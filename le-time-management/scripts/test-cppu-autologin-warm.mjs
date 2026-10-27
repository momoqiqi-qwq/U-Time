#!/usr/bin/env node
/*
 * 警大门户「自动登录优化」（v0.245.0）的行为测试。
 *
 * 三块被测真代码，全部从 public/plugins/cppu-notify/main.js 里按标记切出来跑（不是抄一遍）：
 *  ① readCaptchaCode —— 置信度偏低时换图重认、且始终提交「最后那张图」的识别结果；
 *  ② warmSession    —— 启动预热的闸门与频控（不许与前台登录抢会话）；
 *  ③ autoLogin      —— 吃 render 并发读好的票据、且不被 saveCookies 落盘拖住首屏。
 *
 * 之所以抓这三处：它们是这次改动的全部风险点，而老测试（test-cppu / test-cppu-campus /
 * test-cppu-jw-login-once）只在「OCR 完全认不出」和「置信度字段缺失」这两条老路径上压测，
 * 新加的换图与预热逻辑没有断言盖着就会静默退化。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const source = read('public/plugins/cppu-notify/main.js');

/** 按起止标记切一段真代码；找不到就当场炸，避免切片漂移后测试静默跑空。 */
function slice(from, to) {
  const a = source.indexOf(from);
  const b = a < 0 ? -1 : source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `main.js 里找不到代码片段：${from} … ${to}`);
  return source.slice(a, b);
}

const CAPTCHA_CODE = slice('  const CAPTCHA_MIN_CONFIDENCE', '  async function runLoginAttempts(');
const WARM_CODE = slice('  /* 「上次自动登录」只给登录页', '  /* 密码兜底与人工按钮共享');
const AUTO_LOGIN_CODE = slice('  async function autoLogin(el, restored)', '  async function persistCredentials(');

/* ── ① 验证码：先看清再提交 ── */
function captchaHarness(results, { extraCaptchas = 0 } = {}) {
  const calls = { fetch: 0, recognize: 0, check: 0 };
  const box = {
    state: { captcha: 'img-0' },
    OC: null,
    OCR: {
      recognize: async () => {
        const hit = results[Math.min(calls.recognize, results.length - 1)];
        calls.recognize++;
        return hit;
      },
    },
    fetchCaptcha: async () => { calls.fetch++; box.state.captcha = 'img-' + calls.fetch; },
  };
  box.extraCaptchas = extraCaptchas;
  vm.runInNewContext(CAPTCHA_CODE + ';globalThis.readCaptchaCode = readCaptchaCode;globalThis.limits = { CAPTCHA_RESHOTS, CAPTCHA_MIN_CONFIDENCE };', box);
  box.calls = calls;
  box.check = () => { calls.check++; };
  return box;
}

{
  // 连续两张都模糊 → 换两张图，提交的是第三张（最后一张）自己的识别结果
  const h = captchaHarness([
    { code: 'AAAA', confidence: 0.20, samples: ['s1'] },
    { code: 'BBBB', confidence: 0.31, samples: ['s2'] },
    { code: 'CCCC', confidence: 0.88, samples: ['s3'] },
  ]);
  const out = await h.readCaptchaCode(h.check);
  assert.equal(h.calls.fetch, 2, '模糊到第二次仍不达标就要再换一张图');
  assert.equal(out.code, 'CCCC', '提交的必须是最后那张图自己的识别结果');
  assert.deepEqual(out.samples, ['s3'], '样本也要跟着最后那张图走，否则登录成功样本会串图');
  assert.equal(h.calls.check, 2, '每次换图后都要重新确认视图还在');
}
{
  // 换到上限仍然模糊：仍然交出最后一次（让它去试），绝不回头用更早那张 —— 会话绑定的图已经废了
  const h = captchaHarness([{ code: 'OLD0', confidence: 0.05 }, { code: 'MID1', confidence: 0.05 }, { code: 'NEW2', confidence: 0.05 }]);
  const out = await h.readCaptchaCode(h.check);
  assert.equal(h.calls.fetch, h.limits.CAPTCHA_RESHOTS, '换图次数受上限约束，不会无限刷验证码');
  assert.equal(out.code, 'NEW2', '耗到上限也要提交最新那张，不能回退成第一张');
}
{
  // 老宿主 / 测试桩不给 confidence：按可用处理，不额外取图（老测试的断言全靠这条）
  const h = captchaHarness([{ code: 'OK', samples: [] }]);
  const out = await h.readCaptchaCode(h.check);
  assert.equal(out.code, 'OK');
  assert.equal(h.calls.fetch, 0, '没有置信度字段时不许擅自换图');
  assert.equal(h.calls.check, 0);
}
{
  // 一个字符都认不出：不换图（换了也还是空），立刻返回让上层报「未识别」
  const h = captchaHarness([{ code: '', confidence: 0, samples: [] }]);
  const out = await h.readCaptchaCode(h.check);
  assert.equal(out.code, '');
  assert.equal(h.calls.fetch, 0, '认不出字符时换图只是白刷验证码，会把尝试次数烧在取图上');
}

