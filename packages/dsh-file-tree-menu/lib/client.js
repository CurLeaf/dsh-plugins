/**
 * Browser half of `dsh-file-tree-menu`.
 *
 * DSH 0.2.2 gives the right sidebar's workspace file tree
 * (`@deepseek-ai/dsh-client-ui-sidebar-files`) one first-class context-menu
 * target per row: `file` and `directory`, both carrying the Session and the
 * entry's absolute path. This plugin contributes to that shared menu, so its
 * actions sit beside the product's own open / reveal / save items, work in the
 * files page and beside docked or floating previews, and survive the tree's
 * DOM or slot changes.
 *
 * It contributes:
 *
 *   添加到会话        insert `@relative/path` into the composer (undoable edit),
 *                     falling back to the clipboard when the composer face is
 *                     not mounted
 *   复制名称 / 相对路径 / 绝对路径
 *   重命名            in-place dialog; the Host route renames without overwrite
 *   删除              confirm dialog; the Host route deletes under the workspace
 *
 * The two write operations go through the plugin's Host half
 * (`POST /dsh-file-tree-menu/action`), because the tree's `workspaceFiles` Remote is
 * read-only. The path / conversation items work entirely in the browser.
 *
 * Older DSH builds have no shared context menu (`contextMenus`). There the
 * plugin keeps its original fallback: a capture listener on the rows of the tree
 * that owns its header-slot bridge, with the same items in the shared `Menu`
 * primitive. The fallback also keeps the Host's reveal action because those
 * builds have no `open-in-app` contribution for file rows.
 */
