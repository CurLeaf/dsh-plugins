/**
 * dsh-lazy-mcp — 把 MCP 工具组改成「常驻一个入口工具 + 首次调用后挂载」。
 *
 * 常驻的只有 load_tool_group（约 0.6KB schema）和一小段 system prompt 说明；
 * 被激活的组用 ctx.plugin() 在运行期挂载对应插件（默认 @deepseek-ai/dsh-mcp-client）。
 *
 * v2 的三个关键变化：
 *
 *  1. `scope: agent` 的组挂到发起调用的会话（agent.ctx）里，而不是进程根上下文。
 *     DSH 的工具注册和可见性本来就按 scope 走，MCP 客户端的 serverName 预留
 *     也按 scope 隔离（见 dsh-mcp-client 的 activeServerNames 注释），所以两个
 *     会话可以各自挂一个同名 `browser` 组、各用各的 Chrome，互不可见、互不打扰。
 *
 *  2. `pool` 组在挂载前先向外部分配器（dsh-browser-pool）领一个插槽，把
 *     `{profile}` / `{slot}` 替换进子插件配置。工具名不再承载插槽号：换窗口
 *     不会换工具名，也就没有「新增 14 / 移除 14」的抖动。
 *
 *  3. 空闲回收按真实调用计时（tools/execute），卸载/回收时把插槽还回池子；
 *     另外每轮对账一次租约，窗口被手动关掉后工具不会装作还占着插槽。
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'lazy-mcp'
export const inject = ['tools']

const MARKER = 'dsh-lazy-mcp'
const DEFAULT_IDLE_MINUTES = 30
const DEFAULT_LOAD_TIMEOUT_MS = 25_000
const DEFAULT_REAP_INTERVAL_MS = 60_000
const DEFAULT_POOL_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 300
const DEFAULT_LEASE_TOUCH_MS = 30 * 60_000

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 用 {profile}/{slot}/{group}/{serverName} 这些变量替换配置里的字符串。 */
function fillTokens(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{(profile|slot|group|serverName)\}/g, (match, key) => vars[key] ?? match)
  }
  if (Array.isArray(value)) return value.map((item) => fillTokens(item, vars))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = fillTokens(item, vars)
    return out
  }
  return value
}

