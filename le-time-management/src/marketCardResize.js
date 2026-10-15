import {
  DEFAULT_UI_PREFERENCES,
  MARKET_CARD_SIZE_LIMITS,
  getUiPreferences,
  setUiPreferences,
} from "./uiPreferences.js";
import { getUiScaleFactor } from "./uiScale.js";

/* ── 插件中心卡片尺寸（v0.181.0 / 跟手与光标 v0.214.3）──
   拖动任意一张卡片 = 调整**全部**卡片的大小：水平位移改网格列宽
   （--market-card-w），垂直位移改卡片高度（--market-card-h，0 = 随内容自适应），
   两个值都落进 uiPreferences，重启后保持。

   为什么不用拖拽把手：卡片本身没有可插把手的余地（整张卡是打开入口，右下角是启停滑块），
   所以直接用「在卡片上拖动」这一手势，并靠位移阈值把「点击打开」与「拖动改尺寸」分开。

   只在鼠标下介入：触屏上拖动与页面滚动同义，pointerType !== "mouse" 一律放行。

   v0.214.3 三条修正（用户实测反馈）：
   ① 指针形状：拖动中不再是 `grabbing`（那是「搬运」语义），改成随拖动方向实时变化的
      调整尺寸光标（ew / ns / nwse / nesw-resize），并挂在 <html> 上 —— 指针拖到卡片外也保持。
      光标按**整段拖动的尺寸变化**算（不是指针位移、也不是每帧增量）：中途换向不会闪，
      指针拖出卡片也仍是同一个箭头。
   ② 跟手：拖动中由 CSS 把轨道固定成拖动值、卡片高度也取拖动值（见 styles.css 的
      `.market-grid.market-resizing` 与 .mcard 的 height），卡片才真的 1:1 跟随鼠标、缩小时真的缩小。
      只改 `--market-card-w` 时它只是 minmax 的下限：列数不变则卡片宽度纹丝不动。
   ③ 落位动画：松手瞬间挂 `.market-settling`，让「拖动中的固定列宽」→「落位后的 1fr 列宽」
      过渡 200ms；高度取的是确定像素（拖动值原样保留），所以缩小时不会在松手那一帧弹回内容高度。
   位移除以界面缩放系数：`clientX` 与 `rect` 同为屏幕视觉 px，而 CSS 变量是布局 px。 */

const DRAG_THRESHOLD = 4; // 小于这个位移算点击 —— 卡片点击是打开插件，不能被拖动抢走
const HINT_CLASS = "market-size-hint";
const RESIZING_CLASS = "market-resizing";
const PAGE_CLASS = "market-resizing-page"; // 挂 <html>：拖动中整页统一成调整尺寸光标
const CURSOR_VAR = "--market-resize-cursor";
const SETTLING_CLASS = "market-settling"; // 松手后短暂挂上，给列宽落位加过渡（与 CSS 同值）
const SETTLE_MS = 240;

/** 纯换算：**实际尺寸变化** → 调整尺寸光标。
 *  两轴都变了 = 斜拉（同向 nwse、反向 nesw）；只剩一轴变 = 单轴光标（另一轴已顶到上下限）；
 *  都没变 = "default"（调用方保持上一个光标，不要突然跳成箭头）。 */
export function resizeCursor(dw, dh) {
  const useX = Math.abs(dw) >= 1, useY = Math.abs(dh) >= 1;
  if (useX && useY) return (dw > 0) === (dh > 0) ? "nwse-resize" : "nesw-resize";
  if (useX) return "ew-resize";
  if (useY) return "ns-resize";
  return "default";
}

/** 纯换算：起始尺寸 + 指针位移 → 新尺寸（已 clamp 到合法区间，1px 位移 = 1px 变化）。 */
export function cardSizeFrom(startWidth, startHeight, dx, dy) {
  const L = MARKET_CARD_SIZE_LIMITS;
  return {
    width: Math.round(Math.min(L.maxWidth, Math.max(L.minWidth, startWidth + dx))),
    height: Math.round(Math.min(L.maxHeight, Math.max(L.minHeight, startHeight + dy))),
  };
}

