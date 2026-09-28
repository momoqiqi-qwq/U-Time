// 通用网页内容工具：网页收藏、学校公告等插件共用。
// 只处理 http/https，不执行抓取到的脚本，也不会绕过站点验证码。
export function normalizeWebUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("请输入网站地址");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "https://" + raw;
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error("仅支持 http/https 网站");
  u.hash = "";
  return u.toString();
}

export function resolveWebUrl(href, baseUrl) {
  try {
    const u = new URL(String(href || "").trim(), baseUrl);
    return /^https?:$/.test(u.protocol) ? u.toString() : "";
  } catch { return ""; }
}

// ── 响应体编码 ────────────────────────────────────────────────────────────
// 中文站点常见做法：响应头只给 `text/html`（**不带 charset**），编码只在
// `<meta http-equiv=Content-Type content="text/html; charset=gb2312">` 或
// `<meta charset="gbk">` 里声明。`Response.text()` 按规范恒按 UTF-8 解，
// 这种情况会解出满屏 `�` —— 所以自己按「响应头 → meta → UTF-8」解。
// Rust 侧 `decode_body()` 用同一套优先级，两端行为保持一致。

/** 从 Content-Type 头（或直接喂一个 `<meta>` 标签字符串）里取 charset 标签。 */
export function charsetFromContentType(contentType) {
  const m = String(contentType || "").match(/charset\s*=\s*["']?([\w.-]+)/i);
  return m ? m[1].toLowerCase() : "";
}

/** 从 HTML 头部（前 4KB）的 `<meta>` 里嗅探 charset。 */
export function charsetFromMeta(bytes) {
  const head = new TextDecoder("utf-8").decode(bytes.slice(0, 4096));
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    if (/charset/i.test(tag)) {
      const v = charsetFromContentType(tag);
      if (v) return v;
    }
  }
  return "";
}

/**
 * 正文本身是不是一份标记文档（而不是「含有标记片段的 JSON」）。
 * 首字符必须是 `<`，且 512 字节内出现 html / doctype / head / meta / ?xml 之一。
 * 这道判别是必要的：否则 `{"html":"<meta charset=gbk>"}` 这种 JSON 会被误判成
 * 声明了 gbk，反而把本来正确的 UTF-8 中文解坏。
 */
export function looksLikeMarkup(bytes) {
  const head = new TextDecoder("utf-8").decode(bytes.slice(0, 512)).replace(/^\uFEFF/, "");
  return /^\s*</.test(head) && /<(?:\/?html\b|!doctype\b|head\b|meta\b|\?xml\b)/i.test(head);
}

/**
 * 按声明编码解码响应体：响应头 charset → HTML meta charset → UTF-8 兜底。
 * 只在 content-type 为空或 html/xml、**且正文看起来确实是标记文档**时才嗅探 meta ——
 * JSON 按规范恒 UTF-8，不该被正文里偶然出现的 `<meta charset=...>` 带偏。
 */
export function decodeWebBody(bytes, contentType) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const ct = String(contentType || "").toLowerCase();
  const htmlish = !ct || ct.includes("html") || ct.includes("xml");
  const label = charsetFromContentType(contentType)
    || (htmlish && looksLikeMarkup(buf) ? charsetFromMeta(buf) : "")
    || "utf-8";
  try { return new TextDecoder(label).decode(buf); }
  catch { return new TextDecoder("utf-8").decode(buf); }
}

function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, " ").trim();
}

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = String(tag || "").match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function metaContent(html, keys) {
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop")).toLowerCase();
    if (keys.includes(key)) return cleanText(attr(tag, "content"));
  }
  return "";
}

export function inferSiteIconName(title, url) {
  const t = String(title || "").toLowerCase();
  const s = `${title || ""} ${url || ""}`.toLowerCase();
  if (/图书|library|book/.test(t)) return "book-open";
  if (/学校|大学|学院|校园|教务|education/.test(t)) return "school";
  const rules = [
    [/图书|library|book/, "book-open"], [/新闻|news|公告|通知/, "newspaper"],
    [/代码|github|gitlab|developer|开发/, "code"], [/视频|video|bilibili|youtube/, "circle-play"],
    [/音乐|music|audio|网易云|spotify/, "music"], [/邮箱|mail|email/, "envelope"],
    [/云盘|drive|disk|storage/, "cloud"], [/购物|shop|store|商城|taobao|jd\./, "cart-shopping"],
    [/地图|map|导航/, "map-location-dot"], [/论坛|forum|community|社区/, "comments"],
    [/文档|docs|wiki|知识/, "file-lines"], [/日历|calendar/, "calendar-days"],
    [/学校|大学|学院|edu\.|education|教务|校园/, "school"],
  ];
  return rules.find(([re]) => re.test(s))?.[1] || "globe";
}

