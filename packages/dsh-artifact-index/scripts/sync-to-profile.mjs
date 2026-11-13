#!/usr/bin/env node
/**
 * 把本包的源码同步进正在使用的 DSH profile（默认 ~/.dsh/profiles/web）。
 *
 * 为什么需要它：profile 装的是 registry 版本，本地改完 lib/ 不会自动生效；
 * 直接手抄 node_modules 又容易漏文件。这个脚本幂等，改完源码执行一次，
 * 重启 DSH 后生效。
 *
 * 用法：
 *   pnpm sync:profile                 # 默认 profile
 *   DSH_PROFILE_DIR=/path/to/profile pnpm sync:profile
 */
import { cp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(homedir(), '.dsh', 'profiles', 'web')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const dest = path.join(profileDir, 'node_modules', ...pkg.name.split('/'))

const ENTRIES = ['lib', 'locale', 'cordis.patch.yml', 'package.json', 'icon.svg', 'README.md', 'LICENSE']

for (const entry of ENTRIES) {
  const from = new URL(`../${entry}`, import.meta.url)
  const to = path.join(dest, entry)
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true })
}
console.log(`已同步 ${pkg.name}@${pkg.version} → ${dest}\n重启 DSH 后生效。`)
