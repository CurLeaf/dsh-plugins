# dsh-command-rea

A tiny DeepSeek Harness host plugin that registers `/rea` in the Web/TUI command
menu.

```
/rea 分析 /opt/app/resources/app.asar
```

The command injects one ordinary user message — the same way the built-in
commands do, through `createUserMessage()` semantics and `agent.followup()` —
asking the agent to load the `reverse-engineer-anything` skill and run the
request with the REA MCP tools:

```
请加载 reverse-engineer-anything 技能，并按它的流程用 REA 完成下面的任务。

任务：分析 /opt/app/resources/app.asar
```

Composer attachments (`input.attachments`) are admitted and published ahead of
that text, so a binary, an archive, or a screenshot can be handed to REA
directly. The command result is rendered outside model history, like other slash
commands.

### Why the plugin imports nothing from `@deepseek-ai/*`

A `link:` install is evaluated from its checkout, outside the profile directory,
and the launcher only routes bare `@deepseek-ai/*` specifiers for importers
inside the profile (or the installation). Importing `createUserMessage` from
`@deepseek-ai/dsh-llm` therefore fails at boot with `ERR_MODULE_NOT_FOUND` when
the package is linked, which takes the whole `/rea` row down:

```
command-rea (dsh-command-rea): failed to import: Cannot find package '@deepseek-ai/dsh-commands'
```

The plugin therefore mirrors the two framework values it needs — an equivalent
`createUserMessage()` (fresh identity, `user` role, user source, deep-frozen) and
the identity string of `CommandDefinitionId` — and imports only `node:crypto`.
That keeps checkout and registry installs loading identically.


## Command surface

| Field | Value |
|---|---|
| name | `rea` |
| definitionId | `dsh-command-rea` |
| title | 逆向分析 |
| icon | `IconInspectOutlineRegular` |
| description | 用 REA 逆向分析目标 |
| input hint | `<目标路径或问题>` |
| attachments | accepted |

`title` and `icon` are the command's own menu face: the Web client renders them
as the row title and glyph, so `/rea` sits beside first-party rows instead of
showing a bare `rea`. `icon` is an export name of
`@deepseek-ai/dsh-client-ui-primitives`; an unknown name falls back to the
generic plugin glyph. A definition that supplies neither still gets a row whose
title is its description.

Both fields need a Host that forwards them: `commands/list` must keep `title`
and `icon` on the descriptor, and the client must render them. `@deepseek-ai/dsh`
0.2.1-rc.3 does neither — that is what the patch this package carries does (see
[The bundled patch](#the-bundled-patch) below). On a Host release without that
plumbing the fields are ignored and the row keeps the description-as-title
fallback written above.


## The / menu face

`/rea` 的标题「逆向分析」、图标 `IconInspectOutlineRegular` 和说明「用 REA 逆向分析目标」
由**客户端半边**（`lib/client.js`）提供，不依赖下面的补丁：

- 客户端模块在运行时包一层 `commandUi.candidates`，只改 `rea` 那一行，补 `label` / `description` / `icon`
- 已带面孔的行原样放行，官方将来支持 `title`/`icon` 后自动让位
- 取不到图标模块或 `commandUi` 时只降级成"少图标/少标题"，不影响命令执行，也不弄坏「/」菜单

宿主侧 `register()` 里的 `title` / `icon` 仍然保留：它们现在是前向兼容字段，
在支持这两列 Host 上会优先于客户端补丁。

## The bundled patch

`@deepseek-ai/dsh` 0.2.1-rc.3 only gives a menu face to six first-party
`definitionId`s, and its composer `+` button re-opens the command menu instead
of closing it. This package ships the fix as data plus a small CLI, so no
separate repository or hand-made patch directory is needed:

```
dsh-patch/
  manifest.json   # one row per target: package, path, pre/patched SHA-256, marker, diff
  pre/            # pristine upstream files (basis for --restore and for verification)
  patched/        # the patched images that get written
  diffs/          # the same changes as unified diffs, for review
```

What it changes:

| Target | Change |
|---|---|
| `dsh-commands/lib/index.js` | `register()` accepts and validates optional `title` / `icon`; the descriptor carries them. |
| `dsh-commands/lib/typert.host.js`, `…/typert.remote-client.js` | the `commands/list` result schema keeps `title` / `icon` on both wire ends (zod strips unknown keys otherwise). |
| `dsh-commands/lib/types/*.d.ts` | `CommandDefinition` / `CommandDescriptor` document the two fields. |
| `dsh-client-ui-commands/lib/client.js` | `declaredRowFace()`: a definition's `title`/`icon` win, otherwise its description becomes the row title with a generic plugin glyph. |
| `dsh-client-ui-input-trigger/lib/client.js` | `track()` keeps the launch mark when an update carries no trigger, so a second press on `+` closes the menu. |

First-party rows are untouched: they still resolve by `definitionId`, so their
localized copy and glyphs do not move.

### Running it

```bash
# installed from the registry: the postinstall hook already ran it
# linked checkout (npm/pnpm do not run lifecycle scripts for link: deps):
node ~/WorkSpace/dsh-command-rea/bin/dsh-command-rea-patch.js

# or, once the profile has the bin link:
~/.dsh/profiles/web/node_modules/.bin/dsh-command-rea-patch --check
```

| Command | Effect |
|---|---|
| `dsh-command-rea-patch` | apply; already-patched files are skipped |
| `--check` | report only, write nothing |
| `--restore` | put the pristine upstream files back |
| `--dry-run` | print what apply/restore would write |
| `--root <dir>` | target a specific `@deepseek-ai/dsh` package directory (else `$DSH_ROOT`, else the `dsh` on `PATH`) |
| `--force` | overwrite targets that match neither image (otherwise the run aborts before writing anything) |

Exit codes: `0` applied / already patched, `1` a target is unknown so nothing was
written, `2` resolution or usage error. The `postinstall` hook runs the same CLI
in a quiet never-failing mode and can be disabled with
`DSH_COMMAND_REA_PATCH=0`.

The patch is pinned to one DSH release. Every target is verified against the
recorded pre-image SHA-256 before it is replaced, so a `dsh` upgrade makes the
CLI report a conflict instead of corrupting the install. Moving the patch to
another release means refreshing `pre/`, `patched/` and `manifest.json` from
that version.

A restart is needed because the host half runs in the Node process:

```bash
systemctl --user restart dsh-web.service
```

Client bundles are re-read from disk on every page load, so the client half
lands on a plain refresh. `dsh-patch/pre/` and `dsh-patch/patched/` are modified
copies of MIT-licensed `@deepseek-ai/dsh` build artifacts; see
[`dsh-patch/NOTICE.md`](dsh-patch/NOTICE.md).


## Install

```bash
# from the registry
dsh plugin --profile web add dsh-command-rea

# or from a local checkout, while developing
dsh plugin --profile web add link:/path/to/dsh-command-rea
```

The package ships its own bundle patch (`dsh.bundle.patch`), so the row mounts
through `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`. Nothing has
to be added to `cordis.patch.yml`; an older manual `command-rea` row must be
removed first, otherwise the same id would be inserted twice.

A registry install runs `postinstall`, which applies the bundled patch when it
can resolve the DSH installation. A `link:` install does not run lifecycle
scripts, so run the CLI once by hand (above) after installing or after a `dsh`
upgrade.

The web profile's HMR watches profile configuration only, not linked module
roots, so a code change in a linked checkout needs one restart of the web
service:

```bash
systemctl --user restart dsh-web.service
```

## Requirement

The command only formats the prompt. Running the actual analysis needs the
`reverse-engineer-anything` skill and the REA MCP server in the same profile.
