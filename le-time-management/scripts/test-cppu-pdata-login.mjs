// 个人成长中心（pdata.cppu.edu.cn）的自动登录与「和警大通知互通登录状态」。
//
// 用户口径：两个站点账号密码相同，登一次应该两边都算登过。
// 事实是它们共用同一套统一身份认证（sso.cppu.edu.cn）：
//   · 通知侧登录成功后留下 CASTGC（rememberMe 保 5 天）+ 一份密码（vault "secret"）；
//   · pdata 侧不发会话 Cookie，只用「主 SSO 的票」换自己的 token。
// 所以互通 = 复用同一份会话票据与同一份账号密码，而不是再存一份 pdata 专用凭据。
//
// 本测试盯三件容易悄悄退回去的事：
//   ① 冷启动直接进成长中心/一卡通时，必须先把通知存下的票据灌回本会话再换票；
//   ② 票据全失效时必须能用通知那份账号密码自动登一次，而不是甩一句「请先登录」；
//   ③ 网页窗口必须带会话打开（宿主 openPdataPage 注入 sso + pdata 两个域），
//      且只对 pdata.cppu.edu.cn/stu/** 放行。
import { readProductSource } from "./lib/read-product-source.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = readProductSource(new URL('../public/plugins/cppu-notify/main.js', import.meta.url), 'utf8');
const PDATA_TICKET_RE = /^https:\/\/sso\.cppu\.edu\.cn\/tpass\/login\?service=https%3A%2F%2Fpdata\.cppu\.edu\.cn/;
const LOGIN_URL = 'https://sso.cppu.edu.cn/tpass/login?service=https%3A%2F%2Fsso-jw.cppu.edu.cn%2Ftpass%2Fbridge';

const log = [];
let response = () => ({ status: 404, body: '' });
const vaultData = {}, storageData = {}, opened = [];
const notices = [];

const context = vm.createContext({
  URL, Set, Map, Date, console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { createElement: () => ({ set innerHTML(x) { this.value = x; } }), querySelectorAll: () => [] },
  // 解码不了的验证码图 = OCR 认不出来，用来把「换票 → 自动登录」这条链逼到失败分支
  Image: class { constructor() { this.naturalWidth = 0; this.naturalHeight = 0; } set src(v) { this._src = v; } decode() { return Promise.reject(new Error('cannot decode')); } },
  tide: {
    ui: { registerView: () => {} },
    http: {
      session: async () => { log.push('session'); return 's1'; },
      restoreCookies: async (dump) => { log.push('restore'); return dump?.length ? 'restored-sid' : null; },
      fetch: async (sid, method, url, opts) => { log.push('fetch ' + url); return response(sid, method, url, opts || {}); },
    },
    storage: {
      set: async (k, v) => { storageData[k] = v; },
      get: async (k, d) => (k in storageData ? storageData[k] : (d === undefined ? null : d)),
    },
    vault: {
      get: async (key) => vaultData[key] ?? null,
      set: async (key, value) => { vaultData[key] = value; },
      del: async (key) => { delete vaultData[key]; },
    },
    util: {
      openUrl: (url) => opened.push(['url', url]),
      openPdataPage: (url, sid) => { opened.push(['pdata', url, sid || '']); return Promise.resolve(); },
    },
    notify: (message) => notices.push(message),
  },
});

const exported = 'state,pdataApi,ensurePdataAuth,dropPdataAuth,loadPdataAuth,openPdataLink,clearSavedLogin,newSession,restoreCookies,silentRenew,passwordAutoLogin';
vm.runInContext(
  source.replace('  tide.ui.registerView({', `  globalThis.testApi = {${exported}};\n  tide.ui.registerView({`),
  context,
);
const api = context.testApi;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ── ① 冷启动：票据只在密钥库里，没先打开通知界面 ── */
await api.dropPdataAuth();
vaultData.cookies = JSON.stringify([{ url: 'https://sso.cppu.edu.cn/', cookie: 'CASTGC=abc' }]);
response = (sid, method, url) => {
  if (PDATA_TICKET_RE.test(url)) return { status: 302, location: 'https://pdata.cppu.edu.cn/stu/home/?ticket=ST-1' };
  if (/\/tsa\/validateLogin\?ticket=ST-1/.test(url)) return { status: 200, body: JSON.stringify({ code: 2000, data: { token: 'TK-1', userId: '2025290058' } }) };
  if (/\/tsa\/pdp\/consume\/cardInfo/.test(url)) return { status: 200, body: JSON.stringify({ code: 2000, data: { yktye: '88.50' } }) };
  return { status: 404, body: '' };
};

