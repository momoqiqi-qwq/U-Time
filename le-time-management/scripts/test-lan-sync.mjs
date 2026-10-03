import { readProductSource } from "./lib/read-product-source.mjs";
/**
 * v0.67.0 · 局域网直连的回归守卫（本版从「只能拉」扩成「拉 + 受确认门的推」）。
 *
 * 这个功能的安全性建立在四件事上，每一条都必须钉住：
 *  ① 电脑端的联动服务默认对数据只读：回传开关默认关，关着的时候网络上没有那条路由；
 *  ② 开着开关也不许 Rust 侧直接写盘 —— 回传的快照只进内存暂存槽，必须桌面端弹窗里
 *     有人点「接收」，再由前端统一数据层落盘（谁绕过这条，谁就把假同步做成了真丢数据）；
 *  ③ 两边覆盖本机/覆盖电脑之前都要先落一个恢复点，且「拉回本机」在探到电脑概况前是锁着的；
 *  ④ 手机侧 POST 只换来 pending，必须轮询到终端态才对用户报成败（发出去 ≠ 对方接受）。
 * 外加 parseLanTarget：小白只会往一个框里粘一样东西，认不出链接就等于没有这功能。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => readProductSource(new URL(rel, import.meta.url), 'utf8');
const cardSrc = read('../src/views/settings/sync.js');

/* ── 假 Tauri 后端：一台开着联动服务的电脑 ── */
const TOKEN = 'ab12cd34';
const LAN_PORT = 27123;
const STATE = { tasks: [{ id: 't1' }, { id: 't2' }], blocks: [{ id: 'b1' }], settings: {} };
const routes = [];
let info = { ok: true, appVersion: '9.9.9', savedAtEpoch: 1760000000, dataOk: true, allowPush: true, tasks: 2, blocks: 1 };
/** 电脑端确认脚本：手机每轮询一次吃一条；吃完还是 pending（真实服务就是这么应人的）。 */
let pushScript = [];
/** 模拟只有 /api/info 与 /api/state 的老版本电脑。 */
let noPushRoute = false;
const received = [];

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args = {}) => {
      if (cmd === 'http_session_new') return 's1';
      if (cmd !== 'http_fetch') throw new Error(`测试桩没实现命令 ${cmd}`);
      const url = new URL(args.url);
      const route = `${args.method} ${url.pathname}`;
      routes.push(route);
      const http = (status, obj) => ({
        status, body: JSON.stringify(obj), finalUrl: '', contentType: 'application/json', location: '', cookies: [],
      });
      // 端口上挂着别的服务：连接成功但没有我们的路由 → 真服务器会回 404
      if (url.port !== String(LAN_PORT)) return http(404, { error: 'not found' });
      if (url.searchParams.get('token') !== TOKEN) return http(403, { error: 'token 无效' });
      if (url.pathname === '/api/info') return http(200, info);
      if (url.pathname === '/api/state') return http(200, STATE);
      if (url.pathname === '/api/push') {
        if (noPushRoute) return http(404, { error: 'not found' });
        if (!info.allowPush) return http(403, { ok: false, error: '电脑端没开「允许手机推回本机」' });
        const snap = JSON.parse(args.body);
        if (!Array.isArray(snap?.data?.tasks) || !Array.isArray(snap?.data?.blocks)) return http(400, { ok: false, error: '不像数据' });
        received.push(snap);
        return http(202, { ok: true, status: 'pending', id: `p${received.length}` });
      }
      if (url.pathname === '/api/push-status') return http(200, { ok: true, ...(pushScript.shift() || { status: 'pending' }) });
      return http(404, { error: 'not found' });
    },
  },
};

const LAN = await import('../src/lanSync.js');
assert.equal(LAN.DEFAULT_LAN_PORT, LAN_PORT, "引导卡提示的默认端口要跟 lanSync 一致");

