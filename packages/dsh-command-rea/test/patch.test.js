/**
 * Patch-engine tests: they run against a throwaway copy of the recorded
 * pre-images, so nothing here touches the real DSH installation.
 */
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { apply, check, PATCH_ROOT, readManifest, restore } from '../lib/patch.js'

/** Build a fake DSH install whose targets hold the recorded pre-images. */
async function fakeInstall() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-command-rea-'))
  const manifest = await readManifest()
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: manifest.dshVersion }))
  for (const entry of manifest.files) {
    const target = join(root, 'node_modules', '@deepseek-ai', entry.target)
    await cp(join(PATCH_ROOT, entry.pre.replace(/^dsh-patch\//u, '')), target, { recursive: false }).catch(async (error) => {
      if (error.code !== 'ENOENT') throw error
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(target, '..'), { recursive: true })
      await cp(join(PATCH_ROOT, entry.pre.replace(/^dsh-patch\//u, '')), target)
    })
  }
  return root
}

describe('dsh-patch', () => {
  let root
  let manifest

  before(async () => {
    manifest = await readManifest()
    root = await fakeInstall()
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports a pristine target tree', async () => {
    const result = await check({ root })
    assert.equal(result.conflict, 0)
    assert.equal(result.missing, 0)
    assert.equal(result.pristine, manifest.files.length)
    assert.equal(result.patched, 0)
  })

  it('applies every file and is idempotent', async () => {
    const first = await apply({ root })
    assert.equal(first.blocked, false)
    assert.equal(first.written.length, manifest.files.length)

    const second = await apply({ root })
    assert.equal(second.written.length, 0)

    const status = await check({ root })
    assert.equal(status.patched, manifest.files.length)
    assert.equal(status.pristine, 0)
  })

  it('restores the pristine images', async () => {
    const result = await restore({ root })
    assert.equal(result.restored.length, manifest.files.length)
    const status = await check({ root })
    assert.equal(status.pristine, manifest.files.length)
  })

  it('refuses to overwrite an unknown file', async () => {
    const entry = manifest.files[0]
    const target = join(root, 'node_modules', '@deepseek-ai', entry.target)
    await writeFile(target, '// hand edited\n')
    const result = await apply({ root })
    assert.equal(result.blocked, true)
    assert.deepEqual(result.written, [])
    assert.match(await readFile(target, 'utf8'), /hand edited/u)
    await rm(target, { force: true })
    await cp(join(PATCH_ROOT, entry.pre.replace(/^dsh-patch\//u, '')), target)
  })

  it('treats a moved-but-marked file as patched', async () => {
    const entry = manifest.files.find((file) => file.id === 'menu-face')
    const target = join(root, 'node_modules', '@deepseek-ai', entry.target)
    const patched = await readFile(join(PATCH_ROOT, entry.patched.replace(/^dsh-patch\//u, '')), 'utf8')
    await writeFile(target, `${patched}\n// trailing note\n`)
    const result = await check({ root })
    assert.equal(result.rows.find((row) => row.entry.id === 'menu-face').state, 'patched-unverified')
    await cp(join(PATCH_ROOT, entry.pre.replace(/^dsh-patch\//u, '')), target)
  })
})
