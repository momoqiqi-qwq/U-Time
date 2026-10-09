/* AI 对话插件守卫（public/plugins/ai-chat）。
 *
 * 这个插件的风险不在「界面画得对不对」，而在三件事：
 *   ① 它会把用户本机的任务与时间块**发给外部模型** —— 所以「带本机数据」必须是一个
 *      看得见、可关掉、关掉后真的不发数据的开关；
 *   ② 它会把模型返回的东西**写进本机数据** —— 所以每条建议必须过白名单校验，
 *      且写库前由用户逐条勾选，写完还能撤销；
 *   ③ 模型会编造 —— 所以快照里必须带真实 id，校验必须拿快照里的 id 去比对，
 *      对不上的那条要当场标成不可写，而不是等用户点了才发现写坏。
 * 静态接线 + 真跑一遍解析/落库/撤销，缺一条都会红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const mainSrc = read("../public/plugins/ai-chat/main.js");
const manifest = JSON.parse(read("../public/plugins/ai-chat/manifest.json"));
const host = read("../src/pluginHost.js");
const api = read("../src/api.js");
const rust = read("../src-tauri/src/lib.rs");
const catalog = read("../src/pluginCatalog.js");
const miniCatalog = read("../../miniprogram/core/pluginCatalog.js");
const doc = read("../public/plugins/plugin-guide/plugin-development.md");

/* ───────── 一、宿主侧：tide.ai 是新开的口子，权限闸门必须一起到位 ───────── */

