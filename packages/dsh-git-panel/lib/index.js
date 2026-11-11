/**
 * Host half of `dsh-git-panel`.
 *
 * The Browser half draws a Git section (changes, commit box, stage/discard,
 * diff preview, commit graph) inside the right Sidebar, but the browser cannot
 * run git and must never be trusted with one. Everything that touches a
 * repository happens here, behind one authenticated `POST /api/git-panel`
 * route below the same `/api` channel as every other Host feature:
 *
 *   read      status · numstat · graph · diff · commit detail · branches
 *   write     stage · unstage · discard · commit · amend · undo commit
 *             fetch · pull · push · sync · checkout · stash · stash pop
 *
 * The action vocabulary and its payload shape are modelled on the Git module of
 * the local Cursor IDE (its bundled `extensions/git` — 154 contributed
 * commands, the `scm/*` resource groups `merge | index | workingTree |
 * untracked`, and the `git.graph.*` commands that drive the Source Control
 * Graph view). Only the subset a Sidebar panel can honestly drive is here;
 * `lib/README` in the repository package lists what was deliberately left out.
 *
 * Security has one home, here:
 *
 *   - The route is registered only through the `connection` service, so the
 *     Host/Origin fence and the browser login cookie gate the caller before any
 *     repository is read or written.
 *   - `cwd` must be an absolute directory that resolves inside a Git work tree.
 *   - Every path a write action names is resolved against the repository root
 *     and must stay inside it; `..`, absolute paths and symlink escapes are
 *     refused before git runs.
 *   - Commands are spawned with an argument vector (never a shell) and a
 *     scrubbed environment: no terminal prompt, no pager, C locale.
 *
 * @module dsh-git-panel
 */
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Loader identity. */
export const name = 'git-panel'

/** Exact route below `/api`; the browser half requests the same path. */
export const ROUTE = '/api/git-panel'

/** Milliseconds one read command may run before the request gives up. */
const READ_TIMEOUT_MS = 15000
/** Writes and network commands are slower; the UI shows progress for them. */
const WRITE_TIMEOUT_MS = 120000
/** Bytes kept per command; a bigger diff listing is refused rather than truncated silently. */
const MAX_BUFFER = 16 * 1024 * 1024
/** A single file preview beyond this stays a "binary or too large" stub in the diff tab. */
const MAX_PREVIEW_BYTES = 1024 * 1024
/** Longest absolute `cwd` accepted from the browser. */
const MAX_PATH_LENGTH = 4096
/** Default commit graph depth. */
const DEFAULT_GRAPH_LIMIT = 60
/** Hard ceiling for the graph depth. */
const MAX_GRAPH_LIMIT = 400

/** Value reads stay fresh for the same caller inside this window (one render pass). */
const STATUS_TTL_MS = 1200

/**
 * The Git work tree this package itself lives in, if any.
 *
 * A Sidebar panel is scoped to the Session's working directory, but a Session
 * parked outside a repository (a workspace root, say) has nothing to show while
 * the user is editing this very plugin. The browser half asks for this root and
 * falls back to it when the Session directory answers `repo: false`. Resolved
 * once at load: a `link:` install walks up to the checkout, an npm install
 * stops somewhere under `node_modules` with no `.git` above it.
 */
const PLUGIN_REPO_ROOT = (() => {
	try {
		let directory = dirname(realpathSync(fileURLToPath(import.meta.url)))
		while (true) {
			if (existsSync(join(directory, '.git'))) return directory
			const parent = dirname(directory)
			if (parent === directory) return undefined
			directory = parent
		}
	} catch {
		return undefined
	}
})()

/** `path -> { at, value }` for `status` only: the panel polls it. */
const statusCache = new Map()

/** A refusal the browser can translate by `code`. */
class PanelError extends Error {
	constructor(code, message, details = undefined) {
		super(message)
		this.name = 'PanelError'
		this.code = code
		this.details = details
	}
}

/* ------------------------------------------------------------------ */
/* Running git                                                         */
/* ------------------------------------------------------------------ */

/**
 * One settled git result. A nonzero exit is a result, not an exception: the
 * panel shows stderr (a rejected push is an answer the user must read).
 */
function settled(exitCode, stdout, stderr, capped) {
	return { exitCode, stdout, stderr, capped }
}

/**
 * Spawn `git -C <cwd> <args>` with a scrubbed environment.
 * @param {string} cwd - repository working directory.
 * @param {string[]} args - git arguments; never shell-interpreted.
 * @param {object} [options] - stdin text, timeout, cancellation, read-only hint.
 * @returns {Promise<object>} settled result.
 */
