/* 个人信息（含成长数据）页的本地缓存（v0.268.0 起，v0.281.0 两页合一时保持）
 *
 * 需求原话：这个界面不用每一次打开都刷新，默认用缓存直到一个月后，要「无感」。
 * 所以这里验的不是「有缓存文件」，而是四件事：
 *   ① 第一次抓完必须把快照落盘（tide.cache，不进 data.json）；
 *   ② 30 天内重开（**新的视图实例**才等于重启应用）⇒ 一个请求都不发，直接画上次那份；
 *   ③ 超过 30 天 ⇒ 必须自己重抓，不能一年后还在画旧数据；
 *   ④ 快照坏了 / 只有半页 / 宿主没 tide.cache ⇒ 退回取数，不许把页面画成空白。
 * 另外钉住两条容易被"优化"掉的口径：
 *   · 抓取**没到半数**的那次不许落盘，否则一次断网就把「暂无」写死 30 天；
 *   · v0.281.0 合并前的 `growthSnapshot` 只可能是半页数据，读到就删，不许再当缓存用。
 */
import assert from 'node:assert/strict';

/* paint() 只写 root.innerHTML；bind() 只读 querySelector(All)。
   styles() 要 document.getElementById / createElement —— 全部给最小替身。 */
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ append: () => {} }),
  head: { append: () => {} },
};

const { createProfileView } = await import('../public/plugins/cppu-notify/profile.js');

const DAY = 24 * 60 * 60 * 1000;
const SNAPSHOT_KEY = 'profileSnapshot';
const LEGACY_KEY = 'growthSnapshot';
const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

/* 磁盘缓存替身：值的拷贝都过一遍 JSON，跟真实落盘一致（否则测试会因为共享引用假通过）。
   remove 是宿主 vue- 侧的名字（pluginCache.js 返回的是 remove，没有 delete）。 */
function fakeCache(seed = null, seedKey = SNAPSHOT_KEY) {
  const map = new Map();
  if (seed) map.set(seedKey, JSON.parse(JSON.stringify(seed)));
  return {
    map,
    get: async (k, d = null) => (map.get(k) == null ? d : JSON.parse(JSON.stringify(map.get(k)))),
    set: async (k, v) => { map.set(k, v == null ? null : JSON.parse(JSON.stringify(v))); },
    remove: async (k) => { map.delete(k); },
  };
}

/* 8 个接口的应答；mode 决定全部成功还是后半截失败（验「半页不落盘」）。 */
const OK = (p) => {
  if (p.includes('/personInfo')) return { ok: true, data: { personInfo: { USERNAME: '张三', USERID: '2025000001' }, column: [] } };
  if (p.includes('/learnSituation')) return { ok: true, data: { GOTTENUNIT: 218, TOTALUNIT: 59.6 } };
  if (p.includes('/getKpiList')) return { ok: true, data: [{ FORMNAME: '图书借阅数', KPICONFIG: 12, KPI_COLOR: '#118AB2', WID: 'w1' }] };
  if (p.includes('/cardConsume')) return { ok: true, data: { placeRanking: [{ MERCHANT: '食堂', SPENDGMONEY: 12 }], balance: { BALANCE: 88.5, TOTALAMOUNT: 300 } } };
  if (p.includes('/onlineState')) return { ok: true, data: { placeRanking: [] } };
  if (p.includes('/getMyAttendance')) return { ok: true, data: [] };
  if (p.includes('/bonusPenaltyList')) return { ok: true, data: [] };
  if (p.includes('/getModuleList')) return { ok: true, data: [] };
  return { ok: false, message: `unexpected path ${p}` };
};
const FAIL = { ok: false, message: '校园网不通' };

