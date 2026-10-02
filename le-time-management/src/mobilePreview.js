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

// 快照只挂在当前 iframe 的内存对象上，避免图片/插件缓存挤满 Web Storage。
export function prepareMobilePreview(frame, state) {
  frame[MOBILE_PREVIEW_KEY] = previewSnapshot(state);
}

function previewFrame(win) {
  const frame = isMobilePreview(win) ? win.frameElement : null;
  if (!frame?.[MOBILE_PREVIEW_KEY]) throw new Error("手机预览数据不可用，请在设置中重新打开预览");
  return frame;
}

export function loadMobilePreviewData(win = window) {
  return structuredClone(previewFrame(win)[MOBILE_PREVIEW_KEY]);
}

export function saveMobilePreviewData(data, win = window) {
  previewFrame(win)[MOBILE_PREVIEW_KEY] = structuredClone(data);
}