function runGit(cwd, args, options = {}) {
	const {
		stdin,
		signal,
		timeoutMs = READ_TIMEOUT_MS,
		readOnly = true,
		maxBuffer = MAX_BUFFER,
	} = options

	return new Promise((resolvePromise, rejectPromise) => {
		const env = {
			...process.env,
			GIT_TERMINAL_PROMPT: '0',
			GIT_PAGER: 'cat',
			PAGER: 'cat',
			LC_ALL: 'C',
			LANG: 'C',
		}
		// Optional locks stay off for reads: a panel poll must never touch the
		// index of a repository the user is not looking at. Writes need their own
		// locks, so the hint is dropped there.
		if (readOnly) env.GIT_OPTIONAL_LOCKS = '0'

		let child
		try {
			child = spawn('git', ['-C', cwd, ...args], {
				cwd,
				env,
				stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
				windowsHide: true,
			})
		} catch (error) {
			rejectPromise(error instanceof Error ? error : new Error(String(error)))
			return
		}

		let stdout = ''
		let stderr = ''
		let capped = false
		let timer
		const stop = () => {
			if (timer !== undefined) clearTimeout(timer)
			timer = undefined
		}
		const onAbort = () => {
			stop()
			child.kill('SIGKILL')
		}

		if (signal !== undefined) {
			if (signal.aborted === true) {
				onAbort()
				rejectPromise(new PanelError('cancelled', 'the request was cancelled'))
				return
			}
			signal.addEventListener('abort', onAbort, { once: true })
		}

		timer = setTimeout(() => {
			capped = true
			child.kill('SIGKILL')
		}, timeoutMs)

		child.stdout?.setEncoding('utf8')
		child.stderr?.setEncoding('utf8')
		child.stdout?.on('data', (chunk) => {
			if (stdout.length > maxBuffer) return
			stdout += chunk
			if (stdout.length > maxBuffer) {
				capped = true
				child.kill('SIGKILL')
			}
		})
		child.stderr?.on('data', (chunk) => {
			if (stderr.length > 1024 * 1024) return
			stderr += chunk
		})
		child.on('error', (error) => {
			stop()
			signal?.removeEventListener?.('abort', onAbort)
			rejectPromise(new PanelError('spawn-failed', error.message))
		})
		child.on('close', (code) => {
			stop()
			signal?.removeEventListener?.('abort', onAbort)
			if (signal?.aborted === true) {
				rejectPromise(new PanelError('cancelled', 'the request was cancelled'))
				return
			}
			if (capped === true && code !== 0 && stdout === '') {
				rejectPromise(new PanelError('timeout', `git ${args[0] ?? ''} did not finish in ${timeoutMs} ms`))
				return
			}
			resolvePromise(settled(capped ? 124 : code, stdout, stderr, capped))
		})

		if (stdin !== undefined && child.stdin !== undefined) {
			child.stdin.end(stdin)
		}
	})
}

/**
 * Run a command and throw when git fails, attaching stderr to the refusal.
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @param {object} [options] - see {@link runGit}.
 * @returns {Promise<string>} stdout on success.
 */
