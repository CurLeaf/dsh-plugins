/**
 * Contract tests for the browser half of `dsh-git-panel`.
 *
 * The client file is a loader script: it calls `window.__ModuleLoader__.load`
 * at module scope and hands everything else to the factory. These tests drive
 * that same entry point with a stub loader and a stub React, then assert the
 * two things a client plugin can get wrong without any UI running:
 *
 *   - the tab-type registrations (ids, kinds, priority band, guide entries)
 *   - the pure helpers the bodies depend on (patch rows, graph lanes, file
 *     addresses, placeholders)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')
/**
 * The bundle's registered identity must equal the package name: the web loader
 * fetches a plugin's script by that name and refuses a script that registers
 * anything else ("loaded without registering ..."), which stalls the whole boot.
 * Reading it here keeps a rename from drifting out of the client again.
 */
const MANIFEST = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

/** Minimal React stand-in: the module only builds elements, never renders them. */
function stubReact() {
	const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
	return {
		createElement,
		Fragment: Symbol('Fragment'),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useMemo: (factory) => factory(),
		useCallback: (fn) => fn,
		useRef: (initial) => ({ current: initial }),
	}
}

/**
 * Load the client bundle through a stub module loader.
 * @returns {{plugin: object, registered: object[]}} the plugin export and the
 *   tab-type definitions it registered.
 */
function loadClient() {
	const registered = []
	let plugin
	const context = {
		window: {
			__ModuleLoader__: {
				load: (entry) => {
					assert.equal(entry.id, MANIFEST.name, 'the client module id must equal the package name')
					plugin = entry.factory((name) => {
						if (name === 'react') return stubReact()
						throw new Error(`unexpected require: ${name}`)
					})
				},
			},
			addEventListener: () => {},
			removeEventListener: () => {},
		},
		document: {
			baseURI: 'http://127.0.0.1:8710/',
			visibilityState: 'visible',
			querySelector: () => null,
			createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
			head: { appendChild: () => {} },
			addEventListener: () => {},
			removeEventListener: () => {},
		},
		navigator: { platform: 'Linux', userAgent: 'node' },
		console,
		setTimeout,
		clearTimeout,
		setInterval: () => 0,
		clearInterval: () => {},
		URL,
		fetch: async () => {
			throw new Error('no host in this test')
		},
	}

	const source = readFileSync(CLIENT_PATH, 'utf8')
	vm.runInNewContext(source, context, { filename: CLIENT_PATH })

	assert.ok(plugin !== undefined, 'the client bundle did not hand back a plugin')

	// Drive `apply` with the smallest context that satisfies the injections.
	const effects = []
	const ctx = {
		locale: {
			bind: () => (key, values) => (values === undefined ? key : key),
			register: () => {},
		},
		effect: (factory) => {
			effects.push(factory())
		},
		sidebarRightTabs: {
			register: (definition) => {
				registered.push(definition)
				return () => {}
			},
		},
		slots: {
			inject: (_name, factory) => {
				factory()
			},
			register: (options) => options,
		},
	}
	plugin.apply(ctx)
	return { plugin, registered, effects }
}

test('the client half injects the services it uses', () => {
	const { plugin } = loadClient()
	assert.equal(plugin.name, 'git-panel')
	for (const service of ['slots', 'locale', 'sidebarRightTabs']) {
		assert.ok(plugin.inject.includes(service), `missing inject: ${service}`)
	}
})

test('it registers a panel type and a diff page type', () => {
	const { registered } = loadClient()
	const kinds = registered.map((definition) => definition.kind).sort()
	assert.deepEqual(JSON.parse(JSON.stringify(kinds)), ['git', 'git-diff'])

	const panel = registered.find((definition) => definition.kind === 'git')
	assert.equal(panel.id, 'dsh-git-panel')
	assert.equal(panel.priority, 'extension')
	assert.equal(typeof panel.title, 'function')
	assert.ok(Array.isArray(panel.guide) && panel.guide.length === 1)
	assert.equal(panel.guide[0].id, 'panel')
	assert.equal(typeof panel.guide[0].title, 'function')
	assert.equal(typeof panel.guide[0].icon, 'function', 'the guide glyph is a component')

	const diff = registered.find((definition) => definition.kind === 'git-diff')
	assert.equal(diff.multiple, true, 'each diff needs its own tab')
	assert.equal(diff.handle, undefined)
})

