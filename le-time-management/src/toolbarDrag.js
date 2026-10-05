import { reducedMotion } from "./motion.js";
import { slotIndexFor } from "./railActions.js";
import { getUiScaleFactor } from "./uiScale.js";

// 顶栏与左下操作条共用：跟手浮起、FLIP 让位、松手落位；不参与业务数据写入。
const animations = new WeakMap();
const EASING = "cubic-bezier(.22,.8,.22,1)";

export function toolbarItems(list, selector) {
  return [...list.children].filter((node) => {
    if (!node.matches(selector) || !node.getClientRects().length) return false;
    // 居中的统计胶囊脱离 flex 流，不能把它的宽度算进横向槽位。
    return !["absolute", "fixed"].includes(getComputedStyle(node).position);
  });
}

// widths / left / gap / x 都是视口坐标；保留原按钮占位，避免指针停下时来回换位。
export function toolbarSlot(order, card, widths, left, gap, x, margins = new Map()) {
  const mids = [];
  let at = left;
  for (const node of order) {
    const margin = margins.get(node) || { left: 0, right: 0 };
    at += margin.left;
    const width = widths.get(node) || 0;
    if (node !== card) mids.push(at + width / 2);
    at += width + gap + margin.right;
  }
  return slotIndexFor(mids, x);
}

function play(node, frames, duration) {
  animations.get(node)?.cancel();
  if (typeof node.animate !== "function") return;
  const animation = node.animate(frames, { duration, easing: EASING });
  animations.set(node, animation);
  animation.onfinish = () => { if (animations.get(node) === animation) animations.delete(node); };
}

export function animateToolbarReorder(nodes, mutate, { scale = getUiScaleFactor() || 1 } = {}) {
  // 先记当前视觉位置，再取消上一次 FLIP；连续换位不累加残余 transform。
  const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
  for (const node of nodes) { animations.get(node)?.cancel(); animations.delete(node); }
  mutate();
  if (reducedMotion()) return;
  for (const node of nodes) {
    const old = before.get(node), now = node.getBoundingClientRect();
    const dx = (old.left - now.left) / scale, dy = (old.top - now.top) / scale;
    if (Math.abs(dx) + Math.abs(dy) < .1) continue;
    play(node, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], 185);
  }
}

