// 应用外壳：侧栏导航 + 顶栏 + 视图切换
import * as S from "./store.js";
import { appIcon } from "./icons.js";
import { api } from "./api.js";
import { appConfirm, appPrompt, bottomInsetPx, el, isSelfActivationKey, toast } from "./ui.js";
import { renderQuadrant } from "./views/quadrant.js";
import { renderTimeblock } from "./views/timeblock.js";
import { renderTimeline } from "./views/timeline.js";
import { renderSettings } from "./views/settings.js";
import { renderInbox } from "./views/inbox.js";
import { openQuickCapture } from "./capture.js";
import { pluginViews, onNavChanged, getRegistry, setEnabled, rescan, removeExternalPlugin } from "./pluginHost.js";
import { getPluginOverride, pluginAccent, pluginColor, pluginDisplayIcon, pluginDisplayName, resetPluginOverride, setPluginColor, setPluginOverride } from "./pluginAppearance.js";
import { GROUP_COLORS, groupColorMeta, groupName, groupRuns, isGroupColor, isGroupCollapsed, moveGroupInOrder, normalizePluginOrder, renameGroup, toggleGroupCollapsed } from "./pluginGroups.js";
import { hasNavOverride, navDisplayIcon, navDisplayName, resetNavOverride, setNavOverride } from "./navAppearance.js";
import { PLUGIN_SHORTCUT_MODIFIER, attachPluginShortcutKeys, computePluginShortcutMap, effectivePluginShortcutLetter, getPluginShortcutCustoms, normalizeShortcutLetter, setPluginShortcut } from "./pluginShortcuts.js";
import { pluginShortcutEntries } from "./pluginShortcutEntries.js";
import { getUiPreferences, coreViewIds } from "./uiPreferences.js";
import { listRailActions, normalizeRailActionOrder, registerRailAction, slotIndexFor } from "./railActions.js";
import { closeLayer, fadeAway, flipByKey, foldClose, foldOpen, observePluginMotion, reducedMotion, removeWithMotion } from "./motion.js";
import { FOCUS_WINDOW_SIZE, isDesktopRuntime, isFocusWindowActive, toggleFocusWindow } from "./windowSize.js";
import { canGoBack, goBack, initBackNav, noteViewChange } from "./backNav.js";
import { getThemeMode, resolveThemeMode, setThemeMode } from "./theme.js";
import { RAIL_WIDTH_LIMITS, RAIL_WIDTH_STEP, applyRailWidth, clampRailWidth, normalizeRailWidth, steppedRailWidth } from "./railWidth.js";
import { getUiScaleFactor } from "./uiScale.js";
import { attachToolbarDrag } from "./toolbarDrag.js";

// 注意：模块导入阶段 state 还未初始化，activeView 必须延迟到 renderShell 时读取
let activeView = null;
let marketQuery = "";
let marketFilter = "all";
let marketSearchOpen = false;
function ensureActiveView() {
  if (activeView === null) {
    const prefs = getUiPreferences();
    const saved = S.getState().settings.lastView;
    const fixedStart = prefs.startupView !== "last" ? prefs.startupView : null;
    // v0.52.0：白名单改为按平台取（APK 端没有时间块 / 收件箱，落到四象限兜底）
    const core = coreViewIds();
    if (fixedStart && core.includes(fixedStart)) activeView = fixedStart;
    else if (core.includes(saved)) activeView = saved;
    else if (typeof saved === "string" && saved.startsWith("plug:")) activeView = saved;
    else activeView = "quadrant";
  }
  return activeView;
}

// 核心页的**默认**名称与图标（图标 key 见 icons.js 的 NAV_ICONS8）。
// 用户在侧栏右键改的是显示名，落在 settings.navOverrides（见 navAppearance.js），不动这里。
const VIEWS = [
  { id: "quadrant", icon: "table-cells-large", title: "任务表", sub: "先决定，再动手" },
  // v0.52.0：时间线 —— APK（移动运行时）专属核心视图，替代窄屏下的时间块 / 收件箱；
  // 桌面端不出这个入口（coreViewIds() 按平台裁剪，见 uiPreferences.js）。
  { id: "timeline", icon: "timeline", title: "时间线", sub: "按日期串起安排与截止" },
  { id: "timeblock", icon: "clock", title: "时间块", sub: "把任务装进一天的格子" },
  { id: "inbox", icon: "inbox", title: "收件箱", sub: "自动化与待确认事项" },
  { id: "market", icon: "puzzle-piece", title: "插件", sub: "扩展能力集中在这里" },
];
const PLUGIN_ICONS = {
  "pomodoro": "hourglass-half",
  "weekly-report": "chart-column",
  "gx-news": "trophy",
  "chaoxing-notify": "graduation-cap",
  "cppu-notify": "building-columns",
  "wechat-push": "comment-dots",
};
// v0.58.0 加 "theme"（顶栏深浅色切换键，用户需求「添加深色和浅色切换按钮」）。
// window 恒作为兜底排最后（Windows 习惯：窗口键必须贴最右），见 topbarOrderState。
const TOPBAR_PARTS = ["search", "quick", "theme", "settings", "stats", "window"];

function topbarOrderState() {
  const settings = S.getState().settings;
  const saved = Array.isArray(settings.topbarOrder) ? settings.topbarOrder : [];
  // 归一化：保留存档里仍存在的部件顺序，新增部件补进尾部 —— 但**不许落在 window
  // 之后**（老存档升级时新键若直接补尾，会排到窗口键右边，违反窗口键贴最右的习惯）。
  const order = [...new Set(saved.filter((id) => TOPBAR_PARTS.includes(id)))];
  for (const id of TOPBAR_PARTS.filter((x) => !saved.includes(x))) {
    const wi = order.indexOf("window");
    if (wi >= 0) order.splice(wi, 0, id); else order.push(id);
  }
  settings.topbarOrder = order;
  return settings.topbarOrder;
}

function moveTopbarPart(order) {
  if (!Array.isArray(order)) return false;
  const previous = [...topbarOrderState()];
  const visible = [...new Set(order.filter((id) => TOPBAR_PARTS.includes(id)))];
  // 未渲染的窗口键仍留在存档里；浏览器/不同平台间切换不会丢失部件。
  const next = [...visible, ...previous.filter((id) => !visible.includes(id))];
  if (next.length === previous.length && next.every((id, i) => id === previous[i])) return false;
  S.getState().settings.topbarOrder = next;
  S.persistSoon();
  return true;
}
function viewDef(id) {
  if (id.startsWith("plug:")) {
    const v = pluginViews.find((x) => `plug:${x.id}` === id);
    // 插件视图副标题不放 manifest.description（长简介会把桌面标题卡撑爆、名称被裁），
    // 顶栏只保留插件名称；核心视图的短文案副标题不受影响
    return v ? { id, icon: PLUGIN_ICONS[v.pluginId] || v.icon || "puzzle-piece", title: pluginDisplayName(v.pluginId, v.title), sub: "", pluginView: v } : null;
  }
  // v0.52.0：核心视图按平台裁剪 —— 移动端查不到时间块 / 收件箱（viewDef 返回 null），
  // 桌面端查不到时间线。switchTo 里有更早的重定向兜底（见下）。
  if (!coreViewIds().includes(id)) return null;
  const def = VIEWS.find((v) => v.id === id) || VIEWS[0];
  // 右键改过名才新建对象：VIEWS 是默认名的事实源，也是「恢复默认」的比对基准，不许被写脏
  const title = navDisplayName(def.id, def.title);
  return title === def.title ? def : { ...def, title };
}

function pluginOrderState() {
  const settings = S.getState().settings;
  settings.pluginOrder = Array.isArray(settings.pluginOrder) ? settings.pluginOrder.filter(Boolean) : [];
  return settings.pluginOrder;
}

function orderedPluginViews() {
  const order = pluginOrderState();
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...pluginViews].sort((a, b) => {
    const ar = rank.has(a.pluginId) ? rank.get(a.pluginId) : Number.MAX_SAFE_INTEGER;
    const br = rank.has(b.pluginId) ? rank.get(b.pluginId) : Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    return String(a.title || a.id).localeCompare(String(b.title || b.id), "zh-CN");
  });
}

// 当前显示顺序下的插件 ID 完整排列（同色已吸附成段）。改色、整组移动、段内拖拽都从这里取，
// 保证「看到的顺序」与「落库的顺序」是同一个口径。
function currentPluginOrder() {
  return normalizePluginOrder(orderedPluginViews().map((pv) => pv.pluginId), pluginColor);
}

// 侧栏 FLIP 的 key：插件项按 data-view 认领（桌面端之外没有 data-plugin-id），颜色卡片与组头按色认领。
function navFlipKey(node) {
  if (node.matches(".plug-group")) return `group:${node.dataset.color}`;
  if (node.matches(".plug-group-head")) return `head:${node.parentElement?.dataset.color || ""}`;
  return node.dataset.view ? `view:${node.dataset.view}` : "";
}

// 新出现的颜色卡片只把底色与描边淡进来 —— 整卡淡入会把里面本来就在的插件也闪一下；
// 组头与新出现的插件项轻轻落下。
function navFlipEnter(node) {
  if (node.matches(".plug-group")) {
    const style = getComputedStyle(node);
    return [
      { backgroundColor: "transparent", boxShadow: "none" },
      { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow },
    ];
  }
  return [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }];
}

// 插件中心的组头每次都是重建出来的新节点，接不上 CSS 过渡：用 WAAPI 从旧角度转到新角度。
function turnChevron(chev, collapsed) {
  if (!chev || reducedMotion() || typeof chev.animate !== "function") return;
  chev.animate(
    [{ transform: `rotate(${collapsed ? 0 : -90}deg)` }, { transform: `rotate(${collapsed ? -90 : 0}deg)` }],
    { duration: 180, easing: "cubic-bezier(.22,.8,.22,1)" },
  );
}

function movePluginBefore(sourcePluginId, targetPluginId) {
  if (!sourcePluginId || !targetPluginId || sourcePluginId === targetPluginId) return false;
  const ids = [...new Set(pluginViews.map((x) => x.pluginId))];
  const saved = pluginOrderState();
  const current = [...saved.filter((id) => ids.includes(id)), ...ids.filter((id) => !saved.includes(id))];
  const from = current.indexOf(sourcePluginId);
  const to = current.indexOf(targetPluginId);
  if (from < 0 || to < 0) return false;
  current.splice(from, 1);
  current.splice(current.indexOf(targetPluginId), 0, sourcePluginId);
  S.getState().settings.pluginOrder = current;
  S.persistSoon();
  return true;
}

// ── 插件快捷键（Alt + 字母直达插件视图）──
// 取数统一走这里：侧栏徽标、按键命中、右键菜单看到的必须是同一份分配结果。
// 顺序刻意用 pluginViews 的**注册顺序**（= manifest order），而不是显示顺序：
// ① 内置插件的 order 是策划过的重要度，「番茄专注」这类旗舰不该被「插件使用说明」抢走首字母；
// ② 用户拖动调整显示顺序时，已自动分配的字母不能跟着洗牌。
function shortcutEntries() {
  return pluginShortcutEntries();
}
function effectiveShortcutMap() {
  return computePluginShortcutMap(shortcutEntries(), getPluginShortcutCustoms());
}
function effectiveShortcutLetter(pluginId) {
  return effectivePluginShortcutLetter(pluginId, shortcutEntries());
}

// 翻页顺序：滑动/翻页沿此序（插件页夹在时间线和插件市场之间；APK 端没有时间块 / 收件箱）
function allViewIds() {
  const core = coreViewIds().filter((id) => id !== "market");
  return [...core, ...orderedPluginViews().map((pv) => `plug:${pv.id}`), "market"];
}

