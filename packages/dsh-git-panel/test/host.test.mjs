/**
 * Behaviour tests for the host half of `dsh-git-panel`.
 *
 * Everything the panel claims lives behind `perform(action, signal)`, so the
 * suite drives that seam against real temporary repositories and asserts the
 * payloads the browser renders. The parsers are also exercised on the exact
 * separator shapes git produces, because the NUL framing of `status -z` and
 * `numstat -z` is where a Git panel usually breaks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { __internals, apply, perform } from '../lib/index.js'

const { containedPath, parseDecorations, parseGraph, parseNumstat, parseRefList, parseStatus } = __internals

const SIGNAL = new AbortController().signal
/** The checkout these tests run from; the Host resolves the same root. */
const REPO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))

/**
 * Create one throwaway repository with an initial commit.
 * @returns {Promise<string>} its absolute path.
 */
async function repository() {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-git-panel-'))
	const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
	git('init', '-q', '-b', 'main')
	git('config', 'user.email', 'tester@example.com')
	git('config', 'user.name', 'Tester')
	git('config', 'commit.gpgsign', 'false')
	await writeFile(join(dir, 'tracked.txt'), 'one\n')
	git('add', '.')
	git('commit', '-qm', 'feat: initial')
	return dir
}

test('parseStatus reads the branch header and the four entry lists', () => {
	const raw = [
		'# branch.oid 1111111111111111111111111111111111111111',
		'# branch.head main',
		'# branch.upstream origin/main',
		'# branch.ab +3 -2',
		'1 .M N... 100644 100644 100644 aaa bbb src/a.js',
		'1 A. N... 000000 100644 100644 aaa bbb new file.txt',
		'2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt',
		'old-name.txt',
		'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt',
		'? untracked.txt',
		'! ignored.txt',
		'',
	].join('\0')

	const parsed = parseStatus(raw)
	assert.equal(parsed.branch.head, 'main')
	assert.equal(parsed.branch.upstream, 'origin/main')
	assert.equal(parsed.branch.ahead, 3)
	assert.equal(parsed.branch.behind, 2)
	assert.deepEqual(parsed.changes.map((entry) => entry.path), ['src/a.js'])
	assert.deepEqual(parsed.staged.map((entry) => entry.path), ['new file.txt', 'renamed.txt'])
	assert.equal(parsed.staged[1].originalPath, 'old-name.txt')
	assert.equal(parsed.staged[1].letter, 'R')
	assert.deepEqual(parsed.conflicts.map((entry) => entry.path), ['conflicted.txt'])
	assert.deepEqual(parsed.untracked.map((entry) => entry.path), ['untracked.txt'])
})

test('parseStatus keeps spaces in names and reports a detached HEAD honestly', () => {
	const raw = ['# branch.oid abc', '# branch.head (detached)', '1 .M N... 100644 100644 100644 aaa bbb a file with spaces.txt', ''].join('\0')
	const parsed = parseStatus(raw)
	assert.equal(parsed.branch.head, null)
	assert.equal(parsed.changes[0].path, 'a file with spaces.txt')
})

test('parseNumstat handles plain, binary and rename records', () => {
	const plain = parseNumstat(['3\t1\tsrc/a.js', ''].join(''))
	assert.equal(plain.get('src/a.js').additions, 3)
	assert.equal(plain.get('src/a.js').deletions, 1)

	const binary = parseNumstat(['-\t-\timage.png', ''].join(''))
	assert.equal(binary.get('image.png').binary, true)

	const renamed = parseNumstat(['2\t0\t', 'old.js', 'new.js', ''].join('\u0000'))
	assert.equal(renamed.get('new.js').additions, 2)
})

