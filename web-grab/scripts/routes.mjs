#!/usr/bin/env node
/**
 * 路由表提取：SPA 的页面路由（也就是「详情页长什么样」）藏在入口 bundle 里，
 * 静态抓 HTML 是看不到的。这个脚本把路由字面量扒出来，方便给适配器拼 pageUrl。
 *
 *   node scripts/routes.mjs https://www.mojinghub.com/competitions
 *   node scripts/routes.mjs <bundle.js> --grep events
 */

import { getText } from '../src/core/http.mjs';
import { analyzeHtml } from '../src/core/shell.mjs';

const [target, ...rest] = process.argv.slice(2);
const grepIdx = rest.indexOf('--grep');
const grep = grepIdx >= 0 ? rest[grepIdx + 1] : null;

if (!target) {
  console.error('用法：node scripts/routes.mjs <页面URL|bundle.js> [--grep 关键词]');
  process.exit(1);
}

let bundleUrls = [];
if (/\.js(\?|$)/i.test(target)) {
  bundleUrls = [target];
} else {
  const html = await getText(target, { limitBytes: 4 * 1024 * 1024 });
  const report = analyzeHtml(html, target);
  // 路由表通常在入口 chunks 里；只扫 JS bundle，跳过 CSS
  bundleUrls = report.bundles.filter((u) => /\.js(\?|$)/i.test(u));
  console.log(`页面判定：${report.verdict}（${report.textLength} 字可见文本）`);
  console.log(`扫描 bundle：${bundleUrls.length} 个\n`);
}

const routeSet = new Set();
const lazySet = new Set();

for (const url of bundleUrls) {
  let js = '';
  try {
    js = await getText(url, { limitBytes: 8 * 1024 * 1024 });
  } catch (err) {
    console.error(`  跳过 ${url}：${err.message}`);
    continue;
  }

  // 常见形态：{path:"/competitions/:name/:time"} 或 path:"about"
  for (const m of js.matchAll(/path\s*:\s*["'`]([^"'`]{0,120})["'`]/g)) {
    const p = m[1];
    if (p.startsWith('http')) continue;
    routeSet.add(p);
  }
  // react-router v6 的 useRoutes 数组里也可能是 {index:true}
  for (const m of js.matchAll(/index\s*:\s*!0\s*,\s*element/g)) lazySet.add('(index route)');
  // 动态 import 的 chunk 名，能看出有哪些页面
  for (const m of js.matchAll(/import\(["'`]\.?\/?([\w./-]+\.js)["'`]\)/g)) lazySet.add(m[1]);
}

const routes = [...routeSet].filter((p) => (grep ? p.includes(grep) : true)).sort();
console.log(`路由 ${routes.length} 条：`);
for (const r of routes) console.log(`  ${r.startsWith('/') ? r : `/${r}`}`);

if (lazySet.size) {
  console.log(`\n懒加载 chunk ${lazySet.size} 个（前 20）：`);
  console.log([...lazySet].slice(0, 20).map((c) => `  ${c}`).join('\n'));
}
