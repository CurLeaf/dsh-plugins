/**
 * `dsh-cursor-bridge` — project-local Cursor assets as DSH skills.
 *
 * One `ctx.skills` provider that projects two kinds of `.cursor` content into
 * the shared skill catalog, so both land in the composer's `/` menu:
 *
 *   `.cursor/skills/<name>/SKILL.md`  → a normal project skill
 *   `.cursor/commands/<id>.md`        → a user-invocable "prompt skill"
 *
 * Commands are projected as skills on purpose: a command body may reference
 * sibling commands (`/platform-integration` → `/platform-prepare`), and only a
 * model-invocable skill lets the model load that sibling itself. With
 * `commandModelInvocable: false` the commands stay user-only and cost nothing
 * in the model catalog.
 *
 * No runtime dependencies: the frontmatter subset Cursor writes (top-level
 * scalars plus `|` / `>` block scalars) is parsed here rather than pulling in a
 * YAML engine, so this package can be `link:`-ed without an install step.
 *
 * @module dsh-cursor-bridge
 */

import { watch as watchFs } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** kebab-case grammar the skill registry enforces. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Precedence: under project `.dsh/skills` (100) and `.agents/skills` (200), over `custom` (300). */
const DEFAULT_RANK = 250

const DEFAULT_SKILL_ROOTS = ['.cursor/skills', '.claude/skills']
const DEFAULT_COMMAND_ROOTS = ['.cursor/commands', '.claude/commands']

const DEFAULT_WATCH_POLL_INTERVAL_MS = 2000
const DEFAULT_WATCH_MAX_ROOTS = 64
const INVALIDATE_DEBOUNCE_MS = 120

const name = 'cursor-bridge'
const inject = ['skills']

/**
 * Normalize user configuration. Deliberately schema-free: the plugin has no
 * dependency on `@deepseek-ai/schemastery`, and every field is optional.
 * @param config - raw plugin config from the loader.
 */
function normalizeConfig(config) {
	const raw = config ?? {}
	return {
		providerName: nonEmpty(raw.providerName) ?? 'cursor',
		skillRoots: dirList(raw.skillRoots, DEFAULT_SKILL_ROOTS),
		commandRoots: dirList(raw.commandRoots, DEFAULT_COMMAND_ROOTS),
		rank: Number.isFinite(raw.rank) ? raw.rank : DEFAULT_RANK,
		commandRankOffset: Number.isFinite(raw.commandRankOffset) ? raw.commandRankOffset : 10,
		commandModelInvocable: raw.commandModelInvocable !== false,
		watch: raw.watch !== false,
		debug: raw.debug === true,
		debugCwd: nonEmpty(raw.debugCwd),
		watchPollIntervalMs: positive(raw.watchPollIntervalMs) ?? DEFAULT_WATCH_POLL_INTERVAL_MS,
		watchMaxRoots: positive(raw.watchMaxRoots) ?? DEFAULT_WATCH_MAX_ROOTS,
	}
}

function nonEmpty(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function positive(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function dirList(value, fallback) {
	if (!Array.isArray(value)) return [...fallback]
	const kept = value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
	return kept.length > 0 ? kept : [...fallback]
}

/**
 * Parse the YAML subset Cursor frontmatter uses.
 *
 * Supported: `key: scalar`, quoted scalars, `key: |` and `key: >` (with `-`
 * chomping), and `#` comments outside quotes. Anything else is kept verbatim as
 * a string, which is what the catalog needs — the registry only reads
 * `name`/`description`/`whenToUse`/invocation flags.
 *
 * @param text - YAML frontmatter body, without the `---` fences.
 * @returns flat record of parsed scalars.
 */
function parseYamlSubset(text) {
	const out = {}
	const lines = text.split(/\r?\n/)
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]
		if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
		if (/^\s/.test(line)) continue
		const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
		if (match === null) continue
		const key = match[1]
		const inline = match[2]
		const block = /^([|>])([+-]?)\s*(?:#.*)?$/.exec(inline)
		if (block !== null) {
			const collected = []
			for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
				const body = lines[cursor]
				if (body.trim().length === 0) {
					collected.push('')
					continue
				}
				if (!/^\s/.test(body)) break
				collected.push(body.replace(/^\s+/, ''))
				index = cursor
			}
			const joined = block[1] === '|' ? collected.join('\n') : foldLines(collected)
			out[key] = block[2] === '-' ? joined.replace(/\n+$/, '') : joined
			continue
		}
		out[key] = unquote(stripComment(inline))
	}
	return out
}

