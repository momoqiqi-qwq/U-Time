// 小程序核心逻辑测试（Node 环境跑，mock wx 存储）
// 用法：node tools/test-miniprogram-core.js
// 覆盖：core/store.js 的 CRUD / 派生 / 持久化，core/timeParser.js 的解析规则
const BASE = new Date(2026, 8, 6); // 2026-09-06，周日，保证用例确定性

/* ── mock wx ── */
const mem = {};
global.wx = {
  getStorageSync(k) { return mem[k]; },
  setStorageSync(k, v) { mem[k] = v; },
};

const store = require("../miniprogram/core/store.js");
const parser = require("../miniprogram/core/timeParser.js");

let pass = 0, fail = 0;
function ok(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  ✓", name); }
  else { fail++; console.error("  ✗", name, "\n    期望", e, "\n    实际", a); }
}

/* ── store ── */
console.log("[store]");
store.initStore(store.seed());
/* v0.37.17 起 seed() 刻意全空（首启四象限干净），测试改为显式构造确定性数据 */
store.replaceAll({
  version: 1,
  tasks: [
    { id: "t1", title: "已完成的任务", quad: 1, done: true, estMin: 30 },
    { id: "t2", title: "象限一任务甲", quad: 1, estMin: 30 },
    { id: "t3", title: "象限一任务乙", quad: 1, estMin: 30 },
    { id: "t4", title: "象限二任务", quad: 2, estMin: 30 },
    { id: "t5", title: "任务五", quad: 2, estMin: 30 },
    { id: "t6", title: "任务六", quad: 3, estMin: 30 },
    { id: "t7", title: "任务七", quad: 4, estMin: 30 },
    { id: "t8", title: "任务八", quad: 2, estMin: 30 },
  ],
  blocks: [
    { id: "b1", date: store.todayStr(), start: "09:00", durMin: 30, title: "上午块", cat: "work" },
    { id: "b2", date: store.todayStr(), start: "11:00", durMin: 45, title: "上午块二", cat: "study" },
    { id: "b3", date: store.todayStr(), start: "11:45", durMin: 30, title: "上午块三", cat: "work" },
  ],
});
let st = store.getState();
ok("空种子策略下测试数据 8 任务 3 时间块", [st.tasks.length, st.blocks.length], [8, 3]);

const t = store.addTask({ title: "测试任务", quad: 2, estMin: 45, due: "2026-09-08" });
ok("addTask 返回带 id 的新任务", [st.tasks.length, st.tasks[0].title], [9, "测试任务"]);

store.updateTask(t.id, { quad: 3 });
ok("updateTask 生效", st.tasks.find((x) => x.id === t.id).quad, 3);

store.toggleTask(t.id);
ok("toggleTask 置完成", st.tasks.find((x) => x.id === t.id).done, true);
store.toggleTask(t.id);

const b = store.addBlock({ date: store.todayStr(), start: "08:00", durMin: 30, title: "早读", taskId: t.id, cat: "study" });
ok("poolOf 排除已安排任务", store.poolOf(store.todayStr()).some((x) => x.id === t.id), false);
ok("poolOf 未完成的都在池里", store.poolOf(store.todayStr()).length, 7); // 种子 8 个减去完成的 t1，新任务已排程被排除

ok("blocksOf 按开始时间排序", store.blocksOf(store.todayStr()).map((x) => x.start), ["08:00", "09:00", "11:00", "11:45"]);

store.removeTask(t.id);
ok("removeTask 级联删时间块", st.blocks.some((x) => x.id === b.id), false);
ok("删除后任务数复原", st.tasks.length, 8);

// 象限排序：未完成在前；同为未完成时按截止日期升序；完成的垫底
store.updateTask("t2", { due: "2026-09-20" });
store.updateTask("t3", { due: "2026-09-08" });
ok("tasksOfQuad：未完成在前、截止升序、完成垫底",
  store.tasksOfQuad(1).map((x) => x.id), ["t3", "t2", "t1"]);

// 持久化：saveNow 后重新 init 能读回
store.updateTask("t2", { title: "修复登录页线上 bug v2" });
store.saveNow();
store.initStore(store.seed()); // 应读回存储而不是种子
ok("持久化读回（防抖写盘生效）", store.getState().tasks.find((x) => x.id === "t2").title, "修复登录页线上 bug v2");

// replaceAll：导入备份（带兜底字段）
store.replaceAll({ tasks: [{ id: "x1", title: "导入的任务", quad: 1 }] });
ok("replaceAll 归一化缺省字段",
  [store.getState().tasks.length, store.getState().blocks.length, typeof store.getState().settings],
  [1, 0, "object"]);

/* ── timeParser ── */
console.log("[timeParser]");
function P(s) { return parser.parseWhen(s, BASE); }

let r = P("明天下午3点到4点 与导师讨论开题修改");
ok("明天下午3点到4点 → 日期/起止", [r.date, r.startMin, r.endMin], ["2026-09-07", 900, 960]);
ok("区间标题清洗", r.title.includes("导师讨论开题修改") && !r.title.includes("3点"), true);

r = P("9月10日 14:00 复查眼睛");
ok("X月X日 + HH:MM", [r.date, r.startMin], ["2026-09-10", 840]);

r = P("周五下午4点半 项目周会");
ok("周X + X点半", [r.date, r.startMin], ["2026-09-11", 990]);

r = P("今晚8点吃饭");
ok("今晚8点 → 今天 晚上8点", [r.date, r.startMin], ["2026-09-06", 1200]);

r = P("大后天 09:15 晨会");
ok("大后天 + HH:MM", [r.date, r.startMin], ["2026-09-09", 555]);

r = P("15号 交房租");
ok("X号（本月未来）", r.date, "2026-09-15");

r = P("月底 整理账目");
ok("月底", r.date, "2026-09-30");

r = P("下下周三 交论文初稿");
ok("下下周三", r.date, "2026-09-16");

r = P("2026-10-01 国庆出发");
ok("YYYY-MM-DD", [r.date, r.title], ["2026-10-01", "国庆出发"]);

r = P("回飞书群消息 12 条");
ok("无日期 → null", r.date, null);
ok("无日期 → 标题保留原文", r.title.includes("回飞书群消息"), true);

r = P("明天上午10点到下午3点 值班");
ok("跨时段区间（上午10点到下午3点）", [r.startMin, r.endMin], [600, 900]);

r = P("下周六晚上9点一刻 看电影");
ok("下周X + 9点一刻", [r.date, r.startMin], ["2026-09-12", 1275]);

