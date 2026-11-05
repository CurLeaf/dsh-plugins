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
	id: 'dsh-git-panel',
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
		const POLL_MS = 6000
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

		/**
		 * 评审期临时回退点（TEMP）。
		 *
		 * 会话工作目录不是 Git 仓库时（例如日常会话停在 ~/WorkSpace 这类聚合目录），
		 * Git 分区退回到这个仓库，方便一边改插件源码一边看改动。
		 * 评审结束把 `FALLBACK_REPO_CWD` 设为 '' 即可恢复原状。
		 */
		const FALLBACK_REPO_CWD = '/home/yxw/WorkSpace/dsh-plugins'

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
			'diff.lines': '{count} 行',
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
			'status.refresh': '刷新',
			'status.fetch': '抓取',
			'status.pull': '拉取',
			'status.push': '推送',
			'status.sync': '同步',
			'status.busy': '执行中…',
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
			'commit.placeholder': '提交信息（{mod}+↵ 提交到 “{branch}”）',
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
			'diff.lines': '{count} lines',
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
			'status.refresh': 'Refresh',
			'status.fetch': 'Fetch',
			'status.pull': 'Pull',
			'status.push': 'Push',
			'status.sync': 'Sync',
			'status.busy': 'Working…',
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
			'commit.placeholder': 'Message ({mod}+↵ to commit on "{branch}")',
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
/* Apple-flavoured design tokens, scoped to the panel. */
.gp-root{
  --gp-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --gp-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  --gp-label:rgba(255,255,255,.92);
  --gp-label-2:rgba(235,235,245,.62);
  --gp-label-3:rgba(235,235,245,.38);
  --gp-label-4:rgba(235,235,245,.20);
  --gp-fill-2:rgba(120,120,128,.28);
  --gp-fill-3:rgba(120,120,128,.20);
  --gp-fill-4:rgba(120,120,128,.12);
  --gp-separator:rgba(84,84,88,.62);
  --gp-accent:#80a1c0;
  --gp-accent-hover:#8db0cf;
  --gp-accent-dim:#3a4552;
  --gp-accent-ink:#101720;
  --gp-red:#ff453a;
  --gp-green:#30d158;
  --gp-orange:#ff9f0a;
  --gp-yellow:#ffd60a;
  --gp-blue:#0a84ff;
  --gp-purple:#bf5af2;
  --gp-radius:8px;
  display:flex;flex-direction:column;height:100%;min-height:0;position:relative;
  font-family:var(--gp-font);font-size:12.5px;line-height:1.45;letter-spacing:-.006em;
  color:var(--gp-label);background:transparent;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
.gp-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.gp-review{flex:none;position:relative;display:flex;flex-direction:column;gap:6px;padding:8px 10px}
.gp-review-btn{width:100%;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:none;border-radius:7px;background:var(--gp-fill-3);color:var(--gp-label);font:inherit;font-size:12.5px;font-weight:560;cursor:pointer;transition:background .12s ease-out}
.gp-review-btn:hover:not(:disabled){background:var(--gp-fill-2)}
.gp-review-btn:disabled{opacity:.42;cursor:default}
.gp-review-head{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--gp-label-3);cursor:pointer;user-select:none}
.gp-review-head:hover{color:var(--gp-label-2)}
.gp-changes{flex:1;min-height:80px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.gp-resizer{flex:none;position:relative;height:8px;cursor:row-resize;background:transparent;user-select:none;touch-action:none}
.gp-resizer:hover,.gp-resizer:active{background:var(--gp-fill-3)}
.gp-graph-panel{flex:none;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.gp-toolbar{display:flex;align-items:center;gap:6px;flex:none;padding:8px 10px;border-bottom:.5px solid var(--gp-separator)}
.gp-toolbar .gp-spacer{flex:1}
.gp-branch{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;height:22px;padding:0 8px;border-radius:6px;background:var(--gp-fill-3);color:var(--gp-label);font-family:var(--gp-mono);font-size:11px;letter-spacing:0;border:none;cursor:pointer;transition:background .12s ease-out}
.gp-branch:hover{background:var(--gp-fill-2)}
.gp-branch span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-tag{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--gp-fill-3);color:var(--gp-label-2)}
.gp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;min-width:24px;padding:0 6px;border-radius:6px;border:none;background:transparent;color:var(--gp-label-2);font:inherit;font-size:11.5px;cursor:pointer;transition:background .12s ease-out,color .12s ease-out}
.gp-btn:hover:not(:disabled){background:var(--gp-fill-3);color:var(--gp-label)}
.gp-btn:active:not(:disabled){background:var(--gp-fill-2)}
.gp-btn:disabled{opacity:.38;cursor:default}
.gp-btn svg{width:13px;height:13px;flex:none}
.gp-btn-danger:hover:not(:disabled){background:rgba(255,69,58,.18);color:var(--gp-red)}
.gp-primary{height:28px;padding:0 12px;border-radius:7px;border:none;background:var(--gp-accent);color:var(--gp-accent-ink);font:inherit;font-size:12.5px;font-weight:590;letter-spacing:-.01em;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .12s ease-out,transform .06s ease-out}
.gp-primary:hover:not(:disabled){background:var(--gp-accent-hover)}
.gp-primary:active:not(:disabled){transform:scale(.985)}
.gp-primary:disabled{background:var(--gp-accent-dim);color:var(--gp-label-3);cursor:default}
.gp-compose{flex:none;display:flex;flex-direction:column;gap:8px;padding:10px}
.gp-input{box-sizing:border-box;width:100%;min-height:36px;max-height:132px;resize:none;field-sizing:content;padding:8px 10px;border-radius:var(--gp-radius);border:.5px solid rgba(255,255,255,.07);background:#2e2e2e;color:rgba(255,255,255,.94);font:inherit;font-size:12.5px;line-height:1.45;outline:none;transition:border-color .12s ease-out,box-shadow .12s ease-out}
.gp-input:focus{border-color:var(--gp-accent);box-shadow:0 0 0 3.5px rgba(128,161,192,.28)}
.gp-input::placeholder{color:var(--gp-label-3)}
.gp-compose .gp-input-wrap{position:relative;display:flex}
.gp-input-wrap .gp-input{padding-right:34px}
.gp-input-ai{position:absolute;top:5px;right:5px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:6px;background:transparent;color:var(--gp-label-3);cursor:pointer;transition:background .12s ease-out,color .12s ease-out}
.gp-input-ai:hover:not(:disabled){background:var(--gp-fill-3);color:var(--gp-label)}
.gp-input-ai:disabled{opacity:.35;cursor:default}
.gp-input-ai svg{width:14px;height:14px;flex:none}
.gp-actions{display:flex;align-items:center;gap:6px}
.gp-actions > .gp-primary{flex:1}
.gp-actions .gp-primary{width:100%;height:32px;justify-content:center;gap:6px;font-size:13px;border-radius:8px}
.gp-actions .gp-primary svg{width:14px;height:14px;flex:none}
.gp-actions .gp-primary-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-menu-wrap{position:relative}
.gp-menu{position:absolute;z-index:40;top:calc(100% + 6px);right:0;min-width:200px;padding:5px;border-radius:10px;border:.5px solid rgba(255,255,255,.1);background:rgba(40,40,44,.86);backdrop-filter:saturate(180%) blur(24px);-webkit-backdrop-filter:saturate(180%) blur(24px);box-shadow:0 12px 32px rgba(0,0,0,.48),0 0 0 .5px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:1px}
.gp-menu button{display:flex;width:100%;align-items:center;gap:7px;height:28px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:var(--gp-label);font:inherit;font-size:12.5px;text-align:left;cursor:pointer;transition:background .1s ease-out}
.gp-menu button:hover:not(:disabled){background:var(--gp-accent)}
.gp-menu button:hover:not(:disabled){color:var(--gp-accent-ink)}
.gp-menu button:disabled{opacity:.4;cursor:default}
.gp-section{flex:none}
.gp-section-head{display:flex;align-items:center;gap:6px;padding:0 8px 0 10px;min-height:30px;cursor:pointer;user-select:none;transition:background .1s ease-out}
.gp-section-head:hover{background:var(--gp-fill-4)}
.gp-section-title{font-weight:600;font-size:11px;letter-spacing:.055em;text-transform:uppercase;color:var(--gp-label-3)}
.gp-section-count{margin-left:2px;font-size:11px;color:var(--gp-label-3);font-variant-numeric:tabular-nums}
.gp-chevron{width:11px;height:11px;flex:none;color:var(--gp-label-3);transition:transform .18s cubic-bezier(.32,.72,0,1)}
.gp-chevron.open{transform:rotate(90deg)}
.gp-section-actions{margin-left:auto;display:flex;align-items:center;gap:2px}
.gp-group-head{display:flex;align-items:center;gap:6px;padding:2px 8px 2px 22px;min-height:22px;color:var(--gp-label-3);font-size:11px;font-weight:500}
.gp-group-head .gp-section-actions{gap:0}
.gp-row{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 6px 0 22px;cursor:pointer;position:relative;transition:background .1s ease-out}
.gp-row:hover{background:var(--gp-fill-4)}
.gp-row.selected{background:rgba(128,161,192,.18)}
.gp-row .gp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;letter-spacing:-.006em}
.gp-row .gp-name .gp-dir{color:var(--gp-label-3)}
/* One chip per change kind: M pencil, A plus, U dashed plus, D minus, R arrow,
   C copy, T swap, CONFLICT alert. The chip carries the colour; the tooltip and
   aria-label carry the word. */
