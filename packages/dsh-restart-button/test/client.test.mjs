/**
 * 浏览器半边的 DOM 契约测试。
 *
 * 客户端不再注册槽位，而是把按钮挂进侧栏最下面那一行（账号 / 头像行）：
 *
 *   [data-slot="sidebar.settings"] > 行容器 > 那个 aria-label="账号菜单" 的按钮
 *
 * 这些测试用 jsdom 搭出宿主那一行的最小结构，驱动同一个 bundle 入口，确认：
 *
 *   - 按钮挂在账号行里（不是另一行），带 aria-label 与自己的样式表；
 *   - 点击按钮打开确认弹窗，此时还没有发重启请求；
 *   - 点「确认重启」才 POST，进度写在弹窗里，按钮只进入忙碌态；
 *   - 账号菜单展开时点按钮：个人中心收不到这次点击，菜单被收起，弹窗打开；
 *   - 取消 / Esc 关闭弹窗且不发请求；
 *   - 侧栏折叠时隐藏，展开后再出现；React 重建行后按钮挂回；
 *   - 卸载时按钮、弹窗、样式、监听全部撤干净。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** 宿主那一行的最小结构：槽位 → 行容器 → 账号按钮。 */
function accountRowHtml({ collapsed = 'false' } = {}) {
  return `<!doctype html><html><head></head><body>
    <div class="sidebar">
      <div data-slot="sidebar.settings" style="display: contents;">
        <div class="triggerRow" style="position: relative;">
          <div class="accountRoot" style="flex: 1; position: relative;">
            <button type="button" class="account" data-collapsed="${collapsed}"
              aria-label="账号菜单" aria-haspopup="menu" aria-expanded="false"><span>CurLeaf</span></button>
          </div>
        </div>
      </div>
    </div>
  </body></html>`
}

/** 等一帧，让 MutationObserver + requestAnimationFrame 跑完。 */
function flush(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 给 jsdom 补上原生 dialog 的打开/关闭（jsdom 26 还没有 showModal）。 */
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

/**
 * 在 jsdom 里加载 bundle 并调用 apply。
 * @param {object} [options]
 * @param {string} [options.collapsed] 账号按钮的 data-collapsed。
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl] fetch 桩。
 */
function mount({ collapsed = 'false', fetchImpl } = {}) {
  const dom = new JSDOM(accountRowHtml({ collapsed }), {
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
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, pid: 1, plan: { kind: 'systemd', label: 'systemd · dsh-web.service' } }
      },
    }
  }

  // 宿主账号菜单的行为模型：触发器 click 切展开态；菜单开着时 document 上的
  // pointerdown 会把它收起（真实 Menu 的“点外部关闭”）。我们的按钮必须先于它。
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
    button: () => window.document.querySelector('.dsh-restart-inline'),
    dialog: () => window.document.querySelector('.dsh-restart-dialog'),
    row: () => window.document.querySelector('[data-slot="sidebar.settings"] > *'),
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

test('bundle 的 id / name / inject 与宿主约定一致', () => {
  const world = mount()
  assert.equal(world.plugin.name, 'restart-button')
  assert.deepEqual(JSON.parse(JSON.stringify(world.plugin.inject)), [])
  assert.equal(world.plugin.inject.length, 0, '纯 DOM 插件不需要宿主服务')
  world.dispose()
  world.dom.window.close()
})

test('按钮挂在账号行里，而不是单独一行', async () => {
  const world = mount()
  await flush()

  const button = world.button()
  assert.ok(button !== null, '没有渲染出重启按钮')
  assert.equal(button.parentElement, world.row(), '按钮必须是账号行的子节点')
  assert.equal(button.getAttribute('data-dsh-restart'), 'true')
  assert.equal(button.getAttribute('aria-label'), '重启 DSH')
  assert.equal(button.hidden, false)
  assert.ok(world.document.getElementById('dsh-restart-button/styles') !== null, '样式表没装上')

  world.dispose()
  world.dom.window.close()
})

test('点击按钮打开确认弹窗，不直接发请求', async () => {
  const world = mount()
  await flush()

  world.button().click()
  await flush()

  const dialog = world.dialog()
  assert.ok(dialog !== null, '没有弹出确认弹窗')
  assert.equal(dialog.open, true, '弹窗没有打开')
  assert.equal(dialog.dataset.mode, 'confirm')
  assert.equal(
    world.requests.filter((entry) => entry.url === 'api/restart-button/restart').length,
    0,
    '打开弹窗时不应该发重启请求',
  )
  assert.ok(dialog.textContent.includes('重启方式'), '弹窗里没有重启方式')
  assert.equal(world.host.triggerClicks, 0, '账号菜单不该被这次点击打开')

  world.dispose()
  world.dom.window.close()
})

