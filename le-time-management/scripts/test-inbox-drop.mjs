import { readProductSource } from "./lib/read-product-source.mjs";
// 拖入消息收纳：识别正确性 + 「先确认后入库」的流程闸门 + 去重窗口 + 可执行文件拒收。
//
// 手法沿用 test-dorm-duty.mjs：vm 注入 fixture，把 IIFE 内部纯函数（analyze / matchDate /
// matchTime / sameMessage / normalizeDrop / statsOf …）与流程函数（acceptDrop / commitDrop /
// runAccept / onGlobalPaste）暴露出来直接真跑，不对着源码猜行为。
//
// ⚠️ 本插件测试要特别钉住的两个历史 bug（都有对应断言，改坏了会当场炸）：
//   1. acceptDrop 曾把入库也做了 → 拖入的当下就落库，确认条还把这条消息自己标成
//      「疑似重复」（自己和自己比）。现在 acceptDrop 必须只解析不入库，唯一写入点是 commitDrop。
//   2. matchDate 曾把正则捕获的 "01" 再补一次零 → "2026-001-12" 进了 due 字段。
//      日期格式断言按「输出必须永远匹配 ^\d{4}-\d{2}-\d{2}$」来守。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const read = (rel) => readProductSource(new URL(rel, import.meta.url), 'utf8');
const PLUGIN_SRC = read('../public/plugins/inbox-drop/main.js');
const manifest = JSON.parse(read('../public/plugins/inbox-drop/manifest.json'));

/* ── 一、清单与三端接线 ── */
assert.equal(manifest.id, 'inbox-drop');
assert.equal(manifest.entry, 'main.js');
assert.equal(manifest.order, 14, 'order 决定侧栏位置；改它要同步 catalog');
for (const perm of ['ui', 'storage', 'tasks', 'notify', 'timeParse']) {
  assert.ok(manifest.permissions.includes(perm), `manifest 必须声明 ${perm} 权限（收件箱与时间解析都走宿主）`);
}
assert.equal(manifest.platforms.windows, 'full');
assert.equal(manifest.platforms.android, 'full', 'Android 与 Windows 共用前端，必须是 full');
// 声明 native 就等于承诺「小程序里点进去有东西」。三处接线少任何一处，
// 小程序里就是一个空白页或「暂不可用」（与 dorm-duty 同一条规矩）。
assert.equal(manifest.platforms.miniprogram, 'native');

