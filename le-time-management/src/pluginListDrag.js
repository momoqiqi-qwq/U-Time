import { slotIndexFor } from "./railActions.js";
import { reducedMotion } from "./motion.js";
import { getUiScaleFactor } from "./uiScale.js";

/* ── 侧栏插件拖拽重排 ─────────────────────────────────────────────────────────
 * 拖动项**就是原件本身**：不克隆副本、不挂到 body，直接给被拖按钮写 translate3d
 * 跟手 —— 与 tauri-shortcut-launcher 的子目录上下拖动（src/components/Sidebar/
 * Sidebar.tsx 的 useSortable + verticalListSortingStrategy）同一套模型。
 * v0.197.0 之前是「原位留空槽 + body 上的克隆副本跟手」，两份配色一样 ⇒ 看上去
 * 是两个一模一样的项目（v0.134.0 把空槽从半透明虚线改成实心高亮后尤其明显）。
 *
 * 拖动中不重排 DOM：其余项各自写一条 translateY 让出落点（原件离开原位后，
 * 后面的项逐项补上原位，落点处空出一格）。指针停下时布局就停在当前状态，
 * 不会自动滑向列表端点；松手才把 DOM 顺序真正落地，再播一段落位动画。
 *
 * 几何量一律是视口坐标（zoom 之后的视觉像素：指针、getBoundingClientRect），
 * 写进 transform 之前除以 st.scale —— 与 toolbarDrag.js 同一口径；
 * 否则界面缩放不是 100% 时浮起项会偏离指针。
 */
