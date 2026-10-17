import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* 学习通卡片颜色标记 v2.19.0：右键 / 长按上色 + 整组同色规则。
   需求原文（m00001）：「右键卡片可以设置颜色，比如没做完的作业设置成这个颜色，
   所有没做完作业都是这个颜色」—— 后半句才是重点：不是一条条点，而是**规则**，
   以后新同步进来的通知只要命中规则就自动同色。这个测试就是钉住后半句。 */

const source = fs.readFileSync(new URL('../public/plugins/chaoxing-notify/main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../public/plugins/chaoxing-notify/manifest.json', import.meta.url), 'utf8'));

const listeners = {};
const storage = {};
const notifies = [];
const styleTags = [];

const host = {
  isConnected: true, innerHTML: '',
  addEventListener: (type, fn) => { listeners[type] = fn; },
  querySelector: () => null,
};

const viewport = { w: 390, h: 780 };
const insets = { '--sat': '24', '--sab': '48', '--sal': '0', '--sar': '0' };

const context = vm.createContext({
  console, URL, Set, Map, Date, JSON, Number, String, Array, Object, Promise, RegExp, Math, atob,
  // 长按那条 520ms 定时器同步触发（否则测试要真等半秒）；其余定时器压到 5ms 并 unref
  setTimeout: (fn, ms) => {
    if (ms >= 400 && ms <= 600) { fn(); return 0; }
    const t = setTimeout(fn, Math.min(ms, 5)); t.unref?.(); return t;
  },
  clearTimeout,
  getComputedStyle: () => ({ getPropertyValue: (v) => insets[v] ?? '' }),
  window: {
    innerWidth: viewport.w, innerHeight: viewport.h,
    addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: () => ({ matches: true }),
  },
  document: {
    documentElement: {},
    getElementById: () => null,
    createElement: () => ({}),
    head: { append: (el) => styleTags.push(String(el.textContent || '')) },
    addEventListener: () => {}, removeEventListener: () => {},
  },
  navigator: { vibrate: () => {} },
  tide: {
    ui: { registerView() {} },
    storage: {
      get: async (k, fallback = null) => (k in storage ? storage[k] : fallback),
      set: async (k, v) => { storage[k] = v; },
    },
    notify: (msg) => { notifies.push(String(msg)); },
    http: { session: async () => 'sid', fetch: async () => ({ status: 200, cookies: [], body: '{}' }) },
    util: { openUrl() {} },
    tasks: { create: () => ({ id: 't' }), update() {}, remove() {} },
    blocks: { create: () => ({}) },
  },
});

vm.runInContext(
  source.replace('  tide.ui.registerView({',
    '  globalThis.cx = {state,CARD_COLORS,COLOR_NONE,HW_SCOPE,catScope,courseScope,courseOf,secOf,pendingWork,'
    + 'scopeHit,scopeLabel,ruleColorFor,colorOf,colorMarked,colorDotHtml,inboxCardHtml,todoCardHtml,applyColor,'
    + 'clearAllColors,openCardMenu,closeCardMenu,colorMenuHtml,scopeOptionsHtml,loadPrefs,paintMain};\n'
    + '  globalThis.cx.mount = (el) => { host = el; ensureStyle(); wire(); paintMain(); };\n'
    + '  globalThis.cx.menuOpen = () => !!cardMenu;\n  tide.registerViewSentinel = true;\n  tide.ui.registerView({'),
  context,
);
const cx = context.cx;
assert.ok(cx && cx.menuOpen);
/* 插件在 vm 隔离域里跑，它的对象原型跟本测试不是同一个 —— 比较前先过一遍 JSON，
   否则 deepStrictEqual 会因为「结构一样但不是同一个原型」直接判红（这是跨域比较的噪音，不是真 bug）。 */
const plain = (v) => JSON.parse(JSON.stringify(v));
const { state, courseOf, secOf, scopeHit, scopeLabel, colorOf, colorDotHtml, inboxCardHtml,
  loadPrefs, mount, menuOpen } = cx;