ok("guessCategory 跑步 → sport", parser.guessCategory("晚上去跑步"), "sport");
ok("guessCategory 吃饭 → life", parser.guessCategory("中午和朋友聚餐"), "life");
ok("guessCategory 复习 → study", parser.guessCategory("复习线性代数"), "study");
ok("guessQuad 近两天 → I", parser.guessQuad("2026-09-07", BASE), 1);
ok("guessQuad 远期 → II", parser.guessQuad("2026-09-20", BASE), 2);
ok("guessQuad 无日期 → II", parser.guessQuad(null, BASE), 2);

/* ── captureFlow（捕获页建块流程） ── */
console.log("[captureFlow]");
const flow = require("../miniprogram/core/captureFlow.js");

let c = flow.buildCapture("明天下午3点到4点 与导师讨论开题", BASE);
ok("buildCapture 字段齐全",
  [c.title.includes("导师讨论开题"), c.due, c.start, c.dur, c.hasDate, c.hasTime, c.quad],
  [true, "2026-09-07", "15:00", 60, true, true, 1]);

c = flow.buildCapture("回飞书群消息", BASE);
ok("无日期捕获：estMin 60 / start 兜底 09:00", [c.hasDate, c.estMin, c.start], [false, 60, "09:00"]);

c = flow.buildCapture("下周六晚上9点一刻 看电影", BASE);
ok("一刻解析 → 21:15 · 时长默认 60", [c.start, c.estMin], ["21:15", 60]);

ok("durOptions 动态插入非档位时长",
  flow.durOptions(37).values, [15, 30, 37, 45, 60, 90, 120, 180]);
ok("durOptions 命中档位不重复", flow.durOptions(45).values.length, 7);

const before = store.getState().tasks.length;
const made = flow.createFromCapture(c, { date: "", start: "09:00", durMin: 60, cat: "work" });
ok("createFromCapture 无日期仅建任务",
  [made.hasBlock, store.getState().tasks.length - before, made.task.due],
  [false, 1, null]);

const b2 = flow.createFromCapture(c, { date: "2026-09-08", start: "10:30", durMin: 45, cat: "life" });
const nb = store.getState().blocks[store.getState().blocks.length - 1];
ok("createFromCapture 有日期建块字段一致",
  [b2.hasBlock, nb.date, nb.start, nb.durMin, nb.cat, nb.taskId === b2.task.id],
  [true, "2026-09-08", "10:30", 45, "life", true]);


/* ── 三端插件同步 / 小程序原生适配 ── */
console.log("[plugins]");
const catalog = require("../miniprogram/core/pluginCatalog.js");
const pluginRuntime = require("../miniprogram/core/pluginRuntime.js");
/* 数量与 tools/sync-plugins.js 的输出对齐（v0.54.0 批次新增 rss-reader 后为 15 / 10） */
ok("内置插件清单同步为 18 个", catalog.plugins.length, 18);
ok("小程序原生适配 13 个", catalog.plugins.filter((x) => x.platforms.miniprogram === "native").length, 13);
["plugin-guide", "wechat-push", "gx-news", "chaoxing-notify"].forEach((id) =>
  ok("新适配插件 " + id + " 标记 native", (catalog.byId[id].platforms || {}).miniprogram, "native"));
store.setPluginEnabled("pomodoro", false);
ok("插件启停写入与桌面相同的 plugins 字段", store.getState().plugins.pomodoro.enabled, false);
store.setPluginEnabled("pomodoro", true);
store.pluginStorageSet("pomodoro", "doneCount", 3);
ok("插件 storage 字段可跨端备份", store.getState().plugins.pomodoro.storage.doneCount, 3);
const hs = pluginRuntime.holidaySummary("2026-09-06");
ok("节假日适配读取桌面同源数据", [hs.available, hs.upcoming.length > 0], [true, true]);
const ex = pluginRuntime.futureExams("2026-09-06", 5);
ok("考试日历适配读取桌面内嵌数据", [ex.length > 0, ex.every((x) => x.date >= "2026-09-06")], [true, true]);
const cet4 = pluginRuntime.futureExams("2026-09-06", 60, "cet4");
ok("考试日历可只看 CET4 全流程", [cet4.length > 0, cet4.every((x) => ["cet4", "cet-set4"].includes(x.examId) || String(x.examId).includes("大学英语四六级"))], [true, true]);
const cetFlow = pluginRuntime.examFlow("2026-09-06", "cet4");
ok("CET 报名提示包含学校/考点与报名系统", [cetFlow.signupNotice.includes("学校"), cetFlow.signupNotice.includes("考点"), cetFlow.signupUrl], [true, true, "https://cet-bm.neea.edu.cn/"]);
const pth = pluginRuntime.futureExams("2026-09-06", 60, "putonghua");
ok("普通话水平测试已收录且按报名窗口标注", [pth.length >= 3, pth.every((x) => x.examId === "putonghua"), pth.some((x) => x.countdown.indexOf("报名") >= 0)], [true, true, true]);
const pthFlow = pluginRuntime.examFlow("2026-09-06", "putonghua");
ok("普通话报名提示说明无全国统一日期并给出官方入口", [pthFlow.signupNotice.includes("没有全国统一考试日期"), pthFlow.signupNotice.includes("bm.cltt.org"), pthFlow.signupUrl], [true, true, "https://bm.cltt.org/"]);
const wr = pluginRuntime.weeklyReport("2026-09-08");
ok("周度报告适配输出 7 天", wr.days.length, 7);

/* ── 轮换值日（dorm-duty）：多套轮换的纯逻辑真跑，不是源码字符串断言 ──
   与桌面端 public/plugins/dorm-duty/main.js 同源的规则，这里守五条不变量：
   ① 按「轮次」切段（周期内每天都是同一个人，否则每周轮换会天天催）
   ② 只在每轮第一天提醒 ③ 临时换人只影响那一轮
   ④ 坏时刻不能把提醒静默关掉 ⑤ 多套轮换之间完全隔离（成员/周期/换人/提醒互不串台） */
const DD = (raw, today) => pluginRuntime.ddNormalizeGroup(raw, today || "2026-09-17");
const DDG = (today, name, cfg) => DD(Object.assign({ name: name, startDate: "2026-09-14", periodDays: 7 }, cfg || {}), today);
const ddM = [{ id: "m1", name: "小北" }, { id: "m2", name: "老陈" }, { id: "m3", name: "阿青" }];
const ddWeek = DDG("2026-09-17", "宿舍值日", { members: ddM });

