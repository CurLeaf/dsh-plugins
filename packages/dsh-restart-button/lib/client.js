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
 * 交互：点击 → 原地打开确认弹窗（重启方式 + 会中断会话的提醒）；确认后同一个
 * 弹窗变成进度视图，轮询 pid 变化后自动刷新页面。所有进度都只在弹窗里出现：
 * 不再用按钮旁边的 toast，也不会因为账号菜单展开而被挡住。
 *
 * 点击隔离：按钮上的 pointer / mouse / key / click 事件在 document 捕获阶段就被
 * 截住，账号菜单（个人中心）收不到这次点击；打开弹窗前还会把已经展开的账号菜单
 * 收起，避免两层浮层叠在一起抢焦点。
 */
// 注册 id 必须等于包名（DSH 客户端模块表按包名索引；写裸名会
// "loaded without registering" → 整个客户端半边不激活，按钮消失）。
window.__ModuleLoader__.load({
	id: '@qzsy/dsh-restart-button',
	factory(require) {
		/** 宿主路由，相对路径：转发部署（子路径）下也能落到同一处。 */
		const STATUS_URL = 'api/restart-button/status'
		const RESTART_URL = 'api/restart-button/restart'
		/** 自己的样式表 id；卸载时按它清理。 */
		const STYLE_ID = 'dsh-restart-button/styles'
		/** 锚点：账号行所在的槽位（槽名是宿主的稳定契约）。 */
		const SETTINGS_SLOT = '[data-slot="sidebar.settings"]'
		/** 重启后最多等多久。 */
		const RESTART_TIMEOUT_MS = 45000
		/** 轮询间隔。 */
		const POLL_MS = 700
		/** 成功提示停留多久再刷新。 */
		const RELOAD_DELAY_MS = 400

		const POWER_SVG =
			'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
			'<path d="M12 3.5v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
			'<path d="M6.4 6.9a8 8 0 1 0 11.2 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
			'</svg>'

		const CLOSE_SVG =
			'<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
			'<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
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
.dsh-restart-inline[data-busy="true"] { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-restart-inline[hidden] { display: none; }
.dsh-restart-inline svg { flex: none; width: 17px; height: 17px; }
.dsh-restart-inline-label { white-space: nowrap; }
/* 账号行里「重新连接中 / 连接成功」那枚连接状态胶囊正好被重启按钮盖住，
   重启、重连时还会在按钮背后闪一下；宿主没有开关，按 DOM 结构整块收掉。
   选择器只认 CSS Module 的 _indicator_ 前缀，哈希后缀随宿主版本变化也不影响。 */
[data-slot="sidebar.settings"] [class*="_indicator_"] { display: none !important; }

.dsh-restart-dialog {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  height: 100%;
  max-height: none;
  margin: 0;
  padding: max(24px, env(safe-area-inset-top, 0px)) 24px max(24px, env(safe-area-inset-bottom, 0px));
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, #f2f2f4);
  overflow: auto;
}
.dsh-restart-dialog:not([open]) { display: none; }
.dsh-restart-dialog[open] { display: grid; place-items: center; }
.dsh-restart-dialog[data-fallback="true"] { background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.55)); }
.dsh-restart-dialog::backdrop {
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
  backdrop-filter: var(--dsw-mask-blur, blur(2px));
}
.dsh-restart-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: min(420px, 100%);
  max-height: calc(100dvh - 48px);
  padding: 20px;
  overflow: auto;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, #1f1f23);
  box-shadow: var(--dsw-elevation-prominent, 0 24px 60px rgba(0, 0, 0, 0.5));
  color: var(--dsw-alias-label-primary, #f2f2f4);
  animation: dsh-restart-dialog-in 160ms ease;
}
@keyframes dsh-restart-dialog-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.dsh-restart-head { display: flex; align-items: flex-start; gap: 12px; }
.dsh-restart-glyph {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  color: var(--dsw-alias-state-warn-primary, #f0a020);
  background: var(--dsw-alias-state-warn-tertiary, rgba(240, 160, 32, 0.12));
}
.dsh-restart-glyph svg { width: 18px; height: 18px; }
.dsh-restart-head-text { flex: 1; min-width: 0; }
.dsh-restart-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.dsh-restart-subtitle { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8a90); }
.dsh-restart-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: -4px -4px 0 0;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #b6b6bb);
  cursor: pointer;
}
.dsh-restart-close:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-restart-close:disabled { opacity: 0.4; cursor: not-allowed; }
.dsh-restart-close svg { width: 14px; height: 14px; }
.dsh-restart-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-restart-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary, #b6b6bb); }
.dsh-restart-plan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #17171a);
  font-size: 13px;
  line-height: 20px;
}
.dsh-restart-plan-label { flex: none; color: var(--dsw-alias-label-tertiary, #8a8a90); }
.dsh-restart-plan-value { min-width: 0; font-weight: 500; text-align: right; overflow-wrap: anywhere; }
.dsh-restart-status {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #17171a);
}
.dsh-restart-status[hidden] { display: none; }
.dsh-restart-status[data-tone="error"] { background: var(--dsw-alias-state-error-tertiary, rgba(244, 49, 70, 0.12)); }
.dsh-restart-status[data-tone="ok"] { background: var(--dsw-alias-state-success-tertiary, rgba(65, 186, 65, 0.12)); }
.dsh-restart-status-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-restart-status-title { font-size: 13px; line-height: 20px; font-weight: 500; }
.dsh-restart-status-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #b6b6bb); overflow-wrap: anywhere; }
.dsh-restart-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  border: 2px solid rgba(255, 255, 255, 0.24);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: dsh-restart-spin 800ms linear infinite;
}
.dsh-restart-status[data-tone="error"] .dsh-restart-spinner,
.dsh-restart-status[data-tone="ok"] .dsh-restart-spinner { display: none; }
@keyframes dsh-restart-spin { to { transform: rotate(360deg); } }
.dsh-restart-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.dsh-restart-actions[hidden] { display: none; }
.dsh-restart-action {
  box-sizing: border-box;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.dsh-restart-action[data-variant="outline"] {
  color: var(--dsw-alias-label-primary, #f2f2f4);
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.16));
}
.dsh-restart-action[data-variant="outline"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-restart-action[data-variant="primary"] {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-primary-fill, #4d6bfe);
}
.dsh-restart-action[data-variant="primary"]:hover { background: var(--dsw-alias-button-primary-hover, #5b78ff); }
.dsh-restart-action:disabled { opacity: 0.5; cursor: not-allowed; }
@media (max-width: 480px) {
  .dsh-restart-dialog { padding: 16px; }
  .dsh-restart-card { max-height: calc(100dvh - 32px); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-restart-card { animation: none; }
  .dsh-restart-spinner { animation-duration: 2.4s; }
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

		/**
		 * 打开模态框：优先用原生 `showModal()`（浏览器把它放进 top layer，层级高于
		 * 宿主任何菜单），环境不支持时退化成带遮罩的 `open` 属性。
		 * @param {HTMLDialogElement} dialog 弹窗。
		 */
		function showModal(dialog) {
			if (dialog.open === true) return
			if (typeof dialog.showModal === 'function') {
				try {
					dialog.showModal()
					return
				} catch {
					/* 已经打开或不是连接中的节点：退回 open 属性 */
				}
			}
			dialog.dataset.fallback = 'true'
			dialog.setAttribute('open', '')
		}

		/**
		 * 关闭模态框；原生实现会顺带把焦点还给打开弹窗的元素。
		 * @param {HTMLDialogElement} dialog 弹窗。
		 */
		function hideModal(dialog) {
			if (dialog.open !== true) return
			if (typeof dialog.close === 'function') {
				dialog.close()
				return
			}
			dialog.removeAttribute('open')
		}

		/**
		 * 确认 / 进度弹窗。所有状态都在这一层里切换，不再往按钮旁边挂提示条。
		 * @param {object} handlers 回调。
		 * @param {() => void} handlers.onDismiss 关闭（取消 / 关闭 / Esc / 点遮罩）。
		 * @param {() => void} handlers.onConfirm 确认重启 / 重试。
		 * @param {() => boolean} handlers.isBusy 是否正在重启（禁止关闭）。
		 * @returns {object} 控制方法。
		 */
		function createDialog(handlers) {
			const el = document.createElement('dialog')
			el.className = 'dsh-restart-dialog'
			el.setAttribute('aria-labelledby', 'dsh-restart-title')
			el.innerHTML =
				'<div class="dsh-restart-card" role="document">' +
				'<div class="dsh-restart-head">' +
				'<span class="dsh-restart-glyph" aria-hidden="true">' + POWER_SVG + '</span>' +
				'<div class="dsh-restart-head-text">' +
				'<h2 class="dsh-restart-title" id="dsh-restart-title">重启 DeepSeek Harness</h2>' +
				'<p class="dsh-restart-subtitle">正在运行的会话会被中断</p>' +
				'</div>' +
				'<button type="button" class="dsh-restart-close" data-action="close" aria-label="关闭">' + CLOSE_SVG + '</button>' +
				'</div>' +
				'<div class="dsh-restart-body">' +
				'<p class="dsh-restart-intro">重启会打断正在生成的那一轮对话和工具调用；服务回来后页面会自动刷新。</p>' +
				'<div class="dsh-restart-plan">' +
				'<span class="dsh-restart-plan-label">重启方式</span>' +
				'<strong class="dsh-restart-plan-value" data-plan>正在读取…</strong>' +
				'</div>' +
				'<div class="dsh-restart-status" data-status hidden data-tone="info" role="status" aria-live="polite">' +
				'<span class="dsh-restart-spinner" aria-hidden="true"></span>' +
				'<span class="dsh-restart-status-text">' +
				'<strong class="dsh-restart-status-title" data-status-title></strong>' +
				'<span class="dsh-restart-status-detail" data-status-detail></span>' +
				'</span>' +
				'</div>' +
				'</div>' +
				'<div class="dsh-restart-actions" data-actions></div>' +
				'</div>'
			document.body?.appendChild(el)

			const plan = el.querySelector('[data-plan]')
			const status = el.querySelector('[data-status]')
			const statusTitle = el.querySelector('[data-status-title]')
			const statusDetail = el.querySelector('[data-status-detail]')
			const actions = el.querySelector('[data-actions]')
			const closeButton = el.querySelector('[data-action="close"]')

			/** 按按钮列表重画底部操作区。 */
			const setActions = (items) => {
				actions.replaceChildren(
					...items.map((item) => {
						const button = document.createElement('button')
						button.type = 'button'
						button.className = 'dsh-restart-action'
						button.dataset.variant = item.variant ?? 'outline'
						button.dataset.action = item.action
						button.textContent = item.label
						button.addEventListener('click', item.onClick)
						return button
					}),
				)
				actions.hidden = items.length === 0
			}

			const setStatus = (title, detail, tone) => {
				status.hidden = false
				status.dataset.tone = tone
				statusTitle.textContent = title
				statusDetail.textContent = detail
				statusDetail.hidden = detail === ''
			}

			const setPlan = (text) => {
				plan.textContent = text
			}

			const show = () => {
				showModal(el)
				const target = actions.querySelector('[data-action="confirm"]') ?? closeButton
				target?.focus?.({ preventScroll: true })
			}

			const dismiss = () => {
				if (handlers.isBusy()) return
				hideModal(el)
				handlers.onDismiss?.()
			}

			closeButton.addEventListener('click', dismiss)
			// 弹窗上的指针事件不再交给宿主：菜单、拖拽、快捷键都别在这里接手。
			el.addEventListener('pointerdown', (event) => event.stopPropagation())
			el.addEventListener('click', (event) => {
				event.stopPropagation()
				if (event.target === el) dismiss()
			})
			el.addEventListener('cancel', (event) => {
				if (handlers.isBusy()) {
					event.preventDefault()
					return
				}
				dismiss()
			})
			el.addEventListener('keydown', (event) => {
				// 弹窗是模态的：宿主快捷键（命令面板等）不该在弹窗后面继续响应。
				event.stopPropagation()
				if (event.key !== 'Escape') return
				if (handlers.isBusy()) {
					event.preventDefault()
					return
				}
				dismiss()
			})

			return {
				el,
				/** 确认态：展示重启方式与两个操作。 */
				openConfirm() {
					el.dataset.mode = 'confirm'
					status.hidden = true
					closeButton.disabled = false
					setActions([
						{ label: '取消', action: 'cancel', variant: 'outline', onClick: dismiss },
						{ label: '确认重启', action: 'confirm', variant: 'primary', onClick: handlers.onConfirm },
					])
					show()
				},
				/** 进度态：没有可点的操作，Esc / 遮罩也关不掉。 */
				showProgress(title, detail) {
					el.dataset.mode = 'progress'
					closeButton.disabled = true
					setActions([])
					setStatus(title, detail, 'info')
				},
				/** 成功态：停留片刻后刷新。 */
				showSuccess(title, detail) {
					el.dataset.mode = 'success'
					closeButton.disabled = false
					setStatus(title, detail, 'ok')
					setActions([
						{
							label: '刷新页面',
							action: 'reload',
							variant: 'primary',
							onClick: () => window.location.reload(),
						},
					])
				},
				/** 失败态：关闭 + 重试。 */
				showError(title, detail) {
					el.dataset.mode = 'error'
					closeButton.disabled = false
					setStatus(title, detail, 'error')
					setActions([
						{ label: '关闭', action: 'close', variant: 'outline', onClick: dismiss },
						{ label: '重试', action: 'retry', variant: 'primary', onClick: handlers.onConfirm },
					])
				},
				setPlan,
				show,
				hide: () => hideModal(el),
				/** 插件卸载：连同 DOM 一起撤掉。 */
				remove() {
					hideModal(el)
					el.remove()
				},
				get open() {
					return el.open === true
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
			let busy = false
			let planLabel = ''
			let dialog = null

			const styleCleanup = installStyles()
			const cleanups = [styleCleanup]

			/* ---------- 按钮 ---------- */

			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'dsh-restart-inline'
			button.dataset.dshRestart = 'true'
			button.dataset.busy = 'false'
			button.setAttribute('aria-haspopup', 'dialog')
			button.innerHTML = POWER_SVG
			const label = document.createElement('span')
			label.className = 'dsh-restart-inline-label'
			button.appendChild(label)

			/** 按状态刷新按钮的文案与无障碍名。 */
			const render = () => {
				button.dataset.busy = String(busy)
				label.textContent = busy ? '重启中…' : '重启'
				button.setAttribute('aria-label', busy ? '正在重启 DSH' : '重启 DSH')
				button.title = busy
					? '正在重启 DSH，进度在弹窗里'
					: '重启 DSH 服务（会中断正在运行的会话）'
			}

			/**
			 * 找账号行：`[data-slot="sidebar.settings"]` 的第一个元素子节点。
			 * @returns {Element | null}
			 */
			const findRow = () => {
				const slot = document.querySelector(SETTINGS_SLOT)
				const row = slot === null ? null : slot.firstElementChild
				if (row === null) return null
				return row.querySelector('button') === null ? null : row
			}

			/**
			 * 收起已经展开的宿主账号菜单，别让个人中心和弹窗叠在一起。
			 * 只点 `aria-expanded="true"` 的触发器，菜单本来就关着时什么都不做。
			 */
			const closeAccountMenu = () => {
				const trigger = document.querySelector(
					`${SETTINGS_SLOT} button[aria-haspopup="menu"][aria-expanded="true"]`,
				)
				if (trigger instanceof HTMLElement) trigger.click()
			}

			/** 读取这次重启会走哪条路，只用于弹窗里那行说明。 */
			const loadPlan = async () => {
				const status = await readStatus()
				if (disposed) return
				if (typeof status?.plan?.label === 'string' && status.plan.label !== '') {
					planLabel = status.plan.label
					dialog?.setPlan(planLabel)
				} else {
					dialog?.setPlan('等待宿主返回重启方式…')
				}
			}

			/** 真正发重启请求，并在弹窗里等待进程回来。 */
			const restart = async () => {
				if (busy || disposed) return
				busy = true
				render()
				dialog = dialog ?? createDialog({ onDismiss: () => {}, onConfirm: () => void restart(), isBusy: () => busy })
				dialog.setPlan(planLabel === '' ? '正在读取…' : planLabel)
				dialog.showProgress('正在重启 DSH…', planLabel === '' ? '正在读取重启方式' : planLabel)

				const before = await readStatus()
				if (disposed) return
				if (typeof before?.plan?.label === 'string' && before.plan.label !== '') {
					planLabel = before.plan.label
					dialog.setPlan(planLabel)
					dialog.showProgress('正在重启 DSH…', planLabel)
				} else if (planLabel === '') {
					dialog.setPlan('宿主未返回重启方式')
				}

				try {
					const response = await fetch(RESTART_URL, {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ source: 'account-row' }),
					})
					if (!response.ok) throw new Error(`HTTP ${response.status}`)
				} catch {
					if (disposed) return
					busy = false
					render()
					dialog.showError('重启请求没有送达', '服务可能已经断开，请检查终端。')
					return
				}

				if (disposed) return
				dialog.showProgress('正在重启 DSH…', '页面会在服务回来后自动刷新')
				const status = await waitForRestart(
					typeof before?.pid === 'number' ? before.pid : null,
					() => !disposed,
				)
				if (disposed) return
				if (status !== null) {
					dialog.showSuccess('已重启，正在刷新…', planLabel)
					await sleep(RELOAD_DELAY_MS)
					if (disposed) return
					window.location.reload()
					return
				}

				busy = false
				render()
				dialog.showError('没等到 DSH 回来', '请在终端检查 dsh-web 是否已重新启动。')
			}

			/** 打开弹窗（账号菜单开着就先收起它）。 */
			const openDialog = () => {
				if (disposed) return
				closeAccountMenu()
				dialog = dialog ?? createDialog({
					onDismiss: () => {},
					onConfirm: () => void restart(),
					isBusy: () => busy,
				})
				if (busy) {
					dialog.show()
					return
				}
				dialog.setPlan(planLabel === '' ? '正在读取…' : planLabel)
				dialog.openConfirm()
				void loadPlan()
			}

			/* ---------- 点击隔离 ---------- */

			/**
			 * 按钮上的事件在 document 捕获阶段就截住：宿主的账号菜单（个人中心）
			 * 不会因为点在重启按钮上而展开、收起或抢走焦点。click 由这里直接触发。
			 * @param {Event} event 原生事件。
			 */
			const guard = (event) => {
				if (disposed) return
				if (!(event.target instanceof Node)) return
				if (!button.contains(event.target)) return
				event.stopPropagation()
				if (event.type === 'pointerdown') closeAccountMenu()
				if (event.type === 'click') openDialog()
			}

			// 挂在 window 捕获阶段：比宿主菜单注册在 document 上的“点外部关闭”更早，
			// 不论两边谁先注册都轮不到宿主处理这次点击。
			for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'contextmenu']) {
				window.addEventListener(type, guard, true)
				cleanups.push(() => window.removeEventListener(type, guard, true))
			}

			/* ---------- 挂载到账号行 ---------- */

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

			let frame = 0

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

			// 卸载：撤掉按钮、弹窗与监听器，并让状态表复位。
			cleanups.push(() => {
				disposed = true
				if (frame !== 0) window.cancelAnimationFrame(frame)
				dialog?.remove()
				dialog = null
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
