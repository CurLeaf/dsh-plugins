# @qzsy/dsh-artifact-index

会话里的图片**生成即落盘**，但落在内容寻址的 `~/.dsh/attachments/v1/objects/<2>/<sha256>`：没有扩展名、没有原名、也没有「这次改页面到底用了哪几张图」的线索。这个插件把每一回合新增的图片**硬链接**成项目里可浏览的视图，并给出一条 `/artifacts` 命令来查看和清退。

```
<项目>/.dsh/artifacts/
├── .gitignore                      # 内容是一行 `*`，视图整体不入库
├── index.json                      # 会话 → 产物（seq、附件 id、体积、链接方式、状态）
└── 2026-11-13/
    ├── f2a86021-0123-home-banner.jpg
    └── f2a86021-0150-mall-home.png
```

对象库仍是唯一真相：视图是硬链接（同 inode，零额外空间），删视图不影响会话重放，删对象才会真的丢图。

## 它做什么

| 时机 | 行为 |
|---|---|
| 每个 `turn/end` | 取这一回合新增的图片 → 硬链接进 `<项目>/.dsh/artifacts/<日期>/` → 更新 `index.json` |
| 记录数量或体积过阈值 | 往下一轮注入一行上下文，让模型在最终答复末尾提醒「可以 `/artifacts clear`」；每会话最多提醒 `maxTimes` 次 |
| `/artifacts` | 本会话产物明细（最近 8 条 + 合计） |
| `/artifacts backfill` | 把本会话**历史**图片补进视图（装插件之前产生的也算） |
| `/artifacts clear` | 把本会话产物标为 `cleared`（只改状态，不删文件、不影响重放） |
| `/artifacts gc` | 空跑：扫全部会话日志，报告哪些对象已无人引用 |
| `/artifacts gc --yes` | 真删：只删「没被任何会话引用 + 超过保护期」的对象 |

链接策略依次退化：**硬链接** → 符号链接（跨设备）→ 复制（文件系统不支持链接）。`index.json` 里每条记录都带 `link` 字段说明实际用了哪一种。

## 为什么 gc 不能按会话删

附件库是内容寻址、**跨会话共享**的：同一张图可能被多个会话引用。唯一安全的判据是「扫一遍全部会话日志（`session.v4.jsonl.zstd`），这个 sha256 一次都没出现过」。所以 `gc` 会解压全部会话日志——483 个会话、469 MiB 压缩日志大约 30–90 秒，属于手动操作，不常驻。

`gc` 只处理图片对象库；`file-objects/`（上传的文件）不动。

### 多帧日志：必须用 zstd CLI 解

DSH 的会话日志是**追加写入的多帧 zstd**。Node 自带的 `zlib.zstdDecompress` 只解第一帧——用它扫引用会得到「0 引用」的假象，进而把仍在用的附件整批当孤儿删掉（历史上真的发生过）。

所以 `scanSessionReferences()` 的顺序是：

1. 优先 `zstd -dc <file>` 流式解压（能覆盖全部帧，493 个会话约 8 秒）；
2. CLI 不可用时回退 Node zstd，但会数帧魔数，多帧就标 `lossy`；
3. `gc --yes` 前过 `gcSafetyBlockReason()`：`failed > 0` / `lossy > 0` / 「扫到日志却 0 命中」一律拒绝删除，只有显式 `--force` 才放行。

本地改完源码同步进 profile：`pnpm sync:profile`（默认 `~/.dsh/profiles/web`，可用 `DSH_PROFILE_DIR` 覆盖），重启 DSH 生效。

不想等重启，可以走终端 CLI（直接跑本包源码，改完即生效）：

```sh
pnpm gc                      # 空跑：扫日志 → 算孤儿 → 出报告
pnpm gc --yes                # 真删（默认 3 天保护期）
pnpm gc --yes --min-age-days=7   # 换保护期
```

## 配置

在 profile 的 patch 层覆盖这一行的 `config` 即可（缺省值如下）：

```yaml
- id: artifact-index
  name: '@qzsy/dsh-artifact-index'
  config:
    enabled: true
    viewDir: .dsh/artifacts      # 相对会话 cwd；也可以写绝对路径
    selfIgnore: true             # 在视图根写 .gitignore（内容 `*`）
    remind:
      enabled: true
      minImages: 10              # 张数阈值
      minBytes: 2097152          # 体积阈值（2 MiB）
      maxTimes: 2                # 每会话最多提醒几次
    gc:
      minAgeDays: 3              # 保护期：最近 N 天的对象不删，避免误伤刚生成的图
```

## 和「413」的关系

这个插件管**磁盘**，不管**请求体**。请求里内联多少图片由 provider 的 `maxInlineRequestImageBytes` 决定——网关 `client_max_body_size` 只有 6 MiB 时，把它调到 3 MiB，DSH 就会在超预算时把最老的图片换成「附件名 + 只读路径」的文本再重试，那条路径正好指向对象库，模型需要回看时用 `read_image` 打开即可。

两者配合才是完整方案：

- 请求体：`maxInlineRequestImageBytes` 卡预算，避免 413；
- 磁盘：本插件给视图、给清退入口；
- 对象库：DSH 自己从不自动删（上游现状），`/artifacts gc` 补上这一段。

## 安装

```bash
dsh plugin add @qzsy/dsh-artifact-index
```

或在 **插件** 面板里添加 `@qzsy/dsh-artifact-index`（需要重启 `dsh-web`）。

## 限制

- 只索引**图片**；上传的文件（`file-objects/`）不建视图。
- 提醒走 `agent.inject()`，落在**下一轮**的上下文里；本轮答复已结束后无法追加。
- `gc` 需要 Node 的 zstd 解压（≥ 22.15 / 23.8），更老的 Node 会明确拒绝而不是瞎删。
- 视图按会话 cwd 落盘：子代理会话与主会话同 cwd 时，各自在 `index.json` 里有一条记录。

## 开发

```bash
pnpm --filter @qzsy/dsh-artifact-index test
```

## License

MIT
