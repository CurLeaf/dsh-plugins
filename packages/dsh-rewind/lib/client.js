/**
 * Browser half of `@qzsy/dsh-rewind`.
 *
 * One affordance: a footer button at the end of every completed turn —
 * `↩ 回退本轮`. Clicking it asks the Host for a plan (which files that turn
 * changed, which of them were touched by the user since), shows the list with
 * checkboxes, and applies the ones you keep.
 *
 * Nothing here touches the conversation. The session id, its title, the input
 * queue and the model selection are all left exactly as they were.
 */
window.__ModuleLoader__.load({
	id: '@qzsy/dsh-rewind',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const { useCallback, useEffect, useMemo, useRef, useState } = React

		/** Locale namespace. */
		const NS = 'rewind'
		/** Host route, relative so a forwarded deployment keeps working. */
		const ROUTE = 'api/rewind'
		/** Style tag identity. */
		const STYLE_ID = 'dsh-rewind/styles'
		/** How long a turn summary stays fresh in the browser. */
		const SUMMARY_TTL = 5000
		/** How long the "已回退 · 撤销" strip stays up. */
		const UNDO_WINDOW = 30000

		const zh = {
			'action.label': '回退本轮',
			'action.inline': '回退第 {turn} 轮的文件改动',
			'title.turn': '回退第 {turn} 轮',
			'action.count': '回退本轮 · {count} 个文件',
			'action.none': '本轮没有可回退的文件改动',
			'title': '回退到本轮开始之前',
			'explain': '只写回这一轮改过的文件，对话、标题和输入队列都不动。',
			'files': '{count} 个文件',
			'conflicts': '{count} 个文件被你在之后改动过，默认跳过',
			'restore': '恢复',
			'delete': '删除',
			'unrestorable': '不可还原',
			'conflict': '你改过',
			'cancel': '取消',
			'apply': '确认回退',
			'applying': '回退中…',
			'applied': '已恢复 {restored} · 删除 {deleted} · 跳过 {skipped}',
			'undo': '撤销这次回退',
			'undone': '已撤销回退',
			'error': '回退失败：{message}',
			'empty': '没有可回退的改动',
			'loading': '读取中…',
			'unavailable': '回退暂不可用',
		}

		const en = {
			'action.label': 'Rewind turn',
			'action.inline': 'Revert the files turn {turn} changed',
			'title.turn': 'Revert turn {turn}',
			'action.count': 'Rewind turn · {count} files',
			'action.none': 'This turn changed no files',
			'title': 'Revert to before this turn',
			'explain': 'Writes back only the files this turn changed. The chat, its title and the queue stay untouched.',
			'files': '{count} files',
			'conflicts': '{count} files were edited after the agent and are skipped',
			'restore': 'restore',
			'delete': 'delete',
			'unrestorable': 'not restorable',
			'conflict': 'edited by you',
			'cancel': 'Cancel',
			'apply': 'Revert',
			'applying': 'Reverting…',
			'applied': 'Restored {restored} · deleted {deleted} · skipped {skipped}',
			'undo': 'Undo this revert',
			'undone': 'Revert undone',
			'error': 'Revert failed: {message}',
			'empty': 'Nothing to revert',
			'loading': 'Loading…',
			'unavailable': 'Rewind unavailable',
		}

		/** Cached turn summaries: one request per session per few seconds. */
		const summaries = new Map()

		/** Fill `{name}` placeholders. */
		function fill(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
		}

		/** Absolute route of the Host action endpoint. */
		function endpoint() {
			if (typeof document === 'undefined') return ROUTE
			try {
				return new URL(ROUTE, document.baseURI).href
			} catch {
				return ROUTE
			}
		}

		/** Call one Host action. */
		async function call(body) {
			const response = await fetch(endpoint(), {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
			const payload = await response.json().catch(() => undefined)
			if (payload === undefined || payload.ok !== true) {
				throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
			}
			return payload.value
		}

		/** Host-visible trace: proves which client steps actually ran. */
		function trace(step, extra) {
			void call({ action: 'hello', step, ...extra }).catch(() => {})
		}

		/** Cached per-session turn summary. */
		function loadSummary(sessionId, { fresh = false } = {}) {
			const cached = summaries.get(sessionId)
			if (!fresh && cached !== undefined && Date.now() - cached.at < SUMMARY_TTL) return cached.promise
			const promise = call({ action: 'list', sessionId }).catch((error) => ({ __error: error }))
			summaries.set(sessionId, { at: Date.now(), promise })
			return promise
		}

		/** Install the stylesheet once. */
		function installStyles() {
			if (typeof document === 'undefined') return undefined
			const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
			if (document.querySelector(selector) !== null) return undefined
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-rewind'
			tag.dataset.pluginCss = STYLE_ID
			tag.textContent = CSS
			document.head.appendChild(tag)
			return () => tag.remove()
		}

		const CSS = `
.dsh-rewind-root { position: relative; display: inline-flex; align-items: center; }
.dsh-rewind-button {
	display: inline-flex; align-items: center; gap: 4px;
	height: 22px; padding: 0 8px; border-radius: 6px;
	border: 1px solid rgba(127,127,127,.32); background: transparent;
	color: inherit; font-size: 12px; line-height: 1; cursor: pointer;
	opacity: .72; transition: opacity .12s ease, border-color .12s ease;
}
.dsh-rewind-button:hover { opacity: 1; border-color: rgba(127,127,127,.6); }
.dsh-rewind-button[disabled] { opacity: .35; cursor: default; }
.dsh-rewind-panel {
	position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 40;
	width: 340px; max-height: 380px; overflow: auto;
	padding: 12px; border-radius: 10px;
	border: 1px solid rgba(127,127,127,.28);
	background: var(--dsh-surface, Canvas);
	box-shadow: 0 8px 28px rgba(0,0,0,.22);
	font-size: 12px; color: inherit;
}
.dsh-rewind-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.dsh-rewind-note { opacity: .68; line-height: 1.5; margin-bottom: 8px; }
.dsh-rewind-list { list-style: none; margin: 0; padding: 0; }
.dsh-rewind-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.dsh-rewind-row input { margin: 0; }
.dsh-rewind-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.dsh-rewind-tag { font-size: 10px; padding: 1px 5px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); opacity: .8; }
.dsh-rewind-tag[data-kind="conflict"] { border-color: rgba(214,120,40,.75); color: rgb(214,120,40); }
.dsh-rewind-tag[data-kind="delete"] { border-color: rgba(214,70,70,.7); color: rgb(214,70,70); }
.dsh-rewind-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.dsh-rewind-primary, .dsh-rewind-ghost {
	height: 26px; padding: 0 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
	border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit;
}
.dsh-rewind-primary { border-color: rgba(64,132,255,.7); background: rgba(64,132,255,.14); }
.dsh-rewind-primary[disabled] { opacity: .45; cursor: default; }
.dsh-rewind-error { color: rgb(214,70,70); margin-top: 8px; }
.dsh-rewind-done { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; opacity: .85; }
.dsh-rewind-link { border: 0; background: transparent; color: rgb(64,132,255); cursor: pointer; font-size: 12px; padding: 0; }
.dsh-rewind-inline {
	display: inline-flex; align-items: center; justify-content: center;
	width: 22px; height: 22px; padding: 0; margin-left: 2px;
	border: 0; border-radius: 6px; background: transparent;
	color: inherit; font-size: 13px; line-height: 1; cursor: pointer; opacity: .6;
}
.dsh-rewind-inline:hover { opacity: 1; background: rgba(127,127,127,.16); }
.dsh-rewind-pop {
	position: fixed; z-index: 80; box-sizing: border-box;
	max-height: 340px; overflow: auto; padding: 12px; border-radius: 10px;
	border: 1px solid rgba(127,127,127,.28); background: var(--dsh-surface, Canvas);
	box-shadow: 0 10px 30px rgba(0,0,0,.24); font-size: 12px; color: inherit;
}
.dsh-rewind-pop-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.dsh-rewind-pop-note { opacity: .68; line-height: 1.5; margin-bottom: 8px; }
.dsh-rewind-pop-list { display: flex; flex-direction: column; gap: 2px; }
.dsh-rewind-pop-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
.dsh-rewind-pop-row input { margin: 0; }
.dsh-rewind-pop-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.dsh-rewind-pop-tag { font-size: 10px; padding: 1px 5px; border-radius: 999px; border: 1px solid rgba(127,127,127,.35); opacity: .8; }
.dsh-rewind-pop-tag.conflict { border-color: rgba(214,120,40,.75); color: rgb(214,120,40); }
.dsh-rewind-pop-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.dsh-rewind-pop-primary, .dsh-rewind-pop-ghost {
	height: 26px; padding: 0 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
	border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit;
}
.dsh-rewind-pop-primary { border-color: rgba(64,132,255,.7); background: rgba(64,132,255,.14); }
.dsh-rewind-pop-primary[disabled] { opacity: .45; cursor: default; }
.dsh-rewind-pop-link { border: 0; background: transparent; color: rgb(64,132,255); cursor: pointer; font-size: 12px; padding: 0 0 0 8px; }
.dsh-rewind-strip {
	position: fixed; z-index: 79; display: inline-flex; align-items: center;
	padding: 4px 10px; border-radius: 8px; font-size: 12px;
	border: 1px solid rgba(127,127,127,.25); background: var(--dsh-surface, Canvas);
	box-shadow: 0 6px 18px rgba(0,0,0,.18);
}
`

		/**
		 * Turn footer button plus its preview panel.
		 *
		 * @param {object} props - slot props: `turn`, `seq`, plus the injected session.
		 */
		function RewindTurn(props) {
			/* A child slot may not receive the locale binder; fall back to the key. */
			const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key
			const [sessionId, setSessionId] = useState(props.sessionId)
			const [summary, setSummary] = useState(undefined)
			const [open, setOpen] = useState(false)
			const [plan, setPlan] = useState(undefined)
			const [selected, setSelected] = useState(undefined)
			const [busy, setBusy] = useState(false)
			const [error, setError] = useState(undefined)
			const [done, setDone] = useState(undefined)
			const rootRef = useRef(null)

			useEffect(() => {
				trace('footer-mount', { turn: String(props.turn ?? ''), session: props.sessionId === undefined ? 'no' : 'yes', seq: props.seq === undefined ? 'no' : 'yes' })
			}, [])

			/* Resolve the session once, when the slot did not hand one over. */
			useEffect(() => {
				if (sessionId !== undefined || props.seq === undefined) return
				let alive = true
				call({ action: 'resolve', seq: props.seq })
					.then((value) => {
						if (alive && typeof value.sessionId === 'string') setSessionId(value.sessionId)
					})
					.catch(() => {})
				return () => {
					alive = false
				}
			}, [sessionId, props.seq])

			/* The per-turn file count, so the button can stay quiet when nothing changed. */
			useEffect(() => {
				if (sessionId === undefined) return
				let alive = true
				loadSummary(sessionId).then((value) => {
					if (alive && value !== undefined && value.__error === undefined) setSummary(value)
				})
				return () => {
					alive = false
				}
			}, [sessionId])

			const row = useMemo(() => {
				if (summary === undefined) return undefined
				return summary.turns.find((entry) => entry.turn === props.turn)
			}, [summary, props.turn])

			/* Close the panel when clicking outside it. */
			useEffect(() => {
				if (!open) return undefined
				const onDown = (event) => {
					if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
				}
				document.addEventListener('mousedown', onDown)
				return () => document.removeEventListener('mousedown', onDown)
			}, [open])

			const showPlan = useCallback(async () => {
				if (sessionId === undefined) return
				setBusy(true)
				setError(undefined)
				try {
					const value = await call({ action: 'plan', sessionId, turn: props.turn })
					setPlan(value)
					setSelected(new Set(value.entries.filter((entry) => entry.restorable && !entry.conflict).map((entry) => entry.path)))
					setOpen(true)
				} catch (problem) {
					setError(problem instanceof Error ? problem.message : String(problem))
					setOpen(true)
				} finally {
					setBusy(false)
				}
			}, [sessionId, props.turn])

			const apply = useCallback(async () => {
				if (sessionId === undefined || plan === undefined || selected === undefined) return
				setBusy(true)
				setError(undefined)
				try {
					const value = await call({ action: 'apply', sessionId, turn: props.turn, paths: [...selected] })
					setDone({ ...value, at: Date.now() })
					setOpen(false)
					setPlan(undefined)
					summaries.delete(sessionId)
					const next = await loadSummary(sessionId, { fresh: true })
					if (next !== undefined && next.__error === undefined) setSummary(next)
				} catch (problem) {
					setError(problem instanceof Error ? problem.message : String(problem))
				} finally {
					setBusy(false)
				}
			}, [sessionId, props.turn, plan, selected])

			const undo = useCallback(async () => {
				if (sessionId === undefined || done === undefined) return
				setBusy(true)
				try {
					await call({ action: 'undo', sessionId, revertId: done.revertId })
					setDone(undefined)
					summaries.delete(sessionId)
					const next = await loadSummary(sessionId, { fresh: true })
					if (next !== undefined && next.__error === undefined) setSummary(next)
				} catch (problem) {
					setError(problem instanceof Error ? problem.message : String(problem))
				} finally {
					setBusy(false)
				}
			}, [sessionId, done])

			/* Keep the undo strip from outliving its window. */
			useEffect(() => {
				if (done === undefined) return undefined
				const timer = setTimeout(() => setDone(undefined), UNDO_WINDOW)
				return () => clearTimeout(timer)
			}, [done])

			const count = row?.files ?? 0
			const canUndo = summary?.lastRevert !== undefined && summary.lastRevert !== null
			if (sessionId === undefined) return null
			if (count === 0 && done === undefined) return null

			return h(
				'div',
				{ className: 'dsh-rewind-root', ref: rootRef },
				done === undefined
					? h(
							'button',
							{
								type: 'button',
								className: 'dsh-rewind-button',
								title: t('title'),
								disabled: busy,
								onClick: showPlan,
							},
							`↩ ${count > 0 ? fill(t('action.count'), { count }) : t('action.label')}`,
						)
					: h(
							'span',
							{ className: 'dsh-rewind-done' },
							fill(t('applied'), {
								restored: done.restored,
								deleted: done.deleted,
								skipped: done.skipped.length,
							}),
							h('button', { type: 'button', className: 'dsh-rewind-link', onClick: undo, disabled: busy }, t('undo')),
						),
				open && plan !== undefined
					? h(
							'div',
							{ className: 'dsh-rewind-panel', role: 'dialog' },
							h('div', { className: 'dsh-rewind-title' }, t('title')),
							h('div', { className: 'dsh-rewind-note' }, t('explain')),
							plan.stats.conflicts > 0
								? h('div', { className: 'dsh-rewind-note' }, fill(t('conflicts'), { count: plan.stats.conflicts }))
								: null,
							h(
								'ul',
								{ className: 'dsh-rewind-list' },
								plan.entries.map((entry) =>
									h(
										'li',
										{ className: 'dsh-rewind-row', key: entry.path },
										h('input', {
											type: 'checkbox',
											checked: selected.has(entry.path),
											disabled: !entry.restorable,
											onChange: (event) => {
												const next = new Set(selected)
												if (event.target.checked) next.add(entry.path)
												else next.delete(entry.path)
												setSelected(next)
											},
										}),
										h('span', { className: 'dsh-rewind-path', title: entry.path }, entry.display),
										entry.op === 'delete'
											? h('span', { className: 'dsh-rewind-tag', 'data-kind': 'delete' }, t('delete'))
											: null,
										!entry.restorable
											? h('span', { className: 'dsh-rewind-tag' }, t('unrestorable'))
											: null,
										entry.conflict
											? h('span', { className: 'dsh-rewind-tag', 'data-kind': 'conflict' }, t('conflict'))
											: null,
									),
								),
							),
							error !== undefined ? h('div', { className: 'dsh-rewind-error' }, fill(t('error'), { message: error })) : null,
							h(
								'div',
								{ className: 'dsh-rewind-actions' },
								canUndo
									? h(
											'button',
											{ type: 'button', className: 'dsh-rewind-ghost', onClick: undo, disabled: busy },
											t('undo'),
										)
									: null,
								h('button', { type: 'button', className: 'dsh-rewind-ghost', onClick: () => setOpen(false) }, t('cancel')),
								h(
									'button',
									{ type: 'button', className: 'dsh-rewind-primary', onClick: apply, disabled: busy || selected.size === 0 },
									busy ? t('applying') : t('apply'),
								),
							),
						)
					: null,
				open && plan === undefined && error !== undefined
					? h('div', { className: 'dsh-rewind-panel' }, h('div', { className: 'dsh-rewind-error' }, error))
					: null,
			)
		}


		/* ------------------------------------------------------------------ */
		/* Inline affordance: one icon button beside the copy button of every  */
		/* user message whose turn changed files. The user-action row has no  */
		/* plugin slot in this Host release, so this half anchors on the chat  */
		/* node's own `data-chat-flow-kind="user"` + `data-chat-turn` marks,   */
		/* which are the same marks the transcript uses for scroll targeting. */
		/* ------------------------------------------------------------------ */

		const inline = {
			sessionId: undefined,
			renderedFor: undefined,
			summary: undefined,
			panel: undefined,
			anchor: undefined,
			applied: undefined,
			timer: undefined,
		}

		/** Remove every button and panel this half owns. */
		function dropInline() {
			for (const node of document.querySelectorAll('[data-dsh-rewind-btn]')) node.remove()
			closePanel()
		}

		/** Resolve (and cache) the session the visible transcript belongs to. */
		async function sessionOf() {
			if (inline.sessionId !== undefined) return inline.sessionId
			try {
				const value = await call({ action: 'current' })
				if (typeof value?.sessionId === 'string') inline.sessionId = value.sessionId
			} catch {
				/* the next tick tries again */
			}
			return inline.sessionId
		}

		/** Close the floating panel, if open. */
		function closePanel() {
			inline.panel?.remove()
			inline.panel = undefined
			inline.anchor = undefined
			if (inline.offOutside !== undefined) {
				document.removeEventListener('mousedown', inline.offOutside)
				inline.offOutside = undefined
			}
		}

		/** Create one icon button that matches the surrounding action row. */
		function makeInlineButton(turn) {
			const button = document.createElement('button')
			button.type = 'button'
			button.dataset.dshRewindBtn = String(turn)
			button.className = 'dsh-rewind-inline'
			button.textContent = '↩'
			const t = inline.translator
			button.title = typeof t === 'function' ? fill(t('action.inline'), { turn }) : `回退第 ${turn} 轮的文件改动`
			button.addEventListener('click', (event) => {
				event.preventDefault()
				event.stopPropagation()
				void openPanel(button, turn)
			})
			return button
		}

		/** Build the panel skeleton and fill it from a plan. */
		async function openPanel(anchor, turn) {
			closePanel()
			const sessionId = await sessionOf()
			if (sessionId === undefined) return
			let plan
			try {
				plan = await call({ action: 'plan', sessionId, turn })
			} catch (error) {
				return
			}
			if (plan.entries.length === 0) return

			const panel = document.createElement('div')
			panel.className = 'dsh-rewind-pop'
			const selected = new Set(plan.entries.filter((entry) => entry.restorable && !entry.conflict).map((entry) => entry.path))

			const title = document.createElement('div')
			title.className = 'dsh-rewind-pop-title'
			title.textContent = fill(inline.translator('title.turn'), { turn })
			panel.append(title)

			const note = document.createElement('div')
			note.className = 'dsh-rewind-pop-note'
			note.textContent = plan.stats.conflicts > 0
				? fill(inline.translator('conflicts'), { count: plan.stats.conflicts })
				: inline.translator('explain')
			panel.append(note)

			const list = document.createElement('div')
			list.className = 'dsh-rewind-pop-list'
			for (const entry of plan.entries) {
				const row = document.createElement('label')
				row.className = 'dsh-rewind-pop-row'
				const box = document.createElement('input')
				box.type = 'checkbox'
				box.checked = selected.has(entry.path)
				box.disabled = !entry.restorable
				box.addEventListener('change', () => {
					if (box.checked) selected.add(entry.path)
					else selected.delete(entry.path)
					confirm.disabled = selected.size === 0
				})
				const name = document.createElement('span')
				name.className = 'dsh-rewind-pop-path'
				name.textContent = entry.display
				name.title = entry.path
				row.append(box, name)
				if (entry.op === 'delete') {
					const tag = document.createElement('span')
					tag.className = 'dsh-rewind-pop-tag'
					tag.textContent = inline.translator('delete')
					row.append(tag)
				}
				if (entry.conflict) {
					const tag = document.createElement('span')
					tag.className = 'dsh-rewind-pop-tag conflict'
					tag.textContent = inline.translator('conflict')
					row.append(tag)
				}
				list.append(row)
			}
			panel.append(list)

			const actions = document.createElement('div')
			actions.className = 'dsh-rewind-pop-actions'
			const cancel = document.createElement('button')
			cancel.type = 'button'
			cancel.className = 'dsh-rewind-pop-ghost'
			cancel.textContent = inline.translator('cancel')
			cancel.addEventListener('click', closePanel)
			const confirm = document.createElement('button')
			confirm.type = 'button'
			confirm.className = 'dsh-rewind-pop-primary'
			confirm.textContent = inline.translator('apply')
			confirm.disabled = selected.size === 0
			confirm.addEventListener('click', async () => {
				confirm.disabled = true
				confirm.textContent = inline.translator('applying')
				try {
					const result = await call({ action: 'apply', sessionId, turn, paths: [...selected] })
					inline.applied = { ...result, sessionId }
					closePanel()
					summaries.delete(sessionId)
					await refreshButtons(sessionId)
					showResult(anchor, result)
				} catch (error) {
					note.textContent = fill(inline.translator('error'), { message: error instanceof Error ? error.message : String(error) })
					confirm.disabled = false
					confirm.textContent = inline.translator('apply')
				}
			})
			actions.append(cancel, confirm)
			panel.append(actions)

			document.body.append(panel)
			const box = anchor.getBoundingClientRect()
			const width = Math.min(340, Math.max(260, window.innerWidth - 32))
			panel.style.width = `${width}px`
			const left = Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12))
			const top = box.bottom + 8
			panel.style.left = `${left}px`
			panel.style.top = `${top}px`

			inline.panel = panel
			inline.anchor = anchor
			inline.offOutside = (event) => {
				if (!panel.contains(event.target) && event.target !== anchor) closePanel()
			}
			document.addEventListener('mousedown', inline.offOutside)
			trace('panel-open', { turn: String(turn), files: String(plan.entries.length) })
		}

		/** Show the applied summary in a small strip below the button. */
		function showResult(anchor, result) {
			const strip = document.createElement('div')
			strip.className = 'dsh-rewind-strip'
			strip.textContent = fill(inline.translator('applied'), {
				restored: result.restored,
				deleted: result.deleted,
				skipped: result.skipped.length,
			})
			const undo = document.createElement('button')
			undo.type = 'button'
			undo.className = 'dsh-rewind-pop-link'
			undo.textContent = inline.translator('undo')
			undo.addEventListener('click', async () => {
				const applied = inline.applied
				if (applied === undefined) return
				undo.disabled = true
				try {
					await call({ action: 'undo', sessionId: applied.sessionId, revertId: applied.revertId })
					strip.remove()
					await refreshButtons(applied.sessionId)
				} catch {
					undo.disabled = false
				}
			})
			strip.append(undo)
			document.body.append(strip)
			const box = anchor.getBoundingClientRect()
			strip.style.left = `${Math.max(12, box.left)}px`
			strip.style.top = `${box.bottom + 6}px`
			setTimeout(() => strip.remove(), UNDO_WINDOW)
		}

		/** Drop cached state and re-anchor every button. */
		async function refreshButtons(sessionId) {
			inline.summary = undefined
			const summary = await loadSummary(sessionId, { fresh: true })
			if (summary !== undefined && summary.__error === undefined) inline.summary = summary
			dropButtons()
			paintButtons()
		}

		/** Remove only the injected buttons, keeping an open panel. */
		function dropButtons() {
			for (const node of document.querySelectorAll('[data-dsh-rewind-btn]')) node.remove()
		}

		/** Add a button beside the copy affordance of every recorded turn. */
		function paintButtons() {
			const summary = inline.summary
			if (summary === undefined) return
			const turns = new Map(summary.turns.filter((row) => row.files > 0).map((row) => [row.turn, row]))
			for (const item of document.querySelectorAll('[data-chat-flow-kind="user"][data-chat-turn]')) {
				const turn = Number(item.getAttribute('data-chat-turn'))
				if (!turns.has(turn)) continue
				if (item.querySelector('[data-dsh-rewind-btn]') !== null) continue
				const buttons = [...item.querySelectorAll('button')].filter((button) => button.closest('pre, code') === null)
				const copy = buttons.at(-1)
				if (copy === undefined) continue
				copy.insertAdjacentElement('afterend', makeInlineButton(turn))
			}
		}

		/** One polling pass: resolve the session, keep summaries, paint. */
		async function inlineTick() {
			if (typeof document === 'undefined' || document.hidden) return
			const sessionId = await sessionOf()
			if (sessionId === undefined) return
			if (inline.renderedFor !== sessionId) {
				inline.renderedFor = sessionId
				dropButtons()
			}
			if (inline.summary === undefined) {
				const summary = await loadSummary(sessionId)
				if (summary !== undefined && summary.__error === undefined) inline.summary = summary
			}
			paintButtons()
		}

		/** Start the inline affordance. */
		function startInline(ctx) {
			if (typeof document === 'undefined') return undefined
			ctx.effect(() => installStyles(), 'rewind: inline styles')
			void inlineTick()
			inline.timer = setInterval(() => void inlineTick(), 1500)
			return () => {
				clearInterval(inline.timer)
				inline.timer = undefined
				dropInline()
			}
		}

		/**
		 * Client plugin body.
		 *
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			/* One line the Host can prove: this bundle ran in a real browser. */
			trace('apply')
			const t = ctx.locale.bind(NS)
			inline.translator = t
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rewind: dictionaries')
			ctx.effect(() => installStyles(), 'rewind: styles')
			ctx.effect(() => startInline(ctx), 'rewind: inline affordance')
			try {
				ctx.effect(
					() =>
						ctx.slots.inject('conversation.chat.turnTail', () =>
						ctx.slots.register(
							{
								name: 'conversation.chat.turnTail',
								key: 'rewind',
								locale: NS,
								inject: (sessionId) => ({ sessionId, t }),
							},
								RewindTurn,
							),
						),
					'rewind: turn footer',
				)
				trace('slot-registered')
			} catch (error) {
				trace('slot-error', { message: error instanceof Error ? error.message : String(error) })
			}
		}

		return {
			name: 'rewind',
			inject: ['slots', 'locale'],
			apply,
			__test: { fill, summaries },
		}
	},
})
