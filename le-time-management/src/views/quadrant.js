// 四象限视图 —— 概念稿 03「权衡」
import * as S from "../store.js";
import { el, newBadge, QUADS, popmenu, toast } from "../ui.js";
import { taskActions } from "../pluginHost.js";
import { pluginDisplayName, pluginDisplayIcon } from "../pluginAppearance.js";
import { openTaskDrawer } from "./drawer.js";
import { reducedMotion } from "../motion.js";
import { getKeywordHighlights, highlightedText } from "../keywordHighlights.js";
import { getTaskPreferences } from "../taskPreferences.js";
import { createKeyedNodes } from "../keyedNodes.js";
import { withSearchGlyph } from "../searchField.js";

// 展开状态跨重渲染保持
const expandedCards = new Set();

function taskCard(t) {
  const state = S.getState();
  const scheduled = state.blocks.find((b) => b.taskId === t.id);
  const highlightCfg = getKeywordHighlights(state.settings);
  const hasNote = !!(t.note && t.note.trim());
  // 标题现在一律换行完整显示（卡片随内容变高），不再截断，
  // 所以「可展开」只服务于备注/原始消息，不再由标题长度触发。
  const expandable = hasNote;
  const card = el("button", { class: `tkc${t.done ? " done" : ""}${expandedCards.has(t.id) ? " expanded" : ""}`, "data-id": t.id },
    el("span", {
      class: "cb",
      onclick: (e) => { e.stopPropagation(); S.toggleTask(t.id); },
    }, t.done ? "✓" : ""),
    el("span", { class: "tt" },
      // 标题行：标题 + 展开箭头同处一行，标题换行时卡片自动变高，不再截断
      el("span", { class: "tt-top" },
        // 插件联动提醒：任务由插件创建时，标题前显示来源插件图标（悬停看插件名）
        t.sourcePlugin ? el("span", { class: "src-ic", title: `来自插件「${pluginDisplayName(t.sourcePlugin)}」的提醒` },
          pluginDisplayIcon(t.sourcePlugin, pluginDisplayName(t.sourcePlugin))) : null,
        (() => {
          const titleSpan = el("span", { class: "t", title: t.title }, highlightedText(t.title, highlightCfg), newBadge(t.isNew === true));
          if (expandable) {
            // 点标题就地展开/收起备注，不打开抽屉
            titleSpan.addEventListener("click", (e) => {
              e.stopPropagation();
              if (expandedCards.has(t.id)) expandedCards.delete(t.id);
              else expandedCards.add(t.id);
              card.classList.toggle("expanded", expandedCards.has(t.id));
            });
          }
          return titleSpan;
        })(),
        expandable ? el("span", { class: "exp" }, "⌄") : null,
      ),
      hasNote ? el("span", { class: "tn" }, highlightedText(t.note, highlightCfg)) : null,
      el("span", { class: "m" },
        highlightedText(t.due ? `截止 ${t.due.slice(5).replace("-", "/")} ${t.dueTime || "23:59"}` : "无截止", highlightCfg),
        t.project ? highlightedText(` · ${t.project}`, highlightCfg) : "",
        t.attachments?.length ? " · 📷" : ""),
    ),
    scheduled ? el("span", { class: "sch" }, highlightedText(`已排 ${scheduled.start}`, highlightCfg)) : null,
    el("span", { class: "est" }, S.durLabel(t.estMin)),
  );
  card.addEventListener("click", () => {
    // 横滑结束后浏览器仍会补发 click；此时只收尾手势，不打开详情抽屉。
    if (document.body.dataset.cardSwipe === "1") return;
    openTaskDrawer(t.id);
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (document.body.dataset.dragReorder === "1" || document.body.dataset.cardSwipe === "1") return;
    popmenu(e.clientX, e.clientY, [
      { label: "打开详情", icon: "▸", run: () => openTaskDrawer(t.id) },
      { label: t.done ? "标记为未完成" : "标记完成", icon: "✓", run: () => S.toggleTask(t.id) },
      "-",
      { label: "删除任务", icon: "✕", warn: true, run: () => {
        const undo = S.deleteTaskUndoable(t.id);
        toast(`已删除「${t.title}」`, { actionLabel: "撤销", action: undo });
      } },
    ]);
  });
  return card;
}