/* 1. 归一化：坏数据不能把页面画崩 */
{
  const bad = DD({ name: "   ", startDate: "不是日期", periodDays: 0, remindTime: "25:99" }, "2026-09-17");
  ok("空轮换名退回默认「值日」", bad.name, "值日");
  ok("非法起始日期退回今天", bad.startDate, "2026-09-17");
  ok("周期为 0 / 非法退回默认 7 天（0 是「没填」不是「每天」）", bad.periodDays, 7);
  ok("非法时刻退回 08:00", bad.remindTime, "08:00");
  ok("成员不是数组时当空处理", DD({ members: "坏了" }).members.length, 0);
  ok("overrides 不是对象时当空处理", Object.keys(DD({ overrides: "坏了" }).overrides).length, 0);
  ok("缺 id 的组必须补一个（否则切换轮换会指错对象）", !!DD({}).id, true);
  ok("空白 id 的组也要补（'' 会让两套轮换 id 撞在一起）", /^\S+$/.test(DD({ id: "   " }).id), true);
  ok("两套空白 id 的组各自拿到不同 id（否则切换轮换会指错对象）",
    (function () {
      const gs = pluginRuntime.ddGroups([{ id: "  ", name: "A" }, { id: "  ", name: "B" }], "2026-09-17");
      return gs.length === 2 && gs[0].id !== gs[1].id;
    })(), true);
  ok("显式关掉的提醒必须保留", DD({ remindEnabled: false }).remindEnabled, false);
  ok("边界 23:59 合法", DD({ remindTime: "23:59" }).remindTime, "23:59");
  ok("00:00 合法（午夜提醒）", DD({ remindTime: "00:00" }).remindTime, "00:00");
  ok("24:00 非法（时最大 23）", DD({ remindTime: "24:00" }).remindTime, "08:00");
  ok("25:99 非法（会静默关掉提醒）", DD({ remindTime: "25:99" }).remindTime, "08:00");
  ok("「8:5」被拒（分必须两位，与桌面端同规则）", DD({ remindTime: "8:5" }).remindTime, "08:00");
  ok("「8:05」补零后合法", DD({ remindTime: "8:05" }).remindTime, "08:05");
  ok("负周期夹到 1 天", DD({ periodDays: -3 }).periodDays, 1);
  ok("小数周期取整后不小于 1 天", DD({ periodDays: 0.4 }).periodDays, 1);
  ok("周期上限 365 天", DD({ periodDays: 9999 }).periodDays, 365);
  ok("未识别的键原样保留（桌面端字段不能被抹掉）", DD({ futureKey: "v" }).futureKey, "v");
  ok("桌面端选的提示音必须保留", DD({ sound: "chime" }).sound, "chime");
  ok("轮换名截断到 12 字", DD({ name: "一二三四五六七八九十十一十二十三" }).name.length, 12);
  ok("成员名截断到 16 字", DD({ members: [{ id: "a", name: "一二三四五六七八九十十一十二十三十四十五十六十七" }] }).members[0].name.length, 16);
  ok("无 id 的脏成员被剔掉", DD({ members: [{ name: "没 id" }, { id: "ok", name: "有 id" }] }).members.length, 1);
}

/* 2. 组列表归一化：重复 id / 垃圾条目 / 上限 */
{
  ok("组列表不是数组时当空处理", pluginRuntime.ddGroups("坏了", "2026-09-17").length, 0);
  ok("组列表为 null 时当空处理", pluginRuntime.ddGroups(null, "2026-09-17").length, 0);
  ok("垃圾条目各自兜成一套可用轮换，而不是整份丢掉",
    pluginRuntime.ddGroups([null, undefined, 3], "2026-09-17").length, 3);
  ok("重复 id 必须剔掉（会让「切换轮换」指错对象）",
    pluginRuntime.ddGroups([{ id: "x" }, { id: "x" }], "2026-09-17").length, 1);
  const many = [];
  for (let i = 0; i < pluginRuntime.DD_GROUP_MAX + 5; i++) many.push({ id: "g" + i, name: "组" + i });
  ok("组数夹到上限（否则界面被撑爆）",
    pluginRuntime.ddGroups(many, "2026-09-17").length, pluginRuntime.DD_GROUP_MAX);
}

/* 3. 旧版单套数据迁移 */
{
  const legacy = {
    members: ddM,
    config: { dutyName: "宿舍值日", startDate: "2026-09-14", periodDays: 7, remindTime: "07:30", remindEnabled: true, sound: "chime" },
    overrides: { "2026-09-14": "m3" },
    removed: [{ id: "m9", name: "走的人" }],
    lastNotified: "2026-09-14",
  };
  const m = pluginRuntime.ddMigrateLegacy(legacy, "2026-09-17");
  ok("旧数据迁移成 1 套轮换", m.length, 1);
  ok("迁移后保留原轮换名", m[0].name, "宿舍值日");
  ok("迁移后保留原成员", m[0].members.map((x) => x.name).join(","), "小北,老陈,阿青");
  ok("迁移后保留原周期", m[0].periodDays, 7);
  ok("迁移后保留原提醒时刻", m[0].remindTime, "07:30");
  ok("迁移后保留原提示音（桌面端选的）", m[0].sound, "chime");
  ok("迁移后保留换人记录", m[0].overrides["2026-09-14"], "m3");
  ok("迁移后保留已移除名单", m[0].removed.map((x) => x.name).join(","), "走的人");
  ok("迁移后保留提醒去重标记", m[0].lastNotified, "2026-09-14");
  ok("完全没有旧数据时不迁移（由调用方建默认组）",
    pluginRuntime.ddMigrateLegacy({ members: [], config: null, overrides: {}, removed: [], lastNotified: "" }, "2026-09-17").length, 0);
  ok("旧数据为 null 时不崩", pluginRuntime.ddMigrateLegacy(null, "2026-09-17").length, 0);
  ok("ddActiveId：存的 id 有效就用它",
    pluginRuntime.ddActiveId([{ id: "gA" }, { id: "gB" }], "gB"), "gB");
  ok("ddActiveId：失效 id 退回第一组（否则页面失去当前组）",
    pluginRuntime.ddActiveId([{ id: "gA" }, { id: "gB" }], "不存在"), "gA");
  ok("ddActiveId：没有组时返回空串", pluginRuntime.ddActiveId([], "gA"), "");
}