/* ── 1. 课程名解析：正文固定写「课程名称：X」，历史数据里也有半角冒号 ── */
assert.equal(courseOf({ body: '截止时间：2030-01-01 09:00\n课程名称：C语言程序设计A\n作业名称：新建作业' }), 'C语言程序设计A');
assert.equal(courseOf({ body: '课程名称:C语言程序设计A' }), 'C语言程序设计A', '半角冒号也要认');
assert.equal(courseOf({ body: '没有课程名' }), '');
assert.equal(courseOf({}), '');

/* ── 2. 档位判定：「没做完」= 未截止未提交 + 已逾期未提交 ── */
const now = Date.now();
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
/* statusOf 的键来自 parseWorkRef：raw.rtf_content 里 iframe name 是 base64(encodeURIComponent(JSON)) */
const workIframe = (workId) => {
  const payload = { att_web: { url: `https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=${workId}`, examOrWorkId: workId } };
  return `<iframe name="${Buffer.from(encodeURIComponent(JSON.stringify(payload))).toString('base64')}"></iframe>`;
};
const work = (id, title, dueMs, workId) => ({
  id, title, unread: true, insertTime: 1,
  body: `截止时间：${iso(dueMs)}\n课程名称：C语言程序设计A\n作业名称：新建作业`,
  raw: { content: '', rtf_content: workIframe(workId) },
});
const openWork = work('w-open', '作业：《C语言程序设计A》新建作业', now + 3 * day, 'wk-open');
const lateWork = work('w-late', '作业：《C语言程序设计A》新建作业', now - 3 * day, 'wk-late');
const submittedWork = work('w-submitted', '作业：《C语言程序设计A》已交作业', now + 3 * day, 'wk-submitted');
state.workStatus = { 'wk-submitted': 'grading' };

assert.equal(secOf(openWork), 'open');
assert.equal(secOf(lateWork), 'late');
assert.equal(secOf(submittedWork), 'submitted', '探到已提交的不能算「没做完」');
assert.equal(secOf({ id: 'n', title: '通知', body: '课程名称：X' }), '', '非作业不参与作业档位');
assert.equal(cx.pendingWork(openWork) && cx.pendingWork(lateWork), true);
assert.equal(cx.pendingWork(submittedWork), false);

assert.equal(scopeHit(cx.HW_SCOPE, openWork), true);
assert.equal(scopeHit(cx.HW_SCOPE, lateWork), true);
assert.equal(scopeHit(cx.HW_SCOPE, submittedWork), false);
assert.equal(scopeHit(cx.catScope('作业'), openWork), true);
assert.equal(scopeHit(cx.courseScope('C语言程序设计A'), openWork), true);
assert.equal(scopeHit(cx.courseScope('别的课'), openWork), false);
assert.equal(scopeLabel(cx.HW_SCOPE), '所有没做完的作业');
assert.equal(scopeLabel(cx.courseScope('C语言程序设计A')), '全部「C语言程序设计A」');

/* ── 3. 走真实事件链路：右键 → 选作用范围 → 点颜色 ── */
state.loggedIn = true;
state.inbox = [openWork, lateWork, submittedWork];
mount(host);
assert.ok(styleTags.length, 'ensureStyle 必须注入样式');
const cardNode = (id) => ({ closest: (sel) => (sel === '[data-id]' ? { dataset: { id } } : null) });
const pickNode = (key) => ({ closest: (sel) => (sel === '[data-color-pick]' ? { dataset: { colorPick: key } } : null) });
const scopeNode = (scope) => ({ closest: (sel) => (sel === '[data-color-scope]' ? { dataset: { colorScope: scope } } : null) });

