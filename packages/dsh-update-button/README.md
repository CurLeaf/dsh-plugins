# dsh-update-button

账号行最右端的「更新」按钮：一键把**全局安装的 DeepSeek Harness** 从旧版本换到新版本。
它和 `dsh-restart-button` 并排 —— 重启按钮在左，更新按钮在右。

```
侧栏底部： [头像 账号]                      [重启] [更新]
```

## 定时检查（不是只靠页面轮询）

宿主侧有一个**常驻检查器**，插件挂载 8 秒后跑第一次，之后每 15 分钟一次：

* 一次 `npm view @deepseek-ai/dsh dist-tags --json` 拿到所有轨道（`latest` / `next` / `alpha`）；
* 在 `channel`（默认 `next`）和 `latest` 两个轨道里挑**最高**的那个 —— 稳定版刚发、
  `next` 落后时也能跟上；
* **只在严格新于当前版本时才算「有更新」**，绝不下推旧版本（`latest` 标签曾长期停在
  `0.2.2-rc.1`，比已装的 rc.3 还旧）；
* 结论写到 `$DSH_HOME/state/update-check.json`，重启后第一屏就有；失败按指数退避
  （15 分钟 → 30 → 60 封顶），不会拿 npm 源抖动当没事；
* 页面只负责读这份结论（45 秒一次，便宜），发现新版本时按钮长小圆点；
  点按钮打开弹窗，能看到当前版本 → 最新版本与更新说明。

## 点下「更新」之后

点击按钮先打开更新弹窗：有新版本时显示当前/最新版本对比与确认按钮；已是最新时
直接告诉用户；更新进行中则显示阶段进度。确认后宿主把更新脚本塞进
`systemd-run --user --collect` 拉起的**瞬态单元**里执行。脚本的顺序是**先暂存、后停机**：

1. 确认当前版本、解析目标版本；不更新/降级直接退出（不动服务）
2. `npm i -g … --prefix <暂存目录>` 把新版本装到一个独立前缀 —— **这一步服务照常运行**
3. 回读暂存区里的 `bin.js --version` 和版本号比对（npm 退出码 0 不等于装上了）
4. `systemctl --user stop dsh-web`，等到真的 inactive
5. 原子切换：旧目录 `mv` 成备份，暂存目录 `mv` 进全局前缀（同盘秒级 rename）
6. 可选：`pnpm update` 更新 profile 里的第三方插件
7. `systemctl --user start dsh-web`，等到 active；对 `http://127.0.0.1:3080/` 做 HTTP 探测
8. 任何一步失败：把备份目录 `mv` 回去（不依赖网络），再把服务拉起来

停机窗口只有「停服务 → rename → 起服务」，下载和解包全在服务活着的时候完成。

整个过程写进 `$DSH_HOME/state/update-status.json` 和 `$DSH_HOME/logs/dsh-update.log`，
浏览器半边轮询状态文件，把进度写进**同一个弹窗**（不再用按钮旁边的提示条）；
失败时弹窗里有「查看日志」和「重试」。

### 为什么要在服务外面跑

在 dsh-web 进程里直接 `npm i -g` 会死在第一步：`systemctl stop dsh-web` 把发命令的
自己一起杀了，更新断在半新半旧的状态。所以宿主只做两件事 —— 校验请求、把脚本
扔进瞬态单元（`systemd-run --unit=dsh-update-<pid>-<ts>`），脚本自己在服务的 cgroup
之外跑完。这也是官方桌面端 updater 的做法。

### 为什么不会把用户丢在坏状态里

* 旧版本号在动手前就记下来了，回滚不依赖任何外部信息
* 脚本用 `flock` 单实例，按钮另有 10 秒冷却与「进行中」判定，连点不会并发装包
* 起服务后做 HTTP 探测；systemd 说 active 不代表能打开页面
* 浏览器半边在服务离线期间显示「服务重启中」，而不是报错；回来后等进程换 pid 再刷新
* 进度与结果都写在更新弹窗里：不会被账号菜单或按钮挡住；弹窗用原生
  `dialog.showModal()`，在 top layer 里
