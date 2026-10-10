(function () {
  // 默认「应用内显示」：点卡片「打开」直接在本应用的面板里加载，不跳出到系统浏览器。
  // 用户仍可在工具栏下拉里改成「浏览器打开」，该选择会存进 storage 并被尊重。
  const DEFAULT_OPEN_MODE = "inside";
  let host = null, items = [], query = "", busy = false, openMode = DEFAULT_OPEN_MODE, iconPreview = null;
  const expandedCards = new Set();
  const DEFAULT_ITEMS = [
    { url: "http://daxue.qiyemulu.cn/", title: "大学名录", host: "daxue.qiyemulu.cn", iconUrl: "http://daxue.qiyemulu.cn/favicon.ico", iconName: "school", note: "默认：大学名录" },
    { url: "https://www.resource.edu.cn/", title: "国家教育资源公共服务平台", host: "resource.edu.cn", iconUrl: "https://www.resource.edu.cn/favicon.ico", iconName: "school", note: "默认：教育资源入口" },
  ];
  // v1.1.0 起默认条目的备注前缀由「默认收集：」改为「默认：」。老用户的条目早已存进
  // storage，只改 DEFAULT_ITEMS 不会生效 —— 下面做一次性改写兜住老数据。
  const LEGACY_NOTE_PREFIX = "默认收集：";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const fa = (name) => `<svg viewBox="0 0 512 512" aria-hidden="true"><use href="/icons/fontawesome/solid.svg#${esc(name || "globe")}"></use></svg>`;

  function styles() {
    if (document.getElementById("web-collector-style")) return;
    const s = document.createElement("style"); s.id = "web-collector-style";
    s.textContent = `
      .wc{max-width:1100px;margin:0 auto;padding:14px 0 30px;color:var(--ink)}.wc-hero{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;margin-bottom:14px}.wc-input{height:42px;border:1px solid var(--line);border-radius:10px;padding:0 12px;background:var(--paper);color:var(--ink);min-width:0}.wc-btn{height:42px;border-radius:10px;border:1px solid var(--line);padding:0 15px;background:var(--panel);color:var(--ink);font-weight:650}.wc-btn.pri{background:var(--deep);border-color:var(--deep);color:white}.wc-btn:disabled{opacity:.55}.wc-icon-preview{grid-column:1/-1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--line-soft);border-radius:12px;background:var(--paper);margin-top:2px}.wc-icon-preview .wc-icon{flex:none;width:38px;height:38px;border-radius:10px}.wc-icon-preview .wc-icon img{width:24px;height:24px}.wc-preview-text{flex:1;min-width:0;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2)}.wc-preview-text code{display:block;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3);white-space:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}.wc-icon-preview .wc-btn{height:32px;padding:0 12px;font-size:calc(12px * var(--ui-text-scale));flex:none}.wc-toolbar{display:flex;gap:9px;align-items:center;margin:10px 0 12px}.wc-toolbar .wc-input{flex:1}/* 搜索框只留一颗放大镜（用户要求「删除所有搜索框内的中文，仅保留搜索图标」） */.wc-searchbox{position:relative;display:flex;align-items:center;flex:1;min-width:0}.wc-searchbox>.wc-input{flex:1;min-width:0;padding-left:34px}.wc-search-ico{position:absolute;left:12px;width:15px;height:15px;display:inline-flex;color:var(--ink-3);pointer-events:none}.wc-search-ico svg{width:100%;height:100%;display:block}.wc-open-mode{height:42px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:var(--paper);color:var(--ink);font-size:calc(12px * var(--ui-text-scale))}.wc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:11px}.wc-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;grid-template-columns:46px minmax(0,1fr);gap:11px;content-visibility:auto;contain-intrinsic-size:120px}.wc-icon{width:46px;height:46px;border-radius:12px;background:var(--paper);border:1px solid var(--line-soft);display:grid;place-items:center;overflow:hidden}.wc-icon img{width:30px;height:30px;object-fit:contain}.wc-icon svg{width:24px;height:24px;fill:var(--deep)}.wc-title{font-size:calc(14px * var(--ui-text-scale));font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wc-host{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wc-note{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2);margin-top:8px;line-height:1.55;min-height:19px;overflow-wrap:anywhere}.wc-actions{grid-column:1/-1;display:flex;gap:7px;flex-wrap:wrap;margin-top:2px}.wc-actions button{border:1px solid var(--line);border-radius:8px;background:var(--paper);padding:6px 10px;font-size:calc(11px * var(--ui-text-scale));color:var(--ink)}.wc-empty{border:1.5px dashed var(--line);border-radius:16px;padding:32px;text-align:center;color:var(--ink-3)}.wc-edit{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-top:4px}.wc-edit input{height:34px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);padding:0 9px;min-width:0;width:100%;font-size:calc(13px * var(--ui-text-scale))}.wc-badge{display:inline-flex;font-size:calc(10px * var(--ui-text-scale));padding:2px 7px;border-radius:999px;background:color-mix(in srgb,var(--deep) 10%,var(--panel));color:var(--deep);margin-top:6px}.wc-web-mask{position:fixed;inset:0;z-index:1980;background:rgba(15,23,42,.42);backdrop-filter:blur(3px)}.wc-web-panel{position:fixed;inset:calc(18px + var(--sat,env(safe-area-inset-top,0px))) calc(18px + var(--sar,env(safe-area-inset-right,0px))) calc(18px + var(--sab,env(safe-area-inset-bottom,0px))) calc(18px + var(--sal,env(safe-area-inset-left,0px)));z-index:1981;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 24px 70px rgba(15,23,42,.26)}.wc-web-head{height:52px;flex:none;display:flex;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--line-soft)}.wc-web-head b{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wc-web-head button{border:1px solid var(--line);border-radius:8px;background:var(--paper);padding:6px 10px;color:var(--ink)}.wc-web-panel iframe{flex:1;width:100%;border:0;background:var(--paper)}.wc-web-blocked{flex:1;display:grid;place-content:center;justify-items:center;gap:11px;padding:24px;text-align:center;background:var(--paper)}.wc-web-blocked b{font-size:calc(14px * var(--ui-text-scale))}.wc-web-blocked p{margin:0;max-width:34em;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.7;color:var(--ink-2)}
      @media(max-width:640px){.wc-hero{grid-template-columns:1fr}.wc-hero .wc-btn{width:100%}.wc-icon-preview .wc-btn{width:auto}.wc-icon-preview{flex-wrap:wrap}.wc-preview-text{flex-basis:100%}.wc-grid{grid-template-columns:1fr}.wc-edit{grid-template-columns:1fr}}
      /* 拖入时的落区提示：只给 .wc 描虚线框 + 在 hero 网格末尾补一行说明，
         刻意**不建 position:fixed 遮罩** —— 浮层就得自己让开四边安全区（见宿主 .view 的约定），
         而这两种样式都长在已有布局里，零额外成本也不会算两遍安全区。 */
      .wc-dropping .wc{outline:2px dashed var(--deep);outline-offset:-10px;border-radius:22px}
      .wc-dropping .wc-hero{border-color:var(--deep)}
      .wc-dropping .wc-hero::after{content:"松手即自动收藏（可一次拖多个网址）";grid-column:1/-1;font-size:calc(12px * var(--ui-text-scale));font-weight:650;color:var(--deep)}
      @media(max-width:640px){.wc-dropping .wc-hero::after{grid-column:1/-1;text-align:center}}
    `;
    s.textContent += `.wc-card{min-width:0}.wc-card>div:nth-child(2){min-width:0}.wc-title{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;line-height:1.4}.wc-note{max-height:3.1em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.wc-card.expanded .wc-note{max-height:none;display:block}.wc-card:not(.expanded) .wc-edit,.wc-card:not(.expanded) .wc-actions [data-save],.wc-card:not(.expanded) .wc-actions [data-fetch-icon],.wc-card:not(.expanded) .wc-actions [data-refresh],.wc-card:not(.expanded) .wc-actions [data-remove]{display:none}.wc-card .wc-actions{align-items:center}.wc-card .wc-actions [data-more]{margin-left:auto}.wc-edit{min-width:0}.wc-edit input{box-sizing:border-box}.wc-card.expanded .wc-actions{border-top:1px solid var(--line-soft);padding-top:9px}`;
    document.head.append(s);
  }

  async function save() { await tide.storage.set("items", items); }

  /* ── 拖入的文本里挑网址 ──
     拖法的差别要分开认：拖浏览器标签 / 拖页面上选中的链接，Chromium 给的是 text/plain
     （地址本身）+ text/html（`<a href>`，标题文字也在里面）；从资源管理器或别的系统
     拖「网址文件」进来给的是 text/uri-list（多行、可带 `#` 注释行）。
     🔴 带 Files 的一律不接管：那可能是图片/文档，属于全局快速捕获（解析成任务 + 时间块）
        的活，抢过来只会让人「拖截图建任务」突然失灵。 */
  const DROP_MAX = 12;
  const DROP_URL_RE = /https?:\/\/[^\s"'<>\\`]+/gi;
  function extractDropUrls(dt) {
    const types = Array.from((dt && dt.types) || []);
    if (!types.length || types.includes("Files")) return [];
    const read = (type) => { try { return String((dt.getData && dt.getData(type)) || ""); } catch { return ""; } };
    // uri-list 优先：它就是纯地址清单，不会像 text/html 那样把页面里的其他链接一起混进来
    const source = read("text/uri-list") || read("text/plain") || read("text/html");
    const seen = new Set();
    const urls = [];
    for (const hit of source.match(DROP_URL_RE) || []) {
      /* 真地址一律是 ASCII（中文路径浏览器会给成百分号编码），所以碰到第一个非 ASCII
         字符就断掉：中文语境里拖出来的一段文本（「…https://a.cn/。还有…」），
         不断掉就会把句号和后面的字一起收进地址，点开直接 404。
         尾部残留的英文标点（句号、右括号、分号）一并削掉。 */
      const url = hit.split(/[\u0080-\uffff]/)[0].replace(/[,;:.)\]]+$/, "");
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
      if (urls.length >= DROP_MAX) break;
    }
    return urls;
  }

  async function ensureDefaults() {
    const seen = new Set(items.map((x) => String(x.url || "").replace(/\/$/, "")));
    let changed = false;
    for (const item of DEFAULT_ITEMS) {
      if (seen.has(item.url.replace(/\/$/, ""))) continue;
      items.push({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), ...item });
      changed = true;
    }
    if (changed) await save();
  }
  /** 只改写「默认条目」上的旧前缀，避免误伤用户自己写的、碰巧以同样文字开头的备注。 */
  async function migrateNotes() {
    const defaults = new Set(DEFAULT_ITEMS.map((x) => x.url.replace(/\/$/, "")));
    let changed = false;
    for (const item of items) {
      if (!defaults.has(String(item.url || "").replace(/\/$/, ""))) continue;
      if (typeof item.note === "string" && item.note.startsWith(LEGACY_NOTE_PREFIX)) {
        item.note = "默认：" + item.note.slice(LEGACY_NOTE_PREFIX.length);
        changed = true;
      }
    }
    if (changed) await save();
  }
  // 图标一律优先用抓好的 data URL。**必须走原生侧**：Android 上页面来源是
  // `https://tauri.localhost`，WebView 默认禁混合内容，内置预置条目那种
  // `http://…/favicon.ico` 直连会被静默拦掉（桌面端页面来源是 http，看不出问题）。
  // 只认我们自己生成的那种 data URL —— 只查前缀的话，脏值里塞个引号就能突破 src 属性。
  function iconDataOf(item) {
    const v = item.iconData;
    return typeof v === "string" && /^data:image\/(?!svg)[a-z0-9][a-z0-9.+-]*;base64,[A-Za-z0-9+/]+={0,2}$/i.test(v) ? v : "";
  }
  /** 抓图标转 data URL。失败**不抛** —— 调用它的是识别 / 刷新流程，图标拿不到不该把整条流程带塌。 */
  async function fetchIconData(iconUrl) {
    if (!iconUrl) return "";
    try { return (await tide.http.getIcon(iconUrl)) || ""; } catch { return ""; }
  }
  function favicon(item) {
    const fallback = fa(item.iconName || "globe");
    const src = iconDataOf(item) || String(item.iconUrl || "");
    if (!src) return fallback;
    return `<img loading="lazy" decoding="async" src="${esc(src)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">` + `<span style="display:none">${fallback}</span>`;
  }
  function visible() {
    const q = query.trim().toLowerCase(); if (!q) return items;
    return items.filter((x) => `${x.title} ${x.url} ${x.host} ${x.note || ""}`.toLowerCase().includes(q));
  }
  function paint() {
    if (!host?.isConnected) return;
    const rows = visible();
    host.innerHTML = `<div class="wc"><div class="wc-hero"><input class="wc-input" data-url placeholder="输入网站，例如 https://www.example.edu.cn"><button class="wc-btn pri" data-add ${busy ? "disabled" : ""}>${busy ? "正在识别…" : "自动识别并收藏"}</button><button class="wc-btn" data-probe-icon ${busy ? "disabled" : ""}>${busy ? "获取中…" : "自动获取网站图标"}</button></div>${iconPreview ? `<div class="wc-icon-preview"><span class="wc-icon">${favicon(iconPreview)}</span><span class="wc-preview-text">图标地址：<code>${esc(iconPreview.iconUrl || "未取到")}</code></span><button class="wc-btn" data-preview-save ${busy ? "disabled" : ""}>存为新条目</button><button class="wc-btn" data-preview-clear>清空</button></div>` : ""}</div><div class="wc-toolbar"><span class="wc-searchbox"><span class="wc-search-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span><input class="wc-input" data-search value="${esc(query)}" aria-label="搜索已收藏网站" title="搜索已收藏网站" placeholder=""></span><select class="wc-open-mode" data-open-mode aria-label="网站打开方式"><option value="external"${openMode === "external" ? " selected" : ""}>浏览器打开</option><option value="inside"${openMode === "inside" ? " selected" : ""}>应用内显示</option></select><span style="font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2)">${rows.length} / ${items.length}</span></div><div class="wc-grid">${rows.map((x) => `<article class="wc-card" data-id="${esc(x.id)}"><div class="wc-icon">${favicon(x)}</div><div><div class="wc-title" title="${esc(x.title)}">${esc(x.title)}</div><div class="wc-host">${esc(x.host || x.url)}</div><span class="wc-badge">FA: ${esc(x.iconName || "globe")}</span><div class="wc-note">${esc(x.note || "暂无备注")}</div></div><div class="wc-edit"><input data-title value="${esc(x.title)}" aria-label="名称"><input data-note value="${esc(x.note || "")}" placeholder="备注" aria-label="备注"></div><div class="wc-actions"><button data-open>打开</button><button data-save>保存修改</button><button data-fetch-icon title="只重新抓取这个网站的图标，标题与备注保持不变">换图标</button><button data-refresh>刷新名称/图标</button><button data-remove>删除</button></div></article>`).join("") || `<div class="wc-empty">还没有收藏网页。输入网址后会自动获取网站名称和图标。</div>`}</div></div>`;
    for (const card of host.querySelectorAll(".wc-card")) {
      const open = expandedCards.has(card.dataset.id);
      card.classList.toggle("expanded", open);
      const more = document.createElement("button");
      more.type = "button"; more.dataset.more = "";
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? "收起" : "更多";
      card.querySelector(".wc-actions").append(more);
    }
    fitInputFonts();
  }

  /** 名称/备注超长时自动缩小字号适配框宽，缩到 11px 为止（再放不下交给省略号）——
   *  缩太小读起来难受，11px 是「能看清」的下限。
   *  字号一律写成 `calc(Npx * var(--ui-text-scale))`：scrollWidth/clientWidth 量的是
   *  缩放后的实际渲染宽度，收缩循环在任意「文字大小」档位下逻辑不变。 */
  function fitInputFonts() {
    const MAX = 13, MIN = 11;
    for (const input of host.querySelectorAll(".wc-edit input")) {
      let size = MAX;
      input.style.fontSize = `calc(${size}px * var(--ui-text-scale, 1))`;
      while (size > MIN && input.scrollWidth > input.clientWidth) {
        size -= 0.5;
        input.style.fontSize = `calc(${size}px * var(--ui-text-scale, 1))`;
      }
    }
  }

  /* 🔴 站内 iframe 在 APK 上会「白板」—— 和图标那次是同一个根因：
     Android 上 Tauri 用 WebViewAssetLoader（没指定 scheme ⇒ 默认 https），页面来源是
     https://tauri.localhost；WebView 自 API 21 起默认 MIXED_CONTENT_NEVER_ALLOW
     ⇒ 页面里 http 的 iframe 被**静默拦掉**；release 还叠了 usesCleartextTraffic=false。
     桌面端页面来源是 http://tauri.localhost，同一个地址嵌得出来 —— 所以只有 APK 上是空白。
     判据用「页面自己是不是 https」而不是「是不是 Android」：混合内容的定义就是这个，
     换平台 / 换 scheme 都不会失效。（站点允许被嵌：实测两个站点都回了 200 且无
     X-Frame-Options / CSP frame-ancestors，所以不是 frame-ancestors 的锅。） */
  const PAGE_IS_HTTPS = location.protocol === "https:";
  const cleartextBlocked = (url) => PAGE_IS_HTTPS && /^http:\/\//i.test(String(url || ""));

  function openInside(item) {
    document.querySelector(".wc-web-panel")?._close?.();
    const mask = document.createElement("div"); mask.className = "wc-web-mask";
    const panel = document.createElement("div"); panel.className = "wc-web-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", item.title || "网站");
    const close = () => { mask.remove(); panel.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    panel._close = close;
    mask.addEventListener("click", close);
    /* 嵌不出来的地址**不要挂 iframe** —— 挂上去只会得到一块空白，看起来就是「插件坏了」，
       用户也不知道该点哪里。直接把原因和出口摆进面板，出口就是头部那个「浏览器打开」。 */
    const body = cleartextBlocked(item.url)
      ? `<div class="wc-web-blocked"><b>这个站点是 http 明文地址</b><p>应用内显示不了：页面来源是 https，系统不允许 https 页面加载 http 内容。请用「浏览器打开」。</p><button class="wc-btn" data-web-external>浏览器打开</button></div>`
      : `<iframe src="${esc(item.url)}" title="${esc(item.title || "网站")}"></iframe>`;
    panel.innerHTML = `<div class="wc-web-head"><b title="${esc(item.url)}">${esc(item.title || item.url)}</b><button data-web-external>浏览器打开</button><button data-web-close>关闭</button></div>${body}`;
    panel.querySelector("[data-web-close]").addEventListener("click", close);
    // querySelectorAll：降级面板里还有一个「浏览器打开」，两个都要接上
    panel.querySelectorAll("[data-web-external]").forEach((b) => b.addEventListener("click", () => tide.util.openUrl(item.url)));
    document.addEventListener("keydown", onKey);
    document.body.append(mask, panel);
  }

  function openItem(item) {
    if (openMode === "inside") openInside(item);
    else tide.util.openUrl(item.url);
  }

  async function inspect(url) {
    const normalized = tide.util.web.normalizeUrl(url);
    let finalUrl = normalized, meta;
    try {
      const res = await tide.http.getCached(normalized, 10 * 60 * 1000);
      finalUrl = res.finalUrl || normalized;
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      meta = tide.util.web.parseSiteMeta(res.body, finalUrl);
    } catch (e) {
      const u = new URL(normalized);
      meta = { title: u.hostname.replace(/^www\./, ""), host: u.hostname.replace(/^www\./, ""), iconUrl: new URL("/favicon.ico", normalized).toString(), iconName: tide.util.web.inferIconName("", normalized), warning: e.message || String(e) };
    }
    return { url: finalUrl, ...meta, iconData: await fetchIconData(meta.iconUrl) };
  }

  /* ── 只取网站图标，不碰名称与备注 ──
     和 inspect() 的区别：inspect 是「整体识别」（标题 + 图标 + FA 名），
     会覆盖用户手改过的标题；这里只解决「图标不对/是白板」这一件事，
     所以只回写 iconUrl / iconName，其他字段原样保留。 */
  async function fetchIcon(url) {
    const normalized = tide.util.web.normalizeUrl(url);
    let finalUrl = normalized, iconUrl = "", iconName = "";
    try {
      const res = await tide.http.getCached(normalized, 10 * 60 * 1000);
      finalUrl = res.finalUrl || normalized;
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const meta = tide.util.web.parseSiteMeta(res.body, finalUrl);
      iconUrl = meta.iconUrl || "";
      iconName = meta.iconName || "";
    } catch (e) {
      iconUrl = new URL("/favicon.ico", normalized).toString();
      iconName = tide.util.web.inferIconName("", normalized);
    }
    if (!iconUrl) iconUrl = new URL("/favicon.ico", finalUrl).toString();
    return { iconUrl, iconName: iconName || "globe", iconData: await fetchIconData(iconUrl) };
  }

  /** 顶栏「自动获取网站图标」：拿输入框里的网址试抓一次，只回显结果，不动已有条目。 */
  async function probeIcon() {
    if (busy) return;
    const input = host.querySelector("[data-url]"); const raw = input?.value || "";
    if (!raw.trim()) return tide.notify("请先输入网站地址");
    busy = true; paint();
    try {
      const got = await fetchIcon(raw);
      iconPreview = { url: tide.util.web.normalizeUrl(raw), ...got };
      busy = false; paint();
      tide.notify(got.iconUrl ? `已获取图标：${got.iconUrl.split("/").pop() || got.iconUrl}` : "没有取到图标，已回退为默认域名图标");
    } catch (e) { busy = false; paint(); tide.notify(`获取图标失败：${e.message || e}`); }
  }

  /** 卡片上的「换图标」：只刷新这一个条目的图标。 */
  async function refreshIcon(id) {
    const item = items.find((x) => x.id === id); if (!item) return;
    try {
      const got = await fetchIcon(item.url);
      Object.assign(item, got, { updatedAt: Date.now() });
      await save(); paint(); tide.notify("图标已更新");
    } catch (e) { tide.notify(`获取图标失败：${e.message || e}`); }
  }

  /** 把顶栏预览到的图标落成一条收藏（用输入框里的网址，走一次完整识别拿标题）。 */
  async function savePreviewAsItem() {
    if (!iconPreview || busy) return;
    busy = true; paint();
    try {
      // 图标以用户刚刚预览到的那张为准 —— 说明他就是要这个。
      const data = await collect(iconPreview.url, { iconUrl: iconPreview.iconUrl, iconName: iconPreview.iconName });
      iconPreview = null;
      busy = false; paint();
      tide.notify(`已收藏「${data.title}」`);
    } catch (e) { busy = false; paint(); tide.notify(`收藏失败：${e.message || e}`); }
  }

  /** 收藏一个原始地址：识别元信息 → 同 URL 覆盖、否则置顶 → 落库。
      输入框、图标预览「存为新条目」与拖入三条入口共用这一条路，所以落库点全文件只有一处。
      `overrides` 给图标预览用：用户刚预览到的那张图标就是他想要的，不能被重新抓的结果顶掉。 */
  async function collect(raw, overrides) {
    const data = await inspect(raw);
    // 只覆盖给了值的字段：预览里没拿到图标时要保留 inspect 抓到的那张，别写成空
    for (const [key, value] of Object.entries(overrides || {})) { if (value) data[key] = value; }
    const existing = items.find((x) => x.url.replace(/\/$/, "") === data.url.replace(/\/$/, ""));
    if (existing) Object.assign(existing, data, { updatedAt: Date.now() });
    else items.unshift({ id: uid(), note: "", createdAt: Date.now(), updatedAt: Date.now(), ...data });
    await save();
    return data;
  }

  async function add() {
    if (busy) return;
    const input = host.querySelector("[data-url]"); const raw = input?.value || ""; if (!raw.trim()) return tide.notify("请先输入网站地址");
    busy = true; paint();
    try {
      const data = await collect(raw);
      tide.notify(data.warning ? `已收藏；元信息读取失败，已使用域名：${data.warning}` : `已收藏「${data.title}」`);
    } catch (e) { tide.notify(`收藏失败：${e.message || e}`); }
    busy = false; paint();
  }

  /** 把拖进来的网址逐个收藏。一次拖多个（多选标签、书签文件夹）时逐个抓，失败的不中断其余。 */
  async function collectDropped(urls) {
    if (busy || !urls.length) return;
    busy = true; paint();
    const titles = [];
    let failed = 0;
    for (const url of urls) {
      try { titles.push((await collect(url)).title); } catch { failed += 1; }
    }
    busy = false; paint();
    if (!titles.length) return tide.notify(`拖入的 ${urls.length} 个地址都没能收藏，请改用输入框`);
    if (titles.length === 1) return tide.notify(`已收藏「${titles[0]}」${failed ? `，另有 ${failed} 个失败` : ""}`);
    return tide.notify(`已收藏拖入的 ${titles.length} 个网站：${titles.slice(0, 3).join("、")}${titles.length > 3 ? " 等" : ""}${failed ? `，另有 ${failed} 个失败` : ""}`);
  }

  async function refresh(id) {
    const item = items.find((x) => x.id === id); if (!item) return;
    try { Object.assign(item, await inspect(item.url), { updatedAt: Date.now() }); await save(); paint(); tide.notify("网站信息已刷新"); }
    catch (e) { tide.notify(`刷新失败：${e.message || e}`); }
  }
  async function render(el) {
    host = el; styles(); items = await tide.storage.get("items", []); if (!Array.isArray(items)) items = [];
    openMode = await tide.storage.get("openMode", DEFAULT_OPEN_MODE); if (!["external", "inside"].includes(openMode)) openMode = DEFAULT_OPEN_MODE;
    await ensureDefaults(); await migrateNotes(); paint();
    // 存量条目补图标：升级前保存的条目只有远程地址，在 APK 上取不到
    // （内置预置的「大学名录」本身就是 http）。后台补抓，不阻塞首屏。
    if (items.some((x) => x.iconUrl && !iconDataOf(x))) {
      setTimeout(async () => {
        let changed = false;
        for (const item of items) {
          if (!item.iconUrl || iconDataOf(item)) continue;
          const data = await fetchIconData(item.iconUrl);
          if (data) { item.iconData = data; changed = true; }
        }
        if (changed) { await save(); paint(); }
      }, 0);
    }
    host.addEventListener("click", (e) => {
      // ⚠️ 顶栏按钮与卡片按钮必须用**不同**的 data 标记：
      // 两者都叫 data-fetch-icon 的话，这行会抢先命中，卡片的「换图标」永远拿不到 id。
      if (e.target.closest("[data-add]")) return add();
      if (e.target.closest("[data-probe-icon]")) return probeIcon();
      if (e.target.closest("[data-preview-clear]")) { iconPreview = null; return paint(); }
      if (e.target.closest("[data-preview-save]")) return savePreviewAsItem();
      const card = e.target.closest("[data-id]"); if (!card) return; const id = card.dataset.id; const item = items.find((x) => x.id === id); if (!item) return;
      if (e.target.closest("[data-more]")) { if (expandedCards.has(id)) expandedCards.delete(id); else expandedCards.add(id); return paint(); }
      if (e.target.closest("[data-open]")) openItem(item);
      else if (e.target.closest("[data-fetch-icon]")) refreshIcon(id);
      else if (e.target.closest("[data-refresh]")) refresh(id);
      else if (e.target.closest("[data-remove]")) { items = items.filter((x) => x.id !== id); expandedCards.delete(id); save().then(paint); }
      else if (e.target.closest("[data-save]")) { item.title = card.querySelector("[data-title]").value.trim() || item.title; item.note = card.querySelector("[data-note]").value.trim(); save().then(() => { paint(); tide.notify("已保存"); }); }
    });
    host.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-url]")) add(); });
    host.addEventListener("input", (e) => { if (e.target.matches("[data-search]")) { query = e.target.value; paint(); const next = host.querySelector("[data-search]"); next?.focus(); next?.setSelectionRange(query.length, query.length); } });
    host.addEventListener("change", async (e) => { if (e.target.matches("[data-open-mode]")) { openMode = e.target.value; await tide.storage.set("openMode", openMode); tide.notify(openMode === "inside" ? "网站将在应用内显示" : "网站将在浏览器打开"); paint(); } });
    /* ── 拖入即收藏 ──
       🔴 必须 stopPropagation：宿主在 document 上挂了全局快速捕获（src/capture.js），
       不拦的话拖进来的链接会被当成「贴进来的文本」解析成任务 + 时间块，而不是收藏。
       dragover 的 preventDefault 也不能省 —— 不 preventDefault 浏览器根本不认这是可放置
       目标，drop 永远不触发（inbox-drop 同款）。
       判不了就在 drop 里放行：文本里没挑出网址时不 preventDefault、不 stopPropagation，
       让它照老路子交给全局捕获。 */
    let dragDepth = 0;
    const droppable = (e) => {
      const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
      return !!e.dataTransfer && !types.includes("Files")
        && types.some((t) => t === "text/uri-list" || t === "text/plain" || t === "text/html");
    };
    const markDrop = (on) => { host.classList.toggle("wc-dropping", on); };
    host.addEventListener("dragenter", (e) => { if (!droppable(e)) return; e.preventDefault(); e.stopPropagation(); dragDepth += 1; markDrop(true); });
    host.addEventListener("dragover", (e) => {
      if (!droppable(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      markDrop(true);
    });
    host.addEventListener("dragleave", (e) => {
      if (!droppable(e)) return;
      e.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) markDrop(false);
    });
    host.addEventListener("drop", (e) => {
      if (!droppable(e)) return;
      const urls = extractDropUrls(e.dataTransfer);
      if (!urls.length) { dragDepth = 0; markDrop(false); return; }
      e.preventDefault(); e.stopPropagation();
      dragDepth = 0; markDrop(false);
      collectDropped(urls);
    });
    return () => { if (host === el) { host = null; dragDepth = 0; } };
  }
  tide.ui.registerView({ id: "web-collector", title: "网页收集", icon: "bookmark", render });
})();
