import * as S from "./store.js";
import { CUSTOM_SIZE_LIMITS } from "./windowSize.js";
import { isDesktopRuntime } from "./windowSize.js";
import { DEFAULT_UI_SCALE, applyUiScale, normalizeUiScale } from "./uiScale.js";

/* ── 核心视图的平台清单（v0.52.0）──
   APK（移动运行时）用「时间线」替代「时间块 / 收件箱」：手机上没有拖拽排程的交互价值，
   时间线按日期串起安排与截止更适合竖屏浏览。桌面端保持原四视图，且没有时间线入口。
   消费方：shell.js（导航 / 翻页序 / 快捷菜单）与 settings/appearance.js（启动页下拉）。 */
export const MOBILE_CORE_VIEWS = Object.freeze(["quadrant", "timeline", "market"]);
export const DESKTOP_CORE_VIEWS = Object.freeze(["quadrant", "timeblock", "inbox", "market"]);
export function coreViewIds() {
  return isDesktopRuntime() ? DESKTOP_CORE_VIEWS : MOBILE_CORE_VIEWS;
}

/** 「文字大小」合法区间与步进（百分比）。v0.55.0 起 80~150（旧为 90~120）：
 *  只动 font-size 不动盒模型，拉宽区间也不会撑破布局；与界面缩放（uiScale）同区间同步进，
 *  两个滑杆的手感一致。设置页滑杆的 min/max/step 必须从这里取，不许再写死。 */
export const TEXT_SCALE_LIMITS = Object.freeze({ min: 80, max: 150, step: 5 });
export const NAV_WIDTH_LIMITS = Object.freeze({ min: 60, max: 100, step: 1 });
export const NAV_TRANSPARENCY_LIMITS = Object.freeze({ min: 0, max: 100, step: 1 });

export const DEFAULT_UI_PREFERENCES = Object.freeze({
  // 默认紧凑：小屏与笔记本上信息密度优先；想要宽松的用户可在设置里切回「舒适」
  density: "compact",
  textScale: 100,
  // 界面整体缩放（80~150）：与只动字号的 textScale 分工不同，这里连控件、间距、图标一起缩放。
  // 实现与三个坑见 src/uiScale.js 头部注释 —— 改这个字段前先读那一页。
  uiScale: DEFAULT_UI_SCALE,
  motion: "system",
  nepheleBackground: true,
  nepheleSettings: true,
  // 保持历史行为：老用户升级后仍交给系统浏览器；显式开启才走应用内网页窗口。
  openLinksInApp: false,
  swipeNavigation: true,
  showTopStats: true,
  // v0.57.0：默认居中（用户需求「待办/已完成默认居中」）。归一化用 !==false：
  // 老数据里没写过这个键 → 落新默认 true；显式关过（false）的用户保持关闭。
  centerTopStats: true,
  showViewSubtitle: true,
  // 多条横幅叠成一张、鼠标移上去才展开（src/notifyStack.js）。关掉回到逐条竖排。
  // 只在有真实指针的设备上有意义，触屏恒定走竖排（判据在 CSS 的媒体查询里）。
  notifyStack: true,
  // 设置中心的辅助说明：默认显示；“无描述”预设只隐藏说明，不影响标题、控件和状态反馈。
  showSettingsDescriptions: true,
  // auto 保留升级前的布局；用户在设置底部选择后固定为顶部或左侧。
  settingsNavPosition: "auto",
  startupView: "last",
  // 手机底栏高度档位：紧凑 40px / 标准 46px / 宽松 54px（按钮最小高，CSS 变量消费）
  navBarSize: "standard",
  // v0.108.0：手机底栏形态 —— float = 悬空玻璃（默认，四周留缝浮起）；
  // docked = 贴底通宽（v0.105 之前的形态：悬浮量归零、压平四角）。
  navDock: "float",
  navWidth: 100,
  // 在当前材质上增加透明度，0 保留已有毛玻璃或实色效果，100 为透明背景。
  navTransparency: 0,
  // v0.110.0：悬浮键（‹ 返回 / ⋮ 菜单）垂直锚点档位（35 / 45 / 55，百分比）。
  // 默认 45 = v0.52.1 实测对各类视图遮挡最少的档位；互换只对调两颗键的左右。
  fabHeight: 45,
  fabSwap: false,
  // v0.108.0：手机底栏材质 —— frosted = 毛玻璃（默认）；solid = 实色
  // （低端 WebView 关掉 backdrop-filter，滚动更稳、更省电）。
  navGlass: "frosted",
  // 启动窗口大小：默认标准窗口，接近常见聊天/工作应用的中等尺寸；想更大或更小可在设置中改。
  startupWindowMode: "standard",
  startupWindowWidth: 1360,
  startupWindowHeight: 860,
});

