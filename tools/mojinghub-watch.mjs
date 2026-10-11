#!/usr/bin/env node
/**
 * 模竞 (mojinghub.com) 通知 / 新竞赛轮询器 —— 不需要任何浏览器插件。
 *
 * 原理：站点是 React SPA，数据全部来自 https://admin.mojinghub.com 的接口。
 *   - 公开接口（无需登录）：Competition / Events / Article / Banner / SiteConfig
 *   - 私有接口（需登录 token）：Notification.Notification/*
 * 服务端 CORS 只放行 https://www.mojinghub.com，所以浏览器里跨域会被拦；
 * 但桌面 / Node / 手机端直接发 HTTP 没有同源策略，照样能读。
 *
 * 用法：
 *   node tools/mojinghub-watch.mjs                 # 只看公开的新竞赛/活动
 *   node tools/mojinghub-watch.mjs --loop          # 每 5 分钟轮询一次
 *   MOJING_TOKEN=xxx node tools/mojinghub-watch.mjs --with-notify
 *   node tools/mojinghub-watch.mjs --json          # 输出 JSON 供其它程序消费
 *   node tools/mojinghub-watch.mjs --install-toast # 注册 Windows 通知宿主（只需跑一次）
 *   node tools/mojinghub-watch.mjs --toast --test-toast   # 弹一条测试通知
 *
 * 取 token：浏览器登录 www.mojinghub.com → F12 → Application → Local Storage
 *   → 键 auth-storage → 里面 state.token 的值（纯字符串，直接塞 Authorization 头）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://admin.mojinghub.com';
const STATE_FILE = resolve(HERE, '..', '.workbuddy', 'mojinghub-watch-state.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const LOOP = has('--loop');
const INTERVAL = Number(argOf('--interval', '300')) * 1000;
const AS_JSON = has('--json');
const WITH_NOTIFY = has('--with-notify');
const TOAST = has('--toast');
const INSTALL_TOAST = has('--install-toast');
const TOKEN = process.env.MOJING_TOKEN || argOf('--token', '');

/**
 * toast 用的 AppUserModelID。Windows 只认「已注册」的 AUMID：注册方式是在开始菜单
 * 留一个快捷方式（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\<AUMID>.lnk`），
 * 快捷方式指向哪里不重要。没注册时 CreateToastNotifier(...).Show() 不报错但静默丢弃，
 * 通知中心里也不会留记录 —— 这就是以前 --toast 看着成功却什么都不弹的原因。
 */
