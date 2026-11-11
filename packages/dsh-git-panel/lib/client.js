/**
 * Browser half of `dsh-git-panel`.
 *
 * A Git section for the right Sidebar, modelled on the Git module of the local
 * Cursor IDE: the Source Control panel (`CHANGES`) plus the Source Control Graph
 * it ships below. Two tab types are registered here:
 *
 *   `git`      the panel itself — branch header, changes groups, commit box,
 *              the commit graph, and a commit description panel
 *   `git-diff` a diff preview page opened in a new tab — one file, all working
 *              tree changes, or one commit
 *
 * Everything that runs git lives in the Host half behind `POST /api/git-panel`;
 * this half only renders and calls it. Opening a file is the Sidebar's own
 * `openResource` (`dsh-resource://file/...`), so a changed file lands in the
 * same previewer any other file link uses.
 */
window.__ModuleLoader__.load({
	id: '@qzsy/dsh-git-panel',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const { useCallback, useEffect, useMemo, useRef, useState } = React

		/** Plugin context, kept so the panel can reach the conversation input. */
		let pluginCtx

		/** Copy namespace. */
		const NS = 'gitPanel'
		/** This package's tab-type identity (the registry `id`). */
		const PANEL_ID = 'dsh-git-panel'
		/** The diff page type; a different id so both types can coexist. */
		const DIFF_ID = 'dsh-git-panel/diff'
		/** Page kind of the panel. */
		const GIT_KIND = 'git'
		/** Page kind of the diff preview. */
		const DIFF_KIND = 'git-diff'
		/** Host route, relative so a forwarded deployment keeps working. */
		const ROUTE = 'api/git-panel'
		/** One `<style>` element per page. */
		const STYLE_ID = 'dsh-git-panel/styles'

		/** Short poll while the panel is visible: the work tree changes under it. */
		/** The status poll: fast enough that a branch switched in a terminal lands. */
		const POLL_MS = 4000
		/** Locale key per network verb, for the progress line under the graph header. */
		const NETWORK_LABELS = {
			fetch: 'status.fetching',
			pull: 'status.pulling',
			push: 'status.pushing',
			sync: 'status.syncing',
		}
		/** Lane geometry of the graph, in CSS pixels. */
		const LANE_WIDTH = 16
		const ROW_HEIGHT = 38
		const NODE_RADIUS = 4.8
		/** Left/right breathing room inside the lane canvas. */
		const GRAPH_PAD = 8
		/** Curve tension as a fraction of the segment: Git Graph uses 0.8 for its rounded style. */
		const CURVE_TENSION = 0.8
		/**
		 * Horizontal budget of one lane canvas, in CSS pixels. Without it the
		 * canvas is `18px × lanes` wide, which overflows a sidebar long before the
		 * 400-commit ceiling is reached (59 lanes = 1060px).
		 */
		const GRAPH_MAX_WIDTH = 260
		/**
		 * Lanes never get thinner than this. Squeezing 59 lanes into the 260px budget
		 * put the pitch at 4.2px, and a 0.2px pitch on a 1161-lane history is not a
		 * readable graph — below this floor the canvas grows and the pane scrolls.
		 */
		const LANE_MIN_WIDTH = 6
		/**
		 * Branch-line palette, taken from VS Code Git Graph's default
		 * `git-graph.graph.colours` (12 entries) so the graph reads the same way.
		 * Order matters: adjacent lanes differ most at the front of the list.
		 */
		const LANE_COLORS = [
			'#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000',
			'#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00',
		]

		/** True on a Mac, where the commit chord is ⌘ instead of Ctrl. */
		const IS_MAC = (() => {
			try {
				return /mac|iphone|ipad/i.test(String(navigator.platform || navigator.userAgent))
			} catch {
				return false
			}
		})()
		/** The visible chord label. */
		const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'

		/* ------------------------------------------------------------------ */
		/* Copy                                                               */
		/* ------------------------------------------------------------------ */

		const zh = {
			'type.label': 'Git',
			'guide.title': 'Git',
			'guide.description': '改动 · 提交 · 分支图',
			'diff.type.label': '改动预览',
			'diff.title': '改动',
			'diff.title.path': '{path} · 改动',
			'diff.mode.staged': '已暂存',
			'diff.mode.worktree': '未暂存',
			'diff.mode.untracked': '新文件',
			'diff.mode.commit': '提交',
			'diff.openFile': '打开文件',
			'diff.refresh': '刷新',
			'diff.empty': '这个范围没有可显示的改动',
			'diff.binary': '二进制文件，无法预览',
			'diff.crash': '这个改动页渲染失败：{message}',
			'diff.lines': '{count} 行',
			'diff.all': '全部改动',
			'diff.files': '{count} 个文件',
			'diff.commit': '提交 {hash}',
			'diff.collapseFile': '收起这个文件的改动',
			'diff.expandFile': '展开这个文件的改动',
			'error.title': '操作没有完成',
			'error.dismiss': '知道了',
			'empty.noSession': '这个面板需要一个打开的会话',
			'empty.noRepo': '当前会话的工作目录不在 Git 仓库里',
			'empty.clean': '工作区干净，没有待提交的改动',
			'empty.loading': '正在读取仓库…',
			'branch.detached': '游离 HEAD',
			'branch.ahead': '领先 {count}',
			'branch.behind': '落后 {count}',
			'branch.switch': '切换分支',
			'branch.current': '当前分支',
			'branch.local': '本地分支',
			'status.refresh': '刷新',
			'status.fetch': '抓取',
			'status.pull': '拉取',
			'status.push': '推送',
			'status.sync': '同步',
			'status.busy': '执行中…',
			'status.fetching': '正在抓取…',
			'status.pulling': '正在拉取…',
			'status.pushing': '正在推送…',
			'status.syncing': '正在同步…',
			'status.switching': '正在切换到 {name}…',
			'changes.title': '改动',
			'changes.staged': '暂存的改动',
			'changes.worktree': '改动',
			'changes.untracked': '未跟踪',
			'changes.conflicts': '合并改动',
			'changes.stageAll': '全部暂存',
			'changes.unstageAll': '全部取消暂存',
			'changes.discardAll': '全部丢弃',
			'changes.previewAll': '预览全部改动',
			'changes.collapse': '折叠',
			'changes.expand': '展开',
			'row.stage': '暂存这个文件',
			'row.unstage': '取消暂存',
			'row.discard': '丢弃改动',
			'row.openDiff': '在新标签里查看改动',
			'row.openImage': '在侧边栏预览图片',
			'row.openFile': '在新标签里打开文件',
			'row.delete': '删除这个未跟踪文件',
			'change.M': '已修改',
			'change.A': '新增文件（已暂存）',
			'change.U': '新增文件（未跟踪）',
			'change.D': '已删除',
			'change.R': '重命名',
			'change.C': '复制',
			'change.T': '类型变更',
			'change.conflict': '冲突（双方都改过）',
			'confirm.discardOne': '丢弃 {path} 的改动？这一步不能撤销。',
			'confirm.discardAll': '丢弃全部改动？{count} 个文件会回到 HEAD 的状态，未跟踪文件会被删除。这一步不能撤销。',
			'confirm.discard': '丢弃',
			'confirm.cancel': '取消',
			'discard.done': '已丢弃 {count} 个文件的改动',
			'commit.placeholder': '提交信息（{mod}+↵ 提交）',
			'commit.draft': '按当前改动生成提交信息草稿',
			'commit.draft.one': '更新 {name}',
			'commit.draft.many': '更新 {name} 等 {count} 个文件',
			'commit.button': '提交',
			'commit.sync': '提交并推送到远端',
			'commit.continue': '继续',
			'commit.conflictsLeft': '还有 {count} 个冲突没解决',
			'conflict.badge': '冲突 · 双方都修改',
			'conflict.quote': '引用到对话',
			'conflict.quoteHeader': 'Git 冲突：{path}（当前分支 {branch}）\n下面是一处冲突，请给出合并后的完整内容，并说明保留哪一边更合理。',
			'conflict.quoted': '已把冲突引用到对话输入框',
			'review.title': '智能审查',
			'review.find': '找问题',
			'review.empty': '没有可审查的改动',
			'review.quoted': '已把审查请求发到输入框',
			'review.copied': '已复制审查请求（输入框不可达）',
			'conflict.copied': '输入框不可用，冲突片段已复制到剪贴板',
			'commit.staged': '提交（已暂存）',
			'commit.all': '提交全部改动',
			'commit.amend': '修订上一次提交',
			'commit.noVerify': '跳过校验钩子提交',
			'commit.push': '提交后推送',
			'commit.hint': '没有暂存的改动，将提交全部改动',
			'commit.clean': '工作区没有改动',
			'commit.subjectTooLong': '标题 {count} 字符，建议不超过 50',
			'commit.empty': '提交信息不能为空',
			'commit.done': '已提交 {hash}',
			'commit.donePushed': '已提交并推送 {hash}',
			'graph.title': '分支图',
			'graph.resize': '拖动调整分支图高度',
			'graph.all': '全部引用',
			'graph.head': '当前分支',
			'graph.empty': '还没有提交',
			'graph.loading': '正在读取提交历史…',
			'graph.truncated': '只显示最近 {count} 条',
			'graph.openDiff': '查看这次提交的改动',
			'graph.copy': '复制 hash',
			'graph.copied': '已复制',
			'graph.checkout': '切换到这个分支',
			'graph.tag': '标签',
			'graph.remote': '远端',
			'graph.files': '{count} 个文件',
			'graph.detail': '提交说明',
			'graph.author': '作者',
			'graph.date': '时间',
			'graph.hash': '提交',
		}

		const en = {
			'type.label': 'Git',
			'guide.title': 'Git',
			'guide.description': 'Changes · commit · graph',
			'diff.type.label': 'Change preview',
			'diff.title': 'Changes',
			'diff.title.path': '{path} · changes',
			'diff.mode.staged': 'staged',
			'diff.mode.worktree': 'unstaged',
			'diff.mode.untracked': 'new file',
			'diff.mode.commit': 'commit',
			'diff.openFile': 'Open file',
			'diff.refresh': 'Refresh',
			'diff.empty': 'Nothing to show in this range',
			'diff.binary': 'Binary file, no preview',
			'diff.crash': 'This diff failed to render: {message}',
			'diff.lines': '{count} lines',
			'diff.all': 'All changes',
			'diff.files': '{count} files',
			'diff.commit': 'Commit {hash}',
			'diff.collapseFile': 'Collapse this file’s changes',
			'diff.expandFile': 'Expand this file’s changes',
			'error.title': 'The action did not finish',
			'error.dismiss': 'Dismiss',
			'empty.noSession': 'This panel needs an open session',
			'empty.noRepo': 'The session working directory is not a Git work tree',
			'empty.clean': 'The work tree is clean',
			'empty.loading': 'Reading the repository…',
			'branch.detached': 'detached HEAD',
			'branch.ahead': '{count} ahead',
			'branch.behind': '{count} behind',
			'branch.switch': 'Switch branch',
			'branch.current': 'Current branch',
			'branch.local': 'Local branches',
			'status.refresh': 'Refresh',
			'status.fetch': 'Fetch',
			'status.pull': 'Pull',
			'status.push': 'Push',
			'status.sync': 'Sync',
			'status.busy': 'Working…',
			'status.fetching': 'Fetching…',
			'status.pulling': 'Pulling…',
			'status.pushing': 'Pushing…',
			'status.syncing': 'Syncing…',
			'status.switching': 'Switching to {name}…',
			'changes.title': 'Changes',
			'changes.staged': 'Staged Changes',
			'changes.worktree': 'Changes',
			'changes.untracked': 'Untracked',
			'changes.conflicts': 'Merge changes',
			'changes.stageAll': 'Stage all',
			'changes.unstageAll': 'Unstage all',
			'changes.discardAll': 'Discard all',
			'changes.previewAll': 'Preview all changes',
			'changes.collapse': 'Collapse',
			'changes.expand': 'Expand',
			'row.stage': 'Stage this file',
			'row.unstage': 'Unstage',
			'row.discard': 'Discard changes',
			'row.openDiff': 'Open the diff in a new tab',
			'row.openImage': 'Preview the image in the sidebar',
			'row.openFile': 'Open the file in a new tab',
			'row.delete': 'Delete this untracked file',
			'change.M': 'Modified',
			'change.A': 'Added file (staged)',
			'change.U': 'New file (untracked)',
			'change.D': 'Deleted',
			'change.R': 'Renamed',
			'change.C': 'Copied',
			'change.T': 'Type changed',
			'change.conflict': 'Conflict',
			'confirm.discardOne': 'Discard the changes in {path}? This cannot be undone.',
			'confirm.discardAll': 'Discard every change? {count} files go back to HEAD and untracked files are deleted. This cannot be undone.',
			'confirm.discard': 'Discard',
			'confirm.cancel': 'Cancel',
			'discard.done': 'Discarded changes in {count} files',
			'commit.placeholder': 'Message ({mod}+↵ to commit)',
			'commit.draft': 'Draft a commit message from the changes',
			'commit.draft.one': 'Update {name}',
			'commit.draft.many': 'Update {name} and {count} more files',
			'commit.button': 'Commit',
			'commit.sync': 'Commit and push to the remote',
			'commit.continue': 'Continue',
			'commit.conflictsLeft': '{count} conflicts left to resolve',
			'conflict.badge': 'Conflict · both modified',
			'conflict.quote': 'Quote in chat',
			'conflict.quoteHeader': 'Git conflict in {path} (branch {branch}).\nBelow is one conflicted hunk; return the fully merged content and say which side to keep.',
			'conflict.quoted': 'Quoted into the chat input',
			'review.title': 'Agent review',
			'review.find': 'Find issues',
			'review.empty': 'Nothing to review',
			'review.quoted': 'Review request sent to the input',
			'review.copied': 'Review request copied (input unreachable)',
			'conflict.copied': 'Chat input unavailable — the hunk is on your clipboard',
			'commit.staged': 'Commit staged',
			'commit.all': 'Commit all changes',
			'commit.amend': 'Amend the last commit',
			'commit.noVerify': 'Commit without hooks',
			'commit.push': 'Commit, then push',
			'commit.hint': 'Nothing staged — this commits every change',
			'commit.clean': 'No changes in the working tree',
			'commit.subjectTooLong': 'Subject is {count} characters, 50 is the usual limit',
			'commit.empty': 'A commit message is required',
			'commit.done': 'Committed {hash}',
			'commit.donePushed': 'Committed and pushed {hash}',
			'graph.title': 'Graph',
			'graph.resize': 'Drag to resize the graph',
			'graph.all': 'All refs',
			'graph.head': 'Current branch',
			'graph.empty': 'No commits yet',
			'graph.loading': 'Reading history…',
			'graph.truncated': 'Showing the newest {count}',
			'graph.openDiff': 'See what this commit changed',
			'graph.copy': 'Copy hash',
			'graph.copied': 'Copied',
			'graph.checkout': 'Check out this branch',
			'graph.tag': 'tag',
			'graph.remote': 'remote',
			'graph.files': '{count} files',
			'graph.detail': 'Message',
			'graph.author': 'Author',
			'graph.date': 'Date',
			'graph.hash': 'Commit',
		}

		/* ------------------------------------------------------------------ */
		/* Styles                                                             */
		/* ------------------------------------------------------------------ */

		const CSS = `
/* ---------------------------------------------------------------------------
   A Git pane in the Apple surface language, laid out like the Source Control
   Graph: one header row per pane, a compact list, lane artwork on the left.

   Colour comes from the host app's semantic tokens, so the panel follows the
   app's light and dark themes; the value after each comma is the dark-theme
   fallback used when the panel renders outside the app shell.
   --------------------------------------------------------------------------- */
.gp-root{
  --gp-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --gp-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;

  --gp-bg:var(--dsw-alias-bg-base,#151517);
  --gp-surface:var(--dsw-alias-bg-layer-1,#1b1b1d);
  --gp-surface-2:var(--dsw-alias-bg-layer-2,#202023);
  --gp-surface-3:var(--dsw-alias-bg-layer-3,#26262a);
  --gp-label:var(--dsw-alias-label-primary,#f5f5f7);
  --gp-label-2:var(--dsw-alias-label-secondary,#c7c7cc);
  --gp-label-3:var(--dsw-alias-label-tertiary,#8e8e93);
  --gp-label-4:var(--dsw-alias-label-caption,#5f5f66);
  --gp-separator:var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  --gp-hairline:var(--dsw-alias-border-l1,rgba(255,255,255,.07));
  --gp-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));
  --gp-press:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12));

  --gp-green:var(--dsw-alias-state-success-primary,#30d158);
  --gp-red:var(--dsw-alias-state-error-primary,#ff453a);
  --gp-orange:#b26a00;
  --gp-purple:#8b3fd1;
  --gp-blue:#1f6feb;
  /* Source Control letter colours: VS Code's decoration palette, dark first
     and swapped for the light theme right below, because the host marks the
     dark theme on <body> while the light one is the unmarked default. */
  --gp-scm-modified:#e2c08d;
  --gp-scm-added:#81b88b;
  --gp-scm-untracked:#73c991;
  --gp-scm-deleted:#c74e39;
  --gp-scm-conflict:#e4676b;
  --gp-code-add:var(--dsw-alias-code-diff-added,rgba(48,209,88,.14));
  --gp-code-del:var(--dsw-alias-code-diff-deleted,rgba(255,69,58,.15));
  /* Layered like a VS Code diff editor: a faint line wash, a text run tint, and
     a stronger token wash for the characters that actually changed. */
  --gp-diff-add-line:color-mix(in srgb,var(--gp-green) 7%,transparent);
  --gp-diff-add-text:color-mix(in srgb,var(--gp-green) 10%,transparent);
  --gp-diff-add-word:color-mix(in srgb,var(--gp-green) 22%,transparent);
  --gp-diff-del-line:color-mix(in srgb,var(--gp-red) 7%,transparent);
  --gp-diff-del-text:color-mix(in srgb,var(--gp-red) 10%,transparent);
  --gp-diff-del-word:color-mix(in srgb,var(--gp-red) 22%,transparent);

  /* Syntax palette: VS Code Light+ values, swapped for Dark+ under the dark theme. */
  --gp-tok-comment:#6a737d;
  --gp-tok-string:#a31515;
  --gp-tok-keyword:#0000b3;
  --gp-tok-number:#098658;
  --gp-tok-func:#795e26;
  --gp-tok-type:#267f99;
  --gp-tok-key:#0b5cad;
  --gp-tok-tag:#800000;
  --gp-tok-attr:#b45309;
  --gp-tok-heading:#0b5cad;
  --gp-tok-code:#0a7a4a;

  --gp-file-code:#a87c1f;
  --gp-file-data:#7a5cc4;
  --gp-file-style:#1c7fa8;
  --gp-file-doc:#3f74a8;
  --gp-file-image:#9a55b8;
  --gp-file-media:#b8457d;
  --gp-file-font:#8a7420;
  --gp-file-archive:#6b7079;
  --gp-file-lock:#6b6c73;
  --gp-file-shell:#2f7d4a;

  --gp-accent:#2f6fb3;
  --gp-accent-hover:#255d97;
  --gp-accent-ink:#ffffff;
  --gp-accent-soft:rgba(47,111,179,.12);
  --gp-ring:0 0 0 3px rgba(47,111,179,.3);

  --gp-radius-s:6px;
  --gp-radius-m:9px;
  --gp-radius-l:12px;
  --gp-ease:cubic-bezier(.32,.72,0,1);

  display:flex;flex-direction:column;height:100%;min-height:0;position:relative;
  container-type:inline-size;
  font-family:var(--gp-font);font-size:12.5px;line-height:1.45;letter-spacing:-.006em;
  color:var(--gp-label);background:transparent;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
body[data-ds-dark-theme] .gp-root{
  --gp-orange:#ffb340;
  --gp-purple:#c08cff;
  --gp-blue:#66a9ff;
  --gp-file-code:#e0c07a;
  --gp-file-data:#b9a3e3;
  --gp-file-style:#6fc7e8;
  --gp-file-doc:#7fa6cf;
  --gp-file-image:#c08ed6;
  --gp-file-media:#e08ab0;
  --gp-file-font:#d8c98a;
  --gp-file-archive:#9aa3ad;
  --gp-file-lock:#a9a9b3;
  --gp-file-shell:#8fd39a;
  --gp-accent:#9dbcd8;
  --gp-accent-hover:#b2cbe2;
  --gp-accent-ink:#0d1319;
  --gp-accent-soft:rgba(157,188,216,.16);
  --gp-ring:0 0 0 3px rgba(157,188,216,.3);

  --gp-diff-add-line:color-mix(in srgb,var(--gp-green) 10%,transparent);
  --gp-diff-add-text:color-mix(in srgb,var(--gp-green) 12%,transparent);
  --gp-diff-add-word:color-mix(in srgb,var(--gp-green) 26%,transparent);
  --gp-diff-del-line:color-mix(in srgb,var(--gp-red) 10%,transparent);
  --gp-diff-del-text:color-mix(in srgb,var(--gp-red) 12%,transparent);
  --gp-diff-del-word:color-mix(in srgb,var(--gp-red) 26%,transparent);

  --gp-tok-comment:#6a9955;
  --gp-tok-string:#ce9178;
  --gp-tok-keyword:#569cd6;
  --gp-tok-number:#b5cea8;
  --gp-tok-func:#dcdcaa;
  --gp-tok-type:#4ec9b0;
  --gp-tok-key:#9cdcfe;
  --gp-tok-tag:#569cd6;
  --gp-tok-attr:#9cdcfe;
  --gp-tok-heading:#569cd6;
  --gp-tok-code:#ce9178;
}
body:not([data-ds-dark-theme]) .gp-root{
  --gp-scm-modified:#895503;
  --gp-scm-added:#587c0c;
  --gp-scm-untracked:#007100;
  --gp-scm-deleted:#ad0707;
  --gp-scm-conflict:#ad0707;
}
.gp-root ::-webkit-scrollbar{width:9px;height:9px}
.gp-root ::-webkit-scrollbar-track{background:transparent}
.gp-root ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,#3b3b40);border-radius:999px;border:2px solid transparent;background-clip:content-box}
.gp-root ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,#4a4a50);background-clip:content-box}

.gp-changes,.gp-graph-list,.gp-diff-body{overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,#3b3b40) transparent}

/* --- review --------------------------------------------------------------- */
.gp-review{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 12px 6px}
.gp-review-head{display:flex;align-items:center;gap:6px;align-self:flex-start;font-size:10.5px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--gp-label-3);cursor:pointer;user-select:none;padding:2px 6px;margin-left:-6px;border-radius:var(--gp-radius-s);transition:background .12s var(--gp-ease),color .12s var(--gp-ease)}
.gp-review-head:hover{background:var(--gp-hover);color:var(--gp-label-2)}
.gp-review-head:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-review-btn{width:100%;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:.5px solid var(--gp-separator);border-radius:var(--gp-radius-s);background:transparent;color:var(--gp-label-2);font:inherit;font-size:12px;font-weight:560;cursor:pointer;transition:background .12s var(--gp-ease),color .12s var(--gp-ease),border-color .12s var(--gp-ease)}
.gp-review-btn:hover:not(:disabled){background:var(--gp-hover);border-color:var(--gp-label-4);color:var(--gp-label)}
.gp-review-btn:active:not(:disabled){transform:scale(.995)}
.gp-review-btn:disabled{opacity:.42;cursor:default}
.gp-review-btn svg{width:13px;height:13px;flex:none}

/* --- changes -------------------------------------------------------------- */
.gp-changes{flex:1;min-height:90px;padding:2px 0 6px}
.gp-section{flex:none}
.gp-section-head{display:flex;align-items:center;gap:2px;padding:0 6px;height:30px}
.gp-section-head-graph{height:34px;padding:0 6px 0 4px;border-top:.5px solid var(--gp-hairline);border-bottom:.5px solid var(--gp-hairline);gap:2px}
.gp-section-toggle{display:flex;align-items:center;gap:6px;min-width:0;height:24px;padding:0 5px;border-radius:var(--gp-radius-s);cursor:pointer;user-select:none;color:inherit;background:transparent;transition:background .12s var(--gp-ease)}
.gp-section-toggle:hover{background:var(--gp-hover)}
.gp-section-toggle:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-section-title{font-size:10.5px;font-weight:650;letter-spacing:.045em;text-transform:uppercase;color:var(--gp-label-3);white-space:nowrap}
.gp-section-count{min-width:17px;height:15px;padding:0 5px;border-radius:999px;background:var(--gp-hover);color:var(--gp-label-3);font-size:10px;font-weight:600;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}
.gp-chevron{width:11px;height:11px;flex:none;color:var(--gp-label-3);transition:transform .2s var(--gp-ease)}
.gp-chevron.open{transform:rotate(90deg)}
.gp-section-actions{position:relative;margin-left:auto;display:flex;align-items:center;gap:1px;flex:none}
/* The branch popover belongs to the header's action cluster, not to the chip:
   anchored to the chip it would hang off the panel's left edge. */
.gp-section-actions .gp-menu-wrap{position:static}
/* A narrow pane gives the branch chip the room fetch would otherwise take;
   sync already covers fetch + pull + push. */
@container (max-width: 300px){
  .gp-section-head-graph .gp-btn-fetch{display:none}
}

/* The progress line sits under the graph header, where the verb that is running
   lives; the elapsed clock is a leaf component, so it ticks without repainting
   the 60-row graph above it. */
.gp-progress{flex:none;display:flex;align-items:center;gap:6px;height:22px;padding:0 10px 0 8px;font-size:10.5px;color:var(--gp-accent);background:var(--gp-accent-soft);border-bottom:.5px solid var(--gp-hairline);animation:gp-fade .12s var(--gp-ease)}
.gp-progress-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-progress-time{margin-left:auto;flex:none;font-family:var(--gp-mono);font-size:10px;font-variant-numeric:tabular-nums;color:var(--gp-label-3)}

.gp-row{display:flex;align-items:center;gap:8px;height:32px;margin:0 6px;padding:0 6px 0 8px;border-radius:7px;cursor:pointer;position:relative;transition:background .12s var(--gp-ease)}
.gp-row:hover{background:var(--gp-hover)}
.gp-row:active{background:var(--gp-press)}
.gp-row:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-row .gp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;letter-spacing:-.01em}
.gp-row .gp-name .gp-dir{color:var(--gp-label-3)}
.gp-row-conflict .gp-name{color:var(--gp-red)}
/* A deleted path reads struck through, as in the Source Control view. */
.gp-row-deleted .gp-name{text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:color-mix(in srgb,var(--gp-label-3) 78%,transparent)}
.gp-counts{display:flex;gap:6px;flex:none;font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--gp-label-3);font-family:var(--gp-mono)}
.gp-add{color:var(--gp-green)}
.gp-del{color:var(--gp-red)}
.gp-row-actions{display:none;align-items:center;gap:1px;flex:none}
.gp-row:hover .gp-row-actions{display:flex}
.gp-row:hover .gp-counts{display:none}
.gp-row:hover .gp-change{display:none}

/* --- change badges -------------------------------------------------------- */
/* One coloured letter, right-aligned, no pill: the Source Control vocabulary.
   Hover swaps it for the row actions, so it never competes with them. */
.gp-change{flex:none;display:inline-flex;align-items:center;justify-content:center;width:13px;height:18px;font:600 11px/1 var(--gp-font);font-variant-numeric:tabular-nums;user-select:none;color:var(--gp-label-3)}
.gp-change.M,.gp-change.T{color:var(--gp-scm-modified)}
.gp-change.A,.gp-change.C{color:var(--gp-scm-added)}
.gp-change.U,.gp-change.R{color:var(--gp-scm-untracked)}
.gp-change.D{color:var(--gp-scm-deleted)}
.gp-change.CONFLICT{color:var(--gp-scm-conflict);font-weight:700}

/* --- file type icons ------------------------------------------------------ */
.gp-ftype{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;color:var(--gp-label-4)}
.gp-ftype svg{width:16px;height:16px;flex:none;display:block}

/* --- buttons -------------------------------------------------------------- */
.gp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;min-width:24px;padding:0 5px;border-radius:var(--gp-radius-s);border:none;background:transparent;color:var(--gp-label-3);font:inherit;font-size:11.5px;cursor:pointer;transition:background .12s var(--gp-ease),color .12s var(--gp-ease)}
.gp-btn:hover:not(:disabled){background:var(--gp-hover);color:var(--gp-label)}
.gp-btn:active:not(:disabled){background:var(--gp-press)}
.gp-btn:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-btn:disabled{opacity:.36;cursor:default}
.gp-btn svg{width:13px;height:13px;flex:none}
.gp-btn.active{background:var(--gp-accent-soft);color:var(--gp-accent)}
.gp-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--gp-red) 16%,transparent);color:var(--gp-red)}
/* A running verb keeps its place in the header: the glyph becomes a spinner and
   the button stays at full strength, because disabled-on-purpose is not a lie. */
.gp-btn-busy,.gp-btn-busy:disabled{color:var(--gp-accent);opacity:1;cursor:progress}
.gp-btn-busy:hover:not(:disabled){background:transparent}

.gp-primary{height:30px;padding:0 12px;border-radius:8px;border:none;background:var(--gp-accent);color:var(--gp-accent-ink);font:inherit;font-size:12.5px;font-weight:600;letter-spacing:-.01em;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .12s var(--gp-ease),transform .08s var(--gp-ease)}
.gp-primary:hover:not(:disabled){background:var(--gp-accent-hover)}
.gp-primary:active:not(:disabled){transform:scale(.99)}
.gp-primary:focus-visible{outline:none;box-shadow:var(--gp-ring),0 0 0 1px var(--gp-bg)}
.gp-primary:disabled{background:color-mix(in srgb,var(--gp-label) 5%,transparent);color:var(--gp-label-4);cursor:default}
.gp-primary svg{width:14px;height:14px;flex:none}

/* --- commit box ----------------------------------------------------------- */
.gp-compose{flex:none;display:flex;flex-direction:column;gap:8px;padding:12px 12px 10px;border-bottom:.5px solid var(--gp-hairline)}
.gp-input{box-sizing:border-box;width:100%;min-height:38px;max-height:140px;resize:none;field-sizing:content;padding:9px 10px;border-radius:10px;border:.5px solid var(--gp-hairline);background:color-mix(in srgb,var(--gp-label) 4%,transparent);color:var(--gp-label);font:inherit;font-size:12.5px;line-height:1.45;outline:none;transition:border-color .12s var(--gp-ease),box-shadow .12s var(--gp-ease),background .12s var(--gp-ease)}
.gp-input::placeholder{color:var(--gp-label-4)}
.gp-input:hover{border-color:var(--gp-separator)}
.gp-input:focus{border-color:color-mix(in srgb,var(--gp-accent) 60%,transparent);box-shadow:var(--gp-ring);background:color-mix(in srgb,var(--gp-label) 7%,transparent)}
.gp-input-wrap{position:relative;display:flex}
.gp-input-wrap .gp-input{padding-right:34px}
.gp-input-ai{position:absolute;top:6px;right:6px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:var(--gp-radius-s);background:transparent;color:var(--gp-label-4);cursor:pointer;transition:background .12s var(--gp-ease),color .12s var(--gp-ease)}
.gp-input-ai:hover:not(:disabled){background:var(--gp-hover);color:var(--gp-label-2)}
.gp-input-ai:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-input-ai:disabled{opacity:.32;cursor:default}
.gp-input-ai svg{width:14px;height:14px;flex:none}
.gp-actions{display:flex;align-items:center;gap:6px}
.gp-actions .gp-primary{width:100%}
.gp-primary-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- branch chip + popover menu ------------------------------------------- */
.gp-menu-wrap{position:relative;display:inline-flex;min-width:0}
.gp-branch{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:132px;height:24px;padding:0 8px;border-radius:7px;background:var(--gp-hover);border:.5px solid var(--gp-hairline);color:var(--gp-label);font-family:var(--gp-mono);font-size:11px;letter-spacing:0;cursor:pointer;transition:background .12s var(--gp-ease),border-color .12s var(--gp-ease)}
.gp-branch:hover{background:var(--gp-press)}
.gp-branch:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-branch svg{width:11px;height:11px;flex:none;color:var(--gp-label-3)}
.gp-branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-branch-meta{display:flex;gap:3px;flex:none;font-size:9.5px;color:var(--gp-label-3);font-variant-numeric:tabular-nums}
.gp-branch-meta .up{color:var(--gp-green)}
.gp-branch-meta .down{color:var(--gp-orange)}
.gp-branch-waiting{cursor:default;color:var(--gp-label-3)}
.gp-branch-pending{cursor:progress;max-width:150px;border-color:color-mix(in srgb,var(--gp-accent) 55%,transparent);color:var(--gp-accent);background:var(--gp-accent-soft)}
.gp-branch-pending .gp-spinner{color:var(--gp-accent)}
.gp-menu{position:absolute;z-index:50;top:calc(100% + 6px);right:0;min-width:216px;max-height:min(60vh,340px);overflow:auto;padding:5px;border-radius:11px;background:color-mix(in srgb,var(--gp-surface-3) 90%,transparent);backdrop-filter:saturate(180%) blur(30px);-webkit-backdrop-filter:saturate(180%) blur(30px);border:.5px solid var(--gp-hairline);box-shadow:0 18px 44px rgba(0,0,0,.42),0 0 0 .5px rgba(0,0,0,.18);animation:gp-pop .14s var(--gp-ease);display:flex;flex-direction:column;gap:1px}
.gp-menu.up{top:auto;bottom:calc(100% + 6px);animation-name:gp-pop-up}
.gp-menu-title{display:flex;align-items:center;gap:6px;padding:4px 8px 3px;font-size:9.5px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--gp-label-4)}
.gp-menu button{display:flex;width:100%;align-items:center;gap:8px;height:28px;padding:0 8px;border:none;border-radius:var(--gp-radius-s);background:transparent;color:var(--gp-label);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background .1s var(--gp-ease),color .1s var(--gp-ease)}
.gp-menu button:hover:not(:disabled){background:var(--gp-accent);color:var(--gp-accent-ink)}
.gp-menu button:hover:not(:disabled) svg{color:currentColor}
.gp-menu button:disabled{color:var(--gp-label-3);cursor:default}
.gp-menu button svg{width:12px;height:12px;flex:none;color:var(--gp-label-3)}
.gp-menu button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-menu-check{margin-left:auto;display:inline-flex;color:var(--gp-accent)}
.gp-menu-check svg{color:currentColor}

/* --- graph ---------------------------------------------------------------- */
.gp-resizer{flex:none;position:relative;height:10px;margin:-3px 0;cursor:row-resize;background:transparent;user-select:none;touch-action:none}
.gp-resizer:after{content:"";position:absolute;left:50%;top:50%;width:38px;height:3px;margin:-1.5px 0 0 -19px;border-radius:2px;background:var(--gp-separator);opacity:0;transition:opacity .15s var(--gp-ease)}
.gp-resizer:hover:after,.gp-resizer:active:after{opacity:1}
.gp-graph-panel{flex:none;display:flex;flex-direction:column;min-height:0;position:relative;overflow:visible}
.gp-graph-list{flex:1;min-height:0;padding:2px 0 6px}
.gp-graph{position:relative}
.gp-graph-row{display:flex;align-items:center;gap:8px;min-height:38px;margin:0 6px;padding:0 8px 0 2px;border-radius:8px;cursor:pointer;position:relative;transition:background .12s var(--gp-ease)}
.gp-graph-row:hover{background:var(--gp-hover)}
.gp-graph-row:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-graph-row.selected{background:var(--gp-accent-soft);box-shadow:inset 2px 0 0 var(--gp-accent)}
.gp-graph-canvas{flex:none;display:block;overflow:visible;transition:filter .15s var(--gp-ease)}
.gp-graph-row:hover .gp-graph-canvas{filter:brightness(1.12)}
.gp-graph-row.selected .gp-graph-canvas{filter:brightness(1.2) saturate(1.05)}
.gp-graph-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.gp-graph-subject{display:flex;align-items:center;gap:5px;min-width:0}
.gp-graph-subject .gp-subject-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;letter-spacing:-.01em}
.gp-ref{flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:17px;padding:0 6px;border-radius:999px;background:var(--gp-hover);color:var(--gp-label-2);font-size:9.5px;font-weight:600;line-height:17px;letter-spacing:.01em}
.gp-ref.head{background:color-mix(in srgb,var(--gp-accent) 24%,transparent);color:var(--gp-accent)}
.gp-ref.tag{background:color-mix(in srgb,var(--gp-orange) 20%,transparent);color:var(--gp-orange)}
.gp-ref.remote{background:color-mix(in srgb,var(--gp-purple) 20%,transparent);color:var(--gp-purple)}
.gp-graph-meta{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;font-size:10.5px;color:var(--gp-label-4);font-variant-numeric:tabular-nums}
.gp-graph-meta > span{flex:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-graph-meta > span:not(.gp-hash){flex:0 1 auto}
.gp-graph-meta > span + span:before{content:"·";margin-right:6px;color:var(--gp-label-4)}
.gp-graph-meta .gp-hash{font-family:var(--gp-mono);font-size:10px;color:var(--gp-label-3);background:var(--gp-hover);border-radius:4px;padding:0 4px;line-height:15px}
.gp-detail{margin:2px 6px 8px;padding:10px 12px;border-radius:var(--gp-radius-m);background:color-mix(in srgb,var(--gp-label) 4%,transparent);border:.5px solid var(--gp-hairline);animation:gp-fade .16s var(--gp-ease)}
.gp-detail-body{white-space:pre-wrap;word-break:break-word;font-size:11.5px;color:var(--gp-label-2);margin:6px 0 8px}
.gp-kv{display:flex;gap:8px;font-size:11px;color:var(--gp-label-3);line-height:1.7}
.gp-kv b{font-weight:600;color:var(--gp-label-2)}
.gp-detail-actions{display:flex;gap:1px;margin:6px 0 0 -5px}
.gp-detail-files{margin-top:8px;padding-top:8px;border-top:.5px solid var(--gp-hairline);display:flex;flex-direction:column;gap:1px;max-height:168px;overflow:auto}
.gp-detail-file{display:flex;align-items:center;gap:7px;height:24px;padding:0 4px;border-radius:5px;font-size:11px;color:var(--gp-label-2)}
.gp-detail-file:hover{background:var(--gp-hover)}
.gp-detail-file .gp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- status note / error / toast ------------------------------------------ */
.gp-note{padding:18px 14px;color:var(--gp-label-3);font-size:11.5px;text-align:center;line-height:1.5}
.gp-error{margin:8px 12px 0;padding:9px 10px;border-radius:10px;background:color-mix(in srgb,var(--gp-red) 10%,transparent);border:.5px solid color-mix(in srgb,var(--gp-red) 24%,transparent);color:var(--gp-label);font-size:11.5px;display:flex;gap:8px;align-items:flex-start;animation:gp-fade .16s var(--gp-ease)}
.gp-error-icon{flex:none;display:inline-flex;margin-top:1px;color:var(--gp-red)}
.gp-error-icon svg{width:13px;height:13px}
.gp-error span.gp-error-text{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}
.gp-toast{margin:8px 12px 0;padding:8px 10px;border-radius:9px;background:var(--gp-hover);color:var(--gp-label-2);font-size:11.5px;display:flex;gap:7px;align-items:center;animation:gp-fade .16s var(--gp-ease)}
.gp-toast svg{width:13px;height:13px;flex:none;color:var(--gp-green)}

/* --- confirm overlay ------------------------------------------------------ */
.gp-confirm-scrim{position:absolute;inset:0;z-index:60;display:flex;align-items:flex-end;padding:10px;background:color-mix(in srgb,#000 36%,transparent);animation:gp-fade .16s var(--gp-ease)}
.gp-confirm{flex:1;padding:10px 12px;border-radius:var(--gp-radius-l);background:color-mix(in srgb,var(--gp-surface-3) 92%,transparent);backdrop-filter:saturate(180%) blur(28px);-webkit-backdrop-filter:saturate(180%) blur(28px);border:.5px solid var(--gp-hairline);box-shadow:0 18px 44px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.2);font-size:11.5px;display:flex;gap:8px;align-items:center;animation:gp-rise .2s var(--gp-ease)}
.gp-confirm span{flex:1;min-width:0;line-height:1.5}
.gp-confirm .gp-primary{height:26px;padding:0 10px;font-size:11.5px;flex:none}

/* --- diff page ------------------------------------------------------------ */
/* A unified diff laid out like the VS Code diff editor: dual line-number
   gutters, a sign column, a tinted text run per changed line, word-level
   washes for the characters that moved, and sticky per-file headers. */
.gp-diff{display:flex;flex-direction:column;height:100%;min-height:0;font-size:11.5px;background:transparent}
.gp-diff-head{display:flex;align-items:center;gap:7px;padding:0 12px;height:40px;flex:none;border-bottom:.5px solid var(--gp-hairline);background:color-mix(in srgb,var(--gp-surface) 55%,transparent)}
.gp-diff-head .gp-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--gp-mono);font-size:11.5px;color:var(--gp-label)}
.gp-diff-head .gp-path.commit{font-family:var(--gp-font);font-weight:560;letter-spacing:-.01em}
.gp-diff-head .gp-ftype{flex:none}
.gp-diffstat{flex:none;display:inline-flex;gap:1.5px;height:7px;width:52px;border-radius:3px;overflow:hidden}
.gp-diffstat i{flex:1;background:var(--gp-label-4);opacity:.28}
.gp-diffstat i.add{background:var(--gp-green);opacity:.9}
.gp-diffstat i.del{background:var(--gp-red);opacity:.9}
.gp-diff-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;font-family:var(--gp-mono);font-size:11.5px;line-height:19px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,#3b3b40) transparent}
.gp-diff-body ::-webkit-scrollbar{width:9px;height:9px}

/* One file inside a multi-file patch (commit / every-change preview). */
.gp-file{display:block;min-width:100%}
.gp-file-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:6px;height:30px;padding:0 10px 0 7px;background:color-mix(in srgb,var(--gp-surface-2) 92%,transparent);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px);border-bottom:.5px solid var(--gp-hairline);cursor:pointer;user-select:none;transition:background .12s var(--gp-ease)}
.gp-file-head:hover{background:var(--gp-surface-3)}
.gp-file-head:focus-visible{outline:none;box-shadow:var(--gp-ring)}
.gp-file-head .gp-ftype{flex:none;opacity:.85}
.gp-file-head .gp-chevron{color:var(--gp-label-4);transition:transform .15s var(--gp-ease)}
.gp-file-head .gp-chevron.open{transform:rotate(90deg)}
.gp-file-path{flex:0 1 auto;min-width:0;display:flex;align-items:baseline;font-size:11px;line-height:1;white-space:nowrap}
.gp-file-dir{color:var(--gp-label-4);overflow:hidden;text-overflow:ellipsis}
.gp-file-name{color:var(--gp-label-2);overflow:hidden;text-overflow:ellipsis}
.gp-file-old{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gp-label-4);font-size:10.5px}
.gp-file-tag{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.02em;line-height:1}
.gp-file-tag.M{color:var(--gp-orange);background:color-mix(in srgb,var(--gp-orange) 14%,transparent)}
.gp-file-tag.A{color:var(--gp-green);background:color-mix(in srgb,var(--gp-green) 14%,transparent)}
.gp-file-tag.D{color:var(--gp-red);background:color-mix(in srgb,var(--gp-red) 14%,transparent)}
.gp-file-tag.R{color:var(--gp-blue);background:color-mix(in srgb,var(--gp-blue) 16%,transparent)}
.gp-file-stats{margin-left:auto;flex:none;display:flex;align-items:center;gap:6px;padding-left:8px;font-size:10.5px;font-variant-numeric:tabular-nums}
.gp-file-note{padding:10px 14px 14px}

/* Hunk rails: the range plus the function context git put after the second @@. */
.gp-hunk{display:flex;align-items:center;gap:6px;min-height:22px;padding:2px 10px 2px 8px;background:color-mix(in srgb,var(--gp-blue) 6%,var(--gp-surface-2));border-top:.5px solid var(--gp-hairline);border-bottom:.5px solid var(--gp-hairline);color:var(--gp-label-3);font-size:10.5px;white-space:nowrap;overflow:hidden;box-shadow:inset 2px 0 0 color-mix(in srgb,var(--gp-blue) 40%,transparent)}
.gp-hunk-mark{flex:none;color:color-mix(in srgb,var(--gp-blue) 72%,var(--gp-label-3));font-weight:600;letter-spacing:-.02em}
.gp-hunk-range{flex:none;color:var(--gp-label-3);font-variant-numeric:tabular-nums}
.gp-hunk-section{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--gp-label-4);font-style:italic;padding-left:2px}
.gp-hunk-section:empty{display:none}

/* One line: old number · new number · sign · code. */
.gp-diff-line{display:flex;box-sizing:border-box;width:max-content;min-width:100%;white-space:pre;position:relative}
.gp-diff-line .gp-ln{flex:none;width:34px;padding-right:7px;text-align:right;color:var(--gp-label-4);user-select:none;font-variant-numeric:tabular-nums;font-size:10.5px;opacity:.72}
.gp-diff-line .gp-sign{flex:none;width:14px;text-align:center;color:var(--gp-label-4);user-select:none;font-weight:600}
.gp-diff-line .gp-code{flex:1;padding-right:16px;white-space:pre;min-height:19px}
.gp-diff-line .gp-code-text{white-space:pre}
.gp-diff-line.add{background:var(--gp-diff-add-line)}
.gp-diff-line.add .gp-ln{color:color-mix(in srgb,var(--gp-green) 34%,var(--gp-label-4));opacity:.85}
.gp-diff-line.add .gp-sign{color:var(--gp-green)}
.gp-diff-line.add .gp-code-text{background:var(--gp-diff-add-text);border-radius:2px}
.gp-diff-line.del{background:var(--gp-diff-del-line)}
.gp-diff-line.del .gp-ln{color:color-mix(in srgb,var(--gp-red) 34%,var(--gp-label-4));opacity:.85}
.gp-diff-line.del .gp-sign{color:var(--gp-red)}
.gp-diff-line.del .gp-code-text{background:var(--gp-diff-del-text);border-radius:2px}
.gp-diff-line.add .gp-word{background:var(--gp-diff-add-word);border-radius:2px}
.gp-diff-line.del .gp-word{background:var(--gp-diff-del-word);border-radius:2px}

/* Syntax colours; a missing token class falls through to the line colour. */
.gp-tok-comment{color:var(--gp-tok-comment);font-style:italic}
.gp-tok-string{color:var(--gp-tok-string)}
.gp-tok-keyword{color:var(--gp-tok-keyword)}
.gp-tok-number{color:var(--gp-tok-number)}
.gp-tok-func{color:var(--gp-tok-func)}
.gp-tok-type{color:var(--gp-tok-type)}
.gp-tok-key{color:var(--gp-tok-key)}
.gp-tok-tag{color:var(--gp-tok-tag)}
.gp-tok-attr{color:var(--gp-tok-attr)}
.gp-tok-heading{color:var(--gp-tok-heading);font-weight:600}
.gp-tok-code{color:var(--gp-tok-code)}

/* A commit's message, shown above its patch. */
.gp-commit{display:flex;flex-direction:column;gap:4px;padding:12px 12px 10px;border-bottom:.5px solid var(--gp-hairline);background:color-mix(in srgb,var(--gp-label) 3%,transparent)}
.gp-commit-subject{font-family:var(--gp-font);font-size:12.5px;font-weight:600;letter-spacing:-.01em;line-height:1.45;word-break:break-word}
.gp-commit-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;font-family:var(--gp-font);font-size:10.5px;color:var(--gp-label-4)}
.gp-commit-meta > span + span:before{content:"·";margin-right:5px;color:var(--gp-label-4)}
.gp-commit-hash{font-family:var(--gp-mono);font-size:10px;color:var(--gp-label-3);background:var(--gp-hover);border-radius:4px;padding:0 5px;line-height:16px}
.gp-commit-body{margin-top:2px;max-height:132px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--gp-font);font-size:11px;line-height:1.6;color:var(--gp-label-2)}

/* First paint: a few skeleton rows instead of a jump-cut. */
.gp-skeleton{padding:8px 0}
.gp-skeleton i{display:block;height:10px;margin:6px 12px;border-radius:3px;background:var(--gp-hover);animation:gp-pulse 1.2s ease-in-out infinite}
@keyframes gp-pulse{0%,100%{opacity:.45}50%{opacity:.9}}

/* The side pane runs narrow: drop the secondary chips before the path is
   squeezed to an ellipsis, and keep the counts that carry real information. */
@container (max-width: 360px){
  .gp-diff-head .gp-tag-files{display:none}
  .gp-diffstat{display:none}
}

/* --- misc ----------------------------------------------------------------- */
.gp-tag{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:999px;background:var(--gp-hover);color:var(--gp-label-3);font-size:9.5px;font-weight:600}
.gp-spinner{display:inline-block;width:11px;height:11px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:gp-spin .7s linear infinite}
@keyframes gp-spin{to{transform:rotate(360deg)}}
@keyframes gp-pop{from{opacity:0;transform:scale(.97) translateY(-3px)}to{opacity:1;transform:none}}
@keyframes gp-pop-up{from{opacity:0;transform:scale(.97) translateY(3px)}to{opacity:1;transform:none}}
@keyframes gp-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes gp-fade{from{opacity:0}to{opacity:1}}
`

		/* ------------------------------------------------------------------ */
		/* Small utilities                                                    */
		/* ------------------------------------------------------------------ */

		/** Install the stylesheet once per page; the effect removes it on dispose. */
		function installStyles() {
			if (typeof document === 'undefined') return undefined
			const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
			if (existing !== null) return undefined
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-git-panel'
			tag.dataset.pluginCss = STYLE_ID
			tag.textContent = CSS
			document.head.appendChild(tag)
			return () => {
				tag.remove()
			}
		}

		/** Resolve the route below the page base so forwarded deployments keep working. */
		function endpointUrl() {
			if (typeof document === 'undefined') return ROUTE
			try {
				return new URL(ROUTE, document.baseURI).href
			} catch {
				return ROUTE
			}
		}

		/** One failure from the Host route, carrying its stable code. */
		class PanelFailure extends Error {
			constructor(code, message, details) {
				super(message)
				this.name = 'PanelFailure'
				this.code = code
				this.details = details
			}
		}

		/**
		 * Call one Host action.
		 * @param {string} action - route action name.
		 * @param {object} payload - action fields (cwd plus action-specific ones).
		 * @param {AbortSignal} [signal] - request signal.
		 * @returns {Promise<object>} the route's value.
		 */
		async function call(action, payload, signal) {
			const response = await fetch(endpointUrl(), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				signal,
				body: JSON.stringify({ action, ...payload }),
			})
			if (!response.ok) throw new PanelFailure('http', `HTTP ${response.status}`, { status: response.status })
			const envelope = await response.json()
			if (envelope === null || typeof envelope !== 'object') throw new PanelFailure('bad-payload', '响应格式不正确')
			if (envelope.ok === true) return envelope.value
			const error = envelope.error ?? {}
			throw new PanelFailure(String(error.code ?? 'failed'), String(error.message ?? 'Git 操作失败'), error.details)
		}

		/** Fill `{name}` placeholders; unknown names stay literal. */
		function fill(text, values) {
			return String(text).replace(/\{(\w+)\}/gu, (whole, name) => {
				const value = values === undefined ? undefined : values[name]
				return value === undefined ? whole : String(value)
			})
		}

		/** Split a path into its directory and its node name. */
		function splitPath(path) {
			const index = String(path).lastIndexOf('/')
			if (index === -1) return { dir: '', name: String(path) }
			return { dir: String(path).slice(0, index + 1), name: String(path).slice(index + 1) }
		}

		/**
		 * Navigation params for one row's diff tab.
		 *
		 * The worktree group mixes modified and untracked files, so the row's own
		 * porcelain code decides whether the Host should diff the index or
		 * synthesize an all-additions patch for a file git has never seen.
		 * @param {object} entry - status row.
		 * @param {string} group - section id (`staged | worktree | untracked | conflicts`).
		 * @param {string} [cwd] - repository working directory.
		 * @returns {object} params for the `git-diff` tab.
		 */
		function diffRequestFor(entry, group, cwd) {
			const path = String(entry?.path ?? '')
			const base = typeof cwd === 'string' && cwd !== '' ? { cwd } : {}
			if (group === 'staged') return { path, staged: true, ...base }
			if (group === 'untracked' || entry?.code === '??') return { path, untracked: true, ...base }
			return { path, ...base }
		}

		/**
		 * The `discard` payload for one row: untracked files are removed, tracked
		 * ones are restored. A staged-new file is handled by the Host, which sees
		 * it as tracked-without-HEAD.
		 * @param {object} entry - status row.
		 * @param {string} group - section id.
		 * @returns {object} request fields.
		 */
		function discardRequestFor(entry, group) {
			const path = String(entry?.path ?? '')
			const untracked = group === 'untracked' || entry?.code === '??'
			return untracked ? { paths: [], untracked: [path] } : { paths: [path] }
		}

		/** A short, human relative time for a unix-seconds or ISO timestamp. */
		function relativeTime(value, now = Date.now()) {
			let ms
			if (typeof value === 'number') ms = value > 1e12 ? value : value * 1000
			else ms = Date.parse(String(value))
			if (!Number.isFinite(ms)) return ''
			const seconds = Math.max(0, Math.round((now - ms) / 1000))
			if (seconds < 60) return '刚刚'
			const minutes = Math.round(seconds / 60)
			if (minutes < 60) return `${minutes} 分钟前`
			const hours = Math.round(minutes / 60)
			if (hours < 24) return `${hours} 小时前`
			const days = Math.round(hours / 24)
			if (days < 30) return `${days} 天前`
			const months = Math.round(days / 30)
			if (months < 12) return `${months} 个月前`
			return `${Math.round(months / 12)} 年前`
		}

		/** Absolute local time for a timestamp, for the commit detail. */
		function absoluteTime(value) {
			const ms = typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : Date.parse(String(value))
			if (!Number.isFinite(ms)) return String(value ?? '')
			try {
				return new Date(ms).toLocaleString()
			} catch {
				return String(value ?? '')
			}
		}

		/**
		 * Build the `dsh-resource://file/...` address of one repository file.
		 * An absolute path keeps working when the repository root differs from the
		 * Session's workspace root.
		 * @param {string} sessionId - Session opening the file.
		 * @param {string} root - repository top level.
		 * @param {string} path - repository-relative path.
		 * @returns {string} the address.
		 */
		/**
		 * Pull the conflict block out of a patch; a patch without markers falls
		 * back to its first lines so the quote is never empty.
		 * @param {string} patch - unified diff text.
		 * @returns {string} the quoted lines.
		 */
		/**
		 * Put one quote into the conversation input of a session, appending to what
		 * the user already typed. Falls back to the clipboard when the input cannot
		 * be reached from here.
		 * @param {string} sessionId - session on screen.
		 * @param {string} text - the quote.
		 * @returns {boolean} true when the input took it.
		 */
		function insertIntoComposer(sessionId, text) {
			try {
				const conversation = pluginCtx?.get?.('conversation')
				const sessions = pluginCtx?.get?.('sessions')
				const binding = sessions?.binding?.(sessionId)
				if (conversation?.input !== undefined && binding !== undefined) {
					const shell = conversation.input.shellFor?.(binding)
					const current = typeof shell?.snapshot?.draft === 'string' ? shell.snapshot.draft : ''
					const prompt = current.trim() === '' ? text : `${current.trimEnd()}\n\n${text}`
					if (conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'replace' }) !== 'blocked') return true
				}
			} catch (failure) {
				// the clipboard below is the fallback
			}
			try {
				navigator.clipboard?.writeText?.(text)
			} catch (failure) {
				// nothing else to do
			}
			return false
		}

		function conflictSnippet(patch) {
			const lines = String(patch ?? '').split('\n')
			const start = lines.findIndex((line) => line.startsWith('<<<<<<<'))
			let end = -1
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				if (lines[index].startsWith('>>>>>>>')) { end = index; break }
			}
			if (start === -1 || end === -1 || end < start) return lines.slice(0, 40).join('\n')
			return lines.slice(start, end + 1).join('\n')
		}

		/**
		 * Build the review request the "Find Issues" button sends to the composer.
		 *
		 * The prompt asks the agent to read the diff itself rather than pasting it:
		 * a working tree can be megabytes, and the conversation input is only a draft.
		 * @param {object} input - repo facts.
		 * @returns {string} prompt text, empty when there is nothing to review.
		 */
		function buildReviewPrompt(input) {
			const cwd = String(input?.cwd ?? '')
			const branch = String(input?.branch ?? 'HEAD')
			const staged = Array.isArray(input?.staged) ? input.staged : []
			const changes = Array.isArray(input?.changes) ? input.changes : []
			const untracked = Array.isArray(input?.untracked) ? input.untracked : []
			const limit = Number.isInteger(input?.limit) ? input.limit : 40
			const all = [
				...staged.map((entry) => `- [已暂存] ${entry.path}`),
				...changes.map((entry) => `- [未暂存] ${entry.path}`),
				...untracked.map((entry) => `- [未跟踪] ${entry.path}`),
			]
			if (all.length === 0) return ''
			const shown = all.slice(0, limit)
			const more = all.length > shown.length ? `\n- …另有 ${all.length - shown.length} 个文件，未列出` : ''
			const head = [
				'请审查当前工作区的本地改动，找出**真实存在的问题**，不要做风格偏好评审。',
				'',
				`仓库：${cwd}`,
				`分支：${branch}（对比基线：该分支的 HEAD）`,
				`改动：已暂存 ${staged.length} · 未暂存 ${changes.length} · 未跟踪 ${untracked.length}`,
				'',
				'改动文件：',
				...shown,
			].join('\n') + more
			const rules = [
				'',
				'做法要求：',
				`1. 先读真实内容：\`git -C ${cwd} diff\`、\`git -C ${cwd} diff --staged\`；未跟踪文件直接读文件。不要凭文件名猜。`,
				'2. 只报能给出证据的问题：正确性 bug、边界条件、空值、资源泄漏、并发与竞态、错误处理缺失、安全（注入/路径穿越/凭据）、向后兼容破坏、明确的性能回退。',
				'3. 每条按这个格式输出：`[级别] 文件:行 — 问题一句话`，下一行给「触发条件」与「建议修法」。级别只用 blocker / major / minor。',
				'4. 不要修改文件、不要提交、不要跑破坏性命令；这一步只出结论。',
				'5. 没问题就直说「未发现需要修的问题」，并列出实际看过的文件；不要为凑数编造。',
			].join('\n')
			return `${head}\n${rules}`
		}

		function fileAddress(sessionId, root, path) {
			const absolute = `${String(root).replace(/[\\/]+$/u, '')}/${path}`.replace(/\\/gu, '/')
			const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/giu, ':')
			const encoded = absolute.split('/').map(encodeSegment).join('/')
			return `dsh-resource://file/session/${encodeSegment(String(sessionId))}/${encoded}`
		}

		/* ------------------------------------------------------------------ */
		/* Patch parsing                                                      */
		/* ------------------------------------------------------------------ */

		/**
		 * Decode a path git quoted. Git escapes unprintable bytes as octal, so a
		 * run of octal escapes is decoded as UTF-8 instead of one byte at a time.
		 * @param {string} raw - the path as git printed it, quotes included.
		 * @returns {string} the plain path.
		 */
		function unquoteGitPath(raw) {
			const text = String(raw ?? '')
			if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
			const body = text.slice(1, -1)
			const parts = []
			const bytes = []
			const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null
			const flush = () => {
				if (bytes.length === 0) return
				parts.push(decoder !== null ? decoder.decode(new Uint8Array(bytes)) : String.fromCharCode(...bytes))
				bytes.length = 0
			}
			for (let index = 0; index < body.length; index += 1) {
				const char = body[index]
				if (char !== '\\') {
					flush()
					parts.push(char)
					continue
				}
				const octal = /^[0-7]{1,3}/u.exec(body.slice(index + 1))
				if (octal !== null) {
					bytes.push(Number.parseInt(octal[0], 8))
					index += octal[0].length
					continue
				}
				const escape = body[index + 1]
				if (escape === undefined) break
				flush()
				parts.push(
					escape === 'n' ? '\n' : escape === 't' ? '\t' : escape === 'r' ? '\r' : escape === 'b' ? '\b' : escape === 'f' ? '\f' : escape,
				)
				index += 1
			}
			flush()
			return parts.join('')
		}

		/**
		 * Split the two paths out of a `diff --git` header.
		 * @param {string} rest - everything after `diff --git `.
		 * @returns {{oldPath: string, newPath: string}} repository-relative paths.
		 */
		function parseGitHeaderPaths(rest) {
			const text = String(rest ?? '').trim()
			const strip = (path) => unquoteGitPath(path).replace(/^[ab]\//u, '')
			const quoted = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/u.exec(text)
			if (quoted !== null) return { oldPath: strip(quoted[1]), newPath: strip(quoted[2]) }
			const split = text.lastIndexOf(' b/')
			if (split > 0) return { oldPath: strip(text.slice(0, split)), newPath: strip(text.slice(split + 1)) }
			return { oldPath: '', newPath: '' }
		}

		/**
		 * Separate the commit message preamble `git show` prints from its patch.
		 * @param {string} patch - output of `git show --format=...`.
		 * @returns {{commit: object|null, patch: string}} the message and the patch.
		 */
		function splitCommitPatch(patch) {
			const text = String(patch ?? '')
			const lines = text.split('\n')
			const start = lines.findIndex((line) => line.startsWith('diff --git '))
			if (start <= 0) return { commit: null, patch: text }
			const head = lines.slice(0, start)
			while (head.length > 0 && head[head.length - 1] === '') head.pop()
			if (head.length < 4 || !/^[0-9a-f]{7,64}$/iu.test(head[0])) return { commit: null, patch: text }
			const author = /^(.*?)\s*<([^>]*)>$/u.exec(head[1] ?? '')
			return {
				commit: {
					hash: head[0],
					author: author === null ? String(head[1] ?? '').trim() : author[1].trim(),
					email: author === null ? '' : author[2],
					date: head[2] ?? '',
					subject: head[3] ?? '',
					body: head.slice(4).join('\n').trim(),
				},
				patch: lines.slice(start).join('\n'),
			}
		}

		/**
		 * Turn one unified diff into renderable rows, tracking both line numbers
		 * and the file each row belongs to. File headers (`diff --git`, `index`,
		 * `---`, `+++`) collapse into one `files` entry instead of becoming noise
		 * rows, which is what lets the page print a sticky header per file.
		 * @param {string} patch - unified diff text.
		 * @param {number} [limit] - row cap; the tail is dropped.
		 * @returns {{rows: object[], files: object[], truncated: boolean, additions: number, deletions: number}} rows, files and totals.
		 */
		function parsePatch(patch, limit = 6000) {
			const rows = []
			const files = []
			let current = null
			let index = -1
			let oldNo = 0
			let newNo = 0
			let truncated = false
			let additions = 0
			let deletions = 0

			const startFile = (fields) => {
				current = { path: '', oldPath: '', status: 'modified', additions: 0, deletions: 0, binary: false, ...fields }
				files.push(current)
				index = files.length - 1
				return current
			}
			const fileForRow = () => (current === null ? startFile({}) : current)

			for (const line of String(patch ?? '').split('\n')) {
				if (rows.length >= limit) {
					truncated = true
					break
				}
				if (line.startsWith('diff --git ')) {
					startFile(parseGitHeaderPaths(line.slice('diff --git '.length)))
					continue
				}
				if (line.startsWith('--- ')) {
					const path = unquoteGitPath(line.slice(4).trim()).replace(/^a\//u, '')
					if (current === null) startFile({ oldPath: path === '/dev/null' ? '' : path })
					if (path === '/dev/null') current.status = 'added'
					else current.oldPath = path
					continue
				}
				if (line.startsWith('+++ ')) {
					const path = unquoteGitPath(line.slice(4).trim()).replace(/^b\//u, '')
					if (current === null) startFile({})
					if (path === '/dev/null') {
						current.status = 'deleted'
						if (current.path === '') current.path = current.oldPath
					} else {
						current.path = path
					}
					continue
				}
				if (line.startsWith('new file mode')) {
					fileForRow().status = 'added'
					continue
				}
				if (line.startsWith('deleted file mode')) {
					fileForRow().status = 'deleted'
					continue
				}
				if (line.startsWith('rename from ')) {
					fileForRow().oldPath = unquoteGitPath(line.slice('rename from '.length).trim())
					current.status = 'renamed'
					continue
				}
				if (line.startsWith('rename to ')) {
					const target = unquoteGitPath(line.slice('rename to '.length).trim())
					fileForRow()
					if (target !== '') current.path = target
					current.status = 'renamed'
					continue
				}
				if (
					line.startsWith('index ') ||
					line.startsWith('similarity index') ||
					line.startsWith('dissimilarity index') ||
					line.startsWith('old mode') ||
					line.startsWith('new mode') ||
					line.startsWith('copy from ') ||
					line.startsWith('copy to ')
				) {
					continue
				}
				if (line.startsWith('Binary files') || line.startsWith('GIT binary patch') || line.startsWith('literal ')) {
					fileForRow().binary = true
					continue
				}
				if (line.startsWith('\\')) continue
				if (line.startsWith('@@')) {
					fileForRow()
					const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/u.exec(line)
					if (match !== null) {
						oldNo = Number.parseInt(match[1], 10)
						newNo = Number.parseInt(match[3], 10)
					}
					rows.push({
						kind: 'hunk',
						text: line,
						section: match === null ? '' : match[5],
						range:
							match === null
								? null
								: {
										oldStart: Number.parseInt(match[1], 10),
										oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
										newStart: Number.parseInt(match[3], 10),
										newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
									},
						oldNo: '',
						newNo: '',
						file: index,
					})
					continue
				}
				if (line.startsWith('+')) {
					additions += 1
					fileForRow().additions += 1
					rows.push({ kind: 'add', text: line.slice(1), oldNo: '', newNo, file: index })
					newNo += 1
					continue
				}
				if (line.startsWith('-')) {
					deletions += 1
					fileForRow().deletions += 1
					rows.push({ kind: 'del', text: line.slice(1), oldNo, newNo: '', file: index })
					oldNo += 1
					continue
				}
				if (line.startsWith(' ')) {
					fileForRow()
					rows.push({ kind: 'context', text: line.slice(1), oldNo, newNo, file: index })
					oldNo += 1
					newNo += 1
					continue
				}
				if (line === '') continue
				fileForRow()
				rows.push({ kind: 'context', text: line, oldNo: '', newNo: '', file: index })
			}
			return { rows, files, truncated, additions, deletions }
		}

		/**
		 * The character range that differs between a deleted line and the added
		 * line it was edited into. Equal prefixes and suffixes are left alone; only
		 * what actually moved gets the stronger wash.
		 * @param {string} oldText - the deleted line.
		 * @param {string} newText - the added line.
		 * @returns {{old: number[], new: number[]}|null} half-open ranges, or null.
		 */
		function wordDiff(oldText, newText) {
			const before = String(oldText ?? '')
			const after = String(newText ?? '')
			if (before === after || before.length > 4000 || after.length > 4000) return null
			let start = 0
			const shortest = Math.min(before.length, after.length)
			while (start < shortest && before[start] === after[start]) start += 1
			let beforeEnd = before.length
			let afterEnd = after.length
			while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
				beforeEnd -= 1
				afterEnd -= 1
			}
			// Only whitespace in common is not an anchor: two unrelated lines that
			// happen to share indentation must not get a full-line wash.
			const anchored =
				/[^\s]/u.test(before.slice(0, start)) ||
				/[^\s]/u.test(before.slice(beforeEnd)) ||
				/[^\s]/u.test(after.slice(afterEnd))
			if (!anchored) return null
			while (start < beforeEnd && start < afterEnd && /\s/u.test(before[start]) && /\s/u.test(after[start])) {
				start += 1
			}
			while (beforeEnd > start && afterEnd > start && /\s/u.test(before[beforeEnd - 1]) && /\s/u.test(after[afterEnd - 1])) {
				beforeEnd -= 1
				afterEnd -= 1
			}
			if (start >= beforeEnd && start >= afterEnd) return null
			return { old: [start, beforeEnd], new: [start, afterEnd] }
		}

		/** Extensions grouped by the colouring family below; first match wins. */
		const LANGUAGE_EXTENSIONS = {
			js: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'],
			json: ['json', 'jsonc', 'json5', 'webmanifest'],
			css: ['css', 'scss', 'sass', 'less', 'styl'],
			html: ['html', 'htm', 'xhtml', 'xml', 'svg', 'vue', 'svelte'],
			md: ['md', 'markdown', 'mdx'],
			py: ['py', 'pyi', 'pyw'],
			sh: ['sh', 'bash', 'zsh', 'fish', 'ksh'],
			yaml: ['yml', 'yaml'],
			sql: ['sql'],
			go: ['go'],
			rust: ['rs'],
			java: ['java', 'kt', 'kts', 'scala'],
			c: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm'],
		}

		/**
		 * The colouring family of a file.
		 * @param {string} path - repository-relative path.
		 * @returns {string} a key of `LANGUAGE_EXTENSIONS`, or `plain`.
		 */
		function languageOf(path) {
			const clean = String(path ?? '').replace(/\\/gu, '/')
			const base = clean.slice(clean.lastIndexOf('/') + 1).toLowerCase()
			const dot = base.lastIndexOf('.')
			if (dot < 0) return 'plain'
			const extension = base.slice(dot + 1)
			for (const [language, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
				if (extensions.includes(extension)) return language
			}
			return 'plain'
		}

		/** Keywords per colouring family. */
		const KEYWORDS = {
			js: new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield'.split(' ')),
			py: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self'.split(' ')),
			sh: new Set('case do done elif else esac fi for function if in local readonly return select then time until while export declare unset shift source set trap'.split(' ')),
			yaml: new Set('true false null yes no on off'.split(' ')),
			sql: new Set('select from where join left right inner outer full on group by order having limit offset insert into values update set delete create table alter drop index view as and or not null is in like between union all distinct case when then else end with returning'.split(' ')),
			go: new Set('package import func return if else for range switch case default break continue var const type struct interface map chan go defer select fallthrough goto'.split(' ')),
			rust: new Set('fn let mut const static struct enum impl trait for while loop match if else return use mod pub crate self super as move ref where async await unsafe extern type dyn'.split(' ')),
			java: new Set('public private protected class interface extends implements new return if else for while do switch case break continue static final void int long double float boolean char import package try catch finally throw throws this super null true false'.split(' ')),
			c: new Set('include define ifdef ifndef endif int char void long short float double struct union enum typedef static const return if else for while do switch case break continue goto sizeof unsigned signed extern volatile register'.split(' ')),
		}

		/**
		 * Colour one line. State carries block comments, HTML comments and code
		 * fences across lines, so a multi-line construct keeps its colour.
		 * @param {string} text - one line, without its diff prefix.
		 * @param {string} language - family from `languageOf`.
		 * @param {object} [state] - carry-over state from the previous line.
		 * @returns {{tokens: object[], state: object}} coloured segments and the next state.
		 */
		function tokenizeLine(text, language = 'plain', state = undefined) {
			const source = String(text ?? '')
			if (source === '') return { tokens: [], state: { ...(state ?? {}) } }
			if (language === 'json') return tokenizeJson(source)
			if (language === 'css') return tokenizeCss(source, state)
			if (language === 'html') return tokenizeHtml(source, state)
			if (language === 'md') return tokenizeMarkdown(source, state)
			if (language === 'yaml') return tokenizeYaml(source, state)
			return scanCode(source, language, state)
		}

		/** Generic C-like scanner: comments, strings, keywords, calls and numbers. */
		function scanCode(text, language, state) {
			const source = String(text)
			const keywords = KEYWORDS[language] ?? KEYWORDS.js
			const hashComments = language === 'py' || language === 'sh' || language === 'yaml'
			const slashComments = language === 'js' || language === 'c' || language === 'go' || language === 'rust' || language === 'java'
			const blockComments = language !== 'py' && language !== 'sh' && language !== 'yaml'
			const dollarVars = language === 'sh'
			const tokens = []
			let block = state?.block === true
			let index = 0
			let plain = 0
			const flush = (upTo) => {
				if (upTo > plain) tokens.push({ text: source.slice(plain, upTo), cls: '' })
			}
			if (block) {
				const end = source.indexOf('*/')
				if (end === -1) return { tokens: [{ text: source, cls: 'comment' }], state: { block: true } }
				tokens.push({ text: source.slice(0, end + 2), cls: 'comment' })
				index = end + 2
				plain = index
				block = false
			}
			while (index < source.length) {
				const char = source[index]
				const next = source[index + 1]
				if (blockComments && char === '/' && next === '*') {
					flush(index)
					const end = source.indexOf('*/', index + 2)
					if (end === -1) {
						tokens.push({ text: source.slice(index), cls: 'comment' })
						return { tokens, state: { block: true } }
					}
					tokens.push({ text: source.slice(index, end + 2), cls: 'comment' })
					index = end + 2
					plain = index
					continue
				}
				if (slashComments && char === '/' && next === '/') {
					flush(index)
					tokens.push({ text: source.slice(index), cls: 'comment' })
					return { tokens, state: { block: false } }
				}
				if (language === 'sql' && char === '-' && next === '-') {
					flush(index)
					tokens.push({ text: source.slice(index), cls: 'comment' })
					return { tokens, state: { block: false } }
				}
				if (hashComments && char === '#') {
					flush(index)
					tokens.push({ text: source.slice(index), cls: 'comment' })
					return { tokens, state: { block: false } }
				}
				if (dollarVars && char === '$' && next !== undefined && /[A-Za-z_{]/u.test(next)) {
					const variable = /^\$\{[^}]*\}|^\$[A-Za-z_][\w]*/u.exec(source.slice(index))
					if (variable !== null) {
						flush(index)
						tokens.push({ text: variable[0], cls: 'type' })
						index += variable[0].length
						plain = index
						continue
					}
				}
				if (char === '"' || char === "'" || (char === '`' && language === 'js')) {
					flush(index)
					let cursor = index + 1
					while (cursor < source.length) {
						if (source[cursor] === '\\') {
							cursor += 2
							continue
						}
						if (source[cursor] === char) {
							cursor += 1
							break
						}
						cursor += 1
					}
					const end = Math.min(cursor, source.length)
					tokens.push({ text: source.slice(index, end), cls: 'string' })
					index = end
					plain = index
					continue
				}
				if (/[A-Za-z_$]/u.test(char) && !/[\w$]/u.test(source[index - 1] ?? '')) {
					const word = /^[A-Za-z_$][\w$]*/u.exec(source.slice(index))[0]
					const remainder = source.slice(index + word.length)
					const isCall = /^\s*\(/u.test(remainder)
					const isType = language === 'js' && /^[A-Z][A-Za-z0-9_$]*$/u.test(word)
					const cls = keywords.has(word) ? 'keyword' : isCall ? 'func' : isType ? 'type' : ''
					if (cls !== '') {
						flush(index)
						tokens.push({ text: word, cls })
						plain = index + word.length
					}
					index += word.length
					continue
				}
				if (/[0-9]/u.test(char) && !/[\w$]/u.test(source[index - 1] ?? '')) {
					const number = /^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(index))
					if (number !== null) {
						flush(index)
						tokens.push({ text: number[0], cls: 'number' })
						index += number[0].length
						plain = index
						continue
					}
				}
				index += 1
			}
			flush(source.length)
			return { tokens, state: { block: false } }
		}

		/** JSON: keys, strings, numbers and the three literals. */
		function tokenizeJson(text) {
			const source = String(text)
			const tokens = []
			let index = 0
			let plain = 0
			const flush = (upTo) => {
				if (upTo > plain) tokens.push({ text: source.slice(plain, upTo), cls: '' })
			}
			while (index < source.length) {
				const char = source[index]
				if (char === '"') {
					let cursor = index + 1
					while (cursor < source.length) {
						if (source[cursor] === '\\') cursor += 2
						else if (source[cursor] === '"') {
							cursor += 1
							break
						} else cursor += 1
					}
					const end = Math.min(cursor, source.length)
					flush(index)
					tokens.push({ text: source.slice(index, end), cls: /^\s*:/u.test(source.slice(end)) ? 'key' : 'string' })
					index = end
					plain = index
					continue
				}
				if (/[0-9-]/u.test(char) && (index === 0 || /[\s:,[{]/u.test(source[index - 1]))) {
					const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(index))
					if (number !== null) {
						flush(index)
						tokens.push({ text: number[0], cls: 'number' })
						index += number[0].length
						plain = index
						continue
					}
				}
				if (/[A-Za-z]/u.test(char)) {
					const word = /^[A-Za-z]+/u.exec(source.slice(index))[0]
					if (word === 'true' || word === 'false' || word === 'null') {
						flush(index)
						tokens.push({ text: word, cls: 'keyword' })
						index += word.length
						plain = index
						continue
					}
				}
				index += 1
			}
			flush(source.length)
			return { tokens, state: {} }
		}

		/** CSS: selectors stay plain; properties, values and at-rules get colour. */
		function tokenizeCss(text, state) {
			const source = String(text)
			const tokens = []
			let index = 0
			let plain = 0
			let blocked = state?.block === true
			const flush = (upTo) => {
				if (upTo > plain) tokens.push({ text: source.slice(plain, upTo), cls: '' })
			}
			if (blocked) {
				const end = source.indexOf('*/')
				if (end === -1) return { tokens: [{ text: source, cls: 'comment' }], state: { block: true } }
				tokens.push({ text: source.slice(0, end + 2), cls: 'comment' })
				index = end + 2
				plain = index
				blocked = false
			}
			// Only a line that starts fresh can open with a declaration; a line that
			// began inside a block comment above must not repeat its own prefix.
			const property = index === 0 ? /^(\s*)(--?[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)(\s*:)/u.exec(source) : null
			if (property !== null) {
				tokens.push({ text: property[1], cls: '' })
				tokens.push({ text: property[2], cls: 'key' })
				tokens.push({ text: property[3], cls: '' })
				index = property[0].length
				plain = index
			}
			while (index < source.length) {
				const char = source[index]
				const next = source[index + 1]
				if (char === '/' && next === '*') {
					flush(index)
					const end = source.indexOf('*/', index + 2)
					if (end === -1) {
						tokens.push({ text: source.slice(index), cls: 'comment' })
						return { tokens, state: { block: true } }
					}
					tokens.push({ text: source.slice(index, end + 2), cls: 'comment' })
					index = end + 2
					plain = index
					continue
				}
				if (char === '"' || char === "'") {
					flush(index)
					let cursor = index + 1
					while (cursor < source.length) {
						if (source[cursor] === '\\') cursor += 2
						else if (source[cursor] === char) {
							cursor += 1
							break
						} else cursor += 1
					}
					const end = Math.min(cursor, source.length)
					tokens.push({ text: source.slice(index, end), cls: 'string' })
					index = end
					plain = index
					continue
				}
				if (char === '@') {
					const at = /^@[A-Za-z-]+/u.exec(source.slice(index))
					if (at !== null) {
						flush(index)
						tokens.push({ text: at[0], cls: 'keyword' })
						index += at[0].length
						plain = index
						continue
					}
				}
				if (char === '!' && source.startsWith('!important', index)) {
					flush(index)
					tokens.push({ text: '!important', cls: 'keyword' })
					index += '!important'.length
					plain = index
					continue
				}
				if (char === '#') {
					const hex = /^#[\da-fA-F]{3,8}/u.exec(source.slice(index))
					if (hex !== null) {
						flush(index)
						tokens.push({ text: hex[0], cls: 'number' })
						index += hex[0].length
						plain = index
						continue
					}
				}
				if (/[0-9]/u.test(char) && !/[\w$]/u.test(source[index - 1] ?? '')) {
					const number = /^\d*\.?\d+(?:[a-zA-Z%]+)?/u.exec(source.slice(index))
					if (number !== null) {
						flush(index)
						tokens.push({ text: number[0], cls: 'number' })
						index += number[0].length
						plain = index
						continue
					}
				}
				index += 1
			}
			flush(source.length)
			return { tokens, state: { block: false } }
		}

		/** HTML/XML: tags, attribute names and their values. */
		function tokenizeHtml(text, state) {
			const source = String(text)
			const tokens = []
			let index = 0
			let plain = 0
			let inComment = state?.comment === true
			const flush = (upTo) => {
				if (upTo > plain) tokens.push({ text: source.slice(plain, upTo), cls: '' })
			}
			if (inComment) {
				const end = source.indexOf('-->')
				if (end === -1) return { tokens: [{ text: source, cls: 'comment' }], state: { comment: true } }
				tokens.push({ text: source.slice(0, end + 3), cls: 'comment' })
				index = end + 3
				plain = index
				inComment = false
			}
			while (index < source.length) {
				if (source.startsWith('<!--', index)) {
					flush(index)
					const end = source.indexOf('-->', index + 4)
					if (end === -1) {
						tokens.push({ text: source.slice(index), cls: 'comment' })
						return { tokens, state: { comment: true } }
					}
					tokens.push({ text: source.slice(index, end + 3), cls: 'comment' })
					index = end + 3
					plain = index
					continue
				}
				if (source[index] === '<' && /[A-Za-z/!]/u.test(source[index + 1] ?? '')) {
					flush(index)
					let cursor = index + (source[index + 1] === '/' ? 2 : 1)
					const name = /^[A-Za-z][\w:-]*/u.exec(source.slice(cursor))
					tokens.push({ text: source.slice(index, cursor), cls: '' })
					if (name !== null) {
						tokens.push({ text: name[0], cls: 'tag' })
						cursor += name[0].length
					}
					while (cursor < source.length && source[cursor] !== '>') {
						const attribute = /^\s+[A-Za-z_:][\w:.-]*/u.exec(source.slice(cursor))
						if (attribute !== null) {
							const gap = /^(\s+)([A-Za-z_:][\w:.-]*)/u.exec(attribute[0])
							if (gap !== null) {
								tokens.push({ text: gap[1], cls: '' })
								tokens.push({ text: gap[2], cls: 'attr' })
							}
							cursor += attribute[0].length
							continue
						}
						const quote = source[cursor]
						if (quote === '"' || quote === "'") {
							let endQuote = cursor + 1
							while (endQuote < source.length && source[endQuote] !== quote) endQuote += 1
							endQuote = Math.min(endQuote + 1, source.length)
							tokens.push({ text: source.slice(cursor, endQuote), cls: 'string' })
							cursor = endQuote
							continue
						}
						tokens.push({ text: source[cursor], cls: '' })
						cursor += 1
					}
					if (cursor < source.length) {
						tokens.push({ text: '>', cls: '' })
						cursor += 1
					}
					index = cursor
					plain = index
					continue
				}
				index += 1
			}
			flush(source.length)
			return { tokens, state: { comment: false } }
		}

		/** Markdown: headings, fenced blocks and inline code. */
		function tokenizeMarkdown(text, state) {
			const source = String(text)
			if (state?.fence === true) {
				if (/^\s*```/u.test(source)) return { tokens: [{ text: source, cls: 'comment' }], state: { fence: false } }
				return { tokens: [{ text: source, cls: 'code' }], state: { fence: true } }
			}
			if (/^\s*```/u.test(source)) return { tokens: [{ text: source, cls: 'comment' }], state: { fence: true } }
			if (/^#{1,6}\s/u.test(source)) return { tokens: [{ text: source, cls: 'heading' }], state: { fence: false } }
			const tokens = []
			let index = 0
			const regex = /`[^`]*`/gu
			let match
			while ((match = regex.exec(source)) !== null) {
				if (match.index > index) tokens.push({ text: source.slice(index, match.index), cls: '' })
				tokens.push({ text: match[0], cls: 'code' })
				index = match.index + match[0].length
			}
			if (index < source.length) tokens.push({ text: source.slice(index), cls: '' })
			return { tokens, state: { fence: false } }
		}

		/** YAML: the key before the colon, then the generic scanner for the value. */
		function tokenizeYaml(text, state) {
			const source = String(text)
			const key = /^(\s*(?:-\s+)?)([A-Za-z_$][\w.$-]*)(\s*:)(.*)$/u.exec(source)
			if (key === null) return scanCode(source, 'yaml', state)
			const rest = scanCode(key[4], 'yaml', state)
			return {
				tokens: [{ text: key[1], cls: '' }, { text: key[2], cls: 'key' }, { text: key[3], cls: '' }, ...rest.tokens],
				state: rest.state,
			}
		}

		/**
		 * Five overview blocks, the GitHub way of showing the add/delete mix.
		 * @param {number} additions - added line count.
		 * @param {number} deletions - deleted line count.
		 * @param {number} [count] - number of blocks.
		 * @returns {string[]} `add` / `del` per block.
		 */
		function diffStatBlocks(additions, deletions, count = 5) {
			const adds = Math.max(0, Number(additions) || 0)
			const dels = Math.max(0, Number(deletions) || 0)
			if (adds + dels === 0) return []
			let addBlocks = Math.round((adds / (adds + dels)) * count)
			if (adds > 0 && addBlocks === 0) addBlocks = 1
			if (dels > 0 && addBlocks === count) addBlocks = count - 1
			return Array.from({ length: count }, (_, index) => (index < addBlocks ? 'add' : 'del'))
		}


		/* ------------------------------------------------------------------ */
		/* Graph lanes                                                        */
		/* ------------------------------------------------------------------ */

		/** Colour of one lane, cycling the palette. */
		const laneColor = (index) => LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]

		/**
		 * Assign lanes to commits, gitk-style.
		 *
		 * A lane holds the hash it expects next. A commit takes the lane already
		 * waiting for it (or opens one), leaves its first parent there, and puts any
		 * further parent into a free lane. The result is what the SVG needs: the
		 * lane of every row, and the edges crossing it.
		 * @param {object[]} commits - commits in git's order.
		 * @returns {{rows: object[], laneCount: number}} laid-out rows.
		 */
		function layoutGraph(commits) {
			const rows = []
			let lanes = []
			/**
			 * Palette colour of each lane's *lineage*, parallel to `lanes`.
			 *
			 * Colour used to be `laneColor(index)`, i.e. a function of the lane
			 * number. Since lanes compact when a branch ends, one branch changed
			 * colour mid-line (measured: 0.44–1.36% of edges), and two branches that
			 * reached the same index shared a colour. Keeping the colour with the
			 * lane slot instead makes it follow the branch and survive compaction.
			 */
			let colors = []
			let colorSeq = 0
			let laneCount = 0
			const takeColor = () => LANE_COLORS[colorSeq++ % LANE_COLORS.length]

			for (const commit of commits) {
				let index = lanes.indexOf(commit.hash)
				// A commit that a lane already waits for is drawn with an incoming
				// segment from the top of the row; one that opens a new lane is not,
				// or every graph would start with a line running into nowhere.
				const arrived = index !== -1
				if (index === -1) {
					index = lanes.length
					lanes = lanes.concat([commit.hash])
					colors = colors.concat([takeColor()])
				}
				const before = lanes
				const beforeColors = colors
				const next = before.slice()
				const nextColors = beforeColors.slice()
				const firstParent = commit.parents.length > 0 ? commit.parents[0] : null
				// A first parent that another lane already waits for must not open a
				// second lane for the same hash: duplicates gave one commit two lines
				// in two colours, and `after.indexOf` then resolved to the wrong one.
				next[index] = firstParent !== null && next.some((hash, lane) => lane !== index && hash === firstParent) ? null : firstParent
				for (const parent of commit.parents.slice(1)) {
					if (next.includes(parent)) continue
					const free = next.indexOf(null)
					if (free === -1) {
						next.push(parent)
						nextColors.push(takeColor())
					} else {
						next[free] = parent
						nextColors[free] = takeColor()
					}
				}
				// Nulls compact, and the colours compact with them.
				const after = []
				const afterColors = []
				for (let lane = 0; lane < next.length; lane += 1) {
					if (next[lane] === null) continue
					after.push(next[lane])
					afterColors.push(nextColors[lane])
				}

				const edges = []
				// Lanes that merely pass through this row keep their line; when a
				// previous row reordered them, the target is where they now sit.
				for (let lane = 0; lane < before.length; lane += 1) {
					if (lane === index) continue
					const target = after.indexOf(before[lane])
					if (target === -1) continue
					edges.push({ from: lane, to: target, color: beforeColors[lane], commitEdge: false, hash: before[lane] })
				}
				for (const parent of commit.parents) {
					const target = after.indexOf(parent)
					if (target === -1) continue
					// Take the colour of the lane the parent lands in, not the merge's
					// own: a fan-out then splits into branch colours on this row instead
					// of staying one colour until the next row.
					edges.push({ from: index, to: target, color: afterColors[target] ?? beforeColors[index], commitEdge: true, hash: parent })
				}

				laneCount = Math.max(laneCount, before.length, after.length)
				const current = Array.isArray(commit.refs) && commit.refs.some((ref) => ref.kind === 'head')
				rows.push({ commit, lane: index, color: beforeColors[index], current, arrived, edges })
				lanes = after
				colors = afterColors
			}
			return { rows, laneCount }
		}

		/* ------------------------------------------------------------------ */
		/* Icons                                                              */
		/* ------------------------------------------------------------------ */

		const iconProps = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }
		/** Same canvas, heavier line: the 11–14px glyphs would smear at 1.4. */
		const glyphProps = { ...iconProps, strokeWidth: 1.75 }

		const BranchIcon = (props) =>
			h(
				'svg',
				{ ...iconProps, width: props?.size ?? 13, height: props?.size ?? 13 },
				h('circle', { cx: 4.5, cy: 12, r: 1.7 }),
				h('circle', { cx: 4.5, cy: 4, r: 1.7 }),
				h('circle', { cx: 11.5, cy: 6.5, r: 1.7 }),
				h('path', { d: 'M4.5 5.7v4.6' }),
				h('path', { d: 'M11.5 8.2c0 1.7-1.4 2.2-3.4 2.5' }),
			)

		const ChevronIcon = (props) => h('svg', { ...iconProps, width: 12, height: 12, className: props?.className }, h('path', { d: 'M6 3.5 10.5 8 6 12.5' }))
		const RefreshIcon = () => h('svg', iconProps, h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.9-4.2' }), h('path', { d: 'M13.5 2v3.2h-3.2' }))
		/** Two arrows around a circle: fetch + pull + push, one verb. */
		const SyncIcon = () =>
			h(
				'svg',
				glyphProps,
				h('path', { d: 'M2.6 8a5.4 5.4 0 0 1 9.2-3.8' }),
				h('path', { d: 'M13.4 8a5.4 5.4 0 0 1-9.2 3.8' }),
				h('path', { d: 'M12.4 1.6v2.9H9.5' }),
				h('path', { d: 'M3.6 14.4v-2.9h2.9' }),
			)
		/** The graph's refs filter: a lane that forks. */
		const GraphRefsIcon = () =>
			h(
				'svg',
				glyphProps,
				h('circle', { cx: 4, cy: 3.4, r: 1.5 }),
				h('circle', { cx: 4, cy: 12.6, r: 1.5 }),
				h('circle', { cx: 11.8, cy: 8, r: 1.5 }),
				h('path', { d: 'M4 4.9v6.2' }),
				h('path', { d: 'M5.3 7.1c2.5 0 3.5.4 5 1' }),
			)
		const PlusIcon = () => h('svg', iconProps, h('path', { d: 'M8 3v10M3 8h10' }))
		const MinusIcon = () => h('svg', iconProps, h('path', { d: 'M3 8h10' }))
		const UndoIcon = () => h('svg', iconProps, h('path', { d: 'M3 8a5 5 0 1 1 1.6 3.7' }), h('path', { d: 'M3 3.6V8h4.4' }))
		const DiffIcon = () => h('svg', iconProps, h('path', { d: 'M4 2.5v6' }), h('path', { d: 'M2 5.5h4' }), h('path', { d: 'M10 10.5h4' }), h('path', { d: 'M2.5 13.5h11' }))
		const FileIcon = () => h('svg', iconProps, h('path', { d: 'M9 1.8H4.4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5.3z' }), h('path', { d: 'M9 1.8v3.5h3.6' }))

		/**
		 * Which icon a path gets.
		 *
		 * The table is generated from Material Icon Theme: an exact filename wins
		 * (`package.json` gets the Node icon, not the JSON one), then the longest
		 * dotted suffix (`foo.d.ts` tries `d.ts` before `ts`), then the generic page.
		 * @param {string} path - repository-relative path.
		 * @returns {string} icon name known to `FILE_ICON_SVGS`.
		 */
		function fileIconFor(path) {
			const clean = String(path ?? '').replace(/\\/gu, '/')
			const base = clean.slice(clean.lastIndexOf('/') + 1).toLowerCase()
			if (base === '') return 'file'
			const byName = FILE_ICON_BY_NAME[base]
			if (byName !== undefined) return byName
			let dot = base.indexOf('.', 1)
			while (dot !== -1) {
				const byExtension = FILE_ICON_BY_EXTENSION[base.slice(dot + 1)]
				if (byExtension !== undefined) return byExtension
				dot = base.indexOf('.', dot + 1)
			}
			return 'file'
		}

		/** The file-type icon; the change chip sits on the right. */
		function FileTypeIcon({ path }) {
			const icon = FILE_ICON_SVGS[fileIconFor(path)] ?? FILE_ICON_SVGS.file
			return h(
				'span',
				{ className: 'gp-ftype' },
				h('svg', { viewBox: icon[0], width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false', dangerouslySetInnerHTML: { __html: icon[1] } }),
			)
		}

		/**
		 * One change kind per status entry.
		 *
		 * Porcelain v2 says "untracked" with `??` and "conflict" with an `u`
		 * record inside the two-letter code; both carry the letter `U`, so the
		 * code decides between them instead of the letter.
		 * @param {object} entry - status row.
		 * @param {string} [group] - section id; the conflicts list forces the alert.
		 * @returns {string} `M A U D R C T CONFLICT`.
		 */
		function changeKindOf(entry, group) {
			if (group === 'conflicts') return 'CONFLICT'
			const code = String(entry?.code ?? '')
			if (code === '??') return 'U'
			const letter = String(entry?.letter ?? '').toUpperCase()
			if (letter === 'U') return 'CONFLICT'
			if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'R' || letter === 'C' || letter === 'T') return letter
			// Anything else (a mode change on a file already listed as M, or a row
			// built from a commit's name-status) reads as a modification.
			return 'M'
		}

		/**
		 * Image formats the Sidebar's document preview renders in place.
		 *
		 * Wider than "this gets a picture icon": `.psd`, `.tiff`, `.heic` and
		 * friends keep the image icon but would only reach an unsupported page
		 * in the previewer, so their rows keep the diff instead.
		 */
		const PREVIEWABLE_IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/iu

		/**
		 * Whether a change row opens the file itself instead of a diff.
		 *
		 * An image has no readable patch — git answers "binary" and the diff tab
		 * only says so. Clicking such a row opens the Sidebar's document preview,
		 * which draws the image in place. A deleted image keeps the diff: the
		 * work-tree file is gone, so there is nothing to draw.
		 * @param {object} entry - status row.
		 * @param {string} [group] - section id.
		 * @returns {boolean} true when the row opens the previewer.
		 */
		function previewsAsImage(entry, group) {
			if (group === 'conflicts') return false
			const path = typeof entry?.path === 'string' ? entry.path : ''
			if (path === '' || PREVIEWABLE_IMAGE.test(path) !== true) return false
			return changeKindOf(entry, group) !== 'D'
		}

		/**
		 * The one-letter badge the Source Control view uses to say *how* a file
		 * changed: `M` modified, `A` added, `U` untracked, `D` deleted, `R`
		 * renamed, `C` copied, `T` type changed, `!` conflicted. Colour carries
		 * the state, not a pill behind it.
		 * @param {object} props - `entry`, the translator, and the section id.
		 * @returns {object} the badge.
		 */
		function ChangeBadge({ entry, t, group }) {
			const kind = changeKindOf(entry, group)
			const key = kind === 'CONFLICT' ? 'change.conflict' : `change.${kind}`
			const renamedFrom = kind === 'R' && typeof entry?.originalPath === 'string' && entry.originalPath !== '' ? entry.originalPath : ''
			const label = renamedFrom === '' ? t(key) : `${t(key)} · ${renamedFrom}`
			const letter = kind === 'CONFLICT' ? '!' : kind
			return h('span', { className: `gp-change ${kind}`, title: label, role: 'img', 'aria-label': label }, letter)
		}

		const TrashIcon = () => h('svg', iconProps, h('path', { d: 'M2.8 4.4h10.4' }), h('path', { d: 'M6.4 4.4V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.2' }), h('path', { d: 'M4.2 4.4l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2' }))
		const CloudIcon = () => h('svg', iconProps, h('path', { d: 'M4.4 11.6a2.6 2.6 0 0 1-.3-5.2 3.6 3.6 0 0 1 6.9-.7 2.6 2.6 0 0 1 1 5.9z' }))
		const CaretIcon = () => h('svg', { ...iconProps, width: 12, height: 12 }, h('path', { d: 'M4 6.5 8 10.5l4-4' }))
		const CopyIcon = () => h('svg', iconProps, h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.4 }), h('path', { d: 'M10.5 3.6V2.9a1 1 0 0 0-1-1H2.9a1 1 0 0 0-1 1v6.6a1 1 0 0 0 1 1h.7' }))
		const CheckIcon = () => h('svg', iconProps, h('path', { d: 'M3 8.4 6.3 11.7 13 4.6' }))
		const ImageIcon = () =>
			h('svg', glyphProps, h('rect', { x: 2.4, y: 3.2, width: 11.2, height: 9.6, rx: 2 }), h('circle', { cx: 6, cy: 6.7, r: 1 }), h('path', { d: 'M3.4 11.6 6.9 8.6l2.1 1.8 2-1.7 1.6 1.4' }))
		/** Route-error marker; the same triangle Source Control uses for conflicts. */
		const ChangeConflictIcon = () =>
			h('svg', glyphProps, h('path', { d: 'M8 2.6 13.6 12.6H2.4z' }), h('path', { d: 'M8 6.2v2.6' }), h('circle', { cx: 8, cy: 10.9, r: 0.6, fill: 'currentColor', stroke: 'none' }))
		const ChatIcon = () =>
			h('svg', iconProps, h('path', { d: 'M13.4 8.4c0 2.6-2.4 4.7-5.4 4.7-.7 0-1.4-.1-2-.3L3 13.8l1.2-2.3A4.4 4.4 0 0 1 2.6 8.4C2.6 5.8 5 3.7 8 3.7s5.4 2.1 5.4 4.7Z' }))
		const SparkleIcon = () =>
			h(
				'svg',
				iconProps,
				h('path', { d: 'M6.6 2.2 7.9 5.5 11.2 6.8 7.9 8.1 6.6 11.4 5.3 8.1 2 6.8 5.3 5.5Z' }),
				h('path', { d: 'M12.2 9.6l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6Z' }),
			)

		/** The guide-page glyph: the Sidebar's own artwork size contract. */
		function GitGuideIcon(props) {
			const size = props?.size ?? 20
			return h(
				'svg',
				{ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
				h('circle', { cx: 6.5, cy: 18, r: 2.4 }),
				h('circle', { cx: 6.5, cy: 6, r: 2.4 }),
				h('circle', { cx: 17.5, cy: 9, r: 2.4 }),
				h('path', { d: 'M6.5 8.4v7.2' }),
				h('path', { d: 'M17.5 11.4c0 2.6-2.2 3.3-5.4 3.8' }),
			)
		}

		/* ------------------------------------------------------------------ */
		/* Hooks                                                              */
		/* ------------------------------------------------------------------ */

		/**
		 * Read the Session's working directory with the slot's session selector.
		 * The selector hook is always called: the slot supplies it for every
		 * session-scoped body, so the call order never changes between renders.
		 * @param {Function} useSessions - session list selector hook from the slot.
		 * @param {string} sessionId - Session on screen.
		 * @returns {string | undefined} absolute cwd.
		 */
		function useSessionCwd(useSessions, sessionId) {
			const select = useSessions((sessions) => {
				const entry = sessions?.byId?.[sessionId]
				return entry?.cwd
			})
			return select
		}

		/**
		 * Poll one Host action while the panel is visible.
		 * @param {string | undefined} cwd - repository directory.
		 * @param {string} action - route action.
		 * @param {object} params - extra fields.
		 * @param {object} options - `enabled`, `poll`, `version`.
		 * @returns {{value: object|undefined, error: Error|undefined, loading: boolean, refresh: Function}} state.
		 */
		function useRoute(cwd, action, params, options = {}) {
			const { enabled = true, poll = 0, version = 0 } = options
			const [value, setValue] = useState(undefined)
			const [error, setError] = useState(undefined)
			const [loading, setLoading] = useState(false)
			const signature = JSON.stringify(params ?? {})
			const signatureRef = useRef(signature)
			signatureRef.current = signature
			/**
			 * Request tickets.
			 *
			 * A poll that started before a write resolved must not paint its older
			 * answer over the status that write already returned, so a response only
			 * lands when its ticket is the newest one issued.
			 */
			const startedRef = useRef(0)
			const appliedRef = useRef(0)

			const load = useCallback(
				async (signal, silent, force) => {
					if (cwd === undefined || cwd === '' || enabled !== true) return undefined
					const ticket = (startedRef.current += 1)
					if (silent !== true) setLoading(true)
					try {
						const body = { cwd, ...(params ?? {}) }
						// An explicit refresh must not be answered from the Host's short
						// read cache: a click that changes nothing reads as a broken button.
						if (force === true) body.force = true
						const next = await call(action, body, signal)
						if (ticket >= appliedRef.current) {
							appliedRef.current = ticket
							setValue(next)
							setError(undefined)
						}
						return next
					} catch (failure) {
						if (signal?.aborted === true) return undefined
						if (silent !== true) setError(failure)
						return undefined
					} finally {
						if (signal?.aborted !== true && silent !== true) setLoading(false)
					}
				},
				// The signature is the stable identity of `params`.
				// eslint-disable-next-line react-hooks/exhaustive-deps
				[cwd, action, enabled, signature, version],
			)

			useEffect(() => {
				const controller = new AbortController()
				load(controller.signal, false)
				return () => controller.abort()
			}, [load])

			useEffect(() => {
				if (poll <= 0 || enabled !== true) return undefined
				const tick = () => {
					if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
					const controller = new AbortController()
					load(controller.signal, true)
				}
				const timer = setInterval(tick, poll)
				const onFocus = () => tick()
				// A tab that comes back must not wait for the next tick to be current.
				const onVisible = () => {
					if (typeof document !== 'undefined' && document.visibilityState === 'visible') tick()
				}
				window.addEventListener('focus', onFocus)
				document.addEventListener('visibilitychange', onVisible)
				return () => {
					clearInterval(timer)
					window.removeEventListener('focus', onFocus)
					document.removeEventListener('visibilitychange', onVisible)
				}
			}, [load, poll, enabled])

			/** Install a value the Host already produced, beating any in-flight poll. */
			const replace = useCallback((next) => {
				appliedRef.current = (startedRef.current += 1)
				setValue(next)
				setError(undefined)
			}, [])

			const refresh = useCallback(
				(silent, refreshOptions) => {
					const controller = new AbortController()
					return load(controller.signal, silent === true, refreshOptions?.force === true)
				},
				[load],
			)

			return { value, error, loading, refresh, replace }
		}

		/* ------------------------------------------------------------------ */
		/* Shared little components                                            */
		/* ------------------------------------------------------------------ */

		/**
		 * A ghost icon button with an accessible label.
		 *
		 * `busy` swaps the glyph for a spinner in place: the button that was clicked
		 * is where the answer has to appear, not a spinner somewhere else on the
		 * pane. The width is reserved by the CSS so the header does not jump.
		 */
		function IconButton({ label, onClick, disabled, danger, active, busy, className, children }) {
			return h(
				'button',
				{
					type: 'button',
					className: `gp-btn${danger === true ? ' gp-btn-danger' : ''}${active === true ? ' active' : ''}${busy === true ? ' gp-btn-busy' : ''}${typeof className === 'string' ? ` ${className}` : ''}`,
					title: label,
					'aria-label': label,
					'aria-busy': busy === true ? true : undefined,
					'aria-pressed': active === undefined ? undefined : active === true,
					disabled: disabled === true || busy === true,
					onClick: (event) => {
						event.stopPropagation()
						onClick?.(event)
					},
				},
				busy === true ? h('span', { className: 'gp-spinner' }) : children,
			)
		}

		/**
		 * The thin line under the graph header that says a repository verb is
		 * running and for how long.
		 *
		 * `git fetch`/`pull` take seconds and the Host answers in one JSON body, so
		 * there is no percentage to show. A count of elapsed seconds is the honest
		 * substitute: it proves the click registered without inventing progress. The
		 * clock lives in this leaf component, so ticking it re-renders the line and
		 * nothing else.
		 */
		function ProgressStrip({ label, since }) {
			const [now, setNow] = useState(() => Date.now())
			useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 200)
				return () => clearInterval(timer)
			}, [])
			const seconds = Math.max(0, (now - since) / 1000)
			return h(
				'div',
				{ className: 'gp-progress', role: 'status', 'aria-live': 'polite' },
				h('span', { className: 'gp-spinner' }),
				h('span', { className: 'gp-progress-text' }, label),
				h('span', { className: 'gp-progress-time' }, `${seconds.toFixed(1)}s`),
			)
		}

		/**
		 * One collapsible section header.
		 *
		 * The collapse hit area is the label cluster only (chevron, title, count),
		 * not the whole row: the right side now hosts real controls — the branch
		 * menu and the repo verbs on the graph header — and a full-row toggle
		 * would fire when the user aimed at them.
		 */
		function SectionHeader({ title, count, expanded, onToggle, actions, t, variant }) {
			const label = expanded === true ? t('changes.collapse') : t('changes.expand')
			return h(
				'div',
				{ className: `gp-section-head${variant === 'graph' ? ' gp-section-head-graph' : ''}` },
				h(
					'div',
					{
						className: 'gp-section-toggle',
						role: 'button',
						tabIndex: 0,
						'aria-expanded': expanded === true,
						title: label,
						onClick: onToggle,
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault()
								onToggle?.()
							}
						},
					},
					h(ChevronIcon, { className: `gp-chevron${expanded ? ' open' : ''}` }),
					h('span', { className: 'gp-section-title' }, title),
					count === undefined ? null : h('span', { className: 'gp-section-count' }, String(count)),
				),
				h('div', { className: 'gp-section-actions' }, actions),
			)
		}

		/**
		 * A menu anchored to its own trigger button.
		 * @param {object} props - `label` (trigger content), `items`, `disabled`,
		 *   `triggerClass`, `title` and `t`.
		 * @returns {object} the trigger and, while open, its menu.
		 */
		/** One group of rows (staged / unstaged / untracked / conflicts). */
		function ChangeRow({ entry, group, busy, t, onOpenDiff, onOpenFile, onStage, onUnstage, onDiscard, onQuote }) {
			const { dir, name } = splitPath(entry.path)
			const image = previewsAsImage(entry, group)
			const select = () => (image ? onOpenFile(entry) : onOpenDiff(entry, group))
			const showCounts = entry.additions > 0 || entry.deletions > 0
			const conflicted = group === 'conflicts'
			const kind = changeKindOf(entry, group)
			return h(
				'div',
				{
					className: `gp-row${conflicted ? ' gp-row-conflict' : ''}${kind === 'D' ? ' gp-row-deleted' : ''}`,
					title: conflicted ? `${entry.path} · ${t('conflict.badge')}` : entry.path,
					role: 'button',
					tabIndex: 0,
					onClick: select,
					onKeyDown: (event) => (event.key === 'Enter' ? select() : undefined),
				},
				h(FileTypeIcon, { path: entry.path }),
				h('span', { className: 'gp-name' }, dir === '' ? null : h('span', { className: 'gp-dir' }, dir), name),
				showCounts
					? h(
							'span',
							{ className: 'gp-counts' },
							entry.additions > 0 ? h('span', { className: 'gp-add' }, `+${entry.additions}`) : null,
							entry.deletions > 0 ? h('span', { className: 'gp-del' }, `-${entry.deletions}`) : null,
						)
					: null,
				h(ChangeBadge, { entry, t, group }),
				h(
					'span',
					{ className: 'gp-row-actions' },
					conflicted
						? h(IconButton, { label: t('conflict.quote'), disabled: busy, onClick: () => onQuote(entry) }, h(ChatIcon, null))
						: group === 'staged'
							? h(IconButton, { label: t('row.unstage'), disabled: busy, onClick: () => onUnstage(entry) }, h(MinusIcon, null))
							: h(IconButton, { label: t('row.stage'), disabled: busy, onClick: () => onStage(entry) }, h(PlusIcon, null)),
					group === 'staged' || conflicted
						? null
						: h(IconButton, { label: t('row.discard'), disabled: busy, danger: true, onClick: () => onDiscard(entry, group) }, h(UndoIcon, null)),
					image
						? h(IconButton, { label: t('row.openImage'), onClick: () => onOpenFile(entry) }, h(ImageIcon, null))
						: h(IconButton, { label: t('row.openDiff'), onClick: () => onOpenDiff(entry, group) }, h(DiffIcon, null)),
					image ? null : h(IconButton, { label: t('row.openFile'), onClick: () => onOpenFile(entry) }, h(FileIcon, null)),
				),
			)
		}

		/* ------------------------------------------------------------------ */
		/* Changes                                                             */
		/* ------------------------------------------------------------------ */

		/** The commit box: message, primary action and its smaller options. */
		/**
		 * The commit box: message field, the full-width Commit button and its menu.
		 *
		 * The placeholder names the branch the commit will land on, and the button
		 * keeps its disabled look while there is nothing to commit.
		 * @param {object} props - slot props.
		 * @returns {object} the box.
		 */
		function CommitBox({ t, status, busy, onCommit }) {
			const [message, setMessage] = useState('')
			const counts = status?.counts ?? {}
			const staged = counts.staged ?? 0
			const changed = staged + (counts.changes ?? 0) + (counts.untracked ?? 0) + (counts.conflicts ?? 0)
			const hasStaged = staged > 0
			/** No change in the work tree: the primary action stays disabled. */
			const idle = changed === 0
			const conflicts = (status?.conflicts ?? []).length
			const merging = status?.merging === true
			/** Unresolved conflicts block the commit, exactly like a merge editor. */
			const blocked = conflicts > 0
			const branch = status?.detached === true ? String(status?.oid ?? '').slice(0, 7) || 'HEAD' : status?.branch || 'HEAD'
			const submit = (overrides) => {
				const text = message
				if (text.trim() === '' || idle || blocked) return
				onCommit({ message: text, stageAll: hasStaged !== true, ...(overrides ?? {}) })
					.then((done) => {
						if (done === true) setMessage('')
					})
					.catch(() => {})
			}

			/** Fill the field with a draft derived from the changed paths. */
			const draft = () => {
				const paths = [...(status?.staged ?? []), ...(status?.changes ?? []), ...(status?.untracked ?? [])].map((entry) => entry.path)
				if (paths.length === 0) return
				const name = String(paths[0]).split('/').pop() ?? paths[0]
				setMessage(paths.length === 1 ? fill(t('commit.draft.one'), { name }) : fill(t('commit.draft.many'), { name, count: paths.length - 1 }))
			}

			const placeholder = fill(t('commit.placeholder'), { mod: MOD_LABEL, branch })

			return h(
				'div',
				{ className: 'gp-compose' },
				h(
					'div',
					{ className: 'gp-input-wrap' },
					h('textarea', {
						className: 'gp-input',
						value: message,
						placeholder: placeholder,
						'aria-label': placeholder,
						rows: 3,
						onChange: (event) => setMessage(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
								event.preventDefault()
								submit()
							}
						},
					}),
					h('button', { type: 'button', className: 'gp-input-ai', title: t('commit.draft'), disabled: busy || idle, onClick: draft }, h(SparkleIcon, null)),
				),
				h(
					'div',
					{ className: 'gp-actions' },
					h(
						'button',
						{ type: 'button', className: 'gp-primary', title: t('commit.sync'), disabled: busy || idle || blocked, onClick: () => submit() },
						busy ? h('span', { className: 'gp-spinner' }) : h(CheckIcon, null),
						h('span', { className: 'gp-primary-label' }, merging ? t('commit.continue') : t('commit.button')),
					),
				),
			)
		}

		/* ------------------------------------------------------------------ */
		/* Commit detail                                                       */
		/* ------------------------------------------------------------------ */

		/** The panel under a graph row: full message, author, date and files. */
		function CommitDetail({ t, detail, loading, onOpenDiff, onCopy, onCheckout, copied }) {
			if (loading === true && detail === undefined) return h('div', { className: 'gp-detail gp-note' }, t('graph.loading'))
			const commit = detail?.commit
			if (commit === undefined) return null
			const files = Array.isArray(commit.files) ? commit.files : []
			return h(
				'div',
				{ className: 'gp-detail' },
				h('div', { className: 'gp-kv' }, h('b', null, t('graph.author')), h('span', null, `${commit.author} <${commit.email}>`)),
				h('div', { className: 'gp-kv' }, h('b', null, t('graph.date')), h('span', null, absoluteTime(commit.at))),
				h('div', { className: 'gp-kv' }, h('b', null, t('graph.hash')), h('span', { className: 'gp-hash' }, commit.short)),
				commit.body === '' ? null : h('div', { className: 'gp-detail-body' }, commit.body),
				h(
					'div',
					{ className: 'gp-detail-actions' },
					h(IconButton, { label: t('graph.openDiff'), onClick: () => onOpenDiff(commit) }, h(DiffIcon, null)),
					h(IconButton, { label: copied === true ? t('graph.copied') : t('graph.copy'), onClick: () => onCopy(commit) }, h(CopyIcon, null)),
					onCheckout === undefined
						? null
						: h(IconButton, { label: t('graph.checkout'), onClick: () => onCheckout() }, h(BranchIcon, { size: 12 })),
				),
				files.length === 0
					? null
					: h(
							'div',
							{ className: 'gp-detail-files' },
							files.map((file) =>
								h(
									'div',
									{
										className: 'gp-detail-file',
										key: file.path,
										title: file.path,
									},
									h(FileTypeIcon, { path: file.path }),
									h(ChangeBadge, { entry: { letter: file.status ?? 'M' }, t }),
									h('span', { className: 'gp-name' }, file.path),
									h('span', { className: 'gp-add' }, `+${file.additions}`),
									h('span', { className: 'gp-del' }, `-${file.deletions}`),
								),
							),
						),
			)
		}

		/* ------------------------------------------------------------------ */
		/* Graph section                                                       */
		/* ------------------------------------------------------------------ */

		/**
		 * Geometry of one graph row, as plain data.
		 *
		 * Everything the row's SVG needs, in the coordinate space the canvas uses:
		 * one path per edge (straight when the lane holds, an S-curve with vertical
		 * tangents when it moves — the shape the Cursor graph uses) and the commit's
		 * own node. Kept separate from rendering so it can be tested and measured.
		 * @param {object} row - one laid-out row from `layoutGraph`.
		 * @param {number} laneCount - widest lane count of the whole graph.
		 * @returns {{width: number, height: number, edges: object[], node: object}} geometry.
		 */
		function graphShapes(row, laneCount, maxWidth = GRAPH_MAX_WIDTH) {
			const lanes = Math.max(laneCount, 1)
			// Compress the pitch down to a legibility floor, then let the pane scroll.
			const laneWidth = lanes <= 1
				? LANE_WIDTH
				: Math.max(LANE_MIN_WIDTH, Math.min(LANE_WIDTH, (maxWidth - GRAPH_PAD * 2) / (lanes - 1)))
			const width = GRAPH_PAD * 2 + (lanes - 1) * laneWidth
			const x = (lane) => GRAPH_PAD + lane * laneWidth
			const center = ROW_HEIGHT / 2
			const edges = []
			for (const edge of row.edges) {
				// The commit's own edge leaves below its node; a lane that merely
				// passes through enters at the top of the row.
				const y0 = edge.from === row.lane ? center : 0
				const y1 = ROW_HEIGHT
				const x0 = x(edge.from)
				const x1 = x(edge.to)
				const bend = (y1 - y0) * CURVE_TENSION
				const d =
					x0 === x1
						? `M${x0} ${y0}L${x0} ${y1}`
						: `M${x0} ${y0}C${x0} ${y0 + bend} ${x1} ${y1 - bend} ${x1} ${y1}`
				edges.push({ d, color: edge.color, width: 2, opacity: 1 })
			}
			if (row.arrived === true) {
				// The half-row above the node: without it a commit whose lane it owns
				// shows a 19px hole between rows (linear history was all holes).
				const cx = x(row.lane)
				edges.push({
					d: `M${cx} 0L${cx} ${center}`,
					color: row.color ?? laneColor(row.lane),
					width: 2,
					opacity: 1,
				})
			}
			const merge = row.commit.parents.length > 1
			// Compressed lanes must not keep full-size dots: at a 4px pitch a 4.8px
			// radius overlaps the neighbouring lane, so the dot scales with the pitch.
			const dot = Math.min(NODE_RADIUS, laneWidth * 0.4)
			return {
				width,
				height: ROW_HEIGHT,
				edges,
				node: {
					cx: x(row.lane),
					cy: center,
					radius: merge ? Math.min(dot + 1.2, laneWidth * 0.5) : dot,
					color: row.color ?? laneColor(row.lane),
					merge,
					current: row.current === true,
				},
			}
		}

		/**
		 * Fold one row's edges into drawable groups.
		 *
		 * A straight lane is one subpath either way, so grouping by
		 * (colour, width, opacity) turns N pass-through lanes into at most one
		 * `<path>` per palette colour. Movement within a group is identical.
		 * @param {object[]} edges - `graphShapes` edges.
		 * @returns {object[]} groups with a joined `d`.
		 */
		function groupEdges(edges) {
			const groups = new Map()
			for (const edge of edges) {
				const key = `${edge.color}|${edge.width}|${edge.opacity}`
				const group = groups.get(key)
				if (group === undefined) groups.set(key, { color: edge.color, width: edge.width, opacity: edge.opacity, d: [edge.d] })
				else group.d.push(edge.d)
			}
			return [...groups.values()].map((group) => ({ ...group, d: group.d.join(' ') }))
		}

		/** One row's lane artwork. */
		function GraphCanvas({ row, laneCount, maxWidth }) {
			const shapes = graphShapes(row, laneCount, maxWidth)
			const { node } = shapes
			// Lines are drawn once, at full opacity: an interrupter in the background
			// colour (Git Graph draws one) reads as a broken line at our row height.
			const groups = groupEdges(shapes.edges)
			const children = []
			for (let index = 0; index < groups.length; index += 1) {
				const group = groups[index]
				children.push(h('path', {
					key: `e${index}`,
					d: group.d,
					stroke: group.color,
					strokeWidth: group.width,
					strokeLinecap: 'round',
					fill: 'none',
					opacity: group.opacity,
				}))
			}
			// The checked-out commit is a hollow ring, matching Git Graph's `.current`.
			children.push(
				node.current === true
					? h('circle', {
							key: 'node',
							cx: node.cx,
							cy: node.cy,
							r: node.radius,
							fill: 'var(--dsw-alias-bg-base,#1b1b1d)',
							stroke: node.color,
							strokeWidth: 2,
						})
					: h('circle', {
							key: 'node',
							cx: node.cx,
							cy: node.cy,
							r: node.radius,
							fill: node.color,
							stroke: 'var(--dsw-alias-bg-base,#1b1b1d)',
							strokeWidth: 1.2,
							strokeOpacity: 0.75,
						}),
			)
			if (node.merge === true) children.push(h('circle', { key: 'node-merge', cx: node.cx, cy: node.cy, r: 1.9, fill: 'var(--dsw-alias-bg-base,#1b1b1d)' }))
			return h(
				'svg',
				{
					className: 'gp-graph-canvas',
					width: shapes.width,
					height: shapes.height,
					viewBox: `0 0 ${shapes.width} ${shapes.height}`,
					'aria-hidden': 'true',
				},
				children,
			)
		}

		/** The refs of one commit, as the small badges the graph shows. */
		function Refs({ refs, t }) {
			if (!Array.isArray(refs) || refs.length === 0) return null
			return refs.map((ref) =>
				h('span', { key: `${ref.kind}:${ref.name}`, className: `gp-ref ${ref.kind}`, title: ref.kind === 'tag' ? `${t('graph.tag')}: ${ref.name}` : ref.name }, ref.name),
			)
		}

		/* ------------------------------------------------------------------ */
		/* The panel                                                           */
		/* ------------------------------------------------------------------ */

		/**
		 * The Git section body.
		 *
		 * The guard keeps hook order honest: this component holds no hooks, so when
		 * a seat arrives without the session props the fallback costs no hook, and
		 * the real body only ever mounts with every hook it needs.
		 * @param {object} props - slot props: `sessionId`, `useSessions`, `useTabInfo`, `t`.
		 * @returns {object} the panel.
		 */
		function GitPanelBody(props) {
			const t = props.t ?? ((key) => key)
			if (typeof props.useSessions !== 'function' || typeof props.useTabInfo !== 'function') {
				return h('div', { className: 'gp-root' }, h('div', { className: 'gp-note' }, t('empty.noSession')))
			}
			return h(GitPanelView, props)
		}

		/**
		 * The panel proper: every hook runs on every render of this component.
		 * @param {object} props - slot props.
		 * @returns {object} the panel content.
		 */
		function GitPanelView(props) {
			const t = props.t ?? ((key) => key)
			const sessionId = props.sessionId
			const useSessions = props.useSessions
			const tabInfo = props.useTabInfo()
			const tabActions = tabInfo?.tab?.actions

			const sessionCwd = useSessionCwd(useSessions, sessionId)
			const sessionRepoCwd = typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : undefined
			/**
			 * The Host's own checkout, named by `meta` without needing a `cwd`.
			 *
			 * A Session parked outside a repository (a workspace root, say) still
			 * has a repository worth showing while the user edits this plugin, so
			 * the panel falls back to it instead of rendering an empty page.
			 */
			const [pluginRepo, setPluginRepo] = useState(undefined)
			const [usingFallback, setUsingFallback] = useState(false)
			const cwd = (usingFallback ? pluginRepo : undefined) ?? sessionRepoCwd

			const [statusVersion, setStatusVersion] = useState(0)
			const [graphVersion, setGraphVersion] = useState(0)
			/**
			 * Every Host action currently in flight, keyed by what it acts on.
			 *
			 * One shared boolean used to stand for all of them, so a fetch that takes
			 * ten seconds greyed out the whole pane and reported itself through a
			 * spinner on the commit button. An entry per action lets the clicked
			 * control spin in place and lets a read-only fetch leave the rest usable.
			 */
			const [pending, setPending] = useState({})
			const [error, setError] = useState(undefined)
			const [notice, setNotice] = useState(undefined)
			const [confirming, setConfirming] = useState(undefined)
			const [expanded, setExpanded] = useState({ changes: true, graph: true })
			const [graphAll, setGraphAll] = useState(false)
			/** Height of the graph pane, dragged by the separator below the changes. */
			const [graphHeight, setGraphHeight] = useState(() => {
				try {
					const raw = window.localStorage?.getItem('dsh-git-panel:graphHeight')
					const parsed = Number.parseInt(raw ?? '', 10)
					if (Number.isFinite(parsed) && parsed >= 140 && parsed <= 900) return parsed
				} catch {}
				return 320
			})
			const graphHeightRef = useRef(graphHeight)
			graphHeightRef.current = graphHeight
			const startGraphResize = useCallback((event) => {
				event.preventDefault()
				const startY = event.clientY
				const startHeight = graphHeightRef.current
				const move = (moveEvent) => {
					// Dragging all the way down must collapse, not stop at a useless 140px.
					const next = Math.min(900, Math.max(0, startHeight + (startY - moveEvent.clientY)))
					graphHeightRef.current = next
					setGraphHeight(next)
				}
				const up = () => {
					window.removeEventListener('pointermove', move)
					window.removeEventListener('pointerup', up)
					window.removeEventListener('pointercancel', up)
					const settled = graphHeightRef.current
					if (settled < 120) {
						// Snapped shut: the pane keeps the last usable height for re-opening.
						setExpanded((current) => ({ ...current, graph: false }))
						graphHeightRef.current = 320
						setGraphHeight(320)
					} else if (settled < 140) {
						graphHeightRef.current = 140
						setGraphHeight(140)
					}
					try {
						window.localStorage?.setItem('dsh-git-panel:graphHeight', String(graphHeightRef.current))
					} catch {}
				}
				window.addEventListener('pointermove', move)
				window.addEventListener('pointerup', up)
				window.addEventListener('pointercancel', up)
			}, [])
			const [selected, setSelected] = useState(undefined)
			const [detail, setDetail] = useState(undefined)
			const [detailLoading, setDetailLoading] = useState(false)
			const [copied, setCopied] = useState(false)

			const status = useRoute(cwd, 'status', {}, { enabled: true, poll: POLL_MS, version: statusVersion })
			const value = status.value
			/** Stable `useState` setter: lets `run` install a status without re-creating itself. */
			const replaceStatus = status.replace

			/** Ask the Host once for the checkout the plugin itself lives in. */
			useEffect(() => {
				let live = true
				call('meta')
					.then((result) => {
						const fallback = typeof result?.fallback === 'string' ? result.fallback : ''
						if (live && fallback !== '') setPluginRepo(fallback)
					})
					.catch(() => {})
				return () => {
					live = false
				}
			}, [])

			/** A new Session directory gets its own chance to be a repository first. */
			useEffect(() => {
				setUsingFallback(false)
			}, [sessionRepoCwd])

			// No repository here (or no Session directory yet) but the plugin's own
			// checkout exists: show that instead of an empty page. The status must
			// name the Session directory, otherwise it is the previous one's answer,
			// still on screen while the new request runs.
			useEffect(() => {
				if (usingFallback || pluginRepo === undefined) return
				if (sessionRepoCwd === undefined) {
					setUsingFallback(true)
					return
				}
				if (value !== undefined && value.cwd === sessionRepoCwd && value.repo !== true) setUsingFallback(true)
			}, [usingFallback, pluginRepo, sessionRepoCwd, value])
			const repo = value?.repo === true ? value : undefined

			const graph = useRoute(
				cwd,
				'graph',
				{ all: graphAll, limit: 60 },
				{ enabled: expanded.graph && repo !== undefined, version: graphVersion },
			)
			const graphRows = useMemo(() => layoutGraph(Array.isArray(graph.value?.commits) ? graph.value.commits : []), [graph.value])

			/**
			 * Run one Host action.
			 *
			 * Two rules keep the pane feeling live:
			 *
			 *   - the action's own entry is pending, so the control that was clicked
			 *     shows the spinner and says how long it has been running;
			 *   - the answer carries the status the action produced (`settleStatus` in
			 *     the Host half), so the branch chip and the counts flip in the same
			 *     render instead of one round trip after the work finished.
			 *
			 * Only actions that touch the work tree lock the rows; a fetch does not.
			 * `graph` asks for a history reload, and only the actions that can move a
			 * ref send it — staging a file no longer re-reads the whole log.
			 */
			const run = useCallback(
				async (action, payload, options = {}) => {
					if (cwd === undefined) return { ok: false, value: undefined }
					const key = typeof options.key === 'string' ? options.key : action
					const startedAt = Date.now()
					setPending((current) => ({
						...current,
						[key]: { action, mode: payload?.mode, name: payload?.name, since: startedAt },
					}))
					setError(undefined)
					try {
						const result = await call(action, { cwd, ...(payload ?? {}) })
						if (typeof options.notice === 'string' && options.notice !== '') setNotice(options.notice)
						if (result !== null && typeof result === 'object' && result.status !== null && typeof result.status === 'object') {
							replaceStatus(result.status)
						} else {
							setStatusVersion((value2) => value2 + 1)
						}
						if (options.graph === true) setGraphVersion((value2) => value2 + 1)
						options.onDone?.(result)
						return { ok: true, value: result }
					} catch (failure) {
						setError(failure)
						return { ok: false, value: undefined }
					} finally {
						setPending((current) => {
							// A slower earlier request must not clear the entry a newer one
							// just put there.
							if (current[key]?.since !== startedAt) return current
							const next = { ...current }
							delete next[key]
							return next
						})
						if (options.clearConfirm !== false) setConfirming(undefined)
					}
				},
				[cwd, replaceStatus],
			)

			/**
			 * What the header should say is running, if anything.
			 *
			 * A checkout reports the branch it is moving to; a network verb reports
			 * which of fetch / pull / push / sync it is running.
			 */
			const networkPending = pending.network
			const checkoutPending = pending.checkout
			const progress =
				networkPending !== undefined
					? {
							label: t(NETWORK_LABELS[String(networkPending.mode ?? 'fetch')] ?? 'status.busy'),
							since: networkPending.since,
						}
					: checkoutPending === undefined
						? undefined
						: {
								label: fill(t('status.switching'), { name: String(checkoutPending.name ?? '') }),
								since: checkoutPending.since,
							}

			/**
			 * Whether the work tree is being changed right now.
			 *
			 * Rows and the commit box wait for those; a fetch or a push only touches
			 * refs, so it leaves them alone and the pane never freezes on the network.
			 */
			const workTreePending = Object.keys(pending).filter((key) => key !== 'network')
			const busy =
				workTreePending.length > 0 ||
				(networkPending !== undefined && networkPending.mode !== 'fetch' && networkPending.mode !== 'push')

			useEffect(() => {
				if (notice === undefined) return undefined
				const timer = setTimeout(() => setNotice(undefined), 3200)
				return () => clearTimeout(timer)
			}, [notice])

			/**
			 * Open one file's diff in a new tab.
			 *
			 * The worktree group holds both modified and untracked files, so the
			 * row's own porcelain code decides whether git can diff it: an
			 * untracked path has no index entry, and `git diff` on it is empty —
			 * the Host renders those as an all-additions patch instead.
			 */
			const openDiff = useCallback(
				(entry, group) => {
					if (tabActions === undefined) return
					tabActions.openTab(DIFF_KIND, { params: diffRequestFor(entry, group, repo?.cwd) })
				},
				[tabActions, repo],
			)

			/** Open one changed file itself — the same previewer a file link uses. */
			const openFile = useCallback(
				(entry) => {
					if (tabActions === undefined || repo === undefined) return
					try {
						tabActions.openResource(fileAddress(sessionId, repo.root, entry.path))
					} catch (failure) {
						setError(failure)
					}
				},
				[tabActions, repo, sessionId],
			)

			/** Open every working-tree change as one preview page. */
			const openAllDiff = useCallback(() => {
				if (tabActions === undefined) return
				tabActions.openTab(DIFF_KIND, { params: { all: true, cwd: repo?.cwd } })
			}, [tabActions, repo])

			/** Header actions per section: staging lives with the list it acts on. */
			function sectionHeaderActions(id) {
				if (repo === undefined) return []
				if (id === 'staged') {
					return [
						h(IconButton, { key: 'unstage', label: t('changes.unstageAll'), disabled: busy, onClick: () => run('unstage', { paths: (repo.staged ?? []).map((entry) => entry.path) }) }, h(MinusIcon, null)),
					]
				}
				if (id === 'worktree') {
					return [
						h(IconButton, { key: 'stage', label: t('changes.stageAll'), disabled: busy || stageAllPaths(repo).length === 0, onClick: () => run('stage', { paths: stageAllPaths(repo) }) }, h(PlusIcon, null)),
						h(IconButton, { key: 'discard', label: t('changes.discardAll'), danger: true, disabled: busy, onClick: () => setConfirming({ kind: 'discardAll' }) }, h(UndoIcon, null)),
						h(IconButton, { key: 'preview', label: t('changes.previewAll'), onClick: openAllDiff }, h(DiffIcon, null)),
					]
				}
				return []
			}

			/** Send one conflicted file to the conversation input. */
			const quoteConflict = useCallback(
				async (entry) => {
					if (cwd === undefined) return
					const header = fill(t('conflict.quoteHeader'), { path: entry.path, branch: repo?.branch ?? 'HEAD' })
					let snippet = ''
					try {
						const patch = await call('diff', { cwd, path: entry.path }, undefined)
						snippet = conflictSnippet(patch?.patch)
					} catch (failure) {
						setError(failure)
						return
					}
					const text = `${header}\n\n\`\`\`diff\n${snippet}\n\`\`\`\n`
					setNotice(insertIntoComposer(sessionId, text) ? t('conflict.quoted') : t('conflict.copied'))
				},
				[cwd, repo, sessionId, t],
			)

			/** Send the whole working tree to the conversation for review. */
			const findIssues = useCallback(() => {
				const text = buildReviewPrompt({
					cwd,
					branch: repo?.branch ?? 'HEAD',
					staged: repo?.staged ?? [],
					changes: repo?.changes ?? [],
					untracked: repo?.untracked ?? [],
				})
				if (text === '') {
					setNotice(t('review.empty'))
					return
				}
				setNotice(insertIntoComposer(sessionId, text) ? t('review.quoted') : t('review.copied'))
			}, [cwd, repo, sessionId, t])

			/** Select one commit and read its description. */
			const selectCommit = useCallback(
				(commit) => {
					if (selected === commit.hash) {
						setSelected(undefined)
						setDetail(undefined)
						return
					}
					setSelected(commit.hash)
					setDetail(undefined)
					setDetailLoading(true)
					call('commitDetail', { cwd: cwd, hash: commit.hash })
						.then((next) => setDetail(next))
						.catch((failure) => setError(failure))
						.finally(() => setDetailLoading(false))
				},
				[cwd, selected],
			)

			const onCommit = useCallback(
				async (payload) => {
					const outcome = await run('commit', payload, { graph: true, clearConfirm: false })
					if (outcome.ok !== true) return false
					// 提交即同步：先 commit，再 push（失败会走到下面的 error）。
					// 两个答复都带 status，芯片不必再等一次往返。
					const pushed = await run('network', { mode: 'push' }, { key: 'network', graph: true, clearConfirm: false })
					const hash = outcome.value?.hash
					setNotice(
						fill(pushed.ok === true ? t('commit.donePushed') : t('commit.done'), {
							hash: typeof hash === 'string' ? hash : '',
						}),
					)
					return true
				},
				[run, t],
			)

			/** One refresh verb for the whole pane: status and history together. */
			const refreshAll = useCallback(() => {
				// The history is reloaded through its version; the status is read here
				// and once, with `force` — a refresh answered from the Host's short read
				// cache looks like a button that does nothing.
				setGraphVersion((value2) => value2 + 1)
				status.refresh?.(true, { force: true })
			}, [status])

			const sectionToggle = (name) => () => setExpanded((current) => ({ ...current, [name]: current[name] !== true }))

			/** Switch branches; the answer already carries the status that follows. */
			const checkoutBranch = useCallback((name) => run('checkout', { name }, { graph: true }), [run])

			if (cwd === undefined) {
				return h('div', { className: 'gp-root' }, h('div', { className: 'gp-note' }, t('empty.noRepo')))
			}

			if (value !== undefined && value.repo !== true) {
				return h('div', { className: 'gp-root' }, h('div', { className: 'gp-note' }, t('empty.noRepo')))
			}

			/** Cursor/VS Code split: staged on its own, everything else in one list. */
			const worktreeEntries = [...(repo?.changes ?? []), ...(repo?.untracked ?? [])]
			const sections = [
				{ id: 'conflicts', title: t('changes.conflicts'), entries: repo?.conflicts ?? [] },
				{ id: 'staged', title: t('changes.staged'), entries: repo?.staged ?? [] },
				{ id: 'worktree', title: t('changes.worktree'), entries: worktreeEntries },
			].filter((section) => section.id === 'worktree' || section.entries.length > 0)

			return h(
				'div',
				{ className: 'gp-root' },
				error === undefined
					? null
					: h(
							'div',
							{ className: 'gp-error', role: 'alert' },
							h('span', { className: 'gp-error-icon' }, h(ChangeConflictIcon, null)),
							h('span', { className: 'gp-error-text' }, `${t('error.title')}：${error.message}`),
							h(IconButton, { label: t('error.dismiss'), onClick: () => setError(undefined) }, h('span', { 'aria-hidden': 'true' }, '✕')),
						),
				notice === undefined ? null : h('div', { className: 'gp-toast', role: 'status' }, h(CheckIcon, null), h('span', null, notice)),
				h(CommitBox, {
					t,
					status: repo,
					busy,
					onCommit,
				}),
				h(
					'div',
					{ className: 'gp-changes' },
					repo === undefined
						? h('div', { className: 'gp-note' }, t('empty.loading'))
						: sections.map((section) =>
						h(
							'div',
							{ className: 'gp-section', key: section.id },
							h(SectionHeader, {
								t,
								title: section.title,
								count: section.entries.length,
								expanded: expanded[section.id] !== false,
								onToggle: sectionToggle(section.id),
								actions: sectionHeaderActions(section.id),
							}),
							expanded[section.id] === false
								? null
								: section.entries.length === 0
									? section.id === 'worktree'
										? h('div', { className: 'gp-note' }, t('empty.clean'))
										: null
									: section.entries.map((entry) =>
										h(ChangeRow, {
											key: `${section.id}:${entry.path}`,
											entry,
											group: section.id,
											busy,
											t,
											onOpenDiff: openDiff,
											onOpenFile: openFile,
											onStage: (target) => run('stage', { paths: [target.path] }),
											onUnstage: (target) => run('unstage', { paths: [target.path] }),
											onDiscard: (target, kind) =>
												setConfirming({ kind: 'discardOne', path: target.path, group: kind, request: discardRequestFor(target, kind) }),
											onQuote: quoteConflict,
										}),
									),
						),
					),
				),
				h('div', { className: 'gp-review' },
					h('div', {
						className: 'gp-review-head',
						role: 'button',
						tabIndex: 0,
						onClick: () => setExpanded((current) => ({ ...current, review: current.review === false })),
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault()
								setExpanded((current) => ({ ...current, review: current.review === false }))
							}
						},
					}, t('review.title')),
					expanded.review === false ? null : h('button', {
						type: 'button',
						className: 'gp-review-btn',
						disabled: busy || (repo?.staged?.length ?? 0) + (repo?.changes?.length ?? 0) + (repo?.untracked?.length ?? 0) === 0,
						onClick: findIssues,
					}, h(SparkleIcon, null), t('review.find')),
				),
				expanded.graph === false
					? null
					: h('div', {
							className: 'gp-resizer',
							role: 'separator',
							'aria-orientation': 'horizontal',
							title: t('graph.resize'),
							onPointerDown: startGraphResize,
						}),
				h(
					'div',
					{
						className: 'gp-graph-panel',
						style: expanded.graph === false ? null : { height: `${graphHeight}px` },
					},
					h(SectionHeader, {
						t,
						variant: 'graph',
						title: t('graph.title'),
						count: graphRows.rows.length,
						expanded: expanded.graph,
						onToggle: sectionToggle('graph'),
						actions: [
							repo === undefined
								? h('span', { className: 'gp-branch gp-branch-waiting', key: 'branch' }, h('span', { className: 'gp-spinner' }), h('span', { className: 'gp-branch-name' }, t('empty.loading')))
								: h(BranchMenu, {
										key: 'branch',
										t,
										repo,
										busy,
										pending: checkoutPending?.name,
										placement: 'up',
										onCheckout: checkoutBranch,
									}),
							h(
								IconButton,
								{
									key: 'refs',
									label: graphAll ? t('graph.head') : t('graph.all'),
									active: graphAll,
									onClick: () => setGraphAll((value2) => !value2),
								},
								h(GraphRefsIcon, null),
							),
							repo === undefined
								? null
								: h(
										IconButton,
										{
											key: 'fetch',
											label: t('status.fetch'),
											className: 'gp-btn-fetch',
											busy: networkPending?.mode === 'fetch',
											// Two network verbs at once would race for the same refs.
											disabled: networkPending !== undefined || checkoutPending !== undefined,
											onClick: () => run('network', { mode: 'fetch' }, { key: 'network', graph: true }),
										},
										h(CloudIcon, null),
									),
							repo === undefined
								? null
								: h(
										IconButton,
										{
											key: 'sync',
											label: t('status.sync'),
											busy: networkPending !== undefined && networkPending.mode !== 'fetch',
											disabled: networkPending !== undefined || checkoutPending !== undefined,
											onClick: () => run('network', { mode: 'sync' }, { key: 'network', graph: true }),
										},
										h(SyncIcon, null),
									),
							h(IconButton, { key: 'refresh', label: t('status.refresh'), disabled: busy, onClick: refreshAll }, h(RefreshIcon, null)),
						],
					}),
					progress === undefined ? null : h(ProgressStrip, { label: progress.label, since: progress.since }),
					expanded.graph !== true
						? null
						: h(
								'div',
								{ className: 'gp-graph-list' },
								graph.loading === true && graphRows.rows.length === 0
									? h('div', { className: 'gp-note' }, t('graph.loading'))
									: graphRows.rows.length === 0
										? h('div', { className: 'gp-note' }, t('graph.empty'))
										: h(
												'div',
												{ className: 'gp-graph' },
												graphRows.rows.map((row) =>
													h(
														React.Fragment,
														{ key: row.commit.hash },
														h(
															'div',
															{
																className: `gp-graph-row${selected === row.commit.hash ? ' selected' : ''}`,
																onClick: () => selectCommit(row.commit),
																role: 'button',
																tabIndex: 0,
																onKeyDown: (event) => (event.key === 'Enter' ? selectCommit(row.commit) : undefined),
															},
															h(GraphCanvas, { row, laneCount: graphRows.laneCount }),
															h(
																'div',
																{ className: 'gp-graph-main' },
																h(
																	'div',
																	{ className: 'gp-graph-subject' },
																	h(Refs, { refs: row.commit.refs, t }),
																	h('span', { className: 'gp-subject-text', title: row.commit.subject }, row.commit.subject === '' ? '(无提交说明)' : row.commit.subject),
																),
																h(
																	'div',
																	{ className: 'gp-graph-meta' },
																	h('span', { className: 'gp-hash' }, row.commit.short),
																	h('span', null, row.commit.author),
																	h('span', null, relativeTime(row.commit.at)),
																),
															),
														),
														selected === row.commit.hash
															? h(CommitDetail, {
																	t,
																	detail,
																	loading: detailLoading,
																	copied,
																	onOpenDiff: (commit) => tabActions?.openTab(DIFF_KIND, { params: { hash: commit.hash, cwd: repo?.cwd } }),
																	onCopy: (commit) => {
																		try {
																			navigator.clipboard?.writeText?.(commit.hash)
																		} catch {}
																		setCopied(true)
																		setTimeout(() => setCopied(false), 1600)
																	},
																	onCheckout:
																		row.commit.refs.some((ref) => ref.kind === 'branch' || ref.kind === 'head')
																		? () => {
																				const ref = row.commit.refs.find((entry) => entry.kind === 'branch')
																				if (ref !== undefined) checkoutBranch(ref.name)
																			}
																		: undefined,
																})
															: null,
													),
												),
												graph.value?.truncated === true ? h('div', { className: 'gp-note' }, fill(t('graph.truncated'), { count: graphRows.rows.length })) : null,
											),
							),
				),
								confirming === undefined
					? null
					: h(ConfirmBar, {
							t,
							confirming,
							repo,
							busy,
							onCancel: () => setConfirming(undefined),
							onConfirm: () => {
								/** One request per confirmation, so a stale row cannot widen it. */
								let request
								let count
								if (confirming.kind === 'discardOne') {
									request = confirming.request ?? discardRequestFor({ path: confirming.path, code: confirming.untracked === true ? '??' : '' }, confirming.group)
									count = (request.paths?.length ?? 0) + (request.untracked?.length ?? 0)
								} else {
									const paths = [...(repo?.staged ?? []), ...(repo?.changes ?? [])].map((entry) => entry.path)
									const untracked = (repo?.untracked ?? []).map((entry) => entry.path)
									request = { paths, untracked }
									count = paths.length + untracked.length
								}
								if (count === 0) {
									setConfirming(undefined)
									return
								}
								run('discard', request).then((outcome) => {
									if (outcome.ok !== true) return
									setNotice(fill(t('discard.done'), { count }))
								})
							},
						}),
			)
		}

		/** Every path a "stage all" click should add. */
		function stageAllPaths(repo) {
			const paths = [...(repo?.untracked ?? []), ...(repo?.changes ?? []), ...(repo?.conflicts ?? [])].map((entry) => entry.path)
			return paths
		}

		/**
		 * The in-panel confirmation overlay: discard never happens on one click.
		 *
		 * It is anchored to the bottom edge of the panel (`position:absolute` in a
		 * positioned `.gp-root`) instead of being the last flex row of the column,
		 * where a tall graph pushed it out of view.
		 * @param {object} props - `t`, `confirming`, `repo`, `busy` and the handlers.
		 * @returns {object} the overlay.
		 */
		function ConfirmBar({ t, confirming, repo, busy, onCancel, onConfirm }) {
			const text =
				confirming.kind === 'discardOne'
					? fill(t('confirm.discardOne'), { path: confirming.path })
					: fill(t('confirm.discardAll'), { count: (repo?.counts?.staged ?? 0) + (repo?.counts?.changes ?? 0) + (repo?.counts?.untracked ?? 0) })
			const label = t('confirm.discard')
			useEffect(() => {
				const onKey = (event) => {
					if (event.key === 'Escape') onCancel()
				}
				window.addEventListener('keydown', onKey)
				return () => window.removeEventListener('keydown', onKey)
			}, [onCancel])
			return h(
				'div',
				{
					className: 'gp-confirm-scrim',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget) onCancel()
					},
				},
				h(
					'div',
					{ className: 'gp-confirm', role: 'alertdialog', 'aria-modal': 'true' },
					h('span', null, text),
					h(
						'button',
						{ type: 'button', className: 'gp-primary', disabled: busy === true, onClick: onConfirm },
						busy === true ? h('span', { className: 'gp-spinner' }) : null,
						label,
					),
					h(IconButton, { label: t('confirm.cancel'), onClick: onCancel }, h('span', { 'aria-hidden': 'true' }, '✕')),
				),
			)
		}

		/**
		 * What the branch chip says: the checked-out name (or the short hash when
		 * detached) plus the divergence the old toolbar used to show as three
		 * separate tags.
		 * @param {object} repo - status payload.
		 * @returns {{label: string, detached: boolean, ahead: number, behind: number}} chip facts.
		 */
		function branchSummaryOf(repo) {
			const detached = repo?.detached === true
			const raw = detached ? String(repo?.oid ?? '') : String(repo?.branch ?? '')
			const label = detached ? raw.slice(0, 7) || 'HEAD' : raw
			return {
				label,
				detached,
				ahead: Number(repo?.ahead) || 0,
				behind: Number(repo?.behind) || 0,
			}
		}

		/**
		 * The branch chip and its checkout menu.
		 *
		 * It lives in the graph header now, which sits at the bottom of the pane,
		 * so the menu opens upward (`placement="up"`); a downward popover would be
		 * clipped by the sidebar.
		 */
		function BranchMenu({ t, repo, busy, pending, onCheckout, placement }) {
			const [open, setOpen] = useState(false)
			const [branches, setBranches] = useState(undefined)
			const [loadingRefs, setLoadingRefs] = useState(false)
			const ref = useRef(null)
			const summary = branchSummaryOf(repo)

			/**
			 * Re-read the ref list every time the menu opens.
			 *
			 * It used to be fetched once and kept for the life of the pane, so after a
			 * checkout the menu still marked the branch the user had just left as
			 * current. The previous list stays on screen while the new one loads: the
			 * menu opens instantly and settles a moment later.
			 */
			useEffect(() => {
				if (!open) return undefined
				let live = true
				setLoadingRefs(true)
				call('branches', { cwd: repo.cwd })
					.then((next) => {
						if (live) setBranches(next)
					})
					.catch(() => {
						if (live) setBranches((current) => current ?? { local: [], remote: [], tags: [] })
					})
					.finally(() => {
						if (live) setLoadingRefs(false)
					})
				return () => {
					live = false
				}
			}, [open, repo.cwd, repo.branch, repo.ahead, repo.behind])

			useEffect(() => {
				if (!open) return undefined
				const onDown = (event) => {
					if (ref.current !== null && !ref.current.contains(event.target)) setOpen(false)
				}
				const onKey = (event) => {
					if (event.key === 'Escape') setOpen(false)
				}
				document.addEventListener('mousedown', onDown)
				document.addEventListener('keydown', onKey)
				return () => {
					document.removeEventListener('mousedown', onDown)
					document.removeEventListener('keydown', onKey)
				}
			}, [open])

			const diverged = summary.ahead + summary.behind
			const detail = [
				`${t('branch.current')}: ${summary.label}`,
				summary.detached ? t('branch.detached') : '',
				summary.ahead > 0 ? fill(t('branch.ahead'), { count: summary.ahead }) : '',
				summary.behind > 0 ? fill(t('branch.behind'), { count: summary.behind }) : '',
			].filter((part) => part !== '').join(' · ')

			// A checkout in flight owns the chip: it names the branch being moved to,
			// so the click is answered immediately instead of after `git checkout`.
			if (pending !== undefined) {
				const switching = fill(t('status.switching'), { name: String(pending) })
				return h(
					'div',
					{ className: 'gp-menu-wrap', ref },
					h(
						'button',
						{ type: 'button', className: 'gp-branch gp-branch-pending', title: switching, disabled: true, 'aria-busy': true },
						h('span', { className: 'gp-spinner' }),
						h('span', { className: 'gp-branch-name' }, String(pending)),
					),
				)
			}

			return h(
				'div',
				{ className: 'gp-menu-wrap', ref },
				h(
					'button',
					{
						type: 'button',
						className: 'gp-branch',
						title: detail,
						'aria-haspopup': 'menu',
						'aria-expanded': open === true,
						onClick: () => setOpen((value) => !value),
					},
					h(BranchIcon, { size: 11 }),
					h('span', { className: 'gp-branch-name' }, summary.label),
					summary.detached === true || diverged === 0
						? null
						: h(
								'span',
								{ className: 'gp-branch-meta' },
								summary.ahead > 0 ? h('span', { className: 'up' }, `↑${summary.ahead}`) : null,
								summary.behind > 0 ? h('span', { className: 'down' }, `↓${summary.behind}`) : null,
							),
				),
				open
					? h(
							'div',
							{ className: `gp-menu${placement === 'up' ? ' up' : ''}`, role: 'menu' },
							h(
								'div',
								{ className: 'gp-menu-title' },
								t('branch.local'),
								loadingRefs === true ? h('span', { className: 'gp-spinner' }) : null,
							),
							(branches?.local ?? []).map((branch) =>
								h(
									'button',
									{
										key: branch.name,
										type: 'button',
										role: 'menuitem',
										disabled: busy || branch.current === true,
										onClick: () => {
											setOpen(false)
											onCheckout(branch.name)
										},
									},
									h(BranchIcon, { size: 12 }),
									h('span', null, branch.name),
									branch.current === true ? h('span', { className: 'gp-menu-check' }, h(CheckIcon, null)) : null,
								),
							),
							(branches?.local ?? []).length === 0 ? h('div', { className: 'gp-note' }, t('empty.loading')) : null,
						)
					: null,
			)
		}

		/* ------------------------------------------------------------------ */
		/* Diff page                                                           */
		/* ------------------------------------------------------------------ */

		/**
		 * The diff preview body: one file, every working-tree change, or one commit.
		 * @param {object} props - slot props plus the tab's navigation params.
		 * @returns {object} the preview.
		 */
		function DiffBody(props) {
			const t = props.t ?? ((key) => key)
			if (typeof props.useSessions !== 'function' || typeof props.useTabInfo !== 'function') {
				return h('div', { className: 'gp-root' }, h('div', { className: 'gp-note' }, t('empty.noSession')))
			}
			return h(TabBoundary, { t }, h(DiffView, props))
		}

		/**
		 * Contains one tab's render error.
		 *
		 * React unmounts the whole root when a tab body throws, which the user sees
		 * as a black window. The panel is a viewer: a broken diff should lose its
		 * own content, not the app around it, and it should say what went wrong.
		 */
		class TabBoundary extends React.Component {
			constructor(props) {
				super(props)
				this.state = { error: undefined }
			}

			static getDerivedStateFromError(error) {
				return { error }
			}

			componentDidCatch(error) {
				try {
					console.error('[git-panel] tab render failed', error)
				} catch {}
			}

			render() {
				if (this.state.error === undefined) return this.props.children
				const t = this.props.t ?? ((key) => key)
				const message = this.state.error?.message ?? String(this.state.error)
				return h(
					'div',
					{ className: 'gp-root' },
					h(
						'div',
						{ className: 'gp-error', role: 'alert' },
						h('span', { className: 'gp-error-text' }, fill(t('diff.crash'), { message })),
					),
				)
			}
		}

		/**
		 * Colour one file's rows, then pair each run of deletions with the run of
		 * additions after it so both sides can carry a word-level wash.
		 * @param {object[]} rows - parsed rows of one file.
		 * @param {string} language - colouring family of the file.
		 * @returns {object[]} rows with `tokens` (and `word` where paired).
		 */
		function colorizeRows(rows, language) {
			let state = {}
			const colored = rows.map((row) => {
				if (row.kind === 'hunk') return row
				const next = tokenizeLine(row.text, language, state)
				state = next.state
				return { ...row, tokens: next.tokens }
			})
			let index = 0
			while (index < colored.length) {
				if (colored[index].kind !== 'del') {
					index += 1
					continue
				}
				let after = index
				while (after < colored.length && colored[after].kind === 'del') after += 1
				let end = after
				while (end < colored.length && colored[end].kind === 'add') end += 1
				const pairs = Math.min(after - index, end - after)
				for (let offset = 0; offset < pairs; offset += 1) {
					const changed = wordDiff(colored[index + offset].text, colored[after + offset].text)
					if (changed !== null) {
						colored[index + offset].word = changed.old
						colored[after + offset].word = changed.new
					}
				}
				index = end > index ? end : index + 1
			}
			return colored
		}

		/**
		 * Split one coloured row into the spans the line prints, cutting tokens
		 * where the word-level wash starts and ends.
		 * @param {object} row - a coloured row.
		 * @returns {object[]} `{ text, cls, word }` segments.
		 */
		function rowSegments(row) {
			const tokens = Array.isArray(row.tokens) && row.tokens.length > 0 ? row.tokens : [{ text: row.text, cls: '' }]
			if (row.word === undefined) return tokens.map((token) => ({ text: token.text, cls: token.cls, word: false }))
			const [from, to] = row.word
			const segments = []
			let offset = 0
			for (const token of tokens) {
				const start = offset
				const end = offset + token.text.length
				offset = end
				const left = Math.max(start, from)
				const right = Math.min(end, to)
				if (left >= right) {
					segments.push({ text: token.text, cls: token.cls, word: false })
					continue
				}
				if (left > start) segments.push({ text: token.text.slice(0, left - start), cls: token.cls, word: false })
				segments.push({ text: token.text.slice(left - start, right - start), cls: token.cls, word: true })
				if (right < end) segments.push({ text: token.text.slice(right - start), cls: token.cls, word: false })
			}
			return segments
		}

		/** One code line: two number gutters, the sign, and the coloured text run. */
		function DiffRowView({ row }) {
			const segments = rowSegments(row)
			return h(
				'div',
				{ className: `gp-diff-line ${row.kind}` },
				h('span', { className: 'gp-ln' }, row.oldNo === '' ? '' : String(row.oldNo)),
				h('span', { className: 'gp-ln' }, row.newNo === '' ? '' : String(row.newNo)),
				h('span', { className: 'gp-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''),
				h(
					'span',
					{ className: 'gp-code' },
					h(
						'span',
						{ className: 'gp-code-text' },
						segments.map((segment, index) =>
							h(
								'span',
								{
									key: index,
									className: `${segment.cls === '' ? '' : `gp-tok gp-tok-${segment.cls}`}${segment.word ? ' gp-word' : ''}`.trim(),
								},
								segment.text,
							),
						),
					),
				),
			)
		}

		/** The `@@ -a,b +c,d @@` rail, with the function context git appends. */
		function HunkRow({ row }) {
			const range =
				row.range === null || row.range === undefined
					? ''
					: `-${row.range.oldStart},${row.range.oldCount} +${row.range.newStart},${row.range.newCount}`
			return h(
				'div',
				{ className: 'gp-hunk' },
				h('span', { className: 'gp-hunk-mark' }, '@@'),
				h('span', { className: 'gp-hunk-range' }, range),
				h('span', { className: 'gp-hunk-mark' }, '@@'),
				row.section === '' ? null : h('span', { className: 'gp-hunk-section', title: row.section }, row.section),
			)
		}

		/** The sticky header of one file inside a multi-file patch. */
		function DiffFileHeader({ file, expanded, onToggle, t }) {
			const status = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M'
			const label = expanded ? t('diff.collapseFile') : t('diff.expandFile')
			const parts = splitPath(file.path)
			const renamed = file.oldPath !== '' && file.oldPath !== file.path
			return h(
				'div',
				{
					className: 'gp-file-head',
					role: 'button',
					tabIndex: 0,
					'aria-expanded': expanded,
					title: renamed ? `${file.oldPath} → ${file.path}` : file.path,
					'aria-label': label,
					onClick: onToggle,
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onToggle()
						}
					},
				},
				h(ChevronIcon, { className: `gp-chevron${expanded ? ' open' : ''}` }),
				h(FileTypeIcon, { path: file.path }),
				h(
					'span',
					{ className: 'gp-file-path' },
					parts.dir === '' ? null : h('span', { className: 'gp-file-dir' }, parts.dir),
					h('span', { className: 'gp-file-name' }, parts.name),
				),
				renamed ? h('span', { className: 'gp-file-old' }, `← ${file.oldPath}`) : null,
				h('span', { className: `gp-file-tag ${status}` }, status),
				h(
					'span',
					{ className: 'gp-file-stats' },
					file.additions > 0 ? h('span', { className: 'gp-add' }, `+${file.additions}`) : null,
					file.deletions > 0 ? h('span', { className: 'gp-del' }, `-${file.deletions}`) : null,
				),
			)
		}

		/** The commit message shown above a `git show` patch. */
		function CommitBanner({ commit, t }) {
			if (commit === null) return null
			const short = commit.hash.slice(0, 7)
			const date = String(commit.date ?? '').replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}):\d{2}.*$/u, '$1 $2')
			return h(
				'div',
				{ className: 'gp-commit' },
				h('div', { className: 'gp-commit-subject' }, commit.subject === '' ? fill(t('diff.commit'), { hash: short }) : commit.subject),
				h(
					'div',
					{ className: 'gp-commit-meta' },
					h('span', { className: 'gp-commit-hash', title: commit.hash }, short),
					commit.author === '' ? null : h('span', null, commit.author),
					date === '' ? null : h('span', null, date),
				),
				commit.body === '' ? null : h('div', { className: 'gp-commit-body' }, commit.body),
			)
		}

		/** The five-block add/delete overview next to the header counts. */
		function DiffOverview({ additions, deletions }) {
			const blocks = diffStatBlocks(additions, deletions)
			if (blocks.length === 0) return null
			return h(
				'span',
				{ className: 'gp-diffstat', 'aria-hidden': 'true' },
				blocks.map((kind, index) => h('i', { key: index, className: kind })),
			)
		}

		/** First-paint placeholder: a handful of shimmering rows. */
		function DiffSkeleton() {
			return h(
				'div',
				{ className: 'gp-skeleton' },
				// React rejects a string `style`; the width has to be a style object.
				Array.from({ length: 8 }, (_, index) => h('i', { key: index, style: { width: `${28 + ((index * 17) % 58)}%` } })),
			)
		}

		/**
		 * The diff page proper, with its hooks unconditional.
		 * @param {object} props - slot props.
		 * @returns {object} the preview.
		 */
		function DiffView(props) {
			const t = props.t ?? ((key) => key)
			const sessionId = props.sessionId
			const tabInfo = props.useTabInfo()
			const params = tabInfo?.tab?.navigation?.params
			const revision = tabInfo?.tab?.navigation?.revision ?? 0
			const tabActions = tabInfo?.tab?.actions
			const sessionCwd = useSessionCwd(props.useSessions, sessionId)
			// TEMP: 面板打开改动页时带的仓库根优先，会话目录只作兜底。
			const paramCwd = typeof params?.cwd === 'string' && params.cwd !== '' ? params.cwd : undefined
			const cwd = paramCwd !== undefined ? paramCwd : typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : undefined

			const request = useMemo(() => {
				const source = params ?? {}
				const next = { all: source.all === true }
				if (typeof source.path === 'string') next.path = source.path
				if (source.staged === true) next.staged = true
				if (source.untracked === true) next.untracked = true
				if (typeof source.hash === 'string') next.hash = source.hash
				return next
			}, [params])

			const [result, setResult] = useState(undefined)
			const [error, setError] = useState(undefined)
			const [loading, setLoading] = useState(false)
			const [version, setVersion] = useState(0)
			const signature = JSON.stringify(request)

			useEffect(() => {
				if (cwd === undefined || cwd === '') return undefined
				const controller = new AbortController()
				setLoading(true)
				call('diff', { cwd, ...request }, controller.signal)
					.then((next) => {
						setResult(next)
						setError(undefined)
					})
					.catch((failure) => {
						if (controller.signal.aborted !== true) setError(failure)
					})
					.finally(() => {
						if (controller.signal.aborted !== true) setLoading(false)
					})
				return () => controller.abort()
				// `signature` is the stable identity of `request`; `revision` re-opens.
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [cwd, signature, version, revision])

			const mode =
				request.hash !== undefined
					? t('diff.mode.commit')
					: request.all === true
						? undefined
						: request.staged === true
							? t('diff.mode.staged')
							: request.untracked === true
								? t('diff.mode.untracked')
								: t('diff.mode.worktree')

			const patch = typeof result?.patch === 'string' ? result.patch : ''
			const model = useMemo(() => {
				const { commit, patch: body } = splitCommitPatch(patch)
				const parsed = parsePatch(body)
				const groups = parsed.files.map((file) => ({ file, rows: [], language: languageOf(file.path) }))
				for (const row of parsed.rows) {
					const group = groups[row.file]
					if (group !== undefined) group.rows.push(row)
				}
				for (const group of groups) group.rows = colorizeRows(group.rows, group.language)
				return { commit, parsed, groups }
			}, [patch])

			const [collapsed, setCollapsed] = useState(() => new Set())
			const toggleFile = useCallback((index) => {
				setCollapsed((current) => {
					const next = new Set(current)
					if (next.has(index)) next.delete(index)
					else next.add(index)
					return next
				})
			}, [])

			const openFile = () => {
				if (tabActions === undefined || typeof request.path !== 'string' || typeof result?.root !== 'string') return
				try {
					tabActions.openResource(fileAddress(sessionId, result.root, request.path))
				} catch (failure) {
					setError(failure)
				}
			}

			const commit = model.commit
			const subject = commit !== null && commit.subject !== '' ? commit.subject : ''
			const title =
				typeof request.path === 'string' && request.path !== ''
					? request.path
					: subject !== ''
						? subject
						: request.all === true
							? t('diff.all')
							: request.hash !== undefined
								? fill(t('diff.commit'), { hash: request.hash.slice(0, 7) })
								: t('diff.title')
			const showFileHeaders = model.groups.length > 1 || typeof request.path !== 'string'
			const hasRows = model.parsed.rows.length > 0

			return h(
				'div',
				{ className: 'gp-root gp-diff' },
				h(
					'div',
					{ className: 'gp-diff-head' },
					typeof request.path === 'string' ? h(FileTypeIcon, { path: request.path }) : h(DiffIcon, null),
					h('span', { className: `gp-path${typeof request.path === 'string' ? '' : ' commit'}`, title }, title),
					mode === undefined ? null : h('span', { className: 'gp-tag' }, mode),
					model.groups.length > 1 ? h('span', { className: 'gp-tag gp-tag-files' }, fill(t('diff.files'), { count: model.groups.length })) : null,
					h(DiffOverview, { additions: model.parsed.additions, deletions: model.parsed.deletions }),
					model.parsed.additions > 0 ? h('span', { className: 'gp-add' }, `+${model.parsed.additions}`) : null,
					model.parsed.deletions > 0 ? h('span', { className: 'gp-del' }, `-${model.parsed.deletions}`) : null,
					typeof request.path === 'string' ? h(IconButton, { label: t('diff.openFile'), onClick: openFile }, h(FileIcon, null)) : null,
					h(IconButton, { label: t('diff.refresh'), disabled: loading, onClick: () => setVersion((value) => value + 1) }, h(RefreshIcon, null)),
				),
				error === undefined ? null : h('div', { className: 'gp-error' }, h('span', null, error.message)),
				h(
					'div',
					{ className: 'gp-diff-body' },
					commit === null ? null : h(CommitBanner, { commit, t }),
					loading === true && hasRows === false && model.groups.length === 0
						? h(DiffSkeleton, null)
						: hasRows === false && model.groups.length === 0
							? h('div', { className: 'gp-note' }, result?.binary === true ? t('diff.binary') : t('diff.empty'))
							: model.groups.map((group, index) => {
									const expanded = !collapsed.has(index)
									return h(
										'section',
										{ key: index, className: 'gp-file' },
										showFileHeaders
											? h(DiffFileHeader, { file: group.file, expanded, onToggle: () => toggleFile(index), t })
											: null,
										expanded === false
											? null
											: group.file.binary
												? h('div', { className: 'gp-note gp-file-note' }, t('diff.binary'))
												: group.rows.map((row, rowIndex) =>
														row.kind === 'hunk'
															? h(HunkRow, { key: rowIndex, row })
															: h(DiffRowView, { key: rowIndex, row }),
													),
									)
								}),
					model.parsed.truncated === true
						? h('div', { className: 'gp-note' }, fill(t('diff.lines'), { count: model.parsed.rows.length }))
						: null,
				),
			)
		}

		/** The panel chip's live title. */
		function GitTitle(props) {
			const t = props.t ?? ((key) => key)
			return h('span', null, t('type.label'))
		}

		/** The diff chip's live title: the file being previewed. */
		function DiffTitle(props) {
			const t = props.t ?? ((key) => key)
			if (typeof props.useTabInfo !== 'function') return h('span', null, t('diff.title'))
			return h(DiffTitleView, props)
		}

		/**
		 * The chip title, read from the tab's own navigation parameters so two
		 * diff tabs never share a label.
		 * @param {object} props - slot props.
		 * @returns {object} the title.
		 */
		function DiffTitleView(props) {
			const t = props.t ?? ((key) => key)
			const params = props.useTabInfo()?.tab?.navigation?.params ?? {}
			if (typeof params.path === 'string' && params.path !== '') return h('span', null, fill(t('diff.title.path'), { path: params.path }))
			if (typeof params.hash === 'string' && params.hash !== '') return h('span', null, fill(t('diff.title.path'), { path: params.hash.slice(0, 7) }))
			return h('span', null, t('diff.title'))
		}

		/* ------------------------------------------------------------------ */
		/* Registration                                                        */
		/* ------------------------------------------------------------------ */

		/**
		 * Client plugin body: register both tab types, their dictionaries and
		 * their bodies.
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			pluginCtx = ctx
			const t = ctx.locale.bind(NS)
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git-panel: dictionaries')
			ctx.effect(() => installStyles(), 'git-panel: styles')

			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: PANEL_ID,
						kind: GIT_KIND,
						priority: 'extension',
						title: () => t('type.label'),
						guide: [
							{
								id: 'panel',
								order: 25,
								title: () => t('guide.title'),
								description: () => t('guide.description'),
								icon: GitGuideIcon,
							},
						],
					}),
				'git-panel: git type',
			)

			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: DIFF_ID,
						kind: DIFF_KIND,
						multiple: true,
						priority: 'extension',
						title: () => t('diff.title'),
					}),
				'git-panel: diff type',
			)

			ctx.effect(
				() =>
					ctx.slots.inject('sidebar.right.pane.tab', () =>
						ctx.slots.register(
							{
								name: 'sidebar.right.pane.tab',
								key: PANEL_ID,
								locale: NS,
								inject: (sessionId) => ({ sessionId, t }),
							},
							GitPanelBody,
						),
					),
				'git-panel: git body',
			)

			ctx.effect(
				() =>
					ctx.slots.inject('sidebar.right.pane.tab', () =>
						ctx.slots.register(
							{
								name: 'sidebar.right.pane.tab',
								key: DIFF_ID,
								locale: NS,
								inject: (sessionId) => ({ sessionId, t }),
							},
							DiffBody,
						),
					),
				'git-panel: diff body',
			)

			ctx.effect(
				() =>
					ctx.slots.inject('sidebar.right.pane.tab.title', () =>
						ctx.slots.register(
							{
								name: 'sidebar.right.pane.tab.title',
								key: DIFF_ID,
								locale: NS,
								inject: (sessionId) => ({ sessionId, t }),
							},
							DiffTitle,
						),
					),
				'git-panel: diff title',
			)
		}

		/* @file-icons:start — generated by scripts/build-file-icons.mjs from
		   Material Icon Theme 5.40.0 (MIT); regenerate instead of editing. */
		const FILE_ICON_SVGS = {
			"adobe-illustrator": ["0 0 32 32","<rect width=\"28\" height=\"28\" x=\"2\" y=\"2\" fill=\"#5d4037\" rx=\"4\"/><path fill=\"#ffb74d\" d=\"M20.988 9.999a.96.96 0 0 1-.687-.269 1 1 0 0 1-.263-.704.9.9 0 0 1 .278-.681 1 1 0 0 1 .687-.268.93.93 0 0 1 .703.268 1.046 1.046 0 0 1-.015 1.385.9.9 0 0 1-.703.268M20 12h2v10h-2zm-5.63-1.98-.01-.02h-2.08a.12.12 0 0 0-.1.13 4.5 4.5 0 0 1-.06.74c-.05.13-.08.26-.12.37l-.27.78L8 22h2.14l.75-2h5.24l.79 2h2.16zM11.64 18l1.8-4.84.01.04.02.04L14.95 17l.39 1z\"/>"],
			"adobe-photoshop": ["0 0 32 32","<rect width=\"28\" height=\"28\" x=\"2\" y=\"2\" fill=\"#37474f\" rx=\"4\"/><path fill=\"#64b5f6\" d=\"M23.744 14.716a3.7 3.7 0 0 0-1.066-.408 5.4 5.4 0 0 0-1.245-.157 2.1 2.1 0 0 0-.666.085.57.57 0 0 0-.345.24.7.7 0 0 0-.089.324.56.56 0 0 0 .111.313 1.3 1.3 0 0 0 .378.324q.386.217.79.397a7.8 7.8 0 0 1 1.71.877 2.7 2.7 0 0 1 .878.998 2.8 2.8 0 0 1 .256 1.238 2.96 2.96 0 0 1-.434 1.599 2.83 2.83 0 0 1-1.244 1.07 4.75 4.75 0 0 1-2.011.384 7 7 0 0 1-1.511-.156 4.2 4.2 0 0 1-1.134-.385.24.24 0 0 1-.122-.228v-2.092a.14.14 0 0 1 .044-.108c.034-.024.067-.012.1.012a4.6 4.6 0 0 0 1.378.59 4.8 4.8 0 0 0 1.311.18 2 2 0 0 0 .923-.169.56.56 0 0 0 .3-.505.65.65 0 0 0-.267-.48 4.6 4.6 0 0 0-1.089-.565 6.6 6.6 0 0 1-1.578-.866 3 3 0 0 1-.844-1.021 2.76 2.76 0 0 1-.256-1.226 3 3 0 0 1 .378-1.455 2.8 2.8 0 0 1 1.167-1.105A4 4 0 0 1 21.533 12a9 9 0 0 1 1.378.108 3.7 3.7 0 0 1 .956.277.2.2 0 0 1 .11.108.7.7 0 0 1 .023.144v1.96a.15.15 0 0 1-.056.12.28.28 0 0 1-.2 0M12.38 10H9.99v-.03h-2v12h2V18h2.39A3.62 3.62 0 0 0 16 14.38v-.76A3.62 3.62 0 0 0 12.38 10M14 14.38A1.626 1.626 0 0 1 12.38 16H9.99v-4h2.39A1.626 1.626 0 0 1 14 13.62Z\"/>"],
			"android": ["0 0 32 32","<rect width=\"4\" height=\"10\" x=\"2\" y=\"12\" fill=\"#8bc34a\" rx=\"2\"/><rect width=\"4\" height=\"10\" x=\"26\" y=\"12\" fill=\"#8bc34a\" rx=\"2\"/><path fill=\"#8bc34a\" d=\"M8 12h16v12H8zm2 12h4v4a2 2 0 0 1-2 2 2 2 0 0 1-2-2zm8 0h4v4a2 2 0 0 1-2 2 2 2 0 0 1-2-2zm3.545-19.759 2.12-2.12A1 1 0 0 0 22.251.707l-2.326 2.326a7.97 7.97 0 0 0-7.85 0L9.75.707a1 1 0 1 0-1.414 1.414l2.12 2.12A7.97 7.97 0 0 0 8 10h16a7.97 7.97 0 0 0-2.455-5.759M14 8h-2V6h2Zm6 0h-2V6h2Z\"/>"],
			"applescript": ["0 0 32 32","<path fill=\"#78909c\" d=\"M25.425 26.498c-1.162 1.736-2.394 3.43-4.27 3.458-1.875.042-2.477-1.106-4.605-1.106-2.142 0-2.8 1.078-4.578 1.148-1.834.07-3.22-1.848-4.396-3.542C5.183 23 3.35 16.63 5.813 12.346a6.84 6.84 0 0 1 5.767-3.514c1.792-.028 3.5 1.217 4.606 1.217 1.092 0 3.164-1.497 5.334-1.273a6.5 6.5 0 0 1 5.095 2.771 6.38 6.38 0 0 0-3.01 5.334 6.18 6.18 0 0 0 3.752 5.656 15.5 15.5 0 0 1-1.932 3.961M17.432 4.1A6.36 6.36 0 0 1 21.548 2a6.13 6.13 0 0 1-1.456 4.466 5.11 5.11 0 0 1-4.13 1.988 5.98 5.98 0 0 1 1.47-4.354\"/>"],
			"asciidoc": ["0 0 32 32","<path fill=\"#0097a7\" d=\"M4 18V8l5.39 10Zm0 4v3.67A2.33 2.33 0 0 0 6.33 28h8.9l-3.496-6Zm12.444 0 3.177 5.444A11.88 11.88 0 0 0 26.448 22Zm11.419-4A15 15 0 0 0 28 16 12 12 0 0 0 16 4L6 3.995q-.08 0-.158.005L14 18Z\"/>"],
			"assembly": ["0 0 16 16","<path fill=\"#ff6e40\" d=\"M2 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h2v-1H2V2h2V1Zm10 0v1h2v12h-2v1h2a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1ZM6 3c0 1 0 1-1 1v1h1v2h1V3Zm3 0a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1Zm0 1h1v2H9ZM6 9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1Zm4 0c0 1 0 1-1 1v1h1v2h1V9Zm-4 1h1v2H6Z\"/>"],
			"astro": ["0 0 32 32","<path fill=\"#7c4dff\" d=\"M12.106 25.849c-1.262-1.156-1.63-3.586-1.105-5.346a5.18 5.18 0 0 0 3.484 1.66 9.68 9.68 0 0 0 5.882-.734c.215-.106.413-.247.648-.39a3.5 3.5 0 0 1 .16 1.555 4.26 4.26 0 0 1-1.798 3.021c-.404.3-.832.569-1.25.852a2.613 2.613 0 0 0-1.15 3.372l.048.161a3.4 3.4 0 0 1-1.5-1.285 3.6 3.6 0 0 1-.578-1.962 9 9 0 0 0-.05-1.037c-.114-.831-.504-1.204-1.238-1.225a1.45 1.45 0 0 0-1.507 1.18c-.012.056-.028.112-.046.178M4.901 20a17.75 17.75 0 0 1 7.4-2l2.913-8.38a.765.765 0 0 1 1.527 0L19.7 18a14.24 14.24 0 0 1 7.399 2S20.704 2.877 20.692 2.842C20.51 2.33 20.202 2 19.787 2h-7.619c-.415 0-.71.33-.904.842z\"/>"],
			"audio": ["0 0 32 32","<path fill=\"#ef5350\" d=\"M16 2a14 14 0 1 0 14 14A14 14 0 0 0 16 2m6 10h-4v8a4 4 0 1 1-4-4 3.96 3.96 0 0 1 2 .555V8h6Z\"/>"],
			"babel": ["0 0 24 24","<path fill=\"#fdd835\" d=\"M18.23 11.21q-.045-.24-1.32-1.65c-.02-.19.29-.45.9-.8l1.74-1.55c.39-.5.62-1.28.69-2.38l-.02-.26c-.07-.78-.63-1.4-1.69-1.89-.63-.42-1.76-.65-3.38-.68-1.35.11-3.11.59-5.28 1.43-.6.43-1.28.86-2.04 1.28l.01.14.21-.08c.08-.01.13.03.14.11l.13-.07.07-.01.01.06c0 .07-.47.44-1.76 1.35l-.06.12c-.31.02-.61.25-.91.67l.08.12.25-.09.18.24c.32-.33.66-.62 1.03-.87.19.05.29.11.44.16 1.02-.75 2.03-1.3 3.04-1.64l.01.14c-.2.27-.32.42-.38.42l.1.23c.01.19-2.55 7-6.66 14.44l.08.19c.35-.08.58-.17.75-.26l.01.13.4-.03-.67 1.76.14.06c.57-.64 1-1.29 1.3-1.88 1.67-.49 2.94-.97 3.82-1.44.88-.08 1.56-.31 2.02-.7l.92-.47c1.27-.98 2.22-1.67 2.87-2.08 1.33-.98 2.2-1.93 2.6-2.85zm-3.46 2.31L13 14.91c-1.29.85-2 1.3-2.09 1.3-2.07 1.13-3.36 1.72-3.86 1.76l-.05.01c.04-.23.96-2.12 2.75-5.67.78-.06 2.02-.43 3.71-1.1l.41-.03c.85-.08 1.49.09 1.91.49l.03.26c-.31.9-.67 1.44-1.04 1.59m1.09-5.78q-.27.33-1.5 1.11c-.27.03-1.27.42-3.01 1.18l-.28-.05-.01-.12c-.02-.25.09-.57.34-.95.13-.7.28-1.12.44-1.2l1.45-3.28c-.02-.22.29-.35.93-.46l.21-.02.01.18 1.16-.16c1.15-.1 1.75.14 1.8.7l.13-.02-.03-.32.15-.02c.35.19.52.4.54.68.02.18-.08.41-.29.68-.09.01-.14-.06-.15-.18l-.14.01-.03.4c-.58.87-1.01 1.31-1.27 1.34z\"/>"],
			"browserlist": ["0 0 140 140","<path fill=\"#ffca28\" d=\"M70 10.172A59.83 59.83 0 0 0 10.172 70 59.83 59.83 0 0 0 70 129.828 59.83 59.83 0 0 0 129.828 70 59.83 59.83 0 0 0 70 10.172m-4.836 8.785C65.66 23 66.516 26.28 67.736 29.18c4.779-4.287 10.265-7.546 16.041-9.02-.981 3.938-1.357 7.295-1.261 10.43 6.026-2.314 12.349-3.404 18.3-2.706-3.182 2.413-5.482 4.717-7.128 7.015-2.201 12.074 6.858 20.43 14.779 24.551a5.13 5.13 0 0 1 5.183-3.888 5.128 5.128 0 0 1 3.7 8.435V64c-.487 1.055-2.002 2.343-3.496 3.219-4.076 2.39-11.173 5.736-20.915 7.39.045 1.214.077 2.453.077 3.747 0 4.817-.485 8.291-1.385 10.699-3.3 13.313-12.648 26.76-24.695 31.95.357-4.082.197-7.484-.402-10.591-5.582 3.219-11.646 5.278-17.623 5.52h-.002c1.785-3.662 2.855-6.878 3.412-9.976-6.347.996-12.727.742-18.377-1.17 2.93-2.732 5.054-5.314 6.673-7.96-6.292-1.344-12.169-3.87-16.766-7.686 3.822-1.544 6.795-3.239 9.3-5.197-5.426-3.517-10.034-7.998-12.972-13.23 4.012-.07 7.321-.568 10.3-1.453-3.786-5.215-6.468-11.032-7.333-16.951 3.861 1.405 7.196 2.133 10.36 2.355-1.662-6.22-2.081-12.605-.768-18.436 3.03 2.634 5.824 4.48 8.63 5.815.677-6.406 2.576-12.52 5.893-17.496 1.926 3.622 3.914 6.392 6.111 8.672 2.93-5.754 6.9-10.798 11.791-14.262zM91.63 38.514c-2.395 5.514-1.665 11.297-.555 18.732a2.138 2.138 0 0 0 .28-4.178 3.419 3.419 0 1 1 .092 6.704c.574 3.882 1.157 8.18 1.421 13.125a67 67 0 0 0 3.25-.649c6.616-1.487 12.258-3.801 16.871-6.506.45-.264.884-.563 1.276-.867.366-.557.333-.957.035-1.285-4.831-1.245-10.891-4.53-15.258-8.795-4.764-4.653-7.427-10.164-7.412-16.281\"/>"],
			"bun": ["0 0 32 32","<path fill=\"#fff8e1\" d=\"M30 17.045a9.8 9.8 0 0 0-.32-2.306l-.004.034a11.2 11.2 0 0 0-5.762-6.786c-3.495-1.89-5.243-3.326-6.8-3.811h.003c-1.95-.695-3.949.82-5.825 1.927-4.52 2.481-9.573 5.45-9.28 11.417.008-.029.017-.052.026-.08a9.97 9.97 0 0 0 3.934 7.257l-.01-.006C13.747 31.473 30.05 27.292 30 17.045\"/><path fill=\"#37474f\" d=\"M19.855 20.236A.8.8 0 0 0 19.26 20h-6.514a.8.8 0 0 0-.596.236.51.51 0 0 0-.137.463 4.37 4.37 0 0 0 1.641 2.339 4.2 4.2 0 0 0 2.349.926 4.2 4.2 0 0 0 2.343-.926 4.37 4.37 0 0 0 1.642-2.339.5.5 0 0 0-.132-.463Z\"/><ellipse cx=\"22.5\" cy=\"18.5\" fill=\"#f8bbd0\" rx=\"2.5\" ry=\"1.5\"/><ellipse cx=\"9.5\" cy=\"18.5\" fill=\"#f8bbd0\" rx=\"2.5\" ry=\"1.5\"/><circle cx=\"10\" cy=\"16\" r=\"2\" fill=\"#37474f\"/><circle cx=\"22\" cy=\"16\" r=\"2\" fill=\"#37474f\"/><path fill=\"#455a64\" d=\"M9.996 18A2 2 0 1 0 8 15.996V16a2 2 0 0 0 1.996 2\"/><circle cx=\"9\" cy=\"15\" r=\"1\" fill=\"#fafafa\"/><circle cx=\"21\" cy=\"15\" r=\"1\" fill=\"#fafafa\"/>"],
			"c": ["0 0 32 32","<path fill=\"#0288d1\" d=\"M19.563 22A5.57 5.57 0 0 1 14 16.437v-2.873A5.57 5.57 0 0 1 19.563 8H24V2h-4.437A11.563 11.563 0 0 0 8 13.563v2.873A11.564 11.564 0 0 0 19.563 28H24v-6Z\"/>"],
			"changelog": ["0 0 24 24","<path d=\"M0 0h24v24H0z\"/><path fill=\"#8bc34a\" d=\"M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.95 8.95 0 0 0 13 21a9 9 0 0 0 0-18m-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8z\"/>"],
			"clojure": ["0 0 256 256","<path fill=\"#64dd17\" d=\"M123.456 129.975a507 507 0 0 0-3.54 7.846c-4.406 9.981-9.284 22.127-11.066 29.908-.64 2.77-1.037 6.205-1.03 10.013 0 1.506.081 3.09.21 4.702a58.1 58.1 0 0 0 19.98 3.559 58.2 58.2 0 0 0 18.29-2.98c-1.352-1.237-2.642-2.554-3.816-4.038-7.796-9.942-12.146-24.512-19.028-49.01m-28.784-49.39C79.782 91.08 70.039 108.387 70.002 128c.037 19.32 9.487 36.403 24.002 46.94 3.56-14.83 12.485-28.41 25.868-55.63a219 219 0 0 0-2.714-7.083c-3.708-9.3-9.059-20.102-13.834-24.993-2.435-2.555-5.389-4.763-8.652-6.648\"/><path fill=\"#7cb342\" d=\"M178.532 194.535c-7.683-.963-14.023-2.124-19.57-4.081a69.4 69.4 0 0 1-30.958 7.249c-38.491 0-69.693-31.198-69.698-69.7 0-20.891 9.203-39.62 23.764-52.392-3.895-.94-7.956-1.49-12.104-1.482-20.45.193-42.037 11.51-51.025 42.075-.84 4.45-.64 7.813-.64 11.8 0 60.591 49.12 109.715 109.705 109.715 37.104 0 69.882-18.437 89.732-46.633-10.736 2.675-21.06 3.955-29.902 3.982-3.314 0-6.425-.177-9.305-.53\"/><path fill=\"#29b6f6\" d=\"M157.922 173.271c.678.336 2.213.884 4.35 1.49 14.375-10.553 23.717-27.552 23.754-46.764h-.005c-.055-32.03-25.974-57.945-58.011-58.009a58.2 58.2 0 0 0-18.213 2.961c11.779 13.426 17.443 32.613 22.922 53.6l.01.025c.01.017 1.752 5.828 4.743 13.538 2.97 7.7 7.203 17.231 11.818 24.178 3.03 4.655 6.363 8 8.632 8.981\"/><path fill=\"#1e88e5\" d=\"M128.009 18.29c-36.746 0-69.25 18.089-89.16 45.826 10.361-6.49 20.941-8.83 30.174-8.747 12.753.037 22.779 3.991 27.589 6.696a51 51 0 0 1 3.345 2.131 69.4 69.4 0 0 1 28.049-5.894c38.496.004 69.703 31.202 69.709 69.698h-.006c0 19.409-7.938 36.957-20.736 49.594 3.142.352 6.492.571 9.912.554 12.15.006 25.284-2.675 35.13-10.956 6.42-5.408 11.798-13.327 14.78-25.199.584-4.586.92-9.247.92-13.991 0-60.588-49.116-109.715-109.705-109.715\"/>"],
			"cmake": ["0 0 24 24","<path fill=\"#1e88e5\" d=\"M11.94 2.984 2.928 21.017l9.875-8.47z\"/><path fill=\"#e53935\" d=\"m11.958 2.982.002.29 1.312 14.499-.002.006.023.26 7.363 2.978h.415l-.158-.31-.114-.228h-.001l-8.84-17.494z\"/><path fill=\"#7cb342\" d=\"m8.558 16.13-5.627 4.884h17.743v-.016z\"/>"],
			"conduct": ["0 0 24 24","<path fill=\"#cddc39\" d=\"m10 17-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9m-6-6a1 1 0 0 1 1 1 1 1 0 0 1-1 1 1 1 0 0 1-1-1 1 1 0 0 1 1-1m7 0h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2\"/>"],
			"console": ["0 0 16 16","<path fill=\"#ff7043\" d=\"M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z\"/>"],
			"contributing": ["0 0 24 24","<path fill=\"#ffca28\" d=\"M17 9H7V7h10m0 6H7v-2h10m-3 6H7v-2h7M12 3a1 1 0 0 1 1 1 1 1 0 0 1-1 1 1 1 0 0 1-1-1 1 1 0 0 1 1-1m7 0h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2\"/>"],
			"cpp": ["0 0 32 32","<path fill=\"#0288d1\" d=\"M28 14v-4h-2v4h-6v-4h-2v4h-4v2h4v4h2v-4h6v4h2v-4h4v-2z\"/><path fill=\"#0288d1\" d=\"M13.563 22A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z\"/>"],
			"csharp": ["0 0 32 32","<path fill=\"#0288d1\" d=\"M30 14v-2h-2V8h-2v4h-2V8h-2v4h-2v2h2v2h-2v2h2v4h2v-4h2v4h2v-4h2v-2h-2v-2Zm-4 2h-2v-2h2Zm-12.437 6A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z\"/>"],
			"css": ["0 0 32 32","<path fill=\"#7e57c2\" d=\"M20 18h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 20 22h2v2h2v-2c0-.388-.562-.851-1.254-1.034C20.356 20.34 20 18.84 20 18m-3.254 2.966C14.356 20.34 14 18.84 14 18h-2v-2h-2v8h2v-2h4v2h2v-2c0-.388-.562-.851-1.254-1.034\"/><path fill=\"#7e57c2\" d=\"M24 4H4v20a4 4 0 0 0 4 4h16.16A3.84 3.84 0 0 0 28 24.16V8a4 4 0 0 0-4-4m2 14h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 26 22v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2Z\"/>"],
			"cuda": ["0 0 32 32","<path fill=\"#7cb342\" d=\"M12.496 10.16c-.184 0-.314.01-.496.022V12a7 7 0 0 1 .991-.062 7.34 7.34 0 0 1 5.335 2.457l-2.72 2.156c-1.213-1.922-1.568-2.767-3.606-3v5.468a4.8 4.8 0 0 0 1.486.234c3.969 0 7.667-4.847 7.667-4.847s-3.427-4.402-8.657-4.246m-9.222 4.468A12.46 12.46 0 0 1 12 10.184V8.715c-6.407.489-12 5.602-12 5.602s3.202 8.56 12 9.337v-1.641c-6.454-.756-8.726-7.385-8.726-7.385\"/><path fill=\"#7cb342\" d=\"M12 13.54V12a11.17 11.17 0 0 0-6.3 2.828s1.424 4.791 6.3 5.614v-1.423a6.48 6.48 0 0 1-3.72-3.913A5.04 5.04 0 0 1 12 13.54m0-7.566v2.74l.496-.032c7.267-.234 12.014 5.624 12.014 5.624s-5.442 6.247-11.107 6.247A8.4 8.4 0 0 1 12 20.431V22a11 11 0 0 0 1.19.108c5.276 0 9.058-2.478 12.757-5.479.612.467 3.12 1.59 3.64 2.079-3.51 2.779-11.696 5.013-16.337 5.013a12 12 0 0 1-1.25-.066V26h20V6Z\"/>"],
			"dart": ["0 0 32 32","<path fill=\"#4fc3f7\" d=\"M16.83 2a1.3 1.3 0 0 0-.916.377l-.013.01L7.323 7.34l8.556 8.55v.005l10.283 10.277 1.96-3.529-7.068-16.96-3.299-3.297A1.3 1.3 0 0 0 16.828 2Z\"/><path fill=\"#01579b\" d=\"m7.343 7.32-4.955 8.565-.01.013a1.297 1.297 0 0 0 .004 1.835l.005.005 4.106 4.107 16.064 6.314 3.632-2.015-.098-.098-.025.002L15.995 15.97h-.012z\"/><path fill=\"#01579b\" d=\"m7.321 7.324 8.753 8.755h.013L26.16 26.156l3.835-.73L30 14.089l-4.049-3.965a6.5 6.5 0 0 0-3.618-1.612l.002-.043L7.323 7.325Z\"/><path fill=\"#64b5f6\" d=\"m7.332 7.335 8.758 8.75v.013l10.079 10.071L25.436 30H14.09l-3.967-4.048a6.5 6.5 0 0 1-1.611-3.618l-.045.004Z\"/>"],
			"database": ["0 0 32 32","<path fill=\"#ffca28\" d=\"M16 24c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-8c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-12C10.477 4 6 4.895 6 6v4c0 1.1 4.475 2 10 2s10-.9 10-2V6c0-1.105-4.477-2-10-2\"/>"],
			"diff": ["0 0 24 24","<path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M18 23H4c-1.1 0-2-.9-2-2V7h2v14h14zM14.5 7V5h-2v2h-2v2h2v2h2V9h2V7zm2 6h-6v2h6zM15 1H8c-1.1 0-1.99.9-1.99 2L6 17c0 1.1.89 2 1.99 2H19c1.1 0 2-.9 2-2V7zm4 16H8V3h6.17L19 7.83z\"/>"],
			"disc": ["0 0 32 32","<path fill=\"#b0bec5\" d=\"M16 12a4 4 0 1 1-4 4 4.005 4.005 0 0 1 4-4m0-10a14 14 0 1 0 14 14A14 14 0 0 0 16 2\"/>"],
			"dll": ["0 0 24 24","<path fill=\"#42a5f5\" d=\"M6 2a2 2 0 0 0-2 2v16c0 1.11.89 2 2 2h6v-2H6V4h7v5h5v3h2V8l-6-6m4 12a.26.26 0 0 0-.26.21l-.19 1.32c-.3.13-.59.29-.85.47l-1.24-.5c-.11 0-.24 0-.31.13l-1 1.73c-.06.11-.04.24.06.32l1.06.82a4.2 4.2 0 0 0 0 1l-1.06.82a.26.26 0 0 0-.06.32l1 1.73c.06.13.19.13.31.13l1.24-.5c.26.18.54.35.85.47l.19 1.32c.02.12.12.21.26.21h2c.11 0 .22-.09.24-.21l.19-1.32c.3-.13.57-.29.84-.47l1.23.5c.13 0 .26 0 .33-.13l1-1.73a.26.26 0 0 0-.06-.32l-1.07-.82c.02-.17.04-.33.04-.5s-.01-.33-.04-.5l1.06-.82a.26.26 0 0 0 .06-.32l-1-1.73c-.06-.13-.19-.13-.32-.13l-1.23.5c-.27-.18-.54-.35-.85-.47l-.19-1.32A.236.236 0 0 0 20 14m-1 3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5c-.84 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5\"/>"],
			"docker": ["0 0 24 24","<path fill=\"#0288d1\" d=\"M21.81 10.25c-.06-.04-.56-.43-1.64-.43-.28 0-.56.03-.84.08-.21-1.4-1.38-2.11-1.43-2.14l-.29-.17-.18.27c-.24.36-.43.77-.51 1.19-.2.8-.08 1.56.33 2.21-.49.28-1.29.35-1.46.35H2.62c-.34 0-.62.28-.62.63 0 1.15.18 2.3.58 3.38.45 1.19 1.13 2.07 2 2.61.98.6 2.59.94 4.42.94.79 0 1.61-.07 2.42-.22 1.12-.2 2.2-.59 3.19-1.16A8.3 8.3 0 0 0 16.78 16c1.05-1.17 1.67-2.5 2.12-3.65h.19c1.14 0 1.85-.46 2.24-.85.26-.24.45-.53.59-.87l.08-.24zm-17.96.99h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H3.85c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.43 0h1.76c.08 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16H6.28c-.09 0-.16.07-.16.16v1.58c.01.09.07.16.16.16m2.47 0h1.75c.1 0 .17-.07.17-.16V9.5c0-.08-.06-.16-.17-.16H8.75c-.08 0-.15.07-.15.16v1.58c0 .09.06.16.15.16m2.44 0h1.77c.08 0 .15-.07.15-.16V9.5c0-.08-.06-.16-.15-.16h-1.77c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16M6.28 9h1.76c.08 0 .16-.09.16-.18V7.25c0-.09-.07-.16-.16-.16H6.28c-.09 0-.16.06-.16.16v1.57c.01.09.07.18.16.18m2.47 0h1.75c.1 0 .17-.09.17-.18V7.25c0-.09-.06-.16-.17-.16H8.75c-.08 0-.15.06-.15.16v1.57c0 .09.06.18.15.18m2.44 0h1.77c.08 0 .15-.09.15-.18V7.25c0-.09-.07-.16-.15-.16h-1.77c-.08 0-.15.06-.15.16v1.57c0 .09.07.18.15.18m0-2.28h1.77c.08 0 .15-.07.15-.16V5c0-.1-.07-.17-.15-.17h-1.77c-.08 0-.15.06-.15.17v1.56c0 .08.07.16.15.16m2.46 4.52h1.76c.09 0 .16-.07.16-.16V9.5c0-.08-.07-.16-.16-.16h-1.76c-.08 0-.15.07-.15.16v1.58c0 .09.07.16.15.16\"/>"],
			"document": ["0 0 24 24","<path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z\"/>"],
			"editorconfig": ["0 0 3473 3473","<path fill=\"#ede7f6\" d=\"M989.342 1977.409c41.146-26.835 75.137-93.922 54.564-141.33-56.353 24.151-53.67 79.61-54.564 141.33m636.877 153.851c44.724-14.311 87.66-64.402 63.509-116.283-34.886 24.151-57.248 57.247-63.51 116.284z\"/><g fill=\"#fafafa\"><path d=\"M374.827 2871.899c0 56.352 14.312 117.178 53.67 138.645 144.907 81.4 652.977 17.89 825.614-20.573 90.343-20.573 163.692-87.66 248.668-124.334 191.421-83.187 330.067-150.274 483.025-262.085 110.916-81.399 287.131-310.388 305.915-447.245l-151.169-33.991c-3.578 153.852-38.463 188.737-175.32 224.517-92.132 25.046-271.925 30.413-365.846 14.312-124.334-20.574-180.687-85.871-237.04-160.114-109.128-144.907 24.151-245.985-148.485-255.824-181.582 222.728-501.81 62.614-642.244 40.252-59.93 86.765-200.366 650.294-198.577 779.1 86.766-29.517 141.33 2.684 219.15 33.097 275.503 106.444 34.885 200.366-75.137 172.636-75.137-17.89-98.394-67.086-142.224-98.393m360.48-1285.383c111.81 21.468 211.1 67.982 305.915 115.39 154.747 76.926 182.476 66.192 196.788 173.53 1.789 19.68-1.789 30.413 54.564 48.303 94.816 29.518-54.564-23.257 199.471-22.362 151.169.894 497.337 61.72 609.148 132.384 46.513 29.519 37.568 67.087 194.999 62.615-1.79-185.16-50.986-461.557-123.44-631.51-88.554-205.733-205.733-237.04-444.561-313.966-139.54-44.725-549.217-93.922-676.235-15.207-118.967 74.243-141.33 162.798-252.246 318.439-32.202 45.619-43.83 80.504-64.403 132.384\"/><path d=\"M1720.14 1966.675c89.45 36.674-4.472 273.714-128.806 216.466-40.252-113.6 55.458-178.003 81.398-228.99-53.67-8.05-206.627-32.2-252.246-15.206-59.036 22.363-72.454 148.486-42.041 207.522 143.118 280.87 775.523 220.94 708.436 2.684-26.835-88.555-51.88-102.867-142.224-133.28-72.454-24.15-144.907-49.196-224.517-49.196m-1124.374-31.307c71.56 68.875 233.462 79.61 338.117 84.976 13.418-138.646 25.046-242.407 135.963-234.356 54.564 74.242 25.94 161.902-31.307 218.255 97.5-.894 153.852-74.242 139.54-180.687-82.293-59.036-331.856-177.109-457.084-194.104-34.885 37.569-120.756 243.301-125.229 305.916\"/></g><path d=\"M427.602 2820.913c59.036-5.367 212.889 39.357 225.412 89.449-95.71 11.628-217.361 2.683-225.412-89.45zm-52.775 50.986c43.83 31.307 67.087 80.504 142.224 98.393 110.022 27.73 350.64-66.192 75.137-172.636-77.82-30.413-132.384-62.614-219.15-33.096-1.789-128.807 138.646-692.336 198.577-779.101 140.435 22.362 460.662 182.476 642.244-40.252 172.636 9.84 39.357 110.917 148.485 255.824 56.353 74.243 112.706 139.54 237.04 160.114 93.921 16.1 273.714 10.734 365.846-14.312 136.857-35.78 171.742-70.665 175.32-224.517l151.17 33.99c-18.785 136.858-195 365.847-305.916 447.246-152.958 111.81-291.604 178.898-483.025 262.085-84.976 36.674-158.325 103.761-248.668 124.334-172.637 38.463-680.707 101.972-825.614 20.574-39.358-21.468-53.67-82.294-53.67-138.646M1626.22 2131.26c6.261-59.037 28.623-92.133 63.508-116.284 24.152 51.88-18.784 101.972-63.508 116.284m93.921-164.586c79.61 0 152.063 25.045 224.517 49.197 90.344 30.412 115.39 44.724 142.224 133.279 67.087 218.255-565.318 278.186-708.436-2.684-30.413-59.036-16.995-185.16 42.041-207.522 45.619-16.995 198.577 7.156 252.246 15.207-25.94 50.986-121.65 115.389-81.398 228.99 124.334 57.247 218.255-179.793 128.806-216.467m-730.798 10.734c.894-61.72-1.79-117.179 54.564-141.33 20.573 47.408-13.418 114.495-54.564 141.33m-393.576-42.041c4.473-62.615 90.344-268.347 125.229-305.916 125.228 16.995 374.791 135.068 457.084 194.104 14.312 106.445-42.04 179.793-139.54 180.687 57.247-56.353 85.87-144.013 31.307-218.255-110.917-8.05-122.545 95.71-135.963 234.356-104.655-5.367-266.558-16.1-338.117-84.976m-89.449-71.56c-33.096-91.238-33.096-233.462 107.339-245.09l-71.56 199.471c-18.783 42.936-18.783 33.096-35.779 45.62zm228.99-277.292c20.573-51.88 32.201-86.765 64.403-132.384 110.917-155.641 133.279-244.196 252.246-318.439 127.018-78.715 536.694-29.518 676.235 15.207 238.828 76.926 356.007 108.233 444.561 313.966 72.454 169.953 121.65 446.35 123.44 631.51-157.43 4.472-148.486-33.096-195-62.615-111.81-70.664-457.978-131.49-609.147-132.384-254.035-.895-104.655 51.88-199.471 22.362-56.353-17.89-52.775-28.624-54.564-48.302-14.312-107.34-42.041-96.605-196.788-173.531-94.816-47.408-194.104-93.922-305.915-115.39m1583.247-43.83c-16.995-56.352 14.312-52.775 68.876-91.238 31.307-22.362 56.353-45.619 94.816-67.086 144.013-80.504 412.36-93.922 526.854 1.789 46.514 38.463 122.545 113.6 110.917 211.994-24.151 195.893-158.325 303.232-268.347 392.68-111.811 91.239-297.865 185.16-490.18 122.546-16.101-39.358-3.578-288.92-22.363-381.053-16.995-82.293-8.05-91.238 39.358-140.435 139.54-144.907 441.878-250.457 613.62-126.123 72.454 53.67 51.88 74.243 89.449 115.39 46.513-50.092-40.252-218.256-360.48-207.522-217.36 7.156-311.282 177.109-402.52 169.058m-1302.377-508.964c4.472-124.335 118.967-381.948 233.461-471.397 138.646-107.338 283.554-208.416 496.442-87.66 52.775 29.519 50.092 44.725 55.459 118.073 4.472 70.665-1.79 96.605-19.679 153.852-141.33 456.19-259.402 194.105-712.014 302.338 16.995-148.485 145.802-280.87 217.361-349.746 122.545-118.967 211.1-195.893 395.365-170.847 50.986 84.976 56.352 138.646-5.367 237.934-82.293 132.385-102.867 124.334-90.344 214.678 64.403-16.101 84.082-78.715 113.6-141.33 179.793-375.686-81.398-421.305-241.512-352.429-107.339 45.62-298.76 256.719-361.374 383.736-12.523 25.046-25.94 57.248-37.568 84.977zm708.436 18.784c18.784-111.811 129.7-139.54 129.7-483.92 0-148.485-182.475-281.764-421.304-182.475-204.838 84.082-236.145 148.485-345.273 313.071-102.867 155.642-99.289 326.49-187.843 470.502-25.94 41.147-49.197 55.458-77.82 96.605-20.574 30.413-35.78 68.876-56.354 104.655-42.04 68.876-84.976 118.968-118.967 201.26-107.339 2.684-197.682 4.473-208.416 115.39-14.312 152.063 57.247 189.632 57.247 246.879-.894 61.72-251.351 684.285-181.581 1055.498 19.679 101.972 86.765 102.867 194.104 115.39 258.508 31.307 593.942 20.573 825.614-72.454l420.41-201.26c106.445-59.931 285.343-173.532 364.953-256.72 56.353-58.141 85.87-107.338 134.173-176.214 66.192-96.605 67.981-94.816 82.293-226.306 87.66 16.101 251.352 54.564 305.916 101.972-6.262 61.72-36.674 32.202-36.674 87.66 34.885.895 93.027-42.935 107.339-91.238-36.675-53.67-75.138-44.724-127.913-87.66 42.042-33.096 118.073-48.302 176.215-72.453 125.229-51.88 339.012-209.311 391.787-352.43 42.04-115.389 10.734-307.704-57.248-382.841-71.559-78.715-237.934-118.967-373.897-118.967-161.902 0-329.172 116.283-459.767 166.375-50.092-43.83-53.67-93.922-90.344-142.224-42.04-57.248-315.755-200.366-446.35-228.095\"/><path fill=\"#efebe9\" d=\"M2318.554 1542.686c91.238 8.05 185.16-161.902 402.52-169.058 320.228-10.734 406.993 157.43 360.48 207.521-37.569-41.146-16.995-61.72-89.45-115.389-171.741-124.334-474.079-18.784-613.62 126.123-47.407 49.197-56.352 58.142-39.357 140.435 18.785 92.133 6.262 341.695 22.362 381.053 192.316 62.614 378.37-31.307 490.181-122.545 110.022-89.45 244.196-196.788 268.347-392.681 11.628-98.394-64.403-173.531-110.917-211.994-114.494-95.71-382.841-82.293-526.854-1.79-38.463 21.468-63.51 44.725-94.816 67.087-54.564 38.464-85.871 34.886-68.876 91.238m-1302.377-508.964 43.83-77.821c11.628-27.73 25.045-59.93 37.568-84.977 62.614-127.017 254.035-338.117 361.374-383.736 160.114-68.876 421.305-23.257 241.512 352.43-29.518 62.614-49.197 125.228-113.6 141.329-12.523-90.344 8.05-82.293 90.344-214.678 61.72-99.288 56.353-152.958 5.367-237.934-184.265-25.046-272.82 51.88-395.365 170.847-71.56 68.876-200.366 201.26-217.361 349.746 452.612-108.233 570.685 153.852 712.014-302.338 17.89-57.247 24.151-83.187 19.679-153.852-5.367-73.348-2.684-88.554-55.459-118.073-212.888-120.756-357.796-19.678-496.442 87.66-114.494 89.45-228.989 347.062-233.461 471.397\"/><path fill=\"#eee\" d=\"M506.317 1863.808c16.996-12.523 16.996-2.683 35.78-45.619l71.559-199.47c-140.435 11.627-140.435 153.851-107.339 245.09z\"/><path fill=\"#efebe9\" d=\"M653.014 2910.362c-12.523-50.092-166.376-94.816-225.412-89.45 8.05 92.133 129.701 101.078 225.412 89.45\"/>"],
			"elixir": ["0 0 24 24","<path fill=\"#9575cd\" d=\"M12.173 22.681c-3.86 0-6.99-3.64-6.99-8.13 0-3.678 2.773-8.172 4.916-10.91 1.014-1.296 2.93-2.322 2.93-2.322s-.982 5.239 1.683 7.319c2.366 1.847 4.106 4.25 4.106 6.363 0 4.232-2.784 7.68-6.645 7.68\"/>"],
			"epub": ["0 0 16 16","<path fill=\"#8bc34a\" d=\"M8 12.401 3.601 8 8 3.601l1.468 1.466L6.534 8 8 9.467l4.4-4.4-3.833-3.832a.8.8 0 0 0-1.133 0L1.235 7.434a.8.8 0 0 0 0 1.133l6.199 6.199a.8.8 0 0 0 1.133 0l6.199-6.199a.803.803 0 0 0 0-1.133l-.9-.899z\"/>"],
			"erlang": ["0 0 30 30","<path fill=\"#f44336\" d=\"M5.207 4.33q-.072.075-.143.153Q1.5 8.476 1.5 15.33c0 4.418 1.155 7.862 3.459 10.34h19.415c2.553-1.152 4.127-3.43 4.127-3.43l-3.147-2.52L23.9 21.1c-.867.773-.845.931-2.315 1.78-1.495.674-3.04.966-4.634.966-2.515 0-4.423-.909-5.723-2.059-1.286-1.15-1.985-4.511-2.096-6.68l17.458.067-.183-1.472s-.847-7.129-2.541-9.372zm8.76.846c1.565 0 3.22.535 3.961 1.471.74.937.931 1.667.973 3.524H9.11c.112-1.955.436-2.81 1.373-3.698.936-.887 2.03-1.297 3.484-1.297\"/>"],
			"eslint": ["0 0 32 32","<path fill=\"#3f51b5\" d=\"M22.713 4H9.287a.5.5 0 0 0-.432.248l-6.708 11.5a.5.5 0 0 0 0 .504l6.708 11.5a.5.5 0 0 0 .432.248h13.426a.5.5 0 0 0 .432-.248l6.708-11.5a.5.5 0 0 0 0-.504l-6.708-11.5A.5.5 0 0 0 22.713 4m-6.937 20.888-7.5-3.75A.5.5 0 0 1 8 20.691v-9.382a.5.5 0 0 1 .276-.447l7.5-3.75a.5.5 0 0 1 .448 0l7.5 3.75a.5.5 0 0 1 .276.447v9.382a.5.5 0 0 1-.276.447l-7.5 3.75a.5.5 0 0 1-.448 0\"/><path fill=\"#7986cb\" d=\"M22 19.441v-6.882a.5.5 0 0 0-.276-.447l-5.5-2.75a.5.5 0 0 0-.448 0l-5.5 2.75a.5.5 0 0 0-.276.447v6.882a.5.5 0 0 0 .276.447l5.5 2.75a.5.5 0 0 0 .448 0l5.5-2.75a.5.5 0 0 0 .276-.447\"/>"],
			"exe": ["0 0 32 32","<path fill=\"#e64a19\" d=\"M28 4H4a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h24a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 22H4V10h24Z\"/>"],
			"figma": ["0 0 32 32","<path fill=\"#f4511e\" d=\"M12 4h4v8h-4a4 4 0 0 1-4-4 4 4 0 0 1 4-4\"/><path fill=\"#ff8a65\" d=\"M20 12h-4V4h4a4 4 0 0 1 4 4 4 4 0 0 1-4 4\"/><rect width=\"8\" height=\"8\" x=\"16\" y=\"12\" fill=\"#29b6f6\" rx=\"4\" transform=\"rotate(180 20 16)\"/><path fill=\"#7c4dff\" d=\"M12 12h4v8h-4a4 4 0 0 1-4-4 4 4 0 0 1 4-4\"/><path fill=\"#00e676\" d=\"M12 20h4v4a4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4\"/>"],
			"file": ["0 0 16 16","<path d=\"m8.668 6h3.6641l-3.6641-3.668v3.668m-4.668-4.668h5.332l4 4v8c0 0.73828-0.59375 1.3359-1.332 1.3359h-8c-0.73828 0-1.332-0.59766-1.332-1.3359v-10.664c0-0.74219 0.59375-1.3359 1.332-1.3359m3.332 1.3359h-3.332v10.664h8v-6h-4.668z\" fill=\"#90a4ae\" />"],
			"firebase": ["0 0 24 24","<path fill=\"#ff9100\" d=\"M18.217 8.974c-.45-.623-1.482-1.904-3.07-3.808-.689-.825-1.28-1.526-1.57-1.87l-.408-.48-.173-.205-.094-.11-.018-.027-.008-.004-.4-.47-.509.407a11.1 11.1 0 0 0-3.069 3.866 9.5 9.5 0 0 0-.87 2.647q-.06.303-.1.615a9 9 0 0 0-.577-.03 6.2 6.2 0 0 0-1.901.229l-.265.074-.136.238a8 8 0 0 0-1.044 3.68 8 8 0 0 0 5.006 7.697l.197.079.06.02h.002a8 8 0 0 0 2.452.473q.143.005.286.005a7.9 7.9 0 0 0 3.076-.618l.007.003.261-.12a7.99 7.99 0 0 0 4.643-6.981 8.5 8.5 0 0 0-1.778-5.31M9.837 19.82l-.192-.074-.051-.02a6.31 6.31 0 0 1-3.897-6.048 6.2 6.2 0 0 1 .697-2.667 4.6 4.6 0 0 1 .759-.103l.065-.002a8 8 0 0 1 .378 0c.108.005.215.021.322.034a13 13 0 0 0 .918 4.007 10.1 10.1 0 0 0 2.474 3.61 6.4 6.4 0 0 1-1.473 1.263m.351-5.486a11.4 11.4 0 0 1-.767-3.125 4.6 4.6 0 0 1 .95.461 4.73 4.73 0 0 1 1.94 2.884 5 5 0 0 1 .12.649 4.2 4.2 0 0 1-.288 2.023 8.3 8.3 0 0 1-1.955-2.892m1.741 5.858a8 8 0 0 0 .553-.62c.233.177.485.332.73.495a6.3 6.3 0 0 1-1.283.125m5.432-2.97a6.34 6.34 0 0 1-2.212 2.138 12.4 12.4 0 0 1-1.851-1.15 5.84 5.84 0 0 0 .309-3.998 6.02 6.02 0 0 0-2.504-3.664 6.1 6.1 0 0 0-1.679-.74 8 8 0 0 1 .064-.496 9 9 0 0 1 .465-1.598q.117-.298.253-.584l.004-.007c.14-.282.296-.567.481-.872l.073-.12h-.002a9.2 9.2 0 0 1 1.534-1.824l.227.269c.53.628 1.03 1.222 1.483 1.765 1.02 1.223 2.342 2.828 2.852 3.536a6.8 6.8 0 0 1 1.446 4.242 6.3 6.3 0 0 1-.943 3.104\"/>"],
			"font": ["0 0 32 32","<path fill=\"#f44336\" d=\"M24 28h4L18 4h-4L4 28h4l8-19.422\"/><path fill=\"#f44336\" d=\"M8 20h16v4H8z\"/>"],
			"fsharp": ["0 0 500 500","<path fill=\"#0288d1\" d=\"m236.249 36.066-213.94 213.94 213.94 213.94v-84.36l-129.7-129.7 129.7-129.7z\"/><path fill=\"#0288d1\" d=\"m236.249 156.017-93.622 93.62 93.622 93.622z\"/><path fill=\"#00b8d4\" d=\"m263.759 36.047 213.94 213.94-213.94 213.94v-84.36l129.7-129.7-129.7-129.7z\"/>"],
			"gemfile": ["0 0 32 32","<path fill=\"#e53935\" d=\"M21.184 10.016V10H10.881l.016.033-.016-.017L8 14l8.032 10L24 14z\"/><path fill=\"#e53935\" d=\"m16 3.455 11 6.286v12.518l-11 6.286-11-6.286V9.741zM16 0 2 8v16l14 8 14-8V8z\"/>"],
			"git": ["0 0 32 32","<path fill=\"#e64a19\" d=\"M13.172 2.828 11.78 4.22l1.91 1.91 2 2A2.986 2.986 0 0 1 20 10.81a3.25 3.25 0 0 1-.31 1.31l2.06 2a2.68 2.68 0 0 1 3.37.57 2.86 2.86 0 0 1 .88 2.117 3.02 3.02 0 0 1-.856 2.109A2.9 2.9 0 0 1 23 19.81a2.93 2.93 0 0 1-2.13-.87 2.694 2.694 0 0 1-.56-3.38l-2-2.06a3 3 0 0 1-.31.12V20a3 3 0 0 1 1.44 1.09 2.92 2.92 0 0 1 .56 1.72 2.88 2.88 0 0 1-.878 2.128 2.98 2.98 0 0 1-2.048.871 2.981 2.981 0 0 1-2.514-4.719A3 3 0 0 1 16 20v-6.38a2.96 2.96 0 0 1-1.44-1.09 2.9 2.9 0 0 1-.56-1.72 2.9 2.9 0 0 1 .31-1.31l-3.9-3.9-7.579 7.572a4 4 0 0 0-.001 5.658l10.342 10.342a4 4 0 0 0 5.656 0l10.344-10.344a4 4 0 0 0 0-5.656L18.828 2.828a4 4 0 0 0-5.656 0\"/>"],
			"go": ["0 0 32 32","<path fill=\"#00acc1\" d=\"M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4zm16.954-5H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .003-1.5\"/><path fill=\"#00acc1\" d=\"M26.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z\"/>"],
			"go-mod": ["0 0 32 32","<path fill=\"#ec407a\" d=\"M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4zm16.954-5H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .003-1.5\"/><path fill=\"#ec407a\" d=\"M26.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z\"/>"],
			"gradle": ["0 0 32 32","<path fill=\"#0097a7\" d=\"M16 10v2h6c-2 0-3-2-6-2\"/><path fill=\"#0097a7\" d=\"M26 4h-2a4 4 0 0 0-4 4h4a1 1 0 0 1 2 0v4H16v-2h-5.317A2.683 2.683 0 0 0 8 12.683v2.634A2.683 2.683 0 0 0 10.683 18H16v2h-5.98A4.02 4.02 0 0 1 6 16v-2c-2 0-4 4-4 8 0 5 1 6 2 6h4v-4h4v4h4v-4h4v4h4v-6a2 2 0 0 0 2-2v-2a4 4 0 0 0 4-4V8a4 4 0 0 0-4-4m-4 12h-2a2 2 0 0 1-2-2h6a2 2 0 0 1-2 2\"/>"],
			"graphql": ["0 0 32 32","<path fill=\"#ec407a\" d=\"M6 20h20v2H6z\"/><circle cx=\"7\" cy=\"21\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"16\" cy=\"27\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"25\" cy=\"21\" r=\"3\" fill=\"#ec407a\"/><path fill=\"#ec407a\" d=\"M6 10h20v2H6z\"/><circle cx=\"7\" cy=\"11\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"16\" cy=\"5\" r=\"3\" fill=\"#ec407a\"/><circle cx=\"25\" cy=\"11\" r=\"3\" fill=\"#ec407a\"/><path fill=\"#ec407a\" d=\"M6 12h2v10H6zm18-2h2v12h-2z\"/><path fill=\"#ec407a\" d=\"m5.014 19.41 11.674 6.866L15.674 28 4 21.134z\"/><path fill=\"#ec407a\" d=\"M26.688 21.724 15.014 28.59 14 26.866 25.674 20zM5.124 10.382l11.415-7.29 1.077 1.686L6.2 12.068z\"/><path fill=\"#ec407a\" d=\"m25.798 12.067-11.415-7.29 1.077-1.685 11.415 7.29zM6.2 19.932l11.416 7.29-1.077 1.686-11.415-7.29z\"/><path fill=\"#ec407a\" d=\"m26.875 21.619-11.415 7.29-1.077-1.687 11.415-7.289zM5.877 22.6 16.04 3.686l1.762.946L7.638 23.546z\"/><path fill=\"#ec407a\" d=\"M24.361 23.545 14.197 4.633l1.761-.947 10.165 18.913z\"/>"],
			"groovy": ["0 0 32 32","<path fill=\"#26c6da\" d=\"M19.322 2a6.5 6.5 0 0 1 4.352 1.419 4.55 4.55 0 0 1 1.685 3.662 5.82 5.82 0 0 1-1.886 4.275 6.04 6.04 0 0 1-4.34 1.846 4.15 4.15 0 0 1-2.385-.649 1.91 1.91 0 0 1-.936-1.603 1.6 1.6 0 0 1 .356-1.024 1.1 1.1 0 0 1 .861-.447q.469 0 .468.504a.79.79 0 0 0 .358.693 1.43 1.43 0 0 0 .826.245 3.1 3.1 0 0 0 2.39-1.573 5.66 5.66 0 0 0 1.154-3.39 2.64 2.64 0 0 0-.891-2.064 3.28 3.28 0 0 0-2.293-.812 6.18 6.18 0 0 0-4.086 1.736 12.9 12.9 0 0 0-3.215 4.557 13.4 13.4 0 0 0-1.233 5.36 5.86 5.86 0 0 0 1.091 3.723 3.53 3.53 0 0 0 2.905 1.372q3.058 0 5.848-4.002l2.935-.388q.546-.07.545.246a8 8 0 0 1-.423 1.24q-.421 1.097-1.152 3.668A12.7 12.7 0 0 0 26 17.72v1.66a14.2 14.2 0 0 1-4.055 2.57 10.38 10.38 0 0 1-2.764 5.931 6.7 6.7 0 0 1-4.806 2.11 3.3 3.3 0 0 1-2.012-.55 1.8 1.8 0 0 1-.718-1.514q0-2.685 5.634-5.212.532-1.766 1.152-3.507a8.6 8.6 0 0 1-2.853 2.323 7.4 7.4 0 0 1-3.48 1.01 5.46 5.46 0 0 1-4.366-2.093A8.1 8.1 0 0 1 6 15.122a11.6 11.6 0 0 1 1.966-6.426 14.7 14.7 0 0 1 5.162-4.862A12.44 12.44 0 0 1 19.322 2m-2.407 22.17q-4.055 1.875-4.054 3.695a.87.87 0 0 0 .999.97q1.964 0 3.055-4.665\"/>"],
			"h": ["0 0 32 32","<path fill=\"#0288d1\" d=\"M18.5 11a5.49 5.49 0 0 0-4.5 2.344V4H8v24h6V17a2 2 0 0 1 4 0v11h6V16.5a5.5 5.5 0 0 0-5.5-5.5\"/>"],
			"haskell": ["0 0 300 300","<g stroke-width=\"2.422\"><path fill=\"#ef5350\" d=\"m23.928 240.5 59.94-89.852-59.94-89.855h44.955l59.94 89.855-59.94 89.852z\"/><path fill=\"#ffa726\" d=\"m83.869 240.5 59.94-89.852-59.94-89.855h44.955l119.88 179.71h-44.95l-37.46-56.156-37.468 56.156z\"/><path fill=\"#ffee58\" d=\"m228.72 188.08-19.98-29.953h69.93v29.956h-49.95zm-29.97-44.924-19.98-29.953h99.901v29.953z\"/></g>"],
			"hex": ["0 0 32 32","<path fill=\"#26a69a\" d=\"M4 8v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2m4 14V10h4v12Zm11.999-6L18 18.001 21 21l-3 3.001L19.999 26l3.003-3 3 2.999L28 24l-3-2.999 3-3L26.001 16l-3 3z\"/>"],
			"hpp": ["0 0 32 32","<path fill=\"#0288d1\" d=\"M28 6V2h-2v4h-6V2h-2v4h-4v2h4v4h2V8h6v4h2V8h4V6zm-15.5 5A5.49 5.49 0 0 0 8 13.344V4H2v24h6V17a2 2 0 0 1 4 0v11h6V16.5a5.5 5.5 0 0 0-5.5-5.5\"/>"],
			"html": ["0 0 32 32","<path fill=\"#e65100\" d=\"m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z\"/>"],
			"image": ["0 0 16 16","<path fill=\"#26a69a\" d=\"M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9\"/>"],
			"jar": ["0 0 32 32","<path fill=\"#f44336\" d=\"M22 10h2v4h-2z\"/><path fill=\"#f44336\" d=\"M28 2H4a2 2 0 0 0-2 2v24a2 2 0 0 0 2 2h24a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2m-2 12a2 2 0 0 1-2 2h-2v4a4 4 0 0 1-4 4h-8a4 4 0 0 1-4-4V8h18a2 2 0 0 1 2 2Z\"/>"],
			"java": ["0 0 32 32","<path fill=\"#f44336\" d=\"M4 26h24v2H4zM28 4H7a1 1 0 0 0-1 1v13a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 8h-4V6h4Z\"/>"],
			"javascript": ["0 0 16 16","<path fill=\"#ffca28\" d=\"M2 2v12h12V2zm6 6h1v4a1.003 1.003 0 0 1-1 1H7a1.003 1.003 0 0 1-1-1v-1h1v1h1zm3 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1\"/>"],
			"jsconfig": ["0 0 32 32","<path fill=\"#757575\" d=\"M15 2H6a2.006 2.006 0 0 0-2 2v22a2.006 2.006 0 0 0 2 2h6v-4H6v-2h6v-2H6v-2h6v-2H6v-2h6v-2h2V4l8 8h2v-1Z\" data-mit-no-recolor=\"true\"/><path fill=\"#ffca28\" d=\"M12 12v18h18V12zm8 12a2.006 2.006 0 0 1-2 2h-2a2.006 2.006 0 0 1-2-2v-2h2v2h2v-8h2zm8-6h-4v2h2a2.006 2.006 0 0 1 2 2v2a2.006 2.006 0 0 1-2 2h-4v-2h4v-2h-2a2.006 2.006 0 0 1-2-2v-2a2.006 2.006 0 0 1 2-2h4z\"/>"],
			"json": ["0 -960 960 960","<path fill=\"#f9a825\" d=\"M560-160v-80h120q17 0 28.5-11.5T720-280v-80q0-38 22-69t58-44v-14q-36-13-58-44t-22-69v-80q0-17-11.5-28.5T680-720H560v-80h120q50 0 85 35t35 85v80q0 17 11.5 28.5T840-560h40v160h-40q-17 0-28.5 11.5T800-360v80q0 50-35 85t-85 35zm-280 0q-50 0-85-35t-35-85v-80q0-17-11.5-28.5T120-400H80v-160h40q17 0 28.5-11.5T160-600v-80q0-50 35-85t85-35h120v80H280q-17 0-28.5 11.5T240-680v80q0 38-22 69t-58 44v14q36 13 58 44t22 69v80q0 17 11.5 28.5T280-240h120v80z\"/>"],
			"julia": ["0 0 50 50","<g transform=\"translate(.21 -247.01)\"><circle cx=\"13.497\" cy=\"281.63\" r=\"9.555\" fill=\"#c62828\"/><circle cx=\"36.081\" cy=\"281.63\" r=\"9.555\" fill=\"#7e57c2\"/><circle cx=\"24.722\" cy=\"262.39\" r=\"9.555\" fill=\"#388e3c\"/></g>"],
			"jupyter": ["0 0 32 32","<path fill=\"#f57c00\" d=\"M6.2 18a22.7 22.7 0 0 0 9.8 2 22.7 22.7 0 0 0 9.8-2 10.002 10.002 0 0 1-19.6 0m19.6-4a22.7 22.7 0 0 0-9.8-2 22.7 22.7 0 0 0-9.8 2 10.002 10.002 0 0 1 19.6 0\"/><circle cx=\"27\" cy=\"5\" r=\"3\" fill=\"#757575\"/><circle cx=\"5\" cy=\"27\" r=\"3\" fill=\"#9e9e9e\"/><circle cx=\"5\" cy=\"5\" r=\"3\" fill=\"#616161\"/>"],
			"kotlin": ["0 0 24 24","<defs><linearGradient id=\"kotlin-a\" x1=\"1.725\" x2=\"22.185\" y1=\"22.67\" y2=\"1.982\" gradientTransform=\"translate(1.306 1.129)scale(.89324)\" gradientUnits=\"userSpaceOnUse\"><stop offset=\"0\" stop-color=\"#7c4dff\"/><stop offset=\".5\" stop-color=\"#d500f9\"/><stop offset=\"1\" stop-color=\"#ef5350\"/></linearGradient></defs><path fill=\"url(#kotlin-a)\" d=\"M2.975 2.976v18.048h18.05v-.03l-4.478-4.511-4.48-4.515 4.48-4.515 4.443-4.477z\"/>"],
			"lerna": ["0 0 24 24","<path fill=\"#448aff\" d=\"M7.57 8.21c-.41.08-.99.06-1.26.06-.4 0-1.27-.48-1.75-.98-.25-.26-.71-.82-1.01-1.25-.31-.43-.62-.78-.71-.78-.17 0-.28.6-.29 1.6 0 .12-.01.22-.01.31l.01.03-.14 8.47c.27.07.54.13.82.19.58.12 1.06.22 1.08.23.01.02-.19.34-.45.71-.95 1.35-1.14 2-.6 2 .17 0 .53-.07.82-.17.33-.1.93-.16 1.58-.16 1.34 0 2.68.33 4.37 1.08 1.61.71 2.14.88 4 1.25.85.18 1.59.37 1.64.41.05.05-.07.22-.28.38s-.38.33-.38.37.22.04.51-.01c.27-.04.89-.14 1.36-.19 1.43-.18 2.45-.82 2.47-1.56.04-.94-.25-3.03-.43-3.14-.02-.01-.38.11-.46.24-.07.13-.16.33-.25.56-.18.46-.15.56-1.57.66-1.03.05-2.02-.19-2.82-.65-.67-.39-1.66-.74-2.18-1.54-.42-.65-.86-1.72-.78-1.87.03-.04.17-.03.32.02.39.15.96.38 2.73.15 1.54-.2 3-.04 3.39.16s.92.47.94.99c.01.52.33.63.36.63.17-.03.59-1.42.83-1.83.2-.32.31-.5 1.1-1.04.62-.43 1.13-.83 1.11-.9-.01-.06-.36-.47-.77-.92-.65-.7-.83-.82-1.42-1.02-2.05-.67-4.23-2.12-5.36-3.54-1.25-1.58-1.6-1.94-2.5-2.53-1.01-.67-2.32-1.24-3.3-1.43-1-.19-.72.13-.29.8 1.53 1.75 1.49 1.81 1.49 2.97-.16.9-1 1.03-1.92 1.24m3.17 1.03c.17 0 .58.11 1.29.35 1.74.58 1.84.85 2.41 1.85.13.22.22.41.21.42s-.17.05-.35.09c-.45.09-1.16.09-1.58 0-.76-.16-.72-.19-1.11-.57-.16-.16-.35-.42-.41-.56-.04-.1-.03-.12.19-.3.05-.04.1-.11.1-.15 0-.07-.22-.37-.34-.47-.13-.11-.49-.54-.49-.59 0-.03.03-.05.1-.05z\"/>"],
			"less": ["0 0 24 24","<path fill=\"#0277bd\" d=\"M8 3a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2H3v2h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2v-2H8v-5a2 2 0 0 0-2-2 2 2 0 0 0 2-2V5h2V3m6 0a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1v2h-1a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2v-2h2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5h-2V3z\"/>"],
			"license": ["0 0 16 16","<path fill=\"#ff5722\" d=\"M8 1a5.5 5.5 0 0 0-4 9.26V15l4-1.5 4 1.5v-4.74A5.49 5.49 0 0 0 8 1m0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8m0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4\"/>"],
			"lock": ["0 0 32 32","<path fill=\"#ffd54f\" d=\"M25 12h-3V8a6 6 0 0 0-12 0v4H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V13a1 1 0 0 0-1-1M14 8a2 2 0 0 1 4 0v4h-4Zm2 17a4 4 0 1 1 4-4 4 4 0 0 1-4 4\"/>"],
			"log": ["0 0 24 24","<path d=\"M0 0h24v24H0z\"/><path fill=\"#afb42b\" d=\"M19 5v9h-5v5H5V5zm0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h10l6-6V5c0-1.1-.9-2-2-2m-7 11H7v-2h5zm5-4H7V8h10z\"/>"],
			"lua": ["0 0 32 32","<path fill=\"#42a5f5\" d=\"M30 6a3.86 3.86 0 0 1-1.167 2.833 4.024 4.024 0 0 1-5.666 0A3.86 3.86 0 0 1 22 6a3.86 3.86 0 0 1 1.167-2.833 4.024 4.024 0 0 1 5.666 0A3.86 3.86 0 0 1 30 6m-9.208 5.208A10.6 10.6 0 0 0 13 8a10.6 10.6 0 0 0-7.792 3.208A10.6 10.6 0 0 0 2 19a10.6 10.6 0 0 0 3.208 7.792A10.6 10.6 0 0 0 13 30a10.6 10.6 0 0 0 7.792-3.208A10.6 10.6 0 0 0 24 19a10.6 10.6 0 0 0-3.208-7.792m-1.959 7.625a4.024 4.024 0 0 1-5.666 0 4.024 4.024 0 0 1 0-5.666 4.024 4.024 0 0 1 5.666 0 4.024 4.024 0 0 1 0 5.666\"/>"],
			"makefile": ["0 0 32 32","<path fill=\"#ef5350\" d=\"m29.5 24.02-1.6-.92a4.4 4.4 0 0 0 .09-.9A1.3 1.3 0 0 0 28 22a5.6 5.6 0 0 0-.1-1.1l1.6-.92a.493.493 0 0 0 .18-.68l-1.5-2.6a.45.45 0 0 0-.18-.18V6.01a2.006 2.006 0 0 0-2-2H4a2.006 2.006 0 0 0-2 2V22a2.006 2.006 0 0 0 2 2h10.53l-.03.02a.493.493 0 0 0-.18.68l1.5 2.6a.493.493 0 0 0 .68.18l1.6-.92a5.9 5.9 0 0 0 1.9 1.09v1.85a.495.495 0 0 0 .5.5h3a.495.495 0 0 0 .5-.5v-1.85a5.9 5.9 0 0 0 1.9-1.09l1.6.92a.493.493 0 0 0 .68-.18l1.5-2.6a.493.493 0 0 0-.18-.68M24 22.01a1.99 1.99 0 0 1-.88 1.65l-.18.11a2.04 2.04 0 0 1-1.88 0l-.18-.11a1.99 1.99 0 0 1-.88-1.65V22a2 2 0 0 1 .88-1.66l.18-.11a2.04 2.04 0 0 1 1.88 0l.18.11A2 2 0 0 1 24 22Zm2-4.63-.1.06a5.9 5.9 0 0 0-1.9-1.09V14.5a.495.495 0 0 0-.5-.5h-3a.495.495 0 0 0-.5.5v1.85a5.9 5.9 0 0 0-1.9 1.09l-1.6-.92a.493.493 0 0 0-.68.18l-1.5 2.6a.493.493 0 0 0 .18.68l1.6.92A5.6 5.6 0 0 0 16 22v.01L4 22V10.01h22Z\"/>"],
			"markdown": ["0 0 32 32","<path fill=\"#42a5f5\" d=\"m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z\"/>"],
			"maven": ["0 0 24 24","<defs><linearGradient id=\"maven-a\" x1=\".125\" x2=\"0\" y1=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#ab47bc\"/><stop offset=\"37.5%\" stop-color=\"#ab47bc\"/><stop offset=\"37.501%\" stop-color=\"#d32f2f\"/><stop offset=\"54.25%\" stop-color=\"#d32f2f\"/><stop offset=\"54.251%\" stop-color=\"#ff7043\"/><stop offset=\"69.75%\" stop-color=\"#ff7043\"/><stop offset=\"69.751%\" stop-color=\"#ffa726\"/><stop offset=\"100%\" stop-color=\"#ffa726\"/></linearGradient></defs><path fill=\"url(#maven-a)\" d=\"M22 2s-7.64-.37-13.66 7.88C3.72 16.21 2 22 2 22l1.94-1c1.44-2.5 2.19-3.53 3.6-5 2.53.74 5.17.65 7.46-2-2-.56-3.6-.43-5.96-.19C11.69 12 13.5 11.6 16 12l1-2c-1.8-.34-3-.37-4.78.04C14.19 8.65 15.56 7.87 18 8l1.11-1.73c-1.53-.06-2.4-.02-4.19.3 1.61-1.46 3.08-2.12 5.22-2.25 0 0 1.05-1.89 1.86-2.32\"/>"],
			"mdx": ["0 0 32 32","<path fill=\"#ffca28\" d=\"m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z\"/>"],
			"netlify": ["0 0 24 24","<path fill=\"#00bfa5\" d=\"m11.25 2.232-.127.127v4.567l.127.129h1.526l.126-.13V2.36l-.126-.127H11.25zM6.69 5.455 5.643 6.5v.21l1.6 1.6h1.108l.148-.148V7.055l-1.6-1.6zM1.026 11.11l-.127.127v1.528l.127.127h6.09l.127-.127v-1.528l-.127-.127zm15.858 0-.127.127v1.528l.127.127h6.09l.127-.127v-1.528l-.127-.127zm-9.64 4.58-1.6 1.6v.21l1.045 1.046h.21l1.6-1.6v-1.109l-.148-.146zm4.005 1.256-.127.13v4.566l.127.127h1.526l.126-.127v-4.567l-.126-.129z\"/><path fill=\"#cfd8dc\" d=\"M14.855 15.172h-1.523l-.127-.127V11.48c0-.634-.249-1.125-1.013-1.142-.394-.01-.844 0-1.325.019l-.072.074v4.61l-.127.128H9.146l-.128-.127V8.956l.128-.127h3.425a2.41 2.41 0 0 1 2.41 2.41v3.806z\"/>"],
			"nim": ["0 0 32 32","<path fill=\"#ffca28\" d=\"M6 24h20v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM30 6l-9 9-5-11-5 11-9-9 4 14h20z\"/>"],
			"nodejs": ["0 0 32 32","<path fill=\"#8bc34a\" d=\"M16 20.003v2h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-2v-2h4v-2h-4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2v2Z\"/><path fill=\"#8bc34a\" d=\"m16 3.003-12 7v14l4 2h6v-13.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v11.5H8l-2-1.034V11.15l10-5.833 10 5.833v11.703l-10 5.833-1.745-1.022L13 29.253l3 1.75 12-7v-14Z\"/>"],
			"npm": ["0 0 32 32","<path fill=\"#e53935\" d=\"M4 4v24h24V4Zm20 20h-4V12h-4v12H8V8h16Z\"/>"],
			"nx": ["0 0 24 24","<path fill=\"#039be5\" d=\"m12 13.862-2.749 4.434-4.61-7.537v7.891H1.36V5.35h3.28l4.611 7.892V9.695l2.66 4.168zm.532-5.054V5.35h-3.28v3.458zm4.966 3.635a1.77 1.77 0 0 0-1.774 1.153 1.77 1.77 0 0 1 2.128-.62c.355.177.887.354 1.153.265a1.86 1.86 0 0 0-1.507-.798m3.014.887c-.354 0-.709-.177-.975-.532l-.177-.266a1.9 1.9 0 0 0-.444-.532 1.77 1.77 0 0 0-1.064-.266 2.22 2.22 0 0 0-2.04 1.33 2.04 2.04 0 0 1 3.548.355.71.71 0 0 0 .798.266c.443 0 .354.354 1.064.443v-.089c0-.354-.266-.443-.71-.62zm1.774 1.153a.62.62 0 0 0 .354-.532c0-2.66-2.128-4.877-4.788-4.877a4.79 4.79 0 0 0-3.99 2.128l-1.33-2.128h-3.28l3.103 4.788L9.34 18.65h3.192l1.241-2.216 1.42 2.128h3.102l-2.748-4.434a.6.6 0 0 1 0-.266 2.394 2.394 0 0 1 2.305-2.394c1.33 0 1.507.798 1.773 1.153.621.71 1.774.443 1.774 1.33a.62.62 0 0 0 .887.532m.354.177c-.177.266-.532.266-.709.532-.089.266.089.355.089.355s.354.177.532-.266v-.621z\"/>"],
			"objective-c": ["0 0 32 32","<path fill=\"#ffab40\" d=\"M19.563 22A5.57 5.57 0 0 1 14 16.437v-2.873A5.57 5.57 0 0 1 19.563 8H24V2h-4.437A11.563 11.563 0 0 0 8 13.563v2.873A11.564 11.564 0 0 0 19.563 28H24v-6Z\"/>"],
			"objective-cpp": ["0 0 32 32","<path fill=\"#ffab40\" d=\"M28 14v-4h-2v4h-6v-4h-2v4h-4v2h4v4h2v-4h6v4h2v-4h4v-2z\"/><path fill=\"#ffab40\" d=\"M13.563 22A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z\"/>"],
			"ocaml": ["0 0 24 24","<path d=\"m12.019 15.021.003-.008c-.005-.021-.006-.026-.003.008\"/><path fill=\"#ff9800\" d=\"M4.51 3.273a2.523 2.523 0 0 0-2.524 2.523V11.3c.361-.13.88-.898 1.043-1.085.285-.327.337-.743.478-1.006C3.83 8.612 3.886 8.2 4.62 8.2c.342 0 .478.08.71.39.16.216.438.615.568.882.15.307.396.724.503.808q.122.095.233.137c.119.044.218-.037.297-.1.102-.082.145-.247.24-.467.135-.317.283-.697.367-.83.146-.23.195-.501.352-.633.232-.195.535-.208.618-.225.466-.092.677.225.907.43.15.133.355.403.5.765.114.283.26.544.32.707.059.158.203.41.289.713.077.275.286.486.365.616 0 0 .121.34.858.65.16.067.482.176.674.246.32.116.63.101 1.025.054.281 0 .434-.408.562-.734.075-.193.148-.745.197-.902.048-.153-.064-.27.031-.405.112-.156.178-.164.242-.368.138-.436.936-.458 1.384-.458.374 0 .327.363.96.239.364-.072.714.046 1.1.149.324.086.63.184.812.398.119.139.412.834.113.863.029.035.05.099.104.134-.067.262-.357.075-.518.041-.217-.045-.37.007-.583.101-.363.162-.894.143-1.21.407-.27.223-.269.721-.394 1 0 0-.348.895-1.106 1.443-.194.14-.574.477-1.4.605a5.3 5.3 0 0 1-1.1.043c-.186-.009-.362-.018-.549-.02-.11-.002-.48-.013-.461.022l-.041.103.024.138c.015.083.019.149.022.225.006.157-.013.32-.005.478.017.328.138.627.154.958.017.368.199.758.375 1.059.067.114.169.128.213.269.052.161.003.333.028.505.1.668.292 1.366.592 1.97l.008.014c.371-.062.743-.196 1.226-.267.885-.132 2.115-.064 2.906-.138 2-.188 3.085.82 4.882.407V5.796a2.523 2.523 0 0 0-2.523-2.523zm-.907 11.144q-.022 0-.046.003c-.159.025-.313.08-.412.24-.08.13-.108.355-.164.505-.064.175-.176.338-.274.505-.18.305-.504.581-.644.879-.028.06-.053.13-.076.2v3.402c.163.028.333.062.524.113 1.407.375 1.75.407 3.13.25l.13-.018c.105-.22.187-.968.255-1.2.054-.178.127-.32.155-.5.026-.173-.003-.337-.017-.493-.04-.393.285-.533.44-.87.14-.304.22-.651.336-.963.11-.298.284-.721.579-.872-.036-.041-.617-.06-.772-.076a5 5 0 0 1-.5-.07c-.314-.064-.656-.126-.965-.2a10 10 0 0 1-.947-.328c-.298-.138-.503-.497-.732-.507m5.737.83c-.74.149-.97.876-1.32 1.451-.192.319-.396.59-.548.928-.14.312-.128.657-.368.924a2.55 2.55 0 0 0-.528.922c-.023.067-.088.776-.158.943l1.101-.078c1.026.07.73.464 2.332.378l2.529-.078a7 7 0 0 0-.228-.588c-.07-.147-.16-.434-.218-.56a3.5 3.5 0 0 0-.309-.526c-.184-.215-.227-.23-.28-.503-.095-.473-.344-1.33-.637-1.923-.151-.306-.403-.562-.634-.784-.2-.195-.655-.522-.734-.505z\"/>"],
			"pdf": ["0 0 24 24","<path fill=\"#ef5350\" d=\"M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z\"/>"],
			"perl": ["0 0 24 24","<path fill=\"#ba68c8\" d=\"M11.057 2.981c.537.735.028 1.653.141 2.472a3.42 3.42 0 0 1-1.03 2.415c-1.414 1.625-3.165 3.038-4.097 5.03a5.28 5.28 0 0 0 1.412 5.847c.706.735 1.54 1.342 2.472 1.738.17.805-1.088.184-1.455 0A6.7 6.7 0 0 1 4.361 16.4a5.44 5.44 0 0 1 .904-5.368c1.272-1.61 3.136-2.543 4.662-3.857.565-.55 1.003-1.3.932-2.119.156-.678-.254-1.469.212-2.09zm-.07 18.929c-.17.198-.467.325-.495.24-.042-.085.212-.127.381-.325.17-.183.127-.522.24-.522.1 0 .043.395-.14.607zm2.16 0c.17.198.453.31.495.24.028-.085-.212-.141-.395-.339-.156-.184-.113-.523-.24-.523-.085 0-.029.41.14.608zm-1.03.48c-.1 0-.071-.296-.071-.65 0-.367-.028-.663.07-.663.085 0 .057.296.057.663 0 .354.014.65-.057.65m-.495-20.765c.34.24.254 2.077.254 3.136 0 1.653.184 3.376-.805 4.916-.96 1.497-2.048 3.108-1.95 4.972.1 1.837.99 3.504 2.148 5.043.664.876-.353.509-.876.085a7.2 7.2 0 0 1-2.755-5.664c.142-1.907 1.597-3.348 2.628-4.803.805-1.13 1.186-1.879 1.215-3.645.028-1.412-.142-3.531.042-3.983.014-.043.07-.1.099-.057m.537 2.232c-.085 0-.043.396.028.72.424 2.26-.198 4.52-.749 6.682a12.77 12.77 0 0 0 .283 7.826c.607 1.568 1.71.791 2.161 1.568.34.593 1.272.198 1.978-.141 2.232-1.102 4.012-3.108 4.11-5.566.029-.494 0-.989-.07-1.497-.283-1.837-1.78-3.065-3.15-4.083-1.215-.89-2.74-1.483-3.659-2.613-.523-.65-.297-1.638-.381-2.458-.043-.452-.255-.042-.382-.268-.084-.127-.14-.17-.17-.17zm.72 3.616c.057 0 .17.071.325.226a20 20 0 0 0 2.161 1.921c1.272.961 2.43 2.091 2.967 3.504.339.875.339 1.836.226 2.74-.184 1.384-1.187 2.444-2.119 3.404-.339.354-1.06.791-1.074.678-.084-.367.763-1.172 1.159-1.695A5.93 5.93 0 0 0 16 10.962c-1.102-1.214-2.317-1.907-2.995-3.08-.14-.253-.183-.409-.113-.409z\"/>"],
			"php": ["0 0 24 24","<path fill=\"#1e88e5\" d=\"M12 18.08c-6.63 0-12-2.72-12-6.08s5.37-6.08 12-6.08S24 8.64 24 12s-5.37 6.08-12 6.08m-5.19-7.95c.54 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.58 1.09q-.42.33-1.29.33h-.87l.53-2.76zm-3.5 5.55h1.44l.34-1.75h1.23c.54 0 .98-.06 1.33-.17.35-.12.67-.31.96-.58.24-.22.43-.46.58-.73.15-.26.26-.56.31-.88.16-.78.05-1.39-.33-1.82-.39-.44-.99-.65-1.82-.65H4.59zm7.25-8.33-1.28 6.58h1.42l.74-3.77h1.14c.36 0 .6.06.71.18s.13.34.07.66l-.57 2.93h1.45l.59-3.07c.13-.62.03-1.07-.27-1.36-.3-.27-.85-.4-1.65-.4h-1.27L12 7.35zM18 10.13c.55 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.57 1.09-.29.22-.72.33-1.3.33h-.85l.5-2.76zm-3.5 5.55h1.44l.34-1.75h1.22c.55 0 1-.06 1.35-.17.35-.12.65-.31.95-.58.24-.22.44-.46.58-.73.15-.26.26-.56.32-.88.15-.78.04-1.39-.34-1.82-.36-.44-.99-.65-1.82-.65h-2.75z\"/>"],
			"pnpm": ["0 0 32 32","<path fill=\"#e0e0e0\" d=\"M2 22h8v8H2zm10 0h8v8h-8zm10 0h8v8h-8zM12 12h8v8h-8z\"/><path fill=\"#ffb300\" d=\"M2 2h8v8H2zm10 0h8v8h-8zm10 0h8v8h-8zm0 10h8v8h-8z\"/>"],
			"poetry": ["0 0 32 32","<path fill=\"#3f51b5\" d=\"M20.137 17.834A18.52 18.52 0 0 1 6 24l5 6a25.1 25.1 0 0 0 13-8Z\"/><path fill=\"#1976d2\" d=\"M6 2v22a18.52 18.52 0 0 0 14.137-6.166Z\"/><path fill=\"#29b6f6\" d=\"m6 2 14.137 15.834A23.7 23.7 0 0 0 26 2Z\"/>"],
			"powerpoint": ["0 0 24 24","<path fill=\"#e64a19\" d=\"M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM8 11v2h1v6H8v1h4v-1h-1v-2h2a3 3 0 0 0 3-3 3 3 0 0 0-3-3zm5 2a1 1 0 0 1 1 1 1 1 0 0 1-1 1h-2v-2z\"/>"],
			"powershell": ["0 0 32 32","<path fill=\"#03a9f4\" d=\"M29.07 6H7.677A1.535 1.535 0 0 0 6.24 7.113l-4.2 17.774A.852.852 0 0 0 2.93 26h21.393a1.535 1.535 0 0 0 1.436-1.113L29.96 7.112A.852.852 0 0 0 29.07 6M8.626 23.797a1.4 1.4 0 0 1-1.814-.31l-.007-.009a1.075 1.075 0 0 1 .315-1.599l9.6-6.061-6.102-5.852-.01-.01a1.068 1.068 0 0 1 .084-1.625l.037-.03a1.38 1.38 0 0 1 1.8.07l7.233 6.957a1.1 1.1 0 0 1 .236.739 1.08 1.08 0 0 1-.412.79c-.074.04-.146.119-10.951 6.935ZM24 22.94A1.135 1.135 0 0 1 22.803 24h-5.634a1.061 1.061 0 1 1 .001-2.112h5.633A1.134 1.134 0 0 1 24 22.938Z\"/>"],
			"prettier": ["0 0 16 16","<path fill=\"#f44336\" d=\"M2 8h4v1H2zm0 6h4v1H2zm9-10h3v1h-3zM2 2h3v1H2z\"/><path fill=\"#f9a825\" d=\"M9 2h3v1H9zm1 4h4v1h-4zm-5 6h1v1H5zm-3-2h6v1H2z\"/><path fill=\"#26a69a\" d=\"M2 12h3v1H2zm7-4h5v1H9zM2 4h4v1H2zm3-2h4v1H5z\"/><path fill=\"#ba68c8\" d=\"M2 6h3v1H2zm7-2h2v1H9zm-1 6h4v1H8z\"/>"],
			"prisma": ["0 0 32 32","<path fill=\"#00bfa5\" d=\"m27.777 22.617-.459-.946L18.43 3.26a2.25 2.25 0 0 0-1.914-1.256A2 2 0 0 0 16.379 2a2.23 2.23 0 0 0-1.891 1.042L4.348 19.056a2.2 2.2 0 0 0 .025 2.417l4.957 7.488A2.34 2.34 0 0 0 11.29 30a2.4 2.4 0 0 0 .655-.092l14.387-4.149a2.32 2.32 0 0 0 1.458-1.234 2.21 2.21 0 0 0-.013-1.908m-3.538.604-11.268 3.25 4.075-19.033 7.568 15.671-.376.098Z\"/>"],
			"prolog": ["0 0 24 24","<path fill=\"#ef5350\" d=\"M12 15.385a5.1 5.1 0 0 0 1.862 1.693L12 18.94l-1.862-1.862A5.04 5.04 0 0 0 12 15.385m4.232-4.063a1.693 1.693 0 0 0-1.693 1.693 1.693 1.693 0 0 0 1.693 1.693 1.693 1.693 0 0 0 1.693-1.693c0-.94-.762-1.693-1.693-1.693m-8.464 0a1.693 1.693 0 0 0-1.693 1.693 1.693 1.693 0 0 0 1.693 1.693 1.693 1.693 0 0 0 1.693-1.693c0-.94-.762-1.693-1.693-1.693m8.464-2.116a3.385 3.385 0 0 1 3.385 3.386 3.385 3.385 0 0 1-3.385 3.385 3.385 3.385 0 0 1-3.386-3.385 3.385 3.385 0 0 1 3.386-3.386m-8.464 0a3.385 3.385 0 0 1 3.386 3.386 3.385 3.385 0 0 1-3.386 3.385 3.385 3.385 0 0 1-3.385-3.385 3.385 3.385 0 0 1 3.385-3.386M3.74 2.69c1.49 3.132.415 5.468-.584 7.787a5.1 5.1 0 0 0-.465 2.116 5.08 5.08 0 0 0 5.078 5.078 6 6 0 0 0 .533-.042l2.506 2.505L12 21.31l1.194-1.177 2.505-2.505c.178.025.355.034.533.042a5.08 5.08 0 0 0 5.078-5.078 5.1 5.1 0 0 0-.465-2.116c-.999-2.319-2.074-4.655-.584-7.787-2.235 1.744-5.417 3.123-8.26 3.132-2.845-.008-6.027-1.388-8.261-3.132z\"/>"],
			"proto": ["0 0 32 32","<path fill=\"#00bfa5\" d=\"M16 27 2 19v-5l14 8z\"/><path fill=\"#ffeb3b\" d=\"m30 14-14 8v5l14-8z\"/><path fill=\"#ff5722\" d=\"M16 6 2 14v5l14-8z\"/><path fill=\"#00e676\" d=\"m30 19-14-8V6l14 8z\"/><path fill=\"#03a9f4\" d=\"M16 27 2 19v-5l14 8z\"/>"],
			"python": ["0 0 24 24","<path fill=\"#0288d1\" d=\"M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711\"/><path fill=\"#fdd835\" d=\"M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89\"/>"],
			"python-misc": ["0 0 32 32","<path fill=\"#757575\" d=\"M15 2H6a2.006 2.006 0 0 0-2 2v22a2.006 2.006 0 0 0 2 2h16a2 2 0 0 0 2-2V11Zm3 22H6v-2h12Zm0-4H6v-2h12Zm0-4H6v-2h12Zm-4-4V4l8 8Z\"/><path fill=\"#fbc02d\" d=\"M30.714 16H28v5h-9v7.714A1.286 1.286 0 0 0 20.286 30h6.428A1.286 1.286 0 0 0 28 28.714V26h-6v-1h8.714A1.286 1.286 0 0 0 32 23.714v-6.428A1.286 1.286 0 0 0 30.714 16M24 28h3v1h-3Z\" style=\"isolation:isolate\"/><path fill=\"#0288d1\" d=\"M25.714 12h-6.428A1.286 1.286 0 0 0 18 13.286V16h6v1h-8.714A1.286 1.286 0 0 0 14 18.286v6.428A1.286 1.286 0 0 0 15.286 26H18v-6h9v-6.714A1.286 1.286 0 0 0 25.714 12M22 14h-3v-1h3Z\" style=\"isolation:isolate\"/>"],
			"r": ["0 0 24 24","<path fill=\"#1976d2\" d=\"M11.956 4.05c-5.694 0-10.354 3.106-10.354 6.947 0 3.396 3.686 6.212 8.531 6.813v2.205h3.53V17.82c.88-.093 1.699-.259 2.475-.497l1.43 2.692h3.996l-2.402-4.048c1.936-1.263 3.147-3.034 3.147-4.97 0-3.841-4.659-6.947-10.354-6.947m1.584 2.712c4.349 0 7.558 1.45 7.558 4.753 0 1.77-.952 3.013-2.505 3.779a1 1 0 0 1-.228-.156c-.373-.165-.994-.352-.994-.352s3.085-.227 3.085-3.302-3.23-3.127-3.23-3.127h-7.092v7.413c-2.64-.766-4.462-2.392-4.462-4.255 0-2.63 3.52-4.753 7.868-4.753m.156 4.12h2.143s.983-.05.983.974c0 1.004-.983 1.004-.983 1.004h-2.143v-1.977m-.031 4.566h.952c.186 0 .28.052.445.207.135.103.28.3.404.476-.57.073-1.17.104-1.801.104z\"/>"],
			"react": ["0 0 32 32","<path fill=\"#00bcd4\" d=\"M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6\"/><path fill=\"#00bcd4\" d=\"M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2\"/><path fill=\"#00bcd4\" d=\"M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z\"/><path fill=\"#00bcd4\" d=\"M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369\"/>"],
			"react_ts": ["0 0 32 32","<path fill=\"#0288d1\" d=\"M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6\"/><path fill=\"#0288d1\" d=\"M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2\"/><path fill=\"#0288d1\" d=\"M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z\"/><path fill=\"#0288d1\" d=\"M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369\"/>"],
			"readme": ["0 0 16 16","<path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M8 1C4.136 1 1 4.136 1 8s3.136 7 7 7 7-3.136 7-7-3.136-7-7-7m1 11H7V7.5h2zm0-6H7V4h2z\"/>"],
			"ruby": ["0 0 24 24","<path fill=\"#f44336\" d=\"M18.041 3.177c2.24.382 2.879 1.919 2.843 3.527V6.67l-1.013 13.266-13.132.897h.008c-1.093-.044-3.518-.151-3.634-3.545l1.217-2.222 2.462 5.74 2.097-6.77-.045.009.018-.018 6.85 2.186L13.945 9.3l6.53-.409-5.144-4.212 2.71-1.51v.009M3.113 17.252v.017zM6.916 6.874c2.63-2.622 6.033-4.168 7.34-2.844 1.297 1.306-.072 4.523-2.702 7.135-2.666 2.613-6.015 4.248-7.322 2.933-1.306-1.324.036-4.612 2.675-7.224z\"/>"],
			"rust": ["0 0 32 32","<path fill=\"#ff7043\" d=\"m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10\"/>"],
			"sass": ["0 0 32 32","<path fill=\"#ec407a\" d=\"M27.837 5.673a4.33 4.33 0 0 0-2.293-2.701c-2.362-1.261-6.11-1.298-9.548-.092a26.3 26.3 0 0 0-8.76 4.966c-2.752 2.542-3.438 4.925-3.189 6.194.523 2.668 3.274 4.539 5.485 6.042.418.284.822.559 1.175.816-1.429.76-4.261 2.444-5.088 4.248a3.88 3.88 0 0 0-.118 3.332A2.37 2.37 0 0 0 6.869 29.8a5.6 5.6 0 0 0 1.49.2 6.35 6.35 0 0 0 5.19-2.856 6.74 6.74 0 0 0 .864-5.382 7.3 7.3 0 0 1 2.044-.03 3.92 3.92 0 0 1 2.816 1.311 1.82 1.82 0 0 1 .423 1.262 1.55 1.55 0 0 1-.772 1.05c-.234.14-.586.355-.504.803.036.194.198.633.894.512a2.93 2.93 0 0 0 2.145-2.651 4 4 0 0 0-1.197-2.904 5.94 5.94 0 0 0-4.396-1.626 10.6 10.6 0 0 0-2.672.304 20 20 0 0 0-2.203-1.846c-1.712-1.3-3.33-2.529-3.235-4.26.125-2.263 2.468-4.532 6.964-6.744 4.016-1.976 7.254-2.037 8.944-1.438a2 2 0 0 1 1.204.883 2.77 2.77 0 0 1-.36 2.47 9.71 9.71 0 0 1-7.425 4.304 3.86 3.86 0 0 1-3.238-.757c-.278-.302-.593-.645-1.074-.383q-.565.31-.225 1.189a3.9 3.9 0 0 0 2.407 1.92 11.7 11.7 0 0 0 7.128-.671c3.527-1.35 6.681-5.202 5.756-8.787M11.895 24.475a4 4 0 0 1-.192.468 4.5 4.5 0 0 1-.753 1.081 2.83 2.83 0 0 1-2.533 1.107c-.056-.032-.078-.146-.085-.193a3.28 3.28 0 0 1 1.076-2.284 11.3 11.3 0 0 1 2.644-1.933 3.85 3.85 0 0 1-.157 1.754\"/>"],
			"scala": ["0 0 32 32","<path fill=\"#f44336\" d=\"m6.457 9.894 12.523 5.163-.456 1.211L6 11.105Zm7.02-3.091L26 11.966l-.457 1.21L13.02 8.015ZM6.465 18.885l12.524 5.163-.457 1.21L6.01 20.097Zm7.007-3.086 12.524 5.163-.456 1.21-12.524-5.162Z\"/><path fill=\"#f44336\" d=\"M6 24.07V30l19.997-3.106V20.96zM6 5.11v5.99l20-3.11V2zm0 9.96v5.03l20-3.11v-5.03z\"/>"],
			"settings": ["0 0 24 24","<path d=\"M0 0h24v24H0z\"/><path fill=\"#42a5f5\" d=\"M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.6.6 0 0 0-.18-.03c-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1q.09.03.18.03c.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64zm-1.98-1.71c.04.31.05.52.05.73s-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4m0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2\"/>"],
			"sketch": ["0 0 24 24","<path fill=\"#ffc107\" d=\"M15.705 9.221h2.779l-4.632 6.484m-3.705-6.484h3.705L12 16.631m-6.484-7.41h2.779l1.852 6.484M14.78 4.59h1.852l1.853 2.779h-2.78m-4.63-2.779h1.852l.926 2.779h-3.705M7.368 4.59h1.853l-.926 2.78h-2.78m.927-4.631L2.737 8.294 12 21.263l9.262-12.968-3.705-5.557z\"/>"],
			"solidity": ["0 0 24 24","<g fill=\"#0288d1\"><path d=\"m5.747 14.046 6.254 8.61 6.252-8.61-6.254 3.807z\"/><path d=\"M11.999 1.343 5.747 11.83l6.252 3.807 6.253-3.807z\"/></g>"],
			"stylelint": ["0 0 412 395","<g fill=\"#cfd8dc\" transform=\"translate(31.478 29.499)scale(.84775)\"><path d=\"M208.8 393.05c45.057-161.12 43.75-161.85 76.32-276.73l7.832 4.523c4.255 2.458 7.738.448 7.738-4.455V61.602c8.643-30.27 15.416-53.66 17.4-60.693h35.287l58.618 54.304-38.498 33.27 29.11 31.473-191.86 273.09c-.938 1.542-2.244 1.19-1.947 0zm20.96-347.28c1.733 0 3.148.958 3.148 2.147v28.077c0 1.186-1.415 2.15-3.147 2.15h-47.396c-1.742 0-3.153-.96-3.153-2.15V47.917c0-1.185 1.41-2.147 3.153-2.147h47.396z\"/><path d=\"m288.26 14.688-52.14 30.1c.605.92.973 1.98.973 3.136v28.078c0 1.457-.565 2.77-1.496 3.83l52.663 30.402c3.59 2.073 6.535.377 6.535-3.764V18.456c0-4.145-2.944-5.836-6.535-3.768M175.02 76V47.923c0-1.15.368-2.21.966-3.13l-52.14-30.105c-3.588-2.068-6.53-.376-6.53 3.768v88.013c0 4.14 2.938 5.84 6.53 3.76l52.66-30.405c-.926-1.06-1.487-2.37-1.487-3.827z\"/><path d=\"M201.25 393.05h1.947c-45.05-161.12-43.753-161.85-76.32-276.73l-7.833 4.523c-4.253 2.458-7.737.448-7.737-4.455V61.602C102.662 31.332 95.892 7.942 93.902.909H58.619L.002 55.213l38.494 33.27-29.11 31.473z\"/><circle cx=\"204.57\" cy=\"122.54\" r=\"14.231\"/><circle cx=\"204.57\" cy=\"207.16\" r=\"14.231\"/><circle cx=\"204.57\" cy=\"291.78\" r=\"14.23\"/></g>"],
			"stylus": ["0 0 200 200","<path fill=\"#c0ca33\" d=\"M127.22 155.91c14.639-17.51 16.362-35.594 5.023-69.178-7.176-21.241-19.089-37.603-10.334-50.807 9.33-14.065 29.135-.43 12.63 18.371l3.301 2.296c19.806 2.297 29.566-24.83 14.783-32.58-39.038-20.38-73.197 18.802-58.127 64.155 6.459 19.232 15.501 39.613 8.181 55.831-6.315 13.922-18.515 22.103-26.695 22.39-17.079.862-5.74-38.32 13.922-48.08 1.722-.86 4.162-2.009 1.866-4.88-24.255-2.726-38.464 8.468-46.645 24.113-23.825 45.497 45.21 62.289 82.096 18.37z\"/>"],
			"svelte": ["0 0 300 300","<path fill=\"#ff5722\" d=\"M175.94 24.328c-13.037.252-26.009 3.872-37.471 11.174L79.912 72.818a67.13 67.13 0 0 0-30.355 44.906 70.8 70.8 0 0 0 6.959 45.445 67.2 67.2 0 0 0-10.035 25.102 71.54 71.54 0 0 0 12.236 54.156c23.351 33.41 69.468 43.311 102.81 22.07l58.559-37.158a67.36 67.36 0 0 0 30.355-44.906 70.77 70.77 0 0 0-6.982-45.422 67.65 67.65 0 0 0 10.059-25.102 71.63 71.63 0 0 0-12.236-54.156v-.18c-15.324-21.925-40.453-33.727-65.342-33.246zm5.137 28.68a46.5 46.5 0 0 1 36.09 19.969 42.98 42.98 0 0 1 7.365 32.557 45 45 0 0 1-1.393 5.455l-1.123 3.37-2.986-2.247a75.9 75.9 0 0 0-22.902-11.45l-2.244-.651.201-2.246a13.16 13.16 0 0 0-2.379-8.711 13.99 13.99 0 0 0-14.953-5.412 12.8 12.8 0 0 0-3.594 1.572l-58.578 37.25a12.24 12.24 0 0 0-5.502 8.15 13.1 13.1 0 0 0 2.246 9.834 14.03 14.03 0 0 0 14.93 5.569 13.5 13.5 0 0 0 3.594-1.573l22.453-14.234a41.8 41.8 0 0 1 11.898-5.232 46.48 46.48 0 0 1 49.914 18.502 43.02 43.02 0 0 1 7.363 32.557 40.42 40.42 0 0 1-18.254 27.078l-58.58 37.316a43 43 0 0 1-11.898 5.23A46.545 46.545 0 0 1 82.81 227.14a42.98 42.98 0 0 1-7.341-32.557 38 38 0 0 1 1.39-5.41l1.102-3.37 3.008 2.246a75.9 75.9 0 0 0 22.836 11.361l2.244.65-.201 2.247a13.25 13.25 0 0 0 2.447 8.644 14.03 14.03 0 0 0 15.043 5.569 13.1 13.1 0 0 0 3.592-1.573l58.467-37.316a12.17 12.17 0 0 0 5.502-8.173 12.96 12.96 0 0 0-2.246-9.811 14.03 14.03 0 0 0-15.043-5.568 12.8 12.8 0 0 0-3.592 1.57l-22.453 14.258a42.9 42.9 0 0 1-11.877 5.209 46.52 46.52 0 0 1-49.846-18.5 43.02 43.02 0 0 1-7.297-32.557A40.42 40.42 0 0 1 96.798 96.98l58.646-37.316a42.8 42.8 0 0 1 11.811-5.21 46.5 46.5 0 0 1 13.822-1.444z\"/>"],
			"svg": ["0 0 32 32","<path fill=\"#ffb300\" d=\"M29.168 14.03a2.7 2.7 0 0 0-1.968-.83 2.51 2.51 0 0 0-1.929.8h-4.443l3.078-3.078a2.835 2.835 0 0 0 2.857-2.842 2.6 2.6 0 0 0-.831-1.969 2.82 2.82 0 0 0-2.014-.788 2.67 2.67 0 0 0-1.968.788 2.36 2.36 0 0 0-.812 1.922L18 11.17V6.726a2.51 2.51 0 0 0 .8-1.929 2.7 2.7 0 0 0-.832-1.968 2.745 2.745 0 0 0-3.936 0 2.7 2.7 0 0 0-.832 1.968 2.51 2.51 0 0 0 .8 1.93v4.443l-3.138-3.138a2.36 2.36 0 0 0-.812-1.922 2.66 2.66 0 0 0-1.968-.788 2.83 2.83 0 0 0-2.014.788 2.6 2.6 0 0 0-.831 1.969 2.74 2.74 0 0 0 .831 2.013 2.8 2.8 0 0 0 2.026.829l3.078 3.078H6.729a2.51 2.51 0 0 0-1.929-.8 2.7 2.7 0 0 0-1.968.831 2.745 2.745 0 0 0 0 3.937 2.7 2.7 0 0 0 1.968.832 2.51 2.51 0 0 0 1.929-.8h4.443l-3.078 3.077a2.835 2.835 0 0 0-2.857 2.842 2.6 2.6 0 0 0 .831 1.969 2.82 2.82 0 0 0 2.014.788 2.67 2.67 0 0 0 1.968-.788 2.36 2.36 0 0 0 .812-1.922L14 20.827v4.444a2.51 2.51 0 0 0-.8 1.929 2.784 2.784 0 0 0 4.768 1.968A2.7 2.7 0 0 0 18.8 27.2a2.51 2.51 0 0 0-.8-1.929v-4.444l3.138 3.138a2.36 2.36 0 0 0 .812 1.922 2.66 2.66 0 0 0 1.968.788 2.83 2.83 0 0 0 2.014-.788 2.6 2.6 0 0 0 .831-1.969 2.74 2.74 0 0 0-.831-2.013 2.8 2.8 0 0 0-2.026-.829L20.828 18h4.443a2.51 2.51 0 0 0 1.93.8 2.784 2.784 0 0 0 1.967-4.769Z\"/>"],
			"swift": ["0 0 24 24","<path fill=\"#ff6e40\" d=\"M17.087 19.721c-2.36 1.36-5.59 1.5-8.86.1a13.8 13.8 0 0 1-6.23-5.32c.67.55 1.46 1 2.3 1.4 3.37 1.57 6.73 1.46 9.1 0-3.37-2.59-6.24-5.96-8.37-8.71-.45-.45-.78-1.01-1.12-1.51 8.28 6.05 7.92 7.59 2.41-1.01 4.89 4.94 9.43 7.74 9.43 7.74.16.09.25.16.36.22.1-.25.19-.51.26-.78.79-2.85-.11-6.12-2.08-8.81 4.55 2.75 7.25 7.91 6.12 12.24-.03.11-.06.22-.05.39 2.24 2.83 1.64 5.78 1.35 5.22-1.21-2.39-3.48-1.65-4.62-1.17\"/>"],
			"table": ["0 0 24 24","<path fill=\"#8bc34a\" d=\"M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zm4 7.5h-4v2h1l-2 1.67L10 13h1v-2H7v2h1l3 2.5L8 18H7v2h4v-2h-1l2-1.67L14 18h-1v2h4v-2h-1l-3-2.5 3-2.5h1z\"/>"],
			"tex": ["0 0 1024 1024","<path fill=\"#2196f3\" d=\"M80 192 64 320h32c16-80 16-96 63.242-96H176c8.837 0 16 7.163 16 16v352c0 8.837 0 16-32 16h-32v32h192v-32h-32c-32 0-32-7.163-32-16V240c0-8.837 7.163-16 16-16h16c48 0 48 16 64 96h32l-16-128zm560 0v32c16 0 45.713 0 52.57 16L776 434.666 708.57 592c-6.857 16-52.57 16-68.57 16v32h128v-32s-34.285 0-27.428-16L792 472l51.428 120c3.103 7.24-1.52 16-11.428 16v32h128v-32c-16 0-45.713 0-52.57-16L824 397.334 891.43 240c6.857-16 52.57-16 68.57-16v-32H832v32s34.285 0 27.428 16L808 360l-51.428-120c-3.103-7.24 1.52-16 11.428-16v-32zM320 384v32h32c32 0 32 7.163 32 16v352c0 8.837 0 16-32 16h-32v32h304l16-128h-32c-16 80-16 96-64 96h-64c-32 0-32-7.163-32-16V624h80c8.837 0 16 0 16 32v16h32V544h-32v16c0 32-7.163 32-16 32h-80V432c0-8.837 0-16 32-16h64c48 0 48 16 64 96h32l-16-128z\"/>"],
			"toml": ["0 0 16 16","<path fill=\"#cfd8dc\" d=\"M4 6V4h8v2H9v7H7V6z\"/><path fill=\"#ef5350\" d=\"M4 1v1H2v12h2v1H1V1zm8 0v1h2v12h-2v1h3V1z\"/>"],
			"tsconfig": ["0 0 32 32","<path fill=\"#757575\" d=\"M15 2H6a2.006 2.006 0 0 0-2 2v22a2.006 2.006 0 0 0 2 2h6v-4H6v-2h6v-2H6v-2h6v-2H6v-2h6v-2h2V4l8 8h2v-1Z\" data-mit-no-recolor=\"true\"/><path fill=\"#0288d1\" d=\"M12 12v18h18V12Zm8 6h-2v8h-2v-8h-2v-2h6Zm8 0h-4v2h2a2.006 2.006 0 0 1 2 2v2a2.006 2.006 0 0 1-2 2h-4v-2h4v-2h-2a2.006 2.006 0 0 1-2-2v-2a2.006 2.006 0 0 1 2-2h4Z\"/>"],
			"tune": ["0 0 32 32","<path fill=\"#fbc02d\" d=\"M12 10h10v2H12z\"/><path fill=\"#fbc02d\" d=\"M16 4h2v8h-2zm4 18h10v2H20zm4 2h2v4h-2zm0-20h2v14h-2zM2 18h10v2H2z\"/><path fill=\"#fbc02d\" d=\"M6 18h2v10H6zM6 4h2v10H6zm10 12h2v12h-2z\"/>"],
			"turborepo": ["0 0 32 32","<defs><linearGradient id=\"turborepo-a\" x1=\"27.349\" x2=\"7.613\" y1=\"26.455\" y2=\"6.719\" gradientTransform=\"matrix(1 0 0 -1 0 34)\" gradientUnits=\"userSpaceOnUse\"><stop offset=\".15\" stop-color=\"#2196f3\"/><stop offset=\".85\" stop-color=\"#f50057\"/></linearGradient></defs><path fill=\"#cfd8dc\" d=\"M16 8a8 8 0 1 0 8 8 8 8 0 0 0-8-8m0 12a4 4 0 1 1 4-4 4 4 0 0 1-4 4\"/><path fill=\"url(#turborepo-a)\" d=\"M4.281 23.647A13.9 13.9 0 0 1 2 16h4a9.95 9.95 0 0 0 1.192 4.736ZM14 29.84v-4.042a9.9 9.9 0 0 1-3.892-1.732l-2.854 2.855A13.9 13.9 0 0 0 14 29.84M16 2v4a10 10 0 0 1 2 19.8v4.04A13.992 13.992 0 0 0 16 2\"/>"],
			"typescript": ["0 0 16 16","<path fill=\"#0288d1\" d=\"M2 2v12h12V2zm4 6h3v1H8v4H7V9H6zm5 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1\"/>"],
			"vercel": ["0 0 32 32","<path fill=\"#cfd8dc\" d=\"m16 6 12 20H4Z\"/>"],
			"video": ["0 0 32 32","<path fill=\"#ff9800\" d=\"m24 6 2 6h-4l-2-6h-3l2 6h-4l-2-6h-3l2 6H8L6 6H5a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3V6Z\"/>"],
			"visualstudio": ["0 0 32 32","<path fill=\"#ab47bc\" d=\"m22 11.8-5.7 4.584L22 20.8zM7.24 23.68 4 21.64v-10.8l3.6-1.2 5.16 3.996L23.2 4 28 7v18.6L22 28l-9.192-8.808zm.36-5.28 2.232-2.064L7.6 14.2Z\"/>"],
			"vite": ["0 0 32 32","<path fill=\"#a0f\" d=\"M29.313 12h-6.664a1.427 1.427 0 0 1-1.1-2.24l4.398-6.676A.703.703 0 0 0 25.397 2H8.428a.62.62 0 0 0-.55.289l-5.77 8.627A.703.703 0 0 0 2.658 12h8.175a1.427 1.427 0 0 1 1.099 2.24l-4.48 6.676A.702.702 0 0 0 8 22l6.695.002A1.34 1.34 0 0 1 16 23.375v5.934a.652.652 0 0 0 1.168.433l12.694-16.586a.725.725 0 0 0-.55-1.156\"/>"],
			"vlang": ["0 0 500 500","<path fill=\"#546e7a\" d=\"m311.64 433.372 130.885-363.97c2.22-6.173-1.28-10.674-7.809-10.044l-102.93 9.915c-6.529.63-13.582 6.17-15.739 12.363L194.901 429.48c-2.158 6.194 1.416 11.223 7.975 11.223h100.191c3.28 0 6.843-2.505 7.953-5.592z\"/><path fill=\"#039be5\" d=\"m65.278 59.359 102.93 9.915c6.529.63 13.59 6.167 15.757 12.358l123.714 353.456c1.083 3.097-.7 5.608-3.98 5.608H202.877c-6.56 0-13.688-5.01-15.907-11.183L57.472 69.398c-2.22-6.173 1.28-10.674 7.809-10.044z\"/>"],
			"vue": ["0 0 24 24","<path fill=\"#41b883\" d=\"M1.791 3.851 12 21.471 22.209 3.936V3.85H18.24l-6.18 10.616L5.906 3.851z\"/><path fill=\"#35495e\" d=\"m5.907 3.851 6.152 10.617L18.24 3.851h-3.723L12.084 8.03 9.66 3.85z\"/>"],
			"webassembly": ["0 0 32 32","<path fill=\"#7c4dff\" d=\"M22 18h4v4h-4z\"/><path fill=\"#7c4dff\" d=\"M20 2a4 4 0 0 1-8 0H2v28h28V2Zm-2 24h-2v2h-4v-2h-2v2H6v-2H4V16h2v10h4V16h2v10h4V16h2Zm10 2h-2v-4h-4v4h-2V18h2v-2h4v2h2Z\"/>"],
			"word": ["0 0 24 24","<path fill=\"#01579b\" d=\"M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM7 13l1.5 7h2l1.5-3 1.5 3h2l1.5-7h1v-2h-4v2h1l-.9 4.2L13 15h-2l-1.1 2.2L9 13h1v-2H6v2z\"/>"],
			"xml": ["0 0 24 24","<path fill=\"#8bc34a\" d=\"M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2m.12 13.5 3.74 3.74 1.42-1.41-2.33-2.33 2.33-2.33-1.42-1.41zm11.16 0-3.74-3.74-1.42 1.41 2.33 2.33-2.33 2.33 1.42 1.41z\"/>"],
			"yaml": ["0 0 24 24","<path fill=\"#ff5252\" d=\"M13 9h5.5L13 3.5zM6 2h8l6 6v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2m12 16v-2H9v2zm-4-4v-2H6v2z\"/>"],
			"yarn": ["0 0 32 32","<path fill=\"#0288d1\" d=\"M27.575 23.967a9.9 9.9 0 0 0-3.751 1.726 22.6 22.6 0 0 1-5.537 2.504 1.55 1.55 0 0 1-.931.52 59 59 0 0 1-6.11.548c-1.102.008-1.777-.282-1.965-.735a1.49 1.49 0 0 1 .82-1.965 3.6 3.6 0 0 1-.486-.359c-.163-.162-.334-.487-.385-.367-.213.52-.324 1.794-.897 2.366-.786.795-2.273.53-3.153.069-.965-.513.069-1.718.069-1.718a.69.69 0 0 1-.94-.324 4.6 4.6 0 0 1-.632-2.794 5.2 5.2 0 0 1 1.674-2.76 8.84 8.84 0 0 1 .624-4.17 9.9 9.9 0 0 1 3-3.469S7.136 11.015 7.82 9.177c.444-1.196.623-1.187.769-1.239a3.44 3.44 0 0 0 1.375-.811 4.99 4.99 0 0 1 4.178-1.607s1.094-3.357 2.12-2.7a17.4 17.4 0 0 1 1.452 2.735s1.213-.71 1.35-.445a10.74 10.74 0 0 1 .495 5.81 13.3 13.3 0 0 1-2.46 5.127c-.129.214 1.47.889 2.477 3.683.932 2.554.103 4.699.248 4.938.026.043.034.06.034.06s1.068.085 3.213-1.24a8.05 8.05 0 0 1 4.05-1.52 1.026 1.026 0 0 1 .453 2Z\"/>"],
			"zig": ["0 0 32 32","<path fill=\"#f9a825\" d=\"M2 8h6v4H2zm8 0h12v4H10zm0 12h12v4H10zm14 0h2v4h-2zM8 20l-3 4H2V12h4v8zm14-8h-6l-6 8h6z\"/><path fill=\"#f9a825\" d=\"M16 20h-6l-6 8m12-16h6l6-8m2 4v16h-4V12h-2l3-4z\"/>"],
			"zip": ["0 0 24 24","<path fill=\"#afb42b\" d=\"M14 17h-2v-2h-2v-2h2v2h2m0-6h-2v2h2v2h-2v-2h-2V9h2V7h-2V5h2v2h2m5-4H5c-1.11 0-2 .89-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2\"/>"],
		}
		const FILE_ICON_BY_EXTENSION = {
			"7z": "zip",
			"aac": "audio",
			"adoc": "asciidoc",
			"ai": "adobe-illustrator",
			"apk": "android",
			"asm": "assembly",
			"astro": "astro",
			"avi": "video",
			"avif": "image",
			"bash": "console",
			"bat": "console",
			"bin": "hex",
			"bmp": "image",
			"bz2": "zip",
			"c": "c",
			"cc": "cpp",
			"cfg": "settings",
			"cjs": "javascript",
			"clj": "clojure",
			"cljs": "clojure",
			"cmd": "console",
			"conf": "settings",
			"cpp": "cpp",
			"cs": "csharp",
			"css": "css",
			"csv": "table",
			"cts": "typescript",
			"cu": "cuda",
			"cxx": "cpp",
			"dart": "dart",
			"db": "database",
			"deb": "zip",
			"diff": "diff",
			"dll": "dll",
			"dmg": "disc",
			"doc": "word",
			"docx": "word",
			"env": "tune",
			"eot": "font",
			"eps": "image",
			"epub": "epub",
			"erl": "erlang",
			"ex": "elixir",
			"exe": "exe",
			"exs": "elixir",
			"fig": "figma",
			"fish": "console",
			"flac": "audio",
			"fs": "fsharp",
			"fsi": "fsharp",
			"fsx": "fsharp",
			"gif": "image",
			"go": "go",
			"gql": "graphql",
			"graphql": "graphql",
			"groovy": "groovy",
			"gz": "zip",
			"h": "h",
			"heic": "image",
			"hpp": "hpp",
			"hs": "haskell",
			"htm": "html",
			"html": "html",
			"hxx": "hpp",
			"ico": "image",
			"ini": "settings",
			"ipa": "applescript",
			"ipynb": "jupyter",
			"iso": "disc",
			"jar": "jar",
			"java": "java",
			"jl": "julia",
			"jpeg": "image",
			"jpg": "image",
			"js": "javascript",
			"json": "json",
			"json5": "json",
			"jsonc": "json",
			"jsx": "react",
			"kt": "kotlin",
			"kts": "kotlin",
			"less": "less",
			"lock": "lock",
			"log": "log",
			"lua": "lua",
			"m": "objective-c",
			"m4a": "audio",
			"markdown": "markdown",
			"md": "markdown",
			"mdx": "mdx",
			"mjs": "javascript",
			"mkv": "video",
			"ml": "ocaml",
			"mm": "objective-cpp",
			"mov": "video",
			"mp3": "audio",
			"mp4": "video",
			"mts": "typescript",
			"nim": "nim",
			"odp": "powerpoint",
			"ods": "table",
			"odt": "word",
			"ogg": "video",
			"opus": "audio",
			"otf": "font",
			"patch": "git",
			"pdf": "pdf",
			"php": "php",
			"pl": "prolog",
			"plist": "xml",
			"pm": "perl",
			"png": "image",
			"ppt": "powerpoint",
			"pptx": "powerpoint",
			"prisma": "prisma",
			"properties": "settings",
			"proto": "proto",
			"ps1": "powershell",
			"psd": "adobe-photoshop",
			"py": "python",
			"pyi": "python",
			"r": "r",
			"rar": "zip",
			"rb": "ruby",
			"rpm": "zip",
			"rs": "rust",
			"rst": "markdown",
			"rtf": "word",
			"s": "assembly",
			"sass": "sass",
			"scala": "scala",
			"scss": "sass",
			"sh": "console",
			"sketch": "sketch",
			"so": "dll",
			"sol": "solidity",
			"sql": "database",
			"sqlite": "database",
			"sqlite3": "database",
			"styl": "stylus",
			"svelte": "svelte",
			"svg": "svg",
			"swift": "swift",
			"tar": "zip",
			"tex": "tex",
			"tgz": "zip",
			"tif": "image",
			"tiff": "image",
			"toml": "toml",
			"ts": "typescript",
			"tsv": "table",
			"tsx": "react_ts",
			"ttf": "font",
			"txt": "document",
			"v": "vlang",
			"vb": "visualstudio",
			"vue": "vue",
			"wasm": "webassembly",
			"wav": "audio",
			"webm": "video",
			"webp": "image",
			"woff": "font",
			"woff2": "font",
			"xhtml": "html",
			"xls": "table",
			"xlsx": "table",
			"xml": "xml",
			"xz": "zip",
			"yaml": "yaml",
			"yml": "yaml",
			"zig": "zig",
			"zip": "zip",
			"zsh": "console",
			"zst": "zip",
		}
		const FILE_ICON_BY_NAME = {
			".babelrc": "babel",
			".babelrc.js": "babel",
			".browserslistrc": "browserlist",
			".editorconfig": "editorconfig",
			".env": "tune",
			".env.development": "tune",
			".env.example": "tune",
			".env.local": "tune",
			".env.production": "tune",
			".eslintignore": "eslint",
			".eslintrc": "eslint",
			".eslintrc.json": "eslint",
			".gitattributes": "git",
			".gitignore": "git",
			".gitkeep": "git",
			".gitmodules": "git",
			".node-version": "nodejs",
			".npmrc": "npm",
			".nvmrc": "nodejs",
			".prettierignore": "prettier",
			".prettierrc": "prettier",
			".prettierrc.json": "prettier",
			".python-version": "python-misc",
			".ruby-version": "ruby",
			".stylelintrc": "stylelint",
			"build.gradle": "gradle",
			"build.gradle.kts": "gradle",
			"bun.lockb": "bun",
			"cargo.lock": "lock",
			"cargo.toml": "rust",
			"changelog.md": "changelog",
			"cmakelists.txt": "cmake",
			"code_of_conduct.md": "conduct",
			"compose.yaml": "docker",
			"compose.yml": "docker",
			"contributing.md": "contributing",
			"docker-compose.yaml": "docker",
			"docker-compose.yml": "docker",
			"dockerfile": "docker",
			"firebase.json": "firebase",
			"gemfile": "gemfile",
			"gemfile.lock": "lock",
			"gnumakefile": "makefile",
			"go.mod": "go-mod",
			"go.sum": "go-mod",
			"gradlew": "gradle",
			"jsconfig.json": "jsconfig",
			"lerna.json": "lerna",
			"license": "license",
			"license.md": "license",
			"makefile": "makefile",
			"netlify.toml": "netlify",
			"nx.json": "nx",
			"package-lock.json": "nodejs",
			"package.json": "nodejs",
			"pipfile": "python-misc",
			"pnpm-lock.yaml": "pnpm",
			"poetry.lock": "poetry",
			"pom.xml": "maven",
			"pyproject.toml": "python-misc",
			"rakefile": "ruby",
			"readme": "readme",
			"readme.md": "readme",
			"requirements.txt": "python-misc",
			"security.md": "lock",
			"settings.gradle": "gradle",
			"setup.cfg": "python-misc",
			"setup.py": "python",
			"tsconfig.json": "tsconfig",
			"turbo.json": "turborepo",
			"vercel.json": "vercel",
			"vite.config.js": "vite",
			"vite.config.ts": "vite",
			"yarn.lock": "yarn",
		}
		/* @file-icons:end */

		return {
			name: 'git-panel',
			inject: ['slots', 'locale', 'sidebarRightTabs'],
			apply,
			// Exposed for the package's own tests; not part of any slot contract.
			__test: {
				buildReviewPrompt,
				ChangeBadge,
				ChangeRow,
				branchSummaryOf,
				messages: { zh, en },
				changeKindOf,
				diffRequestFor,
				discardRequestFor,
				previewsAsImage,
				FILE_ICON_BY_EXTENSION,
				FILE_ICON_BY_NAME,
				FILE_ICON_SVGS,
				fileIconFor,
				FileTypeIcon,
				fill,
				graphShapes,
				groupEdges,
				layoutGraph,
				parsePatch,
				splitCommitPatch,
				wordDiff,
				languageOf,
				tokenizeLine,
				diffStatBlocks,
				relativeTime,
				splitPath,
				fileAddress,
				GitPanelBody,
				DiffSkeleton,
				DiffBody,
			},
		}
	},
})
