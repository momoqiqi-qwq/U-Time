import { slotIndexFor } from "./railActions.js";
import { reducedMotion } from "./motion.js";
import { getUiScaleFactor } from "./uiScale.js";

/* ── 侧栏插件拖拽重排 ─────────────────────────────────────────────────────────
 * 被拖项仍留在 flex 流里充当明确空槽；body 上的克隆项跟随指针。激活后用 rAF
 * 每帧按缓存的 item 高度重新推演落点，DOM 一变，其余项各自用 FLIP 追赶新位置。
 * 指针停下时槽位不再变化，所有项自然停在当前布局，不会自动滑向列表端点。
 * 几何量一律是视口坐标（zoom 之后的视觉像素：指针、getBoundingClientRect），
 * 写进 transform / 宽高之前除以 st.scale —— 与 toolbarDrag.js 同一口径；
 * 否则界面缩放不是 100% 时浮起项会偏离指针、FLIP 起点会跳。
 */
export function attachPluginListDrag(list, onCommit) {
  let pd = null;
  const items = () => [...list.querySelectorAll(":scope > button[data-plugin-id]")];
  const clearLong = (st) => { if (st.longTimer) { clearTimeout(st.longTimer); st.longTimer = null; } };
  const detachDoc = (st) => {
    document.removeEventListener("pointerup", st.docUp, true);
    document.removeEventListener("pointermove", st.docMove, true);
    document.removeEventListener("scroll", st.docScroll, true);
    window.removeEventListener("blur", st.docCancel);
    window.removeEventListener("resize", st.docCancel);
    document.removeEventListener("pointercancel", st.docCancel, true);
  };
  const moveGhost = (st) => st.ghost?.style.setProperty("transform", `translate3d(${(st.x - st.gx) / st.scale}px, ${(st.y - st.gy) / st.scale}px, 0)`);
  const stopFrame = (st) => { if (st.frame) cancelAnimationFrame(st.frame); st.frame = 0; };
  const endSession = (st) => {
    clearLong(st); stopFrame(st); detachDoc(st);
    st.flips?.forEach(animation => animation.cancel()); st.flips?.clear();
    st.ghost?.remove(); st.ghost = null;
    if (st.originOrder) {
      if (st.motionBefore === undefined) delete st.card.dataset.motion;
      else st.card.dataset.motion = st.motionBefore;
    }
    st.card?.classList.remove("nav-dragging");
    list.classList.remove("plugin-drag-live");
    try { st.card?.releasePointerCapture(st.pointerId); } catch { /* document 兜底已覆盖 */ }
    if (st.swallowClick) setTimeout(() => document.removeEventListener("click", st.swallowClick, true), 0);
    if (pd === st) pd = null;
  };
  const cancel = (st = pd) => {
    if (!st) return;
    if (st.active) for (const node of st.originOrder) list.append(node);
    st.active = false;
    endSession(st);
  };
  const computeSlot = (st, y) => {
    // 祖先滚动后只读取容器位置；条目高度仍来自稳定缓存，不受 FLIP transform 污染。
    let top = list.getBoundingClientRect().top + st.contentInset;
    const mids = [];
    for (const item of st.peers) {
      const height = st.heights.get(item) ?? item.getBoundingClientRect().height;
      mids.push(top + height / 2);
      top += height + st.gap;
    }
    return slotIndexFor(mids, y);
  };
  const reorderDOM = (st, slot) => {
    const peers = st.peers;
    const before = new Map(peers.map((node) => [node, node.getBoundingClientRect().top]));
    // 先取当前视觉位置，再取消旧让位动画，避免快速反向时动画叠加、越拖越滞后。
    st.flips.forEach(animation => animation.cancel()); st.flips.clear();
    list.insertBefore(st.card, peers[slot] ?? null);
    if (reducedMotion()) return;
    for (const node of peers) {
      const dy = (before.get(node) - node.getBoundingClientRect().top) / st.scale;
      if (dy) st.flips.set(node, node.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: 120, easing: "cubic-bezier(.22,.8,.22,1)" }));
    }
  };
  const frame = (st) => {
    st.frame = 0;
    if (!st.active) return;
    if (!list.isConnected || !list.contains(st.card)) { cancel(st); return; }
    moveGhost(st);
    const slot = computeSlot(st, st.y);
    if (slot !== st.slot) { st.slot = slot; reorderDOM(st, slot); }
  };
  const queueFrame = (st) => {
    if (st.active && !st.frame) st.frame = requestAnimationFrame(() => frame(st));
  };
  const finish = (st) => {
    if (!st.active) return;
    // 松手前同步最后一次落点，即使 pointerup 早于下一帧也不能丢掉最终移动。
    stopFrame(st); frame(st);
    if (!st.active) return;
    st.active = false;
    const ghostRect = st.ghost?.getBoundingClientRect();
    st.card.classList.remove("nav-dragging");
    list.classList.remove("plugin-drag-live");
    onCommit?.();
    if (ghostRect && !reducedMotion()) {
      const landed = st.card.getBoundingClientRect();
      st.card.animate([
        { transform: `translate(${(ghostRect.left - landed.left) / st.scale}px, ${(ghostRect.top - landed.top) / st.scale}px)` },
        { transform: "none" },
      ], { duration: 140, easing: "cubic-bezier(.22,.8,.22,1)" });
    }
    endSession(st);
  };
  const begin = (st) => {
    if (!list.contains(st.card) || st.active) return;
    st.active = true; clearLong(st);
    st.originOrder = [...list.children];
    st.motionBefore = st.card.dataset.motion; st.card.dataset.motion = "off";
    st.card.getAnimations?.().forEach(animation => animation.cancel());
    st.flips = new Map();
    st.peers = items().filter(node => node !== st.card);
    st.scale = getUiScaleFactor() || 1;
    const rect = st.card.getBoundingClientRect();
    st.gx = st.startX - rect.left; st.gy = st.startY - rect.top;
    st.gap = (parseFloat(getComputedStyle(list).rowGap) || 0) * st.scale;
    st.contentInset = (items()[0]?.getBoundingClientRect().top ?? list.getBoundingClientRect().top) - list.getBoundingClientRect().top;
    // 按节点缓存视觉高度：多视图插件的几个按钮 data-plugin-id 相同，按 ID 缓存会互相覆盖
    st.heights = new Map(items().map((node) => [node, node.getBoundingClientRect().height]));
    st.card.classList.add("nav-dragging"); list.classList.add("plugin-drag-live");
    { // 跟手副本属于交互反馈；减少动效只跳过让位/落位动画，不隐藏拖动内容。
      st.ghost = st.card.cloneNode(true);
      st.ghost.classList.remove("nav-dragging", "on");
      st.ghost.classList.add("plugin-nav-ghost");
      st.ghost.setAttribute("aria-hidden", "true");
      st.ghost.tabIndex = -1;
      st.ghost.removeAttribute("id");
      st.ghost.removeAttribute("data-plugin-id");
      st.ghost.style.width = `${rect.width / st.scale}px`; st.ghost.style.height = `${rect.height / st.scale}px`;
      document.body.append(st.ghost);
      moveGhost(st); // 激活当次就定位，不先在左上角出现一帧。
    }
    navigator.vibrate?.(10);
    st.swallowClick = (event) => { event.preventDefault(); event.stopPropagation(); };
    document.addEventListener("click", st.swallowClick, true);
    try { st.card.setPointerCapture(st.pointerId); } catch { /* document 兜底 */ }
    st.docMove = (event) => {
      if (event.pointerId !== st.pointerId || !st.active) return;
      st.x = event.clientX; st.y = event.clientY;
      event.preventDefault();
      moveGhost(st); // 指针事件直接写 transform；排序/测量合并到下一帧。
      queueFrame(st);
    };
    st.docScroll = () => queueFrame(st);
    st.docUp = (event) => { if (event.pointerId === st.pointerId) { st.x = event.clientX; st.y = event.clientY; finish(st); } };
    st.docCancel = (event) => { if (event.pointerId == null || event.pointerId === st.pointerId) cancel(st); };
    document.addEventListener("pointermove", st.docMove, { capture: true, passive: false });
    document.addEventListener("scroll", st.docScroll, true);
    window.addEventListener("blur", st.docCancel);
    window.addEventListener("resize", st.docCancel);
    document.addEventListener("pointerup", st.docUp, true);
    document.addEventListener("pointercancel", st.docCancel, true);
    st.slot = items().indexOf(st.card);
    queueFrame(st);
  };

  list.addEventListener("pointerdown", (event) => {
    if (event.isPrimary === false || pd?.active || (event.pointerType === "mouse" && event.button !== 0)) return;
    // 行尾的悬停操作条（… 更多 / 📌 置顶）长在导航按钮**内部**：不拦住的话按下去就变成
    // 拖拽，松手后插件被顺手挪位（closest 会一路找到外层 button[data-plugin-id]）。
    if (event.target.closest?.(".nav-act")) return;
    if (pd) cancel(pd);
    const card = event.target.closest?.("button[data-plugin-id]");
    if (!card || !list.contains(card)) return;
    pd = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, scale: 1, active: false, longTimer: null, frame: 0, ghost: null, swallowClick: null, docUp: null, docCancel: null };
    if (event.pointerType !== "mouse") pd.longTimer = setTimeout(() => { if (pd?.card === card && !pd.active) begin(pd); }, 240);
  });
  list.addEventListener("pointermove", (event) => {
    const st = pd;
    if (!st || event.pointerId !== st.pointerId) return;
    st.x = event.clientX; st.y = event.clientY;
    if (st.active) { event.preventDefault(); return; }
    const dx = st.x - st.startX, dy = st.y - st.startY;
    if (st.longTimer) { if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLong(st); return; }
    if (event.pointerType === "mouse" && Math.hypot(dx, dy) >= 4) begin(st);
  });
  list.addEventListener("pointerup", (event) => {
    const st = pd; if (!st || event.pointerId !== st.pointerId) return;
    if (st.active) finish(st); else endSession(st);
  });
  list.addEventListener("pointercancel", (event) => { if (pd && event.pointerId === pd.pointerId) cancel(pd); });
  list.addEventListener("touchmove", (event) => { if (pd?.active) event.preventDefault(); }, { passive: false });
  list.addEventListener("keydown", (event) => {
    if (pd?.active && event.key === "Escape") { event.preventDefault(); cancel(pd); return; }
    if (pd?.active) return;
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const card = event.target.closest?.("button[data-plugin-id]");
    const order = items(); const at = order.indexOf(card); const to = at + (event.key === "ArrowDown" ? 1 : -1);
    if (at < 0 || to < 0 || to >= order.length) return;
    event.preventDefault();
    if (to > at) list.insertBefore(card, order[to].nextSibling); else list.insertBefore(card, order[to]);
    onCommit?.(); card.focus();
  });
}

