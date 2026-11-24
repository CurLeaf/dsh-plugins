#!/usr/bin/env node
/**
 * dsh-lazy-mcp 冒烟测试。
 *
 * 在一个真实的 cordis Context + ToolsService 上跑：
 *   1. 冷启动只注册 load_tool_group；
 *   2. 全局组：激活/重复激活/卸载；
 *   3. agent 组 + 池子：先 acquire 再挂载、工具只在该 agent 的 scope 可见、
 *      两个 agent 各拿各的插槽、卸载时归还租约；
 *   4. 挂载失败（服务器没注册工具）会回滚并归还租约。
 *
 * 依赖宿主安装：默认用 `which dsh` 反推 @deepseek-ai/dsh 根目录，
 * 也可以用 DSH_BIN=/path/to/dsh 指定。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

function resolveDshRoot() {
  const bin = process.env.DSH_BIN ?? execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  // .../@deepseek-ai/dsh/lib/bin.js → .../@deepseek-ai/dsh
  return path.dirname(path.dirname(fs.realpathSync(bin)))
}

const dshRoot = resolveDshRoot()
const { Context } = await import(`${dshRoot}/node_modules/@deepseek-ai/cordis/lib/index.js`)
const { ToolsService } = await import(`${dshRoot}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`)
const { createScope } = await import(`${dshRoot}/node_modules/@deepseek-ai/dsh-scope/lib/index.js`)

const ctx = new Context()
const sections = []
ctx.provide('systemPrompt', {
  tools() { return () => {} },
  section(section) { sections.push(section); return () => {} },
  getSectionOrder() { return 0 }
})
ctx.plugin(ToolsService)
await new Promise((resolve) => setTimeout(resolve, 50))
assert.ok(ctx.tools, 'tools service did not mount')
ctx.logger = { info() {}, warn: (...a) => console.error('[warn]', ...a), error: (...a) => console.error('[error]', ...a) }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-mcp-test-'))
const fakePlugin = path.join(tmpDir, 'fake-mcp.mjs')
fs.writeFileSync(fakePlugin, `
const name = 'fake-mcp'
const inject = ['tools']
function apply(ctx, config = {}) {
  const server = config.serverName ?? 'fake'
  setTimeout(() => {
    for (const suffix of ['a', 'b']) {
      const dispose = ctx.tools.register({
        name: 'mcp__' + server + '__' + suffix,
        description: 'fake ' + suffix,
        parameters: {},
        output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false }, render: () => [{ type: 'text', text: 'ok' }] },
        async execute() { return { ok: true } }
      })
      ctx.effect?.(() => dispose)
    }
  }, 80)
}
export { name, inject, apply }
`)

const fakePoolState = path.join(tmpDir, 'pool-state.json')
const fakePool = path.join(tmpDir, 'fake-pool.mjs')
fs.writeFileSync(fakePool, `
import fs from 'node:fs'
const stateFile = ${JSON.stringify(fakePoolState)}
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return { leases: {} } } }
const save = (state) => fs.writeFileSync(stateFile, JSON.stringify(state))
const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
const state = load()
if (cmd === 'acquire') {
  const owner = flag('--owner', 'anon')
  const free = ['slot-1', 'slot-2', 'slot-3'].find((slot) => !state.leases[slot])
  if (free === undefined) { console.log(JSON.stringify({ ok: false, error: 'no-free-slot', leases: [] })); process.exit(2) }
  state.leases[free] = { owner, profile: '/tmp/lazy-profile-' + free, expiresAt: Date.now() + 7200000 }
  save(state)
  console.log(JSON.stringify({ ok: true, slot: free, group: 'browser', profile: state.leases[free].profile, owner }))
} else if (cmd === 'release') {
  delete state.leases[argv[1]]
  save(state)
  console.log(JSON.stringify({ ok: true, slot: argv[1], released: true }))
} else if (cmd === 'touch') {
  console.log(JSON.stringify({ ok: true, slot: argv[1] }))
} else if (cmd === 'status') {
  const slots = ['slot-1', 'slot-2', 'slot-3'].map((slot) => ({ slot, leased: Boolean(state.leases[slot]), owner: state.leases[slot]?.owner ?? '' }))
  console.log(JSON.stringify({ ok: true, slots }))
} else {
  console.log(JSON.stringify({ ok: false, error: 'unknown command ' + cmd }))
  process.exit(1)
}
`)

function readPoolState() {
  try {
    return JSON.parse(fs.readFileSync(fakePoolState, 'utf8'))
  } catch {
    return { leases: {} }
  }
}

/** 不注册任何工具的服务器，用来验证失败回滚。 */
const deadPlugin = path.join(tmpDir, 'dead-mcp.mjs')
fs.writeFileSync(deadPlugin, `
export const name = 'dead-mcp'
export const inject = ['tools']
export function apply() { /* 永远不注册工具 */ }
`)

