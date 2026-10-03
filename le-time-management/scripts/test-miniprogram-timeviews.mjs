import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

/* ───────────── 小程序端时间视图（v0.38.0）─────────────
   小程序跑不了浏览器，也没有官方测试框架，所以这里用「真模块 + 打桩宿主」的办法：
   把 pages/timeblock/index.js 真正求值进一个沙箱（补上 require / Page / wx），
   再用桩 store 喂数据，直接调用它的数据构造函数，断言输出形状。

   这样能挡住的主要是「改了 WXML 忘了改 JS」这类**跨文件不一致** ——
   小程序的模板里读的是 {{item.xxx}}，JS 不给对应字段就是静默空白，
   本地 dev 与真机都不报错，只表现为「某一块是空的」。 */

const ROOT = new URL("../../", import.meta.url);
const read = (p) => readProductSource(new URL(p, ROOT), "utf8");

const wxml = read("miniprogram/pages/timeblock/index.wxml");
const wxss = read("miniprogram/pages/timeblock/index.wxss");
const pageSrc = read("miniprogram/pages/timeblock/index.js");

/* ── 1) 切换栏：7 个样式必须收进展开菜单，不再横排 scroll-x ── */
assert.doesNotMatch(wxml, /class="view-tabs"/, "旧的 7 tab 横排容器必须移除");
assert.doesNotMatch(wxml, /class="view-tab\b/, "旧的 .view-tab 必须移除");
assert.doesNotMatch(wxss, /\.view-tabs\b/, "旧的 .view-tabs 样式必须移除");
assert.doesNotMatch(wxss, /\.view-tab\b/, "旧的 .view-tab 样式必须移除");
assert.match(wxml, /class="vt-toggle"[\s\S]*?bindtap="onViewMenuToggle"/, "必须有展开触发器");
assert.match(wxml, /wx:if="\{\{viewMenuOpen\}\}" class="vt-menu"/, "菜单容器必须受 viewMenuOpen 控制");
assert.match(wxml, /class="vt-mask"[^>]*bindtap="onViewMenuClose"/, "点遮罩必须能关闭");
assert.match(wxml, /class="vt-item \{\{viewMode === item\.id \? 'on' : ''\}\}"/, "菜单项带选中态");
// 说明文案：7 个名字里「横向时间轴 / 卡片时间轴 / 年度甘特 / 阶段甘特」光看名字分不清
assert.match(wxml, /\{\{item\.desc\}\}/, "菜单项必须显示用途说明");
assert.match(wxss, /\.vt-item\s*\{[^}]*min-height:\s*88rpx/, "菜单项触控区 ≥88rpx（约 44px）");

/* ── 2) 7 个视图都不许再用横向滚动 ── */
for (const cls of [
  "wk-mini-scroll", "ms-scroll", "chron-scroll",
  "gantt-mobile-scroll", "swim-mobile-scroll",
]) {
  assert.ok(!wxml.includes(cls), `${cls}（横向滚动容器）必须移除 —— 横向滚动不是适配`);
  assert.ok(!wxss.includes(`.${cls}`), `${cls} 的样式也必须一并删掉，别留死声明`);
}
// 只看「5 个可视化视图」那一段 —— 日时间轴里保留的「近 7 天日期条 / 任务池」
// 本来就是短横条（7 个 chip / 几个卡片），横向滚动不影响可用性，不在改造范围内。
const vizStart = wxml.indexOf("viewMode === 'wakeup'");
assert.ok(vizStart > 0, "必须能找到可视化视图段");
const vizSeg = wxml.slice(vizStart);
assert.doesNotMatch(vizSeg, /<scroll-view[^>]*scroll-x/,
  "这 5 个可视化视图里不该再有 scroll-x —— 横向滚动不是适配");
// 日时间轴的两条短横条保留（顺带确认不是「一刀切删掉所有 scroll-x」）
assert.match(wxml, /class="days" scroll-x/, "日时间轴的日期条可保留横向滚动（7 个短 chip）");

/* ── 3) 折叠分组：三类视图共用同一套 .fold 结构 ── */
assert.match(wxml, /class="fold \{\{item\.today \? 'is-today' : ''\}\}"/, "WakeUp 按天折叠");
assert.match(wxml, /class="fold \{\{item\.isNow \? 'is-today' : ''\}\}"/, "年度甘特按月折叠");
assert.match(wxss, /\.fold-head\s*\{[^}]*min-height:\s*96rpx/, "折叠标题行触控区 ≥96rpx");
assert.match(wxss, /\.fold-caret\.up\s*\{\s*transform:\s*rotate\(180deg\)/, "展开时箭头要掉头");
for (const view of ["wakeup", "gantt"]) {
  const seg = wxml.slice(wxml.indexOf(`viewMode === '${view}'`), wxml.indexOf(`viewMode === '${view}'`) + 2600);
  assert.match(seg, /bindtap="onFoldTap"/, `${view} 必须能点标题展开/收起`);
}
// 阶段甘特用的是 `<view wx:else>`（7 个视图里的兜底分支），模板里搜不到它的 id，
// 所以单独按「它之后的内容」取段。
const swimSeg = wxml.slice(wxml.indexOf("swimCats"), wxml.length);
assert.match(swimSeg, /bindtap="onFoldTap"/, "swimlane（wx:else 兜底分支）必须能点标题展开/收起");

/* ── 4) 空态：4 个纯可视化视图都要有「先加数据」的提示，不能是一片空白 ── */
assert.match(wxml, /class="fold-empty"/, "必须有空态提示样式");
const emptyCount = (wxml.match(/fold-empty/g) || []).length;
assert.ok(emptyCount >= 4, `至少 4 处空态（里程碑/横向时间轴/卡片/甘特），实际 ${emptyCount}`);

/* ── 5) 🔴 不用 color-mix：小程序渲染引擎支持不可靠，全仓库其余 WXSS 都没用 ── */
// 剥掉注释再判定 —— 本文件的说明注释里就写着「不用 color-mix」这句话，否则会误伤自己。
const wxssCode = wxss.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(!wxssCode.includes("color-mix"), "小程序 WXSS 不得使用 color-mix（支持不可靠）");

/* ── 6) 真跑 JS 的数据构造函数（沙箱 + 桩 store）─────────────
   小程序的模板读 {{item.xxx}}，JS 不给字段就是静默空白 —— 不报错、只表现为「某块是空的」。 */

const captured = {};
const pageProxy = new Proxy({}, {
  get: (_, k) => captured[k],
  set: (_, k, v) => { captured[k] = v; return true; },
});

// 桩 store：形状要对齐 core/store.js 的对外接口
const today = "2026-09-15";
const blocks = [
  { id: "b1", date: today, start: "09:00", durMin: 60, title: "写方案", cat: "work" },
  { id: "b2", date: today, start: "11:00", durMin: 30, title: "跑步", cat: "sport" },
  { id: "b3", date: today, start: "14:00", durMin: 90, title: "读书", cat: "study" },
  { id: "b4", date: "2026-09-16", start: "10:00", durMin: 45, title: "组会", cat: "study" },
  { id: "b5", date: "2026-11-03", start: "09:30", durMin: 60, title: "中期检查", cat: "work" },
];
const tasks = [
  { id: "t1", title: "交论文初稿", done: false, due: "2026-09-20 23:59", createdAt: Date.now() - 86400000 * 20, project: "论文" },
  { id: "t2", title: "做完实验", done: false, due: "2026-11-15 23:59", createdAt: Date.now() - 86400000 * 60, tags: ["学习"] },
  { id: "t3", title: "已完成的事", done: true, due: "2026-09-01" },
];
const stubStore = {
  todayStr: () => today,
  getState: () => ({ settings: {}, blocks, tasks }),
  mmOf: (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; },
  hhmmOf: (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"),
  durLabel: (m) => (m >= 60 ? Math.floor(m / 60) + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "") : m + " 分钟"),
  weekdayCN: () => "二",
  addDays: (d, n) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); },
  fmtDate: (d) => d.toISOString().slice(0, 10),
  blocksOf: (d) => blocks.filter((b) => b.date === d),
  poolOf: () => tasks.filter((t) => !t.done),
  taskById: (id) => tasks.find((t) => t.id === id),
  saveNow: () => {},
  subscribe: () => () => {},
};

