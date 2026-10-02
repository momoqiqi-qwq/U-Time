import { el, toast } from "../../ui.js";
import * as S from "../../store.js";
import { MOBILE_PREVIEW_KEY, isMobilePreview, mobilePreviewUrl, prepareMobilePreview } from "../../mobilePreview.js";

export function createTestingCard() {
  const card = el("div", { class: "card set-card" }, el("h2", {}, "测试"));
  if (isMobilePreview()) {
    card.append(el("p", { class: "desc" }, "当前已在手机预览中，请在外层测试面板切换尺寸或刷新。"));
    return card;
  }
  const devices = [["390,844", "手机 · 390 × 844"], ["360,800", "小屏手机 · 360 × 800"], ["412,915", "大屏手机 · 412 × 915"]];
  const size = el("select", { "aria-label": "手机预览尺寸" }, ...devices.map(([value, label]) => el("option", { value }, label)));
  let landscape = false, frame = null;
  const area = el("div", { class: "mobile-preview-area" });
  const dimensions = el("span", { class: "desc", role: "status" });
  const applySize = () => {
    let [width, height] = size.value.split(",").map(Number);
    if (landscape) [width, height] = [height, width];
    if (frame) { frame.style.width = `${width}px`; frame.style.height = `${height}px`; }
    dimensions.textContent = `${width} × ${height} CSS 像素 · ${landscape ? "横屏" : "竖屏"}`;
  };
  const open = () => {
    try {
      frame = el("iframe", {
        class: "mobile-preview-frame", title: "U-Time 手机界面预览",
      });
      prepareMobilePreview(frame, S.getState());
      // 必须先放好内存快照再加载子页面，避免启动时读到空数据。
      frame.src = mobilePreviewUrl(window.location.href);
      area.replaceChildren(frame);
      try { localStorage.removeItem(MOBILE_PREVIEW_KEY); } catch { /* 旧版测试副本清理失败不影响预览 */ }
      applySize();
    } catch (error) { toast(`打开手机预览失败：${error.message || error}`); }
  };
  size.addEventListener("change", applySize);
  const rotate = el("button", { class: "btn ghost sm", type: "button", onclick: () => {
    landscape = !landscape; rotate.textContent = landscape ? "切换竖屏" : "切换横屏"; applySize();
  } }, "切换横屏");
  card.append(
    el("p", { class: "desc" }, "在内置网页视图中按手机尺寸预览，使用手机底栏与设置布局，无需启动本机网页服务。"),
    el("div", { class: "mobile-preview-tools" }, size,
      el("button", { class: "btn pri sm", type: "button", onclick: open }, "打开 / 刷新手机预览"), rotate),
    dimensions,
    el("p", { class: "set-hint" }, "刷新会复制当前数据到独立的内存测试副本，并使用本机已保存的账号与登录票据自动登录。预览中的修改不会写回正式数据，关闭预览后即丢弃；系统通知、软键盘及 Android 原生页面需在 APK 中验证。"),
    area,
  );
  applySize();
  return card;
}