window.__ModuleLoader__.load({
	id: 'dsh-file-tree-menu',
	factory(require) {
		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		const h = React.createElement
		const { Menu } = primitives

		/** The Host route the write operations post to (relative: survives a base path). */
		const ACTION_ROUTE = 'dsh-file-tree-menu/action'

		/** The slot the files tab publishes for its header: `scope: session`, so `inputActions` arrives. */
		const ACTIONS_SLOT = 'sidebar.right.tab.files.actions'

		/** Marks the hidden span whose closest tree this instance owns. */
		const BRIDGE_ATTRIBUTE = 'data-file-menu-bridge'

		const STYLE_ID = 'dsh-file-tree-menu/styles'

		/** File-manager wording per Host platform. */
		const MANAGER_LABELS = {
			finder: '在访达中显示',
			explorer: '在文件资源管理器中显示',
			directory: '在文件管理器中显示'
		}

		/** The always-mounted Session slot that carries `inputActions` into this plugin. */
		const COMPOSER_SLOT = 'conversation.input.dock'

		/** The shared icon seat the context menu renders action glyphs from. */
		const MENU_ICON_SLOT = 'contextMenu.icon'

		/** Keys this plugin publishes into `contextMenu.icon`. */
		const ICON_KEYS = {
			chat: 'file-tree-menu.chat',
			copy: 'file-tree-menu.copy',
			path: 'file-tree-menu.path',
			edit: 'file-tree-menu.edit',
			trash: 'file-tree-menu.trash'
		}

		/* ------------------------------------------------------------------ */
		/* Small utilities                                                     */
		/* ------------------------------------------------------------------ */

		/** A readable message out of anything thrown. */
		const messageOf = (error) => {
			if (error && typeof error.message === 'string' && error.message.length > 0) return error.message
			return typeof error === 'string' ? error : '未知原因'
		}

		const warn = (...args) => {
			try {
				console.warn('[file-menu]', ...args)
			} catch {}
		}

		/** Normalize a path to forward slashes without a trailing separator. */
		const normalizePath = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '')

		/** The path relative to the workspace root, or undefined when it is not below it. */
		const relativeTo = (root, path) => {
			const base = normalizePath(root)
			const target = normalizePath(path)
			if (base.length === 0) return target
			if (target === base) return ''
			if (!target.startsWith(base + '/')) return undefined
			return target.slice(base.length + 1)
		}

		/** The entry's own name. */
		const nameOf = (path) => {
			const normalized = normalizePath(path)
			const index = normalized.lastIndexOf('/')
			return index === -1 ? normalized : normalized.slice(index + 1)
		}

		/**
		 * Format a workspace path as composer reference text, matching the
		 * `@file` / `@"file with spaces"` grammar the reference plugin reads back.
		 * A directory keeps its trailing slash (and an open quote) so the
		 * completion can descend.
		 */
		const formatMention = (path, directory) => {
			const text = directory ? `${path}/` : path
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(text)) return undefined
			if (!/\s/u.test(text)) return `@${text}`
			return directory ? `@"${text}` : `@"${text}"`
		}

		/** The `<style>` element this plugin owns, created once. */
		const installStyles = () => {
			try {
				if (typeof document === 'undefined') return
				if (document.getElementById(STYLE_ID) !== null) return
				const tag = document.createElement('style')
				tag.id = STYLE_ID
				tag.dataset.plugin = 'dsh-file-tree-menu'
				tag.textContent = [
					'.dsh-file-tree-menu-list{min-width:184px}',
					'.dsh-file-tree-menu-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:flex-start;justify-content:center;padding-top:16vh;background:rgba(0,0,0,.28)}',
					'.dsh-file-tree-menu-dialog{box-sizing:border-box;width:min(440px,calc(100vw - 48px));padding:16px 18px;border-radius:var(--dsw-radius-lg,12px);border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-1,#2b2b2b);color:var(--dsw-alias-label-primary,#ededed);box-shadow:0 16px 48px rgba(0,0,0,.42);font-size:13px;line-height:1.55}',
					'.dsh-file-tree-menu-title{margin:0 0 10px;font-size:14px;font-weight:600}',
					'.dsh-file-tree-menu-text{margin:0;color:var(--dsw-alias-label-secondary,#b8b8b8);word-break:break-all}',
					'.dsh-file-tree-menu-text strong{color:var(--dsw-alias-label-primary,#ededed);font-weight:600}',
					'.dsh-file-tree-menu-input{box-sizing:border-box;width:100%;height:32px;margin-top:12px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font:inherit}',
					'.dsh-file-tree-menu-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
					'.dsh-file-tree-menu-error{margin:8px 0 0;color:var(--dsw-alias-danger-primary,#f43146)}',
					'.dsh-file-tree-menu-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
					'.dsh-file-tree-menu-button{height:28px;padding:0 14px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:transparent;color:inherit;font:inherit;cursor:pointer}',
					'.dsh-file-tree-menu-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
					'.dsh-file-tree-menu-button[disabled]{opacity:.55;cursor:default}',
					'.dsh-file-tree-menu-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}',
					'.dsh-file-tree-menu-primary:hover{filter:brightness(1.06);background:var(--dsw-alias-brand-primary,#4d6bfe)}',
					'.dsh-file-tree-menu-danger{background:var(--dsw-alias-danger-primary,#f43146);border-color:transparent;color:#fff}',
					'.dsh-file-tree-menu-danger:hover{filter:brightness(1.06);background:var(--dsw-alias-danger-primary,#f43146)}',
					'.dsh-file-tree-menu-toast{position:fixed;top:40px;left:50%;z-index:1300;transform:translateX(-50%);width:max-content;max-width:min(560px,calc(100vw - 48px));padding:10px 14px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-toast-bg,#2f2f2f);color:var(--dsw-alias-toast-label,#fff);font-size:12.5px;line-height:1.5;text-align:center;box-shadow:0 8px 26px rgba(0,0,0,.3);pointer-events:none}'
				].join('')
				document.head.appendChild(tag)
			} catch (error) {
				warn('styles unavailable', error)
			}
		}

		/** The shared context-menu service once DSH provides it; undefined on older builds. */
		let menuService

		/** Session id → the composer's public action face, captured from the conversation dock. */
		const composerFaces = new Map()

		/** The mounted dialog host, so a context-menu callback can open a rename/delete dialog. */
		const dialogHost = { open: undefined }

		/** One short-lived toast, replacing the previous one. */
		let toastElement
		const showToast = (text) => {
			try {
				if (typeof document === 'undefined' || document.body === null) return
				if (toastElement === undefined || toastElement.isConnected !== true) {
					toastElement = document.createElement('div')
					toastElement.className = 'dsh-file-tree-menu-toast'
					toastElement.setAttribute('role', 'status')
					document.body.appendChild(toastElement)
				}
				toastElement.textContent = text
				clearTimeout(showToast.timer)
				showToast.timer = setTimeout(() => {
					if (toastElement !== undefined) toastElement.textContent = ''
				}, 2600)
			} catch {}
		}

		/** Copy text, giving the clipboard API one try before the selection fallback. */
		const copyText = async (text) => {
			try {
				const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
				if (clipboard && typeof clipboard.writeText === 'function') {
					await clipboard.writeText(text)
					return true
				}
			} catch {}
			return legacyCopy(text)
		}

		const legacyCopy = (text) => {
			try {
				if (typeof document === 'undefined' || document.body === null) return false
				const area = document.createElement('textarea')
				area.value = text
				area.setAttribute('readonly', '')
				area.style.position = 'fixed'
				area.style.top = '0'
				area.style.opacity = '0'
				document.body.appendChild(area)
				area.select()
				const copied = typeof document.execCommand === 'function' && document.execCommand('copy') === true
				area.remove()
				return copied
			} catch {
				return false
			}
		}

		/** Copy and say what was copied; a refused clipboard is reported, never silent. */
		const copyAndAnnounce = async (text, description) => {
			if (await copyText(text)) {
				showToast(`已复制${description}`)
				return true
			}
			showToast('无法写入剪贴板')
			return false
		}

		/** The visible composer editor, or undefined when no session is on screen. */
		const composerEditor = () => {
			if (typeof document === 'undefined') return undefined
			const editors = [...document.querySelectorAll('[data-conversation-region="composer"] [contenteditable="true"]')]
			return editors.filter((node) => node.getClientRects().length > 0).pop() ?? editors.pop()
		}

		const focusComposer = () => {
			try {
				const editor = composerEditor()
				if (editor && typeof editor.focus === 'function') editor.focus()
			} catch {}
		}

		/** Insert one undoable plain-text edit through the composer's public face. */
		const insertIntoComposer = (inputActions, text) => {
			if (
				inputActions === undefined ||
				typeof inputActions.captureInsertion !== 'function' ||
				typeof inputActions.insertText !== 'function' ||
				typeof text !== 'string' ||
				text.length === 0
			) {
				return false
			}
			try {
				const span = inputActions.captureInsertion()
				focusComposer()
				if (span && inputActions.insertText(text, span)) return true
			} catch (error) {
				warn('composer insertion failed', error)
			}
			return false
		}

		/** A `remote.‹namespace›` face, or undefined when the Host lacks it. */
		const remoteNamespace = (ctx, name) => {
			try {
				const remote = ctx.get('remote')
				const namespace = remote ? remote[name] : undefined
				if (namespace) return namespace
			} catch {}
			try {
				return ctx.get(`remote.${name}`)
			} catch {
				return undefined
			}
		}

		/** A Cordis service, without letting a missing one throw. */
		const serviceOf = (ctx, name) => {
			try {
				return ctx.get(name)
			} catch {
				return undefined
			}
		}

		/** Say something through the shared toast when DSH has one, else the plugin's own. */
		const notify = (text, success = true) => {
			try {
				if (menuService && typeof menuService.notify === 'function') {
					menuService.notify(text, success === true)
					return
				}
			} catch {}
			showToast(text)
		}

		/** Copy and say what was copied; a refused clipboard is reported, never silent. */
		const copyAndNotify = async (text, description, failureLabel) => {
			if (await copyText(text)) {
				notify(`已复制${description}`, true)
				return
			}
			throw new Error(failureLabel ?? '无法写入剪贴板')
		}

		/** Whether a path is absolute in either platform spelling (after normalization). */
		const isAbsolutePath = (path) => path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path.startsWith('//')

		/** The current Session's workspace root, when the sessions service is available. */
		const sessionCwd = (ctx, sessionId) => {
			try {
				const sessions = serviceOf(ctx, 'sessions')
				const list = sessions ? sessions.list : undefined
				const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
				const entry = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined
				return entry && typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : undefined
			} catch {
				return undefined
			}
		}

		/**
		 * The workspace-relative path of a shared-context-menu target.
		 * The tree's row targets carry absolute paths; a relative path is kept as is.
		 */
		const relativePathOfTarget = (ctx, target) => {
			if (typeof target.path !== 'string' || target.path.length === 0) return undefined
			const path = normalizePath(target.path)
			if (!isAbsolutePath(path)) return path
			const cwd = sessionCwd(ctx, target.sessionId)
			if (cwd === undefined) return undefined
			return relativeTo(cwd, path)
		}

		/** The `@` reference text for a target, or undefined when it cannot be written. */
		const mentionOfTarget = (ctx, target) => {
			const relative = relativePathOfTarget(ctx, target)
			if (relative === undefined || relative.length === 0) return undefined
			return formatMention(relative, target.kind === 'directory')
		}

		/**
		 * Resolve the Host's absolute path for a shared-context-menu target.
		 * Tree rows already carry an absolute path; a relative target falls back to
		 * `workspaceFiles.stat`, which is how the other sidebar callers resolve it.
		 */
		const absolutePathOfTarget = async (ctx, target, signal) => {
			if (typeof target.path !== 'string' || target.path.length === 0) return undefined
			if (isAbsolutePath(normalizePath(target.path))) return target.path
			const workspaceFiles = remoteNamespace(ctx, 'workspaceFiles')
			if (!workspaceFiles || typeof workspaceFiles.stat !== 'function') return undefined
			try {
				const result = await workspaceFiles.stat(target.sessionId, target.path, signal)
				if (!result || result.ok !== true) return undefined
				return result.value && typeof result.value.absolutePath === 'string' ? result.value.absolutePath : undefined
			} catch (error) {
				if (signal && signal.aborted === true) throw error
				return undefined
			}
		}

		/** Put one `@` reference into the Session's composer, or the clipboard when there is no face. */
		const addMentionToConversation = async (target, mention) => {
			const actions = composerFaces.get(target.sessionId)
			if (actions && typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
				try {
					const span = actions.captureInsertion()
					focusComposer()
					if (span && actions.insertText(`${mention} `, span)) {
						notify('已添加到会话', true)
						return
					}
				} catch (error) {
					warn('composer insertion failed', error)
				}
			}
			if (await copyText(mention)) {
				notify('输入框不可用，引用已复制到剪贴板', true)
				return
			}
			throw new Error('无法写入输入框或剪贴板')
		}

		/* ------------------------------------------------------------------ */
		/* Host calls                                                          */
		/* ------------------------------------------------------------------ */

		/** POST one rename/delete and translate the Host's answer. */
		const callHost = async (payload) => {
			let response
			try {
				response = await fetch(ACTION_ROUTE, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify(payload)
				})
			} catch (error) {
				throw new Error(`与宿主通信失败：${messageOf(error)}`)
			}
			let body
			try {
				body = await response.json()
			} catch {
				body = undefined
			}
			if (response.ok === true && body && body.ok === true) return body
			const message =
				body && typeof body.message === 'string' && body.message.length > 0
					? body.message
					: `宿主拒绝了这次请求（HTTP ${response.status}）`
			throw new Error(message)
		}

		/* ------------------------------------------------------------------ */
		/* Reveal in the Host's file manager                                   */
		/* ------------------------------------------------------------------ */

		/** Resolve the Host's file-manager family once; `undefined` while unknown. */
		let managerState
		let managerProbe

		const hostHome = (ctx) => {
			try {
				const facts = ctx.get('remote')?.$host
				return facts && typeof facts.home === 'string' && facts.home.length > 0 ? facts.home : undefined
			} catch {
				return undefined
			}
		}

		const managerFromApps = (apps) => {
			if (!Array.isArray(apps)) return undefined
			if (apps.includes('finder')) return 'finder'
			if (apps.includes('explorer')) return 'explorer'
			if (apps.includes('filemanager')) return 'directory'
			return undefined
		}

		const managerFromHome = (home) => {
			if (typeof home !== 'string' || home.length === 0) return undefined
			if (home.startsWith('/Users/')) return 'finder'
			if (/^[A-Za-z]:[\\/]/.test(home) || home.startsWith('\\\\')) return 'explorer'
			if (home.startsWith('/home/') || home.startsWith('/root')) return 'directory'
			return undefined
		}

		const probeManager = async (ctx) => {
			try {
				const response = await fetch('open-in-app/apps', {
					credentials: 'same-origin',
					headers: { accept: 'application/json' }
				})
				if (response.ok === true) {
					const body = await response.json()
					const matched = managerFromApps(body && body.apps)
					if (matched !== undefined) return matched
				}
			} catch {}
			const guessed = managerFromHome(hostHome(ctx))
			if (guessed !== undefined) return guessed
			const session = remoteNamespace(ctx, 'session')
			if (session && typeof session.canOpenWorkspacePath === 'function') {
				try {
					const result = await session.canOpenWorkspacePath()
					if (result && result.ok === true && result.value === true) return 'directory'
				} catch {}
			}
			return undefined
		}

		const ensureManager = (ctx) => {
			if (managerState !== undefined) return Promise.resolve(managerState)
			if (managerProbe !== undefined) return managerProbe
			managerProbe = probeManager(ctx)
				.then((value) => {
					managerState = value
					managerProbe = undefined
					return value
				})
				.catch(() => {
					managerProbe = undefined
					return undefined
				})
			return managerProbe
		}

		const revealPath = async (ctx, path) => {
			const session = remoteNamespace(ctx, 'session')
			try {
				if (!session || typeof session.openWorkspacePath !== 'function') throw new Error('宿主没有提供打开文件位置的能力')
				const result = await session.openWorkspacePath({ path, action: 'reveal' })
				if (!result || result.ok !== true) throw new Error(messageOf(result && result.error) || '宿主拒绝了这次请求')
			} catch (error) {
				const label = MANAGER_LABELS[managerState] ?? '打开文件位置'
				showToast(`${label}失败：${messageOf(error)}`)
			}
		}

		/* ------------------------------------------------------------------ */
		/* Icons (14px, stroke: currentColor)                                  */
		/* ------------------------------------------------------------------ */

		const icon = (...children) =>
			h(
				'span',
				{ 'aria-hidden': 'true', style: { display: 'inline-flex', width: 14, height: 14 } },
				h(
					'svg',
					{ width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' },
					...children
				)
			)

		const chatIcon = () => icon(h('path', { d: 'M2.6 3.6h10.8v6.9H8.1L5 13.2v-2.7H2.6z' }))
		const folderIcon = () => icon(h('path', { d: 'M1.8 4.1c0-.7.6-1.3 1.3-1.3h2.3c.4 0 .8.2 1 .5l.8 1h4.6c.7 0 1.3.6 1.3 1.3v5.3c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3z' }))
		const copyIcon = () => icon(h('rect', { x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 1.6 }), h('path', { d: 'M10.6 3.9V3.2c0-.6-.5-1.1-1.1-1.1H3.2c-.6 0-1.1.5-1.1 1.1v6.3c0 .6.5 1.1 1.1 1.1h.7' }))
		const pathIcon = () => icon(h('circle', { cx: 4.2, cy: 11.8, r: 1.6 }), h('circle', { cx: 11.8, cy: 4.2, r: 1.6 }), h('path', { d: 'M5.5 10.5 10.5 5.5' }))
		const editIcon = () => icon(h('path', { d: 'M11.2 2.4l2.4 2.4-7.6 7.6-3.1.7.7-3.1z' }))
		const trashIcon = () => icon(h('path', { d: 'M2.8 4.4h10.4' }), h('path', { d: 'M6.3 4.4V2.9h3.4v1.5' }), h('path', { d: 'M4.2 4.4l.7 8.4c0 .5.5.9 1 .9h4.2c.5 0 1-.4 1-.9l.7-8.4' }))

		/* ------------------------------------------------------------------ */
		/* The bridge component                                                */
		/* ------------------------------------------------------------------ */

		/**
		 * Fallback for DSH builds without `contextMenus`: renders the hidden anchor
		 * that identifies its tree, owns the menu and dialogs, and listens for
		 * `contextmenu` on the rows of that tree only. It is registered into the
		 * files tab header slot, which is the one place this plugin is guaranteed
		 * to be mounted alongside the tree and to carry the Session's
		 * `inputActions`.
		 */
		function FileMenuBridge(props) {
			const ctx = props.ctx
			const anchorRef = React.useRef(null)
			const inputActionsRef = React.useRef(props.inputActions)
			inputActionsRef.current = props.inputActions

			const [menu, setMenu] = React.useState(null)
			const [dialog, setDialog] = React.useState(null)
			const [manager, setManager] = React.useState(managerState)
			const inputRef = React.useRef(null)

			React.useEffect(() => {
				let cancelled = false
				ensureManager(ctx).then((value) => {
					if (!cancelled) setManager(value)
				})
				return () => {
					cancelled = true
				}
			}, [ctx])

			React.useEffect(() => {
				const onContextMenu = (event) => {
					const element = event.target instanceof Element ? event.target : undefined
					const row = element ? element.closest('[data-files-entry]') : null
					if (!row) return
					const kind = row.getAttribute('data-files-entry')
					if (kind !== 'file' && kind !== 'directory') return
					const anchor = anchorRef.current
					const tree = anchor ? anchor.closest('[data-files-state="tree"]') : null
					if (!tree || !tree.contains(row)) return
					const path = row.getAttribute('data-files-path')
					if (typeof path !== 'string' || path.length === 0) return
					event.preventDefault()
					event.stopPropagation()
					const root = tree.getAttribute('data-files-root') ?? ''
					setMenu({
						x: event.clientX,
						y: event.clientY,
						target: { path, root, kind, name: nameOf(path) }
					})
				}
				document.addEventListener('contextmenu', onContextMenu, true)
				return () => document.removeEventListener('contextmenu', onContextMenu, true)
			}, [])

			React.useEffect(() => {
				if (dialog === null) return
				const input = inputRef.current
				if (input === null) return
				input.focus()
				const dot = dialog.value.lastIndexOf('.')
				const end = dot > 0 ? dot : dialog.value.length
				try {
					input.setSelectionRange(0, end)
				} catch {}
			}, [dialog === null])

			const closeMenu = React.useCallback(() => setMenu(null), [])

			const openDialog = React.useCallback((kind, target) => {
				setDialog({
					kind,
					target,
					value: target.name,
					error: undefined,
					busy: false
				})
			}, [])

			const closeDialog = React.useCallback(() => setDialog(null), [])

			const choose = React.useCallback(
				async (id) => {
					const current = menu
					if (current === null) return
					const target = current.target
					setMenu(null)
					const relative = relativeTo(target.root, target.path)
					if (id === 'add-to-chat') {
						const mention = formatMention(relative ?? target.path, target.kind === 'directory')
						if (mention === undefined) {
							showToast('这个路径没法写成 @ 引用')
							return
						}
						const text = `${mention} `
						if (insertIntoComposer(inputActionsRef.current, text)) {
							showToast('已添加到输入框')
							return
						}
						if (await copyText(mention)) showToast('输入框不可用，引用已复制到剪贴板')
						else showToast('无法写入输入框，请手动复制路径')
						return
					}
					if (id === 'reveal') {
						await revealPath(ctx, target.path)
						return
					}
					if (id === 'copy-name') {
						await copyAndAnnounce(target.name, `「${target.name}」`)
						return
					}
					if (id === 'copy-relative') {
						if (relative === undefined) {
							showToast('这个路径不在工作区里')
							return
						}
						await copyAndAnnounce(relative, `相对路径「${relative}」`)
						return
					}
					if (id === 'copy-absolute') {
						await copyAndAnnounce(target.path, `绝对路径「${target.path}」`)
						return
					}
					if (id === 'rename') {
						openDialog('rename', target)
						return
					}
					if (id === 'delete') {
						openDialog('delete', target)
					}
				},
				[ctx, menu, openDialog]
			)

			const submitDialog = React.useCallback(async () => {
				const current = dialog
				if (current === null || current.busy === true) return
				const target = current.target
				if (current.kind === 'rename') {
					const nextName = current.value
					if (nextName.length === 0) {
						setDialog({ ...current, error: '文件名不能为空' })
						return
					}
					if (nextName === target.name) {
						setDialog(null)
						return
					}
					setDialog({ ...current, busy: true, error: undefined })
					try {
						await callHost({ action: 'rename', path: target.path, name: nextName })
						setDialog(null)
						showToast(`已重命名为「${nextName}」`)
					} catch (error) {
						setDialog({ ...current, busy: false, error: messageOf(error) })
					}
					return
				}
				setDialog({ ...current, busy: true, error: undefined })
				try {
					await callHost({ action: 'delete', path: target.path })
					setDialog(null)
					showToast(`已删除「${target.name}」`)
				} catch (error) {
					setDialog({ ...current, busy: false, error: messageOf(error) })
				}
			}, [dialog])

			const items = [
				{ id: 'add-to-chat', label: '添加到会话', icon: chatIcon() },
				{ id: 'reveal', label: MANAGER_LABELS[manager] ?? '打开文件位置', icon: folderIcon() },
				{ id: 'sep-copy', type: 'separator' },
				{ id: 'copy-name', label: '复制', icon: copyIcon() },
				{ id: 'copy-relative', label: '复制相对路径', icon: pathIcon() },
				{ id: 'copy-absolute', label: '复制绝对路径', icon: pathIcon() },
				{ id: 'sep-edit', type: 'separator' },
				{ id: 'rename', label: '重命名', icon: editIcon() },
				{ id: 'delete', label: '删除', icon: trashIcon(), danger: true }
			]

			const overlayPointer = (event) => {
				if (event.target === event.currentTarget && dialog !== null && dialog.busy !== true) closeDialog()
			}
			const overlayKeys = (event) => {
				if (event.key !== 'Escape') return
				event.preventDefault()
				event.stopPropagation()
				if (dialog !== null && dialog.busy !== true) closeDialog()
			}

			return h(
				React.Fragment,
				null,
				h('span', { ref: anchorRef, hidden: true, [BRIDGE_ATTRIBUTE]: '' }),
				menu !== null
					? h(Menu, {
							open: true,
							portal: true,
							autoFocus: true,
							align: 'start',
							side: 'bottom',
							listClassName: 'dsh-file-tree-menu-list',
							/* DSH 0.2.2 起 Menu 不再接受 getAnchorRect：点触发的菜单改用
							 * anchorPoint（与 event.clientX/clientY 同一套视口坐标）。
							 * 两个都传：新 Host 用 anchorPoint，旧 Host 仍认 getAnchorRect，
							 * 各自忽略对方不认识的 prop。 */
							anchorPoint: { x: menu.x, y: menu.y },
							getAnchorRect: () => ({ left: menu.x, top: menu.y, right: menu.x, bottom: menu.y, width: 0, height: 0 }),
							onClose: closeMenu,
							items,
							onSelect: choose
						})
					: null,
				dialog !== null
					? h(
							'div',
							{ className: 'dsh-file-tree-menu-overlay', onPointerDown: overlayPointer, onKeyDown: overlayKeys },
							h(
								'div',
								{ className: 'dsh-file-tree-menu-dialog', role: 'dialog', 'aria-modal': 'true' },
								h('p', { className: 'dsh-file-tree-menu-title' }, dialog.kind === 'rename' ? '重命名' : '删除'),
								dialog.kind === 'rename'
									? h('p', { className: 'dsh-file-tree-menu-text' }, '修改 ', h('strong', null, dialog.target.name), ' 的名称：')
									: h(
											'p',
											{ className: 'dsh-file-tree-menu-text' },
											'确定删除 ',
											h('strong', null, dialog.target.name),
											dialog.target.kind === 'directory' ? ' 及其全部内容吗？' : ' 吗？',
											h('br'),
											'这个操作不可撤销。'
										),
								dialog.kind === 'rename'
									? h('input', {
											ref: inputRef,
											className: 'dsh-file-tree-menu-input',
											value: dialog.value,
											spellCheck: false,
											autoComplete: 'off',
											disabled: dialog.busy === true,
											onChange: (event) => setDialog({ ...dialog, value: event.target.value, error: undefined }),
											onKeyDown: (event) => {
												if (event.key === 'Enter') {
													event.preventDefault()
													submitDialog()
												}
											}
										})
									: null,
								dialog.error !== undefined ? h('p', { className: 'dsh-file-tree-menu-error' }, dialog.error) : null,
								h(
									'div',
									{ className: 'dsh-file-tree-menu-buttons' },
									h(
										'button',
										{
											type: 'button',
											className: 'dsh-file-tree-menu-button',
											disabled: dialog.busy === true,
											onClick: closeDialog
										},
										'取消'
									),
									h(
										'button',
										{
											type: 'button',
											className:
												'dsh-file-tree-menu-button ' +
												(dialog.kind === 'rename' ? 'dsh-file-tree-menu-primary' : 'dsh-file-tree-menu-danger'),
											disabled: dialog.busy === true,
											autoFocus: dialog.kind === 'delete',
											onClick: submitDialog
										},
										dialog.busy === true ? '处理中…' : dialog.kind === 'rename' ? '确定' : '删除'
									)
								)
							)
						)
					: null
			)
		}
		FileMenuBridge.displayName = 'DshFileMenuBridge'

		/* ------------------------------------------------------------------ */
		/* Shared-context-menu host                                            */
		/* ------------------------------------------------------------------ */

		/**
		 * Mounted in the conversation's input dock (a Session-scoped list that is
		 * drawn for every conversation). It captures the composer's `inputActions`
		 * for the shared context menu, and owns the rename/delete dialog the menu
		 * actions open. It renders nothing until a dialog is requested.
		 */
		function SessionMenuHost(props) {
			const { sessionId, inputActions } = props
			const [dialog, setDialog] = React.useState(null)
			const inputRef = React.useRef(null)

			React.useEffect(() => {
				if (typeof sessionId !== 'string' || sessionId.length === 0 || inputActions === undefined || inputActions === null) return undefined
				composerFaces.set(sessionId, inputActions)
				return () => {
					if (composerFaces.get(sessionId) === inputActions) composerFaces.delete(sessionId)
				}
			}, [sessionId, inputActions])

			React.useEffect(() => {
				dialogHost.open = setDialog
				return () => {
					if (dialogHost.open === setDialog) dialogHost.open = undefined
				}
			}, [])

			React.useEffect(() => {
				if (dialog === null) return
				const input = inputRef.current
				if (input === null) return
				input.focus()
				const dot = dialog.value.lastIndexOf('.')
				const end = dot > 0 ? dot : dialog.value.length
				try {
					input.setSelectionRange(0, end)
				} catch {}
			}, [dialog === null])

			const closeDialog = React.useCallback(() => setDialog(null), [])

			const submitDialog = React.useCallback(async () => {
				const current = dialog
				if (current === null || current.busy === true) return
				const target = current.target
				if (current.kind === 'rename') {
					const nextName = current.value
					if (nextName.length === 0) {
						setDialog({ ...current, error: '文件名不能为空' })
						return
					}
					if (nextName === target.name) {
						setDialog(null)
						return
					}
					setDialog({ ...current, busy: true, error: undefined })
					try {
						await callHost({ action: 'rename', path: target.path, name: nextName })
						setDialog(null)
						notify(`已重命名为「${nextName}」`, true)
					} catch (error) {
						setDialog({ ...current, busy: false, error: messageOf(error) })
					}
					return
				}
				setDialog({ ...current, busy: true, error: undefined })
				try {
					await callHost({ action: 'delete', path: target.path })
					setDialog(null)
					notify(`已删除「${target.name}」`, true)
				} catch (error) {
					setDialog({ ...current, busy: false, error: messageOf(error) })
				}
			}, [dialog])

			if (dialog === null) return null

			const overlayPointer = (event) => {
				if (event.target === event.currentTarget && dialog.busy !== true) closeDialog()
			}
			const overlayKeys = (event) => {
				if (event.key !== 'Escape') return
				event.preventDefault()
				event.stopPropagation()
				if (dialog.busy !== true) closeDialog()
			}

			return h(
				'div',
				{ className: 'dsh-file-tree-menu-overlay', onPointerDown: overlayPointer, onKeyDown: overlayKeys },
				h(
					'div',
					{ className: 'dsh-file-tree-menu-dialog', role: 'dialog', 'aria-modal': 'true' },
					h('p', { className: 'dsh-file-tree-menu-title' }, dialog.kind === 'rename' ? '重命名' : '删除'),
					dialog.kind === 'rename'
						? h('p', { className: 'dsh-file-tree-menu-text' }, '修改 ', h('strong', null, dialog.target.name), ' 的名称：')
						: h(
								'p',
								{ className: 'dsh-file-tree-menu-text' },
								'确定删除 ',
								h('strong', null, dialog.target.name),
								dialog.target.kind === 'directory' ? ' 及其全部内容吗？' : ' 吗？',
								h('br'),
								'这个操作不可撤销。'
							),
					dialog.kind === 'rename'
						? h('input', {
								ref: inputRef,
								className: 'dsh-file-tree-menu-input',
								value: dialog.value,
								spellCheck: false,
								autoComplete: 'off',
								disabled: dialog.busy === true,
								onChange: (event) => setDialog({ ...dialog, value: event.target.value, error: undefined }),
								onKeyDown: (event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										submitDialog()
									}
								}
							})
						: null,
					dialog.error !== undefined ? h('p', { className: 'dsh-file-tree-menu-error' }, dialog.error) : null,
					h(
						'div',
						{ className: 'dsh-file-tree-menu-buttons' },
						h(
							'button',
							{
								type: 'button',
								className: 'dsh-file-tree-menu-button',
								disabled: dialog.busy === true,
								onClick: closeDialog
							},
							'取消'
						),
						h(
							'button',
							{
								type: 'button',
								className:
									'dsh-file-tree-menu-button ' +
									(dialog.kind === 'rename' ? 'dsh-file-tree-menu-primary' : 'dsh-file-tree-menu-danger'),
								disabled: dialog.busy === true,
								autoFocus: dialog.kind === 'delete',
								onClick: submitDialog
							},
							dialog.busy === true ? '处理中…' : dialog.kind === 'rename' ? '确定' : '删除'
						)
					)
				)
			)
		}
		SessionMenuHost.displayName = 'DshFileMenuSessionHost'

		/** Open the host's rename/delete dialog from a context-menu callback. */
		const requestEditDialog = (kind, target) => {
			if (typeof dialogHost.open !== 'function') throw new Error('对话框还没有准备好')
			dialogHost.open({ kind, target, value: target.name, error: undefined, busy: false })
		}

		/** Register one contribution for both file and directory targets. */
		const registerForRows = (ctx, contextMenus, id, order, resolve, label) => {
			for (const kind of ['file', 'directory']) {
				ctx.effect(
					() =>
						contextMenus.register({
							id,
							target: kind,
							order,
							resolve: (target, signal) => resolve(kind, target, signal)
						}),
					`file-menu: ${label} (${kind})`
				)
			}
		}

		/** Register the shared-context-menu contributions and their icons. */
		const registerContextMenu = (ctx, slots, contextMenus) => {
			registerForRows(
				ctx,
				contextMenus,
				'file-tree-menu.chat',
				40,
				(kind, target, signal) => {
					signal.throwIfAborted()
					const full = { ...target, kind }
					const mention = mentionOfTarget(ctx, full)
					if (mention === undefined) return []
					return [
						{
							id: 'addToConversation',
							label: '添加到会话',
							icon: { key: ICON_KEYS.chat },
							failureLabel: '无法添加到会话',
							run: () => addMentionToConversation(full, mention)
						}
					]
				},
				'add to conversation'
			)

			registerForRows(
				ctx,
				contextMenus,
				'file-tree-menu.paths',
				300,
				async (kind, target, signal) => {
					signal.throwIfAborted()
					if (typeof target.path !== 'string' || target.path.length === 0) return []
					const absolutePath = await absolutePathOfTarget(ctx, target, signal)
					signal.throwIfAborted()
					const relative = relativePathOfTarget(ctx, { ...target, kind })
					const name = nameOf(target.path)
					return [
						{
							id: 'copyName',
							label: '复制名称',
							icon: { key: ICON_KEYS.copy },
							separatorBefore: true,
							failureLabel: '复制失败',
							run: () => copyAndNotify(name, `「${name}」`, '复制失败')
						},
						{
							id: 'copyRelative',
							label: '复制相对路径',
							icon: { key: ICON_KEYS.path },
							disabled: relative === undefined || relative.length === 0,
							failureLabel: '复制失败',
							run: () =>
								relative === undefined || relative.length === 0
									? Promise.reject(new Error('这个路径不在工作区里'))
									: copyAndNotify(relative, `相对路径「${relative}」`, '复制失败')
						},
						{
							id: 'copyAbsolute',
							label: '复制绝对路径',
							icon: { key: ICON_KEYS.path },
							disabled: absolutePath === undefined,
							failureLabel: '复制失败',
							run: () =>
								absolutePath === undefined
									? Promise.reject(new Error('宿主没有给出绝对路径'))
									: copyAndNotify(absolutePath, `绝对路径「${absolutePath}」`, '复制失败')
						}
					]
				},
				'path copying'
			)

			registerForRows(
				ctx,
				contextMenus,
				'file-tree-menu.edit',
				400,
				async (kind, target, signal) => {
					signal.throwIfAborted()
					if (typeof target.path !== 'string' || target.path.length === 0) return []
					const absolutePath = await absolutePathOfTarget(ctx, target, signal)
					signal.throwIfAborted()
					const relative = relativePathOfTarget(ctx, { ...target, kind })
					if (absolutePath === undefined || relative === undefined || relative.length === 0) return []
					const dialogTarget = {
						kind,
						name: nameOf(absolutePath),
						path: absolutePath,
						sessionId: target.sessionId
					}
					return [
						{
							id: 'rename',
							label: '重命名…',
							icon: { key: ICON_KEYS.edit },
							separatorBefore: true,
							failureLabel: '重命名失败',
							run: () => requestEditDialog('rename', dialogTarget)
						},
						{
							id: 'delete',
							label: '删除…',
							icon: { key: ICON_KEYS.trash },
							danger: true,
							failureLabel: '删除失败',
							run: () => requestEditDialog('delete', dialogTarget)
						}
					]
				},
				'rename and delete'
			)

			const icons = [
				[ICON_KEYS.chat, chatIcon],
				[ICON_KEYS.copy, copyIcon],
				[ICON_KEYS.path, pathIcon],
				[ICON_KEYS.edit, editIcon],
				[ICON_KEYS.trash, trashIcon]
			]
			try {
				ctx.effect(() => {
					const disposers = icons.map(([key, Icon]) =>
						slots.inject(MENU_ICON_SLOT, () =>
							slots.register({ name: MENU_ICON_SLOT, key }, Icon)
						)
					)
					return () => {
						for (const dispose of disposers) {
							try {
								dispose()
							} catch {}
						}
					}
				}, 'file-menu: context-menu icons')
			} catch (error) {
				warn('context-menu icon slot unavailable', error)
			}
		}

		/* ------------------------------------------------------------------ */
		/* Registration                                                        */
		/* ------------------------------------------------------------------ */

		const inject = ['slots']

		/**
		 * Register the composer host that owns the Session's `inputActions` and the
		 * rename/delete dialogs. Both modes register it: a build whose
		 * `contextMenus` service arrives after this plugin applied still opens its
		 * dialogs through the same host.
		 */
		const registerComposerHost = (ctx, slots) => {
			try {
				return ctx.effect(
					() =>
						slots.inject(COMPOSER_SLOT, () =>
							slots.register(
								{ name: COMPOSER_SLOT, id: 'file-menu', order: 1000 },
								SessionMenuHost
							)
						),
					'file-menu: composer face capture'
				)
			} catch (error) {
				warn('conversation input dock unavailable', error)
				return undefined
			}
		}

		function apply(ctx) {
			try {
				// A client bundle can be evaluated again by a reload; one listener set is enough.
				if (typeof window !== 'undefined' && window.__DSH_FILE_MENU_APPLIED__ === true) return
				const slots = ctx.get('slots')
				if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
					warn('slots service unavailable; plugin inactive')
					return
				}
				installStyles()

				const contextMenus = serviceOf(ctx, 'contextMenus')
				const sharedMenu = contextMenus !== undefined && typeof contextMenus.register === 'function'
				let mode = sharedMenu ? 'context-menu' : 'dom-menu'

				registerComposerHost(ctx, slots)

				/** The legacy listener, until the shared menu replaces it. */
				let legacyMenu

				/** Contribute to the shared menu, dropping the legacy listener it supersedes. */
				const useSharedMenu = (service) => {
					menuService = service
					registerContextMenu(ctx, slots, service)
					mode = 'context-menu'
					if (typeof legacyMenu === 'function') {
						try {
							legacyMenu()
						} catch (error) {
							warn('legacy menu removal failed', error)
						}
						legacyMenu = undefined
					}
					if (typeof globalThis.__DSH_FILE_MENU__ === 'object' && globalThis.__DSH_FILE_MENU__ !== null) {
						globalThis.__DSH_FILE_MENU__.mode = mode
					}
				}

				if (sharedMenu) {
					useSharedMenu(contextMenus)
				} else {
					if (typeof Menu !== 'function') {
						warn('primitives.Menu unavailable; plugin inactive')
						return
					}
					legacyMenu = ctx.effect(
						() =>
							slots.inject(ACTIONS_SLOT, () =>
								slots.register(
									{ name: ACTIONS_SLOT, id: 'file-menu', order: 100 },
									(props) => h(FileMenuBridge, { ...props, ctx })
								)
							),
						'file-menu: workspace file context menu'
					)
					// A 0.2.2 build may provide `contextMenus` after this plugin applies.
					// Upgrade when it does instead of hiding behind the DOM menu for the
					// whole page lifetime.
					try {
						if (typeof ctx.inject === 'function') {
							ctx.inject(['contextMenus'], (scoped) => {
								const service = serviceOf(scoped, 'contextMenus') ?? serviceOf(ctx, 'contextMenus')
								if (service !== undefined && typeof service.register === 'function') useSharedMenu(service)
							})
						}
					} catch (error) {
						warn('contextMenus never arrived; keeping the DOM menu', error)
					}
				}

				if (typeof window !== 'undefined') window.__DSH_FILE_MENU_APPLIED__ = true

				// Diagnostics: the same helpers the menu uses, for a console check.
				globalThis.__DSH_FILE_MENU__ = {
					version: '0.2.0',
					mode,
					reveal: (path) => revealPath(ctx, path),
					formatMention,
					relativeTo,
					probeManager: () => ensureManager(ctx)
				}
			} catch (error) {
				warn('apply failed', error)
			}
		}

		return {
			name: 'file-menu',
			inject,
			apply,
			__internals: { formatMention, nameOf, normalizePath, relativeTo, isAbsolutePath, composerFaces }
		}
	}
})
