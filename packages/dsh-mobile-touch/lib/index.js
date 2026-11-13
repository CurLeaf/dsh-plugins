/**
 * Host half of `dsh-mobile-touch`.
 *
 * 纯浏览器端外观层：宿主侧没有行为，这一半只负责让 bundle 出现在 profile 的加载器里。
 */

/** Bundle id used by the profile patch entry. */
export const name = 'mobile-touch'

/** No Host behaviour. */
export function apply() {}
