/**
 * 浏览器半边：把「重启」按钮放进侧栏最下面那一行（账号 / 头像行）的右端。
 *
 * 桌面侧栏和手机抽屉用的是同一个 SidebarRoot，所以只需要盯一个锚点：
 *
 *   [data-slot="sidebar.settings"] > 行容器（position: relative，正是头像行）
 *
 * 按钮绝对定位贴在行的右侧，不动宿主的 flex 布局：行里的账号按钮仍然是通栏，
 * 只是右端那一小块被我们的按钮盖住。React 重渲染把行删掉/重建时，MutationObserver
 * 会把按钮重新挂回去；侧栏折叠成 56px 导轨时（账号行只剩一个头像图标）隐藏，
 * 不给宿主添乱。
 *
 * 交互：第一下进入「确认重启？」（4 秒自动收回），第二下才 POST；之后顶部弹提示，
 * 轮询 pid 变化后自动刷新页面。
 */
window.__ModuleLoader__.load({
	id: 'dsh-restart-button',
	factory(require) {
		/** 宿主路由，相对路径：转发部署（子路径）下也能落到同一处。 */
		const STATUS_URL = 'api/restart-button/status'
		const RESTART_URL = 'api/restart-button/restart'
		/** 自己的样式表 id；卸载时按它清理。 */
		const STYLE_ID = 'dsh-restart-button/styles'
		/** 锚点：账号行所在的槽位（槽名是宿主的稳定契约）。 */
		const SETTINGS_SLOT = '[data-slot="sidebar.settings"]'
		/** 第一下之后等多久收回确认态。 */
		const ARM_TIMEOUT_MS = 4000
		/** 重启后最多等多久。 */
		const RESTART_TIMEOUT_MS = 45000
		/** 轮询间隔。 */
		const POLL_MS = 700

		const POWER_SVG =
			'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
			'<path d="M12 3.5v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
			'<path d="M6.4 6.9a8 8 0 1 0 11.2 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
			'</svg>'

		const CSS = `
.dsh-restart-inline {
  position: absolute;
  right: 8px;
  top: 50%;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #b6b6bb);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transform: translateY(-50%);
  -webkit-tap-highlight-color: transparent;
}
.dsh-restart-inline:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-restart-inline:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe)); outline-offset: -2px; }
.dsh-restart-inline[data-armed="true"] {
  padding: 0 10px;
  color: var(--dsw-alias-state-warn-primary, #f0a020);
  background: var(--dsw-alias-state-warn-tertiary, rgba(240, 160, 32, 0.12));
}
.dsh-restart-inline[data-busy="true"] { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-restart-inline[hidden] { display: none; }
.dsh-restart-inline svg { flex: none; width: 17px; height: 17px; }
.dsh-restart-inline-label { white-space: nowrap; }

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
		 * @returns {() => void} 移除函数（只移除自己装的）。
		 */
		function installStyles() {
			if (typeof document === 'undefined') return () => {}
			const existing = document.getElementById(STYLE_ID)
			if (existing !== null) return () => {}
			const tag = document.createElement('style')
			tag.id = STYLE_ID
			tag.textContent = CSS
			document.head?.appendChild(tag)
			return () => tag.remove()
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

		/** 顶部提示条：一个挂在 body 上的固定胶囊，重启期间常驻。 */
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
		 * @param {() => boolean} [isAlive] 插件是否还在挂载（卸载后立刻停）。
		 * @returns {Promise<object | null>} 新状态；超时为 null。
		 */
		async function waitForRestart(beforePid, isAlive = () => true) {
			const deadline = Date.now() + RESTART_TIMEOUT_MS
			while (Date.now() < deadline) {
				await sleep(POLL_MS)
				if (!isAlive()) return null
				const status = await readStatus()
				if (status === null) continue
				if (typeof beforePid !== 'number' || status.pid !== beforePid) return status
			}
			return null
		}

		/** 不需要宿主服务：按钮是纯 DOM，路由是 fetch。 */
		const inject = []

		/**
		 * 插件入口。
		 * @param {object} ctx 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			if (typeof document === 'undefined' || typeof window === 'undefined') return

			let disposed = false
			let armed = false
			let busy = false
			let armTimer = 0
			let frame = 0
			let toast = null

			const styleCleanup = installStyles()
			const cleanups = [styleCleanup]

			/* ---------- 按钮 ---------- */

			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'dsh-restart-inline'
			button.dataset.dshRestart = 'true'
			button.dataset.armed = 'false'
			button.dataset.busy = 'false'
			button.innerHTML = POWER_SVG
			const label = document.createElement('span')
			label.className = 'dsh-restart-inline-label'
			button.appendChild(label)

			/** 按状态刷新按钮的文案与无障碍名。 */
			const render = () => {
				button.dataset.armed = String(armed)
				button.dataset.busy = String(busy)
				label.textContent = busy ? '重启中…' : armed ? '确认重启？' : '重启'
				button.setAttribute('aria-label', busy ? '正在重启 DSH' : armed ? '确认重启 DSH' : '重启 DSH')
				button.title = busy
					? '正在重启 DSH'
					: armed
						? '再点一次确认：会中断正在运行的会话'
						: '重启 DSH 服务（会中断正在运行的会话）'
			}

			/** 收回确认态。 */
			const disarm = () => {
				if (armTimer !== 0) {
					window.clearTimeout(armTimer)
					armTimer = 0
				}
				if (armed) {
					armed = false
					render()
				}
			}

			/** 真正发重启请求，并等待进程回来。 */
			const restart = async () => {
				disarm()
				busy = true
				render()
				const before = await readStatus()
				const plan = typeof before?.plan?.label === 'string' ? before.plan.label : ''
				toast = toast ?? createToast()
				toast.set('正在重启 DSH…', 'info', undefined, plan)

				try {
					const response = await fetch(RESTART_URL, {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ source: 'account-row' }),
					})
					if (!response.ok) throw new Error(`HTTP ${response.status}`)
				} catch {
					toast.set('重启请求没有送达', 'error', {
						label: '关闭',
						onClick: () => {
							toast?.close()
							toast = null
						},
					}, '服务可能已经断开，请检查终端')
					busy = false
					render()
					return
				}

				toast.set('正在重启 DSH…', 'info', undefined, '页面会在服务回来后自动刷新')
				const status = await waitForRestart(
					typeof before?.pid === 'number' ? before.pid : null,
					() => !disposed,
				)
				if (disposed) return
				if (status !== null) {
					toast?.set('已重启，正在刷新…', 'ok')
					await sleep(400)
					window.location.reload()
					return
				}

				toast?.set('没等到 DSH 回来', 'error', {
					label: '重试',
					onClick: () => {
						toast?.close()
						toast = null
						void restart()
					},
				}, '请在终端检查 dsh-web 是否已重新启动')
				busy = false
				render()
			}

			button.addEventListener('click', (event) => {
				// 按钮盖在账号行的右端：别让点重启变成点开账号菜单
				event.preventDefault()
				event.stopPropagation()
				if (busy) return
				if (!armed) {
					armed = true
					render()
					if (armTimer !== 0) window.clearTimeout(armTimer)
					armTimer = window.setTimeout(() => {
						armTimer = 0
						disarm()
					}, ARM_TIMEOUT_MS)
					return
				}
				void restart()
			})
			button.addEventListener('blur', disarm)

			/* ---------- 挂载到账号行 ---------- */

			/**
			 * 找到账号行：`[data-slot="sidebar.settings"]` 的第一个元素子节点。
			 * @returns {Element | null}
			 */
			const findRow = () => {
				const slot = document.querySelector(SETTINGS_SLOT)
				const row = slot === null ? null : slot.firstElementChild
				if (row === null) return null
				return row.querySelector('button') === null ? null : row
			}

			/**
			 * 账号行是否处于折叠导轨（只剩头像图标），此时没有放重启按钮的地方。
			 * @param {Element} row 账号行。
			 * @returns {boolean}
			 */
			const isRail = (row) => {
				const trigger = row.querySelector('button[data-collapsed]')
				if (trigger !== null) return trigger.getAttribute('data-collapsed') === 'true'
				try {
					return row.getBoundingClientRect().width < 120
				} catch {
					return false
				}
			}

			/** 把按钮挂回账号行（或按折叠状态隐藏）。 */
			const sync = () => {
				frame = 0
				if (disposed) return
				const row = findRow()
				if (row === null) {
					if (button.parentElement !== null) button.remove()
					return
				}
				if (isRail(row)) {
					if (!button.hidden) button.hidden = true
					return
				}
				if (button.hidden) button.hidden = false
				if (button.parentElement !== row) row.appendChild(button)
			}

			/** 合并同一帧里的多次 DOM 变化。 */
			const schedule = () => {
				if (frame !== 0 || disposed) return
				frame = window.requestAnimationFrame(sync)
			}

			let observer = null
			if (typeof MutationObserver === 'function' && document.body !== null) {
				observer = new MutationObserver(schedule)
				observer.observe(document.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ['data-collapsed'],
				})
				cleanups.push(() => observer.disconnect())
			}

			schedule()

			// 卸载：撤掉按钮、提示条与监听器，并让状态表复位。
			cleanups.push(() => {
				disposed = true
				if (armTimer !== 0) window.clearTimeout(armTimer)
				if (frame !== 0) window.cancelAnimationFrame(frame)
				toast?.close()
				toast = null
				button.remove()
			})

			ctx?.effect?.(() => () => {
				for (const cleanup of cleanups.reverse()) {
					try {
						cleanup()
					} catch {
						/* 卸载不抛错 */
					}
				}
			}, 'restart-button: account row action')

			render()
		}

		return { name: 'restart-button', inject, apply }
	},
})
