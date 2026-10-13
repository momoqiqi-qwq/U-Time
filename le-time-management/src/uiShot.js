// 界面演示图：一条命令把「此刻这一屏」截成 PNG，落进系统下载目录。
//
// 与仓库里的 tools/shots/ 不是一回事，两者互补：
//   · tools/shots/ 在开发机上跑无头 Chrome + 假数据（fixture），产出文档配图 —— 可复现、
//     可批量、能出手机视口，但它是「另建一个页面」，不是用户眼前的真实界面；
//   · 本模块由应用截自己的渲染层（Rust 侧 capture_ui_shot → WebView2 CapturePreview），
//     真实数据、真实主题、真实滚动位置都在，代价是只在桌面端可用。
//
// 三个入口都落到 captureUiShot()：
//   · 命令面板「生成界面演示图」（面板会先关闭，所以留一点延时等浮层收完，免得把自己拍进去）
//   · 全局快捷键 tide:ui-shot（默认 CommandOrControl+Alt+S，键位在设置页可改）
//   · 其它模块直接调用
import { api } from "./api.js";
import { toast } from "./ui.js";

// 与 globalShortcuts.js 同一口径：Tauri 且非移动端 UA。
function isDesktopTauri() {
  if (!api.isTauri) return false;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  return !/Android|iPhone|iPad|iPod/i.test(ua);
}

export function uiShotSupported() {
  return isDesktopTauri();
}

/** 本地时间戳（文件名用，不受系统区域设置影响，永远是 `YYYY-MM-DD_HHmmss`）。 */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 当前视图名（只用来给文件起名，取不到就退回「界面」）。 */
function currentViewLabel() {
  try {
    const node = document.querySelector("[data-view].on, [data-view][aria-current='page']");
    const text = node?.querySelector?.(".nav-text, span")?.textContent || node?.textContent || "";
    return String(text).trim().slice(0, 24);
  } catch {
    return "";
  }
}

function baseName(path) {
  return String(path || "").split(/[\\/]/).pop() || String(path || "");
}

let busy = false;

/**
 * 截当前界面并存盘。
 * @param {{ label?: string, delay?: number, silent?: boolean }} opts
 *   label 进文件名（一般给当前视图名）；delay 毫秒，用来等浮层/动画收完再截。
 * @returns {Promise<string|null>} 落盘绝对路径；失败或环境不支持时 null。
 */
export async function captureUiShot(opts = {}) {
  if (!isDesktopTauri()) {
    toast("界面演示图只在桌面端可用");
    return null;
  }
  if (busy) return null; // 连按只截一张：两帧几乎相同的图没有意义，还会并发落盘
  busy = true;
  try {
    const wait = Math.max(0, Number(opts.delay) || 0);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const label = String(opts.label || "").trim() || currentViewLabel() || "界面";
    const path = await api.captureUiShot(`界面演示图-${label}-${stamp()}.png`);
    if (!opts.silent) {
      toast(`界面演示图已保存：${baseName(path)}`, {
        actionLabel: "打开文件夹",
        action: () => { api.revealSavedFile(path).catch(() => {}); },
      });
    }
    return path;
  } catch (e) {
    toast(`截图失败：${e?.message || e}`);
    return null;
  } finally {
    busy = false;
  }
}

export function initUiShot() {
  window.addEventListener("tide:ui-shot", () => {
    // 快捷键触发时界面通常是静止的，但输入法候选、下拉收起可能还在跑，留一小段更稳。
    captureUiShot({ delay: 120 });
  });
}
