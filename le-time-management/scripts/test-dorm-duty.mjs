// 轮换值日：多套轮换的隔离与迁移 + 轮换数学 + 逐组提醒时机 + 双实例自终止。
//
// 插件源码是 IIFE，这里沿用 test-pomodoro.mjs 的手法：vm 里注入 fixture 把内部纯函数
// （cycleStartOf / assigneeFor / snapshot / reminderDue / tick …）暴露出来直接真跑，
// 而不是对着源码猜行为。轮换是「按起始日切段」的数学，用字符串断言守不住边界。
//
// ⚠️ 三条测试自身的坑（都真踩过）：
//   1. 计数器（notified / sounds / started / cleared）必须**每个实例一份**。它们曾经是
//      测试模块级的共享变量，结果前面实例的 boot() 是异步的，等它跑完时会去递增**当前**
//      那一份计数 —— 断言看到 25 个定时器，实际只起了 1 个。
//   2. **boot() 是异步的，会在测试中途把 state 从 storage 重置回去。** 只要测试手动改
//      state（fx.addGroup() 之类），就必须先 `await settle()` 等首刷跑完，否则改动会被
//      稍后完成的 load() 覆盖掉（表现为「函数返回 true 但值没变」，极难看出）。
//   3. 别让首刷的 tick 真的弹通知 —— 它按**真实墙钟**判断「到点没」，测试结果会随运行
//      时刻变化。不测提醒的用例统一用 quietSeed()（关掉提醒）。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 小程序 runtime 是 CommonJS，直接 require 进来**真跑**（不是正则扫源码）。
    两端各写一份复制/导入实现，只有跑起来才比得出语义有没有跑偏。 */
const requireCjs = createRequire(import.meta.url);
const mini = requireCjs(fileURLToPath(new URL('../../miniprogram/core/pluginRuntime.js', import.meta.url)));

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const PLUGIN_SRC = read('../public/plugins/dorm-duty/main.js');
const manifest = JSON.parse(read('../public/plugins/dorm-duty/manifest.json'));

/* ── 一、清单与三端接线 ── */
assert.equal(manifest.id, 'dorm-duty');
assert.equal(manifest.entry, 'main.js');
assert.equal(manifest.order, 13, 'order 决定侧栏位置；改它要同步 catalog');
for (const perm of ['ui', 'tasks', 'storage', 'notify', 'sound']) {
  assert.ok(manifest.permissions.includes(perm), `manifest 必须声明 ${perm} 权限，否则宿主会拒绝调用`);
}
assert.equal(manifest.platforms.windows, 'full');
assert.equal(manifest.platforms.android, 'full', 'Android 与 Windows 共用前端，必须是 full');
// 声明 native 就等于承诺「小程序里点进去有东西」。原生适配是独立实现（纯逻辑在
// miniprogram/core/pluginRuntime.js，页面在 miniprogram/pages/plugin/index.js），
// 所以下面把三处接线逐条钉住 —— 少任何一处，小程序里就是一个空白页或「暂不可用」。
assert.equal(manifest.platforms.miniprogram, 'native', '已做原生适配就必须标 native（标 unavailable 会让小程序显示「暂不可用」）');