test('apply is idempotent per effect and returns no throwing registration', () => {
	const { effects } = loadClient()
	assert.ok(effects.length >= 4)
	for (const value of effects) assert.ok(value === undefined || typeof value === 'function')
})

test('parsePatch tracks both line numbers and counts', () => {
	const { plugin } = loadClient()
	const patch = [
		'diff --git a/a.txt b/a.txt',
		'index 5626abf..814f4a4 100644',
		'--- a/a.txt',
		'+++ b/a.txt',
		'@@ -1 +1,2 @@',
		' one',
		'+two',
		'-three',
		'',
	].join('\n')
	const parsed = plugin.__test.parsePatch(patch)
	assert.equal(parsed.additions, 1)
	assert.equal(parsed.deletions, 1)
	const context = parsed.rows.find((row) => row.kind === 'context' && row.text === 'one')
	assert.equal(context.oldNo, 1)
	assert.equal(context.newNo, 1)
	const added = parsed.rows.find((row) => row.kind === 'add')
	assert.equal(added.newNo, 2)
	const removed = parsed.rows.find((row) => row.kind === 'del')
	assert.equal(removed.oldNo, 2)
	assert.equal(parsed.truncated, false)
})

test('parsePatch caps a very long patch instead of growing without bound', () => {
	const { plugin } = loadClient()
	const patch = ['@@ -1 +1 @@', ...Array.from({ length: 40 }, (_, index) => `+line ${index}`)].join('\n')
	const parsed = plugin.__test.parsePatch(patch, 10)
	assert.equal(parsed.rows.length, 10)
	assert.equal(parsed.truncated, true)
})

test('layoutGraph keeps a merge in two lanes and a straight history in one', () => {
	const { plugin } = loadClient()
	const linear = [
		{ hash: 'c3', parents: ['c2'] },
		{ hash: 'c2', parents: ['c1'] },
		{ hash: 'c1', parents: [] },
	]
	const flat = plugin.__test.layoutGraph(linear)
	assert.equal(flat.laneCount, 1)
	assert.deepEqual(JSON.parse(JSON.stringify(flat.rows.map((row) => row.lane))), [0, 0, 0])

	const merge = [
		{ hash: 'm', parents: ['a', 'b'] },
		{ hash: 'a', parents: ['root'] },
		{ hash: 'b', parents: ['root'] },
		{ hash: 'root', parents: [] },
	]
	const drawn = plugin.__test.layoutGraph(merge)
	assert.equal(drawn.laneCount, 2)
	assert.equal(drawn.rows[0].lane, 0)
	assert.equal(drawn.rows[1].lane, 0, 'the first parent takes the merge lane')
	assert.equal(drawn.rows[2].lane, 1, 'the second parent gets its own lane')
	assert.equal(drawn.rows[0].edges.length, 2)
})

