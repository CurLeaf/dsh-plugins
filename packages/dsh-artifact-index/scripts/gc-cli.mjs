#!/usr/bin/env node
/**
 * 终端侧的 gc：不依赖 DSH 进程，直接用本包源码跑「扫引用 → 算孤儿 → 删」。
 * 好处是改完 lib/ 立刻可用，不必等重启。
 *
 *   pnpm gc            # 空跑，只报告
 *   pnpm gc --yes      # 真删（默认 3 天保护期）
 *   pnpm gc --yes --force   # 引用扫描异常时仍强删（危险）
 */
import { formatBytes } from '../lib/store.js'
import {
  gcSafetyBlockReason,
  planOrphans,
  scanObjects,
  scanSessionReferences,
  sweepOrphans,
} from '../lib/gc.js'

const argv = process.argv.slice(2)
const yes = argv.includes('--yes')
const force = argv.includes('--force')
const minAgeArg = argv.find((arg) => arg.startsWith('--min-age-days='))
const minAgeDays = minAgeArg ? Number(minAgeArg.split('=')[1]) : 3
if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
  console.error('--min-age-days 需要非负数字，例如 --min-age-days=7')
  process.exit(2)
}
const minAgeMs = minAgeDays * 86_400_000

const started = Date.now()
const scan = await scanSessionReferences({
  onProgress: (done, total) => {
    if (total >= 50 && done % 100 === 0) process.stderr.write(`扫描会话日志 ${done}/${total}\n`)
  },
})
const objects = await scanObjects({})
const plan = planOrphans({ objects, referenced: scan.ids, minAgeMs })

console.log(
  `会话日志 ${scan.files} 个（CLI ${scan.viaCli}，失败 ${scan.failed}，只读到首帧 ${scan.lossy}）；命中 ${scan.ids.size} 个引用 id`,
)
console.log(
  `对象库 ${plan.scanned} 个：被引用 ${plan.referenced}，保护期内 ${plan.fresh}，可回收 ${plan.orphans.length} 个 / ${formatBytes(plan.bytes)}`,
)

const blockReason = gcSafetyBlockReason({ scan, plan, force })
if (blockReason !== null) {
  console.error(`\n拒绝删除：${blockReason}。\n修好扫描（确认 zstd 可用）后重试；确需强删加 --force。`)
  process.exit(1)
}
if (!yes) {
  console.log('\n空跑，没有删任何东西。确认后：pnpm gc --yes')
} else if (plan.orphans.length > 0) {
  const swept = await sweepOrphans(plan.orphans)
  console.log(`已删除 ${swept.deleted} 个对象，回收 ${formatBytes(swept.bytes)}${swept.failed > 0 ? `（失败 ${swept.failed}）` : ''}。`)
} else {
  console.log('没有可回收对象。')
}
console.error(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