function bridge(mode = 'ok') {
  const calls = [];
  const answer = (p) => (mode === 'tail-fail' && /cardConsume|onlineState|getMyAttendance|bonusPenaltyList|getModuleList/.test(p) ? FAIL : OK(p));
  return {
    calls,
    api: (p) => { calls.push({ path: p, force: false }); return Promise.resolve(answer(p)); },
    force: (p) => { calls.push({ path: p, force: true }); return Promise.resolve(answer(p)); },
    open: () => {},
    relogin: async () => 'ok',
  };
}

const tideStub = (cache) => ({
  cache,
  storage: { get: async (k, d) => d, set: async () => {} },
  ui: { selectionGlow: () => null, waitMask: () => () => {} },
  notify: () => {},
});
const host = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });

/* 一份「完整」的旧快照：dirs 是 v0.281.0 起的数据报告目录字段（旧版叫 modules）。 */
const seedOf = (savedAt, extra = {}) => ({
  savedAt,
  profile: { USERNAME: '张三', USERID: '2025' },
  photo: '',
  fields: [],
  learn: { GOTTENUNIT: 218 },
  kpi: [{ FORMNAME: '图书借阅数', WID: 'w1', KPI_COLOR: '#118AB2' }],
  consume: { placeRanking: [{ MERCHANT: '食堂' }], balance: { BALANCE: 88.5 } },
  online: null,
  attend: [],
  bonus: [],
  dirs: [],
  ...extra,
});

/* ① 第一次：全部成功 ⇒ 落盘，且快照里该有的都在 */
{
  const cache = fakeCache();
  const b = bridge();
  const h = host();
  const view = createProfileView(tideStub(cache), b);
  view.render(h);
  await flush();

  assert.equal(b.calls.length, 8, '首次进入必须把 8 个接口发出去');
  assert.match(h.innerHTML, /张三/);
  assert.match(h.innerHTML, /食堂/);

  const snap = cache.map.get(SNAPSHOT_KEY);
  assert.ok(snap, '抓完必须把快照写进 tide.cache');
  assert.ok(Math.abs(Date.now() - Number(snap.savedAt)) < 60 * 1000, '快照要记真实抓取时刻');
  assert.equal(snap.profile.USERNAME, '张三', '身份卡要进快照');
  assert.equal(snap.consume.balance.BALANCE, 88.5, '第二批数据也要进快照');
  assert.equal(snap.kpi[0].FORMNAME, '图书借阅数', 'KPI 卡片要进快照');
  assert.equal(snap.error, undefined, 'error / stale 这类当下状态不许进快照');
}

/* ② 30 天内重开（新实例 = 重启应用）⇒ 零请求，直接画缓存 */
{
  const cache = fakeCache(seedOf(Date.now() - 20 * DAY));
  const b = bridge();
  const h = host();
  createProfileView(tideStub(cache), b).render(h);
  await flush();

  assert.equal(b.calls.length, 0, '一个月内打开不该发任何请求（这就是"无感"）');
  assert.match(h.innerHTML, /张三/, '缓存要立刻画出身份卡');
  assert.match(h.innerHTML, /食堂/, '缓存里的第二批数据也在');
  assert.doesNotMatch(h.innerHTML, /正在读取个人信息…/, '有缓存就不该停在整页占位');
  assert.match(h.innerHTML, /更新于/, '仍要给出数据的时间戳（用抓取那一刻，不是打开这一刻）');
  assert.match(h.innerHTML, /一个月内直接显示本地缓存/, '工具栏要说明这是缓存口径');
}

/* ②b 合并前的 growthSnapshot：读盘时删掉，不许当缓存（它只可能是半页） */
{
  const cache = fakeCache(seedOf(Date.now() - 2 * DAY), LEGACY_KEY);
  const b = bridge();
  const h = host();
  createProfileView(tideStub(cache), b).render(h);
  await flush();
  assert.equal(b.calls.length, 8, '旧 key 不是缓存，必须重新取数');
  assert.equal(cache.map.has(LEGACY_KEY), false, '旧 key 读到就删，别继续占地方');
  assert.ok(cache.map.get(SNAPSHOT_KEY), '重抓后写的是新 key');
}

