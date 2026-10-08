import { el } from "../../ui.js";
import { reducedMotion } from "../../motion.js";
import { getUiPreferences, setUiPreferences } from "../../uiPreferences.js";
import { getUiScaleFactor } from "../../uiScale.js";

export function usesSettingsTabs(prefs) {
  return prefs.nepheleSettings || prefs.settingsNavPosition !== "auto";
}

const LAYOUT_FLIP_SELECTOR = ".settings-nav-card, .settings-content, .settings-sidebar-head, .settings-search, .settings-catalog, .settings-nav-item:not([hidden]), .selection-glow.on";
const LAYOUT_FLIP_EASING = "cubic-bezier(.4,0,.2,1)";
const LAYOUT_SHIFT_MS = 480;
const runningLayoutAnimations = new WeakMap();

function readLayoutRects(layout) {
  const rects = new Map();
  for (const node of [layout, ...layout.querySelectorAll(LAYOUT_FLIP_SELECTOR)]) {
    const rect = node.getBoundingClientRect();
    if (rect.width || rect.height) rects.set(node, { rect, opacity: getComputedStyle(node).opacity });
  }
  return rects;
}

function stopLayoutShift(layout) {
  runningLayoutAnimations.get(layout)?.dispose();
}

function captureLayoutRects(modal) {
  const layout = modal?.querySelector?.(".settings-layout");
  if (!layout) return null;
  // 先读正在显示的中间帧，再撤销旧动画；连续点击沿当前尺寸和位置接续。
  const rects = readLayoutRects(layout);
  stopLayoutShift(layout);
  if (reducedMotion() || typeof layout.animate !== "function") return null;
  return { layout, rects };
}

function playLayoutShift(snapshot) {
  if (!snapshot?.layout?.isConnected || !snapshot.rects.size) return;
  const { layout } = snapshot;
  const scale = getUiScaleFactor() || 1;
  const target = readLayoutRects(layout);
  const animations = [];
  const styles = new Map();
  const catalog = layout.querySelector(".settings-catalog");
  const scroll = { left: catalog.scrollLeft, top: catalog.scrollTop };
  const saveStyle = (node, patch) => {
    if (!styles.has(node)) styles.set(node, node.getAttribute("style"));
    Object.assign(node.style, patch);
  };
  const parentOf = (node) => {
    if (node.matches(".settings-nav-card, .settings-content")) return layout;
    if (node.matches(".settings-nav-item, .selection-glow")) return catalog;
    return layout.querySelector(".settings-nav-card");
  };
  const frame = (node, records) => {
    const { rect, opacity } = records.get(node);
    const parent = parentOf(node);
    const origin = records.get(parent).rect;
    const box = {
      left: `${(rect.left - origin.left) / scale - parent.clientLeft}px`,
      top: `${(rect.top - origin.top) / scale - parent.clientTop}px`,
      width: `${rect.width / scale}px`,
      opacity,
    };
    // 内容区用真实宽度逐帧排版，文字与控件不做 scale 拉伸。
    if (!node.matches(".settings-content")) box.height = `${rect.height / scale}px`;
    return box;
  };
  const navCard = layout.querySelector(".settings-nav-card");
  const returningTopExtra = snapshot.to === "top" && snapshot.rects.has(catalog) && target.has(catalog)
    ? Math.max(0, parseFloat(frame(catalog, snapshot.rects).top) - parseFloat(frame(catalog, target).top)) : 0;
  layout.classList.add("settings-layout-switching");
  saveStyle(layout, { position: "relative", height: `${target.get(layout).rect.height / scale}px` });
  saveStyle(layout.querySelector(".settings-sidebar"), { position: "static" });
  // 临时独立定位各层框体，避免父框和子按钮的位移被计算两次。
  // 分类容器也参与尺寸动画，横排/竖排不再瞬间把后续内容挤到终点。
  for (const node of snapshot.rects.keys()) {
    if (node === layout || !target.has(node) || typeof node.animate !== "function") continue;
    const end = frame(node, target);
    const start = frame(node, snapshot.rects);
    let middle;
    if (snapshot.from === "top") {
      // 先缩窄导航、给内容让出横向空间，再展开侧栏高度并抬起内容。
      middle = node.matches(".settings-content") ? { ...end, top: start.top }
        : node.matches(".settings-nav-card, .settings-catalog") ? { ...end, height: start.height } : end;
    } else if (snapshot.to === "top") {
      // 回到顶部时先收短侧栏并放低内容，再铺开导航宽度，避免中途压住文字。
      middle = node.matches(".settings-content") ? { ...start, top: `${parseFloat(end.top) + returningTopExtra}px` }
        : node.matches(".settings-nav-card, .settings-sidebar-head, .settings-search, .settings-catalog")
          ? { ...end, left: start.left, width: start.width } : end;
      if (node === navCard) middle.height = `${parseFloat(end.height) + returningTopExtra}px`;
      if (node.matches(".settings-sidebar-head")) middle.height = start.height;
      if (node.matches(".settings-search, .settings-catalog")) middle.top = start.top;
    }
    saveStyle(node, {
      position: "absolute", boxSizing: "border-box", margin: "0", minWidth: "0",
      maxHeight: "none", transform: "none", ...end,
    });
    const keyframes = middle ? [
      { ...start, offset: 0, easing: LAYOUT_FLIP_EASING },
      { ...middle, offset: .45, easing: LAYOUT_FLIP_EASING },
      { ...end, offset: 1 },
    ] : [start, end];
    animations.push(node.animate(keyframes, {
      duration: LAYOUT_SHIFT_MS, easing: middle ? "linear" : LAYOUT_FLIP_EASING,
    }));
  }
  catalog.scrollLeft = 0;
  catalog.scrollTop = 0;
  animations.push(layout.animate([
    { height: `${snapshot.rects.get(layout).rect.height / scale}px` },
    { height: `${target.get(layout).rect.height / scale}px` },
  ], { duration: LAYOUT_SHIFT_MS, easing: LAYOUT_FLIP_EASING }));
  const transition = { dispose() {
    if (runningLayoutAnimations.get(layout) !== transition) return;
    runningLayoutAnimations.delete(layout);
    for (const animation of animations) animation.cancel();
    for (const [node, original] of styles) {
      if (original === null) node.removeAttribute("style");
      else node.setAttribute("style", original);
    }
    layout.classList.remove("settings-layout-switching");
    catalog.scrollLeft = scroll.left;
    catalog.scrollTop = scroll.top;
  } };
  runningLayoutAnimations.set(layout, transition);
  Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
    transition.dispose();
  });
}

