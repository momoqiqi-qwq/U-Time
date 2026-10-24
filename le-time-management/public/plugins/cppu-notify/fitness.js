// 警大门户通知 · 我的体测（sport-wechat.cppu.edu.cn · 警大体育测试）
//
// 数据从哪来 —— 这个应用只在企业微信里跑（OAuth appid 绑死 wxwork），
// U-Time 里既没有企业微信的 User-Agent 环境、也进不去它的内置浏览器，
// 所以**插件自己不做 OAuth**。取数链路是：
//
//   ① 本机跑一次 tools/sync-fitness.mjs（读企业微信内置浏览器的 sessionStorage，
//      拿 Authorization token，写进 <数据目录>/plugin-cache/cppu-notify/fitnessToken.json）
//   ② 插件点「刷新」时用这份 token 直接 POST 体测接口
//
// token 失效（服务端回 status -998 / -999「登录已过期」）时不清数据、不假装成功，
// 状态行照原话说，并给出重新同步的提示。
//
// 数据是「快照」语义（用户口径：不实时变化，点了刷新才重新取）：
//   · 首次打开：先读 tide.cache 里的上次结果；没有就读内置 fitness-seed.json
//   · 全程不自动联网（token 都没有，也没有定时器）
//   · 只有点「刷新」才发请求；成功才覆盖缓存
//
// 接口口径（实测，2026-10）：
//   POST https://sport-wechat.cppu.edu.cn/api/iot/h5fitness/fitnessAchievementActivity/getAppealInfo
//   headers: 企业微信 UA + Authorization: <token> + Content-Type: application/json
//   body: {}
//   → { status: "00", data: [ 44 条记录 ], wxLoginStatus: 0 }
//   不带 token 或 token 非法：status -999 / -998，data 为 null
//
// 记录字段（只用得到这几个）：
//   projectName 项目名 / projectUnit 单位 / projectIcon 图标 URL
//   score 已格式化成绩（"210 厘米"）/ scoreOriginal 原始值
//   fraction 得分（"61.00"）/ level 等级 / remark 判罚备注
//   testTime 测试时间 / termName 学年
//
// 同一项目会有多次重测（44 条 = 7 个项目），所以按项目分组、组内取 fraction 最高
// 的那条当「最好」，其余收进展开区。
//
// 视图口径（v0.283.0，按用户反馈定的四条）：
//   ① 图标用服务端 projectIcon 的原图（fitness-icons.js 内嵌 PNG），不再自绘近似图形
//   ② 七项装在**一个**容器里，项与项之间用细分隔线，不再各自一枚卡片
//   ③ 右侧成绩的数字和文字取该项目图标的主色（--fit-c），与左边的圆同色
//   ④ 学期可切换：胶囊单选（宿主 tide.ui.selectionGlow 画滑动光块，铁律六）

import { FITNESS_ICONS, FITNESS_COLORS, FITNESS_FALLBACK_COLOR } from "./fitness-icons.js";

