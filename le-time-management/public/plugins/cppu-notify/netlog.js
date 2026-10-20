// 警大门户通知 · 上网记录（drcom.cppu.edu.cn/bill/userOnlineLog）
//
// 独立界面，不照搬网页：Dr.COM 自助服务系统那页是 bootstrap-table 的整站风格，
// 一屏只有一张 10 行的表 + 一个 60 天的日期选择框，塞进插件只会变成更窄的浏览器。
// 这里按 U-Time 的卡片语言重排成四块：
//   ① 概览（在线时长 / 流量 / 费用 / 上网次数，来自接口自带的 summary）
//      每张卡一个语义图标 + 一套语义色（--c 由一个类给出，数字与小标题都用它的混色）
//   ② 熬夜（按「夜」合并在线区间，超过学期阈值的部分才计时；春季 22:20 / 冬学期 22:00）
//   ③ 趋势（每日在线时长折线 + 每日流量上下行堆叠柱 + 国际/国内占比条）
//   ④ 明细（按天分组，整块可一键收起、单天也能折叠，两者都是双向动画）
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
  const TREND_DAYS = 14; // 趋势图最多铺 14 个自然日（缺网的日子补 0，不跳过）
  const NIGHT_SHOW = 12; // 熬夜条最多列 12 夜（再往前翻明细看）
  // 一夜只算到「次日 06:00」：冬学期 22:00→06:00 共 8 小时，春季 22:20→06:00 共 7 小时 40 分。
  // 早先按「阈值 + 8 小时」收口，春季会拖到 06:20，和「到凌晨 6 点」的说法对不上。
  // 不设上限的话，挂机两天没下线的那条记录会把「熬夜」算成 30 小时，数值失去意义。
  const NIGHT_END = 30 * 60; // 该夜 00:00 起算 → 次日 06:00

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
  /* 某天 00:00 的本地时间戳（熬夜按「夜」切区间，基准就是这一夜的零点）。 */
  const stampOf = (dayStr) => {
    const m = String(dayStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return 0;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
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

  /* ── 语义图标 ─────────────────────────────────────────────────────────
     内联 SVG：插件视图里取 /icons/... 是静默失败（file:// 或路径不对就一片空白），
     而这几个图标只服务于本页的卡片标题，内联比走图标库更稳。stroke 走 currentColor，
     颜色由所在卡片的 --c 决定。 */
  const ICON = {
    clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4v4.9l3.1 1.8"/>',
    flow: '<path d="M12 3.6v11.6"/><path d="M8.1 11.6 12 15.5l3.9-3.9"/><path d="M4.6 19.4h14.8"/>',
    money: '<path d="M12 3.6v16.8"/><path d="M15.9 7.3H9.7a2.7 2.7 0 0 0 0 5.4h4.6a2.7 2.7 0 0 1 0 5.4H7.7"/>',
    plug: '<path d="M9 3.6v4"/><path d="M15 3.6v4"/><path d="M7.2 7.6h9.6v2.6a4.8 4.8 0 0 1-9.6 0Z"/><path d="M12 15v5.4"/>',
    moon: '<path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8 8.6 8.6 0 1 0 20.2 14.4Z"/>',
    activity: '<path d="M3.4 13h3.2L9.5 5.8l4 12.4 2.7-5.2h4.4"/>',
    bars: '<path d="M5 19.2V10.4"/><path d="M10.3 19.2V4.8"/><path d="M15.7 19.2v-6.2"/><path d="M21 19.2V8.4"/>',
    list: '<path d="M8.4 6.4h11.2"/><path d="M8.4 12h11.2"/><path d="M8.4 17.6h11.2"/><circle cx="4.4" cy="6.4" r=".9"/><circle cx="4.4" cy="12" r=".9"/><circle cx="4.4" cy="17.6" r=".9"/>',
  };
  const svgIcon = (name, cls = "nlog-ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name] || ""}</svg>`;

  /* ── 熬夜口径 ─────────────────────────────────────────────────────────
     **这个指标没有官方定义。** 校园网日志接口只给 loginTime / logoutTime / 时长 / 流量，
     不存在「熬夜」字段，所以下面是本插件自己按在线区间推的口径：
       窗口 = 当晚阈值（春 22:20 / 冬 22:00）→ **次日 06:00**；
       窗口外的在线（比如熬到第二天下午）不计入熬夜时长，只在「最晚下线」里如实显示
       并标注「超出窗口」，避免把 13:17 下线读成「熬夜算到 13:17」。
     学期怎么定：校历（calendar 那份 storage）里存了当前学期名，名字里带「春」按春季、
     带「冬 / 秋」按冬学期；校历没同步过就按月份兜底（2–7 月春季，8 月–次年 1 月冬学期）。
     阈值按**每一夜自己的日期**取，这样 60 天区间跨过学期边界时不会用错阈值。 */
  const SEM = {
    spring: { id: "spring", label: "春季学期", cutoff: 22 * 60 + 20, text: "22:20" },
    winter: { id: "winter", label: "冬学期", cutoff: 22 * 60, text: "22:00" },
  };
  const semOfDay = (dayStr) => {
    const m = Number(String(dayStr || "").slice(5, 7));
    return m >= 2 && m <= 7 ? SEM.spring : SEM.winter;
  };
  const currentSem = () => {
    const name = state.termName;
    if (name) {
      if (/春/.test(name)) return SEM.spring;
      if (/冬|秋/.test(name)) return SEM.winter;
    }
    return semOfDay(todayStr());
  };

  /* 一条记录归属于哪一「夜」：06:00 之前上线的算前一晚（凌晨补网不算新的一夜）。 */
  const nightKeyOf = (dt) => {
    const d = dayKey(dt);
    if (!d) return "";
    return dt.getHours() < 6 ? shiftDay(d, -1) : d;
  };
  /* 分钟 → 时钟（跨零点标「次日」）。熬夜最晚下线常用到。 */
  const clockOf = (min) => {
    const m = Math.max(0, Math.round(num(min)));
    const day = Math.floor(m / 1440);
    const hh = String(Math.floor((m % 1440) / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    return `${day > 0 ? "次日 " : ""}${hh}:${mm}`;
  };

  const state = {
    root: null, disposed: false, loading: false, error: "", needLogin: false, stale: "",
    range: "30", customStart: "", customEnd: "", customOpen: false,
    rows: [], summary: null, span: null, expanded: new Set(), visible: SLICE,
    loadedAt: 0, inFlight: 0, user: "", termName: "",
    detailOpen: true, collapsedDays: new Set(),
    /* 熬夜是唯一按「整个学期」而不是按当前区间统计的一块，独立取一份行数据。 */
    nightOpen: true, nightRows: null, nightLoading: false, nightInFlight: 0, nightLoadedAt: 0,
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
.nlog-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid color-mix(in srgb,var(--ink,#22303A) 16%,var(--line));border-radius:10px;padding:8px 13px;min-height:36px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
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
/* 图标：尺寸与线宽固定，颜色一律 currentColor（由所在卡片的 --c 给） */
.nlog-ico{width:15px;height:15px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
/* ① 概览：每张卡一套语义色 --c，底 / 边 / 字 / 图标全从它派生 */
.nlog-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:15px 16px 0}
.nlog-stat{--c:var(--deep,#0F4C5C);border:1px solid color-mix(in srgb,var(--c) 26%,var(--line));border-radius:12px;padding:11px 13px;background:color-mix(in srgb,var(--c) 8%,var(--panel))}
.nlog-stat.s-time{--c:var(--sea,#118AB2)}
/* 总流量用「绿」：mint 太青、q4 太灰，两者混出来的绿松石才对得上语义，
   且与「在线时长」的 sea（青蓝）色相差约 35°，扫一眼分得开。 */
.nlog-stat.s-flow,.nlog-bar-up,.nlog-sw-up{--flow-c:color-mix(in srgb,var(--mint,#2EC4B6) 58%,var(--q4,#5B8F7B))}
.nlog-stat.s-flow{--c:var(--flow-c)}
.nlog-bar-up{fill:var(--flow-c)}
.nlog-sw-up{color:var(--flow-c)}
.nlog-stat.s-cost{--c:var(--sun,#E0A32E)}
.nlog-stat.s-count{--c:var(--grape,#7B61A8)}
.nlog-stat-hd{display:flex;align-items:center;gap:6px;margin-bottom:6px;color:color-mix(in srgb,var(--c) 72%,var(--ink))}
.nlog-stat-hd small{font-size:calc(11px * var(--ui-text-scale));white-space:nowrap;color:inherit}
.nlog-stat strong{font-size:calc(19px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--c) 58%,var(--ink));overflow-wrap:anywhere}
.nlog-stat em{font-style:normal;font-size:calc(11px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 72%,var(--ink-2,#4A5A66));margin-left:3px}
.nlog-stat .nlog-cardsub{display:block;margin-top:4px;font-size:calc(10.5px * var(--ui-text-scale));line-height:1.45;color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66));font-variant-numeric:tabular-nums;white-space:normal}
/* 流量占比条（国际 / 国内，各自再分上下行） */
.nlog-split{display:grid;gap:8px;padding:13px 16px 16px}
.nlog-split-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:9px;font-size:calc(11px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 80%,var(--ink-2,#4A5A66))}
.nlog-mix{display:flex;height:9px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--ink,#22303A) 8%,var(--panel))}
.nlog-mix i{display:block;height:100%}
.nlog-mix .mix-up{background:var(--sea,#118AB2)}
.nlog-mix .mix-down{background:var(--deep,#0F4C5C)}
.nlog-split-v{font-variant-numeric:tabular-nums;white-space:nowrap}
/* ② 熬夜 */
.nlog-night-top{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:13px}
.nlog-night-big{--c:var(--coral,#E4572E);display:grid;gap:3px}
.nlog-night-big strong{font-size:calc(21px * var(--ui-text-scale));font-weight:600;color:color-mix(in srgb,var(--c) 56%,var(--ink));font-variant-numeric:tabular-nums}
.nlog-night-big small{font-size:calc(11px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 76%,var(--ink-2,#4A5A66))}
.nlog-night-facts{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap;font-size:calc(11.5px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66))}
/* 「最晚下线」超出熬夜窗口时的注脚：不是错误，只是提醒这个时刻没被算进熬夜时长。
   用浅色 chip 而不是裸小字 —— 裸 10px 灰黄在深色底上太小太暗，实测读不清。 */
.nlog-night-facts small.nlog-beyond{margin-left:5px;font-size:calc(10.5px * var(--ui-text-scale));line-height:1.5;padding:0 5px;border-radius:5px;
  color:color-mix(in srgb,var(--sun,#F2A03D) 62%,var(--ink,#22303A));
  background:color-mix(in srgb,var(--sun,#F2A03D) 16%,transparent);
  border:1px solid color-mix(in srgb,var(--sun,#F2A03D) 34%,transparent)}
/* 深色：--sun 在深底上会混灰，文字提亮、底色加重，保证「超出窗口」这枚标签在夜里也读得清 */
[data-theme-mode="dark"] .nlog-night-facts small.nlog-beyond{
  color:color-mix(in srgb,var(--sun,#F2A03D) 88%,#FFFFFF);
  background:color-mix(in srgb,var(--sun,#F2A03D) 26%,transparent);
  border-color:color-mix(in srgb,var(--sun,#F2A03D) 52%,transparent)}
.nlog-night-facts b{color:var(--ink);font-variant-numeric:tabular-nums;font-weight:600}
.nlog-night-list{display:grid;gap:6px}
.nlog-night .nlog-fill{background:linear-gradient(90deg,color-mix(in srgb,var(--coral,#E4572E) 62%,var(--deep,#0F4C5C)),var(--coral,#E4572E))}
.nlog-night>.nlog-night-note{margin-top:9px;font-size:calc(11.5px * var(--ui-text-scale))}
.nlog-night>header .nlog-nightfold{margin-left:8px;flex:0 0 auto}
/* 每日条（熬夜列表复用） */
.nlog-day{display:grid;grid-template-columns:96px minmax(0,1fr) auto;align-items:center;gap:10px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)}
.nlog-day b{font-weight:600;color:var(--ink);white-space:nowrap}
.nlog-track{position:relative;height:9px;border-radius:999px;background:color-mix(in srgb,var(--ink,#22303A) 8%,var(--panel));overflow:hidden}
.nlog-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--sea,#118AB2) 78%,var(--deep,#0F4C5C)),var(--deep,#0F4C5C));min-width:3px;transition:width .3s ease}
.nlog-day span{font-variant-numeric:tabular-nums;white-space:nowrap;color:color-mix(in srgb,var(--ink,#22303A) 82%,var(--ink-2,#4A5A66))}
/* ③ 趋势图：viewBox 固定、宽度 100%、preserveAspectRatio=none，
   所以图内不放任何文字（会被横向拉伸），刻度与日期一律用 HTML 排在上下 */
.nlog-charts{display:grid;gap:16px;padding:14px 16px 16px}
.nlog-chart{display:grid;gap:7px;min-width:0}
.nlog-chart-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:calc(12px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66))}
.nlog-chart-hd b{font-size:calc(13px * var(--ui-text-scale));font-weight:600;color:var(--ink)}
.nlog-chart-hd .nlog-legend{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
.nlog-legend i{width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:4px;vertical-align:-1px;background:currentColor}
.nlog-plot{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px;border:1px solid var(--line);border-radius:11px;background:color-mix(in srgb,var(--deep,#0F4C5C) 3%,var(--panel));padding:6px 9px 6px 6px}
.nlog-plot svg{display:block;width:100%;height:132px}
/* 纵轴刻度：HTML 排，SVG 内不放字（preserveAspectRatio=none 会把字横向拉扁）。
   上下各让 10.5px，正好对着 132px 图里的 12/150 留白，刻度才压得住网格线。 */
.nlog-yaxis{display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;padding:10.5px 0;font-size:calc(9.5px * var(--ui-text-scale));line-height:1;color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums;white-space:nowrap}
/* 数据点：折线被横向拉伸，SVG 里的 circle 会变椭圆，所以点改成绝对定位的 HTML 圆点铺在上面。 */
.nlog-vbox{position:relative;min-width:0}
.nlog-dots{position:absolute;inset:0}
.nlog-dots i{position:absolute;width:6px;height:6px;border-radius:50%;transform:translate(-50%,-50%);background:var(--panel);border:1.8px solid var(--sea,#118AB2);box-sizing:border-box}
.nlog-dots i.nlog-dot-peak{width:7px;height:7px;background:var(--coral,#E4572E);border-color:var(--coral,#E4572E)}
.nlog-grid{stroke:color-mix(in srgb,var(--ink,#22303A) 13%,transparent);stroke-width:1;vector-effect:non-scaling-stroke}
.nlog-stroke{fill:none;stroke:var(--sea,#118AB2);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.nlog-area{stroke:none}
.nlog-grad-a{stop-color:color-mix(in srgb,var(--sea,#118AB2) 46%,transparent)}
.nlog-grad-b{stop-color:color-mix(in srgb,var(--sea,#118AB2) 4%,transparent)}
.nlog-peak{stroke:color-mix(in srgb,var(--coral,#E4572E) 72%,transparent);stroke-width:1.4;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}
.nlog-bar-down{fill:var(--grape,#7B61A8)}
/* 横轴与数值行都按「一天一列」的网格排，列与折线上的点对齐；
   首列靠左、末列靠右，正好压在首末两个点上（点就在图的两端）。 */
.nlog-xaxis{display:grid;font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums;text-align:center}
.nlog-xvals{display:grid;font-size:calc(9.5px * var(--ui-text-scale));line-height:1.35;color:color-mix(in srgb,var(--sea,#118AB2) 46%,var(--ink,#22303A));font-variant-numeric:tabular-nums;text-align:center}
.nlog-xaxis span:first-child,.nlog-xvals span:first-child{justify-self:start;text-align:left}
.nlog-xaxis span:last-child,.nlog-xvals span:last-child{justify-self:end;text-align:right}
.nlog-xvals span.is-empty{color:color-mix(in srgb,var(--ink,#22303A) 26%,var(--ink-3,#7E8B94))}
.nlog-xvals span.is-peak{font-weight:600;color:var(--coral,#E4572E)}
/* ④ 明细 */
.nlog-detail-head{align-items:flex-start}
.nlog-detail-head .nlog-sub{margin-left:0}
.nlog-hd-acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.nlog-btn.nlog-mini{min-height:36px;padding:6px 11px;font-size:calc(11.5px * var(--ui-text-scale))}
/* 整块收起 / 单天收起：都是 grid-template-rows 0fr↔1fr，收的那一刻就把内容设成 inert */
.nlog-dwrap,.nlog-gfold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .32s cubic-bezier(.2,.8,.2,1),opacity .22s ease}
.nlog-dwrap.open,.nlog-daygroup.open .nlog-gfold{grid-template-rows:1fr;opacity:1}
.nlog-dclip,.nlog-gclip{min-height:0;overflow:hidden}
.nlog-daygroup+.nlog-daygroup{margin-top:12px}
.nlog-ghead{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:var(--ink-2,#4A5A66);background:transparent;border:0;border-bottom:1px solid var(--line);padding:8px 2px;min-height:40px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;font-size:calc(12px * var(--ui-text-scale))}
.nlog-ghead:hover{color:var(--ink)}
.nlog-ghead:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px;border-radius:8px}
.nlog-ghead b{font-size:calc(12.5px * var(--ui-text-scale));font-weight:600;color:var(--ink)}
.nlog-ghead span{margin-left:auto;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--ink,#22303A) 82%,var(--ink-2,#4A5A66));white-space:nowrap}
.nlog-gchev{display:inline-block;transition:transform .3s cubic-bezier(.2,.78,.2,1);color:var(--ink-3,#7E8B94)}
.nlog-daygroup.open .nlog-gchev{transform:rotate(90deg)}
.nlog-rows{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:6px}
.nlog-row{border:1px solid var(--line);border-radius:11px;background:var(--panel);overflow:hidden}
.nlog-hit{display:grid;grid-template-columns:1fr auto;gap:4px 12px;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:9px 12px;min-height:44px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.nlog-hit:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 6%,var(--panel))}
.nlog-hit:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.nlog-hit .nlog-when2{font-size:calc(12.5px * var(--ui-text-scale));font-variant-numeric:tabular-nums;color:var(--ink)}
.nlog-hit .nlog-flow{font-size:calc(12px * var(--ui-text-scale));font-weight:600;color:color-mix(in srgb,var(--sea,#118AB2) 52%,var(--ink));font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.nlog-hit .nlog-meta2{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.nlog-hit .nlog-alt{display:block;margin-top:1px;font-style:normal;font-size:calc(10px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66))}
.nlog-hit .nlog-chev{display:inline-block;transition:transform .3s cubic-bezier(.2,.78,.2,1);color:var(--ink-3,#7E8B94);margin-left:5px}
.nlog-row.open .nlog-chev{transform:rotate(90deg)}
.nlog-fold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .2s ease}
.nlog-row.open .nlog-fold{grid-template-rows:1fr;opacity:1}
.nlog-clip{min-height:0;overflow:hidden}
.nlog-detail{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px 14px;padding:2px 12px 12px;border-top:1px solid var(--line);margin-top:2px}
.nlog-detail div{min-width:0}
.nlog-detail small{display:block;font-size:calc(10.5px * var(--ui-text-scale));color:color-mix(in srgb,var(--ink,#22303A) 78%,var(--ink-2,#4A5A66));margin-bottom:2px}
.nlog-detail b{font-weight:600;font-size:calc(12px * var(--ui-text-scale));font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.nlog-hintline{margin:10px 0 0;font-size:calc(11px * var(--ui-text-scale));line-height:1.8;color:var(--ink-3,#7E8B94)}
.nlog-more{display:flex;justify-content:center;padding:12px 0 0}
.nlog-empty{border:1px dashed var(--line);border-radius:11px;padding:18px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12px * var(--ui-text-scale));line-height:1.85}
.nlog-loading{padding:26px 16px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12.5px * var(--ui-text-scale))}
.nlog-alert{border:1px solid color-mix(in srgb,var(--danger,#B03535) 42%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 8%,var(--panel));border-radius:11px;padding:12px 14px;font-size:calc(12px * var(--ui-text-scale));line-height:1.85;color:var(--ink)}
.nlog-note{margin:0;font-size:calc(11px * var(--ui-text-scale));line-height:1.85;color:var(--ink-3,#7E8B94)}
@media(max-width:760px){.nlog-stats{grid-template-columns:repeat(2,1fr)}}
@media(max-width:440px){
.nlog-tabs button{padding:8px 10px;font-size:calc(12px * var(--ui-text-scale))}
.nlog-day{grid-template-columns:78px minmax(0,1fr) auto}
.nlog-detail{grid-template-columns:1fr 1fr}
.nlog-when{display:none}
.nlog-night-facts{gap:10px}
.nlog-hd-acts{margin-left:0}
}
/* 深色模式：--sun / --grape 这类语义色在暗底上会被吞掉半格对比度，
   数字与标签按 ink 提亮一次，明细小字与口径说明同理。走 data-theme-mode
   而不是某个主题名 —— 每套主题都有自己的深色变体（见 styles.css 的派生层）。 */
[data-theme-mode="dark"] .nlog-stat strong{color:color-mix(in srgb,var(--c) 34%,var(--ink,#E6EDF3))}
[data-theme-mode="dark"] .nlog-stat-hd{color:color-mix(in srgb,var(--c) 48%,var(--ink,#E6EDF3))}
/* 总流量的绿在暗底上混 34% 会被稀释成近白，认不出是绿：单独抬到 64%。 */
[data-theme-mode="dark"] .nlog-stat.s-flow strong{color:color-mix(in srgb,var(--c) 80%,var(--ink,#E6EDF3))}
[data-theme-mode="dark"] .nlog-stat.s-flow .nlog-stat-hd{color:color-mix(in srgb,var(--c) 88%,var(--ink,#E6EDF3))}
/* 浅色下沿用本色（混 ink 会变墨绿，绿就看不出来了）。 */
[data-theme-mode="light"] .nlog-stat.s-flow strong{color:var(--c)}
[data-theme-mode="light"] .nlog-stat.s-flow .nlog-stat-hd{color:color-mix(in srgb,var(--c) 88%,var(--ink,#1F2328))}
[data-theme-mode="dark"] .nlog-hit .nlog-alt{color:color-mix(in srgb,var(--ink,#E6EDF3) 84%,var(--ink-2,#9FB0BC))}
[data-theme-mode="dark"] .nlog-hintline{color:color-mix(in srgb,var(--ink,#E6EDF3) 72%,var(--ink-3,#8C9AA4))}
/* 熬夜卡的小字（累计/平均/最晚/熬夜率/逐夜时长）在暗色下原来偏灰，实测「能读但不轻松」，抬到 86% 以上才算够。 */
[data-theme-mode="dark"] .nlog-night-big small{color:color-mix(in srgb,var(--ink,#E6EDF3) 86%,var(--ink-2,#9FB0BC))}
[data-theme-mode="dark"] .nlog-night-facts{color:color-mix(in srgb,var(--ink,#E6EDF3) 88%,var(--ink-2,#9FB0BC))}
[data-theme-mode="dark"] .nlog-night .nlog-day span:last-child{color:color-mix(in srgb,var(--ink,#E6EDF3) 88%,var(--ink-2,#9FB0BC))}
[data-theme-mode="dark"] .nlog-night .nlog-night-note{color:color-mix(in srgb,var(--ink,#E6EDF3) 84%,var(--ink-3,#8C9AA4))}
[data-theme-mode="dark"] .nlog-track{background:color-mix(in srgb,var(--ink,#E6EDF3) 15%,var(--panel))}
@media(prefers-reduced-motion:reduce){.nlog-cwrap,.nlog-dwrap,.nlog-gfold,.nlog-fold,.nlog-hit .nlog-chev,.nlog-gchev,.nlog-fill,.nlog-tabs button,.nlog-night-fill{transition-duration:.01ms!important}}`;
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
        /* 熬夜的口径是整个学期，和上面这个区间不是一回事：单独再取一次（分片），
           拿到了再重画一次，首屏不等它。 */
        if (force || !state.nightRows) loadNight();
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

  /* 熬夜统计范围＝一个学期（约 5 个月），远超服务端单次 60 天的上限，所以要分片取。
     学期首日按校历节奏估：春季 2/10 起，冬季 8/25 起（1 月仍属上一年开始的冬季学期）。
     终点固定取今天 —— 未来日期拉了也是空。 */
  function semBounds() {
    const today = todayStr();
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    if (month >= 2 && month <= 7) return { start: `${year}-02-10`, end: today };
    return { start: `${month === 1 ? year - 1 : year}-08-25`, end: today };
  }

  function semChunks() {
    const { start, end } = semBounds();
    const list = [];
    let from = start;
    for (let guard = 0; guard < 12 && from <= end; guard += 1) {
      const to = shiftDay(from, MAX_SPAN - 1);
      const chunkEnd = to > end ? end : to;
      list.push({ start: from, end: chunkEnd });
      if (chunkEnd >= end) break;
      from = shiftDay(chunkEnd, 1);
    }
    return list;
  }

  function loadNight() {
    if (state.nightInFlight) return state.nightInFlight;
    state.nightLoading = true;
    const chunks = semChunks();
    state.nightInFlight = Promise.all(chunks.map((c) => call(c)))
      .then((list) => {
        const rows = [];
        for (const r of list) {
          if (r && r.ok && r.data && Array.isArray(r.data.rows)) rows.push(...r.data.rows);
        }
        /* 一片都没成功（比如登录过期）就别把「上面已经算好的」清空。 */
        if (rows.length || !state.nightRows) state.nightRows = rows;
        state.nightLoadedAt = Date.now();
      })
      .catch(() => { if (!state.nightRows) state.nightRows = []; })
      .finally(() => {
        state.nightInFlight = 0;
        state.nightLoading = false;
        if (!state.disposed) paint();
      });
    return state.nightInFlight;
  }

  /* ── 派生数据 ─────────────────────────────────────────────────────────── */
  /* 每条记录先解析出本地日期与时刻，之后概览 / 熬夜 / 趋势 / 明细四处共用同一份，
     避免四遍各自 new Date（几百行时没必要）。 */
  function decorateRows(list) {
    return list.map((raw, i) => {
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
  const decorated = () => decorateRows(state.rows);

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

  /* 趋势窗口：以区间结束日为右端，往前铺 N 个**自然日**。
     时长按自然日切分：drcom 的一条记录把整段会话的 minutes 全记在上线那天，一条挂了
     三天的会话会让那天出现「72 小时」这种不可能的值，后面几天却一片空白 —— 走势图
     既不可信，也看不出真实作息。这里按「这条会话落在各自然日里的时长占比」拆开，
     flow 同比例拆，于是每天都是真实数据，且单日不会超过一天。 */
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DAY_MIN = 24 * 60; // 单日上限：多设备并行时合计可能超过一天，图上封顶
  function trendList(rows) {
    const days = Number(state.range) || 30;
    const span = Math.max(2, Math.min(TREND_DAYS, days));
    const end = clean(state.span?.end) || todayStr();
    const first = shiftDay(end, -(span - 1));
    const list = [];
    const index = new Map();
    const cellOf = (day) => index.get(day) || null;
    const add = (day, minutes, up, down) => {
      const cell = cellOf(day);
      if (!cell) return; // 窗口外的那一截不画，窗口往前滚时自然出现
      cell.minutes += minutes;
      cell.up += up;
      cell.down += down;
      cell.hits += 1;
    };
    for (let i = 0; i < span; i += 1) {
      const day = shiftDay(first, i);
      const cell = { day, label: String(day).slice(5), minutes: 0, up: 0, down: 0, hits: 0 };
      list.push(cell);
      index.set(day, cell);
    }
    for (const r of rows) {
      const loginAt = r.login ? r.login.getTime() : 0;
      if (!loginAt) { add(r.day, r.minutes, r.up, r.down); continue; } // 没上线时间，只能整笔记到行日期
      const minutes = Math.max(0, r.minutes);
      const logoutAt = r.logout && r.logout > r.login ? r.logout.getTime() : loginAt + minutes * 60000;
      const stop = Math.max(logoutAt, loginAt + minutes * 60000);
      const share = new Map();
      let cursor = loginAt;
      for (let guard = 0; cursor < stop && guard < 400; guard += 1) {
        const day = dayKey(new Date(cursor));
        const segEnd = Math.min(stop, stampOf(day) + DAY_MS);
        if (!(segEnd > cursor)) break;
        share.set(day, (share.get(day) || 0) + (segEnd - cursor));
        cursor = segEnd;
      }
      let total = 0;
      for (const v of share.values()) total += v;
      if (!(total > 0)) { add(r.day, minutes, r.up, r.down); continue; }
      for (const [day, ms] of share) {
        const frac = ms / total;
        add(day, minutes * frac, r.up * frac, r.down * frac);
      }
    }
    for (const cell of list) {
      cell.minutes = cell.hits ? Math.min(DAY_MIN, cell.minutes) : 0;
      cell.hours = cell.minutes / 60;
      cell.total = cell.up + cell.down;
      cell.empty = cell.hits === 0;
    }
    return list;
  }

  /* 熬夜：先把同一夜里的多段在线区间合并成并集，再对阈值之后的部分计时。
     直接按条相加会重复计算重叠时段（换 IP 重连时 drcom 会留下首尾相接的两条）。 */
  function nightSummary(rows) {
    const byNight = new Map();
    for (const r of rows) {
      if (!r.login) continue;
      const key = nightKeyOf(r.login);
      if (!key) continue;
      if (!byNight.has(key)) byNight.set(key, []);
      byNight.get(key).push(r);
    }
    const nights = [];
    for (const [key, list] of byNight) {
      const sem = semOfDay(key);
      const base = stampOf(key);
      const spans = [];
      let lastEnd = 0;
      for (const r of list) {
        const out = r.logout && r.logout > r.login ? r.logout : new Date();
        const startMin = (r.login.getTime() - base) / 60000;
        const endMin = (out.getTime() - base) / 60000;
        if (endMin > lastEnd) lastEnd = endMin;
        const s = Math.max(startMin, sem.cutoff);
        const e = Math.min(endMin, NIGHT_END);
        if (e > s) spans.push([s, e]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      let minutes = 0;
      let cur = null;
      for (const [s, e] of spans) {
        if (!cur) { cur = [s, e]; continue; }
        if (s <= cur[1]) { if (e > cur[1]) cur[1] = e; }
        else { minutes += cur[1] - cur[0]; cur = [s, e]; }
      }
      if (cur) minutes += cur[1] - cur[0];
      nights.push({ key, sem, minutes: Math.round(minutes), lastEnd, count: list.length });
    }
    nights.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const late = nights.filter((n) => n.minutes > 0);
    const total = late.reduce((s, n) => s + n.minutes, 0);
    const latest = nights.reduce((m, n) => (n.lastEnd > m ? n.lastEnd : m), 0);
    return {
      nights,
      late: late.length,
      all: nights.length,
      total,
      avg: late.length ? total / late.length : 0,
      latest: latest > 0 ? clockOf(latest) : "—",
      /* 最晚下线是**原始**下线时刻（不按窗口截断）：熬到第二天下午时它会明显越过 06:00，
         卡面必须标一句，否则会被读成「熬夜一直算到了下午」。 */
      latestBeyond: latest > NIGHT_END,
      longest: late.reduce((m, n) => Math.max(m, n.minutes), 0),
    };
  }

  /* ── 图表（无依赖的 SVG）──────────────────────────────────────────────
     两个图都用固定 viewBox + preserveAspectRatio="none" + 固定像素高度，
     好处是宽屏窄屏都不变形、不出现「宽屏下 300px 高的怪物」；
     代价是图形会被横向拉伸，所以**图里一个字都不放**，刻度与日期全用 HTML 排。 */
  const SVG_W = 480;
  const SVG_H = 150;
  const PAD = { l: 6, r: 6, t: 12, b: 12 };

  /* 把最大值抬到 1 / 2 / 5 × 10^n，网格线与峰值位置才稳定。 */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / exp;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * exp;
  }

  function gridHtml(max) {
    const innerH = SVG_H - PAD.t - PAD.b;
    const base = PAD.t + innerH;
    return [0.25, 0.5, 0.75, 1].map((k) => `<line class="nlog-grid" x1="${PAD.l}" y1="${(base - innerH * k).toFixed(1)}" x2="${SVG_W - PAD.r}" y2="${(base - innerH * k).toFixed(1)}"/>`).join("");
  }

  /* 折线：只在**有记录**的日子之间连线。没有记录的日子不补 0 落到底线（那会被读成
     「这天在线 0 小时」），而是断开，两端各留一个数据点，一看就知道是空档。
     返回值拆成 { svg, dots }：点在 SVG 外，用 HTML 铺（见 .nlog-dots 的注释）。 */
  function lineChart(list) {
    const n = list.length;
    if (!n) return { svg: "", dots: "" };
    const innerW = SVG_W - PAD.l - PAD.r;
    const innerH = SVG_H - PAD.t - PAD.b;
    const base = PAD.t + innerH;
    const max = niceMax(Math.max(...list.map((d) => d.hours), 1));
    const x = (i) => PAD.l + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
    const y = (v) => PAD.t + innerH - (Math.max(0, Math.min(v, max)) / max) * innerH;
    const segs = [];
    let run = [];
    for (let i = 0; i < n; i += 1) {
      if (list[i].empty) { if (run.length) segs.push(run); run = []; } else run.push(i);
    }
    if (run.length) segs.push(run);
    const stroke = [];
    const area = [];
    for (const seg of segs) {
      if (seg.length === 1) {
        /* 孤零零一天：画一根竖线，总比什么都不画好（否则这点数据在图上完全消失）。 */
        const i = seg[0];
        stroke.push(`M${x(i).toFixed(1)} ${base.toFixed(1)} L${x(i).toFixed(1)} ${y(list[i].hours).toFixed(1)}`);
        continue;
      }
      const d = seg.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)} ${y(list[i].hours).toFixed(1)}`).join(" ");
      stroke.push(d);
      area.push(`${d} L${x(seg[seg.length - 1]).toFixed(1)} ${base.toFixed(1)} L${x(seg[0]).toFixed(1)} ${base.toFixed(1)} Z`);
    }
    let top = -1;
    list.forEach((d, i) => { if (!d.empty && (top < 0 || d.hours > list[top].hours)) top = i; });
    const peak = top >= 0 && list[top].hours > 0
      ? `<line class="nlog-peak" x1="${x(top).toFixed(1)}" y1="${PAD.t}" x2="${x(top).toFixed(1)}" y2="${base.toFixed(1)}"/>`
      : "";
    const dots = list.map((d, i) => (d.empty ? "" : `<i${i === top ? ' class="nlog-dot-peak"' : ""} style="left:${((x(i) / SVG_W) * 100).toFixed(2)}%;top:${((y(d.hours) / SVG_H) * 100).toFixed(2)}%" title="${esc(`${d.day} · 在线 ${fmtHours(d.minutes)}`)}"></i>`)).join("");
    return {
      dots,
      svg: `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="none" role="img" aria-label="每日在线时长折线图">
<defs><linearGradient id="nlog-grad-line" x1="0" y1="0" x2="0" y2="1"><stop class="nlog-grad-a" offset="0"/><stop class="nlog-grad-b" offset="1"/></linearGradient></defs>
${gridHtml(max)}${peak}${area.length ? `<path class="nlog-area" fill="url(#nlog-grad-line)" d="${area.join(" ")}"/>` : ""}<path class="nlog-stroke" d="${stroke.join(" ") || `M${PAD.l} ${base.toFixed(1)} L${(SVG_W - PAD.r).toFixed(1)} ${base.toFixed(1)}`}"/></svg>`,
    };
  }

  /* 纵轴刻度：niceMax 后的最大值往下四等分，与 gridHtml 的四条网格线一一对应。 */
  function yaxisHtml(top, fmt) {
    const max = niceMax(Math.max(Number(top) || 0, 1));
    return `<div class="nlog-yaxis" aria-hidden="true">${[1, 0.75, 0.5, 0.25, 0].map((k) => `<span>${esc(fmt(max * k))}</span>`).join("")}</div>`;
  }

  function barChart(list) {
    const n = list.length;
    if (!n) return "";
    const innerW = SVG_W - PAD.l - PAD.r;
    const innerH = SVG_H - PAD.t - PAD.b;
    const base = PAD.t + innerH;
    const max = niceMax(Math.max(...list.map((d) => d.total), 1));
    const slot = innerW / n;
    const bw = Math.max(2.5, Math.min(24, slot * 0.6));
    const bars = list.map((d, i) => {
      const cx = PAD.l + slot * i + slot / 2;
      const hDown = (d.down / max) * innerH;
      const hUp = (d.up / max) * innerH;
      const x0 = cx - bw / 2;
      /* 总量小到不足 1px 时柱子在图上等于消失（看着像「这天没数据」）。
         真有值就给 1.6px 的可见下限，真值仍在 title 里。 */
      const drawnDown = d.down > 0 ? Math.max(hDown, 1.6) : 0;
      const yDown = base - drawnDown;
      /* 上行通常只占总量的一小截，按真实比例常常不足 1px 就看不见了；
         有上行数据时给一个 2.2px 的可见下限（真值仍在 title 里）。 */
      const upH = d.up > 0 ? Math.max(hUp, 2.2) : 0;
      const yUp = yDown - upH;
      const tip = `${d.label} 上行 ${fmtSize(d.up)} · 下行 ${fmtSize(d.down)}`;
      const down = hDown > 0 ? `<rect class="nlog-bar-down" x="${x0.toFixed(1)}" y="${yDown.toFixed(1)}" width="${bw.toFixed(1)}" height="${drawnDown.toFixed(1)}" rx="1.4"><title>${esc(tip)}</title></rect>` : "";
      const up = upH > 0 ? `<rect class="nlog-bar-up" x="${x0.toFixed(1)}" y="${yUp.toFixed(1)}" width="${bw.toFixed(1)}" height="${upH.toFixed(1)}" rx="1.4"><title>${esc(tip)}</title></rect>` : "";
      /* 当天没记录：画一条贴着基线的浅色小横线，避免「空柱」被误读成漏数据。 */
      const idle = d.total <= 0 ? `<rect class="nlog-grid" x="${x0.toFixed(1)}" y="${(base - 1).toFixed(1)}" width="${bw.toFixed(1)}" height="1"/>` : "";
      return down + up + idle;
    }).join("");
    return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="none" role="img" aria-label="每日流量上下行柱状图">${gridHtml(max)}${bars}</svg>`;
  }

  /* 横轴 + 数值行：一天一列（均分），日期与当天时长都对齐到折线上的点。
     14 天默认窗口下只隔一列标日期、隔一列写时长（全写会在窄屏挤成一团），
     但每个有记录的日子至少能读到一个真实数值。 */
  function axisHtml(list) {
    if (!list.length) return "";
    const n = list.length;
    const step = n <= 8 ? 1 : 2;
    const now = todayStr();
    const cols = `grid-template-columns:repeat(${n},minmax(0,1fr))`;
    const shown = (i) => i % step === 0 || i === n - 1;
    const dates = list.map((d, i) => `<span>${shown(i) ? esc(d.day === now ? "今天" : d.label) : ""}</span>`).join("");
    const top = list.reduce((m, d) => (d.empty ? m : Math.max(m, d.hours)), 0);
    const vals = list.map((d, i) => {
      if (!shown(i)) return "<span></span>";
      if (d.empty) return '<span class="is-empty">—</span>';
      return `<span${top > 0 && d.hours >= top ? ' class="is-peak"' : ""}>${esc(fmtHours(d.minutes))}</span>`;
    }).join("");
    return `<div class="nlog-xaxis" style="${cols}">${dates}</div><div class="nlog-xvals" style="${cols}" aria-hidden="true">${vals}</div>`;
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

  /* ① 概览：四张卡各带一个语义图标与配色（时钟 / 流量箭头 / 金额 / 插头）。 */
  function statsHtml(rows) {
    const t = totals(rows);
    const cards = [
      { cls: "s-time", icon: "clock", k: "在线时长", v: fmtDur(t.minutes), sub: [`${fmtHours(t.minutes)} · ${fmtDays(t.minutes)}`] },
      {
        cls: "s-flow", icon: "flow", k: "总流量", v: fmtSize(t.up + t.down),
        sub: [`国际 ↑${fmtSize(t.intraUp)} ↓${fmtSize(t.intraDown)}`, `国内 ↑${fmtSize(t.cnUp)} ↓${fmtSize(t.cnDown)}`],
      },
      { cls: "s-cost", icon: "money", k: "计费金额", v: fmtMoney(t.cost) },
      { cls: "s-count", icon: "plug", k: "上网次数", v: String(t.count || 0), u: "次" },
    ];
    return `<div class="nlog-stats">${cards.map((c) => `<div class="nlog-stat ${c.cls}">
<div class="nlog-stat-hd">${svgIcon(c.icon)}<small>${esc(c.k)}</small></div>
<strong>${esc(c.v)}${c.u ? `<em>${esc(c.u)}</em>` : ""}</strong>
${Array.isArray(c.sub) ? `<span class="nlog-cardsub">${c.sub.map((s) => esc(s)).join("<br>")}</span>` : ""}</div>`).join("")}</div>`;
  }

  /* 流量构成：国际 / 国内各自的上行与下行，按占总量比例铺满同一条轨道。 */
  function splitHtml(rows) {
    const t = totals(rows);
    const all = t.intraUp + t.intraDown + t.cnUp + t.cnDown;
    if (!(all > 0)) return "";
    const pct = (v) => Math.max(0, Math.min(100, (v / all) * 100));
    const line = (k, up, down) => `<div class="nlog-split-row"><span>${esc(k)}</span>
<span class="nlog-mix"><i class="mix-up" style="width:${pct(up).toFixed(1)}%"></i><i class="mix-down" style="width:${pct(down).toFixed(1)}%"></i></span>
<span class="nlog-split-v">↑${esc(fmtSize(up))} ↓${esc(fmtSize(down))}</span></div>`;
    return `<div class="nlog-split">${line("国际", t.intraUp, t.intraDown)}${line("国内", t.cnUp, t.cnDown)}</div>`;
  }

  /* ② 熬夜：整个学期为范围；累计时长 + 三事实在最外，逐夜列表可整块收起。 */
  function nightHtml(rows) {
    /* 学期分片取回来的是原始行，和首屏一样要先解析出 login / logout 才能算熬夜。 */
    const scope = state.nightRows && state.nightRows.length ? decorateRows(state.nightRows) : rows;
    const s = nightSummary(scope);
    const sem = currentSem();
    const open = state.nightOpen;
    const bodyId = "nlog-night-body";
    if (!s.nights.length) {
      return `<div class="nlog-card nlog-sec nlog-night">
<header>${svgIcon("moon")}<h3>熬夜</h3><span class="nlog-sub">${esc(`${sem.label} · ${sem.text} 后`)}</span></header>
<p class="nlog-hintline" data-nlog-night-empty>${state.nightLoading ? "正在统计本学期…" : "本学期还没有记录到熬夜。"}</p>
</div>`;
    }
    const top = Math.max(s.longest, 1);
    const rate = s.all ? Math.round((s.late / s.all) * 100) : 0;
    const bars = s.nights.slice(0, NIGHT_SHOW).map((n) => {
      const pct = n.minutes > 0 ? Math.max(3, Math.round((n.minutes / top) * 100)) : 0;
      return `<div class="nlog-day"><b>${esc(dayLabel(n.key))}</b>
<span class="nlog-track"><i class="nlog-fill" style="width:${pct}%"></i></span>
<span>${esc(n.minutes > 0 ? fmtDur(n.minutes) : "未熬夜")}</span></div>`;
    }).join("");
    const more = s.nights.length > NIGHT_SHOW
      ? `<p class="nlog-hintline nlog-night-note">只列最近 ${NIGHT_SHOW} 夜 · 本学期共 ${s.nights.length} 夜有记录</p>`
      : "";
    return `<div class="nlog-card nlog-sec nlog-night">
<header>${svgIcon("moon")}<h3>熬夜</h3><span class="nlog-sub" title="同一夜的多条记录先合并去重；一夜只算到次日 06:00，挂机整夜不会算成几十小时">${esc(`${sem.label} · ${sem.text} 后`)}</span><button class="nlog-btn nlog-mini nlog-nightfold" type="button" data-nlog-nightfold aria-expanded="${open ? "true" : "false"}" aria-controls="${bodyId}">${open ? "收起" : "展开"}</button></header>
<div class="nlog-night-top">
<div class="nlog-night-big"><strong>${esc(fmtDur(s.total))}</strong><small>累计 · ${s.late} 夜</small></div>
<div class="nlog-night-facts"><span>平均 <b>${esc(fmtDur(s.avg))}</b></span><span>最晚下线 <b>${esc(s.latest)}</b>${s.latestBeyond ? '<small class="nlog-beyond" title="这是原始下线时刻，超出熬夜窗口（次日 06:00）的部分不计入熬夜时长">超出窗口</small>' : ""}</span><span>熬夜率 <b>${rate}%</b></span></div>
</div>
<div class="nlog-dwrap${open ? " open" : ""}" id="${bodyId}" aria-hidden="${open ? "false" : "true"}"${open ? "" : " inert"}><div class="nlog-dclip">
<div class="nlog-night-list">${bars}</div>${more}
</div></div>
</div>`;
  }

  /* ③ 趋势：上「每日在线时长」折线，下「每日流量」上下行堆叠柱。
     两图都带纵轴刻度 + 每天的数据点；日期下方再给一行「当天几小时」（14 天窗口隔列写），数值直接读得出来。 */
  function trendHtml(rows) {
    /* 窗口里一条记录都没有时，趋势会铺满 0 值：折线贴底、柱图全空，
       看着像「这些天都是 0 小时」而不是「没有数据」，比不画更误导。 */
    if (!rows.length) return "";
    const list = trendList(rows);
    if (!list.length) return "";
    const maxH = list.reduce((m, d) => Math.max(m, d.hours), 0);
    const maxT = list.reduce((m, d) => Math.max(m, d.total), 0);
    const sumH = list.reduce((s, d) => s + d.hours, 0);
    const avgH = sumH / list.length;
    const line = lineChart(list);
    const days = list.length;
    return `<div class="nlog-card"><div class="nlog-charts">
<div class="nlog-chart">
<div class="nlog-chart-hd">${svgIcon("activity")}<b>上网时间</b><span>每日在线时长 · 近 ${days} 天</span><span class="nlog-legend"><span>最高 ${esc(fmtHours(maxH * 60))}</span><span>日均 ${esc(fmtHours(avgH * 60))}</span></span></div>
<div class="nlog-plot">${yaxisHtml(maxH, (h) => fmtHours(h * 60))}<div class="nlog-vbox">${line.svg}<div class="nlog-dots">${line.dots}</div></div></div>
${axisHtml(list)}
</div>
<div class="nlog-chart">
<div class="nlog-chart-hd">${svgIcon("bars")}<b>流量使用</b><span>每日上下行 · 近 ${days} 天</span><span class="nlog-legend"><span><i class="nlog-sw-up"></i>上行</span><span><i style="color:var(--grape,#7B61A8)"></i>下行</span><span>最高 ${esc(fmtSize(maxT))}</span></span></div>
<div class="nlog-plot">${yaxisHtml(maxT, fmtSize)}<div class="nlog-vbox">${barChart(list)}</div></div>
${axisHtml(list)}
</div>
<p class="nlog-hintline">跨天在线的会话已按自然日拆到每一天（单日最多按 24 小时计）；「—」表示那天没有记录。</p>
</div></div>`;
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
      const dayOpen = !state.collapsedDays.has(g.day);
      const gid = `nlog-day-${g.day}`;
      blocks.push(`<div class="nlog-daygroup${dayOpen ? " open" : ""}" data-nlog-daygroup="${esc(g.day)}">
<button class="nlog-ghead" type="button" data-nlog-daytoggle aria-expanded="${dayOpen ? "true" : "false"}" aria-controls="${esc(gid)}">
<b>${esc(dayLabel(g.day))}</b><i class="nlog-gchev" aria-hidden="true">›</i>
<span>${g.count} 次 · ${esc(fmtSize(g.total))}</span></button>
<div class="nlog-gfold" id="${esc(gid)}" aria-hidden="${dayOpen ? "false" : "true"}"><div class="nlog-gclip">
<ul class="nlog-rows">${take.map((r) => rowHtml(r, state.expanded.has(r.key))).join("")}</ul>
</div></div></div>`);
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

  /* 明细卡：header 上两个动作 —— 整块收起（全部收起 / 全部展开）。
     整块收起后内容立刻 inert（动画仍在播，但点不到、也无法 Tab 进去）。 */
  function detailHtml(rows) {
    const open = state.detailOpen;
    return `<header class="nlog-detail-head">${svgIcon("list")}<h3>上网明细</h3>
<span class="nlog-sub">${esc(titleSub(rows))}</span>
<div class="nlog-hd-acts"><button class="nlog-btn nlog-mini" type="button" data-nlog-fold aria-expanded="${open ? "true" : "false"}" aria-controls="nlog-detail-body">${open ? "全部收起" : "全部展开"}</button></div>
</header>
<div class="nlog-dwrap${open ? " open" : ""}" id="nlog-detail-body" data-nlog-detail-wrap aria-hidden="${open ? "false" : "true"}"><div class="nlog-dclip">
<div data-nlog-list>${listHtml(rows)}</div>
<p class="nlog-note">${esc(state.span ? `区间 ${state.span.start} → ${state.span.end}（含起止两天，最长 60 天）。` : "")}时长与流量以自助服务系统记录为准；flow 字段恒为 0，真实用量按国际 / 国内上下行合计。</p>
</div></div>`;
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
    root.innerHTML = `<div class="nlog-wrap">
${toolbarHtml()}
${state.stale ? `<div class="nlog-card nlog-sec"><div class="nlog-alert">${esc(state.stale)}</div></div>` : ""}
<div class="nlog-card">${statsHtml(rows)}${splitHtml(rows)}</div>
${nightHtml(rows)}
${trendHtml(rows)}
<div class="nlog-card nlog-sec">${detailHtml(rows)}</div></div>`;
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
    if (fold) {
      fold.setAttribute("aria-hidden", open ? "false" : "true");
      try { fold.inert = !open; } catch { /* 老 WebView 没有 inert，只是少一层可达性保护 */ }
    }
  }

  /* 整块明细收起 / 展开（双向动画；收起瞬间就 inert）。 */
  function toggleDetail(root) {
    const wrap = root.querySelector("[data-nlog-detail-wrap]");
    const btn = root.querySelector("[data-nlog-fold]");
    state.detailOpen = !state.detailOpen;
    if (wrap) {
      wrap.classList.toggle("open", state.detailOpen);
      wrap.setAttribute("aria-hidden", state.detailOpen ? "false" : "true");
      try { wrap.inert = !state.detailOpen; } catch { /* ignore */ }
    }
    if (btn) {
      btn.setAttribute("aria-expanded", state.detailOpen ? "true" : "false");
      btn.textContent = state.detailOpen ? "全部收起" : "全部展开";
    }
    persist();
  }

  /* 熬夜逐夜列表收起 / 展开：与明细同一套 grid-rows 双向过渡，收起瞬间 inert。 */
  function toggleNight(root) {
    const wrap = root.querySelector("#nlog-night-body");
    const btn = root.querySelector("[data-nlog-nightfold]");
    if (!wrap || !btn) return;
    state.nightOpen = !state.nightOpen;
    wrap.classList.toggle("open", state.nightOpen);
    wrap.setAttribute("aria-hidden", state.nightOpen ? "false" : "true");
    try { wrap.inert = !state.nightOpen; } catch { /* ignore */ }
    btn.setAttribute("aria-expanded", state.nightOpen ? "true" : "false");
    btn.textContent = state.nightOpen ? "收起" : "展开";
    persist();
  }

  /* 单天收起 / 展开：与整块收起同一套 grid-rows 过渡，箭头同步旋转。 */
  function toggleDay(btn) {
    const group = btn.closest?.("[data-nlog-daygroup]");
    if (!group) return;
    const key = group.getAttribute("data-nlog-daygroup") || "";
    const open = !state.collapsedDays.has(key);
    if (open) state.collapsedDays.delete(key); else state.collapsedDays.add(key);
    group.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    const fold = group.querySelector(".nlog-gfold");
    if (fold) {
      fold.setAttribute("aria-hidden", open ? "false" : "true");
      try { fold.inert = !open; } catch { /* ignore */ }
    }
    persist();
  }

  function bind(root) {
    const on = (sel, fn) => { const n = root.querySelector(sel); if (n) n.onclick = fn; };
    on("[data-nlog-refresh]", () => load(true));
    on("[data-nlog-fold]", () => toggleDetail(root));
    on("[data-nlog-nightfold]", () => toggleNight(root));
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
    for (const btn of root.querySelectorAll("[data-nlog-daytoggle]")) {
      btn.onclick = () => toggleDay(btn);
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
      tide.storage?.set?.(KEY, {
        range: state.range,
        customStart: state.customStart,
        customEnd: state.customEnd,
        detailOpen: state.detailOpen,
        nightOpen: state.nightOpen,
        collapsedDays: [...state.collapsedDays],
      });
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
        if (typeof saved.detailOpen === "boolean") state.detailOpen = saved.detailOpen;
        if (typeof saved.nightOpen === "boolean") state.nightOpen = saved.nightOpen;
        if (Array.isArray(saved.collapsedDays)) state.collapsedDays = new Set(saved.collapsedDays.filter((k) => typeof k === "string"));
      }
    }).catch(() => {});
    /* 学期名只服务于熬夜阈值：校历同步过就用它，没同步过 semester 会退回按月份判断。 */
    Promise.resolve(tide.storage?.get?.("calendar", null)).then((saved) => {
      if (state.disposed) return;
      const name = clean(saved?.term?.name);
      if (name) state.termName = name;
    }).catch(() => {});
    Promise.resolve().then(() => load());
    return () => {
      state.disposed = true;
      state.root = null;
      for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
      state.expanded.clear();
    };
  }

  return { render, refresh: () => load(true) };
}