test('parseGraph reads commits, parents and decorations', () => {
	const first = ['aaaaaaa1111111111111111111111111111111111', 'bbbbbbb2222222222222222222222222222222222 ccccccc3333333333333333333333333333333333', 'Ann', 'a@b.c', '1700000000', 'HEAD -> main, tag: v1', 'feat: one', 'body line'].join('\x1f')
	const second = ['ddddddd4444444444444444444444444444444444', '', 'Bob', 'b@b.c', '1690000000', '', 'fix: two', ''].join('\x1f')
	const raw = `\x1e${first}\n\x1e${second}\n`
	const commits = parseGraph(raw)
	assert.equal(commits.length, 2)
	assert.equal(commits[0].short, 'aaaaaaa')
	assert.deepEqual(commits[0].parents, ['bbbbbbb2222222222222222222222222222222222', 'ccccccc3333333333333333333333333333333333'])
	assert.equal(commits[0].body, 'body line')
	assert.equal(commits[1].parents.length, 0)

	const refs = parseDecorations('HEAD -> main, origin/main, tag: v1.0.0, feature/x, HEAD')
	assert.deepEqual(refs, [
		{ kind: 'head', name: 'main' },
		{ kind: 'remote', name: 'origin/main' },
		{ kind: 'tag', name: 'v1.0.0' },
		{ kind: 'branch', name: 'feature/x' },
		{ kind: 'head', name: 'HEAD' },
	])
	assert.deepEqual(parseDecorations(''), [])
})

test('parseRefList keeps the detail fields of a branch listing', () => {
	const rows = parseRefList('main\x1fabc1234\x1forigin/main\x1f*\x1f2026-11-01 10:00:00 +0800\nnext\x1fdef5678\x1f\x1f \x1f2026-10-01 10:00:00 +0800', true)
	assert.equal(rows.length, 2)
	assert.equal(rows[0].current, true)
	assert.equal(rows[0].upstream, 'origin/main')
	assert.equal(rows[1].current, false)
})

test('containedPath refuses anything outside the work tree', () => {
	const root = '/tmp/example-root'
	assert.equal(containedPath(root, 'src/a.js'), 'src/a.js')
	assert.equal(containedPath(root, 'src/a.js'), 'src/a.js')
	assert.throws(() => containedPath(root, '../escape.js'), /escapes the repository/)
	assert.throws(() => containedPath(root, '/etc/passwd'), /absolute paths are refused/)
	assert.throws(() => containedPath(root, ''), /non-empty string/)
})

