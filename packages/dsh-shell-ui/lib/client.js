/**
 * Browser half of `dsh-shell-ui`.
 *
 * 两个纯外观补丁合住一个包，少一条 bundle：
 *   - 设置面板：macOS 系统设置式的居中分组卡片（原 dsh-settings-apple）
 *   - 左栏折叠：非导航的全局面板行收进「更多」菜单（原 dsh-sidebar-fold）
 *
 * 两半都只读 DOM、只写自己的 style 标签；不碰宿主与第三方插件的布局容器。
 */

window.__ModuleLoader__.load({
	id: 'dsh-shell-ui',
	factory(require) {
		/* ========= 设置面板外观（原 dsh-settings-apple） ========= */
		const settingsSurface = (() => {
		const STYLE_ID = 'dsh-shell-ui/settings.css';
		const CSS = `
/* ==================================================================
 * dsh-settings-apple — 叠加式外观层（只读取 DOM，不改插件源码）
 *
 * 分层约定（第三方插件页面尤其重要）：
 *   1. 外壳：弹窗、侧栏、内容区——完全可控，可以放心改
 *   2. 控件：input / select / textarea / button 等叶子节点——只改尺寸、
 *      圆角、字号、颜色，不碰它们所在的布局容器
 *   3. 表面：卡片、磁贴、搜索框的圆角/描边/底色——只改“皮肤”
 *   4. 布局修正：仅保留防止裁切/塌陷的最小必要规则（如市场两列、卡片等高）
 *
 * 禁止：改第三方插件容器的 padding / gap / flex / grid（历史故障来源）。
 * ================================================================== */

/* ==================================================================
 * dsh-settings-apple — 按 macOS 26 系统设置实测参数重排
 *   窗口 760×820 / 侧栏 190 / 内容边距 20
 *   卡片：圆角 10、无描边、底色比内容深、同组间距 10
 *   行：44（单行）/ 56（带说明），分隔线 1px 6% 内嵌
 * ================================================================== */

@media (min-width: 1024px) {
  /* ---------- 窗口 ---------- */
  div[role="dialog"]:has(> nav) {
    width: min(760px, calc(100vw - 64px)) !important;
    height: min(820px, calc(100vh - 64px)) !important;
    border-radius: 12px !important;
    background: var(--dsw-alias-bg-layer-2, #161618) !important;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55) !important;
    overflow: hidden !important;
  }

  /* ---------- 侧栏 ---------- */
  div[role="dialog"]:has(> nav) > nav {
    display: flex !important;
    flex-direction: column !important;
    gap: 6px !important;
    flex: none !important;
    width: 190px !important;
    max-width: 190px !important;
    padding: 16px 10px 12px !important;
    background: var(--dsw-alias-bg-layer-1, #111113) !important;
    border-right: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.07)) !important;
  }

  div[role="dialog"]:has(> nav) > nav > div:first-child {
    padding: 2px 8px 8px !important;
    font-size: 15px !important;
    font-weight: 600 !important;
    line-height: 20px !important;
  }

  div[role="dialog"]:has(> nav) > nav > div:last-child {
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 1px !important;
    min-height: 0 !important;
    overflow-y: auto !important;
  }

  div[role="dialog"]:has(> nav) > nav button {
    display: flex !important;
    flex: none !important;
    width: 100% !important;
    height: 28px !important;
    min-height: 28px !important;
    padding: 0 8px !important;
    gap: 7px !important;
    border-radius: 6px !important;
    font-size: 13px !important;
    justify-content: flex-start !important;
    text-align: left !important;
    color: var(--dsw-alias-label-secondary, #b6b6bb) !important;
  }

  div[role="dialog"]:has(> nav) > nav button:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06)) !important;
  }

  div[role="dialog"]:has(> nav) > nav button[aria-current="true"] {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.10)) !important;
    color: var(--dsw-alias-label-primary, #ececf1) !important;
    font-weight: 500 !important;
  }

  div[role="dialog"]:has(> nav) > nav button svg { width: 15px; height: 15px; flex: none; opacity: 0.85; }

  /* ---------- 内容 ---------- */
  div[role="dialog"]:has(> nav) > div:not(nav) {
    display: flex !important;
    flex: 1 1 auto !important;
    flex-direction: column !important;
    min-width: 0 !important;
  }

  div[role="dialog"]:has(> nav) [class*="_header"] {
    height: 44px !important;
    padding: 8px 12px 4px 16px !important;
  }

  div[role="dialog"]:has(> nav) [class*="_options"] {
    padding: 10px 20px 24px !important;
  }

  /* ---------- 账号页 ---------- */
  html body ._7lc4_a_section {
    width: 100%;
    max-width: 560px;
    margin: 0 auto;
    padding: 12px 0 32px;
    gap: 10px;
    font-size: 13px;
    line-height: 16px;
  }

  html body ._7lc4_a_card,
  html body ._7lc4_a_balanceCard {
    border: 0;
    border-radius: 10px;
    background: var(--dsw-alias-bg-layer-1, #111113);
  }

  html body ._7lc4_a_card { padding: 14px 16px; }
  html body ._7lc4_a_balanceCard { padding: 2px 16px; gap: 0; }

  html body ._7lc4_a_identity { gap: 10px; min-height: 36px; }
  html body ._7lc4_a_avatar { width: 36px; height: 36px; }
  html body ._7lc4_a_name { font-size: 13px; font-weight: 600; line-height: 16px; }
  html body ._7lc4_a_status { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #8a8a90); }
  html body ._7lc4_a_accountInfo {
    gap: 2px;
    font-size: 11px;
    line-height: 14px;
    color: var(--dsw-alias-label-tertiary, #9a9aa0);
  }
  html body ._7lc4_a_accountInfo:hover { color: var(--dsw-alias-label-primary, #ececf1); }
  html body ._7lc4_a_row { min-height: 44px; padding: 10px 0; gap: 16px; }
  html body ._7lc4_a_row > span:first-child { color: var(--dsw-alias-label-secondary, #b9b9bf); }
  html body ._7lc4_a_amount {
    font-size: 17px;
    font-weight: 600;
    line-height: 22px;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
  }
  html body ._7lc4_a_divider { border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.07)); }
  html body ._7lc4_a_balanceCard > ._7lc4_a_row:last-child { justify-content: flex-end; gap: 8px; }
  html body ._7lc4_a_balanceCard > ._7lc4_a_row:last-child > span:first-child { display: none; }
  html body ._7lc4_a_links { gap: 8px; }
  html body ._7lc4_a_linkButton {
    min-width: 64px;
    height: 24px;
    padding: 0 10px;
    border-radius: 6px;
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.12));
    font-size: 12px;
    font-weight: 400;
    line-height: 1;
  }
  html body ._7lc4_a_primary { border-color: transparent; }

  /* ---------- 跨页共享：标题、说明、卡片、控件 ---------- */
  div[role="dialog"]:has(> nav) [class*="_options"] h2 {
    margin: 0 0 4px !important;
    font-size: 15px !important;
    font-weight: 600 !important;
    line-height: 20px !important;
  }

  div[role="dialog"]:has(> nav) [class*="_options"] h3 {
    font-size: 13px !important;
    font-weight: 600 !important;
    line-height: 16px !important;
  }

  /* 卡片：去掉插件自带的描边，统一 10 圆角、暗一档底色 */
  div[role="dialog"]:has(> nav) [class*="_options"] [class$="_card"],
  div[role="dialog"]:has(> nav) [class*="_options"] [class$="_rowCard"],
  div[role="dialog"]:has(> nav) [class*="_options"] [class$="_recentTile"],
  div[role="dialog"]:has(> nav) [class*="_options"] [class$="_card"]:hover {
    border: 1px solid rgba(255, 255, 255, 0.07) !important;
    border-radius: 10px !important;
    background: var(--dsw-alias-bg-layer-1, #1c1c1f) !important;
  }

  /* 输入框 / 文本域：与 macOS 一致的 24 高、6 圆角 */
  div[role="dialog"]:has(> nav) [class*="_options"] input:not([type="checkbox"]):not([type="radio"]),
  div[role="dialog"]:has(> nav) [class*="_options"] select {
    border-radius: 6px !important;
  }

  div[role="dialog"]:has(> nav) [class*="_options"] textarea {
    border-radius: 6px !important;
    font-size: 12px !important;
    line-height: 16px !important;
  }

  div[role="dialog"]:has(> nav) [class*="_options"] input[type="checkbox"],
  div[role="dialog"]:has(> nav) [class*="_options"] input[type="radio"] {
    width: 14px !important;
    height: 14px !important;
  }

  /* 小标签页：插件列表 / 插件市场 / 计费 / 桌宠 */
  div[role="dialog"]:has(> nav) [class*="_options"] [class$="_tab"] {
    border-radius: 6px !important;
    font-size: 12.5px !important;
  }

  /* 卡外分组小标题：16/400 → 13/600 */
  div[role="dialog"]:has(> nav) [class*="_options"] [class*="_groupTitle"],
  div[role="dialog"]:has(> nav) [class*="_options"] [class*="_groupHead"],
  div[role="dialog"]:has(> nav) [class*="_options"] [class*="_cardTitle"] {
    font-size: 13px !important;
    font-weight: 600 !important;
    line-height: 16px !important;
  }

  div[role="dialog"]:has(> nav) textarea[class*="dsh-pet-cfg__area"] {
    height: 96px !important;
    min-height: 96px !important;
    padding: 8px 10px !important;
    line-height: 18px !important;
    overflow-y: auto !important;
  }

  /* ---------- 桌宠配置：勾选框重绘 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(6)[aria-current="true"]) [class*="_options"] input[type="checkbox"] {
    appearance: none !important;
    -webkit-appearance: none !important;
    width: 15px !important;
    height: 15px !important;
    margin: 0 !important;
    border: 1px solid rgba(255, 255, 255, 0.22) !important;
    border-radius: 4px !important;
    background: rgba(255, 255, 255, 0.04) !important;
    position: relative !important;
    cursor: pointer !important;
    flex: none !important;
    transition: background-color 120ms ease, border-color 120ms ease !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(6)[aria-current="true"]) [class*="_options"] input[type="checkbox"]:hover {
    border-color: rgba(255, 255, 255, 0.35) !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(6)[aria-current="true"]) [class*="_options"] input[type="checkbox"]:checked {
    background: var(--dsw-alias-state-business-primary, #3b82f6) !important;
    border-color: transparent !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(6)[aria-current="true"]) [class*="_options"] input[type="checkbox"]:checked::after {
    content: "";
    position: absolute;
    inset: 0;
    background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M3.6 8.4l2.9 2.9 5.9-6.4' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>") center / 11px 11px no-repeat;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(6)[aria-current="true"]) [class*="_options"] label {
    gap: 7px !important;
    min-height: 24px !important;
    align-items: center !important;
    cursor: pointer !important;
    font-size: 12.5px !important;
  }

  /* 桌宠表单控件 */
  div[role="dialog"]:has(> nav) [class*="dsh-pet-cfg__inp"]:not(textarea) {
    height: 24px !important;
    min-height: 24px !important;
    padding: 0 8px !important;
    border-radius: 6px !important;
    font-size: 12px !important;
  }

  /* 插件卡片名 / 页面标题行 */
  div[role="dialog"]:has(> nav) [class*="_options"] [class*="_recentName"],
  div[role="dialog"]:has(> nav) [class*="_options"] [class*="_cardName"],
  div[role="dialog"]:has(> nav) [class*="_options"] [class*="_titleRow"] {
    font-size: 13px !important;
    font-weight: 600 !important;
    line-height: 16px !important;
  }

  div[role="dialog"]:has(> nav) [class*="dsh-pet-mp__trigger"] {
    height: 24px !important;
    min-height: 24px !important;
    padding: 0 8px !important;
    font-size: 12px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(3)[aria-current="true"]) [class*="_addBlock"],
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(3)[aria-current="true"]) [class*="_addButton"] {
    min-height: 36px !important;
    border-radius: 10px !important;
  }

  /* ---------- 内置插件：搜索框与市场保持一致 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(4)[aria-current="true"]) [class*="_search"],
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(4)[aria-current="true"]) [class*="_search"] [class*="_wrap"] {
    display: flex !important;
    align-items: center !important;
    height: 30px !important;
    background: rgba(255, 255, 255, 0.04) !important;
    border: 1px solid rgba(255, 255, 255, 0.10) !important;
    border-radius: 8px !important;
    box-sizing: border-box !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(4)[aria-current="true"]) [class*="_search"] input {
    height: 100% !important;
    font-size: 12.5px !important;
    line-height: normal !important;
    background: transparent !important;
  }

  /* ---------- 插件市场：卡片内部节奏（标题→元信息→描述→标签→操作） ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_cardContent"] {
    display: flex !important;
    flex-direction: column !important;
    gap: 6px !important;
    height: 100% !important;
    min-height: 0 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_cardDescription"] {
    display: -webkit-box !important;
    -webkit-line-clamp: 2 !important;
    -webkit-box-orient: vertical !important;
    overflow: hidden !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_cardMainRow"],
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_cardMeta"] {
    flex: none !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_tag_"] {
    height: 20px !important;
    padding: 0 6px !important;
    border-radius: 4px !important;
    font-size: 11px !important;
    line-height: 20px !important;
  }

  /* ---------- 插件市场：卡片等高，行列对齐 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_masonryCol"] > * {
    min-height: 132px !important;
    min-width: 0 !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    overflow: hidden !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_cardDescription"] {
    overflow-wrap: anywhere !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_cardDesc"] {
    display: -webkit-box !important;
    -webkit-line-clamp: 2 !important;
    -webkit-box-orient: vertical !important;
    overflow: hidden !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_cardTitle"] {
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }

  /* ---------- 插件市场：顶部工具区贴合面板，不做深色条 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_stickyHead"] {
    position: static !important;
    top: auto !important;
    background: transparent !important;
    border-bottom: 0 !important;
    box-shadow: none !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_searchInput"] input {
    height: 100% !important;
    background: transparent !important;
    font-size: 12.5px !important;
    line-height: normal !important;
    padding: 0 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_tabs"] {
    font-size: 13px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_tabSearchRow"] {
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 0 0 10px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_tabSearchRow"] button {
    height: 30px !important;
    min-height: 30px !important;
    border-radius: 8px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_searchInput"] {
    display: flex !important;
    align-items: center !important;
    height: 30px !important;
    border: 1px solid rgba(255, 255, 255, 0.10) !important;
    border-radius: 8px !important;
    background: rgba(255, 255, 255, 0.04) !important;
    overflow: hidden !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_catsWrap"] > * {
    border-radius: 6px !important;
    background: rgba(255, 255, 255, 0.05) !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_hostFilterNote"] {
    margin-top: 4px !important;
    font-size: 11px !important;
    line-height: 14px !important;
    color: var(--dsw-alias-label-tertiary, #8a8a90) !important;
  }

  /* ---------- 插件市场：三列瀑布流 → 两列 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_masonry"] {
    display: flex !important;
    flex-wrap: wrap !important;
    align-items: flex-start !important;
    gap: 10px !important;
    width: 100% !important;
    max-width: 100% !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_masonryCol"] {
    flex: 1 1 calc(50% - 5px) !important;
    max-width: calc(50% - 5px) !important;
    min-width: 0 !important;
    gap: 10px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_recentRow"] {
    flex-wrap: wrap !important;
    gap: 10px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_recentTile"] {
    flex: 1 1 calc(50% - 5px) !important;
    max-width: calc(50% - 5px) !important;
    min-width: 0 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_card"],
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_recentTile"] {
    padding: 12px 14px !important;
    gap: 8px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(7)[aria-current="true"]) [class*="_recentTile"] {
    height: auto !important;
    min-height: 68px !important;
  }

  /* ---------- 计费：hero 数字收小、指标层级理清 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(9)[aria-current="true"]) [class*="_herocardValue"] {
    font-size: 24px !important;
    line-height: 30px !important;
    font-weight: 600 !important;
    letter-spacing: -0.02em !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(9)[aria-current="true"]) [class*="_herocardCellValue"] {
    font-size: 15px !important;
    line-height: 20px !important;
    font-weight: 500 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(9)[aria-current="true"]) [class*="_herocardCellLabel"],
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(9)[aria-current="true"]) [class*="_herocardSub"],
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(9)[aria-current="true"]) [class*="_herocardTitle"] {
    font-size: 11px !important;
    line-height: 14px !important;
    color: var(--dsw-alias-label-tertiary, #8a8a90) !important;
  }

  /* ---------- 远程访问（全内联样式，按 pane 覆盖） ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(8)[aria-current="true"]) [class*="_options"] div[style*="border: 1px solid"] {
    border-color: rgba(255, 255, 255, 0.07) !important;
    border-radius: 10px !important;
    background: var(--dsw-alias-bg-layer-1, #1c1c1f) !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(8)[aria-current="true"]) [class*="_options"] input:not([type="checkbox"]):not([type="radio"]) {
    height: 26px !important;
    padding: 0 8px !important;
    border-radius: 6px !important;
    font-size: 12px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(8)[aria-current="true"]) [class*="_options"] button {
    border-radius: 6px !important;
    font-size: 12px !important;
    padding: 3px 8px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(8)[aria-current="true"]) [class*="_options"] strong {
    font-size: 13px !important;
    font-weight: 600 !important;
  }

  /* ---------- 生图配置（全内联样式） ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(10)[aria-current="true"]) [class*="_options"] h2 {
    font-size: 15px !important;
    line-height: 20px !important;
    margin: 0 0 4px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(10)[aria-current="true"]) [class*="_options"] p {
    font-size: 12px !important;
    line-height: 18px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(10)[aria-current="true"]) [class*="_options"] div[style*="border: 1px solid"] {
    border-color: rgba(255, 255, 255, 0.07) !important;
    border-radius: 10px !important;
    background: var(--dsw-alias-bg-layer-1, #1c1c1f) !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(9)[aria-current="true"]) [class*="_options"] [class*="_themeSelect"] {
    height: 26px !important;
    border-radius: 6px !important;
    font-size: 12px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(10)[aria-current="true"]) [class*="_options"] button {
    height: 24px !important;
    border-radius: 6px !important;
    font-size: 12px !important;
    padding: 0 8px !important;
  }

  /* ---------- Agent 预设：只调标题与 footer，不碰布局 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(5)[aria-current="true"]) [class*="_cardName"] {
    font-size: 13px !important;
    font-weight: 600 !important;
    line-height: 16px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(5)[aria-current="true"]) [class*="_cardDesc"] {
    font-size: 12px !important;
    line-height: 18px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(5)[aria-current="true"]) [class*="_cardFoot"] {
    border-top: 1px solid rgba(255, 255, 255, 0.06) !important;
  }

  /* 细滚动条 */
  div[role="dialog"]:has(> nav) [class*="_options"]::-webkit-scrollbar { width: 8px; }
  div[role="dialog"]:has(> nav) [class*="_options"]::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background-clip: padding-box;
    background-color: rgba(255, 255, 255, 0.18);
  }

  /* 普通按钮：统一 24 高、6 圆角、12 号字（图标按钮不动） */
  div[role="dialog"]:has(> nav) [class*="_options"] button:not([aria-label]) {
    border-radius: 6px !important;
    font-size: 12px !important;
    line-height: 16px !important;
  }

  /* ---------- 通用设置：一行一张小卡 ---------- */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_section"] {
    background: none !important;
    border: 0 !important;
    padding: 0 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [data-dsh-card] {
    position: relative !important;
    background: var(--dsw-alias-bg-layer-1, #111113) !important;
    margin: 0 !important;
    padding: 10px 14px !important;
    border: 0 !important;
    min-height: 44px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [data-dsh-first] {
    margin-top: 10px !important;
    border-radius: 10px 10px 0 0 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [data-dsh-last] {
    border-radius: 0 0 10px 10px !important;
    margin-bottom: 10px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [data-dsh-first][data-dsh-last] {
    border-radius: 10px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [data-dsh-card]:not([data-dsh-last])::after {
    content: "";
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 0;
    height: 1px;
    background: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class$="_rowText"] {
    padding: 0 !important;
    border: 0 !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_title"] {
    font-size: 13px !important;
    font-weight: 400 !important;
    line-height: 16px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_desc"] {
    margin-top: 2px !important;
    color: var(--dsw-alias-label-tertiary, #8a8a90) !important;
    font-size: 11px !important;
    line-height: 14px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_selector"] {
    height: 24px !important;
    padding: 0 8px !important;
    border-radius: 6px !important;
    border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.14)) !important;
    background: transparent !important;
    font-size: 12px !important;
  }

  /* 外观三选一：等宽小磁贴 */
  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_cubeRow"] {
    gap: 8px !important;
    margin-top: 8px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_themeCube"] {
    flex: 1 1 0 !important;
    min-height: 64px !important;
    padding: 10px 8px !important;
    border-radius: 8px !important;
    border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08)) !important;
    background: transparent !important;
    font-size: 12px !important;
  }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_themeCube"] svg { flex: none !important; }

  div[role="dialog"]:has([class*="_navList"] > button:nth-child(2)[aria-current="true"]) [class*="_themeCube"][aria-pressed="true"] {
    border: 1.5px solid var(--dsw-alias-label-primary, #ececf1) !important;
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.05)) !important;
  }
}
`;

		const install = () => {
			try {
				if (typeof document === 'undefined' || !document.head) return;
				if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-shell-ui';
				tag.dataset.pluginCss = STYLE_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			} catch {}
		};

		const remove = () => {
			try {
				const tag = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
				if (tag && typeof tag.remove === 'function') tag.remove();
			} catch {}
		};

		/** Group rows of 通用设置 by their label so CSS can draw one card per group. */
		const GROUPS = [
			['basic', ['权限', '语言']],
			['look', ['外观', '字号大小']],
			['behave', ['工作步骤展示', '工作步骤收起时机', '显示代码工作视图', '网页链接默认打开方式', '繁忙时的发送行为', '性能与用量', '在使用官方模型']],
			['about', ['当前版本']],
		];

		const groupOf = (label) => {
			for (const [key, titles] of GROUPS) {
				if (titles.some((t) => label.startsWith(t))) return key;
			}
			return undefined;
		};

		const tagGroups = () => {
			try {
				const dialog = document.querySelector('div[role="dialog"]');
				if (!dialog) return;
				const options = dialog.querySelector('[class*="_options"]');
				if (!options) return;
				const rows = [...options.querySelectorAll('[class$="_row"], [class$="_group"]')]
					.filter((el) => !(el.className || '').includes('Text'));
				let lastGroup;
				let lastEl;
				for (const el of rows) {
					const title = el.querySelector('[class$="_title"]');
					const label = (title ? title.textContent : el.textContent || '').trim();
					const key = groupOf(label);
					if (!key) { el.removeAttribute('data-dsh-card'); continue; }
					el.dataset.dshCard = key;
					if (key !== lastGroup) {
						el.dataset.dshFirst = '1';
						if (lastEl) lastEl.dataset.dshLast = '1';
						lastGroup = key;
					}
					lastEl = el;
				}
				if (lastEl) lastEl.dataset.dshLast = '1';
			} catch {}
		};

		let observer;
		let frame;
		const schedule = () => {
			if (frame !== undefined) return;
			frame = requestAnimationFrame(() => {
				frame = undefined;
				tagGroups();
			});
		};

		function apply(ctx) {
			try {
				install();
				tagGroups();
				if (typeof MutationObserver === 'function' && document.body) {
					observer = new MutationObserver(schedule);
					observer.observe(document.body, { childList: true, subtree: true });
				}
				if (ctx && typeof ctx.effect === 'function') {
					ctx.effect(() => () => {
						if (observer) observer.disconnect();
						if (frame !== undefined) cancelAnimationFrame(frame);
						remove();
					}, 'settings-apple: styles');
				}
			} catch {}
		}
			return { apply };
		})();

		/* ========= 左栏折叠（原 dsh-sidebar-fold） ========= */
		const sidebarFold = (() => {
		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		const h = React.createElement
		const { MenuItemButton, IconCheckOutlineRegular } = primitives

		/** Panels that stay inline in the rail; everything else folds into 更多. */
		const KEEP = ['plugins', 'schedules']
		const STYLE_ID = 'dsh-shell-ui/sidebar-fold.css'
		const MENU_ROW_ORDER = -100
		const ACTIVE_ATTR = 'data-dsh-fold-active'

		/** Escape a value for a double-quoted CSS attribute selector. */
		const escapeAttribute = (value) =>
			String(value)
				.replace(/\\/g, '\\\\')
				.replace(/"/g, '\\"')
				.replace(/\n/g, '\\a ')

		/** Resolve a slot entry's label exactly the way the sidebar does. */
		const labelOf = (entry) => {
			const raw = entry && entry.options ? entry.options.label : undefined
			try {
				return typeof raw === 'function' ? raw() : raw
			} catch {
				return undefined
			}
		}

		/** Folded panels, in rail order: id + current localized label. */
		const foldedPanels = (slots) => {
			const out = []
			let entries = []
			try {
				entries = slots.entriesOfSlot('sidebar.panellist') || []
			} catch {
				return out
			}
			for (const entry of entries) {
				const id = entry && entry.options ? entry.options.id : undefined
				if (typeof id !== 'string' || KEEP.indexOf(id) !== -1) continue
				const label = labelOf(entry)
				if (typeof label === 'string' && label.length > 0) out.push({ id, label })
			}
			return out
		}

		/** The one stylesheet this plugin owns. */
		const stylesheet = () => {
			let tag = document.getElementById(STYLE_ID)
			if (tag === null) {
				tag = document.createElement('style')
				tag.id = STYLE_ID
				tag.dataset.plugin = 'dsh-shell-ui'
				document.head.appendChild(tag)
			}
			return tag
		}

		/** Hide folded rows; draw the "a folded panel is open" dot on 更多. */
		const rulesFor = (folded) => {
			const rules = folded.map(
				({ label }) =>
					`nav > button[aria-label="${escapeAttribute(label)}"]{display:none !important}`
			)
			rules.push(
				`nav > span > button[aria-haspopup="menu"][${ACTIVE_ATTR}="true"]::after{` +
					'content:"";width:4px;height:4px;border-radius:999px;' +
					'background:currentColor;opacity:.55;margin-left:auto;flex:none}'
			)
			return rules.join('\n')
		}

		/** Mirror "the active panel is folded" onto the 更多 row. */
		const syncActiveDot = (folded) => {
			const foldedLabels = new Set(folded.map((panel) => panel.label))
			for (const nav of document.querySelectorAll('nav')) {
				const more = nav.querySelector('button[aria-haspopup="menu"]')
				if (more === null) continue
				const active = Array.from(
					nav.querySelectorAll('button[aria-label][aria-current="page"]')
				).find((row) => !row.hasAttribute('aria-haspopup'))
				const activeLabel =
					active === undefined ? undefined : active.getAttribute('aria-label')
				// The collapsed rail draws icons only; a dot there would collide with
				// the glyph, so the indicator is wide-sidebar only.
				const wide = more.textContent.trim().length > 0
				if (
					wide &&
					activeLabel !== undefined &&
					activeLabel !== null &&
					foldedLabels.has(activeLabel)
				)
					more.setAttribute(ACTIVE_ATTR, 'true')
				else more.removeAttribute(ACTIVE_ATTR)
			}
		}

		/**
		 * Reuse the glyph the rail already draws for this panel, so the menu row
		 * looks like the row it replaced (the panel's own icon component stays
		 * private to the sidebar; its rendered SVG does not).
		 */
		const glyphIcon = (label) => {
			const row = Array.from(document.querySelectorAll('nav > button[aria-label]')).find(
				(candidate) => candidate.getAttribute('aria-label') === label
			)
			const svg = row === undefined ? null : row.querySelector('svg')
			if (svg === null) return undefined
			return h('span', {
				style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
				dangerouslySetInnerHTML: { __html: svg.outerHTML }
			})
		}

		/** One row per folded panel inside the 更多 menu. */
		function FoldedPanelsMenu({ entries, onOpen, onDismiss }) {
			const rows = (Array.isArray(entries) ? entries : []).filter(
				(entry) => KEEP.indexOf(entry.id) === -1
			)
			if (rows.length === 0) return null
			return h(
				React.Fragment,
				null,
				rows.map((entry) =>
					h(
						MenuItemButton,
						{
							key: entry.id,
							icon: glyphIcon(entry.label),
							current: entry.active === true,
							onSelect: () => {
								if (typeof onDismiss === 'function') onDismiss()
								if (typeof onOpen === 'function') onOpen(entry.id)
							}
						},
						h(
							'span',
							{
								style: {
									display: 'flex',
									alignItems: 'center',
									gap: '8px',
									width: '100%',
									minWidth: 0
								}
							},
							h(
								'span',
								{
									style: {
										minWidth: 0,
										overflow: 'hidden',
										textOverflow: 'ellipsis',
										whiteSpace: 'nowrap'
									}
								},
								entry.label
							),
							entry.active === true
								? h(
										'span',
										{
											style: {
												marginLeft: 'auto',
												flex: 'none',
												display: 'inline-flex'
											}
										},
										h(IconCheckOutlineRegular, { size: 16 })
									)
								: null
						)
					)
				)
			)
		}

		/** Services this browser half needs. */
		const inject = ['slots', 'locale']

		/**
		 * @param ctx - Client context with the slot registry and locale service.
		 */
		function apply(ctx) {
			if (typeof window !== 'undefined' && window.__DSH_SHELL_UI_FOLD_APPLIED__ === true) return
			if (typeof window !== 'undefined') window.__DSH_SHELL_UI_FOLD_APPLIED__ = true

			let frame
			const refresh = () => {
				const folded = foldedPanels(ctx.slots)
				stylesheet().textContent = rulesFor(folded)
				syncActiveDot(folded)
			}
			const schedule = () => {
				if (frame !== undefined) return
				frame = window.requestAnimationFrame(() => {
					frame = undefined
					refresh()
				})
			}

			ctx.effect(() => {
				const unsubscribeSlots = ctx.slots.subscribe('sidebar.panellist', schedule)
				const locale = ctx.get('locale')
				const unsubscribeLocale =
					locale && typeof locale.subscribe === 'function' ? locale.subscribe(schedule) : () => {}

				let observer
				if (typeof MutationObserver === 'function' && document.body !== null) {
					observer = new MutationObserver(schedule)
					observer.observe(document.body, {
						childList: true,
						subtree: true,
						attributes: true,
						attributeFilter: ['aria-label', 'aria-current']
					})
				}
				refresh()

				return () => {
					if (typeof unsubscribeSlots === 'function') unsubscribeSlots()
					if (typeof unsubscribeLocale === 'function') unsubscribeLocale()
					if (observer !== undefined) observer.disconnect()
					if (frame !== undefined) window.cancelAnimationFrame(frame)
					window.__DSH_SHELL_UI_FOLD_APPLIED__ = false
					const tag = document.getElementById(STYLE_ID)
					if (tag !== null) tag.remove()
				}
			}, 'sidebar-fold: folded panel rows')

			ctx.slots.inject('sidebar.panellist.actions', () =>
				ctx.slots.register(
					{
						name: 'sidebar.panellist.actions',
						id: 'shell-ui-fold',
						order: MENU_ROW_ORDER
					},
					FoldedPanelsMenu
				)
			)
		}
			return { apply };
		})();

		/** 折叠半边需要槽位注册表与本地化服务；设置半边不需要服务。 */
		const inject = ['slots', 'locale'];

		function apply(ctx) {
			settingsSurface.apply(ctx);
			sidebarFold.apply(ctx);
		}

		return { inject, apply };
	},
});
