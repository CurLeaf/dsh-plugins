/**
 * `dsh-shell-ui` 的浏览器半边是纯 DOM 补丁，这里用 jsdom 起一个最小宿主：
 * 假 `__ModuleLoader__` 收下 factory，假 ctx 提供 effect / slots / locale。
 *
 * 合并两个插件最容易坏的地方是清理函数漏了一半，所以这里两头都断言：
 * 装上之后两个 style 标签和「更多」菜单行都在，卸载之后不留痕。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

const SETTINGS_CSS = 'dsh-shell-ui/settings.css'
const FOLD_CSS = 'dsh-shell-ui/sidebar-fold.css'

/** 起一个最小宿主，返回注册到的 factory 与生命周期收集器。 */
function boot() {
  const dom = new JSDOM('<!doctype html><html><body><nav></nav></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const { window } = dom
  let factory
  window.__ModuleLoader__ = {
    load({ id, factory: make }) {
      assert.equal(id, 'dsh-shell-ui', '模块 id 必须与包名一致')
      factory = make
    },
  }
  window.eval(CLIENT)

  const cleanups = []
  const registered = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    get() {
      return undefined
    },
    slots: {
      subscribe() {
        return () => {}
      },
      inject(_slot, run) {
        run()
      },
      register(_entry, component) {
        registered.push(component)
        return () => {}
      },
      entriesOfSlot() {
        return []
      },
    },
  }

  /** 假 require：React 只用到 createElement，primitives 只解构两个组件。 */
  const requireStub = (name) => {
    if (name === 'react') return { createElement: () => null }
    return { MenuItemButton: () => null, IconCheckOutlineRegular: () => null }
  }

  return { window, factory, ctx, cleanups, registered, requireStub }
}

test('注入面是两半的并集，apply 可用', () => {
  const { factory, requireStub } = boot()
  const mod = factory(requireStub)
  // jsdom 里 eval 出来的数组属于另一个 realm，逐项比较而不是 deepEqual
  assert.equal(JSON.stringify(mod.inject), JSON.stringify(['slots', 'locale']))
  assert.equal(typeof mod.apply, 'function')
})

test('装好之后两个外观层都在', () => {
  const { window, factory, ctx, requireStub, registered, cleanups } = boot()
  factory(requireStub).apply(ctx)

  const styleOf = (id) => window.document.querySelector(`style[data-plugin-css="${id}"]`)
  assert.ok(styleOf(SETTINGS_CSS), '设置面板的样式表必须挂上')
  assert.ok(window.document.getElementById(FOLD_CSS), '左栏折叠的样式表必须挂上')
  assert.equal(registered.length, 1, '「更多」菜单里必须有一条折叠面板行')
  assert.equal(cleanups.length, 2, '两半各挂一个清理函数')
})

test('卸载之后不留样式表，折叠标志位复位', () => {
  const { window, factory, ctx, requireStub, cleanups } = boot()
  factory(requireStub).apply(ctx)
  for (const dispose of cleanups) dispose()

  assert.equal(window.document.querySelectorAll('style').length, 0)
  assert.equal(window.__DSH_SHELL_UI_FOLD_APPLIED__, false)
})
