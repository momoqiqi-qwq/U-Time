// 警大门户通知 · 学生个人成长中心（pdata.cppu.edu.cn/stu/home）
//
// 独立界面，不照搬网页：网页是 umi + antd 的整站 SPA（左侧导航 + 顶部栏 + 一堆
// 折叠面板），塞进插件只会变成一个更窄的浏览器。这里只保留网页真正有信息量的
// 六块，按 U-Time 的卡片语言重排：
//   ① 顶部身份卡（头像 / 姓名 / 学号 / 字段标签）
//   ② 学业概览（累计已修 / 应修学分 / GPA / 本学期已获得）
//   ③ KPI 指标卡（后台配的指标，点开看明细表）
//   ④ 我的消费 / 我的上网（单选切换，与网页同构）
//   ⑤ 我的考勤 / 奖惩记录
//   ⑥ 数据中心入口（网页的模块清单，点了带会话开浏览器）
//
// 边界：本模块**不碰** SSO / 密码 / vault / Cookie —— 那是 main.js 的事。
// 一切取数走 bridge.api(path)，鉴权（换票 → validateLogin → token）与
// 一次性重登由 main.js 内部处理；本模块只认「拿到 data / 没拿到」两种结果。
//
// 取数口径对齐网页（services 层，反解自 umi.js）：
//   personInfo / learnSituation / getKpiList / getKpiDetailInfo / cardConsume /
//   onlineState / getMyAttendance / bonusPenaltyList / getModuleList
// 字段名一律用接口原样的大写名，不在这里改名 —— 出问题时能直接对着抓包看。

