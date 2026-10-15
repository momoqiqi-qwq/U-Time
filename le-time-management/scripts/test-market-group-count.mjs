import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";

/* v0.214.1：绿色组「侧栏 7 条 / 插件中心 1 张卡」的回归闸。
   侧栏是按「视图」成行的（一个插件注册几个视图就几行，shell.js:1227 的 views.length），
   插件中心是按「插件」成卡的。cppu-notify 一个插件就注册了 7 个视图（成绩 / 创新学分 / 获奖名单 /
   请假 / 通知 / 选课 / 一卡通），于是同一个绿色组在侧栏数 7、在插件中心数 1 —— 用户看到的就是
   「绿色组包含许多插件，但在插件组页面仅显示一个」。
   这里锁两件事：①插件中心组头计数与侧栏同口径（条目数，而不是插件数）；②桌面端也不再藏视图入口。 */

const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");
const code = shell.slice(shell.indexOf("  function renderMarket(container)"), shell.indexOf("  // ── 内容区左右滑动"));

assert.match(shell, /groupFoldButton\("plug-group", color, views\.length/, "侧栏组头按视图条数计数");
assert.match(shell, /groupFoldButton\("market-group", color, colorCount\.get\(color\) \|\| 0/, "插件中心组头必须与侧栏同口径");
assert.match(code, /Math\.max\(1, pluginViews\.filter\(\(v\) => v\.pluginId === id\)\.length\)/, "条目数 = 该插件的视图数（至少 1）");
assert.ok(!code.includes("isAndroidRuntime"), "🔴 视图入口与组计数不许按平台分叉：桌面端也要列全");
assert.match(code, /headRefreshers\.set\(color, \(\) => \{/, "组头计数要登记刷新器");
assert.match(code, /cardRefreshers\.forEach\(\(refresh\) => refresh\(\)\);\s*headRefreshers\.forEach\(\(refresh\) => refresh\(\)\)/,
  "🔴 refreshMarketState 的增量分支里必须同时刷组头：只刷卡片会让组头冻在首帧的数字上");

let active = null;
class N {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.attrs = {}; this.dataset = {}; this.children = []; this.parent = null; this.nodeType = 1; this.disabled = Boolean(attrs.disabled); this.classes = new Set(); for (const [k, v] of Object.entries(attrs)) if (v != null) this.setAttribute(k, v); this.append(...children.flat().filter((n) => n != null)); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.classes = new Set(v.split(' ')); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  get classList() { return { add: (...cs) => cs.forEach(c => this.classes.add(c)), remove: (...cs) => cs.forEach(c => this.classes.delete(c)), contains: (c) => this.classes.has(c), toggle: (c, on) => on ? this.classes.add(c) : this.classes.delete(c) }; }
  append(...nodes) { for (const n of nodes) { if (typeof n === 'object') { n.remove(); n.parent = this; } this.children.push(n); } }
  insertBefore(n, b) { n.remove(); n.parent = this; this.children.splice(this.children.indexOf(b), 0, n); }
  replaceChildren(...nodes) { for (const n of this.children) if (typeof n === 'object') n.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  get isConnected() { return this === root || Boolean(this.parent?.isConnected); }
  set textContent(v) { this.replaceChildren(String(v)); } get textContent() { return this.children.map(n => typeof n === 'object' ? n.textContent : n).join(''); }
  matches(s) { if (s.startsWith('.')) return s.slice(1).split('.').every(c => this.classes.has(c)); return s === this.tag; }
  querySelectorAll(s) { const selectors = s.split(',').map(x => x.trim()); return this.children.filter(n => typeof n === 'object').flatMap(n => [...(selectors.some(x => n.matches(x)) ? [n] : []), ...n.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  closest(s) { return s.split(',').some(x => this.matches(x.trim())) ? this : this.parent?.closest(s); }
  addEventListener(k, f) { this.attrs['on' + k] = f; }
  focus() { active = this; }
  getAnimations() { return []; }
  animate() { return { cancel() { } }; }
}
const root = new N('main');
/* 绿色组：一个插件 3 个视图 + 一个插件 2 个视图（正是 cppu-notify 那种形态）；另有一个未分组插件。 */
const regs = ['green-a', 'green-b', 'plain'].map((id, i) => ({ id, source: 'builtin', manifest: { name: id, order: i + 1 } }));
const views = [
  { id: 'green-a-1', pluginId: 'green-a', title: '警大成绩' },
  { id: 'green-a-2', pluginId: 'green-a', title: '警大选课' },
  { id: 'green-a-3', pluginId: 'green-a', title: '警大一卡通' },
  { id: 'green-b-1', pluginId: 'green-b', title: 'B1' },
  { id: 'green-b-2', pluginId: 'green-b', title: 'B2' },
  { id: 'plain-1', pluginId: 'plain', title: 'P1' },
];
const routes = [];
const env = {
  document: { get activeElement() { return active; } },
  el: (...a) => new N(...a),
  S: { pluginState: () => ({ enabled: true }) },
  getRegistry: () => [...regs],
  pluginViews: views,
  pluginDisplayName: (_, n) => n,
  pluginDisplayIcon: () => new N('i'),
  pluginAccent: () => '',
  pluginOrderState: () => [],
  normalizePluginOrder: (ids) => ids,
  pluginColor: (id) => (id === 'green-a' || id === 'green-b' ? 'green' : null),
  isAndroidRuntime: () => false, // 桌面端：改动前这里 viewLinks 恒为 null
  reducedMotion: () => false,
  isSelfActivationKey: () => true,
  faIcon: () => new N('i'),
  switchTo: (id) => routes.push(id),
  toast: () => { },
  flipByKey: (_, opts) => opts.mutate(),
  fadeAway: () => Promise.resolve(),
  openPluginContextMenu: () => { },
  attachMarketCardResize: () => () => { },
  resetMarketCardSize: () => { },
  withSearchGlyph: (input) => new N('div', { class: 'search-field' }, input),
  searchGlyph: (cls) => new N('span', { class: cls || 'search-ico' }),
  setEnabled: async () => { },
  // 组头只在 pluginColor 返回颜色时才渲染（test-market-toggle 里恒为 null，所以那边没有这几个替身）。
  groupFoldButton: (prefix, color, count) => new N('button', { class: `${prefix}-fold`, 'data-color': color },
    new N('span', { class: `${prefix}-count` }, String(count))),
  isGroupCollapsed: () => false,
  toggleGroupCollapsed: () => { },
  groupName: () => '绿色',
  groupColorMeta: () => ({ hex: '#16A34A', label: '绿色' }),
  foldNavGroup: () => { },
  turnChevron: () => { },
  nav: () => { },
};
const module = new Function(...Object.keys(env), `let marketQuery='',marketFilter='all',marketSearchOpen=false,repaintMarket,refreshMarketState; const marketTogglePending=new Set(); ${code}; return { renderMarket, refresh: () => refreshMarketState() };`)(...Object.values(env));
module.renderMarket(root);

const grid = root.querySelector('.market-grid');
const heads = grid.querySelectorAll('.market-group-head');
assert.equal(heads.length, 1, '只给了绿色一个分组色，应该只有一个组头');
assert.equal(heads[0].querySelector('.market-group-count').textContent, '5', '🔴 绿色组要按条目数计数（3 + 2），不是插件数 2');
const cards = grid.querySelectorAll('.mcard');
assert.equal(cards.length, 3, '三张卡：green-a / green-b / plain');
const card = (id) => {
  const found = cards.find((c) => c.attrs['data-card-id'] === id);
  assert.ok(found, `插件 ${id} 的卡片必须存在`);
  return found;
};
const linksOf = (id) => card(id).querySelector('.market-view-links');
assert.equal(linksOf('green-a').children.length, 3, '🔴 桌面端也要列出多视图插件的全部 3 个入口')
assert.equal(linksOf('green-b').children.length, 2);
assert.equal(linksOf('plain'), null, '单视图插件不挂入口行');
assert.deepEqual(linksOf('green-a').children.map((b) => b.attrs['data-plugin-view']), ['green-a-1', 'green-a-2', 'green-a-3']);
assert.ok(linksOf('green-a').children.every((b) => b.disabled === false), '插件启用时入口可点');
assert.ok(card('green-a').classList.contains('has-views'), '多视图卡片要带 has-views（桌面端跨两列放得下入口）');
assert.ok(!card('plain').classList.contains('has-views'), '单视图卡片不跨列');
const event = { stopPropagation() { } };
for (const button of linksOf('green-a').children) button.attrs.onclick(event);
assert.deepEqual(routes, ['plug:green-a-1', 'plug:green-a-2', 'plug:green-a-3'], '每枚入口进自己的视图');

/* 真机现场：插件 main.js 是启动后异步逐个 registerView 的，首帧可能只到位一部分视图。
   onNavChanged → refreshMarketState 在「插件成员没变」时只刷新卡片、不重排网格，
   所以组头计数必须自己也能被推着更新 —— 线上实测就是这个：卡片补成了 7 枚入口、组头仍写 1。 */
views.push({ id: 'green-a-4', pluginId: 'green-a', title: '警大通知' }, { id: 'green-a-5', pluginId: 'green-a', title: '警大请假' });
module.refresh();
assert.equal(heads[0].querySelector('.market-group-count').textContent, '7',
  '🔴 视图陆续注册后组头计数必须跟着涨（5 + 2），不能冻在首帧那个数字上');
assert.equal(linksOf('green-a').children.length, 5, '卡片入口随注册补齐');
assert.deepEqual(linksOf('green-a').children.map((b) => b.attrs['data-plugin-view']).slice(-2), ['green-a-4', 'green-a-5']);

const css = readProductSource(new URL("../src/styles/feature-layouts.css", import.meta.url), "utf8");
assert.match(css, /\.market-view-links \.btn \{ min-height: 44px/, '触屏那套 44px 基础样式要留着');
assert.match(css, /@media \(min-width: 901px\) \{\s*\.market-view-links \{ display: flex/,
  '🔴 桌面端要另给紧凑胶囊样式：7 枚 44px 竖排会把卡片顶成四倍高（实测 364px vs 邻卡 100px）');
assert.ok(css.indexOf('min-height: 24px') > css.indexOf('min-height: 44px'),
  '🔴 桌面覆写必须排在基础规则之后：媒体查询不加特异性，同文件同特异性只能靠顺序取胜（index.html 先加载 styles.css）');
assert.match(css, /@media \(min-width: 901px\) \{[\s\S]*\.market-grid \.mcard\.has-views \{ grid-column: span 2; \}/,
  '🔴 桌面 180px 磁贴的内容宽只有 147px，装不下两枚中文胶囊：多视图卡片要跨两列，否则入口一行一枚把卡片顶成塔');
assert.match(code, /\$\{cardViews\.length > 1 \? " has-views" : ""\}/, '多视图卡片建卡时就带 has-views');
assert.match(code, /card\.classList\.toggle\("has-views", views\.length > 1\)/, '视图数量变化时同步 has-views');

console.log('PASS: the market group header counts entries exactly like the sidebar (a plugin counts every view), keeps up as views register late, every platform lists every view entry, and the desktop entry row stays compact');
