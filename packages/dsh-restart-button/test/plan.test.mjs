/**
 * `dsh-restart-button` 的重启计划是纯函数：这些测试只喂文本与配置，断言选哪条路。
 *
 * 覆盖三条路（command / systemd / exit）和两个容易出错的边界：
 *   - cgroup v2 的多行文本里只认最后那个 `*.service`；
 *   - delaySeconds 是配置值，必须夹在 [0, 30] 且是整数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { describePlan, normalizeDelay, resolvePlan, serviceFromCgroup } from '../lib/plan.js'

const CGROUP_V2 =
  '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service\n'

test('serviceFromCgroup 读出 cgroup v2 的单元名', () => {
  assert.equal(serviceFromCgroup(CGROUP_V2), 'dsh-web.service')
})

test('serviceFromCgroup 容忍前后空白与多行', () => {
  assert.equal(serviceFromCgroup(`\n  ${CGROUP_V2.trim()}  \n`), 'dsh-web.service')
  assert.equal(
    serviceFromCgroup('0::/system.slice/other.service\n0::/user.slice/user@1000.service/app.slice/dsh-web.service'),
    'dsh-web.service',
  )
})

test('serviceFromCgroup 对 docker / 前台启动返回 null', () => {
  assert.equal(serviceFromCgroup(''), null)
  assert.equal(serviceFromCgroup('0::/docker/abc123'), null)
  assert.equal(serviceFromCgroup('not a cgroup'), null)
  assert.equal(serviceFromCgroup(undefined), null)
})

test('normalizeDelay 夹到 [0, 30] 的整数秒', () => {
  assert.equal(normalizeDelay(0), 0)
  assert.equal(normalizeDelay(2.9), 2)
  assert.equal(normalizeDelay(99), 30)
  assert.equal(normalizeDelay(-1), 1, '非法值回到默认 1 秒')
  assert.equal(normalizeDelay('3'), 3)
  assert.equal(normalizeDelay('abc'), 1)
  assert.equal(normalizeDelay(undefined), 1)
})

test('Linux + systemd：计划是 systemd restart 到 cgroup 里的单元', () => {
  const plan = resolvePlan({ config: {}, cgroup: CGROUP_V2, platform: 'linux' })
  assert.equal(plan.kind, 'systemd')
  assert.equal(plan.service, 'dsh-web.service')
  assert.equal(plan.delaySeconds, 1)
})

test('显式配置的 service 优先于 cgroup', () => {
  const plan = resolvePlan({
    config: { service: 'dsh-prod.service', delaySeconds: 2 },
    cgroup: CGROUP_V2,
    platform: 'linux',
  })
  assert.equal(plan.kind, 'systemd')
  assert.equal(plan.service, 'dsh-prod.service')
  assert.equal(plan.delaySeconds, 2)
})

test('配置了 command 就用自己的命令，但仍然汇报探测到的单元', () => {
  const plan = resolvePlan({
    config: { command: 'systemctl --user restart dsh-web.service' },
    cgroup: CGROUP_V2,
    platform: 'linux',
  })
  assert.equal(plan.kind, 'command')
  assert.equal(plan.command, 'systemctl --user restart dsh-web.service')
  assert.equal(plan.service, 'dsh-web.service')
})

test('没有 systemd（容器 / 前台）退到 exit', () => {
  const plan = resolvePlan({ config: {}, cgroup: '0::/docker/abc', platform: 'linux' })
  assert.equal(plan.kind, 'exit')
  assert.equal(plan.service, null)
})

test('非 Linux 平台不假装有 systemd', () => {
  const plan = resolvePlan({ config: {}, cgroup: CGROUP_V2, platform: 'darwin' })
  assert.equal(plan.kind, 'exit')
  assert.equal(plan.service, 'dsh-web.service', '仍把探测结果带出来，方便面板解释')
  assert.equal(plan.reason.includes('darwin'), true)
})

test('describePlan 给三种计划一句人话', () => {
  assert.equal(describePlan({ kind: 'command' }), '自定义命令')
  assert.equal(describePlan({ kind: 'systemd', service: 'dsh-web.service' }), 'systemd · dsh-web.service')
  assert.equal(describePlan({ kind: 'exit' }), '退出进程（等 supervisor）')
  assert.equal(describePlan(undefined), '未知')
})