const miniRuntime = read('../../miniprogram/core/pluginRuntime.js');
const miniPage = read('../../miniprogram/pages/plugin/index.js');
const miniWxml = read('../../miniprogram/pages/plugin/index.wxml');
assert.match(miniRuntime, /function dormDutySummary\(/, '小程序 runtime 必须提供 dormDutySummary 供页面取视图模型');
assert.match(miniRuntime, /function ddMigrateLegacy\(/, '小程序也要能迁移旧版单套轮换的数据');
assert.match(miniRuntime, /function ddGroups\(/, '小程序要有组列表归一化，否则脏数据会画崩页面');
assert.match(miniPage, /id === "dorm-duty"\) this\.loadDormDuty\(\)/, 'initPlugin 分派必须接上 dorm-duty，否则页面拿不到数据');
assert.match(miniPage, /loadDormDuty\(\) \{/, '页面必须有 loadDormDuty');
assert.match(miniPage, /id === "dorm-duty" && this\.data\.dd\) this\.loadDormDuty\(\)/, 'onShow 必须重算（跨天 / 到点后回到本页）');
assert.match(miniWxml, /id === 'dorm-duty' && dd/, 'WXML 必须有 dorm-duty 分支');
assert.match(miniPage, /"dorm-duty": \[/, '「插件使用说明」必须收录 dorm-duty，否则小程序里查不到用法');
assert.match(miniPage, /name: "生活与工具", ids: \[[^\]]*"dorm-duty"[^\]]*\]/, '说明页分组要与桌面端 plugin-guide 同源');
// 存储键逐字一致 ⇒ 备份导出后跨端恢复不丢数据。这是「三端同源」最容易悄悄破的一环。
for (const key of ['groups', 'activeId']) {
  assert.match(miniRuntime, new RegExp(`pluginStorageGet\\("dorm-duty", "${key}"`),
    `小程序必须用与桌面端同名的存储键 ${key}，否则备份跨端恢复会丢数据`);
}
// 旧键仍要被读一次（迁移用），否则升级上来的人数据全丢
for (const key of ['members', 'config', 'overrides']) {
  assert.match(miniRuntime, new RegExp(`pluginStorageGet\\("dorm-duty", "${key}"`),
    `小程序必须读旧键 ${key} 才能把旧版单套轮换迁移过来`);
}
assert.match(miniRuntime, /c\.sound = String\(c\.sound \|\| "beep"\);/, '小程序保存配置时必须保留桌面端的提示音选择');

const catalog = read('../src/pluginCatalog.js');
assert.match(catalog, /"id": "dorm-duty"/, 'pluginCatalog 必须已同步（跑 node tools/sync-plugins.js）');
assert.match(catalog, new RegExp(`"id": "dorm-duty"[\\s\\S]{0,200}?"version": "${manifest.version.replace(/\./g, '\\.')}"`), 'pluginCatalog 里的版本号必须与 manifest 一致');
assert.match(read('../../miniprogram/core/pluginCatalog.js'), /"id": "dorm-duty"/, '小程序 catalog 也必须同步');

// 图标：三端同源，桌面端与小程序各一份字节一致
const desktopIcon = new URL('../public/icons/plugins/dorm-duty.png', import.meta.url);
const miniIcon = new URL('../../miniprogram/images/plugins/dorm-duty.png', import.meta.url);
assert.ok(fs.existsSync(desktopIcon), '缺少桌面端插件图标 public/icons/plugins/dorm-duty.png');
assert.ok(fs.existsSync(miniIcon), '缺少小程序插件图标 miniprogram/images/plugins/dorm-duty.png');
assert.deepEqual(fs.readFileSync(desktopIcon), fs.readFileSync(miniIcon), '两端图标必须字节一致（由 tools/gen-plugin-icons.py 一次写入）');

// 插件使用说明：新插件必须被收录，否则用户在「插件使用说明」里找不到它
const guide = read('../public/plugins/plugin-guide/main.js');
assert.match(guide, /"dorm-duty"/, '插件使用说明必须收录 dorm-duty');
assert.match(guide, /"dorm-duty":\[/, '插件使用说明必须给出 dorm-duty 的使用步骤');

/* ── 二、源码不变量 ── */
// 深色主题下主色会被提亮，硬编码白字会糊在亮底上（与番茄专注同一条规矩）
assert.ok(!/["']#fff["']/.test(PLUGIN_SRC), '不能硬编码 #fff，配色必须走主题变量');
assert.match(PLUGIN_SRC, /var\(--on-deep/, '主按钮文字必须用 --on-deep 令牌');
assert.ok(!/["']#[0-9a-fA-F]{6}["']/.test(PLUGIN_SRC.replace(/dd-err\{color:#B34747\}/, '')), '除错误色外不该出现硬编码十六进制色值');
assert.match(PLUGIN_SRC, /tide\.ui\.registerView\(\{ id: VIEW_ID, title: "轮换值日", icon: "broom", render \}\)/, '必须注册视图，icon 走 FA 名');
assert.match(PLUGIN_SRC, /tide\.sound\.presets/, '提示音下拉必须读宿主音效目录，而不是自带一份列表');
assert.match(PLUGIN_SRC, /Promise\.resolve\(tide\.sound\.presets\(\)\)/, 'presets() 在真宿主里是同步返回数组，但仍应兼容异步实现');
assert.match(PLUGIN_SRC, /Array\.isArray\(list\) \? list : \[\]/, '音效目录形状不对时必须降级为「默认提示音」，不能画崩整页');
// 提醒时刻必须真校验时/分范围，不能只看格式
assert.match(PLUGIN_SRC, /h >= 0 && h <= 23/, '提醒时刻必须校验「时」的范围，否则 25:99 会让提醒静默失效');
assert.match(PLUGIN_SRC, /mi >= 0 && mi <= 59/, '提醒时刻必须校验「分」的范围');
assert.match(PLUGIN_SRC, /state\.gen !== MY_GEN/, '必须有「被新实例顶掉就退出」的守卫，否则停用再启用会双份提醒');
assert.match(PLUGIN_SRC, /navEntryAlive/, '必须有「侧栏入口消失就自终止」的守卫，否则停用后定时器仍在跑');
// 多组相关的源码不变量
assert.match(PLUGIN_SRC, /if \(!confirmFn\(/, '删除一整套轮换必须二次确认，误点不能直接抹掉排班');
assert.ok(!/state\.members\b/.test(PLUGIN_SRC), '成员已经按组存放，不该再有全局 state.members（会串台）');
assert.ok(!/state\.config\b/.test(PLUGIN_SRC), '配置已经按组存放，不该再有全局 state.config');
assert.ok(!/state\.overrides\b/.test(PLUGIN_SRC), '换人记录已经按组存放，不该再有全局 state.overrides');
// 「已换人 · 原 X」里的 X 必须是正常排班本该当班的那批人，不是替补
assert.match(PLUGIN_SRC, /已换人 · 原 \$\{esc\(normalNames\)/, '「已换人 · 原 X」必须显示原排班的名单，别把替补当成「原」');
// 多人值日的关键写法：滑动窗口切片 + override 双格式（单人字符串 / 多人数组）
assert.match(PLUGIN_SRC, /function normalAssignees\(/, '必须有「正常轮换该当班的一批人」纯函数（perRound 切片）');
assert.match(PLUGIN_SRC, /Array\.isArray\(v\) \? v : \(v \? \[v\] : \[\]\)/, 'override 必须兼容双格式（单人字符串 / 多人数组）');
assert.match(PLUGIN_SRC, /members\.length === 1 \? members\[0\]\.id : members\.map\(\(m\) => m\.id\)/, '单人换人必须写字符串（旧版本客户端还能读），多人才写数组');

/* ── 三、真跑用的沙箱 ── */
function fakeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [], dataset: {}, id: '', className: '', textContent: '',
    hidden: false, disabled: false, checked: false, value: '',
    isConnected: true,
    style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() { return ''; } },
    append: (...n) => { node.children.push(...n); },
    appendChild: (n) => { node.children.push(n); return n; },
    replaceChildren: (...n) => { node.children = [...n]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => undefined,
    scrollIntoView() {}, focus() {},
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html || ''; },
    set(v) { node._html = String(v); },
  });
  return node;
}

/** 起一个插件实例。seed 直接写进 storage（插件 load() 从那里读），today 控制 tide.util.today()。
    每个实例自带一份 counters，互不干扰。withWindow=false 模拟没有 window 的环境（单测/SSR）。 */
function bootPlugin({ seed = {}, today = '2026-09-17', navAlive = true, clock = null, tasks = [], confirm = true, withWindow = true } = {}) {
  const c = { notified: [], sounds: [], intervalFn: null, started: 0, cleared: 0, created: [] };
  const storage = new Map(Object.entries(seed));
  let todayNow = today;
  const ctx = {
    console,
    setInterval: (fn) => { c.intervalFn = fn; c.started++; return 1; },
    clearInterval: () => { c.cleared++; },
    setTimeout, clearTimeout,
    document: {
      head: fakeEl('head'),
      createElement: fakeEl,
      createTextNode: (t) => ({ textContent: t }),
      getElementById: () => null,
      // navEntryAlive 用它判断「插件是否已被停用」：navAlive=false 模拟侧栏入口消失
      querySelector: (sel) => (String(sel).includes('nav') ? (navAlive ? { querySelector: () => ({}) } : { querySelector: () => null }) : null),
      addEventListener() {}, removeEventListener() {},
    },
    tide: {
      storage: {
        async get(k, fallback = null) { return storage.has(k) ? storage.get(k) : fallback; },
        async set(k, v) { storage.set(k, v); },
      },
      tasks: {
        list: () => tasks,
        create: (patch) => { const t = { id: 't' + (c.created.length + 1), ...patch }; c.created.push(t); return t; },
      },
      notify: (msg) => c.notified.push(String(msg)),
      sound: {
        presets: () => [{ id: 'beep', label: '清脆提示' }, { id: 'chime', label: '三音铃' }],
        play: (opts) => { c.sounds.push(opts && opts.sound); return Promise.resolve('builtin'); },
      },
      events: { emit() {}, on() {} },
      ui: { registerView: (d) => { ctx.__view = d; } },
      util: {
        today: () => todayNow,
        addDays: (s, n) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); },
        navigate: () => {},
      },
    },
  };
  if (withWindow) ctx.window = { confirm: () => confirm };
  if (clock) ctx.Date = clock;
  vm.createContext(ctx);
  // 注入 fixture：把 IIFE 内部的纯函数与 state 暴露出来
  vm.runInContext(
    PLUGIN_SRC.replace(
      '  tide.ui.registerView({ id: VIEW_ID,',
      '  globalThis.__fx = { state, load, save, tick, stopTimer, snapshot, GROUP_MAX, NAME_MAX, MEMBER_MAX, confirmFn,\n'
      + '    defaultGroup, normalizeGroup, normalizeGroups, migrateLegacy, addTodayTask,\n'
      + '    cycleStartOf, assigneeFor, assigneesFor, cycleIndexAt, overrideHit, overrideHits, normalAssignees,\n'
      + '    isCycleStartDay, reminderDue, periodOf, perRoundOf, locationAt, locationsHtml,\n'
      + '    nextBigText, render, heroHtml, rowsHtml, groupChipsHtml, swapHtml, rulesHtml, setActiveGroup, addGroup, removeGroup, renameGroup,\n'
      + '    duplicateGroup, importMembers, tabMenuHtml,\n'
      + '    get tabMenu() { return tabMenu; }, set tabMenu(v) { tabMenu = v; },\n'
      + '    get MY_GEN() { return MY_GEN; }, set MY_GEN(v) { MY_GEN = v; } };\n'
      + '  tide.ui.registerView({ id: VIEW_ID,'
    ),
    ctx,
  );
  return { ctx, fx: ctx.__fx, storage, view: ctx.__view, c, setToday: (v) => { todayNow = v; } };
}
/** 等插件的 boot()（异步读 storage + 首次 tick）跑完。测试要改 state 前必须先等它。 */
const settle = () => new Promise((r) => setTimeout(r, 15));

const MEMBERS = [{ id: 'mA', name: '阿青' }, { id: 'mB', name: '小北' }, { id: 'mC', name: '老陈' }];
/** 一套轮换的种子数据（新版结构：字段平铺在组上）。 */
const GROUP = (patch = {}) => ({
  id: 'g1', name: '值日', startDate: '2026-09-17', periodDays: 7,
  remindEnabled: true, remindTime: '08:00', sound: 'beep',
  members: MEMBERS, removed: [], overrides: {}, lastNotified: '', ...patch,
});
const seed = (patch = {}) => ({ groups: [GROUP()], activeId: 'g1', ...patch });
/** 关掉提醒的种子：不测提醒的用例用它，免得首刷 tick 按真实墙钟弹通知、写 storage。 */
const quietSeed = (patch = {}) => ({ groups: [GROUP({ remindEnabled: false })], activeId: 'g1', ...patch });

/* 3.1 组内字段归一化：坏数据不能把插件变成白屏 */
{
  const { fx } = bootPlugin();
  const bad = fx.normalizeGroup({ name: '   ', startDate: '不是日期', periodDays: 0, remindTime: '25:99', members: '坏了', overrides: '坏了' }, '2026-09-17');
  assert.equal(bad.name, '值日', '空名称必须退回默认「值日」');
  assert.equal(bad.startDate, '2026-09-17', '非法起始日期必须退回今天');
  assert.equal(bad.periodDays, 7, '周期为 0 / 非法时退回默认 7 天（0 是「没填」，不是「每天」）');
  assert.equal(bad.remindTime, '08:00', '非法时刻必须退回 08:00');
  assert.equal(bad.members.length, 0, '成员不是数组时当空处理');
  assert.equal(Object.keys(bad.overrides).length, 0, 'overrides 不是对象时当空处理');
  assert.equal(bad.remindEnabled, true, '提醒默认开启');
  assert.equal(fx.normalizeGroup({ remindEnabled: false }, '2026-09-17').remindEnabled, false, '显式关掉必须保留');
  assert.equal(fx.normalizeGroup({ remindTime: '23:59' }, '2026-09-17').remindTime, '23:59', '边界值 23:59 合法');
  assert.equal(fx.normalizeGroup({ remindTime: '00:00' }, '2026-09-17').remindTime, '00:00', '00:00 合法（午夜提醒）');
  assert.equal(fx.normalizeGroup({ remindTime: '24:00' }, '2026-09-17').remindTime, '08:00', '24:00 非法（时最大 23）');
  assert.equal(fx.normalizeGroup({ remindTime: '8:5' }, '2026-09-17').remindTime, '08:00', '分必须两位');
  assert.equal(fx.normalizeGroup({ remindTime: '8:05' }, '2026-09-17').remindTime, '08:05', '时补零后合法');
  assert.equal(fx.normalizeGroup({ periodDays: -3 }, '2026-09-17').periodDays, 1, '负周期夹到下限 1 天');
  assert.equal(fx.normalizeGroup({ periodDays: 0.4 }, '2026-09-17').periodDays, 1, '小数周期取整后不小于 1 天');
  assert.equal(fx.normalizeGroup({ periodDays: 9999 }, '2026-09-17').periodDays, 365, '周期上限 365 天');
  assert.ok(fx.normalizeGroup({ id: 'x' }, '2026-09-17').id, '缺 id 的组必须补一个，否则切换轮换会指错对象');
  assert.equal(fx.normalizeGroup({ id: 'g', futureKey: 'v' }, '2026-09-17').futureKey, 'v', '未识别的键必须原样保留（别端字段不能被抹掉）');
}

/* 3.2 组列表归一化：脏数据、重复 id、超量都要夹住 */
{
  const { fx } = bootPlugin();
  assert.equal(fx.normalizeGroups('坏了', '2026-09-17').length, 0, '不是数组时当空处理');
  assert.equal(fx.normalizeGroups(null, '2026-09-17').length, 0);
  assert.equal(fx.normalizeGroups([null, undefined, 3], '2026-09-17').length, 3, '垃圾条目各自兜成一套可用轮换，而不是整份丢掉');
  assert.equal(fx.normalizeGroups([{ id: 'x' }, { id: 'x' }], '2026-09-17').length, 1, '重复 id 会让「切换轮换」指错对象，必须剔掉');
  const many = fx.normalizeGroups(Array.from({ length: 30 }, (_, i) => ({ id: 'g' + i })), '2026-09-17');
  assert.equal(many.length, fx.GROUP_MAX, `组数必须夹到 ${fx.GROUP_MAX}，否则界面会被撑爆`);
}

/* 3.2b 旧版单套数据迁移：字段一个都不能丢（丢了用户就得重设一遍） */
{
  const { fx } = bootPlugin();
  const legacy = {
    members: [{ id: 'm1', name: '小北' }, { id: 'm2', name: '老陈' }],
    config: { dutyName: '宿舍值日', startDate: '2026-09-14', periodDays: 7, remindTime: '07:30', remindEnabled: true, sound: 'chime' },
    overrides: { '2026-09-14': 'm2' },
    removed: [{ id: 'm9', name: '旧室友' }],
    lastNotified: '2026-09-14',
  };
  const m = fx.migrateLegacy(legacy, '2026-09-17');
  assert.equal(m.length, 1, '旧数据只应迁出一组');
  assert.equal(m[0].name, '宿舍值日', '迁移后保留原轮换名');
  assert.equal(m[0].members.map((x) => x.name).join(','), '小北,老陈', '迁移后保留原成员');
  assert.equal(m[0].periodDays, 7, '迁移后保留原周期');
  assert.equal(m[0].remindTime, '07:30', '迁移后保留原提醒时刻');
  assert.equal(m[0].sound, 'chime', '迁移后保留桌面端选的提示音');
  assert.equal(m[0].overrides['2026-09-14'], 'm2', '迁移后保留换人记录');
  assert.equal(m[0].removed.map((x) => x.name).join(','), '旧室友', '迁移后保留「已移除」名单（否则误删的人找不回来）');
  assert.equal(m[0].lastNotified, '2026-09-14', '迁移后保留提醒去重标记（否则当天会重复提醒）');
  assert.equal(
    fx.migrateLegacy({ members: [], config: null, overrides: {}, removed: [], lastNotified: '' }, '2026-09-17').length, 0,
    '完全没有旧数据时不迁移（由 load 建默认组）',
  );
  assert.equal(fx.migrateLegacy(null, '2026-09-17').length, 0, '旧数据为 null 时不崩');
  assert.equal(fx.migrateLegacy({ lastNotified: '2026-09-14' }, '2026-09-17').length, 1, '只有提醒标记也算有旧数据（否则升级当天会重复提醒一次）');
  assert.equal(fx.migrateLegacy({ overrides: { '2026-09-14': 'm2' } }, '2026-09-17').length, 1, '只有换人记录也算有旧数据');
  assert.equal(fx.migrateLegacy({ config: { periodDays: 3 } }, '2026-09-17').length, 1, '只有配置也算有旧数据');
}

/* 3.3 按起始日切段：周期内每天都是同一个人（否则会天天催人） */
{
  const cases = [
    // [周期, 今天, 期望当班人] —— 起始日固定 2026-09-17
    [7, '2026-09-17', '阿青'], [7, '2026-09-20', '阿青'], [7, '2026-09-23', '阿青'],
    [7, '2026-09-24', '小北'], [7, '2026-09-30', '小北'],
    [7, '2026-10-01', '老陈'], [7, '2026-10-08', '阿青'],
    [1, '2026-09-17', '阿青'], [1, '2026-09-18', '小北'], [1, '2026-09-19', '老陈'], [1, '2026-09-20', '阿青'],
    [3, '2026-09-17', '阿青'], [3, '2026-09-19', '阿青'], [3, '2026-09-20', '小北'], [3, '2026-09-23', '老陈'], [3, '2026-09-26', '阿青'],
    [14, '2026-09-17', '阿青'], [14, '2026-09-30', '阿青'], [14, '2026-10-01', '小北'],
  ];
  for (const [p, today, want] of cases) {
    const { fx } = bootPlugin({ today });
    const g = fx.normalizeGroup(GROUP({ periodDays: p }), today);
    assert.equal(fx.assigneeFor(g, today)?.name, want, `周期 ${p} 天、${today} 应轮到 ${want}`);
  }
}

/* 3.3b 编辑名单保持真实轮换顺序，今天当班人单独标记 */
{
  const { fx } = bootPlugin({ seed: quietSeed({ groups: [GROUP({ periodDays: 1 })] }), today: '2026-09-19' });
  await settle();
  await fx.load();
  const host = fakeEl('div');
  fx.render(host);
  await settle();
  const g = fx.state.groups[0];
  const names = () => [...host.innerHTML.matchAll(/class="dd-mrow(?: current)?" data-id="[^"]+"[\s\S]*?<input class="dd-in" data-name value="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(names().join(','), '阿青,小北,老陈', '编辑列表顺序必须与长期轮换顺序一致');
  assert.match(host.innerHTML, /class="dd-mrow current" data-id="mC"/, '今天当班的人应有醒目标记');
  assert.equal(g.members.map((m) => m.name).join(','), '阿青,小北,老陈', '展示排序不改写长期轮换顺序');
  const miniGroup = mini.ddNormalizeGroup(GROUP({ periodDays: 1, perRound: 2 }), '2026-09-18');
  const miniMembers = mini.ddSnapshot('2026-09-18', miniGroup).members;
  assert.equal(miniMembers.map((m) => m.name).join(','), '阿青,小北,老陈', '小程序编辑列表也保持长期轮换顺序');
  assert.equal(miniGroup.members.map((m) => m.name).join(','), '阿青,小北,老陈', '小程序视图同样不改写基础名单');
  const swapped = mini.ddNormalizeGroup(GROUP({ periodDays: 1, overrides: { '2026-09-18': 'mC' } }), '2026-09-18');
  assert.equal(mini.ddSnapshot('2026-09-18', swapped).members[2].isCurrent, true, '临时换人时标记实际替班人');
}

/* 3.3c 地点与成员分开计时，跨端数据和展示一致 */
{
  const { fx } = bootPlugin({ today: '2026-09-20' });
  const source = GROUP({ periodDays: 7, locations: ['走廊', '浴室', '阳台'], locationPeriodDays: 3 });
  const g = fx.normalizeGroup(source, '2026-09-20');
  assert.equal(fx.locationAt(g, '2026-09-16'), '', '起始前无地点');
  assert.equal(fx.locationAt(g, '2026-09-17'), '走廊');
  assert.equal(fx.locationAt(g, '2026-09-19'), '走廊');
  assert.equal(fx.locationAt(g, '2026-09-20'), '浴室', '地点已换，成员仍在第一轮');
  assert.equal(fx.assigneeFor(g, '2026-09-20').name, '阿青');
  assert.equal(fx.locationAt(g, '2026-09-26'), '走廊', '地点列表循环');
  const snap = fx.snapshot(g);
  assert.equal(snap.currentLocation, '浴室');
  assert.equal(snap.nextLocationStart, '2026-09-23');
  assert.equal(snap.nextLocation, '阳台');
  assert.match(fx.heroHtml(snap), /今日地点：<b>浴室<\/b>/);
  assert.match(fx.locationsHtml(snap), /data-location-period-custom/);
  const mg = mini.ddNormalizeGroup(source, '2026-09-20');
  assert.equal(mini.ddLocationAt(mg, '2026-09-20'), '浴室');
  const ms = mini.ddSnapshot('2026-09-20', mg);
  assert.equal(ms.currentLocation, '浴室');
  assert.equal(ms.nextLocationStart, '2026-09-23');
  assert.equal(ms.nextLocationName, '阳台');
  assert.equal(ms.currentNames, '阿青');
  assert.equal(mini.ddGroupMoveLocation(mg, 0, 1).locations.join(','), '浴室,走廊,阳台');
  assert.equal(mini.ddGroupRemoveLocation(mg, 1).locations.join(','), '走廊,阳台');
  assert.equal(mini.ddGroupAddLocation(mg, '厨房').locations.join(','), '走廊,浴室,阳台,厨房');
  assert.equal(mini.ddGroupAddLocation(mg, '浴室').locations.length, 3, '重复地点不添加');
  assert.equal(mini.ddLocationAt(mini.ddNormalizeGroup(GROUP({ locations: ['教室'], locationPeriodDays: 1 }), '2026-09-20'), '2026-09-20'), '教室', '其他轮换组有独立地点');
  assert.equal(mini.ddSnapshot('2026-09-20', mini.ddNormalizeGroup(GROUP(), '2026-09-20')).currentLocation, '', '旧数据没有地点时保持原样');
  assert.deepEqual(mini.ddNormalizeGroup({ locations: ['走廊', '走廊', '', '浴室'], locationPeriodDays: 999 }, '2026-09-20').locations, ['走廊', '浴室']);
  assert.equal(fx.normalizeGroup({ locationPeriodDays: 999 }, '2026-09-20').locationPeriodDays, 365);
  assert.match(miniWxml, /bindtap="onDdAddLocation"/);
  assert.match(miniPage, /onDdLocationPeriodCustom\(\)/);
}

/* 3.4 起始日之前：还没有轮次，不能算成「第一个人」 */
{
  const { fx } = bootPlugin({ today: '2026-09-16' });
  const g = fx.normalizeGroup(GROUP(), '2026-09-16');
  assert.equal(fx.cycleStartOf(g, '2026-09-16'), null, '起始日之前没有轮次');
  assert.equal(fx.assigneeFor(g, '2026-09-16'), null, '未开始时不指派任何人');
  assert.equal(fx.isCycleStartDay(g, '2026-09-16'), false);
}

/* 3.5 临时换人只影响那一轮，不改变后续排班 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  const g = fx.normalizeGroup(GROUP({ overrides: { '2026-09-17': 'mC' } }), '2026-09-17');
  assert.equal(fx.assigneeFor(g, '2026-09-17')?.name, '老陈', '本轮已换给老陈');
  assert.equal(fx.assigneeFor(g, '2026-09-18')?.name, '老陈', '周期内每天沿用同一次换人');
  assert.equal(fx.assigneeFor(g, '2026-09-24')?.name, '小北', '下一轮不受影响，回到原排班');
  // 换人记录指向一个已不在名单里的人 → 必须退回正常轮换，而不是空
  const gone = fx.normalizeGroup(GROUP({ overrides: { '2026-09-17': 'mGone' } }), '2026-09-17');
  assert.equal(fx.assigneeFor(gone, '2026-09-17')?.name, '阿青', '换人对象不存在时必须退回原排班');
  assert.equal(fx.overrideHit(gone, '2026-09-17'), null, '指向已移除成员的换人**不算换人**（否则界面会显示「已换人 · 原 X」而实际当班的就是 X）');
  assert.equal(fx.overrideHit(g, '2026-09-17')?.name, '老陈', '真换人时 overrideHit 返回的是替补本人');
}

/* 3.6 成员顺序就是轮换顺序；空名单不指派 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  assert.equal(fx.assigneeFor(fx.normalizeGroup(GROUP({ periodDays: 1, members: [] }), '2026-09-17'), '2026-09-17'), null, '没有成员时不指派');
  const g = fx.normalizeGroup(GROUP({ periodDays: 1, members: [{ id: 'mB', name: '小北' }, { id: 'mA', name: '阿青' }] }), '2026-09-17');
  assert.equal(fx.assigneeFor(g, '2026-09-17')?.name, '小北', '第一个人先当班');
  assert.equal(fx.assigneeFor(g, '2026-09-18')?.name, '阿青', '按名单顺序轮换');
}

/* 3.7 组间隔离：两套轮换的成员 / 周期 / 起始日 / 换人互不影响 */
{
  const dorm = GROUP({ id: 'gDorm', name: '宿舍值日', startDate: '2026-09-17', periodDays: 7, remindEnabled: false });
  const pub = GROUP({ id: 'gPub', name: '公区卫生', startDate: '2026-09-18', periodDays: 1, remindEnabled: false, members: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }] });
  const { fx } = bootPlugin({ seed: { groups: [dorm, pub], activeId: 'gDorm' }, today: '2026-09-18' });
  await settle();
  await fx.load();
  const [d, p] = fx.state.groups;
  assert.equal(d.name, '宿舍值日');
  assert.equal(p.name, '公区卫生');
  assert.equal(fx.assigneeFor(d, '2026-09-18').name, '阿青', '宿舍组 7 天一段：整周都是阿青');
  assert.equal(fx.assigneeFor(p, '2026-09-18').name, '甲', '公区组从 9/18 起每天一轮');
  assert.equal(fx.assigneeFor(p, '2026-09-19').name, '乙');
  assert.equal(fx.assigneeFor(d, '2026-09-19').name, '阿青', '公区换人不会带动宿舍组');
  // 给宿舍组换人，公区组不受影响
  d.overrides['2026-09-17'] = 'mC';
  assert.equal(fx.assigneeFor(d, '2026-09-18').name, '老陈');
  assert.equal(fx.assigneeFor(p, '2026-09-18').name, '甲', 'A 组换人不改 B 组排班');
  // 周期与起始日各自独立
  assert.equal(fx.periodOf(d), 7);
  assert.equal(fx.periodOf(p), 1);
  // 公区组自己的换人也不影响宿舍组
  p.overrides['2026-09-18'] = 'p2';
  assert.equal(fx.assigneeFor(p, '2026-09-18').name, '乙');
  assert.equal(fx.assigneeFor(d, '2026-09-18').name, '老陈', 'B 组换人不改 A 组排班');
}

/* 3.8 组管理：新建 / 切换 / 改名 / 删除 */
{
  const { fx, storage } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await fx.load();
  assert.equal(fx.state.groups.length, 1);
  const first = fx.state.groups[0];
  assert.equal(first.id, 'g1');

  // 新建：切到新组，且新组是空成员（不能继承别人的成员）
  const created = await fx.addGroup();
  assert.equal(fx.state.groups.length, 2);
  assert.equal(fx.state.activeId, created.id, '新建后应切到新组');
  assert.equal(created.members.length, 0, '新组不能继承上一组的成员');
  assert.notEqual(created.id, first.id, '两套轮换的 id 必须不同');
  assert.equal(storage.get('groups').length, 2, '新建要落盘');
  assert.equal(storage.get('activeId'), created.id, '当前组也要落盘（下次打开还停在这一组）');

  // 切换
  assert.equal(await fx.setActiveGroup(first.id), true);
  assert.equal(fx.state.activeId, first.id);
  assert.equal(await fx.setActiveGroup('不存在'), false, '切到不存在的组必须失败（不能让界面失去当前组）');
  assert.equal(fx.state.activeId, first.id);
  assert.equal(await fx.setActiveGroup(first.id), false, '切到当前组不算变更');

  // 改名
  assert.equal(await fx.renameGroup(created.id, '  公区卫生  '), true);
  assert.equal(fx.state.groups[1].name, '公区卫生', '改名要去掉首尾空白');
  assert.equal(await fx.renameGroup(created.id, '   '), true);
  assert.equal(fx.state.groups[1].name, '值日', '空名退回默认名，不留空白标签');
  assert.equal(await fx.renameGroup(created.id, '值日'), false, '名字没变时不算变更');
  assert.equal(await fx.renameGroup('不存在', 'x'), false);
  assert.equal(await fx.renameGroup(created.id, '公区卫生'), true);

  // 删除
  assert.equal(await fx.removeGroup('不存在'), false, '删不存在的组必须失败');
  assert.equal(fx.state.groups.length, 2);
  assert.equal(await fx.removeGroup(created.id), true);
  assert.equal(fx.state.groups.length, 1);
  assert.equal(fx.state.activeId, first.id, '删掉当前组后必须落到还活着的组');
  assert.equal(await fx.removeGroup(first.id), false, '最后一套不许删（删光界面就没有可编辑的对象了）');
  assert.equal(fx.state.groups.length, 1);
}

/* 3.9 组数上限：到上限拒绝新建，而不是静默丢 */
{
  const { fx } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await fx.load();
  for (let i = 0; i < 30; i++) await fx.addGroup();
  assert.equal(fx.state.groups.length, fx.GROUP_MAX, `组数必须夹在 ${fx.GROUP_MAX}`);
  assert.equal(await fx.addGroup(), null, '到上限返回 null，让调用方去提示，而不是假装建成功');
}

/* 3.10 snapshot：首页卡片与「接下来的轮次」 */
{
  const { fx } = bootPlugin({ today: '2026-09-20' });
  const g = fx.normalizeGroup(GROUP(), '2026-09-20');
  const s = fx.snapshot(g);
  assert.equal(s.started, true);
  assert.equal(s.cycle, '2026-09-17', '本轮起始日');
  assert.equal(s.current.name, '阿青');
  assert.equal(s.nextStart, '2026-09-24', '下次换人日 = 本轮起始 + 周期');
  assert.equal(s.nextWho.name, '小北');
  assert.equal(s.period, 7);
  assert.equal(s.rows.length, 6, '默认展示 6 个后续轮次');
  // ⚠️ 数组来自 vm 的另一个 realm，原型不同 —— deepStrictEqual 会把内容相同的数组判成不等，
  // 这里统一比拼接后的字符串（与 test-pomodoro.mjs 同一条避坑）。
  assert.equal(s.rows.map((r) => r.who.name).join(','), '小北,老陈,阿青,小北,老陈,阿青', '后续轮次按顺序循环');
  assert.equal(s.rows.map((r) => r.daysUntil).join(','), '4,11,18,25,32,39', '每行倒计时按天算');
  assert.equal(s.rows[0].index, 2, '第 2 轮（从 1 起）');
  assert.equal(s.rows[0].swapped, false, '没有换人时不该标「换人」');

  // 还没开始：nextStart 落在起始日，动词是「开始」而不是「换人」
  const s2 = fx.snapshot(fx.normalizeGroup(GROUP({ startDate: '2026-10-01' }), '2026-09-20'));
  assert.equal(s2.started, false);
  assert.equal(s2.nextStart, '2026-10-01');
  assert.equal(s2.current, null, '未开始时不显示「当前当班人」');
  assert.match(fx.nextBigText(s2), /天后开始/, '未开始时说的是「开始」而不是「换人」');
}

/* 3.11 迁移：旧版单套轮换 → 一组，字段一个不丢 */
{
  const { fx, storage } = bootPlugin({
    seed: {
      members: MEMBERS,
      config: { dutyName: '打水', startDate: '2026-09-10', periodDays: 3, remindTime: '07:30', remindEnabled: false, sound: 'chime' },
      overrides: { '2026-09-10': 'mC' },
      removed: [{ id: 'mX', name: '老张' }],
      lastNotified: '2026-09-10',
    },
    today: '2026-09-17',
  });
  await settle();
  await fx.load();
  assert.equal(fx.state.groups.length, 1, '旧数据只应迁出一组');
  const g = fx.state.groups[0];
  assert.ok(g.id, '迁移出的组必须有 id，否则切不动');
  assert.equal(g.name, '打水', '轮换名取自旧的事项名');
  assert.equal(g.startDate, '2026-09-10');
  assert.equal(g.periodDays, 3);
  assert.equal(g.remindTime, '07:30');
  assert.equal(g.sound, 'chime', '提示音要一起搬过来，不能因为改版就把用户的选择抹掉');
  assert.equal(g.members.length, 3);
  assert.equal(g.removed[0].name, '老张', '「已移除」名单也要搬过来，否则用户找不回误删的人');
  assert.equal(g.overrides['2026-09-10'], 'mC', '换人记录要一起搬');
  assert.equal(g.lastNotified, '2026-09-10', '「已提醒过」要一起搬，否则升级当天会重复催一次');
  assert.equal(fx.state.activeId, g.id, '迁移后当前组指向它');
  assert.equal(storage.get('groups').length, 1, '迁移要立刻落盘');
}

/* 3.11b 完全没有旧数据时不迁移（由 load 建一套默认轮换）——
   否则空数据的用户会凭空多出一套「值日」 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  await settle();
  await fx.load();
  assert.equal(fx.state.groups.length, 1, '空数据时只应有一套默认轮换');
  assert.equal(
    fx.migrateLegacy({ members: [], config: null, overrides: {}, removed: [], lastNotified: '' }, '2026-09-17').length, 0,
    '没有任何旧数据时不该迁出东西',
  );
  assert.equal(fx.migrateLegacy(null, '2026-09-17').length, 0, '旧数据为 null 时不崩');
  assert.equal(fx.migrateLegacy({ lastNotified: '2026-09-10' }, '2026-09-17').length, 1, '只有「已提醒」标记也算有旧数据（否则升级当天会重复提醒）');
  assert.equal(fx.migrateLegacy({ overrides: { '2026-09-10': 'mC' } }, '2026-09-17').length, 1, '只有换人记录也算有旧数据');
  assert.equal(fx.migrateLegacy({ config: { periodDays: 3 } }, '2026-09-17').length, 1, '只有配置也算有旧数据');
}

/* 3.11c 轮次行的日期文案：周几只能出现一次（曾经写成「9月18日（周五）· 周五」） */
{
  const { fx } = bootPlugin({ today: '2026-09-20' });
  const weekly = fx.rowsHtml(fx.snapshot(fx.normalizeGroup(GROUP({ periodDays: 7 }), '2026-09-20')));
  const daily = fx.rowsHtml(fx.snapshot(fx.normalizeGroup(GROUP({ periodDays: 1 }), '2026-09-20')));
  const dateCell = (html) => (html.match(/<span class="dd-d">([^<]*)<\/span>/) || [])[1] || '';
  const wCell = dateCell(weekly);
  const dCell = dateCell(daily);
  assert.match(wCell, /^\d+月\d+日 — \d+月\d+日 · 周[一二三四五六日]起$/, `多日轮次的日期文案（实际「${wCell}」）`);
  assert.match(dCell, /^\d+月\d+日（周[一二三四五六日]）$/, `单日轮次的日期文案（实际「${dCell}」）`);
  assert.equal((wCell.match(/周/g) || []).length, 1, '多日轮次的日期里「周X」只应出现一次');
  assert.equal((dCell.match(/周/g) || []).length, 1, '单日轮次的日期里「周X」只应出现一次');
  // 整行也只该有一个「周X」—— 防止以后又有人在外层补一遍
  const rowLine = (weekly.match(/<div class="dd-row[^"]*">[\s\S]*?<\/div>/) || [])[0] || '';
  assert.equal((rowLine.match(/周/g) || []).length, 1, '整行里「周X」只应出现一次');
}

/* 3.12 迁移后旧键不再影响：groups 一旦存在就以它为准 */
{
  const { fx, storage } = bootPlugin({
    seed: { members: MEMBERS, config: { dutyName: '打水', startDate: '2026-09-10', periodDays: 3, remindEnabled: false } },
    today: '2026-09-17',
  });
  await settle();
  await fx.load();
  assert.equal(fx.state.groups[0].name, '打水');
  storage.set('members', []);                          // 模拟旧版本客户端改动旧键
  storage.set('config', { dutyName: '被别人改了' });
  await fx.load();
  assert.equal(fx.state.groups[0].name, '打水', 'groups 已存在时不得再被旧键盖回去');
  assert.equal(fx.state.groups[0].members.length, 3, '旧键的改动不该影响已迁移的数据');
}

/* 3.13 全新安装 / 脏 groups：兜底出一组并落盘，且再 load 不会换 id */
{
  const fresh = bootPlugin({ today: '2026-09-17' });
  await settle();
  await fresh.fx.load();
  assert.equal(fresh.fx.state.groups.length, 1, '全新安装必须自动有一套默认轮换，否则界面无处落脚');
  assert.equal(fresh.fx.state.activeId, fresh.fx.state.groups[0].id);
  assert.equal(fresh.storage.get('groups').length, 1, '兜底建组要立刻落盘');

  const broken = bootPlugin({ seed: { groups: '坏了', activeId: 42 }, today: '2026-09-17' });
  await settle();
  await broken.fx.load();
  const id1 = broken.fx.state.groups[0].id;
  assert.equal(broken.storage.get('groups').length, 1, '脏 groups 也要落盘成一份可用的');
  await broken.fx.load();
  assert.equal(broken.fx.state.groups[0].id, id1, '再 load 不能又生成一个随机 id 的新组（否则用户刚做的设置下次就没了）');
}

/* ── 四、真跑：提醒时机 ── */
/* 4.1 reminderDue 纯函数：五个条件缺一不可 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  const g = fx.normalizeGroup(GROUP({ remindTime: '08:00' }), '2026-09-17');
  assert.equal(fx.reminderDue(g, '2026-09-17', 480), true, '08:00 整点应提醒');
  assert.equal(fx.reminderDue(g, '2026-09-17', 479), false, '差一分钟不提醒');
  assert.equal(fx.reminderDue(g, '2026-09-17', 1439), true, '当天再晚也该补提醒');
  assert.equal(fx.reminderDue(g, '2026-09-18', 600), false, '周期中间不提醒（否则天天催人）');
  assert.equal(fx.reminderDue(fx.normalizeGroup(GROUP({ remindEnabled: false }), '2026-09-17'), '2026-09-17', 600), false, '关掉提醒就不提醒');
  assert.equal(fx.reminderDue(fx.normalizeGroup(GROUP({ members: [] }), '2026-09-17'), '2026-09-17', 600), false, '没有成员时无人可提醒');
  assert.equal(fx.reminderDue(fx.normalizeGroup(GROUP({ lastNotified: '2026-09-17' }), '2026-09-17'), '2026-09-17', 600), false, '同一轮不重复提醒');
  assert.equal(fx.reminderDue(fx.normalizeGroup(GROUP({ startDate: '2026-10-01' }), '2026-09-17'), '2026-09-17', 600), false, '还没开始不提醒');
}

/* 4.2 每轮第一天到点提醒一次，并落盘 lastNotified */
{
  const { storage, c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '00:00' })] }), today: '2026-09-17' });
  await settle();
  assert.equal(c.notified.length, 1, `每轮第一天应提醒一次，实际 ${c.notified.length}`);
  assert.match(c.notified[0], /阿青/, '提醒里必须带当班人的名字');
  assert.match(c.notified[0], /值日/);
  assert.equal(c.sounds.join(','), 'beep', '提醒要带上这一组选的提示音');
  assert.equal(storage.get('groups')[0].lastNotified, '2026-09-17', '提醒后必须落盘，防止重复提醒');
  assert.equal(c.started, 1, '启动时起一个定时器');
}

