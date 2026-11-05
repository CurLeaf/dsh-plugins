/**
 * 分支图线条的三条回归：血统染色、宽度预算、路径合并。
 *
 * 用与 client.test.mjs 相同的 stub-loader 方式驱动发布产物，只断言三件事：
 *
 *   - 车道压缩后，同一条血统的线**不再换色**（旧实现按车道下标取色，会换）
 *   - 车道数很多时画布宽度被预算压住（旧实现是 18px × 车道数）
 *   - 同一行里同色的线合并成一条 path（旧实现是每车道一个 path）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')

function stubReact() {
	const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
	return {
		createElement,
		Fragment: Symbol('Fragment'),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useMemo: (factory) => factory(),
		useCallback: (fn) => fn,
		useRef: (initial) => ({ current: initial }),
	}
}

function loadClient() {
	let plugin
	const context = {
		window: {
			__ModuleLoader__: {
				load: (entry) => {
					plugin = entry.factory((name) => {
						if (name === 'react') return stubReact()
						throw new Error(`unexpected require: ${name}`)
					})
				},
			},
			addEventListener: () => {},
			removeEventListener: () => {},
			localStorage: { getItem: () => null, setItem: () => {} },
		},
		document: {
			baseURI: 'http://127.0.0.1:8710/',
			createElement: () => ({ style: {}, appendChild() {} }),
			head: { appendChild() {} },
		},
		fetch: async () => ({ ok: false, json: async () => ({}) }),
		EventSource: class { addEventListener() {} close() {} },
		console,
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
	}
	vm.createContext(context)
	vm.runInContext(readFileSync(CLIENT_PATH, 'utf8'), context, { filename: CLIENT_PATH })
	return plugin.__test
}

/** A-A-A: 合并出三条并行车道，第一条立刻结束，逼出一次车道压缩。 */
function compactionHistory() {
	return [
		{ hash: 'A', parents: ['P', 'Q', 'R'], subject: 'merge 3' },
		{ hash: 'P', parents: [], subject: 'P root' },
		{ hash: 'Q', parents: [], subject: 'Q root' },
		{ hash: 'R', parents: [], subject: 'R root' },
	]
}

test('血统染色：车道压缩后 R 仍是它自己的颜色，而不是新下标的颜色', () => {
	const { layoutGraph, graphShapes } = loadClient()
	const { rows, laneCount } = layoutGraph(compactionHistory())

	// 第 0 行：合并点扇出三条线，各自立刻拿到目标车道的血统色
	const first = rows[0]
	assert.deepEqual([...first.edges.map((e) => e.to)], [0, 1, 2])
	const pEdge = first.edges.find((e) => e.to === 0)
	const qEdge = first.edges.find((e) => e.to === 1)
	const rEdge = first.edges.find((e) => e.to === 2)
	assert.ok(pEdge !== undefined && qEdge !== undefined && rEdge !== undefined)
	assert.equal(new Set([pEdge.color, qEdge.color, rEdge.color]).size, 3, '扇出的三条线必须三种颜色')

	// 第 1 行：lane0（P）结束，Q、R 各左移一位；R 的线必须还是原来的颜色
	const second = rows[1]
	const moved = second.edges.find((e) => e.from === 2)
	assert.ok(moved !== undefined, 'R 的过路线应该存在')
	assert.equal(moved.to, 1, 'R 压缩后落在 lane1')
	assert.equal(moved.color, rEdge.color, '压缩不得换色')

	// 节点色也跟着血统走
	const rRow = rows[3]
	assert.equal(graphShapes(rRow, laneCount).node.color, rEdge.color)
})

