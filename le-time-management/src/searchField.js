// 搜索框统一装饰（需求（用户）：「删除所有搜索框内的中文，仅保留搜索图标。」）
// 框里只留一颗放大镜，不再写中文占位词；无障碍文案仍走 input 自己的 aria-label。
// 用法：withSearchGlyph(input) —— 输入框本体、类名与事件绑定都不变，只多一层定位容器。
import { el } from "./ui.js";

export const SEARCH_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>';

/** 放大镜图标节点（颜色跟随 currentColor，深浅主题同源）。 */
export function searchGlyph(cls = "search-ico") {
  const span = el("span", { class: cls, "aria-hidden": "true" });
  span.innerHTML = SEARCH_GLYPH;
  return span;
}

/** 把搜索输入框包进「图标钉在框内左端」的容器，返回容器。 */
export function withSearchGlyph(input, { cls = "" } = {}) {
  return el("div", { class: `search-field${cls ? ` ${cls}` : ""}` }, searchGlyph(), input);
}