/* ── ① parseLanTarget：一个框要吃下所有粘法 ── */
const pair = LAN.parseLanTarget(`http://192.168.1.5:27123/m?token=${TOKEN}`);
assert.deepEqual(pair, { base: 'http://192.168.1.5:27123', token: TOKEN }, '整条配对链接直接粘进来就该能用');
assert.deepEqual(LAN.parseLanTarget('  http://192.168.1.5:27123/m/?x=1&token=zz  '), { base: 'http://192.168.1.5:27123', token: 'zz' }, '多余参数与空格不影响');
assert.equal(LAN.parseLanTarget('192.168.1.5', TOKEN).base, 'http://192.168.1.5:27123', '只给 IP 时补默认端口');
assert.equal(LAN.parseLanTarget(`192.168.1.5:27123 ${TOKEN}`).token, TOKEN, '地址空一格跟配对码也认');
assert.equal(LAN.parseLanTarget('10.0.0.9:8080/', 'tk').base, 'http://10.0.0.9:8080', '结尾斜杠吃掉');
assert.equal(LAN.parseLanTarget('https://192.168.1.5/m', 'tk').base, 'https://192.168.1.5', 'https 也允许（自建带证书的局域网盒子）');
assert.equal(LAN.parseLanTarget(`http://h:1/m?token=${TOKEN}`, '别的码').token, TOKEN, '链接里带了码就以链接为准');
assert.throws(() => LAN.parseLanTarget(''), /贴进来/);
assert.throws(() => LAN.parseLanTarget('192.168.1.5'), /配对码/);
assert.throws(() => LAN.parseLanTarget('ftp://192.168.1.5', TOKEN), /http/);
assert.throws(() => LAN.parseLanTarget('27123', TOKEN), /192\.168\.1\.5/, '只填了端口这种半截地址要指出缺什么');

/* ── ② 探电脑 / 拉快照 ── */
routes.length = 0;
const seen = await LAN.lanInfo(pair);
assert.equal(seen.savedAt, new Date(1760000000 * 1000).toISOString(), '落盘时间要转成 ISO 给界面用');
assert.equal(seen.allowPush, true, '电脑端肯不肯收回传必须原样带给界面，不然按钮只能靠点了才知能不能用');
assert.match(LAN.describeLanInfo(seen), /电脑上有 2 条任务、1 个时间块/, '条数要说人话');
assert.match(LAN.describeLanInfo(seen), /电脑上是 v9\.9\.9/, '概况里带上电脑端的版本号，好让人确认连对了机器');
assert.deepEqual(routes, ['GET /api/info'], '探概况只读 /api/info，不多发请求');

const snap = await LAN.lanPullSnapshot(pair);
assert.equal(snap.format, 'legacy-data-json', '电脑端 /api/state 给的是裸 data.json，靠同步层的老格式兼容接住');
assert.deepEqual(snap.data.tasks.map((t) => t.id), ['t1', 't2']);
assert.deepEqual(routes, ['GET /api/info', 'GET /api/state']);

await assert.rejects(() => LAN.lanInfo({ base: 'http://192.168.1.5:27123', token: '错的码' }), /配对码不对/);
await assert.rejects(() => LAN.lanInfo({ base: 'http://192.168.1.5:9999', token: TOKEN }), /没在跑本程序/);
info = { ...info, dataOk: false };
await assert.rejects(() => LAN.lanInfo(pair), /数据文件读不出来/);
info = { ...info, dataOk: true, savedAtEpoch: null };
assert.equal((await LAN.lanInfo(pair)).savedAt, '', '拿不到 mtime 时不硬造时间');
info = { ...info, savedAtEpoch: 1760000000 };

/* ── ③ 回传：POST 换 pending → 轮询到终端态才算成败 ──
   这是整条链路唯一会让用户以为「已经同步好了」的地方，四种结局都要走一遍。 */
const SNAPSHOT = { format: 'le-time-management-sync', schema: 1, appVersion: '9.9.9', exportedAt: '2026-09-19T00:00:00.000Z', data: { tasks: [{ id: 'm1' }], blocks: [] } };
routes.length = 0; received.length = 0; pushScript = [{ status: 'pending' }, { status: 'accepted' }];
const stages = [];
const out = await LAN.lanPushSnapshot(pair, SNAPSHOT, { onStage: (s) => stages.push(s), pollMs: 1 });
assert.equal(out.status, 'accepted');
assert.deepEqual(routes, ['POST /api/push', 'GET /api/push-status', 'GET /api/push-status'], '一次 POST，之后每轮询一次问一次结果');
assert.deepEqual(received[0].data.tasks.map((t) => t.id), ['m1'], 'POST 的 body 就是快照本体，不能被中途改形');
assert.equal(stages.length, 3, '上传 → 等确认 → 已接收，三个阶段各回显一次（等确认那句只说一次，不刷屏）');
assert.match(stages[0], /发到电脑/);
assert.match(stages[1], /等电脑上点/, '卡在等确认时必须有回显，否则看着像按钮坏了');
assert.match(stages[2], /已接收/);

pushScript = [{ status: 'rejected', note: '电脑端已经在处理更新的一次推送（p9）' }];
await assert.rejects(() => LAN.lanPushSnapshot(pair, SNAPSHOT, { pollMs: 1 }), /更新的一次推送/, '被更新的推送顶掉要说清，不然人以为是自己点错了');

pushScript = [];   // 电脑端一直 pending = 没人点
const timeoutMsg = await LAN.lanPushSnapshot(pair, SNAPSHOT, { pollMs: 1, waitMs: 40 }).then(() => '', (e) => e.message);
assert.match(timeoutMsg, /没人确认/, '等满要自己作废，不能让手机无限转圈');
assert.match(timeoutMsg, /没动/, '超时文案要讲明电脑上那份没被改，人才敢放手');

