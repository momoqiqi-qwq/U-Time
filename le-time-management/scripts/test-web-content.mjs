import assert from 'node:assert/strict';
import { normalizeWebUrl, resolveWebUrl, parseSiteMeta, inferSiteIconName, extractNoticeLinks, extractPager, noticeKind, extractArticleText, screenNotice, formEncode,
  charsetFromContentType, charsetFromMeta, looksLikeMarkup, decodeWebBody,
  detectSpaShell, matchJsonSiteAdapter, buildJsonSiteListUrl, parseJsonSiteList,
  parseGenericNoticeJson, extractEmbeddedJsonNotices, extractNoticeApiCandidates } from '../src/webContent.js';
assert.equal(normalizeWebUrl('example.edu.cn'), 'https://example.edu.cn/');
assert.equal(resolveWebUrl('../notice/1.htm', 'https://www.example.edu.cn/xw/list.htm'), 'https://www.example.edu.cn/notice/1.htm');
const html=`<html><head><meta property="og:site_name" content="示例大学"><link rel="icon" href="/logo.ico"></head><body><ul class="notice-list"><li><a href="/info/1001/1234.htm">关于开展 2026 年奖学金申报的通知</a><span>2026-09-10</span></li><li><a href="/">首页</a></li></ul></body></html>`;
const meta=parseSiteMeta(html,'https://www.example.edu.cn/news/');
assert.equal(meta.title,'示例大学');assert.equal(meta.iconUrl,'https://www.example.edu.cn/logo.ico');assert.equal(meta.iconName,'school');
const rows=extractNoticeLinks(html,'https://www.example.edu.cn/news/');assert.equal(rows.length,1);assert.equal(rows[0].url,'https://www.example.edu.cn/info/1001/1234.htm');assert.equal(rows[0].date,'2026-09-10');
const plain=`<ul><li><a href="/2026/0911/c123a456/page.htm">2026 年秋季学期本科生选课安排</a><span>2026-09-11</span></li></ul>`;
const plainRows=extractNoticeLinks(plain,'https://jwc.example.edu.cn/tzgg/');assert.equal(plainRows.length,1);assert.equal(plainRows[0].date,'2026-09-11');
assert.equal(inferSiteIconName('校园图书馆','https://lib.example.edu.cn'),'book-open');
assert.equal(formEncode({username:'张三',password:'a&b'}),'username=%E5%BC%A0%E4%B8%89&password=a%26b');

/* ── 导航 / 页脚 / 栏目页必须摘出去 ──
   真实取证：桂林电子科技大学招生信息网首页（2026-09-16 抓取）全页 45 条候选里，
   25 条是导航、页脚和学院目录（`/zs/2119/list.htm`、`桂公网安备…`、`招生动态`），
   真通知被挤在后面。判据用 screenNotice 这个纯函数压 —— Node 里没有 DOMParser，
   extractNoticeLinks 的 DOM 分支只能靠 output/notice-probe.cjs + Chrome 端到端验。 */
const GUET = 'https://www.guet.edu.cn/zs/';
assert.equal(screenNotice('数学与计算科学学院', 'https://www.guet.edu.cn/zs/2119/list.htm', '数学与计算科学学院', '', GUET), null,
  '学院目录指向 list.htm，必须摘掉');
assert.equal(screenNotice('招生动态', 'http://www.guet.edu.cn/zs/550/list.htm', '招生动态', '', GUET), null, '栏目 tab 也是列表页');
assert.equal(screenNotice('桂公网安备45030502000232号', 'http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=45030502000232', '主办单位：桂林电子科技大学招生办公室 桂公网安备45030502000232号', '', GUET), null,
  '页脚备案链接必须摘掉');
assert.equal(screenNotice('桂ICP备05000961号', 'https://beian.miit.gov.cn/', '桂ICP备05000961号', '', GUET), null);
assert.equal(screenNotice('学校简介', 'https://www.guet.edu.cn/zs/2023/0221/c543a58762/page.htm', '学校简介', '', GUET), null,
  '无日期的短栏目名必须摘掉');
const keep = screenNotice('关于临时调整本科招生咨询方式的通知', 'https://www.guet.edu.cn/zs/2023/0808/c551a104240/page.htm',
  '2026-08-16 关于临时调整本科招生咨询方式的通知', '2026-08-16', GUET);