/* 4. 轮换数学：按轮次切段 */
{
  ok("周期 7 天：今天切段到本轮起始日", pluginRuntime.ddCycleStartOf(ddWeek, "2026-09-17"), "2026-09-14");
  ok("周期内每天都是同一个人（否则每周轮换会天天催）",
    ["2026-09-14", "2026-09-16", "2026-09-20"].map((d) => pluginRuntime.ddAssigneeFor(ddWeek, d).name), ["小北", "小北", "小北"]);
  ok("下一轮换到下一个人", pluginRuntime.ddAssigneeFor(ddWeek, "2026-09-21").name, "老陈");
  ok("第 3 轮回到第一个人", pluginRuntime.ddAssigneeFor(ddWeek, "2026-10-05").name, "小北");
  ok("起始日之前不排班",
    [pluginRuntime.ddCycleStartOf(ddWeek, "2026-09-13"), pluginRuntime.ddAssigneeFor(ddWeek, "2026-09-13")], [null, null]);
  ok("只在每轮第一天算「当天」",
    ["2026-09-14", "2026-09-15", "2026-09-21"].map((d) => pluginRuntime.ddIsCycleStartDay(ddWeek, d)), [true, false, true]);
  const per3 = DDG("2026-09-17", "值日", { periodDays: 3, members: ddM });
  ok("周期 3 天：切段按 3 天推进",
    ["2026-09-14", "2026-09-16", "2026-09-17"].map((d) => pluginRuntime.ddCycleStartOf(per3, d)), ["2026-09-14", "2026-09-14", "2026-09-17"]);
  ok("周期 3 天：第 3 天换人", pluginRuntime.ddAssigneeFor(per3, "2026-09-17").name, "老陈");
  ok("周期 1 天：每天换人",
    ["2026-09-14", "2026-09-15", "2026-09-16"].map((d) => pluginRuntime.ddAssigneeFor(DDG("2026-09-17", "值日", { periodDays: 1, members: ddM }), d).name),
    ["小北", "老陈", "阿青"]);
  ok("周期 14 天：两周内都是同一个人",
    pluginRuntime.ddAssigneeFor(DDG("2026-09-17", "值日", { periodDays: 14, members: ddM }), "2026-09-27").name, "小北");
  ok("没有成员时不指派", pluginRuntime.ddAssigneeFor(DDG("2026-09-17", "值日", { members: [] }), "2026-09-17"), null);
  ok("第 1 个人先当班", pluginRuntime.ddAssigneeFor(ddWeek, "2026-09-14").name, "小北");
  ok("轮次序号从 1 开始", pluginRuntime.ddCycleIndexAt(ddWeek, "2026-09-14") + 1, 1);
  ok("第 2 轮序号是 2", pluginRuntime.ddCycleIndexAt(ddWeek, "2026-09-21") + 1, 2);
}

/* 5. 临时换人：只影响那一轮 */
{
  const g = pluginRuntime.ddGroupSetOverride(ddWeek, "2026-09-14", "m3");
  ok("本轮已换给阿青", pluginRuntime.ddAssigneeFor(g, "2026-09-17").name, "阿青");
  ok("周期内每天沿用同一次换人", pluginRuntime.ddAssigneeFor(g, "2026-09-18").name, "阿青");
  ok("下一轮不受影响，回到原排班", pluginRuntime.ddAssigneeFor(g, "2026-09-24").name, "老陈");
  ok("真换人时 overrideHit 返回的是替补本人", pluginRuntime.ddOverrideHit(g, "2026-09-14").name, "阿青");
  ok("「原本该谁」是正常轮换的人（不是替补）", pluginRuntime.ddNormalFor(g, "2026-09-14").name, "小北");
  ok("撤销换人后回到原排班",
    pluginRuntime.ddAssigneeFor(pluginRuntime.ddGroupSetOverride(g, "2026-09-14", ""), "2026-09-17").name, "小北");
  ok("撤销换人要把键删掉，而不是留一个空串（否则存量数据越攒越多）",
    Object.keys(pluginRuntime.ddGroupSetOverride(g, "2026-09-14", "").overrides).length, 0);
  const gone = pluginRuntime.ddGroupRemoveMember(g, "m3");
  ok("换人对象被移除后退回原排班", pluginRuntime.ddAssigneeFor(gone, "2026-09-17").name, "小北");
  ok("指向已移除成员的换人不算换人（否则界面会显示「已换人 · 原 X」而实际当班的就是 X）",
    pluginRuntime.ddOverrideHit(gone, "2026-09-14"), null);
  ok("移除成员时顺手清掉指向他的换人（不留永远命中不了的 override）",
    Object.keys(gone.overrides).length, 0);
  // 存量脏数据：旧版本可能留下「override 指向已不在名单里的人」。
  // 这种换人**不算换人** —— 否则界面会显示「已换人 · 原 X」而实际当班的就是 X。
  const stale = DD({ startDate: "2026-09-14", periodDays: 7, members: [{ id: "m1", name: "小北" }], overrides: { "2026-09-14": "m9" } });
  ok("存量脏数据：override 指向不在名单的人 → 不算换人", pluginRuntime.ddOverrideHit(stale, "2026-09-14"), null);
  ok("存量脏数据：当班人退回正常排班", pluginRuntime.ddAssigneeFor(stale, "2026-09-17").name, "小北");
  ok("存量脏数据：快照也不显示「已换人」", pluginRuntime.ddSnapshot("2026-09-17", stale).swapped, false);
}

/* 6. 成员增删改序 */
{
  const g = DDG("2026-09-17", "值日", { members: ddM });
  ok("添加成员接在名单末尾（顺序即轮换顺序）",
    pluginRuntime.ddGroupAddMember(g, "  小新  ").members.map((m) => m.name).join(","), "小北,老陈,阿青,小新");
  ok("空名成员不添加（不留一个点不动的空条目）",
    pluginRuntime.ddGroupAddMember(g, "   ").members.length, 3);
  ok("改名去掉首尾空白",
    pluginRuntime.ddGroupRenameMember(g, "m2", "  老陈  ").members[1].name, "老陈");
  ok("改名成空则不动",
    pluginRuntime.ddGroupRenameMember(g, "m2", "  ").members[1].name, "老陈");
  ok("上移交换相邻两人",
    pluginRuntime.ddGroupMoveMember(g, "m2", -1).members.map((m) => m.name).join(","), "老陈,小北,阿青");
  ok("第一个人不能再上移",
    pluginRuntime.ddGroupMoveMember(g, "m1", -1).members.map((m) => m.name).join(","), "小北,老陈,阿青");
  ok("最后一个人不能再下移",
    pluginRuntime.ddGroupMoveMember(g, "m3", 1).members.map((m) => m.name).join(","), "小北,老陈,阿青");
  const rm = pluginRuntime.ddGroupRemoveMember(g, "m2");
  ok("移除成员后名单里没有他", rm.members.map((m) => m.name).join(","), "小北,阿青");
  ok("移除的成员进「已移除」可恢复", rm.removed.map((m) => m.name).join(","), "老陈");
  const back = pluginRuntime.ddGroupRestoreMember(rm, "m2");
  ok("恢复成员接回名单末尾（不会插队打乱已定好的顺序）",
    back.members.map((m) => m.name).join(","), "小北,阿青,老陈");
  ok("恢复后从「已移除」里移除", back.removed.length, 0);
  const many = { id: "g", members: [], removed: [], overrides: {} };
  let acc = many;
  for (let i = 0; i < pluginRuntime.DD_REMOVED_KEEP + 6; i++) {
    const added = pluginRuntime.ddGroupAddMember(acc, "人" + i);
    acc = pluginRuntime.ddGroupRemoveMember(added, added.members[added.members.length - 1].id);
  }
  ok("「已移除」列表截断，不会无限增长", acc.removed.length, pluginRuntime.DD_REMOVED_KEEP);
  ok("组归一化也要截断「已移除」（存量脏数据兜底）",
    DD({ removed: new Array(40).fill(0).map((_, i) => ({ id: "r" + i, name: "x" })) }).removed.length, pluginRuntime.DD_REMOVED_KEEP);
}

