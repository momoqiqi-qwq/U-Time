#!/usr/bin/env node
/**
 * 把 web-grab 目录挂到本地 HTTP —— 用途只有一个：
 * 让油猴管理器能「拦截」到 .user.js 的导航（file:// 需要额外开「允许访问文件网址」，
 * http:// 则开箱即用），顺手也能在浏览器里打开预览页。
 *
 *   node scripts/serve.mjs              # http://127.0.0.1:8788/
 *   node scripts/serve.mjs --port 9000  # 换端口
 *
 * 页面：/                       目录索引
 *       /userscript/spa-grab-enhancer.user.js   油猴插件安装地址
 *       /docs/panel-preview.html                配色预览
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const hasPortArg = portArg >= 0; // 注意：indexOf 找不到是 -1（真值），必须显式比较
const PORT = hasPortArg ? Number(args[portArg + 1]) : 8788;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/plain; charset=utf-8', // .user.js 按纯文本发，跟 GitHub raw 一致，油猴照样拦截
  '.mjs': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ics': 'text/calendar; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  if (rel === '/') rel = '/docs/panel-preview.html';
  const abs = path.join(ROOT, rel);

  // 不许跳出 web-grab 目录
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 ${rel}`);
      return;
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    fs.createReadStream(abs).pipe(res);
  });
});

// 端口被占就往后让一位（本机 8788 常被 wb-proxy 之类占着）
let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !hasPortArg) {
    port += 1;
    if (port > PORT + 20) throw err;
    console.log(`端口 ${port - 1} 被占，试 ${port} …`);
    server.listen(port, HOST);
    return;
  }
  throw err;
});

server.on('listening', () => {
  console.log(`web-grab 已挂载：http://${HOST}:${port}/`);
  console.log(`  安装油猴插件：http://${HOST}:${port}/userscript/spa-grab-enhancer.user.js`);
  console.log(`  配色预览：    http://${HOST}:${port}/docs/panel-preview.html`);
});
server.listen(port, HOST);