assert.ok(keep >= 4, `真通知必须留下，实际评分 ${keep}`);
// 站外链接（公众号文章、友情链接）不一律排除，但必须带日期
assert.equal(screenNotice('某某大学教务处关于学籍管理工作的若干说明文件', 'https://other.example.com/x', '某某大学教务处关于学籍管理工作的若干说明文件', '', GUET), null,
  '无日期的站外链接要摘');
assert.ok(screenNotice('咨询面对面｜桂电2026年招生咨询活动预告！', 'https://mp.weixin.qq.com/s/abc', '2026-06-15 咨询面对面｜桂电2026年招生咨询活动预告！', '2026-06-15', GUET) >= 4,
  '带日期的公众号文章要留');
assert.equal(noticeKind('关于临时调整本科招生咨询方式的通知'), 'notice');
assert.equal(noticeKind('2026年全日制本科招生宣传册电子书'), 'news', '宣传册属于 news 而不是 notice');
assert.equal(noticeKind('我校2026年统招本科录取工作圆满结束（图）'), 'other');

/* ── JSON 接口型站点：服务端只吐空壳，列表靠浏览器执行 JS 后调接口渲染 ──
   真实取证：北航信息门户 `it.buaa.edu.cn/portal/pages/newsite/site/informationPc/zixun?system=news`
   返回 HTTP 200 / 11642 字节，但整页 **0 个 `<a>` 标签**、连 `<title>` 都是空的，
   body 里只有 `<div id="__nuxt">` 与 `window.__NUXT__` —— 纯 DOM 解析必然 0 条，
   而插件当时连「为什么」都不说，用户只看到「已读取 0 条公告」。
   数据只在它自己的接口里：`/portal/news/frontend/default/news-list`（实测无 cookie 可访问）。 */
const BUAA_URL = 'https://it.buaa.edu.cn/portal/pages/newsite/site/informationPc/zixun?system=news';
const BUAA_SHELL = '<!DOCTYPE html><html><head><meta charset="utf-8">'
  + '<script src="/portal/pages/_nuxt/entry.48836b41.js"></script></head>'
  + '<body><div id="__nuxt"></div><script>window.__NUXT__={config:{webid:"portal"}}</script></body></html>';

const shell = detectSpaShell(BUAA_SHELL);
assert.equal(shell && shell.framework, 'Nuxt', '北航空壳必须认出是 Nuxt');
assert.equal(shell && shell.links, 0, '空壳里的链接数要为 0 —— 提示文案直接引用它');
assert.equal(detectSpaShell(html), null, '普通服务端渲染页面不能被误判成空壳');
assert.equal(detectSpaShell(''), null, '空串不能抛，返回 null');

const adapter = matchJsonSiteAdapter(BUAA_URL);
assert.equal(adapter && adapter.id, 'buaa-portal');
assert.ok(adapter && adapter.label, '适配器要带可显示的 label，插件拿它当「适配模式」');
// 空壳页既没有 <title> 也没有 <link rel=icon> —— 站名会退成域名、图标只能猜 /favicon.ico，
// 所以这两样必须由适配器登记（实测 /favicon.ico 确实是真 ICO，1150 字节）。
assert.equal(adapter && adapter.title, '北航信息门户', '空壳页读不到 <title>，站名要靠适配器给');
assert.equal(adapter && adapter.icon, 'https://it.buaa.edu.cn/favicon.ico', '图标路径要拼成绝对地址');
assert.equal(matchJsonSiteAdapter('https://jwc.example.edu.cn/tzgg/'), null, '未登记的站点不该命中');
assert.equal(matchJsonSiteAdapter('https://it.buaa.edu.cn/portal/pages/newsite/site/informationPc/index'), null,
  '同域但不是资讯页，不该命中');
assert.equal(matchJsonSiteAdapter('不是网址'), null, '非法 URL 不能抛');

assert.equal(buildJsonSiteListUrl('buaa-portal', BUAA_URL),
  'https://it.buaa.edu.cn/portal/news/frontend/default/news-list?system=news&page=1&pageSize=100&need_all=1');
