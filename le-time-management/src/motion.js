import { getUiScaleFactor } from "./uiScale.js";

const CLOSING_CLASS = "motion-closing";
const PRESS_CLASS = "motion-pressing";
const CLOSE_CONTROL_CLASS = "motion-close-control";
let initialized = false;
const pressedControls = new Set();
const releasedControls = new WeakSet();
const controlAnimations = new WeakMap();
const pageAnimations = new WeakMap();
const FLIP_EASING = "cubic-bezier(.16,1,.3,1)";
const SPRING_EASING = "cubic-bezier(.22,1,.36,1.08)";

// 重复操作从正在显示的位置接续，不通过 offsetWidth 强制刷新整棵布局。
function releaseControl(control) {
  if (typeof control.animate !== "function") return;
  const transform = getComputedStyle(control).transform;
  controlAnimations.get(control)?.cancel();
  const target = control.matches(":hover") && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches
    ? "translateY(-1px)" : "none";
  const animation = control.animate([{ transform }, { transform: target }], {
    duration: 220, easing: SPRING_EASING,
  });
  controlAnimations.set(control, animation);
  animation.finished.catch(() => {}).then(() => {
    if (controlAnimations.get(control) === animation) controlAnimations.delete(control);
  });
}

export function enterPage(node, direction = "left") {
  if (!node) return;
  const previous = pageAnimations.get(node);
  const current = previous ? getComputedStyle(node) : null;
  const opacity = current?.opacity ?? .4;
  const transform = current?.transform;
  previous?.cancel();
  if (reducedMotion() || typeof node.animate !== "function") return;
  const offset = direction === "left" ? 12 : -12;
  const animation = node.animate([
    { opacity, transform: transform ?? `translate3d(${offset}px, 6px, 0) scale(.992)` },
    { opacity: 1, transform: "none" },
  ], { duration: 320, easing: FLIP_EASING });
  pageAnimations.set(node, animation);
  animation.finished.catch(() => {}).then(() => {
    if (pageAnimations.get(node) === animation) pageAnimations.delete(node);
  });
}

function captureExit(node) {
  if (!node) return;
  const style = getComputedStyle(node);
  node.style.setProperty("--motion-exit-transform", style.transform);
  node.style.setProperty("--motion-exit-opacity", style.opacity);
}

export function reducedMotion() {
  const setting = document.documentElement.dataset.uiMotion;
  if (setting === "full") return false;
  if (setting === "reduced") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// CSS 与 JS 共用关闭语义：控件自身或祖先 off，以及系统/应用减少动效。
function allowsControlMotion(control) {
  return !control.closest?.('[data-motion="off"]') && !reducedMotion();
}

function isCloseControl(control) {
  const label = [control.getAttribute("aria-label"), control.title, control.textContent]
    .filter(Boolean)
    .join(" ")
    .trim();
  return /(?:关闭|取消|收起|退出|×|✕)/.test(label);
}

function addRipple(control, clientX, clientY) {
  if (control.tagName !== "BUTTON" || !allowsControlMotion(control)) return;
  const rect = control.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Number.isFinite(clientX) && clientX > 0 ? clientX - rect.left : rect.width / 2;
  const y = Number.isFinite(clientY) && clientY > 0 ? clientY - rect.top : rect.height / 2;
  const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
  const ripple = document.createElement("span");
  ripple.className = "motion-ripple";
  ripple.style.cssText = `--motion-ripple-x:${x}px;--motion-ripple-y:${y}px;--motion-ripple-size:${radius * 2}px`;
  control.classList.add("motion-ripple-host");
  control.append(ripple);
  const remove = () => ripple.remove();
  ripple.addEventListener("animationend", remove, { once: true });
  window.setTimeout(remove, 520);
}

export function initMotionInteractions() {
  if (initialized) return;
  initialized = true;
  const release = (event) => {
    for (const control of pressedControls) {
      // 在摘掉按下样式之前读取视觉位置，拖出按钮释放也平滑归位。
      if (event?.type === "pointerup" && allowsControlMotion(control)) {
        releaseControl(control);
        releasedControls.add(control);
      }
      else controlAnimations.get(control)?.cancel();
      control.classList.remove(PRESS_CLASS);
    }
    pressedControls.clear();
  };
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const control = event.target?.closest?.("button, [role='button']");
    if (!control || control.disabled || control.getAttribute("aria-disabled") === "true" || !allowsControlMotion(control)) return;
    controlAnimations.get(control)?.cancel();
    releasedControls.delete(control);
    control.classList.add(PRESS_CLASS);
    pressedControls.add(control);
    addRipple(control, event.clientX, event.clientY);
  }, { passive: true });
  document.addEventListener("click", (event) => {
    const control = event.target?.closest?.("button, [role='button']");
    if (!control || control.disabled || control.getAttribute("aria-disabled") === "true" || !allowsControlMotion(control)) return;
    control.classList.toggle(CLOSE_CONTROL_CLASS, isCloseControl(control));
    const alreadyReleased = releasedControls.delete(control);
    if (!alreadyReleased || event.detail === 0) releaseControl(control);
    if (event.detail === 0) addRipple(control);
  }, true);
  document.addEventListener("pointerup", release, { passive: true });
  document.addEventListener("pointercancel", release, { passive: true });
  window.addEventListener("blur", release);
}

