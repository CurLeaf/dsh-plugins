/**
 * 定时检查「官方有没有发新版本」，并把结论留在内存 + 状态文件里。
 *
 * 为什么要一个后台计时器，而不是只靠页面轮询：
 *   * 页面关掉/手机锁屏时按钮不在线，但用户一打开就该看到「有新版本」，而不是
 *     等页面先跑一次 npm 请求；
 *   * 官方发 rc 的频率不低，每次发布都该被**一次**发现并记住，而不是每个页面
 *     各查一次（npm 是公共资源，也省得被限流）；
 *   * 失败要退避：npm 源抖动时别每 15 分钟硬撞，指数退避到 1 小时。
 *
 * 结论落盘到 `$DSH_HOME/state/update-check.json`，重启后第一屏就能显示上次结果。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { highest, isNewer, isValid } from './semver.js'

/** 默认检查间隔：15 分钟。 */
export const DEFAULT_INTERVAL_MS = 15 * 60_000
/** 失败退避上限：1 小时。 */
export const MAX_BACKOFF_MS = 60 * 60_000
/** 单次 `npm view` 的超时。 */
export const CHECK_TIMEOUT_MS = 60_000
/** 插件挂载后多久跑第一次（别和启动抢带宽）。 */
export const INITIAL_DELAY_MS = 8_000

/**
 * 解析 `npm view @deepseek-ai/dsh dist-tags --json` 的输出。
 * @param {string} text 命令输出。
 * @returns {Record<string, string>} tag → 版本。
 */