const AUMID = 'mojinghub-watch';
const toastShortcutPath = () => resolve(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${AUMID}.lnk`);

/** 在开始菜单写一个同名的空快捷方式，把 AUMID 注册进 Windows（幂等）。 */
function installToastHost() {
  const lnk = toastShortcutPath();
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
    '$sc.TargetPath = "$env:SystemRoot\\System32\\cmd.exe"',
    "$sc.Arguments = '/c exit'",
    `$sc.Description = '${AUMID} toast host'`,
    '$sc.Save()',
  ].join('; ');
  return new Promise((ok, fail) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], (err) => (err ? fail(err) : ok(lnk)));
  });
}

/** 统一 POST 调用，返回后端 JSON（模竞所有接口都是 POST + JSON body）。 */
async function api(path, body = {}, { token = null } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    // 故意不带 Origin：服务端不校验来源，只有浏览器才受 CORS 约束。
    // 带上 Origin 反而会让服务端回一个只放行 www.mojinghub.com 的 ACAO 头。
    Referer: 'https://www.mojinghub.com/competitions',
  };
  if (token) headers.Authorization = token;
  const res = await fetch(API + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  // 模竞后端永远返回 HTTP 200，真实状态在 body.status：
  // 200 正常；102 token 解析错误；103 token 缺失；401/-1 登录态失效。
  const code = Number(json?.status);
  if (Number.isFinite(code) && code !== 200) {
    const err = new Error(`${path} status=${code} msg=${json.msg || ''}`);
    err.apiStatus = code;
    throw err;
  }
  return json;
}

/** 公开：全部竞赛（含报名时间、阶段、通知 PDF）。 */
const listCompetitions = () => api('/api/Competition.Competition/index', { page: 1, limit: 100 });
/** 公开：全部活动/夏令营。 */
const listEvents = () => api('/api/Events.Events/index', { page: 1, limit: 100 });
/** 公开：文章/公告（论文规范、获奖名单这类长文都在这）。 */
const listArticles = () => api('/api/Article.Article/index', { page: 1, limit: 50 });
/** 私有：站内通知列表。 */
const listNotifications = (token, body = {}) => api('/api/Notification.Notification/index', body, { token });
/** 私有：未读数。 */
const unreadCount = (token) => api('/api/Notification.Notification/unreadCount', {}, { token });

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    /* 状态文件坏了就当空的，下一次会重建 */
  }
  return { competitions: [], events: [], articles: [], notifications: [] };
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** 首次运行只记录基线，不把已有内容全部当成"新"推一遍。 */
function diffNew(prevIds, rows, idOf) {
  const prev = new Set(prevIds);
  const fresh = rows.filter((r) => !prev.has(idOf(r)));
  return { fresh, ids: rows.map(idOf) };
}

/**
 * Windows 原生 toast。必须走 Windows PowerShell 5.1（powershell.exe）：
 * PowerShell 7 的 .NET Core 没有 WinRT 投影，加载 Windows.UI.Notifications 会直接报
 * "找不到类型"。5.1 实测可用，无需装 BurntToast 之类模块。
 * 三个坑，踩过才知道：
 *   1. AUMID 必须先注册（见 installToastHost），否则 .Show() 不报错但被静默丢弃；
 *   2. 脚本必须用 -EncodedCommand 传（base64 + UTF-16LE）。直接 -Command 时 5.1 按系统
 *      ANSI 代码页解析参数，中文标题会变成「妯＄珵鐩戞帶」这种乱码；
 *   3. XML 本身也走 base64（UTF-8）传进 PowerShell，不要在命令行里做引号转义 ——
 *      属性里的双引号撞上外层单引号会让 PowerShell 解析器直接报 Missing ')'。
 */
let warnedUnregistered = false;
function toast(title, message) {
  if (!TOAST) return;
  if (!existsSync(toastShortcutPath()) && !warnedUnregistered) {
    warnedUnregistered = true;
    console.error('[toast] 这个 AUMID 还没注册，通知会被系统静默丢掉。先跑一次：node tools/mojinghub-watch.mjs --install-toast');
  }
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(message)}</text></binding></visual></toast>`;
  const xmlB64 = Buffer.from(xml, 'utf8').toString('base64');
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xmlB64}')))`,
    '$t = [Windows.UI.Notifications.ToastNotification]::new($x)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${AUMID}").Show($t)`,
  ].join('; ');
  execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], () => {});
}

