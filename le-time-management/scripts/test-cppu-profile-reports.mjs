// 「个人信息 → 数据报告目录」（v0.240.0；v0.281.0 两页合一时改为随第二批一起取）。
//
// 用户口径：个人信息页只有 5 个档案字段，下面大片空白 —— 要问的是「同一个网址还能取到什么」。
// 答案就是这页背后的 pdata 还有一整组「数据报告」目录（basicInfo 只是其中之一）。
//
// 本测试盯五件事：
//   ① 目录与成长数据同属第二批：首屏三块（身份 / 学业 / KPI）先落画面，目录到了再补；
//   ② 目录没回来之前不许先摆一个空壳，也不许说「暂无」；
//   ③ 目录接口失败不牵连档案 —— 字段照样能复制，只是少一张卡；
//   ④ key 的两种形态都要认：CATALOGID 直给，或老接口只给 "1-13-basicInfo" 这种复合 id；
//   ⑤ 点一格必须走 bridge.open('/stu/dataReport/<key>')，这条通道才带得上会话。
import assert from 'node:assert/strict';

/* paint() 只写 root.innerHTML，bind() 只读 querySelector / querySelectorAll
   （返回 null / [] 时所有接线都被 if 挡住），styles() 只需要能 append。 */
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({}),
  head: { append: () => {} },
};

const { createProfileView } = await import('../public/plugins/cppu-notify/profile.js');

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
function deferred() {
  let resolve = null;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const calls = [];
  const opened = [];
  const bridge = {
    api: (p) => { const d = deferred(); calls.push({ path: p, force: false, d }); return d.promise; },
    force: (p) => { const d = deferred(); calls.push({ path: p, force: true, d }); return d.promise; },
    open: (p) => { opened.push(p); },
    relogin: async () => 'ok',
  };
  const tideStub = {
    storage: { get: async (k, d) => d, set: async () => {} },
    ui: { waitMask: () => () => {} },
    notify: () => {},
  };
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const view = createProfileView(tideStub, bridge);
  const find = (needle) => calls.filter((c) => c.path.includes(needle));
  const one = (needle) => find(needle)[0];
  return { calls, opened, bridge, host, view, find, one };
}

const PROFILE = {
  ok: true,
  data: {
    personInfo: { USERNAME: '张三', USERID: '2025000001', SEX: '1' },
    column: [{ dataField: 'RXNF', dataFieldName: '入学年份' }],
  },
};
const LEARN = { ok: true, data: { GOTTENUNIT: 218, TOTALUNIT: 59.6 } };
const KPI = { ok: true, data: [] };
const MODULES = {
  ok: true,
  data: [{
    id: '1',
    name: '数据报告',
    children: [
      { id: '1-13-basicInfo', name: '个人信息' },
      { CATALOGID: 'bookRent', name: '借书情况' },
      { id: '1-15-scoreList', name: '成绩单' },
    ],
  }],
};
/* 第二批的五路应答（顺序 = consume / online / attend / bonus / dirs）。 */
const tailOf = (dirs) => [
  { ok: true, data: { placeRanking: [{ MERCHANT: '食堂' }], balance: { BALANCE: 88.5 } } },
  { ok: true, data: { placeRanking: [] } },
  { ok: true, data: [] },
  { ok: true, data: [] },
  dirs,
];
const resolveTail = (h, dirs) => {
  ['/cardConsume', '/onlineState', '/getMyAttendance', '/bonusPenaltyList', '/getModuleList']
    .forEach((p, i) => h.one(p).d.resolve(tailOf(dirs)[i]));
};

