import { readProductSource } from "./lib/read-product-source.mjs";
/**
 * v0.62.0 · 网盘同步引导的回归守卫。
 *
 * 三件事必须钉住：
 *  1. URL 拼接/反解对中文文件夹名成立（拼错就是所有人同步不上去）；
 *  2. 目录不存在时会自动 MKCOL 建出来，且重复点是幂等的（这是「一键配好」的全部价值）；
 *  3. 应用密码只进密钥库，绝不进 settings / 快照 —— 进了就会跟着快照一起上传到网盘。
 * 外加几条源码契约（Rust 侧认得 WebDAV 方法且未门控、卡片真的接上、样式类名有定义）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => readProductSource(new URL(rel, import.meta.url), 'utf8');
const cardSrc = read('../src/views/settings/sync.js');

/* ── 假 Tauri 后端 ──
   替 window.__TAURI_INTERNALS__.invoke 而不是替全局 fetch：那才是 exe / APK 真正走的路径，
   顺带把「JS 参数形状 → Rust 命令」这层的契约一起钉住（WebDAV 方法正是在这层丢掉的）。 */
const dirs = new Set(['/dav']);
const files = new Map();
const vault = new Map();
const calls = [];
const ACCOUNT = 'me@example.com';
const APP_SECRET = 'app-secret';

/** 字段名照 HttpFetchResp 的 serde 形状来，改一边另一边就得红。 */
function reply(status, body = '', contentType = 'application/xml') {
  return { status, body, finalUrl: '', contentType, location: '', cookies: [] };
}

/** 像真服务器一样校验 Basic：误填网页登录密码那条路才测得出来。 */
function authorized(headers) {
  const header = String(headers?.Authorization || '');
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i > 0 && decoded.slice(0, i) === ACCOUNT && decoded.slice(i + 1) === APP_SECRET;
}

function webDavServer({ method, url, headers, body }) {
  // calls 记的是原始路径：服务端区分「/dav/x」和「/dav/x/」，探测必须带集合尾斜杠。
  const rawPath = decodeURIComponent(new URL(url).pathname);
  const path = rawPath.replace(/\/+$/, '') || '/';
  calls.push(`${method} ${rawPath}`);
  if (!authorized(headers)) return reply(401);
  if (method === 'PROPFIND') {
    // Nextcloud 一类服务器遇到裸 PROPFIND 直接拒，缺 Depth 或请求体就算实现错。
    if (!headers.Depth) return reply(400, 'missing Depth');
    if (!/<(?:[A-Za-z0-9]+:)?propfind[\s>]/.test(String(body || ''))) return reply(400, 'missing body');
    return dirs.has(path) ? reply(207, '<multistatus/>') : reply(404);
  }
  if (method === 'MKCOL') {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (!dirs.has(parent)) return reply(409);
    if (dirs.has(path)) return reply(405);
    dirs.add(path);
    return reply(201);
  }
  if (method === 'PUT') {
    if (!dirs.has(path.slice(0, path.lastIndexOf('/')) || '/')) return reply(409);
    files.set(path, body);
    return reply(201);
  }
  if (method === 'GET') return files.has(path) ? reply(200, files.get(path), 'application/json') : reply(404);
  return reply(405);
}

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args = {}) => {
      if (cmd === 'http_session_new') return 's1';
      if (cmd === 'http_fetch') return webDavServer(args);
      if (cmd === 'plugin_vault_set') {
        if (args.pluginId !== 'core-webdav') throw new Error(`同步密码不该写进 ${args.pluginId} 这个库`);
        vault.set(args.key, args.value);
        return null;
      }
      if (cmd === 'plugin_vault_get') return vault.get(args.key) ?? null;
      if (cmd === 'plugin_vault_del') { vault.delete(args.key); return null; }
      throw new Error(`测试桩没实现命令 ${cmd}`);
    },
  },
};

const L = await import('../src/syncLayer.js');

/* ── ① URL 拼接与反解 ── */
// 更名后预设默认文件夹是纯 ASCII 的 U-Time，「中文逐段转义」这个行为必须显式传中文来测，
// 不能再蹭默认名当靶子。
assert.equal(L.getPreset('jianguoyun').folder, 'U-Time', '预设默认文件夹已随更名改为 U-Time');
const target = L.buildDavUrl({ root: 'https://dav.jianguoyun.com/dav', folder: '时间管理' });
assert.equal(target, 'https://dav.jianguoyun.com/dav/%E6%97%B6%E9%97%B4%E7%AE%A1%E7%90%86/le-time-data.json', '中文文件夹名必须逐段转义');
assert.deepEqual(L.splitDavUrl(target), { origin: 'https://dav.jianguoyun.com', segments: ['dav', '时间管理'], fileName: 'le-time-data.json' }, '反解只拆到「段」，不猜根地址边界');
assert.equal(L.davRootDepth('https://dav.jianguoyun.com/dav'), 1, '坚果云的根自带一层 /dav');
assert.equal(L.composeDavRoot('https://x.test', ['dav', '时间管理']), 'https://x.test/dav/%E6%97%B6%E9%97%B4%E7%AE%A1%E7%90%86', '拼回去不带结尾斜杠');
assert.equal(L.buildDavFolderUrl({ root: 'https://dav.jianguoyun.com/dav/', folder: 'a/b' }), 'https://dav.jianguoyun.com/dav/a/b', '目录地址不带结尾斜杠');
assert.equal(L.buildDavUrl({ root: 'https://x.test/dav', folder: '' }).endsWith('/dav/le-time-data.json'), true, '文件夹留空就放根下');
assert.throws(() => L.buildDavUrl({ root: 'ftp://x.test/dav' }), /只支持 http/);

