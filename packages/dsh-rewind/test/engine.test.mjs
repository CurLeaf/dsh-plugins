/**
 * Behaviour tests for the rewind engine.
 *
 * The suite drives the same seam the Host uses — capture before a write,
 * settle after it, plan, apply, undo — against real temporary files, because
 * every claim this plugin makes is about bytes on disk.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RewindStore, resolveConfig } from '../lib/engine.js'

/** One throwaway workspace plus one throwaway storage root. */
async function fixture(overrides = {}) {
	const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-'))
	const base = join(root, 'workspace')
	await mkdir(base, { recursive: true })
	const store = new RewindStore({
		root: join(root, 'store'),
		config: resolveConfig({ maxFileBytes: 1024 * 1024, gcGraceMs: 0, ...overrides }),
	})
	await store.ensureSession('s1', base)
	return { root, base, store, sessionId: 's1' }
}

/** Simulate one tool call: capture, mutate, settle. */
async function editCall(store, sessionId, base, { turn, callId, path, next }) {
	await store.capture({ sessionId, base, path, tool: 'edit', callId, turn })
	if (next === undefined) await rm(path, { force: true })
	else await writeFile(path, next)
	return store.settle({ sessionId, callId, turn })
}

test('reverting an update restores the pre-image', async () => {
	const { base, store, sessionId } = await fixture()
	const file = join(base, 'a.txt')
	await writeFile(file, 'A0')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: file, next: 'A1' })
	assert.equal(await readFile(file, 'utf8'), 'A1')

	const result = await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(result.restored, 1)
	assert.equal(await readFile(file, 'utf8'), 'A0')
})

test('reverting a create deletes the file, reverting a delete restores it', async () => {
	const { base, store, sessionId } = await fixture()
	const created = join(base, 'new.txt')
	const removed = join(base, 'gone.txt')
	await writeFile(removed, 'KEEP')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: created, next: 'hello' })
	await editCall(store, sessionId, base, { turn: 1, callId: 'c2', path: removed, next: undefined })

	const result = await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(result.deleted, 1)
	assert.equal(result.restored, 1)
	await assert.rejects(stat(created))
	assert.equal(await readFile(removed, 'utf8'), 'KEEP')
})

test('an earlier turn reverts every later turn too', async () => {
	const { base, store, sessionId } = await fixture()
	const a = join(base, 'a.txt')
	const b = join(base, 'b.txt')
	await writeFile(a, 'A0')
	await writeFile(b, 'B0')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: a, next: 'A1' })
	await editCall(store, sessionId, base, { turn: 2, callId: 'c2', path: b, next: 'B1' })
	await editCall(store, sessionId, base, { turn: 2, callId: 'c3', path: a, next: 'A2' })

	await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(await readFile(a, 'utf8'), 'A0')
	assert.equal(await readFile(b, 'utf8'), 'B0', 'b was changed in turn 2 and must be reverted too')

	const { base: base2, store: store2, sessionId: s2 } = await fixture()
	const c = join(base2, 'c.txt')
	const d = join(base2, 'd.txt')
	await writeFile(c, 'C0')
	await writeFile(d, 'D0')
	await editCall(store2, s2, base2, { turn: 1, callId: 'x1', path: c, next: 'C1' })
	await editCall(store2, s2, base2, { turn: 2, callId: 'x2', path: d, next: 'D1' })
	await store2.apply({ sessionId: s2, targetTurn: 2 })
	assert.equal(await readFile(c, 'utf8'), 'C1', 'turn 1 is not in range')
	assert.equal(await readFile(d, 'utf8'), 'D0')
})

test('turn granularity keeps the first pre-image of the turn', async () => {
	const { base, store, sessionId } = await fixture()
	const file = join(base, 'a.txt')
	await writeFile(file, 'A0')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: file, next: 'A1' })
	await editCall(store, sessionId, base, { turn: 1, callId: 'c2', path: file, next: 'A2' })

	const { turns } = await store.turns(sessionId)
	assert.equal(turns[0].files, 1, 'one path, two edits, one record set')

	await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(await readFile(file, 'utf8'), 'A0')
})

