#!/usr/bin/env node
/**
 * 油猴增强插件的真实执行验证。
 *
 * 浏览器（Chrome DevTools 代理）不可用时，用 Node 的 vm 造一个「够用的假页面」，
 * 直接把 userscript 跑起来，然后：
 *   1. 真实调用模竞接口拿一份真响应，塞进被 hook 的 fetch，看它认不认得这是列表接口；
 *   2. 校验请求透传（hook 不能破坏页面自己的 fetch）、XHR 分支、暂停开关、导出格式；
 *   3. 校验「模竞全量抓取」按钮的翻页与落盘。
 *
 *   node scripts/check-userscript.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SCRIPT = path.join(ROOT, 'userscript', 'spa-grab-enhancer.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};
const eq = (a, b, msg) => assert(a === b, `${msg || 'not equal'}：期望 ${b}，实际 ${a}`);

// ---------------------------------------------------------------- 假页面

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: { cssText: '' },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attrs: {},
    textContent: '',
    id: '',
    title: '',
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append(...nodes) {
      nodes.forEach((c) => c && this.children.push(c));
    },
    prepend(...nodes) {
      this.children.unshift(...nodes.filter(Boolean));
    },
    replaceChildren(...nodes) {
      this.children = nodes.filter(Boolean);
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    },
    remove() {
      this.removed = true;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'id') this.id = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    addEventListener() {},
    removeEventListener() {},
    click() {
      this.clicked = true;
      if (this.download) sync.downloads.push({ name: this.download, href: this.href });
    },
    attachShadow() {
      const sr = makeEl('#shadow-root');
      this.shadowRoot = sr;
      return sr;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    get firstChild() {
      return this.children[0] || null;
    },
    contains() {
      return true;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._html || '';
    },
    set(v) {
      el._html = v;
    },
  });
  return el;
}

/** 主线程里攒的同步副作用（下载、剪贴板），供断言读取。 */
const sync = { downloads: [], clipboard: [], toasts: [] };

function makeSandbox({ fetchImpl, realPayload, extras = {} }) {
  const documentElement = makeEl('html');
  // 记录 document 上注册的监听器，测试里可以手动触发 DOMContentLoaded
  const docListeners = {};
  const document = {
    documentElement,
    head: makeEl('head'),
    body: makeEl('body'),
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ textContent: t }),
    getElementById: () => null,
    addEventListener(type, fn) {
      (docListeners[type] || (docListeners[type] = [])).push(fn);
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  documentElement.appendChild = function (c) {
    this.children.push(c);
    return c;
  };

  class FakeXHR {
    constructor() {
      this.headers = {};
      this.listeners = {};
      this.readyState = 0;
      this.responseText = '';
      this.responseType = '';
      this.status = 0;
      this._url = '';
    }
    open(method, url) {
      this._method = method;
      this._url = url;
      this.readyState = 1;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    getAllResponseHeaders() {
      return 'content-type: application/json\r\n';
    }
    getResponseHeader(k) {
      return String(k).toLowerCase() === 'content-type' ? 'application/json' : null;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    send() {
      const loaders = this.listeners.load || [];
      this.status = 200;
      this.readyState = 4;
      loaders.forEach((fn) => fn.call(this));
    }
    /** 测试用：直接给一次响应 */
    _emit(status, text, ct = 'application/json') {
      this.status = status;
      this.responseText = text;
      this.readyState = 4;
      (this.listeners.load || []).forEach((fn) => fn.call(this));
    }
  }

  const win = {
    location: {
      href: 'https://www.mojinghub.com/competitions',
      hostname: 'www.mojinghub.com',
      origin: 'https://www.mojinghub.com',
      protocol: 'https:',
    },
    navigator: {
      clipboard: {
        writeText: (t) => {
          sync.clipboard.push(t);
          return Promise.resolve();
        },
      },
      userAgent: 'node-vm',
    },
    fetch: fetchImpl,
    XMLHttpRequest: FakeXHR,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 5)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Blob: class {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts?.type || '';
        this.text = async () => parts.join('');
      }
    },
    URL: class extends URL {
      static createObjectURL(blob) {
        sync.downloads.push({ blob });
        return 'blob:fake';
      }
      static revokeObjectURL() {}
    },
    console,
    JSON,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    RegExp,
    Map,
    Set,
    Intl,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.globalThis = win;
  win.document = document;
  Object.assign(win, extras);

  const ctx = vm.createContext(win);
  return { win, ctx, document, sync, FakeXHR, docListeners };
}

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return makeResponse(text, 'application/json; charset=utf-8', status);
}

