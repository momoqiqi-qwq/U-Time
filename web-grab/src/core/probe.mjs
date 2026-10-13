/**
 * 通用「接口探测」增强：不针对任何单一站点。
 *
 * 思路 —— 静态层拿不到内容时，前端一定把接口地址写进了自己的 JS bundle 里：
 *   1) 抓 HTML，拿 module/preload 的 bundle 列表（shell.mjs）
 *   2) 下 bundle，正则捞出 `/api/x.y/z` 形态的端点
 *   3) 解 atob('...') 里藏的接口域（很多项目把 baseURL 用它包一层躲过肉眼搜索）
 *   4) 再顺着 bundle 里的动态 import 名字多爬一层，把懒加载路由的接口也捞出来
 *   5) 按「列表 / 详情 / 目录」给候选打标，直接给出可复制的下一步命令
 *
 * 这一步的意义：把一个没适配过的站点的「适配成本」从人工 F12 变成一条命令。
 */

import { getText } from './http.mjs';
import { analyzeHtml } from './shell.mjs';

const API_RE = /\/api\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+/g;
const ATAB_RE = /atob\(\s*['"]([A-Za-z0-9+/=]{8,})['"]\s*\)/g;
const DYN_IMPORT_RE = /["'`]\.\/([A-Za-z0-9_.\-]+\.js)["'`]/g;
const ABS_ORIGIN_RE = /https?:\/\/[A-Za-z0-9.\-]+(?:\:\d+)?/g;

function decodeBase64(value) {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function classify(path) {
  const tail = path.split('/').pop().toLowerCase();
  if (tail === 'index' || tail === 'list') return 'list';
  if (tail === 'detail' || tail === 'info') return 'detail';
  if (tail === 'cate' || tail === 'config' || tail === 'fields') return 'catalog';
  return 'other';
}

/**
 * @param {string} url 页面地址（通常是那个「抓不到」的页面）
 * @param {{maxBundles?:number, maxBytesPerBundle?:number, depth?:number, log?:(msg:string)=>void}} [opts]
 */
export async function probe(url, opts = {}) {
  const {
    maxBundles = 30,
    maxBytesPerBundle = 3 * 1024 * 1024,
    depth = 1,
    log = () => {},
  } = opts;

  const html = await getText(url, {
    headers: { Accept: 'text/html,*/*;q=0.8' },
    limitBytes: 2 * 1024 * 1024,
  });
  const shell = analyzeHtml(html, url);
  const pageOrigin = new URL(url).origin;

  const queue = shell.bundles.map((u) => ({ url: u, level: 0 }));
  const seen = new Set(queue.map((q) => q.url));
  const endpointHits = new Map(); // path -> Set(source)
  const originHits = new Map(); // origin -> Set(source)
  const fetched = [];
  const failures = [];

  while (queue.length && fetched.length < maxBundles) {
    const { url: bundleUrl, level } = queue.shift();
    let text = '';
    try {
      text = await getText(bundleUrl, {
        headers: { Accept: '*/*' },
        limitBytes: maxBytesPerBundle,
        timeoutMs: 45000,
        retries: 1,
      });
    } catch (err) {
      failures.push({ url: bundleUrl, error: err.message });
      continue;
    }
    fetched.push({ url: bundleUrl, bytes: text.length, level });
    log(`bundle ${fetched.length}/${maxBundles} ${bundleUrl} (${text.length}B)`);

    for (const m of text.matchAll(API_RE)) {
      if (!endpointHits.has(m[0])) endpointHits.set(m[0], new Set());
      endpointHits.get(m[0]).add(new URL(bundleUrl).pathname);
    }
    for (const m of text.matchAll(ATAB_RE)) {
      const decoded = decodeBase64(m[1]).trim();
      if (/^https?:\/\//i.test(decoded)) {
        const origin = decoded.replace(/\/+$/, '');
        if (!originHits.has(origin)) originHits.set(origin, new Set());
        originHits.get(origin).add(`${new URL(bundleUrl).pathname} (atob)`);
      }
    }
    for (const m of text.matchAll(ABS_ORIGIN_RE)) {
      const origin = m[0].replace(/\/+$/, '');
      if (origin === pageOrigin) continue;
      if (level > 0 && !/api|admin|gateway|server/i.test(origin)) continue;
      if (!originHits.has(origin)) originHits.set(origin, new Set());
      originHits.get(origin).add(new URL(bundleUrl).pathname);
    }
    if (level < depth) {
      for (const m of text.matchAll(DYN_IMPORT_RE)) {
        const next = new URL(`./${m[1]}`, bundleUrl).href;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push({ url: next, level: level + 1 });
      }
    }
  }

  const endpoints = [...endpointHits.entries()]
    .map(([path, sources]) => ({
      path,
      kind: classify(path),
      hits: sources.size,
      sources: [...sources].slice(0, 5),
    }))
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));

  const origins = [...originHits.entries()]
    .map(([origin, sources]) => ({ origin, hits: sources.size, sources: [...sources].slice(0, 5) }))
    .sort((a, b) => b.hits - a.hits);

  const apiOrigin = origins.length ? origins[0].origin : pageOrigin;
  const listEndpoints = endpoints.filter((e) => e.kind === 'list');
  const detailEndpoints = endpoints.filter((e) => e.kind === 'detail');

  const nextSteps = [];
  if (listEndpoints.length) {
    nextSteps.push(
      `候选列表接口：POST ${apiOrigin}${listEndpoints[0].path}  body: {"page":1,"limit":20}`
    );
    nextSteps.push(
      `先用 curl 直接打一发：curl -s -X POST '${apiOrigin}${listEndpoints[0].path}' -H 'Content-Type: application/json' -H 'Origin: ${pageOrigin}' --data-raw '{"page":1,"limit":20}'`
    );
  }
  if (detailEndpoints.length) {
    nextSteps.push(`候选详情接口：POST ${apiOrigin}${detailEndpoints[0].path}`);
  }
  if (origins.length) {
    nextSteps.push(`接口域：${apiOrigin}（来自 ${origins[0].sources.join(', ')}）`);
  }
  if (!endpoints.length) {
    nextSteps.push('没捞到 /api/ 形态端点：接口可能拼在变量里（如 `${base}/list`），或改用油猴插件抓运行时的真实 XHR');
  }

  return {
    page: url,
    shell,
    apiOrigin,
    origins,
    endpoints,
    listEndpoints,
    detailEndpoints,
    fetchedBundles: fetched,
    failures,
    nextSteps,
  };
}