assert.equal(buildJsonSiteListUrl('buaa-portal', 'https://it.buaa.edu.cn/portal/pages/newsite/site/informationPc/zixun?system=tzgg'),
  'https://it.buaa.edu.cn/portal/news/frontend/default/news-list?system=tzgg&page=1&pageSize=100&need_all=1',
  '页面 URL 里的栏目参数要原样带给接口');
assert.equal(buildJsonSiteListUrl('没这个适配器', BUAA_URL), '', '未登记的 id 返回空串，插件好回退');

// 字段形状照实测响应压：`d.list[]` 里 title / url / publish_time / publish_date_time / cname
const BUAA_JSON = JSON.stringify({ e: 0, m: '操作成功', d: { total: 6616, list: [
  { id: '3286f56765fcda5325f1c8c3bdbf280e', title: '北航召开美育工作高质量发展研讨会',
    url: 'https://it.buaa.edu.cn/portal/pages/newsite/site/informationPc/details?id=3286f56765fcda5325f1c8c3bdbf280e&system=news',
    publish_time: '2026-09-16', publish_date_time: '2026-09-16 19:01', cname: '新闻资讯' },
  { id: 'b47df82fb2ca3b3d61a3bd24504e714e', title: '关于开展 2026 年秋季学期本科生选课工作的通知',
    url: 'https://it.buaa.edu.cn/portal/pages/newsite/site/informationPc/details?id=b47df82fb2ca3b3d61a3bd24504e714e&system=news',
    publish_time: '2026-09-14', publish_date_time: '2026-09-14 16:24', cname: '通知公告' },
  { id: 'short', title: '短', url: 'https://it.buaa.edu.cn/portal/pages/newsite/site/informationPc/details?id=short' },
] } });

const jrows = parseJsonSiteList('buaa-portal', BUAA_JSON, BUAA_URL);
assert.equal(jrows.length, 2, `标题短于 4 字的条目要丢掉，实际 ${jrows.length} 条`);
assert.equal(jrows[0].date, '2026-09-16', '要按日期倒序：9-16 排在 9-14 前面');
assert.equal(jrows[0].title, '北航召开美育工作高质量发展研讨会');
assert.equal(jrows[0].kind, 'other', '「研讨会」既不是通知也不是新闻动态');
assert.equal(jrows[0].snippet, '新闻资讯 · 2026-09-16 19:01', '摘要由 cname 与带时间的发布时间拼成');
assert.equal(jrows[1].date, '2026-09-14', 'publish_time 直接成为 date');
assert.equal(jrows[1].kind, 'notice', '含「通知」的标题要分类成 notice，好让「仅通知/公告」筛得出来');
assert.equal(jrows[1].snippet, '通知公告 · 2026-09-14 16:24');
assert.equal(jrows[1].url, 'https://it.buaa.edu.cn/portal/pages/newsite/site/informationPc/details?id=b47df82fb2ca3b3d61a3bd24504e714e&system=news',
  '绝对地址要原样保留（详情页靠 id 参数）');

// 接口挂了 / 改版了都必须安静返回空数组，插件好回退到 DOM 解析，而不是整页报错
assert.deepEqual(parseJsonSiteList('buaa-portal', '这不是 JSON', BUAA_URL), []);
assert.deepEqual(parseJsonSiteList('buaa-portal', JSON.stringify({ e: 1, m: '失败', d: null }), BUAA_URL), []);
assert.deepEqual(parseJsonSiteList('buaa-portal', JSON.stringify({ d: { list: '不是数组' } }), BUAA_URL), []);
assert.deepEqual(parseJsonSiteList('没这个适配器', BUAA_JSON, BUAA_URL), []);
assert.equal(parseJsonSiteList('buaa-portal', BUAA_JSON, BUAA_URL, { max: 1 }).length, 1, 'max 要生效');
// 对象形态的响应（宿主可能已解好 JSON）也要吃
assert.equal(parseJsonSiteList('buaa-portal', JSON.parse(BUAA_JSON), BUAA_URL).length, 2);

/* ── 通用前端渲染公告 / 消息栏：内嵌状态与接口候选 ──
   不同学校的公告栏常见形态：HTML 只有 Vue/Nuxt/Next 空壳，列表数据在
   `window.__INITIAL_STATE__`、`__NEXT_DATA__`，或脚本里某个 `/api/.../list` 接口里。
   这里不为具体学校写死字段，按常见 title/url/date/summary 同义键递归抽取。 */