listeners.contextmenu({ target: cardNode('w-open'), clientX: 100, clientY: 200, preventDefault() {} });
assert.equal(menuOpen(), true, '桌面右键必须开出颜色菜单');
assert.match(host.innerHTML, /data-color-menu/, '菜单必须画进宿主容器');
assert.match(host.innerHTML, /left:100px;top:200px/, '菜单坐标按视口算好写进 inline style');
assert.match(host.innerHTML, /所有没做完的作业/, '作业卡片要给出「所有没做完的作业」这个作用范围');
assert.match(host.innerHTML, /全部「C语言程序设计A」/, '正文里有课程名就要给出按课程上色的范围');
assert.match(host.innerHTML, /仅这一条/);
assert.match(host.innerHTML, /cx2-swatches/, '要有色板');

// 切到整组范围；换范围不该关掉菜单，方便接着挑颜色
await listeners.click({ target: scopeNode(cx.HW_SCOPE) });
assert.equal(menuOpen(), true, '切作用范围后菜单要留在原地');
assert.equal(state.colorScope, cx.HW_SCOPE, '上次选的范围要记住，下次打开沿用');

// 挑颜色：整组规则落盘
await listeners.click({ target: pickNode('red') });
assert.equal(menuOpen(), false, '选完颜色菜单收起');
assert.deepEqual(plain(state.colorRules), [{ scope: cx.HW_SCOPE, color: 'red' }]);
assert.deepEqual(plain(storage.colorRules), [{ scope: cx.HW_SCOPE, color: 'red' }]);
assert.equal(storage.colorScope, cx.HW_SCOPE);
assert.equal(state.cardColors.size, 0, '整组上色不该退化成一条条单卡标记');
assert.match(notifies.at(-1), /「所有没做完的作业」2 条已全部标成红/, '要回执清楚改了几条、什么颜色');

/* ── 4. 需求后半句：新同步进来的通知自动同色 ── */
const freshWork = work('w-fresh', '作业：《C语言程序设计A》新建作业', now + 5 * day, 'wk-fresh');
const plainNotice = { id: 'n-plain', title: '课程通知', body: '课程名称：C语言程序设计A\n课程有新资料', unread: true, insertTime: 9 };
state.inbox = [freshWork, openWork, lateWork, submittedWork, plainNotice];

