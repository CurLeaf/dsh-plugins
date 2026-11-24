import { strict as assert } from 'node:assert'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** 宿主账号行的最小结构。 */
function accountRowHtml() {
  return `<!doctype html><html><head></head><body>
    <div class="sidebar">
      <div data-slot="sidebar.settings" style="display: contents;">
        <div class="triggerRow" style="position: relative;">
          <div class="accountRoot" style="flex: 1; position: relative;">
            <button type="button" class="account" data-collapsed="false"
              aria-label="账号菜单" aria-haspopup="menu" aria-expanded="false"><span>CurLeaf</span></button>
          </div>
        </div>
      </div>
    </div>
  </body></html>`
}

const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

function polyfillDialog(window) {
  const prototype = window.HTMLDialogElement?.prototype
  if (prototype === undefined) return
  prototype.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  prototype.close = function close() {
    this.removeAttribute('open')
    this.dispatchEvent(new window.Event('close'))
  }
}

/** 一份后端快照：有新版本 / 已是最新 / 正在更新。 */
function snapshot({ available = true, active = false, phase = 'installing' } = {}) {
  return {
    ok: true,
    pid: 1,
    running: '0.2.2-rc.3',
    active,
    status: active ? { phase, from: '0.2.2-rc.3', to: '0.2.3' } : null,
    checker: {
      current: '0.2.2-rc.3',
      target: available ? '0.2.3' : '0.2.2-rc.3',
      updateAvailable: available,
      lastCheckAt: Date.now(),
      lastError: '',
      intervalMs: 900000,
    },
  }
}

/**
 * 在 jsdom 里加载 bundle 并调用 apply。
 * @param {object} [options]
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl] fetch 桩。
 */
function mount({ fetchImpl } = {}) {
  const dom = new JSDOM(accountRowHtml(), {
    url: 'http://127.0.0.1:3080/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const { window } = dom
  polyfillDialog(window)
  const requests = []

  window.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (fetchImpl) return fetchImpl(String(url), init ?? {})
    return { ok: true, status: 200, async json() { return snapshot() } }
  }

  const host = { menuOpen: false, triggerClicks: 0, outsideCloses: 0 }
  const trigger = window.document.querySelector('button[aria-haspopup="menu"]')
  trigger.addEventListener('click', () => {
    host.triggerClicks += 1
    host.menuOpen = !host.menuOpen
    trigger.setAttribute('aria-expanded', String(host.menuOpen))
  })
  window.document.addEventListener('pointerdown', () => {
    if (!host.menuOpen) return
    host.outsideCloses += 1
    host.menuOpen = false
    trigger.setAttribute('aria-expanded', 'false')
  })

  let plugin
  window.__ModuleLoader__ = {
    load: (entry) => {
      plugin = entry.factory(() => {
        throw new Error('this bundle requires no modules')
      })
    },
  }

  window.eval(SOURCE)
  assert.ok(plugin !== undefined, 'bundle 没有交回 plugin')

  const disposers = []
  const ctx = {
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  plugin.apply(ctx)

  return {
    dom,
    window,
    document: window.document,
    plugin,
    requests,
    host,
    trigger,
    button: () => window.document.querySelector('.dsh-update-inline'),
    dialog: () => window.document.querySelector('.dsh-update-dialog'),
    row: () => window.document.querySelector('[data-slot="sidebar.settings"] > *'),
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/** 带版本号的后端状态。 */
function statusPayload(options) {
  return { ok: true, status: 200, async json() { return snapshot(options) } }
}

test('client.js 通过 ModuleLoader 注册，并导出 apply/inject', async () => {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        captured = options
      },
    },
  }
  await import('../lib/client.js')
  assert.ok(captured, '必须以 __ModuleLoader__.load 注册')
  assert.equal(captured.id, 'dsh-update-button')
  const mod = captured.factory(() => {})
  assert.equal(mod.name, 'update-button')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
  delete globalThis.window
})

test('按钮挂在账号行里，点击打开带版本对比的确认弹窗', async () => {
  const world = mount()
  await flush(80)

  const button = world.button()
  assert.ok(button !== null, '没有渲染出更新按钮')
  assert.equal(button.parentElement, world.row(), '按钮必须是账号行的子节点')
  assert.equal(button.getAttribute('data-dsh-update'), 'true')
  assert.equal(button.getAttribute('data-available'), 'true', '有新版本时按钮该显示小圆点')
  assert.ok(world.document.getElementById('dsh-update-button/styles') !== null, '样式表没装上')

  button.click()
  await flush()

  const dialog = world.dialog()
  assert.ok(dialog !== null, '没有弹出更新弹窗')
  assert.equal(dialog.open, true)
  assert.equal(dialog.dataset.mode, 'confirm')
  assert.ok(dialog.textContent.includes('0.2.2-rc.3'), '弹窗里没有当前版本')
  assert.ok(dialog.textContent.includes('0.2.3'), '弹窗里没有目标版本')
  assert.equal(
    world.requests.filter((entry) => entry.url === 'api/update-button/start').length,
    0,
    '打开弹窗时不该开始更新',
  )
  assert.equal(world.requests.filter((entry) => entry.url === 'api/update-button/check').length, 0,
    '已经知道有新版本时不该再查一次')

  world.dispose()
  world.dom.window.close()
})

test('没有新版本时先检查，结果写进弹窗', async () => {
  const world = mount({
    fetchImpl: async (url) => {
      if (url.startsWith('api/update-button/check')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              current: '0.2.2-rc.3',
              target: '0.2.2-rc.3',
              updateAvailable: false,
              lastCheckAt: Date.now(),
            }
          },
        }
      }
      return statusPayload({ available: false })
    },
  })
  await flush(80)

  world.button().click()
  await flush(150)

  const dialog = world.dialog()
  assert.ok(dialog !== null)
  assert.equal(dialog.dataset.mode, 'result')
  assert.ok(dialog.textContent.includes('已是最新版本'))
  assert.ok(world.requests.some((entry) => entry.url.startsWith('api/update-button/check?force=1')))

  world.dispose()
  world.dom.window.close()
})