export function createGrowthView(tide, bridge) {
  const KEY = "growthViewPreferences";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** 接口里的空值是字符串 "null"（后台 Java 侧 String.valueOf(null)），必须当空处理。 */
  const clean = (v) => {
    const s = String(v ?? "").trim();
    return !s || s === "null" || s === "undefined" || s === "NaN" ? "" : s;
  };
  const text = (v, fallback = "—") => clean(v) || fallback;
  const num = (v) => {
    const s = clean(v);
    if (!s) return "";
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : s;
  };
  const money = (v) => {
    const s = clean(v);
    if (!s) return "";
    const n = Number(s);
    return Number.isFinite(n) ? n.toFixed(2) : s;
  };
  /** 接口里的日期是 "2025-09-01 08:00:00" 或 "20250901" 这类混排，只做最保守的规整。 */
  const day = (v) => {
    const s = clean(v);
    if (!s) return "";
    const m = s.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
  };
  const clock = (v) => {
    const s = clean(v);
    const m = s.match(/(\d{1,2}:\d{2})(?::\d{2})?/);
    return m ? m[1] : s;
  };
  /** 后台给的 KPI_COLOR 是 hex（少数部署给的是渐变串）；非法 / 缺省时按位次
      退回四色轮转 —— 色相取自网页「数据导航页」的 .KUCard .generl 渐变。
      网页那套是给浅色图标底用的，白字压在最浅处只有 1.75:1；这里把两端都压深，
      使 12.5px 白字（指标名）也能到 ≥4.6:1，24px 数值（大字）更宽裕。 */
  const HEX = /^#[0-9a-fA-F]{3,8}$/;
  const GRADIENTS = [
    "linear-gradient(-90deg,#2F72D2,#2559A8)",
    "linear-gradient(-90deg,#C4496F,#A83A5E)",
    "linear-gradient(-90deg,#1A7C75,#14625F)",
    "linear-gradient(-90deg,#4C56C9,#3A43A8)",
  ];
  const kpiBg = (v, index) => {
    const s = clean(v);
    if (HEX.test(s)) return s;
    if (/^(linear|radial|conic)-gradient\(/i.test(s) && !/[<>"']/.test(s)) return s;
    return GRADIENTS[index % GRADIENTS.length];
  };
  /** 指标卡的底色是后台给的，深浅不可控（实测有 #FCA271 这类浅色，白字只有 1.99:1）。
      所以按底色亮度自己选字色：白字压最亮停靠色、深字压最暗停靠色，谁对比度高用谁。 */
  const KPI_INK = "#152A33";
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lumOf = (raw) => {
    const s = String(raw).trim();
    let r, g, b;
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) {
      const h = s.length === 4 ? s.slice(1).split("").map((x) => x + x).join("") : s.slice(1, 7);
      if (h.length < 6) return null;
      [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    } else {
      const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
      if (!m) return null;
      [r, g, b] = [1, 2, 3].map((i) => Number(m[i]) / 255);
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = a >= b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  };
  const kpiFg = (bg) => {
    const stops = (String(bg).match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/g) || []).map(lumOf).filter((v) => v !== null);
    if (!stops.length) return "#fff";
    const asWhite = contrast(1, Math.max(...stops));
    const asInk = contrast(lumOf(KPI_INK), Math.min(...stops));
    return asInk > asWhite ? KPI_INK : "#fff";
  };
  /** 指标卡的圆形图标位：网页用的是站点自带 iconfont（我们没那份字体），
      所以只有干净的内联 SVG 才原样渲染，其余一律退回「指标名首字」徽标。 */
  const iconHtml = (raw) => {
    const s = clean(raw);
    if (!/^<svg[\s>]/i.test(s)) return "";
    if (/<script|onload\s*=|onerror\s*=|javascript:/i.test(s)) return "";
    return s;
  };
  const initial = (name) => {
    const s = clean(name);
    if (!s) return "成";
    // 中文取末字（姓名取名字）、拉丁取首字母
    return /^[\u4e00-\u9fa5]+$/.test(s) ? s.slice(-1) : s.slice(0, 1).toUpperCase();
  };

  const state = {
    root: null, disposed: false, loading: false, error: "", loginNeeded: false, stale: "",
    account: "", tab: "consume", kpiPage: 0, detail: null, detailLoading: false, expanded: false,
    profile: null, photo: "", learn: null, learnTags: [], kpi: [], consume: null, online: null, attend: [], bonus: [], modules: [],
    loadedAt: 0, inFlight: 0, partial: false,
  };
  const glowHandles = [];
  let modalEl = null, modalTimer = 0, modalKeyHandler = null;

  /* ── 样式 ──────────────────────────────────────────────────────────────
     安全区：本模块只画 [data-pg-host] 里的内容，四条边由宿主 .view 负责，这里
     **不垫第二遍**。唯一例外是 .pg-modal（position:fixed，包含块是 .view 的
     padding box，宿主 padding 拦不住它），四边自己让开。 */
  function styles() {
    if (typeof document === "undefined" || document.getElementById("pg-growth-style")) return;
    const node = document.createElement("style");
    node.id = "pg-growth-style";
    node.textContent = `.pg-wrap{max-width:900px;margin:0 auto;display:grid;gap:14px}
.pg-card{border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--panel);color:var(--ink);overflow:hidden}
.pg-sec{padding:15px 16px}
.pg-sec>header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.pg-sec h3{margin:0;font-size:calc(15px * var(--ui-text-scale));letter-spacing:.02em}
.pg-sec>header .pg-sub{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);white-space:nowrap}
.pg-eyebrow{font-size:calc(10.5px * var(--ui-text-scale));letter-spacing:.26em;color:var(--ink-3,#7E8B94)}
/* ① 身份卡 */
.pg-hero{position:relative;border:0;background:linear-gradient(135deg,var(--deep,#0F4C5C) 0%,color-mix(in srgb,var(--sea,#118AB2) 62%,var(--deep,#0F4C5C)) 100%);color:var(--on-accent,#fff)}
.pg-hero-in{display:flex;align-items:center;gap:15px;padding:17px 18px}
.pg-face{flex:none;width:64px;height:64px;border-radius:50%;overflow:hidden;background:color-mix(in srgb,#fff 22%,transparent);display:grid;place-items:center;font-size:calc(24px * var(--ui-text-scale));font-weight:600;border:2px solid color-mix(in srgb,#fff 45%,transparent)}
.pg-face img{width:100%;height:100%;object-fit:cover;display:block}
.pg-id{min-width:0;flex:1 1 auto}
.pg-id h2{margin:0;font-size:calc(20px * var(--ui-text-scale));font-weight:600;overflow-wrap:anywhere}
.pg-id .pg-no{margin-top:3px;font-size:calc(12px * var(--ui-text-scale));opacity:.86;font-variant-numeric:tabular-nums}
.pg-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.pg-tag{font-size:calc(11px * var(--ui-text-scale));padding:3px 9px;border-radius:999px;background:color-mix(in srgb,#fff 18%,transparent);border:1px solid color-mix(in srgb,#fff 30%,transparent);white-space:nowrap}
.pg-tag b{font-weight:600;opacity:.78;margin-right:4px}
.pg-fold{margin-top:10px}
.pg-fold>button{font:inherit;font-size:calc(11.5px * var(--ui-text-scale));color:inherit;opacity:.9;background:transparent;border:0;padding:2px 0;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:30px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.pg-fold>button .pg-chev{display:inline-block;transition:transform .3s cubic-bezier(.2,.78,.2,1)}
.pg-fold.open>button .pg-chev{transform:rotate(90deg)}
/* 铁律七：展开 / 收起都要有中间帧 —— grid-template-rows 0fr↔1fr 可连续插值 */
.pg-shell{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .34s cubic-bezier(.2,.8,.2,1),opacity .22s ease}
.pg-fold.open .pg-shell{grid-template-rows:1fr;opacity:1}
.pg-clip{min-height:0;overflow:hidden}
/* ② 学业概览 */
.pg-learn{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.pg-stat{border:1px solid var(--line);border-radius:12px;padding:12px 13px;background:color-mix(in srgb,var(--deep,#0F4C5C) 5%,var(--panel))}
.pg-stat small{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);margin-bottom:6px}
.pg-stat strong{font-size:calc(22px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;color:var(--deep,#0F4C5C)}
.pg-stat em{font-style:normal;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-left:3px}
/* ③ KPI 指标卡 */
.pg-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.pg-kpi{position:relative;display:block;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:#fff;border:0;border-radius:12px;padding:13px 14px;min-height:92px;cursor:pointer;overflow:hidden;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .18s ease,box-shadow .18s ease}
.pg-kpi:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg,0 10px 32px rgba(34,48,58,.16))}
.pg-kpi:focus-visible{outline:2px solid color-mix(in srgb,#fff 70%,transparent);outline-offset:-3px}
.pg-kpi .pg-kpi-name{font-size:calc(12.5px * var(--ui-text-scale));opacity:.94;display:block;overflow-wrap:anywhere}
.pg-kpi .pg-kpi-num{margin-top:7px;font-size:calc(24px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.pg-kpi .pg-kpi-unit{font-size:calc(11.5px * var(--ui-text-scale));opacity:.9;margin-left:3px;font-weight:400}
.pg-kpi .pg-kpi-badge{position:absolute;right:11px;bottom:11px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:calc(13px * var(--ui-text-scale));border:1px solid currentColor;opacity:.92}
.pg-kpi .pg-kpi-badge svg{width:16px;height:16px}
.pg-pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:10px}
.pg-pager button{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:6px 11px;min-height:34px;cursor:pointer;touch-action:manipulation}
.pg-pager button:disabled{opacity:.42;cursor:default}
.pg-pager span{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
/* ④ 消费 / 上网 */
.pg-tabs{display:inline-flex;position:relative;isolation:isolate;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
/* 铁律六：单选组高亮 = 一块随选择滑动的光（宿主 selectionGlow.js 画），选中按钮不再自画静态底。 */
.pg-tabs .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;transition:opacity .2s linear;border-radius:10px;background:var(--deep,#0F4C5C)}
.pg-tabs .selection-glow.on{opacity:1}
.pg-tabs.has-selection-glow button{position:relative;z-index:1}
.pg-tabs.has-selection-glow button[aria-pressed=true]{background:transparent}
.pg-tabs button{font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:inherit;background:transparent;border:0;padding:8px 14px;min-height:36px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,color .18s ease}
.pg-tabs button+button{border-left:1px solid var(--line)}
.pg-tabs button[aria-pressed=true]{background:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.pg-flow{background:linear-gradient(-90deg,color-mix(in srgb,var(--deep,#0F4C5C) 14%,var(--panel)),color-mix(in srgb,var(--sea,#118AB2) 22%,var(--panel)));border-radius:12px;padding:13px 15px;display:flex;gap:22px;flex-wrap:wrap}
.pg-flow .pg-f{border:0;background:transparent;padding:0}
.pg-flow small{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-bottom:5px}
.pg-flow strong{font-size:calc(21px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;color:var(--deep,#0F4C5C)}
.pg-flow strong.pg-num{border:0;background:transparent;padding:0;font-family:inherit}
.pg-flow em{font-style:normal;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-left:3px}
.pg-list{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:7px}
.pg-row{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:11px;padding:9px 12px;background:var(--panel);font-size:calc(12.5px * var(--ui-text-scale))}
.pg-row .pg-when{flex:none;color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums;font-size:calc(11.5px * var(--ui-text-scale))}
.pg-row .pg-what{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pg-row .pg-how{flex:none;font-weight:600;color:var(--deep,#0F4C5C);font-variant-numeric:tabular-nums;text-align:right}
.pg-more{font:inherit;font-size:calc(11.5px * var(--ui-text-scale));color:var(--deep,#0F4C5C);background:transparent;border:0;padding:0;cursor:pointer;text-decoration:underline;white-space:nowrap}
.pg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:9px}
.pg-entry{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font:inherit;font-size:calc(12.5px * var(--ui-text-scale));text-align:left;color:inherit;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel));border:1px solid var(--line);border-radius:11px;padding:10px 12px;min-height:44px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .16s ease}
.pg-entry:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 11%,var(--panel))}
.pg-entry:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.pg-entry i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--deep,#0F4C5C);opacity:.7}
.pg-entry span{min-width:0;overflow-wrap:anywhere}
.pg-empty{border:1px dashed var(--line);border-radius:11px;padding:15px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12px * var(--ui-text-scale));line-height:1.85}
.pg-note{margin:11px 0 0;font-size:calc(11px * var(--ui-text-scale));line-height:1.85;color:var(--ink-3,#7E8B94)}
.pg-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.pg-bar .pg-when{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94)}
.pg-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 13px;min-height:38px;cursor:pointer;touch-action:manipulation}
.pg-btn.pg-primary{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.pg-btn:disabled{opacity:.5;cursor:default}
.pg-loading{padding:26px 16px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12.5px * var(--ui-text-scale))}
.pg-alert{border:1px solid color-mix(in srgb,var(--danger,#B03535) 42%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 8%,var(--panel));border-radius:11px;padding:12px 14px;font-size:calc(12px * var(--ui-text-scale));line-height:1.85;color:var(--ink)}
/* KPI 明细弹层：position:fixed 是唯一逃出宿主 .view 的定位，四边自己让开安全区。 */
.pg-modal{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:calc(16px + var(--sat,env(safe-area-inset-top,0px))) calc(16px + var(--sar,env(safe-area-inset-right,0px))) calc(16px + var(--sab,env(safe-area-inset-bottom,0px))) calc(16px + var(--sal,env(safe-area-inset-left,0px)));background:color-mix(in srgb,#000 46%,transparent);opacity:0;transition:opacity .22s ease}
.pg-modal.on{opacity:1}
.pg-modal-card{width:100%;max-width:640px;max-height:100%;display:flex;flex-direction:column;border-radius:var(--radius,14px);background:var(--panel);color:var(--ink);border:1px solid var(--line);box-shadow:var(--shadow-lg,0 10px 32px rgba(34,48,58,.16));overflow:hidden;transform:translateY(14px) scale(.985);opacity:0;transition:transform .26s cubic-bezier(.2,.8,.2,1),opacity .22s ease}
.pg-modal.on .pg-modal-card{transform:none;opacity:1}
.pg-modal-card>header{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--line)}
.pg-modal-card>header h3{margin:0;font-size:calc(14.5px * var(--ui-text-scale));flex:1 1 auto;overflow-wrap:anywhere}
.pg-modal-card>header button{font:inherit;font-size:calc(16px * var(--ui-text-scale));line-height:1;color:var(--ink-2,#4A5A66);background:transparent;border:0;border-radius:9px;padding:6px 10px;min-height:34px;cursor:pointer}
.pg-modal-body{padding:13px 15px;overflow:auto}
.pg-table{width:100%;border-collapse:collapse;font-size:calc(12px * var(--ui-text-scale))}
.pg-table th,.pg-table td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.pg-table th{background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel));font-weight:600;white-space:nowrap}
.pg-table td{font-variant-numeric:tabular-nums}
.pg-modal-foot{display:flex;align-items:center;gap:9px;padding:11px 15px;border-top:1px solid var(--line)}
.pg-modal-foot span{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
@media(max-width:760px){.pg-learn,.pg-kpis{grid-template-columns:repeat(2,1fr)}}
@media(max-width:420px){.pg-learn,.pg-kpis{grid-template-columns:1fr 1fr}.pg-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.pg-shell,.pg-fold>button .pg-chev,.pg-kpi,.pg-modal,.pg-modal-card,.pg-tabs button{transition-duration:.01ms!important}}`;
    document.head.append(node);
  }

  /* ── 取数 ────────────────────────────────────────────────────────────── */
  /* `force` 只在用户按「刷新」时为真：要求 bridge 绕过它那份缓存。老宿主没给 force
     通道时退回普通取数 —— 宁可慢一次，也不要「点了刷新没反应」。 */
  const call = (path, force = false) => Promise.resolve(force && bridge?.force ? bridge.force(path) : bridge?.api?.(path)).then((r) => (r && typeof r === "object" ? r : { ok: false, message: "取数通道不可用" }));

  /* 刷新等待蒙版（v0.233.0）：这一页要并发打 8 个 pdata 接口，首次进入整屏只有一句
     「正在读取个人成长数据…」。蒙版盖在这句占位之上（占位保留，作为老宿主的兜底）。
     包一层而不是在原函数里散点 release：里面有多条 return，散点极易漏掉一条。
     v0.236.0：**手里已经有数据时不再打蒙版** —— 蒙版是给「什么都没有」的首次进入用的。 */
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});

  /* 重进缓存（v0.236.0）：成长页在侧栏里是来回切的常客，而它一次要打 8 个接口。
     进去一次不该等于「每次都把全部数据重等一遍」：
       · TTL 内重进：连 bridge 都不问（主进程那份缓存也就不会被碰），直接画上次的；
       · 有数据但过期：先把旧数据画出来（带「更新于 …」），再后台静默刷新；
       · 什么都没有：才是蒙版该出现的场景。 */
  const FRESH_MS = 60 * 1000;
  function loadAll(force = false) {
    if (state.inFlight) return Promise.resolve();
    if (!force && state.loadedAt && Date.now() - state.loadedAt < FRESH_MS) {
      paint();
      return Promise.resolve();
    }
    const releaseWait = state.loadedAt ? () => {} : waitMask("正在读取学生成长数据…");
    return loadAllInner(force).finally(releaseWait);
  }

  /* 两组响应共用的落盘映射：HEAD_FIELDS / TAIL_FIELDS 与请求数组一一对应。
     返回成功条数，交给 state.stale 算「几项没取到」。 */
  const HEAD_FIELDS = ["profile", "learn", "kpi"];
  const TAIL_FIELDS = ["consume", "online", "attend", "bonus", "modules"];
  function applyResults(fields, rs) {
    let ok = 0;
    fields.forEach((f, i) => {
      const x = rs[i];
      if (!x || !x.ok) return;
      ok += 1;
      if (f === "profile") {
        const d = x.data || {};
        state.profile = d.personInfo || null;
        state.photo = photoSrc(d.personPhoto);
        // 网页把前 3 项砍掉（那 3 项是姓名/学号/性别，身份卡上已经有了），这里照做。
        state.learnTags = (Array.isArray(d.column) ? d.column : []).slice(3)
          .map((c) => ({ k: clean(c.dataFieldName), v: clean(c.val) })).filter((t) => t.k && t.v);
      } else if (f === "learn") state.learn = x.data || null;
      else if (f === "kpi") state.kpi = (Array.isArray(x.data) ? x.data : []).filter((k) => k && (clean(k.FORMNAME) || clean(k.KPICONFIG)));
      else if (f === "consume") state.consume = x.data || null;
      else if (f === "online") state.online = x.data || null;
      else if (f === "attend") state.attend = Array.isArray(x.data) ? x.data.filter(Boolean) : [];
      else if (f === "bonus") state.bonus = Array.isArray(x.data) ? x.data.filter(Boolean) : [];
      else if (f === "modules") state.modules = flattenModules(x.data);
    });
    return ok;
  }

  async function loadAllInner(force = false) {
    if (state.inFlight) return;
    state.inFlight = 1;
    state.loading = true;
    state.error = "";
    state.loginNeeded = false;
    // 还在补数据 ≠ 没有数据：下面几块要显示「读取中…」而不是「暂无」。
    state.partial = true;
    paint();

    /* 首屏优先：先把身份卡 / 学业概览 / 成长指标这三块画出来，剩下五块（消费 / 上网 /
       考勤 / 奖惩 / 模块入口）到了再补一版。两组请求同时发出 —— 只是**分两批落画面**，
       否则首屏等于在等最慢的那一个接口。 */
    const head = [
      call("/tsa/shc/homepage/personInfo", force),
      call("/tsa/shc/learnInfo/learnSituation", force),
      call("/tsa/shc/homepage/getKpiList", force),
    ];
    const tail = [
      call("/tsa/shc/homepage/cardConsume", force),
      call("/tsa/shc/homepage/onlineState", force),
      call("/tsa/shc/homepage/getMyAttendance", force),
      call("/tsa/shc/homepage/bonusPenaltyList", force),
      call(`/tsa/shc/customStyle/getModuleList?t=${Date.now()}`, force),
    ];

    const headRes = await Promise.all(head);
    if (state.disposed) { state.inFlight = 0; return; }
    const okHead = applyResults(HEAD_FIELDS, headRes);
    if (!okHead) {
      // 首屏这三块全灭：不必再等后面五块，直接给结论（没登录 vs 站点不通，两者下一步不同）。
      const first = headRes.find((r) => r && (r.message || r.status)) || {};
      state.inFlight = 0;
      state.loading = false;
      state.partial = false;
      state.loginNeeded = !!first.auth;
      state.error = first.message || "个人成长中心暂时没有响应";
      paint();
      return;
    }
    // 首屏落地：从这一刻起「有数据」——后面的刷新一律不再打蒙版（loadAll 看的就是它）。
    state.loadedAt = Date.now();
    paint();

    const tailRes = await Promise.all(tail);
    if (state.disposed) { state.inFlight = 0; return; }
    state.inFlight = 0;
    state.loading = false;
    state.partial = false;
    const okCount = okHead + applyResults(TAIL_FIELDS, tailRes);
    const total = head.length + tail.length;
    state.stale = okCount < total ? `${total - okCount} 项数据没取到，其余为最新` : "";
    state.kpiPage = 0;
    paint();
  }

  function photoSrc(raw) {
    const s = clean(raw);
    if (!s) return "";
    if (/^data:image\//i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    return `data:image/jpeg;base64,${s}`;
  }

  /** 模块清单：取「数据报告」那一组的 children（网页同款口径），拿不到就摊平所有组。 */
  function flattenModules(data) {
    const list = Array.isArray(data) ? data : [];
    const group = list.find((g) => clean(g?.id) === "1-DataReport" || clean(g?.name) === "数据报告");
    const children = (group && Array.isArray(group.children) ? group.children : list.flatMap((g) => (Array.isArray(g?.children) ? g.children : [])));
    return children.map((c) => ({
      name: clean(c?.name),
      // CATALOGID 是 SPA 路由参数；老版本接口只给 id（形如 "1-13-basicInfo"），
      // 那就按最后一个 '-' 后面那截当目录名 —— 这正是 basicInfo / bookRent 这类值。
      key: clean(c?.CATALOGID) || clean(c?.catalogId) || clean(c?.id).split("-").slice(-1)[0],
    })).filter((c) => c.name && c.key);
  }

  /* ── 明细弹层 ─────────────────────────────────────────────────────────── */
  async function openDetail(kpiRow) {
    const wid = clean(kpiRow?.WID);
    if (!wid) return;
    state.detail = { wid, title: clean(kpiRow.FORMNAME) || "指标明细", page: 1, pageSize: 10, total: 0, cols: [], rows: [], error: "" };
    state.detailLoading = true;
    showModal();
    await loadDetailPage(1);
  }

  async function loadDetailPage(page) {
    const d = state.detail;
    if (!d) return;
    state.detailLoading = true;
    paintModal();
    const res = await call(`/tsa/shc/homepage/getKpiDetailInfo?page=${page}&pageSize=${d.pageSize}&wid=${encodeURIComponent(d.wid)}`);
    if (state.disposed || state.detail !== d) return;
    state.detailLoading = false;
    if (!res.ok) { d.error = res.message || "明细读取失败"; paintModal(); return; }
    const body = res.data || {};
    const detail = body.dataDetail || {};
    const fields = Array.isArray(body.dataField) ? body.dataField : [];
    d.cols = fields.map((f) => ({ title: clean(f.DATAFIELDNAME) || clean(f.DATAFIELD), key: clean(f.DATAFIELD) })).filter((c) => c.key);
    d.rows = Array.isArray(detail.rowsList) ? detail.rowsList : [];
    d.total = Number(detail.total) || 0;
    d.page = page;
    d.error = "";
    paintModal();
  }

  function showModal() {
    if (typeof document === "undefined") return;
    if (!modalEl) {
      modalEl = document.createElement("div");
      modalEl.className = "pg-modal";
      modalEl.setAttribute("role", "dialog");
      modalEl.setAttribute("aria-modal", "true");
      modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl || e.target.closest("[data-pg-close]")) { closeModal(); return; }
        const prev = e.target.closest("[data-pg-page]");
        if (prev && !prev.disabled) loadDetailPage(Number(prev.dataset.pgPage));
      });
      state.root?.append(modalEl);
    }
    // Escape 绑在 document 上（捕获阶段）而不是 modalEl：焦点一旦用 Tab 走到弹层外面的
    // 卡片按钮上，绑在弹层上的监听就收不到键了。关闭时立刻摘掉，不留常驻监听。
    if (!modalKeyHandler && typeof document !== "undefined") {
      modalKeyHandler = (e) => { if (e.key === "Escape" || e.keyCode === 27) closeModal(); };
      document.addEventListener("keydown", modalKeyHandler, true);
    }
    // 正在收起时又点开另一张卡：撤掉待删的定时器，同一节点重新亮起，
    // 而不是新建一个 —— 否则旧节点会盖在新节点上面继续淡出。
    clearTimeout(modalTimer);
    paintModal();
    // 先插入再置 on：同帧加类不会产生过渡，展开动画就没了。
    // 回调里再判一次 state.detail —— 同一帧内就被关掉（Escape / 点背板）时，
    // 迟到的 rAF 不能把 .on 又加回一个正在删除的节点上。
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    raf(() => { if (modalEl && state.detail) modalEl.classList.add("on"); });
    const btn = modalEl.querySelector("[data-pg-close]");
    if (btn && btn.focus) btn.focus();
  }

  function closeModal() {
    const node = modalEl;
    if (!node) return;
    state.detail = null;
    node.classList.remove("on");
    if (modalKeyHandler && typeof document !== "undefined") {
      document.removeEventListener("keydown", modalKeyHandler, true);
      modalKeyHandler = null;
    }
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const drop = () => { if (modalEl === node) modalEl = null; node.remove(); };
    clearTimeout(modalTimer);
    if (reduce) drop();
    else modalTimer = setTimeout(drop, 260);
  }

  function paintModal() {
    if (!modalEl) return;
    const d = state.detail;
    if (!d) return;
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const head = `<header><h3>${esc(d.title)}</h3><button type="button" data-pg-close aria-label="关闭">✕</button></header>`;
    let body;
    if (state.detailLoading) body = `<div class="pg-loading">正在读取明细…</div>`;
    else if (d.error) body = `<div class="pg-alert">${esc(d.error)}</div>`;
    else if (!d.rows.length) body = `<div class="pg-empty">这个指标暂时没有明细记录</div>`;
    else {
      body = `<div style="overflow:auto"><table class="pg-table"><thead><tr>${d.cols.map((c) => `<th>${esc(c.title)}</th>`).join("")}</tr></thead>`
        + `<tbody>${d.rows.map((r) => `<tr>${d.cols.map((c) => `<td>${esc(clean(r[c.key]) || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    const foot = `<div class="pg-modal-foot">`
      + `<button type="button" class="pg-btn" data-pg-page="${Math.max(1, d.page - 1)}" ${d.page <= 1 || state.detailLoading ? "disabled" : ""}>上一页</button>`
      + `<button type="button" class="pg-btn" data-pg-page="${Math.min(pages, d.page + 1)}" ${d.page >= pages || state.detailLoading ? "disabled" : ""}>下一页</button>`
      + `<span>第 ${d.page} / ${pages} 页 · 共 ${d.total} 条</span></div>`;
    modalEl.innerHTML = `<div class="pg-modal-card">${head}<div class="pg-modal-body">${body}</div>${foot}</div>`;
  }

  /* ── 渲染 ────────────────────────────────────────────────────────────── */
  const heroHtml = () => {
    const p = state.profile || {};
    const name = text(p.USERNAME, state.account || "在读学生");
    const id = text(p.USERID, "");
    const tags = [
      id ? { k: "学号", v: id } : null,
      clean(p.SEX) ? { k: "性别", v: clean(p.SEX) === "1" ? "男" : clean(p.SEX) === "2" ? "女" : clean(p.SEX) } : null,
      clean(p.MZ) ? { k: "民族", v: clean(p.MZ) } : null,
      clean(p.TEL) ? { k: "电话", v: clean(p.TEL) } : null,
      clean(p.BIRTHDATE) ? { k: "出生日期", v: day(p.BIRTHDATE) } : null,
      clean(p.BJ) ? { k: "班级", v: clean(p.BJ) } : null,
    ].filter(Boolean);
    const more = (state.learnTags || []).filter((t) => !tags.some((x) => x.v === t.v));
    const face = state.photo
      ? `<span class="pg-face"><img src="${esc(state.photo)}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="pg-face" aria-hidden="true">${esc(initial(name))}</span>`;
    return `<section class="pg-card pg-hero"><div class="pg-hero-in">${face}
<div class="pg-id"><div class="pg-eyebrow" style="color:inherit;opacity:.72">CPPU · 学生个人成长中心</div>
<h2>${esc(name)}</h2>${id ? `<div class="pg-no">学号 ${esc(id)}</div>` : ""}
<div class="pg-tags">${tags.map((t) => `<span class="pg-tag"><b>${esc(t.k)}</b>${esc(t.v)}</span>`).join("")}</div>
${more.length ? `<div class="pg-fold${state.expanded ? " open" : ""}" data-pg-fold>
<button type="button" data-pg-toggle aria-expanded="${state.expanded ? "true" : "false"}" aria-controls="pg-more-tags"><span class="pg-chev" aria-hidden="true">▸</span>更多档案字段（${more.length}）</button>
<div class="pg-shell" id="pg-more-tags" aria-hidden="${state.expanded ? "false" : "true"}"><div class="pg-clip"><div class="pg-tags" style="margin-top:8px">${more.map((t) => `<span class="pg-tag"><b>${esc(t.k)}</b>${esc(t.v)}</span>`).join("")}</div></div></div></div>` : ""}
</div></div></section>`;
  };

  const learnHtml = () => {
    const c = state.learn || {};
    const cells = [
      { k: "累计已修学分", v: num(c.GOTTENUNIT), u: "学分" },
      { k: "累计应修学分", v: num(c.TOTALUNIT), u: "学分" },
      { k: "GPA", v: num(c.GRADEPOINT), u: "" },
      { k: "本学期已获得学分", v: num(c.THISTERMGOTTENUNIT), u: "学分" },
    ];
    const any = cells.some((x) => x.v);
    return `<section class="pg-card pg-sec"><header><h3>学业概览</h3><span class="pg-sub">${any ? "来自教务处学分统计" : "暂无数据"}</span></header>
${any ? `<div class="pg-learn">${cells.map((x) => `<div class="pg-stat"><small>${esc(x.k)}</small><strong>${esc(x.v || "—")}</strong>${x.v && x.u ? `<em>${esc(x.u)}</em>` : ""}</div>`).join("")}</div>`
      : `<div class="pg-empty">还没有可用的学分数据</div>`}</section>`;
  };

  const kpiHtml = () => {
    if (!state.kpi.length) return "";
    const pages = Math.max(1, Math.ceil(state.kpi.length / 4));
    const page = Math.min(state.kpiPage, pages - 1);
    const slice = state.kpi.slice(page * 4, page * 4 + 4);
    const cards = slice.map((k, i) => {
      const bg = kpiBg(k.KPI_COLOR, page * 4 + i);
      const fg = kpiFg(bg);
      const name = clean(k.FORMNAME) || "指标";
      const value = num(k.KPICONFIG);
      const unit = clean(k.KPIUNIT);
      const icon = iconHtml(k.ICON);
      const badge = icon
        ? `<span class="pg-kpi-badge" aria-hidden="true">${icon}</span>`
        : `<span class="pg-kpi-badge" aria-hidden="true">${esc(initial(name))}</span>`;
      const wid = clean(k.WID);
      // 白字压在渐变最浅处时补一点描边阴影；深字不需要（加了反而糊）
      const shadow = fg === "#fff" ? ";text-shadow:0 1px 2px rgba(9,32,46,.32)" : "";
      return `<button type="button" class="pg-kpi" style="background:${esc(bg)};color:${esc(fg)}${shadow}"${wid ? ` data-pg-kpi="${esc(wid)}"` : " disabled"} title="${esc(wid ? `${name} · 点击查看明细` : name)}">
<span class="pg-kpi-name">${esc(name)}</span><span class="pg-kpi-num">${esc(value || "—")}${value && unit ? `<span class="pg-kpi-unit">${esc(unit)}</span>` : ""}</span>${badge}</button>`;
    }).join("");
    return `<section class="pg-card pg-sec"><header><h3>成长指标</h3><span class="pg-sub">${state.kpi.length} 项 · 点卡片看明细</span></header>
<div class="pg-kpis">${cards}</div>
${pages > 1 ? `<div class="pg-pager"><button type="button" data-pg-kpipage="${page - 1}" ${page <= 0 ? "disabled" : ""}>‹</button><span>${page + 1} / ${pages}</span><button type="button" data-pg-kpipage="${page + 1}" ${page >= pages - 1 ? "disabled" : ""}>›</button></div>` : ""}</section>`;
  };

  const flowHtml = () => {
    const c = state.consume || {}, o = state.online || {};
    const onConsume = state.tab === "consume";
    const rows = onConsume
      ? (Array.isArray(c.placeRanking) ? c.placeRanking : []).map((r) => ({ a: clean(r.MERCHANT) || "未知地点", b: clean(r.SPENDGMONEY) ? `${money(r.SPENDGMONEY)} 元` : "" }))
      : (Array.isArray(o.placeRanking) ? o.placeRanking : []).map((r) => ({ a: clean(r.PLACE) || "未知地点", b: clean(r.USETIME) || "" }));
    const body = rows.length
      ? `<ul class="pg-list">${rows.slice(0, 8).map((r) => `<li class="pg-row"><span class="pg-what">${esc(r.a)}</span><span class="pg-how">${esc(r.b || "—")}</span></li>`).join("")}</ul>`
      : `<div class="pg-empty" style="margin-top:10px">${state.partial ? "正在读取…" : onConsume ? "当月无消费记录" : "当月无上网记录"}</div>`;
    const metrics = onConsume
      ? `<div class="pg-flow"><div class="pg-f"><small>当月消费</small><strong>${esc(money(c?.balance?.TOTALAMOUNT) || "—")}</strong><em>元</em></div>
<div class="pg-f"><small>一卡通余额</small><strong>${esc(money(c?.balance?.BALANCE) || "—")}</strong><em>元</em></div></div>`
      : `<div class="pg-flow"><div class="pg-f"><small>累计时长</small><strong>${esc(text(o?.totalTime?.USETIME, "—"))}</strong></div></div>`;
    return `<section class="pg-card pg-sec"><header><h3>校园生活</h3>
<div class="pg-tabs" data-pg-tabs><button type="button" data-pg-tab="consume" aria-pressed="${onConsume ? "true" : "false"}">我的消费</button><button type="button" data-pg-tab="online" aria-pressed="${onConsume ? "false" : "true"}">我的上网</button></div>
<button type="button" class="pg-more" data-pg-open="${onConsume ? "/stu/dataReport/consumption" : "/stu/dataReport/onlineInfo"}">查看更多</button></header>
${metrics}${body}
<p class="pg-note">消费与上网数据来自一卡通与校园网，可能滞后于部门系统实时数据。</p></section>`;
  };

  const recordHtml = () => {
    const attend = state.attend.map((a) => {
      const qs = clean(a.QSSJ), jz = clean(a.JZSJ);
      return {
        when: qs ? `${day(qs)} ${clock(qs)}${jz ? ` ~ ${clock(jz)}` : ""}`.trim() : "",
        what: clean(a.CQLX) || "出勤记录",
        how: "",
      };
    }).filter((r) => r.what);
    const bonus = state.bonus.map((b) => ({
      when: day(b.SHOWTIME),
      what: clean(b.BONUSPENALTY) || "奖惩记录",
      how: clean(b.TYPE),
    })).filter((r) => r.what);
    const block = (title, sub, list, empty) => `<section class="pg-card pg-sec"><header><h3>${esc(title)}</h3><span class="pg-sub">${esc(sub)}</span></header>
${list.length ? `<ul class="pg-list">${list.slice(0, 10).map((r) => `<li class="pg-row">${r.when ? `<span class="pg-when">${esc(r.when)}</span>` : ""}<span class="pg-what">${esc(r.what)}</span>${r.how ? `<span class="pg-how">${esc(r.how)}</span>` : ""}</li>`).join("")}</ul>`
      : `<div class="pg-empty">${esc(empty)}</div>`}</section>`;
    return `<div style="display:grid;gap:14px" class="pg-two">`
      + block("我的考勤", attend.length ? `${attend.length} 条` : state.partial ? "读取中" : "暂无", attend, state.partial ? "正在读取…" : "暂无出勤记录")
      + block("奖惩记录", bonus.length ? `${bonus.length} 条` : state.partial ? "读取中" : "暂无", bonus, state.partial ? "正在读取…" : "暂无奖惩记录")
      + `</div>`;
  };

  const moduleHtml = () => {
    if (!state.modules.length) return "";
    return `<section class="pg-card pg-sec"><header><h3>数据中心</h3><span class="pg-sub">在浏览器中打开</span></header>
<div class="pg-grid">${state.modules.map((m) => `<button type="button" class="pg-entry" data-pg-open="/stu/dataReport/${encodeURIComponent(m.key)}"><i aria-hidden="true"></i><span>${esc(m.name)}</span></button>`).join("")}</div>
<p class="pg-note">这些入口需要统一身份认证会话；浏览器里如果要求登录，先用「警大通知」登录一次即可复用。</p></section>`;
  };

  function toolbarHtml() {
    const at = state.loadedAt ? new Date(state.loadedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
    return `<div class="pg-bar">
<button type="button" class="pg-btn pg-primary" data-pg-refresh ${state.loading ? "disabled" : ""}>${state.loading ? "正在刷新…" : "刷新"}</button>
<button type="button" class="pg-btn" data-pg-home>去个人成长中心</button>
<button type="button" class="pg-btn" data-pg-relogin>重新登录</button>
<span class="pg-when">${at ? `更新于 ${esc(at)}` : "尚未取到数据"}</span></div>`;
  }

  function paint() {
    const root = state.root;
    if (!root) return;
    styles();
    if (state.loading && !state.loadedAt) {
      root.innerHTML = `<div class="pg-wrap">${toolbarHtml()}<div class="pg-card"><div class="pg-loading">正在读取个人成长数据…</div></div></div>`;
      bind(root);
      return;
    }
    if (state.error && !state.loadedAt) {
      root.innerHTML = `<div class="pg-wrap">${toolbarHtml()}
<div class="pg-card pg-sec"><div class="pg-alert"><b>${state.loginNeeded ? "需要先登录统一身份认证" : "个人成长中心暂时不可用"}</b><br>${esc(state.error)}<br>${state.loginNeeded ? "先在「警大通知」里完成一次登录，再回到本页刷新。" : "校园网 / 内网代理不通时也会这样，稍后再试。"}</div></div></div>`;
      bind(root);
      return;
    }
    root.innerHTML = `<div class="pg-wrap">${toolbarHtml()}
${state.stale ? `<div class="pg-card pg-sec"><div class="pg-alert">${esc(state.stale)}</div></div>` : ""}
${heroHtml()}${learnHtml()}${kpiHtml()}${flowHtml()}${recordHtml()}${moduleHtml()}</div>`;
    bind(root);
  }

  function attachGlow(root) {
    for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    const box = root.querySelector?.("[data-pg-tabs]");
    if (!box) return;
    let handle = null;
    try { handle = tide.ui?.selectionGlow?.(box, { selector: 'button[aria-pressed="true"]' }) || null; } catch { handle = null; }
    if (handle) glowHandles.push(handle);
  }

  function bind(root) {
    const on = (sel, fn) => { const n = root.querySelector(sel); if (n) n.onclick = fn; };
    on("[data-pg-refresh]", () => loadAll(true));
    on("[data-pg-home]", () => bridge?.open?.("/stu/home/"));
    on("[data-pg-relogin]", async () => {
      const btn = root.querySelector("[data-pg-relogin]");
      if (btn) { btn.disabled = true; btn.textContent = "正在重新登录…"; }
      let result = "fail";
      try { result = (await bridge?.relogin?.()) || "fail"; } catch { result = "fail"; }
      if (result === "ok") { state.error = ""; state.stale = ""; loadAll(true); return; }
      // 换不到票 ⇒ 插件的统一身份认证会话不在。**不动现有画面**：这里要是重画，
      // 用户看到的是一片空白，连该去哪儿登录的提示都读不到。
      if (btn) { btn.disabled = false; btn.textContent = "重新登录"; }
      tide.notify?.(result === "form" ? "请先在「警大通知」里登录一次，再回到本页刷新" : "重新登录失败，请稍后再试");
    });
    // 身份卡的「更多字段」：就地切类名（不重画），展开 / 收起都走同一段过渡。
    const fold = root.querySelector("[data-pg-fold]");
    if (fold) {
      const btn = fold.querySelector("[data-pg-toggle]");
      const shell = fold.querySelector(".pg-shell");
      btn.onclick = () => {
        state.expanded = !state.expanded;
        fold.classList.toggle("open", state.expanded);
        btn.setAttribute("aria-expanded", state.expanded ? "true" : "false");
        shell.setAttribute("aria-hidden", state.expanded ? "false" : "true");
      };
    }
    // 单选切换：只切 aria-pressed，让宿主的光块自己滑过去（重建 DOM 会把光块变成孤儿）。
    for (const btn of root.querySelectorAll("[data-pg-tab]")) {
      btn.onclick = () => {
        if (state.tab === btn.dataset.pgTab) return;
        state.tab = btn.dataset.pgTab;
        persist();
        paint();
      };
    }
    for (const btn of root.querySelectorAll("[data-pg-kpipage]")) {
      btn.onclick = () => {
        const p = Number(btn.dataset.pgKpipage);
        const pages = Math.max(1, Math.ceil(state.kpi.length / 4));
        if (!Number.isFinite(p) || p < 0 || p >= pages) return;
        state.kpiPage = p;
        paint();
      };
    }
    for (const btn of root.querySelectorAll("[data-pg-kpi]")) {
      btn.onclick = () => {
        const row = state.kpi.find((k) => clean(k.WID) === btn.dataset.pgKpi);
        if (row) openDetail(row);
      };
    }
    for (const btn of root.querySelectorAll("[data-pg-open]")) {
      btn.onclick = async () => {
        const path = btn.dataset.pgOpen;
        if (btn.setAttribute) btn.setAttribute("aria-busy", "1");
        try { await bridge?.open?.(path); }
        catch { tide.notify?.("打开失败，请稍后再试"); }
        finally { if (btn.removeAttribute) btn.removeAttribute("aria-busy"); }
      };
    }
    attachGlow(root);
  }

  function persist() {
    try { tide.storage?.set?.(KEY, { tab: state.tab }); } catch { /* ignore */ }
  }

  function render(host) {
    state.disposed = false;
    state.root = host;
    styles();
    host.innerHTML = `<div class="pg-wrap"><div class="pg-card"><div class="pg-loading">正在读取个人成长数据…</div></div></div>`;
    Promise.resolve(tide.storage?.get?.(KEY, null)).then((saved) => {
      if (state.disposed) return;
      if (saved && (saved.tab === "consume" || saved.tab === "online")) state.tab = saved.tab;
    }).catch(() => {}).finally(() => { if (!state.disposed) loadAll(); });
    return () => {
      state.disposed = true;
      state.root = null;
      clearTimeout(modalTimer);
      if (modalKeyHandler && typeof document !== "undefined") {
        document.removeEventListener("keydown", modalKeyHandler, true);
        modalKeyHandler = null;
      }
      for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
      if (modalEl) { modalEl.remove(); modalEl = null; }
      state.detail = null;
    };
  }

  return { render, refresh: () => loadAll() };
}
