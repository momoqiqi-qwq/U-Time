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
  const MOJING_HOME = "https://www.mojinghub.com/competitions";
  const MOJING_API = "https://admin.mojinghub.com";
  const MOJING_POST = { headers: { "Content-Type": "application/json" } };

  /* ═══════════ 分类体系：三条正交的轴，每轴一张有序封闭表 ═══════════
     旧版把三种互不相干的语义塞进同一个 `type` 字段 —— 摩课云的「消息性质」、赛氪的
     「赛事级别」、我要参赛网的「站点分类」。后果就是「类型」那一排 chip 混着三种轴：
     换个源整排换脸、顺序跟着抓取结果的先后漂移，认不出的统统掉进「其他」，越用越乱。

     现在拆成三条互不干涉的轴，每轴一张**有序**表：表顺序 = chip 顺序 = 关键词命中优先级。
       kind  性质：这条消息是「什么」  报名 / 榜单 / 公告 / 培训 / 赛事
       level 级别：办到哪一层          国际 / 全国 / 省级 / 市级 / 校级
       field 学科：比的是什么          数学建模 / 程序设计 / 电子机械 / 数理化生 /
                                       经济管理 / 文学外语 / 设计艺术 / 体育公益
     站点原生标签（newsType / level_name / 「分类」）只当第一手证据，经表归一后落到轴上，
     不再直接当 chip 用 —— 词表因此封闭且跨源通用，换源不用重学一套分类。
     认不出的轴一律留空，**不设「其他」占格子**：空标签不渲染、不成 chip。 */
  const KIND_TABLE = [
    { id: "signup", label: "报名", kw: /报名|开赛|征集|征稿|招募|参赛|投递|投稿|提交|通道|入口|截止/ },
    { id: "result", label: "榜单", kw: /榜单|获奖|奖项|名单|结果|公示|成绩|晋级|入围|评审|揭晓|评比/ },
    { id: "notice", label: "公告", kw: /公告|通知|须知|安排|说明|调整|变更|延期|预告|政策|日程|时间表/ },
    { id: "train", label: "培训", kw: /培训|讲座|公开课|研讨会|分享会|工作坊|训练营|辅导|答疑|宣讲/ },
    { id: "race", label: "赛事", kw: /竞赛|大赛|比赛|挑战赛|擂台|赛项|初赛|复赛|决赛|半决赛|选拔/ },
  ];
  const LEVEL_TABLE = [
    { id: "intl", label: "国际", kw: /国际|全球|世界|亚洲|亚太|海外/ },
    { id: "nation", label: "全国", kw: /全国|国家级|国家|中华|中国|教育部|国赛/ },
    { id: "prov", label: "省级", kw: /省级|全省|省赛|省大学生|分赛区|赛区|自治区/ },
    { id: "city", label: "市级", kw: /市级|全市|市赛|地市/ },
    { id: "school", label: "校级", kw: /校级|校赛|校内|本校|校园|学校|学院|我校/ },
  ];
  const FIELD_TABLE = [
    { id: "math", label: "数学建模", kw: /数学|数模|建模|统计|概率|运筹|精算/ },
    { id: "code", label: "程序设计", kw: /程序|编程|算法|软件|计算机|信息|人工智能|网络安全|区块链|开源|物联网|大数据|数据|芯片/ },
    { id: "eng", label: "电子机械", kw: /电子(?!商)|电气|机械|工程|自动化|机器人|航空|航天|能源|材料|建筑|土木|测绘|结构|水利|环境|交通|制造|车辆/ },
    { id: "sci", label: "数理化生", kw: /物理|化学|生物|医药|医学|药学|护理|生命|健康|农业|食品|地理|地质|天文|心理/ },
    { id: "biz", label: "经济管理", kw: /经济|金融|财务|管理|商务|电商|营销|会计|审计|创业|创新|职业|就业|物流|贸易|市场|投资|规划/ },
    { id: "lang", label: "文学外语", kw: /英语|外语|翻译|语文|汉语|文学|写作|演讲|辩论|阅读|诗歌|诗词|哲学|历史|法律|新闻|思政|征文/ },
    { id: "art", label: "设计艺术", kw: /设计|美术|艺术|绘画|书法|摄影|音乐|舞蹈|动漫|影视|传媒|广告|服装|播音|主持|创意|IP形象/ },
    { id: "sport", label: "体育公益", kw: /体育|运动|健身|球|田径|游泳|武术|棋|电竞|志愿|公益|支教|环保|慈善|劳动/ },
  ];
  const AXES = { kind: KIND_TABLE, level: LEVEL_TABLE, field: FIELD_TABLE };
  const AXIS_NAME = { kind: "性质", level: "级别", field: "学科" };
  /** 表内首个命中的 id（表顺序即优先级：越靠前越具体）。命中不了返回空串。 */
  function pick(table, text) {
    const s = String(text == null ? "" : text);
    if (!s) return "";
    for (const row of table) if (row.kw.test(s)) return row.id;
    return "";
  }
  const axisLabel = (axis, id) => ((AXES[axis] || []).find((r) => r.id === id) || {}).label || "";

  // 赛氪的 level_name 直接就是「级别」轴，站点自造的叫法在这里对齐到同一套 id。
  const LEVEL_NATIVE = {
    国际: "intl", 国际级: "intl", 全国性: "nation", 国家级: "nation", 全国: "nation",
    省级: "prov", 省: "prov", 市级: "city", 市: "city", 校级: "school", 校: "school",
    市级赛: "city", 省赛: "prov", 国赛: "nation", 校赛: "school", 区域赛: "prov", 地区赛: "prov",
  };
  // 摩课云的 newsType 是点分复合标签（如 202.204.208）：202 = 平台通知，203 = 赛事动态。
  const hasType = (t, code) => String(t || "").split(".").includes(code);

  /** 一条消息 → 三条轴。站点原生标签（结构化字段 / 站点自己的分类）算硬证据，
      关键词只在标题与摘要里找 —— 认不出就留空，不硬塞「其他」。
      学科优先信标题：站点分类常是「公益大赛」这类伞词，标题里的「文学 / 数模」才具体。 */
  function classify(m) {
    const nat = (m && m.native) || {};
    const text = `${(m && m.title) || ""} ${(m && m.snippet) || ""}`;
    return {
      kind: nat.kind || pick(KIND_TABLE, text) || "",
      level: nat.level || pick(LEVEL_TABLE, text) || "",
      field: pick(FIELD_TABLE, text) || pick(FIELD_TABLE, nat.field) || "",
    };
  }

  const state = {
    custom: [],           // 用户添加的源 [{ id, name, url }]
    sourceId: LEGACY_SRC,
    list: [], page: 1, hasMore: true, fetching: false, fetchedAt: 0, error: null,
    seen: new Set(),
    known: {},            // 源 id -> 上次第 1 页的 id 快照（判「新消息」用）
    // kind / level / field 三条轴各自独立，「all」= 该轴不设限。
    filter: { kw: "", kind: "all", level: "all", field: "all", from: "", to: "", hideSeen: false, auto: false, showCover: false },
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

  /* ── 时间范围（v0.9.0 起取代「月份」chip 那一排）──
     一排绝对月份按钮只能按「月」选，选不了「9 月 10 日到 10 月 8 日」这种跨月区间；月份一多，
     那一排还要占掉筛选面板三行。改成两个原生日期框后：范围任意、面板反而不那么长。
     边界一律按 `YYYY-MM-DD` 字符串比较 —— 列表里的 `time` 就是补零后的同一格式，
     字符串大小序与时间序一致，不必造 Date（也就不会踩时区把 9 月 1 日读成 8 月 31 日）。 */

  /** 日期框的值：空的当「不限」。只认 `YYYY-MM-DD`。 */
  const dateStr = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v == null ? "" : v)) ? String(v) : "");
  const monthStr = (v) => (/^\d{4}-\d{2}$/.test(String(v == null ? "" : v)) ? String(v) : "");

  /** 某月最后一天。旧版存的「月份」筛迁移成日期区间时，上界要落到月底而不是月初。 */
  function monthEnd(mo) {
    const [y, m] = mo.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  }

  /** 一条消息的发布日（只截到「天」）。时间未知返回空串 —— 它只在「不限」时留下。 */
  const dayOf = (m) => String(m.time || "").slice(0, 10);

  /** 生效中的时间范围文案；两侧都没设返回空串。 */
  function rangeText(from, to) {
    if (!from && !to) return "";
    if (from && to) return `${from} ~ ${to}`;
    return from ? `${from} 之后` : `${to} 之前`;
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
        // 站点自己标的性质：202 = 平台通知，203 = 赛事动态，其余交给关键词兜底。
        native: { kind: hasType(t, "203") ? "race" : hasType(t, "202") ? "notice" : "", label: t && t !== "0" ? t : "" },
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
        // level_name 就是级别轴的原生值；time_name（正在报名 / 即将截止）是性质轴的第一手证据。
        native: { level: LEVEL_NATIVE[level] || pick(LEVEL_TABLE, level), kind: pick(KIND_TABLE, String(r.time_name || "")), label: level },
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

  /* ═══════════ 模竞 mojinghub.com（三条通道共用一套 POST 解析） ═══════════

     站点是 React SPA，页面本身没有数据，列表全在 admin.mojinghub.com 的 POST 接口里，
     请求体一律 JSON、`Authorization` 头放裸 token（只有「我的通知」那条通道才需要）。
     两处与其它三家不一样，必须单独记着：

     ① 接口永远回 HTTP 200，真状态在响应体的 `status` 字段里：200 正常，102 token 解析错误，
        103 token 不能为空。所以判失败不能只看 res.status，得看 body.status。
     ② 列表在 `data.data` 里（Laravel 分页器形状），不是 `data.list`；翻页字段是
        `current_page` / `last_page` / `total`。

     ⚠️ 站点自己的 CORS 只放行它自己的域（预检 ACAO 固定回 https://admin.mojinghub.com），
     浏览器里 fetch 必被拦。这里走 tide.http.fetch（Rust 侧 reqwest），不受影响。 */

  /** 解一条模竞接口响应：判 HTTP、判 body.status、取 Laravel 分页器里的数组。 */
  function mojingPayload(res, what) {
    if (!res || res.status !== 200) throw new Error(`模竞${what}接口 HTTP ${res ? res.status : "无响应"}`);
    let d;
    try { d = JSON.parse(String(res.body || "")); } catch { throw new Error(`模竞${what}接口返回的不是 JSON`); }
    if (Number(d.status) !== 200) {
      const msg = clip(String(d.msg || ""), 40);
      throw new Error(msg ? `模竞${what}接口：${msg}` : `模竞${what}接口返回 status=${d.status}`);
    }
    const page = d.data && typeof d.data === "object" ? d.data : {};
    return { rows: Array.isArray(page.data) ? page.data : [], page: Number(page.current_page) || 1, last: Number(page.last_page) || 1 };
  }

  /** 接口给的报名 / 举办时间统一成 Unix 秒。字段实测就是秒级，但毫秒级的也接住。 */
  const secOf = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  };

  /** 竞赛通道：`/api/Competition.Competition/index`。接口只给 Unix 秒，没有现成的可读时间。 */
  async function fetchMojingCompetition(page) {
    const res = await tide.http.fetch(await tide.http.session(), "POST", `${MOJING_API}/api/Competition.Competition/index`,
      { ...MOJING_POST, body: JSON.stringify({ page, limit: PAGE_SIZE }) });
    const { rows, last } = mojingPayload(res, "竞赛");
    const items = rows.map((r) => {
      const signupEnd = secOf(r.signup_end);
      return {
        rawId: String(r.competition_id),
        title: clip(String(r.title || "(无标题)"), 120),
        // 级别轴的原生值就是 wcompetitionlevel.level_name（国家级 / 国际级 / 全国性…），
        // 经 LEVEL_NATIVE 归一到 intl / nation / prov / city / school；认不出的交给关键词兜底。
        native: {
          level: LEVEL_NATIVE[clip(String((r.wcompetitionlevel || {}).level_name || ""), 12)] || "",
          label: clip(String((r.wcompetitionlevel || {}).level_name || ""), 12),
        },
        // 列表时间取创建时间：竞赛是「挂上来」才算进雷达，报名开始日往往还没到。
        time: fmtTs(secOf(r.created_time) || secOf(r.update_time)),
        deadline: fmtTs(signupEnd),
        snippet: stripTags(r.description),
        cover: String(r.cover_image || r.header_img || ""),
        url: `${MOJING_HOME}/${r.competition_id}`,
      };
    });
    return { items, hasMore: rows.length > 0 && page < last && page < MAX_PAGES };
  }

  /** 活动通道：`/api/Events.Events/index`。字段形状与竞赛基本一致，主键是 events_id。 */
  async function fetchMojingEvents(page) {
    const res = await tide.http.fetch(await tide.http.session(), "POST", `${MOJING_API}/api/Events.Events/index`,
      { ...MOJING_POST, body: JSON.stringify({ page, limit: PAGE_SIZE }) });
    const { rows, last } = mojingPayload(res, "活动");
    const items = rows.map((r) => {
      const level = clip(String((r.wEventslevel || {}).level_name || ""), 12);
      return {
        rawId: String(r.events_id),
        title: clip(String(r.title || "(无标题)"), 120),
        native: { level: LEVEL_NATIVE[level] || "", label: level },
        time: fmtTs(secOf(r.created_time) || secOf(r.update_time)),
        deadline: fmtTs(secOf(r.signup_end)),
        snippet: stripTags(r.description) || clip(String(r.organizational_unit || ""), 60),
        cover: String(r.cover_image || r.header_img || ""),
        url: `https://www.mojinghub.com/events/${r.events_id}`,
      };
    });
    return { items, hasMore: rows.length > 0 && page < last && page < MAX_PAGES };
  }

  /** 资讯通道：`/api/Article.Article/index`。`news_channel` 是站点自己的通道标签，
      有 competition 值的都属于某场竞赛（带 competition_id），正好当学科轴的第一手证据。 */
  async function fetchMojingArticle(page) {
    const res = await tide.http.fetch(await tide.http.session(), "POST", `${MOJING_API}/api/Article.Article/index`,
      { ...MOJING_POST, body: JSON.stringify({ page, limit: PAGE_SIZE }) });
    const { rows, last } = mojingPayload(res, "资讯");
    const items = rows.map((r) => ({
      rawId: String(r.article_id),
      title: clip(String(r.title || "(无标题)"), 120),
      native: { kind: pick(KIND_TABLE, String(r.title || "")), label: clip(String(r.news_channel || ""), 12) },
      time: fmtTs(secOf(r.published_at) || secOf(r.create_time)),
      snippet: stripTags(r.description || r.content),
      cover: String(r.cover || ""),
      url: `https://www.mojinghub.com/news/${r.article_id}`,
    }));
    return { items, hasMore: rows.length > 0 && page < last && page < MAX_PAGES };
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
        // 站点的「分类」只作学科轴的兜底证据（「公益大赛」这种伞词认不出学科就留空）
        native: { field: cat, label: cat },
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
      // 模竞三条通道各占一个「源」：它们的差分快照、已读、筛选互不干扰（id 前缀天然隔离），
      // 界面上也就和另外三家排在同一排里，切换成本与切站点一样。
      { id: "mojing-comp", name: "模竞竞赛", home: MOJING_HOME, fetch: fetchMojingCompetition, pages: true },
      { id: "mojing-events", name: "模竞活动", home: "https://www.mojinghub.com/events", fetch: fetchMojingEvents, pages: true },
      { id: "mojing-news", name: "模竞资讯", home: "https://www.mojinghub.com/news", fetch: fetchMojingArticle, pages: true },
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
     读回来必须先归一遍，否则界面上一个 chip 都没高亮却仍在过滤（用户只看到「显示 0 条」）。 */
  function sanitizeFilter(raw) {
    const f = { ...state.filter, ...(raw && typeof raw === "object" ? raw : {}) };
    f.kw = String(f.kw || "");
    // 旧版只有一个 `type` 字段、三种语义混着：n202/n203 是性质、lv:xx 是级别、cat:xx 是学科。
    // 这里按语义拆到三条轴上，老设备升级后原来选的那一项还亮着。
    const old = String(f.type == null ? "" : f.type);
    if (old && old !== "all") {
      if (old === "202" || old === "n202") f.kind = "notice";
      else if (old === "203" || old === "n203") f.kind = "race";
      else if (/^lv:/.test(old)) f.level = LEVEL_NATIVE[old.slice(3)] || pick(LEVEL_TABLE, old.slice(3)) || "all";
      else if (/^cat:/.test(old)) f.field = pick(FIELD_TABLE, old.slice(4)) || "all";
    }
    delete f.type;
    // 三条轴各只认自己表里的 id：连旧版一起，任何写坏的值都不会变成「静默过滤」。
    for (const axis of ["kind", "level", "field"]) {
      if (f[axis] !== "all" && !AXES[axis].some((r) => r.id === f[axis])) f[axis] = "all";
    }
    /* 时间范围：只认补零的 `YYYY-MM-DD`（原生日期框给的就是这个形状）。
       旧版的「月份」筛选（`month: "2026-09"`）就地迁成月初→月末的区间 —— 老设备升级后
       原来选的那一个月还生效，不用用户再点一次；写坏的值一律作废，绝不静默过滤。 */
    const legacyMonth = monthStr(f.month);
    delete f.month;
    f.from = dateStr(f.from);
    f.to = dateStr(f.to);
    if (legacyMonth && !f.from && !f.to) {
      f.from = `${legacyMonth}-01`;
      f.to = `${legacyMonth}-${pad2(monthEnd(legacyMonth))}`;
    }
    // 两端都填了却反着（先点「至」再点「从」）就交换：区间永远读得出「起 → 止」。
    if (f.from && f.to && f.from > f.to) { const t = f.from; f.from = f.to; f.to = t; }
    f.hideSeen = !!f.hideSeen;
    f.showCover = !!f.showCover;
    return f;
  }

  /** 旧版本只有一家的裸 id（`123`）⇒ 补上摩课云前缀，老设备的已读记录才不会整批复活成 NEW。 */
  const legacyId = (x) => { const s = String(x); return s.includes(":") ? s : `${LEGACY_SRC}:${s}`; };

  async function loadPrefs() {
    const rawFilter = await tide.storage.get("filter", null);
    state.filter = sanitizeFilter(rawFilter);
    /* 老键（旧 `month` / 更旧的 `type`）在内存里已经被用掉了，就顺手落盘一次：
       否则原始值一直躺在 data.json 里，每次进视图都会被重新迁回来 —— 用户明明点过
       「✕ 不限」，下次打开又冒出同一段范围，只清内存不落盘就是这种反复。 */
    if (rawFilter && typeof rawFilter === "object" && (rawFilter.month !== undefined || rawFilter.type !== undefined)) savePrefs();
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
    for (const axis of ["kind", "level", "field"]) {
      const v = state.filter[axis];
      if (v !== "all") out.push(`${AXIS_NAME[axis]}「${axisLabel(axis, v)}」`);
    }
    if (state.filter.from || state.filter.to) out.push(`时间「${rangeText(state.filter.from, state.filter.to)}」`);
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

  /* 刷新等待蒙版（v0.233.0）：抓消息是网络往返，几秒；期间只有状态行在动。
     包一层而不是在函数体里 release —— 里面有三条 return（切源 / 抛错各一条），散点必漏。
     老宿主没有 tide.ui.waitMask 时退化成空操作。 */
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});
  function fetchList(page = 1) {
    if (state.fetching) return Promise.resolve();
    const releaseWait = waitMask("正在抓取消息…");
    return fetchListInner(page).finally(releaseWait);
  }

  async function fetchListInner(page = 1) {
    if (state.fetching) return;
    const src = currentSource();
    const seq = ++fetchSeq;
    state.fetching = true;
    paintStatus();
    try {
      const { items, hasMore } = await src.fetch(page);
      if (seq !== fetchSeq) return;   // 抓取期间切了源：结果丢掉，别把上一家的条目混进这一家
      // 分类统一在入口归一：适配器只管交「原生标签」，三条轴由同一套跨源词表算出来。
      const fresh = items.map((m) => ({ ...m, ...classify(m), id: `${src.id}:${m.rawId}`, srcId: src.id }));
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
        // 时间范围是绝对值：跨月 / 跨年之后本次抓取里一条都落不进它，界面却会「日期框里明明写着
        // 9 月」地继续过滤（旧版的绝对月份就在这儿把「拉取 40 条 · 显示 0 条」变成假故障）。
        // 抓完第 1 页先看有没有一条落在范围里，一条都没有就静默清空并落盘 —— 面板上日期框会一起变空，
        // 所以不存在「看不出在过滤」的状态。只要还剩一条命中就原样保留，不抹用户的选择。
        const from = state.filter.from, to = state.filter.to;
        if ((from || to) && !state.list.some((m) => {
          const d = dayOf(m);
          return d && (!from || d >= from) && (!to || d <= to);
        })) {
          state.filter.from = "";
          state.filter.to = "";
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
    const from = dateStr(state.filter.from), to = dateStr(state.filter.to);
    const rows = state.list.filter((m) => {
      // 三条轴是「与」关系：性质+级别+学科可以叠加，比如「报名 × 全国 × 数学建模」。
      for (const axis of ["kind", "level", "field"]) {
        const want = state.filter[axis];
        if (want !== "all" && (m[axis] || "") !== want) return false;
      }
      // 时间范围同样是「与」：起止任意一侧可空。补零格式下字符串比较 = 时间比较。
      const day = dayOf(m);
      if (from || to) {
        if (!day) return false;                                    // 时间未知的条目只在「不限」时留下
        if (from && day < from) return false;
        if (to && day > to) return false;
      }
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
      /* 搜索框只留一颗放大镜（用户要求「删除所有搜索框内的中文，仅保留搜索图标」） */
      .gx-kwbox{position:relative;display:flex;align-items:center;flex:1;min-width:170px}
      .gx-kwbox>.gx-kw{flex:1 1 auto;min-width:0;padding-left:32px}
      .gx-kw-ico{position:absolute;left:11px;width:14px;height:14px;display:inline-flex;color:#7E8B94;pointer-events:none}
      .gx-kw-ico svg{width:100%;height:100%;display:block}
      .gx-kw{flex:1;min-width:170px;height:34px;border:1px solid #E4DFD6;border-radius:9px;padding:0 11px;background:#fff}
      .gx-chip{font-size:calc(12px * var(--ui-text-scale));border:1px solid #E4DFD6;background:#fff;border-radius:16px;padding:6px 13px;cursor:pointer;color:#7E8B94}
      .gx-chip.on{background:#0F4C5C;color:#fff;border-color:#0F4C5C}
      .gx-chip.add{border-style:dashed;color:#0F4C5C}
      /* ── 时间范围（v0.9.0 取代「月份」那一排 chip）──
         两个原生日期框：范围任意、可跨月，面板也不再被十几个月挤成三行。
         配色沿用本插件其余控件的写法（与 .gx-chip / .gx-kw 同一套浅色值），
         这样面板在浅色与深色下都是同一种质感，不出现「只有这两个框不一样」。 */
      .gx-range{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1;min-width:0}
      .gx-date{display:inline-flex;align-items:center;gap:6px;font-size:calc(11px * var(--ui-text-scale));color:#7E8B94}
      .gx-date>span{flex:none}
      .gx-date input[type="date"]{height:32px;padding:0 9px;border:1px solid #E4DFD6;border-radius:9px;background:#fff;color:#22303A;font-size:calc(12px * var(--ui-text-scale));font-family:inherit}
      .gx-date input[type="date"]:focus{outline:none;border-color:#0F4C5C;box-shadow:0 0 0 2px rgba(15,76,92,.16)}
      .gx-range-tilde{color:#A9B2BA;flex:none}
      .gx-range-clear{font-size:calc(11px * var(--ui-text-scale));padding:5px 10px;border:1px dashed #CFC8BA;border-radius:16px;background:#fff;color:#0F4C5C;cursor:pointer;flex:none}
      .gx-range-clear:hover:not(:disabled){background:#EFEAE1}
      .gx-range-clear:disabled{opacity:.45;cursor:default}
      /* 生效中的范围说清「命中了多少条」；没设时退成灰色提示，不抢 chip 的注意力。 */
      .gx-range-cap{font-size:calc(10.5px * var(--ui-text-scale));color:#7E8B94;margin-left:auto;transition:color .16s ease}
      .gx-range-cap.on{color:#0F4C5C;font-weight:600}
      .gx-link{font-size:calc(11.5px * var(--ui-text-scale));color:#7E8B94;cursor:pointer;background:none;border:none;text-decoration:underline;text-underline-offset:3px}
      .gx-link:hover{color:#0F4C5C}
      .gx-toggle{display:flex;align-items:center;gap:6px;font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;cursor:pointer;user-select:none}
      .gx-toggle i{width:34px;height:19px;border-radius:10px;background:#D8D2C6;display:inline-block;position:relative;transition:.15s}
      .gx-toggle i::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:.15s}
      .gx-toggle.on i{background:var(--deep,#0F4C5C)}.gx-toggle.on i::after{background:var(--on-deep,#fff)}
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
      /* 三枚 tag 就是三条轴上的值：学科（默认蓝）、性质（.k-*）、级别（.lv 灰）。
         性质是这张列表里唯一「要动起来」的信号（报名 / 截止），所以按性质分色。 */
      .gx-tag{border-radius:6px;padding:2px 8px;background:#E1EEF3;color:#0F4C5C;font-size:calc(10px * var(--ui-text-scale))}
      .gx-tag.k{background:#EFE7FB;color:#6C3FB8}
      .gx-tag.k-signup{background:#E4F5EC;color:#1F7A4C}
      .gx-tag.k-result{background:#FDF0E2;color:#9A5B12}
      .gx-tag.k-train{background:#EAF1FB;color:#2B5FA8}
      .gx-tag.lv{background:#F1EFE9;color:#5C6670}
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

  /** 时间范围那一行：日期框的值永远从 state 里回写（切源 / 一键清除 / 自愈都会改它）。
      正在敲的那个框不回写 —— 用户打到一半的 `2026-1` 被覆盖掉是很烦的事。 */
  function paintDateRange() {
    if (!ui || !ui.dateRange) return;
    const { from, to, clear, cap } = ui.dateRange;
    const f = state.filter.from || "", t = state.filter.to || "";
    if (!(document.activeElement && document.activeElement === from)) from.value = f;
    if (!(document.activeElement && document.activeElement === to)) to.value = t;
    clear.disabled = !f && !t;
    cap.textContent = rangeText(f, t)
      ? `发布日在 ${rangeText(f, t)} 里，命中 ${filtered().length} 条`
      : "按发布日筛，两端都含当天；留空即不限";
    cap.classList.toggle("on", !!(f || t));
  }

  /** 提交一次时间范围：只认 `YYYY-MM-DD`，两端填反了就交换，一侧填了一侧空也允许。 */
  function commitRange() {
    if (!ui || !ui.dateRange) return;
    state.filter.from = dateStr(ui.dateRange.from.value);
    state.filter.to = dateStr(ui.dateRange.to.value);
    if (state.filter.from && state.filter.to && state.filter.from > state.filter.to) {
      const t = state.filter.from;
      state.filter.from = state.filter.to;
      state.filter.to = t;
    }
    savePrefs();
    paintChips();
    paintList(true);
  }

  function clearRange() {
    if (!state.filter.from && !state.filter.to) return;
    state.filter.from = "";
    state.filter.to = "";
    savePrefs();
    paintChips();
    paintList(true);
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

  /** 某条轴的 chip：只列「当前列表里真出现过」的值，顺序永远按表走（不跟抓取结果的先后漂移）；
      正在生效、但这一批里已命不中的那个也留在台面上，否则就是「一个都没高亮却仍在过滤」的老坑。 */
  function axisChips(axis) {
    const seen = new Set(state.list.map((m) => m[axis] || "").filter(Boolean));
    return AXES[axis].filter((r) => seen.has(r.id) || state.filter[axis] === r.id)
      .map((r) => ({ id: r.id, label: r.label }));
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

    // 一条轴只有一个可选值（或一个都没有）、又没在过滤时，这一行没有信息量，整行收掉
    // —— 旧版的「其他」桶就是靠「永远至少有一项」把这个收行机会吃掉的。
    for (const axis of ["kind", "level", "field"]) {
      const opts = axisChips(axis);
      const box = ui.axes[axis];
      box.row.style.display = opts.length < 2 && state.filter[axis] === "all" ? "none" : "flex";
      chipRow(box.chips, [{ id: "all", label: "全部" }, ...opts], state.filter[axis],
        (id) => { state.filter[axis] = id; savePrefs(); paintChips(); paintList(true); });
    }

    // 时间范围交给日期框那一行（不再是一排绝对月份 chip）
    paintDateRange();

    const axesOn = ["kind", "level", "field"].some((a) => state.filter[a] !== "all");
    const timeOn = !!(state.filter.from || state.filter.to);
    ui.filterSummary.textContent = `筛选${axesOn || timeOn || state.filter.hideSeen ? " · 已设置" : ""}`;

    ui.hideSeen.classList.toggle("on", !!state.filter.hideSeen);
    ui.showCover.classList.toggle("on", !!state.filter.showCover);
    ui.auto.classList.toggle("on", !!state.filter.auto);
  }

  /** 卡片上最多三枚标签 = 三条轴各自的取值（性质 / 级别 / 学科），缺的轴不占位。
      站点自己标的那行原生分类（如「公益大赛」）挂到 meta 的 title 上：不占视觉，但不丢信息。 */
  function axisTags(m) {
    const out = [];
    if (m.kind) out.push(`<span class="gx-tag k k-${esc(m.kind)}">${esc(axisLabel("kind", m.kind))}</span>`);
    if (m.level) out.push(`<span class="gx-tag lv">${esc(axisLabel("level", m.level))}</span>`);
    if (m.field) out.push(`<span class="gx-tag">${esc(axisLabel("field", m.field))}</span>`);
    return out.join("");
  }

  function cardHtml(m) {
    const isNew = !state.seen.has(m.id);
    const natLabel = (m.native && m.native.label) || "";
    const natTip = natLabel ? ` title="${esc(`站点分类：${natLabel}`)}"` : "";
    return `<div class="gx-card${isNew ? "" : " seen"}" data-id="${esc(m.id)}">
      ${state.filter.showCover && m.cover ? `<img class="gx-cover" loading="lazy" decoding="async" fetchpriority="low" src="${esc(coverSmall(m.cover))}" data-orig="${esc(m.cover)}" onerror="if(this.dataset.retried){this.style.display='none'}else{this.dataset.retried=1;this.src=this.dataset.orig}">` : ""}
      <div class="gx-main">
        <div class="gx-title">${esc(m.title)}</div>
        <div class="gx-meta"${natTip}>
          ${axisTags(m)}
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

  /** 换源：清掉上一家的结果，再抓第一页。
      分类三条轴与关键词、只看未读一律保留 —— 归一之后它们是同一套跨源通用词表，
      「报名 × 全国」这种组合换了源照样成立；时间范围是绝对值、只在这一家的数据里成立，清掉。
      保留的轴若在新源里命不中，chip 会把它留在台面上并高亮、空态也会列出来加一键清除，
      所以不会出现「一个都没高亮却仍在过滤」。 */
  function setSource(id) {
    if (state.sourceId === id) return;
    state.sourceId = id;
    state.filter.from = "";
    state.filter.to = "";
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
      // 分类轴同理保留（跨源词表），只有绝对月份要清。
      state.sourceId = LEGACY_SRC;
      state.filter.from = "";
      state.filter.to = "";
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
      // 认得出的条目比内置适配器少、也拿不到站点的原生分类，用户以为「加了两次更好」其实更差。
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
      <div class="gx-toolbar"><button class="gx-link" data-home>打开源站 ↗</button></div>
      <div class="gx-toolbar">
        <button class="gx-refresh">刷新</button>
        <span class="gx-kwbox"><span class="gx-kw-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span><input class="gx-kw" type="text" aria-label="关键词过滤：如 答辩 / 数学 / 报名 / 截止" title="关键词过滤：如 答辩 / 数学 / 报名 / 截止" placeholder=""></span>
        <label class="gx-toggle show-cover"><i></i>封面图</label>
        <label class="gx-toggle auto"><i></i>每 10 分钟自动刷新</label>
      </div>
      <details class="plugin-filter-menu"><summary data-filter-summary>筛选</summary><div class="plugin-filter-menu-panel">
        <div class="gx-toolbar"><span class="gx-lab">源</span><div class="gx-chips" data-sources></div></div>
        <div class="gx-toolbar" data-axis-bar="kind"><span class="gx-lab">性质</span><div class="gx-chips" data-axis-chips="kind"></div></div>
        <div class="gx-toolbar" data-axis-bar="level"><span class="gx-lab">级别</span><div class="gx-chips" data-axis-chips="level"></div></div>
        <div class="gx-toolbar" data-axis-bar="field"><span class="gx-lab">学科</span><div class="gx-chips" data-axis-chips="field"></div></div>
        <div class="gx-toolbar gx-toolbar-range"><span class="gx-lab">时间</span>
          <div class="gx-range">
            <label class="gx-date"><span>从</span><input type="date" data-range-from aria-label="起始日期（含当天）" title="起始日期（含当天），留空表示不限"></label>
            <span class="gx-range-tilde">~</span>
            <label class="gx-date"><span>至</span><input type="date" data-range-to aria-label="结束日期（含当天）" title="结束日期（含当天），留空表示不限"></label>
            <button class="gx-range-clear" data-range-clear type="button" title="清空时间范围">✕ 不限</button>
            <span class="gx-range-cap" data-range-cap>按发布日筛，两端都含当天；留空即不限</span>
          </div>
        </div>
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
      axes: {
        kind: { row: wrap.querySelector('[data-axis-bar="kind"]'), chips: wrap.querySelector('[data-axis-chips="kind"]') },
        level: { row: wrap.querySelector('[data-axis-bar="level"]'), chips: wrap.querySelector('[data-axis-chips="level"]') },
        field: { row: wrap.querySelector('[data-axis-bar="field"]'), chips: wrap.querySelector('[data-axis-chips="field"]') },
      },
      dateRange: {
        from: wrap.querySelector("[data-range-from]"),
        to: wrap.querySelector("[data-range-to]"),
        clear: wrap.querySelector("[data-range-clear]"),
        cap: wrap.querySelector("[data-range-cap]"),
      },
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

    /* 时间范围：`change`（原生日期框选完 / 键盘改完失焦）才提交并落盘，
       `input` 只用来实时回显「命中 N 条」——每敲一个字符就重排列表会很跳。 */
    const rangeInputs = [ui.dateRange.from, ui.dateRange.to];
    for (const input of rangeInputs) {
      input.addEventListener("change", commitRange);
      input.addEventListener("input", () => {
        const f = dateStr(ui.dateRange.from.value), t = dateStr(ui.dateRange.to.value);
        ui.dateRange.cap.textContent = rangeText(f, t)
          ? `发布日在 ${rangeText(f, t)} 里，命中 ${filtered().length} 条`
          : "按发布日筛，两端都含当天；留空即不限";
      });
      // 宿主与插件都用键盘快捷键，输入框里的回车 / 空格 / Esc 不能冒泡出去
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") commitRange(); e.stopPropagation(); });
    }
    ui.dateRange.clear.addEventListener("click", clearRange);

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
        state.filter = { ...state.filter, kw: "", kind: "all", level: "all", field: "all", from: "", to: "", hideSeen: false };
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
