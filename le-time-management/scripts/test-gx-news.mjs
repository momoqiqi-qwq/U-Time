// 竞赛消息雷达（gx-news）的回归：残留筛选自愈 + 多源抓取。
//
// 起因一：APK 上「拉取 40 条 · 显示 0 条」被当成抓取失败 —— 实际是上次点的时间筛选存成了
// 绝对值，跨月之后一条也命不中，界面上完全看不出还在过滤。手机与电脑各存各的 data.json，
// 所以只有一端表现异常。v0.9.0 把「月份」那一排 chip 换成两个日期框（范围可跨月、可单边），
// 「筛不到就静静滤着」这个故障形态没变，自愈与列名两条不变量照旧压在这里。
//
// 起因二：插件从「只有摩课云一个源」改成多源（摩课云 / 赛氪 / 我要参赛网 + 自定义）。三家的响应
// 形态完全不同：点分复合标签的 JSON 接口、只给 Unix 时间戳的 JSON 接口、GBK 编码的 Discuz HTML。
// 光读代码没法确信字段解析与 id 隔离都对，所以 fixture 按真站响应的结构与写法裁剪而成。
//
// 起因三：分类原本挤在一个 `type` 字段里，三种语义混着用 —— 摩课云的消息性质（202/203）、赛氪的
// 赛事级别（全国性/省级）、我要参赛网的站点分类（公益大赛）。换源就作废、站点叫法直接当 chip。
// 现在拆成三条正交轴（kind 性质 / level 级别 / field 学科），每轴一张封闭表，原生标签经表归一，
// 认不出留空、不设「其他」占格子。这一层的不变量（归一、跨源保留、单值收行）同样只能真跑源码验。
//
// 不变量都必须真跑源码才断言得出来，正则匹配只能证明「我写了这行」。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// 插件经 tide.util.web 用的就是宿主这两个函数，测试也引真的：自己拼一份假语义，测过了也不作数。
import { resolveWebUrl, detectSpaShell } from '../src/webContent.js';

const src = fs.readFileSync(new URL('../public/plugins/gx-news/main.js', import.meta.url), 'utf8');

/* ── 最小 DOM 桩：够 buildUI / paintChips / paintList / 添加源浮层跑完 ── */
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

/* ══════════ fixture ══════════ */

const MOKEROAD_API = 'https://www.gxxsjs.com/prod-api/home/competition/news/page';
const SAIKR_API = 'https://apiv4buffer.saikr.com/api/pc/contest/lists';
const JINGSAI_HOME = 'https://www.52jingsai.com/bisai/';

const rec = (id, publishTime, newsType = '202') => ({ newsId: id, newsTitle: `消息 ${id}`, newsType, publishTime, newsInfo: '<p>正文</p>' });
const SEPTEMBER = [rec(1, '2026-09-12 10:00:00'), rec(2, '2026-09-03 08:30:00', '202.204')];
const mokeroadBody = (records) => JSON.stringify({ code: 0, data: { records } });

/** 赛氪：列表页是 Vue 空壳，数据在 apiv4buffer 接口里；时间只给 Unix 秒，详情地址是 `vse/xxx` 相对形式。 */
const SAIKR_BODY = JSON.stringify({ code: 200, msg: '', data: { total: 5121, list: [
  { contest_id: 57786, contest_name: '第六届大学生心理知识大赛·全国赛', contest_url: 'vse/psy2026',
    regist_start_time: 1775707200, regist_end_time: 1790351999, contest_start_time: 0,
    thumb_pic: 'https://publicqn.saikr.com/a.png', level_name: '全国性',
    organiser: '某心理学普及工作委员会', enter_range: '全国', time_name: '正在报名' },
  { contest_id: 58309, contest_name: '大学生英语阅读大赛（分赛区）', contest_url: 'vse/2026/ER',
    regist_start_time: 1779638400, regist_end_time: 1790434800, contest_start_time: 1790384400,
    thumb_pic: 'https://publicqn.saikr.com/b.png', level_name: '省级',
    organiser: '某寓言文学研究会', enter_range: '全国', time_name: '即将截止' },
] } });

/** 我要参赛网：Discuz 门户 block。要害在 `<base href>` 指站点根，而条目链接是裸的 `article-x-1.html`。 */
const JINGSAI_BODY = `<!DOCTYPE html>
<html><head><base href="https://www.52jingsai.com/" /></head><body><div class="xld">
<dl class="bbda list_bbda cl">
<div class="atc"><a href="article-24056-1.html" target="_blank"><img src="data/attachment/portal/202609/17/a.png.thumb.jpg" alt="高校文学知识竞答活动" class="tn" /></a></div>
<dt class="xs2_tit"><a href="article-24056-1.html" target="_blank" class="xi2"  style="">高校文学知识竞答活动</a> </dt>
<dd class="xs2 cl">
高校文学知识竞答活动，答题领证书||报名时间：2026年9月16日至2027年5月31日||主办单位:某校园文学协会
<div class="list_info">
分类: <label><a href="https://www.52jingsai.com/bisai/gggy/gongyi/" class="xi2">公益大赛</a></label>&nbsp;&nbsp;<span class="xg1"> </span>
 2026-9-17 17:49
<span class="chakan"> 211</span>
</div>
</dd>
</dl>
<dl class="bbda list_bbda cl">
<div class="atc"><a href="article-24054-1.html" target="_blank"><img src="data/attachment/portal/202609/17/b.jpg.thumb.jpg" alt="数字IP形象征集" class="tn" /></a></div>
<dt class="xs2_tit"><a href="article-24054-1.html" target="_blank" class="xi2"  style="">数字IP形象征集</a> </dt>
<dd class="xs2 cl">
数字IP形象征集；征集截止日期：2026年11月21日
<div class="list_info">
分类: <label><a href="https://www.52jingsai.com/bisai/keji/sheji/" class="xi2">设计比赛</a></label>
 2026-9-17 17:14
</div>
</dd>
</dl>
</div></body></html>`;

