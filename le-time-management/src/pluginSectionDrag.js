import { slotIndexFor } from "./railActions.js";
import { reducedMotion } from "./motion.js";
import { getUiScaleFactor } from "./uiScale.js";

/* ── 侧栏颜色组整卡拖动重排（v0.215.0）──────────────────────────────────────
 * 需求原文：「让侧边栏组合成的颜色组也可以被拖动，或者说，将其融入侧边栏的拖动系统中。」
 *
 * 拖动单位是**整张颜色卡片**（.plug-list 的直接子节点 .plug-group[data-color]），
 * 不是卡片里的某一行插件（那是 pluginListDrag 的活）。两套控制器共用同一个模型，
 * 所以观感与手感一致：原件自己浮起跟手、其余段各让一截、拖动中一行 DOM 都不动、
 * 松手才落地顺序并播一段落位动画；鼠标 4px / 触屏长按 240ms 起拖，
 * Escape 与 pointercancel 干净收场，Alt+↑/↓ 键盘换位，减少动效只跳装饰动画。
 *
 * 与段内拖动唯一的差别是**几何不再等高**：卡片、无色段、置顶段的高度与上下外边距
 * 各不相同，相邻兄弟的外边距还会合并。所以这里不套「原件高度 + gap」那套递推，
 * 改成开拖时量三个量：
 *   · tops[i] —— 各段此刻（原件还在场）的位置；
 *   · gone[i] —— 把原件临时摘出流后各段的位置（display:none 量一次，同帧还回去）；
 *   · 卡片自己的上下外边距，以及落点前后那两段的外边距。
 * 由此得到两个精确量：
 *   · 原件占的流高度 foot = tops[from] − gone[from]（它离场后，后面各段上移的距离）；
 *   · 落点 top(slot) = gone[slot] + gBefore − gDirect（gBefore 含原件自己的上外边距、
 *     gDirect 不含 —— 两者之差就是插入后兄弟外边距合并方式的改变量）。
 * 用实测值而不是「高度 + 固定 gap」，是因为外边距合并让空档随邻居而变：
 * 置顶段下边距 6px、卡片 3px、无色段 0，同一个落点的空档在 3px 与 6px 之间变。
 * 另一个坑是**两把尺子**：外边距来自 getComputedStyle（元素自己的 CSS px，界面缩放走的是
 * html 上的 zoom，计算值不跟着变），位置来自 getBoundingClientRect（已乘过 zoom）。
 * 所以外边距一律乘上缩放系数换成视口像素再参与几何，否则 150% 缩放下落点会歪两三像素。
 *
 * 让位位移与落点同出一套实测值，所以「清掉位移不会跳」这条与段内拖动同样成立：
 * 被让位的段，其自然位置正好等于它此刻的视觉位置 —— 见 test-plugin-section-drag.mjs
 * 里对落位动画首帧的断言（首帧 = 原件此刻的视觉位置，差一像素就是松手时的一跳）。
 *
 * 不参与拖动的两类节点：
 *   · 置顶段（.plug-seg-pinned）—— 它永远渲染在最上方（pinnedPlugins 与 pluginOrder
 *     正交，见 pluginPins.js），拖到它上面只会被下一次重绘弹回来。所以既不许拖、
 *     也不让位：落点 0 就是「紧贴置顶段下方」。
 *   · 无色段（.plug-seg 没有卡片外壳）—— 整段都是插件按钮、没有可抓的头部，
 *     所以不当拖动单位；但它照样**让位**，要挪它拖它里面的插件即可（段内拖动）。
 */