test('graphShapes draws straight lanes, curved merges and a ring node', () => {
	const { plugin } = loadClient()
	const { layoutGraph, graphShapes } = plugin.__test

	const flat = layoutGraph([
		{ hash: 'b', parents: ['a'] },
		{ hash: 'a', parents: [] },
	])
	const row = graphShapes(flat.rows[0], flat.laneCount)
	assert.equal(row.width, 16, 'one lane keeps the padding on both sides')
	assert.equal(row.height, 38)
	assert.equal(row.edges.length, 1)
	assert.match(row.edges[0].d, /^M8 19L8 38$/, 'a lane that holds is a straight line')
	assert.equal(row.node.cx, 8)
	assert.equal(row.node.merge, false)
	assert.equal(row.node.radius, 4.8, 'a plain commit draws a small node')

	const merged = layoutGraph([
		{ hash: 'm', parents: ['a', 'b'] },
		{ hash: 'a', parents: ['root'] },
		{ hash: 'b', parents: ['root'] },
		{ hash: 'root', parents: [] },
	])
	const mergeRow = graphShapes(merged.rows[0], merged.laneCount)
	assert.equal(mergeRow.edges.length, 2)
	const curved = mergeRow.edges.filter((edge) => edge.d.includes('C'))
	assert.equal(curved.length, 1, 'the second parent bends into its own lane')
	assert.match(curved[0].d, /^M8 19C8 [\d.]+ 24 [\d.]+ 24 38$/)
	assert.equal(mergeRow.width, 32, 'two lanes widen the canvas by one lane width (16px)')
	assert.equal(mergeRow.node.merge, true)
	assert.ok(mergeRow.node.radius > row.node.radius, 'a merge draws a larger node')
})

test('fileAddress builds a session file address that survives spaces and drive letters', () => {
	const { plugin } = loadClient()
	// An absolute path rides the session scope with its leading separator kept:
	// the file provider resolves it as absolute rather than workspace-relative.
	const address = plugin.__test.fileAddress('s1', '/home/me/repo/', 'src/a b.js')
	assert.equal(address, 'dsh-resource://file/session/s1//home/me/repo/src/a%20b.js')
	const windows = plugin.__test.fileAddress('s1', 'C:\\repo', 'a.js')
	assert.equal(windows, 'dsh-resource://file/session/s1/C:/repo/a.js')
})

test('splitPath keeps whole relative directories', () => {
	const { plugin } = loadClient()
	assert.deepEqual(JSON.parse(JSON.stringify(plugin.__test.splitPath('a.js'))), { dir: '', name: 'a.js' })
	assert.deepEqual(JSON.parse(JSON.stringify(plugin.__test.splitPath('a/b/c.js'))), { dir: 'a/b/', name: 'c.js' })
})

test('fill replaces only known placeholders', () => {
	const { plugin } = loadClient()
	assert.equal(plugin.__test.fill('a {n} b', { n: 2 }), 'a 2 b')
	assert.equal(plugin.__test.fill('a {missing} b', {}), 'a {missing} b')
})

test('a change row carries the right diff request, including untracked files', () => {
	const { plugin } = loadClient()
	const { diffRequestFor } = plugin.__test

	// The worktree group mixes modified and untracked files: the row's code decides.
	assert.deepEqual(
		JSON.parse(JSON.stringify(diffRequestFor({ path: 'a.js', code: '.M', letter: 'M' }, 'worktree', '/repo'))),
		{ path: 'a.js', cwd: '/repo' },
	)
	assert.deepEqual(
		JSON.parse(JSON.stringify(diffRequestFor({ path: 'new.js', code: '??', letter: 'U' }, 'worktree', '/repo'))),
		{ path: 'new.js', untracked: true, cwd: '/repo' },
	)
	assert.deepEqual(
		JSON.parse(JSON.stringify(diffRequestFor({ path: 'new.js', code: 'A.', letter: 'A' }, 'staged', '/repo'))),
		{ path: 'new.js', staged: true, cwd: '/repo' },
	)
})

test('a discard request keeps untracked paths out of the tracked list', () => {
	const { plugin } = loadClient()
	const { discardRequestFor } = plugin.__test
	assert.deepEqual(JSON.parse(JSON.stringify(discardRequestFor({ path: 'a.js', code: '.M' }, 'worktree'))), { paths: ['a.js'] })
	assert.deepEqual(JSON.parse(JSON.stringify(discardRequestFor({ path: 'new.js', code: '??' }, 'worktree'))), { paths: [], untracked: ['new.js'] })
	assert.deepEqual(JSON.parse(JSON.stringify(discardRequestFor({ path: 'new.js', code: '??' }, 'untracked'))), { paths: [], untracked: ['new.js'] })
})