export function renderShell(root) {
  ensureActiveView();
  const desktopWindow = isDesktopRuntime();
  const dragRegion = desktopWindow ? "" : null;
  const settings = S.getState().settings;
  settings.quickDock ??= { left: null, top: 92, collapsed: false, alwaysOnTop: false };
  const quickDockState = settings.quickDock;
  const nav = el("nav", { class: "nav" });
  const view = el("div", { class: "view" });
  const titleEl = el("h1", {});
  const subEl = el("span", { class: "sub" });
  // v0.39.0：标题卡左侧恢复小框 —— 但不再是 v0.38.2 之前那颗恒装 Le 应用图标的
  // 42px 死框，而是紧凑尺寸（22px，窄屏 20px），图标跟随当前视图：
  // 插件页装插件自己的图标（如竞赛消息的奖杯），核心页装各视图导航图标。
  const titleMark = el("span", { class: "topbar-title-mark", "aria-hidden": "true" });
  // v0.44.1：窄屏顶栏返回按钮。起因（用户反馈）：「apk 点进插件后很多没有返回按钮」。
  // 根因：≤900px 时底栏把 12 个插件直达入口收进「插件市场」（styles.css 的 `.plug-list{display:none}`），
  // 进插件后底栏只剩一颗高亮的「插件」，虽然点它能回市场，但没有任何「返回」语义的控件。
  // 行为与 Android 返回键完全一致（先关浮层、再回上一个视图），实现直接复用 backNav 的 goBack()。
  // 默认 display:none，只在窄屏且确实有地方可回时显示（桌面有侧栏直达，不占顶栏）。
  const backBtn = el("button", {
    class: "topbar-back",
    type: "button",
    title: "返回",
    "aria-label": "返回",
    onclick: () => goBack(),
  }, el("span", { class: "topbar-back-glyph", "aria-hidden": "true" }, "‹"));
  // v0.52.0：APK 沉浸式外壳的两颗悬浮键（CSS 只在 ≤900px 显示，桌面端恒 display:none）。
  // 需求（用户）：「apk 默认上下栏都隐藏起来，只有点 3 个点图标的菜单键才会显示出来」+
  // 「每一页都添加返回按钮，在适合的位置，要小」。
  // ① 右上角 ⋮ 菜单键（.chrome-toggle）：点它给 .app 挂 .chrome-shown 呼出底栏，
  //    再点收回（图标随之变 ✕）。
  //    v0.59.0：顶栏整条移除（用户需求「APK 上面那栏删除」），⋮ 只剩呼出底栏一个职责。
  //    v0.59.0：呼出后底栏常驻，切视图不再自动收回（用户需求「点击显示菜单按钮后，
  //    除非打开设置否则不[收起]菜单」）—— 只有 openSettingsModal 会收掉它，
  //    而设置关掉时按进入前的样子放回来（见 openSettingsModal 的 railShownBeforeSettings）。
  // ② 左上角小返回键（.mobile-back）：与顶栏返回键共用一份 canGoBack() 状态 ——
  //    上下栏收起时它是唯一的返回入口，行为与 Android 返回键完全一致（复用 goBack()）。
  //    两颗都要 data-motion="off"：interactions.css 的
  //    `button.motion-ripple-host:not([data-motion="off"]) { position: relative }`（0,2,1）
  //    会把 position: fixed 压掉，悬浮键直接掉回文档流末尾（实测 rect y=850 出屏）；
  //    带上该属性选择器不命中，fixed 得以保留，顺带免掉 36px 小钮上的波纹动效。
  const mobileBack = el("button", {
    class: "mobile-back",
    type: "button",
    title: "返回",
    "aria-label": "返回",
    "data-motion": "off",
    onclick: () => goBack(),
  }, el("span", { class: "mobile-back-glyph", "aria-hidden": "true" }, "‹"));
  const chromeToggle = el("button", {
    class: "chrome-toggle",
    type: "button",
    title: "显示菜单",
    "aria-label": "显示或隐藏底栏",
    "aria-expanded": "false",
    "data-motion": "off",
    onclick: () => setChromeShown(!chromeShown),
  },
    el("span", { class: "chrome-glyph ct-open", "aria-hidden": "true" }, "⋮"),
    el("span", { class: "chrome-glyph ct-close", "aria-hidden": "true" }, "✕"),
  );
  const statPill = el("span", { class: "pill" });
  // v0.54.0：触发钮改为圆方形图标瓷砖（无文字），样式对齐快捷菜单的图标网格观感
  const quickDockToggle = el("button", { class: "top-mini-btn quick-menu-trigger", title: "快捷入口", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" },
    el("span", { class: "quick-menu-trigger-glyph", "aria-hidden": "true" }, faIcon("bolt")),
  );

  // v0.53.0：操作条里的设置按钮由 renderRailDock() 建好后回填 —— 切换视图时要摘掉它的 .on
  let settingsDockBtn = null;
  let quickDock = null;
  let pinActionBtn = null;
  let navTransitionSeq = 0;
  // v0.52.0：沉浸式外壳状态。默认 false ⇒ APK 上下栏默认都收起（需求原文「默认上下栏
  // 都隐藏起来」）。每次启动都从收起态开始，不做持久化 —— 「默认」就是每次进来的样子。
  let chromeShown = false;
  const mobileQuery = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 900px)")
    : { matches: false };
  // 设置弹窗会收掉呼出的底栏（弹窗要占满屏），关掉后再按进入前的样子放回来。
  // 层数是必要的：设置页里还能再开一次设置页（views/settings/sync.js 派发
  // tide:open-settings），只有最外层记录快照、只有最后一层关闭才恢复。
  let settingsLayers = 0;
  let railShownBeforeSettings = false;

  // ── v0.53.0：左下角快捷操作条 ──
  // 竖排两颗按钮 → 横排一条，按住任一按钮可拖动重排（其余按钮实时让位，落点由指针
  // 实时决定，见 attachRailDockDrag）。按钮不再在这里手写，改由注册表驱动：
  //   registerRailAction({ id, label, icon, onClick })  ← 「后续添加按钮的接口」
  // 顺序持久化在 settings.railActionOrder。容器仍带 .rail-bottom 类 —— 窄屏底栏
  // 那批规则（order/width/子按钮尺寸）全部挂在它上面，换名会连带动几十条 CSS。
  const railDock = el("div", {
    class: "rail-bottom rail-dock",
    role: "toolbar",
    "aria-label": "快捷操作",
    "data-rail-dock": "",
  });
  const rail = el("aside", { class: "rail" },
      el("div", { class: "brand" },
      el("span", { class: "mark" }),
      el("div", {}, el("b", {}, "U-Time"), el("small", {}, "U-TIME")),
    ),
    nav,
    railDock,
  );

  const makeWindowControl = (kind, label, handler) => el("button", {
    class: `window-control window-control-${kind}`,
    type: "button",
    title: label,
    "aria-label": label,
    onclick: handler,
  }, el("span", { class: `window-control-glyph window-control-glyph-${kind}`, "aria-hidden": "true" }));

  const windowControls = desktopWindow ? el("div", { class: "window-controls", "data-noswipe": "", title: "拖动可调整顶栏位置" },
    makeWindowControl("minimize", "最小化", () => withCurrentWindow((win) => win.minimize())),
    makeWindowControl("maximize", "最大化 / 还原", () => withCurrentWindow((win) => win.toggleMaximize())),
    makeWindowControl("close", "关闭", () => withCurrentWindow((win) => win.close())),
  ) : null;

  // v0.57.0：搜索钮收成纯放大镜图标（用户需求「搜索/命令也弄成一个放大镜图标，不用文字」），
  // 与快捷入口瓷砖（.quick-menu-trigger）同观感 —— 文字与 Ctrl K 角标从 DOM 移除，
  // 快捷键说明挪进 title；命令面板入口（tide:command-palette）与拖动排序不变。
  const topSearch = el("button", { class: "top-search", title: "全局搜索 / 命令面板（Ctrl+K）· 拖动可调整位置", "aria-label": "全局搜索 / 命令", type: "button", onclick: () => window.dispatchEvent(new CustomEvent("tide:command-palette")) },
    el("span", { class: "top-search-glyph", "aria-hidden": "true" }, faIcon("magnifying-glass")));

  /* 深浅色键的字形按**当前生效亮度**取：浅色 = 太阳、深色 = 月亮（2026-09-19 用户指定）。
     顶栏与左下角两颗键共用，别各写一份 ternary。
     旧逻辑反着来（浅色显月亮 = 「点下去会去哪」），而 FA 的 sun 在 15~18px 下就是
     「圆盘 + 8 道短射线」，与隔壁设置键的真齿轮几乎同形 —— 深色模式里再叠上
     「深字压深底」，用户看到的就是「一个深色齿轮」。 */
  const themeModeGlyph = () => (resolveThemeMode() === "dark" ? "moon" : "sun");

  // v0.58.0：顶栏深浅色切换键（用户需求「添加深色和浅色切换按钮」）。与左下角操作条 /
  // 设置页同一条动画路径（setThemeMode → View Transitions 圆形揭示，圆心取点击位置 ——
  // theme.js 的全局 pointerdown 监听自动记录 lastPointer）。图标随**实际生效**亮度翻转
  //（浅色显太阳 = 现在就是浅色），「跟随系统」时系统亮暗翻转也由 MutationObserver 驱动刷新，
  // 逻辑照抄 railDock 的 theme-toggle 注册（shell.js 下方 registerRailAction("theme-toggle")）。
  const topTheme = el("button", {
    class: "top-mini-btn top-theme-toggle",
    title: "切换深浅模式",
    "aria-label": "切换深浅模式",
    type: "button",
    onclick: () => {
      const next = resolveThemeMode() === "dark" ? "light" : "dark";
      setThemeMode(next, { animate: true });
      toast(`已切换为${next === "dark" ? "深色" : "浅色"}模式`);
      // 图标刷新由下面的 MutationObserver 驱动，不在这里手动调（与侧栏同一模式）
    },
  });
  const paintTopTheme = () => {
    const dark = resolveThemeMode() === "dark";
    topTheme.replaceChildren(el("span", { class: "top-theme-glyph", "aria-hidden": "true" }, faIcon(themeModeGlyph())));
    topTheme.title = dark ? "切换到浅色模式 · 拖动可调整位置" : "切换到深色模式 · 拖动可调整位置";
  };
  paintTopTheme();
  new MutationObserver(paintTopTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode"] });

  const topSettings = el("button", {
    class: "top-mini-btn top-settings-trigger",
    title: "设置 · 拖动或 Alt+←/→ 调整位置",
    "aria-label": "设置",
    "aria-haspopup": "dialog",
    type: "button",
    onclick: () => openSettingsModal(),
  }, el("span", { class: "top-settings-glyph", "aria-hidden": "true" }, appIcon("settings")));

  const topbarActionCard = el("div", { class: "topbar-action-card", role: "toolbar", "aria-label": "可拖动排序的顶栏工具", "data-noswipe": "" });
  const topbar = el("header", { class: "topbar", "data-tauri-drag-region": dragRegion },
      el("div", { class: "topbar-title-card", "data-tauri-drag-region": dragRegion },
        // v0.39.0：小框回归（紧凑版），图标随视图切换（见 renderTitleMark）；
        // 右侧标题仍直接写在顶栏这两条横线之间（v0.37.15「框太多」只针对右侧工具卡）。
        backBtn,
        titleMark,
        el("div", { class: "topbar-title-copy", "data-tauri-drag-region": dragRegion }, titleEl, subEl),
      ),
      desktopWindow ? el("span", { class: "window-drag-strip", "data-tauri-drag-region": dragRegion }) : null,
      topbarActionCard,
    );
  const main = el("main", { class: "main" },
    topbar,
    view,
  );

  // v0.58.0：侧栏宽度分隔条 —— 骑在 .rail 与 .main 的间隙上（几何见 styles.css），
  // 桌面（≥901px）显示，窄屏侧栏变底栏后整条隐藏。事件接线在下方 root.append 之后。
  const railResizer = el("div", {
    class: "rail-resizer",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "调整侧栏宽度",
    "aria-valuemin": String(RAIL_WIDTH_LIMITS.min),
    "aria-valuemax": String(RAIL_WIDTH_LIMITS.max),
    title: "拖动调整侧栏宽度 · 双击恢复默认",
    tabindex: 0,
  });

  const appFrame = el("div", { class: "app" }, rail, railResizer, main);
  root.append(appFrame);

  /* ── v0.58.0：侧栏宽度分隔条接线 ──
   * 拖动实时改宽（rAF 合帧），松手落盘 settings.railWidth；pointercancel 回滚到
   * 拖动前宽度（不留半截状态）；双击恢复默认；键盘 ←/↓ 变窄、→/↑ 变宽、Home/End 到界。
   *
   * 坐标换算：zoom 下 clientX 与 getBoundingClientRect() 同为屏幕视觉 px，一律除以
   * 生效缩放系数（getUiScaleFactor()）换成布局 px（与 uiScale.js 的 viewportWidth()
   * 同一口径）—— 不除的话 125% 缩放下侧栏会比手指快 25%。
   *
   * 会话兜底照抄 attachRailDockDrag：setPointerCapture 失败（或环境不支持）时，
   * document 捕获阶段的 pointerup/pointercancel 兜底收会话，指针在元素外松手也不会挂死。
   */
  let resizeSess = null;
  let resizeFrame = 0;
  let resizePending = null;
  applyRailWidth(normalizeRailWidth(S.getState().settings.railWidth), appFrame);
  const railWidthLayoutPx = () => {
    const factor = getUiScaleFactor() || 1;
    const w = rail.getBoundingClientRect().width / factor;
    return Number.isFinite(w) && w > 0 ? w : null;
  };
  const syncResizerAria = () => {
    const w = railWidthLayoutPx();
    if (w !== null) railResizer.setAttribute("aria-valuenow", String(Math.round(w)));
  };
  syncResizerAria();
  const paintResize = () => {
    resizeFrame = 0;
    if (resizePending === null) return;
    applyRailWidth(resizePending, appFrame);
    resizePending = null;
    syncResizerAria();
  };
  const endResizeSession = (event, commit) => {
    const st = resizeSess;
    if (!st || (event && event.pointerId !== st.pointerId)) return;
    if (resizeFrame) { // 收帧：拖动中松手时把最后一帧宽度立即落定，不丢尾帧
      cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
      paintResize();
    }
    resizeSess = null;
    document.removeEventListener("pointerup", st.docUp, true);
    document.removeEventListener("pointercancel", st.docCancel, true);
    document.body.classList.remove("rail-resizing");
    railResizer.classList.remove("active");
    try { railResizer.releasePointerCapture(st.pointerId); } catch { /* 未捕获过 */ }
    if (commit) {
      // st.last === null = 原地点击没拖动，不落盘；与拖动前值相同也不必写
      if (st.last !== null && st.last !== st.startSaved) {
        S.getState().settings.railWidth = st.last;
        S.persistSoon();
      }
    } else if (st.last !== null) {
      // pointercancel（触摸被打断 / 系统手势接管）：回滚到拖动前的宽度
      applyRailWidth(st.startSaved, appFrame);
      syncResizerAria();
    }
  };

  railResizer.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (resizeSess) return;
    const startW = railWidthLayoutPx();
    if (startW === null) return;
    resizeSess = {
      pointerId: event.pointerId,
      startX: event.clientX,
      factor: getUiScaleFactor() || 1,
      startW,
      startSaved: normalizeRailWidth(S.getState().settings.railWidth),
      last: null,
      docUp: null,
      docCancel: null,
    };
    document.body.classList.add("rail-resizing");
    railResizer.classList.add("active");
    event.preventDefault(); // 不让按下起点变成文本选区；键盘焦点走 Tab，不抢鼠标焦点
    try { railResizer.setPointerCapture(event.pointerId); } catch { /* 下面有 document 兜底 */ }
    resizeSess.docUp = (e) => endResizeSession(e, true);
    resizeSess.docCancel = (e) => endResizeSession(e, false);
    document.addEventListener("pointerup", resizeSess.docUp, true);
    document.addEventListener("pointercancel", resizeSess.docCancel, true);
  });
  railResizer.addEventListener("pointermove", (event) => {
    const st = resizeSess;
    if (!st || event.pointerId !== st.pointerId) return;
    const delta = (event.clientX - st.startX) / st.factor;
    const next = clampRailWidth(st.startW + delta);
    if (next === null) return;
    st.last = next;
    // rAF 合帧：宽度变化会重排整个 .app，pointermove 的触发频率没必要逐事件重排
    resizePending = next;
    if (!resizeFrame && typeof window.requestAnimationFrame === "function") resizeFrame = window.requestAnimationFrame(paintResize);
    else if (typeof window.requestAnimationFrame !== "function") paintResize();
  });
  railResizer.addEventListener("keydown", (event) => {
    const base = S.getState().settings.railWidth;
    let next = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = steppedRailWidth(base, -1, railWidthLayoutPx());
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = steppedRailWidth(base, 1, railWidthLayoutPx());
    else if (event.key === "Home") next = clampRailWidth(RAIL_WIDTH_LIMITS.min);
    else if (event.key === "End") next = clampRailWidth(RAIL_WIDTH_LIMITS.max);
    if (next === null) return;
    event.preventDefault();
    applyRailWidth(next, appFrame);
    S.getState().settings.railWidth = next;
    S.persistSoon();
    syncResizerAria();
  });
  // 双击恢复默认：删内联 --rail-w + 删落盘值，密度档位的默认宽度立刻生效
  railResizer.addEventListener("dblclick", () => {
    if (normalizeRailWidth(S.getState().settings.railWidth) === null) return;
    delete S.getState().settings.railWidth;
    applyRailWidth(null, appFrame);
    S.persistSoon();
    syncResizerAria();
    toast("侧栏宽度已恢复默认");
  });

  function renderTopbarOrder() {
    const parts = { search: topSearch, quick: quickDockToggle, theme: topTheme, settings: topSettings, stats: statPill, window: windowControls };
    for (const [id, node] of Object.entries(parts)) {
      if (!node) continue;
      node.draggable = false; // 改用和侧栏相同的指针拖拽，不再启动浏览器原生拖放。
      node.dataset.topbarPart = id;
      node.classList.add("topbar-sortable");
    }
    topbarActionCard.replaceChildren(...topbarOrderState().map((id) => parts[id]).filter(Boolean));
  }
  renderTopbarOrder();
  attachToolbarDrag(topbarActionCard, () => {
    const order = [...topbarActionCard.children].map((node) => node.dataset.topbarPart);
    if (moveTopbarPart(order)) toast("顶栏顺序已保存");
  }, {
    selector: "[data-topbar-part]",
    ghostClass: "topbar-drag-ghost",
    dragClass: "topbar-dragging",
    liveClass: "topbar-drag-live",
  });

  // 核心页与插件的右键菜单共用一个槽位：同一时刻只可能有一个菜单开着，
  // 关闭逻辑（含全局 pointerdown / Escape）也只有一份。
  let contextMenu = null;
  // 挑图标的 <input type=file> 也只有一份，靠这个字段记住「这次是给谁挑」
  let pendingIconTarget = null; // { kind: "plugin" | "nav", id }
  // 插件中心挂着时由 renderMarket 填上「就地重排」入口；没挂着时调用也什么都不做（见 renderMarket）。
  let repaintMarket = null;
  let navFlips = 0; // 在飞的侧栏 FLIP 数：全部落定才摘 .nav-flip
  const pluginZipInput = el("input", { type: "file", accept: ".zip,application/zip", multiple: true, hidden: true });
  const pluginIconInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml", hidden: true });
  root.append(pluginZipInput, pluginIconInput);
  // v0.52.0：两颗悬浮键必须挂在 .app（appFrame）**里面** —— 呼出态的 ⋮/✕ 字形切换
  // 靠 `.app.chrome-shown .chrome-toggle …` 后代选择器驱动，挂在 root
  // 上时是 .app 的兄弟节点，选择器永不命中（实测 ⋮ 永远不变 ✕）。
  // fixed 定位不受影响：.app 无 transform/filter，不构成 fixed 的包含块。
  appFrame.append(chromeToggle, mobileBack);

  function refreshPluginPresentation() {
    renderNav();
    if (activeView === "market" || activeView.startsWith("plug:")) switchTo(activeView, undefined, { history: false });
  }

  /* 分组相关的改动（改色 / 组名 / 收起 / 整组换位 / 段内排序）只影响侧栏与插件中心，
     所以不走上面的 switchTo：那会把当前插件页整个重挂（插件内部状态丢失、联网插件重新拉数据），
     也会把插件中心滚回顶部、让全部卡片重播入场动画。这里只重绘侧栏（FLIP 过渡），
     插件中心若挂着就就地重排。 */
  function refreshPluginGroups() {
    flipNav(renderNav);
    repaintMarket?.();
  }

  // 侧栏整段重绘的 FLIP。飞进 / 飞出颜色卡片的插件在半路会越过卡片边界，
  // 动画期间给 .nav 挂 nav-flip 放开卡片的 overflow（styles.css），否则插件像是凭空出现。
  function flipNav(mutate) {
    navFlips += 1;
    nav.classList.add("nav-flip");
    return flipByKey(nav, {
      selector: "button[data-view], .plug-group[data-color], .plug-group-head",
      key: navFlipKey,
      mutate,
      enter: navFlipEnter,
    }).finally(() => {
      navFlips -= 1;
      if (!navFlips) nav.classList.remove("nav-flip");
    });
  }

  /* 核心页改名 / 换图标后只刷外壳：侧栏条目 + 顶栏标题卡。
     不走 switchTo —— 那会重渲染整个视图，把用户的滚动位置和未保存的输入一起弄没，
     而这里改的只是标签文字和一张图标。 */
  function refreshCorePresentation() {
    renderNav();
    const def = viewDef(activeView);
    if (!def || def.pluginView) return;
    titleEl.textContent = def.title;
    subEl.textContent = def.sub ? ` · ${def.sub}` : "";
    renderTitleMark(def);
  }

  pluginZipInput.addEventListener("change", async () => {
    const files = [...pluginZipInput.files];
    if (!files.length) return;
    try {
      const imported = [];
      for (const file of files) {
        const bytes = [...new Uint8Array(await file.arrayBuffer())];
        imported.push(...await api.importPluginZip(bytes));
      }
      await rescan();
      toast(`已导入 ${new Set(imported).size} 个插件`);
    } catch (error) {
      toast(`插件导入失败：${error.message || error}`);
    } finally {
      pluginZipInput.value = "";
    }
  });

  pluginIconInput.addEventListener("change", async () => {
    const file = pluginIconInput.files?.[0];
    const target = pendingIconTarget;
    pendingIconTarget = null;
    if (!file || !target) return;
    try {
      if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
      if (file.size > 1024 * 1024) throw new Error("图标不能超过 1 MB");
      const icon = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图标失败"));
        reader.readAsDataURL(file);
      });
      if (target.kind === "nav") {
        setNavOverride(target.id, { icon });
        refreshCorePresentation();
        toast("图标已更新");
      } else {
        setPluginOverride(target.id, { icon });
        refreshPluginPresentation();
        toast("插件图标已更新");
      }
    } catch (error) {
      toast(`修改图标失败：${error.message || error}`);
    } finally {
      pluginIconInput.value = "";
    }
  });

  function closeContextMenu(immediate = false) {
    const menu = contextMenu;
    contextMenu = null;
    if (!menu) return;
    if (immediate) menu.remove();
    else removeWithMotion(menu);
  }

  const contextMenuItem = (label, onClick, { danger = false, disabled = false, title = "" } = {}) => el("button", {
    class: `plugin-context-item${danger ? " danger" : ""}`,
    type: "button",
    disabled: disabled ? true : null,
    title: title || null,
    onclick: async () => {
      if (disabled) return;
      closeContextMenu();
      await onClick();
    },
  }, label);

  // 调用前由各 open*ContextMenu 自己 preventDefault（查不到目标时要提前返回，
  // 那时不该把原生右键菜单一起吞掉）
  function showContextMenu(event, menu) {
    closeContextMenu(true);
    document.body.append(menu);
    contextMenu = menu;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8 - bottomInsetPx()))}px`;
    requestAnimationFrame(() => menu.querySelector("button:not(:disabled)")?.focus());
  }

  // 改色即吸附：先按改色前的显示顺序取一份完整排列 → 写色 → 按新颜色吸附成连续段 → 刷侧栏与插件中心。
  // 落库的永远是「当前有视图的插件 ID 的一个完整排列」。以显示顺序为底（而不是 pluginOrder
  // 再按注册顺序补尾）：没拖过序的插件是按标题排的，按注册顺序补尾会让它们因为别人上色而整体洗牌。
  function applyPluginColor(pluginId, colorId) {
    const next = isGroupColor(colorId) ? colorId : "";
    if (pluginColor(pluginId) === next) return;
    const order = currentPluginOrder();
    setPluginColor(pluginId, next);
    S.getState().settings.pluginOrder = normalizePluginOrder(order, pluginColor);
    S.persistSoon();
    refreshPluginGroups();
    const rec = getRegistry().find((item) => item.id === pluginId);
    const name = pluginDisplayName(pluginId, rec?.manifest?.name || pluginViews.find((pv) => pv.pluginId === pluginId)?.title || pluginId);
    toast(next ? `「${name}」已归入「${groupName(next)}」` : `「${name}」已移出分组`);
  }

  function openPluginContextMenu(event, pluginId) {
    event.preventDefault();
    event.stopPropagation();
    const rec = getRegistry().find((item) => item.id === pluginId);
    if (!rec) return;
    const fallbackName = rec.manifest?.name || pluginViews.find((item) => item.pluginId === pluginId)?.title || pluginId;
    const displayName = pluginDisplayName(pluginId, fallbackName);
    const override = getPluginOverride(pluginId);
    const effSc = effectiveShortcutLetter(pluginId);
    const currentColor = pluginColor(pluginId);
    const menu = el("div", { class: "plugin-context-menu", role: "menu", "aria-label": `${displayName}插件菜单` },
      el("div", { class: "plugin-context-head" }, pluginDisplayIcon(pluginId, displayName), el("span", {}, el("b", {}, displayName), el("small", {}, rec.source === "builtin" ? "内置插件" : "用户插件"))),
      contextMenuItem("重命名", async () => {
        const value = await appPrompt("重命名插件", { label: "输入插件显示名称（留空恢复默认名称）", value: displayName, confirmText: "保存" });
        if (value === null) return;
        setPluginOverride(pluginId, { name: value });
        refreshPluginPresentation();
        toast(value ? "插件名称已更新" : "已恢复默认名称");
      }),
      contextMenuItem("修改图标…", () => {
        pendingIconTarget = { kind: "plugin", id: pluginId };
        pluginIconInput.click();
      }),
      el("div", { class: "plugin-color-row", role: "group", "aria-label": "分组颜色" },
        ...GROUP_COLORS.map((color) => el("button", {
          class: `plugin-color-dot${currentColor === color.id ? " on" : ""}`,
          type: "button",
          style: `--gc:${color.hex}`,
          title: currentColor === color.id ? `取消${color.label}分组` : `归入${color.label}组`,
          "aria-label": color.label,
          "aria-pressed": String(currentColor === color.id),
          onclick: () => { closeContextMenu(); applyPluginColor(pluginId, currentColor === color.id ? "" : color.id); },
        })),
        el("button", {
          class: `plugin-color-dot none${!currentColor ? " on" : ""}`,
          type: "button",
          title: "不分组",
          "aria-label": "不分组",
          "aria-pressed": String(!currentColor),
          onclick: () => { closeContextMenu(); applyPluginColor(pluginId, ""); },
        }),
      ),
      contextMenuItem(`分组名称 · ${currentColor ? groupName(currentColor) : "未分组"}`, async () => {
        if (!currentColor) return;
        const value = await appPrompt("重命名分组", {
          label: `这张${groupColorMeta(currentColor).label}卡片的名称（留空恢复默认）`,
          value: groupName(currentColor),
          confirmText: "保存",
        });
        if (value === null) return;
        renameGroup(currentColor, value);
        refreshPluginGroups();
        toast(value.trim() ? "分组名称已更新" : "已恢复默认组名");
      }, { disabled: !currentColor }),
      contextMenuItem(`快捷键 · ${effSc ? `${PLUGIN_SHORTCUT_MODIFIER}+${effSc}` : "未设置"}`, async () => {
        const value = await appPrompt("设置插件快捷键", {
          label: `输入一个字母（A–Z），按 ${PLUGIN_SHORTCUT_MODIFIER} + 字母直接打开「${displayName}」。留空恢复自动分配（按插件 ID 首字母，先到先得）。`,
          value: getPluginShortcutCustoms()[pluginId] || effSc || "",
          confirmText: "保存",
        });
        if (value === null) return;
        const wanted = normalizeShortcutLetter(value);
        setPluginShortcut(pluginId, value);
        renderNav();
        const nowSc = effectiveShortcutLetter(pluginId);
        if (wanted && wanted !== nowSc) {
          // 想要的字母被别的插件占了（显式指定之间也是先到先得）
          const holder = [...effectiveShortcutMap()].find(([, info]) => info.letter === wanted)?.[0];
          toast(`Alt+${wanted} 已被「${pluginDisplayName(holder, holder)}」占用，本插件生效 ${nowSc ? `Alt+${nowSc}` : "无"}`);
        } else if (wanted) {
          toast(`快捷键 Alt+${wanted} 已保存`);
        } else {
          toast("已清除，恢复自动分配");
        }
      }),
      contextMenuItem("恢复默认名称与图标", () => {
        // 只清名称和图标：分组色是「你在哪个组」而不是「你长什么样」，不该被顺手抹掉
        setPluginOverride(pluginId, { name: "", icon: "" });
        refreshPluginPresentation();
        toast("已恢复插件默认外观");
      }, { disabled: !(override.name || override.icon) }),
      el("div", { class: "plugin-context-separator", role: "separator" }),
      contextMenuItem("导入插件…", () => pluginZipInput.click()),
      contextMenuItem("删除插件", async () => {
        if (!(await appConfirm(`删除用户插件「${displayName}」？`, "插件文件夹和保存状态将一并移除。", { confirmText: "删除", danger: true }))) return;
        try {
          await removeExternalPlugin(pluginId);
          resetPluginOverride(pluginId);
          toast(`已删除「${displayName}」`);
        } catch (error) {
          toast(`删除失败：${error.message || error}`);
        }
      }, { danger: true, disabled: rec.source === "builtin", title: rec.source === "builtin" ? "内置插件不能删除，可在插件中心关闭" : "" }),
    );
    showContextMenu(event, menu);
  }

  /* 核心页（任务表 / 时间块 / 收件箱 / 插件 / 时间线）的右键菜单。
     与插件菜单同形同风格，但只有外观三项 —— 快捷键、导入、删除都是插件独有的概念。 */
  function openNavContextMenu(event, viewId) {
    event.preventDefault();
    event.stopPropagation();
    const def = viewDef(viewId);
    if (!def) return;
    const menu = el("div", { class: "plugin-context-menu", role: "menu", "aria-label": `${def.title}页面菜单` },
      el("div", { class: "plugin-context-head" }, navDisplayIcon(viewId, def.title), el("span", {}, el("b", {}, def.title), el("small", {}, "核心页面"))),
      contextMenuItem("重命名", async () => {
        const value = await appPrompt("重命名页面", { label: "输入侧栏与标题栏显示的名称（留空恢复默认名称）", value: def.title, confirmText: "保存" });
        if (value === null) return;
        setNavOverride(viewId, { name: value });
        refreshCorePresentation();
        toast(value ? "页面名称已更新" : "已恢复默认名称");
      }),
      contextMenuItem("修改图标…", () => {
        pendingIconTarget = { kind: "nav", id: viewId };
        pluginIconInput.click();
      }),
      contextMenuItem("恢复默认名称与图标", () => {
        resetNavOverride(viewId);
        refreshCorePresentation();
        toast("已恢复页面默认外观");
      }, { disabled: !hasNavOverride(viewId) }),
    );
    showContextMenu(event, menu);
  }

  document.addEventListener("pointerdown", (event) => {
    if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu();
  }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeContextMenu(); });

  function renderNav() {
    nav.replaceChildren();
    // v0.52.0：导航按平台清单渲染（APK 端 = 四象限 / 时间线 / 插件）
    for (const id of coreViewIds()) nav.append(navBtn(id));
    if (!pluginViews.length) return;
    // 桌面端侧栏仍保留插件直达列表；移动端底栏只留核心入口（.plug-list 被隐藏）
    const box = el("div", { class: "plug-list" },
      el("div", { class: "sec plug-list-sec" },
        el("span", {}, "插 件 视 图"),
        desktopWindow ? el("small", {}, "上下拖动排序") : null,
      ),
    );
    // 一个插件可以注册多个视图（cppu-notify 就有通知 / 一卡通 / 教务四视图共 6 个）。
    // 颜色与顺序都是插件级的：先按插件归拢，它的视图整串跟着插件走，一个都不能丢。
    const viewsOf = new Map();
    for (const pv of orderedPluginViews()) {
      if (!viewsOf.has(pv.pluginId)) viewsOf.set(pv.pluginId, []);
      viewsOf.get(pv.pluginId).push(pv);
    }
    // 改色时已经把同色吸附成连续段（normalizePluginOrder），这里再归一次兜底：
    // 别的设备同步过来的顺序可能还没吸附。
    const runs = groupRuns(normalizePluginOrder([...viewsOf.keys()], pluginColor), pluginColor);
    runs.forEach(({ color, ids }, index) => {
      const views = ids.flatMap((id) => viewsOf.get(id) || []);
      if (!views.length) return;
      box.append(color
        ? plugGroupNode(color, views, { first: index === 0, last: index === runs.length - 1 })
        : plugSegNode(views));
    });
    nav.append(box);
  }

  /* 一段可拖拽容器：直接子节点必须正好是插件按钮 —— attachPluginListDrag 的落点
     推演按「等高连续兄弟」累加高度，中间插进组头就会整体偏移。所以组头挂在容器外。
     跨段（跨卡片）拖动不支持，换组走右键改色。 */
  function plugSegNode(views) {
    const seg = el("div", { class: "plug-seg" }, views.map((pv) => navBtn(`plug:${pv.id}`, true)));
    if (desktopWindow && views.length > 1) {
      attachPluginListDrag(seg, () => saveSegmentOrder(
        [...seg.querySelectorAll(":scope > button[data-plugin-id]")].map((node) => node.dataset.pluginId),
      ));
    }
    return seg;
  }

  // 段内新顺序写回全局顺序：只回填这一段占着的那几个格子，别的段原地不动。
  // 同一插件的多个视图各有一个按钮（data-plugin-id 相同），先按首次出现去重 ——
  // 否则回填时重复 ID 会占掉别人的格子，把别的插件挤出排列。
  function saveSegmentOrder(domIds) {
    const ids = [...new Set(domIds)];
    const full = currentPluginOrder();
    const slots = new Set(ids);
    let at = 0;
    S.getState().settings.pluginOrder = full.map((id) => (slots.has(id) ? ids[at++] : id));
    S.persistSoon();
    repaintMarket?.();
    // 多视图插件被拖散（它的两个视图之间插进了别的插件）：落位动画播完再按插件归拢一次
    if (domIds.filter((id, i) => id !== domIds[i - 1]).length > ids.length) setTimeout(() => flipNav(renderNav), 260);
    toast("插件顺序已保存，并会随同步快照一起同步");
  }

  /* 一张颜色卡片 = 组头（折叠钮 + 整组 ↑/↓）+ 成员段。收起时成员段不渲染。
     收起 / 展开由 foldNavGroup 就地增删成员段并做高度动画，不整段重绘 —— 箭头的 CSS 过渡才接得上。 */
  function plugGroupNode(color, views, { first = false, last = false } = {}) {
    const collapsed = isGroupCollapsed(color);
    const hasOn = views.some((pv) => activeView === `plug:${pv.id}`);
    const group = el("div", {
      class: `plug-group${collapsed ? " collapsed" : ""}${hasOn ? " has-on" : ""}`,
      "data-color": color,
      role: "group",
      "aria-label": groupName(color),
      style: `--gc:${groupColorMeta(color).hex}`,
    },
      el("div", { class: "plug-group-head" },
        groupFoldButton("plug-group", color, views.length, collapsed, () => toggleNavGroup(group, color)),
        desktopWindow ? el("span", { class: "plug-group-tools" },
          groupMoveButton(color, -1, first),
          groupMoveButton(color, 1, last),
        ) : null,
      ),
      collapsed ? null : plugSegNode(views),
    );
    group._views = views;
    return group;
  }

  // 侧栏组头与插件中心组头共用的折叠钮：箭头 + 色点 + 组名 + 成员数。
  // 箭头固定用 chevron-down，收起态由 CSS 转 -90°（带过渡），不再整颗换图标。
  // data-motion="off"：退出全局按钮反馈。标题里带「收起」会被 motion.js 认成关闭钮，
  // 松手时播 rotate(3deg) 的关闭回弹；插件中心的折叠钮是整行宽，一转两端就歪出去二十多像素，
  // 按下的 scale(.965) 也会让整条缩一截。收放的反馈交给箭头旋转与内容动画。
  function groupFoldButton(prefix, color, count, collapsed, onToggle) {
    const name = groupName(color);
    return el("button", {
      class: `${prefix}-fold`,
      type: "button",
      "data-motion": "off",
      title: `${collapsed ? "展开" : "收起"}「${name}」`,
      "aria-expanded": String(!collapsed),
      onclick: onToggle,
    },
      el("span", { class: "fold-chev", "aria-hidden": "true" }, faIcon("chevron-down")),
      el("span", { class: "group-dot", "aria-hidden": "true" }),
      el(prefix === "market-group" ? "b" : "span", { class: `${prefix}-name` }, name),
      el("span", { class: `${prefix}-count` }, String(count)),
    );
  }

  // 整组 ↑/↓：到顶 / 到底直接置灰，不必点了才弹「没有可换位的插件段」
  function groupMoveButton(color, delta, atEdge) {
    const label = delta < 0 ? "整组上移" : "整组下移";
    return el("button", {
      class: "plug-group-move",
      type: "button",
      "data-dir": String(delta),
      title: label,
      "aria-label": label,
      disabled: atEdge ? true : null,
      onclick: () => moveNavGroup(color, delta),
    }, faIcon(delta < 0 ? "arrow-up" : "arrow-down"));
  }

  function moveNavGroup(color, delta) {
    const full = currentPluginOrder();
    const next = moveGroupInOrder(full, color, delta, pluginColor);
    if (next.join(" ") === full.join(" ")) {
      toast(delta > 0 ? "下面没有可换位的插件段" : "上面没有可换位的插件段");
      return;
    }
    const hadFocus = nav.contains(document.activeElement);
    S.getState().settings.pluginOrder = next;
    S.persistSoon();
    refreshPluginGroups();
    if (!hadFocus) return;
    // 整段重绘换掉了按钮节点：焦点还给同一组的同向按钮（到边了就给折叠钮），键盘连按 ↑/↓ 不断档
    const group = nav.querySelector(`.plug-group[data-color="${color}"]`);
    const again = group?.querySelector(`.plug-group-move[data-dir="${delta}"]`);
    (again && !again.disabled ? again : group?.querySelector(".plug-group-fold"))?.focus({ preventScroll: true });
  }

  // 侧栏组的收起 / 展开：先落状态，再就地收放；插件中心若挂着就跟着一起收放。
  function toggleNavGroup(group, color) {
    if (group.dataset.folding) return; // 动画进行中的第二下忽略，免得成员段被重复挂载
    const collapsed = toggleGroupCollapsed(color);
    foldNavGroup(group, color, collapsed);
    repaintMarket?.({ fold: { color, collapsed } });
  }

  // 只动 DOM、不碰状态：侧栏自己点、插件中心点，都走这里把侧栏那张卡片收放到位。
  function foldNavGroup(group, color, collapsed) {
    if (!group?.isConnected || group.classList.contains("collapsed") === collapsed) return;
    if (group.dataset.folding) {
      flipNav(renderNav); // 上一次收放还没播完就又反向：直接按最新状态重绘，不叠两段动画
      return;
    }
    group.classList.toggle("collapsed", collapsed);
    const fold = group.querySelector(".plug-group-fold");
    if (fold) {
      fold.title = `${collapsed ? "展开" : "收起"}「${groupName(color)}」`;
      fold.setAttribute("aria-expanded", String(!collapsed));
    }
    group.dataset.folding = "1";
    const done = () => { delete group.dataset.folding; };
    if (collapsed) {
      const seg = group.querySelector(":scope > .plug-seg");
      if (!seg) return done();
      foldClose(seg).then(() => { seg.remove(); done(); });
      return;
    }
    const seg = plugSegNode(group._views || []);
    group.append(seg);
    foldOpen(seg).then(done);
  }
  function navBtn(id, isPlug = false) {
    const def = viewDef(id);
    if (!def) return null;
    // 插件市场高亮条件：在市场页或任何插件页里（插件从市场进入）
    const on = activeView === id || (id === "market" && activeView.startsWith("plug:"));
    // 生效的 Alt 字母快捷键（显式指定优先，否则按插件 ID 首字母自动分配，先到先得）
    const sc = isPlug && def.pluginView?.pluginId ? effectiveShortcutLetter(def.pluginView.pluginId) : "";
    // 插件导航条右侧的来源标签：内置 → 「内置」，用户导入 → 「导入」；
    // 兜底（registry 还没建好等异常态）回落到「插件」，保持原有文案。
    let pvLabel = "插件";
    if (isPlug) {
      const pid = def.pluginView?.pluginId;
      const rec = pid && getRegistry().find((r) => r.id === pid);
      if (rec) pvLabel = rec.source === "builtin" ? "内置" : "导入";
    }
    const b = el("button", { class: on ? "on" : "", "data-view": id },
      el("span", { class: "ic", style: isPlug ? `--plugin-accent:${pluginAccent(def.pluginView?.pluginId)}` : null }, isPlug ? pluginDisplayIcon(def.pluginView.pluginId, def.title) : navDisplayIcon(id, def.title)),
      el("span", { class: "lb" }, def.title),
      isPlug ? el("span", { class: "pv-count" }, pvLabel) : null,
      // 快捷键徽标：平时收着（opacity:0），悬停 / 选中 / 键盘聚焦时现形，不挤占常驻空间
      sc ? el("kbd", { class: "nav-kbd", "aria-hidden": "true" }, `${PLUGIN_SHORTCUT_MODIFIER}+${sc}`) : null,
    );
    b.addEventListener("click", () => switchTo(id));
    // 核心页与插件项一样可右键改外观。窄屏是底栏、没有右键语义，
    // 所以与插件菜单同样只在桌面窗口开放（见下面插件分支的 desktopWindow 条件）。
    if (desktopWindow && !isPlug) {
      b.title = "右键可重命名、更换图标";
      b.addEventListener("contextmenu", (event) => openNavContextMenu(event, id));
    }
    if (desktopWindow && isPlug && def.pluginView?.pluginId) {
      b.dataset.pluginId = def.pluginView.pluginId;
      b.title = `${def.title} · ${sc ? `快捷键 ${PLUGIN_SHORTCUT_MODIFIER}+${sc} · ` : ""}拖动或 Alt+↑/↓ 调整插件顺序`;
      b.addEventListener("contextmenu", (event) => openPluginContextMenu(event, def.pluginView.pluginId));
    }
    return b;
  }

  // ── v0.53.0：操作条动作注册 ──
  // 「后续添加按钮的接口」就是 registerRailAction —— 新增按钮不必再改 shell 的建 DOM
  // 代码，调一次即可（图标给一个返回节点的函数，onMount 用于需要自己订阅刷新的场景）。

  // 深浅色切换：与设置 › 主题的切换共用同一条动画路径
  //（setThemeMode → applyTheme → runThemeMutation → View Transitions 圆形揭示）。
  // 点击位置由 theme.js 的全局 pointerdown 监听自动记录为 lastPointer，
  // 所以圆形从按钮位置向外扩散 —— 与设置页点按钮的动画完全一致。
  // 字形走上方 themeModeGlyph()（浅色=太阳、深色=月亮），用 MutationObserver 驱
  // data-theme-mode 刷新，覆盖「跟随系统」时系统亮暗翻转。
  registerRailAction({
    id: "theme-toggle",
    label: "切换深浅模式",
    className: "theme-toggle-btn",
    icon: () => faIcon(themeModeGlyph()),
    onMount: (btn) => {
      const update = () => {
        const dark = resolveThemeMode() === "dark";
        btn.replaceChildren(el("span", { class: "ic" }, faIcon(themeModeGlyph())));
        btn.title = dark ? "切换到浅色模式" : "切换到深色模式";
      };
      update(); // 首次同步（icon() 已给过图标，这里顺手把 title 也写对）
      new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-mode"] });
    },
    onClick: () => {
      const next = resolveThemeMode() === "dark" ? "light" : "dark";
      setThemeMode(next, { animate: true });
      toast(`已切换为${next === "dark" ? "深色" : "浅色"}模式`);
      // 图标刷新由 onMount 里的 MutationObserver 驱动，不需要手动调
    },
  });

  registerRailAction({
    id: "settings",
    label: "设置",
    icon: () => appIcon("settings"),
    onClick: () => openSettingsModal(),
  });

  // v0.69.0：缩放视图 —— 按下后窗口收成 FOCUS_WINDOW_SIZE 并居中，再按回到按之前的
  // 尺寸和位置（实现与「为什么只存内存」的说明见 windowSize.js::toggleFocusWindow）。
  // 只在桌面端注册：Android / 浏览器里调窗口尺寸没有意义。
  if (desktopWindow) {
    const paintWindowFocus = (btn) => {
      const active = isFocusWindowActive();
      btn.replaceChildren(el("span", { class: "ic" }, faIcon(active ? "expand" : "compress")));
      btn.title = active ? "还原窗口的大小和位置" : `窗口居中并收成 ${FOCUS_WINDOW_SIZE.width} × ${FOCUS_WINDOW_SIZE.height}`;
      btn.classList.toggle("on", active);
      btn.setAttribute("aria-pressed", String(active));
    };
    registerRailAction({
      id: "window-focus",
      label: "缩放视图",
      className: "window-focus-btn",
      icon: () => faIcon(isFocusWindowActive() ? "expand" : "compress"),
      onMount: paintWindowFocus,
      onClick: async (event, btn) => {
        const result = await toggleFocusWindow();
        if (!result.applied) {
          toast(`窗口大小调整失败（${result.reason}）`);
          return;
        }
        paintWindowFocus(btn);
        toast(result.mode === "focus"
          ? `窗口已收成 ${result.width} × ${result.height} 并居中，再按一次还原`
          : "已还原到之前的窗口大小和位置");
      },
    });
  }

  // 顺序状态：settings.railActionOrder（与 settings.topbarOrder 同构）。
  // 归一化只保留仍注册着的 id，未记录的按注册顺序补到尾部 ⇒ 新增按钮自动出现在末尾。
  function railActionOrderState() {
    const settings = S.getState().settings;
    settings.railActionOrder = normalizeRailActionOrder(settings.railActionOrder);
    return settings.railActionOrder;
  }

  function buildRailButton(def) {
    const btn = el("button", {
      class: `settings-icon-button rail-dock-btn${def.className ? ` ${def.className}` : ""}`,
      type: "button",
      title: def.title || def.label || def.id,
      "aria-label": def.label || def.title || def.id,
      "data-rail-id": def.id,
    });
    const ic = el("span", { class: "ic" });
    const node = def.icon?.();
    if (node) ic.append(node);
    btn.append(ic);
    if (def.onClick) btn.addEventListener("click", (event) => def.onClick(event, btn));
    def.onMount?.(btn);
    return btn;
  }

  // ⚠️ 必须**复用已有节点**（append 移动）而不是 replaceChildren 重建：
  // theme-toggle 的 MutationObserver 挂在 documentElement 上、闭包持有按钮引用，
  // 每次重建都会多留一个 observer 指向已被移除的按钮（键盘重排会反复触发重建）。
  function renderRailDock() {
    const byId = new Map(listRailActions().map((def) => [def.id, def]));
    const existing = new Map([...railDock.children].map((b) => [b.dataset.railId, b]));
    const nodes = railActionOrderState()
      .map((id) => existing.get(id) || (byId.has(id) ? buildRailButton(byId.get(id)) : null))
      .filter(Boolean);
    for (const child of [...railDock.children]) if (!nodes.includes(child)) child.remove();
    railDock.append(...nodes); // 已在容器里的节点会先被移出再追加 ⇒ 最终顺序 = nodes 顺序
    settingsDockBtn = railDock.querySelector('[data-rail-id="settings"]');
  }
  renderRailDock();

  attachRailDockDrag(railDock, () => {
    // 落库：DOM 序就是用户拖出的序。走 normalize 而不是直接赋值 ——
    // 归一化保证落库的永远是「当前注册表的一个完整排列」（不多不少不重复）。
    S.getState().settings.railActionOrder = normalizeRailActionOrder(
      [...railDock.querySelectorAll(".rail-dock-btn")].map((b) => b.dataset.railId),
    );
    S.persistSoon();
  });

  // Alt+←/→ 键盘重排由 toolbarDrag 共享实现：同样平滑让位，并沿用上面的持久化回调。

  // 标题卡小框的图标跟随当前视图：插件页 → 插件自己的图标（含用户自定义覆盖），
  // 核心页 → 该视图的导航图标。图标由 pluginDisplayIcon/appIcon 每次新建，直接替换子节点即可。
  function renderTitleMark(def) {
    titleMark.replaceChildren();
    if (!def) return;
    if (def.pluginView?.pluginId) {
      titleMark.style.setProperty("--plugin-accent", pluginAccent(def.pluginView.pluginId));
      titleMark.append(pluginDisplayIcon(def.pluginView.pluginId, def.title));
    } else {
      titleMark.style.removeProperty("--plugin-accent");
      titleMark.append(navDisplayIcon(def.id, def.title));
    }
  }

  function renderStat() {
    const t = S.getState().tasks;
    const open = t.filter((x) => !x.done).length;
    statPill.replaceChildren("待办 ", el("b", {}, String(open)), " · 已完成 ", el("b", {}, String(t.length - open)));
  }

  async function withCurrentWindow(run, fallbackMessage = "当前环境不支持窗口控制") {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      return await run(getCurrentWindow());
    } catch (err) {
      toast(fallbackMessage);
      return null;
    }
  }

  function openSettingsModal(section = "") {
    const target = arguments[1] || "";
    // v0.59.0：设置是底栏呼出态唯一的「让位」出口 —— 弹窗要占满屏，菜单先收回去。
    // 桌面宽屏下 .chrome-shown 无视觉效果，仍然门槛一下，免得 ⋮ 的 title 被无关路径改掉。
    // 这一让不是单程的：close() 里按 railShownBeforeSettings 恢复（点 ⋮ 呼出后再进设置，
    // 退出设置就该还是呼出态，不该逼用户再点一次 ⋮）。
    if (settingsLayers === 0) railShownBeforeSettings = chromeShown;
    settingsLayers += 1;
    if (chromeShown && mobileQuery.matches) setChromeShown(false);
    document.querySelector(".settings-modal")?._close?.();
    const mask = el("div", { class: "drawer-mask settings-modal-mask", onclick: close });
    const panel = el("section", { class: "settings-modal", role: "dialog", "aria-modal": "true", "aria-label": "设置" },
      el("header", { class: "settings-modal-head", "data-tauri-drag-region": dragRegion },
        el("div", {},
          el("h2", {}, "设置"),
          el("p", { class: "desc" }, "界面、提醒、数据与扩展"),
        ),
        el("button", { class: "btn ghost sm", type: "button", onclick: close }, "关闭"),
      ),
      el("div", { class: "settings-modal-body" }),
    );
    function onKey(event) { if (event.key === "Escape") close(); }
    // 幂等：点遮罩关掉后，重开设置那句 `._close?.()` 还会再敲一次同一个面板。
    let dismissed = false;
    function close() {
      if (dismissed) return;
      dismissed = true;
      closeLayer(panel, mask, () => document.removeEventListener("keydown", onKey));
      settingsLayers = Math.max(0, settingsLayers - 1);
      if (settingsLayers === 0 && railShownBeforeSettings && mobileQuery.matches) {
        railShownBeforeSettings = false;
        setChromeShown(true);
      }
    }
    panel._close = close;
    document.addEventListener("keydown", onKey);
    document.body.append(mask, panel);
    renderSettings(panel.querySelector(".settings-modal-body"), { section, target });
  }

  function updateQuickDockToggle() {
    const open = !quickDockState.collapsed;
    quickDockToggle.classList.toggle("on", open);
    quickDockToggle.setAttribute("aria-expanded", String(open));
    quickDockToggle.title = open ? "收起快捷入口" : "展开快捷入口";
  }

  function positionQuickDock(node, left = quickDockState.left, top = quickDockState.top) {
    const rect = node.getBoundingClientRect();
    const margin = window.innerWidth <= 760 ? 12 : 20;
    const safeTop = window.innerWidth <= 760 ? 72 : 84;
    const width = rect.width || 152;
    const height = rect.height || 320;
    let x = Number.isFinite(left) ? left : (window.innerWidth - width - 22);
    let y = Number.isFinite(top) ? top : 92;
    x = Math.min(window.innerWidth - width - margin, Math.max(margin, x));
    // v0.58.2：底部钳制叠加三键导航栏高度（--sab），否则拖到最底时面板被导航栏压住
    y = Math.min(window.innerHeight - height - margin - bottomInsetPx(), Math.max(safeTop, y));
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    quickDockState.left = x;
    quickDockState.top = y;
  }

  function bindQuickDockDrag(node, handle) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      positionQuickDock(node, baseX + ev.clientX - startX, baseY + ev.clientY - startY);
      ev.preventDefault();
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pointerId) return;
      pointerId = null;
      node.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      S.persistSoon();
    };
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = node.getBoundingClientRect();
      baseX = rect.left;
      baseY = rect.top;
      node.classList.add("dragging");
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
      ev.preventDefault();
    });
  }

  function updatePinButtonState() {
    if (!pinActionBtn) return;
    pinActionBtn.classList.toggle("on", !!quickDockState.alwaysOnTop);
    pinActionBtn.setAttribute("aria-pressed", String(!!quickDockState.alwaysOnTop));
  }

  async function syncWindowPinState() {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      quickDockState.alwaysOnTop = await getCurrentWindow().isAlwaysOnTop();
      updatePinButtonState();
    } catch {}
  }

  // 顶栏组件可拖动换位 → 面板每次展开都重新贴着触发按钮定位，而不是固定在屏幕右侧
  function positionQuickDockNear(node) {
    if (!quickDock) return;
    const rect = node.getBoundingClientRect();
    const box = quickDock.getBoundingClientRect();
    const margin = 12;
    const width = box.width || 292;
    const height = box.height || 320;
    let x = rect.left;
    let y = rect.bottom + 8;
    x = Math.min(window.innerWidth - width - margin, Math.max(margin, x));
    y = Math.min(window.innerHeight - height - margin - bottomInsetPx(), Math.max(margin, y));
    quickDock.style.left = `${x}px`;
    quickDock.style.top = `${y}px`;
    quickDock.style.right = "auto";
    quickDockState.left = x;
    quickDockState.top = y;
  }

  function toggleQuickDock(force) {
    quickDockState.collapsed = typeof force === "boolean" ? force : !quickDockState.collapsed;
    if (quickDock) {
      quickDock.classList.toggle("collapsed", quickDockState.collapsed);
      if (!quickDockState.collapsed) positionQuickDockNear(quickDockToggle);
    }
    updateQuickDockToggle();
    S.persistSoon();
  }

  // 快捷菜单图标：用打包内自带的 Font Awesome solid（插件同款根路径），别再回退成汉字/ASCII
  function faIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "fa-ic");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `/icons/fontawesome/solid.svg#${name}`);
    svg.append(use);
    return svg;
  }

  function createQuickDockButton(iconName, label, handler, extraClass = "") {
    return el("button", {
      class: `quick-dock-btn${extraClass ? ` ${extraClass}` : ""}`,
      type: "button",
      title: label,
      "aria-label": label,
      role: "menuitem",
      onclick: async () => {
        await handler();
        if (!quickDockState.collapsed) toggleQuickDock(true);
      },
    },
      el("span", { class: "quick-dock-glyph" }, faIcon(iconName)),
      el("small", {}, label),
    );
  }

  function mountQuickDock() {
    quickDock?.remove();
    quickDockState.collapsed = true;
    const dock = el("div", { class: "quick-dock collapsed", role: "menu", "aria-label": "快捷入口" },
      el("div", { class: "quick-dock-head" },
        el("span", { class: "quick-menu-avatar", "aria-hidden": "true" }, "YL"),
        el("div", { class: "quick-dock-title" }, el("b", {}, "Yile Liang"), el("small", {}, "Plus")),
      ),
      el("div", { class: "quick-dock-grid" },
        createQuickDockButton("plus", "快速新建", () => openQuickCapture()),
        createQuickDockButton("magnifying-glass", "命令搜索", () => window.dispatchEvent(new CustomEvent("tide:command-palette"))),
        createQuickDockButton("table-cells", "任务表", () => switchTo("quadrant")),
        // v0.52.0：快捷菜单跟随平台 —— APK 端给时间线（fa 精灵图 id="timeline"），
        // 桌面端保留时间块 / 收件箱直达（桌面没有时间线入口）。
        ...(desktopWindow ? [
          createQuickDockButton("clock", "时间块", () => switchTo("timeblock")),
          createQuickDockButton("inbox", "收件箱", () => switchTo("inbox")),
        ] : [
          createQuickDockButton("timeline", "时间线", () => switchTo("timeline")),
        ]),
        createQuickDockButton("puzzle-piece", "插件中心", () => switchTo("market")),
        createQuickDockButton("gear", "设置", () => openSettingsModal()),
        desktopWindow ? (pinActionBtn = createQuickDockButton("thumbtack", "窗口置顶", async () => {
          await withCurrentWindow(async (win) => {
            const next = !(await win.isAlwaysOnTop());
            await win.setAlwaysOnTop(next);
            quickDockState.alwaysOnTop = next;
            updatePinButtonState();
            S.persistSoon();
            toast(next ? "已置顶窗口" : "已取消置顶");
          });
        }, "pin")) : null,
        desktopWindow ? createQuickDockButton("minus", "最小化", () => withCurrentWindow((win) => win.minimize())) : null,
        desktopWindow ? createQuickDockButton("xmark", "关闭", () => withCurrentWindow((win) => win.close())) : null,
      ),
    );
    quickDock = dock;
    root.append(dock);
    updateQuickDockToggle();
    updatePinButtonState();
    const closeOnOutside = (event) => {
      if (quickDockState.collapsed) return;
      if (dock.contains(event.target) || quickDockToggle.contains(event.target)) return;
      toggleQuickDock(true);
    };
    document.addEventListener("pointerdown", closeOnOutside, true);
    syncWindowPinState();
  }

  // 返回按钮只在「确实有地方可回」时出现：首页且无浮层时它会出现但点了等于退出应用，
  // 那种情况不给按钮（与 Android 返回键的语义保持一致，见 backNav.js 的不变量）。
  // v0.52.0：悬浮小返回键（.mobile-back）与顶栏返回键读同一份 canGoBack() ——
  // 上下栏收起时顶栏不可见，悬浮键就是每一页的返回入口（需求：「每一页都添加返回按钮」）。
  function syncBackButton() {
    const show = canGoBack();
    backBtn.classList.toggle("show", show);
    mobileBack.classList.toggle("show", show);
  }

  // v0.52.0：沉浸式外壳开关。只切 .app 上的 .chrome-shown 类，CSS 在 ≤900px 媒体块里
  // 消费它（桌面宽屏下类挂着也没任何视觉效果）。v0.59.0 起它只控制底栏显隐（顶栏已移除），
  // 且只有三处调用者：⋮ 自己切换、openSettingsModal 收回、设置关掉时按进入前的状态恢复。
  // v0.58.2 追加：底栏呼出/收起动画。收起态是 display:none，过渡跟不上 ⇒ 真正摘
  // .chrome-shown 之前先挂 .rail-hiding 顶住显示、播 CSS 的 rail-dock-out 滑出动画
  //（forwards 停在屏下），超时兜底摘类；呼出/快速连点都先摘 rail-hiding 再挂呼出态。
  // reducedMotion()（用户「减少动效」设置或系统偏好）为真时直接摘类，跳过动画。
  let railHideTimer = 0;
  const RAIL_HIDE_ANIM_MS = 220; // CSS rail-dock-out .18s + 事件/帧余量
  function setChromeShown(show) {
    if (railHideTimer) { clearTimeout(railHideTimer); railHideTimer = 0; }
    appFrame.classList.remove("rail-hiding");
    const wasShown = chromeShown;
    chromeShown = show;
    if (!show && wasShown && mobileQuery.matches && !reducedMotion()) {
      appFrame.classList.add("rail-hiding");
      railHideTimer = setTimeout(() => {
        appFrame.classList.remove("rail-hiding");
        railHideTimer = 0;
      }, RAIL_HIDE_ANIM_MS);
    }
    appFrame.classList.toggle("chrome-shown", show);
    chromeToggle.setAttribute("aria-expanded", String(show));
    chromeToggle.title = show ? "收起菜单" : "显示菜单";
  }
  // v0.108.0：呼出态点空白即收起。此前底栏只跟着「再按 ⋮ / 打开设置」消失，用户
  // 点内容区没有任何反馈，还得再找那颗 ⋮ —— 与 Android「弹出的面板，点外部即收」
  // 的肌肉记忆相悖。捕获阶段监听 pointerdown：不 preventDefault、不 stopPropagation，
  // 收起与「点到的那个控件照常工作」同时发生（收起绝不抢点击）。两颗悬浮键本身排除：
  // ⋮ 自带 toggle onclick（排除避免先收起再被点击重新呼出），‹ 是返回（返回后底栏
  // 保留是既有语义）。
  document.addEventListener("pointerdown", (e) => {
    if (!chromeShown || !mobileQuery.matches) return;
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".rail, .chrome-toggle, .mobile-back")) return;
    setChromeShown(false);
  }, true);
  // v0.108.0：软键盘让路。输入框/可编辑区聚焦 → :root 挂 data-kbd="1"（CSS ≤900px
  // 把两颗悬浮键淡出并停吃点击），失焦摘掉。focusin/focusout 是冒泡版 focus/blur，
  // 输入框之间移动时 focusout 先于 focusin，一删一挂自然收敛到正确状态。
  const isEditableTarget = (t) => t instanceof HTMLElement
    && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  document.addEventListener("focusin", (e) => {
    if (isEditableTarget(e.target)) document.documentElement.dataset.kbd = "1";
  });
  document.addEventListener("focusout", (e) => {
    if (isEditableTarget(e.target)) delete document.documentElement.dataset.kbd;
  });

  // opts.history=false：程序性重渲染（刷新当前视图、注册表变化后回正、首屏）不该压历史栈，
  // 否则 Android 返回键要多按好几下才退得出去（见 backNav.js）。
  function switchTo(id, dirHint, opts = {}) {
    if (id === "settings") {
      openSettingsModal();
      return;
    }
    // v0.52.0：APK 端收到「时间块 / 收件箱」导航（命令面板「今天的时间块」、
    // 快速捕获排程后的「查看」、插件联动等历史入口）一律落到时间线 ——
    // 它是移动端唯一的按日期视图；桌面端不受影响。
    if (!desktopWindow && (id === "timeblock" || id === "inbox")) id = "timeline";
    if (id.startsWith("plug:") && !viewDef(id)) id = "market";
    const targetId = id;
    const prevId = activeView;
    const ids = allViewIds();
    const dir = dirHint || (ids.indexOf(targetId) >= ids.indexOf(prevId) ? "left" : "right");
    const seq = ++navTransitionSeq;

    const commit = () => {
      if (seq !== navTransitionSeq) return;
      activeView = targetId;
      S.getState().settings.lastView = targetId;
      S.persistSoon();
      document.querySelector(".drawer")?._close?.();
      view._unsub?.();
      view._unsub = null;
      view.classList.remove("tb-root");
      view.replaceChildren();
      const def = viewDef(targetId);
      if (!def) return switchTo("market", dirHint);
      titleEl.textContent = def.title;
      subEl.textContent = def.sub ? ` · ${def.sub}` : "";
      renderTitleMark(def);
      renderNav();
      if (settingsDockBtn) settingsDockBtn.classList.remove("on");
      renderStat();
      /* 沉浸式视图（插件声明 immersive:true，如课程表）在窄屏下要让出全局底栏，
         把那 ~50px 还给内容。标记打在 .app 上而不是 .rail 上，是为了让 CSS 能同时
         收掉底栏与 .view 的 padding-bottom —— 后者是给底栏预留的占位，底栏不在就该一起收，
         否则底部会留一条空白。判定只看 def.pluginView?.immersive，不认插件 id。 */
      appFrame.classList.toggle("rail-hidden", def.pluginView?.immersive === true);
      if (def.pluginView) {
        const box = el("div", {
          class: "plugview",
          "data-plugin-id": def.pluginView.pluginId || def.pluginView.id,
        });
        view.append(box);
        try {
          const cleanup = def.pluginView.render(box, { refresh: () => switchTo(targetId, undefined, { history: false }) });
          const stopPluginMotion = observePluginMotion(box);
          view._unsub = () => {
            stopPluginMotion();
            if (typeof cleanup === "function") cleanup();
          };
        }
        catch (e) { box.append(el("p", { class: "desc" }, `插件视图出错：${e.message}`)); }
      } else if (targetId === "quadrant") renderQuadrant(view);
      else if (targetId === "timeline") renderTimeline(view);
      else if (targetId === "timeblock") renderTimeblock(view);
      else if (targetId === "inbox") renderInbox(view);
      else if (targetId === "market") renderMarket(view);

      view.classList.remove("page-l", "page-r");
      if (prevId !== targetId) {
        void view.offsetWidth;
        view.classList.add(dir === "left" ? "page-l" : "page-r");
        const titleCard = titleEl.closest(".topbar-title-card");
        if (titleCard?.animate && getUiPreferences().motion !== "reduced") {
          const titleOffset = dir === "left" ? 7 : -7;
          titleCard.animate([
            { opacity: .36, transform: `translate3d(${titleOffset}px, 0, 0) scale(.99)` },
            { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
          ], { duration: 240, easing: "cubic-bezier(.22,.8,.22,1)" });
        }
      }
      // 用户真的换了界面才压历史：返回键据此回到上一个界面
      if (opts.history !== false) noteViewChange(targetId);
      // 必须排在 noteViewChange 之后：它刚压了一格，返回按钮要立刻反映出来
      // （commit 早于 noteViewChange 跑，放在上面会慢一拍 —— 进插件时按钮不出现）。
      syncBackButton();
      // v0.59.0：这里不再有「切完视图自动收回底栏」。需求（用户）「点击显示菜单按钮后，
      // 除非打开设置否则不[收起]菜单」—— 呼出态常驻，连续换页不必反复点 ⋮。
      // 收回入口只有两处：再点一次 ⋮（✕）与 openSettingsModal。
    };

    // 「弹 2 下」修复：切视图只保留入场动画，不再先播放旧页滑出——
    // 出场 + 入场 + 插件首绘三层动画叠在一起，小窗口里看起来就是界面弹两下。
    commit();
  }

  // ── 插件中心：搜索、筛选、启停与直达 ──
  function renderMarket(container) {
    const wrap = el("div", { class: "market" });
    let query = marketQuery;
    let filter = marketFilter;

    const search = el("input", { class: "market-search", type: "search", value: query, placeholder: "搜索插件名称 / ID / 功能 / 作者…", "aria-label": "搜索插件" });
    const count = el("span", { class: "market-count" });
    const filterBox = el("div", { class: "market-filters" });
    const grid = el("div", { class: "market-grid" });

    const filters = [
      ["all", "全部"], ["enabled", "已启用"], ["disabled", "已停用"], ["builtin", "内置"], ["user", "用户插件"],
    ];
    // 各筛选档的数量跟随当前搜索词（忽略筛选维度本身），直接显示在按钮里
    function countFor(id) {
      const q = query.trim().toLowerCase();
      return getRegistry().filter((rec) => {
        const man = rec.manifest || {};
        const enabled = S.pluginState(rec.id).enabled !== false;
        if (id === "enabled" && !enabled) return false;
        if (id === "disabled" && enabled) return false;
        if (id === "builtin" && rec.source !== "builtin") return false;
        if (id === "user" && rec.source === "builtin") return false;
        if (!q) return true;
        return `${man.name || ""} ${rec.id} ${man.description || ""} ${man.author || ""}`.toLowerCase().includes(q);
      }).length;
    }
    function paintFilters() {
      filterBox.replaceChildren(...filters.map(([id, label]) => el("button", {
        class: `market-filter${filter === id ? " on" : ""}`,
        onclick: () => { filter = id; marketFilter = id; paintFilters(); paintCards(); },
      }, label, el("span", { class: "market-filter-count" }, String(countFor(id))))));
    }
    function match(rec) {
      const man = rec.manifest || {};
      const enabled = S.pluginState(rec.id).enabled !== false;
      if (filter === "enabled" && !enabled) return false;
      if (filter === "disabled" && enabled) return false;
      if (filter === "builtin" && rec.source !== "builtin") return false;
      if (filter === "user" && rec.source === "builtin") return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return `${man.name || ""} ${rec.id} ${man.description || ""} ${man.author || ""}`.toLowerCase().includes(q);
    }
    // flip=false：首次挂载 / 搜索 / 筛选，沿用逐张入场动画。
    // flip=true：分组相关的就地重排（改色、收放、整组换位、拖拽排序）—— 卡片从旧位置滑到新位置，
    // 不重播入场动画，滚动位置也不动。
    function paintCards({ flip = false } = {}) {
      if (!flip) return fillCards(true);
      return flipByKey(grid, {
        selector: ":scope > .mcard[data-card-id], :scope > .market-group-head[data-color]",
        key: (node) => (node.dataset.cardId ? `card:${node.dataset.cardId}` : `head:${node.dataset.color}`),
        mutate: () => fillCards(false),
      });
    }
    // 组收放：收起先让本组卡片淡出，再整段重排（后面的卡片滑上来补位）；展开直接重排，
    // 本组卡片按 FLIP 的 enter 淡入。
    function foldMarketGroup(color, collapsed) {
      const leaving = collapsed ? grid.querySelectorAll(`:scope > .mcard[data-color="${color}"]`) : [];
      const head = () => grid.querySelector(`:scope > .market-group-head[data-color="${color}"]`);
      const hadFocus = !!head()?.contains(document.activeElement);
      return fadeAway(leaving).then(() => {
        if (!grid.isConnected) return;
        paintCards({ flip: true });
        const fresh = head();
        turnChevron(fresh?.querySelector(".fold-chev"), collapsed);
        // 组头是重建出来的新节点：键盘操作时把焦点还给新的折叠钮
        if (hadFocus) fresh?.querySelector(".market-group-fold")?.focus({ preventScroll: true });
      });
    }
    repaintMarket = ({ fold } = {}) => {
      if (!grid.isConnected) return;
      if (fold) foldMarketGroup(fold.color, fold.collapsed);
      else paintCards({ flip: true });
    };
    function fillCards(entrance) {
      const customOrder = pluginOrderState();
      const rank = new Map(customOrder.map((id, index) => [id, index]));
      const sorted = getRegistry().filter(match).sort((a, b) => {
        const ar = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
        const br = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
        return ar - br || (a.manifest?.order || 999) - (b.manifest?.order || 999) || String(a.manifest?.name || a.id).localeCompare(String(b.manifest?.name || b.id), "zh-CN");
      });
      // 与侧栏同一口径吸附同色：没有视图、没进 pluginOrder 的已上色插件（例如已停用的）也归进本组，
      // 不会在列表末尾再冒出一个同名组头。
      const slot = new Map(normalizePluginOrder(sorted.map((rec) => rec.id), pluginColor).map((id, index) => [id, index]));
      const rows = sorted.sort((a, b) => slot.get(a.id) - slot.get(b.id));
      count.textContent = `显示 ${rows.length} / ${getRegistry().length}`;
      grid.replaceChildren();
      if (!rows.length) {
        grid.append(el("div", { class: "market-empty" }, query ? `没有找到“${query}”相关插件` : "当前筛选下没有插件"));
        return;
      }
      // 分组色带：组头是一条横跨整个网格的行，卡片仍留在同一个网格里流式排布，
      // 这样响应式列数只在 .market-grid 一处定义，不必给每组再抄一遍。
      const colorCount = new Map();
      for (const rec of rows) {
        const color = pluginColor(rec.id);
        if (color) colorCount.set(color, (colorCount.get(color) || 0) + 1);
      }
      const groupHead = (color) => {
        const collapsed = isGroupCollapsed(color);
        return el("div", {
          class: `market-group-head${collapsed ? " collapsed" : ""}`,
          "data-color": color,
          style: `--gc:${groupColorMeta(color).hex}`,
        }, groupFoldButton("market-group", color, colorCount.get(color) || 0, collapsed, () => {
          const next = toggleGroupCollapsed(color);
          foldMarketGroup(color, next);
          foldNavGroup(nav.querySelector(`.plug-group[data-color="${color}"]`), color, next);
        }));
      };
      let sectionColor = null;
      let hiddenSection = false;
      for (const [rowIndex, rec] of rows.entries()) {
        const recColor = pluginColor(rec.id);
        if (recColor !== sectionColor) {
          // 离开颜色段、回到未分组：插一条零高的整行分隔，强制换行并多留一道行距 ——
          // 否则后面的未分组卡片会接着填满该组最后一行，看起来就像是这个组的成员。
          if (sectionColor && !recColor) grid.append(el("div", { class: "market-group-end", "aria-hidden": "true" }));
          sectionColor = recColor;
          hiddenSection = false;
          if (recColor) {
            grid.append(groupHead(recColor));
            hiddenSection = isGroupCollapsed(recColor);
          }
        }
        if (hiddenSection) continue;
        const man = rec.manifest || {};
        const pluginName = pluginDisplayName(rec.id, man.name || rec.id);
        const enabled = S.pluginState(rec.id).enabled !== false;
        const pv = pluginViews.find((v) => v.pluginId === rec.id);
        const open = el("button", { class: "btn pri sm", disabled: !enabled || !pv ? true : null, onclick: () => {
          if (!enabled) return toast("请先开启这个插件");
          if (pv) switchTo(`plug:${pv.id}`);
          else toast("这个插件没有注册可打开的视图");
        } }, pv ? "打开" : "无视图");
        const toggle = el("button", {
          class: `switch market-plugin-switch${enabled ? " on" : ""}`,
          role: "switch",
          "aria-checked": String(enabled),
          "aria-label": `${enabled ? "关闭" : "开启"}${pluginName}`,
          title: enabled ? "关闭插件" : "开启插件",
          onclick: async (e) => {
            e.stopPropagation();
            const next = !enabled;
            const btn = e.currentTarget;
            btn.classList.toggle("on", next);
            btn.setAttribute("aria-checked", String(next));
            btn.closest(".market-switch-control")?.querySelector(".market-switch-text")?.replaceChildren(next ? "已开启" : "已关闭");
            try {
              await setEnabled(rec.id, next);
              toast(next ? `已开启「${pluginName}」` : `已关闭「${pluginName}」`);
              setTimeout(() => renderMarket(container), 120);
            } catch (err) {
              btn.classList.toggle("on", enabled);
              btn.setAttribute("aria-checked", String(enabled));
              toast(`切换失败：${err.message || err}`);
            }
          },
        });
        const switchControl = el("div", { class: "market-switch-control" },
          el("span", { class: "market-switch-text" }, enabled ? "已开启" : "已关闭"),
          toggle,
        );
        const card = el("div", {
          class: `mcard market-manage-card${entrance ? " market-card-enter" : ""}${enabled ? "" : " disabled"}`,
          "data-card-id": rec.id,
          "data-color": recColor || null,
          style: `--market-enter-index:${Math.min(rowIndex, 8)}${recColor ? `;--gc:${groupColorMeta(recColor).hex}` : ""}`,
          role: pv ? "button" : null,
          tabindex: pv ? "0" : null,
          onclick: (e) => {
            if (e.target.closest?.("button, input, select, a")) return;
            if (!enabled) return toast("请先开启这个插件");
            if (pv) switchTo(`plug:${pv.id}`);
          },
          onkeydown: (e) => {
            if (!pv || !enabled || !isSelfActivationKey(e)) return;
            e.preventDefault();
            switchTo(`plug:${pv.id}`);
          },
        },
          el("div", { class: "market-card-head" },
            el("span", { class: "mi", style: `--plugin-accent:${pluginAccent(rec.id)}` }, pluginDisplayIcon(rec.id, pluginName)),
            el("span", { class: "market-card-title" }, el("b", {}, pluginName), el("small", {}, `v${man.version || "?"} · ${rec.source === "builtin" ? "内置" : "用户"}`)),
          ),
          el("p", { class: "market-card-desc" }, man.description || "（无描述）"),
          el("div", { class: "market-card-meta" }, `${man.author ? `作者 ${man.author}` : rec.source === "builtin" ? "内置扩展" : "用户插件"}${rec.error ? " · 加载失败" : ""}`),
          rec.error ? el("div", { class: "perr" }, rec.error) : null,
          el("div", { class: "market-card-actions" }, open, switchControl, el("button", {
            class: "market-card-more",
            type: "button",
            title: "重命名、改图标与分组颜色",
            "aria-label": `${pluginName} 更多操作`,
            onclick: (e) => { e.stopPropagation(); openPluginContextMenu(e, rec.id); },
          }, "⋯")),
        );
        card.addEventListener("contextmenu", (event) => openPluginContextMenu(event, rec.id));
        grid.append(card);
      }
    }

    search.addEventListener("input", () => { query = search.value; marketQuery = query; paintFilters(); paintCards(); });
    // 手机上搜索默认收成一个图标（用户反馈：不要独占一行）；点了才展开输入框
    const searchToggle = el("button", {
      class: "market-search-toggle", type: "button", title: "搜索插件", "aria-label": "搜索插件",
      "aria-expanded": String(marketSearchOpen), "aria-controls": "market-search-row",
      onclick: () => {
        marketSearchOpen = !marketSearchOpen;
        searchToggle.setAttribute("aria-expanded", String(marketSearchOpen));
        wrap.classList.toggle("open-search", marketSearchOpen);
        if (marketSearchOpen) search.focus();
        else if (!query) paintCards();
      },
    }, el("span", { class: "market-search-glyph", "aria-hidden": "true" }, "⌕"));
    if (marketSearchOpen) wrap.classList.add("open-search");
    // 搜索开关与计数放在筛选按钮下面（用户反馈：顶部只留筛选档，别多占一行）
    wrap.append(
      filterBox,
      el("div", { class: "market-head" },
        el("div", { class: "market-head-tools" }, searchToggle, count),
      ),
      el("div", { class: "market-search-row", id: "market-search-row" }, search),
      grid,
    );
    container.replaceChildren(wrap);
    paintFilters();
    paintCards();
  }

  // ── 内容区左右滑动 = 返回上一页（v0.52.0 应用户要求改语义）──
  // 原来是「按 allViewIds 顺序翻到上/下一个视图」，用户反馈：滑动不该切界面，
  // 左右滑应该和 Android 返回键一个语义。现在 touchend 直调 backNav 的 goBack()：
  // 先关最上层浮层，没有浮层才回上一个视图，没有格子可回就静默忽略（不会误退应用）。
  // SWIPE_SKIP 的排除清单照旧：横滑课表 / 泳道 / 甘特这类「自己能横向滚」的内容时
  // 必须滚内容，不能被手势抢去当返回。
  let swX = 0, swY = 0, swOn = false, swEdge = false;
  const SWIPE_SKIP = ".plist, .block, .drawer, .popmenu, input, textarea, select, [data-noswipe], " +
    ".wakeup-scroll, .milestone-scroll, .chronicle-scroll, .gantt-scroll, .swim-scroll, " +
    // 插件页（.plugview）横向手势归插件自己：课程表周视图左右滑 = 切周（约 70px 阈值），
    // 这里的返回手势（56px 阈值）会同时命中 —— 同一次滑动既切周又退回上个视图。
    // 插件页内的视图级返回走 ‹ 悬浮键，插件子页返回走子页自己的 ‹（历史栈照常）。
    ".plugview";
  // v0.110.0：左缘返回带（视觉 px）。从屏幕最左 28px 内起滑的横滑视作「系统级返回」，
  // 即使落在插件页（.plugview）内也生效 —— 0.108 把插件页中部横滑让给插件（课表切周）
  // 之后，插件页里失去滑动返回只能找悬浮键；边缘带把通用返回找回来，页面中部仍归插件。
  // 用视觉像素、不 ÷ --ui-scale：边缘就是物理屏幕边缘。SKIP 只拦「非边缘」起滑。
  const EDGE_SWIPE_PX = 28;
  view.addEventListener("touchstart", (e) => {
    swOn = false; swEdge = false;
    if (e.touches.length !== 1) return;
    swEdge = e.touches[0].clientX <= EDGE_SWIPE_PX;
    if (!swEdge && e.target.closest?.(SWIPE_SKIP)) return;
    swX = e.touches[0].clientX; swY = e.touches[0].clientY; swOn = true;
  }, { passive: true });
  view.addEventListener("touchcancel", () => { swOn = false; }, { passive: true });
  view.addEventListener("touchend", (e) => {
    if (!swOn) return;
    if (!getUiPreferences().swipeNavigation) { swOn = false; return; }
    // 拖拽排序等手势会话期间让路：拖拽卡片的横移距离会满足滑动手势阈值，
    // 不拦会把「拖完松手」误判成一次滑动返回（v0.52.0 与四象限拖拽排序配套）
    if (document.body.dataset.swipeSuspended === "1") { swOn = false; return; }
    swOn = false;
    const dx = e.changedTouches[0].clientX - swX;
    const dy = e.changedTouches[0].clientY - swY;
    // 横向主导 + 足够长才算滑动手势，避免误伤纵向滚动
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    // 边缘带起滑：只认「从左往右拉」（与 Android 系统返回同向）；SKIP 例外在这里不适用 ——
    // 起滑阶段已为边缘放行，56px 阈值内内容自身的横滚基本没动，不构成冲突。
    if (swEdge) { if (dx > 0) goBack(); return; }
    // 页面中部：方向不限 —— 左滑右滑都是返回
    goBack();
  }, { passive: true });

  mountQuickDock();
  quickDockToggle.addEventListener("click", () => toggleQuickDock());
  window.addEventListener("resize", () => { if (quickDock?.isConnected && !quickDockState.collapsed) positionQuickDockNear(quickDockToggle); }, { passive: true });
  renderNav();
  onNavChanged(() => {
    const missingActivePlugin = activeView.startsWith("plug:") && !viewDef(activeView);
    renderNav();
    if (missingActivePlugin) switchTo("market", undefined, { history: false });
    else if (activeView.startsWith("plug:") || activeView === "market") switchTo(activeView, undefined, { history: false });
  });
  // 捕获/插件可请求跳转视图
  window.addEventListener("tide:navigate", (e) => switchTo(e.detail));
  // 别处（如更新提示条的「立即更新」）可以直接点名打开设置里的某一节
  window.addEventListener("tide:open-settings", (e) => openSettingsModal(e.detail?.section || "", e.detail?.target || ""));
  switchTo(activeView, undefined, { history: false });
  // Android 返回键的历史栈：必须在首屏视图定下来之后挂（readView 要读到它）。
  // 桌面端没有返回键，但浏览器/WebView 的后退（Alt+←）也走同一条逻辑。
  initBackNav({
    readView: () => activeView,
    applyView: (id) => switchTo(id, undefined, { history: false }),
  });
  // 插件快捷键：Alt + 字母直达插件视图。取数走回调，每次按键现查 ——
  // 插件是启动后期异步注册的，监听先挂上也没问题。 Alt+←（后退）不含字母，互不干扰。
  attachPluginShortcutKeys({
    getEntries: shortcutEntries,
    getCustoms: getPluginShortcutCustoms,
    navigate: (viewId) => switchTo(`plug:${viewId}`),
  });
  // 关浮层这类回退不会走 commit，返回按钮得自己跟一次。
  // 注册在 initBackNav 之后：backNav 的 onPopState 先跑完（depth 已更新），这里读到的才是新值。
  window.addEventListener("popstate", syncBackButton);
  syncBackButton();
  S.subscribe(renderStat);
}

