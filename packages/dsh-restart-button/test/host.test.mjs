/**
 * 宿主半边的行为测试：只测「决定」与「安排」，不真的重启任何东西。
 *
 * `launchRestart` 的 spawn / exit 都是注入点，所以三条路都能在测试里走一遍而
 * 不碰本机服务；`statusSnapshot` 用固定的 cgroup 文本与 now，断言浏览器拿到的
 * 形状稳定（客户端靠 `pid` 判断是否换了一个进程）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { launchRestart, normalizeConfig, statusSnapshot } from '../lib/index.js'

const CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n'

/** 记录 spawn 调用并返回一个假的子进程。 */
function spySpawn() {
  const calls = []
  const start = (file, args, options) => {
    calls.push({ file, args, options })
    return { on: () => {}, unref: () => {} }
  }
  return { calls, start }
}

test('statusSnapshot 汇报 pid、运行时长与这次重启会怎么走', () => {
  const snapshot = statusSnapshot({
    config: normalizeConfig({}),
    cgroup: CGROUP,
    now: Date.now(),
  })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.pid, process.pid)
  assert.equal(typeof snapshot.uptimeMs, 'number')
  assert.equal(snapshot.plan.kind, 'systemd')
  assert.equal(snapshot.plan.service, 'dsh-web.service')
  assert.equal(snapshot.plan.label, 'systemd · dsh-web.service')
})

test('normalizeConfig 只认非空字符串，并去掉首尾空白', () => {
  assert.deepEqual(normalizeConfig({ service: ' dsh-web.service ', command: '', delaySeconds: 3 }), {
    service: 'dsh-web.service',
    command: null,
    delaySeconds: 3,
  })
  assert.deepEqual(normalizeConfig(null), { service: null, command: null, delaySeconds: undefined })
})

test('systemd 计划通过瞬态 timer 调 systemctl --user restart', () => {
  const { calls, start } = spySpawn()
  const exits = []
  const result = launchRestart(
    { kind: 'systemd', service: 'dsh-web.service', delaySeconds: 1, reason: '' },
    { spawn: start, exit: (code) => exits.push(code) },
  )

  assert.equal(result.ok, true)
  assert.equal(result.how, 'systemd')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'systemd-run')
  assert.deepEqual(calls[0].args.slice(0, 3).map((value) => value.split('=')[0]), ['--user', '--collect', '--unit'])
  assert.ok(calls[0].args.includes('--on-active=1'))
  assert.deepEqual(calls[0].args.slice(-4), ['systemctl', '--user', 'restart', 'dsh-web.service'])
  assert.deepEqual(exits, [], '没退出进程')
})

test('command 计划把命令交给 /bin/sh -c', () => {
  const { calls, start } = spySpawn()
  const result = launchRestart(
    { kind: 'command', service: null, delaySeconds: 1, command: 'systemctl --user restart dsh-web.service', reason: '' },
    { spawn: start, exit: () => assert.fail('不该退出进程') },
  )

  assert.equal(result.how, 'command')
  assert.equal(calls[0].file, '/bin/sh')
  assert.deepEqual(calls[0].args, ['-c', 'systemctl --user restart dsh-web.service'])
})

test('exit 计划直接退出，交给 supervisor', () => {
  const exits = []
  const result = launchRestart(
    { kind: 'exit', service: null, delaySeconds: 1, reason: '' },
    { spawn: spySpawn().start, exit: (code) => exits.push(code) },
  )
  assert.equal(result.how, 'exit')
  assert.deepEqual(exits, [0])
})

test('systemd-run 不存在时退回 exit，而不是静默失败', () => {
  const exits = []
  const start = () => {
    const child = {
      on: (event, handler) => {
        if (event === 'error') handler(new Error('ENOENT'))
      },
      unref: () => {},
    }
    return child
  }
  const result = launchRestart(
    { kind: 'systemd', service: 'dsh-web.service', delaySeconds: 1, reason: '' },
    { spawn: start, exit: (code) => exits.push(code) },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(exits, [0], '错误回调里退出了进程')
})
