// 一卡通图形统计：把已同步的一卡通流水画成图形，另附「平台口径」入口直读个人成长中心。
//
// 图形口径反解自 pdata.cppu.edu.cn 学生端 umi.js 的 dataReport/consumption 三个图表组件：
//   trendChart  → 折线 + 面积渐变，x 轴月份、y 轴金额（lineStyle #2B7BFF，面积 #ABCCFF→透明）
//   rankChart   → 横向 pictorialBar：整条浅灰底条 + 彩色前景条 + 右侧「N 次」标签，
//                 前景条是 3px 色块 / 2px 间隙的重复纹理（symbolSize:[3,14] + symbolMargin:2）
//   pieChart    → 环形图，中心「累计总消费 + 金额」，右侧图例带百分比与金额
// 配色也照抄网页：地点排行用它的八色序列，环形图用它的五色序列。
//
// 数据来源两条腿：
//   ① 本地口径 —— main.js 已同步的一卡通流水（cardState.rows），永远可用；
//   ② 平台口径 —— bridge.api("/tsa/pdp/consume/*")，与官网同源，但依赖统一身份认证会话。
//
// 边界：本模块**不碰** SSO / 密码 / vault / Cookie —— 那是 main.js 的事。平台口径只认
// 「拿到 data / 没拿到」两种结果，换票与一次性重登由 main.js 的 growthBridge 内部处理。
//
// 安全区：本面板是普通文档流内容，四条边由宿主 .view 负责，这里**不垫第二遍**。
import { classifyExpense, DEFAULT_KEYWORDS } from './card-averages.js';

/** 网页 rankChart 的八色序列，原样搬过来。 */
export const CHART_PALETTE = ['#29aadf', '#1dffd4', '#f1d53c', '#ffad5c', '#34da62', '#00e9db', '#00c0e9', '#0096f3'];
/** 网页 pieChart 的五色序列。 */
export const PIE_PALETTE = ['#1FA2FE', '#F5972B', '#7D6AEF', '#FC5B5B', '#2CC772'];

