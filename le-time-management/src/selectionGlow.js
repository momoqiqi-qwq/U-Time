import { reducedMotion } from "./motion.js";
import { getUiScaleFactor } from "./uiScale.js";

const pending = new Map();
const SLIDE_MS = 500;
const SIZE_MS = 400;
const EASING = "cubic-bezier(.34,1.56,.64,1)";

export function attachSelectionGlow(container, { selector, persistKey = "" }) {
  const glow = document.createElement("span");
  glow.className = "selection-glow";
  glow.setAttribute("aria-hidden", "true");
  container.append(glow);
  container.classList.add("has-selection-glow");
  let box = null;
  let observed = null;
  let animations = [];
  let disposed = false;

  const observer = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => sync(false)) : null;
  observer?.observe(container);

  function stop() {
    for (const animation of animations) animation.cancel();
    animations = [];
  }

  function visualBox() {
    if (!box) return null;
    const factor = getUiScaleFactor() || 1;
    const current = glow.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    return {
      left: (current.left - parent.left) / factor + container.scrollLeft - container.clientLeft,
      top: (current.top - parent.top) / factor + container.scrollTop - container.clientTop,
      width: current.width / factor,
      height: current.height / factor,
    };
  }

  function sync(animate = true) {
    if (disposed || !container.isConnected || typeof container.querySelector !== "function") return;
    const target = container.querySelector(selector);
    if (observed !== target) {
      if (observed) observer?.unobserve(observed);
      observed = target;
      if (target) observer?.observe(target);
    }
    if (!target || target.hidden || !target.offsetParent) {
      stop();
      glow.classList.remove("on");
      box = null;
      return;
    }
    const next = { left: target.offsetLeft, top: target.offsetTop, width: target.offsetWidth, height: target.offsetHeight };
    if (box && glow.classList.contains("on") && !reducedMotion()
      && Object.keys(next).every(key => Math.abs(next[key] - box[key]) < .01)) return;

    let from = box && glow.classList.contains("on") ? visualBox() : null;
    if (persistKey && !from) {
      const saved = pending.get(persistKey);
      pending.delete(persistKey);
      if (saved && performance.now() - saved.at < 3000) from = saved.box;
    }
    stop();
    glow.style.left = `${next.left}px`;
    glow.style.top = `${next.top}px`;
    glow.style.width = `${next.width}px`;
    glow.style.height = `${next.height}px`;
    glow.classList.add("on");
    box = next;
    if (!animate || !from || reducedMotion() || typeof glow.animate !== "function") return;

    const dx = from.left - next.left;
    const dy = from.top - next.top;
    if (Math.abs(dx) + Math.abs(dy) > .5) {
      animations.push(glow.animate([
        { transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" },
      ], { duration: SLIDE_MS, easing: EASING }));
    }
    if (Math.abs(from.width - next.width) + Math.abs(from.height - next.height) > .5) {
      animations.push(glow.animate([
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${next.width}px`, height: `${next.height}px` },
      ], { duration: SIZE_MS, easing: "cubic-bezier(.22,.8,.22,1)" }));
    }
  }

  function rememberClick(event) {
    if (!persistKey || !box || !event.target.closest?.("button")) return;
    pending.set(persistKey, { box: visualBox(), at: performance.now() });
  }
  if (persistKey) container.addEventListener("click", rememberClick, true);
  else container.addEventListener("click", onClick);
  function onClick() { sync(); }
  requestAnimationFrame(() => sync());

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    container.removeEventListener("click", persistKey ? rememberClick : onClick, !!persistKey);
    stop();
  }
  container._disposeSelectionGlow = dispose;
  return { sync, dispose };
}
