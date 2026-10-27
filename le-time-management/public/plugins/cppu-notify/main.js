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
  // 学生个人成长中心（教师端同一套 pdata）：独立 SPA + 独立 CAS 客户端，
  // 登录后不发会话 Cookie，而是发 `Authentication` 头里的 token —— 见 ensurePdataAuth。
  const PDATA = "https://pdata.cppu.edu.cn";
  const PDATA_HOME = "/stu/home/";
  const JW_INDEX = JWAPP + "/index.html";
  const SERVICE_JW = JW + "/tpass/bridge";
  const LOGIN_URL = SSO + "/tpass/login?service=" + encodeURIComponent(SERVICE_JW);
  const SERVICE_PORTAL = PORTAL + "/tp_up/view?m=up";
  const SILENT_LOGIN = JW + "/tpass/login?service=" + encodeURIComponent(SERVICE_PORTAL);
  const MAIL = "https://mail.cppu.edu.cn/";
  // 警大邮箱新版前端（Coremail Sirius Web）是单页应用：`#mailbox` 只是它的前端路由，
  // `version` 是官方静态资源指纹（取用户给的那串写死，避免 CDN 把新旧资源串起来）。
  // 它认的是 mail 域的 sid Cookie —— 插件 native 会话登一次后把 Cookie 注入内置窗口即可免登。
  const MAIL_WEB = "https://mail.cppu.edu.cn/static/sirius-web/?version=1791461395966#mailbox";
  // 邮箱账号不写死在源码里：本仓库公开，学号属于个人身份信息。用本机记住的登录学号
  // 拼校邮箱域名即可 —— 换账号时自动跟着换，也不会拿着上一个用户的学号去登邮箱。
  const mailAccount = () => {
    const name = String(state.username || "").split("@")[0].trim();
    return name ? `${name}@${MAIL_DOMAIN}` : "";
  };
  // 邮箱登录不在邮件站上：mail.cppu.edu.cn 是网易企业邮的定制登录页，真正的校验走学校
  // 中间件（网页里也是这条路：RSA 加密密码 → POST /cppu/api/login → 拿 entryhz 的
  // location → 再跳回 mail.cppu.edu.cn/js6/main.jsp?sid=…）。mbox 接口只认 URL 里的 sid，
  // 光有 Cookie 会回 FA_INVALID_SESSION。
  const MAIL_MIDDLE = "https://mailuser.cppu.edu.cn";
  const MAIL_LOGIN_API = MAIL_MIDDLE + "/cppu/api/login";
  const MAIL_PUBKEY_API = MAIL_MIDDLE + "/sync/mail/pubkey";
  const MAIL_DOMAIN = "cppu.edu.cn";
  const MAIL_API = "https://mail.cppu.edu.cn/js6/s";
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
  // 获奖名单视图（cppu-award）：获奖信息只在通知正文里，所以它得先把通知列表往回翻够页，
  // 再逐条读正文筛选。上限写死是为了别把一次刷新变成几百个详情请求。
  const AWARD_CACHE_KEY = "awardBoardCache";
  // 大块可重抓的缓存走 tide.cache（宿主 v0.248.0 起，落独立文件、不进 data.json）；
  // 旧宿主 / 测试桩没有它时退回 tide.storage，行为与以前一致。
  const cacheStore = tide.cache || tide.storage;
  // 解析口径版本：缓存里存的是**解析结果**（不是正文），口径一变旧结果就不能再拿来看 ——
  // v2 之前「单行单名」只看「正文出现过级别行」，把落款与附件字体名 / 样式名（等线 / 仿宋 /
  // 无列表 / 教务处）一起收进了名单。这里不做迁移，版本不符就整份丢掉重新同步（正文在门户上）。
  const AWARD_CACHE_VER = 2;
  // 缓存新鲜期：这一页每次打开都会「拉通知 → 逐条读正文 → 读附件」走完一整轮，
  // 一分钟起步，而获奖名单一个月才变几次 —— 「每次点开都等一轮」才是体感慢的真正来源。
  // 所以新鲜期内只画缓存、不自动重爬；要更新就点「刷新名单」。过期 / 没缓存才自动跑一轮。
  // 6 小时：一天里多次点开都秒开，隔夜第一次进来会自动更新。
  const AWARD_CACHE_FRESH_MS = 6 * 60 * 60 * 1000;
  // 翻页策略：**按时间回溯，而不是固定页数**。门户通知一年几百条，写死 4 页只够看到今年，
  // 而获奖名单往往要看前两三年。所以首屏先翻 AWARD_PAGES 页，再一路往后翻到覆盖
  // AWARD_YEARS 个自然年为止（或翻到底、或撞上 AWARD_PAGES_MAX 的防呆上限）。
  const AWARD_PAGES = 4;          // 首屏先翻 4 页（50 条/页 = 200 条）
  const AWARD_PAGES_STEP = 10;    // 「再往前翻」每次加 10 页（500 条）
  const AWARD_PAGES_MAX = 60;     // 上限 60 页（3000 条）：再往前对门户不礼貌，收益也低
  const AWARD_YEARS = 3;          // 默认回溯到「今年往前数 3 个自然年」（2025 年 ⇒ 翻到 2023 年为止）
  const AWARD_NOTICE_MAX = 60;    // 每批最多读多少条候选正文（每条一次详情请求）
  // 一次「刷新」最多读多少条候选正文（跨批累计）。低于它的候选会分几批在同一轮里读完，
  // 所以正常年份范围（几页通知、几十~两百条候选）一次点击就能「读到底」，不留「还有 N 条没读」的尾巴；
  // 超过它的（那种翻到 60 页的极端情况）再点一次刷新接着读，剩下的会照实计数写进状态行。
  const AWARD_CAND_BUDGET = 300;
  const AWARD_CACHE_MAX = 200;    // 奖项记录落盘上限（正文留缓存里，这里只存解析结果）
  // 获奖名单附件：名单常挂在 .docx / .xlsx / .pdf 上而不是写在正文里。三条口径：
  //  ① 只有「附件名像名单」或「正文说了名单在附件」的附件才下载（award-attach.js 判定）；
  //  ② 单轮最多读 AWARD_AFFIX_MAX 个附件，别把一次刷新变成几十个附件请求；
  //  ③ 扫过的附件只留一个标记（awardAffixScanned），不留文本 —— 名单抽出来后附件内容即弃，
  //     屏幕上的名单永远只是「谁得了什么奖」，附件本身不再回看（回看走「来源通知」）。
  const AWARD_AFFIX_KEY = "awardAffixScanned";
  const AWARD_AFFIX_MAX = 12;     // 每批最多下载解析多少个附件
  // 一次「刷新」最多读多少个附件（跨批累计）。附件比正文重得多（每个几百 KB），所以上限压得低；
  // 但同样是「一轮读到底」，不再把「还有 N 份下一轮读」这种尾巴留在状态行上。
  const AWARD_AFFIX_BUDGET = 36;
  const AWARD_AFFIX_MARK_MAX = 400; // 「扫过」标记的落盘上限（按时间淘汰最旧的）
  const AWARD_AFFIX_CHARS = 60000;  // 单个附件抽取文本的上限，防止一个巨型表格把解析拖住
  // 取数并发：上面这两批请求（候选正文、附件）过去是一条一条串着等的，60 条正文就能把
  // 状态行顶住半分钟。并发档位在「设置 → 警大获奖名单 → 读取并发数」，键名 / 默认值 / 上限 /
  // 档位全在 award-pool.js（运行时动态 import，见 ensurePoolMod），与设置页共用一份 storage。

  // ── 左侧校园服务栏 ──
  // 标题与图标不写死：进入插件时抓一次网页元信息（<title> / favicon / 图标名），
  // 抓不到（内网、未登录、断网）就退回下面的 label 与 icon，因此离线也不会空着。
  const QUICK_LINKS = [
    // 警大邮箱走应用内网页窗口（Sirius Web 单页前端）：点一下先用插件自己那份会话登一次，
    // 再把该会话的 mail 域 Cookie 注入内置 WebView —— 登录态与插件同源，窗口里不用再登一遍。
    // 没存密码 / 登录失败就退回不带会话的内置窗口，由页面自己登录。
    { url: MAIL_WEB, label: "警大邮箱", icon: "envelope" },
    // 「教务」是唯一的父项：右侧箭头展开 / 收起，行本身仍是换票开教务（与升级前行为一致）。
    // 教务子项走 `view:`（在 U-Time 里开视图）而不是换票开浏览器：
    // 教务 SPA 完全没有 URL 深链（je-app/je-main/je-core 三个 bundle 都不解析
    // location.hash / location.search，开任何功能地址栏都停在 index.html），
    // 做成链接的话四个入口只会统统落回教务首页，等于同一个入口抄四遍。
    { url: "https://jw.cppu.edu.cn/index.html", label: "教务", icon: "school", children: [
      { view: "cppu-xk", label: "学生选课", icon: "list-check" },
      { view: "cppu-qj", label: "学生请假", icon: "calendar-xmark" },
      { view: "cppu-exam", label: "我的考试", icon: "clock" },
      { view: "cppu-credit-ledger", label: "我的学分", icon: "graduation-cap" },
      { view: "cppu-credit", label: "警大成绩", icon: "chart-line" },
      { view: "cppu-cx", label: "创新学分", icon: "medal" },
      { view: "cppu-calendar", label: "警大校历", icon: "calendar-days" },
      { view: "cppu-room", label: "自习室", icon: "door-open" },
    ] },
    { url: "https://xg.cppu.edu.cn/XGPhone/Phone/index.html", label: "学工", icon: "id-card" },
    // 「我的请假」与「学工」同源，只是该 SPA 的 hash 路由（实测路由表里有 /StuDailyLeaveList）。
    // 裸开 index.html 返回 200 静态壳、没有服务端 302，登录由该 SPA 自己的 /Login 路由处理
    // ⇒ 不属于「302 到统一身份认证」那一类，刻意不进 TICKET_LINKS（换票链路不适用）。
    // ⚠️ 用户给的原始地址带一次性授权码与 state 参数（用完即废），绝不能原样写死进来，
    // 否则入口点开必失败；这里只保留裸地址 + hash 路由。
    { url: "https://xg.cppu.edu.cn/XGPhone/Phone/index.html#/StuDailyLeaveList", label: "我的请假", icon: "calendar-check" },
    { url: "https://service.cppu.edu.cn/fe/site/service", label: "一网通办", icon: "clipboard-list" },
    // 个人信息（pdata.cppu.edu.cn）：与门户 / 教务不同源 —— 独立 SPA、独立 CAS、
    // 登录态是请求头里的 token 而不是 Cookie，所以做成 U-Time 内部视图，
    // 由插件自己换票 + 续期（见 ensurePdataAuth / growthBridge）。
    // v0.281.0 起「学生成长」并进这一页（同一站点、同一份 token，一个人在两页里各画一遍
    // 身份卡是纯冗余）；这一页的卖点仍是网页做不到的：点任意字段直接复制到剪贴板。
    { view: "cppu-profile", label: "个人信息", icon: "address-card" },
    // 一卡通平台（慧新易校 / 新中新）不是 sso-jw/门户体系里的子系统。
    // 直接打开 cardRecharge 这类受保护深链，平台还没建立自己的 H5 session 时会先报「未授权」；
    // 所以这里改成 U-Time 内部视图：先加载一卡通 H5 首页/登录壳，再由视图内按钮跳充值等子页。
    { view: "cppu-card", label: "一卡通", icon: "credit-card" },
    // 上网记录（drcom.cppu.edu.cn 自助服务系统）：**另一套会话** —— JSESSIONID + 4 位图形验证码，
    // 不走统一身份认证的票据，只是账号密码同一套。做成内部视图的理由是网页那页本身不好用：
    // 一次最多 60 天、一屏只有 10 行、summary 趴在页脚，而这里能整区间按天聚合（见 netlog.js）。
    { view: "cppu-net", label: "上网记录", icon: "network-wired" },
    // 获奖名单与「警大通知」同源（名单就长在通知正文里，共用同一份正文缓存），
    // 所以入口放在校园服务这一侧，跟着通知走，而不是挂到「教务」子菜单下。
    { view: "cppu-award", label: "获奖名单", icon: "trophy" },
    // 我的体测（sport-wechat.cppu.edu.cn）：**不是统一身份认证体系**，也不是教务那套
    // Cookie/ticket —— 它只认企业微信 OAuth 发下来的 Authorization token（appid 绑死 wxwork，
    // 普通浏览器 UA 连授权页都过不去）。所以这一页自己不做登录，取数全靠
    // tools/sync-fitness.mjs 从企业微信内置浏览器的 sessionStorage 里捞到的那枚 token；
    // 数据是快照语义，**只有点「刷新」才重新拉**（见 fitness.js 头注释）。
    { view: "cppu-fitness", label: "我的体测", icon: "heart-pulse" },
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

  /* 刷新等待蒙版（v0.233.0）：门户这几个分类每次进入都要「验票据 → 必要时自动登录 →
     拉第一页数据」，几秒钟里整页只有一句灰色占位。宿主提供了整屏蒙版（与启动蒙版同一颗
     字标），这里统一用它，占位文字仍保留作为兜底（蒙版只盖在上面，不替掉内容）。

     老宿主没有 tide.ui.waitMask（插件 zip 可能装到旧版本应用上），退化成空操作而不是抛错。 */
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});

  const state = {
    sid: null, token: "", username: "", rememberUsername: true, autoLogin: true, autoRefresh: true, loginRetries: 2,
    notices: [], page: 1, hasMore: true,
    fetching: false, error: null, fetchedAt: 0,
    expanded: new Set(),
    details: {},           // rid -> {content, attachments, loading, error}
    seen: new Set(),
    filter: { kw: "", year: "all", month: "all", kind: "all", hideSeen: false },
    captcha: "", pending: null, renderedCount: CHUNK,
    savedPassword: "",     // 密钥库取出的密码（仅内存，用于自动登录与表单预填）
    sideOpen: false,       // 校园服务栏：默认收起。只活在本次插件会话里，重进插件回到收起
    jwOpen: true,          // 「教务」子菜单：默认展开 —— 这四个入口升级前本来就露在侧栏上，
                           // 默认收起等于把已有功能藏到一次点击之后。同样只活在本次会话里。
    loginAt: 0,            // 上次自动登录成功的时间戳（storage autoLoginAt）：登录页拿它解释「为什么还是要我登录」
    viewOpen: 0,           // 当前挂着的视图数：>0 说明前台正占着会话，启动预热不许插手
  };
  let ui = null, io = null, sentinelCb = null, paintToken = 0, autoRefreshTimer = null;
  let filterOutsideHandler = null; // 筛选下拉的「点外部收回」监听，重进插件时替换旧监听
  // 获奖名单视图的状态：与通知视图共用 state.notices / state.details（同一次登录、同一份正文缓存），
  // 但 DOM 引用、进度与解析结果独立 —— 两个视图会同时活着，不能让它们互相盖掉对方的 ui。
  // cacheOnly：这次画出来的榜单来自本机缓存、本进程还没同步过 —— 状态行要据此说明「点刷新可更新」。
  // wantSync：用户在本进程里表达过「就是要同步」（点了刷新 / 刚登录成功）。缓存新鲜期会让路，
  // 免得登录成功后又被自己的新鲜期判定挡回去、白等一轮。
  const awState = { el: null, loading: false, error: "", progress: "", records: [], board: null, syncedAt: 0, pages: AWARD_PAGES, pendingCands: 0, affixCount: 0, affixWait: 0, sessionOk: false, cacheOnly: false, wantSync: false };
  let awardPanel = null, awardPanelLoading = null;
  let attachMod = null, attachLoading = null;
  let affixScanned = null;         // { "rid::附件名": 时间戳 } —— 扫过的附件不再扫
  let affixScannedLoading = null;  // 上面那份台账的读取合流：并发读附件时不各建一个空对象
  let poolMod = null, poolLoading = null;   // award-pool.js：取数并发池（读不到就退回串行）

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
    // 参数层被 Rust 挡回来（sid 是 null）不是网络问题：这类原文只对开发者有意义，
    // 界面上一句「invalid type: null」帮不了用户，换成能照做的动作。
    if (/invalid args `?sid`?|invalid type: null, expected a string/i.test(msg)) {
      return "本机取数会话没建起来（sid 为空），点「刷新」重试一次；仍然这样就重启应用。";
    }
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
      /* 搜索框只留一颗放大镜（用户要求「删除所有搜索框内的中文，仅保留搜索图标」） */
      .pp-kwbox{position:relative;display:flex;align-items:center;flex:1;min-width:170px}
      .pp-kwbox>.pp-kw{flex:1 1 auto;min-width:0;padding-left:32px}
      .pp-kw-ico{position:absolute;left:11px;width:14px;height:14px;display:inline-flex;color:#7E8B94;pointer-events:none}
      .pp-kw-ico svg{width:100%;height:100%;display:block}
      .pp-kw{flex:1;min-width:170px;height:34px;border:1px solid #E4DFD6;border-radius:9px;padding:0 11px;background:#fff}
      .pp-chip{font-size:calc(12px * var(--ui-text-scale));border:1px solid #E4DFD6;background:#fff;border-radius:16px;padding:6px 13px;cursor:pointer;color:#7E8B94}
      .pp-chip.on{background:#0F4C5C;color:#fff;border-color:#0F4C5C}
      .gx-btn:hover,.pp-btn:hover{border-color:#0F4C5C;color:#0F4C5C}
      .pp-btn{font-size:calc(12px * var(--ui-text-scale));border:1px solid #E4DFD6;border-radius:8px;padding:7px 13px;background:#fff;cursor:pointer;color:#22303A;white-space:nowrap}
      .pp-btn.pri{background:#0F4C5C;color:#fff;border-color:#0F4C5C;font-weight:600}
      .pp-btn.pri:hover{background:#0B3D4A;color:#fff}
      /* 刷新请求在路上：按钮自己顶住，防止连点；光标换成「忙」让触屏也有第二种反馈 */
      .pp-btn.is-busy{opacity:.72;cursor:progress}
      .pp-btn.is-busy:hover{background:#0F4C5C}
      /* 当前学期胶囊点了不改任何东西（本来就是它）：去掉手型，别暗示还能点 */
      .pp-chip[aria-current="true"]{cursor:default}
      .pp-toggle{display:flex;align-items:center;gap:6px;font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;cursor:pointer;user-select:none}
      .pp-toggle i{width:34px;height:19px;border-radius:10px;background:#D8D2C6;display:inline-block;position:relative;transition:.15s}
      .pp-toggle i::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:.15s}
      .pp-toggle.on i{background:var(--deep,#0F4C5C)}
      .pp-toggle.on i::after{left:17px;background:var(--on-deep,#fff)}
      .pp-status{font-size:calc(12px * var(--ui-text-scale));color:#7E8B94;margin:2px 0 8px}
      .pp-status .err{color:#B03535}
      .pp-month{font-size:calc(12.5px * var(--ui-text-scale));font-weight:700;color:var(--deep,#0F4C5C);padding:9px 2px 7px;letter-spacing:.05em}
      .pp-card{background:#fff;border:1px solid #E4DFD6;border-radius:14px;padding:12px 14px;margin-bottom:9px;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 74px;transition:border-color .28s ease,box-shadow .28s ease,background .28s ease}
      .pp-card.open{border-color:#D5DED9;box-shadow:0 7px 24px rgba(34,48,58,.055)}
      .pp-heading{display:block;width:100%;text-align:left;background:transparent;border:0;color:inherit;padding:4px 0;cursor:pointer;font-family:inherit;min-height:44px}
      .pp-expand{margin-top:10px;min-height:44px;display:inline-flex;align-items:center;gap:7px;transition:background .2s ease,border-color .2s ease,color .2s ease}
      .pp-expand::after{content:"⌄";display:inline-block;font-size:calc(14px * var(--ui-text-scale));line-height:1;transform:translateY(-1px) rotate(0deg);transition:transform .36s cubic-bezier(.22,.8,.22,1)}
      .pp-card.open .pp-expand::after{transform:translateY(1px) rotate(180deg)}
      /* v1.64.0：「展开正文」收成卡片右上角一颗圆形箭头，文字只留给读屏（span 文案与 aria-expanded 照旧切换）；
         标题右侧让出位置，不被箭头压住。以前每张卡片底部一个文字按钮，长列表里像一排重复的噪音。 */
      .pp-card{position:relative}
      .pp-card .pp-heading{padding-right:42px}
      .pp-expand{position:absolute;top:10px;right:10px;margin:0;width:36px;height:36px;min-height:36px;padding:0;justify-content:center;gap:0;border-radius:50%}
      .pp-expand>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      @media(max-width:600px){.pp-expand{top:6px;right:6px;width:44px;height:44px;min-height:44px}.pp-card .pp-heading{padding-right:50px}}
      .pp-heading:focus-visible,.pp-btn:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      @media(max-width:600px){.pp-wrap{width:100%;min-width:0}.pp-login{margin:12px auto;padding:20px 16px;max-width:100%;box-sizing:border-box}.pp-title{font-size:calc(17px * var(--ui-text-scale))!important}.pp-meta{font-size:calc(13px * var(--ui-text-scale))!important}.pp-detail .c{font-size:calc(16px * var(--ui-text-scale))!important;max-height:none!important;overflow-wrap:anywhere}.pp-btn,.pp-chip{min-height:44px;font-size:calc(14px * var(--ui-text-scale))!important}.pp-kwbox{width:100%;flex-basis:100%;box-sizing:border-box}.pp-kwbox>.pp-kw{min-height:44px}.pp-card{padding:14px;cursor:default}.pp-caprow input{min-width:0}.pp-detail .pp-act{flex-wrap:wrap}}
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
      .pp-att-list{margin-top:10px;border:1px solid var(--line-soft);border-radius:10px;background:var(--bg);color:var(--ink);padding:9px 10px}
      .pp-att-list>b{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--deep);margin-bottom:6px}
      .pp-att{display:flex;align-items:center;gap:8px;width:100%;padding:8px 2px;border:0;border-top:1px solid var(--line-soft);background:transparent;text-align:left;cursor:pointer;min-width:0;color:var(--ink)}
      .pp-att:hover,.pp-att:focus-visible{color:var(--deep);background:var(--panel)}
      .pp-att:focus-visible{outline:2px solid var(--deep);outline-offset:-2px}
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
      .pp-banner{background:color-mix(in srgb,var(--deep,#0F4C5C) 14%,var(--bg,#F2EFEA));border:1px solid color-mix(in srgb,var(--deep,#0F4C5C) 38%,var(--bg,#F2EFEA));color:var(--ink,#22303A);border-radius:12px;padding:12px 15px;font-size:calc(12px * var(--ui-text-scale));line-height:1.8;margin-bottom:10px}
      /* 横幅升级成刷新入口（v0.189.0）：.pp-banner 原样保留，这里只叠加「可点」的表现。
         button 默认 text-align:center、且不继承 font-family / line-height，三者都得显式给回正文的左对齐长相。
         宽度用 width:100% + border-box：button 改成 display:flex 后，width:auto 在部分 WebView 里仍按
         shrink-to-fit 收成一小块，显式 100% 才稳。min-height:44px 是触摸目标下限；
         touch-action:manipulation 去掉移动端双击缩放那 300ms 等待。 */
      .pp-banner-act{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;min-height:44px;text-align:left;font-family:inherit;appearance:none;-webkit-appearance:none;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,border-color .18s ease}
      .pp-banner-txt{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
      /* 右侧「点击刷新」提示：让「这条能点」自己说出来，不靠用户去猜或悬停试探。
         用词跟通知里那条可点横幅的 onClickHint（「点击定位文件」）保持一致。 */
      .pp-banner-act-hint{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:calc(11px * var(--ui-text-scale));font-weight:600;color:color-mix(in srgb,var(--deep,#0F4C5C) 30%,var(--ink,#22303A));white-space:nowrap}
      .pp-banner-act-hint::before{content:"↻";font-size:calc(13px * var(--ui-text-scale));line-height:1;transition:transform .18s ease}
      /* 底色 / 强调色由 --deep 混进视图底色 --bg 派生（v0.190.0），不再用米黄硬编码：换主题、切深浅、开 Nephele 都自动跟随
         （Nephele 把 --deep 换成 #81559b / 深色 #d3afe9，这条横幅就变成同色系薰衣草紫，跟外壳一致）。
         三档底都是 --deep 与 --bg 的 color-mix：静止 14% / 悬停 22% / 按下 32%；
         文字用 --ink，右侧提示用 --deep 30% + --ink 70%。34 张色板实测最低 5.03:1（正文最低 6.23:1），都在 AA 之上。
         混的是 --bg（视图自己的底）而不是 --panel：横幅挂在视图顶部、不在卡片里，而 Nephele 的 --bg(#ece5f4)
         恰好落在 --deep 与 --panel 的 12% 处，混 --panel 会让底色和背景只差 1 个通道（等于看不见）；
         混 --bg 则无论哪套色板都保证「底色离所在底面至少 19 个通道」，这条有测试卡着。
         提示那两个数字也是量出来的：55% 时按下态在 classic / citrus 深色上只剩 4.30:1，所以往 --ink 多混一点。
         color-mix(in srgb) 对不透明色就是逐通道线性插值，跟 tools/lib/theme-tokens.js 里算出来的数字一致。 */
      .pp-banner-act:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 22%,var(--bg,#F2EFEA));border-color:color-mix(in srgb,var(--deep,#0F4C5C) 52%,var(--bg,#F2EFEA))}
      .pp-banner-act:hover .pp-banner-act-hint::before{transform:rotate(-90deg)}
      .pp-banner-act:active{background:color-mix(in srgb,var(--deep,#0F4C5C) 32%,var(--bg,#F2EFEA))}
      .pp-banner-act:focus-visible{outline:3px solid var(--deep,#0F4C5C);outline-offset:2px}
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
      /* 收起后留在原地的把手，展开后就是侧栏头部那个「◂ 校园服务」——【同一个元素】。
         v1.69.0：由竖变横、由横变竖必须是真动画。writing-mode 不参与过渡（属性一换整段跳变，
         旧实现就是这么「竖条直接消失、横按钮直接出现」的），所以四个字各自一个 span 绝对定位：
         收起时用 translate 依次落成竖列，展开时滑成横行；容器同时从 2.3em×8.5em 长成 190×34。
         它仍是 .pp-shell 的正经 flex 子项（不是浮层）：收起时天然落在左上角把正文让开；
         展开时 margin-right:-190px 抵消自身占位（正文不会多让一格），translate(-218px,12px)
         落到头部那一格 —— -218 = 侧栏左 20 + 边框 1 + 内边距 11 − 它在流里的位置 250；
         12 = 卡片边框 1 + 内边距 11。sticky 用 top:0 而不是 16：滚动容器的上沿就压在卡片顶上，
         写 16 会让 sticky 把把手整体再下推 16px，展开态落不到头部那一格（实测 95 vs 79）。 */
      /* ⚠️ 选择器必须写到 (0,3,0)：主程序 interactions.css 有一条
         button:not([data-motion="off"], …)（0,2,1）统管所有按钮的 position / transition，
         光写 .pp-side-toggle（0,1,0）会被它压住 —— 实测 width/height 过渡直接消失（变形变成跳变），
         position:sticky 也被改成 relative、top 降级成相对位移。 */
      .pp-shell .pp-side-toggle{flex:none;box-sizing:border-box;position:sticky;top:0;align-self:flex-start;z-index:4;display:block;padding:0;font-family:inherit;font-size:calc(12px * var(--ui-text-scale));font-weight:600;color:var(--deep);background:var(--panel);border:1px solid var(--line);border-radius:11px;cursor:pointer;box-shadow:0 1px 6px rgba(34,48,58,.06);overflow:hidden;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:width .34s cubic-bezier(.22,.8,.22,1),height .34s cubic-bezier(.22,.8,.22,1),transform .34s cubic-bezier(.22,.8,.22,1),margin-right .34s cubic-bezier(.22,.8,.22,1),border-radius .34s cubic-bezier(.22,.8,.22,1),opacity .24s ease,background .16s ease}
      .pp-side-toggle:hover,.pp-side-toggle:active{background:var(--paper)}
      .pp-side-toggle:focus-visible{outline:3px solid #2EC4B6;outline-offset:2px}
      .pp-side-toggle>span{position:absolute;left:0;top:0;width:1em;height:1.25em;line-height:1.25em;text-align:center;transition:transform .34s cubic-bezier(.22,.8,.22,1)}
      /* 横排（展开态）：▸ 在左、四个字依次排开，间距与 .pp-side-head-toggle 的内边距 / gap 一致 */
      .pp-side-toggle-arrow{transform:translate(1em,.71em) rotate(0deg)}
      .pp-side-toggle-ch:nth-child(2){transform:translate(2.58em,.71em)}
      .pp-side-toggle-ch:nth-child(3){transform:translate(3.58em,.71em)}
      .pp-side-toggle-ch:nth-child(4){transform:translate(4.58em,.71em)}
      .pp-side-toggle-ch:nth-child(5){transform:translate(5.58em,.71em)}
      @media(min-width:821px){
        .pp-shell:not(.side-collapsed) .pp-side-toggle{width:190px;height:34px;margin-right:-190px;transform:translate(-218px,12px)}
        /* 箭头就是 ▸ 转 180° 变成 ◂，方向翻转也走同一条过渡，不是换字 */
        .pp-shell:not(.side-collapsed) .pp-side-toggle-arrow{transform:translate(1em,.71em) rotate(180deg)}
        /* 竖排（收起态）：宽度收成一根竖条，四个字沿【高度】方向依次落下 —— 逐字位移可插值，
           所以「竖 ⇄ 横」是连续变形，不是换一套排版再跳一下 */
        .pp-shell.side-collapsed .pp-side-toggle{width:2.3em;height:8.5em;margin-right:12px;transform:none;border-radius:10px}
        .pp-shell.side-collapsed .pp-side-toggle-arrow{transform:translate(.57em,.71em) rotate(0deg)}
        .pp-shell.side-collapsed .pp-side-toggle-ch:nth-child(2){transform:translate(.57em,2.29em)}
        .pp-shell.side-collapsed .pp-side-toggle-ch:nth-child(3){transform:translate(.57em,3.65em)}
        .pp-shell.side-collapsed .pp-side-toggle-ch:nth-child(4){transform:translate(.57em,5.01em)}
        .pp-shell.side-collapsed .pp-side-toggle-ch:nth-child(5){transform:translate(.57em,6.37em)}
        /* 展开态侧栏头部只留占位（撑出与把手等高的一行）：看得见、点得到的是上面那个把手，
           两套视觉完全一致，于是看起来就是同一个按钮从竖排摊成横排。
           visibility:hidden 顺带把它从 Tab 顺序与无障碍树里摘掉，不会出现两个同名开关。 */
        .pp-side-head-toggle{height:34px;visibility:hidden;pointer-events:none}
      }
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
      /* 剩余学时（v0.271.0）：不新开色相 —— .jw-tag 的默认文字色就是 var(--deep)，16 套主题的
         浅/深两态都已实测达标，这里只加粗描边让它在同一排灰胶囊里认得出来。硬编码色一条都不加，
         test-theme-contrast.mjs 里「.jw-tag.ok/.warn/.live 恰好 3 条硬编码」那条计数不会被碰。 */
      .jw-tag.hours{font-weight:700;border-color:color-mix(in srgb,var(--deep) 34%,var(--line))}
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
      /* 自习室（v0.270.0）：一栋楼一张卡，卡里一间教室一行、五个节次各一个格子。
         过滤只切 [hidden]：卡片、行、组头都要真的消失 —— .jw-card 没设 display，默认就吃
         hidden 属性，这几条是兜底（将来谁给 .jw-card 加了 display 也不会漏）。 */
      .jw-room-bld[hidden],.jw-room-line[hidden],.jw-room-row[hidden],.jw-group[hidden]{display:none}
      .jw-room-bld{margin-bottom:12px}
      .jw-room-bld-hd{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-bottom:7px;margin-bottom:6px;border-bottom:1px solid var(--line-soft)}
      .jw-room-bld-name{font-size:calc(14px * var(--ui-text-scale));font-weight:700;color:var(--deep);letter-spacing:.02em}
      .jw-room-bld-sum{font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3);font-variant-numeric:tabular-nums}
      .jw-room-bld-sum b{color:var(--deep);font-weight:700}
      .jw-room-line{display:flex;align-items:center;gap:8px;padding:5px 2px}
      .jw-room-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink)}
      .jw-room-slots{display:flex;gap:3px;flex:none}
      /* 格子色与 .jw-tag 同一套语义（空闲 / 占用），深色整组重给 —— 浅色硬编码压深色面板只有 ~1.4:1 */
      .jw-room-slot{min-width:27px;padding:1px 4px;border-radius:6px;text-align:center;font-size:calc(9.5px * var(--ui-text-scale));font-variant-numeric:tabular-nums;border:1px solid var(--line-soft);background:var(--paper);color:var(--ink-3)}
      /* 节次切换行单独占一行：六个胶囊 + 搜索框挤一行在 390px 上会挤成「全部 1-2 3-4 5-6 / 7-8 / 9-10」
         三行 —— 窄屏不靠 flex-wrap 碰运气。 */
      .jw-room-bar{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
      .jw-room-bar::-webkit-scrollbar{display:none}
      /* 六个胶囊 + 「节次」标签在 390px 上默认字号放不下（实测 426px），收紧到 342px 才不横向滚 */
      .jw-room-bar .pp-chips{flex-wrap:nowrap;gap:6px}
      .jw-room-bar .pp-chip{padding:4px 9px;font-size:calc(11.5px * var(--ui-text-scale))}
      /* 日期行尾的日历按钮：原生 date 输入框铺满整块并透明，点哪儿都弹系统日历。
         原生弹层没法做双向动画，所以这里不做自建下拉（铁律七约束的是自建下拉栏）。 */
      .pp-datesel{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:26px;margin-left:6px;border-radius:8px;border:1px solid var(--line-soft);background:var(--paper);color:var(--ink-2)}
      .pp-datesel svg{width:15px;height:15px;pointer-events:none}
      .pp-datesel .jw-date-in{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;padding:0;background:transparent;cursor:pointer}
      /* 「全天空闲」标跟在间数后面：不改 header 原本的 space-between 布局，只让标不缩 */
      .jw-room-bld-hd .jw-tag{flex:none;font-size:calc(10px * var(--ui-text-scale))}
      .jw-room-slot.ok{background:rgba(46,196,182,.14);border-color:rgba(46,196,182,.45);color:#0B6B60}
      .jw-room-slot.bad{background:rgba(220,53,69,.12);border-color:rgba(220,53,69,.42);color:#B42318}
      .jw-room-slot.off{opacity:.4}
      [data-theme-mode="dark"] .jw-room-slot.ok{background:color-mix(in srgb,var(--mint) 18%,var(--panel));border-color:color-mix(in srgb,var(--mint) 42%,transparent);color:color-mix(in srgb,var(--mint) 55%,var(--ink))}
      [data-theme-mode="dark"] .jw-room-slot.bad{background:color-mix(in srgb,var(--danger) 18%,var(--panel));border-color:color-mix(in srgb,var(--danger) 42%,transparent);color:color-mix(in srgb,var(--danger) 55%,var(--ink))}
      .jw-room-row .jw-detail-grid{margin-top:8px;padding-top:8px}
      .jw-leave-draft small,.jw-detail-grid small{display:block;color:var(--ink-3);font-size:calc(10.5px * var(--ui-text-scale));line-height:1.7;margin-top:6px}
      /* ── 请假页：状态四档沿用「警大成绩」的分数四档色相 ──
         成绩页把分数分四档（.jg-good / .jg-warn / .jg-bad + --deep），请假状态同样只有
         「已同意 / 审批中 / 未同意 / 已撤销」四态，这里直接复用那四个色相，两页说同一种颜色语言。
         文字色在色相内取「压得住浅掺底」的一档：成绩页的 #1B7F4B / #B06A00 当 10.5px 小字压在
         同色底上只有 4.29 / 3.65:1（成绩页自己是色字压白底 5.02:1），所以标签档各加深一档；
         掺底取 8% 而不是 10% —— 16 套主题（含各自派生深色）实算的最差值：10% 时深色红只有
         4.38:1（褐底主题 fresh/claude/dunhuang/citrus 的深色面板 #202F2D / #2F2A20 最伤），
         8% 时四档最差 4.55:1，浅色最差 4.84:1，全部 ≥WCAG AA。作用域限定 .jw-leave ——
         选课 / 创新学分页的 .jw-tag 旧色各有主题对比度断言（test-theme-contrast.mjs 数着那三条），不连带改。 */
      .jw-leave .jw-tag.ok{background:rgba(21,112,63,.08);border-color:rgba(21,112,63,.34);color:#15703F}
      .jw-leave .jw-tag.warn{background:rgba(150,89,0,.08);border-color:rgba(150,89,0,.34);color:#965900}
      .jw-leave .jw-tag.bad{background:rgba(200,16,46,.08);border-color:rgba(200,16,46,.34);color:#C8102E}
      .jw-leave .jw-tag.muted{background:var(--paper);border-color:var(--line-soft);color:var(--ink-2)}
      [data-theme-mode="dark"] .jw-leave .jw-tag.ok{background:rgba(74,222,128,.08);border-color:rgba(74,222,128,.34);color:#4ADE80}
      [data-theme-mode="dark"] .jw-leave .jw-tag.warn{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.34);color:#FBBF24}
      [data-theme-mode="dark"] .jw-leave .jw-tag.bad{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.34);color:#F87171}
      [data-theme-mode="dark"] .jw-leave .jw-tag.muted{background:var(--paper);border-color:var(--line-soft);color:var(--ink-2)}
      /* 请假理由 / 课次行的课程信息是「内容」不是「注释」：--ink-3 在浅色面板上只有 3.49:1，
         这两处提到 --ink-2（浅色 5.4:1 / 深色 7.4:1），与成绩页正文同档。 */
      .jw-leave .jw-why{color:var(--ink-2)}
      .jw-leave .jw-row small{color:var(--ink-2)}
      .jw-leave .jw-leave-draft small{color:var(--ink-2)}
      .jw-leave .jw-card-t{color:var(--deep)}
      /* ── 我的考试（v0.272.0）：一场考试一张卡，左日期块 / 右课程与时段 / 下面考场。
         日期块是这一页唯一的「大数字」，其余都是 10.5~12px 的辅助行 —— 手机上一列扫下来
         先落到眼里的是「哪天考」，而不是课程名。 */
      .jw-exam-sum{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:8px 0 4px}
      .jw-exam-stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 12px;min-width:0}
      .jw-exam-stat b{display:block;font-size:calc(19px * var(--ui-text-scale));font-weight:700;color:var(--deep);line-height:1.15;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
      .jw-exam-stat span{display:block;margin-top:3px;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3);line-height:1.5}
      /* 只有「距下一场」会变红：另外两格是静态事实，一页里给两处红等于都没给 */
      .jw-exam-stat.hot b{color:var(--danger)}
      .jw-exam-card{display:flex;align-items:flex-start;gap:11px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:11px 13px;margin-bottom:7px;transition:border-color .16s ease,opacity .16s ease}
      .jw-exam-card[hidden]{display:none}
      .jw-exam-card.next{border-color:color-mix(in srgb,var(--danger) 46%,var(--line));box-shadow:inset 3px 0 0 var(--danger)}
      .jw-exam-card.done{opacity:.58}
      .jw-exam-date{flex:none;width:54px;text-align:center;border-radius:10px;background:var(--paper);border:1px solid var(--line-soft);padding:6px 0}
      .jw-exam-date b{display:block;font-size:calc(17px * var(--ui-text-scale));font-weight:700;color:var(--deep);line-height:1.1;font-variant-numeric:tabular-nums}
      .jw-exam-date span{display:block;font-size:calc(10px * var(--ui-text-scale));color:var(--ink-2);margin-top:2px;line-height:1.3}
      .jw-exam-main{flex:1;min-width:0}
      .jw-exam-main .jw-card-t{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;color:var(--deep)}
      /* 时段 / 考场 / 状态挤成一行（flex-wrap 兜住长考场名）：四行竖排的卡在 390 视口
         上要 132px，一屏只落一张；收成两行后 ~90px。 */
      .jw-exam-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:1px 12px;margin-top:5px}
      .jw-exam-when{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2);line-height:1.6;font-variant-numeric:tabular-nums}
      .jw-exam-when b{color:var(--ink);font-weight:700}
      .jw-exam-where{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2);line-height:1.65;overflow-wrap:anywhere}
      .jw-exam-line .pp-meta{margin-top:0}
      .jw-exam-where b{color:var(--campus-green);font-weight:700}
      .jw-exam-wi{white-space:nowrap}
      /* 卡片可点开（铁律七）：折叠沿用仓库既有的 grid-template-rows 0fr→1fr（与 .pp-detail-shell
         同一套），收起时内容留在 DOM 里继续插值 —— 换成 display:none 高度会跳、也没法做收起动画。 */
      .jw-exam-card{cursor:pointer}
      .jw-exam-card:focus-visible{outline:2px solid var(--deep);outline-offset:2px}
      .jw-exam-fold{display:grid;grid-template-rows:0fr;opacity:0;margin-top:0;transition:grid-template-rows .3s cubic-bezier(.2,.78,.2,1),opacity .2s ease,margin-top .3s cubic-bezier(.2,.78,.2,1)}
      .jw-exam-card.open .jw-exam-fold{grid-template-rows:1fr;opacity:1;margin-top:8px}
      .jw-exam-fold-clip{min-height:0;overflow:hidden}
      .jw-exam-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:5px 12px;padding-top:9px;border-top:1px dashed var(--line-soft);font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2);line-height:1.7}
      .jw-exam-detail>div{min-width:0;overflow-wrap:anywhere}
      .jw-exam-detail>div.jw-exam-span{grid-column:1/-1}
      .jw-exam-detail b{display:block;font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3);font-weight:500;margin-bottom:1px}
      .jw-exam-chev{flex:none;margin-left:auto;font-size:calc(13px * var(--ui-text-scale));color:var(--ink-3);line-height:1;transition:transform .28s cubic-bezier(.2,.78,.2,1)}
      .jw-exam-card.open .jw-exam-chev{transform:rotate(180deg)}
      /* 课程编号是标签里最"码"的一个：给它等宽数字宽度、把文字提到 ink-2，
         和「今天/已结束」那枚状态标签拉出层级（灰底灰字在 done 卡的 .58 透明度下更糊）。 */
      .jw-exam-code{color:var(--ink-2);font-variant-numeric:tabular-nums;letter-spacing:.01em}
      /* 学期单选（铁律六）：光块由宿主的 tide.ui.selectionGlow 画，这里只给容器定位与一套
         主题令牌配色 —— 圆角对齐 .pp-chip（16px），选中态把自己的底色让给光块。 */
      .jw-exam-terms{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
      .jw-exam-terms::-webkit-scrollbar{display:none}
      .jw-exam-terms .pp-chips{flex-wrap:nowrap;gap:6px;position:relative;isolation:isolate}
      .jw-exam-terms .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;transition:opacity .2s linear;border:1px solid color-mix(in srgb,var(--deep) 28%,var(--line));border-radius:16px;background:color-mix(in srgb,var(--deep) 9%,var(--panel))}
      .jw-exam-terms .selection-glow.on{opacity:1}
      .jw-exam-terms .pp-chip{position:relative;z-index:1;white-space:nowrap}
      .jw-exam-terms .pp-chip.on{background:transparent;border-color:transparent;color:var(--deep);font-weight:700}
      @media(max-width:600px){
        /* APK / 390 视口：三格并排一行。原来「首格跨满 + 两列」要吃掉 ~147px 高，
           加上壳头部后首屏只落得下一张考试卡。 */
        .jw-exam-sum{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
        .jw-exam-stat{padding:8px 9px}
        .jw-exam-stat b{font-size:calc(15px * var(--ui-text-scale))}
        .jw-exam-stat span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px;font-size:calc(9.5px * var(--ui-text-scale))}
        /* 卡内纵向收紧：四项内容（课程 / 时段 / 考场 / 状态）单行排下来 140px 太松，收到 ~104px */
        .jw-exam-card{padding:9px 10px;gap:9px;margin-bottom:6px}
        .jw-exam-date{width:46px;padding:5px 0}
        .jw-exam-date b{font-size:calc(16px * var(--ui-text-scale))}
        .jw-exam-date span{font-size:calc(9px * var(--ui-text-scale));margin-top:1px}
        .jw-exam-line{margin-top:4px;gap:1px 10px}
        .jw-exam-when{font-size:calc(11.5px * var(--ui-text-scale))}
        .jw-exam-where{font-size:calc(11px * var(--ui-text-scale))}
        [data-exam-group] .jw-sec{padding:10px 2px 6px}
        .jw-exam-notice{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
        /* 窄屏展开区改两列：auto-fit 的 132px 底线在 390px 上只够一列，五个字段竖着排比主行还高 */
        .jw-exam-detail{grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 10px}}
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
.jw-credit-course.doing{border-color:var(--line-soft)}
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
      /* 指标图标（请假汇总卡）：左图标 + 右「数值在上、标签在下」，与一卡通三张卡的 .yk-amount 同一语言 */
      .jg-metrics .jg-metric{display:flex;align-items:center;gap:11px;min-width:0}
      .jg-metrics .jg-metric .pp-metric-ico{flex:none;display:block}
      .jg-metrics .jg-metric-text{min-width:0}
      .jg-metrics .jg-metric-text b{display:block;line-height:1.15}
      .jg-metrics .jg-metric-text small{display:block;margin-top:1px}
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
      /* 绩点排名情况 / 六维图（数据来自学生个人成长中心） */
      .jg-rank-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 10px;margin:8px 0 10px}
      .jg-rank-item{display:flex;align-items:center;gap:16px;min-width:0}
      .jg-rank-badge{flex:none;width:65px;height:65px;border-radius:50%;background:#e8f4fc;display:flex;align-items:center;justify-content:center}
      .jg-rank-badge img{width:36px;height:40px;display:block}
      .jg-rank-right{display:flex;flex-direction:column;gap:1px;min-width:0}
      .jg-rank-num{color:#2a7eff;font-size:calc(20px * var(--ui-text-scale));line-height:1.15;font-weight:600}
      .jg-rank-right small{color:var(--ink-3);font-size:calc(12px * var(--ui-text-scale));white-space:nowrap}
      [data-theme-mode="dark"] .jg-rank-badge{background:rgba(42,126,255,.16)}
      [data-theme-mode="dark"] .jg-rank-num{color:#7CB6FF}
      .jg-legend{display:flex;gap:14px;flex-wrap:wrap;margin:2px 0 4px;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale))}
      .jg-legend span{display:inline-flex;align-items:center;gap:5px}
      .jg-legend i{width:9px;height:9px;border-radius:3px;display:inline-block}
      .jg-legend i.mine{background:#FB951E}.jg-legend i.top{background:#2A7EFF}
      .jg-radar{display:block;width:100%;max-width:290px;height:auto;margin:0 auto}
      .jg-radar-grid polygon,.jg-radar-grid line{fill:none;stroke:var(--line);stroke-width:1}
      .jg-radar-top{fill:rgba(42,126,255,.18);stroke:#2A7EFF;stroke-width:1.6}
      .jg-radar-mine{fill:rgba(251,149,30,.2);stroke:#FB951E;stroke-width:1.6}
      .jg-radar-label text{fill:var(--ink-3);font-size:calc(11px * var(--ui-text-scale))}
      [data-theme-mode="dark"] .jg-radar-top{stroke:#7CB6FF}[data-theme-mode="dark"] .jg-radar-mine{stroke:#FBBF24}
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
      /* 三张卡的图标行：图标与金额并排，金额仍是卡片主角（图标 44px / 金额 30px） */
      .yk-total .yk-amount,.yk-spent .yk-amount,.yk-balance .yk-amount{display:flex;align-items:center;gap:12px;min-width:0}
      .yk-total .yk-amount .pp-metric-ico,.yk-spent .yk-amount .pp-metric-ico,.yk-balance .yk-amount .pp-metric-ico{flex:none;display:block}
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
      @media(max-width:600px){.jw-card-t{font-size:calc(14.5px * var(--ui-text-scale))}.jw-head h3{font-size:calc(17px * var(--ui-text-scale))}.jw-sum b{font-size:calc(26px * var(--ui-text-scale))}.jw-row small{min-width:0;flex-basis:100%}
    /* APK / 390 视口：三分类型排要吃掉近 270px，首屏只剩一张汇总卡 → 并成一行三格。 */
    .jw-sum{padding:10px 12px;margin:4px 0 8px}
    .jw-credit-overview{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    .jw-credit-stat{padding:8px 9px}
    .jw-credit-stat small{font-size:calc(9.5px * var(--ui-text-scale));margin-bottom:3px}
    .jw-credit-stat b{font-size:calc(15px * var(--ui-text-scale))}
    .jw-credit-stat span{font-size:calc(9.5px * var(--ui-text-scale));margin-top:2px}
    .jw-credit-stat em{display:none}
    .jw-credit-bar{height:5px;margin-top:6px}}
      @media(max-width:820px){
        .pp-shell{flex-direction:column;padding:0 14px}
        /* 窄屏时侧栏是整层叠在正文上面的，收起要收"高度"而不是宽度 */
        .pp-side{width:100%;position:static;padding:10px;margin-right:0;margin-bottom:12px;max-height:1400px;transition:max-height .34s cubic-bezier(.22,.8,.22,1),margin-bottom .34s cubic-bezier(.22,.8,.22,1),padding .34s cubic-bezier(.22,.8,.22,1),border-width .3s ease,opacity .24s ease}
        .pp-side-inner{width:100%}
        .pp-shell.side-collapsed .pp-side{width:100%;max-height:0;padding-top:0;padding-bottom:0;margin-bottom:0;border-top-width:0;border-bottom-width:0;opacity:0}
        /* 手机上的两个开关（收起后的把手 / 展开态头部的收起按钮）都要 44px 触控区，手指才点得准 */
        /* 窄屏是整层叠放，没有「竖条 ⇄ 头部」那套变形，把手就是普通横按钮：
           把桌面版绝对定位的那几个字退回行内（.pp-shell 前缀提权重，压过 nth-child 的坐标） */
        /* 窄屏把手的权重同样要写到 (0,3,0)：否则被 interactions.css 的按钮规则压住 position/transition。 */
      .pp-shell .pp-side-toggle[data-side-toggle]{position:relative;top:auto;margin-right:0;margin-bottom:12px;max-width:100%;width:auto;height:auto;min-height:44px;max-height:64px;transform:none;display:inline-flex;align-items:center;gap:7px;padding:10px 14px;font-size:calc(13px * var(--ui-text-scale))}
        .pp-shell .pp-side-toggle>span{position:static;width:auto;height:auto;line-height:1.35;transform:none}
        .pp-side-head-toggle{min-height:44px;padding:10px 14px;font-size:calc(13px * var(--ui-text-scale))}
        /* 展开时把手要整体藏掉：min-height 会压过 max-height，所以必须把 min-height 也归零，
           否则窄屏上会在侧栏与正文之间留一条 44px 的隐形空隙 */
        .pp-shell:not(.side-collapsed) .pp-side-toggle{margin-bottom:0;min-height:0;max-height:0;padding-top:0;padding-bottom:0;padding-left:0;padding-right:0;border-width:0;opacity:0;visibility:hidden;pointer-events:none}
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
        .pp-kwbox{flex:1 1 100%;order:2;min-width:0}.pp-kwbox>.pp-kw{height:44px}
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
      @media(prefers-reduced-motion:reduce){.pp-card,.pp-expand,.pp-expand::after,.pp-detail-shell,.pp-detail,.jw-exam-fold,.jw-exam-chev,.pp-side,.pp-side-inner,.pp-side-toggle,.pp-side-toggle>span,.pp-side-sub,.pp-banner-act,.pp-banner-act-hint::before{transition-duration:.01ms!important}}
    `;
    document.head.append(st);
  }

  // 清除凭据是一个代际边界：旧请求可结束，但不能再恢复身份或写回密钥库。
  let authEpoch = 0, authClearing = 0;
  const authCurrent = (epoch, username) => epoch === authEpoch && (username === undefined || username === state.username);
  let authStorageTail = Promise.resolve();
  function authStorage(operation) {
    const next = authStorageTail.then(operation);
    authStorageTail = next.catch(() => {});
    return next;
  }
  function savedPasswordFor(secret, username) {
    // 兼容旧版无账号字段的记录；下次成功登录会补齐账号绑定。
    return secret && (!secret.username || secret.username === username) && typeof secret.password === "string" ? secret.password : "";
  }

  async function loadPrefs() {
    if (authClearing) return;
    const epoch = authEpoch;
    const f = await tide.storage.get("filter", null);
    if (f) state.filter = { ...state.filter, ...f };
    const username = (await tide.storage.get("username", "")) || "";
    const rememberUsername = await tide.storage.get("rememberUsername", true) !== false;
    const autoLogin = await tide.storage.get("autoLogin", true) !== false;
    if (!authCurrent(epoch)) return;
    state.username = username;
    state.rememberUsername = rememberUsername;
    state.autoLogin = autoLogin;
    const autoRefresh = await tide.storage.get("autoRefresh", true) !== false;
    const loginRetries = cleanLoginRetries(await tide.storage.get("loginRetries", 2));
    const seen = new Set(await tide.storage.get("seen", []));
    const loginAt = Number(await tide.storage.get("autoLoginAt", 0)) || 0;
    let password = "";
    if (autoLogin && typeof tide.vault?.get === "function") {
      try { password = savedPasswordFor(JSON.parse((await tide.vault.get("secret")) || "null"), username); } catch { /* 保留磁盘记录，稍后可重试读取 */ }
    }
    if (authCurrent(epoch, username)) Object.assign(state, { autoRefresh, loginRetries, seen, loginAt, savedPassword: state.autoLogin ? password : "" });
  }
  const saveFilter = () => tide.storage.set("filter", state.filter);
  // 恢复默认筛选：关键词也在 filter 里存着，只点面板里的「全部」分类/月份清不掉它 —— 必须整体重置
  function resetFilter() {
    state.filter = { kw: "", year: "all", month: "all", kind: "all", hideSeen: false };
    if (ui?.kw) ui.kw.value = "";
    saveFilter();
    if (ui) paintAll();
  }
  const saveSeen = () => tide.storage.set("seen", [...state.seen].slice(-500));

  // 缓存数据而非登录页面，恢复时重新渲染，凭据仍只存密钥库。
  async function saveNoticeCache() {
    const epoch = authEpoch, username = state.username;
    try {
      const details = {};
      const notices = state.notices.slice(0, PAGE_SIZE * PAGES_MAX);
      for (const item of notices) {
        const key = itemKey(item), detail = state.details[key];
        if (detail && !detail.loading && !detail.error) details[key] = detail;
      }
      const snapshot = { username, notices, details, at: state.fetchedAt };
      // 同一条队列保持写入顺序，旧账号的慢写入不能覆盖新账号的缓存。
      await authStorage(() => authCurrent(epoch, username) ? cacheStore.set("noticeCache", snapshot) : undefined);
    } catch { /* 写失败不影响已加载页面 */ }
  }
  async function restoreNoticeCache() {
    const epoch = authEpoch, username = state.username;
    try {
      const cache = await cacheStore.get("noticeCache", null);
      if (!authCurrent(epoch, username)) return false;
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
    state.error = `登录或连接失败，正在显示缓存（${state.fetchedAt ? new Date(state.fetchedAt).toLocaleString("zh-CN") : "更新时间未知"}）。${error || "点这条状态条或上方「刷新」可重试，需要重新登录时点「重新登录」。"}`;
    buildMain(el);
    return true;
  }

  /* 本地缓存已经画过首屏时，网络回来只重画内容，别再 buildMain 重建整页 ——
     重建会把刚渲染好的列表整段替换掉，阅读位置回到顶部，还会闪一帧。 */
  let cacheFirstPaint = false;
  function paintAfterLoad(el) {
    if (cacheFirstPaint && el && el.isConnected) { paintAll(); return; }
    buildMain(el);
  }

  /* ── 登录态持久化：Cookie 存密钥库，重启后恢复会话免验证码 ── */
  async function saveCookies() {
    if (authClearing || !state.autoLogin || typeof tide.vault?.set !== "function" || !state.sid) return;
    const epoch = authEpoch, sid = state.sid, username = state.username;
    try {
      const dump = await tide.http.exportCookies(sid, [SSO, JW, PORTAL, JWAPP, PDATA]);
      await authStorage(async () => {
        if (authCurrent(epoch, username) && state.autoLogin && state.sid === sid && dump.length) {
          await tide.vault.set("cookies", JSON.stringify({ username, cookies: dump }));
        }
      });
    } catch { /* 密钥库不可用（浏览器调试）时静默跳过 */ }
  }

  let restorePending = null, cookieSessionSid = null;
  async function restoreCookies() {
    if (authClearing || state.autoLogin === false || typeof tide.vault?.get !== "function") return false;
    // HTTP 运输会话也可能是空的（先开个人信息就会建立它），只有已恢复/认证的会话能短路。
    if (state.sid && (state.token || jwSid === state.sid || cookieSessionSid === state.sid || loginBusy)) return true;
    if (restorePending) return restorePending;
    const epoch = authEpoch, initialSid = state.sid;
    const pending = (async () => { try {
      // render 会与 loadPrefs 并行，不能依赖尚未水合的默认 autoLogin=true。
      if (await tide.storage.get("autoLogin", true) === false || !authCurrent(epoch)) return false;
      const raw = await tide.vault.get("cookies");
      const record = raw ? JSON.parse(raw) : null;
      const dump = Array.isArray(record) ? record : record?.cookies;
      const username = state.username || (await tide.storage.get("username", "")) || "";
      if (!authCurrent(epoch) || !state.autoLogin || (record?.username && username && record.username !== username)) return false;
      if (Array.isArray(dump) && dump.length) {
        const sid = await tide.http.restoreCookies(dump);
        if (!authCurrent(epoch) || !state.autoLogin || (state.username && state.username !== username)) return false;
        if (state.sid && state.sid !== initialSid) return true; // 另一条前台链已建立会话，迟到的恢复不能覆盖它。
        state.sid = sid;
        cookieSessionSid = sid;
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
    })();
    restorePending = pending;
    try { return await pending; }
    finally { if (restorePending === pending) restorePending = null; }
  }

  async function clearSavedLogin() {
    authClearing++;
    authEpoch++;
    cookieSessionSid = null;
    restorePending = null;
    sidPending = null;
    loginPrefsReady = null;
    passwordLoginPending = null;
    passwordLoginFailure = null;
    state.sid = null;
    state.token = "";
    state.pending = null;
    state.captcha = "";
    state.savedPassword = "";
    state.loginAt = 0;
    state.notices = []; state.details = {}; state.fetchedAt = 0;
    awState.sessionOk = false;
    forgetPdataAuth();
    jwSid = null;
    jwBootPromise = null; jwRound++; jwRoundLoginFailed = -1;
    for (const key of Object.keys(jwState.data)) jwState.data[key] = null;
    jwState.at = {}; jwState.error = {}; jwState.term = null;
    return authStorage(async () => {
      // 每个删除独立完成，一个键失败不能阻止其它凭据的清理。
      const deleted = await Promise.allSettled(["secret", "cookies", PDATA_VAULT_KEY].map(key => Promise.resolve().then(() => tide.vault?.del?.(key))));
      // 预热/登录时间戳一起清掉：留着会让下一个人（或清号后的自己）在登录页看到上一个人的登录时间。
      await Promise.allSettled(["autoWarmAt", "autoWarmFailAt", "autoLoginAt"].map(key => Promise.resolve().then(() => tide.storage.set(key, 0))));
      return deleted.every(result => result.status === "fulfilled");
    }).finally(() => { authClearing--; });
  }

  /* ── 会话通道：取数之前必须已经有一个会话 ──
     冷启动直接进「学生成长 / 一卡通 / 个人信息」会踩这条：pdata 的 token 就躺在密钥库里，
     ensurePdataAuth 第一行 `if (pdataAuth.token) return` 直接短路 —— 整条链路谁都没调过
     newSession，state.sid 还是 null。把它交给 invoke("http_fetch") 会被 Rust 侧挡回来：

       invalid args `sid` for command `http_fetch`:
       invalid type: null, expected a string

     所以「没有就建」压在这一层，与调用顺序无关。并发只建一个：成长页首屏同时打 8 个接口，
     它们会同时发现 sid 是空的。 */
  let sidPending = null;
  function ensureSid() {
    if (state.sid) return Promise.resolve(state.sid);
    if (!sidPending) {
      const epoch = authEpoch;
      const pending = Promise.resolve(tide.http.session())
        .then((sid) => {
          if (!authCurrent(epoch)) return null;
          if (!state.sid && sid) state.sid = sid;
          return state.sid;
        })
        .finally(() => { if (sidPending === pending) sidPending = null; });
      sidPending = pending;
    }
    return sidPending;
  }

  /* ── SSO 登录链路 ── */
  async function newSession() { if (!state.sid) await ensureSid(); }
  const referer = () => PORTAL + "/tp_up/view;tp_up=" + state.token + "?m=up";

  async function getPage(url, useBinary = false, opts = {}) {
    const epoch = authEpoch;
    try {
      const sid = await ensureSid();
      if (!sid) throw new Error("本机取数会话没建起来，请重启应用后再试一次");
      if (!authCurrent(epoch)) throw new Error("登录状态已改变，请重新操作");
      const result = await tide.http.fetch(sid, "GET", url, { ...opts, binary: useBinary });
      if (!authCurrent(epoch) || state.sid !== sid) throw new Error("登录状态已改变，请重新操作");
      return result;
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

  /* 验证码「先看清再提交」（v0.246.0）：SSO 的验证码与会话绑定，一张图只能提交一次，
     识别结果不管多模糊都直接 POST 等于白烧一次尝试（自动重试上限才 2 次）。现在置信度
     偏低就原地换一张图重认，并且**始终提交最后那张图自己的识别结果** —— 换成旧图会
     必然对不上，等于把重试次数手动烧掉。 */
  const CAPTCHA_MIN_CONFIDENCE = 0.34;   // classify() 的相似度下限是 0.18，这里取「明显更清楚」的一档
  const CAPTCHA_RESHOTS = 2;             // 最多再换两张，别把一次登录拖成验证码批发

  /* 读一张验证码并识别到「够清楚」为止；始终不够清楚也把最后一次结果交出去试一次。 */
  async function readCaptchaCode(checkActive) {
    let last = null;
    for (let shot = 0; shot <= CAPTCHA_RESHOTS; shot++) {
      if (shot) { await fetchCaptcha(); checkActive(); }
      last = await OCR.recognize(state.captcha);
      if (!last?.code) return last;
      // 老宿主 / 测试桩不给 confidence（非有限数）时按「可用」处理，不额外换图。
      const conf = Number(last.confidence);
      if (!Number.isFinite(conf) || conf >= CAPTCHA_MIN_CONFIDENCE) return last;
    }
    return last;
  }

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
            const ocr = await readCaptchaCode(checkActive);
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

  /* 「上次自动登录」只给登录页做解释用；写盘失败不影响登录本身。 */
  function markLoginAt(at = Date.now()) {
    const epoch = authEpoch;
    state.loginAt = at;
    return authStorage(() => authCurrent(epoch) ? tide.storage.set("autoLoginAt", at) : undefined).catch(() => {});
  }

  /* ── 启动预热（v0.246.0）──
     门户的 rememberMe 只保 5 天，而且「用一次」才顺延。过去只有打开本插件视图才碰登录
     态 ⇒ 隔几天再点开，第 6 天回来必弹验证码。现在应用启动 8 秒后在后台静默续期一次
     （12 小时频控），把 CASTGC 的使用时间推后：代价是每半天 2~4 个请求，换来「打开插件
     就是已登录」。只在没有视图占着会话时做，绝不与前台登录抢 state.sid。 */
  const WARM_DELAY_MS = 8000;
  const WARM_EVERY_MS = 12 * 60 * 60 * 1000;
  /* 失败的退避比成功的频控短得多：手机上续期失败十有八九是「刚从后台醒来、网还没连上」，
     按 12 小时压着就等于一整天都不再续，第 6 天回来照样弹验证码。 */
  const WARM_RETRY_MS = 30 * 60 * 1000;
  let warmBusy = false, warmPromise = null;
  let warmDisposed = false, warmCleanup = null;

  /* 续期一次。返回 true = 这次真的把票据推后了，false = 试过但没成，
     "skip" = 压根不该做（没授权 / 没票据），不计入失败退避。

     v0.272.7 的两处修正：
     ① `state.sid` 不再当闸门 —— 它一旦建出来就整个运行期不清（只有 clearSavedLogin 清），
        原先「有会话就拒绝」等于**用过一次插件之后，本轮运行再也不会预热**，而这正是
        手机端的常态（应用不关，只是切到后台）。
     ② 已有会话时直接在它上面续期，不再 restore 一个新会话盖掉它 —— 没有视图占用时这么做是安全的，
        有视图时 scheduleWarm 的入口闸门（viewOpen）本来就不放行。 */
  async function warmSession() {
    // 测试沙箱用 vm 造了 document 却没有 window：不排程、不发请求。
    if (typeof window === "undefined" || warmDisposed) return false;
    if (warmBusy) return warmPromise || false;
    if (loginBusy || state.viewOpen) return false;
    if (typeof tide.vault?.get !== "function") return false;
    const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
    if (!online()) return false;
    // focus、visibilitychange、定时器可以在同一帧到达，必须先占用再读取异步存储。
    warmBusy = true;
    const epoch = authEpoch;
    const current = () => !warmDisposed && authCurrent(epoch);
    warmPromise = (async () => {
      let result = "skip";
      try {
        const now = Date.now();
        const recent = (at, limit) => Number.isFinite(Number(at)) && Number(at) > 0 && now >= Number(at) && now - Number(at) < limit;
        const okAt = await tide.storage.get("autoWarmAt", 0);
        if (!current() || recent(okAt, WARM_EVERY_MS)) return false;
        const failAt = await tide.storage.get("autoWarmFailAt", 0);
        if (!current() || recent(failAt, WARM_RETRY_MS)) return false;
        await loadPrefs();
        if (!current() || !online() || loginBusy || state.viewOpen || state.autoLogin === false || !state.username) return false;
        if (!state.sid && !(await restoreCookies())) return false;
        if (!current() || !online() || loginBusy || state.viewOpen) return false;
        result = false;
        if (!(await silentRenew()) || !current() || !online()) return false;
        await saveCookies();
        if (!current() || !online()) return false;
        result = true;
        return true;
      } catch { return false; }
      finally {
        try {
          // 与清除凭据串行，并在真正写入前检查代际；旧续期不能把清除后的时间重新写回来。
          if (result !== "skip" && current() && online()) await authStorage(async () => {
            if (!current() || !online()) return;
            const at = Date.now();
            if (result === true) {
              await Promise.resolve(tide.storage.set("autoWarmAt", at)).catch(() => {});
              if (!current()) return;
              await Promise.resolve(tide.storage.set("autoWarmFailAt", 0)).catch(() => {});
              if (!current()) return;
              await Promise.resolve(tide.storage.set("autoLoginAt", at)).catch(() => {});
              if (current()) state.loginAt = at;
            } else {
              await Promise.resolve(tide.storage.set("autoWarmFailAt", at)).catch(() => {});
            }
          });
        } catch { /* 写入失败不影响本次会话 */ }
        finally { warmBusy = false; warmPromise = null; }
      }
    })().then(ok => ok === true && current());
    return warmPromise;
  }

  /* ── 前台可见即续期（v0.272.7，APK 的关键一条）──
     Android 后台会冻结 WebView 的定时器（Doze + 计时器对齐）：锁屏放一夜，12 小时的
     setInterval 一次都跑不了，于是「打开插件就是已登录」只在桌面成立。用户真正「回来」
     的那一刻是切回应用 —— 那就把续期挂在可见性/焦点上，闸门（授权/频控/退避）全在
     warmSession 里，这里只负责叫，叫了不等于会做。

     网络恢复时也走同一个闸门；停用插件时移除监听，不让旧实例继续续期。 */
  function bindWarmOnForeground() {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => {};
    const relay = () => {
      if (typeof document.visibilityState === "string" && document.visibilityState === "hidden") return;
      warmSession().catch(() => {});
    };
    try {
      document.addEventListener("visibilitychange", relay);
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("focus", relay);
        window.addEventListener("online", relay);
      }
    } catch { /* 老宿主没有 addEventListener 就只能靠定时器 */ }
    return () => {
      document.removeEventListener?.("visibilitychange", relay);
      window.removeEventListener?.("focus", relay);
      window.removeEventListener?.("online", relay);
    };
  }

  function scheduleWarm() {
    if (typeof window === "undefined" || typeof window.setTimeout !== "function") return;
    // 重载时把旧实例的计时器、事件与在途结果一起停掉；宿主停用走同一个清理函数。
    try { window.__cppuWarmDispose?.(); } catch { /* ignore */ }
    warmCleanup?.();
    warmDisposed = false;
    let delayTimer = null, retryTimer = null, stopped = false;
    const run = () => { warmSession().catch(() => {}); };
    const unbind = bindWarmOnForeground();
    const dispose = () => {
      if (stopped) return;
      stopped = true;
      warmDisposed = true;
      authEpoch++;
      window.clearTimeout?.(delayTimer);
      window.clearInterval?.(retryTimer);
      unbind();
      if (window.__cppuWarmDispose === dispose) delete window.__cppuWarmDispose;
      if (warmCleanup === dispose) warmCleanup = null;
    };
    warmCleanup = dispose;
    window.__cppuWarmDispose = dispose;
    try {
      delayTimer = window.setTimeout(run, WARM_DELAY_MS);
      // 每 30 分钟检查失败重试，成功仍由 12 小时闸门控制，休眠恢复由前台事件补齐。
      if (typeof window.setInterval === "function") retryTimer = window.setInterval(run, WARM_RETRY_MS);
    } catch { /* ignore */ }
    tide.ui?.onDispose?.(dispose);
  }

  /* 密码兜底与人工按钮共享重试边界、退避和全新会话流程。 */
  let passwordLoginPending = null, passwordLoginFailure = null;
  const PASSWORD_LOGIN_COOLDOWN_MS = 30 * 60 * 1000;
  async function passwordAutoLogin() {
    if (authClearing || !state.autoLogin || !state.username || !state.savedPassword) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    if (passwordLoginPending) return passwordLoginPending;
    const epoch = authEpoch, username = state.username, password = state.savedPassword;
    const elapsed = Date.now() - (passwordLoginFailure?.at || 0);
    if (passwordLoginFailure?.username === username && elapsed >= 0 && elapsed < PASSWORD_LOGIN_COOLDOWN_MS) {
      loginHint = { msg: "自动登录暂时未成功，已暂停重复尝试；请手动登录或稍后重试", code: "" };
      return false;
    }
    if (loginBusy) return false;
    loginHint = null;
    const pending = (async () => { try {
      await runLoginAttempts({ username, password, isActive: () => authCurrent(epoch, username) && state.autoLogin });
      if (!authCurrent(epoch, username) || !state.autoLogin) return false;
      passwordLoginFailure = null;
      await persistCredentials(password);
      if (!authCurrent(epoch, username) || !state.autoLogin) return false;
      saveCookies().catch(() => {});   // 票据落盘不挡首屏：晚几百毫秒写进密钥库不影响这次使用
      markLoginAt();
      tide.notify("已自动完成登录（含验证码识别）");
      return true;
    } catch (error) {
      if (!authCurrent(epoch, username)) return false;
      passwordLoginFailure = { username, at: Date.now() };
      loginHint = { msg: `${loginErrorText(error)}；请核对账号和验证码后重试`, code: "" };
      return false;
    } })();
    passwordLoginPending = pending;
    try { return await pending; }
    finally { if (passwordLoginPending === pending) passwordLoginPending = null; }
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

  async function autoLogin(el, restored) {
    const epoch = authEpoch;
    // 启动预热正拿着会话找续期时先等它 —— 它做的正是第 ① 步，并行只会互相踩 state.sid。
    if (warmBusy && warmPromise) { try { await warmPromise; } catch { /* 预热失败按无票据处理 */ } }
    // ① 恢复上次会话票据（CASTGC 有效期内直达，不碰验证码）；render 已并发读好时直接用
    const hasCookies = restored === undefined ? await restoreCookies() : await restored;
    if (!authCurrent(epoch)) return false;
    if (!hasCookies) await newSession();
    if (state.token) {
      // Cookie 中的 tp_up 可能已过期：先用列表接口做真实校验，失败后继续走
      // 主 SSO/密码兜底，不能把用户留在只有“会话过期”的空列表页。
      if (await loadPage(1)) { if (!authCurrent(epoch)) return false; markLoginAt(); paintAfterLoad(el); return true; }
      if (!authCurrent(epoch)) return false;
      state.token = "";
      state.error = null;
    }
    if (await silentRenew()) {
      if (!authCurrent(epoch)) return false;
      saveCookies().catch(() => {});   // 同上：先让列表页走起来，票据稍后落盘
      markLoginAt();
      tide.notify("已自动恢复门户登录，正在打开通知");
      paintAfterLoad(el);
      loadPage(1);
      return true;
    }
    // ② 票据失效：有保存的密码就走「验证码识别 + 换图重试」全自动登录
    if (!authCurrent(epoch)) return false;
    if (await passwordAutoLogin()) {
      if (!authCurrent(epoch)) return false;
      paintAfterLoad(el);
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
    if (authClearing || !state.autoLogin || typeof tide.vault?.set !== "function") return;
    const epoch = authEpoch, username = state.username;
    try {
      await authStorage(async () => {
        if (!authCurrent(epoch, username) || !state.autoLogin) return;
        await tide.vault.set("secret", JSON.stringify({ username, password }));
        if (authCurrent(epoch, username) && state.autoLogin) state.savedPassword = password;
      });
    } catch { /* 密钥库不可用时跳过 */ }
  }

  async function finishPortalTicket(loginRes) {
    const direct = tokenFromText(loginRes?.finalUrl, loginRes?.location, loginRes?.body, ...(loginRes?.cookies || []));
    if (direct) { state.token = direct; forgetPdataAuth(); return true; }
    const portalTicket = redirectTarget(loginRes, SILENT_LOGIN, PORTAL);
    if (!portalTicket) return false;
    const portal = await getPage(portalTicket, false, { followRedirects: false }).catch(() => null);
    const token = tokenFromText(portal?.finalUrl, portal?.location, portal?.body, ...(portal?.cookies || []));
    if (token) { state.token = token; forgetPdataAuth(); return true; }
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
    const epoch = authEpoch;
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
    if (!authCurrent(epoch)) throw { fatal: "登录状态已改变，请重新操作" };
    if (await finishPortalLogin(res)) {
      if (!authCurrent(epoch)) throw { fatal: "登录状态已改变，请重新操作" };
      state.pending = null; return;
    }
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
    const epoch = authEpoch;
    // 先试 sso-jw 自己的 CASTGC；若只有主 SSO 的 CASTGC，再由 finishPortalLogin
    // 显式完成主 SSO → bridge → sso-jw → portal，所有一次性 ticket 均只消费一次。
    const renew = await getPage(SILENT_LOGIN, false, { followRedirects: false }).catch(() => null);
    if (!authCurrent(epoch)) return false;
    if (await finishPortalTicket(renew)) return true;
    const primary = await getPage(LOGIN_URL, false, { followRedirects: false }).catch(() => null);
    if (!authCurrent(epoch)) return false;
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
    const epoch = authEpoch, username = state.username;
    const stored = await tide.storage.get("knownIds", null);
    if (!authCurrent(epoch, username)) return;
    const known = new Set(Array.isArray(stored) ? stored : []);
    const fresh = stored === null ? [] : items.filter((it) => itemKey(it) && !known.has(itemKey(it)));
    await authStorage(() => authCurrent(epoch, username) ? tide.storage.set("knownIds", items.map(itemKey).filter(Boolean)) : undefined);
    if (!authCurrent(epoch, username) || !fresh.length) return;
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
    const epoch = authEpoch, username = state.username;
    if (state.fetching && state.noticeFetch?.epoch === epoch && state.noticeFetch?.username === username) return;
    // 清号后无需等旧网络请求结束；只有拥有本次请求标记的收尾能撤销 fetching。
    const request = { epoch, username };
    state.noticeFetch = request;
    const current = () => authCurrent(epoch, username) && state.noticeFetch === request;
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
      if (!current()) return false;
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
      if (!current()) return false;
      // v0.11.0：新通知先进入统一收件箱，用户确认后再转任务，避免自动化误建日程。
      if (page === 1 && tide.inbox && typeof tide.inbox.create === "function") {
        for (const it of items.slice(0, 12)) {
          const title = titleOf(it);
          const key = itemKey(it);
          tide.inbox.create({ sourceKey: `cppu:${key}`, title, note: "警大门户新通知 · 打开通知详情后可进一步识别日期和时间", suggestion: "create-task" });
        }
      }
      if (page === 1) await broadcastNew(items);
      return current();
    } catch (e) {
      if (!current()) return false;
      // 会话过期先尝试静默续期一次
      if (!renewed) {
        const renewedSession = await silentRenew();
        if (!current()) return false;
        if (renewedSession) {
          state.fetching = false;
          state.noticeFetch = null;
          return await loadPage(page, true);
        }
      }
      const error = String(e.message || e);
      const cached = await restoreNoticeCache();
      if (!current()) return false;
      state.error = cached ? `连接失败，正在显示缓存（${state.fetchedAt ? new Date(state.fetchedAt).toLocaleString("zh-CN") : "更新时间未知"}）。${error}` : error;
      return false;
    } finally {
      if (state.noticeFetch === request) {
        state.fetching = false;
        state.noticeFetch = null;
        if (authCurrent(epoch, username)) paintAll();
      }
    }
  }

  // 筛选结果为 0 时旧的「加载更早」按钮不会出现（空态分支提前 return），老数据永远够不着；
  // 这里连页往回拉，直到出现匹配或没有更多页。
  async function loadOlderUntilMatch() {
    while (state.hasMore && !filtered().length) {
      const ok = await loadPage(state.page + 1);
      if (!ok) break;
    }
  }

  /**
   * 通知正文 + 附件：只取数、不碰 UI。
   *
   * 为什么从 loadDetail 里抠出来（v0.207.0）：获奖名单视图要批量读几十条通知的正文才能在
   * 里面筛出获奖名单，而两个视图会同时活在内存里 —— 共用一个 `ui` 变量必然互相污染。
   * 取数（这里）与呈现（loadDetail / 获奖视图）分开后，两边都能各自决定什么时候画。
   */
  /* 一条通知的正文 + 附件表。
     ⚠️ 时序是有意安排的，改动前先看懂这一段：
     这里的三个请求是 ①详情（给 PIM_CONTENT 与 CONTENT_URL）②正文页 ③附件列表。
     过去写成 ①→②→③ 三连串行 await，等于一条候选要等 **三个 RTT**：门户单次 300~600ms，
     一条就是 1.0~1.6s，获奖名单 200 多条候选按并发 3 摊下来要一分半 —— 那就是「感觉太慢」。
     但依赖关系只有一层：②要等①给的 CONTENT_URL，③**只要 rid**。
     所以③在函数一进去就发出去，②与③再并一层 ⇒ 三连压成两连，一条省掉约 1/3 的等待，
     而且不改任何判定口径（该读的条目一条不少，只是等得更省）。
     失败语义保持原样：①③是硬依赖（①没了整条失败，③失败只记 attachmentError），
     ②失败记 contentError 但仍回退到 PIM_CONTENT。 */
  async function fetchNoticeContent(rid) {
    // ③ 附件列表：只依赖 rid，立刻发，让它和①③并行跑。
    let attachmentError = "";
    const affixTask = tide.http.fetch(state.sid, "POST", PORTAL + "/tp_up/up/pim/showpim/getPimAffixList", {
      headers: { "Content-Type": "application/json;charset=utf-8", "Referer": referer(), "Cookie": "tp_up=" + state.token },
      body: JSON.stringify({ RESOURCE_ID: rid }),
    }).then((ares) => {
      if (ares.status !== 200) throw new Error(`附件列表接口 HTTP ${ares.status}`);
      const list = JSON.parse(ares.body);
      if (!Array.isArray(list)) throw new Error("附件列表格式异常或会话已过期");
      return list;
    }).catch((e) => { attachmentError = String(e?.message || e); return []; });

    // ① 详情
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
    let text = d.PIM_CONTENT || "", contentData = null, contentError = "";
    const cu = d.CONTENT_URL || "";
    // ② 正文页：与 ③ 并行收。正文页抛错要落成 contentError（不能把整条拖下水），
    // 所以先包一层结果对象，别让 Promise.all 直接 reject。
    const pageTask = cu
      ? getPage(portalUrl(cu), false, { headers: { "Referer": referer(), "Cookie": "tp_up=" + state.token } })
        .then((cres) => ({ cres }), (e) => ({ error: e }))
      : Promise.resolve(null);
    const [pageGot, affixes] = await Promise.all([pageTask, affixTask]);
    if (pageGot) {
      try {
        if (pageGot.error) throw pageGot.error;
        const cres = pageGot.cres;
        if (cres.status !== 200) throw new Error(`正文接口 HTTP ${cres.status}`);
        const mm = cres.body.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
        let obj;
        try { obj = JSON.parse(mm ? mm[1] : cres.body); contentData = obj; text = obj.result || obj.content || text; }
        catch { text = cres.body; }
      } catch (e) { contentError = String(e?.message || e); }
    }
    return {
      content: cleanText(text) || cleanText(d.PIM_CONTENT),
      attachments: extractAttachments([arr, contentData, affixes], text),
      contentError, attachmentError,
    };
  }

  async function loadDetail(rid, force = false) {
    const cur = state.details[rid] || {};
    if (cur.loading || (!force && (cur.detailVersion === 2 || (!state.token && (cur.content || cur.attachments))))) return;
    state.details[rid] = { ...cur, loading: true };
    updateDetail(rid);
    try {
      const got = await fetchNoticeContent(rid);
      state.details[rid] = { ...got, detailVersion: got.contentError || got.attachmentError ? 0 : 2 };
      await saveNoticeCache();
    } catch (e) {
      state.details[rid] = { error: String(e.message || e) };
    }
    updateDetail(rid);
  }

  /**
   * 落盘横幅：整卡可点，点一下就在系统文件管理器里定位到刚存下的那个文件
   * （Windows 会直接选中它）。
   *
   * 为什么不加一颗按钮：这种横幅只有一个去处，按钮会把一条长路径的正文挤窄。
   * Android 没有「在文件夹里选中文件」这回事，宿主如实报错 —— 那就退化成把路径
   * 再摊开一次，横幅上本来就写着完整路径，用户照样能自己找过去。
   */
  function notifySaved(msg, path) {
    tide.notify(msg, {
      ms: 8000,
      onClickHint: "点击定位文件",
      onClick: () => {
        tide.assets.revealSaved(path).catch((e) => {
          tide.notify(`请手动到下载目录查看：${path}（${String(e?.message || e)}）`, { ms: 10000 });
        });
      },
    });
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
      notifySaved(`已保存到下载目录：${path}`, path);
    } catch (e) {
      tide.notify(`「${name}」下载失败：${explainHttpError(e)}`);
    }
  }

  /* ── 过滤与渲染 ── */
  function filtered() {
    const kw = state.filter.kw.trim().toLowerCase();
    const rows = state.notices.filter((it) => {
      if (state.filter.year !== "all" && !monthOf(it).startsWith(state.filter.year)) return false;
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

  /* 「登录失败 / 拉取失败」的横幅统一走这里（v0.190.0）：整条就是一个刷新入口，
     点一下等于工具栏「刷新」——重拉该视图的全部数据。文案右端自带「点击刷新」，不靠用户猜。
     用真 <button> 而不是给 div 挂 click：Tab 能聚焦、Enter / Space 能触发、读屏会念成按钮名。
     action 由调用方给：教务视图 data-jw-banner-refresh、通知视图 data-banner-refresh、一卡通 data-card-refresh。 */
  function bannerRefreshHtml(text, action) {
    return `<button type="button" class="pp-banner pp-banner-act" data-${action}><span class="pp-banner-txt">${esc(text)}</span><span class="pp-banner-act-hint">点击刷新</span></button>`;
  }
  function paintStatus() {
    if (!ui) return;
    if (state.fetching && !state.notices.length) { ui.status.innerHTML = "正在拉取通知…"; return; }
    // 登录 / 拉取失败的整条状态行就是刷新入口，点一下重跑 loadPage(1)
    if (state.error) { ui.status.innerHTML = bannerRefreshHtml(state.error, "banner-refresh"); return; }
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
    // 年份行：月份选项只来自已加载的数据，没有年粒度就筛不了「某一年全年」
    const yearIds = [...new Set(state.notices.map(monthOf).filter((mo) => mo !== "unknown").map((mo) => mo.slice(0, 4)))].sort().reverse();
    ui.years?.replaceChildren(...[{ id: "all", label: "全部" }, ...yearIds.map((y) => ({ id: y, label: `${y}年` }))].map((c) => {
      const b = document.createElement("button");
      b.className = "pp-chip" + (state.filter.year === c.id ? " on" : "");
      b.textContent = c.label;
      b.addEventListener("click", () => {
        state.filter.year = c.id;
        // 切年份后已选月份若不属于该年份，一并清掉，避免「2025年 + 2026年9月」这种永远为空的组合
        if (state.filter.month !== "all" && !state.filter.month.startsWith(c.id)) state.filter.month = "all";
        saveFilter(); paintChips(); paintList(true);
      });
      return b;
    }));
    const months = [...new Set(state.notices.map(monthOf))]
      .filter((mo) => mo !== "unknown" && (state.filter.year === "all" || mo.startsWith(state.filter.year)))
      .sort().reverse();
    ui.months.replaceChildren(...[{ id: "all", label: "全部" }, ...months.map((mo) => ({ id: mo, label: monthLabel(mo) }))].map((c) => {
      const b = document.createElement("button");
      b.className = "pp-chip" + (state.filter.month === c.id ? " on" : "");
      b.textContent = c.label;
      b.addEventListener("click", () => { state.filter.month = c.id; saveFilter(); paintChips(); paintList(true); });
      return b;
    }));
    ui.filterSummary.textContent = `筛选${state.filter.kind !== "all" || state.filter.year !== "all" || state.filter.month !== "all" || state.filter.hideSeen ? " · 已设置" : ""}`;
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
      const kwActive = !!state.filter.kw.trim();
      const filteredAny = state.filter.kind !== "all" || state.filter.year !== "all" || state.filter.month !== "all" || state.filter.hideSeen || kwActive;
      ui.list.innerHTML = `<div class="pp-empty">${state.notices.length
        ? (kwActive
            ? `关键词「${esc(state.filter.kw.trim())}」没有匹配的通知${filteredAny ? "（叠加了其他筛选）" : ""}`
            : "没有符合过滤条件的通知")
          + "<br>试试调整筛选条件，或点下面的「恢复默认筛选」"
        : state.error ? "" : "还没有通知，点上方「刷新」拉取"}</div>`;
      // 空态也要能自救：没加载完就继续往回拉到出现匹配，别把老数据锁死在分页后面
      if (state.notices.length) {
        const row = document.createElement("div");
        row.className = "pp-more";
        if (state.hasMore) {
          const b = document.createElement("button");
          b.className = "pp-btn";
          b.textContent = state.fetching ? "正在加载更早的通知…" : "加载更早的通知再筛";
          b.addEventListener("click", () => { if (token === paintToken) loadOlderUntilMatch(); });
          row.append(b);
        }
        const r = document.createElement("button");
        r.className = "pp-btn";
        r.textContent = "恢复默认筛选";
        r.addEventListener("click", () => { if (token === paintToken) resetFilter(); });
        row.append(r);
        ui.list.append(row);
      }
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
      + `<div class="pp-side-note">标题与图标自动识别<br>点一下打开对应服务</div>`
      + `</div>`;
  }
  // 收起/展开开关。做成 .pp-shell 的 flex 子项而不是浮层：永不压住正文，收起时天然落在左上角；
  // 展开时同一个元素被 CSS 平移到侧栏头部那一格 —— 于是「竖排 ⇄ 横排」就是这个按钮本身摊开的动画。
  // 竖排刻意不用 writing-mode：那属性不参与过渡，一改就整段跳变（旧实现就是这个观感）。
  // 四个字各占一个 span，靠 translate 换坐标，位移可插值，所以是连续变形。
  // data-motion="off"：退出主程序的通用按钮反馈（motion.js 不再挂 .motion-ripple-host）。
  //   那条 `button.motion-ripple-host:not(…)`（0,3,1）会补 position:relative / overflow:clip，
  //   一挂上就把这里的 sticky 与 top 打回相对位移，把手凭空下移 16px 且不再钉住 —— 点一次就变样。
  const SIDE_LABEL_CHARS = ["校", "园", "服", "务"];
  function sideToggleHtml() {
    const open = !!state.sideOpen;
    const tip = `${open ? "收起" : "展开"}校园服务`;
    const chars = SIDE_LABEL_CHARS.map((ch) => `<span class="pp-side-toggle-ch" aria-hidden="true">${ch}</span>`).join("");
    return `<button type="button" class="pp-side-toggle" data-side-toggle data-motion="off" aria-expanded="${open ? "true" : "false"}" `
      + `title="${tip}" aria-label="${tip}"><span class="pp-side-toggle-arrow" aria-hidden="true">▸</span>${chars}</button>`;
  }
  function sideShellClass() { return state.sideOpen ? "pp-shell" : "pp-shell side-collapsed"; }
  function applySideOpen(root, open) {
    state.sideOpen = !!open;
    const shell = root && root.querySelector ? root.querySelector(".pp-shell") : null;
    if (shell) shell.classList.toggle("side-collapsed", !state.sideOpen);
    const btns = root && root.querySelectorAll ? root.querySelectorAll("[data-side-toggle]") : [];
    for (const b of btns) {
      b.setAttribute("aria-expanded", state.sideOpen ? "true" : "false");
      // 箭头方向是 CSS 旋转做出来的，这里只需就地改提示文案。绝不能重渲染 DOM：
      // 换了节点，CSS 过渡就从第一帧重新开始，用户看到的是直接跳到位。
      if (!b.classList.contains("pp-side-toggle")) continue;
      const tip = state.sideOpen ? "收起校园服务" : "展开校园服务";
      b.title = tip;
      b.setAttribute("aria-label", tip);
    }
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
    if (url === MAIL_WEB) { await openMailWeb(btn); return; }
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

  /* ── 学生个人成长中心（pdata.cppu.edu.cn）鉴权 ──
     它和门户 / 教务不是一套东西：pdata 是独立 SPA，自带一份 CAS 客户端
     （settings.js 里 casPrefixUrl = https://sso.cppu.edu.cn/tpass、casType=1），
     登录成功后**不发会话 Cookie**，而是把 token 放进每个 /tsa/** 请求的
     `Authentication` 头里（见站点 services 层）。

     但它和「警大通知」共用同一套统一身份认证：同一个 sso.cppu.edu.cn、同一份账号密码。
     所以登录态是互通的 —— 本插件登录成功留下的 CASTGC 就是 pdata 换票的凭据，
     反过来 pdata 换票也只消费主 SSO 的票，不会动门户会话。

     链路（三步都必须在本插件的会话里走，Rust 侧发起，不受 CORS 限制）：
       ⓪ 先把「警大通知」存进密钥库的会话票据灌回本会话（restoreCookies）——
          这一步以前缺了，于是冷启动直接打开成长中心/一卡通时永远换不到票；
       ① 用主 SSO 的 CASTGC 换一张一次性 ticket
          （service 就是裸开 /stu/home/ 时 302 里的那个，即 https://pdata.cppu.edu.cn/stu/home/）；
          followRedirects:false —— 只看 Location，绝不把票消费掉；
       ② 拿 ticket 打 /tsa/validateLogin?ticket=..&service=..（SPA 自己就是这么登的），
          **这一步才消费 ticket**，回 {code:2000, data:{token, userId, ...}}。

     ① 失败 ⇒ 主 SSO 的 CASTGC 也没了，就用通知里存的那份账号密码自动登一次（同一份凭据，
     用户不需要再输一遍），登完再回到 ①。整条链都失败才提示「请先在警大通知里登录一次」。

     token 只进 vault（和教务密码同一把锁），不进 storage、不进日志、不写进 DOM。
     失效时由 pdataApi 自己清掉重走一遍，用户不需要做任何事。 */
  const PDATA_VAULT_KEY = "pdataToken";
  let pdataAuth = { token: "", userId: "", at: 0 };
  let pdataAuthPending = null;
  let pdataAuthGeneration = 0;

  /* ── pdata 取数缓存（v0.236.0：把「切走再切回」这条最常走的路变成 0 次网络） ────
     「学生成长」一次进页面并发打 8 个接口，而它和个人信息在侧栏里是来回切的常客 ——
     原来每次 render 都从零重打一遍，用户看到的就是「每次进去都在转圈」。

     这一层刻意做成 pdataApi 的**包装**，而不是它的内部逻辑：
       · 并发去重：两个视图同一时刻要 personInfo 时只发一次请求。
       · 短 TTL：TTL 内重进直接吃内存；用户按「刷新」走 force 绕开。

     为什么不动 pdataApi：它是唯一的事实出口（URL 口径不带 _USER 有回归测试钉着），
     而 test-cppu-pdata-login 要求「同一个 path 第二次被问到时必须重新问服务端」——
     把缓存塞进去会把那条断言变成假绿。挂在外面，那份测试完全碰不到。

     只缓存成功：失败 / 未登录的响应一律不落缓存 —— 否则一次网络抖动会被记住一整个
     TTL，用户点几次刷新都是「读不到」，比不快更糟。 */
  const PDATA_TTL = 60 * 1000;
  // 这两样在一节课的时间里不会变：模块清单是静态导航，personInfo 是档案。
  const PDATA_TTL_STATIC = 10 * 60 * 1000;
  const PDATA_STATIC_RE = /getModuleList|personInfo/;
  const pdataCache = new Map();
  const pdataPending = new Map();

  /** 缓存键：调用方用 `?t=<时间戳>` 防缓存（getModuleList 就带着），不剔掉永远不命中。 */
  function pdataCacheKey(path) {
    return String(path || "")
      .replace(/([?&])(?:t|_t|_)=[^&]*(?=&|$)/g, "$1")
      .replace(/\?&/, "?")
      .replace(/[?&]+$/, "");
  }
  function pdataCacheTtl(path) {
    return PDATA_STATIC_RE.test(String(path || "")) ? PDATA_TTL_STATIC : PDATA_TTL;
  }
  /** 票据换了人（重登 / 换账号 / 清凭据）⇒ 手上这份数据可能属于上一个人，整层作废。 */
  function dropPdataCache() { pdataCache.clear(); }

  /** 学生端 CAS 要票：pdata 的 CAS 就是 sso.cppu.edu.cn，没有 sso-jw 那一跳。 */
  function mintPdataTicket(entry) {
    const url = SSO + "/tpass/login?service=" + encodeURIComponent(entry.service);
    return getPage(url, false, { followRedirects: false })
      .then((res) => redirectTarget(res, url, entry.origin, entry.path))
      .catch(() => "");
  }

  async function loadPdataAuth() {
    if (pdataAuth.token) return pdataAuth;
    const epoch = authEpoch, generation = pdataAuthGeneration;
    const current = () => authCurrent(epoch) && generation === pdataAuthGeneration;
    try {
      await authStorage(async () => {
        if (!current() || state.autoLogin === false) return;
        if (pdataAuth.token) return; // 并发读取合流后保留首份对象，避免重建对象使取数方误判身份已变。
        // 此入口可能早于偏好水合；关闭自动登录后不能用默认 true 恢复磁盘票据。
        if (await tide.storage.get("autoLogin", true) === false || !current()) return;
        const username = state.username || (await tide.storage.get("username", "")) || "";
        const raw = await tide.vault?.get?.(PDATA_VAULT_KEY);
        const saved = raw ? JSON.parse(raw) : null;
        if (!current() || !state.autoLogin || (state.username && state.username !== username)) return;
        if (saved?.username && username && saved.username !== username) return;
        // 旧记录没有 username，沿用现有凭据；下一次换票成功时补齐账号绑定。
        if (saved?.token) pdataAuth = { token: String(saved.token), userId: String(saved.userId || ""), at: Number(saved.at) || 0 };
      });
    } catch { /* 密钥库不可用（浏览器调试）时按无票据处理 */ }
    return pdataAuth;
  }

  /** 丢掉手上的 pdata 票。门户换了人（重新登录）或用户清了凭据时都要走一遍。 */
  async function dropPdataAuth() {
    pdataAuthGeneration++;
    pdataAuthPending = null;
    pdataAuth = { token: "", userId: "", at: 0 };
    dropPdataCache();
    try { await authStorage(() => tide.vault?.del?.(PDATA_VAULT_KEY)); } catch { /* ignore */ }
  }

  /** 门户会话刚被（重新）建立：手上的 pdata 票不再可信，下次取数重新换。
      同步、不 await —— 它挂在 finishPortalTicket 的热路径上，不能拖慢登录。 */
  function forgetPdataAuth() {
    pdataAuthGeneration++;
    pdataAuthPending = null;
    pdataAuth = { token: "", userId: "", at: 0 };
    dropPdataCache();
    authStorage(() => tide.vault?.del?.(PDATA_VAULT_KEY)).catch(() => {});
  }

  /* 凭据只在 loadPrefs 里读一次，而成长中心/一卡通可能比通知界面先被打开
     （侧栏直接点进去就是这条路径）。这里只补登录相关的三项，
     不碰筛选、已读等界面状态 —— 那些由 loadPrefs 在通知界面里负责。 */
  let loginPrefsReady = null;
  function ensureLoginPrefs() {
    if (authClearing) return Promise.resolve();
    if (loginPrefsReady) return loginPrefsReady;
    loginPrefsReady = (async () => {
      const epoch = authEpoch;
      try {
        const username = state.username || (await tide.storage.get("username", "")) || "";
        const autoLogin = await tide.storage.get("autoLogin", true) !== false;
        if (!authCurrent(epoch)) return;
        state.username = username;
        state.autoLogin = autoLogin;
        if (!autoLogin) state.savedPassword = "";
        if (state.autoLogin && !state.savedPassword && typeof tide.vault?.get === "function") {
          const secret = JSON.parse((await tide.vault.get("secret")) || "null");
          if (authCurrent(epoch, username) && state.autoLogin) state.savedPassword = savedPasswordFor(secret, username);
        }
      } catch { /* 读不到就按「没存过凭据」处理，退回人工登录 */ }
      // 没读到凭据就不缓存：用户很可能先去通知里登一次再回来，那时必须重新读一遍。
      if (!state.username || !state.savedPassword) loginPrefsReady = null;
    })();
    return loginPrefsReady;
  }

  /** ①② 共用的那一步：换票 → 消费票 → 落库。成功返回 true。 */
  async function exchangePdataToken() {
    const epoch = authEpoch, generation = pdataAuthGeneration, username = state.username;
    const current = () => authCurrent(epoch, username) && generation === pdataAuthGeneration;
    const service = PDATA + PDATA_HOME;
    const ticket = await mintPdataTicket({ service, origin: PDATA, path: PDATA_HOME });
    // 换不到票 ⇒ 本插件的统一身份认证会话不在（没勾「5天内自动登录」，或已过期）。
    if (!ticket || !current()) return false;
    let raw = "";
    try { raw = new URL(ticket).searchParams.get("ticket") || ""; } catch { raw = ""; }
    if (!raw) return false;
    const res = await getPage(PDATA + "/tsa/validateLogin?ticket=" + encodeURIComponent(raw) + "&service=" + encodeURIComponent(service));
    if (!current()) return false;
    const body = JSON.parse(String(res?.body || ""));
    if (Number(body?.code) !== 2000 || !body?.data?.token) return false;
    pdataAuth = { token: String(body.data.token), userId: String(body.data.userId || ""), at: Date.now() };
    const auth = pdataAuth;
    try {
      await authStorage(async () => {
        if (current() && state.autoLogin && pdataAuth === auth) {
          await tide.vault?.set?.(PDATA_VAULT_KEY, JSON.stringify({ username, ...auth }));
        }
      });
    } catch { /* 密钥库不可用时仍可使用本次内存会话 */ }
    if (!current()) return false;
    saveCookies().catch(() => {});
    return true;
  }

  /** force=true：丢掉手上的 token 重新走一遍（用户点「重新登录」/ 服务端说 token 过期）。 */
  async function ensurePdataAuth(force = false) {
    const epoch = authEpoch;
    const empty = () => ({ token: "", userId: "", at: 0 });
    if (force) await dropPdataAuth();
    else await loadPdataAuth();
    if (!authCurrent(epoch)) return empty();
    // 手上有票也要有会话 —— token 是从密钥库读出来的，可这条通道之外没人建过 session：
    // 少了这一步，下面的 getPage / openPdataLink 都会拿着 sid=null 出门。
    if (pdataAuth.token) {
      const auth = pdataAuth;
      await ensureSid();
      return authCurrent(epoch) && pdataAuth === auth ? auth : empty();
    }
    // 同一时刻只允许有一次换票在飞：七个接口并发拉的时候不能各换一次。
    if (pdataAuthPending) return pdataAuthPending;
    const pending = (async () => {
      try {
        await ensureLoginPrefs();
        if (!authCurrent(epoch)) return empty();
        // ⓪ 复用「警大通知」留下的登录态：CASTGC / tp_up 都在密钥库里，先灌回本会话。
        await restoreCookies();
        if (!authCurrent(epoch)) return empty();
        await newSession();
        if (!authCurrent(epoch)) return empty();
        if (await exchangePdataToken()) return pdataAuth;
        if (!authCurrent(epoch)) return empty();
        // ① CASTGC 还在、门户票据过期：静默续期一次，不碰验证码。
        if (await silentRenew()) {
          if (!authCurrent(epoch)) return empty();
          await saveCookies();
          if (!authCurrent(epoch)) return empty();
          if (await exchangePdataToken()) return pdataAuth;
        }
        if (!authCurrent(epoch)) return empty();
        // ② 主 SSO 也没了：用通知里存的那份账号密码自动登一次（含验证码识别），
        //    成功后主 SSO 的 CASTGC 就有了，再换 pdata 的票。
        if (await passwordAutoLogin()) {
          if (!authCurrent(epoch)) return empty();
          await saveCookies();
          if (!authCurrent(epoch)) return empty();
          if (await exchangePdataToken()) return pdataAuth;
        }
        return authCurrent(epoch) ? pdataAuth : empty();
      } catch {
        return authCurrent(epoch) ? pdataAuth : empty();
      }
    })();
    pdataAuthPending = pending;
    try { return await pending; }
    finally { if (pdataAuthPending === pending) pdataAuthPending = null; }
  }

  /* pdata 统一取数。学生端【绝不能带 _USER】—— 实测（2026-10）服务端按 Authentication
     里的身份认人；URL 上再挂一个 _USER，它就拿这个值去当筛选条件，命中空集：
       personInfo / getKpiList / getModuleList / gradePointRanking / learningGap /
       getFormListByCatalogId 带 _USER 时分别返回 code:-1 或 code:2000 + data:[]，
       去掉后同一 token 立刻拿到真数据（排名 6519/622/145/30、学分 218/59.6）。
     v0.220.1 前这里拼的是 `_USER=<userId>`，所以「学生个人成长中心」视图长期半瘫。 */
  async function pdataApi(path, retried = false) {
    const auth = await ensurePdataAuth();
    if (!auth.token) {
      return { ok: false, code: 0, status: 0, auth: true, data: null,
        message: "自动登录没成功：请先在「警大通知」里登录一次（两边共用同一份账号密码），再回到本页刷新" };
    }
    const url = PDATA + path;
    let res = null;
    try {
      res = await getPage(url, false, { headers: { Authentication: auth.token, "Content-Type": "application/json;charset=utf-8" } });
    } catch (e) {
      return { ok: false, code: 0, status: 0, auth: false, data: null, message: String(e?.message || e) };
    }
    let body = null;
    try { body = JSON.parse(String(res?.body || "")); } catch { body = null; }
    if (body && Number(body.code) === 2000) return { ok: true, code: 2000, status: res.status, auth: false, message: "", data: body.data };
    // 不是 2000、又没解析出 JSON：多半是 token 过期落回了登录页，清掉重换一次票再来。
    if (!retried && (!body || [401, 1001, 4001].includes(Number(body?.code)))) {
      await ensurePdataAuth(true);
      return pdataApi(path, true);
    }
    const msg = String(body?.message || body?.msg || "").trim();
    return { ok: false, code: Number(body?.code) || 0, status: Number(res?.status) || 0, auth: !body, data: null,
      message: msg || `个人成长中心返回 ${res?.status || "未知响应"}` };
  }

  /** 带缓存与并发去重的取数：两个视图都走这里。`force` = 用户明确要求重新取。 */
  async function pdataCached(path, force = false) {
    const key = pdataCacheKey(path);
    if (!force) {
      const hit = pdataCache.get(key);
      if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
      const flying = pdataPending.get(key);
      if (flying) return flying;
    }
    const task = pdataApi(path)
      .then((res) => {
        if (res && res.ok) pdataCache.set(key, { at: Date.now(), ttl: pdataCacheTtl(path), value: res });
        return res;
      })
      .finally(() => { if (pdataPending.get(key) === task) pdataPending.delete(key); });
    pdataPending.set(key, task);
    return task;
  }

  /* 开 pdata 的某个页面：先确保本会话有统一身份认证的票据，再把这份会话的 Cookie
     交给应用内网页窗口（宿主 openPdataPage 注入 sso + pdata 两个域），
     窗口里的 SPA 自己跑一次 validateLogin 就完成免登 —— 它必须自己跑，
     把换来的票交给我们反而没人消费。换不到票据时退回裸链接（会落到统一身份认证登录页），
     入口不能点了没反应。 */
  async function openPdataLink(path) {
    let url = PDATA + PDATA_HOME;
    try {
      const target = new URL(path || PDATA_HOME, PDATA + "/");
      // path 是调用方给的：绝对外链在这里就折回首页，别让它把本插件的会话带去别处。
      if (target.origin === PDATA) url = target.href;
    } catch { /* 退回首页 */ }
    await ensurePdataAuth();
    if (state.sid && typeof tide.util?.openPdataPage === "function") {
      try { await tide.util.openPdataPage(url, state.sid); return; } catch { /* 退回裸开 */ }
    }
    tide.util.openUrl(url);
  }

  /* profile.js 只认这几件事：取数（可强制绕缓存）、开网页、重登。
     SSO 会话与 token 不出本文件。 */
  const growthBridge = {
    api: (path) => pdataCached(path),
    // 「刷新」走这条：主进程那份缓存也要绕过去，否则用户按了刷新还是旧数据。
    force: (path) => pdataCached(path, true),
    open: (path) => openPdataLink(path),
    // "ok"  = 换到票了，可以重新取数（含「用通知那份账号密码自动登一次」这条兜底）；
    // "form" = 整条链都没换到 ⇒ 得先去「警大通知」人工登一次。
    relogin: async () => {
      await ensurePdataAuth(true);
      return pdataAuth.token ? "ok" : "form";
    },
  };

  /* 从任意「含 sid 的文本 / URL」里抠出 sid。落地页把 sid 塞在 redirect?l=… 的
     编码参数里（sid%3D…），中间件换回来的 main.jsp 则是普通查询参数，两种都收。 */
  function mailSidFrom(text) {
    const t = String(text || "").replace(/&amp;/g, "&");
    const m = t.match(/[?&;]sid=([^&#"'<>\s]+)/i) || t.match(/sid%3D([^%&"'<>\s]+)/i);
    if (!m) return "";
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }

  /* 纯 JS 的 RSA/PKCS#1 v1.5 加密（BigInt 现算模幂，不引第三方库）：
     公钥是中间件 /sync/mail/pubkey 给的 SPKI（hex），内层 RSAPublicKey 的
     模长 128 字节、指数固定 65537。PS 段必须是**非零随机字节**（type 2 加密）——
     写成 0xFF 就成了签名用的 type 1，服务端解出来一定报密码错。 */
  function mailRsaEscape(pubHex, text) {
    const hex = String(pubHex || "");
    const at = hex.toLowerCase().indexOf("02818100");
    if (at < 0) throw new Error("邮箱公钥结构不认识");
    const nHex = hex.slice(at + 8, at + 8 + 256);
    const n = BigInt("0x" + nHex);
    const bytes = new TextEncoder().encode(String(text));
    const k = nHex.length / 2;
    if (bytes.length > k - 11) throw new Error("密码太长，邮箱登录不支持");
    const psLen = k - 3 - bytes.length;
    const em = new Uint8Array(k);
    em[0] = 0;
    em[1] = 2;
    const rnd = new Uint8Array(psLen);
    try { crypto.getRandomValues(rnd); } catch { for (let i = 0; i < psLen; i++) rnd[i] = (Math.random() * 255) | 0; }
    for (let i = 0; i < psLen; i++) em[2 + i] = (rnd[i] % 255) + 1;
    em[2 + psLen] = 0;
    em.set(bytes, 3 + psLen);
    let m = 0n;
    for (const b of em) m = (m << 8n) | BigInt(b);
    let c = 1n;
    let base = m % n;
    let exp = 65537n;
    while (exp > 0n) {
      if (exp & 1n) c = (c * base) % n;
      base = (base * base) % n;
      exp >>= 1n;
    }
    const out = new Uint8Array(k);
    let t = c;
    for (let j = k - 1; j >= 0; j--) { out[j] = Number(t & 0xffn); t >>= 8n; }
    let bin = "";
    for (const b of out) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  let mailPubKeyCache = "";
  let mailLoginError = "";
  let mailSession = { sid: "", at: 0 };

  async function mailPublicKey(httpSid) {
    if (mailPubKeyCache) return mailPubKeyCache;
    const res = await tide.http.fetch(httpSid, "GET", MAIL_PUBKEY_API, {
      headers: { "Referer": MAIL, "Accept": "application/json,*/*" },
    });
    // 实测回的是 `pubSetting={"pubKey":"…"}`（jsonp 式赋值，不是纯 JSON），所以取第一个对象。
    const text = String(res?.body || "");
    const json = text.match(/\{[\s\S]*\}/)?.[0] || text;
    let key = "";
    try { key = String(JSON.parse(json)?.pubKey || ""); } catch { key = ""; }
    if (!/^30[0-9a-f]+$/i.test(key)) throw new Error("邮箱公钥取不到（中间件不可达）");
    mailPubKeyCache = key;
    return key;
  }

  /* 中间件登录：成功给 entryhz 的 location，失败给 message（如 input.password.xxx）。
     走 form 编码而不是 JSON —— 网页端就是 $.ajax 的默认表单编码。 */
  async function mailMiddlewareLogin(httpSid, password) {
    const account = mailAccount();
    if (!account) throw new Error("没读到登录学号，请先在「警大通知」里登录一次再打开邮箱");
    const parts = account.split("@");
    const key = await mailPublicKey(httpSid);
    const body = tide.util.web.formEncode({
      accountName: parts[0],
      domain: parts[1] || MAIL_DOMAIN,
      password: mailRsaEscape(key, password),
      language: "zh_CN",
      ch: "",
    });
    const res = await tide.http.fetch(httpSid, "POST", MAIL_LOGIN_API, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": MAIL,
        "Origin": "https://mail.cppu.edu.cn",
        "Accept": "application/json,*/*",
      },
      body,
    });
    let data = null;
    try { data = JSON.parse(String(res?.body || "")); } catch { data = null; }
    if (!data) throw new Error(`邮箱登录失败（中间件返回 HTTP ${Number(res?.status) || 0}）`);
    if (!data.state) {
      const msg = String(data.message || "");
      throw new Error(/password/i.test(msg)
        ? "邮箱登录被拒：账号或密码不对（用的是「警大通知」里保存的那份密码）"
        : `邮箱登录被拒：${msg || "站点没有给出原因"}`);
    }
    return String(data.location || "");
  }

  /* entryhz 的 /entry/door 是 meta-refresh + JS 跳转（不是 HTTP 302），HTTP 客户端
     只会停在那一页，所以要从 body 里把 /redirect?l=… 抠出来再走一步才落到 main.jsp。 */
  async function mailLandingSid(httpSid, entryUrl) {
    let url = String(entryUrl || "").trim();
    if (!url) return "";
    for (let hop = 0; hop < 4 && url; hop++) {
      const res = await tide.http.fetch(httpSid, "GET", url, {
        headers: { "Referer": MAIL, "Accept": "text/html,*/*" },
      });
      const direct = mailSidFrom(res?.finalUrl || "");
      if (direct) return direct;
      const body = String(res?.body || "");
      const next = body.match(/https:\/\/mail\.cppu\.edu\.cn\/redirect\?l=[^"'\s<>]+/i)?.[0]
        || body.match(/href=["']([^"']*main\.jsp\?sid=[^"']+)/i)?.[1];
      if (!next) return mailSidFrom(body);
      url = next.replace(/&amp;/g, "&");
    }
    return "";
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

  /* ── 警大邮箱（Sirius Web）内置网页窗口 ──
     登录走网页端同一条路（RSA 加密密码 → 中间件 → 落地页换 sid），换回来的 sid 缓存
     20 分钟。mbox 接口只认 URL 上的 sid —— 光有 Cookie 会回 FA_INVALID_SESSION。
     会话建不起来（没存密码 / 站点改版 / 密码不对）就退回不带会话的内置窗口，由页面自己登录。 */
  async function ensureMailSession(force = false) {
    if (!force && mailSession.sid && Date.now() - mailSession.at < 20 * 60 * 1000) return mailSession.sid;
    mailSession = { sid: "", at: 0 };
    const password = await readSavedPassword();
    if (!password) { mailLoginError = ""; return ""; }
    const httpSid = await ensureSid();
    if (!httpSid) { mailLoginError = "本机取数会话没建起来，请重启应用后再试一次。"; return ""; }
    let location = "";
    try {
      location = await mailMiddlewareLogin(httpSid, password);
    } catch (e) {
      mailLoginError = String(e?.message || e);
      return "";
    }
    const sid = await mailLandingSid(httpSid, location);
    if (!sid) { mailLoginError = "邮箱登录通过了，但落地页没给出 sid（站点改版？）"; return ""; }
    mailSession = { sid, at: Date.now() };
    mailLoginError = "";
    return sid;
  }

  async function openMailWeb(btn) {
    if (typeof tide.util?.openMailPage !== "function") { tide.util.openUrl(MAIL_WEB); return; }
    if (btn && btn.setAttribute) btn.setAttribute("aria-busy", "1");
    try {
      let sid = "";
      try { sid = await ensureMailSession(); } catch { sid = ""; }
      try {
        await tide.util.openMailPage(MAIL_WEB, sid);
        tide.notify(sid ? "已使用警大通知保存的账号密码打开警大邮箱" : "警大邮箱已在应用内打开，可直接登录");
      } catch (e) {
        // 会话过期 / 注入被拒时别让入口点了没反应：退回不带会话的内置窗口
        if (!sid) { tide.notify(`警大邮箱窗口打开失败：${e?.message || e}`); return; }
        try {
          await tide.util.openMailPage(MAIL_WEB);
          tide.notify(`邮箱登录态注入失败，已打开登录页：${e?.message || e}`);
        } catch (e2) {
          tide.notify(`警大邮箱窗口打开失败：${e2?.message || e2}`);
        }
      }
    } finally {
      if (btn && btn.removeAttribute) btn.removeAttribute("aria-busy");
    }
  }

  /* ── 警大邮箱 · 取数桥 ─────────────────────────────────────────────────────
     自动登录已经由 ensureMailSession() 走完（vault 里的账号密码 → 学校中间件 RSA 登录 →
     落地页换 sid），这里只负责「带着 sid 去读邮件」。

     接口选型（v0.259.1 实测定案）：
     · 老的 XT JSON 变体 → 恒回 {"error_code":"FA_INVALID_SESSION"}，无论 Cookie 多齐全；
     · `/js6/s?func=…`     → 只认 URL 上的 sid，不带的活回 `<code>FA_INVALID_SESSION</code>`；
     所以固定打 `/js6/s` 且**总是**带 sid，回的是 XML。XML 的字段名靠 `name` 属性（见
     mailXmlTree），Content-Type 会谎报，只能看 body 首字符判断 JSON / XML。 */
  const MAIL_PAGE = 20;   // 每页条数（分页取信见 mailLoad；并发去重在 mailPages 里）

  /* 键名大小写不可信（JSON 是 suc/error_code，XML 是 code/var），一律忽略大小写取值。 */
  function mailPick(obj, keys, dflt = "") {
    if (!obj || typeof obj !== "object") return dflt;
    const map = new Map();
    for (const [k, v] of Object.entries(obj)) map.set(String(k).toLowerCase(), v);
    for (const k of keys) {
      const v = map.get(String(k).toLowerCase());
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return dflt;
  }

  /* 端点偶尔回 XML（同一路径，同一个 func）。Coremail 的 XML 用 `name` 属性给每个
     元素命名（`<int name="parent">0</int>`、`<object name="stats">`），标签名本身没有
     信息量，所以按 name 建键、重复键收成数组 —— 摊平后与 JSON 版同形，下游只写一套解析。
     `<array name="var"><object>` 会落成 `{var:{object:[…]}}`，item/folder 就挂在 object 上。 */
  function mailXmlTree(text) {
    try {
      if (typeof DOMParser !== "function") return null;
      const doc = new DOMParser().parseFromString(text, "text/xml");
      if (!doc || doc.querySelector("parsererror") || !doc.documentElement) return null;
      const conv = (node) => {
        const kids = Array.from(node.children || []);
        if (!kids.length) return String(node.textContent || "").trim();
        const out = {};
        for (const ch of kids) {
          let key = String(ch.tagName || "").replace(/^.*:/, "");
          for (const a of Array.from(ch.attributes || [])) if (a.name === "name" && a.value) key = a.value;
          const val = conv(ch);
          if (key in out) out[key] = [].concat(out[key], val);
          else out[key] = val;
        }
        return out;
      };
      return conv(doc.documentElement);
    } catch { return null; }
  }

  function mailIsSessionDead(data) {
    if (!data || typeof data !== "object") return false;
    const code = String(mailPick(data, ["error_code", "errorCode", "code", "error_msg"], "")).toUpperCase();
    const suc = String(mailPick(data, ["suc", "success"], "")).toLowerCase();
    if (/INVALID_SESSION|FA_SESSION|NEED_LOGIN|NOT_LOGIN|AUTH_FAILED/.test(code)) return true;
    return suc === "false" && Boolean(code) && code !== "S_OK";
  }

  /* Inbox 的未读/总数：先看 getAllFolders 里的收件箱那一项，退而取 listMessages 的顶层计数，
     最后才用「取回的这几封自己数」兜底 —— 后者只是让 0 不显示成空白，不代表真实总数。 */
  function mailFolderStat(foldersPayload, listPayload, mails) {
    const folderRoot = foldersPayload && foldersPayload.var && typeof foldersPayload.var === "object" ? foldersPayload.var : foldersPayload;
    let folders = null;
    if (folderRoot && typeof folderRoot === "object") {
      for (const k of ["folder", "folders", "object", "i"]) {
        const v = mailPick(folderRoot, [k], null);
        if (Array.isArray(v)) { folders = v; break; }
        if (v && typeof v === "object") { folders = [v]; break; }
      }
    }
    if (folders) {
      const inbox = folders.find((f) => {
        if (!f || typeof f !== "object") return false;
        const name = String(mailPick(f, ["name", "fullname", "path", "showname"], "")).toLowerCase();
        const id = String(mailPick(f, ["id", "fid"], ""));
        return /收件箱|inbox/.test(name) || id === "1";
      });
      if (inbox) {
        // XML 版把未读/总数塞在 `<object name="stats">` 里，顶层没有这两个字段。
        const stats = mailPick(inbox, ["stats"], null);
        const unread = Number(mailPick(inbox, ["unread", "unreadcount", "newcount", "new"], 0))
          || Number(mailPick(stats, ["unreadmessagecount", "unread", "unreadcount", "newcount"], 0)) || 0;
        const total = Number(mailPick(inbox, ["total", "count", "totalcount", "msgcount"], 0))
          || Number(mailPick(stats, ["messagecount", "count", "total", "msgcount"], 0)) || 0;
        if (unread || total) return { unread, total };
      }
    }
    const listRoot = listPayload && listPayload.var && typeof listPayload.var === "object" ? listPayload.var : listPayload;
    const total = Number(mailPick(listRoot, ["total", "count", "msgcount"], 0)) || 0;
    const unread = Number(mailPick(listRoot, ["unread", "unreadcount", "newcount"], 0)) || 0;
    const rows = Array.isArray(mails) ? mails : [];
    return {
      unread: unread || rows.filter((m) => !m.read).length,
      total: total || rows.length,
    };
  }

  /* 条目挂在哪个键上不可信（var.i / var.message / 顶层 list 都见过），
     字段名同理（subject|subj、from|sender、sentDate|date、id|mid）。
     解析出 0 条不算错误：调用方会把「会话通但没解析出」单独呈现。 */
  function mailItems(payload) {
    const pools = [];
    if (payload && typeof payload === "object") {
      if (payload.var && typeof payload.var === "object") pools.push(payload.var);
      pools.push(payload);
    }
    let arr = null;
    for (const p of pools) {
      // XML 版把条目挂在 `<array name="var"><object>` 上，摊平后键名是 object。
      for (const k of ["i", "message", "messages", "list", "items", "mail", "object"]) {
        const v = mailPick(p, [k], null);
        if (Array.isArray(v)) { arr = v; break; }
        if (v && typeof v === "object") { arr = [v]; break; }
      }
      if (arr) break;
    }
    if (!arr) return [];
    const out = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const flags = mailPick(it, ["flags"], null);
      let flagArr = [];
      let flagsRead = "";
      if (Array.isArray(flags)) flagArr = flags;
      else if (flags && typeof flags === "object") {
        const f = mailPick(flags, ["flag", "flags"], null);
        flagArr = Array.isArray(f) ? f : (f ? [f] : []);
        // XML 的已读标记是 `<boolean name="read">true</boolean>`，摊平后在 flags 里。
        flagsRead = String(mailPick(flags, ["read", "isread", "seen"], "")).toLowerCase();
      }
      const readRaw = String(mailPick(it, ["read", "isread", "seen"], flagsRead)).toLowerCase();
      const read = readRaw === "true" || readRaw === "1" || flagArr.some((f) => /read/i.test(String(f)) && !/unread/i.test(String(f)));
      const id = cleanText(mailPick(it, ["id", "mid", "messageid", "msgid"], ""));
      const subject = cleanText(mailPick(it, ["subject", "subj"], ""));
      // `"某某" <a@b>` 只留显示名。必须在 cleanText 之前匹配 —— cleanText 会把
      // `<a@b>` 当成 HTML 标签剥掉，剩下 `"某某"` 时再匹配就只剩一对引号。
      const fromRaw = String(mailPick(it, ["from", "sender", "fromname", "fromaddr", "sendername"], ""));
      const nameHit = fromRaw.trim().match(/^"?([^"<]+?)"?\s*<([^>\s]+)>$/);
      const from = cleanText(nameHit ? (nameHit[1].trim() || nameHit[2].trim()) : fromRaw)
        .replace(/^["'\s]+|["'\s]+$/g, "");
      const date = mailPick(it, ["sentdate", "receiveddate", "date", "time", "sent"], "");
      const size = Number(mailPick(it, ["size", "bodysize", "msgsize"], 0)) || 0;
      if (!id && !subject && !from) continue;
      out.push({ id: id || subject || from, subject, from, date, size, read });
    }
    return out;
  }

  /* ── 顺序：最新在最前面（v0.268.0）─────────────────────────────────────────
     `mbox:listMessages` 的 start/limit 只说明「取哪一段」，不保证段内顺序（实测有部署按 id
     升序回，最早的那封排在第一条），而这一页要回答的第一个问题就是「最近来了什么信」。
     所以解析完一律自己按时间倒排：时间解析不出来的垫底，彼此保持服务端原序
     （每条带原始下标做稳定排序 —— 同一秒里的几封不会每次刷新互相换位）。 */
  function mailTime(value) {
    const s = String(value ?? "").trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      const ms = n > 1e11 ? n : n * 1000;
      return Number.isFinite(ms) ? ms : null;
    }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    const ms = new Date(s).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  function mailSortNewest(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list
      .map((row, i) => ({ row, i, t: mailTime(row && row.date) }))
      .sort((a, b) => {
        if (a.t === null && b.t === null) return a.i - b.i;
        if (a.t === null) return 1;
        if (b.t === null) return -1;
        return a.t === b.t ? a.i - b.i : b.t - a.t;
      })
      .map((x) => x.row);
  }

  /* ── 验证码（v0.268.0）────────────────────────────────────────────────────
     用户要的是「后台收到验证码就进剪贴板」。分三步，缺一步都是噪音：
     ① 先认这封信有没有「验证码」的意思（中英文都认）；
     ② 再认它旁边那串码 —— 关键词后 48 / 前 40 个字符里找 4~8 位数字，或带数字的
        5~8 位字母数字混合串（大写化）。年份（19xx / 20xx）与纯字母词都不算；
     ③ 只复制「刚收到」的：15 分钟内。旧信里的码进剪贴板只会污染用户下一次粘贴。
     同一封只复制一次（已处理 id 落 storage，留 200 条）；开关关掉就完全不动。
     时间解析不出来的信不自动复制 —— 判断不了新旧，就不替用户往剪贴板写东西。 */
  const MAIL_CODE_SEEN = "mailCodeSeen";
  const MAIL_CODE_SEEN_MAX = 200;
  const MAIL_CODE_FRESH_MS = 15 * 60 * 1000;
  const MAIL_BODY_TRIES = 3;
  const MAIL_AUTOCOPY_KEY = "mailAutoCopy";
  const MAIL_PAGE_MAX = 200;
  const MAIL_WATCH_PAGE = 10;
  const MAIL_WATCH_DELAY_MS = 20 * 1000;
  const MAIL_WATCH_EVERY_MS = 60 * 1000;

  const MAIL_CODE_HINT = /(验证码|校验码|确认码|动态码|登录码|安全码|短信码|一次性(?:密码|口令)|verification\s*code|security\s*code|verify\s*code|passcode|one[-\s]?time\s*(?:code|password)|\botp\b)/i;
  const MAIL_CODE_AFTER = 48;
  const MAIL_CODE_BEFORE = 40;

  function mailCodeCandidate(zone) {
    const hits = String(zone || "").match(/(?:^|[^0-9A-Za-z])([0-9A-Za-z]{4,8})(?![0-9A-Za-z])/g) || [];
    for (const raw of hits) {
      const v = raw.replace(/^[^0-9A-Za-z]+/, "").replace(/[^0-9A-Za-z]+$/, "");
      if (!v) continue;
      if (/^(?:19|20)\d{2}$/.test(v)) continue;               // 年份不是码
      if (/^\d{4,8}$/.test(v)) return v;                      // 纯数字：4~8 位就是它
      const up = v.toUpperCase();
      // 字母数字混合才是码；纯字母（please / notice）一律当噪点
      if (/^[A-Z0-9]{5,8}$/.test(up) && /\d/.test(up) && /[A-Z]/.test(up)) return up;
    }
    return "";
  }

  function mailCodeOf(text) {
    const raw = String(text ?? "");
    if (!raw) return "";
    const hit = raw.match(MAIL_CODE_HINT);
    if (!hit) return "";
    const at = Number(hit.index) || 0;
    const end = at + hit[0].length;
    const zones = [raw.slice(end, end + MAIL_CODE_AFTER), raw.slice(Math.max(0, at - MAIL_CODE_BEFORE), at)];
    for (const zone of zones) {
      const code = mailCodeCandidate(zone);
      if (code) return code;
    }
    return "";
  }

  async function mailAutoCopyOn() {
    try { return (await tide.storage.get(MAIL_AUTOCOPY_KEY, true)) !== false; } catch { return true; }
  }

  async function mailSeenIds() {
    try {
      const v = await tide.storage.get(MAIL_CODE_SEEN, null);
      return new Set((Array.isArray(v) ? v : []).map((x) => String(x)));
    } catch { return new Set(); }
  }

  async function mailSaveSeen(seen) {
    const ids = Array.from(seen).slice(-MAIL_CODE_SEEN_MAX);
    try { await tide.storage.set(MAIL_CODE_SEEN, ids); } catch { /* 存不下就下一轮再判一次 */ }
  }

  /* 剪贴板：优先 navigator.clipboard（Tauri 的 WebView 是安全上下文）；拿不到就退回
     execCommand 通道。主窗口里用户点了没反应，比「偶尔失败」更糟。 */
  async function copyPlainText(value) {
    const v = String(value ?? "");
    if (!v) return false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(v); return true; }
    } catch { /* 落到 execCommand */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = v;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      ta.style.opacity = "0";
      /* 挂在插件自己的容器里、不挂 document.body：body 直挂的浮层会逃出宿主 .view 的安全区
         （scripts/test-plugin-safe-area.mjs ④ 专门拦这个），而这颗离屏 textarea 本来也不需要。 */
      const host = document.querySelector(".view") || document.documentElement;
      host.append(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch { return false; }
  }

  let mailLastCode = null;   // { code, id, from, subject, at } —— 视图侧「已复制 · 再复制」用

  async function mailCopyCode(hit) {
    if (!hit || !hit.code) return false;
    const ok = await copyPlainText(hit.code);
    mailLastCode = { code: hit.code, id: hit.id || "", from: hit.from || "", subject: hit.subject || "", at: Date.now() };
    try {
      tide.notify(ok
        ? `已复制验证码 ${hit.code}${hit.from ? `（${hit.from}）` : ""}`
        : `收到验证码 ${hit.code}，但没写进剪贴板`);
    } catch { /* 通知失败不影响已经复制好的结果 */ }
    return ok;
  }

  /* 一页信头 → 最多复制一条验证码。bodyText 为空时只认主题 / 发件人（视图首屏走这条快路，
     不为了一封不确定的信再多打一次请求）；后台轮询会给一个读正文的函数，主题里认不出时
     最多试 MAIL_BODY_TRIES 封。 */
  async function mailScanCodes(rows, bodyText) {
    if (!(await mailAutoCopyOn())) return null;
    const seen = await mailSeenIds();
    const now = Date.now();
    let touched = false;
    const fresh = mailSortNewest(rows).filter((row) => {
      const id = String((row && row.id) || "");
      if (!id || seen.has(id)) return false;
      const at = mailTime(row && row.date);
      // 未来 1 分钟内的容差：服务端时钟可能快几十秒。
      return at !== null && now - at <= MAIL_CODE_FRESH_MS && at - now <= 60 * 1000;
    });
    let tried = 0;
    for (const row of fresh) {
      const id = String(row.id);
      let code = mailCodeOf(`${row.subject || ""} ${row.from || ""}`);
      if (!code && typeof bodyText === "function" && tried < MAIL_BODY_TRIES) {
        tried++;
        try { code = mailCodeOf(await bodyText(id)); } catch { code = ""; }
      }
      if (code) {
        seen.add(id);
        await mailSaveSeen(seen);
        return { code, id, from: row.from || "", subject: row.subject || "" };
      }
      // 真读过正文才记「处理过」；只看了主题就记，后台那一轮就再也不会去读正文了。
      if (typeof bodyText === "function") { seen.add(id); touched = true; }
    }
    if (touched) await mailSaveSeen(seen);
    return null;
  }

  /* 正文兜底：这套部署没公开这个 func 的契约，两种写法各试一次；都不认就把 mailBodyApi
     记成 "no"，本次会话不再试 —— 每分钟一次无效请求比「少读一点」更讨厌。 */
  let mailBodyApi = "";

  function mailFlattenText(node, budget = 20000) {
    const parts = [];
    let used = 0;
    const walk = (n, depth) => {
      if (!n || used >= budget || depth > 10) return;
      if (typeof n === "string") { parts.push(n); used += n.length; return; }
      if (typeof n === "number") { parts.push(String(n)); return; }
      if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
      if (typeof n === "object") { for (const v of Object.values(n)) walk(v, depth + 1); }
    };
    walk(node, 0);
    return parts.join("\n");
  }

  async function mailBodyReader(httpSid, mailSid) {
    if (mailBodyApi === "no") return null;
    return async (id) => {
      for (const func of ["mbox:getMessage", "mbox:getMessageBody"]) {
        let got = null;
        try { got = await mailCoremail(httpSid, func, { mbox: "Inbox", id, part: "1" }, mailSid); } catch { continue; }
        if (mailIsSessionDead(got.data)) return "";
        const text = mailFlattenText(got.data ?? got.body);
        if (text.trim()) { mailBodyApi = "ok"; return text; }
      }
      mailBodyApi = "no";
      return "";
    };
  }

  /* 单封正文（v0.269.0）：视图里点一封就地展开，不再非得跳邮箱窗口。
     与 mailBodyReader 的差别是这里要「给人读的那一段」——优先取 content（HTML）用
     cleanText 摊成带换行的纯文本；拿不到再退回整棵响应。结果按 id 缓存 30 条：
     列表里来回展开同一封信不该反复打接口。 */
  const mailBodies = new Map();
  const MAIL_BODY_CACHE_MAX = 30;
  const MAIL_BODY_MAX = 60000;   // 6 万字之后只剩签名和免责声明，截断即可

  function mailBodyOf(data) {
    if (!data || typeof data !== "object") return "";
    const box = data.var && typeof data.var === "object" ? data.var : data;
    const html = mailPick(box, ["content", "body", "htmlbody", "bodyhtml", "text"], "");
    const text = typeof html === "string" ? cleanText(html) : "";
    if (text.trim()) return text;
    return mailFlattenText(box, MAIL_BODY_MAX).trim();
  }

  async function mailMessage(id) {
    const key = String(id || "").trim();
    if (!key) return { ok: false, error: "这封信没有 id，读不到正文。" };
    const cached = mailBodies.get(key);
    if (cached) return cached;

    const job = (async () => {
      const httpSid = await ensureSid();
      if (!httpSid) return { ok: false, needLogin: true, error: "本机取数会话没建起来，重启应用后再试一次。" };
      for (let attempt = 0; attempt < 2; attempt++) {
        const mailSid = await ensureMailSession(attempt > 0);
        if (!mailSid) {
          return { ok: false, needLogin: true, error: mailLoginError || "没拿到邮箱登录态 —— 先在「警大通知」里勾上记住密码登录一次。" };
        }
        /* 两路都试：这套部署对 getMessage / getMessageBody 的接受度不一致（同 mailBodyReader）。 */
        for (const func of ["mbox:getMessage", "mbox:getMessageBody"]) {
          let got = null;
          try { got = await mailCoremail(httpSid, func, { mbox: "Inbox", id: key, part: "1" }, mailSid); } catch { continue; }
          if (mailIsSessionDead(got.data)) break;   // 会话失效：跳出 func 循环，外层换票重登
          const text = mailBodyOf(got.data) || cleanText(got.body);
          if (!text.trim()) continue;
          const box = got.data && got.data.var && typeof got.data.var === "object" ? got.data.var : (got.data || {});
          return {
            ok: true,
            id: key,
            text: text.slice(0, MAIL_BODY_MAX),
            truncated: text.length > MAIL_BODY_MAX,
            subject: cleanText(mailPick(box, ["subject", "subj"], "")),
            from: cleanText(mailPick(box, ["from", "sender"], "")),
            date: mailPick(box, ["sentdate", "date"], ""),
          };
        }
      }
      return { ok: false, error: "邮箱接口没回这封信的正文（会话可能是通的，但这个 func 不被接受）。点右上角「在邮箱打开」可以在邮箱窗口里看。" };
    })().then((r) => {
      if (r && r.ok) {
        mailBodies.set(key, r);
        if (mailBodies.size > MAIL_BODY_CACHE_MAX) mailBodies.delete(mailBodies.keys().next().value);
      }
      return r;
    });

    mailBodies.set(key, job);   // 连点同一封只打一次（存的是 Promise，await 之后拿到结果）
    return job;
  }

  /* ── 后台轮询「收到验证码就复制」（v0.268.0）───────────────────────────────
     邮件不是我们推的，只能问。口径取「够快但不吵」：60 秒一轮，只读最新 10 封的信头，
     连续失败自己拉长间隔（最多 8 倍）。闸门与 warmSession 同一套边界：开关开着、
     用户授权过自动登录（vault 里有密码）、上一轮没在飞。没登录态就静默等下一轮 ——
     后台不能弹登录框。 */
  let mailWatchBusy = false, mailWatchMiss = 0, mailWatchRetryAt = 0, mailPrefsReady = false, mailWatchTimer = 0;

  async function mailWatchReady() {
    if (!mailPrefsReady) {
      /* 已经有身份就别再水合一次偏好：loadPrefs 会把 state.username / state.autoLogin 整份
         按 storage 重写，而此刻视图可能正拿着现身份在跑（冷启动前台已读过一次）。
         后台轮询只该问「能不能登录」，不该改动正在用的状态。 */
      if (state.username) {
        mailPrefsReady = true;
      } else {
        try { await loadPrefs(); mailPrefsReady = true; } catch { return false; }
      }
    }
    if (typeof tide.vault?.get !== "function") return false;
    return state.autoLogin !== false && Boolean(state.username);
  }

  async function mailWatchTick() {
    if (typeof window === "undefined") return;
    if (mailWatchBusy) return;
    if (Date.now() < mailWatchRetryAt) return;
    mailWatchBusy = true;
    try {
      if (!(await mailAutoCopyOn())) return;
      if (!(await mailWatchReady())) return;
      const httpSid = await ensureSid();
      if (!httpSid) return;
      const mailSid = await ensureMailSession();
      if (!mailSid) return;                       // 没密码 / 站点要图形码：交给前台那次
      const got = await mailCoremail(httpSid, "mbox:listMessages", { mbox: "Inbox", start: "0", limit: String(MAIL_WATCH_PAGE) }, mailSid);
      if (mailIsSessionDead(got.data)) { await ensureMailSession(true); return; }
      const rows = mailSortNewest(mailItems(got.data));
      mailWatchMiss = 0;
      mailWatchRetryAt = 0;
      if (!rows.length) return;
      const hit = await mailScanCodes(rows, await mailBodyReader(httpSid, mailSid));
      if (hit) await mailCopyCode(hit);
    } catch {
      mailWatchMiss = Math.min(8, mailWatchMiss + 1);
      mailWatchRetryAt = Date.now() + MAIL_WATCH_EVERY_MS * mailWatchMiss;
    } finally {
      mailWatchBusy = false;
    }
  }

  function scheduleMailWatch() {
    if (mailWatchTimer) return;
    if (typeof window === "undefined" || typeof window.setTimeout !== "function") return;
    mailWatchTimer = 1;
    const run = () => { mailWatchTick().catch(() => {}); };
    try {
      window.setTimeout(run, MAIL_WATCH_DELAY_MS);
      if (typeof window.setInterval === "function") window.setInterval(run, MAIL_WATCH_EVERY_MS);
    } catch { /* ignore */ }
  }

  /* mbox 接口：这套部署只认 /js6/s，而且 sid 必须写在 URL 上（Cookie 齐全也不行）。
     老的 XT JSON 变体恒回 FA_INVALID_SESSION，已经弃用。 */
  async function mailCoremail(httpSid, func, params, mailSid) {
    const q = new URLSearchParams({ func, ...(params || {}) });
    if (mailSid) q.set("sid", mailSid);
    const res = await tide.http.fetch(httpSid, "GET", `${MAIL_API}?${q.toString()}`, {
      headers: { "Referer": MAIL, "Accept": "application/xml,application/json,*/*" },
    });
    const raw = String(res?.body || "");
    const body = raw.trim();
    let data = null;
    if (body.startsWith("{") || body.startsWith("[")) {
      try { data = JSON.parse(body); } catch { data = null; }
    }
    if (!data && body.startsWith("<")) data = mailXmlTree(raw);
    return { status: Number(res?.status) || 0, data, body: raw };
  }

  /* 分页取信（v0.268.0）：以前只取 start=0,limit=20 就完事，视图再「显示更多」也只是把
     已经拿到的 20 条拆着显示 —— 第 21 封起永远看不见。现在 start/limit 透传给 mbox 接口，
     一页一页向服务端要；同一页并发只发一次（连点「加载更早」不会打两遍）。 */
  const mailPages = new Map();   // `${start}:${limit}` → Promise

  async function mailLoad(opts) {
    const start = Math.max(0, Number(opts && opts.start) || 0);
    const limit = Math.min(MAIL_PAGE_MAX, Math.max(1, Number(opts && opts.limit) || MAIL_PAGE));
    const key = `${start}:${limit}`;
    const running = mailPages.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        const httpSid = await ensureSid();
        if (!httpSid) return { ok: false, needLogin: true, error: "本机取数会话没建起来，请重启应用后再试一次。" };
        let folders = null;
        let list = null;
        // 两轮：第一轮用缓存 sid，被拒就强制重登再试一次 —— sid 有过期，别让用户手动点。
        for (let attempt = 0; attempt < 2 && !list; attempt++) {
          const mailSid = await ensureMailSession(attempt > 0);
          if (!mailSid) {
            return {
              ok: false, needLogin: true,
              error: mailLoginError || "没拿到邮箱登录态：密钥库里没有可用密码、或站点要求图形/短信验证码。先在「警大通知」里勾选记住密码登录一次，再回本页重试。",
            };
          }
          // 第 2 页起不必再问文件夹统计（未读/总数第一页已经拿到），省一次请求。
          if (start === 0) {
            const got = await mailCoremail(httpSid, "mbox:getAllFolders", {}, mailSid);
            if (mailIsSessionDead(got.data)) continue;
            folders = got;
          }
          const gotList = await mailCoremail(httpSid, "mbox:listMessages", { mbox: "Inbox", start: String(start), limit: String(limit) }, mailSid);
          if (mailIsSessionDead(gotList.data)) { folders = null; continue; }
          list = gotList;
        }
        if (!list) {
          return {
            ok: false, needLogin: true,
            error: "邮箱接口不认这次登录（FA_INVALID_SESSION），重登过一次仍被拒。点「在邮箱窗口里登录」手动登一次，再回本页刷新。",
          };
        }
        const mails = mailSortNewest(mailItems(list.data));
        const out = {
          ok: true,
          account: mailAccount(),
          start,
          limit,
          mails,
          // 满页就当还有下一页；不满页说明到头了。
          hasMore: mails.length >= limit,
          syncedAt: Date.now(),
        };
        if (folders && folders.data) {
          const stat = mailFolderStat(folders.data, list.data, mails);
          out.unread = stat.unread;
          out.total = stat.total;
        }
        // 顺手扫一遍验证码（只认主题，不读正文）：用户点开邮箱时若刚收到码，不必等下一轮轮询。
        mailScanCodes(mails, null)
          .then((hit) => { if (hit) return mailCopyCode(hit); return null; })
          .catch(() => {});
        return out;
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    })().finally(() => { mailPages.delete(key); });
    mailPages.set(key, job);
    return job;
  }

  const mailBridge = {
    load: (opts) => mailLoad(opts),
    body: (id) => mailMessage(id),
    open: () => openMailWeb(null),
    autoCopy: () => mailAutoCopyOn(),
    setAutoCopy: (on) => Promise.resolve(tide.storage.set(MAIL_AUTOCOPY_KEY, Boolean(on))).catch(() => {}),
    lastCode: () => mailLastCode,
    copy: (text) => copyPlainText(text),
  };

  let mailModule = null, mailView = null;
  function mountMailView(el) {
    let disposed = false, teardown = null;
    ensureStyle();
    el.innerHTML = `<div class="${sideShellClass()}"><aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}`
      + `<div class="pp-main"><div data-ml-host><div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在载入邮箱…</div></div></div></div>`;
    bindSide(el);
    loadLinkMeta(el);
    (mailModule || (mailModule = import("/plugins/cppu-notify/mail.js")))
      .then((mod) => {
        if (disposed) return;
        const host = el.querySelector("[data-ml-host]");
        if (!host) return;
        mailView = mailView || mod.createMailView(tide, mailBridge);
        teardown = mailView.render(host);
      })
      .catch(() => {
        mailModule = null;
        const host = el.querySelector("[data-ml-host]");
        if (host && !disposed) host.innerHTML = '<p class="pp-tip" style="padding:24px;text-align:center">邮箱模块加载失败，请重新打开本视图重试</p>';
      });
    return () => { disposed = true; if (typeof teardown === "function") teardown(); };
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
    // 自习室查询（教室占用 / 借用）：nodeInfo 是校方菜单树里的实测值（dev/jw-assets_je_rbac_perm_getMenuTree-post.json
    // 里「学生服务 › 公共服务 › 自习室查询」节点的 nodeInfo=ZXZYCX），不是猜的。
    // ⚠️ funcId / tableCode 刻意留空：这两个值只在教务前端运行时才有（四个 bundle 搜 ZXZYCX 全 0 命中），
    // 运行时由 jwFuncInfo 从 funcInfo 元信息补齐；补不到就老实报错，绝不抄一个像样的 funcId 上去
    // —— 错值在服务端表现为 UNKOWN_ERROR，排查成本远高于直说「没取到」。
    room: { funcCode: "ZXZYCX", funcId: "", tableCode: "" },
    /* 我的考试（v0.272.0）：两块接口都必须硬编码 funcId。
       考试计划 V_JWBZK_KWGL_KS_STU 是 sql 型（要带 dbSql + queryParamsStr），
       考试任务 V_JWBZK_KWGL_KSRW_STU 是 func 型（普通表查询，不带 queryType）。
       两个 funcId 与 tableCode 都是浏览器里抓到的真实请求体里抄的，不是猜的；
       照 room 那条的老规矩：抓不到就留空让元信息补，绝不抄一个像样的值上去。 */
    examPlan: { funcCode: "V_JWBZK_KWGL_KS_STU", funcId: "8doEdJCt9B3MRujeyKo", tableCode: "V_JWBZK_KWGL_KS_STU" },
    examTask: { funcCode: "V_JWBZK_KWGL_KSRW_STU", funcId: "XyTHnkGDVnGOCTQECC6", tableCode: "V_JWBZK_KWGL_KSRW_STU" },
  };
  // 教务里没有「创新成绩」这个菜单，实名叫「成绩查询(学生)」，挂在 创新实践 下面
  const JW_MENU = {
    xk: "学生服务 › 我的课程表 › 我的选课 › 学生选课",
    qj: "学生服务 › 我的课程表 › 我的课表 › 学生请假申请",
    grades: "学生服务 › 我的学业 › 成绩 › 成绩查询",
    cx: "学生服务 › 综合素质考评 › 创新实践 › 成绩查询(学生)",
    room: "学生服务 › 公共服务 › 自习室查询",
    // 菜单树 dump 里「我的考试」节点（orderIndex 2）下只有一个子项「我的考试计划」，
    // nodeInfo / 功能码同为 V_JWBZK_KWGL_KS_STU；「考务管理 › 考试计划管理」下那条
    // 「我的考试计划（学生）」是同一个功能码，指向同一页。
    exam: "学生服务 › 我的考试 › 我的考试计划",
    // 「我的学分」挂在 成绩 下面（菜单树实测：学生服务 › 我的学业 › 成绩 › 我的学分，
    // nodeInfo 与功能码同为 V_JWBZK_XKGL_XKQK）。
    credit: "学生服务 › 我的学业 › 成绩 › 我的学分",
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
  const jwKeyLabel = (k) => ({ xkTask: "选课任务", xkResult: "选课结果", qjRecord: "请假记录", qjCourse: "可请假课次", creditPlan: "培养计划", creditModule: "课程模块进度", credit: "我的学分", grade: "课程成绩", cxCredit: "创新学分", cxDetail: "创新学分明细", room: "自习室", exam: "考试安排", examPlan: "考试计划", examTask: "考试安排" }[k] || k);

  let jwSid = null;                 // 已经落上教务 authorization 的那个会话 id
  const jwLive = () => !!jwSid && jwSid === state.sid;
  let jwBootPromise = null;         // 同时挂两个教务视图时合流，别各跑一遍验证码登录
  /* 一轮「刷新」= 一次 jwEnsureKeys。一个教务视图往往有多个 key（选课 = 选课任务 + 选课结果，
     请假 = 请假记录 + 可请假课次），而 jwEnsureKeys 是串行 for 循环、每个 key 的 jeLoad 都要
     先过一次 ensureJwLogin —— jwBootPromise 只合流「并发」，串行的后一个 key 拿不到合流，
     于是登录态失效时会连着跑 N 轮完整登录（每轮内部还按 loginRetries 重试），
     白刷 N×3 次验证码识别，还把学校侧的登录频次推上去。所以同一轮里登录只判定一次：
     本轮已经判失败，后续 key 直接复用结论，等下一次「刷新」/「重新登录」再重新判定。 */
  let jwRound = 0;                  // 每轮刷新自增，用来作废上一轮的判定
  let jwRoundLoginFailed = -1;      // 本轮登录已经判定失败（-1 = 还没有判定过）

  /* 教务取数前的统一引导：恢复密钥库 Cookie → 换票建教务会话 → 不行就用保存的密码
     走验证码自动识别 → 再换一次票。登录代码全插件只有这一份，从侧栏点进哪个警大
     视图都一样，不需要先绕去「警大通知」手工登录。 */
  function ensureJwLogin(force = false) {
    if (!force && jwLive()) return Promise.resolve(true);
    // 只记忆「失败」不记忆「成功」：记住成功会把 jeLoad 里 ensureJwSession(true) 之后的
    // 兜底登录短路掉，登录态中途失效时错误会退化成「教务数据解析失败」而不是让人去重新登录
    if (jwRoundLoginFailed === jwRound) return Promise.resolve(false);
    if (jwBootPromise) return jwBootPromise;
    const round = jwRound;
    const p = (async () => {
      await loadPrefs();
      if (!state.sid) await restoreCookies();
      if (await ensureJwSession()) return true;
      return await passwordAutoLogin() && await ensureJwSession(true);
    })();
    jwBootPromise = p;
    // 只合流并发、不缓存结果：点「刷新」时该再试一次，别拿着上次的 false 一直不回本
    const clear = () => { if (jwBootPromise === p) jwBootPromise = null; };
    const settle = (ok) => { if (!ok) jwRoundLoginFailed = round; clear(); };
    // p 自己就是「成没成」的布尔：验不出验证码时它 resolve(false) 而不是 reject。
    // 只看 resolve/reject 会把这种失败漏记，后面每个 key 又重跑一轮完整登录（白刷验证码）。
    p.then((ok) => settle(ok !== false), () => settle(false));
    return p;
  }
  const jwState = {
    term: null,
    data: { xkTask: null, xkResult: null, qjRecord: null, qjCourse: null, creditPlan: null, creditModule: null, grade: null, cxCredit: null, cxDetail: null, room: null, pdataStudy: null, exam: null },
    loading: {}, error: {}, at: {},
    courseScope: "week",            // today | week | term，默认本周（本学期是 200+ 行的紧凑列表）
    roomSlot: "all",                // all | 节次码（01…05）：选一个节次就把别的格子调暗，好判断「现在哪间空」
    // 看哪一栋楼："" = 全部（v0.275.0）。学生几乎只在固定几栋楼自习，17 栋一次铺开
    // 要滚三屏才能看到自己那栋 —— 先按楼收窄，再看节次。
    roomBld: "",
    // 看哪一天的自习室："" = 今天（不覆盖 RQ，让服务端用 SYSDATE），否则 "YYYY-MM-DD"。
    // 教务那条 SQL 是 (select ? rq from dual)，RQ 由 FUNCINFO_QUERYPARAM 声明，改 defaultValue
    // 就能查任意一天（实测 2026-10-25 空闲 614/630，今天 332/630，服务端按天换数）。
    roomDate: "",
    roomFilter: "",                 // 自习室关键词过滤（只改 DOM 显隐，不触发重绘 —— 重绘会夺走输入焦点）
    examFilter: "",                 // 考试关键词过滤（同上，只切 [hidden]）
    examOpen: new Set(),            // 手动摊开的考试卡（按考试 ID 记，切学期再切回来还开着）
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
  /* 取不到 rows 有两种完全不同的成因，过去被混成一句「解析失败」：
     ① 教务把我们当没登录 —— 302 回 sso、或干脆吐一整页 HTML；
     ② 服务端听懂了但拒绝 —— 结构化 JSON 里带 UNKOWN_ERROR / code / message（字段定义缺失、
        没权限、表名不对）。② 换票重登一百次结果一样，认成①就会凭空多跑一轮登录，
        横幅于是显示「自动登录失败」——用户看到的是登录坏了，其实是查询配方不对。 */
  const jeJsonOf = (res) => { try { return JSON.parse(String(res?.body || "")); } catch { return null; } };
  const jeNeedsLogin = (res) => {
    const st = Number(res?.status) || 0;
    if (st === 401 || st === 403 || (st >= 300 && st < 400)) return true;
    if (/tpass\/login|cas_callback/i.test(String(res?.finalUrl || res?.location || ""))) return true;
    return /^\s*<(!doctype|html|\?xml)/i.test(String(res?.body || ""));
  };
  const jeBizError = (res) => {
    const j = jeJsonOf(res) || {};
    const why = String(j.message || j.msg || j.error || j.obj || j.code || "").trim();
    return why ? `${why}（HTTP ${res?.status ?? "?"}）` : `HTTP ${res?.status ?? "?"}`;
  };

  // funcType=sql 的功能（如「学员选课」）光给 funcCode 是查不出来的：教务前端会把该功能的
  // 整段 SELECT 从元信息里取出来原样回传，服务端才认（实测漏掉就回 UNKOWN_ERROR）。
  // 视图型功能（V_ 开头那几张）不需要，所以这里按 funcType 条件加，一律不自己拼 SQL。
  const jwFuncMeta = {};
  /* 列定义（v1.73.0）：自习室查询是「校方在后台配列」的网格，前端 bundle 里没有任何字段名
     （je-app / je-main / je-core / url-map 四个包搜 ZXZYCX 全 0 命中），所以中文列名只能从
     funcInfo 的元信息读。正方各部署把列放在不同位置（funcInfo.columns / func.columns /
     func.items 都见过），这里按「有字段码」判；一个都取不到就返回空数组 ——
     渲染层退回用字段码当列名，绝不编一个看着顺眼的中文名。 */
  function jwFuncColumns(j) {
    for (const bag of [j?.funcInfo?.columns, j?.columns, j?.func?.columns, j?.func?.items]) {
      if (!Array.isArray(bag) || !bag.length) continue;
      const cols = bag.map((c) => ({
        code: String(c?.code || c?.fieldCode || c?.dataIndex || c?.columnCode || ""),
        name: String(c?.text || c?.name || c?.title || c?.fieldName || c?.columnName || ""),
      })).filter((c) => c.code);
      if (cols.length) return cols;
    }
    return [];
  }
  /* v1.77.0：这个端点的「正确姿势」在部署之间并不一致。
     正方 7.2.7 的四个前端包里**没有任何调用点**（je-app / je-main / je-core / url-map 搜
     getStaticFuncByCode 只命中字符串本身），说明它只被服务端用过，方法名与参数名没有权威
     答案；同一份部署对 GET / POST、对 funcCode / FUNCINFO_FUNCCODE 的接受度也不保证一样。
     除自习室以外每个功能都有硬编码 funcId 兜底，所以只有它会在这一跳上卡死 ——
     多试几种姿势，哪一路回了 funcId / tableCode 就用哪一路，全都不认才如实报错。
     注意：第一路必须保持原样（POST + FUNCINFO_FUNCCODE），那是真机验证过的形状。 */
  const jwFuncProbes = (f) => [
    { method: "POST", url: JW_FUNC_INFO, form: { refresh: "false", tableCode: "JE_CORE_FUNCINFO", FUNCINFO_FUNCCODE: f.funcCode, perm: "true" } },
    { method: "POST", url: JW_FUNC_INFO, form: { refresh: "false", funcCode: f.funcCode } },
    { method: "GET", url: `${JW_FUNC_INFO}?refresh=false&funcCode=${encodeURIComponent(f.funcCode)}` },
    { method: "GET", url: `${JW_FUNC_INFO}?refresh=false&tableCode=JE_CORE_FUNCINFO&FUNCINFO_FUNCCODE=${encodeURIComponent(f.funcCode)}` },
  ];
  async function jwFuncInfo(key) {
    if (jwFuncMeta[key]) return jwFuncMeta[key];
    const f = JW_FUNC[key];
    let netErr = null;
    for (const probe of jwFuncProbes(f)) {
      let res = null;
      try {
        res = await tide.http.fetch(state.sid, probe.method, probe.url, {
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: JW_INDEX },
          body: probe.form ? tide.util.web.formEncode(probe.form) : "",
        });
      } catch (e) { netErr = e; continue; }   // 这一路非 2xx / 超时不代表别的路不通
      let j = null;
      try { j = JSON.parse(String(res.body || "")); } catch { j = null; }
      const info = j?.funcInfo || {};
      const meta = {
        funcId: String(info.funcId || f.funcId),
        funcType: String(info.funcType || ""),
        dbSql: String(j?.func?.info?.FUNCINFO_SQL || ""),
        // 表名同样以元信息为准：JW_FUNC 里的 tableCode 只是抄下来的常量兜底，
        // 新接入的自习室查询没有常量可抄，漏了这一句 /je/load 一律回 UNKOWN_ERROR。
        tableCode: String(info.tableCode || j?.func?.tableCode || f.tableCode || ""),
        // 加载端点也由元信息决定：教务允许给单个功能配自己的控制器路径，自习室查询就是
        // FUNCINFO_FUNCACTION = "/je/zxcx"。一律打通用 /je/load 时，那个控制器会因为参数
        // 对不上而只回一句「数据加载失败！」，前端再把它当成登录失效（v1.77.1 修的就是这条）。
        funcAction: String(j?.func?.info?.FUNCINFO_FUNCACTION || "").trim(),
        // SQL 里的 ? 占位符要靠 FUNCINFO_QUERYPARAM 的声明回传（自习室那条是
        // [{name:"RQ",defaultValue:"SYSDATE"}]）。漏了就报
        // 「Expected positional parameter count: 1, actual parameters: []」。
        queryParams: String(j?.func?.info?.FUNCINFO_QUERYPARAM || ""),
        columns: jwFuncColumns(j),
      };
      // 回了真元信息才缓存（省掉后续每次多跳）；一个字段都没有说明这一路不对，换下一路
      if (info.funcId || info.tableCode || j?.func?.tableCode || meta.funcAction) {
        jwFuncMeta[key] = meta;
        return meta;
      }
    }
    if (netErr) throw new Error(explainHttpError(netErr));
    const bare = { funcId: f.funcId, funcType: "", dbSql: "", tableCode: f.tableCode || "", funcAction: "", queryParams: "", columns: [] };
    // 有硬编码 funcId 的功能照旧能查；自习室这类「后台配列」的新功能没有常量可抄，
    // 这时必须把话说明白 —— 旧写法让它一路走到 /je/load 回 UNKOWN_ERROR，再被当成
    // 「登录失效」去重登一次，横幅就变成了「自动登录失败」（v1.77.0 修的就是这句假话）。
    if (!bare.funcId && !bare.tableCode) {
      throw new Error(`教务没给出「${jwKeyLabel(key)}」的字段定义：先点「刷新」重试；一直这样就说明这版教务的接口形状变了，插件需要更新`);
    }
    return bare;
  }

  /* 自习室那条 SQL 是 (select ? rq from dual)，占位符的实参由 FUNCINFO_QUERYPARAM 声明
     （[{"name":"RQ","fieldType":"VARCHAR","paramType":"0","defaultValue":"SYSDATE"}]）。
     服务端认的是 defaultValue 这一格：把它换成具体某天就查那天 —— 实测 2026-10-25 回
     空闲 614/630、今天 332/630。换成 {"name","value"} 会被判 JSONObject["fieldType"]
     not found；声明里其他字段一个都不能少，所以这里只改 defaultValue。 */
  function jwQueryParamsForDate(raw, date) {
    if (!date || !raw) return raw;
    let list;
    try { list = JSON.parse(raw); } catch { return raw; }
    if (!Array.isArray(list) || !list.length) return raw;
    const i = list.findIndex((x) => x && (x.name === "RQ" || String(x.defaultValue || "").toUpperCase() === "SYSDATE"));
    if (i < 0) return raw;
    list[i] = { ...list[i], defaultValue: date };
    return JSON.stringify(list);
  }

  async function jeLoad(key, groups = [], opts = {}) {
    const f = JW_FUNC[key];
    if (!f) throw new Error(`未登记的教务功能：${key}`);
    if (!await ensureJwLogin()) throw new Error("警大统一身份认证未建立：请在下方完成登录后重试");
    let meta = await jwFuncInfo(key);
    const post = () => {
      const params = {
        funcCode: f.funcCode, funcId: meta.funcId, columnLazy: "true", mark: "false", postil: "",
        funcEdit: "false", coverJquery: "0", tableCode: meta.tableCode || f.tableCode, _isFunc_: "true",
        j_query: JSON.stringify({ custom: groups, _custom_types: groups.map(() => "group") }),
        j_order: "[]", dbQueryObj: "{}", page: "1", start: "0", limit: "-1",
      };
      if (meta.funcType === "sql" && meta.dbSql) {
        params.queryType = "sql";
        params.dbSql = meta.dbSql;
        // 占位符的实参来自元信息。传空数组会让服务端直接拒绝整条 SQL（自习室那条是
        // 「Expected positional parameter count: 1, actual parameters: []」）。
        params.queryParamsStr = jwQueryParamsForDate(meta.queryParams, opts.date) || "[]";
      }
      // 端点派发：功能配了 FUNCINFO_FUNCACTION 就走「它的路径 + /load」，没配才回落到通用
      // /je/load。教务自己的前端也是这么拼的（自习室 = /je/zxcx/load）。
      const endpoint = meta.funcAction ? JWAPP + meta.funcAction + "/load" : JW_LOAD;
      return tide.http.fetch(state.sid, "POST", endpoint, {
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
      // 业务拒绝（UNKOWN_ERROR / 没权限）不是登录态问题：换票重登只会白跑一轮验证码，
      // 还会把「字段没取到」显示成「自动登录失败」。只有服务端真的把我们当未登录时才重登一次。
      if (!jeNeedsLogin(res)) throw new Error(`教务拒绝了这次查询：${jeBizError(res)}`);
      // 会话过期的表现不是 401，而是 POST 被 302 回登录页、拿回来一整页 HTML
      delete jwFuncMeta[key];
      if (!await ensureJwSession(true) && !await ensureJwLogin(true)) throw new Error("教务登录态已失效，请重新登录");
      meta = await jwFuncInfo(key);
      res = await postThrough();
      rows = jeRowsOf(res);
      if (!rows) {
        throw new Error(jeNeedsLogin(res)
          ? `教务登录态没建立起来（HTTP ${res.status}）：点「刷新」重试一次，仍然这样就点「重新登录」`
          : `教务拒绝了这次查询：${jeBizError(res)}`);
      }
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
      // 取数字段与 cppu-helper v15.0 的 XlFragment 完全一致（同一个 POST /je/system/getNowXnxq → data.values）：
      // JXZQSRQ = 教学第 1 周起始日（第 1 周的周一，周次一律以它为基准）、JXZS = 教学周数、
      // KSRQ = 学期开始日、JSRQ = 学期结束日。v0.216.0 起把 KSRQ / JSRQ 也留下来：
      // 校历的学期起止是官方值，不再只有「起始日 + 周数」推算。
      // 周数用 JXZS（教学周）而不是 XQZS（学期周，含军训/假期）—— 后者会把教学周次算偏。
      if (v.DM) jwState.term = { code: v.DM, name: String(v.MC || v.DM), jxStart: String(v.JXZQSRQ || ""),
        weeks: Number(v.JXZS) || Number(v.XQZS) || 0, termStart: String(v.KSRQ || ""), termEnd: String(v.JSRQ || "") };
    } catch { /* 学期拿不到不阻塞列表：课次视图退化成「不过滤学期」 */ }
    return jwState.term;
  }

  // 校历视图只接收学期边界数据（含官方起止日 KSRQ / JSRQ）；统一身份认证和 Cookie 始终留在本插件。
  tide.events?.on?.("cppu:term-request", (request) => {
    if (!request || typeof request.id !== "string") return;
    const previous = jwState.term;
    loadJwTerm(true).then((term) => {
      tide.events.emit("cppu:term-response", { id: request.id,
        term: term && term !== previous ? { name: term.name, jxStart: term.jxStart, weeks: term.weeks,
          termStart: term.termStart || "", termEnd: term.termEnd || "" } : null,
        error: term === previous ? "本次未能刷新教务学期；请检查警大门户登录" : "教务暂未返回学期信息" });
    }).catch((error) => {
      tide.events.emit("cppu:term-response", { id: request.id, error: String(error?.message || "教务学期暂不可用") });
    });
  });

  async function jwSaveCache() {
    const keep = {};
    for (const k of ["xkTask", "xkResult", "qjRecord", "creditPlan", "creditModule", "grade", "cxCredit", "cxDetail", "room"]) if (Array.isArray(jwState.data[k])) keep[k] = jwState.data[k];
    if (jwState.data.pdataStudy) keep.pdataStudy = jwState.data.pdataStudy;
    // 考试是对象（{plans,current,terms}）不是数组，上面那个循环收不进去，单独存
    if (jwState.data.exam && jwState.data.exam.ok !== false) keep.exam = jwState.data.exam;
    try { await tide.storage.set("jwCache", { username: state.username, term: jwState.term, at: jwState.at, keep, prefs: { creditHideDone: jwState.creditHideDone, roomDate: jwState.roomDate } }); } catch { /* 忽略 */ }
  }
  async function jwRestoreCache() {
    try {
      const c = await tide.storage.get("jwCache", null);
      if (!c || typeof c !== "object" || (c.username != null && c.username !== state.username)) return;
      if (c.term && !jwState.term) jwState.term = c.term;
      jwState.creditHideDone = c.prefs?.creditHideDone === true;
      // 自习室缓存的是「那一天」的行，日期偏好必须一起恢复，否则重开应用会拿别天的数据
      // 顶着今天的日期显示（RQ 就在行里，渲染层据它写日期）。
      if (typeof c.prefs?.roomDate === "string") jwState.roomDate = c.prefs.roomDate;
      for (const [k, rows] of Object.entries(c.keep || {})) if (Array.isArray(rows) && jwState.data[k] === null) jwState.data[k] = rows;
      if (jwState.data.pdataStudy === null && c.keep?.pdataStudy && typeof c.keep.pdataStudy === "object") jwState.data.pdataStudy = c.keep.pdataStudy;
      if (jwState.data.exam === null && c.keep?.exam && typeof c.keep.exam === "object" && Array.isArray(c.keep.exam.terms)) jwState.data.exam = c.keep.exam;
      for (const [k, at] of Object.entries(c.at || {})) if (!jwState.at[k]) jwState.at[k] = Number(at) || 0;
      // 自习室缓存的是「哪一天」的数：昨天缓存的那份顶着今天用就是错的（RQ 会露出真相）。
      // 今天视图（roomDate ""）发现缓存行不是今天的，直接丢掉等重拉；指定日期的缓存按日期比。
      if (Array.isArray(jwState.data.room) && jwState.data.room.length) {
        const cachedDay = String(jwState.data.room[0]?.RQ || "");
        const want = jwState.roomDate || jwDayISO(0);
        if (cachedDay && cachedDay !== want) { jwState.data.room = null; }
      }
    } catch { /* 缓存坏了当没有 */ }
  }

  /* ── 个人成长中心（pdata）学情：绩点排名 + 本人/学霸绩点差距 ──
     两个接口的学生端路径都带 shc 段（pdp 段是教师端，学生 token 打过去同样空）：
       GET /tsa/shc/learnInfo/gradePointRanking → [{RANKTYPE, RANKING}]，RANKTYPE ∈ 全校/学院/专业/班级
       GET /tsa/shc/learnInfo/learningGap      → [{RANKTYPE, MYPOINT, TOPPOINT}]
     pdata 的排行只按学期批量算，2025 级新生（当前账号）两个接口都返回 data: []，
     所以这里必须原样保留空数组 —— 渲染层靠它区分「暂无数据」和「还没拉过」。 */
  const PDATA_RANK_TYPES = ["全校", "学院", "专业", "班级"];
  const PDATA_RANK_KEYS = ["QXPM", "XYPM", "ZYPM", "BJPM"];

  function pdataRankOf(list, key) {
    const hit = (Array.isArray(list) ? list : []).find((r) => String(r?.RANKTYPE || "").trim() === key);
    const n = Number(hit?.RANKING);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function pdataPointOf(list, key, field) {
    const hit = (Array.isArray(list) ? list : []).find((r) => String(r?.RANKTYPE || "").trim() === key);
    const n = Number(hit?.[field]);
    return Number.isFinite(n) ? n : 0;
  }
  // 空数据也带 ok:true 落进缓存：否则每进一次页面都要重打两个接口，而结果永远是空。
  const pdataEmptyStudy = () => ({
    ok: true, at: Date.now(), auth: false, message: "",
    rank: { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 },
    myPoint: { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 },
    topPoint: { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 },
  });

  async function jeLoadPdataStudy() {
    const [rankRes, gapRes] = await Promise.all([
      pdataApi("/tsa/shc/learnInfo/gradePointRanking"),
      pdataApi("/tsa/shc/learnInfo/learningGap"),
    ]);
    const rank = { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 };
    const myPoint = { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 };
    const topPoint = { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 };
    PDATA_RANK_TYPES.forEach((type, i) => {
      rank[PDATA_RANK_KEYS[i]] = pdataRankOf(rankRes.data, type);
      myPoint[PDATA_RANK_KEYS[i]] = pdataPointOf(gapRes.data, type, "MYPOINT");
      topPoint[PDATA_RANK_KEYS[i]] = pdataPointOf(gapRes.data, type, "TOPPOINT");
    });
    return { ok: !!(rankRes.ok || gapRes.ok), at: Date.now(),
      auth: !!(rankRes.auth || gapRes.auth), message: String(rankRes.message || gapRes.message || ""),
      rank, myPoint, topPoint };
  }

  async function jwEnsureKeys(keys, force = false) {
    jwRound++;                      // 新一轮刷新：作废上一轮的登录失败结论，允许重新判定
    // 登录在一轮刷新开始时只判定一次，放在 loadJwTerm 之前（这样 loadJwTerm 里那次
    // ensureJwLogin() 会被 jwLive() 直接短路，不会再多跑一轮）。判定失败就当场收工：
    // 这一轮所有 key 都是同一个原因，没必要逐个再撞一次登录。
    if (!await ensureJwLogin(force)) {
      const reason = loginHint?.msg || "警大统一身份认证未建立：请在下方完成登录后重试";
      for (const key of keys) if (!jwState.loading[key]) jwState.error[key] = reason;
      jwPaint();
      return;
    }
    await loadJwTerm(force);
    for (const key of keys) {
      if (jwState.loading[key]) continue;
      if (!force && Array.isArray(jwState.data[key])) continue;
      // 考试是对象不是数组，上面那个 continue 兜不住它：缓存里已经有安排就直接用缓存，
      // 进页面不再重拉一遍（「刷新」按钮走 force，一次拉全）
      if (!force && key === "exam" && jwState.data.exam?.plans?.length) continue;
      jwState.loading[key] = true;
      jwState.error[key] = "";
      jwPaint();
      try {
        // pdata 学情走自己的 token（不经 jeLoad）；它没有数据也算拉成功，
        // 失败只在卡片内部提示，不挂「拉取失败」横幅 —— 它不影响成绩本体。
        if (key === "pdataStudy") jwState.data.pdataStudy = await jeLoadPdataStudy();
        else if (key === "exam") jwState.data.exam = await jeLoadExam();
        else {
          // 课次一次拉「整学期」（实测 222 节），今天/本周在渲染时切，避免每切一次打一次接口
          const groups = key === "qjCourse" && jwState.term?.code
            ? [{ type: "and", value: [{ code: "XNXQ_CODE", type: "=", value: jwState.term.code, cn: "and" }] }]
            : [];
          // 自习室带日期维度（RQ 占位符换成选中那天）；其它功能没有这个参数，原样不传
          jwState.data[key] = await jeLoad(key, groups, key === "room" ? { date: jwState.roomDate } : undefined);
        }
        jwState.at[key] = Date.now();
      } catch (e) {
        jwState.error[key] = String(e?.message || e);
      }
      jwState.loading[key] = false;
    }
    await jwSaveCache();
    jwPaint();
  }

  /* ── 我的考试（v0.272.0）──────────────────────────────────────────────
     两块接口，缺一不可：
       V_JWBZK_KWGL_KS_STU  考试计划 —— 哪个学期、叫什么名字、什么时候开考到什么时候收
       V_JWBZK_KWGL_KSRW_STU 考试任务 —— 这个计划下**我本人**的每一场：课程 / 地点 / 时段
     任务接口按「计划 ID + 学期 + 学号」筛，所以一个计划就得打一次；而计划接口一次回所有
     学期（实测 2 条，往前还有更早的），全拉一遍就是十几跳 —— 只拉当前学期，其余学期
     等用户在学期胶囊上点了再补，补过的留在内存 + 缓存里。
     XH 必须用 like '%学号%'：校方把整场考生的学号串在同一个字段里，等号一个都匹配不上。 */
  const jwExamNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  /* KSSJQJ 实测形如 "2026-01-15 08:00-09:50"（日期 + 起止时刻，中间一个连字符）。
     格式变了就原样留着显示，不硬猜 —— 这一页最容易编出来的假话就是「08:00 开考」。 */
  function jwExamParse(qj) {
    const raw = String(qj || "").trim();
    const m = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}:\d{2})\s*[-–~至]\s*(\d{1,2}:\d{2})/);
    if (!m) return { date: "", md: "", day: "", start: "", end: "", at: 0, endAt: 0, raw };
    const date = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    const hhmm = (s) => { const [h, mi] = String(s).split(":"); return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`; };
    const start = hhmm(m[4]), end = hhmm(m[5]);
    const at = Date.parse(`${date}T${start}:00`), endAt = Date.parse(`${date}T${end}:00`);
    return { date, md: date.slice(5), day: "日一二三四五六"[new Date(`${date}T00:00:00`).getDay()],
      start, end, at: Number.isFinite(at) ? at : 0, endAt: Number.isFinite(endAt) ? endAt : 0, raw };
  }
  function jwExamRow(r) {
    const p = jwExamParse(r?.KSSJQJ);
    return {
      id: String(r?.ID || [r?.KCMC, r?.KSSJQJ, r?.KSDD].filter(Boolean).join("|")),
      course: String(r?.KCMC || "").trim(),
      code: String(r?.KCBH || "").trim(),
      place: String(r?.KSDD || "").trim(),
      chief: String(r?.ZKXM || "").trim(),
      watch: String(r?.JKXM || "").trim(),
      ...p,
    };
  }
  const jwExamPlanOf = (p) => ({
    id: String(p?.ID || ""),
    name: String(p?.KSMC || "").trim(),
    term: String(p?.XNXQ || "").trim(),
    range: String(p?.KSSJ || "").trim(),
    start: jwExamNum(p?.KSKSSJ),
    end: jwExamNum(p?.KSJSSJ),
  });
  async function jeLoadExamTerm(termCode) {
    const plans = ((jwState.data.exam?.plans) || []).filter((p) => p.term === termCode && p.id);
    if (!plans.length) return [];
    const uid = String(state.username || "").trim();
    const boom = [];
    const results = await Promise.all(plans.map((plan) => {
      const groups = [{ type: "and", value: [
        { code: "KS", type: "=", value: plan.id, cn: "and" },
        { code: "XNXQ", type: "=", value: plan.term, cn: "and" },
        ...(uid ? [{ code: "XH", type: "like", value: `%${uid}%`, cn: "and" }] : []),
      ] }];
      // 一个学期挂了两个计划（期末 + 补考）时，其中一个报错不该让整学期空着：
      // 收下错误，全都失败才抛（那时候才是真的登录态/接口坏了）
      return jeLoad("examTask", groups).catch((e) => { boom.push(e); return []; });
    }));
    if (boom.length && boom.length === plans.length) throw boom[0];
    const seen = new Set();
    return results.flat().map(jwExamRow)
      .filter((r) => (r.course || r.raw) && !seen.has(r.id) && seen.add(r.id))
      .sort((a, b) => (a.at || 9e15) - (b.at || 9e15) || a.course.localeCompare(b.course));
  }
  async function jeLoadExam() {
    const raw = await jeLoad("examPlan");
    const plans = (Array.isArray(raw) ? raw : []).map(jwExamPlanOf).filter((p) => p.id && p.term);
    // 学期排序统一走 jwTermOrder（20252026-1 → 20252），再按计划结束时间兜底
    plans.sort((a, b) => jwTermOrder(b.term) - jwTermOrder(a.term) || b.end - a.end);
    const out = { ok: true, at: Date.now(), plans, current: "", terms: {} };
    if (!plans.length) return out;
    // 当前学期有考试计划就落在当前学期；没有（放假/新学期还没排考）就落在最近一个学期，
    // 渲染时明说「已结束」—— 比给一屏空白让人以为接口坏了要诚实。
    const cur = String(jwState.term?.code || "").trim();
    out.current = plans.some((p) => p.term === cur) ? cur : plans[0].term;
    jwState.data.exam = out;                       // jeLoadExamTerm 要读 plans，先把壳挂上
    try { out.terms[out.current] = await jeLoadExamTerm(out.current); }
    catch (e) { delete jwState.data.exam; throw e; }
    return out;
  }
  /* 学期胶囊按需补数：补过的不再打接口（结果留内存 + 落缓存），失败只弹一句提示，
     因为失败的是「另一个学期」，不该把整页已经画好的安排换成一条红横幅。 */
  async function jwEnsureExamTerm(termCode) {
    const d = jwState.data.exam;
    if (!d || !termCode || Array.isArray(d.terms?.[termCode])) return;
    if (!d.plans?.length) return;
    d.terms[termCode] = await jeLoadExamTerm(termCode);
    await jwSaveCache();
  }

  /* ── 视图渲染 ── */
  function jwTag(text, cls) { if (/^[\d.]+ 学分$/.test(text)) cls = "credit"; return text ? `<span class="jw-tag${cls ? " " + cls : ""}">${esc(text)}</span>` : ""; }
  function jwAt(key) {
    const at = Number(jwState.at[key]) || 0;
    return at ? `更新于 ${new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "尚未拉取";
  }
  /* 横幅本身就是刷新入口（用户要求「点击这个横幅也可以刷新」）。用真 <button> 而不是 div+click：
     Tab 能聚焦、Enter / Space 能触发、读屏会把整条文案念成按钮名。加载态仍是纯文字 .pp-empty
     —— 那时候再点只会叠一轮请求，点不动才是对的。标记与外壳统一由 bannerRefreshHtml 产出
     （v0.190.0 抽出来给通知视图、一卡通视图共用），所以登录失败、拉取失败、解析失败三种横幅一次全部可点。 */
  function jwStateBlock(key, loadingText) {
    if (jwState.loading[key]) return `<div class="pp-empty">${esc(loadingText || `正在拉取${jwKeyLabel(key)}…`)}</div>`;
    if (jwState.error[key]) return bannerRefreshHtml(jwState.error[key], "jw-banner-refresh");
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

  /* OPERATERCODE 的语义：是学号＝学生自己选的；是 32 位 uuid＝教务代选 / 批量导入。
     能拿到登录学号时以「相等」为准；拿不到时按「像不像学号」兜底 —— 不能因为
     state.username 还没填上，就把整页课程全标成「教务代选」。 */
  function jwOperatorSelf(code) {
    const raw = String(code || "").trim();
    if (!raw) return false;
    const uid = String(state.username || "").trim();
    if (uid) return raw === uid;
    return /^\d{6,}$/.test(raw);
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
          jwHoursTag(r),
          r.SKDD ? jwTag(r.SKDD) : "",
          jwTag(jwOperatorSelf(r.OPERATERCODE) ? "本人自选" : "教务代选"),
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

  /* 剩余学时（v0.271.0）：已选课程卡片上加一枚「剩余 N 学时」标签。
     选课结果视图自己没有学时字段（V_JWBZK_XKGL_XKJG 的 18 个字段里只有 XF 学分），课时在
     请假视图那张课次表（V_JWBZK_PK_XSKBZHCX：KCH/KCBH 课程号、KXXS 课序学时、SKRQ 上课日）。
     所以按课程号把两张表对齐：总学时 = Σ 这门课每次课的 KXXS，已上 = SKRQ ≤ 今天的那些，
     剩余 = 总 − 已上。慕课这类没排课次的课程对不上 → 一枚标签都不显示，
     绝不拿学分折算一个「看起来像」的数出来（学分与学时不是一回事，慕课尤其不是）。 */
  const jwLessonKey = (r) => String(r?.KCH || r?.KCBH || "").trim();
  function jwLessonsOf(course) {
    const rows = Array.isArray(jwState.data.qjCourse) ? jwState.data.qjCourse : null;
    if (!rows || !rows.length || !course) return [];
    const key = jwLessonKey(course);
    const name = String(course.KCMC || "").trim();
    return rows.filter((r) => {
      const lessonKey = jwLessonKey(r);
      // 课程号是「同一门课」最硬的判据；课次行没给号时才退回课程名，
      // 否则一门缺号的课会把整学期的课时都算到自己头上。
      if (key && lessonKey) return lessonKey === key;
      return !!name && String(r.KCMC || "").trim() === name;
    });
  }
  function jwHoursRest(course) {
    const today = jwToday();
    let total = 0, done = 0;
    for (const r of jwLessonsOf(course)) {
      const h = Number(String(r?.KXXS ?? "").trim());
      if (!Number.isFinite(h) || h <= 0) continue;
      total += h;
      // SKRQ 一律是 YYYY-MM-DD，字符串比较即日期比较（午后的课也算今天已经上掉）
      if (String(r?.SKRQ || "") && String(r.SKRQ) <= today) done += h;
    }
    return total > 0 ? { total, done, rest: Math.max(0, total - done) } : null;
  }
  function jwHoursTag(course) {
    const hours = jwHoursRest(course);
    if (!hours) return "";
    return hours.rest > 0 ? jwTag(`剩余 ${hours.rest} 学时`, "hours") : jwTag("学时已上完", "hours");
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
        const self = jwOperatorSelf(r.OPERATERCODE);
        return `<div class="jw-card">
          <div class="jw-card-t">${esc(r.KCMC || "（未命名课程）")}</div>
          ${jwMetaLine([
            jwTag(jwDict("KCSX", r.KCSX)),
            r.XKBMC ? jwTag(r.XKBMC) : "",
            r.XF ? jwTag(`${r.XF} 学分`, "ok") : "",
            r.SKDD ? jwTag(r.SKDD) : "",
            jwTag(self ? "本人自选" : "教务代选", self ? "" : "warn"),
            // 学时排最后：它是这门课自己的进度，压在「本人自选/教务代选」这种身份标签之后更顺，
            // 也不会把教室号往右挤出去（v0.271.1）
            jwHoursTag(r),
          ])}
        </div>`;
      }).join("");
    }
    return jwSection("已选课程", `${rows.length} 门 · ${jwAt("xkResult")}`, html);
  }

  /* ═════════ 自习室查询（教室占用 / 借用） ═════════
     取数：funcCode = ZXZYCX（见 JW_FUNC.room），funcId / tableCode 由 jwFuncInfo 现场补齐。
     为什么这里要「按列名语义自适应」而不是像选课 / 成绩那样写死字段：这个网格的列是校方在后台
     配的，前端四个 bundle 里一个字段名都抄不到（见 JW_FUNC.room 注释）。所以先按中文列名 / 字段码
     把列认成语义角色（教室 / 日期 / 时段 / 容量 / 状态），认得出的排成卡片，认不出的一律
     以「列名：值」列在卡片底部 —— 一行都不丢，也绝不猜一个看着顺眼的中文糊上去。
     写操作（申请借用）与交请假、选课同一条口径：提交不接管，换票开教务交给学校系统。 */
  const JW_ROOM_ROLES = [
    ["room", /教室|房间|场地|地点|门牌|自习室|room|jxlsmc|ddmc|fjmc|ddd/i],
    ["date", /日期|上课日|使用日|skrq|^rq$|date/i],
    ["slot", /节次|节$|时段|开始时间|结束时间|时间|jc$|sjd|kssj|jssj|time/i],
    ["cap", /容量|座位|人数|容纳|余位|剩余|cap|seat|rl/i],
    ["status", /状态|是否|占用|空闲|可用|预约|申请|审核|批准|使用|zt$|state/i],
  ];
  const jwRoomText = (v) => (v == null ? "" : String(v).trim().replace(/^(null|undefined)$/i, ""));
  /* 搜索（铁律十）：一个框里同时认三种输入 —— 原文、拼音首字母、跳字简写。
     首字母表随插件带一份（pinyin-initials.js 是生成物，事实源是 src/pinyinInitial.js），
     按需动态加载：装好之前先按原文匹配，装好立刻原地重跑一次，不会出现「打了拼音没反应」。
     逐字段匹配、绝不把一行拼成长串：拼串会让首字母跨字段连起来
     （「阶梯教室 / 第一节」→ jtjsjd1），搜 jd 就假命中，而页面上并没有这几个字挨着。 */
  let roomPinyinMod = null, roomPinyinLoading = null;
  const loadRoomPinyin = () => roomPinyinLoading
    || (roomPinyinLoading = import("/plugins/cppu-notify/pinyin-initials.js")
      .then((m) => (roomPinyinMod = m)).catch(() => null));
  const roomFieldHits = (field, q) => {
    const f = String(field || "").toLowerCase().replace(/\s+/g, "");
    if (!f || !q) return false;
    if (f.includes(q)) return true;
    // 纯数字查询只认「包含」：教室号里没有拼音可打，而跳字子序列会把 101 连到 10S-102 上
    // （1→0→1 在 "10s102" 里按序出现），搜 A 栋 101 却捞出一串 10S-1xx，纯属噪音。
    if (/^\d+$/.test(q)) return false;
    return roomPinyinMod ? roomPinyinMod.initialHit(field, q) : false;
  };
  // idx → 这一行的可搜字段。渲染时顺手记下，过滤时不必重算列定义（每敲一个字都算一遍太浪费）。
  const roomRowFields = new Map();
  let roomCountIdle = "";           // 计数行的「未过滤」原文：清空搜索时原地复原，不必重绘（重绘会夺走输入焦点）
  /* 列清单 = funcInfo 声明的列 ∪ 真实返回行的键。后者必须并进来：校方常给「隐藏列」，
     元信息里不声明但数据里有值，只信元信息会把它们悄悄丢掉。 */
  function jwRoomCols(rows) {
    const named = new Map();
    for (const c of jwFuncMeta.room?.columns || []) if (c.code && !named.has(c.code)) named.set(c.code, c.name || c.code);
    for (const r of rows.slice(0, 80)) for (const k of Object.keys(r || {})) if (!named.has(k)) named.set(k, k);
    return [...named.entries()].map(([code, name]) => ({
      code, name,
      role: (JW_ROOM_ROLES.find(([, re]) => re.test(`${name} ${code}`)) || ["other"])[0],
    }));
  }
  const jwRoomPick = (r, cols, role) => {
    const c = cols.find((x) => x.role === role && jwRoomText(r?.[x.code]));
    return c ? jwRoomText(r[c.code]) : "";
  };
  /* 状态着色沿用成绩页四档里的三档：有空 → ok、占用 → bad、待审 → warn，
     看不懂的文案不给色（校方随时可能加词，不给色比给错色安全）。 */
  function jwRoomTone(text) {
    const s = String(text || "");
    if (/空闲|可用|无人|未占用|可预约|可借|^是$/.test(s)) return "ok";
    if (/占用|已满|不可用|不可预约|已预约|已借|^否$/.test(s)) return "bad";
    if (/审核|审批|待|申请中|处理中/.test(s)) return "warn";
    return "";
  }
  /* ── 楼（v0.270.0：一行一间的旧渲染 ⇒ 一栋楼一张卡片）─────────────────────
     接口只回六个键（YWMC 教室号 / YW_ID / JC 节次 / RQ 日期 / SFZY 1 占用 2 空闲 / ID），
     **没有独立的「楼」字段**，楼只能从教室号认。实测 126 间教室这几种写法：
       101 102 … 538        → 主楼（无字母前缀，1–5 层）
       A101 … A503  C… D… E307 → A / C / D / E 栋
       7S-101 9S-101 10S-101 → 7S / 9S / 10S 楼
       一讲堂 三讲堂 五讲堂 六讲堂 → 讲堂
       第一阶梯教室 第二阶梯教室（模拟法庭）→ 阶梯教室
       穗7-3 → 穗区；穗公安边防派出所实训室 → 实训室（按「实训室」先认，再谈「穗」）
     认不出的原样归「其它」，绝不猜一个看着像的楼名 —— 与仓库其它地方同一条口径。 */
  function jwRoomBuilding(raw) {
    const s = jwRoomText(raw);
    let m;
    if ((m = /^([A-Za-z])\s*\d{3,4}$/.exec(s))) return `${m[1].toUpperCase()} 栋`;
    if ((m = /^(\d+)\s*S\s*[-－]/i.exec(s))) return `${m[1]}S 楼`;
    if (/讲堂/.test(s)) return "讲堂";
    if (/阶梯教室/.test(s)) return "阶梯教室";
    if (/实训室|实验室/.test(s)) return "实训室";
    if (/^穗/.test(s)) return "穗区";
    if ((m = /^(\d+)\s*[-－]/.exec(s))) return `${m[1]} 号楼`;
    if (/^\d{3,4}$/.test(s)) return "主楼";
    return "其它";
  }
  /* 卡片顺序：主楼 → 字母栋（A→E）→ S 楼 → 讲堂 → 阶梯教室 → 实训室 → 穗区 → 其它。
     按「大家最常去的那栋」排，不按字符序（字符序会把 10S 排到 7S 前面、把「主楼」排到最后）。 */
  function jwRoomBldRank(name) {
    if (name === "主楼") return 0;
    if (/^[A-E] 栋$/.test(name)) return 1;
    if (/ 楼$/.test(name)) return 2;
    if (name === "讲堂") return 3;
    if (name === "阶梯教室") return 4;
    if (name === "实训室") return 5;
    if (name === "穗区") return 6;
    return 7;
  }
  const jwRoomSlotLabel = (code) => jwDict("JC", code) || jwRoomText(code);
  const jwRoomSlotText = (code) => ({ "1": "占用", "2": "空闲" }[String(code || "").trim()] || "未给出");
  const jwRoomSlotTone = (code) => ({ "1": "bad", "2": "ok" }[String(code || "").trim()] || "");
  /* 真形状判定：YWMC + JC + SFZY 三个键都在，才按「一间教室 × 一个节次」来建卡片。
     校方哪天换了返回形状（比如给中文列名），这里自动退回下面那套认列名的通用渲染。 */
  const jwRoomShape = (rows) => {
    const r = rows[0] || {};
    return ["YWMC", "JC", "SFZY"].every((k) => Object.prototype.hasOwnProperty.call(r, k));
  };
  /* 日期胶囊用的 ISO 日（本地时区，不用 toISOString —— 那个是 UTC，晚上会差一天）。
     offset 0 = 今天，1 = 明天…… "" 表示「今天」交给服务端 SYSDATE 决定。 */
  function jwDayISO(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + Number(offset || 0));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  // 胶囊上的字：今天/明天/后天以外给「10-25 周日」，比裸 ISO 好认
  function jwRoomDateLabel(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 周${"日一二三四五六"[d.getDay()]}`;
  }
  function jwRoomModel(rows) {
    const slots = [...new Set(rows.map((r) => jwRoomText(r.JC)).filter(Boolean))].sort();
    // 按教室名分组（YW_ID 只是兜底）。实测教室名与 YW_ID 是一对一（126 间 ↔ 126 个 ID），
    // 但同一间教室在别的数据形态下可能每节次一个 YW_ID —— 那样按 ID 分组就会把 101 拆成
    // 5 行「101」，用户看到的就是「同一间教室占了一堆位置」。名字才是人认的那把钥匙。
    const rooms = new Map();   // 教室名 → { name, bld, idx, slots: Map<节次, SFZY> }
    const order = [];
    for (const r of rows) {
      const name = jwRoomText(r.YWMC);
      const id = name || jwRoomText(r.YW_ID);
      if (!id) continue;
      if (!rooms.has(id)) {
        rooms.set(id, { name: name || "教室未给出", bld: jwRoomBuilding(name), idx: order.length, slots: new Map() });
        order.push(id);
      }
      const room = rooms.get(id);
      const jc = jwRoomText(r.JC);
      const code = jwRoomText(r.SFZY);
      // 同一天同一间同一节次只该有一行；真出现重复就以「占用」为准（宁可少报空闲）
      if (!room.slots.has(jc) || code === "1") room.slots.set(jc, code);
    }
    const byBld = new Map();
    for (const id of order) {
      const room = rooms.get(id);
      if (!byBld.has(room.bld)) byBld.set(room.bld, []);
      byBld.get(room.bld).push(room);
    }
    const blds = [...byBld.entries()].sort((a, b) => jwRoomBldRank(a[0]) - jwRoomBldRank(b[0])
      || String(a[0]).localeCompare(String(b[0]), "zh-CN"));
    let free = 0, seats = 0;
    for (const id of order) {
      for (const s of slots) {
        const code = rooms.get(id).slots.get(s);
        if (code === undefined) continue;
        seats++;
        if (code === "2") free++;
      }
    }
    return { slots, date: jwRoomText(rows[0]?.RQ), blds, total: order.length, free, seats };
  }
  function jwRoomRowHtml(r, idx, cols, mode) {
    const take = (role) => {
      const c = cols.find((x) => x.role === role && jwRoomText(r[x.code]));
      return c ? { code: c.code, val: jwRoomText(r[c.code]) } : null;
    };
    const room = take("room"), date = take("date"), slot = take("slot"), cap = take("cap"), status = take("status");
    const used = new Set([room, date, slot, cap, status].filter(Boolean).map((x) => x.code));
    const main = mode === "date"
      ? (room?.val || "教室未给出")
      : ([date?.val, slot?.val].filter(Boolean).join(" · ") || "时段未给出");
    const tags = [
      mode === "date" ? jwTag(slot?.val || "") : "",
      cap?.val ? jwTag(`容量 ${cap.val}`) : "",
      status?.val ? jwTag(status.val, jwRoomTone(status.val)) : "",
    ].filter(Boolean).join("");
    const rest = cols.filter((c) => !used.has(c.code) && jwRoomText(r[c.code]));
    // 可搜字段 = 这一行所有非空单元格，逐格记下来（过滤时按 data-room-idx 取回）。
    // data-kw 只是首字母表还没装好时的兜底整串，正常路径绝不拿它比 —— 见 roomFieldHits 注释。
    const fields = cols.map((c) => jwRoomText(r[c.code])).filter(Boolean);
    roomRowFields.set(idx, fields);
    const kw = fields.join(" ").toLowerCase();
    return `<div class="jw-card jw-room-row" data-kw="${esc(kw)}" data-room-idx="${idx}">
      <div class="jw-card-t">${esc(main)}</div>
      ${tags ? `<div class="pp-meta">${tags}</div>` : ""}
      ${rest.length ? `<div class="jw-detail-grid">${rest.map((c) => `<div class="jw-detail-cell"><b>${esc(c.name)}</b><span>${esc(jwRoomText(r[c.code]))}</span></div>`).join("")}</div>` : ""}
    </div>`;
  }
  /* 一栋楼一张卡：标题带这一栋的间数 / 空闲数，卡里每间教室一行，五个节次各一个小格。
     选了节次就把别的格子调暗（不是删掉）—— 一边看「现在哪间空」一边仍能扫到全天分布。 */
  function jwRoomCardHtml(bld, rooms, slots, sel, visible = true) {
    const freeIn = (slot) => rooms.filter((x) => x.slots.get(slot) === "2").length;
    const freeN = rooms.reduce((n, x) => n + slots.filter((s) => x.slots.get(s) === "2").length, 0);
    const seatN = rooms.reduce((n, x) => n + slots.filter((s) => x.slots.get(s) !== undefined).length, 0);
    const sum = sel !== "all" && slots.includes(sel)
      ? `空闲 <b>${freeIn(sel)}</b> / ${rooms.length} 间`
      : `共 ${rooms.length} 间 · 空闲位 ${freeN} / ${seatN}`;
    // 整天一位都没占：直接给一个绿标，省得换算「332/630」这种数字
    const allDay = seatN > 0 && freeN === seatN ? `<span class="jw-tag ok">全天空闲</span>` : "";
    const lines = rooms.map((room) => {
      const pills = slots.map((s) => {
        const code = room.slots.get(s) || "";
        const tone = jwRoomSlotTone(code);
        const off = sel !== "all" && sel !== s;
        return `<span class="jw-room-slot${tone ? ` ${tone}` : ""}${off ? " off" : ""}" title="${esc(`${jwRoomSlotLabel(s)} 节 · ${jwRoomSlotText(code)}`)}">${esc(jwRoomSlotLabel(s))}</span>`;
      }).join("");
      // 可搜字段：楼名 + 教室号 + 每个节次的「节次 状态」，逐字段比（见 roomFieldHits 注释）
      roomRowFields.set(room.idx, [bld, room.name, ...slots.map((s) => `${jwRoomSlotLabel(s)} ${jwRoomSlotText(room.slots.get(s) || "")}`)]);
      return `<div class="jw-room-line" data-room-idx="${room.idx}"><span class="jw-room-name" title="${esc(room.name)}">${esc(room.name)}</span><span class="jw-room-slots">${pills}</span></div>`;
    }).join("");
    // 没选中的楼整张收起（不是不渲染）：搜索 / 节次切换都在 DOM 上就地做，
    // 卡片必须一直在树里，[hidden] 只切显隐 —— 重绘会把输入框换掉、用户打两个字就丢焦点。
    return `<div class="jw-card jw-room-bld"${visible ? "" : " hidden"} data-room-bld="${esc(bld)}">
      <div class="jw-room-bld-hd"><span class="jw-room-bld-name">${esc(bld)}</span><span class="jw-room-bld-sum" data-room-sum>${sum}</span>${allDay}</div>
      ${lines}
    </div>`;
  }
  function jwRoomHtml() {
    const head = jwStateBlock("room", "正在拉取自习室数据…");
    if (head) return jwSection("自习室", jwAt("room"), head);
    const rows = jwState.data.room;
    if (!Array.isArray(rows)) return jwSection("自习室", jwAt("room"), `<div class="pp-empty">还没有拉取过自习室数据，点上方「刷新」</div>`);
    if (!rows.length) {
      return jwSection("自习室", jwAt("room"),
        `<div class="pp-empty">教务这次没返回自习室记录。若确有开放时段，点「浏览器打开」进「${JW_MENU.room}」查看。</div>`);
    }
    roomRowFields.clear();
    const cols = jwRoomCols(rows);
    if (!jwRoomShape(rows)) {
      /* 返回形状变了（没有 YWMC/JC/SFZY）：退回认列名的通用渲染，一行都不丢。 */
      const bar = `<div class="pp-toolbar"><span class="pp-kwbox"><span class="pp-kw-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span>`
        + `<input class="pp-kw" data-room-filter type="text" value="${esc(jwState.roomFilter || "")}" aria-label="筛选教室 / 时段 / 状态（支持拼音首字母）" placeholder="筛选教室、时段、状态…"></span></div>`
        + `<div class="pp-meta" data-room-count>${roomCountIdle = `共 ${rows.length} 条`}</div>`;
      return jwSection("自习室", jwAt("room"), bar
        + rows.map((r, idx) => jwRoomRowHtml(r, idx, cols, "flat")).join(""));
    }
    const { slots, date: dataDate, blds } = jwRoomModel(rows);
    const sel = slots.includes(jwState.roomSlot) ? jwState.roomSlot : "all";
    const theDay = dataDate || jwState.roomDate || jwDayISO(0);
    /* 楼胶囊（v0.275.0）：选过的楼不在这次数据里（换了日期、那栋楼当天全满不返回）就当「全部」，
       否则会渲染出一屏「全部楼都藏起来了」的空白页。三个数字（计数行 / 卡片标题 / 搜索匹配数）
       必须同一个口径，全部按 picked 算。 */
    const bldSel = blds.some(([b]) => b === jwState.roomBld) ? jwState.roomBld : "";
    const picked = bldSel ? blds.filter(([b]) => b === bldSel) : blds;
    const pTotal = picked.reduce((n, [, rooms]) => n + rooms.length, 0);
    const pFree = picked.reduce((n, [, rooms]) => n + rooms.reduce((m, x) => m + slots.filter((s) => x.slots.get(s) === "2").length, 0), 0);
    const pSeats = picked.reduce((n, [, rooms]) => n + rooms.reduce((m, x) => m + slots.filter((s) => x.slots.get(s) !== undefined).length, 0), 0);
    // 计数行先给「哪天 · 空闲多少」——用户点日期就是为了这一句
    roomCountIdle = `${theDay} · ${picked.length} 栋 ${pTotal} 间 · 空闲位 ${pFree} / ${pSeats}`;
    /* 日期胶囊：今天 = 不传 RQ（服务端 SYSDATE）。选过的自定义日期额外补一颗，
       并把原生日期选择器叠在最后一颗胶囊上（原生弹层做不了双向动画，铁律七只约束
       自建下拉栏，这里用系统的日历）。 */
    const dayItems = [["", "今天"], [jwDayISO(1), "明天"], [jwDayISO(2), "后天"]];
    if (jwState.roomDate && !dayItems.some(([id]) => id === jwState.roomDate)) {
      dayItems.push([jwState.roomDate, jwRoomDateLabel(jwState.roomDate)]);
    }
    const dateBar = `<div class="pp-toolbar jw-room-bar"><span class="pp-lab">日期</span><div class="pp-chips" data-room-dates>`
      + dayItems.map(([id, label]) =>
        `<button type="button" class="pp-chip${(jwState.roomDate || "") === id ? " on" : ""}" data-room-date="${esc(id)}">${esc(label)}</button>`).join("")
      + `</div><span class="pp-datesel" data-room-date-btn><input class="jw-date-in" type="date" data-room-date-in value="${esc(theDay)}" aria-label="选日期，看那天有没有空闲" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg></span></div>`;
    const bar = dateBar
      + `<div class="pp-toolbar jw-room-bar"><span class="pp-lab">楼</span><div class="pp-chips" data-room-blds>`
      + [["", "全部"], ...blds.map(([b]) => [b, b])].map(([id, label]) => {
        const n = id ? (blds.find(([b]) => b === id)?.[1].length || 0) : pTotal;
        return `<button type="button" class="pp-chip${bldSel === id ? " on" : ""}" data-room-bld-chip="${esc(id)}" title="${esc(id ? `${id} · ${n} 间` : `全部 ${blds.length} 栋 ${n} 间`)}">${esc(label)}</button>`;
      }).join("")
      + `</div></div>`
      + `<div class="pp-toolbar jw-room-bar"><span class="pp-lab">节次</span><div class="pp-chips" data-room-slots>`
      + [["all", "全部"], ...slots.map((s) => [s, jwRoomSlotLabel(s)])].map(([id, label]) =>
        `<button type="button" class="pp-chip${sel === id ? " on" : ""}" data-room-slot="${esc(id)}">${esc(label)}</button>`).join("")
      + `</div></div><div class="pp-toolbar"><span class="pp-kwbox"><span class="pp-kw-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span>`
      + `<input class="pp-kw" data-room-filter type="text" value="${esc(jwState.roomFilter || "")}" aria-label="筛选楼、教室、节次、状态（支持拼音首字母与简写）" placeholder="搜楼 / 教室，可打拼音首字母…"></span></div>`
      + `<div class="pp-meta" data-room-count>${esc(roomCountIdle)}</div>`;
    return jwSection("自习室", jwAt("room"), bar + blds.map(([bld, rooms]) => jwRoomCardHtml(bld, rooms, slots, sel, !bldSel || bldSel === bld)).join(""));
  }
  /* 过滤在 DOM 上就地做（不重绘）：重绘会把 input 换掉，用户打两个字就丢焦点。
     组头下一条都没剩就一起藏起来，避免一屏空标题。
     输入口径见 roomFieldHits：原文 / 拼音首字母 / 跳字简写，且按单元格逐格比。 */
  function jwApplyRoomFilter(el) {
    if (!el || !el.isConnected) return;
    const raw = String(jwState.roomFilter || "").trim();
    const q = raw.toLowerCase().replace(/\s+/g, "");
    // 首字母表是按需加载的：拉丁输入在它就绪前先不下结论，装好后原地重跑一次。
    if (q && !roomPinyinMod && /[a-z]/.test(q)) loadRoomPinyin().then(() => jwApplyRoomFilter(el));
    const rows = el.querySelectorAll(".jw-room-line, .jw-room-row");
    if (!rows.length) return;
    /* 楼选择是「范围」不是「搜索」：选了一栋楼，别的楼的教室连"全部"都不该算进分母 ——
       否则计数行写着「匹配 3 / 全部 214 间」，用户会以为搜索漏了东西。
       楼不在这次数据里（换日期后那栋没返回）就自动退回全部，与渲染层的 bldSel 同一条口径。 */
    const wantBld = String(jwState.roomBld || "");
    const bldSel = wantBld && [...el.querySelectorAll("[data-room-bld]")].some((c) => c.dataset.roomBld === wantBld) ? wantBld : "";
    let shown = 0, scope = 0;
    for (const row of rows) {
      const card = row.closest("[data-room-bld]");
      const inScope = !bldSel || (!!card && card.dataset.roomBld === bldSel);
      const fields = roomRowFields.get(Number(row.dataset.roomIdx));
      const hit = !q || (Array.isArray(fields)
        ? fields.some((f) => roomFieldHits(f, q))
        : String(row.dataset.kw || "").includes(q));
      row.hidden = !hit || !inScope;
      if (inScope) scope++;
      if (inScope && hit) shown++;
    }
    // 楼卡片：一间都没剩就整张收起来，剩几间就更新卡片右上角的计数（清空搜索时整页重绘复原）。
    for (const card of el.querySelectorAll("[data-room-bld]")) {
      const all = card.querySelectorAll(".jw-room-line").length;
      const left = card.querySelectorAll(".jw-room-line:not([hidden])").length;
      card.hidden = !left || (!!bldSel && card.dataset.roomBld !== bldSel);
      const sum = card.querySelector("[data-room-sum]");
      if (sum && q) sum.textContent = `${left} / ${all} 间匹配`;
    }
    for (const head of el.querySelectorAll("[data-room-group-head]")) {
      let n = 0, node = head.nextElementSibling;
      while (node && !node.hasAttribute("data-room-group-head")) {
        if (node.classList.contains("jw-room-row") && !node.hidden) n++;
        node = node.nextElementSibling;
      }
      head.hidden = !n;
    }
    const count = el.querySelector("[data-room-count]");
    if (count) {
      count.textContent = !q ? roomCountIdle || count.textContent
        : shown ? `匹配 ${shown} / ${bldSel ? `${bldSel} ` : "全部 "}${scope} 间教室`
          : `没有匹配「${raw}」的记录 —— 能搜楼（如 zl 找主楼、jtjs 找阶梯教室）、教室号、节次与占用状态；空格无所谓，也能打拼音首字母和跳字简写`;
    }
  }

  /* ── 我的考试视图（v0.272.0）──────────────────────────────────────────
     三格统计 + 学期胶囊 + 搜索 + 「待考 / 已结束」两组卡。三件小事值得说明：
     1) 只有「距下一场」允许变红。场次和日期跨度是静态事实，一页里给两处红等于都没给。
     2) 待考按时间正序（下一场在最上），已结束按时间倒序（最近考完的最上）——
        两边都是「离现在最近的先看到」。
     3) 本学期没有考试计划时（放假 / 新学期还没排考）不给你一屏空白：回退到最近一个
        学期并明说它已经考完了，否则用户会以为接口坏了。 */
  const examRowFields = new Map();  // idx → 这一场所有可搜字段（渲染时记，过滤时不重算）
  const examDetailFields = new Map(); // idx → 只在展开区露面的那几个字段（命中就把卡摊开）
  let examCountIdle = "";
  const examDayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  /* 胶囊文案取短：教务的 20252026-1 展开成「2025-2026 学年第 1 学期」要 18 个字，
     一排胶囊装不下三个学期。title 里放全名，屏幕上只留「25-26 第1学期」。 */
  function jwExamTermLabel(code) {
    const m = String(code || "").match(/^(\d{4})\d{4}-(\d+)$/);
    if (!m) return String(code || "");
    return `${m[1].slice(2)}-${String(Number(m[1]) + 1).slice(2)} 第${m[2]}学期`;
  }
  function jwExamGap(e) {
    const now = Date.now();
    if (!e.at) return { key: "unknown", text: "", tag: "" };
    if (now > e.endAt) return { key: "done", text: "", tag: "" };
    if (now >= e.at) return { key: "live", text: "进行中", tag: "live" };
    const days = Math.round((examDayStart(e.at) - examDayStart(now)) / 86400000);
    const text = days <= 0 ? "今天" : days === 1 ? "明天" : days === 2 ? "后天" : `${days} 天后`;
    // 三档色相各自不同才扫得出来：今天用 live（红、加粗，与「进行中」同义），明天 warn（黄），
    // 再往后 ok（青）。不新开 .jw-tag 的硬编码色 —— test-theme-contrast.mjs 数着那三条。
    return { key: "up", text, tag: days <= 0 ? "live" : days === 1 ? "warn" : "ok", days };
  }
  function jwExamCardHtml(e, idx, isNext) {
    const gap = jwExamGap(e);
    const done = gap.key === "done";
    const month = e.md ? `${Number(e.md.slice(0, 2))}月` : "";
    const open = e.id ? jwState.examOpen.has(e.id) : false;
    const tags = gap.tag ? jwTag(gap.text, gap.tag) : (done ? jwTag("已结束", "muted") : jwTag("日期待定", "muted"));
    // 时段只留时刻：日期已经由左边的日期块说了（「01-14 周三」写两遍是纯噪音）。
    const when = e.at
      ? `<b>${esc(e.start)}-${esc(e.end)}</b>`
      : esc(e.raw || "时间待定");
    /* 折叠起来只留「哪天 / 几点 / 在哪 / 什么状态」——这四样是扫一眼就要的。
       主考监考、课程编号、完整日期、教务原文时间都收进展开区：它们查的时候才看，平时占着
       三行会把一学期的考试拉成一屏两场。 */
    const where = e.place ? `<div class="jw-exam-where"><span class="jw-exam-wi">考场 <b>${esc(e.place)}</b></span></div>` : "";
    /* 「教务原文」只在**和解析结果不一样**时才给：正常一行「2026-01-13 14:00-15:50」和上面
       的日期/时段逐字相同，摆出来纯属重复；教务写成跨天、带「至」「上午」这类怪格式时才留着对照。 */
    const rawNorm = String(e.raw || "").replace(/\s+/g, "");
    const derived = e.at ? `${e.date}${e.start}-${e.end}` : "";
    const rawDiffers = !!e.at && !!rawNorm && rawNorm !== derived;
    const detail = [
      e.date ? ["日期", `${esc(e.date)}${e.day ? ` 周${esc(e.day)}` : ""}`] : "",
      e.code ? ["课程编号", `<span class="jw-tag jw-exam-code">${esc(e.code)}</span>`] : "",
      e.chief ? ["主考", esc(e.chief)] : "",
      e.watch ? ["监考", esc(e.watch)] : "",
      rawDiffers ? ["教务原文", esc(e.raw), "jw-exam-span"] : "",
    ].filter(Boolean).map(([k, v, cls]) => `<div${cls ? ` class="${cls}"` : ""}><b>${k}</b>${v}</div>`).join("");
    // 可搜字段逐格记：课程名 / 课程号 / 地点 / 主考 / 监考 / 日期 / 时段。
    // 不 join 成整串（铁律十的负例：join 后「张三 李四」会跨字段假命中）。
    examRowFields.set(idx, [e.course, e.code, e.place, e.chief, e.watch, e.md, e.date, e.start, e.end, e.raw].filter(Boolean));
    // 只出现在展开区的字段：命中它们时把卡自动摊开，否则搜「张老师」会得到一张看不见「张老师」的卡
    examDetailFields.set(idx, [e.code, e.chief, e.watch, e.raw, e.date].filter(Boolean));
    return `<div class="jw-exam-card${isNext ? " next" : ""}${done ? " done" : ""}${open ? " open" : ""}" data-exam-idx="${idx}" data-exam-id="${esc(e.id || "")}"
      role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}" aria-label="${esc(`${e.course || "考试"}，${e.md ? `${e.md} 周${e.day} ` : ""}${when.replace(/<[^>]+>/g, "")}${e.place ? `，考场 ${e.place}` : ""}，点开看详情`)}">
      <div class="jw-exam-date"><b>${esc(e.md ? e.md.slice(3).replace(/^0/, "") : "—")}</b><span>${esc(e.md ? `${month} · 周${e.day}` : "待定")}</span></div>
      <div class="jw-exam-main">
        <div class="jw-card-t">${esc(e.course || "未命名考试")}<span class="jw-exam-chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span></div>
        <div class="jw-exam-line"><div class="jw-exam-when">${when}</div>${where}${`<div class="pp-meta">${tags}</div>`}</div>
        <div class="jw-exam-fold"><div class="jw-exam-fold-clip"><div class="jw-exam-detail">${detail}</div></div></div>
      </div>
    </div>`;
  }
  function jwExamHtml() {
    const head = jwStateBlock("exam", "正在读取考试安排…");
    if (head) return jwSection("我的考试", jwAt("exam"), head);
    const d = jwState.data.exam;
    if (!d || !Array.isArray(d.plans)) return jwSection("我的考试", jwAt("exam"), `<div class="pp-empty">还没有拉取过考试安排，点上方「刷新」</div>`);
    if (!d.plans.length) {
      return jwSection("我的考试", jwAt("exam"),
        `<div class="pp-empty">教务没返回任何考试计划。若班里已发考试通知，点「浏览器打开」进「${JW_MENU.exam}」看看。</div>`);
    }
    const cur = d.current;
    const rows = Array.isArray(d.terms?.[cur]) ? d.terms[cur] : null;
    const terms = [...new Set(d.plans.map((p) => p.term))];
    const plan = d.plans.find((p) => p.term === cur) || d.plans[0];
    /* 学期胶囊：只有一个学期就不摆出来（一个选项的选项卡是噪音）。 */
    const chips = terms.length > 1
      ? `<div class="pp-toolbar jw-exam-terms"><span class="pp-lab">学期</span><div class="pp-chips" data-exam-terms>`
        + terms.map((t) => {
          const on = t === cur ? " on" : "";
          const p = d.plans.find((x) => x.term === t);
          return `<button type="button" class="pp-chip${on}" data-exam-term="${esc(t)}"${on ? ' aria-current="true"' : ""} title="${esc(`${jwTermName(t)}${p?.range ? ` · ${p.range}` : ""}`)}">${esc(jwExamTermLabel(t))}</button>`;
        }).join("")
        + `</div></div>`
      : "";
    // 搜索框 + 计数行做成函数：计数文案要等 rows 与分组算完才知道，而空态分支也得带这条工具栏
    const examBar = () => `<div class="pp-toolbar"><span class="pp-kwbox"><span class="pp-kw-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span>`
      + `<input class="pp-kw" data-exam-filter type="text" value="${esc(jwState.examFilter || "")}" aria-label="搜课程、考场、老师（支持拼音首字母与简写）" placeholder="搜课程 / 考场 / 老师…"></span></div>`
      + `<div class="pp-meta" data-exam-count>${esc(examCountIdle)}</div>`;
    if (!rows) {
      // 这一学期还没拉（点了胶囊正在补，或者补失败了）：给一句能懂的话，别留空白
      examCountIdle = "";
      return jwSection("我的考试", `${jwTermName(cur)}${plan?.range ? ` · ${plan.range}` : ""}`, chips + examBar()
        + `<div class="pp-empty">正在读取 ${esc(jwTermName(cur))} 的考试安排…若一直停在这，点「刷新」重试。</div>`);
    }
    examRowFields.clear();
    const startOfTerm = String(jwState.term?.code || "");
    const stale = startOfTerm && cur !== startOfTerm;
    if (!rows.length) {
      examCountIdle = plan?.name || "";
      return jwSection("我的考试", `${jwTermName(cur)}${plan?.range ? ` · ${plan.range}` : ""}`, chips + examBar()
        + `<div class="pp-empty">这个学期教务没给你的考试记录${stale ? "（它已经结束了）" : ""}。考试计划名称：${esc(plan?.name || cur)}；若班里已发通知，点「浏览器打开」查看。</div>`);
    }
    const now = Date.now();
    const up = [], done = [];
    rows.forEach((e, i) => { (e.at && now > e.endAt ? done : up).push([e, i]); });
    up.sort((a, b) => (a[0].at || 9e15) - (b[0].at || 9e15) || a[0].course.localeCompare(b[0].course));
    done.sort((a, b) => b[0].endAt - a[0].endAt);
    const nextId = up.length && up[0][0].at ? up[0][0].id : "";
    const dates = rows.filter((e) => e.md).map((e) => e.md).sort();
    const gap = up.length ? jwExamGap(up[0][0]) : null;
    const nextCell = gap
      ? { hot: gap.key === "live" || gap.days <= 1, value: gap.key === "live" ? "进行中" : gap.text, sub: up[0][0].course || "" }
      : { hot: false, value: "已结束", sub: "这个学期考完了" };
    /* 回退到别的学期时才解释「为什么不是本学期」；这句必须按**当前显示的学期**还有没有
       待考场次来写 —— 无条件写「已经考完了」会和下面的「3 场待考」正面打架。 */
    const notice = stale
      ? `<div class="jw-tip jw-exam-notice">${esc(jwTermName(startOfTerm))}教务还没排考，下面是${esc(jwTermName(cur))}的安排${up.length ? `（还有 ${up.length} 场没考）` : "（已经考完了）"}。</div>`
      : "";
    /* dates 里是 "MM-DD"（5 字符，别再 slice(5) —— 那会切出空串，卡片上只剩「考试跨度」四个字，
       看起来像大数字没渲染）。首末同一天就只写一个日期。 */
    const mdSpan = (() => {
      if (!dates.length) return "—";
      const a = dates[0].replace("-", ".");
      const b = dates[dates.length - 1].replace("-", ".");
      return a === b ? a : `${a}–${b}`;
    })();
    const sum = `<div class="jw-exam-sum">
      <div class="jw-exam-stat"><b>${rows.length}</b><span>场考试${up.length ? ` · ${up.length} 场待考` : " · 全部结束"}</span></div>
      <div class="jw-exam-stat${nextCell.hot ? " hot" : ""}"><b>${esc(nextCell.value)}</b><span>${esc(nextCell.sub || "下一场")}</span></div>
      <div class="jw-exam-stat" title="${esc(plan?.range || "")}"><b>${esc(mdSpan)}</b><span>考试跨度</span></div>
    </div>`;
    // 这行只放「这场考试叫什么」：场数已经在大数字和分组标题里各说一次，第三次就是噪音。
    examCountIdle = plan?.name || "";
    const groupUp = up.length
      ? `<div data-exam-group="up">${jwSection("待考", `${up.length} 场`, up.map(([e, i]) => jwExamCardHtml(e, i, e.id === nextId)).join(""))}</div>`
      : "";
    const groupDone = done.length
      ? `<div data-exam-group="done">${jwSection("已结束", `${done.length} 场`, done.map(([e, i]) => jwExamCardHtml(e, i, false)).join(""))}</div>`
      : "";
    return chips + notice + sum + examBar() + groupUp + groupDone;
  }
  /* 过滤同样在 DOM 上就地做（重绘会换掉 input，打一个字丢一次焦点）。
     命中口径直接复用 roomFieldHits：原文 / 拼音首字母 / 跳字简写，纯数字只认包含。 */
  function jwApplyExamFilter(el) {
    if (!el || !el.isConnected) return;
    const raw = String(jwState.examFilter || "").trim();
    // 按空白切成词，每个词都得落在**某个**字段上（AND 跨字段，但每个词只在单字段内比）：
    // 「2030 08:00」能搜到 1 月 15 号那场，而「张三 李四」不会因为拼成整串而假命中。
    const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
    // 首字母表按需加载：拉丁输入先不急着下结论，装好后原地重跑一次。
    // 用 `!roomPinyinLoading` 而不是 `!roomPinyinMod` 兜住加载失败的情况 ——
    // 失败时 roomPinyinMod 永远是 null，只看它就会「加载→重跑→再加载」微任务死循环。
    if (tokens.some((t) => /[a-z]/.test(t)) && !roomPinyinMod && !roomPinyinLoading) loadRoomPinyin().then(() => jwApplyExamFilter(el));
    const cards = el.querySelectorAll(".jw-exam-card");
    if (!cards.length) return;
    let shown = 0;
    for (const card of cards) {
      const idx = Number(card.dataset.examIdx);
      const fields = examRowFields.get(idx);
      const hit = !tokens.length || (Array.isArray(fields) && tokens.every((t) => fields.some((f) => roomFieldHits(f, t))));
      card.hidden = !hit;
      if (!hit) continue;
      shown++;
      /* 命中的词只出现在展开区（主考 / 监考 / 课程号 / 完整日期 / 教务原文）时自动摊开 ——
         否则等于给了一张「搜到了却看不见命中词」的卡。摊开只增不减，不动用户手开的那些。 */
      const fold = examDetailFields.get(idx);
      if (tokens.length && Array.isArray(fold) && Array.isArray(fields)) {
        const shownFields = fields.filter((f) => !fold.includes(f));
        if (tokens.some((t) => fold.some((f) => roomFieldHits(f, t)) && !shownFields.some((f) => roomFieldHits(f, t)))) {
          jwToggleExamCard(card, true);
        }
      }
    }
    // 一整个组都没剩就把它连标题一起收起来，避免一屏只剩「待考」「已结束」两个空标题
    for (const group of el.querySelectorAll("[data-exam-group]")) {
      group.hidden = !group.querySelector(".jw-exam-card:not([hidden])");
    }
    const count = el.querySelector("[data-exam-count]");
    if (count) {
      count.textContent = !tokens.length ? examCountIdle
        : shown ? `匹配 ${shown} / 全部 ${cards.length} 场`
          : `没有匹配「${raw}」的考试 —— 能搜课程名、课程号、考场、主考监考和日期；空格无所谓（多个词取交集），也能打拼音首字母（如 gs → 高等数学）和跳字简写`;
    }
  }
  /* 学期胶囊的滑动选中光（铁律六）：光块由宿主的 attachSelectionGlow 画，插件只负责
     在每次重绘后重挂一次 —— 重绘会把 [data-jw-body] 整个 innerHTML 换掉，光块跟着没了，
     旧实例必须 dispose，否则宿主那边会累积分区 Disposer。 */
  /* 点开/收起一张考试卡。状态同时记在 DOM（class/aria，供 CSS 与读屏）和 jwState.examOpen
     （按考试 ID，重绘后还在）——只记 DOM 的话过滤重绘一次就全收起来了。 */
  function jwToggleExamCard(card, force) {
    if (!card || !card.classList.contains("jw-exam-card")) return;
    const open = force === undefined ? !card.classList.contains("open") : !!force;
    card.classList.toggle("open", open);
    card.setAttribute("aria-expanded", open ? "true" : "false");
    const id = card.dataset.examId || "";
    if (!id) return;
    if (open) jwState.examOpen.add(id); else jwState.examOpen.delete(id);
  }
  const examGlows = new WeakMap();
  function jwSyncExamGlow(root) {
    if (!root || !root.isConnected) return;
    const box = root.querySelector("[data-exam-terms]");
    const prev = examGlows.get(root);
    if (prev && prev.box === box && box?.isConnected) { prev.glow?.sync?.(); return; }
    if (prev) { try { prev.glow?.dispose?.(); } catch { /* 宿主要是不给 dispose 就当它自己收 */ } examGlows.delete(root); }
    if (!box) return;
    const glow = tide.ui?.selectionGlow?.(box, { selector: ".pp-chip.on" });
    if (glow) examGlows.set(root, { box, glow });
  }

  /* 自习室的「日期」「楼」「节次」三组胶囊同样要滑动选中光（铁律六）：光块由宿主的
     tide.ui.selectionGlow 画在各自的 .pp-chips 上，插件每次重绘后重挂一次 ——
     body 被整个换掉，旧实例必须 dispose，否则宿主那边会累积分区 Disposer
     （与学期胶囊 jwSyncExamGlow 完全同一处教训）。 */
  const roomGlows = new WeakMap();   // root -> [{ box, glow }]
  function jwSyncRoomGlow(root) {
    if (!root || !root.isConnected) return;
    const boxes = [...root.querySelectorAll("[data-room-dates], [data-room-blds], [data-room-slots]")];
    const prev = roomGlows.get(root) || [];
    const same = prev.length === boxes.length && prev.every((p, i) => p.box === boxes[i] && p.box.isConnected);
    if (same) { for (const p of prev) p.glow?.sync?.(); return; }
    for (const p of prev) { try { p.glow?.dispose?.(); } catch { /* 宿主要是不给 dispose 就当它自己收 */ } }
    roomGlows.delete(root);
    const made = boxes
      .map((box) => ({ box, glow: tide.ui?.selectionGlow?.(box, { selector: ".pp-chip.on" }) }))
      .filter((p) => p.glow);
    if (made.length) roomGlows.set(root, made);
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
  /* 请假状态四档 → 成绩页分数四档的同名色（见 .jw-leave .jw-tag.* 注释）：
     2 已同意 → ok、1 审批中 → warn、3 未同意 → bad、0 已撤销 → muted，校方新加的未知码不给色。 */
  const jwLeaveTone = (code) => ({ "2": "ok", "1": "warn", "3": "bad", "0": "muted" }[String(code ?? "").trim()] || "");
  /* 指标行图标（v1.61.0）：与校历图标同一套语言 —— 纯线条、无底板、无投影、无渐变，
     线外一律不铺底色，落在 16 套主题的浅/深面板上都不带自己的色块。
     颜色取「白卡与深紫卡上都能看」的中间调（对 #FFF ≥3:1、对 #232029 ≥4.6:1），
     所以不需要按 data-theme-mode 出两套色板；线条与实心小块统一走 currentColor。
     画在标准 24 网格上（stroke 2.2、圆头圆角），width/height 就是视觉尺寸 —— 96 网格留白多，
     44px 盒里图形实际只有 22px，比例会偏小；24 网格下 30px 盒 ≈ 22.5px 图形，与 30px 金额相称。 */
  const METRIC_ICONS = {
    /* 一卡通三卡 */
    total: { color: "#4C8DE8", glyph: `<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>` },
    spent: { color: "#D98A0F", glyph: `<path d="M6.2 8.2h11.6v10.6a2.2 2.2 0 0 1-2.2 2.2H8.4a2.2 2.2 0 0 1-2.2-2.2V8.2z"/><path d="M9 8.2V6.6a3 3 0 0 1 6 0v1.6"/>` },
    balance: { color: "#22A55E", glyph: `<ellipse cx="12" cy="7.6" rx="6.2" ry="2.6"/><path d="M5.8 7.6v5.1c0 1.44 2.78 2.6 6.2 2.6s6.2-1.16 6.2-2.6V7.6"/><path d="M5.8 12.7v5.1c0 1.44 2.78 2.6 6.2 2.6s6.2-1.16 6.2-2.6v-5.1"/>` },
    /* 请假汇总四指标 */
    applyTotal: { color: "#4C8DE8", glyph: `<rect x="6" y="3.4" width="12" height="17.2" rx="2.2"/><path d="M9.2 8.4h5.6M9.2 12h5.6M9.2 15.6h3.6"/>` },
    approved: { color: "#22A55E", glyph: `<path d="M5.4 12.6l4.1 4.4L18.6 7"/>` },
    pending: { color: "#D98A0F", glyph: `<path d="M6.8 3.4h10.4M6.8 20.6h10.4"/><path d="M8 3.4c0 4.2 4 5.2 4 8.6s-4 4.4-4 8.6"/><path d="M16 3.4c0 4.2-4 5.2-4 8.6s4 4.4 4 8.6"/>` },
    rejected: { color: "#D9453F", glyph: `<path d="M7.2 7.2l9.6 9.6M16.8 7.2L7.2 16.8"/>` },
  };
  const METRIC_ICON_KEYS = Object.keys(METRIC_ICONS);
  function metricIcon(key, size = 28) {
    const set = METRIC_ICONS[key];
    if (!set) return "";
    return `<svg class="pp-metric-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
      + ` style="color:${set.color}" aria-hidden="true" focusable="false">`
      + `<g stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">`
      + set.glyph + `</g></svg>`;
  }
  /* 首屏汇总与成绩页同构：同一个 .jg-card + .jg-metrics 骨架，指标名 11px --ink-3、数值 19px --ink，
     语义数字借 .jg-good / .jg-warn / .jg-bad —— 两页的「一屏概览」看起来才是同一套界面。 */
  function jwLeaveSummaryHtml() {
    const rec = Array.isArray(jwState.data.qjRecord) ? jwState.data.qjRecord : [];
    const courses = Array.isArray(jwState.data.qjCourse) ? jwState.data.qjCourse : [];
    if (!rec.length && !courses.length) return "";
    const count = (code) => rec.filter((r) => String(r.SQZT ?? "").trim() === code).length;
    const ok = count("2");
    const pending = count("1");
    const rest = rec.length - ok - pending;
    const metrics = [["申请总数", rec.length, "", "applyTotal"], ["已同意", ok, "jg-good", "approved"], ["审批中", pending, "jg-warn", "pending"], ["未通过 / 已撤销", rest, rest ? "jg-bad" : "", "rejected"]]
      .map(([label, value, tone, key]) => `<div><div class="jg-metric">${metricIcon(key, 26)}<span class="jg-metric-text"><b${tone ? ` class="${tone}"` : ""}>${value}</b><small>${label}</small></span></div></div>`).join("");
    return `<section class="jg-card"><div class="jg-metrics">${metrics}</div>
      <div class="jg-note">可请假课次 ${courses.length} 节 · 汇总按教务返回的申请状态统计，提交入口仍在学校教务。</div></section>`;
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
            jwTag(jwDict("SQZT", r.SQZT), jwLeaveTone(r.SQZT)),
          ])}
          ${r.SQYY ? `<div class="jw-why">${esc(r.SQYY)}</div>` : ""}
        </div>`).join("") : `<div class="pp-empty">还没有提交过请假申请</div>`);
    return `<div class="jw-leave">`
      + jwLeaveSummaryHtml()
      + jwSection("请假记录", `${Array.isArray(rows) ? rows.length + " 条 · " : ""}${jwAt("qjRecord")}`, records)
      + jwSection("可提请假的课次", jwAt("qjCourse"), jwCourseScopeBar() + jwCourseList())
      + `</div>`;
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
      // 三态：拿满学分 / 有成绩但没拿到 / 还在修（没成绩）。教务只给 SFHDXF，
      // 没出分的课若按「未获得」画红框，会让人以为自己挂了。
      const done = jwGradeDone(r);
      const scored = r.ZPCJ != null && String(r.ZPCJ).trim() !== "";
      const tone = done ? "done" : scored ? "fail" : "doing";
      const label = done ? "已获得学分" : scored ? "未获得学分" : "在修 · 未出分";
      return `<div class="jw-card jw-credit-course ${tone}">
        <div class="jw-card-t">${esc(r.KCMC || "（未命名课程）")}</div>
        ${jwMetaLine([
          jwTag(`${Number(r.XF) || 0} 学分`, done ? "ok" : scored ? "warn" : "muted"),
          jwTag(label, done ? "ok" : scored ? "live" : "muted"),
          scored ? jwTag(`成绩 ${r.ZPCJ}`) : "",
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
    return `<div class="jg-status">${jwState.at.grade ? `更新于 ${esc(jwAt("grade").replace("更新于 ", ""))} · ` : ""}共 ${rows.length} 门 · 总学分 ${credits.toFixed(1)} · GPA ${gpa.toFixed(3)}</div>${gradeCard("", overview)}${pdataRankCard()}${pdataRadarCard()}${trend}${progress}${distribution}${category}${exportCard}${semesters}`;
  }

  /* ── 「绩点排名情况」与「六维图」（个人成长中心）──
     与成绩总览同屏，数据来自 pdata，跟教务成绩是两条链路，所以单独一个 stateBlock：
     教务成绩拉失败时它照样显示，pdata 挂了也只让这两张卡自己说话。 */
  const PDATA_SOURCE_NOTE = "数据来源：教务系统（学生个人成长中心，按学期批量计算）";
  // pdata 说 0 就画 0（跟成长中心前端一致），「还没算出来」用 noData 单独表达
  const pdataRankValue = (n) => (n > 0 ? String(n) : "0");
  const pdataRankHasData = (s) => PDATA_RANK_KEYS.some((k) => Number(s?.rank?.[k]) > 0);

  /* 站点「绩点排名情况」四档图标：成长中心把图标内联在 umi.js 里（54×59 PNG 的 data URI），
     这里原样内嵌、不重画不改色 —— 站点长什么样，插件就长什么样。
     四个键与 PDATA_RANK_KEYS 一一对应：QXPM 全校 / XYPM 学院 / ZYPM 专业 / BJPM 班级。 */
  const PDATA_RANK_ICONS = {
    QXPM: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAAA7CAYAAAAw23kDAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyVpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTQ4IDc5LjE2NDAzNiwgMjAxOS8wOC8xMy0wMTowNjo1NyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDIxLjAgKE1hY2ludG9zaCkiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6QjNENUY4NDVGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6QjNENUY4NDZGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDpCMkZCMEUwMEZBMjAxMUVBOTAyN0FFRTYzOTU5NTMxQiIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDpCM0Q1Rjg0NEZBMjAxMUVBOTAyN0FFRTYzOTU5NTMxQiIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/Psh5C3AAAA12SURBVHjavFoJ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",
    XYPM: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAAA7CAYAAAAw23kDAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyVpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTQ4IDc5LjE2NDAzNiwgMjAxOS8wOC8xMy0wMTowNjo1NyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDIxLjAgKE1hY2ludG9zaCkiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6QjJGQjBERkVGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6QjJGQjBERkZGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDpCMkZCMERGQ0ZBMjAxMUVBOTAyN0FFRTYzOTU5NTMxQiIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDpCMkZCMERGREZBMjAxMUVBOTAyN0FFRTYzOTU5NTMxQiIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/PgWx+g8AAAsfSURBVHjavFoL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",
    ZYPM: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAAA7CAYAAAAw23kDAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyVpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTQ4IDc5LjE2NDAzNiwgMjAxOS8wOC8xMy0wMTowNjo1NyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDIxLjAgKE1hY2ludG9zaCkiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6QjJGQjBERkFGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6QjJGQjBERkJGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDpCMkZCMERGOEZBMjAxMUVBOTAyN0FFRTYzOTU5NTMxQiIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDpCMkZCMERGOUZBMjAxMUVBOTAyN0FFRTYzOTU5NTMxQiIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/Pou/Fe4AAAzASURBVHjatFoJ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",
    BJPM: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAAA7CAYAAAAw23kDAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyVpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTQ4IDc5LjE2NDAzNiwgMjAxOS8wOC8xMy0wMTowNjo1NyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDIxLjAgKE1hY2ludG9zaCkiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6QjJGQjBERjZGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6QjJGQjBERjdGQTIwMTFFQTkwMjdBRUU2Mzk1OTUzMUIiPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDpEOTlCODY3RkZBMUYxMUVBOTAyN0FFRTYzOTU5NTMxQiIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDpEOTlCODY4MEZBMUYxMUVBOTAyN0FFRTYzOTU5NTMxQiIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/PlBRalcAAA9LSURBVHjarFoJ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",
  };


  function pdataRankCard() {
    const state = jwState.data.pdataStudy;
    const head = jwStateBlock("pdataStudy", "正在读取绩点排名…");
    if (head) return gradeCard("🏅 绩点排名情况", head);
    if (!state) return gradeCard("🏅 绩点排名情况", `<div class="pp-empty">还没有拉取过绩点排名，点上方「刷新」</div>`);
    if (state.auth) return gradeCard("🏅 绩点排名情况", `<div class="pp-empty">个人成长中心的登录态不在：先到「警大通知」登录一次，再回本页点「刷新」</div>`);
    if (!state.ok) return gradeCard("🏅 绩点排名情况", `<div class="pp-empty">${esc(state.message || "个人成长中心暂未返回绩点排名")}</div>`);
    /* 版式照抄站点（.myRank / .myRank_item）：左边 65px 圆底 + 36×40 图标，
       右边上面是 20px 的排名数字、下面是灰字标签。数字一律用站点那个蓝（#2a7eff），
       不按档位换色 —— 站点四档就是同一个蓝。 */
    const items = [
      ["全校排名", "QXPM"],
      ["学院排名", "XYPM"],
      ["专业排名", "ZYPM"],
      ["班级排名", "BJPM"],
    ].map(([label, key]) => `<div class="jg-rank-item">
        <span class="jg-rank-badge"><img src="${PDATA_RANK_ICONS[key]}" alt="" width="36" height="40" decoding="async"></span>
        <span class="jg-rank-right"><b class="jg-rank-num">${pdataRankValue(state.rank?.[key])}</b><small>${esc(label)}</small></span></div>`).join("");
    const noData = !pdataRankHasData(state)
      ? `<div class="jg-note">成长中心暂未算出你的排名（排行按学期批量生成，新生入学首学期通常为空）</div>` : "";
    return gradeCard("🏅 绩点排名情况", `<div class="jg-rank-grid">${items}</div>${noData}
      <div class="jg-note">${esc(PDATA_SOURCE_NOTE)}</div>`);
  }

  /* 成长中心的「六维图」实为圆形雷达图：轴 = 全校 / 学院 / 专业 / 班级，
     轴刻度 = 该档的学霸绩点（topPoint），两组数据分别是学霸绩点与本人绩点。
     这里用内联 SVG 重画（插件里不引 echarts）：半径 65%、4 环、起点 -90°。 */
  function pdataRadarSvg(myPoint, topPoint) {
    const axes = PDATA_RANK_TYPES.map((label, i) => ({
      label,
      mine: Number(myPoint?.[PDATA_RANK_KEYS[i]]) || 0,
      top: Number(topPoint?.[PDATA_RANK_KEYS[i]]) || 0,
    }));
    const size = 240, cx = size / 2, cy = size / 2, radius = size * 0.30;
    const angle = (i) => (-90 + i * 360 / axes.length) * Math.PI / 180;
    const at = (i, r) => [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r];
    const ring = (ratio) => axes.map((_, i) => at(i, radius * ratio).map((n) => n.toFixed(1)).join(",")).join(" ");
    const path = (pick) => axes.map((a, i) => at(i, radius * Math.max(0, Math.min(1, a.top ? a[pick] / a.top : 0)))
      .map((n) => n.toFixed(1)).join(",")).join(" ");
    const spokes = axes.map((_, i) => {
      const [x, y] = at(i, radius);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    }).join("");
    const labels = axes.map((a, i) => {
      const [x, y] = at(i, radius + 20);
      const anchor = Math.abs(x - cx) < 1 ? "middle" : (x > cx ? "start" : "end");
      return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${esc(a.label)}</text>`;
    }).join("");
    return `<svg class="jg-radar" viewBox="0 0 ${size} ${size}" role="img" aria-label="本人绩点与学霸绩点对比雷达图：${esc(axes.map((a) => `${a.label} 本人 ${a.mine} 学霸 ${a.top}`).join("，"))}">
      <g class="jg-radar-grid">${[0.25, 0.5, 0.75, 1].map((r) => `<polygon points="${ring(r)}"/>`).join("")}${spokes}</g>
      <polygon class="jg-radar-top" points="${path("top")}"/>
      <polygon class="jg-radar-mine" points="${path("mine")}"/>
      <g class="jg-radar-label">${labels}</g>
    </svg>`;
  }

  function pdataRadarCard() {
    const state = jwState.data.pdataStudy;
    const head = jwStateBlock("pdataStudy", "正在读取绩点对比…");
    if (head) return gradeCard("🕸 六维图", head);
    if (!state) return gradeCard("🕸 六维图", `<div class="pp-empty">还没有拉取过学情数据，点上方「刷新」</div>`);
    if (state.auth) return gradeCard("🕸 六维图", `<div class="pp-empty">个人成长中心的登录态不在：先到「警大通知」登录一次，再回本页点「刷新」</div>`);
    if (!state.ok) return gradeCard("🕸 六维图", `<div class="pp-empty">${esc(state.message || "个人成长中心暂未返回学情数据")}</div>`);
    const hasTop = PDATA_RANK_KEYS.some((k) => Number(state.topPoint?.[k]) > 0);
    if (!hasTop) return gradeCard("🕸 六维图",
      `<div class="pp-empty">成长中心暂未算出绩点对比（新生入学首学期通常为空）</div><div class="jg-note">${esc(PDATA_SOURCE_NOTE)}</div>`);
    const legend = `<div class="jg-legend">
      <span><i class="mine"></i>本人绩点</span><span><i class="top"></i>学霸绩点</span></div>`;
    return gradeCard("🕸 六维图", `${legend}${pdataRadarSvg(state.myPoint, state.topPoint)}
      <div class="jg-note">轴为全校 / 学院 / 专业 / 班级四档，外环刻度是各档的学霸绩点；${esc(PDATA_SOURCE_NOTE)}</div>`);
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
    // 只信 canShare 的正向结论：桌面端 WebView 里 navigator.share 存在但没实现文件分享，
    // 直接调用会弹出空白的系统共享面板且永不 reject，把下面的落盘兜底整个截胡。
    const canShareFile = typeof navigator.canShare === "function"
      && typeof navigator.share === "function"
      && navigator.canShare({ files: [file] });
    if (canShareFile) {
      try { await navigator.share({ files: [file], title: "分享成绩单" }); return; } catch (e) { if (e?.name === "AbortError") return; }
    }
    // Android / Tauri WebView 的 <a download> 不可靠，落盘走宿主已有的下载桥。
    try {
      const path = await tide.assets.saveBase64(name, canvas.toDataURL("image/png").split(",")[1]);
      notifySaved(`成绩单图片已保存：${path}`, path);
    } catch (e) { tide.notify(`保存成绩单失败：${String(e?.message || e)}`); }
  }

  const JW_VIEWS = [
    {
      // qjCourse 一并拉：已选课程卡片上的「剩余学时」要用它的 KXXS 课序学时与 SKRQ 上课日
      // （选课结果视图没有学时段），拉不到只是少一枚标签，不影响课表本身。
      id: "cppu-xk", title: "警大选课", icon: "list-check", keys: ["xkTask", "xkResult", "qjCourse"], menu: JW_MENU.xk,
      kicker: "教 务 · 学 生 选 课",
      tip: "选择任务可进入 U-Time 选课页查看状态与本学期已选课程；卡片上的「剩余学时」按教务课次表算（总学时 − 已上），慕课这类没排课次的课程不显示。已结束和过期任务会自动置灰。",
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
      id: "cppu-credit", title: "警大成绩", icon: "chart-line", keys: ["grade", "pdataStudy"], menu: JW_MENU.grades,
      kicker: "教 务 · 成 绩",
      tip: "课程成绩、学分和 GPA 按教务原始记录汇总。参考毕业学分仅供参考；刷新可重新读取学校数据。",
      body: () => jwGradesHtml(),
    },
    {
      /* 我的学分（v0.272.3）：教务「学生服务 › 我的学业 › 成绩 › 我的学分」，
         功能码 V_JWBZK_XKGL_XKQK —— 就是 JW_FUNC.creditModule（一行一个课程模块，
         自带 要求/获得/在修/待修 四列），配 creditPlan（培养计划总学分）
         与 grade（课程成绩）挂明细。
         渲染体 jwAcademicCreditHtml() 本来就在插件里、也有测试守着，只是从来没有入口；
         这个视图只做接线，不另写一套学分口径 —— 两份算法迟早对不上。
         学分是全校口径、不按学期切，所以这一页没有学期胶囊。
         icon 用 scroll（卷轴 = 账本）：学分是「离毕业还差多少」，与成绩页的 chart-line
         读起来不是同一件事（同侧栏放两张图表会混）。
         不用 graduation-cap —— 那是 learning 侧栏 chaoxing-notify 的图标，
         同一条侧栏里撞图标会被 test-plugin-view-icons 拦下。 */
      id: "cppu-credit-ledger", title: "警大学分", icon: "scroll",
      keys: ["creditPlan", "creditModule", "grade"], menu: JW_MENU.credit,
      kicker: "教 务 · 我 的 学 分",
      tip: "按课程模块看学分账本：要求、已获得、在修、待修；点分类卡展开模块与课程明细。数字取自教务「我的学分」，只读 —— 学分认定与免修仍在教务里办。",
      body: () => jwAcademicCreditHtml(),
    },
    {
      id: "cppu-cx", title: "警大创新学分", icon: "medal", keys: ["cxCredit", "cxDetail"], menu: JW_MENU.cx,
      kicker: "教 务 · 创 新 实 践 学 分",
      tip: "按学期显示创新实践申报项目、级别、奖项、认定学分和审核状态。",
      body: () => jwInnovationCreditHtml(),
    },
    {
      // 我的考试（v0.272.0）：校方在 学生服务 › 我的考试 › 我的考试计划 下，功能码
      // V_JWBZK_KWGL_KS_STU（考试计划）+ V_JWBZK_KWGL_KSRW_STU（我本人的每一场）。
      // icon 用 clock —— 这一页读的是「几点考、还有几天」；calendar-days / -week / -xmark
      // 已被校历、选课、请假占掉。solid 精灵里**没有** calendar-clock，别写它：
      // 引用不存在的 symbol 会画出一个空图标（v0.272.0 实测踩过）。
      id: "cppu-exam", title: "警大考试", icon: "clock", keys: ["exam"], menu: JW_MENU.exam,
      kicker: "教 务 · 我 的 考 试",
      tip: "按学期显示你的每一场考试：日期、时段、考场与主考监考。待考按时间正序排在前面，已结束的收在下面。只读 —— 缓考/免考申请仍在教务里提交。",
      body: () => jwExamHtml(),
    },
    {
      // 自习室查询（教室占用 / 借用）：校方挂在 学生服务 › 公共服务 下，nodeInfo=ZXZYCX。
      // icon 用 door-open —— 一扇开着的门，语义直给，且与教务子菜单里其余视图图标不撞。
      // 只读：申请借用仍去教务提交（与交请假、选课同一条口径）。
      id: "cppu-room", title: "自习室", icon: "door-open", keys: ["room"], menu: JW_MENU.room,
      kicker: "教 务 · 自 习 室 查 询",
      tip: "教室占用与开放时段按楼与教室分组；可切成按日期看或平铺，也能按楼 / 节次 / 状态筛选。申请借用仍在教务里提交。",
      body: () => jwRoomHtml(),
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
        <button class="pp-btn" data-jw-back>回通知</button>
        <button class="pp-btn" data-jw-login>重新登录</button>
        <button class="pp-btn" data-jw-site>浏览器打开</button>
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
      // v0.272.0：body 整个换掉了 ⇒ 学期光块要重挂、已有搜索词要重新套一遍，
      // 否则切一次学期/刷一次新，过滤看起来就「失灵」了（与自习室同一处教训）
      jwSyncExamGlow(m.el);
      jwSyncRoomGlow(m.el);
      jwApplyExamFilter(m.el);
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
    // 刷新必须「一按就有动静」：真机（尤其 APK）上取一次数可能要好几秒，
    // 期间按钮若毫无反馈，用户会当成按钮坏了，于是连点三五下——那才是最坏的结果。
    // 所以按钮先变成「刷新中…」并禁用，回来再给一句结果：数据没变就说「已是最新」，
    // 别让人盯着同一屏以为没刷成。
    const jwDataSig = (keys) =>
      keys
        .map((k) => {
          const v = jwState.data[k];
          if (Array.isArray(v)) return v.length;
          if (v && v.terms) return Object.values(v.terms).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
          return v ? 1 : 0;
        })
        .join("/");
    const jwRefreshWithFeedback = async (btn, keys) => {
      // btn 可能是 null（合成事件 / 横幅里的子节点），也可能不是真元素：那就只管刷新，别去摸 dataset。
      if (!btn || !btn.dataset) { await jwEnsureKeys(keys, true); return; }
      if (btn.dataset.jwBusy === "1") return;
      const before = jwDataSig(keys);
      const label = btn && btn.dataset.jwRefresh !== undefined ? btn.textContent : "";
      if (btn) {
        btn.dataset.jwBusy = "1";
        btn.disabled = true;
        btn.classList.add("is-busy");
        if (label) btn.textContent = "刷新中…";
      }
      try {
        await jwEnsureKeys(keys, true);
        const changed = jwDataSig(keys) !== before;
        if (changed) tide.notify("已刷新");
        else tide.notify("已是最新，教务那边没有新数据");
      } finally {
        if (btn) {
          btn.dataset.jwBusy = "";
          btn.disabled = false;
          btn.classList.remove("is-busy");
          if (label) btn.textContent = label;
        }
      }
    };
    /* 换自习室的查看日期。今天用 "" 表示（让服务端 SYSDATE 决定，少一次参数特判）；
       换天必须清掉 room 缓存 —— 那份行是别的日子的，留着就会被当成今天的数据显示。 */
    const jwSetRoomDate = async (day) => {
      const d = String(day || "");
      const norm = d === jwDayISO(0) ? "" : d;
      if (norm === jwState.roomDate) return;
      jwState.roomDate = norm;
      jwState.data.room = null;
      jwState.at.room = 0;
      jwState.error.room = "";
      jwPaint();
      jwSyncRoomGlow(el);
      await jwEnsureKeys(["room"]);
      if (!el.isConnected) return;
      jwSyncRoomGlow(el);
      jwApplyRoomFilter(el);
      await jwSaveCache();
    };
    el.addEventListener("click", async (e) => {
      if (e.target.closest("[data-jw-login]")) { await openLogin(); return; }
      if (e.target.closest("[data-jw-refresh]")) {
        await jwRefreshWithFeedback(e.target.closest("[data-jw-refresh]"), cfg.keys);
        return;
      }
      // 横幅（登录失败 / 拉取失败 / 解析失败）也是刷新入口：与上方「刷新」走同一条通路。
      // 点哪一条都刷整个视图的 keys —— 登录失败时每条横幅都挂了同一个错，
      // 只刷被点的那条会让另一条留着旧提示，看着像「刷了没用」。
      if (e.target.closest("[data-jw-banner-refresh]")) {
        await jwRefreshWithFeedback(e.target.closest("[data-jw-banner-refresh]"), cfg.keys);
        return;
      }
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
      // 自习室按楼收窄（v0.275.0）：只改 jwState 再重绘，卡片显隐由渲染层的 visible 与
      // jwApplyRoomFilter 的 scope 共同决定 —— 搜索词必须就地重套一遍，否则选楼之后
      // 之前打的过滤词看着还在输入框里、却没有生效。
      const roomBldChip = e.target.closest("[data-room-bld-chip]");
      if (roomBldChip) {
        jwState.roomBld = roomBldChip.dataset.roomBldChip || "";
        jwPaint();
        jwSyncRoomGlow(el);
        jwApplyRoomFilter(el);
        return;
      }
      // 自习室节次切换：重绘后要把已有的过滤词再套一遍，否则切一次节次过滤就「失效」了
      const roomSlot = e.target.closest("[data-room-slot]");
      if (roomSlot) {
        jwState.roomSlot = roomSlot.dataset.roomSlot || "all";
        jwPaint();
        jwSyncRoomGlow(el);
        jwApplyRoomFilter(el);
        return;
      }
      // 自习室换日期：缓存里那份是别的日子，清掉再拉（不 force —— force 会重跑登录判定）
      const roomDay = e.target.closest("[data-room-date]");
      if (roomDay) {
        await jwSetRoomDate(roomDay.dataset.roomDate || "");
        return;
      }
      if (e.target.closest("[data-room-date-btn]")) {
        el.querySelector("[data-room-date-in]")?.showPicker?.();
        return;
      }
      // 考试学期切换：已有数据的学期直接换看，没拉过的补一次再重绘。
      // 补数失败只弹提示 —— 失败的是「另一个学期」，不该把已画好的这一页换成红横幅。
      const examTerm = e.target.closest("[data-exam-term]");
      if (examTerm) {
        const term = examTerm.dataset.examTerm || "";
        const d = jwState.data.exam;
        if (term && d && term !== d.current) {
          d.current = term;
          jwPaint();
          jwSyncExamGlow(el);
          jwApplyExamFilter(el);
          if (!Array.isArray(d.terms?.[term])) {
            try { await jwEnsureExamTerm(term); } catch (err) { tide.notify(`读取 ${jwExamTermLabel(term)} 的考试安排失败：${err?.message || err}`, { ms: 6000 }); }
            if (el.isConnected) { jwPaint(); jwSyncExamGlow(el); jwApplyExamFilter(el); }
          }
          await jwSaveCache();
        }
        return;
      }
      // 考试卡摊开/收起：整张卡自己就是按钮（role="button"），点卡上任何位置都算 ——
      // 卡片里没有输入控件，所以不担心误触。开着的卡按考试 ID 记在 jwState.examOpen，重绘后自动还原。
      const examCard = e.target.closest(".jw-exam-card");
      if (examCard && el.contains(examCard)) {
        jwToggleExamCard(examCard);
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
      // 自习室过滤：只改显隐、不调 jwPaint()，否则输入框会被换掉、每打一个字丢一次焦点
      if (e.target.matches("[data-room-filter]")) {
        jwState.roomFilter = e.target.value;
        jwApplyRoomFilter(el);
      }
      if (e.target.matches("[data-exam-filter]")) {
        jwState.examFilter = e.target.value;
        jwApplyExamFilter(el);
      }
    });
    // 原生日期选择器选完 → 换天（change 冒泡到容器上，日期框是浮层里唯一带这个属性的）
    el.addEventListener("change", (e) => {
      if (!e.target.matches?.("[data-room-date-in]")) return;
      jwSetRoomDate(e.target.value || "");
    });
    // 键盘也能摊开考试卡：卡片的 role="button" + tabindex 只是「看起来能按」，
    // 空格/回车得自己接（原生 button 才有默认行为）。只在焦点就在卡本身时处理，
    // 卡里的输入框（目前没有）将来也不会被抢走按键。
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      if (!e.target.matches?.(".jw-exam-card")) return;
      e.preventDefault();
      jwToggleExamCard(e.target);
    });
    (async () => {
      await loadPrefs();
      await jwRestoreCache();
      jwPaint();
      jwSyncRoomGlow(el);
      jwApplyRoomFilter(el);
      jwApplyExamFilter(el);
      await jwEnsureKeys(cfg.keys);
      jwApplyRoomFilter(el);
      jwApplyExamFilter(el);
      // 登录失败保留已有缓存；没有缓存时显示共用登录卡。
      // 考试是对象（不是数组），缓存判定要单独放行，否则有考试的号也会被当成「没有缓存」
      // 而拉出登录卡，把刚读到的一整页考试挡在后面。
      if (!jwLive() && el.isConnected && cfg.keys.some(key => Array.isArray(jwState.data[key]) || (key === "exam" && jwState.data.exam?.plans?.length))) {
        for (const key of cfg.keys) jwState.error[key] = `登录失败，正在显示缓存（${jwAt(key)}）；点这条横幅或上方「刷新」可重试，需要重新登录时点「重新登录」。`;
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

  /* ═════════ 警大获奖名单（cppu-award） ═════════
     为什么单开一个视图、而不是在通知列表上加一个筛选项：获奖信息散在几十条通知的正文里，
     而用户想要的是「谁得了什么奖」的横向视图（按项目排下来、按获奖数量排名），
     跟「按时间读通知」是两种读法 —— 塞进筛选器只会让通知视图多出一堆跟读通知无关的状态。
     数据源与通知视图完全同一份 state.notices / state.details（同一次登录、同一份正文缓存），
     解析与渲染全在 award-list.js，这里只管取数、进度与骨架，所以主文件没有因此变胖。
     口径：只认正文里明确的获奖段落，宁少不滥；每条记录都能点回原通知核对。 */
  function awShellHtml() {
    return `<div class="${sideShellClass()}">
      <aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}
      <div class="pp-main"><div class="pp-wrap">
      <div class="pp-toolbar">
        <button class="pp-btn pri" data-aw-sync>刷新名单</button>
        <button class="pp-btn" data-aw-deeper title="再往回翻 500 条通知">再往前翻</button>
        <button class="pp-btn" data-aw-notify>回通知</button>
        <button class="pp-btn" data-aw-relogin>重新登录</button>
        <span style="flex:1"></span>
      </div>
      <div data-aw-status></div>
      <div data-aw-panel></div>
      <div style="height:30px"></div>
      </div></div>
    </div>`;
  }

  /* 进度行：与 award-list.js 的「统计口径」并排读得通 —— 这里说「扫了多少、翻到哪一年」，
     那里说「认了多少」。 */
  function awStatusLine() {
    if (awState.progress) return awState.progress;
    if (!awState.board) return `还没同步过：点「刷新名单」开始（往回翻通知到 ${AWARD_YEARS} 个自然年，逐条读正文筛获奖名单；正文里说「名单见附件」的再去读那份附件）`;
    const s = awState.board.stats;
    const at = awState.syncedAt ? new Date(awState.syncedAt).toLocaleString("zh-CN", { hour12: false }) : "—";
    const cov = awCoverage();
    // 缓存直出：这一轮没拉过通知列表（state.notices 为空），所以绝不能沿用下面那句「已扫 N 条通知」——
    // 那会读成「扫了 0 条」。只说这份名单本身，外加它是什么时候的、怎么更新。
    if (awState.cacheOnly) {
      return `本机缓存 · 奖项 ${s.awards} 人次 · 同步于 ${at} · 点「刷新名单」重新同步`;
    }
    // 一轮读到底之后，这里的非零只可能来自「撞上单轮预算」或「会话掉线」两种极端情况，
    // 所以要把话说明白：这是本轮的上限，不是「名单就这些」。
    const pending = awState.pendingCands
      ? ` · 还有 ${awState.pendingCands} 条候选没读完（本轮到了单轮上限，再点一次接着读）`
      : "";
    const affix = awState.affixCount
      ? ` · 读到附件名单 ${awState.affixCount} 份${awState.affixWait ? `（还有 ${awState.affixWait} 份本轮没读，再点一次接着读）` : ""}`
      : "";
    // 门户会把同一批成绩发两条通知（正文名单一条、附件成绩报告单一条）：award-list 已合并计数，
    // 这里要说出来，否则用户对不上上一版的通知条数。
    const merged = s.merged ? `（同一奖项重复发布 ${s.merged} 条已合并）` : "";
    return `${state.username ? `学号 ${state.username} · ` : ""}已扫 ${state.notices.length} 条通知${cov ? `（覆盖 ${cov}）` : ""} · 命中获奖通知 ${s.notices} 条${merged} · 奖项 ${s.awards} 人次${pending}${affix} · 同步于 ${at}`;
  }
  function awPaint(el) {
    if (!el || el.isConnected === false) return;
    const box = el.querySelector("[data-aw-status]");
    if (box) {
      // 失败时整条状态行就是重试入口（与通知视图同一种横幅，用户不必去别处找刷新）
      box.innerHTML = awState.error && !awState.progress
        ? bannerRefreshHtml(awState.error, "aw-banner-refresh")
        : `<div style="margin:2px 0 10px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)">${esc(awStatusLine())}</div>`;
    }
    awardPanel?.render(el.querySelector("[data-aw-panel]"), awState.board, {
      syncedAt: awState.syncedAt, progress: awState.progress, error: awState.error,
      onOpenSource: (rid) => awOpenNotice(rid),
    });
  }

  /* 同步进行中只刷状态行：`awState.board` 这时候还是**上一轮的榜单**（本轮要等候选全读完
     才重算），所以每读完一条正文就 awPaint 一次，等于把一份完全没变的榜单整段重绘几百遍 ——
     本机白烧 CPU，界面上还会一路闪。读正文/读附件这两段循环只改进度文字，走这条。 */
  function awStatusOnly(el) {
    if (!el || el.isConnected === false) return;
    const box = el.querySelector("[data-aw-status]");
    if (!box) return;
    box.innerHTML = awState.error && !awState.progress
      ? bannerRefreshHtml(awState.error, "aw-banner-refresh")
      : `<div style="margin:2px 0 10px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)">${esc(awStatusLine())}</div>`;
  }

  /* 「来源通知」按钮：切回通知视图并把那条通知展开 —— 名单是从那句话里抽出来的，
     能一眼看到原句才算可核对（这也是不做原文照搬的前提）。
     个人 / 团体排名里的每一条获奖记录都挂这个按钮，所以点「个人项目里面那条通知」也能回原通知。 */
  function awOpenNotice(rid) {
    if (!rid) return;
    if (state.notices.some((x) => itemKey(x) === rid)) {
      state.expanded.add(rid);
      setSeen(rid);
    } else {
      // 名单是从缓存恢复的、而这条通知还没被翻进列表（回溯页数不够）：说一句话，
      // 别让点击看起来像没反应。
      tide.notify("这条来源通知还没在列表里（点「刷新名单」或去通知页往前翻可以把它拉进来）", { ms: 6000 });
    }
    tide.util.navigate("plug:cppu-notify");
  }

  // 取模块里的纯函数（titleLooksAward / parseAwardNotice / buildAwardBoard）供同步流程用，
  // 顺带把面板渲染器建起来 —— 面板要用宿主的滑动选中光（铁律六同一套实现），
  // 插件拿不到 src/selectionGlow.js，只能让宿主开出来的 tide.ui.selectionGlow 代画。
  function ensureAwardPanel() {
    if (!awardPanelLoading) {
      awardPanelLoading = import("/plugins/cppu-notify/award-list.js")
        .then(async (mod) => {
          awardPanel = await mod.createAwardPanel(tide.storage, {
            selectionGlow: (box, opts) => tide.ui.selectionGlow?.(box, opts),
          });
          return mod;
        })
        .catch(() => { awardPanelLoading = null; awardPanel = null; awState.error = "获奖名单模块加载失败，请重新打开本视图重试"; throw new Error("获奖名单模块加载失败"); });
    }
    return awardPanelLoading;
  }

  /* 登录：与通知视图同一套凭据（cookie → 静默续期 → 密钥库密码），任一成功即可继续。
     与通知视图 autoLogin() 对齐的关键一步是**验证**：恢复出来的票据先真打一次列表接口。
     为什么（v0.214.2）：tp_up 只有几十分钟寿命，而它跟着 Cookie 一起存在密钥库里，
     冷启动恢复出来的那个十有八九已经过期 —— 之前的写法见到 state.token 就返回 true，
     于是「自动登录」在获奖视图里从来没跑过，用户看到的是「列表接口 HTTP 302」横幅，
     得手点「重新登录」再手填一次验证码。 */
  function awSessionError(e) {
    // 只有「会话不认了」才值得重走登录链：断网、DNS 失败这类传输抖动换票据也没用，
    // 原样抛给上层报错（分工与 explainHttpError 一致）。
    return /HTTP\s*(?:30[0-9]|40[13])|会话已过期|登录可能已过期|重新登录|未建立/.test(String(e?.message || e || ""));
  }
  // 真打一次列表接口当作票据探针；顺带把第 1 页装进 state.notices（去重，不浪费这次请求）。
  async function awProbeSession() {
    try { await awFetchList(1); return true; }
    catch (e) { if (awSessionError(e)) return false; throw e; }
  }
  async function awEnsureSession(force = false) {
    if (force) { awState.sessionOk = false; state.token = ""; }
    if (awState.sessionOk) return true;
    const restored = await restoreCookies();     // 内部自带 catch，票据损坏按无票据处理
    if (!restored) await newSession();
    if (state.token && await awProbeSession()) { awState.sessionOk = true; return true; }
    state.token = "";                            // 票据过期：清掉，免得 referer() 继续带着它
    try {
      if (await silentRenew()) {
        await saveCookies();
        if (await awProbeSession()) { awState.sessionOk = true; return true; }
        state.token = "";
      }
      if (await passwordAutoLogin()) { awState.sessionOk = true; return true; }
    } catch { /* 落到人工登录表单 */ }
    return false;
  }

  /* 列表只往回翻、不覆盖 state.notices：通知视图已经把前几页装进来了，这里只补它没装的部分，
     免得用户刚从通知列表滚到第 3 页、一进获奖名单又被重置回第 1 页。
     untilYear：翻到「这一页最后一条的年份 ≤ untilYear」就停。门户通知一年几百条，
     固定页数会把更早的获奖通知挡在候选集之外 —— 表现就是「怎么只识别到今年的」。 */
  async function awFetchList(maxPages, untilYear = 0) {
    const epoch = authEpoch, username = state.username;
    const checkCurrent = () => { if (!authCurrent(epoch, username)) throw new Error("登录状态已改变，请重新操作"); };
    for (let page = 1; page <= maxPages; page++) {
      checkCurrent();
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
      checkCurrent();
      if (res.status !== 200) throw new Error(`列表接口 HTTP ${res.status}，登录可能已过期`);
      let d;
      try { d = JSON.parse(res.body); } catch { throw new Error("会话已过期，请重新登录"); }
      const items = Array.isArray(d?.list) ? d.list : [];
      if (!items.length) { state.hasMore = false; break; }
      const ids = new Set(state.notices.map((x) => x.RESOURCE_ID));
      state.notices = state.notices.concat(items.filter((x) => !ids.has(x.RESOURCE_ID)));
      if (items.length < PAGE_SIZE) { state.hasMore = false; break; }
      // 这一页的最后一条已经比目标年份更早 ⇒ 目标区间已覆盖，不必再翻。
      const oldest = Number(items[items.length - 1]?.CREATE_TIME || 0);
      if (untilYear && oldest) {
        const y = new Date(oldest).getFullYear();
        if (y && y <= untilYear) break;
      }
    }
    checkCurrent();
    state.fetchedAt = Date.now();
    await saveNoticeCache();
    checkCurrent();
  }

  /* 覆盖区间：让用户一眼看出这次翻到了哪一年，而不是疑惑「怎么只有今年的」。
     用起止年月 + 条数表达，比页码直观。 */
  function awCoverage() {
    const times = state.notices.map((it) => Number(it.CREATE_TIME || 0)).filter((n) => n > 0);
    if (!times.length) return "";
    const ym = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
    return `${ym(Math.min(...times))} ~ ${ym(Math.max(...times))}`;
  }

  function awDetailCached(rid) {
    const det = state.details[rid];
    return det && det.content ? det : null;
  }
  async function awDetailFetch(rid) {
    const got = await fetchNoticeContent(rid);
    state.details[rid] = { ...got, detailVersion: got.contentError || got.attachmentError ? 0 : 2 };
    return state.details[rid];
  }

  /* ── 获奖名单附件 ──
     判定与字节解析全在 award-attach.js（纯函数，可单测）；这里只做三件事：
     决定读哪些附件、下载、把抽出来的文本并进同一条通知的解析文本。 */
  function ensureAttachMod() {
    if (!attachLoading) {
      attachLoading = import("/plugins/cppu-notify/award-attach.js")
        .then((mod) => { attachMod = mod; return mod; })
        .catch(() => { attachLoading = null; attachMod = null; throw new Error("附件名单模块加载失败"); });
    }
    return attachLoading;
  }

  /* ── 取数并发池 ──
     口径与实现都在 award-pool.js（纯函数，可单测）：并发数 1~8、默认 3，
     档位由「设置 → 警大获奖名单 → 读取并发数」写进同一份插件 storage。
     main.js 是宿主包出来的经典脚本（不能写顶层 import），所以这里运行时动态 import。 */
  function ensurePoolMod() {
    if (!poolLoading) {
      poolLoading = import("/plugins/cppu-notify/award-pool.js")
        .then((mod) => { poolMod = mod; return mod; })
        .catch(() => { poolLoading = null; poolMod = null; return null; });   // 读不到不抛：退回串行
    }
    return poolLoading;
  }
  // 读并发数：每轮同步开头读一次 —— 改完设置点「刷新」或重开视图即生效。
  async function awConcurrency() {
    await ensurePoolMod();
    if (!poolMod) return 1;
    let raw = poolMod.AWARD_CONCURRENCY_DEFAULT;
    try { raw = await tide.storage.get(poolMod.AWARD_CONCURRENCY_KEY, poolMod.AWARD_CONCURRENCY_DEFAULT); }
    catch { /* 读不到就用默认值，不影响这一轮 */ }
    return poolMod.clampConcurrency(raw);
  }
  /* 跑一批任务，最多 limit 个同时在飞。stop() 为真时不再派新任务（视图卸载后别再敲门户）。
     池子模块缺失时退化成一次一个：并发是个可选的加速，不该把整张榜单拖垮。 */
  async function awRun(items, limit, worker, stop) {
    await ensurePoolMod();
    if (poolMod) return poolMod.runPool(items, limit, worker, { stop });
    const serial = [];
    for (let i = 0; i < items.length; i++) {
      if (stop?.()) break;
      try { serial[i] = { ok: true, value: await worker(items[i], i) }; }
      catch (error) { serial[i] = { ok: false, error }; }
    }
    return serial;
  }

  // 键是「通知 + 附件名」：换一条通知的同名附件不算同一个，不会被旧标记挡住。
  const affixKey = (rid, name) => `${rid}::${name}`;

  // 「扫过」标记只在这一刻整体赋值：并发读附件时多个 markAffixScanned 会同时进来，
  // 若像以前那样先塞一个空对象再等 storage 回来，后到的调用会拿着空对象改、
  // 早到的又把整份旧标记盖回去 —— 判定「读过就不再下载」的台账就这么丢光了。
  async function loadAffixScanned() {
    if (affixScanned) return affixScanned;
    if (!affixScannedLoading) {
      affixScannedLoading = (async () => {
        let box = {};
        try {
          const saved = await tide.storage.get(AWARD_AFFIX_KEY, null);
          if (saved && typeof saved === "object") box = saved;
        } catch { /* 读不到就当作一个都没扫过 */ }
        affixScanned = box;
        return box;
      })();
    }
    return affixScannedLoading;
  }
  // 只记「扫过」，不存内容：名单已经进了 awardBoardCache，附件文本用完即弃。
  async function markAffixScanned(rid, name) {
    await loadAffixScanned();
    affixScanned[affixKey(rid, name)] = Date.now();
    const keys = Object.keys(affixScanned);
    if (keys.length > AWARD_AFFIX_MARK_MAX) {
      keys.sort((a, b) => Number(affixScanned[a]) - Number(affixScanned[b]));
      for (const k of keys.slice(0, keys.length - AWARD_AFFIX_MARK_MAX)) delete affixScanned[k];
    }
    try { await tide.storage.set(AWARD_AFFIX_KEY, affixScanned); } catch { /* 标记写不进就下次再读一遍，不影响本轮结果 */ }
  }

  async function awAffixFetch(rid, att) {
    const res = await tide.http.fetch(state.sid, "GET", att.url, {
      headers: { "Referer": referer(), "Cookie": "tp_up=" + state.token },
      binary: true,
    });
    if (res.status !== 200 || !res.body) throw new Error(`附件接口 HTTP ${res.status}`);
    // 票据过期时附件链接会 200 返回一张登录页：当失败处理（不记标记，下次刷新再试）
    if (/text\/html/i.test(res.contentType || "")) throw new Error("门户会话已过期");
    const got = await attachMod.attachmentToNoticeText({
      name: att.name,
      base64: res.body,
      mime: res.contentType,
      spreadsheetText: (file) => tide.assets.spreadsheetText(file),
    });
    return String(got.text || "").slice(0, AWARD_AFFIX_CHARS);
  }

  /* 附件阶段：先算出「该读哪些」（纯判定，不产生请求），再逐个读。返回 rid → { text, names }。
     names 只记附件名，用于在名单里标出「这条获奖名单读自哪个附件」。 */
  async function awAffixPass(el, cands) {
    const out = new Map();
    await loadAffixScanned();
    if (!attachMod) await ensureAttachMod();
    // 与正文同一口径：一次刷新把「该读的附件」读完，不留「还有 N 份下一轮读」的尾巴
    // （那同样是让人怀疑漏人的含糊提示）。附件更重，所以单批 12、整轮预算 36；
    // 读失败的记进 tried，否则 plan 会每圈重新把它捞回来，原地打转。
    const tried = new Set();
    // 附件同样并发读（以前是一个一个下载解析）。进度行报的是**已读完**的条数：
    // 并发下按完成顺序往前爬，比按提交顺序更能说明还剩多少。
    const conc = await awConcurrency();
    const pace = conc > 1 ? ` · 并发 ${conc}` : "";
    let readTotal = 0;
    for (;;) {
      const plan = [];
      for (const it of cands) {
        const rid = itemKey(it);
        const det = state.details[rid];
        const affixes = Array.isArray(det?.attachments) ? det.attachments : [];
        if (!affixes.length) continue;
        const body = String(det?.content || "");
        for (const att of affixes) {
          // 两条触发口径：附件名像名单，或正文说了名单在附件 —— 其余附件连请求都不发
          if (!attachMod.looksLikeAwardAttachment(att.name, body)) continue;
          if (affixScanned[affixKey(rid, att.name)]) continue;   // 扫过就不再扫
          if (tried.has(affixKey(rid, att.name))) continue;      // 本轮已试过（失败的不重试）
          plan.push({ rid, att });
        }
      }
      const batch = plan.slice(0, AWARD_AFFIX_MAX);
      awState.affixWait = Math.max(0, plan.length - batch.length);
      if (!batch.length) break;
      for (const { rid, att } of batch) tried.add(affixKey(rid, att.name));
      let done = 0;
      await awRun(batch, conc, async ({ rid, att }) => {
        if (!el.isConnected) return;                      // 视图已卸载：这一格不再发请求
        try {
          const text = await awAffixFetch(rid, att);
          if (text) {
            const cur = out.get(rid) || { text: "", names: [] };
            cur.text = [cur.text, text].filter(Boolean).join("\n");
            if (!cur.names.includes(att.name)) cur.names.push(att.name);
            out.set(rid, cur);
            awState.affixCount += 1;
          }
          // 读过就记上（哪怕里面没名单）：同一份附件不在每轮刷新里反复下载
          await markAffixScanned(rid, att.name);
        } catch { /* 读失败不记标记，下一轮刷新会再试 */ }
        done += 1;
        awState.progress = `正在读附件里的获奖名单 ${done}/${batch.length}（${att.name}）${pace}`;
        awStatusOnly(el);
      }, () => !el.isConnected);
      if (!el.isConnected) break;
      readTotal += batch.length;
      if (readTotal >= AWARD_AFFIX_BUDGET) break;
      if (plan.length <= batch.length) break;              // 这批就是全部，没有下一批
      awState.progress = `附件名单已读 ${readTotal} 份，接着读剩下的 ${plan.length - batch.length} 份…${pace}`;
      awStatusOnly(el);
    }
    return out;
  }

  async function saveAwardCache() {
    try {
      await cacheStore.set(AWARD_CACHE_KEY, {
        ver: AWARD_CACHE_VER,
        username: state.username,
        syncedAt: awState.syncedAt,
        records: awState.records.slice(0, AWARD_CACHE_MAX),
      });
    } catch { /* 写盘失败不影响本次阅读 */ }
  }
  async function restoreAwardCache() {
    try {
      const cache = await cacheStore.get(AWARD_CACHE_KEY, null);
      if (!cache || cache.username !== state.username || !Array.isArray(cache.records) || !cache.records.length) return false;
      // 旧口径（ver < AWARD_CACHE_VER）的解析结果里混着等线 / 仿宋 / 无列表 / 教务处，
      // 直接作废：这一轮重新扫一遍正文，榜单才是干净的。
      if (Number(cache.ver) !== AWARD_CACHE_VER) return false;
      const mod = await ensureAwardPanel();
      awState.records = cache.records;
      awState.board = mod.buildAwardBoard(cache.records);
      awState.syncedAt = Number(cache.syncedAt) || 0;
      return true;
    } catch { return false; }
  }

  /* 缓存够不够新。restoreAwardCache 成功只说明「盘上有这份」，不代表它值得挡住一次整轮重爬；
      真正的门槛是 syncedAt（上一轮同步完成的时刻）。没有 syncedAt 的一律当过期，走自动同步。 */
  function awCacheFresh() {
    if (!awState.board || !awState.syncedAt) return false;
    return Date.now() - awState.syncedAt < AWARD_CACHE_FRESH_MS;
  }

  async function awSync(el, deeper = false) {
    if (awState.loading) return;
    if (deeper) awState.pages = Math.min(AWARD_PAGES_MAX, awState.pages + AWARD_PAGES_STEP);
    awState.loading = true;
    awState.error = "";
    awState.progress = "正在拉取通知列表…";
    awPaint(el);
    try {
      const mod = await ensureAwardPanel();
      // 按时间回溯：翻到覆盖 AWARD_YEARS 个自然年为止（点过「再往前翻」则按累计页数继续往前）。
      const untilYear = new Date().getFullYear() - (AWARD_YEARS - 1);
      // 会话可能正好在这一刻死掉（tp_up 只有几十分钟）：续一次期 / 用密钥库密码重登一次再重跑，
      // 成不了才把错误摆出来。这是「自动登录」在长同步里的那一半 —— 没有它，用户看到 302 横幅
      // 只能自己去点人工登录。
      try {
        await awFetchList(awState.pages, untilYear);
      } catch (e) {
        if (!awSessionError(e) || !await awEnsureSession(true)) throw e;
        await awFetchList(awState.pages, untilYear);
      }
      // 先按标题筛「像获奖」的（这一步免费），再逐条读正文由 award-list.js 判定收不收。
      const cands = state.notices.filter((it) => mod.titleLooksAward(titleOf(it)));
      // 已读过正文的（上一轮读的、或用户在通知视图里点开过的）不重复请求。
      // ⚠️ 必须「一轮读到底」：过去读满一批（AWARD_NOTICE_MAX 条）就收工、剩下的留给「再点一次」，
      // 于是状态行长期挂着「还有 89 条候选没读」—— 而漏人恰恰是这一页唯一不能出的错，
      // 一条含糊的尾巴等于让人自己去猜。现在改成同一轮里续批，直到没有未读候选 / 用完预算 /
      // 视图卸载 / 会话掉线。failed 的条目记进 tried：正文没读到的条目 content 永远为空，
      // 不排除掉就会在下一圈里对同一条反复发请求。
      const unreadAll = () => cands.filter((it) => !state.details[itemKey(it)]?.content);
      const tried = new Set();
      let failed = 0, sessionLost = false, readTotal = 0;
      // 正文并发读：一串 60 条候选 × 门户 300~600ms 的串行等待是这套同步里最长的一段，
      // 并发数读「设置 → 警大获奖名单 → 读取并发数」（默认 3，上限 16，键见 award-pool.js）。
      // 默认值刻意压在对学校服务器客气的档位：拉高只为了自己赶时间，别让默认行为替所有人决定。
      const conc = await awConcurrency();
      const pace = conc > 1 ? ` · 并发 ${conc}` : "";
      for (;;) {
        const left = unreadAll();
        const batch = left.filter((it) => !tried.has(itemKey(it))).slice(0, AWARD_NOTICE_MAX);
        awState.pendingCands = Math.max(0, left.length - batch.length);
        if (!batch.length) break;
        for (const it of batch) tried.add(itemKey(it));
        let done = 0;
        await awRun(batch, conc, async (it) => {
          if (!el.isConnected) return;                    // 视图已卸载：这一格不再发请求
          // 会话型失败要记下来：下一轮「刷新」若还信 sessionOk，就只会在同一堵墙上再撞一次。
          try { await awDetailFetch(itemKey(it)); } catch (e) { failed += 1; if (awSessionError(e)) sessionLost = true; }
          done += 1;
          awState.progress = `正在读正文筛选获奖名单 ${readTotal + done} 条（本批 ${done}/${batch.length} · 待读 ${left.length} 条）${pace}`;
          awStatusOnly(el);
        }, () => !el.isConnected);
        if (!el.isConnected) { awState.loading = false; awState.progress = ""; return; }
        readTotal += batch.length;
        // 会话掉了就先停：在一条已经死掉的会话上把剩下几百条全撞一遍，只会把「名单不全」拖得更久。
        if (sessionLost || readTotal >= AWARD_CAND_BUDGET) break;
        if (!unreadAll().length) break;
        awState.progress = `候选正文已读 ${readTotal} 条，接着读剩下的 ${unreadAll().length} 条…${pace}`;
        awStatusOnly(el);
      }
      // 池子跑完才发现视图已经关掉：这时状态要收干净（与串行版逐条判断的收尾一致）
      if (!el.isConnected) { awState.loading = false; awState.progress = ""; return; }
      // 附件阶段：正文里没有名单的通知，名单多半在附件上。只读「该读的」（附件名像名单，
      // 或正文说了名单在附件），扫过的跳过；抽到的文本并进同一条通知的解析文本，
      // 解析完这段文本就丢 —— 落盘的只有名单本身（见 AWARD_AFFIX_KEY 的注释）。
      let affixMap = new Map();
      if (!el.isConnected) { awState.loading = false; awState.progress = ""; return; }
      awState.progress = "正在看有没有「名单在附件」的通知…";
      awStatusOnly(el);
      try {
        affixMap = await awAffixPass(el, cands);
      } catch (e) {
        // 附件模块不可用不该让整张名单失败：正文里读到的部分照常出结果
        awState.error = `附件名单没读到：${String(e?.message || e)}`;
      }
      if (!el.isConnected) { awState.loading = false; awState.progress = ""; return; }
      // 再对**全部**候选统一解析：已读的走内存缓存，不产生请求；正文 + 附件文本一起解析。
      const records = [];
      for (const it of cands) {
        const rid = itemKey(it);
        const det = state.details[rid];
        const affix = affixMap.get(rid);
        const text = [det?.content, affix?.text].filter(Boolean).join("\n");
        const rec = text
          ? mod.parseAwardNotice({ rid, title: titleOf(it), text, date: Number(it.CREATE_TIME || 0) })
          : null;
        if (!rec) continue;
        if (affix?.names.length) rec.affix = affix.names.slice(0, 4);
        records.push(rec);
      }
      awState.records = records;
      awState.board = mod.buildAwardBoard(records);
      awState.syncedAt = Date.now();
      await saveAwardCache();
      if (sessionLost) awState.sessionOk = false;   // 会话中途丢了：下一次刷新重新走登录链
      if (failed) awState.error = `${failed} 条通知的正文没读到（网络或会话中断），名单可能不全，点这条状态行可重试。`;
      // 这一轮真跑完了：盘上的缓存就是本轮产物，「缓存直出」的说明与欠下的那次同步都该销账。
      awState.cacheOnly = false;
      awState.wantSync = false;
    } catch (e) {
      awState.error = String(e?.message || e);
      if (awSessionError(e)) awState.sessionOk = false;
    }
    awState.loading = false;
    awState.progress = "";
    awPaint(el);
  }

  function awRemount(el) {
    el.innerHTML = awShellHtml();
    bindSide(el);
    loadLinkMeta(el);
    awStart(el);
  }
  /* 「确保会话就绪，否则把人工登录摆出来」。awStart 与「刷新名单」共用这一段：
      缓存新鲜期让 awStart 跳过了它，所以点刷新时必须自己能把会话建起来，不能指望开局铺过路。 */
  async function awEnsureReady(el) {
    if (!state.token) { awState.progress = "正在恢复登录状态…"; awPaint(el); }
    let ok = false;
    try {
      ok = await awEnsureSession();
    } catch (e) {
      // 断网 / DNS 这类传输抖动不是登录态问题：别把用户甩到人工登录表单 —— 有缓存就显示缓存，
      // 顺手把真实原因写在横幅上（点状态行重试即可，不需要重新输验证码）。
      awState.progress = "";
      awState.error = explainHttpError(e);
      awPaint(el);
      return false;
    }
    if (!el.isConnected) return false;
    if (!ok) {
      awState.progress = "";
      await prepareLoginForm();
      if (!el.isConnected) return false;
      paintLogin(el, loginHint?.msg || "", {
        prefillCode: loginHint?.code || "",
        // 只换回页面内容，不重跑 mountAwardView：容器上的监听器挂在 el 本身，再挂一遍会双触发。
        // 登录成功说明用户本来就要看数据，把「欠一次同步」记下来，免得回来又被新鲜期挡回去。
        onDone: () => { awState.wantSync = true; awRemount(el); },
        onFailure: () => false,
      });
      return false;
    }
    return true;
  }
  async function awStart(el) {
    try { await ensureAwardPanel(); } catch { awPaint(el); return; }
    const fromCache = await restoreAwardCache();
    // 新鲜期内只画缓存，不自动整轮重爬：这一页一轮要读上百条正文 + 附件，一分钟起步，
    // 而名单一个月才变几次。用户点「刷新名单」（wantSync）时无条件放行。
    // 先判后画：cacheOnly 一旦成立，状态行要立刻是「本机缓存 · …」那一句，不能先闪一次同步口径。
    if (fromCache && !awState.wantSync && awCacheFresh()) {
      awState.cacheOnly = true;
      awPaint(el);
      return;
    }
    if (fromCache) awPaint(el);
    if (!await awEnsureReady(el)) return;
    await awSync(el);
  }

  function mountAwardView(el) {
    ensureStyle();
    el.innerHTML = awShellHtml();
    bindSide(el);
    loadLinkMeta(el);
    const openLogin = async () => {
      await prepareLoginForm();
      if (!el.isConnected) return;
      paintLogin(el, loginHint?.msg || "", {
        prefillCode: loginHint?.code || "",
        onDone: () => awRemount(el),
        onFailure: () => false,
      });
    };
    el.addEventListener("click", async (e) => {
      // 这三个入口都是「我就是要同步」：先记账（让缓存新鲜期让路），再自己把会话建起来 ——
      // awStart 在新鲜期下根本没跑登录链，这里不补就只会在 awFetchList 上撞一次墙。
      if (e.target.closest("[data-aw-sync]")) { awState.wantSync = true; if (await awEnsureReady(el)) await awSync(el); return; }
      if (e.target.closest("[data-aw-banner-refresh]")) { awState.wantSync = true; if (await awEnsureReady(el)) await awSync(el); return; }
      // 「再往前翻」：把回溯页数往上加一档再同步 —— 首页只翻到近三年，更早的要用户自己决定。
      if (e.target.closest("[data-aw-deeper]")) { awState.wantSync = true; if (await awEnsureReady(el)) await awSync(el, true); return; }
      if (e.target.closest("[data-aw-notify]")) { tide.util.navigate("plug:cppu-notify"); return; }
      if (e.target.closest("[data-aw-relogin]")) {
        state.token = ""; state.notices = []; state.details = {}; state.pending = null; state.captcha = "";
        awState.board = null; awState.records = []; awState.error = ""; awState.syncedAt = 0;
        awState.pages = AWARD_PAGES; awState.pendingCands = 0; awState.affixCount = 0; awState.affixWait = 0;
        awState.sessionOk = false;   // 用户明确要求重新登录：缓存里的「会话已核验」也必须作废
        // 盘上的榜单缓存没删（同一学号、同一口径还能读回来），所以只能靠 wantSync 压过新鲜期，
        // 否则重新登录回来又被自己的缓存挡成「只看缓存、不同步」。
        awState.cacheOnly = false; awState.wantSync = true;
        await openLogin();
        return;
      }
    });
    awStart(el);
    return () => { if (awState.el === el) awState.el = null; };
  }

  const cardState = {
    rows: [], mode: "month", kind: "in", sid: null, username: "", password: "", accessToken: "",
    tokenType: "bearer", refreshToken: "", expiresAt: 0, loading: false, syncedAt: 0, error: "",
    balance: null, balanceAt: 0, balanceError: "", billsPartial: false,
  };
  let cardAveragePanel = null, cardAverageLoading = null, cardAverageError = "";
  let cardChartsPanel = null, cardChartsLoading = null, cardChartsError = "";
  function loadCardAveragePanel(root) {
    if (!cardAverageLoading) {
      cardAverageLoading = import("/plugins/cppu-notify/card-averages.js")
        .then(module => module.createCardAverages(tide.storage))
        .then(panel => { cardAveragePanel = panel; cardAverageError = ""; })
        .catch(() => { cardAverageError = "日均统计模块加载失败，请重新打开一卡通重试"; cardAverageLoading = null; });
    }
    cardAverageLoading.then(() => { if (root?.isConnected !== false) cardPaintStats(root); });
  }
  /* 图形统计（v0.221.0）：趋势折线 / 消费结构 / 地点排行 / 星期分布，画在本视图最下面。
     平台口径复用 growthBridge（同一份 pdata 会话），模块只认「拿到 data / 没拿到」。 */
  function loadCardChartsPanel(root) {
    if (!cardChartsLoading) {
      cardChartsLoading = import("/plugins/cppu-notify/card-charts.js")
        .then(module => module.createCardCharts(tide, growthBridge))
        .then(panel => { cardChartsPanel = panel; cardChartsError = ""; })
        .catch(() => { cardChartsError = "图形统计模块加载失败，请重新打开一卡通重试"; cardChartsLoading = null; });
    }
    cardChartsLoading.then(() => { if (root?.isConnected !== false) cardPaintStats(root); });
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
      : `<div class="yk-empty">暂未从一卡通账单识别到${kindLabels[cardState.kind] || "充值"}记录。连接校园网后重新进入本视图会自动再同步一次。</div>`;
    const rows = cardState.rows.slice(0, 16).map((r) => `<div class="yk-ledger-row${r.kind === "out" ? " out" : ""}" data-card-row="${esc(r.id)}">
      <span>${esc(r.date)}</span><b>${r.kind === "out" ? "-" : "+"}${esc(cardMoney(r.amount))}</b><span>${esc(r.note || kindLabels[r.kind === "out" ? "out" : "in"])}</span>
    </div>`).join("") || `<div class="yk-empty">暂无平台流水记录。本页不再需要手工“记一笔”。</div>`;
    const synced = cardState.syncedAt ? new Date(cardState.syncedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
    const balanceSynced = cardState.balanceAt ? new Date(cardState.balanceAt).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
    return `<div class="yk-stat">
      <div class="yk-total"><small>总充值量</small><div class="yk-amount">${metricIcon("total", 28)}<b>${esc(cardMoney(total))}</b></div><span>共 ${inCount} 笔一卡通平台充值记录，可按年份 / 月份 / 日期汇总查看。</span></div>
      <div class="yk-spent"><small>已花费</small><div class="yk-amount">${metricIcon("spent", 28)}<b>${esc(cardMoney(spent))}</b></div><span>共 ${outCount} 笔一卡通平台消费流水（含食堂、商超、洗浴等刷卡支出）。</span></div>
      <div class="yk-balance"><small>当前余额</small><div class="yk-amount">${metricIcon("balance", 28)}<b>${cardState.balance == null ? "--" : esc(cardMoney(cardState.balance))}</b></div><span>一卡通平台实时余额（校园卡账户 + 电子账户，含未结算金额） · ${esc(balanceSynced)}${cardState.balanceError ? ` · ${esc(cardState.balanceError)}` : ""}</span></div>
      <div class="yk-account"><span>账单来源：<b>一卡通平台</b></span><span>最后同步：${esc(synced)}</span>${cardState.error ? `<span class="warn">${esc(cardState.error)}</span>` : ""}</div>
    </div>
    <div data-card-averages><p>${esc(cardAverageError || "正在载入日均餐费统计…")}</p></div>
    <div class="yk-groups"><div class="yk-group-head"><b>流水统计</b><div class="pp-chips">${kindChips}</div><div class="pp-chips">${modeChips}</div></div><div class="yk-bars${cardState.kind === "out" ? " out" : ""}">${bars}</div></div>
    <div class="yk-ledger">${rows}</div>
    <div data-card-charts><p class="yk-empty">${esc(cardChartsError || "正在载入图形统计…")}</p></div>`;
  }
  function cardPaintStats(root) {
    const box = root?.querySelector?.("[data-card-stats]");
    if (box) {
      box.innerHTML = cardStatsHtml();
      try { cardAveragePanel?.render(box.querySelector("[data-card-averages]"), cardState.rows, { syncedAt: cardState.syncedAt, partial: cardState.billsPartial }); }
      catch { const panel=box.querySelector("[data-card-averages]"); if(panel)panel.textContent="日均统计暂不可用，不影响账单与流水统计"; }
      try { cardChartsPanel?.render(box.querySelector("[data-card-charts]"), cardState.rows, { syncedAt: cardState.syncedAt, partial: cardState.billsPartial }); }
      catch { const panel=box.querySelector("[data-card-charts]"); if(panel)panel.textContent="图形统计暂不可用，不影响账单与流水统计"; }
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
    status.classList.toggle("warn", warn);
    // 警告态（登录失败 / 拉取失败）整条就是刷新入口（v0.190.0）：点一下 = 重新登录并重拉账单
    if (warn) status.innerHTML = bannerRefreshHtml(text, "card-refresh");
    else status.textContent = text;
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
      await cacheStore.set(CARD_CACHE_KEY, {
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
      <div class="yk-status" data-card-status role="status" aria-live="polite">正在恢复一卡通登录信息…</div>
      <div data-card-login-box></div>
      <div data-card-web hidden><p class="jw-tip">当前为官方网页。若空白或未授权，请在浏览器中完成官方登录。</p><div class="yk-frame-shell"><iframe class="yk-frame" data-card-frame src="about:blank" title="一卡通官方网页"></iframe></div></div>
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
      if (!frame || !shell) { message('内嵌网页容器不可用，请在浏览器中打开官方页面', true); return; }
      currentUrl = url; selectPage(name); clearFrameTimer();
      message('正在载入官方页面；若出现空白或未授权，请在浏览器中完成官方登录。');
      frame.src = cardAuthedUrl(url);
      frameTimer = setTimeout(() => { if (alive && page !== 'summary') message('网页仍未确认载入，可能受网络或内嵌限制影响；请在浏览器中打开官方页面', true); }, 15000);
    };
    const onFrameLoad = () => {
      if (!alive || page === 'summary') return;
      clearFrameTimer();
      // 跨域 iframe 的 load 不能证明网站可用或认证成功（拦截页也可能触发）。
      message('官方网页已触发载入；登录状态以网页为准。若空白、未授权或无法操作，请改用浏览器打开。');
    };
    const onFrameError = () => { clearFrameTimer(); if (page !== 'summary') message('官方页面未能载入，请检查网络或改用浏览器打开', true); };
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
      const names=['summary','billing','sync','home','recharge','center','reload','open','back','login','change','mode','kind','refresh'];
      const name=names.find(key=>target.closest(`[data-card-${key}]`));
      if (!name) return;
      const button=target.closest(`[data-card-${name}]`);
      if (!el.contains(button) || button.disabled) return;
      event.preventDefault();
      try {
        // 返回和页面切换不依赖网络、缓存或可选的日均模块。
        if (name==='back') { navSequence++; tide.util.navigate('plug:cppu-notify'); return; }
        if (name==='summary') { navSequence++; selectPage('summary'); cardPaintStats(el); message('已切回本地账单与统计。'); return; }
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
        if(name==='refresh'){
          // 警告横幅整条可点（v0.190.0）：重新登录并重拉本视图的全部数据
          cardState.error=''; cardState.balanceError=''; selectPage('summary'); cardPaintStats(el);
          captureCredentials();
          if(!cardState.username||!cardState.password){cardPaintLogin(el);message('请先填写一卡通学/工号和密码，再点击“登录并自动同步”',true);el.querySelector('[data-card-user]')?.focus();return;}
          await sync(false); return;
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
            if(!cardState.username||!cardState.password){message('请先登录一卡通，再进入账单、充值或账户中心。',true);el.querySelector('[data-card-user]')?.focus();return;}
            await sync(true);
          }
          if(!alive||sequence!==navSequence)return;
          if(!cardState.accessToken||cardState.expiresAt<=Date.now()){message('登录尚未成功，未打开受保护页面；请检查账号与密码',true);return;}
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
        const cache=await cacheStore.get(CARD_CACHE_KEY,null);
        if(!alive)return;
        cardState.rows=cardCleanRows(cache?.rows||[]);cardState.syncedAt=Number(cache?.syncedAt||0);
        cardState.billsPartial=!!cache?.billsPartial||(cache?.rows?.length||0)>=5000;
        cardState.balance=Number.isFinite(Number(cache?.balance))&&cache?.balance!=null?Number(cache.balance):null;
        cardState.balanceAt=Number(cache?.balanceAt||0);
      } catch { message('本地账单缓存读取失败，可填写账号后重新登录同步。',true); }
      try { if(alive)await cardRestoreSecret(); } catch { message('登录信息恢复失败，请手动填写一卡通账号和密码',true); }
      if(!alive)return;
      cardPaintLogin(el);cardPaintStats(el);
    })();
    ready.then(()=>{
      if(!alive)return;
      if(cardState.username&&cardState.password)return sync();
      message('首次使用请填写一卡通学/工号和密码，登录后会自动同步平台账单。');
    }).catch(()=>message('一卡通初始化未完成，请手动登录或重新打开本页',true));
    Promise.resolve().then(()=>{if(alive){bindSide(el);return loadLinkMeta(el);}}).catch(()=>{});
    Promise.resolve().then(()=>{if(alive)return loadCardAveragePanel(el);}).catch(()=>message('日均模块未能载入，账单与流水统计不受影响',true));
    Promise.resolve().then(()=>{if(alive)return loadCardChartsPanel(el);}).catch(()=>message('图形统计模块未能载入，账单与流水统计不受影响',true));
    const dispose=()=>{alive=false;navSequence++;clearFrameTimer();el.removeEventListener('click',click);frame?.removeEventListener('load',onFrameLoad);frame?.removeEventListener('error',onFrameError);try{cardChartsPanel?.dispose?.();}catch{}if(el._cardViewDispose===dispose)delete el._cardViewDispose;};
    el._cardViewDispose=dispose;return dispose;
  }

  /* ── 登录界面 ── */
  /* 「上次自动登录：…」——票据过了 5 天失效时，这句话是唯一能说明不是白记了账号的证据。 */
  function loginAtText() {
    const t = Number(state.loginAt) || 0;
    if (!t) return "";
    try {
      const d = new Date(t);
      const pad = n => String(n).padStart(2, "0");
      return `上次自动登录：${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}。`;
    } catch { return ""; }
  }

  function paintLogin(el, errMsg, opts = {}) {
    const hasSaved = !!state.username;
    const canVault = typeof tide.vault?.get === "function";
    el.innerHTML = `<div class="${sideShellClass()}">
      <aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}
      <div class="pp-main"><div class="pp-login">
      <h3>登录智慧警大门户</h3>
      <div class="d">中国人民警察大学统一门户（portal-jw.cppu.edu.cn）。系统会先自动恢复上次会话，失败后自动识别验证码完成登录；都行不通才需要在这里核对信息。</div>
      <div class="d"><b>自动登录状态：</b>记住账号 ${state.rememberUsername ? "✓" : "✗"} · 票据静默续期 ✓ · 加密保存密码 ${state.autoLogin && canVault ? "✓" : "✗"} · 验证码自动识别 ✓</div>
      ${hasSaved ? `<div class="saved">已自动填入账号 ${esc(state.username)}${state.autoLogin && state.savedPassword ? "与保存的密码" : ""}。${loginAtText()}验证码会自动识别预填，核对无误直接点「登 录」即可。</div>` : ""}
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
    if (autoEl) autoEl.addEventListener("click", async () => {
      if (loggingIn || loginBusy) return;
      state.autoLogin = !state.autoLogin;
      autoEl.classList.toggle("on", state.autoLogin);
      tide.storage.set("autoLogin", state.autoLogin);
      if (!state.autoLogin) {
        await clearSavedLogin();
        passEl.value = ""; codeEl.value = "";
        await prepareLoginForm();
        if (capImg) capImg.src = state.captcha || "";
      }
      tide.notify(state.autoLogin ? "已开启记住密码并自动登录" : "已关闭自动登录，并清除保存的密码");
    });
    el.querySelector("[data-switchuser]").addEventListener("click", async () => {
      if (loggingIn || loginBusy) return;
      await clearSavedLogin();
      state.username = "";
      tide.storage.set("username", "");
      userEl.value = ""; passEl.value = ""; codeEl.value = "";
      await prepareLoginForm();
      if (capImg) capImg.src = state.captcha || "";
      userEl.focus();
    });
    el.querySelector("[data-clearauth]")?.addEventListener("click", async () => {
      if (loggingIn || loginBusy) return;
      const cleared = await clearSavedLogin();
      passEl.value = "";
      codeEl.value = "";
      await prepareLoginForm();
      if (capImg) capImg.src = state.captcha || "";
      tide.notify(cleared ? "已清除保存的密码与会话票据" : "内存登录已清除，但本机密钥库删除失败，请重试");
    });

    let loggingIn = false;
    const doLogin = async () => {
      if (loggingIn || loginBusy) return;
      const username = userEl.value.trim();
      const password = passEl.value;
      const code = codeEl.value.trim();
      if (!username || !password || !code) { errEl.textContent = "请填写学号、密码和验证码"; return; }
      if (!state.pending?.execution) { errEl.textContent = "登录页尚未准备好，请稍候再试"; return; }
      // 人工选择的账号优先：尚未完成的恢复/偏好读取不得再覆盖这次登录。
      const loginEpoch = ++authEpoch;
      restorePending = null; sidPending = null;
      loggingIn = true; el.querySelector("[data-go]").disabled = true;
      for (const input of [userEl, passEl, codeEl]) input.disabled = true;
      errEl.textContent = "正在走 SSO 链路（登录 → bridge → 门户）…";
      try {
        const loginResult = await runLoginAttempts({ username, password, code,
          onRetry: message => { errEl.textContent = message; },
          isActive: () => authCurrent(loginEpoch) && el.isConnected !== false && el.querySelector("[data-err]") === errEl });
        if (!authCurrent(loginEpoch) || el.isConnected === false || el.querySelector("[data-err]") !== errEl) return;
        if (state.username !== username) {
          state.notices = []; state.details = {}; state.fetchedAt = 0;
          for (const key of Object.keys(jwState.data)) jwState.data[key] = null;
          jwState.at = {}; jwState.error = {}; jwState.term = null;
        }
        state.username = username;
        passwordLoginFailure = null;
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
      <div class="pp-toolbar">
        <button class="pp-btn pri" data-refresh>刷新</button>
        <span class="pp-kwbox"><span class="pp-kw-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span><input class="pp-kw" data-kw type="text" aria-label="关键词过滤：标题 / 发布人 / 单位 / 分类" title="关键词过滤：标题 / 发布人 / 单位 / 分类" placeholder=""></span>
        <label class="pp-toggle" data-ar title="打开插件期间每 10 分钟自动同步一次"><i></i>自动刷新</label>
        <span style="flex:1"></span>
        <button class="pp-btn" data-award>获奖名单</button>
        <button class="pp-btn" data-relogin>重新登录</button>
      </div>
      <details class="plugin-filter-menu"><summary data-filter-summary>筛选</summary><div class="plugin-filter-menu-panel">
        <div class="pp-toolbar"><span class="pp-lab">分类</span><div class="pp-chips" data-kinds></div></div>
        <div class="pp-toolbar"><span class="pp-lab">年份</span><div class="pp-chips" data-years></div></div>
        <div class="pp-toolbar"><span class="pp-lab">月份</span><div class="pp-chips" data-months></div></div>
        <label class="pp-toggle" data-hs><i></i>只看未读</label>
        <div class="pp-toolbar"><button class="pp-btn" data-filter-reset title="清空关键词、分类、年份、月份和只看未读">恢复默认筛选</button></div>
      </div></details>
      <div class="pp-status" data-status></div>
      <div data-list></div>
      <div style="height:30px"></div>
      </div></div>
    </div>`;

    ui = {
      status: el.querySelector("[data-status]"),
      kinds: el.querySelector("[data-kinds]"),
      years: el.querySelector("[data-years]"),
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
    el.querySelector("[data-filter-reset]").addEventListener("click", () => resetFilter());
    el.querySelector("[data-refresh]").addEventListener("click", () => {
      // 刷新要重新走会话校验 + 拉第一页（+ 新通知广播），几秒钟里只有状态条在动。
      const release = waitMask("正在刷新门户通知…");
      loadPage(1).finally(release);
    });
    // 错误状态行整条也是刷新入口（v0.190.0）：状态行每次重绘都会换掉里面的按钮，所以挂在容器上做委托
    ui.status.addEventListener("click", (e) => { if (e.target.closest("[data-banner-refresh]")) loadPage(1); });
    // 下拉是原生 <details>，点开面板后点旁边不会自己收 —— 在文档级捕获外面的按下，替它收起
    if (filterOutsideHandler) document.removeEventListener("pointerdown", filterOutsideHandler, true);
    filterOutsideHandler = (e) => {
      const menu = el.querySelector("details.plugin-filter-menu");
      if (menu?.open && !menu.contains(e.target)) menu.removeAttribute("open");
    };
    document.addEventListener("pointerdown", filterOutsideHandler, true);
    el.querySelector("[data-award]").addEventListener("click", () => tide.util.navigate("plug:cppu-award"));
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
    cacheFirstPaint = false;
    stopAutoRefresh();
    ensureStyle();
    el.innerHTML = `<div class="${sideShellClass()}"><aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}<div class="pp-main">`
      + `<div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在恢复登录状态…</div>`
      + `</div></div>`;
    bindSide(el);
    loadLinkMeta(el);
    // 整页等待：loadPrefs → 验票据/自动登录 → 首屏数据，走完才撤蒙版（抛错也撤）。
    const releaseWait = waitMask("正在载入警大门户通知…");
    // 偏好走 storage、票据走密钥库，是两条互不依赖的通道：并发取，autoLogin 直接用读好的
    // 那份，首屏少一个串行往返；票据读失败只当「没存过」，不影响下面的兜底链路。
    // 预热正在换票时必须排在它后面读 —— 两边各自 restore 一个新会话，会把 state.sid 中途换掉。
    const waitingWarm = warmBusy && warmPromise ? warmPromise.catch(() => {}) : Promise.resolve();
    const sessionReady = waitingWarm.then(() => restoreCookies()).catch(() => false);
    state.viewOpen++;
    loadPrefs().then(async () => {
      if (disposed) return;
      // ① 手里有上次的列表就先把内容画上屏（stale-while-revalidate，与「学生成长」v1.58.0 同口径）：
      //    过去 render 无论有没有缓存都挂整屏蒙版等完登录 + 首屏请求，二次进入也要空等一个往返。
      //    缓存按账号隔离（restoreNoticeCache 里比 username），换账号不会串台；画完立刻撤蒙版，
      //    下面的校验/登录/刷新在后台跑，数据回来只重画内容（paintAfterLoad）。
      cacheFirstPaint = false;
      if (await restoreNoticeCache() && !disposed) {
        cacheFirstPaint = true;
        buildMain(el);
        releaseWait();
      }
      if (disposed) return;
      // 每次进入都重新验证票据，避免插件在应用内放置较久后拿着过期 token 直接进空列表。
      // 自动登录三级链路：恢复票据静默续期 → 保存的密码 + 验证码识别 → 人工表单（预填）
      let ok = false;
      try { ok = await autoLogin(el, sessionReady); }
      catch (error) { ok = await showNoticeCache(el, loginErrorText(error)); }
      if (disposed) return;
      // autoLogin 失败路径里已经 paintLogin（含预填）；这里只兜「无凭据直接表单」
      if (!ok && !el.querySelector(".pp-login")) {
        await prepareLoginForm();
        paintLogin(el, "");
      }
    }).finally(releaseWait);
    return () => { if (!disposed) state.viewOpen--; disposed = true; releaseWait(); stopAutoRefresh(); io?.disconnect(); };
  }

  /* 警大校历（v0.216.0 从独立插件 cppu-calendar 并进来）：视图主体在 calendar.js，
     与获奖名单 / 一卡通同一套边界 —— 只借宿主的能力（storage / events / ui），
     登录态与 Cookie 一律不出本插件；学期边界仍走上面那条 cppu:term-request 事件。
     外壳（校园服务侧栏）由本文件画，校历只画 [data-cc-host] 里那一块，
     这样它和同插件的其它分类一样能就地切走、侧栏不用重画。
     实例缓存住：calendar.js 在 createCalendarView() 里挂 schedule:changed 一类监听，
     每次进入都新建会把监听叠起来（切三次就三份）。 */
  let calendarModule = null, calendarView = null;
  function mountCalendarView(el) {
    let disposed = false, teardown = null;
    ensureStyle();
    el.innerHTML = `<div class="${sideShellClass()}"><aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}`
      + `<div class="pp-main"><div data-cc-host><div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在载入警大校历…</div></div></div></div>`;
    bindSide(el);
    loadLinkMeta(el);
    (calendarModule || (calendarModule = import("/plugins/cppu-notify/calendar.js")))
      .then((mod) => {
        if (disposed) return;
        const host = el.querySelector("[data-cc-host]");
        if (!host) return;
        calendarView = calendarView || mod.createCalendarView(tide);
        teardown = calendarView.render(host);
      })
      .catch(() => {
        calendarModule = null;
        const host = el.querySelector("[data-cc-host]");
        if (host && !disposed) host.innerHTML = '<p class="pp-tip" style="padding:24px;text-align:center">警大校历模块加载失败，请重新打开本视图重试</p>';
      });
    return () => { disposed = true; if (typeof teardown === "function") teardown(); };
  }

  /* 个人信息（pdata.cppu.edu.cn/stu/dataReport/basicInfo + /stu/home）：视图主体在
     profile.js，与校历 / 获奖名单同一套边界 —— 只借宿主的能力（storage / ui / notify），
     取数与鉴权一律走 growthBridge，SSO 会话与 token 不出本文件。
     外壳（校园服务侧栏）由本文件画，视图只画 [data-pf-host] 里那一块。
     v0.281.0：「学生成长」并进这一页（原来两个视图打同一套 8 个接口、各画一遍身份卡）。
     实例缓存住：profile.js 在 createProfileView() 里挂着宿主事件监听与选中光句柄，
     每次进入都新建会把它们叠起来（切三次就三份）。 */
  let profileModule = null, profileView = null;
  function mountProfileView(el) {
    let disposed = false, teardown = null;
    ensureStyle();
    el.innerHTML = `<div class="${sideShellClass()}"><aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}`
      + `<div class="pp-main"><div data-pf-host><div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在载入个人信息…</div></div></div></div>`;
    bindSide(el);
    loadLinkMeta(el);
    (profileModule || (profileModule = import("/plugins/cppu-notify/profile.js")))
      .then((mod) => {
        if (disposed) return;
        const host = el.querySelector("[data-pf-host]");
        if (!host) return;
        profileView = profileView || mod.createProfileView(tide, growthBridge);
        teardown = profileView.render(host);
      })
      .catch(() => {
        profileModule = null;
        const host = el.querySelector("[data-pf-host]");
        if (host && !disposed) host.innerHTML = '<p class="pp-tip" style="padding:24px;text-align:center">个人信息模块加载失败，请重新打开本视图重试</p>';
      });
    return () => { disposed = true; if (typeof teardown === "function") teardown(); };
  }

  /* 我的体测（sport-wechat.cppu.edu.cn）：视图主体在 fitness.js。
     取数链路与上面几站都不同 —— 不做 OAuth（appid 绑死企业微信，宿主里进不去它的内置浏览器），
     只用 tools/sync-fitness.mjs 写进 plugin-cache 的那枚 token 直接 POST 体测接口。
     快照语义：进页面先读缓存 / 内置快照，**不自动联网**，只有点「刷新」才重新拉。
     实例缓存住：fitness.js 里持有展开状态与 prefers 节流器，每次新建会叠加。 */
  let fitnessModule = null, fitnessView = null;
  function mountFitnessView(el) {
    let disposed = false, teardown = null;
    ensureStyle();
    el.innerHTML = `<div class="${sideShellClass()}"><aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}`
      + `<div class="pp-main"><div data-fit-host><div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在载入体测数据…</div></div></div></div>`;
    bindSide(el);
    loadLinkMeta(el);
    (fitnessModule || (fitnessModule = import("/plugins/cppu-notify/fitness.js")))
      .then((mod) => {
        if (disposed) return;
        const host = el.querySelector("[data-fit-host]");
        if (!host) return;
        fitnessView = fitnessView || mod.createFitnessView(tide);
        teardown = fitnessView.render(host);
      })
      .catch(() => {
        fitnessModule = null;
        const host = el.querySelector("[data-fit-host]");
        if (host && !disposed) host.innerHTML = '<p class="pp-tip" style="padding:24px;text-align:center">体测模块加载失败，请重新打开本视图重试</p>';
      });
    return () => { disposed = true; if (typeof teardown === "function") teardown(); };
  }

  /* ── 上网记录（drcom.cppu.edu.cn 自助服务系统）─────────────────────────────
     与上面三站都不同：drcom 是 Dr.COM 的 Spring MVC 站，**完全没有统一身份认证票据链路**，
     会话就是一枚 JSESSIONID，登录 = 账号 + 密码 + 4 位图形验证码（表单里要同时带
     `code` 与 `random` 两个字段，只带一个必失败）。账号密码与门户同一套，所以凭据源仍复用
     ensureLoginPrefs / readSavedPassword，**不新增任何存储**。

     取数口径（实测 /bill/getUserOnlineLog，别照抄网页的 limit/offset —— 那套会被忽略）：
       pageSize / pageNumber 驼峰分页，sortName=loginTime&sortOrder=DESC，
       startTime / endTime 为 YYYY-MM-DD，**服务端最多接受 60 天跨度**（网页 daterangepicker
       的 dateLimit），超出要分段拉再合并。
     登录成功判定不用读 302 的 Location（无错误文案、失败/成功都 302），而是拿一次接口看
     返回是不是 JSON —— 落到登录页时拿到的是 HTML。

     边界：Cookie、密码、验证码识别全在本文件内，netlog.js 只拿 drcomBridge.logs()。 */
  const DRCOM = "https://drcom.cppu.edu.cn";
  const DRCOM_COOKIE_KEY = "drcomCookies";    // 密钥库里的一份会话快照，重启后免验证码
  const DRCOM_TRIES = 6;                      // 一次登录最多换几张验证码
  const DRCOM_TTL = 30 * 60 * 1000;           // 手上的会话在本进程内复用多久
  const DRCOM_SPAN = 60;                      // 单次查询的日期上限（服务端约束）
  const DRCOM_PAGE = 100;                     // 分页尺寸（网页给的是 10/20/50/100）
  const DRCOM_CAP = 1200;                     // 单区间行数保护，避免极端账号把界面拖死
  let drcomSession = { sid: "", at: 0, user: "" };
  let drcomPending = null;

  function drcomYmd(offsetDays) {
    const base = (tide.util?.today?.() || "");
    if (!base) return "";
    try { return tide.util.addDays(base, offsetDays); } catch { return base; }
  }

  /** 取一次账单接口：返回解析后的 JSON，落回登录页（HTML）时返回 null。 */
  async function drcomProbe(sid, start, end) {
    const s = start || drcomYmd(-1);
    const e = end || drcomYmd(0);
    const qs = `pageSize=1&pageNumber=1&sortName=loginTime&sortOrder=DESC&startTime=${encodeURIComponent(s)}&endTime=${encodeURIComponent(e)}`;
    const res = await tide.http.fetch(sid, "GET", `${DRCOM}/bill/getUserOnlineLog?${qs}`, {
      headers: { Accept: "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
    });
    const text = String(res?.body || "").trim();
    if (!text.startsWith("{")) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  async function drcomRestoreSid() {
    try {
      const raw = await tide.vault?.get?.(DRCOM_COOKIE_KEY);
      const cookies = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(cookies) || !cookies.length) return "";
      return (await tide.http.restoreCookies(cookies)) || "";
    } catch { return ""; }
  }

  async function drcomSaveCookies(sid) {
    try {
      const cookies = await tide.http.exportCookies(sid, [DRCOM]);
      if (Array.isArray(cookies) && cookies.length) await tide.vault?.set?.(DRCOM_COOKIE_KEY, JSON.stringify(cookies));
    } catch { /* 存不下就算了：下次重登一次（多花一张验证码） */ }
  }

  function drcomForget() {
    drcomSession = { sid: "", at: 0, user: "" };
    Promise.resolve(tide.vault?.del?.(DRCOM_COOKIE_KEY)).catch(() => {});
  }

  /** 拿下一条可用会话：先试密钥库里那份，再走密码 + 验证码。失败抛错（needLogin 标记凭据缺失）。 */
  async function drcomLogin() {
    if (drcomSession.sid && Date.now() - drcomSession.at < DRCOM_TTL) return drcomSession.sid;
    if (drcomPending) return drcomPending;
    drcomPending = (async () => {
      await ensureLoginPrefs();
      const user = String(state.username || "");
      const password = String((await readSavedPassword().catch(() => "")) || "");
      if (!user || !password) {
        const err = new Error("没有保存账号或密码");
        err.needLogin = true;
        throw err;
      }

      // ① 续期：上次的 JSESSIONID 还有效就不用再认验证码。
      const saved = await drcomRestoreSid();
      if (saved) {
        const probe = await drcomProbe(saved).catch(() => null);
        if (probe) {
          drcomSession = { sid: saved, at: Date.now(), user };
          return saved;
        }
      }

      // ② 密码登录。每次失败都**重取新图**：验证码与会话绑定，复用旧图等于白烧一次机会。
      const sid = await tide.http.session();
      let lastError = "";
      for (let i = 0; i < DRCOM_TRIES; i++) {
        const page = await tide.http.fetch(sid, "GET", `${DRCOM}/login/`);
        const body0 = String(page?.body || "");
        const checkcode = body0.match(/name=["']checkcode["']\s+value=["']([^"']*)["']/)?.[1] || "";
        const img = await tide.http.fetch(sid, "GET", `${DRCOM}/login/randomCode?t=${Date.now()}`, { binary: true });
        const dataUrl = img?.body ? `data:image/png;base64,${img.body}` : "";
        const ocr = dataUrl ? await OCR.recognize(dataUrl).catch(() => null) : null;
        const code = String(ocr?.code || "").replace(/\D/g, "");
        if (code.length !== 4) { lastError = "验证码没认出来"; continue; }
        const body = tide.util.web.formEncode({
          account: user,
          password,
          code,
          // 服务端两个验证码字段都要（code 与 random），少一个必 302 回登录页。
          random: code,
          checkcode,
          submit: "",
        });
        await tide.http.fetch(sid, "POST", `${DRCOM}/login/verify`, {
          headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${DRCOM}/login/` },
          body,
        });
        const probe = await drcomProbe(sid).catch(() => null);
        if (probe) {
          try { if (ocr?.samples?.length) await OCR.confirmSamples(ocr.samples); } catch { /* 回存样板失败不影响登录 */ }
          drcomSession = { sid, at: Date.now(), user };
          await drcomSaveCookies(sid);
          return sid;
        }
        lastError = "账号、密码或验证码不对";
      }
      const err = new Error(lastError || "上网记录登录失败");
      err.needLogin = true;
      throw err;
    })().finally(() => { drcomPending = null; });
    return drcomPending;
  }

  /** ≤60 天分段：服务端超限不会报错，只会静默按自己的上限裁，所以必须自己切。 */
  function drcomSpans(start, end) {
    const spans = [];
    let cursor = start;
    let guard = 0;
    while (cursor <= end && guard < 24) {
      guard += 1;
      let stop = cursor;
      try { stop = tide.util.addDays(cursor, DRCOM_SPAN - 1); } catch { stop = end; }
      if (stop > end) stop = end;
      spans.push({ start: cursor, end: stop });
      if (stop >= end) break;
      try { cursor = tide.util.addDays(stop, 1); } catch { break; }
    }
    return spans.length ? spans : [{ start, end }];
  }

  async function drcomFetchSpan(sid, span) {
    const rows = [];
    let summary = null;
    let total = 0;
    for (let page = 1; page <= 20; page++) {
      const qs = `pageSize=${DRCOM_PAGE}&pageNumber=${page}&sortName=loginTime&sortOrder=DESC`
        + `&startTime=${encodeURIComponent(span.start)}&endTime=${encodeURIComponent(span.end)}`;
      const res = await tide.http.fetch(sid, "GET", `${DRCOM}/bill/getUserOnlineLog?${qs}`, {
        headers: { Accept: "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
      });
      if (Number(res?.status) !== 200) throw new Error(`上网记录接口返回 ${res?.status || "?"} `);
      const text = String(res?.body || "").trim();
      if (!text.startsWith("{")) {
        const err = new Error("上网记录会话已失效");
        err.expired = true;
        throw err;
      }
      let data = null;
      try { data = JSON.parse(text); } catch { throw new Error("上网记录接口返回的不是 JSON"); }
      if (!summary && data?.summary && typeof data.summary === "object") summary = data.summary;
      total = Number(data?.total) || total;
      const got = Array.isArray(data?.rows) ? data.rows : [];
      rows.push(...got);
      if (!got.length || rows.length >= total || rows.length >= DRCOM_CAP) break;
    }
    return { rows, summary, total };
  }

  /** 多段合并：按 loginTime + IP + NAS 端口去重，统一按上线时间倒序。 */
  async function drcomAggregate(sid, spans) {
    const rows = [];
    let summary = null;
    for (const span of spans) {
      const one = await drcomFetchSpan(sid, span);
      if (spans.length === 1) summary = one.summary || null;
      rows.push(...one.rows);
    }
    const seen = new Set();
    const unique = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const key = `${r.loginTime || ""}|${r.userIp || ""}|${r.nasPort || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    unique.sort((a, b) => (Number(b.loginTime) || 0) - (Number(a.loginTime) || 0));
    // 多段时各段 summary 不能相加口径不一（COU 是条数、TIME 是分钟），交给视图从 rows 自算。
    return { rows: unique, summary, total: unique.length, span: { start: spans[0].start, end: spans[spans.length - 1].end } };
  }

  async function drcomLogs(params = {}) {
    const today = tide.util?.today?.() || "";
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    let start = isDay(params.start) ? String(params.start) : today;
    let end = isDay(params.end) ? String(params.end) : today;
    if (start > end) { const t = start; start = end; end = t; }
    if (!start || !end) return { ok: false, message: "日期区间不可用" };
    try {
      let sid = await drcomLogin();
      const spans = drcomSpans(start, end);
      let data;
      try {
        data = await drcomAggregate(sid, spans);
      } catch (err) {
        if (!err?.expired) throw err;
        // 会话失效：丢 Cookie 重登一次（只一次，别把账号试到锁）。
        drcomForget();
        sid = await drcomLogin();
        data = await drcomAggregate(sid, spans);
      }
      return { ok: true, data };
    } catch (err) {
      return { ok: false, message: err?.message || explainHttpError(err) || "上网记录取数失败", needLogin: Boolean(err?.needLogin) };
    }
  }

  const netBridge = { logs: (params) => drcomLogs(params) };

  /* 上网记录：视图主体在 netlog.js，与成长 / 个人信息同一套边界（只借 storage / ui）。
     外壳（校园服务侧栏）由本文件画，记录页只画 [data-nl-host] 里那一块。
     实例缓存住：netlog.js 持有选中光句柄与偏好状态，每次进入都新建会叠起来。 */
  let netModule = null, netView = null;
  function mountNetLogView(el) {
    let disposed = false, teardown = null;
    ensureStyle();
    el.innerHTML = `<div class="${sideShellClass()}"><aside class="pp-side" data-side>${sideHtml()}</aside>${sideToggleHtml()}`
      + `<div class="pp-main"><div data-nl-host><div style="padding:30px;text-align:center;color:#A9B2BA;font-size:calc(12.5px * var(--ui-text-scale))">正在载入上网记录…</div></div></div></div>`;
    bindSide(el);
    loadLinkMeta(el);
    (netModule || (netModule = import("/plugins/cppu-notify/netlog.js")))
      .then((mod) => {
        if (disposed) return;
        const host = el.querySelector("[data-nl-host]");
        if (!host) return;
        netView = netView || mod.createNetLogView(tide, netBridge);
        teardown = netView.render(host);
      })
      .catch(() => {
        netModule = null;
        const host = el.querySelector("[data-nl-host]");
        if (host && !disposed) host.innerHTML = '<p class="pp-tip" style="padding:24px;text-align:center">上网记录模块加载失败，请重新打开本视图重试</p>';
      });
    return () => { disposed = true; if (typeof teardown === "function") teardown(); };
  }

  tide.ui.registerView({ id: "cppu-notify", title: "警大通知", icon: 'building-columns', render });
  tide.ui.registerView({ id: "cppu-card", title: "警大一卡通", icon: "credit-card", render: mountCardView });
  // 上网记录（drcom.cppu.edu.cn 自助服务系统）：另一套会话（JSESSIONID + 图形验证码），
  // 账号密码与门户同一套。icon 用 network-wired —— 与 chart-line（警大成绩）区分开，
  // 后者是图表语义，这里是「联网」语义，同一个侧栏里也不撞。
  tide.ui.registerView({ id: "cppu-net", title: "上网记录", icon: "network-wired", render: mountNetLogView });
  // 邮箱（mail.cppu.edu.cn / 雪球 Sirius Web，v0.255.0）：取数走老 XT 的 mbox 接口，
  // 点一封邮件走 openMailPage（原生端从 Cookie Jar 注入登录态，sid 不进 URL）。
  // icon 用 envelope —— 侧栏「警大邮箱」快捷入口本来就是信封，视图与入口同形更好认；
  // VIEW_ICONS8 / VIEW_FA_ICONS 里此前没有任何视图用过信封，不会撞。
  tide.ui.registerView({ id: "cppu-mail", title: "邮箱", icon: "envelope", render: mountMailView });
  // 获奖名单：通知正文里的获奖段落抽出来单独看（个人/团体排名 + 按时间的奖项项目）
  // icon 用 award 不用 trophy：trophy 已是「竞赛消息」插件的侧栏图标，同一个侧栏里不能撞。
  tide.ui.registerView({ id: "cppu-award", title: "警大获奖名单", icon: "award", render: mountAwardView });
  // 警大校历：学期起止 / 教学周 / 个人事项 / 本周课次统计（v0.216.0 从独立插件并入）
  // icon 用 calendar-week 不用 calendar-days：后者已是「课程表」插件的侧栏图标。
  tide.ui.registerView({ id: "cppu-calendar", title: "警大校历", icon: "calendar-week", render: mountCalendarView });
  // 个人信息（pdata.cppu.edu.cn）：身份卡 / 学业概览 / 成长指标 / 校园生活 / 考勤奖惩 /
  // 档案字段（点一下就复制）/ 数据报告目录，v0.281.0 起「学生成长」也在这页里。
  // icon 用 address-card 不用 id-card：id-card 已是本插件侧栏「学工」入口的图标。
  tide.ui.registerView({ id: "cppu-profile", title: "个人信息", icon: "address-card", render: mountProfileView });
  // 我的体测（sport-wechat.cppu.edu.cn）：只有企业微信能进的体测系统，取数靠同步脚本落下的 token。
  // icon 用 heart-pulse 不用 person-running：后者语义偏「运动」，这一页是体测成绩单。
  tide.ui.registerView({ id: "cppu-fitness", title: "我的体测", icon: "heart-pulse", render: mountFitnessView });
  // 后台轮询：收到验证码就写进剪贴板（v0.268.0）。没 window 的环境（测试 / 极早期加载）不排程。
  scheduleMailWatch();
  // 启动预热（v0.246.0 引入，v0.272.7 才真正挂上）—— 插件在应用启动时由 initPluginHost
  // 全部执行一遍，所以这一行就是「开机 8 秒后在后台把 CASTGC 的使用时间推后」。
  // 之前只有定义没有调用，预热一次都没跑过，5 天没开就必弹验证码。
  scheduleWarm();
  // 教务只读视图：侧栏「校园服务」里的选课 / 请假 / 成绩 / 创新学分入口直接 navigate 过来
  for (const cfg of JW_VIEWS) {
    tide.ui.registerView({
      id: cfg.id, title: cfg.title, icon: cfg.icon,
      render: (el) => mountJwView(el, cfg),
    });
  }
})();