const GENERIC_JSON = {
  data: {
    records: [
      { noticeTitle: '关于 2026 年研究生学业奖学金评审的通知', detailUrl: '/notice/detail?id=1001', publishTime: '2026-09-20 08:30', columnName: '通知公告' },
      { msgTitle: '图书馆中秋节开放安排', pcUrl: '/message/2002.html', createTime: 1790035200000, summary: '服务消息' },
      { title: '短', url: '/bad' },
    ],
  },
};
const genericRows = parseGenericNoticeJson(GENERIC_JSON, 'https://portal.example.edu.cn/notice/list');
assert.equal(genericRows.length, 2, '通用 JSON 递归解析要跳过短标题并保留有效公告');
const genericNotice = genericRows.find((x) => x.title.includes('奖学金评审'));
const genericMsg = genericRows.find((x) => x.title.includes('图书馆'));
assert.equal(genericNotice.url, 'https://portal.example.edu.cn/notice/detail?id=1001');
assert.equal(genericNotice.date, '2026-09-20');
assert.equal(genericNotice.kind, 'notice');
assert.equal(genericMsg.url, 'https://portal.example.edu.cn/message/2002.html');
assert.ok(genericMsg.date, '毫秒时间戳要能转成日期');
assert.deepEqual(parseGenericNoticeJson('不是 JSON', 'https://portal.example.edu.cn/'), []);

const embeddedHtml = `<html><body><div id="app"></div><script>
  window.__INITIAL_STATE__ = ${JSON.stringify(GENERIC_JSON)};
</script><script>const api="/api/notice/page?pageNo=1&pageSize=20"; const img="/assets/news.png";</script></body></html>`;
const embeddedRows = extractEmbeddedJsonNotices(embeddedHtml, 'https://portal.example.edu.cn/notice/');
assert.equal(embeddedRows.length, 2, '应能从 window.__INITIAL_STATE__ 内嵌状态里抽公告');
const apiCandidates = extractNoticeApiCandidates(embeddedHtml, 'https://portal.example.edu.cn/notice/');
assert.deepEqual(apiCandidates, ['https://portal.example.edu.cn/api/notice/page?pageNo=1&pageSize=20'],
  '脚本里的公告列表接口要被发现，静态图片资源不能混进候选');