/* 4.3 同一轮不重复提醒（重新加载后靠 lastNotified 去重） */
{
  const { c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '00:00', lastNotified: '2026-09-17' })] }), today: '2026-09-17' });
  await settle();
  assert.equal(c.notified.length, 0, '这一轮已经提醒过，不该再催');
}

/* 4.4 周期中间不提醒 —— 否则就是天天催人 */
{
  const { c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '00:00' })] }), today: '2026-09-20' });
  await settle();
  assert.equal(c.notified.length, 0, '不是本轮第一天就不提醒');
}

/* 4.5 还没到点不提醒 */
{
  const clock = class extends Date { constructor(...a) { super(...(a.length ? a : ['2026-09-17T06:00:00'])); } };
  const { c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '08:00' })] }), today: '2026-09-17', clock });
  await settle();
  assert.equal(c.notified.length, 0, '06:00 未到 08:00，不该提醒');
}

/* 4.6 回归：存量配置里存着 "25:99" 这种坏时刻时，提醒不能被静默关掉。
   "25:99" 能过 /^\d{2}:\d{2}$/，但换算成 1599 分钟 > 一天最大值 1439，
   会让「now < 到点」永远成立 —— 不报错、不提示，用户只会觉得「提醒坏了」。 */
{
  const clock = class extends Date { constructor(...a) { super(...(a.length ? a : ['2026-09-17T09:30:00'])); } };
  const { c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '25:99' })] }), today: '2026-09-17', clock });
  await settle();
  assert.equal(c.notified.length, 1, '坏时刻必须被归一化到 08:00 并照常提醒，而不是永远不响');
}

