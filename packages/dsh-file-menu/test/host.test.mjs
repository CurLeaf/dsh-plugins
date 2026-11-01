/**
 * Host-half tests: the rename/delete route against a real temporary directory,
 * with every security gate exercised (trust fence, containment, symlink escape,
 * root protection, overwrite refusal, wire validation).
 *
 * The Cordis context is faked at exactly the seams the route uses, so the test
 * needs neither a running Host nor the full plugin graph.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'

import { ACTION_PATH, apply, handleRequest } from '../lib/index.js'

/** Every temporary root this file created, removed once the tests finish. */
const created = []
after(async () => {
	await Promise.all(created.map((base) => rm(base, { recursive: true, force: true })))
})

/** One writable workspace plus a sibling "outside" directory, both real. */
async function sandbox() {
	const base = await mkdtemp(join(tmpdir(), 'dsh-file-menu-'))
	created.push(base)
	const root = join(base, 'workspace')
	const outside = join(base, 'outside')
	await mkdir(root)
	await mkdir(outside)
	return { base, root, outside }
}

/** A Host context whose only facts are the ones the route reads. */
function hostContext({ root, authenticated = true }) {
	const routes = new Map()
	const ctx = {
		get(name) {
			if (name === 'connection') return { requestRejection: () => (authenticated ? undefined : 401) }
			if (name === 'sessions') return { store: new Map([['session-1', { header: { cwd: root } }]]) }
			if (name === 'sandboxPolicy') return { workspaceRoot: root }
			return undefined
		},
		inject(_deps, callback) {
			callback({
				effect: (factory) => {
					factory()
				},
				webServer: {
					register: (route) => {
						routes.set(route.path, route)
						return () => routes.delete(route.path)
					}
				}
			})
		}
	}
	return { ctx, routes }
}

/** A Host context without the browser-auth service (must fail closed). */
function unauthenticatedHost({ root }) {
	const routes = new Map()
	const ctx = {
		get(name) {
			if (name === 'sessions') return { store: new Map([['session-1', { header: { cwd: root } }]]) }
			if (name === 'sandboxPolicy') return { workspaceRoot: root }
			return undefined
		},
		inject(_deps, callback) {
			callback({
				effect: (factory) => {
					factory()
				},
				webServer: {
					register: (route) => {
						routes.set(route.path, route)
						return () => routes.delete(route.path)
					}
				}
			})
		}
	}
	return { ctx, routes }
}

/** POST one body through the real handler and collect the JSON answer. */
function post(ctx, body, init = {}) {
	return new Promise((resolve, reject) => {
		const text = typeof body === 'string' ? body : JSON.stringify(body)
		const req = Readable.from([Buffer.from(text)])
		req.method = init.method ?? 'POST'
		req.headers = { 'content-type': init.contentType ?? 'application/json' }
		const res = {
			statusCode: 200,
			headers: {},
			setHeader(name, value) {
				this.headers[name.toLowerCase()] = value
			},
			end(payload) {
				let parsed
				try {
					parsed = payload === undefined || payload === '' ? undefined : JSON.parse(payload)
				} catch {
					parsed = payload
				}
				resolve({ status: this.statusCode, body: parsed, headers: this.headers })
			}
		}
		handleRequest(ctx, req, res).catch(reject)
	})
}

test('the route is mounted at the documented path', async () => {
	const { root } = await sandbox()
	const { ctx, routes } = hostContext({ root })
	apply(ctx)
	assert.ok(routes.has(ACTION_PATH), 'route registered')
	assert.equal(routes.get(ACTION_PATH).kind, 'exact')
})

test('rename changes one segment and keeps the file', async () => {
	const { root } = await sandbox()
	const source = join(root, 'old.txt')
	await writeFile(source, 'hello')
	const { ctx } = hostContext({ root })
	const answer = await post(ctx, { action: 'rename', path: source, name: 'new.md' })
	assert.equal(answer.status, 200)
	assert.deepEqual(answer.body, { ok: true, action: 'rename', changed: true, path: join(root, 'new.md') })
	assert.deepEqual(await readdir(root), ['new.md'])
	assert.equal(await readFile(join(root, 'new.md'), 'utf8'), 'hello')
})

test('rename never overwrites an existing entry', async () => {
	const { root } = await sandbox()
	await writeFile(join(root, 'a.txt'), 'a')
	await writeFile(join(root, 'b.txt'), 'b')
	const { ctx } = hostContext({ root })
	const answer = await post(ctx, { action: 'rename', path: join(root, 'a.txt'), name: 'b.txt' })
	assert.equal(answer.status, 409)
	assert.equal(answer.body.code, 'exists')
	assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b')
	assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'b.txt'])
})

test('rename rejects a name that is not a single segment', async () => {
	const { root } = await sandbox()
	const source = join(root, 'a.txt')
	await writeFile(source, 'a')
	const { ctx } = hostContext({ root })
	for (const name of ['../escape.txt', 'nested/b.txt', 'a\\b', '', '.', '..']) {
		const answer = await post(ctx, { action: 'rename', path: source, name })
		assert.equal(answer.status, 400, `name ${JSON.stringify(name)}`)
		assert.equal(answer.body.code, 'invalid-name')
	}
	assert.deepEqual(await readdir(root), ['a.txt'])
})