/** 返回 text/html 的响应：hook 应当直接忽略。 */
function textResponse(body, status = 200) {
  return makeResponse(body, 'text/html; charset=utf-8', status);
}

function makeResponse(text, contentType, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(Buffer.byteLength(text));
        return null;
      },
    },
    clone() {
      return {
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// ---------------------------------------------------------------- 真数据

let realList = null;
let realDetail = null;
try {
  const res = await fetch('https://admin.mojinghub.com/api/Competition.Competition/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.mojinghub.com' },
    body: JSON.stringify({ lite: 1, page: 1, limit: 100 }),
    signal: AbortSignal.timeout(15000),
  });
  realList = await res.json();
  const id = realList?.data?.data?.[0]?.competition_id;
  if (id) {
    const d = await fetch('https://admin.mojinghub.com/api/Competition.Competition/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.mojinghub.com' },
      body: JSON.stringify({ competition_id: id }),
      signal: AbortSignal.timeout(15000),
    });
    realDetail = await d.json();
  }
  console.log(`拿到真实响应：列表 ${realList?.data?.data?.length} 行 / 详情 id=${id}\n`);
} catch (err) {
  console.log(`⚠ 取真实响应失败（${err.message}），改用合成样本\n`);
  realList = {
    code: 1,
    msg: 'ok',
    data: {
      total: 2,
      last_page: 1,
      data: [
        { competition_id: 1, title: '样本A', title_sub: 'a', stage: 1 },
        { competition_id: 2, title: '样本B', title_sub: 'b', stage: 4 },
      ],
    },
  };
}

// ---------------------------------------------------------------- 跑起来

console.log('把 userscript 丢进假页面执行：');

let box;
let fetchedUrls = [];
let responseMode = 'json';
const fetchImpl = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  fetchedUrls.push({ url, init });
  return Promise.resolve(
    responseMode === 'html'
      ? textResponse('<!doctype html><html><body><div id="root"></div></body></html>')
      : jsonResponse(realList)
  );
};

box = makeSandbox({ fetchImpl, realPayload: realList });
const rawFetchBefore = box.win.fetch;
vm.runInContext(src, box.ctx, { filename: SCRIPT });
const api = box.win.__spaGrab;

await check('脚本加载后暴露出调试入口 window.__spaGrab', () => {
  assert(api, '__spaGrab 没挂上');
  eq(api.version, '1.1.1', 'version');
});

await check('面板构建没抛错（假 DOM 上完整走了一遍 buildUI）', () => {
  const host = box.document.documentElement.children.find((c) => c.id === 'web-grab-enhancer');
  assert(host, '宿主元素没挂到 documentElement');
  assert(host.shadowRoot, '没建 Shadow DOM');
  assert(host.shadowRoot.children.length > 0, 'Shadow DOM 里没塞样式');
});

// ---------------------------------------------------------------- 单实例（v1.1.1）

const emptyFetch = async () => jsonResponse({ code: 1, data: { total: 0, data: [] } });

