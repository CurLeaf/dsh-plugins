import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import {
  collectReferencedIds,
  findSessionLogs,
  planOrphans,
  scanObjects,
  sweepOrphans,
} from '../lib/gc.js'

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompress === 'function'

/** 造一个 sha256 形状的 id。 */
function id(seed) {
  return seed.repeat(64).slice(0, 64)
}

test('planOrphans：被引用与保护期内的对象都不删', () => {
  const now = 1_000_000_000
  const day = 86_400_000
  const objects = [
    { id: id('a'), path: '/o/a', bytes: 10, at: now - 10 * day },
    { id: id('b'), path: '/o/b', bytes: 20, at: now - 10 * day },
    { id: id('c'), path: '/o/c', bytes: 30, at: now - 1 * day },
  ]
  const referenced = new Set([id('a')])
  const plan = planOrphans({ objects, referenced, minAgeMs: 3 * day, now })
  assert.deepEqual(plan.orphans.map((object) => object.path), ['/o/b'])
  assert.equal(plan.bytes, 20)
  assert.equal(plan.scanned, 3)
  assert.equal(plan.fresh, 1)
  assert.equal(plan.referenced, 1)
})

test('planOrphans：全被引用时没有孤儿', () => {
  const now = 1_000_000_000
  const objects = [{ id: id('d'), path: '/o/d', bytes: 5, at: now - 100 * 86_400_000 }]
  const plan = planOrphans({ objects, referenced: new Set([id('d')]), minAgeMs: 0, now })
  assert.equal(plan.orphans.length, 0)
  assert.equal(plan.bytes, 0)
})

test('findSessionLogs 递归只收 session.v4.jsonl.zstd', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-gc-logs-'))
  try {
    await mkdir(path.join(root, 'project-a', 'session-1'), { recursive: true })
    await mkdir(path.join(root, 'project-b', 'session-2'), { recursive: true })
    await writeFile(path.join(root, 'project-a', 'session-1', 'session.v4.jsonl.zstd'), 'x')
    await writeFile(path.join(root, 'project-b', 'session-2', 'session.v4.jsonl.zstd'), 'y')
    await writeFile(path.join(root, 'project-b', 'session-2', 'session.lock'), '')
    const logs = await findSessionLogs(root)
    assert.equal(logs.length, 2)
    assert.ok(logs.every((file) => file.endsWith('session.v4.jsonl.zstd')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findSessionLogs 对不存在的根目录给空列表', async () => {
  assert.deepEqual(await findSessionLogs(path.join(tmpdir(), 'artifact-gc-missing-root')), [])
})

test('collectReferencedIds 解压会话日志并收 id', { skip: HAS_ZSTD ? false : '当前 Node 没有 zstd' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-gc-refs-'))
  try {
    const one = id('a')
    const two = id('b')
    await mkdir(path.join(root, 'p', 's1'), { recursive: true })
    await mkdir(path.join(root, 'p', 's2'), { recursive: true })
    await writeFile(
      path.join(root, 'p', 's1', 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(`{"a":"sha256:${one}"}\n`)),
    )
    await writeFile(
      path.join(root, 'p', 's2', 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(`{"b":"sha256:${two}"}\n`, 'utf8')),
    )
    // 一个坏日志不该让整次扫描失败
    await writeFile(path.join(root, 'p', 's2', 'broken.v4.jsonl.zstd'), 'not-zstd')

    const referenced = await collectReferencedIds({ root, onProgress: () => {} })
    assert.equal(referenced.size, 2)
    assert.ok(referenced.has(one))
    assert.ok(referenced.has(two))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scanObjects 列出分片目录里的对象', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-gc-objects-'))
  try {
    const a = id('a')
    const b = id('b')
    await mkdir(path.join(root, a.slice(0, 2)), { recursive: true })
    await mkdir(path.join(root, b.slice(0, 2)), { recursive: true })
    await writeFile(path.join(root, a.slice(0, 2), a), Buffer.alloc(7))
    await writeFile(path.join(root, b.slice(0, 2), b), Buffer.alloc(3))
    const objects = await scanObjects({ root })
    assert.equal(objects.length, 2)
    assert.deepEqual(objects.map((object) => object.bytes).sort((x, y) => x - y), [3, 7])
    assert.ok(objects.every((object) => object.at > 0))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scanObjects 对不存在的对象库给空列表', async () => {
  assert.deepEqual(await scanObjects({ root: path.join(tmpdir(), 'artifact-gc-missing-objects') }), [])
})

test('sweepOrphans 统计删除结果并忽略已消失的文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-gc-sweep-'))
  try {
    const keep = path.join(root, 'keep')
    const drop = path.join(root, 'drop')
    await writeFile(keep, 'keep')
    await writeFile(drop, '0123456789')
    const result = await sweepOrphans([
      { path: drop, bytes: 10 },
      { path: path.join(root, 'already-gone'), bytes: 99 },
    ])
    assert.equal(result.deleted, 1)
    assert.equal(result.bytes, 10)
    assert.equal(result.failed, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
