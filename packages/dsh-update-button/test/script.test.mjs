import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/dsh-update.sh', import.meta.url))

test('脚本语法合法（bash -n）', async () => {
  await run('/bin/bash', ['-n', script])
})

test('--help 可用且提到 --check', async () => {
  const { stdout } = await run('/bin/bash', [script, '--help'])
  assert.match(stdout, /--check/)
  assert.match(stdout, /--tag/)
})

test('--check 输出一行可解析的 JSON；更旧的版本不算「有新版本」', async () => {
  const { stdout } = await run('/bin/bash', [script, '--check', '--tag', '0.0.0-test'])
  const line = stdout.trim().split('\n').filter(Boolean).pop()
  const parsed = JSON.parse(line)
  assert.equal(parsed.latest, '0.0.0-test')
  assert.equal(typeof parsed.current, 'string')
  assert.equal(parsed.updateAvailable, false, '0.0.0-test 一定比已装版本旧，不能报可更新')
})

test('--check 对明显更新的版本报「可更新」', async () => {
  const { stdout } = await run('/bin/bash', [script, '--check', '--tag', '99.0.0'])
  const parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop())
  assert.equal(parsed.latest, '99.0.0')
  assert.equal(parsed.updateAvailable, true)
})

test('--check 不写状态文件（只读检查）', async () => {
  const { stdout } = await run('/bin/bash', [script, '--check', '--tag', '0.0.0-test'])
  assert.ok(stdout.includes('"current"'))
})