export function createFitnessView(tide) {
  const API = "https://sport-wechat.cppu.edu.cn/api/iot/h5fitness/fitnessAchievementActivity/getAppealInfo";
  const ORIGIN = "https://sport-wechat.cppu.edu.cn";
  /* 服务端按 UA 判来源：换回浏览器 UA 会被当成非企业微信环境。
     这串是从企业微信 PC 内置浏览器的真实请求里抄下来的，改动前先想清楚。 */
  const WXWORK_UA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) "
    + "Chrome/129.0.0.0 Safari/537.36 wxwork/5.0.12 MicroMessenger/7.0.1 NetType/WIFI Language/zh";

  const CACHE_KEY = "fitnessScores";       // { items, fetchedAt, source }
  const TOKEN_KEY = "fitnessToken";        // { token, savedAt }  由同步脚本写入
  const ICON_KEY = "fitnessIcons";         // { url: dataUrl }    远程图标本地化
  const PREF_KEY = "fitnessViewPreferences";
  const SEED = "fitness-seed.json";        // 随插件走的首装快照

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** 后台的空值是字符串 "null"（Java 侧 String.valueOf），必须当空处理。 */
  const clean = (v) => {
    if (v == null) return "";
    const s = String(v).trim();
    return s && s !== "null" && s !== "undefined" ? s : "";
  };
  const num = (v) => {
    const n = Number(clean(v));
    return Number.isFinite(n) ? n : 0;
  };

  /* 等级 → 色档。与「警大成绩」同一套四档语义（good / info / warn / bad），
     不另起一套自编色；「正常」是体测 BMI 的合格档，归到 good。 */
  function toneOf(level) {
    const s = clean(level);
    if (!s) return "flat";
    if (s.includes("优秀") || s.includes("正常")) return "good";
    if (s.includes("良好")) return "info";
    if (s.includes("不及格") || s.includes("不合格")) return "bad";
    if (s.includes("及格") || s.includes("合格")) return "warn";
    return "flat";
  }

  /* 项目图标：用服务端 projectIcon 的原图（fitness-icons.js 内嵌的 96×96 PNG）。
     运行时若还能抓到更新的 projectIcon（state.icons 缓存），那一条优先 —— 后端换图能跟上。
     认不出的项目给中性灰线条图形，不硬套别的项目的颜色。 */
  const ICON_FALLBACK = { c: FITNESS_FALLBACK_COLOR, d: "M4 12h4l2-5 3 12 2-7h5" };

  /** 项目名 → 图标主色。右侧成绩的数字与文字都取这个色（与左边的圆同色）。 */
  const colorOf = (name) => FITNESS_COLORS[clean(name)] || ICON_FALLBACK.c;

  function iconHtml(name, dataUrl, size = 34) {
    const src = dataUrl || FITNESS_ICONS[clean(name)];
    if (src) {
      return `<img src="${esc(src)}" alt="" width="${size}" height="${size}" draggable="false">`;
    }
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
      + `<circle cx="12" cy="12" r="12" fill="${ICON_FALLBACK.c}"/>`
      + `<path d="${ICON_FALLBACK.d}" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  const state = {
    items: [],
    fetchedAt: 0,
    source: "",          // "cache" | "seed" | "api"
    loading: false,
    error: null,
    note: "",            // 成功/失败之后那一句实话
    term: "",            // "" = 全部学期；否则是 termName 原串
    expanded: new Set(),
    icons: {},           // projectName -> dataUrl
    disposed: false,
    root: null,
  };

  // ── 样式 ────────────────────────────────────────────────────────────────
  function styles() {
    if (typeof document === "undefined" || document.getElementById("fit-style")) return;
    const node = document.createElement("style");
    node.id = "fit-style";
    node.textContent = `
.fit-wrap{display:grid;gap:12px;padding:2px 0 18px;font-size:calc(13px * var(--ui-text-scale));color:var(--ink)}
.fit-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.fit-bar h2{margin:0;font-size:calc(16px * var(--ui-text-scale));font-weight:600;letter-spacing:.01em}
.fit-bar .fit-when{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
.fit-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));padding:6px 14px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);color:var(--ink);display:inline-flex;align-items:center;gap:6px}
.fit-btn:hover{border-color:var(--sea,#118AB2)}
.fit-btn:focus-visible{outline:2px solid var(--sea,#118AB2);outline-offset:2px}
.fit-btn[disabled]{opacity:.55;cursor:default}
.fit-btn.fit-primary{background:var(--sea,#118AB2);border-color:transparent;color:#fff}
.fit-btn.fit-primary[disabled]{background:var(--sea,#118AB2)}
.fit-spin{width:12px;height:12px;border-radius:50%;border:1.8px solid currentColor;border-top-color:transparent;animation:fit-spin .7s linear infinite}
@keyframes fit-spin{to{transform:rotate(360deg)}}

.fit-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.fit-stats[data-n="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
.fit-stat{border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--panel);padding:11px 13px}
.fit-stat span{display:block;font-size:calc(10.5px * var(--ui-text-scale));letter-spacing:.14em;color:var(--ink-3,#7E8B94)}
.fit-stat b{display:block;margin-top:5px;font-size:calc(19px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums}
.fit-stat em{font-style:normal;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);margin-left:3px}
/* 总分单独挑出来：它和另外三格不是一类东西（一个是结论，三个是计数）。
   结论与等级要并排一行读（「75.4 分 · 及格」），所以这格自己开成两列网格。 */
.fit-stat.fit-total{display:grid;grid-template-columns:auto auto;align-items:baseline;column-gap:7px;
  background:color-mix(in srgb,var(--sea,#118AB2) 9%,var(--panel));
  border-color:color-mix(in srgb,var(--sea,#118AB2) 30%,var(--line))}
.fit-stat.fit-total span{grid-column:1/-1}
.fit-stat.fit-total b{font-size:calc(21px * var(--ui-text-scale));color:var(--sea,#118AB2)}
.fit-lv{display:inline-block;font-style:normal;font-size:calc(10.5px * var(--ui-text-scale));
  padding:2px 7px;border-radius:999px;white-space:nowrap;
  color:var(--sea,#118AB2);background:color-mix(in srgb,var(--sea,#118AB2) 13%,transparent)}
.fit-lv.good{color:var(--good,#0F7A43);background:color-mix(in srgb,var(--good,#0F7A43) 12%,transparent)}
.fit-lv.bad{color:var(--bad,#B3261E);background:color-mix(in srgb,var(--bad,#B3261E) 12%,transparent)}
.fit-sub{margin:0;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);line-height:1.65}

/* 学期单选（铁律六）：光块由宿主的 tide.ui.selectionGlow 画在 .fit-chips 上，
   这里只给容器定位与一套配色 —— 选中项把自己的底色让给光块。 */
.fit-terms{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.fit-terms::-webkit-scrollbar{display:none}
.fit-chips{display:flex;gap:6px;position:relative;isolation:isolate;padding:2px}
.fit-chips .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;
  transition:opacity .2s linear;border:1px solid color-mix(in srgb,var(--sea,#118AB2) 26%,var(--line));
  border-radius:999px;background:color-mix(in srgb,var(--sea,#118AB2) 10%,var(--panel))}
.fit-chips .selection-glow.on{opacity:1}
.fit-chip{position:relative;z-index:1;font:inherit;font-size:calc(12px * var(--ui-text-scale));
  padding:5px 13px;border-radius:999px;cursor:pointer;white-space:nowrap;
  border:1px solid var(--line);background:var(--panel);color:var(--ink-2,#4A5A66)}
.fit-chip.on{background:transparent;border-color:transparent;color:var(--sea,#118AB2);font-weight:700}
.fit-chip:focus-visible{outline:2px solid var(--sea,#118AB2);outline-offset:2px}

/* 七项装在**一个**容器里：外层一枚卡片（边框 + 圆角 + overflow 裁切），
   项与项之间只留 1px 分隔线 —— 不再每项各套一个框（用户口径第 2 条）。 */
.fit-list{border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--panel);overflow:hidden}
.fit-item{position:relative;isolation:isolate}
.fit-item+.fit-item{border-top:1px solid color-mix(in srgb,var(--line) 72%,transparent)}
.fit-head{display:grid;grid-template-columns:34px minmax(0,1fr) auto auto;align-items:center;gap:11px;
  width:100%;padding:12px 14px;background:none;border:0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.fit-head:hover{background:color-mix(in srgb,var(--fit-c,var(--sea,#118AB2)) 8%,transparent)}
.fit-head:focus-visible{outline:2px solid var(--fit-c,var(--sea,#118AB2));outline-offset:-2px}
.fit-ic{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;overflow:hidden;flex:none}
.fit-ic img{width:34px;height:34px;display:block;object-fit:contain}
.fit-name{display:grid;gap:2px;min-width:0}
.fit-name b{font-size:calc(14px * var(--ui-text-scale));font-weight:600}
.fit-name span{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94)}
/* 成绩染色（用户口径第 3 条）：数字与文字都取图标主色。混一点 ink —— 浅色主题下 ink 是深色、
   等于压暗提对比，深色主题下 ink 是浅色、等于提亮 —— 一套写法两种模式都可读。 */
.fit-score{text-align:right;display:grid;gap:2px}
.fit-score b{font-size:calc(15px * var(--ui-text-scale));font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;
  color:color-mix(in srgb,var(--fit-c,var(--ink)) 86%,var(--ink) 14%)}
.fit-score span{font-size:calc(11px * var(--ui-text-scale));font-variant-numeric:tabular-nums;
  color:color-mix(in srgb,var(--fit-c,var(--ink-3)) 62%,var(--ink) 38%)}
.fit-arrow{width:16px;height:16px;flex:none;color:var(--ink-3,#7E8B94);transition:transform .28s cubic-bezier(.32,.72,.28,1)}
.fit-item[data-open="1"] .fit-arrow{transform:rotate(180deg)}

/* 展开 / 收起走 grid-template-rows 0fr ⇄ 1fr 的双向插值 —— 只淡入、
   或者关闭时直接 display:none 都会让下面内容「跳」一下（铁律七）。 */
.fit-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s cubic-bezier(.32,.72,.28,1)}
.fit-item[data-open="1"] .fit-body{grid-template-rows:1fr}
.fit-body>div{overflow:hidden;min-height:0}
.fit-rows{display:grid;gap:0;padding:0 14px 4px}
.fit-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:baseline;
  padding:8px 0;border-top:1px solid color-mix(in srgb,var(--line) 70%,transparent);font-size:calc(12px * var(--ui-text-scale))}
.fit-row:first-child{border-top:0}
.fit-row .fit-t{color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums;white-space:nowrap}
.fit-row .fit-s{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;
  color:color-mix(in srgb,var(--fit-c,var(--ink)) 86%,var(--ink) 14%)}
.fit-row .fit-f{color:var(--ink-2,#4A5A66);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:52px;text-align:right}
.fit-remark{grid-column:1/-1;margin:2px 0 0;font-size:calc(11px * var(--ui-text-scale));color:var(--warn,#B4590B)}
.fit-tag{font-size:calc(10.5px * var(--ui-text-scale));padding:2px 8px;border-radius:999px;white-space:nowrap}
.fit-tag.good{color:var(--good,#0F7A43);background:color-mix(in srgb,var(--good,#0F7A43) 8%,transparent)}
.fit-tag.info{color:var(--sea,#118AB2);background:color-mix(in srgb,var(--sea,#118AB2) 8%,transparent)}
.fit-tag.warn{color:var(--warn,#B4590B);background:color-mix(in srgb,var(--warn,#B4590B) 8%,transparent)}
.fit-tag.bad{color:var(--bad,#B3261E);background:color-mix(in srgb,var(--bad,#B3261E) 8%,transparent)}
.fit-tag.flat{color:var(--ink-3,#7E8B94);background:color-mix(in srgb,var(--ink-3,#7E8B94) 8%,transparent)}

.fit-best{font-size:calc(10.5px * var(--ui-text-scale));letter-spacing:.1em;color:var(--ink-3,#7E8B94);
  padding:10px 14px 0}
.fit-note{margin:0;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);line-height:1.6}
.fit-note.bad{color:var(--bad,#B3261E)}
.fit-note code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:calc(11px * var(--ui-text-scale));
  padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--ink-3,#7E8B94) 14%,transparent)}
.fit-empty{border:1px dashed var(--line);border-radius:var(--radius,14px);padding:26px 18px;text-align:center;
  color:var(--ink-3,#7E8B94);font-size:calc(12.5px * var(--ui-text-scale));line-height:1.7}
@media (max-width:520px){
  .fit-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .fit-head{grid-template-columns:30px minmax(0,1fr) auto;gap:9px;padding:11px 12px}
  .fit-arrow{display:none}
}
@media (prefers-reduced-motion:reduce){
  .fit-body,.fit-arrow,.fit-spin{transition:none;animation:none}
}
`;
    document.head.appendChild(node);
  }

  // ── 数据 ────────────────────────────────────────────────────────────────
  /** 按项目分组；组内按测试时间倒序，第一条是「最好」（fraction 最高，同分取更晚的）。 */
  function groupBy(items) {
    const map = new Map();
    for (const raw of Array.isArray(items) ? items : []) {
      const it = raw && typeof raw === "object" ? raw : {};
      const name = clean(it.projectName) || "未命名项目";
      if (!map.has(name)) map.set(name, { name, unit: clean(it.projectUnit), icon: clean(it.projectIcon), rows: [] });
      const g = map.get(name);
      g.rows.push({
        id: clean(it.id),
        score: clean(it.score) || clean(it.scoreOriginal),
        original: clean(it.scoreOriginal),
        unit: clean(it.projectUnit),
        fraction: num(it.fraction),
        level: clean(it.level),
        remark: clean(it.remark),
        time: clean(it.testTime),
        term: clean(it.termName),
      });
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.rows.sort((a, b) => String(b.time).localeCompare(String(a.time)));
      let bestIdx = 0;
      for (let i = 1; i < g.rows.length; i += 1) {
        if (g.rows[i].fraction > g.rows[bestIdx].fraction) bestIdx = i;
      }
      [g.rows[0], g.rows[bestIdx]] = [g.rows[bestIdx], g.rows[0]];
      g.best = g.rows[0];
      g.rest = g.rows.slice(1);
    }
    // 项目顺序：得分高的在前（成绩单读法），同分按名称稳定排序
    groups.sort((a, b) => (b.best.fraction - a.best.fraction) || a.name.localeCompare(b.name, "zh"));
    return groups;
  }

  function allRows(items) {
    return (Array.isArray(items) ? items : []).filter((x) => x && typeof x === "object");
  }

  function termLabel(items) {
    const terms = [...new Set(allRows(items).map((x) => clean(x.termName)).filter(Boolean))];
    if (!terms.length) return "—";
    return terms.length === 1 ? terms[0] : `${terms[0]} 等 ${terms.length} 个`;
  }

  /* 体测总分的算法：国家学生体质健康标准（大学组）的七项权重，合计 100%。
     每一项用自己的最好一次成绩（fraction，百分制）乘权重再相加 —— 这就是学校上报的那个总分。
     1000 米 / 800 米、引体向上 / 1 分钟仰卧起坐 是男女二选一，占同一格权重。
     服务端没有给总分接口（getZLScore 恒返回「不能展示记录成绩」），也没有 weightScore 字段，
     所以这里按标准权重自己算；有项目还没出成绩时不编数，只算已出的部分并在下面写明缺几项。 */
  const WEIGHT_SLOTS = [
    { w: 0.15, names: ["体重/身高", "身高体重", "体重指数", "BMI"] },
    { w: 0.15, names: ["肺活量"] },
    { w: 0.2, names: ["50米", "50 米"] },
    { w: 0.1, names: ["坐位体前屈"] },
    { w: 0.1, names: ["立定跳远"] },
    { w: 0.1, names: ["引体向上", "仰卧起坐"] },
    { w: 0.2, names: ["1000米", "1000 米", "800米", "800 米"] },
  ];

  function levelOfScore(score) {
    if (!(score > 0)) return "";
    if (score >= 90) return "优秀";
    if (score >= 80) return "良好";
    if (score >= 60) return "及格";
    return "不及格";
  }

  /** groups = groupBy(filteredItems())，每项一条且 best 已是该项最好一次。 */
  function totalOf(groups) {
    const byName = new Map(groups.map((g) => [g.name, g]));
    const used = new Set();
    let sum = 0;
    let covered = 0;
    const missing = [];
    for (const slot of WEIGHT_SLOTS) {
      const hit = slot.names.map((n) => byName.get(n)).find(Boolean);
      if (!hit) { missing.push(slot.names[0]); continue; }
      used.add(hit.name);
      const f = Number(hit.best && hit.best.fraction);
      if (!Number.isFinite(f) || f <= 0) { missing.push(hit.name); continue; }
      sum += f * slot.w;
      covered += 1;
    }
    // 权重表之外的项（学校自加的项目）不计入总分，但要让人知道它没被算进去
    const extra = groups.filter((g) => !used.has(g.name)).map((g) => g.name);
    return { score: covered ? sum : 0, covered, slots: WEIGHT_SLOTS.length, missing, extra };
  }

  /** 数据里出现过的学期，新的在前。 */
  function termList(items) {
    const seen = [];
    for (const x of allRows(items)) {
      const t = clean(x && x.termName);
      if (t && !seen.includes(t)) seen.push(t);
    }
    return seen.sort((a, b) => String(b).localeCompare(String(a), "zh"));
  }

  /** 当前学期下的记录；state.term 为空 = 全部学期。 */
  function filteredItems() {
    const rows = allRows(state.items).filter((x) => x && typeof x === "object");
    if (!state.term) return rows;
    return rows.filter((x) => clean(x.termName) === state.term);
  }

  async function readCache(key) {
    try {
      const v = await tide.cache?.get?.(key, null);
      return v && typeof v === "object" ? v : null;
    } catch { return null; }
  }
  async function writeCache(key, value) {
    try { await tide.cache?.set?.(key, value); } catch { /* 缓存写不进去不该挡着人看数据 */ }
  }

  async function readSeed() {
    try {
      const arr = await tide.assets.json(SEED);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  /** 首次进入：缓存 → 内置快照。都不联网。 */
  async function load() {
    if (state.items.length) return;         // 本次会话里已经有数据，重进直接用
    const cached = await readCache(CACHE_KEY);
    if (cached && Array.isArray(cached.items) && cached.items.length) {
      state.items = cached.items;
      state.fetchedAt = Number(cached.fetchedAt) || 0;
      state.source = "cache";
      return;
    }
    const seed = await readSeed();
    if (seed.length) {
      state.items = seed;
      state.fetchedAt = 0;
      state.source = "seed";
    }
  }

  /** 刷新：只有这里有网络请求。 */
  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    state.note = "";
    paint();
    try {
      const saved = await readCache(TOKEN_KEY);
      const token = clean(saved && (saved.token || saved.Authorization || saved.value));
      if (!token) {
        state.error = "还没拿到体测 token";
        state.note = "在项目目录跑一次 tools/sync-fitness.mjs（会自动读取企业微信的登录态），再回来点刷新。";
        return;
      }
      const sid = await tide.http.session();
      const res = await tide.http.fetch(sid, "POST", API, {
        headers: {
          "User-Agent": WXWORK_UA,
          Referer: ORIGIN + "/",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Content-Type": "application/json;charset=UTF-8",
          Authorization: token,
        },
        body: "{}",
      });
      let json = null;
      try { json = JSON.parse(String(res && res.body)); } catch { json = null; }
      if (!json || typeof json !== "object") {
        state.error = "体测接口返回的不是 JSON";
        state.note = `HTTP ${res && res.status}；可能是网络或服务端异常，稍后再点一次刷新。`;
        return;
      }
      const code = clean(json.status);
      if (code && code !== "00" && code !== "0") {
        state.error = clean(json.msg) || `接口返回 status=${code}`;
        state.note = /过期|登录/.test(state.error)
          ? "企业微信的登录态已经过期，重跑一次 tools/sync-fitness.mjs 就能续上。"
          : "服务端拒绝了这次请求，稍后再试；反复这样就重跑同步脚本。";
        return;
      }
      const data = Array.isArray(json.data) ? json.data : [];
      if (!data.length) {
        state.error = "接口通了，但没有取到任何体测记录";
        state.note = "如果网页里能看到成绩，说明这份 token 对应的不是同一个身份，重跑同步脚本。";
        return;
      }
      state.items = data;
      state.fetchedAt = Date.now();
      state.source = "api";
      await writeCache(CACHE_KEY, { items: data, fetchedAt: state.fetchedAt, source: "api" });
      state.note = `已刷新 · ${data.length} 条记录`;
      kickIcons();
    } catch (error) {
      state.error = (error && error.message) || String(error);
      state.note = "请求没发出去：检查网络，或重跑同步脚本换一份 token。";
    } finally {
      state.loading = false;
      if (!state.disposed) paint();
    }
  }

  /** 把服务端给的 projectIcon 抓成 data URL 存起来；失败就继续用内联 SVG。 */
  let iconsKicked = false;
  async function kickIcons() {
    if (iconsKicked || !tide.http?.getIcon) return;
    iconsKicked = true;
    const urls = [...new Set(groupBy(state.items).map((g) => g.icon).filter(Boolean))];
    if (!urls.length) return;
    const known = (await readCache(ICON_KEY)) || {};
    const next = { ...known };
    let changed = false;
    for (const url of urls.slice(0, 12)) {
      if (next[url]) { state.icons[url] = next[url]; continue; }
      try {
        const dataUrl = await tide.http.getIcon(url);
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
          next[url] = dataUrl;
          state.icons[url] = dataUrl;
          changed = true;
        }
      } catch { /* 拿不到就用 SVG，不是错误 */ }
    }
    if (changed) await writeCache(ICON_KEY, next);
    if (!state.disposed && changed) paint();
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  function timeText(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return `${sameYear ? "" : d.getFullYear() + "-"}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const shortTime = (s) => {
    const v = clean(s);
    return v ? v.slice(5, 16) : "—";     // "2025-12-16 15:25:00" → "12-16 15:25"
  };

  function itemHtml(g) {
    const open = state.expanded.has(g.name);
    const tone = toneOf(g.best.level);
    const iconData = g.icon && state.icons[g.icon];
    const icon = iconHtml(g.name, iconData);
    /* 这一项的色彩来源：图标主色。成绩数字、每次记录都跟着它走。 */
    const tint = colorOf(g.name);
    const rows = g.rest.map((r) => `
      <div class="fit-row">
        <span class="fit-t">${esc(shortTime(r.time))}</span>
        <span class="fit-s">${esc(r.score || "—")}</span>
        <span class="fit-f">${r.fraction ? r.fraction.toFixed(2) : "—"}</span>
        ${r.remark ? `<p class="fit-remark">${esc(r.remark)}</p>` : ""}
      </div>`).join("");
    return `
    <div class="fit-item" data-open="${open ? 1 : 0}" data-name="${esc(g.name)}" style="--fit-c:${esc(tint)}">
      <button type="button" class="fit-head" data-toggle aria-expanded="${open ? "true" : "false"}">
        <span class="fit-ic">${icon}</span>
        <span class="fit-name">
          <b>${esc(g.name)}</b>
          <span>${g.rows.length} 次记录 · ${esc(clean(g.best.term) || "—")}</span>
        </span>
        <span class="fit-score">
          <b>${esc(g.best.score || "—")}</b>
          <span>${g.best.fraction ? g.best.fraction.toFixed(2) + " 分" : "—"}</span>
        </span>
        <svg class="fit-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="fit-body"><div>
        <p class="fit-best">最好成绩 · ${esc(g.best.score || "—")}
          <span class="fit-tag ${tone}">${esc(g.best.level || "未评级")}</span></p>
        <div class="fit-rows">${rows || '<div class="fit-row"><span class="fit-t">只有这一条记录</span></div>'}</div>
      </div></div>
    </div>`;
  }

  /* 学期胶囊：只有一个学期时没有可切换的，就只显示那一枚（不当成开关）；
     有两个以上才多出「全部」。光块交给宿主的 selectionGlow，见 bind() 之后的 syncTermGlow()。 */
  function termsHtml() {
    const terms = termList(state.items);
    if (!terms.length) return "";
    /* 只有一个学期时它必然就是当前视图 —— 也要标成选中，否则光块无处落、看着像没选。 */
    const cur = state.term || (terms.length === 1 ? terms[0] : "");
    const chip = (id, label) => `<button type="button" class="fit-chip${cur === id ? " on" : ""}"`
      + ` data-term="${esc(id)}" aria-pressed="${cur === id ? "true" : "false"}">${esc(label)}</button>`;
    const parts = terms.length > 1 ? [chip("", "全部")] : [];
    for (const t of terms) parts.push(chip(t, t));
    return `<div class="fit-terms"><div class="fit-chips" role="group" aria-label="学期">${parts.join("")}</div></div>`;
  }

  function bodyHtml() {
    const rows = filteredItems();
    const groups = groupBy(rows);
    const rowCount = rows.length;
    if (!groups.length) {
      return `<div class="fit-empty">还没有体测数据。<br>点右上角「刷新」抓一次；如果提示没有 token，先跑一次同步脚本。</div>`;
    }
    const termNow = state.term || termLabel(state.items);
    const sum = totalOf(groups);
    const lv = levelOfScore(sum.score);
    const cells = [];
    if (sum.score > 0) {
      cells.push(`<div class="fit-stat fit-total"><span>总分</span>`
        + `<b>${sum.score.toFixed(1)}<em>分</em></b>`
        + `<i class="fit-lv${lv === "优秀" || lv === "良好" ? " good" : lv === "不及格" ? " bad" : ""}">${esc(lv)}</i></div>`);
    }
    cells.push(`<div class="fit-stat"><span>项目</span><b>${groups.length}<em>项</em></b></div>`);
    cells.push(`<div class="fit-stat"><span>记录</span><b>${rowCount}<em>条</em></b></div>`);
    cells.push(`<div class="fit-stat"><span>学期</span><b style="font-size:calc(14px * var(--ui-text-scale))">${esc(termNow)}</b></div>`);
    /* 总分是算出来的，不是接口给的 —— 把这句写在明面上，并交代哪几项没算进去。 */
    const sumNote = sum.score > 0
      ? `<p class="fit-note fit-sub">总分按国家学生体质健康标准权重加权（各项目取最好一次）`
        + `${sum.missing.length ? `；还有 ${sum.missing.length} 项没出成绩（${esc(sum.missing.join("、"))}），未计入` : ""}`
        + `${sum.extra.length ? `；${esc(sum.extra.join("、"))} 不在标准七项里，也未计入` : ""}。</p>`
      : "";
    return `
      <div class="fit-stats" data-n="${cells.length}">
        ${cells.join("")}
      </div>
      ${sumNote}
      ${termsHtml()}
      <div class="fit-list">${groups.map(itemHtml).join("")}</div>`;
  }

  function statusHtml() {
    if (state.error) {
      return `<p class="fit-note bad">${esc(state.error)}${state.note ? `<br>${esc(state.note)}` : ""}</p>`;
    }
    if (state.note) return `<p class="fit-note">${esc(state.note)}</p>`;
    if (state.source === "seed") {
      return `<p class="fit-note">当前是安装时随插件带的内置快照，不是实时数据。点「刷新」才重新取。</p>`;
    }
    return "";
  }

  function paint() {
    const host = state.root;
    if (!host || state.disposed) return;
    const groups = groupBy(state.items);
    const when = state.fetchedAt ? `更新于 ${timeText(state.fetchedAt)}` : (state.source === "seed" ? "内置快照" : "");
    host.innerHTML = `
      <div class="fit-wrap">
        <div class="fit-bar">
          <h2>我的体测</h2>
          <button type="button" class="fit-btn fit-primary" data-refresh ${state.loading ? "disabled" : ""}>
            ${state.loading ? '<span class="fit-spin" aria-hidden="true"></span>刷新中…' : "刷新"}
          </button>
          <span class="fit-when">${esc(when)}</span>
        </div>
        ${bodyHtml()}
        ${statusHtml()}
      </div>`;
    bind();
    syncTermGlow();
    if (!groups.length || state.source === "seed") kickIcons();
  }

  function bind() {
    const host = state.root;
    if (!host) return;
    const btn = host.querySelector("[data-refresh]");
    if (btn) btn.addEventListener("click", () => { refresh(); });

    /* 学期胶囊是单选切换 —— 重绘会把 [data-term] 整片换掉，所以每次重绘后按新 DOM 重挂一次。 */
    host.querySelectorAll("[data-term]").forEach((el) => {
      el.addEventListener("click", () => {
        const next = el.getAttribute("data-term") || "";
        if (next === state.term) return;
        state.term = next;
        savePrefs();
        paint();
      });
    });

    host.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const item = el.closest(".fit-item");
        if (!item) return;
        const name = item.getAttribute("data-name") || "";
        const open = item.getAttribute("data-open") === "1";
        item.setAttribute("data-open", open ? "0" : "1");
        el.setAttribute("aria-expanded", open ? "false" : "true");
        if (open) state.expanded.delete(name); else state.expanded.add(name);
        // 收起后内部不能再被 Tab 到（grid-rows 收起来内容还在 DOM 里）
        const rowsWrap = item.querySelector(".fit-rows");
        if (rowsWrap) rowsWrap.inert = open;
        savePrefs();
      });
    });
    host.querySelectorAll(".fit-item").forEach((item) => {
      const rowsWrap = item.querySelector(".fit-rows");
      if (rowsWrap) rowsWrap.inert = item.getAttribute("data-open") !== "1";
    });
  }

  /* 学期胶囊的滑动选中光（铁律六）：光块由宿主 tide.ui.selectionGlow 画，
     插件只负责在每次重绘后重挂 —— 重绘会把 [data-term] 换成新节点，光块跟着没了，
     旧实例必须 dispose，否则宿主那边会累积 Disposer。 */
  let termGlow = null;
  function syncTermGlow() {
    const host = state.root;
    if (!host || state.disposed) return;
    const box = host.querySelector(".fit-chips");
    if (termGlow && termGlow.box === box && box && box.isConnected) { termGlow.glow?.sync?.(); return; }
    if (termGlow) { try { termGlow.glow?.dispose?.(); } catch { /* 宿主不给 dispose 就当它自己收 */ } termGlow = null; }
    if (!box) return;
    const glow = tide.ui?.selectionGlow?.(box, { selector: ".fit-chip.on" });
    if (glow) termGlow = { box, glow };
  }

  let saveTimer = 0;
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        tide.storage?.set?.(PREF_KEY, { expanded: [...state.expanded], term: state.term || "" });
      } catch { /* ignore */ }
    }, 300);
  }

  function render(host) {
    state.disposed = false;
    state.root = host;
    styles();
    host.innerHTML = `<div class="fit-wrap"><div class="fit-empty">正在读取体测数据…</div></div>`;
    let saved = null;
    try { saved = tide.storage?.get?.(PREF_KEY, null); } catch { saved = null; }
    if (saved && Array.isArray(saved.expanded)) state.expanded = new Set(saved.expanded);
    if (saved && typeof saved.term === "string") state.term = saved.term;

    load().then(() => {
      if (state.disposed) return;
      paint();
      if (!state.items.length) refresh();
    }).catch(() => {
      if (!state.disposed) paint();
    });

    return () => {
      state.disposed = true;
      state.root = null;
      clearTimeout(saveTimer);
      if (termGlow) { try { termGlow.glow?.dispose?.(); } catch { /* ignore */ } termGlow = null; }
    };
  }

  return { render, refresh: () => refresh() };
}