test('status of a real repository lists the three groups with counts', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')
		await writeFile(join(dir, 'fresh.txt'), 'new\n')
		await mkdir(join(dir, 'nested'))
		await writeFile(join(dir, 'nested', 'inner.txt'), 'x\n')

		const status = await perform({ action: 'status', cwd: dir }, SIGNAL)
		assert.equal(status.repo, true)
		assert.equal(status.branch, 'main')
		assert.equal(status.detached, false)
		assert.equal(status.counts.changes, 1)
		assert.equal(status.counts.untracked, 2)
		assert.equal(status.counts.staged, 0)
		const modified = status.changes.find((entry) => entry.path === 'tracked.txt')
		assert.equal(modified.letter, 'M')
		assert.equal(modified.additions, 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('stage, unstage and discard move one file between the groups', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')

		await perform({ action: 'stage', cwd: dir, paths: ['tracked.txt'] }, SIGNAL)
		let status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.deepEqual(status.staged.map((entry) => entry.path), ['tracked.txt'])
		assert.deepEqual(status.changes, [])

		await perform({ action: 'unstage', cwd: dir, paths: ['tracked.txt'] }, SIGNAL)
		status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.deepEqual(status.staged, [])
		assert.deepEqual(status.changes.map((entry) => entry.path), ['tracked.txt'])

		await perform({ action: 'discard', cwd: dir, paths: ['tracked.txt'], untracked: [] }, SIGNAL)
		status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.counts.changes, 0)
		assert.equal(await readFile(join(dir, 'tracked.txt'), 'utf8'), 'one\n')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('discard removes an untracked file but never a path outside the repo', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'junk.txt'), 'temporary\n')
		await perform({ action: 'discard', cwd: dir, paths: [], untracked: ['junk.txt'] }, SIGNAL)
		await assert.rejects(() => readFile(join(dir, 'junk.txt')), /ENOENT/)

		await assert.rejects(
			() => perform({ action: 'discard', cwd: dir, paths: [], untracked: ['../outside.txt'] }, SIGNAL),
			/escapes the repository/,
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('a commit carries the message, stages everything when asked, and shows up in the graph', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')
		await writeFile(join(dir, 'extra.txt'), 'extra\n')

		const committed = await perform(
			{ action: 'commit', cwd: dir, message: 'feat: second\n\nbody paragraph', stageAll: true },
			SIGNAL,
		)
		assert.equal(committed.ok, true)
		assert.match(committed.hash, /^[0-9a-f]{7,}$/)
		assert.equal(committed.branch, 'main')

		const status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.counts.staged + status.counts.changes + status.counts.untracked, 0)

		const graph = await perform({ action: 'graph', cwd: dir, limit: 10 }, SIGNAL)
		assert.equal(graph.commits.length, 2)
		assert.equal(graph.commits[0].subject, 'feat: second')
		assert.equal(graph.commits[0].body, 'body paragraph')
		assert.deepEqual(graph.commits[0].refs, [{ kind: 'head', name: 'main' }])

		const detail = await perform({ action: 'commitDetail', cwd: dir, hash: graph.commits[0].hash }, SIGNAL)
		assert.equal(detail.commit.files.length, 2)
		const extra = detail.commit.files.find((file) => file.path === 'extra.txt')
		assert.equal(extra.status, 'A')
		assert.equal(extra.additions, 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('an empty message is refused before git runs', async () => {
	const dir = await repository()
	try {
		await assert.rejects(() => perform({ action: 'commit', cwd: dir, message: '   ' }, SIGNAL), /提交信息不能为空/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('a diff renders one file, one commit and every change', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')
		await writeFile(join(dir, 'brand-new.txt'), 'hello\n')

		const single = await perform({ action: 'diff', cwd: dir, path: 'tracked.txt' }, SIGNAL)
		assert.match(single.patch, /\+two/u)
		assert.equal(single.path, 'tracked.txt')

		const untracked = await perform({ action: 'diff', cwd: dir, path: 'brand-new.txt', untracked: true }, SIGNAL)
		assert.match(untracked.patch, /\+hello/u)
		assert.equal(untracked.binary, false)

		const all = await perform({ action: 'diff', cwd: dir, all: true }, SIGNAL)
		assert.match(all.patch, /\+two/u)
		assert.match(all.patch, /\+hello/u)
		assert.equal(all.files, 2)

		const graph = await perform({ action: 'graph', cwd: dir, limit: 5 }, SIGNAL)
		const commit = await perform({ action: 'diff', cwd: dir, hash: graph.commits[0].hash }, SIGNAL)
		assert.match(commit.patch, /feat: initial/u)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('branches lists the current branch and checkout switches', async () => {
	const dir = await repository()
	try {
		await execFileSync('git', ['-C', dir, 'branch', 'next'], { encoding: 'utf8' })
		const branches = await perform({ action: 'branches', cwd: dir }, SIGNAL)
		assert.equal(branches.local.length, 2)
		assert.equal(branches.local.find((branch) => branch.current === true).name, 'main')

		const checkedOut = await perform({ action: 'checkout', cwd: dir, name: 'next' }, SIGNAL)
		assert.equal(checkedOut.name, 'next')
		const status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.branch, 'next')
		await assert.rejects(() => perform({ action: 'checkout', cwd: dir, name: '-x' }, SIGNAL), /分支名不合法/)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('a checkout answers with the status it produced', async () => {
	const dir = await repository()
	try {
		await execFileSync('git', ['-C', dir, 'branch', 'next'], { encoding: 'utf8' })
		const checkedOut = await perform({ action: 'checkout', cwd: dir, name: 'next' }, SIGNAL)
		// The panel paints the chip from this payload: no second round trip, and
		// no frame where the old branch is still on screen.
		assert.equal(checkedOut.status.branch, 'next')
		assert.equal(checkedOut.status.detached, false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('a write answers with the status it produced', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')
		const staged = await perform({ action: 'stage', cwd: dir, paths: ['tracked.txt'] }, SIGNAL)
		assert.equal(staged.status.counts.staged, 1)
		assert.equal(staged.status.counts.changes, 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('status reads an unborn HEAD as no commit yet', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-git-panel-empty-'))
	try {
		execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' })
		const status = await perform({ action: 'status', cwd: dir }, SIGNAL)
		assert.equal(status.repo, true)
		assert.equal(status.branch, 'main')
		assert.equal(status.unborn, true)
		assert.equal(status.oid, null)
		assert.equal(status.detached, false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('status reads a detached HEAD as its short commit', async () => {
	const dir = await repository()
	try {
		const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
		execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', head], { encoding: 'utf8' })
		const status = await perform({ action: 'status', cwd: dir }, SIGNAL)
		assert.equal(status.detached, true)
		assert.equal(status.branch, null)
		assert.equal(status.oid, head.slice(0, 7))
		assert.equal(status.unborn, false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('undoCommit keeps the content staged', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')
		await perform({ action: 'commit', cwd: dir, message: 'feat: second', stageAll: true }, SIGNAL)
		await perform({ action: 'undoCommit', cwd: dir }, SIGNAL)
		const status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.counts.staged, 1)
		assert.equal(status.counts.changes, 0)
		const graph = await perform({ action: 'graph', cwd: dir, limit: 10 }, SIGNAL)
		assert.equal(graph.commits.length, 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('a stash round trip returns the work tree to HEAD and back', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'stashed.txt'), 'later\n')
		const pushed = await perform({ action: 'stash', cwd: dir, mode: 'push', message: 'wip' }, SIGNAL)
		assert.equal(pushed.ok, true)
		let status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.counts.untracked, 0)

		await perform({ action: 'stash', cwd: dir, mode: 'pop' }, SIGNAL)
		status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.counts.untracked, 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('a directory outside any repository answers repo: false instead of failing', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-git-panel-plain-'))
	try {
		const status = await perform({ action: 'status', cwd: dir }, SIGNAL)
		assert.equal(status.repo, false)
		const graph = await perform({ action: 'graph', cwd: dir }, SIGNAL)
		assert.equal(graph.repo, false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('meta names the checkout this package itself lives in', async () => {
	const value = await perform({ action: 'meta' }, SIGNAL)
	assert.equal(value.fallback, REPO_ROOT)
	assert.ok(isAbsolute(value.fallback))
	assert.ok(existsSync(join(value.fallback, '.git')), 'the fallback root is a work tree')
})

test('the route refuses what it does not know', async () => {
	await assert.rejects(() => perform({ action: 'rm -rf', cwd: '/tmp' }, SIGNAL), /unknown action/)
	await assert.rejects(() => perform({ action: 'status', cwd: 'relative/path' }, SIGNAL), /absolute directory/)
	await assert.rejects(() => perform(null, SIGNAL), /JSON object/)
})

test('apply registers exactly one authenticated POST route', async () => {
	const registered = []
	const ctx = {
		inject: (names, callback) => {
			assert.deepEqual(JSON.parse(JSON.stringify(names)), ['connection'])
			callback({
				get: () => ({
					fetch: {
						register: (options) => {
							registered.push(options)
							return () => {}
						},
					},
				}),
				effect: (factory) => factory(),
			})
		},
	}
	apply(ctx)
	assert.equal(registered.length, 1)
	assert.equal(registered[0].path, '/api/git-panel')
	assert.deepEqual(JSON.parse(JSON.stringify(registered[0].methods)), ['POST'])
	assert.equal(registered[0].requestBody, 'buffered')

	const dir = await repository()
	try {
		const response = await registered[0].fetch({
			json: async () => ({ action: 'status', cwd: dir }),
			signal: SIGNAL,
		})
		const body = await response.json()
		assert.equal(body.ok, true)
		assert.equal(body.value.repo, true)

		const refused = await registered[0].fetch({
			json: async () => ({ action: 'nonsense', cwd: dir }),
			signal: SIGNAL,
		})
		const refusedBody = await refused.json()
		assert.equal(refusedBody.ok, false)
		assert.equal(refusedBody.error.code, 'bad-action')

		const broken = await registered[0].fetch({
			json: async () => {
				throw new Error('not json')
			},
			signal: SIGNAL,
		})
		assert.equal((await broken.json()).error.code, 'bad-request')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('discard deletes a staged-new file, which has no HEAD version to restore', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'fresh.txt'), 'brand new\n')
		await perform({ action: 'stage', cwd: dir, paths: ['fresh.txt'] }, SIGNAL)
		let status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.deepEqual(status.staged.map((entry) => entry.path), ['fresh.txt'])
		assert.equal(status.staged[0].letter, 'A')

		// `git restore --source=HEAD` removes a path HEAD never had, index and
		// worktree alike; nothing is left behind as an untracked file.
		const discarded = await perform({ action: 'discard', cwd: dir, paths: ['fresh.txt'], untracked: [] }, SIGNAL)
		assert.deepEqual(discarded.paths, ['fresh.txt'])
		await assert.rejects(() => readFile(join(dir, 'fresh.txt')), /ENOENT/)

		status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.counts.staged + status.counts.changes + status.counts.untracked, 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('discard of a mixed batch restores what HEAD knows and deletes what it does not', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')
		await writeFile(join(dir, 'fresh.txt'), 'brand new\n')
		await perform({ action: 'stage', cwd: dir, paths: ['fresh.txt'] }, SIGNAL)

		const discarded = await perform({ action: 'discard', cwd: dir, paths: ['tracked.txt', 'fresh.txt'], untracked: [] }, SIGNAL)
		assert.deepEqual(discarded.paths, ['tracked.txt', 'fresh.txt'])
		assert.equal(await readFile(join(dir, 'tracked.txt'), 'utf8'), 'one\n')
		await assert.rejects(() => readFile(join(dir, 'fresh.txt')), /ENOENT/)

		const status = await perform({ action: 'status', cwd: dir, force: true }, SIGNAL)
		assert.equal(status.counts.changes + status.counts.staged + status.counts.untracked, 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('a write invalidates the cached status the panel polls', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n')
		// Prime the cache the way the panel's poll does.
		let status = await perform({ action: 'status', cwd: dir }, SIGNAL)
		assert.equal(status.counts.changes, 1)

		// No `force` here: the next status must not answer from the stale cache.
		await perform({ action: 'stage', cwd: dir, paths: ['tracked.txt'] }, SIGNAL)
		status = await perform({ action: 'status', cwd: dir }, SIGNAL)
		assert.equal(status.counts.staged, 1)
		assert.equal(status.counts.changes, 0)

		await perform({ action: 'discard', cwd: dir, paths: ['tracked.txt'], untracked: [] }, SIGNAL)
		status = await perform({ action: 'status', cwd: dir }, SIGNAL)
		assert.equal(status.counts.staged, 0)
		assert.equal(status.counts.changes, 0)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('an untracked new file previews as an all-additions patch', async () => {
	const dir = await repository()
	try {
		await writeFile(join(dir, 'fresh.txt'), 'first line\nsecond line\n')
		const preview = await perform({ action: 'diff', cwd: dir, path: 'fresh.txt', untracked: true }, SIGNAL)
		assert.equal(preview.binary, false)
		assert.match(preview.patch, /^\+\+\+ b\/fresh\.txt$/mu)
		const added = preview.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
		assert.deepEqual(added, ['+first line', '+second line'])
		assert.equal(preview.patch.includes('-first line'), false)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