/* ── ② 启动预热：闸门、频控、落盘 ── */
function warmHarness({ withWindow = true, stored = {}, vaultOk = true, renew = true, restore = true, username = '2025000001' } = {}) {
  const calls = { restore: 0, renew: 0, save: 0, notify: 0, loadPrefs: 0 };
  const store = { autoLogin: true, username, ...stored };
  const box = {
    state: { sid: null, viewOpen: 0, autoLogin: true, username: '', savedPassword: '', loginAt: 0, loginRetries: 2, seen: new Set(), filter: {} },
    loginBusy: false,
    authEpoch: 0,
    authCurrent: epoch => epoch === box.authEpoch,
    authStorage: job => Promise.resolve().then(job),
    navigator: { onLine: true },
    tide: {
      storage: {
        get: async (key, fallback) => (key in store ? store[key] : fallback),
        set: async (key, value) => { store[key] = value; },
      },
      vault: vaultOk ? { get: async () => null } : undefined,
    },
    loadPrefs: async () => {
      calls.loadPrefs++;
      box.state.username = username;
      box.state.autoLogin = store.autoLogin !== false;
    },
    restoreCookies: async () => { calls.restore++; return restore; },
    silentRenew: async () => { calls.renew++; return typeof renew === 'function' ? renew() : renew; },
    saveCookies: async () => { calls.save++; },
  };
  if (withWindow) box.window = { setTimeout: () => 0 };
  vm.runInNewContext(WARM_CODE + ';globalThis.warmSession = warmSession;globalThis.scheduleWarm = scheduleWarm;globalThis.WARM_EVERY_MS = WARM_EVERY_MS;', box);
  box.calls = calls;
  box.store = store;
  return box;
}