const cold = await api.pdataApi('/tsa/pdp/consume/cardInfo');
assert.equal(cold.ok, true, '密钥库里还有通知留下的票据时，成长中心必须能自己换到票');
assert.equal(cold.data.yktye, '88.50');
assert.equal(context.testApi.state.sid, 'restored-sid', '换票用的必须是恢复回来的那个会话，而不是新开的空会话');
assert.ok(
  log.indexOf('restore') < log.findIndex((l) => l.startsWith('fetch ') && PDATA_TICKET_RE.test(l.slice(6))),
  '恢复票据必须发生在要票之前，否则冷启动第一次换票永远失败',
);
const ticketCall = log.find((l) => l.startsWith('fetch ') && PDATA_TICKET_RE.test(l.slice(6)));
assert.ok(ticketCall, '必须真的去主 SSO 要过一次 pdata 的票');
assert.match(String(vaultData.pdataToken || ''), /TK-1/, '换到的 token 只落密钥库');
assert.equal(log.some((l) => l.startsWith('fetch https://pdata.cppu.edu.cn/stu/home/')), false, '换票只看 Location，绝不能把一次性票消费掉');

/* ── ② 票据全失效 + 通知里存过账号密码：必须自己登一次，而不是甩「请先登录」 ── */
await api.dropPdataAuth();
delete vaultData.cookies;
delete vaultData.pdataToken;
vaultData.secret = JSON.stringify({ password: 'pw-shared' });
storageData.username = '2025290058';
storageData.autoLogin = true;
storageData.loginRetries = 0; // 不跑退避等待，测试只关心链路走到哪一步
log.length = 0;
response = (sid, method, url, opts) => {
  if (PDATA_TICKET_RE.test(url)) return { status: 302, location: LOGIN_URL };
  if (url === LOGIN_URL) return opts.followRedirects === false ? { status: 302, location: LOGIN_URL } : { status: 200, body: '<input name="execution" value="EX1">' };
  if (/\/tpass\/login\?service=https%3A%2F%2Fsso-jw/.test(url)) return { status: 302, location: LOGIN_URL };
  if (/\/tpass\/captcha\.jpg/.test(url)) return { status: 200, body: 'AAAA' };
  return { status: 404, body: '' };
};

const dead = await api.pdataApi('/tsa/pdp/consume/cardInfo');
assert.equal(dead.ok, false);
assert.match(dead.message, /先在「警大通知」里登录一次/, '整条链都失败时才提示人工登录，且要指向通知插件');
assert.equal(context.testApi.state.username, '2025290058', '账号必须取自通知保存的那一份（storage: username）');
assert.equal(context.testApi.state.savedPassword, 'pw-shared', '密码必须取自通知保存的那一份（vault: secret）');
assert.ok(
  log.some((l) => /\/tpass\/captcha\.jpg/.test(l)),
  '有通知那份账号密码时必须真的走一次「密码 + 验证码识别」自动登录，而不是直接放弃',
);
assert.equal(opened.length, 0, '取数阶段不该弹任何网页窗口');

/* ── ③ 开网页：带会话交给宿主窗口，且只在有会话时注入 ── */
log.length = 0;
opened.length = 0;
await api.newSession();
await api.openPdataLink('/stu/dataReport/consumption');
assert.deepEqual(opened[0], ['pdata', 'https://pdata.cppu.edu.cn/stu/dataReport/consumption', 's1'],
  '成长中心的网页必须带本插件会话在应用内窗口打开，窗口里的 SPA 才能免登');
await api.openPdataLink('https://evil.invalid/stu/home/');
assert.deepEqual(opened[1], ['pdata', 'https://pdata.cppu.edu.cn/stu/home/', 's1'],
  '外链必须折回 pdata 首页：会话不能被带去非 pdata 地址');

/* ── ④ 冷启动但密钥库里已有 pdata 的票：ensurePdataAuth 会直接短路，
       整条链路上没人建过会话 —— 取数层必须自己补一个，否则 invoke("http_fetch")
       收到的 sid 是 null，被 Rust 侧挡回来：
       invalid args `sid` for command `http_fetch`: invalid type: null, expected a string */
log.length = 0;
context.testApi.state.sid = null; // 模拟「本次进程还没建过会话」
vaultData.pdataToken = JSON.stringify({ token: 'TK-2', userId: '2025290058', at: Date.now() });
response = (sid, method, url) => {
  if (url.startsWith('https://pdata.cppu.edu.cn/tsa/shc/')) return { status: 200, body: JSON.stringify({ code: 2000, data: { yktye: '12.00' } }) };
  return { status: 404, body: '' };
};
const fromVault = await Promise.all([
  api.pdataApi('/tsa/shc/homepage/personInfo'),
  api.pdataApi('/tsa/shc/learnInfo/learnSituation'),
  api.pdataApi('/tsa/shc/homepage/getKpiList'),
]);
for (const one of fromVault) assert.equal(one.ok, true, '密钥库里的票还能用时，冷启动不该因为「没有会话」而整页报「个人成长中心暂时不可用」');
assert.equal(context.testApi.state.sid, 's1', '取数前必须自己建一个会话，不能把 sid=null 交给 http_fetch');
assert.equal(log.filter((l) => l === 'session').length, 1, '成长页首屏 8 个接口并发，会话只能建一个');