export function parseDistTags(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return {}
  try {
    const parsed = JSON.parse(trimmed)
    const out = {}
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (typeof value === 'string' && isValid(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 决定「应该升到哪个版本」。
 *
 * 规则刻意保守：
 *   1. 只在 `channel`（默认 next）和 `latest` 两个轨道里挑**最高**的那个 ——
 *      `next` 落后于 `latest` 时（稳定版刚发）也能跟上；
 *   2. 只接受严格大于当前版本的候选，绝不下推一个更旧的版本 —— 我们见过
 *      `latest` 标签停在比已装版本更旧的情况，那不该变成「更新」。
 *
 * @param {object} input 输入。
 * @param {Record<string,string>} input.tags dist-tags。
 * @param {string} [input.channel] 主轨道。
 * @param {string} input.current 当前安装版本。
 * @returns {{target: string|null, updateAvailable: boolean}}
 */
export function pickTarget({ tags, channel = 'next', current }) {
  const track = highest([tags?.[channel], tags?.latest])
  if (track === null) return { target: null, updateAvailable: false }
  const candidate = isValid(current) ? highest([track, current]) : track
  return { target: candidate, updateAvailable: isNewer(candidate, current) }
}

/**
 * 建一个检查器。
 *
 * @param {object} input 参数。
 * @param {object} input.config 归一后的配置。
 * @param {object} input.paths resolvePaths 的结果。
 * @param {() => string} input.currentVersion 读当前安装版本。
 * @param {object} [input.logger] 日志。
 * @param {object} [input.deps] 测试注入点（spawn / 计时器 / 时钟）。
 * @returns {object} 检查器。
 */
export function createChecker({ config, paths, currentVersion, logger, deps = {} }) {
  const now = deps.now ?? Date.now
  const spawnProcess = deps.spawn ?? spawn
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  const env = deps.env ?? process.env
  const interval = Number.isFinite(config?.checkIntervalMs) ? Number(config.checkIntervalMs) : DEFAULT_INTERVAL_MS
  const channel = typeof config?.channel === 'string' && config.channel !== '' ? config.channel : 'next'
  const stateFile = paths.checkFile

  let state = {
    current: '',
    channel,
    tags: {},
    target: null,
    updateAvailable: false,
    lastCheckAt: 0,
    nextCheckAt: 0,
    lastError: '',
    failures: 0,
    checking: false,
  }
  let timer = null
  let inFlight = null
  let stopped = false

  /** 从磁盘恢复上次结论（没有就保持空状态）。 */
  function restore() {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (saved !== null && typeof saved === 'object') {
        state = {
          ...state,
          ...saved,
          current: currentVersionSafe(),
          checking: false,
        }
        // 落盘时合法的 target 才留；文件被手动改坏了就当没有。
        if (state.target !== null && !isValid(state.target)) state.target = null
      }
    } catch {
      /* 没有历史，等第一次检查 */
    }
    state.updateAvailable = state.target !== null && isNewer(state.target, state.current)
  }

  function currentVersionSafe() {
    try {
      return String(currentVersion() ?? '')
    } catch {
      return ''
    }
  }

  function persist() {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify({ ...state, checking: false, updatedAt: new Date(now()).toISOString() }, null, 2)}\n`)
    } catch (error) {
      logger?.warn?.(`[update-button] 状态文件写入失败：${String(error)}`)
    }
  }

  /** 快照：给路由/页面看的只读副本。 */
  function snapshot() {
    return {
      ...state,
      current: state.current || currentVersionSafe(),
      intervalMs: interval,
      stale: state.lastCheckAt !== 0 && now() - state.lastCheckAt > interval * 22 / 10,
    }
  }

  /** 排下一次检查：成功按 interval（±10% 抖动），失败指数退避。 */
  function schedule(delay) {
    if (stopped) return
    if (timer !== null) clearTimer(timer)
    const base = Number.isFinite(delay) ? delay : interval
    const jittered = Math.max(5_000, Math.round(base * (0.9 + Math.random() * 0.2)))
    state.nextCheckAt = now() + jittered
    timer = setTimer(() => {
      timer = null
      void check({ force: true })
    }, jittered)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  /** 跑一次 `npm view dist-tags`。 */
  function queryTags() {
    return new Promise((resolve) => {
      let child
      try {
        child = spawnProcess('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({ ok: false, error: String(error) })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimer(timeout)
        resolve(result)
      }
      const timeout = setTimer(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已经退出 */
        }
        finish({ ok: false, error: `npm view 超时（${CHECK_TIMEOUT_MS}ms）` })
      }, CHECK_TIMEOUT_MS)
      if (typeof timeout?.unref === 'function') timeout.unref()
      child.stdout?.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
      child.on?.('error', (error) => finish({ ok: false, error: String(error) }))
      child.on?.('close', (code) => {
        if (code !== 0) {
          finish({ ok: false, error: (stderr || `npm view 退出码 ${code}`).trim().slice(-500) })
          return
        }
        const tags = parseDistTags(stdout)
        if (Object.keys(tags).length === 0) {
          finish({ ok: false, error: 'npm view 没有返回可用版本' })
          return
        }
        finish({ ok: true, tags })
      })
    })
  }

  /**
   * 检查一次；并发调用共用同一个 Promise。
   * @param {object} [options] 选项。
   * @param {boolean} [options.force] 忽略新鲜度缓存。
   * @returns {Promise<object>} 快照。
   */
  function check({ force = false } = {}) {
    if (inFlight !== null) return inFlight
    const fresh = state.lastCheckAt !== 0 && now() - state.lastCheckAt < interval * 0.9
    if (!force && fresh) return Promise.resolve(snapshot())

    state.checking = true
    inFlight = (async () => {
      const result = await queryTags()
      state.current = currentVersionSafe()
      if (result.ok) {
        state.tags = result.tags
        const picked = pickTarget({ tags: result.tags, channel, current: state.current })
        const before = state.target
        state.target = picked.target
        state.updateAvailable = picked.updateAvailable
        state.lastCheckAt = now()
        state.lastError = ''
        state.failures = 0
        logger?.info?.(
          `[update-button] 检查完成：current=${state.current} target=${state.target ?? '?'} ` +
            `tags=${Object.entries(result.tags).map(([k, v]) => `${k}:${v}`).join(',')}` +
            (before !== state.target ? '（版本变化）' : ''),
        )
        schedule(interval)
      } else {
        state.lastError = result.error
        state.failures += 1
        const backoff = Math.min(interval * 2 ** state.failures, MAX_BACKOFF_MS)
        logger?.warn?.(`[update-button] 检查失败（第 ${state.failures} 次）：${result.error}；${Math.round(backoff / 60000)} 分钟后重试`)
        schedule(backoff)
      }
      state.checking = false
      persist()
      return snapshot()
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** 启动后台检查。 */
  function start() {
    stopped = false
    restore()
    if (state.lastCheckAt !== 0) {
      // 有历史：按剩余时间排下一次，别一启动就打 npm。
      const elapsed = now() - state.lastCheckAt
      schedule(Math.max(INITIAL_DELAY_MS, interval - elapsed))
      // 但历史太旧就立刻补一次。
      if (elapsed > interval) void check({ force: true })
    } else {
      schedule(INITIAL_DELAY_MS)
    }
  }

  /** 停掉计时器（插件卸载时）。 */
  function stop() {
    stopped = true
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  return { snapshot, check, start, stop, _state: () => state }
}
