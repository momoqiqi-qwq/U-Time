import { attachPluginListDrag } from "./pluginListDrag.js";
// 应用外壳：侧栏导航 + 顶栏 + 视图切换
import * as S from "./store.js";
import { outlineAppIcon } from "./icons.js";
import { api } from "./api.js";
import { appConfirm, appPrompt, bottomInsetPx, el, isSelfActivationKey, toast } from "./ui.js";
import { renderQuadrant } from "./views/quadrant.js";
import { renderTimeblock } from "./views/timeblock.js";
import { renderTimeline } from "./views/timeline.js";
import { renderSettings } from "./views/settings.js";
import { createSettingsLayoutControls } from "./views/settings/layout.js";
import { renderInbox } from "./views/inbox.js";
import { openQuickCapture } from "./capture.js";
import { pluginViews, onNavChanged, getRegistry, setEnabled, rescan, removeExternalPlugin } from "./pluginHost.js";
import { getPluginOverride, pluginAccent, pluginColor, pluginDisplayIcon, pluginDisplayName, pluginDisplayOutlineIcon, resetPluginOverride, setPluginColor, setPluginOverride } from "./pluginAppearance.js";
import { GROUP_COLORS, groupColorMeta, groupName, groupRuns, isGroupColor, isGroupCollapsed, moveGroupInOrder, normalizePluginOrder, renameGroup, toggleGroupCollapsed } from "./pluginGroups.js";
import { isPluginPinned, pinnedOrderOf, setPinnedPluginOrder, togglePluginPin } from "./pluginPins.js";
import { hasNavOverride, navDisplayIcon, navDisplayName, navDisplayOutlineIcon, resetNavOverride, setNavOverride } from "./navAppearance.js";
import { PLUGIN_SHORTCUT_MODIFIER, attachPluginShortcutKeys, computePluginShortcutMap, effectivePluginShortcutLetter, getPluginShortcutCustoms, normalizeShortcutLetter, setPluginShortcut } from "./pluginShortcuts.js";
import { pluginShortcutEntries } from "./pluginShortcutEntries.js";
import { getUiPreferences, coreViewIds } from "./uiPreferences.js";
import { listRailActions, normalizeRailActionOrder, registerRailAction, slotIndexFor } from "./railActions.js";
import { closeLayer, enterPage, fadeAway, flipByKey, foldClose, foldOpen, observePluginMotion, reducedMotion, removeWithMotion } from "./motion.js";
import { FOCUS_WINDOW_SIZE, isDesktopRuntime, isFocusWindowActive, toggleFocusWindow } from "./windowSize.js";
import { isAndroidRuntime as isNativeAndroidRuntime } from "./androidNotify.js";
import { isMobilePreview } from "./mobilePreview.js";

// 本文件的 Android 判断只用于布局，预览复用它；原生能力仍由 androidNotify 判断。
function isAndroidRuntime() { return isNativeAndroidRuntime() || isMobilePreview(); }
import { canGoBack, goBack, initBackNav, noteViewChange } from "./backNav.js";
import { getThemeMode, resolveThemeMode, setThemeMode } from "./theme.js";
import { RAIL_WIDTH_LIMITS, RAIL_WIDTH_STEP, applyRailWidth, clampRailWidth, normalizeRailWidth, steppedRailWidth } from "./railWidth.js";
import { getUiScaleFactor } from "./uiScale.js";
import { attachToolbarDrag } from "./toolbarDrag.js";
import { attachMarketCardResize, resetMarketCardSize } from "./marketCardResize.js";
import { searchGlyph, withSearchGlyph } from "./searchField.js";
import { openUpdateHistory } from "./updateHistory.js";

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
const TOPBAR_PARTS = ["history", "sync", "search", "logs", "theme", "settings", "quick", "stats", "window"];
const PREVIOUS_TOPBAR_DEFAULT = ["search", "quick", "theme", "settings", "stats", "window"];