/* ── 任务卡横滑曲线删除 ───────────────────────────────────────────────────────
 * 横向位移与纵向拖拽排序仲裁：横移占优进入删除预览，纵移占优继续交给 attachListDrag；
 * 松手未过阈值就从当前变换平滑归位，过阈值则沿二次弧线飞向当前象限的回收区。
 * 数据删除严格发生在 exit animation.finished 之后，所以动画途中任务仍真实存在、可取消。
 */
function attachCardSwipeDelete(list, trash) {
  let session = null;
  const THRESHOLD_MIN = 92;
  const clearBodyState = () => setTimeout(() => {
    if (!session?.active) {
      delete document.body.dataset.cardSwipe;
      delete document.body.dataset.swipeSuspended;
    }
  }, 80);
  const detachDocument = (st) => {
    document.removeEventListener("pointerup", st.docUp, true);
    document.removeEventListener("pointercancel", st.docCancel, true);
  };
  const resetTrash = () => {
    trash.classList.remove("show", "armed", "left");
    trash.querySelector("span").textContent = "滑到这里删除";
  };
  const resetCard = (card) => {
    card.classList.remove("swipe-active", "swipe-deleting");
    card.style.removeProperty("transform");
    card.style.removeProperty("opacity");
  };
  const animateAndWait = async (node, keyframes, options) => {
    if (typeof node.animate !== "function") {
      await new Promise((resolve) => setTimeout(resolve, options.duration || 0));
      return;
    }
    const animation = node.animate(keyframes, options);
    try { await animation.finished; } catch { /* 被外部刷新取消时静默收尾 */ }
  };
  const returnHome = async (st) => {
    const { card, dx } = st;
    st.active = false;
    await animateAndWait(card, [
      { transform: card.style.transform || `translateX(${dx}px)`, opacity: card.style.opacity || "1" },
      { transform: "translateX(0) rotate(0deg) scale(1)", opacity: 1 },
    ], { duration: reducedMotion() ? 80 : 260, easing: "cubic-bezier(.2,.9,.25,1)" });
    resetCard(card); resetTrash(); clearBodyState();
  };
  const deleteAlongCurve = async (st) => {
    const { card, dx } = st;
    st.active = false;
    card.classList.add("swipe-deleting");
    trash.classList.add("armed");
    const from = card.getBoundingClientRect();
    const to = trash.getBoundingClientRect();
    // from 已含当前 translateX；终点变换却仍以卡片原位为坐标系，需先扣回 dx。
    const tx = to.left + to.width / 2 - (from.left + from.width / 2 - dx);
    const ty = to.top + to.height / 2 - (from.top + from.height / 2);
    const turn = tx < 0 ? -1 : 1;
    const arc = Math.min(110, Math.max(52, Math.abs(tx) * .18 + Math.abs(ty) * .12));
    if (reducedMotion()) {
      await animateAndWait(card, [
        { opacity: Number(card.style.opacity || 1), transform: card.style.transform || "none" },
        { opacity: 0, transform: "scale(.96)" },
      ], { duration: 100, easing: "ease-out", fill: "forwards" });
    } else {
      await animateAndWait(card, [
        { offset: 0, transform: card.style.transform || `translateX(${dx}px)`, opacity: Number(card.style.opacity || 1) },
        { offset: .34, transform: `translate(${dx + (tx - dx) * .34}px, ${ty * .14 - arc}px) rotate(${turn * 7}deg) scale(.82)`, opacity: .82 },
        { offset: .7, transform: `translate(${dx + (tx - dx) * .72}px, ${ty * .58 - arc * .48}px) rotate(${turn * 13}deg) scale(.48)`, opacity: .42 },
        { offset: 1, transform: `translate(${tx}px, ${ty}px) rotate(${turn * 19}deg) scale(.12)`, opacity: 0 },
      ], { duration: 440, easing: "cubic-bezier(.3,.05,.55,1)", fill: "forwards" });
    }
    // 必须等飞出结束后才碰数据源；这句会触发列表重绘并真正移除卡片。
    const task = S.taskById(st.id);
    const undo = S.deleteTaskUndoable(st.id);
    resetTrash(); clearBodyState();
    if (task && undo) toast(`已删除「${task.title}」`, { actionLabel: "撤销", action: undo });
  };
  const finish = (st, cancelled = false) => {
    if (session !== st) return;
    detachDocument(st);
    session = null;
    try { st.card.releasePointerCapture(st.pointerId); } catch { /* document 兜底 */ }
    if (!st.active) { resetCard(st.card); resetTrash(); return; }
    if (cancelled || !st.armed) returnHome(st);
    else deleteAlongCurve(st);
  };
  const activate = (st) => {
    st.active = true;
    document.body.dataset.cardSwipe = "1";
    document.body.dataset.swipeSuspended = "1";
    st.card.classList.add("swipe-active");
    trash.classList.add("show");
    try { st.card.setPointerCapture(st.pointerId); } catch { /* document 兜底 */ }
    st.docUp = (event) => { if (event.pointerId === st.pointerId) finish(st); };
    st.docCancel = (event) => { if (event.pointerId === st.pointerId) finish(st, true); };
    document.addEventListener("pointerup", st.docUp, true);
    document.addEventListener("pointercancel", st.docCancel, true);
  };
  const paint = (st) => {
    const limit = Math.max(THRESHOLD_MIN, Math.min(150, st.card.offsetWidth * .38));
    const progress = Math.min(1, Math.abs(st.dx) / limit);
    st.armed = progress >= 1;
    const rotation = Math.max(-5, Math.min(5, st.dx / 24));
    const scale = 1 - progress * .045;
    st.card.style.transform = `translateX(${st.dx}px) rotate(${rotation}deg) scale(${scale})`;
    st.card.style.opacity = String(1 - progress * .18);
    trash.classList.toggle("left", st.dx < 0);
    trash.classList.toggle("armed", st.armed);
    trash.querySelector("span").textContent = st.armed ? "松开删除" : "滑到这里删除";
    if (st.armed !== st.wasArmed) { if (st.armed) navigator.vibrate?.(12); st.wasArmed = st.armed; }
  };

  list.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (document.body.dataset.cardSwipe === "1") return;
    const card = event.target.closest?.(".tkc");
    if (!card || !list.contains(card) || card.classList.contains("dragging")) return;
    session = { id: card.dataset.id, card, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false, armed: false, wasArmed: false, docUp: null, docCancel: null };
  });
  list.addEventListener("pointermove", (event) => {
    const st = session;
    if (!st || event.pointerId !== st.pointerId) return;
    st.dx = event.clientX - st.x;
    const dy = event.clientY - st.y;
    if (!st.active) {
      if (Math.hypot(st.dx, dy) < 7) return;
      if (Math.abs(st.dx) <= Math.abs(dy) * 1.15) { session = null; return; }
      activate(st);
    }
    event.preventDefault();
    paint(st);
  });
  list.addEventListener("pointerup", (event) => { if (session && event.pointerId === session.pointerId) finish(session); });
  list.addEventListener("pointercancel", (event) => { if (session && event.pointerId === session.pointerId) finish(session, true); });
  list.addEventListener("touchmove", (event) => { if (session?.active) event.preventDefault(); }, { passive: false });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const card = event.target.closest?.(".tkc");
    if (!card || event.altKey || event.ctrlKey || event.metaKey || document.body.dataset.cardSwipe === "1") return;
    event.preventDefault();
    const st = { id: card.dataset.id, card, dx: 0, active: true, armed: true };
    document.body.dataset.cardSwipe = "1";
    document.body.dataset.swipeSuspended = "1";
    card.classList.add("swipe-active"); trash.classList.add("show", "armed");
    trash.querySelector("span").textContent = "正在删除";
    deleteAlongCurve(st);
  });

  return { cancel: () => {
    const st = session; session = null;
    if (!st) return;
    detachDocument(st); resetCard(st.card); resetTrash(); clearBodyState();
  } };
}

