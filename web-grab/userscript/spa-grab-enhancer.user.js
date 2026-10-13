// ==UserScript==
// @name         SPA 抓取增强器 (web-grab enhancer)
// @namespace    https://github.com/local/web-grab
// @version      1.1.1
// @description  给任何 JS 渲染的站点装上「接口嗅探 + 一键导出」：hook fetch/XHR，自动识别承载列表数据的接口，导出 JSON/CSV/Markdown，并生成 curl / Node 复现代码。对 mojinghub.com 额外提供直连接口的全量抓取。面板配色自动跟随宿主页面主题（含 le-time-management 各主题与 Nephele 云雾星尘风格）。
// @author       web-grab
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 为什么需要它：
 * 纯前端渲染（SPA）的页面，HTML 里只有空壳，真实数据是页面自己 XHR/fetch 拉回来的。
 * 所以「抓不到」的解法不是解析 HTML，而是把页面自己发的那一发请求记下来、复现它。
 *
 * 这个脚本做三件事：
 *   1. 嗅探：hook window.fetch 与 XMLHttpRequest，把每个返回 JSON 的请求记下来；
 *   2. 识别：自动判断哪个接口在返回"列表"，把它标成候选数据接口；
 *   3. 导出：面板里一键导出当前列表为 JSON/CSV/Markdown，或复制 curl 给 CLI 复现。
 *
 * 关于配色（v1.1.0）：
 * 面板不写死颜色，全部走 --wg-* 令牌，由 applyTheme() 在运行时决定：
 *   · 宿主页面自己定义了主题令牌（le-time-management 的 潮汐/lavender/night… 或 Nephele 风格，
 *     以及 shadcn 系站点的 --card/--border/--primary）⇒ 直接借它的颜色，面板与页面同色；
 *   · 否则用内置调色板（浅色/深色），并按 prefers-color-scheme 跟随系统；
 *   · Nephele 开启时额外换上紫调 + 毛玻璃 + 面板自带的云雾与星尘。
 * 用户可在面板里手动锁定 浅/深 与 Nephele 开关（存 localStorage，不联网）。
 *
 * 关于单实例（v1.1.1）：
 * document-start 时 documentElement 可能还没出现，启动逻辑会 setTimeout 重试，而
 * DOMContentLoaded 又会调一次 boot —— 修复前会造出两个宿主、两个浮标，其中一个计数永远
 * 停在 0。现在 boot 一次性、buildUI 幂等，并顺手清掉页面里残留的旧宿主。
 */

