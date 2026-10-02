// 只在内嵌预览中模拟手机布局，不冒充 Android 原生运行环境。
export const MOBILE_PREVIEW_KEY = "letime-mobile-preview-data";

export function isMobilePreview(win = typeof window !== "undefined" ? window : null) {
  return Boolean(win && win.parent !== win && new URLSearchParams(win.location?.search || "").get("mobile-preview") === "1");
}

export function mobilePreviewUrl(href) {
  const url = new URL(href);
  url.search = "?mobile-preview=1";
  url.hash = "";
  return url.href;
}

export function previewSnapshot(state) {
  const copy = structuredClone(state);
  copy.settings = { ...copy.settings, ui: { ...copy.settings?.ui, uiScale: 100, startupView: "quadrant" } };
  return copy;
}
