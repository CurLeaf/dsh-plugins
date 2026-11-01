/**
 * Watcher acceptance: catalog-relevant edits invalidate, bundle-internal churn
 * does not. The real repo ships a 2 MB `.cache/` inside a skill bundle, so this
 * filter is what keeps the registry cache from thrashing during a query run.
 *
 *   node test/watch.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CursorBridgeProvider, normalizeConfig } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 3000) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true
		await sleep(50)
	}
	return false
}

test('bundle-internal churn is ignored, SKILL.md edits invalidate', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cursor-bridge-watch-'))
	let invalidations = 0
	const provider = new CursorBridgeProvider(undefined, { invalidate: () => { invalidations += 1 } }, normalizeConfig({ watch: true, watchPollIntervalMs: 100 }))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, '.cursor/skills/one/.cache'), { recursive: true })
		await writeFile(join(root, '.cursor/skills/one/SKILL.md'), '---\nname: one\ndescription: d\n---\nbody\n')
		await writeFile(join(root, '.cursor/skills/one/.cache/blob.json'), '{}')

		const before = await provider.list({ cwd: root })
		assert.equal(before.length, 1)

		// A cache write inside the bundle must not invalidate.
		await writeFile(join(root, '.cursor/skills/one/.cache/blob.json'), '{"rows":1}')
		await sleep(400)
		assert.equal(invalidations, 0, 'cache churn should not invalidate')

		// A SKILL.md edit must invalidate.
		await writeFile(join(root, '.cursor/skills/one/SKILL.md'), '---\nname: one\ndescription: d2\n---\nbody\n')
		assert.ok(await waitFor(() => invalidations > 0), 'SKILL.md edit should invalidate')

		// A new bundle directory must invalidate too.
		const mark = invalidations
		await mkdir(join(root, '.cursor/skills/two'), { recursive: true })
		await writeFile(join(root, '.cursor/skills/two/SKILL.md'), '---\nname: two\ndescription: d\n---\n')
		assert.ok(await waitFor(() => invalidations > mark), 'new bundle should invalidate')
	} finally {
		provider.dispose()
		await rm(root, { recursive: true, force: true })
	}
})

test('a command root created after the first list is picked up', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cursor-bridge-watch-'))
	let invalidations = 0
	const provider = new CursorBridgeProvider(undefined, { invalidate: () => { invalidations += 1 } }, normalizeConfig({ watch: true, watchPollIntervalMs: 100 }))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		const before = await provider.list({ cwd: root })
		assert.equal(before.length, 0)

		await mkdir(join(root, '.cursor/commands'), { recursive: true })
		await writeFile(join(root, '.cursor/commands/ship.md'), '---\nid: ship\ndescription: ship it\n---\nbody\n')
		assert.ok(await waitFor(() => invalidations > 0), 'late command root should invalidate')
		const after = await provider.list({ cwd: root })
		assert.equal(after.length, 1)
		assert.equal(after[0].name, 'ship')
	} finally {
		provider.dispose()
		await rm(root, { recursive: true, force: true })
	}
})
