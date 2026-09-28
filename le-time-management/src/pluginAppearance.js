import * as S from "./store.js";
import { isGroupColor } from "./pluginGroups.js";
import { appIcon, outlineAppIcon } from "./icons.js";

const ACCENTS = ["#7C3AED", "#2563EB", "#0F766E", "#D97706", "#DB2777", "#0891B2", "#65A30D", "#EA580C"];

function overridesState() {
  const settings = S.getState().settings;
  if (!settings.pluginOverrides || typeof settings.pluginOverrides !== "object" || Array.isArray(settings.pluginOverrides)) {
    settings.pluginOverrides = {};
  }
  return settings.pluginOverrides;
}

export function pluginAccent(id) {
  let hash = 0;
  for (const char of String(id || "plugin")) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return ACCENTS[Math.abs(hash) % ACCENTS.length];
}

export function getPluginOverride(id) {
  const value = overridesState()[id];
  return value && typeof value === "object" ? value : {};
}

export function pluginDisplayName(id, fallback) {
  const name = String(getPluginOverride(id).name || "").trim();
  return name || fallback || id;
}

export function pluginDisplayIcon(id, title = "") {
  const icon = appIcon(id, title);
  const custom = getPluginOverride(id).icon;
  icon.classList.add("plugin-present-icon");
  icon.style.setProperty("--plugin-accent", pluginAccent(id));
  if (typeof custom === "string" && custom.startsWith("data:image/")) {
    icon.src = custom;
    icon.dataset.iconSource = "user customization";
  }
  return icon;
}

export function pluginDisplayOutlineIcon(id, title = "") {
  const icon = outlineAppIcon(id, title);
  icon.classList.add("plugin-present-icon");
  icon.style.setProperty("--plugin-accent", pluginAccent(id));
  return icon;
}

export function setPluginOverride(id, patch) {
  const table = overridesState();
  const next = { ...(table[id] || {}), ...(patch || {}) };
  if (!String(next.name || "").trim()) delete next.name;
  if (!String(next.icon || "").startsWith("data:image/")) delete next.icon;
  // 分组色只存色 ID（pluginGroups.GROUP_COLORS），色值和自定义值一律不落库
  if (!isGroupColor(next.color)) delete next.color;
  if (Object.keys(next).length) table[id] = next;
  else delete table[id];
  S.persistSoon();
  return next;
}

export function pluginColor(id) {
  const value = getPluginOverride(id).color;
  return isGroupColor(value) ? value : "";
}

/** color 传空即取消分组。顺序吸附由调用方负责（见 shell.js 的 normalizePluginOrder）。 */
export function setPluginColor(id, color) {
  return setPluginOverride(id, { color: isGroupColor(color) ? color : "" });
}

export function resetPluginOverride(id) {
  delete overridesState()[id];
  S.persistSoon();
}
