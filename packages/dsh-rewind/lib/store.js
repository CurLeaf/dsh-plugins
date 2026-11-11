/**
 * Storage primitives for `dsh-rewind`.
 *
 * The whole point of this module is to keep the on-disk footprint proportional
 * to *what the agent changed*, never to the size of the workspace:
 *
 *   blobs/<aa>/<rest-of-sha256>     content-addressed pre-images, shared by every
 *                                   session and every turn
 *   sessions/<id>/meta.json         working directory and bookkeeping
 *   sessions/<id>/turns/<t>.ndjson  one appended line per settled file mutation
 *   sessions/<id>/reverts/<id>.json plans that were applied (undoable)
 *   sessions/<id>/pending/<call>.json
 *                                   captures of a tool call that has not settled
 *
 * A capture happens *before* the write (the `fs/*-intent` waterfall awaits it),
 * so the bytes stored here are always the pre-image the tool is about to
 * replace. A crash leaves at most one pending file and some unreferenced
 * blobs; both are collected later and neither can corrupt a record.
 *
 * @module dsh-rewind/store
 */

import { createHash, randomUUID } from 'node:crypto'
import {
	chmod,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'

/** Format version of the on-disk layout; bump only with a migration. */
export const FORMAT = 1

/** Directory permission for everything the plugin creates. */
const DIR_MODE = 0o700

/** File permission for every blob, record and plan. */
const FILE_MODE = 0o600

/**
 * Resolve the plugin's storage root: `$DSH_HOME/storages/dsh-rewind`, which is
 * `~/.dsh/storages/dsh-rewind` for every normal install.
 *
 * @param {string | undefined} home - `DSH_HOME` when the caller resolved it.
 * @returns {string} absolute storage root.
 */
export function storageRoot(home) {
	const base = home !== undefined && home.trim() !== '' ? home : join(process.env.HOME ?? '.', '.dsh')
	return join(base, 'storages', 'dsh-rewind')
}

/**
 * Content address of one byte string.
 *
 * @param {Buffer | Uint8Array} bytes - content.
 * @returns {string} lowercase hex sha256.
 */
export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Write a file atomically: full content to a temp sibling, then rename.
 *
 * @param {string} path - destination.
 * @param {string | Uint8Array} data - content.
 * @param {number} [mode] - permission bits.
 * @returns {Promise<void>} after the rename.
 */
export async function writeAtomic(path, data, mode = FILE_MODE) {
	await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
	const temp = `${path}.${randomUUID()}.tmp`
	await writeFile(temp, data, { mode })
	await chmod(temp, mode)
	await rename(temp, path)
}

/**
 * Read a file with a byte cap, without ever buffering more than the cap.
 *
 * @param {string} absolute - file to read.
 * @param {number} maxBytes - inclusive cap.
 * @returns {Promise<{kind: 'absent'} | {kind: 'oversized', size: number} | {kind: 'file', bytes: Buffer, mode: number}>}
 *   the pre-image shape every record uses.
 */
export async function readCapped(absolute, maxBytes) {
	let handle
	try {
		handle = await open(absolute, 'r')
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { kind: 'absent' }
		throw error
	}
	try {
		const info = await handle.stat()
		if (!info.isFile()) return { kind: 'oversized', size: info.size }
		if (info.size > maxBytes) return { kind: 'oversized', size: info.size }
		const buffer = Buffer.allocUnsafe(info.size)
		let read = 0
		while (read < info.size) {
			const { bytesRead } = await handle.read(buffer, read, info.size - read, read)
			if (bytesRead === 0) break
			read += bytesRead
		}
		return { kind: 'file', bytes: buffer.subarray(0, read), mode: info.mode & 0o777 }
	} finally {
		await handle.close()
	}
}

/**
 * Store bytes as a blob and return their address. Identical content is written
 * once: the rename is idempotent because the target name *is* the digest.
 *
 * @param {string} root - storage root.
 * @param {Buffer} bytes - content.
 * @returns {Promise<string>} sha256 address.
 */
export async function putBlob(root, bytes) {
	const sha = sha256(bytes)
	const target = blobPath(root, sha)
	try {
		const existing = await stat(target)
		if (existing.isFile() && existing.size === bytes.length) return sha
	} catch {
		/* not there yet: fall through and write it */
	}
	await writeAtomic(target, bytes)
	return sha
}

/**
 * Absolute path of one blob.
 *
 * @param {string} root - storage root.
 * @param {string} sha - hex digest.
 * @returns {string} path under `blobs/<aa>/`.
 */
export function blobPath(root, sha) {
	return join(root, 'blobs', sha.slice(0, 2), sha.slice(2))
}

/**
 * Read one blob back.
 *
 * @param {string} root - storage root.
 * @param {string} sha - hex digest.
 * @returns {Promise<Buffer>} its bytes.
 */
export async function readBlob(root, sha) {
	return readFile(blobPath(root, sha))
}

/**
 * Append one JSON line to a file, creating it on first use.
 *
 * @param {string} path - record file.
 * @param {object} value - serializable record.
 * @returns {Promise<void>} after the append.
 */
export async function appendLine(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
	const line = `${JSON.stringify(value)}\n`
	const handle = await open(path, 'a', FILE_MODE)
	try {
		await handle.appendFile(line)
	} finally {
		await handle.close()
	}
}

/**
 * Read every record of a turn file, skipping torn last lines.
 *
 * @param {string} path - record file.
 * @returns {Promise<object[]>} parsed records in append order.
 */
export async function readLines(path) {
	let text
	try {
		text = await readFile(path, 'utf8')
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
		throw error
	}
	const out = []
	for (const line of text.split('\n')) {
		if (line === '') continue
		try {
			out.push(JSON.parse(line))
		} catch {
			/* a torn line from a crash is not a record */
		}
	}
	return out
}

/**
 * Write one JSON document atomically.
 *
 * @param {string} path - destination.
 * @param {unknown} value - serializable value.
 * @returns {Promise<void>} after the rename.
 */
export async function writeJson(path, value) {
	await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Match a basename against the tiny glob vocabulary the config uses: `*`, `?`
 * and literal text. Patterns are compared case-insensitively on macOS and
 * Windows, exactly like the shells those users expect.
 *
 * @param {string} name - basename.
 * @param {string} pattern - glob such as `*.lock` or `.env.*`.
 * @returns {boolean} whether it matches.
 */
export function matchesGlob(name, pattern) {
	const source = pattern
		.split('')
		.map((character) => {
			if (character === '*') return '.*'
			if (character === '?') return '.'
			return character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		})
		.join('')
	const flags = process.platform === 'darwin' || process.platform === 'win32' ? 'i' : ''
	return new RegExp(`^${source}$`, flags).test(name)
}

/**
 * Whether a path is excluded from capture entirely.
 *
 * @param {string} absolute - canonical absolute path.
 * @param {string} base - session working directory.
 * @param {object} config - plugin configuration.
 * @returns {boolean} true when the path must not be captured.
 */
export function excluded(absolute, base, config) {
	const rel = relative(base, absolute)
	if (rel.startsWith('..') || isAbsolute(rel)) {
		return config.allowOutsideWorkspace !== true
	}
	const segments = rel.split(sep)
	for (const name of config.excludePaths) {
		if (segments.includes(name)) return true
	}
	const basename = segments.at(-1) ?? ''
	return config.excludePatterns.some((pattern) => matchesGlob(basename, pattern))
}

/**
 * Whether a path should be recorded without its content (lock files, media,
 * build output). Reverting such a path is impossible by design: the plan marks
 * it and the UI refuses it instead of silently doing nothing.
 *
 * @param {string} absolute - canonical absolute path.
 * @param {object} config - plugin configuration.
 * @returns {boolean} true when only metadata is recorded.
 */
export function metadataOnly(absolute, config) {
	const basename = absolute.split(sep).at(-1) ?? ''
	return config.metadataOnlyPatterns.some((pattern) => matchesGlob(basename, pattern))
}

/**
 * Delete a path, tolerating a file that is already gone.
 *
 * @param {string} absolute - file to remove.
 * @returns {Promise<boolean>} whether something was removed.
 */
export async function removeFile(absolute) {
	try {
		await unlink(absolute)
		return true
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false
		throw error
	}
}

/**
 * Recursively delete a directory, tolerating its absence.
 *
 * @param {string} path - directory.
 * @returns {Promise<void>} after removal.
 */
export async function removeTree(path) {
	await rm(path, { recursive: true, force: true })
}

/**
 * List directory entries, treating a missing directory as empty.
 *
 * @param {string} path - directory.
 * @returns {Promise<string[]>} entry names.
 */
export async function listDir(path) {
	try {
		return await readdir(path)
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
		throw error
	}
}

/**
 * Make a path relative to a base for display, keeping `..` for outsiders.
 *
 * @param {string} base - session working directory.
 * @param {string} absolute - canonical absolute path.
 * @returns {string} display path with forward slashes.
 */
export function displayPath(base, absolute) {
	const rel = relative(base, absolute)
	return (rel === '' ? '.' : rel).split(sep).join('/')
}

/**
 * Resolve a session's directory.
 *
 * @param {string} root - storage root.
 * @param {string} sessionId - session identity.
 * @returns {string} absolute directory.
 */
export function sessionDir(root, sessionId) {
	return join(root, 'sessions', sessionId)
}

/**
 * Canonical absolute path for a resolved filesystem target.
 *
 * @param {string} path - possibly relative path.
 * @returns {string} absolute path without a trailing separator.
 */
export function absolutePath(path) {
	return resolve(path)
}