export function createSettingsLayoutControls() {
  const media = window.matchMedia("(max-width: 980px)");
  const currentPosition = () => {
    const prefs = getUiPreferences();
    return prefs.settingsNavPosition === "auto"
      ? (prefs.nepheleSettings || media.matches ? "top" : "left")
      : prefs.settingsNavPosition;
  };
  const togglePosition = (event) => {
    const from = currentPosition();
    const corner = event.currentTarget.dataset.corner;
    const to = from === corner ? "top" : corner;
    const snapshot = captureLayoutRects(event.currentTarget.closest(".settings-modal"));
    if (snapshot) Object.assign(snapshot, { from, to });
    setUiPreferences({ settingsNavPosition: to });
    playLayoutShift(snapshot);
  };
  const buttons = ["left", "right"].map(corner => el("button", {
    class: "settings-layout-button",
    type: "button",
    "data-corner": corner,
    onclick: togglePosition,
  }, el("span", { class: "settings-layout-arrow", "aria-hidden": "true" }, "<")));
  const node = el("footer", { class: "settings-modal-footer", "aria-label": "设置分类位置" }, ...buttons);
  const update = () => {
    stopLayoutShift(node.closest(".settings-modal")?.querySelector(".settings-layout"));
    for (const button of buttons) {
      const next = currentPosition() === button.dataset.corner ? "top" : button.dataset.corner;
      const label = `将设置分类移到${{ left: "左侧栏", right: "右侧栏", top: "顶部栏" }[next]}`;
      button.setAttribute("data-next-position", next);
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  };
  window.addEventListener("tide:ui-preferences-changed", update);
  const onResize = () => stopLayoutShift(node.closest(".settings-modal")?.querySelector(".settings-layout"));
  window.addEventListener("resize", onResize);
  media.addEventListener("change", update);
  node._dispose = () => {
    const layout = node.closest(".settings-modal")?.querySelector(".settings-layout");
    stopLayoutShift(layout);
    window.removeEventListener("tide:ui-preferences-changed", update);
    window.removeEventListener("resize", onResize);
    media.removeEventListener("change", update);
  };
  update();
  return node;
}