await check('启动路径双触发（document-start 重试 + DOMContentLoaded）也只建一个面板', async () => {
  const b = makeSandbox({ fetchImpl: emptyFetch });
  const html = b.document.documentElement;
  b.document.readyState = 'loading';
  b.document.documentElement = null; // document-start：<html> 还没被解析出来
  vm.runInContext(src, b.ctx, { filename: SCRIPT });
  await new Promise((r) => setTimeout(r, 20)); // 此时 boot 只能 setTimeout 重试
  b.document.documentElement = html; // 解析器把 <html> 建出来了
  await new Promise((r) => setTimeout(r, 30)); // 重试路径完成 buildUI
  for (const fn of b.docListeners['DOMContentLoaded'] || []) fn(); // 再来一次
  await new Promise((r) => setTimeout(r, 10));
  const hosts = html.children.filter((c) => c.id === 'web-grab-enhancer');
  eq(hosts.length, 1, `宿主数量应为 1，实际 ${hosts.length}`);
  const fabs = hosts[0].shadowRoot.children.filter((c) => c.class === 'fab' || c.attrs?.class === 'fab');
  eq(fabs.length, 1, `浮标数量应为 1，实际 ${fabs.length}`);
});

await check('页面里残留的旧宿主会被清掉（脚本重载 / 重复注入）', async () => {
  const b = makeSandbox({ fetchImpl: emptyFetch });
  const html = b.document.documentElement;
  const stale = makeEl('div');
  stale.id = 'web-grab-enhancer';
  stale.parentNode = html;
  html.children.push(stale);
  b.document.querySelectorAll = (sel) => (sel === '#web-grab-enhancer' ? [stale] : []);
  vm.runInContext(src, b.ctx, { filename: SCRIPT });
  await new Promise((r) => setTimeout(r, 10));
  eq(html.children.filter((c) => c.id === 'web-grab-enhancer').length, 1, '残留宿主没被清干净');
  assert(!html.children.includes(stale), '旧宿主还留在 DOM 里');
});

await check('fetch 已被 hook（且不是原始函数）', () => {
  assert(box.win.fetch !== rawFetchBefore, 'window.fetch 没被替换');
});

await check('非 JSON 响应不进面板（hook 只记 JSON）', async () => {
  responseMode = 'html';
  const before = api.records().length;
  await box.win.fetch('https://www.mojinghub.com/competitions');
  await new Promise((r) => setTimeout(r, 30));
  eq(api.records().length, before, 'html 响应不该被记录');
  eq(api.lists().length, 0, '此时还没有列表接口');
  responseMode = 'json';
});

// fetch 的记录是异步的（promise 链），统一 await 一次
await box.win.fetch('https://admin.mojinghub.com/api/Competition.Competition/index', {
  method: 'POST',
  body: JSON.stringify({ lite: 1, page: 1, limit: 100 }),
});
await new Promise((r) => setTimeout(r, 30));

await check('真实列表响应被识别为「列表接口」并记下路径与行数', () => {
  const best = api.best();
  assert(best, '一条列表接口都没识别出来');
  eq(best.isList, true, 'isList');
  assert(best.listPath, 'listPath 为空');
  eq(best.rowCount, realList.data.data.length, 'rowCount 应等于真实行数');
  eq(best.method, 'POST', 'method');
  assert(best.ms >= 0, 'ms 应被记录');
  assert(best.fields.length > 5, `字段应被收集，实际 ${best.fields.length}`);
});

await check('请求透传：hook 不改写 URL、method 与 body', () => {
  const call = fetchedUrls.at(-1);
  assert(call.url.includes('/api/Competition.Competition/index'), 'URL 被改了');
  eq(call.init.method, 'POST', 'method 被改了');
  assert(JSON.parse(call.init.body).lite === 1, 'body 被改了');
});

await check('真实详情响应不会被误判成列表接口', () => {
  const before = api.lists().length;
  api.record({
    url: 'https://admin.mojinghub.com/api/Competition.Competition/detail',
    method: 'POST',
    status: 200,
    json: realDetail || { code: 1, data: { competition_id: 1, title: '样本A', description: 'x' } },
  });
  const rec = api.records()[0];
  assert(!rec.isList, '详情被误判成列表接口了');
  eq(api.lists().length, before, '列表接口数不应增加');
});

