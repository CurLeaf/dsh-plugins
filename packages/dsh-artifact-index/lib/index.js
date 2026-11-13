/**
 * `dsh-artifact-index` 宿主半边。
 *
 * 解决的事：长会话里截图越攒越多，但用户根本找不到它们——附件库是内容寻址的
 * `objects/<2>/<sha256>`，没扩展名、没原名、没有「这次改页面用了哪几张图」的线索。
 * 这个插件在每次回合结束时，把这一回合新增的图片**硬链接**成项目里可浏览的视图：
 *
 *   <项目>/.dsh/artifacts/<YYYY-MM-DD>/<会话短id>-<seq>-<原名>.png
 *   <项目>/.dsh/artifacts/index.json
 *
 * 对象库仍是唯一真相，视图只是零额外空间的硬链接；删除视图不影响会话重放。
 *
 * 另外给一条 `/artifacts` 命令（list / backfill / clear / gc），以及到阈值后往
 * 下一轮注入一行提醒，让模型在答复末尾提示用户「可以清退了」。
 *
 * 不做的事：不改请求里的图片预算（那是 provider 的 `maxInlineRequestImageBytes`），
 * 也不删附件对象本身（只有 `/artifacts gc --yes` 且确认无引用时才删）。
 *
 * @module dsh-artifact-index
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  artifactLeafName,
  dayStamp,
  ensureSelfIgnore,
  formatBytes,
  linkIntoView,
  readIndex,
  resolveViewRoot,
  sessionStats,
  writeIndex,
} from './store.js'
import {
  attachmentsRootPath,
  gcSafetyBlockReason,
  planOrphans,
  scanObjects,
  scanSessionReferences,
  sessionsRootPath,
  sweepOrphans,
} from './gc.js'

/** 稳定 Loader 身份。 */
export const name = 'artifact-index'

/** 缺少这些服务时插件保持未激活，而不是抛错。 */
export const inject = ['agents', 'commands', 'attachments']

/** 命令用法。 */
const USAGE = [
  '/artifacts            本会话产物明细',
  '/artifacts backfill   把本会话历史图片补进视图',
  '/artifacts clear      标记本会话产物为「可清退」（不删文件）',
  '/artifacts gc         报告可回收的对象（不删）',
  '/artifacts gc --yes   真删：未被任何会话引用且超过保护期的对象',
  '/artifacts gc --yes --force  引用扫描异常时仍强制删除（危险）',
].join('\n')

/** 默认配置；与 cordis.patch.yml 里插件的 `config` 同形。 */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  viewDir: '.dsh/artifacts',
  selfIgnore: true,
  remind: { enabled: true, minImages: 10, minBytes: 2097152, maxTimes: 2 },
  gc: { minAgeDays: 3 },
})

/**
 * 把行配置收敛成确定形状：缺省补默认，类型不对就退回默认，未知键忽略。
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const remind = input.remind !== null && typeof input.remind === 'object' ? input.remind : {}
  const gc = input.gc !== null && typeof input.gc === 'object' ? input.gc : {}
  const number = (value, fallback) => (Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback)
  return {
    enabled: input.enabled !== false,
    viewDir: typeof input.viewDir === 'string' && input.viewDir.trim() !== '' ? input.viewDir.trim() : DEFAULT_CONFIG.viewDir,
    selfIgnore: input.selfIgnore !== false,
    remind: {
      enabled: remind.enabled !== false,
      minImages: number(remind.minImages, DEFAULT_CONFIG.remind.minImages),
      minBytes: number(remind.minBytes, DEFAULT_CONFIG.remind.minBytes),
      maxTimes: number(remind.maxTimes, DEFAULT_CONFIG.remind.maxTimes),
    },
    gc: {
      minAgeDays: number(gc.minAgeDays, DEFAULT_CONFIG.gc.minAgeDays),
    },
  }
}

/**
 * 会话的项目目录。
 * @param {any} session
 * @returns {string | undefined}
 */
export function sessionCwd(session) {
  const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : undefined
}

/**
 * 从事件里取图片附件。目前只有这两类事件会带模型可见的图片。
 * @param {any} event
 * @returns {Array<any>} `ImageAttachmentRef` 列表
 */