/* 7. 多套轮换：完全隔离（本次改造的核心） */
{
  const dorm = DDG("2026-09-17", "宿舍值日", { startDate: "2026-09-14", periodDays: 7, members: ddM });
  const pub = DDG("2026-09-17", "公区卫生", {
    startDate: "2026-09-18", periodDays: 1,
    members: [{ id: "p1", name: "甲" }, { id: "p2", name: "乙" }],
  });
  ok("两套轮换各有自己的成员", [dorm.members.length, pub.members.length], [3, 2]);
  ok("两套轮换各有自己的周期", [pluginRuntime.ddPeriod(dorm), pluginRuntime.ddPeriod(pub)], [7, 1]);
  ok("宿舍组：9/18 整周还是小北（7 天一段）", pluginRuntime.ddAssigneeFor(dorm, "2026-09-18").name, "小北");
  ok("公区组：9/18 起每天一轮，轮到甲", pluginRuntime.ddAssigneeFor(pub, "2026-09-18").name, "甲");
  ok("公区组：9/19 轮到乙", pluginRuntime.ddAssigneeFor(pub, "2026-09-19").name, "乙");
  ok("公区组换人不会带动宿舍组", pluginRuntime.ddAssigneeFor(dorm, "2026-09-19").name, "小北");
  ok("宿舍组起始日早于公区组（两套起始日独立）",
    [pluginRuntime.ddCycleStartOf(dorm, "2026-09-17"), pluginRuntime.ddCycleStartOf(pub, "2026-09-17")], ["2026-09-14", null]);
  ok("公区组未开始时不算出当班人（各自独立判断）", pluginRuntime.ddAssigneeFor(pub, "2026-09-17"), null);

  // A 组换人 → B 组排班不受影响
  const dorm2 = pluginRuntime.ddGroupSetOverride(dorm, "2026-09-14", "m2");
  ok("A 组换人后 A 组当班变了", pluginRuntime.ddAssigneeFor(dorm2, "2026-09-18").name, "老陈");
  ok("A 组换人不改 B 组排班", pluginRuntime.ddAssigneeFor(pub, "2026-09-18").name, "甲");

  // 两组同名成员 id 也不能串台（各自一份名单）
  const dorm3 = pluginRuntime.ddGroupAddMember(dorm, "只有宿舍有");
  ok("A 组加成员不影响 B 组", [dorm3.members.length, pub.members.length], [4, 2]);

  // 各自独立的提醒去重
  const gA = pluginRuntime.ddGroupPatch(dorm, { lastNotified: "2026-09-14" });
  const gB = pluginRuntime.ddGroupPatch(pub, { lastNotified: "" });
  ok("A 组已提醒过 → 不再提醒", pluginRuntime.ddReminderDue(gA, "2026-09-14", 600), null);
  ok("B 组自己的去重标记独立（A 提醒过不影响 B）",
    pluginRuntime.ddReminderDue(gB, "2026-09-18", 600).whoName, "甲");
}

/* 8. 组的增删改（纯函数：一组进、一组出） */
{
  const g1 = DD({ id: "g1", name: "宿舍值日", members: ddM });
  const created = pluginRuntime.ddAddGroup([g1], "2026-09-17", "公区卫生");
  ok("新建一套轮换", !!created, true);
  ok("新组不能继承上一组的成员", created.members.length, 0);
  ok("两套轮换的 id 必须不同", created.id === g1.id, false);
  ok("新建时给的名字生效", created.name, "公区卫生");
  ok("新建未给名字时用默认名", pluginRuntime.ddAddGroup([g1], "2026-09-17", null).name, "值日");
  const full = [];
  for (let i = 0; i < pluginRuntime.DD_GROUP_MAX; i++) full.push(DD({ id: "g" + i }));
  ok("到上限时新建返回 null（让调用方去提示，而不是假装建成功）",
    pluginRuntime.ddAddGroup(full, "2026-09-17", "多余的"), null);

  const two = [g1, created];
  const rmCreated = pluginRuntime.ddRemoveGroup(two, created.id, created.id);
  ok("删掉当前组后落到还活着的组", [rmCreated.ok, rmCreated.groups.length, rmCreated.activeId], [true, 1, "g1"]);
  const rmOther = pluginRuntime.ddRemoveGroup(two, created.id, "g1");
  ok("删掉非当前组时当前组不变", [rmOther.ok, rmOther.activeId], [true, "g1"]);
  ok("删不存在的组必须失败",
    pluginRuntime.ddRemoveGroup(two, "不存在", "g1").ok, false);
  ok("最后一套不许删（删光界面就没有可编辑的对象了）",
    pluginRuntime.ddRemoveGroup([g1], "g1", "g1").ok, false);
  ok("只有一套时删除失败且列表不变",
    pluginRuntime.ddRemoveGroup([g1], "g1", "g1").groups.length, 1);
  const three = [g1, created, pluginRuntime.ddAddGroup(two, "2026-09-17", "打水")];
  const rmMid = pluginRuntime.ddRemoveGroup(three, "g1", "g1");
  ok("删当前那套后落到同一位置的邻居", [rmMid.groups.length, rmMid.activeId], [2, rmMid.groups[0].id]);

  ok("patch 只改指定字段，其余保持",
    JSON.stringify(pluginRuntime.ddGroupPatch(g1, { name: "新名" }).members) === JSON.stringify(g1.members), true);
  const patched = pluginRuntime.ddWithGroup([g1, created], "g1", (g) => pluginRuntime.ddGroupPatch(g, { name: "改名了" }));
  ok("ddWithGroup 只替换目标组", [patched[0].name, patched[1].name], ["改名了", "公区卫生"]);
}

