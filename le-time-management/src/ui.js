// 通用 UI 小件：toast、弹出菜单、dom 助手
import { removeWithMotion } from "./motion.js";
import { observeStack, refreshStack } from "./notifyStack.js";

/** 仅让卡片自身的 Enter/Space 触发激活，不抢内部原生控件或输入法的按键。 */
export function isSelfActivationKey(event) {
  return Boolean(event.currentTarget && event.target === event.currentTarget
    && !event.defaultPrevented && !event.isComposing
    && (event.key === "Enter" || event.key === " "));
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

/** 统一的新内容标签：三处视图只决定显不显示，外观和无障碍文案保持同源。 */
export function newBadge(visible = true) {
  return visible
    ? el("span", { class: "new-badge", title: "新添加", "aria-label": "新添加" }, "NEW")
    : null;
}

/**
 * 应用内横幅。
 * @param {object} opts
 *   action / actionLabel 带一个动作按钮（默认文案「撤销」）
 *   onClick / onClickHint 整卡可点：点一下（或键盘 Enter / Space）就跑 onClick 并收掉。
 *     用在「这件事只有一个去处」的横幅上（如插件下载完附件 → 定位到下载目录），
 *     比再加一颗按钮好：按钮会把一条长路径的正文挤窄。
 *   ms 停留时长；**0 = 常驻不自动消失**（长鸣那种必须用户明确处置的横幅），默认 4200
 *   class 额外类名（如 "alarm"）
 *   pin 钉住这条：不缩进堆叠里被别的横幅盖住。`ms: 0` 隐含 pin（常驻卡都带按钮，
 *   藏起来等于按钮消失）；要「常驻但允许被盖」才显式写 `pin: false`
 * @returns {{close:Function,node:HTMLElement}} 调用方可以提前收掉它；旧调用方忽略返回值即可。
 *   close 幂等：按钮自身与调用方都会收，重复调用不会把动效跑两遍。
 */
export function toast(msg, opts = {}) {
  const box = document.getElementById("toasts");
  const clickable = typeof opts.onClick === "function";
  const t = el("div", { class: `toast${opts.class ? ` ${opts.class}` : ""}${clickable ? " toast-clickable" : ""}` }, el("span", {}, msg));
  if (opts.pin !== undefined ? opts.pin : opts.ms === 0) t.setAttribute("data-pin", "");
  let removed = false;
  const close = () => {
    if (removed) return;
    removed = true;
    removeWithMotion(t);
  };
  if (opts.action) {
    t.append(el("button", { onclick: () => { opts.action(); close(); } }, opts.actionLabel || "撤销"));
  }
  if (clickable) {
    t.append(el("span", { class: "toast-hint" }, opts.onClickHint || "点击查看"));
    // 卡里已经有一颗真按钮时不再把整卡也标成按钮：嵌套的交互元素会让读屏器念两次，
    // 键盘也会多出一站。那种横幅点按钮就够，卡本身不是入口。
    if (!opts.action) {
      t.setAttribute("role", "button");
      t.setAttribute("tabindex", "0");
    }
    // 先跑回调再收卡：回调抛错也得把卡收掉（否则用户以为没点上，会一直点）。
    const fire = () => { try { opts.onClick(); } finally { close(); } };
    t.addEventListener("click", (e) => {
      // 点内部按钮（如「撤销」）走它自己的动作，不能顺带把 onClick 也跑一遍。
      if (opts.action && e.target?.closest?.("button")) return;
      fire();
    });
    t.addEventListener("keydown", (e) => {
      if (!isSelfActivationKey(e)) return;
      e.preventDefault();
      fire();
    });
  }
  box.classList.add("notify-stack");
  box.append(t);
  observeStack(box);
  refreshStack(box);
  let timer = null;
  if (opts.ms !== 0) timer = setTimeout(close, opts.ms || 4200);
  return { close: () => { if (timer) clearTimeout(timer); close(); }, node: t };
}

/* ── 应用内对话框：替代 window.prompt / window.confirm（Tauri 里原生弹窗样式突兀）── */
function appDialog({ title, message, label, value = "", placeholder = "", confirmText = "确定", cancelText = "取消", danger = false, input = false, timeoutMs = 0, timeoutNote = "不操作", dialogClass = "", focusMessage = false }) {
  return new Promise((resolve) => {
    let tick = null;
    let closed = false;
    const previousFocus = document.activeElement;
    const isTopDialog = () => [...document.querySelectorAll(".app-dialog-mask")].at(-1) === mask;
    const close = (result) => {
      if (closed) return;
      closed = true;
      const restoreFocus = isTopDialog();
      document.removeEventListener("keydown", onKey, true);
      if (tick) clearInterval(tick);
      mask.remove();
      if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (!isTopDialog()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(input ? null : false);
      } else if (e.key === "Tab") {
        const targets = [...box.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
          .filter((node) => !node.disabled && node.getClientRects().length);
        const first = targets[0], last = targets.at(-1);
        if (!first) return;
        if (!box.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    const field = input
      ? el("input", { class: "app-dialog-field", type: "text", value, placeholder, "aria-label": label || title })
      : null;
    // 倒计时到点一律按「取消」处理：这类对话框存在的意义是「有人点头才算数」，
    // 没人看就等于没人点，绝不能因为它挂着就让人觉得还是活的。
    const countdown = timeoutMs > 0
      ? el("p", { class: "app-dialog-countdown" })
      : null;
    const submit = () => close(input ? field.value.trim() : true);
    const box = el("div", { class: `app-dialog${dialogClass ? ` ${dialogClass}` : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
      el("h3", {}, title),
      message ? (message.nodeType ? message : el("p", { class: "app-dialog-msg" }, message)) : null,
      countdown,
      field,
      el("div", { class: "app-dialog-actions" },
        el("button", { class: "app-dialog-btn", type: "button", onclick: () => close(input ? null : false) }, cancelText),
        el("button", { class: `app-dialog-btn pri${danger ? " danger" : ""}`, type: "button", onclick: submit }, confirmText),
      ),
    );
    const mask = el("div", { class: "drawer-mask app-dialog-mask" }, box);
    mask.addEventListener("click", (e) => { if (e.target === mask) close(input ? null : false); });
    if (field) {
      field.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") submit();
      });
    }
    document.addEventListener("keydown", onKey, true);
    document.body.append(mask);
    if (countdown) {
      const until = Date.now() + timeoutMs;
      const paint = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) { close(input ? null : false); return; }
        countdown.textContent = `${timeoutNote} ${left} 秒后自动取消`;
      };
      paint();
      tick = setInterval(paint, 1000);
    }
    if (field) { field.focus(); field.select(); }
    else if (focusMessage && message?.focus) message.focus();
    else box.querySelector(".app-dialog-btn.pri")?.focus();
  });
}

/** 应用内输入对话框：确认返回输入值（已 trim），取消/Esc 返回 null */
export function appPrompt(title, opts = {}) {
  return appDialog({ title, input: true, ...opts });
}

/** 应用内确认对话框：确认返回 true，取消/Esc 返回 false */
export function appConfirm(title, message, opts = {}) {
  return appDialog({ title, message, ...opts });
}

/**
 * 底部系统栏（三键导航栏 / 手势条）的真实高度，单位 px。
 * Android 由 MainActivity 注入 `--sab`（WebView 不实现 env(safe-area-inset-*)），
 * 桌面 / iOS 取不到该变量，返回 0 —— 行为与以前一致。
 * JS 定位的浮层（popmenu / 右键菜单 / quick-dock）贴底钳制必须减掉它，
 * 否则 8~20px 的 margin 挡不住 ~48dp 的三键导航栏（v0.58.2）。
 */
export function bottomInsetPx() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sab"));
  return Number.isFinite(v) ? v : 0;
}

export function popmenu(x, y, items) {
  document.querySelectorAll(".popmenu").forEach((m) => m.remove());
  const menu = el("div", { class: "popmenu" });
  for (const it of items) {
    if (it === "-") { menu.append(el("div", { class: "sep" })); continue; }
    menu.append(el("button", { class: it.warn ? "warn" : "", onclick: () => { close(); it.run(); } },
      it.icon ? el("span", {}, it.icon) : null, it.label));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 10)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 10 - bottomInsetPx())}px`;
  const close = () => { removeWithMotion(menu); document.removeEventListener("pointerdown", onDoc, true); };
  const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener("pointerdown", onDoc, true));
  return close;
}

// 指针拖拽（鼠标 + 触摸通用，Android 可用）
// onDrop({x, y, payload, targetAt}) 由调用方决定放置逻辑
export function pointerDrag(e, payload, { ghostHTML, onMove, onDrop, onClick, onCancel }) {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let ghost = null, moved = false;
  let lastEv = null, raf = 0;
  const pid = e.pointerId;

  const onUp = (ev) => {
    if (ev.pointerId !== pid) return;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    if (raf) cancelAnimationFrame(raf);
    if (ghost) ghost.remove();
    if (ev.type === "pointercancel") { onCancel?.({ payload }); return; }
    if (moved) onDrop && onDrop({ x: ev.clientX, y: ev.clientY, payload });
    else onClick && onClick(ev);
  };
  const paintMove = () => {
    raf = 0;
    if (!lastEv) return;
    if (ghost) {
      ghost.style.transform = `translate3d(${lastEv.clientX}px, ${lastEv.clientY}px, 0) translate(-50%, -50%) rotate(1deg)`;
    }
    onMove && onMove(lastEv);
  };
  const move = (ev) => {
    if (ev.pointerId !== pid) return;
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
    moved = true;
    if (!ghost) {
      ghost = el("div", { class: "drag-ghost" });
      if (ghostHTML) ghost.append(ghostHTML);
      document.body.append(ghost);
    }
    lastEv = ev;
    if (!raf) raf = requestAnimationFrame(paintMove);
    ev.preventDefault();
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

export const QUADS = [
  { q: 1, cls: "q1", title: "重要且紧急 · 立即做", tip: "截止压顶，别再犹豫", rn: "I" },
  { q: 2, cls: "q2", title: "重要不紧急 · 排计划", tip: "人生的复利都在这里", rn: "II" },
  { q: 3, cls: "q3", title: "紧急不重要 · 少快办", tip: "能批量就批量，能拒绝就拒绝", rn: "III" },
  { q: 4, cls: "q4", title: "不重要不紧急 · 有空再说", tip: "留给真正的休息", rn: "IV" },
];
