import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildSystemdRunArgs,
  isActiveUpdate,
  normalizeConfig,
  readLogTail,
  readStatusFile,
  resolvePaths,
} from '../lib/index.js'

test('normalizeConfig：默认值就是 dsh-web / next / 3080', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.service, 'dsh-web')
  assert.equal(config.tag, 'next')
  assert.equal(config.port, 3080)
  assert.equal(config.withPlugins, false)
})

test('normalizeConfig：空串回落到默认值，数字被转成 number', () => {
  const config = normalizeConfig({ service: '   ', tag: '', port: '3090', withPlugins: true })
  assert.equal(config.service, 'dsh-web')
  assert.equal(config.tag, 'next')
  assert.equal(config.port, 3090)
  assert.equal(config.withPlugins, true)
})

test('buildSystemdRunArgs：瞬态单元、PATH 带 node 目录、脚本作为 bash 参数', () => {
  const args = buildSystemdRunArgs({
    unit: 'dsh-update-1-2',
    script: '/opt/dsh/scripts/dsh-update.sh',
    scriptArgs: ['--tag', 'next'],
    nodeDir: '/usr/local/bin',
    home: '/home/u',
    dshHome: '/home/u/.dsh',
    service: 'dsh-web',
  })
  assert.ok(args.includes('--user'))
  assert.ok(args.includes('--collect'))
  assert.ok(args.includes('--unit=dsh-update-1-2'))
  assert.ok(args.includes('--setenv=PATH=/usr/local/bin:/usr/local/bin:/usr/bin:/bin'))
  assert.ok(args.includes('--setenv=DSH_HOME=/home/u/.dsh'))
  const bashAt = args.indexOf('/bin/bash')
  assert.ok(bashAt > 0, '必须以 /bin/bash 起脚本')
  assert.equal(args[bashAt + 1], '/opt/dsh/scripts/dsh-update.sh')
  assert.deepEqual(args.slice(bashAt + 2), ['--tag', 'next'])
})

test('isActiveUpdate：进行中才算，过期状态不算', () => {
  const now = Date.parse('2026-11-16T10:00:00Z')
  const fresh = { phase: 'installing', updatedAt: new Date(now - 5_000).toISOString() }
  const stale = { phase: 'installing', updatedAt: new Date(now - 3_600_000).toISOString() }
  const done = { phase: 'done', updatedAt: new Date(now - 1_000).toISOString() }
  assert.equal(isActiveUpdate(fresh, now), true)
  assert.equal(isActiveUpdate(stale, now), false)
  assert.equal(isActiveUpdate(done, now), false)
  assert.equal(isActiveUpdate(null, now), false)
})

test('resolvePaths：默认落在 $DSH_HOME 的 state/ 与 logs/', () => {
  const paths = resolvePaths(normalizeConfig(undefined), {
    HOME: '/home/u',
    DSH_HOME: '/home/u/.dsh',
  })
  assert.equal(paths.statusFile, join('/home/u/.dsh', 'state', 'update-status.json'))
  assert.equal(paths.logFile, join('/home/u/.dsh', 'logs', 'dsh-update.log'))
  assert.ok(paths.script.endsWith(join('scripts', 'dsh-update.sh')))
})

test('readStatusFile / readLogTail：读得到，坏文件当没有', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-test-'))
  const statusFile = join(dir, 'status.json')
  const logFile = join(dir, 'update.log')

  assert.equal(readStatusFile(statusFile), null)

  writeFileSync(statusFile, JSON.stringify({ phase: 'done', from: 'a', to: 'b' }))
  assert.deepEqual(readStatusFile(statusFile), { phase: 'done', from: 'a', to: 'b' })

  writeFileSync(statusFile, 'not json')
  assert.equal(readStatusFile(statusFile), null)

  writeFileSync(logFile, ['1', '2', '3', '4'].join('\n'))
  assert.deepEqual(readLogTail(logFile, 2), { lines: ['3', '4'], total: 4 })
  assert.deepEqual(readLogTail(join(dir, 'missing.log'), 2), { lines: [], total: 0 })
})
