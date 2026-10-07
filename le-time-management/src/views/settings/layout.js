import { el } from "../../ui.js";
import { getUiPreferences, setUiPreferences } from "../../uiPreferences.js";

export function usesSettingsTabs(prefs) {
  return prefs.nepheleSettings || prefs.settingsNavPosition !== "auto";
}

export function createSettingsLayoutControls() {
  const media = window.matchMedia("(max-width: 980px)");
  const currentPosition = () => {
    const prefs = getUiPreferences();
    return prefs.settingsNavPosition === "auto"
      ? (prefs.nepheleSettings || media.matches ? "top" : "left")
      : prefs.settingsNavPosition;
  };
  const buttons = ["left", "right"].map(corner => el("button", {
    class: "settings-layout-button",
    type: "button",
    "data-corner": corner,
    onclick: () => setUiPreferences({ settingsNavPosition: currentPosition() === "top" ? "left" : "top" }),
  }, el("span", { class: "settings-layout-arrow", "aria-hidden": "true" }, "<")));
  const node = el("footer", { class: "settings-modal-footer", "aria-label": "设置分类位置" }, ...buttons);
  const update = () => {
    const next = currentPosition() === "top" ? "left" : "top";
    const label = `将设置分类移到${next === "left" ? "左侧栏" : "顶部栏"}`;
    for (const button of buttons) {
      button.setAttribute("data-next-position", next);
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  };
  window.addEventListener("tide:ui-preferences-changed", update);
  media.addEventListener("change", update);
  node._dispose = () => {
    window.removeEventListener("tide:ui-preferences-changed", update);
    media.removeEventListener("change", update);
  };
  update();
  return node;
}
