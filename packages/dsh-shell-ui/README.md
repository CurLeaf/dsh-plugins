# dsh-shell-ui

把两处纯外观的 DSH 外壳补丁合进同一条 bundle：

| 部分 | 做什么 | 原来是谁 |
|---|---|---|
| **设置面板** | 把「账号与余额」等设置页重排成 macOS 系统设置的样子：居中分组卡片、44pt 行、内嵌分隔线 | `dsh-settings-apple` |
| **左栏折叠** | 左栏只留「插件」「自动化任务」两行，其余全局面板（命令面板、工作区 Git、MCP 连接器…）收进现成的「更多」菜单，折叠面板处于打开状态时「更多」行带一个点 | `dsh-sidebar-fold` |

两半都只读 DOM、只写自己的 `<style>`，不碰宿主与第三方插件的布局容器。合成一个包以后少一条 bundle，也少一份要跟的 profile 记录。

## 安装

```bash
dsh plugin --profile desktop add link:~/WorkSpace/dsh-plugins/packages/dsh-shell-ui
```

或者等价的 profile 改法：`dependencies` 里加一条 link，`dsh.profile.bundles` 里加 `dsh-shell-ui`。装完**退出并重启** DeepSeek Harness，窗口刷新不够。

## 结构

```
lib/index.js   宿主半边：没有行为，只让 bundle 出现在加载器里
lib/client.js  浏览器半边：两个外观层，各自一个 style 标签、各自一个 effect
test/          jsdom 冒烟：两半都装上、卸载不留痕
```

`dsh.client.inject` 是两半需要的客户端模块并集：`ui-settings-account`（设置面板）与 `ui-sidebar`（左栏）。

## 卸载

从 profile 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-shell-ui`，重装依赖，重启。
