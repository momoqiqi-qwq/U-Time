// RSS 信息流（rss-reader）的解析、合并与裁剪。
//
// 这个插件的价值全在「解析」和「合并」两处，两处都容易出静默错误：
//   · 解析错了 → 条目少一半，界面看着正常，没人会发现；
//   · 合并错了 → 刷新一次已读全丢，未读数乱跳。
// 所以测试直接跑真源码（vm 注入 tide 桩），用三种方言的真实结构做 fixture，
// 而不是读源码做正则匹配 —— 正则匹配只能证明「我写了这行」，证明不了行为。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);
const src = fs.readFileSync(new URL('../public/plugins/rss-reader/main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../public/plugins/rss-reader/manifest.json', import.meta.url), 'utf8'));

/* ═══════════ 一、把插件跑起来（真源码 + 最小 tide 桩） ═══════════ */

const storage = new Map();
const TODAY = '2026-09-18';               // 固定「今天」，日期分组断言才确定
const addDays = (d, n) => {
  const t = new Date(d + 'T00:00:00');
  t.setDate(t.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
};

const ctx = vm.createContext({
  console,
  /* 最小 DOM 桩：只有 paintList() 会用到（造「显示更多」按钮与空态节点）。
     没有它就没法在 vm 里跑 setStyle() —— 而「换样式不能把分块进度收回去」这条
     恰恰只能在 paintList 真跑起来之后才断言得到。 */
  document: {
    getElementById: () => null,
    head: { appendChild() {} },
    addEventListener() {},
    createElement: () => ({
      className: "", innerHTML: "", textContent: "", style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, append() {}, appendChild() {}, addEventListener() {},
    }),
  },
  tide: {
    storage: {
      async get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback; },
      async set(key, value) { storage.set(key, value); },
    },
    notify: () => {},
    ui: { registerView: () => {} },
    http: { get: async () => ({ status: 200, body: '', finalUrl: '' }) },
    tasks: { create: () => ({ id: 't1' }) },
    blocks: { create: () => ({}) },
    util: {
      today: () => TODAY,
      addDays,
      hhmmOf: (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'),
      parseWhen: () => ({ date: '', startMin: null, endMin: null }),
      guessQuad: () => 2,
      guessCategory: () => '其他',
      navigate: () => {},
      openUrl: () => {},
    },
  },
});

vm.runInContext(
  src.replace(
    '  tide.ui.registerView({',
    '  globalThis.__fx = {\n'
    + '    parseFeed, decodeEntities, stripCdata, toText, esc, absolutize, normalizePath, normalizeFeedUrl, hashId,\n'
    + '    parseDateAny, discoverFeedUrls, looksLikeFeed, looksLikeHtml, itemAuthor, itemLink,\n'
    +     '    mergeItems, trimItems, filtered, groupOf, fmtWhen, makeFeed, state,\n'
    + '    cardHtml, applyStyle, setStyle, STYLES, loadPrefs, focusAddBox, toggleBody, onManageToggle,\n'
    + '    get UI() { return ui; }, set UI(v) { ui = v; },\n'
    + '    DEFAULT_FEEDS, SUGGESTED_FEEDS, PER_FEED_KEEP, CACHE_MAX,\n'
    + '  };\n'
    + '  tide.ui.registerView({',
  ),
  ctx,
);
const fx = ctx.__fx;
assert.ok(fx && typeof fx.parseFeed === 'function', '插件源码没有暴露内部函数 —— 注入点是不是被改动了？');

/* vm 里造出来的数组，原型与宿主的不是同一个 —— deepStrictEqual 会因此误报。
   所有跨 realm 的数组比较都先搬进宿主数组。 */
const ids = () => Array.from(fx.filtered(), (x) => x.id);

/* ═══════════ 二、fixture ═══════════ */

/* RSS 2.0：命名空间前缀、CDATA 摘要、实体转义 HTML、enclosure 封面、dc:date、
   一条没有 pubDate 的条目（必须仍能展示，只是落进「时间未知」）。 */
const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<title>少数派</title>
<link>https://sspai.com</link>
<description>效率工具</description>
<item>
  <title>派早报：欧盟拟禁止 13 岁以下儿童使用社交媒体</title>
  <link>https://sspai.com/post/114699</link>
  <description>&lt;p&gt;今天的早报内容。&lt;/p&gt;&lt;a href=&#34;https://sspai.com/post/114699&#34;&gt;查看全文&lt;/a&gt;</description>
  <author>少数派编辑部</author>
  <pubDate>Fri, 18 Sep 2026 08:17:34 +0800</pubDate>
  <enclosure url="https://cdn.sspai.com/cover/114699.jpg" type="image/jpeg" length="0"/>
</item>
<item>
  <title><![CDATA[城市漫步指南｜威海初秋，看海玩沙 & 吃海鲜]]></title>
  <link>/post/114557</link>
  <dc:creator>Victor42</dc:creator>
  <dc:date>2026-09-17T17:47:28+08:00</dc:date>
  <description><![CDATA[<p>9 月刚开渔，避开暑假，正是玩沙吃海鲜的好时节。</p><img src="https://cdn.sspai.com/inline/114557.png">]]></description>
</item>
<item>
  <title>没有日期的旧文</title>
  <link>https://sspai.com/post/1</link>
  <description>正文</description>
</item>
</channel>
</rss>`;

/* Atom：<link href> 且有 rel=self/alternate 两个、<author><name> 嵌套、ISO 时间、相对链接。 */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>阮一峰的网络日志</title>
  <link rel="self" type="application/atom+xml" href="http://www.ruanyifeng.com/blog/atom.xml"/>
  <link rel="alternate" type="text/html" href="http://www.ruanyifeng.com/blog/"/>
  <updated>2026-09-18T02:36:54Z</updated>
  <entry>
    <title>科技爱好者周刊（第 413 期）：再见了，React Native</title>
    <link rel="replies" type="text/html" href="http://www.ruanyifeng.com/blog/2026/09/weekly-issue-413-comments.html"/>
    <link rel="alternate" type="text/html" href="http://www.ruanyifeng.com/blog/2026/09/weekly-issue-413.html"/>
    <id>tag:www.ruanyifeng.com,2026:/blog//1.2557</id>
    <published>2026-09-18T00:03:02Z</published>
    <updated>2026-09-18T02:36:54Z</updated>
    <summary>这里记录每周值得分享的科技内容，周五发布。</summary>
    <author>
      <name>阮一峰</name>
      <uri>http://www.ruanyifeng.com</uri>
    </author>
  </entry>
  <entry>
    <title>相对链接条目</title>
    <link href="./2026/08/weekly-issue-410.html"/>
    <updated>2026-08-28T00:00:00Z</updated>
    <content type="html">&lt;img src="http://www.ruanyifeng.com/blog/images/410.png"/&gt;正文</content>
  </entry>
</feed>`;

/* RDF / RSS 1.0：根是 <rdf:RDF>，item 带 rdf:about，字段是 dc:*。 */
const RDF = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://example.org/feed">
  <title>RDF 老站</title>
  <link>https://example.org/</link>
</channel>
<item rdf:about="https://example.org/a">
  <title>RDF 条目一</title>
  <link>https://example.org/a</link>
  <dc:date>2026-09-16T10:00:00+08:00</dc:date>
  <dc:creator>张三</dc:creator>
  <description>摘要一</description>
</item>
</rdf:RDF>`;

/* 畸形但常见：裸 & 未转义、属性用单引号、title 里带未闭合标签。
   现实中的校园站 / 老博客大量存在 —— 这种源不能被整份丢掉。 */
const MALFORMED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>老站 & 旧闻</title>
<link>https://old.example.edu.cn/</link>
<item>
  <title>数学建模 & 电子设计竞赛报名</title>
  <link href='https://old.example.edu.cn/n/1.html'>https://old.example.edu.cn/n/1.html</link>
  <author><![CDATA[admin@old.edu.cn (教务处)]]></author>
  <pubDate>2026-09-15 09:30:00</pubDate>
  <description>报名截止 &lt;9 月 20 日&gt;，请抓紧。</description>
</item>
</channel></rss>`;

/* 橘鸦AI早报（https://daily.juya.uk/rss.xml，2026-09-18 真抓的形态）：一天一条、
   标题就是日期；description 是短的纯文本，content:encoded 是几十 KB 的带内联样式 HTML。
   这份 fixture 钉的是**取值优先级**：description 必须先于 content:encoded 命中 ——
   取反了摘要就会从 43 KB 的 HTML 里抠出来（慢，而且形状完全不对）。
   第二条**故意**让 guid 与 link 不同：条目身份要认 guid，否则站点一换链接，
   同一篇会反复变回未读。 */
const JUYA = `<?xml version='1.0' encoding='utf-8'?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>橘鸦AI早报</title>
<link>https://daily.juya.uk/</link>
<description>Aidaily 自动生成的 AI 早报 RSS。</description>
<language>zh-CN</language>
<atom:link href="https://daily.juya.uk/rss.xml" rel="self" type="application/rss+xml" />
<item>
  <title>2026-09-18</title>
  <link>https://daily.juya.uk/issues/2026-09-18/</link>
  <guid isPermaLink="true">https://daily.juya.uk/issues/2026-09-18/</guid>
  <pubDate>Fri, 18 Sep 2026 01:41:57 GMT</pubDate>
  <description>AI 早报 2026 09 18 视频版 ：哔哩哔哩 ｜ YouTube 概览 开发生态 Claude Code 重构 Projects，支持协调并行云端线程 ↗ 1 ChatGPT 桌面版 Windows 端现已支持 Appshots 功能 ↗ 2 Kimi Code 桌面端发布 ↗ 3 Kimi 开放平台推出联网搜索 Basic、Pro 及网页读取接口 ↗ 4 TRAE 国际版上线新版订阅套餐 ↗ 5 产品应用 ChatGPT 进入 Microsoft Word，支持起草校对与格式检查 ↗ 6 ChatGPT 向所有用户开放响应可视化功能 ↗ 7 OpenAI 推出 Astra for Law ↗ 8 Meta 上线 Muse for Mac 桌面端</description>
  <content:encoded>&lt;div style="font-family:-apple-system,Segoe UI,PingFang SC"&gt;&lt;h2&gt;概览&lt;/h2&gt;&lt;p&gt;这段只存在于 content:encoded 里，摘要里不该出现它。&lt;/p&gt;&lt;/div&gt;</content:encoded>
</item>
<item>
  <title>2026-09-17</title>
  <link>https://daily.juya.uk/issues/2026-09-17/</link>
  <guid isPermaLink="false">juya-2026-09-17</guid>
  <pubDate>Thu, 17 Sep 2026 01:21:33 GMT</pubDate>
  <description>AI 早报 2026 09 17 视频版 ：哔哩哔哩 ｜ YouTube 概览 要闻 “stealth”模型登陆 OpenRouter</description>
</item>
</channel></rss>`;

/* ═══════════ 三、RSS 2.0 ═══════════ */
{
  const f = fx.parseFeed(RSS2, 'https://sspai.com/feed');
  assert.ok(f, 'RSS 2.0 应当能解析');
  assert.equal(f.title, '少数派', '频道标题');
  assert.equal(f.site, 'https://sspai.com', '频道站点链接');
  assert.equal(f.items.length, 3, '三条 item 都要在（含没有日期的）');

  const a = f.items[0];
  assert.equal(a.title, '派早报：欧盟拟禁止 13 岁以下儿童使用社交媒体');
  assert.equal(a.link, 'https://sspai.com/post/114699');
  assert.equal(a.author, '少数派编辑部');
  assert.equal(a.cover, 'https://cdn.sspai.com/cover/114699.jpg', 'enclosure 里的图片要当封面');
  /* 转义过的 HTML 必须先解实体再去标签，否则摘要里会留下 &lt;p&gt; 这种垃圾 */
  assert.ok(!a.snippet.includes('&lt;'), '摘要里不该残留实体：' + a.snippet);
  assert.ok(!a.snippet.includes('<'), '摘要里不该残留标签：' + a.snippet);
  assert.ok(a.snippet.includes('今天的早报内容'), '摘要正文要保留：' + a.snippet);
  assert.ok(a.snippet.includes('查看全文'), '摘要里的链接文字要保留：' + a.snippet);
  /* RFC822 日期必须被认出来（精度刻意只到分钟 —— 秒级对信息流没有意义，
     而且让所有源的时间戳落在同一粒度上，排序更稳定） */
  assert.match(a.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '日期要归一成 YYYY-MM-DD HH:mm');
  assert.equal(new Date(a.date).getTime(), new Date('2026-09-18T08:17:00+08:00').getTime(), 'RFC822 日期要解析成正确的时刻');

  const b = f.items[1];
  assert.equal(b.title, '城市漫步指南｜威海初秋，看海玩沙 & 吃海鲜', 'CDATA 包裹的标题要去掉包裹并解出 &');
  assert.equal(b.link, 'https://sspai.com/post/114557', '相对链接要补成绝对地址');
  assert.equal(b.author, 'Victor42', 'dc:creator 是作者');
  assert.equal(b.cover, 'https://cdn.sspai.com/inline/114557.png', '正文里的首图当封面');
  assert.ok(!b.snippet.includes('<'), 'CDATA 里的 HTML 也要去掉：' + b.snippet);

  const c = f.items[2];
  assert.equal(c.date, '', '没有日期就是空串，不能拿当前时间冒充');
  assert.equal(c.author, '');
}

/* ═══════════ 四、Atom ═══════════ */
{
  const f = fx.parseFeed(ATOM, 'http://www.ruanyifeng.com/blog/atom.xml');
  assert.ok(f, 'Atom 应当能解析');
  assert.equal(f.title, '阮一峰的网络日志');
  assert.equal(f.site, 'http://www.ruanyifeng.com/blog/', 'Atom 的站点链接要按 rel 挑（fixture 里 self 排在 alternate 前面），不能取到 feed 自身地址');
  assert.equal(f.items.length, 2);

  const a = f.items[0];
  assert.equal(a.link, 'http://www.ruanyifeng.com/blog/2026/09/weekly-issue-413.html', 'rel=alternate 优先于 rel=self');
  assert.equal(a.author, '阮一峰', '作者只取 <name>，不能把 <uri> 一起带进来');
  assert.equal(a.date, fx.parseDateAny('2026-09-18T00:03:02Z'), 'published 优先于 updated');
  assert.equal(new Date(a.date).getTime(), new Date('2026-09-18T00:03:00Z').getTime());

  const b = f.items[1];
  assert.equal(b.link, 'http://www.ruanyifeng.com/blog/2026/08/weekly-issue-410.html', '相对 href 要按 feed 地址补全（不是按站点根）');
  assert.equal(b.cover, 'http://www.ruanyifeng.com/blog/images/410.png', 'content 里转义的 <img> 也要能认出封面');}

/* ═══════════ 五、RDF / RSS 1.0 ═══════════ */
{
  const f = fx.parseFeed(RDF, 'https://example.org/feed');
  assert.ok(f, 'RDF 应当能解析');
  assert.equal(f.items.length, 1, 'RDF 的 <item> 也要被认出来');
  assert.equal(f.items[0].title, 'RDF 条目一');
  assert.equal(f.items[0].author, '张三');
  assert.equal(new Date(f.items[0].date).getTime(), new Date('2026-09-16T10:00:00+08:00').getTime());
}

/* ═══════════ 六、畸形源 ═══════════ */
{
  const f = fx.parseFeed(MALFORMED, 'https://old.example.edu.cn/');
  assert.ok(f, '带裸 & 的源不能被整份丢掉');
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].title, '数学建模 & 电子设计竞赛报名', '标题里的裸 & 要原样保留');
  assert.equal(f.items[0].link, 'https://old.example.edu.cn/n/1.html', 'link 带属性时仍要取到地址');
  assert.ok(f.items[0].snippet.includes('9 月 20 日'), '尖括号实体要解回文本：' + f.items[0].snippet);
  assert.equal(f.items[0].author, 'admin@old.edu.cn (教务处)', 'RSS 里 <author> 是纯文本（不是 <name> 子标签）时也要取到');
  assert.equal(new Date(f.items[0].date).getTime(), new Date('2026-09-15T09:30:00').getTime(), 'Date 构造函数吃不下的写法要有兜底');
}

