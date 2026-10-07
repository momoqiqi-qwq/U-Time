import { el } from "../../ui.js";
import { reducedMotion } from "../../motion.js";
import { getUiPreferences, setUiPreferences } from "../../uiPreferences.js";
import { getUiScaleFactor } from "../../uiScale.js";

export function usesSettingsTabs(prefs) {
  return prefs.nepheleSettings || prefs.settingsNavPosition !== "auto";
}

const LAYOUT_FLIP_SELECTOR = ".settings-content, .settings-sidebar-head, .settings-search, .settings-nav-item:not([hidden])";
const LAYOUT_FLIP_EASING = "cubic-bezier(.16,1,.3,1)";
const runningLayoutAnimations = new WeakMap();

function captureLayoutRects(modal) {
  const layout = modal?.querySelector?.(".settings-layout");
  if (!layout) return null;
  const rects = new Map();
  for (const node of layout.querySelectorAll(LAYOUT_FLIP_SELECTOR)) {
    const rect = node.getBoundingClientRect();
    if (rect.width || rect.height) rects.set(node, { rect, opacity: getComputedStyle(node).opacity });
  }
  // Capture the visible frame before cancelling an interrupted transition.
  for (const animation of runningLayoutAnimations.get(layout) || []) animation.cancel();
  runningLayoutAnimations.delete(layout);
  layout.classList.remove("settings-layout-switching");
  if (reducedMotion() || typeof layout.animate !== "function") return null;
  return { layout, rects };
}

function playLayoutShift(snapshot) {
  if (!snapshot?.layout?.isConnected || !snapshot.rects.size) return;
  const scale = getUiScaleFactor() || 1;
  const animations = [];
  snapshot.layout.classList.add("settings-layout-switching");
  for (const [node, { rect: before, opacity }] of snapshot.rects) {
    if (!node.isConnected || typeof node.animate !== "function") continue;
    const after = node.getBoundingClientRect();
    const dx = (before.left - after.left) / scale;
    const dy = (before.top - after.top) / scale;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
    const isContent = node.classList.contains("settings-content");
    const animation = node.animate([
      { transform: `translate3d(${dx}px, ${dy}px, 0)`, opacity },
      { transform: "translate3d(0, 0, 0)", opacity: 1 },
    ], {
      duration: isContent ? 300 : 360,
      easing: LAYOUT_FLIP_EASING,
    });
    animations.push(animation);
  }
  runningLayoutAnimations.set(snapshot.layout, animations);
  Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {
    if (runningLayoutAnimations.get(snapshot.layout) !== animations) return;
    runningLayoutAnimations.delete(snapshot.layout);
    snapshot.layout.classList.remove("settings-layout-switching");
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
    const snapshot = captureLayoutRects(event.currentTarget.closest(".settings-modal"));
    const corner = event.currentTarget.dataset.corner;
    setUiPreferences({ settingsNavPosition: currentPosition() === corner ? "top" : corner });
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
    for (const button of buttons) {
      const next = currentPosition() === button.dataset.corner ? "top" : button.dataset.corner;
      const label = `将设置分类移到${{ left: "左侧栏", right: "右侧栏", top: "顶部栏" }[next]}`;
      button.setAttribute("data-next-position", next);
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  };
  window.addEventListener("tide:ui-preferences-changed", update);
  media.addEventListener("change", update);
  node._dispose = () => {
    const layout = node.closest(".settings-modal")?.querySelector(".settings-layout");
    for (const animation of runningLayoutAnimations.get(layout) || []) animation.cancel();
    if (layout) {
      runningLayoutAnimations.delete(layout);
      layout.classList.remove("settings-layout-switching");
    }
    window.removeEventListener("tide:ui-preferences-changed", update);
    media.removeEventListener("change", update);
  };
  update();
  return node;
}