assert.match(host, /ai: "AI 对话（/, "PLUGIN_PERMISSION_LABELS 必须有 ai 条目，否则报错文案只剩英文 ai");
assert.match(host, /ai: \{[\s\S]{0,900}requirePermission\(man, pid, "ai"\)[\s\S]{0,400}requirePermission\(man, pid, "ai"\)/,
  "tide.ai 的 chat 与 status 两个方法都必须过权限闸门，漏一个就是未声明也能调");
assert.match(host, /return api\.aiChat\(messages, opts\.temperature[,)]/, "chat 必须复用 api.aiChat（凭据只在 Rust 侧）");
assert.match(host, /return api\.aiVaultStatus\(\)/, "status 必须复用 api.aiVaultStatus，插件才有「配没配」可判");
assert.match(api, /async aiChat\(messages, temperature = 0\.2[,)]/, "api.aiChat 的默认温度不能悄悄改掉");
assert.match(host, /非流式/, "宿主注释必须写明上游非流式，否则下一个写插件的人会以为能拿增量");

/* 跨插件消息：宿主在 emit 处抄收，读口单独一道权限 */
assert.match(host, /messages: "读取其他插件推来的消息"/, "PLUGIN_PERMISSION_LABELS 必须有 messages 条目");
assert.match(host, /messages: \{[\s\S]{0,200}requirePermission\(man, pid, "messages"\)/,
  "tide.messages.list 必须过权限闸门，未声明就读不到别的插件推了什么");
assert.match(host, /if \(name === "notice:new"\) collectNotice\(data, pid\)/,
  "抄收必须挂在 events.emit 上：这样与谁在监听、谁先加载都无关");
assert.match(host, /publish: \(items\) => \{ requirePermission\(man, pid, "events"\); publishPluginMessages\(pid, man\.name, items\); \}/,
  "发布当前列表摘要必须过 events 权限，并由宿主绑定真实来源");
assert.match(doc, /tide\.messages\.publish\(/, "插件开发文档必须说明现有列表如何发布");
for (const id of ["school-notice", "chaoxing-notify", "cppu-notify", "gx-news", "rss-reader", "github-readme"]) {
  assert.match(read(`../public/plugins/${id}/main.js`), /tide\.messages\?\.publish\(/, `${id} 必须公开现有消息摘要`);
  assert.ok(JSON.parse(read(`../public/plugins/${id}/manifest.json`)).permissions.includes("events"), `${id} 发布摘要需要 events 权限`);
}
assert.match(host, /只存内存/, "宿主注释要写清这份队列只在运行期，避免有人以为它能跨重启");
assert.match(doc, /tide\.messages\.list\(/, "插件开发文档必须写清怎么读其他插件的消息");
assert.match(doc, /source\|time\|title/, "文档要写明去重键，插件侧才知道重复推送会合并");

/* ───────── 二、清单与三端产物 ───────── */

assert.equal(manifest.id, "ai-chat", "manifest.id 必须与目录名一致");
for (const need of ["ai", "ui", "storage", "tasks", "blocks", "messages"]) {
  assert.ok(manifest.permissions.includes(need), `manifest.permissions 缺 ${need}`);
}
assert.equal(manifest.platforms.windows, "full");
assert.equal(manifest.platforms.android, "full");
assert.equal(manifest.platforms.miniprogram, "unavailable",
  "小程序没有 AI 配置面与 tide.ai，声明成 unavailable 而不是硬凑一个假页");
assert.ok(catalog.includes('"ai-chat"') || catalog.includes("'ai-chat'"), "桌面 pluginCatalog.js 未收录（跑 node tools/sync-plugins.js）");
assert.ok(miniCatalog.includes('"ai-chat"') || miniCatalog.includes("'ai-chat'"), "小程序 pluginCatalog.js 未收录");

const orders = fs.readdirSync(new URL("../public/plugins/", import.meta.url))
  .filter((d) => fs.existsSync(new URL(`../public/plugins/${d}/manifest.json`, import.meta.url)))
  .map((d) => JSON.parse(read(`../public/plugins/${d}/manifest.json`)).order)
  .filter((o) => o != null);
assert.equal(new Set(orders).size, orders.length, "内置插件的 order 必须互不相同，否则侧栏顺序随文件系统变化");

/* 图标三端同源（单一事实源在小程序目录，桌面是生成副本） */
const miniIcon = new URL("../../miniprogram/images/plugins/ai-chat.png", import.meta.url);
const deskIcon = new URL("../public/icons/plugins/ai-chat.png", import.meta.url);
assert.ok(fs.existsSync(miniIcon), "缺少插件图标事实源 miniprogram/images/plugins/ai-chat.png（tools/gen-plugin-icons.py 生成）");
assert.ok(fs.existsSync(deskIcon), "缺少桌面插件图标 public/icons/plugins/ai-chat.png");
assert.deepEqual(Array.from(fs.readFileSync(deskIcon).subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "桌面图标不是合法 PNG");
assert.ok(fs.readFileSync(deskIcon).equals(fs.readFileSync(miniIcon)), "桌面与小程序图标必须字节一致");

/* ───────── 三、对外文档与页面纪律 ───────── */

assert.match(doc, /tide\.ai\.chat\(/, "插件开发文档必须写清 tide.ai.chat 怎么用");
assert.match(doc, /24 条消息/, "文档必须写明一次 24 条消息的上限（Rust 侧硬限制）");
assert.match(doc, /60000 字符/, "文档必须写明 60000 字符总量上限");
assert.match(doc, /非流式/, "文档必须写明非流式，插件要自己画等待态");

// 吸底输入框靠 .plugview 的满高 flex 列实现：不建浮层、不往宿主容器外挂节点、不按视口尺寸定位。
// 这三条正是 test-plugin-safe-area 的判定条件（它按字面量扫，注释里出现同样会中招），
// 所以在这里把它们钉成断言，而不是等那个测试报一句看不懂的"有浮层却没提宿主变量"。
for (const banned of ["position:fixed", "document.body.append", "innerWidth", "innerHeight"]) {
  assert.ok(!mainSrc.includes(banned), `插件源码里不该出现 ${banned}（安全区由宿主 .view 负责）`);
}
assert.match(mainSrc, /!e\.isComposing/, "回车发送必须避开中文输入法的选词回车");
assert.match(mainSrc, /带本机数据/, "「带本机数据」开关要在界面上看得见 —— 这是数据外发的唯一闸口");
assert.match(mainSrc, /\[data-theme-mode="dark"\] \.aichat-msg\.me/, "深色模式的用户气泡须单独压低亮度");

/* ───────── 四、真跑：解析、校验、落库、撤销 ───────── */

const TODAY = "2026-09-23";
const addDays = (ds, n) => {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};

const storage = new Map();
const toasts = [];
const calls = { created: [], updated: [], removedTasks: [], removedBlocks: [], smart: [], chat: [] };
let tasks = [
  { id: "t_1", title: "交报告", done: false, due: "2026-09-20", dueTime: "18:00", quad: 1, estMin: 30, note: "" },
  { id: "t_2", title: "取快递", done: false, due: TODAY, dueTime: "23:59", quad: 4, estMin: 10, note: "" },
  { id: "t_3", title: "写周报", done: true, due: null, dueTime: "23:59", quad: 2, estMin: 20, note: "" },
];

const sandbox = {
  console,
  Date,
  JSON,
  Math,
  Number,
  Object,
  Array,
  String,
  RegExp,
  Set,
  encodeURIComponent,
  setTimeout,
  document: {
    getElementById: () => null,
    head: { append() {} },
    createElement: () => ({
      className: "", innerHTML: "", textContent: "", style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, append() {}, addEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
    }),
  },
  window: { dispatchEvent() {} },
  CustomEvent: class { constructor(name, opts) { this.name = name; Object.assign(this, opts); } },
  tide: {
    storage: {
      async get(key, fallback = null) { return storage.has(key) ? storage.get(key) : fallback; },
      async set(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
    },
    notify: (msg, opts) => toasts.push({ msg, opts }),
    ui: { registerView() {} },
    util: { today: () => TODAY, addDays, guessQuad: () => 2, guessCategory: () => "work" },
    tasks: {
      list: () => JSON.parse(JSON.stringify(tasks)),
      create: (patch) => { const t = { id: `t_${calls.created.length + 9}`, ...patch }; calls.created.push(t); return t; },
      update: (id, patch) => { const t = tasks.find((x) => x.id === id); Object.assign(t, patch); return t; },
      remove: (id) => { calls.removedTasks.push(id); },
    },
    blocks: {
      list: (date) => (date === TODAY
        ? [{ id: "b_1", date, start: "10:00", durMin: 90, title: "高数", cat: "study", taskId: null }]
        : []),
      createSmart: (patch) => {
        calls.smart.push(patch);
        const moved = patch.start === "10:00";
        return { block: { id: `b_${calls.smart.length + 5}`, ...patch, start: moved ? "11:30" : patch.start }, moved };
      },
      remove: (id) => { calls.removedBlocks.push(id); },
    },
    ai: {
      status: async () => ({ configured: true, model: "gpt-4o-mini", baseUrl: "", keyMasked: "" }),
      chat: async (messages, opts) => { calls.chat.push({ messages, opts }); return sandbox.__reply || "好的"; },
    },
    messages: { list: (limit = 30) => (sandbox.__feed || []).slice(-limit).reverse() },
  },
};
const ctx = vm.createContext(sandbox);
vm.runInContext(
  mainSrc.replace(
    "  tide.ui.registerView({",
    "  globalThis.__fx = {\n"
    + "    parseReply, normalizeSuggestion, snapshot, systemPrompt, buildMessages, describe,\n"
    + "    applySuggestions, undoRecord, taskPatch, md, ask, CHIPS, CHIPS_BLANK, activeChips,\n"
    + "    taskTitleOf, SEND_TURNS, KEEP, ACTIONS,\n"
    + "    get thread() { return thread; }, set thread(v) { thread = v; },\n"
    + "    get notices() { return notices; }, set notices(v) { notices = v; },\n"
    + "    syncNotices, noticeBlock,\n"
    + "    loadOnce, saveThread, startSession,\n"
    + "    get sessions() { return sessions; }, get sessionId() { return sessionId; },\n"
    + "    get draft() { return draft; }, set draft(v) { draft = v; },\n"
    + "    set loaded(v) { loaded = v; },\n"
    + "    get withContext() { return withContext; }, set withContext(v) { withContext = v; },\n"
    + "    THINK_LEVELS, cycleThink, paintThink,\n"
    + "    get thinkEffort() { return thinkEffort; }, set thinkEffort(v) { thinkEffort = v; },\n"
    + "  };\n"
    + "  tide.ui.registerView({",
  ),
  ctx,
);
const fx = ctx.__fx;
assert.ok(fx && typeof fx.parseReply === "function", "插件源码没暴露内部函数 —— 注入点被改动了？");

/* 1. 回复解析：建议块只取最后一个能解析的，正文里不留代码块残渣 */
{
  const r = fx.parseReply('先说结论。\n```json\n{"suggestions":[{"action":"create-task","title":"A"}]}\n```');
  assert.equal(r.body, "先说结论。", "正文必须切掉建议块");
  assert.equal(r.suggestions.length, 1);
  assert.equal(fx.parseReply("只有散文，没有代码块").suggestions.length, 0, "没给建议块要正常返回空");
  assert.equal(fx.parseReply('{"suggestions": 不是 JSON}').suggestions.length, 0, "坏 JSON 不能抛异常");
  const two = fx.parseReply('a\n```json\n{"suggestions":[{"action":"nope"}]}\n```\nb\n```json\n{"suggestions":[{"action":"done-task","id":"t_2"}]}\n```');
  assert.equal(two.suggestions.length, 1, "多个代码块只认最后一个");
  assert.equal(two.suggestions[0].action, "done-task");
  assert.equal(two.body, 'a\n```json\n{"suggestions":[{"action":"nope"}]}\n```\nb',
    "只切掉能解析的那块及其之后的内容，前面解析不了的原样留着给用户看");
}

/* 2. 白名单校验：模型编出来的东西一律拦下 */
{
  assert.equal(fx.normalizeSuggestion({ action: "delete-task", title: "x" }), null, "action 不在白名单里直接丢");
  assert.equal(fx.normalizeSuggestion("不是对象"), null);
  assert.match(fx.normalizeSuggestion({ action: "create-task" }).reason, /缺任务标题/);
  assert.match(fx.normalizeSuggestion({ action: "create-block", title: "只有标题" }).reason, /缺日期、开始时间或标题/,
    "时间块缺了日期或开始时间就落不了地，要在勾选阶段就标红");
  assert.match(fx.normalizeSuggestion({ action: "done-task" }).reason, /没说改哪条任务/);
  const bad = fx.normalizeSuggestion({ action: "update-task", id: "t_999", title: "x" });
  assert.match(bad.reason, /本机任务里找不到这一条/, "编造的 id 必须当场标出来，不能等写库");
  assert.ok(!/t_999/.test(bad.reason), "标红的话术是给人看的，不要把内部 id 印上去");
  assert.equal(fx.normalizeSuggestion({ action: "update-task", id: "t_1", title: "x" }).reason, undefined, "真实 id 不该被拦");
  assert.ok(!("title" in fx.normalizeSuggestion({ action: "update-task", id: "t_1", due: "2026-09-30" })),
    "模型没给 title 时不能挂一个空串下去，否则写库会把任务标题清空");
  const s = fx.normalizeSuggestion({ action: "create-task", title: " 跑 5 公里 ", due: "2026/09/25", dueTime: "99:99", quad: 9, estMin: 99999, note: "x".repeat(500) });
  assert.equal(s.due, undefined, "日期格式不对必须丢字段，而不是把脏值传给 store");
  assert.equal(s.dueTime, undefined);
  assert.equal(s.quad, undefined, "象限越界要丢");
  assert.equal(s.estMin, undefined, "时长越界要丢");
  assert.ok(s.note.length <= 200, "备注要截断");
  assert.equal(s.title, "跑 5 公里", "标题要 trim");
  assert.match(fx.describe({ action: "create-block", title: "背书", date: "2026-09-24", start: "08:00", durMin: 45 }), /2026-09-24 08:00 起 45 分钟/);

  /* 建议行要说的是「哪条任务」，不是那串随机字符 —— 用户看不到任务表里的 id，印上去也没意义。 */
  assert.equal(fx.taskTitleOf("t_1"), "交报告", "被点名的任务要回任务表查标题");
  assert.equal(fx.describe({ action: "update-task", id: "t_1", due: "2026-09-30" }), "改任务「交报告」：改到 2026-09-30");
  assert.ok(!/t_1/.test(fx.describe({ action: "update-task", id: "t_1", due: "2026-09-30" })),
    "内部 id 不许出现在建议行上");
  assert.match(fx.describe({ action: "update-task", id: "t_1", title: "新名" }), /改任务「交报告」：标题「新名」/,
    "update-task 的 title 是「改成的新标题」，不能拿它当被改那条的名字");
  assert.equal(fx.describe({ action: "done-task", id: "t_2" }), "标记完成：取快递", "done-task 没给标题时同样回查");
  assert.match(fx.describe({ action: "update-task", id: "t_404", due: "2026-09-30" }), /未指明任务/,
    "查不到的（模型编的 id）宁可说「未指明任务」，也不印 id —— 拦它靠的是 reason 标红");
}

/* 3. 快照：带真实 id、分段正确、条数与总长都封顶 */
{
  const snap = fx.snapshot();
  assert.match(snap, /id=t_1 · 交报告 · 截止 2026-09-20 18:00/, "快照必须带 id 与关键字段，否则模型没法说「改哪条」");
  assert.match(snap, /已逾期未完成 共 1 条/, "2026-09-20 的报告要落在逾期段");
  assert.match(snap, /今天到期 共 1 条/);
  assert.match(snap, /【今天 2026-09-23/, "时间块要按天给，模型才知道哪些格子被占");
  assert.match(snap, /10:00 起 90 分钟 高数/);
  assert.match(snap, /已完成 1 条/, "已完成也要给数量，模型才能做「本周做完了什么」的盘点");
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m_${i}`, title: `任务${i}`, done: false, due: "2026-09-01", quad: 1 }));
  const saved = tasks;
  tasks = many;
  const big = fx.snapshot();
  assert.match(big, /其余 15 条略/, "单段必须封顶，否则一次请求就撞上 60000 字符上限");
  assert.ok(big.length < 9200, `快照总长必须封顶（当前 ${big.length}）`);
  tasks = saved;
  const sp = fx.systemPrompt();
  assert.match(sp, /绝不编造/, "提示词要明令不许编");
  /* 格式收紧（真机截图：正文漏 id、要点写成整段）*/
  assert.match(sp, /输出格式/, "提示词里要有一节专门讲排版");
  assert.match(sp, /第一行只写一句结论/, "要先给一句结论");
  assert.match(sp, /「一、」「二、」「三、」分块/, "分块方式要写死，模型才会跟着走");
  assert.match(sp, /不超过 5 条/, "要点条数要封顶");
  assert.match(sp, /形如 t_xxx、b_xxx 的 id/, "要点名禁止内部 id，光说「别泄露字段」没用");
  assert.match(sp, /写了也会被系统抹掉/, "告诉模型 id 会被抹掉，它才不会反复拿它当依据");
  assert.match(sp, /rest \/ work \/ study/, "分类码这类内部取值也要禁掉（截图里漏过「分类 rest」）");
  assert.match(sp, /直接写它的标题/, "禁了 id 得给出替代说法");
  assert.match(sp, /数据不够回答时\*\*只写一句\*\*/, "查不到就一句话讲清，别硬凑三块（截图那三块全是废话）");
  assert.match(sp, /不要为此硬凑「现状 \/ 建议 \/ 操作」三块/);
  assert.match(sp, /不复述用户的问题/);
  assert.match(sp, /其余 N 条略/, "数数题要交代截断：省略掉的那部分不许算进总数");
  assert.match(sp, /至少 X 条，另有 N 条未列出/);
  assert.match(sp, /按标题字样认的/, "「作业」这类按字面归类的要自己说明口径");
  assert.match(sp, /不要 Markdown 标题/);
  assert.ok(sp.indexOf("输出格式") < sp.indexOf("本机数据快照"), "格式说明要在数据前面，模型才先读到排版要求");
  fx.withContext = false;
  assert.match(fx.systemPrompt(), /已关闭「带本机数据」/, "关掉开关后提示词里不能出现任何本机数据");
  assert.ok(!fx.systemPrompt().includes("交报告"), "关了就真的一个字都不发");
  assert.match(fx.systemPrompt(), /第一行只写一句结论/, "不带数据时同样要管格式");
  fx.withContext = true;
}

/* 4. 历史裁剪：system 永远在第一位，条数不超上限 */
{
  fx.thread = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `第${i}条`, at: Date.now() }));
  fx.thread.push({ role: "error", text: "这条不该发出去", at: Date.now() });
  const msgs = fx.buildMessages();
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs.length, fx.SEND_TURNS + 1, `送给模型的历史要按轮数截断（当前 ${msgs.length}）`);
  assert.ok(!JSON.stringify(msgs).includes("不该发出去"), "错误行不参与上下文");
  assert.equal(msgs[msgs.length - 1].content, "第29条", "截断要保留最近的");
}

/* 5. 落库与撤销 */
{
  fx.thread = [];
  const created = [];
  const list = [
    fx.normalizeSuggestion({ action: "create-task", title: "约导师面谈", due: "2026-09-25", dueTime: "14:00", quad: 2, estMin: 30 }),
    fx.normalizeSuggestion({ action: "create-block", title: "背单词", date: TODAY, start: "10:00", durMin: 30, cat: "study" }),
    fx.normalizeSuggestion({ action: "update-task", id: "t_1", due: "2026-09-26" }),
    fx.normalizeSuggestion({ action: "done-task", id: "t_2" }),
  ];
  const { record, errors } = fx.applySuggestions(list);
  // vm 里造出来的数组 / 对象与宿主不是同一个原型，一律逐字段比，别用 deepEqual。
  assert.equal(errors.length, 0, "四条合法建议都应写入成功");
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].title, "约导师面谈");
  assert.equal(calls.created[0].dueTime, "14:00");
  assert.ok(!("dueTime" in fx.taskPatch({ title: "x" })), "模型没给 dueTime 时不能传空串盖掉 store 默认值");
  assert.equal(record.blocks.length, 1);
  assert.equal(list[1].movedTo, "11:30", "createSmart 挪了位置必须告诉用户，不能悄悄改时间");
  assert.equal(tasks.find((t) => t.id === "t_1").due, "2026-09-26");
  assert.equal(tasks.find((t) => t.id === "t_2").done, true);
  assert.equal(record.updates.length, 2, "改期与标记完成都要留还原记录");
  const u1 = record.updates.find((u) => u.id === "t_1");
  assert.equal(Object.keys(u1.before).length, 1, "撤销记录只存被改掉的字段，别把整条任务快照塞进去");
  assert.equal(u1.before.due, "2026-09-20");
  assert.equal(record.updates.find((u) => u.id === "t_2").before.done, false, "标记完成的撤销是回到未完成");
  assert.ok(list.every((s) => s.applied), "写成功的建议要标 applied，界面据此禁用勾选框");

  fx.undoRecord(record);
  assert.deepEqual(calls.removedTasks, [record.tasks[0]], "撤销要删掉新建的任务");
  assert.deepEqual(calls.removedBlocks, [record.blocks[0]]);
  assert.equal(tasks.find((t) => t.id === "t_1").due, "2026-09-20", "撤销要把改动还原");
  assert.equal(tasks.find((t) => t.id === "t_2").done, false, "标记完成也能撤销回去");
  assert.ok(toasts.some((t) => /已撤销/.test(t.msg)), "撤销完要给一条回执");
}

/* 6. 写坏一条不能连累其它条，且坏的那条要就地标注原因 */
{
  const savedCreate = sandbox.tide.tasks.create;
  sandbox.tide.tasks.create = (patch) => {
    if (patch.title === "坏任务") throw new Error("标题重复");
    return savedCreate(patch);
  };
  const list = [
    fx.normalizeSuggestion({ action: "create-task", title: "坏任务" }),
    fx.normalizeSuggestion({ action: "create-task", title: "好任务" }),
  ];
  const { record, errors } = fx.applySuggestions(list);
  sandbox.tide.tasks.create = savedCreate;
  assert.equal(errors.length, 1, "失败要报出来");
  assert.match(errors[0], /标题重复/);
  assert.equal(record.tasks.length, 1, "后面的合法建议照常写入");
  assert.equal(list[0].reason, "标题重复", "失败的那条要标在界面上，不能悄悄吞掉");
  assert.equal(list[1].reason, undefined, "成功的那条不该带原因");
  assert.equal(list[1].applied, true);
}

/* 7. 正文渲染：先转义再排版，模型吐出 HTML 也不会被执行 */
{
  const html = fx.md('**注意** <img src=x onerror="alert(1)"> `code`\n- 第一条\n- 第二条');
  assert.ok(!/<img/.test(html), "图片标签必须被转义");
  assert.match(html, /&lt;img/);
  assert.match(html, /<strong>注意<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul>\s*<li>第一条<\/li>\s*<li>第二条<\/li>\s*<\/ul>/s, "连续短行要收成列表");
  assert.equal((html.match(/<ul>/g) || []).length, (html.match(/<\/ul>/g) || []).length, "列表标签必须配平");

  /* 真机截图的毛病：正文抄出内部 id，还连排两遍「（id=b_xxx）（id=b_xxx）」。
     id 用生产里的真实形状（store.js：前缀 + Date.now 的 36 进制 + 5 位随机），短 id 只活在别的用例里。 */
  const savedTasks = tasks;
  const savedBlocks = sandbox.tide.blocks.list;
  tasks = savedTasks.concat([{ id: "t_mu4wrhhrc751i", title: "交报告", done: false, due: TODAY, dueTime: "18:00", quad: 1 }]);
  sandbox.tide.blocks.list = (date) => (date === TODAY
    ? [{ id: "b_hrc882934078e", date, start: "08:00", durMin: 45, title: "睡觉", cat: "rest", taskId: null }]
    : []);
  fx.snapshot();   // 走真路径填 id → 标题 映射
  assert.equal(fx.md("交报告（id=t_mu4wrhhrc751i）（id=t_mu4wrhhrc751i）"), '<p class="lead">交报告</p>',
    "同一行已经有标题，id 连同括号整段抹掉");
  assert.equal(fx.md("关联 id=t_mu4wrhhrc751i 的那条"), '<p class="lead">关联 交报告 的那条</p>',
    "行里没提标题时把 id 换成人话，而不是留一串随机字符（前后的空格不能顺手吃掉）");
  assert.equal(fx.md("时间块（id=b_hrc882934078e）"), '<p class="lead">时间块（睡觉）</p>',
    "时间块的 id 也认（映射由快照里的块填），行里没提标题就换成标题并保住括号");
  assert.equal(fx.md("关联明天 08:00 的时间块（id=b_hrc882934078e）（id=b_hrc882934078e）"),
    '<p class="lead">关联明天 08:00 的时间块（睡觉）</p>', "同一条替过一次之后，第二遍就是纯噪音");
  assert.ok(!fx.md("看这条 id=t_9zzzzzzzzzzz").includes("t_9zzzzzzzzzzz"), "对不上号的（模型编的）抹掉；编造该报的是建议块");
  assert.equal(fx.md("- id=t_mu4wrhhrc751i"), "<ul>\n<li>交报告</li>\n</ul>", "整行只有 id 时换成标题，这条要点还有意义");
  assert.equal(fx.md("- id=t_9zzzzzzzzzzz"), "", "整行只有个对不上号的 id 时不要留个光秃秃的项目符号");
  tasks = savedTasks;
  sandbox.tide.blocks.list = savedBlocks;
  fx.snapshot();   // 复位映射，别把长 id 带进后面的用例
  assert.ok(!fx.md("1.5 小时就够了").includes("<ol>"), "「1.5 小时」是数字不是序号，点号后没空格就不算列表");
  const ol = fx.md("1. 先交报告\n2、再报名\n3）最后背书");
  assert.match(ol, /<ol>\s*<li>先交报告<\/li>\s*<li>再报名<\/li>\s*<li>最后背书<\/li>\s*<\/ol>/s, "1./1、/1） 都要收成有序列表");
  assert.equal((ol.match(/<ol>/g) || []).length, (ol.match(/<\/ol>/g) || []).length, "ol 标签必须配平");
  assert.match(fx.md("1. 甲\n- 乙"), /<\/ol>\s*<ul>/s, "序号接项目符号时要换列表，不能把 li 混在一种标签里");

  /* 提示词让模型用「一、二、」分块 —— 那是小标题，不该被折成 1. 的项目符号。 */
  const sec = fx.md("一、今晚必须处理\n- 交报告\n二、明天再说\n- 报名");
  assert.match(sec, /<p class="sec">一、今晚必须处理<\/p>/, "中文序号要保留原文当小标题");
  assert.ok(!sec.includes("<ol>"), "「一、」不是列表项");
  assert.match(sec, /<p class="sec">二、明天再说<\/p>\s*<ul>/s);
  assert.ok(!fx.md("一是准备材料").includes("class=\"sec\""), "「一是…」是句子不是序号");

  /* 结论行：第一行有内容的正文做成带色块的摘要，「结论：」这类前缀不重复显示。 */
  assert.match(fx.md("今晚只需动三件事。\n\n一、别的"), /^<p class="lead">今晚只需动三件事。<\/p>/);
  assert.match(fx.md("结论：今晚只需动三件事。\n正文"), /<p class="lead">今晚只需动三件事。<\/p>/,
    "模型自己写的「结论：」前缀要吃掉，摘要行已经有视觉标记");
  assert.match(fx.md("总结：还行"), /<p class="lead">还行<\/p>/);
  assert.match(fx.md("\n\n第一行就是结论"), /<p class="lead">第一行就是结论<\/p>/, "开头空行不占结论位");
  assert.ok(!fx.md("- 只有列表\n- 没有结论").includes("lead"), "开头就是列表时不硬造摘要行");
  assert.equal((fx.md("结论：甲\n\n结论：乙").match(/class="lead"/g) || []).length, 1, "摘要只给第一行");
  assert.ok(!fx.md(`${"很长".repeat(40)}的第一行`).includes("lead"),
    "第一行本身就是一坨长段落时不许加粗 —— 那是模型没听话，加粗只会更糊");
  assert.match(fx.md(`结论：${"很长".repeat(40)}的第一行`), /^<p>很长/, "不吃摘要样式也要把「结论：」前缀去掉");

  /* markdown 漏出来也要能收住 */
  assert.match(fx.md("### 建议排法"), /<p class="sec">建议排法<\/p>/, "井号小标题归到 .sec");
  assert.match(fx.md("结论在此\n\n点这个 [提交通知](https://example.com/a?x=1&y=2) 看"), /<p>点这个 提交通知 看<\/p>/,
    "链接语法只留文字，窄气泡里不铺 URL");
}

/* 8. 端到端一轮问答：等待态复位、建议入库、历史落盘 */
{
  fx.thread = [];
  storage.clear();
  calls.chat.length = 0;
  sandbox.__reply = '今天有三件事要动。\n```json\n{"suggestions":[{"action":"create-task","title":"给导师发消息","due":"2026-09-23","dueTime":"20:00","quad":1}]}\n```';
  await fx.ask("帮我安排一下今天");
  assert.equal(calls.chat.length, 1, "只发一次请求");
  assert.equal(calls.chat[0].opts.temperature, 0.3, "温度由插件定，不吃默认值");
  assert.equal(calls.chat[0].messages[0].role, "system");
  assert.equal(calls.chat[0].messages[1].content, "帮我安排一下今天");
  assert.match(JSON.stringify(calls.chat[0].messages), /交报告/, "开了带本机数据就要把快照带上");
  assert.equal(fx.thread.length, 2);
  assert.equal(fx.thread[1].role, "assistant");
  assert.equal(fx.thread[1].suggestions.length, 1);
  assert.equal(fx.thread[1].text, "今天有三件事要动。", "正文里不该残留建议块");
  assert.equal(storage.get("thread")[1].suggestions[0].title, "给导师发消息", "建议要随历史落盘");

  sandbox.__reply = "坏掉的回复";
  await fx.ask("再来一轮");
  assert.equal(fx.thread.length, 4);

  // 上游报错 → 落成一条错误消息，并把错误原文留在界面上可重试
  const savedChat = sandbox.tide.ai.chat;
  sandbox.tide.ai.chat = async () => { throw new Error("AI 请求失败：401"); };
  await fx.ask("会失败的一问");
  sandbox.tide.ai.chat = savedChat;
  const last = fx.thread[fx.thread.length - 1];
  assert.equal(last.role, "error");
  assert.match(last.text, /401/, "错误原文要给用户看，不能只说「失败了」");
  assert.equal(fx.thread.filter((m) => m.role === "user").length, 3, "失败的那次提问要留在历史里，重试才有东西可问");
  assert.ok(fx.thread.length <= fx.KEEP, `历史必须裁到 ${fx.KEEP} 条以内`);
}

/* 9. 宿主抄收：真的把 pluginHost 拉起来跑，不靠正则猜 */
{
  globalThis.window = globalThis.window || {};
  globalThis.document = globalThis.document || {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, append() {}, addEventListener() {} }),
    getElementById: () => null,
    head: { append() {} },
    addEventListener() {},
  };
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
  const PH = await import("../src/pluginHost.js");

  PH.collectNotice({
    source: "cppu-notify", sourceName: "警大门户", total: 2,
    items: [{ title: "关于补考的通知", time: "09-22 10:00", sender: "教务处" }, { title: "   ", time: "", sender: "" }],
  });
  PH.collectNotice({ source: "gx-news", sourceName: "竞赛消息雷达", items: [{ title: "省赛报名开始", time: "09-23 09:00", sender: "GX" }] });
  PH.collectNotice({ source: "cppu-notify", sourceName: "警大门户", items: [{ title: "关于补考的通知", time: "09-22 10:00" }] });
  let feed = PH.listNotices(10);
  assert.equal(feed.length, 2, "空标题要丢，同一件事重复推送要按 source|time|title 合并");
  assert.equal(feed[0].title, "省赛报名开始", "listNotices 新的在前");
  assert.equal(feed[1].sourceName, "警大门户", "来源名要带上，AI 才说得出是哪推的");

  for (let i = 0; i < 150; i += 1) PH.collectNotice({ source: "rss-reader", items: [{ title: `条${i}` }] });
  feed = PH.listNotices(500);
  assert.equal(feed.length, 120, "队列必须封顶，跑一天不能把内存吃干净");
  assert.equal(feed[0].title, "条149");
  assert.equal(PH.listNotices(1).length, 1, "limit 要生效");

  PH.collectNotice(null);
  PH.collectNotice({ items: "不是数组" });
  PH.collectNotice({ source: "x", items: [null, { title: "活下来了" }] });
  assert.equal(PH.listNotices(1)[0].title, "活下来了", "载荷畸形只能丢条目，不能把广播方一起打断");
  PH.publishPluginMessages("school-notice", "学校通知", [
    { title: "  已有公告  ", time: "09-20", sender: "教务处" },
    { title: "", time: "09-19" },
  ]);
  assert.equal(PH.listNotices(120).filter((m) => m.source === "school-notice").length, 1, "现有列表只公开有效标题");
  assert.equal(PH.listNotices(120).find((m) => m.title === "已有公告").sourceName, "学校通知");
  PH.publishPluginMessages("school-notice", "学校通知", []);
  assert.equal(PH.listNotices(120).some((m) => m.title === "已有公告"), false, "空列表须撤销先前公开的摘要");
}

/* 10. 插件侧合并：跨重启留存、重复同步不翻倍、快照与提示词都带上消息 */
{
  fx.notices = [];
  sandbox.__feed = [
    { source: "cppu-notify", sourceName: "警大门户", title: "补考通知", time: "09-22 10:00", sender: "教务处", at: 1 },
    { source: "gx-news", sourceName: "竞赛消息雷达", title: "省赛报名", time: "09-23 09:00", sender: "GX", at: 2 },
  ];
  await fx.syncNotices();
  assert.equal(fx.notices.length, 2);
  assert.equal(fx.notices[0].title, "省赛报名", "合并后要维持新的在前");
  assert.equal(storage.get("notices").length, 2, "要落进私有存储，重启后 AI 还记得");
  await fx.syncNotices();
  assert.equal(fx.notices.length, 2, "重复同步不能翻倍");

  sandbox.__feed = [{ source: "rss-reader", sourceName: "RSS 订阅", title: "一篇新文章", time: "09-23 12:00", at: 3 }];
  await fx.syncNotices();
  assert.equal(fx.notices.length, 3);
  assert.equal(fx.notices[0].title, "一篇新文章");

  const snap = fx.snapshot();
  assert.match(snap, /其他插件的消息/, "快照必须带上消息段，否则「最近有什么通知」无从回答");
  assert.match(snap, /【警大门户 共 1 条】/);
  assert.match(snap, /补考通知 · 09-22 10:00 · 教务处/);
  assert.match(snap, /【RSS 订阅 共 1 条】/);
  assert.match(fx.systemPrompt(), /不代表用户已经处理过/, "提示词要交代「收到」不等于「办过」");

  fx.notices = [];
  assert.equal(fx.noticeBlock(), "", "一条都没收到时整段不出现，不给模型留一句空话");
}

assert.equal(fx.CHIPS.length, 5, "快捷提问至少给五条，空界面不该让用户自己想问题");
assert.ok(fx.CHIPS.some((c) => /通知/.test(c.label)), "消息收集是新能力，界面上要给一条现成的问法");
assert.ok(fx.CHIPS.every((c) => c.label && c.ask), "每条快捷提问都要有短标签与完整问法");
/* 关掉「带本机数据」后，上面那组全在问本机的事，点了只能得到一句「查不到」，所以要换一组。 */
assert.equal(fx.CHIPS_BLANK.length, 5, "通用那组也要给满五条，别留空界面");
assert.ok(fx.CHIPS_BLANK.every((c) => c.label && c.ask), "通用那组同样要标签与问法齐");
assert.ok(fx.CHIPS_BLANK.every((c) => !/本机|我的|本周|今天|逾期|通知/.test(c.ask)),
  "通用那组不许在问用户自己的事 —— 那一轮根本没把本机数据发过去");
assert.ok(fx.CHIPS.every((a) => !fx.CHIPS_BLANK.some((b) => b.ask === a.ask)), "两组问题不许重叠");
fx.withContext = false;
assert.equal(fx.activeChips(), fx.CHIPS_BLANK, "开关关掉就要切到通用那组");
fx.withContext = true;
assert.equal(fx.activeChips(), fx.CHIPS, "打开时回到本机数据那组");
assert.ok(Object.keys(fx.ACTIONS).every((a) => /create|update|done/.test(a)), "写库动作白名单只能增改，不许出现删除类动作");

/* 历史迁移、新会话隔离、草稿恢复、重启读回与进行中的请求保护。 */
{
  storage.clear();
  const legacy = [{ role: "user", text: "旧对话 <标题>", at: 100 }, { role: "assistant", text: "旧回复", at: 101 }];
  storage.set("thread", legacy);
  storage.set("draft", "旧对话待发送的草稿");
  fx.loaded = false;
  await fx.loadOnce();
  const oldId = fx.sessionId;
  assert.equal(fx.sessions.length, 1, "旧记录应迁入历史，不能丢失");
  assert.equal(fx.sessions[0].title, "旧对话 <标题>");
  fx.startSession();
  assert.equal(fx.thread.length, 0, "新会话不能带入上一段历史");
  assert.equal(fx.draft, "", "新会话不能带入上一段草稿");
  fx.draft = "新对话草稿";
  fx.saveThread();
  const newId = fx.sessionId;
  fx.startSession(oldId);
  assert.equal(fx.draft, "旧对话待发送的草稿");
  assert.equal(fx.thread[1].text, "旧回复");
  fx.startSession(newId);
  assert.equal(fx.draft, "新对话草稿");
  assert.equal(fx.sessions.length, 2, "重复切换不能复制会话");
  fx.loaded = false;
  await fx.loadOnce();
  assert.equal(fx.sessionId, newId, "重启应恢复当前会话");
  assert.equal(fx.draft, "新对话草稿");
  const originalChat = sandbox.tide.ai.chat;
  let finish;
  sandbox.tide.ai.chat = () => new Promise((resolve) => { finish = resolve; });
  const pending = fx.ask("当前请求");
  await Promise.resolve();
  await Promise.resolve();
  fx.startSession(oldId);
  assert.equal(fx.sessionId, newId, "请求进行中不能切换，以免回复写错会话");
  fx.startSession();
  assert.equal(fx.sessionId, newId, "请求进行中不能新建会话");
  finish("当前回复");
  await pending;
  assert.equal(fx.sessions.find((s) => s.id === newId).thread.at(-1).text, "当前回复");
  assert.equal(fx.sessions.find((s) => s.id === oldId).thread.at(-1).text, "旧回复");
  sandbox.tide.ai.chat = originalChat;
}

/* 思考强度（v0.175.0）：档位必须真的进请求体，而「自动」必须一个字段都不加。
   这条链有四段（插件 → tide.ai → api → Rust），断一段界面照样显示、请求却没带上，
   所以四段各钉一条断言，再真跑一遍循环与落盘。 */
{
  // vm 里造出来的数组与宿主不同原型，逐项串成字符串比（同文件开头的既有约定）。
  const ids = fx.THINK_LEVELS.map((l) => l.id).join(",");
  assert.equal(ids, ",low,medium,high",
    "档位顺序必须是 自动 → 低 → 中 → 高（自动排第一，也是新装的默认值）");
  assert.equal(fx.THINK_LEVELS[0].id, "", "「自动」必须是空串 —— 它代表请求体里根本不出现 reasoning_effort");
  assert.ok(fx.THINK_LEVELS.every((l) => l.label && l.hint), "每一档都要有按钮文字与说明，否则点了不知道选了什么");

  /* 按钮自己的类名（v0.175.0 打磨）：`.aichat-think` 不是「思考强度」的钩子，它是
     「正在思考…」那三个跳动圆点的类（下方 .aichat-think i 挂着 animation）。新按钮
     复挂它的话，今天只是白蹭了 display/gap，哪天往按钮里塞个 <i> 就会当场冒出三个点。
     所以钉死两件事：按钮用 .aichat-effort，圆点继续用 .aichat-think。 */
  // 按钮按类名清单来判（而不是钉一整串 class="..."）：类顺序换了也照样判得出来。
  const thinkBtn = mainSrc.match(/<button[^>]*\bdata-think\b[^>]*>/);
  assert.ok(thinkBtn, "模板里要有思考强度按钮（data-think 是渲染与测试的共同抓手）");
  const thinkCls = ((thinkBtn[0].match(/class="([^"]*)"/) || [])[1] || "").trim().split(/\s+/);
  assert.ok(thinkCls.includes("aichat-effort"), "思考强度按钮要用自己的类名 .aichat-effort");
  assert.ok(!thinkCls.includes("aichat-think"),
    "思考强度按钮不能复挂 .aichat-think —— 那是「正在思考…」圆点的类（.aichat-think i 挂着圆点动画），挂上后按钮里一旦有 <i> 就会冒出三个点");
  assert.match(mainSrc, /\.aichat-effort\{display:inline-flex/, "自己的类名要有对应样式，否则按钮掉回默认行盒、与相邻 chip 不齐");
  assert.match(mainSrc, /<span class="aichat-think"><i><\/i><i><\/i><i><\/i> 正在思考…<\/span>/,
    "圆点指示器仍要挂在 .aichat-think 上（改名的只是按钮，别把指示器一起改了）");

  // 按钮 title 的「点击依次切换：…」提成常量只算一次；paintThink() 每次重绘都跑，别再 map + join。
  assert.match(mainSrc, /const THINK_CYCLE = THINK_LEVELS\.map\(\(l\) => l\.label\)\.join\(" → "\)/,
    "切换提示串要提成模块级常量");
  assert.match(mainSrc, /点击依次切换：\$\{THINK_CYCLE\}/, "paintThink() 要复用这个常量");
  assert.equal((mainSrc.match(/THINK_LEVELS\.map\(/g) || []).length, 1,
    "THINK_LEVELS.map 只准出现在常量定义处 —— 出现在重绘路径上就是每次重绘重新拼一遍");

  assert.match(mainSrc, /tide\.ai\.chat\(buildMessages\(\), \{ temperature: 0\.3, reasoningEffort: thinkEffort \}\)/,
    "档位必须真的跟着请求发出去，只画在界面上等于没接");
  assert.match(host, /api\.aiChat\(messages, opts\.temperature, opts\.reasoningEffort\)/, "宿主必须把档位透下去");
  assert.match(api, /invoke\("ai_chat", \{ messages, temperature, reasoningEffort \}\)/, "api 层要把档位递给 Rust");
  assert.match(rust, /reasoning_effort: Option<String>/, "ai_chat 必须收 reasoningEffort 参数");
  assert.match(rust, /"low" \| "medium" \| "high" => body\["reasoning_effort"\] = json!\(effort\)/,
    "只有三档能落进请求体，别把任意字符串透传给上游");
  assert.match(rust, /"" \| "auto" => \{\}/, "自动档必须一个字段都不加 —— 有的网关不认这个键，多塞就 400");
  assert.match(rust, /思考强度只能是 low \/ medium \/ high/, "非法档位要报中文错误，别让它变成上游一句看不懂的 400");
  assert.match(doc, /reasoningEffort/, "插件开发文档必须写清这个可选参数");
  assert.match(doc, /reasoning_effort/, "文档要写明落到上游的字段名");

  storage.clear();
  fx.loaded = false;
  await fx.loadOnce();
  assert.equal(fx.thinkEffort, "", "新装默认是自动档");
  const seen = [];
  for (let i = 0; i < 4; i++) { fx.cycleThink(); seen.push(fx.thinkEffort); }
  assert.equal(seen.join(","), "low,medium,high,", "点四下要转回自动，不能停在末尾或跳档");
  assert.equal(storage.get("thinkEffort"), "", "每次切换都要落盘（最后一档是空串也要存）");

  fx.thinkEffort = "high";
  calls.chat.length = 0;
  await fx.ask("随便问一句");
  assert.equal(calls.chat.at(-1).opts.reasoningEffort, "high", "选中的档位要出现在这一轮的请求里");

  fx.thinkEffort = "";
  calls.chat.length = 0;
  await fx.ask("再问一句");
  assert.equal(calls.chat.at(-1).opts.reasoningEffort, "", "自动档照样往下传空串，由宿主 / Rust 决定不加字段");

  storage.set("thinkEffort", "super-high");
  fx.loaded = false;
  await fx.loadOnce();
  assert.equal(fx.thinkEffort, "", "认不出来的档位要退回自动，别把一个非法值递给 Rust（它会直接报错）");
}

console.log("PASS: AI 对话插件 —— 权限 / 快照 / 建议写入撤销 / 一轮问答 / 历史迁移 / 会话与草稿隔离 / 思考强度 / 请求保护");