info = { ...info, allowPush: false };
await assert.rejects(() => LAN.lanPushSnapshot(pair, SNAPSHOT, { pollMs: 1 }), /允许手机推回本机/, '开关没开时把电脑端那句指引原样带到');
info = { ...info, allowPush: true };
noPushRoute = true;
await assert.rejects(() => LAN.lanPushSnapshot(pair, SNAPSHOT, { pollMs: 1 }), /版本太旧/, '老电脑没这条路由，不能报「没在跑本程序」那种误导性错误');
noPushRoute = false;

/* ── ④ 电脑端服务：默认关、开了也只进内存、绝不写盘 ── */
const lan = read('../src-tauri/src/lan.rs');
assert.match(lan, /&tiny_http::Method::Get, "\/api\/info"/, '/api/info 必须是 GET');
assert.match(lan, /"savedAtEpoch": saved_at/);
assert.match(lan, /"dataOk": parsed\.is_some\(\)/, '数据文件读不出来时要如实说，别让手机拉到一份空数据');
assert.match(lan, /"allowPush": allow_push/, '概况要带上肯不肯收回传，手机才能提前把按钮摆对');
assert.match(lan, /if !allow_push \{[\s\S]{0,160}\(\s*403/, '开关关着时 /api/push 必须 403，网络上等于没有这条路');
assert.match(lan, /"status": "pending", "id": id/, 'POST 立即回 pending：tiny_http 单线程，阻塞等确认会把遥控页一起卡死');
assert.match(lan, /app\.emit\("lan-push-incoming", meta\)/, '要靠桌面端确认门点头，Rust 自己不决定');
assert.doesNotMatch(lan, /fs::write|File::create/, 'lan.rs 里出现写盘就是假同步：前端内存里那份会把它盖掉');
assert.match(lan, /PUSH_MAX_BYTES/, '请求体必须有上限，否则拿配对码发一条巨型 body 就能吃穿内存');
assert.match(lan, /take\(limit \+ 1\)/, '超限要能被判出来，不能悄悄截断成半份数据');
assert.match(lan, /唯一的常规写入口是 \/api\/command/, '顶部注释要讲清边界与三道门，否则下一个人会"顺手"把确认门拆了');

const lib = read('../src-tauri/src/lib.rs');
assert.match(lib, /fn lan_start\([\s\S]{0,160}allow_push: bool/, '回传开关要一路传到服务线程');
assert.match(lib, /lan_push_take,\s*\n\s*lan_push_resolve,/, '两个命令都得注册进 invoke_handler');

const apiSrc = read('../src/api.js');
assert.match(apiSrc, /invoke\("lan_start", \{ port, token, allowPush \}\)/, '前端传的开关不能在半路丢掉');
assert.match(apiSrc, /async lanStart\(port, token, allowPush = false\)/, '不传就是关：默认值必须倒向安全那一侧');

/* ── ⑤ 手机侧引导卡：先探后拉、推也要探、覆盖前留恢复点、配对码不落盘 ── */
assert.match(cardSrc, /const pullBtn = el\("button", \{[^}]*disabled: true/, '没连上之前「拉回本机」必须是锁着的');
assert.match(cardSrc, /const pushBtn = el\("button", \{[^}]*disabled: true/, '没连上之前「推到电脑」同样必须是锁着的');
assert.match(cardSrc, /pullBtn\.disabled = false/, '探到电脑概况后才解锁');
assert.match(cardSrc, /target = null;\s*\n\s*seen = null;\s*\n\s*pullBtn\.disabled = true;\s*\n\s*pushBtn\.disabled = true/, '连接失败要把两个按钮一起锁回去');
assert.match(cardSrc, /if \(!seen\.allowPush\)/, '电脑端没开开关时推按钮要一直灰着，并说明为什么');
assert.match(cardSrc, /createAutoBackup\("局域网拉回前"/, '局域网覆盖本机前先存恢复点');
assert.match(cardSrc, /createAutoBackup\("扫码自动同步前"/, '扫码自动同步覆盖本机前先存恢复点');
assert.match(cardSrc, /await pullToLocal\(\{ fromScan: true \}\)/, '扫码配对成功后自动拉取电脑数据');
assert.match(cardSrc, /createAutoBackup\("从网盘拉回前"/, '网盘那条同样要先存恢复点');
assert.match(cardSrc, /lanCfg\.host = next\.base\.replace/, '只记地址');
assert.match(cardSrc, /const scanBtn = !isDesktop && canScanQr\(\)/, '扫码按钮只在有相机的端上出现（桌面端 WebView 不是安全上下文，没有 mediaDevices）');
assert.match(cardSrc, /\} catch \(e\) \{ fail\(e\); \}/, '粘贴与扫码两条入口失败后要走同一套「把按钮锁回去」的路径');
assert.match(cardSrc, /lanPushSnapshot\(target, makeSnapshot\(mine, appVersion\)/, '推出去的是同步层那份带版本与时间戳的快照，不是裸 state');
assert.match(cardSrc, /电脑上会先弹一个确认框/, '手机侧文案要讲明「点了推送不等于已经同步」');
assert.match(cardSrc, /默认是关的/, '双向文案不能再让人以为电脑随时会被改');
assert.doesNotMatch(cardSrc, /只能「手机拉电脑」/, '旧的单向文案已经过期，留着会误导');
/* v0.67.0 开发中真踩到的一次：卡片里写了 info?.os，而 info 是 settings.js 的模块级变量，
 * 引导卡当场抛错 → 整个设置页空白。卡片模块只许用传进来的参数。
 * 用子串断言而非正则：这条守卫的字面量里全是点号问号，正则转义一坏就退化成永远通过的假断言。 */
assert.equal(cardSrc.includes("info?."), false, "sync.js 里不许出现 info —— 那是 settings.js 的模块级变量，卡片拿不到（拿到了就是整页空白）");
assert.equal(cardSrc.includes("info.version"), false);
assert.ok(cardSrc.includes('appVersion = "", os = ""'), "os 必须由 settings.js 显式传进来");
for (const cls of new Set([...cardSrc.matchAll(/sync-[a-z-]+/g)].map((m) => m[0]))) {
  const styles = read('../src/styles.css');
  assert.match(styles, new RegExp(`\\.${cls}[\\s,{:]`), `styles.css 里没有 .${cls} 这条规则`);
}

/* ── ⑥ 电脑端确认门：备份 → 落盘 → 回执，一步都不能少 ── */
const gate = read('../src/lanPushGate.js');
assert.match(gate, /listen\("lan-push-incoming"/, '要接住 Rust 广播，不能靠轮询');
// 顺序断言：恢复点必须落在覆盖之前，回执必须落在覆盖之后 —— 反了就是丢数据或手机空转
assert.match(gate, /createAutoBackup\("局域网回传前"[\s\S]*?replaceAll\([\s\S]*?saveNow\(\)[\s\S]*?lanPushResolve\(id, true,/,
  '先存恢复点再覆盖，覆盖成功才回「已接收」');
// 回执都要带原因：手机侧要能分清「电脑上没人确认」与「电脑上真有人点了拒绝」
assert.match(gate, /lanPushResolve\(id, false, expired \? "电脑上没人确认，自动取消了" : "电脑上点了「拒绝」"\)/,
  '自动取消与人工拒绝要分开报，不然用户以为有人在动他数据');
assert.match(gate, /const expired = Date\.now\(\) > until - 2000/, '到点自动取消要按时间判，不能靠猜');
assert.match(gate, /lanPushResolve\(id, false, `电脑上没能导入：/, '导入失败也要把原因带回手机，别让人对着转圈的界面干等');
assert.match(read('../src-tauri/src/lan.rs'), /pub note: String/, '暂存槽要存得下拒绝原因');
assert.match(read('../src/api.js'), /async lanPushResolve\(id, approve, note = ""\)/, '回执通道要带上原因这一路');
assert.match(gate, /const LOCAL_ONLY_SETTINGS = \[[^\]]*"lanToken"[^\]]*\]/,
  '本机的联动凭据不能被手机那份换掉：正在跑的服务用的是电脑这个 token');
assert.match(gate, /GATE_TIMEOUT_MS = LAN_PUSH_WAIT_MS \+ 8000/, '电脑端比手机多等一会，让手机先报「没人确认」而不是弹窗先消失');
assert.match(gate, /timeoutMs: GATE_TIMEOUT_MS/, '弹窗必须带倒计时：没人点就是没同意');
assert.match(read('../src/views/settings.js'), /api\.lanStart\(st\.lanPort, st\.lanToken, st\.lanPush\)/,
  '改完开关要带新值重启服务，否则界面上开着、网络上其实还关着');
assert.match(read('../src/main.js'), /api\.lanStart\(Number\(st\.lanPort\), st\.lanToken, Boolean\(st\.lanPush\)\)/,
  '自启动也要把开关传下去，不然重启一次电脑回传就悄悄失效了');

console.log('PASS: 局域网直连（配对链接解析 / 只读探测与拉取 / 回传两段式四种结局 / 电脑端默认关且只进内存 / 确认门先备份后落盘 / 手机侧按钮锁到探过为止）');