/* ── 四象限卡片拖拽排序 / 跨象限移动 ──
 * 桌面：按住卡片移动 ≥6px 即进入拖拽；触屏：长按 240ms 进入（期间移动 >8px 视为滚动意图）。
 * 拖动中幽灵卡（drag-ghost）跟随指针，其余卡片用 WAAPI FLIP 平滑让位；松手把顺序写回
 * store（moveTaskRelative 懒回填 order），新卡从幽灵落点平滑接位。
 * 手势会话期间置 document.body.dataset.swipeSuspended = "1"，shell 的滑动返回让路
 * （touchend 检查），清除延迟 80ms 覆盖到 touchend 之后（pointerup 先于 touchend 发出）。
 */
function attachListDrag(list) {
  let pd = null; // 当前按下会话
  const clearLong = (st) => { if (st.longTimer) { clearTimeout(st.longTimer); st.longTimer = null; } };
  const visibleCards = () => [...list.querySelectorAll(".tkc:not(.dragging)")];

  const clearDropTarget = (st) => {
    st.dropCell?.classList.remove("quad-drop-target");
    st.dropCell = null;
    st.targetQuad = st.sourceQuad;
    st.targetOverId = null;
  };

  const updateDropTarget = (st, x, y) => {
    const cell = document.elementFromPoint(x, y)?.closest?.(".q[data-quad]");
    const quad = Number(cell?.dataset.quad);
    st.dropCell?.classList.remove("quad-drop-target");
    st.dropCell = null;
    st.targetQuad = st.sourceQuad;
    st.targetOverId = null;
    if (!cell || !Number.isInteger(quad) || quad === st.sourceQuad) return;
    st.dropCell = cell;
    st.targetQuad = quad;
    cell.classList.add("quad-drop-target");
    const dragDone = st.card.classList.contains("done");
    const candidates = [...cell.querySelectorAll(".tks > .tkc")]
      .filter((card) => card.classList.contains("done") === dragDone);
    st.targetOverId = candidates.find((card) => y < card.getBoundingClientRect().top + card.offsetHeight / 2)?.dataset.id || null;
  };

  // document 捕获阶段兜底：setPointerCapture 失败（或环境不支持）时，指针在列表区域外
  // 松手的 pointerup/pointercancel 不会冒泡回 list，会话会挂起（幽灵卡不消失、顺序不落库）。
  // endDrag / cancel 自身幂等，与 list 级监听双触发无害。
  const detachDoc = (st) => {
    if (st.docUp) document.removeEventListener("pointerup", st.docUp, true);
    if (st.docCancel) document.removeEventListener("pointercancel", st.docCancel, true);
    st.docUp = st.docCancel = null;
  };

  const moveGhost = (st, x, y) => {
    st.ghost?.style.setProperty("transform", `translate(${x - st.gx}px, ${y - st.gy}px) scale(1.03)`);
  };

  const endSession = (st) => {
    clearLong(st);
    detachDoc(st);
    delete document.body.dataset.dragReorder;
    // swipeSuspended 要活过 touchend（swipe 返回在 touchend 判定，而 pointerup 先发），延迟清
    setTimeout(() => { if (!pd?.active && document.body.dataset.cardSwipe !== "1") delete document.body.dataset.swipeSuspended; }, 80);
    st.ghost?.remove();
    st.ghost = null;
    st.card?.classList.remove("dragging");
    list.classList.remove("drag-live");
    clearDropTarget(st);
    if (st.pointerId != null && st.card) { try { st.card.releasePointerCapture(st.pointerId); } catch { /* 已释放 */ } }
    if (pd === st) pd = null;
  };

  const cancel = () => {
    const st = pd;
    if (!st) return;
    if (st.active) for (const c of st.originOrder || []) list.append(c); // DOM 已被重排 → 按启动时顺序复原
    st.active = false;
    endSession(st);
  };

  const computeSlot = (st, y) => {
    // 插入槽判定用几何推演（offsetHeight + rowGap 递推），不读 getBoundingClientRect：
    // FLIP 让位动画进行中 rect 含残余 transform，会把槽位判定污染到动画中间态（实测探针抓到）
    const all = [...list.children].filter((c) => c.classList.contains("tkc"));
    let acc = list.getBoundingClientRect().top;
    const mids = all.map((c) => {
      const m = acc + (st.h[c.dataset.id] || c.offsetHeight) / 2;
      acc += (st.h[c.dataset.id] || c.offsetHeight) + st.gap;
      return m;
    });
    const vis = all.filter((c) => c !== st.card);
    let k = vis.length;
    for (let i = 0; i < all.length; i++) {
      if (all[i] === st.card) continue;
      if (y < mids[i]) { k = vis.indexOf(all[i]); break; }
    }
    // 完成的卡片永远沉底：插入槽夹在「与拖拽卡同完成态」的连续区间内
    const dragDone = st.card.classList.contains("done");
    const dones = vis.map((c) => c.classList.contains("done"));
    const first = dones.indexOf(dragDone);
    if (first >= 0) {
      let last = first;
      while (last + 1 < dones.length && dones[last + 1] === dragDone) last++;
      k = Math.min(Math.max(k, first), last + 1);
    }
    return k;
  };

  const reorderDOM = (st, k) => {
    const cards = visibleCards();
    const before = cards.map((c) => c.getBoundingClientRect());
    list.insertBefore(st.card, cards[k] ?? null);
    if (reducedMotion()) return;
    cards.forEach((c, i) => {
      const dy = before[i].top - c.getBoundingClientRect().top;
      if (dy) c.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: 180, easing: "cubic-bezier(.22,.8,.22,1)" });
    });
  };

  const beginDrag = (st, x, y) => {
    if (!list.contains(st.card) || st.card.classList.contains("dragging")) { if (pd === st) pd = null; return; }
    st.active = true;
    clearLong(st);
    document.body.dataset.swipeSuspended = "1"; // 滑动返回让路（shell touchend 检查）
    document.body.dataset.dragReorder = "1";    // 卡片 contextmenu 让路
    navigator.vibrate?.(10);                    // 触屏进入拖拽的触觉反馈（不支持则静默）
    const rect = st.card.getBoundingClientRect();
    st.gx = x - rect.left; st.gy = y - rect.top;
    if (!reducedMotion()) {
      const ghost = st.card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.width = `${rect.width}px`;
      document.body.append(ghost);
      st.ghost = ghost;
      moveGhost(st, x, y);
    }
    st.originOrder = [...list.querySelectorAll(".tkc")];
    // 槽位推演用的高度表：offsetHeight 不含 transform，拖拽中卡片高度不变
    st.gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    st.h = {};
    for (const c of list.querySelectorAll(".tkc")) st.h[c.dataset.id] = c.offsetHeight;
    st.card.classList.add("dragging");
    list.classList.add("drag-live");
    try { st.card.setPointerCapture(st.pointerId); } catch { /* 部分环境拿不到 capture，下面有 document 兜底 */ }
    st.docUp = (e) => {
      if (e.pointerId !== st.pointerId) return;
      detachDoc(st);
      if (st.active) endDrag(st); else endSession(st);
    };
    st.docCancel = (e) => {
      if (e.pointerId !== st.pointerId) return;
      detachDoc(st);
      cancel();
    };
    document.addEventListener("pointerup", st.docUp, true);
    document.addEventListener("pointercancel", st.docCancel, true);
    st.slot = computeSlot(st, y);
    reorderDOM(st, st.slot);
  };

  const endDrag = (st) => {
    if (!st.active) return;
    st.active = false;
    const ghostRect = st.ghost?.getBoundingClientRect() ?? null;
    const dragId = st.id;
    const targetQuad = st.targetQuad;
    const targetOverId = st.targetOverId;
    if (targetQuad !== st.sourceQuad) {
      endSession(st);
      S.moveTaskToQuad(dragId, targetQuad, targetOverId, true);
      const newCard = document.querySelector(`.q[data-quad="${targetQuad}"] .tkc[data-id="${dragId}"]`);
      if (newCard && ghostRect && !reducedMotion()) {
        const r1 = newCard.getBoundingClientRect();
        newCard.animate([
          { transform: `translate(${ghostRect.left - r1.left}px, ${ghostRect.top - r1.top}px) scale(1.03)` },
          { transform: "none" },
        ], { duration: 220, easing: "cubic-bezier(.22,.8,.22,1)" });
      }
      const title = QUADS.find((q) => q.q === targetQuad)?.title || `象限 ${targetQuad}`;
      toast(`已移到「${title}」`);
      return;
    }
    // 当前 DOM 序就是用户拖出的序 → 翻译成「相邻卡」写回 store
    const kids = [...list.children];
    const at = kids.indexOf(st.card);
    const next = kids[at + 1], prev = kids[at - 1];
    st.card.classList.remove("dragging");
    list.classList.remove("drag-live");
    if (next && next !== st.card) S.moveTaskRelative(dragId, next.dataset.id, true);
    else if (prev && prev !== st.card) S.moveTaskRelative(dragId, prev.dataset.id, false);
    // moveTaskRelative → changed() → 订阅同步 renderList 重建；新卡从幽灵落点平滑接位
    const newCard = list.querySelector(`.tkc[data-id="${dragId}"]`);
    if (newCard && ghostRect && !reducedMotion()) {
      const r1 = newCard.getBoundingClientRect();
      newCard.animate([
        { transform: `translate(${ghostRect.left - r1.left}px, ${ghostRect.top - r1.top}px) scale(1.03)` },
        { transform: "none" },
      ], { duration: 200, easing: "cubic-bezier(.22,.8,.22,1)" });
    }
    endSession(st);
  };

  list.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const card = e.target.closest?.(".tkc");
    if (!card || !list.contains(card)) return;
    const sourceQuad = Number(list.closest(".q")?.dataset.quad);
    pd = { id: card.dataset.id, card, pointerId: e.pointerId, x: e.clientX, y: e.clientY, active: false, ghost: null, slot: -1, originOrder: null, longTimer: null, sourceQuad, targetQuad: sourceQuad, targetOverId: null, dropCell: null };
    if (e.pointerType !== "mouse") {
      // 触屏：长按 240ms 进入拖拽；期间移动 >8px 视为滚动意图，取消长按
      pd.longTimer = setTimeout(() => { if (pd && pd.card === card && !pd.active) beginDrag(pd, pd.x, pd.y); }, 240);
    }
  });
  list.addEventListener("pointermove", (e) => {
    const st = pd;
    if (!st || e.pointerId !== st.pointerId) return;
    if (st.active) {
      if (st.ghost) moveGhost(st, e.clientX, e.clientY);
      updateDropTarget(st, e.clientX, e.clientY);
      if (st.targetQuad !== st.sourceQuad) return;
      const k = computeSlot(st, e.clientY);
      if (k !== st.slot) { st.slot = k; reorderDOM(st, k); }
      return;
    }
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (st.longTimer) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLong(st);
      return;
    }
    if (e.pointerType === "mouse" && Math.hypot(dx, dy) >= 6) {
      // 横向手势保留给曲线删除；纵向或斜向才进入排序拖拽。
      if (Math.abs(dx) > Math.abs(dy) * 1.15) return;
      beginDrag(st, e.clientX, e.clientY);
    }
  });
  list.addEventListener("pointerup", (e) => {
    const st = pd;
    if (!st || e.pointerId !== st.pointerId) return;
    if (st.active) endDrag(st); else endSession(st);
  });
  list.addEventListener("pointercancel", (e) => {
    const st = pd;
    if (!st || e.pointerId !== st.pointerId) return;
    cancel();
  });
  // 长按进入拖拽后浏览器可能仍尝试滚动（touch-action pan-y）→ 会话活跃时阻断
  list.addEventListener("touchmove", (e) => { if (pd?.active) e.preventDefault(); }, { passive: false });

  return { cancel };
}

