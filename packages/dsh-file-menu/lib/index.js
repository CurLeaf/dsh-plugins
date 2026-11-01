/**
 * Host half of `dsh-file-menu`.
 *
 * The workspace file tree in the right sidebar is read-only: it lists a
 * Session's workspace through the `workspaceFiles` Remote and opens files into
 * a tab. This plugin adds the two operations a tree cannot do over that
 * read-only face — **rename** and **delete** — through one small HTTP route on
 * the composition's `webServer`.
 *
 * Security has one home, here:
 *
 *   - Every request is answered only after the `connection` service clears it
 *     (`requestRejection`): the Host/Origin fence plus the browser login cookie
 *     gate the caller before any filesystem fact is read. A composition
 *     without that service fails closed with 503 rather than accepting
 *     unauthenticated writes.
 *   - The body is validated at the wire: `application/json`, a 64 KiB ceiling,
 *     a known action, and an absolute path.
 *   - The target must name an existing entry whose **resolved parent** is
 *     inside a Session workspace (or the active sandbox workspace). Resolving
 *     the parent defeats a symlink inside the tree that points elsewhere;
 *     deleting or renaming the link itself stays allowed.
 *   - The workspace root itself is never a target: its parent is outside the
 *     root, so containment refuses it before any operation runs.
 *   - A rename may only change the last path segment, and never overwrites an
 *     existing entry (a case-only rename of the same inode is allowed).
 *
 * @module dsh-file-menu
 */
import { lstat, realpath, rename as renameEntry, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Cordis function-plugin name. */
export const name = 'file-menu'

/** Route path: one exact POST endpoint. */
export const ACTION_PATH = '/dsh-file-menu/action'

/** Roster of actions this route accepts. */
const ACTIONS = new Set(['rename', 'delete'])

/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** Longest single path segment this route will accept. */
const MAX_NAME_BYTES = 255

/** A refusal the client can translate by `code`. */
class ActionError extends Error {
	constructor(status, code, message) {
		super(message)
		this.status = status
		this.code = code
	}
}

/** JSON response (no-store: these outcomes are live filesystem facts). */
function sendJson(res, status, payload) {
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.end(JSON.stringify(payload))
}

/** 405 with the one supported method. */
function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405
	res.setHeader('allow', allow)
	res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
		size += buffer.byteLength
		if (size > MAX_BODY_BYTES) {
			req.resume?.()
			return null
		}
		chunks.push(buffer)
	}
	return Buffer.concat(chunks, size).toString('utf8')
}

/** Parse the request body into the request shape, or throw a 400. */
function parseActionBody(text) {
	let body
	try {
		body = JSON.parse(text)
	} catch {
		throw new ActionError(400, 'bad-request', '请求体不是合法的 JSON')
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new ActionError(400, 'bad-request', '请求体必须是 JSON 对象')
	}
	if (typeof body.action !== 'string' || !ACTIONS.has(body.action)) {
		throw new ActionError(400, 'bad-request', '不支持的 action')
	}
	if (typeof body.path !== 'string' || body.path.length === 0 || !isAbsolute(body.path)) {
		throw new ActionError(400, 'bad-request', 'path 必须是绝对路径')
	}
	if (body.action === 'rename' && typeof body.name !== 'string') {
		throw new ActionError(400, 'bad-request', '重命名需要 name')
	}
	return {
		action: body.action,
		path: body.path,
		...(body.action === 'rename' ? { name: body.name } : {}),
	}
}

/** One Session workspace (or the sandbox workspace) the host is willing to write in. */
function workspaceRootOf(ctx) {
	const roots = new Set()
	const push = (value) => {
		if (typeof value === 'string' && value.length > 0 && isAbsolute(value)) roots.add(value)
	}
	try {
		push(ctx.get('sandboxPolicy')?.workspaceRoot)
	} catch {}
	try {
		const sessions = ctx.get('sessions')
		const store = sessions?.store
		if (store !== undefined && typeof store.values === 'function') {
			for (const session of store.values()) push(session?.header?.cwd)
		}
	} catch {}
	return [...roots]
}

