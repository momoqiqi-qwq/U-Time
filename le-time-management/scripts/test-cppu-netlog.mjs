import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 上网记录视图（cppu-notify/netlog.js）的行为测试。
   netlog.js 是 ESM 且只依赖 tide / bridge，所以这里给一个最小 DOM 与假宿主，
   真跑一次 render() → paint()，再从产出的 HTML 断言四块内容与熬夜口径。
   静态 `source.includes(...)` 只能证明字符串在文件里，证明不了算出来的数对不对。 */

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'public', 'plugins', 'cppu-notify', 'netlog.js');
const source = fs.readFileSync(file, 'utf8');

const styleNodes = [];
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { append: (node) => styleNodes.push(node) },
};

const { createNetLogView } = await import('../public/plugins/cppu-notify/netlog.js');

const hostOf = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });
const tideOf = (calendar = null) => ({
  storage: { get: async (key) => (key === 'calendar' ? calendar : null), set: () => {} },
  ui: { waitMask: () => () => {} },
  util: {},
});

/* ── 时间夹具：一律相对今天构造，测试与运行月份无关 ───────────────────── */
const atNoon = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const at = (offset, h, m = 0) => {
  const d = atNoon();
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const row = (login, logout, minutes, flows = {}) => ({
  loginTime: login,
  logoutTime: logout,
  time: minutes,
  flow: 0,
  costMoney: 0,
  internetUpFlow: flows.iu || 0,
  internetDownFlow: flows.id || 0,
  chinanetUpFlow: flows.cu || 0,
  chinanetDownFlow: flows.cd || 0,
  userIp: '10.0.0.1',
  macAddress: 'AA-BB-CC-DD-EE-FF',
  nasIp: '10.0.0.254',
  nasPort: '1001',
});

/* 学期阈值：与 netlog.js 同一套口径（2–7 月春季 22:20，其余冬学期 22:00）。
   这里独立算一遍，等于给被测实现一个对账基准。 */
const cutoffOf = (stamp) => {
  const month = new Date(stamp).getMonth() + 1;
  return month >= 2 && month <= 7 ? 22 * 60 + 20 : 22 * 60;
};
const fmtDur = (m) => {
  const n = Math.round(m);
  const h = Math.floor(n / 60);
  const mm = n % 60;
  if (h && mm) return `${h} 小时 ${mm} 分`;
  if (h) return `${h} 小时`;
  return `${mm} 分钟`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── ① 正常面板：概览图标 / 折线 / 流量柱 / 熬夜 / 明细折叠 ───────────── */
const nightRows = [
  row(at(-1, 22, 30), at(0, 1, 0), 150, { iu: 120, id: 800, cu: 60, cd: 400 }),
  row(at(0, 20, 0), at(0, 22, 10), 130, { iu: 30, id: 200, cu: 10, cd: 90 }),
  row(at(-2, 21, 0), at(-2, 21, 40), 40, { iu: 8, id: 40 }),
];
const host = hostOf();
const calls = [];
const view = createNetLogView(tideOf(), {
  logs: async (params) => {
    calls.push(params || {});
    return { ok: true, data: { rows: nightRows, summary: null } };
  },
});
view.render(host);
await sleep(120);

const html = host.innerHTML;
assert.ok(html.includes('nlog-stat'), '概览卡必须渲染');
for (const cls of ['s-time', 's-flow', 's-cost', 's-count']) {
  assert.ok(html.includes(`nlog-stat ${cls}`), `概览必须有 ${cls} 这张卡（语义色靠它给）`);
}
assert.ok((html.match(/class="nlog-ico"/g) || []).length >= 4, '四张概览卡各带一个内联 SVG 图标');
assert.ok(html.includes('在线时长') && html.includes('总流量') && html.includes('上网次数'), '标题文案不能丢');

/* 折线：path + 渐变面积都在 */
const stroke = html.match(/class="nlog-stroke" d="([^"]*)"/)?.[1] || '';
assert.ok(stroke.startsWith('M'), '折线必须有 path（M 开头）');
assert.ok((stroke.match(/L/g) || []).length >= 1, '折线至少两个点');
assert.ok(html.includes('url(#nlog-grad-line)'), '折线下方要有渐变面积');
assert.ok(html.includes('class="nlog-peak"'), '折线要标出峰值那天');

/* 流量柱：上下行两段都要出现 */
assert.ok(html.includes('class="nlog-bar-down"') && html.includes('class="nlog-bar-up"'), '流量图必须是上下行堆叠柱');
assert.ok(html.includes('nlog-split-row'), '国际 / 国内占比条必须渲染');
assert.equal((html.match(/nlog-split-row/g) || []).length, 2, '占比条固定两行：国际 + 国内');

/* 熬夜：阈值按当月，累计时长按并集口径 */
const cYesterday = cutoffOf(at(-1, 22, 30));
const cToday = cutoffOf(at(0, 20, 0));
const tonight1 = 24 * 60 + 60 - Math.max(22 * 60 + 30, cYesterday); // 昨天 22:30 → 次日 01:00
const tonight2 = Math.max(0, Math.min(22 * 60 + 10, cToday + 8 * 60) - Math.max(20 * 60, cToday));
const expectTotal = Math.round(tonight1 + tonight2);
assert.ok(html.includes('nlog-night'), '熬夜卡必须渲染');
assert.ok(html.includes('累计 ·'), '熬夜卡要有累计时长');
assert.ok(
  html.includes(fmtDur(expectTotal)),
  `熬夜累计应为 ${expectTotal} 分钟（${fmtDur(expectTotal)}），实际没出现这个数`,
);
assert.ok(html.includes('最晚下线'), '熬夜卡要显示最晚下线时间');
assert.ok(/春季学期 · 22:20|冬学期 · 22:00/.test(html), '熬夜卡要写明当前学期阈值');

/* 熬夜①口径文案精简：长篇解释挪进 title，卡面只留「学期 · 阈值」 */
assert.ok(!html.includes('口径：'), '熬夜卡不再挂长段口径说明');
assert.ok(html.includes('挂机整夜不会算成几十小时'), '口径解释要留在 title 里，不能整段消失');

/* 熬夜②逐夜列表可整块收起（默认展开，按钮 aria 同步） */
assert.ok(html.includes('data-nlog-nightfold'), '熬夜逐夜列表要有收起按钮');
assert.ok(/aria-controls="nlog-night-body"/.test(html), '收起按钮要指向逐夜容器');
assert.ok(/id="nlog-night-body"/.test(html), '逐夜容器要有 id 供 aria 关联');
assert.ok(/nlog-dwrap open" id="nlog-night-body"/.test(html), '默认展开');

/* 熬夜③统计范围＝整个学期：取数请求里必须有以学期首日开头的区间，且每片不超过 60 天 */
const todayKey = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const semStartOf = () => {
  const y = Number(todayKey.slice(0, 4));
  const m = Number(todayKey.slice(5, 7));
  if (m >= 2 && m <= 7) return `${y}-02-10`;
  return `${m === 1 ? y - 1 : y}-08-25`;
};
const spanOf = (c) => Math.round((Date.parse(`${c.end}T00:00:00`) - Date.parse(`${c.start}T00:00:00`)) / 86400000) + 1;
assert.ok(
  calls.some((c) => c.start === semStartOf()),
  `熬夜要按学期取数（应出现 start=${semStartOf()} 的请求），实际：${JSON.stringify(calls.map((c) => `${c.start}~${c.end}`))}`,
);
assert.ok(calls.every((c) => spanOf(c) <= 60), '每片区间都不能超过服务端 60 天上限');
assert.ok(calls.every((c) => c.end <= todayKey), '不能向未来日期取数');

/* 明细：整块折叠 + 单天折叠 */
assert.ok(html.includes('data-nlog-fold') && html.includes('全部收起'), '明细要有整块收起按钮');
assert.equal((html.match(/data-nlog-daytoggle/g) || []).length, 3, '三个有记录的日子各有一个折叠头');
assert.ok((html.match(/nlog-daygroup open/g) || []).length >= 1, '默认展开的日子要带 open 类');

/* ── ② 熬夜上限：连挂三天只算一夜 8 小时 ─────────────────────────────── */
const longHost = hostOf();
const longView = createNetLogView(tideOf(), {
  logs: async () => ({ ok: true, data: { rows: [row(at(-1, 22, 0), at(-1, 22, 0) + 72 * 3600 * 1000, 4320)], summary: null } }),
});
longView.render(longHost);
await sleep(30);
assert.ok(longHost.innerHTML.includes('8 小时'), '挂机三夜也必须封顶在阈值后 8 小时');
assert.ok(longHost.innerHTML.includes('累计 · 1 夜'), '同一条跨天记录只算一夜');

/* ── ③ 空数据：不画图、不报错 ─────────────────────────────────────────── */
const emptyHost = hostOf();
const emptyView = createNetLogView(tideOf(), { logs: async () => ({ ok: true, data: { rows: [], summary: null } }) });
emptyView.render(emptyHost);
await sleep(30);
assert.ok(emptyHost.innerHTML.includes('这段时间没有上网记录'), '空区间给空态文案');
assert.ok(!emptyHost.innerHTML.includes('nlog-stroke'), '没有记录时不该画出空折线');

/* ── ④ 源码守卫：浮层与动效 ───────────────────────────────────────────── */
assert.ok(!/position\s*:\s*fixed/.test(source), '本视图不做固定浮层，安全区四边归宿主 .view 管');

console.log('PASS: netlog 概览图标、折线、流量柱、熬夜口径、明细折叠与空态文案');
