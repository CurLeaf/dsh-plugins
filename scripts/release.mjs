#!/usr/bin/env node
/**
 * 发版：把工作区里「本地版本 > npm 上的版本」的包按顺序发布，并给每个发出去的
 * 版本打一个 `<包名>@<版本>` 的 tag。
 *
 * 只做减法，不做加法：不自动 bump 版本、不自动改 changelog。版本是手写的，
 * 发布只是把已经写好的东西送出去。用 `--dry-run` 先看会发什么。
 *
 * 用法
 *   pnpm release --dry-run      # 只打印计划
 *   pnpm release                # 真发
 *   pnpm release --otp 123456   # 带 2FA 一次性口令
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGES = join(ROOT, 'packages')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const otpIndex = argv.indexOf('--otp')
const otp = otpIndex === -1 ? undefined : argv[otpIndex + 1]

/** 跑一条命令并回传 stdout；失败时回传 undefined（用于探测 npm 状态）。 */
function tryRun(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
  } catch (error) {
    if (options.rethrow === true) throw error
    return undefined
  }
}

/** npm 上这个包的最新版本，没有这个包时是 undefined。 */
function publishedVersion(name) {
  return tryRun('npm', ['view', name, 'version'])
}

/** semver 比较只关心「本地是不是比线上新」，够用就好。 */
function newerThan(a, b) {
  const parse = (v) => v.split('-')[0].split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  // 同版本号时，正式版比预发布版新
  return a.includes('-') && !b.includes('-')
}

const plan = []
for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(PACKAGES, entry.name)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  if (manifest.private === true || typeof manifest.name !== 'string') continue
  const local = manifest.version
  const remote = publishedVersion(manifest.name)
  const state = remote === undefined ? 'new' : newerThan(local, remote) ? 'bump' : 'skip'
  plan.push({ dir, name: manifest.name, version: local, remote, state })
}

if (plan.length === 0) {
  console.log('没有找到可发布的包')
  process.exit(0)
}

let released = 0
for (const item of plan) {
  const label = `${item.name}@${item.version}`
  if (item.state === 'skip') {
    console.log(`- ${label}: 已在 npm 上（${item.remote}），跳过`)
    continue
  }
  const why = item.state === 'new' ? 'npm 上还没有' : `线上是 ${item.remote}`
  if (dryRun) {
    console.log(`- ${label}: 会发布（${why}）`)
    released += 1
    continue
  }
  console.log(`- ${label}: 发布中（${why}）`)
  const args = ['publish', '--access', 'public', '--no-git-checks', '--tag', 'latest']
  if (otp !== undefined) args.push('--otp', otp)
  tryRun('pnpm', args, { cwd: item.dir, rethrow: true, stdio: 'inherit' })
  tryRun('git', ['tag', label], { cwd: ROOT, rethrow: false })
  released += 1
}

console.log(dryRun ? `\n${released} 个包会被发布（dry-run，未写入任何东西）` : `\n${released} 个包已发布`)
if (!dryRun && released > 0) console.log('tag 已在本地创建，推送：git push --tags')
