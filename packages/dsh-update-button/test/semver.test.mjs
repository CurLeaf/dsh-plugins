import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { compareSemver, highest, isNewer, isValid, parseSemver } from '../lib/semver.js'

test('parseSemver：解析正式版与预发布版，非法输入返回 null', () => {
  assert.deepEqual(parseSemver('0.2.2-rc.3'), { major: 0, minor: 2, patch: 2, pre: ['rc', 3] })
  assert.deepEqual(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] })
  assert.deepEqual(parseSemver('1.2.3+build.7'), { major: 1, minor: 2, patch: 3, pre: [] })
  assert.equal(parseSemver('latest'), null)
  assert.equal(parseSemver(''), null)
  assert.equal(parseSemver(undefined), null)
})

test('compareSemver：数值段优先于预发布段', () => {
  assert.equal(compareSemver('0.2.10', '0.2.9'), 1)
  assert.equal(compareSemver('0.2.2', '0.2.2-rc.3'), 1)
  assert.equal(compareSemver('0.2.2-rc.3', '0.2.2'), -1)
})

test('compareSemver：rc 序号按数值比，不是字典序', () => {
  assert.equal(compareSemver('0.2.2-rc.10', '0.2.2-rc.9'), 1)
  assert.equal(compareSemver('0.2.2-rc.9', '0.2.2-rc.10'), -1)
  assert.equal(compareSemver('0.2.2-rc.3', '0.2.2-rc.3'), 0)
})

test('compareSemver：alpha < beta < rc < stable', () => {
  assert.equal(compareSemver('0.2.2-alpha.3', '0.2.2-beta.1'), -1)
  assert.equal(compareSemver('0.2.2-beta.1', '0.2.2-rc.1'), -1)
  assert.equal(compareSemver('0.2.2-rc.1', '0.2.2'), -1)
})

test('isNewer：只认严格更新，非法版本一律 false', () => {
  assert.equal(isNewer('0.2.2-rc.4', '0.2.2-rc.3'), true)
  assert.equal(isNewer('0.2.2-rc.3', '0.2.2-rc.3'), false)
  assert.equal(isNewer('0.2.1', '0.2.2-rc.3'), false)
  assert.equal(isNewer('nope', '0.2.2'), false)
  assert.equal(isNewer('0.2.2', 'nope'), false)
})

test('highest：跳过非法值，取最大', () => {
  assert.equal(highest(['0.2.2-rc.1', null, '0.2.2-rc.3', 'latest']), '0.2.2-rc.3')
  assert.equal(highest([null, undefined]), null)
})

test('isValid', () => {
  assert.equal(isValid('1.0.0'), true)
  assert.equal(isValid('1.0'), false)
})
