// 「个人信息（含成长数据）」的获取速度（v0.236.0，v0.281.0 两页合一后重写）。
//
// 用户口径：这页每次进去都在转圈，要的是「切走再切回别再等一遍」。
//
// 本测试盯四件容易悄悄退回去的事：
//   ① 主进程那层缓存必须挂在 pdataApi **之外** —— 挂进去会把
//      test-cppu-pdata-login 的「同一个 path 第二次必须重新问服务端」变成假绿；
//   ② 只缓存成功响应：失败 / 未登录不落缓存（否则一次网络抖动会被记住一整个 TTL，
//      用户点几次刷新都是「读不到」）；
//   ③ 重进 TTL 内不再问 bridge，「刷新」走 force 真的绕过去；
//   ④ 首屏分两批落画面：三块先画，其余五块没回来之前**不许**冒出「暂无 …」。
import { readProductSource } from './lib/read-product-source.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const mainSrc = readProductSource(new URL('../public/plugins/cppu-notify/main.js', import.meta.url), 'utf8');
const profileSrc = readProductSource(new URL('../public/plugins/cppu-notify/profile.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ── ① 主进程：缓存层挂在 pdataApi 之外 ─────────────────────────────────── */
{
  const fetches = [];
  const vaultData = { pdataToken: JSON.stringify({ token: 'TK-1', userId: '2025000001', at: Date.now() }) };
  let response = () => ({ status: 200, body: JSON.stringify({ code: 2000, data: { ok: 1 } }) });
  let gate = null;   // 用来把响应挂在半空，验证并发去重

  const context = vm.createContext({
    URL, Set, Map, Date, Promise, console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { createElement: () => ({ set innerHTML(x) { this.value = x; } }), querySelectorAll: () => [] },
    Image: class { constructor() { this.naturalWidth = 0; this.naturalHeight = 0; } decode() { return Promise.reject(new Error('no')); } },
    tide: {
      ui: { registerView: () => {} },
      http: {
        session: async () => 's1',
        restoreCookies: async () => 'sid-1',
        fetch: async (sid, method, url, opts) => {
          fetches.push(url);
          if (gate) await gate;
          return response(sid, method, url, opts || {});
        },
      },
      storage: { set: async () => {}, get: async (k, d) => (d === undefined ? null : d) },
      vault: {
        get: async (k) => (vaultData[k] ?? null),
        set: async (k, v) => { vaultData[k] = v; },
        del: async (k) => { delete vaultData[k]; },
      },
      util: { openUrl: () => {}, openPdataPage: async () => {} },
      notify: () => {},
    },
  });
  const exported = 'state,pdataApi,pdataCached,pdataCache,pdataPending,pdataCacheKey,pdataCacheTtl,dropPdataCache,'
    + 'PDATA_TTL,PDATA_TTL_STATIC,growthBridge,dropPdataAuth,forgetPdataAuth,loadPdataAuth';
  vm.runInContext(
    mainSrc.replace('  tide.ui.registerView({', `  globalThis.testApi = {${exported}};\n  tide.ui.registerView({`),
    context,
  );
  const api = context.testApi;
  const count = (needle) => fetches.filter((u) => u.includes(needle)).length;

  // 键归一：调用方用 ?t=<时间戳> 防缓存（getModuleList 就带着），不剔掉永远不命中
  assert.equal(api.pdataCacheKey('/a/b'), '/a/b');
  assert.equal(api.pdataCacheKey('/a/b?t=1712345678901'), '/a/b');
  assert.equal(api.pdataCacheKey('/a/b?wid=9&_t=1712345678901'), '/a/b?wid=9');
  assert.equal(api.pdataCacheKey('/a/b?_=1712345678901&z=1'), '/a/b?z=1');
  assert.equal(api.pdataCacheTtl('/tsa/shc/homepage/personInfo'), api.PDATA_TTL_STATIC);
  assert.equal(api.pdataCacheTtl('/tsa/shc/customStyle/getModuleList?t=1'), api.PDATA_TTL_STATIC);
  assert.equal(api.pdataCacheTtl('/tsa/shc/homepage/cardConsume'), api.PDATA_TTL);

  // 命中：同一个 path 第二次不再发请求（直接问层 / 走 bridge 共用一份缓存）
  await api.pdataCached('/tsa/shc/homepage/getMyAttendance');
  await api.pdataCached('/tsa/shc/homepage/getMyAttendance');
  assert.equal(count('/getMyAttendance'), 1, 'TTL 内同一个 path 不该问第二次');
  await api.growthBridge.api('/tsa/shc/homepage/getMyAttendance');
  assert.equal(count('/getMyAttendance'), 1, '视图走的 bridge 必须和直接取数共用同一份缓存');

  // force：用户按「刷新」时必须真的重新取
  await api.growthBridge.force('/tsa/shc/homepage/getMyAttendance');
  assert.equal(count('/getMyAttendance'), 2, 'force 必须绕开缓存');

  // 防缓存参数被归一后才命中缓存
  await api.pdataCached('/tsa/shc/customStyle/getModuleList?t=111');
  await api.pdataCached('/tsa/shc/customStyle/getModuleList?t=222');
  assert.equal(count('/getModuleList'), 1, '?t= 只是一层防缓存，不该让同一份数据请求两次');

  // 并发去重：同一时刻问两次只发一次请求
  {
    const before = count('/getKpiList');
    let release = null;
    gate = new Promise((r) => { release = r; });
    const a = api.pdataCached('/tsa/shc/homepage/getKpiList');
    const b = api.pdataCached('/tsa/shc/homepage/getKpiList');
    await flush();
    assert.equal(count('/getKpiList'), before + 1, '并发同一个 path 必须只发一次请求');
    release();
    gate = null;
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true, '两个调用方都要拿到同一份结果');
  }

  // 失败不缓存：否则一次抖动会被记住一整个 TTL
  response = () => ({ status: 200, body: JSON.stringify({ code: 5001, message: '服务端忙' }) });
  await api.pdataCached('/tsa/pdp/consume/cardInfo');
  await api.pdataCached('/tsa/pdp/consume/cardInfo');
  assert.equal(count('/cardInfo'), 2, '失败的响应绝不能进缓存');
  assert.equal(api.pdataCache.has('/tsa/pdp/consume/cardInfo'), false);

  // 票据换人 ⇒ 整层作废（缓存里那份可能属于上一个身份）
  response = () => ({ status: 200, body: JSON.stringify({ code: 2000, data: { ok: 1 } }) });
  await api.pdataCached('/tsa/shc/homepage/cardConsume');
  const beforeDrop = count('/cardConsume');
  assert.equal(api.pdataCache.size > 0, true);
  await api.dropPdataAuth();
  // dropPdataAuth 连密钥库里的票一起删了，这里补一份新票（本用例只看缓存有没有作废）
  vaultData.pdataToken = JSON.stringify({ token: 'TK-2', userId: '2025000001', at: Date.now() });
  await api.pdataCached('/tsa/shc/homepage/cardConsume');
  assert.equal(count('/cardConsume'), beforeDrop + 1, '重登（dropPdataAuth）必须把缓存整层作废');
  api.forgetPdataAuth();
  assert.equal(api.pdataCache.size, 0, '门户会话重建（forgetPdataAuth）也要作废缓存');

  // 缓存不碰 pdataApi 本体：那条回归断言依赖的就是它每次都真的问服务端
  const pdataApiBody = mainSrc.slice(mainSrc.indexOf('async function pdataApi'), mainSrc.indexOf('async function pdataApi') + 900);
  assert.ok(!/pdataCache|pdataCached/.test(pdataApiBody), '缓存不能写进 pdataApi 的函数体');
  assert.match(pdataApiBody, /const url = PDATA \+ path;/, 'pdataApi 的 URL 口径（不带 _USER）不许动');
  assert.ok(!pdataApiBody.includes('_USER'));
}

/* ── ② 视图层：分两批落画面 + 重进不打网络 ──────────────────────────────── */
{
  /* 最小 DOM 替身：paint() 只写 root.innerHTML，bind() 只读 querySelector /
     querySelectorAll（返回 null / [] 时所有接线都被 if 挡住）。 */
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({}),
    head: { append: () => {} },
  };
  const { createProfileView } = await import('../public/plugins/cppu-notify/profile.js');

  const calls = [];
  const bridge = {
    api: (p) => { const d = deferred(); calls.push({ path: p, force: false, d }); return d.promise; },
    force: (p) => { const d = deferred(); calls.push({ path: p, force: true, d }); return d.promise; },
    open: () => {},
    relogin: async () => 'ok',
  };
  const tideStub = {
    storage: { get: async (k, d) => d, set: async () => {} },
    ui: { selectionGlow: () => null, waitMask: () => () => {} },
    notify: () => {},
  };
  function deferred() {
    let resolve = null;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  }
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const view = createProfileView(tideStub, bridge);
  view.render(host);
  await flush();

  assert.equal(calls.length, 8, '八个接口还是要并发发出（只是分两批落画面）');
  const find = (needle) => calls.filter((c) => c.path.includes(needle))[0];
  assert.match(host.innerHTML, /正在读取个人信息…/, '首屏之前还是要有整页占位（老宿主的兜底）');
  const okHead = [
    { ok: true, data: { personInfo: { USERNAME: '张三', USERID: '2025000001' }, column: [] } },
    { ok: true, data: { GOTTENUNIT: 218, TOTALUNIT: 59.6 } },
    { ok: true, data: [{ FORMNAME: '跑操', KPICONFIG: 12, KPI_COLOR: '#118AB2', WID: 'w1' }] },
  ];
  const headPaths = ['/personInfo', '/learnSituation', '/getKpiList'];
  headPaths.forEach((p, i) => find(p).d.resolve(okHead[i]));
  await flush();

  const mid = host.innerHTML;
  assert.match(mid, /张三/, '首屏三块到了就该把身份卡画出来');
  assert.match(mid, /更新于/, '首屏落地就要给更新时间（手里有数据了）');
  assert.doesNotMatch(mid, /暂无出勤记录|当月无消费记录|暂无奖惩记录/, '其余五块还没回来时不许说「暂无」');
  assert.match(mid, /正在读取…/, '其余五块的位置要说「正在读取…」');
  assert.doesNotMatch(mid, /正在读取个人信息…/, '有数据了就不该再退回整页占位');

  const tailData = [
    { ok: true, data: { placeRanking: [{ MERCHANT: '食堂', SPENDGMONEY: 12 }], balance: { BALANCE: 88.5, TOTALAMOUNT: 300 } } },
    { ok: true, data: { placeRanking: [] } },
    { ok: true, data: [] },
    { ok: true, data: [] },
    { ok: true, data: [] },
  ];
  ['/cardConsume', '/onlineState', '/getMyAttendance', '/bonusPenaltyList', '/getModuleList']
    .forEach((p, i) => find(p).d.resolve(tailData[i]));
  await flush();

  assert.match(host.innerHTML, /食堂/, '第二批复数据要补进画面');
  assert.match(host.innerHTML, /暂无出勤记录/, '全部到齐后空列表才可以说「暂无」');
  assert.doesNotMatch(host.innerHTML, /正在读取…/);

  // 切走再切回：TTL 内不再问 bridge（这正是用户抱怨的那一步）
  const before = calls.length;
  view.render(host);
  await flush();
  assert.equal(calls.length, before, 'TTL 内重进不该再发任何请求');
  assert.match(host.innerHTML, /张三/, '重进要能立刻画出上次那份');
  assert.equal(view.refresh === undefined, false, '对外仍要暴露 refresh');

  /* 静态接线：「刷新」「重新登录」都必须走 force（否则用户按了刷新还是旧数据；
     换票后那份数据属于新身份）。v0.281.0 起只剩一个视图、一个文件。 */
  assert.match(profileSrc, /hit\("\[data-pf-refresh\]"\)\) \{ loadAll\(true\); return; \}/, '刷新必须走 force');
  assert.match(profileSrc, /result === "ok"\) \{ state\.error = ""; state\.stale = ""; loadAll\(true\); return; \}/,
    '重新登录成功后必须强制重取');
  /* 重进窗口：v0.268.0 起是「一个月内直接用车里的/磁盘上的缓存」（数据不勤变，
     8 个接口每次打开都重打纯属白等）。必须是常量，不能散写数字。 */
  assert.match(profileSrc, /loadAll\(force = false\)/, 'loadAll 必须收 force');
  assert.match(profileSrc, /const FRESH_MS = 30 \* 24 \* 60 \* 60 \* 1000;/, '重进窗口是一个月');
  // 手里有数据时不打蒙版，但兜底占位不能丢（老宿主还要靠它）
  assert.match(profileSrc, /const releaseWait = state\.loadedAt \? \(\) => \{\} : waitMask\("正在读取个人信息与成长数据…"\);/, '有数据时不打蒙版');
  assert.match(profileSrc, /const HEAD_FIELDS = \["profile", "learn", "kpi"\];/);
  assert.match(profileSrc, /const TAIL_FIELDS = \["consume", "online", "attend", "bonus", "dirs"\];/);
  assert.match(profileSrc, /state\.partial \? "正在读取…" : onConsume \? "当月无消费记录"/);
  assert.match(profileSrc, /state\.partial \? "正在读取…" : "暂无出勤记录"/);
  assert.match(profileSrc, /state\.partial \? "正在读取…" : "暂无奖惩记录"/);
  // 「学生成长」不再是独立视图：入口、视图注册、模块文件都必须只剩个人信息这一份
  assert.doesNotMatch(mainSrc, /cppu-growth|growth\.js|data-pg-host/, '成长页已并入个人信息，不许留半截入口');
}

console.log('PASS: 个人信息（含成长数据）取数速度（pdata 缓存与并发去重 · 失败不缓存 · 票据换人作废 · 首屏分两批落画面 · 重进不打网络 · 刷新走 force）');