/* ── ① 两批落画面：身份 / 学业 / KPI 先出，目录随第二批补 ───────────────── */
{
  const h = harness();
  h.view.render(h.host);
  await flush();

  assert.equal(h.calls.length, 8, '首屏就把 8 个接口一起发出去（分两批落画面，不是串行）');
  assert.match(h.calls[0].path, /\/tsa\/shc\/homepage\/personInfo$/, '第一枪必须还是 personInfo');
  assert.equal(h.find('/getModuleList').length, 1, '目录清单在第二批里，但同一次打开就发出');
  assert.match(h.host.innerHTML, /正在读取个人信息…/, '数据没到之前要有占位');

  h.one('/personInfo').d.resolve(PROFILE);
  h.one('/learnSituation').d.resolve(LEARN);
  h.one('/getKpiList').d.resolve(KPI);
  await flush();

  assert.match(h.host.innerHTML, /张三/, '首屏到了先把身份卡与字段画出来');
  assert.doesNotMatch(h.host.innerHTML, /数据报告目录/, '目录还没回来时不许先摆一个空壳');
  assert.doesNotMatch(h.host.innerHTML, /暂无/, '第二批没回来时也不许说「暂无」');
  assert.match(h.host.innerHTML, /正在读取…/, '第二批的位置要说「正在读取…」');

  resolveTail(h, MODULES);
  await flush();

  const html = h.host.innerHTML;
  assert.match(html, /数据报告目录/, '目录回来要把卡片画出来');
  assert.match(html, /3 个 · 点开直达/, '条数要对得上（重名 / 缺 key 的会剔掉）');
  assert.match(html, /借书情况/);
  assert.match(html, /成绩单/);
  assert.match(html, /上面这些与「个人信息」同站同权限/, '要说明这批目录和本页的关系');
  assert.doesNotMatch(html, /正在读取…/, '全部到齐后不该再有读取中');
  assert.match(html, /暂无出勤记录/, '考勤确实是空的 ⇒ 这才是「暂无」该出现的时机');

  /* ② 点一格：必须走 bridge.open 的站内路径（那条通道才换票 + 注入 Cookie） */
  const dirTarget = (idx) => ({ closest: (sel) => (sel === '[data-pf-dir]' ? { dataset: { pfDir: String(idx) } } : null) });
  h.host.onclick({ target: dirTarget(1) });
  h.host.onclick({ target: dirTarget(2) });
  assert.deepEqual(h.opened, ['/stu/dataReport/bookRent', '/stu/dataReport/scoreList'],
    'CATALOGID 直给与 "1-15-scoreList" 复合 id 都要还原成站内目录名');
}

/* ── ③ 目录接口失败：档案照旧，只是少一张卡 ─────────────────────────────── */
{
  const h = harness();
  h.view.render(h.host);
  await flush();
  h.one('/personInfo').d.resolve(PROFILE);
  h.one('/learnSituation').d.resolve(LEARN);
  h.one('/getKpiList').d.resolve(KPI);
  resolveTail(h, { ok: false, message: '个人成长中心返回 502' });
  await flush();

  assert.match(h.host.innerHTML, /张三/, '目录挂了不影响档案');
  assert.match(h.host.innerHTML, /入学年份/, '字段照样要能看能复制');
  assert.doesNotMatch(h.host.innerHTML, /数据报告目录/, '没数据就不摆空卡');
  assert.doesNotMatch(h.host.innerHTML, /502/, '目录失败不弹错 —— 它不是本页主体');
}

/* ── ④ 点「刷新」：八路都必须走 force（否则看到的是旧目录旧数据）───────── */
{
  const h = harness();
  h.view.render(h.host);
  await flush();
  h.one('/personInfo').d.resolve(PROFILE);
  h.one('/learnSituation').d.resolve(LEARN);
  h.one('/getKpiList').d.resolve(KPI);
  resolveTail(h, MODULES);
  await flush();
  assert.match(h.host.innerHTML, /借书情况/);

  const before = h.calls.length;
  // 工具栏那颗「刷新」：走的是 loadAll(true)，不是 refresh() 的 TTL 分支
  h.host.onclick({ target: { closest: (sel) => (sel === '[data-pf-refresh]' ? {} : null) } });
  await flush();

  const fresh = h.calls.slice(before);
  assert.equal(fresh.length, 8, '刷新要重打 8 个接口');
  assert.ok(fresh.every((c) => c.force), '每一个都必须带 force，否则主进程缓存会把请求吃掉');
  assert.equal(fresh.filter((c) => /\/getModuleList/.test(c.path)).length, 1, '目录也要一起刷');

  fresh.find((c) => /\/personInfo$/.test(c.path)).d.resolve(PROFILE);
  fresh.find((c) => /\/learnSituation/.test(c.path)).d.resolve(LEARN);
  fresh.find((c) => /\/getKpiList/.test(c.path)).d.resolve(KPI);
  fresh.filter((c) => /cardConsume|onlineState|getMyAttendance|bonusPenaltyList|getModuleList/.test(c.path))
    .forEach((c, i) => c.d.resolve(tailOf(MODULES)[i]));
  await flush();
  assert.match(h.host.innerHTML, /借书情况/);
}

console.log('PASS: 个人信息数据报告目录（随第二批取数 · 目录口径 · 站内直达 · 失败不牵连档案 · 刷新八路走 force）');