test('确认后才 POST，进度写在弹窗里', async () => {
  let posted = false
  const world = mount({
    fetchImpl: async (url) => {
      if (url === 'api/update-button/start') {
        posted = true
        return { ok: true, status: 202, async json() { return { ok: true } } }
      }
      return statusPayload(posted ? { active: true, phase: 'installing' } : { available: true })
    },
  })
  await flush(80)

  world.button().click()
  await flush()
  world.dialog().querySelector('[data-action="confirm"]').click()
  await flush(150)

  const post = world.requests.find((entry) => entry.url === 'api/update-button/start')
  assert.ok(post !== undefined, '没有发出更新请求')
  assert.equal(post.init.method, 'POST')
  assert.equal(world.button().dataset.busy, 'true')
  assert.equal(world.dialog().dataset.mode, 'progress')
  assert.ok(world.dialog().textContent.includes('正在更新 DSH'), '进度没有写在弹窗里')
  assert.equal(world.document.querySelector('.dsh-update-toast'), null, '不该再有按钮旁的提示条')

  world.dispose()
  world.dom.window.close()
})

test('账号菜单展开时点按钮：个人中心收不到点击，菜单被收起，弹窗打开', async () => {
  const world = mount()
  await flush(80)

  world.trigger.click()
  await flush(10)
  assert.equal(world.host.menuOpen, true)

  const button = world.button()
  button.dispatchEvent(new world.window.Event('pointerdown', { bubbles: true }))
  button.click()
  await flush()

  assert.equal(world.host.outsideCloses, 0, '个人中心抢到了这次点击')
  assert.equal(world.host.menuOpen, false, '菜单没有收起')
  assert.equal(world.dialog().open, true, '弹窗没有打开')
  assert.equal(world.host.triggerClicks, 2, '应收起账号菜单（打开 + 收起各一次）')

  world.dispose()
  world.dom.window.close()
})

test('取消关闭弹窗，不发更新请求', async () => {
  const world = mount()
  await flush(80)

  world.button().click()
  await flush()
  world.dialog().querySelector('[data-action="cancel"]').click()

  assert.equal(world.dialog().open, false)
  assert.equal(world.requests.filter((entry) => entry.url === 'api/update-button/start').length, 0)

  world.dispose()
  world.dom.window.close()
})

test('更新失败时弹窗给出日志与重试', async () => {
  const world = mount({
    fetchImpl: async (url) => {
      if (url === 'api/update-button/start') {
        return { ok: false, status: 500, async json() { return { ok: false, message: '装包失败' } } }
      }
      if (url.startsWith('api/update-button/log')) {
        return { ok: true, status: 200, async json() { return { ok: true, lines: ['npm ERR! test failure'] } } }
      }
      return statusPayload()
    },
  })
  await flush(80)

  world.button().click()
  await flush()
  world.dialog().querySelector('[data-action="confirm"]').click()
  await flush(120)

  const dialog = world.dialog()
  assert.equal(dialog.dataset.mode, 'error')
  assert.ok(dialog.textContent.includes('没能启动更新'))
  assert.ok(dialog.querySelector('[data-action="retry"]') !== null, '失败后没有重试')
  assert.ok(dialog.querySelector('[data-action="log"]') !== null, '失败后没有日志入口')
  assert.equal(world.button().dataset.busy, 'false')

  dialog.querySelector('[data-action="log"]').click()
  await flush(80)
  const log = world.document.querySelector('.dsh-update-log-dialog')
  assert.ok(log !== null, '没有打开日志弹窗')
  assert.equal(log.open, true)
  assert.ok(log.textContent.includes('npm ERR! test failure'), '日志内容没有加载')

  world.dispose()
  world.dom.window.close()
})

test('页面刷新时如果更新还在跑，弹窗自动打开进度', async () => {
  const world = mount({
    fetchImpl: async () => statusPayload({ active: true, phase: 'verifying' }),
  })
  await flush(120)

  const dialog = world.dialog()
  assert.ok(dialog !== null, '没有自动打开进度弹窗')
  assert.equal(dialog.open, true)
  assert.equal(dialog.dataset.mode, 'progress')
  assert.ok(dialog.textContent.includes('正在校验新版本'))
  assert.equal(world.button().dataset.busy, 'true')

  world.dispose()
  world.dom.window.close()
})

test('卸载后按钮、弹窗、样式、监听都撤掉', async () => {
  const world = mount()
  await flush(80)
  world.button().click()
  await flush()
  assert.ok(world.dialog() !== null)

  world.dispose()
  await flush(30)

  assert.equal(world.document.querySelector('.dsh-update-inline'), null)
  assert.equal(world.document.querySelector('.dsh-update-dialog'), null)
  assert.equal(world.document.getElementById('dsh-update-button/styles'), null)

  world.dom.window.close()
})