// 插件常用 innerHTML / replaceChildren 重绘局部内容。宿主统一为新内容补上轻量反馈，
// 让第三方插件无需依赖主应用 CSS 类，也能获得一致的状态切换动效。
//
// 「弹 2 下」修复（用户视频反馈）：
// 1) 挂载宽限期 settleMs——视图本身正在做入场动画，这期间插件的首绘 / 缓存绘
//    （如学习通 render 里的 loading → paintMain(缓存)）不再叠加动画；
// 2) 重绘动画只留淡入、去掉 7px 上移——异步数据到达的重绘是「浮现」不是「弹跳」。
export function observePluginMotion(container, { settleMs = 350 } = {}) {
  if (!container || typeof MutationObserver === "undefined") return () => {};
  const pending = new Set();
  let frame = 0;
  const startedAt = performance.now();
  const flush = () => {
    frame = 0;
    if (reducedMotion()) {
      pending.clear();
      return;
    }
    if (performance.now() - startedAt < settleMs) {
      pending.clear();
      return;
    }
    const candidates = [...pending].filter((node) => node.isConnected);
    pending.clear();
    const roots = candidates.filter((node) => !candidates.some((parent) => parent !== node && parent.contains(node)));
    for (const node of roots.slice(0, 12)) {
      if (!node.getClientRects().length) continue;
      const topLevel = node.parentElement === container;
      node.animate(
        topLevel
          ? [{ opacity: .2 }, { opacity: 1 }]
          : [{ opacity: .24 }, { opacity: 1 }],
        { duration: topLevel ? 180 : 160, easing: "cubic-bezier(.22,.8,.22,1)" },
      );
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("style, script, link, option, .motion-ripple") || node.closest('[data-motion="off"]')) continue;
        pending.add(node);
      }
    }
    if (pending.size && !frame) frame = requestAnimationFrame(flush);
  });
  observer.observe(container, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    pending.clear();
  };
}

export function closeLayer(panel, mask, cleanup) {
  if (!panel && !mask) {
    cleanup?.();
    return;
  }
  if (panel?.classList.contains(CLOSING_CLASS)) return;
  if (!reducedMotion()) {
    captureExit(panel);
    captureExit(mask);
  }
  cleanup?.();
  if (reducedMotion()) {
    mask?.remove();
    panel?.remove();
    return;
  }
  const layerKind = panel?.matches(".drawer")
    ? "side"
    : panel?.matches(".cmd-palette, .quick-cap")
      ? "top"
      : panel?.matches(".settings-modal, .wc-web-panel")
        ? "full"
        : "center";
  if (panel) panel.dataset.motionLayer = layerKind;
  mask?.classList.add("motion-layer-mask");
  panel?.classList.add(CLOSING_CLASS);
  mask?.classList.add(CLOSING_CLASS);
  panel?.setAttribute("aria-hidden", "true");
  if (panel?.contains(document.activeElement)) document.activeElement.blur();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    mask?.remove();
    panel?.remove();
  };
  const target = panel || mask;
  const onAnimationEnd = (event) => {
    if (event.target !== target) return;
    target.removeEventListener("animationend", onAnimationEnd);
    finish();
  };
  target?.addEventListener("animationend", onAnimationEnd);
  window.setTimeout(finish, 320);
}

export function removeWithMotion(element) {
  if (!element || element.classList.contains(CLOSING_CLASS)) return;
  if (reducedMotion()) return element.remove();
  captureExit(element);
  element.classList.add(CLOSING_CLASS);
  const finish = () => element.remove();
  const onAnimationEnd = (event) => {
    if (event.target !== element) return;
    element.removeEventListener("animationend", onAnimationEnd);
    finish();
  };
  element.addEventListener("animationend", onAnimationEnd);
  window.setTimeout(finish, 240);
}

