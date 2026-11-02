/**
 * 宿主半边：把「重启这只 DSH」做成一条受鉴权的 HTTP 路由。
 *
 * 浏览器不能重启服务，也不该拿到 shell —— 所以这份代码只做三件事：
 *
 *   1. 通过 `connection` 服务注册 `/api/restart-button/*`，让 Host/Origin 校验和
 *      浏览器会话 Cookie 在进入处理函数之前就把外人挡掉（和其它 Host 功能同一条通道）；
 *   2. `GET status` 汇报当前进程与「这次重启会怎么执行」，浏览器用它来判断进程是否
 *      已经换了一个（pid 变了 = 重启完成）；
 *   3. `POST restart` 先把 202 写回浏览器，再按计划安排重启：systemd 用一只瞬态
 *      timer 在一秒后 `systemctl --user restart`，没有 systemd 就退出进程等外部
 *      supervisor 拉起。
 *
 * 不做的事：不常驻、不轮询、不碰 Caddy / EasyTier —— 那是 `dsh-remote-panel` 的
 * 控制面，重启 DSH 只重启 DSH。
 *
 * @module dsh-restart-button
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { describePlan, resolvePlan } from './plan.js'

/** 稳定 Loader 身份。 */
export const name = 'restart-button'

/** 状态路由；浏览器半请求同一路径（相对，转发部署下也成立）。 */
export const STATUS_ROUTE = '/api/restart-button/status'
/** 重启路由。 */
export const RESTART_ROUTE = '/api/restart-button/restart'

/** 本进程启动时刻（模块载入即视为启动）。 */
const STARTED_AT = Date.now()

/**
 * 写完响应到真正动手之间的缓冲：让 HTTP 帧落地，客户端才能看到「正在重启」。
 * 比 systemd 的 1 秒 timer 短一个量级，用户感知不到。
 */
const RESPONSE_GRACE_MS = 250

/** 两次重启之间的最小间隔，防止连点把瞬态单元刷爆。 */
const RESTART_COOLDOWN_MS = 5000

/** 上一次被接受的重启请求（仅进程内存）。 */
let lastRestartAt = 0

/**
 * 读 `/proc/self/cgroup`；读不到就当作「没有 systemd」。
 * @returns {string} 原始文本，失败为空串。
 */
export function readCgroup(path = '/proc/self/cgroup') {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 把 profile 里的 config 归一成计划用的形状。
 * @param {unknown} config 原始配置。
 * @returns {{service: string|null, command: string|null, delaySeconds: number|undefined}}
 */
export function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const service = typeof source.service === 'string' && source.service.trim() !== '' ? source.service.trim() : null
  const command = typeof source.command === 'string' && source.command.trim() !== '' ? source.command.trim() : null
  return { service, command, delaySeconds: source.delaySeconds }
}

/**
 * 生成状态快照。
 * @param {object} input
 * @param {ReturnType<typeof normalizeConfig>} input.config 归一后的配置。
 * @param {string} [input.cgroup] cgroup 文本。
 * @param {number} [input.now] 当前时间。
 * @returns {object} 浏览器可渲染的 JSON。
 */
export function statusSnapshot({ config, cgroup = readCgroup(), now = Date.now() }) {
  const plan = resolvePlan({ config, cgroup })
  return {
    ok: true,
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeMs: Math.max(0, now - STARTED_AT),
    platform: process.platform,
    node: process.version,
    plan: {
      kind: plan.kind,
      service: plan.service,
      delaySeconds: plan.delaySeconds,
      label: describePlan(plan),
      reason: plan.reason,
    },
  }
}

/**
 * 真正动手：按计划把重启安排出去。
 *
 * 三条路都返回 `{ ok, how }`；调用方已经把响应写完了，这里失败只能靠日志。
 *
 * @param {ReturnType<typeof resolvePlan>} plan 执行计划。
 * @param {object} [deps] 测试注入点。
 * @param {typeof spawn} [deps.spawn] 进程启动器。
 * @param {(code: number) => void} [deps.exit] 退出函数。
 * @param {{info?: Function, warn?: Function}} [deps.logger] 日志。
 * @returns {{ok: boolean, how: string}}
 */
