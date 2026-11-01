/**
 * Browser half of `dsh-file-menu`.
 *
 * The right sidebar's workspace file tree (`@deepseek-ai/dsh-client-ui-sidebar-files`)
 * owns its rows: it renders `<li data-files-entry data-files-path>` with a plain
 * button, and nothing listens for `contextmenu`. There is no slot for a row
 * menu, so this plugin adds one the only way a client plugin can: a capture
 * listener on the document, scoped to the tree that owns the header slot it
 * renders in.
 *
 * It contributes, on right-click:
 *
 *   添加到会话        insert `@relative/path` into the composer (undoable edit),
 *                     falling back to the clipboard when the composer face is
 *                     not mounted
 *   在访达中显示      the Host's own reveal route, with the label matching the
 *                    Host's platform (访达 / 文件资源管理器 / 文件管理器)
 *   复制              the entry's name
 *   复制相对路径      path relative to the workspace root
 *   复制绝对路径      the path the tree already carries
 *   重命名            in-place dialog; the Host route renames without overwrite
 *   删除              confirm dialog; the Host route deletes under the workspace
 *
 * The two write operations go through the plugin's Host half
 * (`POST /dsh-file-menu/action`), because the tree's `workspaceFiles` Remote is
 * read-only. Every other item works entirely in the browser and keeps working
 * when the Host half is missing.
 *
 * The menu itself is the shared primitives `Menu`, so focus, Escape, outside
 * clicks and keyboard navigation are the product's own behaviour rather than a
 * reimplementation.
 */
