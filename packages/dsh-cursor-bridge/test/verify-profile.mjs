/**
 * Verify the desktop profile wiring: the plugin is declared, linked, resolvable,
 * and composed into the profile bundle stack.
 *
 *   node test/verify-profile.mjs
 *   DSH_PROFILE_DIR=/path/to/profile node test/verify-profile.mjs
 */

import assert from 'node:assert/strict'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR ?? '/Users/curleaf/.dsh/profiles/desktop'
const PACKAGE = 'dsh-cursor-bridge'

const pkg = JSON.parse(await readFile(join(PROFILE, 'package.json'), 'utf8'))

assert.equal(pkg.dependencies?.[PACKAGE], 'link:/Users/curleaf/WorkSpace/dsh-cursor-bridge', 'dependency entry')
assert.ok(pkg.dsh?.profile?.bundles?.includes(PACKAGE), 'bundle entry')

const linked = join(PROFILE, 'node_modules', PACKAGE)
await stat(linked)
const target = await realpath(linked)
assert.equal(target, '/Users/curleaf/WorkSpace/dsh-cursor-bridge', 'link target')

// Loader-style resolution from inside the profile directory.
const moduleUrl = new URL(`file://${PROFILE}/node_modules/${PACKAGE}/lib/index.js`)
const mod = await import(moduleUrl.href)
assert.equal(mod.name, 'cursor-bridge')
assert.deepEqual([...mod.inject], ['skills'])
assert.equal(typeof mod.apply, 'function')

console.log(JSON.stringify({ ok: true, profile: PROFILE, link: target, exports: Object.keys(mod).sort() }, null, 2))