await check('XHR 分支：xhr 返回的列表同样被抓到', () => {
  const xhr = new box.win.XMLHttpRequest();
  xhr.open('POST', 'https://admin.mojinghub.com/api/Competition.Competition/index');
  xhr.send();
  const before = api.records().length;
  xhr._emit(200, JSON.stringify(realList));
  assert(api.records().length === before + 1, 'XHR 响应没被记录');
  assert(api.records()[0].isList, 'XHR 的列表没被识别');
});

await check('暂停开关：暂停期间不再记录', () => {
  eq(api.pause(true), true, 'pause(true) 应返回 true');
  const before = api.records().length;
  api.record({ url: 'https://x/ignored', method: 'GET', status: 200, json: { a: [1, 2, 3] } });
  eq(api.records().length, before, '暂停后仍在记录');
  api.pause(false);
  api.record({ url: 'https://x/kept', method: 'GET', status: 200, json: { a: [1, 2, 3] } });
  eq(api.records().length, before + 1, '恢复后应继续记录');
});

await check('导出 CSV：带 BOM、转义逗号与引号、扁平化嵌套字段', () => {
  const rows = [
    { competition_id: 1, title: '含,逗号"引号"', level: { name: '国家级' } },
    { competition_id: 2, title: '普通行', level: { name: '省级' } },
  ];
  const csv = api.toCsv(rows);
  assert(csv.charCodeAt(0) === 0xfeff, 'CSV 应带 BOM（Excel 中文不乱码）');
  assert(csv.includes('"含,逗号""引号"""'), `转义不对：${csv}`);
  assert(csv.includes('level.name'), '嵌套字段应被扁平化成 level.name');
  eq(csv.trim().split(/\r?\n/).length, 3, '表头 + 2 行');
});

await check('导出 CSV：单元格里的换行被引号包住（RFC4180，Excel 能读回两行）', () => {
  const csv = api.toCsv([{ a: '换\n行', b: 1 }]);
  assert(csv.includes('"换\n行"'), `含换行的单元格应被引号包住：${JSON.stringify(csv)}`);
  assert(csv.includes('"a"') || csv.startsWith('\ufeffa'), '表头应是 a');
});

await check('导出 Markdown：转义竖线、去掉换行', () => {
  const md = api.toMarkdown([{ a: 'x|y', b: 'p\nq' }]);
  assert(md.includes('x\\|y'), '竖线应转义');
  assert(!md.includes('p\nq'), '单元格内不应有换行');
  assert(md.includes('| ---'), '应有分隔行');
});

await check('fetchSnippet 生成的复现代码能被解析', () => {
  const best = api.best();
  const code = api.fetchSnippet(best);
  assert(code.includes('admin.mojinghub.com'), '代码里应含真实接口域');
  assert(code.includes('await fetch'), '应是 await fetch 形式');
  // 生成的必须是合法 JS
  new Function(`return (async () => { ${code} })`);
});

await check('清理：clear() 清空记录', () => {
  api.clear();
  eq(api.records().length, 0, '记录数');
  eq(api.best(), null, 'best');
});

await check('「模竞全量抓取」按钮：翻页聚合 + 落盘（用桩 fetch 走完整流程）', async () => {
  // 让页面上的 fetch 返回两页数据，第二页 last_page=2
  const pages = {
    '1': { data: { total: 3, last_page: 2, data: [{ competition_id: 1 }, { competition_id: 2 }] } },
    '2': { data: { total: 3, last_page: 2, data: [{ competition_id: 3 }] } },
  };
  box.win.fetch = (url, init) => {
    const page = JSON.parse(init?.body || '{}').page || 1;
    return Promise.resolve(jsonResponse(pages[String(page)]));
  };
  sync.downloads.length = 0;
  await api.grabMojingAll();
  const files = sync.downloads.filter((d) => d.name);
  assert(files.length === 1, `应下载 1 个文件，实际 ${files.length}`);
  assert(/^mojinghub-competitions-3\.json$/.test(files[0].name), `文件名不对：${files[0].name}`);
  assert(files[0].href === 'blob:fake', '应通过 Blob URL 下载');
});

