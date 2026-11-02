/**
 * 浏览器半边的契约测试。
 *
 * 客户端文件只做两件「不跑界面也能断言」的事：把插件交给 loader，把动作注册进
 * `sidebar.footer.action`。这里用桩 loader + 桩 React 驱动同一入口，确认：
 *
 *   - 注册名、id、顺序（桌面与手机抽屉用的是同一个槽位，注册一次两边都有）；
 *   - 组件是函数，且 `wide=false`（折叠导轨）时仍能渲染出按钮；
 *   - 样式表只装一次、卸载时移除；
 *   - 请求路径是相对路径（转发到子路径部署时不逃出前缀）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')

/** 最小 React 桩：只建元素，不渲染。 */
function stubReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  }
}

/**
 * 用桩环境加载客户端 bundle。
 * @returns {{plugin: object, registrations: object[], styles: object[], cleanup: Function[]}}
 */
function loadClient() {
  const registrations = []
  const styles = []
  const cleanups = []
  let plugin

  const document = {
    baseURI: 'http://127.0.0.1:8710/',
    head: { appendChild: (tag) => styles.push(tag) },
    body: { appendChild: () => {} },
    getElementById: (id) => styles.find((tag) => tag.id === id) ?? null,
    createElement: () => ({
      id: '',
      className: '',
      dataset: {},
      style: {},
      textContent: '',
      append() {},
      appendChild() {},
      addEventListener() {},
      remove() {},
      querySelectorAll: () => [],
      setAttribute() {},
    }),
    querySelector: () => null,
  }

  const context = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          assert.equal(entry.id, 'dsh-restart-button')
          plugin = entry.factory((name) => {
            if (name === 'react') return stubReact()
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
      location: { reload: () => {} },
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document,
    navigator: { platform: 'Linux', userAgent: 'node' },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error('no host in this test')
    },
    URL,
  }

  vm.runInNewContext(readFileSync(CLIENT_PATH, 'utf8'), context, { filename: CLIENT_PATH })
  assert.ok(plugin !== undefined, 'bundle 没有交回 plugin')

  const ctx = {
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { plugin, registrations, styles, cleanups }
}

test('注入的服务与宿主约定一致', () => {
  const { plugin } = loadClient()
  assert.equal(plugin.name, 'restart-button')
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.inject)), ['slots'])
})

test('注册进侧栏脚部的动作槽位，桌面与抽屉共用', () => {
  const { registrations } = loadClient()
  assert.equal(registrations.length, 1)
  const [entry] = registrations
  assert.equal(entry.options.name, 'sidebar.footer.action')
  assert.equal(entry.options.id, 'restart-button')
  assert.equal(entry.options.order, 30)
  assert.equal(entry.options.label, '重启 DSH')
  assert.equal(typeof entry.component, 'function')
})

test('折叠导轨（wide=false）也渲染按钮，文字标签保留在 aria 里', () => {
  const { registrations } = loadClient()
  const [entry] = registrations
  const element = entry.component({ wide: false })
  assert.equal(element.type, 'button')
  assert.equal(element.props['data-wide'], 'false')
  assert.equal(element.props['data-dsh-restart'], 'true')
  assert.equal(element.props['aria-label'], '重启 DSH')
  assert.equal(element.props.disabled, false)
})

test('样式表只装一次，卸载时移除', () => {
  const { styles, cleanups } = loadClient()
  assert.equal(styles.length, 1)
  assert.equal(styles[0].id, 'dsh-restart-button/styles')
  assert.ok(styles[0].textContent.includes('.dsh-restart-row'))
  assert.equal(cleanups.length >= 1, true)
  let removed = false
  styles[0].remove = () => {
    removed = true
  }
  for (const dispose of cleanups) dispose()
  assert.equal(removed, true)
})

test('请求走相对路径，转发部署下不会逃出前缀', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.ok(source.includes("'api/restart-button/status'"))
  assert.ok(source.includes("'api/restart-button/restart'"))
  assert.equal(source.includes("'/api/restart-button"), false, '客户端不能用根绝对路径')
})
