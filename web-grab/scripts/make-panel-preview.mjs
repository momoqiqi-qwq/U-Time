#!/usr/bin/env node
/**
 * 生成面板配色的静态预览页（docs/panel-preview.html）。
 *
 * 关键点：CSS、调色板、派生色全部**从 userscript 里现取**，不在这里重写一遍：
 *   · CSS        ← 抓 `const CSS = \`…\`` 原文；
 *   · PALETTES   ← 抓 `const PALETTES = {…}` 原文并 eval；
 *   · 派生色     ← 抓 `const V = (n) =>` 到 `const label = …` 之间那段原文当函数体执行。
 * 所以预览图展示的就是插件真正会用的颜色（改插件 → 重新生成即同步）。
 *
 *   node scripts/make-panel-preview.mjs          # 生成 HTML
 *   node scripts/make-panel-preview.mjs --check  # 只校验能否取出三段原文
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'userscript', 'spa-grab-enhancer.user.js');
const OUT = path.join(ROOT, 'docs', 'panel-preview.html');

const src = fs.readFileSync(SCRIPT, 'utf8');

// --- 1. 取 CSS -----------------------------------------------------------------
const cssMatch = src.match(/const CSS = `\n([\s\S]*?)\n  `;/);
if (!cssMatch) throw new Error('没能从 userscript 里取出 CSS 块');
const rawCss = cssMatch[1];

// --- 2. 取调色板 ---------------------------------------------------------------
const palMatch = src.match(/const PALETTES = (\{[\s\S]*?\n  \});/);
if (!palMatch) throw new Error('没能从 userscript 里取出 PALETTES');
const PALETTES = new Function(`return (${palMatch[1]});`)();

// --- 3. 取派生色逻辑（原样执行插件里的那些赋值） ---------------------------------
const a = src.indexOf('const V = (n) =>');
const b = src.indexOf('const label = source ===');
if (a < 0 || b < 0 || b < a) throw new Error('没能定位派生色代码段（const V = (n) => … const label = …）');
const deriveBlock = src.slice(a, b);
const buildVars = new Function('colors', 'mode', 'nephele', `${deriveBlock}\nreturn vars;`);

if (process.argv.includes('--check')) {
  console.log(`✓ CSS ${rawCss.length} 字符 / PALETTES ${Object.keys(PALETTES).length} 组 / 派生段 ${deriveBlock.length} 字符`);
  console.log(JSON.stringify(buildVars(PALETTES['nephele-light'], 'light', true), null, 2));
  process.exit(0);
}

// ------------------------------------------------------------------ 预览页

// :host → .pane（预览里没有 Shadow DOM），其余选择器原样保留
const pageCss = rawCss
  .replace(':host{all:initial}', '')
  .replace(/^ {2}header,main,footer\{position:relative;z-index:1\}$/m, '  header,main,footer{position:relative;z-index:1}')
  .replace(/:host\(\[data-wg-nephele="on"\]\)/g, '.pane[data-wg-nephele="on"]')
  .replace(/:host/g, '.pane');

const THEMES = [
  { key: 'light', mode: 'light', nephele: false, cap: '浅色 · 内置兜底', page: '#f4f2ee', note: '站点没有主题令牌时（或系统偏好浅色）' },
  { key: 'dark', mode: 'dark', nephele: false, cap: '深色 · 跟随系统', page: '#0f1721', note: 'prefers-color-scheme: dark，或页面 html.dark' },
  { key: 'nephele-light', mode: 'light', nephele: true, cap: 'Nephele 浅 · 云雾与星尘', page: '#ece5f4', note: '产品开启 Nephele 风格界面（浅色）' },
  { key: 'nephele-dark', mode: 'dark', nephele: true, cap: 'Nephele 深', page: '#211b2b', note: '产品 Nephele + 深色（或手动锁定 Nephele）' },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 星尘：与插件相同的固定种子，位置一致
function stars() {
  let seed = 20261011;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  for (let i = 0; i < 16; i += 1) {
    const size = rnd() > 0.75 ? 3 : 2;
    out.push(`<div class="wg-star" style="left:${(rnd() * 96 + 2).toFixed(2)}%;top:${(rnd() * 88 + 2).toFixed(2)}%;` +
      `width:${size}px;height:${size}px;animation-delay:${(rnd() * 4).toFixed(2)}s"></div>`);
  }
  return out.join('');
}

const ROWS = [
  { p: '/api/Competition.Competition/index', tags: ['17 行 @ data.data', 'POST', '200', '42ms'], good: true, sel: true },
  { p: '/api/Competition.CompetitionCate/index', tags: ['12 行 @ data', 'POST', '200', '31ms'], good: true },
  { p: '/api/Events.Events/index', tags: ['4 行 @ data.data', 'POST', '200', '28ms'], good: true },
  { p: '/api/SiteConfig/getFullConfig', tags: ['GET', '200', '19ms'] },
];

const BUTTONS = ['复制 curl', '复制原始 JSON', '导出 JSON (17 行)', '导出 CSV', '导出 Markdown', '复制 fetch 代码', '模竞全量抓取'];

const PRE = `listPath: data.data
字段(31): competition_id, title, title_sub, cate_id, level_id, stage, is_hot, is_rec …

[
  {
    "competition_id": 40,
    "title": "数维杯秋季赛",
    "created_time": 1756623600,
    "deadline": 1795194000
  },
  … 其余 15 行已省略
]`;

function pane(t) {
  const vars = buildVars(PALETTES[t.key], t.mode, t.nephele);
  const styleText = Object.entries(vars).map(([k, v]) => `--wg-${k}:${v}`).join(';');
  const note = t.nephele ? `配色：Nephele${t.mode === 'dark' ? '深色' : '浅色'}` : `配色：内置${t.mode === 'dark' ? '深色' : '浅色'}`;

  return `
  <section class="cell">
    <div class="cap"><b>${esc(t.cap)}</b><small>${esc(t.note)}</small></div>
    <div class="stage" style="background:${t.page}">
      <div class="pane" data-wg-nephele="${t.nephele ? 'on' : 'off'}" data-wg-mode="${t.mode}" style="${styleText}">
        <div class="wrap">
          <div class="wg-sky">
            <div class="wg-cloud c1"></div><div class="wg-cloud c2"></div><div class="wg-cloud c3"></div>
            ${stars()}
          </div>
          <header>
            <span class="title">SPA 抓取增强器</span>
            <input type="text" placeholder="过滤接口路径…" />
            <button class="mini">暂停</button>
            <button class="mini">主题·自动</button>
            <button class="mini ${t.nephele ? 'on' : ''}">Nephele·${t.nephele ? '开' : '自动'}</button>
            <span class="sp"></span>
            <button class="mini">✕</button>
          </header>
          <main>
            <div class="list">
              ${ROWS.map((r) => `
              <div class="item ${r.sel ? 'sel' : ''}">
                <div class="p">${esc(r.p)}</div>
                <div class="m">${r.tags.map((tg, i) => `<span class="tag ${r.good && i === 0 ? '' : 'dim'}">${esc(tg)}</span>`).join('')}</div>
              </div>`).join('')}
            </div>
            <div class="detail">
              <div class="bar">
                ${BUTTONS.map((btn, i) => `<button class="mini ${i === 2 ? 'primary' : ''}">${esc(btn)}</button>`).join('')}
              </div>
              <pre>${esc(PRE)}</pre>
            </div>
          </main>
          <footer>
            <span>Alt+G 开/关</span>
            <span class="note">${esc(note)}</span>
            <span>数据只在本地内存，不上传</span>
          </footer>
        </div>
        <div class="fab"><span>抓取增强</span><b>37</b></div>
      </div>
    </div>
  </section>`;
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>SPA 抓取增强器 · 面板配色预览</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 26px 30px 34px; background: #fbfaf8; color: #22303a;
         font: 14px/1.55 -apple-system, "Segoe UI", system-ui, "Microsoft YaHei", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 19px; }
  .lead { margin: 0 0 20px; color: #6b7783; font-size: 12.5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
  .cap { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .cap b { font-size: 13.5px; }
  .cap small { color: #8c99a4; font-size: 11.5px; }
  .stage { padding: 16px; border-radius: 16px; border: 1px solid rgba(0,0,0,.07); }

  ${pageCss}

  /* 预览专用：把 fixed 的面板摆进卡片里 */
  .pane { display: block; }
  .pane .wrap, .pane .fab { position: static; right: auto; bottom: auto; width: auto; height: auto; max-width: none; }
  .pane .wrap { width: 100%; height: 336px; }
  .pane .fab { display: inline-flex; margin-top: 12px; }
</style>
</head>
<body>
  <h1>SPA 抓取增强器 · 面板配色</h1>
  <p class="lead">同一份面板代码，四种配色。颜色全部来自 <code>--wg-*</code> 令牌：页面有主题令牌就借页面的（产品各主题 / shadcn 系站点），
  没有就用内置浅深两套；Nephele 打开时换紫调 + 毛玻璃 + 云雾星尘。</p>
  <div class="grid">${THEMES.map(pane).join('')}</div>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(`✓ 已生成 ${path.relative(process.cwd(), OUT)}（${Buffer.byteLength(html)} 字节，${THEMES.length} 种配色）`);
