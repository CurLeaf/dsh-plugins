/**
 * 客户端半边验收：`lib/client.js` 在假的浏览器环境里被 `__ModuleLoader__`
 * 装载后，`commandUi.candidates` 的包装应只改 `/rea` 那一行。
 *
 *   node test/client.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const CLIENT = join(import.meta.dirname, '..', 'lib', 'client.js')

/** 用假 window/require 装载一次客户端模块，返回它的导出。 */
async function loadClient({ primitives = { IconInspectOutlineRegular: function FakeIcon() {} } } = {}) {
	let exported
	globalThis.window = {
		__ModuleLoader__: {
			load({ id, factory }) {
				assert.equal(id, 'dsh-command-rea')
				exported = factory((specifier) => {
					if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
					throw new Error(`unexpected require: ${specifier}`)
				})
			},
		},
	}
	await import(`${pathToFileURL(CLIENT).href}?t=${Math.random()}`)
	delete globalThis.window
	return exported
}

/** 构造一个只记录调用的 cordis ctx。 */
function makeCtx(commandUi) {
	const effects = []
	return {
		effects,
		get: (name) => (name === 'commandUi' ? commandUi : undefined),
		effect(factory) {
			const dispose = factory()
			effects.push(dispose)
			return dispose
		},
	}
}

function makeCommandUi(rows) {
	return {
		calls: 0,
		async candidates(session, req) {
			this.calls += 1
			return rows
		},
	}
}

test('把 /rea 那一行补成标题 + 说明 + 图标，其它行原样放行', async () => {
	const client = await loadClient()
	assert.equal(client.name, 'command-rea')
	assert.deepEqual([...client.inject], ['commandUi'])

	const rows = [
		{ name: 'permission', label: '权限' },
		{ name: 'rea', description: undefined },
		{ name: 'pet', label: '桌宠', description: '选择桌宠', icon: () => null },
	]
	const commandUi = makeCommandUi(rows)
	const ctx = makeCtx(commandUi)
	client.apply(ctx)

	const out = await commandUi.candidates({}, {})
	assert.equal(commandUi.calls, 1, 'still calls the original once')
	assert.deepEqual(out[0], rows[0], 'other rows untouched')
	assert.equal(out[1].label, '逆向分析')
	assert.equal(out[1].description, '用 REA 逆向分析目标')
	assert.equal(typeof out[1].icon, 'function')
	assert.equal(out[2], rows[2], 'a row that already has a face is left alone')
})

test('已有 label/icon 的 /rea 行不被覆盖', async () => {
	const client = await loadClient()
	const original = function OriginalIcon() {}
	const row = { name: 'rea', label: '自带标题', icon: original }
	const commandUi = makeCommandUi([row])
	client.apply(makeCtx(commandUi))
	const out = await commandUi.candidates({}, {})
	assert.equal(out[0].label, '自带标题')
	assert.equal(out[0].icon, original)
	assert.equal(out[0].description, '用 REA 逆向分析目标', 'description 缺失时仍补齐')
})

test('缺少图标模块时退化为只有标题和说明', async () => {
	const client = await loadClient({ primitives: {} })
	const commandUi = makeCommandUi([{ name: 'rea' }])
	client.apply(makeCtx(commandUi))
	const out = await commandUi.candidates({}, {})
	assert.equal(out[0].label, '逆向分析')
	assert.equal(out[0].description, '用 REA 逆向分析目标')
	assert.equal(out[0].icon, undefined)
})

test('卸载后恢复原方法', async () => {
	const client = await loadClient()
	const commandUi = makeCommandUi([{ name: 'rea' }])
	const original = commandUi.candidates
	const ctx = makeCtx(commandUi)
	client.apply(ctx)
	assert.notEqual(commandUi.candidates, original)
	for (const dispose of ctx.effects) dispose()
	assert.equal(commandUi.candidates, original)
})

test('commandUi 缺失时不抛错', async () => {
	const client = await loadClient()
	const ctx = { get: () => undefined, effect(factory) { factory(); return () => {} } }
	assert.doesNotThrow(() => client.apply(ctx))
})

test('原 candidates 抛错时错误照常向外抛（不吞）', async () => {
	const client = await loadClient()
	const commandUi = { async candidates() { throw new Error('boom') } }
	client.apply(makeCtx(commandUi))
	await assert.rejects(() => commandUi.candidates({}, {}), /boom/)
})
