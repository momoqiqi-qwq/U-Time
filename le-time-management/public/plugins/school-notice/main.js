(function () {
  let host = null, sites = [], activeId = "", notices = [], busy = false, query = "";
  // 登录相关按钮自己的忙碌态：busy 是全局的（刷新/添加也用），
  // 光看 busy 会让「登录配置」在刷新通知时也显示读取中，所以单独记一个。
  let loginBusy = false;
  // 「编辑」模式只对当前站点生效：切换/删除站点时收回，避免编辑框串到别的站点上。
  let editing = false;
  // 站点设置卡片（图1 那块）是否展开。刻意不落盘：日常只看公告，
  // 每次打开插件都从收起态开始，点站点图标才展开，需要时才占纵向空间。
  let sitePanel = false;
  // 展开的正文只留内存：详情页正文动辄几 KB，写进本地存储会把它撑爆，
  // 关掉插件重开再抓一次即可（有 lastFetchedAt 缓存，抓取很便宜）。
  const expanded = new Set();
  const bodies = new Map();
  const bodyLoading = new Set();
  // 用户手动删掉的通知：记 URL 而不是删缓存，否则一刷新就又被抓回来。
  let hiddenUrls = [];
  let onlyNotice = true;
  const sessions = new Map();
  // ── 分页：列表页一次只给当页那十几条，历史通知全压在分页器后面 ────────────
  // 实测（北京大学本科招生网「通知公告」，2026-09-19 抓取）：一页 8 条、共 46 页，
  // 分页网址是 index.htm、index1.htm … index45.htm（页码写在文件名上，第 2 页才是 index1）。
  // 插件原先只请求用户填的那一个网址，等于永远只看得到最近 8 条。
  // 现在刷新连着读前 PAGE_ROUND 页，工具条上再给「再读 N 页」按页码往下走。
  const PAGE_ROUND = 5;
  // 一轮翻页的总时限（毫秒）。单页看门狗是 30 秒，五页串起来最坏能拖到分把钟，
  // 「处理中…」按那么久等于按钮坏掉 —— 到点就停下，剩下的页留给「再读 N 页」。
  const PAGE_BUDGET = 12000;
  // 分块渲染：翻页后列表能有上百条，一次全建进 DOM 时输入搜索每敲一个字都要重建整页。
  // 与 rss-reader / cppu-notify 同一套做法，先只画一屏，剩下的点「显示更多」补。
  const CHUNK = 20;
  let rendered = CHUNK;
  // 列表换了一批内容才收回首屏：刷新 / 切站点 / 换关键词 / 切筛选。
  // 「再读 N 页」和「显示更多」刻意不动它 —— 收回去会把用户已经展开的部分吞掉。
  const resetChunk = () => { rendered = CHUNK; };
  // 与 notices:<id> 缓存上限一致。截断丢的是最旧的：页码越往后日期越早。
  const MAX_ROWS = 100;
  // siteId -> { total, links: Map(页码→网址), read: Set(已读页码) }。
  // 只留内存（同 expanded/bodies）：缓存里存的是条目不是分页器，重开插件从第 1 页重读。
  const pagers = new Map();
  // 每个站点最近一次读取失败的错误：失败只靠 toast 一闪而过的话，
  // 用户只会看到「正在读取通知…」来回转，不知道到底发生了什么。
  const lastErrors = new Map();
  const loginRuntime = new Map();
  // 「点别处收起右键菜单」的 document 级监听只绑一次（宿主元素会随 render 重建）。
  let tabMenuDismissBound = false;
  // 「登录配置」失败的原因：光靠 toast 一闪而过，用户只会觉得按钮点了没反应。
  // 和 lastErrors 一样常驻显示，直到下一次操作把它清掉。
  const loginErrors = new Map();
  // 登录框里已填的内容（只留内存，不落盘）：paint() 会重建 DOM，
  // 不记住的话「刷新验证码」和「登录失败重试」都会把账号密码一起清空。
  const loginDraft = new Map();
  // 站点标签页的右键菜单：{ id, x, y }（x/y 是视口坐标，菜单用 position:fixed）。
  // 菜单里的动作与卡片按钮完全同一套实现，右键只是少一步「先切站点」。
  let tabMenu = null;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => `school-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const active = () => sites.find((x) => x.id === activeId) || sites[0] || null;
  // 看门狗：底层 invoke 一旦挂死（代理失效/连接被吞等），按钮会永远停在「处理中…」。
  // 给所有网络调用兜一个 30 秒超时，超时后 UI 一定恢复并给出错误提示。
  const FETCH_TIMEOUT = 30000;
  const withTimeout = (p, ms = FETCH_TIMEOUT) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`请求超过 ${Math.round(ms / 1000)} 秒未响应，已中断。请检查网络或代理后重试`)), ms)),
  ]);
  // 提示失败绝不能吞掉动作本身：宿主 tide.notify 会走权限校验，manifest 少声明
  // 一项能力它就抛错 —— 而插件过去把「报错」也交给 tide.notify，于是 catch 里
  // 一抛，错误提示和后续步骤（例如登录成功后的 refresh）一起消失，按钮看着像坏的。
  const toast = (msg) => { try { tide.notify(msg); } catch (e) { console.warn("[school-notice] 通知发送失败：", e); } };

  function styles() {
    if (document.getElementById("school-notice-style")) return;
    const s = document.createElement("style"); s.id = "school-notice-style";
    s.textContent = `
      .sn{max-width:1120px;margin:0 auto;padding:12px 0 32px;color:var(--ink)}.sn-card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;margin-bottom:12px}.sn-add{display:grid;grid-template-columns:1fr 1.35fr auto;gap:9px}.sn-in{height:40px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);padding:0 11px;min-width:0}.sn-btn{min-height:40px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);padding:7px 13px;font-weight:650}.sn-btn.pri{background:var(--deep);border-color:var(--deep);color:white}.sn-btn:disabled{opacity:.5}.sn-note{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2);line-height:1.7;margin-top:9px}
.sn-sites{display:flex;align-items:center;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line-soft)}.sn-sites-label{flex:none;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3)}.sn-chips{display:flex;gap:7px;overflow:auto;padding:2px;min-width:0}
.sn-chip{flex:none;display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 9px;border:1px solid var(--line);border-radius:11px;background:var(--paper);color:var(--ink-2);font:inherit;font-size:calc(12px * var(--ui-text-scale));cursor:pointer}.sn-chip .sn-chip-name{display:inline;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}.sn-chip.cur{border-color:color-mix(in srgb,var(--deep) 42%,var(--line))}.sn-chip.cur::after{content:"⌄";font-size:calc(13px * var(--ui-text-scale));line-height:1;color:var(--ink-3)}.sn-chip.on{background:color-mix(in srgb,var(--deep) 10%,var(--panel));border-color:var(--deep);color:var(--deep)}.sn-chip.on::after{content:"⌃"}.sn-chip:focus-visible{outline:3px solid var(--mint);outline-offset:2px}
.sn-site{animation:sn-site-in .26s cubic-bezier(.2,.78,.2,1)}@keyframes sn-site-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.sn-head{display:flex;align-items:flex-start;gap:12px;justify-content:space-between}.sn-head>div:first-child{flex:1 1 auto;min-width:0}.sn-head h2{font-size:calc(19px * var(--ui-text-scale));margin:0 0 4px;display:flex;align-items:center;gap:8px}.sn-head h2 .sn-name{min-width:0;overflow-wrap:anywhere}.sn-fav.big{width:22px;height:22px;border-radius:6px;margin-top:0}.sn-fav.big img{width:22px;height:22px}.sn-fav.big.no-img::after{width:22px;height:22px;border-radius:6px;font-size:calc(12px * var(--ui-text-scale))}.sn-meta{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3);line-height:1.6;overflow-wrap:anywhere}.sn-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;flex:none}.sn-login{margin-top:14px;border-top:1px solid var(--line-soft);padding-top:14px}.sn-login-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.sn-login-grid label{display:grid;gap:5px;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2)}.sn-login-grid .wide{grid-column:1/-1}.sn-captcha{display:flex;align-items:center;gap:9px}.sn-captcha img{max-width:180px;max-height:72px;border-radius:8px;border:1px solid var(--line);background:white}.sn-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.sn-toolbar .sn-in{flex:1 1 240px;max-width:560px;min-width:180px}
  /* 搜索框只留一颗放大镜（用户要求「删除所有搜索框内的中文，仅保留搜索图标」） */
  .sn-searchbox{position:relative;display:flex;align-items:center;flex:1 1 240px;max-width:560px;min-width:180px}
  .sn-searchbox>.sn-in{flex:1;min-width:0;padding-left:34px}
  .sn-search-ico{position:absolute;left:12px;width:15px;height:15px;display:inline-flex;color:var(--ink-3);pointer-events:none}
  .sn-search-ico svg{width:100%;height:100%;display:block}.sn-count{flex:none;white-space:nowrap}.sn-pager{flex:none;white-space:nowrap}.sn-more{display:block;margin:10px auto 0}.sn-toggle{margin-left:auto}.sn-login-url{display:block;width:min(100%,460px);margin-top:8px}