export function attachPluginListDrag(list, onCommit) {
  const SHIFT_MS = 140; // 其余项让位
  const LAND_MS = 140;  // 松手落位
  const EASE = "cubic-bezier(.22,.8,.22,1)";
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
  const stopFrame = (st) => { if (st.frame) cancelAnimationFrame(st.frame); st.frame = 0; };
  /* 原件跟手：位移 = 指针位移 − 容器自身漂移。滚动后原件在流里的位置也跟着挪，
     不减掉这一项，指针不动而列表滚动时原件会从指针底下飘走。 */
  const moveCard = (st) => {
    st.card.style.transform = `translate3d(${(st.x - st.startX) / st.scale}px, ${(st.y - st.startY - st.drift) / st.scale}px, 0)`;
  };
  /* 颜色卡片（.nav .plug-group）是 overflow: hidden，原件一旦被拖出卡片边界就被裁掉。
     拖动期间临时放开「段容器 → .plug-list」这条链上的裁切，松手原样还回去。
     .nav 是滚动容器，绝不能碰 —— 放开它侧栏列表会漏到栏外。 */
  const unclip = (st) => {
    st.unclipped = [];
    for (let node = list.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.classList?.contains("nav")) break;
      st.unclipped.push([node, node.style.overflow]);
      node.style.overflow = "visible";
      if (node.classList?.contains("plug-list")) break;
    }
  };
  const reclip = (st) => { for (const [node, prev] of st.unclipped || []) node.style.overflow = prev; };
  const clearShifts = (st) => {
    for (const node of st.peers || []) { node.style.transition = ""; node.style.transform = ""; }
    st.shifted?.clear();
  };
  const endSession = (st) => {
    clearLong(st); stopFrame(st); detachDoc(st);
    clearShifts(st); reclip(st);
    if (st.began) {
      if (st.motionBefore === undefined) delete st.card.dataset.motion;
      else st.card.dataset.motion = st.motionBefore;
    }
    if (st.card) { st.card.style.transform = ""; st.card.style.willChange = ""; }
    st.card?.classList.remove("nav-dragging");
    list.classList.remove("plugin-drag-live");
    try { st.card?.releasePointerCapture(st.pointerId); } catch { /* document 兜底已覆盖 */ }
    if (st.swallowClick) setTimeout(() => document.removeEventListener("click", st.swallowClick, true), 0);
    if (pd === st) pd = null;
  };
  /* 取消不用还原顺序：拖动期间 DOM 一行没动，清掉位移就回到原样。 */
  const cancel = (st = pd) => { if (!st) return; st.active = false; endSession(st); };
  const slotOf = (st, y) => {
    // 落点判定一律用「未位移」的位置（缓存值 + 容器漂移）：让位位移不参与判定，
    // 否则判定与让位互相喂养，指针停着也会来回抖。
    const mids = st.peers.map((node) => (st.tops.get(node) ?? list.getBoundingClientRect().top)
      + st.drift + (st.heights.get(node) ?? 0) / 2);
    return slotIndexFor(mids, y);
  };
  /* 让位：原件从 from 挪到 slot，跨过的那几项各让一格。DOM 顺序不动、只有 transform，
     松手落地时它们的自然位置正好等于这里算出的视觉位置，所以清掉位移不会跳。 */
  const applyShift = (st, slot) => {
    if (slot === st.slot) return;
    st.slot = slot;
    const step = st.step / st.scale;
    for (let i = 0; i < st.peers.length; i++) {
      const node = st.peers[i];
      const px = (slot > st.from && i >= st.from && i < slot) ? -step
        : (slot < st.from && i >= slot && i < st.from) ? step : 0;
      if ((st.shifted.get(node) ?? 0) === px) continue;
      if (px) st.shifted.set(node, px); else st.shifted.delete(node);
      node.style.transform = px ? `translate3d(0, ${px}px, 0)` : "";
    }
  };
  /* 松手后原件落在哪：把它从流里摘掉（后面各项上移一格），再插进 slot 位。 */
  const landingTop = (st, slot) => {
    if (!st.peers.length) return st.tops.get(st.card) + st.drift;
    const post = (i) => st.tops.get(st.peers[i]) + st.drift - (i >= st.from ? st.step : 0);
    return slot < st.peers.length ? post(slot) : post(st.peers.length - 1) + st.step;
  };
  const frame = (st) => {
    st.frame = 0;
    if (!st.active) return;
    if (!list.isConnected || !list.contains(st.card)) { cancel(st); return; }
    st.drift = (list.getBoundingClientRect().top - st.listTop) - ((list.scrollTop || 0) - st.listScroll);
    moveCard(st); // 滚动之后指针没动，也要按 drift 贴回来
    applyShift(st, slotOf(st, st.y));
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
    const slot = st.slot;
    // 落位动画的起点 = 原件此刻的视觉位置，相对的是**松手后**的自然位置。
    const landX = (st.x - st.startX) / st.scale;
    const landY = (st.tops.get(st.card) + (st.y - st.startY) - landingTop(st, slot)) / st.scale;
    st.card.classList.remove("nav-dragging");
    list.classList.remove("plugin-drag-live");
    // 到这里才真正落地 DOM 顺序：其余项的自然位置即最终位置，清掉让位位移不会跳。
    list.insertBefore(st.card, st.peers[slot] ?? null);
    clearShifts(st);
    st.card.style.transform = "";
    onCommit?.();
    if (!reducedMotion() && typeof st.card.animate === "function" && (landX || landY)) {
      st.card.animate([{ transform: `translate3d(${landX}px, ${landY}px, 0)` }, { transform: "none" }],
        { duration: LAND_MS, easing: EASE });
    }
    endSession(st);
  };
  const begin = (st) => {
    if (!list.contains(st.card) || st.active) return;
    st.active = true; st.began = true; clearLong(st);
    st.scale = getUiScaleFactor() || 1;
    st.motionBefore = st.card.dataset.motion; st.card.dataset.motion = "off";
    st.card.getAnimations?.().forEach(animation => animation.cancel());
    st.order = items();
    st.from = st.order.indexOf(st.card);
    st.peers = st.order.filter(node => node !== st.card);
    // 按节点缓存视觉几何：多视图插件的几个按钮 data-plugin-id 相同，按 ID 缓存会互相覆盖
    st.tops = new Map(st.order.map((node) => [node, node.getBoundingClientRect().top]));
    st.heights = new Map(st.order.map((node) => [node, node.getBoundingClientRect().height]));
    st.gap = (parseFloat(getComputedStyle(list).rowGap) || 0) * st.scale;
    st.cardHeight = st.heights.get(st.card) ?? st.card.getBoundingClientRect().height;
    st.step = st.cardHeight + st.gap; // 原件让位一格的距离（视口像素）
    st.listTop = list.getBoundingClientRect().top;
    st.listScroll = list.scrollTop || 0;
    st.drift = 0;
    st.shifted = new Map();
    st.slot = st.from;
    unclip(st);
    st.card.classList.add("nav-dragging"); list.classList.add("plugin-drag-live");
    // 减少动效只跳过装饰性的让位 / 落位动画，拖动内容本身照旧直接跟手。
    if (reducedMotion()) for (const node of st.peers) node.style.transition = "none";
    moveCard(st); // 激活当次就定位，不先在左上角出现一帧
    navigator.vibrate?.(10);
    st.swallowClick = (event) => { event.preventDefault(); event.stopPropagation(); };
    document.addEventListener("click", st.swallowClick, true);
    try { st.card.setPointerCapture(st.pointerId); } catch { /* document 兜底 */ }
    st.docMove = (event) => {
      if (event.pointerId !== st.pointerId || !st.active) return;
      st.x = event.clientX; st.y = event.clientY;
      event.preventDefault();
      moveCard(st); // 指针事件直接写 transform；落点推演合并到下一帧。
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
    pd = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, scale: 1, active: false, began: false, longTimer: null, frame: 0, swallowClick: null, docUp: null, docCancel: null };
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
