/**
 * The rewind engine: capture pre-images, plan a revert, apply it, undo it.
 *
 * This module knows nothing about DSH events or HTTP; `lib/index.js` wires the
 * Host hooks to it and `test/` drives it against real temporary directories.
 *
 * Semantics in one paragraph: every record names one file, the turn and tool
 * call that changed it, and the *pre-image* (`before`) plus the resulting
 * content (`after`). Reverting to the start of turn `T` takes, for every path
 * touched at or after `T`, the **earliest** pre-image of that range and writes
 * it back — one write per file, no replay, no full-workspace snapshot. A path
 * whose current content no longer matches the last recorded `after` was edited
 * outside the agent, so it is reported as a conflict and skipped by default.
 *
 * @module dsh-rewind/engine
 */

import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
	appendLine,
	displayPath,
	excluded,
	listDir,
	metadataOnly,
	putBlob,
	readBlob,
	readCapped,
	readLines,
	removeFile,
	removeTree,
	sha256,
	sessionDir,
	writeJson,
	writeAtomic,
} from './store.js'

/** Default configuration, matching the guidance shipped with the plugin. */
export const DEFAULTS = Object.freeze({
	enabled: true,
	granularity: 'turn',
	maxFileBytes: 2 * 1024 * 1024,
	maxTurnsPerSession: 500,
	maxEditsPerSession: 2000,
	globalBudgetBytes: 4 * 1024 * 1024 * 1024,
	retentionDays: 180,
	gcWatermark: 0.8,
	gcGraceMs: 24 * 60 * 60 * 1000,
	allowOutsideWorkspace: false,
	excludePaths: [
		'.git',
		'node_modules',
		'dist',
		'build',
		'.next',
		'.turbo',
		'coverage',
		'.venv',
		'__pycache__',
		'.pnpm-store',
	],
	excludePatterns: ['.env', '.env.*', '*.pem', '*.key', '*.p12', 'id_*', '.npmrc', '.netrc'],
	metadataOnlyPatterns: [
		'*.lock',
		'package-lock.json',
		'pnpm-lock.yaml',
		'yarn.lock',
		'*.min.js',
		'*.min.css',
		'*.map',
		'*.png',
		'*.jpg',
		'*.jpeg',
		'*.gif',
		'*.webp',
		'*.pdf',
		'*.zip',
		'*.mp4',
	],
})

/**
 * Merge a partial configuration over the defaults, validating the few values a
 * user can get dangerously wrong.
 *
 * @param {object} [overrides] - user configuration.
 * @returns {object} a frozen configuration.
 */
export function resolveConfig(overrides = {}) {
	const merged = { ...DEFAULTS, ...overrides }
	if (merged.granularity !== 'turn' && merged.granularity !== 'edit') {
		throw new Error(`dsh-rewind: granularity must be "turn" or "edit", got ${JSON.stringify(merged.granularity)}`)
	}
	for (const key of ['maxFileBytes', 'maxTurnsPerSession', 'maxEditsPerSession', 'globalBudgetBytes']) {
		if (!Number.isFinite(merged[key]) || merged[key] <= 0) {
			throw new Error(`dsh-rewind: ${key} must be a positive number`)
		}
	}
	return Object.freeze(merged)
}

/**
 * The current on-disk state of one path, reduced to the shape a record stores.
 *
 * @param {string} absolute - file to inspect.
 * @param {number} maxBytes - capture cap.
 * @returns {Promise<{kind: 'absent'} | {kind: 'meta', size: number} | {kind: 'file', sha: string, size: number, mode: number}>}
 */
async function stateOf(absolute, maxBytes) {
	const read = await readCapped(absolute, maxBytes)
	if (read.kind === 'absent') return { kind: 'absent' }
	if (read.kind === 'oversized') return { kind: 'meta', size: read.size }
	return { kind: 'file', sha: sha256(read.bytes), size: read.bytes.length, mode: read.mode }
}

/**
 * Whether two states are known to describe the same content.
 *
 * @param {object | undefined} a - one state.
 * @param {object | undefined} b - the other.
 * @returns {boolean} true only when both are known and equal.
 */
export function sameState(a, b) {
	if (a === undefined || b === undefined) return false
	if (a.kind !== b.kind) return false
	if (a.kind === 'file') return a.sha === b.sha
	if (a.kind === 'absent') return true
	return a.size === b.size
}

