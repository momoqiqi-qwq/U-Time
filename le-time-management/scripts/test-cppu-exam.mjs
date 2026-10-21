/*
 * 「我的考试」（cppu-notify 的 cppu-exam 视图）行为测试。
 *
 * 这一页的数据来自两块教务接口，形状差别很大：
 *   V_JWBZK_KWGL_KS_STU   考试计划（sql 型）—— 学期、计划名、开考到收考
 *   V_JWBZK_KWGL_KSRW_STU 考试任务（func 型）—— 我本人的每一场：课程 / 地点 / 时段
 * 所以这里既守「接口常量不许写错」（funcId 抄错就静默回空表，看不出是坏了），
 * 也守渲染口径：待考按正序、已结束倒序、下学期没排考要明说、日期解析不了不许编时间。
 *
 * 断言分两层：
 *   ① 源码结构 —— 常量、三处接线（jwEnsureKeys / 缓存 / 视图与侧栏）、图标真的在精灵里、
 *      搜索复用 roomFieldHits 而不是另写一套（铁律十只有一套实现，且带负例）；
 *   ② 行为 —— 在 vm 里把 main.js 真跑起来，用抓包得到的真实字段喂 jwExamRow，
 *      再对 jwExamHtml / jwApplyExamFilter 的产物做断言（含 URL 转义、空态、过滤负例）。
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readProductSource } from "./lib/read-product-source.mjs";

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");
const source = read("../public/plugins/cppu-notify/main.js");

/* ── ① 源码结构 ───────────────────────────────────────────────────────── */

// funcId 是从浏览器抓到的真实请求体里抄的：抄错不会被任何东西发现（接口回空表），只能钉死
const plan = source.match(/examPlan:\s*\{([^}]*)\}/);
assert.ok(plan, "JW_FUNC 里必须有 examPlan（考试计划 V_JWBZK_KWGL_KS_STU）");
assert.match(plan[1], /funcCode:\s*"V_JWBZK_KWGL_KS_STU"/);
assert.match(plan[1], /funcId:\s*"8doEdJCt9B3MRujeyKo"/);
const task = source.match(/examTask:\s*\{([^}]*)\}/);
assert.ok(task, "JW_FUNC 里必须有 examTask（考试任务 V_JWBZK_KWGL_KSRW_STU）");
assert.match(task[1], /funcCode:\s*"V_JWBZK_KWGL_KSRW_STU"/);
assert.match(task[1], /funcId:\s*"XyTHnkGDVnGOCTQECC6"/);
// XH 必须是 like '%学号%'：校方把整场考生的学号串在同一个字段里，等号一个都匹配不上
assert.match(source, /code:\s*"XH",\s*type:\s*"like",\s*value:\s*`%\$\{uid\}%`/,
  "考试任务必须按 XH like '%学号%' 过滤");
assert.match(source, /code:\s*"KS",\s*type:\s*"=",\s*value:\s*plan\.id/, "必须按计划 ID（KS）筛任务");
assert.match(source, /code:\s*"XNXQ",\s*type:\s*"=",\s*value:\s*plan\.term/, "必须按学期（XNXQ）筛任务");

// 三处接线：取数分支、缓存存取、视图 + 侧栏入口。少一处就是「点进去一片空白还不报错」
assert.match(source, /if \(key === "exam"\) jwState\.data\.exam = await jeLoadExam\(\);/, "jwEnsureKeys 必须认 exam");
assert.match(source, /if \(!force && key === "exam" && jwState\.data\.exam\?\.plans\?\.length\) continue;/, "有缓存的考试不该每次进页面重拉");
assert.match(source, /keep\.exam = jwState\.data\.exam/, "考试必须落缓存（它是对象，上面那个数组循环收不进去）");
assert.match(source, /jwState\.data\.exam === null && c\.keep\?\.exam[\s\S]{0,160}jwState\.data\.exam = c\.keep\.exam/, "考试必须从缓存恢复");
assert.match(source, /id: "cppu-exam", title: "警大考试", icon: "clock", keys: \["exam"\]/, "JW_VIEWS 必须有 cppu-exam");
assert.match(source, /\{ view: "cppu-exam", label: "我的考试", icon: "clock" \}/, "侧栏「教务」下必须有我的考试");

// 图标必须真在 solid 精灵里：calendar-clock 是 Pro 才有，写它会画出一个空图标
const sprite = read("../public/icons/fontawesome/solid.svg");
assert.ok(sprite.includes('id="clock"'), "solid.svg 里必须有 clock");
assert.ok(!source.includes('icon: "calendar-clock"'), "不许用精灵里不存在的 calendar-clock");

