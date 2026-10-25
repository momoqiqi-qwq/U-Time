/* 警大邮箱（cppu-notify）三条行为：最新在前 / 分页取全 / 验证码自动复制。
   跑的是产品里那份真 main.js（vm 里加载），fixture 是真实 coremail 报文形状。 */
import { readProductSource } from "./lib/read-product-source.mjs";
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';

const source = readProductSource(new URL('../public/plugins/cppu-notify/main.js', import.meta.url), 'utf8');
const viewSource = readProductSource(new URL('../public/plugins/cppu-notify/mail.js', import.meta.url), 'utf8');

/* ── 最小 DOM：邮箱 XML 走 DOMParser，剪贴板兜底走 textarea ── */
const XML_ENT = { quot: '"', lt: '<', gt: '>', amp: '&', apos: "'" };
const xmlDecode = (s) => s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return XML_ENT[e] ?? m;
});
class XEl {
  constructor(tag) { this.tagName = tag; this.attributes = []; this.children = []; this.text = ''; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  querySelector() { return null; }
}
class MiniDOMParser {
  parseFromString(text) {
    const root = new XEl('#doc');
    const stack = [root];
    const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      if (m[2]) {
        const el = new XEl(m[2]);
        const ar = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = ar.exec(m[3] || ''))) el.attributes.push({ name: a[1], value: xmlDecode(a[3] ?? a[4] ?? '') });
        stack[stack.length - 1].children.push(el);
        if (!m[4]) stack.push(el);
        continue;
      }
      if (m[5] && m[5].trim()) stack[stack.length - 1].text += xmlDecode(m[5]);
    }
    return { documentElement: root.children[0], querySelector: () => null };
  }
}

let calls = [], vaultData = {}, storageData = {}, notices = [], mounted = [], copies = [], views = [];
/* cleanText() 靠 `<textarea>.innerHTML = x` 再读 `.value` 解实体，替身也必须这样联动，
   否则主题/发件人会被洗成空串（真跑时看不出，只有断言会红）。 */