/** One session's in-memory index, rebuilt from the turn files on first use. */
class SessionIndex {
	constructor() {
		this.loaded = false
		this.turns = new Map()
		this.lastByPath = new Map()
		this.all = []
		this.count = 0
		this.lastAt = 0
	}
}

/** A rewind store over one storage root. */
export class RewindStore {
	/**
	 * @param {object} options - constructor options.
	 * @param {string} options.root - storage root.
	 * @param {object} options.config - resolved configuration.
	 * @param {() => number} [options.now] - clock seam for tests.
	 */
	constructor({ root, config, now = () => Date.now() }) {
		this.root = root
		this.config = config
		this.now = now
		this.indexes = new Map()
		this.pending = new Map()
	}

	/** Directory of one session. */
	dir(sessionId) {
		return sessionDir(this.root, sessionId)
	}

	/** Path of one turn's record file. */
	turnFile(sessionId, turn) {
		return join(this.dir(sessionId), 'turns', `${String(turn).padStart(4, '0')}.ndjson`)
	}

	/** Path of one applied revert plan. */
	revertFile(sessionId, revertId) {
		return join(this.dir(sessionId), 'reverts', `${revertId}.json`)
	}

	/** Index of one session, loading it on first use. */
	async index(sessionId) {
		let index = this.indexes.get(sessionId)
		if (index === undefined) {
			index = new SessionIndex()
			this.indexes.set(sessionId, index)
		}
		if (index.loaded) return index
		index.loaded = true
		const turnsDir = join(this.dir(sessionId), 'turns')
		const names = (await listDir(turnsDir)).filter((name) => name.endsWith('.ndjson')).sort()
		for (const name of names) {
			const turn = Number.parseInt(name, 10)
			for (const record of await readLines(join(turnsDir, name))) {
				this.absorb(index, record)
			}
		}
		return index
	}

	/** Fold one record into an index. */
	absorb(index, record) {
		let turn = index.turns.get(record.turn)
		if (turn === undefined) {
			turn = { paths: new Set(), first: record.ts, last: record.ts }
			index.turns.set(record.turn, turn)
		}
		turn.paths.add(record.path)
		turn.last = Math.max(turn.last, record.ts ?? 0)
		index.lastByPath.set(record.path, record)
		index.all.push(record)
		index.count += 1
		index.lastAt = Math.max(index.lastAt, record.ts ?? 0)
	}

	/** Record this session's working directory once. */
	async ensureSession(sessionId, base) {
		const dir = this.dir(sessionId)
		const path = join(dir, 'meta.json')
		try {
			await stat(path)
			return
		} catch {
			/* first write of this session */
		}
		await writeJson(path, { version: 1, sessionId, base, createdAt: this.now() })
	}

	/** Drop in-memory state for a disposed session. */
	forget(sessionId) {
		this.indexes.delete(sessionId)
		for (const key of [...this.pending.keys()]) {
			if (key.startsWith(`${sessionId}\u0000`)) this.pending.delete(key)
		}
	}

	/**
	 * Capture the pre-image of one path, before the tool writes it.
	 *
	 * @param {object} input - capture request.
	 * @param {string} input.sessionId - owning session.
	 * @param {string} input.base - session working directory, for display paths.
	 * @param {string} input.path - canonical absolute target.
	 * @param {string} input.tool - tool name that is about to write.
	 * @param {string} input.callId - tool call identity.
	 * @param {number} input.turn - turn number.
	 * @returns {Promise<boolean>} whether anything was captured.
	 */
	async capture({ sessionId, base, path, tool, callId, turn }) {
		if (!this.config.enabled) return false
		if (excluded(path, base, this.config)) return false
		const index = await this.index(sessionId)
		const already = this.config.granularity === 'turn' && index.turns.get(turn)?.paths.has(path) === true
		const key = `${sessionId}\u0000${callId}`
		let entry = this.pending.get(key)
		if (entry === undefined) {
			entry = { turn, tool, base, paths: new Map() }
			this.pending.set(key, entry)
		}
		if (entry.paths.has(path)) return false
		if (already) {
			/**
			 * The turn already holds this path's first pre-image. Only the resulting
			 * content needs to be remembered, so a later conflict check compares
			 * against what the file really looks like now.
			 */
			entry.paths.set(path, null)
			return false
		}
		let before
		if (metadataOnly(path, this.config)) {
			const info = await stat(path).catch(() => undefined)
			before = info === undefined ? { kind: 'absent' } : { kind: 'meta', size: info.size }
		} else {
			const read = await readCapped(path, this.config.maxFileBytes)
			if (read.kind === 'file') {
				const sha = await putBlob(this.root, read.bytes)
				before = { kind: 'file', sha, size: read.bytes.length, mode: read.mode }
			} else if (read.kind === 'oversized') {
				before = { kind: 'meta', size: read.size }
			} else {
				before = { kind: 'absent' }
			}
		}
		entry.paths.set(path, before)
		return true
	}

