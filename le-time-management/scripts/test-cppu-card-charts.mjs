import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CHART_PALETTE, PIE_PALETTE, chartMonthShift, chartTrend, chartPlaces, placeName,
  chartCategories, chartWeekday, platformTrend, platformPlaces, niceMaxCents, createCardCharts,
  plotWidth, donutWidth,
} from '../public/plugins/cppu-notify/card-charts.js';

// ── 月份位移：跨年、越界都要准 ──────────────────────────────────────────
assert.equal(chartMonthShift('2026-01', -1), '2025-12');
assert.equal(chartMonthShift('2025-12', 1), '2026-01');
assert.equal(chartMonthShift('2026-03', -11), '2025-04');
assert.equal(chartMonthShift('2026-10', 0), '2026-10');
assert.throws(() => chartMonthShift('2026-13', 1), /月份格式/);
assert.throws(() => chartMonthShift('2026-00', 1), /月份格式/);
assert.throws(() => chartMonthShift('2026-1', 1), /月份格式/);
assert.throws(() => chartMonthShift('2026-01', -25000), /可计算范围/);

// ── 趋势：连续补月 + 空月记 0 + 口径过滤 ────────────────────────────────
const out = (date, amount, merchant = '', note = '一卡通消费') => ({ id: `${date}|${amount}|${merchant}|${note}`, date, amount, note, merchant, kind: 'out', at: 0 });
const income = (date, amount) => ({ id: `${date}|${amount}|in`, date, amount, note: '一卡通充值', merchant: '', kind: 'in', at: 0 });