window.__ModuleLoader__.load({
	id: 'dsh-file-menu',
	factory(require) {
		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		const h = React.createElement
		const { Menu } = primitives

		/** The Host route the write operations post to (relative: survives a base path). */
		const ACTION_ROUTE = 'dsh-file-menu/action'

		/** The slot the files tab publishes for its header: `scope: session`, so `inputActions` arrives. */
		const ACTIONS_SLOT = 'sidebar.right.tab.files.actions'

		/** Marks the hidden span whose closest tree this instance owns. */
		const BRIDGE_ATTRIBUTE = 'data-file-menu-bridge'

		const STYLE_ID = 'dsh-file-menu/styles'

		/** File-manager wording per Host platform. */
		const MANAGER_LABELS = {
			finder: '在访达中显示',
			explorer: '在文件资源管理器中显示',
			directory: '在文件管理器中显示'
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
				tag.dataset.plugin = 'dsh-file-menu'
				tag.textContent = [
					'.dsh-file-menu-list{min-width:184px}',
					'.dsh-file-menu-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:flex-start;justify-content:center;padding-top:16vh;background:rgba(0,0,0,.28)}',
					'.dsh-file-menu-dialog{box-sizing:border-box;width:min(440px,calc(100vw - 48px));padding:16px 18px;border-radius:var(--dsw-radius-lg,12px);border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-1,#2b2b2b);color:var(--dsw-alias-label-primary,#ededed);box-shadow:0 16px 48px rgba(0,0,0,.42);font-size:13px;line-height:1.55}',
					'.dsh-file-menu-title{margin:0 0 10px;font-size:14px;font-weight:600}',
					'.dsh-file-menu-text{margin:0;color:var(--dsw-alias-label-secondary,#b8b8b8);word-break:break-all}',
					'.dsh-file-menu-text strong{color:var(--dsw-alias-label-primary,#ededed);font-weight:600}',
					'.dsh-file-menu-input{box-sizing:border-box;width:100%;height:32px;margin-top:12px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font:inherit}',
					'.dsh-file-menu-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
					'.dsh-file-menu-error{margin:8px 0 0;color:var(--dsw-alias-danger-primary,#f43146)}',
					'.dsh-file-menu-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
					'.dsh-file-menu-button{height:28px;padding:0 14px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:transparent;color:inherit;font:inherit;cursor:pointer}',
					'.dsh-file-menu-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
					'.dsh-file-menu-button[disabled]{opacity:.55;cursor:default}',
					'.dsh-file-menu-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}',
					'.dsh-file-menu-primary:hover{filter:brightness(1.06);background:var(--dsw-alias-brand-primary,#4d6bfe)}',
					'.dsh-file-menu-danger{background:var(--dsw-alias-danger-primary,#f43146);border-color:transparent;color:#fff}',
					'.dsh-file-menu-danger:hover{filter:brightness(1.06);background:var(--dsw-alias-danger-primary,#f43146)}',
					'.dsh-file-menu-toast{position:fixed;top:40px;left:50%;z-index:1300;transform:translateX(-50%);width:max-content;max-width:min(560px,calc(100vw - 48px));padding:10px 14px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-toast-bg,#2f2f2f);color:var(--dsw-alias-toast-label,#fff);font-size:12.5px;line-height:1.5;text-align:center;box-shadow:0 8px 26px rgba(0,0,0,.3);pointer-events:none}'
				].join('')
				document.head.appendChild(tag)
			} catch (error) {
				warn('styles unavailable', error)
			}
		}

		/** One short-lived toast, replacing the previous one. */
		let toastElement
		const showToast = (text) => {
			try {
				if (typeof document === 'undefined' || document.body === null) return
				if (toastElement === undefined || toastElement.isConnected !== true) {
					toastElement = document.createElement('div')
					toastElement.className = 'dsh-file-menu-toast'
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
		 * Renders the hidden anchor that identifies its tree, owns the menu and
		 * dialogs, and listens for `contextmenu` on the rows of that tree only.
		 * It is registered into the files tab header slot, which is the one place
		 * this plugin is guaranteed to be mounted alongside the tree and to carry
		 * the Session's `inputActions`.
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
							listClassName: 'dsh-file-menu-list',
							getAnchorRect: () => ({ left: menu.x, top: menu.y, right: menu.x, bottom: menu.y, width: 0, height: 0 }),
							onClose: closeMenu,
							items,
							onSelect: choose
						})
					: null,
				dialog !== null
					? h(
							'div',
							{ className: 'dsh-file-menu-overlay', onPointerDown: overlayPointer, onKeyDown: overlayKeys },
							h(
								'div',
								{ className: 'dsh-file-menu-dialog', role: 'dialog', 'aria-modal': 'true' },
								h('p', { className: 'dsh-file-menu-title' }, dialog.kind === 'rename' ? '重命名' : '删除'),
								dialog.kind === 'rename'
									? h('p', { className: 'dsh-file-menu-text' }, '修改 ', h('strong', null, dialog.target.name), ' 的名称：')
									: h(
											'p',
											{ className: 'dsh-file-menu-text' },
											'确定删除 ',
											h('strong', null, dialog.target.name),
											dialog.target.kind === 'directory' ? ' 及其全部内容吗？' : ' 吗？',
											h('br'),
											'这个操作不可撤销。'
										),
								dialog.kind === 'rename'
									? h('input', {
											ref: inputRef,
											className: 'dsh-file-menu-input',
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
								dialog.error !== undefined ? h('p', { className: 'dsh-file-menu-error' }, dialog.error) : null,
								h(
									'div',
									{ className: 'dsh-file-menu-buttons' },
									h(
										'button',
										{
											type: 'button',
											className: 'dsh-file-menu-button',
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
												'dsh-file-menu-button ' +
												(dialog.kind === 'rename' ? 'dsh-file-menu-primary' : 'dsh-file-menu-danger'),
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
		/* Registration                                                        */
		/* ------------------------------------------------------------------ */

		const inject = ['slots']

		function apply(ctx) {
			try {
				// A client bundle can be evaluated again by a reload; one listener set is enough.
				if (typeof window !== 'undefined' && window.__DSH_FILE_MENU_APPLIED__ === true) return
				const slots = ctx.get('slots')
				if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
					warn('slots service unavailable; plugin inactive')
					return
				}
				if (typeof Menu !== 'function') {
					warn('primitives.Menu unavailable; plugin inactive')
					return
				}
				installStyles()

				ctx.effect(
					() =>
						slots.inject(ACTIONS_SLOT, () =>
							slots.register(
								{ name: ACTIONS_SLOT, id: 'file-menu', order: 100 },
								(props) => h(FileMenuBridge, { ...props, ctx })
							)
						),
					'file-menu: workspace file context menu'
				)

				if (typeof window !== 'undefined') window.__DSH_FILE_MENU_APPLIED__ = true

				// Diagnostics: the same helpers the menu uses, for a console check.
				globalThis.__DSH_FILE_MENU__ = {
					version: '0.1.0',
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
			__internals: { formatMention, nameOf, normalizePath, relativeTo }
		}
	}
})