function foldLines(lines) {
	const parts = []
	for (const line of lines) {
		if (line === '') {
			parts.push('\n')
			continue
		}
		if (parts.length > 0 && parts[parts.length - 1] !== '\n') parts.push(' ')
		parts.push(line)
	}
	return parts.join('').replace(/\n /g, '\n')
}

function stripComment(value) {
	let quoted
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index]
		if (quoted !== undefined) {
			if (char === quoted) quoted = undefined
			continue
		}
		if (char === '"' || char === "'") {
			quoted = char
			continue
		}
		if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trimEnd()
	}
	return value
}

function unquote(value) {
	const trimmed = value.trim()
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replaceAll('\\"', '"')
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replaceAll("''", "'")
	}
	return trimmed
}

/**
 * Split a document into frontmatter fields and body.
 * @param raw - whole file text.
 * @returns `{ data, body }`; `data` is empty when the file has no frontmatter.
 */
function parseFrontmatter(raw) {
	const text = raw.replace(/^\uFEFF/, '')
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
	if (match === null) return { data: {}, body: text }
	return { data: parseYamlSubset(match[1]), body: text.slice(match[0].length) }
}

/**
 * Read an invocation flag the way DSH's own provider does: absent means
 * allowed, and a rejected spelling drops the entry instead of silently
 * opening an interface.
 * @returns `true`, `false`, or `undefined` when the value is unparseable.
 */
function readBoolean(value) {
	if (value === undefined) return undefined
	if (typeof value !== 'string') return value === true ? true : value === false ? false : undefined
	const lowered = value.trim().toLowerCase()
	if (['true', 'yes', 'on', '1'].includes(lowered)) return true
	if (['false', 'no', 'off', '0'].includes(lowered)) return false
	return undefined
}

/** Lowercase, replace illegal runs with `-`, and collapse them. */
function normalizeName(value) {
	return value
		.trim()
		.replace(/^\//, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

/** First non-empty, non-heading line — the description fallback for bare commands. */
function firstMeaningfulLine(body) {
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('>')) continue
		return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed
	}
	return ''
}

/**
 * Nearest ancestor holding `.git`; the same project-root rule DSH's own
 * filesystem provider uses. Falls back to `cwd` when no marker exists.
 * @param cwd - lookup directory.
 */
async function findProjectRoot(cwd) {
	let current = resolve(cwd)
	for (;;) {
		try {
			await stat(join(current, '.git'))
			return current
		} catch {
			const parent = dirname(current)
			if (parent === current) return resolve(cwd)
			current = parent
		}
	}
}

async function readDirSafe(path) {
	try {
		return await readdir(path, { withFileTypes: true })
	} catch {
		return []
	}
}