test('the change chip separates an untracked file from a conflict', () => {
	const { plugin } = loadClient()
	const { changeKindOf } = plugin.__test
	assert.equal(changeKindOf({ code: '??', letter: 'U' }), 'U')
	assert.equal(changeKindOf({ code: 'UU', letter: 'U' }), 'CONFLICT')
	// An 'AA' conflict would otherwise read as a plain added file.
	assert.equal(changeKindOf({ code: 'AA', letter: 'A' }, 'conflicts'), 'CONFLICT')
	assert.equal(changeKindOf({ code: '.M', letter: 'M' }), 'M')
	assert.equal(changeKindOf({ code: 'A.', letter: 'A' }), 'A')
	assert.equal(changeKindOf({ code: '.D', letter: 'D' }), 'D')
	assert.equal(changeKindOf({ code: 'R.', letter: 'R' }), 'R')
	assert.equal(changeKindOf({ code: '.T', letter: 'T' }), 'T')
	assert.equal(changeKindOf({}), 'M')
})

test('file families are specific before generic', () => {
	const { plugin } = loadClient()
	const { fileFamilyOf } = plugin.__test
	assert.equal(fileFamilyOf('src/client.js'), 'code')
	assert.equal(fileFamilyOf('src/client.tsx'), 'code')
	assert.equal(fileFamilyOf('package.json'), 'data')
	assert.equal(fileFamilyOf('pnpm-lock.yaml'), 'lock')
	assert.equal(fileFamilyOf('package-lock.json'), 'lock')
	assert.equal(fileFamilyOf('styles/app.scss'), 'style')
	assert.equal(fileFamilyOf('README.md'), 'doc')
	assert.equal(fileFamilyOf('logo.svg'), 'image')
	assert.equal(fileFamilyOf('logo.png'), 'image')
	assert.equal(fileFamilyOf('clip.mp4'), 'media')
	assert.equal(fileFamilyOf('font.woff2'), 'font')
	assert.equal(fileFamilyOf('bundle.zip'), 'archive')
	assert.equal(fileFamilyOf('run.sh'), 'shell')
	assert.equal(fileFamilyOf('Makefile'), 'plain')
})

test('the change chip renders one class per kind and a readable label', () => {
	const { plugin } = loadClient()
	const { ChangeBadge } = plugin.__test
	const t = (key) => key
	const untracked = ChangeBadge({ entry: { code: '??', letter: 'U' }, t })
	assert.equal(untracked.type, 'span')
	assert.equal(untracked.props.className, 'gp-change U')
	assert.equal(untracked.props.title, 'change.U')
	assert.equal(untracked.props['aria-label'], 'change.U')

	const renamed = ChangeBadge({ entry: { code: 'R.', letter: 'R', originalPath: 'old.js' }, t })
	assert.equal(renamed.props.className, 'gp-change R')
	assert.equal(renamed.props.title, 'change.R · old.js')

	const conflict = ChangeBadge({ entry: { code: 'UU', letter: 'U' }, t })
	assert.equal(conflict.props.className, 'gp-change CONFLICT')
	assert.equal(conflict.props.title, 'change.conflict')
})

test('the branch chip folds ahead/behind into one summary', () => {
	const { plugin } = loadClient()
	const { branchSummaryOf } = plugin.__test
	assert.deepEqual(
		JSON.parse(JSON.stringify(branchSummaryOf({ branch: 'main', ahead: 2, behind: 1 }))),
		{ label: 'main', detached: false, ahead: 2, behind: 1 },
	)
	assert.deepEqual(
		JSON.parse(JSON.stringify(branchSummaryOf({ branch: null, detached: true, oid: 'cce8bbb8bc1a' }))),
		{ label: 'cce8bbb', detached: true, ahead: 0, behind: 0 },
	)
	assert.deepEqual(
		JSON.parse(JSON.stringify(branchSummaryOf({ branch: 'feat/x', ahead: 0, behind: 0 }))),
		{ label: 'feat/x', detached: false, ahead: 0, behind: 0 },
	)
})
