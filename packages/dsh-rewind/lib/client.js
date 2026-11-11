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

		/**
		 * Client plugin body.
		 *
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS)
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rewind: dictionaries')
			ctx.effect(() => installStyles(), 'rewind: styles')
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
		}

		return {
			name: 'rewind',
			inject: ['slots', 'locale'],
			apply,
			__test: { fill, summaries },
		}
	},
})
