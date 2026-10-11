// 模竞（mojinghub.com）通道的回归：三条 POST 接口的解析、id 隔离、翻页与失败语义。
//
// 起因：竞赛消息雷达原本只有三家 GET 站点，模竞是第一个 POST 源。它与另外三家有三处结构性差异，
// 光读代码断言不出来，只能真跑一遍源码：
//
// ① 接口永远回 HTTP 200，真状态在响应体的 `status` 字段（200 正常 / 102 token 解析错误 /
//    103 token 不能为空）。只看 res.status 会把「token 不能为空」当成成功，然后对着空数组
//    报「没有新消息」—— 用户以为站点没更新。
// ② 列表在 Laravel 分页器的 `data.data` 里，翻页字段是 current_page / last_page，
//    不是另外三家的 `data.records` / `data.list`。
// ③ 时间字段全是 Unix 秒（created_time / signup_end / published_at），没有现成的可读时间。
//
// 另外两条不变量沿用主用例的做法：条目 id 必须带源前缀（模竞的 competition_id 是自增小数字，
// 不隔离就会和摩课云的 newsId 串在一起）；首次抓取只建基线、不广播 notice:new。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../public/plugins/gx-news/main.js', import.meta.url), 'utf8');

/* ── 最小 DOM 桩：与 test-gx-news.mjs 同形，够 buildUI / paintChips / paintList 跑完 ── */
function makeNode() {
  const bySel = new Map();
  const node = {
    children: [], style: {}, dataset: {}, className: '', innerHTML: '', textContent: '', value: '',
    handlers: {},
    append(...cs) { node.children.push(...cs); },
    appendChild(c) { node.children.push(c); return c; },
    replaceChildren(...cs) { node.children = cs; },
    addEventListener(ev, fn) { (node.handlers[ev] ||= []).push(fn); },
    setAttribute() {},
    closest() { return null; },
    querySelector(sel) {
      if (!bySel.has(sel)) bySel.set(sel, makeNode());
      return bySel.get(sel);
    },
  };
  const set = new Set();
  node.classList = {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (on ? set.add(c) : set.delete(c))),
    contains: (c) => set.has(c),
  };
  return node;
}

/* ══════════ fixture：按真站响应的结构与写法裁剪 ══════════ */

const MOJING_API = 'https://admin.mojinghub.com';
const COMP_URL = `${MOJING_API}/api/Competition.Competition/index`;
const EVENTS_URL = `${MOJING_API}/api/Events.Events/index`;
const ARTICLE_URL = `${MOJING_API}/api/Article.Article/index`;

/** Laravel 分页器形状：{ status, data: { total, per_page, current_page, last_page, data: [...] } }。 */
const page = (rows, { current = 1, last = 1 } = {}) => JSON.stringify({
  status: 200,
  data: { total: rows.length, per_page: rows.length, current_page: current, last_page: last, data: rows },
});

/** 真站竞赛记录：时间全是秒级时间戳，级别在 wcompetitionlevel.level_name 里。 */
const COMP_ROWS = [
  { competition_id: 40, title: '2026年第十二届数维杯全国大学生数学建模挑战赛（秋季赛）',
    description: '数维杯自2015年创办，已成功举办十一届。', cover_image: 'https://mojing.yeeaf.net/a.jpg',
    header_img: '', created_time: 1785318298, update_time: 1788398913,
    signup_start: 1785427200, signup_end: 1795125600, stage: 1,
    wcompetitionlevel: { level_name: '国家级' } },
  { competition_id: 39, title: '大学生仿真建模应用挑战赛（国际组）',
    description: '面向海外高校的独立赛区。', cover_image: '',
    header_img: 'https://mojing.yeeaf.net/b.png',
    created_time: 1785200000, update_time: 0,
    signup_start: 1785300000, signup_end: 1794000000, stage: 1,
    wcompetitionlevel: { level_name: '国际级' } },
];

const EVENT_ROWS = [
  { events_id: 4, title: '2026年第十一届数维杯大学生数学建模夏令营',
    description: '暑期线下集训。', cover_image: 'https://mojing.yeeaf.net/c.png', header_img: '',
    created_time: 1779093481, update_time: 1785378213, signup_end: 1785427200, stage: 4,
    wEventslevel: { level_name: '全国性' }, organizational_unit: '某仿真学会' },
];

