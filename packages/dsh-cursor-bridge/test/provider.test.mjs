/**
 * Provider-level acceptance tests.
 *
 * These run without DSH or a model: they drive `CursorBridgeProvider` directly
 * against the real `erp-admin-demo-1` checkout and against synthetic fixtures.
 *
 *   node test/provider.test.mjs
 *   CURSOR_REPO=/path/to/other/repo node test/provider.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CursorBridgeProvider, normalizeConfig, parseFrontmatter } from '../lib/index.js'

const REPO = process.env.CURSOR_REPO ?? '/Users/curleaf/Project/erp-admin-demo-1'

function makeProvider(overrides = {}) {
	const control = { invalidate() {}, signal: undefined }
	const config = normalizeConfig({ watch: false, ...overrides })
	return new CursorBridgeProvider(undefined, control, config)
}

test('discovers the real repo: 4 skills + 15 commands', async () => {
	const provider = makeProvider()
	const candidates = await provider.list({ cwd: REPO })

	const skills = candidates.filter((entry) => entry.locator.kind === 'skill').map((entry) => entry.name).sort()
	const commands = candidates.filter((entry) => entry.locator.kind === 'command').map((entry) => entry.name).sort()

	assert.deepEqual(skills, [
		'prod-qx-erp-database-query',
		'publish',
		'test-1688-listing',
		'third-party-integration-review',
	])
	assert.equal(commands.length, 15)
	assert.deepEqual(commands.slice(0, 4), [
		'complex-plan-generate',
		'git-commit',
		'patrol',
		'platform-card-listing',
	])
	assert.ok(commands.includes('platform-integration'))
	assert.ok(commands.includes('prod-server'))
})

test('every candidate passes the registry contract', async () => {
	const provider = makeProvider()
	const candidates = await provider.list({ cwd: REPO })
	assert.ok(candidates.length > 0)

	for (const candidate of candidates) {
		assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `bad name ${candidate.name}`)
		assert.equal(typeof candidate.description, 'string')
		assert.ok(candidate.description.length > 0, `empty description for ${candidate.name}`)
		assert.equal(typeof candidate.source, 'string')
		assert.equal(typeof candidate.rank, 'number')
		assert.ok(Number.isFinite(candidate.rank))
		assert.equal(candidate.provider, 'cursor')
		assert.equal(typeof candidate.path, 'string')
		assert.equal(typeof candidate.invocation.modelInvocable, 'boolean')
		assert.equal(typeof candidate.invocation.userInvocable, 'boolean')
		assert.equal(candidate.invocation.userInvocable, true)
	}
})

test('loads bodies, and the definition name matches the candidate', async () => {
	const provider = makeProvider()
	const candidates = await provider.list({ cwd: REPO })
	for (const candidate of candidates) {
		const definition = await provider.get(candidate, {})
		assert.ok(definition !== undefined, `no definition for ${candidate.name}`)
		assert.equal(definition.name, candidate.name)
		assert.ok(definition.content.length > 0, `empty body for ${candidate.name}`)
		assert.equal(definition.path, candidate.path)
		assert.equal(definition.provider, 'cursor')
	}
})

test('a command body keeps its content and is model-invocable by default', async () => {
	const provider = makeProvider()
	const candidates = await provider.list({ cwd: REPO })
	const integration = candidates.find((entry) => entry.name === 'platform-integration')
	assert.ok(integration !== undefined)
	assert.equal(integration.invocation.modelInvocable, true)
	const definition = await provider.get(integration, {})
	assert.match(definition.content, /平台接入总控/)
	assert.doesNotMatch(definition.content, /^---/)
})

test('commandModelInvocable:false keeps commands user-only', async () => {
	const provider = makeProvider({ commandModelInvocable: false })
	const candidates = await provider.list({ cwd: REPO })
	const commands = candidates.filter((entry) => entry.locator.kind === 'command')
	assert.equal(commands.length, 15)
	for (const command of commands) assert.equal(command.invocation.modelInvocable, false)
	for (const skill of candidates.filter((entry) => entry.locator.kind === 'skill')) {
		assert.equal(skill.invocation.modelInvocable, true)
	}
})

test('project root wins over cwd when a nested directory is used', async () => {
	const provider = makeProvider()
	const nested = join(REPO, 'apps')
	const candidates = await provider.list({ cwd: nested })
	assert.equal(candidates.length, 19)
})

test('frontmatter subset: folded blocks, quotes, comments, missing fences', () => {
	assert.deepEqual(parseFrontmatter('no frontmatter here').data, {})
	assert.equal(parseFrontmatter('no frontmatter here').body, 'no frontmatter here')

	const folded = parseFrontmatter('---\nname: a-b\ndescription: >-\n  one\n  two\n---\nbody\n')
	assert.equal(folded.data.name, 'a-b')
	assert.equal(folded.data.description, 'one two')
	assert.equal(folded.body, 'body\n')

	const literal = parseFrontmatter('---\ndescription: |\n  one\n  two\n---\n')
	assert.equal(literal.data.description, 'one\ntwo')

	const quoted = parseFrontmatter('---\ndescription: "a: b" # note\n---\n')
	assert.equal(quoted.data.description, 'a: b')
})

test('a broken file does not take the whole provider down', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cursor-bridge-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, '.cursor/skills/good'), { recursive: true })
		await mkdir(join(root, '.cursor/skills/bad'), { recursive: true })
		await writeFile(join(root, '.cursor/skills/good/SKILL.md'), '---\nname: good-one\ndescription: fine\n---\nbody\n')
		// No frontmatter at all and no usable first line -> skipped, not fatal.
		await writeFile(join(root, '.cursor/skills/bad/SKILL.md'), '---\nname: "Not Kebab"\n---\n')

		const provider = makeProvider()
		const candidates = await provider.list({ cwd: root })
		const names = candidates.map((entry) => entry.name)
		assert.ok(names.includes('good-one'), `expected good-one, got ${names.join(',')}`)
		assert.equal(names.includes('not-kebab'), false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('rename in frontmatter is reported so the registry can re-discover', async () => {
	const root = await mkdtemp(join(tmpdir(), 'cursor-bridge-'))
	try {
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, '.cursor/skills/one'), { recursive: true })
		await writeFile(join(root, '.cursor/skills/one/SKILL.md'), '---\nname: one\ndescription: d\n---\nb\n')

		const provider = makeProvider()
		const [candidate] = await provider.list({ cwd: root })
		await writeFile(join(root, '.cursor/skills/one/SKILL.md'), '---\nname: two\ndescription: d\n---\nb\n')
		const definition = await provider.get(candidate, {})
		assert.equal(definition.name, 'two')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
