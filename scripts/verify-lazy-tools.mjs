#!/usr/bin/env node
/**
 * verify-lazy-tools — 从会话日志里量「每次请求的工具体积」，用来核对按需加载是否生效。
 *
 * 读的是 ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd 里的
 * request/header 事件（DSH 每次请求都会记录实际发出的 tools 数组），所以这是
 * 模型真正看到的工具清单，不是配置推测。
 *
 * 用法：
 *   node scripts/verify-lazy-tools.mjs                 # 最近 6 个会话
 *   node scripts/verify-lazy-tools.mjs --session 6a4e36d3
 *   node scripts/verify-lazy-tools.mjs --since 18:00   # 只看该时间之后的 header
 *   node scripts/verify-lazy-tools.mjs --expect cold   # 冷启动基线 44 个 / ego 10 / rea 0
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const sessionFilter = valueOf('--session')
const sinceFilter = valueOf('--since')
const expect = valueOf('--expect')
const limit = Number(valueOf('--limit') ?? 6)

function valueOf(flag) {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  return args[index + 1]
}

function parseSince(text) {
  if (text === undefined) return 0
  const [hh, mm] = text.split(':').map(Number)
  const now = new Date()
  const at = new Date(now)
  at.setHours(hh, mm ?? 0, 0, 0)
  return at.getTime()
}

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
if (!fs.existsSync(sessionsRoot)) {
  console.error(`no sessions directory: ${sessionsRoot}`)
  process.exit(1)
}

function readHeaders(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.includes('"request/header"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const tools = event?.data?.header?.tools
    if (!Array.isArray(tools)) continue
    out.push({
      time: event.time,
      tools,
      ego: tools.filter((tool) => tool.name.startsWith('ego_')).length,
      rea: tools.filter((tool) => tool.name.startsWith('mcp__rea__')).length,
      bootstrap: tools.some((tool) => tool.name === 'load_tool_group'),
      bytes: Buffer.byteLength(JSON.stringify(tools))
    })
  }
  return out
}

const since = parseSince(sinceFilter)
const files = []
for (const workspace of fs.readdirSync(sessionsRoot)) {
  const workspaceDir = path.join(sessionsRoot, workspace)
  if (!fs.statSync(workspaceDir).isDirectory()) continue
  for (const session of fs.readdirSync(workspaceDir)) {
    if (sessionFilter !== undefined && !session.includes(sessionFilter)) continue
    const file = path.join(workspaceDir, session, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    files.push({ workspace, session, file, mtime: fs.statSync(file).mtimeMs })
  }
}
files.sort((a, b) => b.mtime - a.mtime)

const rows = []
for (const entry of files.slice(0, limit)) {
  for (const header of readHeaders(entry.file)) {
    if (header.time < since) continue
    rows.push({ ...header, workspace: entry.workspace, session: entry.session.slice(0, 16) })
  }
}

if (rows.length === 0) {
  console.log('no request headers found')
  process.exit(0)
}
rows.sort((a, b) => a.time - b.time)

const pad = (text, width) => String(text).padEnd(width)
console.log(`${pad('time', 10)}${pad('workspace', 34)}${pad('tools', 7)}${pad('ego', 5)}${pad('rea', 5)}${pad('bootstrap', 10)}${pad('bytes', 9)}`)
for (const row of rows) {
  const time = new Date(row.time).toLocaleTimeString('zh-CN', { hour12: false })
  console.log(
    `${pad(time, 10)}${pad(row.workspace.replace(/^--|--$/g, ''), 34)}${pad(row.tools.length, 7)}${pad(row.ego, 5)}${pad(row.rea, 5)}${pad(row.bootstrap ? 'yes' : 'no', 10)}${pad(row.bytes, 9)}`
  )
}

if (expect !== undefined) {
  const last = rows.at(-1)
  const checks = []
  if (expect === 'cold') {
    checks.push(['tools', 44], ['ego', 10], ['rea', 0], ['bootstrap', true])
  } else if (expect === 'browser') {
    checks.push(['tools', 69], ['ego', 35], ['rea', 0])
  } else if (expect === 'rea') {
    checks.push(['ego', 35], ['rea', 229])
  } else {
    console.error(`unknown --expect value: ${expect} (cold | browser | rea)`)
    process.exit(1)
  }
  let failed = false
  for (const [key, want] of checks) {
    const got = key === 'bootstrap' ? last.bootstrap : key === 'tools' ? last.tools.length : last[key]
    if (got !== want) {
      failed = true
      console.error(`expectation failed: ${key} = ${got}, want ${want}`)
    }
  }
  console.log(failed ? 'verdict: MISMATCH' : `verdict: OK (${expect})`)
  process.exit(failed ? 1 : 0)
}