async function exists(path) {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/**
 * Skill provider that projects project-local Cursor/Claude Markdown into the
 * DSH skill catalog.
 */
export class CursorBridgeProvider {
	#ctx
	#control
	#config
	#watch = new Map()
	#pollTimers = new Map()
	#disposed = false
	#pendingInvalidate

	constructor(ctx, control, config) {
		this.#ctx = ctx
		this.#control = control
		this.#config = config
	}

	get name() {
		return this.#config.providerName
	}

	/** Roots to scan for one lookup cwd, in precedence order. */
	async roots(cwd) {
		const projectRoot = await findProjectRoot(cwd)
		const skills = this.#config.skillRoots.map((relative, index) => ({
			path: join(projectRoot, relative),
			source: sourceLabel(relative, 'skill'),
			rank: this.#config.rank + index,
			kind: 'skill',
		}))
		const commands = this.#config.commandRoots.map((relative, index) => ({
			path: join(projectRoot, relative),
			source: sourceLabel(relative, 'command'),
			rank: this.#config.rank + this.#config.commandRankOffset + index,
			kind: 'command',
		}))
		return [...skills, ...commands]
	}

	async list(options = {}) {
		const roots = await this.roots(options.cwd ?? process.cwd())
		let complete = true
		if (this.#config.watch) {
			try {
				await this.#observe(roots)
			} catch {
				complete = false
			}
		}
		const candidates = []
		for (const root of roots) {
			const found = root.kind === 'skill' ? await this.#discoverSkills(root) : await this.#discoverCommands(root)
			for (const candidate of found) candidates.push(candidate)
		}
		return complete ? candidates : { candidates, complete }
	}

	async get(candidate, options = {}) {
		if (options.signal?.aborted === true) return undefined
		const path = candidate.locator?.path
		if (typeof path !== 'string') return undefined
		let raw
		try {
			raw = await readFile(path, 'utf8')
		} catch {
			return undefined
		}
		const { data, body } = parseFrontmatter(raw)
		const kind = candidate.locator?.kind ?? 'skill'
		const parsed =
			kind === 'command' ? commandFields(path, data, body, candidate.invocation?.modelInvocable !== false) : skillFields(data, body)
		if (parsed === undefined) return undefined
		return {
			name: parsed.name,
			description: parsed.description,
			...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
			invocation: parsed.invocation,
			source: candidate.source,
			provider: candidate.provider,
			resourceBase: candidate.resourceBase,
			path,
			content: parsed.content,
		}
	}

	async #discoverSkills(root) {
		const entries = (await readDirSafe(root.path)).sort((left, right) => left.name.localeCompare(right.name))
		const candidates = []
		for (const entry of entries) {
			const isDirectory = entry.isDirectory() || entry.isSymbolicLink()
			if (!isDirectory) continue
			const directory = join(root.path, entry.name)
			const path = join(directory, 'SKILL.md')
			let raw
			try {
				raw = await readFile(path, 'utf8')
			} catch {
				continue
			}
			const { data, body } = parseFrontmatter(raw)
			const parsed = skillFields(data, body, entry.name)
			if (parsed === undefined) continue
			candidates.push({
				name: parsed.name,
				description: parsed.description,
				...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
				invocation: parsed.invocation,
				provider: this.name,
				source: root.source,
				rank: root.rank,
				locator: { path, directory, kind: 'skill' },
				resourceBase: { kind: 'directory', path: directory },
				path,
				...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
			})
		}
		return candidates
	}

	async #discoverCommands(root) {
		const entries = (await readDirSafe(root.path)).sort((left, right) => left.name.localeCompare(right.name))
		const candidates = []
		for (const entry of entries) {
			if (!entry.isFile() && !entry.isSymbolicLink()) continue
			if (!entry.name.endsWith('.md')) continue
			const path = join(root.path, entry.name)
			let raw
			try {
				raw = await readFile(path, 'utf8')
			} catch {
				continue
			}
			const { data, body } = parseFrontmatter(raw)
			const parsed = commandFields(path, data, body, this.#config.commandModelInvocable)
			if (parsed === undefined) continue
			candidates.push({
				name: parsed.name,
				description: parsed.description,
				invocation: parsed.invocation,
				provider: this.name,
				source: root.source,
				rank: root.rank,
				locator: { path, directory: root.path, kind: 'command' },
				resourceBase: { kind: 'directory', path: root.path },
				path,
			})
		}
		return candidates
	}

	async #observe(roots) {
		const known = new Set(roots.map((root) => root.path))
		for (const [path, handle] of this.#watch) {
			if (known.has(path)) continue
			handle.close()
			this.#watch.delete(path)
		}
		for (const path of [...this.#pollTimers.keys()]) {
			if (!known.has(path)) this.#stopPolling(path)
		}
		for (const root of roots) {
			if (this.#watch.has(root.path)) continue
			if (await exists(root.path)) this.#attach(root.path, root.kind)
			else this.#pollForCreation(root.path, root.kind)
		}
	}

	/**
	 * Watch one root and invalidate only for events that can change the catalog.
	 * The skill bundle in this repo carries a 2 MB `.cache/`, so an unfiltered
	 * recursive watcher would invalidate the whole registry on every query.
	 * @param path - root directory.
	 * @param kind - `skill` or `command`, deciding which relative paths matter.
	 */
	#attach(path, kind) {
		if (this.#disposed) return
		this.#stopPolling(path)
		if (this.#watch.size >= this.#config.watchMaxRoots) return
		const onChange = (eventType, filename) => {
			if (isCatalogEvent(kind, filename)) this.#invalidateSoon()
		}
		let handle
		try {
			handle = watchFs(path, { recursive: true }, onChange)
		} catch {
			handle = watchFs(path, onChange)
		}
		handle.on?.('error', () => {
			handle.close()
			this.#watch.delete(path)
		})
		this.#watch.set(path, handle)
	}

	#pollForCreation(path, kind) {
		if (this.#pollTimers.has(path)) return
		const timer = setInterval(async () => {
			if (this.#disposed) return
			if (!(await exists(path))) return
			this.#stopPolling(path)
			this.#attach(path, kind)
			this.#invalidateSoon()
		}, this.#config.watchPollIntervalMs)
		timer.unref?.()
		this.#pollTimers.set(path, timer)
	}

	#stopPolling(path) {
		const timer = this.#pollTimers.get(path)
		if (timer === undefined) return
		clearInterval(timer)
		this.#pollTimers.delete(path)
	}

	#invalidateSoon() {
		if (this.#disposed) return
		if (this.#pendingInvalidate !== undefined) return
		this.#pendingInvalidate = setTimeout(() => {
			this.#pendingInvalidate = undefined
			if (!this.#disposed) this.#control.invalidate()
		}, INVALIDATE_DEBOUNCE_MS)
		this.#pendingInvalidate.unref?.()
	}

	/** Release every watcher and timer. Safe to call twice. */
	dispose() {
		if (this.#disposed) return
		this.#disposed = true
		if (this.#pendingInvalidate !== undefined) {
			clearTimeout(this.#pendingInvalidate)
			this.#pendingInvalidate = undefined
		}
		for (const handle of this.#watch.values()) {
			try {
				handle.close()
			} catch {}
		}
		this.#watch.clear()
		for (const path of [...this.#pollTimers.keys()]) this.#stopPolling(path)
	}
}

/**
 * Whether a watched event can change the catalog.
 * @param kind - root kind.
 * @param filename - relative path of the changed entry, when the platform reports it.
 */
function isCatalogEvent(kind, filename) {
	if (typeof filename !== 'string' || filename.length === 0) return true
	const relative = filename.split(sep).join('/')
	if (kind === 'command') return /^[^/]+\.md$/.test(relative)
	return /^[^/]+\/SKILL\.md$/.test(relative)
}

function sourceLabel(relative, kind) {
	const top = relative.split(/[\\/]/).filter(Boolean)[0] ?? 'project'
	const family = top.replace(/^\./, '')
	return kind === 'command' ? `project-${family}-command` : `project-${family}`
}

/** Parse a `SKILL.md` into catalog fields, or `undefined` when it is unusable. */
function skillFields(data, body, fallbackName) {
	const declared = nonEmpty(data.name) ?? nonEmpty(fallbackName)
	if (declared === undefined) return undefined
	const name = normalizeName(declared)
	if (!SKILL_NAME.test(name)) return undefined
	const description = nonEmpty(data.description) ?? nonEmpty(firstMeaningfulLine(body))
	if (description === undefined) return undefined
	const modelAllowed = readBoolean(data['disable-model-invocation'])
	const userAllowed = readBoolean(data['user-invocable'])
	// A rejected spelling drops the skill instead of guessing an interface.
	if (modelAllowed === undefined && data['disable-model-invocation'] !== undefined) return undefined
	if (userAllowed === undefined && data['user-invocable'] !== undefined) return undefined
	return {
		name,
		description,
		whenToUse: nonEmpty(data.whenToUse),
		invocation: {
			modelInvocable: modelAllowed !== true,
			userInvocable: userAllowed !== false,
		},
		content: body.replace(/^\r?\n/, ''),
	}
}

/**
 * Parse a command Markdown into catalog fields.
 *
 * `id` wins over `name` because Cursor writes `name: /platform-integration`
 * with a leading slash; the file name is the last resort.
 */
function commandFields(path, data, body, modelInvocable = true) {
	const declared = nonEmpty(data.id) ?? nonEmpty(data.name) ?? baseName(path)
	const name = normalizeName(declared)
	if (!SKILL_NAME.test(name)) return undefined
	const description = nonEmpty(data.description) ?? nonEmpty(firstMeaningfulLine(body))
	if (description === undefined) return undefined
	return {
		name,
		description,
		content: body.replace(/^\r?\n/, ''),
		invocation: { modelInvocable: modelInvocable === true, userInvocable: true },
	}
}

function baseName(path) {
	const file = path.split(sep).pop() ?? path
	return file.replace(/\.md$/i, '')
}

/**
 * Mount the provider and keep its watchers alive for the plugin's lifetime.
 * @param ctx - host plugin context; requires the `skills` service.
 * @param config - raw plugin config.
 */
export function apply(ctx, config = {}) {
	const settings = normalizeConfig(config)
	if (settings.debug) debugProbe(ctx, settings)
	ctx.skills.registerProvider((control) => {
		const provider = new CursorBridgeProvider(ctx, control, settings)
		ctx.effect(function* () {
			yield async () => {
				provider.dispose()
			}
		}, 'cursor-bridge watcher')
		return provider
	})
}

/**
 * Opt-in startup probe: report what the host-side catalog resolves to, so a
 * headless boot can prove the provider is live. Never enabled by default.
 * @param ctx - host plugin context.
 * @param settings - normalized config.
 */
function debugProbe(ctx, settings) {
	const cwd = settings.debugCwd ?? process.cwd()
	Promise.resolve(ctx.skills.list({ cwd }))
		.then((entries) => {
			console.error(`[cursor-bridge] debug: ${entries.length} entries from ${cwd}: ${entries.map((entry) => entry.name).join(',')}`)
		})
		.catch((error) => {
			console.error(`[cursor-bridge] debug failed: ${String(error)}`)
		})
}

export { inject, name, normalizeConfig, parseFrontmatter, normalizeName, findProjectRoot }

export default { apply, inject, name }
