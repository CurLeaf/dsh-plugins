/**
 * 宿主半边：把「更新这只 DSH」做成三条受鉴权的 HTTP 路由。
 *
 * 为什么要脚本 + systemd 瞬态单元，而不是在这里直接 `npm i -g`：
 *   1. 换包前必须先 `systemctl stop dsh-web`，而发这条命令的进程如果还躺在
 *      dsh-web 的 cgroup 里，systemd 会把「正在更新的进程」一起杀掉 —— 更新
 *      必然断在半新半旧的状态。所以真正的执行者必须是**服务之外**的进程：
 *      `systemd-run --user --collect` 拉起的瞬态单元。
 *   2. 换包、停服务、回读版本、起服务、健康探测这一整串是脚本事（可以手工跑、
 *      可以进日志），不是一段塞在宿主里的 Promise 链。
 *
 * 本模块只负责三件事：
 *   `GET  /api/update-button/status`  当前版本 + 上一次更新的进度（读状态文件）
 *   `GET  /api/update-button/check`   问 npm 有没有新版本（跑脚本 --check，带缓存）
 *   `POST /api/update-button/start`   把脚本塞进瞬态单元，先回 202 再动手
 *   `GET  /api/update-button/log`     只读尾部日志，方便按钮出错时给人看
 *
 * @module dsh-update-button
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChecker, DEFAULT_INTERVAL_MS } from './checker.js'
import { isNewer } from './semver.js'

/** 稳定 Loader 身份。 */
export const name = 'update-button'

export const STATUS_ROUTE = '/api/update-button/status'
export const CHECK_ROUTE = '/api/update-button/check'
export const START_ROUTE = '/api/update-button/start'
export const LOG_ROUTE = '/api/update-button/log'

/** 更新进行中时，状态文件的更新时间超过这个时长就视为「僵尸状态」。 */
const ACTIVE_WINDOW_MS = 20 * 60_000
/** 两次启动之间的最小间隔。 */
const START_COOLDOWN_MS = 10_000

const ACTIVE_PHASES = new Set([
  'checking',
  'stopping',
  'installing',
  'verifying',
  'updating-plugins',
  'starting',
  'health-check',
  'rolling-back',
])

let lastStartAt = 0


/**
 * 把 profile patch 行里的 config 归一成可用形状。
 * @param {unknown} config 原始配置。
 */
export function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const str = (key, fallback = '') =>
    typeof source[key] === 'string' && source[key].trim() !== '' ? source[key].trim() : fallback
  const num = (key, fallback) => {
    const raw = source[key]
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    return Number.isFinite(value) ? Number(value) : fallback
  }
  return {
    service: str('service', 'dsh-web'),
    tag: str('tag', 'next'),
    channel: str('channel', 'next'),
    port: num('port', 3080),
    scriptPath: str('scriptPath', ''),
    statusFile: str('statusFile', ''),
    logFile: str('logFile', ''),
    checkFile: str('checkFile', ''),
    profileDir: str('profileDir', ''),
    withPlugins: source.withPlugins === true,
    checkIntervalMs: num('checkIntervalMs', DEFAULT_INTERVAL_MS),
    updateTimeoutMs: num('updateTimeoutMs', ACTIVE_WINDOW_MS),
  }
}

/** 本包根目录（脚本与状态文件默认位置都以它为锚）。 */
function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** 解析脚本、状态文件、日志文件的绝对路径。 */
export function resolvePaths(config, env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(env.HOME ?? '/', '.dsh')
  const root = packageRoot()
  return {
    script: config.scriptPath !== '' ? config.scriptPath : join(root, 'scripts', 'dsh-update.sh'),
    statusFile: config.statusFile !== '' ? config.statusFile : join(home, 'state', 'update-status.json'),
    logFile: config.logFile !== '' ? config.logFile : join(home, 'logs', 'dsh-update.log'),
    checkFile: config.checkFile !== '' ? config.checkFile : join(home, 'state', 'update-check.json'),
    home,
    root,
  }
}

/**
 * 读当前正在运行的 DSH 安装版本。
 *
 * 宿主进程是用 `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 启动的，
 * 所以 `argv[1]` 的上一级就是安装根。取不到就退回 `npm root -g` 的约定路径。
 * @param {string[]} [argv] 进程 argv。
 * @param {string} [fallbackPrefix] 兜底前缀。
 * @returns {string} 版本号，读不到为空串。
 */
