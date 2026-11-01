/**
 * Host half of `dsh-shell-ui`.
 *
 * 整个插件是一个浏览器端外观层：设置面板按 macOS 系统设置重排，左栏的非导航
 * 全局面板行收进「更多」菜单。宿主侧没有行为，这一半只负责让 bundle 出现在
 * profile 的加载器里。
 */

/** Bundle id used by the profile patch entry. */
export const name = 'dsh-shell-ui'

/** No Host behaviour. */
export function apply() {}