(function () {
  'use strict';

  const MAX_RECORDS = 300;
  const MAX_JSON_BYTES = 4 * 1024 * 1024;
  const SCRIPT_ID = 'web-grab-enhancer';

  const state = {
    records: [], // {id, url, path, origin, method, body, status, ts, ms, json, isList, listPath, rowCount}
    seq: 0,
    panel: null,
    root: null,
    filter: '',
    selected: null,
    paused: false,
  };

  // ---------------------------------------------------------------- 工具

  const isJsonType = (ct) => !!ct && /application\/(json|.*\+json)/i.test(ct);

  /** 从一个 JSON 里找出"像列表"的那条路径：找到行数最多的数组。 */
  function findListPath(node, path = '', depth = 0) {
    if (depth > 6 || node === null || typeof node !== 'object') return null;
    let best = null;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object' && node[0] !== null) {
        const keys = new Set();
        node.slice(0, 8).forEach((row) => Object.keys(row || {}).forEach((k) => keys.add(k)));
        // id 类字段是列表行的强特征
        const hasId = [...keys].some((k) => /(^|_)id$|_id$|Id$/.test(k));
        best = { path, count: node.length, fields: [...keys], hasId };
      }
      return best;
    }
    for (const key of Object.keys(node)) {
      const sub = findListPath(node[key], path ? `${path}.${key}` : key, depth + 1);
      if (!sub) continue;
      if (!best || sub.count * (sub.hasId ? 2 : 1) > best.count * (best.hasId ? 2 : 1)) best = sub;
    }
    return best;
  }

  function getByPath(obj, path) {
    return String(path || '')
      .split('.')
      .filter(Boolean)
      .reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
  }

  function flatten(row, prefix = '', out = {}) {
    if (row === null || typeof row !== 'object') {
      out[prefix] = row;
      return out;
    }
    if (Array.isArray(row)) {
      out[prefix] = row.length && typeof row[0] === 'object' ? JSON.stringify(row) : row.join(' | ');
      return out;
    }
    for (const [k, v] of Object.entries(row)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') flatten(v, key, out);
      else out[key] = v;
    }
    return out;
  }

  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function toCsv(rows) {
    if (!rows.length) return '';
    // 收集所有列，保持出现顺序
    const cols = [];
    const seen = new Set();
    rows.forEach((r) => {
      Object.keys(flatten(r)).forEach((k) => {
        if (!seen.has(k)) {
          seen.add(k);
          cols.push(k);
        }
      });
    });
    const lines = [cols.map((c) => csvCell(c)).join(',')];
    rows.forEach((r) => {
      const f = flatten(r);
      lines.push(cols.map((c) => csvCell(f[c])).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function toMarkdown(rows) {
    if (!rows.length) return '(空)';
    const cols = [];
    const seen = new Set();
    rows.forEach((r) =>
      Object.keys(flatten(r)).forEach((k) => {
        if (!seen.has(k)) {
          seen.add(k);
          cols.push(k);
        }
      })
    );
    const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
    return [
      `| ${cols.join(' | ')} |`,
      `| ${cols.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => {
        const f = flatten(r);
        return `| ${cols.map((c) => esc(f[c])).join(' | ')} |`;
      }),
    ].join('\n');
  }

  function copy(text, label) {
    const done = () => toast(`${label || '已复制'} ✓`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      toast('复制失败，请手动选中');
    }
    ta.remove();
  }

  function download(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;bottom:64px;transform:translateX(-50%);' +
      'background:#111;color:#fff;padding:8px 14px;border-radius:8px;font:13px/1.4 system-ui;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .2s';
    document.body.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = '1'));
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 1600);
  }

  const shortPath = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin ? u.pathname + u.search : u.href;
    } catch {
      return String(url);
    }
  };

  // ---------------------------------------------------------------- 嗅探

  function record({ url, method, body, status, json, ms }) {
    if (state.paused) return;
    let list = null;
    try {
      list = findListPath(json);
    } catch {
      list = null;
    }
    const entry = {
      id: ++state.seq,
      url,
      path: shortPath(url),
      origin: (() => {
        try {
          return new URL(url, location.href).origin;
        } catch {
          return '';
        }
      })(),
      method,
      body: typeof body === 'string' ? body.slice(0, 4000) : body ?? null,
      status,
      ts: Date.now(),
      ms,
      json,
      listPath: list?.path ?? null,
      rowCount: list?.count ?? 0,
      isList: !!list && list.count > 0,
      fields: list?.fields ?? [],
    };
    state.records.unshift(entry);
    if (state.records.length > MAX_RECORDS) state.records.pop();
    if (state.selected === null && entry.isList) state.selected = entry.id;
    render();
  }

  function installHooks() {
    // ---- fetch
    const rawFetch = window.fetch;
    if (typeof rawFetch === 'function') {
      window.fetch = function (input, init) {
        const started = Date.now();
        const url = typeof input === 'string' ? input : input?.url || String(input);
        const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
        const body = init?.body;
        const p = rawFetch.apply(this, arguments);
        p.then(
          (res) => {
            try {
              const ct = res.headers.get('content-type') || '';
              const len = Number(res.headers.get('content-length') || 0);
              if (!isJsonType(ct) && !/json/.test(ct)) return;
              if (len > MAX_JSON_BYTES) return;
              const clone = res.clone();
              clone.text().then((text) => {
                if (text.length > MAX_JSON_BYTES) return;
                let json;
                try {
                  json = JSON.parse(text);
                } catch {
                  return;
                }
                record({
                  url,
                  method,
                  body: typeof body === 'string' ? body : null,
                  status: res.status,
                  json,
                  ms: Date.now() - started,
                });
              });
            } catch {
              /* 记录失败不影响页面 */
            }
          },
          () => {}
        );
        return p;
      };
    }

    // ---- XHR
    const XHR = window.XMLHttpRequest;
    if (XHR?.prototype) {
      const rawOpen = XHR.prototype.open;
      const rawSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__wg = { method: String(method || 'GET').toUpperCase(), url: String(url), started: Date.now() };
        return rawOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        const meta = this.__wg;
        if (meta) {
          meta.body = typeof body === 'string' ? body : null;
          this.addEventListener('load', () => {
            try {
              const ct = this.getResponseHeader('content-type') || '';
              if (!/json/i.test(ct)) return;
              const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
              if (!text || text.length > MAX_JSON_BYTES) return;
              let json;
              try {
                json = JSON.parse(text);
              } catch {
                return;
              }
              record({
                url: meta.url,
                method: meta.method,
                body: meta.body,
                status: this.status,
                json,
                ms: Date.now() - meta.started,
              });
            } catch {
              /* ignore */
            }
          });
        }
        return rawSend.apply(this, arguments);
      };
    }
  }

  // ------------------------------------------------- 主题 / Nephele 适配
  //
  // 面板不写死颜色。计算顺序：
  //   1. 先看宿主页面有没有自己的主题令牌（产品主题变量，或 shadcn 系站点的 --card/--border/--primary）；
  //      有就直接借它的颜色 ⇒ 用户换任何主题/深浅/Nephele 开关，面板自动同色。
  //   2. 没有就用内置调色板（浅色/深色），深浅按 data-theme-mode → class → 底色明度 → 系统偏好。
  //   3. Nephele 打开时换成紫调 + 毛玻璃 + 云雾星尘。
  // 用户在面板里手动指定过 浅/深 或 Nephele 开关时，以手动的为准。

  const THEME_KEY = 'web-grab:panel-theme';

  // 内置调色板。nephele-* 两组取自 le-time-management/src/styles/nephele-settings.css
  // （--panel/--ink/--deep/--nephele-rail 等），改产品主题色时这里要跟着对一遍。
  const PALETTES = {
    light: {
      bg: '#ffffff', head: '#f7f6f2', ink: '#22303a', ink2: '#5b6b78', ink3: '#8c99a4',
      line: '#e4dfd6', 'line-soft': '#efece5', accent: '#0f4c5c', 'on-accent': '#ffffff',
      good: '#2e9d8f', shadow: '0 20px 60px rgba(35,32,28,.18)',
    },
    dark: {
      bg: '#1c2833', head: '#17212b', ink: '#e7f0ee', ink2: '#a6b6ba', ink3: '#7b8a92',
      line: '#31414d', 'line-soft': '#26343f', accent: '#37a6a0', 'on-accent': '#07241f',
      good: '#6ee7a8', shadow: '0 20px 60px rgba(0,0,0,.5)',
    },
    'nephele-light': {
      bg: '#fbf8ff', head: '#e4d7f4', ink: '#3e344f', ink2: '#675c77', ink3: '#786b89',
      line: '#c6b8d4', 'line-soft': '#ded3e9', accent: '#81559b', 'on-accent': '#ffffff',
      good: '#2e9d8f', shadow: '0 18px 46px rgba(52,30,72,.22)',
    },
    'nephele-dark': {
      bg: '#31263f', head: '#342350', ink: '#f6eefc', ink2: '#d1c2df', ink3: '#b6a4c7',
      line: '#645371', 'line-soft': '#50415f', accent: '#d3afe9', 'on-accent': '#2b1e37',
      good: '#8ee0b0', shadow: '0 18px 46px rgba(20,10,32,.55)',
    },
  };

  // 页面令牌 → 面板令牌。同名多候选，取第一个命中的（产品主题排前面，再做 shadcn/Tailwind 兜底）。
  const PAGE_MAP = {
    bg: ['--panel', '--card', '--surface', '--paper', '--background'],
    ink: ['--ink', '--foreground', '--text'],
    ink2: ['--ink-2', '--muted-foreground'],
    ink3: ['--ink-3', '--text-3'],
    line: ['--line', '--border'],
    'line-soft': ['--line-soft', '--border-soft'],
    accent: ['--accent', '--deep', '--primary'],
    'on-accent': ['--on-accent', '--on-deep', '--primary-foreground'],
    good: ['--mint'],
    head: ['--nephele-rail'],
  };

  // 只接受「老老实实的颜色字面量」。带 var()/color-mix() 的值会被丢掉：
  // 那些值里的 var() 引用的是页面自己的变量，搬进 Shadow DOM 后解析不出来。
  const WG_COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lch|lab|color)\([0-9a-z%.,/\s+-]*\))$/i;

  const themeCtl = { current: null, styleEl: null, observer: null, media: null };

  function readVar(el, name) {
    if (!el || typeof getComputedStyle !== 'function') return '';
    let v = '';
    try {
      v = String(getComputedStyle(el).getPropertyValue(name) || '').trim();
    } catch {
      return '';
    }
    return WG_COLOR_RE.test(v) ? v : '';
  }

  function attrOf(el, name) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    return el.getAttribute(name) || '';
  }

  /** 收集宿主页面的主题令牌（html 优先，body 兜底）。 */
  function pageTokens() {
    const roots = [];
    if (document.documentElement) roots.push(document.documentElement);
    if (document.body && document.body !== document.documentElement) roots.push(document.body);
    const out = {};
    for (const [key, names] of Object.entries(PAGE_MAP)) {
      for (const el of roots) {
        for (const n of names) {
          const v = readVar(el, n);
          if (v) {
            out[key] = v;
            break;
          }
        }
        if (out[key]) break;
      }
    }
    out.themeName = attrOf(document.documentElement, 'data-theme');
    out.modeAttr = attrOf(document.documentElement, 'data-theme-mode');
    out.nepheleAttr = attrOf(document.documentElement, 'data-nephele-settings');
    // 产品只在 Nephele 风格开启时才定义 --nephele-edge，用它兜底判断 Nephele
    out.edgeHint = readVar(document.documentElement, '--nephele-edge')
      || readVar(document.body, '--nephele-edge');
    return out;
  }

  function luminance(color) {
    const s = String(color).trim();
    let r;
    let g;
    let b;
    if (/^#[0-9a-f]{3}$/i.test(s)) {
      r = parseInt(s[1] + s[1], 16);
      g = parseInt(s[2] + s[2], 16);
      b = parseInt(s[3] + s[3], 16);
    } else if (/^#[0-9a-f]{6}/i.test(s)) {
      r = parseInt(s.slice(1, 3), 16);
      g = parseInt(s.slice(3, 5), 16);
      b = parseInt(s.slice(5, 7), 16);
    } else if (/^rgba?\(/i.test(s)) {
      const m = s.match(/[\d.]+/g);
      if (!m) return null;
      [r, g, b] = [+m[0], +m[1], +m[2]];
    } else return null;
    if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function detectMode(page) {
    if (page.modeAttr === 'dark' || page.modeAttr === 'light') return page.modeAttr;
    const cls = `${attrOf(document.documentElement, 'class')} ${attrOf(document.body, 'class')}`;
    if (/(^|\s)(dark|night|theme-dark|dark-mode)(\s|$)/i.test(cls)) return 'dark';
    const lum = page.bg ? luminance(page.bg) : null;
    if (lum !== null && lum < 0.45) return 'dark';
    if (lum !== null && lum > 0.62) return 'light';
    if (typeof matchMedia === 'function') {
      try {
        if (matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      } catch {
        /* ignore */
      }
    }
    return 'light';
  }

  function readUserTheme() {
    try {
      const raw = localStorage.getItem(THEME_KEY);
      if (raw) {
        const o = JSON.parse(raw) || {};
        return {
          mode: o.mode === 'light' || o.mode === 'dark' ? o.mode : 'auto',
          nephele: o.nephele === 'on' || o.nephele === 'off' ? o.nephele : 'auto',
        };
      }
    } catch {
      /* 沙箱里没有 localStorage，走默认 */
    }
    return { mode: 'auto', nephele: 'auto' };
  }

  function saveUserTheme(u) {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(u));
    } catch {
      /* ignore */
    }
  }

  function computeTheme() {
    const user = readUserTheme();
    const page = pageTokens();
    const pageUsable = Boolean(page.bg && page.ink && page.accent);
    const mode = user.mode !== 'auto' ? user.mode : detectMode(page);
    const source = user.mode === 'auto' && pageUsable ? 'page' : 'builtin';
    const nephele = user.nephele === 'on'
      ? true
      : user.nephele === 'off'
        ? false
        : page.nepheleAttr === 'on' || Boolean(page.edgeHint);
    const pname = `${nephele ? 'nephele-' : ''}${mode}`;
    const base = PALETTES[pname] || PALETTES[mode] || PALETTES.light;
    const colors = { ...base };
    if (source === 'page') {
      for (const k of Object.keys(PAGE_MAP)) if (page[k]) colors[k] = page[k];
    }

    const V = (n) => `var(--wg-${n})`;
    const vars = { ...colors };
    // Nephele 的云雾/星尘配色取自 src/styles/nephele-background.css（深色那组更暗更淡）
    const dark = mode === 'dark';
    vars.cloud1 = dark ? '#67749e47' : '#7f9cf55c';
    vars.cloud2 = dark ? '#aa7cbc52' : '#c498d36b';
    vars.cloud3 = dark ? '#7f98951f' : '#a8d8c850';
    vars.star = dark ? '#f4e4ff' : '#9e72be';
    vars.dust = dark ? '#dca0ef' : '#aa72c6';
    // 派生色全部在面板自己的 Shadow DOM 里混，不依赖页面能否解析 var()/color-mix()
    vars.elev = `color-mix(in srgb, ${V('bg')} 90%, ${V('ink')} 10%)`;
    vars['accent-soft'] = `color-mix(in srgb, ${V('accent')} 14%, ${V('bg')})`;
    vars['accent-line'] = `color-mix(in srgb, ${V('accent')} 45%, ${V('line')})`;
    vars['good-bg'] = `color-mix(in srgb, ${V('good')} 16%, ${V('bg')})`;
    vars['good-line'] = `color-mix(in srgb, ${V('good')} 42%, ${V('line')})`;
    vars.edge = `color-mix(in srgb, ${V('accent')} 30%, ${V('line')})`;
    if (!vars.head) vars.head = `color-mix(in srgb, ${V('accent')} 9%, ${V('bg')})`;
    vars.radius = nephele ? '20px' : '14px';
    vars.glass = nephele ? 'blur(22px) saturate(1.12)' : 'none';

    const label = source === 'page'
      ? `跟随页面${page.themeName ? `(${page.themeName})` : ''}${nephele ? '·Nephele' : ''}`
      : `${nephele ? 'Nephele' : '内置'}${dark ? '深色' : '浅色'}`;

    return { user, mode, nephele, source, label, themeName: page.themeName || '', vars };
  }

  function themeCSS(t) {
    const decls = Object.entries(t.vars).map(([k, v]) => `--wg-${k}:${v}`);
    return `:host{${decls.join(';')}}`;
  }

  function applyTheme() {
    const t = computeTheme();
    themeCtl.current = t;
    const root = state.root;
    if (!root) return t;
    if (root.themeStyle) root.themeStyle.textContent = themeCSS(t);
    if (root.host && root.host.setAttribute) {
      root.host.setAttribute('data-wg-mode', t.mode);
      root.host.setAttribute('data-wg-source', t.source);
      // Nephele 的开关是 CSS 选择器的依据（云雾、毛玻璃、圆角）
      root.host.setAttribute('data-wg-nephele', t.nephele ? 'on' : 'off');
    }
    const modeLabel = { auto: '自动', light: '浅', dark: '深' };
    const nephLabel = t.user.nephele === 'auto'
      ? (t.nephele ? '跟随(开)' : '自动')
      : (t.user.nephele === 'on' ? '开' : '关');
    if (root.themeBtn) {
      root.themeBtn.textContent = `主题·${modeLabel[t.user.mode]}`;
      root.themeBtn.setAttribute('data-mode', t.user.mode);
      if (root.themeBtn.classList && root.themeBtn.classList.toggle) {
        root.themeBtn.classList.toggle('on', t.user.mode !== 'auto');
      }
    }
    if (root.nephBtn) {
      root.nephBtn.textContent = `Nephele·${nephLabel}`;
      if (root.nephBtn.classList && root.nephBtn.classList.toggle) {
        root.nephBtn.classList.toggle('on', t.nephele);
      }
    }
    if (root.themeNote) root.themeNote.textContent = `配色：${t.label}`;
    return t;
  }

  function cycleTheme(field) {
    const u = themeCtl.current ? themeCtl.current.user : readUserTheme();
    const next = { mode: u.mode, nephele: u.nephele };
    if (field === 'mode') {
      next.mode = u.mode === 'auto' ? 'light' : u.mode === 'light' ? 'dark' : 'auto';
    } else {
      next.nephele = u.nephele === 'auto' ? 'on' : u.nephele === 'on' ? 'off' : 'auto';
    }
    saveUserTheme(next);
    const t = applyTheme();
    toast(`面板配色：${t.label}`);
    return t;
  }

  /** 页面换主题/切深浅/Nephele 开关时，面板跟着变。 */
  function watchTheme() {
    try {
      if (typeof MutationObserver === 'function' && document.documentElement) {
        themeCtl.observer = new MutationObserver(() => applyTheme());
        themeCtl.observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'data-theme-mode', 'data-nephele-settings', 'data-nephele-background', 'class', 'style'],
        });
      }
    } catch {
      /* 老引擎忽略 */
    }
    try {
      if (typeof matchMedia === 'function') {
        const mq = matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => applyTheme();
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
        themeCtl.media = mq;
      }
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- 面板

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}

  /* 颜色一律取自 --wg-* 令牌（由 applyTheme 注入，见「主题 / Nephele 适配」一节），
     这里不出现任何硬编码色值，换主题就是换一组令牌。 */
  .fab{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:6px;
       background:var(--wg-bg);color:var(--wg-ink);border:1px solid var(--wg-line);border-radius:999px;padding:8px 14px;
       font-size:12px;cursor:pointer;box-shadow:var(--wg-shadow);user-select:none;
       backdrop-filter:var(--wg-glass);-webkit-backdrop-filter:var(--wg-glass)}
  .fab:hover{background:var(--wg-elev)}
  .fab b{color:var(--wg-accent);font-weight:600}
  :host([data-wg-nephele="on"]) .fab{border-color:var(--wg-edge);
       background:linear-gradient(120deg,color-mix(in srgb,var(--wg-accent) 16%,var(--wg-bg)),var(--wg-bg))}
  .wrap{position:fixed;right:18px;bottom:70px;z-index:2147483646;width:min(760px,92vw);height:min(560px,80vh);
        background:var(--wg-bg);color:var(--wg-ink);border:1px solid var(--wg-line);border-radius:var(--wg-radius);
        display:flex;flex-direction:column;box-shadow:var(--wg-shadow);overflow:hidden;font-size:12.5px;
        backdrop-filter:var(--wg-glass);-webkit-backdrop-filter:var(--wg-glass)}
  :host([data-wg-nephele="on"]) .wrap{border-color:var(--wg-edge);
        background:linear-gradient(165deg,color-mix(in srgb,var(--wg-accent) 13%,var(--wg-bg)),var(--wg-bg) 58%)}

  /* Nephele 云雾与星尘：只在 nephele=on 时显示，动效遵守 prefers-reduced-motion */
  .wg-sky{position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .45s ease}
  :host([data-wg-nephele="on"]) .wg-sky{opacity:1}
  .wg-cloud{position:absolute;border-radius:50%;filter:blur(24px)}
  .wg-cloud.c1{width:58%;height:50%;left:-10%;top:-14%;animation:wg-cloud-x 12.5s ease-in-out infinite alternate;
       background:radial-gradient(circle at 40% 40%,var(--wg-cloud1),transparent 70%)}
  .wg-cloud.c2{width:52%;height:46%;right:-12%;top:4%;animation:wg-cloud-y 17.5s ease-in-out infinite alternate;
       background:radial-gradient(circle at 60% 40%,var(--wg-cloud2),transparent 70%)}
  .wg-cloud.c3{width:48%;height:42%;left:16%;bottom:-18%;animation:wg-cloud-x 21s ease-in-out infinite alternate-reverse;
       background:radial-gradient(circle at 50% 50%,var(--wg-cloud3),transparent 70%)}
  .wg-star{position:absolute;border-radius:50%;background:var(--wg-star);box-shadow:0 0 4px var(--wg-dust);
       animation:wg-twinkle 4s ease-in-out infinite}
  @keyframes wg-cloud-x{from{transform:translate3d(-5%,0,0)}to{transform:translate3d(7%,3%,0)}}
  @keyframes wg-cloud-y{from{transform:translate3d(0,-4%,0)}to{transform:translate3d(3%,6%,0)}}
  @keyframes wg-twinkle{0%,100%{opacity:.16}50%{opacity:.8}}

  header,main,footer{position:relative;z-index:1}
  header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--wg-line);background:var(--wg-head)}
  header .title{font-weight:600;font-size:13px;color:var(--wg-ink)}
  header .sp{flex:1}
  button{background:color-mix(in srgb,var(--wg-bg) 88%,var(--wg-ink) 12%);color:var(--wg-ink);
         border:1px solid var(--wg-line);border-radius:8px;padding:4px 9px;font-size:12px;cursor:pointer}
  button:hover{background:var(--wg-elev)}
  button.primary{background:var(--wg-accent);border-color:var(--wg-accent);color:var(--wg-on-accent)}
  button.primary:hover{background:color-mix(in srgb,var(--wg-accent) 86%,#000)}
  button.mini{padding:2px 7px;font-size:11.5px}
  button.on{background:var(--wg-accent-soft);border-color:var(--wg-accent-line);color:var(--wg-ink)}
  input[type=text]{background:color-mix(in srgb,var(--wg-bg) 92%,var(--wg-ink) 8%);border:1px solid var(--wg-line);
         color:var(--wg-ink);border-radius:8px;padding:5px 8px;font-size:12px;width:170px}
  main{flex:1;display:flex;min-height:0}
  .list{width:44%;border-right:1px solid var(--wg-line);overflow:auto}
  .item{padding:7px 10px;border-bottom:1px solid var(--wg-line-soft);cursor:pointer}
  .item:hover{background:var(--wg-elev)}
  .item.sel{background:var(--wg-accent-soft);box-shadow:inset 3px 0 0 var(--wg-accent)}
  .item .p{color:var(--wg-ink);word-break:break-all;line-height:1.35}
  .item .m{color:var(--wg-ink2);font-size:11px;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap}
  .tag{background:var(--wg-good-bg);color:var(--wg-good);border:1px solid var(--wg-good-line);border-radius:5px;padding:0 5px;font-size:10.5px}
  .tag.dim{background:color-mix(in srgb,var(--wg-bg) 88%,var(--wg-ink) 12%);color:var(--wg-ink3);border-color:var(--wg-line-soft)}
  .detail{flex:1;display:flex;flex-direction:column;min-width:0}
  .bar{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--wg-line);flex-wrap:wrap}
  pre{margin:0;padding:10px;overflow:auto;flex:1;font:11.5px/1.5 ui-monospace,Consolas,monospace;color:var(--wg-ink2);white-space:pre}
  footer{padding:6px 10px;border-top:1px solid var(--wg-line);color:var(--wg-ink3);font-size:11px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .hide{display:none!important}
  kbd{background:color-mix(in srgb,var(--wg-bg) 88%,var(--wg-ink) 12%);border:1px solid var(--wg-line);border-radius:4px;padding:0 4px;font-size:10.5px}
  @media (prefers-reduced-motion: reduce){.wg-cloud,.wg-star{animation:none!important}}
  @media (max-width:560px){.wrap{width:96vw;height:76vh}input[type=text]{width:108px}.list{width:48%}}
  `;

  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') el.style.cssText = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) => c && el.appendChild(c));
    return el;
  }

  function buildUI() {
    // 幂等守卫：document-start 时 documentElement 可能还没出现，boot 会 setTimeout 重试，
    // 而 DOMContentLoaded 又会调一次 boot —— 没有这行就会造出两个宿主/两个浮标，
    // state.root 只指向后一个，前一个的计数永远停在 0。
    if (state.root) return;
    // 同一页面里残留的旧宿主（脚本热重载/重复注入）一并清掉，保证只有一个面板
    const stale = document.querySelectorAll('#' + SCRIPT_ID);
    for (const el of stale) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    const host = document.createElement('div');
    host.id = SCRIPT_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('style', { text: CSS }));
    // 主题令牌写进这个 <style>（applyTheme 每次重算就换一遍皮肤）
    const themeStyle = h('style', { class: 'wg-theme', text: '' });
    shadow.appendChild(themeStyle);

    const themeBtn = h('button', {
      class: 'mini',
      title: '面板配色：自动跟随页面主题 / 锁定浅色 / 锁定深色',
      onclick: () => cycleTheme('mode'),
    });
    const nephBtn = h('button', {
      class: 'mini',
      title: 'Nephele 云雾与星尘风格：自动 / 开 / 关',
      onclick: () => cycleTheme('nephele'),
    });

    const count = h('b', { text: '0' });
    const fab = h('div', { class: 'fab', title: 'Alt+G 切换面板', onclick: toggle }, [
      h('span', { text: '抓取增强' }),
      count,
    ]);

    const search = h('input', {
      type: 'text',
      placeholder: '过滤接口路径…',
      oninput: (e) => {
        state.filter = e.target.value.trim().toLowerCase();
        render();
      },
    });
    const pauseBtn = h('button', { text: '暂停', onclick: (e) => {
      state.paused = !state.paused;
      e.target.textContent = state.paused ? '继续' : '暂停';
      e.target.classList.toggle('primary', state.paused);
    }});
    const closeBtn = h('button', { text: '✕', onclick: () => toggle(false) });

    const header = h('header', [
      h('span', { class: 'title', text: 'SPA 抓取增强器' }),
      search,
      pauseBtn,
      themeBtn,
      nephBtn,
      h('span', { class: 'sp' }),
      closeBtn,
    ]);

    const listEl = h('div', { class: 'list' });
    const barEl = h('div', { class: 'bar' });
    const preEl = h('pre', { text: '选一个接口看返回结构。\n\n提示：绿色标签 = 这个接口在返回列表数据。' });
    const themeNote = h('span', { class: 'note', text: '配色：自动' });
    const footer = h('footer', [
      h('span', { text: 'Alt+G 开/关' }),
      themeNote,
      h('span', { text: '数据只在本地内存，不上传' }),
    ]);

    // Nephele 的星尘：固定种子的伪随机，位置稳定（每次刷新都一样）
    let seed = 20261011;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const stars = [];
    for (let i = 0; i < 16; i += 1) {
      const size = rnd() > 0.75 ? 3 : 2;
      stars.push(h('div', {
        class: 'wg-star',
        style: `left:${(rnd() * 96 + 2).toFixed(2)}%;top:${(rnd() * 88 + 2).toFixed(2)}%;` +
          `width:${size}px;height:${size}px;animation-delay:${(rnd() * 4).toFixed(2)}s`,
      }));
    }
    const sky = h('div', { class: 'wg-sky' }, [
      h('div', { class: 'wg-cloud c1' }),
      h('div', { class: 'wg-cloud c2' }),
      h('div', { class: 'wg-cloud c3' }),
      ...stars,
    ]);

    const wrap = h('div', { class: 'wrap hide' }, [
      sky,
      header,
      h('main', [listEl, h('div', { class: 'detail' }, [barEl, preEl])]),
      footer,
    ]);

    shadow.append(fab, wrap);
    state.root = {
      host, shadow, fab, wrap, count, listEl, barEl, preEl,
      themeStyle, themeBtn, nephBtn, themeNote, sky,
    };
    document.documentElement.appendChild(host);
    // 上色 + 订阅页面主题变化（换主题、切深浅、开关 Nephele 都跟着走）
    applyTheme();
    watchTheme();

    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        toggle();
      }
    });
  }

  function toggle(force) {
    if (!state.root) return;
    const show = force === undefined ? state.root.wrap.classList.contains('hide') : force;
    state.root.wrap.classList.toggle('hide', !show);
    state.root.fab.classList.toggle('hide', show);
    if (show) render();
  }

  function currentRecord() {
    return state.records.find((r) => r.id === state.selected) || null;
  }

  function rowsOf(rec) {
    if (!rec) return [];
    if (!rec.listPath) return [];
    const arr = getByPath(rec.json, rec.listPath);
    return Array.isArray(arr) ? arr : [];
  }

  function render() {
    if (!state.root) return;
    const { count, listEl, barEl, preEl } = state.root;
    count.textContent = String(state.records.length);

    const kw = state.filter;
    const items = state.records.filter((r) => !kw || r.path.toLowerCase().includes(kw));

    listEl.textContent = '';
    if (!items.length) {
      listEl.appendChild(h('div', { class: 'item', text: '还没有捕获到 JSON 接口。刷新页面或点一下列表试试。' }));
    }
    for (const r of items) {
      const tags = [];
      if (r.isList) tags.push(h('span', { class: 'tag', text: `${r.rowCount} 行 @ ${r.listPath}` }));
      tags.push(h('span', { class: 'tag dim', text: r.method }));
      tags.push(h('span', { class: 'tag dim', text: String(r.status) }));
      if (r.ms) tags.push(h('span', { class: 'tag dim', text: `${r.ms}ms` }));
      listEl.appendChild(
        h('div', {
          class: `item${r.id === state.selected ? ' sel' : ''}`,
          onclick: () => {
            state.selected = r.id;
            render();
          },
        }, [
          h('div', { class: 'p', text: r.path }),
          h('div', { class: 'm' }, tags),
        ])
      );
    }

    const rec = currentRecord();
    barEl.textContent = '';
    preEl.textContent = '';
    if (!rec) return;

    const rows = rowsOf(rec);
    const base = (rec.path.split('/').pop() || 'data').replace(/[^\w.-]/g, '');
    const curl = `curl -s -X ${rec.method} '${rec.url}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Origin: ${location.origin}' \\\n  ${rec.body ? `--data-raw '${rec.body.replace(/'/g, `'\\''`)}'` : ''}`;

    const buttons = [
      h('button', { class: 'mini', text: '复制 curl', onclick: () => copy(curl, 'curl 已复制') }),
      h('button', { class: 'mini', text: '复制原始 JSON', onclick: () => copy(JSON.stringify(rec.json, null, 2), 'JSON 已复制') }),
      h('button', { class: 'mini primary', text: `导出 JSON (${rows.length || 0} 行)`, onclick: () => download(`${base}.json`, JSON.stringify(rows.length ? rows : rec.json, null, 2)) }),
      h('button', { class: 'mini', text: '导出 CSV', onclick: () => rows.length ? download(`${base}.csv`, toCsv(rows), 'text/csv') : toast('该接口不是列表接口') }),
      h('button', { class: 'mini', text: '导出 Markdown', onclick: () => rows.length ? download(`${base}.md`, toMarkdown(rows), 'text/markdown') : toast('该接口不是列表接口') }),
      h('button', { class: 'mini', text: '复制 fetch 代码', onclick: () => copy(fetchSnippet(rec), 'fetch 代码已复制') }),
    ];
    if (isMojing()) {
      buttons.push(
        h('button', { class: 'mini', text: '模竞全量抓取', onclick: () => grabMojingAll() })
      );
    }
    barEl.append(...buttons);

    preEl.textContent = rec.listPath
      ? `listPath: ${rec.listPath}\n字段(${rec.fields.length}): ${rec.fields.join(', ')}\n\n` +
        JSON.stringify(rows.slice(0, 3), null, 2) +
        (rows.length > 3 ? `\n\n… 其余 ${rows.length - 3} 行已省略` : '')
      : JSON.stringify(rec.json, null, 2).slice(0, 20000);
  }

  function fetchSnippet(rec) {
    return `// 直接复现这个接口（浏览器/Node 18+ 都能跑）
const res = await fetch(${JSON.stringify(rec.url)}, {
  method: ${JSON.stringify(rec.method)},
  headers: { 'Content-Type': 'application/json', Origin: location.origin },
  ${rec.body ? `body: ${JSON.stringify(rec.body)},` : ''}
});
const data = await res.json();
console.log(data);`;
  }

  // ------------------------------------------------- 模竞（mojinghub）专用增强

  const isMojing = () => /(^|\.)mojinghub\.com$/.test(location.hostname);
  const MOJING_API = 'https://admin.mojinghub.com';

  async function grabMojingAll() {
    toast('开始直连接口抓取全部竞赛…');
    try {
      const all = [];
      let page = 1;
      for (;;) {
        const res = await fetch(`${MOJING_API}/api/Competition.Competition/index`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lite: 1, page, limit: 100 }),
        });
        const json = await res.json();
        const rows = json?.data?.data || json?.data?.list || [];
        all.push(...rows);
        const last = json?.data?.last_page || 1;
        if (page >= last || page >= 50 || !rows.length) break;
        page += 1;
      }
      download(`mojinghub-competitions-${all.length}.json`, JSON.stringify(all, null, 2));
      toast(`抓完 ${all.length} 条，已下载 JSON`);
    } catch (err) {
      toast(`抓取失败：${err.message}`);
    }
  }

  // ---------------------------------------------------------------- 调试入口

  // 面板能做的事，控制台都能做；此外这个对象让 scripts/check-userscript.mjs 能对脚本做真实执行验证。
  try {
    window.__spaGrab = {
      version: '1.1.1',
      state,
      records: () => state.records.slice(),
      lists: () => state.records.filter((r) => r.isList),
      best: () => state.records.find((r) => r.isList) || null,
      findListPath,
      toCsv,
      toMarkdown,
      shortPath,
      fetchSnippet,
      record,
      grabMojingAll,
      // 主题：theme() 现在算出来的结果，setTheme({mode,nephele}) 手动锁定，themeCSS() 看注入的令牌
      theme: () => themeCtl.current || computeTheme(),
      recomputeTheme: () => computeTheme(),
      themeCSS: () => themeCSS(themeCtl.current || computeTheme()),
      setTheme: (patch) => {
        const u = themeCtl.current ? themeCtl.current.user : readUserTheme();
        saveUserTheme({ ...u, ...patch });
        return applyTheme();
      },
      resetTheme: () => {
        try {
          localStorage.removeItem(THEME_KEY);
        } catch {
          /* ignore */
        }
        return applyTheme();
      },
      palettes: () => JSON.parse(JSON.stringify(PALETTES)),
      pause: (v) => {
        state.paused = v !== false;
        return state.paused;
      },
      clear: () => {
        state.records.length = 0;
        state.selected = null;
        render();
      },
    };
  } catch {
    /* 沙箱环境没有 window，忽略 */
  }

  // ---------------------------------------------------------------- 启动

  if (window.top === window) {
    installHooks();
    let booted = false;
    const boot = () => {
      if (booted) return;
      if (!document.documentElement) return setTimeout(boot, 20);
      booted = true;
      buildUI();
      // 有些页面会重绘 body，把我们的宿主挂到 html 上避免被清掉
      setInterval(() => {
        if (state.root && !document.documentElement.contains(state.root.host)) {
          document.documentElement.appendChild(state.root.host);
        }
      }, 3000);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
      boot();
    } else boot();
  }
})();
