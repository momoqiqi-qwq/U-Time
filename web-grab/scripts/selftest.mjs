#!/usr/bin/env node
/**
 * 自检：离线部分是纯函数断言（不做网络请求），加 --online 再跑一遍真实接口验收。
 *
 *   node scripts/selftest.mjs            # 离线
 *   node scripts/selftest.mjs --online   # 离线 + 联网实测
 */

import { analyzeHtml } from '../src/core/shell.mjs';
import {
  renderCsv,
  renderIcs,
  renderJson,
  renderMarkdown,
  renderTable,
  formatFromPath,
  FORMATS,
} from '../src/render.mjs';
import mojinghub, { computeStatus, toRecord, fmtCn, ADMIN_ORIGIN } from '../src/adapters/mojinghub.mjs';
import { listAdapters, requireAdapter, matchAdapter } from '../src/adapters/index.mjs';

const online = process.argv.includes('--online');

let passed = 0;
const failures = [];
let group = '';

function section(name) {
  group = name;
  console.log(`\n── ${name}`);
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${group} / ${name}: ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${group} / ${name}: ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ------------------------------------------------------------ 1. 空壳判定

section('空壳判定 analyzeHtml');

const SPA_HTML = `<!doctype html><html><head>
<link rel="modulepreload" href="/vendor-react-abc.js">
<script type="module" src="/index-abc.js"></script>
</head><body><div id="root"></div></body></html>`;

check('纯前端骨架 → spa-shell', () => {
  const r = analyzeHtml(SPA_HTML, 'https://example.com/competitions');
  eq(r.verdict, 'spa-shell', 'verdict');
  assert(r.mountPoints.includes('root'), '应识别 #root');
  assert(r.moduleScripts.length === 1, 'module 脚本数');
  assert(r.bundles.length === 2, `bundle 去重数（实际 ${r.bundles.join(',')}）`);
});

check('静态内容页 → 不是 spa-shell', () => {
  const body = '这是一篇很长的静态文章。'.repeat(200);
  const r = analyzeHtml(`<html><body><p>${body}</p></body></html>`, 'https://example.com/a');
  assert(r.verdict !== 'spa-shell', `verdict=${r.verdict}，长文静态页不该判成壳子`);
  eq(r.verdict, 'static', 'verdict');
});

check('内联 window.__X__ 配置能被揪出来', () => {
  const r = analyzeHtml(
    `<html><body><div id="app"></div><script>window.__INITIAL_STATE__={a:1}</script></body></html>`,
    'https://example.com/'
  );
  assert(r.inlineConfig.includes('__INITIAL_STATE__'), `inlineConfig=${r.inlineConfig}`);
});

// ------------------------------------------------------------ 2. 渲染层

section('渲染层 render');

const ROWS = [
  {
    kind: 'competitions',
    id: 40,
    title: '数维杯, "秋季赛"',
    subtitle: 'swbmcm',
    category: '数学建模',
    level: '国家级',
    method: '线上',
    organizer: '中国仿真学会',
    publisher: '组委会',
    feeType: '收费',
    feeAmount: 200,
    status: '报名进行中',
    signupStart: '2026-07-30T16:00:00.000Z',
    signupEnd: '2026-11-19T22:00:00.000Z',
    runStart: '2026-11-20T01:00:00.000Z',
    runEnd: '2026-11-24T02:00:00.000Z',
    signupStartCn: '2026-07-31 00:00',
    signupEndCn: '2026-11-20 06:00',
    runStartCn: '2026-11-20 09:00',
    runEndCn: '2026-11-24 10:00',
    isHot: true,
    isRecommended: true,
    signupMode: '站内报名',
    externalSignupUrl: '',
    pageUrl: 'https://www.mojinghub.com/competitions/swbmcm/1785318298',
    updatedAt: '2026-09-03T01:28:33.000Z',
  },
];

check('JSON 可被解析回原结构', () => {
  const back = JSON.parse(renderJson(ROWS));
  eq(back[0].id, 40, 'id');
  eq(back.length, 1, '长度');
});

check('CSV 处理逗号与引号，带 BOM', () => {
  const csv = renderCsv(ROWS);
  assert(csv.startsWith('\uFEFF'), '应以 BOM 开头（Excel 打开不乱码）');
  assert(csv.includes('"数维杯, ""秋季赛"""'), `CSV 未正确转义：${csv.split('\r\n')[1]}`);
});

check('Markdown 表格转义竖线', () => {
  const md = renderMarkdown([{ ...ROWS[0], title: 'a|b' }]);
  assert(md.includes('a\\|b'), 'Markdown 竖线未转义');
  assert(md.includes('# '), '缺标题行');
});

check('终端表格不会抛错且有表头', () => {
  const t = renderTable(ROWS);
  assert(t.includes('标题') && t.includes('报名截止'), '表头缺失');
});

check('ICS 行不超过 75 字节（RFC5545）', () => {
  const ics = renderIcs(ROWS, { window: 'both' });
  for (const line of ics.split('\r\n')) {
    const bytes = Buffer.byteLength(line, 'utf8');
    assert(bytes <= 75, `超长行 ${bytes} 字节: ${line.slice(0, 40)}…`);
  }
});

check('ICS 结构合法：VCALENDAR 包裹、UID 唯一、时间用浮动东八区', () => {
  const ics = renderIcs(ROWS, { window: 'both' });
  const events = (ics.match(/BEGIN:VEVENT/g) || []).length;
  const ends = (ics.match(/END:VEVENT/g) || []).length;
  eq(events, 2, 'both 窗口应有比赛+报名两个事件');
  eq(events, ends, 'BEGIN/END 配对');
  eq((ics.match(/BEGIN:VCALENDAR/g) || []).length, 1, 'VCALENDAR 数');
  assert(ics.includes('UID:grab-competitions-40-run@mojinghub.web-grab'), 'run 事件 UID');
  assert(ics.includes('UID:grab-competitions-40-signup@mojinghub.web-grab'), 'signup 事件 UID');
  // 默认 local：不写 Z，且必须是东八区口径（UTC 01:00 → 北京 09:00）
  assert(ics.includes('DTSTART:20261120T090000'), '默认应为浮动东八区时间');
  assert(!/DTSTART:\d{8}T\d{6}Z/.test(ics), '默认不应带 Z');
  assert(ics.endsWith('END:VCALENDAR\r\n'), '结尾');
});

check('ICS --ics-tz utc 输出标准 UTC', () => {
  const ics = renderIcs(ROWS, { window: 'both', tz: 'utc' });
  assert(ics.includes('DTSTART:20261120T010000Z'), 'UTC 口径应为 01:00Z');
});

check('ICS --ics-days all 把跨天窗口按天展开', () => {
  const ics = renderIcs(ROWS, { window: 'run', days: 'all' });
  const events = (ics.match(/BEGIN:VEVENT/g) || []).length;
  // 比赛 11-20 09:00 → 11-24 10:00，跨 5 天
  eq(events, 5, `跨天窗口应出 5 条，实际 ${events}`);
  assert(ics.includes('UID:grab-competitions-40-run-20261120@mojinghub.web-grab'), '含按天 UID');
  assert(ics.includes('UID:grab-competitions-40-run-20261124@mojinghub.web-grab'), '含最后一天 UID');
});

check('ICS --ics-days all 对同天窗口不展开成多条', () => {
  const sameDay = {
    ...ROWS[0],
    runStart: '2026-11-20T01:00:00.000Z',
    runEnd: '2026-11-20T05:00:00.000Z',
  };
  eq((renderIcs([sameDay], { window: 'run', days: 'all' }).match(/BEGIN:VEVENT/g) || []).length, 1, '同天窗口');
});

check('ICS --ics-days all 超过 21 天的长窗口只出一条「截止」事件', () => {
  const longWindow = {
    ...ROWS[0],
    runStart: '2026-01-01T00:00:00.000Z',
    runEnd: '2026-12-31T00:00:00.000Z',
  };
  const ics = renderIcs([longWindow], { window: 'run', days: 'all' });
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 1, '长窗口不该铺满日历');
  assert(ics.includes('UID:grab-competitions-40-run-deadline@mojinghub.web-grab'), '应为 deadline UID');
  assert(ics.includes('（截止）'), '标题应标出截止');
  // 窗口末尾 2026-12-31T00:00Z → 北京 08:00，截止事件提前 1 小时
  assert(ics.includes('DTEND:20261231T080000'), `截止时间不对：${ics.match(/DTEND:[^\r\n]*/)?.[0]}`);
});

