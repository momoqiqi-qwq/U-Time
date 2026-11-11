(function () {
  "use strict";

  /* ═══════════════════ HTML 目录 ═══════════════════
     把一个本地文件夹里的 .html 铺成卡片，每张卡片里是**真的渲染出来的页面**。

     为什么不能直接 <iframe src="file:///…">：
     应用页面来源是 http://tauri.localhost，跨到 file: 属于被禁止的导航，WebView2 直接
     拒掉（白框 + 控制台一条 Not allowed to load local resource）。所以缩略图走原生起的
     127.0.0.1 静态服务（src-tauri/src/html_gallery.rs）：iframe 拿到普通 http 地址，
     页面里相对路径的 css / js / 图片全按原样工作 —— 这才是「首页内容图片」，
     而不是截图，也不是拿个图标糊上去。

     卡片的交互：
       · 拖右 / 下 / 右下三条边框改大小（鼠标移到边框上光标自动变成对应的调整箭头）
       · 尺寸按文件相对路径记住，下次进来还是你摆的样子
       · 没摆过的卡片跟着容器自适应（flex 铺满一行）
       · 点卡片 → 整页浮层里看（浮层里的 iframe 是可交互的，卡片里的只是画面）
  */

  const FRAME_W = 1280;   // iframe 的逻辑宽度：按桌面页面排版，再等比缩到卡片大小
  const FRAME_H = 900;
  const MIN_W = 190;
  const MIN_H = 96;
  const STORE = { folder: "folder", deep: "deep", sizes: "sizes" };

  const state = {
    folder: "",
    deep: false,
    sizes: {},          // { [rel]: {w, h} }
    items: [],
    base: "",           // 本地静态服务地址，如 http://127.0.0.1:53421
    busy: false,
    error: "",
  };

  let rootEl = null;
  let epoch = 0;
  let observer = null;   // IntersectionObserver：滚到附近才真的去加载 iframe
  let sizer = null;      // ResizeObserver：卡片尺寸一变就把 iframe 重新缩放
  let sheet = null;      // 整页预览浮层
  let picker = null;     // 选文件夹浮层

  /* ── 小工具 ─────────────────────────────────────────────────────────── */

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

  /** 相对路径 → 静态服务地址。逐段 encodeURIComponent：# ? 空格 中文都能过。 */
  function urlOf(rel) {
    if (!state.base || !rel) return "";
    return `${state.base}/${String(rel).split("/").map(encodeURIComponent).join("/")}`;
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtTime(ms) {
    const t = Number(ms) || 0;
    if (!t) return "";
    const d = new Date(t);
    const pad = (v) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 文件夹尾段当标题：路径太长时界面上只需要认识「这是哪个目录」。 */
  function tailOf(p) {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const cut = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return cut >= 0 ? s.slice(cut + 1) || s : s;
  }

  function ensureStyle() {
    if (document.getElementById("hg-style")) return;
    const st = document.createElement("style");
    st.id = "hg-style";
    st.textContent = `
      .hg-wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
      .hg-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .hg-path{flex:1 1 220px;min-width:0;display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;
        border:1px solid var(--line,#E4DFD6);border-radius:9px;background:var(--panel,#fff);
        font-size:calc(12px * var(--ui-text-scale,1));color:var(--ink,#22303A);overflow:hidden}
      .hg-path b{font-weight:600;flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .hg-path span{flex:1 1 auto;min-width:0;color:var(--ink-3,#A9B2BA);overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
      .hg-path.empty{color:var(--ink-2,#7E8B94)}
      .hg-btn{height:34px;padding:0 13px;border-radius:9px;border:1px solid var(--line,#E4DFD6);
        background:var(--panel,#fff);color:var(--ink,#22303A);font:inherit;
        font-size:calc(12px * var(--ui-text-scale,1));cursor:pointer;flex:none;transition:background .15s,border-color .15s}
      .hg-btn:hover{border-color:var(--sea,#118AB2)}
      .hg-btn.primary{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
      .hg-btn.primary:hover{background:var(--deep-2,#12333D);border-color:var(--deep-2,#12333D)}
      .hg-btn[disabled]{opacity:.5;cursor:default}
      .hg-check{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px;flex:none;
        font-size:calc(12px * var(--ui-text-scale,1));color:var(--ink-2,#7E8B94);cursor:pointer;
        border:1px solid transparent;border-radius:9px}
      .hg-check:hover{color:var(--ink,#22303A)}
      .hg-check input{width:14px;height:14px;accent-color:var(--deep,#0F4C5C);cursor:pointer}
      .hg-note{font-size:calc(11px * var(--ui-text-scale,1));color:var(--ink-2,#7E8B94);
        display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .hg-note .hg-warn{color:var(--danger,#B03535)}
      .hg-grid{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;padding-bottom:8px}
      .hg-card{position:relative;flex:1 1 268px;min-width:0;max-width:100%;
        border:1px solid var(--line,#E4DFD6);border-radius:12px;background:var(--panel,#fff);
        overflow:hidden;transition:border-color .15s,box-shadow .15s}
      .hg-card:hover{border-color:var(--sea,#118AB2);box-shadow:var(--shadow,0 1px 8px rgba(34,48,58,.065))}
      .hg-card.hg-custom{flex:0 0 auto}
      .hg-head{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid var(--line-soft,#EFEAE1);
        background:var(--paper,#F7F6F2)}
      .hg-title{flex:1 1 auto;min-width:0;font-size:calc(12px * var(--ui-text-scale,1));font-weight:600;
        color:var(--ink,#22303A);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .hg-sub{flex:none;max-width:45%;font-size:calc(10px * var(--ui-text-scale,1));color:var(--ink-3,#A9B2BA);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
      .hg-frame{position:relative;overflow:hidden;background:#fff;aspect-ratio:16/10;cursor:zoom-in}
      .hg-frame iframe{position:absolute;left:0;top:0;width:1280px;height:900px;border:0;
        transform-origin:top left;pointer-events:none;background:#fff}
      .hg-frame .hg-skel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        font-size:calc(11px * var(--ui-text-scale,1));color:var(--ink-3,#A9B2BA);background:#fff}
      /* 三条可拖边框。光标靠 cursor 自动变箭头，不需要额外提示。 */
      .hg-grip{position:absolute;z-index:3;touch-action:none}
      .hg-grip.e{top:0;right:0;width:9px;height:100%;cursor:ew-resize}
      .hg-grip.s{left:0;bottom:0;height:9px;width:100%;cursor:ns-resize}
      .hg-grip.se{right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize}
      .hg-grip:hover{background:var(--sea,#118AB2);opacity:.25}
      .hg-empty{flex:1 1 100%;display:flex;flex-direction:column;align-items:center;gap:10px;
        padding:44px 20px;border:1px dashed var(--line,#E4DFD6);border-radius:12px;background:var(--paper,#F7F6F2);
        text-align:center;color:var(--ink-2,#7E8B94);font-size:calc(12px * var(--ui-text-scale,1));line-height:1.8}
      .hg-empty b{font-size:calc(13px * var(--ui-text-scale,1));color:var(--ink,#22303A);font-weight:600}
      .hg-mask{position:fixed;inset:0;z-index:60;display:flex;background:rgba(20,28,34,.42);
        padding:calc(16px + var(--sat,env(safe-area-inset-top,0px))) calc(16px + var(--sar,env(safe-area-inset-right,0px))) calc(16px + var(--sab,env(safe-area-inset-bottom,0px))) calc(16px + var(--sal,env(safe-area-inset-left,0px)))}
      .hg-sheet{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--panel,#fff);
        border-radius:14px;box-shadow:var(--shadow-lg,0 10px 32px rgba(34,48,58,.16))}
      .hg-sheet-bar{display:flex;align-items:center;gap:10px;padding:9px 12px;
        border-bottom:1px solid var(--line-soft,#EFEAE1);background:var(--paper,#F7F6F2);flex:none}
      .hg-sheet-title{flex:1;min-width:0;font-size:calc(12px * var(--ui-text-scale,1));font-weight:600;
        color:var(--ink,#22303A);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .hg-sheet-frame{flex:1;min-height:0;width:100%;border:0;background:#fff}
      .hg-crumb{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:none;
        border-bottom:1px solid var(--line-soft,#EFEAE1)}
      .hg-crumb-path{flex:1;min-width:0;font-size:calc(11px * var(--ui-text-scale,1));color:var(--ink-2,#7E8B94);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
      .hg-roots{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px 4px;flex:none}
      .hg-root{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--line,#E4DFD6);
        background:var(--panel,#fff);color:var(--ink-2,#7E8B94);font:inherit;
        font-size:calc(11px * var(--ui-text-scale,1));cursor:pointer;flex:none}
      .hg-root:hover{border-color:var(--sea,#118AB2);color:var(--ink,#22303A)}
      .hg-dirs{flex:1;min-height:0;overflow:auto;padding:6px 8px 10px}
      .hg-dir{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;
        font-size:calc(12px * var(--ui-text-scale,1));color:var(--ink,#22303A)}
      .hg-dir:hover{background:var(--paper,#F7F6F2)}
      .hg-dir .hg-dir-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .hg-dir .hg-dir-n{flex:none;font-size:calc(10px * var(--ui-text-scale,1));color:var(--ink-3,#A9B2BA)}
      .hg-dir .hg-dir-n.hit{color:var(--sea,#118AB2)}
      .hg-picker-foot{display:flex;gap:8px;align-items:center;padding:10px 12px;flex:none;
        border-top:1px solid var(--line-soft,#EFEAE1);background:var(--paper,#F7F6F2)}
      .hg-picker-foot .hg-count{flex:1;min-width:0;font-size:calc(11px * var(--ui-text-scale,1));color:var(--ink-2,#7E8B94)}
    `;
    document.head.appendChild(st);
  }

  /* ── 数据：读 / 存 ───────────────────────────────────────────────────── */

  async function restore() {
    const [folder, deep, sizes] = await Promise.all([
      tide.storage.get(STORE.folder, ""),
      tide.storage.get(STORE.deep, false),
      tide.storage.get(STORE.sizes, {}),
    ]);
    state.folder = typeof folder === "string" ? folder : "";
    state.deep = deep === true;
    state.sizes = sizes && typeof sizes === "object" ? sizes : {};
  }

  function saveSizes() {
    tide.storage.set(STORE.sizes, state.sizes);
  }

  /* ── 扫描 ───────────────────────────────────────────────────────────── */

  async function loadFolder() {
    if (!state.folder) { state.items = []; state.base = ""; state.error = ""; return; }
    state.busy = true;
    state.error = "";
    try {
      const served = await tide.localHtml.serve(state.folder);
      state.base = String(served && served.base || "");
      const res = await tide.localHtml.scan(state.folder, state.deep ? 3 : 0);
      state.items = Array.isArray(res && res.items) ? res.items : [];
      if (res && res.truncated) state.error = "页面太多，只列出前 600 个。";
    } catch (e) {
      state.base = "";
      state.items = [];
      state.error = String((e && e.message) || e || "读不到这个文件夹");
    } finally {
      state.busy = false;
    }
  }

  /* ── 卡片 ───────────────────────────────────────────────────────────── */

  function cardHtml(item) {
    const rel = String(item.rel || "");
    const title = String(item.title || "").trim() || String(item.name || rel);
    const size = state.sizes[rel];
    const custom = size && size.w && size.h;
    const style = custom ? ` style="width:${Math.round(size.w)}px;height:auto"` : "";
    const frameStyle = custom ? ` style="height:${Math.round(size.h)}px"` : "";
    const meta = [fmtSize(item.size), fmtTime(item.mtime)].filter(Boolean).join(" · ");
    return `<div class="hg-card${custom ? " hg-custom" : ""}" data-rel="${esc(rel)}" data-url="${esc(urlOf(rel))}"${style}>
        <div class="hg-head">
          <span class="hg-title" title="${esc(rel)}">${esc(title)}</span>
          <span class="hg-sub" title="${esc(meta)}">${esc(rel)}</span>
        </div>
        <div class="hg-frame"${frameStyle}>
          <div class="hg-skel">正在加载…</div>
        </div>
        <div class="hg-grip e" data-dir="e"></div>
        <div class="hg-grip s" data-dir="s"></div>
        <div class="hg-grip se" data-dir="se"></div>
      </div>`;
  }

  function emptyHtml(kind) {
    if (kind === "nofolder") {
      return `<div class="hg-empty"><b>还没选文件夹</b>
        选一个装着网页的文件夹，这里就会把它们铺成卡片，<br>每张卡片直接显示那个页面的样子。
        <div style="margin-top:6px"><button class="hg-btn primary" data-act="pick">选择文件夹</button></div></div>`;
    }
    if (kind === "nohtml") {
      return `<div class="hg-empty"><b>这个文件夹里没找到 .html</b>
        换一个文件夹试试，或者勾上「含子文件夹」再扫一次。
        <div style="margin-top:6px"><button class="hg-btn primary" data-act="pick">重新选择</button></div></div>`;
    }
    return "";
  }

  /* ── 画 ─────────────────────────────────────────────────────────────── */

  function paint() {
    if (!rootEl) return;
    const el = rootEl;
    const label = state.folder ? tailOf(state.folder) : "未选择文件夹";
    const pathLine = state.folder
      ? `<b>${esc(label)}</b><span title="${esc(state.folder)}">${esc(state.folder)}</span>`
      : `<span>选一个本地文件夹，自动认出里面的 .html</span>`;
    let body = "";
    if (state.busy) {
      body = `<div class="hg-empty">正在扫描…</div>`;
    } else if (!state.folder) {
      body = emptyHtml("nofolder");
    } else if (state.error && !state.items.length) {
      body = `<div class="hg-empty"><b>读不到这个文件夹</b>${esc(state.error)}
        <div style="margin-top:6px"><button class="hg-btn primary" data-act="pick">重新选择</button></div></div>`;
    } else if (!state.items.length) {
      body = emptyHtml("nohtml");
    } else {
      body = state.items.map(cardHtml).join("");
    }
    el.innerHTML = `<div class="hg-wrap">
        <div class="hg-bar">
          <div class="hg-path${state.folder ? "" : " empty"}" title="${esc(state.folder)}">${pathLine}</div>
          <button class="hg-btn primary" data-act="pick">选择文件夹</button>
          <button class="hg-btn" data-act="rescan"${state.folder && !state.busy ? "" : " disabled"}>刷新</button>
          <label class="hg-check"><input type="checkbox" data-act="deep"${state.deep ? " checked" : ""}>含子文件夹</label>
        </div>
        <div class="hg-note">${noteHtml()}</div>
        <div class="hg-grid">${body}</div>
      </div>`;
    hookCards(el);
  }

  function noteHtml() {
    if (!state.folder) return "支持 .html / .htm；卡片里的画面是真的渲染，不是截图。";
    if (state.busy) return "正在扫描…";
    const n = state.items.length;
    const parts = [`${n} 个页面`];
    if (state.deep) parts.push("含子文件夹");
    parts.push("拖卡片右 / 下边框改大小，点卡片看整页");
    if (state.error) parts.push(`<span class="hg-warn">${esc(state.error)}</span>`);
    return parts.join(" · ");
  }

  /** 缩放：iframe 逻辑宽固定 1280，等比缩到卡片实际宽度。 */
  function scaleFrame(frame) {
    const iframe = frame.querySelector("iframe");
    if (!iframe) return;
    const w = frame.clientWidth || 0;
    if (!w) return;
    iframe.style.transform = `scale(${(w / FRAME_W).toFixed(5)})`;
    iframe.style.height = `${Math.round(FRAME_H)}px`;
  }

  function mountFrame(frame, url) {
    if (!frame || frame.querySelector("iframe")) return;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.src = url;
    iframe.addEventListener("load", () => {
      const skel = frame.querySelector(".hg-skel");
      if (skel) skel.remove();
    });
    frame.appendChild(iframe);
    scaleFrame(frame);
  }

  function hookCards(el) {
    if (observer) { observer.disconnect(); observer = null; }
    if (sizer) { sizer.disconnect(); sizer = null; }
    const grid = el.querySelector(".hg-grid");
    if (!grid) return;
    const frames = [...grid.querySelectorAll(".hg-frame")];

    // 只在滚到附近时才真的建 iframe：一屏几十个页面同时加载会互相拖死
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = entry.target.closest(".hg-card");
          if (card) mountFrame(entry.target, card.dataset.url || "");
          observer.unobserve(entry.target);
        }
      }, { rootMargin: "320px 0px" });
      frames.forEach((f) => observer.observe(f));
    } else {
      frames.forEach((f) => {
        const card = f.closest(".hg-card");
        if (card) mountFrame(f, card.dataset.url || "");
      });
    }

    // 尺寸变了（窗口缩放 / 拖边框 / 界面缩放）就重新算 iframe 的缩放比
    if ("ResizeObserver" in window) {
      sizer = new ResizeObserver((entries) => {
        for (const entry of entries) scaleFrame(entry.target);
      });
      frames.forEach((f) => sizer.observe(f));
    }

    // 首帧先把已有 iframe（自定义尺寸的卡片）对齐一次
    frames.forEach((f) => { if (f.querySelector("iframe")) scaleFrame(f); });
  }

  /* ── 拖边框改大小 ───────────────────────────────────────────────────── */

  function bindResize(el) {
    el.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest(".hg-grip");
      if (!grip) return;
      const card = grip.closest(".hg-card");
      const frame = card && card.querySelector(".hg-frame");
      if (!card || !frame) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = grip.dataset.dir || "se";
      const rect = frame.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
      const maxW = Math.max(MIN_W, el.clientWidth - 4);
      let w = start.w;
      let h = start.h;
      let moved = false;
      try { grip.setPointerCapture(e.pointerId); } catch { /* 某些 WebView 不支持，忽略 */ }

      const onMove = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (dir === "e" || dir === "se") w = Math.min(maxW, Math.max(MIN_W, start.w + dx));
        if (dir === "s" || dir === "se") h = Math.min(1400, Math.max(MIN_H, start.h + dy));
        card.classList.add("hg-custom");
        card.style.width = `${Math.round(w)}px`;
        frame.style.height = `${Math.round(h)}px`;
        scaleFrame(frame);
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        if (!moved) return;                       // 只是点了下边框，不改尺寸
        card.dataset.dragged = "1";
        state.sizes[card.dataset.rel] = { w: Math.round(w), h: Math.round(h) };
        saveSizes();
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });

    // 点卡片看整页。拖过边框的那一下不算点击。
    el.addEventListener("click", (e) => {
      if (e.target.closest(".hg-grip")) return;
      const card = e.target.closest(".hg-card");
      if (!card) return;
      if (card.dataset.dragged) { delete card.dataset.dragged; return; }
      openSheet(card.dataset.rel, card.dataset.url);
    });
  }

  /* ── 整页预览浮层 ───────────────────────────────────────────────────── */

  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    document.removeEventListener("keydown", onSheetKey, true);
  }

  function onSheetKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeSheet(); }
  }

  function openSheet(rel, url) {
    closeSheet();
    const item = state.items.find((x) => x.rel === rel) || {};
    const title = String(item.title || "").trim() || String(item.name || rel);
    const mask = document.createElement("div");
    mask.className = "hg-mask";
    mask.innerHTML = `<div class="hg-sheet">
        <div class="hg-sheet-bar">
          <span class="hg-sheet-title" title="${esc(rel)}">${esc(title)}</span>
          <button class="hg-btn" data-act="close">关闭</button>
        </div>
        <iframe class="hg-sheet-frame" src="${esc(url)}" referrerpolicy="no-referrer"></iframe>
      </div>`;
    mask.addEventListener("click", (e) => {
      if (e.target.closest("[data-act='close']")) { closeSheet(); return; }
      if (e.target === mask) closeSheet();
    });
    document.body.appendChild(mask);
    sheet = mask;
    document.addEventListener("keydown", onSheetKey, true);
  }

  /* ── 选文件夹浮层 ───────────────────────────────────────────────────── */

  function closePicker() {
    if (!picker) return;
    picker.remove();
    picker = null;
    document.removeEventListener("keydown", onPickerKey, true);
  }

  function onPickerKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); closePicker(); }
  }

  async function openPicker() {
    closePicker();
    const mask = document.createElement("div");
    mask.className = "hg-mask";
    mask.innerHTML = `<div class="hg-sheet">
        <div class="hg-sheet-bar">
          <span class="hg-sheet-title">选择装着网页的文件夹</span>
          <button class="hg-btn" data-act="close">关闭</button>
        </div>
        <div class="hg-crumb">
          <button class="hg-btn" data-act="up">上一级</button>
          <span class="hg-crumb-path">正在读取…</span>
        </div>
        <div class="hg-roots"></div>
        <div class="hg-dirs"></div>
        <div class="hg-picker-foot">
          <span class="hg-count"></span>
          <button class="hg-btn primary" data-act="use">就用这个文件夹</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    picker = mask;
    document.addEventListener("keydown", onPickerKey, true);

    const cur = { path: state.folder || "" };
    const dirsEl = mask.querySelector(".hg-dirs");
    const crumbEl = mask.querySelector(".hg-crumb-path");
    const countEl = mask.querySelector(".hg-count");
    const upBtn = mask.querySelector("[data-act='up']");
    const useBtn = mask.querySelector("[data-act='use']");

    const show = async (target) => {
      dirsEl.innerHTML = `<div class="hg-dir"><span class="hg-dir-name">正在读取…</span></div>`;
      let res;
      try {
        res = await tide.localHtml.list(target);
      } catch (e) {
        dirsEl.innerHTML = `<div class="hg-dir"><span class="hg-dir-name">${esc(String((e && e.message) || e))}</span></div>`;
        return;
      }
      if (!picker) return;
      cur.path = String(res.path || target);
      crumbEl.textContent = cur.path;
      crumbEl.title = cur.path;
      upBtn.disabled = !res.parent;
      upBtn.dataset.parent = res.parent || "";
      const n = Number(res.htmlCount) || 0;
      countEl.textContent = n ? `这一层有 ${n} 个页面` : "这一层没有页面，可以进去子文件夹看看";
      const rows = (res.dirs || []).map((d) => `<div class="hg-dir" data-path="${esc(d.path)}">
          <span class="hg-dir-name">${esc(d.name)}</span>
          <span class="hg-dir-n${d.htmlCount ? " hit" : ""}">${d.htmlCount ? `${d.htmlCount} 个页面` : ""}</span>
        </div>`).join("");
      dirsEl.innerHTML = rows || `<div class="hg-dir"><span class="hg-dir-name">没有子文件夹</span></div>`;
    };

    const rootsEl = mask.querySelector(".hg-roots");
    let firstRoot = "";
    try {
      const roots = await tide.localHtml.roots();
      if (!picker) return;
      const list = roots.roots || [];
      firstRoot = (list[0] && list[0].path) || "";
      rootsEl.innerHTML = list
        .map((r) => `<button class="hg-root" data-path="${esc(r.path)}">${esc(r.label)}</button>`)
        .join("");
    } catch { /* 拿不到起点也不影响手动往下点 */ }

    mask.addEventListener("click", async (e) => {
      if (e.target.closest("[data-act='close']")) { closePicker(); return; }
      if (e.target === mask) { closePicker(); return; }
      const up = e.target.closest("[data-act='up']");
      if (up && !up.disabled && up.dataset.parent) { await show(up.dataset.parent); return; }
      if (e.target.closest("[data-act='use']")) {
        const picked = cur.path;
        if (!picked) return;
        closePicker();
        await choose(picked);
        return;
      }
      const root = e.target.closest(".hg-root");
      if (root) { await show(root.dataset.path); return; }
      const dir = e.target.closest(".hg-dir[data-path]");
      if (dir) { await show(dir.dataset.path); }
    });

    const start = state.folder || firstRoot;
    if (start) await show(start);
    else dirsEl.innerHTML = `<div class="hg-dir"><span class="hg-dir-name">没有可用的起始目录</span></div>`;
  }

  async function choose(path) {
    state.folder = path;
    state.sizes = {};
    tide.storage.set(STORE.folder, path);
    saveSizes();
    paint();
    await loadFolder();
    paint();
  }

  /* ── 视图 ───────────────────────────────────────────────────────────── */

  function render(el) {
    ensureStyle();
    const my = ++epoch;
    rootEl = el;
    el.innerHTML = `<div class="hg-wrap"><div class="hg-empty">正在读取上次选的文件夹…</div></div>`;

    (async () => {
      try {
        await restore();
      } catch { state.error = "读取本地设置失败"; }
      if (my !== epoch || rootEl !== el) return;
      paint();
      if (state.folder) {
        await loadFolder();
        if (my !== epoch || rootEl !== el) return;
        paint();
      }
    })();

    el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const name = act.dataset.act;
      if (name === "pick") { openPicker(); return; }
      if (name === "rescan") {
        if (!state.folder || state.busy) return;
        paint();
        loadFolder().then(() => { if (rootEl === el) paint(); });
        return;
      }
      if (name === "deep") {
        state.deep = act.checked === true;
        tide.storage.set(STORE.deep, state.deep);
        if (!state.folder) return;
        paint();
        loadFolder().then(() => { if (rootEl === el) paint(); });
      }
    });
    bindResize(el);

    return () => {
      if (my !== epoch) return;
      epoch++;
      if (observer) { observer.disconnect(); observer = null; }
      if (sizer) { sizer.disconnect(); sizer = null; }
      closeSheet();
      closePicker();
      rootEl = null;
      // 静态服务跟着视图一起收掉：没有 iframe 了就没有读者，留着只是白占一个监听端口
      tide.localHtml.unserve().catch(() => {});
      state.base = "";
      state.items = [];
    };
  }

  tide.ui.registerView({
    id: "html-gallery",
    title: "HTML 目录",
    icon: "file-code",
    render,
  });
})();
