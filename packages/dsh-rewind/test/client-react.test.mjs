/**
 * DOM test of the browser half's footer fallback (React).
 *
 * The inline button is primary; `RewindTurn` is the footer slot component the
 * Host renders when DOM anchoring is unavailable. It shares the same promise:
 * one button, one full revert, no per-file picking.
 *
 * The module keeps a little module-level state, so this file owns its own
 * jsdom document and never shares it with the inline test.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	url: 'http://127.0.0.1:58082/',
	pretendToBeVisual: true
})
const { window } = dom

for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'navigator', 'getComputedStyle']) {
	Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const act = React.act ?? (await import('react-dom/test-utils')).act

/* Every timer the plugin schedules, so the test leaves none behind. */
const timers = new Set()
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...args) => {
	const id = realSetTimeout(fn, ms, ...args)
	timers.add(id)
	return id
}

const settle = (ms = 20) => new Promise((resolve) => realSetTimeout(resolve, ms))

after(() => {
	for (const id of timers) clearTimeout(id)
	dom.window.close()
})

/* -------------------------------------------------------------------------- */
/* Host stub                                                                 */
/* -------------------------------------------------------------------------- */

window.fetch = async (_url, init) => {
	const body = JSON.parse(init.body)
	const value =
		body.action === 'list'
			? { turns: [{ turn: 4, files: 1, at: 2 }, { turn: 3, files: 2, at: 1 }], total: 3, lastRevert: null, usage: 0 }
			: body.action === 'plan'
				? {
						turn: 3,
						entries: [
							{ path: '/ws/a.txt', display: 'a.txt', op: 'update', restorable: true, conflict: false },
							{ path: '/ws/b.txt', display: 'b.txt', op: 'create', restorable: true, conflict: false },
						],
						stats: { files: 2, restorable: 2, conflicts: 0 },
					}
				: { revertId: 'revert-1', restored: 1, deleted: 1, skipped: [], conflicts: 0, files: 2 }
	return { status: 200, json: async () => ({ ok: true, value }) }
}
globalThis.fetch = window.fetch

/* -------------------------------------------------------------------------- */
/* Load the bundle                                                           */
/* -------------------------------------------------------------------------- */

let bundle
const slots = {}
window.__ModuleLoader__ = {
	load(entry) {
		bundle = entry.factory((id) => (id === 'react' ? React : undefined))
	},
}

await import('../lib/client.js?react-fallback-test')

/** Minimal client context whose slot registry keeps what the bundle registers. */
function makeContext() {
	const disposers = []
	const ctx = {
		locale: {
			bind: () => (key) => key,
			register: () => () => {},
		},
		effect: (factory) => {
			const dispose = factory()
			disposers.push(dispose)
			return dispose
		},
		slots: {
			inject: (_name, install) => install(),
			register: (config, component) => {
				slots[config.name] = component
				return () => {}
			},
		},
	}
	return {
		ctx,
		dispose: () => {
			for (const fn of disposers.reverse()) if (typeof fn === 'function') fn()
			for (const id of timers) clearTimeout(id)
			timers.clear()
		},
	}
}

/** The injected translator stands in for the Host's locale binder: it resolves keys only. */
const t = (key) => {
	const dict = {
		'title': '回退到本轮开始之前',
		'action.count': '回退本轮 · {count} 个文件',
		'action.count.all': '回退本轮及之后 · {count} 个文件',
		'action.label': '回退本轮',
		'explain': '写回这一轮及之后所有轮改过的文件，一次全量，不挑文件。',
		'apply': '全部回退',
		'cancel': '取消',
		'files': '{count} 个文件',
		'conflicts': '{count} 个文件被你在之后改动过，这次跳过',
		'scope': '共 {files} 个文件：写回 {restore} 个，删除 {remove} 个',
		'scope.none': '没有可写回的文件',
		'delete': '删除',
		'conflict': '你改过',
		'unrestorable': '不可还原',
	}
	return dict[key] ?? key
}

test('the fallback button counts the whole tail and opens the same preview', async () => {
	const { ctx, dispose } = makeContext()
	bundle.apply(ctx)

	const RewindTurn = slots['conversation.chat.turnTail']
	assert.ok(RewindTurn, 'the footer slot component is registered')

	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)

	try {
		await act(async () => {
			root.render(React.createElement(RewindTurn, { turn: 3, seq: 1, sessionId: 'session-1', t }))
		})
		await act(async () => {
			await settle(30)
		})

		const button = container.querySelector('.dsh-rewind-button')
		assert.ok(button, 'the button renders once the summary lands')
		/* Turn 4 follows turn 3, so the button counts the whole tail. */
		assert.match(button.textContent, /回退本轮及之后 · 3 个文件/)

		await act(async () => {
			button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
			await settle(30)
		})

		const panel = container.querySelector('.dsh-rewind-panel')
		assert.ok(panel, 'clicking opens the panel')
		assert.equal(panel.querySelectorAll('input[type="checkbox"]').length, 0, 'no per-file checkbox')
		assert.match(panel.textContent, /全部回退/)
	} finally {
		await act(async () => {
			root.unmount()
		})
		container.remove()
		dispose()
	}
})