/** 自定义源的三种形态：RSS 2.0（RFC 822 日期）、字段名跟内置三家全不一样的 JSON 接口、普通 HTML 列表。 */
const RSS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>某校竞赛公告</title><link>https://cms.example.edu.cn/contest/</link>
<item><title>关于举办2026年大学生数学建模竞赛校内选拔的通知</title>
<link>https://cms.example.edu.cn/contest/1207.htm</link>
<guid>https://cms.example.edu.cn/contest/1207.htm</guid>
<pubDate>Fri, 18 Sep 2026 09:30:00 +0800</pubDate>
<description>请各学院组织参赛，作品提交截至 9 月 30 日。</description></item>
<item><title>第二十一届大学生广告艺术大赛征集公告</title>
<link>/contest/1199.htm</link><pubDate>2026-09-11T15:20:00Z</pubDate></item>
</channel></rss>`;

const JSON_API_BODY = JSON.stringify({ status: 1, info: { rows: [
  { actId: 9001, actName: '全国大学生电子商务挑战赛校内选拔', actLink: '/act/9001',
    showTime: '2026-09-15 08:00', memo: '校赛报名中', picUrl: '/pic/9001.jpg' },
  { actId: 9002, actName: '大学生智能汽车竞赛分赛区赛', showTime: 1789000000, memo: '' },
] } });

const HTML_LIST_BODY = `<!DOCTYPE html><html><body>
<div id="nav"><a href="/">首页</a><a href="/login">登录</a><a href="/more">更多</a></div>
<ul class="contest-list">
  <li><a href="/js/2026/1012.html">全省大学生统计建模大赛报名通知</a><span class="date">2026-09-18</span></li>
  <li><a href="/js/2026/1009.html">高校计算机能力挑战赛赛项说明会</a><span class="date">2026/9/12</span></li>
  <li><a href="/js/2026/1003.html">这一条行内没有日期只能排到后面去</a></li>