const CATEGORY_LABEL = { dining: '餐饮', other: '商超洗浴', unknown: '其他消费' };
const CATEGORY_ORDER = ['dining', 'other', 'unknown'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const KEY = 'cardChartPreferences';
const MONTH_MODES = { 6: '近 6 个月', 12: '近 12 个月' };
/** 一卡通平台给方向缺失流水用的兜底摘要，不是真的「地点」。 */
const GENERIC_NOTE = /^一卡通(消费|充值)$/;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kindOf = (row) => (row?.kind === 'out' ? 'out' : 'in');
/** 金额一律走「分」的整数运算，避免 0.1+0.2 这类浮点误差进到图表刻度里。 */
const toCents = (v) => {
  const n = Math.round(Number(v) * 100);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const money = (cents) => `¥${(cents / 100).toFixed(2)}`;
const trim = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** 月份键位移。越界直接抛错，让调用方拿到「算不出来」而不是一个错月份的图。 */
export function chartMonthShift(key, delta) {
  if (!/^\d{4}-\d{2}$/.test(String(key))) throw Error('月份格式应为 YYYY-MM');
  const month = Number(key.slice(5, 7));
  // 2026-13 这种键必须在这里挡住：不然位移会静默滚成 2027-01，图上多出一个不存在的月份。
  if (month < 1 || month > 12) throw Error('月份格式应为 YYYY-MM（月份 01–12）');
  const total = Number(key.slice(0, 4)) * 12 + (month - 1) + Math.trunc(Number(delta) || 0);
  if (!Number.isSafeInteger(total) || total < 0) throw Error('月份超出可计算范围');
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * 月度趋势。以最后一个有数据的月份为右端，向前补满连续自然月（空月记 0），
 * 折线才不会把「3 月和 8 月」连成一条误导的斜线。
 */
export function chartTrend(rows, options = {}) {
  const kind = options.kind === 'in' ? 'in' : 'out';
  const months = Math.min(24, Math.max(3, Math.trunc(Number(options.months)) || 12));
  const buckets = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (kindOf(row) !== kind) continue;
    const date = String(row?.date || '');
    if (!/^\d{4}-\d{2}/.test(date)) continue;
    const key = date.slice(0, 7);
    // 月份必须落在 01–12：脏数据（2026-13-xx）不能被 chartMonthShift 当成一个真实月份画出来。
    if (Number(key.slice(5, 7)) < 1 || Number(key.slice(5, 7)) > 12) continue;
    const cents = toCents(row?.amount);
    if (!cents) continue;
    buckets.set(key, (buckets.get(key) || 0) + cents);
  }
  const latest = [...buckets.keys()].sort().at(-1) || '';
  const points = latest
    ? Array.from({ length: months }, (_, i) => chartMonthShift(latest, i - (months - 1)))
      .map((key) => ({ key, label: `${Number(key.slice(5, 7))}月`, cents: buckets.get(key) || 0 }))
    : [];
  return {
    kind, months, points, latest,
    totalCents: points.reduce((sum, p) => sum + p.cents, 0),
    activeMonths: points.filter((p) => p.cents > 0).length,
    maxCents: Math.max(1, ...points.map((p) => p.cents)),
  };
}

/** 一条流水的「地点」：优先商户名，其次摘要，两个都没有就归到未标注桶。 */
export function placeName(row, kind = 'out') {
  const merchant = String(row?.merchant || '').replace(/\s+/g, ' ').trim();
  if (merchant) return merchant.slice(0, 40);
  const note = String(row?.note || '').replace(/\s+/g, ' ').trim();
  if (note && !GENERIC_NOTE.test(note)) return note.slice(0, 40);
  return kind === 'in' ? '未标注充值渠道' : '未标注消费地点';
}

/** 地点排行：网页按交易次数（TRADINGNUM）排，这里同口径，金额只做同次数时的次序。 */
export function chartPlaces(rows, options = {}) {
  const kind = options.kind === 'in' ? 'in' : 'out';
  const limit = Math.min(8, Math.max(3, Math.trunc(Number(options.limit)) || 6));
  const map = new Map();
  let totalCount = 0, totalCents = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (kindOf(row) !== kind) continue;
    const cents = toCents(row?.amount);
    if (!cents) continue;
    const name = placeName(row, kind);
    const hit = map.get(name) || { name, count: 0, cents: 0 };
    hit.count += 1;
    hit.cents += cents;
    map.set(name, hit);
    totalCount += 1;
    totalCents += cents;
  }
  const items = [...map.values()]
    .sort((a, b) => b.count - a.count || b.cents - a.cents || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { kind, items, totalCount, totalCents, maxCount: Math.max(1, ...items.map((i) => i.count)) };
}

/** 消费结构：复用日均模块的关键词分类，只统计支出；退款冲正单列不计入占比。 */
export function chartCategories(rows, options = {}) {
  const keywords = typeof options.keywords === 'string' && options.keywords.trim() ? options.keywords.trim() : DEFAULT_KEYWORDS;
  const buckets = new Map();
  let totalCents = 0, count = 0, excludedCount = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== 'out') continue;
    const cents = toCents(row?.amount);
    if (!cents) continue;
    const category = classifyExpense(row, keywords);
    if (category === 'excluded') { excludedCount += 1; continue; }
    buckets.set(category, (buckets.get(category) || 0) + cents);
    totalCents += cents;
    count += 1;
  }
  const slices = CATEGORY_ORDER
    .map((id) => ({ id, name: CATEGORY_LABEL[id], cents: buckets.get(id) || 0 }))
    .filter((s) => s.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .map((s) => ({ ...s, percent: totalCents ? (s.cents / totalCents) * 100 : 0 }));
  return { slices, totalCents, count, excludedCount };
}

/** 星期分布：周一是第 0 列（Date.getUTCDay 的周日 = 0 要挪到末尾）。 */
export function chartWeekday(rows, options = {}) {
  const kind = options.kind === 'in' ? 'in' : 'out';
  const sums = new Array(7).fill(0);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (kindOf(row) !== kind) continue;
    const cents = toCents(row?.amount);
    if (!cents) continue;
    const stamp = Date.parse(`${String(row.date)}T00:00:00Z`);
    if (!Number.isFinite(stamp)) continue;
    sums[(new Date(stamp).getUTCDay() + 6) % 7] += cents;
  }
  const items = WEEKDAYS.map((name, i) => ({ name, cents: sums[i] }));
  const totalCents = sums.reduce((a, b) => a + b, 0);
  return {
    kind, items, totalCents,
    maxCents: Math.max(1, ...sums),
    peak: totalCents ? items.reduce((best, x) => (x.cents > best.cents ? x : best), items[0]).name : '',
  };
}

/* ── 平台口径（与官网 dataReport/consumption 同源） ───────────────────────
   tradingTrend        → { trendList:[{LASTMONTH, TOTAL}] }   LASTMONTH 只有月，没有年
   tradingPlaceRanking → { tradingList:[{MERCHANT, TRADINGNUM}] }
   cardInfo            → { BALANCE, MONTHCONSUME, WEEKCONSUME, USERNAME, USERID } */