/* ③ 超过 30 天 ⇒ 必须重抓 */
{
  const cache = fakeCache(seedOf(Date.now() - 31 * DAY, { profile: { USERNAME: '李四' }, kpi: [] }));
  const b = bridge();
  const h = host();
  createProfileView(tideStub(cache), b).render(h);
  await flush();

  assert.equal(b.calls.length, 8, '过了 30 天要自己重抓');
  assert.match(h.innerHTML, /张三/, '画的是新抓那份');
  assert.doesNotMatch(h.innerHTML, /李四/, '不许把过期快照里的旧人画出来');
  const snap = cache.map.get(SNAPSHOT_KEY);
  assert.ok(Number(snap.savedAt) > Date.now() - 60 * 1000, '重抓成功后要刷新快照时间');
}

/* ④ 坏快照 / 半页快照 ⇒ 当没有缓存（宁可重抓，也不许画半页） */
for (const bad of [
  { savedAt: Date.now() - DAY },                                  // 没有身份卡
  { savedAt: Date.now() - DAY, profile: null },                    // 身份卡是空
  { savedAt: Date.now() - DAY, profile: 'oops' },                  // 形状不对
  { savedAt: 0, profile: { USERNAME: '张三' } },                    // 时间是 0
]) {
  const cache = fakeCache(bad);
  const b = bridge();
  const h = host();
  createProfileView(tideStub(cache), b).render(h);
  await flush();
  assert.equal(b.calls.length, 8, `坏快照 ${JSON.stringify(bad).slice(0, 40)} 要退回取数`);
  assert.match(h.innerHTML, /张三/);
}

/* ⑤ 抓取只到一半（首屏齐、后五块全灭）⇒ 不许落盘，别把「暂无」写死 30 天 */
{
  const old = seedOf(Date.now() - 40 * DAY);
  const cache = fakeCache(old);
  const b = bridge('tail-fail');
  const h = host();
  createProfileView(tideStub(cache), b).render(h);
  await flush();
  assert.equal(b.calls.length, 8);
  assert.equal(cache.map.get(SNAPSHOT_KEY).savedAt, old.savedAt, '半页结果不许盖掉上一份完整快照');
}

/* ⑥ 老宿主没有 tide.cache ⇒ 照常取数，不许抛 */
{
  const b = bridge();
  const h = host();
  const tide = { storage: { get: async (k, d) => d, set: async () => {} }, ui: { selectionGlow: () => null, waitMask: () => () => {} }, notify: () => {} };
  createProfileView(tide, b).render(h);
  await flush();
  assert.equal(b.calls.length, 8, '没有缓存层也要能正常取数');
  assert.match(h.innerHTML, /张三/);
}

/* ⑦ 一个月内手动刷新 ⇒ 必须真的重打（缓存只能拦住「自动重开」，不能拦住用户按刷新） */
{
  const cache = fakeCache(seedOf(Date.now() - 3 * DAY));
  const b = bridge();
  const h = host();
  const view = createProfileView(tideStub(cache), b);
  view.render(h);
  await flush();
  assert.equal(b.calls.length, 0, '自动重开零请求');

  view.refresh();
  await flush();
  assert.equal(b.calls.length, 8, '手动刷新要重打 8 个接口');
  assert.ok(b.calls.every((c) => c.force), '刷新必须带 force，否则主进程那份缓存会把请求吃掉');
  assert.ok(Number(cache.map.get(SNAPSHOT_KEY).savedAt) > Date.now() - 60 * 1000, '刷新成功后快照时间要更新');
}

console.log('PASS: 个人信息页本地缓存（30 天快照 · 打开零请求 · 过期自愈 · 旧 growthSnapshot 清掉 · 坏快照与半页结果不落盘 · 刷新走 force · 无缓存层降级）');