{
  // 没有 window（测试沙箱 / 非浏览器环境）：直接不排程
  const h = warmHarness({ withWindow: false });
  assert.equal(await h.warmSession(), false);
  assert.equal(h.calls.restore, 0, '没有 window 时一个请求都不许发');
}
{
  // 前台有视图挂着 / 会话已被占用：预热退让，绝不与登录抢 state.sid
  const busyView = warmHarness();
  busyView.state.viewOpen = 1;
  assert.equal(await busyView.warmSession(), false);
  assert.equal(busyView.calls.restore, 0);

  // v0.272.7：内存里已经有会话（state.sid）**不是**拒绝预热的理由 —— 那个 sid 整个运行期
  // 都不清，拿它当闸门等于「用过一次插件之后永久不预热」。现在改成复用它续期，不另建会话。
  const busySid = warmHarness();
  busySid.state.sid = 'sid-live';
  assert.equal(await busySid.warmSession(), true, '已有会话时复用续期，不再拒绝预热');
  assert.equal(busySid.calls.restore, 0, '已经有会话在用就不能另起一个');
  assert.equal(busySid.calls.renew, 1, '复用已有会话走静默续期');
  assert.equal(busySid.state.sid, 'sid-live', '预热不许把正在用的会话换掉');
}
{
  // 12 小时频控：刚预热过就不重复
  const h = warmHarness({ stored: { autoWarmAt: Date.now() - 60 * 1000 } });
  assert.equal(await h.warmSession(), false);
  assert.equal(h.calls.restore, 0, '频控命中时不许再碰网络');
}
{
  // 用户关掉自动登录 / 没记住账号：后台不登录（后台登录只能用这两项授权）
  const off = warmHarness({ stored: { autoWarmAt: 0, autoLogin: false } });
  assert.equal(await off.warmSession(), false);
  assert.equal(off.calls.renew, 0, '关闭自动登录后不许在后台拿密码登');

  const anon = warmHarness({ stored: { autoWarmAt: 0 }, username: '' });
  assert.equal(await anon.warmSession(), false);
  assert.equal(anon.calls.renew, 0);
}
{
  // 主路径：恢复票据 → 静默续期 → 落盘 → 记时间戳；频控时间同步推后
  const h = warmHarness({ stored: { autoWarmAt: 0 } });
  assert.equal(await h.warmSession(), true);
  assert.equal(h.calls.restore, 1);
  assert.equal(h.calls.renew, 1);
  assert.equal(h.calls.save, 1, '续期拿到的新票据必须落盘，否则下次启动又回到旧票据');
  assert.ok(h.store.autoLoginAt > 0, '成功预热要记下「上次自动登录」时间，登录页靠它解释为什么还要登录');
  assert.ok(Date.now() - h.store.autoWarmAt < 5000, '频控时间要在做完之后再写');
}
{
  // 失败路径（v0.272.7 起）：只写**短退避** autoWarmFailAt，不写 autoWarmAt ——
  // 原来失败什么都不记、只能干等 12 小时，白天断一次网就整天不再续期。
  const h = warmHarness({ stored: { autoWarmAt: 0 }, renew: false });
  assert.equal(await h.warmSession(), false);
  assert.ok(h.store.autoWarmFailAt > 0, '失败要记 30 分钟退避');
  assert.equal(h.store.autoWarmAt, 0, '失败不能写成功时间，否则成功路径的 12 小时频控会把它当成功');
  assert.equal(h.store.autoLoginAt, undefined, '没成不能写「上次自动登录」');
  // 退避期内不再打扰；退避过期后可以重来
  const callsAfter = h.calls.renew;
  assert.equal(await h.warmSession(), false, '退避期内不许重试');
  assert.equal(h.calls.renew, callsAfter, '退避命中时一个请求都不该发');
  h.store.autoWarmFailAt = Date.now() - 31 * 60 * 1000;
  assert.equal(await h.warmSession(), false, '票据还是坏的，但这次真的问了');
  assert.equal(h.calls.renew, callsAfter + 1, '退避过期后必须重新尝试');
}
{
  // 成功要清掉失败退避，否则上一次断网的退避时间会继续挡着
  const h = warmHarness({ stored: { autoWarmAt: 0, autoWarmFailAt: Date.now() - 60 * 1000 } });
  assert.equal(await h.warmSession(), false, '退避期内即使能成也不碰网络');
  h.store.autoWarmFailAt = 0;
  assert.equal(await h.warmSession(), true);
  assert.equal(h.store.autoWarmFailAt, 0, '成功必须把退避清零');
}

{
  // 三种唤醒可以在同一帧触发，异步读取设置之前就必须拿到唯一预热所有权。
  const h = warmHarness();
  const outcomes = await Promise.all([h.warmSession(), h.warmSession(), h.warmSession()]);
  assert.deepEqual(outcomes, [true, true, true]);
  assert.equal(h.calls.restore, 1, '并发唤醒只恢复一份 Cookie');
  assert.equal(h.calls.renew, 1, '并发唤醒只能发起一次静默续期');
  assert.equal(h.calls.save, 1, '并发唤醒只落盘一次');
}
{
  // 调整系统时钟、旧数据异常都不能把频控卡到未来；有效的过去时间仍由上面测试守住。
  for (const at of [Date.now() + 86400000, Infinity, -100, 'not-a-date']) {
    const h = warmHarness({ stored: { autoWarmAt: at, autoWarmFailAt: at } });
    assert.equal(await h.warmSession(), true, `无效/未来时间不能阻止恢复：${at}`);
    assert.equal(h.calls.renew, 1);
  }
}
{
  const h = warmHarness();
  h.navigator.onLine = false;
  assert.equal(await h.warmSession(), false);
  assert.equal(h.calls.restore, 0, '明确离线时不恢复会话、不发请求');
  assert.equal(h.store.autoWarmFailAt, undefined, '离线跳过不能占用失败退避');
  h.navigator.onLine = true;
  assert.equal(await h.warmSession(), true, '网络回来后可以立即恢复');
}
{
  // 等异步频控读取时，用户已打开登录表单；后台必须让位，不触碰其会话。
  const h = warmHarness();
  const pending = h.warmSession();
  h.state.viewOpen = 1;
  assert.equal(await pending, false);
  assert.equal(h.calls.renew, 0);
  assert.equal(h.store.autoWarmFailAt, undefined);
}
{
  let settle;
  const h = warmHarness({ renew: () => new Promise(resolve => { settle = resolve; }) });
  const pending = h.warmSession();
  while (!settle) await Promise.resolve();
  h.authEpoch++;
  settle(true);
  assert.equal(await pending, false, '清除凭据后，旧续期结果已作废');
  assert.equal(h.calls.save, 0, '作废的续期不能重新保存 Cookie');
  assert.equal(h.store.autoWarmAt, undefined);
  assert.equal(h.store.autoWarmFailAt, undefined);
  assert.equal(h.store.autoLoginAt, undefined, '旧续期不能写回已清除的登录时间');
}