export function platformTrend(list, limit = 12) {
  const all = (Array.isArray(list) ? list : []).map((row) => {
    const month = Math.trunc(Number(row?.LASTMONTH) || 0);
    return { month, cents: Math.max(0, Math.round((Number(row?.TOTAL) || 0) * 100)) };
  }).filter((p) => p.month >= 1 && p.month <= 12);
  // 接口按「新→旧」下发（网页拿到后 reverse 一次才画），取最近 limit 个再翻回时间顺序。
  const points = all.slice(0, Math.max(1, limit)).reverse().map((p) => ({ key: String(p.month), label: `${p.month}月`, cents: p.cents }));
  return {
    kind: 'out', months: points.length, points, latest: '',
    totalCents: points.reduce((sum, p) => sum + p.cents, 0),
    activeMonths: points.filter((p) => p.cents > 0).length,
    maxCents: Math.max(1, ...points.map((p) => p.cents)),
  };
}

export function platformPlaces(list, limit = 6) {
  const all = (Array.isArray(list) ? list : []).map((row) => ({
    name: trim(row?.MERCHANT, 40) || '未标注消费地点',
    count: Math.max(0, Math.trunc(Number(row?.TRADINGNUM) || 0)),
  })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const items = all.slice(0, Math.min(8, Math.max(3, limit)));
  return {
    kind: 'out', items, maxCount: Math.max(1, ...items.map((i) => i.count)),
    totalCount: all.reduce((sum, x) => sum + x.count, 0),
  };
}

/* ── 自绘 SVG ─────────────────────────────────────────────────────────────
   不引 echarts（插件里再塞一个 1MB 的图表库不划算）：折线 / 环形图用内联 SVG，
   排行 / 星期分布用 HTML 条。配色与刻度照网页，尺寸走 viewBox 自适应。 */

/** 刻度上界取「好看的整数元」，否则 y 轴会冒出 137.42 这种刻度。 */
export function niceMaxCents(cents) {
  const yuan = cents / 100;
  if (!(yuan > 0)) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(yuan));
  const norm = yuan / magnitude;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return Math.max(1, Math.round(step * magnitude * 100));
}

const axisText = (cents) => {
  const yuan = cents / 100;
  if (yuan >= 10000) return `${(yuan / 10000).toFixed(yuan % 10000 === 0 ? 0 : 1)}万`;
  return String(Math.round(yuan));
};

/** 折线段的控制点只沿水平方向偏移：曲线顺滑但永不越过数据点，不会画出「负消费」。 */
function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const cx = (x1 - x0) * 0.36;
    d += ` C${(x0 + cx).toFixed(2)},${y0.toFixed(2)} ${(x1 - cx).toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

let gradientSeq = 0;
/** 画布宽度取容器真实像素：viewBox 与渲染宽度一致，SVG 里的字才不会被等比缩小。 */
function trendChartHtml(trend, width = 0) {
  const W = Math.round(Math.min(1400, Math.max(300, width || 620)));
  const H = 236, padL = 54, padR = 18, padT = 18, padB = 36;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const points = trend.points;
  const max = niceMaxCents(trend.maxCents);
  const x = (i) => padL + (points.length > 1 ? (i * innerW) / (points.length - 1) : innerW / 2);
  const y = (cents) => padT + innerH - (cents / max) * innerH;
  const coords = points.map((p, i) => [x(i), y(p.cents)]);
  const baseY = padT + innerH;
  const gid = `cc-trend-${++gradientSeq}`;
  const line = smoothPath(coords);
  const area = line ? `${line} L${coords.at(-1)[0].toFixed(2)},${baseY} L${coords[0][0].toFixed(2)},${baseY} Z` : '';
  const peak = points.reduce((best, p) => (p.cents > best.cents ? p : best), points[0] || { cents: 0 });
  const grid = [0, 1, 2, 3, 4].map((i) => {
    const gy = padT + (innerH * i) / 4;
    return `<line class="cc-gridline" x1="${padL}" y1="${gy.toFixed(2)}" x2="${W - padR}" y2="${gy.toFixed(2)}"/>`
      + `<text class="cc-axis" x="${padL - 8}" y="${(gy + 3.5).toFixed(2)}" text-anchor="end">${esc(axisText((max * (4 - i)) / 4))}</text>`;
  }).join("");
  const dots = points.map((p, i) => {
    const [cx, cy] = coords[i];
    const on = peak.cents > 0 && p.cents === peak.cents;
    return `<circle class="cc-dot${on ? " on" : ""}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${on ? 4.5 : 3}">`
      + `<title>${esc(`${p.label}：${money(p.cents)}`)}</title></circle>`;
  }).join("");
  // 每个刻度大约要 30px：宽度不够就隔一个画一个，宁可少几个也不挤成一团。
  const step = Math.max(1, Math.ceil((points.length * 30) / Math.max(120, innerW)));
  const labels = points.map((p, i) => (i % step === 0 || i === points.length - 1
    ? `<text class="cc-axis" x="${x(i).toFixed(2)}" y="${H - 12}" text-anchor="middle">${esc(p.label)}</text>` : "")).join("");
  return `<div class="cc-plot"><svg class="cc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${trend.months} 个月金额趋势`)}" preserveAspectRatio="xMidYMid meet">
