import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, collectSessionImages, imagesOf, normalizeConfig, sessionCwd } from '../lib/index.js'

/** 等一个条件成立（同步任务链跑完）。 */
async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * 最小可用的假 ctx：只实现插件真正用到的那几个入口。
 * @param {{ hostPaths: Map<string, string> }} options
 */
function fakeContext({ hostPaths }) {
  const listeners = new Map()
  const state = { command: undefined }
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((entry) => entry !== listener))
      }
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    commands: {
      register(definition) {
        state.command = definition
        return () => {
          state.command = undefined
        }
      },
    },
    attachments: {
      imageHostPath(ref) {
        return hostPaths.get(ref.attachmentId)
      },
    },
  }
  return {
    ctx,
    state,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

/** 造一个只读的假会话。 */
function fakeSession({ id, cwd, events }) {
  return {
    id,
    header: { cwd },
    seq: events.length,
    eventAt: (seq) => events[seq],
  }
}

/** 一条带图片的 tool/result 事件。 */
function imageEvent(seq, attachmentId) {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        content: [
          { type: 'text', text: 'screenshot saved' },
          {
            type: 'image',
            attachment: {
              attachmentId,
              mediaType: 'image/png',
              bytes: 12,
              width: 8,
              height: 6,
              name: 'shot.png',
            },
          },
        ],
      },
    },
  }
}

test('imagesOf 只认 image 块，且覆盖 user/message 与 tool/result', () => {
  const attachment = { attachmentId: 'sha256:aa', mediaType: 'image/png' }
  assert.deepEqual(imagesOf({ type: 'user/message', data: { content: [{ type: 'image', attachment }] } }), [attachment])
  assert.deepEqual(
    imagesOf({ type: 'tool/result', data: { message: { content: [{ type: 'image', attachment }] } } }),
    [attachment],
  )
  assert.deepEqual(imagesOf({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'x' }] } } }), [])
  assert.deepEqual(imagesOf(undefined), [])
})

test('collectSessionImages：本回合模式在 turn/start 处停住', () => {
  const attachment = { attachmentId: 'sha256:bb', mediaType: 'image/png' }
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/result', seq: 1, data: { turn: 1, message: { content: [{ type: 'image', attachment }] } } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'tool/result', seq: 4, data: { turn: 2, message: { content: [{ type: 'image', attachment }] } } },
    { type: 'turn/end', data: { turn: 2 } },
  ]
  const session = fakeSession({ id: 'session-x', cwd: '/tmp', events })
  assert.equal(collectSessionImages(session, { all: false }).length, 1)
  assert.equal(collectSessionImages(session, { all: true }).length, 2)
})

test('sessionCwd 只接受绝对路径', () => {
  assert.equal(sessionCwd({ header: { cwd: '/a/b' } }), '/a/b')
  assert.equal(sessionCwd({ meta: { cwd: '/c' } }), '/c')
  assert.equal(sessionCwd({ header: {} }), undefined)
  assert.equal(sessionCwd({ header: { cwd: 'relative/path' } }), undefined)
})

test('normalizeConfig 补齐默认值、丢弃坏值', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.viewDir, '.dsh/artifacts')
  assert.equal(defaults.remind.minImages, 10)
  assert.equal(defaults.gc.minAgeDays, 3)

  const custom = normalizeConfig({
    enabled: false,
    viewDir: '   ',
    remind: { minImages: 'x', minBytes: 1024, maxTimes: 0 },
    gc: { minAgeDays: -1 },
  })
  assert.equal(custom.enabled, false)
  assert.equal(custom.viewDir, '.dsh/artifacts')
  assert.equal(custom.remind.minImages, 10)
  assert.equal(custom.remind.minBytes, 1024)
  assert.equal(custom.remind.maxTimes, 0)
  assert.equal(custom.gc.minAgeDays, 3)
})

