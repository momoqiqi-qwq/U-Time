/* ═══════════════════════════════════════════════════════════════════
   竞赛消息雷达 · 内置插件 —— 多源版

   一个「源」= 一个抓取适配器。内置三家，用户还能自己加：
     · 摩课云竞赛平台 gxxsjs.com   官方分页接口（本校在用，保留为默认源）
     · 赛氪竞赛广场   saikr.com    页面是 Vue 空壳，列表在它自己的 JSON 接口里
                                   （apiv4buffer.saikr.com/api/pc/contest/lists）
     · 我要参赛网     52jingsai.com/bisai/   Discuz 门户页，GBK 编码的 HTML 列表
     · 自定义源       粘一个网址，自动判别 RSS / Atom、JSON 接口、HTML 列表

   三处刻意的取舍：
   ① 解析器用字符串正则，不用 DOMParser。
      中文站的列表页常缺闭合标签、属性里塞未转义的 `&`；DOMParser 一旦 parsererror
      整源报废，正则能捞回大部分字段。纯字符串实现还能在 node 里直接跑测试
      （scripts/test-gx-news.mjs），这是本插件可测的前提。
   ② 条目 id 一律加源前缀 `源id:原始id`。三家接口的 id 都是自增数字，不加前缀的话
      「已读」「新消息推送」会在源之间互相串 —— 在赛氪读过一条，摩课云同号码那条就没了。
   ③ 网络走 tide.http.get（Rust 侧 reqwest）：既绕开 CORS，也负责按响应头 / `<meta>`
      里的 charset 解码（我要参赛网是 GBK，浏览器 fetch 直接拿到乱码）。

   权限对账：ui / storage / notify / http / openUrl / tasks / blocks / timeParse / events，
   与下面用到的 tide.* 一一对应，多一个都没声明。
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  const PAGE_SIZE = 40, CHUNK = 14, MAX_PAGES = 6, CUSTOM_MAX = 60;
  const LEGACY_SRC = "mokeroad";   // 旧版本只有一个源：storage 里的裸 id、knownIds 数组都是它写的
  const MOKEROAD_API = "https://www.gxxsjs.com/prod-api/home/competition/news/page";
  const MOKEROAD_DETAIL = "https://www.gxxsjs.com/home/newsDetails?newsId=";
  const SAIKR_API = "https://apiv4buffer.saikr.com/api/pc/contest/lists";
  const JINGSAI_HOME = "https://www.52jingsai.com/bisai/";

  // 摩课云的 newsType 是点分复合标签（如 202.204.208），按包含关系收敛成两类。
  // 类型 id 与旧版本一致（n202 / n203 / other），老的持久化筛选值才继续命中。
  const hasType = (t, code) => String(t || "").split(".").includes(code);
  const TYPE_LABEL = { n202: "平台通知", n203: "赛事动态", other: "其他" };
  // 动态类型带来源前缀：lv:全国性（赛氪级别）、cat:科技创新（我要参赛网分类）。
  const typeLabel = (id) => TYPE_LABEL[id] || String(id || "").replace(/^(?:lv|cat):/, "") || "其他";

  const state = {
    custom: [],           // 用户添加的源 [{ id, name, url }]
    sourceId: LEGACY_SRC,
    list: [], page: 1, hasMore: true, fetching: false, fetchedAt: 0, error: null,
    seen: new Set(),
    known: {},            // 源 id -> 上次第 1 页的 id 快照（判「新消息」用）
    filter: { kw: "", type: "all", month: "all", hideSeen: false, auto: false, showCover: false },
    timer: null, renderedCount: CHUNK,
  };
  let ui = null, paintToken = 0, fetchSeq = 0, dialog = null;

  /* ═══════════ 文本 / 地址小工具（全部不碰 DOM） ═══════════ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  const ENTITIES = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", middot: "·",
    ldquo: "“", rdquo: "”", mdash: "—", hellip: "…", bull: "·", deg: "°",
  };
  function decodeEntities(s) {
    return String(s == null ? "" : s).replace(/&(#[0-9]{1,6}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,9});/g,
      (all, body) => {
        if (body[0] === "#") {
          const code = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
        }
        return ENTITIES[body.toLowerCase()] ?? all;
      });
  }

  /** 一段 HTML → 单行纯文本（正则解析器的主力：先挖掉脚本样式，再去标签，再解实体）。
      顺序不能反：`<[^>]*>` 先把 `<script>` 的尖括号吃掉，剩下的 JS 文本就摘不掉了。 */
  function toText(html) {
    return decodeEntities(String(html == null ? "" : html)
      .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ").trim();
  }
  /** 已经去掉标签的文本 → 压空白 + 截断。 */
  const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const stripTags = (s) => clip(toText(s), 120);

  /** 属性取值：从 `<a ...>` 的开标签串里拿属性（属性值可能用单/双引号，也可能裸写）。 */
  function attrOf(openTag, name) {
    const tag = String(openTag || "");
    const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>]+))`, "i");
    const m = tag.match(re);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : "";
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  /** 相对地址 → 绝对地址。交给宿主的 resolveWebUrl（它会按 URL 规范处理 ../ 与查询串）。 */
  function absolutize(href, baseUrl) {
    const raw = String(href || "").trim();
    if (!raw || /^(?:javascript|data|mailto|tel):/i.test(raw)) return "";
    try {
      const abs = tide.util.web.resolveUrl(raw.startsWith("//") ? `https:${raw}` : raw, baseUrl);
      return /^https?:/i.test(abs) ? abs : "";
    } catch { return ""; }
  }

  /** HTML 里的 `<base href>`。我要参赛网的列表在 `/bisai/` 下、条目链接却是 `article-123-1.html`，
      不读 base 就会拼成 `/bisai/article-123-1.html` —— 实测那条路径是 404。 */
  function baseHrefOf(html, baseUrl) {
    const m = String(html || "").match(/<base\b[^>]*>/i);
    return (m && absolutize(attrOf(m[0], "href"), baseUrl)) || baseUrl;
  }

  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url || "自定义源"; } };

  /** Unix 秒 → 本地 `YYYY-MM-DD HH:mm`（赛氪接口只给时间戳）。 */
  function fmtTs(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return "";
    const ms = n > 1e11 ? n : n * 1000;   // 毫秒级的值也接住，别排出 1970 年
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 从任意文本里揪第一个日期，归一到 `YYYY-MM-DD[ HH:mm]`。
      必须补零：月份分组是 `time.slice(0, 7)`，`2026-9-1` 会切成 `2026-9-`。 */
  function firstDate(text) {
    const s = String(text || "");
    const m = s.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})日?(?:\s*(\d{1,2})[:：](\d{2}))?/);
    if (!m) return "";
    const mo = Number(m[2]), day = Number(m[3]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return "";
    const date = `${m[1]}-${pad2(mo)}-${pad2(day)}`;
    if (m[4] === undefined) return date;
    const hh = Number(m[4]), mm = Number(m[5]);
    return hh > 23 || mm > 59 ? date : `${date} ${pad2(hh)}:${pad2(mm)}`;
  }

  /** 接口 / feed 里**明确标成日期**的那个字段：先按常见写法抠，抠不到再交给 Date.parse
      （RSS 2.0 的 `Fri, 18 Sep 2026 10:00:00 GMT` 只有 Date.parse 认）。
      纯数字要分格式：8 位是 `20260918`、14 位是 `20260918111500`，其余按 Unix 时间戳。 */
  function parseDateField(raw) {
    const s = clip(toText(raw), 80);
    if (!s) return "";
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{14}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    const direct = firstDate(s);
    if (direct) return direct;
    const n = Number(s);
    if (Number.isFinite(n) && n > 1e8) return fmtTs(n);
    const t = Date.parse(s);
    return Number.isNaN(t) ? "" : fmtTs(Math.floor(t / 1000));
  }

  const monthOf = (m) => (m.time || "").slice(0, 7) || "unknown";
  function monthLabel(mo) {
    if (mo === "unknown") return "时间未知";
    const [y, m] = mo.split("-");
    return `${y}年${Number(m)}月`;
  }

  /** 稳定短哈希：自定义条目没有 id 字段时，用「地址 + 标题」折出一个，跨刷新才不会重判 NEW。 */
  function hashId(s) {
    let h = 5381;
    const str = String(s || "");
    for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + str.length.toString(36);
  }

  /* ═══════════ 内置源解析 ═══════════ */

  async function fetchMokeroad(page) {
    const res = await tide.http.get(`${MOKEROAD_API}?pageNum=${page}&pageSize=${PAGE_SIZE}`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    let d;
    try { d = JSON.parse(res.body); } catch { throw new Error("接口返回的不是 JSON"); }
    if (d.code !== 0 || !d.data) throw new Error(d.msg || "接口返回异常");
    const records = d.data.records || [];
    const items = records.map((r) => {
      const t = String(r.newsType || "");
      return {
        rawId: String(r.newsId),
        title: String(r.newsTitle || "(无标题)"),
        type: hasType(t, "203") ? "n203" : hasType(t, "202") ? "n202" : "other",
        time: String(r.publishTime || "").slice(0, 16),
        cover: String(r.newsCover || ""),
        snippet: stripTags(r.newsInfo),
        url: MOKEROAD_DETAIL + r.newsId,
      };
    });
    return { items, hasMore: records.length >= PAGE_SIZE && page < MAX_PAGES };
  }

  async function fetchSaikr(page) {
    const res = await tide.http.get(`${SAIKR_API}?page=${page}&limit=${PAGE_SIZE}&univs_id=&class_id=&level=0&sort=0`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    let d;
    try { d = JSON.parse(res.body); } catch { throw new Error("赛氪接口返回的不是 JSON"); }
    const list = d && d.data ? d.data.list : null;
    if (!Array.isArray(list)) throw new Error((d && d.msg) || "赛氪接口返回异常");
    const items = list.map((r) => {
      const level = clip(String(r.level_name || ""), 12);
      const deadline = fmtTs(r.regist_end_time);
      return {
        rawId: String(r.contest_id),
        title: clip(String(r.contest_name || "(无标题)"), 120),
        type: level ? `lv:${level}` : "other",
        // 列表时间取报名开始：竞赛是「开了报名」才出现在雷达上的。
        time: fmtTs(r.regist_start_time) || fmtTs(r.contest_start_time),
        deadline,
        status: clip(String(r.time_name || ""), 12),
        snippet: [clip(String(r.organiser || ""), 60), clip(String(r.enter_range || ""), 12)]
          .filter(Boolean).join(" · "),
        cover: String(r.thumb_pic || ""),
        url: absolutize(String(r.contest_url || ""), "https://www.saikr.com/"),
      };
    });
    return { items, hasMore: list.length >= PAGE_SIZE && page < MAX_PAGES };
  }

  /** 我要参赛网的列表块（Discuz 门户 block）。解析不出来时回落到通用 HTML 列表提取。 */
  function parseJingsai(html, baseUrl) {
    const base = baseHrefOf(html, baseUrl);
    const out = [];
    const re = /<dl\b[^>]*class="[^"]*list_bbda[^"]*"[^>]*>([\s\S]*?)<\/dl\s*>/gi;
    let m;
    while ((m = re.exec(html))) {
      const block = m[1];
      const dt = block.match(/<dt\b[^>]*>([\s\S]*?)<\/dt\s*>/i);
      const linkTag = dt && dt[1].match(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i);
      if (!linkTag) continue;
      const title = clip(toText(linkTag[2]), 120);
      const url = absolutize(attrOf(linkTag[1], "href"), base);
      if (!title || !url) continue;
      // 正文行是 `标题||比赛时间||主办单位` 三段拼的，|| 换成 · 更好读。
      const dd = block.match(/<dd\b[^>]*>([\s\S]*?)(?:<div\b[^>]*class="[^"]*list_info|<\/dd\s*>)/i);
      const desc = dd ? clip(toText(dd[1]).replace(/\|\|/g, " · "), 160) : "";
      const info = block.match(/<div\b[^>]*class="[^"]*list_info[\s\S]*$/i);
      const infoText = info ? toText(info[0]) : "";
      const cat = clip(toText((block.match(/分类[\s\S]{0,220}?<a\b[^>]*>([\s\S]*?)<\/a\s*>/i) || [])[1] || ""), 12);
      const img = block.match(/<img\b[^>]*>/i);
      out.push({
        rawId: (url.match(/article-(\d+)-/i) || [])[1] || hashId(url),
        title,
        type: cat ? `cat:${cat}` : "other",
        time: firstDate(infoText),
        snippet: desc,
        cover: img ? absolutize(attrOf(img[0], "src"), base) : "",
        url,
      });
    }
    return out;
  }

  async function fetchJingsai(page) {
    const url = page > 1 ? `https://www.52jingsai.com/bisai/index.php?page=${page}` : JINGSAI_HOME;
    const res = await tide.http.get(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    let items = parseJingsai(res.body, res.final_url || url);
    if (!items.length) items = parseHtmlList(res.body, res.final_url || url, CUSTOM_MAX);
    if (!items.length) {
      const shell = tide.util.web.detectSpaShell(res.body);
      throw new Error(shell ? `页面是 ${shell.framework} 渲染的空壳，服务器不带列表` : "没从页面里认出竞赛条目（站点可能改版了）");
    }
    return { items, hasMore: page < MAX_PAGES };
  }

  /* ═══════════ 通用抓取：自定义源用的三路自动识别 ═══════════ */

  function looksLikeFeed(body) {
    return /<(?:rss|feed|rdf)\b/i.test(String(body || "").slice(0, 2000));
  }

  /** 取 XML 块里第一个非空的 `<name>值</name>`（含 CDATA 与带命名空间的写法）。 */
  function tagText(xml, names) {
    const src = String(xml || "");
    for (const name of names) {
      const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, "i");
      const m = src.match(re);
      if (!m) continue;
      const val = m[1].replace(/^[\s]*<!\[CDATA\[([\s\S]*?)\]\]>[\s]*$/, "$1").trim();
      if (val) return val;
    }
    return "";
  }

  function parseFeedItems(body, baseUrl, limit) {
    const xml = String(body || "").replace(/^\uFEFF/, "");
    const items = [];
    const re = /<(?:[\w.-]+:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>/gi;
    let m;
    while ((m = re.exec(xml)) && items.length < limit) {
      const block = m[2];
      const rawTitle = clip(toText(tagText(block, ["title"])), 120);
      const linkRaw = tagText(block, ["link"])
        || attrOf((block.match(/<link\b[^>]*>/i) || [""])[0], "href");
      const url = absolutize(clip(toText(linkRaw), 400), baseUrl);
      if (!rawTitle && !url) continue;
      const desc = tagText(block, ["description", "summary", "content:encoded", "content"]);
      const enc = block.match(/<(?:media:)?thumbnail\b[^>]*>|<enclosure\b[^>]*>/i);
      items.push({
        rawId: clip(toText(tagText(block, ["guid", "id"])), 120) || url || hashId(rawTitle),
        title: rawTitle || "(无标题)",
        type: "other",
        time: parseDateField(tagText(block, ["pubDate", "published", "updated", "dc:date", "date"])),
        snippet: clip(toText(desc), 160),
        cover: enc ? absolutize(attrOf(enc[0], "url"), baseUrl) : "",
        url,
      });
    }
    return items;
  }

  /** JSON 响应里 BFS 找第一个「对象数组」，再按常见字段名取值。 */
  function findObjectArray(data) {
    const queue = [{ v: data, d: 0 }];
    while (queue.length) {
      const { v, d } = queue.shift();
      if (d > 5) continue;
      if (Array.isArray(v)) {
        if (v.length && v[0] && typeof v[0] === "object" && !Array.isArray(v[0])) return v;
        continue;
      }
      if (v && typeof v === "object") {
        for (const key of Object.keys(v)) queue.push({ v: v[key], d: d + 1 });
      }
    }
    return null;
  }

  /* 自定义 JSON 接口的字段名没法预知，只能靠键名猜。两层：先exact-ish（`title` / `url`），
     再模糊（`actName` / `showTime` / `picUrl` 这类带前后缀的写法）。 */
  const JSON_FIELD = {
    title: [/^(?:title|name|subject|text)$/i, /(?:title|name|subject)/i],
    url: [/^(?:url|link|href|src)$/i, /(?:url|link|href)$/i],
    time: [/^(?:time|date|datetime|publish_time|publishTime|created_at|addtime)$/i, /(?:time|date|_at|deadline)/i],
    snippet: [/^(?:description|summary|desc|abstract|memo|remark|content|intro|note)$/i, /(?:desc|summary|abstract|memo|remark|intro|content|note)/i],
    cover: [/^(?:cover|image|img|pic|thumb|thumbnail)$/i, /(?:pic|img|image|cover|thumb|logo)/i],
    id: [/^(?:id|guid|uuid|newsId|contest_id|actId|tid)$/i, /(?:_?id|Id)$/],
  };
  function pickField(obj, patterns) {
    for (const re of patterns) {
      for (const key of Object.keys(obj)) {
        if (!re.test(key)) continue;
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number' && v > 0) return String(v);
      }
    }
    return '';
  }

  function parseJsonItems(body, baseUrl, limit) {
    let data;
    try { data = JSON.parse(String(body || "")); } catch { return null; }
    const arr = findObjectArray(data);
    if (!arr) return null;
    const items = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      if (items.length >= limit) break;
      const title = clip(toText(pickField(raw, JSON_FIELD.title)), 120);
      if (title.replace(/\s/g, "").length < 4) continue;
      const link = pickField(raw, JSON_FIELD.url);
      // 相对地址一律按接口地址解析；赛氪这类接口的 contest_url 是 `vse/xxx`。
      const url = absolutize(link, baseUrl) || baseUrl;
      const timeRaw = pickField(raw, JSON_FIELD.time);
      items.push({
        rawId: pickField(raw, JSON_FIELD.id) || hashId(`${url}|${title}`),
        title,
        type: "other",
        time: parseDateField(timeRaw),
        snippet: clip(toText(pickField(raw, JSON_FIELD.snippet)), 160),
        cover: absolutize(pickField(raw, JSON_FIELD.cover), baseUrl),
        url,
      });
    }
    return items;
  }

  /** 通用 HTML 列表提取：把页面里每个「像条目的链接」当成一行，带日期的优先。
      没有选择器可调，所以靠「这一行自己有没有日期」「标题够不够长」把导航、页脚筛掉。 */
  function parseHtmlList(html, baseUrl, limit) {
    const base = baseHrefOf(html, baseUrl);
    // 行结束标签：用来把「上一行的日期」挡在下一行之外
    const ROW_END = "<\\/(?:li|tr|article|section|div|p)\\s*>";
    const rowEndRe = new RegExp(ROW_END, "i");
    const rowEndReG = new RegExp(ROW_END, "gi");
    const tags = [];
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    let m;
    while ((m = re.exec(html))) tags.push({ start: m.index, end: re.lastIndex, attrs: m[1], inner: m[2] });

    const dated = [], plain = [];
    const seenUrl = new Set(), seenTitle = new Set();
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const href = attrOf(t.attrs, "href");
      if (!href) continue;
      const url = absolutize(href, base);
      if (!url) continue;
      const key = url.replace(/[?#].*$/, "");
      if (seenUrl.has(key)) continue;
      const title = clip(toText(t.inner) || toText(attrOf(t.attrs, "title")), 120);
      if (title.replace(/\s/g, "").length < 6) continue;
      if (/^(?:登录|注册|首页|更多|详细|查看|查看更多|下一页|上一页|搜索|提交|返回顶部|联系我们)[\s\S]{0,4}$/.test(title)) continue;
      const tkey = title.replace(/\s/g, "");
      if (seenTitle.has(tkey)) continue;
      seenUrl.add(key); seenTitle.add(tkey);

      /* 日期只能在「这一行自己的文字」里找。窗口有两道收边：
         ① 行结束标签（`</li>` / `</tr>` / `</div>` …）—— 上一行的日期不能借给下一行；
         ② 相邻链接 —— 菜单 / 页脚是一串紧挨着的链接，中间没有正文，不收紧就会把邻居的日期算进来
            （实测「2015年优秀大使评选」这类侧栏菜单项会被当成竞赛条目）。
         卡片式列表是「标题 → 一段正文 → 日期」，两道边都隔得远，仍给 300 字符窗口。 */
      const back = html.slice(Math.max(0, t.start - 400), t.start);
      const lastTerm = [...back.matchAll(rowEndReG)].pop();
      const fwd = html.slice(t.end, Math.min(html.length, t.end + 400));
      const nextTerm = fwd.match(rowEndRe);
      const gapLeft = i ? t.start - tags[i - 1].end : Infinity;
      const gapRight = i + 1 < tags.length ? tags[i + 1].start - t.end : Infinity;
      const left = Math.min(300, lastTerm ? back.length - lastTerm.index - lastTerm[0].length : 300, gapLeft < 60 ? gapLeft : 300);
      const right = Math.min(300, nextTerm ? nextTerm.index : 300, gapRight < 60 ? gapRight : 300);
      const ctx = html.slice(Math.max(0, t.start - left), Math.min(html.length, t.end + right));
      const ctxText = toText(ctx);
      const img = ctx.match(/<img\b[^>]*>/i);
      const row = {
        rawId: hashId(key + "|" + tkey),
        title,
        type: "other",
        time: firstDate(ctxText),
        snippet: clip(ctxText.replace(title, ""), 160),
        cover: img ? absolutize(attrOf(img[0], "src"), base) : "",
        url,
      };
      (row.time ? dated : plain).push(row);
      if (dated.length >= limit) break;
    }
    // 没有日期的那些行基本都是导航 / 侧栏 / 页脚。认得出日期的行已经成规模时，一律不要它们。
    return (dated.length >= 8 ? dated : dated.concat(plain)).slice(0, limit);
  }

  /** 页面里声明的订阅地址（`<link rel="alternate" type="application/rss+xml">）。 */
  function discoverFeedUrls(html, baseUrl) {
    const out = [];
    for (const tag of String(html || "").match(/<link\b[^>]*>/gi) || []) {
      if (!/\balternate\b/i.test(attrOf(tag, "rel"))) continue;
      const abs = absolutize(attrOf(tag, "href"), baseUrl);
      if (abs) out.push(abs);
    }
    return [...new Set(out)];
  }

  /** 为什么这个网址抓不出条目。SPA 空壳要单独说清楚，否则用户只会看到「0 条」。 */
  function emptyReason(html) {
    const shell = tide.util.web.detectSpaShell(html);
    const links = (String(html || "").match(/<a\b[^>]*\bhref\s*=/gi) || []).length;
    // 一个链接都没有的页面必然是 JS 渲染出来的，但框架标记不一定写在前 4KB（实测赛氪的
    // Vite 产物就没有 __NUXT__ / data-v-app 这类标记），所以按「零链接」也判一次空壳。
    if (shell || !links) {
      return `这是${shell ? ` ${shell.framework} 渲染` : " JS 渲染"}的页面，列表要浏览器执行脚本才有，服务器只回空壳。`
        + "改抓它的数据接口：浏览器 F12 → Network → 筛 Fetch/XHR → 复制返回竞赛列表那个地址。";
    }
    const feeds = discoverFeedUrls(html, "");
    return feeds.length ? "页面里只有订阅声明、没认出列表条目。" : "没从页面里认出列表条目（链接太少或都不是竞赛列表）。";
  }

  /** 抓一个通用地址：RSS/Atom → JSON → HTML 依次尝试；纯 HTML 页还挂着订阅声明的话追一跳。 */
  async function fetchGeneric(url, tried) {
    const seen = tried || new Set();
    seen.add(url);
    const res = await tide.http.get(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = String(res.body || "");
    const base = res.final_url || url;
    if (looksLikeFeed(body)) {
      const items = parseFeedItems(body, base, CUSTOM_MAX);
      if (items.length) return { items, hasMore: false };
      throw new Error("这是一份 feed，但里面没有条目");
    }
    const trimmed = body.replace(/^\s+/, "");
    if (trimmed[0] === "{" || trimmed[0] === "[") {
      const items = parseJsonItems(body, base, CUSTOM_MAX);
      if (items === null) throw new Error("JSON 解析失败");
      if (items.length) return { items, hasMore: false };
      throw new Error("JSON 里没找到「对象数组」形式的列表数据");
    }
    const items = parseHtmlList(body, base, CUSTOM_MAX);
    if (items.length) return { items, hasMore: false };
    const next = discoverFeedUrls(body, base).find((u) => !seen.has(u));
    if (next) return fetchGeneric(next, seen);
    throw new Error(emptyReason(body));
  }

  /* ═══════════ 源清单 ═══════════ */

  function builtinSources() {
    return [
      { id: LEGACY_SRC, name: "摩课云竞赛", home: "https://www.gxxsjs.com/", fetch: fetchMokeroad, pages: true },
      { id: "saikr", name: "赛氪竞赛广场", home: "https://www.saikr.com/contests", fetch: fetchSaikr, pages: true },
      { id: "jingsai", name: "我要参赛网", home: JINGSAI_HOME, fetch: fetchJingsai, pages: true },
    ];
  }
  function sources() {
    return [...builtinSources(), ...state.custom.map((c) => ({
      id: c.id, name: c.name, home: c.url, pages: false,
      fetch: (page) => (page > 1 ? Promise.resolve({ items: [], hasMore: false }) : fetchGeneric(c.url)),
    }))];
  }
  const currentSource = () => sources().find((s) => s.id === state.sourceId) || builtinSources()[0];

  /* ═══════════ 持久化 ═══════════ */

  /* 持久化的筛选值是上次界面点出来的，可能是旧版本写的、也可能是早就命不中的绝对月份，
     读回来必须先归一遍类型，否则界面上一个 chip 都没高亮却仍在过滤（用户只看到「显示 0 条」）。 */
  function sanitizeFilter(raw) {
    const f = { ...state.filter, ...(raw && typeof raw === "object" ? raw : {}) };
    f.kw = String(f.kw || "");
    if (f.type === "202") f.type = "n202";
    if (f.type === "203") f.type = "n203";
    // 类型 id 现在有两种来源：内置的 n202/n203/other，以及数据里长出来的 lv:/cat: 前缀值。
    if (f.type !== "all" && !/^n\d{3}$|^other$|^(?:lv|cat):/.test(String(f.type))) f.type = "all";
    if (f.month !== "all" && f.month !== "unknown" && !/^\d{4}-\d{2}$/.test(String(f.month))) f.month = "all";
    f.hideSeen = !!f.hideSeen;
    f.showCover = !!f.showCover;
    return f;
  }

  /** 旧版本只有一家的裸 id（`123`）⇒ 补上摩课云前缀，老设备的已读记录才不会整批复活成 NEW。 */
  const legacyId = (x) => { const s = String(x); return s.includes(":") ? s : `${LEGACY_SRC}:${s}`; };

  async function loadPrefs() {
    state.filter = sanitizeFilter(await tide.storage.get("filter", null));
    state.seen = new Set((await tide.storage.get("seen", []) || []).map(legacyId));
    state.custom = normalizeCustom(await tide.storage.get("customSources", []));
    const saved = String(await tide.storage.get("source", "") || "");
    if (saved) state.sourceId = saved;
    const rawKnown = await tide.storage.get("knownIds", null);
    // v0.3.x 写的是一维数组（当时只有摩课云一个源）⇒ 归到摩课云名下。
    state.known = Array.isArray(rawKnown)
      ? { [LEGACY_SRC]: rawKnown.map(legacyId) }
      : (rawKnown && typeof rawKnown === "object" ? rawKnown : {});
  }
  function normalizeCustom(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [], seen = new Set();
    for (const item of list) {
      const url = String((item && item.url) || "").trim();
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const id = String((item && item.id) || "").trim() || `usr-${hashId(url)}`;
      out.push({ id, name: clip(String((item && item.name) || ""), 20) || hostOf(url), url });
      if (out.length >= 20) break;
    }
    return out;
  }
  const savePrefs = () => tide.storage.set("filter", state.filter);
  const saveSeen = () => tide.storage.set("seen", [...state.seen].slice(-600));
  const saveCustom = () => tide.storage.set("customSources", state.custom);
  const saveSource = () => tide.storage.set("source", state.sourceId);

  function activeFilters() {
    const out = [];
    if (state.filter.kw.trim()) out.push(`关键词「${state.filter.kw.trim()}」`);
    if (state.filter.type !== "all") out.push(`类型「${typeLabel(state.filter.type)}」`);
    if (state.filter.month !== "all") out.push(`月份「${monthLabel(state.filter.month)}」`);
    if (state.filter.hideSeen) out.push("只看未读");
    return out;
  }

  /* ═══════════ 抓取 ═══════════ */

  /* ── 插件联动：第 1 页抓到新消息时广播 notice:new，微信推送插件按插件勾选合并推送 ──
     判「新」用「该源上次第 1 页的 id 快照」而不是界面上的已读集合 —— 那个只在点开卡片时才写，
     拿它做差分等于每刷新一次就把没点开的旧消息重推一遍。该源没有快照（首次抓取）只记不广播。 */
  async function broadcastNew(src, rows) {
    const stored = state.known[src.id];
    const known = new Set(Array.isArray(stored) ? stored : []);
    const fresh = stored === undefined ? [] : rows.filter((m) => !known.has(m.id));
    state.known[src.id] = rows.map((m) => m.id);
    await tide.storage.set("knownIds", state.known);
    if (!fresh.length) return;
    try {
      tide.events.emit("notice:new", {
        source: "gx-news", sourceName: `竞赛消息·${src.name}`, total: fresh.length,
        items: fresh.slice(0, 5).map((m) => ({ title: m.title, time: m.time || "", sender: src.name })),
      });
    } catch {}
  }

  async function fetchList(page = 1) {
    if (state.fetching) return;
    const src = currentSource();
    const seq = ++fetchSeq;
    state.fetching = true;
    paintStatus();
    try {
      const { items, hasMore } = await src.fetch(page);
      if (seq !== fetchSeq) return;   // 抓取期间切了源：结果丢掉，别把上一家的条目混进这一家
      const fresh = items.map((m) => ({ ...m, id: `${src.id}:${m.rawId}`, srcId: src.id }));
      if (page === 1) state.list = fresh;
      else {
        const ids = new Set(state.list.map((m) => m.id));
        state.list = state.list.concat(fresh.filter((m) => !ids.has(m.id)));
      }
      try {
        tide.messages?.publish(state.list.slice(0, 80).map((m) => ({
          title: m.title, time: m.time || "", sender: src.name, sourceName: `竞赛消息·${src.name}`,
        })));
      } catch {}
      state.page = page;
      state.hasMore = !!hasMore;
      state.fetchedAt = Date.now();
      state.error = null;
      if (page === 1) {
        // 月份是绝对值：跨一个月之后本次抓取里就没有它，界面却会「一个 chip 都不高亮」地继续过滤。
        // 抓完第 1 页先把它对齐到真实存在的月份，命不中就静默回「全部」。
        if (state.filter.month !== "all" && !state.list.some((m) => monthOf(m) === state.filter.month)) {
          state.filter.month = "all";
          savePrefs();
        }
        await broadcastNew(src, fresh);
      }
    } catch (e) {
      if (seq !== fetchSeq) return;
      state.error = String(e && e.message ? e.message : e);
    }
    if (seq !== fetchSeq) return;
    state.fetching = false;
    paintAll();
  }

  function filtered() {
    const kw = state.filter.kw.trim().toLowerCase();
    const rows = state.list.filter((m) => {
      if (state.filter.type !== "all" && m.type !== state.filter.type) return false;
      if (state.filter.month !== "all" && monthOf(m) !== state.filter.month) return false;
      if (state.filter.hideSeen && state.seen.has(m.id)) return false;
      if (kw && !(m.title.toLowerCase().includes(kw) || m.snippet.toLowerCase().includes(kw))) return false;
      return true;
    });
    // 各家接口的返回顺序不定（赛氪按热度、我要参赛网按发布），展示统一按时间倒排
    return rows.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  }

  /* ═══════════ 渲染 ═══════════ */

  function ensureStyle() {
    if (document.getElementById("gx-news-style")) return;
    const st = document.createElement("style");
    st.id = "gx-news-style";
    st.textContent = `
      .gx-wrap{max-width:880px;margin:0 auto}
      .gx-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
      .gx-lab{font-size:calc(11px * var(--ui-text-scale));color:#A9B2BA;letter-spacing:.14em;flex:none;width:34px}
      .gx-chips{display:flex;gap:8px;flex-wrap:wrap;flex:1}
      .gx-kw{flex:1;min-width:170px;height:34px;border:1px solid #E4DFD6;border-radius:9px;padding:0 11px;background:#fff}
      .gx-chip{font-size:calc(12px * var(--ui-text-scale));border:1px solid #E4DFD6;background:#fff;border-radius:16px;padding:6px 13px;cursor:pointer;color:#7E8B94}
      .gx-chip.on{background:#0F4C5C;color:#fff;border-color:#0F4C5C}
      .gx-chip.add{border-style:dashed;color:#0F4C5C}
      .gx-link{font-size:calc(11.5px * var(--ui-text-scale));color:#7E8B94;cursor:pointer;background:none;border:none;text-decoration:underline;text-underline-offset:3px}
      .gx-link:hover{color:#0F4C5C}
      .gx-toggle{display:flex;align-items:center;gap:6px;font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;cursor:pointer;user-select:none}
      .gx-toggle i{width:34px;height:19px;border-radius:10px;background:#D8D2C6;display:inline-block;position:relative;transition:.15s}
      .gx-toggle i::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:.15s}
      .gx-toggle.on i{background:#2EC4B6}
      .gx-toggle.on i::after{left:17px}
      .gx-status{font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;margin:2px 0 8px}
      .gx-status .err{color:#B03535}
      /* 无阴影 + 分块渲染 + 离屏跳过：滚动零成本 */
      .gx-card{display:flex;gap:12px;background:#fff;border:1px solid #E4DFD6;border-radius:14px;padding:12px 14px;margin-bottom:9px;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 96px}
      .gx-card:hover{background:#FBFAF5;border-color:#D8D2C4}
      .gx-card.seen{opacity:.55}
      .gx-cover{width:74px;height:56px;border-radius:8px;object-fit:cover;flex:none;background:#EFEAE1;transform:translateZ(0)}
      .gx-main{flex:1;min-width:0}
      .gx-title{font-size:calc(13.5px * var(--ui-text-scale));font-weight:600;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gx-meta{display:flex;gap:8px;align-items:center;font-size:calc(11px * var(--ui-text-scale));color:#7E8B94;margin-top:4px;flex-wrap:wrap}
      .gx-tag{border-radius:6px;padding:2px 8px;background:#E1EEF3;color:#0F4C5C;font-size:calc(10px * var(--ui-text-scale))}
      .gx-tag.n{background:#EFE7FB;color:#6C3FB8}
      .gx-dl{color:#B03535;font-weight:600}
      .gx-st{color:#2F8F5B}
      .gx-new{background:#FF6B6B;color:#fff;border-radius:8px;padding:1px 7px;font-size:calc(10px * var(--ui-text-scale))}
      .gx-snip{font-size:calc(11.5px * var(--ui-text-scale));color:#7E8B94;margin-top:5px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .gx-act{display:flex;flex-direction:column;gap:6px;justify-content:center}
      .gx-btn{font-size:calc(11px * var(--ui-text-scale));border:1px solid #E4DFD6;border-radius:8px;padding:5px 10px;background:#fff;cursor:pointer;color:#22303A;white-space:nowrap}
      .gx-btn:hover{border-color:#0F4C5C;color:#0F4C5C}
      .gx-empty{border:1.5px dashed #CFC8BA;border-radius:12px;padding:26px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.8}
      .gx-empty + .gx-btn{display:block;margin:9px auto 0;padding:7px 16px}
      .gx-month{font-size:calc(12.5px * var(--ui-text-scale));font-weight:700;color:#0F4C5C;padding:9px 2px 7px;letter-spacing:.05em}
      .gx-more{display:flex;justify-content:center;padding:8px 0 4px}
      .gx-more .gx-btn{padding:8px 20px;font-size:calc(12px * var(--ui-text-scale))}
      .gx-refresh{font-size:calc(12.5px * var(--ui-text-scale));font-weight:600;height:34px;padding:0 15px;border-radius:9px;background:#0F4C5C;color:#fff;cursor:pointer}
      .gx-refresh:disabled{opacity:.5}
      /* 添加 / 管理自定义源：挂在插件自己的容器里，不碰 document.body（宿主切视图会连它一起摘掉）
         ⚠️ position:fixed 的包含块是宿主 .view 的 padding box（.view 上有 will-change:transform），
         所以 .view 替插件垫掉的四条安全区边拦不住它 —— 浮层必须自己让开，且一律走
         var(--sa*, env(…)) 双路（铁律四：Android WebView 里裸 env() 恒为 0）。 */
      .gx-mask{position:fixed;inset:0;background:rgba(20,28,34,.42);display:flex;align-items:center;justify-content:center;z-index:40;padding:calc(16px + var(--sat,env(safe-area-inset-top,0px))) calc(16px + var(--sar,env(safe-area-inset-right,0px))) calc(16px + var(--sab,env(safe-area-inset-bottom,0px))) calc(16px + var(--sal,env(safe-area-inset-left,0px)))}
      .gx-dlg{width:min(460px,100%);max-height:min(82vh,100%);overflow:auto;background:#fff;border-radius:16px;padding:18px 20px}
      .gx-dlg h4{margin:0 0 4px;font-size:calc(14px * var(--ui-text-scale));color:#22303A}
      .gx-dlg p{margin:0 0 12px;font-size:calc(11.5px * var(--ui-text-scale));color:#7E8B94;line-height:1.7}
      .gx-field{display:block;margin-bottom:10px;font-size:calc(11.5px * var(--ui-text-scale));color:#7E8B94}
      .gx-field input{display:block;width:100%;margin-top:4px;height:34px;border:1px solid #E4DFD6;border-radius:9px;padding:0 11px;font-size:calc(12.5px * var(--ui-text-scale))}
      .gx-res{font-size:calc(11.5px * var(--ui-text-scale));line-height:1.7;margin:2px 0 10px;min-height:18px;color:#7E8B94}
      .gx-res.ok{color:#2F8F5B}
      .gx-res.bad{color:#B03535}
      .gx-btns{display:flex;gap:8px;justify-content:flex-end}
      .gx-list{margin:16px 0 0;padding:12px 0 0;border-top:1px dashed #E4DFD6;list-style:none}
      .gx-list li{display:flex;gap:8px;align-items:center;font-size:calc(11.5px * var(--ui-text-scale));color:#7E8B94;padding:5px 0}
      .gx-list .nm{color:#22303A;font-weight:600;flex:none}
      .gx-list .u{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .gx-del{border:1px solid #E4DFD6;background:#fff;color:#B03535;border-radius:7px;padding:3px 9px;cursor:pointer;font-size:calc(11px * var(--ui-text-scale))}
      .gx-cap{font-size:calc(10.5px * var(--ui-text-scale));color:#A9B2BA}
    `;
    document.head.append(st);
  }

  function paintStatus() {
    if (!ui) return;
    const s = ui.status;
    const src = currentSource();
    if (state.fetching && !state.list.length) { s.innerHTML = `正在抓取「${esc(src.name)}」…`; return; }
    if (state.error) { s.innerHTML = `<span class="err">抓取失败：${esc(state.error)}（点「刷新」重试）</span>`; return; }
    const at = state.fetchedAt ? new Date(state.fetchedAt).toTimeString().slice(0, 5) : "—";
    s.innerHTML = `源 <b>${esc(src.name)}</b> · 已更新 ${at} · 拉取 ${state.list.length} 条 · 显示 <b>${filtered().length}</b> 条`
      + (src.pages ? "" : '<span class="gx-cap">　自定义源只取第 1 页</span>');
  }

  function chipRow(container, items, current, onPick) {
    container.replaceChildren(...items.map((c) => {
      const b = document.createElement("button");
      b.className = "gx-chip" + (c.class ? ` ${c.class}` : "") + (current === c.id ? " on" : "");
      b.textContent = c.label;
      b.addEventListener("click", () => onPick(c.id));
      return b;
    }));
  }

  /** 当前列表里真实出现过的类型 → chip。正在生效但已命不中的那个也要留在台面上，
      否则就是「一个都没高亮却仍在过滤」的老坑。 */
  function typeChips() {
    const map = new Map();
    for (const m of state.list) if (m.type) map.set(m.type, typeLabel(m.type));
    if (state.filter.type !== "all" && !map.has(state.filter.type)) {
      map.set(state.filter.type, typeLabel(state.filter.type));
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }

  function paintChips() {
    if (!ui) return;
    chipRow(ui.sources, [
      ...sources().map((s) => ({ id: s.id, label: s.name })),
      { id: "__add", label: "＋ 添加源", class: "add" },
    ], state.sourceId, (id) => {
      if (id === "__add") { openDialog(); return; }
      setSource(id);
    });

    const types = typeChips();
    // 只有一个类型（自定义源大多如此）时这一排没有信息量，整行收掉。
    ui.typeBar.style.display = types.length <= 1 && state.filter.type === "all" ? "none" : "flex";
    chipRow(ui.chips, [{ id: "all", label: "全部" }, ...types], state.filter.type,
      (id) => { state.filter.type = id; savePrefs(); paintChips(); paintList(true); });

    const months = [...new Set(state.list.map(monthOf))].filter((mo) => mo !== "unknown").sort().reverse();
    if (state.list.some((m) => monthOf(m) === "unknown")) months.push("unknown");
    chipRow(ui.months, [{ id: "all", label: "全部" }, ...months.map((mo) => ({ id: mo, label: monthLabel(mo) }))],
      state.filter.month, (id) => { state.filter.month = id; savePrefs(); paintChips(); paintList(true); });

    ui.filterSummary.textContent = `筛选${state.filter.type !== "all" || state.filter.month !== "all" || state.filter.hideSeen ? " · 已设置" : ""}`;

    ui.hideSeen.classList.toggle("on", !!state.filter.hideSeen);
    ui.showCover.classList.toggle("on", !!state.filter.showCover);
    ui.auto.classList.toggle("on", !!state.filter.auto);
  }

  function cardHtml(m) {
    const isNew = !state.seen.has(m.id);
    const tn = typeLabel(m.type);
    return `<div class="gx-card${isNew ? "" : " seen"}" data-id="${esc(m.id)}">
      ${state.filter.showCover && m.cover ? `<img class="gx-cover" loading="lazy" decoding="async" fetchpriority="low" src="${esc(coverSmall(m.cover))}" data-orig="${esc(m.cover)}" onerror="if(this.dataset.retried){this.style.display='none'}else{this.dataset.retried=1;this.src=this.dataset.orig}">` : ""}
      <div class="gx-main">
        <div class="gx-title">${esc(m.title)}</div>
        <div class="gx-meta">
          <span class="gx-tag ${tn === "赛事动态" ? "n" : ""}">${esc(tn)}</span>
          <span>${esc(m.time)}</span>
          ${m.deadline ? `<span class="gx-dl">截止 ${esc(m.deadline.slice(0, 16))}</span>` : ""}
          ${m.status ? `<span class="gx-st">${esc(m.status)}</span>` : ""}
          ${isNew ? '<span class="gx-new">NEW</span>' : ""}
        </div>
        ${m.snippet ? `<div class="gx-snip">${esc(m.snippet)}</div>` : ""}
      </div>
      <div class="gx-act">
        <button class="gx-btn" data-act="open">打开 ↗</button>
        <button class="gx-btn" data-act="remind">提醒</button>
      </div>
    </div>`;
  }

  // 阿里云 OSS 实时缩略图：列表只拉 148px 小图，失败回退原图（摩课云 / 赛氪的图床都是 OSS）
  function coverSmall(url) {
    if (!url) return "";
    return url + (url.includes("?") ? "&" : "?") + "x-oss-process=image/resize,w_148/quality,q_80";
  }

  function paintList(reset) {
    if (!ui) return;
    if (reset) state.renderedCount = CHUNK;
    const rows = filtered();
    const slice = rows.slice(0, state.renderedCount);
    ui.count.textContent = String(rows.length);
    const token = ++paintToken;

    if (!slice.length) {
      if (!state.list.length) {
        ui.list.innerHTML = `<div class="gx-empty">「${esc(currentSource().name)}」还没有消息，点上方「刷新」抓取</div>`;
        return;
      }
      // 「拉取 N 条 / 显示 0 条」最容易被读成抓取失败，所以把生效中的筛选原样列出来，并给一次清零。
      const acts = activeFilters();
      ui.list.innerHTML = `<div class="gx-empty">已抓取 ${state.list.length} 条，被筛选全部滤掉了<br>`
        + `生效中：${acts.length ? esc(acts.join("、")) : "无"}${acts.length ? "（点下面按钮一次清除）" : ""}</div>`;
      if (acts.length) {
        const b = document.createElement("button");
        b.className = "gx-btn";
        b.dataset.clearFilters = "1";
        b.textContent = "✕ 清除全部筛选";
        ui.list.append(b);
      }
      return;
    }

    // 分月分组
    let html = "", lastMonth = "";
    const counts = {};
    for (const m of rows) counts[monthOf(m)] = (counts[monthOf(m)] || 0) + 1;
    for (const m of slice) {
      const mo = monthOf(m);
      if (mo !== lastMonth) {
        html += `<div class="gx-month">${esc(monthLabel(mo))} · ${counts[mo]} 条</div>`;
        lastMonth = mo;
      }
      html += cardHtml(m);
    }
    ui.list.innerHTML = html;

    // 底部：先分块渲染已加载的，再手动翻页拉更早的（自定义源没有翻页）
    const more = document.createElement("div");
    more.className = "gx-more";
    if (state.renderedCount < rows.length) {
      const b = document.createElement("button");
      b.className = "gx-btn";
      b.textContent = `▾ 显示更多（本页还有 ${rows.length - state.renderedCount} 条）`;
      b.addEventListener("click", () => {
        if (token !== paintToken) return;
        state.renderedCount += CHUNK;
        paintList();
      });
      more.append(b);
    } else if (state.hasMore) {
      const b = document.createElement("button");
      b.className = "gx-btn";
      b.textContent = state.fetching ? "正在加载更早的消息…" : `加载更早的消息（第 ${state.page + 1} 页）`;
      b.addEventListener("click", () => { if (token === paintToken) fetchList(state.page + 1); });
      more.append(b);
    } else if (state.list.length) {
      more.innerHTML = `<div style="font-size:calc(11px * var(--ui-text-scale));color:#A9B2BA">这一页的内容已全部展示</div>`;
    }
    ui.list.append(more);
  }

  function paintAll(reset) {
    paintStatus();
    paintChips();
    paintList(reset);
  }

  function markSeen(id) {
    state.seen.add(id);
    saveSeen();
  }

  async function createReminder(m) {
    const text = `${m.title} ${m.snippet}`;
    const p = tide.util.parseWhen(text);
    const cat = tide.util.guessCategory(text);
    let date = p.date, startMin = p.startMin, endMin = p.endMin;
    // 正文里没写出时间、但接口本身带了报名截止 ⇒ 用那个日期兜底（赛氪这类接口每条都给）。
    // 只取「哪天」，不取几点：报名截止往往是 23:59 / 00:39 这类半夜时刻，按它提醒等于睡梦里收通知。
    let fromDeadline = false;
    if (!date && m.deadline) {
      date = m.deadline.slice(0, 10);
      startMin = null; endMin = null;
      fromDeadline = true;
    }
    const task = tide.tasks.create({
      title: m.title,
      quad: tide.util.guessQuad(date),
      estMin: date && startMin !== null && startMin !== undefined && endMin ? endMin - startMin : 60,
      due: date || null,
      tags: ["竞赛消息"],
      note: m.url,
    });
    if (date && startMin !== null && startMin !== undefined) {
      const dur = endMin && endMin > startMin ? endMin - startMin : 60;
      tide.blocks.create({ date, start: tide.util.hhmmOf(startMin), durMin: dur, title: m.title, taskId: task.id, cat });
      tide.notify(`已创建提醒：「${m.title.slice(0, 20)}${m.title.length > 20 ? "…" : ""}」→ ${date.slice(5)} ${tide.util.hhmmOf(startMin)}${fromDeadline ? "（按报名截止）" : ""}`, {
        actionLabel: "查看", ms: 6500,
        action: () => tide.util.navigate("timeblock"),
      });
    } else if (date) {
      tide.blocks.create({ date, start: "09:00", durMin: 60, title: m.title, taskId: task.id, cat });
      tide.notify(`识别到日期 ${date.slice(5)}，提醒先放在 09:00${fromDeadline ? "（按报名截止）" : ""}`);
    } else {
      tide.notify("没识别到日期，任务已存入象限池，可手动安排");
    }
    markSeen(m.id);
    paintList();
  }

  function setAuto(on) {
    state.filter.auto = on;
    savePrefs();
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (on) state.timer = setInterval(() => fetchList(1), 10 * 60 * 1000);
  }

  /** 换源：清掉上一家的结果与「只在这一家成立」的类型 / 月份筛选，再抓第一页。
      关键词与「只看未读」是跟人不跟源的，保留。 */
  function setSource(id) {
    if (state.sourceId === id) return;
    state.sourceId = id;
    state.filter.type = "all";
    state.filter.month = "all";
    state.list = []; state.page = 1; state.hasMore = true; state.error = null; state.fetchedAt = 0;
    state.fetching = false;
    fetchSeq += 1;
    paintToken += 1;
    saveSource(); savePrefs();
    fetchList(1);
  }

  /* ═══════════ 添加 / 管理自定义源 ═══════════ */

  function openDialog() {
    if (!ui || dialog) return;
    const mask = document.createElement("div");
    mask.className = "gx-mask";
    mask.innerHTML = `
      <div class="gx-dlg">
        <h4>添加竞赛源</h4>
        <p>贴一个竞赛列表的网址就行，添加时会真抓一次并自动识别形态：RSS / Atom 订阅、返回 JSON 的数据接口、普通网页列表都支持。
        识别不出条目会直接说明原因（比如页面是 JS 渲染的空壳）。</p>
        <label class="gx-field">源名称（留空用域名）<input class="gx-dlg-name" type="text" placeholder="如 我的目标赛事"></label>
        <label class="gx-field">列表地址<input class="gx-dlg-url" type="text" placeholder="https://…"></label>
        <div class="gx-res"></div>
        <div class="gx-btns">
          <button class="gx-btn" data-act="cancel">取消</button>
          <button class="gx-refresh" data-act="save">检测并添加</button>
        </div>
        <ul class="gx-list"></ul>
      </div>`;
    ui.wrap.append(mask);

    const dlg = {
      mask,
      name: mask.querySelector(".gx-dlg-name"),
      url: mask.querySelector(".gx-dlg-url"),
      res: mask.querySelector(".gx-res"),
      list: mask.querySelector(".gx-list"),
      hide() { if (mask.parentNode) mask.parentNode.removeChild(mask); dialog = null; },
    };
    dialog = dlg;
    const paintCustomList = () => {
      dlg.list.replaceChildren(...state.custom.map((c) => {
        const li = document.createElement("li");
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = c.name;
        const u = document.createElement("span");
        u.className = "u";
        u.textContent = c.url;
        const del = document.createElement("button");
        del.className = "gx-del";
        del.textContent = "删除";
        del.addEventListener("click", () => removeCustom(c.id));
        li.append(nm, u, del);
        return li;
      }));
      const tip = document.createElement("li");
      tip.innerHTML = `<span class="gx-cap">${state.custom.length
        ? `已添加 ${state.custom.length} 个 · 自定义源每次刷新只取第 1 页`
        : "还没有自定义源"}</span>`;
      dlg.list.append(tip);
    };
    const say = (msg, cls) => { dlg.res.className = `gx-res ${cls || ""}`; dlg.res.textContent = msg; };

    const removeCustom = (id) => {
      const gone = state.custom.find((c) => c.id === id);
      state.custom = state.custom.filter((c) => c.id !== id);
      saveCustom();
      paintCustomList();
      paintChips();
      tide.notify(`已删除竞赛源「${(gone && gone.name) || id}」`);
      if (state.sourceId !== id) return;
      // 删的正是当前源：回落到默认的摩课云并重抓，否则界面停在一张空列表上。
      state.sourceId = LEGACY_SRC;
      state.filter.type = "all"; state.filter.month = "all";
      state.list = []; state.error = null; state.fetching = false;
      fetchSeq += 1;
      saveSource(); savePrefs();
      fetchList(1);
    };

    dlg.mask.addEventListener("click", async (e) => {
      if (e.target === dlg.mask || e.target.closest('[data-act="cancel"]')) { dlg.hide(); return; }
      if (!e.target.closest('[data-act="save"]')) return;
      const url = String(dlg.url.value || "").trim();
      if (!/^https?:\/\//i.test(url)) { say("地址要以 http:// 或 https:// 开头", "bad"); return; }
      if (state.custom.some((c) => c.url === url)) { say("这个地址已经添加过了", "bad"); return; }
      // 内置三家已经覆盖的站别再当自定义源加：自定义那一套是通用启发式解析，
      // 认得出的条目比内置适配器少、也不带类型 / 截止时间，用户以为「加了两次更好」其实更差。
      const builtinSame = builtinSources().find((s) => hostOf(s.home) === hostOf(url));
      if (builtinSame) { say(`「${builtinSame.name}」已经是内置源，直接在上方「源」那一排点它就行`, "bad"); return; }
      say("正在抓取并识别…");
      const name = clip(String(dlg.name.value || ""), 20) || hostOf(url);
      try {
        const { items } = await fetchGeneric(url);
        state.custom = [...state.custom, { id: `usr-${hashId(url)}`, name, url }];
        saveCustom();
        dlg.hide();
        setSource(`usr-${hashId(url)}`);
        tide.notify(`已添加「${name}」，抓到 ${items.length} 条`);
      } catch (err) {
        // 抓不通就不落库：留下一个抓不出东西的源，只会在每次刷新时重复报错。
        say(String(err && err.message ? err.message : err), "bad");
      }
    });
    dlg.url.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.name.addEventListener("keydown", (e) => e.stopPropagation());

    paintCustomList();
    try { dlg.url.focus(); } catch {}
  }

  /* ═══════════ 视图 ═══════════ */

  function buildUI(el) {
    el.innerHTML = "";
    el.style.overscrollBehavior = "contain";

    const wrap = document.createElement("div");
    wrap.className = "gx-wrap";
    wrap.innerHTML = `
      <div style="font-size:calc(11px * var(--ui-text-scale));letter-spacing:.3em;color:#7E8B94;margin:16px 0 4px">竞 赛 消 息 雷 达 · 内 置 插 件</div>
      <div class="gx-toolbar"><button class="gx-link" data-home>打开源站 ↗</button></div>
      <div class="gx-toolbar">
        <button class="gx-refresh">刷新</button>
        <input class="gx-kw" type="text" placeholder="关键词过滤：如 答辩 / 数学 / 报名 / 截止…">
        <label class="gx-toggle show-cover"><i></i>封面图</label>
        <label class="gx-toggle auto"><i></i>每 10 分钟自动刷新</label>
      </div>
      <details class="plugin-filter-menu"><summary data-filter-summary>筛选</summary><div class="plugin-filter-menu-panel">
        <div class="gx-toolbar"><span class="gx-lab">源</span><div class="gx-chips" data-sources></div></div>
        <div class="gx-toolbar" data-type-bar><span class="gx-lab">类型</span><div class="gx-chips" data-chips></div></div>
        <div class="gx-toolbar"><span class="gx-lab">月份</span><div class="gx-chips" data-months></div></div>
        <label class="gx-toggle hide-seen"><i></i>只看未读</label>
      </div></details>
      <div class="gx-status"></div>
      <div data-list></div>
      <div style="height:30px"></div>
    `;
    el.append(wrap);

    ui = {
      wrap,
      status: wrap.querySelector(".gx-status"),
      sources: wrap.querySelector("[data-sources]"),
      typeBar: wrap.querySelector("[data-type-bar]"),
      chips: wrap.querySelector("[data-chips]"),
      months: wrap.querySelector("[data-months]"),
      filterSummary: wrap.querySelector("[data-filter-summary]"),
      list: wrap.querySelector("[data-list]"),
      kw: wrap.querySelector(".gx-kw"),
      hideSeen: wrap.querySelector(".hide-seen"),
      showCover: wrap.querySelector(".show-cover"),
      auto: wrap.querySelector(".auto"),
      refresh: wrap.querySelector(".gx-refresh"),
      home: wrap.querySelector("[data-home]"),
      count: document.createElement("b"),
    };
    // 视图重进时旧的 `el.innerHTML = ""` 已经把浮层从 DOM 上摘走了，指针必须一起清掉，
    // 否则 openDialog 会以为还开着、再也点不出东西。
    dialog = null;

    ui.kw.value = state.filter.kw;
    let kwTimer = null;
    ui.kw.addEventListener("input", () => {
      clearTimeout(kwTimer);
      kwTimer = setTimeout(() => {
        state.filter.kw = ui.kw.value;
        savePrefs();
        paintAll();
      }, 200);
    });
    ui.kw.addEventListener("keydown", (e) => e.stopPropagation());

    ui.hideSeen.addEventListener("click", () => {
      state.filter.hideSeen = !state.filter.hideSeen;
      savePrefs(); paintChips(); paintList(true);
    });
    ui.showCover.addEventListener("click", () => {
      state.filter.showCover = !state.filter.showCover;
      savePrefs(); paintChips(); paintList(true);
    });
    ui.auto.addEventListener("click", () => {
      setAuto(!state.filter.auto);
      paintChips();
      tide.notify(state.filter.auto ? "已开启自动刷新（10 分钟，只刷当前源）" : "已关闭自动刷新");
    });
    ui.refresh.addEventListener("click", () => fetchList(1));
    ui.home.addEventListener("click", () => tide.util.openUrl(currentSource().home));

    ui.list.addEventListener("click", (e) => {
      if (e.target.closest("[data-clear-filters]")) {
        state.filter = { ...state.filter, kw: "", type: "all", month: "all", hideSeen: false };
        ui.kw.value = "";
        savePrefs();
        paintAll(true);
        return;
      }
      const card = e.target.closest(".gx-card");
      if (!card) return;
      const m = state.list.find((x) => String(x.id) === String(card.dataset.id));
      if (!m) return;
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "remind") { createReminder(m); return; }
      markSeen(m.id);
      paintList();
      if (m.url) tide.util.openUrl(m.url);
      else tide.notify("这条消息没有可用的详情地址");
    });

    paintAll();
    if (state.filter.auto && !state.timer) state.timer = setInterval(() => fetchList(1), 10 * 60 * 1000);
    if (!state.list.length && !state.fetching && !state.error) fetchList(1);
  }

  function render(el) {
    ensureStyle();
    el.innerHTML = '<div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在读取偏好…</div>';
    loadPrefs().then(() => buildUI(el)).catch(() => buildUI(el));
  }

  tide.ui.registerView({ id: "gx-news", title: "竞赛消息", icon: 'trophy', render });
})();
