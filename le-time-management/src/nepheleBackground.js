import { getUiPreferences } from "./uiPreferences.js";

export function nepheleBackgroundState(prefs, hidden, systemReduced) {
  if (prefs.nepheleBackground !== true) return "off";
  if (hidden || prefs.motion === "reduced" || (prefs.motion !== "full" && systemReduced)) return "paused";
  return "running";
}

// 云雾只绘制一次，由两条独立 CSS transform 动画漂移；星尘不使用逐帧 JS。
export function initNepheleBackground({ doc = document, browserWindow = window, preferences = getUiPreferences } = {}) {
  let prefs = preferences();
  let layer = null;
  let pageHidden = false;
  const media = browserWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
  const sync = () => {
    const state = nepheleBackgroundState(prefs, doc.hidden || pageHidden, media?.matches === true);
    if (state === "off") {
      layer?.remove();
      layer = null;
      return;
    }
    if (!layer) {
      layer = doc.createElement("div");
      layer.className = "nephele-background";
      layer.setAttribute("aria-hidden", "true");
      const driftX = doc.createElement("div");
      driftX.className = "nephele-cloud-x";
      const driftY = doc.createElement("div");
      driftY.className = "nephele-cloud-y";
      driftX.append(driftY);
      layer.append(driftX);
      // 固定分布，开关与重绘不重新随机排列，也不在每帧生成粒子。
      for (let i = 0; i < 52; i++) {
        const particle = doc.createElement("i");
        particle.className = i < 28 ? "nephele-star" : "nephele-dust";
        particle.style.setProperty("--x", `${(i * 37.31 + 7.4) % 100}%`);
        particle.style.setProperty("--y", `${(i * 61.73 + 12.8) % 100}%`);
        particle.style.setProperty("--size", `${i < 28 ? 1 + (i % 7) / 4 : 4 + i % 5}px`);
        particle.style.setProperty("--phase", `${-(i * .71) % 8}s`);
        particle.style.setProperty("--duration", `${6 + i % 3}s`);
        layer.append(particle);
      }
      doc.body.prepend(layer);
    }
    layer.dataset.state = state;
  };
  const onPreferences = (event) => { prefs = event.detail || preferences(); sync(); };
  const onHide = () => { pageHidden = true; sync(); };
  const onShow = () => { pageHidden = false; sync(); };
  browserWindow.addEventListener("tide:ui-preferences-changed", onPreferences);
  browserWindow.addEventListener("pagehide", onHide);
  browserWindow.addEventListener("pageshow", onShow);
  doc.addEventListener("visibilitychange", sync);
  media?.addEventListener?.("change", sync);
  sync();
  return () => {
    browserWindow.removeEventListener("tide:ui-preferences-changed", onPreferences);
    browserWindow.removeEventListener("pagehide", onHide);
    browserWindow.removeEventListener("pageshow", onShow);
    doc.removeEventListener("visibilitychange", sync);
    media?.removeEventListener?.("change", sync);
    layer?.remove();
  };
}