/* 搜索口径只有一套（铁律十）：逐字段 + 复用 roomFieldHits，不许 join 成整串 */
const filterSrc = source.slice(source.indexOf("function jwApplyExamFilter"), source.indexOf("function jwSyncExamGlow"));
assert.match(filterSrc, /fields\.some\(\(f\) => roomFieldHits\(f, t\)\)/, "考试过滤必须复用 roomFieldHits（逐字段）");
assert.match(filterSrc, /tokens\.every\(/, "多个词取交集，而不是把词拼成一串");
assert.doesNotMatch(filterSrc, /join\(" "\)/, "不许 join 成整串再比（跨字段假命中）");
assert.match(filterSrc, /没有匹配「\$\{raw\}」/, "空结果必须说人话");

/* 学期胶囊是单选 → 必须走宿主的滑动选中光（铁律六），且 .pp-chip.on 要把底色让给光块 */
assert.match(source, /tide\.ui\?\.selectionGlow\?\.\(box, \{ selector: "\.pp-chip\.on" \}\)/, "学期切换必须挂滑动选中光");
assert.match(source, /\.jw-exam-terms \.pp-chip\.on\{background:transparent/, "选中态底色必须让给光块");

/* 折叠必须双向可插值（铁律七）：0fr→1fr 的网格 + 不透明度 + 箭头旋转，收起时内容留在 DOM 里；
   display:none 或只做淡入都算没做完，减少动效时还要能立刻到位。 */
assert.match(source, /\.jw-exam-fold\{display:grid;grid-template-rows:0fr;opacity:0/, "折叠容器用 0fr 而不是 display:none");
assert.match(source, /\.jw-exam-card\.open \.jw-exam-fold\{grid-template-rows:1fr;opacity:1/, "展开要回到 1fr 并补不透明度");
assert.match(source, /\.jw-exam-card\.open \.jw-exam-chev\{transform:rotate\(180deg\)\}/, "箭头要跟着翻");
assert.match(source, /prefers-reduced-motion:reduce\)\{[^}]*\.jw-exam-fold,\.jw-exam-chev,/, "减少动效时折叠与箭头要立刻到位");

/* ── ② 行为：在 vm 里把 main.js 跑起来 ───────────────────────────────── */

const noop = () => {};
const context = vm.createContext({
  URL, Set, Map, WeakMap, Date, Promise, JSON, Math, RegExp, String, Number, Object, Array, Error, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: globalThis.crypto, btoa: globalThis.btoa, TextEncoder, URLSearchParams,
  document: { createElement: () => ({ set innerHTML(x) { this.value = x; } }), querySelectorAll: () => [] },
  Image: class { constructor() { this.naturalWidth = 0; this.naturalHeight = 0; } set src(v) { this._src = v; } decode() { return Promise.reject(new Error("no")); } },
  tide: {
    ui: { registerView: noop },
    http: { session: async () => "s1", restoreCookies: async () => "sid", fetch: async () => ({ status: 200, body: "[]" }) },
    storage: { set: async () => {}, get: async (k, d) => (d === undefined ? null : d) },
    vault: { get: async () => null, set: async () => {}, del: async () => {} },
    util: { openUrl: noop, web: { formEncode: () => "" } },
    notify: noop,
    assets: { saveBase64: async () => "", revealSaved: async () => ({ ok: true }) },
  },
});
const API = "state,jwState,JW_FUNC,JW_VIEWS,jwExamParse,jwExamRow,jwExamPlanOf,jwExamGap,jwExamHtml,jwApplyExamFilter,jwExamTermLabel,jwToggleExamCard";
const anchor = "  tide.ui.registerView({";
assert.ok(source.includes(anchor), "注入锚点变了：test-cppu 同款 testApi 注入失效");
vm.runInContext(source.replace(anchor, `  globalThis.testApi = {${API}};\n${anchor}`), context);
const api = context.testApi;
const { jwState, jwExamParse, jwExamRow, jwExamPlanOf, jwExamGap, jwExamHtml, jwApplyExamFilter, jwExamTermLabel, jwToggleExamCard } = api;

/* 日期解析：实测格式是 "2026-01-15 08:00-09:50"；解析不了就原样留着，不许编一个 08:00 */
const p1 = jwExamParse("2026-01-15 08:00-09:50");
assert.deepEqual(
  { date: p1.date, md: p1.md, day: p1.day, start: p1.start, end: p1.end },
  { date: "2026-01-15", md: "01-15", day: "四", start: "08:00", end: "09:50" },
  "标准时段必须解成日期 + 起止时刻",
);
const p2 = jwExamParse("2026-1-5 9:00~10:30");
assert.deepEqual({ date: p2.date, md: p2.md, day: p2.day, start: p2.start, end: p2.end, raw: p2.raw },
  { date: "2026-01-05", md: "01-05", day: "一", start: "09:00", end: "10:30", raw: "2026-1-5 9:00~10:30" },
  "补零、用「~」当分隔符也要认（校方两种都出现过）");
const odd = jwExamParse("时间另行通知");
assert.equal(odd.at, 0);
assert.equal(odd.raw, "时间另行通知", "非标准写法必须原样保留");
assert.equal(jwExamTermLabel("20252026-1"), "25-26 第1学期", "胶囊文案要短到一排装得下");
assert.equal(jwExamTermLabel("乱码"), "乱码");

/* 真实抓包字段 → 行模型 */
const FUTURE = "2030-01-15 08:00-09:50";
const PAST = "2020-01-15 08:00-09:50";
const rowFuture = jwExamRow({ ID: "a1", KCMC: "大学计算机", KCBH: "B01001", KSDD: "B301", KSSJQJ: FUTURE, ZKXM: "张老师", JKXM: "李老师" });
const rowPast = jwExamRow({ ID: "a2", KCMC: "心理健康教育", KCBH: "B02002", KSDD: "B302", KSSJQJ: PAST, ZKXM: "", JKXM: "" });
const rowOdd = jwExamRow({ ID: "a3", KCMC: "<img src=x onerror=alert(1)>", KSDD: "", KSSJQJ: "时间另行通知" });
assert.equal(rowFuture.course, "大学计算机");
assert.equal(rowFuture.place, "B301");
assert.equal(rowFuture.start, "08:00");
assert.equal(jwExamGap(rowFuture).key, "up");
assert.equal(jwExamGap(rowPast).key, "done");
assert.equal(jwExamGap(rowOdd).key, "unknown");

/* 渲染：两个学期 → 出胶囊；待考/已结束分组；下一场挂 .next；不逃逸的课程名要被转义 */
const planA = jwExamPlanOf({ ID: "p1", KSMC: "2025年秋季学期期末考试", XNXQ: "20252026-1", KSSJ: "2025年11月03日至2026年01月17日", KSJSSJ: 1768588800000 });
const planB = jwExamPlanOf({ ID: "p2", KSMC: "2026年春季学期期末考试", XNXQ: "20252026-2", KSSJ: "2026年06月29日至2026年07月09日", KSJSSJ: 1783526400000 });
assert.equal(planA.term, "20252026-1");
jwState.term = { code: "20252026-1", name: "2025-2026 学年第 1 学期" };
jwState.examFilter = "";
jwState.data.exam = { ok: true, at: Date.now(), plans: [planA, planB], current: "20252026-1", terms: { "20252026-1": [rowFuture, rowPast, rowOdd] } };
const html = jwExamHtml();
assert.match(html, /jw-exam-sum/, "首屏要有三格统计");
assert.match(html, /场考试 · 2 场待考/, "统计要报场次与待考场数（大数字已给总场数，不再重复「共 N 场」）");
assert.match(html, /<b>01\.15<\/b>/, "跨度那格要给出真实日期区间（MM-DD 只有 5 字符，切片写错就只剩「考试跨度」四个字）");
// 时段行只留时刻：卡上已经用日期块说了「哪天」，再写一遍「· 01-15 周三」是纯噪音
// （展开区的「日期」栏写完整日期是另一回事，别把断言写宽到连它一起禁掉）。
assert.doesNotMatch(html, /jw-exam-when"><b>[^<]*<\/b>\s*·\s*\d{2}-\d{2}/, "时段行不再重复日期：日期块已经说了哪天");
assert.match(html, /data-exam-term="20252026-1"/, "两个学期要出胶囊");
assert.match(html, /data-exam-term="20252026-2"/, "另一个学期也要在胶囊里");
assert.match(html, /class="pp-chip on"[^>]*data-exam-term="20252026-1"/, "当前学期胶囊选中");
assert.match(html, /jw-exam-card next/, "下一场要有左侧红条");
assert.match(html, /待考/);
assert.match(html, /已结束/);
assert.match(html, /class="jw-exam-card done"/, "考完的卡要置灰");
assert.doesNotMatch(html, /<img src=x/, "课程名必须转义，不许把节点塞进页面");
assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, "转义后的原文仍要看得见");
assert.match(html, /时间另行通知/, "日期解析不了就显示原文");
assert.match(html, /B301/, "考场要显示");
assert.match(html, /主考 张老师|主考<\/b>张老师/, "主考要显示");
assert.match(html, /class="jw-exam-wi"/, "考点/主考/监考各自 nowrap，窄屏不许把「监考 冯海生」拆出孤字");
assert.match(html, /class="jw-tag jw-exam-code"/, "课程编号是标签里最像「码」的一个，走自己的类");
assert.doesNotMatch(html, /教务还没排考/, "当前学期有考试时不该出现「本学期还没排考」");

/* 卡片可点开（用户 m00779）：默认收起，主考/监考/课程号/完整日期/教务原文都在折叠区里 */
assert.match(html, /class="jw-exam-card[^"]*"[\s\S]{0,120}role="button" tabindex="0" aria-expanded="false"/, "卡片本身要是个能聚焦的按钮，且默认收起");
assert.match(html, /<div class="jw-exam-fold"><div class="jw-exam-fold-clip">/, "折叠用 0fr→1fr 的网格，不用 display:none（那样没有收起动画）");
assert.match(html, /<div><b>监考<\/b>李老师<\/div>/, "监考收进展开区");
// 正常行的「教务原文」和日期/时段逐字相同，摆出来只是重复；格式怪（跨天/带「至」）时才留对照
assert.doesNotMatch(html, /<b>教务原文<\/b>/, "解析结果与原文一致时不重复一遍原文");
const oddRow = jwExamRow({ ID: "x9", KCMC: "军事理论", KSSJQJ: "2030-01-15 至 2030-01-16 08:00-09:50", KSDD: "B101" }, 0, "20252026-1");
assert.equal(oddRow.at > 0, true);
assert.match(oddRow.raw, /至/);
const oddHtml = (() => {
  jwState.data.exam.terms["20252026-1"] = [oddRow];
  const h = jwExamHtml();
  jwState.data.exam.terms["20252026-1"] = [rowFuture, rowPast, rowOdd];
  return h;
})();
assert.match(oddHtml, /<div class="jw-exam-span"><b>教务原文<\/b>/, "原文与解析不一致时要留原文对照，并且独占一行");
assert.doesNotMatch(html, /jw-exam-where"><span class="jw-exam-wi">主考/, "收起态不再摆主考监考两行，否则一屏只放得下两场");
assert.match(html, /jw-exam-chev/, "要有方向箭头");
assert.doesNotMatch(html, /class="jw-exam-sep"/, "旧的「·」分隔符不再出现");

/* 回退到别的学期时才解释原因：这句必须按**显示中的学期**还有没有待考来写，
   无条件写「已经考完了」会和下面「2 场待考」正面打架。 */
jwState.term = { code: "20262027-1", name: "2026-2027 学年第 1 学期" };
jwState.data.exam.current = "20252026-1";
assert.match(jwExamHtml(), /教务还没排考[\s\S]{0,80}还有 2 场没考/, "回退学期还有待考时要这么说");
jwState.data.exam.terms["20252026-1"] = [rowPast];
assert.match(jwExamHtml(), /教务还没排考[\s\S]{0,80}已经考完了/, "回退学期全部考完时才说已结束");
jwState.data.exam.terms["20252026-1"] = [rowFuture, rowPast, rowOdd];

/* 该学期一条都没有：给一句能懂的话，并指出计划名 */
jwState.data.exam.current = "20252026-2";
jwState.data.exam.terms["20252026-2"] = [];
assert.match(jwExamHtml(), /教务没给你的考试记录/, "空学期要有空态文案");

/* 学期还没拉（点了胶囊正在补）：不能是空白页 */
delete jwState.data.exam.terms["20252026-2"];
jwState.data.exam.current = "20252026-2";
assert.match(jwExamHtml(), /正在读取[\s\S]{0,40}考试安排/, "未拉取的学期要有等待文案");

/* 过滤：逐字段比 + 纯数字只认包含 + 负例必须真给空结果（拼音最容易写成「永远有结果」） */
jwState.term = { code: "20252026-1", name: "2025-2026 学年第 1 学期" };
jwState.data.exam.current = "20252026-1";
jwState.data.exam.terms["20252026-1"] = [rowFuture, rowPast, rowOdd];
jwState.examFilter = "";
jwExamHtml();                                  // 渲染时把可搜字段记进 examRowFields
// 卡片替身：jwToggleExamCard 会动 class / aria-expanded / jwState.examOpen，所以这几样得有真行为
const fakeCard = (idx, id) => {
  const cls = new Set(["jw-exam-card"]);
  const attrs = {};
  return {
    dataset: { examIdx: idx, examId: id },
    hidden: false,
    cls,
    classList: {
      contains: (c) => cls.has(c),
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => {
        const want = on === undefined ? !cls.has(c) : !!on;
        if (want) cls.add(c); else cls.delete(c);
        return want;
      },
    },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
  };
};
const cards = [fakeCard("0", "a1"), fakeCard("1", "a2"), fakeCard("2", "a3")];
const groups = [0, 1].map(() => ({ hidden: false, querySelector: () => cards.find((c) => !c.hidden) || null }));
const count = { textContent: "" };
const el = {
  isConnected: true,
  querySelectorAll: (sel) => (sel === ".jw-exam-card" ? cards : sel === "[data-exam-group]" ? groups : []),
  querySelector: (sel) => (sel === "[data-exam-count]" ? count : null),
};
const runFilter = (q) => {
  cards.forEach((c) => { c.hidden = false; });
  groupHiddenReset(groups);
  jwState.examFilter = q;
  jwApplyExamFilter(el);
  return cards.filter((c) => !c.hidden).map((c) => c.dataset.examIdx);
};
function groupHiddenReset(list) { list.forEach((g) => { g.hidden = false; }); }
assert.deepEqual(runFilter(""), ["0", "1", "2"], "空查询要全部显示");
assert.deepEqual(runFilter("大学计算机"), ["0"], "课程名原文命中");
assert.deepEqual(runFilter("B301"), ["0"], "考场命中");
assert.deepEqual(runFilter("张老师"), ["0"], "主考命中");
assert.deepEqual(runFilter("2030"), ["0"], "纯数字只认包含（日期）");
assert.deepEqual(runFilter("心理健康"), ["1"], "第二场课程名命中");
assert.deepEqual(runFilter("没有这门课"), [], "负例必须真的没有结果");
assert.match(count.textContent, /没有匹配「没有这门课」/, "空结果要说人话");
assert.deepEqual(runFilter("2030 08:00"), ["0"], "多个词取交集，且每个词只在单字段内比（不 join，避免跨字段假命中）");

/* 折叠（用户 m00779）：手动开关要真的动 class / aria，并按考试 ID 记住；
   命中「只在展开区」的字段时自动摊开 —— 否则搜「李老师」会得到一张看不见李老师的卡。 */
jwState.examOpen.clear();
cards.forEach((c) => { c.cls.delete("open"); c.setAttribute("aria-expanded", "false"); });
jwToggleExamCard(cards[0]);
assert.equal(cards[0].cls.has("open"), true, "点一下要摊开");
assert.equal(cards[0].getAttribute("aria-expanded"), "true", "aria-expanded 要跟着走");
assert.equal(jwState.examOpen.has("a1"), true, "摊开状态按考试 ID 记，重绘/切学期后还在");
jwToggleExamCard(cards[0]);
assert.equal(cards[0].cls.has("open"), false, "再点一下收起");
assert.equal(cards[0].getAttribute("aria-expanded"), "false", "收起后 aria-expanded 也要回落");
assert.equal(jwState.examOpen.size, 0, "收起要把它从记忆里删掉");

runFilter("大学计算机");
assert.equal(cards[0].cls.has("open"), false, "命中收起态本来就看得见的字段，不该被强摊开");
runFilter("李老师");                            // 监考只在展开区
assert.deepEqual(cards.filter((c) => !c.hidden).map((c) => c.dataset.examIdx), ["0"], "监考仍然可搜");
assert.equal(cards[0].cls.has("open"), true, "命中展开区字段时自动摊开");
jwState.examOpen.clear();

/* 计数行在清空搜索后要复原成考试计划名（场数已在大数字与分组标题里各说一次），
   不能留上一次的「匹配 1 / 全部 3」 */
runFilter("大学计算机");
runFilter("");
assert.match(count.textContent, /2025年秋季学期期末考试/, "清空搜索后计数行要复原成计划名");
assert.doesNotMatch(count.textContent, /匹配|共 \d+ 场/, "计数行不许第三次报场数");

console.log("test-cppu-exam: PASS");