/* 4.7 关掉提醒 / 没有成员时不提醒 */
{
  const off = bootPlugin({ seed: seed({ groups: [GROUP({ remindEnabled: false, remindTime: '00:00' })] }), today: '2026-09-17' });
  await settle();
  assert.equal(off.c.notified.length, 0, '关掉提醒后不该提醒');

  const empty = bootPlugin({ seed: seed({ groups: [GROUP({ members: [], remindTime: '00:00' })] }), today: '2026-09-17' });
  await settle();
  assert.equal(empty.c.notified.length, 0, '没有成员时无人可提醒，静默跳过');
}

/* 4.8 多组同时到点：各自提醒一次、各自落盘，但只响一声 */
{
  const A = GROUP({ id: 'gA', name: '宿舍值日', periodDays: 1, remindTime: '00:00' });
  const B = GROUP({ id: 'gB', name: '公区卫生', periodDays: 1, remindTime: '00:00', members: [{ id: 'p1', name: '甲' }] });
  const { storage, c } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-17' });
  await settle();
  assert.equal(c.notified.length, 2, `两套轮换同时到点应各提醒一次，实际 ${c.notified.length}`);
  assert.match(c.notified[0], /宿舍值日/);
  assert.match(c.notified[0], /阿青/);
  assert.match(c.notified[1], /公区卫生/);
  assert.match(c.notified[1], /甲/);
  assert.equal(c.sounds.length, 1, '同时到点只响一声 —— 叠着播会糊成一片噪音');
  const saved = storage.get('groups');
  assert.equal(saved[0].lastNotified, '2026-09-17', 'A 组要落盘');
  assert.equal(saved[1].lastNotified, '2026-09-17', 'B 组要落盘');
}