export function imagesOf(event) {
  const blocks = event?.type === 'user/message'
    ? event?.data?.content
    : event?.type === 'tool/result'
      ? event?.data?.message?.content
      : undefined
  if (!Array.isArray(blocks)) return []
  const refs = []
  for (const block of blocks) {
    if (block?.type === 'image' && typeof block?.attachment?.attachmentId === 'string') refs.push(block.attachment)
  }
  return refs
}

/**
 * 按 seq 倒序在会话日志里走图片；`all` 为假时只走到本回合开头。
 * @param {any} session
 * @param {{ all: boolean }} options
 * @returns {Array<[number, any]>} `[seq, attachment]`，按 seq 升序
 */
export function collectSessionImages(session, { all }) {
  const collected = []
  const last = Number(session?.seq ?? 0) - 1
  for (let seq = last; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (!all && event.type === 'turn/start') break
    for (const attachment of imagesOf(event)) collected.push([seq, attachment])
  }
  return collected.reverse()
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  /** sessionId → Agent，用来在回合结束时注入提醒。 */
  const agents = new Map()
  /** sessionId → 已提醒次数。 */
  const reminders = new Map()
  /** sessionId → 进行中的同步任务，同一会话串行。 */
  const syncing = new Map()

  ctx.effect(() => {
    const disposers = [
      ctx.on('agent/created', ({ agent }) => {
        if (agent?.session?.id !== undefined) agents.set(String(agent.session.id), agent)
      }),
      ctx.on('agent/disposed', ({ agent }) => {
        if (agent?.session?.id !== undefined) agents.delete(String(agent.session.id))
      }),
      ctx.on('session/event', (session, event) => {
        if (!options.enabled) return
        if (event?.type !== 'turn/end') return
        scheduleSync(session)
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // 卸载期的清理失败不该影响其它监听器
        }
      }
    }
  }, 'artifact-index session listeners')

  /**
   * 回合结束后按会话串行同步；失败只记日志，绝不影响对话本身。
   * @param {any} session
   */
  function scheduleSync(session) {
    const sessionId = String(session?.id ?? '')
    if (sessionId === '' || syncing.has(sessionId)) return
    const task = Promise.resolve()
      .then(() => syncSession(session, { all: false }))
      .then((result) => {
        if (result !== null && result.added > 0) remind(session, result)
      })
      .catch((error) => {
        warn(`同步失败（${sessionId}）：${error?.message ?? String(error)}`)
      })
      .finally(() => {
        syncing.delete(sessionId)
      })
    syncing.set(sessionId, task)
  }

  /**
   * 把（本回合或全部）图片投影进视图，并更新索引。
   * @param {any} session
   * @param {{ all: boolean }} scope
   * @returns {Promise<null | { root: string, indexPath: string, sessionId: string, record: any, added: number }>}
   */
  async function syncSession(session, { all }) {
    const cwd = sessionCwd(session)
    if (cwd === undefined) return null
    const root = resolveViewRoot(cwd, options.viewDir)
    const indexPath = path.join(root, 'index.json')
    const index = await readIndex(indexPath)
    const sessionId = String(session.id)
    const record = index.sessions[sessionId] ?? {
      sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      artifacts: [],
    }
    index.sessions[sessionId] = record
    const known = new Set(record.artifacts.map((entry) => entry.key))
    const candidates = collectSessionImages(session, { all }).filter(([seq, attachment]) => !known.has(`${seq}|${attachment.attachmentId}`))
    if (candidates.length === 0) return { root, indexPath, sessionId, record, added: 0 }

    const day = dayStamp()
    const dayDir = path.join(root, day)
    if (options.selfIgnore) await ensureSelfIgnore(root)
    let added = 0
    for (const [seq, attachment] of candidates) {
      const sourcePath = ctx.attachments.imageHostPath(attachment)
      if (typeof sourcePath !== 'string' || sourcePath === '') continue
      const leaf = artifactLeafName({ sessionId, seq, name: attachment.name, mediaType: attachment.mediaType })
      const target = path.join(dayDir, leaf)
      let link
      try {
        link = await linkIntoView(sourcePath, target)
      } catch (error) {
        warn(`链接失败（${leaf}）：${error?.message ?? String(error)}`)
        continue
      }
      record.artifacts.push({
        key: `${seq}|${attachment.attachmentId}`,
        seq,
        attachmentId: attachment.attachmentId,
        name: typeof attachment.name === 'string' ? attachment.name : leaf,
        mediaType: attachment.mediaType ?? 'image/png',
        bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : 0,
        width: attachment.width,
        height: attachment.height,
        at: new Date().toISOString(),
        path: path.relative(root, target),
        objectPath: sourcePath,
        link,
        status: 'live',
      })
      added += 1
    }
    if (added > 0) {
      index.updatedAt = new Date().toISOString()
      await writeIndex(indexPath, index)
    }
    return { root, indexPath, sessionId, record, added }
  }

  /**
   * 到阈值就往下一轮注入一行提醒；次数上限防止每轮刷。
   * @param {any} session
   * @param {{ root: string, record: any }} result
   */
  function remind(session, result) {
    const settings = options.remind
    if (!settings.enabled) return
    const sessionId = String(session.id)
    const times = reminders.get(sessionId) ?? 0
    if (times >= settings.maxTimes) return
    const stats = sessionStats(result.record?.artifacts ?? [])
    if (stats.count < settings.minImages && stats.bytes < settings.minBytes) return
    const agent = agents.get(sessionId)
    if (agent === undefined || typeof agent.inject !== 'function') return
    const text = [
      `[artifact-index] 本会话中间产物已有 ${stats.count} 张 / ${formatBytes(stats.bytes)}，视图目录 ${result.root}。`,
      '如果这一轮给出了最终答复，请在答复末尾用一行提醒用户：可以运行 /artifacts clear 标记清退、/artifacts gc 回收磁盘。只提醒一次，不要展开。',
    ].join('')
    try {
      agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      reminders.set(sessionId, times + 1)
    } catch (error) {
      warn(`注入提醒失败：${error?.message ?? String(error)}`)
    }
  }

  /**
   * 命令唯一入口：所有子命令都从这里分发，UI 与命令都走同一条逻辑。
   * @param {{ agent: any, rawInput: string, signal?: AbortSignal }} invocation
   * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
   */
  const handler = async (invocation) => {
    try {
      return await runCommand(invocation)
    } catch (error) {
      return { kind: 'error', text: `artifact-index：${error?.message ?? String(error)}` }
    }
  }

  /** @param {{ agent: any, rawInput: string, signal?: AbortSignal }} invocation */
  async function runCommand({ agent, rawInput, signal }) {
    const session = agent?.session
    if (session === undefined) return { kind: 'error', text: '没有可用的会话。' }
    const cwd = sessionCwd(session)
    if (cwd === undefined) return { kind: 'error', text: '这个会话没有项目目录（cwd），无法定位 .dsh/artifacts。' }
    const root = resolveViewRoot(cwd, options.viewDir)
    const indexPath = path.join(root, 'index.json')
    const [verb = '', ...flags] = String(rawInput ?? '').trim().split(/\s+/u).filter((part) => part !== '')
    switch (verb) {
      case '':
      case 'list':
        return listResult(session, root, indexPath)
      case 'backfill': {
        const result = await syncSession(session, { all: true })
        const added = result?.added ?? 0
        return {
          kind: 'success',
          text: added === 0 ? `本会话没有新的历史图片可回填。视图：${root}` : `已回填 ${added} 张图片到 ${root}`,
        }
      }
      case 'clear':
        return clearResult(session, root, indexPath)
      case 'gc':
        return gcResult({
          root,
          indexPath,
          yes: flags.includes('--yes'),
          force: flags.includes('--force'),
          signal,
        })
      default:
        return { kind: 'error', text: `未知子命令「${verb}」\n${USAGE}` }
    }
  }

  /** @param {any} session @param {string} root @param {string} indexPath */
  async function listResult(session, root, indexPath) {
    const index = await readIndex(indexPath)
    const record = index.sessions[String(session.id)]
    const entries = record?.artifacts ?? []
    if (entries.length === 0) {
      return {
        kind: 'success',
        text: `本会话还没有索引到中间产物。\n视图目录：${root}\n把历史图片补进来：/artifacts backfill`,
      }
    }
    const stats = sessionStats(entries)
    const recent = entries.slice(-8).reverse()
    const lines = [
      `本会话中间产物：${stats.count} 张 / ${formatBytes(stats.bytes)}（已标记清退 ${stats.cleared} 张 / ${formatBytes(stats.clearedBytes)}）`,
      `视图：${root}`,
      `最近 ${recent.length} 张：`,
      ...recent.map((entry) => `  ${entry.status === 'cleared' ? '×' : '·'} ${entry.path}  ${formatBytes(entry.bytes)}`),
      USAGE,
    ]
    return { kind: 'success', text: lines.join('\n') }
  }

  /** @param {any} session @param {string} root @param {string} indexPath */
  async function clearResult(session, root, indexPath) {
    const index = await readIndex(indexPath)
    const record = index.sessions[String(session.id)]
    const entries = record?.artifacts ?? []
    const live = entries.filter((entry) => entry.status !== 'cleared')
    if (live.length === 0) {
      return { kind: 'success', text: '本会话没有需要清退的产物（都已经是 cleared 状态）。' }
    }
    const now = new Date().toISOString()
    let bytes = 0
    for (const entry of live) {
      entry.status = 'cleared'
      entry.clearedAt = now
      bytes += Number.isFinite(entry.bytes) ? Number(entry.bytes) : 0
    }
    index.updatedAt = now
    await writeIndex(indexPath, index)
    return {
      kind: 'success',
      text: `已把本会话 ${live.length} 张 / ${formatBytes(bytes)} 标记为可清退（文件还在，会话重放不受影响）。\n真正回收磁盘：/artifacts gc 先看报告，再加 --yes。\n视图：${root}`,
    }
  }

  /** @param {{ root: string, indexPath: string, yes: boolean, force?: boolean, signal?: AbortSignal }} input */
  async function gcResult({ root, indexPath, yes, force = false, signal }) {
    const scan = await scanSessionReferences({ signal })
    const referenced = scan.ids
    const objects = await scanObjects({ root: attachmentsRootPath() })
    const plan = planOrphans({
      objects,
      referenced,
      minAgeMs: options.gc.minAgeDays * 86400000,
    })
    const scanLine = `引用扫描：${scan.files} 个会话日志，成功解压 ${scan.decoded}（走 zstd CLI ${scan.viaCli}），失败 ${scan.failed}，只读到首帧 ${scan.lossy}，命中 ${referenced.size} 个 id`

    // 引用扫描不可信时，绝不能按「没被引用」删东西：宁可拒绝，也不误删。
    const blockReason = gcSafetyBlockReason({ scan, plan, force })
    if (yes && blockReason !== null) {
      return {
        kind: 'error',
        text: [
          `已拒绝删除：${blockReason}。`,
          scanLine,
          '按当前结果删会把仍在用的附件当孤儿。先确认 `zstd` 命令可用（DSH 日志是多帧追加，必须用 CLI 解），修好后重跑 /artifacts gc。',
          '确实要按当前结果强删：/artifacts gc --yes --force',
        ].join('\n'),
      }
    }
    if (plan.orphans.length === 0) {
      return {
        kind: 'success',
        text: `扫描 ${plan.scanned} 个对象：没有可回收的对象（未过 ${options.gc.minAgeDays} 天保护期的 ${plan.fresh} 个）。\n${scanLine}`,
      }
    }
    if (!yes) {
      const worst = plan.orphans.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5)
      return {
        kind: 'success',
        text: [
          `可回收：${plan.orphans.length} 个对象 / ${formatBytes(plan.bytes)}（对象库共 ${plan.scanned} 个）`,
          scanLine,
          '最大的 5 个：',
          ...worst.map((object) => `  ${object.id.slice(0, 12)}…  ${formatBytes(object.bytes)}`),
          '这是空跑，没有删任何东西。确认后运行：/artifacts gc --yes',
          `视图目录 ${root} 不受影响；删的是跨会话共享对象库里没人引用的对象。`,
        ].join('\n'),
      }
    }
    const swept = await sweepOrphans(plan.orphans, { signal })
    return {
      kind: 'success',
      text: `已删除 ${swept.deleted} 个对象，回收 ${formatBytes(swept.bytes)}${swept.failed > 0 ? `（${swept.failed} 个删除失败）` : ''}。\n${scanLine}`,
    }
  }

  ctx.effect(
    () => ctx.commands.register({
      name: 'artifacts',
      description: '查看 / 清退本会话的图片中间产物',
      input: { hint: '[list|backfill|clear|gc]' },
      handler,
    }),
    'artifact-index command',
  )
}

/**
 * 别把插件故障塞进对话：只写 stderr，DSH 的宿主日志会带上前缀。
 * @param {string} message
 */
function warn(message) {
  try {
    process.stderr.write(`[dsh-artifact-index] ${message}\n`)
  } catch {
    // 忽略不可写的 stderr
  }
}
