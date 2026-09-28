import * as S from "./store.js";
import { appIcon, outlineAppIcon } from "./icons.js";

/* ── 核心导航项（任务表 / 时间块 / 收件箱 / 插件 / 时间线）的用户自定义外观 ──
   与 pluginAppearance.js 是同一套思路：只存「用户改过的字段」，缺省回落默认值。
   两边的键空间刻意分开（settings.pluginOverrides 存插件 ID，settings.navOverrides 存视图 ID），
   因为默认名称的事实源不同 —— 插件名来自 manifest，核心页名来自 shell.js 的 VIEWS。
   合并成一张表看着省代码，实际会让「视图 id 与插件 id 撞名」从不可能变成可能。 */

function overridesState() {
  const settings = S.getState().settings;
  if (!settings.navOverrides || typeof settings.navOverrides !== "object" || Array.isArray(settings.navOverrides)) {
    settings.navOverrides = {};
  }
  return settings.navOverrides;
}

export function getNavOverride(id) {
  const value = overridesState()[id];
  return value && typeof value === "object" ? value : {};
}

export function hasNavOverride(id) {
  return Object.keys(getNavOverride(id)).length > 0;
}

export function navDisplayName(id, fallback) {
  const name = String(getNavOverride(id).name || "").trim();
  return name || fallback || id;
}

/** 自定义图标直接换掉 <img> 的 src；随包 PNG 缺失时的 CDN 回落逻辑仍留在 icons.js 里 */
export function navDisplayIcon(id, title = "") {
  const icon = appIcon(id, title);
  const custom = getNavOverride(id).icon;
  if (typeof custom === "string" && custom.startsWith("data:image/")) {
    icon.src = custom;
    icon.dataset.iconSource = "user customization";
  }
  return icon;
}

export function navDisplayOutlineIcon(id, title = "") {
  return outlineAppIcon(id, title);
}

export function setNavOverride(id, patch) {
  const table = overridesState();
  const next = { ...(table[id] || {}), ...(patch || {}) };
  if (!String(next.name || "").trim()) delete next.name;
  if (!String(next.icon || "").startsWith("data:image/")) delete next.icon;
  if (Object.keys(next).length) table[id] = next;
  else delete table[id];
  S.persistSoon();
  return next;
}

export function resetNavOverride(id) {
  delete overridesState()[id];
  S.persistSoon();
}
