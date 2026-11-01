/**
 * DOM test of the browser half.
 *
 * The bundle is rendered with real React into a jsdom document that mirrors the
 * files tab's DOM contract (`data-files-state="tree"`, `data-files-root`,
 * `data-files-entry` rows). The shared `Menu` primitive is replaced by a small
 * stand-in so the test observes the items this plugin publishes, without
 * depending on the product's portal/focus machinery.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { JSDOM } from 'jsdom'

/* -------------------------------------------------------------------------- */
/* Environment                                                               */
/* -------------------------------------------------------------------------- */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	url: 'http://127.0.0.1:58081/',
	pretendToBeVisual: true
})
const { window } = dom

for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator', 'getComputedStyle']) {
	Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = await import('react-dom/test-utils')
const { createRoot } = await import('react-dom/client')

after(() => {
	dom.window.close()
})

/* -------------------------------------------------------------------------- */
/* Harness                                                                   */
/* -------------------------------------------------------------------------- */

/** Calls made through the composer face. */
const composer = { insertions: [] }

const inputActions = {
	captureInsertion: () => ({ from: 0, to: 0 }),
	insertText: (text) => {
		composer.insertions.push(text)
		return true
	}
}

/** Every action POST the menu made, in order. */
const requests = []

/** Per-test override of the Host answer. */
let hostAnswer = (body) => ({ status: 200, body: { ok: true, action: body.action, path: body.path } })

/** Per-test override of the `remote` face (reveal target). */
let remoteFace = {
	$host: { home: '/Users/curleaf' },
	session: { openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) }
}

globalThis.fetch = async (url, init) => {
	if (String(url).includes('open-in-app/apps')) {
		return { ok: true, status: 200, json: async () => ({ apps: ['finder'] }) }
	}
	const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
	requests.push({ url, body })
	const answer = hostAnswer(body)
	return {
		ok: answer.status >= 200 && answer.status < 300,
		status: answer.status,
		json: async () => answer.body
	}
}

/** Copies the plugin's clipboard path recorded. */
const clipboard = []
Object.defineProperty(window.navigator, 'clipboard', {
	value: {
		writeText: async (text) => {
			clipboard.push(text)
		}
	},
	configurable: true
})

/** The slots registry the plugin registers into. */
const registrations = []
const slots = {
	inject: (slot, factory) => {
		assert.equal(slot, 'sidebar.right.tab.files.actions')
		return factory()
	},
	register: (options, component) => {
		registrations.push({ options, component })
		return () => {}
	}
}

/** The Cordis context the component closes over. */
const fakeCtx = {
	get(name) {
		if (name === 'slots') return slots
		if (name === 'remote') return remoteFace
		return undefined
	},
	effect: (factory) => factory()
}

/** The shared Menu stand-in: records its items and forwards selections. */
function MenuStandIn(props) {
	const items = Array.isArray(props.items) ? props.items : []
	return React.createElement(
		'div',
		{ 'data-test-menu': '', 'data-open': String(props.open === true) },
		items.map((item) =>
			item.type === 'separator'
				? React.createElement('hr', { key: item.id, 'data-menu-separator': '' })
				: React.createElement(
						'button',
						{
							key: item.id,
							type: 'button',
							'data-menu-item': item.id,
							'data-danger': String(item.danger === true),
							onClick: () => props.onSelect(item.id)
						},
						item.label
					)
		)
	)
}

/** Load the bundle against real React and the Menu stand-in. */
async function loadPlugin() {
	let registration
	const previousWindow = globalThis.window
	const loaderWindow = {
		__ModuleLoader__: {
			load: (value) => {
				registration = value
			}
		}
	}
	Object.defineProperty(globalThis, 'window', { value: loaderWindow, configurable: true, writable: true })
	try {
		await import(`../lib/client.js?dom=${Date.now()}-${Math.random()}`)
	} finally {
		Object.defineProperty(globalThis, 'window', { value: previousWindow ?? window, configurable: true, writable: true })
	}
	assert.ok(registration, 'bundle registered')
	const module = registration.factory((spec) => {
		if (spec === 'react') return React
		if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: MenuStandIn }
		throw new Error(`unexpected require: ${spec}`)
	})
	module.apply(fakeCtx)
	return module
}

const pluginInjected = loadPlugin()

/** Drain the microtasks one menu action queues. */
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
}

