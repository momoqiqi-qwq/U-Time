// 警大门户通知 · 邮箱（mail.cppu.edu.cn / 雪球 Sirius Web）
//
// 独立界面，不照搬网页：Sirius 那套是整站 SPA，侧栏 + 三栏 + 阅读器，塞进插件只会变成
// 一个更窄的浏览器窗口。这里按 U-Time 的卡片语言重排成两块：
//   ① 概览（未读 / 收件箱总数）
//   ② 收件箱最近 N 封（发件人 + 主题 + 时间），点一封直接在应用内邮箱窗口打开
//
// 边界：本模块**不碰**账号、密码、vault、Cookie、验证码 —— 那是 main.js 的事。
// 一切取数走 bridge.load({force})，那边负责用「警大通知」保存的账号密码自动登录
// （含验证码识别、会话续期），再走 coreremail 的 mbox 接口；本模块只认
// 「拿到 mails / 没拿到」两种结果，以及 needLogin 这一个额外信号。
//
// 口径（老 XT 的 JSON 端点，字段靠宽容解析，别当成契约）：
//   未读/总数优先取 mbox:getAllFolders 里 Inbox 那一项的 unread/total，
//   取不到再从 mbox:listMessages 的条目自己数；
//   列表里 read 的判定是 flags 含 read、或 read 字段为 true/1（两种都给过）。
//   解析不出条目但会话有效时**不报错**：显示「会话已建立但没解析出邮件」并保底给
//   一个「在邮箱窗口查看」按钮 —— 站点改版不应该让这页变成一句红字。

export function createMailView(tide, bridge) {
  const KEY = "mailViewPreferences";
  const PAGE = 20;
  const FRESH_MS = 60 * 1000;

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clean = (v) => {
    const s = String(v ?? "").trim();
    return !s || s === "null" || s === "undefined" || s === "NaN" ? "" : s;
  };
  const num = (v) => {
    const n = Number(clean(v));
    return Number.isFinite(n) ? n : 0;
  };

  const state = {
    disposed: false,
    root: null,
    loading: false,
    inFlight: 0,
    loadedAt: 0,
    error: "",
    needLogin: false,
    stale: "",
    account: "",
    unread: 0,
    total: 0,
    mails: [],
    visible: PAGE,
    filter: "all",     // all | unread
  };
  const glowHandles = [];

  /* ── 格式化 ───────────────────────────────────────────────────────────── */
  const pad2 = (n) => String(n).padStart(2, "0");

  /* Coremail 的 sentDate 三种写法都遇到过：'2026-10-19 15:04:03'、ISO、毫秒/秒时间戳。
     都按本地时间读（服务端给的就是本地时间，没有时区后缀）。 */
  const toDate = (v) => {
    const s = clean(v);
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return new Date(n > 1e11 ? n : n * 1000);
    }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? null : dt;
  };

  const dayKey = (dt) => (dt ? `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}` : "");
  const fmtWhen = (v) => {
    const dt = toDate(v);
    if (!dt) return clean(v);
    const now = new Date();
    const sameDay = dayKey(dt) === dayKey(now);
    const hm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    if (sameDay) return hm;
    const yday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dayKey(dt) === dayKey(yday)) return `昨天 ${hm}`;
    if (dt.getFullYear() === now.getFullYear()) return `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  };

  const fmtBytes = (v) => {
    const n = num(v);
    if (n <= 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const fmtSynced = (ts) => {
    const n = num(ts);
    if (!n) return "";
    const dt = new Date(n);
    return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  };

  /* ── 样式（只注入一次；前缀 ml- 与 netlog.js 的 nlog- 并列，互不覆盖）──── */
  function styles() {
    if (document.querySelector("style[data-cppu-mail]")) return;
    const node = document.createElement("style");
    node.dataset.cppuMail = "1";
    node.textContent = `