test('delete removes a file and a directory tree', async () => {
	const { root } = await sandbox()
	await writeFile(join(root, 'file.txt'), 'x')
	await mkdir(join(root, 'folder', 'nested'), { recursive: true })
	await writeFile(join(root, 'folder', 'nested', 'inner.txt'), 'y')
	const { ctx } = hostContext({ root })
	const file = await post(ctx, { action: 'delete', path: join(root, 'file.txt') })
	assert.equal(file.status, 200)
	assert.equal(file.body.ok, true)
	const folder = await post(ctx, { action: 'delete', path: join(root, 'folder') })
	assert.equal(folder.status, 200)
	assert.deepEqual(await readdir(root), [])
})

test('a path outside every workspace is refused', async () => {
	const { root, outside } = await sandbox()
	const victim = join(outside, 'keep.txt')
	await writeFile(victim, 'keep')
	const { ctx } = hostContext({ root })
	const answer = await post(ctx, { action: 'delete', path: victim })
	assert.equal(answer.status, 403)
	assert.equal(answer.body.code, 'outside-workspace')
	assert.equal(await readFile(victim, 'utf8'), 'keep')
})

test('a symlinked parent cannot smuggle a path out of the workspace', async () => {
	const { root, outside } = await sandbox()
	const victim = join(outside, 'keep.txt')
	await writeFile(victim, 'keep')
	await symlink(outside, join(root, 'escape'))
	const { ctx } = hostContext({ root })
	const answer = await post(ctx, { action: 'delete', path: join(root, 'escape', 'keep.txt') })
	assert.equal(answer.status, 403)
	assert.equal(answer.body.code, 'outside-workspace')
	assert.equal(await readFile(victim, 'utf8'), 'keep')
})

test('the workspace root itself cannot be deleted or renamed', async () => {
	const { root } = await sandbox()
	const { ctx } = hostContext({ root })
	const deleted = await post(ctx, { action: 'delete', path: root })
	assert.equal(deleted.status, 403)
	assert.equal(deleted.body.code, 'root-protected')
	const renamed = await post(ctx, { action: 'rename', path: root, name: 'moved' })
	assert.equal(renamed.status, 403)
	assert.equal(renamed.body.code, 'root-protected')
	assert.deepEqual(await readdir(root), [])
})

test('a missing entry is a 404, not a silent success', async () => {
	const { root } = await sandbox()
	const { ctx } = hostContext({ root })
	const answer = await post(ctx, { action: 'delete', path: join(root, 'ghost.txt') })
	assert.equal(answer.status, 404)
	assert.equal(answer.body.code, 'not-found')
})

test('the trust fence answers first and refuses unauthenticated callers', async () => {
	const { root } = await sandbox()
	const victim = join(root, 'keep.txt')
	await writeFile(victim, 'keep')
	const { ctx } = hostContext({ root, authenticated: false })
	const answer = await post(ctx, { action: 'delete', path: victim })
	assert.equal(answer.status, 401)
	assert.equal(answer.body, undefined)
	assert.equal(await readFile(victim, 'utf8'), 'keep')
})

test('a Host without the browser-auth service fails closed', async () => {
	const { root } = await sandbox()
	const { ctx } = unauthenticatedHost({ root })
	const answer = await post(ctx, { action: 'delete', path: join(root, 'a.txt') })
	assert.equal(answer.status, 503)
	assert.equal(answer.body.code, 'unavailable')
})

test('wire validation: method, media type, JSON, action, path', async () => {
	const { root } = await sandbox()
	const { ctx } = hostContext({ root })
	const wrongMethod = await post(ctx, { action: 'delete', path: join(root, 'a') }, { method: 'GET' })
	assert.equal(wrongMethod.status, 405)
	assert.equal(wrongMethod.headers.allow, 'POST')

	const wrongType = await post(ctx, { action: 'delete', path: join(root, 'a') }, { contentType: 'text/plain' })
	assert.equal(wrongType.status, 415)

	const brokenJson = await post(ctx, '{')
	assert.equal(brokenJson.status, 400)

	const unknownAction = await post(ctx, { action: 'chmod', path: join(root, 'a') })
	assert.equal(unknownAction.status, 400)

	const relative = await post(ctx, { action: 'delete', path: 'a.txt' })
	assert.equal(relative.status, 400)

	const renamedWithoutName = await post(ctx, { action: 'rename', path: join(root, 'a') })
	assert.equal(renamedWithoutName.status, 400)
})

test('path traversal is normalized before containment', async () => {
	const { base, root } = await sandbox()
	const victim = join(base, 'secret.txt')
	await writeFile(victim, 'secret')
	const { ctx } = hostContext({ root })
	const answer = await post(ctx, { action: 'delete', path: `${root}/../secret.txt` })
	assert.equal(answer.status, 403)
	assert.equal(await readFile(victim, 'utf8'), 'secret')
})

test('a rename to the same name is a no-op success', async () => {
	const { root } = await sandbox()
	const source = join(root, 'same.txt')
	await writeFile(source, 'x')
	const { ctx } = hostContext({ root })
	const answer = await post(ctx, { action: 'rename', path: source, name: 'same.txt' })
	assert.equal(answer.status, 200)
	assert.equal(answer.body.changed, false)
	assert.equal(await readFile(source, 'utf8'), 'x')
})