export function parseSiteMeta(html, baseUrl) {
  const source = String(html || "");
  let title = metaContent(source, ["og:site_name", "application-name"]);
  if (!title) title = cleanText((source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  title = title.replace(/\s*[-_|｜·]\s*(首页|主页|home)\s*$/i, "").trim();
  let iconUrl = "";
  const links = source.match(/<link\b[^>]*>/gi) || [];
  const scored = [];
  for (const tag of links) {
    const rel = attr(tag, "rel").toLowerCase();
    const href = attr(tag, "href");
    if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) continue;
    const sizes = attr(tag, "sizes");
    const size = Math.max(...(sizes.match(/\d+/g) || [0]).map(Number));
    scored.push({ url: resolveWebUrl(href, baseUrl), score: (rel.includes("apple") ? 20 : 10) + size });
  }
  scored.sort((a, b) => b.score - a.score);
  iconUrl = scored.find((x) => x.url)?.url || resolveWebUrl("/favicon.ico", baseUrl);
  let host = "";
  try { host = new URL(baseUrl).hostname.replace(/^www\./, ""); } catch {}
  return { title: title || host || "未命名网站", iconUrl, iconName: inferSiteIconName(title, baseUrl), host };
}

function extractDate(text, yearHint = new Date().getFullYear()) {
  const s = String(text || "");
  let m = s.match(/(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  m = s.match(/(?:^|\s)(\d{1,2})[月\-\/.](\d{1,2})日?(?:\s|$)/);
  if (m) return `${yearHint}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  return "";
}

// ── 公告链接筛选：把导航 / 页脚 / 列表页摘出去 ─────────────────────────────
// 实测（桂林电子科技大学招生信息网首页，2026-09-16 抓取）：全页 45 条候选链接里
// 25 条是导航、页脚和学院目录，真通知反而被压在后面。三类判据能摘掉它们：
//   ① 站内导航指向「列表页」（`/zs/2118/list.htm`），真通知指向文章详情页；
//   ② 页脚备案/版权条目没有日期，且基本指向站外（`beian.gov.cn`）；
//   ③ 导航 / 页脚 / 侧栏容器里的链接，长得再像文章也不算通知。
// 站外链接不一律排除 —— 学校常用官方公众号发通知（`mp.weixin.qq.com`），
// 但要求它必须带日期，否则视为友情链接之类。
const NAV_TAGS = new Set(["nav", "header", "footer", "aside"]);
const NAV_SIGNATURE_RE = /(^|[\s_-])(nav|navbar|navigation|menu|submenu|footer|header|topbar|top-bar|breadcrumb|crumb|crumbs|friendlink|friend-link|links|copyright|banquan|sidebar|side-bar|sitemap|site-map|pager|pagination|quick|search|login)([\s_-]|$)/i;
const NOISE_TITLE_RE = /备案|icp\s*备|公网安备|版权所有|copyright|主办单位|技术支持|友情链接|无障碍|返回顶部|^更多$|^more$|^首页$|^home$|^english$|^登录$|^注册$|^返回$|^上一页$|^下一页$|^尾页$|^网站地图$|^联系我们$|^关于我们$/i;
// 无日期时用来判断「像通知还是像栏目名」的词表。`招生动态`、`学院简介` 这类栏目名
// 既短又不含这些词，会被摘掉；`关于XX的通知` 虽短但命中，保留。
const NOTICE_WORD_RE = /通知|公告|公示|通告|声明|安排|名单|报名|考试|选课|招生|招聘|讲座|活动|会议|放假|开学|评审|申报|招标|采购|结果|新闻|动态|要闻|notice|announce|news/i;
const MULTI_SUFFIX_RE = /\.(?:edu|gov|com|net|org|co|ac)\.cn$/i;

/** 取站点根域，`www.guet.edu.cn` 与 `jwc.guet.edu.cn` 视为同一站。 */
function siteKey(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    if (MULTI_SUFFIX_RE.test(host) && parts.length >= 3) return parts.slice(-3).join(".");
    return parts.slice(-2).join(".");
  } catch { return ""; }
}

/** 列表页 / 栏目页 / 首页 / 搜索页 —— 导航最爱指向的地方，不是通知本身。 */
function isListingUrl(href) {
  let u; try { u = new URL(href); } catch { return false; }
  if (/\/(?:list|index|default|column|channel|category|more)(?:_\d+)?\.(?:s?html?|jsp|aspx?|php)$/i.test(u.pathname)) return true;
  if (/_redirect|\/search\b|\/tags?\b/i.test(u.pathname)) return true;
  if (/[?&](?:page|p|pageNum|pageNo|pageIndex)=\d+/i.test(u.search)) return true;
  return u.pathname.split("/").filter(Boolean).length <= 1;
}

/** 链接是否落在导航 / 页脚 / 侧栏容器里（沿祖先链找 tag 与 class/id 特征）。 */
function inNavigationArea(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (NAV_TAGS.has(node.tagName.toLowerCase())) return true;
    const sig = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
    if (NAV_SIGNATURE_RE.test(sig)) return true;
  }
  return false;
}

const DATE_IN_TEXT_RE = /20\d{2}[年\-\/.]\d{1,2}[月\-\/.]\d{1,2}日?|\d{1,2}[月\-\/.]\d{1,2}日?/g;

/**
 * 列表项的 `context` 常常就是「日期 + 标题」的拼接（`2026-09-13 关于…的通知`），
 * 这种摘要和标题一字不差，显示出来纯属噪声 —— 日期字段本来就有。返回空串即不显示。
 */
function snippetOf(title, context) {
  const rest = String(context || "").replace(DATE_IN_TEXT_RE, " ").replace(/\s+/g, " ").trim();
  if (!rest) return "";
  if (rest.replace(/\s+/g, "") === title.replace(/\s+/g, "")) return "";
  return context.slice(0, 160);
}

function noticeScore(title, href, context, hasDate) {
  const all = `${title} ${href} ${context}`.toLowerCase();
  let score = 0;
  if (/通知|公告|公示|新闻|要闻|动态|notice|news|announcement/.test(all)) score += 7;
  if (/tzgg|gggs|xwzx|news|notice|article|content|info|show|detail/.test(href.toLowerCase())) score += 5;
  if (/list|news|notice|article|content|item/.test(context.toLowerCase())) score += 3;
  if (/\.(?:s?html?|aspx?)(?:[?#]|$)/i.test(href)) score += 2;
  if (/(?:\/|^)(?:20\d{2})[\/-]?(?:0?[1-9]|1[0-2])/.test(href) || /\/c?\d+(?:a\d+)?\//i.test(href)) score += 2;
  if (hasDate) score += 2;
  if (/登录|注册|首页|english|更多|more|下一页|上一页|下载|附件/.test(title.toLowerCase())) score -= 8;
  if (title.length >= 8 && title.length <= 80) score += 3;
  return score;
}

/**
 * 这条链接像不像通知。返回 `null` 表示「直接排除」，返回数字表示评分。
 * `date` 由调用方先算好，避免重复解析。导出是为了让回归测试能直接压判据
 * （Node 里没有 DOMParser，端到端只能靠 Chrome 探测脚本）。
 */
export function screenNotice(title, href, context, date, baseUrl) {
  if (NOISE_TITLE_RE.test(title)) return null;
  if (isListingUrl(href)) return null;
  const external = siteKey(href) !== siteKey(baseUrl);
  // 站外链接（备案查询、公众号文章、兄弟院校）必须带日期才算通知
  if (external && !date) return null;
  // 无日期时按标题判断：命中通知词的要够 6 字，否则得长到 16 字以上
  // —— `计算机与信息安全学院`（10 字栏目名）会被摘掉，长标题通知不会。
  if (!date && !(NOTICE_WORD_RE.test(title) ? title.length >= 6 : title.length >= 16)) return null;
  const score = noticeScore(title, href, context, !!date);
  return score < 4 ? null : score;
}

/**
 * 给条目分类：`notice`（通知/公告/公示…）、`news`（动态/宣传/介绍…）、`other`。
 * 招生办这类站点一个列表里混着「通知」和「宣传册/专业介绍」，插件据此让用户
 * 一键只看通知；分类只做提示，不会把任何条目丢掉。
 */
export function noticeKind(title) {
  const t = String(title || "");
  if (/通知|公告|公示|通告|声明|名单|报名|考试|选课|安排|评审|申报|招标|采购|中标|成交|结果|notice|announce/i.test(t)) return "notice";
  if (/新闻|动态|要闻|报道|活动|讲座|预告|宣传|介绍|风采|纪实|回顾|视频|news/i.test(t)) return "news";
  return "other";
}

const TITLE_KEYS = ["title", "bt", "name", "subject", "caption", "headline", "newsTitle", "noticeTitle", "articleTitle", "msgTitle"];
const URL_KEYS = ["url", "link", "href", "path", "jumpUrl", "detailUrl", "wapUrl", "pcUrl"];
const DATE_KEYS = ["date", "time", "publishTime", "publishDate", "publish_time", "createTime", "createdAt", "releaseTime", "pubDate", "pubtime", "addtime"];
const SNIP_KEYS = ["summary", "description", "desc", "content", "digest", "category", "channelName", "columnName", "typeName", "cname"];

function objectValueByKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  const lower = Object.create(null);
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v;
  for (const key of keys) {
    const v = lower[key.toLowerCase()];
    if (v != null && v !== "") return v;
  }
  return "";
}

function normalizeDateValue(value, yearHint) {
  if (value == null || value === "") return "";
  if (typeof value === "number") {
    const ms = value > 100000000000 ? value : value > 1000000000 ? value * 1000 : 0;
    if (ms) return new Date(ms).toISOString().slice(0, 10);
  }
  return extractDate(String(value), yearHint);
}

function jsonNoticeRow(raw, baseUrl, yearHint) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const title = cleanText(objectValueByKeys(raw, TITLE_KEYS));
  if (title.length < 4) return null;
  const href = resolveWebUrl(objectValueByKeys(raw, URL_KEYS), baseUrl);
  if (!href) return null;
  const date = normalizeDateValue(objectValueByKeys(raw, DATE_KEYS), yearHint)
    || extractDate(`${title} ${cleanText(objectValueByKeys(raw, SNIP_KEYS))}`, yearHint);
  const snippet = SNIP_KEYS.map((k) => cleanText(raw[k])).filter(Boolean).slice(0, 3).join(" · ");
  const score = noticeScore(title, href, snippet, !!date) + 20;
  if (score < 10) return null;
  return { title, url: href, date, score, kind: noticeKind(title), snippet: snippetOf(title, snippet) };
}

function collectJsonNoticeRows(value, baseUrl, options, out, depth = 0) {
  if (!value || depth > 8 || out.length >= options.max) return;
  if (Array.isArray(value)) {
    let local = [];
    for (const item of value) {
      const row = jsonNoticeRow(item, baseUrl, options.yearHint);
      if (row) local.push(row);
    }
    if (local.length) {
      for (const row of local) {
        if (out.length >= options.max) break;
        out.push(row);
      }
    }
    for (const item of value) collectJsonNoticeRows(item, baseUrl, options, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) collectJsonNoticeRows(v, baseUrl, options, out, depth + 1);
  }
}

function uniqueNoticeRows(rows, max) {
  const seen = new Set(), titleSeen = new Set(), out = [];
  for (const row of rows) {
    const key = String(row.url || "").replace(/[?#].*$/, "");
    const tkey = String(row.title || "").replace(/\s+/g, "");
    if (!key || seen.has(key)) continue;
    if (tkey.length >= 6 && titleSeen.has(tkey)) continue;
    seen.add(key); titleSeen.add(tkey);
    out.push(row);
    if (out.length >= max) break;
  }
  return out.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.score || 0) - (a.score || 0));
}

export function parseGenericNoticeJson(body, baseUrl, options = {}) {
  let data = body;
  if (typeof body === "string") {
    try { data = JSON.parse(body); } catch { return []; }
  }
  const max = Math.max(1, Math.min(200, Number(options.max) || 100));
  const rows = [];
  collectJsonNoticeRows(data, baseUrl, { max: max * 3, yearHint: Number(options.yearHint) || new Date().getFullYear() }, rows);
  return uniqueNoticeRows(rows, max);
}

function scriptTextBlocks(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const type = attr(m[1], "type").toLowerCase();
    if (type && !/json|javascript|ecmascript|module|ld\+json/.test(type)) continue;
    blocks.push(m[2] || "");
  }
  return blocks;
}

function balancedJsonAt(text, start) {
  const open = text[start], close = open === "{" ? "}" : "]";
  let depth = 0, quote = "", escp = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escp) escp = false;
      else if (c === "\\") escp = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return "";
}

export function extractEmbeddedJsonNotices(html, baseUrl, options = {}) {
  const max = Math.max(1, Math.min(200, Number(options.max) || 100));
  const rows = [];
  for (const block of scriptTextBlocks(html)) {
    const trimmed = block.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("["))) {
      rows.push(...parseGenericNoticeJson(trimmed, baseUrl, { ...options, max: max * 2 }));
      continue;
    }
    const marks = [...block.matchAll(/(?:__INITIAL_STATE__|__NEXT_DATA__|__NUXT__|window\.\w*DATA\w*|window\.\w*STATE\w*)\s*=\s*([\[{])/g)];
    for (const m of marks) {
      const json = balancedJsonAt(block, (m.index || 0) + m[0].lastIndexOf(m[1]));
      if (json) rows.push(...parseGenericNoticeJson(json, baseUrl, { ...options, max: max * 2 }));
    }
  }
  return uniqueNoticeRows(rows, max);
}

export function extractNoticeApiCandidates(html, baseUrl, options = {}) {
  const max = Math.max(1, Math.min(40, Number(options.max) || 12));
  const out = [], seen = new Set();
  const source = String(html || "");
  const re = /["'`]([^"'`<>\s]{3,260})["'`]/g;
  let m;
  while ((m = re.exec(source))) {
    const raw = m[1].replace(/\\\//g, "/");
    if (!/^(?:https?:)?\/\//i.test(raw) && !raw.startsWith("/")) continue;
    if (!/(notice|announce|news|article|message|msg|bulletin|inform|publish|list|page|portal|cms|content|栏目|通知|公告)/i.test(raw)) continue;
    if (/\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?|map)(?:[?#]|$)/i.test(raw)) continue;
    const url = resolveWebUrl(raw, baseUrl);
    if (!url || seen.has(url)) continue;
    let u; try { u = new URL(url); } catch { continue; }
    if (siteKey(url) !== siteKey(baseUrl)) continue;
    if (!/[?&](?:page|pageNo|pageNum|pageIndex|current|size|limit|rows)=/i.test(u.search)
      && !/\/(?:api|apis|open|portal|cms|content)\/.*(?:list|page|search|query|notice|news|message|bulletin)\b/i.test(u.pathname)
      && !/\/(?:notice|news|message|bulletin|article)[_-]?(?:list|page|search|query)\b/i.test(u.pathname)) continue;
    seen.add(url); out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

export function extractNoticeLinks(html, baseUrl, options = {}) {
  const source = String(html || ""), max = Math.max(1, Math.min(200, Number(options.max) || 80));
  const yearHint = Number(options.yearHint) || new Date().getFullYear();
  const rows = [];
  const seen = new Set();
  const seenTitle = new Set();
  // 同一篇通知常在不同栏目里各挂一次（如 `c550a136330` 与 `c9193a136330` 同名不同址），
  // 按标题再去一次重，否则列表里会出现两条一模一样的内容。
  const push = (title, href, date, score, snippet) => {
    const key = href.replace(/[?#].*$/, "");
    if (seen.has(key)) return;
    const tkey = title.replace(/\s+/g, "");
    if (tkey.length >= 6 && seenTitle.has(tkey)) return;
    seen.add(key); seenTitle.add(tkey);
    rows.push({ title, url: href, date, score, kind: noticeKind(title), snippet });
  };
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(source, "text/html");
    for (const a of doc.querySelectorAll("a[href]")) {
      const title = cleanText(a.textContent || a.getAttribute("title") || "");
      if (title.length < 4) continue;
      if (inNavigationArea(a)) continue;
      const href = resolveWebUrl(a.getAttribute("href"), baseUrl);
      if (!href || /(?:javascript:|#)$/i.test(href)) continue;
      const context = cleanText(a.closest("li,tr,article,section,div")?.textContent || a.parentElement?.textContent || title).slice(0, 260);
      const date = extractDate(context, yearHint);
      const score = screenNotice(title, href, context, date, baseUrl);
      if (score === null) continue;
      push(title, href, date, score, snippetOf(title, context));
    }
  } else {
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi; let m;
    while ((m = re.exec(source))) {
      const title = cleanText(m[2]); if (title.length < 4) continue;
      const href = resolveWebUrl(attr(m[1], "href"), baseUrl); if (!href) continue;
      const context = cleanText(source.slice(Math.max(0, m.index - 140), Math.min(source.length, re.lastIndex + 140)));
      const date = extractDate(context, yearHint);
      const score = screenNotice(title, href, context, date, baseUrl);
      if (score === null) continue;
      push(title, href, date, score, "");
    }
  }
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.score - a.score);
  return rows.slice(0, max);
}

// ── 分页器：列表页「第 N 页」的网址 ─────────────────────────────────────────
// 高校 CMS 的分页链接写法很不统一，实测到三种：
//   ① 页码写在文件名上 —— 北京大学本科招生网「通知公告」（2026-09-19 抓取）：
//      `<a href="index.htm" class="paging-item paging-link cur">1</a>`
//      `<a href="index1.htm" class="paging-item paging-link">2</a>` … 共 46 页，
//      一页只有 8 条，其余 360 来条历史通知全压在后面的页里；
//   ② 下划线后缀 `list_2.html`；③ 查询参数 `?page=2` / `&pageNum=3`。
// 三种写法的链接文字都是页码本身，所以统一按文字取号，不认 class 名
// （class 有 paging-/page-/pager-/next_min 等十几种写法，认不过来的）。
// 只收与当前列表页同目录的同源链接，挡掉正文里恰好是数字的其他链接。

/** 两条 URL 的最长公共前后缀，返回 `[前缀, 后缀]`（不重叠）。 */
function commonWrap(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return [a.slice(0, i), j ? a.slice(a.length - j) : ""];
}

/**
 * 按通式拼出某页网址。`n === 0` 就是「第一页省掉数字」那种写法（`index.htm`
 * 对应 `index1.htm`），连分隔符一起省（`list.htm` 对应 `list_1.htm`）；
 * 拼错的话通式过不了下面那道回校，宁可退回字面链接。
 */
function templatePageUrl(tpl, page) {
  const n = page - tpl.offset;
  if (n < 0) return "";
  if (n === 0) return `${tpl.prefix.replace(/[_-]$/, "")}${tpl.suffix}`;
  return `${tpl.prefix}${n}${tpl.suffix}`;
}

/**
 * 从已知页码链接里推出「页码 → 网址」通式 `{ prefix, offset, suffix }`，
 * 含义是 `url(page) = prefix + (page - offset) + suffix`。
 * 用**相邻两页**的 URL 差值定出数字段，再拿它回校所有已知链接：
 * 有一对能解释全部样本才算成立，否则返回 `null`（哈希分页之类根本不适用通式）。
 */
function pagerTemplate(known) {
  for (let i = 0; i + 1 < known.length; i++) {
    const [pa, ua] = known[i];
    const [pb, ub] = known[i + 1];
    if (pb - pa !== 1) continue;
    const [prefix, suffix] = commonWrap(ua, ub);
    const da = ua.slice(prefix.length, ua.length - suffix.length);
    const db = ub.slice(prefix.length, ub.length - suffix.length);
    if (!/^\d{1,3}$/.test(da) || !/^\d{1,3}$/.test(db)) continue;
    if (Number(db) - Number(da) !== 1) continue;
    const tpl = { prefix, offset: pb - Number(db), suffix };
    if (known.every(([p, u]) => { const url = templatePageUrl(tpl, p); return !url || url === u; })) return tpl;
  }
  return null;
}

/**
 * 列表页的分页器：`{ total, pages }`，pages 是按页码升序、**已补全 1..total** 的
 * `[{ page, url }]`。认不出分页器时返回 `{ total: 1, pages: [] }`。
 *
 * 补全这步不能省：分页器大多只给「窗口」（实测北大这站每页都只印 1…5 + 46，
 * 第 6 页的链接在第 1 页上根本不出现），只抄字面链接的话读到第 5 页就断了。
 */
export function extractPager(html, baseUrl) {
  let base; try { base = new URL(baseUrl); } catch { return { total: 1, pages: [] }; }
  const dirOf = (u) => u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  const source = String(html || "");
  const byPage = new Map();
  const byUrl = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(source))) {
    const text = cleanText(m[2]);
    if (!/^\d{1,3}$/.test(text)) continue;
    const page = Number(text);
    if (page < 1 || byPage.has(page)) continue;
    const url = resolveWebUrl(attr(m[1], "href"), baseUrl);
    if (!url) continue;
    let u; try { u = new URL(url); } catch { continue; }
    if (u.origin !== base.origin || dirOf(u) !== dirOf(base)) continue;
    const key = u.pathname + u.search;
    if (byUrl.has(key)) continue;
    byUrl.add(key);
    byPage.set(page, url);
  }
  const known = [...byPage].sort((a, b) => a[0] - b[0]);
  if (!known.length) return { total: 1, pages: [] };
  const total = known[known.length - 1][0];
  const tpl = pagerTemplate(known);
  const pages = [];
  for (let page = 1; page <= total; page++) {
    const url = byPage.get(page) || (tpl ? templatePageUrl(tpl, page) : "");
    if (url) pages.push({ page, url });
  }
  return { total, pages };
}

// ── JSON 接口型站点：服务端只吐空壳，列表靠浏览器执行 JS 后调接口渲染 ────────
// 实测（北京航空航天大学信息门户 `it.buaa.edu.cn`，2026-09-16）：页面返回 HTTP 200、
// 11642 字节，**一个 `<a>` 标签都没有**（连 `<title>` 都是空的），body 里只有
// `<div id="__nuxt">` 与 `window.__NUXT__` —— 典型的 Nuxt 3 客户端渲染页面。
// 公告数据只存在于它自己的 JSON 接口里，DOM 解析必然 0 条。所以这里补两件事：
//   ① `detectSpaShell()` 认出空壳，让插件能说明「为什么读不到」，而不是静默 0 条；
//   ② `JSON_SITE_ADAPTERS` 为已知站点登记「页面 URL → 接口 URL → 字段映射」，
//      插件命中后直接取接口。加新学校只需往表里加一条，不必改插件代码。

/** 命中即说明页面是 JS 渲染的空壳。 */
const SPA_SHELL_MARKERS = [
  [/\b__NUXT__\b|_nuxt\/|__nuxt_data__/i, "Nuxt"],
  [/\b__NEXT_DATA__\b|_next\/static/i, "Next.js"],
  [/data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__/, "React"],
  [/ng-version\s*=|ng-app\s*=/i, "Angular"],
  [/\bdata-v-app\b|\b__VUE__\b/, "Vue"],
];

/**
 * 页面是不是「靠 JS 渲染」的空壳。返回框架名与 HTML 里现成的链接数（供提示文案用），
 * 不是则返回 `null`。只在「解析结果为 0 条」时才该调用 —— 它是给用户解释原因用的。
 */
export function detectSpaShell(html) {
  const source = String(html || "");
  if (!source) return null;
  for (const [re, framework] of SPA_SHELL_MARKERS) {
    if (re.test(source)) return { framework, links: (source.match(/<a\b[^>]*\bhref\s*=/gi) || []).length };
  }
  return null;
}

/**
 * 已登记的「JSON 接口型」站点。字段含义：
 * - `host` / `path`：命中判据（`path` 省略表示该域下全部页面）。
 * - `api(u, opts)`：由**页面 URL** 推出列表接口地址（栏目参数原样吃回去）。
 * - `list`：响应里列表的字段路径；`fields`：每条记录的字段映射。
 *   `date` 支持 `YYYY-MM-DD` 或带时间的 `YYYY-MM-DD HH:mm`；`snippet` 可以是数组，按序拼接。
 */
const JSON_SITE_ADAPTERS = [
  {
    id: "buaa-portal",
    label: "北航信息门户（Nuxt 资讯接口）",
    host: /(^|\.)buaa\.edu\.cn$/i,
    path: /\/informationPc\/zixun\b/i,
    // `?system=news` 就是栏目，原样传回接口；pageSize 实测放到 100 不被限。
    api: (u, opts) => `${u.origin}/portal/news/frontend/default/news-list`
      + `?system=${encodeURIComponent(u.searchParams.get("system") || "news")}`
      + `&page=1&pageSize=${Math.max(1, Math.min(100, Number(opts?.max) || 100))}&need_all=1`,
    list: "d.list",
    fields: { title: "title", url: "url", date: "publish_time", snippet: ["cname", "publish_date_time"] },
    // 空壳页**既没有 `<title>` 也没有 `<link rel=icon>`**，`parseSiteMeta()` 只能退成
    // 「域名 + 猜一个 /favicon.ico」。适配器本来就认识这个站，把这两样登记清楚，
    // 免得站点名显示成 `it.buaa.edu.cn`、图标靠猜（实测 `/favicon.ico` 确实是真 ICO，16×16）。
    meta: { title: "北航信息门户", iconPath: "/favicon.ico" },
  },
];

/** 页面 URL 命中哪个适配器。返回 `{ id, label, title, icon }`（可序列化，便于跨宿主边界传）。 */
export function matchJsonSiteAdapter(url) {
  let u; try { u = new URL(String(url || "")); } catch { return null; }
  for (const a of JSON_SITE_ADAPTERS) {
    if (!a.host.test(u.hostname) || (a.path && !a.path.test(u.pathname))) continue;
    return {
      id: a.id, label: a.label,
      title: a.meta?.title || "",
      icon: a.meta?.iconPath ? resolveWebUrl(a.meta.iconPath, u.href) : "",
    };
  }
  return null;
}

/** 由页面 URL 推出列表接口地址；未登记或 URL 非法时返回空串。 */
export function buildJsonSiteListUrl(id, url, options = {}) {
  const a = JSON_SITE_ADAPTERS.find((x) => x.id === id);
  if (!a) return "";
  try { return a.api(new URL(String(url || "")), options); } catch { return ""; }
}

function readPath(obj, path) {
  return String(path || "").split(".").filter(Boolean)
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * 把接口响应解析成与 `extractNoticeLinks()` **同构**的条目 —— 插件两条取数路径
 * 共用同一套渲染、搜索与分类。解析失败 / 字段缺失 / 条目不成形一律跳过、不抛：
 * 接口不可用时插件要能安静地回退到 DOM 解析，而不是整个报错。
 */
export function parseJsonSiteList(id, body, baseUrl, options = {}) {
  const a = JSON_SITE_ADAPTERS.find((x) => x.id === id);
  if (!a) return [];
  let data = body;
  if (typeof body === "string") { try { data = JSON.parse(body); } catch { return []; } }
  const list = readPath(data, a.list);
  if (!Array.isArray(list)) return [];
  const max = Math.max(1, Math.min(200, Number(options.max) || 100));
  const yearHint = Number(options.yearHint) || new Date().getFullYear();
  const rows = [], seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const title = cleanText(readPath(raw, a.fields.title));
    if (title.length < 4) continue;
    const href = resolveWebUrl(readPath(raw, a.fields.url), baseUrl);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const date = extractDate(String(readPath(raw, a.fields.date) || ""), yearHint);
    // 摘要去掉与 date 重复的部分（接口常同时给 `2026-09-16` 与 `2026-09-16 19:01`）。
    const snippet = [].concat(a.fields.snippet || []).map((k) => cleanText(readPath(raw, k)))
      .filter((v) => v && v !== date).join(" · ");
    rows.push({ title, url: href, date, score: 50, kind: noticeKind(title), snippet });
    if (rows.length >= max) break;
  }
  rows.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  return rows;
}

// ── 详情页正文提取 ────────────────────────────────────────────────────────
// 「展开正文」用：把详情页里的正文抽出来，不必为了看一眼内容就跳出应用。
// 先试常见 CMS 的正文容器（VSB 的 `#vsb_content`、WordPress 的 `.entry-content`…），
// 再用「文本量 × (1 − 链接密度)」挑最像正文的块 —— 导航和页脚恰恰是链接密度最高的。
const ARTICLE_SELECTORS = [
  "#vsb_content", "#vsb_content_2", "#vsb_content_4", ".v_news_content", ".wp_articlecontent",
  // 实测（北大本科招生网 bkzs.pku.edu.cn 详情页，2026-09-17 抓取）：gpower CMS 的正文
  // 在 `.article-cont > #articleDiv.gpCmsArticle00` 里，正文只有一句话 —— 上面的选择器
  // 全部落空，就会退到整页兜底，把两翼的菜单页脚全吞进「正文」。
  "#articleDiv", ".article-cont", ".gpCmsArticle00",
  "#content", ".content", ".article-content", ".article_content", ".article-content-wrap",
  "#article", ".article", ".news_content", "#news_content", ".news-content",
  ".entry-content", ".post-content", ".detail-content", ".detail_content",
  ".main-content", "#main-content", "article", ".text", ".txt",
];

/** 把元素里的块级结构摊平成带换行的纯文本（段落之间留 `\n`）。 */
function blockText(el) {
  const clone = el.cloneNode(true);
  for (const b of clone.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,table,br")) {
    if (b.tagName.toLowerCase() === "br") b.replaceWith("\n");
    else b.insertAdjacentText("afterend", "\n");
  }
  return String(clone.textContent || "").replace(/\u00a0/g, " ")
    .split("\n").map((s) => s.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

export function extractArticleText(html, baseUrl, options = {}) {
  const source = String(html || "");
  const limit = Math.max(200, Math.min(20000, Number(options.limit) || 6000));
  if (typeof DOMParser === "undefined") {
    return { title: "", date: "", text: cleanText(source).slice(0, limit), url: baseUrl };
  }
  const doc = new DOMParser().parseFromString(source, "text/html");
  for (const el of doc.querySelectorAll("script,style,noscript,iframe,form,nav,header,footer,aside,button,select,svg")) el.remove();
  // 实测（北大本科招生网 bkzs.pku.edu.cn 详情页，2026-09-17 抓取）：侧栏 / 导航 / 页脚
  // 全是「div 带 class」（.sidebar-mod / .x-header / .nav-mod / .x-footer），整页一个
  // <nav>/<footer> 标签都没有 —— 只按标签删，正文兜底就会把菜单和页脚全吞进「正文」。
  // 所以再按 id/class 特征删一轮容器，判据与公告链接筛选共用同一套 NAV_SIGNATURE_RE。
  for (const el of [...doc.querySelectorAll("body *")]) {
    const sig = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`;
    if (sig.trim() && NAV_SIGNATURE_RE.test(sig)) el.remove();
  }
  const title = (metaContent(source, ["og:title", "twitter:title"])
    || cleanText(doc.querySelector("h1")?.textContent || "")
    || cleanText(doc.querySelector("title")?.textContent || "")).trim();
  const metaText = cleanText([...doc.querySelectorAll(".publish,.date,.time,.info,.article-info,.news-info,#publish,.source,.meta,.author,time")]
    .map((x) => x.textContent || "").join(" ")).slice(0, 300);
  const date = extractDate(metaText) || extractDate(title);
  let best = null;
  for (const sel of ARTICLE_SELECTORS) {
    for (const el of doc.querySelectorAll(sel)) {
      const text = blockText(el);
      if (text.length < 80) continue;
      const linkLen = [...el.querySelectorAll("a")].reduce((n, a) => n + cleanText(a.textContent || "").length, 0);
      const density = text.length ? linkLen / text.length : 1;
      if (density > 0.5) continue;
      const score = text.length * (1 - density) + (sel.startsWith("#") ? 200 : 0);
      if (!best || score > best.score) best = { text, score };
    }
  }
  const text = (best ? best.text : doc.body ? blockText(doc.body) : cleanText(source)).slice(0, limit);
  return { title, date, text, url: baseUrl };
}

export function detectLoginForm(html, baseUrl) {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const forms = [...doc.querySelectorAll("form")];
  const candidates = forms.map((form) => {
    const inputs = [...form.querySelectorAll("input[name],select[name],textarea[name]")].map((el) => ({
      name: el.getAttribute("name") || "", type: (el.getAttribute("type") || (el.tagName === "INPUT" ? "text" : el.tagName) || "text").toLowerCase(),
      value: el.getAttribute("value") || "", placeholder: el.getAttribute("placeholder") || "",
    }));
    const hasPassword = inputs.some((x) => x.type === "password");
    const text = cleanText(form.textContent || "") + " " + inputs.map((x) => `${x.name} ${x.placeholder}`).join(" ");
    let score = hasPassword ? 20 : 0; if (/登录|统一身份|账号|用户名|login|username|password/i.test(text)) score += 8;
    return { form, inputs, score, text };
  }).sort((a, b) => b.score - a.score);
  const hit = candidates[0]; if (!hit || hit.score < 8) return null;
  const user = hit.inputs.find((x) => /user|account|login|name|xh|gh|username|userid|yhm/i.test(`${x.name} ${x.placeholder}`) && x.type !== "hidden" && x.type !== "password") || hit.inputs.find((x) => ["text", "email", "tel"].includes(x.type));
  const password = hit.inputs.find((x) => x.type === "password");
  const captcha = hit.inputs.find((x) => /captcha|verify|validate|vcode|checkcode|yzm|验证码/i.test(`${x.name} ${x.placeholder}`));
  const img = [...hit.form.querySelectorAll("img[src]")].find((x) => /captcha|verify|validate|vcode|checkcode|yzm|code/i.test(`${x.getAttribute("src")} ${x.getAttribute("id")} ${x.getAttribute("class")} ${x.getAttribute("alt")}`));
  return {
    action: resolveWebUrl(hit.form.getAttribute("action") || baseUrl, baseUrl),
    method: (hit.form.getAttribute("method") || "POST").toUpperCase(),
    fields: hit.inputs,
    usernameField: user?.name || "", passwordField: password?.name || "", captchaField: captcha?.name || "",
    captchaImageUrl: img ? resolveWebUrl(img.getAttribute("src"), baseUrl) : "",
  };
}

export function formEncode(fields) {
  return Object.entries(fields || {}).filter(([k, v]) => k && v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}