	/**
	 * Settle one tool call: turn its pending captures into records, dropping the
	 * ones the tool did not actually change.
	 *
	 * @param {object} input - settle request.
	 * @param {string} input.sessionId - owning session.
	 * @param {string} input.callId - tool call identity.
	 * @param {number} input.turn - turn number.
	 * @returns {Promise<number>} how many records were appended.
	 */
	async settle({ sessionId, callId, turn }) {
		const key = `${sessionId}\u0000${callId}`
		const entry = this.pending.get(key)
		if (entry === undefined) return 0
		this.pending.delete(key)
		const index = await this.index(sessionId)
		let written = 0
		for (const [path, before] of entry.paths) {
			const after = await stateOf(path, this.config.maxFileBytes)
			if (before === null) {
				const last = index.lastByPath.get(path)
				if (sameState(last?.after, after)) continue
				const touch = {
					v: 1,
					ts: this.now(),
					turn: entry.turn,
					call: callId,
					tool: entry.tool,
					base: entry.base,
					path,
					display: displayPath(entry.base, path),
					op: 'touch',
					before: null,
					after,
				}
				await appendLine(this.turnFile(sessionId, entry.turn), touch)
				this.absorb(index, touch)
				written += 1
				continue
			}
			if (sameState(before, after)) continue
			if (before.kind === 'meta' && after.kind === 'meta') continue
			const op = before.kind === 'absent' ? 'create' : after.kind === 'absent' ? 'delete' : 'update'
			const record = {
				v: 1,
				ts: this.now(),
				turn: entry.turn,
				call: callId,
				tool: entry.tool,
				base: entry.base,
				path,
				display: displayPath(entry.base, path),
				op,
				before,
				after,
			}
			await appendLine(this.turnFile(sessionId, entry.turn), record)
			this.absorb(index, record)
			written += 1
		}
		return written
	}

	/**
	 * Turn summaries for the UI.
	 *
	 * @param {string} sessionId - session identity.
	 * @returns {Promise<{turns: object[], total: number}>} one row per turn with records.
	 */
	async turns(sessionId) {
		const index = await this.index(sessionId)
		const turns = [...index.turns.entries()]
			.map(([turn, value]) => ({ turn, files: value.paths.size, at: value.last }))
			.sort((a, b) => b.turn - a.turn)
		return { turns, total: index.count }
	}

	/**
	 * Build a revert plan without touching the workspace.
	 *
	 * @param {string} sessionId - session identity.
	 * @param {number} targetTurn - revert to the state before this turn.
	 * @returns {Promise<object>} plan entries and their conflicts.
	 */
	async plan(sessionId, targetTurn) {
		const index = await this.index(sessionId)
		const candidates = new Map()
		for (const record of index.all) {
			if (record.before === null) continue
			if (record.turn < targetTurn) continue
			if (!candidates.has(record.path)) candidates.set(record.path, record)
		}
		const entries = []
		for (const record of candidates.values()) {
			const last = index.lastByPath.get(record.path)
			const current = await stateOf(record.path, this.config.maxFileBytes)
			const expected = last?.after
			const restorable = record.before.kind === 'file' || record.before.kind === 'absent'
			entries.push({
				path: record.path,
				display: record.display,
				op: record.op,
				before: record.before,
				expected: expected ?? null,
				current,
				conflict: expected !== undefined && !sameState(expected, current),
				restorable,
			})
		}
		entries.sort((a, b) => a.display.localeCompare(b.display))
		return {
			turn: targetTurn,
			entries,
			stats: {
				files: entries.length,
				restorable: entries.filter((entry) => entry.restorable).length,
				conflicts: entries.filter((entry) => entry.conflict).length,
			},
		}
	}