/* 4.9 一组到点、另一组没到点：只提醒到点的那组，且**不能**把没到点的标成已提醒 */
{
  const clock = class extends Date { constructor(...a) { super(...(a.length ? a : ['2026-09-17T06:00:00'])); } };
  const A = GROUP({ id: 'gA', name: '宿舍值日', periodDays: 1, remindTime: '23:00' });
  const B = GROUP({ id: 'gB', name: '公区卫生', periodDays: 1, remindTime: '00:00', members: [{ id: 'p1', name: '甲' }] });
  const { storage, c } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-17', clock });
  await settle();
  assert.equal(c.notified.length, 1);
  assert.match(c.notified[0], /公区卫生/, '只有到点的那组该提醒');
  assert.equal(storage.get('groups')[0].lastNotified, '', '没到点的那组不能被标成已提醒（否则它今天就再也不会提醒了）');
  assert.equal(storage.get('groups')[1].lastNotified, '2026-09-17');
}

/* 4.10 一组关掉提醒 / 一组周期没对上：各判各的 */
{
  const A = GROUP({ id: 'gA', name: '宿舍值日', periodDays: 7, remindTime: '00:00', remindEnabled: false });
  const B = GROUP({ id: 'gB', name: '公区卫生', periodDays: 1, remindTime: '00:00', members: [{ id: 'p1', name: '甲' }] });
  const { c } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-20' });
  await settle();
  assert.equal(c.notified.length, 1);
  assert.match(c.notified[0], /公区卫生/, '宿舍组关着提醒、且不在轮次第一天 → 只有公区组该提醒');
}

/* 4.11 各自去重：A 组今天提醒过、B 组没提醒过 → 只补 B 组 */
{
  const A = GROUP({ id: 'gA', name: '宿舍值日', periodDays: 1, remindTime: '00:00', lastNotified: '2026-09-17' });
  const B = GROUP({ id: 'gB', name: '公区卫生', periodDays: 1, remindTime: '00:00', members: [{ id: 'p1', name: '甲' }] });
  const { c } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-17' });
  await settle();
  assert.equal(c.notified.length, 1);
  assert.match(c.notified[0], /公区卫生/, '「已提醒过」是按组记的，不能一组提醒过就全都不提醒');
}

/* 4.12 迁移过来的旧数据也要守住「同一轮不重复提醒」 */
{
  const { c } = bootPlugin({
    seed: { members: MEMBERS, config: { dutyName: '值日', startDate: '2026-09-17', periodDays: 7, remindTime: '00:00' }, lastNotified: '2026-09-17' },
    today: '2026-09-17',
  });
  await settle();
  assert.equal(c.notified.length, 0, '迁移时必须把 lastNotified 一起搬过来，否则升级当天会重复催一次');
}

/* 4.13 迁移后提醒照常工作（不能因为改版把提醒弄丢） */
{
  const { c, storage } = bootPlugin({
    seed: { members: MEMBERS, config: { dutyName: '打水', startDate: '2026-09-17', periodDays: 7, remindTime: '00:00' } },
    today: '2026-09-17',
  });
  await settle();
  assert.equal(c.notified.length, 1, '旧数据升级后当天就该提醒');
  assert.match(c.notified[0], /打水/);
  assert.equal(storage.get('groups')[0].lastNotified, '2026-09-17');
}

/* ── 五、真跑：双实例与停用自终止 ── */
/* 5.1 停用再启用会重跑整个模块，旧实例的 interval 还活着 → 必须自己发现被顶掉后退出 */
{
  const { fx, storage, c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '00:00' })] }), today: '2026-09-17' });
  await settle();
  assert.equal(typeof c.intervalFn, 'function', '应捕获到定时器回调');
  const before = c.cleared;
  storage.set('gen', 99);                                 // 新实例领走了代号
  await c.intervalFn();
  assert.ok(c.cleared > before, '发现自己被顶掉后必须 clearInterval 退出，否则会双份提醒');
  assert.equal(fx.state.timer, null, '退出后定时器句柄必须清掉');
}

/* 5.2 插件被停用（不重启用）：侧栏入口消失 → 自终止 */
{
  const { c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '00:00' })] }), today: '2026-09-17', navAlive: false });
  await settle();
  assert.ok(c.cleared > 0, '侧栏入口消失说明插件已停用，必须停掉定时器');
}

/* 5.3 启动早期导航还没渲染（没有 nav.nav）不算停用，不能误自杀 */
{
  const { c } = bootPlugin({ seed: seed({ groups: [GROUP({ remindTime: '00:00' })] }), today: '2026-09-17' });
  await settle();
  assert.equal(c.cleared, 0, '导航未就绪时不该把自己停掉');
}

/* 5.4 加入今日任务：字段、去重、无成员时静默不建 */
{
  const { fx, c } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await fx.load();
  const t = await fx.addTodayTask(fx.state.groups[0]);
  assert.equal(c.created.length, 1, '应创建 1 条任务');
  assert.equal(c.created[0].title, '值日 · 阿青', '任务标题 = 轮换名 + 当班人');
  assert.equal(c.created[0].due, '2026-09-17', '必须挂在今天');
  assert.equal(c.created[0].quad, 2, '默认第二象限');
  assert.equal(c.created[0].estMin, 15);
  assert.equal(c.created[0].tags.join(','), '值日', '标签用轮换名，方便在任务列表里筛');
  assert.ok(t && t.id, '应把创建出的任务返回给调用方');
  assert.match(c.notified.at(-1), /已把「值日 · 阿青」加进今天的任务/);
}

/* 5.4b 同日同名的未完成任务算重复，不重复创建 */
{
  const dup = { id: 't9', title: '值日 · 阿青', due: '2026-09-17', done: false };
  const { fx, c } = bootPlugin({ seed: quietSeed(), today: '2026-09-17', tasks: [dup] });
  await settle();
  await fx.load();
  const t = await fx.addTodayTask(fx.state.groups[0]);
  assert.equal(c.created.length, 0, '同日同名任务已存在时不该重复创建');
  assert.equal(t, null);
  assert.match(c.notified.at(-1), /已经在列表里了/);
}

/* 5.4c 已完成的任务不算重复；别的日期/别的标题也不算重复 */
{
  const doneSame = { id: 't9', title: '值日 · 阿青', due: '2026-09-17', done: true };
  const otherDay = { id: 't8', title: '值日 · 阿青', due: '2026-09-16', done: false };
  const otherTitle = { id: 't7', title: '值日 · 小北', due: '2026-09-17', done: false };
  const { fx, c } = bootPlugin({ seed: quietSeed(), today: '2026-09-17', tasks: [doneSame, otherDay, otherTitle] });
  await settle();
  await fx.load();
  await fx.addTodayTask(fx.state.groups[0]);
  assert.equal(c.created.length, 1, '已完成 / 别的日期 / 别的当班人都不算重复');
}

/* 5.4d 没有成员时无人可派，静默不建（只提示一句） */
{
  const { fx, c } = bootPlugin({ seed: quietSeed({ groups: [GROUP({ members: [], remindEnabled: false })] }), today: '2026-09-17' });
  await settle();
  await fx.load();
  const t = await fx.addTodayTask(fx.state.groups[0]);
  assert.equal(c.created.length, 0);
  assert.equal(t, null);
  assert.match(c.notified.at(-1), /还没有当班安排/);
}

/* 5.4e 改名后，任务标题与标签都跟着变 */
{
  const { fx, c } = bootPlugin({ seed: quietSeed({ groups: [GROUP({ name: '打水', remindEnabled: false })] }), today: '2026-09-17' });
  await settle();
  await fx.load();
  await fx.addTodayTask(fx.state.groups[0]);
  assert.equal(c.created[0].title, '打水 · 阿青');
  assert.equal(c.created[0].tags.join(','), '打水');
}

/* 5.4f 两套轮换各加各的任务：同一个人在两套里当班 = 两条不同的任务 */
{
  const A = GROUP({ id: 'gA', name: '宿舍值日', remindEnabled: false, members: MEMBERS });
  const B = GROUP({ id: 'gB', name: '公区卫生', remindEnabled: false, members: [{ id: 'p1', name: '阿青' }] });
  const { fx, c } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  await fx.addTodayTask(fx.state.groups[0]);
  await fx.addTodayTask(fx.state.groups[1]);
  assert.equal(c.created.length, 2, '两套轮换的任务不该互相算重复');
  assert.equal(c.created[0].title, '宿舍值日 · 阿青');
  assert.equal(c.created[1].title, '公区卫生 · 阿青');
  assert.equal(c.created[1].tags.join(','), '公区卫生', '标签要能区分是哪一套轮换');
}

/* ── 六、渲染冒烟 ── */
/* 6.1 全新安装：自动有一套默认轮换，画出引导空态而不是白屏 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  await settle();
  await fx.load();
  const host = fakeEl('div');
  await fx.render(host);
  await settle();
  assert.match(host.innerHTML, /先添加成员/, '空名单必须画出引导空态');
  assert.match(host.innerHTML, /还没有成员，无法排班/, '没有成员时不能假装排得出班');
  assert.match(host.innerHTML, /data-group-new/, '必须有「新建轮换」入口');
  assert.ok(!/轮到 <b>—<\/b>/.test(host.innerHTML), '没有成员时不该出现「轮到 —」这种半截文案');
}

/* 6.2 有成员时首页显示当班人与下次换人 */
{
  const { fx } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await fx.load();
  const host = fakeEl('div');
  await fx.render(host);
  await settle();
  assert.match(host.innerHTML, /<b>阿青<\/b>/, '首页必须显示本轮当班人');
  assert.match(host.innerHTML, /今天换人/, '起始日当天应标出「今天换人」');
  assert.match(host.innerHTML, /轮到 <b>小北<\/b>/, '「下次换人」应显示下一轮的人');
  assert.match(host.innerHTML, /第 1 轮/, '轮次表必须标出轮次序号');
  // 「本轮换人」控件必须落在**本轮**那张卡片里，不能塞进「下次换人」卡片 ——
  // 它改的是当前这一轮（overrideHit 用 s.cycle），放在「下次换人」下面会让人以为改的是下一轮。
  const heroPart = host.innerHTML.split('下次换人')[0];
  const nextPart = host.innerHTML.split('下次换人')[1] || '';
  assert.ok(heroPart.includes('data-swap'), '「本轮换人」控件必须在本轮卡片里');
  assert.ok(!nextPart.includes('data-swap'), '「下次换人」卡片里不能出现改本轮的换人控件');
}