check('ICS --ics-days all 长报名窗口同样只出截止事件（不淹日历）', () => {
  const ics = renderIcs(ROWS, { window: 'signup', days: 'all' });
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 1, '报名窗口 7-31→11-20 属长窗口');
  assert(ics.includes('[报名] （截止）'), '标题应带 [报名] （截止）');
});

check('ICS 只有 run 窗口时只有一个事件', () => {
  const ics = renderIcs(ROWS, {});
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 1, '事件数');
});

check('ICS 缺少时间时不生成事件（不写脏日历）', () => {
  const ics = renderIcs([{ ...ROWS[0], runStart: null, runEnd: null }], {});
  eq((ics.match(/BEGIN:VEVENT/g) || []).length, 0, '事件数');
});

check('formatFromPath 认扩展名', () => {
  eq(formatFromPath('a.JSON'), 'json', '大写扩展名');
  eq(formatFromPath('x/y.md'), 'md', 'md');
  eq(formatFromPath('c.ics'), 'ics', 'ics');
  eq(formatFromPath('c.csv'), 'csv', 'csv');
  eq(formatFromPath('c.bin'), null, '未知');
});

check('FORMATS 与 CLI 选项一致', () => {
  eq(FORMATS.join(','), 'json,csv,md,ics,table', '格式清单');
});

