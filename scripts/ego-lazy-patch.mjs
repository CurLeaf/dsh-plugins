#!/usr/bin/env node
/**
 * ego-lazy-patch — 让 dsh-ego-browser 的 35 个 ego_* 工具变成「常驻 10 个 + 首次调用后补齐」。
 *
 * 背景：ego_* 的 schema 占每次请求 33.5KB（当前工具清单 66KB 的 51%），但 30 天里只有
 * 14% 的会话用过浏览器。常驻集选的是使用率最高的入口工具（js/script/screenshot/
 * navigate/wait/click/fill/space_open/status/help，合计约 10KB），其余 25 个在第一次
 * 任意 ego_* 调用时注册；客户端 UI（观察窗/设置页）不受影响，因为包里只是改了注册时机。
 *
 * 用法：
 *   node scripts/ego-lazy-patch.mjs            # 打补丁（默认 ~/.dsh/profiles/web 下的包）
 *   node scripts/ego-lazy-patch.mjs --check    # 只检查当前状态
 *   node scripts/ego-lazy-patch.mjs --restore  # 从 .orig 还原
 *   node scripts/ego-lazy-patch.mjs /path/to/dsh-ego-browser
 *
 * dsh-ego-browser 升级会覆盖 lib/index.js，升级后重跑一次即可（脚本幂等）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const MARKER = '/* dsh-ego-lazy patch v1: eager core + deferred registration */'
const DEFAULT_PKG = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-ego-browser')
const EAGER = [
  'ego_space_open',
  'ego_status',
  'ego_navigate',
  'ego_js',
  'ego_script',
  'ego_screenshot',
  'ego_click',
  'ego_fill',
  'ego_wait',
  'ego_help'
]

const HEAD_SOURCE = '\tconst reg = (tool) => {\n\t\tconst execute = tool.execute;\n\t\ttool.execute = (args, exec) => {\n\t\t\tnoteEgoToolUse(callingSessionId(exec));\n\t\t\treturn execute(args, exec);\n\t\t};\n'
const HEAD_PATCHED = `${MARKER}
	const EGO_LAZY_EAGER = new Set([
${EAGER.map((name) => `		"${name}"`).join(',\n')}
	]);
	const egoDeferredTools = [];
	let egoDeferredFlushed = false;
	let egoFlushHook = null;
	const registerEgoTool = (tool) => {
		const execute = tool.execute;
		tool.execute = (args, exec) => {
			if (egoFlushHook !== null) {
				const hook = egoFlushHook;
				egoFlushHook = null;
				try {
					hook();
				} catch (error) {
					ctx.logger?.warn?.(\`ego-browser: lazy tool activation failed: \${error?.message ?? error}\`);
				}
			}
			noteEgoToolUse(callingSessionId(exec));
			return execute(args, exec);
		};
`

const TAIL_SOURCE = '\t\tconst dispose = ctx.tools.register(tool);\n\t\tctx.effect?.(() => dispose);\n\t};\n'
const TAIL_PATCHED = `\t\tconst dispose = ctx.tools.register(tool);\n\t\tctx.effect?.(() => dispose);\n\t};\n\tconst flushEgoDeferred = () => {
		if (egoDeferredFlushed) return;
		egoDeferredFlushed = true;
		for (const tool of egoDeferredTools.splice(0)) registerEgoTool(tool);
	};
	egoFlushHook = flushEgoDeferred;
	const reg = (tool) => {
		if (!egoDeferredFlushed && !EGO_LAZY_EAGER.has(tool.name)) {
			egoDeferredTools.push(tool);
			return;
		}
		registerEgoTool(tool);
	};
`

function targetFromArgv(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  return positional[0] !== undefined ? path.resolve(positional[0]) : DEFAULT_PKG
}

function statusOf(file) {
  const source = fs.readFileSync(file, 'utf8')
  if (source.includes(MARKER)) return 'patched'
  if (source.includes(HEAD_SOURCE) && source.includes(TAIL_SOURCE)) return 'clean'
  return 'unknown'
}

function check(file) {
  return spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
}

function applyPatch(pkgDir) {
  const file = path.join(pkgDir, 'lib', 'index.js')
  if (!fs.existsSync(file)) throw new Error(`not found: ${file}`)
  const current = statusOf(file)
  if (current === 'patched') {
    console.log(`already patched: ${file}`)
    return
  }
  if (current !== 'clean') {
    throw new Error(
      `unexpected bundle shape in ${file}: upstream changed the registration block; update this script's anchors before retrying`
    )
  }
  const source = fs.readFileSync(file, 'utf8')
  const headCount = source.split(HEAD_SOURCE).length - 1
  const tailCount = source.split(TAIL_SOURCE).length - 1
  if (headCount !== 1 || tailCount !== 1) {
    throw new Error(`anchor uniqueness broken (head=${headCount}, tail=${tailCount}); refusing to patch`)
  }
  const backup = `${file}.orig`
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, source)
  const patched = source.replace(HEAD_SOURCE, HEAD_PATCHED).replace(TAIL_SOURCE, TAIL_PATCHED)
  fs.writeFileSync(file, patched)
  const syntax = check(file)
  if (syntax.status !== 0) {
    fs.writeFileSync(file, source)
    throw new Error(`syntax check failed, reverted:\n${syntax.stderr}`)
  }
  console.log(`patched ${file}`)
  console.log(`  eager tools: ${EAGER.length} (${EAGER.join(', ')})`)
  console.log('  deferred:    remaining ego_* tools, registered on the first ego_* call')
  console.log(`  backup:      ${backup}`)
}

function restore(pkgDir) {
  const file = path.join(pkgDir, 'lib', 'index.js')
  const backup = `${file}.orig`
  if (!fs.existsSync(backup)) throw new Error(`no backup found: ${backup}`)
  fs.copyFileSync(backup, file)
  const syntax = check(file)
  if (syntax.status !== 0) throw new Error(`restored file failed syntax check:\n${syntax.stderr}`)
  console.log(`restored ${file} from ${backup}`)
}

const argv = process.argv.slice(2)
const pkgDir = targetFromArgv(argv)
const file = path.join(pkgDir, 'lib', 'index.js')
try {
  if (argv.includes('--restore')) restore(pkgDir)
  else if (argv.includes('--check')) console.log(`${file}: ${statusOf(file)}`)
  else applyPatch(pkgDir)
} catch (error) {
  console.error(`ego-lazy-patch: ${error.message}`)
  process.exitCode = 1
}