.gp-change{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5.5px;background:var(--gp-fill-4);border:.5px solid transparent;color:var(--gp-label-2);transition:background .12s ease-out}
.gp-change svg{width:12px;height:12px;flex:none}
.gp-change.M{color:var(--gp-orange);background:rgba(255,159,10,.13);border-color:rgba(255,159,10,.3)}
.gp-change.A{color:var(--gp-green);background:rgba(48,209,88,.13);border-color:rgba(48,209,88,.3)}
.gp-change.U{color:var(--gp-green);background:rgba(48,209,88,.06);border:.5px dashed rgba(48,209,88,.55)}
.gp-change.D{color:var(--gp-red);background:rgba(255,69,58,.13);border-color:rgba(255,69,58,.3)}
.gp-change.R,.gp-change.C{color:var(--gp-blue);background:rgba(10,132,255,.14);border-color:rgba(10,132,255,.32)}
.gp-change.T{color:var(--gp-purple);background:rgba(191,90,242,.14);border-color:rgba(191,90,242,.32)}
.gp-change.CONFLICT{color:var(--gp-red);background:rgba(255,69,58,.2);border-color:rgba(255,69,58,.45)}
.gp-ftype{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;color:var(--gp-label-3)}
.gp-ftype svg{width:14px;height:14px;flex:none}
.gp-ftype.code{color:#e0c07a}
.gp-ftype.style{color:#6fc7e8}
.gp-ftype.doc{color:#7fa6cf}
.gp-ftype.image{color:#c08ed6}
.gp-ftype.media{color:#e08ab0}
.gp-ftype.font{color:#d8c98a}
.gp-ftype.archive{color:#9aa3ad}
.gp-ftype.lock{color:#a9a9b3}
.gp-ftype.data{color:#8fcfa0}
.gp-ftype.shell{color:#8fd39a}
.gp-row-conflict .gp-change{color:var(--gp-red)}
.gp-counts{display:flex;gap:5px;flex:none;font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--gp-label-3);font-family:var(--gp-mono)}
.gp-add{color:var(--gp-green)}
.gp-del{color:var(--gp-red)}
.gp-row-actions{display:none;align-items:center;gap:1px;flex:none}
.gp-row:hover .gp-row-actions{display:flex}
.gp-row:hover .gp-counts{display:none}
.gp-row:hover .gp-change{display:none}
.gp-graph{position:relative}
.gp-graph-row{display:flex;align-items:center;gap:8px;min-height:38px;padding:0 8px 0 0;cursor:pointer;position:relative;transition:background .1s ease-out}
.gp-graph-row:hover{background:var(--gp-fill-4)}
.gp-graph-row.selected{background:rgba(128,161,192,.18)}
.gp-graph-canvas{flex:none;display:block;overflow:visible}
.gp-graph-row:hover .gp-graph-canvas{filter:brightness(1.18)}
.gp-graph-row.selected .gp-graph-canvas{filter:brightness(1.3) saturate(1.1)}
.gp-graph-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.gp-graph-subject{display:flex;align-items:center;gap:6px;min-width:0}
.gp-graph-subject .gp-subject-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.gp-ref{flex:none;max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--gp-fill-3);color:var(--gp-label-2);font-weight:500}
.gp-ref.head{background:rgba(10,132,255,.24);color:#9dc0ff}
.gp-ref.tag{background:rgba(255,159,10,.2);color:#ffc477}
.gp-ref.remote{background:rgba(191,90,242,.2);color:#d7a8ff}
.gp-graph-meta{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--gp-label-3)}
.gp-graph-meta .gp-hash{font-family:var(--gp-mono)}
.gp-detail{padding:8px 10px 10px 22px;border-bottom:.5px solid var(--gp-separator);background:rgba(120,120,128,.08)}
.gp-detail-body{white-space:pre-wrap;word-break:break-word;font-size:11.5px;color:var(--gp-label-2);margin:5px 0 7px}
.gp-kv{display:flex;gap:7px;font-size:11px;color:var(--gp-label-3)}
.gp-kv b{font-weight:590;color:var(--gp-label-2)}
.gp-detail-actions{display:flex;gap:2px;margin-top:7px}
.gp-detail-files{margin-top:7px;display:flex;flex-direction:column;gap:2px;max-height:168px;overflow:auto}
.gp-detail-file{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--gp-label-2)}
.gp-detail-file .gp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-note{padding:12px;color:var(--gp-label-3);font-size:11.5px;text-align:center}
.gp-error{margin:8px;padding:8px 10px;border-radius:10px;background:rgba(255,69,58,.12);border:.5px solid rgba(255,69,58,.28);color:var(--gp-label);font-size:11.5px;display:flex;gap:8px;align-items:center}
.gp-error span{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}
/* Confirmation is an in-panel overlay anchored to the bottom edge: it used to be
   a sticky row at the end of the column, which landed outside the visible pane
   whenever the graph held its height. */
.gp-confirm-scrim{position:absolute;inset:0;z-index:60;display:flex;align-items:flex-end;padding:8px;background:rgba(12,12,14,.32)}
.gp-confirm{flex:1;padding:9px 10px;border-radius:10px;background:rgba(44,44,48,.96);backdrop-filter:saturate(180%) blur(24px);-webkit-backdrop-filter:saturate(180%) blur(24px);border:.5px solid rgba(255,255,255,.12);box-shadow:0 12px 32px rgba(0,0,0,.5);font-size:11.5px;display:flex;gap:8px;align-items:center}
.gp-confirm span{flex:1;min-width:0;line-height:1.45}
.gp-confirm .gp-primary{height:24px;padding:0 10px;font-size:11.5px;flex:none}
.gp-diff{display:flex;flex-direction:column;height:100%;min-height:0;font-size:11.5px}
.gp-diff-head{display:flex;align-items:center;gap:7px;padding:0 10px;min-height:34px;flex:none;border-bottom:.5px solid var(--gp-separator)}
.gp-diff-head .gp-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--gp-mono);font-size:11.5px}
.gp-diff-body{flex:1;min-height:0;overflow:auto;font-family:var(--gp-mono);font-size:11.5px;line-height:18px;scrollbar-width:thin}
.gp-diff-line{display:flex;min-width:max-content;white-space:pre}
.gp-diff-line .gp-ln{flex:none;width:42px;padding-right:8px;text-align:right;color:var(--gp-label-4);user-select:none;font-variant-numeric:tabular-nums}
.gp-diff-line .gp-sign{flex:none;width:12px;text-align:center}
.gp-diff-line .gp-code{flex:1;padding-right:14px;white-space:pre}
.gp-diff-line.add{background:rgba(48,209,88,.13)}
.gp-diff-line.add .gp-sign{color:var(--gp-green)}
.gp-diff-line.del{background:rgba(255,69,58,.13)}
.gp-diff-line.del .gp-sign{color:var(--gp-red)}
.gp-diff-line.hunk{background:var(--gp-fill-4);color:var(--gp-label-3)}
.gp-diff-line.meta{color:var(--gp-label-3)}
.gp-diff-line .gp-prefix{color:var(--gp-label-3)}
.gp-spinner{display:inline-block;width:11px;height:11px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:gp-spin .7s linear infinite}
@keyframes gp-spin{to{transform:rotate(360deg)}}

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
		 * Turn one unified diff into renderable rows, tracking both line numbers.
		 * @param {string} patch - unified diff text.
		 * @param {number} [limit] - row cap; the tail is dropped.
		 * @returns {{rows: object[], truncated: boolean, additions: number, deletions: number}} rows and totals.
		 */
		function parsePatch(patch, limit = 6000) {
			const rows = []
			let oldNo = 0
			let newNo = 0
			let truncated = false
			let additions = 0
			let deletions = 0
			for (const line of String(patch ?? '').split('\n')) {
				if (rows.length >= limit) {
					truncated = true
					break
				}
				if (line.startsWith('@@')) {
					const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
					if (match !== null) {
						oldNo = Number.parseInt(match[1], 10)
						newNo = Number.parseInt(match[2], 10)
					}
					rows.push({ kind: 'hunk', text: line, oldNo: '', newNo: '' })
					continue
				}
				if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
					rows.push({ kind: 'meta', text: line, oldNo: '', newNo: '' })
					continue
				}
				if (
					line.startsWith('new file') ||
					line.startsWith('deleted file') ||
					line.startsWith('old mode') ||
					line.startsWith('new mode') ||
					line.startsWith('similarity') ||
					line.startsWith('rename ') ||
					line.startsWith('Binary files') ||
					line.startsWith('\\')
				) {
					rows.push({ kind: 'meta', text: line, oldNo: '', newNo: '' })
					continue
				}
				if (line.startsWith('+')) {
					additions += 1
					rows.push({ kind: 'add', text: line.slice(1), oldNo: '', newNo: newNo })
					newNo += 1
					continue
				}
				if (line.startsWith('-')) {
					deletions += 1
					rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo, newNo: '' })
					oldNo += 1
					continue
				}
				if (line.startsWith(' ')) {
					rows.push({ kind: 'context', text: line.slice(1), oldNo: oldNo, newNo: newNo })
					oldNo += 1
					newNo += 1
					continue
				}
				if (line === '') continue
				rows.push({ kind: 'context', text: line, oldNo: '', newNo: '' })
			}
			return { rows, truncated, additions, deletions }
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
		const PlusIcon = () => h('svg', iconProps, h('path', { d: 'M8 3v10M3 8h10' }))
		const MinusIcon = () => h('svg', iconProps, h('path', { d: 'M3 8h10' }))
		const UndoIcon = () => h('svg', iconProps, h('path', { d: 'M3 8a5 5 0 1 1 1.6 3.7' }), h('path', { d: 'M3 3.6V8h4.4' }))
		const DiffIcon = () => h('svg', iconProps, h('path', { d: 'M4 2.5v6' }), h('path', { d: 'M2 5.5h4' }), h('path', { d: 'M10 10.5h4' }), h('path', { d: 'M2.5 13.5h11' }))
		const FileIcon = () => h('svg', iconProps, h('path', { d: 'M9 1.8H4.4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5.3z' }), h('path', { d: 'M9 1.8v3.5h3.6' }))

		/**
		 * File families, most specific first.
		 *
		 * A lockfile is checked before "config" (`package-lock.json` is a JSON
		 * file), an image before "code" (`.svg` is text), and a shell script
		 * before "code" too. Order is the whole contract here.
		 */
		const FILE_FAMILIES = [
			['lock', /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|bun\.lockb?)$/iu],
			['image', /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|tiff?|heic|psd)$/iu],
			['media', /\.(?:mp4|mov|mkv|avi|webm|mp3|wav|flac|ogg|m4a|aac|opus)$/iu],
			['font', /\.(?:woff2?|ttf|otf|eot)$/iu],
			['archive', /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|zst|jar|war|exe|dll|so|dylib|bin|wasm|node|class|o|a|dmg|pkg|deb|rpm)$/iu],
			['style', /\.(?:css|scss|sass|less|styl|stylus)$/iu],
			['shell', /\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/iu],
			['data', /\.(?:json5?|jsonc|ya?ml|toml|ini|cfg|conf|env|properties|csv|tsv|xml|plist|lock)$/iu],
			['doc', /\.(?:md|markdown|mdx|txt|rst|adoc|org|tex)$/iu],
			['code', /\.(?:js|mjs|cjs|jsx|ts|tsx|vue|svelte|astro|py|rb|php|go|rs|java|kt|kts|scala|swift|c|h|cc|cpp|cxx|hpp|m|mm|cs|lua|pl|r|dart|ex|exs|erl|hs|clj|zig|nim|sql|graphql|gql|html?|xhtml|tpl|ejs|hbs|pug|slim)$/iu],
		]

		/**
		 * Which family a path belongs to.
		 * @param {string} path - repository-relative path.
		 * @returns {string} family id, `plain` when nothing matches.
		 */
		function fileFamilyOf(path) {
			const name = String(path ?? '')
			for (const [id, pattern] of FILE_FAMILIES) {
				if (pattern.test(name)) return id
			}
			return 'plain'
		}

		/** One coloured glyph per file family; the change chip sits on the right. */
		function FileTypeIcon({ path }) {
			const family = fileFamilyOf(path)
			const Glyph = FILE_FAMILY_ICONS[family] ?? FileIcon
			return h('span', { className: `gp-ftype ${family}` }, h(Glyph, null))
		}

		/** Glyph per family; `plain` is the generic page. */
		const FILE_FAMILY_ICONS = {
			image: () => h(ImageIcon, null),
			media: () => h(MediaIcon, null),
			font: () => h(FontIcon, null),
			archive: () => h(BoxIcon, null),
			style: () => h(HashIcon, null),
			shell: () => h(TerminalIcon, null),
			data: () => h(BracesIcon, null),
			doc: () => h(DocIcon, null),
			code: () => h(CodeIcon, null),
			lock: () => h(LockIcon, null),
			plain: () => h(FileIcon, null),
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
		 * The coloured chip that says *how* a file changed.
		 * @param {object} props - `entry` and the translator.
		 * @returns {object} the chip.
		 */
		function ChangeBadge({ entry, t, group }) {
			const kind = changeKindOf(entry, group)
			const key = kind === 'CONFLICT' ? 'change.conflict' : `change.${kind}`
			const renamedFrom = kind === 'R' && typeof entry?.originalPath === 'string' && entry.originalPath !== '' ? entry.originalPath : ''
			const label = renamedFrom === '' ? t(key) : `${t(key)} · ${renamedFrom}`
			const Glyph = CHANGE_ICONS[kind] ?? ChangeModifyIcon
			return h('span', { className: `gp-change ${kind}`, title: label, role: 'img', 'aria-label': label }, h(Glyph, null))
		}

		/** Glyph per change kind. */
		const CHANGE_ICONS = {
			M: () => h(ChangeModifyIcon, null),
			A: () => h(ChangeAddIcon, null),
			U: () => h(ChangeUntrackedIcon, null),
			D: () => h(ChangeDeleteIcon, null),
			R: () => h(ChangeRenameIcon, null),
			C: () => h(ChangeCopyIcon, null),
			T: () => h(ChangeTypeIcon, null),
			CONFLICT: () => h(ChangeConflictIcon, null),
		}

		const TrashIcon = () => h('svg', iconProps, h('path', { d: 'M2.8 4.4h10.4' }), h('path', { d: 'M6.4 4.4V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.2' }), h('path', { d: 'M4.2 4.4l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2' }))
		const CloudIcon = () => h('svg', iconProps, h('path', { d: 'M4.4 11.6a2.6 2.6 0 0 1-.3-5.2 3.6 3.6 0 0 1 6.9-.7 2.6 2.6 0 0 1 1 5.9z' }))
		const CaretIcon = () => h('svg', { ...iconProps, width: 12, height: 12 }, h('path', { d: 'M4 6.5 8 10.5l4-4' }))
		const CopyIcon = () => h('svg', iconProps, h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.4 }), h('path', { d: 'M10.5 3.6V2.9a1 1 0 0 0-1-1H2.9a1 1 0 0 0-1 1v6.6a1 1 0 0 0 1 1h.7' }))
		const CheckIcon = () => h('svg', iconProps, h('path', { d: 'M3 8.4 6.3 11.7 13 4.6' }))
		const CodeIcon = () => h('svg', glyphProps, h('path', { d: 'M5.8 3.6 2.2 8l3.6 4.4' }), h('path', { d: 'M10.2 3.6 13.8 8l-3.6 4.4' }))
		const ImageIcon = () =>
			h('svg', glyphProps, h('rect', { x: 2.4, y: 3.2, width: 11.2, height: 9.6, rx: 2 }), h('circle', { cx: 6, cy: 6.7, r: 1 }), h('path', { d: 'M3.4 11.6 6.9 8.6l2.1 1.8 2-1.7 1.6 1.4' }))
		const DocIcon = () =>
			h(
				'svg',
				glyphProps,
				h('path', { d: 'M9 1.8H4.4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V5.3z' }),
				h('path', { d: 'M9 1.8v3.5h3.6' }),
				h('path', { d: 'M5.4 9.2h5.2M5.4 11.5h3.4' }),
			)
		const BracesIcon = () =>
			h(
				'svg',
				glyphProps,
				h('path', { d: 'M6.2 2.6c-1 0-1.6.5-1.6 1.5v1.5c0 .9-.5 1.4-1.4 1.4.9 0 1.4.5 1.4 1.4v1.5c0 1 .6 1.5 1.6 1.5' }),
				h('path', { d: 'M9.8 2.6c1 0 1.6.5 1.6 1.5v1.5c0 .9.5 1.4 1.4 1.4-.9 0-1.4.5-1.4 1.4v1.5c0 1-.6 1.5-1.6 1.5' }),
			)
		const HashIcon = () => h('svg', glyphProps, h('path', { d: 'M6.4 2.8 5.2 13.2M10.8 2.8 9.6 13.2' }), h('path', { d: 'M3 6.2h10.4M2.6 10h10.4' }))
		const MediaIcon = () =>
			h('svg', glyphProps, h('rect', { x: 2.2, y: 4, width: 11.6, height: 8, rx: 1.8 }), h('path', { d: 'M6.8 6.4l3 1.6-3 1.6z' }))
		const FontIcon = () => h('svg', glyphProps, h('path', { d: 'M4.3 12.6 8 3.4l3.7 9.2' }), h('path', { d: 'M5.6 9.6h4.8' }))
		const BoxIcon = () => h('svg', glyphProps, h('path', { d: 'M2.6 5.5 8 2.9l5.4 2.6v5L8 13.1l-5.4-2.6z' }), h('path', { d: 'M2.6 5.5 8 8.1l5.4-2.6M8 8.1v5' }))
		const LockIcon = () => h('svg', glyphProps, h('rect', { x: 3.6, y: 7, width: 8.8, height: 6.4, rx: 1.4 }), h('path', { d: 'M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7' }))
		const TerminalIcon = () => h('svg', glyphProps, h('rect', { x: 2.2, y: 3.4, width: 11.6, height: 9.2, rx: 1.8 }), h('path', { d: 'M4.6 6.4 6.6 8.2l-2 1.8M8.4 10.2h3' }))

		/* Change-kind glyphs: the shape says *what happened*, the chip colour says
		   which side of the index it happened on. */
		const ChangeModifyIcon = () =>
			h('svg', glyphProps, h('path', { d: 'M3.4 12.6l.5-2.4 6.4-6.4 1.9 1.9-6.4 6.4-2.4.5z' }), h('path', { d: 'M9.2 4.9l1.9 1.9' }))
		const ChangeAddIcon = () =>
			h('svg', glyphProps, h('path', { d: 'M9.2 2.4H4.6a1 1 0 0 0-1 1v9.2a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V5.8z' }), h('path', { d: 'M9.2 2.4v3.4h3.4M8 7.6v4M6 9.6h4' }))
		const ChangeUntrackedIcon = () =>
			h('svg', glyphProps, h('path', { d: 'M9.2 2.4H4.6a1 1 0 0 0-1 1v9.2a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V5.8z' }), h('path', { d: 'M8 7.6v4M6 9.6h4' }))
		const ChangeDeleteIcon = () => h('svg', glyphProps, h('path', { d: 'M3.4 8h9.2' }))
		const ChangeRenameIcon = () =>
			h('svg', glyphProps, h('path', { d: 'M2.8 8h8.6' }), h('path', { d: 'M8.4 5.2 11.2 8l-2.8 2.8' }), h('path', { d: 'M13.2 3.6v8.8' }))
		const ChangeCopyIcon = () =>
			h('svg', glyphProps, h('rect', { x: 2.4, y: 6, width: 6.2, height: 6.2, rx: 1.2 }), h('path', { d: 'M5.6 6V4.4a1 1 0 0 1 1-1h5.2a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H10' }))
		const ChangeTypeIcon = () =>
			h('svg', glyphProps, h('path', { d: 'M3.4 5.6h7.2' }), h('path', { d: 'M8.4 3.4 10.6 5.6 8.4 7.8' }), h('path', { d: 'M12.6 10.4H5.4' }), h('path', { d: 'M7.6 8.2 5.4 10.4 7.6 12.6' }))
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

			const load = useCallback(
				async (signal, silent) => {
					if (cwd === undefined || cwd === '' || enabled !== true) return undefined
					if (silent !== true) setLoading(true)
					try {
						const next = await call(action, { cwd, ...(params ?? {}) }, signal)
						setValue(next)
						setError(undefined)
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
				const timer = setInterval(() => {
					if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
					const controller = new AbortController()
					load(controller.signal, true)
				}, poll)
				const onFocus = () => {
					const controller = new AbortController()
					load(controller.signal, true)
				}
				window.addEventListener('focus', onFocus)
				return () => {
					clearInterval(timer)
					window.removeEventListener('focus', onFocus)
				}
			}, [load, poll, enabled])

			const refresh = useCallback(
				(silent) => {
					const controller = new AbortController()
					return load(controller.signal, silent === true)
				},
				[load],
			)

			return { value, error, loading, refresh }
		}

		/* ------------------------------------------------------------------ */
		/* Shared little components                                            */
		/* ------------------------------------------------------------------ */

		/** A ghost icon button with an accessible label. */
		function IconButton({ label, onClick, disabled, danger, children }) {
			return h(
				'button',
				{
					type: 'button',
					className: `gp-btn${danger === true ? ' gp-btn-danger' : ''}`,
					title: label,
					'aria-label': label,
					disabled: disabled === true,
					onClick: (event) => {
						event.stopPropagation()
						onClick?.(event)
					},
				},
				children,
			)
		}

		/** One collapsible section header. */
		function SectionHeader({ title, count, expanded, onToggle, actions, t }) {
			return h(
				'div',
				{ className: 'gp-section-head', onClick: onToggle, role: 'button', tabIndex: 0, onKeyDown: (event) => (event.key === 'Enter' || event.key === ' ' ? onToggle?.() : undefined) },
				h(ChevronIcon, { className: `gp-chevron${expanded ? ' open' : ''}` }),
				h('span', { className: 'gp-section-title' }, title),
				count === undefined ? null : h('span', { className: 'gp-section-count' }, String(count)),
				h('div', { className: 'gp-section-actions', onClick: (event) => event.stopPropagation() }, actions),
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
			const select = () => onOpenDiff(entry, group)
			const showCounts = entry.additions > 0 || entry.deletions > 0
			const conflicted = group === 'conflicts'
			return h(
				'div',
				{
					className: `gp-row${conflicted ? ' gp-row-conflict' : ''}`,
					title: conflicted ? `${entry.path} · ${t('conflict.badge')}` : entry.path,
					role: 'button',
					tabIndex: 0,
					onClick: select,
					onKeyDown: (event) => (event.key === 'Enter' ? select() : undefined),
				},
				h(FileTypeIcon, { path: entry.path }),
				h('span', { className: 'gp-name' }, dir === '' ? null : h('span', { className: 'gp-dir' }, dir), name),
				showCounts
					? h('span', { className: 'gp-counts' }, h('span', { className: 'gp-add' }, `+${entry.additions}`), h('span', { className: 'gp-del' }, `-${entry.deletions}`))
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
					h(IconButton, { label: t('row.openDiff'), onClick: () => onOpenDiff(entry, group) }, h(DiffIcon, null)),
					h(IconButton, { label: t('row.openFile'), onClick: () => onOpenFile(entry) }, h(FileIcon, null)),
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
			/** TEMP: 会话目录不是仓库时改用回退仓库，见 FALLBACK_REPO_CWD。 */
			const [usingFallback, setUsingFallback] = useState(false)
			const cwd = usingFallback && FALLBACK_REPO_CWD !== '' ? FALLBACK_REPO_CWD : sessionRepoCwd

			const [statusVersion, setStatusVersion] = useState(0)
			const [graphVersion, setGraphVersion] = useState(0)
			const [busy, setBusy] = useState(false)
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

			// TEMP: 会话目录不是 Git 仓库（或还没有会话目录）时，退回到回退仓库。
			useEffect(() => {
				if (usingFallback || FALLBACK_REPO_CWD === '') return
				if (sessionRepoCwd === FALLBACK_REPO_CWD) return
				if (value !== undefined && value.repo !== true) setUsingFallback(true)
			}, [usingFallback, sessionRepoCwd, value])
			const repo = value?.repo === true ? value : undefined

			const graph = useRoute(
				cwd,
				'graph',
				{ all: graphAll, limit: 60 },
				{ enabled: expanded.graph && repo !== undefined, version: graphVersion },
			)
			const graphRows = useMemo(() => layoutGraph(Array.isArray(graph.value?.commits) ? graph.value.commits : []), [graph.value])

			/** Run one Host action with the shared busy/error handling. */
			const run = useCallback(
				async (action, payload, options = {}) => {
					if (cwd === undefined) return { ok: false, value: undefined }
					setBusy(true)
					setError(undefined)
					try {
						const result = await call(action, { cwd, ...(payload ?? {}) })
						if (typeof options.notice === 'string' && options.notice !== '') setNotice(options.notice)
						setStatusVersion((value2) => value2 + 1)
						if (options.graph !== false) setGraphVersion((value2) => value2 + 1)
						options.onDone?.(result)
						return { ok: true, value: result }
					} catch (failure) {
						setError(failure)
						return { ok: false, value: undefined }
					} finally {
						setBusy(false)
						if (options.clearConfirm !== false) setConfirming(undefined)
					}
				},
				[cwd],
			)

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
					const outcome = await run('commit', payload, { clearConfirm: false })
					if (outcome.ok !== true) return false
					// 提交即同步：先 commit，再 push（失败会走到下面的 error）。
					const pushed = await run('network', { mode: 'push' }, { graph: false, clearConfirm: false })
					const hash = outcome.value?.hash
					setNotice(
						fill(pushed.ok === true ? t('commit.donePushed') : t('commit.done'), {
							hash: typeof hash === 'string' ? hash : '',
						}),
					)
					status.refresh?.(true)
					return true
				},
				[run, status, t],
			)

			const sectionToggle = (name) => () => setExpanded((current) => ({ ...current, [name]: current[name] !== true }))

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
				h(
					'div',
					{ className: 'gp-toolbar' },
					repo === undefined
						? h('span', { className: 'gp-branch' }, h('span', { className: 'gp-spinner' }), h('span', null, t('empty.loading')))
						: h(
								'div',
								{ className: 'gp-menu-wrap' },
								h(BranchMenu, { t, repo, busy, onCheckout: (name) => run('checkout', { name }) }),
							),
					repo !== undefined && repo.detached === true ? h('span', { className: 'gp-tag' }, t('branch.detached')) : null,
					repo !== undefined && repo.ahead > 0 ? h('span', { className: 'gp-tag' }, fill(t('branch.ahead'), { count: repo.ahead })) : null,
					repo !== undefined && repo.behind > 0 ? h('span', { className: 'gp-tag' }, fill(t('branch.behind'), { count: repo.behind })) : null,
					h('span', { className: 'gp-spacer' }),
					repo === undefined
						? null
						: h(IconButton, { label: t('status.fetch'), disabled: busy, onClick: () => run('network', { mode: 'fetch' }, { graph: false }) }, h(CloudIcon, null)),
					repo === undefined ? null : h(IconButton, { label: t('status.sync'), disabled: busy, onClick: () => run('network', { mode: 'sync' }, { graph: false }) }, h(RefreshIcon, null)),
					h(IconButton, { label: t('status.refresh'), disabled: busy, onClick: () => status.refresh?.(true) }, h(RefreshIcon, null)),
				),
				error === undefined
					? null
					: h(
							'div',
							{ className: 'gp-error' },
							h('span', null, `${t('error.title')}: ${error.message}`),
							h(IconButton, { label: t('error.dismiss'), onClick: () => setError(undefined) }, h('span', { 'aria-hidden': 'true' }, '✕')),
						),
				notice === undefined ? null : h('div', { className: 'gp-note' }, notice),
				h(CommitBox, {
					t,
					status: repo,
					busy,
					onCommit,
				}),
				h(
					'div',
					{ className: 'gp-changes' },
					...sections.map((section) =>
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
					}, t('review.find')),
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
					h(
						'div',
						{ className: 'gp-section' },
						h(SectionHeader, {
							t,
							title: t('graph.title'),
							count: graphRows.rows.length,
							expanded: expanded.graph,
							onToggle: sectionToggle('graph'),
							actions: [
								h(IconButton, { key: 'all', label: graphAll ? t('graph.all') : t('graph.head'), onClick: () => setGraphAll((value2) => !value2) }, h(BranchIcon, { size: 12 })),
								h(IconButton, { key: 'refresh', label: t('status.refresh'), onClick: () => setGraphVersion((value2) => value2 + 1) }, h(RefreshIcon, null)),
							],
						}),
						expanded.graph !== true
							? null
							: graph.loading === true && graphRows.rows.length === 0
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
																				if (ref !== undefined) run('checkout', { name: ref.name })
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
								run('discard', request, { graph: false }).then((outcome) => {
									if (outcome.ok !== true) return
									setNotice(fill(t('discard.done'), { count }))
									status.refresh?.(true)
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

		/** The branch chip and its checkout menu. */
		function BranchMenu({ t, repo, busy, onCheckout }) {
			const [open, setOpen] = useState(false)
			const [branches, setBranches] = useState(undefined)
			const ref = useRef(null)

			useEffect(() => {
				if (!open || branches !== undefined) return undefined
				call('branches', { cwd: repo.cwd })
					.then((next) => setBranches(next))
					.catch(() => setBranches({ local: [], remote: [], tags: [] }))
				return undefined
			}, [open, branches, repo.cwd])

			useEffect(() => {
				if (!open) return undefined
				const onDown = (event) => {
					if (ref.current !== null && !ref.current.contains(event.target)) setOpen(false)
				}
				document.addEventListener('mousedown', onDown)
				return () => document.removeEventListener('mousedown', onDown)
			}, [open])

			const label = repo.detached === true ? (repo.oid ?? t('branch.detached')) : (repo.branch ?? t('branch.detached'))
			return h(
				'div',
				{ className: 'gp-menu-wrap', ref },
				h(
					'button',
					{ type: 'button', className: 'gp-branch', title: `${t('branch.current')}: ${label}`, onClick: () => setOpen((value) => !value) },
					h(BranchIcon, { size: 12 }),
					h('span', null, label),
				),
				open
					? h(
							'div',
							{ className: 'gp-menu', role: 'menu' },
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
									branch.current === true ? h('span', { className: 'gp-tag' }, t('branch.current')) : null,
								),
							),
							(branches?.local ?? []).length === 0 ? h('div', { className: 'gp-note' }, t('graph.loading')) : null,
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
			return h(DiffView, props)
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
			const parsed = useMemo(() => parsePatch(patch), [patch])

			const openFile = () => {
				if (tabActions === undefined || typeof request.path !== 'string' || typeof result?.root !== 'string') return
				try {
					tabActions.openResource(fileAddress(sessionId, result.root, request.path))
				} catch (failure) {
					setError(failure)
				}
			}

			return h(
				'div',
				{ className: 'gp-diff' },
				h(
					'div',
					{ className: 'gp-diff-head' },
					h('span', { className: 'gp-path', title: request.path ?? request.hash ?? t('diff.title') }, request.path ?? request.hash ?? t('diff.title')),
					mode === undefined ? null : h('span', { className: 'gp-tag' }, mode),
					parsed.additions > 0 ? h('span', { className: 'gp-add' }, `+${parsed.additions}`) : null,
					parsed.deletions > 0 ? h('span', { className: 'gp-del' }, `-${parsed.deletions}`) : null,
					typeof request.path === 'string' ? h(IconButton, { label: t('diff.openFile'), onClick: openFile }, h(FileIcon, null)) : null,
					h(IconButton, { label: t('diff.refresh'), disabled: loading, onClick: () => setVersion((value2) => value2 + 1) }, h(RefreshIcon, null)),
				),
				error === undefined ? null : h('div', { className: 'gp-error' }, h('span', null, error.message)),
				h(
					'div',
					{ className: 'gp-diff-body' },
					loading === true && parsed.rows.length === 0
						? h('div', { className: 'gp-note' }, t('empty.loading'))
						: result?.binary === true && parsed.rows.length === 0
							? h('div', { className: 'gp-note' }, t('diff.binary'))
							: parsed.rows.length === 0
								? h('div', { className: 'gp-note' }, t('diff.empty'))
								: parsed.rows.map((row, index) =>
										h(
											'div',
											{ key: index, className: `gp-diff-line ${row.kind}` },
											h('span', { className: 'gp-ln' }, row.oldNo === '' ? '' : String(row.oldNo)),
											h('span', { className: 'gp-ln' }, row.newNo === '' ? '' : String(row.newNo)),
											h('span', { className: 'gp-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''),
											h('span', { className: 'gp-code' }, row.text),
										),
									),
					parsed.truncated === true ? h('div', { className: 'gp-note' }, fill(t('diff.lines'), { count: parsed.rows.length })) : null,
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

		return {
			name: 'git-panel',
			inject: ['slots', 'locale', 'sidebarRightTabs'],
			apply,
			// Exposed for the package's own tests; not part of any slot contract.
			__test: {
				buildReviewPrompt,
				ChangeBadge,
				changeKindOf,
				diffRequestFor,
				discardRequestFor,
				fileFamilyOf,
				FileTypeIcon,
				fill,
				graphShapes,
				groupEdges,
				layoutGraph,
				parsePatch,
				relativeTime,
				splitPath,
				fileAddress,
				GitPanelBody,
				DiffBody,
			},
		}
	},
})
