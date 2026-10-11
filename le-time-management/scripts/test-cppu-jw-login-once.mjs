import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readProductSource } from './lib/read-product-source.mjs';

/* 回归：警大教务视图「登录失败后自动刷新两次」。
   选课视图有 2 个 key（选课任务 + 选课结果），jwEnsureKeys 是串行 for 循环，而每个 key 的
   jeLoad 都要先过一次 ensureJwLogin —— jwBootPromise 只合流「并发」，串行的后一个 key 拿不到
   合流，于是登录态失效时连着跑 N 轮完整登录（每轮内部还按 loginRetries 重试），
   界面上就表现为两个分区各挂一条「登录失败，正在显示缓存」。 */

const source = readProductSource(new URL('../public/plugins/cppu-notify/main.js', import.meta.url), 'utf8');
const SSO = 'https://sso.cppu.edu.cn';
// 登录页与换票桥是同一个 URL（LOGIN_URL = SSO + "/tpass/login?service=" + encodeURIComponent(JW + "/tpass/bridge")），
// 所以观测点取验证码与密钥库，而不是登录页 URL。
const LOGIN_URL = SSO + '/tpass/login?service=' + encodeURIComponent('https://sso-jw.cppu.edu.cn/tpass/bridge');

// 登录轮次的观测点：ensureJwLogin 的异步体第一句就是 loadPrefs()，而 loadPrefs 只在
// autoLogin 打开时读一次密钥库 —— 所以密钥库读取次数 = 登录轮次，且只在这一处发生。
function loadPlugin(code) {
  const store = { username: 'fixture-account', loginRetries: 0, autoLogin: true, rememberUsername: true, autoRefresh: false };
  const vault = { secret: JSON.stringify({ password: 'fixture-password' }) };
  const calls = { loginRounds: 0, captchas: 0 };
  const context = vm.createContext({
    URL, Date, Set, Map, Promise, console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { querySelectorAll: () => [], createElement: () => null },
    // 验证码识别链路在测试里必然失败：没有图像解码器 —— 这正是要复现的「登录失败」分支
    Image: class { set src(_value) {} async decode() { throw new Error('no image decoder in the test harness'); } },
    tide: {
      ui: { registerView() {} },
      storage: {
        async get(key, fallback) { return store[key] ?? fallback; },
        async set(key, value) { store[key] = structuredClone(value); },
      },
      vault: {
        async get(key) { if (key === 'secret') calls.loginRounds++; return vault[key] ?? null; },
        async set(key, value) { vault[key] = value; },
        async del(key) { delete vault[key]; },
      },
      http: {
        async session() { return 'sid-fixture'; },
        async restoreCookies() { return ''; },
        async exportCookies() { return []; },
        async getCached() { return null; },
        // 只放行登录页与验证码；其余一律 302 且不带 Location，等于「换不到票 / 拿不到数据」
        async fetch(sid, method, url) {
          if (url.startsWith(LOGIN_URL)) return { status: 200, body: '<input name="execution" value="fixture-execution">' };
          if (url.startsWith(SSO + '/tpass/captcha.jpg')) { calls.captchas++; return { status: 200, body: 'Zml4dHVyZQ==' }; }
          return { status: 302, body: '', finalUrl: '' };
        },
      },
      notify() {},
      util: { openSettings() {}, navigate() {}, openUrl() {} },
      events: { on() {}, emit() {} },
    },
  });
  vm.runInContext(code.replace('  tide.ui.registerView({',
    '  globalThis.api = { state, jwState, jwEnsureKeys };\n  tide.ui.registerView({'), context);
  return { api: context.api, calls };
}

async function settleMicrotasks() { await new Promise((resolve) => setTimeout(resolve, 0)); }

// ① 修好之后：一次刷新只判定一次登录，两个分区拿到同一条原因
{
  const { api, calls } = loadPlugin(source);
  await settleMicrotasks();
  calls.loginRounds = 0; calls.captchas = 0;
  // 学期来自缓存（真实场景就是「正在显示缓存」），所以 loadJwTerm 不会再跑一轮登录
  api.jwState.term = { code: '2025-2026-1', name: '2025-2026学年第一学期' };
  await api.jwEnsureKeys(['xkTask', 'xkResult']);
  assert.equal(calls.loginRounds, 1, '一次刷新只该判定一次登录（选课视图有 2 个 key）');
  // 一轮登录 = 首次尝试 + 耗尽后重建人工表单，各取一张验证码；这正是「自动刷新两次」里被白刷的网络开销
  assert.equal(calls.captchas, 2, '一轮登录只该取 2 张验证码，多出来的都是白刷');
  assert.equal(api.jwState.data.xkTask, null, '登录没建立时不该写入数据');
  assert.equal(api.jwState.data.xkResult, null);
  assert.ok(api.jwState.error.xkTask, '登录失败要给分区留下原因');
  assert.equal(api.jwState.error.xkTask, api.jwState.error.xkResult, '同一轮的两个 key 报同一条原因');
  assert.match(api.jwState.error.xkTask, /请核对账号和验证码|警大统一身份认证/, '失败原因要能落到分区上，而不是只报「没登录」');
  assert.equal(calls.loginRounds, 1, '每个 key 不该再各自撞一次登录');
  // 点「刷新」是新的一轮：必须允许重新判定，不能被上一轮的失败结论钉死
  await api.jwEnsureKeys(['xkTask', 'xkResult'], true);
  assert.equal(calls.loginRounds, 2, '点「刷新」该重新判定登录，而不是复用上一轮的失败结论');
}

// ② 变异测试：把统一登录闸门和本轮失败记忆拿掉，断言必须变红 —— 证明 ① 真的在测这件事
{
  const unfixed = source
    .replace('if (!await ensureJwLogin(force)) {', 'if (false) {')
    .replace('if (jwRoundLoginFailed === jwRound) return Promise.resolve(false);', '')
    .replace('jwRound++;', '');
  assert.notEqual(unfixed, source, '变异必须真的改到源码');
  const { api, calls } = loadPlugin(unfixed);
  await settleMicrotasks();
  calls.loginRounds = 0; calls.captchas = 0;
  api.jwState.term = { code: '2025-2026-1', name: '2025-2026学年第一学期' };
  await api.jwEnsureKeys(['xkTask', 'xkResult']);
  assert.equal(calls.loginRounds, 2, '未修复时两个 key 各跑一轮登录 —— 这就是「自动刷新两次」');
  assert.equal(calls.captchas, 4, '未修复时验证码识别被白刷两遍');
}

console.log('PASS: CPPU jw views judge the login once per refresh instead of once per key');
