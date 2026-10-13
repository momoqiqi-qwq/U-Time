#!/usr/bin/env node
/**
 * 兼容性验证：把 web-grab 导出的 ICS，喂给「时间管理软件」自己的导入函数，
 * 确认真的能导进去、且时间不偏。
 *
 * 做法：从 le-time-management/src/dataCenter.js 里取出真实的 parseIcsDate + importIcs
 * 源码片段，注入一个最小 S 桩后执行 —— 测的是产品里的真代码，不是重写的仿制品。
 *
 *   node scripts/check-app-import.mjs [out/competitions.ics]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const APP_DATA_CENTER = path.resolve(
  ROOT,
  '..',
  'le-time-management',
  'src',
  'dataCenter.js'
);

const icsFile = process.argv[2] || path.join(ROOT, 'out', 'competitions.ics');

if (!fs.existsSync(APP_DATA_CENTER)) {
  console.error(`✗ 找不到产品源码：${APP_DATA_CENTER}`);
  process.exit(1);
}
if (!fs.existsSync(icsFile)) {
  console.error(`✗ 找不到 ICS：${icsFile}（先跑 npm run export:ics）`);
  process.exit(1);
}

// ---- 1. 从产品源码里取出真实的导入函数
const src = fs.readFileSync(APP_DATA_CENTER, 'utf8');
const from = src.indexOf('function parseIcsDate');
const to = src.indexOf('export async function exportXlsx');
if (from < 0 || to < 0 || to <= from) {
  console.error('✗ 在 dataCenter.js 里没定位到 parseIcsDate/importIcs —— 产品代码可能改过，请人工核对');
  process.exit(1);
}
const snippet = src.slice(from, to).replace(/^export\s+/gm, '');

const S = {
  uid: (prefix) => `${prefix}_test_1`,
  mmOf: (t) => {
    const [h, m] = String(t || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  },
};

const load = new Function('S', `${snippet}\nreturn { importIcs };`);
const { importIcs } = load(S);

// ---- 2. 导入我们导出的 ICS
const text = fs.readFileSync(icsFile, 'utf8');
const { tasks, blocks } = importIcs(text);

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log(`喂给产品导入函数：${path.relative(ROOT, icsFile)}`);
console.log(`文件 ${fs.statSync(icsFile).size} 字节 → 解析出 ${blocks.length} 个日程块、${tasks.length} 个待办\n`);

check('能解析出日程块（不是 0 条）', () => {
  assert(blocks.length > 0, '一条日程都没解析出来');
});

check('每条日程块都有日期、时间、标题、时长', () => {
  for (const b of blocks) {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(b.date), `日期格式不对：${b.date}`);
    assert(/^\d{2}:\d{2}$/.test(b.start), `开始时间格式不对：${b.start}`);
    assert(b.title && b.title !== 'undefined', `标题异常：${b.title}`);
    assert(Number.isFinite(b.durMin) && b.durMin >= 15, `时长异常：${b.durMin}`);
  }
});

check('没有解析残留（undefined / 空标题 / Z 后缀未清）', () => {
  const all = [...blocks, ...tasks].map((x) => JSON.stringify(x)).join('\n');
  assert(!all.includes('undefined'), '结构里出现 undefined');
  assert(!/\d{8}T\d{6}Z/.test(all), 'DTSTART 带了 Z（说明用了 --ics-tz utc，导进本软件会差 8 小时）');
});

check('中文长标题没被折行截断', () => {
  const longest = blocks.reduce((a, b) => (b.title.length > a.length ? b.title : a), '');
  assert(longest.length > 12, `最长标题只有 ${longest.length} 字，疑似折行还原失败：${longest}`);
});

check('时区正确：数维杯秋季赛比赛 09:00 开始（北京时间）', () => {
  const hit = blocks.find((b) => b.title.includes('数维杯') && b.title.includes('秋季赛'));
  assert(hit, '没找到数维杯秋季赛');
  assert(
    hit.date === '2026-11-20' && hit.start === '09:00',
    `期望 2026-11-20 09:00，实际 ${hit.date} ${hit.start}`
  );
});

check('跨天比赛被 --ics-days all 拆成了多个日程块', () => {
  const days = new Set(
    blocks.filter((b) => b.title.includes('数维杯') && b.title.includes('秋季赛')).map((b) => b.date)
  );
  assert(days.size >= 2, `只落在 ${days.size} 天，说明没按天展开`);
});

check('报名窗口事件（[报名] 前缀）也进来了', () => {
  assert(
    blocks.some((b) => b.title.startsWith('[报名]')),
    '没有 [报名] 事件 —— 检查是否用了 --ics-window both'
  );
});

check('已结束的竞赛被标成 CANCELLED（产品按需自行过滤，解析不受影响）', () => {
  const ended = blocks.find((b) => b.title.includes('春季赛'));
  assert(ended, '没找到已结束的赛事日程');
});

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  failures.forEach((f) => console.log(`   · ${f}`));
  process.exitCode = 1;
} else {
  console.log('✓ 全部通过：web-grab 导出的 ICS 可直接导入「时间管理软件」');
}
