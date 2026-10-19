// 警大门户通知 · 上网记录（drcom.cppu.edu.cn/bill/userOnlineLog）
//
// 独立界面，不照搬网页：Dr.COM 自助服务系统那页是 bootstrap-table 的整站风格，
// 一屏只有一张 10 行的表 + 一个 60 天的日期选择框，塞进插件只会变成更窄的浏览器。
// 这里按 U-Time 的卡片语言重排成三块：
//   ① 概览（在线时长 / 流量 / 费用 / 上网次数，来自接口自带的 summary）
//   ② 每日分布（按本地日期聚合的细条，一眼看出哪天挂得多）
//   ③ 明细（按天分组，点一行展开国际/国内上下行、MAC、NAS）
//
// 边界：本模块**不碰**账号、密码、vault、Cookie、验证码 —— 那是 main.js 的事。
// 一切取数走 bridge.logs({start,end,force})，drcom 的登录（含验证码识别与重试）
// 与 ≤60 天分段都在那边；本模块只认「拿到 data / 没拿到」两种结果。
//
// 口径（实测 /bill/getUserOnlineLog 的返回，别自己发明字段）：
//   loginTime / logoutTime 毫秒时间戳；time 单位分钟；costMoney 元；
//   flow 恒为 0（真实流量在 internetUp/DownFlow 与 chinanetUp/DownFlow，单位 MB）；
//   summary 按**整个查询区间**汇总，键名是大写：TIME / COSTMONEY / COU /
//   INTERNETUPFLOW / INTERNETDOWNFLOW / CHINANETUPFLOW / CHINANETDOWNFLOW。

