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
	/** Enough of React.Component for the tab error boundary to load. */
	class Component {
		constructor(props) {
			this.props = props
			this.state = {}
		}

		setState(next) {
			this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
		}
	}
	return {
		createElement,
		Component,
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
	/** Menu contributions the plugin registers with the shared context menu. */
	const menus = []
	const ctx = {
		locale: {
			bind: () => (key, values) => (values === undefined ? key : key),
			register: () => {},
		},
		effect: (factory) => {
			effects.push(factory())
		},
		inject: () => {},
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
		get: (name) => (name === 'contextMenus' ? { register: (input) => { menus.push(input); return () => {} } } : undefined),
	}
	plugin.apply(ctx)
	return { plugin, registered, effects, menus }
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

test('the change rows register one contribution in their own target family', () => {
	const { menus, plugin } = loadClient()
	assert.equal(menus.length, 1, 'one contribution, however many panels mount')
	const [menu] = menus
	assert.equal(menu.id, 'git-panel.change')
	assert.equal(menu.target, plugin.__test.CHANGE_TARGET)
	assert.equal(menu.target, 'gitChange')
	assert.equal(menu.order, 200)
	assert.equal(typeof menu.resolve, 'function')
})

test('the inline row actions follow Cursor: open file, discard, stage', () => {
	const { plugin } = loadClient()
	const { rowActionPlan } = plugin.__test
	assert.deepEqual(plain(rowActionPlan('worktree', false)), ['file', 'discard', 'stage'])
	assert.deepEqual(plain(rowActionPlan('untracked', false)), ['file', 'discard', 'stage'])
	assert.deepEqual(plain(rowActionPlan('staged', false)), ['file', 'unstage'])
	// Staging a conflict is how it is resolved; the quote action is ours.
	assert.deepEqual(plain(rowActionPlan('conflicts', false)), ['file', 'stage', 'quote'])
	// An image row has no readable patch, so it previews instead of opening changes.
	assert.deepEqual(plain(rowActionPlan('worktree', true)), ['image', 'discard', 'stage'])
})

test('the context menu keeps Cursor groups: navigation, modification, path', () => {
	const { plugin } = loadClient()
	const { changeMenuPlan } = plugin.__test
	assert.deepEqual(plain(changeMenuPlan('worktree', false)), ['changes', 'file', 'stage', 'discard', 'copyPath'])
	assert.deepEqual(plain(changeMenuPlan('untracked', false)), ['changes', 'file', 'stage', 'discard', 'copyPath'])
	assert.deepEqual(plain(changeMenuPlan('staged', false)), ['changes', 'file', 'compare', 'unstage', 'copyPath'])
	assert.deepEqual(plain(changeMenuPlan('conflicts', false)), ['changes', 'file', 'stage', 'copyPath', 'quote'])
	assert.deepEqual(plain(changeMenuPlan('worktree', true)), ['image', 'file', 'stage', 'discard', 'copyPath'])
})

test('a section header carries the verbs of the list below it, in Cursor order', () => {
	const { plugin } = loadClient()
	const { sectionActionPlan } = plugin.__test
	// Preview is Cursor's "Open Changes" group action: it leads the group.
	assert.deepEqual(plain(sectionActionPlan('worktree')), ['previewAll', 'discardAll', 'stageAll'])
	assert.deepEqual(plain(sectionActionPlan('staged')), ['unstageAll'])
	// A conflict is resolved by staging it; there is nothing to discard.
	assert.deepEqual(plain(sectionActionPlan('conflicts')), ['stageMerge'])
	assert.deepEqual(plain(sectionActionPlan('unknown')), [])
})

test('menu actions call the panel that is on screen', () => {
	const { plugin } = loadClient()
	const { changeMenuActions, panelRuntimes } = plugin.__test
	const calls = []
	const panel = {
		t: (key) => key,
		run: (action, payload) => calls.push(['run', action, payload]),
		openDiff: (entry, group) => calls.push(['openDiff', entry.path, group]),
		openFile: (entry) => calls.push(['openFile', entry.path]),
		quoteConflict: (entry) => calls.push(['quote', entry.path]),
		confirmDiscard: (entry, group) => calls.push(['confirmDiscard', entry.path, group]),
		copyPath: (path) => calls.push(['copyPath', path]),
	}
	panelRuntimes.set('session-1', { current: panel })
	try {
		const actions = changeMenuActions({ sessionId: 'session-1', path: 'src/app.ts', code: ' M', group: 'worktree' })
		assert.deepEqual(plain(actions.map((action) => action.id)), ['changes', 'file', 'stage', 'discard', 'copyPath'])
		assert.equal(actions[0].label, 'menu.changes')
		// The modification verbs and the path copy open new groups.
		assert.deepEqual(plain(actions.map((action) => action.separatorBefore === true)), [false, false, true, false, true])
		assert.equal(actions[3].danger, true, 'discarding is the destructive one')
		actions[2].run()
		actions[3].run()
		assert.deepEqual(plain(calls), [
			['run', 'stage', { paths: ['src/app.ts'] }],
			['confirmDiscard', 'src/app.ts', 'worktree'],
		])

		// A row whose panel unmounted yields no actions, not a dead menu.
		panelRuntimes.delete('session-1')
		assert.deepEqual(plain(changeMenuActions({ sessionId: 'session-1', path: 'src/app.ts', group: 'worktree' })), [])
	} finally {
		panelRuntimes.delete('session-1')
	}
})

test('a row composes the context-menu trigger with its own Enter', () => {
	const { plugin } = loadClient()
	const { ChangeRow, CHANGE_TARGET } = plugin.__test
	const opened = []
	const targets = []
	const useContextMenu = () => ({
		getTriggerProps: (target, handlers) => {
			targets.push(target)
			return { ...handlers, tabIndex: 0, onContextMenu: () => opened.push('menu') }
		},
	})
	const row = ChangeRow({
		entry: { path: 'src/app.ts', code: ' M', additions: 1, deletions: 0 },
		group: 'worktree',
		busy: false,
		t: (key) => key,
		sessionId: 'session-1',
		useContextMenu,
		onOpenDiff: (entry, group) => opened.push(`diff:${entry.path}:${group}`),
		onOpenFile: (entry) => opened.push(`file:${entry.path}`),
		onStage: (entry) => opened.push(`stage:${entry.path}`),
		onUnstage: (entry) => opened.push(`unstage:${entry.path}`),
		onDiscard: (entry, group) => opened.push(`discard:${entry.path}:${group}`),
		onQuote: (entry) => opened.push(`quote:${entry.path}`),
	})
	assert.equal(row.props.tabIndex, 0)
	assert.equal(typeof row.props.onContextMenu, 'function')
	assert.deepEqual(JSON.parse(JSON.stringify(targets[0])), {
		kind: CHANGE_TARGET,
		value: { sessionId: 'session-1', path: 'src/app.ts', code: ' M', group: 'worktree' },
	})
	row.props.onClick()
	row.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
	row.props.onContextMenu()
	assert.deepEqual(opened, ['diff:src/app.ts:worktree', 'diff:src/app.ts:worktree', 'menu'])

	// Hover actions, in Cursor's order, live in the row's last cell.
	const actions = row.children[4]
	assert.equal(actions.props.className, 'gp-row-actions')
	assert.deepEqual(
		elementsOf(actions)
			.filter((button) => button.props?.label !== undefined)
			.map((button) => button.props.label),
		['row.openFile', 'row.discard', 'row.stage'],
	)
})

test('a build without the shared menu still gives the row a keyboard stop', () => {
	const { plugin } = loadClient()
	const { ChangeRow } = plugin.__test
	const opened = []
	const row = ChangeRow({
		entry: { path: 'src/app.ts', code: ' M', additions: 0, deletions: 0 },
		group: 'staged',
		busy: false,
		t: (key) => key,
		sessionId: 'session-1',
		useContextMenu: undefined,
		onOpenDiff: (entry, group) => opened.push(`diff:${entry.path}:${group}`),
		onOpenFile: () => {},
		onStage: () => {},
		onUnstage: () => {},
		onDiscard: () => {},
		onQuote: () => {},
	})
	assert.equal(row.props.tabIndex, 0)
	assert.equal(row.props.onContextMenu, undefined)
	row.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
	assert.deepEqual(opened, ['diff:src/app.ts:staged'])
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

test('parsePatch groups rows by file and reads the file status', () => {
	const { plugin } = loadClient()
	const patch = [
		'diff --git a/src/app.js b/src/app.js',
		'index 1111111..2222222 100644',
		'--- a/src/app.js',
		'+++ b/src/app.js',
		'@@ -1,2 +1,2 @@ function boot()',
		'-const a = 1',
		'+const a = 2',
		' same',
		'diff --git a/docs/new.md b/docs/new.md',
		'new file mode 100644',
		'index 0000000..3333333',
		'--- /dev/null',
		'+++ b/docs/new.md',
		'@@ -0,0 +1,2 @@',
		'+# New',
		'+body',
	].join('\n')
	const parsed = plugin.__test.parsePatch(patch)
	assert.equal(parsed.files.length, 2)
	assert.equal(parsed.files.map((file) => file.path).join('|'), 'src/app.js|docs/new.md')
	assert.equal(parsed.files[0].status, 'modified')
	assert.equal(parsed.files[0].additions, 1)
	assert.equal(parsed.files[1].status, 'added')
	assert.equal(parsed.files[1].additions, 2)
	assert.equal(parsed.rows.filter((row) => row.kind === 'add').find((row) => row.text === '# New').file, 1)
	assert.equal(parsed.rows.find((row) => row.kind === 'hunk' && row.section === 'function boot()') !== undefined, true)
	// Header lines collapse into `files`; they must not become noise rows.
	assert.equal(parsed.rows.some((row) => row.text.startsWith('diff --git') || row.text.startsWith('index ')), false)
})

test('parsePatch decodes quoted paths and marks deletions', () => {
	const { plugin } = loadClient()
	const patch = [
		'diff --git "a/my file.txt" "b/my file.txt"',
		'deleted file mode 100644',
		'--- "a/my file.txt"',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-gone',
	].join('\n')
	const parsed = plugin.__test.parsePatch(patch)
	assert.equal(parsed.files.length, 1)
	assert.equal(parsed.files[0].path, 'my file.txt')
	assert.equal(parsed.files[0].status, 'deleted')
	assert.equal(parsed.files[0].deletions, 1)
})

test('an untracked synthetic patch becomes one added file', () => {
	const { plugin } = loadClient()
	const patch = ['--- /dev/null', '+++ b/notes/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two'].join('\n')
	const parsed = plugin.__test.parsePatch(patch)
	assert.equal(parsed.files.length, 1)
	assert.equal(parsed.files[0].path, 'notes/new.txt')
	assert.equal(parsed.files[0].status, 'added')
	assert.equal(parsed.files[0].additions, 2)
})

test('wordDiff keeps the unchanged prefix and suffix out of the wash', () => {
	const { plugin } = loadClient()
	const changed = plugin.__test.wordDiff('const value = 1', 'const value = 2')
	assert.equal(changed.old.join(','), '14,15')
	assert.equal(changed.new.join(','), '14,15')
	assert.equal(plugin.__test.wordDiff('same line', 'same line'), null)
	// Trailing whitespace is not the change worth marking.
	const trailing = plugin.__test.wordDiff('let a = 1 ', 'let a = 2 ')
	assert.equal(trailing.old.join(','), '8,9')
	assert.equal(trailing.new.join(','), '8,9')
})

test('languageOf maps extensions to the colouring families', () => {
	const { plugin } = loadClient()
	const languageOf = plugin.__test.languageOf
	assert.equal(languageOf('src/client.ts'), 'js')
	assert.equal(languageOf('package.json'), 'json')
	assert.equal(languageOf('styles/site.scss'), 'css')
	assert.equal(languageOf('public/index.html'), 'html')
	assert.equal(languageOf('README.md'), 'md')
	assert.equal(languageOf('scripts/run.sh'), 'sh')
	assert.equal(languageOf('conf/app.yaml'), 'yaml')
	assert.equal(languageOf('assets/logo.bin'), 'plain')
})

test('tokenizeLine keeps the text intact and colours keywords, strings and comments', () => {
	const { plugin } = loadClient()
	const line = 'const answer = "42" // the answer'
	const result = plugin.__test.tokenizeLine(line, 'js')
	assert.equal(result.tokens.map((token) => token.text).join(''), line)
	assert.equal(result.tokens.find((token) => token.text === 'const').cls, 'keyword')
	assert.equal(result.tokens.find((token) => token.text === '"42"').cls, 'string')
	assert.equal(result.tokens.find((token) => token.text === '// the answer').cls, 'comment')
})

test('tokenizeLine colours JSON keys differently from values', () => {
	const { plugin } = loadClient()
	const result = plugin.__test.tokenizeLine('  "name": "value",', 'json')
	assert.equal(result.tokens.find((token) => token.text === '"name"').cls, 'key')
	assert.equal(result.tokens.find((token) => token.text === '"value"').cls, 'string')
})

test('splitCommitPatch lifts the commit message off a git show patch', () => {
	const { plugin } = loadClient()
	const raw = [
		'0123456789abcdef0123456789abcdef01234567',
		'Ann Example <ann@example.com>',
		'2026-01-02 10:00:00 +0800',
		'Fix the thing',
		'',
		'Second paragraph.',
		'',
		'diff --git a/x.txt b/x.txt',
		'index 1111111..2222222 100644',
		'--- a/x.txt',
		'+++ b/x.txt',
		'@@ -1 +1 @@',
		'-old',
		'+new',
	].join('\n')
	const split = plugin.__test.splitCommitPatch(raw)
	assert.equal(split.commit.hash, '0123456789abcdef0123456789abcdef01234567')
	assert.equal(split.commit.author, 'Ann Example')
	assert.equal(split.commit.subject, 'Fix the thing')
	assert.equal(split.commit.body, 'Second paragraph.')
	assert.equal(split.patch.startsWith('diff --git a/x.txt'), true)
	assert.equal(plugin.__test.splitCommitPatch('diff --git a/x b/x\n').commit, null)
})

test('diffStatBlocks turns additions and deletions into five overview blocks', () => {
	const { plugin } = loadClient()
	assert.equal(plugin.__test.diffStatBlocks(12, 0).join(','), 'add,add,add,add,add')
	assert.equal(plugin.__test.diffStatBlocks(0, 12).join(','), 'del,del,del,del,del')
	const mixed = plugin.__test.diffStatBlocks(8, 2)
	assert.equal(mixed.length, 5)
	assert.equal(mixed.includes('add'), true)
	assert.equal(mixed.includes('del'), true)
	assert.equal(plugin.__test.diffStatBlocks(0, 0).length, 0)
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
	assert.equal(row.height, 36)
	assert.equal(row.edges.length, 1)
	assert.match(row.edges[0].d, /^M8 18L8 36$/, 'a lane that holds is a straight line')
	assert.equal(row.node.cx, 8)
	assert.equal(row.node.merge, false)
	assert.equal(row.node.radius, 4, 'a plain commit draws a small node')

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
	assert.match(curved[0].d, /^M8 18C8 [\d.]+ 20 [\d.]+ 20 36$/)
	assert.equal(mergeRow.width, 28, 'two lanes widen the canvas by one lane width (12px)')
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

test('file icons resolve by name, longest suffix, then the generic page', () => {
	const { plugin } = loadClient()
	const { fileIconFor, FILE_ICON_SVGS, FILE_ICON_BY_EXTENSION, FILE_ICON_BY_NAME } = plugin.__test
	assert.equal(fileIconFor('src/client.js'), 'javascript')
	assert.equal(fileIconFor('src/client.tsx'), 'react_ts')
	assert.equal(fileIconFor('package.json'), 'nodejs')
	assert.equal(fileIconFor('pnpm-lock.yaml'), 'pnpm')
	assert.equal(fileIconFor('styles/app.scss'), 'sass')
	assert.equal(fileIconFor('README.md'), 'readme')
	assert.equal(fileIconFor('logo.svg'), 'svg')
	assert.equal(fileIconFor('logo.png'), 'image')
	assert.equal(fileIconFor('clip.mp4'), 'video')
	assert.equal(fileIconFor('font.woff2'), 'font')
	assert.equal(fileIconFor('bundle.zip'), 'zip')
	assert.equal(fileIconFor('run.sh'), 'console')
	assert.equal(fileIconFor('Makefile'), 'makefile')
	assert.equal(fileIconFor('Dockerfile'), 'docker')
	assert.equal(fileIconFor('.gitignore'), 'git')
	// A deployment path can arrive with backslashes; the basename still decides.
	assert.equal(fileIconFor('src\\app\\main.ts'), 'typescript')
	// No exact name, no suffix: the generic page.
	assert.equal(fileIconFor('unknown.zzz'), 'file')

	// Every table entry must point at an icon the generated block actually carries.
	for (const [key, icon] of Object.entries({ ...FILE_ICON_BY_EXTENSION, ...FILE_ICON_BY_NAME })) {
		assert.ok(FILE_ICON_SVGS[icon], `${key} -> ${icon} is missing from FILE_ICON_SVGS`)
	}
	assert.ok(FILE_ICON_SVGS.file, 'the generic fallback exists')
})

/**
 * Walk a stubbed React tree and collect every element node.
 * @param {unknown} node - element, array or text.
 * @param {object[]} [out] - accumulator.
 * @returns {object[]} every element with `type` and `props`.
 */
/**
 * Strip the vm realm's prototypes so `deepStrictEqual` compares plain data:
 * the bundle runs inside `vm.runInNewContext`, whose arrays are not this
 * realm's arrays.
 * @param {unknown} value - anything JSON-shaped.
 * @returns {unknown} the same data in this realm.
 */
function plain(value) {
	return JSON.parse(JSON.stringify(value))
}

function elementsOf(node, out = []) {
	if (node === null || node === undefined) return out
	if (Array.isArray(node)) {
		for (const item of node) elementsOf(item, out)
		return out
	}
	if (typeof node === 'object' && node.type !== undefined) {
		out.push(node)
		elementsOf(node.children, out)
	}
	return out
}

test('an image change previews in place instead of a binary diff', () => {
	const { plugin } = loadClient()
	const { previewsAsImage } = plugin.__test

	assert.equal(previewsAsImage({ path: 'shot.png', code: '.M', letter: 'M' }, 'worktree'), true)
	assert.equal(previewsAsImage({ path: 'logo.SVG', code: 'A.', letter: 'A' }, 'staged'), true)
	assert.equal(previewsAsImage({ path: 'new.webp', code: '??', letter: 'U' }, 'worktree'), true)
	// A deleted image has no work-tree bytes left to draw.
	assert.equal(previewsAsImage({ path: 'shot.png', code: '.D', letter: 'D' }, 'worktree'), false)
	// Conflicts keep the diff: the work-tree file is not a valid image any more.
	assert.equal(previewsAsImage({ path: 'shot.png', code: 'UU', letter: 'U' }, 'conflicts'), false)
	// Image-looking formats the previewer cannot render keep the diff too.
	assert.equal(previewsAsImage({ path: 'art.psd', code: '.M', letter: 'M' }, 'worktree'), false)
	// Everything textual keeps the diff.
	assert.equal(previewsAsImage({ path: 'src/client.js', code: '.M', letter: 'M' }, 'worktree'), false)
})

test('clicking an image row opens the preview, a text row opens the diff', () => {
	const { plugin } = loadClient()
	const { ChangeRow } = plugin.__test
	const t = (key) => key
	const base = {
		busy: false,
		t,
		onStage: () => {},
		onUnstage: () => {},
		onDiscard: () => {},
		onQuote: () => {},
	}

	const calls = []
	const imageRow = ChangeRow({
		...base,
		entry: { path: 'shot.png', code: '.M', letter: 'M' },
		group: 'worktree',
		onOpenDiff: () => calls.push('diff'),
		onOpenFile: () => calls.push('file'),
	})
	imageRow.props.onClick()
	assert.deepEqual(calls, ['file'])
	const imageLabels = elementsOf(imageRow).map((node) => node.props?.label).filter(Boolean)
	assert.ok(imageLabels.includes('row.openImage'), 'the only preview action is the image one')
	assert.equal(imageLabels.includes('row.openDiff'), false)

	calls.length = 0
	const textRow = ChangeRow({
		...base,
		entry: { path: 'src/client.js', code: '.M', letter: 'M' },
		group: 'worktree',
		onOpenDiff: () => calls.push('diff'),
		onOpenFile: () => calls.push('file'),
	})
	textRow.props.onClick()
	assert.deepEqual(calls, ['diff'])
	const textLabels = elementsOf(textRow).map((node) => node.props?.label).filter(Boolean)
	// Cursor's row: the click is the diff, so the inline actions are open file,
	// discard and stage — no separate diff button.
	assert.deepEqual(textLabels, ['row.openFile', 'row.discard', 'row.stage'])
})

test('the loading skeleton gives React style objects, not strings', () => {
	const { plugin } = loadClient()
	// React throws "The `style` prop expects a mapping ..." on a string style,
	// which unmounts the whole app while the first diff frame renders.
	const styled = elementsOf(plugin.__test.DiffSkeleton()).filter((node) => node.props?.style !== undefined)
	assert.ok(styled.length > 0, 'the skeleton still sizes its shimmering rows')
	for (const node of styled) assert.equal(typeof node.props.style, 'object', 'every style prop is an object')
})

test('the change badge renders the Source Control letter and a readable label', () => {
	const { plugin } = loadClient()
	const { ChangeBadge } = plugin.__test
	const t = (key) => key
	const untracked = ChangeBadge({ entry: { code: '??', letter: 'U' }, t })
	assert.equal(untracked.type, 'span')
	assert.equal(untracked.props.className, 'gp-change U')
	assert.equal(untracked.props.title, 'change.U')
	assert.equal(untracked.props['aria-label'], 'change.U')
	assert.deepEqual(untracked.children, ['U'])

	const renamed = ChangeBadge({ entry: { code: 'R.', letter: 'R', originalPath: 'old.js' }, t })
	assert.equal(renamed.props.className, 'gp-change R')
	assert.equal(renamed.props.title, 'change.R · old.js')
	assert.deepEqual(renamed.children, ['R'])

	const conflict = ChangeBadge({ entry: { code: 'UU', letter: 'U' }, t })
	assert.equal(conflict.props.className, 'gp-change CONFLICT')
	assert.equal(conflict.props.title, 'change.conflict')
	// Source Control marks conflicts with the exclamation, not a second glyph.
	assert.deepEqual(conflict.children, ['!'])
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
