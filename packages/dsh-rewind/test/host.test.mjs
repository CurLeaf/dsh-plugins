/**
 * Host-half tests: the action vocabulary behind `POST /api/rewind`.
 *
 * `apply` is where "a rewind is all-or-nothing" has to hold at the API
 * boundary, not only in the browser: an older cached bundle — or any other
 * caller — may still send `paths`, and it must not be able to revert a subset.
 *
 * The plugin exposes `{ store, perform }` through `apply(ctx)` as a test seam,
 * so these tests drive the real action handler against a temporary storage
 * root and a temporary workspace.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/** Timers the plugin schedules on mount, so a finished test leaves none behind. */
const timers = new Set()
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...args) => {
	const id = realSetTimeout(fn, ms, ...args)
	timers.add(id)
	return id
}

function clearTimers() {
	for (const id of timers) clearTimeout(id)
	timers.clear()
}

/**
 * Mount the plugin with a minimal Host context.
 *
 * @returns {{plugin: object, handlers: Map<string, Function>, dispose: Function}} mounted pieces.
 */
function mount() {
	const handlers = new Map()
	const disposers = []
	const connection = { fetch: { register: () => () => {} } }
	const ctx = {
		logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
		effect: (factory) => {
			const dispose = factory()
			disposers.push(dispose)
			return dispose
		},
		on: (event, handler) => {
			handlers.set(event, handler)
			return () => {}
		},
		inject: (_names, callback) =>
			callback({
				effect: (factory) => {
					const dispose = factory()
					disposers.push(dispose)
					return dispose
				},
				get: (key) => (key === 'connection' ? connection : undefined),
			}),
		get: () => undefined,
		fs: { processPath: (target) => target?.path },
	}
	const plugin = apply(ctx)
	return {
		plugin,
		handlers,
		dispose: () => {
			for (const fn of disposers.reverse()) if (typeof fn === 'function') fn()
			clearTimers()
		},
	}
}

/** One throwaway workspace plus one throwaway storage root. */
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-host-'))
	const base = join(root, 'workspace')
	await mkdir(base, { recursive: true })
	process.env.DSH_HOME = join(root, 'home')
	const mounted = mount()
	return { root, base, mounted }
}

/** Record one tool edit the way the capture hooks would. */
async function edit(store, sessionId, base, { turn, callId, path, next }) {
	await store.capture({ sessionId, base, path, tool: 'edit', callId, turn })
	if (next === undefined) await rm(path, { force: true })
	else await writeFile(path, next)
	return store.settle({ sessionId, callId, turn })
}

test('apply ignores paths: a rewind is never partial', async () => {
	const { root, base, mounted } = await fixture()
	try {
		const a = join(base, 'a.txt')
		const b = join(base, 'b.txt')
		await writeFile(a, 'A0')
		await writeFile(b, 'B0')
		await edit(mounted.plugin.store, 's1', base, { turn: 1, callId: 'c1', path: a, next: 'A1' })
		await edit(mounted.plugin.store, 's1', base, { turn: 1, callId: 'c2', path: b, next: 'B1' })

		/* A caller that still asks for one file gets the whole turn. */
		const result = await mounted.plugin.perform({ action: 'apply', sessionId: 's1', turn: 1, paths: [a] })
		assert.equal(result.restored, 2)
		assert.equal(await readFile(a, 'utf8'), 'A0')
		assert.equal(await readFile(b, 'utf8'), 'B0', 'b was not named but is reverted anyway')
	} finally {
		mounted.dispose()
		await rm(root, { recursive: true, force: true })
	}
})

test('apply reverts later turns as well', async () => {
	const { root, base, mounted } = await fixture()
	try {
		const a = join(base, 'a.txt')
		const b = join(base, 'b.txt')
		await writeFile(a, 'A0')
		await writeFile(b, 'B0')
		await edit(mounted.plugin.store, 's2', base, { turn: 1, callId: 'c1', path: a, next: 'A1' })
		await edit(mounted.plugin.store, 's2', base, { turn: 2, callId: 'c2', path: b, next: 'B1' })

		const result = await mounted.plugin.perform({ action: 'apply', sessionId: 's2', turn: 1 })
		assert.equal(result.restored, 2)
		assert.equal(await readFile(a, 'utf8'), 'A0')
		assert.equal(await readFile(b, 'utf8'), 'B0')
	} finally {
		mounted.dispose()
		await rm(root, { recursive: true, force: true })
	}
})

test('plan previews every file and its conflicts before anything is written', async () => {
	const { root, base, mounted } = await fixture()
	try {
		const a = join(base, 'a.txt')
		const b = join(base, 'b.txt')
		await writeFile(a, 'A0')
		await writeFile(b, 'B0')
		await edit(mounted.plugin.store, 's3', base, { turn: 1, callId: 'c1', path: a, next: 'A1' })
		await edit(mounted.plugin.store, 's3', base, { turn: 1, callId: 'c2', path: b, next: 'B1' })
		/* The human edits b afterwards: a full revert still must not clobber it. */
		await writeFile(b, 'B1-mine')

		const plan = await mounted.plugin.perform({ action: 'plan', sessionId: 's3', turn: 1 })
		assert.equal(plan.stats.files, 2)
		assert.equal(plan.stats.conflicts, 1)

		const result = await mounted.plugin.perform({ action: 'apply', sessionId: 's3', turn: 1 })
		assert.equal(result.restored, 1)
		assert.equal(await readFile(a, 'utf8'), 'A0')
		assert.equal(await readFile(b, 'utf8'), 'B1-mine', 'the human edit survives')
		assert.deepEqual(result.skipped.map((entry) => entry.reason), ['conflict'])
	} finally {
		mounted.dispose()
		await rm(root, { recursive: true, force: true })
	}
})

test('forget reports a dead session instead of throwing', async () => {
	const { root, mounted } = await fixture()
	try {
		const result = await mounted.plugin.perform({ action: 'forget', sessionId: 'missing', turn: 1 })
		assert.deepEqual(result, { forgotten: false, reason: 'session-not-live' })
	} finally {
		mounted.dispose()
		await rm(root, { recursive: true, force: true })
	}
})
