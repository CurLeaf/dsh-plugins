/**
 * Browser-half tests.
 *
 * The bundle is a classic script (it registers itself through
 * `window.__ModuleLoader__`), so the test evaluates it against a stub loader
 * and inspects the factory's exports. Only the pure decisions are asserted —
 * path math and the `@` mention grammar — plus the registration contract the
 * Host's client loader relies on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Minimal React/primitives stand-ins: the factory only touches them when rendering. */
const reactStub = {
	createElement: () => null,
	Fragment: Symbol('react.fragment'),
	useCallback: (fn) => fn,
	useEffect: () => {},
	useRef: () => ({ current: null }),
	useState: (value) => [value, () => {}]
}

const primitivesStub = { Menu: () => null }

/** Evaluate the bundle and return the module it registered. */
async function loadBundle() {
	let registration
	const previous = globalThis.window
	globalThis.window = {
		__ModuleLoader__: {
			load: (value) => {
				registration = value
			}
		}
	}
	try {
		await import(`../lib/client.js?t=${Date.now()}-${Math.random()}`)
	} finally {
		globalThis.window = previous
	}
	assert.ok(registration, 'the bundle registers itself')
	assert.equal(registration.id, 'dsh-file-menu')
	const module = registration.factory((spec) => {
		if (spec === 'react') return reactStub
		if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
		throw new Error(`unexpected require: ${spec}`)
	})
	assert.ok(module && typeof module.apply === 'function', 'the factory exports apply()')
	return module
}

test('the bundle registers one client plugin named file-menu', async () => {
	const module = await loadBundle()
	assert.equal(module.name, 'file-menu')
	assert.deepEqual(module.inject, ['slots'])
})

test('the @ mention grammar matches the reference plugin', async () => {
	const { formatMention } = (await loadBundle()).__internals
	assert.equal(formatMention('AGENTS.md', false), '@AGENTS.md')
	assert.equal(formatMention('docs/plan.md', false), '@docs/plan.md')
	assert.equal(formatMention('docs/plan.md', true), '@docs/plan.md/')
	assert.equal(formatMention('my notes.md', false), '@"my notes.md"')
	assert.equal(formatMention('my notes', true), '@"my notes/')
	assert.equal(formatMention('has"quote.md', false), undefined)
	assert.equal(formatMention('line\nbreak.md', false), undefined)
})

test('relative paths are computed against the workspace root', async () => {
	const { relativeTo } = (await loadBundle()).__internals
	assert.equal(relativeTo('/Users/me/w', '/Users/me/w/AGENTS.md'), 'AGENTS.md')
	assert.equal(relativeTo('/Users/me/w/', '/Users/me/w/a/b/c.md'), 'a/b/c.md')
	assert.equal(relativeTo('/Users/me/w', '/Users/me/w'), '')
	assert.equal(relativeTo('/Users/me/w', '/Users/me/other/x.md'), undefined)
	assert.equal(relativeTo('/Users/me/w', '/Users/me/ww/x.md'), undefined)
	assert.equal(relativeTo('C:\\work', 'C:\\work\\a\\b.txt'), 'a/b.txt')
})

test('entry names survive both separator spellings', async () => {
	const { nameOf } = (await loadBundle()).__internals
	assert.equal(nameOf('/Users/me/w/AGENTS.md'), 'AGENTS.md')
	assert.equal(nameOf('C:\\work\\dsh\\compose.yaml'), 'compose.yaml')
	assert.equal(nameOf('/Users/me/w/folder/'), 'folder')
	assert.equal(nameOf('/'), '')
})

test('apply() registers the bridge into the files-tab header slot', async () => {
	const module = await loadBundle()
	const registrations = []
	let injectedSlot
	const slots = {
		inject(slot, factory) {
			injectedSlot = slot
			const dispose = factory()
			return () => dispose()
		},
		register(options, component) {
			registrations.push({ options, component })
			return () => {}
		}
	}
	const effects = []
	const ctx = {
		get: (name) => (name === 'slots' ? slots : undefined),
		effect: (factory) => {
			effects.push(factory())
		}
	}
	const previousDocument = globalThis.document
	globalThis.document = undefined
	try {
		module.apply(ctx)
	} finally {
		globalThis.document = previousDocument
	}
	assert.equal(injectedSlot, 'sidebar.right.tab.files.actions')
	assert.equal(registrations.length, 1)
	assert.equal(registrations[0].options.name, 'sidebar.right.tab.files.actions')
	assert.equal(registrations[0].options.id, 'file-menu')
	assert.equal(typeof registrations[0].component, 'function')
	assert.equal(effects.length, 1, 'the slot injection is owned by an effect')
})

test('apply() is inert without a slots service', async () => {
	const module = await loadBundle()
	const ctx = {
		get: () => undefined,
		effect: () => {
			throw new Error('must not register effects without slots')
		}
	}
	assert.doesNotThrow(() => module.apply(ctx))
})