// ------------------------------------------------------------ 3. 适配器纯函数

section('适配器纯函数 mojinghub');

check('computeStatus：报名未开始', () => {
  eq(
    computeStatus(
      { signup_start: 2000, signup_end: 3000, start_time: 4000, end_time: 5000 },
      new Date(1000 * 1000)
    ),
    '报名未开始'
  );
});

check('computeStatus：报名进行中', () => {
  eq(
    computeStatus(
      { signup_start: 1000, signup_end: 3000, start_time: 4000, end_time: 5000 },
      new Date(2000 * 1000)
    ),
    '报名进行中'
  );
});

check('computeStatus：报名已截止（未开赛）', () => {
  eq(
    computeStatus(
      { signup_start: 1000, signup_end: 3000, start_time: 4000, end_time: 5000 },
      new Date(3500 * 1000)
    ),
    '报名已截止'
  );
});

check('computeStatus：比赛进行中', () => {
  eq(
    computeStatus(
      { signup_start: 1000, signup_end: 3000, start_time: 4000, end_time: 5000 },
      new Date(4500 * 1000)
    ),
    '比赛进行中'
  );
});

check('computeStatus：已结束（时间戳超界优先）', () => {
  eq(
    computeStatus(
      { signup_start: 1000, signup_end: 3000, start_time: 4000, end_time: 5000 },
      new Date(6000 * 1000)
    ),
    '已结束'
  );
});

check('toRecord：嵌套关联对象与费用/报名方式映射', () => {
  const rec = toRecord({
    competition_id: 7,
    title: '测试赛',
    title_sub: 'test',
    created_time: 1700000000,
    stage: 1,
    fee_type: 2,
    fee_amount: '99.50',
    signup_mode: 1,
    external_signup_url: 'https://example.com/signup',
    is_hot: 1,
    is_rec: 0,
    cover_image: '/uploads/a.jpg',
    wcompetitioncate: { cate_name: '数学建模' },
    wcompetitionlevel: { level_name: '国家级' },
    wcompetitionmethod: { method_name: '线上' },
  });
  eq(rec.id, 7, 'id');
  eq(rec.category, '数学建模', 'category');
  eq(rec.level, '国家级', 'level');
  eq(rec.method, '线上', 'method');
  eq(rec.feeType, '收费', 'feeType');
  eq(rec.feeAmount, 99.5, 'feeAmount');
  eq(rec.signupMode, '官网报名', 'signupMode');
  eq(rec.isHot, true, 'isHot');
  eq(rec.isRecommended, false, 'isRecommended');
  eq(rec.cover, `${ADMIN_ORIGIN}/uploads/a.jpg`, '相对封面应补接口域');
  eq(rec.pageUrl, 'https://www.mojinghub.com/competitions/test/1700000000', '详情页路由');
  eq(rec.id && rec.kind, 'competitions', 'kind');
});

check('fmtCn 固定东八区', () => {
  eq(fmtCn(new Date('2026-11-19T22:00:00.000Z')), '2026-11-20 06:00', 'UTC+8 换算');
  eq(fmtCn(null), '', '空值');
});

check('适配器注册与命中', () => {
  const ids = listAdapters().map((a) => a.id);
  assert(ids.includes('mojinghub'), `已装适配器：${ids.join(', ')}`);
  eq(matchAdapter('https://www.mojinghub.com/competitions')?.id, 'mojinghub', 'match 命中');
  eq(matchAdapter('https://example.com/')?.id ?? null, null, '非本站不命中');
  assert(requireAdapter('https://www.mojinghub.com/events'), 'requireAdapter 应返回适配器');
});