/* ── ⑤ 重新登录 / 清除凭据后，旧 token 不能留在密钥库里 ── */
vaultData.pdataToken = JSON.stringify({ token: 'TK-STALE', userId: '2025290058', at: 1 });
await api.clearSavedLogin();
await flush();
assert.equal(vaultData.pdataToken, undefined, '清除凭据必须连 pdata 的 token 一起清，否则下个人接着用上个人的数据');

/* ── ⑥ 源码级接线：链路的每一步都必须在文件里，而不是只在这份测试里 ── */
assert.match(source, /function forgetPdataAuth\(\)/, 'finishPortalTicket / clearSavedLogin 共用的失效钩子不能丢');
assert.match(source, /if \(direct\) \{ state\.token = direct; forgetPdataAuth\(\); return true; \}/, '门户会话重建时必须让 pdata 的票失效');
assert.match(source, /async function exchangePdataToken\(\)/, '换票 + 消费票 + 落库必须是同一步，供三条回落路径复用');
assert.match(source, /await restoreCookies\(\);\s*\n\s*await newSession\(\);/, '换票前必须先恢复通知留下的会话票据');
assert.match(source, /const sid = await ensureSid\(\);\s*\n\s*if \(!sid\)/, '取数入口要自己兜会话：sid 为空时宁可直接报错，也不能把 null 交给 http_fetch');
assert.match(source, /if \(await silentRenew\(\)\) \{/, '票据过期但 CASTGC 还在时要走静默续期');
assert.match(source, /if \(await passwordAutoLogin\(\)\) \{/, '主 SSO 也没了时要用通知那份账号密码自动登一次');
assert.match(source, /tide\.util\.openPdataPage\(url, state\.sid\)/, '网页窗口必须走带会话的宿主 API');

const host = fs.readFileSync(new URL('../src/pluginHost.js', import.meta.url), 'utf8');
assert.match(host, /openPdataPage: \(url, sid = ""\) => \{/, '宿主必须提供 util.openPdataPage');
assert.match(host, /if \(pid !== "cppu-notify"\) throw new Error\("个人成长中心网页窗口仅对警大插件开放"\)/, '会话注入必须限定插件');
assert.match(host, /if \(sid\) requirePermission\(man, pid, "http"\);/, '带会话打开要 http 权限');

const apiSource = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
assert.match(apiSource, /async openPdataPage\(url, sid = ""\)/);
assert.match(apiSource, /parsed\.origin !== "https:\/\/pdata\.cppu\.edu\.cn"[\s\S]{0,80}!parsed\.pathname\.startsWith\("\/stu\/"\)/, '只放行 pdata 官方 /stu/ 页面');

const manifest = JSON.parse(fs.readFileSync(new URL('../public/plugins/cppu-notify/manifest.json', import.meta.url), 'utf8'));
for (const perm of ['openUrl', 'http']) assert.ok(manifest.permissions.includes(perm), `manifest 必须声明 ${perm}`);

const rust = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
assert.match(rust, /fn is_cppu_pdata_host\(host: &str\) -> bool \{/, '宿主白名单要有个人成长中心');
assert.match(rust, /fn is_cppu_sso_host\(host: &str\) -> bool \{/, '统一身份认证域必须一起放行，否则窗口里换不到票');
assert.match(rust, /"https:\/\/sso\.cppu\.edu\.cn\/"\.to_string\(\)/, 'sso 必须进 Cookie 取用清单');
assert.match(rust, /Self::Pdata => is_cppu_pdata_host\(host\) \|\| is_cppu_sso_host\(host\) \|\| is_cppu_root_domain\(host\)/, 'CASTGC 常以 Domain=.cppu.edu.cn 下发，根域要放行');
assert.match(rust, /if !site\.allows_host\(host\) \{ continue; \}/, '取 Cookie 必须问当前站点自己的白名单，不能写死学习通');
assert.doesNotMatch(rust, /if !is_chaoxing_host\(host\) \{ continue; \}/, '写死学习通会让邮箱与成长中心一个 Cookie 都收不到');

console.log('PASS: pdata 自动登录（复用通知会话票据与账号密码）、网页带会话打开、宿主白名单与 Cookie 作用域');
