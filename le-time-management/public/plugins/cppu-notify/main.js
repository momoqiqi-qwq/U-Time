// 警大门户通知 —— 对齐 cppu-notify-skill v1.2.1（Python + tesseract OCR → U-Time插件）
// 自动登录：登录成功一次后，密码与门户会话票据（Cookie）加密存入应用密钥库
// （tide.vault，Rust 侧 AES-256-GCM，不进 data.json / 备份）；
// 之后每次打开插件：先恢复票据静默续期直达消息页；票据过期则自动识别验证码
// （内置纯 JS 数字识别 + 失败自动换图重试）完成登录，全程无需手填。
// 保留完整 SSO 链路（主 SSO → sso-jw bridge → 门户 tp_up）与 rememberMe。
(function () {
  const SSO = "https://sso.cppu.edu.cn";
  const JW = "https://sso-jw.cppu.edu.cn";
  const PORTAL = "https://portal-jw.cppu.edu.cn";
  const JWAPP = "https://jw.cppu.edu.cn";          // 智慧教务（正方 JE），与上面的 sso-jw 不是一个域
  const JW_INDEX = JWAPP + "/index.html";
  const SERVICE_JW = JW + "/tpass/bridge";
  const LOGIN_URL = SSO + "/tpass/login?service=" + encodeURIComponent(SERVICE_JW);
  const SERVICE_PORTAL = PORTAL + "/tp_up/view?m=up";
  const SILENT_LOGIN = JW + "/tpass/login?service=" + encodeURIComponent(SERVICE_PORTAL);
  const MAIL = "https://mail.cppu.edu.cn/";
  const MAIL_ACCOUNT = "2025290058@cppu.edu.cn";
  const CARD_ORIGIN = "https://yktcard.cppu.edu.cn";
  const CARD_HOME = CARD_ORIGIN + "/campus-card/?appId=2&loginFrom=h5&type=app";
  const CARD_RECHARGE = CARD_ORIGIN + "/campus-card/cardRecharge?name=cardRecharge&appId=2&loginFrom=h5&type=app";
  const CARD_CENTER = CARD_ORIGIN + "/campus-card/userCenter?name=userCenter&appId=2&loginFrom=h5&type=app";
  const CARD_BILLING = CARD_ORIGIN + "/campus-card/billing/list?name=billList&appId=24&loginFrom=h5&type=app";
  const CARD_AUTH_URL = CARD_ORIGIN + "/berserker-auth/oauth/token";
  const CARD_BILLS_URL = CARD_ORIGIN + "/berserker-search/search/personal/turnover";
  const CARD_LIST_URL = CARD_ORIGIN + "/berserker-app/ykt/tsm/getCampusCards";
  const CARD_DETAIL_URL = CARD_ORIGIN + "/berserker-app/ykt/tsm/queryCard";
  const CARD_BASIC_AUTH = "Basic bW9iaWxlX3NlcnZpY2VfcGxhdGZvcm06bW9iaWxlX3NlcnZpY2VfcGxhdGZvcm1fc2VjcmV0";
  const CARD_VAULT_KEY = "cardSecret";
  const CARD_CACHE_KEY = "cardRechargeCache";
  const CARD_PAGE_SIZE = 100, CARD_MAX_PAGES = 50;
  const PAGES_MAX = 10, PAGE_SIZE = 50, CHUNK = 15;
  const AUTO_REFRESH_MS = 10 * 60 * 1000;

  // ── 左侧校园服务栏 ──
  // 标题与图标不写死：进入插件时抓一次网页元信息（<title> / favicon / 图标名），
  // 抓不到（内网、未登录、断网）就退回下面的 label 与 icon，因此离线也不会空着。
  const QUICK_LINKS = [
    { url: "https://mail.cppu.edu.cn/", label: "教育邮箱", icon: "envelope" },
    // 「教务」是唯一的父项：右侧箭头展开 / 收起，行本身仍是换票开教务（与升级前行为一致）。
    // 教务子项走 `view:`（在 U-Time 里开视图）而不是换票开浏览器：
    // 教务 SPA 完全没有 URL 深链（je-app/je-main/je-core 三个 bundle 都不解析
    // location.hash / location.search，开任何功能地址栏都停在 index.html），
    // 做成链接的话四个入口只会统统落回教务首页，等于同一个入口抄四遍。
    { url: "https://jw.cppu.edu.cn/index.html", label: "教务", icon: "school", children: [
      { view: "cppu-xk", label: "学生选课", icon: "list-check" },
      { view: "cppu-qj", label: "学生请假", icon: "calendar-xmark" },
      { view: "cppu-credit", label: "警大成绩", icon: "chart-line" },
      { view: "cppu-cx", label: "创新学分", icon: "medal" },
      { view: "cppu-calendar", label: "警大校历", icon: "calendar-days" },
    ] },
    { url: "https://xg.cppu.edu.cn/XGPhone/Phone/index.html", label: "学工", icon: "id-card" },
    // 「我的请假」与「学工」同源，只是该 SPA 的 hash 路由（实测路由表里有 /StuDailyLeaveList）。
    // 裸开 index.html 返回 200 静态壳、没有服务端 302，登录由该 SPA 自己的 /Login 路由处理
    // ⇒ 不属于「302 到统一身份认证」那一类，刻意不进 TICKET_LINKS（换票链路不适用）。
    // ⚠️ 用户给的原始地址带一次性授权码与 state 参数（用完即废），绝不能原样写死进来，
    // 否则入口点开必失败；这里只保留裸地址 + hash 路由。
    { url: "https://xg.cppu.edu.cn/XGPhone/Phone/index.html#/StuDailyLeaveList", label: "我的请假", icon: "calendar-check" },
    { url: "https://service.cppu.edu.cn/fe/site/service", label: "一网通办", icon: "clipboard-list" },
    // 一卡通平台（慧新易校 / 新中新）不是 sso-jw/门户体系里的子系统。
    // 直接打开 cardRecharge 这类受保护深链，平台还没建立自己的 H5 session 时会先报「未授权」；
    // 所以这里改成 U-Time 内部视图：先加载一卡通 H5 首页/登录壳，再由视图内按钮跳充值等子页。
    { view: "cppu-card", label: "一卡通", icon: "credit-card" },
  ];
  // 需要登录才能进的入口：点一下不直接开裸地址（那样只会落到统一身份认证登录页），
  // 而是用插件自身那份统一身份认证会话（sso.cppu.edu.cn 的 CASTGC，随 rememberMe 保 5 天）
  // 现场换一张一次性 ticket，交给系统浏览器消费 —— 「教务」因此不需要手填任何 token。
  // 刻意不存 token、也不设「粘贴 token」的输入位：票据只活在这一次点击的内存里，不落盘。
  const TICKET_LINKS = {
    // service 就是裸开 https://jw.cppu.edu.cn/index.html 时 302 里的 cas_callback
    "https://jw.cppu.edu.cn/index.html": {
      service: "https://jw.cppu.edu.cn/cas_callback",
      origin: "https://jw.cppu.edu.cn",
      path: "/cas_callback",
    },
  };
  const LINK_META_TTL = 7 * 24 * 60 * 60 * 1000;   // 识别结果一周内复用，避免每次进插件都抓五个站点
  const LINK_META_KEY = "quickLinkMeta";
  let linkMeta = {};

  // Sudy CAS RSAUtils.encryptedString 忠实移植（126 字符分块，16 位小端打包，非 PKCS#1）
  const MODULUS_HEX = "008aed7e057fe8f14c73550b0e6467b023616ddc8fa91846d2613cdb7f7621e3cada4cd5d812d627af6b87727ade4e26d26208b7326815941492b2204c3167ab2d53df1e3a2c9153bdb7c8c2e968df97a5e7e01cc410f92c4c2c2fba529b3ee988ebc1fca99ff5119e036d732c368acf8beba01aa2fdafa45b21e4de4928d0d403";
  const EXPONENT_HEX = "010001";
  function rsaEncrypt(password) {
    const n = BigInt("0x" + MODULUS_HEX), e = BigInt("0x" + EXPONENT_HEX);
    const chunkSize = 2 * Math.max(0, Math.floor((n.toString(2).length - 1) / 16));
    const a = [...password].map((c) => c.charCodeAt(0));
    while (a.length % chunkSize !== 0) a.push(0);
    const blocks = [];
    for (let i = 0; i < a.length; i += chunkSize) {
      let m = 0n;
      const chunk = a.slice(i, i + chunkSize);
      for (let j = 0; j < chunk.length; j += 2) {
        const word = chunk[j] + ((chunk[j + 1] ?? 0) << 8);
        m |= BigInt(word) << BigInt(16 * (j / 2));
      }
      let r = 1n, b = m % n, ee = e;
      while (ee > 0n) { if (ee & 1n) r = r * b % n; b = b * b % n; ee >>= 1n; }
      blocks.push(r.toString(16));
    }
    return blocks.join(" ");
  }

  const state = {
    sid: null, token: "", username: "", rememberUsername: true, autoLogin: true, autoRefresh: true, loginRetries: 2,
    notices: [], page: 1, hasMore: true,
    fetching: false, error: null, fetchedAt: 0,
    expanded: new Set(),
    details: {},           // rid -> {content, attachments, loading, error}
    seen: new Set(),
    filter: { kw: "", month: "all", kind: "all", hideSeen: false },
    captcha: "", pending: null, renderedCount: CHUNK,
    savedPassword: "",     // 密钥库取出的密码（仅内存，用于自动登录与表单预填）
    sideOpen: false,       // 校园服务栏：默认收起。只活在本次插件会话里，重进插件回到收起
    jwOpen: true,          // 「教务」子菜单：默认展开 —— 这四个入口升级前本来就露在侧栏上，
                           // 默认收起等于把已有功能藏到一次点击之后。同样只活在本次会话里。
  };
  let ui = null, io = null, sentinelCb = null, paintToken = 0, autoRefreshTimer = null;

  function observeSentinel(node, cb) {
    sentinelCb = cb;
    if (io) io.disconnect();
    if (node && io) io.observe(node);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function monthOf(m) {
    const t = Number(m.CREATE_TIME || 0);
    if (!t) return "unknown";
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  function monthLabel(mo) {
    if (mo === "unknown") return "时间未知";
    const [y, m] = mo.split("-");
    return `${y}年${Number(m)}月`;
  }
  const NOTICE_KINDS = [
    { id: "all", label: "全部" },
    { id: "exam", label: "考试" },
    { id: "contest", label: "比赛" },
    { id: "notice", label: "通知" },
  ];
  function noticeKind(it) {
    const hay = `${titleOf(it)} ${it.TYPE_NAME || ""} ${it.BELONG_UNIT_NAME || ""}`.toLowerCase();
    if (/比赛|竞赛|大赛|挑战赛|赛项|参赛|征文|作品征集|技能比武|创新创业/.test(hay)) return NOTICE_KINDS[2];
    if (/考试|考务|期中|期末|补考|缓考|重修|监考|考场|准考证|四六级|cet|普通话|资格证|等级考试|报名缴费/.test(hay)) return NOTICE_KINDS[1];
    return NOTICE_KINDS[3];
  }
  function cleanText(raw) {
    let t = String(raw || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    const ta = document.createElement("textarea");
    ta.innerHTML = t;
    t = ta.value.replace(/&ldquo;/g, "\u201c").replace(/&rdquo;/g, "\u201d");
    const out = [];
    for (const ln of t.split("\n").map((s) => s.trim())) {
      if (ln) out.push(ln);
      else if (!ln && out.length && out[out.length - 1] !== "") out.push("");
    }
    return out.join("\n").trim();
  }
  const titleOf = (it) => String(it.PIM_TITLE || "(无标题)").replace(/&ldquo;/g, "\u201c").replace(/&rdquo;/g, "\u201d");
  const itemKey = (it) => String(it.RESOURCE_ID || "");
  function portalUrl(raw) {
    const s = String(raw || "").trim().replace(/&amp;/gi, "&");
    if (!s) return "";
    try { return new URL(s, PORTAL + "/tp_up/").href; }
    catch { return s; }
  }
  function fileNameFromUrl(url) {
    try {
      const u = new URL(url);
      const last = decodeURIComponent((u.pathname.split("/").filter(Boolean).pop() || "").replace(/\+/g, " "));
      return last || "附件";
    } catch { return "附件"; }
  }
  function safeFileName(name) {
    return String(name || "附件").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "附件";
  }
  function extractAttachments(raw, contentHtml = "") {
    const out = [], seen = new Set();
    const push = (name, url) => {
      const href = portalUrl(url);
      if (!/^https?:\/\//i.test(href) || seen.has(href)) return;
      seen.add(href);
      out.push({ name: safeFileName(cleanText(name) || fileNameFromUrl(href)), url: href });
    };
    const pick = (obj, re) => Object.keys(obj || {}).find((k) => re.test(k) && obj[k] != null && String(obj[k]).trim());
    const links = (html) => String(html || "").replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      push(label, href);
      return "";
    });
    const walk = (v, affix = false) => {
      if (!v) return;
      if (typeof v === "string") {
        const s = v.trim();
        if (affix && /^[\[{]/.test(s)) { try { walk(JSON.parse(s), true); return; } catch { /* 保留原文继续找链接 */ } }
        if (affix) {
          links(s);
          if (/^(?:https?:\/\/|\/?(?:tp_up\/)?uploadfiles\/|\/?tp_up\/)/i.test(s)) push("", s);
        }
        return;
      }
      if (typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach((item) => walk(item, affix)); return; }
      // 门户独立附件接口：AFFIX_NAME 是存储路径，OTHER_NAME 才是展示文件名。
      if (v.AFFIX_NAME && v.OTHER_NAME) push(v.OTHER_NAME, v.AFFIX_NAME);
      const nameKey = pick(v, /^(?:(?:file|attach|attachment|affix|original|origin|real)[_\-]?)?(?:name|title|mc|bt|originalname)$/i);
      const urlKey = pick(v, /^(?:(?:file|attach|attachment|affix|download)[_\-]?)?(?:url|href|path|dz|lj)$/i);
      if (urlKey && urlKey !== "CONTENT_URL" && (affix || nameKey || /file|attach|affix|download/i.test(Object.keys(v).join(" ")))) {
        push(v[nameKey] || "", v[urlKey]);
      }
      Object.entries(v).forEach(([k, val]) => {
        if (k === "CONTENT_URL") return;
        if (/^AFFIX$/i.test(k) && typeof val === "string" && !/^[\[{<]/.test(val.trim()) && /^(?:https?:\/\/|\/)/i.test(val.trim())) push(v[nameKey] || "", val);
        walk(val, affix || /affix|attach|file/i.test(k));
      });
    };
    walk(raw);
    links(contentHtml);
    return out;
  }
  function tokenFromText(...parts) {
    for (const part of parts) {
      const m = String(part || "").match(/tp_up[=;]([^&?;\s"'<>]+)/);
      if (m) return m[1];
    }
    return "";
  }
  function redirectTarget(res, base, expectedOrigin, expectedPath) {
    const raw = String(res?.location || "").trim();
    if (!raw || !(res.status >= 300 && res.status < 400)) return "";
    try {
      const target = new URL(raw, base);
      if (target.protocol !== "https:" || target.origin !== expectedOrigin) return "";
      if (expectedPath && target.pathname !== expectedPath) return "";
      return target.href;
    } catch { return ""; }
  }
  /* Rust 桥回的是摊平后的整条 cause 链 —— reqwest 自己的 Display 只有
     "error sending request for url (…)" 一句，DNS / 连不上 / 超时全藏在后面。
     直接甩给用户等于让人查英文词典，所以按成因分类翻成人话，原串垫在末尾备查。 */
  const NET_WHY = [
    [/operation timed out|timed out/i, "等待响应超时"],
    [/\bdns\b|failed to lookup|getaddrinfo|name not resolved/i, "域名没解析出来"],
    [/certificate|\btls\b|rustls|handshake/i, "HTTPS 握手没通过"],
    [/connection refused|tcp connect|error trying to connect|connect error/i, "连不上服务器"],
    [/connection closed|reset by peer|broken pipe|closed connection/i, "连接被中途掐断"],
  ];
  function explainHttpError(e) {
    const msg = String(e && (e.message || e) || "");
    if (/Failed to fetch|Load failed|NetworkError/i.test(msg)) {
      return "网络桥不可用：浏览器预览会被智慧警大跨域策略拦截，请在桌面版 U-Time 中打开本插件。";
    }
    if (!msg) return "网络请求失败";
    if (!/请求失败|读取响应失败|error sending request/i.test(msg)) return msg;
    const why = (NET_WHY.find(([re]) => re.test(msg)) || [])[1] || "网络没走通";
    return `连不上警大的服务器（${why}），这类抖动稍等片刻再试一次通常就好了。原始：${msg}`;
  }
  /** 传输层抖动（不是登录态失效）：这类失败服务端压根没答话，原样重发是安全的。 */
  const isTransportBlip = (msg) => /error sending request|operation timed out|读取响应失败|\bdns\b|failed to lookup|connection refused|connection closed|broken pipe|getaddrinfo/i.test(String(msg || ""));

  function ensureStyle() {
    if (document.getElementById("pp-notify-style")) return;
    const st = document.createElement("style");
    st.id = "pp-notify-style";
    st.textContent = `
      .pp-wrap{--campus-green:#18783C;max-width:880px;margin:0 auto}
      [data-theme-mode="dark"] .pp-wrap{--campus-green:#72D698}
      .pp-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
      .pp-lab{font-size:calc(11px * var(--ui-text-scale));color:#A9B2BA;letter-spacing:.14em;flex:none;width:34px}
      .pp-chips{display:flex;gap:8px;flex-wrap:wrap;flex:1}
      .pp-kw{flex:1;min-width:170px;height:34px;border:1px solid #E4DFD6;border-radius:9px;padding:0 11px;background:#fff}
      .pp-chip{font-size:calc(12px * var(--ui-text-scale));border:1px solid #E4DFD6;background:#fff;border-radius:16px;padding:6px 13px;cursor:pointer;color:#7E8B94}
      .pp-chip.on{background:#0F4C5C;color:#fff;border-color:#0F4C5C}
      .gx-btn:hover,.pp-btn:hover{border-color:#0F4C5C;color:#0F4C5C}
      .pp-btn{font-size:calc(12px * var(--ui-text-scale));border:1px solid #E4DFD6;border-radius:8px;padding:7px 13px;background:#fff;cursor:pointer;color:#22303A;white-space:nowrap}
      .pp-btn.pri{background:#0F4C5C;color:#fff;border-color:#0F4C5C;font-weight:600}
      .pp-btn.pri:hover{background:#0B3D4A;color:#fff}
      .pp-toggle{display:flex;align-items:center;gap:6px;font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;cursor:pointer;user-select:none}
      .pp-toggle i{width:34px;height:19px;border-radius:10px;background:#D8D2C6;display:inline-block;position:relative;transition:.15s}
      .pp-toggle i::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:.15s}
      .pp-toggle.on i{background:#2EC4B6}
      .pp-toggle.on i::after{left:17px}
      .pp-status{font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;margin:2px 0 8px}
      .pp-status .err{color:#B03535}
      .pp-month{font-size:calc(12.5px * var(--ui-text-scale));font-weight:700;color:#0F4C5C;padding:9px 2px 7px;letter-spacing:.05em}
      .pp-card{background:#fff;border:1px solid #E4DFD6;border-radius:14px;padding:12px 14px;margin-bottom:9px;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 74px;transition:border-color .28s ease,box-shadow .28s ease,background .28s ease}
      .pp-card.open{border-color:#D5DED9;box-shadow:0 7px 24px rgba(34,48,58,.055)}
      .pp-heading{display:block;width:100%;text-align:left;background:transparent;border:0;color:inherit;padding:4px 0;cursor:pointer;font-family:inherit;min-height:44px}
      .pp-expand{margin-top:10px;min-height:44px;display:inline-flex;align-items:center;gap:7px;transition:background .2s ease,border-color .2s ease,color .2s ease}
      .pp-expand::after{content:"⌄";display:inline-block;font-size:calc(14px * var(--ui-text-scale));line-height:1;transform:translateY(-1px) rotate(0deg);transition:transform .36s cubic-bezier(.22,.8,.22,1)}
      .pp-card.open .pp-expand::after{transform:translateY(1px) rotate(180deg)}
      .pp-heading:focus-visible,.pp-btn:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      @media(max-width:600px){.pp-wrap{width:100%;min-width:0}.pp-login{margin:12px auto;padding:20px 16px;max-width:100%;box-sizing:border-box}.pp-title{font-size:calc(17px * var(--ui-text-scale))!important}.pp-meta{font-size:calc(13px * var(--ui-text-scale))!important}.pp-detail .c{font-size:calc(16px * var(--ui-text-scale))!important;max-height:none!important;overflow-wrap:anywhere}.pp-btn,.pp-chip{min-height:44px;font-size:calc(14px * var(--ui-text-scale))!important}.pp-kw{width:100%;flex-basis:100%;box-sizing:border-box;min-height:44px}.pp-card{padding:14px;cursor:default}.pp-caprow input{min-width:0}.pp-detail .pp-act{flex-wrap:wrap}}
      .pp-card:hover{background:#FBFAF5;border-color:#D8D2C4}
      .pp-card.seen{opacity:.6}
      .pp-title{font-size:calc(13.5px * var(--ui-text-scale));font-weight:600;line-height:1.5}
      .pp-meta{display:flex;gap:8px;align-items:center;font-size:calc(11px * var(--ui-text-scale));color:#7E8B94;margin-top:5px;flex-wrap:wrap}
      .pp-tag{border-radius:6px;padding:2px 8px;background:#E1EEF3;color:#0F4C5C;font-size:calc(10px * var(--ui-text-scale))}
      .pp-tag.top{background:#FFF0E1;color:#B26A00}
      .pp-tag.unread{background:#FDE8E8;color:#C64545}
      .pp-tag.kind{background:#F6F3EC;color:#6D5B3F;border:1px solid #E4DFD6}
      .pp-detail-shell{display:grid;grid-template-rows:0fr;opacity:0;margin-top:0;transition:grid-template-rows .42s cubic-bezier(.2,.78,.2,1),opacity .24s ease,margin-top .42s cubic-bezier(.2,.78,.2,1)}
      .pp-card.open .pp-detail-shell{grid-template-rows:1fr;opacity:1;margin-top:10px}
      .pp-detail-clip{min-height:0;overflow:hidden}
      .pp-detail{border-top:1px dashed #EFEAE1;padding-top:10px;transform:translateY(-7px);transition:transform .36s cubic-bezier(.2,.78,.2,1)}
      .pp-card.open .pp-detail{transform:translateY(0)}
      .pp-detail .c{font-size:calc(12px * var(--ui-text-scale));color:#4B565E;line-height:1.9;white-space:pre-wrap;max-height:320px;overflow-y:auto;overscroll-behavior:contain}
      .pp-detail .pp-act{display:flex;gap:8px;margin-top:10px}
      .pp-att-list{margin-top:10px;border:1px solid #E4DFD6;border-radius:10px;background:#FBFAF5;padding:9px 10px}
      .pp-att-list>b{display:block;font-size:calc(11px * var(--ui-text-scale));color:#0F4C5C;margin-bottom:6px}
      .pp-att{display:flex;align-items:center;gap:8px;width:100%;padding:8px 2px;border:0;border-top:1px dashed var(--line);background:transparent;text-align:left;cursor:pointer;min-width:0;color:var(--ink)}
      .pp-att:hover,.pp-att:focus-visible{color:var(--deep);background:var(--paper)}
      .pp-att:first-of-type{border-top:0}
      .pp-att span:first-child{flex:1;min-width:0;overflow-wrap:anywhere;font-size:calc(12px * var(--ui-text-scale))}
      .pp-att-action{flex:none;font-size:calc(11px * var(--ui-text-scale));color:var(--deep)}
      .pp-login{max-width:440px;margin:26px auto;background:#fff;border:1px solid #E4DFD6;border-radius:18px;padding:28px 30px;box-shadow:0 2px 10px rgba(34,48,58,.07)}
      .pp-login h3{font-size:calc(16px * var(--ui-text-scale));margin-bottom:4px}
      .pp-login .d{font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;line-height:1.7;margin-bottom:12px}
      .pp-login label{display:block;font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;margin:12px 0 5px}
      .pp-login input{width:100%;height:38px;border:1px solid #E4DFD6;border-radius:9px;padding:0 12px;background:#fff;box-sizing:border-box}
      .pp-caprow{display:flex;gap:10px;align-items:flex-end}
      .pp-caprow .capbox{flex:none;width:120px;text-align:center;cursor:pointer}
      .pp-caprow img{width:120px;height:40px;border:1px solid #E4DFD6;border-radius:8px;background:#fff;display:block}
      .pp-caprow small{font-size:calc(10px * var(--ui-text-scale));color:#A9B2BA;display:block;margin-top:3px}
      .pp-login .err{color:#B03535;font-size:calc(12px * var(--ui-text-scale));margin-top:10px;min-height:16px}
      .pp-login .sec{font-size:calc(10.5px * var(--ui-text-scale));color:#A9B2BA;margin-top:12px;line-height:1.7}
      .pp-login .saved{background:#F6FBFA;border:1px solid #D6EBE8;color:#42656A;border-radius:10px;padding:9px 11px;font-size:calc(12px * var(--ui-text-scale));line-height:1.65;margin:10px 0 12px}
      .pp-empty{border:1.5px dashed #CFC8BA;border-radius:12px;padding:20px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.8}
      .pp-banner{background:#FFF7E8;border:1px solid #F2D9A6;color:#8A6420;border-radius:12px;padding:12px 15px;font-size:calc(12px * var(--ui-text-scale));line-height:1.8;margin-bottom:10px}
      .pp-more{display:flex;justify-content:center;padding:8px 0 4px}
      .pp-more .pp-btn{padding:8px 20px;font-size:calc(12px * var(--ui-text-scale))}
      /* ── 左侧校园服务栏：只用主题变量配色，夜里自动跟随深色 ── */
      .pp-shell{display:flex;align-items:flex-start;max-width:1180px;margin:0 auto;padding:0 20px;box-sizing:border-box;width:100%}
      .pp-main{flex:1;min-width:0}
      /* 校园服务栏可收起：收 / 展靠 .pp-side 的 width 过渡，.pp-main 是 flex:1 会跟着一起走
         （这就是「警大通知随收缩而动」）。内层固定宽度 + 外层 overflow:hidden --
         否则宽度动画期间文字一直在重排，看着很脏。
         🔴 内层宽度必须是【卡片的内容盒】宽，不能照抄卡片的 214px 外框宽：214 会让内层比
         内容盒宽 24px，多出来的部分被 overflow:hidden 裁掉 —— 右对齐的东西只会剩半个
         （「重新识别」的 ↻ 就是这么被裁的）。190 = 214 − 2×1px 边框 − 2×11px 内边距，
         改 .pp-side 的 width 或 padding 时必须一起改（test-cppu.mjs 有算式守卫）。
         展开方向 = 内层 transform-origin:left top 的缩放，内容自左上角往右下角长出来。 */
      .pp-side{width:214px;flex:none;position:sticky;top:16px;margin-right:16px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:11px 11px 9px;box-shadow:0 1px 6px rgba(34,48,58,.05);overflow:hidden;transition:width .34s cubic-bezier(.22,.8,.22,1),margin-right .34s cubic-bezier(.22,.8,.22,1),padding .34s cubic-bezier(.22,.8,.22,1),border-width .3s ease,opacity .24s ease}
      .pp-side-inner{width:190px;transform-origin:left top;transition:transform .34s cubic-bezier(.22,.8,.22,1),opacity .26s ease}
      .pp-shell.side-collapsed .pp-side{width:0;margin-right:0;padding-left:0;padding-right:0;border-left-width:0;border-right-width:0;opacity:0}
      .pp-shell.side-collapsed .pp-side-inner{transform:scale(.88) translate(-10px,-10px);opacity:0}
      /* 收起后留在原地的把手。它是 .pp-shell 的正经 flex 子项（不是浮层），所以永远压不住正文；
         展开时 max-width 收到 0，与侧栏的 width 过渡同时进行 → 没有跳变。
         sticky 保证列表滚很长时也够得着。 */
      .pp-side-toggle{flex:none;display:inline-flex;align-items:center;gap:7px;font-family:inherit;font-size:calc(12px * var(--ui-text-scale));font-weight:600;color:var(--deep);background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:8px 12px;cursor:pointer;box-shadow:0 1px 6px rgba(34,48,58,.06);position:sticky;top:8px;align-self:flex-start;z-index:4;white-space:nowrap;overflow:hidden;max-width:160px;max-height:52px;margin-right:12px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:max-width .34s cubic-bezier(.22,.8,.22,1),max-height .34s cubic-bezier(.22,.8,.22,1),padding .34s cubic-bezier(.22,.8,.22,1),margin-right .34s cubic-bezier(.22,.8,.22,1),border-width .3s ease,opacity .24s ease,background .16s ease}
      .pp-side-toggle:hover,.pp-side-toggle:active{background:var(--paper)}
      .pp-side-toggle:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      .pp-shell:not(.side-collapsed) .pp-side-toggle{max-width:0;max-height:0;padding-top:0;padding-bottom:0;padding-left:0;padding-right:0;margin-right:0;border-width:0;opacity:0;pointer-events:none}
      /* 头部：就是一个「收起」按钮（与收起后的把手 .pp-side-toggle 同一套视觉）。
         原来这里是 10.5px 灰金小字标题 + 右上角 18px 小三角，两个都太弱（v1.5.0 换成按钮）；
         当时还留着一条 border-bottom 分隔线，可卡片边框 + 这条线正好把头部圈成一个多余的方框，
         右边那个「重新识别」的 ↻ 又因为内层比卡片内容盒宽 24px 被 overflow:hidden 裁掉半个
         —— 两个都删掉（v1.6.0）。 */
      .pp-side-head{display:flex;align-items:center;padding:0 0 9px;margin-bottom:7px}
      .pp-side-head-toggle{flex:1 1 auto;min-width:0;display:inline-flex;align-items:center;gap:7px;font-family:inherit;font-size:calc(12px * var(--ui-text-scale));font-weight:600;letter-spacing:normal;color:var(--deep);background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:8px 12px;cursor:pointer;box-shadow:0 1px 6px rgba(34,48,58,.06);touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .16s ease}
      .pp-side-head-toggle:hover,.pp-side-head-toggle:active{background:var(--paper)}
      .pp-side-head-toggle:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      .pp-side-list{display:flex;flex-direction:column;gap:3px}
      .pp-side-btn{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;border-radius:10px;padding:6px 8px;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit;min-height:46px;transition:background .16s ease,color .16s ease}
      .pp-side-btn:hover{background:var(--paper);color:var(--deep)}
      .pp-side-btn:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      /* 换票要往返 1~3 次请求，期间给出「正在处理」的视觉反馈，避免点了像没反应 */
      .pp-side-btn[aria-busy="1"]{opacity:.55;cursor:progress}
      .pp-side-ico{width:28px;height:28px;flex:none;border-radius:9px;background:var(--paper);border:1px solid var(--line-soft);display:grid;place-items:center;overflow:hidden}
      .pp-side-ico img{width:17px;height:17px;object-fit:contain}
      .pp-side-ico svg{width:14px;height:14px;fill:var(--deep)}
      .pp-side-txt{min-width:0;display:flex;flex-direction:column;gap:1px}
      .pp-side-txt b{font-size:calc(12.5px * var(--ui-text-scale));font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:142px}
      .pp-side-txt small{font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:142px}
      .pp-side-note{font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3);line-height:1.6;padding:8px 4px 1px;border-top:1px solid var(--line-soft);margin-top:7px}
      /* ── 「教务」父项与子菜单 ── */
      /* 整行按钮 + 右侧独立箭头。button 不能嵌 button，所以两者是 .pp-side-row 的兄弟而非父子。 */
      .pp-side-row{display:flex;align-items:stretch;gap:2px}
      .pp-side-row>.pp-side-btn{flex:1;min-width:0}
      .pp-side-sub-btn{flex:none;width:30px;display:grid;place-items:center;border:0;background:transparent;border-radius:9px;color:var(--ink-3);font-family:inherit;font-size:calc(11px * var(--ui-text-scale));cursor:pointer;transition:background .16s ease,color .16s ease;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
      .pp-side-sub-btn:hover{background:var(--paper);color:var(--deep)}
      .pp-side-sub-btn:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      /* 展开沿用仓库既有的 grid-template-rows 0fr→1fr（.pp-detail-shell / .id-fold-body 同款），
         内层必须 min-height:0 + overflow:hidden 才真能从 0 长起来。
         visibility 收拢时延后 .3s（等折叠跑完）、展开时三通道延迟全归零 ——
         只靠 aria-hidden 的话，折叠着的四个子项还能被 Tab 走到。 */
      .pp-side-sub{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;transition:grid-template-rows .3s cubic-bezier(.22,.8,.22,1),opacity .22s ease,visibility 0s .3s}
      .pp-side-sub.open{grid-template-rows:1fr;opacity:1;visibility:visible;transition-delay:0s,0s,0s}
      .pp-side-sub-in{min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:3px}
      /* 子项：缩进一档 + 去掉「在 U-Time 内查看」副行（四行已经够高，副行是噪音） */
      .pp-side-sub .pp-side-btn{padding-left:22px;min-height:38px}
      .pp-side-sub .pp-side-txt small{display:none}
      .pp-side-sub .pp-side-ico{width:22px;height:22px;border-radius:7px}
      .pp-side-sub .pp-side-ico svg{width:12px;height:12px}
      .pp-side-sub .pp-side-ico img{width:14px;height:14px}
      /* ── 教务只读视图（选课 / 请假 / 创新学分）：一律用主题变量，深色模式自动跟随 ── */
      .jw-kicker{font-size:calc(11px * var(--ui-text-scale));letter-spacing:.3em;color:var(--ink-3);margin:16px 0 4px}
      .jw-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
      .jw-head h3{font-size:calc(19px * var(--ui-text-scale));font-weight:700;color:var(--deep);margin:0}
      .jw-head span{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3)}
      .jw-tip{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3);line-height:1.75;margin:2px 0 6px}
      .jw-sec{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:calc(12.5px * var(--ui-text-scale));font-weight:700;color:var(--deep);padding:14px 2px 8px;letter-spacing:.04em}
      .jw-sec small{font-weight:400;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3)}
      .jw-group{font-size:calc(11.5px * var(--ui-text-scale));font-weight:600;color:var(--deep);padding:8px 2px 6px;border-bottom:1px solid var(--line-soft);margin-bottom:8px}
      .jw-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:11px 13px;margin-bottom:8px}
      .jw-card-t{font-size:calc(13.5px * var(--ui-text-scale));font-weight:600;line-height:1.5;color:var(--ink)}
      .jw-why{font-size:calc(11.5px * var(--ui-text-scale));line-height:1.8;color:var(--ink-3);margin-top:7px;padding-top:7px;border-top:1px dashed var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
      .jw-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:7px 4px;border-bottom:1px solid var(--line-soft);font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3)}
      .jw-row b{color:var(--ink);font-weight:600;font-size:calc(12px * var(--ui-text-scale))}
      .jw-row span{color:var(--deep);font-weight:600}
      .jw-row small{flex:1;min-width:120px}
      .jw-tag{display:inline-block;border-radius:6px;padding:2px 8px;background:var(--paper);border:1px solid var(--line-soft);color:var(--deep);font-size:calc(10.5px * var(--ui-text-scale))}
      .jw-tag.ok{background:rgba(46,196,182,.14);border-color:rgba(46,196,182,.45);color:#0B6B60}
      .jw-tag.warn{background:rgba(242,217,166,.24);border-color:#E3C384;color:#8A6420}
      .jw-tag.live{background:rgba(220,53,69,.13);border-color:rgba(220,53,69,.52);color:#B42318;font-weight:700}
      /* 上面三个语义色是浅色硬编码，深色面板上实测只有 1.38~2.17:1 —— 「1 学分」这种
         10.5px 小字几乎读不出。深色必须整组重给：底色改成同色相浅掺（比 --panel 更深，
         沿用 --q*-bg 的「深底亮字」路子），文字把强调色与 --ink 混亮。
         公式与宿主 styles.css 的「内置插件深色兼容层」一致，16 套主题下都过 5.3:1。 */
      [data-theme-mode="dark"] .jw-tag.ok{background:color-mix(in srgb,var(--mint) 18%,var(--panel));border-color:color-mix(in srgb,var(--mint) 42%,transparent);color:color-mix(in srgb,var(--mint) 55%,var(--ink))}
      [data-theme-mode="dark"] .jw-tag.warn{background:color-mix(in srgb,var(--sun) 18%,var(--panel));border-color:color-mix(in srgb,var(--sun) 42%,transparent);color:color-mix(in srgb,var(--sun) 55%,var(--ink))}
      [data-theme-mode="dark"] .jw-tag.live{background:color-mix(in srgb,var(--danger) 18%,var(--panel));border-color:color-mix(in srgb,var(--danger) 42%,transparent);color:color-mix(in srgb,var(--danger) 55%,var(--ink))}
      .jw-tag.credit,[data-theme-mode="dark"] .jw-tag.credit{color:var(--campus-green);background:color-mix(in srgb,var(--campus-green) 12%,var(--panel));border-color:color-mix(in srgb,var(--campus-green) 36%,var(--line))}
      .jw-credit-value,.jg-metrics b.jw-credit-value{color:var(--campus-green)}
      .jw-task-card{display:block;width:100%;font:inherit;text-align:left;color:inherit;cursor:pointer;transition:border-color .16s ease,background .16s ease,opacity .16s ease;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
      .jw-task-card:hover{border-color:var(--deep);background:var(--paper)}
      .jw-task-card:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      .jw-task-card.live{border-color:rgba(220,53,69,.55);box-shadow:inset 3px 0 0 #D93645}
      .jw-task-card.expired{opacity:.54;filter:grayscale(.32);background:var(--paper)}
      .jw-task-card.expired:hover{opacity:.68}
      .jw-task-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:8px 0 10px}
      .jw-task-detail-head .jw-card-t{font-size:calc(16px * var(--ui-text-scale));color:var(--deep)}
      .jw-task-courses{margin-top:8px}
      .jw-card-act{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
      .jw-card-act .pp-btn{min-height:34px;padding:5px 10px;font-size:calc(11.5px * var(--ui-text-scale))}
      .jw-leave-draft{margin-top:10px;border-top:1px dashed var(--line);padding-top:10px}
      .jw-leave-draft textarea{width:100%;min-height:82px;resize:vertical;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);padding:9px 10px;font:inherit;font-size:calc(12px * var(--ui-text-scale));line-height:1.7}
      .jw-leave-draft small,.jw-detail-grid small{display:block;color:var(--ink-3);font-size:calc(10.5px * var(--ui-text-scale));line-height:1.7;margin-top:6px}
      .jw-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:7px;margin-top:10px;padding-top:9px;border-top:1px dashed var(--line)}
      .jw-detail-cell{background:var(--paper);border:1px solid var(--line-soft);border-radius:10px;padding:8px 10px;min-width:0}
      .jw-detail-cell b{display:block;color:var(--ink-3);font-size:calc(10px * var(--ui-text-scale));font-weight:500;margin-bottom:3px}
      .jw-detail-cell span{display:block;color:var(--ink);font-size:calc(11.5px * var(--ui-text-scale));line-height:1.55;overflow-wrap:anywhere}
      .jw-sum{display:flex;align-items:baseline;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:6px 0 10px}
      .jw-sum b{font-size:calc(30px * var(--ui-text-scale));color:var(--campus-green);line-height:1}
      .jw-sum span{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3)}
      .jw-credit-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:8px 0 4px}
      .jw-credit-stat{display:block;width:100%;font:inherit;text-align:left;color:inherit;cursor:pointer;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0;transition:border-color .16s ease,background .16s ease;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
      .jw-credit-stat:hover{border-color:var(--deep);background:var(--paper)}
      .jw-credit-stat:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      .jw-credit-stat.on{border-color:#2EC4B6;background:var(--paper)}
      .jw-credit-stat small{display:block;color:var(--ink-3);font-size:calc(10.5px * var(--ui-text-scale));margin-bottom:5px}
      .jw-credit-stat b{display:block;color:var(--campus-green);font-size:calc(22px * var(--ui-text-scale));line-height:1.2}
      .jw-credit-stat span{display:block;color:var(--ink-3);font-size:calc(10.5px * var(--ui-text-scale));margin-top:4px}
      .jw-credit-stat em{display:block;color:var(--ink-3);font-style:normal;font-size:calc(10px * var(--ui-text-scale));margin-top:7px}
      .jw-credit-detail{animation:jw-credit-in .26s ease both}
      .jw-credit-detail.out{animation:jw-credit-out .2s ease both}
      @keyframes jw-credit-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
      @keyframes jw-credit-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-8px)}}
      .jw-credit-bar{height:7px;border-radius:99px;background:var(--paper);border:1px solid var(--line-soft);overflow:hidden;margin-top:9px}
      .jw-credit-bar i{display:block;height:100%;background:#2EC4B6;border-radius:inherit}
      .jw-credit-course.done{opacity:.62}
      .jw-credit-course.fail{border-color:rgba(220,53,69,.48)}
      .jw-cx-project{border-left:3px solid #2EC4B6}
      .jw-cx-project.pending{border-left-color:#E3C384}
      .jw-cx-term{margin-top:12px}.jw-cx-term>summary{display:flex;align-items:baseline;gap:8px;cursor:pointer;color:var(--deep);font-weight:700;padding:10px 2px;border-bottom:1px solid var(--line);list-style:none}.jw-cx-term>summary::-webkit-details-marker,.jw-cx-project>summary::-webkit-details-marker{display:none}.jw-cx-term>summary::before,.jw-cx-project>summary::before{content:"▸";font-size:calc(12px * var(--ui-text-scale));color:var(--ink-3);transition:transform .15s}.jw-cx-term[open]>summary::before,.jw-cx-project[open]>summary::before{transform:rotate(90deg)}.jw-cx-term>summary small{font-size:calc(10.5px * var(--ui-text-scale));font-weight:400;color:var(--ink-3)}.jw-cx-project{margin-top:8px}.jw-cx-project>summary{display:flex;align-items:flex-start;gap:8px;cursor:pointer;list-style:none}.jw-cx-project>summary .jw-card-t{min-width:0;flex:1;overflow-wrap:anywhere}.jw-cx-project>summary .jw-tag{flex:none}.jw-cx-project .pp-meta{margin-top:7px}.jw-cx-project .jw-detail-grid{margin-bottom:2px}
      .jw-cx-project>summary{flex-wrap:wrap}.jw-cx-project>summary .jw-card-t{flex-basis:calc(100% - 24px)}
      .jg-status{padding:12px 16px 8px;font-size:calc(15px * var(--ui-text-scale));font-weight:700;color:var(--ink);line-height:1.5}
      .jg-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:6px 0}
      .jg-card h4{margin:0 0 8px;color:var(--deep);font-size:calc(13.5px * var(--ui-text-scale));font-weight:700}
      .jg-metrics{display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid var(--line-soft)}
      .jg-metrics>div{display:flex;flex-direction:column;gap:2px;padding:6px 0 10px;min-width:0}
      .jg-metrics small{color:var(--ink-3);font-size:calc(11px * var(--ui-text-scale))}
      .jg-metrics b{color:var(--ink);font-size:calc(19px * var(--ui-text-scale))}
      .jg-divider{height:1px;background:var(--line-soft);margin:4px 0}
      .jg-note{color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale));line-height:1.55;margin:4px 0 7px}
      .jg-pair,.jg-course{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:calc(12.5px * var(--ui-text-scale))}
      .jg-pair span{color:var(--ink-3);flex:1;min-width:0}.jg-pair b{color:var(--ink);font-weight:700;text-align:right}
      .jg-bar-row{padding:4px 0}.jg-bar-row>div:first-child{display:flex;justify-content:space-between;gap:8px;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale))}
      .jg-bar-row b{font-size:calc(12.5px * var(--ui-text-scale))}.jg-track{height:8px;background:var(--paper);border-radius:4px;overflow:hidden;margin-top:3px}.jg-track i{display:block;height:100%;border-radius:4px;min-width:0}
      .jg-segments{height:14px;background:var(--paper);border-radius:4px;overflow:hidden;display:flex;margin:2px 0 6px}.jg-segments i{height:100%;display:block}
      .jg-good{color:#1B7F4B}.jg-mid{color:var(--deep)}.jg-warn{color:#B06A00}.jg-bad{color:#C8102E}.jg-muted{color:var(--ink-3)}
      .jg-track .jg-good{background:#1B7F4B}.jg-track .jg-mid{background:#1B3A6B}.jg-track .jg-warn{background:#B06A00}.jg-track .jg-bad{background:#C8102E}
      [data-theme-mode="dark"] .jg-good{color:#4ADE80}[data-theme-mode="dark"] .jg-mid{color:#60A5FA}[data-theme-mode="dark"] .jg-warn{color:#FBBF24}[data-theme-mode="dark"] .jg-bad{color:#F87171}
      .jg-export{display:block;width:100%;min-height:42px;margin:8px 0 0}.jg-course{border-top:1px solid var(--line-soft);padding:4px 0}.jg-course:first-of-type{border:0}.jg-course span{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--ink)}.jg-course b{width:34px;font-size:calc(13px * var(--ui-text-scale));text-align:right}.jg-course small{width:30px;color:var(--ink-3);font-size:calc(11px * var(--ui-text-scale));text-align:right}
      .yk-frame-shell{margin-top:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;min-height:620px;height:calc(100vh - 190px);box-shadow:0 1px 10px rgba(34,48,58,.05)}
      [data-card-web][hidden],[data-card-stats][hidden]{display:none!important}
      .yk-frame{display:block;width:100%;height:100%;border:0;background:var(--paper)}
      .yk-status{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3);line-height:1.7;margin:7px 0 0}
      .yk-status.warn{color:#8A6420}
      .yk-stat{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:10px 0}
      .yk-total,.yk-spent,.yk-balance{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
      .yk-total small,.yk-spent small,.yk-balance small{display:block;color:var(--ink-3);font-size:calc(10.5px * var(--ui-text-scale));margin-bottom:4px}
      .yk-total b,.yk-spent b,.yk-balance b{display:block;color:var(--deep);font-size:calc(30px * var(--ui-text-scale));line-height:1.15}
      .yk-balance b{color:var(--campus-green)}
      .yk-spent b{color:var(--danger)}
      [data-theme-mode="dark"] .yk-status.warn{color:color-mix(in srgb,var(--sun) 55%,var(--ink))}
      .yk-total span,.yk-spent span,.yk-balance span{display:block;color:var(--ink-3);font-size:calc(11px * var(--ui-text-scale));line-height:1.7;margin-top:4px}
      .yk-login{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;display:grid;grid-template-columns:minmax(140px,1fr) minmax(160px,1fr) auto;gap:8px;align-items:center}
      .yk-login input{min-width:0;height:36px;border:1px solid var(--line);border-radius:9px;background:var(--paper);color:var(--ink);padding:0 10px;font:inherit;font-size:calc(12px * var(--ui-text-scale))}
      .yk-login small{grid-column:1/-1;color:var(--ink-3);font-size:calc(10.5px * var(--ui-text-scale));line-height:1.7}
      .yk-account{grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale))}
      .yk-account b{color:var(--ink)}
      .yk-groups{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:10px}
      .yk-group-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
      .yk-group-head b{font-size:calc(12.5px * var(--ui-text-scale));color:var(--deep)}
      .yk-bars{display:flex;flex-direction:column;gap:6px}
      .yk-bar{display:grid;grid-template-columns:92px 1fr 88px;align-items:center;gap:8px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink)}
      .yk-bar i{display:block;height:9px;border-radius:99px;background:linear-gradient(90deg,#2EC4B6,#0F4C5C);min-width:2px}
      .yk-bars.out .yk-bar i{background:var(--danger)}
      .yk-bars.out .yk-bar span:last-child{color:var(--danger)}
      .yk-bar span:last-child{text-align:right;color:var(--deep);font-weight:650}
      .yk-ledger{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:10px}
      .yk-ledger-row{display:grid;grid-template-columns:100px 1fr auto;gap:8px;align-items:center;padding:7px 0;border-top:1px solid var(--line-soft);font-size:calc(11.5px * var(--ui-text-scale))}
      .yk-ledger-row:first-child{border-top:0}
      .yk-ledger-row b{color:var(--deep)}
      .yk-ledger-row.out b{color:var(--danger)}
      .yk-empty{color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale));line-height:1.7}
      @media(max-width:600px){.jw-card-t{font-size:calc(14.5px * var(--ui-text-scale))}.jw-head h3{font-size:calc(17px * var(--ui-text-scale))}.jw-sum b{font-size:calc(26px * var(--ui-text-scale))}.jw-row small{min-width:0;flex-basis:100%}.jw-credit-overview{grid-template-columns:1fr}}
      @media(max-width:820px){
        .pp-shell{flex-direction:column;padding:0 14px}
        /* 窄屏时侧栏是整层叠在正文上面的，收起要收"高度"而不是宽度 */
        .pp-side{width:100%;position:static;padding:10px;margin-right:0;margin-bottom:12px;max-height:1400px;transition:max-height .34s cubic-bezier(.22,.8,.22,1),margin-bottom .34s cubic-bezier(.22,.8,.22,1),padding .34s cubic-bezier(.22,.8,.22,1),border-width .3s ease,opacity .24s ease}
        .pp-side-inner{width:100%}
        .pp-shell.side-collapsed .pp-side{width:100%;max-height:0;padding-top:0;padding-bottom:0;margin-bottom:0;border-top-width:0;border-bottom-width:0;opacity:0}
        /* 手机上的两个开关（收起后的把手 / 展开态头部的收起按钮）都要 44px 触控区，手指才点得准 */
        .pp-side-toggle{margin-right:0;margin-bottom:12px;max-width:100%;min-height:44px;padding:10px 14px;font-size:calc(13px * var(--ui-text-scale))}
        .pp-side-head-toggle{min-height:44px;padding:10px 14px;font-size:calc(13px * var(--ui-text-scale))}
        /* 展开时把手要整体藏掉：min-height 会压过 max-height，所以必须把 min-height 也归零，
           否则窄屏上会在侧栏与正文之间留一条 44px 的隐形空隙 */
        .pp-shell:not(.side-collapsed) .pp-side-toggle{margin-bottom:0;min-height:0}
        .pp-side-list{flex-direction:row;flex-wrap:wrap}
        .pp-side-btn{width:auto;flex:1 1 132px;min-width:0;min-height:52px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
        /* 窄屏侧栏是换行的 chip 流，不是竖列：父项 = chip + 箭头的实际宽度，且刻意不给 flex-grow
           —— 给了它会在自己那行里撑满，箭头被推到最右边、和教务 chip 中间空一大段。
           箭头 44px 触控区并描一圈边，否则在 chip 流里只像个游离的小灰点，读不出是个按钮。
           子菜单整体独占一行、里面的子项继续按 chip 换行排；
           子项的缩进在 chip 流里没有意义（那是竖列的层级线索），退回常规内边距。 */
        .pp-side-row{flex:0 0 auto}
        .pp-side-row>.pp-side-btn{flex:1 1 132px}
        .pp-side-sub-btn{width:44px;border:1px solid var(--line);background:var(--panel)}
        .pp-side-sub{flex:1 1 100%}
        .pp-side-sub-in{flex-direction:row;flex-wrap:wrap}
        .pp-side-sub .pp-side-btn{padding-left:8px;min-height:44px}
        /* 手机上工具栏不能靠自动换行碰运气（原来「刷新」会独占一整行）：
           关键词搜索独占一行，其余按钮/开关挤一行，并统一给到 44px 的点击高度 */
        .pp-toolbar{gap:8px}
        .pp-kw{flex:1 1 100%;order:2;min-width:0;height:44px}
        .pp-toolbar>span:not(.pp-lab){order:1}
        .pp-toolbar>.pp-btn,.pp-toggle{order:1;min-height:44px}
        .pp-toolbar>.pp-btn{padding:0 14px;font-size:calc(13px * var(--ui-text-scale))}
        .pp-side-txt b,.pp-side-txt small{max-width:96px}
        .pp-side-note{display:none}
        .yk-stat{grid-template-columns:1fr}
        .yk-login{grid-template-columns:1fr}
        .yk-login small{grid-column:auto}
        .yk-login .pp-btn{min-height:44px}
        .yk-bar{grid-template-columns:78px 1fr 76px}
        .yk-ledger-row{grid-template-columns:86px 1fr auto}
        .yk-frame-shell{height:calc(100vh - 230px);min-height:520px}
      }
      @media(prefers-reduced-motion:reduce){.pp-card,.pp-expand,.pp-expand::after,.pp-detail-shell,.pp-detail,.pp-side,.pp-side-inner,.pp-side-toggle,.pp-side-sub{transition-duration:.01ms!important}}
    `;
    document.head.append(st);
  }

  async function loadPrefs() {
    const f = await tide.storage.get("filter", null);
    if (f) state.filter = { ...state.filter, ...f };
    state.username = (await tide.storage.get("username", "")) || "";
    state.rememberUsername = await tide.storage.get("rememberUsername", true) !== false;
    state.autoLogin = await tide.storage.get("autoLogin", true) !== false;
    state.autoRefresh = await tide.storage.get("autoRefresh", true) !== false;
    state.loginRetries = cleanLoginRetries(await tide.storage.get("loginRetries", 2));
    state.seen = new Set(await tide.storage.get("seen", []));
    if (state.autoLogin && typeof tide.vault?.get === "function") {
      try { state.savedPassword = JSON.parse((await tide.vault.get("secret")) || "null")?.password || ""; } catch { state.savedPassword = ""; }
    }
  }
  const saveFilter = () => tide.storage.set("filter", state.filter);
  const saveSeen = () => tide.storage.set("seen", [...state.seen].slice(-500));

  // 缓存数据而非登录页面，恢复时重新渲染，凭据仍只存密钥库。
  async function saveNoticeCache() {
    try {
      const details = {};
      const notices = state.notices.slice(0, PAGE_SIZE * PAGES_MAX);
      for (const item of notices) {
        const key = itemKey(item), detail = state.details[key];
        if (detail && !detail.loading && !detail.error) details[key] = detail;
      }
      await tide.storage.set("noticeCache", { username: state.username, notices, details, at: state.fetchedAt });
    } catch { /* 写失败不影响已加载页面 */ }
  }
  async function restoreNoticeCache() {
    try {
      const cache = await tide.storage.get("noticeCache", null);
      if (!cache || cache.username !== state.username || !Array.isArray(cache.notices)) return false;
      state.notices = cache.notices;
      state.details = cache.details && typeof cache.details === "object" ? cache.details : {};
      state.fetchedAt = Number(cache.at) || 0;
      state.hasMore = false;
      return true;
    } catch { return false; }
  }
  async function showNoticeCache(el, error) {
    if (!await restoreNoticeCache() || !el.isConnected) return false;
    state.error = `登录或连接失败，正在显示缓存（${state.fetchedAt ? new Date(state.fetchedAt).toLocaleString("zh-CN") : "更新时间未知"}）。${error || "可点击重新登录重试。"}`;
    buildMain(el);
    return true;
  }

  /* ── 登录态持久化：Cookie 存密钥库，重启后恢复会话免验证码 ── */
  async function saveCookies() {
    if (typeof tide.vault?.set !== "function" || !state.sid) return;
    try {
      const dump = await tide.http.exportCookies(state.sid, [SSO, JW, PORTAL, JWAPP]);
      if (dump.length) await tide.vault.set("cookies", JSON.stringify(dump));
    } catch { /* 密钥库不可用（浏览器调试）时静默跳过 */ }
  }

  async function restoreCookies() {
    if (typeof tide.vault?.get !== "function") return false;
    try {
      const raw = await tide.vault.get("cookies");
      const dump = raw ? JSON.parse(raw) : null;
      if (Array.isArray(dump) && dump.length) {
        state.sid = await tide.http.restoreCookies(dump);
        // tp_up 本身也保存在门户 Cookie 中。先恢复它可直接复用仍有效的门户会话，
        // 即使主 SSO 的 CASTGC 已失效，也不必立刻退回验证码登录。
        state.token = tokenFromText(...dump.map((row) => row?.cookie));
        // 教务（jw.cppu.edu.cn）的 authorization 若在 dump 里，本会话就省一次换票；
        // 判域名要精确到 https://jw.：sso-jw.cppu.edu.cn 也带 jw.，误判会让教务请求白跑。
        if (dump.some((row) => String(row?.url || "").startsWith(JWAPP) && /authorization=/i.test(String(row?.cookie || "")))) jwSid = state.sid;
        return !!state.sid;
      }
    } catch { /* 票据损坏按无票据处理 */ }
    return false;
  }

  async function clearSavedLogin() {
    state.savedPassword = "";
    jwSid = null;
    jwState.data = { xkTask: null, xkResult: null, qjRecord: null, qjCourse: null, creditPlan: null, creditModule: null, grade: null, cxCredit: null, cxDetail: null };
    try {
      await tide.vault?.del?.("secret");
      await tide.vault?.del?.("cookies");
    } catch { /* ignore */ }
  }

  /* ── SSO 登录链路 ── */
  async function newSession() { if (!state.sid) state.sid = await tide.http.session(); }
  const referer = () => PORTAL + "/tp_up/view;tp_up=" + state.token + "?m=up";

  async function getPage(url, useBinary = false, opts = {}) {
    try {
      return await tide.http.fetch(state.sid, "GET", url, { ...opts, binary: useBinary });
    } catch (e) {
      throw new Error(explainHttpError(e));
    }
  }

  async function fetchLoginHtml() {
    const res = await getPage(LOGIN_URL);
    const m = res.body.match(/name="execution" value="([^"]+)"/);
    if (!m) throw new Error("登录页加载异常（网络或站点不可达）");
    return m[1];
  }

  async function fetchCaptcha() {
    const res = await getPage(SSO + "/tpass/captcha.jpg?tt=" + Math.random(), true);
    if (res.status !== 200) throw new Error("验证码获取失败");
    state.captcha = "data:image/jpeg;base64," + res.body;
    // 更新页面上所有验证码图（登录表单/换图按钮共用）
    document.querySelectorAll("img[data-cap]").forEach((img) => { img.src = state.captcha; });
    return state.captcha;
  }

  /* ══ 验证码识别（纯 JS，无外部运行时）══
     警大 SSO 验证码：4 位数字、每个数字一种颜色、叠加贯穿细线。
     识别管线：解码 → Otsu 二值化 → 连通域去线去噪 → x 区间分组 →
     归一化 16×16 位图 → 与「内置字体模板 + 历史确认样本」匹配。
     单次识别有误差，由自动登录层用「识别失败就换图重试」兜底；
     登录成功后样本回存，识别率随使用快速提升。 */
  const OCR = (() => {
    const N = 16;
    const SAMPLE_MAX = 240;

    // —— 纯函数：区域归一化（最近邻缩放到 N×N 二值位图）——
    function normalizeRegion(w, get, x0, y0, bw, bh) {
      const out = new Array(N * N).fill(0);
      for (let ry = 0; ry < N; ry++) {
        const sy = Math.min(y0 + bh - 1, y0 + Math.floor((ry + 0.5) * bh / N));
        for (let rx = 0; rx < N; rx++) {
          const sx = Math.min(x0 + bw - 1, x0 + Math.floor((rx + 0.5) * bw / N));
          out[ry * N + rx] = get(sx, sy) ? 1 : 0;
        }
      }
      return out;
    }

    // —— 纯函数：Jaccard 相似度 ——
    function similarity(a, b) {
      let inter = 0, union = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] && b[i]) inter++;
        if (a[i] || b[i]) union++;
      }
      return union ? inter / union : 0;
    }

    // —— 纯函数：分类（内置模板 + 历史样本里取最优匹配）——
    function classify(bits, templates, samples) {
      let best = { d: -1, score: 0 };
      for (const t of templates) {
        const s = similarity(bits, t.bits);
        if (s > best.score) best = { d: t.d, score: s };
      }
      for (const smp of samples || []) {
        // 样本可能来自 storage（"0101…" 字符串）或当次识别（数组）
        const arr = typeof smp.b === "string" ? [...smp.b].map(Number) : smp.b;
        const s = similarity(bits, arr) * 1.02; // 同源样本略加权
        if (s > best.score) best = { d: smp.d, score: s };
      }
      return best;
    }

    // —— 纯函数：连通域按 x 区间重叠合并成字符组 ——
    function groupByX(comps) {
      const sorted = [...comps].sort((a, b) => a.minX - b.minX);
      const groups = [];
      for (const c of sorted) {
        const g = groups.find((g) => c.minX <= g.maxX + 1 && c.maxX >= g.minX - 1);
        if (g) {
          g.pix.push(...c.pix);
          g.minX = Math.min(g.minX, c.minX); g.maxX = Math.max(g.maxX, c.maxX);
          g.minY = Math.min(g.minY, c.minY); g.maxY = Math.max(g.maxY, c.maxY);
        } else {
          groups.push({ pix: [...c.pix], minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY });
        }
      }
      return groups.sort((a, b) => a.minX - b.minX);
    }

    // —— 纯函数：连通域标记（8 邻接）——
    function components(w, h, get) {
      const seen = new Uint8Array(w * h);
      const comps = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!get(x, y) || seen[y * w + x]) continue;
          const pix = [];
          const stack = [y * w + x];
          seen[y * w + x] = 1;
          let minX = x, maxX = x, minY = y, maxY = y;
          while (stack.length) {
            const cur = stack.pop();
            const cx = cur % w, cy = (cur / w) | 0;
            pix.push(cur);
            if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const ni = ny * w + nx;
              if (!seen[ni] && get(nx, ny)) { seen[ni] = 1; stack.push(ni); }
            }
          }
          comps.push({ pix, minX, maxX, minY, maxY, size: pix.length });
        }
      }
      return comps;
    }

    // —— Otsu 全局阈值（返回值配合「亮度 < 阈值 = 墨迹」使用，取最大方差点右移一位）——
    function otsu(histogram, total) {
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * histogram[i];
      let sumB = 0, wB = 0, best = 0, threshold = 127;
      for (let t = 0; t < 256; t++) {
        wB += histogram[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * histogram[t];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; threshold = t; }
      }
      return threshold + 1;
    }

    // —— 内置模板：运行时用 canvas 多字体渲染 0-9 生成（含轻微旋转/斜体变化）——
    let templates = null;
    function buildTemplates() {
      if (templates || typeof document === "undefined") return templates || [];
      templates = [];
      const S = 44;
      const cv = document.createElement("canvas");
      cv.width = S; cv.height = S;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return [];
      const fonts = [
        'bold 30px Georgia, serif', 'bold 30px "Times New Roman", serif',
        'bold 30px Arial, sans-serif', 'bold 30px Verdana, sans-serif',
        'italic bold 30px Georgia, serif', 'serif',
      ];
      for (let d = 0; d <= 9; d++) {
        for (const font of fonts) {
          for (const rot of [-0.1, 0, 0.1]) {
            ctx.clearRect(0, 0, S, S);
            ctx.save();
            ctx.translate(S / 2, S / 2);
            ctx.rotate(rot);
            ctx.font = font;
            ctx.fillStyle = "#000";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(d), 0, 1);
            ctx.restore();
            const data = ctx.getImageData(0, 0, S, S).data;
            const get = (x, y) => data[(y * S + x) * 4 + 3] > 100;
            const box = tightBox(S, S, get);
            if (!box) continue;
            templates.push({ d, bits: normalizeRegion(S, get, box.x0, box.y0, box.w, box.h) });
          }
        }
      }
      return templates;
    }

    function tightBox(w, h, get) {
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!get(x, y)) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return null;
      return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }

    // —— 历史确认样本（登录成功 = 当次识别全部正确，回存提升识别率）——
    async function loadSamples() {
      try { const s = await tide.storage.get("ocrSamples", []); return Array.isArray(s) ? s.slice(-SAMPLE_MAX) : []; }
      catch { return []; }
    }
    async function confirmSamples(samples) {
      if (!Array.isArray(samples) || !samples.length) return;
      const mine = samples.map((s) => ({ b: String(s.b || "").slice(0, N * N), d: s.d | 0 }));
      const all = (await loadSamples()).concat(mine).slice(-SAMPLE_MAX);
      try { await tide.storage.set("ocrSamples", all); } catch { /* ignore */ }
    }

    // —— 主入口：dataURL → {code, confidence, samples} ——
    async function recognize(dataUrl) {
      if (typeof document === "undefined" || !dataUrl) return { code: "", confidence: 0, samples: [] };
      const img = new Image();
      img.src = dataUrl;
      try { await img.decode(); } catch { return { code: "", confidence: 0, samples: [] }; }
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h || w > 600 || h > 300) return { code: "", confidence: 0, samples: [] };
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return { code: "", confidence: 0, samples: [] };
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;

      // Otsu 二值化：墨迹 = 亮度低于阈值
      const histogram = new Array(256).fill(0);
      const lum = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const l = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0;
        lum[i] = l;
        histogram[l]++;
      }
      const t = otsu(histogram, w * h);
      const get = (x, y) => lum[y * w + x] < t;

      // 连通域：去噪点、去贯穿细线（宽超过画面 55% 的组件是那条波浪线）
      const comps = components(w, h, get)
        .filter((c) => c.size >= 8 && (c.maxX - c.minX) < w * 0.55);
      if (!comps.length) return { code: "", confidence: 0, samples: [] };

      // x 重叠合并 → 期望 4 个字符组
      let groups = groupByX(comps);
      // 兜底：多余组按 x 均分（细线断片可能被当成独立组）
      if (groups.length > 4) {
        const xs = groups.map((g) => (g.minX + g.maxX) / 2);
        const step = (Math.max(...xs) - Math.min(...xs)) / 4;
        const merged = [[], [], [], []];
        groups.forEach((g, i) => merged[Math.min(3, Math.max(0, Math.floor((xs[i] - xs[0]) / step)))].push(g));
        groups = merged
          .map((list) => list.length ? list.reduce((acc, g) => ({
            minX: Math.min(acc.minX, g.minX), maxX: Math.max(acc.maxX, g.maxX),
            minY: Math.min(acc.minY, g.minY), maxY: Math.max(acc.maxY, g.maxY),
            pix: acc.pix.concat(g.pix),
          })) : null)
          .filter(Boolean);
      }
      if (groups.length !== 4) return { code: "", confidence: 0, samples: [] };

      const lib = buildTemplates();
      const samples = await loadSamples();
      let code = "", worst = 1;
      const out = [];
      for (const g of groups) {
        const getG = (x, y) => g.pix.includes(y * w + x);
        const bits = normalizeRegion(w, getG, g.minX, g.minY, g.maxX - g.minX + 1, g.maxY - g.minY + 1);
        const hit = classify(bits, lib, samples);
        if (hit.d < 0 || hit.score < 0.18) return { code: "", confidence: 0, samples: [] };
        worst = Math.min(worst, hit.score);
        code += String(hit.d);
        out.push({ b: bits.join(""), d: hit.d });
      }
      return { code, confidence: worst, samples: out };
    }

    return { recognize, confirmSamples, loadSamples, normalizeRegion, similarity, classify, groupByX, components, otsu };
  })();

  /* ── 自动登录：恢复票据 → 静默续期 → 密码 + 验证码识别兜底 ── */
  // retry 次数不含首次提交；只读一次设置，进行中的操作不受设置修改影响。
  const cleanLoginRetries = value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 5 ? Number(value) : 2;
  let loginBusy = false;
  let loginHint = null;
  const loginErrorText = e => String(e?.fatal || e?.retry || e?.message || "登录未成功");

  async function runLoginAttempts({ username, password, code = "", onRetry = () => {}, isActive = () => true }) {
    if (loginBusy) throw { fatal: "已有登录正在进行，请稍候" };
    loginBusy = true;
    let retries = cleanLoginRetries(state.loginRetries);
    let samples = null, recognized = false;
    const checkActive = () => { if (!isActive()) throw { fatal: "登录页面已关闭，已停止后续重试" }; };
    try {
      retries = cleanLoginRetries(await tide.storage.get("loginRetries", retries));
      state.loginRetries = retries;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          checkActive();
          if (attempt || !code) {
            if (attempt) {
              onRetry(`登录未成功，正在准备第 ${attempt}/${retries} 次自动重试…`);
              await new Promise(resolve => setTimeout(resolve, Math.min(800 * 2 ** (attempt - 1), 4000)));
              checkActive();
            }
            // 每次自动尝试均使用新的 Cookie、execution 和验证码，绝不重放旧 POST。
            state.sid = null; await newSession(); checkActive();
            state.pending = { username, password, execution: await fetchLoginHtml() };
            await fetchCaptcha(); checkActive();
            const ocr = await OCR.recognize(state.captcha);
            if (!ocr?.code) throw { retry: "验证码未识别，请手动填写", retryable: true };
            code = ocr.code; samples = ocr.samples; recognized = true;
          } else {
            state.pending = { username, password, execution: state.pending?.execution };
          }
          checkActive();
          await submitLogin(code);
          if (recognized && samples) OCR.confirmSamples(samples);
          return { recognized };
        } catch (error) {
          if (error?.fatal || error?.retryable === false || attempt === retries || !isActive()) {
            // 耗尽后仍准备可用的人工表单；不额外提交登录请求，也不覆盖原始错误。
            if (isActive()) {
              try { state.sid = null; await newSession(); state.pending = { execution: await fetchLoginHtml() }; await fetchCaptcha(); } catch { state.pending = null; state.captcha = ""; }
            }
            throw error;
          }
        }
      }
    } finally {
      if (state.pending) delete state.pending.password;
      loginBusy = false;
    }
  }

  /* 密码兜底与人工按钮共享重试边界、退避和全新会话流程。 */
  async function passwordAutoLogin() {
    loginHint = null;
    if (!state.autoLogin || !state.username || !state.savedPassword) return false;
    try {
      await runLoginAttempts({ username: state.username, password: state.savedPassword });
      await persistCredentials(state.savedPassword);
      await saveCookies();
      tide.notify("已自动完成登录（含验证码识别）");
      return true;
    } catch (error) {
      loginHint = { msg: `${loginErrorText(error)}；请核对账号和验证码后重试`, code: "" };
      return false;
    }
  }

  function loginSettingsHtml() {
    return '<button type="button" class="pp-btn" data-login-settings style="margin:14px 0">警大登录设置</button>';
  }
  function bindLoginSettings(el) {
    el.querySelector("[data-login-settings]")?.addEventListener("click", () => tide.util.openSettings("cppu-login"));
  }

  // 人工登录表单要能立刻提交，得先把 execution 和一张验证码抓回来
  async function prepareLoginForm() {
    if (loginBusy) return;
    try {
      await newSession();
      state.pending = { execution: await fetchLoginHtml() };
      await fetchCaptcha();
    } catch { state.captcha = ""; }
  }

  async function autoLogin(el) {
    // ① 恢复上次会话票据（CASTGC 有效期内直达，不碰验证码）
    const restored = await restoreCookies();
    if (!restored) await newSession();
    if (state.token) {
      // Cookie 中的 tp_up 可能已过期：先用列表接口做真实校验，失败后继续走
      // 主 SSO/密码兜底，不能把用户留在只有“会话过期”的空列表页。
      if (await loadPage(1)) { buildMain(el); return true; }
      state.token = "";
      state.error = null;
    }
    if (await silentRenew()) {
      await saveCookies();
      tide.notify("已自动恢复门户登录，正在打开通知");
      buildMain(el);
      loadPage(1);
      return true;
    }
    // ② 票据失效：有保存的密码就走「验证码识别 + 换图重试」全自动登录
    if (await passwordAutoLogin()) {
      buildMain(el);
      loadPage(1);
      return true;
    }
    // ③ 兜底：登录表单，账号/密码/最后一次识别结果全部预填，人工只需核对。
    // 压根没存过凭据时 loginHint 是空的，交给 render 摆一张空白表单。
    if (await showNoticeCache(el, loginHint?.msg)) return true;
    if (!loginHint) return false;
    await prepareLoginForm();
    paintLogin(el, loginHint.msg, { prefillCode: loginHint.code });
    return false;
  }

  async function persistCredentials(password) {
    if (!state.autoLogin || typeof tide.vault?.set !== "function") return;
    try {
      await tide.vault.set("secret", JSON.stringify({ password }));
      state.savedPassword = password;
    } catch { /* 密钥库不可用时跳过 */ }
  }

  async function finishPortalTicket(loginRes) {
    const direct = tokenFromText(loginRes?.finalUrl, loginRes?.location, loginRes?.body, ...(loginRes?.cookies || []));
    if (direct) { state.token = direct; return true; }
    const portalTicket = redirectTarget(loginRes, SILENT_LOGIN, PORTAL);
    if (!portalTicket) return false;
    const portal = await getPage(portalTicket, false, { followRedirects: false }).catch(() => null);
    const token = tokenFromText(portal?.finalUrl, portal?.location, portal?.body, ...(portal?.cookies || []));
    if (token) { state.token = token; return true; }
    return false;
  }

  async function finishPortalLogin(firstRes) {
    const direct = tokenFromText(firstRes?.finalUrl, firstRes?.location, firstRes?.body, ...(firstRes?.cookies || []));
    if (direct) { state.token = direct; return true; }

    // CAS ticket 是一次性的，必须像原 skill 一样逐段消费，不能让 HTTP 客户端
    // 自动跨 sso → sso-jw → portal 跟到底，否则桥接端会把最终 500 当登录结果。
    const bridgeUrl = redirectTarget(firstRes, LOGIN_URL, JW, "/tpass/bridge");
    if (!bridgeUrl) return false;
    const bridge = await getPage(bridgeUrl, false, { followRedirects: false }).catch(() => null);
    if (!bridge) return false;

    const renew = await getPage(SILENT_LOGIN, false, { followRedirects: false }).catch(() => null);
    return finishPortalTicket(renew);
  }

  async function submitLogin(code) {
    const p = state.pending;
    if (!p || !p.username || !p.password) {
      // 缺凭据时绝不提交（否则 POST 体是 username=undefined，服务端会 500）
      throw { retry: "内部错误：登录凭据未就绪，已重置流程", diag: "pending 缺少 username/password" };
    }
    let res;
    try {
      res = await tide.http.fetch(state.sid, "POST", LOGIN_URL, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": LOGIN_URL,
        },
        body: `username=${encodeURIComponent(p.username)}&password=${encodeURIComponent(rsaEncrypt(p.password))}` +
          `&authcode=${encodeURIComponent(code)}&execution=${encodeURIComponent(p.execution)}` +
          `&encrypted=true&_eventId=submit&loginType=1&rememberMe=true&submit=${encodeURIComponent("登 录")}`,
        followRedirects: false,
      });
    } catch (e) {
      throw { retry: explainHttpError(e), retryable: true };
    }
    if (await finishPortalLogin(res)) { state.pending = null; return; }
    const body = res.body || "";
    let msg = null;
    if (/密码错误|账号或密码/.test(body)) throw { fatal: "账号或密码错误" };
    const plain = cleanText(body);
    const mm = plain.match(/((?:验证码|密码|账号|用户名|锁定|禁止|失败|不正确|不允许|过期)[^\n。；;]{0,40})/);
    if (mm) msg = mm[1].trim();
    // 由统一重试控制器刷新会话，避免这里刷新失败掩盖原始 HTTP 状态。
    if (res.status === 429 || /账号.{0,10}(锁定|冻结|停用)|账户.{0,10}(锁定|冻结|停用)|尝试次数|操作频繁|禁止登录/.test(plain)) throw { fatal: msg || "账号受限或请求过频，请稍后手动登录" };
    const isServerErr = res.status >= 500;
    const diag = isServerErr
      ? `诊断：HTTP ${res.status} · 服务端异常（可能与会话或 execution 有关），将按设置换新会话重试`
      : `诊断：HTTP ${res.status} · 登录未建立，请核对验证码`;
    throw {
      retry: msg || `登录未通过（HTTP ${res.status}），请核对验证码或稍后重试`,
      diag,
      status: res.status,
      retryable: isServerErr || res.status === 302 || (res.status === 200 && /验证码|过期|execution/i.test(msg || plain)),
    };
  }

  // 静默续期：先试桥接端；若只剩主 SSO 的 CASTGC，则补走一次主 SSO → bridge 后再换门户票据。
  async function silentRenew() {
    // 先试 sso-jw 自己的 CASTGC；若只有主 SSO 的 CASTGC，再由 finishPortalLogin
    // 显式完成主 SSO → bridge → sso-jw → portal，所有一次性 ticket 均只消费一次。
    const renew = await getPage(SILENT_LOGIN, false, { followRedirects: false }).catch(() => null);
    if (await finishPortalTicket(renew)) return true;
    const primary = await getPage(LOGIN_URL, false, { followRedirects: false }).catch(() => null);
    return finishPortalLogin(primary);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  function startAutoRefresh(el) {
    stopAutoRefresh();
    if (!state.autoRefresh) return;
    autoRefreshTimer = setInterval(() => {
      if (!el.isConnected) { stopAutoRefresh(); return; }
      if (document.visibilityState !== "hidden" && state.token && !state.fetching) loadPage(1);
    }, AUTO_REFRESH_MS);
  }

  /* ── 插件联动：第 1 页抓到新通知时广播 notice:new，微信推送插件按插件勾选合并推送 ──
     判「新」用「上次第 1 页的 RESOURCE_ID 快照」，不复用界面上的已读集合 state.seen ——
     那个只在点开详情/转提醒时才写，拿它差分等于每次刷新都把没点开的旧通知重推一遍。
     没有快照键（首次抓取）只记不广播，否则一登录成功就把整页历史通知推到微信。 */
  async function broadcastNew(items) {
    const stored = await tide.storage.get("knownIds", null);
    const known = new Set(Array.isArray(stored) ? stored : []);
    const fresh = stored === null ? [] : items.filter((it) => itemKey(it) && !known.has(itemKey(it)));
    await tide.storage.set("knownIds", items.map(itemKey).filter(Boolean));
    if (!fresh.length) return;
    try {
      tide.events.emit("notice:new", {
        source: "cppu-notify", sourceName: "警大门户", total: fresh.length,
        items: fresh.slice(0, 5).map((it) => {
          const t = Number(it.CREATE_TIME || 0);
          return {
            title: titleOf(it),
            time: t ? new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "",
            sender: String(it.CREATE_USER_NAME || ""),
          };
        }),
      });
    } catch {}
  }
  function publishNotices() {
    try {
      tide.messages?.publish(state.notices.slice(0, 80).map((it) => ({
        title: titleOf(it), time: it.CREATE_TIME ? new Date(Number(it.CREATE_TIME)).toLocaleString("zh-CN") : "",
        sender: String(it.CREATE_USER_NAME || ""),
      })));
    } catch {}
  }

  /* ── 通知数据 ── */
  async function loadPage(page = 1, renewed = false) {
    if (state.fetching) return;
    state.fetching = true;
    paintStatus();
    try {
      let res;
      try {
        res = await tide.http.fetch(state.sid, "POST", PORTAL + "/tp_up/up/pim/allpim/getAllPimList", {
          headers: {
            "Content-Type": "application/json;charset=utf-8",
            "Referer": referer(),
            "Cookie": "tp_up=" + state.token,
          },
          body: JSON.stringify({ pageNum: page, pageSize: PAGE_SIZE }),
        });
      } catch (e) {
        throw new Error(explainHttpError(e));
      }
      if (res.status !== 200) throw new Error(`列表接口 HTTP ${res.status}，会话可能已过期`);
      let d;
      try { d = JSON.parse(res.body); } catch { throw new Error("会话已过期，请重新登录"); }
      if (!Array.isArray(d.list)) throw new Error("列表格式异常或会话已过期，请重新登录");
      const items = d.list;
      if (page === 1) state.notices = items;
      else {
        const ids = new Set(state.notices.map((x) => x.RESOURCE_ID));
        state.notices = state.notices.concat(items.filter((x) => !ids.has(x.RESOURCE_ID)));
      }
      publishNotices();
      state.page = page;
      state.hasMore = items.length >= PAGE_SIZE && page < PAGES_MAX;
      state.fetchedAt = Date.now();
      state.error = null;
      await saveNoticeCache();
      // v0.11.0：新通知先进入统一收件箱，用户确认后再转任务，避免自动化误建日程。
      if (page === 1 && tide.inbox && typeof tide.inbox.create === "function") {
        for (const it of items.slice(0, 12)) {
          const title = titleOf(it);
          const key = itemKey(it);
          tide.inbox.create({ sourceKey: `cppu:${key}`, title, note: "警大门户新通知 · 打开通知详情后可进一步识别日期和时间", suggestion: "create-task" });
        }
      }
      if (page === 1) await broadcastNew(items);
    } catch (e) {
      // 会话过期先尝试静默续期一次
      if (!renewed && await silentRenew()) {
        state.fetching = false;
        return loadPage(page, true);
      }
      const error = String(e.message || e);
      const cached = await restoreNoticeCache();
      state.error = cached ? `连接失败，正在显示缓存（${state.fetchedAt ? new Date(state.fetchedAt).toLocaleString("zh-CN") : "更新时间未知"}）。${error}` : error;
    }
    state.fetching = false;
    paintAll();
    return !state.error;
  }

  async function loadDetail(rid, force = false) {
    const cur = state.details[rid] || {};
    if (cur.loading || (!force && (cur.detailVersion === 2 || (!state.token && (cur.content || cur.attachments))))) return;
    state.details[rid] = { ...cur, loading: true };
    updateDetail(rid);
    try {
      let res;
      try {
        res = await tide.http.fetch(state.sid, "POST", PORTAL + "/tp_up/up/pim/showpim/getPimDetailInfoById", {
          headers: {
            "Content-Type": "application/json;charset=utf-8",
            "Referer": referer(),
            "Cookie": "tp_up=" + state.token,
          },
          body: JSON.stringify({ RESOURCE_ID: rid }),
        });
      } catch (e) {
        throw new Error(explainHttpError(e));
      }
      if (res.status !== 200) throw new Error(`详情接口 HTTP ${res.status}`);
      const arr = JSON.parse(res.body);
      const d = Array.isArray(arr) ? arr[0] : null;
      if (!d) throw new Error("通知详情格式异常或会话已过期");
      let text = d.PIM_CONTENT || "", contentData = null, contentError = "", attachmentError = "", affixes = [];
      const cu = d.CONTENT_URL || "";
      if (cu) {
        const url = portalUrl(cu);
        try {
          const cres = await getPage(url, false, { headers: { "Referer": referer(), "Cookie": "tp_up=" + state.token } });
          if (cres.status !== 200) throw new Error(`正文接口 HTTP ${cres.status}`);
          const mm = cres.body.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
          let obj;
          try { obj = JSON.parse(mm ? mm[1] : cres.body); contentData = obj; text = obj.result || obj.content || text; }
          catch { text = cres.body; }
        } catch (e) { contentError = String(e.message || e); }
      }
      // 附件与正文独立获取；任一路失败仍展示另一路，且允许重试。
      try {
        const ares = await tide.http.fetch(state.sid, "POST", PORTAL + "/tp_up/up/pim/showpim/getPimAffixList", {
          headers: { "Content-Type": "application/json;charset=utf-8", "Referer": referer(), "Cookie": "tp_up=" + state.token },
          body: JSON.stringify({ RESOURCE_ID: rid }),
        });
        if (ares.status !== 200) throw new Error(`附件列表接口 HTTP ${ares.status}`);
        affixes = JSON.parse(ares.body);
        if (!Array.isArray(affixes)) throw new Error("附件列表格式异常或会话已过期");
      } catch (e) { attachmentError = String(e.message || e); }
      state.details[rid] = {
        content: cleanText(text) || cleanText(d.PIM_CONTENT),
        attachments: extractAttachments([arr, contentData, affixes], text),
        contentError, attachmentError, detailVersion: contentError || attachmentError ? 0 : 2,
      };
      await saveNoticeCache();
    } catch (e) {
      state.details[rid] = { error: String(e.message || e) };
    }
    updateDetail(rid);
  }

  async function downloadAttachment(att) {
    const name = safeFileName(att.name);
    try {
      const res = await tide.http.fetch(state.sid, "GET", att.url, {
        headers: { "Referer": referer(), "Cookie": "tp_up=" + state.token },
        binary: true,
      });
      if (res.status !== 200 || !res.body) throw new Error(`附件接口 HTTP ${res.status}`);
      // 门户票据过期时下载链接会 200 返回一张登录页，不拦就会存下一个打不开的"附件"
      if (/text\/html/i.test(res.contentType || "")) throw new Error("门户会话已过期，请重新打开插件登录后再下载");
      const path = await tide.assets.saveBase64(name, res.body);
      tide.notify(`已保存到下载目录：${path}`, { ms: 8000 });
    } catch (e) {
      tide.notify(`「${name}」下载失败：${explainHttpError(e)}`);
    }
  }

  /* ── 过滤与渲染 ── */
  function filtered() {
    const kw = state.filter.kw.trim().toLowerCase();
    const rows = state.notices.filter((it) => {
      if (state.filter.month !== "all" && monthOf(it) !== state.filter.month) return false;
      if (state.filter.kind !== "all" && noticeKind(it).id !== state.filter.kind) return false;
      if (state.filter.hideSeen && state.seen.has(itemKey(it))) return false;
      if (kw) {
        const hay = `${titleOf(it)} ${it.CREATE_USER_NAME || ""} ${it.BELONG_UNIT_NAME || ""} ${it.TYPE_NAME || ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    return rows.sort((a, b) => Number(b.IS_TOP || 0) - Number(a.IS_TOP || 0) || Number(b.CREATE_TIME || 0) - Number(a.CREATE_TIME || 0));
  }

  function paintStatus() {
    if (!ui) return;
    if (state.fetching && !state.notices.length) { ui.status.innerHTML = "正在拉取通知…"; return; }
    if (state.error) { ui.status.innerHTML = `<span class="err">${esc(state.error)}</span>`; return; }
    const at = state.fetchedAt ? new Date(state.fetchedAt).toTimeString().slice(0, 5) : "—";
    ui.status.innerHTML = `${esc(state.username ? "学号 " + state.username : "")} · 已更新 ${at} · 拉取 ${state.notices.length} 条 · 显示 <b>${filtered().length}</b> 条`;
  }

  function paintChips() {
    if (!ui) return;
    const kindCounts = { all: state.notices.length, exam: 0, contest: 0, notice: 0 };
    for (const it of state.notices) kindCounts[noticeKind(it).id] = (kindCounts[noticeKind(it).id] || 0) + 1;
    ui.kinds?.replaceChildren(...NOTICE_KINDS.map((c) => {
      const b = document.createElement("button");
      b.className = "pp-chip" + (state.filter.kind === c.id ? " on" : "");
      b.textContent = `${c.label}${kindCounts[c.id] ? ` ${kindCounts[c.id]}` : ""}`;
      b.addEventListener("click", () => { state.filter.kind = c.id; saveFilter(); paintChips(); paintList(true); });
      return b;
    }));
    const months = [...new Set(state.notices.map(monthOf))].filter((mo) => mo !== "unknown").sort().reverse();
    ui.months.replaceChildren(...[{ id: "all", label: "全部" }, ...months.map((mo) => ({ id: mo, label: monthLabel(mo) }))].map((c) => {
      const b = document.createElement("button");
      b.className = "pp-chip" + (state.filter.month === c.id ? " on" : "");
      b.textContent = c.label;
      b.addEventListener("click", () => { state.filter.month = c.id; saveFilter(); paintChips(); paintList(true); });
      return b;
    }));
    ui.filterSummary.textContent = `筛选${state.filter.kind !== "all" || state.filter.month !== "all" || state.filter.hideSeen ? " · 已设置" : ""}`;
    ui.hs.classList.toggle("on", !!state.filter.hideSeen);
  }

  function detailHtml(rid) {
    const det = state.details[rid];
    const attachments = Array.isArray(det?.attachments) ? det.attachments : [];
    const attHtml = attachments.length ? `<div class="pp-att-list"><b>附件 ${attachments.length}</b>${attachments.map((a, i) => `
      <button type="button" class="pp-att" data-attach-download="${i}" title="下载附件：${esc(a.name)}" aria-label="下载附件：${esc(a.name)}">
        <span>${esc(a.name)}</span><span class="pp-att-action">下载 ↓</span>
      </button>`).join("")}</div>` : "";
    const content = det?.content ? esc(det.content) : attachments.length ? "本通知内容在附件中，请下载下方文件查看。" : "门户未提供正文或附件。";
    const warnings = [det?.contentError, det?.attachmentError].filter(Boolean);
    const retryHtml = warnings.length ? `<div class="err">${esc(warnings.join("；"))}</div><button class="pp-btn" data-retry>重试加载正文和附件</button>` : "";
    return !det || det.loading ? "正在加载正文…" :
      det.error ? `<span style="color:#B03535;font-size:calc(12px * var(--ui-text-scale))">${esc(det.error)}</span><button class="pp-btn" data-retry>重试加载正文</button>` :
      `<div class="c">${content}</div>${attHtml}${retryHtml}<div class="pp-act"><button class="pp-btn" data-remind>转为提醒</button></div>`;
  }

  function updateDetail(rid) {
    if (!ui?.list) return;
    const card = [...ui.list.querySelectorAll(".pp-card")].find((node) => node.dataset.rid === rid);
    const detail = card?.querySelector("[data-detail-content]");
    if (detail) detail.innerHTML = detailHtml(rid);
  }

  function setCardExpanded(card, open) {
    if (!card) return;
    card.classList.toggle("open", open);
    card.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.setAttribute("aria-expanded", String(open));
      if (btn.classList.contains("pp-expand")) btn.firstChild && (btn.firstChild.textContent = open ? "收起正文" : "展开正文");
      if (btn.classList.contains("pp-heading")) {
        const title = btn.textContent.trim();
        btn.setAttribute("aria-label", `${title}，${open ? "收起正文" : "展开正文"}`);
      }
    });
    card.querySelector(".pp-detail-shell")?.setAttribute("aria-hidden", String(!open));
  }

  function cardHtml(it) {
    const rid = itemKey(it);
    const key = rid;
    const isNew = !state.seen.has(key);
    const t = Number(it.CREATE_TIME || 0);
    const timeStr = t ? new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const open = state.expanded.has(rid);
    const kind = noticeKind(it);
    return `<div class="pp-card${open ? " open" : ""}" data-rid="${esc(rid)}">
      <button class="pp-title pp-heading" data-toggle aria-expanded="${open}" aria-label="${esc(titleOf(it))}，${open ? "收起正文" : "展开正文"}">${esc(titleOf(it))}</button>
      <div class="pp-meta">
        ${it.IS_TOP === "1" ? '<span class="pp-tag top">置顶</span>' : ""}
        ${it.IS_READ === "0" ? '<span class="pp-tag unread">未读</span>' : ""}
        <span class="pp-tag kind">${esc(kind.label)}</span>
        ${it.TYPE_NAME ? `<span class="pp-tag">${esc(it.TYPE_NAME)}</span>` : ""}
        <span>发布：${esc(it.CREATE_USER_NAME || "—")}（${esc(it.BELONG_UNIT_NAME || "—")}）</span>
        <span>${timeStr}</span>
        ${isNew ? '<span class="pp-tag unread">NEW</span>' : ""}
      </div>
      <button class="pp-btn pp-expand" data-toggle aria-expanded="${open}"><span>${open ? "收起正文" : "展开正文"}</span></button>
      <div class="pp-detail-shell" aria-hidden="${!open}"><div class="pp-detail-clip"><div class="pp-detail" data-detail-content>${detailHtml(rid)}</div></div></div>
    </div>`;
  }

  function paintList(reset) {
    if (!ui) return;
    if (reset) state.renderedCount = CHUNK;
    const rows = filtered();
    const slice = rows.slice(0, state.renderedCount);
    const token = ++paintToken;

    if (!slice.length) {
      ui.list.innerHTML = `<div class="pp-empty">${state.notices.length
        ? "没有符合过滤条件的通知<br>试试换个关键词或切回「全部」月份"
        : state.error ? "" : "还没有通知，点上方「刷新」拉取"}</div>`;
      return;
    }

    let html = "", lastMonth = "";
    const counts = {};
    for (const it of rows) counts[monthOf(it)] = (counts[monthOf(it)] || 0) + 1;
    for (const it of slice) {
      const mo = monthOf(it);
      if (mo !== lastMonth) {
        html += `<div class="pp-month">${esc(monthLabel(mo))} · ${counts[mo]} 条</div>`;
        lastMonth = mo;
      }
      html += cardHtml(it);
    }
    ui.list.innerHTML = html;

    const more = document.createElement("div");
    more.className = "pp-more";
    if (state.renderedCount < rows.length) {
      const b = document.createElement("button");
      b.className = "pp-btn";
      b.textContent = `▾ 显示更多（本页还有 ${rows.length - state.renderedCount} 条）`;
      b.addEventListener("click", () => { if (token === paintToken) { state.renderedCount += CHUNK; paintList(); } });
      more.append(b);
    } else if (state.hasMore) {
      const b = document.createElement("button");
      b.className = "pp-btn";
      b.textContent = state.fetching ? "正在加载更早的通知…" : `加载更早的通知（第 ${state.page + 1} 页）`;
      b.addEventListener("click", () => { if (token === paintToken) loadPage(state.page + 1); });
      more.append(b);
    } else if (state.notices.length) {
      more.innerHTML = `<div style="font-size:calc(11px * var(--ui-text-scale));color:#A9B2BA">已加载的通知全部展示</div>`;
    }
    ui.list.append(more);

    // 哨兵元素：滚到底自动补渲染下一块（IO 异步触发，不占滚动帧）
    if (state.renderedCount < rows.length) {
      const sentinel = document.createElement("div");
      sentinel.style.height = "1px";
      ui.list.append(sentinel);
      observeSentinel(sentinel, () => {
        if (token !== paintToken) return;
        state.renderedCount += CHUNK;
        paintList();
      });
    }
  }

  function paintAll() { paintStatus(); paintChips(); paintList(); }

  async function toReminder(it) {
    const title = titleOf(it);
    const det = state.details[itemKey(it)];
    const content = det && det.content ? det.content : "";
    const p = tide.util.parseWhen(`${title} ${cleanText(content).slice(0, 300)}`);
    const cat = tide.util.guessCategory(`${title} ${content}`);
    const task = tide.tasks.create({
      title, quad: tide.util.guessQuad(p.date),
      estMin: p.endMin ? p.endMin - p.startMin : 60,
      due: p.date, tags: ["警大通知"],
      note: PORTAL + "/tp_up/view?m=up",
    });
    if (p.date && p.startMin !== null) {
      const placement = tide.blocks.createSmart({ date: p.date, start: tide.util.hhmmOf(p.startMin), durMin: p.endMin ? p.endMin - p.startMin : 60, title, taskId: task.id, cat });
      tide.notify(placement.moved
        ? `已创建提醒：「${title.slice(0, 20)}${title.length > 20 ? "…" : ""}」· 原时段冲突，自动改到 ${placement.block.start}`
        : `已创建提醒：「${title.slice(0, 20)}${title.length > 20 ? "…" : ""}」→ ${p.date.slice(5)} ${tide.util.hhmmOf(p.startMin)}`, {
        actionLabel: "查看", ms: 6500, action: () => tide.util.navigate("timeblock"),
      });
    } else if (p.date) {
      const placement = tide.blocks.createSmart({ date: p.date, start: "09:00", durMin: 60, title, taskId: task.id, cat });
      tide.notify(placement.moved ? `识别到日期 ${p.date.slice(5)}；09:00 冲突，已改到 ${placement.block.start}` : `识别到日期 ${p.date.slice(5)}，提醒先放在 09:00`);
    } else {
      tide.notify("通知里没识别到日期，任务已存入象限池");
    }
    state.seen.add(itemKey(it));
    saveSeen();
    paintList();
  }

  function setSeen(rid) { state.seen.add(rid); saveSeen(); }

  /* ── 左侧校园服务栏：标题 / 图标自动识别 ── */
  function faGlyph(name) {
    return `<svg viewBox="0 0 512 512" aria-hidden="true"><use href="/icons/fontawesome/solid.svg#${esc(name || "globe")}"></use></svg>`;
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }
  // 站点标题的可用性判定：门户会把人重定向到 SSO，抓到「统一身份认证平台」这类
  // 登录页标题，邮箱页甚至会返回 ' + COMPANY_NAME + ' 这种模板占位符，一律不显示。
  function usableTitle(title) {
    const t = String(title || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 26) return "";
    if (/['"+${}]|COMPANY_NAME|undefined|null|<\/?[a-z]/i.test(t)) return "";
    if (/统一身份认证|身份认证|^登录|登录$|login|sign\s?in|首页|门户首页/i.test(t)) return "";
    return t;
  }
  function linkIcon(item) {
    const meta = linkMeta[item.url] || {};
    // 字形兜底优先用入口自带的语义图标（shield-halved / envelope / school / id-card），
    // 比通用推断出来的图标更好区分；没写才用网页推断结果。
    const fallback = faGlyph(item.icon || meta.iconName || "globe");
    if (!meta.iconUrl) return fallback;
    // 站点 favicon 优先；读图失败（未登录 / 内网 / 跨域）时退回字形图标。
    return `<img src="${esc(meta.iconUrl)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">`
      + `<span style="display:none">${fallback}</span>`;
  }
  function sideBtnHtml(item) {
    // `view:` 入口既没有网址也没有站点元信息：标题用短名，副行写「在 U-Time 内查看」。
    if (item.view) {
      return `<button type="button" class="pp-side-btn" data-goto="${esc("view:" + item.view)}" `
        + `title="${esc(`${item.label} · 在 U-Time 内查看教务数据`)}">`
        + `<span class="pp-side-ico">${linkIcon(item)}</span>`
        + `<span class="pp-side-txt"><b>${esc(item.label)}</b><small>在 U-Time 内查看</small></span>`
        + `</button>`;
    }
    const meta = linkMeta[item.url] || {};
    const recognized = usableTitle(meta.title);
    const host = meta.host || hostOf(item.url);
    // 主标题用短名（稳定、可扫读），自动识别到的站点标题放副行；没写短名时才拿识别结果当主标题。
    const name = item.label || recognized || host;
    const sub = item.label ? (recognized || host) : host;
    const tip = [item.label, recognized, item.url].filter(Boolean).join(" · ")
      + (TICKET_LINKS[item.url] ? " · 用统一身份认证自动换票，免密直达" : "");
    return `<button type="button" class="pp-side-btn" data-goto="${esc(item.url)}" title="${esc(tip)}">`
      + `<span class="pp-side-ico">${linkIcon(item)}</span>`
      + `<span class="pp-side-txt"><b>${esc(name)}</b><small>${esc(sub)}</small></span>`
      + `</button>`;
  }
  // 父项 = 整行按钮 + 右侧独立的箭头按钮（button 不能嵌 button，所以两者是 .pp-side-row 的兄弟），
  // 下面跟一个 0fr→1fr 的子项容器。箭头只管展开收起，整行仍是入口本体的动作。
  function sideItemHtml(item) {
    if (!item.children?.length) return sideBtnHtml(item);
    const open = state.jwOpen;
    return `<div class="pp-side-row">` + sideBtnHtml(item)
      + `<button type="button" class="pp-side-sub-btn" data-side-sub aria-expanded="${open}" `
      + `title="${open ? "收起" : "展开"}${item.label}子菜单" `
      + `aria-label="${open ? "收起" : "展开"}${item.label}子菜单"><span aria-hidden="true">${open ? "▾" : "▸"}</span></button>`
      + `</div>`
      + `<div class="pp-side-sub${open ? " open" : ""}"${open ? "" : ' aria-hidden="true"'}>`
      + `<div class="pp-side-sub-in">${item.children.map(sideBtnHtml).join("")}</div></div>`;
  }
  function sideHtml() {
    const rows = QUICK_LINKS.map(sideItemHtml).join("");
    return `<div class="pp-side-inner">`
      + `<div class="pp-side-head">`
      + `<button type="button" class="pp-side-head-toggle" data-side-toggle aria-expanded="true" title="收起校园服务" aria-label="收起校园服务"><span aria-hidden="true">◂</span>校园服务</button>`
      + `</div>`
      + `<div class="pp-side-list">${rows}</div>`
      + `<div class="pp-side-note">标题与图标自动识别<br>点一下用浏览器打开</div>`
      + `</div>`;
  }
  // 收起/展开开关。做成 .pp-shell 的 flex 子项而不是浮层：永不压住正文，且收起时它天然落在左上角。
  function sideToggleHtml() {
    return `<button type="button" class="pp-side-toggle" data-side-toggle aria-expanded="${state.sideOpen ? "true" : "false"}" title="展开校园服务" aria-label="展开校园服务"><span aria-hidden="true">▸</span>校园服务</button>`;
  }
  function sideShellClass() { return state.sideOpen ? "pp-shell" : "pp-shell side-collapsed"; }
  function applySideOpen(root, open) {
    state.sideOpen = !!open;
    const shell = root && root.querySelector ? root.querySelector(".pp-shell") : null;
    if (shell) shell.classList.toggle("side-collapsed", !state.sideOpen);
    const btns = root && root.querySelectorAll ? root.querySelectorAll("[data-side-toggle]") : [];
    for (const b of btns) b.setAttribute("aria-expanded", state.sideOpen ? "true" : "false");
  }
  function paintSide(root) {
    const box = root && root.querySelector ? root.querySelector("[data-side]") : null;
    if (box) box.innerHTML = sideHtml();
  }
  async function loadLinkMeta(root, force = false) {
    if (typeof tide.util?.web?.parseSiteMeta !== "function") return;
    try {
      if (!force) {
        const saved = await tide.storage.get(LINK_META_KEY, null);
        if (saved && typeof saved === "object") linkMeta = { ...saved, ...linkMeta };
      }
    } catch { /* 存储不可用时用内存里的 */ }
    let changed = false;
    for (const item of QUICK_LINKS) {
      if (!item.url) continue;          // `view:` 入口是插件内视图，没有站点可识别
      const cached = linkMeta[item.url];
      if (!force && cached && Date.now() - Number(cached.at || 0) < LINK_META_TTL) continue;
      try {
        const res = await tide.http.getCached(item.url, 10 * 60 * 1000);
        if (res && Number(res.status) >= 400) throw new Error(`HTTP ${res.status}`);
        const meta = tide.util.web.parseSiteMeta(res?.body || "", res?.finalUrl || item.url);
        linkMeta[item.url] = { title: meta.title, host: meta.host || hostOf(item.url), iconUrl: meta.iconUrl, iconName: meta.iconName, at: Date.now() };
      } catch {
        // 抓不到就留旧结果（可能已有识别过的标题），至少保证 host / 图标名可用。
        linkMeta[item.url] = { ...(cached || {}), host: cached?.host || hostOf(item.url), iconName: cached?.iconName || item.icon, at: Date.now() };
      }
      changed = true;
      paintSide(root);   // 识别一条更新一条，不等四个站点全回来
    }
    if (changed) { try { await tide.storage.set(LINK_META_KEY, linkMeta); } catch { /* 忽略 */ } }
  }
  /* ── 需要登录的入口：现场换一张一次性 ticket，交给系统浏览器消费 ──
     ① 会话还在时，直接向 sso-jw 要票，一次请求就够；
     ② 要不到说明 sso-jw 域没会话，就用主 SSO 的 CASTGC 补走一次 bridge 落会话，再要一次。
     全程 followRedirects:false —— ticket 是一次性的，跟着重定向跑到底就等于把票吃了，
     浏览器拿到的反而是一张废票。所以只取 Location，绝不消费。 */
  async function mintTicket(entry) {
    const ask = () => {
      const url = JW + "/tpass/login?service=" + encodeURIComponent(entry.service);
      return getPage(url, false, { followRedirects: false }).then((res) => ({ res, url }));
    };
    const pick = ({ res, url }) => redirectTarget(res, url, entry.origin, entry.path);
    try {
      const direct = pick(await ask());
      if (direct) return direct;
      const bridge = SSO + "/tpass/login?service=" + encodeURIComponent(JW + "/tpass/bridge");
      const hop = await getPage(bridge, false, { followRedirects: false }).catch(() => null);
      const bridgeTicket = hop ? redirectTarget(hop, bridge, JW, "/tpass/bridge") : "";
      if (!bridgeTicket) return "";
      await getPage(bridgeTicket, false, { followRedirects: false }).catch(() => null);
      return pick(await ask());
    } catch { return ""; }
  }

  async function openSideLink(url, btn) {
    // `view:` 入口不开浏览器，直接切到本插件注册的对应视图（宿主视图 id 统一带 `plug:` 前缀）
    if (url.startsWith("view:")) { tide.util.navigate("plug:" + url.slice(5)); return; }
    if (url === MAIL) { await openMailLink(btn); return; }
    const entry = TICKET_LINKS[url];
    if (!entry || !state.sid) { tide.util.openUrl(url); return; }
    if (btn && btn.setAttribute) btn.setAttribute("aria-busy", "1");
    const ticket = await mintTicket(entry);
    if (btn && btn.removeAttribute) btn.removeAttribute("aria-busy");
    if (ticket) { tide.util.openUrl(ticket); return; }
    // 换不到票就退回裸链接（会落到统一身份认证登录页），不能让入口点了没反应
    tide.util.openUrl(url);
    tide.notify("没换到免登票据，已按普通方式打开，可能需要先登录一次");
  }

  function mailSessionUrlFromResponse(res, base = MAIL) {
    const parts = [res?.finalUrl, res?.location, res?.body].filter(Boolean).map(String);
    for (const raw of parts) {
      const text = raw.replace(/&amp;/g, "&");
      const absolute = text.match(/https?:\/\/mail\.cppu\.edu\.cn\/[^"'<>\\\s]*[?&;]sid=[^"'<>\\\s]+/i)?.[0];
      const relative = text.match(/(?:^|["'=])((?:\/coremail\/|\/)[^"'<>\\\s]*sid=[^"'<>\\\s]+)/i)?.[1];
      const sid = text.match(/(?:[?&;]sid=|\bsid\s*[:=]\s*["'])([A-Za-z0-9._-]+)/i)?.[1];
      const hit = absolute || relative || (sid ? `/coremail/XT5/index.jsp?sid=${encodeURIComponent(sid)}` : "");
      if (!hit) continue;
      try {
        const u = new URL(hit, base);
        if (u.protocol === "https:" && u.hostname === "mail.cppu.edu.cn" && u.searchParams.get("sid")) return u.href;
      } catch { /* ignore */ }
    }
    return "";
  }

  function mailLoginFailureText(res) {
    const text = cleanText(res?.body || "");
    const hit = text.match(/((?:密码|账号|用户|验证码|登录|邮箱)[^\n。；;]{0,42}(?:错误|失败|不存在|过期|不正确|被锁定))/);
    return hit ? hit[1].trim() : "";
  }

  async function verifyMailSession(sid, target) {
    const check = await tide.http.fetch(sid, "GET", target, { headers: { "Referer": MAIL, "Accept": "text/html,*/*" } });
    if (check.status >= 400) throw new Error(`邮箱入口校验失败（HTTP ${check.status}）`);
    const newer = mailSessionUrlFromResponse(check, check?.finalUrl || target);
    if (newer) return newer;
    const body = String(check?.body || "");
    let form = null;
    try { form = tide.util.web.detectLoginForm(body, check?.finalUrl || target); } catch { form = null; }
    if (form?.passwordField || /type=["']?password|coremail.*login|登录邮箱|邮箱登录/i.test(body)) {
      throw new Error("邮箱登录未建立：校验入口时仍停留在登录页");
    }
    return target;
  }

  function defaultMailForm(pageUrl) {
    return {
      pageUrl,
      form: {
        action: new URL("/coremail/index.jsp?cus=1", MAIL).href,
        method: "POST",
        usernameField: "uid",
        passwordField: "password",
        captchaField: "",
        fields: [
          { name: "action", value: "login" },
          { name: "locale", value: "zh_CN" },
          { name: "nodetect", value: "false" },
        ],
      },
    };
  }

  async function readSavedPassword() {
    if (state.savedPassword) return state.savedPassword;
    if (!state.autoLogin || typeof tide.vault?.get !== "function") return "";
    try {
      state.savedPassword = JSON.parse((await tide.vault.get("secret")) || "null")?.password || "";
    } catch {
      state.savedPassword = "";
    }
    return state.savedPassword;
  }

  async function openMailLink(btn) {
    const password = await readSavedPassword();
    if (!password) {
      tide.util.openUrl(MAIL);
      tide.notify("还没有保存警大通知插件密码，已按普通方式打开教育邮箱");
      return;
    }
    if (btn && btn.setAttribute) btn.setAttribute("aria-busy", "1");
    try {
      const sid = await tide.http.session();
      const first = await tide.http.fetch(sid, "GET", MAIL, { headers: { "Accept": "text/html,*/*" } });
      let pageUrl = first?.finalUrl || MAIL;
      const direct = mailSessionUrlFromResponse(first, pageUrl);
      if (direct) {
        const verified = await verifyMailSession(sid, direct);
        tide.util.openUrl(verified);
        return;
      }
      let form = null;
      try { form = tide.util.web.detectLoginForm(first?.body || "", pageUrl); } catch { form = null; }
      const rt = form?.passwordField ? { form, pageUrl } : defaultMailForm(pageUrl);
      if (rt.form.captchaField) {
        tide.util.openUrl(MAIL);
        tide.notify("教育邮箱当前登录页需要验证码，已按普通方式打开");
        return;
      }
      const fields = {};
      for (const f of rt.form.fields || []) if (f.name && f.value !== undefined) fields[f.name] = f.value;
      fields[rt.form.usernameField || "uid"] = MAIL_ACCOUNT;
      fields[rt.form.passwordField || "password"] = password;
      const body = tide.util.web.formEncode(fields);
      const action = rt.form.action || rt.pageUrl;
      const method = (rt.form.method || "POST").toUpperCase();
      const res = method === "GET"
        ? await tide.http.fetch(sid, "GET", action + (action.includes("?") ? "&" : "?") + body, { headers: { "Referer": rt.pageUrl } })
        : await tide.http.fetch(sid, "POST", action, {
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": rt.pageUrl },
            body,
          });
      if (res.status >= 400) throw new Error(`邮箱登录提交失败（HTTP ${res.status}）`);
      const failed = mailLoginFailureText(res);
      if (failed) throw new Error(failed);
      const target = mailSessionUrlFromResponse(res, res?.finalUrl || action);
      if (!target) throw new Error("邮箱登录已提交，但没有拿到可由浏览器直接打开的 sid 会话入口");
      const verified = await verifyMailSession(sid, target);
      tide.util.openUrl(verified);
      tide.notify("已使用警大通知保存的账号密码打开教育邮箱");
    } catch (e) {
      tide.util.openUrl(MAIL);
      tide.notify(`教育邮箱自动登录失败，已按普通方式打开：${e?.message || e}`);
    } finally {
      if (btn && btn.removeAttribute) btn.removeAttribute("aria-busy");
    }
  }

  function bindSide(root) {
    if (!root || root.dataset.ppSideBound) return;
    root.dataset.ppSideBound = "1";
    root.addEventListener("click", (e) => {
      // 🔴 必须排在 [data-goto] 之前：箭头按钮紧贴在带 data-goto 的父行右侧，
      // 顺序反了的话点箭头会顺手把教务开进系统浏览器。
      const sub = e.target.closest("[data-side-sub]");
      if (sub) {
        state.jwOpen = !state.jwOpen;
        // 就地改类名而不是 paintSide 重渲染：重渲染会让 grid-template-rows 一上来就是终值，
        // 展开动画没了，而且焦点会从箭头上掉下去。
        const row = sub.closest(".pp-side-row");
        const panel = row && row.nextElementSibling;
        if (panel) {
          panel.classList.toggle("open", state.jwOpen);
          panel.toggleAttribute("aria-hidden", !state.jwOpen);
        }
        sub.setAttribute("aria-expanded", state.jwOpen ? "true" : "false");
        const glyph = sub.querySelector("span");
        if (glyph) glyph.textContent = state.jwOpen ? "▾" : "▸";
        return;
      }
      const go = e.target.closest("[data-goto]");
      if (go) { openSideLink(go.dataset.goto, go); return; }
      if (e.target.closest("[data-side-toggle]")) { applySideOpen(root, !state.sideOpen); return; }
    });
  }

  /* ═════════ 智慧教务只读接入：学生选课 · 学生请假 · 学分 · 创新学分 ═════════
     为什么做成插件内视图而不是侧栏链接：教务是正方 JE 的 SPA，完全没有 URL 深链
     （je-app / je-main / je-core 三个 bundle 都不读 location.hash、location.search，
     开任何功能地址栏都停在 index.html），换票开浏览器只会一遍遍落回首页。
     取数走通用查询端点 POST /je/load：服务端按会话拼 whereSql（`and xh=学号`），
     客户端既看不到也改不掉别人的数据。
     🔴 刻意只读：交请假、选课这类写操作不接管 —— 提交接口要真提交一次才录得到，
     没录到就不要假装会写，一律用「去教务」换票开首页交给用户自己点。 */
  const JW_LOAD = JWAPP + "/je/load";
  const JW_FUNC_INFO = JWAPP + "/je/develop/funcInfo/getStaticFuncByCode";
  const JW_NOW_TERM = JWAPP + "/je/system/getNowXnxq";
  const JW_RETRY_MS = [400, 1600];     // 教务查询遇到传输层抖动的退避表（最多重发两次）
  const JW_TICKET_ENTRY = { service: JWAPP + "/cas_callback", origin: JWAPP, path: "/cas_callback" };
  // funcId 是功能自身的 id（实测取自面板的 funcData.info.funcId），不是菜单 id。
  // qjCourse 那条 funcCode 里带空格和 "copy from" 前缀不是笔误 —— 校方就是这么配的，
  // 抄错一个字符服务端直接回 UNKOWN_ERROR。
  const JW_FUNC = {
    xkTask: { funcCode: "JWBZK.T_JWBZK_XKGL_XYXK", funcId: "cxJNVOE1UJU4YwTJyDT", tableCode: "JWBZK.T_JWBZK_XKGL_XKRW" },
    xkResult: { funcCode: "V_JWBZK_XKGL_XKJG_XS", funcId: "UEgVc81fir8gotAkmzM", tableCode: "V_JWBZK_XKGL_XKJG" },
    qjRecord: { funcCode: "JWBZK.T_JWBZK_DYKQ_XSQJSQ_XSCX", funcId: "jycdtB3HszziSH8rgxn", tableCode: "JWBZK.T_JWBZK_DYKQ_XSQJSQ" },
    qjCourse: { funcCode: "copy from V_JWBZK_PK_XSKBZHCX", funcId: "TtHt7qQKBLbsw4B2DgB", tableCode: "V_JWBZK_PK_XSKBZHCX" },
    creditPlan: { funcCode: "V_JWBZK_JXJH_JXJH", funcId: "oSVuQBmmB2WLat8hLcQ", tableCode: "V_JWBZK_JXJH_JXJH" },
    // 「我的学分」网格：一行一个课程模块，带 学分要求/获得/在修/待修（XFYQ/HDXF/YXXF/DXXF）。
    creditModule: { funcCode: "V_JWBZK_XKGL_XKQK", funcId: "0ZqWUFX5iDaobVeNNwy", tableCode: "V_JWBZK_XKGL_XKQK" },
    grade: { funcCode: "V_STUDENT_GRADE", funcId: "UGwUYaFdMocm4gG2cdA", tableCode: "V_STUDENT_GRADE" },
    cxCredit: { funcCode: "V_CXGL_GRADE_STU", funcId: "VqfuoxJmlz2G9QJnoPZ", tableCode: "V_CXGL_GRADEQUERY" },
    cxDetail: { funcCode: "T_SZKP_CXGL_CREDITAPPLICATION_STU", funcId: "Ib0BbzaqbUbrKVOsERB", tableCode: "T_SZKP_CXGL_CREDITAPPLICATION" },
  };
  // 教务里没有「创新成绩」这个菜单，实名叫「成绩查询(学生)」，挂在 创新实践 下面
  const JW_MENU = {
    xk: "学生服务 › 我的课程表 › 我的选课 › 学生选课",
    qj: "学生服务 › 我的课程表 › 我的课表 › 学生请假申请",
    grades: "学生服务 › 我的学业 › 成绩 › 成绩查询",
    cx: "学生服务 › 综合素质考评 › 创新实践 › 成绩查询(学生)",
  };
  // 校方字典（/je/dd/dd/getDicItemByCodes 的 KCSXDM_1 / KCHJDM_1 / KJDM / QJSQSP / KCMKDM_1）抄一份在用：
  // 省掉每次开视图多打一跳；未命中的码一律原样显示，绝不猜一个好看的词糊上去。
  const JW_DD = {
    KCSX: { "01": "必修课", "02": "选修课", "03": "课外实践必修", "04": "实践技能选修" },
    HJLX: { "01": "理论", "02": "实验", "03": "实践及实训" },
    JC: { "01": "1-2", "02": "3-4", "03": "5-6", "04": "7-8", "05": "9-10", "06": "11-12" },
    SQZT: { "0": "已撤销", "1": "审批中", "2": "已同意", "3": "未同意" },
    // 课程模块码 KCMK ← 字典 KCMKDM_1（2026-09-24 实测：「我的学分」面板自己就按这张翻译，
    // 31 条全量抄回）。**码和界面顺序完全无关** —— 培养方案第一行「军事教育课程」是 28，
    // 「公共基础」是 23，所以绝不能按列表次序排 01、02。未命中的码原样显示，不猜类名。
    KCMK: {
      "01": "自然科学", "02": "人文社会科学", "03": "军事技能类", "04": "专业基础与专业类", "05": "警种通修类",
      "06": "专业", "07": "基础类", "08": "专业基础", "09": "公共类", "10": "国防教育",
      "11": "科学素养", "12": "公安基础", "13": "程序设计限选", "14": "公共艺术课程", "15": "公共体育课程",
      "16": "创新创业限选", "17": "专业限选", "18": "公共线下课程", "19": "专业任选", "20": "实践技能任选",
      "21": "公共线上课程", "22": "思想政治理论", "23": "公共基础", "24": "信息素养课程", "25": "法律素养",
      "26": "公安理论与警察素养", "27": "公安实战技能", "28": "军事教育课程", "29": "实习实践", "30": "毕业论文",
      "31": "学科基础",
    },
  };
  const jwDict = (dict, code) => {
    const c = String(code ?? "").trim();
    if (!c) return "";
    return JW_DD[dict]?.[c] || c;
  };
  const jwKeyLabel = (k) => ({ xkTask: "选课任务", xkResult: "选课结果", qjRecord: "请假记录", qjCourse: "可请假课次", creditPlan: "培养计划", creditModule: "课程模块进度", grade: "课程成绩", cxCredit: "创新学分", cxDetail: "创新学分明细" }[k] || k);

  let jwSid = null;                 // 已经落上教务 authorization 的那个会话 id
  const jwLive = () => !!jwSid && jwSid === state.sid;
  let jwBootPromise = null;         // 同时挂两个教务视图时合流，别各跑一遍验证码登录

  /* 教务取数前的统一引导：恢复密钥库 Cookie → 换票建教务会话 → 不行就用保存的密码
     走验证码自动识别 → 再换一次票。登录代码全插件只有这一份，从侧栏点进哪个警大
     视图都一样，不需要先绕去「警大通知」手工登录。 */
  function ensureJwLogin(force = false) {
    if (!force && jwLive()) return Promise.resolve(true);
    if (!force && jwBootPromise) return jwBootPromise;
    const p = (async () => {
      await loadPrefs();
      if (!state.sid) await restoreCookies();
      if (await ensureJwSession()) return true;
      return await passwordAutoLogin() && await ensureJwSession(true);
    })();
    jwBootPromise = p;
    // 只合流并发、不缓存结果：点「刷新」时该再试一次，别拿着上次的 false 一直不回本
    const clear = () => { if (jwBootPromise === p) jwBootPromise = null; };
    p.then(clear, clear);
    return p;
  }
  const jwState = {
    term: null,
    data: { xkTask: null, xkResult: null, qjRecord: null, qjCourse: null, creditPlan: null, creditModule: null, grade: null, cxCredit: null, cxDetail: null },
    loading: {}, error: {}, at: {},
    courseScope: "week",            // today | week | term，默认本周（本学期是 200+ 行的紧凑列表）
    leaveCourseId: "",
    leaveReason: "",
    selectedTaskId: "",
    creditHideDone: false,
    expandedCredit: new Set(),
  };
  const jwMounted = new Map();      // viewId -> { el, cfg }

  const jwToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // 校历的 JXZQSRQ（教学周期起始日）才是第 1 周第一天；KSRQ 是学期起始日，可能含军训/假期
  function jwWeekOf(dateStr) {
    const start = Date.parse(`${jwState.term?.jxStart || ""}T00:00:00`);
    const day = Date.parse(`${dateStr || ""}T00:00:00`);
    if (!Number.isFinite(start) || !Number.isFinite(day)) return 0;
    return Math.floor((day - start) / (7 * 86400000)) + 1;
  }

  async function ensureJwSession(force = false) {
    await newSession();
    if (!force && jwLive()) return true;
    const ticket = await mintTicket(JW_TICKET_ENTRY);
    if (!ticket) { jwSid = null; return false; }
    // 侧栏那个「教务」入口是把票交给系统浏览器（自己绝不消费，否则浏览器拿到废票）；
    // 这里反过来：必须自己消费掉，同一个 Cookie Jar 才会落上 jw 的 authorization。
    const res = await getPage(ticket).catch(() => null);
    const ok = !!res && res.status === 200 && !/tpass\/login/i.test(String(res.finalUrl || ""));
    jwSid = ok ? state.sid : null;
    if (ok) await saveCookies();
    return ok;
  }

  const jeRowsOf = (res) => {
    try {
      const j = JSON.parse(String(res?.body || ""));
      return Array.isArray(j?.rows) ? j.rows : null;
    } catch { return null; }
  };

  // funcType=sql 的功能（如「学员选课」）光给 funcCode 是查不出来的：教务前端会把该功能的
  // 整段 SELECT 从元信息里取出来原样回传，服务端才认（实测漏掉就回 UNKOWN_ERROR）。
  // 视图型功能（V_ 开头那几张）不需要，所以这里按 funcType 条件加，一律不自己拼 SQL。
  const jwFuncMeta = {};
  async function jwFuncInfo(key) {
    if (jwFuncMeta[key]) return jwFuncMeta[key];
    const f = JW_FUNC[key];
    const res = await tide.http.fetch(state.sid, "POST", JW_FUNC_INFO, {
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: JW_INDEX },
      body: tide.util.web.formEncode({ refresh: "false", tableCode: "JE_CORE_FUNCINFO", FUNCINFO_FUNCCODE: f.funcCode, perm: "true" }),
    }).catch((e) => { throw new Error(explainHttpError(e)); });
    let j = null;
    try { j = JSON.parse(String(res.body || "")); } catch { j = null; }
    const info = j?.funcInfo || {};
    const meta = {
      funcId: String(info.funcId || f.funcId),
      funcType: String(info.funcType || ""),
      dbSql: String(j?.func?.info?.FUNCINFO_SQL || ""),
    };
    // 元信息拿到了才缓存（省掉后续每次多一跳）；拿不到就退回硬编码 funcId，下次再取
    if (info.funcId) jwFuncMeta[key] = meta;
    return jwFuncMeta[key] || { funcId: f.funcId, funcType: "", dbSql: "" };
  }

  async function jeLoad(key, groups = []) {
    const f = JW_FUNC[key];
    if (!f) throw new Error(`未登记的教务功能：${key}`);
    if (!await ensureJwLogin()) throw new Error("警大统一身份认证未建立：请在下方完成登录后重试");
    let meta = await jwFuncInfo(key);
    const post = () => {
      const params = {
        funcCode: f.funcCode, funcId: meta.funcId, columnLazy: "true", mark: "false", postil: "",
        funcEdit: "false", coverJquery: "0", tableCode: f.tableCode, _isFunc_: "true",
        j_query: JSON.stringify({ custom: groups, _custom_types: groups.map(() => "group") }),
        j_order: "[]", page: "1", start: "0", limit: "-1",
      };
      if (meta.funcType === "sql" && meta.dbSql) { params.queryType = "sql"; params.dbSql = meta.dbSql; params.queryParamsStr = "[]"; }
      return tide.http.fetch(state.sid, "POST", JW_LOAD, {
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: JW_INDEX },
        body: tide.util.web.formEncode(params),
      });
    };
    // 传输层抖动（校园网出口偶发 DNS 解析失败、连接被中途掐断）跟「登录态失效」是两回事：
    // 前者服务端压根没答话，原样重发就通；后者要重新换票，走下面 rows 为空那条路。
    // 教务这边刻意只读，重发不存在二次提交。退避给到秒级 —— Windows 解析器会把失败
    // 结果短期缓存，立刻重发往往撞上同一条负面缓存。最多两次，不能把抖动变成无限重。
    const postThrough = async () => {
      for (let i = 0; ; i++) {
        try { return await post(); }
        catch (e) {
          if (i >= JW_RETRY_MS.length || !isTransportBlip(e && (e.message || e))) throw new Error(explainHttpError(e));
          await new Promise((r) => setTimeout(r, JW_RETRY_MS[i]));
        }
      }
    };
    let res = await postThrough();
    let rows = jeRowsOf(res);
    if (!rows) {
      // 会话过期的表现不是 401，而是 POST 被 302 回登录页、拿回来一整页 HTML
      delete jwFuncMeta[key];
      if (!await ensureJwSession(true) && !await ensureJwLogin(true)) throw new Error("教务登录态已失效，请重新登录");
      meta = await jwFuncInfo(key);
      res = await postThrough();
      rows = jeRowsOf(res);
      if (!rows) throw new Error(`教务数据解析失败（HTTP ${res.status}）`);
    }
    return rows;
  }

  async function loadJwTerm(force = false) {
    if (!force && jwState.term) return jwState.term;
    if (!await ensureJwLogin()) return jwState.term;
    try {
      const res = await tide.http.fetch(state.sid, "POST", JW_NOW_TERM, {
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: JW_INDEX },
        body: "",
      });
      const v = JSON.parse(String(res.body || ""))?.data?.values || {};
      if (v.DM) jwState.term = { code: v.DM, name: String(v.MC || v.DM), jxStart: String(v.JXZQSRQ || ""), weeks: Number(v.XQZS) || 0 };
    } catch { /* 学期拿不到不阻塞列表：课次视图退化成「不过滤学期」 */ }
    return jwState.term;
  }

  // 校历插件只接收学期边界数据；统一身份认证和 Cookie 始终留在本插件。
  tide.events?.on?.("cppu:term-request", (request) => {
    if (!request || typeof request.id !== "string") return;
    const previous = jwState.term;
    loadJwTerm(true).then((term) => {
      tide.events.emit("cppu:term-response", { id: request.id,
        term: term && term !== previous ? { name: term.name, jxStart: term.jxStart, weeks: term.weeks } : null,
        error: term === previous ? "本次未能刷新教务学期；请检查警大门户登录" : "教务暂未返回学期信息" });
    }).catch((error) => {
      tide.events.emit("cppu:term-response", { id: request.id, error: String(error?.message || "教务学期暂不可用") });
    });
  });

  async function jwSaveCache() {
    const keep = {};
    for (const k of ["xkTask", "xkResult", "qjRecord", "creditPlan", "creditModule", "grade", "cxCredit", "cxDetail"]) if (Array.isArray(jwState.data[k])) keep[k] = jwState.data[k];
    try { await tide.storage.set("jwCache", { username: state.username, term: jwState.term, at: jwState.at, keep, prefs: { creditHideDone: jwState.creditHideDone } }); } catch { /* 忽略 */ }
  }
  async function jwRestoreCache() {
    try {
      const c = await tide.storage.get("jwCache", null);
      if (!c || typeof c !== "object" || (c.username != null && c.username !== state.username)) return;
      if (c.term && !jwState.term) jwState.term = c.term;
      jwState.creditHideDone = c.prefs?.creditHideDone === true;
      for (const [k, rows] of Object.entries(c.keep || {})) if (Array.isArray(rows) && jwState.data[k] === null) jwState.data[k] = rows;
      for (const [k, at] of Object.entries(c.at || {})) if (!jwState.at[k]) jwState.at[k] = Number(at) || 0;
    } catch { /* 缓存坏了当没有 */ }
  }

  async function jwEnsureKeys(keys, force = false) {
    await loadJwTerm(force);
    for (const key of keys) {
      if (jwState.loading[key]) continue;
      if (!force && Array.isArray(jwState.data[key])) continue;
      jwState.loading[key] = true;
      jwState.error[key] = "";
      jwPaint();
      try {
        // 课次一次拉「整学期」（实测 222 节），今天/本周在渲染时切，避免每切一次打一次接口
        const groups = key === "qjCourse" && jwState.term?.code
          ? [{ type: "and", value: [{ code: "XNXQ_CODE", type: "=", value: jwState.term.code, cn: "and" }] }]
          : [];
        jwState.data[key] = await jeLoad(key, groups);
        jwState.at[key] = Date.now();
      } catch (e) {
        jwState.error[key] = String(e?.message || e);
      }
      jwState.loading[key] = false;
    }
    await jwSaveCache();
    jwPaint();
  }

  /* ── 视图渲染 ── */
  function jwTag(text, cls) { if (/^[\d.]+ 学分$/.test(text)) cls = "credit"; return text ? `<span class="jw-tag${cls ? " " + cls : ""}">${esc(text)}</span>` : ""; }
  function jwAt(key) {
    const at = Number(jwState.at[key]) || 0;
    return at ? `更新于 ${new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "尚未拉取";
  }
  function jwStateBlock(key, loadingText) {
    if (jwState.loading[key]) return `<div class="pp-empty">${esc(loadingText || `正在拉取${jwKeyLabel(key)}…`)}</div>`;
    if (jwState.error[key]) return `<div class="pp-banner">${esc(jwState.error[key])}</div>`;
    return "";
  }
  function jwTermName(code) {
    const c = String(code || "");
    if (!c) return "";
    if (jwState.term?.code === c) return jwState.term.name;
    // 教务的学期码形如 20262027-1：前 8 位是跨年的两个年份，后半是学期序号
    const m = c.match(/^(\d{4})\d{4}-(\d)$/);
    return m ? `${m[1]}-${Number(m[1]) + 1} 学年第 ${m[2]} 学期` : c;
  }
  function jwSection(title, sub, inner) {
    return `<div class="jw-sec">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</div>${inner}`;
  }
  function jwMetaLine(parts) { return `<div class="pp-meta">${parts.filter(Boolean).join("")}</div>`; }

  const jwTaskId = (r, index = 0) => String(r?.ID || [r?.KKXNXQ, r?.LC, r?.XKRWMC, index].filter(Boolean).join("|"));
  function jwTermOrder(code) {
    const m = String(code || "").match(/^(\d{4})\d{4}-(\d+)$/);
    return m ? Number(m[1]) * 10 + Number(m[2]) : 0;
  }
  function jwTaskStatus(r) {
    const code = String(r?.XKRWZT ?? r?.ZT ?? "").trim();
    const supplied = String(r?.XKRWZTNAME || r?.XKRWZTMC || r?.ZTMC || "").trim();
    const labels = { "0": "未开始选课", "1": "未开始选课", "2": "正在选课", "3": "结束选课" };
    let label = supplied || labels[code] || (code ? `状态 ${code}` : "状态未知");
    const oldTerm = jwTermOrder(r?.KKXNXQ) > 0 && jwTermOrder(jwState.term?.code) > 0
      && jwTermOrder(r.KKXNXQ) < jwTermOrder(jwState.term.code);
    const ended = code === "3" || /结束|已结束|关闭|停止/.test(label);
    const expired = oldTerm || ended;
    if (oldTerm && !ended) label = "结束选课";
    const active = !expired && (code === "2" || /正在选课|选课中|进行中/.test(label));
    return { code, label, active, expired };
  }

  function jwTaskCourses(task) {
    const rows = Array.isArray(jwState.data.xkResult) ? jwState.data.xkResult : [];
    return rows.filter((r) => !task?.KKXNXQ || String(r.KKXNXQ || "") === String(task.KKXNXQ));
  }

  function jwTaskDetailHtml() {
    const rows = Array.isArray(jwState.data.xkTask) ? jwState.data.xkTask : [];
    const task = rows.find((r, index) => jwTaskId(r, index) === jwState.selectedTaskId);
    if (!task) {
      jwState.selectedTaskId = "";
      return jwTaskHtml();
    }
    const status = jwTaskStatus(task);
    const courses = jwTaskCourses(task);
    const detail = [
      ["学期", jwTermName(task.KKXNXQ)],
      ["选课轮次", task.LC ? `第 ${task.LC} 轮` : "未标注"],
      ["年级", task.NJ],
      ["校区", task.XQ],
      ["学院 / 专业", [task.XYID, task.XYZY].filter(Boolean).join(" / ")],
    ].filter(([, value]) => value).map(([label, value]) => `<div class="jw-detail-cell"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join("");
    const courseHtml = courses.length ? courses.map((r) => `<div class="jw-card">
        <div class="jw-card-t">${esc(r.KCMC || "（未命名课程）")}</div>
        ${jwMetaLine([
          r.XKBMC ? jwTag(r.XKBMC) : "",
          r.XF ? jwTag(`${r.XF} 学分`, "ok") : "",
          r.SKDD ? jwTag(r.SKDD) : "",
          jwTag(String(r.OPERATERCODE || "") === String(state.username || "") ? "本人自选" : "教务代选"),
        ])}
      </div>`).join("") : `<div class="pp-empty">这个学期还没有已选课程</div>`;
    return `<button type="button" class="pp-btn" data-jw-task-back>返回任务列表</button>
      <div class="jw-card${status.expired ? " expired" : status.active ? " live" : ""}">
        <div class="jw-task-detail-head">
          <div class="jw-card-t">${esc(task.XKRWMC || "（未命名任务）")}</div>
          ${jwTag(status.label, status.active ? "live" : status.expired ? "" : "warn")}
        </div>
        ${jwMetaLine([jwTag(jwTermName(task.KKXNXQ)), task.LC ? jwTag(`第 ${task.LC} 轮`) : ""])}
        ${detail ? `<div class="jw-detail-grid">${detail}</div>` : ""}
        ${status.active ? `<div class="jw-card-act"><button type="button" class="pp-btn pri" data-jw-task-site>进入教务办理选课</button></div>` : ""}
      </div>
      ${jwSection("本学期已选课程", `${courses.length} 门`, `<div class="jw-task-courses">${courseHtml}</div>`)}`;
  }

  function jwTaskHtml() {
    const rows = jwState.data.xkTask;
    const head = jwStateBlock("xkTask");
    if (head) return jwSection("可参加的选课任务", jwAt("xkTask"), head);
    if (!Array.isArray(rows)) return jwSection("可参加的选课任务", jwAt("xkTask"), `<div class="pp-empty">还没有拉取过选课任务，点上方「刷新」</div>`);
    if (!rows.length) return jwSection("可参加的选课任务", jwAt("xkTask"), `<div class="pp-empty">现在没有待选的选课任务<br>这个列表只列「还没选过的」任务，选完就会消失</div>`);
    const cards = rows.map((r, index) => {
      const status = jwTaskStatus(r);
      return `<button type="button" class="jw-card jw-task-card${status.expired ? " expired" : status.active ? " live" : ""}" data-jw-task="${esc(jwTaskId(r, index))}" aria-label="查看选课任务：${esc(r.XKRWMC || "未命名任务")}">
        <div class="jw-card-t">${esc(r.XKRWMC || "（未命名任务）")}</div>
        ${jwMetaLine([jwTag(jwTermName(r.KKXNXQ)), r.LC ? jwTag(`第 ${r.LC} 轮`) : "", jwTag(status.label, status.active ? "live" : status.expired ? "" : "warn")])}
      </button>`;
    }).join("");
    return jwSection("可参加的选课任务", `${rows.length} 项 · ${jwAt("xkTask")}`, cards);
  }

  function jwResultHtml() {
    const rows = jwState.data.xkResult;
    const head = jwStateBlock("xkResult");
    if (head) return jwSection("已选课程", jwAt("xkResult"), head);
    if (!Array.isArray(rows)) return jwSection("已选课程", jwAt("xkResult"), `<div class="pp-empty">还没有拉取过选课结果，点上方「刷新」</div>`);
    if (!rows.length) return jwSection("已选课程", jwAt("xkResult"), `<div class="pp-empty">还没有选课记录</div>`);
    const byTerm = new Map();
    for (const r of rows) {
      const k = r.KKXNXQNAME || jwTermName(r.KKXNXQ);
      if (!byTerm.has(k)) byTerm.set(k, []);
      byTerm.get(k).push(r);
    }
    let html = "";
    for (const [term, list] of byTerm) {
      const xf = list.reduce((n, r) => n + (Number(r.XF) || 0), 0);
      html += `<div class="jw-group">${esc(term)} · ${list.length} 门 · <span class="jw-credit-value">${xf} 学分</span></div>`;
      html += list.map((r) => {
        const self = String(r.OPERATERCODE || "") === String(state.username || "");
        return `<div class="jw-card">
          <div class="jw-card-t">${esc(r.KCMC || "（未命名课程）")}</div>
          ${jwMetaLine([
            jwTag(jwDict("KCSX", r.KCSX)),
            r.XKBMC ? jwTag(r.XKBMC) : "",
            r.XF ? jwTag(`${r.XF} 学分`, "ok") : "",
            r.SKDD ? jwTag(r.SKDD) : "",
            jwTag(self ? "本人自选" : "教务代选", self ? "" : "warn"),
          ])}
        </div>`;
      }).join("");
    }
    return jwSection("已选课程", `${rows.length} 门 · ${jwAt("xkResult")}`, html);
  }

  function jwCourseScopeBar() {
    const items = [["today", "今天"], ["week", "本周"], ["term", "本学期"]];
    return `<div class="pp-toolbar"><span class="pp-lab">范围</span><div class="pp-chips">${items.map(([id, label]) =>
      `<button type="button" class="pp-chip${jwState.courseScope === id ? " on" : ""}" data-jw-scope="${id}">${label}</button>`).join("")}</div></div>`;
  }
  const jwCourseId = (r) => String(r.ID || [r.SKRQ, r.JC, r.KCMC, r.JS, r.DDMC].filter(Boolean).join("|"));
  function jwCourseTime(r) {
    return `${String(r.SKRQ || "").slice(5)} 周${"日一二三四五六"[Number(new Date(`${r.SKRQ}T00:00:00`).getDay()) || 0]} ${jwDict("JC", r.JC)}节`;
  }
  function jwLeaveDraftHtml(r, applied) {
    if (applied) return `<div class="jw-leave-draft"><small>这节课已经出现在请假记录里，通常不需要重复申请。</small></div>`;
    const title = `${r.KCMC || "这节课"} · ${jwCourseTime(r)}`;
    return `<div class="jw-leave-draft">
      <textarea data-leave-reason placeholder="请假理由，例如：因身体不适需前往校医院就诊，无法参加本节课程。">${esc(jwState.leaveReason || "")}</textarea>
      <div class="jw-card-act">
        <button type="button" class="pp-btn pri" data-leave-site>去教务提交</button>
        <button type="button" class="pp-btn" data-leave-task>存成待办</button>
      </div>
      <small>已选择：${esc(title)}。这里先帮你把课次和理由整理好；点「去教务提交」会免密打开教务，最终提交仍由学校系统确认。</small>
    </div>`;
  }
  function jwLeaveActionHtml(r, applied) {
    if (applied) return "";
    const id = jwCourseId(r);
    return `<div class="jw-card-act"><button type="button" class="pp-btn pri" data-leave-course="${esc(id)}">申请请假</button></div>`;
  }
  function jwCourseList() {
    const rows = jwState.data.qjCourse;
    const head = jwStateBlock("qjCourse");
    if (head) return head;
    if (!Array.isArray(rows)) return `<div class="pp-empty">还没有拉取过课次，点上方「刷新」</div>`;
    const applied = new Set((jwState.data.qjRecord || []).map((r) => String(r.YWID || "")));
    const scope = jwState.courseScope;
    const today = jwToday();
    const week = jwWeekOf(today);
    const list = rows.filter((r) => (scope === "today" ? String(r.SKRQ) === today : scope === "week" ? Number(r.XQ) === week : true));
    if (!list.length) {
      return `<div class="pp-empty">${scope === "week" ? "本周没有课次（或校历起始日没拿到）" : scope === "today" ? "今天没有安排课程" : "本学期没有课次记录"}</div>`;
    }
    if (scope === "term") {
      // 本学期是 200+ 节，用紧凑一行一节；今天/本周才上卡片
      return list.map((r) => {
        const id = jwCourseId(r);
        const hasApplied = applied.has(String(r.ID));
        return `<div class="jw-row" data-jw-course-row="${esc(id)}">
          <b>${esc(jwCourseTime(r))}</b><span>${esc(r.KCMC || "")}</span><small>${esc([jwDict("KCSX", r.KCSX), r.JS, r.DDMC].filter(Boolean).join(" · "))}</small>
          ${hasApplied ? jwTag("已申请", "ok") : `<button type="button" class="pp-btn" data-leave-course="${esc(id)}">申请请假</button>`}
        </div>${jwState.leaveCourseId === id ? jwLeaveDraftHtml(r, hasApplied) : ""}`;
      }).join("");
    }
    return list.map((r) => {
      const id = jwCourseId(r);
      const hasApplied = applied.has(String(r.ID));
      return `<div class="jw-card" data-jw-course-row="${esc(id)}">
        <div class="jw-card-t">${esc(r.KCMC || "（未命名课程）")}${hasApplied ? " " + jwTag("已申请", "ok") : ""}</div>
        ${jwMetaLine([
          jwTag(jwCourseTime(r)),
          jwTag(`第 ${r.XQ} 周`),
          jwTag(jwDict("KCSX", r.KCSX)),
          jwTag(jwDict("HJLX", r.HJLX)),
          r.JS ? jwTag(r.JS) : "",
          r.DDMC ? jwTag(r.DDMC) : "",
          r.XF ? jwTag(`${r.XF} 学分`) : "",
        ])}
        ${jwState.leaveCourseId === id ? jwLeaveDraftHtml(r, hasApplied) : jwLeaveActionHtml(r, hasApplied)}
      </div>`;
    }).join("");
  }
  function jwLeaveHtml() {
    const rows = jwState.data.qjRecord;
    const head = jwStateBlock("qjRecord");
    const records = head || !Array.isArray(rows)
      ? (head || `<div class="pp-empty">还没有拉取过请假记录，点上方「刷新」</div>`)
      : (rows.length ? rows.map((r) => `<div class="jw-card">
          <div class="jw-card-t">${esc(r.KCMC || "（未命名课程）")}</div>
          ${jwMetaLine([
            jwTag(`${String(r.SKRQ || "").slice(5)} ${jwDict("JC", r.JC)}节`),
            r.JSXMS ? jwTag(r.JSXMS) : "",
            r.JSMC ? jwTag(r.JSMC) : "",
            jwTag(jwDict("SQZT", r.SQZT), String(r.SQZT) === "2" ? "ok" : String(r.SQZT) === "1" ? "warn" : ""),
          ])}
          ${r.SQYY ? `<div class="jw-why">${esc(r.SQYY)}</div>` : ""}
        </div>`).join("") : `<div class="pp-empty">还没有提交过请假申请</div>`);
    return jwSection("请假记录", `${Array.isArray(rows) ? rows.length + " 条 · " : ""}${jwAt("qjRecord")}`, records)
      + jwSection("可提请假的课次", jwAt("qjCourse"), jwCourseScopeBar() + jwCourseList());
  }
  const jwGradeDone = (r) => String(r?.SFHDXF || "") === "1";
  const jwModuleLabel = (code) => {
    const c = String(code ?? "").trim();
    if (!c) return "未标注模块";
    return JW_DD.KCMK[c] || `模块 ${c}`;
  };
  // 教务的学分字段是补位到 15 字符的字符串（"              5.0"），一律过一遍再算
  const jwXf = (v) => Math.round((parseFloat(v) || 0) * 10) / 10;
  /* 「我的学分」(creditModule) 一行一个课程模块，按培养方案顺序回，且自带 要求/获得/在修/待修，
     所以分组以它为准，成绩行只负责挂到模块下面 —— 一门课没有的模块（待修 6 学分那种）也要露面。
     方案里查不到的模块码（重修、转专业等）单独补一组垫底，空码永远最后，不能因为方案没列就丢课。 */
  function jwCreditGroups(category, moduleRows) {
    const byCode = new Map();
    for (const r of category.rows) {
      const c = String(r.KCMK ?? "").trim();
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(r);
    }
    const groups = moduleRows
      .filter((m) => category.codes.includes(String(m.KCSX ?? "")))
      .map((m) => {
        const code = String(m.KCMK ?? "").trim();
        const rows = byCode.get(code) || [];
        byCode.delete(code);
        return { label: jwModuleLabel(code), rows, target: jwXf(m.XFYQ), earned: jwXf(m.HDXF), doing: jwXf(m.YXXF), left: jwXf(m.DXXF) };
      });
    for (const [code, rows] of [...byCode.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0]))) {
      groups.push({ label: jwModuleLabel(code), rows, target: null, earned: jwXf(rows.reduce((s, r) => s + (jwGradeDone(r) ? Number(r.XF) || 0 : 0), 0)), planned: jwXf(rows.reduce((s, r) => s + (Number(r.XF) || 0), 0)) });
    }
    return groups;
  }
  function jwModuleLine(m, hidden) {
    const bits = [esc(m.label)];
    if (m.target === null) bits.push(`${m.shown.length} 门`, `已获得 ${m.earned} / 修读 ${m.planned} 学分`);
    else {
      bits.push(`已获得 ${m.earned} / 要求 ${m.target} 学分`);
      if (m.doing) bits.push(`在修 ${m.doing}`);
      if (m.left) bits.push(`待修 ${m.left}`);
      if (m.shown.length) bits.push(`${m.shown.length} 门`);
    }
    if (hidden) bits.push(`已隐藏 ${hidden} 门`);
    return bits.join(" · ");
  }
  function jwAcademicCreditHtml() {
    const planRows = jwState.data.creditPlan;
    const moduleRows = jwState.data.creditModule;
    const grades = jwState.data.grade;
    const planState = jwStateBlock("creditPlan", "正在读取培养计划…");
    const moduleState = jwStateBlock("creditModule", "正在读取课程模块进度…");
    const gradeState = jwStateBlock("grade", "正在读取课程学分…");
    if (planState || moduleState || gradeState) return planState + moduleState + gradeState;
    if (!Array.isArray(planRows) || !Array.isArray(moduleRows) || !Array.isArray(grades)) return `<div class="pp-empty">还没有拉取过学分数据，点上方「刷新」</div>`;
    const plan = planRows[0] || {};
    const categories = [
      { id: "required", title: "必修", codes: ["01"], target: Number(plan.KCBXXF) || 0 },
      { id: "elective", title: "选修", codes: ["02"], target: Number(plan.KCXXXF) || 0 },
      { id: "practice", title: "实践", codes: ["03", "04"], target: Number(plan.SJKCZXF) || 0 },
    ].map((category) => {
      const rows = grades.filter((r) => category.codes.includes(String(r.KCSX || "")));
      const earned = rows.filter(jwGradeDone).reduce((sum, r) => sum + (Number(r.XF) || 0), 0);
      return { ...category, rows, earned };
    });
    const earnedAll = grades.filter(jwGradeDone).reduce((sum, r) => sum + (Number(r.XF) || 0), 0);
    const totalTarget = Number(plan.KCZXF) || categories[0].target + categories[1].target;
    const isOpen = (id) => jwState.expandedCredit.has(id);
    const overview = `<div class="jw-sum"><b>${earnedAll}</b><span>已获得学分 / 培养计划 ${totalTarget || "--"} 学分</span></div>
      <div class="jw-credit-overview">${categories.map((category) => {
        const percent = category.target ? Math.min(100, Math.round(category.earned / category.target * 100)) : 0;
        const on = isOpen(category.id);
        return `<button type="button" class="jw-credit-stat${on ? " on" : ""}" data-credit-toggle="${category.id}" aria-expanded="${on}" aria-label="展开${category.title}课程的模块分类">
          <small>${category.title}学分</small><b>${category.earned} / ${category.target || "--"}</b><span>${category.rows.filter(jwGradeDone).length} 门已获得</span><div class="jw-credit-bar"><i style="width:${percent}%"></i></div>
          <em>${on ? "收起分类" : `按模块看 ${category.rows.length} 门`}</em>
        </button>`;
      }).join("")}</div>`;
    const openCategories = categories.filter((category) => isOpen(category.id));
    if (!openCategories.length) return overview;
    const toggle = `<div class="pp-toolbar"><button type="button" class="pp-chip${jwState.creditHideDone ? " on" : ""}" data-credit-hide-done aria-pressed="${jwState.creditHideDone}">${jwState.creditHideDone ? "显示已修完" : "隐藏已修完"}</button><span>${grades.length} 门成绩记录</span></div>`;
    const courseCard = (r) => {
      const done = jwGradeDone(r);
      return `<div class="jw-card jw-credit-course ${done ? "done" : "fail"}">
        <div class="jw-card-t">${esc(r.KCMC || "（未命名课程）")}</div>
        ${jwMetaLine([
          jwTag(`${Number(r.XF) || 0} 学分`, done ? "ok" : "warn"),
          jwTag(done ? "已获得学分" : "未获得学分", done ? "ok" : "live"),
          r.ZPCJ != null && String(r.ZPCJ) !== "" ? jwTag(`成绩 ${r.ZPCJ}`) : "",
          r.XNXQ ? jwTag(jwTermName(r.XNXQ)) : "",
        ])}
      </div>`;
    };
    const panels = openCategories.map((category) => {
      const head = `${category.earned} / ${category.target || "--"} 学分`;
      const groups = jwCreditGroups(category, moduleRows).map((m) => ({
        ...m, shown: jwState.creditHideDone ? m.rows.filter((r) => !jwGradeDone(r)) : m.rows,
      })).filter((m) => m.shown.length || m.target !== null);
      if (!groups.length) return jwSection(`${category.title}学分`, head, `<div class="pp-empty">暂无${category.title}课程成绩记录</div>`);
      const hiddenAll = groups.reduce((n, m) => n + (m.rows.length - m.shown.length), 0);
      const body = groups.map((m) => `<div class="jw-group">${jwModuleLine(m, m.rows.length - m.shown.length)}</div>${m.shown.map(courseCard).join("")}`).join("");
      return jwSection(`${category.title}学分`, `${head} · ${groups.length} 个课程模块${hiddenAll ? ` · 已隐藏 ${hiddenAll} 门` : ""}`, body);
    }).join("");
    return overview + `<div class="jw-credit-detail">${toggle + panels}</div>`;
  }

  function jwInnovationCreditHtml() {
    const summaries = jwState.data.cxCredit;
    const details = jwState.data.cxDetail;
    const summaryState = jwStateBlock("cxCredit", "正在读取创新学分汇总…");
    const detailState = jwStateBlock("cxDetail", "正在读取创新学分项目…");
    if (summaryState || detailState) return summaryState + detailState;
    if (!Array.isArray(summaries) || !Array.isArray(details)) return `<div class="pp-empty">还没有拉取过创新学分，点上方「刷新」</div>`;
    if (!summaries.length && !details.length) return `<div class="pp-empty">还没有创新实践学分记录</div>`;
    const sum = summaries.reduce((n, r) => n + (Number(r.SUM_VALUE) || 0), 0)
      || details.filter((r) => String(r.SY_AUDFLAG || "") === "ENDED").reduce((n, r) => n + (Number(r.CREDIT_VALUE) || 0), 0);
    const applyAll = summaries.reduce((n, r) => n + (Number(r.APPLYALL) || 0), 0) || details.length;
    const ended = summaries.reduce((n, r) => n + (Number(r.END_VALUE) || 0), 0)
      || details.filter((r) => String(r.SY_AUDFLAG || "") === "ENDED").length;
    const top = `<div class="jw-sum"><b>${sum}</b><span>创新实践学分 · 申请 ${applyAll} 项 / 已认定 ${ended} 项</span></div>`;
    const byTerm = new Map();
    for (const row of details) {
      const term = String(row.DECLARE_YEAR_SEMESTER || "未标注学期");
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term).push(row);
    }
    const projects = [...byTerm.entries()].map(([term, rows], index) => {
      const termCredits = rows.reduce((n, r) => n + (Number(r.CREDIT_VALUE) || 0), 0);
      const cards = rows.map((r) => {
        const approved = String(r.SY_AUDFLAG || "") === "ENDED" || String(r.SY_CURRENTTASK || "").includes("结束");
        const status = approved ? "已认定" : (r.SY_CURRENTTASK || r.SY_AUDFLAG || "处理中");
        const detailCells = [
          ["申请理由", r.REASONS_FOR_APPLYING_CREDIT],
          ["认定方式", r.ASSESSMENT_METHOD],
          ["责任单位", r.RESPONSIBLE_UNIT],
          ["申报时间", r.DECLARATION_DATE],
        ].filter(([, value]) => value).map(([label, value]) => `<div class="jw-detail-cell"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join("");
        return `<details class="jw-card jw-cx-project${approved ? "" : " pending"}">
          <summary><div class="jw-card-t">${esc(r.CONTENT || r.ASSESSMENT_ITEMS || "（未命名创新项目）")}</div>${jwTag(`${Number(r.CREDIT_VALUE) || 0} 学分`, "ok")}${jwTag(status, approved ? "ok" : "warn")}</summary>
          ${jwMetaLine([
            r.ASSESSMENT_ITEMS ? jwTag(r.ASSESSMENT_ITEMS) : "",
            r.CATEGORY ? jwTag(r.CATEGORY) : "",
            r.ASSESSMENT_CONTENTS_STANDARDS ? jwTag(r.ASSESSMENT_CONTENTS_STANDARDS) : "",
          ])}
          ${detailCells ? `<div class="jw-detail-grid">${detailCells}</div>` : ""}
        </details>`;
      }).join("");
      return `<details class="jw-cx-term"${index === 0 ? " open" : ""}><summary>${esc(jwTermName(term))}<small>${rows.length} 项 · ${termCredits} 学分</small></summary>${cards}</details>`;
    }).join("");
    return top + (projects || `<div class="pp-empty">汇总已经发布，但教务暂未返回具体申报项目</div>`);
  }

  // cppu-helper v15.0 的 GradesFragment：卡片顺序、统计口径、分段和学期列表。
  const gradeNum = (r, key) => Number(r?.[key]) || 0;
  const gradeSum = (rows, key) => rows.reduce((n, r) => n + gradeNum(r, key), 0);
  const gradeGpa = (rows) => {
    const credits = gradeSum(rows, "XF");
    return credits ? rows.reduce((n, r) => n + gradeNum(r, "XF") * gradeNum(r, "JD"), 0) / credits : 0;
  };
  const gradeSemLabel = (code) => {
    const m = String(code || "").match(/(\d{4})(\d{4})-(\d)/);
    return m ? `${m[1]}-${m[2]} 学年 · ${m[3] === "1" ? "秋" : "春"}` : String(code || "");
  };
  const gradeScoreTone = (n) => n >= 90 ? "good" : n >= 80 ? "mid" : n >= 70 ? "warn" : n > 0 ? "bad" : "muted";
  const gradeGpaTone = (n) => n >= 3.5 ? "good" : n >= 3 ? "mid" : n >= 2.5 ? "warn" : "bad";
  const gradeCard = (title, body) => `<section class="jg-card">${title ? `<h4>${title}</h4>` : ""}${body}</section>`;
  const gradePair = (label, value) => `<div class="jg-pair"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  const gradeBar = (label, value, ratio, tone) => `<div class="jg-bar-row"><div><span>${esc(label)}</span><b class="jg-${tone}">${esc(value)}</b></div><div class="jg-track"><i class="jg-${tone}" style="width:${Math.max(0, Math.min(100, ratio * 100))}%"></i></div></div>`;

  function jwGradesHtml() {
    const stateBlock = jwStateBlock("grade", "正在读取成绩…");
    if (stateBlock) return stateBlock;
    const rows = jwState.data.grade;
    if (!Array.isArray(rows)) return `<div class="pp-empty">还没有拉取过成绩数据，点上方「刷新」</div>`;
    if (!rows.length) return `<div class="pp-empty">暂无成绩数据</div>`;
    const credits = gradeSum(rows, "XF");
    const gpa = gradeGpa(rows);
    const scored = rows.filter((r) => gradeNum(r, "ZPCJ") > 0 && gradeNum(r, "XF") > 0);
    const scoredCredits = gradeSum(scored, "XF");
    const average = scoredCredits ? scored.reduce((n, r) => n + gradeNum(r, "XF") * gradeNum(r, "ZPCJ"), 0) / scoredCredits : 0;
    const plainAverage = scored.length ? gradeSum(scored, "ZPCJ") / scored.length : 0;
    const max = [...rows].sort((a, b) => gradeNum(b, "ZPCJ") - gradeNum(a, "ZPCJ"))[0];
    const min = [...rows].filter((r) => gradeNum(r, "ZPCJ") > 0).sort((a, b) => gradeNum(a, "ZPCJ") - gradeNum(b, "ZPCJ"))[0];
    const scoreName = (r) => r ? `${r.KCMC || ""} ${Math.trunc(gradeNum(r, "ZPCJ"))}` : "—";
    const bySem = new Map();
    for (const row of rows) if (String(row.XNXQ || "")) {
      const key = String(row.XNXQ);
      if (!bySem.has(key)) bySem.set(key, []);
      bySem.get(key).push(row);
    }
    const semAsc = [...bySem].sort(([a], [b]) => a.localeCompare(b));
    const overview = `<div class="jg-metrics">
      <div><small>总学分</small><b class="jw-credit-value">${credits.toFixed(1)}</b></div><div><small>已修课程</small><b>${rows.length} 门</b></div>
      <div><small>平均绩点</small><b>${gpa.toFixed(3)}</b></div><div><small>平均分</small><b>${average.toFixed(1)}</b></div></div>
      ${Math.abs(plainAverage - average) >= .5 ? `<p class="jg-note">平均分按学分加权（与 GPA 同口径）；学校系统多为算术平均 ${plainAverage.toFixed(1)}</p>` : ""}
      <div class="jg-divider"></div>${gradePair("最高分", scoreName(max))}${gradePair("最低分", scoreName(min))}`;
    const trend = semAsc.length > 1 ? gradeCard("📈 GPA 走势", semAsc.map(([sem, list]) => {
      const n = gradeGpa(list);
      return gradeBar(gradeSemLabel(sem), n.toFixed(3), n / 5, gradeGpaTone(n));
    }).join("")) : "";
    const palette = ["#1B3A6B", "#2C5282", "#3E7CB1", "#5B9BD5", "#7FB3E0", "#A8CCEA"];
    const progress = gradeCard("🎯 学分进度", `<div class="jg-segments">${semAsc.map(([, list], i) => `<i style="width:${credits ? gradeSum(list, "XF") / credits * 100 : 0}%;background:${palette[Math.min(i, palette.length - 1)]}"></i>`).join("")}</div>
      ${gradePair("已修学分", credits.toFixed(1))}${gradePair("参考毕业学分", "170（仅供参考）")}${gradePair("完成度", `${Math.min(100, credits / 170 * 100).toFixed(1)}%`)}${gradePair("总学时", String(Math.round(gradeSum(rows, "ZXS"))))}
      <div class="jg-note">${semAsc.map(([sem, list]) => `${gradeSum(list, "XF").toFixed(1)}  ${esc(gradeSemLabel(sem))}`).join("<br>")}</div>`);
    const positive = rows.map((r) => gradeNum(r, "ZPCJ")).filter((n) => n > 0);
    const buckets = [["90+", (n) => n >= 90, "good"], ["80-89", (n) => n >= 80 && n < 90, "mid"], ["70-79", (n) => n >= 70 && n < 80, "warn"], ["60-69", (n) => n >= 60 && n < 70, "bad"], ["60以下", (n) => n < 60, "bad"]];
    const distribution = gradeCard("📊 成绩分布", buckets.map(([label, test, tone]) => {
      const count = positive.filter(test).length;
      return gradeBar(label, `${count} 门`, count / Math.max(positive.length, 1), tone);
    }).join(""));
    const categories = new Map();
    for (const r of rows) {
      const key = String(r.KCSX || "");
      if (!categories.has(key)) categories.set(key, []);
      categories.get(key).push(r);
    }
    const category = gradeCard("🎓 课程构成", [...categories].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) =>
      gradePair(`${key === "01" ? "必修" : key === "02" ? "选修" : "其他"}（${list.length} 门）`, `${gradeSum(list, "XF").toFixed(1)} 学分 · GPA ${gradeGpa(list).toFixed(3)}`)).join(""));
    const exportCard = gradeCard("📤 导出成绩单", `<p class="jg-note">生成本机图片（不含账号密码），可直接分享或保存</p><button type="button" class="pp-btn pri jg-export" data-grade-export>生成并分享成绩单图片</button>`);
    const semesters = [...semAsc].reverse().map(([sem, list]) => gradeCard(`${esc(gradeSemLabel(sem))}　${list.length} 门 · ${gradeSum(list, "XF").toFixed(1)} 学分 · GPA ${gradeGpa(list).toFixed(3)}`,
      [...list].sort((a, b) => gradeNum(b, "ZPCJ") - gradeNum(a, "ZPCJ")).map((r) => `<div class="jg-course"><span>${esc(r.KCMC || "")}</span><b class="jg-${gradeScoreTone(gradeNum(r, "ZPCJ"))}">${gradeNum(r, "ZPCJ").toFixed(0)}</b><small>${gradeNum(r, "XF").toFixed(1)}</small></div>`).join(""))).join("");
    return `<div class="jg-status">${jwState.at.grade ? `更新于 ${esc(jwAt("grade").replace("更新于 ", ""))} · ` : ""}共 ${rows.length} 门 · 总学分 ${credits.toFixed(1)} · GPA ${gpa.toFixed(3)}</div>${gradeCard("", overview)}${trend}${progress}${distribution}${category}${exportCard}${semesters}`;
  }

  async function jwExportGrades() {
    const rows = jwState.data.grade;
    if (!Array.isArray(rows) || !rows.length) { tide.notify("成绩还没加载好"); return; }
    const semesters = [...new Set(rows.map((r) => String(r.XNXQ || "")).filter(Boolean))].sort().reverse();
    const width = 1080, line = 56, height = 400 + semesters.reduce((n, sem) => n + 94 + rows.filter((r) => String(r.XNXQ || "") === sem).length * line, 0);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) { tide.notify("当前设备无法生成图片"); return; }
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
    const scored = rows.filter((r) => gradeNum(r, "ZPCJ") > 0 && gradeNum(r, "XF") > 0);
    const scoredCredits = gradeSum(scored, "XF");
    const average = scoredCredits ? scored.reduce((n, r) => n + gradeNum(r, "ZPCJ") * gradeNum(r, "XF"), 0) / scoredCredits : 0;
    ctx.fillStyle = "#1B3A6B"; ctx.font = "bold 44px sans-serif"; ctx.fillText("成绩单", 48, 80);
    ctx.fillStyle = "#5A6472"; ctx.font = "24px sans-serif";
    ctx.fillText(state.username || "学生", 48, 126);
    ctx.fillText(`共 ${rows.length} 门 · 总学分 ${gradeSum(rows, "XF").toFixed(1)} · GPA ${gradeGpa(rows).toFixed(3)} · 平均分 ${average.toFixed(1)}`, 48, 160);
    ctx.fillStyle = "#6B7684"; ctx.font = "22px sans-serif";
    ctx.fillText(`导出时间 ${new Date().toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replaceAll("/", "-")}`, 48, 186);
    ctx.fillStyle = "#1B3A6B"; ctx.fillRect(48, 226, 984, 3);
    let y = 279;
    for (const sem of semesters) {
      const list = rows.filter((r) => String(r.XNXQ || "") === sem).sort((a, b) => gradeNum(b, "ZPCJ") - gradeNum(a, "ZPCJ"));
      ctx.fillStyle = "#1B3A6B"; ctx.font = "bold 30px sans-serif";
      ctx.fillText(gradeSemLabel(sem), 48, y);
      const summary = `${list.length} 门 · ${gradeSum(list, "XF").toFixed(1)} 学分 · GPA ${gradeGpa(list).toFixed(3)}`;
      ctx.font = "bold 26px sans-serif"; ctx.fillText(summary, 1032 - ctx.measureText(summary).width, y);
      y += 44;
      for (const r of list) {
        ctx.fillStyle = "#1B2027"; ctx.font = "26px sans-serif";
        let name = String(r.KCMC || "");
        while (name.length > 1 && ctx.measureText(name).width > 754) name = name.slice(0, -1);
        if (name !== String(r.KCMC || "")) name = name.slice(0, -1) + "…";
        ctx.fillText(name, 48, y);
        ctx.fillStyle = "#1B3A6B"; ctx.font = "bold 26px sans-serif"; ctx.fillText(gradeNum(r, "ZPCJ").toFixed(0), 882, y);
        ctx.fillStyle = "#6B7684"; ctx.font = "22px sans-serif"; ctx.fillText(gradeNum(r, "XF").toFixed(1), 992, y);
        y += line;
      }
      y += 30;
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) { tide.notify("图片生成失败"); return; }
    const name = `成绩单-${new Date().toISOString().slice(0, 10)}.png`;
    const file = new File([blob], name, { type: "image/png" });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try { await navigator.share({ files: [file], title: "分享成绩单" }); return; } catch (e) { if (e?.name === "AbortError") return; }
    }
    // Android / Tauri WebView 的 <a download> 不可靠，落盘走宿主已有的下载桥。
    try {
      const path = await tide.assets.saveBase64(name, canvas.toDataURL("image/png").split(",")[1]);
      tide.notify(`成绩单图片已保存：${path}`);
    } catch (e) { tide.notify(`保存成绩单失败：${String(e?.message || e)}`); }
  }

  const JW_VIEWS = [
    {
      id: "cppu-xk", title: "警大选课", icon: "list-check", keys: ["xkTask", "xkResult"], menu: JW_MENU.xk,
      kicker: "教 务 · 学 生 选 课",
      tip: "选择任务可进入 U-Time 选课页查看状态与本学期已选课程；已结束和过期任务会自动置灰。",
      body: () => jwState.selectedTaskId ? jwTaskDetailHtml() : jwTaskHtml() + jwResultHtml(),
    },
    {
      id: "cppu-qj", title: "警大请假", icon: "calendar-xmark", keys: ["qjRecord", "qjCourse"], menu: JW_MENU.qj,
      kicker: "教 务 · 学 生 请 假",
      tip: "这里可以直接选课次、填写请假理由并生成申请草稿；点「去教务提交」会免密打开教务，最终提交仍由学校系统确认。",
      body: () => jwLeaveHtml(),
    },
    {
      // 保留旧视图 id：用户原先的导航入口与快捷键继续有效，内容切到 cppu-helper 成绩页。
      id: "cppu-credit", title: "警大成绩", icon: "chart-line", keys: ["grade"], menu: JW_MENU.grades,
      kicker: "教 务 · 成 绩",
      tip: "课程成绩、学分和 GPA 按教务原始记录汇总。参考毕业学分仅供参考；刷新可重新读取学校数据。",
      body: () => jwGradesHtml(),
    },
    {
      id: "cppu-cx", title: "警大创新学分", icon: "medal", keys: ["cxCredit", "cxDetail"], menu: JW_MENU.cx,
      kicker: "教 务 · 创 新 实 践 学 分",
      tip: "按学期显示创新实践申报项目、级别、奖项、认定学分和审核状态。",
      body: () => jwInnovationCreditHtml(),
    },
  ];

  function jwShellHtml(cfg) {
    return `<div class="${sideShellClass()}">
      <aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}
      <div class="pp-main"><div class="pp-wrap">
      <div class="jw-kicker">${esc(cfg.kicker)}</div>
      <div class="jw-head"><h3>${esc(cfg.title)}</h3><span data-jw-term>${esc(jwState.term ? `${jwState.term.name}（${jwState.term.code}）` : "学期加载中…")}</span></div>
      <div class="pp-toolbar">
        <button class="pp-btn pri" data-jw-refresh>刷新</button>
        <button class="pp-btn" data-jw-site>去教务</button>
        <button class="pp-btn" data-jw-back>回通知</button>
        <button class="pp-btn" data-jw-login>重新登录</button>
        <span style="flex:1"></span>
      </div>
      <div class="jw-tip">${esc(cfg.tip)}</div>
      <div data-jw-body>${cfg.body()}</div>
      <div style="height:30px"></div>
      </div></div>
    </div>`;
  }
  function jwPaint() {
    for (const [id, m] of [...jwMounted]) {
      if (!m.el || !m.el.isConnected) { jwMounted.delete(id); continue; }
      const body = m.el.querySelector("[data-jw-body]");
      if (body) body.innerHTML = m.cfg.body();
      const term = m.el.querySelector("[data-jw-term]");
      if (term) term.textContent = jwState.term ? `${jwState.term.name}（${jwState.term.code}）` : "学期加载中…";
    }
  }

  function mountJwView(el, cfg) {
    ensureStyle();
    el.innerHTML = jwShellHtml(cfg);
    jwMounted.set(cfg.id, { el, cfg });
    bindSide(el);
    loadLinkMeta(el);
    const openLogin = async () => {
      await prepareLoginForm();
      if (!el.isConnected) return;
      paintLogin(el, loginHint?.msg || "", {
        prefillCode: loginHint?.code || "",
        onDone: () => {
          el.innerHTML = jwShellHtml(cfg);
          bindSide(el);
          loadLinkMeta(el);
          jwEnsureKeys(cfg.keys, true);
        },
        onFailure: () => {
          if (!cfg.keys.some(key => Array.isArray(jwState.data[key]))) return false;
          el.innerHTML = jwShellHtml(cfg);
          bindSide(el);
          jwPaint();
          return true;
        },
      });
    };
    el.addEventListener("click", async (e) => {
      if (e.target.closest("[data-jw-login]")) { await openLogin(); return; }
      if (e.target.closest("[data-jw-refresh]")) { await jwEnsureKeys(cfg.keys, true); return; }
      if (e.target.closest("[data-jw-back]")) { tide.util.navigate("plug:cppu-notify"); return; }
      if (e.target.closest("[data-jw-site]")) {
        const btn = e.target.closest("[data-jw-site]");
        await openSideLink(JW_INDEX, btn);
        tide.notify(`在教务里打开：${cfg.menu}`);
        return;
      }
      if (e.target.closest("[data-grade-export]")) { await jwExportGrades(); return; }
      if (e.target.closest("[data-jw-task-back]")) {
        jwState.selectedTaskId = "";
        jwPaint();
        return;
      }
      const taskBtn = e.target.closest("[data-jw-task]");
      if (taskBtn) {
        jwState.selectedTaskId = taskBtn.dataset.jwTask || "";
        jwPaint();
        return;
      }
      const taskSite = e.target.closest("[data-jw-task-site]");
      if (taskSite) {
        await openSideLink(JW_INDEX, taskSite);
        tide.notify(`已打开教务，请进入「${JW_MENU.xk}」办理`);
        return;
      }
      const scope = e.target.closest("[data-jw-scope]");
      if (scope) {
        jwState.courseScope = scope.dataset.jwScope || "week";
        jwPaint();
        if (!Array.isArray(jwState.data.qjCourse)) await jwEnsureKeys(["qjCourse"]);
        return;
      }
      const leaveBtn = e.target.closest("[data-leave-course]");
      if (leaveBtn) {
        jwState.leaveCourseId = leaveBtn.dataset.leaveCourse || "";
        jwPaint();
        return;
      }
      const leaveSite = e.target.closest("[data-leave-site]");
      if (leaveSite) {
        jwState.leaveReason = el.querySelector("[data-leave-reason]")?.value || jwState.leaveReason;
        await openSideLink(JW_INDEX, leaveSite);
        tide.notify("已打开教务，请进入「学生服务 › 我的课程表 › 我的课表 › 学生请假申请」提交");
        return;
      }
      if (e.target.closest("[data-leave-task]")) {
        const rows = jwState.data.qjCourse || [];
        const r = rows.find((x) => jwCourseId(x) === jwState.leaveCourseId);
        jwState.leaveReason = el.querySelector("[data-leave-reason]")?.value || jwState.leaveReason;
        if (r) {
          tide.tasks.create({
            title: `提交请假：${r.KCMC || "课程"}`,
            quad: 1,
            tags: ["警大请假"],
            note: [`课次：${jwCourseTime(r)}`, `教师：${r.JS || ""}`, `地点：${r.DDMC || ""}`, `理由：${jwState.leaveReason || "（待填写）"}`].join("\n"),
          });
          tide.notify("已把请假草稿存成待办");
        }
        return;
      }
      if (e.target.closest("[data-credit-hide-done]")) {
        jwState.creditHideDone = !jwState.creditHideDone;
        jwPaint();
        await jwSaveCache();
        return;
      }
      const creditBtn = e.target.closest("[data-credit-toggle]");
      if (creditBtn) {
        const key = creditBtn.dataset.creditToggle || "";
        const closing = jwState.expandedCredit.has(key);
        if (closing) jwState.expandedCredit.delete(key); else jwState.expandedCredit.add(key);
        const detail = closing ? el.querySelector(".jw-credit-detail") : null;
        if (!detail || detail.classList.contains("out")) { jwPaint(); return; }
        // 明细整块是 innerHTML 重绘的，先重绘就等于把淡出掐死在半路，得等它播完
        const finish = () => { if (detail.isConnected) jwPaint(); };
        detail.addEventListener("animationend", (ev) => { if (ev.target === detail) finish(); });
        setTimeout(finish, 400);
        detail.classList.add("out");
        return;
      }
    });
    el.addEventListener("input", (e) => {
      if (e.target.matches("[data-leave-reason]")) jwState.leaveReason = e.target.value;
    });
    (async () => {
      await loadPrefs();
      await jwRestoreCache();
      jwPaint();
      await jwEnsureKeys(cfg.keys);
      // 登录失败保留已有缓存；没有缓存时显示共用登录卡。
      if (!jwLive() && el.isConnected && cfg.keys.some(key => Array.isArray(jwState.data[key]))) {
        for (const key of cfg.keys) jwState.error[key] = `登录失败，正在显示缓存（${jwAt(key)}）；可点击「重新登录」重试。`;
        jwPaint();
      } else if (!jwLive() && el.isConnected) {
        await prepareLoginForm();
        paintLogin(el, loginHint?.msg || "", {
          prefillCode: loginHint?.code || "",
          // 只换回页面内容，不重跑 mountJwView：那两个 el 上的监听器挂在容器本身，
          // 再挂一遍会让「刷新」一次点触发两轮拉取。
          onDone: () => {
            el.innerHTML = jwShellHtml(cfg);
            bindSide(el);
            loadLinkMeta(el);
            jwEnsureKeys(cfg.keys);
          },
        });
      }
    })();
    return () => { jwMounted.delete(cfg.id); };
  }

  const cardState = {
    rows: [], mode: "month", kind: "in", sid: null, username: "", password: "", accessToken: "",
    tokenType: "bearer", refreshToken: "", expiresAt: 0, loading: false, syncedAt: 0, error: "",
    balance: null, balanceAt: 0, balanceError: "", billsPartial: false,
  };
  let cardAveragePanel = null, cardAverageLoading = null, cardAverageError = "";
  function loadCardAveragePanel(root) {
    if (!cardAverageLoading) {
      cardAverageLoading = import("/plugins/cppu-notify/card-averages.js")
        .then(module => module.createCardAverages(tide.storage))
        .then(panel => { cardAveragePanel = panel; cardAverageError = ""; })
        .catch(() => { cardAverageError = "日均统计模块加载失败，请重新打开一卡通重试"; cardAverageLoading = null; });
    }
    cardAverageLoading.then(() => { if (root?.isConnected !== false) cardPaintStats(root); });
  }
  const cardMoney = (n) => `¥${(Number(n) || 0).toFixed(2)}`;
  const cardPeriodKey = (date, mode) => {
    const s = String(date || "");
    if (mode === "year") return s.slice(0, 4) || "未知年份";
    if (mode === "day") return s.slice(0, 10) || "未知日期";
    return s.slice(0, 7) || "未知月份";
  };
  const cardPeriodLabel = (key, mode) => {
    if (mode === "year" && /^\d{4}$/.test(key)) return `${key} 年`;
    if (mode === "month" && /^\d{4}-\d{2}$/.test(key)) {
      const [y, m] = key.split("-");
      return `${y} 年 ${Number(m)} 月`;
    }
    if (mode === "day" && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
      const [, m, d] = key.split("-");
      return `${Number(m)} 月 ${Number(d)} 日`;
    }
    return key;
  };
  function cardCleanRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      id: String(r.id || `${r.date || "unknown"}-${r.amount || 0}-${r.note || ""}`),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? String(r.date) : "",
      amount: Math.max(0, Math.round((Number(r.amount) || 0) * 100) / 100),
      note: String(r.note || "").slice(0, 80),
      merchant: String(r.merchant || "").slice(0, 160),
      kind: r.kind === "out" ? "out" : "in",
      at: Number(r.at || 0),
    })).filter((r) => r.date && r.amount > 0).sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.at - a.at).slice(0, 5000);
  }
  function cardRecordText(row) {
    return [row?.resume, row?.turnoverType, row?.title, row?.summary, row?.typeName, row?.remark]
      .filter(Boolean).join(" ");
  }
  function cardIsRecharge(row) {
    const text = cardRecordText(row);
    if (String(row?.typeFrom || "") !== "1") return false;
    if (/退款|退费|冲正|撤销|补助|补贴|奖学金/.test(text)) return false;
    return /充值|圈存|存款/.test(text);
  }
  function cardIsExpense(row) {
    /* 平台用 typeFrom 标方向（官方 H5 也拿它决定 +/-）；方向缺失就不算，
       宁可少统计也不能把来路不明的流水记成消费 */
    const from = String(row?.typeFrom ?? "");
    return from !== "" && from !== "1";
  }
  function cardNormalizeBill(row, kind = "in") {
    const rawDate = String(row?.effectdateStr || row?.jndatetimeStr || row?.effectdate || row?.jndatetime || "");
    const date = rawDate.match(/\d{4}[-/]\d{2}[-/]\d{2}/)?.[0]?.replaceAll("/", "-") || "";
    const amount = Math.abs(Number(row?.tranamt || 0)) / 100;
    const note = cardRecordText(row) || (kind === "out" ? "一卡通消费" : "一卡通充值");
    const id = String(row?.orderId || row?.id || row?.serialNo || `${date}-${amount}-${note}`);
    const merchant = [row?.merchantName, row?.mername, row?.shopName, row?.merchant, row?.terminalName].filter(value => typeof value === "string").join(" ").slice(0,160);
    return { id, date, amount, note, merchant, kind: kind === "out" ? "out" : "in", at: Date.parse(rawDate.replaceAll("/", "-")) || 0 };
  }
  function cardTotals(mode = cardState.mode) {
    const groups = { in: new Map(), out: new Map() };
    const sums = { in: 0, out: 0 };
    for (const r of cardState.rows) {
      const kind = r.kind === "out" ? "out" : "in";
      sums[kind] += Number(r.amount) || 0;
      const key = cardPeriodKey(r.date, mode);
      groups[kind].set(key, (groups[kind].get(key) || 0) + (Number(r.amount) || 0));
    }
    const toItems = (kind) => [...groups[kind].entries()]
      .map(([key, amount]) => ({ key, amount }))
      .sort((a, b) => String(b.key).localeCompare(String(a.key)));
    const inItems = toItems("in"), outItems = toItems("out");
    return {
      total: sums.in,
      spent: sums.out,
      inCount: cardState.rows.filter((r) => r.kind !== "out").length,
      outCount: cardState.rows.filter((r) => r.kind === "out").length,
      items: cardState.kind === "out" ? outItems : inItems,
      max: Math.max(1, ...inItems.map((x) => x.amount), ...outItems.map((x) => x.amount)),
    };
  }
  function cardStatsHtml() {
    const { total, spent, inCount, outCount, items, max } = cardTotals();
    const kindLabels = { in: "充值", out: "消费" };
    const modeLabels = { year: "按年", month: "按月", day: "按日" };
    const kindChips = Object.entries(kindLabels).map(([kind, label]) =>
      `<button type="button" class="pp-chip${cardState.kind === kind ? " on" : ""}" data-card-kind="${kind}">${label}</button>`).join("");
    const modeChips = Object.entries(modeLabels).map(([mode, label]) =>
      `<button type="button" class="pp-chip${cardState.mode === mode ? " on" : ""}" data-card-mode="${mode}">${label}</button>`).join("");
    const bars = items.length ? items.slice(0, 18).map((it) =>
      `<div class="yk-bar"><span>${esc(cardPeriodLabel(it.key, cardState.mode))}</span><i style="width:${Math.max(4, Math.round(it.amount / max * 100))}%"></i><span>${esc(cardMoney(it.amount))}</span></div>`).join("")
      : `<div class="yk-empty">暂未从一卡通账单识别到${kindLabels[cardState.kind] || "充值"}记录。连接校园网后点“同步账单”再试。</div>`;
    const rows = cardState.rows.slice(0, 16).map((r) => `<div class="yk-ledger-row${r.kind === "out" ? " out" : ""}" data-card-row="${esc(r.id)}">
      <span>${esc(r.date)}</span><b>${r.kind === "out" ? "-" : "+"}${esc(cardMoney(r.amount))}</b><span>${esc(r.note || kindLabels[r.kind === "out" ? "out" : "in"])}</span>
    </div>`).join("") || `<div class="yk-empty">暂无平台流水记录。本页不再需要手工“记一笔”。</div>`;
    const synced = cardState.syncedAt ? new Date(cardState.syncedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
    const balanceSynced = cardState.balanceAt ? new Date(cardState.balanceAt).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
    return `<div class="yk-stat">
      <div class="yk-total"><small>总充值量</small><b>${esc(cardMoney(total))}</b><span>共 ${inCount} 笔一卡通平台充值记录，可按年份 / 月份 / 日期汇总查看。</span></div>
      <div class="yk-spent"><small>已花费</small><b>${esc(cardMoney(spent))}</b><span>共 ${outCount} 笔一卡通平台消费流水（含食堂、商超、洗浴等刷卡支出）。</span></div>
      <div class="yk-balance"><small>当前余额</small><b>${cardState.balance == null ? "--" : esc(cardMoney(cardState.balance))}</b><span>一卡通平台实时余额（校园卡账户 + 电子账户，含未结算金额） · ${esc(balanceSynced)}${cardState.balanceError ? ` · ${esc(cardState.balanceError)}` : ""}</span></div>
      <div class="yk-account"><span>账单来源：<b>一卡通平台</b></span><span>最后同步：${esc(synced)}</span>${cardState.error ? `<span class="warn">${esc(cardState.error)}</span>` : ""}</div>
    </div>
    <div data-card-averages><p>${esc(cardAverageError || "正在载入日均餐费统计…")}</p></div>
    <div class="yk-groups"><div class="yk-group-head"><b>流水统计</b><div class="pp-chips">${kindChips}</div><div class="pp-chips">${modeChips}</div></div><div class="yk-bars${cardState.kind === "out" ? " out" : ""}">${bars}</div></div>
    <div class="yk-ledger">${rows}</div>`;
  }
  function cardPaintStats(root) {
    const box = root?.querySelector?.("[data-card-stats]");
    if (box) {
      box.innerHTML = cardStatsHtml();
      try { cardAveragePanel?.render(box.querySelector("[data-card-averages]"), cardState.rows, { syncedAt: cardState.syncedAt, partial: cardState.billsPartial }); }
      catch { const panel=box.querySelector("[data-card-averages]"); if(panel)panel.textContent="日均统计暂不可用，不影响账单和工具栏操作"; }
    }
  }
  function cardPaintLogin(root) {
    const box = root?.querySelector?.("[data-card-login-box]");
    if (!box) return;
    if (cardState.accessToken && !cardState.error) {
      box.innerHTML = `<div class="yk-account"><span>已自动登录：<b>${esc(cardState.username || "一卡通账号")}</b></span><span>账号和密码已加密保存在本机密钥库。</span><button type="button" class="pp-btn" data-card-change>更换账号</button></div>`;
      return;
    }
    box.innerHTML = `<div class="yk-login">
      <input type="text" inputmode="numeric" autocomplete="username" data-card-user value="${esc(cardState.username)}" placeholder="学/工号" aria-label="一卡通学号或工号">
      <input type="password" autocomplete="current-password" data-card-pass value="${esc(cardState.password)}" placeholder="一卡通密码" aria-label="一卡通密码">
      <button type="button" class="pp-btn pri" data-card-login>${cardState.loading ? "正在登录…" : "登录并自动同步"}</button>
      <small>登录成功后，账号、密码和令牌只会加密保存在本机密钥库；下次打开将完全自动登录并同步账单。</small>
    </div>`;
  }
  function cardSetStatus(root, text, warn = false) {
    const status = root?.querySelector?.("[data-card-status]");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("warn", warn);
  }
  function cardAuthedUrl(url) {
    const parsed = new URL(url, CARD_ORIGIN);
    if (parsed.origin !== CARD_ORIGIN || parsed.username || parsed.password) throw new Error("仅支持一卡通官方站点");
    parsed.searchParams.delete("synjones-auth");
    if (cardState.accessToken && cardState.expiresAt > Date.now()) parsed.searchParams.set("synjones-auth", cardState.accessToken);
    return parsed.href;
  }
  async function cardSaveSecret() {
    await tide.vault.set(CARD_VAULT_KEY, JSON.stringify({
      username: cardState.username, password: cardState.password, accessToken: cardState.accessToken,
      tokenType: cardState.tokenType, refreshToken: cardState.refreshToken, expiresAt: cardState.expiresAt,
    }));
  }
  async function cardRestoreSecret() {
    let saved = null;
    try { saved = JSON.parse((await tide.vault.get(CARD_VAULT_KEY)) || "null"); } catch { saved = null; }
    cardState.username = String(saved?.username || await tide.storage.get("username", "") || "");
    cardState.password = String(saved?.password || "");
    if (!cardState.password) {
      try { cardState.password = String(JSON.parse((await tide.vault.get("secret")) || "null")?.password || ""); } catch { cardState.password = ""; }
    }
    cardState.accessToken = String(saved?.accessToken || "");
    cardState.tokenType = String(saved?.tokenType || "bearer");
    cardState.refreshToken = String(saved?.refreshToken || "");
    cardState.expiresAt = Number(saved?.expiresAt || 0);
  }
  async function cardLogin(username, password) {
    if (!username || !password) throw new Error("请输入一卡通学/工号和密码");
    if (!cardState.sid) cardState.sid = await tide.http.session();
    const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}` +
      "&grant_type=password&scope=all&loginFrom=h5&logintype=sno&device_token=h5";
    const res = await tide.http.fetch(cardState.sid, "POST", CARD_AUTH_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: CARD_BASIC_AUTH, Accept: "application/json" },
      body,
    });
    let data = null;
    try { data = JSON.parse(String(res?.body || "")); } catch { data = null; }
    if (res.status >= 400 || !data?.access_token) {
      const msg = data?.message || data?.msg || data?.error_description || `登录失败（HTTP ${res.status}）`;
      throw new Error(String(msg));
    }
    cardState.username = username;
    cardState.password = password;
    cardState.accessToken = String(data.access_token);
    cardState.tokenType = String(data.token_type || "bearer");
    cardState.refreshToken = String(data.refresh_token || "");
    cardState.expiresAt = Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000;
    await cardSaveSecret();
  }
  function cardAuthHeaders() {
    return { Accept: "application/json", Referer: CARD_BILLING, "synjones-auth": `${cardState.tokenType || "bearer"} ${cardState.accessToken}` };
  }
  function cardBalanceFromDetail(detail) {
    /* 入参可以是单张卡，也可以是平台返回的整叠卡（名下多卡时逐张相加） */
    let fen = 0;
    for (const item of Array.isArray(detail) ? detail : [detail]) {
      const settled = Number(item?.db_balance);
      const unsettled = Number(item?.unsettle_amount || 0);
      if (!Number.isFinite(settled) || !Number.isFinite(unsettled)) throw new Error("余额数据格式异常");
      /* 本校一卡通是「电子账户」模式（getEcardConfig 的 type=1）：校园卡主账户 db_balance 恒为 0，
         钱记在 accinfo[] 的各个电子账户上，官方 H5 在这种模式下也只渲染 accinfo 的余额。
         只读主账户就会永远显示 ¥0.00。 */
      const accounts = Array.isArray(item?.accinfo) ? item.accinfo : [];
      for (const acc of accounts) {
        const value = Number(acc?.balance || 0);
        if (!Number.isFinite(value)) throw new Error("电子账户余额数据格式异常");
        fen += value;
      }
      fen += settled + unsettled;
    }
    return Math.round(fen) / 100;
  }
  async function cardFetchBalance() {
    if (!cardState.sid) cardState.sid = await tide.http.session();
    const headers = cardAuthHeaders();
    const cardsRes = await tide.http.fetch(cardState.sid, "GET", CARD_LIST_URL, { headers });
    let cardsData = null;
    try { cardsData = JSON.parse(String(cardsRes?.body || "")); } catch { cardsData = null; }
    if (cardsRes.status === 401 || cardsData?.code === 401) { const error = new Error("一卡通登录已过期"); error.code = 401; throw error; }
    if (cardsRes.status >= 400 || Number(cardsData?.code || 200) >= 400) throw new Error(cardsData?.message || cardsData?.msg || `余额同步失败（HTTP ${cardsRes.status}）`);
    const cards = Array.isArray(cardsData?.data?.card) ? cardsData.data.card : [];
    const card = cards.find((item) => Number(item?.lostflag || 0) === 0) || cards[0];
    if (!card?.account) throw new Error("未找到可用的一卡通账户");
    const url = `${CARD_DETAIL_URL}?account=${encodeURIComponent(card.account)}`;
    const detailRes = await tide.http.fetch(cardState.sid, "GET", url, { headers });
    let detailData = null;
    try { detailData = JSON.parse(String(detailRes?.body || "")); } catch { detailData = null; }
    if (detailRes.status === 401 || detailData?.code === 401) { const error = new Error("一卡通登录已过期"); error.code = 401; throw error; }
    if (detailRes.status >= 400 || Number(detailData?.code || 200) >= 400) throw new Error(detailData?.message || detailData?.msg || `余额同步失败（HTTP ${detailRes.status}）`);
    if (String(detailData?.data?.retcode || "") !== "0") throw new Error(detailData?.data?.errmsg || "一卡通余额查询失败");
    const details = Array.isArray(detailData?.data?.card) ? detailData.data.card : [];
    /* queryCard 不回 accinfo 时用卡列表里同账户那份兜底（明细字段优先）；
       名下多卡时逐张相加，只查一张会漏掉另一张卡上的钱 */
    const byAccount = new Map(cards.map((item) => [String(item?.account || ""), item]));
    return cardBalanceFromDetail((details.length ? details : [card]).map((item) => ({
      ...(byAccount.get(String(item?.account || "")) || {}), ...item,
    })));
  }
  async function cardFetchTurnover(type) {
    const headers = cardAuthHeaders();
    const all = [];
    for (let current = 1; current <= CARD_MAX_PAGES; current++) {
      const url = `${CARD_BILLS_URL}?size=${CARD_PAGE_SIZE}&current=${current}&type=${type}`;
      const res = await tide.http.fetch(cardState.sid, "GET", url, { headers });
      let data = null;
      try { data = JSON.parse(String(res?.body || "")); } catch { data = null; }
      if (res.status === 401 || data?.code === 401) { const error = new Error("一卡通登录已过期"); error.code = 401; throw error; }
      if (res.status >= 400 || Number(data?.code || 200) >= 400) throw new Error(data?.message || `账单同步失败（HTTP ${res.status}）`);
      const page = data?.data || data || {};
      const records = Array.isArray(page.records) ? page.records : [];
      all.push(...records);
      const pages = Number(page.pages || Math.ceil(Number(page.total || records.length) / CARD_PAGE_SIZE) || 1);
      if (current === CARD_MAX_PAGES && pages > current) cardState.billsPartial = true;
      if (!records.length || current >= pages) break;
    }
    return all;
  }
  async function cardFetchBills() {
    if (!cardState.sid) cardState.sid = await tide.http.session();
    /* 平台用 type 区分方向：1 入账、2 支出。不传 type 时两类混在一起翻页，
       页数上限会把其中一类挤掉，所以收支各查一趟；
       方向最终以流水自带的 typeFrom 为准，参数被服务端忽略也不会记错。 */
    cardState.billsPartial = false;
    const raw = [...await cardFetchTurnover(1), ...await cardFetchTurnover(2)];
    if (raw.length > 5000) cardState.billsPartial = true;
    const income = raw.filter(cardIsRecharge).map((row) => cardNormalizeBill(row, "in"));
    const expense = raw.filter(cardIsExpense).map((row) => cardNormalizeBill(row, "out"));
    const seen = new Set();
    return cardCleanRows([...income, ...expense].filter((r) => {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
  }
  async function cardSync(root, forceLogin = false) {
    if (cardState.loading) return;
    cardState.loading = true;
    cardState.error = "";
    cardPaintLogin(root);
    cardSetStatus(root, "正在自动登录并同步一卡通账单…");
    try {
      if (forceLogin || !cardState.accessToken || cardState.expiresAt <= Date.now()) {
        await cardLogin(cardState.username, cardState.password);
      }
      try {
        cardState.rows = await cardFetchBills();
      } catch (error) {
        if (error?.code !== 401 || !cardState.password) throw error;
        await cardLogin(cardState.username, cardState.password);
        cardState.rows = await cardFetchBills();
      }
      cardState.balanceError = "";
      try {
        cardState.balance = await cardFetchBalance();
        cardState.balanceAt = Date.now();
      } catch (error) {
        cardState.balanceError = error?.message || "余额同步失败";
      }
      cardState.syncedAt = Date.now();
      await tide.storage.set(CARD_CACHE_KEY, {
        rows: cardState.rows, syncedAt: cardState.syncedAt,
        balance: cardState.balance, balanceAt: cardState.balanceAt, billsPartial: cardState.billsPartial,
      });
      const { inCount, outCount } = cardTotals();
      cardSetStatus(root, `已自动登录并同步 ${cardState.rows.length} 笔一卡通流水（充值 ${inCount} 笔 / 消费 ${outCount} 笔）。`);
      return true;
    } catch (error) {
      cardState.error = error?.message || String(error);
      cardSetStatus(root, `${cardState.error}。请核对一卡通密码，或确认当前网络能访问校园一卡通。`, true);
      return false;
    } finally {
      cardState.loading = false;
      cardPaintLogin(root);
      cardPaintStats(root);
    }
  }

  function cardShellHtml() {
    return `<div class="${sideShellClass()}">
      <aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}
      <div class="pp-main"><div class="pp-wrap">
      <div class="jw-kicker">校 园 服 务 · 一 卡 通</div>
      <div class="jw-head"><h3>一卡通</h3><span>慧新易校 / 新中新 H5</span></div>
      <div class="pp-toolbar">
        <button type="button" class="pp-btn pri" data-card-summary>统计</button>
        <button type="button" class="pp-btn" data-card-billing>账单</button>
        <button type="button" class="pp-btn" data-card-sync>同步账单</button>
        <button type="button" class="pp-btn" data-card-home>首页</button>
        <button type="button" class="pp-btn" data-card-recharge>充值</button>
        <button type="button" class="pp-btn" data-card-center>账户中心</button>
        <button type="button" class="pp-btn" data-card-reload>刷新</button>
        <button type="button" class="pp-btn" data-card-open>应用内新窗打开</button>
        <button type="button" class="pp-btn" data-card-back>回通知</button>
        <span style="flex:1"></span>
      </div>
      <div class="jw-tip">U-Time 会自动登录一卡通并读取平台账单，总充值、已花费及年/月/日统计均来自平台流水；当前余额读平台实时值，校园卡账户与电子账户合并计算。首次登录成功后凭据加密保存在本机，下次无需再次输入。</div>
      <div class="yk-status" data-card-status role="status" aria-live="polite">正在恢复一卡通登录信息…</div>
      <div data-card-login-box></div>
      <div data-card-web hidden><p class="jw-tip">当前为官方网页。若空白或未授权，请用“应用内新窗打开”完成官方登录；点击“统计”返回本地流水与日均统计。</p><div class="yk-frame-shell"><iframe class="yk-frame" data-card-frame src="about:blank" title="一卡通官方网页"></iframe></div></div>
      <div data-card-stats>${cardStatsHtml()}</div>
      <div style="height:30px"></div>
      </div></div>
    </div>`;
  }

  function mountCardView(el) {
    el._cardViewDispose?.();
    ensureStyle(); el.innerHTML = cardShellHtml();
    let alive = true, page = 'summary', currentUrl = CARD_BILLING, navSequence = 0, frameTimer = null, syncFlight = null;
    const frame = el.querySelector('[data-card-frame]');
    const shell = el.querySelector('[data-card-web]');
    const stats = el.querySelector('[data-card-stats]');
    const message = (text, warn = false) => { if (alive) cardSetStatus(el, text, warn); };
    const clearFrameTimer = () => { if (frameTimer) clearTimeout(frameTimer); frameTimer = null; };
    const selectPage = name => {
      page = name;
      if (shell) shell.hidden = name === 'summary';
      if (stats) stats.hidden = name !== 'summary';
      for (const key of ['summary','billing','home','recharge','center']) {
        const button = el.querySelector(`[data-card-${key}]`);
        button?.classList.toggle('pri', name === key); button?.setAttribute('aria-pressed', String(name === key));
      }
      if (name === 'summary') clearFrameTimer();
    };
    const showWeb = (name, url) => {
      if (!alive) return;
      if (!frame || !shell) { message('内嵌网页容器不可用，请使用“应用内新窗打开”', true); return; }
      currentUrl = url; selectPage(name); clearFrameTimer();
      message('正在载入官方页面；若出现空白或未授权，请使用“应用内新窗打开”在官方页面登录。');
      frame.src = cardAuthedUrl(url);
      frameTimer = setTimeout(() => { if (alive && page !== 'summary') message('网页仍未确认载入，可能受网络或内嵌限制影响；请使用“应用内新窗打开”', true); }, 15000);
    };
    const onFrameLoad = () => {
      if (!alive || page === 'summary') return;
      clearFrameTimer();
      // 跨域 iframe 的 load 不能证明网站可用或认证成功（拦截页也可能触发）。
      message('官方网页已触发载入；登录状态以网页为准。若空白、未授权或无法操作，请改用应用内新窗。');
    };
    const onFrameError = () => { clearFrameTimer(); if (page !== 'summary') message('官方页面未能载入，请检查网络或使用“应用内新窗打开”', true); };
    const setSyncBusy = busy => {
      for (const key of ['sync','login']) { const button=el.querySelector(`[data-card-${key}]`); if(button){button.disabled=busy;button.setAttribute('aria-busy',String(busy));} }
      const button=el.querySelector('[data-card-sync]');if(button)button.textContent=busy?'正在同步…':'同步账单';
    };
    const sync = (force = false) => {
      if (syncFlight) return syncFlight;
      if (cardState.loading) { message('已有账单同步正在进行，请稍候再试'); return Promise.resolve(false); }
      setSyncBusy(true); message('正在登录并同步账单…');
      syncFlight = Promise.resolve().then(() => cardSync(el, force)).catch(() => { message('账单同步未完成，请检查网络与登录信息后重试', true); return false; })
        .finally(() => { syncFlight=null; if(alive)setSyncBusy(false); });
      return syncFlight;
    };
    const captureCredentials = () => {
      const user=el.querySelector('[data-card-user]'), pass=el.querySelector('[data-card-pass]');
      if (user) cardState.username=user.value.trim();
      if (pass) cardState.password=pass.value;
    };
    const click = async event => {
      const target=event.target?.closest ? event.target : event.target?.parentElement;
      if (!alive || !target) return;
      const names=['summary','billing','sync','home','recharge','center','reload','open','back','login','change','mode','kind'];
      const name=names.find(key=>target.closest(`[data-card-${key}]`));
      if (!name) return;
      const button=target.closest(`[data-card-${name}]`);
      if (!el.contains(button) || button.disabled) return;
      event.preventDefault();
      try {
        // 返回和页面切换不依赖网络、缓存或可选的日均模块。
        if (name==='back') { navSequence++; tide.util.navigate('plug:cppu-notify'); return; }
        if (name==='summary') { navSequence++; selectPage('summary'); cardPaintStats(el); message('已切回本地账单与统计；需要最新数据请点“同步账单”'); return; }
        if (name==='home') { navSequence++; showWeb('home',CARD_HOME); return; }
        if (name==='open') {
          // 必须在点击栈内调用，Web 调试环境才不会因异步等待被拦截弹窗。
          const authenticated=!!cardState.accessToken && cardState.expiresAt>Date.now();
          const target=authenticated?(page==='summary'?CARD_BILLING:currentUrl):CARD_HOME;
          const opening=tide.util.openCardPage(cardAuthedUrl(target));
          button.disabled=true;
          try { const result=await opening; message(result?.mode==='browser'?'浏览器环境：已打开官方站点窗口，请在窗口内完成登录。':'已打开应用内官方网页窗口，请在窗口内继续操作。'); }
          finally { if(alive)button.disabled=false; }
          return;
        }
        if(name==='mode'){cardState.mode=button.dataset.cardMode||'month';cardPaintStats(el);return;}
        if(name==='kind'){cardState.kind=button.dataset.cardKind==='out'?'out':'in';cardPaintStats(el);return;}
        if(name==='reload' && page!=='summary'){navSequence++;showWeb(page,currentUrl);return;}
        const sequence=++navSequence;
        await ready;
        if(!alive||sequence!==navSequence)return;
        if(name==='change'){
          if(cardState.loading){message('正在同步，请完成后再更换账号');return;}
          cardState.accessToken='';cardState.password='';cardState.error='请输入新的账号和密码';
          await tide.vault?.del?.(CARD_VAULT_KEY);cardPaintLogin(el);message('请输入新账号与密码，然后点击“登录并自动同步”');return;
        }
        captureCredentials();
        if(name==='sync'||name==='login'||name==='reload'){
          selectPage('summary');
          if(!cardState.username||!cardState.password){cardPaintLogin(el);message('请先填写一卡通学/工号和密码，再点击“登录并自动同步”',true);el.querySelector('[data-card-user]')?.focus();return;}
          await sync(name==='login');return;
        }
        if(name==='billing'||name==='recharge'||name==='center'){
          if(syncFlight)await syncFlight;
          if(!alive||sequence!==navSequence)return;
          if(!cardState.accessToken||cardState.expiresAt<=Date.now()){
            if(!cardState.username||!cardState.password){message('请先登录一卡通，再进入账单、充值或账户中心；也可在应用内新窗完成官方登录。',true);el.querySelector('[data-card-user]')?.focus();return;}
            await sync(true);
          }
          if(!alive||sequence!==navSequence)return;
          if(!cardState.accessToken||cardState.expiresAt<=Date.now()){message('登录尚未成功，未打开受保护页面；请检查账号或使用应用内新窗',true);return;}
          showWeb(name,name==='billing'?CARD_BILLING:name==='recharge'?CARD_RECHARGE:CARD_CENTER);
        }
      } catch { message('操作未完成，请检查网络、客户端与登录状态后重试；网页版请允许打开弹窗。',true); }
    };
    // 先接线，再启动任何可能失败的辅助初始化；重复挂载先移除旧事件。
    el.addEventListener('click',click);
    frame?.addEventListener('load',onFrameLoad);frame?.addEventListener('error',onFrameError);
    selectPage('summary');
    const ready=(async()=>{
      try {
        const cache=await tide.storage.get(CARD_CACHE_KEY,null);
        if(!alive)return;
        cardState.rows=cardCleanRows(cache?.rows||[]);cardState.syncedAt=Number(cache?.syncedAt||0);
        cardState.billsPartial=!!cache?.billsPartial||(cache?.rows?.length||0)>=5000;
        cardState.balance=Number.isFinite(Number(cache?.balance))&&cache?.balance!=null?Number(cache.balance):null;
        cardState.balanceAt=Number(cache?.balanceAt||0);
      } catch { message('本地账单缓存读取失败，可填写账号后手动同步；工具栏仍可使用。',true); }
      try { if(alive)await cardRestoreSecret(); } catch { message('登录信息恢复失败，请手动填写一卡通账号和密码',true); }
      if(!alive)return;
      cardPaintLogin(el);cardPaintStats(el);
    })();
    ready.then(()=>{
      if(!alive)return;
      if(cardState.username&&cardState.password)return sync();
      message('首次使用请填写一卡通学/工号和密码；首页、应用内新窗和回通知无需等待登录。');
    }).catch(()=>message('一卡通初始化未完成，请手动同步或重新打开本页',true));
    Promise.resolve().then(()=>{if(alive){bindSide(el);return loadLinkMeta(el);}}).catch(()=>{});
    Promise.resolve().then(()=>{if(alive)return loadCardAveragePanel(el);}).catch(()=>message('日均模块未能载入，工具栏和账单操作仍可使用',true));
    const dispose=()=>{alive=false;navSequence++;clearFrameTimer();el.removeEventListener('click',click);frame?.removeEventListener('load',onFrameLoad);frame?.removeEventListener('error',onFrameError);if(el._cardViewDispose===dispose)delete el._cardViewDispose;};
    el._cardViewDispose=dispose;return dispose;
  }

  /* ── 登录界面 ── */
  function paintLogin(el, errMsg, opts = {}) {
    const hasSaved = !!state.username;
    const canVault = typeof tide.vault?.get === "function";
    el.innerHTML = `<div class="${sideShellClass()}">
      <aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}
      <div class="pp-main"><div class="pp-login">
      <h3>登录智慧警大门户</h3>
      <div class="d">中国人民警察大学统一门户（portal-jw.cppu.edu.cn）。系统会先自动恢复上次会话，失败后自动识别验证码完成登录；都行不通才需要在这里核对信息。</div>
      <div class="d"><b>自动登录状态：</b>记住账号 ${state.rememberUsername ? "✓" : "✗"} · 票据静默续期 ✓ · 加密保存密码 ${state.autoLogin && canVault ? "✓" : "✗"} · 验证码自动识别 ✓</div>
      ${hasSaved ? `<div class="saved">已自动填入账号 ${esc(state.username)}${state.autoLogin && state.savedPassword ? "与保存的密码" : ""}。验证码会自动识别预填，核对无误直接点「登 录」即可。</div>` : ""}
      <label>学号 / 用户名</label><input data-u aria-label="学号 / 用户名" type="text" value="${esc(state.username)}" autocomplete="off">
      <label>密码</label><input data-p aria-label="密码" type="password" autocomplete="current-password" value="${esc(state.autoLogin ? state.savedPassword : "")}">
      <label>验证码</label>
      <div class="pp-caprow">
        <input data-code aria-label="验证码" type="text" maxlength="4" placeholder="4 位字符" value="${esc(opts.prefillCode || "")}">
        <div class="capbox" data-capbox title="点击更换"><img data-cap src="${esc(state.captcha)}"><small>看不清？点图换一张</small></div>
      </div>
      <div class="row" style="margin-top:12px;gap:12px;align-items:center;flex-wrap:wrap">
        <label class="pp-toggle ${state.rememberUsername ? "on" : ""}" data-remember><i></i>记住账号</label>
        ${canVault ? `<label class="pp-toggle ${state.autoLogin ? "on" : ""}" data-autologin><i></i>记住密码并自动登录</label>` : ""}
        <span data-switchuser style="font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;cursor:pointer">清除上次账号</span>
        ${state.autoLogin && canVault ? `<span data-clearauth style="font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;cursor:pointer">清除保存的密码</span>` : ""}
      </div>
      ${loginSettingsHtml()}
      <button class="submit" data-go style="width:100%;height:40px;border-radius:10px;background:#0F4C5C;color:#fff;font-size:calc(14px * var(--ui-text-scale));font-weight:600;margin-top:14px;cursor:pointer">登 录</button>
      <div class="err" data-err>${esc(errMsg || "")}</div>
      <div class="sec">开启「记住密码并自动登录」后，密码与门户会话票据会加密保存在本机密钥库（AES-256-GCM），下次打开自动登录、直达通知列表；不会进入数据备份、同步或其他插件。关闭后只记住账号，密码仅本次内存使用。</div>
      </div></div>
    </div>`;
    bindSide(el);
    loadLinkMeta(el);

    const errEl = el.querySelector("[data-err]");
    const codeEl = el.querySelector("[data-code]");
    const capImg = el.querySelector("[data-cap]");
    const userEl = el.querySelector("[data-u]");
    const passEl = el.querySelector("[data-p]");
    const rememberEl = el.querySelector("[data-remember]");
    const autoEl = el.querySelector("[data-autologin]");
    bindLoginSettings(el);
    el.querySelector("[data-capbox]").addEventListener("click", async () => {
      if (loggingIn || loginBusy) return;
      errEl.textContent = "正在换验证码…";
      try {
        const url = await fetchCaptcha();
        if (capImg) capImg.src = url;   // 直接更新登录表单里的验证码图
        errEl.textContent = "";
        // 换图后同样自动识别预填
        const ocr = await OCR.recognize(url);
        if (ocr.code) {
          codeEl.value = ocr.code;
          state._manualSamples = ocr.samples;
          state._manualCode = ocr.code;
        }
      } catch (e) {
        errEl.textContent = e.message || e;
      }
    });
    rememberEl.addEventListener("click", () => {
      if (loggingIn || loginBusy) return;
      state.rememberUsername = !state.rememberUsername;
      rememberEl.classList.toggle("on", state.rememberUsername);
      tide.storage.set("rememberUsername", state.rememberUsername);
      if (!state.rememberUsername) tide.storage.set("username", "");
    });
    if (autoEl) autoEl.addEventListener("click", () => {
      if (loggingIn || loginBusy) return;
      state.autoLogin = !state.autoLogin;
      autoEl.classList.toggle("on", state.autoLogin);
      tide.storage.set("autoLogin", state.autoLogin);
      if (!state.autoLogin) clearSavedLogin();
      tide.notify(state.autoLogin ? "已开启记住密码并自动登录" : "已关闭自动登录，并清除保存的密码");
    });
    el.querySelector("[data-switchuser]").addEventListener("click", () => {
      if (loggingIn || loginBusy) return;
      state.username = "";
      tide.storage.set("username", "");
      userEl.value = "";
      userEl.focus();
    });
    el.querySelector("[data-clearauth]")?.addEventListener("click", async () => {
      if (loggingIn || loginBusy) return;
      await clearSavedLogin();
      passEl.value = "";
      tide.notify("已清除保存的密码与会话票据");
    });

    let loggingIn = false;
    const doLogin = async () => {
      if (loggingIn || loginBusy) return;
      const username = userEl.value.trim();
      const password = passEl.value;
      const code = codeEl.value.trim();
      if (!username || !password || !code) { errEl.textContent = "请填写学号、密码和验证码"; return; }
      if (!state.pending?.execution) { errEl.textContent = "登录页尚未准备好，请稍候再试"; return; }
      loggingIn = true; el.querySelector("[data-go]").disabled = true;
      for (const input of [userEl, passEl, codeEl]) input.disabled = true;
      errEl.textContent = "正在走 SSO 链路（登录 → bridge → 门户）…";
      try {
        const loginResult = await runLoginAttempts({ username, password, code,
          onRetry: message => { errEl.textContent = message; },
          isActive: () => el.isConnected !== false && el.querySelector("[data-err]") === errEl });
        if (el.isConnected === false || el.querySelector("[data-err]") !== errEl) return;
        if (state.username !== username) {
          state.notices = []; state.details = {}; state.fetchedAt = 0;
          for (const key of Object.keys(jwState.data)) jwState.data[key] = null;
          jwState.at = {}; jwState.error = {}; jwState.term = null;
        }
        state.username = username;
        if (state.rememberUsername) tide.storage.set("username", username);
        else tide.storage.set("username", "");
        await persistCredentials(password);
        await saveCookies();
        // 验证码若来自自动识别且登录成功 → 样本确认，后续识别更准
        // 自动重试所用验证码样本已由统一流程确认；首次人工提交保留原有学习行为。
        if (!loginResult.recognized) {
          if (opts.ocrSamples && code === opts.prefillCode) OCR.confirmSamples(opts.ocrSamples);
          else if (state._manualSamples && code === state._manualCode) OCR.confirmSamples(state._manualSamples);
        }
        state.savedPassword = state.autoLogin ? password : "";
        passEl.value = "";
        // onDone：登录卡是六个视图共用的，教务视图摆出来的那张登完要回它自己那一页
        tide.notify(opts.onDone ? "登录成功，正在回到本页" : "登录成功，正在获取门户通知");
        if (opts.onDone) { opts.onDone(); return; }
        buildMain(el);
        loadPage(1);
      } catch (e2) {
        if (el.isConnected === false || el.querySelector("[data-err]") !== errEl) return;
        if (username === state.username && (opts.onFailure ? opts.onFailure() : !opts.onDone && await showNoticeCache(el, loginErrorText(e2)))) return;
        if (capImg) capImg.src = state.captcha || "";
        if (e2 && e2.fatal) { errEl.textContent = e2.fatal; }
        else {
        errEl.innerHTML = esc((e2 && e2.retry) || e2.message || "登录失败") +
          (e2 && e2.diag ? `<br><span style="font-size:calc(10.5px * var(--ui-text-scale));color:#A9B2BA;word-break:break-all">${e2.diag}</span>` : "");
        }
        // 控制器已准备新 execution 和验证码；即使账号错误也不能重用旧表单。
        const ocr = await OCR.recognize(state.captcha).catch(() => null);
        codeEl.value = "";
        if (ocr?.code) {
          codeEl.value = ocr.code;
          state._manualSamples = ocr.samples;
          state._manualCode = ocr.code;
        }
      } finally {
        loggingIn = false;
        for (const input of [userEl, passEl, codeEl]) input.disabled = false;
        const button = el.querySelector("[data-go]"); if (button) button.disabled = false;
        // pending 密码由 runLoginAttempts 在其互斥区域内清理，不能影响之后发起的登录。
      }
    };
    el.querySelector("[data-go]").addEventListener("click", doLogin);
    for (const input of [userEl, passEl, codeEl]) {
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") doLogin();
      });
    }
    setTimeout(() => (hasSaved && state.savedPassword ? codeEl : userEl).focus(), 0);

    // 首次进入：拉登录页 + 验证码，并自动识别预填
    (async () => {
      try {
        if (loginBusy || loggingIn) return;
        await newSession();
        if (loginBusy || loggingIn) return;
        if (!state.pending?.execution || !state.captcha) {
          state.pending = { execution: await fetchLoginHtml() };
          await fetchCaptcha();
        }
        if (el.isConnected === false || el.querySelector("[data-code]") !== codeEl) return;
        if (capImg) capImg.src = state.captcha || "";
        if (!codeEl.value) {
          const ocr = await OCR.recognize(state.captcha).catch(() => null);
          if (ocr?.code) { codeEl.value = ocr.code; state._manualSamples = ocr.samples; state._manualCode = ocr.code; }
        }
      } catch (e) {
        errEl.textContent = e.message || e;
      }
    })();
  }

  function buildMain(el) {
    el.innerHTML = `<div class="${sideShellClass()}">
      <aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}
      <div class="pp-main"><div class="pp-wrap">
      <div style="font-size:calc(11px * var(--ui-text-scale));letter-spacing:.3em;color:#7E8B94;margin:16px 0 4px">警 大 门 户 通 知 · 内 置 插 件</div>
      <div class="pp-toolbar">
        <button class="pp-btn pri" data-refresh>刷新</button>
        <input class="pp-kw" data-kw type="text" placeholder="关键词过滤：标题 / 发布人 / 单位 / 分类…">
        <label class="pp-toggle" data-ar title="打开插件期间每 10 分钟自动同步一次"><i></i>自动刷新</label>
        <span style="flex:1"></span>
        <button class="pp-btn" data-relogin>重新登录</button>
      </div>
      <details class="plugin-filter-menu"><summary data-filter-summary>筛选</summary><div class="plugin-filter-menu-panel">
        <div class="pp-toolbar"><span class="pp-lab">分类</span><div class="pp-chips" data-kinds></div></div>
        <div class="pp-toolbar"><span class="pp-lab">月份</span><div class="pp-chips" data-months></div></div>
        <label class="pp-toggle" data-hs><i></i>只看未读</label>
      </div></details>
      <div class="pp-status" data-status></div>
      <div data-list></div>
      <div style="height:30px"></div>
      </div></div>
    </div>`;

    ui = {
      status: el.querySelector("[data-status]"),
      kinds: el.querySelector("[data-kinds]"),
      months: el.querySelector("[data-months]"),
      filterSummary: el.querySelector("[data-filter-summary]"),
      list: el.querySelector("[data-list]"),
      kw: el.querySelector("[data-kw]"),
      hs: el.querySelector("[data-hs]"),
      ar: el.querySelector("[data-ar]"),
      count: document.createElement("b"),
    };
    ui.kw.value = state.filter.kw;
    ui.hs.classList.toggle("on", !!state.filter.hideSeen);
    ui.ar.classList.toggle("on", !!state.autoRefresh);
    let kwTimer = null;
    ui.kw.addEventListener("input", () => {
      clearTimeout(kwTimer);
      kwTimer = setTimeout(() => { state.filter.kw = ui.kw.value; saveFilter(); paintAll(); }, 200);
    });
    ui.kw.addEventListener("keydown", (e) => e.stopPropagation());
    ui.hs.addEventListener("click", () => { state.filter.hideSeen = !state.filter.hideSeen; saveFilter(); paintChips(); paintList(true); });
    ui.ar.addEventListener("click", () => {
      state.autoRefresh = !state.autoRefresh;
      ui.ar.classList.toggle("on", state.autoRefresh);
      tide.storage.set("autoRefresh", state.autoRefresh);
      startAutoRefresh(el);
      tide.notify(state.autoRefresh ? "已开启自动刷新：每 10 分钟同步警大通知" : "已关闭警大通知自动刷新");
    });
    el.querySelector("[data-refresh]").addEventListener("click", () => loadPage(1));
    el.querySelector("[data-relogin]").addEventListener("click", () => {
      stopAutoRefresh();
      state.token = ""; state.notices = []; state.details = {}; state.expanded.clear(); state.pending = null; state.captcha = ""; state.sid = null; ui = null;
      paintLogin(el);
    });

    io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting) && sentinelCb) sentinelCb();
    }, { root: el, rootMargin: "320px" });

    ui.list.addEventListener("click", async (e) => {
      const card = e.target.closest(".pp-card");
      if (!card) return;
      const rid = card.dataset.rid;
      const it = state.notices.find((x) => itemKey(x) === rid);
      if (!it) return;
      if (e.target.closest("[data-remind]")) { await toReminder(it); return; }
      if (e.target.closest("[data-retry]")) { loadDetail(rid, true); return; }
      const attBtn = e.target.closest("[data-attach-download]");
      if (attBtn) {
        const det = state.details[rid];
        const att = det?.attachments?.[Number(attBtn.dataset.attachDownload)];
        if (att && !attBtn.disabled) {
          attBtn.disabled = true;
          const label = attBtn.querySelector(".pp-att-action");
          if (label) label.textContent = "下载中…";
          try { await downloadAttachment(att); }
          finally { attBtn.disabled = false; if (label) label.textContent = "下载 ↓"; }
        }
        return;
      }
      if (!e.target.closest("[data-toggle]")) return;
      if (state.expanded.has(rid)) {
        state.expanded.delete(rid);
        setCardExpanded(card, false);
      } else {
        state.expanded.add(rid);
        setSeen(rid);
        setCardExpanded(card, true);
        loadDetail(rid);
      }
    });

    paintAll();
    startAutoRefresh(el);
    if (!state.notices.length && !state.fetching && state.token && !state.error) loadPage(1);
    bindSide(el);
    loadLinkMeta(el);
  }

  function render(el) {
    let disposed = false;
    stopAutoRefresh();
    ensureStyle();
    el.innerHTML = `<div class="${sideShellClass()}"><aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}<div class="pp-main">`
      + `<div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在恢复登录状态…</div>`
      + `</div></div>`;
    bindSide(el);
    loadLinkMeta(el);
    loadPrefs().then(async () => {
      if (disposed) return;
      // 每次进入都重新验证票据，避免插件在应用内放置较久后拿着过期 token 直接进空列表。
      // 自动登录三级链路：恢复票据静默续期 → 保存的密码 + 验证码识别 → 人工表单（预填）
      let ok = false;
      try { ok = await autoLogin(el); }
      catch (error) { ok = await showNoticeCache(el, loginErrorText(error)); }
      if (disposed) return;
      // autoLogin 失败路径里已经 paintLogin（含预填）；这里只兜「无凭据直接表单」
      if (!ok && !el.querySelector(".pp-login")) {
        await prepareLoginForm();
        paintLogin(el, "");
      }
    });
    return () => { disposed = true; stopAutoRefresh(); io?.disconnect(); };
  }

  tide.ui.registerView({ id: "cppu-notify", title: "警大通知", icon: 'building-columns', render });
  tide.ui.registerView({ id: "cppu-card", title: "警大一卡通", icon: "credit-card", render: mountCardView });
  // 教务只读视图：侧栏「校园服务」里的选课 / 请假 / 成绩 / 创新学分入口直接 navigate 过来
  for (const cfg of JW_VIEWS) {
    tide.ui.registerView({
      id: cfg.id, title: cfg.title, icon: cfg.icon,
      render: (el) => mountJwView(el, cfg),
    });
  }
})();