<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="var(--cc-accent-2)" stop-opacity="0.92"/>
<stop offset="100%" stop-color="var(--cc-accent-2)" stop-opacity="0"/>
</linearGradient></defs>
${grid}${area ? `<path class="cc-area" d="${area}" fill="url(#${gid})"/>` : ""}
${line ? `<path class="cc-line" d="${line}"/>` : ""}${dots}${labels}</svg></div>`;
}

/** 环图按真实像素画（viewBox 与渲染尺寸一致），文字因此不缩水。 */
function donutChartHtml(cat, size = 208) {
  const s = Math.round(Math.min(248, Math.max(176, size)));
  const r = Math.round(s * 0.336), cx = s / 2, cy = s / 2, width = Math.round(s * 0.109);
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = cat.slices.map((s, i) => {
    const len = cat.totalCents ? circumference * (s.cents / cat.totalCents) : 0;
    const arc = `<circle class="cc-arc" cx="${cx}" cy="${cy}" r="${r}" stroke="${PIE_PALETTE[i % PIE_PALETTE.length]}" stroke-width="${width}"`
      + ` stroke-dasharray="${len.toFixed(2)} ${(circumference - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})">`
      + `<title>${esc(`${s.name}：${money(s.cents)}（${s.percent.toFixed(1)}%）`)}</title></circle>`;
    offset += len;
    return arc;
  }).join("");
  const center = cat.totalCents
    ? `<text class="cc-donut-val" x="${cx}" y="${cy - 2}" text-anchor="middle">${esc(money(cat.totalCents))}</text>`
      + `<text class="cc-donut-name" x="${cx}" y="${cy + 19}" text-anchor="middle">累计总消费</text>`
    : `<text class="cc-donut-name" x="${cx}" y="${cy + 4}" text-anchor="middle">暂无支出</text>`;
  const legend = cat.slices.map((s, i) => `<li><i style="background:${PIE_PALETTE[i % PIE_PALETTE.length]}"></i>`
    + `<span class="cc-lg-name">${esc(s.name)}</span><b>${s.percent.toFixed(1)}%</b><em>${esc(money(s.cents))}</em></li>`).join("");
  return `<div class="cc-donut"><svg class="cc-donut-svg" viewBox="0 0 ${s} ${s}" style="width:${s}px;height:${s}px" role="img" aria-label="消费结构占比">`
    + `<circle class="cc-donut-track" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${width}"/>${arcs}${center}</svg>`
    + `<ul class="cc-legend">${legend}</ul></div>`;
}

function rankChartHtml(rank, unit) {
  const rows = rank.items.map((item, i) => {
    const value = unit === "次" ? item.count : item.cents;
    const max = unit === "次" ? rank.maxCount : Math.max(1, ...rank.items.map((x) => x.cents));
    const pct = Math.max(3, Math.round((value / max) * 100));
    const label = unit === "次" ? `${item.count} 次` : money(item.cents);
    const title = unit === "次" ? `${item.name}：${item.count} 次 · ${money(item.cents)}` : `${item.name}：${money(item.cents)}`;
    return `<li><span class="cc-rank-name" title="${esc(title)}">${esc(trim(item.name, 12))}</span>`
      + `<span class="cc-rank-track"><i style="width:${pct}%;--cc-bar:${CHART_PALETTE[i % CHART_PALETTE.length]}"></i></span>`
      + `<span class="cc-rank-val">${esc(label)}</span></li>`;
  }).join("");
  return `<ul class="cc-rank" role="list">${rows}</ul>`;
}

function weekChartHtml(week) {
  const cols = week.items.map((item) => {
    const pct = Math.max(2, Math.round((item.cents / week.maxCents) * 100));
    return `<div class="cc-week-col"><b>${esc(item.cents ? money(item.cents) : "—")}</b>`
      + `<span class="cc-week-track" title="${esc(`${item.name}：${money(item.cents)}`)}"><i style="height:${pct}%"${item.name === week.peak ? ' class="peak"' : ""}></i></span>`
      + `<span class="cc-week-lab">${esc(item.name)}</span></div>`;
  }).join("");
  return `<div class="cc-week">${cols}</div>`;
}

/* ── 面板 ─────────────────────────────────────────────────────────────── */