/* ── 端到端：有 DOM 时才跑（浏览器环境），Node 下跳过 ── */
if (typeof DOMParser !== 'undefined') {
  const guet = `<html><body>
  <nav class="nav-second"><ul><li><a class="nav-second-a" href="/zs/2119/list.htm">数学与计算科学学院</a></li></ul></nav>
  <div class="panel-list"><ul>
    <li><span class="panel-list-date">2026-09-13</span><a href="/zs/2026/0913/c551a159536/page.htm">桂林电子科技大学2027年优秀应届本科毕业生免试攻读研究生拟推荐名单公示</a></li>
    <li><span class="panel-list-date">2026-08-16</span><a href="/zs/2023/0808/c551a104240/page.htm">关于临时调整本科招生咨询方式的通知</a></li>
  </ul></div>
  <footer><a href="http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=45030502000232">桂公网安备45030502000232号</a></footer>
  </body></html>`;
  const rows = extractNoticeLinks(guet, GUET);
  assert.equal(rows.length, 2, `导航与页脚要摘掉，实际 ${rows.length} 条`);
  const art = extractArticleText(`<html><body><nav><a href="/">首页</a></nav>
    <div id="vsb_content"><p>各学院：</p><p>现将 2026 年秋季学期本科生选课工作安排通知如下，请于 2026 年 9 月 20 日前完成第一轮选课，逾期系统将自动关闭。</p><p>教务处</p></div></body></html>`,
    'https://jwc.example.edu.cn/tzgg/1.htm');
  assert.ok(art.text.includes('现将 2026 年秋季学期本科生选课工作安排通知如下'), '正文没抽对');
  assert.ok(art.text.split('\n').length >= 3, '段落之间要保留换行');

  /* ── 真实取证：北大本科招生网 bkzs.pku.edu.cn 详情页（2026-09-17 抓取）──
     正文在 `.article-cont > #articleDiv` 里、只有一句话；而侧栏/导航/面包屑/页脚
     全是 div 带 class（.sidebar-mod/.x-header/.nav-mod/.bread-mod/.x-footer），
     整页没有 <nav>/<footer> 标签 —— 旧规则会退到整页兜底，把菜单页脚全吞进「正文」。
     结构照实压：① gpower CMS 的选择器要命中；② class 型导航/页脚不能进正文。 */
  const pkuArt = extractArticleText(`<html><body>
    <div class="sidebar-mod"><a href="../cjwt/index.htm">常见问题</a><div class="t">返回顶部</div></div>
    <div class="x-header"><div class="nav-mod"><a href="../index.htm">首页</a><a href="../zslb/qjjh/index.htm">强基计划</a><a href="../xkzy/xy/index.htm">学科专业</a></div></div>
    <div class="article-page"><div class="bread-mod"><a href="../index.htm">返回列表</a></div>
      <div class="article-head"><div class="t">北京大学2026年强基计划测试准考证打印通知</div>
        <div class="info"><span class="s">时间：2026.06.27 16:28</span></div></div>
      <div class="article-cont"><style>.gpCmsArticle00 p{line-height:180%}</style>
        <div id="articleDiv" class="gpCmsArticle00"><p>各位考生：</p>
          <p>北京大学2026年强基计划测试准考证已开放打印，请确认参加测试的考生登录北京大学本科招生网上报名平台（点击进入）查阅测试安排和打印准考证。</p>
          <p>北京大学招生办公室</p><p>2026年6月27日</p></div></div></div>
    <div class="x-footer"><div class="tit">友情链接：</div><span class="s">电话：010-62751407</span><a class="s" href="">京ICP备05065075号-8</a></div>
    </body></html>`, 'https://bkzs.pku.edu.cn/tzgg/b4238f5f73cf4165a49d1817a2e0434c.htm');
  assert.ok(pkuArt.text.includes('准考证已开放打印'), 'gpower CMS 的正文（#articleDiv/.article-cont）必须抽得到');
  assert.ok(!pkuArt.text.includes('常见问题') && !pkuArt.text.includes('学科专业') && !pkuArt.text.includes('返回列表'),
    `选择器命中时两翼导航不能混进正文，实际：${pkuArt.text.slice(0, 120)}`);
  assert.ok(!pkuArt.text.includes('友情链接') && !pkuArt.text.includes('京ICP备'),
    '页脚不能混进正文');
  // 没有 CMS 特征选择器可命中时走整页兜底 —— class 型导航/页脚同样要摘干净
  const pkuFallback = extractArticleText(`<html><body>
    <div class="nav-mod"><a href="index.htm">首页</a><a href="list.htm">通知公告</a></div>
    <div class="mainWrap"><p>现将 2026 年秋季学期本科生选课工作安排通知如下，请于 9 月 20 日前完成第一轮选课，逾期系统将自动关闭，请各位同学相互转告。</p></div>
    <div class="x-footer"><span class="s">电话：010-62751407</span></div></body></html>`,
    'https://jwc.example.edu.cn/tzgg/2.htm');
  assert.ok(pkuFallback.text.includes('选课工作安排通知如下'), '兜底路径要能抽到正文');
  assert.ok(!pkuFallback.text.includes('首页') && !pkuFallback.text.includes('电话'),
    `class 型导航/页脚（div.nav-mod/.x-footer）要从兜底里摘掉，实际：${pkuFallback.text.slice(0, 120)}`);
}

/* ── 响应体编码：中文站点常只在 <meta> 里声明 gb2312 ──
   真实取证：http://daxue.qiyemulu.cn/ 的响应头只有 `Content-Type: text/html`（不带 charset），
   编码只在 <meta http-equiv=Content-Type content="text/html; charset=gb2312"> 里声明。
   reqwest 的 text() 与 Response.text() 都不读 meta，会按 UTF-8 解 —— 标题就变成一串 `�`。 */
