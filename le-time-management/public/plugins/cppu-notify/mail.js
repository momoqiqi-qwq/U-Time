// 警大门户通知 · 邮箱（mail.cppu.edu.cn / 雪球 Sirius Web）
//
// 独立界面，不照搬网页：Sirius 那套是整站 SPA，侧栏 + 三栏 + 阅读器，塞进插件只会变成
// 一个更窄的浏览器窗口。这里按 U-Time 的卡片语言重排成两块：
//   ① 概览（未读 / 收件箱总数）
//   ② 收件箱（发件人 + 主题 + 时间，最新在最前）；点一封就地展开正文，右上角「在邮箱打开」
//     才跳应用内邮箱窗口
//
// v0.269.0（用户反馈：「点击卡片是展开全文而不是点进邮箱里面，点进邮箱放到右上角」）：
//   卡片本身改成展开/收起正文的开关（正文走 bridge.body(id)，main.js 取 mbox:getMessage
//   并摊成纯文本，按 id 缓存）；跳邮箱降级成卡片右上角那颗小按钮。以前点一下就把人扔出
//   这个界面，只是想知道「这封写了什么」也得先跳窗口、再找那封信。
//
// v0.268.0 三条改动（用户反馈）：
//   ① 「最新的放最前面」—— 服务端段内顺序不可信，本地一律按时间倒排（toDate 解析不出来
//      的垫底，同值保持服务端原序）；缓存恢复的旧数据也走同一条排序。
//   ② 「消息不完全」—— 以前只取第一页 20 条，翻「显示更多」只是把 20 条拆着看。现在
//      按 start/limit 向服务端一页页要，合并去重后一起显示。
//   ③ 「验证码自动复制」—— 识别与写剪贴板都在 main.js（那边才有登录态与后台轮询），
//      本页只放开关与「已复制 · 再复制」的入口；开关是独立开关，不是单选，不套选中光。
//
// 边界：本模块**不碰**账号、密码、vault、Cookie、验证码识别 —— 那是 main.js 的事。
// 一切取数走 bridge.load({force, start, limit})，那边负责用「警大通知」保存的账号密码
// 自动登录（含验证码识别、会话续期），再走 coreremail 的 mbox 接口；本模块只认
// 「拿到 mails / 没拿到」两种结果，以及 needLogin / hasMore 这两个额外信号。
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
  const CODE_SHOW_MS = 30 * 60 * 1000;   // 「已复制」那颗按钮留 30 分钟，之后自己消失

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
    moreFlight: 0,
    loadedAt: 0,
    error: "",
    needLogin: false,
    stale: "",
    account: "",
    unread: 0,
    total: 0,
    mails: [],
    hasMore: false,
    filter: "all",     // all | unread
    autoCopy: true,    // 后台收到验证码自动写剪贴板（独立开关，不是单选）
    copiedCode: "",    // 已复制的验证码（给「再复制」用）
    opened: {},        // id → {status:'loading'|'ok'|'error', text, error}（就地展开的正文）
  };
  const glowHandles = [];

  /* 展开/收起：只认 id 作 key，正文按需向 main.js 要一次（那边自己也缓存，这里保留
     状态是为了重绘后不塌掉 —— 切筛选、刷新都不该把正在读的正文收回去）。 */
  function rowOpen(id) {
    const st = state.opened[id];
    return st && st.status !== "closed" ? st : null;
  }

  function toggleMail(id) {
    const key = String(id || "");
    if (!key) return;
    if (rowOpen(key)) { delete state.opened[key]; paint(); return; }
    state.opened[key] = { status: "loading", text: "", error: "" };
    paint();
    Promise.resolve(bridge?.body?.(key))
      .then((r) => {
        if (state.disposed) return;
        if (!state.opened[key]) return;   // 期间被收起：不再把结果塞回去
        if (!r || r.ok !== true) {
          state.opened[key] = {
            status: "error",
            text: "",
            error: clean(r && r.error) || (r && r.needLogin ? "需要先在邮箱窗口登录一次，再回本页点这一封。" : "读不到这封信的正文。"),
          };
        } else {
          state.opened[key] = { status: "ok", text: String(r.text || ""), error: "", truncated: Boolean(r.truncated) };
        }
        paint();
      })
      .catch((e) => {
        if (state.disposed || !state.opened[key]) return;
        state.opened[key] = { status: "error", text: "", error: clean(e && e.message) || "读不到这封信的正文。" };
        paint();
      });
  }

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

  /* ── 排序 / 合并（v0.268.0）───────────────────────────────────────────────
     服务端段内顺序不可信（实测有部署按 id 升序回），而这一页第一个问题就是「最近来了
     什么信」。所以不论来自接口还是缓存，一律时间倒排：解析不出来的垫底、彼此保持原序
     （带原始下标做稳定排序，同一秒的几封不会每次刷新互相换位）。 */
  const sortMails = (rows) => (Array.isArray(rows) ? rows : [])
    .map((m, i) => ({ m, i, t: toDate(m && m.date) }))
    .sort((a, b) => {
      if (!a.t && !b.t) return a.i - b.i;
      if (!a.t) return 1;
      if (!b.t) return -1;
      const at = a.t.getTime(), bt = b.t.getTime();
      return at === bt ? a.i - b.i : bt - at;
    })
    .map((x) => x.m);

  const mailKey = (m) => String((m && m.id) || "") || `${(m && m.subject) || ""}|${(m && m.date) || ""}`;

  /* 翻下一页时新旧两页会有重叠（期间来了新信，窗口就会错位），按 id 去重后再排一次。 */
  const mergeMails = (oldRows, newRows) => {
    const seen = new Set();
    const all = [];
    for (const m of [...(Array.isArray(oldRows) ? oldRows : []), ...(Array.isArray(newRows) ? newRows : [])]) {
      const k = mailKey(m);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(m);
    }
    return sortMails(all);
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
/* v0.268.0：验证码自动复制是独立开关（不是单选组），所以不套 .ml-tabs / selectionGlow；
   复用宿主 .pp-toggle 的滑杆，只补一个贴住工具条的高度。 */
.ml-wrap .pp-toggle{min-height:36px;flex:none;white-space:nowrap}
.ml-code{font-variant-numeric:tabular-nums;border-color:color-mix(in srgb,var(--sea,#118AB2) 46%,var(--line));background:color-mix(in srgb,var(--sea,#118AB2) 10%,var(--panel))}
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
.ml-row.open{border-color:color-mix(in srgb,var(--deep,#0F4C5C) 30%,var(--line))}
/* v0.269.0：卡片是「展开全文」的开关，右上角单独一颗进邮箱的小按钮（并列，不嵌套）。 */
.ml-top{display:flex;align-items:flex-start;gap:6px}
.ml-hit{display:grid;grid-template-columns:auto 1fr;align-items:flex-start;gap:10px;flex:1 1 auto;min-width:0;box-sizing:border-box;font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:10px 12px;min-height:46px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease}
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
/* 右上角「在邮箱打开」：贴着卡片，不抢信头的点击面积；窄屏也不换行。 */
.ml-open{flex:none;align-self:flex-start;margin:7px 8px 0 0;font:inherit;font-size:calc(10.5px * var(--ui-text-scale));line-height:1.2;color:var(--ml-soft);background:transparent;border:1px solid var(--line);border-radius:8px;padding:4px 8px;min-height:26px;cursor:pointer;white-space:nowrap;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,color .18s ease}
.ml-open:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel));color:var(--ink)}
.ml-open:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:2px}
.ml-open[aria-busy="1"]{opacity:.6}
.ml-row.open .ml-subj{-webkit-line-clamp:unset;display:block}
/* 展开区：正文用 pre-wrap 保留换行（cleanText 已经把 <br>/块级标签换成 \n），
   超过 56vh 自己滚，不让一封信把整页顶到看不见列表。 */
.ml-full{border-top:1px solid var(--line);padding:10px 12px 12px;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel));display:grid;gap:8px;justify-items:start}
.ml-text{margin:0;width:100%;box-sizing:border-box;font:inherit;font-size:calc(12px * var(--ui-text-scale));line-height:1.72;color:var(--ink-2,#4A5A66);white-space:pre-wrap;overflow-wrap:anywhere;max-height:56vh;overflow:auto;-webkit-overflow-scrolling:touch}
.ml-cut{margin:0;font-size:calc(10.5px * var(--ui-text-scale));line-height:1.6;color:var(--ml-dim)}
.ml-bodyerr{border:1px solid color-mix(in srgb,var(--danger,#B03535) 36%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 7%,var(--panel));border-radius:9px;padding:9px 11px;font-size:calc(11.5px * var(--ui-text-scale));line-height:1.75;color:var(--ink);width:100%;box-sizing:border-box}
.ml-loading.sm{padding:8px 0;text-align:left;font-size:calc(11.5px * var(--ui-text-scale))}
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
    state.inFlight = call({ force, start: 0, limit: PAGE })
      .then((r) => {
        if (state.disposed) return;
        if (!r.ok) {
          state.needLogin = Boolean(r.needLogin);
          state.error = r.error || "警大邮箱暂时取不到";
          state.stale = state.mails.length ? "刷新失败，下面是上次取到的邮件。" : "";
          return;
        }
        const mails = sortMails(Array.isArray(r.mails) ? r.mails.filter((x) => x && typeof x === "object") : []);
        state.mails = mails;
        state.unread = Math.max(0, num(r.unread) || mails.filter((m) => !m.read).length);
        state.total = Math.max(0, num(r.total) || mails.length);
        state.account = clean(r.account) || state.account;
        state.loadedAt = num(r.syncedAt) || Date.now();
        state.needLogin = false;
        state.hasMore = r.hasMore !== false && mails.length > 0;
        readAutoCopy();
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

  /* 「加载更早」：向服务端要下一页（start = 已经拿到几条）。以前这里只是把本地那 20 条
     拆着显示，第 21 封起永远看不见 —— 这就是「消息不完全」的根。 */
  function loadMore() {
    if (state.moreFlight || !state.hasMore) return state.moreFlight || Promise.resolve();
    const start = state.mails.length;
    state.stale = "";
    state.moreFlight = call({ start, limit: PAGE })
      .then((r) => {
        if (state.disposed) return;
        if (!r.ok) {
          state.stale = r.needLogin
            ? "读更早的邮件时登录态过期了，点「刷新」重新登录一次。"
            : (r.error || "加载更早的邮件失败。");
          return;
        }
        const rows = Array.isArray(r.mails) ? r.mails.filter((x) => x && typeof x === "object") : [];
        state.mails = mergeMails(state.mails, rows);
        state.hasMore = r.hasMore !== false && rows.length > 0;
        state.loadedAt = num(r.syncedAt) || state.loadedAt;
        if (num(r.total)) state.total = Math.max(state.total, num(r.total));
        if (num(r.unread)) state.unread = num(r.unread);
        persist();
      })
      .catch((e) => { state.stale = e?.message || "加载更早的邮件失败。"; })
      .finally(() => {
        state.moreFlight = 0;
        if (!state.disposed) paint();
      });
    return state.moreFlight;
  }

  /* 开关状态从 main.js 那份 storage 读（那边后台轮询认同一条键，两处不能各存一份）。 */
  function readAutoCopy() {
    Promise.resolve(bridge?.autoCopy?.())
      .then((on) => { if (!state.disposed) { state.autoCopy = on !== false; } })
      .catch(() => {});
  }

  /* 后台复制过的验证码：进页面 / 刷新时把「已复制 · 再复制」补上（30 分钟内有效；
     更早的不显示 —— 那颗按钮的意义就是「刚才那个码」，留太久只会误导）。 */
  function syncCopiedCode() {
    let last = null;
    try { last = bridge?.lastCode?.() || null; } catch { last = null; }
    const code = clean(last && last.code);
    const at = num(last && last.at);
    state.copiedCode = code && (!at || Date.now() - at <= CODE_SHOW_MS) ? code : "";
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
<label class="pp-toggle${state.autoCopy ? " on" : ""}" data-ml-autocopy title="后台收到验证码时自动写进剪贴板（只认 15 分钟内收到的信）"><i></i>验证码自动复制</label>
${state.copiedCode ? `<button class="ml-btn ml-code" type="button" data-ml-code title="再复制一次">已复制 ${esc(state.copiedCode)}</button>` : ""}
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
      ["收件箱", String(state.total), "封", state.mails.length && state.total > state.mails.length ? `已载入 ${state.mails.length} 封，可继续往更早翻` : ""],
    ];
    return `<div class="ml-stats">${cards.map(([k, v, u, sub]) => `<div class="ml-stat"><small>${esc(k)}</small><strong>${esc(v)}<em>${esc(u)}</em></strong>${sub ? `<span class="ml-cardsub">${esc(sub)}</span>` : ""}</div>`).join("")}</div>`;
  }

  /* 一张卡片 = 右上角「在邮箱打开」+ 整块可点的信头（展开/收起）+ 展开后的正文区。
     两个按钮是并列兄弟而不是嵌套 —— 嵌套 <button> 在 HTML 里非法，点了目标会飘。 */
  function rowHtml(m) {
    const id = esc(m.id);
    const size = fmtBytes(m.size);
    const open = rowOpen(String(m.id || ""));
    const body = !open
      ? ""
      : open.status === "loading"
        ? `<div class="ml-full"><div class="ml-loading sm">正在读取正文…</div></div>`
        : open.status === "error"
          ? `<div class="ml-full"><div class="ml-bodyerr">${esc(open.error)}</div>
<button class="ml-btn" type="button" data-ml-open="${id}">在邮箱打开</button></div>`
          : `<div class="ml-full"><pre class="ml-text">${esc(open.text || "(这封信没有正文)")}</pre>
${open.truncated ? '<p class="ml-cut">正文很长，这里只显示前 6 万字 —— 完整内容点「在邮箱打开」。</p>' : ""}
<p class="ml-cut">纯文本，只有正文；附件与样式请到邮箱窗口看。</p></div>`;
    return `<li class="ml-row${m.read ? "" : " unread"}${open ? " open" : ""}">
<div class="ml-top"><button class="ml-hit" type="button" data-ml-toggle="${id}" aria-expanded="${open ? "true" : "false"}" title="${open ? "收起正文" : "展开全文"}">
<span class="ml-dot" aria-hidden="true"></span>
<span class="ml-body"><span class="ml-head"><b>${esc(m.from || "未知发件人")}</b><i>${esc(fmtWhen(m.date))}${size ? `<em class="ml-size">${esc(size)}</em>` : ""}</i></span>
<span class="ml-subj">${esc(m.subject || "(无主题)")}</span></span>
</button><button class="ml-open" type="button" data-ml-open="${id}" title="在应用内邮箱窗口打开这封信">在邮箱打开</button></div>
${body}</li>`;
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
    const more = state.hasMore
      ? `<div class="ml-more"><button class="ml-btn" type="button" data-ml-more${state.moreFlight ? " disabled" : ""}>${state.moreFlight ? "正在加载…" : `加载更早的 ${PAGE} 封`}</button></div>`
      : "";
    return `<ul class="ml-rows">${rows.map(rowHtml).join("")}</ul>${more}`;
  }

  function paint() {
    const root = state.root;
    if (!root || state.disposed) return;
    syncCopiedCode();
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
<div class="ml-card ml-sec"><header><h3>收件箱</h3><span class="ml-sub">${esc(visibleMails().length ? (state.total > state.mails.length ? `${state.mails.length} / ${state.total} 封` : `${state.mails.length} 封`) : "")}</span></header>
${listHtml()}
<p class="ml-note">按时间倒序，最新在最前面；每页 ${PAGE} 封，点「加载更早」继续往以前翻。点任意一封就地展开正文（纯文本），想看原版式、附件就点它右上角的「在邮箱打开」，登录态由原生端注入，账号密码不经过页面。数据来自 mail.cppu.edu.cn 的 mbox 接口，不是本机缓存。</p></div></div>`;
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
    /* 「加载更早」走服务端分页（v0.268.0）。仍然重绘整页而不是替换列表：筛选组的光块
       挂在工具条上，局部替换会把 .ml-rows 的父节点换掉、光块句柄却还指向旧节点。 */
    on("[data-ml-more]", () => { loadMore(); });
    /* 独立开关（不是单选）：点一下翻转 class + 落 storage，交给 main.js 的后台轮询读。
       不做选中光 —— 铁律六只管「同一组里只能选一项」的控件。 */
    const autoEl = root.querySelector("[data-ml-autocopy]");
    if (autoEl) {
      autoEl.onclick = (e) => {
        e?.preventDefault?.();
        state.autoCopy = !state.autoCopy;
        autoEl.classList.toggle("on", state.autoCopy);
        Promise.resolve(bridge?.setAutoCopy?.(state.autoCopy)).catch(() => {});
        persist();
        try {
          tide.notify?.(state.autoCopy
            ? "已开启验证码自动复制：后台收到验证码会直接写进剪贴板"
            : "已关闭验证码自动复制");
        } catch { /* ignore */ }
      };
    }
    on("[data-ml-code]", (btn) => {
      const code = state.copiedCode;
      if (!code) return;
      Promise.resolve(bridge?.copy?.(code))
        .then((ok) => { try { tide.notify?.(ok ? `已复制验证码 ${code}` : `复制 ${code} 失败，请手动选中复制`); } catch { /* ignore */ } })
        .catch(() => {});
      if (btn) btn.blur();
    });
    /* 单选：只切 aria-pressed，让宿主的光块自己滑过去（重建 DOM 会把光块变成孤儿）。 */
    for (const btn of root.querySelectorAll("[data-ml-filter]")) {
      btn.onclick = () => {
        const id = btn.dataset.mlFilter;
        if (!id || state.filter === id) return;
        state.filter = id;
        for (const b of root.querySelectorAll("[data-ml-filter]")) b.setAttribute("aria-pressed", b.dataset.mlFilter === id ? "true" : "false");
        persist();
        paint();
      };
    }
    /* 卡片 = 展开全文（v0.269.0）；跳邮箱只剩右上角那颗小按钮。 */
    for (const btn of root.querySelectorAll("[data-ml-toggle]")) {
      btn.onclick = () => toggleMail(btn.dataset.mlToggle);
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
        autoCopy: state.autoCopy,
        hasMore: state.hasMore,
        // 只落第一页：分页翻到几十条时没必要把整份列表写进 storage（首屏缓存够用）。
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
      if (typeof saved.autoCopy === "boolean") state.autoCopy = saved.autoCopy;
      // 缓存里的顺序也走同一条倒排：老版本存下来的顺序可能是服务端原序（升序）。
      state.mails = sortMails(Array.isArray(saved.mails) ? saved.mails.filter((m) => m && typeof m === "object") : []);
      state.hasMore = saved.hasMore !== false && state.mails.length >= PAGE;
      syncCopiedCode();
    }).catch(() => {}).finally(() => {
      if (state.disposed) return;
      // 开关以 main.js 那份 storage 为准（后台轮询认的就是它），缓存里的值只当首屏兜底。
      readAutoCopy();
      load();
    });
    return () => {
      state.disposed = true;
      state.root = null;
      for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    };
  }

  return { render, refresh: () => load(true) };
}
