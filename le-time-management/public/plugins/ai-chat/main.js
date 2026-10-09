// AI 对话插件 —— 问一句，它把本机的任务、时间块和其他插件推来的消息读成快照交给模型，
// 答完还能把整理结果勾回来落库。
//
// 为什么做成插件而不是核心视图：AI 能力完全依赖「设置 › AI 与自动任务」里用户自己配的
// 模型与密钥，没配就是一块死界面；插件可以被整体关掉，核心视图不该有这种空转状态。
//
// 为什么写回必须经过勾选：模型会一本正经地编出不存在的作业。所有建议先停在回答下面的
// 待确认列表里，逐条勾选、点了「写入」才落库，落库后给一条带「撤销」的提示 ——
// 与截图识别（aiIngest）同一套「先预览后落库」。
//
// 三条硬约束（都不是本地能改的）：
//   · 上游非流式：一次请求拿回整段文本，所以发送后必须自己画等待态；
//   · 宿主限制：一次 ≤24 条消息、文本总量 ≤60000 字符 ⇒ 历史按轮数截断、快照按条数封顶；
//   · 安全区：本视图不建浮层、不往宿主容器外挂节点、不按视口尺寸定位（铁律四与
//     scripts/test-plugin-safe-area.mjs 会拦这三类）；吸底输入框靠 .plugview 的满高 flex 列实现。
//
// v0.175.0 加了「思考强度」：头部一颗按钮循环 自动 → 低 → 中 → 高，档位跟着请求走
// （tide.ai.chat 的 reasoningEffort → Rust 的 reasoning_effort）。做成一整颗按钮而不是
// 分段控件或下拉栏的理由写在 THINK_LEVELS 上方。
(function () {
  const VIEW_ID = "ai-chat";
  const THREAD_KEY = "thread";
  const CTX_KEY = "withContext";
  const NOTICE_KEY = "notices";
  const ID_KEY = "identity";     // 双方头像与名称
  const DRAFT_KEY = "draft";     // 没发出去的输入
  const SESSIONS_KEY = "sessions";
  const THINK_KEY = "thinkEffort"; // 思考强度（v0.175.0）
  const KEEP = 40;          // 本地留存的对话条数
  const SEND_TURNS = 10;    // 送给模型的最近条数（含本轮提问，24 条上限留足余量）
  const SNAP_CAP = 25;      // 快照每段最多列几条
  const NOTICE_KEEP = 120;  // 消息环形队列长度（与宿主抄收队列同宽）
  const NOTICE_PER_SOURCE = 6;
  const NAME_MAX = 12;      // 名称上限，再长气泡上方的标签就顶到边了
  const AVATAR_SIDE = 128;  // 头像统一压成正方形边长（圆形显示用）
  const DEFAULT_NAME = { me: "我", ai: "AI 助手" };

  /* 思考强度（v0.175.0）：四档循环，`id` 空串 = 不带 reasoning_effort 字段。
     为什么做成「一颗按钮循环」而不是分段控件 / 下拉栏：
       · 分段控件属于铁律六的「单选切换」，选中高亮要滑动到新选项，而那个滑动光块是宿主
         src/selectionGlow.js 的 attachSelectionGlow()，插件侧拿不到（插件只有 tide.*）；
       · 下拉栏属于铁律七，要自己写展开 + 收起双向动画；更要紧的是本视图的硬纪律是
         「不建浮层」（见文件头注释，test-ai-chat 与 test-plugin-safe-area 都盯着），
         弹层还得自己让开四条安全区。
     一颗按钮循环三档既能设置，又不引入浮层，也不产生「一组选项」需要滑动高亮，
     两条铁律都不触碰。当前档位直接写在按钮文字里，不必点开才知道选的是什么。 */
  const THINK_LEVELS = [
    { id: "", label: "自动", hint: "不指定思考强度，由模型自己决定（默认）" },
    { id: "low", label: "低", hint: "少想一点，回得更快、更省 token" },
    { id: "medium", label: "中", hint: "速度与深度折中" },
    { id: "high", label: "高", hint: "想得更久，适合复杂推理与长链路任务" },
  ];
  const thinkLevel = () => THINK_LEVELS.find((l) => l.id === thinkEffort) || THINK_LEVELS[0];
  const isThinkLevel = (id) => THINK_LEVELS.some((l) => l.id === id);
  // 按钮 title 里的「点击依次切换：自动 → 低 → 中 → 高」是常量。它写在 paintThink() 里
  // 会随每次重绘重新 map + join 一遍，提出来只算一次（本视图切走再回来就会重绘）。
  const THINK_CYCLE = THINK_LEVELS.map((l) => l.label).join(" → ");

  let thread = [];
  let notices = [];         // 跨插件消息（新的在前），跨重启保留
  let identity = normalizeIdentity(null);
  let loaded = false;
  let busy = false;
  let withContext = true;
  let draft = "";           // 输入到一半的话，切走再回来还在
  let seenLastAt = 0;       // 上次渲染时最后一条消息的时间，用来判断「来了新消息但人没在看底部」
  let modelLabel = "";
  let configured = false;
  let thinkEffort = "";    // 思考强度档位（"" / low / medium / high），跨重启保留
  let ui = null;          // 当前渲染出来的 DOM（切走再回来会重建）
  let sessions = [];
  let sessionId = "";
  const newSessionId = () => `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  function saveThread() {
    if (!sessionId) sessionId = newSessionId();
    const previous = sessions.find((s) => s.id === sessionId);
    if (thread.length || draft || previous) {
      const first = thread.find((m) => m.role === "user");
      const entry = { id: sessionId, title: first?.text.slice(0, 32) || "未发送的草稿", at: thread.at(-1)?.at || previous?.at || Date.now(), thread: thread.slice(), draft };
      sessions = sessions.filter((s) => s.id !== sessionId).concat(entry);
    }
    tide.storage.set(THREAD_KEY, thread);
    tide.storage.set(DRAFT_KEY, draft);
    tide.storage.set(SESSIONS_KEY, { activeId: sessionId, items: sessions });
    paintSessions();
  }

  function startSession(id = "") {
    if (busy) return;
    saveThread();
    const selected = sessions.find((s) => s.id === id);
    sessionId = selected?.id || newSessionId();
    thread = selected ? selected.thread.slice() : [];
    draft = selected?.draft || "";
    saveThread();
    if (ui) {
      ui.input.value = draft;
      ui.input.oninput();
      renderThread();
      ui.log.scrollTop = ui.log.scrollHeight;
      ui.closeSidebar();
      ui.input.focus();
    }
  }

  function paintSessions() {
    if (!ui?.sessionList) return;
    const items = sessions.slice().sort((a, b) => b.at - a.at);
    ui.sessionList.innerHTML = items.length ? items.map((s) => `<button type="button" class="aichat-session${s.id === sessionId ? " on" : ""}" data-session="${esc(s.id)}" ${busy ? "disabled" : ""} ${s.id === sessionId ? 'aria-current="true"' : ""}><span>${esc(s.title)}</span><small>${esc(new Date(s.at).toLocaleDateString("zh-CN"))} · ${s.thread.length} 条消息</small></button>`).join("") : '<p class="aichat-history-empty">还没有对话记录</p>';
    ui.sessionList.querySelectorAll("[data-session]").forEach((button) => {
      button.onclick = () => startSession(button.dataset.session);
    });
    ui.clear.disabled = busy;
  }

  const noticeKey = (m) => `${m.source}|${m.time}|${m.title}`;

  /**
   * 把宿主抄收的新消息和各插件主动发布的现有列表摘要并进本地环形队列。
   *
   * 为什么两头都要：宿主的队列只在本次运行期（重启即空），插件私有存储又能跨重启，
   * 但反过来插件自己听不到早于它加载时广播的消息 —— 合起来才是完整的一份。
   */
  async function syncNotices() {
    const fresh = (await tide.messages.list(NOTICE_KEEP)) || [];
    if (!fresh.length) return;
    const seen = new Set(notices.map(noticeKey));
    const add = fresh.filter((m) => m && m.title && !seen.has(noticeKey(m)));
    if (!add.length) return;
    notices = add.concat(notices).slice(0, NOTICE_KEEP);
    tide.storage.set(NOTICE_KEY, notices);
  }

  /* ───────────────────────── 小工具 ───────────────────────── */

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const QUAD_LABEL = { 1: "象限I", 2: "象限II", 3: "象限III", 4: "象限IV" };

  function weekday(ds) {
    const [y, m, d] = String(ds).split("-").map(Number);
    return "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  }

  const LEAD_PREFIX = /^\s*(?:结论|一句话结论|一句话|总结|要点|摘要)\s*[：:]\s*/;
  const idLabel = new Map();   // id → 标题，由 snapshot() 填，tameIds() 读

  /**
   * 正文里的内部 id 换成人话，或者抹掉。
   *
   * 真机截图上出现过「（id=b_hrc882934078e）（id=b_hrc882934078e）」—— 模型把快照行的尾巴抄了两遍。
   * 一串随机字符对用户没有信息量，所以不再"折成小字留着核对"：
   *   · 同一行已经写了标题（含这一行前面刚替进去的）→ 连括号整段丢；
   *   · 认得这条但行里没提标题 → 换成标题，括号成对时保留括号；
   *   · 对不上号（编造的、或已经删掉的）→ 丢。编造该拦的地方是建议块，那里 normalizeSuggestion 会标红。
   * 映射表由 snapshot() 顺手填；关掉「带本机数据」时表是空的，效果等于一律抹掉。
   */
  function tameIds(escapedLine) {
    const seen = new Set();
    return escapedLine
      .replace(/(?:([（([【])\s*)?(?:id\s*[=＝:：]\s*)?([tb]_[A-Za-z0-9]{3,})(?:\s*([）)\]】]))?/gi, (all, open, id, close) => {
        const label = idLabel.get(id);
        if (!label || seen.has(label) || escapedLine.includes(esc(label))) return "";
        seen.add(label);
        return open && close ? `${open}${esc(label)}${close}` : esc(label);
      })
      .replace(/[（(]\s*[)）]/g, "")
      .replace(/^\s*[-*·•]\s*$/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /**
   * 极简 markdown：先整体转义，再抹 id / 补粗体 / 行内码 / 列表 / 换行。
   *
   * 四条兜底是照着真机回答的漏法加的（v0.100.0 截图）：
   *   · 正文漏内部 id → 见 tameIds；
   *   · 模型爱用「1. 2. 3.」或「1、2、」列点，之前只会当普通段落糊成一坨；
   *   · 提示词让它用「一、二、」分块，那是要当小标题看的，不能也折成 1. 的项目符号；
   *     它偶尔仍漏出 `### 标题` 和 `[文字](网址)`，一并收掉；
   *   · 第一行按提示词是一句结论，给它一个左侧色块的锚点。
   */
  function md(text) {
    const inline = (s) => s
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = [];
    let list = null;
    let leadFree = true;
    String(text || "").split("\n").forEach((rawLine) => {
      const line = tameIds(esc(rawLine));
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      // 「1. 」「1、」「1）」「1）」都算序号；但 "1.5 小时" 不是列表 —— 点号后必须跟空格。
      const numbered = /^\s*(?:\d+\.\s+|\d+[、)）]\s*)(.+)$/.exec(line);
      if (bullet || numbered) {
        const tag = bullet ? "ul" : "ol";
        if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        leadFree = false;
        return;
      }
      if (list) { out.push(`</${list}>`); list = null; }
      // 小标题：中文序号要连「一、」一起留（那是读出来的序号），markdown 井号只取文字。
      const hash = /^\s*#{1,6}\s*(.+)$/.exec(line);
      const cjk = /^\s*([一二三四五六七八九十]+[、.])\s*(.+)$/.exec(line);
      if (hash || cjk) {
        out.push(`<p class="sec">${inline(hash ? hash[1] : cjk[1] + cjk[2])}</p>`);
        leadFree = false;
        return;
      }
      if (!line) { out.push(""); return; }
      // 只有真的很短才当结论；模型偶尔第一行就是一坨 150 字的整段，那样加粗反而更糊。
      const lead = leadFree && line.length <= 60;
      const body = leadFree ? line.replace(LEAD_PREFIX, "") : line;
      leadFree = false;
      out.push(`<p${lead ? ' class="lead"' : ""}>${inline(body)}</p>`);
    });
    if (list) out.push(`</${list}>`);
    return out.join("\n").replace(/(<p><\/p>)+/g, '<p class="gap"></p>');
  }

  function node(html) {
    const box = document.createElement("div");
    box.innerHTML = html;
    return box;
  }

  /* ───────────────────────── 头像与名称 ───────────────────────── */

  // 默认头像用内联 SVG：插件沙箱里拿不到宿主的图标字体，画在 currentColor 上还能跟着主题走。
  const ICON = {
    me: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="7.6" r="4.1"/><path d="M3.6 21c0-4.5 3.8-7.2 8.4-7.2s8.4 2.7 8.4 7.2z"/></svg>',
    ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="4.4" y="8.4" width="15.2" height="11" rx="3.2"/><circle cx="9.6" cy="13.6" r="1.5" fill="currentColor" stroke="none"/><circle cx="14.4" cy="13.6" r="1.5" fill="currentColor" stroke="none"/><path d="M12 5.4v3M9.6 19.4h4.8"/><circle cx="12" cy="3.7" r="1.5" fill="currentColor" stroke="none"/></svg>',
  };

  const displayName = (role) => identity[role].name || DEFAULT_NAME[role];

  /** 名称首字：英文取首字母大写，中文和其他文字直接取第一个字（Array.from 防代理对截半）。 */
  const initialOf = (name) => {
    const c = Array.from(String(name || "").trim())[0] || "";
    return /[a-z]/i.test(c) ? c.toUpperCase() : c;
  };

  /** 上传的图 > 没改名时的线条图标 > 名称首字。只给内容，外壳由调用方决定是 span 还是 button。 */
  function avatarInner(role) {
    const name = displayName(role);
    if (identity[role].avatar) return `<img src="${esc(identity[role].avatar)}" alt="">`;
    return name === DEFAULT_NAME[role] ? ICON[role] : esc(initialOf(name));
  }

  const avatarHtml = (role) => `<span class="aichat-avatar ${role}" aria-hidden="true">${avatarInner(role)}</span>`;

  function normalizeIdentity(raw) {
    const one = (o) => ({
      name: typeof o?.name === "string" ? o.name.trim().slice(0, NAME_MAX) : "",
      // 只收图片 dataURL：别的值（外链、半截字符串）渲染出来就是坏图或注入面。
      avatar: typeof o?.avatar === "string" && o.avatar.startsWith("data:image/") ? o.avatar : "",
    });
    const r = raw && typeof raw === "object" ? raw : {};
    return { me: one(r.me), ai: one(r.ai) };
  }

  function saveIdentity() {
    tide.storage.set(ID_KEY, identity);
    paintIdentityPanel();
    renderThread();
  }

  /** 只刷面板里两个头像预览：改名时走这条，免得把正在输入的光标抢走。 */
  function paintAvatars() {
    if (!ui) return;
    ui.idPanel.querySelectorAll("[data-pick]").forEach((b) => {
      b.innerHTML = avatarInner(b.dataset.pick);
      b.title = `${displayName(b.dataset.pick)} · 点击换头像`;
    });
  }

  function paintIdentityPanel() {
    if (!ui || !ui.idPanel) return;
    paintAvatars();
    ui.idPanel.querySelectorAll("[data-name]").forEach((i) => { i.value = identity[i.dataset.name].name; });
  }

  /** 头像文件 → 边长 128 的方形 dataURL。
      为什么一定要压：整份应用状态是一起写盘的，一张 4MB 截图 base64 后约 5.3MB，
      而浏览器调试模式下的 localStorage 配额只有 5MB —— 不压就写不进去，
      还会连带把整个 store 的保存链一起卡挂。居中裁方是因为头像按圆形显示，直接缩放会压扁。
      统一出 PNG：128 见方最坏也就 88KB 上下，换来透明底的图标不会被填成黑底，值。 */
  function readAvatar(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("图片读取失败"));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("图片格式不支持"));
        img.onload = () => {
          const cv = document.createElement("canvas");
          cv.width = AVATAR_SIDE; cv.height = AVATAR_SIDE;
          const ctx = cv.getContext("2d");
          if (!ctx) { resolve(String(fr.result || "")); return; }
          const cut = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - cut) / 2, (img.height - cut) / 2, cut, cut, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
          resolve(cv.toDataURL("image/png"));
        };
        img.src = String(fr.result || "");
      };
      fr.readAsDataURL(file);
    });
  }

  /* ───────────────────────── 本机数据快照 ───────────────────────── */

  /** 把任务与时间块压成一段文本喂给模型：只给事实，不给判断。 */
  function snapshot() {
    const today = tide.util.today();
    const plus7 = tide.util.addDays(today, 7);
    const tasks = tide.tasks.list();
    idLabel.clear();
    tasks.forEach((t) => t && t.id && idLabel.set(String(t.id), String(t.title || "")));
    const buckets = { overdue: [], today: [], soon: [], later: [], free: [] };
    tasks.filter((t) => !t.done).forEach((t) => {
      if (!t.due) buckets.free.push(t);
      else if (t.due < today) buckets.overdue.push(t);
      else if (t.due === today) buckets.today.push(t);
      else if (t.due <= plus7) buckets.soon.push(t);
      else buckets.later.push(t);
    });
    const line = (t) => {
      const bits = [`id=${t.id}`, t.title];
      if (t.due) bits.push(`截止 ${t.due}${t.dueTime ? " " + t.dueTime : ""}`);
      if (t.quad) bits.push(QUAD_LABEL[t.quad] || `象限${t.quad}`);
      if (t.estMin) bits.push(`估 ${t.estMin} 分钟`);
      if (t.note) bits.push(`备注：${String(t.note).slice(0, 40)}`);
      return `- ${bits.join(" · ")}`;
    };
    const section = (label, list, cap = SNAP_CAP) => {
      if (!list.length) return "";
      const shown = list.slice(0, cap).map(line);
      if (list.length > cap) shown.push(`- （其余 ${list.length - cap} 条略）`);
      return `【${label} 共 ${list.length} 条】\n${shown.join("\n")}`;
    };

    const parts = [`今天：${today}（周${weekday(today)}）`];
    parts.push(section("已逾期未完成", buckets.overdue.sort((a, b) => String(a.due).localeCompare(String(b.due)))));
    parts.push(section("今天到期", buckets.today));
    parts.push(section("未来 7 天到期", buckets.soon.sort((a, b) => String(a.due).localeCompare(String(b.due)))));
    parts.push(section("更远 / 无截止", buckets.later.concat(buckets.free), 15));
    const done = tasks.filter((t) => t.done);
    if (done.length) {
      parts.push(`【已完成 ${done.length} 条，最近 ${Math.min(12, done.length)} 条】\n`
        + done.slice(-12).reverse().map((t) => `- id=${t.id} ${t.title}`).join("\n"));
    }

    // 时间块：今天与后两天（模型要排期就得知道哪些格子已被占）
    const blockLines = [];
    for (let i = 0; i < 3; i += 1) {
      const ds = tide.util.addDays(today, i);
      const bs = tide.blocks.list(ds).sort((a, b) => a.start.localeCompare(b.start));
      if (!bs.length) continue;
      const tag = i === 0 ? "今天" : i === 1 ? "明天" : "后天";
      blockLines.push(`【${tag} ${ds}（周${weekday(ds)}）】`);
      bs.slice(0, 20).forEach((b) => {
        if (b.id) idLabel.set(String(b.id), String(b.title || ""));
        const bits = [`- ${b.start} 起 ${b.durMin} 分钟 ${b.title}`];
        if (b.cat) bits.push(b.cat);
        if (b.taskId) bits.push(`关联 id=${b.taskId}`);
        blockLines.push(bits.join(" · "));
      });
    }
    parts.push(blockLines.join("\n") || "【今天起 3 天没有时间块】");
    parts.push(noticeBlock());

    const text = parts.filter(Boolean).join("\n\n");
    // 60000 字符是整次请求的上限，快照单独卡一道，给对话历史留位置。
    return text.length > 9000 ? `${text.slice(0, 9000)}\n…（数据较多，快照已截断）` : text;
  }

  /** 其他插件推来的消息，按来源分组。没收到过就整段不出现，不给模型留一句空话。 */
  function noticeBlock() {
    if (!notices.length) return "";
    const bySource = new Map();
    notices.forEach((m) => {
      const key = m.sourceName || m.source;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(m);
    });
    const blocks = [...bySource.entries()].map(([name, list]) => {
      const shown = list.slice(0, NOTICE_PER_SOURCE).map((m) => {
        const bits = [m.title];
        if (m.time) bits.push(m.time);
        if (m.sender) bits.push(m.sender);
        return `  - ${bits.join(" · ")}`;
      });
      if (list.length > NOTICE_PER_SOURCE) shown.push(`  - （其余 ${list.length - NOTICE_PER_SOURCE} 条略）`);
      return `【${name} 共 ${list.length} 条】\n${shown.join("\n")}`;
    });
    return `【其他插件的消息（本机已收集，按来源分组）】\n${blocks.join("\n")}`;
  }

  function systemPrompt() {
    const head = [
      `你是「${displayName("ai")}」，U-Time（一款时间块 + 四象限任务管理应用）里的助手，用户就在应用内与你对话。`,
      "规则：",
      "1. 只依据下面给出的本机数据回答；数据里没有的事实直说不知道，绝不编造任务、日期或 id。",
      "2. 中文回答。",
      "3. 涉及日期一律写 YYYY-MM-DD，涉及时间写 HH:MM。",
       "4. 本机数据里可能有【其他插件的消息】一段，那是门户 / 学习通 / 学校通知 / 竞赛 / RSS / GitHub 等插件公开的消息摘要；"
       + "它们只代表「收到了或列表里存在」，不代表用户已经处理过。要据此提醒或安排时，说清是哪来的消息。",
    ].join("\n");
    const fmt = [
      "输出格式（严格遵守 —— 回答显示在手机屏幕的气泡里，宽度很窄）：",
      "① 第一行只写一句结论，不超过 40 字。界面会把这一行做成带色块的醒目摘要，"
      + "所以直接写结论本身，不要加「结论：」「总结如下：」这类前缀，也不要用它引出下文。",
      "② 之后用「一、」「二、」「三、」分块，最多 3 块；每块先一句话说明，紧跟不超过 5 条 \"- \" 短要点，"
      + "每条一行写完、不超过 25 字。不要写成整段的长句子。",
      "③ 正文里绝对不许出现内部标识：形如 t_xxx、b_xxx 的 id（写了也会被系统抹掉，白占字数），"
      + "也不许出现「id=」「字段」「快照」「关联」「分类码」这些系统词，不要写 rest / work / study 这类内部取值 —— "
      + "要指代某条任务或时间块，直接写它的标题，分类说「学习」「休息」这样的中文。",
      "④ 不复述用户的问题，不以「好的」「以下是」开头，不说「根据你提供的数据」。",
      "⑤ 问「有多少」这类数数题：小标题里的「共 N 条」是准数，可以直接报；但某一段如果写着「其余 N 条略」，"
      + "说明那部分没列出来，只能报「至少 X 条，另有 N 条未列出」，不许把没看到的算进去。"
      + "「作业」「复习」这类按字面归类的问题，要顺带说一句你是按标题字样认的。",
      "⑥ 小标题只用「一、」这种中文序号，不要用 # 号；链接直接写文字，不要写 [文字](网址)；"
      + "不要 Markdown 标题、表格、emoji、加粗和斜体。",
      "⑦ 数据不够回答时**只写一句**：查不到什么、缺的是哪一项、下一步做哪一件最省事的事。"
      + "不要为此硬凑「现状 / 建议 / 操作」三块，也不要把时间块的原样格式（几点起多少分钟什么分类）抄进正文。",
    ].join("\n");
    if (!withContext) {
      return `${head}\n\n${fmt}\n\n（用户已关闭「带本机数据」，本轮没有任何本机数据，只能回答通用问题。）`;
    }
    return `${head}\n\n${fmt}\n\n本机数据快照：\n${snapshot()}\n\n当用户要你「整理 / 安排 / 拆分 / 改期」时，除了正文说明，在回复**最后**单独输出一个 json 代码块（不要包在正文里），格式严格如下：\n`
      + '```json\n{"suggestions":[{"action":"create-task","title":"…","due":"YYYY-MM-DD","dueTime":"HH:MM","quad":2,"estMin":45,"note":"…"}]}\n```\n'
      + "action 只能取：create-task（新建任务）、create-block（新建时间块，字段 date/start/durMin/title/cat，cat 取 work|study|sport|life|rest）、update-task（改已有任务，字段 id + 要改的字段）、done-task（标记完成，字段 id）。"
      + "id 必须是上面快照里出现过的真实 id。没有要落库的东西就输出 {\"suggestions\":[]}。";
  }

  /* ───────────────────────── 建议解析与落库 ───────────────────────── */

  const ACTIONS = {
    "create-task": "新建任务",
    "create-block": "新建时间块",
    "update-task": "改任务",
    "done-task": "标记完成",
  };
  const CATS = new Set(["work", "study", "sport", "life", "rest"]);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  /** 取回复里最后一个 json 代码块当建议，其余算正文。 */
  function parseReply(text) {
    const raw = String(text || "");
    const blocks = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      let parsed = null;
      try { parsed = JSON.parse(blocks[i][1]); } catch { continue; }
      const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions
        : Array.isArray(parsed) ? parsed : null;
      if (!list) continue;
      const cut = blocks[i].index;
      return {
        body: raw.slice(0, cut).trimEnd(),
        suggestions: list.map(normalizeSuggestion).filter(Boolean),
      };
    }
    return { body: raw.trim(), suggestions: [] };
  }

  function normalizeSuggestion(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const action = ACTIONS[s.action] ? s.action : "";
    if (!action) return null;
    const out = { action, checked: true, applied: false };
    const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
    const int = (v, lo, hi) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
    };
    // 只有模型真给了值的字段才进 out：update-task 靠「字段在不在」判断要改什么，
    // 塞一个空串进去会把任务标题清空。
    const title = str(s.title, 120); if (title) out.title = title;
    if (s.note) out.note = str(s.note, 200);
    if (s.id) out.id = str(s.id, 40);
    if (DATE_RE.test(String(s.due || ""))) out.due = s.due;
    if (DATE_RE.test(String(s.date || ""))) out.date = s.date;
    if (TIME_RE.test(String(s.dueTime || ""))) out.dueTime = s.dueTime;
    if (TIME_RE.test(String(s.start || ""))) out.start = s.start;
    if (s.cat && CATS.has(s.cat)) out.cat = s.cat;
    const dur = int(s.durMin, 5, 1440); if (dur) out.durMin = dur;
    const est = int(s.estMin, 5, 1440); if (est) out.estMin = est;
    const quad = int(s.quad, 1, 4); if (quad) out.quad = quad;

    // 落地前就能判掉的非法项直接标出来，不等用户点了才发现写不进去。
    if (action === "create-task" && !out.title) out.reason = "缺任务标题";
    if (action === "create-block" && (!out.title || !out.date || !out.start)) out.reason = "缺日期、开始时间或标题";
    if ((action === "update-task" || action === "done-task")) {
      if (!out.id) out.reason = "没说改哪条任务";
      else if (!tide.tasks.list().some((t) => t.id === out.id)) out.reason = "本机任务里找不到这一条";
    }
    return out;
  }

  /** 建议行上要说的是「哪条任务」，不是那串随机 id。
      tide.tasks.list() 每次调用都把整张任务表深拷一遍，所以按「一轮渲染取一次」缓存；
      renderThread() 开头作废它，用户中途改了标题下一轮也能跟上。
      快照里填的 idLabel 作二级兜底：任务在回答之后被删掉时，至少还认得它当时的名字。 */
  let taskIndex = null;
  function taskTitleOf(id) {
    if (!id) return "";
    const key = String(id);
    if (!taskIndex) {
      taskIndex = new Map();
      (tide.tasks.list() || []).forEach((t) => { if (t && t.id) taskIndex.set(String(t.id), String(t.title || "")); });
    }
    return taskIndex.get(key) || idLabel.get(key) || "";
  }

  const targetName = (id) => taskTitleOf(id) || "未指明任务";

  function describe(s) {
    const head = ACTIONS[s.action];
    // update-task 的 s.title 是「要改成的新标题」，被改的那条叫什么得回查任务表。
    if (s.action === "done-task") return `${head}：${s.title || targetName(s.id)}`;
    if (s.action === "update-task") {
      const to = [s.due ? `改到 ${s.due}${s.dueTime ? " " + s.dueTime : ""}` : "", s.title ? `标题「${s.title}」` : "", s.quad ? QUAD_LABEL[s.quad] : ""]
        .filter(Boolean).join("、") || "（模型没给出要改的字段）";
      return `${head}「${targetName(s.id)}」：${to}`;
    }
    if (s.action === "create-block") return `${head} · ${s.title} · ${s.date} ${s.start}${s.durMin ? ` 起 ${s.durMin} 分钟` : ""}`;
    return `${head} · ${s.title} · ${s.due ? `${s.due}${s.dueTime ? " " + s.dueTime : ""}` : "无截止"}`;
  }

  /** 只把模型真给了值的字段传下去，缺的交给 store 默认值（别把 dueTime 写成空串）。 */
  function taskPatch(s) {
    return {
      title: s.title,
      ...(s.note ? { note: s.note } : {}),
      ...(s.due ? { due: s.due } : {}),
      ...(s.dueTime ? { dueTime: s.dueTime } : {}),
      ...(s.quad ? { quad: s.quad } : {}),
      ...(s.estMin ? { estMin: s.estMin } : {}),
    };
  }

  /** 勾选的建议落库；返回一条可撤销的记录。 */
  function applySuggestions(list) {
    const record = { tasks: [], blocks: [], updates: [] };
    const errors = [];
    list.forEach((s) => {
      try {
        if (s.action === "create-task") {
          const t = tide.tasks.create(taskPatch(s));
          record.tasks.push(t.id);
        } else if (s.action === "create-block") {
          const r = tide.blocks.createSmart({
            title: s.title, date: s.date, start: s.start, durMin: s.durMin || 60, cat: s.cat || "work",
          });
          record.blocks.push(r.block.id);
          if (r.moved) s.movedTo = r.block.start;
        } else {
          const before = tide.tasks.list().find((t) => t.id === s.id);
          if (!before) throw new Error("本机任务里找不到这一条");
          const patch = s.action === "done-task" ? { done: true }
            : ["title", "note", "due", "dueTime", "quad", "estMin"].reduce((acc, k) => {
              if (s[k] !== undefined) acc[k] = s[k];
              return acc;
            }, {});
          if (!Object.keys(patch).length) throw new Error("模型没给出要改的字段");
          const restore = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]]));
          tide.tasks.update(s.id, patch);
          record.updates.push({ id: s.id, before: restore });
        }
        s.applied = true;
      } catch (e) {
        // 有 id 的就是在改已有任务，报错要报那条任务叫什么；新建类的才用模型给的标题。
        errors.push(`${s.id ? targetName(s.id) : (s.title || ACTIONS[s.action])}：${e.message || e}`);
        s.reason = String(e.message || e).slice(0, 60);
      }
    });
    return { record, errors };
  }

  /** 撤销一次写入：新建的删掉，改过的还原成落库前那份字段值。 */
  function undoRecord(rec) {
    if (!rec) return;
    rec.tasks.forEach((id) => { try { tide.tasks.remove(id); } catch { /* 已被用户删掉 */ } });
    rec.blocks.forEach((id) => { try { tide.blocks.remove(id); } catch { /* 同上 */ } });
    rec.updates.forEach((u) => { try { tide.tasks.update(u.id, u.before); } catch { /* 同上 */ } });
    tide.notify("已撤销这次写入");
    refresh();
  }

  /* ───────────────────────── 发送 ───────────────────────── */

  function buildMessages() {
    const history = thread
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-SEND_TURNS)
      .map((m) => ({ role: m.role, content: m.text }));
    return [{ role: "system", content: systemPrompt() }].concat(history);
  }

  async function ask(question) {
    const q = String(question || "").trim();
    if (!q || busy) return;
    busy = true;
    thread.push({ role: "user", text: q, at: Date.now() });
    renderThread();
    paintBusy();
    try {
      await syncNotices();          // 发送前再并一次，刚推来的消息这一轮就能被问到
      // reasoningEffort 为 ""（自动档）时，宿主与 Rust 都不往请求体里塞 reasoning_effort 字段。
      const reply = await tide.ai.chat(buildMessages(), { temperature: 0.3, reasoningEffort: thinkEffort });
      const parsed = parseReply(reply);
      thread.push({ role: "assistant", text: parsed.body, at: Date.now(), suggestions: parsed.suggestions });
    } catch (e) {
      thread.push({ role: "error", text: String((e && e.message) || e), at: Date.now() });
    } finally {
      busy = false;
      paintBusy();
    }
    thread = thread.slice(-KEEP);
    saveThread();
    renderThread();
  }

  /* ───────────────────────── 界面 ───────────────────────── */

  const CHIPS = [
    { label: "今天做什么", ask: "今天该做什么？按优先级一条条列出来，每条说清从哪一步开始。" },
    { label: "本周盘点", ask: "盘点一下现在这些任务：还欠着多少、哪些已经拖了很久、接下来最该先动哪个。" },
    { label: "拆掉拖延的", ask: "挑出明显被拖了很久的任务，各给一个不超过 30 分钟就能起步的下一步。" },
    { label: "处理逾期", ask: "逐条给出逾期任务的处理建议：改到哪一天、还是直接关掉，并说明理由。" },
    { label: "最近的通知", ask: "把最近收到的插件消息按「要办事 / 要知道 / 可忽略」分三类，各条说清是哪个来源推来的。" },
  ];
  // 关掉「带本机数据」时上面那组全在问本机的事，点了只能得到一句「查不到」，所以换一组不依赖本机数据的。
  const CHIPS_BLANK = [
    { label: "四象限怎么用", ask: "四象限法该怎么给任务定优先级？哪些事真正属于「重要但不紧急」那一格。" },
    { label: "拖着不想开始", ask: "一件事迟迟不想动手，一般是什么原因？给几个立刻能用的起步办法。" },
    { label: "番茄工作法", ask: "番茄工作法的专注时长和休息该怎么定？常见的误用有哪些。" },
    { label: "拆模糊目标", ask: "把「学好英语」这类模糊目标拆成能执行的任务，通常怎么拆？举个具体例子。" },
    { label: "一天怎么排", ask: "一天里哪些时段更适合做费脑子的安排？按普遍的精力规律给个排法。" },
  ];
  const activeChips = () => (withContext ? CHIPS : CHIPS_BLANK);

  function ensureStyle() {
    if (document.getElementById("ai-chat-style")) return;
    const st = document.createElement("style");
    st.id = "ai-chat-style";
    st.textContent = `
.aichat{height:100%;max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:10px;color:var(--ink,#22303A)}
.aichat-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aichat-eyebrow{font-size:calc(11px * var(--ui-text-scale));letter-spacing:.3em;color:var(--ink-3,#A9B2BA);flex:1;min-width:120px}
.aichat-model{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);border:1px solid var(--line,#E4DFD6);border-radius:999px;padding:3px 10px;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aichat-chip{font-size:calc(11.5px * var(--ui-text-scale));border:1px solid var(--line,#E4DFD6);background:var(--panel,#fff);color:var(--ink-2,#7E8B94);border-radius:999px;padding:4px 11px;cursor:pointer;flex:none}
.aichat-chip.on{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff);font-weight:600}
/* 思考强度按钮（v0.175.0）自己的钩子。别让它复挂 .aichat-think —— 那个类是「正在思考…」
   三个跳动圆点（见下方 .aichat-think i 的 animation），复用后按钮里将来塞个 <i> 就会冒点。 */
.aichat-effort{display:inline-flex;gap:5px;align-items:center}
.aichat-log{flex:1;min-height:120px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:2px 0}
.aichat-jump{align-self:center;flex:none;height:26px;padding:0 12px;border-radius:999px;border:1px solid var(--line,#E4DFD6);background:var(--panel,#fff);color:var(--ink-2,#7E8B94);font-family:inherit;font-size:calc(11px * var(--ui-text-scale));cursor:pointer}
.aichat-jump:hover{border-color:var(--deep,#0F4C5C);color:var(--deep,#0F4C5C)}
.aichat-feed{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);flex:none}
.aichat-empty{border:1px dashed var(--line,#E4DFD6);border-radius:14px;padding:18px;background:var(--panel,#fff)}
.aichat-empty b{display:block;font-size:calc(13.5px * var(--ui-text-scale));margin-bottom:6px}
.aichat-empty p{margin:0 0 10px;font-size:calc(12px * var(--ui-text-scale));line-height:1.7;color:var(--ink-2,#7E8B94)}
.aichat-row{display:flex;align-items:flex-start;gap:8px}
.aichat-row.ai{align-self:stretch}
.aichat-row.me{align-self:flex-end;flex-direction:row-reverse;max-width:82%}
.aichat-body{min-width:0;flex:1}
/* 用户侧不撑满、按内容收，但要允许被行宽压回来：flex:none 会让长句按 max-content 溢出到容器外。 */
.aichat-row.me .aichat-body{flex:0 1 auto}
.aichat-avatar{width:28px;height:28px;flex:none;border:0;border-radius:50%;overflow:hidden;display:grid;place-items:center;font-family:inherit;font-size:calc(12.5px * var(--ui-text-scale));font-weight:700;line-height:1}
.aichat-avatar.ai{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);color:var(--deep,#0F4C5C)}
.aichat-avatar.me{background:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
.aichat-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.aichat-avatar svg{width:16px;height:16px}
.aichat-who{margin:0 0 3px;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aichat-row.me .aichat-who{text-align:right}
.aichat-msg{border-radius:14px;padding:10px 13px;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.75}
.aichat-msg.me{background:var(--deep,#0F4C5C);color:var(--on-deep,#fff);border-bottom-right-radius:5px}
[data-theme-mode="dark"] .aichat-msg.me,[data-theme-mode="dark"] .aichat-avatar.me{background:color-mix(in srgb,var(--deep,#0F4C5C) 38%,#151b1c);color:#f6f8f8}
.aichat-msg.ai{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-bottom-left-radius:5px}
.aichat-msg.err{align-self:stretch;background:color-mix(in srgb,var(--danger,#B03535) 7%,var(--panel,#fff));border:1px solid color-mix(in srgb,var(--danger,#B03535) 34%,var(--line,#E4DFD6));color:var(--danger,#B03535)}
.aichat-msg p{margin:0 0 6px}.aichat-msg p:last-child{margin-bottom:0}
.aichat-msg .lead{margin:0 0 9px;font-weight:700;color:var(--ink,#22303A);line-height:1.6}
.aichat-msg .lead::before{content:"";float:left;width:3px;height:1.15em;margin:1px 8px 0 0;border-radius:2px;background:var(--deep,#0F4C5C)}
.aichat-msg .gap{height:6px}
.aichat-msg ul,.aichat-msg ol{margin:0 0 6px;padding-left:19px}.aichat-msg li{margin:2px 0}
.aichat-msg ol{list-style-type:decimal}
.aichat-msg .sec{margin:11px 0 4px;font-weight:800;color:var(--ink,#1F2A33);letter-spacing:.02em}
.aichat-msg .sec:first-child{margin-top:0}
.aichat-msg code{background:var(--paper,#F7F6F2);border:1px solid var(--line,#E4DFD6);border-radius:5px;padding:0 4px}
.aichat-when{margin-top:6px;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA)}
.aichat-think{display:inline-flex;gap:5px;align-items:center;color:var(--ink-2,#7E8B94)}
.aichat-think i{width:6px;height:6px;border-radius:50%;background:var(--deep,#0F4C5C);animation:aichat-dot 1s infinite ease-in-out}
.aichat-think i:nth-child(2){animation-delay:.15s}.aichat-think i:nth-child(3){animation-delay:.3s}
@keyframes aichat-dot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.aichat-sug{margin-top:10px;border-top:1px dashed var(--line,#E4DFD6);padding-top:9px}
.aichat-sug-t{font-size:calc(11px * var(--ui-text-scale));letter-spacing:.14em;color:var(--ink-3,#A9B2BA);margin-bottom:6px}
.aichat-sug-row{display:flex;align-items:flex-start;gap:8px;padding:5px 0;font-size:calc(12px * var(--ui-text-scale));line-height:1.6}
.aichat-sug-row input{margin-top:3px;flex:none;accent-color:var(--deep,#0F4C5C)}
.aichat-sug-row .no{color:var(--danger,#B03535)}
.aichat-sug-row small{display:block;color:var(--ink-3,#A9B2BA)}
.aichat-sug-act{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.aichat-btn{height:32px;padding:0 14px;border-radius:9px;border:1px solid var(--line,#E4DFD6);background:var(--panel,#fff);color:var(--ink,#22303A);font-size:calc(12px * var(--ui-text-scale));cursor:pointer;flex:none}
.aichat-btn:hover{border-color:var(--deep,#0F4C5C);color:var(--deep,#0F4C5C)}
.aichat-btn.pri{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff);font-weight:600}
.aichat-btn:disabled{opacity:.45;cursor:default}
.aichat-bar{display:flex;gap:8px;align-items:flex-end;flex:none;padding-top:2px}
.aichat-input{flex:1;min-width:0;resize:none;max-height:130px;min-height:40px;border:1px solid var(--line,#E4DFD6);border-radius:12px;padding:10px 12px;background:var(--panel,#fff);color:var(--ink,#22303A);font:inherit;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.5}
.aichat-input:focus{outline:none;border-color:var(--deep,#0F4C5C)}
.aichat-id{flex:none;border:1px solid var(--line,#E4DFD6);border-radius:14px;background:var(--panel,#fff);padding:12px 13px;display:flex;flex-direction:column;gap:10px}
.aichat-id-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.aichat-id-name{flex:1 1 150px;min-width:0;display:flex;align-items:center;gap:8px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.aichat-id-name input{flex:1;min-width:0;height:30px;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:0 10px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);font:inherit;font-size:calc(12.5px * var(--ui-text-scale))}
.aichat-id-name input:focus{outline:none;border-color:var(--deep,#0F4C5C)}
.aichat-id-tip{margin:0;font-size:calc(11px * var(--ui-text-scale));line-height:1.7;color:var(--ink-3,#A9B2BA)}
button.aichat-avatar{padding:0;cursor:pointer}
.aichat-avatar:disabled{opacity:.5;cursor:default}
/* Nephele 参考布局；色板只作用于插件，不改变宿主主题。 */
.aichat{--ink:#f6f0ff;--ink-2:#c7b6d9;--ink-3:#bba8cf;--panel:#2b243b;--paper:#352d46;--line:#665573;--deep:#bb91ce;--on-deep:#fff;position:relative;isolation:isolate;box-sizing:border-box;max-width:none;min-height:0;gap:10px;padding:26px clamp(22px,9%,100px) 58px;background:radial-gradient(ellipse at 12% 95%,#67516f66,transparent 62%),linear-gradient(120deg,#51435e,#48425c);border-radius:18px;overflow:hidden;font-family:"Microsoft YaHei UI","PingFang SC",sans-serif}
.aichat::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:.55;background-image:radial-gradient(circle at 17% 15%,#e9c9ff 0 1px,transparent 1.5px),radial-gradient(circle at 74% 33%,#e9c9ff 0 1px,transparent 1.5px),radial-gradient(circle at 85% 56%,#e9c9ff 0 1px,transparent 1.5px),radial-gradient(circle at 32% 18%,#bb80d2 0 .7px,transparent 1.2px),radial-gradient(circle at 66% 26%,#dc9bea 0 .8px,transparent 1.3px),radial-gradient(circle at 73% 90%,#e9c9ff 0 1px,transparent 1.5px);background-size:100% 100%,100% 100%,100% 100%,193px 157px,271px 211px,100% 100%}
.aichat [hidden]{display:none!important}
.aichat-head{flex:none;gap:10px;min-height:34px}
.aichat-menu{position:relative;z-index:6;width:32px;height:32px;border:0;background:transparent;color:#e0cfea;padding:0;cursor:pointer;margin-right:auto;transition:transform 500ms cubic-bezier(.22,1,.36,1)}
.aichat-menu::before{content:"";position:absolute;inset:-18px;pointer-events:none;border-radius:50%;background:radial-gradient(circle,#cfa8dd33,transparent 68%)}
.aichat-menu span{position:absolute;left:7px;top:15px;width:18px;height:2px;border-radius:2px;background:currentColor;transition:transform 500ms cubic-bezier(.22,1,.36,1),width 500ms cubic-bezier(.22,1,.36,1),left 500ms cubic-bezier(.22,1,.36,1),opacity 350ms}
.aichat-menu span:first-child{transform:translateY(-6px)}
.aichat-menu span:nth-child(2){left:4px;width:24px}
.aichat-menu span:last-child{transform:translateY(6px)}
.aichat-menu:hover,.sidebar-open .aichat-menu{color:#d9b3ea}
.sidebar-open .aichat-menu{transform:rotate(180deg)}
.sidebar-open .aichat-menu span:first-child{left:4px;width:24px;transform:rotate(45deg)}
.sidebar-open .aichat-menu span:nth-child(2){opacity:0;transform:scaleX(0)}
.sidebar-open .aichat-menu span:last-child{left:4px;width:24px;transform:rotate(-45deg)}
.aichat-backdrop{position:absolute;inset:0;z-index:4;visibility:hidden;pointer-events:none;transition:visibility 0s 220ms}
.sidebar-open .aichat-backdrop{visibility:visible;pointer-events:auto;transition-delay:0s}
.aichat-sidebar{position:absolute;z-index:5;left:clamp(22px,9%,100px);top:70px;width:min(320px,calc(100% - 44px));max-height:min(520px,calc(100% - 94px));display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid #bc9acd4d;border-radius:16px;background:#30273eee;box-shadow:0 8px 28px #1c132866;backdrop-filter:blur(16px);transform-origin:top left;opacity:0;transform:scale(.92);visibility:hidden;pointer-events:none;transition:opacity 180ms ease-in,transform 220ms ease-in,visibility 0s 220ms}
.sidebar-open .aichat-sidebar{opacity:1;transform:scale(1);visibility:visible;pointer-events:auto;transition:opacity 220ms cubic-bezier(.22,1,.36,1),transform 320ms cubic-bezier(.34,1.4,.64,1),visibility 0s}
.aichat-sidebar-heading{display:flex;align-items:center;gap:8px;font-size:calc(16px * var(--ui-text-scale,1))}
.aichat-sidebar-heading b{flex:1}
.aichat-sidebar-close{width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:#d5c1e2;font:inherit;font-size:calc(23px * var(--ui-text-scale,1));cursor:pointer}
.aichat-sidebar-close:hover{background:#bd99d12b}
.aichat-sidebar>.aichat-btn{width:100%;min-height:34px}
.aichat-session-list{min-height:0;overflow-y:auto;border-top:1px solid #b69ac42b;padding-top:8px;display:flex;flex-direction:column;gap:4px;scrollbar-width:thin;scrollbar-color:#a17eb966 transparent}
.aichat-session{flex:none;text-align:left;border:1px solid transparent;border-radius:10px;padding:10px;background:transparent;color:#efe5fa;cursor:pointer;font:inherit;font-size:calc(12px * var(--ui-text-scale,1));transition:background 250ms}
.aichat-session:hover,.aichat-session.on{background:#b58fc32b;border-color:#b58fc32b}
.aichat-session:disabled{opacity:.55;cursor:default}
.aichat-session span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aichat-session small{display:block;margin-top:5px;color:#c1afd0;font-size:calc(10.5px * var(--ui-text-scale,1))}
.aichat-history-empty{margin:22px 0;text-align:center;color:#bba8cf;font-size:calc(12px * var(--ui-text-scale,1))}
.aichat-chip{background:#ffffff0a;border-color:#c9acd329;color:#e1d2ef;padding:6px 12px}
.aichat-chip.on{background:#c9a6d438;border-color:#d6b8e16b;color:#fff}
.aichat-log{padding:8px 0;min-height:0;scrollbar-width:thin;scrollbar-color:#ae8cbb66 transparent}
.aichat.is-empty .aichat-log{justify-content:safe flex-end;overflow:auto;padding-bottom:0}
.aichat-empty{flex:none;border:0;padding:0;background:none;margin-bottom:0}
.aichat-empty b{font-size:calc(clamp(25px,4.7vw,38px) * var(--ui-text-scale,1));line-height:1.4;letter-spacing:.01em;margin-bottom:10px;font-weight:700;color:#fcf4ff}
.aichat-empty p{font-size:calc(16px * var(--ui-text-scale,1));line-height:1.6;margin:0;color:#c0abd0}
.aichat-empty .aichat-btn{margin-top:12px}
.aichat-bar{display:flex;flex-direction:column;align-items:stretch;gap:12px;padding:18px 20px 12px;border:2px solid #887092;border-radius:23px;background:#272236ed;box-shadow:0 7px 24px #27192c22;transition:border-color .15s}
.aichat-bar:focus-within{border-color:#b99cc7}
.aichat-input{width:100%;box-sizing:border-box;flex:none;border:0;border-radius:0;padding:3px 0;min-height:42px;background:transparent;font-size:calc(15px * var(--ui-text-scale,1));color:#f5eaff;line-height:1.6}
.aichat-input::placeholder{color:#bca9cf;opacity:1}
.aichat-input:focus{outline:none}
.aichat-compose-tools{display:flex;align-items:center;gap:12px;min-width:0}
.aichat-personalize{display:grid;place-items:center;flex:none;width:30px;height:30px;border:1px solid #a588b03d;border-radius:9px;color:#c8b2d8;background:transparent;cursor:pointer}
.aichat-personalize svg{width:18px;height:18px}
.aichat-model{margin-left:auto;max-width:65%;font:inherit;font-size:calc(12px * var(--ui-text-scale,1));padding:6px 16px;border:1px solid #dac0e485;color:#fff;background:linear-gradient(120deg,#b492c1aa,#856794aa);box-shadow:0 0 18px #d6b3e043;border-radius:12px;cursor:pointer}
.aichat-send{display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:50%;padding:0;background:#cfa8dd;color:#fff;flex:none;cursor:pointer}
.aichat-send svg{width:21px;height:21px}
.aichat-send:disabled{opacity:.45;cursor:default}
.aichat-shortcuts{display:flex;flex:none;gap:3px;padding:3px;background:#c1a8ca15;border:1px solid #c6acd51f;border-radius:13px;overflow-x:auto;scrollbar-width:none}
.aichat-shortcuts button{flex:1 0 auto;font:inherit;font-size:calc(11.5px * var(--ui-text-scale,1));padding:6px 12px;color:#ddd0ef;border:1px solid transparent;border-radius:10px;background:transparent;cursor:pointer}
.aichat-shortcuts button:hover,.aichat-shortcuts button:focus-visible{background:#bf9ecd66;border-color:#c5a5d3;box-shadow:0 0 12px #cfaae438;color:#fff}
.aichat-feed{font-size:calc(10.5px * var(--ui-text-scale,1));opacity:.85}
.aichat button:focus-visible{outline:2px solid #ead3f4;outline-offset:3px}
.aichat-msg.ai{background:#2b243bd9}
.aichat-msg.me{background:#856294;color:#fff}
.aichat-id{max-height:40%;overflow:auto}
@media (max-width:640px){.aichat-row.me{max-width:90%}.aichat{gap:8px;padding:16px 18px 24px;border-radius:14px}.aichat-empty b{font-size:calc(26px * var(--ui-text-scale,1))}.aichat-empty p{font-size:calc(13px * var(--ui-text-scale,1))}.aichat-bar{padding:14px;border-radius:20px}.aichat-head{gap:6px}.aichat-chip{font-size:calc(10px * var(--ui-text-scale,1));padding:5px 8px}.aichat-tools{width:100%}.aichat-model{max-width:68%;padding:6px 10px}}
@media (max-height:480px){.aichat{padding-top:12px;padding-bottom:16px}.aichat-empty b{font-size:calc(23px * var(--ui-text-scale,1))}.aichat-empty p{font-size:calc(12px * var(--ui-text-scale,1))}.aichat-feed{display:none}}
@media (max-width:640px){.aichat-sidebar{left:18px;top:60px;width:min(320px,calc(100% - 36px));max-height:calc(100% - 84px)}}
@media (max-height:480px){.aichat-sidebar{top:56px;max-height:calc(100% - 72px);gap:8px;padding:12px}}
@media (prefers-reduced-motion:reduce){.aichat-bar,.aichat-menu,.aichat-menu span,.aichat-sidebar,.aichat-backdrop,.aichat-session{transition:none}.aichat-think i{animation:none}}
`;
    document.head.append(st);
  }

  function renderThread() {
    if (!ui) return;
    const log = ui.log;
    ui.root.classList.toggle("is-empty", !thread.length && !busy);
    ui.shortcuts.innerHTML = activeChips().map((c, i) => `<button type="button" data-chip="${i}">${esc(c.label)}</button>`).join("");
    wireEmpty();
    taskIndex = null;                  // 任务标题缓存一轮一取，中途改了标题下一轮能跟上
    const prevTop = log.scrollTop;
    const prevHeight = log.scrollHeight;
    // 重建前先问一句「用户是不是贴着底部」。只有贴着才跟着滚到最新；否则原地不动
    // （按内容高度变化补偿 scrollTop）—— 改名、勾选建议、切「带本机数据」这类
    // 重渲染不该把正在往上翻记录的人甩回底部。
    const stick = !prevHeight || prevHeight - prevTop - log.clientHeight < 40;
    // 按最后一条的时间判断「有没有新消息」，不能数条数：thread 满 40 条后是滑动的，
    // 新消息进来条数不变，「有新回复」就永远不亮了。
    const lastAt = thread.length ? Number(thread[thread.length - 1].at) || 0 : 0;
    const grew = lastAt !== seenLastAt;
    seenLastAt = lastAt;
    log.innerHTML = "";
    // 逐条 append 真实元素而不是套一层 div：.aichat-log 是 flex 列，多出来的匿名包裹会
    // 吃掉行上的 align-self（用户气泡因此一直是靠左的）。
    if (!thread.length) { log.append(node(emptyHtml()).firstElementChild); wireEmpty(); }
    thread.forEach((m, idx) => {
      const row = node(messageHtml(m, idx)).firstElementChild;
      log.append(row);
      wireMessage(row, m);
    });
    if (busy) {
      log.append(node(`<div class="aichat-row ai">${avatarHtml("ai")}<div class="aichat-body"><div class="aichat-who">${esc(displayName("ai"))}</div><div class="aichat-msg ai"><span class="aichat-think"><i></i><i></i><i></i> 正在思考…</span></div></div></div>`).firstElementChild);
    }
    if (stick) log.scrollTop = log.scrollHeight;
    else log.scrollTop = Math.max(0, prevTop + (log.scrollHeight - prevHeight));
    // 有新消息而人又没在看底部时，给个入口；一旦回到底部就收起（下一次渲染 stick 为真）。
    if (grew && !stick) ui.jump.hidden = false;
    if (stick) ui.jump.hidden = true;
  }

  function emptyHtml() {
    const name = identity.me.name || "架构师";
    return `<div class="aichat-empty">
      <b>${esc(name)}…一起理理思绪？</b>
      <p>${configured ? "写下你的想法，让今天的安排更清晰" : "配置你的模型，开始一段新的对话"}</p>
      ${configured ? "" : '<button class="aichat-btn pri" data-go-ai>去配置模型</button>'}
    </div>`;
  }

  function messageHtml(m, idx) {
    const role = m.role === "user" ? "me" : m.role === "error" ? "err" : "ai";
    const when = new Date(m.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const body = m.role === "error"
      ? `<p>这次没成功：${esc(m.text)}</p><div class="aichat-sug-act"><button class="aichat-btn" data-retry="${idx}">重试这一条</button></div>`
      : md(m.text);
    const sug = (!m.suggestions || !m.suggestions.length || m.role !== "assistant") ? "" : `
      <div class="aichat-sug">
        <div class="aichat-sug-t">整理出的改动 · 勾选后才写入</div>
        ${m.suggestions.map((s, i) => `
          <label class="aichat-sug-row">
            <input type="checkbox" data-sug="${i}" ${s.applied ? "disabled" : ""} ${s.checked && !s.applied ? "checked" : ""}>
            <span class="${s.reason ? "no" : ""}">${esc(describe(s))}
              ${s.reason ? `<small>${esc(s.reason)}</small>` : ""}
              ${s.applied ? "<small>已写入</small>" : ""}
              ${s.movedTo ? `<small>该时段冲突，已自动挪到 ${esc(s.movedTo)}</small>` : ""}
            </span>
          </label>`).join("")}
        <div class="aichat-sug-act"><button class="aichat-btn pri" data-apply="${idx}">写入所选</button></div>
      </div>`;
    const bubble = `<div class="aichat-msg ${role}">${body}<div class="aichat-when">${when}</div>${sug}</div>`;
    // 报错是系统插话、不是谁说的话，所以不带头像和名称。
    if (role === "err") return bubble;
    return `<div class="aichat-row ${role}">${avatarHtml(role)}<div class="aichat-body"><div class="aichat-who">${esc(displayName(role))}</div>${bubble}</div></div>`;
  }

  function wireEmpty() {
    const go = ui.log.querySelector("[data-go-ai]");
    if (go) go.onclick = () => window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: "ai" } }));
    ui.shortcuts.querySelectorAll("[data-chip]").forEach((btn) => {
      btn.onclick = () => {
        if (busy) return;
        ui.input.value = activeChips()[Number(btn.dataset.chip)].ask;
        ui.input.oninput();
        ui.input.focus();
      };
    });
  }

  function wireMessage(box, m) {
    const retry = box.querySelector("[data-retry]");
    if (retry) {
      retry.onclick = () => {
        const at = thread.indexOf(m);
        let qAt = at - 1;
        while (qAt >= 0 && thread[qAt].role !== "user") qAt -= 1;
        if (qAt < 0) { thread.splice(at, 1); renderThread(); return; }
        const question = thread[qAt].text;
        // 提问与错误一起摘掉再重发，否则重试一次就多一条重复提问。
        thread.splice(qAt, at - qAt + 1);
        ask(question);
      };
    }
    const apply = box.querySelector("[data-apply]");
    if (apply) {
      apply.onclick = () => {
        const picked = m.suggestions.filter((s) => s.checked && !s.applied && !s.reason);
        if (!picked.length) { tide.notify("没有可写入的条目（先勾掉有问题的再试）"); return; }
        const { record, errors } = applySuggestions(picked);
        saveThread();
        renderThread();
        const n = record.tasks.length + record.blocks.length + record.updates.length;
        if (n) tide.notify(`已写入 ${n} 条${errors.length ? `，${errors.length} 条失败` : ""}`, { action: () => undoRecord(record), actionLabel: "撤销", ms: 10000 });
        else if (errors.length) tide.notify(`写入失败：${errors[0]}`);
        refresh();
      };
    }
    box.querySelectorAll("[data-sug]").forEach((cb) => {
      cb.onchange = () => { m.suggestions[Number(cb.dataset.sug)].checked = cb.checked; };
    });
  }

  function paintBusy() {
    if (!ui) return;
    ui.send.disabled = busy || !configured;
    ui.input.disabled = busy;
    paintSessions();
    renderThread();
  }

  function setContext(on) {
    withContext = on;
    tide.storage.set(CTX_KEY, on);
    ui.ctx.classList.toggle("on", on);
    ui.ctx.setAttribute("aria-pressed", String(on));
    ui.ctx.title = on ? "每次提问都会把本机任务、近三天时间块与插件消息一起发给模型" : "已关闭：只问通用问题，不上传本机数据";
    renderThread();
  }

  /** 把当前思考强度画到按钮上：文字里直接写出档位，「自动」不点亮（= 没额外要求）。 */
  function paintThink() {
    if (!ui?.think) return;
    const level = thinkLevel();
    ui.think.textContent = `思考强度 ${level.label}`;
    ui.think.classList.toggle("on", level.id !== "");
    ui.think.setAttribute("aria-label", `思考强度：${level.label}，点击切换下一档`);
    ui.think.title = `${level.hint}。点击依次切换：${THINK_CYCLE}`;
  }

  /** 档位在按钮上就地轮换，不动别的状态 —— 下一句话就按新档发出。 */
  function cycleThink() {
    const index = THINK_LEVELS.findIndex((l) => l.id === thinkEffort);
    const next = THINK_LEVELS[(index + 1) % THINK_LEVELS.length];
    thinkEffort = next.id;
    tide.storage.set(THINK_KEY, thinkEffort);
    paintThink();
  }

  async function loadOnce() {
    if (loaded) return;
    const st = await tide.ai.status().catch(() => ({ configured: false }));
    configured = !!st?.configured;
    modelLabel = st?.model || "";
    withContext = await tide.storage.get(CTX_KEY, true) !== false;
    // 脏值兜底：存进去的档位认不出来就退回「自动」，别把一个非法值递给 Rust（它会直接报错）。
    const savedThink = String((await tide.storage.get(THINK_KEY, "")) ?? "");
    thinkEffort = isThinkLevel(savedThink) ? savedThink : "";
    thread = await tide.storage.get(THREAD_KEY, []) || [];
    notices = (await tide.storage.get(NOTICE_KEY, [])) || [];
    identity = normalizeIdentity(await tide.storage.get(ID_KEY, null));
    draft = String((await tide.storage.get(DRAFT_KEY, "")) || "");
    const saved = await tide.storage.get(SESSIONS_KEY, null);
    sessions = Array.isArray(saved?.items) ? saved.items.filter((s) => s && typeof s.id === "string" && typeof s.title === "string" && Array.isArray(s.thread)) : [];
    sessionId = typeof saved?.activeId === "string" && saved.activeId ? saved.activeId : newSessionId();
    // 旧版本只有 thread / draft，首次进入即加入历史，保留原有内容。
    saveThread();
    loaded = true;
  }

  /** 头部那行「已收集 N 条」：让用户知道 AI 看得见的不只是自己的任务清单。 */
  function paintFeed() {
    if (!ui || !ui.feed) return;
    const sources = new Set(notices.map((m) => m.sourceName || m.source));
    ui.feed.textContent = notices.length
      ? `已收集 ${notices.length} 条插件消息 · 来自 ${sources.size} 个来源`
      : "还没收集到其他插件的消息";
    ui.feed.title = notices.length
      ? "各插件公开的现有消息摘要和新消息，会随本机快照一起发给模型"
      : "打开消息类插件后会收集其当前列表，也可以直接问 AI「最近有什么通知」";
  }

  async function refresh() {
    const st = await tide.ai.status().catch(() => null);
    if (st) { configured = !!st.configured; modelLabel = st.model || ""; }
    if (ui) {
      ui.model.textContent = configured ? (modelLabel || "已配置模型") : "未配置模型";
      paintBusy();
    }
  }

  async function render(el2) {
    ensureStyle();
    await loadOnce();
    el2.innerHTML = "";
    ui = null;

    const root = node(`<div class="aichat">
      <div class="aichat-head">
        <button type="button" class="aichat-menu" data-menu aria-label="展开对话历史" title="对话历史" aria-controls="aichat-history" aria-expanded="false"><span></span><span></span><span></span></button>
        <button class="aichat-chip" data-ctx>带本机数据</button>
        <button type="button" class="aichat-chip aichat-effort" data-think></button>
      </div>
      <div class="aichat-backdrop" aria-hidden="true"></div>
      <aside class="aichat-sidebar" id="aichat-history" aria-label="对话历史" aria-hidden="true" inert>
        <div class="aichat-sidebar-heading"><b>对话历史</b><button type="button" class="aichat-sidebar-close" aria-label="收起对话历史">×</button></div>
        <button type="button" class="aichat-btn pri" data-clear>＋ 新对话</button>
        <div class="aichat-session-list"></div>
        <button type="button" class="aichat-btn" data-id>头像与名称</button>
      </aside>
      <div class="aichat-id" hidden>
        ${["me", "ai"].map((role) => `
          <div class="aichat-id-row">
            <button type="button" class="aichat-avatar ${role}" data-pick="${role}"></button>
            <label class="aichat-id-name"><span>${role === "me" ? "我的名称" : "AI 名称"}</span>
              <input type="text" data-name="${role}" maxlength="${NAME_MAX}" placeholder="${esc(DEFAULT_NAME[role])}" autocomplete="off" spellcheck="false">
            </label>
            <button type="button" class="aichat-btn" data-reset="${role}">恢复默认</button>
          </div>`).join("")}
        <p class="aichat-id-tip">头像与名称只存进本机数据，不会发给模型。改过名称后头像自动换成名称首字，上传过图片则以图片为准。</p>
        <input type="file" class="aichat-file" accept="image/*" hidden>
      </div>
      <div class="aichat-log"></div>
      <button type="button" class="aichat-jump" hidden>↓ 有新回复</button>
      <div class="aichat-bar">
        <textarea class="aichat-input" rows="1" aria-label="对话内容" placeholder="帮我把这周的事理一遍"></textarea>
        <div class="aichat-compose-tools">
          <button type="button" class="aichat-personalize" data-personalize aria-label="头像与名称" title="头像与名称"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/></svg></button>
          <button type="button" class="aichat-model" title="打开模型设置"></button>
          <button type="button" class="aichat-send" data-send aria-label="发送" title="发送 · Enter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m21 3-6 18-4-8-8-4 18-6Z"/><path d="m11 13 10-10"/></svg></button>
        </div>
      </div>
      <div class="aichat-shortcuts" aria-label="快捷提问"></div>
      <div class="aichat-feed"></div>
    </div>`).firstChild;
    el2.append(root);

    ui = {
      root,
      sessionList: root.querySelector(".aichat-session-list"),
      shortcuts: root.querySelector(".aichat-shortcuts"),
      log: root.querySelector(".aichat-log"),
      input: root.querySelector(".aichat-input"),
      send: root.querySelector("[data-send]"),
      model: root.querySelector(".aichat-model"),
      feed: root.querySelector(".aichat-feed"),
      ctx: root.querySelector("[data-ctx]"),
      think: root.querySelector("[data-think]"),
      clear: root.querySelector("[data-clear]"),
      jump: root.querySelector(".aichat-jump"),
      idBtn: root.querySelector("[data-id]"),
      idPanel: root.querySelector(".aichat-id"),
    };
    ui.model.textContent = configured ? (modelLabel || "已配置模型") : "未配置模型";
    ui.ctx.classList.toggle("on", withContext);
    ui.ctx.setAttribute("aria-pressed", String(withContext));
    ui.ctx.title = withContext ? "每次提问都会把本机任务、近三天时间块与插件消息一起发给模型" : "已关闭：只问通用问题，不上传本机数据";
    ui.ctx.onclick = () => setContext(!withContext);
    paintThink();
    ui.think.onclick = cycleThink;
    ui.model.onclick = () => window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: "ai" } }));
    const menu = root.querySelector("[data-menu]");
    const sidebar = root.querySelector(".aichat-sidebar");
    let sidebarOpen = false;
    const setSidebar = (open, restoreFocus = false) => {
      sidebarOpen = open;
      root.classList.toggle("sidebar-open", open);
      sidebar.inert = !open;
      sidebar.setAttribute("aria-hidden", String(!open));
      menu.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-label", open ? "收起对话历史" : "展开对话历史");
      if (open) paintSessions();
      if (restoreFocus) menu.focus();
    };
    ui.closeSidebar = () => setSidebar(false);
    menu.onclick = () => setSidebar(!sidebarOpen);
    root.querySelector(".aichat-sidebar-close").onclick = () => setSidebar(false, true);
    root.querySelector(".aichat-backdrop").onclick = () => setSidebar(false, true);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && sidebarOpen) {
        event.preventDefault();
        event.stopPropagation();
        setSidebar(false, true);
      }
    });
    root.querySelector("[data-personalize]").onclick = () => ui.idBtn.onclick();
    ui.jump.onclick = () => {
      ui.log.scrollTop = ui.log.scrollHeight;
      ui.jump.hidden = true;
    };
    ui.clear.onclick = () => {
      if (busy) return;
      startSession();
      tide.notify("已开新对话，之前的记录保留在对话历史中");
    };
    ui.idBtn.onclick = () => {
      setSidebar(false);
      ui.idPanel.hidden = !ui.idPanel.hidden;
      ui.idBtn.classList.toggle("on", !ui.idPanel.hidden);
    };
    // 一次只挑一个头像：文件框是共用的，点哪个按钮先记下角色。
    let picking = "";
    const file = root.querySelector(".aichat-file");
    file.onchange = async () => {
      const f = file.files?.[0];
      const role = picking;
      file.value = "";
      picking = "";
      if (!f || !role) return;
      if (f.size > 8 * 1024 * 1024) { tide.notify("头像图片请控制在 8MB 以内"); return; }
      try {
        identity[role].avatar = await readAvatar(f);
        saveIdentity();
      } catch (e) {
        tide.notify(`头像读取失败：${(e && e.message) || e}`);
      }
    };
    ui.idPanel.querySelectorAll("[data-pick]").forEach((b) => {
      b.onclick = () => { picking = b.dataset.pick; file.click(); };
    });
    ui.idPanel.querySelectorAll("[data-name]").forEach((input) => {
      input.oninput = () => {
        identity[input.dataset.name].name = input.value.trim().slice(0, NAME_MAX);
        tide.storage.set(ID_KEY, identity);
        paintAvatars();
        renderThread();
      };
    });
    ui.idPanel.querySelectorAll("[data-reset]").forEach((b) => {
      b.onclick = () => {
        identity[b.dataset.reset] = { name: "", avatar: "" };
        saveIdentity();
        tide.notify("已恢复默认头像与名称");
      };
    });
    paintIdentityPanel();

    const autosize = () => {
      ui.input.style.height = "auto";
      ui.input.style.height = `${Math.min(130, ui.input.scrollHeight)}px`;
    };
    const send = () => {
      if (busy || !configured) return;
      const q = ui.input.value.trim();
      if (!q) return;
      ui.input.value = "";
      ui.input.style.height = "auto";
      draft = "";
      tide.storage.set(DRAFT_KEY, "");
      ask(q);
    };
    ui.send.onclick = send;
    ui.input.oninput = () => {
      autosize();
      draft = ui.input.value;
      tide.storage.set(DRAFT_KEY, draft);
      saveThread();
    };
    // 中文输入法回车是在选词，不能当发送；Shift+Enter 留作换行。
    ui.input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    };
    ui.input.value = draft;
    if (draft) autosize();
    paintBusy();
    paintFeed();
    // 进页面先抄一次：消息类插件多半在启动阶段就广播完了，晚加载的这一轮才补得回来。
    syncNotices().then(() => { paintFeed(); renderThread(); });
    return () => { ui = null; };
  }

  tide.ui.registerView({ id: VIEW_ID, title: "AI 对话", icon: "robot", render });
})();