export function runningVersion(argv = process.argv, fallbackPrefix = '') {
  const candidates = []
  const entry = argv[1] ?? ''
  if (entry !== '') {
    candidates.push(join(dirname(dirname(entry)), 'package.json'))
    candidates.push(join(dirname(entry), '..', 'package.json'))
  }
  if (fallbackPrefix !== '') candidates.push(join(fallbackPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      if (pkg.name === '@deepseek-ai/dsh' || String(file).includes('/@deepseek-ai/dsh/')) {
        if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return ''
}

/** 读状态文件；读不到/坏了返回 null。 */
export function readStatusFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 状态文件里的这次更新是否还在进行。
 * @param {object|null} status 状态文件内容。
 * @param {number} [now] 当前时间。
 * @param {number} [windowMs] 活跃窗口。
 */
export function isActiveUpdate(status, now = Date.now(), windowMs = ACTIVE_WINDOW_MS) {
  if (status === null || typeof status !== 'object') return false
  if (!ACTIVE_PHASES.has(String(status.phase))) return false
  const updated = Date.parse(String(status.updatedAt ?? status.startedAt ?? ''))
  if (Number.isNaN(updated)) return false
  return now - updated < windowMs
}

/**
 * 组装 `systemd-run` 参数。
 * @param {object} input 参数。
 * @param {string} input.unit 瞬态单元名。
 * @param {string} input.script 脚本绝对路径。
 * @param {string[]} input.scriptArgs 脚本参数。
 * @param {string} input.nodeDir node 可执行文件目录（放进 PATH）。
 * @param {string} input.home $HOME。
 * @param {string} input.dshHome $DSH_HOME。
 * @param {string} [input.service] 服务名（仅用于描述）。
 * @returns {string[]} systemd-run 的 argv。
 */
export function buildSystemdRunArgs({ unit, script, scriptArgs, nodeDir, home, dshHome, service = '' }) {
  const path = [nodeDir, '/usr/local/bin', '/usr/bin', '/bin'].filter((part) => part !== '').join(':')
  return [
    '--user',
    '--collect',
    `--unit=${unit}`,
    `--description=DSH update (${service || 'no service'})`,
    `--setenv=PATH=${path}`,
    `--setenv=HOME=${home}`,
    `--setenv=DSH_HOME=${dshHome}`,
    '/bin/bash',
    script,
    ...scriptArgs,
  ]
}

/**
 * 发起更新：优先 systemd 瞬态单元，退路是脱离会话的 bash。
 * @param {object} deps 依赖注入。
 * @returns {{ok: boolean, how: string, unit?: string, error?: string}}
 */
export function launchUpdate(
  { paths, config, tag, withPlugins, unit },
  { spawnProcess = spawn, env = process.env, logger } = {},
) {
  const args = ['--service', config.service]
  args.push('--tag', tag)
  args.push('--port', String(config.port))
  if (withPlugins && config.profileDir !== '') args.push('--profile', config.profileDir)
  if (withPlugins) args.push('--with-plugins')

  const scriptArgs = [
    '--status-file', paths.statusFile,
    '--log-file', paths.logFile,
    ...args,
  ]

  const runArgs = buildSystemdRunArgs({
    unit,
    script: paths.script,
    scriptArgs,
    nodeDir: dirname(process.execPath),
    home: env.HOME ?? '/',
    dshHome: paths.home,
    service: config.service,
  })

  try {
    const child = spawnProcess('systemd-run', runArgs, { detached: true, stdio: 'ignore' })
    let spawnError = null
    child.on?.('error', (error) => {
      spawnError = error
      logger?.warn?.(`[update-button] systemd-run 启动失败：${String(error)}`)
    })
    child.unref?.()
    if (spawnError !== null) throw spawnError
    return { ok: true, how: 'systemd-run', unit }
  } catch (error) {
    logger?.warn?.(`[update-button] 退回直跑脚本（无 systemd）：${String(error)}`)
    // 没有 systemd：不碰服务（否则会把自己杀掉），只换包，随后由按钮重启。
    const fallbackArgs = scriptArgs.filter((arg, index, all) => {
      if (arg === '--service') return false
      if (all[index - 1] === '--service') return false
      return true
    })
    try {
      const child = spawnProcess('/bin/bash', [paths.script, ...fallbackArgs], {
        detached: true,
        stdio: 'ignore',
        env,
      })
      child.unref?.()
      return { ok: true, how: 'direct', unit }
    } catch (inner) {
      return { ok: false, how: 'none', error: String(inner) }
    }
  }
}

/** 读取日志尾部；大文件只读最后 256KB，别把整份日志读进内存。 */
export function readLogTail(file, tail = 60) {
  const limit = Math.min(Math.max(Number(tail) || 60, 1), 200)
  const MAX_BYTES = 256 * 1024
  let text
  try {
    const size = statSync(file).size
    if (size > MAX_BYTES) {
      const fd = openSync(file, 'r')
      const buffer = Buffer.alloc(MAX_BYTES)
      readSync(fd, buffer, 0, MAX_BYTES, size - MAX_BYTES)
      closeSync(fd)
      text = buffer.toString('utf8')
      const newline = text.indexOf('\n')
      if (newline >= 0) text = text.slice(newline + 1)
    } else {
      text = readFileSync(file, 'utf8')
    }
  } catch {
    return { lines: [], total: 0 }
  }
  const lines = text.split('\n').filter((line) => line !== '')
  return { lines: lines.slice(-limit), total: lines.length }
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 * @param {object} [config] profile patch 行里的 `config`。
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const paths = resolvePaths(settings)
  // argv[1] 是宿主入口 bin.js；万一被包装过，就用 node 所在前缀兜底。
  const installPrefix = dirname(dirname(process.execPath))
  const currentVersion = () => runningVersion(process.argv, installPrefix)
  const checker = createChecker({
    config: settings,
    paths,
    currentVersion,
    logger: ctx.logger,
  })

  /**
   * 用「正在跑的版本」重算一次结论。
   *
   * 检查器的 current 是上次检查时的快照；刚更新完还没到下一个周期时它会是旧值，
   * 直接展示会让按钮一直挂着「有新版本」。这里以进程自报版本为准，读不到才退回。
   */
  const liveSnapshot = () => {
    const snapshot = checker.snapshot()
    const running = currentVersion()
    if (running !== '') {
      snapshot.current = running
      snapshot.updateAvailable = snapshot.target !== null && isNewer(snapshot.target, running)
    }
    return snapshot
  }

  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get?.('connection') ?? scoped.connection
    const routes = connection?.fetch
    if (routes === undefined || routes === null || typeof routes.register !== 'function') {
      ctx.logger?.warn?.('[update-button] connection.fetch 不可用，更新按钮不会生效')
      return
    }

    // 后台定时检查：页面关着也在跑，结论落盘，重启后第一屏就有。
    scoped.effect(() => {
      checker.start()
      return () => checker.stop()
    }, 'update-button: periodic update check')

    scoped.effect(
      () =>
        routes.register({
          path: STATUS_ROUTE,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => {
            const status = readStatusFile(paths.statusFile)
            return Response.json({
              ok: true,
              pid: process.pid,
              running: runningVersion(),
              active: isActiveUpdate(status),
              status,
              checker: liveSnapshot(),
              paths: { script: paths.script, statusFile: paths.statusFile, logFile: paths.logFile },
            })
          },
        }),
      'update-button: status route',
    )

    scoped.effect(
      () =>
        routes.register({
          path: CHECK_ROUTE,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const url = new URL(request.url, 'http://localhost')
            const force = url.searchParams.get('force') === '1'
            const current = liveSnapshot()
            const result = force || current.lastCheckAt === 0 ? await checker.check({ force: true }) : current
            return Response.json({ ok: true, ...result, latest: result.target, running: runningVersion() })
          },
        }),
      'update-button: check route',
    )

    scoped.effect(
      () =>
        routes.register({
          path: START_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body = {}
            try {
              body = await request.json()
            } catch {
              body = {}
            }
            const now = Date.now()
            if (now - lastStartAt < START_COOLDOWN_MS) {
              return Response.json({ ok: false, error: 'cooldown', message: '刚点过一次，稍等几秒。' }, { status: 429 })
            }
            const status = readStatusFile(paths.statusFile)
            if (isActiveUpdate(status)) {
              return Response.json(
                { ok: false, error: 'busy', message: `上一次更新还在进行（${status.phase}）` },
                { status: 409 },
              )
            }
            const tag = typeof body.tag === 'string' && body.tag.trim() !== '' ? body.tag.trim() : settings.tag
            const withPlugins = body.withPlugins === true || (body.withPlugins === undefined && settings.withPlugins)
            if (!existsSync(paths.script)) {
              return Response.json(
                { ok: false, error: 'missing-script', message: `找不到更新脚本 ${paths.script}` },
                { status: 500 },
              )
            }
            lastStartAt = now
            const unit = `dsh-update-${process.pid}-${now}`
            const launched = launchUpdate(
              { paths, config: settings, tag, withPlugins, unit },
              { logger: ctx.logger },
            )
            ctx.logger?.info?.(`[update-button] start ${tag} → ${launched.how}(${unit})`)
            if (!launched.ok) {
              return Response.json({ ok: false, error: 'spawn-failed', message: launched.error ?? '无法启动更新' }, { status: 500 })
            }
            return Response.json(
              {
                ok: true,
                how: launched.how,
                unit,
                tag,
                withPlugins,
                statusFile: paths.statusFile,
                logFile: paths.logFile,
              },
              { status: 202 },
            )
          },
        }),
      'update-button: start route',
    )

    scoped.effect(
      () =>
        routes.register({
          path: LOG_ROUTE,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const url = new URL(request.url, 'http://localhost')
            return Response.json({ ok: true, ...readLogTail(paths.logFile, url.searchParams.get('tail') ?? 60) })
          },
        }),
      'update-button: log route',
    )
  })
}