/** 图形区可用宽度（扣掉 .cc-panel 16×2 + .cc-card 15×2 + 四道 1px 边框 = 66）。量不到就退回 620。 */
export function plotWidth(root, fallback = 620) {
  const panel = root?.querySelector?.(".cc-panel");
  const raw = Number(panel?.clientWidth ?? root?.clientWidth);
  return Number.isFinite(raw) && raw >= 280 ? Math.max(300, Math.round(raw) - 66) : fallback;
}

/** 环图跟着图形区宽度走，窄屏也不缩到看不清。 */
export const donutWidth = (plot) => Math.round(Math.min(248, Math.max(176, plot * 0.42)));

/** 并排还是单列，看实测的图形区宽度（不看视口）：两列时列宽 ≈ (plot-10)/2，
 *  plot≥640 才有 ≈315px 的卡片内容盒 —— 248px 的环图与最小 206px 的排行行都放得下；
 *  再窄就单列，宁可让每张图吃满一行，也不把两张卡挤成窄条。 */
export const chartColumns = (plot) => (plot >= 640 ? 2 : 1);

/** 网格容器的内联列定义：单列不写内联样式，交给 .cc-chart-grid 的默认值。 */
const gridCols = (plot) => (chartColumns(plot) === 2 ? ' style="grid-template-columns:repeat(2,minmax(0,1fr))"' : "");

