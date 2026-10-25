// 警大门户通知 · 个人信息（pdata.cppu.edu.cn/stu/home + /stu/dataReport/basicInfo）
//
// v0.281.0：「学生成长」并进本页。原来侧栏里是两个视图（个人信息 / 学生成长），
// 但它们打的是同一套 pdata 接口 —— 身份卡、档案字段、数据报告目录两边各画了一遍，
// 用户要在两个入口之间来回跳才能看全一个人。现在只有一个「个人信息」，按「我是谁 →
// 我在学校的数据 → 我能取哪些报表」排下来：
//   ① 身份卡（头像 / 姓名 / 学号 / 性别…；每个标签都能点着复制）
//   ② 工具条（复制全部 / 打开原页 / 刷新 / 重新登录 / 已复制计数 / 更新于）
//   ③ 学业概览（累计已修 / 应修学分 / GPA / 本学期已获得）
//   ④ 成长指标（后台配的指标卡，点开看明细表；分页）
//   ⑤ 校园生活（我的消费 / 我的上网，单选切换）
//   ⑥ 我的考勤 / 奖惩记录
//   ⑦ 档案字段（每格一个字段，点格子即复制；可筛选；复制记录折叠）
//   ⑧ 数据报告目录（学校给在读学生开放的全部报表，点开带会话直达）
//
// 边界：本模块**不碰** SSO / 密码 / vault / Cookie —— 那是 main.js 的事。
// 一切取数走 bridge.api(path)，鉴权（换票 → validateLogin → token）与一次性重登
// 由 main.js 内部处理；本模块只认「拿到 data / 没拿到」两种结果。
//
// 取数口径对齐网页（反解自 pdata 学生端 umi.js）：
//   GET /tsa/shc/homepage/personInfo            → { personInfo, column, personPhoto, … }
//   GET /tsa/shc/learnInfo/learnSituation       → 学分 / 绩点
//   GET /tsa/shc/homepage/getKpiList            → 指标卡
//   GET /tsa/shc/homepage/getKpiDetailInfo      → 指标明细（点卡片才发）
//   GET /tsa/shc/homepage/cardConsume           → 当月消费
//   GET /tsa/shc/homepage/onlineState           → 当月上网
//   GET /tsa/shc/homepage/getMyAttendance       → 考勤
//   GET /tsa/shc/homepage/bonusPenaltyList      → 奖惩
//   GET /tsa/shc/customStyle/getModuleList      → 数据报告目录（含 basicInfo 自己）
// personInfo **不要**加 _USER：服务端按 token 认人，带上反而命中空集（见 main.js pdataApi）。
// 字段名一律用接口原样的大写名，不在这里改名 —— 出问题时能直接对着抓包看。
//
// 值不进 DOM 属性：所有可复制项只带**数组下标**，值统一从 state 里取。
// 后台的字段值里出现过引号与换行，塞进 data-* 迟早会漏一处转义。