/* ── 整段重绘的 FLIP（v0.103.0 插件分组）──────────────────────────────────────
 * 侧栏与插件中心都是「状态 → 整段 replaceChildren() 重建」，每次重建节点身份都会换，
 * 所以这里不认节点只认 key：mutate() 之前按 key 记下视觉位置，重建后同 key 的新节点
 * 从旧位置滑到新位置 —— 只动 transform，由合成层完成，不逐帧重排。
 * - 嵌套：最近的 key 祖先已经在走的那段位移要从子节点里扣掉，否则子节点会叠加走两遍；
 * - 新出现的节点交给 enter(node) 给关键帧（默认淡入 + 轻微放大），返回 null 表示不动；
 *   消失的节点直接离场 —— 需要离场动画的调用方先播完（见 fadeAway）再调 mutate；
 * - getBoundingClientRect 是 zoom 之后的视觉像素，transform 用元素自己的 CSS 像素，
 *   位移必须除以 getUiScaleFactor()（与 toolbarDrag.js 同一口径，否则非 100% 缩放下起点会跳）；
 * - 快照取的是「当前视觉位置」（含进行中的 transform），连点时从半路接着走，不会先跳回原位。
 * reducedMotion() 时只执行 mutate()。返回全部动画结束（或被取消）的 Promise。
 */
export function flipByKey(root, {
  selector,
  key,
  mutate,
  enter = fadeScaleIn,
  duration = 220,
  easing = FLIP_EASING,
  stagger = 16,
} = {}) {
  if (typeof mutate !== "function") return Promise.resolve();
  if (!root || reducedMotion() || typeof root.animate !== "function") {
    mutate();
    return Promise.resolve();
  }
  const scale = getUiScaleFactor() || 1;
  const before = new Map();
  for (const node of root.querySelectorAll(selector)) {
    const id = key(node);
    if (id && !before.has(id)) before.set(id, node.getBoundingClientRect());
  }
  mutate();
  const shifts = new Map();
  const running = [];
  let entering = 0;
  // 所有位置先读完，再启动动画；避免每个兄弟都触发一次样式/布局刷新。
  const measured = [...root.querySelectorAll(selector)].map((node) => ({ node, now: node.getBoundingClientRect() }));
  for (const { node, now } of measured) {
    if (!now.width && !now.height) continue;
    const id = key(node);
    const old = id ? before.get(id) : null;
    if (!old) {
      const frames = enter?.(node);
      if (frames) {
        running.push(node.animate(frames, {
          duration, easing, delay: Math.min(entering++, 8) * stagger, fill: "backwards",
        }));
      }
      continue;
    }
    const shift = { dx: (old.left - now.left) / scale, dy: (old.top - now.top) / scale };
    shifts.set(node, shift);
    const parent = keyedAncestorShift(node, root, shifts);
    const dx = shift.dx - parent.dx;
    const dy = shift.dy - parent.dy;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
    running.push(node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing }));
  }
  return settleAll(running);
}

const NO_SHIFT = { dx: 0, dy: 0 };

function keyedAncestorShift(node, root, shifts) {
  for (let up = node.parentElement; up && up !== root; up = up.parentElement) {
    const shift = shifts.get(up);
    if (shift) return shift;
  }
  return NO_SHIFT;
}

function fadeScaleIn() {
  return [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }];
}

function settleAll(animations) {
  return Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(() => {});
}

/* ── 折叠段的高度动画 ──
 * 收起的成员不渲染（shell.js：collapsed ? null : plugSegNode(views)），接不上 CSS transition：
 * 展开是「新挂上的段从 0 长到自然高度」，收起是「旧段收到 0，结束后由调用方摘掉」。
 * 高度动画会逐帧重排，只给侧栏这种几十个节点的小列表用；下方兄弟随布局自然跟走，不必再 FLIP。
 * 返回动画结束（或被取消）的 Promise；reducedMotion() 时立即 resolve。 */
export function foldOpen(node, { duration = 220, easing = FLIP_EASING } = {}) {
  return foldHeight(node, true, duration, easing);
}

export function foldClose(node, { duration = 180, easing = "cubic-bezier(.4,0,.2,1)" } = {}) {
  return foldHeight(node, false, duration, easing);
}

function foldHeight(node, opening, duration, easing) {
  if (!node || reducedMotion() || typeof node.animate !== "function") return Promise.resolve();
  const style = getComputedStyle(node);
  const open = {
    height: `${node.getBoundingClientRect().height / (getUiScaleFactor() || 1)}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    opacity: 1,
  };
  const shut = { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0 };
  node.style.overflow = "hidden";
  const animation = node.animate(opening ? [shut, open] : [open, shut], {
    duration, easing, fill: opening ? "none" : "forwards",
  });
  return animation.finished.then(() => { if (opening) node.style.overflow = ""; }, () => {});
}

/** 一批节点淡出并轻微缩小（fill: forwards 停在终态），给「先离场、再整段重绘」的调用方等。 */
export function fadeAway(nodes, { duration = 110, easing = "cubic-bezier(.4,0,1,1)" } = {}) {
  const list = [...(nodes || [])].filter((node) => node?.isConnected && typeof node.animate === "function");
  if (!list.length || reducedMotion()) return Promise.resolve();
  return settleAll(list.map((node) => node.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.96)" }],
    { duration, easing, fill: "forwards" },
  )));
}