.ml-wrap{display:flex;flex-direction:column;gap:12px;padding:2px 0 4px;--ml-soft:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66));--ml-dim:color-mix(in srgb,var(--ink,#22303A) 68%,var(--ink-2,#4A5A66))}
.ml-card{border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
.ml-card.ml-sec{padding:15px 16px 16px}
.ml-card.ml-sec>header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.ml-card.ml-sec h3{margin:0;font-size:calc(15px * var(--ui-text-scale));letter-spacing:.02em}
.ml-card.ml-sec>header .ml-sub{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ml-soft);white-space:nowrap;font-variant-numeric:tabular-nums}
/* 工具条：账号 + 登录态徽标 + 筛选单选（光块由宿主 selectionGlow 画）+ 刷新 + 打开邮箱 */
.ml-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.ml-who{display:inline-flex;align-items:center;gap:7px;min-width:0;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)}
.ml-who b{font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.ml-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 8px;font-size:calc(10.5px * var(--ui-text-scale));border:1px solid var(--line);background:color-mix(in srgb,var(--deep,#0F4C5C) 6%,var(--panel));color:var(--ink-2,#4A5A66);white-space:nowrap}
.ml-badge.on{border-color:color-mix(in srgb,var(--sea,#118AB2) 46%,var(--line));background:color-mix(in srgb,var(--sea,#118AB2) 12%,var(--panel));color:var(--ink)}
.ml-badge.warn{border-color:color-mix(in srgb,var(--danger,#B03535) 42%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 9%,var(--panel))}
.ml-tabs{display:inline-flex;position:relative;isolation:isolate;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
.ml-tabs .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;transition:opacity .2s linear;border-radius:10px;background:var(--deep,#0F4C5C)}
.ml-tabs .selection-glow.on{opacity:1}
.ml-tabs.has-selection-glow button{position:relative;z-index:1}
.ml-tabs.has-selection-glow button[aria-pressed=true]{background:transparent}
.ml-tabs button{font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:inherit;background:transparent;border:0;padding:8px 13px;min-height:36px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,color .18s ease;white-space:nowrap}
.ml-tabs button+button{border-left:1px solid var(--line)}
.ml-tabs button[aria-pressed=true]{background:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.ml-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 13px;min-height:36px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.ml-btn:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 6%,var(--panel))}
.ml-btn.ml-primary{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.ml-btn:disabled{opacity:.5;cursor:default}
.ml-bar .ml-right{margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
/* ① 概览 */
.ml-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:15px 16px 16px}
.ml-stat{border:1px solid var(--line);border-radius:12px;padding:11px 13px;background:color-mix(in srgb,var(--deep,#0F4C5C) 5%,var(--panel))}
.ml-stat small{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ml-soft);margin-bottom:6px;white-space:nowrap}
.ml-stat strong{font-size:calc(19px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;color:var(--deep,#0F4C5C);overflow-wrap:anywhere}
.ml-stat .ml-cardsub{display:block;margin-top:4px;font-size:calc(10.5px * var(--ui-text-scale));line-height:1.45;color:var(--ml-soft);font-variant-numeric:tabular-nums;white-space:normal}
/* ② 收件箱列表 */
.ml-rows{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.ml-row{border:1px solid var(--line);border-radius:11px;background:var(--panel);overflow:hidden}
.ml-hit{display:grid;grid-template-columns:auto 1fr;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:10px 12px;min-height:46px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease}
.ml-hit:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 6%,var(--panel))}
.ml-hit:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.ml-dot{width:8px;height:8px;border-radius:999px;margin-top:6px;background:transparent;border:1px solid color-mix(in srgb,var(--ink,#22303A) 22%,transparent);flex:none}
.ml-row.unread .ml-dot{background:var(--sea,#118AB2);border-color:var(--sea,#118AB2)}
.ml-body{min-width:0;display:grid;gap:3px}
.ml-head{display:flex;align-items:baseline;gap:9px;min-width:0}
.ml-head b{font-size:calc(12.5px * var(--ui-text-scale));font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ml-head i{margin-left:auto;font-style:normal;font-size:calc(11px * var(--ui-text-scale));color:var(--ml-dim);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}
.ml-subj{font-size:calc(12px * var(--ui-text-scale));line-height:1.5;color:var(--ink-2,#4A5A66);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ml-row.unread .ml-subj{color:var(--ink);font-weight:600}
.ml-size{font-style:normal;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ml-dim);margin-left:6px;white-space:nowrap}
.ml-more{display:flex;justify-content:center;padding:12px 0 0}
.ml-empty{border:1px dashed var(--line);border-radius:11px;padding:18px;text-align:center;color:var(--ml-soft);font-size:calc(12px * var(--ui-text-scale));line-height:1.85}
.ml-loading{padding:26px 16px;text-align:center;color:var(--ml-soft);font-size:calc(12.5px * var(--ui-text-scale))}
.ml-alert{border:1px solid color-mix(in srgb,var(--danger,#B03535) 42%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 8%,var(--panel));border-radius:11px;padding:12px 14px;font-size:calc(12px * var(--ui-text-scale));line-height:1.85;color:var(--ink)}
.ml-alert .ml-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.ml-note{margin:0;font-size:calc(11px * var(--ui-text-scale));line-height:1.8;color:var(--ml-soft)}
@media(max-width:440px){
.ml-bar .ml-right{margin-left:0;width:100%}
.ml-btn{flex:1 1 0;text-align:center}
.ml-stats{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){.ml-hit,.ml-tabs button{transition-duration:.01ms!important}}`;
    document.head.append(node);
  }

  /* ── 取数 ────────────────────────────────────────────────────────────── */
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});

  const call = (params) => Promise.resolve(bridge?.load?.(params))
    .then((r) => (r && typeof r === "object" ? r : { ok: false, error: "取数通道不可用" }))
    .catch((e) => ({ ok: false, error: e?.message || "取数失败" }));

  const openMail = (btn) => {
    if (btn) btn.setAttribute("aria-busy", "1");
    Promise.resolve(bridge?.open?.())
      .catch((e) => { try { tide.notify?.(`邮箱窗口打开失败：${e?.message || e}`); } catch { /* ignore */ } })
      .finally(() => { if (btn) btn.removeAttribute("aria-busy"); });
  };

  function load(force = false) {
    if (state.inFlight) return state.inFlight;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < FRESH_MS) {
      paint();
      return Promise.resolve();
    }
    state.loading = true;
    state.error = "";
    state.stale = "";
    const releaseWait = state.loadedAt ? () => {} : waitMask("正在读取警大邮箱…");
    state.inFlight = call({ force })
      .then((r) => {
        if (state.disposed) return;
        if (!r.ok) {
          state.needLogin = Boolean(r.needLogin);
          state.error = r.error || "警大邮箱暂时取不到";
          state.stale = state.mails.length ? "刷新失败，下面是上次取到的邮件。" : "";
          return;
        }
        const mails = Array.isArray(r.mails) ? r.mails.filter((x) => x && typeof x === "object") : [];
        state.mails = mails;
        state.unread = Math.max(0, num(r.unread) || mails.filter((m) => !m.read).length);
        state.total = Math.max(0, num(r.total) || mails.length);
        state.account = clean(r.account) || state.account;
        state.loadedAt = num(r.syncedAt) || Date.now();
        state.needLogin = false;
        state.visible = PAGE;
        persist();
      })
      .catch((e) => { state.error = e?.message || "取数失败"; })
      .finally(() => {
        state.inFlight = 0;
        state.loading = false;
        releaseWait();
        if (!state.disposed) paint();
      });
    return state.inFlight;
  }

  /* ── 视图 ─────────────────────────────────────────────────────────────── */
  function visibleMails() {
    const rows = state.filter === "unread" ? state.mails.filter((m) => !m.read) : state.mails;
    return rows;
  }

  function toolbarHtml() {
    const badge = state.needLogin
      ? '<span class="ml-badge warn">未登录</span>'
      : state.loadedAt
        ? '<span class="ml-badge on">已登录</span>'
        : '<span class="ml-badge">未同步</span>';
    const synced = state.loadedAt ? `同步于 ${fmtSynced(state.loadedAt)}` : "";
    return `<div class="ml-card ml-sec"><div class="ml-bar">
<span class="ml-who"><b>${esc(state.account || "警大邮箱")}</b>${badge}${synced ? `<span class="ml-sub">${esc(synced)}</span>` : ""}</span>
<div class="ml-right">
<div class="ml-tabs" data-ml-tabs role="group" aria-label="筛选">
<button type="button" data-ml-filter="all" aria-pressed="${state.filter === "all" ? "true" : "false"}">全部</button>
<button type="button" data-ml-filter="unread" aria-pressed="${state.filter === "unread" ? "true" : "false"}">只看未读</button>
</div>
<button class="ml-btn" type="button" data-ml-refresh${state.loading ? " disabled" : ""}>刷新</button>
<button class="ml-btn ml-primary" type="button" data-ml-open>打开邮箱</button>
</div></div></div>`;
  }

  function statsHtml() {
    const cards = [
      ["未读", String(state.unread), "封", state.unread ? "新邮件还没读" : "没有未读"],
      ["收件箱", String(state.total), "封", state.mails.length && state.total > state.mails.length ? `已取回最近 ${state.mails.length} 封` : ""],
    ];
    return `<div class="ml-stats">${cards.map(([k, v, u, sub]) => `<div class="ml-stat"><small>${esc(k)}</small><strong>${esc(v)}<em>${esc(u)}</em></strong>${sub ? `<span class="ml-cardsub">${esc(sub)}</span>` : ""}</div>`).join("")}</div>`;
  }

  function rowHtml(m) {
    const size = fmtBytes(m.size);
    return `<li class="ml-row${m.read ? "" : " unread"}"><button class="ml-hit" type="button" data-ml-open="${esc(m.id)}" title="在应用内邮箱窗口打开">
<span class="ml-dot" aria-hidden="true"></span>
<span class="ml-body"><span class="ml-head"><b>${esc(m.from || "未知发件人")}</b><i>${esc(fmtWhen(m.date))}${size ? `<em class="ml-size">${esc(size)}</em>` : ""}</i></span>
<span class="ml-subj">${esc(m.subject || "(无主题)")}</span></span>
</button></li>`;
  }

  function listHtml() {
    const rows = visibleMails();
    if (!rows.length) {
      return `<div class="ml-empty">${state.filter === "unread"
        ? "收件箱里没有未读邮件。"
        : state.mails.length
          ? "收件箱是空的。"
          : "没有取到邮件。会话是通的但列表为空 —— 可能是邮箱里确实没有信，也可能是站点改了返回结构。"}</div>`;
    }
    const shown = rows.slice(0, state.visible);
    const more = rows.length > state.visible
      ? `<div class="ml-more"><button class="ml-btn" type="button" data-ml-more>再显示 ${Math.min(PAGE, rows.length - state.visible)} 封（还有 ${rows.length - state.visible} 封）</button></div>`
      : "";
    return `<ul class="ml-rows">${shown.map(rowHtml).join("")}</ul>${more}`;
  }

  function paint() {
    const root = state.root;
    if (!root || state.disposed) return;
    const hasRows = state.mails.length > 0;
    if (state.loading && !state.loadedAt) {
      root.innerHTML = `<div class="ml-wrap">${toolbarHtml()}<div class="ml-card"><div class="ml-loading">正在用警大通知保存的账号密码登录邮箱…</div></div></div>`;
      bind(root);
      return;
    }
    if (state.error && !hasRows) {
      root.innerHTML = `<div class="ml-wrap">${toolbarHtml()}
<div class="ml-card ml-sec"><div class="ml-alert"><b>${state.needLogin ? "需要先登录一次警大邮箱" : "邮箱暂时取不到"}</b><br>${esc(state.error)}
<div class="ml-actions"><button class="ml-btn ml-primary" type="button" data-ml-relogin>重新登录</button><button class="ml-btn" type="button" data-ml-open>在邮箱窗口里登录</button></div></div></div>
<p class="ml-note">本页用的是「警大通知」里保存的账号密码自动登录（含验证码识别）；没勾选记住密码、或站点要求短信/动态码时会走到这一步。手动在邮箱窗口登录一次后，本页刷新即可复用同一套 Cookie。</p></div>`;
      bind(root);
      return;
    }
    root.innerHTML = `<div class="ml-wrap">
${toolbarHtml()}
${state.stale ? `<div class="ml-card ml-sec"><div class="ml-alert">${esc(state.stale)}</div></div>` : ""}
<div class="ml-card">${statsHtml()}</div>
<div class="ml-card ml-sec"><header><h3>收件箱</h3><span class="ml-sub">${esc(visibleMails().length ? `${visibleMails().length} 封` : "")}</span></header>
${listHtml()}
<p class="ml-note">只读最近 ${PAGE} 封的信头（发件人 / 主题 / 时间），正文不在本页展开 —— 点任意一封会在应用内邮箱窗口打开，登录态由原生端注入，账号密码不经过页面。数据来自 mail.cppu.edu.cn 的 mbox 接口，不是本机缓存。</p></div></div>`;
    bind(root);
  }

  /* ── 交互 ─────────────────────────────────────────────────────────────── */
  function attachGlow(root) {
    for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    const box = root.querySelector?.("[data-ml-tabs]");
    if (!box) return;
    let handle = null;
    try { handle = tide.ui?.selectionGlow?.(box, { selector: 'button[aria-pressed="true"]' }) || null; } catch { handle = null; }
    if (handle) glowHandles.push(handle);
  }

  function bind(root) {
    const on = (sel, fn) => { const n = root.querySelector(sel); if (n) n.onclick = fn; };
    on("[data-ml-refresh]", (e) => { if (!state.loading) load(true); else e?.preventDefault?.(); });
    on("[data-ml-relogin]", () => load(true));
    /* 「再显示」重绘整页而不是替换列表：筛选组的光块挂在工具条上，
       局部替换会把 .ml-rows 的父节点换掉、光块句柄却还指向旧节点。整页重绘由 paint 统一重绑。 */
    on("[data-ml-more]", () => {
      state.visible += PAGE;
      paint();
    });
    /* 单选：只切 aria-pressed，让宿主的光块自己滑过去（重建 DOM 会把光块变成孤儿）。 */
    for (const btn of root.querySelectorAll("[data-ml-filter]")) {
      btn.onclick = () => {
        const id = btn.dataset.mlFilter;
        if (!id || state.filter === id) return;
        state.filter = id;
        for (const b of root.querySelectorAll("[data-ml-filter]")) b.setAttribute("aria-pressed", b.dataset.mlFilter === id ? "true" : "false");
        state.visible = PAGE;
        persist();
        paint();
      };
    }
    for (const btn of root.querySelectorAll("[data-ml-open]")) {
      btn.onclick = () => openMail(btn);
    }
    attachGlow(root);
  }

  function persist() {
    try {
      tide.storage?.set?.(KEY, {
        filter: state.filter,
        account: state.account,
        unread: state.unread,
        total: state.total,
        loadedAt: state.loadedAt,
        mails: state.mails.slice(0, PAGE),
      });
    } catch { /* ignore */ }
  }

  function render(host) {
    state.disposed = false;
    state.root = host;
    styles();
    host.innerHTML = `<div class="ml-wrap"><div class="ml-card"><div class="ml-loading">正在读取警大邮箱…</div></div></div>`;
    Promise.resolve(tide.storage?.get?.(KEY, null)).then((saved) => {
      if (state.disposed) return;
      if (!saved || typeof saved !== "object") return;
      if (saved.filter === "all" || saved.filter === "unread") state.filter = saved.filter;
      state.account = clean(saved.account) || "";
      state.unread = num(saved.unread);
      state.total = num(saved.total);
      state.loadedAt = num(saved.loadedAt);
      state.mails = Array.isArray(saved.mails) ? saved.mails.filter((m) => m && typeof m === "object") : [];
    }).catch(() => {}).finally(() => { if (!state.disposed) load(); });
    return () => {
      state.disposed = true;
      state.root = null;
      for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    };
  }

  return { render, refresh: () => load(true) };
}
