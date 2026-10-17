// 「个人信息 → 数据报告目录」（v0.240.0）。
//
// 用户口径：个人信息页只有 5 个档案字段，下面大片空白 —— 要问的是「同一个网址还能取到什么」。
// 答案就是这页背后的 pdata 还有一整组「数据报告」目录（basicInfo 只是其中之一）。
//
// 本测试盯四件事：
//   ① 目录必须在**档案落地之后**才发请求（首屏不许等第二个接口）；
//   ② 目录接口失败不牵连档案 —— 字段照样能复制，只是少一张卡；
//   ③ key 的两种形态都要认：CATALOGID 直给，或老接口只给 "1-13-basicInfo" 这种复合 id；
//   ④ 点一格必须走 bridge.open('/stu/dataReport/<key>')，这条通道才带得上会话。
import assert from 'node:assert/strict';

/* paint() 只写 root.innerHTML，bind() 只读 querySelector / querySelectorAll
   （返回 null / [] 时所有接线都被 if 挡住），styles() 只需要能 append。 */
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({}),
  head: { append: () => {} },
};

const { createProfileView } = await import('../public/plugins/cppu-notify/profile.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
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
  return { calls, opened, bridge, host, view, find };
}

const PROFILE = {
  ok: true,
  data: {
    personInfo: { USERNAME: '梁逸乐', USERID: '2025290058', SEX: '1' },
    column: [{ dataField: 'RXNF', dataFieldName: '入学年份' }],
  },
};
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

/* ── ① 两批落画面：档案先出，目录后补 ───────────────────────────────────── */
{
  const h = harness();
  h.view.render(h.host);
  await flush();

  assert.equal(h.calls.length, 1, '首屏只该先要档案，目录是第二屏');
  assert.match(h.calls[0].path, /\/tsa\/shc\/homepage\/personInfo$/, '第一枪必须还是 personInfo');
  assert.match(h.host.innerHTML, /正在读取个人信息…/, '数据没到之前要有占位');

  h.calls[0].d.resolve(PROFILE);
  await flush();

  assert.match(h.host.innerHTML, /梁逸乐/, '档案到了先把身份卡与字段画出来');
  assert.equal(h.calls.length, 2, '档案落地后才去补目录');
  assert.match(h.calls[1].path, /\/tsa\/shc\/customStyle\/getModuleList/, '第二个接口是目录清单');
  assert.doesNotMatch(h.host.innerHTML, /数据报告目录/, '目录还没回来时不许先摆一个空壳');

  h.calls[1].d.resolve(MODULES);
  await flush();

  const html = h.host.innerHTML;
  assert.match(html, /数据报告目录/, '目录回来要把卡片画出来');
  assert.match(html, /3 个 · 点开直达/, '条数要对得上（重名 / 缺 key 的会剔掉）');
  assert.match(html, /借书情况/);
  assert.match(html, /成绩单/);
  assert.match(html, /个人信息只是「数据报告」下的一个目录|上面这些与「个人信息」同站同权限/, '要说明这批目录和本页的关系');
  assert.doesNotMatch(html, /暂无/, '不该冒出空态文案');

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
  h.calls[0].d.resolve(PROFILE);
  await flush();
  h.calls[1].d.resolve({ ok: false, message: '个人成长中心返回 502' });
  await flush();

  assert.match(h.host.innerHTML, /梁逸乐/, '目录挂了不影响档案');
  assert.match(h.host.innerHTML, /入学年份/, '字段照样要能看能复制');
  assert.doesNotMatch(h.host.innerHTML, /数据报告目录/, '没数据就不摆空卡');
  assert.doesNotMatch(h.host.innerHTML, /502/, '目录失败不弹错 —— 它不是本页主体');
}

/* ── ④ 点「刷新」：档案与目录都必须走 force ─────────────────────────────── */
{
  const h = harness();
  h.view.render(h.host);
  await flush();
  h.calls[0].d.resolve(PROFILE);
  await flush();
  h.calls[1].d.resolve(MODULES);
  await flush();

  const before = h.calls.length;
  // 工具栏那颗「刷新」：走的是 loadAll(true)，不是 refresh() 的 TTL 分支
  h.host.onclick({ target: { closest: (sel) => (sel === '[data-pf-refresh]' ? {} : null) } });
  await flush();

  const fresh = h.calls.slice(before);
  assert.equal(fresh.length, 1, '刷新先重取档案');
  assert.equal(fresh[0].force, true, '刷新必须绕缓存');
  assert.match(fresh[0].path, /\/personInfo$/);
  fresh[0].d.resolve(PROFILE);
  await flush();

  const after = h.calls.slice(before + 1);
  assert.equal(after.length, 1, '档案回来后要一起刷新目录');
  assert.equal(after[0].force, true, '目录也要绕缓存，否则刷新看到的是旧目录');
  assert.match(after[0].path, /\/getModuleList/);
  after[0].d.resolve(MODULES);
  await flush();
  assert.match(h.host.innerHTML, /借书情况/);
}

console.log('PASS: 个人信息数据报告目录（第二屏取数 · 目录口径 · 站内直达 · 失败不牵连档案 · 刷新走 force）');