export const NAVBAR_SIZE_OPTIONS = Object.freeze([
  ["compact", "紧凑"],
  ["standard", "标准"],
  ["relaxed", "宽松"],
]);

export const STARTUP_VIEW_OPTIONS = Object.freeze([
  ["last", "继续上次页面"],
  ["quadrant", "任务表"],
  ["timeline", "时间线（手机端）"],
  ["timeblock", "时间块"],
  ["inbox", "收件箱"],
  ["market", "插件中心"],
]);

/** 启动窗口大小的可选模式。具体的像素值在 windowSize.js —— 那边才是尺寸的单一事实源。 */
export const WINDOW_SIZE_MODES = Object.freeze(["auto", "small", "compact", "standard", "large", "full", "custom"]);

export const WINDOW_SIZE_OPTIONS = Object.freeze([
  ["auto", "跟随屏幕 · 最高 1440 × 900"],
  ["small", "小窗 · 720 × 620"],
  ["compact", "小巧 · 1120 × 720"],
  ["standard", "标准 · 1360 × 860（推荐）"],
  ["large", "宽大 · 1600 × 1000"],
  ["full", "铺满可用区域"],
  ["custom", "自定义尺寸"],
]);

const DENSITIES = new Set(["comfortable", "compact"]);
const MOTIONS = new Set(["system", "full", "reduced"]);
const NAVBAR_SIZES = new Set(NAVBAR_SIZE_OPTIONS.map(([id]) => id));
const NAV_DOCKS = new Set(["float", "docked"]);
const NAV_GLASSES = new Set(["frosted", "solid"]);
const FAB_HEIGHTS = new Set([35, 45, 55]);
const STARTUP_VIEWS = new Set(STARTUP_VIEW_OPTIONS.map(([id]) => id));
const WINDOW_SIZE_MODES_SET = new Set(WINDOW_SIZE_MODES);

