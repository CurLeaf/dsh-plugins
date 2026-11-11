# @qzsy/dsh-rewind

Cursor 式的「回退本轮文件改动」——**只回退文件，不动对话**。

会话 id、标题、输入队列、草稿、模型选择全部保留：它不是 fork 一个新会话再把旧的归档，而是在原会话里把文件写回去。

## 装

```bash
dsh plugin --profile desktop add link:~/WorkSpace/dsh-plugins/packages/dsh-rewind
```

装完**退出并重启** DeepSeek Harness（刷新页面不会重读 bundle 列表）。重启后每个已完成的轮次尾部会出现 `↩ 回退本轮 · N 个文件`。

## 语义

- 每个被 agent 改过的文件，**写之前**存一份原件（`fs/write-intent` / `fs/edit-intent` / `fs/delete-intent` 会等待捕获完成再落盘，因此没有竞态）。
- 「回退本轮」= 对这一轮涉及的文件，取它们**在本轮开始之前**的内容写回；本轮新建的文件删除。
- 回退前先出清单：哪些文件恢复、哪些删除、哪些**你之后手动改过**（冲突，默认跳过，绝不覆盖你的改动）。
- 回退本身也会记一条，所以能「撤销这次回退」。

## 粒度

`granularity: "turn"`（默认）：一轮里同一文件改十次只存**第一次改前**那一份，回退以轮为单位。

`granularity: "edit"`：每次工具调用都留一份，支持轮内单次撤销，代价是存储随编辑次数线性增长。

## 不覆盖什么

| 盲区 | 说明 |
|---|---|
| `bash` 产生的改动 | shell 里的 `sed -i`、构建产物不走文件工具，捕获不到 |
| 锁文件 / 图片 / 压缩包 | `metadataOnlyPatterns` 里只记元数据，**不可还原**（UI 会标出来） |
| `.env` / `*.pem` 等 | `excludePatterns` 里直接不captured——存密钥等于把密钥抄一份到磁盘 |
| 工作区外的绝对路径 | 默认拒绝（`allowOutsideWorkspace: false`） |

## 存储

```
~/.dsh/storages/dsh-rewind/
  blobs/<aa>/<rest>             内容寻址，跨会话去重
  sessions/<id>/turns/<n>.ndjson 每轮一条只追加的记录文件
  sessions/<id>/reverts/<id>.json 回退日志（可撤销）
  sessions/<id>/pending/…        未结算的捕获
  sessions/<id>/meta.json
```

体积与被改文件成正比，与仓库大小无关。按默认配置：常规会话约 400KB，一天约 1.5MB。

## 配置

`~/.dsh/storages/dsh-rewind/config.json`（可缺省）：

```json
{
  "enabled": true,
  "granularity": "turn",
  "maxFileBytes": 2097152,
  "maxTurnsPerSession": 500,
  "maxEditsPerSession": 2000,
  "globalBudgetBytes": 4294967296,
  "retentionDays": 180,
  "gcGraceMs": 86400000,
  "excludePaths": [".git", "node_modules", "dist", "build", ".next", ".venv", "__pycache__"],
  "excludePatterns": [".env", ".env.*", "*.pem", "*.key", "id_*"],
  "metadataOnlyPatterns": ["*.lock", "package-lock.json", "pnpm-lock.yaml", "*.min.js", "*.map", "*.png", "*.zip"]
}
```

## 设计取舍

- **不做整库基线**：只存被改文件的改前内容，开一个会话不花任何空间。
- **不改会话日志**：第三方插件不允许写插件记录，而且回退文件本来就与对话无关。
- **保底维护**：挂载一分钟后与每六小时各跑一次「回收孤儿 blob + 按轮数/编辑数裁剪 + 全局预算淘汰」。
- **捕获失败不阻塞写入**：任何存储故障只记一条 warn，工具照常执行——回滚是附加价值，不能变成新的故障点。
- **子代理**：子代理的写入归到根会话的当前轮，回退不会留下半截改动。

## 测试

```bash
pnpm --filter @qzsy/dsh-rewind test
```

`test/engine.test.mjs` 用临时目录驱动真实的捕获/结算/回退/撤销，覆盖创建、删除、修改、冲突跳过、强制覆盖、轮内多次编辑、GC。