export function createNetLogView(tide, bridge) {
  const KEY = "netLogViewPreferences";
  const MAX_SPAN = 60;   // 服务端 daterangepicker 的 dateLimit：一次查询最多 60 天
  const SLICE = 40;      // 明细「再显示 N 条」的步长
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

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const shiftDay = (dayStr, n) => {
    if (tide.util?.addDays) {
      try { return tide.util.addDays(dayStr, n); } catch { /* 落到下面自己算 */ }
    }
    const [y, m, d] = String(dayStr).split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, (d || 1) + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };

  /* 秒级时间戳也照收：接口给的是毫秒，但换成秒级时不能整屏变成 1970。 */
  const toDate = (v) => {
    const n = num(v);
    if (!n) return null;
    return new Date(n > 1e11 ? n : n * 1000);
  };
  const hhmm = (dt) => (dt ? `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}` : "");
  const dayKey = (dt) => (dt ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}` : "");
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const dayLabel = (key) => {
    const m = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(key);
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = todayStr();
    if (key === today) return "今天";
    if (key === shiftDay(today, -1)) return "昨天";
    return `${m[2]}-${m[3]} ${WEEK[dt.getDay()]}`;
  };

  const mb = (v) => num(v);
  const fmtSize = (v) => {
    const n = mb(v);
    if (n >= 1024) return `${(n / 1024).toFixed(n >= 10240 ? 1 : 2)} GB`;
    if (n >= 1) return `${n.toFixed(n >= 100 ? 0 : 1)} MB`;
    if (n > 0) return `${Math.round(n * 1024)} KB`;
    return "0 MB";
  };
  const fmtDur = (v) => {
    const m = Math.round(num(v));
    if (m <= 0) return "0 分钟";
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h && mm) return `${h} 小时 ${mm} 分`;
    if (h) return `${h} 小时`;
    return `${mm} 分钟`;
  };
  /* 分钟数的两种折算：小时 h 与天 d。给「1 小时 46 分」这类可读形式配一行机读值，
     长时段（一整天挂机）与跨月的对话才好横向比。 */
  const fmtHours = (v) => {
    const h = num(v) / 60;
    if (h <= 0) return "0h";
    if (h >= 100) return `${Math.round(h)}h`;
    return `${h.toFixed(2).replace(/\.?0+$/, "")}h`;
  };
  const fmtDays = (v) => {
    const d = num(v) / 1440;
    if (d <= 0) return "0d";
    return `${d.toFixed(2)}d`;
  };
  const fmtMoney = (v) => {
    const n = num(v);
    return n > 0 ? `¥${n.toFixed(2)}` : "¥0.00";
  };

  /* 一条记录的总流量 = 国际 + 国内，上下行都算（flow 是历史字段，恒 0，别拿它当总量）。 */
  const rowTotal = (r) => mb(r.internetUpFlow) + mb(r.internetDownFlow) + mb(r.chinanetUpFlow) + mb(r.chinanetDownFlow);
  const rowUp = (r) => mb(r.internetUpFlow) + mb(r.chinanetUpFlow);
  const rowDown = (r) => mb(r.internetDownFlow) + mb(r.chinanetDownFlow);

  const state = {
    root: null, disposed: false, loading: false, error: "", needLogin: false, stale: "",
    range: "30", customStart: "", customEnd: "", customOpen: false,
    rows: [], summary: null, span: null, expanded: new Set(), visible: SLICE,
    loadedAt: 0, inFlight: 0, user: "",
  };
  const glowHandles = [];

  /* ── 样式 ──────────────────────────────────────────────────────────────
     安全区：本模块只画 [data-nlog-host] 里的内容，四条边由宿主 .view 负责，
     这里**不垫第二遍**（本模块也不做任何脱离文档流的浮层）。 */
  function styles() {
    if (typeof document === "undefined" || document.getElementById("nlog-style")) return;
    const node = document.createElement("style");
    node.id = "nlog-style";
    node.textContent = `.nlog-wrap{max-width:900px;margin:0 auto;display:grid;gap:14px}
.nlog-card{border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--panel);color:var(--ink);overflow:hidden}
.nlog-sec{padding:15px 16px}
.nlog-sec>header{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.nlog-sec h3{margin:0;font-size:calc(15px * var(--ui-text-scale));letter-spacing:.02em}
.nlog-sec>header .nlog-sub{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);white-space:nowrap;font-variant-numeric:tabular-nums}
/* 工具条：区段单选（铁律六的光块由宿主 selectionGlow.js 画）+ 刷新 */
.nlog-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.nlog-tabs{display:inline-flex;position:relative;isolation:isolate;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
.nlog-tabs .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;transition:opacity .2s linear;border-radius:10px;background:var(--deep,#0F4C5C)}
.nlog-tabs .selection-glow.on{opacity:1}
.nlog-tabs.has-selection-glow button{position:relative;z-index:1}
.nlog-tabs.has-selection-glow button[aria-pressed=true]{background:transparent}
.nlog-tabs button{font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:inherit;background:transparent;border:0;padding:8px 13px;min-height:36px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,color .18s ease;white-space:nowrap}
.nlog-tabs button+button{border-left:1px solid var(--line)}
.nlog-tabs button[aria-pressed=true]{background:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.nlog-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 13px;min-height:36px;cursor:pointer;touch-action:manipulation}
.nlog-btn.nlog-primary{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.nlog-btn:disabled{opacity:.5;cursor:default}
.nlog-when{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
/* 自定义区间：铁律七 —— 展开与收起都走 grid-template-rows 0fr↔1fr，中间帧连续 */
.nlog-cwrap{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .34s cubic-bezier(.2,.8,.2,1),opacity .22s ease}
.nlog-cwrap.open{grid-template-rows:1fr;opacity:1}
.nlog-cwrap[hidden]{display:none}
.nlog-cclip{min-height:0;overflow:hidden}
.nlog-custom{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:12px 14px;margin-top:10px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel))}
.nlog-custom label{display:inline-flex;align-items:center;gap:6px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)}
.nlog-custom input{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:7px 9px;min-height:34px;color-scheme:light dark}
.nlog-custom .nlog-hint{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);margin-left:auto}
/* ① 概览 */
.nlog-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:15px 16px 0}
.nlog-stat{border:1px solid var(--line);border-radius:12px;padding:11px 13px;background:color-mix(in srgb,var(--deep,#0F4C5C) 5%,var(--panel))}
.nlog-stat small{display:block;font-size:calc(11px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66));margin-bottom:6px;white-space:nowrap}
.nlog-stat strong{font-size:calc(19px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;color:var(--deep,#0F4C5C);overflow-wrap:anywhere}
.nlog-stat em{font-style:normal;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-left:3px}
.nlog-stat .nlog-cardsub{display:block;margin-top:4px;font-size:calc(10.5px * var(--ui-text-scale));line-height:1.45;color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66));font-variant-numeric:tabular-nums;white-space:normal}
/* ② 每日分布 */
.nlog-daily{display:grid;gap:6px;padding:14px 16px 16px}
.nlog-day{display:grid;grid-template-columns:96px 1fr auto;align-items:center;gap:10px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)}
.nlog-day b{font-weight:600;color:var(--ink);white-space:nowrap}
.nlog-track{position:relative;height:9px;border-radius:999px;background:color-mix(in srgb,var(--ink,#22303A) 8%,var(--panel));overflow:hidden}
.nlog-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--sea,#118AB2) 78%,var(--deep,#0F4C5C)),var(--deep,#0F4C5C));min-width:3px;transition:width .3s ease}
.nlog-day span{font-variant-numeric:tabular-nums;white-space:nowrap;color:color-mix(in srgb,var(--ink,#22303A) 82%,var(--ink-2,#4A5A66))}
/* ③ 明细 */
.nlog-daygroup+ .nlog-daygroup{margin-top:12px}
.nlog-ghead{display:flex;align-items:baseline;gap:9px;padding:0 2px 7px;border-bottom:1px solid var(--line);font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)}
.nlog-ghead b{font-size:calc(12.5px * var(--ui-text-scale));font-weight:600;color:var(--ink)}
.nlog-ghead span{margin-left:auto;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--ink,#22303A) 82%,var(--ink-2,#4A5A66));white-space:nowrap}
.nlog-rows{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:6px}
.nlog-row{border:1px solid var(--line);border-radius:11px;background:var(--panel);overflow:hidden}
.nlog-hit{display:grid;grid-template-columns:1fr auto;gap:4px 12px;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:9px 12px;min-height:44px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.nlog-hit:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 6%,var(--panel))}
.nlog-hit:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.nlog-hit .nlog-when2{font-size:calc(12.5px * var(--ui-text-scale));font-variant-numeric:tabular-nums;color:var(--ink)}
.nlog-hit .nlog-flow{font-size:calc(12px * var(--ui-text-scale));font-weight:600;color:var(--deep,#0F4C5C);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.nlog-hit .nlog-meta2{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.nlog-hit .nlog-alt{display:block;margin-top:1px;font-style:normal;font-size:calc(10px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 68%,var(--ink-2,#4A5A66))}
.nlog-hit .nlog-chev{display:inline-block;transition:transform .3s cubic-bezier(.2,.78,.2,1);color:var(--ink-3,#7E8B94);margin-left:5px}
.nlog-row.open .nlog-chev{transform:rotate(90deg)}
.nlog-fold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .2s ease}
.nlog-row.open .nlog-fold{grid-template-rows:1fr;opacity:1}
.nlog-clip{min-height:0;overflow:hidden}
.nlog-detail{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px 14px;padding:2px 12px 12px;border-top:1px solid var(--line);margin-top:2px}
.nlog-detail div{min-width:0}
.nlog-detail small{display:block;font-size:calc(10.5px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66));margin-bottom:2px}
.nlog-detail b{font-weight:600;font-size:calc(12px * var(--ui-text-scale));font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.nlog-more{display:flex;justify-content:center;padding:12px 0 0}
.nlog-empty{border:1px dashed var(--line);border-radius:11px;padding:18px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12px * var(--ui-text-scale));line-height:1.85}
.nlog-loading{padding:26px 16px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12.5px * var(--ui-text-scale))}
.nlog-alert{border:1px solid color-mix(in srgb,var(--danger,#B03535) 42%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 8%,var(--panel));border-radius:11px;padding:12px 14px;font-size:calc(12px * var(--ui-text-scale));line-height:1.85;color:var(--ink)}
.nlog-note{margin:0;font-size:calc(11px * var(--ui-text-scale));line-height:1.85;color:var(--ink-3,#7E8B94)}
@media(max-width:760px){.nlog-stats{grid-template-columns:repeat(2,1fr)}}
@media(max-width:440px){
.nlog-tabs button{padding:8px 10px;font-size:calc(12px * var(--ui-text-scale))}
.nlog-day{grid-template-columns:78px 1fr auto}
.nlog-detail{grid-template-columns:1fr 1fr}
.nlog-when{display:none}
}
@media(prefers-reduced-motion:reduce){.nlog-cwrap,.nlog-fold,.nlog-hit .nlog-chev,.nlog-fill,.nlog-tabs button{transition-duration:.01ms!important}}`;
    document.head.append(node);
  }

  /* ── 取数 ────────────────────────────────────────────────────────────── */
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});

  function rangeBounds() {
    const today = todayStr();
    const end = state.range === "custom" ? (state.customEnd || today) : today;
    if (state.range !== "custom") {
      const days = state.range === "7" ? 7 : state.range === "60" ? MAX_SPAN : 30;
      return { start: shiftDay(end, -(days - 1)), end };
    }
    let start = state.customStart || shiftDay(end, -29);
    if (start > end) start = end;
    const floor = shiftDay(end, -(MAX_SPAN - 1));
    if (start < floor) start = floor;
    return { start, end };
  }

  const call = (params) => Promise.resolve(bridge?.logs?.(params))
    .then((r) => (r && typeof r === "object" ? r : { ok: false, message: "取数通道不可用" }))
    .catch((e) => ({ ok: false, message: e?.message || "取数失败" }));

  function load(force = false) {
    if (state.inFlight) return state.inFlight;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < FRESH_MS) {
      paint();
      return Promise.resolve();
    }
    const bounds = rangeBounds();
    state.span = bounds;
    state.loading = true;
    state.error = "";
    state.stale = "";
    const releaseWait = state.loadedAt ? () => {} : waitMask("正在读取上网记录…");
    state.inFlight = call({ ...bounds, force })
      .then((r) => {
        if (state.disposed) return;
        if (!r.ok) {
          state.needLogin = Boolean(r.needLogin);
          state.error = r.message || "上网记录暂时取不到";
          if (!state.rows.length) { state.rows = []; state.summary = null; }
          state.stale = state.rows.length ? "刷新失败，下面是上次取到的记录。" : "";
          return;
        }
        const data = r.data && typeof r.data === "object" ? r.data : {};
        const rows = Array.isArray(data.rows) ? data.rows.filter((x) => x && typeof x === "object") : [];
        state.rows = rows;
        state.summary = data.summary && typeof data.summary === "object" ? data.summary : null;
        state.user = clean(data.userName) || state.user;
        state.loadedAt = Date.now();
        state.expanded.clear();
        state.visible = SLICE;
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

  /* ── 派生数据 ─────────────────────────────────────────────────────────── */
  /* 每条记录先解析出本地日期与时刻，之后概览 / 每日条 / 明细三处共用同一份，
     避免三遍各自 new Date（几百行时没必要）。 */
  function decorated() {
    return state.rows.map((raw, i) => {
      const login = toDate(raw.loginTime);
      const logout = toDate(raw.logoutTime);
      return {
        key: `${clean(raw.loginTime) || i}-${i}`,
        seq: i + 1,
        login, logout,
        day: dayKey(login),
        minutes: num(raw.time),
        flow: num(raw.flow),
        up: rowUp(raw), down: rowDown(raw), total: rowTotal(raw),
        cost: num(raw.costMoney),
        ip: clean(raw.userIp),
        mac: clean(raw.macAddress),
        nas: clean(raw.nasIp),
        port: clean(raw.nasPort),
        place: clean(raw.userAddress) || clean(raw.area),
        intraUp: num(raw.internetUpFlow), intraDown: num(raw.internetDownFlow),
        cnUp: num(raw.chinanetUpFlow), cnDown: num(raw.chinanetDownFlow),
        extra: clean(raw.extend),
      };
    });
  }

  /* 区间汇总按网页页脚的字段口径拆开：国际 / 国内各自上下行，加上 flow 原值。
     多段拉取时 drcom 不给 summary（各段各自的汇总不能相加成整区间），改走 rows 累加。 */
  function totals(rows) {
    const s = state.summary;
    const valid = s && (num(s.COU) || num(s.TIME) || num(s.INTERNETUPFLOW) || num(s.CHINANETUPFLOW));
    const sums = valid
      ? {
        minutes: num(s.TIME),
        intraUp: num(s.INTERNETUPFLOW), intraDown: num(s.INTERNETDOWNFLOW),
        cnUp: num(s.CHINANETUPFLOW), cnDown: num(s.CHINANETDOWNFLOW),
        flow: num(s.FLOW),
        cost: num(s.COSTMONEY),
        count: num(s.COU) || rows.length,
      }
      : { minutes: 0, intraUp: 0, intraDown: 0, cnUp: 0, cnDown: 0, flow: 0, cost: 0, count: rows.length };
    sums.up = sums.intraUp + sums.cnUp;
    sums.down = sums.intraDown + sums.cnDown;
    if (!sums.minutes && !sums.up && !sums.down && rows.length) {
      for (const r of rows) {
        sums.minutes += r.minutes;
        sums.intraUp += r.intraUp; sums.intraDown += r.intraDown;
        sums.cnUp += r.cnUp; sums.cnDown += r.cnDown;
        sums.flow += r.flow;
        sums.cost += r.cost;
      }
      sums.up = sums.intraUp + sums.cnUp;
      sums.down = sums.intraDown + sums.cnDown;
      sums.count = rows.length;
    }
    return sums;
  }

  function dayGroups(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.day)) map.set(r.day, { day: r.day, rows: [], minutes: 0, total: 0, count: 0 });
      const g = map.get(r.day);
      g.rows.push(r);
      g.minutes += r.minutes;
      g.total += r.total;
      g.count += 1;
    }
    return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */
  function toolbarHtml() {
    const tabs = [
      { id: "7", label: "近 7 天" },
      { id: "30", label: "近 30 天" },
      { id: "60", label: "近 60 天" },
      { id: "custom", label: "自定义" },
    ].map((t) => `<button type="button" data-nlog-range="${t.id}" aria-pressed="${state.range === t.id ? "true" : "false"}">${t.label}</button>`).join("");
    const when = state.loadedAt
      ? `更新于 ${new Date(state.loadedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "";
    return `<div class="nlog-bar"><div class="nlog-tabs" data-nlog-tabs>${tabs}</div>
<button class="nlog-btn" type="button" data-nlog-refresh${state.loading ? " disabled" : ""}>${state.loading ? "刷新中…" : "刷新"}</button>
<span class="nlog-when">${esc(when)}</span></div>
${customHtml()}`;
  }

  function customHtml() {
    const end = state.customEnd || todayStr();
    const start = state.customStart || shiftDay(end, -29);
    const open = state.range === "custom";
    return `<div class="nlog-cwrap${open ? " open" : ""}" data-nlog-custom-wrap>
<div class="nlog-cclip"><div class="nlog-custom">
<label>起<input type="date" data-nlog-start value="${esc(start)}" max="${esc(todayStr())}"></label>
<label>止<input type="date" data-nlog-end value="${esc(end)}" max="${esc(todayStr())}"></label>
<button class="nlog-btn nlog-primary" type="button" data-nlog-apply>查询</button>
<span class="nlog-hint">一次最多 60 天</span>
</div></div></div>`;
  }

  function statsHtml(rows) {
    const t = totals(rows);
    /* 总流量 = 国际 + 国内；两者各自上下行只在副行出现一次，明细里不再逐条重复汇总。 */
    const cards = [
      { k: "在线时长", v: fmtDur(t.minutes) },
      {
        k: "总流量",
        v: fmtSize(t.up + t.down),
        sub: [`国际 ↑${fmtSize(t.intraUp)} ↓${fmtSize(t.intraDown)}`, `国内 ↑${fmtSize(t.cnUp)} ↓${fmtSize(t.cnDown)}`],
      },
      { k: "计费金额", v: fmtMoney(t.cost) },
      { k: "上网次数", v: String(t.count || 0), u: "次" },
    ];
    return `<div class="nlog-stats">${cards.map((c) => `<div class="nlog-stat"><small>${esc(c.k)}</small><strong>${esc(c.v)}${c.u ? `<em>${esc(c.u)}</em>` : ""}</strong>${Array.isArray(c.sub) ? `<span class="nlog-cardsub">${c.sub.map((s) => esc(s)).join("<br>")}</span>` : ""}</div>`).join("")}</div>`;
  }

  function dailyHtml(rows) {
    const groups = dayGroups(rows);
    if (!groups.length) return "";
    const top = Math.max(...groups.map((g) => g.total), 1);
    return `<div class="nlog-daily">${groups.slice(0, 14).map((g) => {
      const pct = Math.max(2, Math.round((g.total / top) * 100));
      return `<div class="nlog-day"><b>${esc(dayLabel(g.day))}</b>
<span class="nlog-track"><i class="nlog-fill" style="width:${pct}%"></i></span>
<span>${esc(fmtSize(g.total))}</span></div>`;
    }).join("")}</div>`;
  }

  /* 明细列序对齐网页 /bill/userOnlineLog 的表格：序号 / 上线时间 / 下线时间 / 使用时长 /
     使用流量(flow 原值) / 国际上下行 / 国内上下行 / 登录所在 IP / NASIP / NASPORT / 计费金额。
     MAC、位置、备注是网页没有、接口多给的三项，排在最后。
     去重口径：行内只放「时段 · 合计流量 · 使用时长」三样，明细里同一事实不再出现第二遍；
     网页的「使用流量」是 flow 字段（恒为 0），与合计流量不是同一个量，所以两处都留着并标清来源。 */
  function rowHtml(r, open) {
    const span = r.logout && r.logout > r.login
      ? `${hhmm(r.login)} → ${hhmm(r.logout)}`
      : `${hhmm(r.login)} → 在线`;
    const details = [
      ["序号", `#${r.seq}`],
      ["上线时间", `${r.day} ${hhmm(r.login)}`],
      ["下线时间", r.logout ? `${dayKey(r.logout)} ${hhmm(r.logout)}` : "尚未下线"],
      ["使用流量（网页原值）", fmtSize(r.flow)],
      ["国际上行流量", fmtSize(r.intraUp)],
      ["国际下行流量", fmtSize(r.intraDown)],
      ["国内上行流量", fmtSize(r.cnUp)],
      ["国内下行流量", fmtSize(r.cnDown)],
      ["登录所在 IP", r.ip || "—"],
      ["NASIP", r.nas || "—"],
      ["NASPORT", r.port || "—"],
      ["计费金额", fmtMoney(r.cost)],
    ];
    if (r.mac) details.push(["MAC", r.mac]);
    if (r.place) details.push(["位置", r.place]);
    if (r.extra) details.push(["备注", r.extra]);
    return `<li class="nlog-row${open ? " open" : ""}" data-nlog-row="${esc(r.key)}">
<button class="nlog-hit" type="button" data-nlog-hit="${esc(r.key)}" aria-expanded="${open ? "true" : "false"}">
<span class="nlog-when2">${esc(span)}<i class="nlog-chev" aria-hidden="true">›</i></span>
<span class="nlog-flow">${esc(fmtSize(r.total))}</span>
<span class="nlog-meta2">${esc(fmtDur(r.minutes))}<i class="nlog-alt">${esc(`${fmtHours(r.minutes)} · ${fmtDays(r.minutes)}`)}</i></span>
</button>
<div class="nlog-fold" aria-hidden="${open ? "false" : "true"}"><div class="nlog-clip"><div class="nlog-detail">
${details.map(([k, v]) => `<div><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join("")}
</div></div></div></li>`;
  }

  function listHtml(rows) {
    if (!rows.length) {
      const span = state.span ? `${state.span.start} 至 ${state.span.end}` : "";
      return `<div class="nlog-empty">这段时间没有上网记录${span ? `（${esc(span)}）` : ""}。<br>校园网未登录、或只用了手机流量时都是这样。</div>`;
    }
    const groups = dayGroups(rows);
    let used = 0;
    const blocks = [];
    for (const g of groups) {
      if (used >= state.visible) break;
      const take = g.rows.slice(0, Math.max(0, state.visible - used));
      used += take.length;
      blocks.push(`<div class="nlog-daygroup">
<div class="nlog-ghead"><b>${esc(dayLabel(g.day))}</b><span>${g.count} 次</span></div>
<ul class="nlog-rows">${take.map((r) => rowHtml(r, state.expanded.has(r.key))).join("")}</ul></div>`);
    }
    const more = rows.length > state.visible
      ? `<div class="nlog-more"><button class="nlog-btn" type="button" data-nlog-more>再显示 ${Math.min(SLICE, rows.length - state.visible)} 条（还有 ${rows.length - state.visible} 条）</button></div>`
      : "";
    return blocks.join("") + more;
  }

  function titleSub(rows) {
    if (state.loading && !rows.length) return "正在读取…";
    if (!rows.length) return "";
    return `共 ${rows.length} 条`;
  }

  function paint() {
    const root = state.root;
    if (!root || state.disposed) return;
    const rows = decorated();
    const hadRows = rows.length > 0;
    if (!state.loadedAt && state.loading) {
      root.innerHTML = `<div class="nlog-wrap">${toolbarHtml()}<div class="nlog-card"><div class="nlog-loading">正在读取上网记录…</div></div></div>`;
      bind(root);
      return;
    }
    if (state.error && !hadRows) {
      root.innerHTML = `<div class="nlog-wrap">${toolbarHtml()}
<div class="nlog-card nlog-sec"><div class="nlog-alert"><b>${state.needLogin ? "需要先完成一次登录" : "上网记录暂时取不到"}</b><br>${esc(state.error)}<br>${state.needLogin ? "本页登录用的是「警大通知」里保存的账号密码（drcom 自助服务与统一身份认证同一套）；先在「警大通知」登录一次、并勾选记住密码，再回到本页刷新。" : "校园网 / 代理不通时也会这样，稍后再试。"}</div></div>
<p class="nlog-note">数据来自 Dr.COM 自助服务系统的上网记录页，不是本机抓包。</p></div>`;
      bind(root);
      return;
    }
    const span = state.span ? `${state.span.start} → ${state.span.end}` : "";
    root.innerHTML = `<div class="nlog-wrap">
${toolbarHtml()}
${state.stale ? `<div class="nlog-card nlog-sec"><div class="nlog-alert">${esc(state.stale)}</div></div>` : ""}
<div class="nlog-card">${statsHtml(rows)}${dailyHtml(rows)}</div>
<div class="nlog-card nlog-sec"><header><h3>上网明细</h3><span class="nlog-sub">${esc(titleSub(rows))}</span></header>
<div data-nlog-list>${listHtml(rows)}</div>
<p class="nlog-note">${esc(span ? `区间 ${span}（含起止两天，最长 60 天）。` : "")}时长与流量以自助服务系统记录为准；flow 字段恒为 0，真实用量按国际 / 国内上下行合计。</p></div></div>`;
    bind(root);
  }

  /* ── 交互 ─────────────────────────────────────────────────────────────── */
  function attachGlow(root) {
    for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    const box = root.querySelector?.("[data-nlog-tabs]");
    if (!box) return;
    let handle = null;
    try { handle = tide.ui?.selectionGlow?.(box, { selector: 'button[aria-pressed="true"]' }) || null; } catch { handle = null; }
    if (handle) glowHandles.push(handle);
  }

  /* 展开/收起只切类名与 aria，不重建列表：重建会把刚展开的那行连同过渡一起丢掉。 */
  function toggleRow(root, key) {
    const li = root.querySelector(`[data-nlog-row="${String(key).replace(/["\\]/g, "")}"]`);
    if (!li) return;
    const open = !state.expanded.has(key);
    if (open) state.expanded.add(key); else state.expanded.delete(key);
    li.classList.toggle("open", open);
    const hit = li.querySelector("[data-nlog-hit]");
    if (hit) hit.setAttribute("aria-expanded", open ? "true" : "false");
    const fold = li.querySelector(".nlog-fold");
    if (fold) fold.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function bind(root) {
    const on = (sel, fn) => { const n = root.querySelector(sel); if (n) n.onclick = fn; };
    on("[data-nlog-refresh]", () => load(true));
    on("[data-nlog-more]", () => {
      state.visible += SLICE;
      const host = root.querySelector("[data-nlog-list]");
      if (host) host.innerHTML = listHtml(decorated());
      bindRows(root);
    });
    on("[data-nlog-apply]", () => {
      const s = root.querySelector("[data-nlog-start]");
      const e = root.querySelector("[data-nlog-end]");
      const today = todayStr();
      let start = clean(s?.value) || shiftDay(today, -29);
      let end = clean(e?.value) || today;
      if (end > today) end = today;
      if (start > end) start = end;
      const floor = shiftDay(end, -(MAX_SPAN - 1));
      if (start < floor) start = floor;
      state.customStart = start;
      state.customEnd = end;
      load(true);
    });
    /* 单选：只切 aria-pressed，让宿主的光块自己滑过去（重建 DOM 会把光块变成孤儿）。 */
    for (const btn of root.querySelectorAll("[data-nlog-range]")) {
      btn.onclick = () => {
        const id = btn.dataset.nlogRange;
        if (!id || state.range === id) return;
        state.range = id;
        for (const b of root.querySelectorAll("[data-nlog-range]")) b.setAttribute("aria-pressed", b.dataset.nlogRange === id ? "true" : "false");
        const wrap = root.querySelector("[data-nlog-custom-wrap]");
        if (wrap) wrap.classList.toggle("open", id === "custom");
        persist();
        load(true);
      };
    }
    bindRows(root);
    attachGlow(root);
  }

  function bindRows(root) {
    for (const btn of root.querySelectorAll("[data-nlog-hit]")) {
      btn.onclick = () => toggleRow(root, btn.dataset.nlogHit || "");
    }
  }

  function persist() {
    try {
      tide.storage?.set?.(KEY, { range: state.range, customStart: state.customStart, customEnd: state.customEnd });
    } catch { /* ignore */ }
  }

  function render(host) {
    state.disposed = false;
    state.root = host;
    styles();
    host.innerHTML = `<div class="nlog-wrap"><div class="nlog-card"><div class="nlog-loading">正在读取上网记录…</div></div></div>`;
    Promise.resolve(tide.storage?.get?.(KEY, null)).then((saved) => {
      if (state.disposed) return;
      if (saved && typeof saved === "object") {
        if (["7", "30", "60", "custom"].includes(saved.range)) state.range = saved.range;
        state.customStart = clean(saved.customStart);
        state.customEnd = clean(saved.customEnd);
      }
    }).catch(() => {}).finally(() => { if (!state.disposed) load(); });
    return () => {
      state.disposed = true;
      state.root = null;
      for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
      state.expanded.clear();
    };
  }

  return { render, refresh: () => load(true) };
}