/* 9. 提醒：只在每轮第一天 + 到点 + 当天只一次 */
{
  const g = pluginRuntime.ddGroupPatch(ddWeek, { remindTime: "08:00", lastNotified: "" });
  ok("周期内非首日不提醒（否则天天催）", pluginRuntime.ddReminderDue(g, "2026-09-16", 600), null);
  ok("首日但还没到点不提醒", pluginRuntime.ddReminderDue(g, "2026-09-14", 400), null);
  const due = pluginRuntime.ddReminderDue(g, "2026-09-14", 600);
  ok("首日到点提醒当班的人", [due.whoName, due.time, due.groupName], ["小北", "08:00", "宿舍值日"]);
  ok("提醒里带上组 id（多组时页面要按组标记去重）", due.groupId, g.id);
  ok("当天已提醒过不再提醒",
    pluginRuntime.ddReminderDue(pluginRuntime.ddMarkNotified([g], [g.id], "2026-09-14")[0], "2026-09-14", 600), null);
  ok("提醒被关掉时不提醒", pluginRuntime.ddReminderDue(pluginRuntime.ddGroupPatch(g, { remindEnabled: false }), "2026-09-14", 600), null);
  ok("没有成员时不提醒", pluginRuntime.ddReminderDue(pluginRuntime.ddGroupPatch(g, { members: [] }), "2026-09-14", 600), null);
  ok("未开始时（起始日前）不提醒", pluginRuntime.ddReminderDue(g, "2026-09-13", 600), null);

  // 坏时刻不能让提醒静默失效（存量数据里存着 25:99 时仍须照常提醒）
  const badTime = pluginRuntime.ddGroupPatch(g, { remindTime: "25:99" });
  ok("存量坏时刻被归一化（25:99 → 08:00），提醒不会静默失效",
    pluginRuntime.ddReminderDue(badTime, "2026-09-14", 600).whoName, "小北");

  // 多组同时到点：各自独立
  const g2 = DDG("2026-09-17", "公区卫生", { startDate: "2026-09-14", periodDays: 1, members: [{ id: "p1", name: "甲" }] });
  const dueAll = pluginRuntime.ddDueReminders([g, g2], "2026-09-14", 600);
  ok("多组同时到点时每套各自提醒一次", dueAll.map((r) => r.groupName).join(","), "宿舍值日,公区卫生");
  const marked = pluginRuntime.ddMarkNotified([g, g2], [g.id], "2026-09-14");
  ok("只标记被提醒过的那组（另一组下次仍会提醒）",
    [marked[0].lastNotified, marked[1].lastNotified], ["2026-09-14", ""]);
  ok("标记后只剩另一组到点",
    pluginRuntime.ddDueReminders(marked, "2026-09-14", 600).map((r) => r.groupName).join(","), "公区卫生");
  ok("标记已提醒后 A 组不再到点",
    pluginRuntime.ddReminderDue(marked[0], "2026-09-14", 600), null);
}

/* 10. 视图模型：当前组快照 + 顶部标签条 */
{
  const dorm = DDG("2026-09-17", "宿舍值日", { startDate: "2026-09-14", periodDays: 7, members: ddM });
  const pub = DDG("2026-09-17", "公区卫生", {
    startDate: "2026-09-14", periodDays: 1,
    members: [{ id: "p1", name: "甲" }, { id: "p2", name: "乙" }],
  });
  const s = pluginRuntime.ddSummaryFrom([dorm, pub], pub.id, "2026-09-17");
  ok("快照跟着当前组走", s.groupName, "公区卫生");
  ok("当前组周期标签", s.periodLabel, "每天");
  ok("标签条列出全部轮换", s.groups.map((x) => x.name).join(","), "宿舍值日,公区卫生");
  ok("标签条标出当前组", s.groups.map((x) => x.on).join(","), "false,true");
  ok("标签条给出每组各自的当班人（一眼看出谁在轮）",
    s.groups.map((x) => x.who).join(","), "小北,乙");
  ok("组数", s.groupCount, 2);
  ok("可以继续新建", s.canAddGroup, true);
  ok("多于一套时可以删", s.canDelGroup, true);
  ok("只有一套时不许删",
    pluginRuntime.ddSummaryFrom([dorm], dorm.id, "2026-09-17").canDelGroup, false);
  ok("activeId 无效时退回第一组",
    pluginRuntime.ddSummaryFrom([dorm, pub], "不存在", "2026-09-17").groupName, "宿舍值日");
  ok("没有组时快照不崩（返回空态）",
    pluginRuntime.ddSummaryFrom([], "", "2026-09-17").groupCount, 0);

  // 空态 / 未开始 / 有成员 三种状态
  const empty = pluginRuntime.ddSnapshot("2026-09-17", DDG("2026-09-17", "值日", { members: [] }));
  ok("空态标记", [empty.empty, empty.hasMembers, empty.started], [true, false, true]);
  ok("空态不给当班人", empty.current, null);
  ok("空态后续轮次给出占位名", empty.rows[0].whoName, "—");
  const notStarted = pluginRuntime.ddSnapshot("2026-09-10", DDG("2026-09-17", "值日", { startDate: "2026-09-14", members: ddM }));
  ok("未开始标记", notStarted.started, false);
  ok("未开始时不指派当班人", notStarted.current, null);
  ok("未开始时说的是「开始」而不是「换人」", notStarted.nextVerb, "开始");
  ok("未开始时下次是起始日", notStarted.nextStart, "2026-09-14");
  ok("未开始时不给轮次序号", notStarted.cycleIndex, 0);

  const live = pluginRuntime.ddSnapshot("2026-09-17", ddWeek);
  ok("后续轮次展示 6 条", live.rows.length, 6);
  ok("后续轮次按顺序循环",
    live.rows.map((r) => r.whoName).join(","), "老陈,阿青,小北,老陈,阿青,小北");
  ok("每行倒计时按天算",
    live.rows.map((r) => r.daysUntil).join(","), "4,11,18,25,32,39");
  ok("成员行给出序号与是否当班",
    live.members.map((m) => m.no + (m.isCurrent ? "*" : "")).join(","), "1*,2,3");
  ok("首尾成员的上下移按钮禁用",
    [live.members[0].canUp, live.members[0].canDown, live.members[2].canUp, live.members[2].canDown], [false, true, true, false]);
  ok("周期选项里标出当前档", live.periods.filter((p) => p.on).map((p) => p.label).join(","), "每周");
  ok("周期选项覆盖 1/3/7/14", live.periods.map((p) => p.days).join(","), "1,3,7,14");
  ok("快照里带上桌面端的提示音字段（小程序不展示但要原样带回 storage）", live.cfg.sound, "beep");
  // 周几要标出来但别重复（桌面端曾写成「9月18日（周五）· 周五」，靠眼睛才发现）
  ok("多日轮次的日期文案带周几、且只出现一次",
    /^\d+月\d+日 → \d+月\d+日 · 周[一二三四五六日]起$/.test(live.rows[0].range), true);
  ok("多日轮次的日期里「周X」只出现一次", (live.rows[0].range.match(/周/g) || []).length, 1);
  const dailyRow = pluginRuntime.ddSnapshot("2026-09-20",
    DDG("2026-09-20", "值日", { startDate: "2026-09-20", periodDays: 1, members: ddM })).rows[0];
  ok("单日轮次的日期文案是「M月D日（周X）」",
    /^\d+月\d+日（周[一二三四五六日]）$/.test(dailyRow.range), true);
  ok("单日轮次的日期里「周X」只出现一次", (dailyRow.range.match(/周/g) || []).length, 1);
}

