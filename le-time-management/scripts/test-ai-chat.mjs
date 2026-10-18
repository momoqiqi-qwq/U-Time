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
const calls = { created: [], updated: [], removedTasks: [], removedBlocks: [], smart: [], chat: [], chipGlow: { attach: [], sync: [], dispose: [], onDispose: [] } };
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
  clearTimeout,
  // 下拉栏展开后要等过渡跑完再让光块量落点（真环境都有 rAF，vm 里补一个同步版）
  requestAnimationFrame: (fn) => fn(),
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
    ui: {
      registerView() {},
      // 宿主的滑动选中光（铁律六）：插件侧只拿到 { sync, dispose }，这里记账。
      selectionGlow(container, options = {}) {
        calls.chipGlow.attach.push({ container, options });
        return {
          sync: () => calls.chipGlow.sync.push(options.selector),
          dispose: () => calls.chipGlow.dispose.push(container),
        };
      },
      onDispose(fn) { calls.chipGlow.onDispose.push(fn); },
    },
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
    + "    cardHtml, toneOf, CARD_TONES, renameSession, archiveSession, deleteSession, persistSessions,\n"
    + "    get sessions() { return sessions; }, get sessionId() { return sessionId; },\n"
    + "    get draft() { return draft; }, set draft(v) { draft = v; },\n"
    + "    set loaded(v) { loaded = v; },\n"
    + "    get withContext() { return withContext; }, set withContext(v) { withContext = v; },\n"
    + "    THINK_LEVELS, paintThink, setThinkMenu, pickThink, THINK_ON,\n"
    + "    get thinkEffort() { return thinkEffort; }, set thinkEffort(v) { thinkEffort = v; },\n"
    + "    get thinkOpen() { return thinkOpen; },\n"
    + "    get thinkGlow() { return thinkGlow; }, set thinkGlow(v) { thinkGlow = v; },\n"
    + "    paintChips, paintChipSelection, attachChipGlow, CHIP_ON,\n"
    + "    parseGenui, splitGenui, genuiHtml, bodyHtml, giInline, giText, giRender, wireGenui,\n"
    + "    GENUI_LANGS, GENUI_AS_CODE, GENUI_MAX_NODES, GENUI_MAX_DEPTH, GENUI_MARK,\n"
    + "    get ui() { return ui; }, set ui(v) { ui = v; },\n"
    + "    get activeChip() { return activeChip; }, set activeChip(v) { activeChip = v; },\n"
    + "    get chipGlow() { return chipGlow; },\n"
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
  // 注意 (?![-\w])：下拉栏里的选项带 data-think-lv，别把选项当成按钮抓进来。
  const thinkBtn = mainSrc.match(/<button[^>]*\bdata-think(?![-\w])[^>]*>/);
  assert.ok(thinkBtn, "模板里要有思考强度按钮（data-think 是渲染与测试的共同抓手）");
  const thinkCls = ((thinkBtn[0].match(/class="([^"]*)"/) || [])[1] || "").trim().split(/\s+/);
  assert.ok(thinkCls.includes("aichat-effort"), "思考强度按钮要用自己的类名 .aichat-effort");
  assert.ok(!thinkCls.includes("aichat-think"),
    "思考强度按钮不能复挂 .aichat-think —— 那是「正在思考…」圆点的类（.aichat-think i 挂着圆点动画），挂上后按钮里一旦有 <i> 就会冒出三个点");
  assert.match(mainSrc, /\.aichat-effort\{display:inline-flex/, "自己的类名要有对应样式，否则按钮掉回默认行盒、与相邻 chip 不齐");
  assert.match(mainSrc, /<span class="aichat-think"><i><\/i><i><\/i><i><\/i> 正在思考…<\/span>/,
    "圆点指示器仍要挂在 .aichat-think 上（改名的只是按钮，别把指示器一起改了）");

  // 档位串与下拉栏的选项 HTML 都在常量区一次算好；paintThink() 每次重绘都跑，别再 map + join。
  assert.match(mainSrc, /const THINK_CYCLE = THINK_LEVELS\.map\(\(l\) => l\.label\)\.join\(" → "\)/,
    "档位串要提成模块级常量");
  assert.ok(mainSrc.includes("。可选：${THINK_CYCLE}`"), "paintThink() 的 title 要复用这个常量，别再 map + join");
  assert.match(mainSrc, /const THINK_ITEMS = THINK_LEVELS\.map\(/, "四档的选项 HTML 也要在常量区一次拼好");
  assert.ok(mainSrc.includes('role="option" class="aichat-lv" data-think-lv="${l.id}"'), "每个选项都要带档位标识（渲染与测试的共同抓手）");
  assert.equal((mainSrc.match(/THINK_LEVELS\.map\(/g) || []).length, 2,
    "THINK_LEVELS.map 只准出现在两条常量定义处 —— 出现在重绘路径上就是每次重绘重新拼一遍");

  /* 两颗按钮从顶栏搬进输入区（v0.204.0）。用户原话：「这2个按钮弄成到对话框那里去」——
     改本轮行为的东西要贴着「说」的地方；顶栏只留对话历史与只读状态（已收集 N 条）。
     v0.205.0 又把输入区收了一轮（用户原话：「让对话拥有更大的空间…不然看不到上面的对话」）：
     输入框升到最上，两颗胶囊与工具按钮并成一行摆在它下面，档位栏移到最后（它现在是浮层）。 */
  {
    const head = mainSrc.slice(mainSrc.indexOf('<div class="aichat-head">'), mainSrc.indexOf('<div class="aichat-backdrop"'));
    assert.ok(!head.includes("data-ctx") && !head.includes("data-think"), "顶栏里不许再留这两颗按钮");
    const barAt = mainSrc.indexOf('<div class="aichat-bar">');
    const taAt = mainSrc.indexOf('<textarea class="aichat-input"');
    const chipsAt = mainSrc.indexOf('<div class="aichat-compose-chips">');
    const toolsAt = mainSrc.indexOf('<div class="aichat-compose-tools">');
    const menuAt = mainSrc.indexOf('<div class="aichat-effort-menu"');
    assert.ok(barAt > 0 && taAt > barAt && chipsAt > taAt && toolsAt > chipsAt && menuAt > toolsAt,
      "输入区里的顺序必须是 输入框 → 两颗按钮 + 工具按钮（同一行） → 档位栏");
    assert.ok(mainSrc.includes('<div class="aichat-compose-row">') && mainSrc.includes(".aichat-compose-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}"),
      "两颗胶囊与工具按钮要装进同一个 .aichat-compose-row：整行并排、窄屏能换行，否则输入区白占两行高度");
    assert.ok(mainSrc.includes(".aichat-compose-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1 1 auto;min-width:0}"),
      "按钮行要能换行（窄屏别把输入区撑出横向滚动），并吃掉左半边剩余宽度好让工具按钮靠右");
    assert.ok(mainSrc.includes('class="aichat-chip aichat-effort" data-think aria-haspopup="listbox" aria-expanded="false" aria-controls="aichat-effort-menu"'),
      "胶囊按钮要声明自己是 listbox 的开关，并且初始收起");
    assert.ok(mainSrc.includes('<div class="aichat-effort-menu" id="aichat-effort-menu" role="listbox" aria-label="思考强度" aria-hidden="true" inert>'),
      "档位栏初始是收起的（inert + aria-hidden），收起时内部选项点不到也 Tab 不到");
    // 说明文字在窄屏要收起来（只留档位名），否则一行挤不下
    assert.ok(mainSrc.includes("@media (max-width:640px){.aichat-compose-row{gap:6px}.aichat-compose-chips{gap:4px}.aichat-compose-tools{gap:6px}.aichat-shortcuts{mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent);-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}.aichat-lv{padding:7px 8px}.aichat-lv small{display:none}}"),
      "窄屏要收紧按钮行间距、给快捷条一个右缘渐隐（横滚才有提示）、并收掉档位说明");
  }

  /* 铁律七：下拉栏必须有展开与收起动画，而且是连续插值 —— 不许「打开淡入、关闭 display:none」。 */
  {
    assert.ok(mainSrc.includes(".aichat-effort-menu{position:absolute;z-index:9;left:0;right:0;bottom:calc(100% + 6px);isolation:isolate;display:grid;grid-template-rows:0fr;opacity:0;pointer-events:none;transform:translateY(6px);"),
      "档位栏要做成向上展开的浮层（bottom:100% 朝消息流方向长），收起态仍是 0fr + 透明：它一旦回到 in-flow，展开那一瞬就会吃掉 139px 把上面对话顶掉");
    assert.ok(mainSrc.includes(".aichat-effort-menu.open{grid-template-rows:1fr;opacity:1;pointer-events:auto;transform:none}"), "展开态是 1fr，中间过程由浏览器插值");
    assert.ok(mainSrc.includes(".aichat-bar{position:relative;"),
      "浮层的定位祖先必须是 .aichat-bar（相对它向上长），bar 得是 positioned —— 包含块落在 .aichat 里才不出安全区");
    assert.ok(mainSrc.includes("pointer-events:none"), "透明期间不能收点击");
    assert.ok(mainSrc.includes(".aichat-effort-in{overflow:hidden;min-height:0"), "内层要 overflow:hidden + min-height:0，否则 0fr 压不出 0 高（经典坑）");
    assert.ok(mainSrc.includes("transition:transform 240ms"), "方向箭头要连续旋转（同一支箭头），不是换字符");
    assert.ok(mainSrc.includes("transform:rotate(-135deg)"), "展开时箭头要转过去，收起时转回来");
    assert.ok(mainSrc.includes(".aichat-effort-menu .selection-glow{"), "光块长相要在插件样式里定（基础规则只管定位）");
    assert.ok(mainSrc.includes(".aichat-effort-menu.has-selection-glow .aichat-lv.on{background:transparent"),
      "光块在场时选中项不能再画第二层底，否则叠成实心块");
    assert.ok(mainSrc.includes(".aichat-effort-menu:not(.has-selection-glow) .aichat-lv.on{"),
      "老宿主没有滑动光时要退回瞬变底色，选中项不能没有反馈");
    assert.ok(mainSrc.includes(':root[data-ui-motion="reduced"] .aichat-effort-arrow,:root[data-ui-motion="reduced"] .aichat-effort-menu,:root[data-ui-motion="reduced"] .aichat-effort-in{transition:none}'),
      "应用内的「减少动效」开关也要能停掉下拉栏的过渡");
    assert.ok(mainSrc.includes(".aichat-effort-arrow,.aichat-effort-menu,.aichat-effort-in,.aichat-shortcuts button"),
      "prefers-reduced-motion 白名单要包含下拉栏");
  }

  /* 铁律六 + 交互接线：选中高亮走宿主滑动光；Esc / 点别处 / 选完一档都要收起。 */
  {
    assert.match(mainSrc, /tide\.ui\.selectionGlow\?\.\(ui\.thinkMenu, \{ selector: THINK_ON \}\)/,
      "下拉栏的选中高亮必须走宿主的滑动选中光（与快捷提问行同一套）");
    assert.ok(mainSrc.includes('const THINK_ON = "button.aichat-lv.on"'), "光块的定位口径是选中项的 .on");
    assert.ok(mainSrc.includes("ui.thinkMenu.inert = !open;"), "开合都要同步 inert —— 收起后里面点不到也 Tab 不到");
    assert.ok(mainSrc.includes('ui.thinkMenu.setAttribute("aria-hidden", String(!open))'), "aria-hidden 要跟着状态走");
    assert.ok(mainSrc.includes('ui.think.setAttribute("aria-expanded", String(open))'), "aria-expanded 要跟着状态走");
    assert.ok(mainSrc.includes("const top = thinkOpen ? () => setThinkMenu(false, true)"), "Esc 先关下拉栏，再轮到弹窗与侧栏");
    assert.match(mainSrc, /if \(ui\.think\.contains\(event\.target\) \|\| ui\.thinkMenu\.contains\(event\.target\)\) return;[\s\S]{0,40}setThinkMenu\(false\);/,
      "点别处要收起：它不是浮层，没有「点外面还留着」的理由");
    assert.match(mainSrc, /ArrowDown.*ArrowUp.*Home.*End/, "下拉栏要能用方向键换档（键盘可操作）");
    assert.ok(mainSrc.includes("if (open && thinkOpen) setThinkMenu(false);"), "弹窗打开时输入区那份下拉先收起，两层焦点不打架");
    assert.match(mainSrc, /thinkOpen = false;/, "DOM 重建后要把展开标志位拉回收起态，否则第一次点按钮没反应");
    assert.ok(mainSrc.includes("thinkGlow?.dispose();\n    thinkGlow = tide.ui.selectionGlow?.("), "光块每次重建都要重挂（旧光块量的是已经不在文档里的旧选项）");
    assert.ok(mainSrc.includes("thinkGlow?.dispose(); thinkGlow = null; }"), "卸载时要把光块一起撤掉");
    /* 光块落位的时机是这条改动的要害：展开的那一帧容器还是 0 高、内边距也还在从 0 长到 8px，
       真应用探针实测这一帧量到的 offsetTop 比终态少 8px（换档后重新展开，高亮会贴着选项上沿偏出去）。
       所以必须等最长那条过渡走完再量，别退回「下一帧就同步」。 */
    assert.ok(mainSrc.includes("clearTimeout(thinkGlowTimer);\n    if (open) thinkGlowTimer = setTimeout(() => thinkGlow?.sync(), 300);"),
      "展开后要等过渡跑完（约 300ms）再让光块落位，不能在容器还塌着的那一帧量位置");
    assert.ok(!mainSrc.includes("requestAnimationFrame(() => thinkGlow?.sync())"),
      "rAF 那一帧量到的是过渡中的偏移位置（实测差 8px），这条路径要拆掉");
  }

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
  /* 下拉栏真跑（铁律七 + 铁律六）：假 DOM 只记账 classList / 属性 / inert，
     但「展开 → 换档 → 收起 → 快速连点」这一整条链是真的走插件自己的函数。 */
  {
    const mkOpt = (id) => {
      const cls = new Set();
      return {
        dataset: { thinkLv: id },
        has: (c) => cls.has(c),
        classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
        setAttribute() {},
        focus() {},
      };
    };
    const opts = fx.THINK_LEVELS.map((l) => mkOpt(l.id));
    const lab = { textContent: "" };
    const menuCls = new Set();
    const menuAttr = {};
    const menu = {
      inert: true,
      classList: { toggle: (c, on) => { if (on) menuCls.add(c); else menuCls.delete(c); }, contains: (c) => menuCls.has(c) },
      setAttribute: (k, v) => { menuAttr[k] = v; },
      querySelectorAll: (sel) => (sel === "[data-think-lv]" ? opts : []),
      contains: () => false,
      addEventListener() {},
      onclick: null,
    };
    const btnCls = new Set();
    const btnAttr = {};
    const btn = {
      focused: false,
      classList: { toggle: (c, on) => { if (on) btnCls.add(c); else btnCls.delete(c); }, contains: (c) => btnCls.has(c) },
      setAttribute: (k, v) => { btnAttr[k] = v; },
      querySelector: (sel) => (sel === ".aichat-effort-lab" ? lab : null),
      contains: () => false,
      focus() { btn.focused = true; },
      onclick: null,
    };
    fx.ui = { think: btn, thinkMenu: menu };
    fx.paintThink();
    assert.equal(lab.textContent, "思考强度 自动", "胶囊按钮上要写出当前档位，不能只有个名字");
    assert.equal(btnCls.has("on"), false, "「自动」档不点亮（= 没额外要求）");

    fx.setThinkMenu(true);
    assert.equal(fx.thinkOpen, true, "点一下要展开");
    assert.equal(menuCls.has("open"), true, "展开要有 .open —— 它就是 0fr→1fr 的开关（铁律七）");
    assert.equal(menuAttr["aria-hidden"], "false", "展开时内部选项要能被读屏与 Tab 触达");
    assert.equal(menu.inert, false, "展开要解除 inert");
    assert.equal(btnAttr["aria-expanded"], "true", "aria-expanded 要跟着状态走");

    // 快速连点：从当前画面接续，不许残留中间态、也不许叠加
    fx.setThinkMenu(false);
    fx.setThinkMenu(true);
    fx.setThinkMenu(true);
    assert.equal(fx.thinkOpen, true, "连点之后状态就是最后一次的意图");
    assert.equal(menuCls.has("open"), true);
    assert.equal(menu.inert, false, "连点不许把 inert 留在错误的一侧");

    fx.pickThink("high");
    assert.equal(fx.thinkEffort, "high", "选一档要就地生效");
    assert.equal(storage.get("thinkEffort"), "high", "换档要落盘（下一句话与重启都要用）");
    assert.equal(fx.thinkOpen, false, "选完要收起");
    assert.equal(menuCls.has("open"), false);
    assert.equal(menu.inert, true, "收起后内部选项既点不到也 Tab 不到");
    assert.equal(menuAttr["aria-hidden"], "true");
    assert.equal(btnAttr["aria-expanded"], "false");
    assert.equal(btn.focused, true, "收起后焦点要回胶囊按钮，别掉到 body 上");
    assert.equal(lab.textContent, "思考强度 高", "按钮上的档位要跟着换");
    assert.equal(btnCls.has("on"), true, "非自动档要点亮");
    assert.equal(opts.filter((o) => o.has("on")).length, 1, "选中态只能有一个");
    assert.equal(opts[3].has("on"), true, "亮的是「高」那一项");

    fx.pickThink("不存在的档");
    assert.equal(fx.thinkEffort, "high", "认不出来的档位直接丢掉，别递给 Rust（它会报错）");

    /* 光块落位的时序真跑：展开当帧不许量位置（容器还塌着），过渡走完补一次；
       连点之后只留最后一次，不许叠加 timeout 造成多次 sync。 */
    const glow = { syncs: 0, sync() { this.syncs += 1; } };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    fx.thinkGlow = glow;
    fx.setThinkMenu(true);
    assert.equal(glow.syncs, 0, "展开的同一帧不许 sync —— 那时容器还是 0 高，量出来的落点是假的");
    await sleep(340);
    assert.equal(glow.syncs, 1, "过渡走完要补一次 sync，否则光块永久停在这个假位置上");
    fx.setThinkMenu(false);
    await sleep(340);
    assert.equal(glow.syncs, 1, "收起不必再 sync —— 光块随容器一起收下去，没有落位可量");
    fx.setThinkMenu(true);
    fx.setThinkMenu(false);
    fx.setThinkMenu(true);
    await sleep(340);
    assert.equal(glow.syncs, 2, "连点只留最后一次展开的 sync，旧的 timer 必须被 clearTimeout 掉");
    fx.thinkGlow = null;
    fx.ui = null;
  }

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

/* ───────── 快捷提问行的滑动选中光（v0.187.0）───────── */

/* 宿主这一口：铁律六要求单选控件的选中高亮随选择滑动，插件拿不到 src/selectionGlow.js，
   所以由宿主直传。少了权限闸门或少了 dispose，插件就会各自写一套「闪一下」的高亮。 */
{
  assert.match(host, /selectionGlow\(container, options = \{\}\) \{[\s\S]{0,320}requirePermission\(man, pid, "ui"\)/,
    "tide.ui.selectionGlow 必须过 ui 权限闸门");
  assert.match(host, /const glow = attachSelectionGlow\(container, \{ selector, persistKey: String\(options\.persistKey \|\| ""\) \}\)/,
    "必须是 src/selectionGlow.js 的直传（同一套滑动光，别另写一份）");
  assert.match(host, /return \{ sync: \(\) => glow\.sync\(\), dispose \};/, "要同时给出 sync 与 dispose");
  assert.match(host, /attachSelectionGlow\(container, options\)|attachSelectionGlow\(modes, \{ selector: 'button\[aria-pressed="true"\]' \}\)/,
    "番茄模式用的也是同一套光，别把这层关系弄丢");
  assert.match(doc, /tide\.ui\.selectionGlow\(/, "插件开发文档必须写这一口");
  assert.match(doc, /\.selection-glow/, "文档要说明容器自己上色（基础规则只管定位）");

  assert.match(mainSrc, /tide\.ui\.selectionGlow\?\.\(ui\.shortcuts, \{ selector: CHIP_ON \}\)/,
    "快捷提问行必须走宿主的滑动选中光");
  assert.match(mainSrc, /const CHIP_ON = "button\.on"/, "选中项的定位口径是 .on");
  assert.match(mainSrc, /\.aichat-shortcuts \.selection-glow\{/, "光块长相要在插件样式里定");
  assert.match(mainSrc, /\.aichat-shortcuts\.has-selection-glow button\.on\{background:transparent/,
    "光块在场时选中按钮不能再画第二层底，否则两层叠成实心块");
  assert.match(mainSrc, /\.aichat-shortcuts\{position:relative;isolation:isolate;/,
    "光块按 offsetLeft 定位，容器必须是定位祖先");

  // 行下空位：58px 是浮层口径（NepheleDialog 要露按钮阴影），本视图不是浮层
  // v0.235.0：上下边距再收一轮（26/18 → 10/12），左右上限 100px → 64px。
  // 用户原话「ai对话上面还可以再窄一点，让对话能看到更多地方」—— 减的是对话面自己的边距，
  // 不是内容宽度；.aichat 高度仍是 100%，省下来的全归消息流。
  // v0.243.0：左右内边距单独抽成 --pad-x 并再收一轮（5%/64px → 1.6%/24px）。
  // 用户原话「侧边栏再左移一点」「右边再拉长一点，顶到界面差不多位置」—— 收的是对话面自己的
  // 左右边距，侧栏左缘与消息流右缘同时往外吃，内容宽度本身不动。
  assert.match(mainSrc, /padding:10px var\(--pad-x\) 12px;/, "上下边距 10px/12px，左右走 --pad-x");
  assert.match(mainSrc, /--pad-x:clamp\(10px,1\.6%,24px\)/,
    "左右内边距必须抽成变量：抽屉态侧栏的 left 与拖拽条的 left 都用它对齐，写死就会错位");
  assert.doesNotMatch(mainSrc, /padding:[^;}]*\b58px/, "别退回 58px：行下会多出 82px 空位");
  /* 对话框本体（v0.193.0）：以前 .aichat 是一层纯装饰壳，真正的输入区是壳里另起的一个带边框、
     带独立底色的小框 —— 用户看到的就是「框里套小框」，点发送还没反应。现在消息流与输入区是同一块
     对话面里的上下两段：顶栏（标题/状态）→ 消息流 → 输入区 → 快捷提问。 */
  {
    const headAt = mainSrc.indexOf('<div class="aichat-head"');
    const backdropAt = mainSrc.indexOf('<div class="aichat-backdrop"');
    const flowAt = mainSrc.indexOf('<div class="aichat-flow">');
    const barAt = mainSrc.indexOf('<div class="aichat-bar">');
    const shortAt = mainSrc.indexOf('<div class="aichat-shortcuts"');
    const feedAt = mainSrc.indexOf('class="aichat-feed"');
    assert.ok(headAt > 0 && backdropAt > headAt && flowAt > backdropAt && barAt > flowAt && shortAt > barAt,
      "顺序必须是 顶栏 → 消息流(.aichat-flow) → 输入区(.aichat-bar) → 快捷提问：输入区贴着对话框底部，中间别再垫一层");
    assert.ok(feedAt > headAt && feedAt < backdropAt,
      "「已收集 N 条」这类状态是顶栏的一句话，要跟着标题走 —— 留在输入区下面就等于在行下再垫一条");
    assert.match(mainSrc, /\.aichat-flow\{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1\}/,
      "消息流那一块要可伸缩，否则长对话会把输入区挤出框外");
    assert.doesNotMatch(mainSrc, /<div class="aichat-body">\s*<div class="aichat-log">/,
      "消息流包裹层不能叫 .aichat-body —— 那是单条消息气泡容器的名字，同名会把 gap/column 套到每条气泡上");
  }

  /* v0.243.0：输入区改成圆角输入卡（用户原话「将下面的对话框设置为圆角」）。
     仍然是**一层**边界 —— 圆角/描边/底色只挂在 .aichat-bar 上，里面那颗 textarea 继续
     彻底透明、圆角归零（见下一条 !important 规则），所以不是「框里再套个小框」的老毛病。 */
  assert.match(mainSrc, /\.aichat-bar\{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:6px;flex:none;padding:9px 12px;border:1px solid #c9acd33d;border-radius:18px;background:#2b243b8f;/,
    "输入区是圆角输入卡：自己的描边 + 18px 圆角 + 半透明底，并兼作档位浮层的定位祖先");
  assert.doesNotMatch(mainSrc, /\.aichat-bar\{[^}]*border-radius:0[^}]*\}/,
    "圆角不许再退回 0（用户要的就是圆角输入卡）");

  /* 宿主 src/styles.css 那条通用输入框规则（input/select/textarea，带 !important、特异性 (0,3,1)）
     会把 textarea 刷成 --control-bg 实底 + 8px 圆角，插件样式注入在 <head> 末尾也压不住 ——
     两边都 !important 时比的是特异性、不是先后（宿主自己在 .market-search 那条注释里记过这个坑）。
     压不住的结果就是紫卡里嵌一颗白色实心小圆角框，正是用户说的「框里再套一个小框」。 */
  assert.match(mainSrc, /\.aichat \.aichat-bar textarea\.aichat-input\.aichat-input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)\{/,
    "要压过宿主那条通用输入框规则：选择器必须抬到 (0,6,1)");
  {
    const guard = mainSrc.slice(mainSrc.indexOf('.aichat .aichat-bar textarea.aichat-input.aichat-input'), mainSrc.indexOf('.aichat-compose-tools'));
    assert.match(guard, /background:transparent !important;/, "底色必须透明（宿主把它刷成了 --control-bg 实底）");
    assert.match(guard, /border-radius:0 !important;/, "圆角必须归零（宿主钉死了 8px）");
    assert.match(guard, /outline:none !important;/, "聚焦描边也要去掉，聚焦反馈交给 .aichat-bar:focus-within 的呼吸光");
  }

  /* 空对话时那块欢迎卡要看得见：以前深色段用 border:0;padding:0;background:none 把它抹平，
     整块只剩一片紫底 —— 那就是用户看到的「一个空框」。 */
  assert.doesNotMatch(mainSrc, /\.aichat-empty\{border:0;padding:0;background:none\}/,
    "空态不能抹平");
  assert.match(mainSrc, /\.aichat-empty\{flex:none;border:1px solid #b08fc045;border-radius:16px;padding:20px 22px;background:#2b243ba6;margin-bottom:0\}/,
    "空态是一张有底有边的欢迎卡");

  // 入场与发光照 NepheleDialog（opacity 300ms OutCubic + scale .9→1 400ms OutBack + 软阴影）
  assert.match(mainSrc, /@keyframes aichat-dialog-in\{from\{transform:translate3d\(0,20px,0\) scale\(\.9\)\}to\{transform:none\}\}/,
    "入场位移/缩放要照 NepheleDialog 的 enter");
  assert.match(mainSrc, /animation:aichat-dialog-in 400ms cubic-bezier\(\.34,1\.4,\.64,1\) both,aichat-dialog-fade 300ms cubic-bezier\(\.16,1,\.3,1\) both/,
    "两条动画要分开给时长：透明度快、弹性变换慢");
  assert.match(mainSrc, /@keyframes aichat-bar-glow\{/, "输入框聚焦要有呼吸光（Nephele SettingChipGroup 的 pulse）");
  assert.match(mainSrc, /\.aichat-bar:focus-within\{border-color:#b99cc7;animation:aichat-bar-glow/, "呼吸光只在聚焦时跑");

  // 减少动效：新加的动画 / 过渡都要进白名单，否则省电模式照旧播
  assert.match(mainSrc, /\.aichat-shortcuts button,\.aichat-shortcuts \.selection-glow\{transition:none\}/,
    "prefers-reduced-motion 白名单要包含快捷提问行与光块");
  assert.match(mainSrc, /\.aichat,\.aichat-menu,\.aichat-bar,\.aichat-think i\{animation:none\}/,
    "入场与呼吸光都要能停（.aichat-menu 的汉堡位移动画也在内）");
  assert.match(mainSrc, /:root\[data-ui-motion="reduced"\] \.aichat,:root\[data-ui-motion="reduced"\] \.aichat-menu,:root\[data-ui-motion="reduced"\] \.aichat-bar\{animation:none\}/,
    "应用内的「减少动效」开关与系统开关同级，也要停");
}

/* ───────── 发送永远要有回音（v0.193.0）───────── */

/* 用户的原话是「点了一点反应都没有」。旧实现里未配置模型时 send() 直接 return，界面上一句话都不给，
   只有底部胶囊写着「未配置模型」—— 等于把「没配模型」伪装成「按钮坏了」。现在三条早退路径各给一句话，
   并且把「去配置」做成提示条上的动作；发送键也不再因为未配置而置灰（置灰同样是没反应）。 */
{
  assert.match(mainSrc, /if \(busy\) \{ tide\.notify\("上一条还在回，等它说完再发"\); return; \}/,
    "正在回复时再点发送也要说一句");
  assert.match(mainSrc, /if \(!configured\) \{ tide\.notify\("还没配模型，AI 没法回答", \{ action: openAiSettings, actionLabel: "去配置", ms: 12000 \}\); return; \}/,
    "未配置模型时点发送必须给提示，并且提示条上直接给「去配置」动作");
  assert.match(mainSrc, /if \(!q\) \{ tide\.notify\("先写点什么，再按发送"\); ui\.input\.focus\(\); return; \}/,
    "空输入也要有回音，别静默 return");
  assert.match(mainSrc, /const openAiSettings = \(\) => window\.dispatchEvent\(new CustomEvent\("tide:open-settings", \{ detail: \{ section: "ai" \} \}\)\);/,
    "「去配置」要真的把设置面板的 AI 分区叫出来");

  assert.match(mainSrc, /ui\.send\.disabled = busy;/, "发送键只在「正在回复」时置灰");
  assert.doesNotMatch(mainSrc, /ui\.send\.disabled = busy \|\| !configured;/,
    "别把 !configured 加回 disabled：置灰等于又回到「点了没反应」");
  assert.match(mainSrc, /ui\.send\.classList\.toggle\("is-blocked", !configured\);/,
    "未配置时用 is-blocked 换色提示，而不是禁用");
  assert.match(mainSrc, /\.aichat-send\.is-blocked\{background:#8d7b97\}/, "换色提示要有样式");
  assert.match(mainSrc, /ui\.input\.placeholder = configured \? "帮我把这周的事理一遍" : "还没配模型 —— 先写也行，点发送会带你去配置";/,
    "未配置时占位词要说明「点了会带你去配置」");
}

/* 行为：同一组提问**不许重建行**（重建会连光块和它的 ResizeObserver 一起扔掉、
   并截断 500ms 的位移动画），换组才重建且要清掉选中态。 */
{
  const makeRow = () => {
    const row = { dataset: {}, _html: "", buttons: [], rebuilds: [] };
    Object.defineProperty(row, "innerHTML", {
      get() { return row._html; },
      set(v) {
        row._html = v;
        row.rebuilds.push(v);
        row.buttons = [...v.matchAll(/data-chip="(\d+)"[^>]*>([^<]*)</g)].map((m) => {
          const cls = new Set();
          return {
            dataset: { chip: m[1] },
            textContent: m[2],
            classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
            setAttribute() {},
            onclick: null,
          };
        });
      },
    });
    row.querySelectorAll = (sel) => (sel === "[data-chip]" ? row.buttons : []);
    return row;
  };

  const row = makeRow();
  const input = { value: "", oninput() {}, focus() {} };
  fx.ui = { shortcuts: row, input, log: { querySelector: () => null } };
  fx.activeChip = -1;
  calls.chipGlow.attach.length = 0;
  calls.chipGlow.sync.length = 0;
  calls.chipGlow.dispose.length = 0;

  fx.paintChips();
  assert.equal(row.buttons.length, fx.CHIPS.length, "首屏要长出一整组提问");
  assert.equal(row.buttons[0].textContent, fx.CHIPS[0].label, "按钮文案就是提问标签");
  assert.equal(row.rebuilds.length, 1, "首屏建一次");
  assert.equal(calls.chipGlow.attach.length, 1, "首屏要挂一次选中光");
  assert.equal(calls.chipGlow.attach[0].options.selector, "button.on", "定位口径要传下去");

  fx.paintChips();
  assert.equal(row.rebuilds.length, 1, "提问组没变时不许重建行 —— innerHTML 一换，光块就成孤儿");
  assert.equal(calls.chipGlow.attach.length, 1, "没重建就不该重挂光块");
  assert.equal(calls.chipGlow.sync.length, 1, "只切 .on 之后要 sync，让光块滑到新选项");

  row.buttons[3].onclick();
  assert.equal(fx.activeChip, 3, "点哪一项就要记住哪一项");
  assert.ok(row.buttons[3].classList.contains("on"), "被点的那一项要亮起来");
  assert.ok(row.buttons.filter((b) => b.classList.contains("on")).length === 1, "选中态只能有一个");
  assert.equal(input.value, fx.CHIPS[3].ask, "点快捷提问要把它的问题填进输入框");
  assert.equal(calls.chipGlow.sync.length, 2, "换选项要再 sync 一次");

  fx.withContext = false;            // 关掉「带本机数据」→ 整组提问换掉
  fx.paintChips();
  assert.equal(row.rebuilds.length, 2, "提问组变了就要重建");
  assert.equal(row.buttons[0].textContent, fx.CHIPS_BLANK[0].label, "换掉的是一整组通用提问");
  assert.equal(fx.activeChip, -1, "换了组，旧下标指向的不是同一句话了，选中态必须清掉");
  assert.equal(row.buttons.filter((b) => b.classList.contains("on")).length, 0, "重建后不许有残留选中态");
  assert.equal(calls.chipGlow.dispose.length, 1, "重挂前必须先撤掉旧光块");
  assert.equal(calls.chipGlow.attach.length, 2, "重建后要重挂一次");

  fx.withContext = true;
  fx.ui = null;
}

/* ───────── 「头像与名称」是一块居中弹窗 + 背后蒙版（v0.200.0）───────── */

/* 用户原话：「这个窗口弹出放在中间背后界面蒙版」。改前它是对话面里一张 in-flow 的卡
   （.aichat-id{flex:none;…} 直接排在消息流后面），而那块 .aichat-backdrop 是「空气蒙版」——
   只有 visibility/pointer-events，没有任何底色，所以打开它也看不出「有东西浮起来了」。 */
{
  // ① 弹窗本体：居中定位 + 开合两向动画 + 收起时留在 DOM 里
  const idCss = mainSrc.slice(mainSrc.indexOf(".aichat-id{position:absolute"), mainSrc.indexOf(".aichat-id:focus"));
  assert.ok(idCss.length > 0, "弹窗要有一条「居中 + 开合」的规则（.aichat-id{position:absolute…）");
  assert.match(idCss, /left:50%;top:50%;/, "必须真的居中：left/top 各 50%");
  assert.match(idCss, /transform:translate\(-50%,-50%\) scale\(\.92\)/, "收起态是「缩到 92% 且保持居中偏移」，跟侧栏同一套手感");
  assert.match(idCss, /\.id-open \.aichat-id\{[^}]*transform:translate\(-50%,-50%\) scale\(1\)/, "展开态回到 100% —— 居中偏移不能丢，丢了它就跑到右下角去");
  assert.match(idCss, /\.id-open \.aichat-id\{[^}]*visibility:visible;pointer-events:auto/, "展开才可见可点");
  assert.match(idCss, /transition:opacity 180ms ease-in,transform 220ms ease-in,visibility 0s 220ms/, "收起：先播透明/缩放，过渡走完才真正隐藏");
  assert.match(idCss, /\.id-open \.aichat-id\{[^}]*transition:opacity 220ms[^}]*transform 320ms cubic-bezier\(\.34,1\.4,\.64,1\),visibility 0s\}/, "展开要有回弹，且立刻可见（可见性不能有延迟）");
  assert.doesNotMatch(idCss, /display:none/, "不许用 display:none 收 —— 那样收起动画根本播不出来（铁律七）");

  // ② 位置口径：absolute 而不是 fixed。fixed 会跳出宿主 .view 的安全区（铁律四）
  assert.match(idCss, /\.aichat-id\{position:absolute;/, "用 absolute：包含块是 .aichat 的 padding box，天然落在宿主安全区里");
  assert.doesNotMatch(idCss, /\.aichat-id\{position:fixed/, "别换 fixed：那会跳出 .view 的四条安全边，得自己补 --sat/--sab");

  // ③ 蒙版：必须真的暗下去，而且盖得住 z-index:6 的汉堡键
  assert.match(mainSrc, /\.aichat-backdrop\{position:absolute;inset:0;z-index:4;background:#1c13286b;backdrop-filter:blur\(3px\)/,
    "蒙版要有底色和轻微模糊 —— 只有 pointer-events 的是一层看不见的空气");
  assert.match(mainSrc, /\.sidebar-open \.aichat-backdrop,\.id-open \.aichat-backdrop\{opacity:1;visibility:visible;pointer-events:auto/,
    "侧栏与弹窗共用同一块蒙版，两种状态都要亮起来");
  assert.match(mainSrc, /\.id-open \.aichat-backdrop\{z-index:7\}/,
    "弹窗开着时蒙版要压过 z-index:6 的汉堡键，否则背后那颗还点得着");
  assert.doesNotMatch(mainSrc, /\.aichat-backdrop\{[^}]*transition:visibility 0s 220ms\}/,
    "别退回「只切 visibility」的老写法：那样蒙版不会淡入，弹出瞬间背景直接跳黑");

  // ④ 结构：dialog 语义 + 自己的关闭键 + 收起的弹窗进不了 Tab 序
  assert.match(mainSrc, /<div class="aichat-id" id="aichat-id-panel" role="dialog" aria-modal="true" aria-label="头像与名称" aria-hidden="true" tabindex="-1" inert>/,
    "弹窗要有 dialog 语义 + inert 兜底（脚本没跑起来时也不该能 Tab 进去）");
  assert.match(mainSrc, /class="aichat-id-close" data-id-close aria-label="关闭头像与名称"/,
    "弹窗要有自己的关闭键 —— 蒙版和 Esc 都是隐式出口，不能只有隐式的");
  assert.match(mainSrc, /<div class="aichat-id-head"><b>头像与名称<\/b>/,
    "弹窗要有标题，否则用户不知道这块浮层是什么");
  assert.doesNotMatch(mainSrc, /<div class="aichat-id" hidden>/,
    "不能再靠 hidden 开合：hidden 会顺手把过渡一起砍掉，也把「收起留内容」搞没");
  assert.doesNotMatch(mainSrc, /\.aichat-id\{flex:none;/, "它已经不是对话流里的一张卡了，flex:none 得去掉");

  // ⑤ 交互：Esc 只关最上面那层、背后那层 inert、焦点要还回触发按钮
  assert.match(mainSrc, /const top = thinkOpen \? \(\) => setThinkMenu\(false, true\)\s*\n\s*: idOpen \? closeId : sidebarOpen \? \(\) => setSidebar\(false, true\) : null;/,
    "Esc 一次只关最上面那一层：下拉栏最轻、弹窗在上、侧栏在下");
  assert.match(mainSrc, /const setBehindInert = \(on\) => \{[\s\S]{0,420}child\.inert = child === sidebar \? !sidebarOpen : false;/,
    "恢复 inert 时要看侧栏自己的状态 —— 一把清成 false 会让收起的侧栏变成 Tab 得到却看不见的幽灵");
  assert.match(mainSrc, /if \(child === idPanel \|\| child === backdrop \|\| child === ctxMenu\) return;/,
    "蒙版不能一起 inert 掉：它是「点一下关掉」的落点；右键菜单自己管 inert（v0.235.0）");
  assert.match(mainSrc, /idReturnTo = from === ui\.idBtn \? menu : from;/,
    "从侧栏点开的，焦点要回汉堡键（侧栏已随弹窗一起收起）");
  assert.match(mainSrc, /backdrop\.onclick = \(\) => \{ if \(idOpen\) setIdOpen\(false\); else setSidebar\(false, true\); \}/,
    "点蒙版 = 关掉最上面那层");
  assert.match(mainSrc, /if \(open && sidebarOpen\) setSidebar\(false\);/, "一次只开一个浮层：蒙版只有一块，两个一起开会打架");
  assert.match(mainSrc, /ui\.idBtn\.setAttribute\("aria-expanded", String\(open\)\);/, "触发按钮要维护 aria-expanded");
  assert.match(mainSrc, /personalize\.onclick = \(\) => toggleId\(personalize\);/,
    "输入区那颗 👤 走同一套开合 —— 别一处弹窗、一处又切回显示/隐藏");
  assert.match(mainSrc, /ui\.closeId = closeId;/, "换会话时要把弹窗一起收掉（startSession 里调）");
  assert.match(mainSrc, /\.aichat-sidebar,\.aichat-id,\.aichat-backdrop,[\s\S]{0,240}\{transition:none\}/,
    "减少动效时开合要变成瞬切（白名单后面又接了新控件，所以容差放到 240 —— 关键是被列的类与 {transition:none} 之间不能夹别的规则）");
}

/* ───────── 生成式界面：模型能在正文里画组件（dsh-ui 围栏，v0.201.0）───────── */

/* 参考 dsh-genui：模型另起一个 ```dsh-ui 代码块，块里是一份 JSON 规格，界面把它画成真组件
   （截图里那张深色验收报告就是三段式：红框结论卡 + 对比表 + ✅ 清单）。
   沙箱里只有 tide.* 与 document，没有 React / echarts / mermaid / three，所以只复刻
   「原生 DOM + CSS 画得准」的那些，其余降级成代码块 —— 信息不丢，也不引任何外部依赖。 */
{
  // ① 围栏摘除：位置要保住。摘完不是堆到气泡末尾，而是原地换一个占位符
  const raw = "先说结论。\n```dsh-ui\n"
    + '{"title":"三处不一致","gap":16,"items":[{"type":"callout","tone":"error","title":"硬伤","content":"公式写反了"}]}'
    + "\n```\n后面还有一句依据。";
  const one = fx.splitGenui(raw);
  assert.equal(one.blocks.length, 1, "一个 dsh-ui 围栏要摘出一份规格");
  assert.equal(one.blocks[0].title, "三处不一致");
  assert.equal(one.blocks[0].gap, 16, "gap 用规格里的值（4–28 之外会被夹回来）");
  const mark = `${fx.GENUI_MARK}GUI0${fx.GENUI_MARK}`;
  assert.ok(one.body.includes(mark), "正文里要留占位符 —— 位置才算保住");
  assert.ok(one.body.startsWith("先说结论。"), "围栏前面的正文不动");
  assert.equal(one.body.indexOf("后面还有一句依据"), one.body.length - 9, "围栏后面的正文要留在围栏后面");

  // ② 容错：模型写 JSON 的两处手滑（尾随逗号、围栏外多一句）都容忍；真坏的不硬修
  assert.ok(fx.parseGenui('{"title":"t","items":[{"type":"text","content":"a"}],}\n上面是规格'), "尾随逗号 + 围栏外多一句解释要容忍");
  assert.equal(fx.parseGenui('{"title":"t","items":[]}'), null, "items 空 = 没东西可画，算坏规格");
  assert.equal(fx.parseGenui('[{"type":"text","content":"a"}]'), null, "根必须是对象，数组根不认");
  assert.equal(fx.parseGenui("{items: [}"), null, "坏 JSON 不抛异常，安静返回 null");
  assert.equal(fx.parseGenui('{"title":"t"}'), null, "没有 items / children 就不是规格");
  const bad = "结论。\n```dsh-ui\n{items: [}\n```";
  const kept = fx.splitGenui(bad);
  assert.equal(kept.blocks.length, 0, "坏规格不摘");
  assert.equal(kept.body, bad, "摘不掉就原样留着 —— 一段读不懂的围栏也比凭空消失强");

  // ③ 与建议块共存：先摘围栏，再在剩余正文里从后往前找建议块
  const both = fx.parseReply("结论在这。\n```dsh-ui\n"
    + '{"title":"对比","items":[{"type":"table","columns":["A"],"rows":[["1"]]}]}'
    + "\n```\n说明。\n```json\n"
    + '{"suggestions":[{"action":"create-task","title":"复盘"}]}'
    + "\n```");
  assert.equal(both.genui.length, 1, "围栏照摘");
  assert.equal(both.suggestions.length, 1, "建议块照认");
  assert.equal(both.suggestions[0].title, "复盘");
  assert.ok(both.body.includes(mark), "围栏在同一位置留占位符");
  assert.ok(both.body.includes("说明。"), "围栏与建议块之间的正文要保留");
  assert.ok(!both.body.includes("```"), "建议块连它后面的内容一起切掉");
  assert.ok(!both.body.includes('"columns"'), "规格不能以 JSON 原文再出现在正文里");
  const specOnly = fx.parseReply('```dsh-ui\n{"title":"t","items":[{"type":"list","items":[{"title":"a"}]}]}\n```');
  assert.equal(specOnly.suggestions.length, 0, "规格不能被当成建议列表");
  assert.equal(specOnly.genui.length, 1, "但它本身要留住");

  // ④ 占位符只是位置标记：发给模型的正文里不能带它
  fx.thread = [{ role: "assistant", text: `结论。\n${mark}\n尾注。`, genui: [{ title: "t", gap: 12, items: [{ type: "text", content: "x" }] }] }];
  const sent = fx.buildMessages();
  assert.ok(!sent.some((m) => String(m.content).includes(fx.GENUI_MARK)), "占位符不能发给模型");
  assert.ok(sent.some((m) => String(m.content).includes("结论。")), "正文照旧要带上去");
  fx.thread = [];

  // ⑤ 三段式渲染：结论卡 + 对比表 + 清单（对着截图那张验收报告）
  const spec3 = {
    title: "老实话 3 处不一致",
    gap: 14,
    items: [
      { type: "callout", tone: "error", title: "前两个是硬伤", content: "①纵向公式符号写反 ②迷你图按真实分钟压 ③列序全错" },
      {
        type: "table",
        columns: ["视口(inner)", "断点", "最大 Δx", "最大 Δy"],
        types: ["text", "text", "delta", "delta"],
        rows: [["500×749", "≤620", "-0.0001", "-0.0002"], ["1184×805", ">900", "+0.0001", "-0.0001"]],
      },
      {
        type: "list",
        items: [
          { title: "格子坐标只算一份", desc: "courseCell(c,slotMap) 统一输出 col/row/span" },
          { title: "星期标签跟随列序", desc: ".sem-dow 由 weekOrder() 生成" },
        ],
      },
    ],
  };
  const html = fx.genuiHtml(spec3, {}, "g0");
  assert.match(html, /^<div class="aichat-gui" data-gui-block="g0" style="--gui-gap:14px">/, "外壳带 uid 与间距变量");
  assert.match(html, /<span class="gui-bar-dot">dsh-ui<\/span>/, "有标题就带一枚 dsh-ui 角标");
  assert.match(html, /class="gui-callout error"/, "error 语气 = 红边框结论卡（截图里那张红框卡）");
  assert.match(html, /<b>前两个是硬伤<\/b>/, "结论卡要有自己的标题");
  assert.match(html, /<thead><tr><th>视口\(inner\)<\/th>/, "表头按 columns 出");
  assert.match(html, /<span class="gui-delta down">-0\.0001<\/span>/, "负偏差标红（down）");
  assert.match(html, /<span class="gui-delta up">\+0\.0001<\/span>/, "正偏差标绿（up）");
  assert.match(html, /<ul class="gui-list rail">/, "清单默认带左侧竖线（rail）");
  assert.match(html, /<b>格子坐标只算一份<\/b><span>courseCell\(c,slotMap\) 统一输出 col\/row\/span<\/span>/, "清单每条 = 标题 + 说明");
  assert.match(fx.genuiHtml({ items: [{ type: "list", items: [{ icon: "✅", title: "已通过" }] }] }, {}, "g2"),
    /<li class="gui-li"><span class="gui-li-i">✅<\/span><div class="gui-li-b"><b>已通过<\/b><\/div><\/li>/, "清单条目可以带图标（截图里的 ✅）");
  assert.equal(fx.genuiHtml({ title: "", gap: 12, items: [{ type: "list", rail: false, items: [{ title: "a" }] }] }, {}, "g1").includes("rail"),
    false, "rail:false 时不画竖线");

  // ⑥ 白名单：未知 type 丢、要外部库的降级成代码块、层级封顶、字符串先转义
  const unknown = fx.genuiHtml({ title: "", gap: 12, items: [{ type: "unknown-widget", content: "不该透出来的内容" }] }, {}, "g2");
  assert.ok(!unknown.includes("不该透出来的内容"), "不认识的 type 直接丢，内容也不透出来");
  const heavy = fx.genuiHtml({ title: "", gap: 12, items: [{ type: "mermaid", code: "graph TD; A-->B" }] }, {}, "g3");
  assert.match(heavy, /<pre class="gui-code" data-lang="mermaid"><code>graph TD; A--&gt;B<\/code><\/pre>/, "mermaid / echarts 这类降级成代码块");
  const evil = fx.genuiHtml({ title: "", gap: 12, items: [{ type: "text", content: '<img src=x onerror="alert(1)">' }] }, {}, "g4");
  assert.ok(!evil.includes("<img"), "模型吐 HTML 也执行不了");
  assert.ok(evil.includes("&lt;img"), "先转义再内联排版");
  assert.equal(fx.GENUI_MAX_NODES, 200, "节点封顶 200（与 dsh-genui 同口径）");
  assert.equal(fx.GENUI_MAX_DEPTH, 8, "层级封顶 8");
  let deep = { type: "text", content: "最深处那句话" };
  for (let i = 0; i < 10; i += 1) deep = { type: "col", items: [deep] };
  assert.ok(!fx.genuiHtml({ title: "", gap: 12, items: [deep] }, {}, "g5").includes("最深处那句话"),
    "超过 8 层的节点要被截断，不许无限展开");

  // ⑦ 围栏里的小富文本与图表：链接只认 http(s)，图表是内联 SVG（不引库）
  const inline = fx.giInline("**粗** ==亮== `码` [文档](https://example.com/a) [坏](javascript:alert(1))");
  assert.match(inline, /<strong>粗<\/strong>/);
  assert.match(inline, /<mark>亮<\/mark>/);
  assert.match(inline, /<code>码<\/code>/);
  assert.match(inline, /<a class="gui-link" href="https:\/\/example\.com\/a" target="_blank" rel="noreferrer noopener">文档<\/a>/);
  assert.doesNotMatch(inline, /<a [^>]*href="javascript/, "只认 http(s)，javascript: 原样当文字");
  const donut = fx.genuiHtml({ title: "", gap: 12, items: [{ type: "chart", kind: "donut", data: [{ label: "完成", value: 3 }, { label: "未完成", value: 1 }] }] }, {}, "g6");
  assert.match(donut, /<div class="gui-donut">/);
  assert.match(donut, /<svg viewBox="0 0 36 36"/, "环形图是内联 SVG");
  assert.match(donut, /class="sg0"/, "扇区按调色板取色（与图例一一对应）");
  assert.match(donut, /<div class="gui-legend">/, "环形图要配图例");
  const bars = fx.genuiHtml({ title: "", gap: 12, items: [{ type: "chart", data: [{ label: "一", value: 1 }, { label: "二", value: 2 }] }] }, {}, "g7");
  assert.match(bars, /<svg viewBox="0 0 320 96"/, "柱状/折线也是内联 SVG，不引 echarts");

  // ⑧ 接线（静态）：正文走 bodyHtml、交互挂 wireGenui、占位符不进请求、提示词有第 ⑧ 条
  assert.match(mainSrc, /: bodyHtml\(m\);/, "气泡正文走 bodyHtml（文本段与组件段按原顺序拼）");
  assert.match(mainSrc, /wireGenui\(box, m\);/, "每条消息渲染完都要挂上组件交互");
  assert.match(mainSrc, /replace\(\/\\u0001GUI\\d\+\\u0001\/g, ""\)/, "发给模型前要抹掉占位符");
  assert.match(mainSrc, /const \{ body: stripped, blocks \} = splitGenui\(text\);/, "parseReply 必须先摘围栏");
  assert.match(mainSrc, /genui: parsed\.genui && parsed\.genui\.length \? parsed\.genui : undefined/, "规格跟着助手消息落盘");
  assert.match(mainSrc, /"⑧ 遇到这四种情况/, "提示词要教模型什么时候改用围栏");
  assert.match(mainSrc, /dsh-ui 代码块/, "提示词要写出围栏的语言名");

  // ⑨ 样式：结论卡语气、间距变量、深色适配、宽表横向滚动、折叠两向动画（铁律七）
  assert.match(mainSrc, /\.gui-callout\.error\{border-color:#F09C9366;border-left-color:#F09C93/, "error 语气 = 红边框 + 红左条");
  assert.match(mainSrc, /\.aichat-gui\{display:flex;flex-direction:column;gap:var\(--gui-gap,12px\)/, "组件之间用规格里的间距");
  assert.match(mainSrc, /\.aichat-gui\{[^}]*--gui-1:#8FD0E0/, "图表色板用亮版");
  assert.doesNotMatch(mainSrc, /\[data-theme-mode="dark"\] \.gui-/, "组件色板不许挂在 data-theme-mode 上：这个视图的外壳恒为深底，浅色宿主下会拿到一套压不住深底的颜色");
  assert.doesNotMatch(mainSrc, /\[data-theme="night"\]/, "深色分支只认 data-theme-mode，不许按主题名写（铁律二）");
  assert.match(mainSrc, /\.gui-tablewrap\{[^}]*overflow-x:auto/, "宽表横向滚动，别撑破气泡");
  assert.match(mainSrc, /\.gui-acc-b\{display:grid;grid-template-rows:0fr;transition:grid-template-rows 260ms/, "折叠容器要能连续插值");
  assert.match(mainSrc, /\.gui-acc-one\.open \.gui-acc-b\{grid-template-rows:1fr\}/, "展开到 1fr —— 收起也有中间帧");
  assert.doesNotMatch(mainSrc, /\.gui-acc[a-z-]*\{[^}]*display:none/, "折叠不能靠 display:none（铁律七）");
  assert.match(mainSrc, /@media \(prefers-reduced-motion:reduce\)\{\.gui-acc-h i,\.gui-acc-b,\.gui-acc-in/, "减少动效时折叠变瞬切");
  assert.match(mainSrc, /@media \(max-width:640px\)\{\.gui-table th,\.gui-table td\{padding:5px 6px/, "窄屏收窄表格内边距");
}

/* ───────── 对话侧边栏 / 会话右键菜单 / 回答卡片（v0.235.0）─────────
   四条用户诉求：
   ①「ai对话上面还可以再窄一点，让对话能看到更多地方」→ .aichat 自己的上下内边距与左右上限再收一轮
   ②「添加对话侧边栏」→ 够宽时侧栏是对话面左边的一整列（.aichat.side-docked），窄屏退回抽屉
   ③「右键对话题可改名、删除或归档」→ 会话级右键菜单 + 侧栏里的「已归档」分组
   ④「给AI的回答内容的多表现为对话卡片，颜色多样化一些」→ cardHtml() 按空行切卡、按内容哈希上色
   卡片的装帧全在新的 cardHtml() 里 —— md() 一个字没动（它的精确输出是上面那批断言钉死的）。 */
{
  // ① 更窄的顶部：减的是对话面自己的边距，不是内容宽度（v0.243.0 起左右也走 --pad-x）
  assert.match(mainSrc, /padding:10px var\(--pad-x\) 12px;/, "上下边距 10px/12px、左右走 --pad-x");
  assert.doesNotMatch(mainSrc, /padding:26px clamp\(22px,9%,100px\)/, "别退回 26px/100px 那套旧口径");

  // ② 常驻侧栏：同一块 DOM 两态切换，列宽 --side-w ↔ 0px 插值（不是两套侧栏、也不是 display:none）
  assert.match(mainSrc, /\.aichat\.side-docked\{grid-template-columns:var\(--side-w\) minmax\(0,1fr\)/,
    "常驻态的第一列跟着 --side-w 走：默认 260px，用户拖过的值以内存变量写回 root");
  assert.match(mainSrc, /--side-w:260px/, "未自定义时列宽必须还是 260px");
  assert.match(mainSrc, /\.aichat\.side-docked:not\(\.sidebar-open\)\{grid-template-columns:0px minmax\(0,1fr\)\}/,
    "收起要用 0px 轨道插值，才能有中间帧且不退化成删列");
  assert.doesNotMatch(mainSrc, /\.aichat\.side-docked \.aichat-sidebar\{[^}]*display:none/,
    "常驻侧栏收起不许用 display:none（要靠 0px 轨道 + overflow-x 裁切）");
  assert.match(mainSrc, /\.aichat\.side-docked \.aichat-sidebar\{[^}]*overflow-x:clip/,
    "内层固定 236px、外层裁切：不然收起过程中文字会一路重排");
  assert.match(mainSrc, /\.aichat\.side-docked \.aichat-backdrop\{opacity:0;visibility:hidden;pointer-events:none\}/,
    "常驻侧栏不是浮层，不该把对话面压暗");
  assert.match(mainSrc, /\.aichat\.side-docked \.aichat-sidebar-in\{width:calc\(var\(--side-w\) - 24px\);flex:none\}/,
    "内层跟着列宽走（减掉左右各 12px 内边距）靠外层裁切，而不是让文字一路重排（重排会抽动）");
  assert.match(mainSrc, /const dockQuery = window\.matchMedia\("\(min-width:860px\)"\)/,
    "断点只判一次宽度；用 matchMedia 而不是视口尺寸属性");
  assert.match(mainSrc, /if \(docked && !was && !sidebarOpen\) setSidebar\(true\)/, "首次进宽屏侧栏要直接摊开");
  assert.match(mainSrc, /if \(!docked && sidebarOpen\) setSidebar\(false\)/, "回到窄屏要收回抽屉，别压住对话");
  assert.match(mainSrc, /ui\.closeSidebar = \(\) => \{ if \(!root\.classList\.contains\("side-docked"\)\) setSidebar\(false\); \}/,
    "常驻态下换会话不许把侧栏一起收掉 —— 用户刚就是从那一列里点的");
  assert.match(mainSrc, /@media \(prefers-reduced-motion:reduce\)\{\.aichat\.side-docked,\.aichat\.side-docked \.aichat-sidebar\{transition:none\}\}/,
    "列宽插值同样归减少动效管");
  assert.match(mainSrc, /\.aichat\{display:grid;grid-template-columns:minmax\(0,1fr\);grid-template-rows:auto minmax\(0,1fr\) auto auto;grid-template-areas:"head" "flow" "bar" "quick"\}/,
    "四段各自成行必须靠 grid 命名区域，flex 列做不到「侧栏跨满整高、其余四段仍在右侧」");
  assert.match(mainSrc, /\.aichat-head\{grid-area:head\}\.aichat-flow\{grid-area:flow\}\.aichat-bar\{grid-area:bar\}\.aichat-shortcuts\{grid-area:quick\}/,
    "四段的名字要真的落到 grid-area 上");

  /* ①′ 侧栏宽度可拖（v0.243.0，用户原话「宽度可以自由拖动、拉长或拉大」）：
     拖拽条只在「常驻 + 展开」时出现，写内联 --side-w，落盘值单独过闸门。 */
  assert.match(mainSrc, /<button type="button" class="aichat-rail-resizer" role="separator" aria-orientation="vertical"/,
    "拖拽条要是可聚焦的 separator（键盘 ←/→ 才能微调）");
  assert.match(mainSrc, /\.aichat-rail-resizer\{display:none\}/,
    "默认不出现：抽屉态第一列是 0px，条会贴到左内边距上");
  assert.match(mainSrc, /\.aichat\.side-docked\.sidebar-open \.aichat-rail-resizer\{display:grid;[^}]*left:calc\(var\(--pad-x\) \+ var\(--side-w\) - 8px\)/,
    "只在常驻展开态出现，且用与列宽同一个变量定位 —— 写死像素拖完就错位");
  assert.match(mainSrc, /\.aichat\.rail-dragging\{transition:none\}/,
    "拖动期间必须关掉列宽插值，否则条一直追不上指针");
  assert.match(mainSrc, /root\.style\.setProperty\("--side-w", `\$\{v\}px`\)/,
    "宽度出口只有一个：内联写 root 的 --side-w");
  assert.match(mainSrc, /railScale = \(\) => \{[\s\S]{0,220}?getBoundingClientRect\(\)\.width \|\| layout\) \/ layout/,
    "位移要除过「视觉 px ÷ 布局 px」的缩放比，UI 缩放下才跟手");
  assert.match(mainSrc, /if \(persist\) \{[\s\S]{0,120}?tide\.storage\.set\(RAIL_W_KEY, v\)/,
    "落盘只在抬起 / 键盘改动时写，pointermove 每帧写会把存储刷爆");
  assert.match(mainSrc, /railWidth = normalizeRailW\(await tide\.storage\.get\(RAIL_W_KEY, null\)\)/,
    "存储值必须过落盘闸门（脏数据 → null 回默认）");
  assert.match(mainSrc, /function clampRailW\(raw, containerW\)/,
    "实时夹取与落盘闸门分开：拖动中的 0 / 负数只是「拖过头」，不该被当脏数据拒收");
  assert.match(mainSrc, /resizer\.addEventListener\("dblclick", \(event\) => \{ event\.preventDefault\(\); resetRailW\(\); \}\)/,
    "双击恢复默认宽度");

  // ③ 会话右键菜单：absolute（包含块是 .aichat 的 padding box，天然落在宿主安全区内）
  assert.match(mainSrc, /<div class="aichat-ctx" id="aichat-ctx" role="menu" aria-label="对话操作" aria-hidden="true" inert>/,
    "菜单要有 role/aria，且初始 inert + aria-hidden");
  for (const act of ["rename", "archive", "remove"]) {
    assert.ok(mainSrc.includes(`data-ctx-act="${act}"`), `右键菜单要有 ${act} 这一项`);
  }
  assert.match(mainSrc, /\.aichat-ctx\{position:absolute;/, "菜单用 absolute，不用视口级浮层");
  assert.match(mainSrc, /const box = root\.getBoundingClientRect\(\);/,
    "坐标按 .aichat 的矩形夹取 —— 夹住就既不出框，也不用自己读安全区变量");
  assert.match(mainSrc, /ui\.sessionList\.addEventListener\("contextmenu"/,
    "右键挂在列表容器上（卡片是 innerHTML 整批重建的，逐张挂会漏）");
  assert.match(mainSrc, /input\.className = "aichat-session-edit"/, "改名是就地换输入框，不再多弹一层窗");
  assert.match(mainSrc, /input\.onblur = \(\) => settle\(true\);/, "失焦即提交，别让改动卡在半路");
  assert.match(mainSrc, /if \(!\(save && next && renameSession\(id, next\)\)\) paintSessions\(\);/,
    "改名没真的生效时要补一次重画，否则那行永远停在输入框上");
  assert.match(mainSrc, /input\.aichat-session-edit[\s\S]{0,400}?background:#2b243b!important/,
    "改名输入框要压住宿主那条带 !important 的通用 input 规则（否则深色侧栏里出现白框）");
  assert.match(mainSrc, /if \(ctxMenu\.contains\(event\.target\)\) return;/, "点别处要收起菜单");
  assert.match(mainSrc, /ui\.sessionList\.addEventListener\("scroll", \(\) => closeCtx\(\)\);/,
    "列表一滚，卡片位置就变了，菜单必须收起来");
  assert.match(mainSrc, /const ctxMenu = root\.querySelector\("\.aichat-ctx"\);/, "菜单必须从 root 里取（整棵重建）");
  assert.match(mainSrc, /if \(child === idPanel \|\| child === backdrop \|\| child === ctxMenu\) return;/,
    "菜单自己管 inert，别被弹窗那套一把清成 false（那会留下 Tab 得到却看不见的幽灵）");
  assert.match(mainSrc, /if \(ctxMenu\.classList\.contains\("open"\)\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); closeCtx\(true\); return; \}/,
    "Esc 只关最上面那层：右键菜单排在下拉栏与弹窗之前");

  // 归档分组：0fr ↔ 1fr 两向插值，内容不删只收（铁律七）
  assert.match(mainSrc, /\.aichat-archive-body\{display:grid;grid-template-rows:0fr;transition:grid-template-rows 260ms/,
    "归档分组收起要有中间帧");
  assert.match(mainSrc, /\.aichat-archive\.open \.aichat-archive-body\{grid-template-rows:1fr\}/, "展开插值到 1fr");
  assert.doesNotMatch(mainSrc, /\.aichat-archive[a-z-]*\{[^}]*display:none/, "归档分组不许靠 display:none 收起");
  assert.match(mainSrc, /data-arch-toggle/, "分组头要能点开合");
  assert.match(mainSrc, /if \(s\.archived\) archiveOpen = true;/,
    "刚归档完要把分组展开 —— 卡片凭空消失会被当成删掉了");

  // ④ 回答卡片：切块、上色、可复现
  const one = fx.cardHtml("今天三条都在 23:59 截止，先做实训2。");
  assert.match(one, /^<section class="aichat-card" data-tone="\d">/, "AI 的正文要装成卡片");
  assert.match(one, /<p class="lead">/, "第一块保留结论态");
  const three = fx.cardHtml("先给结论。\n\n依据一：任务积压。\n\n依据二：时段冲突。");
  assert.equal((three.match(/class="aichat-card"/g) || []).length, 3, "按空行切块，一块一张卡");
  assert.equal((three.match(/<p class="lead">/g) || []).length, 1, "只有第一块配叫结论，否则一条回答里冒出好几个大标题");
  assert.equal(fx.cardHtml(""), "", "空正文不产出空卡");
  assert.equal(fx.toneOf("同一段", 0), fx.toneOf("同一段", 0), "同内容同序号必须同色（重绘不闪）");
  assert.notEqual(fx.toneOf("同一段", 0), fx.toneOf("同一段", 1), "相邻两块不能同色");
  assert.ok(fx.CARD_TONES >= 4, "色相至少 4 种");
  for (let t = 0; t < fx.CARD_TONES; t += 1) {
    assert.ok(mainSrc.includes(`.aichat-card[data-tone="${t}"]{--tone:`), `第 ${t} 号色相要有自己的三个变量`);
  }
  assert.match(mainSrc, /\.aichat-card \.lead::before\{display:none\}/, "卡片自带左竖条，结论那条不能再画一根");
  assert.match(mainSrc, /\.aichat-card \.sec\{color:var\(--tone,/,
    "小标题也要跟着卡片色相 —— 这一段是「颜色多样化」里最显眼的那处");
  assert.match(mainSrc, /const paint = \(s\) => \(m\.role === "assistant" \? cardHtml\(s\) : md\(s\)\);/,
    "只有 AI 那侧走卡片，用户自己写的话不必被排版");
  assert.match(mainSrc, /const html = i \? md\(b\)\.replace\('<p class="lead">', "<p>"\) : md\(b\);/,
    "装帧只在外层做：md() 仍旧一段一调，签名与输出都不动");
  assert.equal(fx.cardHtml("- 甲\n- 乙"), `<section class="aichat-card" data-tone="${fx.toneOf("- 甲\n- 乙", 0)}"><ul>\n<li>甲</li>\n<li>乙</li>\n</ul></section>`,
    "装帧只套一层壳，md() 的输出一字不动（它自己的精确输出由上面那批断言钉着）");
}

/* 会话三件事（改名 / 归档 / 删除）改的是 sessions 这份唯一事实源，不是只改 DOM。 */
{
  storage.clear();
  fx.sessions.length = 0;
  fx.startSession();
  const id = fx.sessionId;
  fx.thread.push({ role: "user", text: "原始标题", at: 1 });
  fx.saveThread();
  assert.equal(fx.sessions.find((s) => s.id === id).title, "原始标题", "标题默认取首条提问");

  assert.equal(fx.renameSession(id, "  改过的名字  "), true, "改名要去掉首尾空格");
  assert.equal(fx.sessions.find((s) => s.id === id).title, "改过的名字");
  assert.equal(fx.sessions.find((s) => s.id === id).renamed, true, "改过名的会话要打上标记");
  assert.equal(fx.renameSession(id, "   "), false, "空标题视为放弃，不当无名氏");
  assert.equal(fx.renameSession(id, "改过的名字"), false, "同名不算改动");
  // renamed 标记的用处：saveThread() 每轮对话都会跑，用首条提问当标题的话改名只活到下一次发送
  fx.saveThread();
  assert.equal(fx.sessions.find((s) => s.id === id).title, "改过的名字", "手动改过名的会话不许被首条提问盖回去");
  assert.equal(storage.get("sessions").items.find((s) => s.id === id).title, "改过的名字", "改名要真落盘");

  fx.archiveSession(id);
  assert.equal(fx.sessions.find((s) => s.id === id).archived, true, "归档要落到数据里（侧栏据此分组）");
  fx.archiveSession(id);
  assert.equal(fx.sessions.find((s) => s.id === id).archived, false, "同一项再点一次要能取消归档");

  const keep = fx.sessionId;
  fx.startSession();
  const drop = fx.sessionId;
  fx.thread.push({ role: "user", text: "要被删掉的那条", at: 2 });
  fx.saveThread();
  const before = fx.sessions.length;
  fx.deleteSession(keep);
  assert.equal(fx.sessions.length, before - 1, "删除要真的从 sessions 里摘掉");
  assert.equal(fx.sessionId, drop, "删掉的不是当前会话时，当前会话不能动");
  /* 删掉当前会话：光把 sessionId 挪走不够 —— saveThread() 会按 sessionId 找到「上一个自己」
     把内存里还在的 thread 原样写回，等于删了又活。所以这一条要连着内存状态一起验。 */
  fx.deleteSession(drop);
  assert.equal(fx.sessions.find((s) => s.id === drop), undefined, "删掉的会话不许被 saveThread() 复活");
  assert.equal(fx.thread.length, 0, "当前会话被删后内存里的 thread 要一起清掉");
  assert.equal(fx.draft, "", "草稿同理");
}

/* 删除是唯一不可恢复的动作（改名能再改、归档能取消），所以它必须「点两次」。
   这段逻辑在 render 的接线里跑不到（harness 不驱动整套 DOM 事件），只能守源码 ——
   守的是「第一下不删、第二下才删、关菜单就复位」这三件事都在。 */
{
  assert.match(mainSrc, /if \(act === "remove" && !ctxArm\) \{ armCtx\(true\); return; \}/,
    "删除的第一下只能上膛，不许把 deleteSession() 直接挂在菜单项上");
  assert.match(mainSrc, /const armCtx = \(on\) => \{/, "上膛 / 复位共用一支 armCtx()");
  assert.match(mainSrc, /btn\.textContent = on \? "确认删除" : "删除";/,
    "上膛后按钮文案要变，用户得看得出「这一下没删」");
  assert.match(mainSrc, /\.aichat-ctx button\[data-ctx-act="remove"\]\.armed\{/,
    "上膛态要有自己的样式，不能和 hover 同一层级");
  // 关掉菜单（含点外部、Esc、切会话、重画列表）都要复位，否则下次打开就是「已上膛」
  assert.match(mainSrc, /const closeCtx = \(restoreFocus = false\) => \{[\s\S]{0,200}?if \(ctxArm\) armCtx\(false\);/,
    "closeCtx() 里必须复位上膛态");
  assert.match(mainSrc, /if \(on && ctxAt\) placeCtx\(ctxAt\.x, ctxAt\.y\);/,
    "文案变长会把菜单撑宽，上膛后要按同一个锚点重新夹位置");
}

console.log("PASS: AI 对话插件 —— 权限 / 快照 / 建议写入撤销 / 一轮问答 / 历史迁移 / 会话与草稿隔离 / 思考强度 / 请求保护 / 滑动选中光 / 头像与名称弹窗 / 生成式界面（dsh-ui 围栏） / 对话侧边栏与会话三件事 / 回答卡片");