function styles() {
  if (typeof document === "undefined" || document.getElementById("card-chart-style")) return;
  const node = document.createElement("style");
  node.id = "card-chart-style";
  node.textContent = `.cc-panel{--cc-accent:#2B7BFF;--cc-accent-2:#ABCCFF;--cc-grid:#E3E6F0;--cc-axis:#7E7E7E;--cc-track:#F5F6F6;--cc-dot:#D5E5FF;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin:12px 0}
[data-theme-mode="dark"] .cc-panel{--cc-accent:#7CB6FF;--cc-accent-2:#5B9BFF;--cc-grid:color-mix(in srgb,var(--ink) 16%,transparent);--cc-axis:var(--ink-3);--cc-track:color-mix(in srgb,var(--ink) 15%,transparent);--cc-dot:color-mix(in srgb,#7CB6FF 45%,transparent)}
.cc-panel h4{margin:0;font-size:calc(15px * var(--ui-text-scale));color:var(--deep)}
.cc-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.cc-head h4{margin-right:auto}
.cc-chips{display:inline-flex;position:relative;isolation:isolate;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.cc-chips .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;transition:opacity .2s linear;border-radius:9px;background:var(--deep)}
.cc-chips .selection-glow.on{opacity:1}
.cc-chips.has-selection-glow button{position:relative;z-index:1}
.cc-chips.has-selection-glow button[aria-pressed="true"]{background:transparent}
.cc-chips button{font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:inherit;background:transparent;border:0;padding:7px 14px;min-height:38px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,color .18s ease}
.cc-chips button+button{border-left:1px solid var(--line)}
.cc-chips button[aria-pressed="true"]{background:var(--deep);color:var(--on-accent,#fff)}
/* 默认单列：每张图都吃满面板宽度。够宽时由 paint() 给容器写内联两列 —— 判据是
   **实测的面板宽度**（见 chartColumns），不是视口宽度：面板被夹窄时窗口再宽也不并排。
   ⚠️ 容器类名必须唯一：本插件里校历视图（calendar.js）的月历网格过去也叫 .cc-grid，
   两份 <style> 都常驻 <head> 且同权重，后注入的那份会整块覆盖前者 —— 图形统计被
   套上月历的 repeat(7,minmax(0,1fr)) 后，两张卡被挤成 1/7 宽（环图与排行直接溢出卡片）。
   改名后 .cc-grid 只属于校历，两边再不会互相踩。 */
.cc-chart-grid{display:grid;grid-template-columns:1fr;gap:12px}
.cc-card{border:1px solid var(--line-soft,var(--line));border-radius:14px;padding:14px 15px;background:color-mix(in srgb,var(--deep) 3%,var(--panel));min-width:0}
.cc-card.cc-wide{grid-column:1/-1}
.cc-card>header{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:10px}
.cc-card>header b{font-size:calc(13.5px * var(--ui-text-scale))}
.cc-card>header small{margin-left:auto;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale))}
.cc-svg{display:block;width:100%;height:auto}
.cc-donut-svg{display:block;flex:0 0 auto;margin:0 auto;max-width:100%}
.cc-chart-grid line.cc-gridline{stroke:var(--cc-grid);stroke-width:1}
.cc-axis{fill:var(--cc-axis);font-size:calc(12.5px * var(--ui-text-scale))}
.cc-line{fill:none;stroke:var(--cc-accent);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.cc-dot{fill:var(--cc-dot);stroke:var(--cc-accent);stroke-width:1.8}
.cc-dot.on{fill:#FF9F1C;stroke:#FF9F1C}
.cc-donut{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.cc-arc{fill:none;stroke-linecap:butt}
.cc-donut-track{fill:none;stroke:var(--cc-track)}
.cc-donut-val{fill:var(--cc-accent);font-size:19px;font-weight:650}
.cc-donut-name{fill:var(--cc-axis);font-size:12px}
.cc-legend{flex:1 1 170px;list-style:none;margin:0;padding:0;display:grid;gap:8px;min-width:0}
.cc-legend li{display:flex;align-items:center;gap:8px;font-size:calc(12.5px * var(--ui-text-scale));min-width:0}
.cc-legend i{flex:none;width:10px;height:10px;border-radius:50%}
.cc-legend .cc-lg-name{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.cc-legend b{font-variant-numeric:tabular-nums}
.cc-legend em{font-style:normal;color:var(--ink-3);font-variant-numeric:tabular-nums;font-size:calc(11.5px * var(--ui-text-scale))}
.cc-rank{list-style:none;margin:0;padding:0;display:grid;gap:9px}
.cc-rank li{display:grid;grid-template-columns:112px 1fr 74px;align-items:center;gap:10px;font-size:calc(12.5px * var(--ui-text-scale))}
.cc-rank-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)}
.cc-rank-track{position:relative;display:block;height:18px;border-radius:4px;background:var(--cc-track);overflow:hidden}
.cc-rank-track i{display:block;height:100%;border-radius:4px;min-width:3px;background:repeating-linear-gradient(90deg,var(--cc-bar) 0 3px,color-mix(in srgb,var(--cc-bar) 55%,transparent) 3px 5px)}
.cc-rank-val{text-align:right;font-weight:650;color:var(--deep);font-variant-numeric:tabular-nums}
.cc-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;align-items:end}
.cc-week-col{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}
.cc-week-col b{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.cc-week-track{display:flex;align-items:flex-end;width:100%;height:112px;background:var(--cc-track);border-radius:5px;overflow:hidden}
.cc-week-track i{display:block;width:100%;background:var(--cc-accent);border-radius:5px 5px 0 0}
.cc-week-track i.peak{background:#FF9F1C}
.cc-week-lab{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-3);white-space:nowrap}
.cc-empty{border:1px dashed var(--line);border-radius:10px;padding:18px;text-align:center;color:var(--ink-3);font-size:calc(12.5px * var(--ui-text-scale));line-height:1.8}
.cc-note{margin:12px 0 0;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale));line-height:1.8}
.cc-plat{margin-top:14px;padding-top:14px;border-top:1px solid var(--line-soft,var(--line))}
.cc-plat-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.cc-plat-head b{font-size:calc(13.5px * var(--ui-text-scale))}
.cc-plat-head button{margin-left:auto;font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:7px 14px;min-height:38px;cursor:pointer;touch-action:manipulation}
.cc-plat-head button:disabled{opacity:.5;cursor:default}
.cc-plat-stats{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px}
.cc-plat-stats small{display:block;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale))}
.cc-plat-stats b{font-size:calc(19px * var(--ui-text-scale));color:var(--deep);font-variant-numeric:tabular-nums}
.cc-status{min-height:20px;margin:9px 0 0;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale));line-height:1.8}
.cc-status.warn{color:color-mix(in srgb,var(--danger,#B03535) 78%,var(--ink))}
@media(max-width:720px){.cc-rank li{grid-template-columns:88px 1fr 62px}.cc-panel{padding:13px}.cc-card{padding:12px 13px}}
@media(max-width:520px){.cc-week-col b{display:none}.cc-rank li{grid-template-columns:74px 1fr 56px}.cc-week-track{height:88px}}
@media(prefers-reduced-motion:reduce){.cc-chips button{transition-duration:.01ms!important}}`;
  document.head.append(node);
}

