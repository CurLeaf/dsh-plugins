# dsh-lazy-mcp

把 MCP 工具组从「每次请求都常驻」改成「一个入口工具 + 首次调用后挂载」。

## 为什么

MCP 的 schema 是常驻成本：rea 一家就是 229 个工具 / 275KB，而 30 天里它只在几十个会话用得上。
本插件让 DSH 常驻一个 `load_tool_group` 工具（约 0.5KB）+ 一段几十 token 的说明，
被激活的组用 `ctx.plugin()` 在运行期挂载 `@deepseek-ai/dsh-mcp-client`，
工具注册后由 DSH 在下一次请求里以 `tool-addition` 告知模型，空闲后自动卸下。

## 用法

在 profile 的 `cordis.patch.yml` 里插入一行（不要放进 bundles，它需要带配置）：

```yaml
- insert:
    - id: lazy-mcp
      name: dsh-lazy-mcp
      config:
        idleMinutes: 30          # 默认空闲回收，0 = 不回收
        groups:
          - id: rea
            title: rea 逆向分析
            hint: 二进制/固件/JS bundle 逆向，229 个工具；首次加载约 2–8 秒
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
```

`plugin` 默认 `@deepseek-ai/dsh-mcp-client`；`prefix` 默认 `mcp__<serverName>__`。

## 解析依赖的方式

本包用 `link:` 装进 profile，Node 按真实路径向上找不到 `@deepseek-ai/dsh-*`，
所以从宿主的 `process.argv[1]`（`.../@deepseek-ai/dsh/lib/bin.js`）向上逐层 `createRequire` 解析。
解析不到时给 `config.moduleBase` 传 `@deepseek-ai/dsh` 的安装目录即可。

## 已知边界

- 注册是**进程级全局**的：一个会话激活后，同进程的所有会话都会看到这些工具；卸载同理。
- 激活后要等一个 step 工具才可见（header 在下一个请求重算），这是 DSH 的既有机制。
- 服务端起不来时 `load_tool_group` 会在 `loadTimeoutMs` 后返回错误并卸载。

## 部署与验证

- 生效时机：loader 只在启动时读 `cordis.patch.yml`，改完要重启宿主（`systemctl --user restart dsh-web` 或右侧栏重启按钮）。
- 冒烟测试：`node test/smoke.mjs`（在真实 cordis Context + ToolsService 上验证挂载/激活/卸载，无需 DSH 宿主）。
- 量实际请求：`node ~/WorkSpace/dsh-plugins/scripts/verify-lazy-tools.mjs`，读 `~/.dsh/sessions/*/session.v4.jsonl.zstd` 里的 `request/header`，
  支持 `--expect cold|browser|rea` 直接判定。
- 注意 DSH 的插件热重载：文件级重载可能复用启动时缓存的模块，导致 ego 补丁短暂回退；以一次干净重启后的状态为准。