/* ── ② 老地址迁移：整条 url → 根地址 + 文件夹 + 文件名 ── */
const legacy = { url: 'https://dav.jianguoyun.com/dav/U-Time/data.json', username: ACCOUNT };
L.migrateLegacyUrl(legacy);
assert.equal(legacy.presetId, 'jianguoyun');
assert.equal(legacy.root, 'https://dav.jianguoyun.com/dav');
assert.equal(legacy.folder, 'U-Time', '根地址自带的 /dav 不能当成文件夹名');
assert.equal(legacy.fileName, 'data.json', '老文件名要保留，否则第一次「拉回本地」会扑空');
assert.equal(L.buildDavUrl(legacy), 'https://dav.jianguoyun.com/dav/U-Time/data.json');
L.migrateLegacyUrl(legacy);
assert.equal(legacy.folder, 'U-Time', '迁移必须幂等，第二次不能把文件夹吃成空');
const legacyAtRoot = { url: 'https://dav.jianguoyun.com/dav/data.json' };
L.migrateLegacyUrl(legacyAtRoot);
assert.equal(legacyAtRoot.folder, '', '快照原本就放在根下时，文件夹是空而不是「dav」');
const legacyOther = { url: 'http://192.168.1.5:5005/WebDAV/备份/data.json' };
L.migrateLegacyUrl(legacyOther);
assert.equal(legacyOther.presetId, 'custom');
assert.equal(L.buildDavUrl(legacyOther), 'http://192.168.1.5:5005/WebDAV/%E5%A4%87%E4%BB%BD/data.json', '认不出的地址整条保留');
const already = { presetId: 'nextcloud', root: 'https://keep.test/dav' };
L.migrateLegacyUrl(already);
assert.equal(already.root, 'https://keep.test/dav', '已经有 presetId 的不许再动');

/* ── ③ 预设 ── */
assert.equal(L.getPreset('jianguoyun').rootEditable, false);
assert.equal(L.getPreset('jianguoyun').root, 'https://dav.jianguoyun.com/dav');
assert.equal(L.getPreset('nextcloud').rootEditable, true);
assert.equal(L.getPreset('某个已不存在的预设').id, 'custom', '未知预设不能猜成坚果云，否则根地址会被换成别人的');
assert.match(cardSrc, /getPreset\(cfg\.presetId \|\| "jianguoyun"\)/, '没配过的新用户默认停在坚果云');
assert.ok(L.getPreset('jianguoyun').root.startsWith('https://'), '内置预设不许发 http 根地址');
assert.ok(L.getPreset('jianguoyun').howto.some((line) => /第三方应用管理/.test(line)), '坚果云必须写清应用密码在哪生成');

/* ── ④ 一键配好：核对账号 → 自动建目录 → 传快照 ── */
const creds = { root: 'https://dav.jianguoyun.com/dav', folder: 'U-Time', username: ACCOUNT, password: APP_SECRET };
calls.length = 0;
assert.equal((await L.testWebDavConnection(creds)).status, 207, '根目录探到 207 说明账号可登录');
const first = await L.ensureWebDavFolder(creds);
assert.deepEqual(first.created, ['U-Time'], '目录不存在时自动建出来');
assert.deepEqual(calls, ['PROPFIND /dav/', 'PROPFIND /dav/U-Time/', 'MKCOL /dav/U-Time/'], '先探测再建，探测与建目录都走集合形式，不多发请求');
assert.deepEqual((await L.ensureWebDavFolder(creds)).created, [], '重复点是幂等的：目录已有就不再 MKCOL');
assert.deepEqual((await L.ensureWebDavFolder({ ...creds, folder: 'U-Time/子目录' })).created, ['子目录'], '多级目录只补缺的那几层');
calls.length = 0;
assert.deepEqual((await L.ensureWebDavFolder({ ...creds, folder: '' })).created, [], '文件夹留空时一个请求都不该发');
assert.deepEqual(calls, []);