function clamp(v, lo, hi) {
  const n = Number(v);
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

export function normalizeUiPreferences(raw = {}) {
  const next = { ...DEFAULT_UI_PREFERENCES, ...(raw || {}) };
  if (!DENSITIES.has(next.density)) next.density = DEFAULT_UI_PREFERENCES.density;
  if (!MOTIONS.has(next.motion)) next.motion = DEFAULT_UI_PREFERENCES.motion;
  if (!NAVBAR_SIZES.has(next.navBarSize)) next.navBarSize = DEFAULT_UI_PREFERENCES.navBarSize;
  if (!NAV_DOCKS.has(next.navDock)) next.navDock = DEFAULT_UI_PREFERENCES.navDock;
  if (!NAV_GLASSES.has(next.navGlass)) next.navGlass = DEFAULT_UI_PREFERENCES.navGlass;
  for (const [key, limits] of [["navWidth", NAV_WIDTH_LIMITS], ["navTransparency", NAV_TRANSPARENCY_LIMITS]]) {
    const value = next[key];
    next[key] = value === null || value === "" || !Number.isFinite(Number(value))
      ? DEFAULT_UI_PREFERENCES[key]
      : Math.round(clamp(value, limits.min, limits.max));
  }
  next.fabHeight = FAB_HEIGHTS.has(next.fabHeight) ? next.fabHeight : DEFAULT_UI_PREFERENCES.fabHeight;
  next.fabSwap = next.fabSwap === true;
  if (!STARTUP_VIEWS.has(next.startupView)) next.startupView = DEFAULT_UI_PREFERENCES.startupView;
  next.textScale = Math.round(clamp(next.textScale, TEXT_SCALE_LIMITS.min, TEXT_SCALE_LIMITS.max) / TEXT_SCALE_LIMITS.step) * TEXT_SCALE_LIMITS.step;
  next.uiScale = normalizeUiScale(next.uiScale);
  next.openLinksInApp = next.openLinksInApp === true;
  next.nepheleBackground = next.nepheleBackground === true;
  next.nepheleSettings = next.nepheleSettings === true;
  next.swipeNavigation = next.swipeNavigation !== false;
  next.showTopStats = next.showTopStats !== false;
  // v0.57.0 起 centerTopStats 默认 true：只有显式 false 才算关（缺省 = 开）。
  // 上一版语义是 ===true（缺省 = 关），默认值翻转后必须同步放宽，否则存档里
  // 没有该键的老用户会永远停在「不居中」，新默认形同虚设。
  next.centerTopStats = next.centerTopStats !== false;
  next.showViewSubtitle = next.showViewSubtitle !== false;
  next.notifyStack = next.notifyStack !== false;
  next.showSettingsDescriptions = next.showSettingsDescriptions !== false;
  if (!["auto", "top", "left"].includes(next.settingsNavPosition)) next.settingsNavPosition = "auto";
  if (!WINDOW_SIZE_MODES_SET.has(next.startupWindowMode)) next.startupWindowMode = DEFAULT_UI_PREFERENCES.startupWindowMode;
  next.startupWindowWidth = Math.round(clamp(next.startupWindowWidth, CUSTOM_SIZE_LIMITS.minWidth, CUSTOM_SIZE_LIMITS.maxWidth));
  next.startupWindowHeight = Math.round(clamp(next.startupWindowHeight, CUSTOM_SIZE_LIMITS.minHeight, CUSTOM_SIZE_LIMITS.maxHeight));
  return next;
}

export function getUiPreferences() {
  const st = S.getState()?.settings;
  if (!st) return normalizeUiPreferences();
  st.ui = normalizeUiPreferences(st.ui || {});
  return st.ui;
}

export function applyUiPreferences(raw = null, { animate = false } = {}) {
  const cfg = normalizeUiPreferences(raw || getUiPreferences());
  if (typeof document === "undefined") return cfg;
  const root = document.documentElement;
  root.dataset.uiDensity = cfg.density;
  root.dataset.uiMotion = cfg.motion;
  root.dataset.nepheleBackground = cfg.nepheleBackground ? "on" : "off";
  root.dataset.nepheleSettings = cfg.nepheleSettings ? "on" : "off";
  root.dataset.openLinksInApp = cfg.openLinksInApp ? "on" : "off";
  // 注意：dataset.navbar 才生成 data-navbar；写成 dataset.navBar 会变成 data-nav-bar，
  // CSS 的 :root[data-navbar=…] 选择器就匹配不上了
  root.dataset.navbar = cfg.navBarSize;
  // dataset.navDock → data-nav-dock、dataset.navGlass → data-nav-glass（驼峰自动转
  // 连字符，与上一行 data-navbar 同一批 CSS 消费方，见 styles.css 的 ≤900px 媒体块）
  root.dataset.navDock = cfg.navDock;
  root.dataset.navGlass = cfg.navGlass;
  root.dataset.navWidth = String(cfg.navWidth);
  root.style.setProperty("--nav-width", String(cfg.navWidth / 100));
  root.style.setProperty("--nav-surface-alpha", String(1 - cfg.navTransparency / 100));
  // 悬浮键档位（data-fab-v）与左右互换（data-fab-swap）：styles.css ≤900px 媒体块消费
  root.dataset.fabV = String(cfg.fabHeight);
  root.dataset.fabSwap = cfg.fabSwap ? "on" : "off";
  root.dataset.showTopStats = cfg.showTopStats ? "on" : "off";
  root.dataset.centerTopStats = cfg.centerTopStats ? "on" : "off";
  root.dataset.showViewSubtitle = cfg.showViewSubtitle ? "on" : "off";
  root.dataset.settingsDescriptions = cfg.showSettingsDescriptions ? "on" : "off";
  root.dataset.settingsNavPosition = cfg.settingsNavPosition;
  // dataset.notifyStack → data-notify-stack（写成 data-notifyStack 之类 CSS 匹配不上）
  root.dataset.notifyStack = cfg.notifyStack ? "on" : "off";
  root.style.setProperty("--ui-text-scale", String(cfg.textScale / 100));
  // 界面整体缩放走独立模块（挂 zoom + 注入 --ui-vw/--ui-vh，见 src/uiScale.js）。
  // 放在这里而不是 applyUiScale 的调用点，是为了「任何写入偏好的路径都会重算缩放」——
  // 否则恢复默认、预设切换这些入口会漏掉。
  // animate 只在显式传入时为 true：启动 / 初始化路径（initUiPreferences 等）必须直设，
  // 否则应用打开时能看到界面从 100% 「长大」到存储值 —— 那是 bug 不是动画。
  applyUiScale(cfg.uiScale, { animate });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("tide:ui-preferences-changed", { detail: { ...cfg } }));
  }
  return cfg;
}

export function setUiPreferences(patch, { persist = true, animate = false } = {}) {
  const st = S.getState().settings;
  st.ui = normalizeUiPreferences({ ...(st.ui || {}), ...(patch || {}) });
  applyUiPreferences(st.ui, { animate });
  if (persist) S.persistSoon();
  return st.ui;
}

export function resetUiPreferences() {
  const st = S.getState().settings;
  st.ui = { ...DEFAULT_UI_PREFERENCES };
  // 恢复默认（常含 uiScale: 100 ←→ 当前可能停在 150%）是用户触发的可见跳变，走动画。
  // 若当前值本来就是默认值，applyUiScale 内部「值没变」短路，不会白动。
  applyUiPreferences(st.ui, { animate: true });
  S.persistSoon();
  return st.ui;
}

export function initUiPreferences() {
  const st = S.getState().settings;
  st.ui = normalizeUiPreferences(st.ui || {});
  applyUiPreferences(st.ui);
  return st.ui;
}
