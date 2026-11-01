/**
 * Applies the bundled DSH patch that gives this command its menu face and
 * fixes the composer trigger toggle.
 *
 * The patch targets built artifacts of `@deepseek-ai/dsh` 0.2.1-rc.3. Every
 * target carries a pre-image hash and a patched-image hash, so an unknown
 * release or a hand-edited file is refused instead of overwritten.
 *
 * Nothing here imports from `@deepseek-ai/*`; the module only touches the file
 * system, so it runs the same from a checkout, from the registry, and from a
 * `link:` install that never resolves bare specifiers.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Root of this package (`.../dsh-command-rea`). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Patch payload location inside this package. */
export const PATCH_ROOT = join(PACKAGE_ROOT, 'dsh-patch')

/** The DSH release every pre-image hash below came from. */
export async function readManifest(root = PATCH_ROOT) {
  const text = await readFile(join(root, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(text)
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('dsh-patch: manifest.json is not a schema-1 patch manifest')
  }
  return manifest
}

/** One lowercase hex SHA-256 digest of a file's bytes. */
export async function sha256(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Is `dir` an installed `@deepseek-ai/dsh` package root?
 * @param dir - candidate directory.
 * @returns whether it holds the CLI package.
 */
async function isDshRoot(dir) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    return pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string'
  } catch {
    return false
  }
}

/**
 * Resolve the installed DSH package root.
 *
 * Order: an explicit argument, `DSH_ROOT`, then the `dsh` executable on PATH
 * (its real path is `<root>/lib/bin.js`).
 * @param options - `root` from the command line; `env` defaults to the process env.
 * @returns the package root plus the resolved DSH version.
 * @throws when nothing resolves to a DSH install.
 */
export async function resolveDshRoot(options = {}) {
  const env = options.env ?? process.env
  const candidates = []
  const explicit = options.root ?? env.DSH_ROOT
  if (explicit !== undefined && explicit !== '') candidates.push({ dir: resolve(explicit), from: 'explicit' })

  if (candidates.length === 0) {
    try {
      const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['dsh'])
      const bin = stdout.trim().split(/\r?\n/)[0]
      if (bin !== undefined && bin !== '') {
        const real = await import('node:fs').then((fs) => fs.realpathSync(bin))
        // .../@deepseek-ai/dsh/lib/bin.js -> .../@deepseek-ai/dsh
        candidates.push({ dir: dirname(dirname(real)), from: 'PATH' })
      }
    } catch {
      // No `dsh` on PATH; fall through to the error below.
    }
  }

  for (const candidate of candidates) {
    if (await isDshRoot(candidate.dir)) {
      const pkg = JSON.parse(await readFile(join(candidate.dir, 'package.json'), 'utf8'))
      return { root: candidate.dir, version: pkg.version, source: candidate.from }
    }
  }
  throw new Error(
    'dsh-patch: no installed @deepseek-ai/dsh found; pass --root <dsh package dir> or set DSH_ROOT',
  )
}

/** The `@deepseek-ai` directory that holds every patched package. */
export function vendorRoot(dshRoot) {
  return join(dshRoot, 'node_modules', '@deepseek-ai')
}

/**
 * Classify one target file.
 * @param entry - manifest file entry.
 * @param dshRoot - installed DSH package root.
 * @returns `{ state, path, detail }` where state is one of
 *   patched | pristine | patched-unverified | conflict | missing.
 */
export async function inspectFile(entry, dshRoot) {
  const path = join(vendorRoot(dshRoot), entry.target)
  let digest
  try {
    digest = await sha256(path)
  } catch {
    return { state: 'missing', path, detail: 'target file is absent (different DSH layout)' }
  }
  if (digest === entry.patchedSha256) return { state: 'patched', path, detail: 'already patched' }
  if (digest === entry.preSha256) return { state: 'pristine', path, detail: 'unpatched upstream file' }
  const text = await readFile(path, 'utf8')
  if (text.includes(entry.marker)) return { state: 'patched-unverified', path, detail: 'patch marker present, bytes differ from this release' }
  return { state: 'conflict', path, detail: 'neither the pristine nor the patched image of DSH 0.2.1-rc.3' }
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Copy `source` onto `target` through a sibling temporary file. */
async function replaceFile(source, target) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.dsh-command-rea.tmp`
  await copyFile(source, temp)
  await rename(temp, target)
}

/**
 * Inspect every target without writing anything.
 * @param options - root/version overrides.
 * @returns rows and a summary.
 */
export async function check(options = {}) {
  const manifest = await readManifest()
  const dsh = await resolveDshRoot(options)
  const rows = []
  for (const entry of manifest.files) {
    rows.push({ entry, ...(await inspectFile(entry, dsh.root)) })
  }
  return { manifest, dsh, rows, ...summarize(rows) }
}

function summarize(rows) {
  const count = (state) => rows.filter((row) => row.state === state).length
  return {
    patched: count('patched'),
    patchedUnverified: count('patched-unverified'),
    pristine: count('pristine'),
    conflict: count('conflict'),
    missing: count('missing'),
  }
}

/**
 * Apply the patch.
 *
 * `pristine` files are replaced with their patched image; already-patched files
 * are left alone; conflicts and missing targets abort the whole run before any
 * write so a partial patch never lands.
 * @param options - `root`, `dryRun`, `force`.
 * @returns rows, summary, and whether anything was written.
 */
export async function apply(options = {}) {
  const manifest = await readManifest()
  const dsh = await resolveDshRoot(options)
  const rows = []
  for (const entry of manifest.files) {
    rows.push({ entry, ...(await inspectFile(entry, dsh.root)) })
  }
  const summary = summarize(rows)
  const blocked = rows.filter((row) => row.state === 'conflict' || row.state === 'missing')
  if (blocked.length > 0 && options.force !== true) {
    return { manifest, dsh, rows, ...summary, blocked: true, written: [] }
  }
  const written = []
  if (options.dryRun !== true) {
    for (const row of rows) {
      if (row.state !== 'pristine') continue
      await replaceFile(join(PATCH_ROOT, row.entry.patched.replace(/^dsh-patch\//u, '')), row.path)
      written.push(row.entry.target)
    }
  }
  return { manifest, dsh, rows, ...summary, blocked: false, written }
}

/**
 * Restore the pristine upstream images recorded in the manifest.
 * @param options - `root`, `dryRun`.
 * @returns rows, summary, and the restored targets.
 */
export async function restore(options = {}) {
  const manifest = await readManifest()
  const dsh = await resolveDshRoot(options)
  const rows = []
  for (const entry of manifest.files) {
    rows.push({ entry, ...(await inspectFile(entry, dsh.root)) })
  }
  const summary = summarize(rows)
  const restorable = rows.filter((row) => row.state === 'patched' || row.state === 'patched-unverified')
  const restored = []
  if (options.dryRun !== true) {
    for (const row of restorable) {
      await replaceFile(join(PATCH_ROOT, row.entry.pre.replace(/^dsh-patch\//u, '')), row.path)
      restored.push(row.entry.target)
    }
  }
  return { manifest, dsh, rows, ...summary, restored }
}

/** Whether a path is absolute (callers pass `--root` verbatim). */
export function looksAbsolute(path) {
  return isAbsolute(path)
}

export { exists }