/* 6.2b 页面保持打开跨过换人日，定时 tick 自动刷新当班标记 */
{
  const { fx, setToday } = bootPlugin({ seed: quietSeed({ groups: [GROUP({ periodDays: 1, remindEnabled: false })] }), today: '2026-09-17' });
  await settle();
  const host = fakeEl('div');
  fx.render(host);
  await settle();
  const ids = () => [...host.innerHTML.matchAll(/class="dd-mrow(?: current)?" data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids().join(','), 'mA,mB,mC');
  setToday('2026-09-18');
  await fx.tick();
  assert.equal(ids().join(','), 'mA,mB,mC', '跨到新轮次后编辑顺序仍保持不变');
  assert.match(host.innerHTML, /class="dd-mrow current" data-id="mB"/, '跨到新轮次后应自动更新当班标记');
  assert.equal(fx.state.groups[0].members.map((m) => m.id).join(','), 'mA,mB,mC', '自动刷新不能重排底层成员名单');
}

/* 6.3 多组渲染：标签条列出所有轮换、各自带上今天当班的人；成员列表只显示当前组的 */
{
  const A = GROUP({ id: 'gA', name: '宿舍值日', remindEnabled: false, members: MEMBERS });
  const B = GROUP({ id: 'gB', name: '公区卫生', remindEnabled: false, members: [{ id: 'p1', name: '甲' }] });
  const { fx } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  const host = fakeEl('div');
  await fx.render(host);
  await settle();
  assert.match(host.innerHTML, /data-group="gA"/, '标签条要能切回第一套');
  assert.match(host.innerHTML, /data-group="gB"/, '标签条要列出第二套');
  assert.match(host.innerHTML, /宿舍值日/);
  assert.match(host.innerHTML, /公区卫生/);
  assert.ok(host.innerHTML.includes('value="阿青"'), '当前组的成员要列出来');
  assert.ok(!host.innerHTML.includes('value="甲"'), '不能把别的组的成员混进当前组的成员列表');
  assert.match(host.innerHTML, /aria-pressed="true"/, '当前组要有选中态');
}

/* 6.4 换人后主卡片要标出「已换人 · 原 X」，X 是**正常排班本该当班的人** */
{
  const { fx } = bootPlugin({ seed: quietSeed({ groups: [GROUP({ remindEnabled: false, overrides: { '2026-09-17': 'mC' } })] }), today: '2026-09-17' });
  await settle();
  await fx.load();
  const host = fakeEl('div');
  await fx.render(host);
  await settle();
  assert.match(host.innerHTML, /<b>老陈<\/b>/, '当班人显示换上去的那位');
  assert.match(host.innerHTML, /已换人 · 原 阿青/, '要说清原本该谁当班，别把替补当成「原」');
  assert.ok(!/已换人 · 原 老陈/.test(host.innerHTML), '「原」不能写成替补自己');
}

/* 6.5 只剩一套轮换时「删除」按钮禁用 */
{
  const { fx } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await fx.load();
  const host = fakeEl('div');
  await fx.render(host);
  await settle();
  assert.match(host.innerHTML, /data-group-del[^>]*disabled/, '只剩一套时删除按钮应禁用');

  await fx.addGroup();
  const host2 = fakeEl('div');
  await fx.render(host2);
  await settle();
  assert.ok(!/data-group-del[^>]*disabled/.test(host2.innerHTML), '有两套时删除按钮应可用');
}

/* 6.6 删除的守卫：函数里也拦一道，不能只靠按钮禁用 */
{
  const { fx } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await fx.load();
  assert.equal(await fx.removeGroup(fx.state.groups[0].id), false, '只剩一套时删除必须被拒（按钮禁用只是第一道）');
  assert.equal(fx.state.groups.length, 1);
}

/* 6.7 二次确认：用户点「取消」时 confirmFn 必须返回 false；没有 window 的环境不能把删除卡死 */
{
  const no = bootPlugin({ confirm: false });
  assert.equal(no.fx.confirmFn('删？'), false, '用户在确认框点取消时必须返回 false');
  const yes = bootPlugin({ confirm: true });
  assert.equal(yes.fx.confirmFn('删？'), true);
  const bare = bootPlugin({ withWindow: false });
  assert.equal(bare.fx.confirmFn('删？'), true, '没有 window 的环境（单测/SSR）不能把删除流程卡死');
}

/* 6.8 render 先给出占位，不能白屏 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  await settle();
  const host = fakeEl('div');
  fx.render(host);
  assert.match(host.innerHTML, /dd-wrap/, 'render 必须先给出「正在读取」的占位，不能白屏');
}

/* ── 七、多人值日（perRound） ── */
/* 7.1 perRound 归一化：0 / 负数 / 小数 / 超量都要夹住 */
{
  const { fx } = bootPlugin();
  assert.equal(fx.normalizeGroup({ perRound: 0 }, '2026-09-17').perRound, 1, '0 是「没填」，退回单人');
  assert.equal(fx.normalizeGroup({}, '2026-09-17').perRound, 1, '缺省 = 单人（历史数据默认）');
  assert.equal(fx.normalizeGroup({ perRound: -2 }, '2026-09-17').perRound, 1, '负数夹到下限 1');
  assert.equal(fx.normalizeGroup({ perRound: 2.4 }, '2026-09-17').perRound, 2, '小数取整');
  assert.equal(fx.normalizeGroup({ perRound: 9999 }, '2026-09-17').perRound, 16, '上限对齐 MEMBER_MAX = 16');
  assert.equal(fx.normalizeGroup({ perRound: 3 }, '2026-09-17').perRound, 3, '合法值原样保留');
  assert.equal(fx.defaultGroup('2026-09-17', null).perRound, 1, '默认组是单人');
}

/* 7.2 多人排班：成员环上取 perRound 人的滑动窗口 —— [A,B,C] 每轮 2 人 → A,B / C,A / B,C */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  const g = fx.normalizeGroup(GROUP({ periodDays: 1, perRound: 2 }), '2026-09-17');
  assert.equal(fx.assigneesFor(g, '2026-09-17').map((m) => m.name).join(','), '阿青,小北', '第 1 轮 = 名单前两人');
  assert.equal(fx.assigneesFor(g, '2026-09-18').map((m) => m.name).join(','), '老陈,阿青', '第 2 轮从第 3 人起绕环滑动');
  assert.equal(fx.assigneesFor(g, '2026-09-19').map((m) => m.name).join(','), '小北,老陈', '第 3 轮继续滑动');
  assert.equal(fx.assigneesFor(g, '2026-09-20').map((m) => m.name).join(','), '阿青,小北', '3 人每轮 2 人的周期是 3 轮，之后回到起点');
  // 单人视角仍是第一个（兼容旧调用点）
  assert.equal(fx.assigneeFor(g, '2026-09-18')?.name, '老陈');
  // perRound > 成员数：同一人会出现多次，去重保序，不能崩
  const small = fx.normalizeGroup(GROUP({ periodDays: 1, perRound: 4, members: MEMBERS.slice(0, 2) }), '2026-09-17');
  assert.equal(fx.assigneesFor(small, '2026-09-17').map((m) => m.name).join(','), '阿青,小北', '每轮 4 人但只有 2 人 → 去重后就是这 2 人');
  // 步进 = perRound：与成员数互质时窗口才会滑动（4 ≡ 0 (mod 2)，起点恒定是数学事实，不是 bug）；
  // 用 3 人档验证滑动：起点 3 ≡ 1 (mod 2)
  const slide = fx.normalizeGroup(GROUP({ periodDays: 1, perRound: 3, members: MEMBERS.slice(0, 2) }), '2026-09-17');
  assert.equal(fx.assigneesFor(slide, '2026-09-18').map((m) => m.name).join(','), '小北,阿青', 'perRound 与成员数互质时窗口正常滑动');
  // 周期 > 1 时同一轮内每天都同一批人
  const weekly = fx.normalizeGroup(GROUP({ periodDays: 7, perRound: 2 }), '2026-09-17');
  assert.equal(fx.assigneesFor(weekly, '2026-09-20').map((m) => m.name).join(','), '阿青,小北', '周期内每天沿用同一批人');
  assert.equal(fx.assigneesFor(weekly, '2026-09-24').map((m) => m.name).join(','), '老陈,阿青', '下一轮才换批');
}

/* 7.3 多人临时换人：override 双格式 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  // 多人 = 数组（桌面端写入）
  const multi = fx.normalizeGroup(GROUP({ periodDays: 7, perRound: 2, overrides: { '2026-09-17': ['mC', 'mA'] } }), '2026-09-17');
  assert.equal(fx.assigneesFor(multi, '2026-09-17').map((m) => m.name).join(','), '老陈,阿青', '多人数组 override 按写入顺序生效');
  assert.equal(fx.assigneesFor(multi, '2026-09-19').map((m) => m.name).join(','), '老陈,阿青', '周期内沿用同一次换人');
  assert.equal(fx.assigneesFor(multi, '2026-09-24').map((m) => m.name).join(','), '老陈,阿青', '下一轮回到正常排班（轮 1 = 起点 2 → 老陈、阿青）');
  assert.ok(fx.overrideHits(multi, '2026-09-17').length === 2, 'overrideHits 返回完整替补名单');
  // 单人 = 字符串（历史格式，旧数据零迁移可读）
  const single = fx.normalizeGroup(GROUP({ periodDays: 7, perRound: 2, overrides: { '2026-09-17': 'mC' } }), '2026-09-17');
  assert.equal(fx.assigneesFor(single, '2026-09-17').map((m) => m.name).join(','), '老陈', '字符串 override = 本轮换成他一个人');
  // 混合失效：数组里有人已不在名单 → 滤掉他，剩下的照常生效
  const partial = fx.normalizeGroup(GROUP({ periodDays: 7, perRound: 2, overrides: { '2026-09-17': ['mGone', 'mB'] } }), '2026-09-17');
  assert.equal(fx.assigneesFor(partial, '2026-09-17').map((m) => m.name).join(','), '小北', '失效的 id 要过滤掉，不挡其他人');
  // 全部失效 → 退回正常排班，不算换人
  const gone = fx.normalizeGroup(GROUP({ periodDays: 7, perRound: 2, overrides: { '2026-09-17': ['mGone', 'mGone2'] } }), '2026-09-17');
  assert.equal(fx.assigneesFor(gone, '2026-09-17').map((m) => m.name).join(','), '阿青,小北', 'override 全部失效时退回原排班');
  assert.equal(fx.overrideHits(gone, '2026-09-17').length, 0, '全部失效不算换人');
  // 数组去重：同一 id 写两遍只算一次
  const dup = fx.normalizeGroup(GROUP({ periodDays: 7, overrides: { '2026-09-17': ['mC', 'mC'] } }), '2026-09-17');
  assert.equal(fx.overrideHits(dup, '2026-09-17').length, 1, 'override 数组里的重复 id 要去重');
}

/* 7.4 snapshot / 提醒 / 任务都带完整多人名单 */
{
  const { fx } = bootPlugin({ today: '2026-09-17' });
  const g = fx.normalizeGroup(GROUP({ periodDays: 7, perRound: 2 }), '2026-09-17');
  const s = fx.snapshot(g);
  assert.equal(s.per, 2, 'snapshot 带出每轮人数');
  assert.equal(s.currentAll.map((m) => m.name).join(','), '阿青,小北', '当前当班 = 一批人');
  assert.equal(s.nextWhoAll.map((m) => m.name).join(','), '老陈,阿青', '下一轮 = 滑动窗口的下一批');
  assert.equal(s.rows.map((r) => r.whoAll.map((m) => m.name).join('、')).join('|'), '老陈、阿青|小北、老陈|阿青、小北|老陈、阿青|小北、老陈|阿青、小北', '轮次表每行是完整的名单（从轮 1 起：起点 2 → 1 → 0 循环）');
  assert.equal(s.rows[0].swapped, false, '没有换人时不该标「换人」');
  // 多人 override 时 rows / snapshot 要标「换人」（rows[0] 是下一轮，override 要写在那一轮的起始日上）
  const swapped = fx.snapshot(fx.normalizeGroup(GROUP({ periodDays: 7, perRound: 2, overrides: { '2026-09-24': ['mC', 'mA'] } }), '2026-09-17'));
  assert.equal(swapped.rows[0].swapped, true, '多人数组 override 也要标「换人」');
  assert.equal(swapped.rows[0].whoAll.map((m) => m.name).join(','), '老陈,阿青', '该轮当班 = 换上的名单');

  // 提醒文案带全部当班人
  const { c } = bootPlugin({ seed: seed({ groups: [GROUP({ periodDays: 1, perRound: 2, remindTime: '00:00' })] }), today: '2026-09-17' });
  await settle();
  assert.equal(c.notified.length, 1);
  assert.match(c.notified[0], /阿青、小北/, '提醒里必须是完整名单，不能只报第一个人');

  // 加入今日任务：多人名字用「、」连接
  const { fx: fx2, c: c2 } = bootPlugin({ seed: quietSeed({ groups: [GROUP({ perRound: 2, remindEnabled: false })] }), today: '2026-09-17' });
  await settle();
  await fx2.load();
  await fx2.addTodayTask(fx2.state.groups[0]);
  assert.equal(c2.created.length, 1);
  assert.equal(c2.created[0].title, '值日 · 阿青、小北', '任务标题 = 轮换名 + 全部当班人');
}