function warmLifecycle(h) {
  const target = () => {
    const events = new Map();
    return { events,
      addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
      removeEventListener(name, fn) { events.get(name)?.delete(fn); },
      dispatch(name) { for (const fn of [...(events.get(name) || [])]) fn(); },
    };
  };
  const timers = new Map(), disposers = [];
  let id = 0;
  h.document = { ...target(), visibilityState: 'visible' };
  h.window = { ...target(),
    setTimeout(fn, ms) { timers.set(++id, { fn, ms, interval: false }); return id; },
    setInterval(fn, ms) { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearTimeout(key) { timers.delete(key); }, clearInterval(key) { timers.delete(key); },
  };
  h.tide.ui = { onDispose: fn => disposers.push(fn) };
  return { timers, disposers };
}
{
  const h = warmHarness();
  const life = warmLifecycle(h);
  h.scheduleWarm();
  assert.equal(life.timers.size, 2);
  assert.equal([...life.timers.values()].find(t => t.interval).ms, 30 * 60 * 1000, '失败后应在 30 分钟重试检查，不能再等 12 小时');
  h.scheduleWarm();
  assert.equal(life.timers.size, 2, '重复排程先清旧定时器');
  for (const name of ['focus', 'online']) assert.equal(h.window.events.get(name).size, 1);
  assert.equal(h.document.events.get('visibilitychange').size, 1);
  h.navigator.onLine = false;
  h.window.dispatch('focus');
  await Promise.resolve();
  assert.equal(h.calls.renew, 0);
  h.navigator.onLine = true;
  h.window.dispatch('online');
  await h.warmSession();
  assert.equal(h.calls.renew, 1, 'online 事件应立即触发统一恢复入口');
  life.disposers.at(-1)();
  assert.equal(life.timers.size, 0, '停用插件清掉所有预热计时器');
  for (const name of ['focus', 'online']) assert.equal(h.window.events.get(name).size, 0);
  assert.equal(h.document.events.get('visibilitychange').size, 0);
  assert.equal(await h.warmSession(), false, '停用后遗留回调不得继续续期');
}
{
  let settle;
  const h = warmHarness({ renew: () => new Promise(resolve => { settle = resolve; }) });
  const life = warmLifecycle(h);
  h.scheduleWarm();
  const pending = h.warmSession();
  while (!settle) await Promise.resolve();
  life.disposers.at(-1)();
  settle(true);
  assert.equal(await pending, false);
  assert.equal(h.calls.save, 0, '停用插件后不得保存在途续期结果');
  assert.equal(h.store.autoWarmAt, undefined);
  assert.equal(h.store.autoWarmFailAt, undefined);
}

/* ── ③ autoLogin：吃读好的票据，且不被落盘拖住 ── */
function autoLoginHarness({ renewed = true, pageOk = false, restored } = {}) {
  const calls = { restore: 0, newSession: 0, page: 0, renew: 0, save: 0, mark: 0, build: 0, password: 0 };
  const box = {
    state: { sid: null, token: '', username: 'u', savedPassword: 'p', autoLogin: true, error: null },
    warmBusy: false,
    warmPromise: null,
    authEpoch: 0,
    authCurrent: epoch => epoch === box.authEpoch,
    loginHint: null,
    tide: { notify: () => {} },
    restoreCookies: async () => { calls.restore++; return restored; },
    newSession: async () => { calls.newSession++; box.state.sid = 'sid-new'; },
    loadPage: async () => { calls.page++; return pageOk; },
    silentRenew: async () => { calls.renew++; return renewed; },
    // 永不 settle：证明首屏没有被落盘 await 住
    saveCookies: () => { calls.save++; return new Promise(() => {}); },
    markLoginAt: () => { calls.mark++; },
    buildMain: () => { calls.build++; },
    // 缓存先上屏时数据回来只重画内容；这里等价记一次「界面被刷了」
    paintAfterLoad: () => { calls.build++; },
    passwordAutoLogin: async () => { calls.password++; return false; },
    showNoticeCache: async () => false,
    prepareLoginForm: async () => {},
    paintLogin: () => {},
    loginErrorText: (e) => String(e?.message || e),
  };
  vm.runInNewContext(AUTO_LOGIN_CODE + ';globalThis.autoLogin = autoLogin;', box);
  box.calls = calls;
  return box;
}

{
  // render 已经并发读好票据（false = 没存过）：不许再读一次密钥库
  const pre = (async () => false)();
  const h = autoLoginHarness({ renewed: true });
  assert.equal(await h.autoLogin({}, pre), true);
  assert.equal(h.calls.restore, 0, 'render 并发读好的那份要用起来，不能重复读密钥库');
  assert.equal(h.calls.newSession, 1, '没有票据要建一个新会话再续期');
  assert.equal(h.calls.build, 1);
  assert.equal(h.calls.mark, 1, '成功续期要记「上次自动登录」时间');
  assert.equal(h.calls.save, 1, '新票据还是要落盘（只是不挡首屏）');
}
{
  // 没传参（其他视图直接调）时自己读，行为与旧版一致
  const h = autoLoginHarness({ restored: false, renewed: false });
  assert.equal(await h.autoLogin({}), false);
  assert.equal(h.calls.restore, 1);
  assert.equal(h.calls.save, 0);
  assert.equal(h.calls.mark, 0);
}
{
  // 预热正在进行：先等它，别两条链路同时戳 state.sid
  const h = autoLoginHarness({ restored: false, renewed: false });
  let warmDone = false;
  h.warmBusy = true;
  h.warmPromise = new Promise((resolve) => setTimeout(() => { warmDone = true; resolve(true); }, 5));
  await h.autoLogin({}, Promise.resolve(false));
  assert.equal(warmDone, true, 'autoLogin 必须等预热收尾后再动会话');
}
{
  // 预热抛错也不能把前台登录带崩
  const h = autoLoginHarness({ restored: false, renewed: true });
  h.warmBusy = true;
  h.warmPromise = Promise.reject(new Error('warm boom'));
  h.warmPromise.catch(() => {});
  assert.equal(await h.autoLogin({}), true, '预热失败只当没有票据，前台照常续期');
}

/* 预热必须**真的被调用**：v0.246.0 ~ v0.272.6 之间 scheduleWarm 有定义没调用点，
   一次都没跑过，「放几天就掉登录」的原始问题从未被修掉。这两条源码契约钉住调用点，
   闸门与频控的行为断言（上面 ②）才不是给死代码写的。 */
assert.match(
  source,
  /\r?\n\s{2}scheduleWarm\(\);\r?\n/,
  '插件启动时必须调用 scheduleWarm()，否则预热是纯死代码',
);
assert.ok(
  /document\.addEventListener\("visibilitychange", relay\)/.test(source)
  && /window\.addEventListener\("focus", relay\)/.test(source),
  'APK 后台会冻结定时器：回到前台必须在 visibilitychange / focus 上补一次续期',
);

/* render() 的并发票据必须排在预热之后 —— 两个 restoreCookies 会各自建一个新会话，
   中途把 state.sid 换掉，续期就跑到别人的会话上去了。这段藏在 DOM 装配里没法单测，
   用一条定死的源码契约兜住（改写成别的时序会立刻红）。 */
assert.ok(
  /const waitingWarm = warmBusy && warmPromise \? warmPromise\.catch\(\(\) => \{\}\) : Promise\.resolve\(\);[\s\S]{0,200}?const sessionReady = waitingWarm\.then\(\(\) => restoreCookies\(\)\)/.test(source),
  'render 必须先等预热收尾再读票据，不能两条链路各建一个会话',
);

/* 通知首屏 stale-while-revalidate：手里有本地缓存就先画内容、立刻撤蒙版，票据校验与拉取
   在后台跑；数据回来只重画内容（paintAfterLoad）而不是 buildMain 重建整页。两段都在 DOM
   装配里，同样用源码契约钉住。 */
assert.ok(
  /cacheFirstPaint = false;\s*if \(await restoreNoticeCache\(\) && !disposed\) \{\s*cacheFirstPaint = true;\s*buildMain\(el\);\s*releaseWait\(\);/.test(source),
  'render 必须先用缓存画首屏并立刻撤蒙版，再去校验票据',
);
assert.ok(
  /function paintAfterLoad\(el\) \{\s*if \(cacheFirstPaint && el && el\.isConnected\) \{ paintAll\(\); return; \}\s*buildMain\(el\);/.test(source),
  '缓存先上屏时数据回来只重画内容，不重建整页（重建会把阅读位置拽回顶部）',
);

console.log('PASS: cppu 自动登录预热 / 验证码重认 / 并发取票据 / 通知首屏缓存先上屏');