test('apply：回合结束把图片投影进视图并可被命令列出 / 清退', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-index-apply-'))
  try {
    const objectPath = path.join(root, 'object-store', 'blob')
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(objectPath, 'png-bytes-here')
    const attachmentId = `sha256:${'a'.repeat(64)}`
    const { ctx, state, emit } = fakeContext({ hostPaths: new Map([[attachmentId, objectPath]]) })
    apply(ctx, { remind: { enabled: false } })

    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      imageEvent(1, attachmentId),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } },
    ]
    const session = fakeSession({ id: 'session-abcd1234-5678', cwd: root, events })
    const agent = { session }

    emit('agent/created', { agent })
    emit('session/event', session, events[2])

    const indexPath = path.join(root, '.dsh', 'artifacts', 'index.json')
    await waitFor(() => existsSync(indexPath))
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    const record = index.sessions['session-abcd1234-5678']
    assert.equal(record.artifacts.length, 1)
    const artifact = record.artifacts[0]
    assert.equal(artifact.link, 'hardlink')
    assert.equal(artifact.status, 'live')
    assert.equal(artifact.bytes, 12)
    assert.equal(artifact.name, 'shot.png')

    const viewPath = path.join(root, '.dsh', 'artifacts', artifact.path)
    assert.equal(await readFile(viewPath, 'utf8'), 'png-bytes-here')
    assert.match(artifact.path, /^\d{4}-\d{2}-\d{2}\/abcd1234-0001-shot\.png$/u)
    // 视图自带忽略规则
    assert.match(await readFile(path.join(root, '.dsh', 'artifacts', '.gitignore'), 'utf8'), /^\*$/mu)

    // 命令：list
    const listed = await state.command.handler({ agent, rawInput: '' })
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /1 张/u)
    assert.match(listed.text, /abcd1234-0001-shot\.png/u)

    // 命令：clear 只改状态
    const cleared = await state.command.handler({ agent, rawInput: 'clear' })
    assert.equal(cleared.kind, 'success')
    const afterClear = JSON.parse(await readFile(indexPath, 'utf8'))
    assert.equal(afterClear.sessions['session-abcd1234-5678'].artifacts[0].status, 'cleared')
    assert.ok(existsSync(viewPath), 'clear 不该删文件')

    // 重复 clear 是幂等的
    const again = await state.command.handler({ agent, rawInput: 'clear' })
    assert.match(again.text, /没有需要清退/u)

    // 未知子命令给用法
    const unknown = await state.command.handler({ agent, rawInput: 'nope' })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /\/artifacts/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apply：到阈值时注入提醒，且不重复超过 maxTimes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'artifact-index-remind-'))
  try {
    const objectPath = path.join(root, 'blob')
    await writeFile(objectPath, 'x')
    const attachmentId = `sha256:${'b'.repeat(64)}`
    const { ctx, emit } = fakeContext({ hostPaths: new Map([[attachmentId, objectPath]]) })
    const injected = []
    apply(ctx, { remind: { enabled: true, minImages: 1, minBytes: 0, maxTimes: 1 } })

    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      imageEvent(1, attachmentId),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } },
    ]
    const session = fakeSession({ id: 'session-cafe0001', cwd: root, events })
    const agent = { session, inject: (message) => injected.push(message) }

    emit('agent/created', { agent })
    emit('session/event', session, events[2])
    await waitFor(() => injected.length > 0)
    assert.equal(injected.length, 1)
    assert.match(injected[0].content[0].text, /\/artifacts (clear|gc)/u)
    assert.equal(injected[0].role, 'user')

    // 第二次不再提醒（maxTimes = 1）
    emit('session/event', session, events[2])
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(injected.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('apply：没有 cwd 的会话静默跳过，命令给明确拒绝', async () => {
  const { ctx, state, emit } = fakeContext({ hostPaths: new Map() })
  apply(ctx, {})
  const session = fakeSession({ id: 'session-nocwd', cwd: undefined, events: [] })
  const agent = { session }
  emit('agent/created', { agent })
  emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const result = await state.command.handler({ agent, rawInput: 'list' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /cwd/u)
})
