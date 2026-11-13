/**
 * dsh-lazy-mcp — 把 MCP 工具组改成「常驻一个入口工具 + 首次调用后挂载」。
 *
 * 常驻的只有 load_tool_group（约 0.5KB schema）和一小段 system prompt 说明；
 * 被激活的组用 ctx.plugin() 在运行期挂载对应插件（默认 @deepseek-ai/dsh-mcp-client），
 * 工具注册后 DSH 会在下一次请求里以 tool-addition 告知模型，空闲后自动卸下。
 *
 * 之所以能在运行期挂载：DSH 的 tool registry 每次请求重算 header，MCP 客户端
 * 本来就是在会话开始后才异步注册工具的，这条路径天天在跑。
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url';

export const name = 'lazy-mcp'
export const inject = ['tools']

const MARKER = 'dsh-lazy-mcp'
const DEFAULT_IDLE_MINUTES = 30
const DEFAULT_LOAD_TIMEOUT_MS = 25000
const POLL_INTERVAL_MS = 300
const REAP_INTERVAL_MS = 60_000

/**
 * 从 DSH 自己的安装目录解析依赖。
 *
 * 本插件通过 link: 装进 profile，Node 会按真实路径向上查找，永远看不到
 * @deepseek-ai/dsh-* 这些包；但宿主进程本身就是这些包的持有者，所以从
 * process.argv[1]（.../@deepseek-ai/dsh/lib/bin.js）向上逐层试 createRequire。
 */
