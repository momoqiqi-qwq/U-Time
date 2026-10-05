import { el, toast } from "./ui.js";
import { getUpdateState, describeUpdateState, subscribeUpdateState, isUpdaterSupported, checkForUpdates } from "./updateChecker.js";
import appPackage from "../package.json" with { type: "json" };
import { reducedMotion } from "./motion.js";

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  if (name === "arrow-up") {
    svg.setAttribute("viewBox", "0 0 32 32");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M14 2a2 2 0 0 1 4 0l12 14a2 2 0 0 1-1.5 3H22v11H10V19H3.5A2 2 0 0 1 2 16Z");
    svg.append(path);
    return svg;
  }
  if (name === "circle-check" || name === "party-horn") {
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("fill", "none");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", name === "circle-check"
      ? "M11 6A5 5 0 1 1 1 6A5 5 0 1 1 11 6M3.5 6l1.6 1.6L8.5 4"
      : "M1 11l2-7 5 5-7 2M4 3l1-2M8 4l3-1M9 7l2 1M6 1l1 1");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("fill", "none");
    svg.append(path);
    return svg;
  }
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons/fontawesome/solid.svg#${name}`);
  svg.append(use);
  return svg;
}

let opening = false;
export async function openUpdateHistory(currentVersion = "") {
  if (opening) return;
  opening = true;
  if (!/^\d+\.\d+\.\d+/.test(currentVersion)) currentVersion = appPackage.version;
  let unsubscribe = () => {};
  let cleanup = () => {};
  try {
    const { releaseHistory } = await import("./releaseHistory.js");
    const previousFocus = document.activeElement;
    const page = el("section", { class: "update-history-page", role: "dialog", "aria-modal": "true", "aria-label": "软件更新与更新历史" });
    const mask = el("div", { class: "update-history-mask", "data-motion": "off" }, page);
    cleanup = () => mask.remove();
    const content = el("div", { class: "update-history-content", tabindex: "0" });
    const status = el("button", { class: "update-history-status", type: "button", "aria-label": "检查更新",
      onclick: () => { if (isUpdaterSupported()) void checkForUpdates({ manual: true }); } });
    const badges = [];
    const scrollbars = [];
    const paint = () => {
      const state = getUpdateState();
      const busy = ["checking", "downloading", "installing"].includes(state.phase);
      const message = state.info?.has_update ? "发现可用更新" : state.phase === "idle" ? "查看更新历史" : describeUpdateState(state);
      status.replaceChildren(icon("bell"), el("span", {}, message), el("b", {}, `当前:v${currentVersion}`));
      status.disabled = busy || !isUpdaterSupported();
      for (const { release, badge } of badges) {
        const updating = release.version === state.info?.latest && ["downloading", "installing"].includes(state.phase);
        badge.textContent = !release.version ? "暂无更新" : updating ? "更新中…" : release.version === currentVersion ? "当前版本" : "历史版本";
      }
    };
    content.append(el("div", { class: "update-history-intro" },
      el("span", { class: "update-history-icon" }, icon("arrow-up")),
      el("div", {}, el("h2", {}, "软件更新"), el("p", {}, "获取最新功能与安全性改进"))), status);
    for (const preview of [false, true]) {
      const releases = releaseHistory.filter(release => release.preview === preview);
      const release = releases[0] || { version: "", preview };
      const list = el("div", { class: "update-history-note-list", tabindex: "0", "aria-label": preview ? "预发布版本更新记录" : "正式版本更新记录" });
      const notes = el("div", { class: "update-history-notes" }, list);
      const thumb = el("i");
      const track = el("div", { class: "update-history-scrollbar", "aria-hidden": "true" }, thumb);
      notes.append(track);
      const paintScrollbar = () => {
        const range = list.scrollHeight - list.clientHeight;
        track.hidden = range <= 0;
        if (range <= 0) return;
        const height = Math.min(track.clientHeight, Math.max(68, track.clientHeight * list.clientHeight / list.scrollHeight));
        thumb.style.height = `${height}px`;
        thumb.style.transform = `translateY(${(track.clientHeight - height) * list.scrollTop / range}px)`;
      };
      // 首屏仅建立 40 行；滚到末尾再添加一批，避免动画开始前构建数千个节点。
      const rows = releases.flatMap(entry => [`v${entry.version}`, ...entry.lines.map(line => line.text)]);
      let rendered = 0;
      let frame = null;
      const appendRows = () => {
        const fragment = document.createDocumentFragment();
        const end = Math.min(rendered + 40, rows.length);
        while (rendered < end) {
          fragment.append(el("p", {}, el("span", { class: "update-history-note-icon" }, icon(preview ? "party-horn" : "circle-check")),
            el("span", {}, `• ${rows[rendered++]}`)));
        }
        list.append(fragment);
      };
      appendRows();
      list.addEventListener("scroll", () => {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (list.scrollHeight - list.clientHeight - list.scrollTop < 180 && rendered < rows.length) appendRows();
          paintScrollbar();
        });
      }, { passive: true });
      scrollbars.push({ list, paintScrollbar, dispose: () => { if (frame !== null) cancelAnimationFrame(frame); } });
      if (!releases.length) list.append(el("p", { class: "update-history-empty" }, "暂未发布预发布版本"));
      const badge = el("span", { class: "update-history-current" });
      badges.push({ release, badge });
      content.append(el("section", { class: `update-history-card${release.preview ? " is-preview" : ""}` },
        el("header", {}, el("span", { class: "update-history-channel" }, release.preview ? "预发布版本" : "正式版本"),
          el("h3", {}, release.version ? `v${release.version}` : "暂无"), badge), notes));
    }
    unsubscribe = subscribeUpdateState(paint);
    page.append(content);
    const siblings = [...document.body.children].filter(node => node !== mask && node.id !== "toasts");
    const inertBefore = siblings.map(node => [node, node.inert]);
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    let didClose = false;
    let closing = false;
    const animations = [];
    const resizeObserver = new ResizeObserver(() => scrollbars.forEach(item => item.paintScrollbar()));
    const dispose = () => {
      if (didClose) return;
      didClose = true;
      document.removeEventListener("keydown", onKey, true);
      resizeObserver.disconnect();
      scrollbars.forEach(item => item.dispose());
      animations.forEach(animation => animation.cancel());
      mask.remove();
      for (const [node, inert] of inertBefore) node.inert = inert;
      if (previousFocus?.isConnected) previousFocus.focus();
      resolveClosed();
    };
    const close = () => {
      if (closing || didClose) return;
      closing = true;
      unsubscribe();
      mask.style.pointerEvents = "none";
      if (reducedMotion() || typeof page.animate !== "function") { dispose(); return; }
      // 捕获正在打开时的视觉状态，快速点击关闭也不会突然跳到最终大小。
      const style = getComputedStyle(page);
      const opacity = style.opacity, transform = style.transform;
      const maskOpacity = getComputedStyle(mask).opacity;
      animations.forEach(animation => animation.cancel());
      const exit = page.animate([{ opacity, transform }, { opacity: 0, transform: "translateY(10px) scale(.985)" }],
        { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
      const fade = mask.animate([{ opacity: maskOpacity }, { opacity: 0 }],
        { duration: 170, fill: "forwards" });
      animations.push(exit, fade);
      Promise.allSettled([exit.finished, fade.finished]).then(dispose);
    };
    const onKey = (event) => {
      if (document.querySelector(".app-dialog-mask") || closing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      else if (event.key === "Tab") {
        const targets = [...page.querySelectorAll('button, [tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
        const first = targets[0], last = targets.at(-1);
        if (!page.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    cleanup = dispose;
    page.append(el("button", { class: "update-history-close", "data-motion": "off", type: "button", title: "关闭更新历史", "aria-label": "关闭更新历史", onclick: close }, "×"));
    mask.addEventListener("click", event => { if (event.target === mask) close(); });
    document.body.append(mask);
    for (const { list, paintScrollbar } of scrollbars) { resizeObserver.observe(list); paintScrollbar(); }
    for (const [node] of inertBefore) node.inert = true;
    document.addEventListener("keydown", onKey, true);
    content.focus({ preventScroll: true });
    if (!reducedMotion() && typeof page.animate === "function") {
      animations.push(page.animate([{ opacity: 0, transform: "translateY(16px) scale(.97)" }, { opacity: 1, transform: "none" }],
        { duration: 260, easing: "cubic-bezier(.16,1,.3,1)" }));
      animations.push(mask.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: 220, easing: "ease-out" }));
    }
    await closed;
  } catch (error) {
    toast(`无法打开更新历史：${error?.message || error}`);
  } finally { cleanup(); unsubscribe(); opening = false; }
}
