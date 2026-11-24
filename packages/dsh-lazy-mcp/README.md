# dsh-lazy-mcp

把 MCP 工具组从「每次请求都常驻」改成「一个入口工具 + 首次调用后挂载」。
v2 起还负责两件事：**按会话隔离**（agent 作用域）和**按池子分配窗口**（`pool`）。

## 为什么

MCP 的 schema 是常驻成本：rea 一家就是 229 个工具 / 275KB，而 30 天里它只在几十个会话用得上。
本插件让 DSH 常驻一个 `load_tool_group` 工具（约 0.6KB）+ 一段几十 token 的说明，
被激活的组用 `ctx.plugin()` 在运行期挂载，工具注册后由 DSH 在下一次请求里告知模型。

## 两种作用域

| `scope` | 挂在哪里 | 谁能看见 | 适用 |
|---|---|---|---|
| `global`（默认） | 插件自己的 ctx | 所有会话 | rea 这种无状态、共享一套资源的服务器 |
| `agent` | `exec.agent.ctx`（发起调用的会话） | 只有该会话 | 浏览器这种「每个会话一个实例」的服务器 |

DSH 的工具注册与可见性本来就按 scope 走；`dsh-mcp-client` 的 `serverName` 预留也是按 registration scope
隔离的（源码注释：Agent-scoped MCP servers may reuse a namespace in another Agent），所以两个会话可以
各自挂一个同名 `browser` 组，互不冲突。

## 用法

在 profile 的 `cordis.patch.yml` 里插入（不要放进 bundles，它需要带配置）：

```yaml
- insert:
    - id: lazy-mcp
      name: dsh-lazy-mcp
      config:
        groups:
          - id: rea
            title: rea 逆向分析
            hint: 二进制/固件/JS bundle 逆向，229 个工具
            plugin: "@deepseek-ai/dsh-mcp-client"
            prefix: "mcp__rea__"
            idleMinutes: 30
            loadTimeoutMs: 25000
            config:
              serverName: rea
              transport: stdio
              failOnStartupError: false
              command: /path/to/rea
              args: [mcp]

          # 带池子的浏览器组：挂载前先 acquire，卸载时 release
          - id: browser
            title: 浏览器（自动分配窗口）
            hint: 真实 Chrome，截图/点击/填表/抓网络
            plugin: "@deepseek-ai/dsh-mcp-client"
            prefix: "mcp__browser__"
            scope: agent
            idleMinutes: 120
            loadTimeoutMs: 30000
            pool:
              command: /home/yxw/.local/bin/dsh-browser-pool
              note: "dsh-lazy-mcp"
              ttlSeconds: 7200          # 可选，透传给 acquire --ttl
            config:
              serverName: browser
              transport: stdio
              command: /path/to/node
              args: [/path/to/browser-guard-mcp.mjs, --profile, "{profile}"]
```

`plugin` 默认 `@deepseek-ai/dsh-mcp-client`；`prefix` 默认 `mcp__<serverName>__`。

### 池子协议

`pool.command` 指向一个 CLI，插件按子命令调用它，并要求 JSON 输出：

| 子命令 | 期望输出 |
|---|---|
| `acquire --json --owner agent:<sessionId> [--note ...] [--ttl ...]` | `{ ok, slot, profile, owner }`；失败时 `{ ok:false, error, leases }` 且退出码非 0 |
| `release <slot> --json` | `{ ok, slot }` |
| `touch <slot> --json` | `{ ok }`（长时间任务续租，默认每 30 分钟一次） |
| `status --json` | `{ slots: [{ slot, leased, owner, ... }] }`（每轮对账用） |

配置里的 `{profile}` / `{slot}` / `{group}` / `{serverName}` 会在挂载前替换。

### 工具参数

```
load_tool_group group=browser                  # 领窗口 + 挂载
load_tool_group group=browser status=true      # 看本会话已激活的组
load_tool_group group=browser unload=true      # 卸下 + 归还
load_tool_group group=browser alias=b          # 同会话第二个窗口（mcp__browser-b__*）
```

## 生命周期

- **空闲**：按 `tools/execute` 里的真实调用计时（不是按加载时间）；`idleMinutes` 到点卸载并 release。
- **租约对账**：每分钟一次 `status --json`，发现自己的 slot 被回收（例如窗口被手动关掉）就自动卸下。
- **失败回滚**：挂载后 `loadTimeoutMs` 内没有工具注册 → dispose + release，不留挂着的空组。
- **会话销毁**：agent 的 ctx 会 dispose 挂在上面的 MCP 客户端；留下的租约由 TTL/gc 兜底。
- **插件卸载**：进程退出时尽量把手里所有租约还掉。

## 解析依赖的方式

本包用 `link:` 装进 profile，Node 按真实路径向上找不到 `@deepseek-ai/dsh-*`，
所以从宿主的 `process.argv[1]`（`.../@deepseek-ai/dsh/lib/bin.js`）向上逐层 `createRequire` 解析。
解析不到时给 `config.moduleBase` 传 `@deepseek-ai/dsh` 的安装目录即可。

## 已知边界

- 全局组的注册仍是进程级的：一个会话激活后所有会话都能看到。要按会话隔离就设 `scope: agent`。
- 激活后要等一个 step 工具才可见（header 在下一个请求重算），这是 DSH 的既有机制。
- `scope: agent` 的组必须由带 agent 的调用激活（模型直接调用的工具都满足）。

## 部署与验证

- 生效时机：loader 只在启动时读 `cordis.patch.yml`，改完要重启宿主（`systemctl --user restart dsh-web` 或右侧栏重启按钮）。
- 冒烟测试：`node test/smoke.mjs`（在真实 cordis Context + ToolsService 上验证全局组、agent 组、
  池子 acquire/release、失败回滚，无需 DSH 宿主）。
- 量实际请求：`node ~/WorkSpace/dsh-plugins/scripts/verify-lazy-tools.mjs`。