test('宽度策略：中等车道压进预算，密集车道保底 6px', () => {
	const { layoutGraph, graphShapes } = loadClient()

	// 12 条车道：仍在预算内（16px 间距，宽 192）
	const mid = [{ hash: 'M', parents: Array.from({ length: 11 }, (_v, i) => `m${i}`) }]
	for (let i = 0; i < 11; i += 1) mid.push({ hash: `m${i}`, parents: [] })
	const midLayout = layoutGraph(mid)
	const midShapes = graphShapes(midLayout.rows[0], midLayout.laneCount)
	assert.ok(midShapes.width <= 262, `中等车道应压进预算，实际 ${midShapes.width}`)
	assert.equal(midShapes.width, 16 + (midLayout.laneCount - 1) * 16, '仍在预算内时按 16px 间距排布')

	// 59 条车道：间距保底 6px，画布变宽、由面板横向滚动
	const wide = [{ hash: 'W', parents: Array.from({ length: 59 }, (_v, i) => `w${i}`) }]
	for (let i = 0; i < 59; i += 1) wide.push({ hash: `w${i}`, parents: [] })
	const wideLayout = layoutGraph(wide)
	const wideShapes = graphShapes(wideLayout.rows[0], wideLayout.laneCount)
	const pitch = (wideShapes.width - 16) / (wideLayout.laneCount - 1)
	assert.ok(pitch >= 5.99, `车道间距不得低于 6px，实际 ${pitch}`)
	assert.ok(wideShapes.width > 262, '超出预算时画布变宽而不是继续压缩')
})

test('路径合并：同色同宽的线合成一条 path，元素数远少于车道数', () => {
	const { layoutGraph, graphShapes, groupEdges } = loadClient()
	const commits = [{ hash: 'M', parents: Array.from({ length: 20 }, (_v, i) => `p${i}`), subject: 'wide' }]
	for (let i = 0; i < 20; i += 1) commits.push({ hash: `p${i}`, parents: [], subject: `p${i}` })
	const { rows, laneCount } = layoutGraph(commits)

	// 第 2 行是一条过路行：车道很多，但颜色只有 6 种
	const shapes = graphShapes(rows[1], laneCount)
	const groups = groupEdges(shapes.edges)
	assert.equal(groups.length, 12, '12 色调色板 → 最多 12 条 path（本例正好每种颜色一条）')
	assert.ok(shapes.edges.length > groups.length, '边数应远多于合并后的 path 数')
	const expected = new Map()
	for (const edge of shapes.edges) {
		const key = `${edge.color}|${edge.width}|${edge.opacity}`
		expected.set(key, (expected.get(key) ?? 0) + 1)
	}
	for (const group of groups) {
		const key = `${group.color}|${group.width}|${group.opacity}`
		assert.equal(group.d.split('M').length - 1, expected.get(key), '每条 path 的子路径数应等于该组边数')
	}
})

test('布局：改动区 flex-1 + 可拖分隔条 + 定高分支图面板', () => {
	const src = readFileSync(CLIENT_PATH, 'utf8')
	const changes = src.indexOf("className: 'gp-changes'")
	const resizer = src.indexOf("className: 'gp-resizer'")
	const panel = src.indexOf("'gp-graph-panel'")
	const graphSection = src.indexOf("title: t('graph.title')")

	assert.ok(changes > 0, '改动区应使用 gp-changes')
	assert.ok(resizer > changes, '分隔条应挂在改动区之后')
	assert.ok(panel > resizer, '分支图面板应挂在分隔条之后')
	assert.ok(graphSection > panel, '分支图 section 应在面板内部')

	assert.match(src, /\.gp-changes\{[^}]*flex:1/, '改动区自适应剩余高度')
	assert.match(src, /\.gp-resizer\{[^}]*cursor:row-resize/, '分隔条可上下拖')
	assert.match(src, /\.gp-graph-panel\{[^}]*flex:none/, '分支图面板不参与 flex 伸缩')
	assert.match(src, /height: `\$\{graphHeight\}px`/, '面板高度来自可拖状态')
	assert.equal(src.includes('gp-graph-shadow'), false, '不再用背景色阴影切断交叉线')
})