check('resolve：competitions / events 分流', () => {
  eq(mojinghub.resolve('https://www.mojinghub.com/events').kind, 'events', 'events');
  eq(mojinghub.resolve('https://www.mojinghub.com/competitions').kind, 'competitions', 'competitions');
  eq(mojinghub.resolve('https://www.mojinghub.com/competitions', 'events').kind, 'events', '显式覆盖');
});

check('活动详情路由：规范形态优先，缺字段退回老链接', () => {
  const full = toRecord({ events_id: 4, title: '夏令营', title_sub: 'xly', created_time: 1700000000 }, 'events');
  eq(full.pageUrl, 'https://www.mojinghub.com/events/xly/1700000000', '规范形态');
  const legacy = toRecord({ events_id: 9, title: 'x' }, 'events');
  eq(legacy.pageUrl, 'https://www.mojinghub.com/events/9', '老链接兜底');
});

// ------------------------------------------------------------ 4. 联网验收

if (!online) {
  console.log('\n（跳过联网验收，加 --online 启用）');
} else {
  section('联网验收（真实接口）');

  const H = { Origin: 'https://www.mojinghub.com', Referer: 'https://www.mojinghub.com/competitions' };

  await checkAsync('列表接口返回体量合理', async () => {
    const res = await mojinghub.list('competitions', { limit: 100 });
    assert(res.total > 0, `total=${res.total}`);
    eq(res.rows.length, res.total <= 100 ? res.total : 100, '本页行数');
    assert(res.rows.every((r) => r.id && r.title), '每行都应有 id/title');
    assert(res.rows.every((r) => r.status), '每行都应算出状态');
  });

  await checkAsync('过滤参数 title 生效', async () => {
    const res = await mojinghub.list('competitions', { title: '建模', limit: 100 });
    assert(res.total > 0, '应命中');
    assert(res.rows.every((r) => r.title.includes('建模')), '命中行标题应都含关键词');
  });

  await checkAsync('过滤参数 cate_id 生效', async () => {
    const res = await mojinghub.list('competitions', { cate_id: 6, limit: 100 });
    assert(res.total > 0, 'cate_id=6 应有数据');
    assert(res.rows.every((r) => r.category === '数学建模'), '行类别应一致');
  });

  await checkAsync('分类目录接口可用', async () => {
    const cat = await mojinghub.catalog('competitions');
    assert(Array.isArray(cat.cate_list) && cat.cate_list.length > 0, 'cate_list 非空');
    assert(Array.isArray(cat.level_list) && cat.level_list.length > 0, 'level_list 非空');
  });

  await checkAsync('活动接口可用', async () => {
    const res = await mojinghub.list('events', { limit: 100 });
    assert(res.total > 0, `events total=${res.total}`);
    assert(res.rows[0].id, 'events 行应有 id');
  });

  await checkAsync('详情接口给出正文与详情页', async () => {
    const list = await mojinghub.list('competitions', { limit: 100 });
    const id = list.rows[0].id;
    const rec = await mojinghub.detail('competitions', id);
    eq(rec.id, id, 'id 一致');
    assert(rec.title, '标题');
    assert(rec.pageUrl.includes('/competitions/'), `pageUrl=${rec.pageUrl}`);
    assert(rec.overviewText || rec.description, '应有正文或简介');
  });

  await checkAsync('all() 翻页聚合与 total 一致', async () => {
    const res = await mojinghub.all('competitions', { limit: 100 });
    eq(res.rows.length, res.total, '聚合行数应等于 total');
    const ids = new Set(res.rows.map((r) => r.id));
    eq(ids.size, res.rows.length, '不应有重复 id');
  });

  await checkAsync('ICS 导出全部行都能落地', async () => {
    const res = await mojinghub.all('competitions', { limit: 100 });
    const ics = renderIcs(res.rows, { window: 'both' });
    const events = (ics.match(/BEGIN:VEVENT/g) || []).length;
    assert(events >= res.rows.length, `事件数 ${events} 少于行数 ${res.rows.length}`);
  });
}

// ------------------------------------------------------------ 结果

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  failures.forEach((f) => console.log(`   · ${f}`));
  process.exitCode = 1;
} else {
  console.log(`✓ ${passed} 项全部通过${online ? '（含联网验收）' : '（离线）'}`);
}
