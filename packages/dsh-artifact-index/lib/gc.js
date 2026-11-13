/**
 * 磁盘侧清退：算清「哪些对象真的没人要了」。
 *
 * 为什么不能按时按会话删：附件库是**内容寻址 + 跨会话共享**的，同一张图在多个
 * 会话里可能被反复引用。唯一安全的判据是「扫一遍全部会话日志，某个 sha256 一次
 * 都没出现过」——那才是孤儿。
 *
 * 因此 gc 分两步，且默认只报告：
 *   1. `collectReferencedIds()`：把 ~/.dsh/sessions 下所有会话日志解压、扫出引用；
 *   2. `planOrphans()`：对象库里没被引用、且超过保护期的对象才进删除名单。
 *
 * @module dsh-artifact-index/gc
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'

/** `sha256:<64 hex>` 出现的每一处都算一次引用。 */
const ATTACHMENT_ID = /sha256:([0-9a-f]{64})/gu

/** 会话日志文件名（v4 格式）。 */
const SESSION_LOG = 'session.v4.jsonl.zstd'

/** Node 自带的 zstd 解压；22.15 / 23.8 起才有。 */
const zstdDecompress = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null

/**
 * @returns {string} `$DSH_HOME`（缺省 `~/.dsh`）
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : path.join(homedir(), '.dsh')
}

/** @returns {string} 会话日志根目录 */
export function sessionsRootPath(home = dshHome()) {
  return path.join(home, 'sessions')
}

/** @returns {string} 附件对象库根目录（图片） */
export function attachmentsRootPath(home = dshHome()) {
  return path.join(home, 'attachments', 'v1', 'objects')
}

/**
 * 递归找会话日志。按目录名一层层走，不跟随符号链接。
 * @param {string} root
 * @returns {Promise<string[]>} 绝对路径列表
 */
export async function findSessionLogs(root) {
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await findSessionLogs(target)))
      continue
    }
    if (entry.isFile() && entry.name === SESSION_LOG) found.push(target)
  }
  return found
}

/**
 * 扫描全部会话日志，收集被引用过的附件 id。
 *
 * @param {{ root?: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<Set<string>>} 64 位十六进制 sha256 集合（不含 `sha256:` 前缀）
 */
export async function collectReferencedIds(options = {}) {
  if (zstdDecompress === null) {
    throw new Error('当前 Node 没有 zstd 解压能力（需要 22.15 / 23.8 以上），无法扫描会话日志')
  }
  const root = options.root ?? sessionsRootPath()
  const files = await findSessionLogs(root)
  const referenced = new Set()
  let done = 0
  // 顺序解压：单个日志可能有几十 MB，并发 4 个就够把 CPU 打满、内存翻四倍
  for (const file of files) {
    if (options.signal?.aborted === true) throw new Error('已取消')
    let text
    try {
      text = (await zstdDecompress(await readFile(file))).toString('utf8')
    } catch {
      // 单个损坏的日志不该让整次扫描失败：跳过它，孤儿判据只会更保守
      done += 1
      options.onProgress?.(done, files.length)
      continue
    }
    for (const match of text.matchAll(ATTACHMENT_ID)) referenced.add(match[1])
    done += 1
    options.onProgress?.(done, files.length)
  }
  return referenced
}

/**
 * 列出对象库里的所有对象。
 * @param {{ root?: string }} [options]
 * @returns {Promise<Array<{ id: string, path: string, bytes: number, at: number }>>}
 */
export async function scanObjects(options = {}) {
  const root = options.root ?? attachmentsRootPath()
  let shards
  try {
    shards = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const objects = []
  for (const shard of shards) {
    if (!shard.isDirectory()) continue
    const dir = path.join(root, shard.name)
    for (const leaf of await readdir(dir, { withFileTypes: true })) {
      if (!leaf.isFile()) continue
      const file = path.join(dir, leaf.name)
      const info = await stat(file)
      objects.push({ id: leaf.name, path: file, bytes: info.size, at: info.mtimeMs })
    }
  }
  return objects
}

/**
 * 算出可删名单：既没被任何会话引用，又老于保护期。
 *
 * @param {{ objects: Array<{ id: string, path: string, bytes: number, at: number }>, referenced: Set<string>, minAgeMs?: number, now?: number }} input
 * @returns {{ orphans: Array<{ id: string, path: string, bytes: number, at: number }>, bytes: number, scanned: number, referenced: number, fresh: number }}
 */
export function planOrphans({ objects, referenced, minAgeMs = 0, now = Date.now() }) {
  const orphans = []
  let bytes = 0
  let fresh = 0
  for (const object of objects) {
    if (referenced.has(object.id)) continue
    if (now - object.at < minAgeMs) {
      fresh += 1
      continue
    }
    orphans.push(object)
    bytes += object.bytes
  }
  return { orphans, bytes, scanned: objects.length, referenced: objects.length - orphans.length - fresh, fresh }
}

/**
 * 真删。只接受 `planOrphans()` 的结果，不做任何二次判断。
 * @param {Array<{ path: string, bytes: number }>} orphans
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ deleted: number, bytes: number, failed: number }>}
 */
export async function sweepOrphans(orphans, options = {}) {
  let deleted = 0
  let bytes = 0
  let failed = 0
  for (const orphan of orphans) {
    if (options.signal?.aborted === true) break
    try {
      await unlink(orphan.path)
      deleted += 1
      bytes += orphan.bytes
    } catch (error) {
      if (error?.code !== 'ENOENT') failed += 1
    }
  }
  return { deleted, bytes, failed }
}