try {
  const lazy = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'index.js')).href)
  await lazy.apply(ctx, {
    moduleBase: dshRoot,
    reapIntervalMs: 3_600_000,
    groups: [
      {
        id: 'fake',
        title: '假 MCP',
        hint: '测试用',
        plugin: fakePlugin,
        prefix: 'mcp__fake__',
        config: { serverName: 'fake' },
        loadTimeoutMs: 5000
      },
      {
        id: 'browser',
        title: '假浏览器',
        hint: '测试用池子组',
        plugin: fakePlugin,
        prefix: 'mcp__browser__',
        scope: 'agent',
        idleMinutes: 120,
        loadTimeoutMs: 5000,
        pool: { command: [process.execPath, fakePool], note: 'smoke' },
        config: {
          serverName: 'browser',
          args: ['--profile', '{profile}'],
          profile: '{profile}',
          slot: '{slot}'
        }
      },
      {
        id: 'dead',
        title: '起不来的组',
        hint: '测试回滚',
        plugin: deadPlugin,
        prefix: 'mcp__dead__',
        loadTimeoutMs: 400
      }
    ]
  })

  const visible = (scope) => [...ctx.tools.view(scope).visible.keys()]
  assert.deepEqual(visible(), ['load_tool_group'], 'cold start must register only the bootstrap tool')
  assert.deepEqual(sections.map((section) => section.name), ['lazy-tool-groups'])

  const loadTool = ctx.tools.view().visible.get('load_tool_group')

  // ---------------------------------------------------------------- 全局组
  const activated = await loadTool.execute({ group: 'fake' }, {})
  assert.equal(activated.ok, true)
  assert.equal(activated.status, 'activated')
  assert.equal(activated.tools, 2)
  assert.deepEqual(visible().filter((name) => name.startsWith('mcp__fake__')), ['mcp__fake__a', 'mcp__fake__b'])

  const again = await loadTool.execute({ group: 'fake' }, {})
  assert.equal(again.status, 'already active')

  const unknown = await loadTool.execute({ group: 'nope' }, {})
  assert.equal(unknown.ok, false)

  // ---------------------------------------------------------------- agent 组
  const scopeAKey = { name: 'agent-a' }
  const scopeBKey = { name: 'agent-b' }
  const scopeA = createScope(ctx, scopeAKey)
  const scopeB = createScope(ctx, scopeBKey)
  const agentA = { ctx: scopeA.ctx, session: { id: 'agent-a' } }
  const agentB = { ctx: scopeB.ctx, session: { id: 'agent-b' } }

  const loadedA = await loadTool.execute({ group: 'browser', note: 'A' }, { agent: agentA })
  assert.equal(loadedA.ok, true, `agent A load failed: ${loadedA.error}`)
  assert.equal(loadedA.slot, 'slot-1')
  assert.deepEqual(visible(scopeAKey).filter((name) => name.startsWith('mcp__browser__')), ['mcp__browser__a', 'mcp__browser__b'])
  assert.deepEqual(visible().filter((name) => name.startsWith('mcp__browser__')), [], 'agent tools must not leak into the global view')
  assert.deepEqual(visible(scopeBKey).filter((name) => name.startsWith('mcp__browser__')), [], 'agent tools must not leak into another agent')

  const loadedB = await loadTool.execute({ group: 'browser' }, { agent: agentB })
  assert.equal(loadedB.ok, true, `agent B load failed: ${loadedB.error}`)
  assert.equal(loadedB.slot, 'slot-2')
  assert.deepEqual(visible(scopeBKey).filter((name) => name.startsWith('mcp__browser__')).length, 2)
  assert.equal(Object.keys(readPoolState().leases).length, 2, 'both agents must hold their own slot')

  const statusA = await loadTool.execute({ group: 'browser', status: true }, { agent: agentA })
  assert.equal(statusA.active.length, 1)
  assert.match(statusA.active[0], /slot-1/)

  const unloadedA = await loadTool.execute({ group: 'browser', unload: true }, { agent: agentA })
  assert.equal(unloadedA.status, 'unloaded')
  assert.deepEqual(visible(scopeAKey).filter((name) => name.startsWith('mcp__browser__')), [])
  assert.deepEqual(Object.keys(readPoolState().leases), ['slot-2'], 'unload must release the slot')
  assert.equal(visible(scopeBKey).filter((name) => name.startsWith('mcp__browser__')).length, 2, 'releasing A must not touch B')

  // ---------------------------------------------------------------- 失败回滚
  const dead = await loadTool.execute({ group: 'dead' }, {})
  assert.equal(dead.ok, false, 'a server that registers no tools must fail')
  assert.deepEqual(visible().filter((name) => name.startsWith('mcp__dead__')), [], 'failed mount must be rolled back')

  // ---------------------------------------------------------------- 清理
  await loadTool.execute({ group: 'browser', unload: true }, { agent: agentB })
  await loadTool.execute({ group: 'fake', unload: true }, {})
  assert.deepEqual(visible(), ['load_tool_group'], 'unload must remove the group tools')
  assert.deepEqual(Object.keys(readPoolState().leases), [])

  await scopeA.dispose()
  await scopeB.dispose()

  console.log('dsh-lazy-mcp smoke: OK')
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