/** Mount the registered bridge into a minimal files-tab DOM. */
async function mount(rows, root = '/w') {
	const plugin = await pluginInjected
	const component = registrations[0].component
	document.body.innerHTML = `
		<div data-files-state="tree" data-files-root="${root}">
			<div data-header=""><span id="slot"></span></div>
			<div data-files-body><ul>${rows}</ul></div>
		</div>
	`
	const reactRoot = createRoot(document.getElementById('slot'))
	await act(async () => {
		reactRoot.render(React.createElement(component, { inputActions }))
	})
	return {
		component,
		unmount: async () => {
			await act(async () => {
				reactRoot.unmount()
			})
		}
	}
}

const FILE_ROW = (path, name) => `<li data-files-entry="file" data-files-path="${path}"><button type="button">${name}</button></li>`

/** Right-click one row. */
async function rightClick(path) {
	const target = document.querySelector(`[data-files-path="${path}"] button`)
	assert.ok(target, `row ${path}`)
	const event = new window.MouseEvent('contextmenu', {
		bubbles: true,
		cancelable: true,
		clientX: 140,
		clientY: 96
	})
	await act(async () => {
		target.dispatchEvent(event)
	})
	return event
}

/** Click one menu item. */
async function choose(id) {
	const button = document.querySelector(`[data-menu-item="${id}"]`)
	assert.ok(button, `menu item ${id} exists`)
	await act(async () => {
		button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	})
	await flush()
}

/** Click the last button of an open dialog (the confirming one). */
async function confirmDialog() {
	const buttons = [...document.querySelectorAll('.dsh-file-menu-buttons button')]
	assert.ok(buttons.length >= 2, 'dialog buttons')
	const confirm = buttons.at(-1)
	await act(async () => {
		confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	})
	await flush()
}