function quadrantCell(def, matches) {
  const list = el("div", { class: "tks" });
  const trash = el("div", { class: "task-trash-target", "aria-hidden": "true" },
    el("span", {}, "滑到这里删除"),
    el("i", { "aria-hidden": "true" }, "×"),
  );
  const cell = el("div", { class: `q ${def.cls}`, "data-quad": def.q },
    el("span", { class: "rn" }, def.rn),
    el("div", { class: "qh" }, el("span", { class: "sq" }), el("b", {}, def.title),
      el("span", { class: "cnt" })),
    el("div", { class: "tip" }, def.tip),
    list, trash,
  );

  // 先注册横滑，再注册拖拽：同一次 pointermove 里横向手势能优先声明所有权。
  const swipeCtl = attachCardSwipeDelete(list, trash);
  const dragCtl = attachListDrag(list);

  const reconcileCards = createKeyedNodes(list);
  let lastSignature = "";
  const renderList = () => {
    const tasks = S.tasksOfQuad(def.q).filter(matches);
    const state = S.getState();
    const taskIds = new Set(tasks.map((task) => task.id));
    const blocks = state.blocks.filter((block) => taskIds.has(block.taskId));
    const appearance = JSON.stringify([getKeywordHighlights(state.settings), state.settings.pluginOverrides, getTaskPreferences(state.settings)]);
    const signature = JSON.stringify([tasks, blocks, appearance]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    swipeCtl.cancel();
    dragCtl.cancel(); // 手势会话中外部刷新（插件/订阅）→ 先复位再重建，防孤儿引用
    const scheduled = new Map();
    for (const block of blocks) if (!scheduled.has(block.taskId)) scheduled.set(block.taskId, block);
    reconcileCards(tasks.map((task) => ({ key: task.id,
      signature: JSON.stringify([task, scheduled.get(task.id), appearance]), create: () => taskCard(task) })));
    cell.querySelector(".cnt").textContent = `${tasks.filter((t) => !t.done).length} 项`;
  };
  renderList();
  cell._refresh = renderList;

  // Alt+↑/↓ 键盘重排（与拖拽同一条 store 路径；只在同完成态组内移动，到边界忽略）
  list.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const card = e.target.closest?.(".tkc");
    if (!card) return;
    const id = card.dataset.id;
    const seq = S.tasksOfQuad(def.q);
    const i = seq.findIndex((t) => t.id === id);
    if (i < 0) return;
    const dir = e.key === "ArrowUp" ? -1 : 1;
    let j = i + dir;
    while (j >= 0 && j < seq.length && seq[j].done !== seq[i].done) j += dir;
    if (j < 0 || j >= seq.length) return;
    S.moveTaskRelative(id, seq[j].id, dir < 0);
    // 订阅同步刷新后焦点回到被移动的卡片，支持连续按键
    list.querySelector(`.tkc[data-id="${id}"]`)?.focus();
    e.preventDefault();
  });

  // 快速添加
  const addBtn = el("button", { class: "addq" }, "添加到这个象限");
  const form = el("div", { class: "addform", style: "display:none" },
    Object.assign(el("input", { placeholder: "要做什么？回车保存", type: "text" }), {}),
    (() => {
      const s = el("select", { class: "estsel", title: "预估时长" });
      const duration = getTaskPreferences(S.getState().settings).defaultEstMin;
      for (const m of [...new Set([15, 30, 45, 60, 90, 120, duration])].sort((a, b) => a - b)) s.append(el("option", { value: m }, S.durLabel(m)));
      s.value = String(duration); return s;
    })(),
  );
  const input = form.querySelector("input");
  const estSel = form.querySelector("select");
  const submit = () => {
    const v = input.value.trim();
    if (v) S.addTask({ title: v, quad: def.q, estMin: Number(estSel.value) });
    input.value = ""; input.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) submit();
    if (e.key === "Escape") { form.style.display = "none"; addBtn.style.display = ""; }
  });
  addBtn.addEventListener("click", () => { addBtn.style.display = "none"; form.style.display = "flex"; input.focus(); });
  form.addEventListener("focusout", () => setTimeout(() => {
    if (!form.contains(document.activeElement) && !input.value.trim()) { form.style.display = "none"; addBtn.style.display = ""; }
  }, 120));
  form.append(el("button", { class: "btn pri sm", onclick: submit }, "保存"), el("button", { class: "btn ghost sm", onclick: () => { input.value = ""; form.style.display = "none"; addBtn.style.display = ""; } }, "取消"));
  cell.append(addBtn, form);
  cell._refresh = () => { renderList(); };
  return cell;
}