/** Whether `child` is `parent` or below it, using the host separator. */
function contains(parent, child) {
	if (child === parent) return true
	return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Canonical roots and the canonical parent of the target. A workspace root may
 * itself be a symlink, so both sides are resolved before comparing.
 *
 * @returns the matched root, or undefined when the target is outside every workspace.
 */
async function locateInWorkspace(ctx, target) {
	const parent = await realpath(dirname(target)).catch(() => undefined)
	for (const root of workspaceRootOf(ctx)) {
		const realRoot = await realpath(root).catch(() => undefined)
		if (realRoot === undefined) continue
		// The root itself has no parent inside the root, so it is recognized by identity.
		const identity = target === resolve(root) || (parent !== undefined && parent === dirname(realRoot) && basename(target) === basename(realRoot))
		if (identity) return { root, realRoot, isRoot: true }
		if (parent !== undefined && contains(realRoot, parent)) return { root, realRoot, isRoot: false }
	}
	return undefined
}

/** A rename target must be one plain path segment. */
function validateName(name) {
	if (name.length === 0) throw new ActionError(400, 'invalid-name', '文件名不能为空')
	if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) throw new ActionError(400, 'invalid-name', '文件名太长')
	if (name === '.' || name === '..') throw new ActionError(400, 'invalid-name', '文件名不能是 . 或 ..')
	if (/[/\\\u0000]/u.test(name)) throw new ActionError(400, 'invalid-name', '文件名不能包含 / 或 \\')
	return name
}

/** Rename the target's last segment, refusing an overwrite. */
async function renameTarget(target, name, info) {
	validateName(name)
	const next = join(dirname(target), name)
	if (next === target) return { changed: false, path: target }
	const existing = await lstat(next).catch(() => undefined)
	if (existing !== undefined) {
		// A case-only rename on a case-insensitive volume reports the same entry.
		const sameEntry = existing.ino === info.ino && existing.dev === info.dev
		if (!sameEntry) throw new ActionError(409, 'exists', `已经存在同名文件：${name}`)
	}
	await renameEntry(target, next)
	return { changed: true, path: next }
}

/** Delete the target (a directory is removed recursively). */
async function deleteTarget(target) {
	await rm(target, { recursive: true, force: false, maxRetries: 2 })
	return { path: target }
}

/** Apply one validated request. */
async function perform(ctx, request) {
	const target = resolve(request.path)
	// Refuse the workspace root and anything outside it before touching the disk.
	const located = await locateInWorkspace(ctx, target)
	if (located === undefined) throw new ActionError(403, 'outside-workspace', '这个路径不在工作区里')
	if (located.isRoot === true) throw new ActionError(403, 'root-protected', '不能删除或重命名工作区根目录')
	const info = await lstat(target).catch(() => undefined)
	if (info === undefined) throw new ActionError(404, 'not-found', '找不到这个文件或目录')
	if (request.action === 'rename') return await renameTarget(target, request.name, info)
	return await deleteTarget(target)
}

/** The route handler: fence, validate, act, answer. */
export async function handleRequest(ctx, req, res) {
	let connection
	try {
		connection = ctx.get('connection')
	} catch {
		connection = undefined
	}
	if (connection === undefined || typeof connection.requestRejection !== 'function') {
		sendJson(res, 503, { code: 'unavailable', message: '这个宿主没有浏览器鉴权，拒绝写入' })
		return
	}
	const rejection = connection.requestRejection(req)
	if (rejection !== undefined) {
		res.statusCode = rejection
		res.end()
		return
	}
	if (req.method !== 'POST') {
		sendMethodNotAllowed(res, 'POST')
		return
	}
	const mediaType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
	if (mediaType !== 'application/json') {
		sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type 必须是 application/json' })
		return
	}
	let text
	try {
		text = await readBoundedBody(req)
	} catch {
		sendJson(res, 400, { code: 'bad-request', message: '请求体读取失败' })
		return
	}
	if (text === null) {
		sendJson(res, 413, { code: 'payload-too-large', message: '请求体太大' })
		return
	}
	let request
	try {
		request = parseActionBody(text)
		const result = await perform(ctx, request)
		sendJson(res, 200, { ok: true, action: request.action, ...result })
	} catch (error) {
		if (error instanceof ActionError) {
			sendJson(res, error.status, { code: error.code, message: error.message })
			return
		}
		sendJson(res, 500, {
			code: 'failed',
			message: error instanceof Error ? error.message : String(error)
		})
	}
}

/**
 * Mount the route on the composition's web server.
 * @param ctx - Host context; `webServer` is required, `connection`, `sessions` and
 * `sandboxPolicy` are read lazily so a partial composition still boots.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(
			() => webCtx.webServer.register({ kind: 'exact', path: ACTION_PATH, handler: (req, res) => handleRequest(ctx, req, res) }),
			`file-menu: POST ${ACTION_PATH}`,
		)
	})
}

/** Test seams: the pure decisions, without the HTTP shell. */
export const __internals = {
	ActionError,
	contains,
	locateInWorkspace,
	parseActionBody,
	perform,
	validateName,
	workspaceRootOf
}
