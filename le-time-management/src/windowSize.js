// 启动窗口大小。
//
// 需求：Windows 主窗口默认不要开得过大，并且能在「总设置 → 界面与交互」里选默认大小。
// 实现取向：**每次启动定一次**，不记忆用户手动拖过的大小 —— 需求就是「每次打开的默认界面大小」
// 由设置决定，记忆上次反而会让设置看起来不生效。
//
// 前端直接调 @tauri-apps/api/window，不动 Rust 侧：tauri.conf.json 里的 width/height 只是
// 窗口创建时的初值，启动后再套一次用户设置即可；这样 Android / 浏览器调试环境完全不受影响。
import { api } from "./api.js";

/** 预设的逻辑像素尺寸。`auto` 按屏幕算、`full` 直接最大化，所以这两项不在这里。 */
export const WINDOW_SIZE_PRESETS = Object.freeze({
  compact: { width: 1120, height: 720 },
  standard: { width: 1360, height: 860 },
  large: { width: 1600, height: 1000 },
});

/** 自定义尺寸的合法范围。下限不压到 minWidth/minHeight（tauri.conf.json 是 400×560）是有意的：
 *  比手机还窄的桌面窗口调出来没有意义，这里给的是「仍然可用」的下限。 */
export const CUSTOM_SIZE_LIMITS = Object.freeze({
  minWidth: 900, maxWidth: 3840, minHeight: 600, maxHeight: 2400,
});

/**
 * 左下角「缩放视图」按钮的目标尺寸（逻辑像素，指内容区）。
 *
 * 取 1600 × 1100 是为了让四象限每个象限的卡片基本一屏看完 —— 这是从需求截图量出来的：
 * 截图 1762 × 1213 物理像素，在 110% 缩放下去掉无边框窗口的隐藏投影边距，正好是 1600 × 1100。
 */
export const FOCUS_WINDOW_SIZE = Object.freeze({ width: 1600, height: 1100 });

/** 「跟随屏幕」时占显示器可用区域的比例、上限，以及拿不到显示器信息时的兜底尺寸。 */
const AUTO_RATIO = 0.86;
const AUTO_MAX = Object.freeze({ width: 1440, height: 900 });
const AUTO_FALLBACK = Object.freeze({ ...WINDOW_SIZE_PRESETS.standard });

/** 目标尺寸与屏幕边缘之间留的余量（逻辑像素），避免最大化条 / 边框压住内容。 */
const SCREEN_MARGIN = 24;

