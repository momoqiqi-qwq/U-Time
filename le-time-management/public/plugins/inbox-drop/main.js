// 拖入消息收纳 —— 内置插件：把散落各处的消息（聊天文字 / 通知截图 / 网页段落 / 文件）
// 拖到面板上就收好，自动识别来源平台、消息类型与日期时间，确认后进应用收件箱。
//
// 四个建模决定（改之前先读）：
//   · **解析与收发分离**：`analyze()` / `accepts()` / `sniffBytes()` 是纯函数，不碰 DOM、
//     不碰 tide。所有「认得出什么、收不收」的判断都在这里，才能被测试真跑而不是对着源码猜。
//   · **先收后处理（inbox 语义）**：拖进来默认只把它「接住」，不自动建任务 —— 消息大半是
//     半成品，当场解析成时间块只会弄脏日程。要动手时在条上点「建任务 / 排时间块」。
//   · **不接收可执行文件**：`.exe/.bat/.ps1/...` 一律**明确拒绝并说明原因**，而不是静默忽略。
//     「拖了没反应」比「拖了告诉你为什么不收」糟糕得多。二进制嗅探在 acceptDrop 里真做
//     （PE 的 "MZ"、脚本的 shebang），扩展名只是第一道。
//   · **去重比入库优先**：`sameMessage()` 是纯函数，同一句话重复拖两次只留一条 ——
//     拖放这个动作太容易手滑重复，去重是刚需而不是锦上添花。
//
// 存储（`inbox-drop` 命名空间）：
//   drops : [{ id, createdAt, kind, title, raw, platform, msgType, date, time,
//              source, at, fileSize, mime, bin, tags, pinned }]
//   stats : { total, byKind, byType, byPlatform, lastAt }
//   seq   : 收纳序号（给条目的编号用，重排后不会跳号）
// 宿主收件箱里另有一份（走 tide.inbox.create），本插件的 `drops` 是**可复核的原文台账**：
// 收件箱只留标题与摘要，原文与附件在插件里才找得回来。
//
// ⚠️ 两个容易踩的坑：
//   ① 拖放的 `dragover` **必须** preventDefault，否则浏览器不认这是可放置目标，
//      `drop` 根本不会触发（表现为「拖上去光标不变、松手没反应」）。
//   ② dragenter/dragleave 会**逐个子元素冒泡**，进了子节点就触发一次 leave。
//      用「深度计数」而不是布尔量，否则鼠标划过任意子元素就闪一下。
(function () {
  const VIEW_ID = "inbox-drop";
  const KEEP_MAX = 300;              // 台账上限：超了从头丢，防止病态数据把存储撑爆
  const RAW_MAX = 2000;              // 单条原文截断长度
  const TITLE_MAX = 80;              // 标题长度
  const NOTE_MAX = 160;              // 递进收件箱时的摘要长度
  const DUP_WINDOW_MS = 86400000;    // 去重只看最近一天，隔天同句话算新消息
  const CHECK_LIMIT = 8;             // acceptDrop 单次最多收几个文件
  const BIN_LIMIT = 400 * 1024;      // 大于这个体积的文件不收（message 文本用不着）
  const IMG_SIDE = 900;              // 截图压缩后的最长边

  const KINDS = {
    text:  { label: "文字", icon: "font",          hint: "聊天文字 / 网页段落" },
    image: { label: "截图", icon: "image",         hint: "通知截图 / 聊天图片" },
    file:  { label: "文本文件", icon: "file-lines", hint: "txt / md / csv / json / srt" },
    other: { label: "文件", icon: "paperclip",     hint: "其他文件，仅登记名称" },
  };
  const DROP_KINDS = ["text", "image", "file", "other"];

  // 平台与消息类型。顺序即优先级：先命中先用 ——
  // 「学习通 考试通知」要先认学校平台再认类型，否则会被通用关键词抢走。
  const PLATFORMS = [
    { id: "wechat",     label: "微信",     re: /微信|WeChat|群聊|公众号|聊天记录|订阅号/i },
    { id: "qq",         label: "QQ",       re: /\bQQ\b|腾讯QQ|群消息/i },
    { id: "chaoxing",   label: "学习通",   re: /学习通|超星|智慧树|尔雅/i },
    { id: "dingtalk",   label: "钉钉",     re: /钉钉|DingTalk/i },
    { id: "wecom",      label: "企业微信", re: /企业微信|WeCom/i },
    { id: "feishu",     label: "飞书",     re: /飞书|Lark/i },
    { id: "lark-mail",  label: "邮件",     re: /@(?:qq|163|126|outlook|gmail|foxmail)\.com|发件人|收件人|主题[:：]/i },
    { id: "school",     label: "学校门户", re: /教务处|教务系统|学工|一网通办|研究生院|学院通知|教务处通知/i },
    { id: "portal",     label: "校内门户", re: /门户|通知公告|信息公开/i },
    { id: "sms",        label: "短信",     re: /【.{2,12}】|短信|验证码\d|退订回复/i },
  ];
  const MSG_TYPES = [
    { id: "exam",     label: "考试",   quad: 1, cat: "study",  re: /考试|考场|补考|缓考|准考证|考级|机考|笔试/i },
    { id: "hw",       label: "作业",   quad: 1, cat: "study",  re: /作业|习题|实验报告|论文|提交|上传附件|小测|随堂/i },
    { id: "signin",   label: "签到",   quad: 2, cat: "study",  re: /签到|打卡|上课码|手势签到|位置签到/i },
    { id: "meeting",  label: "会议",   quad: 2, cat: "work",   re: /会议|例会|组会|答辩|研讨会|腾讯会议|钉钉会议/i },
    { id: "activity", label: "活动",   quad: 3, cat: "life",   re: /活动|讲座|报名|招募|社团|志愿者|比赛|竞赛/i },
    { id: "fee",      label: "缴费",   quad: 2, cat: "life",   re: /缴费|缴费|充值|账单|水电|宿费|报名费|付款/i },
    { id: "notify",   label: "通知",   quad: 3, cat: "work",   re: /通知|公告|提醒|须知|安排|公示/i },
    { id: "deadline", label: "截止",   quad: 1, cat: "work",   re: /截止|最终期限|务必于|过期不候|最后期限/i },
    { id: "chat",     label: "闲聊",   quad: 4, cat: "life",   re: /哈哈|在吗|收到|好的|晚安|谢谢|表情/i },
  ];
  const TYPE_LABEL = Object.fromEntries(MSG_TYPES.map((t) => [t.id, t.label]));

  // 明确拒绝的扩展名。**不是**「不认识就不收」—— 那会把用户正常的东西挡在外面；
  // 这里只钉死可执行 / 脚本 / 快捷方式这几类，其余都收（未知类型走 kind:'other'）。
  const REJECT_EXT = new Set([
    "exe", "msi", "bat", "cmd", "com", "scr", "pif", "cpl", "dll", "sys", "drv",
    "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "jar", "sh", "bash",
    "lnk", "url", "reg", "apk", "dmg", "app", "run", "bin", "iso", "img",
  ]);
  const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "srt", "vtt", "yaml", "yml", "ini"]);
  const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "avif", "svg"]);

  const state = {
    drops: [],          // 台账（新在前）
    stats: { total: 0, byKind: {}, byType: {}, byPlatform: {}, lastAt: 0 },
    seq: 0,
    activeKind: "all",  // 当前筛选
    pending: null,      // 正在编辑的确认条
    busy: false,
  };
  let root = null;
  let MY_GEN = 0;
  let dragDepth = 0;
  // 展开着的「原文」行 id：宿主会因 store 订阅在背后重绘插件视图（switchTo(activeView, history:false)），
  // 不记的话用户正展开看着的原文会被一次无关重绘悄悄收起。
  const foldOpen = new Set();

  /* ── 助手 ── */
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const faIcon = (name) => `<svg class="id-ico" viewBox="0 0 512 512" aria-hidden="true"><use href="/icons/fontawesome/solid.svg#${name}"></use></svg>`;
  /** 二次确认。宿主把插件跑在主窗口里（`new Function("tide", …)`），window.confirm 可用；
      单测沙箱里没有 window，退回「允许」—— 那种环境没有用户点得到。 */
  const confirmFn = (msg) => {
    try {
      if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(msg);
    } catch { /* 忽略：确认框本身不该把清空流程卡死 */ }
    return true;
  };
  const extOf = (name) => (String(name || "").match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
  const baseName = (name) => String(name || "").replace(/\.[A-Za-z0-9]+$/, "");
  /** 本地日期 "YYYY-MM-DD"。不能用 toISOString()：那是 UTC，东八区晚上 8 点后会算成前一天。 */
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const relTime = (ts) => {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  };

  /* ══════════════════════════════════════════════════════════════════
     纯逻辑区：不碰 DOM、不碰 tide，测试直接真跑
     ══════════════════════════════════════════════════════════════════ */

  /* ── 一、门卫：这个拖进来的东西收不收 ── */
  /** 数据格式白名单。截图有 Files 与 text/uri-list 两种拖法，都要认。 */
  function wants(dt) {
    const types = Array.isArray(dt && dt.types) ? dt.types : [];
    return types.some((t) => t === "Files" || t === "text/plain" || t === "text/uri-list" || t === "text/html");
  }
  /** 二进制嗅探：扩展名是第一道，但改名成 .txt 的 exe 骗不过它。
      只看头部几个字节 —— message 文本用不着全读。 */
  function sniffBytes(bytes) {
    if (!bytes || !bytes.length) return "empty";
    const at = (i) => bytes[i] || 0;
    if (at(0) === 0x4d && at(1) === 0x5a) return "pe";                       // MZ：PE / DOS 可执行
    if (at(0) === 0x7f && at(1) === 0x45 && at(2) === 0x4c && at(3) === 0x46) return "elf";
    if (at(0) === 0xca && at(1) === 0xfe) return "macho";                    // Mach-O 胖二进制
    if (at(0) === 0xcf && at(1) === 0xfa) return "macho";
    if (at(0) === 0x23 && at(1) === 0x21) return "shebang";                  // #! 脚本
    return "text";
  }
  /** 文本 / data URL 判定。data URL 只认一层，防 base64 里嵌套再嵌套。 */
  function isDataUrl(s) { return /^data:([\w.+-]+\/[\w.+-]+)?;base64,[A-Za-z0-9+/=\s]+$/.test(String(s || "").slice(0, 4096)); }
  function isBinary(dataUrl) {
    const m = /^data:([^;,]+)/.exec(String(dataUrl || ""));
    const mime = m ? m[1] : "";
    return !(mime.startsWith("image/") || mime === "application/pdf");
  }
  /** 单个文件的准入判定。返回 `{ok, kind, mime, reason}` —— **永远给得出理由**，
      调用方据此决定「收下」还是「弹一句为什么没收」。 */
  function accepts(file) {
    const name = String((file && file.name) || "");
    const ext = extOf(name);
    const type = String((file && file.type) || "");
    const size = Number((file && file.size) || 0);
    if (REJECT_EXT.has(ext)) return { ok: false, reason: `为了安全，不接收 .${ext} 这类可执行 / 脚本文件` };
    if (size > BIN_LIMIT) return { ok: false, reason: `文件超过 ${Math.round(BIN_LIMIT / 1024)} KB，收纳区只放消息文本` };
    if (type.startsWith("image/") || IMAGE_EXT.has(ext)) return { ok: true, kind: "image", mime: type || `image/${ext || "png"}` };
    if (type.startsWith("text/") || TEXT_EXT.has(ext)) return { ok: true, kind: "file", mime: type || "text/plain" };
    if (!ext) return { ok: true, kind: "other", mime: type };
    return { ok: true, kind: "other", mime: type };
  }

  /* ── 二、解析：这段文本是什么消息、什么时候 ── */
  /** 猜平台。命中多个时取**最靠前**的（数组顺序即优先级）。 */
  function detectPlatform(text) {
    const s = String(text || "");
    for (const p of PLATFORMS) if (p.re.test(s)) return p.id;
    return "";
  }
  /** 猜消息类型。同时命中时同样取最靠前的 ——
      「考试」排在「通知」前面，因为「关于期末考试的通知」该归考试而不是通知。 */
  function detectType(text) {
    const s = String(text || "");
    for (const t of MSG_TYPES) if (t.re.test(s)) return t.id;
    return "";
  }
  /** 从 URL 抠域名当来源名。比整条 URL 短得多，列表里看得清。 */
  function hostOf(source) {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(source || ""));
    return m ? m[1].replace(/^www\./, "") : "";
  }
  /** 从「【某某】」里抠来源名（短信 / 推送的常见样式）。
      与小程序端 idSourceOf 同一规则 —— 同一条消息在两端要认出同一个来源。 */
  function bracketSource(text) {
    const m = /【([^】]{2,16})】/.exec(String(text || ""));
    return m ? m[1] : "";
  }
  /** 主解析：一段文本 → 结构化消息。`parseWhen` 由宿主注入（权限 timeParse）。 */
  function analyze(input) {
    const opts = Object.assign({ kind: "text", parseWhen: null, now: null, source: "", raw: "" }, input || {});
    const kind = DROP_KINDS.includes(opts.kind) ? opts.kind : "text";
    const raw = String(opts.raw || opts.title || "").slice(0, RAW_MAX);
    const now = opts.now instanceof Date ? opts.now : new Date();
    const today = localDate(now);

    // 时间：优先交给宿主的 parseWhen（它能处理「下周三」「明天下午三点」这类自然语言），
    // 失败再退回自己的正则 —— 单独依赖任何一方都会在对方的盲区上栽跟头。
    let parsed = null;
    if (opts.parseWhen) {
      try { parsed = opts.parseWhen(raw); } catch { parsed = null; }
    }
    let date = parsed && parsed.date ? String(parsed.date) : "";
    let time = parsed && Number.isFinite(parsed.startMin) ? hhmm(parsed.startMin) : "";
    let title = parsed && parsed.title ? String(parsed.title).trim() : "";

    if (!date) {
      const d = matchDate(raw, now);
      if (d) date = d;
    }
    if (!time) {
      const t = matchTime(raw);
      if (t) time = t;
    }
    if (!title) title = (parsed && parsed.title ? String(parsed.title) : raw).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

    let platform = detectPlatform(raw);
    let msgType = detectType(raw);
    // 文件名本身也是线索：拖进来的「期末考试安排.txt」该被认成考试。
    if (kind !== "text" && opts.title) {
      if (!msgType) msgType = detectType(opts.title);
      if (!platform) platform = detectPlatform(opts.title);
    }
    // 文本还是认不出类型时，看它像不像一句话：短、无标点 → 闲聊；长 → 通知。
    if (!msgType && kind === "text") msgType = raw.length <= 24 && !/[。；;：:]/.test(raw) ? "chat" : "notify";

    const source = String(opts.source || bracketSource(raw) || hostOf(raw) || "");
    return {
      kind, title: title.slice(0, TITLE_MAX), raw,
      platform, msgType, date, time, source,
      at: now.getTime(),
      sourceKey: `${platform}|${msgType}|${date}|${time}|${title}`,
    };
  }
  /** 时间转 HH:MM。越界一律返回空串（宁可没时间，也不要一个假的 25:99）。 */
  function hhmm(min) {
    const n = Number(min);
    if (!Number.isFinite(n) || n < 0 || n >= 1440) return "";
    return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  }
  /** 自有日期识别。宿主 parseWhen 在中英混排、压缩格式上会漏，这里补上：
      "9/20"、"2026-09-20"、"9月20日"、以及明后天这种相对词。 */
  function matchDate(text, now) {
    const s = String(text || "");
    const y = now.getFullYear();
    if (/今天|今日/.test(s)) return localDate(now);
    if (/明天|明日/.test(s)) return localDate(new Date(now.getTime() + 86400000));
    if (/后天/.test(s)) return localDate(new Date(now.getTime() + 2 * 86400000));
    let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    m = /(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/.exec(s);
    if (m) {
      const mo = Number(m[1]);
      const d = Number(m[2]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        // 没写年份时按「就近未来」解释：已经过去超过半年的，算明年。
        let year = y;
        const cand = new Date(year, mo - 1, d);
        if (cand.getTime() - now.getTime() < -183 * 86400000) year += 1;
        return `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    return "";
  }
  /** 从文本里认时刻。数字与中文数字都认（「23:59」「下午3点」「下午三点」「晚上十点半」）——
      中文写法在真实消息里比 24 小时制常见，认不出比认错好，但常见写法不该漏。
      **必须校验范围**（时 0-23、分 0-59）：`25:99` 这种错值一旦写进 dueTime，
      宿主的提醒会静默失效，比不填更糟。上下午标记只取紧挨着的那一个，
      不扫全句 —— 「上午发的文件，下午3点交」要按下午算。 */
  function matchTime(text) {
    const s = String(text || "");
    const norm = (h, mi, mark) => {
      let hh = h;
      const pm = /下午|晚上|傍晚|中午/.test(mark || "");
      const am = /上午|早上|凌晨/.test(mark || "");
      if (pm && hh < 12) hh += 12;
      if (am && hh === 12) hh = 0;
      if (!(hh >= 0 && hh <= 23) || !(mi >= 0 && mi <= 59)) return "";
      return hhmm(hh * 60 + mi);
    };
    let m = /(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:[ap]\.?m\.?)?/i.exec(s);
    if (m) return norm(Number(m[2]), Number(m[3]), m[1]);
    // 「X点」与「X时」同权（「下午3时30分」是正式通知的常见写法），与中文数字分支的 [点时] 对齐
    m = /(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*[点时]\s*(半|(\d{1,2})\s*分?)?/.exec(s);
    if (m) return norm(Number(m[2]), m[3] === "半" ? 30 : Number(m[4] || 0), m[1]);
    // 中文数字：「下午三点」「晚上十点半」「中午十二点」
    const CN = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    m = /(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*(零|一|两|二|三|四|五|六|七|八|九|十[一二]?)\s*[点时]\s*(半|(\d{1,2})\s*分?)?/.exec(s);
    if (m && CN[m[2]] !== undefined) return norm(CN[m[2]], m[3] === "半" ? 30 : Number(m[4] || 0), m[1]);
    return "";
  }
  /** 视觉上折叠过的长文本拿不到换行。我们**不猜**哪里该断行 —— 猜错会把正文切碎，
      比多留一点乱字符糟糕。这里只做能保证正确的事：压掉连续空白、去掉引用前缀的 `>`。 */
  function tidyText(s) {
    return String(s == null ? "" : s)
      .replace(/^[>\s]*>[>\s]*/gm, "")
      .replace(/[ \t\u00a0]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  /** 去重判据：同一天内**标题相同**即视为重复。
      额外再比一次 raw 的开头，避免「两个都叫『通知』」被误判成一条。
      拖放太容易手滑重复，去重是刚需。 */
  function sameMessage(a, b) {
    if (!a || !b) return false;
    if (a.title !== b.title) return false;
    // 识别出的日期不同就算新的一条 —— 同一文案可能对应不同场次；
    // 用户在确认条里把日期改掉后再粘一遍原文，也不该被当成旧的重复。
    // （与小程序端 idSameMessage 同一规则。）
    if (String(a.date || "") !== String(b.date || "")) return false;
    if (Math.abs(Number(a.at || 0) - Number(b.at || 0)) > DUP_WINDOW_MS) return false;
    return String(a.raw || "").slice(0, 60) === String(b.raw || "").slice(0, 60);
  }
  function isDuplicate(list, msg) {
    return (Array.isArray(list) ? list : []).some((x) => sameMessage(x, msg));
  }
  /** 统计：一律**从台账重算**，不做增量累加。
      增量累加在「删一条 / 清空 / 改类型」之后必然漂移，重算才是唯一不会说谎的做法。 */
  function statsOf(list) {
    const rows = Array.isArray(list) ? list : [];
    const stats = { total: rows.length, byKind: {}, byType: {}, byPlatform: {}, lastAt: 0 };
    for (const r of rows) {
      if (!r) continue;
      stats.byKind[r.kind] = (stats.byKind[r.kind] || 0) + 1;
      if (r.msgType) stats.byType[r.msgType] = (stats.byType[r.msgType] || 0) + 1;
      if (r.platform) stats.byPlatform[r.platform] = (stats.byPlatform[r.platform] || 0) + 1;
      stats.lastAt = Math.max(stats.lastAt, Number(r.at || 0));
    }
    return stats;
  }
  /** 归一化一条台账。数据损坏不能把插件变成白屏，一律退回可用默认值；
      **未识别的键原样保留** —— 别端（小程序）不展示某字段，也不能把它抹掉。 */
  function normalizeDrop(raw) {
    const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const kind = DROP_KINDS.includes(r.kind) ? r.kind : "text";
    const title = String(r.title || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || "未命名消息";
    return {
      ...r,
      id: String(r.id || "").trim() || uid("d"),
      kind,
      title,
      raw: String(r.raw || "").slice(0, RAW_MAX),
      platform: PLATFORMS.some((p) => p.id === r.platform) ? String(r.platform) : "",
      msgType: MSG_TYPES.some((t) => t.id === r.msgType) ? String(r.msgType) : "",
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? String(r.date) : "",
      time: hhmm((String(r.time || "").match(/^(\d{1,2}):(\d{2})$/) || [])[1] !== undefined
        ? Number(String(r.time).split(":")[0]) * 60 + Number(String(r.time).split(":")[1]) : -1),
      source: String(r.source || "").slice(0, 120),
      at: Number(r.at) > 0 ? Number(r.at) : Date.now(),
      fileSize: Number(r.fileSize) > 0 ? Number(r.fileSize) : 0,
      mime: String(r.mime || ""),
      bin: typeof r.bin === "string" && isDataUrl(r.bin) ? r.bin : "",
      tags: Array.isArray(r.tags) ? r.tags.filter((x) => typeof x === "string").slice(0, 8) : [],
      pinned: r.pinned === true,
    };
  }
  function normalizeDrops(raw) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      const row = normalizeDrop(item);
      if (seen.has(row.id)) continue;   // 重复 id 会让「删除 / 置顶」指错对象
      seen.add(row.id);
      out.push(row);
      if (out.length >= KEEP_MAX) break;
    }
    return out;
  }
  /** 分类标签：平台 + 类型，列表里一眼看清这条是什么。 */
  function tagsOf(msg) {
    const out = [];
    const p = PLATFORMS.find((x) => x.id === msg.platform);
    const t = MSG_TYPES.find((x) => x.id === msg.msgType);
    if (p) out.push(p.label);
    if (t) out.push(t.label);
    return out;
  }
  /** 排序：未处理的排前面（收纳区是待办入口，不该被已处理的沉到下面），
      同组内新的在前，置顶的永远在最上面。 */
  function ordered(list) {
    return (Array.isArray(list) ? list : [])
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        if (!!b.r.pinned !== !!a.r.pinned) return b.r.pinned ? 1 : -1;
        if (!!b.r.done !== !!a.r.done) return b.r.done ? 1 : -1;
        const d = Number(b.r.at || 0) - Number(a.r.at || 0);
        return d || a.i - b.i;   // 时间相同（同一次拖入）时保持原顺序，避免列表跳动
      })
      .map((x) => x.r);
  }
  /** 递给宿主收件箱的载荷。收件箱只认 title/when/note/suggestion，这里做映射。 */
  function toInboxItem(msg) {
    const t = MSG_TYPES.find((x) => x.id === msg.msgType);
    const p = PLATFORMS.find((x) => x.id === msg.platform);
    const bits = [];
    if (p) bits.push(p.label);
    if (msg.kind === "image") bits.push("截图");
    else if (msg.kind !== "text") bits.push("文件");
    if (msg.time) bits.push(msg.time);
    if (msg.source) bits.push(msg.source);
    return {
      sourceKey: `inbox-drop:${msg.sourceKey || msg.id}`,
      title: msg.title,
      when: msg.date || undefined,
      note: (bits.length ? bits.join(" · ") + " —— " : "") + String(msg.raw || "").replace(/\s+/g, " ").slice(0, NOTE_MAX),
      suggestion: "create-task",
      meta: { platform: msg.platform, msgType: msg.msgType, msgHint: t ? t.label : "", dropId: msg.id },
    };
  }
  /** 建任务的载荷。沿用宿主的字段约定（quad / estMin / due / tags / note / attachments）。 */
  function toTaskPatch(msg) {
    const t = MSG_TYPES.find((x) => x.id === msg.msgType);
    const p = PLATFORMS.find((x) => x.id === msg.platform);
    const tags = ["收纳"];
    if (p) tags.push(p.label);
    if (t) tags.push(t.label);
    const patch = {
      title: msg.title,
      quad: t ? t.quad : 2,
      estMin: 30,
      tags,
      note: String(msg.raw || "").slice(0, NOTE_MAX),
    };
    if (msg.date) { patch.due = msg.date; if (msg.time) patch.dueTime = msg.time; }
    if (msg.kind === "image" && msg.bin) patch.attachments = [msg.bin];
    return patch;
  }

  /* ══════════════════════════════════════════════════════════════════
     存储
     ══════════════════════════════════════════════════════════════════ */
  async function load() {
    const [drops, stats, seq, activeKind] = await Promise.all([
      tide.storage.get("drops", null),
      tide.storage.get("stats", null),
      tide.storage.get("seq", 0),
      tide.storage.get("activeKind", "all"),
    ]);
    state.drops = normalizeDrops(drops);
    state.seq = Math.max(0, Number(seq) || 0, state.drops.length);
    state.activeKind = DROP_KINDS.includes(activeKind) || activeKind === "all" ? activeKind : "all";
    // stats 只读一次做个交叉验证：存储里那份与重算结果不一致时以重算为准，
    // 并立刻落盘纠正 —— 否则界面上显示的数字会一直错下去。
    const fresh = statsOf(state.drops);
    state.stats = fresh;
    if (!stats || Number(stats.total) !== fresh.total) await tide.storage.set("stats", fresh);
  }
  async function save() {
    state.stats = statsOf(state.drops);
    await Promise.all([
      tide.storage.set("drops", state.drops),
      tide.storage.set("stats", state.stats),
      tide.storage.set("seq", state.seq),
      tide.storage.set("activeKind", state.activeKind),
    ]);
  }

  /* ══════════════════════════════════════════════════════════════════
     收纳动作：拖进什么 → 台账 + 宿主收件箱
     ══════════════════════════════════════════════════════════════════ */
  /** 收下一个已经解析好的消息。返回 `{row, duplicated}`。
      去重在这里收口 —— 无论是拖放、粘贴还是手动新建，都走这一条路。 */
  async function addDrop(msg) {
    const row = normalizeDrop({ ...msg, id: uid("d") });
    if (isDuplicate(state.drops, row)) return { row: null, duplicated: true };
    state.drops.unshift(row);
    if (state.drops.length > KEEP_MAX) state.drops.length = KEEP_MAX;
    state.seq += 1;
    row.seq = state.seq;
    await save();
    return { row, duplicated: false };
  }
  /** 递进宿主收件箱。失败**不阻断收纳** —— 台账已经收下了，
      收件箱只是转发渠道，转发不出去不该让用户丢掉刚拖进来的东西。 */
  async function pushToHostInbox(msg) {
    try {
      const created = tide.inbox.create(toInboxItem(msg));
      return created || null;
    } catch (e) {
      console.warn("inbox-drop: 递进收件箱失败", e);
      return null;
    }
  }

  /** 拖放主入口。**这是本插件唯一处理「拖入」的地方**。
      ⚠️ 它**只解析、不入库** —— 入库统一由 `commitDrop()` 负责，确认条上的「收进收件箱」
      和「直接建任务」都走那一条路。曾把入库放在这里，结果确认条一开始就把刚拖进来的那条
      当成「已存在的重复」标出来（自己和自己比），并且不点确认也已经落库了。
      返回值是给人看的处理结果数组，测试可以直接断言，不用去翻 DOM。 */
  async function acceptDrop(input) {
    const dt = (input && input.dataTransfer) || {};
    const files = Array.from((input && input.files) || dt.files || []).slice(0, CHECK_LIMIT);
    // 文件夹拖进来的是空 file 列表 + 非空 items，得单独告诉用户为什么没收
    const folderSkipped = !files.length && Array.from(dt.items || []).some((it) => it && it.kind === "file");
    const results = [];
    const payloads = [];

    for (const f of files) {
      const verdict = accepts(f);
      const name = String((f && f.name) || "未命名文件");
      if (!verdict.ok) { results.push({ action: "rejected", name, reason: verdict.reason }); continue; }
      if (verdict.kind === "image") {
        try {
          const bin = await readImage(f);
          payloads.push(analyze({
            kind: "image", title: baseName(name), raw: name, source: "本地截图",
            bin, mime: verdict.mime, fileSize: Number(f.size) || 0,
            parseWhen: parseWhenSafe,
          }));
          results.push({ action: "staged", name, kind: "image" });
        } catch (e) {
          results.push({ action: "rejected", name, reason: `图片读取失败：${e && e.message || e}` });
        }
        continue;
      }
      if (verdict.kind === "file") {
        try {
          const bytes = await readHead(f, 64);
          const sniff = sniffBytes(bytes);
          if (sniff !== "text" && sniff !== "empty") {
            results.push({ action: "rejected", name, reason: "内容是二进制 / 可执行文件，不是消息文本" });
            continue;
          }
          const text = await readFull(f, 64 * 1024);
          payloads.push(analyze({
            kind: "file", title: baseName(name), raw: text, source: name,
            mime: verdict.mime, fileSize: Number(f.size) || 0,
            parseWhen: parseWhenSafe,
          }));
          results.push({ action: "staged", name, kind: "file" });
        } catch (e) {
          results.push({ action: "rejected", name, reason: `文件读取失败：${e && e.message || e}` });
        }
        continue;
      }
      // other：只登记名称，不读内容（体积与安全都不允许）
      let bin = "";
      if (String(verdict.mime || "").startsWith("image/")) {
        try { bin = await readImage(f); } catch { bin = ""; }
      }
      payloads.push(analyze({
        kind: "other", title: baseName(name), raw: `文件：${name}`, source: name,
        mime: verdict.mime, fileSize: Number(f.size) || 0, bin,
        parseWhen: parseWhenSafe,
      }));
      results.push({ action: "staged", name, kind: "other" });
    }

    if (!files.length) {
      let text = String(dt.getData ? dt.getData("text/plain") || dt.getData("text/uri-list") || "" : "");
      if (!text.trim() && dt.getData) {
        const html = dt.getData("text/html");
        if (html) text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
      }
      text = tidyText(text);
      if (text) {
        payloads.push(analyze({ kind: "text", raw: text, title: text, source: hostOf(text), parseWhen: parseWhenSafe }));
        results.push({ action: "staged", name: text.slice(0, 30), kind: "text" });
      } else if (folderSkipped) {
        results.push({ action: "rejected", name: "文件夹", reason: "文件夹不能整体收纳，请拖入里面的单个文件" });
      } else {
        results.push({ action: "rejected", name: "", reason: "没读到可收纳的内容（可能是图片拖放或跨应用限制）" });
      }
    }
    return { results, payloads };
  }

  /** 真正入库。**必须走这一条路** —— 拖入/粘贴的载荷由确认条确认后才落进来，
      手动新建也走它。返回值带 `pushed` 说明有没有递进宿主收件箱。 */
  async function commitDrop(msg) {
    const { row, duplicated } = await addDrop(msg);
    if (duplicated || !row) return { row: null, duplicated: true, pushed: false };
    // 时间与类型都认出来了才自动递进收件箱 —— 认不出的先留在台账里等人补，
    // 否则收件箱会被一堆「通知」标题的裸消息淹掉。
    let pushed = null;
    if (row.date || row.msgType) pushed = await pushToHostInbox(row);
    if (pushed) { row.pushed = true; await save(); }
    return { row, duplicated: false, pushed: !!pushed };
  }

  /* ── 读文件：三种读法分开，浏览器 / Tauri WebView 的兼容面各不相同 ── */
  function readHead(file, n) {
    return new Promise((resolve, reject) => {
      try {
        const blob = file.slice(0, n);
        if (typeof blob.arrayBuffer === "function") {
          blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
          return;
        }
        // 老 WebView 没有 Blob.arrayBuffer，退回 FileReader
        const fr = new FileReader();
        fr.onload = () => resolve(new Uint8Array(fr.result));
        fr.onerror = () => reject(new Error("读取失败"));
        fr.readAsArrayBuffer(blob);
      } catch (e) { reject(e); }
    });
  }
  function readFull(file, max) {
    return new Promise((resolve, reject) => {
      try {
        const blob = file.slice(0, max);
        if (typeof blob.text === "function") { blob.text().then(resolve).catch(reject); return; }
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => reject(new Error("读取失败"));
        fr.readAsText(blob);
      } catch (e) { reject(e); }
    });
  }
  /** 截图压缩成 dataURL。不压的话一张 4K 截图能到十几 MB，
      塞进 storage 会让整个 data.json 变得又大又慢（与 capture.js 同一套做法）。 */
  function readImage(file, max = IMG_SIDE) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.82));
        } catch (e) { reject(e); }
        finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
      img.src = url;
    });
  }
  /** parseWhen 是宿主注入的，可能不存在（权限没声明）也可能抛错。
      包一层，让 analyze 永远拿得到「要么结果、要么 null」。 */
  function parseWhenSafe(text) {
    try {
      if (!tide || !tide.util || typeof tide.util.parseWhen !== "function") return null;
      return tide.util.parseWhen(text);
    } catch { return null; }
  }

  /* ══════════════════════════════════════════════════════════════════
     条上动作：建任务 / 排时间块 / 递收件箱 / 置顶 / 删除 / 回滚
     ══════════════════════════════════════════════════════════════════ */
  /** 建任务。同日同名的未完成任务算重复，不重复创建。 */
  async function createTaskFrom(row) {
    if (!row) return null;
    const patch = toTaskPatch(row);
    const dup = (await tide.tasks.list()).find((t) => !t.done && t.title === patch.title && (t.due || null) === (patch.due || null));
    if (dup) { tide.notify(`「${patch.title}」的任务已经在列表里了`); return null; }
    try {
      const created = tide.tasks.create(patch);
      await markDone(row.id, "task");
      tide.notify(`已把「${patch.title}」变成任务`);
      return created;
    } catch (e) {
      tide.notify(`建任务失败：${e && e.message || e}`);
      return null;
    }
  }
  /** 排时间块。只用宿主接口能保证的两件事：建任务、拿到它的 id。
      **不做二次放置** —— 冲突重排是宿主 `placeTask` 的职责，插件里重写一份必然与宿主行为分叉。 */
  async function scheduleFrom(row) {
    if (!row) return null;
    if (!row.date || !row.time) { tide.notify("这条消息没识别出日期时间，先补一下再排"); return null; }
    const created = await createTaskFrom(row);
    if (!created) return null;
    try {
      const [h, m] = String(row.time).split(":").map(Number);
      const block = tide.blocks.create({
        date: row.date, start: row.time, durMin: 60,
        title: row.title, taskId: created.id,
        cat: (MSG_TYPES.find((t) => t.id === row.msgType) || {}).cat || "work",
      });
      tide.notify(`已排入 ${row.date.slice(5).replace("-", "/")} ${row.time} 的时间块`);
      return block;
    } catch (e) {
      tide.notify(`时间块创建失败，任务已保留：${e && e.message || e}`);
      return null;
    }
  }
  /** 设置处理状态。doneKind 记录「被变成了什么」，列表里能回显。 */
  async function markDone(id, doneKind) {
    const row = state.drops.find((x) => x.id === id);
    if (!row) return false;
    row.done = doneKind || "done";
    row.doneAt = Date.now();
    await save();
    return true;
  }
  async function reopen(id) {
    const row = state.drops.find((x) => x.id === id);
    if (!row) return false;
    delete row.done;
    delete row.doneAt;
    await save();
    return true;
  }
  /** 删除。返回被删的那条，交给调用方做撤销。 */
  async function removeDrop(id) {
    const idx = state.drops.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const [row] = state.drops.splice(idx, 1);
    await save();
    return row;
  }
  /** 撤销删除：**按原下标插回去**，否则撤销后条会跑到列表最上面，
      用户会以为「撤销错了」。 */
  async function restoreDrop(row, index) {
    if (!row) return false;
    const at = Math.max(0, Math.min(Number(index) || 0, state.drops.length));
    state.drops.splice(at, 0, row);
    await save();
    return true;
  }
  async function togglePin(id) {
    const row = state.drops.find((x) => x.id === id);
    if (!row) return false;
    row.pinned = !row.pinned;
    await save();
    return true;
  }
  /** 清空。默认只清已处理的 —— 一键清空未处理的太容易误伤。 */
  async function clearDrops(includeOpen) {
    const before = state.drops.slice();
    state.drops = includeOpen ? [] : state.drops.filter((x) => !x.done);
    if (state.drops.length === before.length) return 0;
    await save();
    return before.length - state.drops.length;
  }
  /** 就地修正识别结果。确认条上改的东西最终落在这里。 */
  async function patchDrop(id, patch) {
    const row = state.drops.find((x) => x.id === id);
    if (!row) return false;
    const next = normalizeDrop({ ...row, ...(patch || {}), id: row.id });
    Object.assign(row, next);
    await save();
    return true;
  }
  async function setKindFilter(kind) {
    const next = DROP_KINDS.includes(kind) || kind === "all" ? kind : "all";
    if (next === state.activeKind) return false;
    state.activeKind = next;
    await tide.storage.set("activeKind", next);
    return true;
  }
  const visibleDrops = () => ordered(state.drops).filter((r) => state.activeKind === "all" || r.kind === state.activeKind);

  /* ══════════════════════════════════════════════════════════════════
     样式：配色一律走主题变量，深色模式下自动跟随
     ══════════════════════════════════════════════════════════════════ */
  function ensureStyle() {
    if (document.getElementById("inbox-drop-style")) return;
    const st = document.createElement("style");
    st.id = "inbox-drop-style";
    st.textContent = `
      .id-wrap{max-width:940px;margin:0 auto;padding-bottom:28px;color:var(--ink,#22303A)}
      .id-card{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:18px;padding:20px 22px}
      /* 收纳概览紧凑条：内容常只有几个 chip，压成一行（kicker + 分布 + 清理按钮），说明走 title 悬停 */
      .id-stats{display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap;padding:10px 14px;border-radius:14px}
      .id-stats .id-kicker{margin:0;flex:none}
      .id-stats .id-tags{flex:0 1 auto;min-width:0}
      .id-stats .id-actions{margin:0 0 0 auto;padding:0}
      .id-stats .id-btn{height:28px;padding:0 10px;font-size:calc(11.5px * var(--ui-text-scale));border-radius:8px}
      .id-kicker{font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#8B979F);letter-spacing:.24em;text-transform:uppercase;margin-bottom:8px}
      .id-title{display:flex;align-items:center;gap:7px;font-size:calc(14px * var(--ui-text-scale));font-weight:750;margin-bottom:12px}
      .id-ico{width:14px;height:14px;flex:none;fill:currentColor;color:var(--deep,#0F4C5C)}
      .id-muted{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.75}
      .id-note{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A1A9AF);line-height:1.7;margin-top:9px}
      .id-err{color:#B34747}
      /* 拖放区：虚线框 + 明确的「可放置」态。dragover 必须 preventDefault，否则 drop 不触发 */
      .id-zone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;min-height:150px;
        border:2px dashed var(--line,#DCD6CB);border-radius:16px;background:var(--soft,#FAF8F4);text-align:center;
        padding:20px 18px;cursor:pointer;transition:border-color .15s ease,background .15s ease}
      .id-zone:hover{border-color:color-mix(in srgb,var(--deep,#0F4C5C) 40%,var(--line,#DCD6CB))}
      .id-zone.on{border-color:var(--deep,#0F4C5C);background:color-mix(in srgb,var(--deep,#0F4C5C) 7%,var(--panel,#fff))}
      .id-zone .id-zbig{font-size:calc(14px * var(--ui-text-scale));font-weight:700;color:var(--ink,#22303A)}
      .id-zone .id-zico{width:30px;height:30px;fill:currentColor;color:var(--deep,#0F4C5C)}
      .id-zone .id-zsub{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.7;max-width:430px}
      .id-zone input[type=file]{display:none}
      /* 确认条：识别结果落在这里，改完再收 */
      .id-pend{margin-top:14px;border:1px solid color-mix(in srgb,var(--deep,#0F4C5C) 30%,var(--line,#E4DFD6));
        border-radius:16px;padding:16px 17px;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel,#fff))}
      .id-pend-h{display:flex;align-items:center;gap:8px;font-size:calc(13px * var(--ui-text-scale));font-weight:750;margin-bottom:11px}
      .id-badge{font-size:calc(10.5px * var(--ui-text-scale));font-weight:700;border-radius:999px;padding:3px 9px;
        background:color-mix(in srgb,var(--mint,#2ec4b6) 16%,var(--panel,#fff));color:var(--deep,#176C60)}
      .id-badge.warn{background:color-mix(in srgb,var(--sun,#e3a008) 18%,var(--panel,#fff));color:var(--ink,#8A5A10)}
      .id-fields{display:grid;grid-template-columns:64px 1fr;gap:9px 11px;align-items:center}
      .id-fields > span{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
      .id-in{height:34px;border:1px solid var(--line,#DDD7CD);border-radius:9px;padding:0 10px;background:var(--panel,#fff);
        color:var(--ink,#22303A);font:inherit;font-size:calc(13px * var(--ui-text-scale));min-width:0;width:100%}
      .id-in:focus{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 18%,transparent);border-color:var(--deep,#0F4C5C)}
      .id-ta{min-height:64px;padding:8px 10px;resize:vertical;line-height:1.6;font-size:calc(12.5px * var(--ui-text-scale))}
      .id-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .id-inline .id-in{flex:1;min-width:110px}
      .id-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}
      .id-btn{height:34px;border-radius:9px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);padding:0 13px;
        cursor:pointer;font-size:calc(12px * var(--ui-text-scale));font-family:inherit;color:var(--ink,#22303A);display:inline-flex;align-items:center;gap:6px}
      .id-btn:hover{border-color:color-mix(in srgb,var(--deep,#0F4C5C) 42%,var(--line,#DCD6CB))}
      .id-btn.pri{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
      .id-btn.pri:hover{filter:brightness(1.06)}
      .id-btn.danger{color:var(--coral,#D64545);border-color:color-mix(in srgb,var(--coral,#D64545) 38%,var(--line,#DCD6CB))}
      .id-btn:disabled{opacity:.45;cursor:not-allowed}
      .id-preview{margin-top:10px;max-height:260px;object-fit:contain;border-radius:12px;border:1px solid var(--line,#E4DFD6);background:var(--panel,#fff);align-self:flex-start}
      .id-filters{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin:16px 0 10px}
      .id-filter-options{display:flex;gap:7px;flex-wrap:wrap}
      .id-chip{height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);
        cursor:pointer;font-size:calc(12px * var(--ui-text-scale));font-family:inherit;color:var(--ink-2,#59656D)}
      .id-chip.on{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
      .id-list{display:flex;flex-direction:column;gap:9px}
      .id-row{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:start;background:var(--panel,#fff);
        border:1px solid var(--line,#E4DFD6);border-radius:15px;padding:13px 15px}
      .id-row.done{opacity:.62}
      .id-mark{width:34px;height:34px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex:none;
        background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel,#fff))}
      .id-mark .id-ico{width:15px;height:15px}
      .id-main{min-width:0;display:flex;flex-direction:column;gap:5px}
      .id-rowtitle{font-size:calc(13.5px * var(--ui-text-scale));font-weight:700;line-height:1.45;word-break:break-word}
      .id-rowtitle .id-seq{font-size:calc(11px * var(--ui-text-scale));font-weight:600;color:var(--ink-3,#A1A9AF);margin-right:5px;font-variant-numeric:tabular-nums}
      .id-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .id-tag{font-size:calc(10.5px * var(--ui-text-scale));border-radius:999px;padding:3px 8px;white-space:nowrap;
        background:color-mix(in srgb,var(--mint,#2ec4b6) 11%,var(--panel,#fff));color:var(--deep,#176C60)}
      .id-tag.gray{background:var(--soft,#F4F1EB);color:var(--ink-2,#7E8B94)}
      .id-tag.sun{background:color-mix(in srgb,var(--sun,#e3a008) 15%,var(--panel,#fff));color:var(--ink,#8A5A10)}
      .id-when{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#687780);font-variant-numeric:tabular-nums}
      /* 原文展开/收起：grid 0fr→1fr 高度过渡（原生 details 没有动画）。
         .id-fold-clip 必须 overflow:hidden + min-height:0，0fr 才能真正压到 0。 */
      .id-fold{margin-top:4px}
      .id-fold-btn{cursor:pointer;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);background:none;border:0;padding:0;font-family:inherit}
      .id-fold-btn:hover{color:var(--ink,#22303A)}
      .id-fold-btn::before{content:"▸ ";color:var(--ink-3,#A1A9AF)}
      .id-fold.open .id-fold-btn::before{content:"▾ "}
      .id-fold-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .24s cubic-bezier(.22,.8,.22,1)}
      .id-fold.open .id-fold-body{grid-template-rows:1fr}
      .id-fold-clip{overflow:hidden;min-height:0}
      .id-raw{margin:7px 0 0;padding:9px 11px;border-radius:10px;background:var(--soft,#F7F5F0);
        font-size:calc(12px * var(--ui-text-scale));line-height:1.7;color:var(--ink-2,#59656D);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto}
      .id-thumb{margin-top:7px;max-height:150px;border-radius:10px;border:1px solid var(--line,#E4DFD6);align-self:flex-start}
      .id-rowbtns{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .id-mini{height:31px;padding:0 10px;border-radius:8px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);
        cursor:pointer;font-size:calc(11.5px * var(--ui-text-scale));font-family:inherit;color:var(--ink-2,#59656D);white-space:nowrap}
      .id-mini:hover{border-color:color-mix(in srgb,var(--deep,#0F4C5C) 42%,var(--line,#DCD6CB));color:var(--deep,#0F4C5C)}
      .id-mini.danger:hover{border-color:var(--coral,#D64545);color:var(--coral,#D64545)}
      /* 空态只用文字，不放图标：这张卡本来就在一个「拖到上面」的引导下面，
         再挂一个灰调的大图标只会和上面的虚线框图标打架，读起来像图裂了。 */
      .id-empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:30px 18px;text-align:center;
        border:1px dashed var(--line,#E4DFD6);border-radius:16px;color:var(--ink-2,#7E8B94)}
      .id-empty b{font-size:calc(13px * var(--ui-text-scale));color:var(--ink,#22303A);font-weight:700}
      /* 减弱动态效果偏好：原文展开退回瞬切（布局结果不变，只是不播过渡） */
      @media (prefers-reduced-motion: reduce){.id-fold-body{transition:none}}
      @media(max-width:720px){
        .id-card{padding:17px}
        .id-stats{padding:9px 12px}
        /* 手机上所有可点控件抬到 44px 触控下限：33px 高在窄屏上点得很难受，
           而这一页的主要操作恰恰都是这几个按钮。 */
        .id-btn,.id-mini,.id-chip{height:44px}
        .id-btn{padding:0 15px;font-size:calc(12.5px * var(--ui-text-scale))}
        .id-mini{padding:0 13px;font-size:calc(12px * var(--ui-text-scale))}
        .id-row{grid-template-columns:auto 1fr;gap:8px 11px;padding:12px}
        /* 按钮组跨满整行靠左：手机上挤在右上角会只剩图标宽度、连「建任务」都显示不全 */
        .id-rowbtns{grid-column:1/-1;justify-content:flex-start;gap:8px}
        .id-rowbtns .id-mini{flex:1 1 auto;justify-content:center;display:inline-flex;align-items:center}
        .id-fields{grid-template-columns:1fr;gap:6px}
        .id-fields > span{margin-top:4px}
        .id-in,.id-ta{height:44px}
        .id-ta{height:auto;min-height:88px}
        .id-zone{min-height:126px;padding:17px 14px}
        .id-filters{margin-top:13px}
        .id-filters .id-muted{margin-left:0}
      }
    `;
    document.head.append(st);
  }

  /* ══════════════════════════════════════════════════════════════════
     渲染
     ══════════════════════════════════════════════════════════════════ */
  const kindMeta = (k) => KINDS[k] || KINDS.text;
  const platformLabel = (id) => (PLATFORMS.find((p) => p.id === id) || {}).label || "";
  const typeLabel = (id) => TYPE_LABEL[id] || "";

  function zoneHtml() {
    return `<div class="id-zone" data-zone role="button" tabindex="0" aria-label="拖入消息收纳区，也可点击选择文件">
      <svg class="id-zico" viewBox="0 0 512 512" aria-hidden="true"><use href="/icons/fontawesome/solid.svg#inbox"></use></svg>
      <div class="id-zbig">把消息拖到这里</div>
      <div class="id-zsub">微信 / QQ 聊天文字、通知截图、网页段落、txt / md / csv 文件都可以直接拖进来；
        聊天里选中的消息也可以直接 Ctrl+V 粘贴。<br>自动识别来源平台、消息类型与日期时间，确认后进收件箱。</div>
      <div class="id-inline" style="justify-content:center;margin-top:3px">
        <button class="id-btn" type="button" data-pick>${faIcon("folder-open")}选择文件</button>
        <button class="id-btn" type="button" data-paste-tip>${faIcon("paste")}从剪贴板粘贴</button>
      </div>
      <input type="file" data-file multiple aria-label="选择要收纳的文件">
    </div>`;
  }

  /** 确认条：识别结果可改。**先给结论再给编辑** —— 用户多数时候只想点「收下」。*/
  function pendingHtml() {
    const p = state.pending;
    if (!p) return "";
    const dupe = isDuplicate(state.drops, p);
    const known = [];
    if (p.platform) known.push(platformLabel(p.platform));
    if (p.msgType) known.push(typeLabel(p.msgType));
    return `<section class="id-pend" data-pend>
      <div class="id-pend-h">${faIcon("wand-magic-sparkles")}识别结果
        <span class="id-badge${dupe ? " warn" : ""}">${dupe ? "疑似重复" : "待确认"}</span>
        <span class="id-badge gray">${esc(kindMeta(p.kind).label)}</span>
        ${known.length ? `<span class="id-badge">${esc(known.join(" · "))}</span>` : `<span class="id-badge warn">来源未识别</span>`}
      </div>
      <div class="id-fields">
        <span>标题</span><input class="id-in" data-f-title value="${esc(p.title)}" maxlength="${TITLE_MAX}" aria-label="消息标题">
        <span>平台</span><div class="id-inline"><select class="id-in" data-f-platform aria-label="来源平台">
          <option value="">未识别</option>
          ${PLATFORMS.map((x) => `<option value="${x.id}"${x.id === p.platform ? " selected" : ""}>${esc(x.label)}</option>`).join("")}
        </select><select class="id-in" data-f-type aria-label="消息类型">
          <option value="">未识别</option>
          ${MSG_TYPES.map((x) => `<option value="${x.id}"${x.id === p.msgType ? " selected" : ""}>${esc(x.label)}</option>`).join("")}
        </select></div>
        <span>日期时间</span><div class="id-inline">
          <input class="id-in" data-f-date type="date" value="${esc(p.date)}" aria-label="消息日期">
          <input class="id-in" data-f-time type="time" value="${esc(p.time)}" aria-label="消息时间">
        </div>
        <span>来源</span><input class="id-in" data-f-source value="${esc(p.source)}" maxlength="120" placeholder="群名 / 发件人 / 文件名" aria-label="消息来源">
        <span>原文</span><textarea class="id-in id-ta" data-f-raw maxlength="${RAW_MAX}" aria-label="消息原文">${esc(p.raw)}</textarea>
      </div>
      ${p.bin ? `<img class="id-preview" src="${esc(p.bin)}" alt="截图预览">` : ""}
      <div class="id-actions">
        <button class="id-btn pri" type="button" data-p-ok>${faIcon("inbox")}收进收件箱</button>
        <button class="id-btn" type="button" data-p-task>${faIcon("circle-plus")}直接建任务</button>
        <button class="id-btn danger" type="button" data-p-cancel>取消</button>
      </div>
      <div class="id-note">收进收件箱后原文与截图都留着，之后随时能变成任务或时间块。${dupe ? "<br>上面已经有一条一模一样的内容，继续收下会得到两条。" : ""}</div>
    </section>`;
  }

  function filtersHtml() {
    const counts = state.stats.byKind || {};
    const total = state.drops.length;
    const chip = (key, label, n) => `<button class="id-chip${state.activeKind === key ? " on" : ""}" data-kind="${key}" type="button" aria-pressed="${state.activeKind === key ? "true" : "false"}">${esc(label)}${n ? ` ${n}` : ""}</button>`;
    return `<div class="id-filters">
      <details class="plugin-filter-menu"><summary>筛选${state.activeKind === "all" ? "" : " · 已设置"}</summary><div class="plugin-filter-menu-panel"><div class="id-filter-options">
        ${chip("all", "全部", total)}
        ${DROP_KINDS.map((k) => chip(k, kindMeta(k).label, counts[k] || 0)).join("")}
      </div></div></details>
      <span class="id-muted" style="margin-left:auto">共 ${total} 条</span>
    </div>`;
  }

  function rowHtml(row) {
    const meta = kindMeta(row.kind);
    const tags = tagsOf(row);
    if (row.done) tags.push(row.done === "task" ? "已成任务" : row.done === "block" ? "已排时间块" : "已处理");
    const when = row.date ? `${row.date.slice(5).replace("-", "/")}${row.time ? ` ${row.time}` : ""}` : "未识别时间";
    const raw = String(row.raw || "");
    const preview = raw.length > 0;
    return `<article class="id-row${row.done ? " done" : ""}" data-id="${esc(row.id)}">
      <div class="id-mark" title="${esc(meta.label)}"><svg class="id-ico" viewBox="0 0 512 512" aria-hidden="true"><use href="/icons/fontawesome/solid.svg#${meta.icon}"></use></svg></div>
      <div class="id-main">
        <div class="id-rowtitle"><span class="id-seq">${row.seq ? `#${row.seq}` : ""}</span>${esc(row.title)}</div>
        <div class="id-tags">
          ${tags.map((t, i) => `<span class="id-tag${i === 0 && row.platform ? "" : " gray"}">${esc(t)}</span>`).join("")}
          ${row.source ? `<span class="id-tag gray">${esc(row.source)}</span>` : ""}
          <span class="id-when">${esc(when)} · ${esc(relTime(row.at))}</span>
          ${row.fileSize ? `<span class="id-tag gray">${Math.max(1, Math.round(row.fileSize / 1024))} KB</span>` : ""}
        </div>
        ${row.bin ? `<img class="id-thumb" src="${esc(row.bin)}" alt="收纳的截图">` : ""}
        ${preview ? `<div class="id-fold${foldOpen.has(row.id) ? " open" : ""}" data-fold><button class="id-fold-btn" type="button" aria-expanded="${foldOpen.has(row.id)}">原文</button><div class="id-fold-body"><div class="id-fold-clip"><pre class="id-raw">${esc(raw)}</pre></div></div></div>` : ""}
      </div>
      <div class="id-rowbtns">
        ${row.pinned ? `<button class="id-mini" data-unpin type="button">取消置顶</button>` : `<button class="id-mini" data-pin type="button">置顶</button>`}
        ${row.done
          ? `<button class="id-mini" data-reopen type="button">重新打开</button>`
          : `<button class="id-mini" data-task type="button">建任务</button>
             <button class="id-mini" data-schedule type="button"${row.date && row.time ? "" : " disabled"} title="${row.date && row.time ? "按识别出的时间创建任务与时间块" : "先补上日期与时间"}">排时间块</button>
             <button class="id-mini" data-repush type="button">递进收件箱</button>`}
        <button class="id-mini danger" data-del type="button">删除</button>
      </div>
    </article>`;
  }

  function listHtml() {
    const rows = visibleDrops();
    if (!rows.length) {
      const filtered = state.activeKind !== "all";
      return `<div class="id-empty">
        <b>${filtered ? "这个筛选下还没有内容。" : "收纳区还是空的"}</b>
        <div class="id-note">${filtered ? "切到「全部」看看其他类型。" : "把消息拖到上面的虚线框里试试 —— 拖进来的东西会先留在这里，确认后再进收件箱。"}</div>
      </div>`;
    }
    return `<div class="id-list">${rows.map(rowHtml).join("")}</div>`;
  }

  /** 类目概览：一眼看清收纳构成，也是判断「该不该清理」的依据。
      紧凑条版：内容通常只有几个 chip，不值得占一整张大卡片 ——
      kicker + 分布 chips + 清理按钮压成一行，说明文字收进 title 悬停提示。 */
  function statsHtml() {
    const s = state.stats || statsOf(state.drops);
    const typeRows = Object.entries(s.byType || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const platRows = Object.entries(s.byPlatform || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const line = (rows, labelOf) => (rows.length
      ? rows.map(([k, n]) => `<span class="id-tag">${esc(labelOf(k) || k)} ${n}</span>`).join("")
      : `<span class="id-muted">还没有数据</span>`);
    const tip = `最近一次收纳：${s.lastAt ? esc(relTime(s.lastAt)) : "还没有"}。收纳区是消息的原文台账；收件箱里只有标题与摘要，原文与截图都从这里取。`;
    return `<section class="id-card id-stats" style="margin-top:14px" title="${tip}">
      <span class="id-kicker">收纳概览</span>
      <div class="id-tags">${line(typeRows, typeLabel)}</div>
      <div class="id-tags">${line(platRows, platformLabel)}</div>
      <div class="id-actions">
        <button class="id-btn" type="button" data-clear-done>清除已处理的（${state.drops.filter((x) => x.done).length}）</button>
        <button class="id-btn danger" type="button" data-clear-all>清空全部</button>
      </div>
    </section>`;
  }

  async function paint() {
    if (!root) return;
    ensureStyle();
    const zone = root.querySelector("[data-zone]");
    const zoneWasOn = zone ? zone.classList.contains("on") : false;
    root.innerHTML = `<div class="id-wrap">
      <section class="id-card">
        <div class="id-kicker">拖入消息收纳</div>
        <div class="id-title">${faIcon("inbox")}把散落的消息收成一条待办</div>
        ${zoneHtml()}
        <div id="id-pend-host">${pendingHtml()}</div>
        ${dragHintHtml()}
      </section>
      ${filtersHtml()}
      ${listHtml()}
      ${statsHtml()}
    </div>`;
    // 重绘会换掉节点，拖动中的高亮态要接着显示，否则鼠标还在上面却突然不亮了。
    if (zoneWasOn) root.querySelector("[data-zone]")?.classList.add("on");
    bind();
  }
  /** 操作反馈：拖放的「拖了什么、收没收、为什么没收」都要有回音。
      「拖了没反应」是最难排查的一种失败。 */
  function dragHintHtml() {
    const lines = state.hint;
    if (!lines || !lines.length) return "";
    const cls = lines.some((l) => l.action === "rejected") ? "warn" : "gray";
    return `<div class="id-actions" style="margin-top:12px">${lines.map((l) => `<span class="id-badge ${cls}">${esc(l.text)}</span>`).join("")}</div>`;
  }

  /* ── 交互绑定：每次 paint() 后重绑（节点都是新的） ── */
  function bind() {
    const q = (sel) => root.querySelector(sel);
    const zone = q("[data-zone]");
    if (!zone) return;

    // —— 点击选择文件 ——
    const fileInput = q("[data-file]");
    zone.addEventListener("click", (e) => { if (!e.target.closest("button")) fileInput?.click(); });
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput?.click(); } });
    q("[data-pick]")?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      await runAccept({ files, dataTransfer: null });
    });

    // —— 拖放 ——
    zone.addEventListener("dragenter", (e) => { if (!wants(e.dataTransfer)) return; e.preventDefault(); dragDepth += 1; zone.classList.add("on"); });
    zone.addEventListener("dragover", (e) => {
      if (!wants(e.dataTransfer)) return;
      // 这一行不能省：不 preventDefault 浏览器就不认这是可放置目标，drop 永远不触发。
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      zone.classList.add("on");
    });
    zone.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) zone.classList.remove("on");
    });
    zone.addEventListener("drop", async (e) => {
      if (!wants(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth = 0;
      zone.classList.remove("on");
      await runAccept({ files: null, dataTransfer: e.dataTransfer });
    });

    // —— 粘贴：聊天里选中一句直接 Ctrl+V ——
    q("[data-paste-tip]")?.addEventListener("click", () => {
      state.hint = [{ action: "info", text: "在应用任意位置按 Ctrl+V，我们会接住剪贴板里的文字或截图" }];
      paint();
    });

    // —— 确认条 ——
    q("[data-f-title]")?.addEventListener("input", syncPending);
    q("[data-f-platform]")?.addEventListener("change", syncPending);
    q("[data-f-type]")?.addEventListener("change", syncPending);
    q("[data-f-date]")?.addEventListener("change", syncPending);
    q("[data-f-time]")?.addEventListener("change", syncPending);
    q("[data-f-source]")?.addEventListener("input", syncPending);
    q("[data-f-raw]")?.addEventListener("input", syncPending);
    // 确认条上的两个按钮是**唯一的入库入口**（单条拖入走的路径）。
    // 都从 state.pending 取当前表单里的值（syncPending 已经把它同步成用户改过的样子），
    // 再统一交给 commitDrop —— 去重、递进收件箱都在那里。
    q("[data-p-ok]")?.addEventListener("click", async () => {
      const p = state.pending;
      if (!p) return;
      // 先把 pending 摘掉再入库：commitDrop 之后 state.drops 里就有这一条了，
      // 若此时还留着 pending，下一步 paint() 画的确认条会拿它跟自己比 → 又标「疑似重复」。
      state.pending = null;
      const { row, duplicated, pushed } = await commitDrop(p);
      if (duplicated || !row) {
        state.hint = [{ action: "rejected", text: "这条和已有的重复，没有重复收纳" }];
        await paint();
        tide.notify("这条和已有的重复，已跳过");
        return;
      }
      state.hint = [{ action: "queued", text: pushed ? `已收进收件箱：${row.title}` : `已收进收纳区：${row.title}` }];
      await paint();
      tide.notify(pushed ? `「${row.title}」已进收件箱` : `「${row.title}」已收进收纳区`);
    });
    q("[data-p-task]")?.addEventListener("click", async () => {
      const p = state.pending;
      if (!p) return;
      state.pending = null;
      const { row, duplicated } = await commitDrop(p);
      if (duplicated || !row) {
        state.hint = [{ action: "rejected", text: "这条和已有的重复，没有重复收纳" }];
        await paint();
        return;
      }
      // 建任务会顺带把这条台账标记成已处理（createTaskFrom 内部负责）
      await createTaskFrom(row);
      state.hint = [{ action: "queued", text: `已建任务：${row.title}` }];
      await paint();
    });
    q("[data-p-cancel]")?.addEventListener("click", async () => { state.pending = null; state.hint = []; await paint(); });

    // —— 筛选 ——
    root.querySelectorAll("[data-kind]").forEach((btn) => btn.addEventListener("click", async () => {
      if (await setKindFilter(btn.dataset.kind)) await paint();
    }));

    // —— 条上动作 ——
    root.querySelectorAll(".id-row").forEach((el) => {
      const id = el.dataset.id;
      const find = () => state.drops.find((x) => x.id === id);
      // 原文展开/收起：切 .open 驱动 grid 0fr→1fr 过渡（原生 details 没有动画）。
      // 展开态记进 foldOpen，宿主背后重绘后 paint 能原样恢复。
      el.querySelector("[data-fold]")?.addEventListener("click", (e) => {
        const btn = e.target.closest(".id-fold-btn");
        if (!btn) return;
        const fold = btn.closest(".id-fold");
        const open = fold.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) foldOpen.add(id); else foldOpen.delete(id);
      });
      el.querySelector("[data-task]")?.addEventListener("click", async () => { await createTaskFrom(find()); await paint(); });
      el.querySelector("[data-schedule]")?.addEventListener("click", async () => { await scheduleFrom(find()); await paint(); });
      el.querySelector("[data-repush]")?.addEventListener("click", async () => {
        const row = find();
        if (!row) return;
        const pushed = await pushToHostInbox(row);
        row.pushed = !!pushed;
        await save();
        tide.notify(pushed ? `「${row.title}」已递进收件箱` : "收件箱暂时不可用，原文仍在收纳区");
        await paint();
      });
      el.querySelector("[data-reopen]")?.addEventListener("click", async () => { await reopen(id); await paint(); });
      el.querySelector("[data-pin]")?.addEventListener("click", async () => { await togglePin(id); await paint(); });
      el.querySelector("[data-unpin]")?.addEventListener("click", async () => { await togglePin(id); await paint(); });
      el.querySelector("[data-del]")?.addEventListener("click", async () => {
        const idx = state.drops.findIndex((x) => x.id === id);
        const row = await removeDrop(id);
        if (!row) return;
        foldOpen.delete(id);   // 行没了，展开记录一并清掉，免得恢复时指向不存在的行
        await paint();
        tide.notify(`已删除「${row.title}」`, {
          actionLabel: "撤销",
          action: async () => { await restoreDrop(row, idx); await paint(); },
        });
      });
    });

    // —— 清空 ——
    q("[data-clear-done]")?.addEventListener("click", async () => {
      const n = await clearDrops(false);
      if (!n) { tide.notify("没有已处理的条目"); return; }
      await paint();
      tide.notify(`已清除 ${n} 条已处理的记录`);
    });
    q("[data-clear-all]")?.addEventListener("click", async () => {
      if (!state.drops.length) { tide.notify("收纳区已经是空的"); return; }
      if (!confirmFn(`清空全部 ${state.drops.length} 条收纳记录？\n\n原文与截图会一起删掉，收件箱里已递进的内容不受影响。`)) return;
      const n = await clearDrops(true);
      await paint();
      tide.notify(`已清空 ${n} 条收纳记录`);
    });
  }
  /** 把确认条上的编辑同步回 state.pending。用 input 而不是 change ——
      用户改完标题**直接点「收下」**时 change 还没触发，那一次编辑就白改了。 */
  function syncPending() {
    const p = state.pending;
    if (!p || !root) return;
    const v = (sel) => { const n = root.querySelector(sel); return n ? n.value : undefined; };
    const t = v("[data-f-title]");
    if (t !== undefined && String(t).trim()) p.title = String(t).trim().slice(0, TITLE_MAX);
    const plat = v("[data-f-platform]"); if (plat !== undefined) p.platform = plat;
    const type = v("[data-f-type]"); if (type !== undefined) p.msgType = type;
    const date = v("[data-f-date]"); if (date !== undefined) p.date = date;
    const time = v("[data-f-time]"); if (time !== undefined) p.time = time;
    const src = v("[data-f-source]"); if (src !== undefined) p.source = src;
    const raw = v("[data-f-raw]"); if (raw !== undefined) p.raw = raw.slice(0, RAW_MAX);
    p.sourceKey = `${p.platform}|${p.msgType}|${p.date}|${p.time}|${p.title}`;
  }

  /** 拖放 / 选择的统一收口：跑准入 → 有内容就弹确认条，没内容就给出理由。 */
  async function runAccept(input) {
    if (state.busy) return [];
    state.busy = true;
    try {
      const { results, payloads } = await acceptDrop(input);
      const staged = results.filter((r) => r.action === "staged");
      const rejects = results.filter((r) => r.action === "rejected");
      // 一条 → 弹确认条让人过一眼再收（这才是「先收后处理」该有的样子）；
      // 多条 → 逐条塞确认条会被挤爆，先都收下再让人在列表里逐条处理。
      let multiCount = 0;
      if (payloads.length === 1) {
        const p = payloads[0];
        // 预览用的 pending 是**未入库**的副本：确认条上标出来的「疑似重复」
        // 因而是在和真正已有的历史条目比，而不是和自己比。
        state.pending = { ...normalizeDrop({ ...p, id: uid("p") }) };
      } else if (payloads.length > 1) {
        for (const p of payloads) {
          const { duplicated } = await commitDrop(p);
          if (!duplicated) multiCount += 1;
        }
        state.pending = null;
      } else {
        state.pending = null;
      }
      state.hint = [
        ...staged.map((r) => ({ action: "staged", text: payloads.length > 1 ? `已收纳：${r.name}` : `已接住：${r.name}` })),
        ...rejects.map((r) => ({ action: "rejected", text: r.name ? `${r.name} —— ${r.reason}` : r.reason })),
      ];
      if (multiCount) tide.notify(`已收纳 ${multiCount} 条消息`);
      else if (payloads.length === 1) tide.notify("已接住这条消息，确认后进收件箱");
      await paint();
      return results;
    } catch (e) {
      console.warn("inbox-drop: 收纳失败", e);
      state.hint = [{ action: "rejected", text: `收纳失败：${e && e.message || e}` }];
      await paint();
      return [];
    } finally {
      state.busy = false;
    }
  }

  let bootPromise = null;

  function render(el) {
    ensureStyle();
    root = el;
    // 首绘必须等 boot() 读完 storage：render() 可能早于插件初始化完成（宿主渲染视图 vs 模块启动），
    // 直接 paint() 会拿着空 drops 画出「收纳区还是空的」，而且之后没人再重绘。
    el.innerHTML = `<div class="id-wrap"><section class="id-card"><div class="id-muted">正在读取收纳记录…</div></section></div>`;
    boot()
      .then(() => { if (root === el) paint(); })
      .catch((e) => {
        if (root !== el) return;
        el.innerHTML = `<div class="id-wrap"><section class="id-card"><div class="id-title id-err">收纳记录读取失败</div><div class="id-muted">${esc(e && e.message || e)}</div><div class="id-actions"><button class="id-btn pri" data-retry type="button">重试</button></div></section></div>`;
        el.querySelector("[data-retry]")?.addEventListener("click", () => { bootPromise = null; render(el); });
      });
    return () => { if (root === el) root = null; };
  }

  tide.ui.registerView({ id: VIEW_ID, title: "拖入消息收纳", icon: "inbox", render });

  /* 启动：读配置 → 领代号（顶掉旧实例）→ 挂全局粘贴与拖放门卫 */
  function boot() {
    if (!bootPromise) bootPromise = (async () => {
      await load();
      MY_GEN = (Number(await tide.storage.get("gen", 0)) || 0) + 1;
      await tide.storage.set("gen", MY_GEN);
      attachGlobal();
    })();
    return bootPromise;
  }

  /* ── 全局挂钩：粘贴与拖放不只在本插件页里能用 ──
     宿主自己也在 document 上监听 paste/drop（src/capture.js），且**先注册**。
     两边的顺序是 DOM 规范保证的：捕获阶段先于冒泡阶段、同阶段按注册顺序。
     所以我们用 capture:true 抢在宿主前面 —— 但这意味着**必须自己判断该不该接管**：
       · 焦点在输入框里 → 绝不接管（那是正常输入）
       · 本插件页可见时 → 我们接管；不在本页时 → 一律放行给宿主
     少任何一条判断，用户的正常输入或宿主的捕获功能就会被打断。 */
  let globalBound = false;
  function attachGlobal() {
    if (globalBound || typeof document === "undefined") return;
    globalBound = true;
    document.addEventListener("paste", onGlobalPaste, true);
  }
  /** 本插件的视图当前是否可见。看不见就别抢 —— 用户没在收纳。 */
  function viewVisible() {
    try {
      const nav = document.querySelector("nav.nav");
      if (nav) {
        const entry = nav.querySelector(`[data-view="plug:${VIEW_ID}"]`);
        if (entry && !/\bon\b|active|selected/i.test(entry.className || "")) return false;
      }
      const host = document.querySelector(`[data-view="plug:${VIEW_ID}"]`);
      if (host) return true;
      // 没有可见性线索时保守放行：宁可让宿主处理，也不要凭空吞掉用户的粘贴。
      return false;
    } catch { return false; }
  }
  function onGlobalPaste(e) {
    try {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!viewVisible()) return;
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const imageItem = items.find((it) => String(it.type || "").startsWith("image/"));
      if (imageItem) {
        const f = imageItem.getAsFile();
        if (!f) return;
        e.preventDefault();
        readImage(f)
          .then(async (bin) => {
            // 和拖入一样：pending 是**未入库**的副本，确认条点下去才落库。
            const msg = analyze({ kind: "image", title: "剪贴板截图", raw: "剪贴板截图", source: "剪贴板", bin, mime: f.type, parseWhen: parseWhenSafe });
            if (!root) { tide.notify("切到「拖入消息收纳」页再粘贴"); return; }
            state.pending = { ...normalizeDrop({ ...msg, id: uid("p") }) };
            state.hint = [{ action: "staged", text: "已接住剪贴板里的截图，确认后收纳" }];
            await paint();
          })
          .catch(() => { tide.notify("这张图片读取失败"); });
        return;
      }
      const text = tidyText(e.clipboardData && e.clipboardData.getData("text/plain"));
      if (!text || text.length < 2) return;
      // 粘的是本插件页才有意义；不在本页就别吞，直接交给宿主处理
      if (!root) return;
      e.preventDefault();
      const msg = analyze({ kind: "text", raw: text, title: text, source: hostOf(text), parseWhen: parseWhenSafe });
      state.pending = { ...normalizeDrop({ ...msg, id: uid("p") }) };
      state.hint = [{ action: "staged", text: "已接住剪贴板里的文字，确认后收纳" }];
      paint();
    } catch (err) {
      console.warn("inbox-drop: 粘贴处理失败", err);
    }
  }

  boot().catch((e) => console.warn("inbox-drop: 初始化失败", e));
})();