/* ═══════════ 七、非 feed 必须被识破 ═══════════ */
{
  assert.equal(fx.parseFeed('<html><body>404</body></html>', 'https://x.com'), null, 'HTML 不是 feed');
  assert.equal(fx.parseFeed('{"a":1}', 'https://x.com'), null, 'JSON 不是 feed');
  assert.equal(fx.parseFeed('', 'https://x.com'), null, '空响应不是 feed');
  assert.equal(fx.looksLikeHtml('<!DOCTYPE html><html>'), true);
  assert.equal(fx.looksLikeHtml('<?xml version="1.0"?><rss>'), false);
}

/* ═══════════ 八、实体与文本清洗 ═══════════ */
{
  /* 一次扫描逐个体替换：分两轮会把 &amp;lt; 二次解码成 <，把用户文本里的尖括号放出来 */
  assert.equal(fx.decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;', '实体只能解一层');
  assert.equal(fx.decodeEntities('a &amp; b'), 'a & b');
  assert.equal(fx.decodeEntities('&#x4e2d;&#25991;'), '中文', '数字实体（十六进制与十进制）');
  assert.equal(fx.decodeEntities('&#0;'), '&#0;', '非法码点原样保留，不能变成空字符');
  assert.equal(fx.decodeEntities('&unknown;'), '&unknown;', '不认识的实体原样保留');
  assert.equal(fx.toText('<![CDATA[<b>粗</b>体]]>'), '粗体');
  assert.equal(fx.toText('&lt;p&gt;转义&lt;/p&gt;'), '转义');
  assert.equal(fx.toText('<p>段落</p><script>alert(1)</script>'), '段落', 'script 内容不能进摘要');
}

/* ═══════════ 九、链接补全与协议白名单 ═══════════ */
{
  assert.equal(fx.absolutize('/a/b', 'https://x.com/dir/page'), 'https://x.com/a/b');
  assert.equal(fx.absolutize('c.html', 'https://x.com/dir/page'), 'https://x.com/dir/c.html');
  assert.equal(fx.absolutize('c.html', 'https://x.com/dir/'), 'https://x.com/dir/c.html');
  assert.equal(fx.absolutize('//cdn.x.com/a.png', 'https://x.com/'), 'https://cdn.x.com/a.png');
  assert.equal(fx.absolutize('https://y.com/z', 'https://x.com/'), 'https://y.com/z');
  assert.equal(fx.absolutize('javascript:alert(1)', 'https://x.com/'), '', 'javascript: 必须被拒');
  assert.equal(fx.absolutize('mailto:a@b.com', 'https://x.com/'), '', '非 http(s) 一律拒');
  assert.equal(fx.absolutize('/a', ''), '', '没有基准地址时相对链接只能放弃');
  /* .. 必须折掉：靠浏览器容错等于把脏地址写进缓存和界面 */
  assert.equal(fx.absolutize('../x.html', 'https://a.com/b/c.html'), 'https://a.com/x.html');
  assert.equal(fx.absolutize('./a/../x.html', 'https://a.com/b/c.html'), 'https://a.com/b/x.html');
  assert.equal(fx.absolutize('/a/b/../../x.html', 'https://a.com/b/c.html'), 'https://a.com/x.html');
  assert.equal(fx.absolutize('/../../x.html', 'https://a.com/b/'), 'https://a.com/x.html', '不能越过站点根');
  assert.equal(fx.absolutize('/a.html?b=1#c', 'https://a.com/'), 'https://a.com/a.html?b=1#c', 'query 与 fragment 要保留');
  assert.equal(fx.normalizePath('/a/b/../c'), '/a/c');

  assert.equal(fx.normalizeFeedUrl('sspai.com/feed'), 'https://sspai.com/feed', '省略协议要补 https');
  assert.equal(fx.normalizeFeedUrl('  https://a.com/rss  '), 'https://a.com/rss');
  assert.equal(fx.normalizeFeedUrl('feed://a.com/rss'), 'https://a.com/rss');
  assert.equal(fx.normalizeFeedUrl('javascript:alert(1)'), '', '非 http(s) scheme 直接拒，不要补成 https://javascript:…');
  assert.equal(fx.normalizeFeedUrl('https://'), '', '没有主机名不算地址');
  assert.equal(fx.normalizeFeedUrl(''), '');
}

/* ═══════════ 十、日期解析 ═══════════ */
{
  assert.equal(fx.parseDateAny('2026-09-18T00:03:02Z'), fx.parseDateAny('Fri, 18 Sep 2026 08:03:02 +0800'), '同一时刻的不同写法要归一');
  assert.equal(new Date(fx.parseDateAny('2026/09/18 08:17')).getTime(), new Date('2026-09-18T08:17:00').getTime(), '斜杠分隔的本地时间要认');
  assert.equal(fx.parseDateAny(''), '');
  assert.equal(fx.parseDateAny('昨天'), '');
  assert.equal(fx.parseDateAny('Thu, 01 Jan 1970 00:00:00 +0000'), '', '1970 年不是有效的发布时间，宁可不显示');
  assert.equal(fx.parseDateAny('3026-09-18T00:00:00Z'), '', '离谱的未来年份同样不认');
  const ok = fx.parseDateAny('2026-09-18 08:17:00');
  assert.equal(new Date(ok).getTime(), new Date('2026-09-18T08:17:00').getTime(), '空格分隔的本地时间要有兜底解析');
}

/* ═══════════ 十一、订阅地址发现 ═══════════ */
{
  const html = `<html><head>
    <link rel="stylesheet" href="/a.css">
    <link rel="prefetch" type="application/rss+xml" href="/prefetch.xml">
    <link rel="alternate" type="application/atom+xml" href="/atom.xml">
    <link rel="alternate" type="application/rss+xml" title="RSS" href="https://x.com/rss">
    <link rel="alternate" type="application/rss+xml" href="https://x.com/rss">
  </head><body></body></html>`;
  const found = fx.discoverFeedUrls(html, 'https://x.com/blog/');
  assert.equal(found.length, 2, '重复地址要去重，非 alternate 的 link（哪怕 type 是 rss+xml）要忽略：' + JSON.stringify(found));
  assert.equal(found[0], 'https://x.com/rss', 'rss+xml 排在 atom+xml 前面');
  assert.equal(found[1], 'https://x.com/atom.xml', '相对 href 要补全');
  // 注：vm 里造出来的数组原型与宿主不同，跨 realm 比较必须比长度，不能用 deepEqual
  assert.equal(fx.discoverFeedUrls('<html><head></head></html>', 'https://x.com/').length, 0, '没有声明就返回空数组');
}

/* ═══════════ 十二、合并：刷新不能把已读/收藏洗掉 ═══════════ */
{
  fx.state.items = [];
  const feed = fx.makeFeed('https://a.com/feed', 'A 站', 0);
  const batch = [
    { key: 'k1', title: '一', link: 'https://a.com/1', date: '2026-09-18 10:00', author: '', snippet: 's1', cover: '' },
    { key: 'k2', title: '二', link: 'https://a.com/2', date: '2026-09-18 09:00', author: '', snippet: 's2', cover: '' },
  ];
  assert.equal(fx.mergeItems(feed.id, batch), 2, '首次合并应新增 2 条');
  assert.equal(fx.state.items.length, 2);
  assert.ok(fx.state.items.every((it) => it.read === false && it.star === false), '新条目默认未读未收藏');

  const target = fx.state.items.find((it) => it.title === '一');
  target.read = true;
  target.star = true;
  fx.state.items.find((it) => it.title === '二').read = true;

  // 同一批内容再抓一次（标题改了一点，模拟源更新摘要）
  const again = batch.map((x) => ({ ...x, snippet: x.snippet + '（更新）' }));
  assert.equal(fx.mergeItems(feed.id, again), 0, '重复抓取不该新增条目');
  assert.equal(fx.state.items.length, 2, '也不能变成 4 条');
  const after = fx.state.items.find((it) => it.title === '一');
  assert.equal(after.read, true, '刷新后已读必须还在');
  assert.equal(after.star, true, '刷新后收藏必须还在');
  assert.equal(after.snippet, 's1（更新）', '摘要更新要写进去');
  assert.equal(after.id, target.id, '同一条目的 id 必须稳定');

  // 不同源的同名条目不能互相顶掉
  const feedB = fx.makeFeed('https://b.com/feed', 'B 站', 1);
  fx.mergeItems(feedB.id, batch);
  assert.equal(fx.state.items.length, 4, '不同源的条目各自独立');
}

/* ═══════════ 十三、裁剪：未读与收藏不受条数限制 ═══════════ */
{
  const feed = fx.makeFeed('https://c.com/feed', 'C 站', 0);
  const many = [];
  for (let i = 0; i < fx.PER_FEED_KEEP + 20; i++) {
    many.push({ key: 'old' + i, title: '旧文 ' + i, link: 'https://c.com/' + i, date: '2026-08-01 10:00', author: '', snippet: '', cover: '' });
  }
  const list = many.map((x) => ({
    id: feed.id + ':' + fx.hashId(x.key), feedId: feed.id, title: x.title, link: x.link,
    date: x.date, author: '', snippet: '', cover: '', read: true, star: false,
  }));
  assert.equal(fx.trimItems(list).length, fx.PER_FEED_KEEP, '已读老条目按每源上限裁掉');

  // 未读不受上限保护外的裁剪 —— 最老的未读也必须留下
  list[list.length - 1].read = false;
  const kept = fx.trimItems(list);
  assert.equal(kept.length, fx.PER_FEED_KEEP + 1, '未读条目不该被裁');
  assert.ok(kept.some((it) => it.title === '旧文 ' + (fx.PER_FEED_KEEP + 19)), '最老的未读条目也要在');

  // 收藏同理
  list[list.length - 1].read = true;
  list[list.length - 2].star = true;
  const kept2 = fx.trimItems(list);
  assert.ok(kept2.some((it) => it.title === '旧文 ' + (fx.PER_FEED_KEEP + 18)), '收藏条目不该被裁');
}

/* ═══════════ 十四、筛选与时间分组 ═══════════ */
{
  const feed = fx.makeFeed('https://d.com/feed', 'D 站', 0);
  const feed2 = fx.makeFeed('https://e.com/feed', 'E 站', 1);
  fx.state.feeds = [feed, feed2];
  fx.state.items = [
    { id: '1', feedId: feed.id, title: '数学建模竞赛报名', link: '', date: TODAY + ' 09:00', snippet: '截止 9 月 20 日', read: false, star: false },
    { id: '2', feedId: feed.id, title: '英语演讲比赛', link: '', date: addDays(TODAY, -1) + ' 08:00', snippet: '', read: true, star: true },
    { id: '3', feedId: feed2.id, title: 'React 19 发布', link: '', date: '2026-08-01 10:00', snippet: '', read: false, star: false },
  ];
  fx.state.prefs = { kw: '', feed: 'all', unreadOnly: false, starOnly: false, autoMin: 0, showCover: true, style: 'card' };
  assert.equal(fx.filtered().length, 3);
  assert.equal(fx.filtered()[0].id, '1', '按时间倒序');

  fx.state.prefs.kw = '数学';
  assert.deepEqual(ids(), ['1'], '关键词命中标题');
  fx.state.prefs.kw = '截止';
  assert.deepEqual(ids(), ['1'], '关键词也命中摘要');
  fx.state.prefs.kw = 'REACT';
  assert.deepEqual(ids(), ['3'], '关键词大小写不敏感');

  fx.state.prefs.kw = '';
  fx.state.prefs.feed = feed.id;
  assert.deepEqual(ids(), ['1', '2'], '按源筛选');
  fx.state.prefs.unreadOnly = true;
  assert.deepEqual(ids(), ['1'], '只看未读');
  fx.state.prefs.unreadOnly = false;
  fx.state.prefs.starOnly = true;
  assert.deepEqual(ids(), ['2'], '只看收藏');
  fx.state.prefs.starOnly = false;
  fx.state.prefs.feed = 'all';

  assert.equal(fx.groupOf(TODAY + ' 09:00'), '今天');
  assert.equal(fx.groupOf(addDays(TODAY, -1) + ' 09:00'), '昨天');
  assert.equal(fx.groupOf(addDays(TODAY, -3) + ' 09:00'), '本周');
  assert.equal(fx.groupOf('2026-08-01 10:00'), '更早');
  assert.equal(fx.groupOf(''), '时间未知', '没有时间的条目要单独成组，不能混进「更早」');

  assert.equal(fx.fmtWhen(TODAY + ' 09:05'), '09:05', '今天的条目只显示时刻');
  assert.equal(fx.fmtWhen(addDays(TODAY, -1) + ' 09:05'), '昨天 09:05');
  assert.equal(fx.fmtWhen('2026-08-01 10:00'), '08-01 10:00');
}

/* ═══════════ 十五、清单、图标与生成物同步 ═══════════ */
{
  assert.equal(manifest.id, 'rss-reader');
  /* 版本号**故意钉死具体值**：插件内容改了（哪怕只是换一条预置源）就必须来这里确认一次。
     别把它改成 /^\d+\.\d+\.\d+$/ 之类的格式检查 —— 那样「改了内容却忘升版本」就再也拦不住了。 */
  assert.equal(manifest.version, '1.6.1');
  for (const perm of ['ui', 'storage', 'notify', 'http', 'openUrl', 'tasks', 'blocks', 'timeParse', 'events']) {
    assert.ok(manifest.permissions.includes(perm), 'manifest 必须声明 ' + perm);
  }
  /* 原生资料库与行为回归已落地；仍需服务器域名配置，不等于桌面任意网络能力。 */
  assert.equal(manifest.platforms.miniprogram, 'native', '已提供 RSS 原生适配');
  const miniPage = new URL('../../miniprogram/pages/library/index.js', import.meta.url);
  assert.ok(fs.existsSync(miniPage), '标记 native 必须同时提供可打开的原生页');
  assert.match(fs.readFileSync(miniPage, 'utf8'), /lib\.refreshFeed/, '原生页必须接入真实刷新逻辑');
  assert.equal(manifest.platforms.windows, 'full');
  assert.equal(manifest.platforms.android, 'full');
  assert.ok(Number.isFinite(Number(manifest.order)), 'order 必须是数字');

  /* 生成物同步：catalog 由 tools/sync-plugins.js 从 manifest 生成，手改 catalog 会被覆盖 */
  for (const rel of ['../src/pluginCatalog.js', '../../miniprogram/core/pluginCatalog.js']) {
    const cat = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(cat.includes('"rss-reader"'), rel + ' 必须已同步 rss-reader（跑 node tools/sync-plugins.js）');
    const entry = cat.slice(cat.indexOf('"id": "rss-reader"'));
    const block = entry.slice(0, entry.indexOf('},\n  {') >= 0 ? entry.indexOf('},\n  {') : 600);
    // 版本号不写死：这条断言的**本意**就是「跟着 manifest 走」，写死字面量会在 manifest 升版时
    // 假红一次（实测：manifest 1.0.0 → 1.1.0 后这里就红了，而生成物其实早已同步）。
    assert.ok(block.includes('"version": "' + manifest.version + '"'), rel + ' 的版本号要跟着 manifest 走');
    assert.match(block, /"http"/, rel + ' 要带上 http 权限');
  }

  /* 插件图标随包：src/icons.js 直接读 /icons/plugins/<插件id>.png，key 就是插件 id。
     漏生成的话侧栏与插件中心是裂图（tools/gen-plugin-icons.py）。
     🔴 只按 manifest.id 拼路径回查 —— 另写一遍 'rss-reader.png' 字面量是**冗余防线**：
     它先于本断言失败，会让「改名」这条变异失去分辨力（实测踩过，删掉才有意义）。 */
  const byId = new URL('../public/icons/plugins/' + manifest.id + '.png', import.meta.url);
  assert.ok(fs.existsSync(byId), '图标文件名必须等于插件 id：' + manifest.id + '.png 不存在（appIcon 会静默回落 CDN，离线即裂）');
  assert.ok(fs.statSync(byId).size > 500, '图标文件太小，多半是下载失败的残片');
  const pngMagic = fs.readFileSync(byId).subarray(0, 8);
  assert.equal(pngMagic.toString('hex'), '89504e470d0a1a0a', '插件图标必须是合法 PNG（appIcon 拿 <img> 加载它）');
  /* 三端同源：桌面 icons/plugins 与小程序 images/plugins 必须是同一份字节 */
  const mpIcon = new URL('../../miniprogram/images/plugins/' + manifest.id + '.png', import.meta.url);
  assert.ok(fs.existsSync(mpIcon), '小程序端缺同源图标 miniprogram/images/plugins/' + manifest.id + '.png');
  assert.ok(fs.readFileSync(byId).equals(fs.readFileSync(mpIcon)), '桌面与小程序图标必须字节一致（tools/gen-plugin-icons.py 一次生成两处）');
  const iconsSrc = fs.readFileSync(new URL('../src/icons.js', import.meta.url), 'utf8');
  assert.match(iconsSrc, /"rss-reader":\s*\[/, 'src/icons.js 的 PLUGIN_ICONS8 要补上 rss-reader 的 CDN 回落 slug');

  /* order 不能和别的插件撞（撞了排序不稳定，插件中心位置会飘） */
  const dir = new URL('../public/plugins/', import.meta.url);
  const orders = new Map();
  for (const name of fs.readdirSync(dir)) {
    const mf = new URL(name + '/manifest.json', dir);
    if (!fs.existsSync(mf)) continue;
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (orders.has(m.order)) assert.fail('插件 order 撞车：' + name + ' 与 ' + orders.get(m.order) + ' 都是 ' + m.order);
    orders.set(m.order, name);
  }

  /* 预置订阅源：必须非空、去重、全是 https（http 源在 Android 上会被明文策略拦掉） */
  assert.ok(fx.DEFAULT_FEEDS.length >= 2, '至少要预置两个源，否则首次打开是空屏');
  assert.ok(fx.SUGGESTED_FEEDS.length >= 2, '推荐源不能为空');
  const urls = [...fx.DEFAULT_FEEDS, ...fx.SUGGESTED_FEEDS].map((f) => f.url);
  assert.equal(new Set(urls).size, urls.length, '预置源不能重复');
  for (const f of [...fx.DEFAULT_FEEDS, ...fx.SUGGESTED_FEEDS]) {
    assert.match(f.url, /^https:\/\//, '预置源必须走 https：' + f.url);
    assert.ok(f.title && f.title.length >= 2, '预置源要有名字：' + f.url);
  }
}

/* ═══════════ 十六、筛选变化必须同时刷新状态栏 ═══════════ */
{
  /* 真浏览器探针发现的回归：点源 chip 后只刷列表、不刷状态栏 ⇒ 列表变了而
     「显示 N / m 条」停在旧值，看着像筛选没生效。三个绘制入口已收成 paintFiltered()，
     这里钉住它，避免以后新增筛选项时又各写各的。 */
  assert.match(
    src,
    /function paintFiltered\(\)\s*\{[\s\S]{0,120}?paintChips\(\);[\s\S]{0,80}?paintStatus\(\);[\s\S]{0,80}?paintList\(true\);/,
    'paintFiltered() 必须同时刷 chips / 状态栏 / 列表',
  );
  assert.doesNotMatch(
    src,
    /state\.prefs\.(feed|unreadOnly|starOnly)\s*=[^;\n]+;\s*savePrefs\(\);\s*paintChips\(\);\s*paintList\(true\);/,
    '筛选变化不得绕过 paintFiltered()（会让状态栏计数停在旧值）',
  );
}

/* ═══════════ 十七、显示样式三档（卡片 / 紧凑 / 标题） ═══════════ */
{
  const feed = fx.makeFeed('https://s.com/feed', 'S 站', 0);
  fx.state.feeds = [feed];
  const rich = {
    id: 'c1', feedId: feed.id, title: '带封面的条目', link: 'https://s.com/1',
    date: TODAY + ' 09:00', author: '某作者', snippet: '这是一段摘要',
    cover: 'https://s.com/a.png', read: false, star: false,
  };
  fx.state.items = [rich];
  const setStyle = (s) => { fx.state.prefs = { kw: '', feed: 'all', unreadOnly: false, starOnly: false, autoMin: 0, showCover: true, style: s }; };

  assert.deepEqual(Array.from(fx.STYLES), ['card', 'compact', 'title'], '三档样式必须正好是这三档');

  /* ① 三档共有的不变量：容器仍叫 .rss-card、仍带 data-id、三个动作仍在。
     ui.list 的点击委托是 closest('.rss-card') + dataset.id 回查条目 ——
     任何一档换了容器类名或漏了 data-id，打开/收藏/提醒会**静默失效**（不报错、点了没反应）。 */
  for (const s of fx.STYLES) {
    setStyle(s);
    const html = fx.cardHtml(rich);
    assert.match(html, /^<article class="rss-card"/, s + '：容器必须仍带 rss-card 类（否则点击委托失效）');
    assert.match(html, /data-id="c1"/, s + '：必须带 data-id');
    assert.match(html, /data-act="open"/, s + '：必须还能打开原文');
    assert.match(html, /data-act="star"/, s + '：收藏动作必须还在');
    assert.match(html, /data-act="remind"/, s + '：提醒动作必须还在');
    assert.match(html, /class="rss-when"/, s + '：时间要有独立类名，密度 CSS 靠它收敛');
  }

  /* ② 卡片档：封面 + 摘要 + 打开按钮 + 作者 */
  setStyle('card');
  const card = fx.cardHtml(rich);
  assert.match(card, /class="rss-cover"/, '卡片档要渲染封面');
  assert.match(card, /class="rss-snip/, '卡片档要渲染摘要');
  assert.match(card, /data-act="open"[^>]*>打开 ↗</, '卡片档要保留「打开」按钮');
  assert.match(card, /class="rss-author"/, '卡片档要显示作者');

  /* ③ 紧凑档：**不渲染**封面与摘要。不是靠 CSS 藏 —— 那样 <img src> 照样发请求，
     33 条就是 33 张白拉的图。作者则相反：DOM 留着，交给 CSS 收掉。 */
  setStyle('compact');
  const compact = fx.cardHtml(rich);
  assert.doesNotMatch(compact, /rss-cover/, '紧凑档不得渲染封面（CSS 藏的话仍会白拉图）');
  assert.doesNotMatch(compact, /rss-snip/, '紧凑档不得渲染摘要');
  assert.match(compact, /class="rss-author"/, '紧凑档的作者交给 CSS 隐藏，DOM 里保留');
  assert.match(compact, /打开 ↗/, '紧凑档仍要有「打开」按钮（一行放得下）');

  /* ④ 标题档：连「打开」按钮都收掉 —— 整行点击即打开（委托的兜底分支就是 openItem）。
     收藏按钮只剩星号，所以**必须**带 title 属性，否则读屏与悬停提示都是空的。 */
  setStyle('title');
  const title = fx.cardHtml(rich);
  assert.doesNotMatch(title, /rss-cover|rss-snip/, '标题档不得渲染封面与摘要');
  assert.doesNotMatch(title, /打开 ↗/, '标题档要收掉冗余的「打开」按钮（整行可点）');
  assert.match(title, /data-act="open"/, '标题档仍需一个可点开原文的节点（标题本身）');
  assert.match(title, /title="收藏 \/ 取消收藏"/, '只剩符号的按钮必须有 title（读屏/悬停提示）');
  assert.match(title, /data-act="star"[^>]*>☆</, '未收藏时标题档只显示星号');

  /* ⑤ 封面开关只作用于卡片档 */
  setStyle('card');
  fx.state.prefs.showCover = false;
  assert.doesNotMatch(fx.cardHtml(rich), /rss-cover/, '关掉封面开关后卡片档也不渲染封面');
  fx.state.prefs.showCover = true;

  /* ⑥ applyStyle() 的三处同步 —— wrap 的 data-style、分段控件选中态、封面开关。
     这三处必须一起变，只改一处就会出现「点着『紧凑』、显示的却是卡片」这类脱节，
     而且它不会报错，只能靠断言钉住。这里给一个假 ui 让 applyStyle 真跑。 */
  const mkBtn = (s) => {
    const b = {
      dataset: { style: s }, on: false, attrs: {},
      classList: { toggle(name, v) { if (name === 'on') b.on = !!v; } },
      setAttribute(k, v) { b.attrs[k] = v; },
    };
    return b;
  };
  const segBtns = Array.from(fx.STYLES, mkBtn);
  const cover = { on: false, classList: { toggle(name, v) { if (name === 'on') cover.on = !!v; } } };
  const wrap = { dataset: {} };
  const list = { innerHTML: '', append() {} };
  fx.UI = { wrap, list, seg: { querySelectorAll: () => segBtns }, coverToggle: cover };

  setStyle('compact');
  fx.applyStyle();
  assert.equal(wrap.dataset.style, 'compact', 'wrap 的 data-style 必须跟着走');
  assert.deepEqual(segBtns.filter((b) => b.on).map((b) => b.dataset.style), ['compact'], '有且只有当前档是选中态');
  assert.equal(segBtns.find((b) => b.dataset.style === 'compact').attrs['aria-pressed'], 'true', '选中态要同步 aria-pressed');
  assert.equal(segBtns.find((b) => b.dataset.style === 'card').attrs['aria-pressed'], 'false', '未选中档 aria-pressed=false');
  assert.equal(cover.on, true, '封面开关跟着 prefs.showCover');
  fx.state.prefs.showCover = false;
  fx.applyStyle();
  assert.equal(cover.on, false, '封面开关关掉后要同步');

  /* 未知样式必须回落卡片档 —— 不能让 'weird' 漏进 data-style，那样所有密度选择器都不匹配，
     界面会退成「无样式的卡片」而没有任何报错。 */
  setStyle('weird');
  fx.applyStyle();
  assert.equal(wrap.dataset.style, 'card', '未知样式必须回落卡片档');

  /* ⑦ setStyle()：非法值不写库；合法值立刻生效；**不得**把分块进度收回去 */
  setStyle('card');
  fx.setStyle('nope');
  assert.equal(fx.state.prefs.style, 'card', '非法样式必须被拒（不能落进 prefs）');
  assert.equal(wrap.dataset.style, 'card', '被拒时也不该动 DOM');
  fx.state.rendered = 40;
  fx.setStyle('title');
  assert.equal(fx.state.prefs.style, 'title', '合法样式要生效');
  assert.equal(wrap.dataset.style, 'title', 'setStyle 之后必须立刻 applyStyle');
  assert.equal(fx.state.rendered, 40, 'setStyle 不得重置分块进度（否则「显示更多」展开的部分会被收回去）');
  /* 落库也要钉：savePrefs() 少一行，样式就变成「本次会话有效、重启回卡片」，
     用户只会觉得「这开关有时好使有时不好使」，最难查的那类。 */
  assert.equal((storage.get('prefs') || {}).style, 'title', 'setStyle 必须落库（否则重启丢样式）');

  /* 源码契约：setStyle 只能走 paintList()，不能走 paintFiltered()（后者 reset 分块） */
  assert.match(src, /function setStyle\(style\)\s*\{[\s\S]{0,240}?paintList\(\);/, 'setStyle 要调 paintList()');
  assert.doesNotMatch(src, /function setStyle\(style\)\s*\{[\s\S]{0,240}?paintFiltered\(\)/, 'setStyle 不得用 paintFiltered()');
  /* 封面开关必须真的接在界面上 —— prefs.showCover 曾经是个有默认值、有归一化、
     却没有任何控件能改的死配置（等于恒为 true）。
     注意别写成 assert.match(src, /data-seg/)：那个名字在 CSS 与
     wrap.querySelector("[data-seg]") 里都出现过，**把模板节点整个删掉它照样绿**
     （实测变异漏过）。必须钉住「模板里真有这个节点」。 */
  assert.match(src, /<span class="rss-seg" data-seg/, '工具栏要有样式分段控件（模板里必须真有这个节点）');
  assert.match(src, /<span class="rss-toggle" data-cover-toggle title=/, '封面开关必须真的接在工具栏上');

  /* ⑧ loadPrefs() 对 style 的兜底。这不是 applyStyle 的重复：
     cardHtml 直接读 state.prefs.style 来决定封面/摘要/「打开」按钮，
     所以一个未知值（旧数据没有这字段、或被人手改成别的串）会让它渲染出
     「没封面没摘要却留着打开按钮」的四不像 —— 而且全程不报错。
     三个方向都要钉：未知值回落、缺字段回落、合法值**不许**被兜底改掉。 */
  storage.set('prefs', { kw: '', feed: 'all', style: 'weird', showCover: true });
  await fx.loadPrefs();
  assert.equal(fx.state.prefs.style, 'card', '未知 style 必须在 loadPrefs 里被归一化成卡片档');
  storage.set('prefs', { kw: '', feed: 'all' });
  await fx.loadPrefs();
  assert.equal(fx.state.prefs.style, 'card', '旧数据缺 style 字段也要回落卡片档');
  storage.set('prefs', { kw: '', feed: 'all', style: 'title' });
  await fx.loadPrefs();
  assert.equal(fx.state.prefs.style, 'title', '合法 style 不能被兜底改掉（否则每次启动都丢用户的选择）');
  storage.delete('prefs');

  fx.UI = null;
}

/* ═══════════ 十八、预置源「橘鸦AI早报」的形态 ═══════════ */
{
  const f = fx.parseFeed(JUYA, 'https://daily.juya.uk/rss.xml');
  assert.ok(f, '这份源要能解析（RSS 2.0 + content:encoded + atom:link rel=self）');
  assert.equal(f.title, '橘鸦AI早报', '频道标题');
  assert.equal(f.site, 'https://daily.juya.uk/', '站点链接要取 <link>，不能取成 atom:link rel=self 的 feed 自身地址');
  assert.equal(f.items.length, 2, '两条都要在');

  const a = f.items[0];
  assert.equal(a.title, '2026-09-18', '这条源的条目标题就是日期');
  assert.equal(a.link, 'https://daily.juya.uk/issues/2026-09-18/');
  assert.equal(a.key, 'https://daily.juya.uk/issues/2026-09-18/', '有 guid 就用 guid 当条目身份');
  /* 🔴 本节要点：description 与 content:encoded 并存时，摘要必须来自**前者**。
     取反了的话摘要会从几十 KB 的 content:encoded HTML 里抠 —— 慢，而且形状完全不对。 */
  assert.ok(a.snippet.includes('AI 早报'), '摘要要来自 description：' + a.snippet);
  assert.ok(!a.snippet.includes('只存在于 content:encoded'), '摘要不能来自 content:encoded：' + a.snippet);
  assert.ok(!a.snippet.includes('<') && !a.snippet.includes('&lt;'), '摘要里不能残留标签或实体：' + a.snippet);
  assert.ok(a.snippet.length <= 220, '摘要要截到 220 字以内，实际 ' + a.snippet.length);
  /* 上限要钉**精确值**，不能只写 <= 220 —— 夹具里的描述一旦短于 220，这条就恒真，
     把上限从 220 放开到 5000 也照样绿（实测漏过一次）。真实源的 description 约 360 字，
     所以夹具也按同量级写。clip(s, n) 的产出长度正好是 n（n-1 字 + 省略号）。 */
  assert.equal(a.snippet.length, 220, '长描述必须被截到正好 220 字，实际 ' + a.snippet.length);
  assert.match(a.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'GMT 的 RFC822 日期要归一成 YYYY-MM-DD HH:mm');
  assert.equal(a.cover, '', '没有 enclosure / 正文图时封面为空，不能瞎猜一个');

  /* guid 与 link 不同时身份必须认 guid —— 站点换链接不能让同一篇变回未读 */
  const b = f.items[1];
  assert.equal(b.key, 'juya-2026-09-17', 'guid 与 link 不同时要认 guid，不是 link');
  assert.equal(b.link, 'https://daily.juya.uk/issues/2026-09-17/', 'link 仍要按 <link> 取，不能拿 guid 顶替');
}

/* ═══════════ 十九、卡片「展开正文」：抓原文正文 + 与同仓库插件同款的展开动画 ═══════════ */
{
  const feed = fx.makeFeed('https://r.com/feed', 'R 站', 0);
  const it = {
    id: 'e1', feedId: feed.id, title: '一篇有正文的文章', link: 'https://r.com/post/1',
    date: TODAY + ' 10:00', author: '', snippet: '摘要有两行，得展开才看得全。'.repeat(3),
    cover: '', read: false, star: false,
  };
  fx.state.feeds = [feed];
  fx.state.items = [it];
  fx.state.prefs = { kw: '', feed: 'all', unreadOnly: false, starOnly: false, autoMin: 0, showCover: true, style: 'card' };
  fx.state.expanded.clear();
  fx.state.bodies.clear();
  fx.state.bodyLoading.clear();

  /* ① 收起态：按钮在、文案「展开正文」、详情壳常驻但 aria-hidden。
     详情壳**不是**条件渲染 —— 它是 grid 0fr 收起的，所以 DOM 一直在，只是不占高度。 */
  const closed = fx.cardHtml(it);
  assert.match(closed, /<button class="rss-btn rss-expand" data-act="expand" aria-expanded="false"/, '收起态要有「展开正文」按钮且 aria-expanded=false');
  assert.match(closed, /<span>展开正文<\/span>/);
  assert.match(closed, /class="rss-detail-shell" aria-hidden="true"/, '正文常驻 DOM，收起时不标 aria-hidden 读屏就会念出来');
  assert.match(closed, /<div class="rss-detail"><\/div>/, '没抓过正文时详情区为空');
  assert.ok(!/class="rss-card[^"]*open/.test(closed), '收起态卡片不带 open 类');

  /* ② 展开态：open 类挂在**卡片**上（`.rss-card.open` 是全部过渡规则的开关），文案与 aria 同步翻转 */
  fx.state.expanded.add(it.id);
  const opened = fx.cardHtml(it);
  assert.match(opened, /class="rss-card open"/, '展开态的 open 类必须挂在 .rss-card 上，否则 .rss-card.open 的选择器全不生效');
  assert.match(opened, /aria-expanded="true"/);
  assert.match(opened, /<span>收起正文<\/span>/);
  assert.match(opened, /class="rss-detail-shell" aria-hidden="false"/);
  fx.state.expanded.delete(it.id);

  /* ③ 抓回来的正文要渲进详情区，且必须转义 —— 原文页面里的 <script> 只是文章里贴的一段代码 */
  fx.state.bodies.set(it.link, '第一段\n<script>alert(1)</script>&第二段');
  const cached = fx.cardHtml(it);
  assert.ok(cached.includes('<div class="rss-body">第一段\n'), '正文换行原样带过（.rss-body 用 white-space:pre-wrap 排版）');
  assert.ok(cached.includes('&lt;script&gt;alert(1)&lt;\/script&gt;&amp;第二段'), '正文必须转义：' + cached.slice(cached.indexOf('rss-body')));
  assert.ok(!cached.includes('<script>'), '正文里绝不能出现未转义的 <script>');

  /* ④ 抓取中：占位文案写在详情区里，靠它把「点了但还没回来」这件事说出来 */
  fx.state.bodies.clear();
  fx.state.bodyLoading.add(it.link);
  assert.match(fx.cardHtml(it), /<div class="rss-body">正在读取正文…<\/div>/, '抓取中要显示占位文案');
  fx.state.bodyLoading.delete(it.link);

  /* ⑤ 没有 link 就无从抓取 ⇒ 整个展开入口不渲染，不留一个点了必然报错的死控件 */
  assert.doesNotMatch(fx.cardHtml({ ...it, link: '' }), /rss-expand|rss-detail-shell/, '无 link 的条目不渲染展开入口');

  /* ⑥ 紧凑 / 标题档不渲染（与摘要同一规律：JS 侧就不出，而不是渲染了再靠 CSS 藏） */
  for (const s of ['compact', 'title']) {
    fx.state.prefs = { ...fx.state.prefs, style: s };
    assert.doesNotMatch(fx.cardHtml(it), /rss-expand|rss-detail-shell/, s + ' 档不渲染展开入口');
  }
  fx.state.prefs = { ...fx.state.prefs, style: 'card' };

  /* ⑦ 🔴 动画必须是「本仓库插件展开收起的事实标准」：与 警大通知 / 学校通知 的详情壳
     **同一套时长与曲线**。为什么不能就地换一套：实测 Chromium 里 grid 轨道只有
     「0fr → 1fr」是连续插值，「定长轨道（px 或 lh）→ 1fr」只做 discrete 插值
     （前一半时间停在原高，然后一次性跳到位）；改成 max-height 或 JS 测高又会做出
     第三种手感 —— 同一类操作上出现三种动画。 */
  const shellRule = (rel, cls) => {
    const s = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    return (s.match(new RegExp('\\.' + cls + '-detail-shell\\s*\\{[^}]*\\}')) || [''])[0];
  };
  const transOf = (rule) => (rule.match(/transition:([^;]+)/) || [, ''])[1].replace(/\s+/g, ' ').trim();
  const rssShell = shellRule('../public/plugins/rss-reader/main.js', 'rss');
  const ppShell = shellRule('../public/plugins/cppu-notify/main.js', 'pp');
  const snShell = shellRule('../public/plugins/school-notice/main.js', 'sn');
  assert.match(rssShell, /display:grid;grid-template-rows:0fr/, '收起态必须是 0fr 起跳（定长轨道不会平滑），且要先抓到的是收起态那条规则');
  const [rssTrans, ppTrans, snTrans] = [rssShell, ppShell, snShell].map(transOf);
  assert.ok(ppTrans && snTrans, '没在 警大通知 / 学校通知 里找到 .xx-detail-shell 的 transition —— 基准插件是不是改了写法？');
  assert.equal(rssTrans, ppTrans, '展开动画的时长/曲线要和 警大通知 一致\n  rss: ' + rssTrans + '\n  pp : ' + ppTrans);
  assert.equal(rssTrans, snTrans, '展开动画的时长/曲线要和 学校通知 一致\n  rss: ' + rssTrans + '\n  sn : ' + snTrans);
  assert.match(src, /\.rss-card\.open \.rss-detail-shell\{grid-template-rows:1fr/, '展开态要把轨道切到 1fr');
  assert.match(src, /\.rss-expand::after\{content:"⌄"/, '箭头用 ⌄，与 警大 / 学校通知 同一个字符');
  assert.match(src, /\.rss-card\.open \.rss-expand::after\{transform:translateY\(1px\) rotate\(180deg\)/, '展开时箭头转 180°');

  /* ⑧ 就地改类，不整体重绘：paintList 会重写 innerHTML，新卡片一出生就带着 .open 终态，
     0fr→1fr 的过渡根本不会播放（观感就是「闪一下」）。 */
  assert.doesNotMatch(src, /kind === "expand"[\s\S]{0,160}paintList\(/, '展开/收起不许走 paintList()');
  assert.match(src, /closest\("\.rss-detail-clip"\)/, '正文区里的点击不能被兜底分支当成「打开原文」，读到一半被踢去浏览器');
  assert.match(src, /\.rss-card\.open\{content-visibility:visible/, '展开态要退出 content-visibility:auto，否则滚出屏幕按 88px 占位收、滚回来会跳');

  /* ⑨ 🔴 回归（浏览器探针实测到的 bug）：抓回来的正文必须真的写进卡片。
     bodyHtml() 第一眼就是 bodyLoading，所以「清 loading」与「写正文」的先后是决定性的 ——
     旧写法把写正文放在 try 里、清 loading 放 finally，结果抓取已返回而卡片永远停在
     「正在读取正文…」。这条用假卡片真跑 toggleBody()，量的就是那一下。 */
  const detailBox = { innerHTML: '' };
  const labelSpan = { textContent: '展开正文' };
  const fakeCard = {
    dataset: { id: it.id },
    classList: { toggle() {} },
    querySelector: (sel) => (sel === '.rss-expand'
      ? { setAttribute() {}, querySelector: () => labelSpan }
      : sel === '.rss-detail' ? detailBox : sel === '.rss-detail-shell' ? { setAttribute() {} } : null),
  };
  const realGet = ctx.tide.http.get;
  ctx.tide.util.web = { extractArticleText: (html) => ({ text: String(html).replace(/<[^>]+>/g, '\n').replace(/\s*\n\s*/g, '\n').trim() }) };
  ctx.tide.http.get = async () => ({ status: 200, body: '<div><p>原文第一段</p><p>第二段</p></div>', finalUrl: it.link });
  fx.UI = { list: { querySelectorAll: () => [fakeCard] } };
  fx.state.expanded.clear();
  fx.state.bodies.clear();
  fx.state.bodyLoading.clear();
  await fx.toggleBody(fakeCard, it);
  assert.ok(detailBox.innerHTML.includes('原文第一段'), '正文要真的写进详情区，实际：' + detailBox.innerHTML);
  assert.ok(!detailBox.innerHTML.includes('正在读取正文'), '不许停在占位文案（loading 没清就先写正文）');
  assert.equal(fx.state.expanded.has(it.id), true, '展开状态要记下');
  assert.equal(fx.state.bodies.get(it.link), '原文第一段\n第二段', '正文按 link 入内存缓存');
  assert.equal(fx.state.bodyLoading.has(it.link), false, '抓完要摘掉 loading');

  /* ⑩ 抓失败：错误写在卡片上、**不进缓存**（下次展开能重试）、loading 摘掉 */
  ctx.tide.http.get = async () => ({ status: 403, body: '', finalUrl: it.link });
  fx.state.expanded.clear();
  fx.state.bodies.clear();
  detailBox.innerHTML = '';
  await fx.toggleBody(fakeCard, it);
  assert.match(detailBox.innerHTML, /读取正文失败：HTTP 403/, '失败要有可行动的文案，实际：' + detailBox.innerHTML);
  assert.match(detailBox.innerHTML, /class="rss-body err"/, '失败文案走 .err 上色');
  assert.equal(fx.state.bodies.has(it.link), false, '失败不许进缓存（否则一次抖动就把这条永久钉死）');
  assert.equal(fx.state.bodyLoading.has(it.link), false, '失败也要摘 loading');
  ctx.tide.http.get = realGet;
  fx.UI = null;
}

/* ═══════════ 二十、顶栏「＋ 添加源」入口（订阅管理的外层把手） ═══════════ */
{
  /* 添加与删除本来就都在「订阅管理」里，问题是入口藏太深。这一节钉两件事：
     ① 里面那套既有控件一个都没被拆走；② 顶栏那颗只是把手，不是第二套添加逻辑。 */

  /* ① 每行仍有 启用/停用 与 删除，内部仍有 添加 按钮与地址输入框 */
  assert.match(src, /srcBtn\(f\.enabled === false \? "启用" : "停用", \(\) => toggleFeed\(f\)\)/, '源行必须仍有 启用/停用');
  assert.match(src, /srcBtn\("删除", \(\) => removeFeed\(f\)\)/, '源行必须仍有 删除（顶栏加了入口也不能把它换掉）');
  assert.match(src, /<input class="rss-input" data-add-url/, '「订阅管理」里必须仍有地址输入框');
  assert.match(src, /<button class="rss-btn pri" data-add>添加<\/button>/, '「订阅管理」里必须仍有 添加 按钮');

  /* ② 顶栏那颗按钮：在「来源」那一行、在 .rss-hero 内（不滚到页面底部也够得着），且是 button 元素 */
  const hero = (src.match(/<div class="rss-hero[\s\S]*?<div data-list/) || [''])[0];
  assert.ok(hero, '没在 .rss-hero 到列表之间找到视图骨架（顶栏结构是不是动了？）');
  assert.match(hero, /<button class="rss-add-src" data-add-src type="button"/, '顶栏必须有一颗真的 <button> 加源入口（不是 span/chip）');
  assert.match(hero, /data-chips><\/div>[\s\S]*?<\/details><button class="rss-add-src"/, '入口要挂在「筛选」按钮那一行的行尾');
  assert.match(hero, /title="[^"]*添加订阅源/, '触屏没有 hover 提示，但读屏要能念出来 —— title 不能省');

  /* ③ 行为：展开 <details> 并把光标放到地址框上。focus 必须 preventScroll ——
     否则浏览器自己那一下跳转会和下面的 scrollIntoView 抢，观感是跳两次。 */
  const calls = [];
  const manage = { open: false };
  const addUrl = {
    focus: (o) => calls.push(['focus', o]),
    scrollIntoView: (o) => calls.push(['scrollIntoView', o]),
  };
  fx.UI = { manage, addUrl };
  fx.focusAddBox();
  assert.equal(manage.open, true, '点顶栏入口必须把「订阅管理」展开');
  assert.deepEqual(calls.map((c) => c[0]), ['focus', 'scrollIntoView'], '要聚焦地址框并带到视野内');
  assert.equal(calls[0][1].preventScroll, true, 'focus 要 preventScroll，别和 scrollIntoView 抢');
  /* 只是把手：不许在这里顺手加源，否则「按 Enter 添加 / 点添加添加」会多出一条路径 */
  assert.doesNotMatch(src, /function focusAddBox\(\)\s*\{[\s\S]{0,260}?(addFeed|removeFeed)\(/, '入口只负责展开与聚焦，不自己添加/删除源');
  fx.UI = null;

  /* ④ 展开箭头。窄屏（APK）上「添加源」三个字要为 chips 让位收掉，只剩一个 ＋ 读不出
     「点它会摊开一块面板」⇒ 补一颗 ⌄，展开时翻转，与卡片上的「展开正文」同一个字符、同一条曲线。 */
  assert.match(src, /\.rss-add-src::after\{content:"⌄"/, '顶栏入口要有展开箭头');
  assert.match(src, /\.rss-add-src\[aria-expanded="true"\]::after\{transform:translateY\(1px\) rotate\(180deg\)/, '箭头翻转要由 aria-expanded 驱动（它同时是读屏的展开状态）');
  assert.match(hero, /data-add-src type="button" aria-expanded="false"/, '初始态要写死 false，箭头才有翻转基准');
  /* 状态一律从 <details> 的 toggle 事件镜像：用户直接点「订阅管理」那行时顶栏箭头也要跟着翻。
     写在 focusAddBox 里只覆盖得到「点按钮」这一条路。 */
  assert.match(src, /addEventListener\("toggle", onManageToggle\)/, 'toggle 要接到统一的镜像入口');
  assert.doesNotMatch(src, /function focusAddBox\(\)\s*\{[\s\S]{0,260}?aria-expanded/, '镜像逻辑不写在 focusAddBox 里');
  const attrs = [];
  fx.UI = { manage, addUrl, manageSummary: {}, addSrcBtn: { setAttribute: (k, v) => attrs.push(k + '=' + v) } };
  fx.onManageToggle();
  assert.deepEqual(attrs, ['aria-expanded=true'], '展开时按钮要带 aria-expanded=true');
  manage.open = false;
  attrs.length = 0;
  fx.onManageToggle();
  assert.deepEqual(attrs, ['aria-expanded=false'], '收起时要翻回去，不能只单向');
  fx.UI = null;
}

console.log('PASS: RSS/Atom/RDF 解析、实体与链接清洗、日期归一、订阅发现、合并保读、裁剪保护、筛选分组、筛选刷新契约、显示样式三档、description/content:encoded 取值优先级、卡片展开正文（含与同仓库插件同款的展开动画）、顶栏加源入口，以及清单/图标/生成物同步');
