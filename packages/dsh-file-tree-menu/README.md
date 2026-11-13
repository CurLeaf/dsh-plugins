# dsh-file-tree-menu

给右侧栏的**工作区文件树**加一组右键动作。DSH 0.2.2 起，文件树的文件行和目录行都暴露了共享右键菜单（`file` / `directory` 两种 target），插件把自己的动作直接挂进去：

| 菜单项 | 行为 |
|---|---|
| **添加到会话** | 把 `@相对路径 ` 插到当前会话输入框的光标处（一次可撤销的纯文本编辑）；带空格的路径按 `@"路径"` 引用，目录带结尾 `/`。输入框接口不可用时退化为复制到剪贴板并提示。 |
| **复制名称** | 复制这个文件/目录的**名称**。 |
| **复制相对路径** | 相对工作区根目录的路径，例如 `docs/plan.md`。 |
| **复制绝对路径** | 树行携带的绝对路径；相对 target 由宿主解析。 |
| **重命名…** | 弹窗改最后一段名字；回车确认、Esc 取消；不覆盖同名文件。 |
| **删除…** | 先确认再删；目录连同内容一起删，不可撤销。 |

「在访达中显示」「下载」「在侧栏/浮窗打开」等由 DSH 自己的 `ui-open-in-app` / `ui-file-actions` 贡献，插件不重复添加。

## 为什么不用 DOM 监听

旧版 DSH（0.2.1 及更早）没有共享右键菜单，文件行也没有给行菜单留插槽；插件当时只能监听 `data-files-entry` 行上的 `contextmenu`，并且只能在挂载了 bridge 的「文件页」里工作——文件预览旁边的目录树没有那个插槽，右键就退回浏览器原生菜单。

现在插件优先使用 `ctx.contextMenus`：

- 文件行和目录行都能拿到 `{ sessionId, path }`，目录行也能用；
- 动作和宿主自己的「在侧栏打开 / 在访达中显示 / 下载」排在同一张菜单里，不再互相遮挡；
- 文件页、停靠预览、浮动预览共用同一份贡献，不依赖树 DOM 或 bridge 挂载位置；
- 会话通过 `conversation.input.dock` 把 `inputActions` 交给插件，所以「添加到会话」在预览旁边也能用。

没有 `contextMenus` 的旧版本会自动回退到原来的 DOM 菜单，功能保持不变。

## 安装

桌面端 profile（`~/.dsh/profiles/desktop`）：

```bash
dsh plugin --profile desktop add link:~/WorkSpace/dsh-plugins/packages/dsh-file-tree-menu
```

然后**退出并重新打开 DeepSeek Harness**。新插件要重新读一次 profile，窗口刷新（Cmd+R）不够。

已经装过旧版（profile 里是 `link:` 到本目录）的，更新的是同一份文件；同样退出重开 DSH 即可加载 0.2.1。升级后：

- 新版本走共享右键菜单，「添加到会话」在文件页和预览旁边都在；
- 旧版本（没有 `contextMenus`）仍走原来的 DOM 菜单；
- 回退菜单同时传 `anchorPoint` 与 `getAnchorRect`：0.2.2 起 `Menu` 用前者定位点触发菜单，旧 Host 仍认后者，升级前后菜单都挂在鼠标位置；
- 两个写操作还是同一条宿主路由，不需要改配置。

## 为什么还需要宿主半边

文件树的读写面 `workspaceFiles` 是只读的（`list` / `stat` / `read` / `changes`），重命名和删除没有对应接口。所以写操作走插件自己的宿主路由：

```
浏览器                                    宿主
┌────────────────────────────┐           ┌──────────────────────────────┐
│ 共享右键菜单                │           │ POST /dsh-file-tree-menu/action    │
│ @ 引用 / 复制 / 对话框      │  ──写──▶  │ 重命名、删除                  │
│ 重命名、删除（对话框）      │           │ 鉴权、限界、路径校验          │
└────────────────────────────┘           └──────────────────────────────┘
```

写操作的路由只有一条，安全全在宿主这一侧：