/* 7.5 渲染：每轮人数设置、多人当班与勾选式换人 */
{
  const { fx } = bootPlugin({ seed: quietSeed({ groups: [GROUP({ periodDays: 7, perRound: 2, remindEnabled: false })] }), today: '2026-09-17' });
  await settle();
  await fx.load();
  const host = fakeEl('div');
  await fx.render(host);
  await settle();
  const html = host.innerHTML;
  assert.match(html, /class="dd-multi"/, '多人当班时名字要用小一号的字（dd-multi）');
  assert.match(html, /每轮 2 人/, 'kicker 必须标出每轮人数');
  assert.match(html, /<b class="dd-multi">阿青、小北<\/b>/, '首页显示完整的当班名单');
  assert.match(html, /data-perround="2"/, '「每轮人数」快捷档要渲染成 chips');
  assert.match(html, /data-perround="3"/, '每轮人数快捷档要有 3 人档');
  assert.match(html, /data-perround-custom/, '每轮人数要有自定义输入');
  assert.match(html, /data-swap-pick/, '换人必须是勾选式（可多选）');
  assert.match(html, /换成所选/, '换人按钮文案 = 换成所选');
  // 换过之后：勾选态落在换上的名单，「原 X」是正常排班的那批
  const swapped = bootPlugin({ seed: quietSeed({ groups: [GROUP({ periodDays: 7, perRound: 2, remindEnabled: false, overrides: { '2026-09-17': ['mC', 'mA'] } })] }), today: '2026-09-17' });
  await settle();
  await swapped.fx.load();
  const host2 = fakeEl('div');
  await swapped.fx.render(host2);
  await settle();
  assert.match(host2.innerHTML, /<b class="dd-multi">老陈、阿青<\/b>/, '换人后显示换上的名单');
  assert.match(host2.innerHTML, /已换人 · 原 阿青、小北/, '「原」必须显示正常排班的整批人');
  assert.match(host2.innerHTML, /data-swap-clear/, '有换人记录时要有撤销入口');
}

/* ── 八、标签右键菜单：整组复制与导入成员 ── */
/* 8.1 duplicateGroup：整组原样复制，但 id 必须全部重新生成。
   共享成员 id 是这里唯一的致命错误 —— 「本轮换人」和「移除某人」都按 id 找 person，
   两组共用 m 开头的同一批 id 时，在副本里换人会把原组的排班一起改掉。 */
{
  const A = GROUP({
    id: 'gA', name: '宿舍值日', remindEnabled: false, periodDays: 3, perRound: 2,
    startDate: '2026-09-10', sound: 'chime', remindTime: '07:30',
    overrides: { '2026-09-17': 'mB' }, lastNotified: '2026-09-17',
    removed: [{ id: 'mX', name: '已走的人' }],
  });
  const B = GROUP({ id: 'gB', name: '公区卫生', remindEnabled: false, members: [{ id: 'p1', name: '甲' }] });
  const { fx, storage } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  const created = await fx.duplicateGroup('gA');
  assert.ok(created, '复制应返回新那一组');

  // 规则原样带走：相位一致才是「同一批人、另一件事」
  assert.equal(created.periodDays, 3, '周期要带走');
  assert.equal(created.perRound, 2, '每轮人数要带走');
  assert.equal(created.startDate, '2026-09-10', '起始日必须带走 —— 两组才会在同一天换人');
  assert.equal(created.remindTime, '07:30');
  assert.equal(created.sound, 'chime');
  assert.equal(created.remindEnabled, false, '提醒开关的状态（含关掉）也要带走');

  // 名字带走、id 全新
  assert.equal(created.members.map((m) => m.name).join(','), '阿青,小北,老陈', '成员顺序与名字要带走');
  for (const m of created.members) {
    assert.ok(!MEMBERS.some((x) => x.id === m.id), `副本成员 ${m.name} 的 id 必须重新生成，否则两组共享同一人`);
    assert.ok(m.id, '副本成员必须有 id，否则改名/移除会命中 undefined');
  }
  assert.equal(created.removed.length, 1, '「已移除」名单也带走（恢复时能找回名字）');
  assert.ok(!created.removed.some((m) => m.id === 'mX'), '「已移除」的 id 同样要重新生成');
  assert.equal(Object.keys(created.overrides).length, 0, '换人记录必须清空 —— 它记的是原组的成员 id，端过来全是悬空引用');
  assert.equal(created.lastNotified, '', '提醒标记清空，否则副本当天不会再提醒当班的人');
  assert.notEqual(created.id, 'gA');

  // 原组一点不能动
  const origin = fx.state.groups.find((x) => x.id === 'gA');
  assert.equal(Object.entries(origin.overrides).map(([k, v]) => `${k}=${v}`).join(','), '2026-09-17=mB', '复制不能吃掉原组的换人记录');
  assert.equal(origin.lastNotified, '2026-09-17');
  assert.equal(origin.members.map((m) => m.id).join(','), 'mA,mB,mC', '原组成员 id 不能被换掉');

  // 位置与选中态：紧跟源组，而不是甩到列表末尾
  const ids = fx.state.groups.map((x) => x.id);
  assert.equal(ids.slice(0, 2).join(','), `gA,${created.id}`, '副本要紧跟在源组后面');
  assert.equal(ids[2], 'gB', '原有的后面那组顺位后移，不能被顶掉');
  assert.equal(fx.state.activeId, created.id, '复制完要切到副本，才接得上「自动改名」');
  assert.equal(storage.get('groups').length, 3, '必须落盘');
}