async function mustGit(cwd, args, options = {}) {
	const result = await runGit(cwd, args, options)
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`
		throw new PanelError('git-failed', detail, { args, exitCode: result.exitCode })
	}
	return result.stdout
}

/* ------------------------------------------------------------------ */
/* Repository resolution                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolve the repository a working directory belongs to.
 * `repo: false` is a normal answer ("this directory is not a Git work tree"),
 * never a failure.
 * @param {string} cwd - absolute Session working directory.
 * @param {AbortSignal} [signal] - request signal.
 * @returns {Promise<object>} `{ repo: false }` or the repository facts.
 */
async function locateRepository(cwd, signal) {
	// One `rev-parse` answers all three questions in the order they were asked.
	// The panel asks this on every poll, so three spawns became one: on macOS a
	// spawn costs more than the answer. A bare repository prints `false` and then
	// fails on `--show-toplevel`; the first line is what decides.
	const probe = await runGit(cwd, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir'], { signal })
	const [inside, top, gitDir] = probe.stdout.split('\n').map((line) => line.trim())
	if (inside !== 'true' || top === undefined || top === '') return { repo: false }

	return {
		repo: true,
		root: top,
		gitDir: gitDir === undefined || gitDir === '' ? join(top, '.git') : gitDir,
		name: top.split(/[\\/]/).filter(Boolean).pop() ?? top,
	}
}

/**
 * Check that one caller-supplied path stays inside the repository root.
 * Refuses absolute paths, `..` segments and anything that escapes after
 * resolution, so a write can never reach outside the work tree it named.
 * @param {string} root - repository top level.
 * @param {string} path - repository-relative path from the request.
 * @returns {string} the normalized relative path.
 */
function containedPath(root, path) {
	if (typeof path !== 'string' || path === '' || path.length > MAX_PATH_LENGTH) {
		throw new PanelError('bad-path', 'a path must be a non-empty string')
	}
	if (isAbsolute(path)) throw new PanelError('bad-path', 'absolute paths are refused')
	const normalized = path.replace(/\\/g, '/')
	const absolute = resolve(root, normalized)
	const rel = relative(root, absolute)
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
		throw new PanelError('bad-path', `${path} escapes the repository`)
	}
	return rel.split(sep).join('/')
}

/**
 * Read and validate the caller's `cwd`.
 * @param {unknown} value - request field.
 * @returns {string} absolute directory path.
 */
function readCwd(value) {
	if (typeof value !== 'string' || value === '' || value.length > MAX_PATH_LENGTH || !isAbsolute(value)) {
		throw new PanelError('bad-cwd', 'cwd must be an absolute directory path')
	}
	return value
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/** Long status letter for one porcelain code point. */
const LETTERS = {
	M: 'M',
	A: 'A',
	D: 'D',
	R: 'R',
	C: 'C',
	U: 'U',
	T: 'T',
}

/**
 * Turn one porcelain XY pair into the two letters the panel shows.
 * @param {string} code - two-character `XY` field.
 * @returns {{ index: string, worktree: string }} letters, empty for unchanged.
 */
function lettersOf(code) {
	const x = code[0] ?? '.'
	const y = code[1] ?? '.'
	return { index: LETTERS[x] ?? '', worktree: LETTERS[y] ?? '' }
}

/**
 * Parse `git status --porcelain=v2 --branch -z --untracked-files=all`.
 *
 * The NUL framing is what keeps unusual file names intact: a record's own path
 * is its last space-separated field (so spaces survive), and a rename's
 * original path is the following NUL-terminated field.
 * @param {string} raw - stdout.
 * @returns {object} branch facts and the four entry lists.
 */
export function parseStatus(raw) {
	const fields = raw.split('\0')
	const branch = { head: null, upstream: null, ahead: 0, behind: 0, oid: null }
	/** @type {object[]} */
	const staged = []
	/** @type {object[]} */
	const changes = []
	/** @type {object[]} */
	const untracked = []
	/** @type {object[]} */
	const conflicts = []

	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index]
		if (record === '') continue

		if (record.startsWith('# ')) {
			const [key, ...rest] = record.slice(2).split(' ')
			const value = rest.join(' ')
			if (key === 'branch.oid') branch.oid = value
			else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value
			else if (key === 'branch.upstream') branch.upstream = value
			else if (key === 'branch.ab') {
				const [ahead, behind] = value.split(' ')
				branch.ahead = Number.parseInt(String(ahead).replace('+', ''), 10) || 0
				branch.behind = Math.abs(Number.parseInt(String(behind), 10) || 0)
			}
			continue
		}

		const kind = record[0]
		if (kind === '1' || kind === '2') {
			const parts = record.split(' ')
			// 1 XY sub mH mI mW hH hI path
			// 2 XY sub mH mI mW hH hI Xscore path  (+ original path as the next field)
			const pathStart = kind === '2' ? 9 : 8
			const path = parts.slice(pathStart).join(' ')
			const code = parts[1] ?? '..'
			const letters = lettersOf(code)
			const originalPath = kind === '2' ? fields[index + 1] : undefined
			if (kind === '2') index += 1
			const entry = {
				path,
				code,
				index: letters.index,
				worktree: letters.worktree,
				originalPath: originalPath === '' ? undefined : originalPath,
			}
			if (letters.index !== '') staged.push({ ...entry, letter: letters.index })
			if (letters.worktree !== '') changes.push({ ...entry, letter: letters.worktree })
			continue
		}

		if (kind === 'u') {
			const parts = record.split(' ')
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			const path = parts.slice(10).join(' ')
			const letters = lettersOf(parts[1] ?? '..')
			conflicts.push({
				path,
				code: parts[1] ?? '..',
				letter: letters.worktree || letters.index || 'U',
			})
			continue
		}

		if (kind === '?') {
			untracked.push({ path: record.slice(2), letter: 'U', code: '??' })
		}
	}

	return { branch, staged, changes, untracked, conflicts }
}

/**
 * Parse `git diff --numstat -z` into `path -> { additions, deletions, binary }`.
 * Rename records put the two paths in their own NUL fields, so they are read
 * from the same field stream the status uses.
 * @param {string} raw - stdout.
 * @returns {Map<string, object>} counts by path.
 */
export function parseNumstat(raw) {
	const counts = new Map()
	const fields = raw.split('\0')
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index]
		if (field === '') continue
		const parts = field.split('\t')
		if (parts.length < 3) continue
		const [additions, deletions] = parts
		let path = parts.slice(2).join('\t')
		if (path === '') {
			// Rename: the empty path slot is followed by `<old>\0<new>\0`.
			path = fields[index + 2] ?? fields[index + 1] ?? ''
			index += 2
		}
		if (path === '') continue
		const binary = additions === '-' || deletions === '-'
		counts.set(path, {
			additions: binary ? 0 : Number.parseInt(additions, 10) || 0,
			deletions: binary ? 0 : Number.parseInt(deletions, 10) || 0,
			binary,
		})
	}
	return counts
}

/**
 * Build the complete status payload for one working directory.
 * @param {string} cwd - absolute directory.
 * @param {AbortSignal} [signal] - request signal.
 * @param {boolean} [force] - ignore the short read cache.
 * @returns {Promise<object>} the payload the panel renders.
 */
export async function readStatus(cwd, signal, force = false) {
	const cached = statusCache.get(cwd)
	if (force !== true && cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) return cached.value

	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) return rememberStatus(cwd, { repo: false, cwd })

	const [status, stagedCounts, worktreeCounts] = await Promise.all([
		runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { signal }),
		runGit(cwd, ['diff', '--cached', '--numstat', '-z'], { signal }),
		runGit(cwd, ['diff', '--numstat', '-z'], { signal }),
	])
	if (status.exitCode !== 0) {
		throw new PanelError('git-failed', status.stderr.trim() || 'git status failed')
	}

	const parsed = parseStatus(status.stdout)
	const staged = mergeCounts(parsed.staged, parseNumstat(stagedCounts.stdout))
	const changes = mergeCounts(parsed.changes, parseNumstat(worktreeCounts.stdout))
	// `--branch` already reports the checked-out object, so `rev-parse HEAD` and
	// the MERGE_HEAD probe are gone: three fewer spawns on a route the panel
	// hits every few seconds. An unborn HEAD is `(initial)` there.
	const fullOid = typeof parsed.branch.oid === 'string' ? parsed.branch.oid : ''
	const unborn = fullOid === '' || fullOid === '(initial)'

	const payload = {
		repo: true,
		cwd,
		root: repository.root,
		name: repository.name,
		branch: parsed.branch.head,
		detached: parsed.branch.head === null,
		oid: unborn ? null : fullOid.slice(0, 7),
		unborn,
		upstream: parsed.branch.upstream,
		ahead: parsed.branch.ahead,
		behind: parsed.branch.behind,
		staged,
		changes,
		untracked: parsed.untracked,
		conflicts: parsed.conflicts,
		merging: existsSync(join(repository.gitDir, 'MERGE_HEAD')),
		counts: {
			staged: staged.length,
			changes: changes.length,
			untracked: parsed.untracked.length,
			conflicts: parsed.conflicts.length,
		},
		generatedAt: Date.now(),
	}
	return rememberStatus(cwd, payload)
}

/**
 * Attach the status a finished write caused.
 *
 * The panel used to answer every write with `{ ok: true }` and then ask for
 * `status` again: two round trips, and a window where the branch chip and the
 * ahead/behind counts still showed what the write had just replaced. Handing
 * the fresh status back in the same response closes that window and halves the
 * hand-offs on a checkout or a fetch.
 *
 * A status read that fails must not turn a finished write into an error — the
 * write already happened, so the value stands on its own.
 * @param {string} cwd - repository working directory.
 * @param {AbortSignal} [signal] - request signal.
 * @param {object} value - the action's own payload.
 * @returns {Promise<object>} the payload, plus `status` when it could be read.
 */
async function settleStatus(cwd, signal, value) {
	statusCache.delete(cwd)
	try {
		return { ...value, status: await readStatus(cwd, signal, true) }
	} catch {
		return value
	}
}

/**
 * Attach `+/-` counts to the entries whose path has them.
 * @param {object[]} entries - status entries.
 * @param {Map<string, object>} counts - numstat by path.
 * @returns {object[]} entries with `additions`/`deletions`.
 */
function mergeCounts(entries, counts) {
	return entries.map((entry) => {
		const count = counts.get(entry.path) ?? counts.get(entry.originalPath ?? '') ?? undefined
		return {
			...entry,
			additions: count?.additions ?? 0,
			deletions: count?.deletions ?? 0,
			binary: count?.binary ?? false,
		}
	})
}

function rememberStatus(cwd, value) {
	if (statusCache.size > 32) statusCache.clear()
	statusCache.set(cwd, { at: Date.now(), value })
	return value
}

/* ------------------------------------------------------------------ */
/* Commit graph                                                        */
/* ------------------------------------------------------------------ */

/** Record and field separators for `git log --pretty=format:`. */
const RECORD = '\x1e'
const FIELD = '\x1f'

/**
 * Parse one decorated `git log` stream.
 * @param {string} raw - stdout.
 * @returns {object[]} commits in the order git produced them.
 */
export function parseGraph(raw, remotes = ['origin']) {
	const commits = []
	for (const chunk of raw.split(RECORD)) {
		const text = chunk.replace(/^\n/u, '')
		if (text.trim() === '') continue
		const [hash, parents, author, email, at, decorations, subject, ...bodyParts] = text.split(FIELD)
		if (typeof hash !== 'string' || hash.length < 7) continue
		commits.push({
			hash,
			short: hash.slice(0, 7),
			parents: typeof parents === 'string' && parents !== '' ? parents.split(' ').filter(Boolean) : [],
			author: author ?? '',
			email: email ?? '',
			at: Number.parseInt(at ?? '0', 10) || 0,
			refs: parseDecorations(decorations ?? '', remotes),
			subject: subject ?? '',
			body: bodyParts.join(FIELD).trim(),
		})
	}
	return commits
}

/**
 * Parse `%D` decorations into typed refs.
 * `HEAD -> main, origin/main, tag: v1.0.0` becomes typed entries the panel can
 * badge and act on.
 *
 * `%D` does not say whether a slashed name is a remote-tracking ref or a local
 * branch, so the repository's remote names decide: only `origin/main` where
 * `origin` is a configured remote is a remote ref, while `feat/dock` stays a
 * local branch.
 * @param {string} text - decoration field.
 * @param {string[]} [remotes] - configured remote names; defaults to `origin`.
 * @returns {object[]} refs in git's order.
 */
export function parseDecorations(text, remotes = ['origin']) {
	const refs = []
	const remotes$ = new Set(remotes.map((entry) => String(entry)))
	for (const piece of text.split(',')) {
		const token = piece.trim()
		if (token === '') continue
		if (token.startsWith('HEAD -> ')) {
			const name = token.slice(8).trim()
			refs.push({ kind: 'head', name })
			continue
		}
		if (token === 'HEAD') {
			refs.push({ kind: 'head', name: 'HEAD' })
			continue
		}
		if (token.startsWith('tag: ')) {
			refs.push({ kind: 'tag', name: token.slice(5).trim() })
			continue
		}
		const slash = token.indexOf('/')
		if (slash > 0 && remotes$.has(token.slice(0, slash))) {
			refs.push({ kind: 'remote', name: token })
			continue
		}
		refs.push({ kind: 'branch', name: token })
	}
	return refs
}

/**
 * Read the commit graph of one repository.
 * @param {string} cwd - absolute directory.
 * @param {object} options - `limit`, `all` (every ref) and cancellation.
 * @returns {Promise<object>} graph payload.
 */
async function readGraph(cwd, { limit, all, signal }) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) return { repo: false }

	const depth = Math.min(Math.max(Number.parseInt(String(limit ?? DEFAULT_GRAPH_LIMIT), 10) || DEFAULT_GRAPH_LIMIT, 1), MAX_GRAPH_LIMIT)
	const args = [
		'log',
		`--max-count=${depth + 1}`,
		'--date-order',
		all === true ? '--all' : 'HEAD',
		`--pretty=format:${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%D${FIELD}%s${FIELD}%b`,
	]

	const [result, remoteList] = await Promise.all([
		runGit(cwd, args, { signal, maxBuffer: 8 * 1024 * 1024 }),
		runGit(cwd, ['remote'], { signal }),
	])
	const remotes = remoteList.exitCode === 0 ? remoteList.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
	if (result.exitCode !== 0) {
		// An unborn HEAD has no history yet; that is an empty graph, not an error.
		const message = result.stderr.toLowerCase()
		if (message.includes('does not have any commits') || message.includes('unknown revision') || message.includes('bad revision')) {
			return { repo: true, root: repository.root, name: repository.name, branch: null, commits: [], truncated: false, all: all === true }
		}
		throw new PanelError('git-failed', result.stderr.trim() || 'git log failed')
	}

	const commits = parseGraph(result.stdout, remotes)
	const truncated = commits.length > depth
	return {
		repo: true,
		root: repository.root,
		name: repository.name,
		commits: truncated ? commits.slice(0, depth) : commits,
		truncated,
		all: all === true,
	}
}

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

/**
 * Render one untracked file as a synthetic "new file" patch, so the diff tab can
 * show what a first-time file actually contains.
 * @param {string} root - repository root.
 * @param {string} path - repository-relative path.
 * @returns {Promise<object>} `{ patch, binary, meta }`.
 */
async function untrackedPatch(root, path) {
	const absolute = resolve(root, path)
	try {
		const info = await stat(absolute)
		if (info.size > MAX_PREVIEW_BYTES) {
			return { patch: '', binary: true, meta: `新文件（${Math.round(info.size / 1024)} KiB，超过预览上限）` }
		}
		const bytes = await readFile(absolute)
		if (bytes.includes(0)) return { patch: '', binary: true, meta: '新文件（二进制）' }
		const text = bytes.toString('utf8')
		const lines = text.split('\n')
		if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
		const body = lines.map((line) => `+${line}`).join('\n')
		return {
			patch: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
			binary: false,
			meta: `新文件（${lines.length} 行）`,
		}
	} catch (error) {
		return { patch: '', binary: true, meta: `新文件（无法读取：${error instanceof Error ? error.message : String(error)}）` }
	}
}

/**
 * Produce the unified diff one file needs.
 * @param {string} cwd - absolute directory.
 * @param {object} request - `{ path, staged, untracked, hash }`.
 * @param {AbortSignal} [signal] - request signal.
 * @returns {Promise<object>} patch payload.
 */
async function readDiff(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) return { repo: false }

	const hash = typeof request.hash === 'string' && /^[0-9a-f]{4,64}$/iu.test(request.hash) ? request.hash : null
	if (hash !== null) {
		const patch = await mustGit(
			cwd,
			['show', '--no-color', '--format=%H%n%an <%ae>%n%ad%n%s%n%b', '--date=iso', '-U3', hash, '--'],
			{ signal, maxBuffer: 8 * 1024 * 1024 },
		)
		return { repo: true, root: repository.root, patch, binary: false, meta: hash }
	}

	const path = typeof request.path === 'string' && request.path !== '' ? containedPath(repository.root, request.path) : null
	const staged = request.staged === true
	const untracked = request.untracked === true

	if (path === null) {
		if (request.all === true) {
			// The preview page for "every change" shows the staged part, the working
			// tree part and each new file, in that order — the same three groups the
			// panel lists.
			const pieces = []
			const stagedDiff = await runGit(cwd, ['diff', '--cached', '--no-color', '-U3'], { signal, maxBuffer: 8 * 1024 * 1024 })
			if (stagedDiff.stdout.trim() !== '') pieces.push(stagedDiff.stdout)
			const worktreeDiff = await runGit(cwd, ['diff', '--no-color', '-U3'], { signal, maxBuffer: 8 * 1024 * 1024 })
			if (worktreeDiff.stdout.trim() !== '') pieces.push(worktreeDiff.stdout)
			const status = await readStatus(cwd, signal, true)
			for (const entry of status.untracked ?? []) {
				const synthetic = await untrackedPatch(repository.root, entry.path)
				if (synthetic.patch !== '') pieces.push(synthetic.patch)
			}
			return {
				repo: true,
				root: repository.root,
				patch: pieces.join('\n'),
				binary: false,
				meta: 'all',
				files: status.untracked.length + status.staged.length + status.changes.length,
			}
		}
		const args = staged ? ['diff', '--cached', '--no-color', '-U3'] : ['diff', '--no-color', '-U3']
		const patch = await mustGit(cwd, args, { signal, maxBuffer: 8 * 1024 * 1024 })
		return { repo: true, root: repository.root, patch, binary: false, meta: staged ? 'staged' : 'worktree' }
	}

	if (untracked === true) {
		const synthetic = await untrackedPatch(repository.root, path)
		return { repo: true, root: repository.root, path, ...synthetic }
	}

	const args = staged
		? ['diff', '--cached', '--no-color', '-U3', '--', path]
		: ['diff', '--no-color', '-U3', '--', path]
	const patch = await mustGit(cwd, args, { signal, maxBuffer: 8 * 1024 * 1024 })
	return {
		repo: true,
		root: repository.root,
		path,
		patch,
		binary: patch.includes('Binary files'),
		meta: staged ? 'staged' : 'worktree',
	}
}

/**
 * Read one commit's file list with its counts, for the node description panel.
 * @param {string} cwd - absolute directory.
 * @param {string} hash - commit id (validated by the caller).
 * @param {AbortSignal} [signal] - request signal.
 * @returns {Promise<object>} file rows.
 */
async function readCommit(cwd, hash, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) return { repo: false }

	const meta = await mustGit(
		cwd,
		['show', '--no-color', '--no-patch', '--date=iso', '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', hash],
		{ signal },
	)
	const [full, parents, author, email, at, subject, ...body] = meta.split(FIELD)
	const numstat = await runGit(cwd, ['show', '--numstat', '-z', '--format=', hash], { signal })
	const nameStatus = await runGit(cwd, ['show', '--name-status', '-z', '--format=', hash], { signal })

	return {
		repo: true,
		root: repository.root,
		commit: {
			hash: full,
			short: String(full).slice(0, 7),
			parents: typeof parents === 'string' && parents !== '' ? parents.split(' ') : [],
			author: author ?? '',
			email: email ?? '',
			at: at ?? '',
			subject: subject ?? '',
			body: body.join(FIELD).trim(),
			files: commitFiles(numstat.stdout, nameStatus.stdout),
		},
	}
}

/**
 * Merge `--numstat` and `--name-status` into one row per file.
 * @param {string} numstat - stdout.
 * @param {string} nameStatus - stdout.
 * @returns {object[]} rows.
 */
export function commitFiles(numstat, nameStatus) {
	const counts = parseNumstat(numstat)
	const statuses = new Map()
	const fields = nameStatus.split('\0')
	for (let index = 0; index < fields.length; index += 1) {
		const code = fields[index]
		if (code === '') continue
		if (code[0] === 'R' || code[0] === 'C') {
			const from = fields[index + 1] ?? ''
			const to = fields[index + 2] ?? ''
			index += 2
			if (to !== '') statuses.set(to, { status: code[0], from })
			continue
		}
		const path = fields[index + 1] ?? ''
		index += 1
		if (path !== '') statuses.set(path, { status: code[0] ?? 'M', from: undefined })
	}

	const rows = []
	for (const [path, info] of statuses) {
		const count = counts.get(path)
		rows.push({
			path,
			status: info.status,
			from: info.from,
			additions: count?.additions ?? 0,
			deletions: count?.deletions ?? 0,
			binary: count?.binary ?? false,
		})
	}
	return rows
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve the paths one write action names and refuse an empty list.
 * @param {object} repository - located repository.
 * @param {unknown} paths - caller paths.
 * @returns {string[]} contained relative paths.
 */
function containedPaths(repository, paths) {
	if (!Array.isArray(paths) || paths.length === 0) throw new PanelError('bad-path', 'paths must be a non-empty array')
	if (paths.length > 500) throw new PanelError('bad-path', 'at most 500 paths per request')
	return paths.map((path) => containedPath(repository.root, path))
}

/**
 * `resolve`: take one side of a conflicted file, then stage it.
 *
 * `ours` keeps HEAD's version and `theirs` the incoming one — the panel-level
 * equivalent of the merge editor's "Accept Current / Incoming Change". Staging
 * afterwards is exactly what marks the conflict resolved, so the file leaves
 * Merge Changes and the commit button unblocks.
 */
async function resolveConflict(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const path = containedPath(repository.root, request.path)
	const mode = request.mode === 'theirs' ? 'theirs' : 'ours'
	const checked = await runGit(cwd, ['checkout', `--${mode}`, '--', path], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	if (checked.exitCode !== 0) {
		throw new PanelError('git-failed', checked.stderr.trim() || `git checkout --${mode} -- ${path} failed`)
	}
	await mustGit(cwd, ['add', '--', path], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	return settleStatus(cwd, signal, { ok: true, action: 'resolve', mode, path })
}

/**
 * `git stage`: add the named paths (deletions included).
 */
async function stage(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const paths = containedPaths(repository, request.paths)
	await mustGit(cwd, ['add', '-A', '--', ...paths], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	return settleStatus(cwd, signal, { ok: true, action: 'stage', paths })
}

/**
 * `git unstage`: drop the named paths from the index, keeping the work tree.
 */
async function unstage(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const paths = containedPaths(repository, request.paths)
	const reset = await runGit(cwd, ['restore', '--staged', '--', ...paths], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	if (reset.exitCode !== 0) {
		await mustGit(cwd, ['reset', '-q', 'HEAD', '--', ...paths], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	}
	return settleStatus(cwd, signal, { ok: true, action: 'unstage', paths })
}

/**
 * `discard`: restore tracked paths from HEAD and delete untracked ones.
 *
 * A path that is staged but has no HEAD version (a brand-new file) makes
 * `git restore --source=HEAD` refuse the whole batch, so the batch falls back to
 * one path at a time: HEAD-known paths are restored, HEAD-unknown ones are
 * unstaged and deleted — the same end state the user means by "discard".
 * The browser asks for confirmation; this path refuses anything outside the
 * work tree, and never deletes a directory the request did not name itself.
 */
async function discard(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const tracked = Array.isArray(request.paths) ? request.paths : []
	const untracked = Array.isArray(request.untracked) ? request.untracked : []
	if (tracked.length === 0 && untracked.length === 0) throw new PanelError('bad-path', 'nothing to discard')

	const restored = []
	const removed = []
	const paths = tracked.length > 0 ? containedPaths(repository, tracked) : []

	if (paths.length > 0) {
		const writeOptions = { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS }
		const bulk = await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths], writeOptions)
		if (bulk.exitCode === 0) {
			restored.push(...paths)
		} else {
			for (const path of paths) {
				if (signal?.aborted === true) break
				const single = await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path], writeOptions)
				if (single.exitCode === 0) {
					restored.push(path)
					continue
				}
				const known = await runGit(cwd, ['cat-file', '-e', `HEAD:${path}`], { signal })
				if (known.exitCode === 0) {
					// HEAD has a version, so a refused restore is a real failure: do not
					// delete content to make the click look like it worked.
					throw new PanelError('git-failed', single.stderr.trim() || `git restore -- ${path} failed`, { path })
				}
				// New in the index and absent from HEAD: unstage, then delete.
				await runGit(cwd, ['rm', '--cached', '-q', '--', path], writeOptions)
				await rm(resolve(repository.root, path), { recursive: true, force: true })
				removed.push(path)
			}
		}
	}

	if (untracked.length > 0) {
		const paths$ = containedPaths(repository, untracked)
		for (const path of paths$) {
			if (signal?.aborted === true) break
			await rm(resolve(repository.root, path), { recursive: true, force: true })
			removed.push(path)
		}
	}

	return settleStatus(cwd, signal, { ok: true, action: 'discard', paths: restored, removed })
}

/**
 * One commit, with the message on stdin so no quoting rule can mangle it.
 * Options mirror the Git module's commit matrix: amend, no-verify, signoff,
 * allow-empty, and "smart commit" (stage everything first).
 */
async function commit(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')

	const message = typeof request.message === 'string' ? request.message : ''
	const subject = message.split('\n').find((line) => line.trim() !== '') ?? ''
	if (subject.trim() === '' && request.allowEmpty !== true) {
		throw new PanelError('empty-message', '提交信息不能为空')
	}

	if (request.stageAll === true) {
		await mustGit(cwd, ['add', '-A'], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	}

	const args = ['commit', '-F', '-', '--cleanup=whitespace']
	if (request.amend === true) args.push('--amend')
	if (request.noVerify === true) args.push('--no-verify')
	if (request.signoff === true) args.push('--signoff')
	if (request.allowEmpty === true) args.push('--allow-empty')

	const result = await runGit(cwd, args, {
		signal,
		readOnly: false,
		timeoutMs: WRITE_TIMEOUT_MS,
		stdin: message === '' ? '\n' : message,
	})
	if (result.exitCode !== 0) {
		throw new PanelError('commit-failed', result.stderr.trim() || result.stdout.trim() || 'git commit failed')
	}

	const head = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], { signal })
	const branch = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal })
	return settleStatus(cwd, signal, {
		ok: true,
		action: 'commit',
		hash: head.exitCode === 0 ? head.stdout.trim() : null,
		branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
		summary: result.stdout.trim(),
	})
}

/** Undo the last commit but keep its content staged — the Git module's `undoCommit`. */
async function undoCommit(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal })
	if (head.exitCode !== 0) throw new PanelError('nothing-to-undo', '还没有任何提交')
	const soft = await runGit(cwd, ['reset', '--soft', 'HEAD~1'], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	if (soft.exitCode !== 0) {
		await mustGit(cwd, ['update-ref', '-d', 'HEAD'], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	}
	return settleStatus(cwd, signal, { ok: true, action: 'undoCommit' })
}

/** Network verbs. Each is one git command with its own timeout and honest stderr. */
async function network(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const mode = String(request.mode ?? 'fetch')

	const steps = []
	if (mode === 'fetch' || mode === 'sync') steps.push(['fetch', '--prune', '--all'])
	if (mode === 'pull' || mode === 'sync') steps.push(['pull', '--no-edit'])
	if (mode === 'push' || mode === 'sync') steps.push(['push'])

	const output = []

	/** Push once; a branch with no upstream gets `-u origin <branch>` instead. */
	async function pushWithUpstream() {
		const first = await runGit(cwd, ['push'], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
		output.push({ args: ['push'], exitCode: first.exitCode, stdout: first.stdout.trim(), stderr: first.stderr.trim() })
		if (first.exitCode === 0) return
		const text = `${first.stderr}\n${first.stdout}`
		if (!/no upstream branch|has no upstream|--set-upstream/i.test(text)) {
			throw new PanelError('git-failed', first.stderr.trim() || first.stdout.trim() || 'git push failed', { steps: output })
		}
		const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal })
		const branch = head.stdout.trim()
		const args = ['push', '-u', 'origin', branch]
		const second = await runGit(cwd, args, { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
		output.push({ args, exitCode: second.exitCode, stdout: second.stdout.trim(), stderr: second.stderr.trim() })
		if (second.exitCode !== 0) {
			throw new PanelError('git-failed', second.stderr.trim() || second.stdout.trim() || 'git push failed', { steps: output })
		}
	}

	for (const args of steps) {
		if (signal?.aborted === true) break
		if (args[0] === 'push') {
			await pushWithUpstream()
			continue
		}
		const result = await runGit(cwd, args, { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
		output.push({ args, exitCode: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() })
		if (result.exitCode !== 0) {
			throw new PanelError('git-failed', result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`, {
				steps: output,
			})
		}
	}

	return settleStatus(cwd, signal, { ok: true, action: 'network', mode, steps: output })
}

