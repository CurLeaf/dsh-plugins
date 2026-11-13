#!/usr/bin/env node
/**
 * usage-billing-anchor-patch — 让 @qzsy/dsh-plugin-usage-billing 的侧栏计费入口
 * 在 DSH 0.2.2+ 上重新渲染。
 *
 * 背景：DSH 0.2.2-alpha.2 从 @deepseek-ai/dsh-client-ui-primitives 移除了
 * `useAnchoredPosition`（升级指南 v0.2.2-alpha.2/css-anchored-menus：改用 CSS
 * anchor positioning，Menu 的 getAnchorRect 换成 anchorRef / anchorPoint）。
 * 插件的侧栏入口组件在渲染时直接调 `(0,m.useAnchoredPosition)(...)`，于是抛
 * `TypeError: (0, m.useAnchoredPosition) is not a function`，DSH 把整条
 * `sidebar.footer.action` slot entry 摘掉 —— 侧栏那张「本月费用」卡就没了；
 * 设置 → 计费 页仍然正常，因为它不走这个 hook。
 *
 * 做法：在 bundle 里插入一个等价的本地实现（量测 anchor/panel、按 side/gap/
 * margin 定位、夹在视口内），并把调用点换过去。只改两处字符串，幂等。
 *
 * 用法：
 *   node scripts/usage-billing-anchor-patch.mjs            # 打补丁
 *   node scripts/usage-billing-anchor-patch.mjs --check    # 只报状态
 *   node scripts/usage-billing-anchor-patch.mjs --restore  # 从 .orig 还原
 *   node scripts/usage-billing-anchor-patch.mjs /path/to/dist/client.js
 *
 * 插件升级会覆盖 dist/client.js，升级后重跑一次即可。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = '/* dsh-ub-anchor patch v1 */'
const DEFAULT_CLIENT = path.join(
  os.homedir(),
  '.dsh',
  'profiles',
  'web',
  'node_modules',
  '@qzsy',
  'dsh-plugin-usage-billing',
  'dist',
  'client.js'
)

const args = process.argv.slice(2)
const command = args.includes('--restore') ? 'restore' : args.includes('--check') ? 'check' : 'apply'
const target = path.resolve(args.find((a) => !a.startsWith('--')) ?? DEFAULT_CLIENT)

if (!fs.existsSync(target)) {
  console.error(`usage-billing-anchor-patch: 找不到 ${target}`)
  process.exit(2)
}

const source = fs.readFileSync(target, 'utf8')
const original = `${target}.orig`

/** React、primitives 的模块别名在压缩产物里是单字母，按 require 调用反查。 */
function aliasOf(specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = source.match(
    new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*[A-Za-z_$][\\w$]*\\(\\s*["\`']${escaped}["\`']\\s*\\)`)
  )
  return m ? m[1] : null
}

const react = aliasOf('react')
const primitives = aliasOf('@deepseek-ai/dsh-client-ui-primitives')
const callSite = `${primitives}.useAnchoredPosition)(`

function shim() {
  return `${MARKER}
	function __UB_useAnchoredPosition(o) {
		var s = (0, ${react}.useState)({ visibility: "hidden", left: 0, top: 0 });
		var pos = s[0], setPos = s[1];
		(0, ${react}.useLayoutEffect)(function () {
			if (!o.open) { setPos({ visibility: "hidden", left: 0, top: 0 }); return }
			function place() {
				var anchor = o.anchorRef && o.anchorRef.current;
				var panel = o.panelRef && o.panelRef.current;
				if (!anchor || !panel) return;
				var r = anchor.getBoundingClientRect();
				var w = panel.offsetWidth || 260, h = panel.offsetHeight || 120;
				var gap = o.gap == null ? 8 : o.gap, margin = o.margin == null ? 12 : o.margin;
				var left = r.left;
				var top = o.side === "top" ? r.top - h - gap : r.bottom + gap;
				var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
				if (left + w > vw - margin) left = vw - w - margin;
				if (left < margin) left = margin;
				if (top + h > vh - margin) top = Math.max(margin, r.top - h - gap);
				if (top < margin) top = margin;
				setPos({ visibility: "visible", left: left, top: top });
			}
			place();
			var timer = setTimeout(place, 0);
			window.addEventListener("resize", place);
			window.addEventListener("scroll", place, true);
			return function () {
				clearTimeout(timer);
				window.removeEventListener("resize", place);
				window.removeEventListener("scroll", place, true);
			};
		}, [o.open, o.side, o.gap, o.margin]);
		return pos;
	}
	`
}

const patched = source.includes(MARKER)
const hasSite = source.includes(callSite)

if (command === 'check') {
  console.log(
    `${target}: ${patched ? 'patched' : hasSite ? 'unpatched' : 'unknown'}` +
      (!patched && !hasSite ? '（找不到 useAnchoredPosition 调用点，可能插件已自行适配）' : '')
  )
  process.exit(patched ? 0 : 1)
}

if (command === 'restore') {
  if (!fs.existsSync(original)) {
    console.error(`usage-billing-anchor-patch: 没有 ${original}，无法还原`)
    process.exit(2)
  }
  fs.copyFileSync(original, target)
  console.log(`restored ${target}`)
  process.exit(0)
}

if (patched) {
  console.log(`already patched: ${target}`)
  process.exit(0)
}
if (!hasSite) {
  console.error(
    `usage-billing-anchor-patch: ${target} 里找不到 ${callSite}；` +
      '插件可能已适配新 primitives，未做改动'
  )
  process.exit(1)
}
if (!react || !primitives) {
  console.error('usage-billing-anchor-patch: 解析不到 react / primitives 的模块别名，未做改动')
  process.exit(1)
}

const anchor = 'function be('
const at = source.indexOf(anchor)
if (at < 0) {
  console.error('usage-billing-anchor-patch: 找不到插入点 function be(，未做改动')
  process.exit(1)
}

const next =
  source.slice(0, at) +
  shim() +
  source.slice(at).replace(callSite, '__UB_useAnchoredPosition)(')

if (!fs.existsSync(original)) fs.copyFileSync(target, original)
fs.writeFileSync(target, next)
console.log(`patched ${target}`)
console.log(`  react=${react} primitives=${primitives} backup=${original}`)