/* 8.2 副本名字自动避开重名：截断要留出后缀的位置，不能退化成和源组同名 */
{
  const { fx } = bootPlugin({ seed: { groups: [GROUP({ id: 'gA', name: '宿舍值日', remindEnabled: false })], activeId: 'gA' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  assert.equal((await fx.duplicateGroup('gA')).name, '宿舍值日 2');
  assert.equal((await fx.duplicateGroup('gA')).name, '宿舍值日 3', '同名已被占时往后取号');

  // 满 NAME_MAX 的名字：把本体截短来腾出「 2」，而不是整名撞车
  const longName = '一二三四五六七八九十甲乙';
  assert.equal(longName.length, fx.NAME_MAX);
  const { fx: fx2 } = bootPlugin({ seed: { groups: [GROUP({ id: 'gL', name: longName, remindEnabled: false })], activeId: 'gL' }, today: '2026-09-17' });
  await settle();
  await fx2.load();
  const copied = await fx2.duplicateGroup('gL');
  assert.equal(copied.name, '一二三四五六七八九十 2', '超长名字要截本体留出后缀，不能和源组重名');
  assert.ok(copied.name.length <= fx2.NAME_MAX, '副本名不能突破 NAME_MAX');
}

/* 8.3 duplicateGroup 的边界：上限与不存在的组都要拒 */
{
  const many = Array.from({ length: 12 }, (_, i) => GROUP({ id: `g${i}`, name: `组${i}`, remindEnabled: false }));
  const { fx } = bootPlugin({ seed: { groups: many, activeId: 'g0' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  assert.equal(fx.state.groups.length, fx.GROUP_MAX, '种子数据应正好铺满上限');
  assert.equal(await fx.duplicateGroup('g0'), null, '到 GROUP_MAX 时复制必须返回 null，由调用方提示');
  assert.equal(fx.state.groups.length, fx.GROUP_MAX, '被拒时不能悄悄塞进第 13 组');
  const { fx: fx2 } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await fx2.load();
  assert.equal(await fx2.duplicateGroup('不存在'), null, '找不到那组时返回 null 而不是抛异常');
}

/* 8.4 importMembers：按名字去重追加到末尾，id 一律新建 */
{
  const target = GROUP({ id: 'gT', name: '公区值日', remindEnabled: false, members: [{ id: 't1', name: '阿青' }] });
  const source = GROUP({ id: 'gS', name: '宿舍值日', remindEnabled: false, members: [{ id: 'mB', name: '小北' }, { id: 'mC', name: '老陈' }, { id: 'mA', name: '阿青' }] });
  const { fx, storage } = bootPlugin({ seed: { groups: [target, source], activeId: 'gT' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  const n = await fx.importMembers('gT', 'gS');
  assert.equal(n, 2, '阿青已在名单里，只该补进小北和老陈');
  const g = fx.state.groups.find((x) => x.id === 'gT');
  assert.equal(g.members.map((m) => m.name).join(','), '阿青,小北,老陈', '已有的人顺序不动，新的人按源组顺序追加到末尾');
  assert.equal(g.members[0].id, 't1', '原有的那位连 id 都不能变，否则过去的轮次会指错人');
  for (const m of g.members.slice(1)) assert.ok(!['mA', 'mB', 'mC', 't1'].includes(m.id), '导入的成员必须新建 id —— 复用源组 id 会让两组共享同一人');
  assert.equal(storage.get('groups').find((x) => x.id === 'gT').members.length, 3, '导入结果必须落盘，不是只改了内存');
  assert.equal(fx.state.activeId, 'gT', '导入不该顺手切走当前组');

  assert.equal(await fx.importMembers('gT', 'gS'), 0, '再导一次一个人也不会重复');
  assert.equal(await fx.importMembers('gT', 'gT'), 0, '不能从自己导');
  assert.equal(await fx.importMembers('gT', '查无此组'), 0, '源组不存在返回 0 而不是抛异常');
  assert.equal(await fx.importMembers('查无此组', 'gS'), 0, '目标组不存在同样返回 0');
}

/* 8.5 导入上限：夹到 MEMBER_MAX，不能把名单撑爆 */
{
  const target = GROUP({
    id: 'gT', name: '目标', remindEnabled: false,
    members: Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, name: `旧${i}` })),
  });
  const source = GROUP({
    id: 'gS', name: '源', remindEnabled: false,
    members: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `新${i}` })),
  });
  const { fx } = bootPlugin({ seed: { groups: [target, source], activeId: 'gT' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  assert.equal(fx.MEMBER_MAX, 16, '上限本身要钉住，否则下面的算式失去意义');
  const n = await fx.importMembers('gT', 'gS');
  assert.equal(n, fx.MEMBER_MAX - 14, '14 + 8 会超上限，只该补到 MEMBER_MAX');
  assert.equal(fx.state.groups.find((x) => x.id === 'gT').members.length, fx.MEMBER_MAX, '成员数必须夹在 MEMBER_MAX');
}

/* 8.6 菜单渲染：五项动作 + 「导入成员」的二级选组 */
{
  const A = GROUP({ id: 'gA', name: '宿舍值日', remindEnabled: false });
  const B = GROUP({ id: 'gB', name: '公区卫生', remindEnabled: false });
  const { fx } = bootPlugin({ seed: { groups: [A, B], activeId: 'gA' }, today: '2026-09-17' });
  await settle();
  await fx.load();
  fx.tabMenu = { id: 'gB', x: 40, y: 60, step: '' };
  const html = fx.tabMenuHtml();
  assert.match(html, /data-tab-menu/, '菜单根节点要有 data-tab-menu，收起逻辑靠它判断「点的是菜单自身」');
  assert.match(html, /role="menu"/);
  assert.match(html, /公区卫生/, '标题要说清操作的是哪一套，别右键错了才发现');
  for (const act of ['switch', 'rename', 'duplicate', 'import', 'remove']) {
    assert.ok(html.includes(`data-tab-act="${act}"`), `菜单必须有「${act}」动作`);
  }
  assert.ok(!/data-group=/.test(html), '菜单项不能复用标签的 data-group 标记，否则事件委托会先命中切组分支');
  assert.ok(!/data-group-del/.test(html), '菜单项也不能复用卡片的 data-group-del 标记，同理');
  assert.match(html, /left:40px;top:60px/, '菜单按传入的视口坐标定位');

  // 二级：点「导入成员」后列出别的组，当前组自己不出现在候选里
  fx.tabMenu = { id: 'gB', x: 40, y: 60, step: 'import' };
  const sub = fx.tabMenuHtml();
  assert.match(sub, /data-import-from="gA"/, '二级菜单要列出可导入的源组');
  assert.ok(!/data-import-from="gB"/.test(sub), '不能把当前组列为导入源');
  assert.match(sub, /取消/, '二级菜单必须有退出入口');
  assert.ok(!/data-tab-act="rename"/.test(sub), '二级菜单不再重复一级动作');

  // 只有一套轮换时：没有别的组可导，也没有可删的余地
  const { fx: only } = bootPlugin({ seed: quietSeed(), today: '2026-09-17' });
  await settle();
  await only.load();
  only.tabMenu = { id: only.state.groups[0].id, x: 10, y: 10, step: '' };
  const one = only.tabMenuHtml();
  assert.match(one, /data-tab-act="remove"[^>]*disabled|data-tab-act="remove" disabled/, '只剩一套时删除项要禁用（与卡片按钮同一道守卫）');
  const oneSub = (() => { only.tabMenu = { ...only.tabMenu, step: 'import' }; return only.tabMenuHtml(); })();
  assert.ok(!/data-import-from=/.test(oneSub), '没有别的组时二级菜单不该列出任何源');
}

/* 8.7 菜单的源码不变量：定位、收起、长按 */
assert.match(PLUGIN_SRC, /addEventListener\("contextmenu"/, '标签必须接 contextmenu');
assert.match(PLUGIN_SRC, /e\.preventDefault\(\)/, '右键要压掉浏览器原生菜单');
assert.match(PLUGIN_SRC, /function openTabMenu\(/, '必须有 openTabMenu()');
assert.match(PLUGIN_SRC, /function closeTabMenu\(\) \{ if \(!tabMenu\) return; tabMenu = null; paint\(\); \}/,
  'closeTabMenu 必须幂等（没开时直接返回），否则每次 pointerdown 都白重绘一遍');
assert.match(PLUGIN_SRC, /\$\{tabMenu \? tabMenuHtml\(\) : ""\}/, 'paint() 必须渲染菜单');
assert.match(PLUGIN_SRC, /window\.innerWidth[\s\S]{0,120}--sar|innerWidth[\s\S]{0,200}\) - sar -/,
  '夹取右边界必须减掉 --sar，innerWidth 是从屏幕角量的，Android 导航栏会裁掉菜单');
for (const v of ['--sat', '--sab', '--sal', '--sar']) {
  assert.match(PLUGIN_SRC, new RegExp(`px\\("${v}"\\)`),
    `菜单夹取必须读 ${v}，缺一条边就有边被系统栏压住（铁律四）`);
}
assert.match(PLUGIN_SRC, /addEventListener\("pointerdown"/, '长按入口挂在 pointerdown');
assert.match(PLUGIN_SRC, /550/, '长按阈值 550ms：短于它当普通点击，长于它才弹菜单');
assert.match(PLUGIN_SRC, /longPressed/, '长按弹菜单后必须吞掉随后的 click，否则顺带把组切走了');
assert.match(PLUGIN_SRC, /if \(longPressed\) \{ longPressed = false; return; \}[\s\S]{0,240}tabMenu = null/,
  '菜单开着时点标签要把浮层一起收起 —— 只切组会留下一个指向旧组的菜单（document 上的收起监听刻意放过标签点击）');
assert.match(PLUGIN_SRC, /\.dd-tabmenu\{[^}]*position:fixed/, '菜单是 fixed 浮层');
assert.match(PLUGIN_SRC, /const promptFn = \(/, '重命名走 promptFn 兜底，不能裸调 window.prompt');

/* 8.8 小程序端同语义实现 + 「⋯」入口 */
assert.match(miniRuntime, /function ddDuplicateGroup\(/, '小程序要有同语义的 ddDuplicateGroup');
assert.match(miniRuntime, /function ddImportMembers\(/, '小程序要有同语义的 ddImportMembers');
assert.match(miniPage, /onDdGroupMenu\(\) \{|onDdGroupMenu\(e\) \{/, '页面必须有 onDdGroupMenu');
assert.match(miniPage, /wx\.showActionSheet/, '「⋯」用 ActionSheet 承载同一组动作');
assert.match(miniWxml, /bindtap="onDdGroupMenu"/, 'WXML 标签上必须有「⋯」入口');

/* 8.9 小程序端真跑：两端各一份实现，逐字段钉住同语义（防「桌面改了小程序没跟」） */
{
  const seed = () => ([
    {
      id: 'gA', name: '宿舍值日', startDate: '2026-09-10', periodDays: 3, perRound: 2,
      remindEnabled: false, remindTime: '07:30', sound: 'chime',
      members: [{ id: 'mA', name: '阿青' }, { id: 'mB', name: '小北' }],
      removed: [{ id: 'mZ', name: '走的人' }], overrides: { '2026-09-17': 'mB' }, lastNotified: '2026-09-17',
    },
    {
      id: 'gB', name: '公区卫生', startDate: '2026-09-10', periodDays: 7, perRound: 1,
      remindEnabled: true, remindTime: '08:00', sound: 'beep',
      members: [{ id: 'p1', name: '甲' }], removed: [], overrides: {}, lastNotified: '',
    },
  ]);
  const out = mini.ddDuplicateGroup(mini.ddGroups(seed(), '2026-09-17'), 'gA', '2026-09-17');
  assert.ok(out, '小程序端复制要返回新列表');
  const copy = out.created;
  assert.equal(copy.name, '宿舍值日 2', '副本名规则要和桌面端一致');
  assert.equal(copy.startDate, '2026-09-10', '起始日带走，两端同相位');
  assert.equal(copy.periodDays, 3);
  assert.equal(copy.perRound, 2);
  assert.equal(copy.remindEnabled, false, '「提醒已关掉」不能被归一化偷偷打开');
  assert.equal(copy.remindTime, '07:30');
  assert.equal(copy.sound, 'chime');
  assert.equal(copy.members.map((m) => m.name).join(','), '阿青,小北');
  assert.ok(!copy.members.some((m) => m.id === 'mA' || m.id === 'mB'), '成员 id 必须重新生成（与桌面端同一条规矩）');
  assert.equal(copy.removed.length, 1, '「已移除」名单也带走');
  assert.ok(!copy.removed.some((m) => m.id === 'mZ'), '「已移除」的 id 同样重新生成');
  assert.equal(Object.keys(copy.overrides).length, 0, '换人记录清空，端过来全是悬空引用');
  assert.equal(copy.lastNotified, '', '提醒标记清空');
  assert.equal(out.groups.map((g) => g.id).slice(0, 2).join(','), `gA,${copy.id}`, '紧跟源组插入');
  assert.equal(out.activeId, copy.id, '复制完切到副本');

  const full = mini.ddGroups(Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, name: `组${i}` })), '2026-09-17');
  assert.equal(full.length, 12);
  assert.equal(mini.ddDuplicateGroup(full, 'g0', '2026-09-17'), null, '到 DD_GROUP_MAX 返回 null');
  assert.equal(mini.ddDuplicateGroup(full, '查无此组', '2026-09-17'), null, '找不到那组返回 null');
  assert.equal(mini.ddCopyName('一二三四五六七八九十甲乙', [{ name: '一二三四五六七八九十甲乙' }]),
    '一二三四五六七八九十 2', '满 NAME_MAX 的名字要截本体腾出后缀，两端一致');

  const gl = mini.ddGroups(seed(), '2026-09-17');
  const imp = mini.ddImportMembers(gl, 'gB', 'gA');
  assert.equal(imp.added, 2, '补进阿青和小北');
  const dest = imp.groups.find((g) => g.id === 'gB');
  assert.equal(dest.members.map((m) => m.name).join(','), '甲,阿青,小北', '已有的人不动，新的人按源组顺序追加到末尾');
  assert.equal(dest.members[0].id, 'p1', '原有成员的 id 不能动，否则过去的轮次会指错人');
  assert.ok(!dest.members.slice(1).some((m) => m.id === 'mA' || m.id === 'mB'), '导入的成员必须新建 id');
  assert.equal(mini.ddImportMembers(imp.groups, 'gB', 'gA').added, 0, '再导一次一个人也不会重复');
  assert.equal(mini.ddImportMembers(gl, 'gB', 'gB').added, 0, '不能自己导给自己');
  assert.equal(mini.ddImportMembers(gl, 'gB', '查无此组').added, 0, '源组不存在返回 0 而不是抛异常');
  assert.equal(imp.groups.find((g) => g.id === 'gA').members.length, 2, '源组一点不能动');
  assert.equal(imp.groups.find((g) => g.id === 'gA').overrides['2026-09-17'], 'mB', '导入不能改掉源组的换人记录');

  // 上限：夹到 DD_MEMBER_MAX（与桌面端 MEMBER_MAX 同一个数）
  const bigTarget = { id: 'gT', name: '目标', members: Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, name: `旧${i}` })) };
  const bigSource = { id: 'gS', name: '源', members: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `新${i}` })) };
  const capped = mini.ddImportMembers(mini.ddGroups([bigTarget, bigSource], '2026-09-17'), 'gT', 'gS');
  assert.equal(capped.added, 2, '14 + 8 会超上限，只该补到 16');
  assert.equal(capped.groups.find((g) => g.id === 'gT').members.length, 16, '成员数必须夹在 DD_MEMBER_MAX');
}

console.log('PASS: dorm-duty 多套轮换互不串台、旧数据迁移不丢字段、轮换切段（周期 1/3/7/14）、换人只影响本轮、逐组提醒且各自去重、坏时刻不再静默失效、双实例与停用自终止、组增删改与上限、空态与多组渲染、多人值日（perRound 滑动窗口 + override 双格式 + 多人提醒/任务/渲染）、标签右键菜单（整组复制换新 id + 清换人记录 + 按名字去重导入 + 长按与夹取）');