function resolveDep(spec, moduleBase) {
  const bases = []
  if (moduleBase !== undefined && moduleBase !== '') bases.push(path.join(moduleBase, 'noop.cjs'))
  const entry = typeof process.argv[1] === 'string' && process.argv[1] !== '' ? path.resolve(process.argv[1]) : ''
  if (entry !== '') {
    let dir = path.dirname(entry)
    for (let depth = 0; depth < 6; depth += 1) {
      bases.push(path.join(dir, 'noop.cjs'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  bases.push(new URL('./noop.cjs', import.meta.url).pathname)
  for (const base of bases) {
    try {
      return createRequire(base).resolve(spec)
    } catch {
      // 继续试下一层
    }
  }
  throw new Error(
    `${MARKER}: cannot resolve "${spec}"; set config.moduleBase to the installed @deepseek-ai/dsh package directory`
  )
}

async function importDep(spec, moduleBase) {
  if (typeof spec === 'string' && spec.startsWith('file:')) return import(spec)
  if (typeof spec === 'string' && path.isAbsolute(spec)) return import(pathToFileURL(spec).href)
  return import(pathToFileURL(resolveDep(spec, moduleBase)).href)
}

function normalizeGroups(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
    .map((entry) => {
      const serverName = typeof entry.serverName === 'string' && entry.serverName !== ''
        ? entry.serverName
        : entry.id
      const idleRaw = entry.idleMinutes
      const idleMinutes = Number.isFinite(idleRaw)
        ? Math.max(0, idleRaw)
        : DEFAULT_IDLE_MINUTES
      const timeoutRaw = entry.loadTimeoutMs
      const loadTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? timeoutRaw
        : DEFAULT_LOAD_TIMEOUT_MS
      return {
        id: entry.id,
        title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.id,
        hint: typeof entry.hint === 'string' ? entry.hint : '',
        plugin: typeof entry.plugin === 'string' && entry.plugin !== ''
          ? entry.plugin
          : '@deepseek-ai/dsh-mcp-client',
        pluginConfig: entry.config !== null && typeof entry.config === 'object' ? entry.config : {},
        prefix: typeof entry.prefix === 'string' && entry.prefix !== ''
          ? entry.prefix
          : `mcp__${serverName}__`,
        idleMinutes,
        loadTimeoutMs
      }
    })
}

/**
 * 入口工具 + 上下文里的一小段说明。
 * @param defineTool - dsh-tools 的 defineTool。
 * @param groups - 归一化后的组配置。
 * @param activate - 激活实现。
 * @param unload - 卸载实现。
 * @returns 注册用的工具定义。
 */
function buildTool(defineTool, groups, activate, unload) {
  const ids = groups.map((group) => `${group.id}（${group.title}）`).join('、')
  return defineTool({
    name: 'load_tool_group',
    description: `按需激活一组 MCP 工具（当前：${ids}）。任务确实需要该能力时调用一次，工具会在下一步请求里出现；空闲一段时间后自动卸下。不确定是否需要时，先不调用。`,
    parameters: {
      group: {
        type: 'string',
        required: true,
        description: `要激活的组 id：${groups.map((group) => group.id).join(' / ')}。`
      },
      unload: {
        type: 'boolean',
        description: '传 true 时卸下该组（工具从下一步消失），用于确认不再需要时提前释放上下文。'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          group: { type: 'string' },
          status: { type: 'string' },
          tools: { type: 'integer' },
          sample: { type: 'array', items: { type: 'string' } },
          hint: { type: 'string' },
          error: { type: 'string' }
        },
        additionalProperties: false
      },
      render(_args, value) {
        const lines = []
        if (value.ok === true) {
          lines.push(`工具组 ${value.group}: ${value.status}（${value.tools} 个工具）`)
          if (Array.isArray(value.sample) && value.sample.length > 0) lines.push(`例如：${value.sample.slice(0, 8).join(', ')}`)
          if (typeof value.hint === 'string' && value.hint !== '') lines.push(value.hint)
        } else {
          lines.push(`工具组 ${value.group} 激活失败：${value.error ?? 'unknown error'}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    async execute(args) {
      const id = String(args.group ?? '')
      const unloadRequested = args.unload === true
      if (unloadRequested) return unload(id)
      return activate(id)
    }
  })
}

export async function apply(ctx, config = {}) {
  try {
    await start(ctx, config)
  } catch (error) {
    ctx.logger?.error?.(`[${MARKER}] failed to start: ${error?.stack ?? error}`)
  }
}

async function start(ctx, config = {}) {
  const groups = normalizeGroups(config.groups)
  if (groups.length === 0) {
    ctx.logger?.warn?.(`[${MARKER}] no groups configured; plugin is idle`)
    return
  }
  const moduleBase = typeof config.moduleBase === 'string' && config.moduleBase !== '' ? config.moduleBase : undefined
  const { defineTool } = await importDep('@deepseek-ai/dsh-tools', moduleBase)
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const active = new Map()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const listTools = (prefix) => {
    try {
      const view = ctx.tools.view()
      const names = view !== null && typeof view === 'object' && view.visible instanceof Map
        ? [...view.visible.keys()]
        : []
      return names.filter((toolName) => toolName.startsWith(prefix))
    } catch {
      return []
    }
  }

  const disposeGroup = (id) => {
    const state = active.get(id)
    if (state === undefined) return false
    active.delete(id)
    try {
      state.fiber?.dispose?.()
    } catch (error) {
      ctx.logger?.warn?.(`[${MARKER}] dispose(${id}) failed: ${error?.message ?? error}`)
    }
    return true
  }

  const activate = async (id) => {
    const group = groupById.get(id)
    if (group === undefined) {
      return { ok: false, group: id, error: `unknown group; available: ${groups.map((g) => g.id).join(', ')}` }
    }
    const existing = active.get(id)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      const names = listTools(group.prefix)
      return {
        ok: true,
        group: id,
        status: 'already active',
        tools: names.length,
        sample: names.slice(0, 8),
        hint: '工具已在上下文中，直接调用即可。'
      }
    }
    let fiber
    try {
      const mod = await importDep(group.plugin, moduleBase)
      const plugin = typeof mod.apply === 'function' ? { name: mod.name, apply: mod.apply, inject: mod.inject } : mod.default
      if (plugin === undefined || plugin === null) throw new Error(`${group.plugin} exports no cordis plugin`)
      fiber = ctx.plugin(plugin, group.pluginConfig)
    } catch (error) {
      return { ok: false, group: id, error: String(error?.message ?? error) }
    }
    active.set(id, { fiber, lastUsedAt: Date.now() })
    const deadline = Date.now() + group.loadTimeoutMs
    let names = []
    while (Date.now() < deadline) {
      names = listTools(group.prefix)
      if (names.length > 0) break
      await sleep(POLL_INTERVAL_MS)
    }
    if (names.length === 0 && group.pluginConfig?.failOnStartupError !== false) {
      disposeGroup(id)
      return {
        ok: false,
        group: id,
        error: `no tools registered within ${group.loadTimeoutMs}ms; check the server command/logs`
      }
    }
    return {
      ok: true,
      group: id,
      status: names.length > 0 ? 'activated' : 'mounted (tools not visible yet)',
      tools: names.length,
      sample: names.slice(0, 8),
      hint: '工具会在下一次请求里进入上下文；本轮里如果还看不到，等一个 step 再调用。'
    }
  }

  const unload = (id) => {
    if (!groupById.has(id)) {
      return { ok: false, group: id, error: `unknown group; available: ${groups.map((g) => g.id).join(', ')}` }
    }
    const removed = disposeGroup(id)
    return { ok: true, group: id, status: removed ? 'unloaded' : 'not active', tools: 0 }
  }

  const tool = buildTool(defineTool, groups, activate, unload)
  const disposeTool = ctx.tools.register(tool)
  ctx.effect(() => disposeTool)

  const lines = [
    '## 按需工具组',
    '这些能力默认不占上下文，确实需要时先调用 `load_tool_group` 激活；不用的组不要激活。'
  ]
  for (const group of groups) {
    lines.push(`- \`${group.id}\`（${group.title}）：${group.hint}`)
  }
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.systemPrompt.section({
      name: 'lazy-tool-groups',
      order: 3050,
      text: lines.join('\n')
    })
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, state] of [...active.entries()]) {
        const group = groupById.get(id)
        if (group === undefined || group.idleMinutes <= 0) continue
        if (now - state.lastUsedAt < group.idleMinutes * 60_000) continue
        ctx.logger?.info?.(`[${MARKER}] unloading idle group "${id}"`)
        disposeGroup(id)
      }
    }, REAP_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  ctx.logger?.info?.(`[${MARKER}] ready with ${groups.length} group(s): ${groups.map((g) => g.id).join(', ')}`)
}
