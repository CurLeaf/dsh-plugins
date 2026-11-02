# dsh-plugins

自己手写的 DeepSeek Harness 插件，收在一个 pnpm workspace 里：一份依赖、一次测试、一条发版命令。

原来每个插件一个目录、一个仓库、一套手动发版流程；收到这里以后，**包还是独立发布、独立版本**，只是维护面从 N 套变成 1 套。

## 这里的包

| 包 | 做什么 | 在 profile 里的形态 |
|---|---|---|
| `dsh-file-tree-menu` | 工作区文件树右键菜单：添加到会话、在访达中显示、复制名/相对路径/绝对路径、重命名、删除（写操作走宿主的鉴权路由） | 1 条 bundle |
| `dsh-command-rea` | 斜杠命令 `/rea`：把逆向分析请求交给 `reverse-engineer-anything` 技能与 REA MCP，附带钉死 DSH 版本的菜单面孔补丁 | 1 条 bundle |
| `dsh-cursor-bridge` | 把项目里的 `.cursor/skills`、`.cursor/commands` 投影成 DSH 技能，直接进「/」菜单 | 1 条 bundle |
| `dsh-shell-ui` | 纯外观层：macOS 式设置面板卡片 + 左栏非导航面板折叠进「更多」 | 1 条 bundle |
| `dsh-git-panel` | 右侧栏 Git 分区：改动分组、提交框、暂存/丢弃、改动预览标签页、提交分支图（按本机 Cursor 的 Git 模块对齐） | 1 条 bundle |
| `dsh-restart-button` | 侧栏脚部（手机抽屉的头像行上方）一行「重启 DSH」：两段式确认、自动等进程回来并刷新；宿主侧从 cgroup 认 systemd 单元 | 1 条 bundle |

`dsh-shell-ui` 是合并出来的：原来的 `dsh-settings-apple` 与 `dsh-sidebar-fold` 两半外观合成一个包，少一条 bundle、也少一份要同步的配置。

`dsh-git-panel` 的 Host 半只跑 git（一个鉴权路由），浏览器半只渲染，所以它和本机 Cursor 的 Git 面板可以对得上，而不需要把 Cursor 的任何东西搬进来。

`dsh-restart-button` 同理：浏览器半只发一个请求，重启由宿主按 `systemd → 自定义命令 → 退出进程` 的顺序挑一条路，页面靠 `pid` 变化判断服务已经回来。

## 不在这里的插件

| 仓库 | 为什么独立 |
|---|---|
| `dsh-browser-studio` | 435MB devDeps（Electron / Playwright）、自带构建与 CI，挪进来只会让每次 `pnpm install` 变重 |
| `dsh-sidebar-share` | 已发布 0.1.7、有独立 release 脚本与历史 |
| `dsh-remote-panel` | 跨端（含 android/）、依赖自成一统、自带 CI |
| `dsh-pet-slim` | 趣味件，按设计不参与整合 |
| `dsh-git-branch-pill` | 只发 npm 的小件，源码不在工作区 |

这三个大件将来若要收编，建议单独一轮，别跟小包混在一起搬。

## 开发

```bash
pnpm install          # 一次装齐四个包的依赖
pnpm -r test          # 全量测试（node:test，没有构建步骤）
```

没有构建步骤是刻意的：这几个包的 `lib/`、`dist/` 就是源码，profile 直接加载，省掉「改完忘了 build」这一类故障。

`dsh-command-rea` 的 postinstall 会给已安装的 DSH 打菜单面孔补丁；没有装 DSH 的机器上它会自己跳过，CI 里用 `DSH_COMMAND_REA_PATCH=0` 显式关掉。

## 发版

```bash
pnpm release --dry-run   # 看会发布哪些包（只发本地版本比 npm 新的）
pnpm release             # 真发，并给每个版本打 <包名>@<版本> 的 tag
git push --tags
```

版本号手写，脚本不替你 bump：发版只是把已经写好的东西送出去。

## 安装到 profile

```bash
dsh plugin --profile desktop add link:~/WorkSpace/dsh-plugins/packages/<包名>
```

改完 profile 必须**退出并重启** DeepSeek Harness——窗口刷新（Cmd+R）不会重新读 bundle 列表。
