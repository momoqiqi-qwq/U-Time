/**
 * 空状态线稿插画（v0.249.0）
 *
 * 用户选定的风格：手绘细线 + 一处实心强调色 + 几颗小星星（参考稿 ui-concepts/empty-quadrant.png）。
 *
 * 为什么是内联 SVG，不用 PNG：
 *  - 线条走 `currentColor`，强调色走 CSS 变量 `--ea-accent`，浅色 / 深色 / 各套主题色
 *    自动跟随，不用每套主题出一份图。
 *  - 体积小（单张 < 1.5KB），没有额外请求，也不用进 gen-plugin-icons 的生成链。
 *
 * 强调色只能写在 `style="fill:var(...)"` 里：SVG 的展示属性（fill="var(--x)"）不认 CSS 变量。
 *
 * 插件（周报 / RSS / 学校通知）**各自内联自己的一份 SVG**，不引用这个模块：插件是独立加载的
 * 脚本，不能 import 宿主源码，也不能指望宿主里有这个类。
 */
import { el } from "./ui.js";

const LINE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ACCENT = 'style="fill:var(--ea-accent,#E8705F)"';
const ON_ACCENT = 'fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ea-on-accent,#fff)"';

/** 四角星（手绘感的小闪光），中心 (x,y)，半径 r。 */
function spark(x, y, r = 4.5) {
  const k = r * 0.18;
  return `<path d="M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z"/>`;
}
const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="1.1" fill="currentColor" stroke="none"/>`;

/* 线条全部故意带一点歪斜 / 不等长，避免「矢量图标库」的机械感。viewBox 统一 160×100。 */
const ART = {
  // 象限 I · 别再犹豫：清单划完，纸飞机起飞
  q1: `<g transform="translate(-3 5)"><g ${LINE}>
    <path d="M60 30Q80 28.6 98 29Q97.4 52 91 69Q86.4 79.6 76 80.6Q62 81.4 50.5 80Q57.6 70 60 30Z"/>
    <path d="M76 80.6Q77.4 74 80.4 73Q86.6 72.4 91 69"/>
    <circle cx="65.4" cy="39" r="3.3"/><path d="M63.8 39l1.2 1.2 2.4-2.6"/><path d="M72 39.2H91"/>
    <circle cx="63.6" cy="50.6" r="3.3"/><path d="M62 50.6l1.2 1.2 2.4-2.6"/><path d="M70.2 50.8H88"/>
    <circle cx="61.4" cy="62.2" r="3.3"/><path d="M59.8 62.2l1.2 1.2 2.4-2.6"/><path d="M68 62.4H82"/>
    <path d="M80 24Q85 18.6 92 17.4Q98 16.6 101 19Q103.4 21.8 100.4 22.6Q97.6 22.8 99 18.6Q103 13 115 11.4" stroke-dasharray="3 4"/>
    ${spark(44, 40)}${spark(110, 46, 3.6)}${spark(52, 20, 3.4)}${dot(40, 54)}${dot(116, 30)}
  </g>
  <path d="M117 9.6L137 4L125.4 18.4Z" ${ACCENT}/>
  <path ${LINE} d="M117 9.6L137 4L125.4 18.4ZM137 4L122.6 13.4L122 18.6L125.4 16"/></g>`,

  // 象限 II · 复利：一摞硬币 → 盆里的芽越长越高
  q2: `<g ${LINE}>
    <ellipse cx="48" cy="77" rx="10.5" ry="3.2"/><path d="M37.5 77v-5M58.5 77v-5"/>
    <ellipse cx="48" cy="72" rx="10.5" ry="3.2"/><path d="M37.5 72v-5M58.5 72v-5"/>
    <ellipse cx="48.6" cy="67" rx="10.5" ry="3.2"/>
    <path d="M46 58Q52 46 66 40" stroke-dasharray="3 4"/><path d="M61 38.6L66.4 39.8L63.6 44.4"/>
    <path d="M76.4 58.6H104.2V63H76Z"/><path d="M78.6 63L82 81.4H98.8L102.2 63"/>
    <path d="M90.4 58.6Q89.2 47 91.2 33"/>
    ${spark(112, 30)}${spark(70, 24, 3.4)}${dot(116, 52)}${dot(36, 52)}
  </g>
  <path d="M90 48Q78.6 46.6 76 35.6Q87.4 35.4 90 48Z" ${ACCENT}/>
  <path d="M91 39Q92.4 26.4 105.6 24Q105.4 36.6 91 39Z" ${ACCENT}/>
  <path ${LINE} d="M90 48Q78.6 46.6 76 35.6Q87.4 35.4 90 48ZM91 39Q92.4 26.4 105.6 24Q105.4 36.6 91 39Z"/>`,

  // 象限 III · 批量：零碎的事捆成一摞一起办
  q3: `<g ${LINE}>
    <path d="M58 27.4H98.6"/><path d="M53.6 33.2H103"/>
    <path d="M51 39H105.6Q109.6 39 109.6 43V74.4Q109.6 78.4 105.6 78.4H51Q47 78.4 47 74.4V43Q47 39 51 39Z"/>
    <path d="M47.6 41.6L76.6 60.4Q78.4 61.6 80.2 60.4L109 41.6"/>
    ${spark(40, 30)}${spark(120, 62, 3.6)}${dot(118, 34)}${dot(38, 70)}
  </g>
  <path d="M86 39H93.4V78.4H86Z" ${ACCENT}/>
  <path ${LINE} d="M86 39H93.4V78.4H86Z"/>
  <path ${ON_ACCENT} d="M86.6 55.6H92.8"/>`,

  // 象限 IV · 休息：一杯热茶，一弯月亮
  q4: `<g ${LINE}>
    <path d="M58.6 51.6H97V60Q97 78.6 77.8 78.6Q58.6 78.6 58.6 60Z"/>
    <path d="M97 55.4Q107 55 107 62.4Q107 70 95.4 69.4"/>
    <path d="M50 82.6Q78 88.6 106 82.4"/>
    <path d="M69 45Q65 39.6 69 34Q73 28.4 69 22.6"/><path d="M79 44Q75 38.6 79 33Q83 27.4 79 21.6"/><path d="M89 45Q85.4 40.4 89 35.6"/>
    ${spark(44, 36)}${spark(108, 44, 3.4)}${dot(40, 60)}${dot(128, 44)}
  </g>
  <path d="M122.6 11A11.6 11.6 0 1 0 133.4 28.6A9 9 0 1 1 122.6 11Z" ${ACCENT}/>
  <path ${LINE} d="M122.6 11A11.6 11.6 0 1 0 133.4 28.6A9 9 0 1 1 122.6 11Z"/>`,

  // 收件箱清空：空托盘 + 一枚勾
  inbox: `<g ${LINE}>
    <path d="M43.6 57L54.4 35.6H105.8L116.6 57V76.6Q116.6 80.6 112.6 80.6H47.6Q43.6 80.6 43.6 76.6Z"/>
    <path d="M44 57H63.6Q65.6 64.6 71.6 64.6H88.6Q94.6 64.6 96.6 57H116.2"/>
    ${spark(40, 30)}${spark(122, 40, 3.6)}${dot(126, 24)}${dot(36, 46)}
  </g>
  <circle cx="80" cy="23" r="9.4" ${ACCENT}/>
  <path ${ON_ACCENT} d="M75.6 23.2L78.8 26.4L84.6 19.8"/>`,
};

/**
 * 空状态节点：插画 + 一句说明。
 * @param {"q1"|"q2"|"q3"|"q4"|"inbox"} kind
 * @param {string} [caption]
 */
export function emptyArt(kind, caption) {
  const box = el("div", { class: "empty-art", "data-art": kind });
  box.innerHTML = `<svg viewBox="0 0 160 100" aria-hidden="true" focusable="false">${ART[kind] || ""}</svg>`;
  if (caption) box.append(el("p", {}, caption));
  return box;
}

/** 测试与预览用：原始 SVG 片段。 */
export const EMPTY_ART_KINDS = Object.keys(ART);
export function emptyArtSvg(kind) { return ART[kind] || ""; }