function normalizePool(raw) {
  if (!isPlainObject(raw)) return undefined
  const command = Array.isArray(raw.command)
    ? raw.command.filter((part) => typeof part === 'string' && part !== '')
    : typeof raw.command === 'string' && raw.command !== ''
      ? [raw.command]
      : []
  if (command.length === 0) return undefined
  return {
    command,
    note: typeof raw.note === 'string' ? raw.note : '',
    ttlSeconds: Number.isFinite(raw.ttlSeconds) ? raw.ttlSeconds : undefined,
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_POOL_TIMEOUT_MS
  }
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
        pluginConfig: isPlainObject(entry.config) ? entry.config : {},
        prefix: typeof entry.prefix === 'string' && entry.prefix !== ''
          ? entry.prefix
          : `mcp__${serverName}__`,
        scope: entry.scope === 'agent' ? 'agent' : 'global',
        pool: normalizePool(entry.pool),
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
 * @param status - 状态实现。
 * @returns 注册用的工具定义。
 */
function buildTool(defineTool, groups, activate, unload, status) {
  const ids = groups.map((group) => `${group.id}（${group.title}）`).join('、')
  return defineTool({
    name: 'load_tool_group',
    description: `按需激活一组 MCP 工具（当前：${ids}）。任务确实需要该能力时调用一次，工具会在下一步请求里出现；空闲一段时间后自动卸下。带池子的组会先领一个窗口/插槽再挂载，不需要另外调用分配命令；同一会话要开第二个窗口时传 alias。不确定是否需要时，先不调用。`,
    parameters: {
      group: {
        type: 'string',
        required: true,
        description: `要激活的组 id：${groups.map((group) => group.id).join(' / ')}。`
      },
      unload: {
        type: 'boolean',
        description: '传 true 时卸下该组（工具从下一步消失），池子组会同时归还插槽。'
      },
      status: {
        type: 'boolean',
        description: '传 true 时只查询当前会话已激活的组（含插槽、空闲剩余时间），不加载任何东西。'
      },
      alias: {
        type: 'string',
        description: '给同一会话里的第二个窗口起个别名（b / work 等），工具前缀变成 mcp__<组>-<别名>__；不传就是默认前缀。'
      },
      note: {
        type: 'string',
        description: '可选：写进插槽租约的一句话，方便 dsh-browser-pool status 里认出是谁在用。'
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          group: { type: 'string' },
          requested: { type: 'string' },
          status: { type: 'string' },
          tools: { type: 'integer' },
          sample: { type: 'array', items: { type: 'string' } },
          slot: { type: 'string' },
          profile: { type: 'string' },
          scope: { type: 'string' },
          hint: { type: 'string' },
          error: { type: 'string' },
          active: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        additionalProperties: false
      },
      render(_args, value) {
        const lines = []
        if (value.active !== undefined) {
          if (value.active.length === 0) {
            lines.push('当前会话没有已激活的工具组。')
          } else {
            lines.push('当前会话已激活：')
            for (const row of value.active) lines.push(`- ${row}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.ok === true) {
          lines.push(`工具组 ${value.group}: ${value.status}（${value.tools} 个工具）`)
          if (typeof value.slot === 'string' && value.slot !== '') {
            lines.push(`插槽：${value.slot}${typeof value.profile === 'string' && value.profile !== '' ? `（${value.profile}）` : ''}`)
          }
          if (Array.isArray(value.sample) && value.sample.length > 0) lines.push(`例如：${value.sample.slice(0, 8).join(', ')}`)
          if (typeof value.hint === 'string' && value.hint !== '') lines.push(value.hint)
        } else {
          lines.push(`工具组 ${value.group ?? value.requested} 激活失败：${value.error ?? 'unknown error'}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    async execute(args, exec) {
      const id = String(args.group ?? '')
      if (args.status === true) return status(id, exec)
      if (args.unload === true) return unload(id, args, exec)
      return activate(id, args, exec)
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
  const reapIntervalMs = Number.isFinite(config.reapIntervalMs) && config.reapIntervalMs > 0
    ? config.reapIntervalMs
    : DEFAULT_REAP_INTERVAL_MS
  const leaseTouchMs = Number.isFinite(config.leaseTouchMs) && config.leaseTouchMs > 0
    ? config.leaseTouchMs
    : DEFAULT_LEASE_TOUCH_MS
  const { defineTool } = await importDep('@deepseek-ai/dsh-tools', moduleBase)
  const { scopeOf } = await importDep('@deepseek-ai/dsh-scope', moduleBase)
  const groupById = new Map(groups.map((group) => [group.id, group]))
  /** key = `${agentKey}::${groupId}${alias ? '#' + alias : ''}` */
  const active = new Map()
  const agentLabels = new WeakMap()
  let agentSeq = 0
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const agentKeyOf = (agent) => {
    if (agent === undefined || agent === null) return 'global'
    const sessionId = agent.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
    let label = agentLabels.get(agent)
    if (label === undefined) {
      agentSeq += 1
      label = `agent-${agentSeq}`
      agentLabels.set(agent, label)
    }
    return label
  }

  const stateKeyOf = (agentKey, groupId, alias) => `${agentKey}::${groupId}${alias ? `#${alias}` : ''}`

  const listTools = (prefix, scope) => {
    try {
      const view = ctx.tools.view(scope)
      const names = view !== null && typeof view === 'object' && view.visible instanceof Map
        ? [...view.visible.keys()]
        : []
      return names.filter((toolName) => toolName.startsWith(prefix))
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------------- pool
  const runPool = async (group, argv) => {
    const [command, ...prefixArgs] = group.pool.command
    try {
      const { stdout } = await execFileAsync(command, [...prefixArgs, ...argv], {
        timeout: group.pool.timeoutMs,
        maxBuffer: 1024 * 1024
      })
      return { code: 0, stdout }
    } catch (error) {
      return {
        code: typeof error?.code === 'number' ? error.code : 1,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? error)
      }
    }
  }

  const parseJson = (text) => {
    try {
      return JSON.parse(String(text).trim())
    } catch {
      return undefined
    }
  }

  const acquireSlot = async (group, agentKey, note) => {
    const argv = ['acquire', '--json', '--owner', `agent:${agentKey}`]
    const leaseNote = typeof note === 'string' && note !== '' ? note : group.pool.note
    if (leaseNote !== '') argv.push('--note', leaseNote)
    if (Number.isFinite(group.pool.ttlSeconds)) argv.push('--ttl', String(group.pool.ttlSeconds))
    const result = await runPool(group, argv)
    const json = parseJson(result.stdout)
    if (result.code !== 0 || json === undefined || json.ok === false) {
      return {
        ok: false,
        error: json?.error ?? result.stderr ?? `pool exited ${result.code}`
      }
    }
    return { ok: true, ...json }
  }

  const releaseSlot = async (group, slot) => {
    if (!group?.pool || typeof slot !== 'string' || slot === '') return
    const result = await runPool(group, ['release', slot, '--json'])
    if (result.code !== 0) {
      ctx.logger?.warn?.(`[${MARKER}] release ${slot} failed: ${result.stderr ?? result.code}`)
    }
  }

  const touchSlot = async (group, slot) => {
    if (!group?.pool || typeof slot !== 'string' || slot === '') return
    await runPool(group, ['touch', slot, '--json'])
  }

  const poolStatus = async (group) => {
    const result = await runPool(group, ['status', '--json'])
    if (result.code !== 0) return undefined
    return parseJson(result.stdout)
  }

  // ---------------------------------------------------------------- state
  const disposeEntry = async (key, reason) => {
    const state = active.get(key)
    if (state === undefined) return false
    active.delete(key)
    try {
      const disposing = state.fiber?.dispose?.()
      if (disposing !== undefined && typeof disposing.catch === 'function') {
        disposing.catch((error) => ctx.logger?.warn?.(`[${MARKER}] dispose(${key}) failed: ${error?.message ?? error}`))
      }
    } catch (error) {
      ctx.logger?.warn?.(`[${MARKER}] dispose(${key}) failed: ${error?.message ?? error}`)
    }
    if (state.slot !== undefined) {
      await releaseSlot(state.group, state.slot)
    }
    ctx.logger?.info?.(`[${MARKER}] disposed "${key}" (${reason})`)
    return true
  }

  const disposeAll = async (reason) => {
    for (const key of [...active.keys()]) await disposeEntry(key, reason)
  }

  const touch = (toolName) => {
    const now = Date.now()
    for (const state of active.values()) {
      if (!toolName.startsWith(state.prefix)) continue
      state.lastUsedAt = now
      if (state.group.pool && now - state.lastLeaseTouch >= leaseTouchMs) {
        state.lastLeaseTouch = now
        void touchSlot(state.group, state.slot)
      }
    }
  }

  // ---------------------------------------------------------------- activate
  const activate = async (id, args, exec) => {
    const group = groupById.get(id)
    if (group === undefined) {
      return { ok: false, group: id, error: `unknown group; available: ${groups.map((g) => g.id).join(', ')}` }
    }
    const agent = exec?.agent
    if (group.scope === 'agent' && (agent === undefined || agent === null)) {
      return { ok: false, group: id, error: 'this group must be loaded by an agent session (exec.agent is missing)' }
    }
    const aliasRaw = typeof args?.alias === 'string' ? args.alias.trim() : ''
    if (aliasRaw !== '' && !/^[A-Za-z0-9_-]{1,16}$/.test(aliasRaw)) {
      return { ok: false, group: id, error: 'alias must match [A-Za-z0-9_-]{1,16}' }
    }
    const alias = aliasRaw === '' ? undefined : aliasRaw
    const agentKey = agentKeyOf(agent)
    const key = stateKeyOf(agentKey, group.id, alias)
    const existing = active.get(key)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      const names = listTools(existing.prefix, existing.scope)
      return {
        ok: true,
        group: id,
        requested: id,
        status: 'already active',
        tools: names.length,
        sample: names.slice(0, 8),
        slot: existing.slot,
        profile: existing.profile,
        hint: '工具已在上下文中，直接调用即可。'
      }
    }

    const serverName = alias === undefined
      ? (typeof group.pluginConfig.serverName === 'string' && group.pluginConfig.serverName !== ''
          ? group.pluginConfig.serverName
          : group.id)
      : `${typeof group.pluginConfig.serverName === 'string' && group.pluginConfig.serverName !== ''
          ? group.pluginConfig.serverName
          : group.id}-${alias}`
    const prefix = alias === undefined ? group.prefix : `mcp__${serverName}__`

    let acquired
    if (group.pool !== undefined) {
      acquired = await acquireSlot(group, agentKey, typeof args?.note === 'string' ? args.note : '')
      if (acquired.ok !== true) {
        return { ok: false, group: id, error: `no browser slot: ${acquired.error ?? 'unknown error'}` }
      }
    }

    const vars = {
      profile: typeof acquired?.profile === 'string' ? acquired.profile : '',
      slot: typeof acquired?.slot === 'string' ? acquired.slot : '',
      group: group.id,
      serverName
    }
    const mountedConfig = fillTokens(group.pluginConfig, vars)
    if (alias !== undefined) mountedConfig.serverName = serverName
    if (typeof args?.note === 'string' && args.note !== '') mountedConfig.note = args.note

    const mountCtx = group.scope === 'agent' ? agent.ctx : ctx
    const scope = group.scope === 'agent' ? (scopeOf(mountCtx) ?? agent) : undefined

    let fiber
    try {
      const mod = await importDep(group.plugin, moduleBase)
      const plugin = typeof mod.apply === 'function' ? { name: mod.name, apply: mod.apply, inject: mod.inject } : mod.default
      if (plugin === undefined || plugin === null) throw new Error(`${group.plugin} exports no cordis plugin`)
      fiber = mountCtx.plugin(plugin, mountedConfig)
    } catch (error) {
      void releaseSlot(group, acquired?.slot)
      return { ok: false, group: id, error: String(error?.message ?? error) }
    }

    const state = {
      key,
      group,
      prefix,
      agent,
      agentKey,
      scope,
      slot: acquired?.slot,
      profile: acquired?.profile,
      fiber,
      lastUsedAt: Date.now(),
      lastLeaseTouch: Date.now()
    }
    active.set(key, state)

    const deadline = Date.now() + group.loadTimeoutMs
    let names = []
    while (Date.now() < deadline) {
      names = listTools(prefix, scope)
      if (names.length > 0) break
      await sleep(POLL_INTERVAL_MS)
    }
    if (names.length === 0) {
      await disposeEntry(key, 'no tools registered')
      return {
        ok: false,
        group: id,
        error: `no tools registered within ${group.loadTimeoutMs}ms; check the server command/logs`
      }
    }
    return {
      ok: true,
      group: id,
      requested: id,
      status: 'activated',
      tools: names.length,
      sample: names.slice(0, 8),
      slot: state.slot ?? '',
      profile: state.profile ?? '',
      scope: group.scope,
      hint: '工具会在下一次请求里进入上下文；本轮里如果还看不到，等一个 step 再调用。'
    }
  }

  // ---------------------------------------------------------------- unload / status
  const unload = async (id, args, exec) => {
    if (!groupById.has(id)) {
      return { ok: false, group: id, error: `unknown group; available: ${groups.map((g) => g.id).join(', ')}` }
    }
    const aliasRaw = typeof args?.alias === 'string' ? args.alias.trim() : ''
    const agentKey = agentKeyOf(exec?.agent)
    const key = stateKeyOf(agentKey, id, aliasRaw === '' ? undefined : aliasRaw)
    const removed = await disposeEntry(key, 'unload requested')
    return {
      ok: true,
      group: id,
      status: removed ? 'unloaded' : 'not active',
      tools: 0
    }
  }

  const status = (id, exec) => {
    const agentKey = agentKeyOf(exec?.agent)
    const rows = []
    for (const state of active.values()) {
      if (id !== '' && state.group.id !== id) continue
      if (state.agentKey !== agentKey && state.agentKey !== 'global') continue
      const alias = state.key.includes('#') ? state.key.slice(state.key.indexOf('#') + 1) : ''
      const idleLeft = state.group.idleMinutes > 0
        ? Math.max(0, state.group.idleMinutes - Math.floor((Date.now() - state.lastUsedAt) / 60_000))
        : 0
      rows.push(
        `${state.group.id}${alias !== '' ? ` (alias=${alias})` : ''} · ${state.slot ?? 'no slot'} · ` +
          `${listTools(state.prefix, state.scope).length} 个工具 · 空闲 ${idleLeft}m 后回收`
      )
    }
    return { ok: true, group: id || '*', status: 'status', tools: 0, active: rows }
  }

  // ---------------------------------------------------------------- reap
  const reapIdle = () => {
    const now = Date.now()
    for (const [key, state] of [...active.entries()]) {
      if (state.fiber !== undefined && state.fiber.uid === null) {
        active.delete(key)
        void releaseSlot(state.group, state.slot)
        continue
      }
      const group = state.group
      if (group.idleMinutes <= 0) continue
      if (now - state.lastUsedAt < group.idleMinutes * 60_000) continue
      void disposeEntry(key, `idle ${group.idleMinutes}m`)
    }
  }

  const reconcileLeases = async () => {
    const byGroup = new Map()
    for (const state of active.values()) {
      if (state.group.pool === undefined || typeof state.slot !== 'string') continue
      const list = byGroup.get(state.group) ?? []
      list.push(state)
      byGroup.set(state.group, list)
    }
    for (const [group, states] of byGroup.entries()) {
      const json = await poolStatus(group)
      if (json === undefined || !Array.isArray(json.slots)) continue
      const slots = new Map(json.slots.map((slot) => [slot.slot, slot]))
      for (const state of states) {
        const info = slots.get(state.slot)
        const owner = `agent:${state.agentKey}`
        if (info === undefined || info.leased !== true || info.owner !== owner) {
          await disposeEntry(state.key, 'lease lost')
        }
      }
    }
  }

  // ---------------------------------------------------------------- wiring
  const tool = buildTool(defineTool, groups, activate, unload, status)
  const disposeTool = ctx.tools.register(tool)
  ctx.effect(() => disposeTool)

  ctx.on('tools/execute', (exec, next) => {
    touch(exec.name)
    return next()
  })

  const lines = [
    '## 按需工具组',
    '这些能力默认不占上下文，确实需要时先调用 `load_tool_group` 激活；不用的组不要激活。',
    '带池子的组会自己领窗口并归还，不要再手动跑 dsh-browser-pool acquire/release。'
  ]
  for (const group of groups) {
    lines.push(`- \`${group.id}\`（${group.title}）：${group.hint}${group.pool ? '，自动分配窗口' : ''}`)
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
      reapIdle()
      void reconcileLeases().catch((error) => {
        ctx.logger?.warn?.(`[${MARKER}] lease reconcile failed: ${error?.message ?? error}`)
      })
    }, reapIntervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  ctx.effect(() => () => disposeAll('plugin disposed'))

  ctx.logger?.info?.(`[${MARKER}] ready with ${groups.length} group(s): ${groups.map((g) => g.id).join(', ')}`)
}