const ARTICLE_ROWS = [
  { article_id: 139, title: '论文格式规范|全国大学生仿真建模应用挑战赛',
    description: '', content: '<p>为了保证竞赛的公平、公正性，特制定本规范。</p>',
    cover: 'https://mojing.yeeaf.net/d.png', published_at: 1791626217, create_time: 1791626172,
    is_top: 1, news_channel: 'competition', competition_id: 40 },
  { article_id: 120, title: '关于平台服务时间调整的公告',
    description: '系统维护安排。', cover: '', published_at: 1791000000, create_time: 1791000000,
    is_top: 0, news_channel: '', competition_id: 0 },
];

/** 「地址 → 响应」，响应可以是对象，也可以是吃 body 的函数（翻页用例要用）。 */
function makeServer(map) {
  return (url, method, body) => {
    for (const [prefix, res] of map) {
      if (url.startsWith(prefix)) return typeof res === 'function' ? res(body, method) : res;
    }
    return { status: 404, body: '' };
  };
}
const serverOf = (map) => makeServer(map);
const compServer = (json, extra = []) => serverOf([[COMP_URL, () => ({ status: 200, body: json })], ...extra]);

async function settle(rounds = 16) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * 跑一遍插件。source 决定首屏落在哪个源上（模竞三条通道各是一个源）。
 * 桩的 http.fetch 记下 (sid, method, url, body) —— 模竞是 POST，必须验方法、请求头与请求体。
 */
async function boot({ source, server, knownIds } = {}) {
  const storage = new Map();
  storage.set('seen', []);
  if (source !== undefined) storage.set('source', source);
  if (knownIds !== undefined) storage.set('knownIds', knownIds);
  let renderFn = null;
  const root = makeNode();
  const calls = [], events = [], notices = [];
  const respond = server || compServer(page(COMP_ROWS));

  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, URL, Date, JSON, Math, Number, String, RegExp, Array, Object,
    Set, Map, Promise, Error, isNaN, parseInt, parseFloat,
    setInterval: () => 1, clearInterval: () => {},
    document: {
      getElementById: () => null,
      head: { append() {} },
      createElement: () => makeNode(),
    },
    tide: {
      storage: {
        async get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback; },
        async set(key, value) { storage.set(key, JSON.parse(JSON.stringify(value ?? null))); },
      },
      http: {
        async session() { return 'sid-1'; },
        async get(url) { calls.push({ sid: '', method: 'GET', url, body: '' }); return { status: 200, body: '', final_url: url, ...respond(url, 'GET', '') }; },
        async fetch(sid, method, url, opts = {}) {
          calls.push({ sid, method, url, body: String((opts && opts.body) || ''), headers: (opts && opts.headers) || {} });
          return { status: 200, body: '', final_url: url, ...respond(url, method, String((opts && opts.body) || '')) };
        },
      },
      ui: { registerView: (v) => { renderFn = v.render; } },
      events: { emit: (name, data) => events.push({ name, data }) },
      notify: (msg) => notices.push(String(msg)),
      tasks: { create: (t) => ({ id: 'task-1', ...t }) },
      blocks: { create: () => {} },
      util: {
        parseWhen: () => ({ date: '', startMin: null, endMin: null }),
        guessCategory: () => 'study', guessQuad: () => 'q3',
        hhmmOf: (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
        openUrl: () => {}, navigate: () => {},
        web: { resolveUrl: (u, base) => new URL(u, base).toString(), detectSpaShell: () => null },
      },
    },
  });
  vm.runInContext(src, ctx);
  assert.ok(renderFn, '插件必须注册视图');
  renderFn(root);
  await settle();

  const wrap = root.children[0];
  assert.ok(wrap, '插件必须挂出内容容器');
  const node = (sel) => wrap.querySelector(sel);
  const listNode = () => node('[data-list]');
  const moreBtn = () => {
    const more = listNode().children.find((c) => c.className === 'gx-more');
    return more && more.children.find((c) => c.className === 'gx-btn');
  };
  return {
    calls, events, notices, storage,
    status: () => node('.gx-status').innerHTML,
    list: () => listNode().innerHTML,
    sourceChips: () => node('[data-sources]').children.map((b) => b.textContent),
    /** 点源那一排的某个源（chip 文案与 manifest 名一致）。 */
    pickSource: async (label) => {
      const b = node('[data-sources]').children.find((x) => x.textContent === label);
      assert.ok(b, `源「${label}」必须渲染出来（现有：${node('[data-sources]').children.map((x) => x.textContent).join(' / ')}）`);
      b.handlers.click[0]();
      await settle();
    },
    /** 点「加载更早的消息（第 N 页）」 */
    clickMore: async () => {
      const b = moreBtn();
      assert.ok(b, '第 1 页还有更多时必须渲染出加载按钮');
      b.handlers.click[0]();
      await settle();
    },
    moreText: () => (moreBtn() || { textContent: '' }).textContent,
  };
}