const el = (tag) => ({
  tag, style: {}, value: '', attrs: {},
  set innerHTML(v) { this.value = String(v); },
  get innerHTML() { return this.value; },
  setAttribute(k, v) { this.attrs[k] = v; }, select() { this.selected = true; }, setSelectionRange() {}, remove() { this.removed = true; },
});
const context = vm.createContext({
  URL, Set, Map, Date, console, setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: globalThis.crypto, btoa: globalThis.btoa, TextEncoder, URLSearchParams, DOMParser: MiniDOMParser,
  document: {
    createElement: (tag) => el(tag),
    createTextNode: (t) => ({ text: t }),
    head: { append() {} },
    querySelector: () => ({ append: (node) => mounted.push(node) }),
    querySelectorAll: () => [],
    execCommand: (cmd) => { const last = mounted[mounted.length - 1]; if (last) copies.push(last.value); return cmd === 'copy'; },
  },
  tide: {
    ui: { registerView: (def) => views.push(def) },
    http: { session: async () => 's1', restoreCookies: async () => 's1', fetch: async (...args) => { calls.push(args); return response(...args); } },
    storage: { set: async (k, v) => { storageData[k] = v; }, get: async (k, d) => (k in storageData ? storageData[k] : (d === undefined ? null : d)) },
    vault: { get: async (k) => vaultData[k] || null, set: async (k, v) => { vaultData[k] = v; }, del: async (k) => { delete vaultData[k]; } },
    notify: (message) => notices.push(message),
    util: {
      openUrl() {}, openMailPage() {}, openSettings() {},
      web: { formEncode: (fields) => Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') },
    },
    assets: { saveBase64: async () => '', revealSaved: async () => ({ ok: true }) },
  },
});
const expose = 'state,mailBridge,mailSortNewest,mailTime,mailCodeOf,mailCodeCandidate,mailScanCodes,mailCopyCode,copyPlainText,mailMessage,mountMailView';
vm.runInContext(source.replace('  tide.ui.registerView({', `  globalThis.testApi = {${expose}};\n  tide.ui.registerView({`), context);
const { state, mailBridge, mailSortNewest, mailTime, mailCodeOf, mailCodeCandidate, mailScanCodes, mailCopyCode, copyPlainText, mailMessage, mountMailView } = context.testApi;

/* ── 1. 时间解析与倒序 ── */
assert.equal(mailTime('2025-08-24 14:48:37'), new Date('2025-08-24T14:48:37').getTime(), '带空格的时间按本地时间解析');
assert.equal(mailTime('2025-08-24T14:48:37'), mailTime('2025-08-24 14:48:37'), 'ISO 与空格两种写法必须等价');
assert.equal(mailTime(1724568000), 1724568000000, '10 位秒级时间戳要按秒算，不能当毫秒');
assert.equal(mailTime(1724568000000), 1724568000000, '13 位毫秒时间戳原样用');
assert.equal(mailTime('昨天下午'), null, '解析不出来必须返回 null，不许瞎猜一个时间');
assert.equal(mailTime(undefined), null);

const sorted = mailSortNewest([
  { id: 'a', date: '2025-08-15 03:05:44' },
  { id: 'b', date: '2025-08-24 14:48:37' },
  { id: 'c', date: null },
  { id: 'd', date: '2025-08-20 09:00:00' },
  { id: 'e', date: '' },
]);
assert.deepEqual(sorted.map((r) => r.id), ['b', 'd', 'a', 'c', 'e'], '时间倒序、最新在前，认不出时间的两封垫底并保持原序');
const ties = mailSortNewest([{ id: 'x1', date: '2025-08-20 09:00:00' }, { id: 'x2', date: '2025-08-20 09:00:00' }]);
assert.deepEqual(ties.map((r) => r.id), ['x1', 'x2'], '同一时刻保持服务端原序（稳定排序）');

/* ── 2. 验证码识别：正例与反例 ── */
assert.equal(mailCodeOf('【校园信息】您的验证码是 483920，5 分钟内有效'), '483920');
assert.equal(mailCodeOf('验证码：8831'), '8831');
assert.equal(mailCodeOf('Your verification code is 5127. Do not share it.'), '5127');
assert.equal(mailCodeOf('one-time code 774233'), '774233');
assert.equal(mailCodeOf('动态码 a1b2c3，请勿外传'), 'A1B2C3', '字母数字混合取大写');
assert.equal(mailCodeOf('您的验证码是 2025'), '', '四位纯数字恰好是年份形状时不当验证码');
assert.equal(mailCodeOf('您的订单 20250815 已发货'), '', '没有验证码关键词就不认');
assert.equal(mailCodeOf(''), '');
assert.equal(mailCodeCandidate('编号 2025 年'), '', '年份候选一律排除');
assert.equal(mailCodeCandidate('工单 ZX8812'), 'ZX8812');

/* ── 3. 真链路：中间件 RSA 登录 → 落地页换 sid → /js6/s 取信 ── */
const rsaKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const nHex = Buffer.from(rsaKeys.publicKey.export({ format: 'jwk' }).n, 'base64url').toString('hex').padStart(256, '0');
const MAIL_PUB_HEX = '30819f300d06092a864886f70d010101050003818d0030818902818100' + nHex + '0203010001';
const stamp = (msAgo) => {
  const d = new Date(Date.now() - msAgo);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const XML_FOLDERS = '<?xml version="1.0" encoding="UTF-8"?><result><code>S_OK</code><array name="var">'
  + '<object><int name="parent">0</int><object name="stats"><int name="messageCount">142</int>'
  + '<int name="unreadMessageCount">73</int></object><int name="id">1</int><string name="name">收件箱</string></object>'
  + '</array></result>';
/* 服务端段内顺序不可信：这里刻意按「越靠后越早」给（index 0 是这一页里最旧的）。 */
const listXml = (start, limit) => {
  let out = '<?xml version="1.0" encoding="UTF-8"?><result><code>S_OK</code><array name="var">';
  for (let i = 0; i < limit; i++) {
    const seq = start + i;
    out += '<object><int name="fid">1</int>'
      + `<string name="subject">第 ${seq} 封</string>`
      + '<string name="from">系统 &lt;sys@cppu.edu.cn&gt;</string>'
      + `<string name="id">m${seq}</string>`
      + `<date name="sentDate">${stamp((limit - i) * 60000)}</date>`
      + '<int name="size">100</int><object name="flags"><boolean name="read">true</boolean></object></object>';
  }
  return out + '</array></result>';
};
const MAIL_DOOR = '<html><head><META HTTP-EQUIV=REFRESH CONTENT="0; URL=x"></head><body><script>'
  + 'window.location.replace("https://mail.cppu.edu.cn/redirect?l=https%3A%2F%2Fmail.cppu.edu.cn%2Fjs6%2Fmain.jsp'
  + '%3Fsid%3Dmail-sid%26show_window%3D0&sid=mail-sid");</script></body></html>';

vaultData.secret = JSON.stringify({ password: 'mail-pass' });
// 邮箱账号由本机登录学号推导（源码里不写死某个人的邮箱），先喂一份给 state。
storageData.username = '2025000001';
state.username = '2025000001';
state.autoLogin = true; state.savedPassword = '';
let response = () => ({ status: 404, finalUrl: '', body: '' });
response = (sid, method, url) => {
  if (method === 'GET' && url === 'https://mailuser.cppu.edu.cn/sync/mail/pubkey') {
    return { status: 200, finalUrl: url, body: 'pubSetting={"pubKey":"' + MAIL_PUB_HEX + '"}' };
  }
  if (method === 'POST' && url === 'https://mailuser.cppu.edu.cn/cppu/api/login') {
    return { status: 200, finalUrl: url, body: JSON.stringify({ state: true, location: 'https://entryhz.qiye.163.com/entry/door?hl=zh_CN' }) };
  }
  if (method === 'GET' && url.includes('entryhz.qiye.163.com/entry/door')) return { status: 200, finalUrl: url, body: MAIL_DOOR };
  if (method === 'GET' && url.includes('/redirect?l=')) {
    return { status: 302, finalUrl: 'https://mail.cppu.edu.cn/js6/main.jsp?sid=mail-sid', location: 'x', body: '' };
  }
  if (method === 'GET' && url.includes('/js6/s') && url.includes('getAllFolders')) {
    return { status: 200, finalUrl: url, body: XML_FOLDERS };
  }
  if (method === 'GET' && url.includes('/js6/s') && url.includes('listMessages')) {
    const q = new URL(url).searchParams;
    return { status: 200, finalUrl: url, body: listXml(Number(q.get('start') || 0), Number(q.get('limit') || 20)) };
  }
  /* 正文：content 是转义过的 HTML（真接口就是这样），要能摊成纯文本 */
  if (method === 'GET' && url.includes('/js6/s') && url.includes('getMessage')) {
    const q = new URL(url).searchParams;
    const id = q.get('id') || '';
    return {
      status: 200, finalUrl: url,
      body: '<?xml version="1.0" encoding="UTF-8"?><result><code>S_OK</code><object name="var">'
        + `<string name="subject">第 ${id.replace(/\D/g, '')} 封</string>`
        + '<string name="from">系统 &lt;sys@cppu.edu.cn&gt;</string>'
        + `<date name="sentDate">${stamp(60000)}</date>`
        + '<string name="content">&lt;div&gt;第一行正文&lt;/div&gt;&lt;div&gt;验证码 483920&lt;/div&gt;&lt;div&gt;&amp;nbsp;&lt;/div&gt;&lt;div&gt;教务处&lt;/div&gt;</string>'
        + '</object></result>',
    };
  }
  return { status: 404, finalUrl: url, body: '' };
};

/* ── 4. 首屏：最新必须排第一，并且带未读/总数 ── */
context.testApi.state.sid = '';
const first = await mailBridge.load();
assert.equal(first.ok, true, '邮箱自动登录要能跑通：' + first.error);
assert.equal(first.unread, 73);
assert.equal(first.total, 142);
assert.equal(first.mails.length, 20);
assert.equal(first.hasMore, true, '刚好满一页时 hasMore 必须为真，否则「加载更早」永远不出现');
assert.ok(first.mails[0].date > first.mails[1].date, '首屏必须最新在前');
assert.equal(first.mails[0].id, 'm19', '服务端给的是最旧在前，插件必须自己翻过来');

/* ── 5. 分页：start/limit 必须真交给服务端，而不是本地切片 ── */
calls = [];
const second = await mailBridge.load({ start: 20, limit: 20 });
const listCall = calls.map((c) => c[2]).filter((u) => u.includes('listMessages')).pop();
const listQuery = new URL(listCall).searchParams;
assert.equal(listQuery.get('start'), '20', '第二页必须以 start=20 向服务端要，否则永远只有前 20 封');
assert.equal(listQuery.get('limit'), '20');
assert.equal(second.start, 20);
assert.equal(second.mails.length, 20);
assert.equal(second.mails[0].id, 'm39', '第二页同样要最新在前');
assert.equal(second.unread, undefined, '未读/总数只跟首屏走，翻页不必重复问文件夹统计');

/* ── 6. 后台轮询：一封新验证码只复制一次 ── */
storageData.mailAutoCopy = true;
delete storageData.mailCodeSeen;
const codeRows = [{
  id: 'code-1', subject: '【校园信息】您的验证码是 483920，5 分钟内有效',
  from: '校园信息中心 <noreply@cppu.edu.cn>', date: stamp(60 * 1000), size: 1024, read: false,
}];
copies = [];
const hit = await mailScanCodes(codeRows, null);
assert.ok(hit && hit.code === '483920', '主题里的验证码要认出来');
assert.equal(await mailCopyCode(hit), true, '剪贴板兜底通道必须能写入');
assert.deepEqual(copies, ['483920'], '复制到剪贴板的正是那串验证码');
assert.ok(storageData.mailCodeSeen.includes('code-1'), '复制过的邮件 id 要落盘，重启后不再重复复制');
assert.equal(await mailScanCodes(codeRows, null), null, '同一封不许复制第二次');
assert.deepEqual(copies, ['483920'], '第二轮不该再写一次剪贴板');

/* 15 分钟以外的不复制：那是历史信，不该在打开应用时把旧验证码糊进剪贴板 */
delete storageData.mailCodeSeen;
const oldRows = [{ id: 'code-old', subject: '验证码 998877', from: '旧系统', date: stamp(60 * 60 * 1000), size: 1, read: true }];
assert.equal(await mailScanCodes(oldRows, null), null, '超过 15 分钟的验证码不参与自动复制');
assert.deepEqual(copies, ['483920']);

/* 关掉开关就不做任何事 */
storageData.mailAutoCopy = false;
delete storageData.mailCodeSeen;
assert.equal(await mailScanCodes(codeRows, null), null, '「验证码自动复制」关掉后必须一个都不复制');
assert.equal(await mailBridge.autoCopy(), false);
await mailBridge.setAutoCopy(true);
assert.equal(await mailBridge.autoCopy(), true, '开关必须能开回来且落盘');

/* ── 7. 剪贴板不许挂 document.body（安全区测试拦这条） ── */
const bodyAppend = /document\.body\.(?:append|prepend|appendChild|insertAdjacent)/;
assert.doesNotMatch(source, bodyAppend, '离屏 textarea 要挂在插件容器里，挂 document.body 会逃出宿主安全区');

/* ── 8. 视图侧「再复制」通道 ── */
copies = [];
assert.equal(await mailBridge.copy('483920'), true);
assert.deepEqual(copies, ['483920']);
const last = mailBridge.lastCode();
assert.ok(last && last.code === '483920', '视图要能用 lastCode() 画出「已复制 · 再复制」');

/* ── 9. 卡片就地展开正文（v0.269.0）── */
calls = [];
const body1 = await mailBridge.body('m19');
assert.equal(body1.ok, true, '正文要能取到：' + body1.error);
assert.equal(body1.id, 'm19');
assert.match(body1.text, /第一行正文/, 'content 里的 HTML 要摊成文本再给界面');
assert.match(body1.text, /验证码 483920/);
assert.doesNotMatch(body1.text, /<div>/, '往页面里放的是纯文本，不许把 HTML 标签漏出去');
assert.equal(body1.truncated, false);
assert.equal(calls.filter((c) => c[2].includes('getMessage')).length, 1, '一封信只打一次接口');

calls = [];
const body2 = await mailBridge.body('m19');
assert.equal(body2.text, body1.text);
assert.equal(calls.filter((c) => c[2].includes('getMessage')).length, 0, '同一封第二次展开走缓存，不再请求');
assert.equal((await mailBridge.body('')).ok, false, '没有 id 就直接报错，不瞎请求');

/* 视图侧：整块信头是展开开关，跳邮箱只剩右上角那颗小按钮 */
assert.match(viewSource, /data-ml-toggle="\$\{id\}"/, '卡片本身要变成展开/收起的开关');
assert.match(viewSource, /class="ml-open"[^>]*data-ml-open="\$\{id\}"/, '「在邮箱打开」必须挂在卡片右上角的小按钮上');
assert.match(viewSource, /bridge\?\.body\?\.\(/, '展开正文要走 bridge.body(id)，不是 bridge.open()');
assert.doesNotMatch(viewSource, /class="ml-hit"[^>]*data-ml-open/, '信头不许再绑「打开邮箱」，否则点一下就跳出本页');
assert.match(viewSource, /在邮箱打开/, '按钮文案要写清楚');
assert.match(viewSource, /ml-text/, '展开区要有正文容器');

console.log('PASS: 邮箱 —— 最新在前 / 分页 start 真透传 / 验证码识别正反例 / 只复制一次 / 开关与再复制 / 卡片就地展开正文');
