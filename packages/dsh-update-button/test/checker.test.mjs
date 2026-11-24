import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createChecker, parseDistTags, pickTarget } from '../lib/checker.js'

/** 造一个假的 child_process.spawn：emit 一段 stdout 后 close。 */
function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => {
      if (stderr !== '') child.stderr.emit('data', stderr)
      if (stdout !== '') child.stdout.emit('data', stdout)
      child.emit('close', code)
    })
    return child
  }
}

/** 记录调度但不真正触发。 */
function fakeTimers() {
  const delays = []
  return {
    delays,
    setTimer: (fn, delay) => {
      delays.push(delay)
      return { unref() {} }
    },
    clearTimer: () => {},
  }
}

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-check-'))
  return { dir, paths: { checkFile: join(dir, 'update-check.json') } }
}

test('parseDistTags：只收合法 semver，坏 JSON 当空', () => {
  assert.deepEqual(parseDistTags('{"latest":"0.2.2-rc.1","next":"0.2.2-rc.3","bad":"latest"}'), {
    latest: '0.2.2-rc.1',
    next: '0.2.2-rc.3',
  })
  assert.deepEqual(parseDistTags('not json'), {})
  assert.deepEqual(parseDistTags(''), {})
})

test('pickTarget：在 next 与 latest 里取最高，并保证不降级', () => {
  const tags = { latest: '0.2.2-rc.1', next: '0.2.2-rc.3' }
  assert.deepEqual(pickTarget({ tags, channel: 'next', current: '0.2.1-rc.5' }), {
    target: '0.2.2-rc.3',
    updateAvailable: true,
  })
  // 稳定版刚发：latest 反超 next，也要跟上
  assert.deepEqual(pickTarget({ tags: { latest: '0.3.0', next: '0.2.2-rc.3' }, channel: 'next', current: '0.2.2-rc.3' }), {
    target: '0.3.0',
    updateAvailable: true,
  })
  // 已经是最新：不提示
  assert.deepEqual(pickTarget({ tags, channel: 'next', current: '0.2.2-rc.3' }), {
    target: '0.2.2-rc.3',
    updateAvailable: false,
  })
  // npm 标签指回旧版本：拒绝降级
  assert.deepEqual(pickTarget({ tags: { latest: '0.2.0' }, channel: 'latest', current: '0.2.2-rc.3' }), {
    target: '0.2.2-rc.3',
    updateAvailable: false,
  })
  // 一个合法版本都没有
  assert.deepEqual(pickTarget({ tags: {}, channel: 'next', current: '0.2.2-rc.3' }), {
    target: null,
    updateAvailable: false,
  })
})

test('checker：成功检查后写入结论并落盘', async () => {
  const { paths } = tempPaths()
  const timers = fakeTimers()
  const checker = createChecker({
    config: { channel: 'next', checkIntervalMs: 900_000 },
    paths,
    currentVersion: () => '0.2.1-rc.5',
    deps: {
      spawn: fakeSpawn({ stdout: '{"latest":"0.2.2-rc.1","next":"0.2.2-rc.3"}' }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: () => 1_700_000_000_000,
    },
  })
  const snapshot = await checker.check({ force: true })
  assert.equal(snapshot.current, '0.2.1-rc.5')
  assert.equal(snapshot.target, '0.2.2-rc.3')
  assert.equal(snapshot.updateAvailable, true)
  assert.equal(snapshot.lastCheckAt, 1_700_000_000_000)
  assert.equal(snapshot.lastError, '')

  const saved = JSON.parse(readFileSync(paths.checkFile, 'utf8'))
  assert.equal(saved.target, '0.2.2-rc.3')
  assert.equal(saved.updateAvailable, true)
})

test('checker：失败计数并退避，下一次更晚', async () => {
  const { paths } = tempPaths()
  const timers = fakeTimers()
  const checker = createChecker({
    config: { channel: 'next', checkIntervalMs: 60_000 },
    paths,
    currentVersion: () => '0.2.2-rc.3',
    deps: {
      spawn: fakeSpawn({ code: 1, stderr: 'ENETUNREACH' }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: () => 1_700_000_000_000,
    },
  })
  const snapshot = await checker.check({ force: true })
  assert.equal(snapshot.failures, 1)
  assert.match(snapshot.lastError, /ENETUNREACH/)
  assert.equal(snapshot.updateAvailable, false)
})

test('checker：并发 check 只发一次请求', async () => {
  const { paths } = tempPaths()
  const timers = fakeTimers()
  let calls = 0
  const spawn = fakeSpawn({ stdout: '{"next":"0.2.2-rc.3"}' })
  const checker = createChecker({
    config: { channel: 'next', checkIntervalMs: 900_000 },
    paths,
    currentVersion: () => '0.2.2-rc.3',
    deps: {
      spawn: () => {
        calls += 1
        return spawn()
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    },
  })
  await Promise.all([checker.check({ force: true }), checker.check({ force: true }), checker.check({ force: true })])
  assert.equal(calls, 1)
})