/** Fill the rename input the way React sees user typing. */
async function typeInto(input, value) {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
	await act(async () => {
		setter.call(input, value)
		input.dispatchEvent(new window.Event('input', { bubbles: true }))
	})
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                     */
/* -------------------------------------------------------------------------- */

test('contextmenu on a file row opens the workspace menu', async () => {
	const view = await mount(FILE_ROW('/w/AGENTS.md', 'AGENTS.md'))
	const event = await rightClick('/w/AGENTS.md')
	assert.equal(event.defaultPrevented, true, 'the native context menu is suppressed')

	const menu = document.querySelector('[data-test-menu]')
	assert.ok(menu, 'menu rendered')
	const ids = [...menu.querySelectorAll('[data-menu-item]')].map((node) => node.getAttribute('data-menu-item'))
	assert.deepEqual(ids, ['add-to-chat', 'reveal', 'copy-name', 'copy-relative', 'copy-absolute', 'rename', 'delete'])
	assert.equal(menu.querySelectorAll('[data-menu-separator]').length, 2)
	assert.equal(menu.querySelector('[data-menu-item="delete"]').getAttribute('data-danger'), 'true')
	// The reveal label follows the probed Host platform (finder → 访达).
	await flush()
	assert.match(document.querySelector('[data-test-menu]').textContent, /在访达中显示/)
	assert.match(document.querySelector('[data-test-menu]').textContent, /复制相对路径/)
	await view.unmount()
})

test('a non-openable entry opens nothing', async () => {
	const view = await mount('<li data-files-entry="other" data-files-path="/w/socket"><span>socket</span></li>')
	const target = document.querySelector('[data-files-entry="other"] span')
	const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
	await act(async () => {
		target.dispatchEvent(event)
	})
	assert.equal(event.defaultPrevented, false)
	assert.equal(document.querySelector('[data-test-menu]'), null)
	await view.unmount()
})

test('a tree that does not own the bridge is left to the other instance', async () => {
	const view = await mount(FILE_ROW('/w/AGENTS.md', 'AGENTS.md'))
	// A second, unrelated tree outside the bridge's root.
	const other = document.createElement('div')
	other.setAttribute('data-files-state', 'tree')
	other.setAttribute('data-files-root', '/other')
	other.innerHTML = FILE_ROW('/other/a.txt', 'a.txt')
	document.body.appendChild(other)
	const target = other.querySelector('button')
	const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
	await act(async () => {
		target.dispatchEvent(event)
	})
	assert.equal(event.defaultPrevented, false)
	assert.equal(document.querySelector('[data-test-menu]'), null)
	await view.unmount()
})

test('复制 / 复制相对路径 / 复制绝对路径 use the tree facts', async () => {
	const view = await mount(FILE_ROW('/w/docs/plan.md', 'plan.md'))
	clipboard.length = 0

	await rightClick('/w/docs/plan.md')
	await choose('copy-relative')
	assert.deepEqual(clipboard, ['docs/plan.md'])

	await rightClick('/w/docs/plan.md')
	await choose('copy-absolute')
	assert.deepEqual(clipboard, ['docs/plan.md', '/w/docs/plan.md'])

	await rightClick('/w/docs/plan.md')
	await choose('copy-name')
	assert.deepEqual(clipboard, ['docs/plan.md', '/w/docs/plan.md', 'plan.md'])
	await view.unmount()
})

test('添加到会话 inserts the @ mention through the composer face', async () => {
	const view = await mount(FILE_ROW('/w/my notes.md', 'my notes.md'))
	composer.insertions.length = 0
	await rightClick('/w/my notes.md')
	await choose('add-to-chat')
	assert.deepEqual(composer.insertions, ['@"my notes.md" '])
	await view.unmount()
})

test('重命名 posts one rename and reports the error inline when the Host refuses', async () => {
	const view = await mount(FILE_ROW('/w/a.txt', 'a.txt'))
	requests.length = 0

	await rightClick('/w/a.txt')
	await choose('rename')
	const input = document.querySelector('.dsh-file-menu-input')
	assert.ok(input, 'rename dialog input')
	assert.equal(input.value, 'a.txt')
	assert.match(document.querySelector('[role="dialog"]').textContent, /重命名/)

	await typeInto(input, 'b.txt')
	hostAnswer = () => ({ status: 409, body: { code: 'exists', message: '已经存在同名文件：b.txt' } })
	await confirmDialog()
	assert.deepEqual(requests.at(-1).body, { action: 'rename', path: '/w/a.txt', name: 'b.txt' })
	assert.match(document.querySelector('.dsh-file-menu-error').textContent, /已经存在同名文件/)
	assert.ok(document.querySelector('[role="dialog"]'), 'the dialog stays open on failure')

	hostAnswer = (body) => ({ status: 200, body: { ok: true, action: body.action, path: '/w/b.txt' } })
	await confirmDialog()
	assert.equal(document.querySelector('[role="dialog"]'), null, 'the dialog closes on success')
	assert.match(document.querySelector('.dsh-file-menu-toast').textContent, /已重命名为「b.txt」/)
	await view.unmount()
})

test('删除 asks once, then posts the delete and closes', async () => {
	const view = await mount('<li data-files-entry="directory" data-files-path="/w/docs"><button type="button">docs</button></li>')
	requests.length = 0
	hostAnswer = (body) => ({ status: 200, body: { ok: true, action: body.action, path: body.path } })

	await rightClick('/w/docs')
	await choose('delete')
	assert.equal(requests.length, 0, 'nothing is deleted before the confirmation')
	const dialog = document.querySelector('[role="dialog"]')
	assert.match(dialog.textContent, /确定删除/)
	assert.match(dialog.textContent, /其全部内容/)
	assert.match(dialog.textContent, /不可撤销/)

	await confirmDialog()
	assert.deepEqual(requests.at(-1).body, { action: 'delete', path: '/w/docs' })
	assert.equal(document.querySelector('[role="dialog"]'), null)
	assert.match(document.querySelector('.dsh-file-menu-toast').textContent, /已删除「docs」/)
	await view.unmount()
})

test('在访达中显示 goes through the Host reveal face', async () => {
	const calls = []
	remoteFace = {
		$host: { home: '/Users/curleaf' },
		session: {
			openWorkspacePath: async (request) => {
				calls.push(request)
				return { ok: true, value: { opened: true } }
			}
		}
	}
	const view = await mount(FILE_ROW('/w/a.txt', 'a.txt'))
	await rightClick('/w/a.txt')
	await choose('reveal')
	assert.deepEqual(calls, [{ path: '/w/a.txt', action: 'reveal' }])
	await view.unmount()
})

test('Escape closes the dialog without calling the Host', async () => {
	const view = await mount(FILE_ROW('/w/a.txt', 'a.txt'))
	requests.length = 0
	await rightClick('/w/a.txt')
	await choose('rename')
	const input = document.querySelector('.dsh-file-menu-input')
	await act(async () => {
		input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
	})
	await flush()
	assert.equal(document.querySelector('[role="dialog"]'), null)
	assert.equal(requests.length, 0)
	await view.unmount()
})
