// 全局搜索 / 命令面板：任务、时间块、插件与常用命令统一入口。
import * as S from "./store.js";
import { el } from "./ui.js";
import { getRegistry, pluginViews } from "./pluginHost.js";
import { computePluginShortcutMap, getPluginShortcutCustoms } from "./pluginShortcuts.js";
import { pluginShortcutEntries } from "./pluginShortcutEntries.js";
import { openTaskDrawer } from "./views/drawer.js";
import { openQuickCapture } from "./capture.js";
import { closeLayer } from "./motion.js";
import { SETTINGS_SEARCH_ENTRIES, SETTINGS_SECTION_LABELS } from "./settingsSearchIndex.js";
import { scoreSearchEntry } from "./searchMatch.js";

let modal = null;
let input = null;
let list = null;
let activeIndex = 0;
let visible = [];

// 内联 SVG（stroke 风格，跟随 currentColor）：手机端命令面板要显示类型图标与关闭按钮，
// 不走 Icons8 PNG——省一次网络/文件加载，且深浅主题自动跟随文字色。
const SVG = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SEARCH_ICON = SVG('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>');
const CLOSE_ICON = SVG('<path d="M18 6 6 18M6 6l12 12"/>');
const KIND_ICONS = {
  "命令": SVG('<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>'),
  "导航": SVG('<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"/>'),
  "任务": SVG('<circle cx="12" cy="12" r="10"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/>'),
  "已完成任务": SVG('<circle cx="12" cy="12" r="10"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/>'),
  "时间块": SVG('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  "设置": SVG('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  // 插件类条目的兜底图标（随包 PNG 加载失败 / 外来插件没有图标时）——齿轮。
  "插件": SVG('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  "已停用插件": SVG('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};
function iconSpan(cls, svg) {
  const s = el("span", { class: cls, "aria-hidden": "true" });
  s.innerHTML = svg;
  return s;
}
// 插件条目用插件自己的随包图标（public/icons/plugins/<id>.png，Icons8 Color 彩色风格，
// 与主导航/插件中心同一套）；没有随包图标的（外来插件等）回落齿轮 SVG。
function kindIconNode(item) {
  if (item.pluginId) {
    const s = el("span", { class: `cmd-kind-ico cmd-kind-plugin${item.kind === "已停用插件" ? " off" : ""}`, "aria-hidden": "true" });
    const img = el("img", {
      class: "cmd-kind-img",
      src: `/icons/plugins/${encodeURIComponent(item.pluginId)}.png`,
      alt: "", loading: "lazy", decoding: "async", draggable: "false",
    });
    img.addEventListener("error", () => { s.innerHTML = KIND_ICONS["插件"]; }, { once: true });
    s.append(img);
    return s;
  }
  return iconSpan("cmd-kind-ico", KIND_ICONS[item.kind] || "");
}

function navigate(view) {
  window.dispatchEvent(new CustomEvent("tide:navigate", { detail: view }));
}

function normalize(text) { return String(text || "").trim().toLowerCase(); }
// 打分与设置页左栏搜索同一套（src/searchMatch.js）：标题 → 标题词段缩写 → 关键词词段缩写。
// 「zt」在两边都只会落到「字体模式 / 文字大小」这类真的以「字体」开头的条目上。
function score(entry, q) {
  if (!q) return entry.priority || 0;
  return scoreSearchEntry(entry, q);
}

function entries() {
  const core = [
    { kind: "命令", title: "快速捕获", sub: "粘贴一句话，自动识别日期和时间", keywords: "capture 新建 收集", priority: 90, run: () => openQuickCapture() },
    { kind: "命令", title: "新建任务", sub: "创建一条任务并立即编辑", keywords: "task 待办", priority: 85, run: () => { const t = S.addTask({ title: "新任务" }); navigate("quadrant"); setTimeout(() => openTaskDrawer(t.id), 40); } },
    { kind: "导航", title: "今天的时间块", sub: S.todayStr(), keywords: "today 日程 时间轴", priority: 80, run: () => { S.getState().settings.lastDate = S.todayStr(); S.persistSoon(); navigate("timeblock"); } },
    { kind: "导航", title: "任务表", sub: "任务优先级", keywords: "quadrant 任务 任务表 四象限", priority: 70, run: () => navigate("quadrant") },
    { kind: "导航", title: "插件中心", sub: "搜索、启停和管理插件", keywords: "plugin market 插件", priority: 70, run: () => navigate("market") },
    { kind: "导航", title: "设置", sub: "提醒、同步、快捷键、插件权限", keywords: "settings 配置", priority: 60, run: () => navigate("settings") },
  ];

  const tasks = S.getState().tasks.map((t) => ({
    kind: t.done ? "已完成任务" : "任务",
    title: t.title,
    sub: [t.project, t.due ? `截止 ${t.due}${t.dueTime ? ` ${t.dueTime}` : ""}` : "", ...(t.tags || [])].filter(Boolean).join(" · "),
    keywords: `${t.note || ""} ${t.project || ""} ${(t.tags || []).join(" ")}`,
    priority: t.done ? 5 : 30,
    run: () => { navigate("quadrant"); setTimeout(() => openTaskDrawer(t.id), 40); },
  }));

  const blocks = S.getState().blocks.map((b) => ({
    kind: "时间块",
    title: b.title,
    sub: `${b.date} ${b.start} · ${S.durLabel(b.durMin)}`,
    keywords: `${b.date} ${b.start} ${b.cat || ""}`,
    priority: b.date === S.todayStr() ? 35 : 12,
    run: () => { S.getState().settings.lastDate = b.date; S.persistSoon(); navigate("timeblock"); },
  }));

  const settings = SETTINGS_SEARCH_ENTRIES.map((item) => ({
    kind: "设置",
    title: item.title,
    sub: `设置 · ${SETTINGS_SECTION_LABELS[item.section] || item.section}`,
    keywords: item.keywords,
    // 空查询时让命令、导航、插件和真实任务优先；一旦输入关键词，匹配分仍会把设置项顶上来。
    priority: 4,
    run: () => window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: item.section, target: item.title } })),
  }));

  const regs = getRegistry();
  // 生效的 Alt 字母（与侧栏徽标同一套分配规则），有就亮在副标题里
  const shortcutMap = computePluginShortcutMap(pluginShortcutEntries(), getPluginShortcutCustoms());
  const plugins = regs.map((rec) => {
    const man = rec.manifest || {};
    const pv = pluginViews.find((v) => v.pluginId === rec.id);
    const enabled = S.pluginState(rec.id).enabled !== false;
    const sc = enabled && pv ? shortcutMap.get(rec.id)?.letter || "" : "";
    return {
      kind: enabled ? "插件" : "已停用插件",
      pluginId: rec.id,
      title: man.name || rec.id,
      sub: enabled && pv ? (sc ? `打开插件 · Alt+${sc}` : "打开插件") : enabled ? "插件已开启 · 前往插件设置" : "插件已关闭 · 前往插件设置",
      keywords: `${rec.id} ${man.description || ""} ${man.author || ""}`,
      priority: enabled ? 40 : 10,
      run: () => enabled && pv ? navigate(`plug:${pv.id}`) : navigate("settings"),
    };
  });
  return [...core, ...settings, ...plugins, ...tasks, ...blocks];
}