/** XML 文本里不能出现裸的 & < >，先转义再塞进 toast 模板。 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ts(unix) {
  if (!unix) return '-';
  return new Date(Number(unix) * 1000).toLocaleString('zh-CN', { hour12: false });
}

async function tick(state) {
  const out = { at: new Date().toISOString(), competitions: [], events: [], articles: [], notifications: [], unread: null, errors: [] };

  try {
    const r = await listCompetitions();
    const rows = r?.data?.data ?? [];
    const { fresh, ids } = diffNew(state.competitions, rows, (x) => x.competition_id);
    state.competitions = ids;
    out.competitions = fresh.map((x) => ({
      id: x.competition_id,
      title: x.title,
      stage: x.stage,
      signup_start: x.signup_start,
      signup_end: x.signup_end,
      url: `https://www.mojinghub.com/competitions/${x.title_sub || x.competition_id}`,
    }));
  } catch (e) {
    out.errors.push('competitions: ' + e.message);
  }

  try {
    const r = await listEvents();
    const rows = r?.data?.data ?? [];
    const { fresh, ids } = diffNew(state.events, rows, (x) => x.events_id);
    state.events = ids;
    out.events = fresh.map((x) => ({
      id: x.events_id,
      title: x.title,
      start_time: x.start_time,
      end_time: x.end_time,
      url: `https://www.mojinghub.com/events`,
    }));
  } catch (e) {
    out.errors.push('events: ' + e.message);
  }

  try {
    const r = await listArticles();
    const rows = r?.data?.data ?? [];
    const { fresh, ids } = diffNew(state.articles, rows, (x) => x.article_id);
    state.articles = ids;
    out.articles = fresh.map((x) => ({
      id: x.article_id,
      title: x.title,
      url: `https://www.mojinghub.com/article/${x.article_id}`,
    }));
  } catch (e) {
    out.errors.push('articles: ' + e.message);
  }

  if (WITH_NOTIFY || TOKEN) {
    if (!TOKEN) {
      out.errors.push('notifications: 未提供 MOJING_TOKEN，站内通知需要登录 token');
    } else {
      try {
        const u = await unreadCount(TOKEN);
        out.unread = u?.data?.count ?? u?.data ?? null;
        const r = await listNotifications(TOKEN, { page: 1, limit: 20 });
        const rows = r?.data?.data ?? [];
        out.notifications = rows
          .filter((x) => !x.is_read)
          .map((x) => ({
            id: x.id,
            title: x.title,
            content: (x.content || '').slice(0, 120),
            type: x.type,
            category: x.category,
            pinned: !!x.is_pinned,
            time: x.create_time_text || ts(x.create_time),
          }));
        // 通知是流水，不按 id 增量，只记最后看到的一条，便于去重推送
        if (out.notifications[0]) state.lastNotificationId = out.notifications[0].id;
      } catch (e) {
        out.errors.push('notifications: ' + e.message);
      }
    }
  }

  saveState(state);
  return out;
}

function render(out) {
  const lines = [`[${new Date(out.at).toLocaleString('zh-CN', { hour12: false })}] 模竞轮询`];
  if (out.unread !== null) lines.push(`未读通知：${out.unread}`);
  const sec = (name, arr, fmt) => {
    if (!arr.length) return;
    lines.push(`\n— 新增${name} ${arr.length} 条 —`);
    for (const x of arr) lines.push('  ' + fmt(x));
  };
  sec('竞赛', out.competitions, (x) => `#${x.id} ${x.title}｜报名 ${ts(x.signup_start)} ~ ${ts(x.signup_end)}`);
  sec('活动', out.events, (x) => `#${x.id} ${x.title}｜${ts(x.start_time)} ~ ${ts(x.end_time)}`);
  sec('文章', out.articles, (x) => `#${x.id} ${x.title}`);
  sec('未读通知', out.notifications, (x) => `[${x.category || x.type}] ${x.title}｜${x.time}${x.pinned ? '｜置顶' : ''}\n      ${x.content}`);
  if (out.errors.length) lines.push('\n错误：\n  ' + out.errors.join('\n  '));
  if (lines.length === 1) lines.push('  无新增。');
  return lines.join('\n');
}

async function main() {
  if (INSTALL_TOAST) {
    const lnk = await installToastHost();
    console.log(`已注册 toast 宿主：${lnk}`);
    console.log('以后加 --toast 就能弹 Windows 原生通知了。');
    return;
  }
  if (has('--test-toast')) {
    toast('模竞监控 · 通道自检', '这条能弹出来，说明不装插件也能收到通知');
    console.log('已发送测试 toast（检查右下角通知中心）。');
    return;
  }
  const firstRun = !existsSync(STATE_FILE);
  const state = loadState();
  const out = await tick(state);

  if (firstRun) {
    // 第一次跑只建基线，避免把历史上百条内容一次性刷出来
    console.log(render({ ...out, competitions: [], events: [], articles: [], notifications: [] }));
    console.log('（首次运行：已建立基线，之后只报增量）');
  } else {
    if (AS_JSON) console.log(JSON.stringify(out, null, 2));
    else console.log(render(out));
    const n = out.competitions.length + out.events.length + out.notifications.length;
    if (n > 0) {
      const head = out.competitions[0] || out.events[0] || out.notifications[0];
      toast('模竞有新动态', `${head.title}（共 ${n} 条）`);
    }
  }

  if (LOOP) {
    console.log(`\n每 ${INTERVAL / 1000}s 轮询一次，Ctrl+C 退出。`);
    setInterval(() => {
      tick(loadState()).then((o) => console.log(render(o))).catch((e) => console.error(e.message));
    }, INTERVAL);
  }
}

main().catch((e) => {
  console.error('轮询失败：' + e.message);
  process.exit(1);
});