/* 11. 页面入口 dormDutySummary：读 store + 迁移 / 兜底建组必须立刻落盘
   ⚠️ 这条守的是最容易漏的坑：迁移结果不写回 storage 的话，「已迁移」与「未迁移」在存储上
   分不出来 —— 每次进页面都会重新建一个**随机 id** 的默认组，用户刚设好的东西下次就没了。
   判据用「两次调用拿到的组 id 是否一致」，而不是「有没有 groups 键」。 */
{
  store.replaceAll({ version: 1, tasks: [], blocks: [], settings: {}, plugins: {} });
  ok("空 store 时先建一套默认轮换", pluginRuntime.dormDutySummary("2026-09-17").groupCount, 1);
  const firstId = store.pluginStorageGet("dorm-duty", "groups", null)[0].id;
  ok("兜底建组必须立刻落盘", !!firstId, true);
  ok("再进一次页面拿到的是同一套（没有重建随机 id 的组）",
    pluginRuntime.dormDutySummary("2026-09-17").groups[0].id, firstId);

  // 旧版单套数据 → 迁移成一套，且立刻落盘
  store.replaceAll({ version: 1, tasks: [], blocks: [], settings: {}, plugins: {} });
  store.pluginStorageSet("dorm-duty", "members", ddM);
  store.pluginStorageSet("dorm-duty", "config", { dutyName: "宿舍值日", startDate: "2026-09-14", periodDays: 7, remindTime: "07:30", sound: "chime" });
  store.pluginStorageSet("dorm-duty", "overrides", { "2026-09-14": "m3" });
  store.pluginStorageSet("dorm-duty", "lastNotified", "2026-09-14");
  const migrated = pluginRuntime.dormDutySummary("2026-09-17");
  ok("旧数据自动迁移成一套轮换", [migrated.groupCount, migrated.groupName], [1, "宿舍值日"]);
  ok("迁移后成员还在", migrated.members.map((m) => m.name).join(","), "小北,老陈,阿青");
  ok("迁移后换人还在（本轮是阿青）", migrated.current.name, "阿青");
  ok("迁移后提醒时刻还在", migrated.cfg.remindTime, "07:30");
  ok("迁移后桌面端的提示音还在", migrated.cfg.sound, "chime");
  ok("迁移结果必须立刻落盘", !!store.pluginStorageGet("dorm-duty", "groups", null), true);
  const migratedId = store.pluginStorageGet("dorm-duty", "groups", null)[0].id;
  ok("再进一次页面不会重新迁移（组 id 稳定）",
    pluginRuntime.dormDutySummary("2026-09-17").groups[0].id, migratedId);

  // 新版 groups 已存在时，不能再被旧键盖回去
  store.replaceAll({ version: 1, tasks: [], blocks: [], settings: {}, plugins: {} });
  store.pluginStorageSet("dorm-duty", "groups", [
    DD({ id: "gA", name: "宿舍值日", members: ddM }),
    DD({ id: "gB", name: "公区卫生", members: [{ id: "p1", name: "甲" }] }),
  ]);
  store.pluginStorageSet("dorm-duty", "activeId", "gB");
  store.pluginStorageSet("dorm-duty", "members", [{ id: "旧", name: "旧数据" }]);
  const both = pluginRuntime.dormDutySummary("2026-09-17");
  ok("新版数据存在时不看旧键（否则旧快照会盖回来）", both.groupCount, 2);
  ok("存的 activeId 生效（下次打开还停在那一套）", both.groupName, "公区卫生");
  ok("标签条给出两组各自当班人", both.groups.map((g) => g.who).join(","), "小北,甲");
  store.pluginStorageSet("dorm-duty", "activeId", "不存在");
  ok("activeId 失效时退回第一套", pluginRuntime.dormDutySummary("2026-09-17").groupName, "宿舍值日");
  ok("失效的 activeId 会被修正后落盘（不留一个永远无效的指针）",
    store.pluginStorageGet("dorm-duty", "activeId", ""), store.pluginStorageGet("dorm-duty", "groups", [])[0].id);
}
/* ── 学习通适配纯逻辑（chaoxingCore） ── */
console.log("[chaoxing]");
const cxCore = require("../miniprogram/core/chaoxingCore.js");
const pluginNet = require("../miniprogram/core/pluginNet.js");

/* DES 向量：与本机 Python pyDes（ECB + PKCS5，key "u2oh6Vu^"）实测对照 */
ok("DES 加密 123456", cxCore.desEncryptHex("123456", "u2oh6Vu^"), "218b246a6f42ee81");
ok("DES 加密 Passw0rd!", cxCore.desEncryptHex("Passw0rd!", "u2oh6Vu^"), "d61c001d2e492b5b946fca742802e4d2");
ok("DES 加密中文（多字节 UTF-8）", cxCore.desEncryptHex("你好学习通", "u2oh6Vu^"), "2bf01b815965bd893690d8083f0f72b7");
ok("DES 加密单字符（PKCS5 填充到 8 字节）", cxCore.desEncryptHex("a", "u2oh6Vu^"), "9524e6bb60f41487");
ok("登录请求体包含加密密码与编码账号",
  cxCore.LOGIN_BODY("13800000000", "abcd"), "fid=-1&uname=13800000000&password=abcd&refer=https%3A%2F%2Fi.chaoxing.com&t=true&forbidotherlogin=0&validate=");

ok("Cookie 合并保留新值并去重",
  cxCore.mergeCookies("UID=1; FUID=2", ["UID=9; Path=/", "VC3=abc; HttpOnly"]),
  "UID=9; FUID=2; VC3=abc");
