import { api } from "./api.js";
import * as S from "./store.js";
import { THEMES, getThemeProfile } from "./themeProfiles.js";

export { THEMES } from "./themeProfiles.js";

let transitionTimer = 0;
let systemThemeListenerBound = false;
let lastPointer = null;

function prefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

function normalizeThemeMode(mode) {
  return ["system", "light", "dark"].includes(mode) ? mode : "system";
}

export function getThemeMode() {
  const st = S.getState()?.settings;
  return normalizeThemeMode(st?.themeMode);
}

/** 用户偏好 + 系统偏好 → 实际生效的亮度（"light" / "dark"）。 */
export function resolveThemeMode(mode = getThemeMode()) {
  const normalized = normalizeThemeMode(mode);
  if (normalized === "light" || normalized === "dark") return normalized;
  return prefersDark() ? "dark" : "light";
}

/**
 * 主题 id + 模式 → 最终生效的主题与色板。
 *
 * ⚠️ 这里曾经是「只要想要深色就一律返回 night」，于是深色模式下选任何主题都没有变化
 * （「切换主题没用」的根因）。现在每套主题都有自己的深色变体
 * （见 src/styles/theme-derived.css），所以深色模式下换主题会真的换。
 *
 * night 是原生深色主题：不受显示模式影响，始终用自己那套深色色板。
 */
export function resolveTheme(id, mode = getThemeMode()) {
  const requested = getThemeProfile(id).id;
  if (requested === "night") return { id: "night", dark: true, mode: "dark" };
  const dark = resolveThemeMode(mode) === "dark";
  return { id: requested, dark, mode: dark ? "dark" : "light" };
}

/* ── 切换动画（v0.50.0 批次）──
   旧实现的问题：animate 的门槛是「主题 id 变了」，而浅色↔深色只是模式变化、
   id 不变 → 全屏配色瞬间跳变，比有动画还突兀；就算走了动画，
   .theme-transitioning 也只覆盖 9 类元素，其余区域照样瞬跳，半渐变半闪变更乱。

   现在：
   ① 主路径 View Transitions（Tauri 的 WebView2 / 新版 Android WebView 都支持）——
      整页快照做一次圆形揭示，从最近一次按下的位置向外扩散（无坐标则从屏幕中心），
      全页统一、无任何元素被落下；
   ② 不支持的环境降级为 .theme-transitioning 全元素过渡（styles.css 同名规则）；
   ③ 动效偏好「减少动效」（data-ui-motion=reduced 或系统 prefers-reduced-motion）直接应用，不出动画。 */

function themeMotionAllowed() {
  const root = document.documentElement;
  const pref = root.dataset.uiMotion || "system";
  if (pref === "reduced") return false;
  if (pref === "full") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches !== true;
}

/** 对 root 应用一次主题变化，动画路径由 runThemeMutation 决定。 */
function paintTheme(root, preference, resolved) {
  root.dataset.themePref = preference;
  root.dataset.theme = resolved.id;
  // CSS 靠 data-theme-mode 决定用浅色还是深色变体；必须是「解析后的 light/dark」，
  // 写成 "system" 会让所有深色选择器失效。
  root.dataset.themeMode = resolved.mode;
  root.style.colorScheme = resolved.mode;
  syncSystemBarIcons(resolved.mode);
}

/**
 * 把网页实际亮度同步给系统栏图标（状态栏 / 导航栏）。
 *
 * ## 为什么必须做（v0.51.0 修的「状态栏文字看不见」）
 *
 * Android 端 `MainActivity` 调了 `enableEdgeToEdge()` ⇒ 状态栏与导航栏是**透明浮层**
 * 盖在 WebView 上，系统栏图标直接压在网页顶部 / 底部那一条的背景上。
 * 但图标颜色是 Android 按**应用主题的 light/dark** 决定的
 * （`Theme.letime` 继承 `DayNight`，只跟随**系统深色模式**），
 * **完全不知道网页的 `data-theme-mode`**。
 *
 * 两者不一致时图标必然消失在背景里 —— 真浏览器实测：
 *
 * | 系统 | 网页 | 状态栏带底色 | 图标 | 对比度 | |
 * |---|---|---|---|---|---|
 * | 深色 | 浅色 | 浅 rgb(253,253,252) | 白 | **1.02** | 看不见 |
 * | 浅色 | 深色 | 深 rgb(42,38,32) | 近黑 | **1.16** | 看不见 |
 * | 深色 | 深色 | 深 | 白 | 15.04 | ✓ |
 * | 浅色 | 浅色 | 浅 | 近黑 | 17.10 | ✓ |
 *
 * （判据 3.0 = 图形元素对比度下限。设置弹窗是 `inset:0` 全屏贴顶，
 * 「设置 → API Key」那一页最容易撞上。）
 *
 * 传 `darkIcons = (mode === "light")`：浅色背景要深色图标，与 Android 的
 * `isAppearanceLightStatusBars` 语义一致。非 Tauri 与桌面端都会安全空转。
 *
 * 刻意**不 await、不 catch 到上层**：这是纯装饰性同步，失败绝不能阻断换主题。
 */
