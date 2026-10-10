import {
  DEFAULT_UI_PREFERENCES,
  MARKET_CARD_SIZE_LIMITS,
  getUiPreferences,
  setUiPreferences,
} from "./uiPreferences.js";

/* ── 插件中心卡片尺寸（v0.181.0）──
   拖动任意一张卡片 = 调整**全部**卡片的大小：水平位移改网格列宽下限
   （--market-card-w），垂直位移改卡片最小高度（--market-card-h），两个值都落进
   uiPreferences，重启后保持。

   为什么不用拖拽把手：卡片本身没有可插把手的余地（整张卡是打开入口，右下角是启停滑块），
   所以直接用「在卡片上拖动」这一手势，并靠位移阈值把「点击打开」与「拖动改尺寸」分开。

   只在鼠标下介入：触屏上拖动与页面滚动同义，pointerType !== "mouse" 一律放行。 */

const DRAG_THRESHOLD = 4; // 小于这个位移算点击 —— 卡片点击是打开插件，不能被拖动抢走
const HINT_CLASS = "market-size-hint";
const RESIZING_CLASS = "market-resizing";

/** 纯换算：起始尺寸 + 指针位移 → 新尺寸（已 clamp 到合法区间，1px 位移 = 1px 变化）。 */
export function cardSizeFrom(startWidth, startHeight, dx, dy) {
  const L = MARKET_CARD_SIZE_LIMITS;
  return {
    width: Math.round(Math.min(L.maxWidth, Math.max(L.minWidth, startWidth + dx))),
    height: Math.round(Math.min(L.maxHeight, Math.max(L.minHeight, startHeight + dy))),
  };
}

/** 把尺寸写进 CSS 变量。拖动中每帧调用，不落盘（落盘在 pointerup）。 */
export function applyCardSizeVars(width, height, target = document.documentElement) {
  target.style.setProperty("--market-card-w", `${width}px`);
  target.style.setProperty("--market-card-h", `${height}px`);
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
    if (!st.active) return;
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
    const size = cardSizeFrom(st.startWidth, st.startHeight, clientX - st.startX, clientY - st.startY);
    st.width = size.width;
    st.height = size.height;
    applyCardSizeVars(size.width, size.height);
    showHint(size.width, size.height, clientX, clientY);
  }

  function onDown(event) {
    if (session) return;
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
    // 从这里起算才是 1:1 跟手（偏好里的高度 0 只表示「不设下限」）。
    const prefs = getUiPreferences();
    const rect = typeof card.getBoundingClientRect === "function" ? card.getBoundingClientRect() : null;
    const startWidth = Math.round(rect?.width || prefs.marketCardWidth || 180);
    const startHeight = Math.round(rect?.height || prefs.marketCardHeight || 100);
    session = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth,
      startHeight,
      prefsWidth: prefs.marketCardWidth,
      prefsHeight: prefs.marketCardHeight,
      width: startWidth,
      height: startHeight,
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
  function onMove(event) {
    const st = session;
    if (!st || event.pointerId !== st.pointerId) return;
    if (!st.active) {
      if (Math.hypot(event.clientX - st.startX, event.clientY - st.startY) < DRAG_THRESHOLD) return;
      st.active = true;
      grid.classList.add(RESIZING_CLASS);
      paint(st, event.clientX, event.clientY);
      return;
    }
    const x = event.clientX, y = event.clientY;
    if (st.frame !== null) return;
    st.frame = requestAnimationFrame(() => {
      st.frame = null;
      if (session === st && st.active) paint(st, x, y);
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
    grid.removeEventListener("pointerdown", onDown);
  };
}