// 沙箱：把页面模块求值进去
const sandbox = {
  require: (p) => {
    if (p.includes("timeParser")) return { guessCategory: () => "work" };
    if (p.includes("store")) return stubStore;
    if (p.includes("undo")) return { bind: () => () => {}, offer() {}, run() {} };
    if (p.includes("files")) return { notifyError() {} };
    throw new Error("意外的 require: " + p);
  },
  Page: (def) => { Object.assign(captured, def); },
  module: { exports: {} },
  exports: {},
  console,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  JSON,
  setInterval: () => 0,
  clearInterval: () => {},
  wx: { showToast: () => {}, vibrateShort: () => {}, showModal: () => {}, showActionSheet: () => {} },
  getApp: () => ({ globalData: {} }),
};
sandbox.global = sandbox;
try {
  vm.runInNewContext(pageSrc, sandbox, { filename: "timeblock/index.js" });
} catch (e) {
  throw new Error("页面模块求值失败（语法或顶层代码问题）：" + e.message);
}

assert.ok(typeof captured.buildWakeupData === "function", "必须能拿到 buildWakeupData");
assert.ok(typeof captured.buildGanttMonths === "function", "必须能拿到 buildGanttMonths");
assert.ok(typeof captured.buildSwimCats === "function", "必须能拿到 buildSwimCats");
assert.ok(Array.isArray(captured.data.viewTabs), "data.viewTabs 必须是数组");