function syncSystemBarIcons(mode) {
  try {
    api.systemBar(mode === "light")?.catch?.(() => {});
  } catch (_) {
    // 原生命令不可用（旧版原生层 / 纯浏览器）时静默忽略
  }
}

function runThemeMutation(root, mutate) {
  if (!themeMotionAllowed()) {
    mutate();
    return;
  }
  const doc = document;
  if (typeof doc.startViewTransition === "function") {
    // 圆形揭示的起点：最近一次按下的位置；没有（系统自动切换 / 程序触发）就从屏幕中心扩散。
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const p = lastPointer || { x: w / 2, y: h / 2 };
    // 半径 = 起点到最远角的距离，保证圆形扫过整个视口。
    const r = Math.ceil(Math.hypot(Math.max(p.x, w - p.x), Math.max(p.y, h - p.y))) || Math.ceil(Math.hypot(w, h));
    root.style.setProperty("--theme-reveal-x", `${p.x}px`);
    root.style.setProperty("--theme-reveal-y", `${p.y}px`);
    root.style.setProperty("--theme-reveal-r", `${r}px`);
    doc.startViewTransition(() => mutate());
    return;
  }
  // 降级：全元素颜色过渡（styles.css 的 :root.theme-transitioning 规则）
  root.classList.add("theme-transitioning");
  clearTimeout(transitionTimer);
  transitionTimer = window.setTimeout(() => root.classList.remove("theme-transitioning"), 340);
  mutate();
}

export function applyTheme(id, { animate = false } = {}) {
  const preference = getThemeMode();
  const resolved = resolveTheme(id, preference);
  const root = document.documentElement;
  // 「变了才动画」要同时看主题与亮度：浅色↔深色只是模式变化，id 不变 —— 旧实现在这里漏掉了
  // 模式切换，导致深浅切换零动画（突兀的根因）。
  const changed = root.dataset.theme !== resolved.id || root.dataset.themeMode !== resolved.mode;
  if (animate && changed) {
    runThemeMutation(root, () => paintTheme(root, preference, resolved));
  } else {
    paintTheme(root, preference, resolved);
  }
  return resolved.id;
}

export function setTheme(id, options) {
  const requested = getThemeProfile(id).id;
  applyTheme(requested, options);
  S.getState().settings.theme = requested;
  S.saveNow();
  return requested;
}

export function initTheme() {
  const st = S.getState().settings;
  st.themeMode = normalizeThemeMode(st.themeMode);
  applyTheme(st.theme);
  if (!systemThemeListenerBound && typeof window !== "undefined") {
    systemThemeListenerBound = true;
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
      if (getThemeMode() === "system") applyTheme(S.getState().settings.theme, { animate: true });
    });
  }
}

export function setThemeMode(mode, options) {
  const st = S.getState().settings;
  st.themeMode = normalizeThemeMode(mode);
  applyTheme(st.theme, options);
  S.saveNow();
  return st.themeMode;
}

/* 记录最近一次按下的位置：圆形揭示从这里扩散。capture 捕获阶段拿原始坐标，
   不影响任何业务监听；探针/程序触发的合成事件也照收（坐标缺省时按 0 处理，等于左上角，
   测试里用默认中心路径时走不到这里）。 */
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      lastPointer = { x: event.clientX || 0, y: event.clientY || 0 };
    },
    { capture: true, passive: true },
  );
}
