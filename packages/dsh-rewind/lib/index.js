/**
 * Host half of `dsh-rewind`.
 *
 * Rewind keeps a *file* history, not a conversation history. Every file the
 * agent is about to write is copied first (`fs/*-intent` is awaited before the
 * write, so the copy is always the pre-image), grouped by turn and tool call.
 * Reverting writes those pre-images back; **the session log is never touched**,
 * so the session keeps its id, title, queue, drafts and model selection.
 *
 * Three seams are enough:
 *
 *   tools/pre-execute   remember session, turn, tool and call id of a dispatch
 *   fs/*-intent         capture the pre-image before the backend writes
 *   tool/result         settle the call into an append-only record
 *
 * Subagent writes are attributed to the root session and its open turn, so a
 * revert never leaves half of a refactor behind.
 *
 * @module dsh-rewind
 */

import { appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { RewindStore, resolveConfig } from './engine.js'
import { storageRoot } from './store.js'

/** Loader identity. */
export const name = 'rewind'

/** The single authenticated route this plugin serves. */
export const ROUTE = '/api/rewind'

/** Host services the wiring needs. */
export const inject = ['sessions', 'fs', 'tools']

/**
 * Read `config.json` from the plugin storage root. A malformed file is a real
 * configuration error and is reported once instead of silently reverting to
 * defaults, because a silently disabled plugin is worse than a loud one.
 *
 * @param {string} root - storage root.
 * @param {(message: string) => void} [warn] - logger.
 * @returns {object} resolved configuration.
 */
export function loadConfig(root, warn = () => {}) {
	const path = join(root, 'config.json')
	try {
		const text = readFileSync(path, 'utf8')
		return resolveConfig(JSON.parse(text))
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return resolveConfig()
		const message = error instanceof Error ? error.message : String(error)
		warn(`dsh-rewind: ignoring ${path}: ${message}`)
		return resolveConfig()
	}
}

/** Identity of a session object. */
function idOf(session) {
	return session.header?.id ?? session.id
}

/** Whether the session is a subagent run. */
function isSubagent(session) {
	return session.header?.origin === 'subagent'
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
	const root = storageRoot(process.env.DSH_HOME)
	const config = loadConfig(root, (message) => ctx.logger.warn(message))
	const store = new RewindStore({ root, config })

	/** Live sessions by id, for parent lookup and the `resolve` fallback. */
	const live = new Map()
	/** Last activity time per session, newest wins for the `current` lookup. */
	const seen = new Map()
	/** Root session of a subagent run. */
	const roots = new WeakMap()
	/** Turn currently open per root session. */
	const turns = new Map()
	/** Dispatch facts per tool execution, read back from the intent hook. */
	const dispatches = new WeakMap()

	/** Resolve the root session of a (possibly subagent) session. */
	const rootOf = (session) => {
		const cached = roots.get(session)
		if (cached !== undefined) return cached
		let current = session
		const guard = new Set()
		while (isSubagent(current)) {
			const parentId = current.header?.parentSession
			const parent = parentId === undefined ? undefined : live.get(parentId)
			if (parent === undefined || guard.has(parentId)) break
			guard.add(parentId)
			current = parent
		}
		roots.set(session, current)
		return current
	}

	/** The newest turn a session has opened, read from its own log. */
	const lastTurnOf = (session) => {
		try {
			const events = session.snapshotEvents?.() ?? []
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index]
				if (event.type === 'turn/start') return event.data.turn
			}
		} catch {
			/* a session without a readable log has no turn yet */
		}
		return undefined
	}

	/**
	 * Remember a live session and its working directory. A session that was
	 * already running when the plugin mounted learns its open turn from the log,
	 * so a capture right after installation still lands in the right turn.
	 */
	const track = (session) => {
		const id = idOf(session)
		if (id === undefined) return undefined
		live.set(id, session)
		seen.set(id, Date.now())
		const base = session.header?.cwd
		if (typeof base === 'string' && base !== '') void store.ensureSession(id, base).catch(() => {})
		if (!turns.has(id)) {
			const turn = lastTurnOf(session)
			if (turn !== undefined) turns.set(id, turn)
		}
		return id
	}

	ctx.on('session/created', (session) => {
		track(session)
	})

	ctx.on('session/event', (session, event) => {
		const id = track(session)
		if (id === undefined) return
		const rootSession = rootOf(session)
		const rootId = idOf(rootSession) ?? id
		if (event.type === 'turn/start') {
			turns.set(rootId, event.data.turn)
			return
		}
		if (event.type !== 'tool/result') return
		const callId = event.data.toolCallId ?? event.data.message?.source?.callId
		if (typeof callId !== 'string') return
		const turn = turns.get(rootId) ?? event.data.turn
		void store.settle({ sessionId: rootId, callId, turn }).catch((error) => {
			ctx.logger.warn(`dsh-rewind: settle failed: ${error instanceof Error ? error.message : String(error)}`)
		})
	})

	ctx.on('session/disposed', (session) => {
		const id = idOf(session)
		if (id !== undefined) live.delete(id)
		store.forget(idOf(rootOf(session)) ?? id ?? '')
	})

	ctx.on('tools/pre-execute', (exec, next) => {
		const session = exec.agent?.session
		if (session !== undefined) {
			const rootSession = rootOf(session)
			const sessionId = idOf(rootSession)
			const base = rootSession.header?.cwd
			if (sessionId !== undefined && typeof base === 'string' && base !== '') {
				dispatches.set(exec, { sessionId, base, tool: exec.name, callId: exec.callId })
			}
		}
		return next()
	})

	/**
	 * Capture the pre-image of one intent target. Never throws: a capture
	 * failure must not block the write the user asked for.
	 */
	const capture = async (target, actor) => {
		const info = actor === undefined ? undefined : dispatches.get(actor)
		if (info === undefined || typeof info.callId !== 'string') return
		const turn = turns.get(info.sessionId)
		if (turn === undefined) return
		let path
		try {
			path = ctx.fs.processPath(target)
		} catch {
			path = target?.path
		}
		if (typeof path !== 'string' || path === '') return
		try {
			await store.capture({ ...info, path, turn })
		} catch (error) {
			ctx.logger.warn(`dsh-rewind: capture failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	for (const event of ['fs/write-intent', 'fs/edit-intent', 'fs/delete-intent']) {
		ctx.on(
			event,
			async (target, actor, next) => {
				const value = await next()
				await capture(target, actor)
				return value
			},
			{ prepend: true },
		)
	}

	/** Surface event types: only these carry a model-visible message. */
	const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

	/**
	 * Replace the model-visible context from `turn` onward with one short note.
	 *
	 * The session log stays append-only: the discarded entries are shadowed by a
	 * `replace` surface operation, so every future request rebuilds history
	 * without them while the transcript on disk remains complete. This is the
	 * same surface mechanism compaction uses, and it keeps the session id, title,
	 * queue and model selection untouched.
	 *
	 * @param {string} sessionId - live session to edit.
	 * @param {number} turn - first turn to forget.
	 * @returns {{forgotten: boolean, removed?: number, reason?: string}} outcome.
	 */
	const forgetFromTurn = (sessionId, turn) => {
		const session = live.get(sessionId)
		if (session === undefined) return { forgotten: false, reason: 'session-not-live' }
		let events
		try {
			events = session.snapshotEvents?.() ?? []
		} catch {
			return { forgotten: false, reason: 'log-unavailable' }
		}
		const last = events[events.length - 1]
		if (last !== undefined && last.type !== 'turn/end') return { forgotten: false, reason: 'turn-open' }
		const start = events.find((event) => event.type === 'turn/start' && event.data?.turn === turn)
		if (start === undefined) return { forgotten: false, reason: 'turn-not-found' }
		const shadowed = events.filter((event) => event.seq >= start.seq && SURFACE.has(event.type))
		if (shadowed.length === 0) return { forgotten: false, reason: 'nothing-to-forget' }
		const startSeq = shadowed[0].seq
		const endSeq = shadowed[shadowed.length - 1].seq
		try {
			session.append(
				'developer/message',
				{
					message: {
						role: 'developer',
						content: [
							{
								type: 'text',
								text: `The user reverted turn ${turn}: the file edits from that turn and everything after it were undone, and those messages were removed from this conversation. Do not rely on them; re-read any file before changing it again.`,
							},
						],
					},
				},
				{ surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: shadowed.map((event) => event.seq) },
			)
			return { forgotten: true, removed: shadowed.length }
		} catch (error) {
			return { forgotten: false, reason: error instanceof Error ? error.message : String(error) }
		}
	}

	/** Resolve a session from an event seq, for slots without session context. */
	const resolveBySeq = (seq) => {
		for (const session of live.values()) {
			try {
				const events = session.snapshotEvents?.() ?? []
				if (events.some((event) => event.seq === seq)) return idOf(session)
			} catch {
				/* a session without a readable log cannot answer */
			}
		}
		return undefined
	}

	/**
	 * Append one line to the access probe. The probe answers a question nothing
	 * else can: did the browser half load at all (`hello`), and did a turn footer
	 * mount (`list`)? It is capped so a long-lived profile cannot grow it.
	 *
	 * @param {string} action - action name the browser asked for.
	 * @param {string | undefined} sessionId - session it named, when any.
	 */
	const probe = (action, sessionId, step, detail) => {
		try {
			const path = join(root, 'access.log')
			try {
				if (statSync(path).size > 256 * 1024) return
			} catch {
				/* first line */
			}
			appendFileSync(path, `${new Date().toISOString()} ${action} ${sessionId ?? '-'} ${step ?? '-'} ${String(detail ?? '-').slice(0, 240)}\n`, { mode: 0o600 })
		} catch {
			/* a probe must never break a request */
		}
	}

	/**
	 * The one action vocabulary behind `POST /api/rewind`.
	 *
	 * @param {object} payload - validated request body.
	 * @returns {Promise<object>} the action result.
	 */
	const perform = async (payload) => {
		const action = payload?.action
		probe(String(action), payload?.sessionId, payload?.step, payload?.detail)
		if (action === 'hello') return { ok: true, version: 1 }
		if (action === 'current') {
			let newest
			for (const [id, at] of seen) {
				if (newest === undefined || at > newest.at) newest = { id, at }
			}
			return { sessionId: newest?.id ?? null }
		}
		if (action === 'resolve') {
			const seq = Number(payload.seq)
			if (!Number.isInteger(seq)) throw new RouteError('bad-request', 'seq must be an integer')
			const sessionId = resolveBySeq(seq)
			return { sessionId: sessionId ?? null }
		}
		if (action === 'status') {
			const usage = await store.usage()
			return { enabled: config.enabled, granularity: config.granularity, usage }
		}
		const sessionId = payload?.sessionId
		if (typeof sessionId !== 'string' || sessionId === '') throw new RouteError('bad-request', 'sessionId is required')
		if (action === 'list') {
			const [turns, lastRevert, usage] = await Promise.all([store.turns(sessionId), store.lastRevert(sessionId), store.usage()])
			return { ...turns, lastRevert: lastRevert ?? null, usage: usage.blobBytes }
		}
		if (action === 'plan') {
			const turn = Number(payload.turn)
			if (!Number.isInteger(turn) || turn < 1) throw new RouteError('bad-request', 'turn must be a positive integer')
			return await store.plan(sessionId, turn)
		}
		if (action === 'apply') {
			const turn = Number(payload.turn)
			if (!Number.isInteger(turn) || turn < 1) throw new RouteError('bad-request', 'turn must be a positive integer')
			const paths = Array.isArray(payload.paths) ? payload.paths.filter((path) => typeof path === 'string') : undefined
			return await store.apply({ sessionId, targetTurn: turn, paths, force: payload.force === true })
		}
		if (action === 'forget') {
			const turn = Number(payload.turn)
			if (!Number.isInteger(turn) || turn < 1) throw new RouteError('bad-request', 'turn must be a positive integer')
			return forgetFromTurn(sessionId, turn)
		}
		if (action === 'undo') {
			if (typeof payload.revertId !== 'string') throw new RouteError('bad-request', 'revertId is required')
			return await store.undo(sessionId, payload.revertId)
		}
		throw new RouteError('bad-request', `unknown action ${JSON.stringify(action)}`)
	}

	ctx.inject(['connection'], (scoped) => {
		const connection = scoped.get('connection')
		const routes = connection?.fetch
		if (routes === undefined || routes === null || typeof routes.register !== 'function') return
		scoped.effect(
			() =>
				routes.register({
					path: ROUTE,
					methods: ['POST'],
					requestBody: 'buffered',
					fetch: async (request) => {
						let payload
						try {
							payload = await request.json()
						} catch {
							return Response.json({ ok: false, error: { code: 'bad-request', message: 'body must be JSON' } })
						}
						try {
							return Response.json({ ok: true, value: await perform(payload) })
						} catch (error) {
							const code = error instanceof RouteError ? error.code : 'internal'
							return Response.json({
								ok: false,
								error: { code, message: error instanceof Error ? error.message : String(error) },
							})
						}
					},
				}),
			'dsh-rewind: /api/rewind route',
		)
	})

	/**
	 * Record what the host published into the browser module graph. This answers
	 * "is the client half available at all" without opening the browser: if the
	 * id is here and the bundle path exists, only a page load can be missing.
	 */
	const dumpClientGraph = () => {
		try {
			const registry = ctx.get('clientModules')
			const ids = registry?.table instanceof Map ? [...registry.table.keys()] : []
			const own = '@qzsy/dsh-rewind'
			let bundle
			try {
				bundle = registry?.clientPath?.(own)
			} catch {
				bundle = undefined
			}
			writeFileSync(
				join(root, 'client-graph.json'),
				`${JSON.stringify({ at: new Date().toISOString(), published: ids.includes(own), ids, bundle }, null, 2)}\n`,
				{ mode: 0o600 },
			)
		} catch (error) {
			ctx.logger.warn(`dsh-rewind: client graph probe failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
	setTimeout(dumpClientGraph, 1500)

	/* Housekeeping: one quiet pass a minute after mount, then every six hours. */
	const maintain = () => {
		void store
			.gc()
			.then(() => store.enforceBudget())
			.catch((error) => {
				ctx.logger.warn(`dsh-rewind: maintenance failed: ${error instanceof Error ? error.message : String(error)}`)
			})
	}
	const firstPass = setTimeout(maintain, 60 * 1000)
	const everyPass = setInterval(maintain, 6 * 60 * 60 * 1000)
	ctx.effect(
		() => () => {
			clearTimeout(firstPass)
			clearInterval(everyPass)
		},
		'dsh-rewind: maintenance timer',
	)

	/** Test seams reachable from a unit test, not from a Context key. */
	return { store, config, perform }
}

/** Test seams: the engine and configuration, without the Host around them. */
export { DEFAULTS, RewindStore, resolveConfig } from './engine.js'

/** A request that the browser caused and can fix. */
export class RouteError extends Error {
	/**
	 * @param {string} code - stable error code.
	 * @param {string} message - human diagnostic.
	 */
	constructor(code, message) {
		super(message)
		this.code = code
		this.name = 'RouteError'
	}
}