- 先过 `connection.requestRejection`：Host/Origin 围栏 + 浏览器登录 Cookie；没有这个服务的组合直接 **503 失败关闭**，不会接受匿名写入。
- 请求体限 `application/json`、64 KiB、已知 action、绝对路径。
- 目标必须存在，且它的**父目录 realpath** 落在某个会话工作区（或 sandbox 工作区）之内——树里的软链接指到外面也绕不过去；删除/重命名软链接本身仍然允许。
- 工作区根目录永远不能作为目标（它的父目录在外面，第一道限界就拒绝）。
- 重命名只改最后一段，且不覆盖已存在的条目（大小写不敏感卷上的「只改大小写」放行）。

## 操作完树会自己刷新

文件树本来就在用 `workspaceFiles.changes` 盯目录，宿主的改名/删除会触发同一条变更流，树自动重读。**关掉了「自动刷新」**（树头部的暂停按钮）时不会自动重读，按一下刷新即可。

## 验证

```bash
npm test
```

- `test/host.test.mjs`：真实临时目录 + 假 Cordis 上下文，覆盖改名、删除、越界、软链接逃逸、根目录保护、覆盖拒绝、鉴权、请求体校验。
- `test/client.test.mjs`：bundle 的注册契约与路径/`@` 引用规则。
- `test/context-menu.test.mjs`：共享右键菜单的 target 注册、文件/目录的 `@` 引用、空格路径、根目录/越界路径不出动作、复制动作的解析。
- `test/context-menu-dom.test.mjs`：jsdom + 真 React 渲染 `conversation.input.dock` 宿主，覆盖 `inputActions` 捕获、清理，以及删除对话框回写绝对路径。
- `test/client-dom.test.mjs`：旧版回退菜单（jsdom + 真 React），覆盖菜单内容、三种复制、插入输入框、重命名失败/成功、删除确认、Esc、显示位置。

测试用的 `jsdom` / `react` / `react-dom` 是 `devDependencies`，不会随插件发布。

## 兼容性

- **DSH 0.2.2+**：使用 `ctx.contextMenus` 的 `file` / `directory` target，动作在共享菜单里。`package.json` 的 `dsh.client.inject` 声明了 `@deepseek-ai/dsh-client-ui-context-menu`，保证服务先于本插件就位（旧版没有这个包时该声明会被忽略）。
- **DSH 0.2.1 及更早**：没有 `contextMenus` 时自动回退到 DOM 菜单；回退依赖 `data-files-entry` / `data-files-path` / `data-files-root` 和 `sidebar.right.tab.files.actions` 插槽。
- **服务晚到**：如果 `contextMenus` 在本插件 apply 之后才出现（同一构建里加载顺序不确定时），插件会改用共享菜单并卸掉 DOM 监听，不会留下一份看不见的旧菜单，也不会两张菜单同时弹。
- 「添加到会话」依赖会话作用域的 `inputActions`（从 `conversation.input.dock` 捕获）；「重命名」「删除」的对话框也挂在这个插槽上，所以两种模式下都会注册它；拿不到 `inputActions` 时「添加到会话」退化成复制引用，不会静默失败。
- 共享菜单的 target 形状是 DSH 的内部约定；DSH 升级后如果 target 改成相对路径或换字段，插件需要跟着改。回退菜单的 DOM 约定同理。

## 已知限制

- 文案目前是中文；界面语言换成英文时菜单仍是中文。
- 删除是**直接删除**，不进废纸篓。
- 重命名/删除以**宿主进程本身的权限**执行（等同于你在终端里操作），不经过会话的沙箱策略；这是你在界面上的主动操作，因此不受智能体沙箱限制。
- 工作区根目录不能重命名或删除；「添加到会话」对根目录也不显示（`@` 引用从根目录开始没有意义）。
- 树行 target 本身就带绝对路径；只有相对的 target 才会通过 `workspaceFiles.stat` 解析。解析不到绝对路径时「复制绝对路径」「重命名」「删除」自动隐藏，「添加到会话」「复制名称/相对路径」不受影响。

## 卸载

从 profile 的 `dependencies` 里删掉 `dsh-file-tree-menu`、从 `dsh.profile.bundles` 删掉同名条目，删掉 `node_modules/dsh-file-tree-menu`，重启应用。
