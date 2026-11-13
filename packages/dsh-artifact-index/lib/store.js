/**
 * 产物视图的纯逻辑与磁盘小工具。
 *
 * 这里刻意不碰 Cordis 上下文：命名、链接、索引读写、统计全部是「输入 → 输出」，
 * 单测可以直接跑，插件那份 `lib/index.js` 只负责把它们接到会话事件上。
 *
 * 视图的定位：**对象库是唯一真相，项目里的 .dsh/artifacts 只是硬链接视图**。
 * 视图删了不影响对象库，对象库清了才会真的丢图。
 *
 * @module dsh-artifact-index/store
 */

import { copyFile, link, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 索引文件的格式版本；字段或折叠语义变了就 +1。 */
export const INDEX_VERSION = 1

/** DSH 附件存储支持的图片类型 → 文件扩展名。 */
const IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

/** 硬链接不成立时可以退化的错误码（跨设备、权限、链接数上限）。 */
const LINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'EACCES', 'EMLINK', 'ENOSYS'])

/**
 * @param {unknown} mediaType
 * @returns {string} 以点开头的扩展名；未知类型给 `.bin`。
 */
export function imageExtension(mediaType) {
  return IMAGE_EXTENSIONS.get(String(mediaType)) ?? '.bin'
}

/**
 * 把任意展示名收敛成一个安全的文件名叶子：去掉目录部分与非法字符。
 * 与 DSH 附件存储的 fileLeafName 同思路，但不需要跨平台设备名那套严格规则。
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function safeLeafName(value, fallback = 'capture') {
  const raw = typeof value === 'string' ? value : ''
  const leaf = raw
    .slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (leaf === '' || leaf === '.' || leaf === '..') return fallback
  return leaf
}

/**
 * 会话 id 去掉 `session-` 前缀后取前 8 位，用作文件名里的短标识。
 * @param {unknown} sessionId
 * @returns {string}
 */
export function shortSessionId(sessionId) {
  return String(sessionId ?? '')
    .replace(/^session-/u, '')
    .slice(0, 8)
}

/**
 * 本地日期戳 `YYYY-MM-DD`。用本地时区而不是 UTC：目录是给人看的。
 * @param {number} [ms]
 * @returns {string}
 */
export function dayStamp(ms = Date.now()) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 视图里的文件名：`<会话短id>-<seq>-<原名>.<ext>`。
 * seq 补零到 4 位，同一天里按名字排序就约等于按时间排序。
 * @param {{ sessionId: unknown, seq: number, name?: unknown, mediaType?: unknown }} input
 * @returns {string}
 */
export function artifactLeafName({ sessionId, seq, name, mediaType }) {
  const ext = imageExtension(mediaType)
  const stem = safeLeafName(name, 'capture')
  const bare = stem.toLowerCase().endsWith(ext) ? stem.slice(0, -ext.length) : stem
  return `${shortSessionId(sessionId) || 'session'}-${String(seq).padStart(4, '0')}-${bare || 'capture'}${ext}`
}

/**
 * 视图根目录：配置项可以是相对会话 cwd 的路径，也可以是绝对路径。
 * @param {string} cwd
 * @param {string} viewDir
 * @returns {string}
 */
export function resolveViewRoot(cwd, viewDir) {
  return path.isAbsolute(viewDir) ? viewDir : path.join(cwd, viewDir)
}

/** @param {string} target @returns {Promise<boolean>} */
async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * 把对象库里的文件投影进视图目录。
 *
 * 顺序：硬链接（同 inode，零额外空间）→ 符号链接（跨设备时的降级）→ 复制（兜底）。
 * 目标已存在就直接当「已在视图里」，不覆盖——视图是只增不改的。
 *
 * @param {string} sourcePath 对象库里的绝对路径
 * @param {string} targetPath 视图里的绝对路径
 * @param {{ link?: typeof link, symlink?: typeof symlink }} [operations] 仅测试注入用
 * @returns {Promise<'hardlink' | 'symlink' | 'copy' | 'existing'>}
 */
