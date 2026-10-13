#!/usr/bin/env node
/**
 * tools/shots/audit.mjs —— 给渲染好的预览页做「真浏览器几何审计」。
 *
 * 为什么需要它：出演示图时最怕「结构对、样式塌」或「内容溢出被裁」，
 * 而这两种问题在静态 HTML 里看不出来（要真排版引擎才有几何）。
 * 本脚本用 CDP 打开页面、等插件视图渲染完，量关键元素的盒模型并回传 JSON。
 *
 * 用法：
 *   node tools/shots/audit.mjs <预览页.html> [更多页面...]
 * 输出：每个文件一行 JSON（viewport / 文档尺寸 / 横向溢出 / 各区块盒子 / 被裁元素 / 计数）。
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = process.env.CHROME_PROFILE || `${process.env.TEMP}\\cx2-audit-profile`;

const AUDIT_JS = `(() => {
  const box = (s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const clips = [...document.querySelectorAll('.aw-row,.aw-pill,.aw-name,.aw-date,.aw-src')]
    .filter((e) => e.scrollWidth > e.clientWidth + 2)
    .slice(0, 6)
    .map((e) => (e.className || '') + '|' + String(e.textContent).slice(0, 24));
  const seg = document.querySelector('[data-aw-seg="order"]');
  const segKind = document.querySelector('[data-aw-seg="kind"]');
  const panel = document.querySelector('.aw-panel');
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    shell: box('.pp-shell'), side: box('.pp-side'), main: box('.pp-main'), wrap: box('.pp-wrap'),
    panel: box('.aw-panel'), head: box('.aw-head'), tools: box('.aw-tools'), segMode: box('[data-aw-seg="mode"]'),
    firstItem: box('.aw-item'), firstShell: box('.aw-item .aw-shell'), openItem: box('.aw-item.open'),
    lastItem: box('.aw-item:last-of-type'),
    counts: {
      items: document.querySelectorAll('.aw-item').length,
      open: document.querySelectorAll('.aw-item.open').length,
      pills: document.querySelectorAll('.aw-pill').length,
      rows: document.querySelectorAll('.aw-rank-row,.aw-item').length,
    },
    segHidden: { order: !!(seg && seg.hidden), kind: !!(segKind && segKind.hidden) },
    status: (document.querySelector('.aw-status') || {}).textContent || '',
    bottomGap: panel ? Math.round(document.documentElement.scrollHeight - panel.getBoundingClientRect().bottom) : null,
    ink: (() => { const e = document.querySelector('.aw-name') || document.body; const c = getComputedStyle(e); return c.color + ' / ' + c.fontSize; })(),
    clips,
  });
})()`;

async function waitForChrome() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await delay(250);
  }
  throw new Error("Chrome 调试端口没起来");
}

async function evaluate(wsUrl, expression, tries = 40) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = pending.get(msg.id);
    if (slot) { pending.delete(msg.id); slot(msg); }
  };
  const send = (method, params) => new Promise((res) => {
    id += 1;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  let out = null;
  for (let i = 0; i < tries; i += 1) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    const v = r?.result?.result?.value;
    if (v) { out = v; break; }
    await delay(250);
  }
  ws.close();
  return out;
}

const files = process.argv.slice(2).filter((f) => fs.existsSync(f));
if (!files.length) {
  console.error("用法：node tools/shots/audit.mjs <预览页.html> [...]");
  process.exit(1);
}

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--allow-file-access-from-files",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1280,1500", "about:blank",
], { stdio: "ignore", detached: false });

try {
  await waitForChrome();
  for (const file of files) {
    const url = pathToFileURL(file).href;
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
    const json = await evaluate(t.webSocketDebuggerUrl, AUDIT_JS);
    console.log(`${file}\n${json || "(没拿到几何数据：页面可能没渲染出 .aw-panel)"}`);
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  }
} finally {
  chrome.kill();
}
