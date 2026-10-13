/**
 * 空壳检测：判断一个 URL 的「静态层」是否只返回 SPA 壳子。
 * 判据（全部来自实测）：
 *   1) 去掉 script/style 后的可见文本极少
 *   2) 存在空的主挂载点（#root / #app / #__next 等）
 *   3) 存在 <script type="module"> 或 modulepreload —— 即数据由 JS 运行时再取
 * 命中即 verdict = 'spa-shell'，此时 fetch/web_fetch 都会「抓不到内容」。
 */

import { getText } from './http.mjs';

const MOUNT_IDS = ['root', 'app', '__next', '__nuxt', 'mount'];

function stripToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? m[1] : '';
}

function absolutize(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return '';
  }
}

/**
 * 静态分析一段 HTML。
 * @param {string} html
 * @param {string} baseUrl
 */
export function analyzeHtml(html, baseUrl) {
  const text = stripToText(html);
  const mountFound = MOUNT_IDS.filter((id) =>
    new RegExp(`id\\s*=\\s*["']${id}["']`, 'i').test(html)
  );

  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  const moduleScripts = scripts
    .filter((tag) => /type\s*=\s*["']module["']/i.test(tag))
    .map((tag) => absolutize(attr(tag, 'src'), baseUrl))
    .filter(Boolean);

  const classicScripts = scripts
    .filter((tag) => !/type\s*=\s*["']module["']/i.test(tag))
    .map((tag) => absolutize(attr(tag, 'src'), baseUrl))
    .filter(Boolean);

  const preloads = [...html.matchAll(/<link\b[^>]*modulepreload[^>]*>/gi)]
    .map((m) => absolutize(attr(m[0], 'href'), baseUrl))
    .filter(Boolean);

  const stylesheets = [...html.matchAll(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi)]
    .map((m) => absolutize(attr(m[0], 'href'), baseUrl))
    .filter(Boolean);

  // 内联 JSON 配置（有些站点把接口地址/站点配置塞在 window.__X__ 里）
  const inlineConfig = [...html.matchAll(/window\.(__[A-Z0-9_]+__)\s*=/gi)].map((m) => m[1]);

  const bundles = [...new Set([...moduleScripts, ...preloads, ...classicScripts])];

  const reasons = [];
  if (text.length < 600) reasons.push(`去标签可见文本仅 ${text.length} 字`);
  if (mountFound.length) reasons.push(`存在空挂载点 #${mountFound.join(' / #')}`);
  if (moduleScripts.length || preloads.length) reasons.push('存在 module 脚本 / modulepreload（内容由 JS 运行时获取）');

  let verdict = 'unknown';
  if ((moduleScripts.length || preloads.length) && text.length < 1200 && mountFound.length) {
    verdict = 'spa-shell';
  } else if (text.length >= 1200 && !moduleScripts.length) {
    verdict = 'static';
  }

  const hints = [];
  if (verdict === 'spa-shell') {
    hints.push('静态层只是壳子，抓 HTML 拿不到数据 —— 改抓它的数据接口（F12 → Network → Fetch/XHR）');
    hints.push('先用 `web-grab probe <url>` 让工具自己把接口候选列出来');
  }
  if (mountFound.length) hints.push(`挂载点：#${mountFound.join(' / #')}`);
  if (inlineConfig.length) hints.push(`内联配置变量：${inlineConfig.join(', ')}`);

  return {
    url: baseUrl,
    htmlBytes: html.length,
    textLength: text.length,
    mountPoints: mountFound,
    moduleScripts,
    classicScripts,
    preloads,
    stylesheets,
    inlineConfig,
    bundles,
    verdict,
    reasons,
    hints,
  };
}

/**
 * 抓取并分析。
 * @param {string} url
 */
export async function inspectUrl(url) {
  const html = await getText(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    limitBytes: 2 * 1024 * 1024,
  });
  const report = analyzeHtml(html, url);
  report.htmlHead = html.slice(0, 4000);
  return report;
}
