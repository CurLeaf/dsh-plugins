/**
 * 浏览器半边：把「更新」按钮放到侧栏账号行最右端，紧挨着重启按钮的右侧。
 *
 * 位置关系：重启按钮（dsh-restart-button）绝对定位在 right: 8px；本按钮同样绝对
 * 定位，并把重启按钮向左推开一个身位，于是账号行右端变成 `… [重启] [更新]`。
 * 推开用的是 CSS 变量 + `body:has()`，不改宿主 flex 布局；插件卸载时变量和样式
 * 一起撤掉，重启按钮自动回到原位。重启按钮不存在时这段规则自然不生效。
 *
 * 交互：
 *   * 点击按钮打开更新弹窗；有新版本时显示版本对比与确认，没有新版本时显示
 *     “已是最新版本”；
 *   * 确认后弹窗原地变成进度视图，轮询 `/status` 的阶段；进度不放到按钮旁边，
 *     也不会再被账号菜单挡住；
 *   * 点按钮时在 window 捕获阶段截住事件，个人中心（账号菜单）收不到这次点击；
 *     打开弹窗前还会把已经展开的账号菜单收起；
 *   * `done` 之后等进程换 pid 再刷新页面；`failed` 在弹窗里给出日志与重试。
 */
window.__ModuleLoader__.load({
  id: 'dsh-update-button',
  factory(require) {
    /** 宿主路由，相对路径：转发部署（子路径）下同样成立。 */
    const STATUS_URL = 'api/update-button/status'
    const CHECK_URL = 'api/update-button/check'
    const START_URL = 'api/update-button/start'
    const LOG_URL = 'api/update-button/log'

    const STYLE_ID = 'dsh-update-button/styles'
    const SETTINGS_SLOT = '[data-slot="sidebar.settings"]'

    /** 轮询状态文件的间隔。 */
    const POLL_MS = 1500
    /** 等更新结束的总时长（装包可能好几分钟）。 */
    const UPDATE_TIMEOUT_MS = 20 * 60_000
    /** 首屏延迟多久检查更新，别和启动抢带宽。 */
    const FIRST_CHECK_DELAY_MS = 4000
    /** 两次自动检查之间的最小间隔。 */
    const RECHECK_MS = 10 * 60_000
    /** 更新按钮的宽度变量，重启按钮靠它躲开。 */
    const WIDTH_VAR = '--dsh-update-w'
    /** 页面轮询后端快照（后端自己按 15 分钟跑 npm，这里只读结论）。 */
    const STATUS_POLL_MS = 45_000
    /** 成功提示停留多久再刷新。 */
    const RELOAD_DELAY_MS = 600

    const UPGRADE_SVG =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 20.5V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M6.2 10.6 12 4.8l5.8 5.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M5 20.5h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '</svg>'

    const CLOSE_SVG =
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>'

    const CSS = `
.dsh-update-inline {
  position: absolute;
  right: 8px;
  top: 50%;
  z-index: 3;
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
.dsh-update-inline:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-update-inline:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe)); outline-offset: -2px; }
.dsh-update-inline[data-busy="true"] { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-update-inline[data-available="true"] { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-update-inline[hidden] { display: none; }
.dsh-update-inline svg { flex: none; width: 17px; height: 17px; }
.dsh-update-inline-label { white-space: nowrap; }
.dsh-update-dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-left: -2px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dsh-update-inline[data-available="false"] .dsh-update-dot { display: none; }

/* 重启按钮让位：本按钮占住 right: 8px，重启按钮挪到它左边一个身位。 */
body:has(.dsh-update-inline) .dsh-restart-inline {
  right: calc(8px + var(${WIDTH_VAR}, 0px) + 6px);
}

.dsh-update-dialog {
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
.dsh-update-dialog:not([open]) { display: none; }
.dsh-update-dialog[open] { display: grid; place-items: center; }
.dsh-update-dialog[data-fallback="true"] { background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.55)); }
.dsh-update-dialog::backdrop {
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
  backdrop-filter: var(--dsw-mask-blur, blur(2px));
}
.dsh-update-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: min(440px, 100%);
  max-height: calc(100dvh - 48px);
  padding: 20px;
  overflow: auto;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, #1f1f23);
  box-shadow: var(--dsw-elevation-prominent, 0 24px 60px rgba(0, 0, 0, 0.5));
  color: var(--dsw-alias-label-primary, #f2f2f4);
  animation: dsh-update-dialog-in 160ms ease;
}
@keyframes dsh-update-dialog-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.dsh-update-head { display: flex; align-items: flex-start; gap: 12px; }
.dsh-update-glyph {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-state-business-tertiary, rgba(77, 107, 254, 0.14));
}
.dsh-update-glyph svg { width: 18px; height: 18px; }
.dsh-update-head-text { flex: 1; min-width: 0; }
.dsh-update-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.dsh-update-subtitle { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8a90); }
.dsh-update-close {
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
.dsh-update-close:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-update-close:disabled { opacity: 0.4; cursor: not-allowed; }
.dsh-update-close svg { width: 14px; height: 14px; }
.dsh-update-versions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #17171a);
}
.dsh-update-versions[hidden] { display: none; }
.dsh-update-version { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dsh-update-version-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8a90); }
.dsh-update-version-value { font-size: 13px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }
.dsh-update-version[data-to="true"] .dsh-update-version-value { color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-update-arrow { flex: none; color: var(--dsw-alias-label-tertiary, #8a8a90); }
.dsh-update-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dsh-update-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary, #b6b6bb); }
.dsh-update-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8a90); }
.dsh-update-status {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #17171a);
}
.dsh-update-status[hidden] { display: none; }
.dsh-update-status[data-tone="error"] { background: var(--dsw-alias-state-error-tertiary, rgba(244, 49, 70, 0.12)); }
.dsh-update-status[data-tone="ok"] { background: var(--dsw-alias-state-success-tertiary, rgba(65, 186, 65, 0.12)); }
.dsh-update-status-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-update-status-title { font-size: 13px; line-height: 20px; font-weight: 500; }
.dsh-update-status-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #b6b6bb); overflow-wrap: anywhere; }
.dsh-update-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  border: 2px solid rgba(255, 255, 255, 0.24);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: dsh-update-spin 800ms linear infinite;
}
.dsh-update-status[data-tone="error"] .dsh-update-spinner,
.dsh-update-status[data-tone="ok"] .dsh-update-spinner { display: none; }
@keyframes dsh-update-spin { to { transform: rotate(360deg); } }
.dsh-update-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.dsh-update-actions[hidden] { display: none; }
.dsh-update-action {
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
.dsh-update-action[data-variant="outline"] {
  color: var(--dsw-alias-label-primary, #f2f2f4);
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.16));
}
.dsh-update-action[data-variant="outline"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-update-action[data-variant="primary"] {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-primary-fill, #4d6bfe);
}
.dsh-update-action[data-variant="primary"]:hover { background: var(--dsw-alias-button-primary-hover, #5b78ff); }
.dsh-update-action:disabled { opacity: 0.5; cursor: not-allowed; }

.dsh-update-log-dialog {
  position: fixed;
  inset: 0;
  z-index: 2147483601;
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  height: 100%;
  max-height: none;
  margin: 0;
  padding: 24px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, #f2f2f4);
  overflow: auto;
}
.dsh-update-log-dialog:not([open]) { display: none; }
.dsh-update-log-dialog[open] { display: grid; place-items: center; }
.dsh-update-log-dialog[data-fallback="true"] { background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.55)); }
.dsh-update-log-dialog::backdrop {
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
  backdrop-filter: var(--dsw-mask-blur, blur(2px));
}
.dsh-update-log-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(760px, 100%);
  max-height: min(76dvh, 640px);
  padding: 14px;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, #1b1b1f);
  box-shadow: var(--dsw-elevation-prominent, 0 24px 60px rgba(0, 0, 0, 0.5));
  color: var(--dsw-alias-label-primary, #f2f2f4);
}
.dsh-update-log-head { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.dsh-update-log-head strong { flex: 1; font-weight: 600; }
.dsh-update-log-card pre {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.35));
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dsh-update-log-card button {
  padding: 4px 10px;
  border: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
@media (max-width: 480px) {
  .dsh-update-dialog { padding: 16px; }
  .dsh-update-card { max-height: calc(100dvh - 32px); }
  .dsh-update-log-dialog { padding: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-update-card { animation: none; }
  .dsh-update-spinner { animation-duration: 2.4s; }
}
`

    /** 幂等装样式表。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head?.appendChild(tag)
      return () => tag.remove()
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /** GET 一个 JSON 路由；网络失败/非 2xx 返回 null。 */
    async function getJson(url) {
      try {
        const response = await fetch(url, {
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

    /** POST 一个 JSON 路由。 */
    async function postJson(url, body) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        return { ok: response.ok, status: response.status, payload }
      } catch {
        return { ok: false, status: 0, payload: null }
      }
    }

    /**
     * 打开原生模态框；不支持 `showModal()` 的环境退回 `open` 属性 + 自绘遮罩。
     * @param {HTMLDialogElement} dialog 弹窗。
     */
    function showModal(dialog) {
      if (dialog.open === true) return
      if (typeof dialog.showModal === 'function') {
        try {
          dialog.showModal()
          return
        } catch {
          /* 已打开或未连接：退回 open 属性 */
        }
      }
      dialog.dataset.fallback = 'true'
      dialog.setAttribute('open', '')
    }

    /**
     * 关闭模态框。
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

    /** 阶段 → 中文进度文案。 */
    function phaseText(status) {
      const map = {
        checking: '正在检查版本',
        stopping: '正在停止服务',
        installing: '正在安装新版本',
        verifying: '正在校验新版本',
        'updating-plugins': '正在更新插件',
        starting: '正在启动服务',
        'health-check': '正在等待服务就绪',
        'rolling-back': '失败，正在回滚',
        done: '更新完成',
        failed: '更新失败',
      }
      return map[status?.phase] ?? status?.message ?? '正在更新'
    }

    /** 版本变化的一行说明。 */
    function versionDetail(status) {
      if (status?.from && status?.to) return `${status.from} → ${status.to}`
      return ''
    }

    /**
     * 更新弹窗：确认、检查、进度、结果、错误都在这一层里切换。
     * @param {object} handlers 回调。
     * @param {() => void} handlers.onStart 点“立即更新 / 重试”。
     * @param {() => void} handlers.onLog 打开日志。
     * @param {() => void} handlers.onReload 刷新页面。
     * @param {() => void} [handlers.onDismiss] 关闭弹窗。
     * @returns {object} 控制方法。
     */
    function createDialog(handlers) {
      const el = document.createElement('dialog')
      el.className = 'dsh-update-dialog'
      el.setAttribute('aria-labelledby', 'dsh-update-title')
      el.innerHTML =
        '<div class="dsh-update-card" role="document">' +
        '<div class="dsh-update-head">' +
        '<span class="dsh-update-glyph" aria-hidden="true">' + UPGRADE_SVG + '</span>' +
        '<div class="dsh-update-head-text">' +
        '<h2 class="dsh-update-title" id="dsh-update-title">更新 DeepSeek Harness</h2>' +
        '<p class="dsh-update-subtitle" data-subtitle></p>' +
        '</div>' +
        '<button type="button" class="dsh-update-close" data-action="close" aria-label="关闭">' + CLOSE_SVG + '</button>' +
        '</div>' +
        '<div class="dsh-update-versions" data-versions hidden>' +
        '<div class="dsh-update-version"><span class="dsh-update-version-label">当前</span>' +
        '<strong class="dsh-update-version-value" data-current></strong></div>' +
        '<span class="dsh-update-arrow" aria-hidden="true">→</span>' +
        '<div class="dsh-update-version" data-to="true"><span class="dsh-update-version-label">最新</span>' +
        '<strong class="dsh-update-version-value" data-latest></strong></div>' +
        '</div>' +
        '<div class="dsh-update-body">' +
        '<p class="dsh-update-intro" data-intro></p>' +
        '<p class="dsh-update-note" data-note></p>' +
        '<div class="dsh-update-status" data-status hidden data-tone="info" role="status" aria-live="polite">' +
        '<span class="dsh-update-spinner" aria-hidden="true"></span>' +
        '<span class="dsh-update-status-text">' +
        '<strong class="dsh-update-status-title" data-status-title></strong>' +
        '<span class="dsh-update-status-detail" data-status-detail></span>' +
        '</span>' +
        '</div>' +
        '</div>' +
        '<div class="dsh-update-actions" data-actions></div>' +
        '</div>'
      document.body?.appendChild(el)

      const subtitle = el.querySelector('[data-subtitle]')
      const versions = el.querySelector('[data-versions]')
      const currentValue = el.querySelector('[data-current]')
      const latestValue = el.querySelector('[data-latest]')
      const intro = el.querySelector('[data-intro]')
      const note = el.querySelector('[data-note]')
      const status = el.querySelector('[data-status]')
      const statusTitle = el.querySelector('[data-status-title]')
      const statusDetail = el.querySelector('[data-status-detail]')
      const actions = el.querySelector('[data-actions]')
      const closeButton = el.querySelector('[data-action="close"]')

      const setActions = (items) => {
        actions.replaceChildren(
          ...items.map((item) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'dsh-update-action'
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

      const clearStatus = () => {
        status.hidden = true
      }

      const setVersions = (current, latest) => {
        const hasCurrent = typeof current === 'string' && current !== ''
        const hasLatest = typeof latest === 'string' && latest !== ''
        currentValue.textContent = hasCurrent ? current : '未知'
        latestValue.textContent = hasLatest ? latest : '待查询'
        versions.hidden = !hasCurrent && !hasLatest
      }

      const setIntro = (text, hint = '') => {
        intro.textContent = text
        intro.hidden = text === ''
        note.textContent = hint
        note.hidden = hint === ''
      }

      const show = () => {
        showModal(el)
        const target = actions.querySelector('[data-action="confirm"]') ?? closeButton
        target?.focus?.({ preventScroll: true })
      }

      const dismiss = () => {
        hideModal(el)
        handlers.onDismiss?.()
      }

      const showActions = (items) => {
        setActions(items)
        closeButton.disabled = false
        if (el.open) {
          const target = actions.querySelector('[data-action="confirm"]') ?? closeButton
          target?.focus?.({ preventScroll: true })
        }
      }

      closeButton.addEventListener('click', dismiss)
      el.addEventListener('pointerdown', (event) => event.stopPropagation())
      el.addEventListener('click', (event) => {
        event.stopPropagation()
        if (event.target === el) dismiss()
      })
      el.addEventListener('cancel', (event) => {
        // 更新进行中允许关掉弹窗：进度继续在后台跑，按钮仍是“更新中…”。
        if (event.defaultPrevented) return
        dismiss()
      })
      el.addEventListener('keydown', (event) => {
        // 弹窗是模态的：宿主快捷键不该在弹窗后面继续响应。
        event.stopPropagation()
        if (event.key !== 'Escape') return
        dismiss()
      })

      return {
        el,
        get open() {
          return el.open === true
        },
        /** 调一下宿主快照里的版本号。 */
        setVersions,
        /** 检查中：只有转圈，没有可点的操作。 */
        showChecking() {
          el.dataset.mode = 'checking'
          closeButton.disabled = false
          subtitle.textContent = '正在检查可用版本'
          setVersions(null, null)
          setIntro('正在向 npm 查询最新版本，完成后会在这里显示结果。', '')
          clearStatus()
          setStatus('正在检查版本…', '通常只需要几秒。', 'info')
          setActions([])
        },
        /** 有新版本：确认后开始。 */
        showConfirm() {
          el.dataset.mode = 'confirm'
          closeButton.disabled = false
          subtitle.textContent = '安装完成后自动重启服务'
          setIntro(
            '会先停掉 dsh-web，安装新版本后自动启动；任何一步失败都会回滚到当前版本。',
            '下载和校验期间服务照常运行，只有切换版本时会短暂断连，完成后页面自动刷新。',
          )
          clearStatus()
          showActions([
            { label: '取消', action: 'cancel', variant: 'outline', onClick: dismiss },
            { label: '立即更新', action: 'confirm', variant: 'primary', onClick: handlers.onStart },
          ])
        },
        /** 已是最新：只给一个关闭。 */
        showLatest(version) {
          el.dataset.mode = 'result'
          closeButton.disabled = false
          subtitle.textContent = '当前已是最新版本'
          setVersions(null, null)
          setIntro('', '')
          setStatus('已是最新版本', version === undefined ? '不需要更新。' : `当前 ${version}`, 'ok')
          showActions([{ label: '关闭', action: 'close', variant: 'outline', onClick: dismiss }])
        },
        /** 进度：阶段文案写在弹窗里，按钮只负责显示忙碌态。 */
        showProgress(title, detail) {
          el.dataset.mode = 'progress'
          closeButton.disabled = false
          subtitle.textContent = '正在更新，页面会在完成后自动刷新'
          setIntro('', '')
          setStatus(title, detail, 'info')
          setActions([])
        },
        /** 成功：停留片刻再刷新。 */
        showSuccess(title, detail) {
          el.dataset.mode = 'success'
          subtitle.textContent = '更新完成'
          setIntro('', '')
          setStatus(title, detail, 'ok')
          showActions([
            { label: '刷新页面', action: 'reload', variant: 'primary', onClick: handlers.onReload },
          ])
        },
        /** 装好了但进程没换：提示手动重启。 */
        showDoneNeedsRestart(detail) {
          el.dataset.mode = 'result'
          closeButton.disabled = false
          subtitle.textContent = '新版本已安装'
          setIntro('', '')
          setStatus('已装好新版本，需要重启生效', detail, 'ok')
          showActions([
            { label: '关闭', action: 'close', variant: 'outline', onClick: dismiss },
            { label: '刷新页面', action: 'reload', variant: 'primary', onClick: handlers.onReload },
          ])
        },
        /** 失败：关闭 / 日志 / 重试。 */
        showError(title, detail, { retry = false, log = false } = {}) {
          el.dataset.mode = 'error'
          subtitle.textContent = '更新没有完成'
          setIntro('', '')
          setStatus(title, detail, 'error')
          const items = [{ label: '关闭', action: 'close', variant: 'outline', onClick: dismiss }]
          if (log) items.push({ label: '查看日志', action: 'log', variant: 'outline', onClick: handlers.onLog })
          if (retry) items.push({ label: '重试', action: 'retry', variant: 'primary', onClick: handlers.onStart })
          showActions(items)
        },
        /** 等超时：只给日志与刷新，不假装成功。 */
        showTimeout(title, detail) {
          el.dataset.mode = 'error'
          subtitle.textContent = '没有等到更新结束'
          setIntro('', '')
          setStatus(title, detail, 'error')
          showActions([
            { label: '关闭', action: 'close', variant: 'outline', onClick: dismiss },
            { label: '查看日志', action: 'log', variant: 'outline', onClick: handlers.onLog },
            { label: '刷新页面', action: 'reload', variant: 'primary', onClick: handlers.onReload },
          ])
        },
        focusPrimary() {
          const target = actions.querySelector('[data-action="confirm"]')
          target?.focus?.({ preventScroll: true })
        },
        show,
        hide: () => hideModal(el),
        /** 插件卸载：连同 DOM 一起撤掉。 */
        remove() {
          hideModal(el)
          el.remove()
        },
      }
    }

    /**
     * 日志弹窗：嵌套在主更新弹窗之上，用同样的原生模态框保证层级。
     * @returns {{close: () => void}} 关闭入口。
     */
    function createLogPanel() {
      const el = document.createElement('dialog')
      el.className = 'dsh-update-log-dialog'
      el.setAttribute('aria-label', '更新日志')
      el.innerHTML =
        '<div class="dsh-update-log-card">' +
        '<div class="dsh-update-log-head">' +
        '<strong>更新日志</strong>' +
        '<button type="button" data-action="refresh">刷新</button>' +
        '<button type="button" data-action="close">关闭</button>' +
        '</div>' +
        '<pre>加载中…</pre>' +
        '</div>'
      document.body?.appendChild(el)
      showModal(el)

      const pre = el.querySelector('pre')
      const load = async () => {
        pre.textContent = '加载中…'
        const payload = await getJson(`${LOG_URL}?tail=160`)
        pre.textContent = payload?.lines?.length ? payload.lines.join('\n') : '（没有日志）'
      }
      const close = () => {
        hideModal(el)
        el.remove()
      }
      el.querySelector('[data-action="refresh"]').addEventListener('click', () => void load())
      el.querySelector('[data-action="close"]').addEventListener('click', close)
      el.addEventListener('cancel', (event) => {
        event.preventDefault()
        close()
      })
      el.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key !== 'Escape') return
        event.preventDefault()
        close()
      })
      void load()
      return { close }
    }

    /** 不需要宿主服务：按钮是纯 DOM，路由是 fetch。 */
    const inject = []

    function apply(ctx) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return

      let disposed = false
      let busy = false
      let dialog = null
      let logPanel = null
      let latest = null
      let current = null
      let updateAvailable = false
      let lastCheckAt = 0
      let lastCheckError = ''
      let checkIntervalMs = RECHECK_MS
      let firstCheckTimer = 0
      let checkSequence = 0
      let lastPhaseTitle = ''
      let lastPhaseDetail = ''

      const styleCleanup = installStyles()
      const cleanups = [styleCleanup]

      /* ---------- 按钮 ---------- */

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-update-inline'
      button.dataset.dshUpdate = 'true'
      button.dataset.busy = 'false'
      button.dataset.available = 'false'
      button.setAttribute('aria-haspopup', 'dialog')
      button.innerHTML = UPGRADE_SVG
      const label = document.createElement('span')
      label.className = 'dsh-update-inline-label'
      const dot = document.createElement('span')
      dot.className = 'dsh-update-dot'
      dot.setAttribute('aria-hidden', 'true')
      button.append(label, dot)

      const available = () => updateAvailable === true && typeof latest === 'string' && latest !== ''

      /** 上次检查了多久之前。 */
      const checkedAgo = () => {
        if (lastCheckAt === 0) return '还没检查过'
        const minutes = Math.round((Date.now() - lastCheckAt) / 60_000)
        if (minutes < 1) return '刚刚检查过'
        if (minutes < 60) return `${minutes} 分钟前检查过`
        return `${Math.round(minutes / 60)} 小时前检查过`
      }

      const render = () => {
        const canUpdate = available()
        button.dataset.busy = String(busy)
        button.dataset.available = String(canUpdate)
        label.textContent = busy ? '更新中…' : '更新'
        button.setAttribute(
          'aria-label',
          busy
            ? '正在更新 DSH'
            : canUpdate
              ? `更新 DSH 到 ${latest}`
              : '检查 DSH 更新',
        )
        const suffix = lastCheckError !== '' ? `（上次检查失败：${lastCheckError}）` : `（${checkedAgo()}）`
        button.title = busy
          ? '正在更新 DSH，进度在弹窗里'
          : canUpdate
            ? `有新版本 ${latest}（当前 ${current}），${checkedAgo()}`
            : `当前 ${current ?? '未知'}，点击检查更新${suffix}`
      }

      /** 把重启按钮推开需要的宽度。 */
      const syncWidth = () => {
        try {
          const width = Math.ceil(button.getBoundingClientRect().width)
          if (width > 0) document.documentElement.style.setProperty(WIDTH_VAR, `${width}px`)
        } catch {
          /* 量不到就算了，重启按钮最多和本按钮重叠 */
        }
      }

      /** 收起已经展开的宿主账号菜单，别让个人中心和弹窗叠在一起。 */
      const closeAccountMenu = () => {
        const trigger = document.querySelector(
          `${SETTINGS_SLOT} button[aria-haspopup="menu"][aria-expanded="true"]`,
        )
        if (trigger instanceof HTMLElement) trigger.click()
      }

      /* ---------- 检查更新 ---------- */

      /** 用 /status 的快照刷新本地状态（含后端定时检查器的结论）。 */
      function applyStatus(snapshot) {
        if (snapshot === null || typeof snapshot !== 'object') return
        const checker = snapshot.checker
        if (checker !== null && typeof checker === 'object') {
          if (typeof checker.current === 'string' && checker.current !== '') current = checker.current
          if (typeof checker.target === 'string' && checker.target !== '') latest = checker.target
          updateAvailable = checker.updateAvailable === true
          lastCheckAt = Number(checker.lastCheckAt) || 0
          lastCheckError = typeof checker.lastError === 'string' ? checker.lastError : ''
          if (Number(checker.intervalMs) > 0) checkIntervalMs = Number(checker.intervalMs)
        }
        if (current === null && typeof snapshot.running === 'string' && snapshot.running !== '') current = snapshot.running
        dialog?.setVersions(current, latest)
        render()
        syncWidth()
      }

      /**
       * 查一次更新；不弹提示条，结论交给按钮圆点和弹窗。
       * @param {object} [options]
       * @param {boolean} [options.force] 绕过后端缓存。
       * @returns {Promise<{ok: boolean, error?: string}>}
       */
      async function checkForUpdate({ force = false } = {}) {
        const payload = await getJson(`${CHECK_URL}${force ? '?force=1' : ''}`)
        if (payload === null || payload.ok === false) {
          lastCheckError = payload?.error ?? '网络或 npm 源不可达'
          render()
          return { ok: false, error: lastCheckError }
        }
        current = payload.current || payload.running || current
        latest = payload.target ?? payload.latest ?? null
        updateAvailable = payload.updateAvailable === true
        lastCheckAt = Number(payload.lastCheckAt) || Date.now()
        lastCheckError = typeof payload.lastError === 'string' ? payload.lastError : ''
        dialog?.setVersions(current, latest)
        render()
        syncWidth()
        return { ok: true }
      }

      /* ---------- 弹窗与进度 ---------- */

      const reload = () => {
        try {
          window.location.reload()
        } catch {
          /* 测试环境没有导航：忽略 */
        }
      }

      const ensureDialog = () =>
        (dialog = dialog ?? createDialog({
          onStart: () => void startUpdate(),
          onLog: () => {
            logPanel?.close()
            logPanel = createLogPanel()
          },
          onReload: reload,
        }))

      /** 检查一次再决定弹窗内容。 */
      async function checkThenShow() {
        const seq = ++checkSequence
        const target = ensureDialog()
        target.showChecking()
        target.show()
        const result = await checkForUpdate({ force: true })
        if (disposed || seq !== checkSequence || dialog === null || dialog.open === false) return
        if (!result.ok) {
          dialog.showError('检查更新失败', result.error ?? '网络或 npm 源不可达', { retry: true })
          return
        }
        dialog.setVersions(current, latest)
        if (available()) {
          dialog.showConfirm()
          dialog.focusPrimary()
          return
        }
        dialog.showLatest(current)
      }

      /** 打开弹窗：进行中显示进度，有更新显示确认，否则先检查。 */
      function openDialog() {
        if (disposed) return
        closeAccountMenu()
        const target = ensureDialog()
        target.setVersions(current, latest)
        target.show()
        if (busy) {
          target.showProgress(lastPhaseTitle || '正在更新 DSH…', lastPhaseDetail || '进度会在这里继续更新')
          return
        }
        if (available()) {
          target.showConfirm()
          target.show()
          return
        }
        void checkThenShow()
      }

      async function waitForUpdate() {
        const deadline = Date.now() + UPDATE_TIMEOUT_MS
        const before = await getJson(STATUS_URL)
        const beforePid = typeof before?.pid === 'number' ? before.pid : null
        let lastPhase = ''

        while (Date.now() < deadline) {
          await sleep(POLL_MS)
          if (disposed) return
          const snapshot = await getJson(STATUS_URL)
          if (snapshot === null) {
            // 服务正在停/起：这是预期内的断连。
            lastPhaseTitle = '正在更新 DSH…'
            lastPhaseDetail = '服务短暂离线，回来后页面会自动刷新'
            dialog?.showProgress(lastPhaseTitle, lastPhaseDetail)
            continue
          }
          const status = snapshot.status
          if (status === null || status === undefined) continue

          if (status.phase !== lastPhase) {
            lastPhase = status.phase
            lastPhaseTitle = phaseText(status)
            lastPhaseDetail = versionDetail(status)
            dialog?.showProgress(lastPhaseTitle, lastPhaseDetail)
          }

          if (status.phase === 'done') {
            const newPid = typeof snapshot.pid === 'number' ? snapshot.pid : null
            if (beforePid !== null && newPid !== null && newPid === beforePid && status.changed === true) {
              // 进程没换：脚本没碰服务（例如 systemd 不可用）。提示用户手动重启。
              busy = false
              render()
              dialog?.showDoneNeedsRestart(versionDetail(status))
              dialog?.show()
              return
            }
            busy = false
            render()
            dialog?.showSuccess('更新完成，正在刷新…', versionDetail(status))
            await sleep(RELOAD_DELAY_MS)
            if (disposed) return
            reload()
            return
          }

          if (status.phase === 'failed') {
            const detail = status.error || status.message || '请查看日志'
            busy = false
            render()
            dialog?.showError('更新失败', String(detail).slice(0, 200), { retry: true, log: true })
            dialog?.show()
            return
          }
        }

        busy = false
        render()
        dialog?.showTimeout('等待超时', '更新可能仍在后台进行，稍后刷新页面查看。')
        dialog?.show()
      }

      async function startUpdate() {
        if (busy || disposed) return
        busy = true
        render()
        const target = ensureDialog()
        target.show()
        target.showProgress('正在启动更新…', `${current ?? '当前版本'} → ${latest ?? '最新版本'}`)

        const result = await postJson(START_URL, { tag: latest ?? undefined })
        if (disposed) return
        if (!result.ok) {
          const message = result.payload?.message ?? (result.status === 429 ? '刚点过一次，稍等几秒' : '更新请求没有送达')
          busy = false
          render()
          target.showError('没能启动更新', message, { retry: true, log: result.status !== 429 })
          return
        }

        target.showProgress('正在更新 DSH…', '停服务 → 装包 → 起服务，完成后页面会自动刷新')
        await waitForUpdate()
      }

      /* ---------- 点击隔离 ---------- */

      /**
       * 按钮上的事件在 window 捕获阶段截住：个人中心（账号菜单）收不到这次点击。
       * 打开弹窗前由 openDialog() 自己把已展开的账号菜单收起。
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

      // window 捕获早于宿主菜单注册在 document 上的“点外部关闭”，谁先注册都一样。
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'contextmenu']) {
        window.addEventListener(type, guard, true)
        cleanups.push(() => window.removeEventListener(type, guard, true))
      }

      /* ---------- 挂到账号行 ---------- */

      const findRow = () => {
        const slot = document.querySelector(SETTINGS_SLOT)
        const row = slot === null ? null : slot.firstElementChild
        if (row === null) return null
        return row.querySelector('button') === null ? null : row
      }

      const isRail = (row) => {
        const trigger = row.querySelector('button[data-collapsed]')
        if (trigger !== null) return trigger.getAttribute('data-collapsed') === 'true'
        try {
          return row.getBoundingClientRect().width < 120
        } catch {
          return false
        }
      }

      let widthObserver = null
      let frame = 0

      const sync = () => {
        frame = 0
        if (disposed) return
        const row = findRow()
        if (row === null) {
          if (button.parentElement !== null) button.remove()
          document.documentElement.style.removeProperty(WIDTH_VAR)
          return
        }
        if (isRail(row)) {
          if (!button.hidden) button.hidden = true
          document.documentElement.style.removeProperty(WIDTH_VAR)
          return
        }
        if (button.hidden) button.hidden = false
        if (button.parentElement !== row) row.appendChild(button)
        syncWidth()
      }

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

      if (typeof ResizeObserver === 'function') {
        widthObserver = new ResizeObserver(() => syncWidth())
        widthObserver.observe(button)
        cleanups.push(() => widthObserver.disconnect())
      }

      schedule()

      /* ---------- 生命周期 ---------- */

      // 上次更新还活着（用户刷新过页面）→ 继续跟进度。弹窗直接打开在进度视图，
      // 进度不再藏在按钮后面。
      void (async () => {
        const snapshot = await getJson(STATUS_URL)
        if (disposed) return
        applyStatus(snapshot)
        if (snapshot?.active === true && snapshot.status?.phase !== 'done') {
          busy = true
          render()
          const status = snapshot.status
          lastPhaseTitle = phaseText(status)
          lastPhaseDetail = versionDetail(status)
          const target = ensureDialog()
          target.setVersions(current, latest)
          target.showProgress(lastPhaseTitle, lastPhaseDetail)
          target.show()
          await waitForUpdate()
          return
        }
        // 后端还没跑过检查（刚装插件/状态文件丢了）就让宿主立刻查一次；
        // 否则等它自己的 15 分钟周期，页面只负责显示。
        if (!(snapshot?.checker?.lastCheckAt > 0)) {
          firstCheckTimer = window.setTimeout(() => {
            firstCheckTimer = 0
            void checkForUpdate({})
          }, FIRST_CHECK_DELAY_MS)
        }
      })()

      // 页面长期开着时定期读后端快照：便宜（读内存/状态文件），
      // 真正的 npm 查询由宿主每 15 分钟跑一次；快照过期了才补一次检查。
      const recheck = window.setInterval(() => {
        if (disposed || busy) return
        void (async () => {
          const snapshot = await getJson(STATUS_URL)
          if (disposed) return
          applyStatus(snapshot)
          const stale = lastCheckAt === 0 || Date.now() - lastCheckAt > Math.max(checkIntervalMs * 1.5, RECHECK_MS)
          if (stale) void checkForUpdate({})
        })()
      }, STATUS_POLL_MS)
      cleanups.push(() => window.clearInterval(recheck))

      cleanups.push(() => {
        disposed = true
        if (firstCheckTimer !== 0) window.clearTimeout(firstCheckTimer)
        if (frame !== 0) window.cancelAnimationFrame(frame)
        logPanel?.close()
        logPanel = null
        dialog?.remove()
        dialog = null
        button.remove()
        document.documentElement.style.removeProperty(WIDTH_VAR)
      })

      ctx?.effect?.(() => () => {
        for (const cleanup of cleanups.reverse()) {
          try {
            cleanup()
          } catch {
            /* 卸载不抛错 */
          }
        }
      }, 'update-button: account row action')

      render()
    }

    return { name: 'update-button', inject, apply }
  },
})
