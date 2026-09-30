/* ═══════════════════════════════════════════════════════════════════
   RSS 信息流 · 内置插件

   把若干 RSS / Atom 源聚合成一条时间倒序的信息流。三处刻意的取舍：

   ① 解析器自己写，不用 DOMParser。
      · 现实里的中文源（高校 / 政务 / 老博客尤甚）常带未转义的裸 `&`、
        缺闭合标签、`<![CDATA[` 里混 HTML —— 交给 DOMParser 会直接
        parsererror，整源报废；字符串解析则能捞回大部分字段。
      · RSS 2.0 / Atom / RDF(RSS 1.0) 的字段差异用「候选标签名列表」就能覆盖，
        不需要完整 XML 语义。
      · 纯字符串实现不碰 DOM，可以在 node 里直接跑测试
        （scripts/test-rss-reader.mjs）—— 这是本插件可测的前提。

   ② 网络走 tide.http.get（Rust 侧 reqwest）。绝大多数 RSS 源不发
      Access-Control-Allow-Origin，浏览器直连必失败。

   ③ 缓存条目按「每源最近 N 条 + 全局上限」裁剪，但**未读与星标不受条数限制**，
      否则会出现「还没看就被裁掉」，未读数自己往下掉。

   权限对账：manifest 声明 ui / storage / notify / http / openUrl /
   tasks / blocks / timeParse，与下面用到的 tide.* 一一对应，多一个都没写。
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  const VIEW_ID = "rss-reader";
  const CACHE_MAX = 600;        // 全局缓存条目上限
  const PER_FEED_KEEP = 60;     // 每个源保留的最近条数
  const CONCURRENCY = 3;        // 同时抓取的源数量
  const CHUNK = 20;             // 每次渲染的条数
  const STALE_MS = 15 * 60 * 1000; // 距上次刷新超过这个时长，进视图自动抓一次
  const AUTO_CHOICES = [0, 15, 30, 60]; // 自动刷新间隔（分钟），0 = 关闭

  /* 默认订阅：四个长期稳定、体积小、无版权争议的中文源。
     ⚠️ 预置源的**可达性不在 npm test 里守**（测试必须离线可跑）⇒ 改这里的 URL 前后
     都要真抓一次：`node scripts/check-feed-urls.mjs` —— 它用**真解析器**跑一遍，
     报出状态码 / 内容类型 / 条目数 / 摘要有无，比只看 200 可靠。
     实测踩过：一条 GitHub Pages 已迁站的 404 地址差点当成可用源发出去。
     橘鸦AI早报是「一天一条」，条目 title 就是日期（2026-09-18）—— 卡片档靠摘要区分，
     紧凑 / 标题档会显示成一列日期，这是该源的形态，不是缺陷。 */
  const DEFAULT_FEEDS = [
    { url: "https://sspai.com/feed", title: "少数派" },
    { url: "https://www.ruanyifeng.com/blog/atom.xml", title: "阮一峰的网络日志" },
    { url: "https://www.infoq.cn/feed", title: "InfoQ 中文" },
    { url: "https://daily.juya.uk/rss.xml", title: "橘鸦AI早报" },
  ];
  /* 一键添加的推荐源（与默认源不重叠） */
  const SUGGESTED_FEEDS = [
    { url: "https://feed.cnblogs.com/news/rss", title: "博客园新闻" },
    { url: "https://www.appinn.com/feed/", title: "小众软件" },
    { url: "https://www.ithome.com/rss/", title: "IT之家" },
    { url: "https://coolshell.cn/feed", title: "酷壳" },
  ];
  /* 源标记色：只用在 6px 圆点上，深色模式下也不会刺眼 */
  const FEED_COLORS = ["#0F4C5C", "#118AB2", "#2EC4B6", "#9B5DE5", "#E3A008", "#FF6B6B", "#5B6BE8", "#5B8F7B"];
  /* 没在 HTML 里声明 feed 时，按常见约定路径兜底试（顺序即优先级） */
  const COMMON_PATHS = ["/feed", "/rss", "/atom.xml", "/feed.xml", "/index.xml", "/rss.xml"];
  /* 条目显示样式。三档都渲染**同一个** .rss-card 容器（只加密度差异），
     因为 ui.list 的点击委托是 `closest(".rss-card")` —— 换容器类名等于把打开/收藏/提醒全弄哑。
     布局差异全部走 CSS：wrap 上挂 data-style，选择器写 .rss-wrap[data-style="compact"] …。 */
  const STYLES = ["card", "compact", "title"];
  const STYLE_LABELS = { card: "卡片", compact: "紧凑", title: "标题" };

  const state = {
    feeds: [],           // [{ id, url, title, color, enabled, addedAt, lastAt, lastError, count }]
    items: [],           // [{ id, feedId, title, link, date, author, snippet, cover, read, star }]
    prefs: { kw: "", feed: "all", unreadOnly: false, starOnly: false, autoMin: 0, showCover: true, style: "card" },
    expanded: new Set(),     // 已展开正文的条目 id
    bodies: new Map(),       // link → 抽出的原文正文。**只留内存**：一篇几 KB 到几十 KB，写进 storage 会把缓存撑爆
    bodyLoading: new Set(),  // 正在抓正文的 link（防重复请求，也让重绘后仍显示「正在读取正文…」）
    fetchedAt: 0,
    fetching: false,
    error: null,
    rendered: CHUNK,
  };
  let ui = null;
  let autoTimer = null;
  let paintToken = 0;

  /* ═══════════════ 文本工具 ═══════════════ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* 实体解码。必须「一次扫描、逐个体替换」—— 分两轮（先 &amp; 再 &lt;）会把
     `&amp;lt;` 二次解码成 `<`，把用户文本里的尖括号还原出来。 */
  const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
    hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”",
    lsquo: "‘", rsquo: "’", times: "×", middot: "·", bull: "•", copy: "©",
  };
  function decodeEntities(s) {
    return String(s == null ? "" : s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
      if (body[0] === "#") {
        const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
        try { return String.fromCodePoint(cp); } catch (e) { return whole; }
      }
      const hit = NAMED_ENTITIES[body.toLowerCase()];
      return hit === undefined ? whole : hit;
    });
  }

  function stripCdata(s) {
    return String(s == null ? "" : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  }

  /* 摘要 / 标题 → 纯文本：先剥 CDATA（有的源把整段 HTML 塞在里面），
     再解实体（有的源把 HTML 转义成 &lt;p&gt;），最后去标签。顺序不能反 ——
     先解实体才能把转义过的标签也去掉。

     去标签分两步，两处都有实际后果：
     · 行内标签（<a> <b> <strong>…）**删除不留空格** —— 中文里 <a> 常包住一整段，
       留空格会把「查看全文」切成「查看 全文」；
     · 其余块级标签替换成空格，避免相邻段落粘成一个词；
     · 且只认「标签名以字母开头」：`&lt;9 月 20 日&gt;` 解出来是正文不是标签，
       一刀切 /<[^>]*>/ 会把它删掉（"报名截止 ，请抓紧"）。浏览器 tokenizer 同规则。 */
  const INLINE_TAGS = "a|b|i|em|strong|span|code|small|sub|sup|u|s|mark|abbr|cite|q|kbd|samp|var|time|bdi|bdo|ruby|rt|rp|font|label|ins|del|wbr";
  function toText(raw) {
    return decodeEntities(stripCdata(raw))
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/p>/gi, " ")
      .replace(new RegExp("<\\/?(?:" + INLINE_TAGS + ")\\b[^>]*>", "gi"), "")
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
      .replace(/<[!?][^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clip(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  /* 路径归一：折掉 . 与 .. —— 相对 href 拼出来的 "…/blog/../2026/x.html" 是脏地址，
     存进缓存、显示在卡片里都难看，也不该指望下游替我们收拾。query / fragment 原样带过。 */
  function normalizePath(p) {
    const s = String(p == null ? "" : p);
    const cut = s.search(/[?#]/);
    const path = cut >= 0 ? s.slice(0, cut) : s;
    const tail = cut >= 0 ? s.slice(cut) : "";
    const absolute = path.startsWith("/");
    const segs = path.split("/");
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === ".") continue;
      if (seg === "..") {
        // 绝对路径的 out[0] 是空串（split 的产物），不能被 pop 掉，否则会越过根
        if (out.length > (absolute ? 1 : 0) && out[out.length - 1] !== "..") out.pop();
        else if (!absolute) out.push("..");
        continue;
      }
      out.push(seg);
    }
    let res = out.join("/");
    if (absolute && !res.startsWith("/")) res = "/" + res;
    return res + tail;
  }

  /* 相对链接 → 绝对。不依赖 URL 构造器：它在插件沙箱与测试环境里未必存在，
     且失败时会抛异常。返回值保证只有 http(s) 或空串，杜绝 javascript: 之类。 */
  function absolutize(href, base) {
    const h = String(href == null ? "" : href).trim().replace(/[\r\n\t]/g, "");
    if (!h) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return /^https?:/i.test(h) ? h : "";
    if (h.startsWith("//")) return "https:" + h;
    const b = String(base == null ? "" : base).trim();
    const m = b.match(/^(https?:\/\/[^/?#]+)([^?#]*)/i);
    if (!m) return "";
    const origin = m[1];
    const path = m[2] || "/";
    if (h.startsWith("#")) return origin + path;
    if (h.startsWith("/")) return origin + normalizePath(h);
    const dir = path.endsWith("/") ? path : path.replace(/[^/]*$/, "");
    return origin + normalizePath(dir + h);
  }

  /* 规范化用户输入的地址：允许 "sspai.com/feed" 这种省略协议的写法，
     但**非 http(s) 的 scheme 一律拒绝** —— 否则 "javascript:alert(1)" 会被
     补成 "https://javascript:alert(1)"，虽然最终打不通，也没必要把它带进存储。 */
  function normalizeFeedUrl(input) {
    let s = String(input == null ? "" : input).trim().replace(/^feed:\/\//i, "https://");
    if (!s) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
    return /^https?:\/\/[^/?#\s]+/i.test(s) ? s : "";
  }

  function hostOf(url) {
    const m = String(url || "").match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1] : "";
  }

  /* 二次确认与输入。宿主把插件跑在主窗口里（new Function("tide", …)），所以
     window.confirm / prompt 可用；但 Tauri WebView 对原生弹窗的支持并不一致，
     拿不到就退回安全侧 —— 确认放行、改名取消（dorm-duty / inbox-drop 同款兜底）。 */
  function confirmFn(msg) {
    try {
      if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(msg);
    } catch (e) { /* 弹窗本身不该把删除流程卡死 */ }
    return true;
  }
  function promptFn(msg, value) {
    try {
      if (typeof window !== "undefined" && typeof window.prompt === "function") return window.prompt(msg, value);
    } catch (e) { /* 退回「不改名」 */ }
    return null;
  }

  /* 稳定的短 id：同一条目跨次抓取必须得到同一个 id，否则已读/星标每次刷新就丢。
     用 FNV-1a 32 位 —— 不追求抗碰撞，只要求确定性与短。 */
  function hashId(s) {
    let h = 2166136261;
    const t = String(s == null ? "" : s);
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  /* ═══════════════ XML / RSS 解析 ═══════════════ */

  /* 取第一个匹配标签的文本内容。标签名可带命名空间前缀（content:encoded / dc:creator），
     所以前缀一律用 (?:[\w.-]+:)? 容忍。 */
  function tagText(block, names) {
    for (let i = 0; i < names.length; i++) {
      const n = names[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("<(?:[\\w.-]+:)?" + n + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + n + "\\s*>", "i");
      const m = block.match(re);
      if (m) {
        const v = decodeEntities(stripCdata(m[1])).trim();
        if (v) return v;
      }
    }
    return "";
  }

  /* 从一个标签串里取属性值（属性可能用单引号、双引号或裸值）。 */
  function attrOf(tag, name) {
    const re = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i");
    const m = String(tag || "").match(re);
    if (!m) return "";
    return decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : (m[3] || "")).trim();
  }

  /* 频道自身的站点地址。Atom 的 <feed> 里往往同时挂着 rel=self（feed 地址本身）
     和 rel=alternate（站点首页），顺序还不固定 —— 直接取第一个 link 会拿到 feed 地址，
     把「打开网站」指向 XML。和条目一样按 rel 挑。 */
  function channelLink(head) {
    const tags = String(head || "").match(/<(?:[\w.-]+:)?link\b[^>]*\/?>/gi) || [];
    let fallback = "";
    for (let i = 0; i < tags.length; i++) {
      const href = attrOf(tags[i], "href");
      if (!href) continue;
      const rel = (attrOf(tags[i], "rel") || "alternate").toLowerCase();
      if (rel === "alternate") return href;
      if (!fallback) fallback = href;
    }
    return fallback;
  }

  /* 条目链接。Atom 用 <link href>（且有 self / alternate 多个），RSS 用 <link>文本。
     优先 rel=alternate 的 href，再退到 <link> 文本，最后才看 <guid>/<id>。 */
  function itemLink(block, baseUrl) {
    const linkTags = String(block || "").match(/<(?:[\w.-]+:)?link\b[^>]*\/?>/gi) || [];
    let fallback = "";
    for (let i = 0; i < linkTags.length; i++) {
      const href = attrOf(linkTags[i], "href");
      if (!href) continue;
      const rel = (attrOf(linkTags[i], "rel") || "alternate").toLowerCase();
      if (rel === "alternate") return absolutize(href, baseUrl);
      if (!fallback) fallback = href;
    }
    if (fallback) return absolutize(fallback, baseUrl);
    const text = tagText(block, ["link"]);
    if (text) return absolutize(text, baseUrl);
    const guid = tagText(block, ["guid", "id"]);
    if (/^https?:\/\//i.test(guid)) return guid;
    return "";
  }

  /* 作者。Atom 是 <author><name>阮一峰</name><uri>…</uri></author>，
     直接取 <author> 的文本会把 uri 一起吞进来（"阮一峰 http://…"），
     所以要先钻进 <name>。RSS 2.0 则走 <dc:creator> 或 <author> 纯文本。 */
  function itemAuthor(block) {
    const direct = toText(tagText(block, ["dc:creator", "creator"]));
    if (direct) return direct;
    const holder = String(block || "").match(/<(?:[\w.-]+:)?author\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?author\s*>/i);
    if (holder) {
      const inner = toText(tagText(holder[1], ["name"])) || toText(holder[1]);
      if (inner) return inner;
    }
    return toText(tagText(block, ["name"]));
  }

  function itemCover(block, baseUrl) {
    const enc = String(block || "").match(/<(?:[\w.-]+:)?enclosure\b[^>]*>/i);
    if (enc) {
      const url = attrOf(enc[0], "url");
      const type = attrOf(enc[0], "type").toLowerCase();
      if (url && (type.startsWith("image") || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url))) return absolutize(url, baseUrl);
    }
    const media = String(block || "").match(/<(?:[\w.-]+:)?(?:content|thumbnail|image)\b[^>]*>/gi) || [];
    for (let i = 0; i < media.length; i++) {
      const url = attrOf(media[i], "url");
      if (url && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url)) return absolutize(url, baseUrl);
    }
    const body = block.match(/<(?:[\w.-]+:)?(?:description|summary|content)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:description|summary|content)\s*>/i);
    if (body) {
      const img = decodeEntities(stripCdata(body[1])).match(/<img[^>]+src\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
      if (img) return absolutize(img[1] || img[2], baseUrl);
    }
    return "";
  }

  /* 日期归一化成「YYYY-MM-DD HH:mm」本地时间串 —— 排序与显示共用一种形态。
     认不出来的返回空串（条目仍然展示，只是排在「时间未知」组）。 */
  function parseDateAny(raw) {
    const t = String(raw == null ? "" : raw).trim();
    if (!t) return "";
    const viaDate = new Date(t);
    if (!Number.isNaN(viaDate.getTime()) && sane(viaDate)) return toLocal(viaDate);
    // 兜底：Date 构造函数吃不下的写法（"2026-09-18 08:17:34"、"2026/09/18 08:17"）
    const m = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
      if (!Number.isNaN(d.getTime()) && sane(d)) return toLocal(d);
    }
    return "";
  }
  function sane(d) {
    const y = d.getFullYear();
    return y >= 1990 && y <= 2100;
  }
  function toLocal(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function looksLikeFeed(body) {
    const head = String(body || "").slice(0, 2000);
    return /<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]|<channel[\s>]/i.test(head);
  }
  function looksLikeHtml(body) {
    const head = String(body || "").slice(0, 600).trimStart();
    return /^<(!doctype\s+html|html[\s>])/i.test(head);
  }

  /* 从站点 HTML 里找声明的订阅地址（<link rel="alternate" type="application/rss+xml">）。
     返回候选数组，按 rss+xml > atom+xml > 其他 xml 排序 —— 有的站同时挂两个。 */
  function discoverFeedUrls(html, baseUrl) {
    const tags = String(html || "").match(/<link\b[^>]*>/gi) || [];
    const rss = [], atom = [], other = [];
    for (let i = 0; i < tags.length; i++) {
      const rel = (attrOf(tags[i], "rel") || "").toLowerCase();
      if (!rel.split(/\s+/).includes("alternate")) continue;
      const type = (attrOf(tags[i], "type") || "").toLowerCase();
      const href = attrOf(tags[i], "href");
      if (!href) continue;
      const abs = absolutize(href, baseUrl);
      if (!abs) continue;
      if (/rss\+xml/.test(type)) rss.push(abs);
      else if (/atom\+xml/.test(type)) atom.push(abs);
      else if (/xml/.test(type)) other.push(abs);
    }
    return [...new Set([...rss, ...atom, ...other])];
  }

  /* 解析一份 feed。返回 { title, site, items }；items 里的字段已全部清洗过。
     任何字段缺失都不抛错 —— 只有「整份不是 feed」才返回 null。 */
  function parseFeed(body, baseUrl) {
    const xml = String(body == null ? "" : body).replace(/^\uFEFF/, "");
    if (!looksLikeFeed(xml)) return null;

    // 频道头 = 第一个 item/entry 之前的片段（channel / feed 元信息都在那里）
    const firstItem = xml.search(/<(?:[\w.-]+:)?(?:item|entry)\b/i);
    const head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
    const site = tagText(head, ["link"]) || channelLink(head);
    const title = toText(tagText(head, ["title"]));

    const blocks = [];
    const re = /<(?:[\w.-]+:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>/gi;
    let m;
    while ((m = re.exec(xml))) blocks.push(m[2]);

    const items = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const link = itemLink(block, baseUrl) || absolutize(site, baseUrl);
      const rawTitle = toText(tagText(block, ["title"]));
      const desc = tagText(block, ["description", "summary", "content:encoded", "content"]);
      const snippet = clip(toText(desc), 220);
      const author = itemAuthor(block);
      const date = parseDateAny(tagText(block, ["pubDate", "published", "updated", "dc:date", "date", "lastBuildDate"]));
      const guid = tagText(block, ["guid", "id"]);
      if (!link && !rawTitle) continue; // 空壳条目（有的源会留占位）直接丢
      items.push({
        key: guid || link || rawTitle,
        title: rawTitle || "(无标题)",
        link,
        date,
        author: clip(author, 40),
        snippet,
        cover: itemCover(block, baseUrl),
      });
    }
    return { title, site: absolutize(site, baseUrl) || baseUrl, items };
  }

  /* ═══════════════ 存储 ═══════════════ */

  async function loadPrefs() {
    const p = await tide.storage.get("prefs", null);
    if (p && typeof p === "object") state.prefs = { ...state.prefs, ...p };
    if (!AUTO_CHOICES.includes(Number(state.prefs.autoMin))) state.prefs.autoMin = 0;
    if (typeof state.prefs.showCover !== "boolean") state.prefs.showCover = true;
    /* 旧数据里没有 style（或被人手改成别的串）⇒ 回落卡片档，不能让未知值漏进 CSS 选择器 */
    if (!STYLES.includes(state.prefs.style)) state.prefs.style = "card";
  }
  const savePrefs = () => tide.storage.set("prefs", state.prefs);

  async function loadFeeds() {
    const raw = await tide.storage.get("feeds", null);
    let list = Array.isArray(raw) ? raw : null;
    if (!list) {
      list = DEFAULT_FEEDS.map((f, i) => makeFeed(f.url, f.title, i));
      await tide.storage.set("feeds", list);
    }
    state.feeds = list.map((f, i) => ({ ...f, color: f.color || FEED_COLORS[i % FEED_COLORS.length] }));
  }
  function makeFeed(url, title, index) {
    return {
      id: hashId(url),
      url,
      title: title || hostOf(url),
      color: FEED_COLORS[(index || 0) % FEED_COLORS.length],
      enabled: true,
      addedAt: Date.now(),
      lastAt: 0,
      lastError: "",
      count: 0,
    };
  }
  const saveFeeds = () => tide.storage.set("feeds", state.feeds.map((f) => ({ ...f })));

  async function loadItems() {
    const raw = await tide.storage.get("items", []);
    state.items = Array.isArray(raw) ? raw.filter((it) => it && it.id && it.feedId) : [];
    state.fetchedAt = Number(await tide.storage.get("fetchedAt", 0)) || 0;
  }
  function publishItems() {
    try {
      tide.messages?.publish(state.items.slice(0, 80).map((item) => {
        const feed = state.feeds.find((f) => f.id === item.feedId);
        return { title: item.title || "", time: item.date || "", sender: item.author || "", sourceName: feed?.title ? `RSS·${feed.title}` : "RSS 订阅" };
      }));
    } catch {}
  }
  async function saveItems() {
    await tide.storage.set("items", state.items);
    await tide.storage.set("fetchedAt", state.fetchedAt);
  }

  /* 合并新抓到的条目：同 id 保留原有的 read / star（这是「刷新不掉已读」的关键）。 */
  function mergeItems(feedId, fresh, out) {
    const byId = new Map(state.items.map((it) => [it.id, it]));
    let added = 0;
    for (let i = 0; i < fresh.length; i++) {
      const raw = fresh[i];
      const id = feedId + ":" + hashId(raw.key);
      const old = byId.get(id);
      if (old) {
        old.date = raw.date || old.date;
        old.title = raw.title || old.title;
        old.link = raw.link || old.link;
        old.snippet = raw.snippet || old.snippet;
        old.cover = raw.cover || old.cover;
        old.author = raw.author || old.author;
      } else {
        const item = {
          id, feedId,
          title: raw.title, link: raw.link, date: raw.date,
          author: raw.author, snippet: raw.snippet, cover: raw.cover,
          read: false, star: false,
        };
        byId.set(id, item);
        if (out) out.push(item);   // 传了 out 才收集本次新增条目（notice:new 广播要条目本身，不只是计数）
        added += 1;
      }
    }
    state.items = trimItems([...byId.values()]);
    return added;
  }

  /* 裁剪：每源只留最近 PER_FEED_KEEP 条，但**未读与星标不受条数限制**；
     全局超上限时星标保底留下。 */
  function trimItems(list) {
    const sorted = [...list].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const perFeed = new Map();
    const kept = [];
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      const n = (perFeed.get(it.feedId) || 0) + 1;
      perFeed.set(it.feedId, n);
      if (n <= PER_FEED_KEEP || it.star || !it.read) kept.push(it);
    }
    if (kept.length <= CACHE_MAX) return kept;
    const stars = kept.filter((it) => it.star);
    const rest = kept.filter((it) => !it.star).slice(0, Math.max(0, CACHE_MAX - stars.length));
    return [...stars, ...rest].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }

  /* ═══════════════ 抓取 ═══════════════ */

  async function httpGet(url) {
    const res = await tide.http.get(url);
    if (!res || typeof res.status !== "number") throw new Error("网络返回异常");
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    return res;
  }

  async function fetchFeed(feed) {
    try {
      const res = await httpGet(feed.url);
      const parsed = parseFeed(res.body, res.finalUrl || feed.url);
      if (!parsed) {
        throw new Error(looksLikeHtml(res.body) ? "这个地址返回的是网页，不是订阅源" : "内容不是有效的 RSS / Atom");
      }
      if (parsed.title && (!feed.title || feed.customTitle !== true)) feed.title = parsed.title;
      // 这个源本地还没有任何条目 = 首次同步：全部条目都是「新增」，但它们是历史存量，
      // 只入库不广播，否则刚订阅一个源就把几十条旧内容推到微信。
      const firstSync = !state.items.some((it) => it.feedId === feed.id);
      const news = [];
      const added = mergeItems(feed.id, parsed.items, news);
      feed.lastAt = Date.now();
      feed.lastError = "";
      feed.count = parsed.items.length;
      return { feed, added, total: parsed.items.length, news: firstSync ? [] : news };
    } catch (e) {
      feed.lastError = String((e && e.message) || e);
      feed.lastAt = Date.now();
      return { feed, added: 0, total: 0, error: feed.lastError };
    }
  }

  /* ── 插件联动：抓到新内容时广播 notice:new，微信推送插件按插件勾选合并成一条推送 ──
     所有源的新条目并成一次广播（标题前缀源名），不按源各发一次 —— 推送侧要省着占 PushPlus 频次额度。
     广播失败不影响抓取本身，所以单独 try/catch。 */
  function broadcastNews(news) {
    if (!news.length) return;
    try {
      tide.events.emit("notice:new", {
        source: "rss-reader", sourceName: "RSS 订阅", total: news.length,
        items: news.slice(0, 5).map(({ feed, item }) => ({
          title: `${feed.title || hostOf(feed.url)}｜${item.title || "(无标题)"}`,
          time: item.date || "",
          sender: item.author || "",
        })),
      });
    } catch {}
  }

  /* 并发抓取：CONCURRENCY 个 worker 抢同一个游标 —— 比 Promise.all 全量并发温和，
     源多时不会一次打出十几个请求（部分源会直接 429）。 */
  async function refreshAll() {
    if (state.fetching) return;
    const targets = state.feeds.filter((f) => f.enabled !== false);
    if (!targets.length) { tide.notify("还没有启用的订阅源，先到「订阅管理」里添加"); return; }
    state.fetching = true;
    state.error = null;
    paintStatus();
    let cursor = 0;
    let added = 0;
    const failures = [];
    const news = [];
    const worker = async () => {
      while (cursor < targets.length) {
        const feed = targets[cursor++];
        const r = await fetchFeed(feed);
        added += r.added;
        for (const item of r.news || []) news.push({ feed, item });
        if (r.error) failures.push(feed.title || hostOf(feed.url));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
      state.fetchedAt = Date.now();
      state.error = failures.length ? "有 " + failures.length + " 个源抓取失败：" + failures.join("、") : null;
      await Promise.all([saveFeeds(), saveItems()]);
      publishItems();
    } catch (e) {
      state.error = String((e && e.message) || e);
    }
    state.fetching = false;
    paintAll();
    if (added > 0) {
      tide.notify("收到 " + added + " 条新内容", {
        actionLabel: "查看", ms: 6000,
        action: () => tide.util.navigate(VIEW_ID),
      });
    }
    broadcastNews(news);
  }

  /* 添加订阅：地址可能是 feed 本身，也可能是网站首页。后者先读 HTML 找声明的
     feed，再按常见约定路径兜底试 —— 用户不该被迫自己去翻网页源码。 */
  async function addFeed(input) {
    const url = normalizeFeedUrl(input);
    if (!url) { tide.notify("请输入有效的网址"); return; }
    if (state.feeds.some((f) => f.url === url)) { tide.notify("这个源已经在订阅列表里了"); return; }
    const feed = makeFeed(url, "", state.feeds.length);
    feed.title = hostOf(url);
    tide.notify("正在识别 " + hostOf(url) + " …");

    let parsed = null, finalUrl = url;
    try {
      const res = await httpGet(url);
      parsed = parseFeed(res.body, res.finalUrl || url);
      if (parsed) finalUrl = res.finalUrl || url;
      else if (looksLikeHtml(res.body) || !looksLikeFeed(res.body)) {
        const origin = "https://" + hostOf(res.finalUrl || url);
        const candidates = discoverFeedUrls(res.body, res.finalUrl || url);
        for (let i = 0; i < COMMON_PATHS.length && candidates.length < 3; i++) candidates.push(origin + COMMON_PATHS[i]);
        for (let i = 0; i < candidates.length && !parsed; i++) {
          if (candidates[i] === url) continue;
          try {
            const r2 = await httpGet(candidates[i]);
            const p2 = parseFeed(r2.body, r2.finalUrl || candidates[i]);
            if (p2) { parsed = p2; finalUrl = r2.finalUrl || candidates[i]; }
          } catch (e) { /* 候选地址不可用是常态，继续试下一个 */ }
        }
      }
    } catch (e) {
      tide.notify("抓取失败：" + String((e && e.message) || e));
      return;
    }
    if (!parsed) { tide.notify("没找到订阅地址，请直接填写 RSS / Atom 链接"); return; }

    if (state.feeds.some((f) => f.url === finalUrl)) { tide.notify("这个源已经在订阅列表里了"); return; }
    feed.url = finalUrl;
    feed.id = hashId(finalUrl);
    feed.title = parsed.title || hostOf(finalUrl);
    feed.customTitle = false;
    feed.lastAt = Date.now();
    feed.count = parsed.items.length;
    mergeItems(feed.id, parsed.items);
    state.feeds = state.feeds.concat(feed);
    await Promise.all([saveFeeds(), saveItems()]);
    paintAll();
    tide.notify("已订阅「" + feed.title + "」（" + parsed.items.length + " 条）");
  }

  /* ═══════════════ 派生数据 ═══════════════ */

  const feedById = (id) => state.feeds.find((f) => f.id === id) || null;
  const feedTitle = (id) => {
    const f = feedById(id);
    return f ? f.title : "已移除的源";
  };
  const feedColor = (id) => {
    const f = feedById(id);
    return f ? f.color : FEED_COLORS[0];
  };
  const unreadCount = (feedId) => state.items.filter((it) => !it.read && (!feedId || it.feedId === feedId)).length;

  function filtered() {
    const kw = state.prefs.kw.trim().toLowerCase();
    const rows = state.items.filter((it) => {
      if (state.prefs.feed !== "all" && it.feedId !== state.prefs.feed) return false;
      if (state.prefs.unreadOnly && it.read) return false;
      if (state.prefs.starOnly && !it.star) return false;
      if (kw && !(String(it.title).toLowerCase().includes(kw) || String(it.snippet).toLowerCase().includes(kw))) return false;
      return true;
    });
    return rows.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }

  function dayDiff(a, b) {
    const da = new Date(a + "T00:00:00"), db = new Date(b + "T00:00:00");
    return Math.round((da - db) / 86400000);
  }
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function groupOf(dt) {
    const d = String(dt || "").slice(0, 10);
    if (!d) return "时间未知";
    const today = tide.util.today();
    if (d === today) return "今天";
    const diff = dayDiff(today, d);
    if (diff === 1) return "昨天";
    if (diff > 1 && diff < 7) return "本周";
    return "更早";
  }
  function fmtWhen(dt) {
    const s = String(dt || "");
    if (!s) return "";
    const d = s.slice(0, 10), hm = s.slice(11, 16);
    const today = tide.util.today();
    if (d === today) return hm;
    const diff = dayDiff(today, d);
    if (diff === 1) return "昨天 " + hm;
    if (diff > 1 && diff < 7) return WEEK[new Date(d + "T00:00:00").getDay()] + " " + hm;
    return d.slice(5) + " " + hm;
  }
  function fmtClock(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ═══════════════ 样式 ═══════════════ */

  function ensureStyle() {
    if (document.getElementById("rss-style")) return;
    const st = document.createElement("style");
    st.id = "rss-style";
    st.textContent = `
.rss-wrap{max-width:900px;margin:0 auto;padding:14px 0 34px;color:var(--ink,#22303A)}
.rss-eyebrow{font-size:calc(11px * var(--ui-text-scale));letter-spacing:.3em;color:var(--ink-3,#A9B2BA)}
.rss-hero{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:16px;padding:13px 14px}
.rss-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rss-top .rss-grow{flex:1;min-width:0}
.rss-unread{font-size:calc(11px * var(--ui-text-scale));font-weight:700;border-radius:999px;padding:3px 9px;background:var(--deep,#0F4C5C);color:var(--on-deep,#fff);flex:none}
.rss-toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:10px}
.rss-lab{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);letter-spacing:.14em;flex:none;width:32px}
.rss-input{flex:1;min-width:150px;height:34px;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:0 11px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);font-size:calc(12.5px * var(--ui-text-scale))}
.rss-btn{height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--line,#E4DFD6);background:var(--panel,#fff);color:var(--ink,#22303A);font-size:calc(12.5px * var(--ui-text-scale));cursor:pointer;flex:none}
.rss-btn:hover{border-color:var(--deep,#0F4C5C);color:var(--deep,#0F4C5C)}
.rss-btn.pri{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff);font-weight:600}
.rss-btn.pri:hover{color:var(--on-deep,#fff);opacity:.92}
.rss-btn:disabled{opacity:.5;cursor:default}
.rss-select{height:34px;border:1px solid var(--line,#E4DFD6);border-radius:9px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);font-size:calc(12.5px * var(--ui-text-scale));padding:0 8px}
.rss-toggle{display:inline-flex;align-items:center;gap:6px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);cursor:pointer;user-select:none;flex:none}
.rss-toggle i{width:32px;height:18px;border-radius:10px;background:var(--line,#E4DFD6);display:inline-block;position:relative;transition:.15s;flex:none}
.rss-toggle i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--panel,#fff);transition:.15s}
.rss-toggle.on i{background:var(--mint,#2EC4B6)}
.rss-toggle.on i::after{left:16px}
.rss-chips{display:flex;gap:7px;flex-wrap:wrap;flex:1;min-width:0}
.rss-chip{font-size:calc(12px * var(--ui-text-scale));border:1px solid var(--line,#E4DFD6);background:var(--panel,#fff);border-radius:999px;padding:5px 12px;cursor:pointer;color:var(--ink-2,#7E8B94);display:inline-flex;align-items:center;gap:6px}
.rss-chip:hover{border-color:var(--deep,#0F4C5C)}
.rss-chip.on{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
.rss-chip .n{font-size:calc(10.5px * var(--ui-text-scale));opacity:.75}
.rss-chip:disabled{opacity:.45;cursor:default}
/* 源名长度不可控（InfoQ 的 title 是「InfoQ - 促进软件开发领域知识与创新的传播」），
   必须自己截断：flex 容器上的 text-overflow 对匿名文本节点不生效，得先包一层块级子元素。 */
.rss-chip-name{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rss-dot{width:6px;height:6px;border-radius:50%;flex:none;display:inline-block}
/* 顶栏的「＋ 添加源」：虚线描边，与实心边框的源 chip 区分开 —— 读起来是「这里能加」，不是「又一个源」 */
.rss-add-src{flex:none;display:inline-flex;align-items:center;gap:3px;height:30px;padding:0 12px;border:1px dashed var(--line,#E4DFD6);border-radius:999px;background:none;color:var(--ink-2,#7E8B94);font-size:calc(12px * var(--ui-text-scale));cursor:pointer;transition:border-color .2s ease,color .2s ease}
.rss-add-src:hover{border-color:var(--deep,#0F4C5C);border-style:solid;color:var(--deep,#0F4C5C)}
/* 展开箭头：窄屏下「添加源」三个字要为 chips 让位收掉（见下面的媒体查询），只剩一个 ＋ 读不出
   「这是把手、点它会摊开一块面板」。箭头是订阅管理展开态的镜像，时长与曲线照抄 .rss-expand::after。 */
.rss-add-src::after{content:"⌄";display:inline-block;font-size:calc(13px * var(--ui-text-scale));line-height:1;transform:translateY(-1px);transition:transform .36s cubic-bezier(.22,.8,.22,1)}
.rss-add-src[aria-expanded="true"]::after{transform:translateY(1px) rotate(180deg)}
.rss-status{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);margin-top:9px;line-height:1.7}
.rss-status .err{color:var(--danger,#B03535)}
.rss-status b{color:var(--ink,#22303A)}
.rss-manage{margin-top:11px;border:1px solid var(--line,#E4DFD6);border-radius:14px;background:var(--panel,#fff)}
.rss-manage>summary{cursor:pointer;padding:11px 14px;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);list-style:none;display:flex;align-items:center;gap:8px}
.rss-manage>summary::-webkit-details-marker{display:none}
.rss-manage>summary::before{content:"▸";font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);transition:.15s}
.rss-manage[open]>summary::before{transform:rotate(90deg)}
.rss-manage-body{padding:0 14px 14px}
.rss-src{display:flex;align-items:flex-start;gap:9px;padding:9px 0;border-top:1px solid var(--line-soft,#EFEAE1)}
.rss-src:first-child{border-top:0}
.rss-src-main{flex:1;min-width:0}
.rss-src-name{font-size:calc(13px * var(--ui-text-scale));font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rss-src-url{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.rss-src-meta{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);margin-top:3px;line-height:1.6}
.rss-src-meta .err{color:var(--danger,#B03535)}
.rss-src.off{opacity:.55}
.rss-src-act{display:flex;gap:6px;flex-wrap:wrap;flex:none;justify-content:flex-end}
.rss-src-act button{font-size:calc(11px * var(--ui-text-scale));border:1px solid var(--line,#E4DFD6);border-radius:7px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);padding:4px 9px;cursor:pointer}
.rss-src-act button:hover{border-color:var(--deep,#0F4C5C);color:var(--deep,#0F4C5C)}
.rss-hint{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);line-height:1.75;margin-top:7px}
.rss-group{font-size:calc(12px * var(--ui-text-scale));font-weight:700;color:var(--deep,#0F4C5C);padding:14px 2px 7px;letter-spacing:.04em}
.rss-card{display:flex;gap:11px;align-items:flex-start;background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:14px;padding:11px 13px;margin-bottom:8px;content-visibility:auto;contain-intrinsic-size:auto 88px}
.rss-card:hover{border-color:var(--deep,#0F4C5C)}
.rss-card.read{opacity:.62}
/* 展开态必须退出 content-visibility:auto（否则滚出屏幕时按 88px 占位收，正文再滚回来会跳），
   并且不再压已读的 62% 透明度 —— 正在读的长文被调暗了读不动。 */
.rss-card.open{content-visibility:visible;opacity:1}
.rss-card-main{flex:1;min-width:0}
.rss-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.rss-src-tag{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line-soft,#EFEAE1);background:var(--paper,#F7F6F2);border-radius:999px;padding:2px 9px;color:var(--ink-2,#7E8B94);max-width:170px}
.rss-src-tag .rss-tag-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rss-new{background:var(--coral,#FF6B6B);color:var(--deep-2,#12333D);border-radius:7px;padding:1px 6px;font-size:calc(10px * var(--ui-text-scale));font-weight:700}
.rss-card-title{font-size:calc(14px * var(--ui-text-scale));font-weight:650;line-height:1.5;margin:5px 0 0;color:var(--ink,#22303A);cursor:pointer}
.rss-card.read .rss-card-title{font-weight:600}
.rss-snip{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.65;margin:5px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
/* 展开正文的动画与 警大通知 .pp-detail-shell、学校通知 .sn-detail-shell **逐字同款**：
   高度用 grid-template-rows 0fr→1fr 撑（实测 Chromium 里「定长轨道（px 或 lh）→ 1fr」只做
   discrete 插值 —— 前一半时间停在原高再一次性跳到位，只有 0fr 起跳才连续），
   箭头 ⌄ 转 180°，正文再补一个 translateY 收口。时长与曲线一律照抄，不要在这里另起一套。 */
.rss-expand{margin-top:7px;display:inline-flex;align-items:center;gap:7px;font-size:calc(11px * var(--ui-text-scale));transition:background .2s ease,border-color .2s ease,color .2s ease}
.rss-expand::after{content:"⌄";display:inline-block;font-size:calc(14px * var(--ui-text-scale));line-height:1;transform:translateY(-1px);transition:transform .36s cubic-bezier(.22,.8,.22,1)}
.rss-card.open .rss-expand::after{transform:translateY(1px) rotate(180deg)}
.rss-detail-shell{display:grid;grid-template-rows:0fr;opacity:0;margin-top:0;transition:grid-template-rows .42s cubic-bezier(.2,.78,.2,1),opacity .24s ease,margin-top .42s cubic-bezier(.2,.78,.2,1)}
.rss-card.open .rss-detail-shell{grid-template-rows:1fr;opacity:1;margin-top:9px}
.rss-detail-clip{min-height:0;overflow:hidden}
.rss-detail{border-top:1px dashed var(--line-soft,#EFEAE1);padding-top:9px;transform:translateY(-6px);transition:transform .36s cubic-bezier(.2,.78,.2,1)}
.rss-card.open .rss-detail{transform:translateY(0)}
.rss-body{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.9;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow-y:auto;overscroll-behavior:contain}
.rss-body.err{color:var(--danger,#B03535)}
.rss-cover{width:78px;height:58px;border-radius:9px;object-fit:cover;flex:none;background:var(--line-soft,#EFEAE1)}
.rss-card-act{display:flex;flex-direction:column;gap:5px;flex:none}
.rss-card-act button{font-size:calc(11px * var(--ui-text-scale));border:1px solid var(--line,#E4DFD6);border-radius:7px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);padding:4px 9px;cursor:pointer;white-space:nowrap}
.rss-card-act button:hover{border-color:var(--deep,#0F4C5C);color:var(--deep,#0F4C5C)}
.rss-card-act button.on{border-color:var(--sun,#E3A008);color:var(--sun,#E3A008)}
.rss-empty{border:1.5px dashed var(--line,#E4DFD6);border-radius:14px;padding:26px;text-align:center;color:var(--ink-3,#A9B2BA);font-size:calc(12.5px * var(--ui-text-scale));line-height:1.9}
.rss-more{display:flex;justify-content:center;padding:8px 0 4px}
.rss-suggest{margin-top:11px;padding-top:11px;border-top:1px solid var(--line-soft,#EFEAE1)}
/* ═══ 显示样式：三档共用同一个 .rss-card 容器，只改密度 ═══
   为什么不动容器类名：ui.list 的点击委托是 closest(".rss-card")，
   换类名会把「打开 / 收藏 / 提醒」全弄哑（而且哑得没有报错）。 */
.rss-seg{display:inline-flex;border:1px solid var(--line,#E4DFD6);border-radius:9px;overflow:hidden;flex:none;background:var(--panel,#fff)}
.rss-seg button{border:0;background:none;color:var(--ink-2,#7E8B94);font-size:calc(12px * var(--ui-text-scale));padding:0 10px;height:32px;cursor:pointer;white-space:nowrap}
.rss-seg button+button{border-left:1px solid var(--line,#E4DFD6)}
.rss-seg button:hover{color:var(--deep,#0F4C5C)}
.rss-seg button.on{background:var(--deep,#0F4C5C);color:var(--on-deep,#fff);font-weight:600}
/* 紧凑：一行一条。封面与摘要都不出现（封面在 JS 侧就不渲染，避免白拉 33 张图） */
.rss-wrap[data-style="compact"] .rss-card{align-items:center;padding:7px 12px;margin-bottom:5px;border-radius:11px;contain-intrinsic-size:auto 40px}
.rss-wrap[data-style="compact"] .rss-cover,
.rss-wrap[data-style="compact"] .rss-snip{display:none}
.rss-wrap[data-style="compact"] .rss-card-main{display:flex;align-items:center;gap:9px}
.rss-wrap[data-style="compact"] .rss-card-head{flex:none;margin:0}
.rss-wrap[data-style="compact"] .rss-author{display:none}
.rss-wrap[data-style="compact"] .rss-src-tag{max-width:120px}
.rss-wrap[data-style="compact"] .rss-card-title{margin:0;flex:1;min-width:0;font-size:calc(13px * var(--ui-text-scale));font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rss-wrap[data-style="compact"] .rss-card-act{flex-direction:row;gap:4px}
.rss-wrap[data-style="compact"] .rss-card-act button{padding:3px 7px;font-size:calc(10.5px * var(--ui-text-scale))}
/* 标题：只留「色点 · 标题 …… 时间」+ 两个极轻的动作，密度最高。
   来源名收成色点、作者与摘要不显示。动作按钮**不做 hover 才出现** ——
   触屏没有 hover，那样手机上会点不到收藏/提醒（窄屏探针暴露过同类问题）。 */
.rss-wrap[data-style="title"] .rss-card{align-items:center;padding:4px 10px;margin-bottom:1px;border:0;background:none;border-radius:8px;contain-intrinsic-size:auto 30px}
.rss-wrap[data-style="title"] .rss-card:hover{background:var(--paper,#F7F6F2)}
.rss-wrap[data-style="title"] .rss-cover,
.rss-wrap[data-style="title"] .rss-snip,
.rss-wrap[data-style="title"] .rss-author{display:none}
.rss-wrap[data-style="title"] .rss-card-main{display:flex;align-items:center;gap:9px}
.rss-wrap[data-style="title"] .rss-card-head{flex:none;margin:0}
.rss-wrap[data-style="title"] .rss-src-tag{border:0;background:none;padding:0;gap:0;max-width:none}
.rss-wrap[data-style="title"] .rss-tag-name{display:none}
.rss-wrap[data-style="title"] .rss-card-title{margin:0;flex:1;min-width:0;font-size:calc(13px * var(--ui-text-scale));font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rss-wrap[data-style="title"] .rss-card-act{flex-direction:row;gap:2px;opacity:.6}
.rss-wrap[data-style="title"] .rss-card:hover .rss-card-act{opacity:1}
.rss-wrap[data-style="title"] .rss-card-act button{border:0;background:none;padding:2px 6px;font-size:calc(11px * var(--ui-text-scale))}
.rss-wrap[data-style="title"] .rss-group{padding:12px 2px 5px}
/* 封面图开关只对卡片档有意义；别的档藏掉，免得点一个不生效的控件 */
.rss-wrap:not([data-style="card"]) [data-cover-toggle]{display:none}
/* 窄屏的样式覆盖单独成块（紧挨样式区，便于一起改），不塞进下面那个媒体查询里 */
@media (max-width:520px){
  .rss-seg button{padding:0 8px;font-size:calc(11.5px * var(--ui-text-scale))}
  /* 390px 一行塞不下「来源 + 时间 + 标题 + 两按钮」⇒ 标题换行独占一行，
     仍限 2 行。flex-wrap 后 align-items:center 会让首行文字对不齐，改 baseline。 */
  .rss-wrap[data-style="compact"] .rss-card-main{flex-wrap:wrap;align-items:baseline;gap:3px 9px}
  .rss-wrap[data-style="compact"] .rss-card-title{flex:1 1 100%;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .rss-wrap[data-style="title"] .rss-card-title{font-size:calc(12.5px * var(--ui-text-scale))}
}
@media (max-width:520px){
  .rss-wrap{padding:10px 0 26px}
  /* 窄屏下「来源 / 推荐」这两个前缀会被挤到独立一行（chips 占满剩余宽度），
     而 chips 本身已经说明了它是什么，直接收掉更省地方 */
  .rss-lab{display:none}
  /* 390px 这一行要给 chips 让位：「＋ 添加源」收成只剩符号，靠 title 与虚线圈说明它是干什么的 */
  .rss-add-src span{display:none}
  .rss-add-src{padding:0 10px}
  .rss-src{flex-wrap:wrap}
  .rss-src-act{width:100%;justify-content:flex-start}
  .rss-cover{width:64px;height:48px}
  .rss-card-act{flex-direction:row;flex-wrap:wrap}
  .rss-card{flex-wrap:wrap}
  .rss-card-main{flex:1 1 100%;order:2}
  .rss-cover{order:1}
  .rss-card-act{order:3;flex:1 1 100%;flex-direction:row}
}
    `;
    document.head.append(st);
  }

  /* ═══════════════ 渲染 ═══════════════ */

  function paintStatus() {
    if (!ui) return;
    if (state.fetching && !state.items.length) { ui.status.innerHTML = "正在抓取订阅源…"; return; }
    const enabled = state.feeds.filter((f) => f.enabled !== false).length;
    const rows = filtered();
    const bits = [];
    bits.push("已更新 " + fmtClock(state.fetchedAt));
    bits.push("订阅 " + enabled + " 个源");
    bits.push("未读 <b>" + unreadCount() + "</b>");
    bits.push("显示 <b>" + rows.length + "</b> / " + state.items.length + " 条");
    let html = bits.join(" · ");
    if (state.error) html += "<br><span class=\"err\">" + esc(state.error) + "</span>";
    ui.status.innerHTML = html;
    if (ui.unread) {
      const n = unreadCount();
      ui.unread.hidden = n === 0;
      ui.unread.textContent = n + " 未读";
    }
  }

  function paintChips() {
    if (!ui) return;
    const all = document.createElement("button");
    all.className = "rss-chip" + (state.prefs.feed === "all" ? " on" : "");
    all.innerHTML = "全部 <span class=\"n\">" + state.items.length + "</span>";
    all.addEventListener("click", () => { state.prefs.feed = "all"; savePrefs(); paintFiltered(); });
    const chips = [all];
    for (let i = 0; i < state.feeds.length; i++) {
      const f = state.feeds[i];
      const n = state.items.filter((it) => it.feedId === f.id).length;
      const b = document.createElement("button");
      b.className = "rss-chip" + (state.prefs.feed === f.id ? " on" : "");
      b.innerHTML = "<i class=\"rss-dot\" style=\"background:" + esc(f.color) + "\"></i>"
        + "<span class=\"rss-chip-name\">" + esc(f.title) + "</span>"
        + "<span class=\"n\">" + n + "</span>"
        + (f.enabled === false ? "<span class=\"n\">已停用</span>" : "");
      b.addEventListener("click", () => { state.prefs.feed = f.id; savePrefs(); paintFiltered(); });
      chips.push(b);
    }
    ui.chips.replaceChildren(...chips);
    ui.filterSummary.textContent = state.prefs.feed === "all" && !state.prefs.unreadOnly && !state.prefs.starOnly
      ? "筛选" : "筛选 · 已设置";

    ui.unreadToggle.classList.toggle("on", !!state.prefs.unreadOnly);
    ui.starToggle.classList.toggle("on", !!state.prefs.starOnly);
    ui.autoSelect.value = String(state.prefs.autoMin);
    ui.kw.value = state.prefs.kw;
  }

  function paintSources() {
    if (!ui) return;
    const rows = state.feeds.map((f) => {
      const row = document.createElement("div");
      row.className = "rss-src" + (f.enabled === false ? " off" : "");
      const n = state.items.filter((it) => it.feedId === f.id).length;
      const unread = unreadCount(f.id);
      const meta = [];
      meta.push(n + " 条" + (unread ? "（" + unread + " 未读）" : ""));
      meta.push(f.lastAt ? "上次 " + fmtClock(f.lastAt) : "尚未抓取");
      if (f.lastError) meta.push("<span class=\"err\">" + esc(clip(f.lastError, 70)) + "</span>");
      row.innerHTML = "<i class=\"rss-dot\" style=\"background:" + esc(f.color) + ";margin-top:6px\"></i>"
        + "<div class=\"rss-src-main\">"
        + "<div class=\"rss-src-name\">" + esc(f.title) + "</div>"
        + "<div class=\"rss-src-url\">" + esc(f.url) + "</div>"
        + "<div class=\"rss-src-meta\">" + meta.join(" · ") + "</div>"
        + "</div>";
      const act = document.createElement("div");
      act.className = "rss-src-act";
      act.append(
        srcBtn(f.enabled === false ? "启用" : "停用", () => toggleFeed(f)),
        srcBtn("改名", () => renameFeed(f)),
        srcBtn("删除", () => removeFeed(f)),
      );
      row.append(act);
      return row;
    });
    ui.srcs.replaceChildren(...(rows.length ? rows : [emptyNode("还没有订阅源。")]));

    const chips = [];
    for (let i = 0; i < SUGGESTED_FEEDS.length; i++) {
      const s = SUGGESTED_FEEDS[i];
      const b = document.createElement("button");
      b.className = "rss-chip";
      b.textContent = s.title + " ＋";
      if (state.feeds.some((f) => f.url === s.url)) { b.disabled = true; b.textContent = s.title + " 已订阅"; }
      b.addEventListener("click", () => addFeed(s.url));
      chips.push(b);
    }
    ui.suggest.replaceChildren(...chips);
  }
  function srcBtn(label, fn) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => Promise.resolve().then(fn).catch((e) => tide.notify("操作失败：" + String((e && e.message) || e))));
    return b;
  }
  function emptyNode(text) {
    const d = document.createElement("div");
    d.className = "rss-empty";
    d.innerHTML = text;
    return d;
  }

  function cardHtml(it) {
    const feed = feedById(it.feedId);
    const style = state.prefs.style;
    const terse = style === "title";
    const expanded = state.expanded.has(it.id);
    /* 封面只在卡片档渲染。紧凑/标题档若「先渲染再 CSS 藏」，<img src> 照样会发请求 ——
       33 条就是 33 张白拉的图。摘要同理：只有卡片档才拼进 HTML。 */
    const cover = style === "card" && state.prefs.showCover && it.cover
      ? "<img class=\"rss-cover\" src=\"" + esc(it.cover) + "\" alt=\"\" loading=\"lazy\" decoding=\"async\">" : "";
    /* 标题档的整行都点了就打开（委托的兜底分支），所以「打开」按钮是冗余的，收掉。
       收藏按钮在标题档只留星号 —— 标签一长，390px 上标题就没地方了。
       动作按钮一律带 title 属性：标题档只剩符号，没有它读屏和悬停提示都是空的。 */
    const act = "<div class=\"rss-card-act\">"
      + (terse ? "" : "<button data-act=\"open\" title=\"打开原文\">打开 ↗</button>")
      + "<button data-act=\"star\" class=\"" + (it.star ? "on" : "") + "\" title=\"收藏 / 取消收藏\">"
      + (terse ? (it.star ? "★" : "☆") : (it.star ? "★ 已收藏" : "☆ 收藏")) + "</button>"
      + "<button data-act=\"remind\" title=\"转成提醒\">提醒</button>"
      + "</div>";
    /* 展开正文：只有卡片档渲染 —— 紧凑/标题档是一行式扫描视图，塞一段可滚动的正文会把行高撑乱。
       没有 link 就无从抓取，按钮也不出现（不留一个点了报错的死控件）。
       正文节点常驻 DOM：收起态由 .rss-detail-shell 的 0fr + overflow:hidden 收掉高度，
       这样列表重绘（刷新 / 改筛选 / 换样式）后已抓到的全文还在，不必重抓。 */
    const detail = style === "card" && it.link
      ? "<button class=\"rss-btn rss-expand\" data-act=\"expand\" aria-expanded=\"" + (expanded ? "true" : "false")
      + "\" title=\"读取原文页面并抽取正文\"><span>" + (expanded ? "收起正文" : "展开正文") + "</span></button>"
      + "<div class=\"rss-detail-shell\" aria-hidden=\"" + (expanded ? "false" : "true")
      + "\"><div class=\"rss-detail-clip\"><div class=\"rss-detail\">" + bodyHtml(it) + "</div></div></div>"
      : "";
    return "<article class=\"rss-card" + (it.read ? " read" : "") + (expanded ? " open" : "") + "\" data-id=\"" + esc(it.id) + "\">"
      + cover
      + "<div class=\"rss-card-main\">"
      + "<div class=\"rss-card-head\">"
      + "<span class=\"rss-src-tag\"><i class=\"rss-dot\" style=\"background:" + esc(feed ? feed.color : FEED_COLORS[0]) + "\"></i>"
      + "<span class=\"rss-tag-name\">" + esc(feedTitle(it.feedId)) + "</span></span>"
      + "<span class=\"rss-when\">" + esc(fmtWhen(it.date) || "时间未知") + "</span>"
      + (it.author ? "<span class=\"rss-author\">" + esc(it.author) + "</span>" : "")
      + (it.read ? "" : "<span class=\"rss-new\">NEW</span>")
      + "</div>"
      + "<h3 class=\"rss-card-title\" data-act=\"open\">" + esc(it.title) + "</h3>"
      + (style === "card" && it.snippet ? "<p class=\"rss-snip\" data-act=\"expand\">" + esc(it.snippet) + "</p>" : "")
      + detail
      + "</div>"
      + act
      + "</article>";
  }

  /* 详情区内容：正在抓 → 占位；抓过 → 全文；没抓过 → 空（收起态本来就不占高度）。 */
  function bodyHtml(it) {
    if (state.bodyLoading.has(it.link)) return "<div class=\"rss-body\">正在读取正文…</div>";
    const text = state.bodies.get(it.link);
    return text === undefined ? "" : "<div class=\"rss-body\">" + esc(text) + "</div>";
  }

  /* 展开 / 收起**一律就地改类，不走 paintList()**：paintList 会整体重写 ui.list.innerHTML，
     新建的卡片一出生就带着 .open 终态，0fr→1fr 的过渡根本不会播放，观感就是「闪一下」。
     学校通知的 setItemOpen 同理，那边踩过这个坑。 */
  function setCardOpen(card, open) {
    card.classList.toggle("open", open);
    const btn = card.querySelector(".rss-expand");
    if (btn) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      const span = btn.querySelector("span");
      if (span) span.textContent = open ? "收起正文" : "展开正文";
    }
    const shell = card.querySelector(".rss-detail-shell");
    if (shell) shell.setAttribute("aria-hidden", open ? "false" : "true");
  }
  function setCardBody(card, it) {
    const box = card.querySelector(".rss-detail");
    if (box) box.innerHTML = bodyHtml(it);
  }
  /* 抓取期间列表可能被整体重绘 ⇒ 手里这个 card 元素已经离开文档。
     正文要写进**当前**那张同 id 的卡片，否则它会永远停在「正在读取正文…」。 */
  function liveCard(id) {
    if (!ui) return null;
    for (const c of ui.list.querySelectorAll(".rss-card")) {
      if (c.dataset.id === id) return c;
    }
    return null;
  }
  async function toggleBody(card, it) {
    const open = !state.expanded.has(it.id);
    if (open) state.expanded.add(it.id); else state.expanded.delete(it.id);
    setCardOpen(card, open);
    if (!open || state.bodies.has(it.link) || state.bodyLoading.has(it.link)) return;
    state.bodyLoading.add(it.link);
    setCardBody(card, it);
    let err = null;
    try {
      const res = await httpGet(it.link);
      const art = tide.util.web.extractArticleText(res.body, res.finalUrl || it.link);
      state.bodies.set(it.link, String((art && art.text) || "").trim()
        || "没有从原文页面识别出正文，点「打开 ↗」直接看原网页。");
    } catch (e) { err = e; }
    /* 顺序是修好的，别改回去：**先摘 loading 再写正文**。bodyHtml() 第一眼看的 loading，
       把写正文留在 try 里 / 清 loading 放进 finally，正文永远停在「正在读取正文…」
       （浏览器探针实测到过：抓取已返回、卡片却还是占位文案）。 */
    state.bodyLoading.delete(it.link);
    const target = liveCard(it.id);
    if (!target) return;
    if (err) {
      /* 失败不进缓存：下次点展开要能重试。错误只写在当前这张卡片上。 */
      if (state.expanded.has(it.id)) {
        const box = target.querySelector(".rss-detail");
        if (box) box.innerHTML = "<div class=\"rss-body err\">读取正文失败：" + esc(String((err && err.message) || err)) + "，再点一次可重试</div>";
      }
      return;
    }
    setCardBody(target, it);
  }

  function paintList(reset) {
    if (!ui) return;
    if (reset) state.rendered = CHUNK;
    const rows = filtered();
    const token = ++paintToken;
    if (!rows.length) {
      ui.list.innerHTML = "";
      ui.list.append(emptyNode(state.items.length
        ? "没有符合筛选条件的内容<br>换个关键词，或把筛选切回「全部」"
        : (state.feeds.length
          ? "还没有内容 —— 点上方「刷新」抓取订阅源"
          : "还没有订阅源<br>展开下方「订阅管理」添加，或从推荐源里一键订阅")));
      return;
    }
    const slice = rows.slice(0, state.rendered);
    const counts = {};
    for (let i = 0; i < rows.length; i++) {
      const g = groupOf(rows[i].date);
      counts[g] = (counts[g] || 0) + 1;
    }
    let html = "", lastGroup = "";
    for (let i = 0; i < slice.length; i++) {
      const g = groupOf(slice[i].date);
      if (g !== lastGroup) {
        html += "<div class=\"rss-group\">" + esc(g) + " · " + counts[g] + " 条</div>";
        lastGroup = g;
      }
      html += cardHtml(slice[i]);
    }
    ui.list.innerHTML = html;

    const more = document.createElement("div");
    more.className = "rss-more";
    if (state.rendered < rows.length) {
      const b = document.createElement("button");
      b.className = "rss-btn";
      b.textContent = "▾ 显示更多（还有 " + (rows.length - state.rendered) + " 条）";
      b.addEventListener("click", () => {
        if (token !== paintToken) return;
        state.rendered += CHUNK;
        paintList();
      });
      more.append(b);
    }
    ui.list.append(more);
  }

  /* 把当前样式写进 DOM：wrap 的 data-style 驱动全部密度 CSS，分段控件与封面开关同步选中态。
     这三处必须一起变 —— 只改 data-style 会让控件显示与实际样式脱节（点着「紧凑」却是卡片）。 */
  function applyStyle() {
    if (!ui) return;
    const style = STYLES.includes(state.prefs.style) ? state.prefs.style : "card";
    ui.wrap.dataset.style = style;
    for (const b of ui.seg.querySelectorAll("button")) {
      const on = b.dataset.style === style;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    ui.coverToggle.classList.toggle("on", !!state.prefs.showCover);
  }

  /* 换样式只影响列表密度，不动筛选结果 ⇒ 走 paintList()（**不** reset 分块进度）。
     用 paintFiltered() 会把 state.rendered 打回 CHUNK，把已经「显示更多」展开的部分收回去。 */
  function setStyle(style) {
    if (!STYLES.includes(style) || state.prefs.style === style) return;
    state.prefs.style = style;
    savePrefs();
    applyStyle();
    paintList();
  }

  function paintAll() {
    applyStyle();
    paintStatus();
    paintChips();
    paintSources();
    paintManageSummary();
    paintList();
  }

  /* 筛选条件变了：chips 选中态、状态栏计数、列表三者必须一起刷。
     只刷列表会让状态栏的「显示 N / m 条」停在旧值 —— 真浏览器探针实测到的
     （点源 chip 后列表变了、计数不动，看着像筛选没生效）。收成一个入口，
     以后新增筛选项也不会再漏。 */
  function paintFiltered() {
    paintChips();
    paintStatus();
    paintList(true);
  }

  /* ═══════════════ 动作 ═══════════════ */

  async function toggleFeed(feed) {
    feed.enabled = feed.enabled === false;
    await saveFeeds();
    paintAll();
    tide.notify((feed.enabled ? "已启用「" : "已停用「") + feed.title + "」");
  }

  async function renameFeed(feed) {
    const next = promptFn("给这个源起个名字", feed.title);
    if (next == null) return;
    const t = String(next).trim();
    if (!t) return;
    feed.title = clip(t, 40);
    feed.customTitle = true; // 用户改过名，之后抓取不再被 feed 自带的标题覆盖
    await saveFeeds();
    paintAll();
  }

  async function removeFeed(feed) {
    if (!confirmFn("删除「" + feed.title + "」？\n它的 " + state.items.filter((it) => it.feedId === feed.id).length + " 条缓存内容会一起清掉。")) return;
    state.feeds = state.feeds.filter((f) => f.id !== feed.id);
    state.items = state.items.filter((it) => it.feedId !== feed.id);
    if (state.prefs.feed === feed.id) state.prefs.feed = "all";
    await Promise.all([saveFeeds(), saveItems(), savePrefs()]);
    publishItems();
    paintAll();
    tide.notify("已删除「" + feed.title + "」");
  }

  async function openItem(it) {
    if (!it.read) {
      it.read = true;
      await saveItems();
      paintStatus();
      paintList();
    }
    if (it.link) tide.util.openUrl(it.link);
    else tide.notify("这条内容没有可打开的链接");
  }

  async function toggleStar(it) {
    it.star = !it.star;
    await saveItems();
    paintList();
  }

  /* 转成提醒：条目里常带日期（"9 月 20 日截止" 之类），交给宿主的语义解析 ——
     解析出时刻就同时排进时间块，只解析出日期就放 09:00，都没有就进象限池。 */
  async function toReminder(it) {
    const text = it.title + " " + it.snippet;
    const parsed = tide.util.parseWhen(text);
    const task = tide.tasks.create({
      title: clip(it.title, 60),
      quad: tide.util.guessQuad(parsed.date),
      estMin: parsed.endMin ? parsed.endMin - parsed.startMin : 45,
      due: parsed.date || "",
      tags: ["RSS", feedTitle(it.feedId)],
      note: it.link,
    });
    if (parsed.date && parsed.startMin !== null && parsed.startMin !== undefined) {
      const dur = parsed.endMin ? parsed.endMin - parsed.startMin : 45;
      tide.blocks.create({
        date: parsed.date, start: tide.util.hhmmOf(parsed.startMin), durMin: dur,
        title: clip(it.title, 40), taskId: task.id, cat: tide.util.guessCategory(text),
      });
      tide.notify("已排入 " + parsed.date.slice(5) + " " + tide.util.hhmmOf(parsed.startMin) + "：「" + clip(it.title, 18) + "」", {
        actionLabel: "看时间块", ms: 6500, action: () => tide.util.navigate("timeblock"),
      });
    } else if (parsed.date) {
      tide.blocks.create({ date: parsed.date, start: "09:00", durMin: 45, title: clip(it.title, 40), taskId: task.id, cat: tide.util.guessCategory(text) });
      tide.notify("只认出日期 " + parsed.date.slice(5) + "，先放在 09:00");
    } else {
      tide.notify("没认出时间，已存进象限池待安排", { actionLabel: "去四象限", action: () => tide.util.navigate("quadrant") });
    }
    if (!it.read) { it.read = true; await saveItems(); }
    paintAll();
  }

  function setAuto(min) {
    state.prefs.autoMin = Number(min) || 0;
    savePrefs();
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (state.prefs.autoMin > 0) {
      autoTimer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return; // 后台不抓，省流量
        refreshAll();
      }, state.prefs.autoMin * 60 * 1000);
    }
    paintChips();
  }

  /* ═══════════════ 视图 ═══════════════ */

  /* 顶栏「＋ 添加源」= 「订阅管理」的外层入口。添加与删除本来就在里面
     （地址框 + 每行的 启用/停用 · 改名 · 删除），只是收在折叠里不好找 ——
     这里只补入口，不另做一套添加/删除逻辑。 */
  function focusAddBox() {
    if (!ui) return;
    ui.manage.open = true;
    ui.addUrl.focus({ preventScroll: true });
    ui.addUrl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function buildUI(el) {
    el.innerHTML = "";
    el.style.overscrollBehavior = "contain";
    const wrap = document.createElement("div");
    wrap.className = "rss-wrap";
    wrap.innerHTML = `
      <div class="rss-hero">
        <div class="rss-top">
          <span class="rss-eyebrow rss-grow">R S S 　信 息 流</span>
          <span class="rss-unread" data-unread hidden></span>
          <button class="rss-btn pri" data-refresh>刷新</button>
        </div>
        <div class="rss-toolbar">
          <input class="rss-input" data-kw type="text" placeholder="关键词过滤：标题与摘要…">
          <select class="rss-select" data-auto title="自动刷新间隔"></select>
          <span class="rss-seg" data-seg role="group" aria-label="条目显示样式"></span>
          <span class="rss-toggle" data-cover-toggle title="卡片档是否显示封面图"><i></i>封面图</span>
        </div>
        <div class="rss-toolbar"><details class="plugin-filter-menu"><summary data-filter-summary>筛选</summary><div class="plugin-filter-menu-panel"><div class="rss-chips" data-chips></div><span class="rss-toggle" data-unread-toggle><i></i>只看未读</span><span class="rss-toggle" data-star-toggle><i></i>只看收藏</span></div></details><button class="rss-add-src" data-add-src type="button" aria-expanded="false" title="添加订阅源（展开「订阅管理」并把光标放到地址框）">＋<span>添加源</span></button></div>
        <div class="rss-status" data-status></div>
      </div>
      <details class="rss-manage" data-manage>
        <summary data-manage-summary>订阅管理</summary>
        <div class="rss-manage-body">
          <div class="rss-toolbar">
            <input class="rss-input" data-add-url type="text" placeholder="RSS / Atom 地址，或网站首页（会自动发现订阅）">
            <button class="rss-btn pri" data-add>添加</button>
          </div>
          <div class="rss-hint">粘贴网站首页也可以：插件会读页面里声明的订阅地址，找不到再按 /feed、/rss 等常见路径试一遍。</div>
          <div data-srcs style="margin-top:6px"></div>
          <div class="rss-suggest"><div class="rss-toolbar" style="margin-top:0"><span class="rss-lab">推荐</span><div class="rss-chips" data-suggest></div></div></div>
        </div>
      </details>
      <div data-list style="margin-top:11px"></div>
    `;
    el.append(wrap);

    ui = {
      wrap,
      status: wrap.querySelector("[data-status]"),
      chips: wrap.querySelector("[data-chips]"),
      filterSummary: wrap.querySelector("[data-filter-summary]"),
      list: wrap.querySelector("[data-list]"),
      srcs: wrap.querySelector("[data-srcs]"),
      suggest: wrap.querySelector("[data-suggest]"),
      unread: wrap.querySelector("[data-unread]"),
      unreadToggle: wrap.querySelector("[data-unread-toggle]"),
      starToggle: wrap.querySelector("[data-star-toggle]"),
      kw: wrap.querySelector("[data-kw]"),
      autoSelect: wrap.querySelector("[data-auto]"),
      seg: wrap.querySelector("[data-seg]"),
      coverToggle: wrap.querySelector("[data-cover-toggle]"),
      refreshBtn: wrap.querySelector("[data-refresh]"),
      addUrl: wrap.querySelector("[data-add-url]"),
      addSrcBtn: wrap.querySelector("[data-add-src]"),
      manage: wrap.querySelector("[data-manage]"),
      manageSummary: wrap.querySelector("[data-manage-summary]"),
    };

    // 自动刷新间隔下拉
    const labels = { 0: "不自动刷新", 15: "每 15 分钟", 30: "每 30 分钟", 60: "每 60 分钟" };
    ui.autoSelect.replaceChildren(...AUTO_CHOICES.map((m) => {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = labels[m];
      return o;
    }));
    ui.autoSelect.addEventListener("change", () => {
      setAuto(ui.autoSelect.value);
      tide.notify(state.prefs.autoMin > 0 ? "已开启自动刷新（每 " + state.prefs.autoMin + " 分钟）" : "已关闭自动刷新");
    });

    // 显示样式分段控件（三档）
    ui.seg.replaceChildren(...STYLES.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.style = s;
      b.textContent = STYLE_LABELS[s];
      b.title = STYLE_LABELS[s] + "样式";
      b.addEventListener("click", () => setStyle(s));
      return b;
    }));
    // 封面图开关：接的是原本就存在、却一直没有 UI 的 prefs.showCover
    ui.coverToggle.addEventListener("click", () => {
      state.prefs.showCover = !state.prefs.showCover;
      savePrefs();
      applyStyle();
      paintList();
    });

    ui.refreshBtn.addEventListener("click", () => refreshAll());
    ui.addUrl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") addFeed(ui.addUrl.value);
    });
    wrap.querySelector("[data-add]").addEventListener("click", () => addFeed(ui.addUrl.value));
    ui.addSrcBtn.addEventListener("click", focusAddBox);

    let kwTimer = null;
    ui.kw.addEventListener("input", () => {
      clearTimeout(kwTimer);
      kwTimer = setTimeout(() => {
        state.prefs.kw = ui.kw.value;
        savePrefs();
        paintStatus();
        paintList(true);
      }, 180);
    });
    ui.kw.addEventListener("keydown", (e) => e.stopPropagation());

    ui.unreadToggle.addEventListener("click", () => {
      state.prefs.unreadOnly = !state.prefs.unreadOnly;
      savePrefs(); paintFiltered();
    });
    ui.starToggle.addEventListener("click", () => {
      state.prefs.starOnly = !state.prefs.starOnly;
      savePrefs(); paintFiltered();
    });

    ui.list.addEventListener("click", (e) => {
      const card = e.target.closest(".rss-card");
      if (!card) return;
      const it = state.items.find((x) => x.id === card.dataset.id);
      if (!it) return;
      /* 正文区里选字、点链接不能落到下面的兜底分支（openItem 会把人踢去浏览器，读到一半就丢）。
         展开按钮是 .rss-detail-clip 的兄弟节点，不会被这条拦住。 */
      if (e.target.closest(".rss-detail-clip")) return;
      const act = e.target.closest("[data-act]");
      const kind = act ? act.dataset.act : "";
      if (kind === "expand") { toggleBody(card, it); return; }
      if (kind === "star") { toggleStar(it); return; }
      if (kind === "remind") { toReminder(it); return; }
      openItem(it);
    });
    // 封面图加载失败就收起（error 不冒泡，用捕获阶段委托）
    ui.list.addEventListener("error", (e) => {
      const img = e.target;
      if (img && img.classList && img.classList.contains("rss-cover")) img.style.display = "none";
    }, true);
  }

  function paintManageSummary() {
    if (!ui) return;
    const off = state.feeds.filter((f) => f.enabled === false).length;
    const bad = state.feeds.filter((f) => f.lastError).length;
    ui.manageSummary.textContent = "订阅管理 · " + state.feeds.length + " 个源"
      + (off ? "（" + off + " 个已停用）" : "")
      + (bad ? "（" + bad + " 个抓取异常）" : "");
  }

  /* 箭头的展开态只在这里同步：`<details>` 的 toggle 事件在**程序化**改 open 时同样会发
     （点 summary、点顶栏「＋ 添加源」两条路都走得到这里），所以不放在 focusAddBox 里 ——
     放那边就得为「用户直接点 summary」再补一条路径。 */
  function onManageToggle() {
    paintManageSummary();
    if (ui) ui.addSrcBtn.setAttribute("aria-expanded", ui.manage.open ? "true" : "false");
  }

  function render(el) {
    ensureStyle();
    el.innerHTML = "<div style=\"padding:28px;text-align:center;color:var(--ink-3,#A9B2BA);font-size:calc(12.5px * var(--ui-text-scale))\">正在读取订阅…</div>";
    Promise.all([loadPrefs(), loadFeeds(), loadItems()])
      .catch((e) => { console.error("[rss-reader] 读取本地数据失败", e); })
      .then(() => {
        publishItems();
        buildUI(el);
        paintAll();
        // 摘要里的「已停用 / 抓取异常」计数与顶栏箭头的展开态都随开合变化，一起对齐
        ui.manage.addEventListener("toggle", onManageToggle);
        setAuto(state.prefs.autoMin);
        const stale = !state.fetchedAt || Date.now() - state.fetchedAt > STALE_MS;
        if (stale && state.feeds.some((f) => f.enabled !== false)) refreshAll();
      });
  }

  tide.ui.registerView({ id: VIEW_ID, title: "RSS 信息流", icon: "rss", render });
})();
