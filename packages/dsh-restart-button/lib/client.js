/**
 * 浏览器半边：在侧栏最下面（手机上是抽屉「用户头像那一栏」上面）加一行「重启 DSH」。
 *
 * 只做三件事：
 *
 *   1. 通过官方槽位 `sidebar.footer.action` 注册一个动作行 —— 桌面侧栏和手机抽屉
 *      用的是同一个 SidebarRoot，注册一次两边都有；`wide` 决定是整行还是 36×36 图标；
 *   2. 两段式确认：第一下进入「确认重启？」（4 秒后自动收回），第二下才真正发请求，
 *      避免手机上误触把正在跑的会话掐掉；
 *   3. 重启后轮询 `api/restart-button/status`，pid 变了就刷新页面；等不到就提示去
 *      终端检查，而不是一直转圈。
 *
 * 不碰宿主 DOM 结构，也不改别人的样式：只往 <head> 里放一份自己的 <style>。
 */
window.__ModuleLoader__.load({
	id: 'dsh-restart-button',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const { useCallback, useEffect, useRef, useState } = React

		/** 宿主路由，相对路径：转发部署（子路径）下也能落到同一处。 */
		const STATUS_URL = 'api/restart-button/status'
		const RESTART_URL = 'api/restart-button/restart'
		/** 自己的样式表 id；卸载时按它清理。 */
		const STYLE_ID = 'dsh-restart-button/styles'
		/** 槽位里的排序：挨着「更多」与计费行，仍在设置（头像）行上面。 */
		const SLOT_ORDER = 30
		/** 第一下之后等多久收回确认态。 */
		const ARM_TIMEOUT_MS = 4000
		/** 重启后最多等多久。 */
		const RESTART_TIMEOUT_MS = 45000
		/** 轮询间隔。 */
		const POLL_MS = 700

		const CSS = `
/* 脚部动作区原本只装「计费」一行；多一行就换行，别把两行挤在同一行里。
   这两个选择器用了宿主的 CSS Module 后缀（_footerActions / _collapsed），
   DSH 升级改名时最坏退化成并排，不会消失。 */
[class*="_footerActions"] { flex-wrap: wrap; row-gap: 2px; }
[class*="_collapsed"] [class*="_footerActions"] { flex-direction: column; align-items: center; gap: 6px; }

.dsh-restart-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 0 100%;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  margin: 0 2px 2px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #b6b6bb);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dsh-restart-row:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-restart-row:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe)); outline-offset: -2px; }
.dsh-restart-row[data-armed="true"] { color: var(--dsw-alias-state-warn-primary, #f0a020); background: var(--dsw-alias-state-warn-tertiary, rgba(240, 160, 32, 0.12)); }
.dsh-restart-row[data-busy="true"] { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-restart-row svg { flex: none; width: 18px; height: 18px; }
.dsh-restart-row .dsh-restart-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-restart-row .dsh-restart-hint { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-restart-row[data-wide="false"],
[class*="_collapsed"] .dsh-restart-row {
  flex: none;
  justify-content: center;
  width: 36px;
  height: 36px;
  min-height: 36px;
  margin: 0 0 2px;
  padding: 0;
  border-radius: var(--dsw-radius-md, 8px);
}
.dsh-restart-row[data-wide="false"] .dsh-restart-label,
.dsh-restart-row[data-wide="false"] .dsh-restart-hint { display: none; }

.dsh-restart-toast {
  position: fixed;
  left: 50%;
  top: calc(60px + env(safe-area-inset-top, 0px));
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 10px;
  width: max-content;
  max-width: min(90vw, 360px);
  padding: 9px 14px;
  border-radius: 14px;
  background: var(--dsw-alias-toast-bg, rgba(20, 20, 22, 0.92));
  color: var(--dsw-alias-toast-label, #fff);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(8px);
  font-size: 13px;
  line-height: 18px;
  transform: translateX(-50%);
  animation: dsh-restart-in 180ms ease;
}
@keyframes dsh-restart-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
.dsh-restart-toast[data-tone="error"] { color: #ffb4ad; }
.dsh-restart-toast[data-tone="ok"] { color: #9be6a8; }
.dsh-restart-toast-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-restart-toast-title { font-size: 13px; line-height: 18px; }
.dsh-restart-toast-detail { font-size: 11px; line-height: 15px; opacity: 0.72; }
.dsh-restart-toast button {
  flex: none;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.14);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dsh-restart-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.28);
  border-top-color: currentColor;
  animation: dsh-restart-spin 800ms linear infinite;
}
@keyframes dsh-restart-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-restart-spinner { animation-duration: 2.4s; }
  .dsh-restart-toast { animation: none; }
}
`

		/**
		 * 幂等地把样式表放进 <head>。
		 * @returns {() => void} 移除函数。
		 */
		function installStyles() {
			if (typeof document === 'undefined') return () => {}
			const existing = document.getElementById(STYLE_ID)
			if (existing !== null) return () => {}
			const tag = document.createElement('style')
			tag.id = STYLE_ID
			tag.textContent = CSS
			document.head?.appendChild(tag)
			return () => {
				tag.remove()
			}
		}

		/** 等待 ms 毫秒。 */
		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms))
		}

		/**
		 * 读一次宿主状态；失败返回 null（重启过程中这是常态）。
		 * @returns {Promise<object | null>}
		 */
		async function readStatus() {
			try {
				const response = await fetch(STATUS_URL, {
					cache: 'no-store',
					credentials: 'same-origin',
					headers: { accept: 'application/json' },
				})
				if (!response.ok) return null
				return await response.json()
			} catch {
				return null
			}
		}

		/** 提示条：一个挂在 body 上的固定胶囊，重启期间常驻。 */
		function createToast() {
			const el = document.createElement('div')
			el.className = 'dsh-restart-toast'
			el.setAttribute('role', 'status')
			el.setAttribute('aria-live', 'polite')
			const spinner = document.createElement('span')
			spinner.className = 'dsh-restart-spinner'
			spinner.setAttribute('aria-hidden', 'true')
			const body = document.createElement('span')
			body.className = 'dsh-restart-toast-text'
			const title = document.createElement('span')
			title.className = 'dsh-restart-toast-title'
			const detail = document.createElement('span')
			detail.className = 'dsh-restart-toast-detail'
			body.append(title, detail)
			el.append(spinner, body)
			document.body?.appendChild(el)

			return {
				/**
				 * 改文案与语气。
				 * @param {string} message 主文案（一行）。
				 * @param {'info'|'ok'|'error'} [tone] 语气。
				 * @param {{label: string, onClick: Function}} [action] 可选按钮。
				 * @param {string} [sub] 第二行小字（可省略）。
				 */
				set(message, tone = 'info', action, sub = '') {
					el.dataset.tone = tone
					title.textContent = message
					detail.textContent = sub
					detail.style.display = sub === '' ? 'none' : ''
					for (const button of el.querySelectorAll('button')) button.remove()
					spinner.style.display = tone === 'info' ? '' : 'none'
					if (action) {
						const button = document.createElement('button')
						button.type = 'button'
						button.textContent = action.label
						button.addEventListener('click', action.onClick, { once: true })
						el.appendChild(button)
					}
				},
				/** 移除。 */
				close() {
					el.remove()
				},
			}
		}

		/**
		 * 等进程换一个 pid。
		 * @param {number | null} beforePid 重启前的 pid。
		 * @returns {Promise<object | null>} 新状态；超时为 null。
		 */
		async function waitForRestart(beforePid) {
			const deadline = Date.now() + RESTART_TIMEOUT_MS
			while (Date.now() < deadline) {
				await sleep(POLL_MS)
				const status = await readStatus()
				if (status === null) continue
				if (typeof beforePid !== 'number' || status.pid !== beforePid) return status
			}
			return null
		}

		/** 电源图标（描述「重启」而不是「关闭」：线在圆环上断开）。 */
		function PowerIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
				h('path', {
					d: 'M12 3.5v8',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
				}),
				h('path', {
					d: 'M6.4 6.9a8 8 0 1 0 11.2 0',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
				}),
			)
		}

		/**
		 * 槽位组件。
		 * @param {{wide?: boolean}} props 侧栏给的列状态。
		 */
		function RestartAction({ wide = true }) {
			const [armed, setArmed] = useState(false)
			const [busy, setBusy] = useState(false)
			const armTimer = useRef(0)
			const mounted = useRef(true)
			const toast = useRef(null)

			useEffect(() => {
				mounted.current = true
				return () => {
					mounted.current = false
					if (armTimer.current !== 0) clearTimeout(armTimer.current)
					toast.current?.close()
					toast.current = null
				}
			}, [])

			const disarm = useCallback(() => {
				if (armTimer.current !== 0) {
					clearTimeout(armTimer.current)
					armTimer.current = 0
				}
				setArmed(false)
			}, [])

			const restart = useCallback(async () => {
				disarm()
				setBusy(true)
				const before = await readStatus()
				const label = typeof before?.plan?.label === 'string' ? before.plan.label : ''
				toast.current = toast.current ?? createToast()
				toast.current.set('正在重启 DSH…', 'info', undefined, label)

				try {
					const response = await fetch(RESTART_URL, {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ source: 'sidebar' }),
					})
					if (!response.ok) throw new Error(`HTTP ${response.status}`)
				} catch {
					toast.current.set('重启请求没有送达', 'error', {
						label: '关闭',
						onClick: () => {
							toast.current?.close()
							toast.current = null
						},
					}, '服务可能已经断开，请检查终端')
					if (mounted.current) setBusy(false)
					return
				}

				toast.current.set('正在重启 DSH…', 'info', undefined, '页面会在服务回来后自动刷新')
				const status = await waitForRestart(typeof before?.pid === 'number' ? before.pid : null)
				if (status !== null) {
					toast.current?.set('已重启，正在刷新…', 'ok')
					await sleep(400)
					window.location.reload()
					return
				}

				toast.current?.set('没等到 DSH 回来', 'error', {
					label: '重试',
					onClick: () => {
						toast.current?.close()
						toast.current = null
						void restart()
					},
				}, '请在终端检查 dsh-web 是否已重新启动')
				if (mounted.current) setBusy(false)
			}, [disarm])

			const onClick = useCallback(() => {
				if (busy) return
				if (!armed) {
					setArmed(true)
					if (armTimer.current !== 0) clearTimeout(armTimer.current)
					armTimer.current = setTimeout(() => {
						armTimer.current = 0
						if (mounted.current) setArmed(false)
					}, ARM_TIMEOUT_MS)
					return
				}
				void restart()
			}, [armed, busy, restart])

			const label = busy ? '重启中…' : armed ? '确认重启？' : '重启 DSH'
			const title = busy
				? '正在重启 DSH'
				: armed
					? '再点一次确认：会中断正在运行的会话'
					: '重启 DSH 服务（会中断正在运行的会话）'

			return h(
				'button',
				{
					type: 'button',
					className: 'dsh-restart-row',
					'data-wide': String(wide),
					'data-armed': String(armed),
					'data-busy': String(busy),
					'data-dsh-restart': 'true',
					title,
					'aria-label': label,
					'aria-pressed': armed,
					disabled: busy,
					onClick,
					onBlur: disarm,
				},
				h(PowerIcon),
				h('span', { className: 'dsh-restart-label' }, label),
				armed ? h('span', { className: 'dsh-restart-hint' }, '再点一次') : null,
			)
		}
		RestartAction.displayName = 'RestartAction'

		/** 需要槽位注册表。 */
		const inject = ['slots']

		/**
		 * 插件入口。
		 * @param {object} ctx 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => installStyles(), 'restart-button: styles')
			ctx.slots.inject('sidebar.footer.action', () =>
				ctx.slots.register(
					{
						name: 'sidebar.footer.action',
						id: 'restart-button',
						order: SLOT_ORDER,
						label: '重启 DSH',
					},
					RestartAction,
				),
			)
		}

		return { name: 'restart-button', inject, apply }
	},
})
