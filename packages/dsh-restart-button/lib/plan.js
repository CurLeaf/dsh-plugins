/**
 * 重启策略：把「这只 DSH 是怎么跑起来的」翻译成一个可以执行的计划。
 *
 * 三种形态，按优先级：
 *   command  用户在 profile patch 里写了 `command`，原样交给 /bin/sh（自管 supervisor 的
 *            人自己决定怎么重启）；
 *   systemd  Linux 由 systemd 用户服务拉起（cgroup 里能读到 `*.service`），交给一个
 *            1 秒后触发的瞬态 timer 去 `systemctl --user restart`，本进程先优雅地
 *            把 HTTP 响应写完；
 *   exit     没有 systemd、也没配命令：直接退出，指望外面的 supervisor（`Restart=always`
 *            的 systemd / pm2 / 前台重开）把进程拉起来。客户端会看到一段断链。
 *
 * 纯函数，不碰进程与文件系统：所有输入都显式传进来，测试才敢断言。
 *
 * @module dsh-restart-button/plan
 */

/** 默认延迟：给 HTTP 响应和浏览器渲染留出时间。 */
export const DEFAULT_DELAY_SECONDS = 1
/** 延迟上限：再久就不像「点了就重启」，而像卡住了。 */
export const MAX_DELAY_SECONDS = 30

/**
 * 从 cgroup 行里读出 systemd 单元名。
 *
 * `/proc/self/cgroup` 在 cgroup v2 里形如
 *   `0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service`
 * 取最后一段；不是 systemd 管理（docker / 前台）时返回 null。
 *
 * @param {string} cgroup 原始 cgroup 文本（可以多行）。
 * @returns {string | null} 例如 `dsh-web.service`；读不出来是 null。
 */
export function serviceFromCgroup(cgroup) {
  if (typeof cgroup !== 'string') return null
  let found = null
  // 多行时取最后一条：混合 cgroup 里 systemd 单元一般落在 `name=systemd` 那一行，
  // 而 `0::` 统一层在最前；后出现的更贴近「本进程属于哪个单元」。
  for (const line of cgroup.split('\n')) {
    const match = /([^/\s]+\.service)\s*$/.exec(line)
    if (match) found = match[1]
  }
  return found
}

/**
 * 把配置里的延迟夹到合法区间。
 * @param {unknown} value 配置原值。
 * @returns {number} 整数秒。
 */
export function normalizeDelay(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return DEFAULT_DELAY_SECONDS
  return Math.min(Math.floor(number), MAX_DELAY_SECONDS)
}

/**
 * 决定这次重启怎么执行。
 *
 * @param {object} input
 * @param {object} [input.config] profile patch 里的 `config`。
 * @param {string} [input.cgroup] `/proc/self/cgroup` 的内容。
 * @param {string} [input.platform] `process.platform`。
 * @param {string} [input.service] 显式指定的 systemd 单元（优先于 cgroup）。
 * @returns {{kind: 'command'|'systemd'|'exit', service: string|null, delaySeconds: number,
 *   command?: string, reason: string}} 执行计划。
 */
export function resolvePlan({
  config = {},
  cgroup = '',
  platform = process.platform,
  service,
} = {}) {
  const delaySeconds = normalizeDelay(config.delaySeconds)
  const explicitService =
    typeof service === 'string' && service.trim() !== ''
      ? service.trim()
      : typeof config.service === 'string' && config.service.trim() !== ''
        ? config.service.trim()
        : null
  const detected = explicitService ?? serviceFromCgroup(cgroup)

  if (typeof config.command === 'string' && config.command.trim() !== '') {
    return {
      kind: 'command',
      service: detected,
      delaySeconds,
      command: config.command.trim(),
      reason: 'profile 配置了 command，按自定义命令重启',
    }
  }

  if (platform === 'linux' && detected !== null) {
    return {
      kind: 'systemd',
      service: detected,
      delaySeconds,
      reason: `由 systemd 用户服务 ${detected} 拉起`,
    }
  }

  return {
    kind: 'exit',
    service: detected,
    delaySeconds,
    reason:
      platform === 'linux'
        ? '没有读到 systemd 单元：退出进程，等外部 supervisor 拉起'
        : `平台 ${platform} 不提供 systemd：退出进程，等外部 supervisor 拉起`,
  }
}

/**
 * 计划的可读描述，用于面板与日志（不暴露命令内容之外的东西）。
 * @param {{kind: string, service: string|null}} plan 执行计划。
 * @returns {string} 一句中文。
 */
export function describePlan(plan) {
  switch (plan?.kind) {
    case 'command':
      return '自定义命令'
    case 'systemd':
      return `systemd · ${plan.service}`
    case 'exit':
      return '退出进程（等 supervisor）'
    default:
      return '未知'
  }
}