export function createProfileView(tide, bridge) {
  const KEY = "profileViewPreferences";
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
  const clockOf = (v) => {
    const s = clean(v);
    const m = s.match(/(\d{1,2}:\d{2})(?::\d{2})?/);
    return m ? m[1] : s;
  };
  const sexText = (v) => {
    const s = clean(v);
    if (s === "1") return "男";
    if (s === "2") return "女";
    return s;
  };
  const photoSrc = (raw) => {
    const s = clean(raw);
    if (!s) return "";
    if (/^data:image\//i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    return `data:image/jpeg;base64,${s}`;
  };
  const initial = (name) => {
    const s = clean(name);
    if (!s) return "人";
    return /^[\u4e00-\u9fa5]+$/.test(s) ? s.slice(-1) : s.slice(0, 1).toUpperCase();
  };

  /* 后台给的 KPI_COLOR 是 hex（少数部署给的是渐变串）；非法 / 缺省时按位次退回四色轮转
     —— 色相取自网页「数据导航页」的 .KUCard .generl 渐变。网页那套是给浅色图标底用的，
     白字压在最浅处只有 1.75:1；这里把两端都压深，使 12.5px 白字（指标名）也能到 ≥4.6:1。 */
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
  /* 指标卡的底色是后台给的，深浅不可控（实测有 #FCA271 这类浅色，白字只有 1.99:1）。
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

  /** 身份卡上已经占掉的字段，字段网格里不再重复（对应网页的 column.splice(0,3)）。 */
  const HERO_FIELDS = new Set(["USERNAME", "XM", "USERID", "ZGH", "XH", "SEX", "XB"]);

  const state = {
    root: null, disposed: false, loading: false, error: "", loginNeeded: false, stale: "",
    account: "", profile: null, photo: "", fields: [], heroTags: [], rows: [],
    query: "", copied: 0, history: [], histOpen: false,
    tab: "consume", kpiPage: 0, detail: null, detailLoading: false,
    learn: null, kpi: [], consume: null, online: null, attend: [], bonus: [], dirs: [],
    loadedAt: 0, inFlight: 0, partial: false,
  };
  const glowHandles = [];
  let modalEl = null, modalTimer = 0, modalKeyHandler = null;

  /* ── 样式 ──────────────────────────────────────────────────────────────
     安全区：本模块只画宿主给的那个容器里的内容，四条边由宿主 .view 负责，这里
     **不垫第二遍**。唯一例外是 .pf-modal（position:fixed，包含块是 .view 的
     padding box，宿主 padding 拦不住它），四边自己让开。
     复制兜底的离屏 textarea 是 absolute + left:-9999px，不贴任何一条边，同样不用管。 */
  function styles() {
    if (typeof document === "undefined" || document.getElementById("pf-profile-style")) return;
    const node = document.createElement("style");
    node.id = "pf-profile-style";
    node.textContent = `.pf-wrap{max-width:900px;margin:0 auto;display:grid;gap:14px}
.pf-card{border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--panel);color:var(--ink);overflow:hidden}
.pf-sec{padding:15px 16px}
.pf-sec>header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.pf-sec h3{margin:0;font-size:calc(15px * var(--ui-text-scale));letter-spacing:.02em}
.pf-sec>header .pf-sub{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);white-space:nowrap}
.pf-eyebrow{font-size:calc(10.5px * var(--ui-text-scale));letter-spacing:.26em;color:var(--ink-3,#7E8B94)}
/* ① 身份卡 */
.pf-hero{position:relative;border:0;background:linear-gradient(135deg,var(--deep,#0F4C5C) 0%,var(--sea,#118AB2) 100%);color:var(--on-accent,#fff)}
.pf-hero-in{display:flex;align-items:center;gap:15px;padding:17px 18px}
.pf-face{flex:none;width:64px;height:64px;border-radius:50%;overflow:hidden;background:color-mix(in srgb,#fff 22%,transparent);display:grid;place-items:center;font-size:calc(24px * var(--ui-text-scale));font-weight:600;border:2px solid color-mix(in srgb,#fff 45%,transparent)}
.pf-face img{width:100%;height:100%;object-fit:cover;display:block}
.pf-id{min-width:0;flex:1 1 auto}
.pf-id h2{margin:0;font-size:calc(20px * var(--ui-text-scale));font-weight:600;overflow-wrap:anywhere}
.pf-id .pf-no{margin-top:3px;font-size:calc(12px * var(--ui-text-scale));opacity:.86;font-variant-numeric:tabular-nums}
.pf-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
/* 标签底用 --panel 而不是「白/黑半透明」：渐变那两端的明度在各主题里方向相反
   （浅色主题 --sea 偏亮、night 那类深色主题 --deep/--sea 也偏亮），
   按一个方向叠半透明层，总有一套主题会把对比度压到 3:1 上下。
   走 --panel + --ink 就是主题测试里已经按 ≥7:1 约束过的那一对，两个方向都稳。 */
.pf-tag{font:inherit;font-size:calc(11px * var(--ui-text-scale));color:var(--ink);padding:6px 12px;border-radius:999px;background:var(--panel);border:1px solid color-mix(in srgb,var(--panel) 45%,var(--line));white-space:nowrap;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;min-height:34px;transition:background .18s ease,border-color .18s ease}
.pf-tag:hover{border-color:var(--sea,#118AB2)}
.pf-tag:focus-visible{outline:2px solid var(--sea,#118AB2);outline-offset:2px}
.pf-tag b{font-weight:600;color:var(--ink-2,#7E8B94);margin-right:4px}
.pf-tag.pf-copied{background:color-mix(in srgb,var(--sea,#118AB2) 18%,var(--panel));border-color:var(--sea,#118AB2)}
/* ② 工具条 */
.pf-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.pf-bar .pf-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
.pf-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 13px;min-height:38px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .16s ease}
.pf-btn:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel))}
.pf-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.pf-btn.pf-primary{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.pf-btn.pf-primary:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 86%,#000)}
.pf-btn:disabled{opacity:.5;cursor:default}
/* ③ 学业概览 */
.pf-learn{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.pf-stat{border:1px solid var(--line);border-radius:12px;padding:12px 13px;background:color-mix(in srgb,var(--deep,#0F4C5C) 5%,var(--panel))}
.pf-stat small{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);margin-bottom:6px}
.pf-stat strong{font-size:calc(22px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;color:var(--deep,#0F4C5C)}
.pf-stat em{font-style:normal;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-left:3px}
/* ④ 成长指标 */
.pf-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.pf-kpi{position:relative;display:block;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:#fff;border:0;border-radius:12px;padding:13px 14px;min-height:92px;cursor:pointer;overflow:hidden;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .18s ease,box-shadow .18s ease}
.pf-kpi:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg,0 10px 32px rgba(34,48,58,.16))}
.pf-kpi:focus-visible{outline:2px solid color-mix(in srgb,#fff 70%,transparent);outline-offset:-3px}
.pf-kpi .pf-kpi-name{font-size:calc(12.5px * var(--ui-text-scale));opacity:.94;display:block;overflow-wrap:anywhere}
.pf-kpi .pf-kpi-num{margin-top:7px;font-size:calc(24px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.pf-kpi .pf-kpi-unit{font-size:calc(11.5px * var(--ui-text-scale));opacity:.9;margin-left:3px;font-weight:400}
.pf-kpi .pf-kpi-badge{position:absolute;right:11px;bottom:11px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:calc(13px * var(--ui-text-scale));border:1px solid currentColor;opacity:.92}
.pf-kpi .pf-kpi-badge svg{width:16px;height:16px}
.pf-pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:10px}
.pf-pager button{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:6px 11px;min-height:34px;cursor:pointer;touch-action:manipulation}
.pf-pager button:disabled{opacity:.42;cursor:default}
.pf-pager span{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
/* ⑤ 消费 / 上网 */
.pf-tabs{display:inline-flex;position:relative;isolation:isolate;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
/* 铁律六：单选组高亮 = 一块随选择滑动的光（宿主 selectionGlow.js 画），选中按钮不再自画静态底。 */
.pf-tabs .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;transition:opacity .2s linear;border-radius:10px;background:var(--deep,#0F4C5C)}
.pf-tabs .selection-glow.on{opacity:1}
.pf-tabs.has-selection-glow button{position:relative;z-index:1}
.pf-tabs.has-selection-glow button[aria-pressed=true]{background:transparent}
.pf-tabs button{font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:inherit;background:transparent;border:0;padding:8px 14px;min-height:36px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,color .18s ease}
.pf-tabs button+button{border-left:1px solid var(--line)}
.pf-tabs button[aria-pressed=true]{background:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.pf-flow{background:linear-gradient(-90deg,color-mix(in srgb,var(--deep,#0F4C5C) 14%,var(--panel)),color-mix(in srgb,var(--sea,#118AB2) 22%,var(--panel)));border-radius:12px;padding:13px 15px;display:flex;gap:22px;flex-wrap:wrap}
.pf-flow .pf-f{border:0;background:transparent;padding:0}
.pf-flow small{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-bottom:5px}
.pf-flow strong{font-size:calc(21px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;color:var(--deep,#0F4C5C)}
.pf-flow em{font-style:normal;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-left:3px}
.pf-list{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:7px}
.pf-row{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:11px;padding:9px 12px;background:var(--panel);font-size:calc(12.5px * var(--ui-text-scale))}
.pf-row .pf-when{flex:none;color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums;font-size:calc(11.5px * var(--ui-text-scale))}
.pf-row .pf-what{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pf-row .pf-how{flex:none;font-weight:600;color:var(--deep,#0F4C5C);font-variant-numeric:tabular-nums;text-align:right}
.pf-two{display:grid;gap:14px}
.pf-more{font:inherit;font-size:calc(11.5px * var(--ui-text-scale));color:var(--deep,#0F4C5C);background:transparent;border:0;padding:0;cursor:pointer;text-decoration:underline;white-space:nowrap}
/* ⑦ 档案字段 */
.pf-search{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:7px 11px;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel));margin-bottom:11px}
.pf-search svg{flex:none;width:15px;height:15px;opacity:.6}
.pf-search input{flex:1 1 auto;min-width:0;font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:inherit;background:transparent;border:0;outline:none}
.pf-search input::placeholder{color:var(--ink-3,#7E8B94)}
.pf-search button{font:inherit;font-size:calc(14px * var(--ui-text-scale));line-height:1;color:var(--ink-3,#7E8B94);background:transparent;border:0;border-radius:8px;padding:6px 9px;min-height:34px;cursor:pointer}
.pf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:9px}
/* 每个字段就是一颗「点一下就复制」的按钮 */
.pf-cell{position:relative;display:block;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:inherit;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel));border:1px solid var(--line);border-radius:11px;padding:9px 12px 10px;min-height:56px;cursor:pointer;overflow:hidden;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,border-color .18s ease,transform .18s ease}
.pf-cell[hidden]{display:none}
.pf-cell:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 11%,var(--panel))}
.pf-cell:active{transform:scale(.985)}
.pf-cell:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.pf-cell.pf-copied{background:color-mix(in srgb,var(--sea,#118AB2) 22%,var(--panel));border-color:color-mix(in srgb,var(--sea,#118AB2) 52%,var(--line))}
.pf-cell.pf-empty{cursor:default;opacity:.62;background:transparent}
.pf-cell.pf-empty:hover{background:transparent}
.pf-cell .pf-k{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);margin-bottom:4px;overflow-wrap:anywhere}
.pf-cell .pf-v{display:block;font-size:calc(13px * var(--ui-text-scale));font-weight:600;overflow-wrap:anywhere;word-break:break-word}
.pf-cell .pf-flag{position:absolute;right:9px;top:8px;font-size:calc(10px * var(--ui-text-scale));color:var(--sea,#118AB2);opacity:0;transition:opacity .2s ease}
.pf-cell.pf-copied .pf-flag{opacity:1}
/* 复制记录：铁律七 —— 展开 / 收起都要有中间帧（grid-template-rows 0fr↔1fr 可连续插值）。
   visibility 一起过渡：收起后内部按钮不再可点、也不进 Tab 序（0fr + overflow 只裁不封）。 */
.pf-fold{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
.pf-fold>button{font:inherit;font-size:calc(11.5px * var(--ui-text-scale));color:var(--deep,#0F4C5C);background:transparent;border:0;padding:2px 0;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:34px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.pf-fold>button .pf-chev{display:inline-block;transition:transform .3s cubic-bezier(.2,.78,.2,1)}
.pf-fold.open>button .pf-chev{transform:rotate(90deg)}
.pf-shell{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;transition:grid-template-rows .34s cubic-bezier(.2,.8,.2,1),opacity .22s ease,visibility .34s}
.pf-fold.open .pf-shell{grid-template-rows:1fr;opacity:1;visibility:visible}
.pf-clip{min-height:0;overflow:hidden}
.pf-hist{display:grid;gap:6px;padding-top:8px}
.pf-hist button{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font:inherit;font-size:calc(12px * var(--ui-text-scale));text-align:left;color:inherit;background:transparent;border:1px solid var(--line);border-radius:10px;padding:7px 11px;min-height:38px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.pf-hist button:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel))}
.pf-hist .pf-hk{flex:none;color:var(--ink-3,#7E8B94);font-size:calc(11px * var(--ui-text-scale));min-width:76px;max-width:34%;overflow-wrap:anywhere}
.pf-hist .pf-hv{flex:1 1 auto;min-width:0;font-weight:600;overflow-wrap:anywhere;word-break:break-word}
.pf-empty{border:1px dashed var(--line);border-radius:11px;padding:15px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12px * var(--ui-text-scale));line-height:1.85}
.pf-note{margin:11px 0 0;font-size:calc(11px * var(--ui-text-scale));line-height:1.85;color:var(--ink-3,#7E8B94)}
/* ⑧ 数据报告目录：一格一个报表，点开在应用内网页窗口里直达 */
.pf-dirs{display:grid;grid-template-columns:repeat(auto-fill,minmax(198px,1fr));gap:9px}
.pf-dir{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font:inherit;font-size:calc(12.5px * var(--ui-text-scale));text-align:left;color:inherit;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel));border:1px solid var(--line);border-radius:11px;padding:10px 12px;min-height:44px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .16s ease}
.pf-dir:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 11%,var(--panel))}
.pf-dir:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.pf-dir .pf-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--deep,#0F4C5C);opacity:.7}
.pf-dir .pf-dn{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pf-dir .pf-go{flex:none;color:var(--ink-3,#7E8B94);font-size:calc(12px * var(--ui-text-scale))}
.pf-loading{padding:26px 16px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12.5px * var(--ui-text-scale))}
.pf-alert{border:1px solid color-mix(in srgb,var(--danger,#B03535) 42%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 8%,var(--panel));border-radius:11px;padding:12px 14px;font-size:calc(12px * var(--ui-text-scale));line-height:1.85;color:var(--ink)}
/* 指标明细弹层：position:fixed 是唯一逃出宿主 .view 的定位，四边自己让开安全区。 */
.pf-modal{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:calc(16px + var(--sat,env(safe-area-inset-top,0px))) calc(16px + var(--sar,env(safe-area-inset-right,0px))) calc(16px + var(--sab,env(safe-area-inset-bottom,0px))) calc(16px + var(--sal,env(safe-area-inset-left,0px)));background:color-mix(in srgb,#000 46%,transparent);opacity:0;transition:opacity .22s ease}
.pf-modal.on{opacity:1}
.pf-modal-card{width:100%;max-width:640px;max-height:100%;display:flex;flex-direction:column;border-radius:var(--radius,14px);background:var(--panel);color:var(--ink);border:1px solid var(--line);box-shadow:var(--shadow-lg,0 10px 32px rgba(34,48,58,.16));overflow:hidden;transform:translateY(14px) scale(.985);opacity:0;transition:transform .26s cubic-bezier(.2,.8,.2,1),opacity .22s ease}
.pf-modal.on .pf-modal-card{transform:none;opacity:1}
.pf-modal-card>header{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--line)}
.pf-modal-card>header h3{margin:0;font-size:calc(14.5px * var(--ui-text-scale));flex:1 1 auto;overflow-wrap:anywhere}
.pf-modal-card>header button{font:inherit;font-size:calc(16px * var(--ui-text-scale));line-height:1;color:var(--ink-2,#4A5A66);background:transparent;border:0;border-radius:9px;padding:6px 10px;min-height:34px;cursor:pointer}
.pf-modal-body{padding:13px 15px;overflow:auto}
.pf-table{width:100%;border-collapse:collapse;font-size:calc(12px * var(--ui-text-scale))}
.pf-table th,.pf-table td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.pf-table th{background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel));font-weight:600;white-space:nowrap}
.pf-table td{font-variant-numeric:tabular-nums}
.pf-modal-foot{display:flex;align-items:center;gap:9px;padding:11px 15px;border-top:1px solid var(--line)}
.pf-modal-foot span{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
@media(max-width:760px){.pf-learn,.pf-kpis{grid-template-columns:repeat(2,1fr)}.pf-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}}
@media(max-width:420px){.pf-learn,.pf-kpis{grid-template-columns:1fr 1fr}.pf-grid{grid-template-columns:1fr}.pf-hero-in{gap:12px}.pf-face{width:54px;height:54px}}
@media(prefers-reduced-motion:reduce){.pf-shell,.pf-fold>button .pf-chev,.pf-cell,.pf-tag,.pf-kpi,.pf-modal,.pf-modal-card,.pf-tabs button{transition-duration:.01ms!important}}`;
    document.head.append(node);
  }

  /* ── 剪贴板 ────────────────────────────────────────────────────────────
     优先 navigator.clipboard（Tauri 的 WebView 是安全上下文，一般都有）；
     拿不到（老 WebView / 非安全上下文）时退回 execCommand 通道，别让用户点了没反应。 */
  async function copyText(value) {
    const v = String(value ?? "");
    if (!v) return false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(v); return true; }
    } catch { /* 落到 execCommand */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = v;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch { return false; }
  }

  /** 大小写不敏感取键：接口在不同部署里 camelCase / UPPER 都出现过。 */
  function pick(obj, ...keys) {
    if (!obj || typeof obj !== "object") return "";
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
    for (const k of keys) {
      const real = lower.get(k.toLowerCase());
      if (real !== undefined && obj[real] !== undefined && obj[real] !== null) return obj[real];
    }
    return "";
  }

  /** column[] + personInfo 摊成 [{k,v}]：值取 <dataField>_CN 优先（字典表字段的中文名）。 */
  function buildFields(data) {
    const info = pick(data, "personInfo") || {};
    const cols = pick(data, "column");
    const out = [];
    const seen = new Set();
    if (Array.isArray(cols)) {
      for (const c of cols) {
        if (!c || typeof c !== "object") continue;
        const field = clean(pick(c, "dataField"));
        const label = clean(pick(c, "dataFieldName")) || field;
        if (!label) continue;
        const cn = field ? clean(info[field + "_CN"]) : "";
        const raw = cn || (field ? clean(info[field]) : "");
        if (seen.has(label)) continue;
        seen.add(label);
        out.push({ k: label, v: raw, key: field || label });
      }
    }
    // column 缺失或过短时的兜底：直接扫 personInfo 的键。
    // <FIELD>_CN 才是给人看的（FIELD 里常是字典码），所以见到 _CN 优先、并跳过它的裸键。
    if (out.length < 3) {
      for (const k of Object.keys(info)) {
        const isCn = /_CN$/.test(k);
        const base = isCn ? k.slice(0, -3) : k;
        if (!isCn && Object.prototype.hasOwnProperty.call(info, base + "_CN")) continue;
        if (seen.has(base)) continue;
        const v = clean(info[k]);
        if (!v) continue;
        seen.add(base);
        out.push({ k: base, v, key: base });
      }
    }
    return out.filter((f) => f.k);
  }

  /** 数据报告目录：取「数据报告」那一组的 children，拿不到就摊平所有组。
      老版本接口只给 id（形如 "1-13-basicInfo"），按最后一个 '-' 后面那截当目录名 ——
      那正是 basicInfo / bookRent 这类值，拼进 /stu/dataReport/<key> 就是网页那张页。 */
  function buildReports(data) {
    const list = Array.isArray(data) ? data : [];
    const group = list.find((g) => clean(pick(g, "id")) === "1-DataReport" || clean(pick(g, "name")) === "数据报告");
    const children = group && Array.isArray(group.children)
      ? group.children
      : list.flatMap((g) => (Array.isArray(g?.children) ? g.children : []));
    const seen = new Set();
    const out = [];
    for (const c of children) {
      if (!c || typeof c !== "object") continue;
      const name = clean(pick(c, "name"));
      const key = clean(pick(c, "CATALOGID", "catalogId")) || clean(pick(c, "id")).split("-").slice(-1)[0];
      if (!name || !key || seen.has(key)) continue;
      seen.add(key);
      out.push({ name, key });
    }
    return out;
  }

  /* ── 取数 ────────────────────────────────────────────────────────────── */
  /* `force` 只在用户按「刷新」时为真：要求 bridge 绕过它那份缓存。老宿主没给 force
     通道时退回普通取数 —— 宁可慢一次，也不要「点了刷新没反应」。 */
  const call = (path, force = false) => Promise.resolve(force && bridge?.force ? bridge.force(path) : bridge?.api?.(path)).then((r) => (r && typeof r === "object" ? r : { ok: false, message: "取数通道不可用" }));

  /* 刷新等待蒙版（v0.233.0）：这一页要并发打 8 个 pdata 接口，首次进入整屏只有一句占位。
     蒙版盖在这句占位之上（占位保留，作为老宿主的兜底）。包一层而不是在原函数里散点
     release：里面有多条 return，散点极易漏掉一条。
     v0.236.0：**手里已经有数据时不再打蒙版** —— 蒙版是给「什么都没有」的首次进入用的。 */
  const waitMask = (textLabel) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(textLabel) : () => {});

  /* ── 本地缓存（v0.268.0 起，v0.281.0 合并时保持）──────────────────────────
     快照落盘（tide.cache → 独立 JSON 文件，不进 data.json），时效 30 天。
     依据是这一页的数据本来就不勤变 —— 学分 / 绩点按学期走、KPI 是月度表、档案字段
     一学年也不动；而它每次打开要并发打 8 个 pdata 接口，断网或校园网不通就整页空白。
     现在的行为：
       · 30 天内（含重启应用）打开 ⇒ 直接画磁盘上的快照，**一个请求都不发**；
       · 超过 30 天 ⇒ 才自动重抓一次，抓完把新快照写回去；
       · 手动「刷新」/ 重新登录成功 ⇒ 永远 force，绕过这两条时效。 */
  const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
  const SNAPSHOT_KEY = "profileSnapshot";
  /* v0.281.0 之前快照分两份（growthSnapshot 是学生成长页的）。合并后 key 换成一份，
     旧 key 只可能是半页数据，直接在读盘时丢掉，别让它继续占地方。 */
  const LEGACY_SNAPSHOT_KEY = "growthSnapshot";
  /** 能从磁盘恢复的字段（与 state 同名，恢复时不用再对表）。
      其余如 error / stale / loading / tab / detail 是「当下状态」的产物，缓存它们只会撒谎。 */
  const SNAPSHOT_FIELDS = ["profile", "photo", "fields", "learn", "kpi", "consume", "online", "attend", "bonus", "dirs"];
  /* tide.cache 是 v0.247.0 才有的宿主能力；老宿主 / 测试替身没有它时安静退化成「没有缓存」，
     绝不能因此把页面弄崩 —— 缓存是加速，不是必需品。 */
  const hasCache = () => !!(tide.cache && typeof tide.cache.get === "function");
  const cacheGet = (key, fallback = null) =>
    hasCache() ? Promise.resolve(tide.cache.get(key, fallback)).catch(() => fallback) : Promise.resolve(fallback);
  const cacheSet = (key, value) =>
    (tide.cache && typeof tide.cache.set === "function")
      ? Promise.resolve(tide.cache.set(key, value)).catch(() => {})
      : Promise.resolve();
  const cacheRemove = (key) => {
    if (!tide.cache) return;
    const fn = tide.cache.remove || tide.cache.delete;
    if (typeof fn === "function") { try { Promise.resolve(fn.call(tide.cache, key)).catch(() => {}); } catch { /* ignore */ } }
  };

  function snapshotOf() {
    const out = { savedAt: state.loadedAt, partial: state.partial ? 1 : 0 };
    for (const f of SNAPSHOT_FIELDS) out[f] = state[f];
    return out;
  }

  /** 恢复快照，返回是否真的用上了。形状不对一律当「没有缓存」——
      宁可重抓一次，也不能让一份半截缓存把整页画成空白。 */
  function restoreSnapshot(saved) {
    if (!saved || typeof saved !== "object") return false;
    const at = Number(saved.savedAt) || 0;
    // 没有身份卡 ⇔ 从来没抓到过有效首屏：这种快照只有半页，不如重抓。
    if (!at || !saved.profile || typeof saved.profile !== "object") return false;
    state.profile = saved.profile;
    state.photo = typeof saved.photo === "string" ? saved.photo : "";
    state.fields = Array.isArray(saved.fields) ? saved.fields : [];
    state.learn = saved.learn && typeof saved.learn === "object" ? saved.learn : null;
    state.consume = saved.consume && typeof saved.consume === "object" ? saved.consume : null;
    state.online = saved.online && typeof saved.online === "object" ? saved.online : null;
    for (const f of ["kpi", "attend", "bonus", "dirs"]) state[f] = Array.isArray(saved[f]) ? saved[f] : [];
    state.account = clean(pick(state.profile || {}, "USERNAME", "XM"));
    // loadedAt 用**抓取那一刻**而不是「打开这一刻」：工具栏的「更新于」必须说真话。
    state.loadedAt = at;
    state.error = "";
    state.stale = "";
    state.partial = false;
    return true;
  }

  function loadAll(force = false) {
    if (state.inFlight) return Promise.resolve();
    if (!force && state.loadedAt && Date.now() - state.loadedAt < FRESH_MS) {
      paint();
      return Promise.resolve();
    }
    const releaseWait = state.loadedAt ? () => {} : waitMask("正在读取个人信息与成长数据…");
    return loadAllInner(force).finally(releaseWait);
  }

  /* 两组响应共用的落盘映射：HEAD_FIELDS / TAIL_FIELDS 与请求数组一一对应。
     返回成功条数，交给 state.stale 算「几项没取到」。 */
  const HEAD_FIELDS = ["profile", "learn", "kpi"];
  const TAIL_FIELDS = ["consume", "online", "attend", "bonus", "dirs"];
  function applyResults(fields, rs) {
    let ok = 0;
    fields.forEach((f, i) => {
      const x = rs[i];
      if (!x || !x.ok) return;
      ok += 1;
      if (f === "profile") {
        const d = x.data || {};
        state.profile = pick(d, "personInfo") || null;
        state.photo = photoSrc(pick(d, "personPhoto"));
        state.fields = buildFields(d);
        state.account = clean(pick(state.profile || {}, "USERNAME", "XM"));
      } else if (f === "learn") state.learn = x.data || null;
      else if (f === "kpi") state.kpi = (Array.isArray(x.data) ? x.data : []).filter((k) => k && (clean(k.FORMNAME) || clean(k.KPICONFIG)));
      else if (f === "consume") state.consume = x.data || null;
      else if (f === "online") state.online = x.data || null;
      else if (f === "attend") state.attend = Array.isArray(x.data) ? x.data.filter(Boolean) : [];
      else if (f === "bonus") state.bonus = Array.isArray(x.data) ? x.data.filter(Boolean) : [];
      else if (f === "dirs") state.dirs = buildReports(x.data);
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
       考勤 / 奖惩 / 数据报告目录）到了再补一版。两组请求同时发出 —— 只是**分两批落画面**，
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
      state.error = first.message || "个人信息暂时没有响应";
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
    /* 落盘：只有「首屏齐 + 至少过半」才值得缓存 —— 半页数据一存就是 30 天，
       反而把「暂无」写死。半途而废的那次不落盘，磁盘上留着上一份完整的。 */
    if (okHead === head.length && okCount * 2 >= total) cacheSet(SNAPSHOT_KEY, snapshotOf());
    paint();
  }

  /* ── 指标明细弹层 ─────────────────────────────────────────────────────── */
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
      modalEl.className = "pf-modal";
      modalEl.setAttribute("role", "dialog");
      modalEl.setAttribute("aria-modal", "true");
      modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl || e.target.closest("[data-pf-close]")) { closeModal(); return; }
        const prev = e.target.closest("[data-pf-page]");
        if (prev && !prev.disabled) loadDetailPage(Number(prev.dataset.pfPage));
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
    const btn = modalEl.querySelector("[data-pf-close]");
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
    const head = `<header><h3>${esc(d.title)}</h3><button type="button" data-pf-close aria-label="关闭">✕</button></header>`;
    let body;
    if (state.detailLoading) body = `<div class="pf-loading">正在读取明细…</div>`;
    else if (d.error) body = `<div class="pf-alert">${esc(d.error)}</div>`;
    else if (!d.rows.length) body = `<div class="pf-empty">这个指标暂时没有明细记录</div>`;
    else {
      body = `<div style="overflow:auto"><table class="pf-table"><thead><tr>${d.cols.map((c) => `<th>${esc(c.title)}</th>`).join("")}</tr></thead>`
        + `<tbody>${d.rows.map((r) => `<tr>${d.cols.map((c) => `<td>${esc(clean(r[c.key]) || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    const foot = `<div class="pf-modal-foot">`
      + `<button type="button" class="pf-btn" data-pf-page="${Math.max(1, d.page - 1)}" ${d.page <= 1 || state.detailLoading ? "disabled" : ""}>上一页</button>`
      + `<button type="button" class="pf-btn" data-pf-page="${Math.min(pages, d.page + 1)}" ${d.page >= pages || state.detailLoading ? "disabled" : ""}>下一页</button>`
      + `<span>第 ${d.page} / ${pages} 页 · 共 ${d.total} 条</span></div>`;
    modalEl.innerHTML = `<div class="pf-modal-card">${head}<div class="pf-modal-body">${body}</div>${foot}</div>`;
  }

  /* ── 复制 ────────────────────────────────────────────────────────────── */
  function recordHistory(label, value) {
    const key = `${label}\u0000${value}`;
    state.history = [{ k: label, v: value }, ...state.history.filter((h) => `${h.k}\u0000${h.v}` !== key)].slice(0, 12);
  }

  /** 复制后的反馈一律**就地改类名**，不重画 —— 重画会把滚动位置和焦点一起丢掉。 */
  function flash(node, label, value) {
    recordHistory(label, value);
    state.copied += 1;
    if (node && node.classList) {
      node.classList.add("pf-copied");
      clearTimeout(node.__pfTimer);
      node.__pfTimer = setTimeout(() => { try { node.classList.remove("pf-copied"); } catch { /* ignore */ } }, 1100);
    }
    const counter = state.root?.querySelector?.("[data-pf-count]");
    if (counter) counter.textContent = `已复制 ${state.copied} 项`;
    syncHistFold();
  }

  async function doCopy(node, label, value) {
    const ok = await copyText(value);
    if (state.disposed) return;
    if (!ok) { tide.notify?.("复制失败，请长按手动选择文本"); return; }
    flash(node, label, value);
  }

  async function copyAll() {
    // 必须按**屏幕上显示的值**拼，不能直接用 state.fields：
    // 那里是接口原样（SEX 是字典码 "1"，不是「男」），而且身份卡上已显示过的字段
    // 会重复出现一次。heroTags + rows 正好就是用户眼前这两块。
    const rows = [...state.heroTags, ...state.rows].filter((f) => f.v);
    if (!rows.length) { tide.notify?.("没有可复制的字段"); return; }
    const ok = await copyText(rows.map((f) => `${f.k}：${f.v}`).join("\n"));
    if (state.disposed) return;
    if (!ok) { tide.notify?.("复制失败，请稍后再试"); return; }
    const btn = state.root?.querySelector?.("[data-pf-copyall]");
    if (btn) {
      btn.textContent = `已复制 ${rows.length} 项`;
      setTimeout(() => { if (!state.disposed && btn.isConnected) btn.textContent = "复制全部"; }, 1400);
    }
    state.copied += rows.length;
    const counter = state.root?.querySelector?.("[data-pf-count]");
    if (counter) counter.textContent = `已复制 ${state.copied} 项`;
  }

  async function relogin(root) {
    const btn = root.querySelector("[data-pf-relogin]");
    if (btn) { btn.disabled = true; btn.textContent = "正在重新登录…"; }
    let result = "fail";
    try { result = (await bridge?.relogin?.()) || "fail"; } catch { result = "fail"; }
    if (state.disposed) return;
    if (result === "ok") { state.error = ""; state.stale = ""; loadAll(true); return; }
    // 换不到票 ⇒ 插件的统一身份认证会话不在。**不动现有画面**：这里要是重画，
    // 用户看到的是一片空白，连该去哪儿登录的提示都读不到。
    if (btn) { btn.disabled = false; btn.textContent = "重新登录"; }
    tide.notify?.(result === "form" ? "请先在「警大通知」里登录一次，再回到本页刷新" : "重新登录失败，请稍后再试");
  }

  /* ── 渲染 ────────────────────────────────────────────────────────────── */
  function computeHeroTags() {
    const p = state.profile || {};
    return [
      clean(pick(p, "USERID", "ZGH", "XH")) ? { k: "学号", v: clean(pick(p, "USERID", "ZGH", "XH")) } : null,
      sexText(pick(p, "SEX", "XB")) ? { k: "性别", v: sexText(pick(p, "SEX", "XB")) } : null,
      clean(pick(p, "MZ")) ? { k: "民族", v: clean(pick(p, "MZ")) } : null,
      clean(pick(p, "TEL")) ? { k: "电话", v: clean(pick(p, "TEL")) } : null,
      clean(pick(p, "BIRTHDATE")) ? { k: "出生日期", v: day(pick(p, "BIRTHDATE")) } : null,
      clean(pick(p, "BJ")) ? { k: "班级", v: clean(pick(p, "BJ")) } : null,
    ].filter(Boolean);
  }

  /* v0.279.0 隐私模式：姓名与头像必须自己打标 —— 宿主的一条规则只认数字和校名，
     姓名「张三」既不是数字也不含「警大」，两条都碰不到；头像不打 data-private-face
     就不会糊（CSS 规则①只认这个属性，不猜元素长得像不像脸）。 */
  const heroHtml = () => {
    const p = state.profile || {};
    const name = text(pick(p, "USERNAME", "XM"), state.account || "在读学生");
    const id = clean(pick(p, "USERID", "ZGH", "XH"));
    const face = state.photo
      ? `<span class="pf-face" data-private-face><img src="${esc(state.photo)}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="pf-face" data-private-face aria-hidden="true">${esc(initial(name))}</span>`;
    return `<section class="pf-card pf-hero"><div class="pf-hero-in">${face}
<div class="pf-id"><div class="pf-eyebrow" style="color:inherit;opacity:.72">CPPU · 个人信息</div>
<h2 data-private-text>${esc(name)}</h2>${id ? `<div class="pf-no">学号 ${esc(id)}</div>` : ""}
${state.heroTags.length ? `<div class="pf-tags">${state.heroTags.map((t, i) => `<button type="button" class="pf-tag" data-pf-tag="${i}" title="点击复制"><b>${esc(t.k)}</b><span data-private-text>${esc(t.v)}</span></button>`).join("")}</div>` : ""}
</div></div></section>`;
  };

  function toolbarHtml() {
    /* 「更新于」必须说真话：数据是 30 天内抓的都算新鲜，但只写 HH:MM:SS 会让人以为是今天
       刚取的。跨天就把日期带上（M-D HH:MM），并在 title 里说清「一个月内不自动联网」。 */
    const at = state.loadedAt ? new Date(state.loadedAt) : null;
    const sameDay = !!at && at.toDateString() === new Date().toDateString();
    const hm = at ? at.toLocaleTimeString("zh-CN", { hour12: false }) : "";
    const when = !at ? "尚未取到数据" : `更新于 ${sameDay ? hm : `${at.getMonth() + 1}-${at.getDate()} ${hm}`}`;
    return `<section class="pf-card pf-sec"><div class="pf-bar">
<button type="button" class="pf-btn pf-primary" data-pf-copyall>复制全部</button>
<button type="button" class="pf-btn" data-pf-home>打开原页</button>
<button type="button" class="pf-btn" data-pf-refresh ${state.loading ? "disabled" : ""}>${state.loading ? "正在刷新…" : "刷新"}</button>
<button type="button" class="pf-btn" data-pf-relogin${state.loginNeeded ? "" : " hidden"}>重新登录</button>
<span class="pf-right"><span data-pf-count>${state.copied ? `已复制 ${state.copied} 项` : "点任意字段即可复制"}</span><span title="一个月内直接显示本地缓存，不自动联网；点「刷新」可立即重取">${esc(when)}</span></span>
</div></section>`;
  }

  const learnHtml = () => {
    const c = state.learn || {};
    const cells = [
      { k: "累计已修学分", v: num(c.GOTTENUNIT), u: "学分" },
      { k: "累计应修学分", v: num(c.TOTALUNIT), u: "学分" },
      { k: "GPA", v: num(c.GRADEPOINT), u: "" },
      { k: "本学期已获得学分", v: num(c.THISTERMGOTTENUNIT), u: "学分" },
    ];
    const any = cells.some((x) => x.v);
    return `<section class="pf-card pf-sec"><header><h3>学业概览</h3><span class="pf-sub">${any ? "来自教务处学分统计" : state.partial ? "读取中" : "暂无数据"}</span></header>
${any ? `<div class="pf-learn">${cells.map((x) => `<div class="pf-stat"><small>${esc(x.k)}</small><strong>${esc(x.v || "—")}</strong>${x.v && x.u ? `<em>${esc(x.u)}</em>` : ""}</div>`).join("")}</div>`
      : `<div class="pf-empty">${state.partial ? "正在读取…" : "还没有可用的学分数据"}</div>`}</section>`;
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
        ? `<span class="pf-kpi-badge" aria-hidden="true">${icon}</span>`
        : `<span class="pf-kpi-badge" aria-hidden="true">${esc(initial(name))}</span>`;
      const wid = clean(k.WID);
      // 白字压在渐变最浅处时补一点描边阴影；深字不需要（加了反而糊）
      const shadow = fg === "#fff" ? ";text-shadow:0 1px 2px rgba(9,32,46,.32)" : "";
      return `<button type="button" class="pf-kpi" style="background:${esc(bg)};color:${esc(fg)}${shadow}"${wid ? ` data-pf-kpi="${esc(wid)}"` : " disabled"} title="${esc(wid ? `${name} · 点击查看明细` : name)}">
<span class="pf-kpi-name">${esc(name)}</span><span class="pf-kpi-num">${esc(value || "—")}${value && unit ? `<span class="pf-kpi-unit">${esc(unit)}</span>` : ""}</span>${badge}</button>`;
    }).join("");
    return `<section class="pf-card pf-sec"><header><h3>成长指标</h3><span class="pf-sub">${state.kpi.length} 项 · 点卡片看明细</span></header>
<div class="pf-kpis">${cards}</div>
${pages > 1 ? `<div class="pf-pager"><button type="button" data-pf-kpipage="${page - 1}" ${page <= 0 ? "disabled" : ""}>‹</button><span>${page + 1} / ${pages}</span><button type="button" data-pf-kpipage="${page + 1}" ${page >= pages - 1 ? "disabled" : ""}>›</button></div>` : ""}</section>`;
  };

  const flowHtml = () => {
    const c = state.consume || {}, o = state.online || {};
    const onConsume = state.tab === "consume";
    const rows = onConsume
      ? (Array.isArray(c.placeRanking) ? c.placeRanking : []).map((r) => ({ a: clean(r.MERCHANT) || "未知地点", b: clean(r.SPENDGMONEY) ? `${money(r.SPENDGMONEY)} 元` : "" }))
      : (Array.isArray(o.placeRanking) ? o.placeRanking : []).map((r) => ({ a: clean(r.PLACE) || "未知地点", b: clean(r.USETIME) || "" }));
    const body = rows.length
      ? `<ul class="pf-list">${rows.slice(0, 8).map((r) => `<li class="pf-row"><span class="pf-what">${esc(r.a)}</span><span class="pf-how">${esc(r.b || "—")}</span></li>`).join("")}</ul>`
      : `<div class="pf-empty" style="margin-top:10px">${state.partial ? "正在读取…" : onConsume ? "当月无消费记录" : "当月无上网记录"}</div>`;
    const metrics = onConsume
      ? `<div class="pf-flow"><div class="pf-f"><small>当月消费</small><strong>${esc(money(c?.balance?.TOTALAMOUNT) || "—")}</strong><em>元</em></div>
<div class="pf-f"><small>一卡通余额</small><strong>${esc(money(c?.balance?.BALANCE) || "—")}</strong><em>元</em></div></div>`
      : `<div class="pf-flow"><div class="pf-f"><small>累计时长</small><strong>${esc(text(o?.totalTime?.USETIME, "—"))}</strong></div></div>`;
    return `<section class="pf-card pf-sec"><header><h3>校园生活</h3>
<div class="pf-tabs" data-pf-tabs><button type="button" data-pf-tab="consume" aria-pressed="${onConsume ? "true" : "false"}">我的消费</button><button type="button" data-pf-tab="online" aria-pressed="${onConsume ? "false" : "true"}">我的上网</button></div>
<button type="button" class="pf-more" data-pf-open="${onConsume ? "/stu/dataReport/consumption" : "/stu/dataReport/onlineInfo"}">查看更多</button></header>
${metrics}${body}
<p class="pf-note">消费与上网数据来自一卡通与校园网，可能滞后于部门系统实时数据。</p></section>`;
  };

  const recordHtml = () => {
    const attend = state.attend.map((a) => {
      const qs = clean(a.QSSJ), jz = clean(a.JZSJ);
      return {
        when: qs ? `${day(qs)} ${clockOf(qs)}${jz ? ` ~ ${clockOf(jz)}` : ""}`.trim() : "",
        what: clean(a.CQLX) || "出勤记录",
        how: "",
      };
    }).filter((r) => r.what);
    const bonus = state.bonus.map((b) => ({
      when: day(b.SHOWTIME),
      what: clean(b.BONUSPENALTY) || "奖惩记录",
      how: clean(b.TYPE),
    })).filter((r) => r.what);
    const block = (title, sub, list, empty) => `<section class="pf-card pf-sec"><header><h3>${esc(title)}</h3><span class="pf-sub">${esc(sub)}</span></header>
${list.length ? `<ul class="pf-list">${list.slice(0, 10).map((r) => `<li class="pf-row">${r.when ? `<span class="pf-when">${esc(r.when)}</span>` : ""}<span class="pf-what">${esc(r.what)}</span>${r.how ? `<span class="pf-how">${esc(r.how)}</span>` : ""}</li>`).join("")}</ul>`
      : `<div class="pf-empty">${esc(empty)}</div>`}</section>`;
    return `<div class="pf-two">`
      + block("我的考勤", attend.length ? `${attend.length} 条` : state.partial ? "读取中" : "暂无", attend, state.partial ? "正在读取…" : "暂无出勤记录")
      + block("奖惩记录", bonus.length ? `${bonus.length} 条` : state.partial ? "读取中" : "暂无", bonus, state.partial ? "正在读取…" : "暂无奖惩记录")
      + `</div>`;
  };

  function matches(f, q) {
    return !q || f.k.toLowerCase().includes(q) || f.v.toLowerCase().includes(q);
  }

  const gridHtml = () => {
    const q = state.query.trim().toLowerCase();
    const shown = state.rows.map((f, i) => ({ f, i })).filter(({ f }) => matches(f, q));
    const filled = state.rows.filter((f) => f.v).length;
    const emptyCount = state.fields.length - filled - state.heroTags.filter((t) => t.v).length;
    const body = shown.length
      ? `<div class="pf-grid">${shown.map(({ f, i }) => (f.v
        ? `<button type="button" class="pf-cell" data-pf-cell="${i}" title="点击复制"><span class="pf-k">${esc(f.k)}</span><span class="pf-v" data-private-text>${esc(f.v)}</span><span class="pf-flag">已复制</span></button>`
        : `<div class="pf-cell pf-empty"><span class="pf-k">${esc(f.k)}</span><span class="pf-v">—</span></div>`)).join("")}</div>`
      : `<div class="pf-empty">${q ? "没有匹配的字段，换个关键词试试。" : state.partial ? "正在读取…" : "学校还没为你的档案配置可展示字段。"}</div>`;
    const emptyNote = emptyCount > 0 && !q ? `<p class="pf-note">另有 ${emptyCount} 个字段学校没填值，未列出。</p>` : "";
    return `<section class="pf-card pf-sec">
<header><h3>档案字段</h3><span class="pf-sub">${filled} 项可复制</span></header>
<div class="pf-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.6-3.6"></path></svg>
<input type="search" data-pf-q placeholder="按字段名或内容筛选" value="${esc(state.query)}" aria-label="筛选字段">
${state.query ? `<button type="button" data-pf-qclear aria-label="清空筛选">✕</button>` : ""}</div>
${body}${emptyNote}${histHtml()}</section>`;
  };

  /* ⑧ 数据报告目录：basicInfo 只是「数据报告」组里的一个目录，学校给在读学生开放的
     其余报表同样一键直达 —— 点开走 bridge.open，与应用内「打开原页」是同一条通道
     （换票 + 注入 Cookie），这条通道才带得上会话。 */
  const dirsHtml = () => {
    if (!state.dirs.length) return "";
    return `<section class="pf-card pf-sec">
<header><h3>数据报告目录</h3><span class="pf-sub">${state.dirs.length} 个 · 点开直达</span></header>
<div class="pf-dirs">${state.dirs.map((r, i) => `<button type="button" class="pf-dir" data-pf-dir="${i}" title="在应用内打开「${esc(r.name)}」"><span class="pf-dot" aria-hidden="true"></span><span class="pf-dn">${esc(r.name)}</span><span class="pf-go" aria-hidden="true">↗</span></button>`).join("")}</div>
<p class="pf-note">上面这些与「个人信息」同站同权限，都是学校在个人成长中心里为你开放的报表。</p>
</section>`;
  };

  const histRowsHtml = () => state.history.map((h, i) => `<button type="button" data-pf-hist="${i}" title="点击再复制一次"><span class="pf-hk">${esc(h.k)}</span><span class="pf-hv" data-private-text>${esc(h.v)}</span></button>`).join("");

  const histFoldHtml = () => `<div class="pf-fold${state.histOpen ? " open" : ""}" data-pf-fold>
<button type="button" data-pf-htoggle aria-expanded="${state.histOpen ? "true" : "false"}" aria-controls="pf-hist-list"><span class="pf-chev" aria-hidden="true">▸</span>复制记录（${state.history.length}）</button>
<div class="pf-shell" id="pf-hist-list" aria-hidden="${state.histOpen ? "false" : "true"}"><div class="pf-clip"><div class="pf-hist" data-pf-histbox>${histRowsHtml()}</div></div></div></div>`;

  const histHtml = () => (state.history.length ? histFoldHtml() : "");

  /**
   * 复制记录区块的**首次出现**得自己插上去。
   * 复制路径刻意不重画（重画会丢滚动位置与焦点），而 histHtml() 在还没记录时是空串 ——
   * 于是第一条记录落在了一个尚不存在的容器里，用户要等下次刷新才看得见折叠栏。
   * 事件走 root 上的委托，新节点不需要重新绑；这里只补 DOM 与计数。
   */
  function syncHistFold() {
    const root = state.root;
    if (!root) return;
    const fold = root.querySelector("[data-pf-fold]");
    if (!fold) {
      const anchor = root.querySelector(".pf-grid") || root.querySelector(".pf-empty");
      const sec = anchor?.closest?.(".pf-sec");
      if (!sec) return;
      sec.insertAdjacentHTML("beforeend", histFoldHtml());
      return;
    }
    const toggle = fold.querySelector("[data-pf-htoggle]");
    if (toggle) toggle.innerHTML = `<span class="pf-chev" aria-hidden="true">▸</span>复制记录（${state.history.length}）`;
    const box = fold.querySelector("[data-pf-histbox]");
    if (box) box.innerHTML = histRowsHtml();
  }

  function paint() {
    const root = state.root;
    if (!root) return;
    styles();
    state.heroTags = computeHeroTags();
    state.rows = state.fields.filter((f) => !HERO_FIELDS.has(String(f.key).toUpperCase()));
    if (state.loading && !state.loadedAt) {
      root.innerHTML = `<div class="pf-wrap">${toolbarHtml()}<div class="pf-card"><div class="pf-loading">正在读取个人信息…</div></div></div>`;
      bind(root);
      return;
    }
    if (state.error && !state.loadedAt) {
      root.innerHTML = `<div class="pf-wrap">${toolbarHtml()}
<div class="pf-card pf-sec"><div class="pf-alert"><b>${state.loginNeeded ? "需要先登录统一身份认证" : "个人信息暂时不可用"}</b><br>${esc(state.error)}<br>${state.loginNeeded ? "先在「警大通知」里完成一次登录，再回到本页刷新。" : "校园网 / 内网代理不通时也会这样，稍后再试。"}</div></div></div>`;
      bind(root);
      return;
    }
    root.innerHTML = `<div class="pf-wrap">${toolbarHtml()}
${state.stale ? `<div class="pf-card pf-sec"><div class="pf-alert">${esc(state.stale)}</div></div>` : ""}
${heroHtml()}${learnHtml()}${kpiHtml()}${flowHtml()}${recordHtml()}${gridHtml()}${dirsHtml()}</div>`;
    bind(root);
  }

  function attachGlow(root) {
    for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    const box = root.querySelector?.("[data-pf-tabs]");
    if (!box) return;
    let handle = null;
    try { handle = tide.ui?.selectionGlow?.(box, { selector: 'button[aria-pressed="true"]' }) || null; } catch { handle = null; }
    if (handle) glowHandles.push(handle);
  }

  function toggleHist(root) {
    const fold = root.querySelector("[data-pf-fold]");
    if (!fold) return;
    state.histOpen = !state.histOpen;
    fold.classList.toggle("open", state.histOpen);
    fold.querySelector("[data-pf-htoggle]")?.setAttribute("aria-expanded", state.histOpen ? "true" : "false");
    fold.querySelector(".pf-shell")?.setAttribute("aria-hidden", state.histOpen ? "false" : "true");
    persist();
  }

  function openDir(index) {
    const r = state.dirs[Number(index)];
    if (r && r.key) bridge?.open?.("/stu/dataReport/" + r.key);
  }

  function bind(root) {
    // 一个委托处理全部点击：可复制项只带下标，值统一从 state 里取。
    root.onclick = (e) => {
      const hit = (sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);
      const tag = hit("[data-pf-tag]");
      if (tag) { const t = state.heroTags[Number(tag.dataset.pfTag)]; if (t) doCopy(tag, t.k, t.v); return; }
      const cell = hit("[data-pf-cell]");
      if (cell) { const f = state.rows[Number(cell.dataset.pfCell)]; if (f && f.v) doCopy(cell, f.k, f.v); return; }
      const hb = hit("[data-pf-hist]");
      if (hb) { const h = state.history[Number(hb.dataset.pfHist)]; if (h) doCopy(hb, h.k, h.v); return; }
      const dir = hit("[data-pf-dir]");
      if (dir) { openDir(dir.dataset.pfDir); return; }
      const tab = hit("[data-pf-tab]");
      if (tab) {
        // 只切 aria-pressed，让宿主的光块自己滑过去（重建 DOM 会把光块变成孤儿）。
        if (state.tab === tab.dataset.pfTab) return;
        state.tab = tab.dataset.pfTab;
        persist();
        paint();
        return;
      }
      const page = hit("[data-pf-kpipage]");
      if (page) {
        const p = Number(page.dataset.pfKpipage);
        const pages = Math.max(1, Math.ceil(state.kpi.length / 4));
        if (!Number.isFinite(p) || p < 0 || p >= pages) return;
        state.kpiPage = p;
        paint();
        return;
      }
      const kpi = hit("[data-pf-kpi]");
      if (kpi) {
        const row = state.kpi.find((k) => clean(k.WID) === kpi.dataset.pfKpi);
        if (row) openDetail(row);
        return;
      }
      const open = hit("[data-pf-open]");
      if (open) {
        const path = open.dataset.pfOpen;
        if (open.setAttribute) open.setAttribute("aria-busy", "1");
        Promise.resolve(bridge?.open?.(path))
          .catch(() => tide.notify?.("打开失败，请稍后再试"))
          .finally(() => { if (open.removeAttribute) open.removeAttribute("aria-busy"); });
        return;
      }
      if (hit("[data-pf-copyall]")) { copyAll(); return; }
      if (hit("[data-pf-refresh]")) { loadAll(true); return; }
      if (hit("[data-pf-home]")) { bridge?.open?.("/stu/dataReport/basicInfo"); return; }
      if (hit("[data-pf-qclear]")) { state.query = ""; paint(); return; }
      if (hit("[data-pf-htoggle]")) { toggleHist(root); return; }
      if (hit("[data-pf-relogin]")) { relogin(root); return; }
    };
    // 筛选：就地显隐，不重画（重画会打断输入法组合）。
    const input = root.querySelector("[data-pf-q]");
    if (input) {
      input.oninput = () => {
        state.query = input.value || "";
        const q = state.query.trim().toLowerCase();
        for (const cell of root.querySelectorAll("[data-pf-cell]")) {
          const f = state.rows[Number(cell.dataset.pfCell)];
          cell.hidden = !(f && matches(f, q));
        }
      };
    }
    // 复制记录折叠：Escape 收起并把焦点还给按钮。
    const fold = root.querySelector("[data-pf-fold]");
    if (fold) {
      fold.onkeydown = (e) => {
        if (e.key !== "Escape" || !state.histOpen) return;
        e.stopPropagation();
        toggleHist(root);
        fold.querySelector("[data-pf-htoggle]")?.focus?.();
      };
    }
    attachGlow(root);
  }

  function persist() {
    try { tide.storage?.set?.(KEY, { histOpen: state.histOpen, tab: state.tab }); } catch { /* ignore */ }
  }

  function render(host) {
    state.disposed = false;
    state.root = host;
    styles();
    host.innerHTML = `<div class="pf-wrap"><div class="pf-card"><div class="pf-loading">正在读取个人信息…</div></div></div>`;
    /* 三项并行读：偏好（tab / 复制记录折叠）与落盘快照。
       快照命中且未过期 ⇒ **当场画完就返回，一个请求都不发**（这就是「无感」）；
       没命中 / 过期 / 本次会话里已经有数据 ⇒ 才回到原来的取数流程。
       会话内重进时不读盘也不清状态：手里那份比磁盘新，画它就行。 */
    const pref = Promise.resolve(tide.storage?.get?.(KEY, null)).catch(() => null);
    const snap = state.loadedAt ? Promise.resolve(null) : cacheGet(SNAPSHOT_KEY, null);
    Promise.all([pref, snap]).then(([saved, cached]) => {
      if (state.disposed) return;
      if (saved && typeof saved === "object") {
        if (saved.tab === "consume" || saved.tab === "online") state.tab = saved.tab;
        if (saved.histOpen === true) state.histOpen = true;
      }
      if (!state.loadedAt && hasCache()) cacheRemove(LEGACY_SNAPSHOT_KEY);
      const at = Number(cached && cached.savedAt) || 0;
      if (at && Date.now() - at < FRESH_MS && restoreSnapshot(cached)) {
        paint();
        return;
      }
      loadAll();
    }).catch(() => { if (!state.disposed) loadAll(); });
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

  /* 对外 refresh 也是 force：外部只会因为「我要最新」才喊它，
     在一个月时效内退化成空操作等于骗人。 */
  return { render, refresh: () => loadAll(true) };
}
