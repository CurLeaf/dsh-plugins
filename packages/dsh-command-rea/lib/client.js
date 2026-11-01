/**
 * `dsh-command-rea` 的客户端半边：给 `/rea` 的「/」菜单行补上标题、图标和说明。
 *
 * 为什么在客户端做：DSH 0.2.1-rc.5 的 `commands.register` 只转出 `name` /
 * `description` / `input`，`title` 和 `icon` 即便注册了也会被丢弃；`/` 菜单的
 * 行构建（`builtinRowFace`）也只为六个第一方 `definitionId` 提供本地化面孔。
 * 第三方宿主命令于是只剩命令名一行。
 *
 * 官方没有给命令配面孔的入口，所以在运行时包一层 `commandUi.candidates`：
 * 只改自己那条候选行，带图标的行原样放行，将来官方支持后自动让位。
 * 降级原则：补丁异常只退回原始行，绝不弄坏「/」菜单；原方法自身的错误不吞。
 *
 * 该文件是 DSH 客户端模块（`window.__ModuleLoader__`），不经打包器。
 */

;(() => {
	/** 命令名（不带前导斜杠）。 */
	const COMMAND = 'rea'
	/** 行标题。 */
	const LABEL = '逆向分析'
	/** 行右侧说明。 */
	const DESCRIPTION = '用 REA 逆向分析目标'
	/** `@deepseek-ai/dsh-client-ui-primitives` 的导出名；取不到就退回无图标。 */
	const ICON_NAME = 'IconInspectOutlineRegular'

	/**
	 * 给一条宿主命令的候选行补上 `label` / `description` / `icon`。
	 * @param commandUi - `ctx.commandUi` 服务实例。
	 * @param face - 要补的面孔。
	 * @returns 还原原方法的清理函数。
	 */
	function installRowFace(commandUi, face) {
		const original = commandUi.candidates
		if (typeof original !== 'function') {
			console.warn('[dsh-command-rea] commandUi.candidates 缺失：/rea 仍可用，只是没有标题和图标')
			return () => {}
		}
		const patched = async (session, req) => {
			const rows = await original.call(commandUi, session, req)
			try {
				if (!Array.isArray(rows)) return rows
				return rows.map((row) => {
					if (row === null || typeof row !== 'object' || row.name !== COMMAND) return row
					return {
						...row,
						label: row.label ?? face.label,
						...(row.description === undefined && face.description !== undefined ? { description: face.description } : {}),
						...(row.icon === undefined && face.icon !== undefined ? { icon: face.icon } : {}),
					}
				})
			} catch (error) {
				console.warn('[dsh-command-rea] 菜单面孔补丁异常，本次退回原始行：' + describe(error))
				return rows
			}
		}
		commandUi.candidates = patched
		return () => {
			if (commandUi.candidates === patched) commandUi.candidates = original
		}
	}

	/** 稳定的错误文案。 */
	function describe(error) {
		return error instanceof Error ? error.message : String(error)
	}

	function makeFactory() {
		return (require) => {
			const module = { exports: {} }
			let icon
			try {
				const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
				icon = primitives?.[ICON_NAME]
				if (icon === undefined) console.warn(`[dsh-command-rea] 图标 ${ICON_NAME} 不可用：/rea 仍带标题，只是没有图标`)
			} catch (error) {
				console.warn('[dsh-command-rea] 图标模块不可用：' + describe(error))
			}

			const name = 'command-rea'
			const inject = ['commandUi']

			function apply(ctx) {
				ctx.effect(() => {
					const commandUi = ctx.get?.('commandUi') ?? undefined
					if (commandUi === undefined) {
						console.warn('[dsh-command-rea] commandUi 服务不可用：/rea 仍可用，只是没有标题和图标')
						return () => {}
					}
					return installRowFace(commandUi, {
						label: LABEL,
						description: DESCRIPTION,
						icon,
					})
				}, 'command-rea: /rea menu face')
			}

			module.exports = { apply, inject, name }
			return module.exports
		}
	}

	window.__ModuleLoader__.load({ id: 'dsh-command-rea', factory: makeFactory() })
})()