function renderResults() {
  if (!list || !input) return;
  const q = normalize(input.value);
  visible = entries()
    .map((entry) => ({ entry, score: score(entry, q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, "zh-CN"))
    .slice(0, 30)
    .map((x) => x.entry);
  activeIndex = Math.max(0, Math.min(activeIndex, visible.length - 1));
  list.replaceChildren();
  if (!visible.length) {
    list.append(el("div", { class: "cmd-empty" }, `没有找到“${input.value.trim()}”`));
    return;
  }
  visible.forEach((item, idx) => {
    const row = el("button", { class: `cmd-row${idx === activeIndex ? " on" : ""}`, type: "button" },
      el("span", { class: "cmd-kind" }, kindIconNode(item), el("span", { class: "cmd-kind-text" }, item.kind)),
      el("span", { class: "cmd-main" }, el("b", {}, item.title), item.sub ? el("small", {}, item.sub) : null),
      el("span", { class: "cmd-enter" }, idx === activeIndex ? "↵" : ""),
    );
    row.addEventListener("mouseenter", () => { activeIndex = idx; paintSelection(); });
    row.addEventListener("click", () => run(idx));
    list.append(row);
  });
}

function paintSelection() {
  [...(list?.querySelectorAll(".cmd-row") || [])].forEach((node, idx) => node.classList.toggle("on", idx === activeIndex));
}

function run(index = activeIndex) {
  const item = visible[index];
  if (!item) return;
  closeCommandPalette();
  try { item.run(); } catch (e) { console.error(e); }
}

function closeCommandPalette() {
  if (!modal) return;
  const closingModal = modal;
  const closingMask = modal._mask;
  modal = input = list = null;
  visible = [];
  closeLayer(closingModal, closingMask);
}

function openCommandPalette(initialQuery = "") {
  if (modal) { input.value = initialQuery; renderResults(); input.focus(); return; }
  const mask = el("div", { class: "cmd-mask", onclick: closeCommandPalette });
  input = el("input", { class: "cmd-input", type: "search", placeholder: "搜索任务、时间块、插件、设置，或输入命令…", value: initialQuery, "aria-label": "全局搜索" });
  // 手机端没有 Esc 键：始终渲染一个 ✕ 关闭按钮（kbd Esc 仅桌面显示，见 CSS）。
  const closeBtn = el("button", { class: "cmd-close", type: "button", "aria-label": "关闭搜索", onclick: closeCommandPalette });
  closeBtn.innerHTML = CLOSE_ICON;
  list = el("div", { class: "cmd-list", role: "listbox" });
  modal = el("div", { class: "cmd-palette", role: "dialog", "aria-label": "全局搜索与命令面板" },
    el("div", { class: "cmd-search" }, iconSpan("cmd-search-ico", SEARCH_ICON), input, closeBtn, el("kbd", {}, "Esc")),
    list,
    el("div", { class: "cmd-foot" },
      el("span", { class: "foot-desktop" }, "↑↓ 选择 · Enter 打开 · Ctrl+K 随时呼出"),
      el("span", { class: "foot-mobile" }, "点按条目直接打开 · 点按空白处收起"),
    ),
  );
  modal._mask = mask;
  input.addEventListener("input", () => { activeIndex = 0; renderResults(); });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(visible.length - 1, activeIndex + 1); paintSelection(); list.querySelectorAll(".cmd-row")[activeIndex]?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); paintSelection(); list.querySelectorAll(".cmd-row")[activeIndex]?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter") { e.preventDefault(); run(); }
    else if (e.key === "Escape") { e.preventDefault(); closeCommandPalette(); }
  });
  document.body.append(mask, modal);
  renderResults();
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

export function initCommandPalette() {
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if (e.key === "Escape" && modal && !inField) closeCommandPalette();
  });
  window.addEventListener("tide:command-palette", () => openCommandPalette());
}