.sn-tabmenu{position:fixed;z-index:60;min-width:168px;max-width:260px;padding:6px;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:0 14px 34px rgba(34,48,58,.2);display:flex;flex-direction:column;gap:2px}
.sn-tabmenu-title{padding:5px 9px 7px;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sn-tabmenu button{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--ink);font:inherit;font-size:calc(12.5px * var(--ui-text-scale));padding:8px 9px;border-radius:8px;min-height:34px}
.sn-tabmenu button:hover{background:var(--paper)}
.sn-tabmenu button:disabled{opacity:.5;cursor:default}
.sn-tabmenu button.danger{color:var(--danger)}
.sn-tabmenu button.danger:hover{background:color-mix(in srgb,var(--danger) 10%,var(--panel))}
.sn-tabmenu .sep{height:1px;margin:5px 4px;background:var(--line-soft)}.sn-list{display:grid;gap:8px}.sn-item{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px 14px;content-visibility:auto;contain-intrinsic-size:auto 74px;transition:border-color .28s ease,box-shadow .28s ease,background .28s ease}.sn-item:hover{background:var(--paper)}.sn-item.open{border-color:color-mix(in srgb,var(--deep) 18%,var(--line));box-shadow:0 7px 24px rgba(34,48,58,.055);content-visibility:visible}.sn-heading{display:block;width:100%;text-align:left;background:transparent;border:0;color:inherit;padding:2px 0;cursor:pointer;font-family:inherit;min-height:40px}.sn-heading:focus-visible{outline:3px solid var(--mint);outline-offset:2px}.sn-title{display:flex;align-items:flex-start;gap:7px;font-size:calc(13.5px * var(--ui-text-scale));font-weight:700;line-height:1.5}.sn-title>span:last-child{min-width:0;overflow-wrap:anywhere}.sn-meta-row{display:flex;gap:8px;align-items:center;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2);margin-top:4px;flex-wrap:wrap}.sn-tag{border-radius:6px;padding:2px 8px;background:color-mix(in srgb,var(--deep) 10%,var(--panel));color:var(--deep);font-size:calc(10px * var(--ui-text-scale))}.sn-snip{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2);line-height:1.55;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.sn-expand{margin-top:6px;min-height:34px;display:inline-flex;align-items:center;gap:7px;font-size:calc(11px * var(--ui-text-scale));transition:background .2s ease,border-color .2s ease,color .2s ease}.sn-expand::after{content:"⌄";display:inline-block;font-size:calc(14px * var(--ui-text-scale));line-height:1;transform:translateY(-1px);transition:transform .36s cubic-bezier(.22,.8,.22,1)}.sn-item.open .sn-expand::after{transform:translateY(1px) rotate(180deg)}.sn-detail-shell{display:grid;grid-template-rows:0fr;opacity:0;margin-top:0;transition:grid-template-rows .42s cubic-bezier(.2,.78,.2,1),opacity .24s ease,margin-top .42s cubic-bezier(.2,.78,.2,1)}.sn-item.open .sn-detail-shell{grid-template-rows:1fr;opacity:1;margin-top:9px}.sn-detail-clip{min-height:0;overflow:hidden}.sn-detail{border-top:1px dashed var(--line-soft);padding-top:9px;transform:translateY(-6px);transition:transform .36s cubic-bezier(.2,.78,.2,1)}.sn-item.open .sn-detail{transform:translateY(0)}.sn-item-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}.sn-item-acts button{border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:calc(11px * var(--ui-text-scale));padding:5px 10px;cursor:pointer;font-family:inherit}.sn-item-acts button:hover{border-color:var(--deep);color:var(--deep)}.sn-empty{border:1.5px dashed var(--line);border-radius:16px;padding:30px;text-align:center;color:var(--ink-3);line-height:1.7}.sn-warn{background:color-mix(in srgb,var(--sun) 12%,var(--panel));border:1px solid color-mix(in srgb,var(--sun) 35%,var(--line));border-radius:12px;padding:10px 12px;color:var(--ink-2);font-size:calc(12px * var(--ui-text-scale));line-height:1.65;margin-top:10px}.sn-ok{display:inline-flex;border-radius:999px;padding:3px 8px;background:color-mix(in srgb,var(--mint) 14%,var(--panel));color:var(--deep);font-size:calc(10px * var(--ui-text-scale));margin-top:5px}.sn-toggle.on{background:var(--deep);border-color:var(--deep);color:white}.sn-fav{flex:none;width:16px;height:16px;margin-top:1px;border-radius:4px;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;background:var(--paper)}.sn-fav img{width:16px;height:16px;object-fit:contain;display:block}.sn-fav.no-img img{display:none}.sn-fav.no-img::after{content:attr(data-initial);width:16px;height:16px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:calc(10px * var(--ui-text-scale));font-weight:700;color:var(--deep);background:color-mix(in srgb,var(--deep) 14%,var(--panel))}.sn-fav.has-icon{background-image:var(--sn-icon);background-size:contain;background-repeat:no-repeat;background-position:center}.sn-article{margin-top:9px;padding:10px 12px;border:1px solid var(--line-soft);border-radius:10px;background:var(--paper);color:var(--ink-2);font-size:calc(12.5px * var(--ui-text-scale));line-height:1.75;word-break:break-word;max-height:420px;overflow:auto}
      @media(max-width:720px){.sn-add{grid-template-columns:1fr}.sn-sites{align-items:flex-start;gap:8px}.sn-chip{min-height:44px}.sn-head{display:block}.sn-actions{justify-content:flex-start;margin-top:10px}.sn-login-grid{grid-template-columns:1fr}.sn-login-grid .wide{grid-column:auto}.sn-heading{min-height:44px}.sn-item-acts button{min-height:44px;font-size:calc(12px * var(--ui-text-scale))}.sn-toolbar .sn-in{flex:1 1 100%;max-width:none}.sn-searchbox{flex:1 1 100%;max-width:none}}
    `; document.head.append(s);
  }
  async function save() { await tide.storage.set("sites", sites.map(({ id, name, url, loginUrl, cms, lastFetchedAt, iconUrl, iconData, spaHint }) => ({ id, name, url, loginUrl, cms, lastFetchedAt, iconUrl, iconData, spaHint }))); }

  // ── 站点图标 ────────────────────────────────────────────────────────────
  // 图标一律优先用抓好的 data URL。原因：Android 上页面来源是
  // `https://tauri.localhost`，WebView 默认禁混合内容，学校网站常见的
  // `http://…/favicon.ico` 用 `<img src>` 直连会被**静默拦掉**（桌面端页面来源是
  // http，看不出问题）。data URL 由原生侧抓取后落盘，两端都稳、离线也显示得出来。
  //
  // data URL 走 CSS 变量而不是每行内联 `<img>`：公告列表上百条，每条内联一份
  // base64 会让 DOM 体积成倍涨。变量设在 `.sn-list` 容器上，列表项继承同一份。
  // 只认我们自己生成的位图 data URL。**不能只查 `data:image/` 前缀** ——
  // 那样 `data:image/png;base64,x" onload="…` 这种脏值能直接突破 style 属性；
  // 真正的约束是「base64 段只含 base64 字符」（base64 字母表里没有引号）。
  // 顺带再拒一次 svg：Rust 侧已经拒了，这里做纵深防御。
  function iconDataOf(site) {
    const v = site.iconData;
    return typeof v === "string" && /^data:image\/(?!svg)[a-z0-9][a-z0-9.+-]*;base64,[A-Za-z0-9+/]+={0,2}$/i.test(v) ? v : "";
  }

  // 图标变量可以设在容器上让子元素继承 —— 公告列表上百条，每条内联一份 base64 会让 DOM 体积成倍涨。
  function iconStyleAttr(site) {
    const data = iconDataOf(site);
    return data ? ` style="--sn-icon:url(&quot;${data}&quot;)"` : "";
  }

  function favHtml(site, extraClass = "", inline = true) {
    const initial = esc((site.name || "学").slice(0, 1));
    if (iconDataOf(site)) {
      return `<span class="sn-fav${extraClass} has-icon" data-initial="${initial}"${inline ? iconStyleAttr(site) : ""}></span>`;
    }
    // 还没抓到 data URL 时仍用远程地址直连：桌面端照常显示，Android 上失败则由
    // 容器上的 error 委托加上 `.no-img`，退回首字母方块。
    if (site.iconUrl) return `<span class="sn-fav${extraClass}" data-initial="${initial}"><img src="${esc(site.iconUrl)}" alt=""></span>`;
    return "";
  }

  // 站点菜单收在「添加站点」卡片里：名称始终显示，避免多个站点只剩下难以辨认的图标。
  // 当前站点才显示展开箭头；设置卡片默认收起，再点一次当前站点才展开。
  // favHtml 三层降级全空时返回空串，这里补一个首字母方块，否则图标位是空的。
  function chipHtml(x, site) {
    const cur = x.id === site?.id;
    const on = cur && sitePanel;
    const icon = favHtml(x, " big") || `<span class="sn-fav big no-img" data-initial="${esc((x.name || "学").slice(0, 1))}"></span>`;
    return `<button class="sn-chip${cur ? " cur" : ""}${on ? " on" : ""}" data-site="${esc(x.id)}" aria-expanded="${on}" title="${esc(x.name)}｜点击${on ? "收起" : "展开"}站点设置 · 右键：刷新 / 登录配置 / 编辑 / 打开 / 删除">${icon}<span class="sn-chip-name">${esc(x.name)}</span></button>`;
  }

  // 抓一次站点图标并落盘。失败**不抛** —— 调用它的是刷新流程，图标拿不到不该
  // 影响公告本身。抓到后重绘一次让图标就位。
  async function ensureIconData(site, repaint = true) {
    const src = String(site.iconUrl || "");
    if (!src || site.iconData) return;
    try {
      const data = await tide.http.getIcon(src);
      if (!data) return;
      site.iconData = data;
      await save();
      if (repaint) paint();
    } catch { /* 走首字母兜底 */ }
  }
  async function loadHidden(id) { const v = await tide.storage.get(`hidden:${id}`, []); hiddenUrls = Array.isArray(v) ? v : []; }
  async function sessionFor(site) { if (!sessions.has(site.id)) sessions.set(site.id, await tide.http.session()); return sessions.get(site.id); }
  function cmsName(html) {
    const s = String(html || "").toLowerCase();
    if (/vsb_content|_vsb_|visualsitebuilder|v_news_content/.test(s)) return "高校 VSB / VisualSiteBuilder";
    if (/wp-content|wordpress/.test(s)) return "WordPress";
    if (/dede:|dedecms/.test(s)) return "DedeCMS";
    if (/drupal-settings-json|sites\/default\/files/.test(s)) return "Drupal";
    if (/powerby.*siteengine|siteengine/.test(s)) return "SiteEngine";
    if (/siteserver|stl:|siteserver cms/.test(s)) return "SiteServer CMS";
    if (/phpcms|content_list|showid=/i.test(s)) return "PHPCMS";
    if (/joomla|com_content|option=com_/i.test(s)) return "Joomla";
    if (/metinfo|met_[a-z_]+/i.test(s)) return "MetInfo";
    if (/jeecg|ant-design-vue|ruoyi|若依|vue-admin|uni-app|unipush|__next_data__|__nuxt__|_nuxt\/|_next\/static/i.test(s)) return "前端渲染公告 / 消息栏";
    return "通用高校公告解析";
  }
  const kindOf = (n) => n.kind || tide.util.web.noticeKind(n.title);
  // 去掉已删除的 → 按关键词搜索 → 最后才做「仅通知/公告」收敛。
  // 收敛后一条不剩时（有的站点标题里根本不写「通知」二字）退回显示全部，
  // 免得用户以为插件坏了。
  function matched() {
    const q = query.trim().toLowerCase();
    const rows = notices.filter((x) => !hiddenUrls.includes(x.url));
    return q ? rows.filter((x) => `${x.title} ${x.snippet || ""} ${x.date || ""}`.toLowerCase().includes(q)) : rows;
  }
  function filtered() {
    const rows = matched();
    if (!onlyNotice) return rows;
    const hits = rows.filter((x) => kindOf(x) === "notice");
    return hits.length ? hits : rows;
  }

  async function fetchPage(site, url, opts = {}) {
    // session() 也要纳入看门狗：否则底层 invoke 挂死时连超时错误都出不来。
    const sid = await withTimeout(sessionFor(site));
    return withTimeout(tide.http.fetch(sid, opts.method || "GET", url, { headers: opts.headers, body: opts.body, binary: opts.binary }));
  }
  // 取数：分两条路 —— 命中「JSON 接口型」适配器就直接读它的数据接口；
  // 否则按 HTML 解析。两条路产出的条目**同构**（title/url/date/score/kind/snippet），
  // 所以后面的搜索、筛选、转提醒不必区分来源。
  // `hint` 是「为什么一条都没有」的解释，只在 0 条时才有值。
  async function collectNotices(site, html, finalUrl) {
    const adapter = tide.util.web.matchJsonSiteAdapter(finalUrl);
    if (adapter) {
      try {
        const apiUrl = tide.util.web.buildJsonSiteListUrl(adapter.id, finalUrl, { max: 100 });
        const res = apiUrl ? await fetchPage(site, apiUrl, { headers: { "Accept": "application/json, text/plain, */*", "Referer": finalUrl } }) : null;
        const rows = res && res.status < 400 ? tide.util.web.parseJsonSiteList(adapter.id, res.body, finalUrl, { max: 100 }) : [];
        if (rows.length) return { rows, mode: adapter.label, hint: "" };
        return { rows: [], mode: adapter.label, hint: `已按适配器读取 ${adapter.label}，但接口没返回条目${res ? `（HTTP ${res.status}）` : "（接口地址未能生成）"}。可点「打开网站」确认页面还能正常访问。` };
      } catch (e) {
        return { rows: [], mode: adapter.label, hint: `已按适配器读取 ${adapter.label}，但接口请求失败：${e.message || e}` };
      }
    }
    const rows = tide.util.web.extractNoticeLinks(html, finalUrl, { max: 100 });
    if (rows.length) return { rows, mode: cmsName(html), hint: "" };
    const embedded = tide.util.web.extractEmbeddedJsonNotices(html, finalUrl, { max: 100 });
    if (embedded.length) return { rows: embedded, mode: "内嵌 JSON 状态", hint: "" };
    const apis = tide.util.web.extractNoticeApiCandidates(html, finalUrl, { max: 8 });
    for (const apiUrl of apis) {
      try {
        const res = await fetchPage(site, apiUrl, { headers: { "Accept": "application/json, text/plain, */*", "Referer": finalUrl } });
        if (res.status >= 400) continue;
        const got = tide.util.web.parseGenericNoticeJson(res.body, res.finalUrl || apiUrl, { max: 100 });
        if (got.length) return { rows: got, mode: "自动发现 JSON 列表接口", hint: "" };
      } catch { /* 下一个候选接口继续试 */ }
    }
    // 一条都没解析出来时才判「是不是 JS 渲染的空壳」—— 这类站点换列表页也救不了，
    // 必须把原因说清楚，否则用户只会看到「已读取 0 条公告」。
    const spa = tide.util.web.detectSpaShell(html);
    return {
      rows: [], mode: cmsName(html),
      hint: spa ? `这个页面是 ${spa.framework} 单页应用：HTML 里只有 ${spa.links} 个链接，插件已尝试内嵌状态和 ${apis.length} 个疑似公告接口但仍未读到条目。可换成学校的「通知公告」列表页；若该站另有数据接口，反馈给插件做站点适配。` : "",
    };
  }

  /* ── 翻页 ────────────────────────────────────────────────────────────────
     分页器只在第一页解析一次就够：extractPager 会把「1…5 + 末页」这种窗口补成
     完整的页码表。用户填的网址本身就是第 3 页时，把第 3 页记成已读，往下走。 */
  function buildPager(html, pageUrl) {
    const { total, pages } = tide.util.web.extractPager(html, pageUrl);
    if (total <= 1 || pages.length < 2) return null;
    const here = String(pageUrl).replace(/[?#].*$/, "");
    const self = pages.find((x) => String(x.url).replace(/[?#].*$/, "") === here);
    return { total, links: new Map(pages.map((x) => [x.page, x.url])), read: new Set([self ? self.page : 1]) };
  }

  // 合并两批条目：同一篇通知可能同时挂在相邻两页上（分页边界），按网址去掉；
  // 再按日期倒序压平，最后截到缓存上限。
  function mergeRows(base, extra) {
    const byUrl = new Map();
    for (const r of [...base, ...extra]) {
      const key = String(r.url || "").replace(/[?#].*$/, "");
      if (key && !byUrl.has(key)) byUrl.set(key, r);
    }
    return [...byUrl.values()]
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.score || 0) - (a.score || 0))
      .slice(0, MAX_ROWS);
  }

  // 从 from 页起最多连读 round 页，新条目并进 notices。返回读到的页数与两种收尾原因：
  //   gained  = **真带来新条目**的页数
  //   slow    = 到 PAGE_BUDGET 时限被砍停（站点响应慢，剩下的页还没读）
  // 单页失败（超时 / HTTP 4xx / 那页解析不出条目）就跳过继续往下：一页读不到不该把
  // 整轮抓取和已经拿到手的条目一起废掉。页码一律先记进 read，失败页不会每轮重试。
  // 满了 MAX_ROWS 也停：再往下翻只会把同样一批「最新的 100 条」换一遍，
  // 白请 5 个请求还让页码一直涨，用户看着像卡在原地。
  async function walkPages(site, pager, from, round) {
    const deadline = Date.now() + PAGE_BUDGET;
    let gained = 0;
    for (let page = from; gained < round && page <= pager.total && notices.length < MAX_ROWS; page++) {
      const url = pager.links.get(page);
      if (!url || pager.read.has(page)) continue;
      if (Date.now() > deadline) return { gained, slow: true };
      pager.read.add(page);
      let rows = [];
      try {
        const res = await fetchPage(site, url);
        if (res.status < 400) rows = (await collectNotices(site, res.body, res.finalUrl || url)).rows;
      } catch { continue; }
      if (!rows.length) continue;
      const before = notices.length;
      notices = mergeRows(notices, rows);
      if (notices.length > before) gained++;
    }
    return { gained, slow: false };
  }

  const lastReadPage = (pager) => Math.max(...pager.read);

  // 「再读 N 页」：接着上次读到的页码往下走，读过的页不再请求。
  async function loadMorePages(site) {
    const pager = pagers.get(site.id);
    if (!pager || busy) return;
    busy = true; paint();
    try {
      const { gained, slow } = await walkPages(site, pager, lastReadPage(pager) + 1, PAGE_ROUND);
      await tide.storage.set(`notices:${site.id}`, notices.slice(0, MAX_ROWS));
      // 三种「这轮没新增」的原因要分开说，否则用户分不清是到底了、卡了、还是站点改版了
      if (slow) toast(`站点响应太慢，这一轮只读到第 ${lastReadPage(pager)} 页，可再点一次继续`);
      else if (notices.length >= MAX_ROWS) toast(`本地列表只缓存最新 ${MAX_ROWS} 条，不再往前读取`);
      else if (!gained) toast(lastReadPage(pager) >= pager.total ? "已经是最后一页，没有更多通知了" : "后面的分页没读到新通知：可能站点改版，或这些页已经读过了");
    } catch (e) { toast(`读取更多分页失败：${e.message || e}`); }
    finally { busy = false; paint(); }
  }

  // 工具条上的分页进度。没认出分页器（单页站点 / JSON 接口）时整块不出现。
  // 三种收尾态要分开说：读到末页 / 缓存条数已满（还能翻但不会再多一条）。
  function pagerHtml(site) {
    const pager = pagers.get(site.id);
    if (!pager) return "";
    const left = pager.total - lastReadPage(pager);
    const full = notices.length >= MAX_ROWS;
    const label = full ? `缓存已满 ${MAX_ROWS} 条` : left > 0 ? (busy ? "读取中…" : `再读 ${Math.min(PAGE_ROUND, left)} 页`) : "已是最后一页";
    const title = full ? ` title="本地列表只缓存最新 ${MAX_ROWS} 条，再往前翻不会增加条数"` : "";
    return `<span class="sn-meta sn-pager">已读 ${pager.read.size} / ${pager.total} 页</span>`
      + `<button class="sn-btn" data-more-pages${title}${busy || full || left <= 0 ? " disabled" : ""}>${label}</button>`;
  }

  /* ── 插件联动：抓到新公告时广播 notice:new，微信推送插件订阅后按插件勾选合并推送 ──
     判「新」用「上次见过的 URL 集合」而不是列表差分：本插件没有已读标记，靠上次快照才能认出新条目。
     存储里没有 seen 键 = 这个站点第一次读到列表，只记集合不广播，否则装好插件就把整页历史公告推一遍。
     「再读 N 页」刻意不广播（loadMorePages 不调本函数）：翻出来的是早就发出去的历史通知。
     广播失败绝不能影响读取本身，所以单独 try/catch。 */
  async function broadcastNew(site, rows) {
    const stored = await tide.storage.get(`seen:${site.id}`, null);
    const known = new Set(Array.isArray(stored) ? stored : []);
    const fresh = stored === null ? [] : rows.filter((n) => n.url && !known.has(n.url));
    await tide.storage.set(`seen:${site.id}`, rows.map((n) => n.url));
    if (!fresh.length) return;
    try {
      tide.events.emit("notice:new", {
        source: "school-notice", sourceName: "学校通知", total: fresh.length,
        items: fresh.slice(0, 5).map((n) => ({ title: n.title, time: n.date || "", sender: site.name || "" })),
      });
    } catch {}
  }

  async function publishCachedNotices() {
    try {
      const groups = await Promise.all(sites.map(async (site) => ({
        site, rows: await tide.storage.get(`notices:${site.id}`, []), hidden: await tide.storage.get(`hidden:${site.id}`, []),
      })));
      tide.messages?.publish(groups.flatMap(({ site, rows, hidden }) => (Array.isArray(rows) ? rows : [])
        .filter((n) => !Array.isArray(hidden) || !hidden.includes(n.url)).slice(0, 20)
        .map((n) => ({ title: n.title, time: n.date || "", sender: site.name || "", sourceName: `学校通知·${site.name || "网站"}` }))));
    } catch {}
  }

  async function readNotices(site) {
    const res = await fetchPage(site, site.url);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const form = tide.util.web.detectLoginForm(res.body, res.finalUrl || site.url);
    const likelyLogin = !!form && (/login|sso|auth|cas/i.test(res.finalUrl || "") || form.passwordField);
    if (likelyLogin) {
      loginRuntime.set(site.id, { form, pageUrl: res.finalUrl || site.url, message: "检测到登录页面，请完成账号、密码和验证码后登录。" });
      // 登录框长在站点卡片里。卡片收着的话，列表只剩一句「请先完成登录」，
      // 用户根本够不着那个表单 —— 这种阻塞态必须自己把卡片摊开。
      sitePanel = true;
      notices = []; return { login: true, html: res.body };
    }
    loginRuntime.delete(site.id); loginErrors.delete(site.id);
    const finalUrl = res.finalUrl || site.url;
    site.lastFetchedAt = Date.now();
    // 空壳页**既没有 `<title>` 也没有 `<link rel=icon>`**：站名会退成域名、图标只能猜一个
    // `/favicon.ico`。命中适配器时用登记里的值补齐；站名只在「还是域名」时才改，
    // 不覆盖用户自己起的名字。未登记的站点仍走 parseSiteMeta 兜底。
    const adapter = tide.util.web.matchJsonSiteAdapter(finalUrl);
    if (adapter?.icon) site.iconUrl = adapter.icon;
    else if (!site.iconUrl) { try { site.iconUrl = tide.util.web.parseSiteMeta(res.body, finalUrl).iconUrl || ""; } catch {} }
    if (adapter?.title) { try { if (!site.name || site.name === new URL(site.url).hostname) site.name = adapter.title; } catch {} }
    const got = await collectNotices(site, res.body, finalUrl);
    site.cms = got.mode; site.spaHint = got.hint;
    notices = got.rows; resetChunk();
    // HTML 列表页接着往下翻 PAGE_ROUND 页。JSON 适配器走的是站点自己的接口，
    // 一次就带回 max 条、页面里没有分页器可翻，所以不动 pagers。
    const pager = adapter ? null : buildPager(res.body, finalUrl);
    if (pager) {
      pagers.set(site.id, pager);
      await walkPages(site, pager, Math.min(...pager.read) + 1, PAGE_ROUND - 1);
    } else pagers.delete(site.id);
    await tide.storage.set(`notices:${site.id}`, notices.slice(0, MAX_ROWS)); await save();
    await publishCachedNotices();
    // 刷新顺带补图标：升级到「原生抓取」之前的存量站点只有远程地址，
    // 在 APK 上拿不到 —— 用户点一次刷新就把 data URL 补上。
    await ensureIconData(site, false);
    await broadcastNew(site, notices);
    return { login: false, html: res.body };
  }

  async function prepareLogin(site) {
    const url = site.loginUrl || site.url;
    const res = await fetchPage(site, tide.util.web.normalizeUrl(url));
    if (res.status >= 400) throw new Error(`登录页 HTTP ${res.status}`);
    const form = tide.util.web.detectLoginForm(res.body, res.finalUrl || url);
    if (!form) throw new Error("没有自动识别到登录表单。可检查登录网址是否正确；使用 JS 加密/扫码/第三方统一认证的网站需要单独适配。");
    const rt = { form, pageUrl: res.finalUrl || url, message: "已识别登录表单。密码仅用于当前会话，不写入本地配置。", captchaData: "" };
    loginRuntime.set(site.id, rt);
    if (form.captchaImageUrl) {
      try {
        const img = await fetchPage(site, form.captchaImageUrl, { binary: true });
        if (img.status < 400 && img.body && img.body.length < 900000) rt.captchaData = `data:${img.contentType || "image/png"};base64,${img.body}`;
      } catch {}
    }
  }

  // 「登录配置 / 刷新验证码」：识别登录表单并取验证码图。要发网络请求（最长 30 秒），
  // 必须有「处理中」反馈 —— 否则按钮看着像坏的；失败原因也要留在卡片上。
  async function openLoginConfig(site) {
    if (busy) return;
    busy = true; loginBusy = true; loginErrors.delete(site.id); paint();
    try {
      await prepareLogin(site);
      const d = loginDraft.get(site.id); if (d) d.captcha = "";   // 换了新验证码图，旧输入作废
      await save();
    }
    catch (e) { const m = e.message || String(e); loginErrors.set(site.id, m); toast(`登录页读取失败：${m}`); }
    finally { busy = false; loginBusy = false; paint(); }
  }

  // 登录提交：先把输入框里的内容读出来，再置 busy 重绘 —— paint() 会重建 host.innerHTML，
  // 顺序反了会把用户刚填的账号密码清空。另外必须先清掉 busy 再 refresh：
  // refresh 自己会置 busy 并在开头 `if (!site || busy) return`，不清就把读公告挡回去了。
  async function doSubmitLogin(site) {
    if (busy) return;
    const box = host.querySelector("[data-login-box]");
    const creds = {
      username: box?.querySelector("[data-user]")?.value || "",
      password: box?.querySelector("[data-pass]")?.value || "",
      captcha: box?.querySelector("[data-captcha]")?.value || "",
    };
    busy = true; loginBusy = true; loginErrors.delete(site.id); paint();
    let ok = false;
    try { ok = await submitLogin(site, creds); }
    catch (e) { const m = e.message || String(e); loginErrors.set(site.id, m); toast(m); }
    finally { busy = false; loginBusy = false; }
    if (ok) return refresh(false);
    paint();
  }

  // 返回值 = 登录是否成功（成功时由 doSubmitLogin 接着读公告）。
  async function submitLogin(site, creds) {
    const rt = loginRuntime.get(site.id); if (!rt?.form) throw new Error("请先识别登录页");
    const form = rt.form; if (!host.querySelector("[data-login-box]")) return false;
    const { username = "", password = "", captcha = "" } = creds || {};
    if (form.usernameField && !username) throw new Error("请输入账号");
    if (form.passwordField && !password) throw new Error("请输入密码");
    if (form.captchaField && !captcha) throw new Error("请输入图片中的验证码");
    const fields = {};
    for (const f of form.fields || []) if (f.name && f.value !== undefined) fields[f.name] = f.value;
    if (form.usernameField) fields[form.usernameField] = username;
    if (form.passwordField) fields[form.passwordField] = password;
    if (form.captchaField) fields[form.captchaField] = captcha;
    const body = tide.util.web.formEncode(fields);
    let action = form.action || rt.pageUrl, method = form.method || "POST";
    let res;
    if (method === "GET") res = await fetchPage(site, action + (action.includes("?") ? "&" : "?") + body);
    else res = await fetchPage(site, action, { method, headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": rt.pageUrl }, body });
    if (res.status >= 400) throw new Error(`登录提交失败（HTTP ${res.status}）`);
    const still = tide.util.web.detectLoginForm(res.body, res.finalUrl || action);
    if (still?.passwordField && (/login|sso|auth|cas/i.test(res.finalUrl || "") || res.body.includes(form.passwordField))) {
      rt.message = "登录后仍停留在登录页：可能是账号/密码/验证码错误，或该站点需要 JS 加密/统一认证专用适配。";
      rt.form = still;
      if (still.captchaImageUrl) {
        try { const img = await fetchPage(site, still.captchaImageUrl, { binary: true }); rt.captchaData = img.status < 400 ? `data:${img.contentType || "image/png"};base64,${img.body}` : ""; } catch { rt.captchaData = ""; }
      }
      return false;
    }
    loginRuntime.delete(site.id); loginErrors.delete(site.id); loginDraft.delete(site.id);
    toast("登录会话已建立，正在读取学校通知");
    return true;
  }

  async function addSite() {
    const nameInput = host.querySelector("[data-new-name]"), urlInput = host.querySelector("[data-new-url]");
    const raw = urlInput?.value || ""; if (!raw.trim()) return toast("请输入学校通知网站网址");
    busy = true; paint();
    try {
      const url = tide.util.web.normalizeUrl(raw); const id = uid(); const tmp = { id, name: nameInput?.value.trim() || "学校通知", url, loginUrl: "", cms: "自动识别", lastFetchedAt: 0, iconUrl: "" };
      sites.push(tmp); activeId = id; sitePanel = true;   // 新站点直接摊开配置：很可能下一步就要登录
      try {
        const res = await fetchPage(tmp, url);
        const finalUrl = res.finalUrl || url;
        const meta = tide.util.web.parseSiteMeta(res.body, finalUrl);
        const ad = tide.util.web.matchJsonSiteAdapter(finalUrl);
        if (!nameInput?.value.trim()) tmp.name = ad?.title || meta.title || tmp.name;
        tmp.iconUrl = ad?.icon || meta.iconUrl || "";
        tmp.cms = cmsName(res.body);
        const form = tide.util.web.detectLoginForm(res.body, finalUrl);
        if (form?.passwordField) {
          // 公告页被重定向到登录页时，保留原公告 URL；登录成功后才能回到正确列表。
          tmp.loginUrl = finalUrl !== url ? finalUrl : tmp.loginUrl;
          loginRuntime.set(tmp.id, { form, pageUrl: finalUrl, message: "检测到登录页面，请完成登录。", captchaData: "" });
        } else {
          tmp.url = finalUrl;
          const got = await collectNotices(tmp, res.body, finalUrl);
          tmp.cms = got.mode; tmp.spaHint = got.hint; notices = got.rows;
          // 新站点先只读第一页（添加这一步已经在等一个请求了），但把分页器认下来，
          // 工具条上的「再读 N 页」当场可用，不必先刷一次。
          const pager = tide.util.web.matchJsonSiteAdapter(finalUrl) ? null : buildPager(res.body, finalUrl);
          if (pager) pagers.set(id, pager);
          tmp.lastFetchedAt = Date.now(); await tide.storage.set(`notices:${id}`, notices.slice(0, MAX_ROWS));
        }
      } catch (e) { lastErrors.set(tmp.id, e.message || String(e)); toast(`网站已保存，但首次读取失败：${e.message || e}`); }
      await save();
      await ensureIconData(tmp, false);
    } catch (e) { toast(`添加失败：${e.message || e}`); }
    busy = false; paint();
  }

  async function refresh(notify = true) {
    const site = active(); if (!site || busy) return; busy = true; paint();
    try { await readNotices(site); lastErrors.delete(site.id); if (notify && !loginRuntime.has(site.id)) toast(`已读取 ${notices.length} 条公告`); }
    catch (e) { lastErrors.set(site.id, e.message || String(e)); toast(`读取失败：${e.message || e}`); }
    finally { busy = false; paint(); }
  }
  async function switchSite(id) { activeId = id; editing = false; resetChunk(); notices = await tide.storage.get(`notices:${id}`, []); if (!Array.isArray(notices)) notices = []; await loadHidden(id); paint(); }
  async function toReminder(n) {
    const text = `${n.title} ${n.snippet || ""} ${n.date || ""}`; const p = tide.util.parseWhen(text);
    const task = tide.tasks.create({ title: n.title, quad: tide.util.guessQuad(p.date || n.date), estMin: p.endMin ? p.endMin - p.startMin : 30, due: p.date || n.date || null, tags: ["学校通知"], note: n.url });
    if (p.date && p.startMin !== null) tide.blocks.create({ date: p.date, start: tide.util.hhmmOf(p.startMin), durMin: p.endMin ? p.endMin - p.startMin : 60, title: n.title, taskId: task.id, cat: "study" });
    toast(p.date || n.date ? "已将公告加入提醒" : "已加入任务池；未识别到明确日期");
  }

  // 展开正文：抓详情页 → 抽正文 → 只留内存。抓过一次就复用，反复展开不再请求。
  // 展开/收起**不走 paint()**：paint 会整体重建列表 DOM，新插入的条目直接带着
  // .open 终态出现，CSS 过渡（0fr → 1fr）根本不会播放，观感就是「闪一下」。
  // 这里只就地切换 .open 类，让既有元素自己的过渡真正跑起来；正文抓取也只
  // 就地填充详情容器，不重绘列表（favicon 不重载、滚动位置不动）。
  function detailHTML(n) {
    const text = bodyLoading.has(n.url) ? "正在读取正文…" : (bodies.get(n.url) || "未识别到正文，可点「打开原文」查看原网页");
    return `<div class="sn-article">${esc(text).replace(/\n/g, "<br>")}</div><div class="sn-item-acts"><button data-open-notice>打开原文</button><button data-remind>转为提醒</button><button data-dismiss>删除条目</button></div>`;
  }
  function setItemOpen(itemEl, n, open) {
    if (!itemEl) return;
    itemEl.classList.toggle("open", open);
    itemEl.querySelectorAll("[data-toggle-body]").forEach((b) => {
      b.setAttribute("aria-expanded", open ? "true" : "false");
      if (b.classList.contains("sn-heading")) b.setAttribute("aria-label", `${n.title}，${open ? "收起正文" : "展开正文"}`);
      else { const span = b.querySelector("span"); if (span) span.textContent = open ? "收起正文" : "展开正文"; }
    });
    const shell = itemEl.querySelector(".sn-detail-shell");
    if (shell) shell.setAttribute("aria-hidden", open ? "false" : "true");
  }
  function setItemDetail(itemEl, n) {
    const d = itemEl?.querySelector(".sn-detail");
    if (d) d.innerHTML = detailHTML(n);
  }
  async function toggleBody(site, n, itemEl) {
    const open = !expanded.has(n.url);
    if (open) expanded.add(n.url); else expanded.delete(n.url);
    setItemOpen(itemEl, n, open);
    // 收起，或正文已在缓存/读取中：状态就位即可（缓存命中时顺手填一次正文，兜底）。
    if (!open || bodies.has(n.url) || bodyLoading.has(n.url)) {
      if (open) setItemDetail(itemEl, n);
      return;
    }
    bodyLoading.add(n.url);
    setItemDetail(itemEl, n);   // 就地显示「正在读取正文…」
    try {
      const res = await fetchPage(site, n.url);
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const art = tide.util.web.extractArticleText(res.body, res.finalUrl || n.url);
      bodies.set(n.url, (art.text || "").trim() || "未识别到正文，可点「打开原文」查看原网页");
    } catch (e) {
      bodies.set(n.url, `读取正文失败：${e.message || e}`);
    } finally { bodyLoading.delete(n.url); }
    // 抓取期间列表可能已被整体重绘（刷新 / 切站点 / 搜索），旧元素失效就别硬塞。
    if (itemEl?.isConnected) setItemDetail(itemEl, n);
  }

  // 删除通知：记进「已隐藏」而不是删缓存 —— 否则下次刷新又从站点抓回来。
  async function dismissNotice(site, n) {
    hiddenUrls = [...hiddenUrls.filter((u) => u !== n.url), n.url];
    expanded.delete(n.url); bodies.delete(n.url);
    notices = notices.filter((x) => x.url !== n.url);
    await tide.storage.set(`hidden:${site.id}`, hiddenUrls);
    await publishCachedNotices();
    paint();
  }

  // 保存编辑：名称随时可改；网址改动 = 换了一个站点，
  // 旧缓存（公告列表 / 正文 / 已删除记录）都按旧网址算，必须一并作废再重抓。
  async function saveSite(site) {
    const name = host.querySelector("[data-edit-name]")?.value.trim() || "";
    const raw = host.querySelector("[data-edit-url]")?.value || "";
    if (!raw.trim()) { toast("网址不能为空；不想用这个站点可直接点「删除」"); return; }
    const url = tide.util.web.normalizeUrl(raw);
    const urlChanged = url !== site.url;
    if (name) site.name = name;
    site.url = url;
    if (urlChanged) {
      site.cms = "自动识别"; site.lastFetchedAt = 0; site.iconUrl = ""; site.spaHint = "";
      notices = []; expanded.clear(); bodies.clear(); pagers.delete(site.id);
      await tide.storage.set(`notices:${site.id}`, []);
      await publishCachedNotices();
    }
    editing = false;
    await save();
    paint();
    if (urlChanged) setTimeout(() => refresh(false), 0);
    else toast("站点配置已保存");
  }

  // 删除站点：卡片「删除」与标签右键菜单共用。旧缓存（公告 / 正文 / 已删除记录）
  // 与内存态（会话 / 登录 / 错误 / 已填凭据）都按站点算，一并清掉。
  async function removeSite(site) {
    editing = false; tabMenu = null; sitePanel = false;
    sessions.delete(site.id); loginRuntime.delete(site.id); loginErrors.delete(site.id);
    loginDraft.delete(site.id); lastErrors.delete(site.id); hiddenUrls = []; pagers.delete(site.id);
    sites = sites.filter((x) => x.id !== site.id);
    activeId = sites[0]?.id || "";
    notices = activeId ? await tide.storage.get(`notices:${activeId}`, []) : [];
    await loadHidden(activeId); await save(); await publishCachedNotices(); paint();
  }

  // 右键标签页：先把该站点切成当前站点 —— 菜单动作与卡片按钮共用同一套实现，
  // 它们都作用于 active()，不切的话右键「通知公告」会去刷新「北航信息门户」。
  async function openTabMenu(id, x, y) {
    if (id !== activeId) await switchSite(id);
    // 菜单 position:fixed + 视口坐标，贴边时往回收，别被窗口裁掉。
    // ⚠️ 视口坐标是从屏幕角上量的，而安全区那四条边（状态栏 / 导航栏 / 横屏挖孔）落在
    // 屏幕边上：fixed 的包含块是宿主 .view 的 padding box，.view 垫掉的安全区拦不住 fixed
    // 后代，所以这里必须自己让开。取值走宿主注入的 --sat/--sab/--sal/--sar（读法同宿主的
    // bottomInsetPx()），拿不到时 parseFloat 出 NaN → 0，桌面端行为不变。
    const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
    const [sat, sab, sal, sar] = [px("--sat"), px("--sab"), px("--sal"), px("--sar")];
    const W = 190, H = 270;
    tabMenu = {
      id,
      x: Math.max(8 + sal, Math.min(x, (window.innerWidth || 1024) - sar - W)),
      y: Math.max(8 + sat, Math.min(y, (window.innerHeight || 768) - sab - H)),
    };
    paint();
  }
  function closeTabMenu() { if (!tabMenu) return; tabMenu = null; paint(); }

  async function runTabAction(act) {
    const site = active(); tabMenu = null;
    if (!site) return paint();
    if (act === "refresh") return refresh();
    // 编辑框和登录框都长在站点卡片里：从右键菜单触发时卡片可能正收起着，先展开再动作。
    if (act === "edit") { editing = true; sitePanel = true; return paint(); }
    if (act === "login") { sitePanel = true; return openLoginConfig(site); }
    if (act === "open") { paint(); return tide.util.openUrl(site.url); }
    if (act === "remove") return removeSite(site);
    paint();
  }

  function loginHtml(site) {
    const rt = loginRuntime.get(site.id), err = loginErrors.get(site.id);
    if (!rt && !err) return "";
    // 没识别出表单就没有可填的字段：把失败原因常驻在卡片上，
    // 否则用户只看到「点了没反应」（toast 一闪而过，权限异常时连 toast 都没有）。
    if (!rt) return `<div class="sn-login"><div class="sn-warn">登录页读取失败：${esc(err)}</div><div class="sn-note">可先在上面填好「登录网址」再点一次「登录配置」。若学校统一认证使用 JS 加密 / 扫码 / 短信验证码 / 第三方 OAuth，需要在插件里为该站点单独适配。</div></div>`;
    const f = rt.form || {};
    const d = loginDraft.get(site.id) || {};
    const errLine = err ? `<div class="sn-warn">上一次操作失败：${esc(err)}</div>` : "";
    return `<div class="sn-login" data-login-box>${errLine}<div class="sn-note">${esc(rt.message || "需要登录")}</div><div class="sn-login-grid">${f.usernameField ? `<label><span>账号 · ${esc(f.usernameField)}</span><input class="sn-in" data-user autocomplete="username" value="${esc(d.username || "")}"></label>` : ""}${f.passwordField ? `<label><span>密码 · ${esc(f.passwordField)}</span><input class="sn-in" data-pass type="password" autocomplete="current-password" value="${esc(d.password || "")}"></label>` : ""}${f.captchaField ? `<label><span>验证码 · ${esc(f.captchaField)}</span><input class="sn-in" data-captcha autocomplete="off" value="${esc(d.captcha || "")}"></label><div class="sn-captcha">${rt.captchaData ? `<img src="${rt.captchaData}" alt="验证码">` : "验证码图片未自动读取"}<button class="sn-btn" data-reload-login ${loginBusy ? "disabled" : ""}>${loginBusy ? "读取中…" : "刷新验证码"}</button></div>` : ""}</div><div class="sn-actions" style="margin-top:10px"><button class="sn-btn pri" data-submit-login ${loginBusy ? "disabled" : ""}>${loginBusy ? "登录中…" : "登录并读取通知"}</button></div><div class="sn-warn">登录网址可在上方网站配置中修改。验证码不会被绕过或自动识别，需要你按页面图片手动输入。密码仅用于当前运行会话，不保存到本地。若学校统一认证使用动态 JS 加密、扫码、短信或第三方 OAuth，需要为该学校再写专用适配器。</div></div>`;
  }

  // 站点标签页右键菜单。菜单项刻意与卡片按钮同名同序（刷新/登录配置/编辑/打开/删除），
  // 用户不用记两套；`data-tab-act` 与卡片上的 `data-*` 标记不同名，
  // 免得事件委托里先命中卡片分支把点击抢走。
  function tabMenuHtml() {
    const target = sites.find((x) => x.id === tabMenu.id); if (!target) return "";
    const item = (act, label, extra = "") => `<button role="menuitem" data-tab-act="${act}"${extra}>${label}</button>`;
    return `<div class="sn-tabmenu" data-tab-menu role="menu" aria-label="站点操作" style="left:${tabMenu.x}px;top:${tabMenu.y}px">`
      + `<span class="sn-tabmenu-title">${esc(target.name)}</span>`
      + item("refresh", "刷新通知", busy ? " disabled" : "")
      + item("login", loginBusy ? "读取中…" : "登录配置", loginBusy ? " disabled" : "")
      + item("edit", "编辑")
      + item("open", "打开网站")
      + `<span class="sep"></span>`
      + item("remove", "删除站点", ` class="danger"`)
      + `</div>`;
  }

  function paint() {
    if (!host?.isConnected) return; const site = active(), rows = filtered(), total = matched().length, shown = rows.slice(0, rendered);
    host.innerHTML = `<div class="sn"><div class="sn-card"><div class="sn-add"><input class="sn-in" data-new-name placeholder="学校名称（可留空自动识别）"><input class="sn-in" data-new-url placeholder="学校通知/公告网站网址"><button class="sn-btn pri" data-add ${busy ? "disabled" : ""}>${busy ? "处理中…" : "添加并自动适配"}</button></div><div class="sn-note">支持常见高校 VSB / VisualSiteBuilder、WordPress、Drupal、DedeCMS、Nuxt / Next / Vue 空壳页、内嵌 JSON 状态和通用公告/消息列表接口。登录页面会尝试识别账号、密码、隐藏字段和验证码。</div>${sites.length ? `<div class="sn-sites"><span class="sn-sites-label">站点</span><div class="sn-chips">${sites.map((x) => chipHtml(x, site)).join("")}</div></div>` : ""}</div>${tabMenu ? tabMenuHtml() : ""}${site ? `${sitePanel ? `<section class="sn-card sn-site"><div class="sn-head"><div><h2>${favHtml(site, " big")}<span class="sn-name">${esc(site.name)}</span></h2><div class="sn-meta">${esc(site.url)}<br>适配模式：${esc(site.cms || "自动识别")}</div><input class="sn-in sn-login-url" data-site-login-url value="${esc(site.loginUrl || "")}" placeholder="登录网址（可选；与公告网址不同时填写）">${site.lastFetchedAt ? `<span class="sn-ok">已缓存 · ${new Date(site.lastFetchedAt).toLocaleString()}</span>` : ""}</div><div class="sn-actions"><button class="sn-btn pri" data-refresh ${busy ? "disabled" : ""}>刷新通知</button><button class="sn-btn" data-edit-site>编辑</button><button class="sn-btn" data-login ${loginBusy ? "disabled" : ""}>${loginBusy ? "读取中…" : "登录配置"}</button><button class="sn-btn" data-open-site>打开网站</button><button class="sn-btn" data-remove-site>删除</button></div></div>${editing ? `<div class="sn-add" data-edit-box style="margin-top:12px"><input class="sn-in" data-edit-name value="${esc(site.name)}" placeholder="网站名称"><input class="sn-in" data-edit-url value="${esc(site.url)}" placeholder="通知/公告网站网址"><div style="display:flex;gap:7px"><button class="sn-btn pri" data-save-site ${busy ? "disabled" : ""}>保存</button><button class="sn-btn" data-cancel-edit>取消</button></div></div><div class="sn-note">改名称只影响显示；改网址会作废旧缓存并自动重新读取公告。</div>` : ""}${loginHtml(site)}</section>` : ""}<div class="sn-toolbar"><span class="sn-searchbox"><span class="sn-search-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span><input class="sn-in" data-search value="${esc(query)}" aria-label="搜索通知" title="搜索通知" placeholder=""></span><details class="plugin-filter-menu"><summary>筛选${onlyNotice ? " · 已设置" : ""}</summary><div class="plugin-filter-menu-panel"><button class="sn-btn ${onlyNotice ? "" : "pri"}" data-filter-only="false" type="button">全部条目</button><button class="sn-btn ${onlyNotice ? "pri" : ""}" data-filter-only="true" type="button">仅通知/公告</button></div></details><span class="sn-meta sn-count">${rows.length} / ${total} 条${hiddenUrls.length ? ` · 已删除 ${hiddenUrls.length}` : ""}</span>${pagerHtml(site)}${hiddenUrls.length ? `<button class="sn-btn" data-restore>恢复已删除</button>` : ""}</div><div class="sn-list"${iconStyleAttr(site)}>${shown.map((n, i) => { const kindCode = kindOf(n); const isOpen = expanded.has(n.url); let timeText = n.date || ""; let snip = n.snippet || ""; let cat = ""; if (snip && timeText && snip.includes(timeText)) { const mTime = snip.match(/(\d{1,2}:\d{2})/); const rest = snip.split(timeText).join("").replace(/[，,、·|/\s]+/g, "").replace(/\d{1,2}:\d{2}/, ""); if (mTime && rest.length <= 5) { if (!timeText.includes(mTime[1])) timeText = `${timeText} ${mTime[1]}`; cat = rest.trim(); snip = ""; } } const tagText = kindCode === "notice" ? "通知" : kindCode === "news" ? "新闻资讯" : (cat.slice(0, 12) || ""); return `<article class="sn-item${isOpen ? " open" : ""}" data-notice="${i}"><button class="sn-heading" data-toggle-body aria-expanded="${isOpen}" aria-label="${esc(n.title)}，${isOpen ? "收起正文" : "展开正文"}"><span class="sn-title">${favHtml(site, "", false)}<span>${esc(n.title)}</span></span></button><div class="sn-meta-row">${tagText ? `<span class="sn-tag">${esc(tagText)}</span>` : ""}<span>${esc(timeText)}</span></div>${snip ? `<div class="sn-snip">${esc(snip)}</div>` : ""}<button class="sn-btn sn-expand" data-toggle-body aria-expanded="${isOpen}"><span>${isOpen ? "收起正文" : "展开正文"}</span></button><div class="sn-detail-shell" aria-hidden="${!isOpen}"><div class="sn-detail-clip"><div class="sn-detail">${isOpen ? `<div class="sn-article">${(bodyLoading.has(n.url) ? "正在读取正文…" : esc(bodies.get(n.url) || "未识别到正文，可点「打开原文」查看原网页")).replace(/\n/g, "<br>")}</div>` : ""}<div class="sn-item-acts"><button data-open-notice>打开原文</button><button data-remind>转为提醒</button><button data-dismiss>删除条目</button></div></div></div></div></article>`; }).join("") || `<div class="sn-empty">${loginRuntime.has(site.id) ? "请先完成登录。" : busy ? "正在读取通知…" : lastErrors.has(site.id) ? `读取失败：${esc(lastErrors.get(site.id))}。请检查网络或代理后，再点一次「刷新通知」重试。` : site.spaHint ? esc(site.spaHint) : "暂无可识别通知。可尝试换成学校“通知公告”列表页，而不是门户首页。"}</div>`}${rows.length > shown.length ? `<button class="sn-btn sn-more" data-more-rows>▾ 显示更多（还有 ${rows.length - shown.length} 条）</button>` : ""}</div>` : `<div class="sn-empty">先输入学校通知网站网址。插件会自动识别公告列表；如果站点需要登录，会显示登录配置。</div>`}</div>`;
  }

  async function render(el) {
    host = el; styles(); sites = await tide.storage.get("sites", []); if (!Array.isArray(sites)) sites = []; activeId = sites[0]?.id || ""; notices = activeId ? await tide.storage.get(`notices:${activeId}`, []) : []; if (!Array.isArray(notices)) notices = []; sitePanel = false; await loadHidden(activeId); paint();
    await publishCachedNotices();
    if (activeId && notices.length) setTimeout(() => refresh(false), 0);
    // 存量站点补图标：升级前保存的站点只有远程地址，在 APK 上取不到（详见 favHtml 注释）。
    // 后台逐个补抓，不阻塞首屏；全部跑完再统一重绘一次。
    if (sites.some((x) => x.iconUrl && !x.iconData)) {
      setTimeout(async () => {
        let changed = false;
        for (const s of sites) {
          if (!s.iconUrl || s.iconData) continue;
          await ensureIconData(s, false);
          if (s.iconData) changed = true;
        }
        if (changed) paint();
      }, 0);
    }
    host.addEventListener("click", async (e) => {
      try {
        const site = active();
        if (e.target.closest("[data-add]")) return addSite();
        const chip = e.target.closest("[data-site]");
        if (chip) {
          tabMenu = null;
          const id = chip.dataset.site;
          // 卡片是整块重绘的：收起或切站点前把没保存的「登录网址」落到当前站点，别让它凭空消失。
          if (sitePanel) {
            const v = host.querySelector("[data-site-login-url]")?.value;
            if (v !== undefined) { const s = active(); s.loginUrl = v.trim(); await save(); }
          }
          // 点当前站点 = 展开/收起来回切；点别的站点 = 只切换列表，设置卡片默认收起。
          if (id !== activeId) { sitePanel = false; return switchSite(id); }
          sitePanel = !sitePanel;
          return paint();
        }
        if (!site) return;
        const menuAct = e.target.closest("[data-tab-act]"); if (menuAct) return runTabAction(menuAct.dataset.tabAct);
        if (e.target.closest("[data-refresh]")) return refresh();
        if (e.target.closest("[data-edit-site]")) { editing = true; return paint(); }
        if (e.target.closest("[data-cancel-edit]")) { editing = false; return paint(); }
        if (e.target.closest("[data-save-site]")) return saveSite(site);
        const filterChoice = e.target.closest("[data-filter-only]");
        if (filterChoice) { onlyNotice = filterChoice.dataset.filterOnly === "true"; resetChunk(); return paint(); }
        if (e.target.closest("[data-more-pages]")) return loadMorePages(site);
        // 「显示更多」只补渲染分块，不再请求站点：翻页后列表能上百条，一次全建 DOM 会卡
        if (e.target.closest("[data-more-rows]")) { rendered += CHUNK; return paint(); }
        if (e.target.closest("[data-restore]")) { hiddenUrls = []; await tide.storage.set(`hidden:${site.id}`, []); return paint(); }
        if (e.target.closest("[data-open-site]")) return tide.util.openUrl(site.url);
        if (e.target.closest("[data-remove-site]")) return removeSite(site);
        if (e.target.closest("[data-login]")) { const v = host.querySelector("[data-site-login-url]")?.value ?? host.querySelector("[data-login-url]")?.value; if (v !== undefined) site.loginUrl = v.trim(); return openLoginConfig(site); }
        if (e.target.closest("[data-reload-login]")) { const v = host.querySelector("[data-site-login-url]")?.value ?? host.querySelector("[data-login-url]")?.value; if (v !== undefined) site.loginUrl = v.trim(); return openLoginConfig(site); }
        if (e.target.closest("[data-submit-login]")) { const v = host.querySelector("[data-site-login-url]")?.value ?? host.querySelector("[data-login-url]")?.value; if (v !== undefined) site.loginUrl = v.trim(); await save(); return doSubmitLogin(site); }
        const itemEl = e.target.closest("[data-notice]"); if (itemEl) { const n = rowsAt(Number(itemEl.dataset.notice)); if (!n) return; if (e.target.closest("[data-open-notice]")) tide.util.openUrl(n.url); else if (e.target.closest("[data-toggle-body]")) await toggleBody(site, n, itemEl); else if (e.target.closest("[data-dismiss]")) await dismissNotice(site, n); else if (e.target.closest("[data-remind]")) await toReminder(n); }
      } catch (err) { toast(err.message || String(err)); }
    });
    // 站点标签页右键 → 弹出与卡片同一组操作。只对标签 preventDefault：
    // 别处保留浏览器原生菜单（右键往输入框里粘贴网址还用得上）。
    host.addEventListener("contextmenu", (e) => {
      const tab = e.target.closest?.("[data-site]"); if (!tab) return;
      e.preventDefault();
      openTabMenu(tab.dataset.site, e.clientX, e.clientY).catch((err) => toast(err.message || String(err)));
    });
    // 右键菜单的收起：点别处 / Esc / 滚动。挂在 document 上且只绑一次 ——
    // 宿主元素每次 render 都可能重建，绑在 host 上会随重建丢失（同 shiguang-schedule 的写法）。
    if (!tabMenuDismissBound) {
      tabMenuDismissBound = true;
      document.addEventListener("pointerdown", (event) => {
        const t = event.target;
        // 点菜单自身要留给 click；点标签页由 click 分支负责收起，这里别抢着重绘一次。
        if (t instanceof Element && (t.closest("[data-tab-menu]") || t.closest("[data-site]"))) return;
        if (event.button === 2) return;   // 右键另一个标签：交给 contextmenu 重新定位
        closeTabMenu();
      }, true);
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTabMenu(); });
      document.addEventListener("scroll", () => closeTabMenu(), true);
      window.addEventListener("resize", () => closeTabMenu());
    }
    // 站点图标加载不出来（防盗链 / 老站点没存图标）时退成首字色块，不留破图。
    host.addEventListener("error", (e) => { const t = e.target; if (t?.tagName === "IMG") t.parentElement?.classList.add("no-img"); }, true);
    host.addEventListener("input", (e) => {
      if (e.target.matches("[data-search]")) { query = e.target.value; resetChunk(); paint(); const n = host.querySelector("[data-search]"); n?.focus(); n?.setSelectionRange(query.length, query.length); return; }
      // 记住登录框已填内容，供 paint() 重建 DOM 后回填（见 loginDraft 注释）。
      if (e.target.matches("[data-user],[data-pass],[data-captcha]")) {
        const s = active(); if (!s) return;
        const d = loginDraft.get(s.id) || { username: "", password: "", captcha: "" };
        if (e.target.matches("[data-user]")) d.username = e.target.value;
        else if (e.target.matches("[data-pass]")) d.password = e.target.value;
        else d.captcha = e.target.value;
        loginDraft.set(s.id, d);
      }
    });
    return () => { if (host === el) host = null; };
  }
  function rowsAt(i) { return filtered()[i]; }
  tide.ui.registerView({ id: "school-notice", title: "学校通知网站", icon: "school", render });
})();