export function attachPluginSectionDrag(list, { onCommit, onMove } = {}) {
  const LAND_MS = 140;   // 松手落位（让位时长写在 styles.css 的 .plug-section-drag-live 上）
  const EASE = "cubic-bezier(.22,.8,.22,1)";
  // 参与让位的段 = 颜色卡片 + 无色段；置顶段在 begin() 里单独摘掉。
  const SECTION = ":scope > .plug-group, :scope > .plug-seg";
  let pd = null;

  const sections = () => [...list.querySelectorAll(SECTION)];
  /* 外边距一律先换算到**视口像素**再参与几何：getComputedStyle 给的是元素自己的 CSS px
     （界面缩放走的是 html 上的 zoom，计算值不跟着变），而 getBoundingClientRect 给的坐标
     已经乘过 zoom。混着加会在 150% 缩放下把落点算歪两三像素 —— 松手那一下就是一跳。 */
  const edgePx = (st, node, side) => {
    let rec = st.edges.get(node);
    if (!rec) {
      const cs = getComputedStyle(node);
      rec = { top: parseFloat(cs.marginTop) || 0, bottom: parseFloat(cs.marginBottom) || 0 };
      st.edges.set(node, rec);
    }
    return rec[side] * st.scale;
  };
  /* 插入点的前一个兄弟 —— 跳过正在拖的那张卡片。相邻兄弟的外边距会合并，
     空档取两边较大的那个（本项目全是正外边距，没有负值要相减）。 */
  const prevOf = (node, card) => {
    let prev = node.previousElementSibling;
    while (prev === card) prev = prev.previousElementSibling;
    return prev;
  };
  const gapBetween = (st, prev, next) => (prev
    ? Math.max(edgePx(st, prev, "bottom"), edgePx(st, next, "top")) : 0);
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
  /* 原件跟手：位移 = 指针位移 − 容器自身漂移（与 pluginListDrag 同一口径，
     祖先滚动后原件在流里的位置也跟着挪，不减掉这一项它会从指针底下飘走）。 */
  const moveCard = (st) => {
    st.card.style.transform = `translate3d(${(st.x - st.startX) / st.scale}px, ${(st.y - st.startY - st.drift) / st.scale}px, 0)`;
  };
  const clearShifts = (st) => {
    for (const node of st.peers || []) { node.style.transition = ""; node.style.transform = ""; }
    st.shifted?.clear();
  };
  const endSession = (st) => {
    clearLong(st); stopFrame(st); detachDoc(st);
    clearShifts(st);
    if (st.began) {
      if (st.motionBefore === undefined) delete st.card.dataset.motion;
      else st.card.dataset.motion = st.motionBefore;
    }
    if (st.card) { st.card.style.transform = ""; st.card.style.willChange = ""; }
    st.card?.classList.remove("nav-dragging");
    list.classList.remove("plugin-section-drag-live");
    try { st.card?.releasePointerCapture(st.pointerId); } catch { /* document 兜底已覆盖 */ }
    if (st.swallowClick) setTimeout(() => document.removeEventListener("click", st.swallowClick, true), 0);
    if (pd === st) pd = null;
  };
  /* 取消不用还原顺序：拖动期间 DOM 一行没动，清掉位移就回到原样。 */
  const cancel = (st = pd) => { if (!st) return; st.active = false; endSession(st); };
  /* 松手后原件落在哪：先把它从流里摘掉（各段落到 gone），再插进 slot 位。
     slot < 段数 —— 插在 peers[slot] 之前：它的新位置 = gone[slot] 再加「插入把后一段
       推下去的量」，而那个量正是上面两个空档之差，代进去只剩 gone[slot] + 上方空档
       − 摘掉后那两个邻居之间的空档。
     slot = 段数 —— 落在最末：最后一段的底 + 它与原件之间的空档。 */
  const landingAt = (st, slot) => {
    const peers = st.peers;
    if (slot < peers.length) {
      const next = peers[slot];
      const prev = prevOf(next, st.card);
      return st.gone.get(next) + gapBetween(st, prev, st.card) - gapBetween(st, prev, next);
    }
    const last = peers[peers.length - 1];
    return st.gone.get(last) + st.heights.get(last) + gapBetween(st, last, st.card);
  };
  const slotOf = (st, y) => {
    // 落点判定一律用「未位移」的位置（缓存值 + 容器漂移）：让位位移不参与判定，
    // 否则判定与让位互相喂养，指针停着也会来回抖。
    const mids = st.peers.map((node) => (st.tops.get(node) ?? st.listTop)
      + st.drift + (st.heights.get(node) ?? 0) / 2);
    return slotIndexFor(mids, y);
  };
  /* 让位：原件从 from 挪到 slot，每一段的位移就是「它落位后的自然位置 − 它此刻的自然位置」。
     落位后的位置在「原件离场」那一量上算：插进 slot 位之后，slot 及之后的段整体下移
     deltas[slot]。这样清零位移**永远不跳** —— 连那些没被跨过、却因为相邻空档合并关系变了
     而挪了一两像素的段也一起算进去（按「跨过的段各让一截」递推会漏掉它们）。 */
  const shiftOf = (st, slot, index) => st.gone.get(st.peers[index])
    + (index >= slot ? st.deltas[slot] : 0) - st.tops.get(st.peers[index]);
  const applyShift = (st, slot) => {
    if (slot === st.slot) return;
    st.slot = slot;
    for (let i = 0; i < st.peers.length; i++) {
      const node = st.peers[i];
      const px = shiftOf(st, slot, i);
      if ((st.shifted.get(node) ?? 0) === px) continue;
      if (px) st.shifted.set(node, px); else st.shifted.delete(node);
      node.style.transform = px ? `translate3d(0px, ${px / st.scale}px, 0)` : "";
    }
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
    // 原件的视觉位置里 drift 已经抵消（它 1:1 跟指针），落点却要加回 drift ——
    // 落点是按开拖那一帧量的，容器滚过之后自然位置整体挪了一个 drift。
    const landX = (st.x - st.startX) / st.scale;
    const landY = (st.cardTop + (st.y - st.startY) - (st.lands[slot] + st.drift)) / st.scale;
    st.card.classList.remove("nav-dragging");
    list.classList.remove("plugin-section-drag-live");
    // 到这里才真正落地 DOM 顺序：其余段的自然位置即最终位置，清掉让位位移不会跳。
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
    const card = st.card;
    const all = sections();
    const pinnedSeg = list.querySelector(":scope > .plug-seg-pinned");
    const peers = all.filter((node) => node !== card && node !== pinnedSeg);
    if (!peers.length) { st.dead = true; return; } // 侧栏里只有这一张卡片：没有可换的位置
    st.active = true; st.began = true; clearLong(st);
    st.scale = getUiScaleFactor() || 1;
    st.motionBefore = card.dataset.motion; card.dataset.motion = "off";
    card.getAnimations?.().forEach((animation) => animation.cancel());
    st.peers = peers;
    // 原件此刻占着第几槽 = 它前面有几段（置顶段不算）
    st.from = peers.filter((node) => all.indexOf(node) < all.indexOf(card)).length;
    st.edges = new Map();   // 外边距缓存：按次建，免得跨次拖动读到旧值
    st.tops = new Map(peers.map((node) => [node, node.getBoundingClientRect().top]));
    st.heights = new Map(peers.map((node) => [node, node.getBoundingClientRect().height]));
    const cardRect = card.getBoundingClientRect();
    st.cardTop = cardRect.top;
    st.height = cardRect.height;
    st.listTop = list.getBoundingClientRect().top;
    st.listScroll = list.scrollTop || 0;
    /* 原件离场后各段落到哪：临时把它摘出流量一次，同一个任务里还回去（不会闪一帧，
       浏览器要等这个任务结束才绘制）。⚠️ .nav 是滚动容器，摘掉卡片内容就变矮 ——
       贴着底部时浏览器会夹住 scrollTop，量完必须把滚动位置还回去，否则侧栏自己跳一下。 */
    const scroller = list.closest(".nav");
    const scrollBefore = scroller ? scroller.scrollTop : 0;
    const displayBefore = card.style.display;
    st.gone = new Map();
    card.style.display = "none";
    for (const node of peers) st.gone.set(node, node.getBoundingClientRect().top);
    card.style.display = displayBefore;
    if (scroller && scroller.scrollTop !== scrollBefore) scroller.scrollTop = scrollBefore;
    st.lands = [];
    st.deltas = [];
    for (let slot = 0; slot <= peers.length; slot++) {
      st.lands[slot] = landingAt(st, slot);
      // 插进 slot 位后，slot 之后的每一段整体下移这么多（插在最末时后面没有段，为 0）。
      st.deltas[slot] = slot < peers.length
        ? st.lands[slot] + st.height + gapBetween(st, st.card, peers[slot]) - st.gone.get(peers[slot])
        : 0;
    }
    st.drift = 0;
    st.shifted = new Map();
    st.slot = st.from;
    card.classList.add("nav-dragging");
    list.classList.add("plugin-section-drag-live");
    // 减少动效只跳过装饰性的让位 / 落位动画，拖动内容本身照旧直接跟手。
    if (reducedMotion()) for (const node of peers) node.style.transition = "none";
    moveCard(st); // 激活当次就定位，不先在原位闪一帧
    navigator.vibrate?.(10);
    st.swallowClick = (event) => { event.preventDefault(); event.stopPropagation(); };
    document.addEventListener("click", st.swallowClick, true);
    try { card.setPointerCapture(st.pointerId); } catch { /* document 兜底 */ }
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
    const card = event.target.closest?.(".plug-group[data-color]");
    // 只认侧栏自己那一层的卡片：卡片**内部**的插件按钮归段内拖动（pluginListDrag），
    // 组头的 ↑/↓ 与插件按钮一样是操作钮 —— 按下去不许起拖。
    if (!card || card.parentElement !== list) return;
    if (event.target.closest?.("button[data-plugin-id], .plug-group-move")) return;
    if (pd) cancel(pd);
    pd = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, scale: 1, active: false, began: false, dead: false, longTimer: null, frame: 0, swallowClick: null, docUp: null, docCancel: null };
    if (event.pointerType !== "mouse") pd.longTimer = setTimeout(() => { if (pd?.card === card && !pd.active) begin(pd); }, 240);
  });
  list.addEventListener("pointermove", (event) => {
    const st = pd;
    if (!st || event.pointerId !== st.pointerId) return;
    st.x = event.clientX; st.y = event.clientY;
    if (st.active) { event.preventDefault(); return; }
    if (st.dead) return;
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
    // 卡片里的插件按钮归段内拖动：它的 Alt+↑/↓ 在段容器上已经处理过（事件还会冒泡到
    // 这里），不拦住就会「按一次方向键，插件和整组一起换位」。
    if (event.target.closest?.("button[data-plugin-id]")) return;
    const card = event.target.closest?.(".plug-group[data-color]");
    if (!card || card.parentElement !== list) return;
    event.preventDefault();
    onMove?.(card, event.key === "ArrowDown" ? 1 : -1);
  });
}
