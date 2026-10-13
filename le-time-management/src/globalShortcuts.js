// 系统级全局快捷键。仅桌面 Tauri 环境注册；浏览器/移动端自动跳过。
import { api } from "./api.js";
import * as S from "./store.js";

export const DEFAULT_GLOBAL_SHORTCUTS = {
  enabled: true,
  commandPalette: "CommandOrControl+Shift+Space",
  quickCapture: "CommandOrControl+Shift+A",
  // 界面演示图（src/uiShot.js）：刻意避开 Ctrl+Shift+S —— 那是浏览器/WebView 的「另存为」，
  // 在桌面端虽然多半抢不到，但换 Alt 组合更省事，也不必和系统的截图键（Win+Shift+S）撞。
  uiShot: "CommandOrControl+Alt+S",
};

let registered = [];
function isDesktopTauri() {
  if (!api.isTauri) return false;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return !/Android|iPhone|iPad|iPod/i.test(ua);
}
let lastStatus = { supported: isDesktopTauri(), registered: [], errors: [] };

export function getShortcutConfig() {
  const settings = S.getState().settings;
  settings.globalShortcuts ??= { ...DEFAULT_GLOBAL_SHORTCUTS };
  settings.globalShortcuts = { ...DEFAULT_GLOBAL_SHORTCUTS, ...settings.globalShortcuts };
  return settings.globalShortcuts;
}

export function getGlobalShortcutStatus() { return { ...lastStatus, registered: [...lastStatus.registered], errors: [...lastStatus.errors] }; }

async function focusMainWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.show().catch(() => {});
    await win.unminimize().catch(() => {});
    await win.setFocus().catch(() => {});
  } catch { /* 浏览器预览或权限不足时仍可在当前窗口触发 */ }
}

async function trigger(name) {
  await focusMainWindow();
  window.dispatchEvent(new CustomEvent(name));
}

export async function applyGlobalShortcuts() {
  const cfg = getShortcutConfig();
  if (!isDesktopTauri()) {
    lastStatus = { supported: false, registered: [], errors: [api.isTauri ? "移动端不注册系统级快捷键" : "浏览器预览不支持系统级快捷键"] };
    return lastStatus;
  }
  const { register, unregister } = await import("@tauri-apps/plugin-global-shortcut");
  if (registered.length) {
    try { await unregister(registered); } catch { /* 可能已由系统释放 */ }
    registered = [];
  }
  const status = { supported: true, registered: [], errors: [] };
  if (!cfg.enabled) { lastStatus = status; return status; }

  const defs = [
    { key: "命令面板", shortcut: String(cfg.commandPalette || "").trim(), event: "tide:command-palette" },
    { key: "快速捕获", shortcut: String(cfg.quickCapture || "").trim(), event: "tide:quick-capture" },
    { key: "界面演示图", shortcut: String(cfg.uiShot || "").trim(), event: "tide:ui-shot" },
  ].filter((x) => x.shortcut);
  const seen = new Set();
  for (const def of defs) {
    const normalized = def.shortcut.toLowerCase();
    if (seen.has(normalized)) { status.errors.push(`${def.key}：与其他快捷键重复`); continue; }
    seen.add(normalized);
    try {
      await register(def.shortcut, (event) => {
        if (!event || event.state === "Pressed") trigger(def.event);
      });
      registered.push(def.shortcut);
      status.registered.push(`${def.key} · ${def.shortcut}`);
    } catch (e) {
      status.errors.push(`${def.key}：${e?.message || e}`);
    }
  }
  lastStatus = status;
  return status;
}

export async function initGlobalShortcuts() {
  try { return await applyGlobalShortcuts(); }
  catch (e) {
    lastStatus = { supported: isDesktopTauri(), registered: [], errors: [String(e?.message || e)] };
    console.warn("全局快捷键初始化失败", e);
    return lastStatus;
  }
}