// 7 个样式齐全，且每个都带 desc
assert.equal(captured.data.viewTabs.length, 7, "必须是 7 个样式");
const tabIds = captured.data.viewTabs.map((t) => t.id);
// 用 join 比较而不是 deepEqual —— viewTabs 来自 vm 沙箱（另一个 realm），
// 数组原型与 Node 主 realm 不同，deepEqual / deepStrictEqual 会因原型差异判不等。
assert.equal(tabIds.join(","), "day,wakeup,milestone,chronicle,cards,gantt,swimlane",
  "7 个样式的 id 与顺序必须与桌面端 VIEW_META 一致");
for (const t of captured.data.viewTabs) {
  assert.ok(t.label && t.desc, `${t.id} 必须有 label 与 desc`);
}

// ── WakeUp：按天分组，7 天齐全，今天默认展开 ──
const wk = captured.buildWakeupData(today);
assert.equal(wk.days.length, 7, "必须是一整周 7 天");
assert.ok(/～/.test(wk.label), "必须给出周区间标签");
const wkToday = wk.days.find((d) => d.today);
assert.ok(wkToday, "必须标出今天");
assert.equal(wkToday.date, today, "今天标记必须落在 todayStr 那一天");
const wkWithBlocks = wk.days.find((d) => d.count > 0);
assert.ok(wkWithBlocks, "有数据的那天必须有 count");
// 行必须按开始时间升序（折叠列表是日程表，不是时间轴格）
const rows = wkWithBlocks.blocks;
for (let i = 1; i < rows.length; i++) {
  assert.ok(rows[i - 1].timeLabel <= rows[i].timeLabel, "每天的日程行必须按开始时间升序");
}
const r0 = wkWithBlocks.blocks[0];
for (const f of ["id", "title", "cat", "catLabel", "timeLabel"]) {
  assert.ok(r0[f] !== undefined && r0[f] !== "", `WakeUp 行必须带 ${f}（模板里读 {{b.${f}}}）`);
}
// 不再输出 top/height（那是横向网格画布的坐标，折叠列表用不到）
assert.ok(!("top" in r0) && !("height" in r0), "折叠列表不该再算 top/height 像素");

// ── 年度甘特：只列有内容的月份 + 当前月，空月份不占屏 ──
const ganttRaw = captured.buildVisualData(today).gantt;
assert.ok(ganttRaw.length > 0, "桩数据下必须能生成甘特条");
for (const g of ganttRaw) {
  for (const f of ["title", "group", "color", "width", "rangeLabel", "_a", "_b"]) {
    assert.ok(g[f] !== undefined, `甘特条必须带 ${f}`);
  }
}
const gm = captured.buildGanttMonths(today, ganttRaw);
assert.equal(gm.year, 2026, "年份取自锚点日期");
assert.ok(gm.months.length < 12, `空月份必须被剔掉（实际 ${gm.months.length} 个月）`);
assert.ok(gm.months.some((m) => m.m === 9), "9 月有任务，必须保留");
assert.ok(gm.months.some((m) => m.m === 11), "11 月有任务，必须保留");
assert.ok(gm.months.every((m) => m.hit.length || m.isNow), "留下的月份要么有内容，要么是当前月");
// 月份必须按 1→12 升序，不能因为过滤而乱序（同样用 join 绕开跨 realm 原型差异）
const ms = gm.months.map((m) => m.m);
assert.equal(ms.join(","), ms.slice().sort((a, b) => a - b).join(","), "过滤后月份仍须升序");
for (const h of gm.months.flatMap((m) => m.hit)) {
  assert.ok(h.title && h.color && h.rangeLabel, "月内条目必须带 title/color/rangeLabel");
}