/**
 * List local branches and tags with their upstream, for the graph header and the
 * checkout menu.
 */
async function branches(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) return { repo: false }
	const format = '%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(HEAD)%1f%(committerdate:iso)'
	const [local, remote, tags] = await Promise.all([
		runGit(cwd, ['for-each-ref', `--format=${format}`, 'refs/heads'], { signal }),
		runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], { signal }),
		runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/tags'], { signal }),
	])
	return {
		repo: true,
		root: repository.root,
		local: parseRefList(local.stdout, true),
		remote: parseRefList(remote.stdout, false),
		tags: parseRefList(tags.stdout, false),
	}
}

/**
 * Parse one `for-each-ref` dump.
 * @param {string} raw - stdout.
 * @param {boolean} detailed - whether the format carried the extra fields.
 * @returns {object[]} ref rows.
 */
export function parseRefList(raw, detailed) {
	const rows = []
	for (const line of raw.split('\n')) {
		const text = line.trim()
		if (text === '') continue
		if (!detailed) {
			rows.push({ name: text })
			continue
		}
		const [name, oid, upstream, head, date] = text.split(FIELD)
		if (name === undefined || name === '') continue
		rows.push({
			name,
			oid: oid ?? '',
			upstream: upstream ?? '',
			current: head === '*',
			date: date ?? '',
		})
	}
	return rows
}

