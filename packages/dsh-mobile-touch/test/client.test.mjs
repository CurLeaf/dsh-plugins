import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * 只验证「注入给宿主的 CSS」本身：把 client.js 在 VM 里跑起来，
 * 用假的 document 接住那支 <style>，然后按字符串钉住几条关键约定。
 *
 * 起因（真机 390×844 实测）：会话视图的「对话 / 轨迹」选中下划线**就是**
 * 宿主 .tabActive::after（2px 高 + 品牌色）。命中区扩展原来也写 ::after，
 * min-height:44px 把那条 2px 下划线撑成 44×44 的蓝色色块，未选中项因为是透明
 * 背景才看不出来 —— 表现就是「选中态多出一个异常色块」。这里钉住它必须走 ::before。
 */
function loadCss() {
	const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
	const styles = []
	const element = () => ({ attrs: {}, setAttribute(name, value) { this.attrs[name] = value }, textContent: '' })
	const document = {
		head: { appendChild: (node) => styles.push(node) },
		querySelector: () => null,
		createElement: element,
		addEventListener: () => {},
	}
	const sandbox = {
		window: { __ModuleLoader__: { load: (entry) => { sandbox.__entry = entry } } },
		document,
		console,
	}
	sandbox.globalThis = sandbox
	vm.createContext(sandbox)
	vm.runInContext(source, sandbox, { filename: 'client.js' })
	const entry = sandbox.__entry
	assert.ok(entry, '必须以 window.__ModuleLoader__.load 装载')
	assert.equal(entry.id, 'dsh-mobile-touch')
	const face = entry.factory(() => null)
	assert.equal(typeof face?.apply, 'function', '工厂必须返回 { apply }')
	face.apply()
	assert.equal(styles.length, 1, 'apply 必须恰好注入一支样式表')
	return styles[0].textContent
}

test('会话视图的 tab 命中区走 ::before，不抢宿主的 ::after 下划线', () => {
	const css = loadCss()
	assert.match(css, /\[role="tab"\]::before\s*\{/, 'tab 的命中区必须用 ::before')
	assert.doesNotMatch(css, /\[role="tab"\]::after/, 'tab 上不能再写 ::after（宿主用它画选中下划线）')
})

test('命中区仍然是 44×44 起步，扩展偏移没被改小', () => {
	const css = loadCss()
	const block = css.slice(css.indexOf('[role="tab"]::before'))
	const body = block.slice(0, block.indexOf('}'))
	assert.match(body, /min-width:\s*44px/)
	assert.match(body, /min-height:\s*44px/)
	assert.match(body, /inset:\s*-4px -5px/, "两个 tab 盒只隔 12px，-5 是既不重叠又够宽的实测值")
})

test('其它按钮仍然用 ::after 扩展（只有 tab 需要换边）', () => {
	const css = loadCss()
	assert.match(css, /button\[aria-label="打开侧栏"\]::after/, '侧栏按钮保持 ::after')
	assert.match(css, /button\[aria-label\^="发送"\]::after/)
})

test('仍然只在 ≤640 生效，桌面端零影响', () => {
	const css = loadCss()
	assert.match(css, /@media \(max-width: 640px\)/)
	assert.ok(css.indexOf('@media (max-width: 640px)') < css.indexOf('[role="tab"]::before'), '命中区规则必须在窄屏媒体查询里')
})
