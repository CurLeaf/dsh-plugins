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
 *   - 第一下是「确认重启？」，4 秒逻辑由 blur / 超时收回（这里用 blur 驱动）；
 *   - 侧栏折叠（data-collapsed="true"）时隐藏，展开后再出现；
 *   - React 把行重建掉以后，MutationObserver 会把按钮挂回新行；
 *   - 第二下真的 POST 到 `api/restart-button/restart`；
 *   - 卸载时按钮、样式、监听全部撤干净。
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
          <div data-slot="settings.launcher" style="display: contents;">
            <button type="button" class="account" data-collapsed="${collapsed}" aria-label="账号菜单">
              <span>CurLeaf</span>
            </button>
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
    button: () => window.document.querySelector('.dsh-restart-inline'),
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

test('第一下进入确认态，blur 收回', async () => {
  const world = mount()
  await flush()
  const button = world.button()

  button.click()
  assert.equal(button.dataset.armed, 'true')
  assert.equal(button.getAttribute('aria-label'), '确认重启 DSH')
  assert.equal(button.textContent, '确认重启？')
  assert.equal(world.requests.length, 0, '第一下不应该发请求')

  button.dispatchEvent(new world.window.Event('blur'))
  assert.equal(button.dataset.armed, 'false')
  assert.equal(world.requests.length, 0)

  world.dispose()
  world.dom.window.close()
})

test('侧栏折叠时隐藏，展开后回到账号行', async () => {
  const world = mount()
  await flush()
  const trigger = world.document.querySelector('button[data-collapsed]')

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

test('第二下发 POST 到重启路由', async () => {
  const world = mount()
  await flush()
  const button = world.button()

  button.click()
  button.click()
  await flush(60)

  const post = world.requests.find((entry) => entry.url === 'api/restart-button/restart')
  assert.ok(post !== undefined, '没有发出重启请求')
  assert.equal(post.init.method, 'POST')
  assert.equal(button.dataset.busy, 'true')

  world.dispose()
  await flush(20)
  world.dom.window.close()
})

test('卸载后按钮、样式、监听都撤掉', async () => {
  const world = mount()
  await flush()
  assert.ok(world.button() !== null)

  world.dispose()
  await flush(30)
  assert.equal(world.document.querySelector('.dsh-restart-inline'), null)
  assert.equal(world.document.getElementById('dsh-restart-button/styles'), null)

  world.dom.window.close()
})