const rows = [
  out('2025-08-10', 30), out('2025-12-20', 20, '第一食堂'), out('2026-01-05', 50, '第一食堂'),
  out('2026-01-06', 10, '超市'), out('2026-01-07', 5, '洗浴'),
  out('2026-01-08', 8, '第一食堂'), out('2026-01-09', 4, '某窗口'), out('2026-01-10', 12, '第一食堂'),
  out('2026-01-11', 6, '超市'), out('2026-01-12', 7, '第一食堂'),
  income('2025-11-02', 500), income('2026-01-03', 300),
];
let trend = chartTrend(rows, { kind: 'out', months: 6 });
assert.equal(trend.latest, '2026-01');
assert.equal(trend.points.length, 6);
assert.deepEqual(trend.points.map((p) => p.key), ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
assert.deepEqual(trend.points.map((p) => p.cents), [3000, 0, 0, 0, 2000, 10200]);
assert.deepEqual(trend.points.map((p) => p.label), ['8月', '9月', '10月', '11月', '12月', '1月']);
assert.equal(trend.totalCents, 15200);
assert.equal(trend.activeMonths, 3);
assert.equal(trend.maxCents, 10200);
// 充值口径互不串味
trend = chartTrend(rows, { kind: 'in', months: 6 });
assert.deepEqual(trend.points.map((p) => p.cents), [0, 0, 0, 50000, 0, 30000]);
assert.equal(trend.totalCents, 80000);
// months 夹到 3–24，缺省 12
assert.equal(chartTrend(rows, { months: 1 }).points.length, 3);
assert.equal(chartTrend(rows, { months: 99 }).points.length, 24);
assert.equal(chartTrend(rows, {}).points.length, 12);
assert.equal(chartTrend([], {}).points.length, 0);
assert.equal(chartTrend([], {}).totalCents, 0);
assert.equal(chartTrend(null, {}).points.length, 0);

// ── 脏数据：金额不可用的行不能进任何一张图 ──────────────────────────────
const junkAmount = [out('2026-01-13', 0), out('2026-01-14', -5), out('2026-01-15', Infinity), out('2026-01-16', NaN), out('2026-01-17', 'abc'), out('2026-01-18', null)];
assert.equal(chartPlaces(junkAmount, {}).totalCount, 0);
assert.equal(chartPlaces(junkAmount, {}).totalCents, 0);
assert.equal(chartCategories(junkAmount, {}).count, 0);
assert.equal(chartCategories(junkAmount, {}).totalCents, 0);
assert.equal(chartWeekday(junkAmount, {}).totalCents, 0);
assert.equal(chartTrend(junkAmount, {}).totalCents, 0);
assert.equal(chartTrend(junkAmount, {}).points.length, 0, '没有任何可用金额时不给趋势，不能凭空画出全 0 的月份轴');
// 月份脏数据不能进趋势：2026-13 会被当成一个真实月份画出来
const junkMonth = [out('2026-13-45', 999), out('bad-date', 999), out('2026-01-05', 10)];
const t2 = chartTrend(junkMonth, { kind: 'out', months: 3 });
assert.equal(t2.totalCents, 1000);
assert.deepEqual(t2.points.map((p) => p.key), ['2025-11', '2025-12', '2026-01']);
assert.equal(chartWeekday(junkMonth, {}).totalCents, 1000);

// ── 地点排行：次数优先，未标注兜底，脏数据不进榜 ────────────────────────
assert.equal(placeName(out('2026-01-01', 1, '  第一 食堂 ')), '第一 食堂');
assert.equal(placeName(out('2026-01-01', 1, '', '一卡通消费')), '未标注消费地点');
assert.equal(placeName(income('2026-01-01', 1), 'in'), '未标注充值渠道');
assert.equal(placeName(out('2026-01-01', 1, '', '东苑一楼'), 'out'), '东苑一楼');
assert.equal(placeName(out('2026-01-01', 1, 'x'.repeat(60))).length, 40);
const places = chartPlaces(rows, { kind: 'out', limit: 6 });
assert.equal(places.items[0].name, '第一食堂');
assert.equal(places.items[0].count, 5);
assert.equal(places.items[0].cents, 2000 + 5000 + 800 + 1200 + 700);
assert.equal(places.totalCount, 10);
assert.equal(places.totalCents, 15200);
assert.equal(places.maxCount, 5);
assert.deepEqual(places.items.map((x) => x.name), ['第一食堂', '超市', '未标注消费地点', '洗浴', '某窗口']);
assert.ok(places.items.length <= 6);
assert.equal(chartPlaces(rows, { limit: 1 }).items.length, 3);
assert.equal(chartPlaces(rows, { limit: 99 }).items.length <= 8, true);
assert.deepEqual(chartPlaces([], {}).items, []);
assert.equal(chartPlaces([], {}).maxCount, 1);
// 次数相同时按金额、再按名称，次序必须稳定
const tied = chartPlaces([out('2026-01-01', 5, 'B'), out('2026-01-02', 9, 'A'), out('2026-01-03', 5, 'C')], {});
assert.deepEqual(tied.items.map((x) => x.name), ['A', 'B', 'C']);

// ── 消费结构：只算支出，退款冲正单列 ────────────────────────────────────
const cat = chartCategories(rows, {});
assert.equal(cat.totalCents, 15200);
assert.equal(cat.count, 10);
assert.equal(cat.excludedCount, 0);
assert.deepEqual(cat.slices.map((s) => s.id), ['dining', 'unknown', 'other'], '占比按金额降序，不是按固定类别序');
assert.equal(cat.slices[0].name, '餐饮');
assert.equal(cat.slices[0].cents, 9700);
assert.equal(cat.slices[1].cents, 3400);
assert.equal(cat.slices[2].cents, 2100);
assert.equal(Math.round(cat.slices.reduce((s, x) => s + x.percent, 0)), 100);
const refund = chartCategories([out('2026-01-01', 10, '食堂退款'), out('2026-01-02', 30, '第一食堂'), income('2026-01-03', 100)], {});
assert.equal(refund.excludedCount, 1);
assert.equal(refund.count, 1);
assert.equal(refund.totalCents, 3000);
assert.equal(refund.slices.length, 1);
assert.equal(refund.slices[0].percent, 100);
assert.deepEqual(chartCategories([], {}).slices, []);
assert.equal(chartCategories([], {}).totalCents, 0);
// 自定义关键词（复用日均模块的分类规则）
assert.equal(chartCategories([out('2026-01-01', 10, '东苑一楼')], { keywords: '东苑一楼' }).slices[0].id, 'dining');

// ── 星期分布：周日落在最后一列 ──────────────────────────────────────────
const week = chartWeekday([out('2026-01-05', 10), out('2026-01-05', 5), out('2026-01-11', 30)], { kind: 'out' });
assert.equal(week.items.length, 7);
assert.equal(week.items[0].name, '周一');
assert.equal(week.items[0].cents, 1500);
assert.equal(week.items[6].name, '周日');
assert.equal(week.items[6].cents, 3000);
assert.equal(week.peak, '周日');
assert.equal(week.totalCents, 4500);
assert.equal(week.maxCents, 3000);
assert.equal(chartWeekday([], {}).peak, '');
assert.equal(chartWeekday([out('bad', 10)], {}).totalCents, 0);

// ── 平台口径：接口按新→旧下发，翻回时间顺序 ──────────────────────────────
const pTrend = platformTrend([{ LASTMONTH: '3', TOTAL: 120.5 }, { LASTMONTH: '2', TOTAL: 80 }, { LASTMONTH: '1', TOTAL: 0 }, { LASTMONTH: '0', TOTAL: 9 }, { LASTMONTH: '13', TOTAL: 9 }]);
assert.deepEqual(pTrend.points.map((p) => p.label), ['1月', '2月', '3月']);
assert.deepEqual(pTrend.points.map((p) => p.cents), [0, 8000, 12050]);
assert.equal(pTrend.totalCents, 20050);
assert.equal(pTrend.activeMonths, 2);
assert.deepEqual(platformTrend([]).points, []);
assert.equal(platformTrend([{ LASTMONTH: '1', TOTAL: 5 }]).points[0].cents, 500);
const pRank = platformPlaces([{ MERCHANT: 'A', TRADINGNUM: 3 }, { MERCHANT: 'B', TRADINGNUM: 9 }, { MERCHANT: 'C', TRADINGNUM: 0 }, { MERCHANT: '', TRADINGNUM: 2 }]);
assert.deepEqual(pRank.items.map((x) => x.name), ['B', 'A', '未标注消费地点']);
assert.equal(pRank.totalCount, 14);
assert.equal(pRank.maxCount, 9);
assert.deepEqual(platformPlaces([]).items, []);
assert.equal(platformPlaces([]).maxCount, 1);

// ── 刻度：取好看的整数元 ────────────────────────────────────────────────
assert.equal(niceMaxCents(0), 100);
assert.equal(niceMaxCents(1), 1);
assert.equal(niceMaxCents(-5), 100);
assert.equal(niceMaxCents(12200), 20000);
assert.equal(niceMaxCents(30000), 50000);
assert.equal(niceMaxCents(120000), 200000);
assert.equal(niceMaxCents(999900), 1000000);
assert.equal(CHART_PALETTE.length, 8);
assert.equal(PIE_PALETTE.length, 5);

// ── 面板：渲染 / 单选切换 / 偏好持久化 / 平台入口 / 转义 ────────────────
const styles = new Map();
globalThis.document = { getElementById: (id) => styles.get(id), createElement: () => ({}), head: { append(node) { styles.set(node.id, node); } } };
function makeRoot() {
  let html = '';
  const nodes = new Map();
  const camel = (attr) => attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const make = (attr, value) => ({ dataset: { [camel(attr)]: value }, onclick: null });
  const one = (attr, value) => { const id = `${attr}=${value}`; if (!nodes.has(id)) nodes.set(id, make(attr, value)); return nodes.get(id); };
  // 值可有可无：`data-cc-kindbox` 是裸属性，`data-cc-kind="out"` 带值；后面必须紧跟空白或标签结束，
  // 否则 `data-cc-kind` 会误匹配到 `data-cc-kindbox` 上。
  const attrRe = (attr) => new RegExp(`${attr.replace(/-/g, '\\-')}(?:="([^"]*)")?(?=[\\s>/])`, 'g');
  return {
    isConnected: true,
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); nodes.clear(); },
    querySelector(selector) {
      const attr = selector.replace(/^\[|\]$/g, '');
      const hit = html.match(attrRe(attr));
      return hit ? one(attr, hit[1] ?? '') : null;
    },
    querySelectorAll(selector) {
      const found = [];
      for (const raw of selector.split(',')) {
        const attr = raw.trim().replace(/^\[|\]$/g, '');
        for (const m of html.matchAll(attrRe(attr))) {
          const node = one(attr, m[1] ?? '');
          if (!found.includes(node)) found.push(node);
        }
      }
      return found;
    },
  };
}
const glowCalls = [];
const tide = {
  storage: { get: async () => ({ kind: 'in', months: 6 }), set: async (key, value) => { glowCalls.push({ key, value }); } },
  ui: { selectionGlow: (box, options) => { glowCalls.push({ box, options }); return { dispose() {} }; } },
};

