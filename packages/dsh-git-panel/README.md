# @qzsy/dsh-git-panel

右侧栏里的一个 **Git 分区**：当前会话工作目录的改动、提交框、暂存/丢弃、改动预览标签页，和一张提交分支图。

功能与交互按本机 Cursor IDE 的 Git 模块对齐——它的源码控制面板（`CHANGES`）加上面板底下那张源码控制图（`GRAPH`）。差别在落点：Cursor 把它放在左侧活动栏，DSH 只有右侧栏是标签式的，所以这里做成右侧栏的两个标签页类型。

## 看得见的效果

在右侧栏的引导页（`+` → 卡片）里多一张 **Git** 卡片，点开就是 Git 分区：

- **顶部就是提交框**：不再有独立工具条；仓库动作全部并进了分支图顶栏（见下）。
- **提交框**：提交信息输入框，`Ctrl/⌘+Enter` 直接提交；主按钮右侧的小箭头里有「提交（已暂存）」「提交全部改动」「修订上一次提交」「跳过校验钩子提交」「提交后推送」；右侧 `⋯` 里是「撤销上一次提交」「暂存改动」「恢复暂存的改动」。
- **CHANGES 分区**：分组列出 冲突 / 已暂存 / 未暂存 / 未跟踪，每行带**文件类型图标**（代码 / 配置 / 样式 / 文档 / 图片 / 音视频 / 字体 / 归档 / 脚本 / 锁文件 / 普通文件）与**改动类型图标**（修改 / 新增 / 未跟踪 / 删除 / 重命名 / 复制 / 类型变更 / 冲突，颜色与虚线圈区分暂存与否）、`+/-` 行数；悬停出现暂存、取消暂存、丢弃、看改动、打开文件五个动作；分区标题右侧是全部暂存 / 全部取消暂存 / 全部丢弃 / 预览全部改动。
- **GRAPH 分区**：泳道图（合并节点画空心圈）+ 分支/标签/远端徽标 + 摘要 + 作者 + 相对时间；点一行展开提交说明面板（作者、时间、hash、正文、文件清单与 `+/-`），并给出「查看这次提交的改动」「复制 hash」「切换到这个分支」。
- **分支图顶栏**：左边是折叠热区（chevron + 「分支图」+ 计数），右边是仓库动作——当前分支胶囊（内含 `↑ahead / ↓behind`，点开向上弹出本地分支菜单）、「当前分支 / 全部引用」切换、抓取、同步、刷新。折叠热区只覆盖左侧标签簇，不会误触右侧按钮；面板窄于 300px 时自动隐藏「抓取」（同步已经包含 fetch）。
- **改动预览标签页**：点文件行 → 新标签显示这个文件的统一 diff（带双行号），标题就是这个文件的路径；未跟踪的新文件没有 index 版本，由 Host 直接合成「整篇新增」的补丁，所以看到的是全绿；「预览全部改动」把已暂存、未暂存、新文件拼成一张总 diff。
- **打开文件标签页**：文件行的「打开文件」走侧栏自己的 `openResource`（`dsh-resource://file/session/...`），落进任何文件链接都会用的那个预览器。

样式按「Apple 语义色 + 源码控制图布局」重做：表面/文字/分隔线全部取宿主的 `--dsw-alias-*` 语义 token，亮色与暗色主题自动跟随，不再假定深色；行高、计数、状态芯片、弹层和 diff 行号都按同一套 4/8pt 间距重排。

所有丢弃、撤销提交都要点一次确认才执行——不会一点就掉改动。「丢弃」的确认是面板底部的一次性浮层（不随列表滚走，Esc 或点空白处取消）；确认后真的执行：已跟踪文件回到 HEAD，未跟踪与「已暂存的新文件」连内容一起删掉，列表随即刷新。

## 结构

```
lib/index.js    Host 半：一个鉴权路由 POST /api/git-panel
lib/client.js   浏览器半：两个标签页类型 + 面板与预览页
test/           host 侧真仓库行为测试 + client 侧注册契约测试
```

**改包名时必须同时改两处**：`cordis.patch.yml` 的 `insert[].name`，以及 `lib/client.js` 里
`window.__ModuleLoader__.load({ id })` 的 `id`。web loader 按包名去抓脚本，脚本注册的名字和包名
不一致会被判成「loaded without registering」，那是整页插件加载失败（白屏），不是只掉一个分区。
`test/client.test.mjs` 现在直接拿 `package.json` 的 `name` 断言这个 id，改名漏了会先在这里红。

Host 半只做 git：读（`status` / `graph` / `diff` / `commitDetail` / `branches`）与写（`stage` / `unstage` / `discard` / `commit` / `undoCommit` / `network` / `checkout` / `stash`）。浏览器半只渲染和调它。

安全边界都在 Host 半：

- 路由只通过 `connection` 服务注册，走和其它 Host 功能一样的 Host/Origin 栅栏 + 登录 cookie。
- `cwd` 必须是绝对目录，且解析后落在 Git 工作树里。
- 写操作点名的每个路径都要在仓库根内重新解析，`..`、绝对路径、软链逃逸一律在 git 跑起来之前拒绝。
- 命令一律用参数数组 spawn（不过 shell），环境变量洗过：无交互提示、无分页器、C locale。
- 提交信息从 stdin 进去（`git commit -F -`），所以换行、引号、`$(...)` 都不会被任何一层改写。

## 安装

```bash
# 1) 装进 profile（本地改代码用 link:，发版后用包名）
dsh plugin --profile web add link:/path/to/dsh-plugins/packages/dsh-git-panel

# 2) 包名会记进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles，
#    bundle 自己的 cordis.patch.yml 声明 insert 行，用户层 patch 不用动

# 3) 退出并重启 DeepSeek Harness —— 新增 bundle 不在已运行进程的模块图里，
#    刷新窗口不够
```

确认组合进去了：

```bash
dsh --profile web --dump-config | grep -A2 dsh-git-panel
```

## 测试

```bash
node --test test/*.test.mjs
```

- `test/host.test.mjs`：NUL 分帧解析（porcelain v2 / numstat -z / `%D` 装饰）、路径逃逸拒绝、真临时仓库里的
  status → stage → unstage → discard、提交（含 smart commit）→ graph → commitDetail、diff 三种范围、
  分支列表与切换、undoCommit 退回归暂存区、stash 往返、非仓库目录答 `repo:false`、路由注册与错误信封。
- `test/client.test.mjs`：用桩 loader 跑真实 `lib/client.js`，断言两个标签页类型的 id/kind/优先级/引导卡片、
  效果注册数量，以及纯函数（diff 解析、泳道布局、文件地址、占位符）。

## 已知边界

- 只看当前会话工作目录所在仓库；多仓库工作区不会并列显示。
- 不做 hunk 级暂存（Cursor / VS Code 的 `stageSelectedRanges`）、不做编辑器内联 blame、不做合并编辑器。
- 提交图按 `--date-order` 取最近 60 条，节点动画与悬停统计不做。
- `network`（抓取/拉取/推送）依赖本机 git 的凭据配置；没有可用凭据时把 git 的 stderr 原样报出来。
