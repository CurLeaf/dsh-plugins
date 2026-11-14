/**
 * DOM test of the browser half's primary affordance.
 *
 * The inline button and its panel are plain DOM, not React, so they are driven
 * here through a jsdom document that mirrors the transcript contract the
 * plugin anchors on (`data-chat-flow-kind="user"` + `data-chat-turn` with a
 * copy button in the action row).
 *
 * The behaviour under test is the one the product asked for: **a rewind is
 * all-or-nothing**. The panel is a preview — it lists every file, offers no
 * per-file checkbox, and the confirm request carries no `paths`.
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

for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'navigator', 'getComputedStyle']) {
	Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true })
}

const React = (await import('react')).default

after(() => {
	clearTimers()
	dom.window.close()
})

/** Every timer the plugin schedules, so a finished test can leave no tail. */
const timers = new Set()
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...args) => {
	const id = realSetTimeout(fn, ms, ...args)
	timers.add(id)
	return id
}

/** Wait for one promise microtask chain plus the plugin's polling tick. */
const settle = (ms = 20) =>
	new Promise((resolve) => {
		const id = realSetTimeout(() => {
			timers.delete(id)
			resolve()
		}, ms)
	})

/** Cancel anything the plugin left scheduled (the undo strip runs for 30 s). */
function clearTimers() {
	for (const id of timers) clearTimeout(id)
	timers.clear()
}

/* -------------------------------------------------------------------------- */
/* Host stub                                                                 */
/* -------------------------------------------------------------------------- */

const requests = []
const plan = {
	turn: 3,
	entries: [
		{ path: '/ws/a.txt', display: 'a.txt', op: 'update', restorable: true, conflict: false },
		{ path: '/ws/b.txt', display: 'b.txt', op: 'create', restorable: true, conflict: false },
	],
	stats: { files: 2, restorable: 2, conflicts: 0 },
}

const routes = {
	current: { sessionId: 'session-1' },
	list: { turns: [{ turn: 3, files: 2, at: 1 }], total: 2, lastRevert: null, usage: 0 },
	plan,
	apply: { revertId: 'revert-1', restored: 1, deleted: 1, skipped: [], conflicts: 0, files: 2 },
	forget: { forgotten: true, removed: 2 },
	hello: { ok: true, version: 1 },
	undo: { restored: 1, deleted: 1 },
}

const hostFetch = async (url, init) => {
	const body = JSON.parse(init.body)
	requests.push(body)
	const value = routes[body.action]
	return {
		status: 200,
		json: async () => ({ ok: true, value }),
	}
}
window.fetch = hostFetch
globalThis.fetch = hostFetch

/* -------------------------------------------------------------------------- */
/* Load the bundle                                                           */
/* -------------------------------------------------------------------------- */

let bundle
/** Whatever the bundle registers as a slot component, so the fallback can be rendered too. */
const slot = {}
window.__ModuleLoader__ = {
	load(entry) {
		bundle = entry.factory((id) => (id === 'react' ? React : undefined))
	},
}

await import('../lib/client.js?inline-dom-test')

assert.equal(bundle.name, 'rewind')

/* -------------------------------------------------------------------------- */
/* Mount                                                                     */
/* -------------------------------------------------------------------------- */

/** A transcript row: one user message with a copy button in its action row. */
function userRow(turn) {
	const row = document.createElement('div')
	row.setAttribute('data-chat-flow-kind', 'user')
	row.setAttribute('data-chat-turn', String(turn))
	const actions = document.createElement('div')
	const copy = document.createElement('button')
	copy.type = 'button'
	copy.textContent = 'copy'
	actions.append(copy)
	row.append(actions)
	document.body.append(row)
	return row
}

/** Minimal client context: effects run immediately and are disposed at the end. */
function makeContext() {
	const dictionaries = new Map()
	const disposers = []
	const ctx = {
		locale: {
			/* The plugin fills placeholders itself; the binder only resolves keys. */
			bind: (ns) => (key) => dictionaries.get(ns)?.[key] ?? key,
			register: (ns, dicts) => {
				dictionaries.set(ns, dicts.zh)
				return () => {}
			},
		},
		effect: (factory) => {
			const dispose = factory()
			disposers.push(dispose)
			return dispose
		},
		slots: {
			inject: (_name, install) => {
				const dispose = install()
				return typeof dispose === 'function' ? dispose : () => {}
			},
			register: (config, component) => {
				slot[config.name] = { config, component }
				return () => {}
			},
		},
	}
	const dispose = () => {
		for (const fn of disposers.reverse()) if (typeof fn === 'function') fn()
	}
	return { ctx, dispose, dictionaries }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                     */
/* -------------------------------------------------------------------------- */

/** Put the fake Host's plan/list back to the baseline between tests. */
function resetRoutes() {
	routes.list = { turns: [{ turn: 3, files: 2, at: 1 }], total: 2, lastRevert: null, usage: 0 }
	routes.plan = plan
}

test('the inline button opens a preview panel with no per-file selection', async () => {
	resetRoutes()
	const { ctx, dispose } = makeContext()
	bundle.apply(ctx)
	userRow(3)

	/* The first tick resolves the session and paints; the second one has the summary. */
	await settle(1750)

	const button = document.querySelector('[data-dsh-rewind-btn="3"]')
	assert.ok(button, 'the rewind button is painted beside the copy button')
	assert.equal(button.textContent, '↩')

	button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await settle(60)

	const panel = document.querySelector('.dsh-rewind-pop')
	assert.ok(panel, 'clicking opens the panel')

	const body = panel.textContent
	assert.match(body, /回退第 3 轮及之后/)
	assert.match(body, /写回 1 个文件|共 2 个文件/)
	assert.match(body, /全部回退/)

	/* The only checkbox left is the context-rollback choice. */
	const boxes = panel.querySelectorAll('input[type="checkbox"]')
	assert.equal(boxes.length, 1, 'no per-file checkbox remains')
	assert.equal(boxes[0].closest('.dsh-rewind-pop-forget') !== null, true, 'the one checkbox is the forget toggle')

	/* Every plan entry is still listed, as information. */
	const rows = panel.querySelectorAll('.dsh-rewind-pop-row:not(.dsh-rewind-pop-forget)')
	assert.equal(rows.length, 2)

	dispose()
	clearTimers()
})

test('confirming sends the full apply request and calls forget', async () => {
	resetRoutes()
	const { ctx, dispose } = makeContext()
	bundle.apply(ctx)
	requests.length = 0
	userRow(5)

	await settle(1750)
	const button = document.querySelector('[data-dsh-rewind-btn="3"]')
	assert.ok(button, 'the button is painted again after remount')
	button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await settle(60)

	const confirm = [...document.querySelectorAll('.dsh-rewind-pop-primary')].at(-1)
	assert.equal(confirm.textContent, '全部回退')
	confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	await settle(120)

	const applyRequest = requests.find((body) => body.action === 'apply')
	assert.ok(applyRequest, 'apply was sent')
	assert.equal(applyRequest.turn, 3)
	assert.equal(Object.hasOwn(applyRequest, 'paths'), false, 'a full revert names no files')

	const forgetRequest = requests.find((body) => body.action === 'forget')
	assert.ok(forgetRequest, 'the context rollback is requested too')
	assert.equal(forgetRequest.turn, 3)

	dispose()
	clearTimers()
})