function topbarOrderState() {
  const settings = S.getState().settings;
  const saved = Array.isArray(settings.topbarOrder) ? settings.topbarOrder : [];
  // 仅没有布局存档或仍使用旧默认顺序时采用新默认；用户重排结果继续保留。
  if (!saved.length || saved.join() === PREVIOUS_TOPBAR_DEFAULT.join()) {
    settings.topbarLayout = "reference";
    settings.topbarOrder = [...TOPBAR_PARTS];
    return settings.topbarOrder;
  }
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

function railCoreViewIds() {
  const ids = coreViewIds();
  return isAndroidRuntime() ? ids.filter((id) => id !== "quadrant" && id !== "timeline") : ids;
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
  /* v0.152.0：侧栏选中光块（滑动指示器）。样式见 styles.css 的 .nav-glow；机制与参数照
     Nephele Workshop 的 sidebarActiveIndicator（已读其随包分发的 QML 源码）。
     ⚠️ 它住在 nav 里，而 renderNav() 首行的 nav.replaceChildren() 会把它一并摘掉 ——
     每次重绘都要挂回来，漏一次它就永久消失（守卫测试拦这条）。 */
  const navGlow = el("div", { class: "nav-glow", "aria-hidden": "true" });
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
  /* v0.183.0：字标下方那条哥特装饰线（用户需求「在下面添加一根像上面代码那样画出来的线」）。
     形状照参考图：左右两条带波纹节点的细主线 + 两端尖饰 + 中间上下对称的菱形与四片卷草花饰，
     末端再挂一对横向小枝；最上面那层极淡的同色柔光只在深色模式开（浅色下压白底会发灰）。
     viewBox 是 160×14 —— 与桌面侧栏里字标的实际宽度（≈159px @ 20px 字号，实测）几乎 1:1，
     所以默认 preserveAspectRatio（xMidYMid meet）下既不会被横拉变形，也不会被裁。
     **颜色一律由 styles.css 的 CSS 变量给**（`--brand-rule-*`）：浅色/深色两套四档跟字标同一
     色相，对比度由 scripts/test-brand-wordmark.mjs 一起实算，别在这里写死十六进制色。 */
  function brandRule() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "brand-rule");
    svg.setAttribute("viewBox", "0 0 160 14");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.innerHTML = `
      <defs>
        <linearGradient id="brandRuleGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="160" y2="0">
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

  /* v0.178.0：左上角品牌区只留名称（用户需求「名称和图标修改为仅保留名称」）。
     被删掉的两样东西：① `<span class="mark">` 那枚四色圆环图标；② 重复一行的副标题
     `<small>U-TIME</small>` —— 名称已经写在字标里，再叠一行同义大写只是噪音。
     名称本身换成 Nephele Workshop 那套哥特字标（UnifrakturCook + 粉紫→珊瑚橙横向渐变），
     字体、渐变、发光与「背景绘制区止于 padding box」的坑全在 styles.css 的 `.brand b` 那条注释里。
     窄屏（≤900px）本来就把 .brand 整个 display:none，所以这次改动只作用于 ≥901px 的桌面侧栏。
     v0.181.0：字标文案从 `U-Time` 改成 `U-Time Work`（用户需求「把 U-Time 改成 U-Time Work」）。
     哥特体下它比原名宽约 1.8 倍，`.brand b` 的 28px 字号是**按新名字**核过的 ——
     默认 224px 侧栏（内容 202px − .brand 左右 padding）里仍留得住，且 white-space:nowrap
     不会折行；`scripts/test-brand-wordmark.mjs` 里钉了「不溢出」这条。

     v0.183.0：字标文案从 `U-Time Work` 改成 `U Time WorkSpace`（用户需求），并在字标**下方**
     补一条哥特装饰线（`brandRule()`，形状与配色见上）。名字又长了 42%（实测 28px 下
     158.06px → 222.64px），而默认 compact 侧栏（--rail-w: 204px）里 `.brand` 的可用宽度只有
     166px —— 所以基础字号从 28px 降到 20px（实测 159.03px，留 7px 余量），过渡带那条从 22px
     降到 18px（实测 143.13px ≤ 可用 146px；19px 会溢出 5.06px）。`.brand` 因为多了下面这条线，
     主轴从 row 改成 column。
     别再照抄 28px：这个字号是拿无头 Chrome 量出来的，不是估的。 */
  const rail = el("aside", { class: "rail" },
      el("div", { class: "brand" },
      el("b", {}, "U Time WorkSpace"),
      brandRule(),
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

  // v0.57.0：搜索钮收成纯放大镜图标（用户需求「搜索/命令也弄成一个放大镜图标，不用文字」）。
  // v0.184.0：中文标签「搜索」彻底从 DOM 移除（用户需求「删除所有搜索框内的中文，仅保留
  // 搜索图标」）—— 连带 topbar-reference / 更新历史页那两条把它显示出来的 CSS 一并删掉，
  // 三处（默认布局、桌面参考布局、更新历史页）统一成同一颗 34×34 放大镜瓷砖。
  // 快捷键说明仍在 title；命令面板入口（tide:command-palette）与拖动排序不变。
  const topSearch = el("button", { class: "top-search", title: "全局搜索 / 命令面板（Ctrl+K）· 拖动可调整位置", "aria-label": "全局搜索 / 命令", type: "button", onclick: () => window.dispatchEvent(new CustomEvent("tide:command-palette")) },
    el("span", { class: "top-search-glyph", "aria-hidden": "true" }, faIcon("magnifying-glass")));
  const topHistory = el("button", { class: "top-mini-btn top-history-trigger", type: "button", title: "更新历史", "aria-label": "更新历史",
    onclick: async () => { const info = await api.appInfo().catch(() => null); openUpdateHistory(info?.version); } }, faIcon("clock-rotate-left"));
  const topSync = el("button", { class: "top-mini-btn top-sync-trigger", type: "button", title: "云同步", "aria-label": "云同步",
    onclick: () => openSettingsModal("sync") }, faIcon("cloud-arrow-up"));
  const topLogs = el("button", { class: "top-mini-btn top-logs-trigger", type: "button", title: "查看自动化日志", "aria-label": "查看自动化日志",
    onclick: async () => {
      const { getLogs } = await import("./automation.js");
      const content = el("div", { class: "update-history-content", tabindex: "0" });
      const logs = getLogs();
      if (!logs.length) content.append(el("p", { class: "desc" }, "暂无自动化操作记录。"));
      for (const log of logs) content.append(el("div", { class: "update-history-card" },
        el("small", {}, new Date(log.at).toLocaleString()), el("p", {}, log.message)));
      await appConfirm("自动化日志", content, { dialogClass: "update-history-dialog", focusMessage: true, cancelText: "返回", confirmText: "关闭" });
    } }, el("span", { class: "top-log-dot", "aria-hidden": "true" }), "日志");

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

  // v0.175.0：顶栏设置键改用**线性**图标（outlineAppIcon → FontAwesome gear，走 currentColor），
  // 不再用 appIcon("settings") 那张随包 PNG。理由：PNG 是 Icons8 **Color** 彩色图（实测主色
  // #607888 / #405860 的青灰齿轮），而顶栏其余按键（搜索、闪电、月亮、时钟、云）全是白色
  // 单色 FA 图标 —— 同一个工具栏里只有齿轮是彩色的，深浅色模式下都对不齐。换成线性图标后
  // 与邻居同色、同粗细，且跟着 --ink-2 / hover 的 --deep 自动变色，Nephele 下也不用特判。
  const topSettings = el("button", {
    class: "top-mini-btn top-settings-trigger",
    title: "设置 · 拖动或 Alt+←/→ 调整位置",
    "aria-label": "设置",
    "aria-haspopup": "dialog",
    type: "button",
    onclick: () => openSettingsModal(),
  }, el("span", { class: "top-settings-glyph", "aria-hidden": "true" }, outlineAppIcon("settings")));

  const topbarActionCard = el("div", { class: "topbar-action-card", role: "toolbar", "aria-label": "可拖动排序的顶栏工具", "data-noswipe": "", "data-tauri-drag-region": dragRegion });
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

  const appFrame = el("div", { class: isAndroidRuntime() ? "app android-runtime" : "app" }, rail, railResizer, main);
  root.append(appFrame);
  // Android 所有视图共用底栏真实占位，设置页也直接读取此变量。
  const updateDockClearance = () => {
    if (!rail.isConnected) return;
    const value = isAndroidRuntime() && mobileQuery.matches
      ? `${Math.max(0, window.innerHeight - rail.getBoundingClientRect().top) + 12}px` : "";
    const style = document.documentElement.style;
    if (style.getPropertyValue("--android-dock-clearance") !== value) {
      if (value) style.setProperty("--android-dock-clearance", value);
      else style.removeProperty("--android-dock-clearance");
    }
  };
  if (isAndroidRuntime()) {
    new ResizeObserver(updateDockClearance).observe(rail);
    new MutationObserver(updateDockClearance).observe(document.documentElement, { attributes: true });
    window.addEventListener("resize", updateDockClearance);
    window.addEventListener("tide:ui-preferences-changed", updateDockClearance);
    updateDockClearance();
  }

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
    const parts = { history: topHistory, sync: topSync, logs: topLogs, search: topSearch, quick: quickDockToggle, theme: topTheme, settings: topSettings, stats: statPill, window: windowControls };
    for (const [id, node] of Object.entries(parts)) {
      if (!node) continue;
      node.draggable = false; // 改用和侧栏相同的指针拖拽，不再启动浏览器原生拖放。
      node.dataset.topbarPart = id;
      node.classList.add("topbar-sortable");
    }
    topbarActionCard.replaceChildren(...topbarOrderState().map((id) => parts[id]).filter(Boolean));
    topbar.classList.toggle("topbar-reference", S.getState().settings.topbarLayout === "reference");
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
  let refreshMarketState = null;
  const marketTogglePending = new Set();
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
      // 与侧栏行尾那颗 📌 同一个动作 —— 键盘 / 触屏也能置顶（那条操作条是 hover 才出现的）
      contextMenuItem(isPluginPinned(pluginId) ? "取消置顶" : "置顶在最上方", () => togglePin(pluginId)),
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
    // v0.152.0：光块刚被上面这行摘掉了，先挂回来再重建按钮（DOM 顺序无所谓，层级由 z-index 定）。
    nav.prepend(navGlow);
    // APK 底栏保留插件中心，并固定提供成绩、课表两个直达入口。
    // 页面本身仍可被启动页、历史栈和返回键访问，不从 coreViewIds() 的平台清单里移除。
    for (const id of railCoreViewIds()) nav.append(navBtn(id));
    if (isAndroidRuntime()) {
      for (const [id, label, icon] of [
        ["plug:cppu-credit", "成绩", "chart-line"],
        ["plug:shiguang-schedule", "课表", "calendar-days"],
      ]) {
        const btn = el("button", {
          class: activeView === id ? "on" : "",
          type: "button",
          "data-view": id,
          "aria-label": label,
        }, el("span", { class: "ic" }, faIcon(icon)), el("span", { class: "lb" }, label));
        btn.addEventListener("click", () => {
          if (viewDef(id)) switchTo(id);
          else { toast(`请先在插件中心启用${label}插件`); switchTo("market"); }
        });
        nav.append(btn);
      }
    }
    if (!pluginViews.length) { syncNavGlow(); return; }
    /* 桌面端侧栏仍保留插件直达列表；移动端底栏只留核心入口（.plug-list 被隐藏）。
       v0.181.0：原来那行「插 件 视 图 ／ 上下拖动排序」整行删掉，改成一条细横线
       （用户需求原文：「请去掉图中的文字（在侧边栏那里），变成一个横线」）。
       线的几何全部写在 styles.css 的 .rail-divider 那条规则里 —— 它与底部操作条上方那条
       （.rail-bottom::before）共用同一个声明块，所以两条线永远等宽、左右对齐。
       被删掉的是两个 UI 事实：分组标题（插件列表本来就自成一段）与拖拽提示（拖动时
       原位空槽 + 克隆项跟随本身就是反馈，提示语不再单占一行）。 */
    const box = el("div", { class: "plug-list" },
      el("div", { class: "rail-divider", "aria-hidden": "true" }),
    );
    // 一个插件可以注册多个视图（cppu-notify 就有通知 / 一卡通 / 教务四视图共 6 个）。
    // 颜色与顺序都是插件级的：先按插件归拢，它的视图整串跟着插件走，一个都不能丢。
    const viewsOf = new Map();
    for (const pv of orderedPluginViews()) {
      if (!viewsOf.has(pv.pluginId)) viewsOf.set(pv.pluginId, []);
      viewsOf.get(pv.pluginId).push(pv);
    }
    // v0.152.0 置顶区：置顶插件从颜色分组里「提」出来，固定渲染在最上方；
    // 顺序用置顶表自己的顺序，与 pluginOrder 正交 —— 取消置顶即回原位（见 pluginPins.js）。
    // 置顶段自己也是一段可拖拽容器，拖动改的是置顶表，不碰 pluginOrder。
    const pinnedIds = pinnedOrderOf([...viewsOf.keys()]);
    const pinned = new Set(pinnedIds);
    // 置顶的插件视图在这里就展开：它们不进下面的分组分段。
    if (pinnedIds.length) box.append(plugSegNode(pinnedIds.flatMap((id) => viewsOf.get(id) || []), { pinned: true }));
    // 改色时已经把同色吸附成连续段（normalizePluginOrder），这里再归一次兜底：
    // 别的设备同步过来的顺序可能还没吸附。
    const runs = groupRuns(
      normalizePluginOrder([...viewsOf.keys()].filter((id) => !pinned.has(id)), pluginColor),
      pluginColor,
    );
    runs.forEach(({ color, ids }, index) => {
      const views = ids.flatMap((id) => viewsOf.get(id) || []);
      if (!views.length) return;
      box.append(color
        ? plugGroupNode(color, views, { first: index === 0, last: index === runs.length - 1 })
        : plugSegNode(views));
    });
    nav.append(box);
    // 收尾落位：所有 renderNav 调用点（切界面 / 改名 / 分组重排 / 置顶…）都自动覆盖
    syncNavGlow();
  }

  /* ── v0.152.0：侧栏选中光块（滑动指示器）────────────────────────────────
     需求：切换界面时选中光效要从旧位置"滑"到新位置，而不是旧位置闪灭 + 新位置闪亮。
     根因：renderNav() 首行 nav.replaceChildren() 整份重建侧栏 ⇒ 一块静态底色做不出位移关系。

     做法与参数照 Nephele Workshop 的 sidebarActiveIndicator（已读其随包分发的 QML 源码）：
       · 条目自持一层淡底（"自持微光"）+ 本光块是"更亮的焦点标记"（两层都在 styles.css 里）；
         两层各管一个语义 —— 选中项落进收起的分组、由组头替它亮着时，光块淡出而条目层仍在；
       · 位移 500ms / OutBack(overshoot 1.3)、尺寸 400ms / OutCubic —— **两条通道分开跑**，
         时长刻意不等（5:4）：行高有差时那一帧的不同步，就是"惯性拉伸"感的来源，比显式
         scaleY 自然；
       · 取位置等布局定下来再读（那边是 Qt.callLater，这边同步读 rect 就够）；
       · 布局漂移（容器 / 按钮尺寸变化）一律瞬时对齐，不走动画。

     坐标换算：包含块直接取 navGlow.offsetParent —— 绝对定位元素的 offsetParent 本身就是它的
     包含块。桌面得到 .nav（滚动容器），光块作为它的绝对定位后代**随列表一起滚动**（所以不需要
     监听 nav 的 scroll）；窄屏 .nav 是 display: contents、不生成盒子，offsetParent 自动上溯到
     .rail；.rail 被 display:none 时（窄屏沉浸式视图、窄屏设置页）offsetParent 为 null ⇒
     直接淡出，不用逐个特判那些场景。
     ⚠️ 三个坐标口径都要除 getUiScaleFactor()：界面缩放是 documentElement 上的 CSS zoom，
     getBoundingClientRect 给的是**视觉 px**，而 left/top/width/height 与 transform 都是
     缩放前的布局 px —— 不除的话 125% 档下光块会偏到 1/5 行以外（与 railWidth.js 同一口径）。
     ⚠️ 起点取"当前**视觉**位置"（直接量光块自己的 rect）而不是上一个目标值：上一段动画可能
     还在飞，用目标值当起点会让连续快切跳一下。
     ⚠️ 终点取"**剥掉按钮自身 transform** 的布局盒"（layoutBoxOf，见下）—— 不能用裸 rect。 */

  /* ── 剥掉元素自身 transform，拿到它稳稳的布局盒 ─────────────────────────────
     为什么需要：CSS 给所有 button 挂了 hover 抬升（interactions.css 里
     `button:hover { transform: translateY(-1px) }`）与 :active 下压
     （`translateY(1px) scale(.98)`），两者都带过渡（`.nav button` 的 transform .08s）。
     切页那一刻按钮正处在过渡中间，裸 rect 读到的是**瞬时反馈的位置**：
     实测会偏 1px；极端情况下 :active 的 scale(.98) 会让宽度差 2%（181px 行差 3.6px，肉眼可见）。
     光块是**选中指示器**，锚定的是"这一行的位置"，不该跟着 hover / 按下抖 —— 鼠标一移开
     按钮回落 1px，跟着抖的光块反而会永久错位。
     transform-origin 是 center（本项目没有覆盖），所以反解很简单：缩放绕中心、位移直接减。
     有旋转 / 斜切（b、c 非零）就放弃反解、退回裸 rect —— 比算错好。 */
  function layoutBoxOf(node) {
    const rect = node.getBoundingClientRect();
    const raw = getComputedStyle(node).transform;
    const m = raw && raw !== "none" ? raw.match(/matrix\(([-\d.eE, ]+)\)/) : null;
    if (!m) return rect;
    const [a, b, c, d, tx, ty] = m[1].split(",").map(Number);
    if (![a, b, c, d, tx, ty].every(Number.isFinite) || Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4) return rect;
    const width = rect.width / (a || 1);
    const height = rect.height / (d || 1);
    return {
      left: rect.left - (width - rect.width) / 2 - tx,
      top: rect.top - (height - rect.height) / 2 - ty,
      width, height,
    };
  }

  const NAV_GLOW_SLIDE_MS = 500;
  const NAV_GLOW_RESIZE_MS = 400; // 与位移通道刻意不同（5:4），见上
  const NAV_GLOW_EASE_SLIDE = "cubic-bezier(.34, 1.56, .64, 1)"; // = OutBack(overshoot 1.3)
  const NAV_GLOW_EASE_RESIZE = "cubic-bezier(.33, 1, .68, 1)";   // = OutCubic
  let navGlowBox = null;   // 上一帧落定的几何（包含块坐标系，布局 px）
  let navGlowAnims = [];   // 在飞的两条通道；重算时整体取消重起
  let navGlowObsBtns = null;
  let navGlowResizeObs = null;

  function hideNavGlow() {
    navGlowBox = null;
    navGlowAnims.forEach((anim) => anim.cancel());
    navGlowAnims = [];
    navGlow.classList.remove("on");
  }

  /* 取「当前该亮」的那颗按钮。
     ⚠️ 不能直接用 querySelector('button[data-view].on')：进入插件视图时 market **也**带 .on
     （navBtn 里 `id === "market" && activeView.startsWith("plug:")`），这是**刻意**的 ——
     插件是从市场进去的，两个都该亮。但 market 在 railCoreViewIds() 里、文档序排在插件段**之前**
     ⇒ querySelector 永远抓到 market，光块就停在「插件市场」上不跟过去。
     实测（v0.152.0）：点 plug:plugin-guide，光块落 t=159（market），目标行在 t=237，差 78px。
     所以多选时以 activeView 自身那一项为准；它不在 DOM 里（插件项被折叠的分组藏起来）时
     回退到文档序第一个 —— 那种情况下光块停 market 是对的。 */
  function activeNavBtn() {
    const ons = nav.querySelectorAll("button[data-view].on");
    for (const b of ons) if (b.dataset.view === activeView) return b;
    return ons[0] || null;
  }

  function syncNavGlow({ animate = true } = {}) {
    const box = navGlow.offsetParent; // 包含块；侧栏隐藏时为 null
    const btn = box && activeNavBtn();
    if (!btn?.isConnected) return hideNavGlow();
    const factor = getUiScaleFactor() || 1;
    const rect = box.getBoundingClientRect();
    const originLeft = rect.left + (box.clientLeft - box.scrollLeft) * factor;
    const originTop = rect.top + (box.clientTop - box.scrollTop) * factor;
    const target = layoutBoxOf(btn);
    if (!target.width || !target.height) return hideNavGlow(); // 侧栏还没布局出来
    const left = (target.left - originLeft) / factor;
    const top = (target.top - originTop) / factor;
    const width = target.width / factor;
    const height = target.height / factor;
    // renderNav 重建按钮后 observe() 必然先通知一次，尺寸并没有因此变化。
    // 先换观察目标，再跳过相同几何的重算，避免这次通知取消刚启动的滑动。
    if (navGlowObsBtns !== btn) {
      if (navGlowObsBtns) navGlowResizeObs?.unobserve(navGlowObsBtns);
      navGlowObsBtns = btn;
      navGlowResizeObs?.observe(btn);
    }
    if (navGlowBox && navGlow.classList.contains("on") && !reducedMotion()
      && Math.abs(navGlowBox.left - left) < .01
      && Math.abs(navGlowBox.top - top) < .01
      && Math.abs(navGlowBox.width - width) < .01
      && Math.abs(navGlowBox.height - height) < .01) return;
    let from = null;
    if (navGlowBox && navGlow.classList.contains("on")) {
      const cur = navGlow.getBoundingClientRect(); // 视觉位置（含在飞的 transform）与当前尺寸
      from = {
        left: (cur.left - originLeft) / factor,
        top: (cur.top - originTop) / factor,
        width: cur.width / factor,
        height: cur.height / factor,
      };
    }
    navGlowAnims.forEach((anim) => anim.cancel());
    navGlowAnims = [];
    navGlow.style.left = `${left}px`;
    navGlow.style.top = `${top}px`;
    navGlow.style.width = `${width}px`;
    navGlow.style.height = `${height}px`;
    navGlowBox = { left, top, width, height };
    navGlow.classList.add("on");
    // 首次出现 / 从淡出恢复 / 减少动效 ⇒ 直接落位，只走 opacity 那条过渡
    if (!animate || !from || reducedMotion() || typeof navGlow.animate !== "function") return;
    const dx = from.left - left;
    const dy = from.top - top;
    if (dx || dy) {
      navGlowAnims.push(navGlow.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: NAV_GLOW_SLIDE_MS, easing: NAV_GLOW_EASE_SLIDE },
      ));
    }
    if (from.width !== width || from.height !== height) {
      navGlowAnims.push(navGlow.animate(
        [{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${width}px`, height: `${height}px` }],
        { duration: NAV_GLOW_RESIZE_MS, easing: NAV_GLOW_EASE_RESIZE },
      ));
    }
  }

  /* 容器尺寸变化（侧栏宽度拖拽 / 窗口 resize / 进出窄屏断点）走这条 —— 一律瞬时对齐。 */
  if (typeof ResizeObserver === "function") {
    navGlowResizeObs = new ResizeObserver(() => syncNavGlow({ animate: false }));
    navGlowResizeObs.observe(nav);
  }

  /* 一段可拖拽容器：直接子节点必须正好是插件按钮 —— attachPluginListDrag 的落点
     推演按「等高连续兄弟」累加高度，中间插进组头就会整体偏移。所以组头挂在容器外。
     跨段（跨卡片）拖动不支持，换组走右键改色。 */
  function plugSegNode(views, { pinned = false } = {}) {
    const seg = el("div", { class: `plug-seg${pinned ? " plug-seg-pinned" : ""}` }, views.map((pv) => navBtn(`plug:${pv.id}`, true)));
    if (desktopWindow && views.length > 1) {
      const readIds = () => [...seg.querySelectorAll(":scope > button[data-plugin-id]")].map((node) => node.dataset.pluginId);
      // 置顶段与常规段的落点容器是同一个，只是「松手后写哪张表」不同。
      attachPluginListDrag(seg, () => (pinned ? savePinnedOrder(readIds()) : saveSegmentOrder(readIds())));
    }
    return seg;
  }

  // 置顶段内拖拽：顺序落进 pinnedPlugins，不回填 pluginOrder —— 置顶区与常规排列是两套顺序，
  // 混着写会让「取消置顶回原位」失效。
  function savePinnedOrder(domIds) {
    if (!setPinnedPluginOrder([...new Set(domIds)])) return;
    toast("置顶顺序已保存");
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
    // 收放播完再对齐光块：nav 的盒子高度由 flex:1 定，折叠不改变它 -> ResizeObserver 盯不到这条
    // 路径，必须显式挂钩。选中项自己跟着收起时，syncNavGlow 会找不到按钮而让它淡出。
    const done = () => { delete group.dataset.folding; syncNavGlow(); };
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
    const imgIcon = isPlug ? pluginDisplayIcon(def.pluginView.pluginId, def.title) : navDisplayIcon(id, def.title);
    const outlineIcon = isPlug ? pluginDisplayOutlineIcon(def.pluginView.pluginId, def.title) : navDisplayOutlineIcon(id, def.title);
    const b = el("button", { class: on ? "on" : "", "data-view": id },
      el("span", { class: "ic", style: isPlug ? `--plugin-accent:${pluginAccent(def.pluginView?.pluginId)}` : null }, imgIcon, outlineIcon),
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
      // v0.152.0：行尾的悬停操作条（… 更多 / 📌 置顶）。鼠标停下才现身，延迟在 CSS 里。
      b.append(pluginNavActions(def.pluginView.pluginId, def.title));
    }
    return b;
  }

  /* v0.152.0：插件导航行尾的悬停操作条。
     外层是 <button>，而 HTML 不允许 button 嵌套 button —— 这两颗只能用
     span[role=button] 造：真 button 会被 `.nav button` 那条基线规则
     （display:flex + width:100% + padding 9px 12px）命中，行尾直接鼓成两个大块。
     只在桌面端挂：手机端侧栏是底栏、没有 hover，长按又已经被拖拽排序占了（见 pluginListDrag.js）。 */
  function pluginNavActions(pluginId, title) {
    const pinned = isPluginPinned(pluginId);
    const wrap = el("span", { class: "nav-actions" });
    // 键盘唤起菜单时没有指针坐标：用按钮自身的矩形当锚点（showContextMenu 只读 clientX/clientY）
    const keyAnchor = (node) => {
      const rect = node.getBoundingClientRect();
      return { clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {}, stopPropagation() {} };
    };
    const make = (act, label, icon, activate) => {
      const node = el("span", {
        class: `nav-act${act === "pin" && pinned ? " on" : ""}`,
        role: "button",
        tabindex: "0",
        title: label,
        "aria-label": label,
        "aria-pressed": act === "pin" ? String(pinned) : null,
        "data-act": act,
      }, faIcon(icon));
      // 外层就是插件导航按钮：不拦下这一次事件，「更多」会顺手把页面切进该插件
      node.addEventListener("pointerdown", (event) => event.stopPropagation());
      node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        activate(event);
      });
      node.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        activate(keyAnchor(node));
      });
      return node;
    };
    wrap.append(
      make("more", `「${title}」更多操作`, "ellipsis", (anchor) => openPluginContextMenu(anchor, pluginId)),
      make("pin", pinned ? `取消置顶「${title}」` : `把「${title}」置顶到最上方`, "thumbtack", () => togglePin(pluginId)),
    );
    return wrap;
  }

  /* 置顶只改 pinnedPlugins、不动 pluginOrder：取消置顶后插件回到常规排列里的原位置。
     侧栏整段重绘走 FLIP，插件从分组卡片飞到置顶区（或飞回去）都有位移动画。 */
  function togglePin(pluginId) {
    const nowPinned = togglePluginPin(pluginId);
    flipNav(renderNav);
    const rec = getRegistry().find((item) => item.id === pluginId);
    const name = pluginDisplayName(pluginId, rec?.manifest?.name || pluginViews.find((pv) => pv.pluginId === pluginId)?.title || pluginId);
    toast(nowPinned ? `「${name}」已置顶，固定在插件区最上方` : `「${name}」已取消置顶`);
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
    mobileLabel: "主题",
    className: "theme-toggle-btn",
    icon: () => faIcon(themeModeGlyph()),
    onMount: (btn) => {
      const update = () => {
        const dark = resolveThemeMode() === "dark";
        btn.querySelector(".ic")?.replaceChildren(faIcon(themeModeGlyph()));
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
    icon: () => outlineAppIcon("settings", "设置"),
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
    if (isAndroidRuntime()) btn.append(el("span", { class: "rail-dock-label" }, def.mobileLabel || def.label));
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

  if (!isAndroidRuntime()) attachRailDockDrag(railDock, () => {
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
    // Android 底栏常驻，设置页为底栏预留空间；其他窄屏环境保留收起与恢复行为。
    if (settingsLayers === 0) railShownBeforeSettings = chromeShown;
    settingsLayers += 1;
    appFrame.classList.add("settings-open");
    if (chromeShown && mobileQuery.matches && !isAndroidRuntime()) setChromeShown(false);
    document.querySelector(".settings-modal")?._close?.();
    const androidSettings = isAndroidRuntime() && mobileQuery.matches;
    // 启动动画会让 app 保留层叠上下文；设置期间把同一条底栏放到独立层，避免被 body 遮罩挡住。
    const dockLayer = androidSettings ? el("div", { class: "app android-runtime android-settings-dock" }, rail) : null;
    const mask = el("div", { class: `drawer-mask settings-modal-mask${androidSettings ? " android-settings-mask" : ""}`, onclick: close });
    const panel = el("section", { class: `settings-modal${androidSettings ? " android-settings-modal" : ""}`, role: "dialog", "aria-modal": String(!androidSettings), "aria-label": "设置" },
      el("header", { class: "settings-modal-head", "data-tauri-drag-region": dragRegion },
        el("div", {},
          el("h2", {}, "设置"),
          el("p", { class: "desc" }, "界面、提醒、数据与扩展"),
        ),
        el("button", { class: "btn ghost sm", type: "button", onclick: close }, "关闭"),
      ),
      el("div", { class: "settings-modal-body" }),
      createSettingsLayoutControls(),
    );
    function onKey(event) { if (event.key === "Escape") close(); }
    // 幂等：点遮罩关掉后，重开设置那句 `._close?.()` 还会再敲一次同一个面板。
    let dismissed = false;
    function close() {
      if (dismissed) return;
      dismissed = true;
      panel.querySelector(".settings-modal-body")?._unsub?.();
      panel.querySelector(".settings-modal-footer")?._dispose?.();
      if (dockLayer) {
        railResizer.before(rail);
        dockLayer.remove();
      }
      closeLayer(panel, mask, () => document.removeEventListener("keydown", onKey));
      settingsLayers = Math.max(0, settingsLayers - 1);
      if (settingsLayers === 0) appFrame.classList.remove("settings-open");
      if (settingsLayers === 0) settingsDockBtn?.classList.remove("on");
      if (settingsLayers === 0 && railShownBeforeSettings && mobileQuery.matches) {
        railShownBeforeSettings = false;
        setChromeShown(true);
      }
    }
    panel._close = close;
    settingsDockBtn?.classList.add("on");
    document.addEventListener("keydown", onKey);
    document.body.append(mask, panel);
    if (dockLayer) document.body.append(dockLayer);
    updateDockClearance();
    const pageBack = el("button", { class: "btn ghost sm settings-page-back", type: "button", hidden: true,
      onclick: () => panel._back?.(), "aria-label": "返回设置列表" }, "‹ 返回设置");
    panel.querySelector(".settings-modal-head").prepend(pageBack);
    renderSettings(panel.querySelector(".settings-modal-body"), { section, target,
      onNavigator: (nav) => { panel._back = () => nav.node._back(); },
      onPageChange: (entry) => {
        pageBack.hidden = !entry;
        panel.querySelector(".settings-modal-head h2").textContent = entry?.label || "设置";
        panel.querySelector(".settings-modal-head .desc").textContent = entry?.hint || "界面、提醒、数据与扩展";
      },
    });
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
    if (isAndroidRuntime()) show = true;
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
    /* v0.152.0：底栏的呼出/收起会改 .rail 的盒模型（display: none ⇄ flex），而光块的
       包含块就是 .rail —— 包含块从"无"变"有"时没人落位的话，底栏会先亮着滑出来、
       选中光块要等下一次 renderNav（用户下一次切页）才淡入，看着像"呼出后没有高亮"。
       这里显式落位一次（瞬时，不滑）。收起方向也调：`.rail-hiding` 期间底栏仍是
       display:flex，所以滑出动画里光块照旧跟着，落地后 offsetParent 变 null 自然淡出。 */
    syncNavGlow({ animate: false });
    chromeToggle.setAttribute("aria-expanded", String(show));
    chromeToggle.title = show ? "收起菜单" : "显示菜单";
  }
  if (isAndroidRuntime()) setChromeShown(true);
  // v0.108.0：呼出态点空白即收起。此前底栏只跟着「再按 ⋮ / 打开设置」消失，用户
  // 点内容区没有任何反馈，还得再找那颗 ⋮ —— 与 Android「弹出的面板，点外部即收」
  // 的肌肉记忆相悖。捕获阶段监听 pointerdown：不 preventDefault、不 stopPropagation，
  // 收起与「点到的那个控件照常工作」同时发生（收起绝不抢点击）。两颗悬浮键本身排除：
  // ⋮ 自带 toggle onclick（排除避免先收起再被点击重新呼出），‹ 是返回（返回后底栏
  // 保留是既有语义）。
  document.addEventListener("pointerdown", (e) => {
    if (isAndroidRuntime()) return;
    if (!chromeShown || !mobileQuery.matches) return;
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".rail, .chrome-toggle, .mobile-back")) return;
    setChromeShown(false);
  }, true);
  // 手机上沿内容向上滑一段距离即可呼出底栏；插件里的纵向滚动也会冒泡到 .view。
  // 只认明显的纵向单指手势，横向课表/返回手势和拖拽排序仍归原来的处理器。
  let railSwipeStart = null;
  view.addEventListener("touchstart", (event) => {
    railSwipeStart = event.touches.length === 1
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
      : null;
  }, { passive: true });
  view.addEventListener("touchcancel", () => { railSwipeStart = null; }, { passive: true });
  view.addEventListener("touchend", (event) => {
    if (isAndroidRuntime()) return;
    const start = railSwipeStart;
    railSwipeStart = null;
    if (!start || event.changedTouches.length !== 1 || !mobileQuery.matches || chromeShown || settingsLayers > 0) return;
    if (document.body.dataset.swipeSuspended === "1") return;
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    if (dy <= -72 && Math.abs(dy) > Math.abs(dx) * 1.4) setChromeShown(true);
  }, { passive: true });
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
    if (isAndroidRuntime() && settingsLayers > 0) document.querySelector(".settings-modal")?._close?.();
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
      // .view is shared by every page; retain scroll only when refreshing the same view.
      if (prevId !== targetId) view.scrollTop = 0;
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
        enterPage(view, dir);
        const titleCard = titleEl.closest(".topbar-title-card");
        if (titleCard?.animate && !reducedMotion()) {
          const titleOffset = dir === "left" ? 4 : -4;
          titleCard.animate([
            { opacity: .36, transform: `translate3d(${titleOffset}px, 0, 0)` },
            { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
          ], { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" });
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

    // v0.184.0：框内不再写中文占位词，只留一颗放大镜（见 src/searchField.js）。
    const search = el("input", { class: "market-search", type: "search", value: query, placeholder: "", "aria-label": "搜索插件" });
    const searchBox = withSearchGlyph(search);
    const filterBox = el("div", { class: "market-filters" });
    const grid = el("div", { class: "market-grid" });
    // 卡片尺寸（v0.181.0）：在任意一张卡片上按住拖动即可调整**全部**卡片的大小
    // （水平位移 = 宽，垂直位移 = 高，见 src/marketCardResize.js）。
    // 网格空白处双击恢复默认 —— 拖动是唯一入口，得留一条零成本的退路。
    attachMarketCardResize(grid, {
      onCommit: (size) => toast(`卡片大小：宽 ${size.marketCardWidth} × 高 ${size.marketCardHeight}`),
    });
    grid.addEventListener("dblclick", (event) => {
      if (event.target !== grid) return;
      resetMarketCardSize();
      toast("卡片大小已恢复默认");
    });
    const cardRefreshers = new Map();
    let registrySnapshot = [], visibleIds = new Set();
    // 启停只同步现有节点；导入/删除或筛选成员变化才执行 FLIP 重排。
    refreshMarketState = () => {
      if (!grid.isConnected) return;
      const regs = getRegistry();
      const matched = regs.filter(match);
      const membershipChanged = regs.length !== registrySnapshot.length
        || regs.some((rec, i) => rec !== registrySnapshot[i])
        || matched.length !== visibleIds.size || matched.some((rec) => !visibleIds.has(rec.id));
      if (membershipChanged) {
        const focusedId = document.activeElement?.closest?.(".mcard")?.dataset.cardId;
        paintCards({ flip: true });
        if (focusedId) {
          const remaining = [...grid.querySelectorAll(".mcard")].find((node) => node.dataset.cardId === focusedId);
          (remaining?.querySelector(".market-plugin-switch") || search).focus({ preventScroll: true });
        }
      } else {
        cardRefreshers.forEach((refresh) => refresh());
      }
      // 不重建筛选按钮，避免点击开关时重置焦点。
      [...filterBox.children].forEach((button, i) => {
        button.querySelector(".market-filter-count").textContent = String(countFor(filters[i][0]));
      });
    };

    const filters = [
      ["all", "全部"], ["enabled", "已启用"], ["disabled", "已停用"], ["builtin", "内置"], ["user", "用户插件"],
    ];
    // 各筛选档的数量跟随当前搜索词（忽略筛选维度本身），直接显示在按钮里
    function countFor(id) {
      const q = query.trim().toLowerCase();
      return getRegistry().filter((rec) => {
        const man = rec.manifest || {};
        let enabled = S.pluginState(rec.id).enabled !== false;
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
      cardRefreshers.clear();
      registrySnapshot = getRegistry();
      visibleIds = new Set(registrySnapshot.filter(match).map((rec) => rec.id));
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
        let enabled = S.pluginState(rec.id).enabled !== false;
        const cardViews = pluginViews.filter((v) => v.pluginId === rec.id);
        let pv = cardViews[0];
        // APK 没有桌面插件侧栏，多视图插件必须在插件中心暴露全部入口。
        let viewLinks = isAndroidRuntime() && cardViews.length > 1
          ? el("div", { class: "market-view-links", "aria-label": `${pluginName} 功能入口` },
            cardViews.map((item) => el("button", {
              class: "btn ghost sm", type: "button", disabled: !enabled ? true : null,
              "data-plugin-view": item.id,
              onclick: (e) => { e.stopPropagation(); switchTo(`plug:${item.id}`); },
            }, faIcon(item.icon || "puzzle-piece"), el("span", {}, item.title))))
          : null;
        // v0.180.0：卡片自己就是打开入口（点卡片、回车都能进对应视图），
        // 原来那枚「打开」按钮和它完全重复，用户反馈没用 —— 已删除。
        const toggle = el("button", {
          class: `switch market-plugin-switch${enabled ? " on" : ""}`,
          "data-motion": "off", // 使用滑块自身过渡，不叠加通用按钮波纹/回弹。
          role: "switch",
          "aria-checked": String(enabled),
          "aria-label": `${enabled ? "关闭" : "开启"}${pluginName}`,
          title: enabled ? "关闭插件" : "开启插件",
          onclick: async (e) => {
            e.stopPropagation();
            if (marketTogglePending.has(rec.id)) return;
            const next = !enabled;
            marketTogglePending.add(rec.id);
            // 按插件 ID 锁定，快速重复点击/筛选重建也不会发出并行启停请求。
            refreshCard();
            try {
              await setEnabled(rec.id, next);
              if (next && rec.error) toast(`「${pluginName}」加载失败：${rec.error}`);
            } catch (err) {
              toast(`切换失败：${err.message || err}`);
            } finally {
              marketTogglePending.delete(rec.id);
              // 以宿主实际状态为准，不把已经失败的加载伪装成可打开。
              refreshMarketState?.();
            }
          },
        });
        const switchControl = el("div", { class: "market-switch-control" },
          el("span", { class: "market-switch-text", "aria-live": "polite", "aria-atomic": "true" }, enabled ? "已开启" : "已关闭"),
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
            if (marketTogglePending.has(rec.id) || rec.error) return;
            if (!enabled) return toast("请先开启这个插件");
            if (pv) switchTo(`plug:${pv.id}`);
          },
          onkeydown: (e) => {
            if (marketTogglePending.has(rec.id) || rec.error || !pv || !enabled || !isSelfActivationKey(e)) return;
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
          viewLinks,
          el("div", { class: "market-card-actions" }, switchControl, el("button", {
            class: "market-card-more",
            type: "button",
            title: "重命名、改图标与分组颜色",
            "aria-label": `${pluginName} 更多操作`,
            onclick: (e) => { e.stopPropagation(); openPluginContextMenu(e, rec.id); },
          }, "⋯")),
        );
        let viewSignature = cardViews.map((item) => `${item.id}:${item.title}:${item.icon}`).join("|");
        const refreshCard = () => {
          const before = enabled;
          enabled = S.pluginState(rec.id).enabled !== false;
          const busy = marketTogglePending.has(rec.id);
          const views = pluginViews.filter((item) => item.pluginId === rec.id);
          pv = views[0];
          const signature = views.map((item) => `${item.id}:${item.title}:${item.icon}`).join("|");
          if (signature !== viewSignature) {
            viewSignature = signature;
            viewLinks?.remove();
            viewLinks = isAndroidRuntime() && views.length > 1
              ? el("div", { class: "market-view-links", "aria-label": `${pluginName} 功能入口` },
                views.map((item) => el("button", {
                  class: "btn ghost sm", type: "button", "data-plugin-view": item.id,
                  onclick: (e) => { e.stopPropagation(); if (!marketTogglePending.has(rec.id) && S.pluginState(rec.id).enabled !== false) switchTo(`plug:${item.id}`); },
                }, faIcon(item.icon || "puzzle-piece"), el("span", {}, item.title)))) : null;
            if (viewLinks) card.insertBefore(viewLinks, card.querySelector(".market-card-actions"));
          }
          viewLinks?.querySelectorAll("button").forEach((button) => { button.disabled = busy || !enabled; });
          card.classList.toggle("disabled", !enabled);
          card.classList.toggle("plugin-toggle-pending", busy);
          card.setAttribute("aria-busy", String(busy));
          // 卡片自己就是打开入口；停用态靠点击拦截与 .disabled 表达，
          // 不对包含可用开关的整张卡片标 aria-disabled。
          if (pv) { card.setAttribute("role", "button"); card.setAttribute("tabindex", "0"); }
          else { card.removeAttribute("role"); card.removeAttribute("tabindex"); }
          // 不用 disabled 摘走键盘焦点；处理函数的 pending 守卫阻止重复请求。
          toggle.setAttribute("aria-disabled", String(busy));
          toggle.classList.toggle("on", enabled);
          toggle.setAttribute("aria-checked", String(enabled));
          toggle.setAttribute("aria-label", `${enabled ? "关闭" : "开启"}${pluginName}`);
          toggle.title = enabled ? "关闭插件" : "开启插件";
          const label = switchControl.querySelector(".market-switch-text");
          const status = busy ? "切换中…" : enabled && rec.error ? "加载失败" : enabled ? "已开启" : "已关闭";
          if (label.textContent !== status) label.textContent = status;
          if (before !== enabled && !reducedMotion() && label.animate) {
            label.getAnimations().forEach((animation) => animation.cancel());
            label.animate([{ opacity: .65, transform: "translateY(2px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 180, easing: "ease-out" });
          }
          let error = card.querySelector(".perr");
          if (rec.error) {
            if (!error) { error = el("div", { class: "perr" }); card.insertBefore(error, card.querySelector(".market-card-actions")); }
            error.textContent = rec.error;
          } else error?.remove();
        };
        cardRefreshers.set(rec.id, refreshCard);
        refreshCard();
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
    }, searchGlyph("market-search-glyph"));
    if (marketSearchOpen) wrap.classList.add("open-search");
    // 搜索开关放在筛选按钮下面（用户反馈：顶部只留筛选档，别多占一行）。
    // 这里原来还带着一个「显示 N / N」计数，已移除：筛选档每枚自带数量，
    // 那行唯一的实际作用是**把搜索框和标签行隔开一行**（用户要求搜索紧跟标签行）。
    wrap.append(
      filterBox,
      el("div", { class: "market-head" },
        el("div", { class: "market-head-tools" }, searchToggle),
      ),
      el("div", { class: "market-search-row", id: "market-search-row" }, searchBox),
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
    else if (activeView === "market") refreshMarketState?.();
    else if (activeView.startsWith("plug:")) switchTo(activeView, undefined, { history: false });
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

// 横向工具区共用同一套跟手 / 实时让位 / 落位动画与键盘重排。
// 保留侧栏接线入口，业务顺序与动作注册仍由 railActions 管理。
function attachRailDockDrag(list, onCommit) {
  return attachToolbarDrag(list, onCommit);
}