/** 把尺寸写进 CSS 变量。拖动中每帧调用，不落盘（落盘在 pointerup）。
 *  高度 0 = 随内容自适应 → 写 auto；写成 0px 会把卡片压成一条线（取消拖动时最容易踩到）。 */
export function applyCardSizeVars(width, height, target = document.documentElement) {
  target.style.setProperty("--market-card-w", `${width}px`);
  target.style.setProperty("--market-card-h", height > 0 ? `${height}px` : "auto");
}

/** 恢复默认尺寸并持久化（插件中心网格空白处双击触发）。 */
export function resetMarketCardSize() {
  return setUiPreferences({
    marketCardWidth: DEFAULT_UI_PREFERENCES.marketCardWidth,
    marketCardHeight: DEFAULT_UI_PREFERENCES.marketCardHeight,
  });
}

/**
 * 在插件中心网格上装「拖动卡片改尺寸」。
 * @param {HTMLElement} grid  插件中心的 .market-grid
 * @param {{ onCommit?: (size: object) => void, onCancel?: () => void }} hooks
 * @returns {() => void} 卸载函数
 */
export function attachMarketCardResize(grid, { onCommit, onCancel } = {}) {
  let session = null;
  let hint = null;
  let settleTimer = null;

  const stopSettling = () => {
    if (settleTimer === null) return;
    clearTimeout(settleTimer);
    settleTimer = null;
    grid.classList.remove(SETTLING_CLASS);
  };

  // 落位过渡：与「移除 .market-resizing」同一帧完成，浏览器才会按新样式（含过渡）算出
  // 前后两个尺寸并插值；晚一帧就只是一次跳变。
  const startSettling = () => {
    grid.classList.add(SETTLING_CLASS);
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      grid.classList.remove(SETTLING_CLASS);
    }, SETTLE_MS);
  };

  const showHint = (width, height, x, y) => {
    if (!hint) {
      hint = document.createElement("div");
      hint.className = HINT_CLASS;
      hint.setAttribute("aria-hidden", "true");
      document.body.append(hint);
    }
    hint.textContent = `宽 ${width} × 高 ${height}`;
    hint.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  };
  const hideHint = () => { hint?.remove(); hint = null; };

  const release = () => {
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onAbort, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onAbort);
  };

  const finish = (commit) => {
    const st = session;
    if (!st) return;
    session = null;
    if (st.frame !== null) cancelAnimationFrame(st.frame);
    release();
    hideHint();
    grid.classList.remove(RESIZING_CLASS);
    // 光标是全局态：无论落盘还是取消，都必须在这里收干净，否则整页指针会一直停在 resize。
    document.documentElement.classList.remove(PAGE_CLASS);
    document.documentElement.style.removeProperty(CURSOR_VAR);
    if (!st.active) return;
    startSettling();
    // pointerup 之后浏览器还会补发一次 click；拖动不能顺带打开插件。
    const swallow = (event) => { event.stopPropagation(); event.preventDefault(); };
    document.addEventListener("click", swallow, true);
    setTimeout(() => document.removeEventListener("click", swallow, true), 0);
    if (commit) {
      const next = setUiPreferences({ marketCardWidth: st.width, marketCardHeight: st.height });
      onCommit?.(next);
    } else {
      applyCardSizeVars(st.prefsWidth, st.prefsHeight);
      onCancel?.();
    }
  };

  function paint(st, clientX, clientY) {
    const dx = clientX - st.startX, dy = clientY - st.startY;
    const size = cardSizeFrom(st.startWidth, st.startHeight, dx / st.scale, dy / st.scale);
    st.width = size.width;
    st.height = size.height;
    applyCardSizeVars(size.width, size.height);
    showHint(size.width, size.height, clientX, clientY);
    // 光标看的是**卡片尺寸变了多少**（已 clamp），不是指针位移：只拖高度就是上下箭头、
    // 只拖宽度就是左右箭头、两轴都动就是对角箭头。
    // 按整段拖动的方向算（不是每帧增量）：中途换向不会让箭头闪来闪去。
    const cursor = resizeCursor(size.width - st.startWidth, size.height - st.startHeight);
    if (cursor !== "default" && cursor !== st.cursor) {
      st.cursor = cursor;
      document.documentElement.style.setProperty(CURSOR_VAR, cursor);
    }
  }

  function onDown(event) {
    if (session) return;
    // 落位过渡还没走完就又按下去：立刻收掉，否则这一次拖动的每帧都会被 200ms 过渡拖住。
    stopSettling();
    // 触屏拖动 = 滚动，不能抢；非左键（右键菜单）也不介入。
    if (event.pointerType && event.pointerType !== "mouse") return;
    if (event.button !== 0) return;
    const target = event.target;
    if (!target?.closest) return;
    // 滑块、⋯、以及未来任何控件都要保持自己的点击语义。
    if (target.closest("button, input, select, a, textarea")) return;
    const card = target.closest(".mcard");
    if (!card || !grid.contains(card)) return;
    // 起点取**卡片当前实际尺寸**，不是偏好值：宽是网格算出来的列宽、高是内容高度，
    // 从这里起算才是 1:1 跟手（偏好里的高度 0 只表示「随内容」）。
    // rect 是屏幕视觉 px、CSS 变量是布局 px ⇒ 先除以界面缩放系数，两者才同一坐标系。
    const scale = getUiScaleFactor() || 1;
    const prefs = getUiPreferences();
    const rect = typeof card.getBoundingClientRect === "function" ? card.getBoundingClientRect() : null;
    const startWidth = Math.round((rect?.width ? rect.width / scale : 0) || prefs.marketCardWidth || 180);
    const startHeight = Math.round((rect?.height ? rect.height / scale : 0) || prefs.marketCardHeight || 100);
    session = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth,
      startHeight,
      scale,
      prefsWidth: prefs.marketCardWidth,
      prefsHeight: prefs.marketCardHeight,
      width: startWidth,
      height: startHeight,
      cursor: "",
      active: false,
      frame: null,
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onAbort, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onAbort);
  }

  // 只在输入改变时申请一帧：同一帧的多次 pointermove 只按最后坐标重排一次。
  // ⚠️ 坐标必须存到会话上、由 rAF 回调去读，**不能**用这次调用的闭包变量 ——
  // 高刷鼠标（500~1000Hz）一帧能来好几条 pointermove，闭包版只会按**本帧第一条**画，
  // 卡片就永远差一帧跟着鼠标走（用户说的「不跟鼠标」有一半是这个）。
  function onMove(event) {
    const st = session;
    if (!st || event.pointerId !== st.pointerId) return;
    if (!st.active) {
      if (Math.hypot(event.clientX - st.startX, event.clientY - st.startY) < DRAG_THRESHOLD) return;
      st.active = true;
      grid.classList.add(RESIZING_CLASS);
      document.documentElement.classList.add(PAGE_CLASS);
      paint(st, event.clientX, event.clientY);
      return;
    }
    st.pendingX = event.clientX;
    st.pendingY = event.clientY;
    if (st.frame !== null) return;
    st.frame = requestAnimationFrame(() => {
      st.frame = null;
      if (session === st && st.active) paint(st, st.pendingX, st.pendingY);
    });
  }

  function onUp(event) {
    if (!session) return;
    if (event?.pointerId !== undefined && event.pointerId !== session.pointerId) return;
    finish(true);
  }

  function onAbort() { finish(false); }

  function onKey(event) {
    if (event.key !== "Escape") return;
    finish(false);
  }

  grid.addEventListener("pointerdown", onDown);
  return () => {
    finish(false);
    stopSettling();
    grid.removeEventListener("pointerdown", onDown);
  };
}