// 上传走 ④ 建好的 U-Time 目录；① 里的 target 是中文文件夹 URL，桩子里没建过那个目录。
const up = await L.uploadWebDav({ url: L.buildDavUrl({ root: creds.root, folder: 'U-Time' }), username: ACCOUNT, password: APP_SECRET, data: { tasks: [], blocks: [] }, appVersion: '9.9.9' });
assert.equal(up.snapshot.format, 'le-time-management-sync');
const onDisk = files.get('/dav/U-Time/le-time-data.json');
assert.deepEqual(L.parseSnapshot(onDisk).data.tasks, [], '传上去的快照要能原样读回来');
assert.equal(JSON.parse(onDisk).appVersion, '9.9.9');
assert.equal(onDisk.includes(APP_SECRET), false, '快照里绝不能出现密码');
await assert.rejects(
  () => L.downloadWebDav({ url: L.buildDavUrl({ root: creds.root, folder: '没传过的目录' }), username: ACCOUNT, password: APP_SECRET }),
  /还没有这份快照文件|404/,
);

/* ── ⑤ 失败要翻成人话，而且说清是哪一步 ── */
await assert.rejects(() => L.testWebDavConnection({ ...creds, password: '网页登录密码' }), /应用密码/, '误填登录密码必须被认出来');
assert.match(L.describeWebDavFailure(404, 'get'), /先点「上传本地 → 网盘」/);
assert.match(L.describeWebDavFailure(401), /HTTP 401/);
assert.match(L.describeWebDavFailure(507), /空间满/);
assert.match(L.describeWebDavFailure(409, 'mkcol'), /上级目录还不存在/);
assert.equal(L.describeWebDavFailure(418), '访问网盘失败（HTTP 418）');
assert.match(L.describeSyncError(new Error('请求失败: error sending request for url')), /连不上这个地址/);
assert.equal(L.isPotentiallyUnsafeWebDav('http://192.168.1.5/dav/x.json'), true, '内网 http 也要提醒：密码在内网里同样是明文走的');
assert.equal(L.isPotentiallyUnsafeWebDav('http://localhost/dav/x.json'), false, '回环地址不打扰');
assert.equal(L.isPotentiallyUnsafeWebDav('https://dav.jianguoyun.com/dav/x.json'), false, 'https 不打扰');

/* ── ⑥ 密码只进密钥库 ── */
assert.equal(await L.saveStoredSyncPassword(APP_SECRET), true);
assert.equal(await L.loadStoredSyncPassword(), APP_SECRET);
assert.deepEqual([...vault.keys()], ['webdav-password'], '密钥库里只该有这一个键');
assert.equal(await L.saveStoredSyncPassword(''), false, '空密码不许覆盖已存的那串');
assert.equal(await L.loadStoredSyncPassword(), APP_SECRET);
await L.clearStoredSyncPassword();
assert.equal(await L.loadStoredSyncPassword(), '');

const settingsSrc = read('../src/views/settings.js');
const rust = read('../src-tauri/src/lib.rs');
const styles = read('../src/styles.css');

assert.doesNotMatch(cardSrc, /cfg\.password/, '密码不许落到 settings（settings 进 data.json，data.json 会被上传）');
assert.doesNotMatch(cardSrc, /Object\.assign\(cfg,\s*\{[^}]*password/i);
assert.match(cardSrc, /saveStoredSyncPassword\(password\)/);
assert.match(cardSrc, /remember\.checked/, '「记住密码」开关必须真的决定存不存');

/* ── ⑦ Rust 侧认得 WebDAV 方法，且没门控成桌面专属（APK 也要能用）── */
assert.match(rust, /"MKCOL" => client\.request\(dav_method\(b"MKCOL"\)/);
assert.match(rust, /"PROPFIND" => client\.request\(dav_method\(b"PROPFIND"\)/);
assert.match(rust, /fn dav_method\(raw: &\[u8\]\)/);
assert.match(rust, /#\[tauri::command\]\nasync fn http_fetch/, 'http_fetch 上方不能挂 #[cfg(desktop)]');
assert.doesNotMatch(rust, /#\[cfg\(desktop\)\]\nasync fn http_fetch/);

/* ── ⑧ 卡片接线与样式类名 ── */
assert.match(settingsSrc, /create: \(\{ render \}\) => createSyncCard\(/, '设置页按分类打开时创建引导卡');
assert.match(settingsSrc, /import \{ createSyncCard \} from "\.\/settings\/sync\.js"/);
assert.match(settingsSrc, /\{ id: "sync", create:/, '设置导航里还得有这一节，搜不到就等于没有');
assert.doesNotMatch(settingsSrc, /from "\.\.\/syncLayer\.js"/, '实现已搬进卡片模块，主文件不该还留着旧 import');
for (const cls of new Set([...cardSrc.matchAll(/sync-[a-z-]+/g)].map((m) => m[0]))) {
  assert.match(styles, new RegExp(`\\.${cls}[\\s,{:]`), `styles.css 里没有 .${cls} 这条规则`);
}
assert.doesNotMatch(styles, /\.sync-fields/, '老卡的 .sync-fields 已无人用，别留在样式里');

console.log('PASS: v0.62.0 WebDAV 同步引导（URL 转义 / 老地址迁移幂等 / 自动建目录 / 失败文案 / 密码只进密钥库 / Rust WebDAV 方法未门控）');
