// 警大校历图标（v1.60.1）：纯线条图形 —— 只有线条本身着色，线外一律不铺底色。
//
// 为什么改：v1.60.0 是「六边形渐变底板 + 白色图形」，那块底板本质上就是一枚彩色填充块，
// 等于给图标又套了一层背景色。现在底板、rim 描边、高光、投影全部删掉，只留线条，
// 输出 SVG 除线条外全透明，落在任何卡片底色上都不带自己的色块。
//
// 颜色口径：六色都取「白卡与深紫卡上都能看」的中间调（对 #FFF ≥3:1、对 #232029 ≥4.6:1），
// 所以不需要按 data-theme-mode 出两套色板。线条用 currentColor，实心小块也是 currentColor，
// 保证「线内有颜色」这一条只有一种颜色来源。
//
// 线宽三档：96 网格的 5.4 缩到 28px 只剩 1.6px 会糊，小尺寸逐级加粗。

/** 六个语义位：线条色 + 图形。key 与 calendar.js 的落点一一对应。 */
const SET = {
  cal: { color: "#8B7BE8", scale: 1.3, glyph: `
    <rect x="28" y="29" width="40" height="40" rx="7.5"/>
    <path d="M28 42.5h40"/>
    <path d="M37.5 21.5v9M58.5 21.5v9"/>
    <rect x="36" y="50.5" width="9.5" height="5" rx="2.5" fill="currentColor" stroke="none"/>
    <rect x="50.5" y="50.5" width="9.5" height="5" rx="2.5" fill="currentColor" stroke="none"/>` },
  // 学期起止 = 双向箭头（起始 ⇄ 结束）。试过两版：实心圆 → 空心圆 + 短线被读成「钥匙 / 链接环」，
  // 沙漏（两横 + 交叉斜线）在 54px 下被读成 I 形光标 —— 都过不了肉眼第一眼。双向箭头笔画少、方向明确。
  term: { color: "#4C8DE8", scale: 1.55, glyph: `
    <path d="M31 48h34"/>
    <path d="M42 40.5 31.5 48l10.5 7.5"/>
    <path d="M54 40.5 64.5 48 54 55.5"/>` },
  week: { color: "#D98A0F", scale: 1.3, glyph: `
    <rect x="30" y="30" width="36" height="36" rx="7"/>
    <path d="M30 44h36"/>
    <circle cx="57" cy="55.5" r="6" fill="currentColor" stroke="none"/>` },
  course: { color: "#22A55E", scale: 1.3, glyph: `
    <circle cx="48" cy="50" r="18"/>
    <path d="M48 39.5V50l8 4.6"/>
    <path d="M40.5 26.5v5.5M55.5 26.5v5.5"/>
    <path d="M40.5 32h15"/>` },
  event: { color: "#17A79E", scale: 1.3, glyph: `
    <path d="M32.5 38l3.8 4 7.4-8.2"/>
    <path d="M51 38.5h15"/>
    <path d="M32.5 58l3.8 4 7.4-8.2"/>
    <path d="M51 58.5h15"/>` },
  sync: { color: "#D9453F", scale: 1.3, glyph: `
    <path d="M33 46.5a15.5 15.5 0 0 1 26.5-7.5"/>
    <path d="M61 30.5v9.5h-9.5"/>
    <path d="M63 49.5a15.5 15.5 0 0 1-26.5 7.5"/>
    <path d="M35 65.5V56h9.5"/>` },
};

export const CAL_ICON_KEYS = Object.keys(SET);

const strokeWidth = (size) => (size <= 30 ? 8.4 : size <= 44 ? 7 : 6);

/**
 * 生成一枚图标。
 * @param {"cal"|"term"|"week"|"course"|"event"|"sync"} key 语义位
 * @param {number} size 输出像素（正方形）；未知 key 返回空串，调用方不必判空
 * @returns {string} 内联 SVG 字符串
 */
export function calIcon(key, size = 48) {
  const set = SET[key];
  if (!set) return "";
  const sw = strokeWidth(size);
  return `<svg class="cc-ico-svg" width="${size}" height="${size}" viewBox="0 0 96 96" fill="none"`
    + ` style="color:${set.color}" aria-hidden="true" focusable="false">`
    + `<g transform="translate(48 48) scale(${set.scale}) translate(-48 -48)"`
    + ` stroke="currentColor" stroke-width="${sw / set.scale}" stroke-linecap="round" stroke-linejoin="round">`
    + set.glyph
    + `</g></svg>`;
}