export async function linkIntoView(sourcePath, targetPath, operations = {}) {
  const hardlink = operations.link ?? link
  const softlink = operations.symlink ?? symlink
  await mkdir(path.dirname(targetPath), { recursive: true })
  if (await pathExists(targetPath)) return 'existing'
  try {
    await hardlink(sourcePath, targetPath)
    return 'hardlink'
  } catch (error) {
    if (error?.code === 'EEXIST') return 'existing'
    if (!LINK_FALLBACK_CODES.has(error?.code)) throw error
  }
  try {
    await softlink(sourcePath, targetPath)
    return 'symlink'
  } catch (error) {
    if (error?.code === 'EEXIST') return 'existing'
    // 落到复制：某些文件系统（FAT、部分网络盘）既不支持硬链接也不支持符号链接
  }
  await copyFile(sourcePath, targetPath)
  return 'copy'
}

/**
 * 让视图目录自带忽略规则：写入 `<root>/.gitignore`，内容是一行 `*`。
 *
 * 这样几百张截图不会污染 `git status`，也不用去改项目根目录的 .gitignore。
 * @param {string} root
 * @returns {Promise<boolean>} 是否写入（已存在则不写）
 */
export async function ensureSelfIgnore(root) {
  const ignorePath = path.join(root, '.gitignore')
  if (await pathExists(ignorePath)) return false
  await mkdir(root, { recursive: true })
  await writeFile(ignorePath, '# 由 dsh-artifact-index 生成：视图目录整体不入库\n*\n', 'utf8')
  return true
}

/**
 * 读索引；文件不存在或版本不符就给一份空索引。
 * @param {string} indexPath
 * @returns {Promise<{ version: number, updatedAt?: string, sessions: Record<string, { artifacts: Array<Record<string, any>> }> }>}
 */
export async function readIndex(indexPath) {
  try {
    const raw = await readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && parsed.version === INDEX_VERSION && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
      return parsed
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) return { version: INDEX_VERSION, sessions: {} }
      throw error
    }
  }
  return { version: INDEX_VERSION, sessions: {} }
}

/**
 * 原子写索引：先写临时文件再 rename，避免命令写到一半被看见。
 * @param {string} indexPath
 * @param {{ version: number, sessions: Record<string, any> }} index
 * @returns {Promise<void>}
 */
export async function writeIndex(indexPath, index) {
  await mkdir(path.dirname(indexPath), { recursive: true })
  const payload = `${JSON.stringify({ ...index, version: INDEX_VERSION }, null, 2)}\n`
  const tmp = `${indexPath}.${process.pid}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, indexPath)
}

/**
 * 一条产物记录的统计口径。
 * @param {Array<{ bytes?: number, at?: string, status?: string }>} entries
 * @returns {{ count: number, bytes: number, cleared: number, clearedBytes: number, live: number, liveBytes: number, oldest?: string, newest?: string }}
 */
export function sessionStats(entries) {
  const stats = { count: 0, bytes: 0, cleared: 0, clearedBytes: 0, live: 0, liveBytes: 0, oldest: undefined, newest: undefined }
  const times = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const bytes = Number.isFinite(entry?.bytes) ? Number(entry.bytes) : 0
    stats.count += 1
    stats.bytes += bytes
    if (entry?.status === 'cleared') {
      stats.cleared += 1
      stats.clearedBytes += bytes
    } else {
      stats.live += 1
      stats.liveBytes += bytes
    }
    if (typeof entry?.at === 'string') times.push(entry.at)
  }
  times.sort()
  if (times.length > 0) {
    stats.oldest = times[0]
    stats.newest = times[times.length - 1]
  }
  return stats
}

/**
 * 人读的字节数。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Number(bytes) : 0
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let scaled = value / 1024
  let index = 0
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[index]}`
}