/* ── 侧栏插件拖拽重排 ─────────────────────────────────────────────────────────
 * 被拖项仍留在 flex 流里充当明确空槽；body 上的克隆项跟随指针。激活后用 rAF
 * 每帧按缓存的 item 高度重新推演落点，DOM 一变，其余项各自用 FLIP 追赶新位置。
 * 指针停下时槽位不再变化，所有项自然停在当前布局，不会自动滑向列表端点。
 * 几何量一律是视口坐标（zoom 之后的视觉像素：指针、getBoundingClientRect），
 * 写进 transform / 宽高之前除以 st.scale —— 与 toolbarDrag.js 同一口径；
 * 否则界面缩放不是 100% 时浮起项会偏离指针、FLIP 起点会跳。
 */
function attachPluginListDrag(list, onCommit) {
  let pd = null;
  const items = () => [...list.querySelectorAll(":scope > button[data-plugin-id]")];
  const clearLong = (st) => { if (st.longTimer) { clearTimeout(st.longTimer); st.longTimer = null; } };
  const detachDoc = (st) => {
    document.removeEventListener("pointerup", st.docUp, true);
    document.removeEventListener("pointercancel", st.docCancel, true);
  };
  const moveGhost = (st) => st.ghost?.style.setProperty("transform", `translate(${(st.x - st.gx) / st.scale}px, ${(st.y - st.gy) / st.scale}px) scale(1.025)`);
  const stopFrame = (st) => { if (st.frame) cancelAnimationFrame(st.frame); st.frame = 0; };
  const endSession = (st) => {
    clearLong(st); stopFrame(st); detachDoc(st);
    st.ghost?.remove(); st.ghost = null;
    st.card?.classList.remove("nav-dragging");
    list.classList.remove("plugin-drag-live");
    try { st.card?.releasePointerCapture(st.pointerId); } catch { /* document 兜底已覆盖 */ }
    if (st.swallowClick) setTimeout(() => document.removeEventListener("click", st.swallowClick, true), 0);
    if (pd === st) pd = null;
  };
  const cancel = (st = pd) => {
    if (!st) return;
    if (st.active) for (const node of st.originOrder) list.append(node);
    st.active = false;
    endSession(st);
  };
  const computeSlot = (st, y) => {
    let top = st.contentTop;
    const mids = [];
    for (const item of items().filter((node) => node !== st.card)) {
      const height = st.heights.get(item) ?? item.getBoundingClientRect().height;
      mids.push(top + height / 2);
      top += height + st.gap;
    }
    return slotIndexFor(mids, y);
  };
  const reorderDOM = (st, slot) => {
    const peers = items().filter((node) => node !== st.card);
    const before = new Map(peers.map((node) => [node, node.getBoundingClientRect().top]));
    list.insertBefore(st.card, peers[slot] ?? null);
    if (reducedMotion()) return;
    for (const node of peers) {
      const dy = (before.get(node) - node.getBoundingClientRect().top) / st.scale;
      if (dy) node.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: 185, easing: "cubic-bezier(.22,.8,.22,1)" });
    }
  };
  const frame = (st) => {
    if (!st.active) return;
    moveGhost(st);
    const slot = computeSlot(st, st.y);
    if (slot !== st.slot) { st.slot = slot; reorderDOM(st, slot); }
    st.frame = requestAnimationFrame(() => frame(st));
  };
  const finish = (st) => {
    if (!st.active) return;
    st.active = false;
    const ghostRect = st.ghost?.getBoundingClientRect();
    st.card.classList.remove("nav-dragging");
    list.classList.remove("plugin-drag-live");
    onCommit?.();
    if (ghostRect && !reducedMotion()) {
      const landed = st.card.getBoundingClientRect();
      st.card.animate([
        { transform: `translate(${(ghostRect.left - landed.left) / st.scale}px, ${(ghostRect.top - landed.top) / st.scale}px) scale(1.025)` },
        { transform: "none" },
      ], { duration: 210, easing: "cubic-bezier(.22,.8,.22,1)" });
    }
    endSession(st);
  };
  const begin = (st) => {
    if (!list.contains(st.card) || st.active) return;
    st.active = true; clearLong(st);
    st.originOrder = [...list.children];
    st.scale = getUiScaleFactor() || 1;
    const rect = st.card.getBoundingClientRect();
    st.gx = st.x - rect.left; st.gy = st.y - rect.top;
    st.gap = (parseFloat(getComputedStyle(list).rowGap) || 0) * st.scale;
    st.contentTop = items()[0]?.getBoundingClientRect().top || list.getBoundingClientRect().top;
    // 按节点缓存视觉高度：多视图插件的几个按钮 data-plugin-id 相同，按 ID 缓存会互相覆盖
    st.heights = new Map(items().map((node) => [node, node.getBoundingClientRect().height]));
    st.card.classList.add("nav-dragging"); list.classList.add("plugin-drag-live");
    if (!reducedMotion()) {
      st.ghost = st.card.cloneNode(true);
      st.ghost.classList.remove("nav-dragging", "on");
      st.ghost.classList.add("plugin-nav-ghost");
      st.ghost.removeAttribute("data-plugin-id");
      st.ghost.style.width = `${rect.width / st.scale}px`; st.ghost.style.height = `${rect.height / st.scale}px`;
      document.body.append(st.ghost);
    }
    navigator.vibrate?.(10);
    st.swallowClick = (event) => { event.preventDefault(); event.stopPropagation(); };
    document.addEventListener("click", st.swallowClick, true);
    try { st.card.setPointerCapture(st.pointerId); } catch { /* document 兜底 */ }
    st.docUp = (event) => { if (event.pointerId === st.pointerId) finish(st); };
    st.docCancel = (event) => { if (event.pointerId === st.pointerId) cancel(st); };
    document.addEventListener("pointerup", st.docUp, true);
    document.addEventListener("pointercancel", st.docCancel, true);
    st.slot = computeSlot(st, st.y);
    st.frame = requestAnimationFrame(() => frame(st));
  };

  list.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const card = event.target.closest?.("button[data-plugin-id]");
    if (!card || !list.contains(card)) return;
    pd = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, scale: 1, active: false, longTimer: null, frame: 0, ghost: null, swallowClick: null, docUp: null, docCancel: null };
    if (event.pointerType !== "mouse") pd.longTimer = setTimeout(() => { if (pd?.card === card && !pd.active) begin(pd); }, 240);
  });
  list.addEventListener("pointermove", (event) => {
    const st = pd;
    if (!st || event.pointerId !== st.pointerId) return;
    st.x = event.clientX; st.y = event.clientY;
    if (st.active) { event.preventDefault(); return; }
    const dx = st.x - st.startX, dy = st.y - st.startY;
    if (st.longTimer) { if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLong(st); return; }
    if (event.pointerType === "mouse" && Math.hypot(dx, dy) >= 6) begin(st);
  });
  list.addEventListener("pointerup", (event) => {
    const st = pd; if (!st || event.pointerId !== st.pointerId) return;
    if (st.active) finish(st); else endSession(st);
  });
  list.addEventListener("pointercancel", (event) => { if (pd && event.pointerId === pd.pointerId) cancel(pd); });
  list.addEventListener("touchmove", (event) => { if (pd?.active) event.preventDefault(); }, { passive: false });
  list.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const card = event.target.closest?.("button[data-plugin-id]");
    const order = items(); const at = order.indexOf(card); const to = at + (event.key === "ArrowDown" ? 1 : -1);
    if (at < 0 || to < 0 || to >= order.length) return;
    event.preventDefault();
    if (to > at) list.insertBefore(card, order[to].nextSibling); else list.insertBefore(card, order[to]);
    onCommit?.(); card.focus();
  });
}

// 横向工具区共用同一套跟手 / 实时让位 / 落位动画与键盘重排。
// 保留侧栏接线入口，业务顺序与动作注册仍由 railActions 管理。
function attachRailDockDrag(list, onCommit) {
  return attachToolbarDrag(list, onCommit);
}
