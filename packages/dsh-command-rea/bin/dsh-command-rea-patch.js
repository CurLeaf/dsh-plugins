#!/usr/bin/env node
/**
 * `dsh-command-rea-patch` — apply, inspect, or revert the DSH patch bundled
 * with `dsh-command-rea`.
 *
 * The patch gives third-party slash commands a menu title and glyph, and makes
 * the composer's `+` button close the menu it opened. It edits built artifacts
 * inside the installed `@deepseek-ai/dsh`, so it is pinned to one DSH release
 * and refuses anything else.
 */
import { apply, check, PATCH_ROOT, readManifest, restore } from '../lib/patch.js'

const HELP = `dsh-command-rea-patch — DSH menu-face patch for dsh-command-rea

Usage
  dsh-command-rea-patch [command] [options]

Commands
  apply      (default) write the patched files over the installed DSH
  --check    report status only, write nothing
  --restore  put the pristine upstream files back
  --help     this text

Options
  --root <dir>       @deepseek-ai/dsh package directory (default: the dsh on PATH, or $DSH_ROOT)
  --dry-run          print what apply/restore would do, write nothing
  --force            continue even when a target is unknown (it is overwritten)
  --json             machine-readable result
  --postinstall      quiet, never-failing mode used by the package's postinstall hook

Environment
  DSH_ROOT               same as --root
  DSH_COMMAND_REA_PATCH=0 skip the postinstall patch entirely

Exit codes
  0  applied, already patched, or nothing to do
  1  a target is unknown/conflicting, so nothing was written
  2  usage or resolution error
`

function parseArgs(argv) {
  const options = { command: 'apply', root: undefined, dryRun: false, force: false, json: false, postinstall: false }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    switch (arg) {
      case 'apply':
        options.command = 'apply'
        break
      case '--check':
        options.command = 'check'
        break
      case '--restore':
        options.command = 'restore'
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--force':
        options.force = true
        break
      case '--json':
        options.json = true
        break
      case '--postinstall':
        options.postinstall = true
        break
      case '--root':
        options.root = rest.shift()
        if (options.root === undefined) throw new Error('--root needs a directory')
        break
      case '--help':
      case '-h':
        options.command = 'help'
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

const STATE_LABEL = {
  patched: 'patched',
  'patched-unverified': 'patched (bytes differ)',
  pristine: 'upstream',
  conflict: 'CONFLICT',
  missing: 'MISSING',
}

function reportRows(rows) {
  const width = Math.max(...rows.map((row) => row.entry.target.length))
  for (const row of rows) {
    console.log(`  ${row.entry.target.padEnd(width)}  ${STATE_LABEL[row.state]}`)
  }
}

function counts(summary) {
  const parts = []
  if (summary.patched > 0) parts.push(`${summary.patched} patched`)
  if (summary.patchedUnverified > 0) parts.push(`${summary.patchedUnverified} patched (bytes differ)`)
  if (summary.pristine > 0) parts.push(`${summary.pristine} upstream`)
  if (summary.conflict > 0) parts.push(`${summary.conflict} conflict`)
  if (summary.missing > 0) parts.push(`${summary.missing} missing`)
  return parts.join(', ') || 'nothing to inspect'
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') {
    console.log(HELP)
    return 0
  }
  if (options.postinstall && process.env.DSH_COMMAND_REA_PATCH === '0') {
    if (options.json) console.log(JSON.stringify({ skipped: 'DSH_COMMAND_REA_PATCH=0' }))
    return 0
  }

  const manifest = await readManifest()
  const expected = manifest.dshVersion

  if (options.command === 'check') {
    const result = await check({ root: options.root })
    if (options.json) {
      console.log(JSON.stringify({ dsh: result.dsh, expected, ...result.summary, files: result.rows.map((row) => ({ target: row.entry.target, state: row.state })) }))
      return result.conflict > 0 || result.missing > 0 ? 1 : 0
    }
    console.log(`dsh ${result.dsh.version} at ${result.dsh.root} (patch targets ${expected})`)
    reportRows(result.rows)
    console.log(counts(result))
    return result.conflict > 0 || result.missing > 0 ? 1 : 0
  }

  if (options.command === 'restore') {
    const result = await restore({ root: options.root, dryRun: options.dryRun })
    if (options.json) {
      console.log(JSON.stringify({ dsh: result.dsh, dryRun: options.dryRun, restored: result.restored, ...result.summary }))
      return 0
    }
    console.log(`${options.dryRun ? 'would restore' : 'restored'} ${result.restored.length} file(s) under ${result.dsh.root}`)
    for (const target of result.restored) console.log(`  ${target}`)
    if (result.restored.length === 0) console.log('  (nothing was patched)')
    console.log('restart the web host to load the upstream modules again')
    return 0
  }

  const result = await apply({ root: options.root, dryRun: options.dryRun, force: options.force })

  if (options.postinstall) {
    // Never fail an install: report and move on.
    if (result.blocked === true) {
      console.log(`[dsh-command-rea] menu patch skipped: ${result.conflict} conflict(s), ${result.missing} missing target(s) against ${expected}.`)
      console.log('[dsh-command-rea] run `npx dsh-command-rea-patch --check` for details; nothing was written.')
      return 0
    }
    if (result.written.length > 0) {
      console.log(`[dsh-command-rea] menu patch applied: ${result.written.length} file(s); restart the web host to load it.`)
      return 0
    }
    console.log('[dsh-command-rea] menu patch already in place.')
    return 0
  }

  if (options.json) {
    console.log(JSON.stringify({ dsh: result.dsh, dryRun: options.dryRun, blocked: result.blocked, written: result.written, ...result.summary }))
    return result.blocked === true ? 1 : 0
  }

  console.log(`dsh ${result.dsh.version} at ${result.dsh.root} (patch targets ${expected})`)
  reportRows(result.rows)
  if (result.blocked === true) {
    console.log(`\n${counts(result)}`)
    console.log('refusing to write: a target is neither the pristine nor the patched image of ' + expected + '.')
    console.log('nothing was changed. rerun with --force to overwrite, or --restore to go back to upstream files.')
    return 1
  }
  if (options.dryRun) {
    console.log(`\nwould write ${result.rows.filter((row) => row.state === 'pristine').length} file(s); nothing changed (--dry-run)`)
    return 0
  }
  if (result.written.length === 0) {
    console.log('\nalready patched; nothing to do')
    return 0
  }
  console.log(`\nwrote ${result.written.length} file(s):`)
  for (const target of result.written) console.log(`  ${target}`)
  console.log('restart the web host so the host half is re-read:')
  console.log('  systemctl --user restart dsh-web.service')
  return 0
}

main().then(
  (code) => process.exit(code),
  async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`dsh-command-rea-patch: ${message}`)
    if (process.argv.includes('--postinstall')) {
      console.error('[dsh-command-rea] continuing without the menu patch.')
      process.exit(0)
    }
    console.error(`patch payload: ${PATCH_ROOT}`)
    process.exit(2)
  },
)