// ── 阶段甘特：5 个分类齐全，条带日期，占比按「分类时长 / 当月总时长」 ──
const swimRaw = captured.buildVisualData(today).swim;
for (const s of swimRaw) {
  assert.ok(Number.isFinite(s.sumMin), `泳道 ${s.cat} 必须携带 sumMin（分类时长），否则占比算不出来`);
}
const sm = captured.buildSwimCats(today, swimRaw);
assert.equal(sm.cats.length, 5, "必须是 5 个分类");
assert.ok(/年|月/.test(sm.label), "必须给出月份标签");
let pctSum = 0;
for (const c of sm.cats) {
  assert.ok(c.cat && c.label && Array.isArray(c.bars), `分类 ${c.cat} 结构不全`);
  assert.ok(c.sumLabel, `分类 ${c.cat} 必须有合计`);
  assert.ok(Number.isFinite(c.pct) && c.pct >= 0 && c.pct <= 100,
    `分类 ${c.cat} 占比必须在 0~100（实际 ${c.pct}）`);
  pctSum += c.pct;
  for (const b of c.bars) {
    assert.ok(b.title, "条目必须有 title");
    assert.ok(Number.isFinite(b.day) && b.day >= 1 && b.day <= 31, `条目的「日」必须在 1~31（实际 ${b.day}）`);
    assert.ok(Number.isFinite(b.durMin) && b.durMin > 0, "条目必须带真实时长 durMin");
  }
  // 分类内必须按日期升序
  const dseq = c.bars.map((b) => b.day);
  assert.equal(dseq.join(","), dseq.slice().sort((a, b) => a - b).join(","), `分类 ${c.cat} 内条目必须按日期升序`);
}
// 占比是「占当月总时长」，全部加起来应落在 100±2（四舍五入）
assert.ok(Math.abs(pctSum - 100) <= 2, `各分类占比之和应约等于 100%（实际 ${pctSum}%）—— 口径错了会明显偏离`);
const work = sm.cats.find((c) => c.cat === "work");
assert.ok(work.bars.length > 0, "桩数据里有 work 分类的时间块，必须落到 work 分类下");
// 占比不许用条宽反推（那会得出「这根条占 31 格的多少」，无意义）
assert.ok(!/pct:\s*Math\.max\(6,\s*Math\.min\(100,\s*\(b\.width/.test(pageSrc),
  "占比必须按时长算，不能拿条宽 width 反推");

/* ── 7) 折叠状态：默认值不能被 refresh 反复覆盖 ──
   refresh() 由 store 订阅与 30 秒定时器反复触发。若每次都重算默认展开态，
   用户手动收起的分组会被立刻弹开 —— 这条靠「只在 key 不存在时兜底」保证。 */
const refreshSrc = pageSrc.slice(pageSrc.indexOf("refresh()"), pageSrc.indexOf("onViewTap(e)"));
assert.ok(refreshSrc.length > 1000, "必须能切出 refresh() 的实现段");
// 三个视图各自的默认展开态都必须走「key 不存在才兜底」的写法
assert.match(refreshSrc, /if\s*\(!\(d\.date in folds\)\)/, "WakeUp 默认展开态只在 key 不存在时兜底");
assert.match(refreshSrc, /if\s*\(!\("gm-"\s*\+\s*m\.m in folds\)\)/, "年度甘特默认展开态只在 key 不存在时兜底");
assert.match(refreshSrc, /if\s*\("sm-"\s*\+\s*c\.cat in folds\)/, "阶段甘特默认展开态只在 key 不存在时兜底");
assert.match(pageSrc, /openedCats\s*<\s*2/, "阶段甘特默认最多展开 2 个有内容的分类");
assert.match(pageSrc, /d\.today\b.*folds\[d\.date\]|folds\[d\.date\]\s*=\s*d\.today/,
  "WakeUp 默认只展开今天");
assert.match(pageSrc, /folds\["gm-"\s*\+\s*m\.m\]\s*=\s*m\.isNow/, "年度甘特默认只展开当前月");

/* ── 8) 折叠 key 必须在三处保持一致（模板 dataset ↔ JS 读法）── */
assert.match(wxml, /data-key="\{\{item\.date\}\}"/, "WakeUp 折叠 key 用日期");
assert.match(pageSrc, /f\[d\.date\]/, "WakeUp 读的 key 必须是 d.date");
assert.match(wxml, /data-key="gm-\{\{item\.m\}\}"/, "甘特折叠 key 用 gm-<月>");
assert.match(pageSrc, /f\["gm-"\s*\+\s*m\.m\]/, "甘特读的 key 必须是 gm-<月>");
assert.match(wxml, /data-key="sm-\{\{item\.cat\}\}"/, "泳道折叠 key 用 sm-<分类>");
assert.match(pageSrc, /f\["sm-"\s*\+\s*c\.cat\]/, "泳道读的 key 必须是 sm-<分类>");

/* ── 9) 视图名必须两端一致（桌面 VIEW_META ↔ 小程序 viewTabs）──
   v0.43.0 把「WakeUp课表」改成「课程表」时两端都得改。漏一端的话，桌面菜单与手机菜单
   会显示不同的名字，而两边各自的测试都测不出来（上面那条 id 断言只比了硬编码字符串，
   且完全没管 label）。这里直接把桌面事实源读进来逐项对比。 */
const desktopViews = read("le-time-management/src/views/timeViews.js");
const metaBlock = desktopViews.match(/const VIEW_META = \[([\s\S]*?)\n\];/)?.[1] ?? "";
assert.ok(metaBlock, "必须能从桌面端 timeViews.js 读到 VIEW_META");
const desktopPairs = [...metaBlock.matchAll(/\["([a-z]+)",\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
assert.equal(desktopPairs.length, 7, `桌面 VIEW_META 应有 7 项（读到 ${desktopPairs.length} 项）`);
assert.equal(desktopPairs.map(([id]) => id).join(","), tabIds.join(","),
  "两端视图 id 与顺序必须一致");
assert.equal(desktopPairs.map(([, label]) => label).join(","),
  captured.data.viewTabs.map((t) => t.label).join(","),
  "两端视图显示名必须逐字一致 —— 改名时漏改一端就会在这里红");

/* ── 分类配色：两端必须同色（v0.55.0「一种类型一种颜色」）──
   小程序取不到 CSS 变量，只能写十六进制；只改一端就会出现
   「桌面端工作=黄、手机端工作=青绿」—— 而这正是这次要消灭的问题。
   所以这里把两边的值对起来：桌面端 --cat-* 必须引用强调色令牌，小程序必须等于同一个值。 */
const desktopCss = read("le-time-management/src/styles.css");
const classicBlock = desktopCss.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.ok(classicBlock, "必须能从桌面端 styles.css 读到基础 :root");
const cssToken = (name) => classicBlock.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
const mpColors = pageSrc.match(/const CAT_COLORS = \{([^}]*)\}/)?.[1] ?? "";
assert.ok(mpColors, "小程序必须有 CAT_COLORS（分类配色的唯一出口）");
for (const cat of ["work", "study", "sport", "life", "rest"]) {
  const want = cssToken(`cat-${cat}`);
  const ref = want?.match(/^var\(--([\w-]+)\)$/)?.[1];
  assert.ok(ref, `桌面端 --cat-${cat} 必须引用强调色令牌（实际读到 ${want}）`);
  const hex = (cssToken(ref) || "").toUpperCase();
  assert.match(hex, /^#[0-9A-F]{6}$/, `桌面端 --${ref} 必须是十六进制`);
  const got = (mpColors.match(new RegExp(`${cat}:\\s*"(#[0-9A-Fa-f]{6})"`))?.[1] || "").toUpperCase();
  assert.equal(got, hex, `分类 ${cat} 两端必须同色：桌面端 ${ref}=${hex}，小程序 ${got || "缺失"}`);
}
// 分类色块上的文字色：黄 / 红 / 青绿底偏亮，白字只有 2.2~2.8:1，必须配深字
assert.match(wxss, /\.block\.cat-work\s*\{\s*color:\s*#17323A/, "小程序时间块的黄底必须配深字");
assert.match(wxss, /\.ms-date\.cat-work[^{]*\{\s*color:\s*#17323A/, "小程序里程碑日期徽章同理");
assert.match(wxss, /\.chron-v-date\.cat-work[^{]*\{\s*color:\s*#17323A/, "小程序年表日期徽章同理");

console.log("PASS: 小程序时间块 —— 7 样式收进展开菜单 + 5 个横向滚动视图改折叠/纵向（真跑数据构造）"
  + " + 分类配色与桌面端同源同值");