/** Switch branches, refusing a dirty work tree the way git itself would. */
async function checkout(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const target = request.name
	if (typeof target !== 'string' || target === '' || target.length > 512 || target.startsWith('-')) {
		throw new PanelError('bad-ref', '分支名不合法')
	}
	const result = await runGit(cwd, ['checkout', target], { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	if (result.exitCode !== 0) {
		throw new PanelError('checkout-failed', result.stderr.trim() || result.stdout.trim() || 'git checkout failed')
	}
	return settleStatus(cwd, signal, { ok: true, action: 'checkout', name: target })
}

/** Stash the work tree (untracked included) or pop the newest entry. */
async function stash(cwd, request, signal) {
	const repository = await locateRepository(cwd, signal)
	if (repository.repo !== true) throw new PanelError('no-repo', 'not a Git work tree')
	const message = typeof request.message === 'string' && request.message.trim() !== '' ? request.message.trim() : ''
	const args = request.mode === 'pop' ? ['stash', 'pop'] : ['stash', 'push', '--include-untracked']
	if (request.mode !== 'pop' && message !== '') args.push('-m', message)
	const result = await runGit(cwd, args, { signal, readOnly: false, timeoutMs: WRITE_TIMEOUT_MS })
	if (result.exitCode !== 0) {
		throw new PanelError('stash-failed', result.stderr.trim() || result.stdout.trim() || 'git stash failed')
	}
	return settleStatus(cwd, signal, { ok: true, action: 'stash', mode: request.mode ?? 'push', summary: result.stdout.trim() })
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

/** Every action this route accepts. */
const ACTIONS = new Map([
	['meta', 'read'],
	['status', 'read'],
	['graph', 'read'],
	['diff', 'read'],
	['commitDetail', 'read'],
	['branches', 'read'],
	['stage', 'write'],
	['unstage', 'write'],
	['discard', 'write'],
	['resolve', 'write'],
	['commit', 'write'],
	['undoCommit', 'write'],
	['network', 'write'],
	['checkout', 'write'],
	['stash', 'write'],
])

/**
 * Dispatch one request.
 * @param {object} request - parsed body.
 * @param {AbortSignal} signal - request signal.
 * @returns {Promise<object>} the value to wrap in `{ ok: true, value }`.
 */
export async function perform(request, signal) {
	if (request === null || typeof request !== 'object' || Array.isArray(request)) {
		throw new PanelError('bad-request', 'body must be a JSON object')
	}
	const action = String(request.action ?? '')
	if (!ACTIONS.has(action)) throw new PanelError('bad-action', `unknown action: ${action}`)
	// `meta` is fixed for the lifetime of the process and takes no `cwd`: the
	// browser asks for it before it knows where to point the panel.
	if (action === 'meta') return { fallback: PLUGIN_REPO_ROOT }
	const cwd = readCwd(request.cwd)

	switch (action) {
		case 'status':
			return readStatus(cwd, signal, request.force === true)
		case 'graph':
			return readGraph(cwd, { limit: request.limit, all: request.all === true, signal })
		case 'diff':
			return readDiff(cwd, request, signal)
		case 'commitDetail': {
			if (typeof request.hash !== 'string' || !/^[0-9a-f]{4,64}$/iu.test(request.hash)) {
				throw new PanelError('bad-ref', 'hash 不合法')
			}
			return readCommit(cwd, request.hash, signal)
		}
		case 'branches':
			return branches(cwd, request, signal)
		case 'resolve':
			return resolveConflict(cwd, request, signal)
		case 'stage':
			return stage(cwd, request, signal)
		case 'unstage':
			return unstage(cwd, request, signal)
		case 'discard':
			return discard(cwd, request, signal)
		case 'commit':
			return commit(cwd, request, signal)
		case 'undoCommit':
			return undoCommit(cwd, request, signal)
		case 'network':
			return network(cwd, request, signal)
		case 'checkout':
			return checkout(cwd, request, signal)
		case 'stash':
			return stash(cwd, request, signal)
		default:
			throw new PanelError('bad-action', `unknown action: ${action}`)
	}
}

/** Success envelope. */
function ok(value) {
	return { ok: true, value }
}

/** Failure envelope; `code` is what the browser translates. */
function fail(error) {
	const known = error instanceof PanelError
	return {
		ok: false,
		error: {
			code: known ? error.code : 'failed',
			message: error instanceof Error ? error.message : String(error),
			details: known ? (error.details ?? {}) : {},
		},
	}
}

/**
 * Mount the route. Everything that touches a repository lives behind this one
 * authenticated POST, so a browser cannot ask for anything else.
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
	ctx.inject(['connection'], (scoped) => {
		const connection = scoped.get('connection')
		if (connection === undefined || connection === null) return
		const routes = connection.fetch
		if (routes === undefined || routes === null || typeof routes.register !== 'function') return

		scoped.effect(
			() =>
				routes.register({
					path: ROUTE,
					methods: ['POST'],
					requestBody: 'buffered',
					fetch: async (request) => {
						let payload
						try {
							payload = await request.json()
						} catch {
							return Response.json(fail(new PanelError('bad-request', 'body must be JSON')))
						}
						try {
							return Response.json(ok(await perform(payload, request.signal)))
						} catch (error) {
							return Response.json(fail(error))
						}
					},
				}),
			'git-panel: /api/git-panel route',
		)
	})
}

/** Test seams: the pure decisions, without the HTTP shell. */
export const __internals = {
	PanelError,
	commitFiles,
	containedPath,
	containedPaths,
	lettersOf,
	locateRepository,
	parseDecorations,
	parseGraph,
	parseNumstat,
	parseRefList,
	parseStatus,
	perform,
	readCwd,
	runGit,
}
