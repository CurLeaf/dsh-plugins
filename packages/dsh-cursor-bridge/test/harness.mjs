/**
 * Live integration harness: mount the real DSH skill registry
 * (`@deepseek-ai/dsh-skill`) plus the bundled filesystem provider plus this
 * plugin inside one Cordis context, then assert what the composer's `/` menu
 * would be served by `skills/list`.
 *
 * Run it through the app's own runtime so `app.asar` paths resolve:
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/harness.mjs
 */

import assert from 'node:assert/strict'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const NM = `file://${ASAR}/dsh/node_modules/@deepseek-ai`

const { Context } = await import(`${NM}/cordis/lib/index.js`)
const skill = await import(`${NM}/dsh-skill/lib/index.js`)
const bridge = await import('file:///Users/curleaf/WorkSpace/dsh-cursor-bridge/lib/index.js')

const REPO = process.env.CURSOR_REPO ?? '/Users/curleaf/Project/erp-admin-demo-1'

const ctx = new Context()
await ctx.plugin(skill.SkillRegistry)
await ctx.plugin(bridge, { watch: false })

const candidates = await ctx.skills.list({ cwd: REPO })
const names = candidates.map((entry) => entry.name)

const skills = candidates.filter((entry) => entry.provider === 'cursor' && entry.source === 'project-cursor')
const commands = candidates.filter((entry) => entry.source === 'project-cursor-command')

assert.equal(skills.length, 4, `skills: ${skills.map((s) => s.name).join(',')}`)
assert.equal(commands.length, 15, `commands: ${commands.map((s) => s.name).join(',')}`)
assert.equal(candidates.length, 19, `total catalog: ${names.join(',')}`)

// The definition load path the `/name` gesture uses.
const loaded = await ctx.skills.get('platform-integration', { cwd: REPO })
assert.ok(loaded !== undefined)
assert.equal(loaded.name, 'platform-integration')
assert.match(loaded.content, /平台接入总控/)

const skillBody = await ctx.skills.get('publish', { cwd: REPO })
assert.ok(skillBody !== undefined)
assert.match(skillBody.content, /发布/)

// Unknown names return undefined rather than throwing.
assert.equal(await ctx.skills.get('does-not-exist', { cwd: REPO }), undefined)

// Invalidation: a new file on disk appears after the provider invalidates.
const { mkdir, writeFile, rm } = await import('node:fs/promises')
const { join } = await import('node:path')
const scratch = join(REPO, '.cursor/skills/__bridge_probe__')
try {
	await mkdir(scratch, { recursive: true })
	await writeFile(join(scratch, 'SKILL.md'), '---\nname: bridge-probe\ndescription: 探针\n---\nprobe body\n')
	// No invalidate() call yet: the registry still serves its cache.
	assert.equal((await ctx.skills.list({ cwd: REPO })).length, 19)
	ctx.skills.invalidateCache()
	const after = await ctx.skills.list({ cwd: REPO })
	assert.equal(after.length, 20, 'invalidate should surface the new skill')
	assert.ok(after.some((entry) => entry.name === 'bridge-probe'))
} finally {
	await rm(scratch, { recursive: true, force: true })
}

console.log(JSON.stringify({
	ok: true,
	total: candidates.length,
	skills: skills.map((s) => s.name),
	commands: commands.map((s) => s.name),
	userInvocable: candidates.every((entry) => entry.invocation.userInvocable),
	modelInvocableCommands: commands.every((entry) => entry.invocation.modelInvocable),
}, null, 2))
