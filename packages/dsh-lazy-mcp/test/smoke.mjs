#!/usr/bin/env node
/**
 * dsh-lazy-mcp 冒烟测试。
 *
 * 在一个真实的 cordis Context + ToolsService 上跑：
 *   1. 插件挂载后只注册 load_tool_group；
 *   2. load_tool_group 动态挂载一个子插件，工具在下一次注册检查里可见；
 *   3. 重复调用返回 already active，unload 后工具消失。
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
ctx.logger = { info() {}, warn() {}, error() {} }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-mcp-test-'))
const fakePlugin = path.join(tmpDir, 'fake-mcp.mjs')
fs.writeFileSync(fakePlugin, `
const name = 'fake-mcp'
const inject = ['tools']
function apply(ctx) {
  setTimeout(() => {
    for (const suffix of ['a', 'b']) {
      const dispose = ctx.tools.register({
        name: 'mcp__fake__' + suffix,
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

try {
  const lazy = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'index.js')).href)
  await lazy.apply(ctx, {
    moduleBase: dshRoot,
    groups: [{
      id: 'fake',
      title: '假 MCP',
      hint: '测试用',
      plugin: fakePlugin,
      prefix: 'mcp__fake__',
      loadTimeoutMs: 5000
    }]
  })

  const visible = () => [...ctx.tools.view().visible.keys()]
  assert.deepEqual(visible(), ['load_tool_group'], 'cold start must register only the bootstrap tool')
  assert.deepEqual(sections.map((section) => section.name), ['lazy-tool-groups'])

  const loadTool = ctx.tools.view().visible.get('load_tool_group')
  const activated = await loadTool.execute({ group: 'fake' }, {})
  assert.equal(activated.ok, true)
  assert.equal(activated.status, 'activated')
  assert.equal(activated.tools, 2)
  assert.deepEqual(visible().filter((name) => name.startsWith('mcp__fake__')), ['mcp__fake__a', 'mcp__fake__b'])

  const again = await loadTool.execute({ group: 'fake' }, {})
  assert.equal(again.status, 'already active')

  const unknown = await loadTool.execute({ group: 'nope' }, {})
  assert.equal(unknown.ok, false)

  const unloaded = await loadTool.execute({ group: 'fake', unload: true }, {})
  assert.equal(unloaded.status, 'unloaded')
  assert.deepEqual(visible(), ['load_tool_group'], 'unload must remove the group tools')

  console.log('dsh-lazy-mcp smoke: OK')
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