export function renderQuadrant(container) {
  let filter = "all", query = "";
  const matches = (t) => (filter === "all" || (filter === "done" ? t.done : !t.done)) &&
    [t.title, t.note, t.project, ...(t.tags || [])].join(" ").toLowerCase().includes(query);
  const cells = QUADS.map((q) => quadrantCell(q, matches));
  // v0.184.0：框内不再写中文占位词，只留一颗放大镜（见 src/searchField.js）。
  const search = el("input", { class: "task-search", placeholder: "", "aria-label": "搜索任务", oninput: (e) => { query = e.target.value.trim().toLowerCase(); cells.forEach(c => c._refresh()); } });
  const searchBox = withSearchGlyph(search);
  const grid = el("div", { class: "quad-grid" }, cells);

  let chipSignature = "";
  const refreshChips = () => {
    const all = S.getState().tasks;
    const open = all.filter((t) => !t.done);
    const signature = `${filter}:${all.length}:${open.length}`;
    if (signature === chipSignature) return;
    chipSignature = signature;
    chips.innerHTML = "";
    for (const [id, label, count] of [["all", "全部", all.length], ["open", "待办", open.length], ["done", "已完成", all.length - open.length]]) {
      chips.append(el("button", { class: "chip", "aria-pressed": String(filter === id), onclick: () => { filter = id; cells.forEach(c => c._refresh()); refreshChips(); } }, `${label} ${count} 项`));
    }
    const done = all.length - open.length;
    clearDoneBtn.disabled = done === 0;
    clearDoneBtn.textContent = done ? `清理已完成 ${done} 项` : "清理已完成";
  };
  const chips = el("div", {});

  // 一键清理已完成：与单条删除同一套「删了给撤销」语义，整批一次撤销（连同各自的排程）。
  const clearDoneBtn = el("button", {
    class: "chip clear-done",
    title: "删除全部已完成任务（连同它们已排入的时间块），删除后可在提示条撤销",
    onclick: () => {
      const done = S.getState().tasks.filter((t) => t.done);
      if (!done.length) return;
      const ids = new Set(done.map((t) => t.id));
      const blockCount = S.getState().blocks.filter((b) => ids.has(b.taskId)).length;
      const undo = S.deleteDoneTasksUndoable();
      toast(`已删除 ${done.length} 个已完成任务${blockCount ? `（含 ${blockCount} 个时间块）` : ""}`, { actionLabel: "撤销", action: undo });
    },
  }, "清理已完成");

  const wrap = el("div", { class: "quad-wrap" },
    el("div", { class: "quad-head" },
      el("span", { class: "motto" }, "把任务放进象限，就是做决定 · 象限 I 的面积最大，因为它值得你最多时间"),
      el("span", { class: "sp" }),
      chips,
      clearDoneBtn,
    ),
    searchBox, grid,
  );
  container.append(wrap);

  refreshChips();
  const un = S.subscribe(() => {
    cells.forEach((c) => c._refresh && c._refresh());
    refreshChips();
  });
  container._unsub = un;
}