export function launchRestart(plan, { spawn: startProcess = spawn, exit = (code) => process.exit(code), logger } = {}) {
  if (plan.kind === 'command' && typeof plan.command === 'string') {
    try {
      const child = startProcess('/bin/sh', ['-c', plan.command], { detached: true, stdio: 'ignore' })
      child.on?.('error', () => {
        logger?.warn?.(`[restart-button] 自定义重启命令启动失败：${plan.command}`)
        exit(0)
      })
      child.unref?.()
      return { ok: true, how: 'command' }
    } catch (error) {
      logger?.warn?.(`[restart-button] 自定义重启命令异常：${String(error)}`)
      exit(0)
      return { ok: false, how: 'command' }
    }
  }

  if (plan.kind === 'systemd' && typeof plan.service === 'string') {
    const unit = `dsh-restart-${process.pid}-${Date.now()}`
    const args = [
      '--user',
      '--collect',
      `--unit=${unit}`,
      `--on-active=${plan.delaySeconds}`,
      'systemctl',
      '--user',
      'restart',
      plan.service,
    ]
    try {
      const child = startProcess('systemd-run', args, { detached: true, stdio: 'ignore' })
      child.on?.('error', () => {
        // systemd-run 不在（容器 / 精简系统）：退回到 exit
        logger?.warn?.('[restart-button] systemd-run 不可用，改为退出进程')
        exit(0)
      })
      child.unref?.()
      logger?.info?.(`[restart-button] ${plan.delaySeconds}s 后重启 ${plan.service}（瞬态单元 ${unit}）`)
      return { ok: true, how: 'systemd' }
    } catch (error) {
      logger?.warn?.(`[restart-button] 安排 systemd 重启失败：${String(error)}`)
      exit(0)
      return { ok: false, how: 'systemd' }
    }
  }

  logger?.info?.('[restart-button] 退出进程，等待外部 supervisor 拉起')
  exit(0)
  return { ok: true, how: 'exit' }
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 * @param {object} [config] profile patch 行里的 `config`。
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)

  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get?.('connection') ?? scoped.connection
    const routes = connection?.fetch
    if (routes === undefined || routes === null || typeof routes.register !== 'function') {
      ctx.logger?.warn?.('[restart-button] connection.fetch 不可用，重启按钮不会生效')
      return
    }

    scoped.effect(
      () =>
        routes.register({
          path: STATUS_ROUTE,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => Response.json(statusSnapshot({ config: settings })),
        }),
      'restart-button: status route',
    )

    scoped.effect(
      () =>
        routes.register({
          path: RESTART_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const now = Date.now()
            if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
              return Response.json(
                { ok: false, error: 'cooldown', message: '上一次重启还在进行，稍等几秒再试。' },
                { status: 429 },
              )
            }
            lastRestartAt = now

            const plan = resolvePlan({ config: settings, cgroup: readCgroup() })
            const payload = { ok: true, mode: plan.kind, service: plan.service, delayMs: RESPONSE_GRACE_MS, plan: describePlan(plan) }

            // 先把响应交给载体，再动手：重启会掐断这条连接，晚一步就写不回去了。
            setTimeout(() => {
              try {
                launchRestart(plan, { logger: ctx.logger })
              } catch (error) {
                ctx.logger?.warn?.(`[restart-button] 重启失败：${String(error)}`)
                setTimeout(() => process.exit(0), 50)
              }
            }, RESPONSE_GRACE_MS)

            ctx.logger?.info?.(`[restart-button] ${request?.method ?? 'POST'} restart: ${describePlan(plan)}`)
            return Response.json(payload, { status: 202 })
          },
        }),
      'restart-button: restart route',
    )
  })
}