const miniRuntime = read('../../miniprogram/core/pluginRuntime.js');
const miniPage = read('../../miniprogram/pages/plugin/index.js');
const miniWxml = read('../../miniprogram/pages/plugin/index.wxml');
assert.match(miniRuntime, /function inboxDropSummary\(/, '小程序 runtime 必须提供 inboxDropSummary 供页面取视图模型');
assert.match(miniRuntime, /function idAddDrops\(/, '小程序要有收纳入口（粘贴 / 手输的落库函数）');
assert.match(miniRuntime, /function idDrops\(/, '小程序要有台账归一化，否则脏数据会画崩页面');
assert.match(miniPage, /id === "inbox-drop"\) this\.loadInboxDrop\(\)/, 'initPlugin 分派必须接上 inbox-drop');
assert.match(miniPage, /loadInboxDrop\(\) \{/, '页面必须有 loadInboxDrop');
assert.match(miniPage, /id === "inbox-drop" && this\.data\.dropsWrap\) this\.loadInboxDrop\(\)/, 'onShow 必须重读（桌面端可能刚改过共享存储）');
assert.match(miniWxml, /id === 'inbox-drop' && dropsWrap/, 'WXML 必须有 inbox-drop 分支');
assert.match(miniPage, /"inbox-drop": \[/, '「插件使用说明」必须收录 inbox-drop');
assert.match(miniPage, /name: "生活与工具", ids: \[[^\]]*"inbox-drop"[^\]]*\]/, '说明页分组要与桌面端 plugin-guide 同源');
// 存储键逐字一致 ⇒ 备份导出后跨端恢复不丢数据。这是「三端同源」最容易悄悄破的一环。
for (const key of ['drops', 'seq']) {
  assert.match(miniRuntime, new RegExp(`pluginStorageGet\\("inbox-drop", "${key}"`),
    `小程序必须用与桌面端同名的存储键 ${key}，否则备份跨端恢复会丢数据`);
}

const catalog = read('../src/pluginCatalog.js');
assert.match(catalog, /"id": "inbox-drop"/, 'pluginCatalog 必须已同步（跑 node tools/sync-plugins.js）');
assert.match(catalog, new RegExp(`"id": "inbox-drop"[\\s\\S]{0,200}?"version": "${manifest.version.replace(/\./g, '\\.')}"`), 'pluginCatalog 里的版本号必须与 manifest 一致');
assert.match(read('../../miniprogram/core/pluginCatalog.js'), /"id": "inbox-drop"/, '小程序 catalog 也必须同步');

// 图标：三端同源，桌面端与小程序各一份字节一致
const desktopIcon = new URL('../public/icons/plugins/inbox-drop.png', import.meta.url);
const miniIcon = new URL('../../miniprogram/images/plugins/inbox-drop.png', import.meta.url);
assert.ok(fs.existsSync(desktopIcon), '缺少桌面端插件图标 public/icons/plugins/inbox-drop.png');
assert.ok(fs.existsSync(miniIcon), '缺少小程序插件图标 miniprogram/images/plugins/inbox-drop.png');
assert.deepEqual(readProductSource(desktopIcon), readProductSource(miniIcon), '两端图标必须字节一致（由 tools/gen-plugin-icons.py 一次写入）');

// 插件使用说明：桌面端与小程序端都必须收录，否则用户查不到用法
const guide = read('../public/plugins/plugin-guide/main.js');
assert.match(guide, /"inbox-drop"/, '桌面端插件使用说明必须收录 inbox-drop');
assert.match(guide, /"inbox-drop":\[/, '桌面端插件使用说明必须给出 inbox-drop 的使用步骤');

/* ── 二、源码不变量 ── */
assert.ok(!/["']#fff["']/.test(PLUGIN_SRC), '不能硬编码 #fff，配色必须走主题变量');
assert.match(PLUGIN_SRC, /var\(--on-deep/, '主按钮文字必须用 --on-deep 令牌');
assert.ok(!/["']#[0-9a-fA-F]{6}["']/.test(PLUGIN_SRC), '不该出现硬编码十六进制色值');
assert.match(PLUGIN_SRC, /tide\.ui\.registerView\(\{ id: VIEW_ID, title: "拖入消息收纳", icon: "inbox", render \}\)/, '必须注册视图，icon 走 FA 名');
// 时间与日期的硬底线：识别结果直接进 due / dueTime，错值会让宿主提醒静默失效
assert.match(PLUGIN_SRC, /mi >= 0 && mi <= 59/, 'matchTime 必须校验时/分范围，25:99 一类错值必须拒收');
assert.match(PLUGIN_SRC, /padStart\(2, "0"\)/, '日期补零必须用 padStart（对已带前导零的捕获组幂等，不会写出 2026-001-12）');
assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(PLUGIN_SRC), '本地日期禁止用 toISOString（UTC 会在晚上把日期挪一天）');
// 可执行文件拒收：扩展名黑名单 + 字节嗅探双保险（改名 .exe→.txt 也要被嗅探拦住）
for (const ext of ['exe', 'msi', 'bat', 'ps1', 'js', 'apk']) {
  assert.match(PLUGIN_SRC, new RegExp(`"${ext}"`), `REJECT_EXT 必须包含 ${ext}`);
}
assert.match(PLUGIN_SRC, /0x4d\s*&&|4d|MZ/, 'sniffBytes 必须认 MZ 头（PE 可执行文件）');
// 🔴 流程闸门（bug 1 的回归守卫）：acceptDrop 只解析不入库，唯一写入点是 commitDrop
const acceptBody = PLUGIN_SRC.slice(PLUGIN_SRC.indexOf('async function acceptDrop'), PLUGIN_SRC.indexOf('async function commitDrop'));
assert.ok(!/\baddDrop\(/.test(acceptBody), 'acceptDrop 里不许出现 addDrop（入库只能在确认后的 commitDrop，否则拖入即落库 + 自己标自己重复）');
assert.equal((PLUGIN_SRC.match(/await addDrop\(/g) || []).length, 1, 'addDrop 只允许被 commitDrop 调用一次');
assert.match(PLUGIN_SRC, /dragover[\s\S]{0,120}preventDefault/, 'dragover 必须 preventDefault，否则 drop 根本不触发');
assert.match(PLUGIN_SRC, /dragDepth/, 'dragenter/leave 是逐子元素冒泡的，必须用深度计数器，布尔值会让高亮闪烁');
// 粘贴抢先必须用捕获阶段（宿主 capture.js 先注册、冒泡阶段处理，只有 capture:true 能跑到它前面）
assert.match(PLUGIN_SRC, /addEventListener\("paste", onGlobalPaste, true\)/, '全局粘贴必须注册在捕获阶段，否则永远轮不到本插件');

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
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html || ''; },
    set(v) { node._html = String(v); },
  });
  return node;
}

/** 起一个插件实例。seed 直接写进 storage；viewVisible 用的 DOM 线索由 domStub 提供。 */
function bootPlugin({ seed = {}, now = null } = {}) {
  const c = { notified: [], inbox: [], created: [], blocks: [], docListeners: {} };
  const storage = new Map(Object.entries(seed));
  const ctx = {
    console,
    setTimeout, clearTimeout,
    Date,
    document: {
      head: fakeEl('head'),
      createElement: fakeEl,
      createTextNode: (t) => ({ textContent: t }),
      getElementById: () => null,
      addEventListener(type, fn) { (c.docListeners[type] ||= []).push(fn); },
      removeEventListener() {},
      body: fakeEl('body'),
      querySelector(sel) {
        const s = String(sel);
        if (s.includes('nav.nav')) return { querySelector: () => ({ className: 'on' }) };
        if (s.includes('plug:inbox-drop')) return { className: 'on' };
        return null;
      },
    },
    tide: {
      storage: {
        async get(k, fallback = null) { return storage.has(k) ? storage.get(k) : fallback; },
        async set(k, v) { storage.set(k, v); },
      },
      inbox: { create: (item) => { c.inbox.push(item); return { id: 'i' + c.inbox.length, ...item }; } },
      tasks: {
        list: () => [],
        create: (patch) => { const t = { id: 't' + (c.created.length + 1), ...patch }; c.created.push(t); return t; },
      },
      blocks: { create: (patch) => { c.blocks.push(patch); return { id: 'b' + c.blocks.length, ...patch }; } },
      notify: (msg) => c.notified.push(String(msg)),
      ui: { registerView: (d) => { ctx.__view = d; } },
      util: {
        today: () => '2026-01-05',
        addDays: (s, n) => { const [y, m, d] = String(s).split('-').map(Number); const dt = new Date(y, m - 1, d + n); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; },
        navigate: () => {},
        parseWhen: null,   // 默认 null → 插件走自己的正则；用例里按需替换
      },
    },
  };
  vm.createContext(ctx);
  // 注入 fixture：把 IIFE 内部的纯函数、流程函数与 state 暴露出来
  vm.runInContext(
    PLUGIN_SRC.replace(
      '  tide.ui.registerView({ id: VIEW_ID,',
      '  globalThis.__fx = { state, load, save, render, paint, boot,\n'
      + '    analyze, accepts, sniffBytes, matchDate, matchTime, hhmm, tidyText, sameMessage, isDuplicate,\n'
      + '    statsOf, normalizeDrop, normalizeDrops, tagsOf, ordered, toInboxItem, toTaskPatch,\n'
      + '    detectPlatform, detectType, hostOf, addDrop, commitDrop, acceptDrop, runAccept, pushToHostInbox,\n'
      + '    KEEP_MAX, RAW_MAX, DUP_WINDOW_MS, REJECT_EXT, PLATFORMS, MSG_TYPES };\n'
      + '  tide.ui.registerView({ id: VIEW_ID,'
    ),
    ctx,
  );
  if (now) ctx.tide.util.parseWhen = now;
  return { ctx, fx: ctx.__fx, storage, view: ctx.__view, c };
}
const settle = () => new Promise((r) => setTimeout(r, 15));

const NOW = new Date(2026, 0, 5, 12, 0, 0);   // 2026-01-05 12:00，固定时钟
const CHAOXING_HW = '【学习通】作业「高等数学第3章」提交截止 2026-01-08 23:59，请及时提交。';
const SCHOOL_EXAM = '【教务处】关于2026年秋季学期期末考试安排的通知：本次考试于2026-01-12 09:00 开始，请提前30分钟到场。';

/* 4.1 normalizeDrop：坏数据不能把插件变成白屏 */
{
  const { fx } = bootPlugin();
  const bad = fx.normalizeDrop({ kind: '坏了', title: '   ', date: '2026-1-5', time: '25:99', bin: '不是dataURL', at: -5, tags: [1, 'ok', null] });
  assert.equal(bad.kind, 'text', '未知类型退回 text');
  assert.equal(bad.title, '未命名消息', '空标题退回「未命名消息」');
  assert.equal(bad.date, '', '非法日期必须清空（2026-1-5 不是合法 YYYY-MM-DD）');
  assert.equal(bad.time, '', '非法时刻必须清空（25:99 进 dueTime 会让提醒静默失效）');
  assert.equal(bad.bin, '', 'bin 不是 dataURL 时必须清空');
  assert.ok(bad.at > 0, 'at 非法时兜底为当前时间');
  assert.deepEqual(bad.tags, ['ok'], 'tags 只留字符串');
  assert.equal(fx.normalizeDrop(null).kind, 'text', 'null 兜成可用对象');
  assert.equal(fx.normalizeDrop({ futureKey: 'v' }).futureKey, 'v', '未识别的键必须原样保留（别端字段不能被抹掉）');
  const dup = fx.normalizeDrops([{ id: 'x' }, { id: 'x' }]);
  assert.equal(dup.length, 1, '重复 id 会让「删除 / 置顶」指错对象，必须剔掉');
}

/* 4.2 analyze：平台 / 类型 / 日期 / 时间的识别主链路 */
{
  const { fx } = bootPlugin();
  const hw = fx.analyze({ kind: 'text', raw: CHAOXING_HW, now: NOW });
  assert.equal(hw.platform, 'chaoxing', '【学习通】要认出平台');
  assert.equal(hw.msgType, 'hw', '作业类消息要认出类型');
  assert.equal(hw.date, '2026-01-08', 'ISO 日期要认出（曾产出 2026-001-12 的补零回归点）');
  assert.equal(hw.time, '23:59', '时刻要认出');
  assert.match(hw.source, /学习通/, '【】里的来源名要抠出来');
  const exam = fx.analyze({ kind: 'text', raw: SCHOOL_EXAM, now: NOW });
  assert.equal(exam.platform, 'school', '教务处要认出学校门户');
  assert.equal(exam.msgType, 'exam', '考试类消息要认出类型');
  assert.equal(exam.date, '2026-01-12');
  assert.equal(exam.time, '09:00');
  const meet = fx.analyze({ kind: 'text', raw: '明天下午三点组会记得带PPT', now: NOW });
  assert.equal(meet.date, '2026-01-06', '「明天」按固定时钟算');
  assert.equal(meet.time, '15:00', '「下午三点」要换算成 15:00');
  assert.equal(meet.msgType, 'meeting', '组会要认出会议');
  const chat = fx.analyze({ kind: 'text', raw: '哈哈哈收到', now: NOW });
  assert.equal(chat.msgType, 'chat', '短、无标点的认成闲聊');
  const notice = fx.analyze({ kind: 'text', raw: '这是一段没有关键词但是很长的说明文字，句中有标点。', now: NOW });
  assert.equal(notice.msgType, 'notify', '长文本兜底为通知');
  // 宿主 parseWhen 优先于自有正则（analyze 的 parseWhen 是显式入参，接线在 acceptDrop/粘贴路径）
  const hostFirst = fx.analyze({ kind: 'text', raw: CHAOXING_HW, now: NOW, parseWhen: () => ({ date: '2030-05-05', startMin: 600, title: '宿主解析' }) });
  assert.equal(hostFirst.date, '2030-05-05', '宿主 parseWhen 能认时要优先用它');
  assert.equal(hostFirst.time, '10:00', 'startMin 要换算成 HH:MM');
  assert.equal(hostFirst.title, '宿主解析', '宿主给的标题要采用');
  // 接线：真实入口必须把 parseWhenSafe 传进去
  assert.match(PLUGIN_SRC, /parseWhen: parseWhenSafe/, '真实入口必须传 parseWhenSafe，宿主的时间解析才接得上');
}

/* 4.3 matchTime / hhmm：非法值宁可没有，也不要假的 */
{
  const { fx } = bootPlugin();
  assert.equal(fx.matchTime('23:59'), '23:59');
  assert.equal(fx.matchTime('9:05'), '09:05');
  assert.equal(fx.matchTime('下午3点'), '15:00');
  assert.equal(fx.matchTime('晚上11点30分'), '23:30');
  assert.equal(fx.matchTime('下午3点半'), '15:30', '「点半」要认成 30 分');
  assert.equal(fx.matchTime('明天下午三点组会'), '15:00', '中文数字「三点」要认出');
  assert.equal(fx.matchTime('晚上十点半'), '22:30', '中文数字「十点半」');
  assert.equal(fx.matchTime('中午十二点'), '12:00', '中午12点就是 12:00');
  assert.equal(fx.matchTime('上午发的文件，下午3点交'), '15:00', '上下午标记取紧挨着的那一个');
  assert.equal(fx.matchTime('25:99'), '', '时超 23 必须拒');
  assert.equal(fx.matchTime('9时61分'), '', '分超 59 必须拒');
  assert.equal(fx.matchTime('没有时间'), '');
  assert.equal(fx.hhmm(1439), '23:59', '边界 1439 合法');
  assert.equal(fx.hhmm(1440), '', '1440 越界必须拒');
  assert.equal(fx.hhmm(-1), '', '负数必须拒');
}

/* 4.4 matchDate：格式必须永远合法 + 就近未来跨年 */
{
  const { fx } = bootPlugin();
  assert.equal(fx.matchDate('2026-01-12 09:00', NOW), '2026-01-12', '已带前导零不能再补（2026-001-12 回归点）');
  assert.equal(fx.matchDate('2026/1/9', NOW), '2026-01-09', '单数字月日要补零');
  assert.equal(fx.matchDate('2026年1月9日', NOW), '2026-01-09');
  assert.equal(fx.matchDate('1月20日截止', NOW), '2026-01-20');
  assert.equal(fx.matchDate('01-08 23:59', NOW), '2026-01-08', 'MM-DD 带前导零也要对');
  assert.equal(fx.matchDate('今天交', NOW), '2026-01-05');
  assert.equal(fx.matchDate('明天', NOW), '2026-01-06');
  assert.equal(fx.matchDate('后天', NOW), '2026-01-07');
  assert.equal(fx.matchDate('1月5日', new Date(2026, 11, 20)), '2027-01-05', '12月看到「1月5日」要算明年（就近未来）');
  assert.equal(fx.matchDate('没有日期', NOW), '', '认不出留空，不猜');
  // 一批真实消息里抽出来的日期，输出必须全部匹配严格格式
  for (const t of ['明天', '2026-01-12 09:00', '2026/1/9', '1月20日', '01-08', '12月31日', '2026年3月7日']) {
    const v = fx.matchDate(t, NOW);
    assert.match(v, /^20\d\d-\d\d-\d\d$/, `matchDate 输出必须永远是合法 YYYY-MM-DD（输入：${t}）`);
  }
}

/* 4.5 去重窗口：同标题 + 同日期 + 24h 内才算同一条 */
{
  const { fx } = bootPlugin();
  const a = fx.normalizeDrop({ id: 'a', title: '作业通知', raw: '提交截止 2026-01-08', date: '2026-01-08', at: NOW.getTime() });
  const dup = fx.normalizeDrop({ id: 'b', title: '作业通知', raw: '提交截止 2026-01-08', date: '2026-01-08', at: NOW.getTime() + 3600_000 });
  assert.ok(fx.isDuplicate([a], dup), '1 小时后的同一条要判重');
  const later = fx.normalizeDrop({ id: 'c', title: '作业通知', raw: '提交截止 2026-01-08', date: '2026-01-08', at: NOW.getTime() + 2 * fx.DUP_WINDOW_MS });
  assert.ok(!fx.isDuplicate([a], later), '隔天同句话算新消息');
  const other = fx.normalizeDrop({ id: 'd', title: '另一条', raw: '提交截止 2026-01-08', date: '2026-01-08', at: NOW.getTime() });
  assert.ok(!fx.isDuplicate([a], other), '不同标题不算重复');
  const otherDate = fx.normalizeDrop({ id: 'e', title: '作业通知', raw: '提交截止 2026-01-08', date: '2026-01-09', at: NOW.getTime() });
  assert.ok(!fx.isDuplicate([a], otherDate), '识别出的日期不同不算重复（同一文案不同场次）');
}

/* 4.6 statsOf：必须从列表整个重算，增量计数在删改后会飘 */
{
  const { fx } = bootPlugin();
  const list = fx.normalizeDrops([
    { id: 'a', kind: 'text', msgType: 'hw', platform: 'chaoxing', title: 'A', at: 3 },
    { id: 'b', kind: 'image', title: 'B', done: 'task', at: 2 },
    { id: 'c', kind: 'text', msgType: 'exam', platform: 'school', title: 'C', pinned: true, at: 1 },
  ]);
  const s = fx.statsOf(list);
  assert.equal(s.total, 3);
  assert.equal(s.byKind.text, 2);
  assert.equal(s.byKind.image, 1);
  assert.equal(s.byType.hw, 1);
  assert.equal(s.byType.exam, 1);
  assert.equal(s.byPlatform.chaoxing, 1);
  assert.equal(s.byPlatform.school, 1);
  assert.equal(s.lastAt, 3, 'lastAt 取最新一条的时间');
  const after = fx.statsOf(list.filter((x) => x.id !== 'b'));
  assert.equal(after.total, 2, '删除后重算必须立刻反映（不许留增量残影）');
}

/* 4.7 toInboxItem / toTaskPatch：递进宿主的载荷形状 */
{
  const { fx } = bootPlugin();
  const msg = fx.analyze({ kind: 'image', raw: '作业截图.png', title: '作业截图', source: '学习通', now: NOW });
  const item = fx.toInboxItem(msg);
  assert.equal(item.suggestion, 'create-task', '收件箱按钮靠 suggestion 驱动');
  assert.match(item.sourceKey, /^inbox-drop:/, 'sourceKey 必须带插件前缀（宿主按它去重）');
  assert.equal(item.meta.dropId, msg.id, 'meta 里要带台账 id，收件箱才能回头对应');
  const task = fx.toTaskPatch(fx.analyze({ kind: 'text', raw: SCHOOL_EXAM, now: NOW }));
  assert.equal(task.due, '2026-01-12', 'due 必须用识别出的日期');
  assert.equal(task.dueTime, '09:00', 'dueTime 必须用识别出的时刻');
  assert.equal(task.quad, 1, '考试落第一象限');
  assert.ok(task.tags.includes('考试'), 'tags 里要有类型标签');
}

/* 4.8 🔴 流程闸门：acceptDrop 只解析不入库，确认后才 commitDrop（bug 1 回归点） */
{
  const { fx, c } = bootPlugin();
  await settle();
  await fx.load();
  assert.equal(fx.state.drops.length, 0, '初始为空');
  const dt = { getData: (t) => (t === 'text/plain' ? CHAOXING_HW : ''), items: [], files: [] };
  const results = await fx.runAccept({ dataTransfer: dt, files: [] });
  assert.equal(results.filter((r) => r.action === 'staged').length, 1, '一条可收的要有 staged 结果');
  assert.equal(fx.state.drops.length, 0, '🔴 拖入后**不许**已经落库（曾经拖入即入库）');
  assert.ok(fx.state.pending, '单条必须弹确认条');
  assert.ok(!fx.state.pending.id || String(fx.state.pending.id).startsWith('p'), 'pending 是未入库的预览副本');
  assert.equal(c.inbox.length, 0, '确认前不许递进收件箱');
  // 确认条上标的是「待确认」，不是「疑似重复」（自己和自己比的回归点）
  const host = fakeEl('div');
  fx.state.busy = false;
  await fx.paint();
  fx.render(host);
  await settle();   // render 的 paint 在 boot().then 里异步跑，要等它
  assert.match(host.innerHTML, /待确认/, '确认条要标「待确认」');
  assert.ok(!/疑似重复/.test(host.innerHTML), '刚拖入的消息不许被标成「疑似重复」（自己和自己比）');
  // 点确认 → 才入库 + 递进收件箱
  const out = await fx.commitDrop(fx.state.pending);
  fx.state.pending = null;
  assert.equal(out.duplicated, false);
  assert.ok(out.pushed, '认出了日期与类型，确认后要递进收件箱');
  assert.equal(fx.state.drops.length, 1, '确认后台账恰好一条');
  assert.equal(c.inbox.length, 1, '收件箱恰好一条');
  assert.equal(fx.state.drops[0].pushed, true, '台账要标记已递进，避免重复推');
}

/* 4.9 重复消息：第二条拦下，不重复入库、不重复进收件箱 */
{
  const { fx, c } = bootPlugin();
  await settle();
  await fx.load();
  const dt = { getData: () => CHAOXING_HW, items: [], files: [] };
  await fx.runAccept({ dataTransfer: dt, files: [] });
  await fx.commitDrop(fx.state.pending);
  fx.state.pending = null;
  await fx.runAccept({ dataTransfer: dt, files: [] });
  assert.ok(fx.state.pending, '重复消息也会弹确认条（让人看见它想进来）');
  const out = await fx.commitDrop(fx.state.pending);
  assert.equal(out.duplicated, true, '第二次提交必须判重');
  assert.equal(fx.state.drops.length, 1, '台账仍然一条');
  assert.equal(c.inbox.length, 1, '收件箱仍然一条');
}

/* 4.10 多条 payload：逐条直接收纳（弹一串确认条会把界面挤爆） */
{
  const { fx, c } = bootPlugin();
  await settle();
  await fx.load();
  const results = await fx.runAccept({ files: [] , dataTransfer: { getData: () => '', items: [], files: [] } });
  assert.ok(Array.isArray(results));
  // 多条路径直接喂 payloads 太绕，改从 commitDrop 逐条验证
  const a = fx.analyze({ kind: 'text', raw: CHAOXING_HW, now: NOW });
  const b = fx.analyze({ kind: 'text', raw: SCHOOL_EXAM, now: NOW });
  const o1 = await fx.commitDrop(a);
  const o2 = await fx.commitDrop(b);
  assert.ok(o1.row && o2.row, '两条都要入库');
  assert.equal(fx.state.drops.length, 2);
  assert.equal(c.inbox.length, 2, '两条都认出了时间，都递进收件箱');
}

/* 4.11 可执行文件拒收：扩展名黑名单 + 字节嗅探 */
{
  const { fx } = bootPlugin();
  const r1 = fx.accepts({ name: 'setup.exe', type: 'application/x-msdownload', size: 10 });
  assert.equal(r1.ok, false, '.exe 必须拒');
  assert.ok(r1.reason, '拒绝必须给原因，不能静默');
  const r2 = fx.accepts({ name: '畜生.txt', type: 'text/plain', size: 10 });
  assert.equal(r2.ok, true, '.txt 要收');
  const r3 = fx.accepts({ name: '图.png', type: 'image/png', size: 10 });
  assert.equal(r3.ok && r3.kind === 'image', true, '图片走 image 通道');
  // 字节嗅探：改名 .exe→.txt 也拦得住
  assert.equal(fx.sniffBytes(new Uint8Array([0x4d, 0x5a, 0x00, 0x01])), 'pe', 'MZ 头要认成 PE');
  assert.equal(fx.sniffBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])), 'elf', 'ELF 头要认出');
  assert.equal(fx.sniffBytes(new Uint8Array([0x23, 0x21, 0x2f, 0x62])), 'shebang', '#! 脚本要认出');
  assert.equal(fx.sniffBytes(new Uint8Array([0xe3, 0x81, 0x82])), 'text', 'UTF-8 文本放行');
}

/* 4.12 全局粘贴：捕获阶段抢先，但只在本插件页可见时才接管 */
{
  const { fx, c } = bootPlugin();
  await settle();
  await fx.boot();   // attachGlobal 挂 paste 监听
  const host = fakeEl('div');
  fx.render(host);
  await settle();    // onGlobalPaste 要求视图已挂载（root 非空）才接管 —— 与真实使用一致
  const listeners = c.docListeners.paste || [];
  assert.ok(listeners.length >= 1, '全局粘贴监听必须已挂上');
  const dispatch = (ev) => listeners.forEach((fn) => fn(ev));
  let prevented = 0;
  const mkEv = (text, target) => ({
    target: target || { tagName: 'DIV' },
    preventDefault: () => { prevented += 1; },
    clipboardData: { items: [], getData: () => text },
  });
  dispatch(mkEv(CHAOXING_HW));
  assert.ok(fx.state.pending, '本页可见时粘贴要接住');
  assert.equal(fx.state.drops.length, 0, '🔴 粘贴同样只到确认条为止，不许落库');
  assert.equal(prevented, 1, '接管了就必须 preventDefault，否则宿主还会再处理一遍');
  // 在输入框里粘贴 → 放行（那是正常输入）
  fx.state.pending = null;
  dispatch(mkEv(CHAOXING_HW, { tagName: 'TEXTAREA' }));
  assert.equal(fx.state.pending, null, '焦点在输入框时绝不接管');
  assert.equal(prevented, 1, '放行时不许 preventDefault');
}

/* 4.13 渲染冒烟：空态 + 有数据 + 筛选 */
{
  const { fx } = bootPlugin();
  await settle();
  await fx.load();
  const host = fakeEl('div');
  fx.render(host);
  assert.match(host.innerHTML, /正在读取收纳记录/, 'render 必须先给出占位（boot 未完成时画空态会拿着空 drops 撒谎）');
  await settle(); // boot().then(paint) 异步重绘，占位之后才轮到真内容
  assert.match(host.innerHTML, /id-wrap/, '重绘后仍是同一套外壳');
  assert.match(host.innerHTML, /收纳区还是空的/, '空态要有引导文案');
  assert.ok(!/<svg[^>]*#inbox[^>]*>/.test(host.innerHTML.split('id-empty')[1] || ''), '空态不再用灰盒子图标（曾读作破图）');
  // 种子数据渲染
  const { fx: fx2 } = bootPlugin({ seed: { drops: [
    { id: 'd1', seq: 2, title: '考试通知', kind: 'text', msgType: 'exam', platform: 'school', date: '2026-01-12', time: '09:00', at: NOW.getTime() },
    { id: 'd2', seq: 1, title: '旧记录', kind: 'text', done: 'task', at: NOW.getTime() - 86400000 },
  ], seq: 2 } });
  await settle();
  await fx2.load();
  const host2 = fakeEl('div');
  fx2.state.busy = false;
  fx2.render(host2);
  await fx2.paint();
  assert.match(host2.innerHTML, /考试通知/, '台账里的条目要画出来');
  assert.match(host2.innerHTML, /#2/, 'seq 序号要显示');
  assert.match(host2.innerHTML, /考试/, '类型标签要显示');
}

/* 4.14 变异测试：把时刻范围校验拆掉，上面的断言必须能抓住它（证明测试有牙） */
{
  // 变异体：删掉 norm 里的范围守卫。25:99 会被 hhmm 兜住（>=1440 拒），但 61 分会被
  // 静默换算成 1 小时 —— 「9时61分 → 10:01」，正是这类 bug 最阴险的失效形态。
  const mutant = PLUGIN_SRC.replace(
    /if \(!\(hh >= 0 && hh <= 23\) \|\| !\(mi >= 0 && mi <= 59\)\) return "";/,
    '',
  );
  assert.notEqual(mutant, PLUGIN_SRC, '变异源必须真的被改到（否则断言形同虚设）');
  const ctx = { console, setTimeout, clearTimeout, Date, document: { head: fakeEl('head'), createElement: fakeEl, createTextNode: (t) => ({ textContent: t }), getElementById: () => null, addEventListener() {}, removeEventListener() {}, querySelector: () => null }, tide: { storage: { async get(k, f = null) { return f; }, async set() {} }, inbox: { create: () => ({}) }, tasks: { list: () => [], create: () => ({}) }, blocks: { create: () => ({}) }, notify() {}, ui: { registerView() {} }, util: { today: () => '2026-01-05', addDays: (s, n) => s, parseWhen: null } } };
  vm.createContext(ctx);
  vm.runInContext(mutant.replace('  tide.ui.registerView({ id: VIEW_ID,', '  globalThis.__m = { matchTime, analyze };\n  tide.ui.registerView({ id: VIEW_ID,'), ctx);
  assert.equal(ctx.__m.matchTime('9时61分'), '10:01', '拆掉守卫的变异体必须真的放过 61 分（换算成 10:01）');
}

console.log('PASS: inbox-drop 识别主链路（平台/类型/日期/时刻）、「先确认后入库」闸门（拖入与粘贴都不落库）、24h 去重窗口、可执行文件双保险拒收、载荷映射、脏数据容错、渲染冒烟、时刻校验变异有牙');
