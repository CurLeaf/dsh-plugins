/**
 * DOM test of the shared-context-menu host.
 *
 * The host is mounted in `conversation.input.dock`; it must capture the
 * composer face and render the rename/delete dialog that the menu callbacks
 * open. The shared menu itself is replaced by the provider registry stand-in.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	url: 'http://127.0.0.1:58082/',
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

/** Every Host action POST made by the dialog. */
const requests = []
globalThis.fetch = async (_url, init) => {
	const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
	requests.push(body)
	return {
		ok: true,
		status: 200,
		json: async () => ({ ok: true, action: body.action, path: body.path })
	}
}

/** Load and apply the bundle against a context-menu-capable Cordis stand-in. */
async function boot() {
	let registration
	const loaderWindow = {
		__ModuleLoader__: {
			load: (value) => {
				registration = value
			}
		}
	}
	const previousWindow = globalThis.window
	globalThis.window = loaderWindow
	try {
		await import(`../lib/client.js?context-menu-dom=${Date.now()}-${Math.random()}`)
	} finally {
		globalThis.window = previousWindow
	}
	assert.ok(registration, 'bundle registered')

	const registrations = []
	const slots = {
		inject: (_slot, factory) => factory(),
		register: (options, component) => {
			registrations.push({ options, component })
			return () => {}
		}
	}
	const providers = new Map()
	const notices = []
	const contextMenus = {
		register(input) {
			providers.set(`${input.target}/${input.id}`, input)
			return () => {}
		},
		notify(text, success) {
			notices.push({ text, success })
		}
	}
	const sessions = { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/w' } } }) } }
	const remote = {
		workspaceFiles: { stat: async (_sessionId, path) => ({ ok: true, value: { absolutePath: path } }) },
		session: { openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) }
	}
	const ctx = {
		get(name) {
			if (name === 'slots') return slots
			if (name === 'contextMenus') return contextMenus
			if (name === 'sessions') return sessions
			if (name === 'remote') return remote
			return undefined
		},
		effect: (factory) => factory()
	}
	const module = registration.factory((spec) => {
		if (spec === 'react') return React
		if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: () => null }
		throw new Error(`unexpected require: ${spec}`)
	})
	globalThis.window = loaderWindow
	try {
		module.apply(ctx)
	} finally {
		globalThis.window = previousWindow
	}
	return { module, registrations, providers, notices }
}

/** Render the registered dock host into a fresh root. */
async function mountHost(registrations) {
	const registration = registrations.find((entry) => entry.options.name === 'conversation.input.dock')
	assert.ok(registration, 'the composer dock host is registered')
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	const insertions = []
	const inputActions = {
		captureInsertion: () => ({ draftRev: 1 }),
		insertText: (text) => {
			insertions.push(text)
			return true
		}
	}
	await act(async () => {
		root.render(React.createElement(registration.component, { sessionId: 's1', inputActions }))
	})
	return {
		insertions,
		inputActions,
		container,
		unmount: async () => {
			await act(async () => root.unmount())
			container.remove()
		}
	}
}

/** Drain the microtasks a menu action queues. */
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
}

test('the dock host captures inputActions for the shared menu', async () => {
	const { module, registrations, providers } = await boot()
	const view = await mountHost(registrations)

	const provider = providers.get('file/file-tree-menu.chat')
	const [action] = provider.resolve({ sessionId: 's1', path: '/w/docs/plan.md' }, new AbortController().signal)
	await act(async () => {
		await action.run()
	})
	assert.deepEqual(view.insertions, ['@docs/plan.md '])
	assert.equal(module.__internals.composerFaces.get('s1'), view.inputActions)
	await view.unmount()
	assert.equal(module.__internals.composerFaces.has('s1'), false)
})

test('the dock host renders the delete dialog and posts the absolute path', async () => {
	const { registrations, providers } = await boot()
	const view = await mountHost(registrations)
	requests.length = 0

	const edit = providers.get('directory/file-tree-menu.edit')
	const actions = await edit.resolve({ sessionId: 's1', path: '/w/docs' }, new AbortController().signal)
	const remove = actions.find((action) => action.id === 'delete')
	await act(async () => {
		remove.run()
	})

	const dialog = document.querySelector('[role="dialog"]')
	assert.ok(dialog, 'delete dialog rendered')
	assert.match(dialog.textContent, /确定删除/)
	assert.match(dialog.textContent, /其全部内容/)
	await act(async () => {
		dialog.querySelectorAll('button')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
	})
	await flush()
	assert.deepEqual(requests.at(-1), { action: 'delete', path: '/w/docs' })
	assert.equal(document.querySelector('[role="dialog"]'), null)
	await view.unmount()
})
