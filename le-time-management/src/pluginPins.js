// 侧栏插件置顶：被置顶的插件从颜色分组里「提」出来，固定渲染在插件区最上方。
//
// 状态只有一处：`settings.pinnedPlugins`（插件 ID 数组，顺序即置顶区内的显示顺序）。
// 刻意**不改写** `settings.pluginOrder` —— 取消置顶时插件自然回到它在常规排列里的
// 原位置（用户拖过的顺序、颜色分组都还在）。这是「置顶是视图增强，不是排序改写」的
// 直接好处；否则取消置顶只能把它扔到列表末尾。
//
// 与 pluginGroups.js 同一条路子：只依赖 store，读写自愈，脏值一律当「没置顶」，
// 不抛错 —— settings 是自由对象，跨版本同步过来的数据里什么都可能有。
import * as S from "./store.js";

function pinList() {
  const settings = S.getState().settings;
  const raw = Array.isArray(settings.pinnedPlugins) ? settings.pinnedPlugins : [];
  const clean = [...new Set(raw.filter((id) => typeof id === "string" && id))];
  settings.pinnedPlugins = clean;
  return settings.pinnedPlugins;
}

/** 置顶表快照（顺序 = 置顶区显示顺序）。 */
export function pinnedPluginIds() {
  return [...pinList()];
}

export function isPluginPinned(pluginId) {
  return Boolean(pluginId) && pinList().includes(pluginId);
}

/** 置顶 / 取消置顶，返回「现在是否已置顶」（用来决定提示文案）。 */
export function togglePluginPin(pluginId) {
  if (!pluginId) return false;
  const list = pinList();
  const at = list.indexOf(pluginId);
  // 新置顶的追加到置顶区末尾，不抢已有置顶的位置。
  if (at >= 0) list.splice(at, 1);
  else list.push(pluginId);
  S.persistSoon();
  return at < 0;
}

/** 置顶区内拖拽排序落库（顺序即 pinnedPlugins）。返回顺序是否真的变了。 */
export function setPinnedPluginOrder(ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id))];
  const current = pinList();
  if (clean.length === current.length && clean.every((id, i) => id === current[i])) return false;
  S.getState().settings.pinnedPlugins = clean;
  S.persistSoon();
  return true;
}

/** 按「当前确实有视图」的插件 ID 过滤置顶表：停用 / 已删除的插件不该在侧栏留空槽。 */
export function pinnedOrderOf(availableIds) {
  const available = new Set(Array.isArray(availableIds) ? availableIds : []);
  return pinList().filter((id) => available.has(id));
}
