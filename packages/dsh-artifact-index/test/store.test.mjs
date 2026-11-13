import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  artifactLeafName,
  dayStamp,
  ensureSelfIgnore,
  formatBytes,
  linkIntoView,
  readIndex,
  resolveViewRoot,
  safeLeafName,
  sessionStats,
  shortSessionId,
  writeIndex,
} from '../lib/store.js'

test('safeLeafName 收敛目录与非法字符', () => {
  assert.equal(safeLeafName('../etc/passwd'), 'passwd')
  assert.equal(safeLeafName('a<b>c.png'), 'a_b_c.png')
  assert.equal(safeLeafName('   '), 'capture')
  assert.equal(safeLeafName(undefined), 'capture')
  assert.equal(safeLeafName('trailing.  '), 'trailing')
})

test('会话短 id 与视图文件名', () => {
  assert.equal(shortSessionId('session-f2a86021-dd67-4f17'), 'f2a86021')
  assert.equal(shortSessionId(''), '')
  assert.equal(
    artifactLeafName({ sessionId: 'session-f2a86021-dd67', seq: 123, name: 'home-banner.jpg', mediaType: 'image/jpeg' }),
    'f2a86021-0123-home-banner.jpg',
  )
  // 名字里已经带对扩展名时不重复追加
  assert.equal(
    artifactLeafName({ sessionId: 'session-abcd1234', seq: 7, name: 'shot.png', mediaType: 'image/png' }),
    'abcd1234-0007-shot.png',
  )
  // 未知类型退 .bin，缺名字退 capture
  assert.equal(
    artifactLeafName({ sessionId: 'session-abcd1234', seq: 1, name: '', mediaType: 'image/avif' }),
    'abcd1234-0001-capture.bin',
  )
})

test('dayStamp 是本地 YYYY-MM-DD', () => {
  assert.match(dayStamp(Date.UTC(2026, 10, 13)), /^\d{4}-\d{2}-\d{2}$/u)
  const local = new Date(2026, 10, 13, 8, 30)
  assert.equal(dayStamp(local.getTime()), '2026-11-13')
})

test('sessionStats 区分 live 与 cleared', () => {
  const stats = sessionStats([
    { bytes: 100, at: '2026-11-13T01:00:00.000Z', status: 'live' },
    { bytes: 200, at: '2026-11-13T02:00:00.000Z', status: 'cleared' },
    { bytes: 50, at: '2026-11-13T00:00:00.000Z' },
  ])
  assert.equal(stats.count, 3)
  assert.equal(stats.bytes, 350)
  assert.equal(stats.live, 2)
  assert.equal(stats.liveBytes, 150)
  assert.equal(stats.cleared, 1)
  assert.equal(stats.clearedBytes, 200)
  assert.equal(stats.oldest, '2026-11-13T00:00:00.000Z')
  assert.equal(stats.newest, '2026-11-13T02:00:00.000Z')
  assert.deepEqual(sessionStats(undefined), {
    count: 0, bytes: 0, cleared: 0, clearedBytes: 0, live: 0, liveBytes: 0, oldest: undefined, newest: undefined,
  })
})

test('formatBytes 走二进制单位', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MiB')
  assert.equal(formatBytes(20 * 1024 ** 3), '20 GiB')
  assert.equal(formatBytes(Number.NaN), '0 B')
})

test('resolveViewRoot 接受相对与绝对路径', () => {
  assert.equal(resolveViewRoot('/work/app', '.dsh/artifacts'), '/work/app/.dsh/artifacts')
  assert.equal(resolveViewRoot('/work/app', '/var/artifacts'), '/var/artifacts')
})

test('linkIntoView：硬链接、幂等、内容可读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-index-'))
  try {
    const source = path.join(root, 'object')
    await writeFile(source, 'png-bytes')
    const target = path.join(root, 'view', '2026-11-13', 'abcd1234-0001-shot.png')

    assert.equal(await linkIntoView(source, target), 'hardlink')
    assert.equal(await readFile(target, 'utf8'), 'png-bytes')
    // 同 inode 才是真硬链接（零额外空间）
    assert.equal((await stat(target)).ino, (await stat(source)).ino)
    // 再来一次不覆盖
    assert.equal(await linkIntoView(source, target), 'existing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('linkIntoView：跨设备时退化为符号链接', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-index-symlink-'))
  try {
    const source = path.join(root, 'object')
    await writeFile(source, 'bytes')
    const target = path.join(root, 'view', 'shot.png')
    const exdev = async () => {
      const error = new Error('cross-device link')
      error.code = 'EXDEV'
      throw error
    }
    assert.equal(await linkIntoView(source, target, { link: exdev }), 'symlink')
    assert.equal(await readFile(target, 'utf8'), 'bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('linkIntoView：链接都不可用时退化为复制', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-index-copy-'))
  try {
    const source = path.join(root, 'object')
    await writeFile(source, 'copied-bytes')
    const target = path.join(root, 'view', 'shot.png')
    const unsupported = async () => {
      const error = new Error('operation not permitted')
      error.code = 'EPERM'
      throw error
    }
    const link = await linkIntoView(source, target, { link: unsupported, symlink: unsupported })
    assert.equal(link, 'copy')
    assert.equal(await readFile(target, 'utf8'), 'copied-bytes')
    // 复制副本与源是两个 inode
    assert.notEqual((await stat(target)).ino, (await stat(source)).ino)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureSelfIgnore 只写一次', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-index-ignore-'))
  try {
    const view = path.join(root, '.dsh', 'artifacts')
    assert.equal(await ensureSelfIgnore(view), true)
    assert.match(await readFile(path.join(view, '.gitignore'), 'utf8'), /^\*$/mu)
    assert.equal(await ensureSelfIgnore(view), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readIndex / writeIndex 往返与容错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-index-index-'))
  try {
    const indexPath = path.join(root, 'index.json')
    assert.deepEqual(await readIndex(indexPath), { version: 1, sessions: {} })

    const index = { version: 1, sessions: { 'session-a': { artifacts: [{ key: '1|sha256:x', bytes: 10 }] } } }
    await writeIndex(indexPath, index)
    const reloaded = await readIndex(indexPath)
    assert.equal(reloaded.sessions['session-a'].artifacts[0].bytes, 10)
    assert.ok(JSON.parse(await readFile(indexPath, 'utf8')).updatedAt === undefined)

    // 损坏的 JSON 当空索引，不抛错
    await writeFile(indexPath, '{not json')
    assert.deepEqual(await readIndex(indexPath), { version: 1, sessions: {} })

    // 版本不符也当空索引
    await writeFile(indexPath, JSON.stringify({ version: 99, sessions: {} }))
    assert.deepEqual(await readIndex(indexPath), { version: 1, sessions: {} })

    await mkdir(path.join(root, 'nested'), { recursive: true })
    await writeIndex(path.join(root, 'nested', 'index.json'), index)
    assert.equal((await readIndex(path.join(root, 'nested', 'index.json'))).sessions['session-a'].artifacts.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