export async function createCardCharts(tide, bridge) {
  let prefs = { kind: 'out', months: 12 };
  let last = null, status = '', saving = false, lastWidth = 0;
  let platform = null, platformLoading = false, platformError = '';
  const glowHandles = [];
  try {
    const saved = await tide?.storage?.get?.(KEY, null);
    if (saved) prefs = {
      kind: saved.kind === 'in' ? 'in' : 'out',
      months: Number(saved.months) === 6 ? 6 : 12,
    };
  } catch { status = '图形统计偏好读取失败，本次用默认值'; }

  const persist = async () => {
    if (saving) return;
    saving = true;
    try { await tide?.storage?.set?.(KEY, { ...prefs }); } catch { status = '图形统计偏好保存失败，仅在本次会话生效'; }
    saving = false;
  };

  const call = (path) => Promise.resolve(bridge?.api?.(path))
    .then((r) => (r && typeof r === "object" ? r : { ok: false, message: "平台取数通道不可用" }))
    .catch((e) => ({ ok: false, message: String(e?.message || e) }));

  async function loadPlatform() {
    if (platformLoading || !bridge?.api) return;
    platformLoading = true;
    platformError = '';
    paint();
    const [trend, places, info] = await Promise.all([
      call("/tsa/pdp/consume/tradingTrend"),
      call("/tsa/pdp/consume/tradingPlaceRanking"),
      call("/tsa/pdp/consume/cardInfo"),
    ]);
    platformLoading = false;
    if (last?.root?.isConnected === false) return;
    const ok = [trend, places, info].filter((r) => r?.ok).length;
    if (!ok) {
      const first = [trend, places, info].find((r) => r && (r.message || r.status)) || {};
      platformError = first.message || "个人成长中心暂时没有响应";
      paint();
      return;
    }
    platform = {
      trend: trend?.ok ? platformTrend(trend.data?.trendList) : null,
      rank: places?.ok ? platformPlaces(places.data?.tradingList) : null,
      info: info?.ok ? (info.data || null) : null,
    };
    paint();
  }

  const clean = (v) => {
    const s = String(v ?? "").trim();
    return !s || s === "null" || s === "undefined" || s === "NaN" ? "" : s;
  };
  const platformStat = (raw) => {
    const s = clean(raw);
    if (!s) return "";
    const n = Number(s);
    return Number.isFinite(n) ? `¥${n.toFixed(2)}` : s;
  };

  function platformHtml(plot) {
    if (!bridge?.api) return "";
    let body;
    if (platformLoading) body = `<div class="cc-empty">正在读取平台数据…</div>`;
    else if (platformError) body = `<div class="cc-empty">${esc(platformError)}<br>先在「警大通知」里登录一次统一身份认证，再回来点「读取平台数据」。</div>`;
    else if (!platform) body = `<div class="cc-empty">平台口径与官网「消费」数据报告同源，需要统一身份认证会话；点右上角按钮按需读取。</div>`;
    else {
      const info = platform.info || {};
      const stats = [
        clean(info.BALANCE) ? `<div><small>卡内余额</small><b>${esc(platformStat(info.BALANCE))}</b></div>` : "",
        clean(info.MONTHCONSUME) ? `<div><small>本月消费</small><b>${esc(platformStat(info.MONTHCONSUME))}</b></div>` : "",
        clean(info.WEEKCONSUME) ? `<div><small>本周消费</small><b>${esc(platformStat(info.WEEKCONSUME))}</b></div>` : "",
      ].filter(Boolean).join("");
      body = `${stats ? `<div class="cc-plat-stats">${stats}</div>` : ""}<div class="cc-chart-grid"${gridCols(plot)}>
${trendCard("平台月度消费趋势", platform.trend, "按月 · 网页同源", plot)}
${rankCard("平台消费地点排行", platform.rank, "按次数 · 网页同源")}
</div>`;
    }
    return `<div class="cc-plat"><div class="cc-plat-head"><b>平台口径（个人成长中心）</b>
<button type="button" data-cc-platform ${platformLoading ? "disabled" : ""}>${platformLoading ? "正在读取…" : platform ? "重新读取" : "读取平台数据"}</button></div>${body}</div>`;
  }

  function trendCard(title, trend, sub, plot) {
    if (!trend || !trend.points.length) return `<article class="cc-card cc-wide"><header><b>${esc(title)}</b></header><div class="cc-empty">还没有可画的月度数据。</div></article>`;
    return `<article class="cc-card cc-wide"><header><b>${esc(title)}</b><small>${esc(sub || `${trend.activeMonths} 个月有记录 · 合计 ${money(trend.totalCents)}`)}</small></header>${trendChartHtml(trend, plot)}</article>`;
  }

  function rankCard(title, rank, sub) {
    if (!rank || !rank.items.length) return `<article class="cc-card"><header><b>${esc(title)}</b></header><div class="cc-empty">还没有可排行的记录。</div></article>`;
    return `<article class="cc-card"><header><b>${esc(title)}</b><small>${esc(sub || `共 ${rank.totalCount} 笔`)}</small></header>${rankChartHtml(rank, "次")}</article>`;
  }

  function paint() {
    const root = last?.root;
    if (!root || root.isConnected === false) return;
    styles();
    for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    const rows = last.rows;
    const plot = plotWidth(root);
    lastWidth = plot;
    const kindLabel = prefs.kind === "out" ? "消费" : "充值";
    const trend = chartTrend(rows, { kind: prefs.kind, months: prefs.months });
    const places = chartPlaces(rows, { kind: prefs.kind, limit: 6 });
    const week = chartWeekday(rows, { kind: prefs.kind });
    const cat = chartCategories(rows, { keywords: last.meta?.keywords });
    const kindChips = [["out", "消费"], ["in", "充值"]].map(([id, label]) =>
      `<button type="button" data-cc-kind="${id}" aria-pressed="${prefs.kind === id}">${label}</button>`).join("");
    const monthChips = Object.entries(MONTH_MODES).map(([id, label]) =>
      `<button type="button" data-cc-months="${id}" aria-pressed="${Number(id) === prefs.months}">${label}</button>`).join("");
    const empty = !rows.length
      ? `<div class="cc-empty">还没有已同步的一卡通流水。连接校园网后点「同步账单」，图形统计会自动跟着刷新。</div>`
      : "";
    root.innerHTML = `<section class="cc-panel">
<div class="cc-head"><h4>一卡通图形统计</h4>
<div class="cc-chips" data-cc-kindbox>${kindChips}</div>
<div class="cc-chips" data-cc-monthbox>${monthChips}</div></div>
${empty || `<div class="cc-chart-grid"${gridCols(plot)}>
${trendCard(`${kindLabel}金额趋势`, trend, "", plot)}
<article class="cc-card"><header><b>消费结构</b><small>${cat.count} 笔支出${cat.excludedCount ? ` · ${cat.excludedCount} 笔退款冲正未计入` : ""}</small></header>${cat.slices.length ? donutChartHtml(cat, donutWidth(plot)) : `<div class="cc-empty">所选流水里没有可分类的支出。</div>`}</article>
${rankCard(`${kindLabel}地点排行`, places, `共 ${places.totalCount} 笔 · 金额 ${money(places.totalCents)}`)}
<article class="cc-card cc-wide"><header><b>星期分布</b><small>${week.peak ? `最高 ${week.peak} · ${money(week.totalCents)}` : "暂无"}</small></header>${week.totalCents ? weekChartHtml(week) : `<div class="cc-empty">还没有可统计的${esc(kindLabel)}记录。</div>`}</article>
</div>
<p class="cc-note">全部基于本机已同步的一卡通流水；一卡通接口单次最多回 5000 笔，更早的历史可能不完整。<br>消费结构按商户与摘要关键词识别，商超、洗浴等不计入餐饮；金额为支出口径，不冲抵退款。</p>`}
${platformHtml(plot)}
<p class="cc-status${status && /失败/.test(status) ? " warn" : ""}" role="status">${esc(status)}</p>
</section>`;
    bind(root);
  }

  function attachGlow(root) {
    for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    for (const box of root.querySelectorAll("[data-cc-kindbox],[data-cc-monthbox]")) {
      let handle = null;
      try { handle = tide?.ui?.selectionGlow?.(box, { selector: 'button[aria-pressed="true"]' }) || null; } catch { handle = null; }
      if (handle) glowHandles.push(handle);
    }
  }

  function bind(root) {
    for (const btn of root.querySelectorAll("[data-cc-kind]")) {
      btn.onclick = () => {
        const next = btn.dataset.ccKind === "in" ? "in" : "out";
        if (next === prefs.kind) return;
        prefs = { ...prefs, kind: next };
        status = "";
        void persist();
        paint();
      };
    }
    for (const btn of root.querySelectorAll("[data-cc-months]")) {
      btn.onclick = () => {
        const next = Number(btn.dataset.ccMonths) === 6 ? 6 : 12;
        if (next === prefs.months) return;
        prefs = { ...prefs, months: next };
        status = "";
        void persist();
        paint();
      };
    }
    const plat = root.querySelector("[data-cc-platform]");
    if (plat) plat.onclick = () => { void loadPlatform(); };
    attachGlow(root);
  }

  /* 窗口尺寸一变就得按新宽度重画：viewBox 是按上一次的宽度定的，
     不重画就会把画布横向拉扁，字也跟着变形。 */
  const onResize = () => {
    const root = last?.root;
    if (!root || root.isConnected === false) return;
    if (Math.abs(plotWidth(root) - lastWidth) < 24) return;
    paint();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", onResize);
  }

  return {
    render(root, rows, meta = {}) {
      if (!root) return;
      last = { root, rows: Array.isArray(rows) ? rows : [], meta };
      paint();
    },
    dispose() {
      last = null;
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("resize", onResize);
      }
      for (const h of glowHandles.splice(0)) { try { h?.dispose?.(); } catch { /* ignore */ } }
    },
  };
}