export function attachToolbarDrag(list, onCommit, {
  selector = ".rail-dock-btn",
  ghostClass = "rail-dock-ghost",
  dragClass = "dragging",
  liveClass = "drag-live",
} = {}) {
  let pd = null;
  const items = () => toolbarItems(list, selector);
  const clearLong = (st) => { if (st.longTimer) clearTimeout(st.longTimer); st.longTimer = null; };
  const changed = (st) => st.originOrder.some((node, i) => list.children[i] !== node);

  const endSession = (st) => {
    clearLong(st);
    if (st.frame !== null) cancelAnimationFrame(st.frame);
    st.frame = null;
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onCancel, true);
    document.removeEventListener("keydown", onEscape, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
    st.ghost?.remove();
    st.card.classList.remove(dragClass);
    list.classList.remove(liveClass, "toolbar-drag-live");
    for (const [node, previous] of st.motionAttrs || []) {
      if (previous === null) node.removeAttribute("data-motion"); else node.setAttribute("data-motion", previous);
    }
    if (pd === st) pd = null;
    try { list.releasePointerCapture(st.pointerId); } catch { /* document 监听兜底 */ }
    // pointerup 后浏览器还会派发 click；拖动不能顺带打开设置、切主题或关闭窗口。
    if (st.swallowClick) setTimeout(() => document.removeEventListener("click", st.swallowClick, true), 0);
  };

  function cancel() {
    const st = pd;
    if (!st) return;
    if (st.active) animateToolbarReorder(items(), () => {
      for (const node of st.originOrder) if (node.parentElement === list) list.append(node);
    }, { scale: getUiScaleFactor() || 1 });
    st.active = false;
    endSession(st);
  }

  function update(st) {
    if (!st.active) return;
    if (!list.isConnected || st.card.parentElement !== list
      || Math.abs((getUiScaleFactor() || 1) - st.scale) > .0001) { cancel(); return; }
    const order = items();
    if (!order.includes(st.card)) { cancel(); return; }
    st.ghost?.style.setProperty("transform", `translate(${(st.x - st.gx) / st.scale}px, ${(st.y - st.gy) / st.scale}px) scale(1.025)`);
    const slot = toolbarSlot(order, st.card, st.widths, st.left, st.gap, st.x, st.margins);
    if (slot === st.slot) return;
    st.slot = slot;
    const peers = order.filter((node) => node !== st.card);
    animateToolbarReorder(peers, () => list.insertBefore(st.card, peers[slot] ?? null), { scale: st.scale });
  }

  // 只在输入改变时申请一帧；同一帧的多次 pointermove 只使用最后坐标。
  // 不缓存参与项，保留 update 对隐藏/移除节点的检查；静止时不轮询 DOM。
  function queueUpdate(st) {
    if (pd !== st || !st.active || st.frame !== null) return;
    st.frame = requestAnimationFrame(() => {
      st.frame = null;
      if (pd === st && st.active) update(st);
    });
  }

  function beginDrag(st) {
    if (pd !== st || st.active) return;
    const order = items();
    // 长按等待期间，按钮可能被隐藏或卸载，不能继续用失效的几何。
    if (!list.isConnected || st.card.parentElement !== list || !order.includes(st.card)) { cancel(); return; }
    clearLong(st);
    st.active = true;
    st.originOrder = [...list.children];
    st.scale = getUiScaleFactor() || 1;
    st.motionAttrs = new Map(order.map((node) => [node, node.getAttribute("data-motion")]));
    list.classList.add(liveClass, "toolbar-drag-live");
    for (const node of order) {
      node.setAttribute("data-motion", "off");
      for (const control of [node, ...node.querySelectorAll("button, [role='button']")]) {
        control.classList.remove("motion-pressing", "motion-clicked");
      }
      for (const ripple of node.querySelectorAll(".motion-ripple")) ripple.remove();
      animations.get(node)?.cancel();
    }
    const rect = st.card.getBoundingClientRect();
    st.gx = st.x - rect.left; st.gy = st.y - rect.top;
    // 新默认布局通过搜索按钮的自动外边距分出左右工具，槽位须包含这段真实空间。
    st.margins = new Map(order.map((node) => {
      const style = getComputedStyle(node);
      return [node, { left: (parseFloat(style.marginLeft) || 0) * st.scale, right: (parseFloat(style.marginRight) || 0) * st.scale }];
    }));
    st.left = order[0].getBoundingClientRect().left - st.margins.get(order[0]).left;
    st.gap = (parseFloat(getComputedStyle(list).columnGap) || 0) * st.scale;
    st.widths = new Map(order.map((node) => [node, node.getBoundingClientRect().width]));
    st.slot = order.indexOf(st.card);
    if (!reducedMotion()) {
      const ghost = st.card.cloneNode(true);
      ghost.classList.add(ghostClass);
      ghost.removeAttribute("id");
      ghost.removeAttribute("data-rail-id");
      ghost.removeAttribute("data-topbar-part");
      ghost.setAttribute("aria-hidden", "true");
      ghost.setAttribute("inert", "");
      ghost.setAttribute("tabindex", "-1");
      // 窗口控制组含嵌套按钮；克隆不能增加 Tab 停靠点或重复原来的 id。
      for (const child of ghost.querySelectorAll("[id]")) child.removeAttribute("id");
      for (const child of ghost.querySelectorAll("a[href], button, input, select, textarea, [tabindex], [contenteditable]")) {
        child.setAttribute("tabindex", "-1");
        child.removeAttribute("autofocus");
        if (child.hasAttribute("contenteditable")) child.setAttribute("contenteditable", "false");
      }
      ghost.setAttribute("data-motion", "off");
      for (const ripple of ghost.querySelectorAll(".motion-ripple")) ripple.remove();
      const css = getComputedStyle(st.card);
      Object.assign(ghost.style, {
        width: `${rect.width / st.scale}px`, height: `${rect.height / st.scale}px`,
        padding: css.padding, font: css.font, color: css.color, gap: css.gap,
      });
      document.body.append(ghost);
      st.ghost = ghost;
    }
    st.card.classList.add(dragClass);
    st.swallowClick = (event) => { event.preventDefault(); event.stopPropagation(); };
    document.addEventListener("click", st.swallowClick, true);
    // 捕获到不移动的容器，避免 insertBefore 移动按钮时丢失 pointer capture。
    try { list.setPointerCapture(st.pointerId); } catch { /* document 监听兜底 */ }
    queueUpdate(st);
  }

  function onDown(event) {
    if (pd || (event.pointerType === "mouse" && event.button !== 0)) return;
    const card = event.target.closest?.(selector);
    if (!card || card.parentElement !== list || !items().includes(card) || card.disabled) return;
    pd = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, active: false, frame: null, longTimer: null };
    if (event.pointerType !== "mouse") {
      const st = pd;
      pd.longTimer = setTimeout(() => { if (pd === st) beginDrag(st); }, 240);
    }
    // 从按下就监听，尚未进入拖拽时在容器外松手也能清掉长按定时器。
    document.addEventListener("pointermove", onMove, { capture: true, passive: false });
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
  }

  function onMove(event) {
    const st = pd;
    if (!st || event.pointerId !== st.pointerId) return;
    st.x = event.clientX; st.y = event.clientY;
    if (st.active) { event.preventDefault(); queueUpdate(st); return; }
    const dx = st.x - st.startX, dy = st.y - st.startY;
    if (st.longTimer) { if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLong(st); return; }
    if (event.pointerType === "mouse" && Math.hypot(dx, dy) >= 6) beginDrag(st);
  }

  function onUp(event) {
    const st = pd;
    if (!st || event.pointerId !== st.pointerId) return;
    if (!st.active) { endSession(st); return; }
    st.x = event.clientX; st.y = event.clientY;
    update(st);
    if (pd !== st) return;
    const didChange = changed(st), ghostRect = st.ghost?.getBoundingClientRect();
    st.active = false;
    endSession(st);
    if (didChange) onCommit?.();
    if (ghostRect && !reducedMotion() && list.contains(st.card)) {
      const landed = st.card.getBoundingClientRect();
      play(st.card, [
        { transformOrigin: "0 0", transform: `translate(${(ghostRect.left - landed.left) / st.scale}px, ${(ghostRect.top - landed.top) / st.scale}px) scale(1.025)` },
        { transformOrigin: "0 0", transform: "none" },
      ], 210);
    }
  }

  function onCancel(event) { if (pd && event.pointerId === pd.pointerId) cancel(); }
  function onEscape(event) { if (event.key === "Escape") { event.preventDefault(); cancel(); } }
  function onLostCapture(event) {
    // 触屏从原按钮的隐式捕获切到容器时，子按钮的 lostpointercapture 会冒泡到这里。
    // 只有容器自身丢失捕获才取消，不能把正常的捕获转移误判为中断。
    if (event.target === list && pd?.active && event.pointerId === pd.pointerId) cancel();
  }
  function onNativeDrag(event) { if (event.target.closest?.(selector)) event.preventDefault(); }
  function onTouchMove(event) { if (pd?.active) event.preventDefault(); }
  function onKey(event) {
    if (pd || event.defaultPrevented || !event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const card = event.target.closest?.(selector), order = items();
    const at = order.indexOf(card), to = at + (event.key === "ArrowRight" ? 1 : -1);
    if (at < 0 || card.disabled || card.getAttribute("aria-disabled") === "true") return;
    // 首/末项也要消费快捷键，否则 Alt+方向键会落到宿主的后退/前进。
    event.preventDefault();
    if (to < 0 || to >= order.length) return;
    const focus = document.activeElement;
    animateToolbarReorder(order, () => list.insertBefore(card, to > at ? order[to].nextSibling : order[to]));
    onCommit?.();
    (focus || card).focus?.({ preventScroll: true });
  }

  list.addEventListener("pointerdown", onDown);
  list.addEventListener("lostpointercapture", onLostCapture);
  list.addEventListener("dragstart", onNativeDrag);
  list.addEventListener("touchmove", onTouchMove, { passive: false });
  list.addEventListener("keydown", onKey);
  return { cancel, destroy() {
    cancel();
    list.removeEventListener("pointerdown", onDown);
    list.removeEventListener("lostpointercapture", onLostCapture);
    list.removeEventListener("dragstart", onNativeDrag);
    list.removeEventListener("touchmove", onTouchMove);
    list.removeEventListener("keydown", onKey);
  } };
}