test('确认后才 POST，进度写在弹窗里而不是按钮旁', async () => {
  let posted = false
  const world = mount({
    fetchImpl: async (url) => {
      if (url === 'api/restart-button/restart') {
        posted = true
        return { ok: true, status: 202, async json() { return { ok: true } } }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          // POST 之后换一个 pid：让客户端认定服务已经回来。
          return { ok: true, pid: posted ? 2 : 1, plan: { kind: 'systemd', label: 'systemd · dsh-web.service' } }
        },
      }
    },
  })
  await flush()

  world.button().click()
  await flush()
  world.dialog().querySelector('[data-action="confirm"]').click()
  await flush(120)

  const post = world.requests.find((entry) => entry.url === 'api/restart-button/restart')
  assert.ok(post !== undefined, '没有发出重启请求')
  assert.equal(post.init.method, 'POST')
  assert.equal(world.button().dataset.busy, 'true')
  assert.equal(world.dialog().dataset.mode, 'progress')
  assert.ok(world.dialog().textContent.includes('正在重启 DSH'), '进度没有写在弹窗里')
  assert.equal(world.document.querySelector('.dsh-restart-toast'), null, '不该再有按钮旁的提示条')

  world.dispose()
  world.dom.window.close()
})

test('服务回来后弹窗显示成功，再刷新页面', async () => {
  let posted = false
  const world = mount({
    fetchImpl: async (url) => {
      if (url === 'api/restart-button/restart') {
        posted = true
        return { ok: true, status: 202, async json() { return { ok: true } } }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, pid: posted ? 2 : 1, plan: { kind: 'systemd', label: 'systemd · dsh-web.service' } }
        },
      }
    },
  })
  await flush()

  world.button().click()
  await flush()
  world.dialog().querySelector('[data-action="confirm"]').click()
  await flush(820)

  assert.equal(world.dialog().dataset.mode, 'success')
  assert.ok(world.dialog().textContent.includes('已重启，正在刷新'), '没有成功提示')

  world.dispose()
  world.dom.window.close()
})

test('账号菜单展开时点按钮：个人中心收不到点击，菜单被收起，弹窗打开', async () => {
  const world = mount()
  await flush()

  // 模拟用户先把个人中心菜单点开。
  world.trigger.click()
  await flush(10)
  assert.equal(world.host.menuOpen, true)
  assert.equal(world.host.outsideCloses, 0)

  // 再点重启按钮：捕获阶段截住 pointerdown，宿主菜单的“点外部关闭”不会先跑；
  // 插件自己收起菜单，然后打开弹窗。
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

test('取消与 Esc 关闭弹窗，都不发请求', async () => {
  const world = mount()
  await flush()

  world.button().click()
  await flush()
  world.dialog().querySelector('[data-action="cancel"]').click()
  assert.equal(world.dialog().open, false)
  assert.equal(world.requests.filter((entry) => entry.url === 'api/restart-button/restart').length, 0)

  world.button().click()
  await flush()
  const dialog = world.dialog()
  dialog.dispatchEvent(new world.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(dialog.open, false)
  assert.equal(world.requests.filter((entry) => entry.url === 'api/restart-button/restart').length, 0)

  world.dispose()
  world.dom.window.close()
})

test('失败后弹窗给出重试与关闭', async () => {
  const world = mount({
    fetchImpl: async (url) => {
      if (url === 'api/restart-button/restart') {
        return { ok: false, status: 500, async json() { return { ok: false } } }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, pid: 1, plan: { kind: 'systemd', label: 'systemd · dsh-web.service' } }
        },
      }
    },
  })
  await flush()

  world.button().click()
  await flush()
  world.dialog().querySelector('[data-action="confirm"]').click()
  await flush(100)

  const dialog = world.dialog()
  assert.equal(dialog.dataset.mode, 'error')
  assert.ok(dialog.textContent.includes('重启请求没有送达'))
  assert.ok(dialog.querySelector('[data-action="retry"]') !== null, '失败后没有重试')
  assert.equal(world.button().dataset.busy, 'false')

  world.dispose()
  world.dom.window.close()
})

test('侧栏折叠时隐藏，展开后回到账号行', async () => {
  const world = mount()
  await flush()
  const trigger = world.trigger

  trigger.setAttribute('data-collapsed', 'true')
  await flush(80)
  assert.equal(world.button().hidden, true, '折叠导轨里不该显示')

  trigger.setAttribute('data-collapsed', 'false')
  await flush(80)
  assert.equal(world.button().hidden, false, '展开后应该回来')

  world.dispose()
  world.dom.window.close()
})

test('React 重建账号行后，按钮挂回新行', async () => {
  const world = mount()
  await flush()

  const slot = world.document.querySelector('[data-slot="sidebar.settings"]')
  const replacement = world.document.createElement('div')
  replacement.className = 'triggerRow'
  replacement.innerHTML = '<button type="button" data-collapsed="false" aria-label="账号菜单">CurLeaf</button>'
  slot.replaceChildren(replacement)
  await flush(80)

  const button = world.button()
  assert.ok(button !== null, '按钮被删掉后没有恢复')
  assert.equal(button.parentElement, replacement)

  world.dispose()
  world.dom.window.close()
})

test('卸载后按钮、弹窗、样式、监听都撤掉', async () => {
  const world = mount()
  await flush()
  assert.ok(world.button() !== null)
  world.button().click()
  await flush()
  assert.ok(world.dialog() !== null)

  world.dispose()
  await flush(30)
  assert.equal(world.document.querySelector('.dsh-restart-inline'), null)
  assert.equal(world.document.querySelector('.dsh-restart-dialog'), null)
  assert.equal(world.document.getElementById('dsh-restart-button/styles'), null)

  world.dom.window.close()
})