// GBK 编码的「大学网站大全」= b4f3 d1a7 cdf8 d5be b4f3 c8ab
const GBK_TITLE = new Uint8Array([0xb4, 0xf3, 0xd1, 0xa7, 0xcd, 0xf8, 0xd5, 0xbe, 0xb4, 0xf3, 0xc8, 0xab]);
const enc = new TextEncoder();
const GBK_PAGE = new Uint8Array([
  ...enc.encode('<html><head><meta http-equiv=Content-Type content="text/html; charset=gb2312"><title>'),
  ...GBK_TITLE,
  ...enc.encode('</title></head></html>'),
]);

assert.equal(charsetFromContentType('text/html; charset=gb2312'), 'gb2312');
assert.equal(charsetFromContentType('text/html; charset="UTF-8"'), 'utf-8', '带引号、大小写混写都要认，且统一成小写');
assert.equal(charsetFromContentType('text/html'), '', '头里没声明 charset 必须返回空串，好让 meta 兜底');
assert.equal(charsetFromContentType('<meta charset=gbk>'), 'gbk', '直接喂 meta 标签也要能取出来');

assert.equal(charsetFromMeta(GBK_PAGE), 'gb2312', '必须能从 <meta http-equiv> 里嗅出 gb2312');
assert.equal(charsetFromMeta(enc.encode('<meta charset="big5">')), 'big5', '简写 <meta charset> 也要认');
assert.equal(charsetFromMeta(enc.encode('<html><head><title>无声明</title>')), '', '没有 meta 声明就该返回空串');

// 核心回归：gb2312 正文必须解对，且不能残留替换字符
const decoded = decodeWebBody(GBK_PAGE, 'text/html');
assert.ok(decoded.includes('大学网站大全'), `gb2312 正文必须解对，实际：${decoded.slice(0, 60)}`);
assert.ok(!decoded.includes('\uFFFD'), 'gb2312 正文里不该出现替换字符 �');
// 端到端：刷新名称拿到的就是真标题（而不是乱码）
assert.equal(parseSiteMeta(decoded, 'http://daxue.qiyemulu.cn/').title, '大学网站大全');
assert.equal(inferSiteIconName(parseSiteMeta(decoded, 'http://daxue.qiyemulu.cn/').title, 'http://daxue.qiyemulu.cn/'), 'school',
  '标题解对之后图标推断也该跟着对上，而不是退回 globe');

// 响应头声明优先，且此时不去嗅探 meta
assert.equal(decodeWebBody(enc.encode('<meta charset="gbk">中文'), 'text/html; charset=utf-8'), '<meta charset="gbk">中文');

// 「正文是不是标记文档」这道判别必须挡得住「含标记片段的 JSON」
assert.equal(looksLikeMarkup(GBK_PAGE), true, '真 HTML 页面应判定为标记文档');
assert.equal(looksLikeMarkup(enc.encode('\r\n<!DOCTYPE html><html>')), true, '前置空白的 doctype 也要认');
assert.equal(looksLikeMarkup(enc.encode('{"html":"<meta charset=gbk>"}')), false, 'JSON 不能被当成标记文档');

// JSON 按规范恒 UTF-8：正文里出现 <meta charset=...> 也不能被带偏
const jsonBody = enc.encode('{"html":"<meta charset=gbk>","t":"中文"}');
assert.equal(decodeWebBody(jsonBody, 'application/json'), '{"html":"<meta charset=gbk>","t":"中文"}');
assert.equal(decodeWebBody(jsonBody, ''), '{"html":"<meta charset=gbk>","t":"中文"}',
  'content-type 缺失时也不能被 JSON 里的 <meta charset> 带偏');
// 反过来：content-type 缺失但正文确实是 HTML 页面时，仍要走 meta 兜底
assert.ok(decodeWebBody(GBK_PAGE, '').includes('大学网站大全'), '没有 content-type 的 gb2312 页面同样要解对');
// 未知 / 非法标签不能抛，回落 UTF-8
assert.equal(decodeWebBody(enc.encode('中文'), 'text/html; charset=x-unknown-9'), '中文');

/* ── 分页器：窗口里没印出来的页码也必须能拿到 ──
   真实取证：北京大学本科招生网「通知公告」（2026-09-19 抓取），每页只给 8 条、共 46 页，
   分页器**每页都只印 1…5 + 末页 46**（第 6 页的链接在第 1 页上根本不出现），
   且页码写在文件名上：第 2 页是 index1.htm。抄字面链接只能读到第 5 页。 */