	/**
	 * Apply a plan: write pre-images back (or delete created files), and keep an
	 * undo journal so the revert itself can be reversed.
	 *
	 * A rewind is all-or-nothing: every file the plan names is written back, so
	 * there is no per-path selection. Conflicted files are still skipped unless
	 * `force` is set, because overwriting a human edit is never implied by
	 * "revert everything".
	 *
	 * @param {object} input - apply request.
	 * @param {string} input.sessionId - session identity.
	 * @param {number} input.targetTurn - revert boundary.
	 * @param {boolean} [input.force] - also overwrite conflicted paths.
	 * @returns {Promise<object>} the applied revert, including its undo id.
	 */
	async apply({ sessionId, targetTurn, force = false }) {
		const plan = await this.plan(sessionId, targetTurn)
		const journal = []
		const skipped = []
		let restored = 0
		let deleted = 0
		for (const entry of plan.entries) {
			if (!entry.restorable) {
				skipped.push({ path: entry.display, reason: 'not-restorable' })
				continue
			}
			if (entry.conflict && !force) {
				skipped.push({ path: entry.display, reason: 'conflict' })
				continue
			}
			const undo = await this.snapshotForUndo(entry.path)
			if (entry.before.kind === 'absent') {
				if (await removeFile(entry.path)) deleted += 1
				journal.push({ path: entry.path, undo, applied: 'delete' })
				continue
			}
			const bytes = await readBlob(this.root, entry.before.sha)
			await writeAtomic(entry.path, bytes, entry.before.mode ?? 0o644)
			restored += 1
			journal.push({ path: entry.path, undo, applied: 'restore' })
		}
		const revertId = randomUUID()
		await writeJson(this.revertFile(sessionId, revertId), {
			version: 1,
			id: revertId,
			sessionId,
			targetTurn,
			at: this.now(),
			entries: journal,
		})
		return {
			revertId,
			restored,
			deleted,
			skipped,
			conflicts: plan.stats.conflicts,
			files: journal.length,
		}
	}

	/** Capture the current content of one path so a revert can be undone. */
	async snapshotForUndo(path) {
		const read = await readCapped(path, this.config.maxFileBytes)
		if (read.kind === 'absent') return { kind: 'absent' }
		if (read.kind === 'oversized') return { kind: 'meta', size: read.size }
		return { kind: 'file', sha: await putBlob(this.root, read.bytes), size: read.bytes.length, mode: read.mode }
	}

	/**
	 * Reverse one applied revert.
	 *
	 * @param {string} sessionId - session identity.
	 * @param {string} revertId - journal identity.
	 * @returns {Promise<object>} counts of restored and deleted paths.
	 */
	async undo(sessionId, revertId) {
		const path = this.revertFile(sessionId, revertId)
		const journal = JSON.parse(await readFileText(path))
		if (journal.undoneAt !== undefined) throw new Error('dsh-rewind: this revert was already undone')
		let restored = 0
		let deleted = 0
		for (const entry of [...journal.entries].reverse()) {
			if (entry.undo.kind === 'absent') {
				if (await removeFile(entry.path)) deleted += 1
				continue
			}
			if (entry.undo.kind === 'meta') continue
			const bytes = await readBlob(this.root, entry.undo.sha)
			await writeAtomic(entry.path, bytes, entry.undo.mode ?? 0o644)
			restored += 1
		}
		journal.undoneAt = this.now()
		await writeJson(path, journal)
		return { restored, deleted }
	}

	/** Most recent revert that can still be undone. */
	async lastRevert(sessionId) {
		const names = (await listDir(join(this.dir(sessionId), 'reverts'))).filter((name) => name.endsWith('.json')).sort()
		for (const name of names.reverse()) {
			const id = name.slice(0, -'.json'.length)
			try {
				const journal = JSON.parse(await readFileText(this.revertFile(sessionId, id)))
				if (journal.undoneAt === undefined && journal.entries.length > 0) return { id, targetTurn: journal.targetTurn, at: journal.at }
			} catch {
				/* a torn journal is not offered */
			}
		}
		return undefined
	}

	/** Storage usage, for the card footer and the GC trigger. */
	async usage() {
		let blobs = 0
		let blobBytes = 0
		const buckets = await listDir(join(this.root, 'blobs'))
		for (const bucket of buckets) {
			for (const name of await listDir(join(this.root, 'blobs', bucket))) {
				const info = await stat(join(this.root, 'blobs', bucket, name)).catch(() => undefined)
				if (info === undefined) continue
				blobs += 1
				blobBytes += info.size
			}
		}
		let records = 0
		const sessions = []
		for (const sessionId of await listDir(join(this.root, 'sessions'))) {
			const index = await this.index(sessionId)
			sessions.push({ sessionId, records: index.count, lastAt: index.lastAt })
			records += index.count
		}
		return { blobs, blobBytes, records, sessions }
	}

