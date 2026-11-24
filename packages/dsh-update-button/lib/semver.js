/**
 * 语义化版本比较：只做 DSH 需要的那部分，但把 pré-release 顺序做对。
 *
 *   `0.2.2-rc.10 > 0.2.2-rc.9`（数字段按数值比，不是字典序）
 *   `0.2.2-rc.3   > 0.2.2-alpha.9`（rc 的 ASCII 序在 alpha 之后，符合 semver）
 *   `0.2.2        > 0.2.2-rc.3`（有 pré-release 的一定更旧）
 *   `0.2.10-rc.1  > 0.2.9`（先比数值段）
 *
 * 官方发布节奏是 rc/alpha 一串，字符串不等于比较会把 `rc.10` 判成比 `rc.9` 旧，
 * 也会把「降级」当成「更新」推给用户。所以这里按 semver 规范逐段比。
 */

/**
 * 解析版本号；非法返回 null。
 * @param {unknown} input 版本字符串（允许前缀 v、后缀 build 元数据）。
 * @returns {{major:number,minor:number,patch:number,pre:Array<string|number>}|null}
 */
export function parseSemver(input) {
  if (typeof input !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim())
  if (match === null) return null
  const pre = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/**
 * -1 / 0 / 1 三段式比较；任一侧非法时按「无法比较」返回 0。
 * @param {string} left 左版本。
 * @param {string} right 右版本。
 * @returns {number} 负数表示 left < right。
 */
export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === null || b === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = typeof x === 'number'
    const yNumeric = typeof y === 'number'
    if (xNumeric && yNumeric) return x < y ? -1 : 1
    if (xNumeric) return -1
    if (yNumeric) return 1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/** `candidate` 是否严格新于 `current`。 */
export function isNewer(candidate, current) {
  if (!isValid(candidate) || !isValid(current)) return false
  return compareSemver(candidate, current) > 0
}

/** 是否是合法 semver。 */
export function isValid(version) {
  return parseSemver(version) !== null
}

/**
 * 从一组候选里挑最高版本。
 * @param {Array<string|null|undefined>} versions 候选。
 * @returns {string|null} 最高版本；没有合法值时 null。
 */
export function highest(versions) {
  let best = null
  for (const version of versions) {
    if (!isValid(version)) continue
    if (best === null || compareSemver(version, best) > 0) best = version
  }
  return best
}