ok("Set-Cookie 提取兼容大小写与数组",
  pluginNet.setCookiesOf({ "set-cookie": ["A=1; Path=/", "B=2"], "Content-Type": "text/html" }),
  ["A=1; Path=/", "B=2"]);

const n1 = cxCore.normalizeNotice({ idCode: "a".repeat(32), title: "第<b>3</b>章 作业提交", rtf_content: "<p>请在 2026-09-10 23:59 前完成。结束时间：2026-09-10 23:59</p>", createrName: "王老师", insertTime: Math.floor(new Date(2025, 8, 6, 7, 20).getTime() / 1000), isread: 0, tag: "courseId(123)" });
ok("normalizeNotice 去 HTML 并识别截止时间",
  [n1.title, cxCore.deadline(n1.body), cxCore.classify(n1), n1.unread],
  ["第3章 作业提交", "2026-09-10 23:59", "作业", true]);
ok("normalizeNotice 时间戳转文本（秒，按本地时区）", n1.time, "2025-09-06 07:20");
ok("isread=1 视为已读", cxCore.normalizeNotice({ id: "x", isread: 1 }).unread, false);

const overrides = new Map([["a".repeat(32), false]]);
const opts = { ignoredIds: new Set(), readOverrides: overrides, filter: { kw: "", category: "全部", onlyUnread: false } };
ok("本机已读标记覆盖平台未读状态", cxCore.effUnread(n1, overrides), false);
ok("关键词过滤命中正文", cxCore.filteredInbox([n1], { ignoredIds: new Set(), readOverrides: new Map(), filter: { kw: "作业", category: "全部", onlyUnread: false } }).length, 1);
ok("分类过滤排除通知", cxCore.filteredInbox([n1], { ignoredIds: new Set(), readOverrides: new Map(), filter: { kw: "", category: "通知", onlyUnread: false } }).length, 0);
ok("已过期截止不进待办", cxCore.todos([n1], { ignoredIds: new Set(), readOverrides: new Map(), filter: { kw: "", category: "全部", onlyUnread: false } }).length, 0);
const futureN = cxCore.normalizeNotice({ idCode: "b".repeat(32), title: "期末作业", rtf_content: "结束时间：" + (new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)) + " 23:59" });
ok("未过期截止进待办且带 dueText", cxCore.todos([futureN], opts).map((x) => !!x.dueText), [true]);
ok("忽略名单把通知挡在列表外",
  cxCore.filteredInbox([n1], { ignoredIds: new Set([n1.id]), readOverrides: new Map(), filter: { kw: "", category: "全部", onlyUnread: false } }).length, 0);

/* 作业附件 iframe：Base64(URL 编码 JSON)，探测「正在批改」用 */
const workPayload = Buffer.from(encodeURIComponent(JSON.stringify({ att_web: { url: "https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=77", examOrWorkId: 77 } })), "utf8").toString("base64");
const workN = cxCore.normalizeNotice({ idCode: "c".repeat(32), title: "作业", rtf_content: '<iframe name="' + workPayload + '"></iframe>' });
const ref = cxCore.parseWorkRef(workN);
ok("作业附件解析出 workId 与入口 URL", [ref && ref.id, /doHomeWorkNew/.test(ref && ref.url)], ["77", true]);
ok("作业链接打分高于普通站内链接", cxCore.linkScore("https://mooc1.chaoxing.com/work/doHomeWorkNew?workId=77") > cxCore.linkScore("https://i.chaoxing.com/"), true);
ok("分享页属匿名可开链接", cxCore.isAnonymousUrl("https://sharewh3.xuexi365.com/share/xxx"), true);

const courses = cxCore.parseCoursesHtml('<li class="course ">' +
  '<input class="courseId" name="courseId" value="555"/>' +
  '<input class="clazzId" name="clazzId" value="666"/>' +
  '<a class="course-name" title="生物化学"></a>' +
  '<a class="line2 color3" title="李老师"></a>班级：25防火<br/>开课时间：2025-09-01～2027-09-01</li>');
const now = new Date(2026, 8, 16);
ok("课程 HTML 解析字段齐全", [courses[0].name, courses[0].teacher, courses[0].clazz, courses[0].start], ["生物化学", "李老师", "25防火", "2025-09-01"]);
ok("开课月份≥7 → 秋季学期", cxCore.termOf("2025-09-01"), { year: 2025, half: "上", rank: 4050, label: "2025-2026 学年上学期" });
ok("秋季学期已过 → 已完成", cxCore.courseStatus(courses[0], now), "green");
ok("班级名投票出入学学年", cxCore.detectEnrollYear(courses), 2025);
ok("年级按入学学年推算", cxCore.gradeOf(2025, 2025), "大一");
const cg = cxCore.courseGroups(courses, now, "");
ok("课程分组视图模型带学年 tab", cg.years, [2025]);
ok("分组视图模型含入学学年推断", cg.enrollYear, 2025);

/* 拼音首字母缩写搜索（v2.12.0，与桌面端同一套规则）：
   数据表由 tools/gen-chaoxing-pinyin.js 生成（pinyin-pro 多音字全读音），标记区勿手改。 */
ok("缩写搜索 北京 → bj 命中", cxCore.cxKwHit("北京理工大学期末通知", "bj"), true);
ok("缩写搜索逐字首字母", cxCore.cxInitials("大学英语四级"), "dxyysj");
ok("多音字按次常用读音命中（重 chong）", cxCore.cxKwHit("重庆", "cq"), true);
ok("多音字在任何位置都能按次读音命中", cxCore.cxKwHit("郑重声明", "zc"), true);
ok("零声母字（安 an）进首字母流", cxCore.cxInitials("安晓伟").charAt(0), "a");
ok("数字与字母原样保留可混拼", cxCore.cxInitials("25防火2队1班"), "25fh2d1b");
ok("含中文的关键词退回原文 includes", cxCore.cxKwHit("大学英语四级", "英语"), true);
ok("不相关缩写不误报", cxCore.cxKwHit("大学英语四级", "bj"), false);
ok("收件箱过滤吃到缩写搜索",
  cxCore.filteredInbox([n1], { ignoredIds: new Set(), readOverrides: new Map(), filter: { kw: "zy", category: "全部", onlyUnread: false } }).length, 1,
  );
ok("课程分组过滤吃到缩写搜索", cxCore.courseGroups(courses, now, "swhx").yearMap.get(2025).length, 1);
ok("缩写不命中时课程分组为空", cxCore.courseGroups(courses, now, "bj").yearMap.size, 0);

/* ── 汇总 ── */
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
