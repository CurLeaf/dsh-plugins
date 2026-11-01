# dsh-cursor-bridge

把项目里的 Cursor 资产接进 DeepSeek Harness 的 skill 目录，于是编辑器输入框里打 `/` 就能直接调用。

```
.cursor/skills/<name>/SKILL.md   →  项目 skill（模型可调用 + 用户可调用）
.cursor/commands/<id>.md         →  项目命令（`/id`，默认也允许模型自己调）
.claude/skills/**、.claude/commands/** 同样扫描
```

## 为什么命令也走 skill 通道

命令正文里常常互相引用（`/platform-integration` 正文写着「按 `/platform-prepare` 执行」）。只有把命令注册成 **modelInvocable 的 skill**，模型才能自己把子命令加载进来，这套「总控 → 阶段 → 验收」的链路才成立。

不想让 15 条命令占系统提示词预算，就把 `commandModelInvocable` 关掉：commands 仍出现在 `/` 菜单，但只面向用户，不产生任何常驻 token。

## 安装

```bash
# 1. 链接进 profile（等价于手写 node_modules 软链 + package.json 两条记录）
dsh plugin --profile desktop install --offline

# 2. 在 profile 的 package.json 里登记
#    "dependencies": { "dsh-cursor-bridge": "link:~/WorkSpace/dsh-plugins/packages/dsh-cursor-bridge" }
#    "dsh": { "profile": { "bundles": [ ..., "dsh-cursor-bridge" ] } }

# 3. 重启应用（cordis 不监听配置文件，插件在 boot 时装载）
```

`cordis.patch.yml` 只负责把它挂上去：

```yaml
- insert:
    - id: cursor-bridge
      name: dsh-cursor-bridge
```

## 配置

默认值即可用；需要时在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: cursor-bridge
  name: dsh-cursor-bridge
  config:
    commandModelInvocable: false   # 命令只对用户可见，不进模型目录
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `skillRoots` | `['.cursor/skills', '.claude/skills']` | 相对项目根扫描的 skill 根目录 |
| `commandRoots` | `['.cursor/commands', '.claude/commands']` | 相对项目根扫描的命令目录 |
| `rank` | `250` | 优先级：低于 `.dsh/skills`(100)、`.agents/skills`(200)，高于 `customSkillDirs`(300) |
| `commandRankOffset` | `10` | 命令相对 skill 的降级量，保证同名时 skill 胜出 |
| `commandModelInvocable` | `true` | 命令是否进入模型目录（可被模型链式调用） |
| `watch` | `true` | 是否监视目录变化并自动失效缓存 |
| `watchPollIntervalMs` | `2000` | 根目录尚不存在时的探测间隔 |
| `watchMaxRoots` | `64` | 同时打开的 watcher 上限 |

项目根 = 最近的含 `.git` 的祖先目录；没有则用会话工作目录。

## 解析规则

- **skill**：frontmatter 必须有 `name`（kebab-case）或可退化为目录名，`description` 缺失时取正文首条有效行
- **command**：`name` 优先 `id`（Cursor 常写 `name: /platform-integration`，前导斜杠会被去掉），再退化到文件名；`description` 取 frontmatter
- frontmatter 只解析顶层标量 + `|` / `>` 块；未知结构按字符串保留，解析不了的文件跳过且不影响其他条目
- 非法名字（非 kebab-case）直接跳过，不猜

## 验证

```bash
npm test                        # 9 项 provider + 2 项 watcher 断言
npm run verify:profile          # profile 接线（依赖/软链/可解析）
npm run test:registry           # 真实 @deepseek-ai/dsh-skill 注册表集成
```

真实宿主验收（用自带运行时把一个临时 profile 启动起来，看宿主侧目录）：

```bash
dsh --profile <profile> --patch examples/debug-overlay.yml --port 46013 --no-open
# 日志出现：[cursor-bridge] debug: 19 entries from <repo>: ...
```

`harness.mjs` 会把 `@deepseek-ai/dsh-skill` 注册表和本插件挂进同一个 Cordis 上下文，断言 `/` 菜单实际拿到的候选、正文加载、以及失效后能发现新增文件。

## 已知限制

- 只做**项目级**：`~/.cursor` 用户级资产不扫描（可后续加用户根）
- 命令的参数靠尾随文本传递，不做 `$ARGUMENTS` 模板替换（Cursor 的命令正文里本来也没有占位符）
- `.cursor/rules/*.mdc` 未接入：DSH 没有按 glob 条件注入的等价物，`alwaysApply: true` 的规则建议直接写进 `AGENTS.md`
- 依赖 MCP 的命令（例如 chrome-devtools）需要先在 MCP 连接器里导入 `.cursor/mcp.json`，否则命令里的「查证」步骤会退化。`erp-admin-demo-1` 可直接导入 `examples/erp-admin-demo-1.mcp.json`（已把 `${workspaceFolder}` 展开成绝对路径）