test('密集车道：节点随车道间距收缩，不压到邻道', () => {
	const { layoutGraph, graphShapes } = loadClient()
	const commits = [{ hash: 'M', parents: Array.from({ length: 59 }, (_v, i) => `p${i}`) }]
	for (let i = 0; i < 59; i += 1) commits.push({ hash: `p${i}`, parents: [] })
	const { rows, laneCount } = layoutGraph(commits)
	const shapes = graphShapes(rows[0], laneCount)
	const laneWidth = (shapes.width - 16) / (laneCount - 1)

	assert.ok(shapes.node.radius < 4.8, `密集时应缩小节点，实际 ${shapes.node.radius}`)
	assert.ok(shapes.node.radius * 2 <= laneWidth + 0.01, '节点直径不得超过车道间距')
})

test('Find Issues 的提示词：空改动不出请求，有改动带文件与约束', () => {
	const { buildReviewPrompt } = loadClient()

	assert.equal(buildReviewPrompt({ cwd: '/repo', staged: [], changes: [], untracked: [] }), '')

	const prompt = buildReviewPrompt({
		cwd: '/repo/app',
		branch: 'release/3.0.0',
		staged: [{ path: 'src/a.js' }],
		changes: [{ path: 'src/b.js' }],
		untracked: [{ path: 'docs/c.md' }],
	})
	assert.match(prompt, /仓库：\/repo\/app/)
	assert.match(prompt, /分支：release\/3\.0\.0/)
	assert.match(prompt, /已暂存 1 · 未暂存 1 · 未跟踪 1/)
	assert.match(prompt, /- \[已暂存\] src\/a\.js/)
	assert.match(prompt, /- \[未跟踪\] docs\/c\.md/)
	assert.match(prompt, /git -C \/repo\/app diff/)
	assert.match(prompt, /不要修改文件/)
	assert.match(prompt, /blocker \/ major \/ minor/)
	assert.match(prompt, /未发现需要修的问题/)
})

test('Find Issues 的提示词：文件过多时截断并注明剩余数量', () => {
	const { buildReviewPrompt } = loadClient()
	const many = Array.from({ length: 45 }, (_v, i) => ({ path: `src/f${i}.js` }))
	const prompt = buildReviewPrompt({ cwd: '/repo', staged: many, changes: [], untracked: [], limit: 40 })
	assert.match(prompt, /另有 5 个文件，未列出/)
	assert.equal(prompt.split('\n').filter((line) => line.startsWith('- [已暂存]')).length, 40)
})

test('折叠与吸附：审查区可折叠、分支图折叠后隐藏拖拽条并吸底', () => {
	const src = readFileSync(CLIENT_PATH, 'utf8')

	// 提示文案与两条 hover 分割线都不可再出现
	assert.equal(src.includes('gp-review-hint'), false, '找问题下方的提示文案应已移除')
	assert.equal(src.includes('review.hint'), false, '提示文案的 locale 键应已移除')
	assert.equal(src.includes('gp-resizer::before'), false, '拖拽条的 hover 分割线应已移除')
	assert.equal(src.includes('gp-review::before'), false, '审查区上沿的分割线应已移除')

	// 审查区标题行是折叠开关
	assert.match(src, /className: 'gp-review-head',\s*\n\s*role: 'button'/, '审查区标题应为可点击开关')
	assert.match(src, /expanded\.review === false \? null : h\('button'/, '折叠后隐藏「找问题」按钮')

	// 分支图折叠：无内联高度（回到内容高度，作为最后一个 flex 子项吸底）、隐藏拖拽条
	assert.match(src, /style: expanded\.graph === false \? null : \{ height: `\$\{graphHeight\}px` \}/, '折叠时不应保留固定高度')
	assert.match(src, /expanded\.graph === false\s*\?\s*null\s*:\s*h\('div',\s*\{\s*className: 'gp-resizer'/, '折叠时应隐藏拖拽条')

	// 拖到很矮就吸附
	assert.match(src, /settled < 120/, '拖到 120px 以下应折叠吸附')
	assert.match(src, /Math\.max\(0, startHeight/, '拖动下限应放到 0 以便触发吸附')
})
