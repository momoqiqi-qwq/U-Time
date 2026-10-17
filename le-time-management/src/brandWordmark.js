// 品牌字标（左上角 `.brand`）与它下方那条哥特装饰线的**唯一创建口**。
//
// 为什么要独立成模块（v0.232.0）：刷新蒙版（loadingMask.js）要「文字形式参考左上角的标题」，
// 也就是同一句 `U Time WorkSpace` + 同一套哥特黑体渐变 + 同一条装饰线。
// 复制一份到蒙版里必然走形（改一处漏一处），所以把 DOM 构造抽到这里，两处共用。
// 视觉的**唯一事实源仍然是 styles.css 的 `.brand b` / `.brand-rule` 那两组规则** ——
// 蒙版只是把 `.brand` 放进自己的容器里，不改字形、不改渐变、不写死任何十六进制色。
//
// 注意：scripts/test-brand-wordmark.mjs 的静态断言现在分两处读 —— 「文案 / 调用」看 shell.js 的
// rail 里那一段，「装饰线形状（viewBox / preserveAspectRatio / 四档渐变）」看本文件。
// 所以 shell.js 里那句调用与 `brandRule()` 这个名字都**不能改名**，本文件也别再长出第二份
// 装饰线实现（测试会直接拦下来）。

/** 字标文案。改名要连带动字号：见 styles.css `.brand b` 那条「20px 是量出来的」注释。 */
export const BRAND_NAME = "U Time WorkSpace";

/**
 * 字标下方那条哥特装饰线（v0.183.0 用户需求「在下面添加一根像上面代码那样画出来的线」）。
 * 形状：左右两条带波纹节点的细主线 + 两端尖饰 + 中间上下对称的菱形与四片卷草花饰，
 * 末端再挂一对横向小枝；最上面那层极淡的同色柔光只在深色模式开（浅色下压白底会发灰）。
 *
 * viewBox 是 160×14 —— 与桌面侧栏里字标的实际宽度（≈159px @ 20px 字号，实测）几乎 1:1，
 * 所以默认 preserveAspectRatio（xMidYMid meet）下既不会被横拉变形，也不会被裁。
 *
 * **颜色一律由 styles.css 的 CSS 变量给**（`--brand-rule-*`）：浅色/深色两套四档跟字标同一
 * 色相，对比度由 scripts/test-brand-wordmark.mjs 一起实算，别在这里写死十六进制色。
 *
 * @param {string} [gradientId] 渐变 `<linearGradient>` 的 id。同一份文档里可能同时存在两条
 *   装饰线（侧栏 + 刷新蒙版），id 撞车时先出现的那个定义会赢 —— 蒙版那条就会借错色标。
 *   所以调用方各给一个 id。**签名必须保持零必填参数**：`scripts/test-brand-wordmark.mjs`
 *   按 `function brandRule()` 做静态断言。
 */
export function brandRule(gradientId) {
  const gid = gradientId || "brandRuleGrad";
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "brand-rule");
  svg.setAttribute("viewBox", "0 0 160 14");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
      <defs>
        <linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="160" y2="0">
          <stop class="bg-1" offset="0%"></stop>
          <stop class="bg-2" offset="34%"></stop>
          <stop class="bg-3" offset="67%"></stop>
          <stop class="bg-4" offset="100%"></stop>
        </linearGradient>
      </defs>
      <path class="br-line" d="M1 7 C3.6 6.2 6.4 5.7 9.4 6.1 L13 6.7 L15.6 5.9 L18.2 6.8 L21.5 6.15 L24 7 H72"></path>
      <path class="br-line" d="M88 7 H136 L138.5 6.15 L141.8 6.8 L144.4 5.9 L147 6.7 C150 5.7 153.4 6.2 159 7"></path>
      <path class="br-tip" d="M1 7 C4.5 5.5 8 5.2 12 7 C8 8.3 4.5 8.2 1 7 Z"></path>
      <path class="br-tip" d="M159 7 C155.5 5.5 152 5.2 148 7 C152 8.3 155.5 8.2 159 7 Z"></path>
      <g class="br-scroll">
        <path d="M80 1.2 C79.4 2.3 79.4 3.2 80 4.2"></path>
        <path d="M80 9.8 C79.4 10.8 79.4 11.8 80 12.8"></path>
        <path d="M80 4.1 L82.2 7 L80 9.9 L77.8 7 Z"></path>
        <path d="M77.7 6 C76.7 5.6 75.8 5 75.9 4 C76 3.2 76.8 2.7 77.5 3.1 C78.1 3.5 77.8 4.3 77.2 4.5"></path>
        <path d="M82.3 6 C83.3 5.6 84.2 5 84.1 4 C84 3.2 83.2 2.7 82.5 3.1 C81.9 3.5 82.2 4.3 82.8 4.5"></path>
        <path d="M77.7 8 C76.7 8.4 75.8 9 75.9 10 C76 10.8 76.8 11.3 77.5 10.9 C78.1 10.5 77.8 9.7 77.2 9.5"></path>
        <path d="M82.3 8 C83.3 8.4 84.2 9 84.1 10 C84 10.8 83.2 11.3 82.5 10.9 C81.9 10.5 82.2 9.7 82.8 9.5"></path>
        <path d="M75.8 7 H72.8 L74 5.8"></path>
        <path d="M84.2 7 H87.2 L86 5.8"></path>
      </g>
      <g class="br-glow">
        <path d="M1 7 H72 M88 7 H159"></path>
        <circle cx="80" cy="7" r="4"></circle>
      </g>`;
  return svg;
}

/**
 * 字标节点（`<b>文案</b>` + 下方装饰线），调用方自己套一层 `.brand` 容器。
 *
 * `text` 默认是品牌文案 `U Time WorkSpace`。**等待蒙版（v0.233.0）会传自定义文案**
 * （如「正在刷新课表…」）—— 那一档的字号由 `.wait-mask[data-size]` 给，别在这里写死字号。
 * @param {string} [gradientId] 见 brandRule()：同文档多条装饰线必须各给一个 id。
 * @param {string} [text] 字标文案，默认 BRAND_NAME。
 */
export function brandMark(gradientId, text) {
  const b = document.createElement("b");
  b.textContent = text || BRAND_NAME;
  return [b, brandRule(gradientId)];
}
