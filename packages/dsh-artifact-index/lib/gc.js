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

import { spawn } from 'node:child_process'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'

/** `sha256:<64 hex>` 出现的每一处都算一次引用。 */
const ATTACHMENT_ID = /sha256:([0-9a-f]{64})/gu

/** zstd 帧魔数（小端 0xFD2FB528），用于判断日志是不是多帧拼接。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
 * 用 `zstd -dc` 流式解压并扫 id。
 *
 * DSH 的会话日志是**按追加写多帧**的 zstd；Node 自带的 `zstdDecompress` 只解第一帧，
 * 用它扫引用会得到「全部未被引用」，进而把仍在用的附件当孤儿删掉。CLI 能解多帧，
 * 且流式读取不会把整份日志堆进内存。
 *
 * @param {string} file
 * @param {Set<string>} ids
 * @returns {Promise<boolean>} CLI 是否可用且解压成功
 */
async function scanWithZstdCli(file, ids) {
  return await new Promise((resolve) => {
    let child
    try {
      child = spawn('zstd', ['-d', '-c', '-q', file], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(false)
      return
    }
    let carry = ''
    let failed = false
    child.on('error', () => {
      failed = true
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      // 跨 chunk 的 id 不能漏：保留尾巴再拼下一次
      const text = carry + chunk
      for (const match of text.matchAll(ATTACHMENT_ID)) ids.add(match[1])
      carry = text.slice(-80)
    })
    child.on('close', (code) => resolve(!failed && code === 0))
  })
}

/**
 * 回退路径：Node 自带 zstd（只解首帧）。
 *
 * 解之前先数帧魔数：不止一帧说明这次解压是残缺的，必须把 `lossy` 报上去，
 * 让上层拒绝 `gc --yes`，而不是悄悄按「无引用」做删除。
 *
 * @param {string} file
 * @param {Set<string>} ids
 * @returns {Promise<{ ok: boolean, lossy: boolean }>}
 */
async function scanWithNodeZstd(file, ids) {
  if (zstdDecompress === null) return { ok: false, lossy: false }
  const raw = await readFile(file)
  let frames = 0
  for (let at = raw.indexOf(ZSTD_MAGIC); at !== -1; at = raw.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)) {
    frames += 1
  }
  let text
  try {
    text = (await zstdDecompress(raw)).toString('utf8')
  } catch {
    return { ok: false, lossy: false }
  }
  for (const match of text.matchAll(ATTACHMENT_ID)) ids.add(match[1])
  return { ok: true, lossy: frames > 1 }
}

/**
 * 扫描全部会话日志，收集被引用过的附件 id，并带上「这次扫描可不可信」的统计。
 *
 * @param {{ root?: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{ ids: Set<string>, files: number, decoded: number, failed: number, lossy: number, viaCli: number }>}
 */
export async function scanSessionReferences(options = {}) {
  const root = options.root ?? sessionsRootPath()
  const files = await findSessionLogs(root)
  const ids = new Set()
  let done = 0
  let decoded = 0
  let failed = 0
  let lossy = 0
  let viaCli = 0
  // 顺序解压：单个日志可能有几十 MB，并发几份就够把 CPU 打满
  for (const file of files) {
    if (options.signal?.aborted === true) throw new Error('已取消')
    if (await scanWithZstdCli(file, ids)) {
      decoded += 1
      viaCli += 1
    } else {
      const fallback = await scanWithNodeZstd(file, ids)
      if (!fallback.ok) failed += 1
      else {
        decoded += 1
        if (fallback.lossy) lossy += 1
      }
    }
    done += 1
    options.onProgress?.(done, files.length)
  }
  return { ids, files: files.length, decoded, failed, lossy, viaCli }
}

/**
 * 扫描全部会话日志，收集被引用过的附件 id。
 *
 * @param {{ root?: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<Set<string>>} 64 位十六进制 sha256 集合（不含 `sha256:` 前缀）
 */
export async function collectReferencedIds(options = {}) {
  const scan = await scanSessionReferences(options)
  return scan.ids
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
 * `gc --yes` 前的安全闸：引用扫描不可信时给出拒绝理由。
 *
 * 历史上这里踩过坑：Node 的 zstd 只解首帧，多帧日志被读成「0 引用」，
 * 于是超保护期的对象被当成孤儿整批删掉。现在只要有失败/残缺就拒绝，
 * 只有显式 `--force` 才放行。
 *
 * @param {{ scan: { files: number, failed: number, lossy: number, ids: Set<string> }, plan: { orphans: unknown[] }, force?: boolean }} input
 * @returns {string | null} 拒绝理由；null 表示可以删
 */
export function gcSafetyBlockReason({ scan, plan, force = false }) {
  if (force) return null
  if (scan.failed > 0 || scan.lossy > 0) {
    return `引用扫描不完整（失败 ${scan.failed} 个、只读到首帧 ${scan.lossy} 个）`
  }
  if (scan.files > 0 && scan.ids.size === 0 && plan.orphans.length > 0) {
    return `扫了 ${scan.files} 个会话日志却 0 命中引用，疑似扫描异常`
  }
  return null
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
