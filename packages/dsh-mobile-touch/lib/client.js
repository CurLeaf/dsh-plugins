/**
 * Browser half of `dsh-mobile-touch`.
 *
 * 手机上的 DSH 外壳有一批 16~28px 的可点控件（对话/轨迹、更多会话视图、
 * 输入区的 +、模型选择、发送…），远低于 44×44 的触控底线，点错率高。
 *
 * 这里**只注入一张样式表**：
 *   1. 用伪元素把命中区外扩到 ≥44px —— 视觉尺寸一点不变，所以不会错位
 *   2. 修输入框占位符对比度（实测 3.76:1，低于 4.5）
 *   3. 窄屏下让模型选择器可截断，避免把输入区那一行挤爆
 *
 * 选择器一律用 aria-label 语义定位，**不用哈希 class**：class 名随构建变化，
 * 用它们第二天就会失效。
 */

const STYLE_ID = 'dsh-mobile-touch/paper.css'
const ATTR = 'data-plugin-css'

/**
 * 命中区外扩**按组给不同参数**——一律 -12px 会出事：
 * 输入区三个图标彼此只隔 8px，各扩 12px 会互相重叠，点哪边都可能落到另一个按钮上，
 * 比原来更糟。所以这里按实测几何分组：
 *
 *   - 输入区图标行：行高 44、按钮高 28 → 上下各 8px 刚好补满整行；
 *     水平只扩 4px，正好吃掉 8px 的一半，与邻居相接但不重叠。
 *   - 顶部标签（对话/轨迹/…）：彼此间隔 20~32px，可以放心 -10px。
 *   - 独立图标（打开侧栏/复制）：四周 -8px，不挤到别人。
 */
const GROUPS = [
  {
    // 输入区：紧挨着，只能小步外扩
    inset: '-8px -4px',
    selectors: [
      'button[aria-label="添加文件或调用指令"]',
      'button[aria-label^="访问模式"]',
      'button[aria-label="GenUI prompt"]',
    ],
  },
  {
    // 会话视图的「对话 / 轨迹」：按钮盒实测 46×44（高度已达标），两个盒子之间
    // 只有 12px 空隙（32px 是**文字**之间的距离，别看错）。所以水平只能各让 5px：
    // 再多两边命中区就会重叠，点「对话」右边缘会落到「轨迹」上。
    //
    // 这里必须用 ::before：宿主的选中下划线**正是** .tabActive::after
    // （2px 高 + 品牌色背景）。我们的命中区也写 ::after 的话，
    // min-height:44px 会把那条 2px 下划线撑成 44×44 的蓝色色块，
    // 只有选中项可见（未选中项背景是透明），看着就像「选中态多了个色块」。
    // 宿主只占了 ::after，换到 ::before 互不影响。
    inset: '-4px -5px',
    pseudo: 'before',
    selectors: ['[role="tab"]'],
  },
  {
    // 顶部标签与相邻入口：间隔足够
    inset: '-11px',
    selectors: [
      'button[aria-label="对话"]',
      'button[aria-label="轨迹"]',
      'button[aria-label="更多会话视图"]',
    ],
  },
  {
    // 工作区选择器：父行高 40、自身 30 → 上下各 5 正好铺满；左右有邻按钮，只给 2
    inset: '-5px -2px',
    selectors: ['button[aria-label="选择工作区"]'],
  },
  {
    // 独立按钮：四周外扩。用 9 而不是 8 —— 实测 -8 时边界落在亚像素上，
    // 有效尺寸只有 43（上下 8/7），差 1px 就到不了 44 的底线。
    inset: '-9px',
    selectors: [
      'button[aria-label="打开侧栏"]',
      'button[aria-label="复制"]',
      // 标签实测是「发送消息」/「停止生成」，用前缀匹配兼容两种状态
      'button[aria-label^="发送"]',
      'button[aria-label^="停止"]',
      'button[aria-label="新建对话"]',
      // 侧栏顶部三图标：实测间距 40px，-8 不会互相抢
      'button[aria-label="搜索会话"]',
      'button[aria-label="视图选项"]',
      'button[aria-label="添加工作区"]',
      'button[aria-label="重启 DSH"]',
      'button[aria-label^="会话“"]',
    ],
  },
]

const touchCss = () =>
  GROUPS.map((g) => {
    const pos = g.selectors.join(',\n  ')
    const pseudo = g.pseudo ?? 'after'
    const hit = g.selectors.map((s) => `${s}::${pseudo}`).join(',\n  ')
    return `
  ${pos} { position: relative; }
  ${hit} {
    content: "";
    position: absolute;
    inset: ${g.inset};
    min-width: 44px;
    min-height: 44px;
    margin: auto;
  }`
  }).join('\n')

const CSS = `
@media (max-width: 640px) {
${touchCss()}

  /**
   * 文案型按钮（审批：继续/先停下/只看不改/换个方案，通知：标记待处理/开启通知，动作：打开）
   * 都没有 aria-label，实测高 28~32。这类不能用伪元素外扩——会盖住卡片正文，
   * 直接抬 min-height 更安全。实测只影响这 7 个，其它按钮高度零变化。
   */
  button:not([aria-label]) {
    min-height: 44px;
  }

  /** 「监看」是整行按钮，实测 456×36，同样抬高度 */
  button[aria-label="监看"] {
    min-height: 44px;
  }

  /**
   * 菜单项：实测 34px（模型菜单）与 28px（+ 菜单）都有，
   * 手指在列表里划过很容易点到相邻项。统一抬到 44。
   * 只影响列表项自身高度，不碰容器的 padding/gap。
   */
  [role="menuitem"],
  [role="option"] {
    min-height: 44px !important;
  }

  /**
   * 输入框的「占位文字」不是原生 placeholder，而是一个 div
   * （实测 class 形如 uV2eYG_placeholder，走的是自绘）。所以 ::placeholder 规则
   * 对它完全无效——原先那条等于没写。这里按类名后缀匹配，跨构建更稳。
   * 原色 rgb(129,133,140) 对 #2c2c2e 只有 3.7:1；换成 #9a9aa2 后约 5.0:1。
   */
  textarea::placeholder,
  input::placeholder,
  [class$="_placeholder"],
  [class*="_placeholder_"] {
    color: #9a9aa2 !important;
    opacity: 1 !important;
  }

  /**
   * 模型选择器是唯一带 overflow:hidden 的按钮 —— 那会把 ::after 整个裁掉，
   * 伪元素外扩对它完全无效（实测点左侧 1px 就已经落到父容器上）。
   * 这类只能直接加高盒子，并用负 margin 抵消，视觉位置不变。
   */
  button[aria-label^="选择模型"] {
    height: 44px !important;
    margin-block: -8px !important;
    align-self: center;
  }

}
`

window.__ModuleLoader__.load({
  id: 'dsh-mobile-touch',
  factory(require) {
    const mount = () => {
      if (document.querySelector(`style[${ATTR}="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.setAttribute(ATTR, STYLE_ID)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    /**
     * 客户端插件的契约：工厂**必须返回 `{ apply }`**。
     * 早先返回 undefined，宿主直接抛出
     * 「invalid plugin, expect function or object with an "apply" method」并白屏 —— 已修正。
     */
    function apply() {
      try {
        if (document.head) mount()
        else document.addEventListener('DOMContentLoaded', mount, { once: true })
      } catch (e) {
        // 外观补丁失败不该连累其它插件
      }
    }

    return { apply };
  },
})