const panel = await createCardCharts(tide, undefined);
const root = makeRoot();
panel.render(root, rows, { partial: false });
assert.match(root.innerHTML, /一卡通图形统计/);
assert.match(root.innerHTML, /充值金额趋势/, '偏好里的口径要生效');
assert.match(root.innerHTML, /class="cc-line"/);
assert.match(root.innerHTML, /class="cc-area"/);
assert.match(root.innerHTML, /class="cc-arc"/);
assert.match(root.innerHTML, /累计总消费/);
assert.match(root.innerHTML, /星期分布/);
assert.match(root.innerHTML, /地点排行/);
// 没有 bridge 时不给平台入口
assert.doesNotMatch(root.innerHTML, /data-cc-platform/);
// 单选组：aria-pressed + 光块
assert.match(root.innerHTML, /data-cc-kind="in" aria-pressed="true"/);
assert.match(root.innerHTML, /data-cc-months="6" aria-pressed="true"/);
assert.ok(glowCalls.some((c) => c.options?.selector === 'button[aria-pressed="true"]'), '单选组必须挂滑动光');

// ── 尺寸：不许「按 viewBox 等比缩」，否则窄窗口下字会缩到看不清 ──────────
// 折线画布宽度跟着容器走（量不到退回 620），环图按真实像素画并写死 width/height。
assert.match(root.innerHTML, /class="cc-svg" viewBox="0 0 620 236"/, '折线画布宽度要按容器量出来');
assert.match(root.innerHTML, /class="cc-donut-svg" viewBox="0 0 248 248" style="width:248px;height:248px"/);
// 星期分布与折线一样吃满整行，不会孤零零占半行、另一半空着
assert.equal((root.innerHTML.match(/class="cc-card cc-wide"/g) || []).length, 2);
const css = styles.get('card-chart-style').textContent;
assert.match(css, /\.cc-grid\{display:grid;grid-template-columns:1fr;gap:12px\}/, '默认单列');
assert.match(css, /@media\(min-width:1080px\)\{\.cc-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
assert.match(css, /\.cc-axis\{fill:var\(--cc-axis\);font-size:calc\(12\.5px \* var\(--ui-text-scale\)\)\}/, 'SVG 轴文字要跟界面字号走');
assert.match(css, /\.cc-week-track\{[^}]*height:112px/, '星期柱要够高');
assert.doesNotMatch(css, /\.cc-donut-svg\{flex:1 1 168px/, '环图不能再被 flex 压缩');

// 尺寸助手：宽度扣掉内外边距（16×2 + 15×2 + 4 道边框 = 66），环图夹在 176–248
assert.equal(plotWidth({ clientWidth: 766 }), 700);
assert.equal(plotWidth({ querySelector: () => ({ clientWidth: 486 }) }), 420, '优先量 .cc-panel');
assert.equal(plotWidth({ clientWidth: 200 }), 620, '太窄就退回默认宽度，不画一条挤成一团的线');
assert.equal(plotWidth(undefined), 620);
assert.equal(donutWidth(700), 248);
assert.equal(donutWidth(400), 176);
assert.equal(donutWidth(1000), 248);

// 切口径 → 重画 + 落盘
const kindButtons = root.querySelectorAll('[data-cc-kind]');
kindButtons.find((b) => b.dataset.ccKind === 'out').onclick();
assert.match(root.innerHTML, /消费金额趋势/);
await new Promise((r) => setImmediate(r));
assert.equal(glowCalls.filter((c) => c.key === 'cardChartPreferences').at(-1).value.kind, 'out');
// 切范围
root.querySelectorAll('[data-cc-months]').find((b) => b.dataset.ccMonths === '12').onclick();
await new Promise((r) => setImmediate(r));
assert.equal(glowCalls.filter((c) => c.key === 'cardChartPreferences').at(-1).value.months, 12);
assert.match(root.innerHTML, /data-cc-months="12" aria-pressed="true"/);

// XSS：商户名里的标签必须转义成文本，不能变成真节点
const evil = makeRoot();
panel.render(evil, [out('2026-01-05', 12, '<img src=x onerror=alert(1)>')], {});
assert.match(evil.innerHTML, /&lt;img src=x/);
assert.doesNotMatch(evil.innerHTML, /<img[\s>]/);
assert.match(evil.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);

// 空数据：给引导而不是空图
const blank = makeRoot();
panel.render(blank, [], {});
assert.match(blank.innerHTML, /还没有已同步的一卡通流水/);
assert.doesNotMatch(blank.innerHTML, /class="cc-line"/);

// ── 平台口径：拿到数据画图，拿不到给提示 ────────────────────────────────
const api = async (path) => {
  if (path.includes('tradingTrend')) return { ok: true, data: { trendList: [{ LASTMONTH: '3', TOTAL: 120 }, { LASTMONTH: '2', TOTAL: 60 }] } };
  if (path.includes('tradingPlaceRanking')) return { ok: true, data: { tradingList: [{ MERCHANT: '第一食堂', TRADINGNUM: 7 }] } };
  return { ok: true, data: { BALANCE: '88.5', MONTHCONSUME: '120', WEEKCONSUME: '30' } };
};
const withBridge = await createCardCharts({ storage: { get: async () => null, set: async () => {} }, ui: {} }, { api });
const platRoot = makeRoot();
withBridge.render(platRoot, rows, {});
assert.match(platRoot.innerHTML, /data-cc-platform/);
assert.match(platRoot.innerHTML, /平台口径（个人成长中心）/);
await platRoot.querySelector('[data-cc-platform]').onclick();
await new Promise((r) => setImmediate(r));
assert.match(platRoot.innerHTML, /平台月度消费趋势/);
assert.match(platRoot.innerHTML, /平台消费地点排行/);
assert.match(platRoot.innerHTML, /¥88.50/);
assert.match(platRoot.innerHTML, /2月/);
assert.match(platRoot.innerHTML, /7 次/);

const failing = await createCardCharts({ storage: { get: async () => null, set: async () => {} }, ui: {} },
  { api: async () => ({ ok: false, auth: true, message: '统一身份认证会话已失效' }) });
const failRoot = makeRoot();
failing.render(failRoot, rows, {});
await failRoot.querySelector('[data-cc-platform]').onclick();
await new Promise((r) => setImmediate(r));
assert.match(failRoot.innerHTML, /统一身份认证会话已失效/);
assert.match(failRoot.innerHTML, /先在「警大通知」里登录一次/);
// 模块崩掉不能把主界面带走
assert.doesNotThrow(() => { panel.render({ isConnected: false, innerHTML: '' }, rows, {}); });
assert.doesNotThrow(() => panel.dispose());

// ── 与 main.js 的接线 ───────────────────────────────────────────────────
const source = fs.readFileSync(new URL('../public/plugins/cppu-notify/main.js', import.meta.url), 'utf8');
assert.match(source, /import\("\/plugins\/cppu-notify\/card-charts\.js"\)/);
assert.match(source, /module\.createCardCharts\(tide, growthBridge\)/);
assert.match(source, /cardChartsPanel\?\.render\(box\.querySelector\("\[data-card-charts\]"\)/);
assert.match(source, /<div data-card-charts>/);
assert.match(source, /loadCardChartsPanel\(el\)/);
assert.match(source, /cardChartsPanel\?\.dispose\?\.\(\)/);
assert.ok(!/data-card-(kind|mode|months)="?cc/.test(source), '图形统计不得占用 main.js 的 data-card-* 委托前缀');

console.log('PASS: card charts trend/ranking/donut/weekday aggregation, month continuity, platform data source, palette, escaping, panel wiring');