function clamp(value, lo, hi, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function clampWindowSize(width, height) {
  const { minWidth, maxWidth, minHeight, maxHeight } = CUSTOM_SIZE_LIMITS;
  return {
    width: clamp(width, minWidth, maxWidth, AUTO_FALLBACK.width),
    height: clamp(height, minHeight, maxHeight, AUTO_FALLBACK.height),
  };
}

/**
 * 把偏好解析成「实际要设的尺寸」。纯函数，方便测试。
 *
 * @param {{startupWindowMode?: string, startupWindowWidth?: number, startupWindowHeight?: number}} pref
 * @param {{width: number, height: number} | null} area 当前显示器可用区域（逻辑像素），拿不到传 null
 * @returns {{mode: "full"} | {mode: "size", width: number, height: number}}
 */
export function resolveWindowSize(pref = {}, area = null) {
  const mode = pref?.startupWindowMode;
  if (mode === "full") return { mode: "full" };

  const usable = area && area.width > 0 && area.height > 0 ? area : null;
  // 屏幕装得下就用请求值，装不下就退到可用区域减余量 —— 换小屏 / 拔掉外接屏后不该开出屏幕外。
  const fitToScreen = (size) => {
    if (!usable) return size;
    return {
      width: Math.max(CUSTOM_SIZE_LIMITS.minWidth, Math.min(size.width, Math.round(usable.width) - SCREEN_MARGIN)),
      height: Math.max(CUSTOM_SIZE_LIMITS.minHeight, Math.min(size.height, Math.round(usable.height) - SCREEN_MARGIN)),
    };
  };

  if (mode === "custom") {
    const { width, height } = clampWindowSize(pref.startupWindowWidth, pref.startupWindowHeight);
    return { mode: "size", ...fitToScreen({ width, height }) };
  }
  if (WINDOW_SIZE_PRESETS[mode]) return { mode: "size", ...fitToScreen({ ...WINDOW_SIZE_PRESETS[mode] }) };

  // 其余（含 auto、未知取值）都按屏幕算，但在大屏上封顶到中等窗口，避免首屏接近满屏。
  if (!usable) return { mode: "size", ...AUTO_FALLBACK };
  return {
    mode: "size",
    ...fitToScreen({
      width: Math.min(Math.round(usable.width * AUTO_RATIO), AUTO_MAX.width),
      height: Math.min(Math.round(usable.height * AUTO_RATIO), AUTO_MAX.height),
    }),
  };
}

/** 桌面端 Tauri（Android / 纯浏览器下调窗口尺寸没意义）。 */
export function isDesktopRuntime() {
  if (!api.isTauri) return false;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return !/Android|iPhone|iPad|iPod/i.test(ua);
}

/**
 * 当前显示器尺寸（逻辑像素）；拿不到显示器信息返回 null，调用方按兜底尺寸走。
 * monitor.size 是**物理**像素，必须除以 scaleFactor 才能和 LogicalSize 对齐。
 */
async function readMonitorArea(currentMonitor) {
  try {
    const monitor = await currentMonitor();
    const scale = monitor?.scaleFactor || 1;
    if (monitor?.size?.width) return { width: monitor.size.width / scale, height: monitor.size.height / scale };
  } catch { /* 拿不到显示器信息就按兜底尺寸走 */ }
  return null;
}

/**
 * 套用启动窗口大小。设置页的「立即应用」也走这里，保证只有一条实现。
 * 失败一律吞掉：调不动窗口不该拦住应用启动。
 * @returns {Promise<{applied: boolean, reason?: string, mode?: string, width?: number, height?: number}>}
 */
export async function applyWindowSize(pref = {}) {
  if (!isDesktopRuntime()) return { applied: false, reason: "not-desktop" };
  try {
    const { getCurrentWindow, LogicalSize, currentMonitor } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const area = await readMonitorArea(currentMonitor);

    const target = resolveWindowSize(pref, area);
    if (target.mode === "full") {
      await win.maximize();
      return { applied: true, mode: "full" };
    }
    // 上次可能是最大化状态，先还原，否则 setSize 会被忽略。
    await win.unmaximize().catch(() => {});
    await win.setSize(new LogicalSize(target.width, target.height));
    await win.center().catch(() => {});
    return { applied: true, mode: "size", width: target.width, height: target.height };
  } catch (error) {
    return { applied: false, reason: String(error?.message || error) };
  }
}

/** 供设置页展示的一句说明。 */
export function windowSizeHint(mode, pref = {}) {
  if (mode === "full") return "启动后直接最大化，铺满当前显示器的可用区域。";
  if (mode === "custom") {
    const { width, height } = clampWindowSize(pref.startupWindowWidth, pref.startupWindowHeight);
    return `启动时为 ${width} × ${height}；比屏幕还大时会自动缩到可用区域内。`;
  }
  const preset = WINDOW_SIZE_PRESETS[mode];
  if (preset) return `启动时为 ${preset.width} × ${preset.height}；比屏幕还大时会自动缩到可用区域内。`;
  return "按当前显示器可用区域的约 86% 打开，最高 1440 × 900；小屏上会自动收窄。";
}

/* ── 左下角「缩放视图」按钮 ──
 *
 * 一键把窗口收成固定尺寸并居中，再按一次回到按之前的尺寸和位置。
 * 与上面的「启动窗口大小」是两件事：那个管每次打开长什么样，这个管**当前这一次**看着顺不顺眼。
 *
 * 快照只存在模块内存里、不落 store：重启后窗口该多大由启动设置说了算，
 * 存下来反而会让「上次退出时停在缩放视图」这件事污染下一次启动。
 */

/** 进入缩放视图前的窗口几何；null ⇒ 当前不在缩放视图。 */
let focusSnapshot = null;

export function isFocusWindowActive() {
  return focusSnapshot !== null;
}

/** 缩放视图的目标内容尺寸：屏幕装得下就用 FOCUS_WINDOW_SIZE，装不下退到「可用区域 − 余量」。 */
export function focusWindowSize(area = null) {
  const target = resolveWindowSize({
    startupWindowMode: "custom",
    startupWindowWidth: FOCUS_WINDOW_SIZE.width,
    startupWindowHeight: FOCUS_WINDOW_SIZE.height,
  }, area);
  return { width: target.width, height: target.height };
}

/**
 * 切换缩放视图。
 *
 * 取快照用 innerSize + outerPosition，还原用 setSize + setPosition —— 必须成对：
 * Tauri 的 setSize 落到 tao 的 set_inner_size，而无边框带投影的窗口外框比内容大一圈
 * （隐藏投影边距），拿 outerSize 去喂 setSize 会每次还原得比原来小一圈。
 *
 * @returns {Promise<{applied: boolean, mode?: "focus" | "restore", reason?: string, width?: number, height?: number}>}
 */
export async function toggleFocusWindow() {
  if (!isDesktopRuntime()) return { applied: false, reason: "not-desktop" };
  try {
    const {
      getCurrentWindow, LogicalSize, PhysicalSize, PhysicalPosition, currentMonitor,
    } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();

    const saved = focusSnapshot;
    if (saved) {
      if (saved.maximized) {
        await win.maximize();
      } else {
        // 缩放视图期间被手动最大化过的话，不先解掉 setSize/setPosition 会被系统忽略。
        await win.unmaximize().catch(() => {});
        await win.setSize(new PhysicalSize(saved.inner.width, saved.inner.height));
        await win.setPosition(new PhysicalPosition(saved.outer.x, saved.outer.y));
      }
      focusSnapshot = null;
      return { applied: true, mode: "restore" };
    }

    const area = await readMonitorArea(currentMonitor);
    const target = focusWindowSize(area);
    const inner = await win.innerSize();
    const outer = await win.outerPosition();
    const maximized = await win.isMaximized().catch(() => false);

    await win.unmaximize().catch(() => {});
    await win.setSize(new LogicalSize(target.width, target.height));
    await win.center().catch(() => {});
    // 全部成功才认快照：中途抛异常时按钮不该停在「已缩放」态。
    focusSnapshot = { inner: { width: inner.width, height: inner.height }, outer: { x: outer.x, y: outer.y }, maximized };
    return { applied: true, mode: "focus", width: target.width, height: target.height };
  } catch (error) {
    return { applied: false, reason: String(error?.message || error) };
  }
}
