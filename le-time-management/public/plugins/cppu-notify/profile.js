// 警大门户通知 · 个人信息（pdata.cppu.edu.cn/stu/dataReport/basicInfo）
//
// 独立界面，不照搬网页：网页那张「个人信息」是 umi + antd 的表单式排版，塞进插件
// 只会变成一个更窄的浏览器。这里按 U-Time 的卡片语言重排，并加上网页没有的那件事
// —— **点一下就复制到剪贴板**：
//   ① 顶部身份卡（头像 / 姓名 / 学号 / 性别；标签本身也能点着复制）
//   ② 工具条（复制全部 / 打开原页 / 重新登录 / 刷新 / 已复制计数）
//   ③ 字段网格（每格一个字段，点格子即复制该字段的值，复制过的格子亮一下）
//   ④ 复制记录（最近复制的若干条，可点着再复制一次；折叠走双向动画）
//   ⑤ 数据报告目录（basicInfo 只是这个组里的一个目录，其余目录同样一键直达）
//
// 边界：本模块**不碰** SSO / 密码 / vault / Cookie —— 那是 main.js 的事。
// 一切取数走 bridge.api(path)，鉴权（换票 → validateLogin → token）与一次性重登
// 由 main.js 内部处理；本模块只认「拿到 data / 没拿到」两种结果。
//
// 取数口径对齐网页（反解自 pdata 学生端 umi.js）：
//   GET /tsa/shc/homepage/personInfo   （**不要**加 _USER：服务端按 token 认人，
//   带上 _USER 反而命中空集 —— 见 main.js 里 pdataApi 的注释）
//   → data = { personInfo, column, personPhoto, basicFormId, QRCodeUrl }
//   · personInfo 是扁平对象：USERNAME / USERID / SEX(1男2女) / MZ / TEL / BIRTHDATE /
//     BJ / ZGH，以及每个字段的中文值副本 <dataField>_CN
//   · column 是字段清单，每项 { dataField, dataFieldName }；网页把前 3 项 splice 掉
//     （那 3 项是姓名 / 学号 / 性别，身份卡上已经有了），这里照做
//   · 字段值 = personInfo[dataField + "_CN"] ?? personInfo[dataField]
// 字段名一律用接口原样名（camelCase），不在这里改名 —— 出问题时能直接对着抓包看。
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
  /** 接口里的日期是 "2025-09-01 00:00:00" 或 "20250901" 这类混排，只做最保守的规整。 */
  const day = (v) => {
    const s = clean(v);
    if (!s) return "";
    const m = s.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
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
  /** 身份卡上已经占掉的字段，字段网格里不再重复（对应网页的 column.splice(0,3)）。 */
  const HERO_FIELDS = new Set(["USERNAME", "XM", "USERID", "ZGH", "XH", "SEX", "XB"]);

  const state = {
    root: null, disposed: false, loading: false, error: "", loginNeeded: false, stale: "",
    account: "", profile: null, photo: "", fields: [], heroTags: [], rows: [],
    query: "", copied: 0, history: [], histOpen: false, loadedAt: 0, inFlight: 0,
    reports: [], reportsAt: 0,
  };

  /* ── 样式 ──────────────────────────────────────────────────────────────
     安全区：本模块只画 [data-pg-host] 里的内容，四条边由宿主 .view 负责，这里
     **不垫第二遍**；样式表里没有任何 fixed 定位的浮层，所以不需要自己让开。
     唯一挂到 document.body 的是复制兜底的离屏 textarea（absolute + left:-9999px，
     不贴任何一条边），它同样不需要 --sat / --sab / --sal / --sar。 */
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
   （浅色主题 --sea 偏亮、night 那类深色主题 --deep/--sea 反而偏亮），
   按一个方向叠半透明层，总有一套主题会把对比度压到 3:1 上下。
   走 --panel + --ink 就是主题测试里已经按 ≥7:1 约束过的那一对，两个方向都稳。 */
.pf-tag{font:inherit;font-size:calc(11px * var(--ui-text-scale));color:var(--ink);padding:6px 12px;border-radius:999px;background:var(--panel);border:1px solid color-mix(in srgb,var(--panel) 45%,var(--line));white-space:nowrap;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;min-height:34px;transition:background .18s ease,border-color .18s ease}
.pf-tag:hover{border-color:var(--sea,#118AB2)}
.pf-tag:focus-visible{outline:2px solid var(--sea,#118AB2);outline-offset:2px}
.pf-tag b{font-weight:600;color:var(--ink-2,#7E8B94);margin-right:4px}
.pf-tag.pf-copied{background:color-mix(in srgb,var(--sea,#118AB2) 18%,var(--panel));border-color:var(--sea,#118AB2)}
/* ② 工具条 */
.pf-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.pf-bar .pf-count{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
.pf-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 13px;min-height:38px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .16s ease}
.pf-btn:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel))}
.pf-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.pf-btn.pf-primary{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-accent,#fff)}
.pf-btn.pf-primary:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 86%,#000)}
.pf-btn:disabled{opacity:.5;cursor:default}
/* ③ 搜索 + 字段网格 */
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
/* ④ 复制记录：铁律七 —— 展开 / 收起都要有中间帧（grid-template-rows 0fr↔1fr 可连续插值）。
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
/* ⑤ 数据报告目录：一格一个报表，点开在应用内网页窗口里直达 */
.pf-dirs{display:grid;grid-template-columns:repeat(auto-fill,minmax(198px,1fr));gap:9px}
.pf-dir{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font:inherit;font-size:calc(12.5px * var(--ui-text-scale));text-align:left;color:inherit;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel));border:1px solid var(--line);border-radius:11px;padding:10px 12px;min-height:44px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .16s ease,border-color .16s ease}
.pf-dir:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 11%,var(--panel))}
.pf-dir:focus-visible{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 55%,transparent);outline-offset:-2px}
.pf-dir .pf-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--deep,#0F4C5C);opacity:.7}
.pf-dir .pf-dn{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pf-dir .pf-go{flex:none;color:var(--ink-3,#7E8B94);font-size:calc(12px * var(--ui-text-scale))}
.pf-loading{padding:26px 16px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12.5px * var(--ui-text-scale))}
.pf-alert{border:1px solid color-mix(in srgb,var(--danger,#B03535) 42%,var(--line));background:color-mix(in srgb,var(--danger,#B03535) 8%,var(--panel));border-radius:11px;padding:12px 14px;font-size:calc(12px * var(--ui-text-scale));line-height:1.85;color:var(--ink)}
@media(max-width:760px){.pf-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}}
@media(max-width:420px){.pf-grid{grid-template-columns:1fr 1fr}.pf-hero-in{gap:12px}.pf-face{width:54px;height:54px}}
@media(prefers-reduced-motion:reduce){.pf-shell,.pf-fold>button .pf-chev,.pf-cell,.pf-tag{transition-duration:.01ms!important}}`;
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

  /* ── 取数 ──────────────────────────────────────────────────────────────
     取数函数在下面的「刷新等待蒙版」一节（它和 force / FRESH_MS 是一组）。 */

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

  /** 数据报告目录：取「数据报告」那一组的 children（与 growth.js flattenModules 同口径）。
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

  /* 取数：`force` 只在用户按「刷新」时为真，要求 bridge 绕过它那份缓存；老宿主没给
     force 通道时退回普通取数（宁可慢一次，也不要「点了刷新没反应」）。 */
  const call = (path, force = false) => Promise.resolve(force && bridge?.force ? bridge.force(path) : bridge?.api?.(path)).then((r) => (r && typeof r === "object" ? r : { ok: false, message: "取数通道不可用" }));

  /* 刷新等待蒙版（v0.233.0）：同 growth.js —— 包一层，别在有多条 return 的函数体里散点 release。
     v0.236.0：**手里已经有数据时不再打蒙版**。 */
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});

  /* 重进缓存（v0.236.0）：这一页只有一个接口，但档案字段在一节课里不会变。
     TTL 内重进连 bridge 都不问；过期时先把旧档案画出来（带「更新于 …」）再静默刷新。 */
  const FRESH_MS = 60 * 1000;
  function loadAll(force = false) {
    if (state.inFlight) return Promise.resolve();
    if (!force && state.loadedAt && Date.now() - state.loadedAt < FRESH_MS) {
      paint();
      return Promise.resolve();
    }
    const releaseWait = state.loadedAt ? () => {} : waitMask("正在读取个人信息…");
    return loadAllInner(force).finally(releaseWait);
  }

  async function loadAllInner(force = false) {
    if (state.inFlight) return;
    state.inFlight = 1;
    state.loading = true;
    state.error = "";
    state.loginNeeded = false;
    paint();
    const res = await call("/tsa/shc/homepage/personInfo", force);
    if (state.disposed) { state.inFlight = 0; return; }
    state.inFlight = 0;
    state.loading = false;
    if (!res.ok) {
      state.loginNeeded = !!res.auth;
      state.error = res.message || "个人信息暂时没有响应";
      paint();
      return;
    }
    const d = res.data || {};
    state.profile = pick(d, "personInfo") || null;
    state.photo = photoSrc(pick(d, "personPhoto"));
    state.fields = buildFields(d);
    state.account = clean(pick(state.profile || {}, "USERNAME", "XM"));
    state.loadedAt = Date.now();
    state.stale = state.fields.length ? "" : "接口通了，但没有返回任何档案字段";
    paint();

    /* 第二屏：数据报告目录。personInfo 只是「数据报告」组里的一个目录（basicInfo），
       同一份 token 还能拿到学校给在读学生开放的全部目录 —— 那正是这一页下方该有的内容。
       档案先落地、目录后补，和 growth.js 分两批落画面同一个理由：别让首屏等第二个接口。
       取不到就静默：目录缺席不影响字段复制。 */
    const dirs = await call(`/tsa/shc/customStyle/getModuleList?t=${Date.now()}`, force);
    if (state.disposed) return;
    if (dirs.ok) {
      state.reports = buildReports(dirs.data);
      state.reportsAt = Date.now();
      paint();
    }
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

  const heroHtml = () => {
    const p = state.profile || {};
    const name = text(pick(p, "USERNAME", "XM"), state.account || "在读学生");
    const id = clean(pick(p, "USERID", "ZGH", "XH"));
    const face = state.photo
      ? `<span class="pf-face"><img src="${esc(state.photo)}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="pf-face" aria-hidden="true">${esc(initial(name))}</span>`;
    return `<section class="pf-card pf-hero"><div class="pf-hero-in">${face}
<div class="pf-id"><div class="pf-eyebrow" style="color:inherit;opacity:.72">CPPU · 个人信息</div>
<h2>${esc(name)}</h2>${id ? `<div class="pf-no">学号 ${esc(id)}</div>` : ""}
${state.heroTags.length ? `<div class="pf-tags">${state.heroTags.map((t, i) => `<button type="button" class="pf-tag" data-pf-tag="${i}" title="点击复制"><b>${esc(t.k)}</b>${esc(t.v)}</button>`).join("")}</div>` : ""}
</div></div></section>`;
  };

  const toolbarHtml = () => `<section class="pf-card pf-sec"><div class="pf-bar">
<button type="button" class="pf-btn pf-primary" data-pf-copyall>复制全部</button>
<button type="button" class="pf-btn" data-pf-home>打开原页</button>
<button type="button" class="pf-btn" data-pf-refresh>刷新</button>
<button type="button" class="pf-btn" data-pf-relogin${state.loginNeeded ? "" : " hidden"}>重新登录</button>
<span class="pf-count" data-pf-count>${state.copied ? `已复制 ${state.copied} 项` : "点任意字段即可复制"}</span>
</div></section>`;

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
        ? `<button type="button" class="pf-cell" data-pf-cell="${i}" title="点击复制"><span class="pf-k">${esc(f.k)}</span><span class="pf-v">${esc(f.v)}</span><span class="pf-flag">已复制</span></button>`
        : `<div class="pf-cell pf-empty"><span class="pf-k">${esc(f.k)}</span><span class="pf-v">—</span></div>`)).join("")}</div>`
      : `<div class="pf-empty">${q ? "没有匹配的字段，换个关键词试试。" : "学校还没为你的档案配置可展示字段。"}</div>`;
    const emptyNote = emptyCount > 0 && !q ? `<p class="pf-note">另有 ${emptyCount} 个字段学校没填值，未列出。</p>` : "";
    return `<section class="pf-card pf-sec">
<header><h3>档案字段</h3><span class="pf-sub">${filled} 项可复制</span></header>
<div class="pf-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.6-3.6"></path></svg>
<input type="search" data-pf-q placeholder="按字段名或内容筛选" value="${esc(state.query)}" aria-label="筛选字段">
${state.query ? `<button type="button" data-pf-qclear aria-label="清空筛选">✕</button>` : ""}</div>
${body}${emptyNote}${histHtml()}</section>`;
  };

  /* ⑤ 数据报告目录：basicInfo 之外，学校还给在读学生开了哪些报表。
     整行是一个按钮 —— 点开走 bridge.open，与应用内「打开原页」是同一条通道（换票 + 注入 Cookie）。 */
  const reportsHtml = () => {
    if (!state.reports.length) return "";
    return `<section class="pf-card pf-sec">
<header><h3>数据报告目录</h3><span class="pf-sub">${state.reports.length} 个 · 点开直达</span></header>
<div class="pf-dirs">${state.reports.map((r, i) => `<button type="button" class="pf-dir" data-pf-dir="${i}" title="在应用内打开「${esc(r.name)}」"><span class="pf-dot" aria-hidden="true"></span><span class="pf-dn">${esc(r.name)}</span><span class="pf-go" aria-hidden="true">↗</span></button>`).join("")}</div>
<p class="pf-note">上面这些与「个人信息」同站同权限，都是学校在个人成长中心里为你开放的报表。</p>
</section>`;
  };

  const histRowsHtml = () => state.history.map((h, i) => `<button type="button" data-pf-hist="${i}" title="点击再复制一次"><span class="pf-hk">${esc(h.k)}</span><span class="pf-hv">${esc(h.v)}</span></button>`).join("");

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
${heroHtml()}${gridHtml()}${reportsHtml()}</div>`;
    bind(root);
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
      if (dir) { const r = state.reports[Number(dir.dataset.pfDir)]; if (r && r.key) bridge?.open?.("/stu/dataReport/" + r.key); return; }
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
  }

  function persist() {
    try { tide.storage?.set?.(KEY, { histOpen: state.histOpen }); } catch { /* ignore */ }
  }

  function render(host) {
    state.disposed = false;
    state.root = host;
    styles();
    host.innerHTML = `<div class="pf-wrap"><div class="pf-card"><div class="pf-loading">正在读取个人信息…</div></div></div>`;
    Promise.resolve(tide.storage?.get?.(KEY, null)).then((saved) => {
      if (state.disposed) return;
      if (saved && typeof saved === "object" && saved.histOpen === true) state.histOpen = true;
    }).catch(() => {}).finally(() => { if (!state.disposed) loadAll(); });
    return () => {
      state.disposed = true;
      state.root = null;
    };
  }

  return { render, refresh: () => loadAll() };
}