const PKU_TZGG = 'https://bkzs.pku.edu.cn/tzgg/index.htm';
const PKU_PAGER = `<div class="paging-box">
  <a class="paging-item paging-arrow xfont xicon-left"></a>
  <a href="index.htm" class="paging-item paging-link cur">1</a>
  <a href="index1.htm" class="paging-item paging-link">2</a>
  <a href="index2.htm" class="paging-item paging-link">3</a>
  <a href="index3.htm" class="paging-item paging-link">4</a>
  <a href="index4.htm" class="paging-item paging-link">5</a>
  <span class="paging-item paging-dot">…</span><a href="index45.htm" class="paging-item paging-link">46</a>
  <a href="index1.htm" class="paging-item paging-arrow xfont xicon-right"></a>
</div><div class="paging-more"><a class="next_min" href="index1.htm">下一页</a></div>`;
const pkuPager = extractPager(PKU_PAGER, PKU_TZGG);
assert.equal(pkuPager.total, 46);
assert.equal(pkuPager.pages.length, 46, '缺的第 6~45 页要按通式补全，不然翻到第 5 页就断');
assert.equal(pkuPager.pages[0].url, PKU_TZGG, '第 1 页是省掉数字的 index.htm');
assert.equal(pkuPager.pages[5].url, 'https://bkzs.pku.edu.cn/tzgg/index5.htm', '第 6 页 → index5.htm（实测该页确实有 7 条 2025 年的通知）');
assert.equal(pkuPager.pages[45].url, 'https://bkzs.pku.edu.cn/tzgg/index45.htm', '补出来的末页要和分页器上的字面链接一致');

// 另外两种常见写法：下划线后缀（第 1 页连分隔符一起省）、查询参数
const underPager = extractPager('<a href="list.htm">1</a><a href="list_1.htm">2</a><a href="list_2.htm">3</a><a href="list_19.htm">20</a>', 'https://jwc.example.edu.cn/tzgg/list.htm');
assert.equal(underPager.total, 20);
assert.equal(underPager.pages[0].url, 'https://jwc.example.edu.cn/tzgg/list.htm');
assert.equal(underPager.pages[3].url, 'https://jwc.example.edu.cn/tzgg/list_3.htm');
const qsPager = extractPager('<a href="?page=1">1</a><a href="?page=2">2</a><a href="?page=3">3</a><a href="?page=12">12</a>', 'https://x.example.edu.cn/n/list.htm');
assert.equal(qsPager.pages[4].url, 'https://x.example.edu.cn/n/list.htm?page=5');

// 推不出通式时**绝不编造网址**：只回字面链接
const hashPager = extractPager('<a href="a7f3.htm">1</a><a href="b2c9.htm">2</a><a href="c1d8.htm">3</a><a href="e5a1.htm">9</a>', PKU_TZGG);
assert.equal(hashPager.total, 9);
assert.deepEqual(hashPager.pages.map((x) => x.page), [1, 2, 3, 9], '哈希分页只能照抄有的四页');
// 没有分页器 / 四位数（年份档）/ 别的栏目目录下的数字链接，都不算页码
assert.equal(extractPager('<a href="/tzgg/2026.htm">2026</a><a href="../xwzx/index5.htm">2</a><a href="index1.htm">3</a>', PKU_TZGG).total, 3,
  '异目录的数字链接不能当分页（会跳到别的栏目）');
assert.equal(extractPager('<ul><li><a href="/tzgg/2026/0911/c1a2.htm">关于放假的通知</a></li></ul>', PKU_TZGG).total, 1);
assert.deepEqual(extractPager('', PKU_TZGG).pages, []);
assert.equal(extractPager(PKU_PAGER, '不是网址').total, 1, 'baseUrl 非法时不能抛');

console.log('PASS: web URL normalization, site metadata, favicon, FA icon inference, generic notice extraction (nav/footer/listing-page screening), notice classification, article body extraction, form encoding, charset decoding, JSON-API site adapters, embedded JSON/API discovery and pager page-number synthesis');