* 失败不谎报成功：状态文件里 `phase: failed` + `error` 字段就是真话

## 手工用法

脚本也可以直接在终端跑，和按钮走的是同一条路径：

```bash
bash scripts/dsh-update.sh --check          # 只查版本，输出一行 JSON
bash scripts/dsh-update.sh --dry-run        # 打印计划，不动服务不装包
bash scripts/dsh-update.sh                  # 完整更新（--tag next --service dsh-web）
bash scripts/dsh-update.sh --tag 0.2.2-rc.3 # 固定版本
bash scripts/dsh-update.sh --with-plugins --profile ~/.dsh/profiles/web
bash scripts/dsh-update.sh --service ''     # 只换包，不碰服务
```

注意：**别在 dsh-web 服务进程里跑它**（例如从 DSH 的 bash 工具里跑完整更新），
停服务会把你这个进程一起停掉。手工跑请在自己终端里，或者像按钮那样包一层：

```bash
systemd-run --user --collect --unit=dsh-update-manual \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" --setenv=DSH_HOME="$HOME/.dsh" \
  /bin/bash "$PWD/scripts/dsh-update.sh"
```

## 宿主配置（profile patch 行的 `config`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `service` | `dsh-web` | 要停/起的 systemd 用户单元名；空串 = 不碰服务 |
| `tag` | `next` | npm dist-tag 或精确版本。**不要用 `latest`**：它可能落后于 `next` |
| `port` | `3080` | 健康探测端口 |
| `scriptPath` | 包内 `scripts/dsh-update.sh` | 覆盖脚本位置 |
| `statusFile` / `logFile` | `$DSH_HOME/state|logs/…` | 覆盖状态/日志路径 |
| `profileDir` | 空 | `--with-plugins` 时进入哪个 profile 目录跑 `pnpm update` |
| `withPlugins` | `false` | 按钮默认是否连带更新插件 |
| `channel` | `next` | 主轨道；候选在它和 `latest` 里取最高 |
| `checkIntervalMs` | `900000` | 后台检查间隔（15 分钟） |
| `checkFile` | `$DSH_HOME/state/update-check.json` | 检查结论落盘位置 |

路由（都经过宿主 `connection` 的鉴权，和重启按钮同一条通道）：

* `GET /api/update-button/status` — 运行中 pid、当前版本、状态文件内容
* `GET /api/update-button/check` — 有没有新版本（`?force=1` 绕缓存）
* `POST /api/update-button/start` — `{ tag?, withPlugins? }`，先回 202 再动手
* `GET /api/update-button/log?tail=160` — 日志尾部

## 测试

```bash
node --test test/*.test.mjs
```

覆盖宿主纯函数（配置归一、systemd-run 参数、状态时效、日志尾部）、脚本语法与
`--check` 的输出格式、客户端注册契约，以及 jsdom 下的按钮/弹窗 DOM 行为：点击打开
弹窗、确认后才 POST、进度写在弹窗里、账号菜单不抢点击、失败给日志与重试、卸载清理。

## 已知边界

* 依赖 `systemd --user` 与 `systemctl`/`systemd-run`；没有 systemd 时脚本退化成
  「只换包不碰服务」，然后由提示条让你手动重启
* 只认 semver；npm 上出现无法解析的版本号时宁可不提示，也不瞎升级
* 一份安装约 1.2G：暂存目录在切换后立刻删掉，备份只留最近一份（同一个盘上 rename，回滚不联网）
* 依赖 npm 全局前缀可写（本机 `~/.vfox/.../node_modules` 可写）
* 只更新**全局 npm 安装**，不更新桌面版内嵌的那份 dsh
* `--with-plugins` 用 `pnpm update`（尊重 semver 范围），不会跨大版本乱跳