// ---------------------------------------------------------------- 主题 / Nephele 适配

console.log('\n主题配色与 Nephele 适配：');

const PRODUCT = path.resolve(ROOT, '..', 'le-time-management');
const NEPHELE_CSS = path.join(PRODUCT, 'src', 'styles', 'nephele-settings.css');
const NEPHELE_BG_CSS = path.join(PRODUCT, 'src', 'styles', 'nephele-background.css');

const blockOf = (css, re) => {
  const m = String(css).match(re);
  return m ? m[1] : '';
};
const varOf = (block, name) => {
  const m = String(block).match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : '';
};
const norm = (c) => {
  let s = String(c).trim().toLowerCase();
  const m3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m3) s = `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  return s;
};

/** 造一个「有主题令牌、有 localStorage/matchMedia」的页面，把 userscript 跑进去。 */
function themeSandbox({ tokens = {}, bodyTokens = {}, attrs = {}, withEdge = false, prefersDark = false, stubs = {} } = {}) {
  const store = new Map();
  const box = makeSandbox({
    fetchImpl: () => Promise.resolve(jsonResponse({ code: 1, data: { data: [] } })),
    extras: {
      getComputedStyle: (el) => ({
        getPropertyValue: (name) => (el && el.__wgTokens && el.__wgTokens[name]) || '',
      }),
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      matchMedia: (q) => ({ matches: prefersDark && /dark/.test(String(q)), addEventListener() {}, addListener() {} }),
      ...stubs,
    },
  });
  for (const [k, v] of Object.entries(attrs)) box.document.documentElement.setAttribute(k, v);
  box.document.documentElement.__wgTokens = { ...tokens };
  box.document.body.__wgTokens = { ...bodyTokens };
  if (withEdge) box.document.documentElement.__wgTokens['--nephele-edge'] = 'color-mix(in srgb, #a680bd 26%, var(--line))';
  box.store = store;
  vm.runInContext(src, box.ctx, { filename: SCRIPT });
  box.api = box.win.__spaGrab;
  return box;
}

const hostOf = (box) => box.document.documentElement.children.find((c) => c.id === 'web-grab-enhancer');
const styleOf = (box, cls) => {
  const host = hostOf(box);
  const kids = host && host.shadowRoot ? host.shadowRoot.children : [];
  return kids.find((c) => c.getAttribute && c.getAttribute('class') === cls) || null;
};

// 产品主题令牌（styles.css 的潮汐 + nephele-settings.css 的 Nephele 两组）
const PRODUCT_LIGHT = {
  '--bg': '#F2EFEA', '--paper': '#F7F6F2', '--panel': '#FFFFFF', '--ink': '#22303A',
  '--ink-2': '#607487', '--ink-3': '#91A1AF', '--line': '#E4DFD6', '--line-soft': '#EEEEEB',
  '--deep': '#0F4C5C', '--accent': 'var(--deep)', '--on-accent': '#FFFFFF', '--mint': '#2E9D8F',
};
const PRODUCT_NEPHELE_LIGHT = {
  ...PRODUCT_LIGHT, '--panel': '#fbf8ff', '--ink': '#3e344f', '--ink-2': '#675c77', '--ink-3': '#786b89',
  '--line': '#c6b8d4', '--line-soft': '#ded3e9', '--deep': '#81559b', '--on-accent': '#fff',
  '--nephele-rail': '#e4d7f4',
};
const PRODUCT_NEPHELE_DARK = {
  '--bg': '#211b2b', '--paper': '#1a1424', '--panel': '#31263f', '--ink': '#f6eefc',
  '--ink-2': '#d1c2df', '--ink-3': '#b6a4c7', '--line': '#645371', '--line-soft': '#50415f',
  '--deep': '#d3afe9', '--on-accent': '#2b1e37', '--nephele-rail': '#342350',
};

await check('裸环境兜底：没有 localStorage / getComputedStyle / matchMedia 也不报错，用内置浅色', () => {
  const t = api.theme();
  eq(t.source, 'builtin', 'source');
  eq(t.mode, 'light', 'mode');
  eq(t.nephele, false, 'nephele');
  assert(api.themeCSS().startsWith(':host{'), 'themeCSS 应以 :host{ 开头');
});

await check('借宿主页面主题令牌（潮汐浅色）：--accent 是 var() 时自动退到 --deep', () => {
  const b = themeSandbox({ tokens: PRODUCT_LIGHT, attrs: { 'data-theme': 'tide' } });
  const t = b.api.theme();
  eq(t.source, 'page', 'source');
  eq(t.mode, 'light', 'mode');
  eq(t.nephele, false, 'nephele');
  eq(norm(t.vars.bg), '#ffffff', 'bg 应取 --panel');
  eq(norm(t.vars.accent), '#0f4c5c', 'accent 应取 --deep');
  eq(norm(t.vars.ink), '#22303a', 'ink');
  eq(norm(t.vars['on-accent']), '#ffffff', 'on-accent');
  assert(t.label.includes('跟随页面') && t.label.includes('tide'), `label=${t.label}`);
  eq(hostOf(b).getAttribute('data-wg-source'), 'page', 'host 上的来源标记');
});

await check('Nephele 浅色：紫调令牌 + 毛玻璃 + 云雾星尘一起上', () => {
  const b = themeSandbox({ tokens: PRODUCT_NEPHELE_LIGHT, attrs: { 'data-theme': 'lavender', 'data-nephele-settings': 'on' } });
  const t = b.api.theme();
  eq(t.nephele, true, 'nephele');
  eq(norm(t.vars.accent), '#81559b', 'accent 应是 Nephele 紫');
  eq(norm(t.vars.bg), '#fbf8ff', 'bg');
  eq(norm(t.vars.head), '#e4d7f4', 'header 用 --nephele-rail');
  assert(String(t.vars.glass).includes('blur(22px)'), `glass=${t.vars.glass}`);
  eq(t.vars.radius, '20px', 'radius');
  eq(t.vars.cloud1, '#7f9cf55c', '云雾蓝');
  eq(t.vars.star, '#9e72be', '星尘色');
  eq(hostOf(b).getAttribute('data-wg-nephele'), 'on', 'host 上的 Nephele 标记');
  assert(b.api.themeCSS().includes('--wg-accent:#81559b'), '注入的 CSS 应含 Nephele 主色');
});

await check('Nephele 深色：按 data-theme-mode 走深色紫调，云雾星尘换成产品深色那组', () => {
  const b = themeSandbox({
    tokens: PRODUCT_NEPHELE_DARK,
    attrs: { 'data-theme': 'lavender', 'data-theme-mode': 'dark', 'data-nephele-settings': 'on' },
  });
  const t = b.api.theme();
  eq(t.mode, 'dark', 'mode');
  eq(t.nephele, true, 'nephele');
  eq(norm(t.vars.bg), '#31263f', 'bg');
  eq(norm(t.vars.accent), '#d3afe9', 'accent');
  eq(norm(t.vars.head), '#342350', 'header 用 --nephele-rail(深)');
  eq(t.vars.radius, '20px', 'radius');
  eq(t.vars.cloud1, '#67749e47', '深色云雾蓝');
  eq(t.vars.star, '#f4e4ff', '深色星尘');
});

await check('内置 Nephele 调色板与产品 nephele-settings.css 逐项对得上（改产品主题色会在这里报错）', () => {
  const css = fs.readFileSync(NEPHELE_CSS, 'utf8');
  const light = blockOf(css, /:root\[data-nephele-settings="on"\]\s*\{([^}]*)\}/);
  const dark = blockOf(css, /:root\[data-theme-mode="dark"\]\[data-nephele-settings="on"\]\s*\{([^}]*)\}/);
  assert(light && dark, '没能从产品 CSS 里切出 Nephele 令牌块（文件结构变了？）');
  const MAP = {
    bg: '--panel', head: '--nephele-rail', ink: '--ink', ink2: '--ink-2', ink3: '--ink-3',
    line: '--line', 'line-soft': '--line-soft', accent: '--deep', 'on-accent': '--on-accent',
  };
  const pal = api.palettes();
  for (const [mode, block] of [['nephele-light', light], ['nephele-dark', dark]]) {
    for (const [key, cssVar] of Object.entries(MAP)) {
      const want = varOf(block, cssVar);
      assert(want, `产品 CSS 里没找到 ${cssVar}`);
      eq(norm(pal[mode][key]), norm(want), `${mode}.${key} 应等于产品 ${cssVar}`);
    }
  }
  const bgCss = fs.readFileSync(NEPHELE_BG_CSS, 'utf8');
  const bgLight = blockOf(bgCss, /\.nephele-background\s*\{([^}]*)\}/);
  const bgDark = blockOf(bgCss, /:root\[data-theme-mode="dark"\]\s*\.nephele-background\s*\{([^}]*)\}/);
  assert(bgLight && bgDark, '没能从 nephele-background.css 切出云雾令牌');
  const vl = themeSandbox({ tokens: PRODUCT_NEPHELE_LIGHT, attrs: { 'data-nephele-settings': 'on' } }).api.theme().vars;
  const vd = themeSandbox({ tokens: PRODUCT_NEPHELE_DARK, attrs: { 'data-theme-mode': 'dark', 'data-nephele-settings': 'on' } }).api.theme().vars;
  eq(vl.cloud1, varOf(bgLight, '--cloud-blue'), '浅色云雾蓝');
  eq(vl.cloud2, varOf(bgLight, '--cloud-purple'), '浅色云雾紫');
  eq(vl.cloud3, varOf(bgLight, '--cloud-mint'), '浅色云雾薄荷');
  eq(vl.star, varOf(bgLight, '--star-color'), '浅色星尘');
  eq(vl.dust, varOf(bgLight, '--dust-color'), '浅色浮尘');
  eq(vd.cloud1, varOf(bgDark, '--cloud-blue'), '深色云雾蓝');
  eq(vd.cloud3, varOf(bgDark, '--cloud-mint'), '深色云雾薄荷');
  eq(vd.star, varOf(bgDark, '--star-color'), '深色星尘');
});

await check('非产品站点也能借色（shadcn/Tailwind 的 --card/--border/--primary），class=dark 判深色', () => {
  const tokens = {
    '--background': '#FFFFFF', '--card': '#FCFCFC', '--foreground': '#09090B', '--border': '#E4E4E7',
    '--primary': '#18181B', '--primary-foreground': '#FAFAFA', '--muted-foreground': '#71717A',
  };
  const b = themeSandbox({ tokens });
  const t = b.api.theme();
  eq(t.source, 'page', 'source');
  eq(t.mode, 'light', '浅底应判浅色');
  eq(norm(t.vars.bg), '#fcfcfc', 'bg 取 --card');
  eq(norm(t.vars.accent), '#18181b', 'accent 取 --primary');
  eq(norm(t.vars['on-accent']), '#fafafa', 'on-accent 取 --primary-foreground');
  eq(norm(t.vars.line), '#e4e4e7', 'line 取 --border');
  eq(norm(t.vars.good), '#2e9d8f', '站点没给 --mint 时用内置绿');
  const b2 = themeSandbox({ tokens, attrs: { class: 'dark' } });
  eq(b2.api.theme().mode, 'dark', 'html.dark 应判深色');
});

await check('页面只给深色底、没有任何属性时，按底色明度自动判深色', () => {
  const b = themeSandbox({ tokens: { '--panel': '#1c2833', '--ink': '#e7f0ee', '--deep': '#37a6a0' } });
  const t = b.api.theme();
  eq(t.source, 'page', 'source');
  eq(t.mode, 'dark', '明度低应判深色');
  eq(t.vars.star, '#f4e4ff', '深色的星尘色');
});

await check('页面令牌只在 body 上时也能借到（html 优先、body 兜底）', () => {
  const b = themeSandbox({ bodyTokens: PRODUCT_LIGHT, attrs: { 'data-theme': 'tide' } });
  const t = b.api.theme();
  eq(t.source, 'page', 'source');
  eq(norm(t.vars.bg), '#ffffff', 'bg 来自 body 上的 --panel');
});

await check('令牌消毒：带大括号/分号/var()/color-mix() 的值一律不采信，注入不进 CSS', () => {
  const b = themeSandbox({
    tokens: { '--panel': '#fff} .wrap{display:none', '--ink': 'color-mix(in srgb, #000 50%, #fff)', '--deep': '#123456' },
  });
  eq(b.api.theme().source, 'builtin', '非法令牌不该让面板进入 page 模式');
  assert(!b.api.themeCSS().includes('display:none'), '注入串泄漏进 CSS 了');
  const decls = b.api.themeCSS().slice(':host{'.length, -1).split(';');
  assert(decls.every((d) => d.startsWith('--wg-')), `有非 --wg- 前缀的声明：${decls.find((d) => !d.startsWith('--wg-'))}`);
  const b2 = themeSandbox({ tokens: { ...PRODUCT_LIGHT, '--panel': 'var(--evil)', '--card': '#FCFCFC' } });
  eq(norm(b2.api.theme().vars.bg), '#fcfcfc', '--panel 是 var() 时应退到 --card');
});

await check('手动锁定浅/深与 Nephele 开关：覆盖页面判断并写进 localStorage，reset 后回到跟随', () => {
  const b = themeSandbox({ tokens: PRODUCT_NEPHELE_LIGHT, attrs: { 'data-nephele-settings': 'on' } });
  const t1 = b.api.setTheme({ mode: 'dark', nephele: 'off' });
  eq(t1.source, 'builtin', '手动锁定后不再跟随页面');
  eq(t1.mode, 'dark', 'mode');
  eq(t1.nephele, false, 'nephele');
  eq(norm(t1.vars.bg), '#1c2833', '内置深色 bg');
  assert(String(b.store.get('web-grab:panel-theme')).includes('"mode":"dark"'), '设置应写进 localStorage');
  const t2 = b.api.resetTheme();
  eq(t2.source, 'page', 'reset 后回到跟随页面');
  eq(t2.nephele, true, 'reset 后 Nephele 跟随页面（on）');
});

await check('页面换主题 / 开关 Nephele 时面板自动重算（MutationObserver → applyTheme）', () => {
  const observers = [];
  const b = themeSandbox({
    tokens: PRODUCT_LIGHT,
    attrs: { 'data-theme': 'tide' },
    stubs: {
      MutationObserver: class {
        constructor(cb) {
          this.cb = cb;
          observers.push(this);
        }
        observe() {}
        disconnect() {}
      },
    },
  });
  eq(b.api.theme().nephele, false, '初始 Nephele 应为关');
  const host = hostOf(b);
  const style = styleOf(b, 'wg-theme');
  assert(style, '没找到注入主题的 <style>');
  // 模拟用户在产品里打开「Nephele 风格界面」：根节点属性 + 令牌都变
  b.document.documentElement.setAttribute('data-nephele-settings', 'on');
  Object.assign(b.document.documentElement.__wgTokens, PRODUCT_NEPHELE_LIGHT);
  eq(observers.length, 1, '应注册 1 个 MutationObserver');
  observers[0].cb();
  const t = b.api.theme();
  eq(t.nephele, true, '重算后 Nephele 应开');
  eq(norm(t.vars.accent), '#81559b', 'accent 应换成 Nephele 紫');
  assert(style.textContent.includes('--wg-accent:#81559b'), '注入的 <style> 内容应已更新');
  eq(host.getAttribute('data-wg-nephele'), 'on', 'host 上的 Nephele 属性应已更新');
});

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  failures.forEach((f) => console.log(`   · ${f}`));
  process.exitCode = 1;
} else {
  console.log('✓ 全部通过：油猴增强插件在真实响应上工作正常');
}