	/**
	 * Delete blobs no record refers to, older than the grace period, and prune
	 * sessions past their retention window.
	 *
	 * @returns {Promise<{removedBlobs: number, removedTurns: number}>} what was freed.
	 */
	async gc() {
		const referenced = new Set()
		const sessionsDir = join(this.root, 'sessions')
		for (const sessionId of await listDir(sessionsDir)) {
			const index = await this.index(sessionId)
			for (const record of index.all) {
				if (record.before?.sha !== undefined) referenced.add(record.before.sha)
				if (record.after?.sha !== undefined) referenced.add(record.after.sha)
			}
			for (const name of await listDir(join(sessionsDir, sessionId, 'reverts'))) {
				try {
					const journal = JSON.parse(await readFileText(join(sessionsDir, sessionId, 'reverts', name)))
					for (const entry of journal.entries ?? []) {
						if (entry.undo?.sha !== undefined) referenced.add(entry.undo.sha)
					}
				} catch {
					/* ignore a torn journal */
				}
			}
		}
		let removedBlobs = 0
		for (const bucket of await listDir(join(this.root, 'blobs'))) {
			for (const name of await listDir(join(this.root, 'blobs', bucket))) {
				const full = join(this.root, 'blobs', bucket, name)
				if (referenced.has(`${bucket}${name}`)) continue
				const info = await stat(full).catch(() => undefined)
				if (info === undefined) continue
				if (Math.max(0, this.now() - info.mtimeMs) < this.config.gcGraceMs) continue
				await removeFile(full).catch(() => false)
				removedBlobs += 1
			}
		}
		const removedTurns = await this.prune()
		return { removedBlobs, removedTurns }
	}

	/** Drop whole sessions past the retention window, and the oldest turns past the cap. */
	async prune() {
		const cutoff = this.now() - this.config.retentionDays * 24 * 60 * 60 * 1000
		let removed = 0
		for (const sessionId of await listDir(join(this.root, 'sessions'))) {
			const index = await this.index(sessionId)
			if (index.lastAt !== 0 && index.lastAt < cutoff) {
				await removeTree(this.dir(sessionId))
				this.indexes.delete(sessionId)
				removed += 1
				continue
			}
			const turnsDir = join(this.dir(sessionId), 'turns')
			const files = (await listDir(turnsDir)).filter((name) => name.endsWith('.ndjson')).sort()
			const excess = files.length - this.config.maxTurnsPerSession
			if (excess > 0) {
				for (const name of files.slice(0, excess)) await removeFile(join(turnsDir, name))
				this.indexes.delete(sessionId)
				removed += excess
			}
			const reloaded = await this.index(sessionId)
			if (reloaded.count <= this.config.maxEditsPerSession) continue
			const oldest = [...reloaded.turns.entries()].sort((a, b) => a[0] - b[0])
			let count = reloaded.count
			for (const [turn] of oldest) {
				if (count <= this.config.maxEditsPerSession) break
				const name = `${String(turn).padStart(4, '0')}.ndjson`
				await removeFile(join(turnsDir, name))
				count -= reloaded.turns.get(turn)?.paths.size ?? 0
				removed += 1
			}
			this.indexes.delete(sessionId)
		}
		return removed
	}

	/**
	 * Keep the store inside its global budget: drop the least recently used
	 * sessions until the blob store is back under the watermark, then sweep.
	 *
	 * @returns {Promise<{droppedSessions: number, blobBytes: number}>} what happened.
	 */
	async enforceBudget() {
		let usage = await this.usage()
		if (usage.blobBytes <= this.config.globalBudgetBytes * this.config.gcWatermark) {
			return { droppedSessions: 0, blobBytes: usage.blobBytes }
		}
		let dropped = 0
		const sessions = [...usage.sessions].sort((a, b) => a.lastAt - b.lastAt)
		for (const session of sessions) {
			if (usage.blobBytes <= this.config.globalBudgetBytes * this.config.gcWatermark) break
			await removeTree(this.dir(session.sessionId))
			this.indexes.delete(session.sessionId)
			dropped += 1
			await this.gc()
			usage = await this.usage()
		}
		return { droppedSessions: dropped, blobBytes: usage.blobBytes }
	}
}

/** Read a small UTF-8 file, used for revert journals. */
async function readFileText(path) {
	return readFile(path, 'utf8')
}