assert.equal(colorOf(freshWork), 'red', '本次同步后才出现的没做完作业必须自动带上同一个颜色');
assert.equal(colorOf(plainNotice), '', '非作业不会被「没做完的作业」规则染色');
assert.match(inboxCardHtml(freshWork), /cx2-marked/, '命中的卡片要有 cx2-marked');
assert.match(inboxCardHtml(freshWork), /style="--cx2-c:#e0523f"/, '颜色只进 --cx2-c，交给 CSS 稀释');
assert.match(inboxCardHtml(freshWork), /cx2-cdot/, '颜色不能只靠颜色传达，要有带颜色名的色点');
assert.match(colorDotHtml(freshWork), /颜色标记：红/);
assert.match(inboxCardHtml(freshWork), /title="本机颜色标记：红/);
assert.doesNotMatch(inboxCardHtml(plainNotice), /cx2-marked/);
assert.doesNotMatch(inboxCardHtml(submittedWork), /cx2-marked/, '已提交的不吃「没做完」规则');

/* ── 5. 单卡压规则；显式清除要能压过规则（否则「只去掉这一条」做不到）── */
const single = state.inbox.find((n) => n.id === 'w-late');
await cx.openCardMenu('w-late', 10, 10);
assert.equal(menuOpen(), true);
await listeners.click({ target: pickNode('blue') });
assert.equal(colorOf(single), 'blue', '单卡颜色优先级高于整组规则');
assert.equal(state.colorRules.length, 1, '单卡上色不该动到规则');
assert.match(inboxCardHtml(single), /--cx2-c:#3b7dd8/);

await cx.openCardMenu('w-late', 10, 10);
assert.equal(menuOpen(), true, '菜单默认沿用上次的作用范围');
await listeners.click({ target: scopeNode('card') });
await listeners.click({ target: pickNode(cx.COLOR_NONE) });
assert.equal(state.cardColors.get('w-late'), cx.COLOR_NONE);
assert.equal(colorOf(single), '', '显式清掉的那一条要压过整组规则，而不是回到规则色');

/* ── 6. 同范围换色只留一条规则；取消规则时组内单卡标记一起清干净 ── */
await cx.openCardMenu('w-open', 10, 10);
await listeners.click({ target: scopeNode(cx.HW_SCOPE) });
await listeners.click({ target: pickNode('green') });
assert.deepEqual(plain(state.colorRules), [{ scope: cx.HW_SCOPE, color: 'green' }], '同范围换色只留一条规则');
assert.equal(colorOf(freshWork), 'green');
assert.match(notifies.at(-1), /「所有没做完的作业」3 条已全部标成绿/);
assert.equal(state.cardColors.has('w-late'), false, '整组上色要顺手清掉组内的单卡标记，否则全组色会被挡住');

await cx.openCardMenu('w-open', 10, 10);
await listeners.click({ target: scopeNode(cx.HW_SCOPE) });
await listeners.click({ target: pickNode(cx.COLOR_NONE) });
assert.deepEqual(plain(state.colorRules), []);
assert.equal(colorOf(freshWork), '', '规则取消后组内卡片一起回到无色');
assert.match(notifies.at(-1), /已取消「所有没做完的作业」的颜色/);

/* ── 7. 一键清空 ── */
await cx.openCardMenu('w-late', 10, 10);
await listeners.click({ target: pickNode('pink') });
assert.equal(state.cardColors.size + state.colorRules.length, 1);
await cx.clearAllColors();
assert.equal(state.cardColors.size, 0);
assert.equal(state.colorRules.length, 0);
assert.match(notifies.at(-1), /清除全部颜色标记/);
assert.ok(storage.colorScope, 'colorScope 也要落盘');

/* ── 8. 落盘 → 读回：坏数据丢掉而不是让整页崩 ── */
storage.cardColors = [['w-open', 'red'], ['w-open-bad', 'nope'], 'garbage', ['w-late', cx.COLOR_NONE]];
storage.colorRules = [{ scope: cx.HW_SCOPE, color: 'teal' }, { scope: 'cat:作业', color: 'bogus' }, null, { color: 'red' }];
storage.colorScope = cx.courseScope('C语言程序设计A');
await loadPrefs();
assert.deepEqual(plain([...state.cardColors]), [['w-open', 'red'], ['w-late', cx.COLOR_NONE]], '非法颜色与坏行要被丢掉');
assert.deepEqual(plain(state.colorRules), [{ scope: cx.HW_SCOPE, color: 'teal' }], '非法规则要被丢掉');
assert.equal(state.colorScope, cx.courseScope('C语言程序设计A'));
assert.equal(cx.colorOf(freshWork), 'teal', '重载后整组规则依然生效');
assert.equal(cx.colorOf(single), '', '重载后单卡的 none 依然压规则');
assert.equal(state.cardColors.get('w-late'), cx.COLOR_NONE);

/* ── 9. 优先级：课程 > 没做完的作业 > 分类（越具体越优先）── */
storage.colorRules = [{ scope: cx.HW_SCOPE, color: 'teal' }, { scope: cx.courseScope('C语言程序设计A'), color: 'violet' }];
await loadPrefs();
assert.equal(cx.colorOf(freshWork), 'violet', '更具体的课程规则要压过「没做完的作业」');
assert.equal(cx.ruleColorFor({ id: 'x', title: '通知', body: '课程名称：别的课' }), '');

/* ── 10. 安全区：fixed 浮层必须自己让开状态栏 / 导航栏，横屏挖孔在侧边 ── */
insets['--sat'] = '24'; insets['--sab'] = '48'; insets['--sal'] = '12'; insets['--sar'] = '16';
viewport.w = 390; viewport.h = 780;
const menuBox = () => {
  const m = host.innerHTML.match(/left:(\d+)px;top:(\d+)px/);
  assert.ok(m, '菜单要带视口坐标');
  return { x: Number(m[1]), y: Number(m[2]) };
};
const MENU_W = 244, MENU_H = 348;

// 右下角弹出：要顶到「让开导航栏 / 右侧挖孔」的那条边界，不能越界
await cx.openCardMenu('w-open', 5000, 5000);
let box = menuBox();
assert.equal(box.x, viewport.w - Number(insets['--sar']) - MENU_W, 'x 夹取必须让开右侧挖孔');
assert.equal(box.y, viewport.h - Number(insets['--sab']) - MENU_H, 'y 夹取必须让开底部导航栏');
assert.ok(box.x + MENU_W <= viewport.w - Number(insets['--sar']));
assert.ok(box.y + MENU_H <= viewport.h - Number(insets['--sab']));
cx.closeCardMenu();

// 左上角弹出：要让开状态栏与左侧挖孔（横屏时挖孔在侧边）
await cx.openCardMenu('w-open', -100, -100);
box = menuBox();
assert.equal(box.x, 8 + Number(insets['--sal']), 'x 下界要让开左侧挖孔');
assert.equal(box.y, 8 + Number(insets['--sat']), 'y 上界要让开状态栏');
cx.closeCardMenu();

/* ── 11. 长按（Android WebView 不一定派发 contextmenu）与 Escape ── */
listeners.pointerdown({ pointerType: 'touch', clientX: 40, clientY: 60, target: cardNode('w-open') });
assert.equal(menuOpen(), true, '触屏长按要能开出同一个菜单');

let stopped = false;
listeners.keydown({ key: 'Escape', target: { matches: () => false }, stopPropagation: () => { stopped = true; } });
assert.equal(menuOpen(), false, 'Escape 收起颜色菜单');
assert.equal(stopped, true, 'Escape 不该继续冒泡去关宿主别的东西');

listeners.pointerdown({ pointerType: 'mouse', clientX: 5, clientY: 5, target: cardNode('w-open') });
assert.equal(menuOpen(), false, '鼠标走右键，左键按住不该弹菜单');
listeners.pointerdown({ pointerType: 'touch', clientX: 5, clientY: 5, target: { closest: () => null } });
assert.equal(menuOpen(), false, '长按空白处不该弹菜单');

/* ── 12. 样式与文案：固定色不跟主题；左边框绝不能用 border 简写 ── */
const css = styleTags.join('\n');
assert.match(css, /\.cx2-card\.cx2-marked\{border-left-color:var\(--cx2-c\)/, '左边框只单写 color');
assert.match(css, /\.cx2-card\.cx2-marked\{[^}]*background:color-mix\(in srgb,var\(--cx2-c\)/);
assert.doesNotMatch(css, /\.cx2-card\.cx2-marked\{[^}]*border:1px/, '绝不能用 border 简写，会吞掉类型色与未读描边');
assert.match(css, /\.cx2-colormenu\{position:fixed/);
assert.match(css, /max-height:calc\(100vh - 16px - var\(--sat, 0px\) - var\(--sab, 0px\)\)/, '浮层高度要让开状态栏与导航栏');
assert.match(css, /@media\(pointer:coarse\)\{\.cx2-swatches button\{min-height:42px\}/, '触屏上色块要够大');
assert.match(source, /getComputedStyle\(document\.documentElement\)\.getPropertyValue\(/, 'fixed 浮层按视口坐标定位，必须读回宿主注入的安全区变量');
for (const side of ['--sat', '--sab', '--sal', '--sar']) {
  assert.ok(source.includes(`px("${side}")`), `四个方向都要取，缺 ${side}（横屏挖孔在侧边）`);
}
assert.match(manifest.description, /右键卡片（手机端长按）可给卡片上色/, '插件描述要写明颜色标记');
assert.equal(manifest.version, '2.19.1', '插件版本必须同步升级');

console.log('PASS: 学习通卡片颜色标记（右键/长按上色、整组规则让新同步的没做完作业自动同色、单卡压规则、持久化校验、浮层安全区与 Escape）');
