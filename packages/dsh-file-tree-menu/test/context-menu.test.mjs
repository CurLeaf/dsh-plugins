/**
 * Shared-context-menu tests.
 *
 * DSH 0.2.2 exposes `contextMenus` with `file` and `directory` targets. The
 * bundle must register its contributions there instead of installing the old
 * DOM capture listener, and its callbacks must insert a workspace-relative
 * `@` reference into the Session's composer.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const reactStub = {
	createElement: () => null,
	Fragment: Symbol('react.fragment'),
	useCallback: (fn) => fn,
	useEffect: () => {},
	useRef: () => ({ current: null }),
	useState: (value) => [value, () => {}]
}

/** Load the bundle and apply it against a context-menu-capable Cordis stand-in. */
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
	const previousDocument = globalThis.document
	globalThis.window = loaderWindow
	globalThis.document = undefined
	try {
		await import(`../lib/client.js?context-menu=${Date.now()}-${Math.random()}`)
	} finally {
		globalThis.window = previousWindow
		globalThis.document = previousDocument
	}
	assert.ok(registration, 'the bundle registers itself')

	const registrations = []
	const injections = []
	const slots = {
		inject(slot, factory) {
			injections.push(slot)
			const dispose = factory()
			return () => {
				if (typeof dispose === 'function') dispose()
			}
		},
		register(options, component) {
			registrations.push({ options, component })
			return () => {}
		}
	}

	const providers = new Map()
	const notices = []
	const contextMenus = {
		register(input) {
			const key = `${input.target}/${input.id}`
			providers.set(key, input)
			return () => providers.delete(key)
		},
		notify(text, success) {
			notices.push({ text, success })
		}
	}

	const sessions = {
		list: {
			getSnapshot: () => ({ byId: { s1: { cwd: '/w' }, s2: { cwd: '/other' } } })
		}
	}
	const remote = {
		$host: { home: '/Users/curleaf' },
		workspaceFiles: {
			stat: async (_sessionId, path) => ({ ok: true, value: { absolutePath: path } })
		},
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
		effect(factory) {
			const dispose = factory()
			return dispose
		}
	}

	const module = registration.factory((spec) => {
		if (spec === 'react') return reactStub
		if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: () => null }
		throw new Error(`unexpected require: ${spec}`)
	})
	globalThis.window = loaderWindow
	try {
		module.apply(ctx)
	} finally {
		globalThis.window = previousWindow
	}

	return { module, registrations, injections, providers, notices }
}

test('apply registers file and directory contributions instead of the DOM menu', async () => {
	const { module, registrations, injections, providers } = await boot()
	assert.equal(globalThis.__DSH_FILE_MENU__.mode, 'context-menu')
	assert.equal(module.inject.includes('slots'), true)
	assert.equal(injections.includes('conversation.input.dock'), true)
	assert.equal(injections.includes('sidebar.right.tab.files.actions'), false)
	assert.equal(registrations.some((entry) => entry.options.name === 'conversation.input.dock'), true)
	for (const kind of ['file', 'directory']) {
		for (const id of ['file-tree-menu.chat', 'file-tree-menu.paths', 'file-tree-menu.edit']) {
			assert.ok(providers.has(`${kind}/${id}`), `${kind}/${id} registered`)
		}
	}
})

test('a file row inserts a workspace-relative @ reference into the composer', async () => {
	const { module, providers, notices } = await boot()
	const insertions = []
	module.__internals.composerFaces.set('s1', {
		captureInsertion: () => ({ draftRev: 1 }),
		insertText: (text) => {
			insertions.push(text)
			return true
		}
	})

	const provider = providers.get('file/file-tree-menu.chat')
	const [action] = provider.resolve({ sessionId: 's1', path: '/w/docs/plan.md' }, new AbortController().signal)
	assert.equal(action.label, '添加到会话')
	await action.run()
	assert.deepEqual(insertions, ['@docs/plan.md '])
	assert.deepEqual(notices, [{ text: '已添加到会话', success: true }])
	module.__internals.composerFaces.clear()
})

test('a directory row keeps the trailing slash and quotes spaced paths', async () => {
	const { module, providers } = await boot()
	const insertions = []
	module.__internals.composerFaces.set('s1', {
		captureInsertion: () => ({ draftRev: 1 }),
		insertText: (text) => {
			insertions.push(text)
			return true
		}
	})

	const provider = providers.get('directory/file-tree-menu.chat')
	const directory = provider.resolve({ sessionId: 's1', path: '/w/my notes' }, new AbortController().signal)[0]
	await directory.run()
	assert.deepEqual(insertions, ['@"my notes/ '])
	module.__internals.composerFaces.clear()
})

test('the workspace root and paths outside it get no conversation action', async () => {
	const { providers } = await boot()
	const provider = providers.get('directory/file-tree-menu.chat')
	assert.deepEqual(provider.resolve({ sessionId: 's1', path: '/w' }, new AbortController().signal), [])
	assert.deepEqual(provider.resolve({ sessionId: 's1', path: '/elsewhere/a.txt' }, new AbortController().signal), [])
})

test('path actions resolve absolute and relative forms', async () => {
	const { providers } = await boot()
	const copy = providers.get('file/file-tree-menu.paths')
	const actions = await copy.resolve({ sessionId: 's1', path: '/w/a.txt' }, new AbortController().signal)
	assert.deepEqual(
		actions.map((action) => action.id),
		['copyName', 'copyRelative', 'copyAbsolute']
	)
	assert.equal(actions[0].label, '复制名称')
	assert.equal(actions[1].label, '复制相对路径')
	assert.equal(actions[2].label, '复制绝对路径')
})

test('edit actions are hidden for the workspace root', async () => {
	const { providers } = await boot()
	const edit = providers.get('directory/file-tree-menu.edit')
	assert.deepEqual(await edit.resolve({ sessionId: 's1', path: '/w' }, new AbortController().signal), [])
})

test('a directory row can be renamed or deleted without a file-only stat', async () => {
	const { providers } = await boot()
	const edit = providers.get('directory/file-tree-menu.edit')
	const actions = await edit.resolve({ sessionId: 's1', path: '/w/docs' }, new AbortController().signal)
	assert.deepEqual(
		actions.map((action) => action.id),
		['rename', 'delete']
	)
	assert.deepEqual(
		actions.map((action) => action.label),
		['重命名…', '删除…']
	)
	assert.equal(actions[1].danger, true)
})