</ul>
</body></html>`;

const SPA_SHELL_BODY = '<!DOCTYPE html><html><body><div id="__nuxt"></div><script src="/_nuxt/i.js"><\\/script></body></html>';

/** 把「地址前缀 → 响应」装成假服务器。 */
function makeServer(map) {
  return (url) => {
    for (const [prefix, res] of map) if (url.startsWith(prefix)) return typeof res === 'function' ? res(url) : res;
    return { status: 404, body: '' };
  };
}
/** 只有摩课云一家会响应（旧用例的默认世界）。 */
const serverOf = (records) => makeServer([[MOKEROAD_API, () => ({ body: mokeroadBody(records) })]]);

/** fixture 的 <base href>，用来对照插件该按哪个根解析相对链接。 */
function baseOf(html, pageUrl) {
  const m = html.match(/<base\b[^>]*>/i);
  if (!m) return pageUrl;
  const href = (m[0].match(/href\s*=\s*["']([^"']+)/i) || [])[1];
  return href ? resolveWebUrl(href, pageUrl) : pageUrl;
}

/** render → loadPrefs → buildUI → fetchList 全是微任务，多让几轮直到首屏刷完。 */
async function settle(rounds = 14) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * 用给定数据跑一遍插件：写入持久化 → render → 等抓取与首屏刷新全部落定。
 * @param {{filter?: unknown, seen?: unknown[], knownIds?: unknown, source?: string,
 *          customSources?: Array<object>, records?: Array<object>, server?: Function}} setup
 */
async function boot({ filter, seen = [], records = [], knownIds, source, customSources, server } = {}) {
  const storage = new Map();
  storage.set('seen', seen);
  if (filter !== undefined) storage.set('filter', filter);
  if (knownIds !== undefined) storage.set('knownIds', knownIds);
  if (source !== undefined) storage.set('source', source);
  if (customSources !== undefined) storage.set('customSources', customSources);
  let renderFn = null;
  const root = makeNode();
  const requests = [], events = [], notices = [], opened = [], created = { tasks: [], blocks: [] };
  const respond = server || serverOf(records);

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
        async get(url) {
          requests.push(url);
          return { status: 200, body: '', final_url: url, content_type: 'text/html', ...respond(url) };
        },
      },
      ui: { registerView: (v) => { renderFn = v.render; } },
      events: { emit: (name, data) => events.push({ name, data }) },
      notify: (msg) => notices.push(String(msg)),
      tasks: { create: (t) => { created.tasks.push(t); return { id: 'task-1', ...t }; } },
      blocks: { create: (b) => created.blocks.push(b) },
      util: {
        // parseWhen 一律解不出时间，专门用来压「接口给了报名截止就按它兜底」那条路
        parseWhen: () => ({ date: '', startMin: null, endMin: null }),
        guessCategory: () => 'study', guessQuad: () => 'q3',
        hhmmOf: (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
        openUrl: (u) => opened.push(String(u)), navigate: () => {},
        web: { resolveUrl: resolveWebUrl, detectSpaShell },
      },
    },
  });
  vm.runInContext(src, ctx);
  assert.ok(renderFn, '插件必须注册视图');
  renderFn(root);
  await settle();

  // buildUI 把内容挂进自己 new 出来的 wrap，所有 data-* 都从 wrap 上查，不是从挂载点 root 上查
  const wrap = root.children[0];
  assert.ok(wrap, '插件必须挂出内容容器');
  const node = (sel) => wrap.querySelector(sel);
  const listNode = () => node('[data-list]');
  const cards = () => (listNode().innerHTML.match(/class="gx-card/g) || []).length;

  return {
    requests, events, notices, opened, created, storage,
    stored: (key = 'filter') => storage.get(key),
    status: () => node('.gx-status').innerHTML,
    get list() { return listNode(); },
    cards,
    chipLabels: (sel) => node(sel).children.map((b) => b.textContent),
    /** 三条分类轴（kind 性质 / level 级别 / field 学科）各自的 chip 文案与整行是否收掉。 */
    axisLabels: (axis) => node(`[data-axis-chips="${axis}"]`).children.map((b) => b.textContent),
    axisHidden: (axis) => node(`[data-axis-bar="${axis}"]`).style.display === 'none',
    clickChip: async (sel, label) => {
      const b = node(sel).children.find((x) => x.textContent === label);
      assert.ok(b, `chip「${label}」必须渲染出来（现有：${node(sel).children.map((x) => x.textContent).join(' / ')}）`);
      b.handlers.click[0]();
      await settle();
    },
    clearButton: () => listNode().children.find((c) => c.dataset.clearFilters === '1'),
    clickList: (target) => listNode().handlers.click.forEach((f) => f({ target })),
    /** 时间范围那一行（v0.9.0 起是两个原生日期框，不再是月份 chip）。 */
    rangeNode: (which) => node(which === 'from' ? '[data-range-from]' : '[data-range-to]'),
    rangeChars: () => ({ from: node('[data-range-from]').value, to: node('[data-range-to]').value }),
    rangeHint: () => node('[data-range-cap]').textContent,
    rangeClearDisabled: () => node('[data-range-clear]').disabled,
    /** 填日期框并按 `change` 提交（真日期框选完 / 键盘改完失焦走的就是这条路）。 */
    fillRange: async (from, to) => {
      const box = node('[data-range-from]'), box2 = node('[data-range-to]');
      if (from !== undefined) box.value = from;
      if (to !== undefined) box2.value = to;
      (from !== undefined ? box : box2).handlers.change[0]();
      await settle(8);
    },
    /** 点「✕ 不限」。 */
    clearRange: async () => {
      node('[data-range-clear]').handlers.click[0]();
      await settle(8);
    },
    /** 走一遍「＋ 添加源」浮层：填地址 → 点「检测并添加」，返回浮层上的结果提示文案。 */
    addSourceViaDialog: async (url, name = '') => {
      await node_addSource(node);
      const mask = wrap.children[wrap.children.length - 1];
      assert.ok(mask && mask.className === 'gx-mask', '点「＋ 添加源」必须挂出浮层');
      mask.querySelector('.gx-dlg-url').value = url;
      mask.querySelector('.gx-dlg-name').value = name;
      mask.handlers.click[0]({ target: { closest: (sel) => (sel === '[data-act="save"]' ? {} : null) } });
      await settle();
      return mask.querySelector('.gx-res').textContent;
    },
  };
}

/** 点源那一排的「＋ 添加源」。 */
async function node_addSource(node) {
  const add = node('[data-sources]').children.find((b) => b.textContent === '＋ 添加源');
  assert.ok(add, '源那一排必须有一颗「＋ 添加源」');
  add.handlers.click[0]();
  await settle(4);
}

/* ══════════ ① 残留筛选自愈（v0.60.1 的三条不变量在多源下必须依然成立） ══════════ */

/* 命不中的时间范围 → 抓完第 1 页静默清空并落盘（v0.9.0 起范围取代了绝对月份，
   但「绝对值筛不到东西就静静滤着」这个故障形态一模一样，必须同样自愈）。 */
{
  const got = await boot({
    filter: { kw: '', kind: 'all', level: 'all', field: 'all', from: '2026-05-01', to: '2026-05-31', hideSeen: false, auto: false, showCover: false },
    records: SEPTEMBER,
  });
  const f = got.stored();
  assert.equal(f.from, '', '跨月后残留的时间范围必须自动清空（原样留着就是「日期框里写着 5 月却显示 0 条」）');
  assert.equal(f.to, '', '范围是一体的：清就从两端一起清，不留半截「5 月 1 日之后」');
  assert.doesNotMatch(got.status(), /抓取失败/, '桩接口本身要跑通，否则后面的断言都是空的');
  assert.ok(!/被筛选全部滤掉/.test(got.list.innerHTML), '范围自愈后不该再走空态');
}

/* 仍然命中的范围要保留，别把用户的选择抹掉 */
{
  const got = await boot({ filter: { from: '2026-09-01', to: '2026-09-30' }, records: SEPTEMBER });
  assert.equal(got.stored().from, '2026-09-01', '命得中的范围不能被自愈逻辑顺手清掉');
  assert.equal(got.stored().to, '2026-09-30', '下界同理');
  assert.equal(got.cards(), 2, '9 月两条都落在范围里');
}

/* 旧版的绝对月份要迁成同一个月的时间范围：老设备升级后原来选的那个月还生效 */
{
  const got = await boot({ filter: { month: '2026-09' }, records: SEPTEMBER });
  const f = got.stored();
  assert.equal(f.from, '2026-09-01', 'month「2026-09」迁成区间下界 = 月初');
  assert.equal(f.to, '2026-09-30', 'month「2026-09」迁成区间上界 = 月末（不是月初，否则整个月只剩 1 日）');
  assert.equal(f.month, undefined, '旧的 month 字段要就地删掉，不能留在持久化里当第二个事实源');
  assert.equal(got.cards(), 2, '迁移后那一个月照旧命中');
}

/* 脏持久化值全部归一：旧分类码要迁到新轴上、写坏的时间范围要作废（只看行为，不看回写） */
{
  const got = await boot({ filter: { type: '203', month: '2026-9' }, records: SEPTEMBER });
  const empty = got.list.innerHTML;
  assert.match(empty, /性质「赛事」/, '空态要列出正在生效的筛选（旧原始类型码 203 已迁到性质轴的「赛事」）');
  assert.doesNotMatch(empty, /时间「/, '非 YYYY-MM 的月份一律作废，不能再参与过滤');
  assert.ok(got.clearButton(), '空态必须给一键清除按钮');
}

/* 时间范围：任意区间 / 单边 / 两端填反 / 一键回到不限 */
{
  // 9 月 3 日到 9 月 5 日：只有 9-03 那条落进来（跨月任意区间，旧的月份 chip 表达不了这个）
  const got = await boot({ records: SEPTEMBER });
  await got.fillRange('2026-09-03', '2026-09-05');
  assert.equal(got.cards(), 1, '任意区间只留落进范围的那条');
  assert.match(got.list.innerHTML, /消息 2/, '留的是 9 月 3 日那条');
  assert.equal(got.rangeChars().from, '2026-09-03', '日期框要回显 state，而不是留在原生控件自己的值里');
  assert.match(got.rangeHint(), /命中 1 条/, '生效中的范围要把命中条数说出来');
}
{
  // 只填下界：上界留空 = 不限
  const got = await boot({ records: SEPTEMBER });
  await got.fillRange('2026-09-10', '');
  assert.equal(got.cards(), 1, '单边范围（9 月 10 日之后）只留 9 月 12 日那条');
  assert.equal(got.rangeClearDisabled(), false, '有范围在生效时「✕ 不限」要可点');
}
{
  // 两端填反：提交时交换，不能变成「一条都命中不了」的区间
  const got = await boot({ records: SEPTEMBER });
  await got.fillRange('2026-09-05', '2026-09-01');
  const f = got.stored();
  assert.equal(f.from, '2026-09-01', '填反了就交换：下界取小的那个');
  assert.equal(f.to, '2026-09-05', '填反了就交换：上界取大的那个');
  assert.equal(got.cards(), 1, '交换后区间有意义，9 月 3 日那条留下');
}
{
  // 时间未知的条目只在「不限」时留下，不会被默认放行
  const got = await boot({ records: [...SEPTEMBER, rec(3, '')] });
  assert.equal(got.cards(), 3, '不限时间时三条都在');
  await got.fillRange('2026-09-01', '2026-09-30');
  assert.equal(got.cards(), 2, '设了范围之后，时间未知的那条要被排除');
  await got.clearRange();
  assert.equal(got.cards(), 3, '「✕ 不限」要一次性放开');
  const f = got.stored();
  assert.equal(f.from, '', '清空后下界落回空串');
  assert.equal(f.to, '', '清空后上界落回空串');
  assert.equal(got.rangeClearDisabled(), true, '没有范围在生效时「✕ 不限」要禁用');
}

/* 旧值另外两种形态：lv:全国性（赛氪自造叫法）→ 级别轴；cat:公益大赛（站点分类词）→ 学科轴 */
{
  const got = await boot({ source: 'saikr', filter: { type: 'lv:全国性' }, server: makeServer([[SAIKR_API, { body: SAIKR_BODY }]]) });
  assert.equal(got.cards(), 1, '「全国性」那条留下、省级那条滤掉（站点叫法先归一成级别轴 id 才谈得上过滤）');
  assert.deepEqual(got.axisLabels('level'), ['全部', '全国', '省级'], '级别 chip 用归一后的词表，不再是站点自造叫法');
}
{
  const got = await boot({ filter: { type: 'cat:公益大赛' }, records: SEPTEMBER });
  assert.match(got.list.innerHTML, /学科「体育公益」/, '旧 cat: 前缀要落到学科轴（站点词「公益大赛」→ 体育公益）');
  assert.ok(got.clearButton(), '命不中也要给一键清除');
}

/* 只看未读滤光时同样列名 + 点清除后恢复全部。
   这里顺带压住 id 命名空间迁移：旧版本 storage 里的 seen 是一维裸 id（当时只有摩课云），
   读回来不补 `mokeroad:` 前缀的话，升级一次等于全部消息复活成 NEW。
   时间范围特意取「命得中但被别的轴滤光」的那一种（9 月）：命不中的范围会被自愈静默清掉，
   根本走不到空态 —— 空态还列着范围，正是「范围确实在生效」的证据。
   一键清除必须把两个日期框也一起清掉（只清 state 不清界面就是老坑的翻版）。 */
{
  const got = await boot({ filter: { kw: '  ', from: '2026-09-01', to: '2026-09-30', hideSeen: true }, seen: [1, 2], records: SEPTEMBER });
  assert.match(got.list.innerHTML, /只看未读/, '空白关键词不算生效筛选，只看未读要列出来');
  assert.match(got.list.innerHTML, /时间「2026-09-01 ~ 2026-09-30」/, '空态要把生效中的时间范围原样列出来');
  assert.equal(got.cards(), 0, '裸 id 补前缀后要能命中原条目，只看未读才会滤光');
  got.clickList({ closest: (sel) => (sel === '[data-clear-filters]' ? {} : null) });
  await settle(8);
  const after = got.stored();
  assert.equal(after.hideSeen, false, '清除按钮要把只看未读关掉');
  assert.equal(after.kw, '', '清除按钮要顺带清掉关键词');
  assert.equal(after.from, '', '清除按钮要把时间范围下界一起清掉');
  assert.equal(after.to, '', '清除按钮要把时间范围上界一起清掉');
  assert.deepEqual(got.rangeChars(), { from: '', to: '' }, '界面上的两个日期框要跟着空');
  assert.equal(got.cards(), 2, '清除后消息要回来');
}

/* ══════════ ② 三个内置源各自的解析 ══════════ */
{
  const got = await boot({ source: 'saikr', server: makeServer([[SAIKR_API, { body: SAIKR_BODY }]]) });
  const html = got.list.innerHTML;
  assert.doesNotMatch(got.status(), /抓取失败/, '桩接口本身要跑通');
  assert.equal(got.cards(), 2, '赛氪：接口两条都要解析出来');
  assert.match(html, /心理知识大赛/, '赛氪：标题');
  // Unix 秒必须补零：月份分组是 time.slice(0, 7)，`2026-9-1` 会切成 `2026-9-`
  assert.match(html, /2026-\d{2}-\d{2} \d{2}:\d{2}/, '赛氪：Unix 秒要归一成补零的 YYYY-MM-DD HH:mm');
  assert.match(html, /截止 2026-\d{2}-\d{2}/, '赛氪：报名截止（regist_end_time）要显示出来');
  assert.match(html, /正在报名/, '赛氪：接口给的报名状态要带上');
  assert.match(html, /某心理学普及工作委员会 · 全国/, '赛氪：主办方与范围拼成摘要');
  assert.deepEqual(got.axisLabels('level'), ['全部', '全国', '省级'], '赛氪：level_name 归一后长成「级别」那一排');
  assert.match(html, /data-id="saikr:57786"/, '条目 id 要带源前缀');
  assert.equal(got.axisHidden('level'), false, '有两个取值的轴不能收掉');
  assert.equal(got.axisHidden('kind'), true, '两条都是「报名」⇒ 性质那排只有一个取值，整行收掉而不是留一颗「全部」');
  assert.match(html, /数理化生/, '学科轴从标题里长（心理知识大赛 ⇒ 数理化生），不靠站点分类');
}
{
  const got = await boot({ source: 'jingsai', server: makeServer([[JINGSAI_HOME, { body: JINGSAI_BODY }]]) });
  const html = got.list.innerHTML;
  assert.doesNotMatch(got.status(), /抓取失败/, '我要参赛网的桩接口本身要跑通');
  assert.equal(got.cards(), 2, '我要参赛网：两个 list_bbda 块要各出一条');
  assert.match(html, /站点分类：公益大赛/, '我要参赛网：站点自己的分类挂到 meta 的 title 上，不占视觉但不丢');
  assert.match(html, /2026-09-17 17:49/, '我要参赛网：页面里写的 2026-9-17 要补零');
  assert.match(html, /报名时间：2026年9月16日/, '我要参赛网：|| 分隔的正文行要成为摘要');
  assert.deepEqual(got.axisLabels('field'), ['全部', '文学外语', '设计艺术'], '我要参赛网：学科轴按标题归一（文学知识竞答 / IP形象征集）');
  assert.equal(got.axisHidden('kind'), true, '两条都是「报名」⇒ 性质行收掉');
  assert.equal(got.axisHidden('level'), true, '级别没凑够两个取值 ⇒ 级别行收掉（不拿「其他」占格子凑数）');
  assert.match(html, /data-id="jingsai:24056"/, '我要参赛网：条目 id 取 article 编号');
  // 要害：`<base href>` 指站点根。按页面路径 /bisai/ 拼会得出 404 的 /bisai/article-x-1.html
  assert.equal(baseOf(JINGSAI_BODY, JINGSAI_HOME), 'https://www.52jingsai.com/', 'fixture 的 base 指向站点根');
  assert.ok(got.requests.every((u) => u === JINGSAI_HOME), '第 1 页就是列表页本身');
}

/* ══════════ ③ 切源：立刻换数据、落盘，并把上一家残留的时间范围作废 ══════════ */
{
  const got = await boot({
    filter: { from: '2026-09-01', to: '2026-09-30' },
    server: makeServer([
      [MOKEROAD_API, () => ({ body: mokeroadBody(SEPTEMBER) })],
      [SAIKR_API, { body: SAIKR_BODY }],
      [JINGSAI_HOME, { body: JINGSAI_BODY }],
    ]),
  });
  assert.match(got.list.innerHTML, /消息 1/, '默认源仍是摩课云（本校在用）');
  assert.ok(!got.requests.some((u) => u.startsWith(SAIKR_API)), '没切源之前不许偷偷去抓别家');
  assert.deepEqual(got.chipLabels('[data-sources]'),
    ['摩课云竞赛', '赛氪竞赛广场', '我要参赛网', '模竞竞赛', '模竞活动', '模竞资讯', '＋ 添加源'],
    '三内置源 + 模竞三条通道 + 添加入口都要在');

  await got.clickChip('[data-sources]', '赛氪竞赛广场');
  assert.ok(got.requests.some((u) => u.startsWith(SAIKR_API)), '切源要立刻抓新源第 1 页');
  assert.match(got.list.innerHTML, /心理知识大赛/, '列表要整个换成新源');
  assert.doesNotMatch(got.list.innerHTML, /消息 1/, '上一家的条目不能留下');
  assert.equal(got.stored('source'), 'saikr', '当前源要落盘，下次进视图还在');
  const f = got.stored();
  assert.equal(f.from, '', '换源要把上一家的时间范围清掉（下界）');
  assert.equal(f.to, '', '换源要把上一家的时间范围清掉（上界）');
  assert.equal(got.rangeChars().from, '', '清掉之后日期框也要跟着空，不能只是 state 空了');
  assert.match(got.status(), /源 <b>赛氪竞赛广场<\/b>/, '状态行要说明现在是哪一家');

  await got.clickChip('[data-sources]', '我要参赛网');
  assert.match(got.list.innerHTML, /文学知识竞答/, '第三个内置源也要抓得动');
}

/* ══════════ ③b 分类轴跨源保留：归一后是同一套词表，换源不该抹掉用户的选择；
   命不中时也必须能在界面上看出来，否则又是「拉取 40 条 · 显示 0 条」被读成抓取失败 ══════════ */
{
  const got = await boot({
    filter: { kind: 'notice' },
    server: makeServer([
      [MOKEROAD_API, () => ({ body: mokeroadBody(SEPTEMBER) })],
      [SAIKR_API, { body: SAIKR_BODY }],
    ]),
  });
  assert.equal(got.cards(), 2, '摩课云两条都是「公告」（newsType 202）⇒ 性质「公告」要全留下');
  assert.deepEqual(got.axisLabels('kind'), ['全部', '公告'], '性质 chip 由新闻类型归一而来，不显示 202 这种原始码');

  await got.clickChip('[data-sources]', '赛氪竞赛广场');
  assert.equal(got.stored().kind, 'notice', '换源不再作废分类轴（同一套词表才谈得上跨源复用）');
  assert.equal(got.cards(), 0, '赛氪两条都是「报名」，性质「公告」在这边命不中');
  assert.match(got.list.innerHTML, /性质「公告」/, '空态要把生效中的轴列出来');
  assert.deepEqual(got.axisLabels('kind'), ['全部', '报名', '公告'],
    '命不中的「公告」也要留在台面上，且顺序按表走（不至于一颗都没高亮却还在过滤）');
  assert.ok(got.clearButton(), '并且给一键清除');
}
{
  // 关键词跟人不跟源，换源不能顺手抹掉；但残留的关键词必须能在界面上看出来，
  // 否则又是「拉取 2 条 / 显示 0 条」被读成抓取失败。
  const got = await boot({
    filter: { kw: '心理' },
    server: makeServer([
      [MOKEROAD_API, () => ({ body: mokeroadBody(SEPTEMBER) })],
      [SAIKR_API, { body: SAIKR_BODY }],
    ]),
  });
  await got.clickChip('[data-sources]', '赛氪竞赛广场');
  assert.equal(got.stored().kw, '心理', '换源要保留关键词');
  assert.equal(got.cards(), 1, '命中的那条要留下，滤掉另一条');
  await got.clickChip('[data-sources]', '摩课云竞赛');
  assert.match(got.list.innerHTML, /关键词「心理」/, '换源后关键词命不中时，空态要把生效中的筛选列出来');
  assert.ok(got.clearButton(), '并且给一键清除');
}

/* ══════════ ④ id 按源隔离：三家都是自增数字，撞号是必然 ══════════ */
{
  const got = await boot({
    seen: ['mokeroad:1'],
    server: makeServer([
      [MOKEROAD_API, () => ({ body: mokeroadBody([rec(1, '2026-09-12 10:00:00')]) })],
      [SAIKR_API, { body: SAIKR_BODY }],
    ]),
  });
  assert.match(got.list.innerHTML, /class="gx-card seen"/, '摩课云第 1 条要显示为已读');
  assert.doesNotMatch(got.list.innerHTML, /gx-new">NEW/, '已读条目不再标 NEW');
  await got.clickChip('[data-sources]', '赛氪竞赛广场');
  // 不隔离的话：赛氪的 contest_id 只要出现过 1，就会被摩课云的已读记录压成灰条目
  assert.match(got.list.innerHTML, /NEW/, '赛氪的条目与摩课云同号也不能被串成已读');
}

/* ══════════ ⑤ 自定义源：URL 自动识别 RSS / JSON / HTML ══════════ */
{
  const got = await boot({
    customSources: [{ id: 'usr-1', name: '校内 RSS', url: 'https://cms.example.edu.cn/contest/rss.xml' }],
    source: 'usr-1',
    server: makeServer([['https://cms.example.edu.cn/contest/rss.xml', { body: RSS_BODY }]]),
  });
  const html = got.list.innerHTML;
  assert.equal(got.cards(), 2, 'RSS：两个 <item> 都要认出来');
  assert.match(html, /数学建模竞赛校内选拔/, 'RSS：title');
  assert.match(html, /2026-09-18 09:30/, 'RSS：RFC 822 的 pubDate 只有 Date.parse 解得动，必须落到时间上');
  assert.match(html, /2026-09-11/, 'RSS：ISO 写法的日期也要认');
  assert.match(html, /作品提交截至 9 月 30 日/, 'RSS：description 要成为摘要');
  assert.match(html, /usr-1:https:\/\/cms\.example\.edu\.cn\/contest\/1207\.htm/,
    'RSS：guid 当稳定 id，跨刷新才不会反复判 NEW');
  assert.equal(got.axisHidden('kind'), true, '自定义源两条都是「报名」⇒ 性质行收掉，而不是留一颗孤零零的「全部」');
  assert.equal(got.axisHidden('level'), true, '级别只有一个取值时同样收掉');
  assert.deepEqual(got.axisLabels('field'), ['全部', '数学建模', '设计艺术'], '学科轴从标题里长出来（RSS 没有站点分类可用）');
  assert.match(got.status(), /自定义源只取第 1 页/, '自定义源没有翻页，状态行要讲清楚');
}
{
  const got = await boot({
    customSources: [{ id: 'usr-2', name: '某接口', url: 'https://api.example.edu.cn/act/list?pageSize=50' }],
    source: 'usr-2',
    server: makeServer([['https://api.example.edu.cn/act/list', { body: JSON_API_BODY }]]),
  });
  const html = got.list.innerHTML;
  assert.equal(got.cards(), 2, 'JSON：嵌在 info.rows 里的对象数组也要找到');
  assert.match(html, /电子商务挑战赛/, 'JSON：actName 要能被认成标题');
  assert.match(html, /2026-09-15 08:00/, 'JSON：字符串时间归一');
  assert.match(html, /校赛报名中/, 'JSON：memo 当摘要');
  assert.match(html, /2026-09-1/, 'JSON：Unix 秒形式的时间也要出日期');
  assert.match(html, /data-id="usr-2:9001"/, 'JSON：actId 要能被认成条目 id');
  // 详情地址只在点开时才用得上，所以走一遍「打开 ↗」，看解析出的绝对地址是什么
  got.clickList({
    closest: (sel) => {
      if (sel === '.gx-card') return { dataset: { id: 'usr-2:9001' } };
      if (sel === '[data-act]') return { dataset: { act: 'open' } };
      return null;
    },
  });
  await settle(8);
  assert.deepEqual(got.opened, ['https://api.example.edu.cn/act/9001'], 'JSON：相对地址要按接口地址解析成绝对地址');
}
{
  const got = await boot({
    customSources: [{ id: 'usr-3', name: '网页列表', url: 'https://www.example.edu.cn/jsds/list.htm' }],
    source: 'usr-3',
    server: makeServer([['https://www.example.edu.cn/jsds/list.htm', { body: HTML_LIST_BODY }]]),
  });
  const html = got.list.innerHTML;
  assert.equal(got.cards(), 3, 'HTML：三条列表链接都要认出来');
  assert.match(html, /统计建模大赛报名通知/, 'HTML：行内链接文字即标题');
  assert.match(html, /2026-09-18/, 'HTML：行内日期抠出来');
  assert.doesNotMatch(html, /<div class="gx-title">登录<\/div>/, 'HTML：导航里的「首页 / 登录 / 更多」不能混进条目');
  assert.ok(html.indexOf('统计建模') < html.indexOf('这一条行内没有日期'), 'HTML：带日期的行要排在没有日期的前面');
}
{
  // 真实踩过的噪声（探针实测 52jingsai 列表页）：侧栏 / 页脚那些「2015年优秀大使」式的
  // 年份菜单项没有日期、字数也够，会被当成条目混进来。成规模的带日期行已经够了就不要它们。
  const rows = Array.from({ length: 9 }, (_, i) =>
    `<li><a href="/js/2026/10${i}.html">第 ${i + 1} 届大学生竞赛报名通知标题够长</a><span>2026-09-0${i + 1}</span></li>`).join('');
  const junk = ['<a href="/ambassador/2015">2015年优秀大使评选</a>', '<a href="/ambassador/2016">2016年优秀大使评选</a>',
    '<a href="/dev">IT应用开发中心的入口</a>'].join('');
  const got = await boot({
    customSources: [{ id: 'usr-5', name: '带侧栏的列表页', url: 'https://www.example.edu.cn/list.htm' }],
    source: 'usr-5',
    server: makeServer([['https://www.example.edu.cn/list.htm', { body: `<html><body><ul>${rows}</ul><div class="side">${junk}</div></body></html>` }]]),
  });
  assert.equal(got.cards(), 9, 'HTML：认得出日期的行够多时，没有日期的侧栏链接一律丢掉');
  assert.doesNotMatch(got.list.innerHTML, /优秀大使/);
}
{
  // 认不出东西时必须说人话：SPA 空壳要给出「改抓接口」的可执行指引，而不是静默 0 条
  const got = await boot({
    customSources: [{ id: 'usr-4', name: '某竞赛网', url: 'https://spa.example.com/contests' }],
    source: 'usr-4',
    server: makeServer([['https://spa.example.com/contests', { body: SPA_SHELL_BODY }]]),
  });
  assert.equal(got.cards(), 0);
  assert.match(got.status(), /抓取失败/, '自定义源抓不到要报错，不能显示成一张空的正常列表');
  assert.match(got.status(), /空壳/, '要说明是 JS 渲染的空壳');
  assert.match(got.status(), /接口/, '要给出下一步：改抓数据接口');
}

/* ══════════ ⑥ 添加浮层：真抓一次才落库，抓不通就留着改地址 ══════════ */
{
  const got = await boot({ server: makeServer([
    [MOKEROAD_API, () => ({ body: mokeroadBody(SEPTEMBER) })],
    ['https://cms.example.edu.cn/contest/rss.xml', { body: RSS_BODY }],
    ['https://spa.example.com/contests', { body: SPA_SHELL_BODY }],
  ]) });
  await got.addSourceViaDialog('https://cms.example.edu.cn/contest/rss.xml', '校内RSS');
  // 成功不走浮层提示：浮层直接关掉 + toast 报条目数；失败才把原因留在浮层上让人改地址。
  assert.match(got.notices[got.notices.length - 1], /已添加「校内RSS」.*抓到 2 条/, `成功要有 toast 反馈（实际：${got.notices.join('/')}）`);
  const list = got.stored('customSources');
  assert.equal(list.length, 1, '检测通过才写进自定义源列表');
  assert.equal(list[0].name, '校内RSS', '填的名称要存下来');
  assert.equal(got.stored('source'), list[0].id, '添加完直接切到这个源');
  assert.match(got.list.innerHTML, /数学建模竞赛/, '切过去之后列表就是这个源的内容');

  const badText = await got.addSourceViaDialog('https://spa.example.com/contests');
  assert.match(badText, /空壳|没从页面里认出/, `失败要把原因留在浮层上（实际：${badText}）`);
  assert.equal(got.stored('customSources').length, 1, '抓不通的绝不落库，否则每次刷新都报错');
  assert.equal(got.stored('source'), list[0].id, '失败不切源');

  const dupText = await got.addSourceViaDialog('https://cms.example.edu.cn/contest/rss.xml');
  assert.match(dupText, /已经添加过/, '同一个地址不许添加两次');
  assert.equal(got.stored('customSources').length, 1);

  const noProto = await got.addSourceViaDialog('cms.example.edu.cn/rss');
  assert.match(noProto, /http/, '缺协议的地址直接提示，不发请求');

  // 内置三家已覆盖的站，别再当自定义源加一遍（通用解析认得出的条目比内置适配器少）
  const builtinDup = await got.addSourceViaDialog('https://www.saikr.com/contests');
  assert.match(builtinDup, /内置源/, `内置站要直接指回源那一排（实际：${builtinDup}）`);
  assert.equal(got.stored('customSources').length, 1, '内置站不会被重复添加成自定义源');
}

/* ══════════ ⑦ 新消息广播：快照按源分存，来回切源不重复推送 ══════════ */
{
  const got = await boot({
    knownIds: [1, 2],   // v0.3.x 写的是「一维数组」，当时只有摩课云一家
    server: makeServer([
      [MOKEROAD_API, () => ({ body: mokeroadBody(SEPTEMBER) })],
      [SAIKR_API, { body: SAIKR_BODY }],
    ]),
  });
  const pushed = () => got.events.filter((e) => e.name === 'notice:new');
  assert.equal(pushed().length, 0, '快照里已有的两条摩课云消息不能重推');
  assert.deepEqual(got.stored('knownIds').mokeroad, ['mokeroad:1', 'mokeroad:2'], '老数组快照要迁到摩课云名下并补前缀');
  await got.clickChip('[data-sources]', '赛氪竞赛广场');
  assert.equal(pushed().length, 0, '赛氪首次抓取只记快照、不广播（否则一上来推 40 条）');
  assert.ok(Array.isArray(got.stored('knownIds').saikr), '赛氪的快照要单独存一份');
  await got.clickChip('[data-sources]', '摩课云竞赛');
  await got.clickChip('[data-sources]', '赛氪竞赛广场');
  assert.equal(pushed().length, 0, '来回切源不许产生重复推送');
}

/* ══════════ ⑧ 转提醒：正文没时间时用接口的报名截止兜底 ══════════ */
{
  const got = await boot({ source: 'saikr', server: makeServer([[SAIKR_API, { body: SAIKR_BODY }]]) });
  // 列表按时间倒排，两条的截止日不同 ⇒ 必须按 id 抠出「我要点的那一张」的截止日
  const shown = (got.list.innerHTML.match(/data-id="saikr:57786"[\s\S]*?截止 (2026-\d{2}-\d{2})/) || [])[1];
  assert.ok(shown, '卡片上要显示报名截止日');
  got.clickList({
    closest: (sel) => {
      if (sel === '.gx-card') return { dataset: { id: 'saikr:57786' } };
      if (sel === '[data-act]') return { dataset: { act: 'remind' } };
      return null;
    },
  });
  await settle(8);
  assert.equal(got.created.tasks.length, 1, '点「提醒」要建任务');
  assert.equal(got.created.tasks[0].due, shown, 'parseWhen 解不出时间时，要按接口给的报名截止日落期');
  assert.equal(got.created.tasks[0].note, 'https://www.saikr.com/vse/psy2026', '备注存详情地址');
  assert.equal(got.created.blocks.length, 1);
  // 截止时刻常常是 23:59 / 00:39 这类半夜点，按它提醒等于睡梦里收通知 ⇒ 只取日期、落到 09:00
  assert.equal(got.created.blocks[0].start, '09:00', '按截止日兜底时提醒要放在白天');
  assert.match(got.notices.join('\n'), /按报名截止/, '提示里要说清这个日期是从哪来的');
  assert.match(got.list.innerHTML, /class="gx-card seen"/, '点了提醒要顺手标已读');
}

console.log('PASS: gx-news 残留筛选自愈 + 多源（六内置源解析 / 三条分类轴归一与跨源保留 / id 按源隔离 / 自定义源三路识别 / 添加浮层与广播快照）');