test('a file edited outside the agent is a conflict and is skipped', async () => {
	const { base, store, sessionId } = await fixture()
	const file = join(base, 'a.txt')
	await writeFile(file, 'A0')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: file, next: 'A1' })
	await writeFile(file, 'USER')

	const plan = await store.plan(sessionId, 1)
	assert.equal(plan.stats.conflicts, 1)
	const result = await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(result.restored, 0)
	assert.deepEqual(result.skipped, [{ path: 'a.txt', reason: 'conflict' }])
	assert.equal(await readFile(file, 'utf8'), 'USER', 'a user edit is never overwritten')

	const forced = await store.apply({ sessionId, targetTurn: 1, force: true })
	assert.equal(forced.restored, 1)
	assert.equal(await readFile(file, 'utf8'), 'A0')
})

test('a revert can be undone', async () => {
	const { base, store, sessionId } = await fixture()
	const file = join(base, 'a.txt')
	await writeFile(file, 'A0')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: file, next: 'A1' })
	const revert = await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(await readFile(file, 'utf8'), 'A0')

	await store.undo(sessionId, revert.revertId)
	assert.equal(await readFile(file, 'utf8'), 'A1')

	await assert.rejects(store.undo(sessionId, revert.revertId), /already undone/)
})

test('excluded paths are never captured', async () => {
	const { base, store, sessionId } = await fixture()
	const env = join(base, '.env')
	await writeFile(env, 'SECRET=1')

	const captured = await store.capture({ sessionId, base, path: env, tool: 'write', callId: 'c1', turn: 1 })
	assert.equal(captured, false)
	assert.equal((await store.turns(sessionId)).total, 0)
})

test('metadata-only paths are recorded but not restorable', async () => {
	const { base, store, sessionId } = await fixture()
	const lock = join(base, 'pnpm-lock.yaml')
	await writeFile(lock, 'lockfileVersion: 9\n')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: lock, next: 'lockfileVersion: 10\n' })
	const plan = await store.plan(sessionId, 1)
	assert.equal(plan.entries.length, 1)
	assert.equal(plan.entries[0].restorable, false)

	const result = await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(result.restored, 0)
	assert.deepEqual(result.skipped, [{ path: 'pnpm-lock.yaml', reason: 'not-restorable' }])
})

test('head-of-turn pre-image wins even after a later turn rewrote the file', async () => {
	const { base, store, sessionId } = await fixture()
	const file = join(base, 'a.txt')
	await writeFile(file, 'A0')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: file, next: 'A1' })
	await editCall(store, sessionId, base, { turn: 2, callId: 'c2', path: file, next: 'A2' })
	await editCall(store, sessionId, base, { turn: 3, callId: 'c3', path: file, next: 'A3' })

	await store.apply({ sessionId, targetTurn: 2 })
	assert.equal(await readFile(file, 'utf8'), 'A1')
})

test('gc drops unreferenced blobs and keeps live pre-images', async () => {
	const { base, store, sessionId } = await fixture({ gcGraceMs: 0 })
	const file = join(base, 'a.txt')
	await writeFile(file, 'A0')
	await writeFile(join(base, 'unused.txt'), 'ORPHAN')

	await editCall(store, sessionId, base, { turn: 1, callId: 'c1', path: file, next: 'A1' })
	// An orphan blob: content stored by a capture that never settled.
	await store.capture({ sessionId, base, path: join(base, 'unused.txt'), tool: 'write', callId: 'c2', turn: 1 })
	store.pending.delete(`${sessionId}\u0000c2`)

	const before = await store.usage()
	assert.equal(before.blobs, 2)

	await store.gc()
	const after = await store.usage()
	assert.equal(after.blobs, 1)

	await store.apply({ sessionId, targetTurn: 1 })
	assert.equal(await readFile(file, 'utf8'), 'A0')
})