/* ══════════ ① 竞赛通道：POST 形态 + 字段解析 ══════════ */

{
  const got = await boot({ source: 'mojing-comp' });

  // 模竞必须走 POST + JSON 请求头，且带一页条数；GET 会被服务端当成空 body 直接回 103。
  const call = got.calls.find((c) => c.url === COMP_URL);
  assert.ok(call, '模竞竞赛源必须请求 /api/Competition.Competition/index');
  assert.equal(call.method, 'POST', '模竞接口只认 POST');
  assert.equal(call.sid, 'sid-1', '模竞请求必须挂在 tide.http.session() 给出的会话上');
  assert.match(String(call.headers['Content-Type'] || ''), /application\/json/, 'POST 必须声明 JSON 请求体');
  assert.deepEqual(JSON.parse(call.body), { page: 1, limit: 40 }, '请求体是 { page, limit }');

  assert.doesNotMatch(got.status(), /抓取失败/, '桩接口本身要跑通，否则后面的断言都是空的');
  const html = got.list();
  assert.match(html, /数维杯全国大学生数学建模挑战赛/, '标题要渲染出来');
  assert.match(html, /数维杯自2015年创办/, 'description 要去标签当摘要');
  // 级别轴：接口原生 level_name「国家级」经词表归一到「全国」这一格（不是原样当 chip 用）。
  assert.match(html, /gx-tag lv">全国</, 'level_name=国家级 必须归一成级别轴的「全国」');
  assert.match(html, /gx-tag lv">国际</, 'level_name=国际级 必须归一成级别轴的「国际」');
  // 时间：created_time=1785318298 → 本地可读时间，年份必须是 2026（秒级时间戳被当成毫秒会掉到 1970）。
  assert.match(html, /2026-07-2\d \d\d:\d\d/, 'created_time 必须按 Unix 秒解成本地时间');
  // 详情地址：站点路由是 /competitions/:id，不是 /competitions/:slug。
  assert.match(html, /data-id="mojing-comp:40"/, '条目 id 必须带源前缀（competition_id 是自增小数字，不隔离会和摩课云串号）');
}

/* ══════════ ② 竞赛通道：报名截止落期 ══════════ */

{
  const got = await boot({ source: 'mojing-comp' });
  // signup_end=1795125600 → 2026-11-20 前后。卡片上要有截止日，转提醒时才落得了期。
  assert.match(got.list(), /11-1\d|11-20/, 'signup_end 必须解出来显示在卡片上');
}

/* ══════════ ③ 活动 / 资讯通道：各自的主键与通道字段 ══════════ */

{
  const got = await boot({ source: 'mojing-events', server: serverOf([[EVENTS_URL, () => ({ status: 200, body: page(EVENT_ROWS) })]]) });
  const call = got.calls.find((c) => c.url === EVENTS_URL);
  assert.ok(call && call.method === 'POST', '模竞活动源必须 POST /api/Events.Events/index');
  assert.match(got.list(), /数维杯大学生数学建模夏令营/, '活动标题要渲染出来');
  assert.match(got.list(), /data-id="mojing-events:4"/, '活动条目 id 必须带 mojing-events 前缀（events_id=4 与 competition_id=4 是两回事）');
  assert.doesNotMatch(got.status(), /抓取失败/);
}

{
  const got = await boot({ source: 'mojing-news', server: serverOf([[ARTICLE_URL, () => ({ status: 200, body: page(ARTICLE_ROWS) })]]) });
  const call = got.calls.find((c) => c.url === ARTICLE_URL);
  assert.ok(call && call.method === 'POST', '模竞资讯源必须 POST /api/Article.Article/index');
  assert.match(got.list(), /论文格式规范/, '资讯标题要渲染出来');
  assert.match(got.list(), /为了保证竞赛的公平/, 'content 要去标签当摘要（description 为空时兜底）');
  assert.match(got.list(), /data-id="mojing-news:139"/, '资讯条目 id 必须带 mojing-news 前缀');
  assert.match(got.list(), /2026-10-0\d|2026-10-1\d/, 'published_at 必须按 Unix 秒解成本地时间');
  assert.doesNotMatch(got.status(), /抓取失败/);
}

/* ══════════ ④ 失败语义：HTTP 200 但 body.status 非 200 ══════════ */

{
  const got = await boot({
    source: 'mojing-comp',
    server: compServer(JSON.stringify({ status: 103, msg: 'token不能为空' })),
  });
  assert.match(got.status(), /token不能为空/, 'body.status=103 必须当失败报出来，不能当成空列表');
  assert.match(got.status(), /抓取失败|失败/, '失败状态要出现在状态栏');
}

{
  const got = await boot({
    source: 'mojing-comp',
    server: compServer(JSON.stringify({ status: 102, msg: 'token解析错误' })),
  });
  assert.match(got.status(), /token解析错误/, 'body.status=102 同样要报出来');
}

/* 非 JSON 响应（网关返回 HTML 错误页）也不能把插件卡死 */
{
  const got = await boot({ source: 'mojing-comp', server: compServer('<html><body>502 Bad Gateway</body></html>') });
  assert.match(got.status(), /不是 JSON/, '非 JSON 响应要给出可读原因');
}

/* ══════════ ⑤ 翻页：hasMore 由 last_page 决定，第 2 页不覆盖第 1 页 ══════════ */

{
  const got = await boot({
    source: 'mojing-comp',
    server: serverOf([[COMP_URL, (body) => {
      const p = JSON.parse(body || '{}').page || 1;
      return { status: 200, body: p === 1 ? page(COMP_ROWS, { current: 1, last: 2 }) : page([{ ...COMP_ROWS[0], competition_id: 38, title: '第二页才有的老竞赛' }], { current: 2, last: 2 }) };
    }]]),
  });
  assert.match(got.moreText(), /第 2 页/, 'last_page=2 时必须给出加载更早消息的入口');
  await got.clickMore();
  const html = got.list();
  assert.match(html, /第二页才有的老竞赛/, '第 2 页的条目要并进来');
  assert.match(html, /数维杯全国大学生数学建模挑战赛/, '第 1 页的条目不能被第 2 页顶掉');
  assert.doesNotMatch(got.moreText(), /第 3 页/, 'last_page=2 时第 2 页之后不该再有加载入口');
}

/* ══════════ ⑥ 首次抓取只建基线，不广播 notice:new ══════════ */

{
  const got = await boot({ source: 'mojing-comp' });
  assert.equal(got.events.filter((e) => e.name === 'notice:new').length, 0,
    '该源第一次抓取（没有 knownIds 快照）只能建基线，不能把整页当成新消息推给微信推送插件');
  const known = got.storage.get('knownIds');
  assert.ok(known && Array.isArray(known['mojing-comp']), '抓完第 1 页必须落一份该源的 id 快照');
  assert.ok(known['mojing-comp'].includes('mojing-comp:40'), '快照里是带源前缀的条目 id');
}

/* 有基线且出现新条目 → 广播；快照按源隔离，模竞的新条目不该带进摩课云的名单里 */
{
  const got = await boot({
    source: 'mojing-comp',
    knownIds: { 'mojing-comp': ['mojing-comp:39'] },
  });
  const broadcast = got.events.filter((e) => e.name === 'notice:new');
  assert.equal(broadcast.length, 1, '第 1 页出现基线里没有的条目必须广播一次');
  assert.equal(broadcast[0].data.source, 'gx-news', '广播来源固定是插件 id');
  assert.equal(broadcast[0].data.total, 1, '只广播增量那一条');
  assert.match(broadcast[0].data.sourceName, /模竞竞赛/, '来源名要带上具体源名，微信推送里才分得清是哪一家');
  const known = got.storage.get('knownIds');
  assert.deepEqual(known['mojing-comp'], ['mojing-comp:40', 'mojing-comp:39'], '广播后快照更新成当前第 1 页');
}

/* ══════════ ⑦ 源那一排要能看见模竞三条通道 ══════════ */

{
  const got = await boot({ source: 'mojing-comp' });
  const labels = got.sourceChips();
  for (const want of ['模竞竞赛', '模竞活动', '模竞资讯']) {
    assert.ok(labels.includes(want), `源那一排必须有「${want}」（现有：${labels.join(' / ')}）`);
  }
}

console.log('PASS: 模竞通道解析、id 隔离、翻页与失败语义');
