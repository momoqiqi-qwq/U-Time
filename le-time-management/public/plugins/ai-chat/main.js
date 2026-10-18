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
//   · 安全区：本视图不建 fixed 浮层、不往宿主容器外挂节点、不按视口尺寸定位（铁律四与
//     scripts/test-plugin-safe-area.mjs 会拦这三类）；吸底输入框靠 .plugview 的满高 flex 列实现。
//     视图内的弹层（侧栏 / 头像弹窗 / 档位下拉）一律用 absolute —— 包含块是带 transform 的
//     .aichat，天然落在宿主 .view 的安全区里，不用自己补四条边。
//
// v0.175.0 加了「思考强度」：档位跟着请求走（tide.ai.chat 的 reasoningEffort → Rust 的
// reasoning_effort）。v0.204.0 把它从「头部一颗循环按钮」改成输入区里的下拉栏 —— 四档是
// 「一组只能选一个」，逐次循环既看不到有哪几档、又要连点四下才能回到原档；「带本机数据」
// 也一起从顶栏搬到输入区，改本轮行为的东西贴着「说」的地方。改法见 THINK_LEVELS 上方。
// v0.205.0 再收一轮输入区：档位栏从「in-flow 折叠块」改成向上展开的浮层（展开不再顶掉
// 对话），输入框移到最上、两颗胶囊与工具按钮并成一行 —— 用户原话是「让对话拥有更大的
// 空间…不然看不到上面的对话」。
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
  /* 侧栏宽度（v0.243.0，用户原话：「宽度可以自由拖动、拉长或拉大」）。
     与宿主 .rail 的可拖拽同口径：落盘存**布局 px 整数**，未自定义/脏数据 = null（回 CSS 默认
     260px）；拖动中的实时值允许越界，夹取而不是拒收。上限还要再被对话面宽度的 55% 压一次 ——
     侧栏宽过对话列本身就没有「对话」可看了，窄窗口里尤其明显。 */
  const RAIL_W_KEY = "railWidth";
  const RAIL_W_DEFAULT = 260;
  const RAIL_W_STEP = 16;
  const RAIL_W_LIMITS = Object.freeze({ min: 200, max: 480 });
  const RAIL_W_SHARE = 0.55;

  /* 思考强度（v0.175.0 加档位，v0.204.0 从「一颗循环按钮」改成输入区里的下拉栏）：
     四档，`id` 空串 = 不带 reasoning_effort 字段。
     为什么现在是下拉栏：四档是「一组只能选一个」的单选组，逐次循环点四下才能回到原档，
     用户看不到还有哪几档。改成下拉栏后：
       · 展开 / 收起走铁律七（0fr→1fr 连续插值 + 方向箭头旋转 + 收起置 inert，见 .aichat-effort-menu）；
       · 选中高亮走铁律六，用宿主 tide.ui.selectionGlow 的滑动光（与快捷提问行同一套参数）；
       · 浮层是 absolute 且向上展开（v0.205.0）：展开对布局的高度占用是 0，不再把上面的对话顶掉；
         包含块是带 transform 的 .aichat，所以它落不进宿主 .view 安全区之外，不用自己补四条边；
         test-plugin-safe-area 扫的那几个禁用字面量（贴视口定位的那类）一个都不出现。
         （别在这条注释里把它们原样列出来：那个脚本按字面量扫，注释里写了同样会中招。） */
  const THINK_LEVELS = [
    { id: "", label: "自动", hint: "不指定思考强度，由模型自己决定（默认）" },
    { id: "low", label: "低", hint: "少想一点，回得更快、更省 token" },
    { id: "medium", label: "中", hint: "速度与深度折中" },
    { id: "high", label: "高", hint: "想得更久，适合复杂推理与长链路任务" },
  ];
  const thinkLevel = () => THINK_LEVELS.find((l) => l.id === thinkEffort) || THINK_LEVELS[0];
  const isThinkLevel = (id) => THINK_LEVELS.some((l) => l.id === id);
  // 档位串（「自动 → 低 → 中 → 高」）与下拉栏的选项 HTML 都只算一次：paintThink() 每次
  // 切页回来都会跑，在重绘路径上重拼就是白算一遍（测试按「THINK_LEVELS.map 只准在常量区出现」钉住）。
  const THINK_CYCLE = THINK_LEVELS.map((l) => l.label).join(" → ");
  const THINK_ITEMS = THINK_LEVELS.map((l) => `<button type="button" role="option" class="aichat-lv" data-think-lv="${l.id}" aria-selected="false"><b>${l.label}</b><small>${l.hint}</small></button>`).join("");

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
  let chipGlow = null;    // 快捷提问行的滑动选中光（宿主 tide.ui.selectionGlow 给的 {sync,dispose}）
  let thinkGlow = null;   // 思考强度下拉栏的滑动选中光（同一套宿主光，另一个容器）
  let thinkGlowTimer = 0; // 光块落位定时器：等展开过渡走完再量位置，理由见 setThinkMenu()
  let thinkOpen = false;  // 下拉栏展开态（DOM 重建时一并重置）
  let activeChip = -1;    // 最近一次点的快捷提问；-1 = 还没点过（光块不出现）
  let disposeHooked = false;   // tide.ui.onDispose 只挂一次，避免每次重绘往宿主 Set 里塞新闭包
  let sessions = [];
  let sessionId = "";
  // 「已归档」分组是展开还是收起。它必须活在重绘之外 —— 每次 saveThread() 都会重画侧栏，
  // 状态放在渲染函数里的话，打一个字进去分组就自己合上了。
  let archiveOpen = false;
  // 侧栏宽度（布局 px）。null = 没自定义过，宽度回 CSS 的 --side-w 默认 260px。
  let railWidth = null;
  /* 会话右键菜单的「收尾钩子」。paintSessions() 在模块层、菜单接线在 render() 里，而重画列表
     必须先收掉菜单（菜单锚在旧卡片上，卡片一换节点就悬空了）。用钩子而不是把 paintSessions
     搬进 render：它会重建，闭包会随每次重绘堆积。 */
  let ctxCloser = null;
  const newSessionId = () => `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  /** 只落盘会话索引（改名 / 归档 / 删除用得到），不碰 thread 与 draft。 */
  function persistSessions() {
    tide.storage.set(SESSIONS_KEY, { activeId: sessionId, items: sessions });
  }

  function saveThread() {
    if (!sessionId) sessionId = newSessionId();
    const previous = sessions.find((s) => s.id === sessionId);
    if (thread.length || draft || previous) {
      const first = thread.find((m) => m.role === "user");
      // 手动改过名的会话不许被「首条提问」盖回去：saveThread() 每轮对话都会跑一次，
      // 用首条提问当标题的话，改名只活到下一次发送。
      const auto = first?.text.slice(0, 32) || "未发送的草稿";
      const entry = {
        id: sessionId,
        title: previous?.renamed ? previous.title : auto,
        at: thread.at(-1)?.at || previous?.at || Date.now(),
        thread: thread.slice(),
        draft,
        renamed: !!previous?.renamed,
        archived: !!previous?.archived,
      };
      sessions = sessions.filter((s) => s.id !== sessionId).concat(entry);
    }
    tide.storage.set(THREAD_KEY, thread);
    tide.storage.set(DRAFT_KEY, draft);
    persistSessions();
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
      ui.closeId?.();
      ui.input.focus();
    }
  }

  /* ─── 会话管理三件事：改名 / 归档 / 删除（右键菜单，v0.235.0）───
     三条都不是「只改 DOM」：sessions 是唯一事实源，改完必须 persistSessions() + paintSessions()。
     删除当前会话时还要把内存里的 thread/draft 一起清掉 —— 见 deleteSession 里的注释。 */

  function renameSession(id, title) {
    const s = sessions.find((x) => x.id === id);
    const name = String(title || "").trim().slice(0, 60);
    if (!s || !name || name === s.title) return false;
    s.title = name;
    s.renamed = true;
    persistSessions();
    paintSessions();
    return true;
  }

  function archiveSession(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    s.archived = !s.archived;
    // 刚归档完就把分组展开 —— 否则用户点「归档」，卡片凭空消失，看着像被删了。
    if (s.archived) archiveOpen = true;
    persistSessions();
    paintSessions();
    tide.notify(s.archived ? `已归档「${s.title}」` : `已取消归档「${s.title}」`);
  }

  function deleteSession(id) {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const wasActive = id === sessionId;
    sessions = sessions.filter((s) => s.id !== id);
    if (!wasActive) {
      persistSessions();
      paintSessions();
    } else {
      /* 删掉的正是当前这条：光把 sessionId 挪走不够 —— saveThread() 会按 sessionId 找到
         「上一个自己」，把内存里还在的 thread 原样写回 sessions，等于删了又活。所以
         thread / draft 必须与 sessionId 一起换掉。 */
      const next = sessions.slice().sort((a, b) => b.at - a.at)[0];
      sessionId = next ? next.id : "";
      thread = next ? next.thread.slice() : [];
      draft = next?.draft || "";
      if (ui) {
        ui.input.value = draft;
        ui.input.oninput();               // 顺带走一次 saveThread()，把新状态落盘
        renderThread();
        ui.log.scrollTop = ui.log.scrollHeight;
        ui.closeId?.();
      } else persistSessions();
      paintSessions();
    }
    tide.notify(`已删除「${target.title}」`);
  }

  function paintSessions() {
    if (!ui?.sessionList) return;
    ctxCloser?.();
    const items = sessions.slice().sort((a, b) => b.at - a.at);
    const card = (s) => `<button type="button" class="aichat-session${s.id === sessionId ? " on" : ""}" data-session="${esc(s.id)}" title="右键：重命名 / 归档 / 删除" ${busy ? "disabled" : ""} ${s.id === sessionId ? 'aria-current="true"' : ""}><span>${esc(s.title)}</span><small>${esc(new Date(s.at).toLocaleDateString("zh-CN"))} · ${s.thread.length} 条消息</small></button>`;
    const live = items.filter((s) => !s.archived);
    const arch = items.filter((s) => s.archived);
    /* 归档分组用 0fr → 1fr 插值开合（铁律七：展开与收起都要有中间帧，内容不删只收），
       箭头是同一支连续旋转，不换字符。分组自己带计数，收起时也知道里面有几条。 */
    const archive = arch.length ? `
      <div class="aichat-archive${archiveOpen ? " open" : ""}">
        <button type="button" class="aichat-archive-head" data-arch-toggle aria-expanded="${archiveOpen}"><i aria-hidden="true"></i>已归档 ${arch.length}</button>
        <div class="aichat-archive-body"><div>${arch.map(card).join("")}</div></div>
      </div>` : "";
    ui.sessionList.innerHTML = (live.length ? live.map(card).join("") : '<p class="aichat-history-empty">还没有对话记录</p>') + archive;
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

  /**
   * 侧栏宽度的落盘闸门：storage 里的值 → 布局 px 整数。
   * 脏数据（非数字、0、空串、负数、NaN/Infinity）一律 null = 回 CSS 默认，宁可不要自定义；
   * 越界值夹进区间 —— 语义是「上次拖过头了」，仍然是有效的自定义宽度。
   */
  function normalizeRailW(raw) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.min(RAIL_W_LIMITS.max, Math.max(RAIL_W_LIMITS.min, Math.round(raw)));
  }

  /**
   * 拖动 / 键盘的实时宽度：只认有限数字 —— 0 与负数在这里是「往左拖过头」的合法中间态，
   * 夹到下限即可，不当脏数据（`Number(null) === 0` 那种坑由 normalizeRailW 挡在存储侧）。
   * 上限再被容器宽度的 55% 压一次；容器还没进布局（offsetWidth === 0）时退回常量上限。
   */
  function clampRailW(raw, containerW) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    const byBox = containerW > 0 ? Math.round(containerW * RAIL_W_SHARE) : RAIL_W_LIMITS.max;
    const hi = Math.max(RAIL_W_LIMITS.min, Math.min(RAIL_W_LIMITS.max, byBox));
    return Math.min(hi, Math.max(RAIL_W_LIMITS.min, Math.round(raw)));
  }

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

  /* ─── 回答卡片（v0.235.0）───
     用户原话：「给AI的回答内容的多表现为对话卡片，颜色多样化一些」。
     以前一条回答就是一整块同色气泡，结论、正文、清单连成一片，扫的时候分不清哪块是哪块。
     现在：按空行把回答切成若干张卡，每张卡自带一个色相（左竖条 + 同色晕染底 + 同色小标题），
     色相取「内容哈希 + 序号」，所以同一条回答每次重绘颜色完全一致（不会闪），相邻段落之间
     又必然不同色。
     md() 一行没动 —— 卡片只是把 md() 的输出按段落装帧。测试里 md() 的精确输出是硬约束，
     所有装帧都在这个函数里做，不往 md() 里塞任何分支。 */
  const CARD_TONES = 6;
  function toneOf(text, i) {
    let h = 0;
    for (let k = 0; k < text.length; k += 1) h = (h * 31 + text.charCodeAt(k)) >>> 0;
    return (h + i * 3) % CARD_TONES;
  }

  function cardHtml(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return "";
    const blocks = raw.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
    if (!blocks.length) return "";
    return blocks.map((b, i) => {
      /* md() 的 leadFree 是按单次调用算的：切块后每块都想当「结论」。只有第一块配叫结论，
         后面的把 .lead 摘掉，否则一条回答里会冒出好几个加粗大标题。 */
      const html = i ? md(b).replace('<p class="lead">', "<p>") : md(b);
      return `<section class="aichat-card" data-tone="${toneOf(b, i)}">${html}</section>`;
    }).join("");
  }

  function node(html) {
    const box = document.createElement("div");
    box.innerHTML = html;
    return box;
  }

  /* ─────────────────── 生成式界面：dsh-ui 围栏（v0.201.0） ───────────────────

     参考 dsh-genui：模型可以在正文里另起一个 ```dsh-ui 代码块，块里是一份 JSON 规格，
     界面把它画成真组件（结论卡、对比表、清单、图表…），而不是丢一段等宽的 JSON 让用户自己读。

     三条取舍，都是被沙箱逼出来的：
       · 这里只有 tide.* 与 document，没有 React，也没有 echarts / mermaid / three；
         所以只复刻「原生 DOM + CSS 就能画准」的组件，echart / mermaid / diagram /
         scene3d / plot 一律降级成代码块（信息不丢，也不引任何外部依赖）。
       · 规格先过白名单再画：未知 type 直接丢，节点数封顶 200、层级封顶 8，
         字符串一律先 esc() 再内联排版 —— 模型吐 HTML 也执行不了。
       · 交互只做本地的（切页签 / 展开 / 筛选 / 填值 / 判卷 / 复制），不为了一个按钮回头找模型；
         要模型参与的按钮没有 action 就渲染成禁用态，不做「看着能点、点了没反应」的假按钮。
     护栏在 scripts/test-ai-chat.mjs 的「生成式界面」一节逐条盯着。 */

  const GENUI_LANGS = new Set(["dsh-ui", "genui"]);
  const GENUI_MARK = "\u0001";     // 正文里的占位符：\u0001GUI0\u0001，渲染时换回组件
  const GENUI_MAX_NODES = 200;     // 与 dsh-genui 同一个口径：再多也没人看得完
  const GENUI_MAX_DEPTH = 8;
  const GENUI_TONES = new Set(["info", "success", "warning", "error"]);
  // 需要第三方库或外部媒体的组件：不假装能画，原样当代码块交给用户。
  const GENUI_AS_CODE = new Set(["echart", "mermaid", "diagram", "scene3d", "plot", "image", "audio", "video"]);

  const giText = (v) => (v == null ? "" : String(v));
  const giTag = (tag, cls, inner, attrs = "") =>
    `<${tag}${cls ? ` class="${cls}"` : ""}${attrs}>${inner}</${tag}>`;
  const giOne = (v, key, fallback = "") => giText(v && typeof v === "object" ? v[key] : v) || fallback;
  const giNum = (v) => {
    const n = Number(String(v ?? "").trim());
    return Number.isFinite(n) ? n : null;
  };

  /** 围栏里的小富文本：先转义，再补 ==高亮== / **加粗** / `行内码` / [文字](网址)。 */
  function giInline(s) {
    return esc(giText(s))
      .replace(/==([^=]+)==/g, "<mark>$1</mark>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="gui-link" href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  }

  /**
   * 从第一个 { 开始配平括号（跳过字符串里的括号），顺带容忍模型带上来的尾随文字。
   * 返回配平出来的那一段 JSON 文本；配不平就返回空串。
   */
  function giBalanced(src, start) {
    let depth = 0;
    let quote = false;
    let escape = false;
    for (let i = start; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"') { quote = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return "";
  }

  /** 规格白名单：只留认识的键，标题截断，items 必须是数组。坏规格返回 null（正文原样留着）。 */
  function giSpec(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const items = Array.isArray(raw.items) ? raw.items
      : Array.isArray(raw.children) ? raw.children : null;
    if (!items || !items.length) return null;
    return {
      title: giText(raw.title).replace(/\s+/g, " ").trim().slice(0, 120),
      gap: Math.max(4, Math.min(28, Math.round(giNum(raw.gap) ?? 12))),
      items,
    };
  }

  /** 围栏内容 → 规格；坏 JSON / 非对象根都返回 null。 */
  function parseGenui(inner) {
    const src = giText(inner).trim();
    const start = src.indexOf("{");
    if (start < 0) return null;
    const cut = giBalanced(src, start);
    if (!cut) return null;
    let parsed = null;
    try { parsed = JSON.parse(cut); } catch {
      // 模型写 JSON 最常见的两处手滑：尾随逗号、末尾多一句解释。只修前者。
      try { parsed = JSON.parse(cut.replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
    }
    return giSpec(parsed);
  }

  /**
   * 把回复里的 dsh-ui 围栏摘出来，正文原地留一个占位符。
   * 留占位符是为了**保住位置**：围栏可以出现在正文中间，抽走之后按顺序插回去，
   * 而不是一律堆到气泡末尾。坏规格不摘（原样留在正文里给用户看，比凭空消失强）。
   */
  function splitGenui(raw) {
    const blocks = [];
    const body = giText(raw).replace(/```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g, (all, lang, inner) => {
      if (!GENUI_LANGS.has(String(lang).toLowerCase())) return all;
      const spec = parseGenui(inner);
      if (!spec) return all;
      blocks.push(spec);
      return `${GENUI_MARK}GUI${blocks.length - 1}${GENUI_MARK}`;
    });
    return { body, blocks };
  }

  function giRender(node, depth, seen) {
    if (typeof node === "string" || typeof node === "number") {
      if (seen.n >= GENUI_MAX_NODES || depth > GENUI_MAX_DEPTH) return "";
      seen.n += 1;
      return giTag("p", "gui-text", giInline(node));
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) return "";
    if (seen.n >= GENUI_MAX_NODES || depth > GENUI_MAX_DEPTH) return "";
    seen.n += 1;
    const type = giText(node.type || "text").toLowerCase();
    if (GENUI_AS_CODE.has(type)) return giCode(node.lang || type, node.code ?? node.content ?? JSON.stringify(node));
    const draw = GENUI_DRAW[type];
    return draw ? draw(node, depth, seen) : "";
  }

  /** 子节点：认 items 也认 children；带 span 的按网格跨列包一层。 */
  function giKids(node, depth, seen) {
    const list = Array.isArray(node.items) ? node.items
      : Array.isArray(node.children) ? node.children : [];
    return list.map((child) => {
      const html = giRender(child, depth + 1, seen);
      if (!html) return "";
      const span = child && typeof child === "object" ? Math.round(giNum(child.span) ?? 0) : 0;
      return span > 1 ? giTag("div", "gui-span", html, ` style="grid-column:span ${Math.max(1, Math.min(4, span))}"`) : html;
    }).join("");
  }

  const giCode = (lang, code) => {
    const label = giText(lang).slice(0, 24);
    return `<pre class="gui-code"${label ? ` data-lang="${esc(label)}"` : ""}><code>${esc(giText(code))}</code></pre>`;
  };

  /** 偏差：正数绿、负数红、零灰。颜色语义照截图（绿=正常，红=不一致）。 */
  function giDelta(v) {
    const s = giText(v).trim();
    const n = giNum(s);
    const sign = /^[+-]/.test(s) ? s[0] : n == null ? "" : n > 0 ? "+" : n < 0 ? "-" : "";
    const cls = sign === "+" ? "up" : sign === "-" ? "down" : "flat";
    return `<span class="gui-delta ${cls}">${giInline(s)}</span>`;
  }

  /** 表单类组件：值存在消息自己身上（m.genuiState），重建气泡也不丢。 */
  function giField(node, seen) {
    const key = giText(node.id).replace(/[^\w-]/g, "").slice(0, 40) || `f${seen.fields.length}`;
    seen.fields.push(key);
    const t = giText(node.type).toLowerCase();
    const raw = seen.state[key];
    const val = raw == null ? giText(node.value ?? "") : giText(raw);
    const ph = node.placeholder ? ` placeholder="${esc(node.placeholder)}"` : "";
    const attrs = ` data-gui-field="${esc(key)}"`;
    const label = node.label && t !== "checkbox" && t !== "switch"
      ? giTag("span", "gui-field-l", giInline(node.label)) : "";

    if (t === "textarea") return giTag("label", "gui-field", label + `<textarea class="gui-input" rows="${Math.max(2, Math.min(8, Math.round(giNum(node.rows) ?? 3)))}"${attrs}${ph}>${esc(val)}</textarea>`);
    if (t === "select") {
      const opts = (Array.isArray(node.options) ? node.options : []).map((o) => {
        const v = giOne(o, "value", giOne(o, "label"));
        return `<option value="${esc(v)}"${v === val ? " selected" : ""}>${esc(giOne(o, "label", v))}</option>`;
      }).join("");
      return giTag("label", "gui-field", label + `<select class="gui-input"${attrs}>${opts}</select>`);
    }
    if (t === "checkbox" || t === "switch") {
      const on = raw == null ? node.checked === true : val === "true";
      return `<label class="gui-check${t === "switch" ? " sw" : ""}">`
        + `<input type="checkbox"${attrs}${on ? " checked" : ""}><span>${giInline(node.label ?? node.text ?? "")}</span></label>`;
    }
    if (t === "radio") {
      const group = giText(node.group).replace(/[^\w-]/g, "").slice(0, 40) || key;
      const cur = raw == null ? giText(node.value ?? "") : val;
      const opts = (Array.isArray(node.options) ? node.options : []).map((o, i) => {
        const v = giOne(o, "value", giOne(o, "label", String(i)));
        return `<label class="gui-radio"><input type="radio" name="${esc(seen.uid + group)}" value="${esc(v)}"`
          + ` data-gui-field="${esc(group)}"${v === cur ? " checked" : ""}><span>${giInline(giOne(o, "label", v))}</span></label>`;
      }).join("");
      return giTag("div", "gui-field", (node.label ? giTag("span", "gui-field-l", giInline(node.label)) : "") + opts);
    }
    return giTag("label", "gui-field", label
      + `<input class="gui-input" type="${esc(giText(node.inputType || "text"))}"${attrs} value="${esc(val)}"${ph}>`);
  }

  /** 柱状 / 折线 / 环形都用内联 SVG 画：气泡宽度够摆 6–8 个点，够用且零依赖。 */
  function giChart(node) {
    const kind = giText(node.kind || "bars").toLowerCase();
    const data = (Array.isArray(node.data) ? node.data : []).filter((d) => d && typeof d === "object").slice(0, 12);
    if (!data.length) return "";
    const vals = data.map((d) => giNum(d.value) ?? 0);
    const max = Math.max(...vals, 1);
    const W = 320;
    const title = node.title ? giTag("div", "gui-chart-t", giInline(node.title)) : "";
    const labels = (xs) => (Array.isArray(xs) && xs.length
      ? `<div class="gui-chart-x">${data.map((d) => giTag("span", "", esc(giText(d.label).slice(0, 8)))).join("")}</div>` : "");
    if (kind === "donut") {
      const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
      let at = 0;
      const segs = data.map((d, i) => {
        const len = (Math.max(0, vals[i]) / total) * 100;
        const seg = `<circle class="sg${i % 6}" cx="18" cy="18" r="15.9155" stroke-dasharray="${len.toFixed(2)} ${(100 - len).toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}"></circle>`;
        at += len;
        return seg;
      }).join("");
      const legend = data.map((d, i) => `<span class="gui-lg"><i class="sg${i % 6}"></i>${giInline(d.label)} <b>${esc(giText(d.value))}</b></span>`).join("");
      return giTag("div", "gui-chart", title
        + `<div class="gui-donut"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="bg" cx="18" cy="18" r="15.9155"></circle>${segs}</svg>`
        + giTag("div", "gui-legend", legend) + "</div>");
    }
    if (kind === "line") {
      const step = data.length > 1 ? W / (data.length - 1) : W;
      const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(78 - (v / max) * 70).toFixed(1)}`);
      const dots = pts.map((p) => {
        const [x, y] = p.split(",");
        return `<circle cx="${x}" cy="${y}" r="2.4"></circle>`;
      }).join("");
      return giTag("div", "gui-chart", title
        + `<svg viewBox="0 0 ${W} 96" class="gui-chart-svg" role="img" aria-label="${esc(giText(node.title || "折线图"))}">`
        + `<polyline points="${pts.join(" ")}"></polyline>${dots}</svg>` + labels(data));
    }
    const bw = W / data.length;
    const bars = data.map((d, i) => {
      const h = Math.max(2, Math.round((Math.max(0, vals[i]) / max) * 70));
      return `<rect x="${(i * bw + bw * 0.18).toFixed(1)}" y="${78 - h}" width="${(bw * 0.64).toFixed(1)}" height="${h}" rx="2"></rect>`;
    }).join("");
    const ticks = data.map((d, i) => `<text x="${(i * bw + bw / 2).toFixed(1)}" y="92" text-anchor="middle">${esc(giText(d.label).slice(0, 6))}</text>`).join("");
    return giTag("div", "gui-chart", title
      + `<svg viewBox="0 0 ${W} 96" class="gui-chart-svg" role="img" aria-label="${esc(giText(node.title || "柱状图"))}">${bars}${ticks}</svg>`);
  }

  const GENUI_DRAW = {
    text: (n) => giTag("p", "gui-text", giInline(n.content ?? n.text ?? "")),
    card: (n, d, s) => giTag("div", "gui-card",
      (n.title ? giTag("div", "gui-card-t", giInline(n.title)) : "") + giKids(n, d, s)),
    hero: (n, d, s) => giTag("div", "gui-hero",
      (n.title ? giTag("b", "", giInline(n.title)) : "")
      + (n.desc || n.subtitle ? giTag("span", "", giInline(n.desc ?? n.subtitle)) : "") + giKids(n, d, s)),
    row: (n, d, s) => giTag("div", "gui-row", giKids(n, d, s)),
    col: (n, d, s) => giTag("div", "gui-col", giKids(n, d, s)),
    grid: (n, d, s) => giTag("div", "gui-grid", giKids(n, d, s),
      ` style="--gui-cols:${Math.max(1, Math.min(4, Math.round(giNum(n.cols) ?? 2)))}"`),
    divider: () => '<hr class="gui-hr">',
    spacer: (n) => `<div class="gui-gap" style="height:${Math.max(2, Math.min(48, Math.round(giNum(n.size) ?? 10)))}px"></div>`,
    callout: (n, d, s) => {
      const tone = GENUI_TONES.has(giText(n.tone).toLowerCase()) ? giText(n.tone).toLowerCase() : "info";
      const hasKids = Array.isArray(n.items) || Array.isArray(n.children);
      const body = hasKids ? giKids(n, d, s) : giTag("div", "gui-callout-b", giInline(n.content ?? n.text ?? ""));
      return giTag("div", `gui-callout ${tone}`,
        (n.title ? giTag("b", "", giInline(n.title)) : "") + body);
    },
    badge: (n) => {
      const tone = GENUI_TONES.has(giText(n.tone).toLowerCase()) ? ` ${giText(n.tone).toLowerCase()}` : "";
      return `<span class="gui-badge${tone}">${giInline(n.text ?? n.label ?? n.value ?? "")}</span>`;
    },
    stat: (n) => giTag("div", `gui-stat${giText(n.size).toLowerCase() === "lg" ? " lg" : ""}`,
      giTag("span", "gui-stat-v", giInline(n.value ?? ""))
      + giTag("span", "gui-stat-l", giInline(n.label ?? ""))
      + (n.delta == null ? "" : giDelta(n.delta))),
    progress: (n) => {
      const v = Math.max(0, Math.min(100, Math.round(giNum(n.value) ?? 0)));
      if (giText(n.variant).toLowerCase() === "ring") {
        return giTag("div", "gui-prog ring",
          '<svg viewBox="0 0 36 36" class="gui-ring" aria-hidden="true">'
          + '<circle class="bg" cx="18" cy="18" r="15.9155"></circle>'
          + `<circle class="fg" cx="18" cy="18" r="15.9155" stroke-dasharray="${v} 100"></circle></svg>`
          + giTag("span", "gui-prog-t", `${v}%${n.label ? ` · ${giInline(n.label)}` : ""}`));
      }
      return giTag("div", "gui-prog",
        giTag("div", "gui-prog-bar", `<i style="width:${v}%"></i>`)
        + giTag("div", "gui-prog-t", `${giInline(n.label ?? "")}${n.valueLabel ? ` · ${giInline(n.valueLabel)}` : ` · ${v}%`}`));
    },
    list: (n, d, s) => {
      const items = Array.isArray(n.items) ? n.items : [];
      const rows = items.map((it) => {
        if (it && typeof it === "object" && it.type && (GENUI_DRAW[it.type] || GENUI_AS_CODE.has(giText(it.type).toLowerCase()))) {
          return giTag("li", "gui-li block", giRender(it, d + 1, s));
        }
        const o = it && typeof it === "object" ? it : { title: it };
        return giTag("li", "gui-li",
          (o.icon ? giTag("span", "gui-li-i", giInline(o.icon)) : "")
          + giTag("div", "gui-li-b",
            (o.title ? giTag("b", "", giInline(o.title)) : "")
            + (o.desc ?? o.text ? giTag("span", "", giInline(o.desc ?? o.text)) : "")));
      }).join("");
      return giTag("ul", `gui-list${n.rail === false ? "" : " rail"}`, rows);
    },
    table: (n) => {
      const cols = (Array.isArray(n.columns) ? n.columns : []).map((c) => giOne(c, "title", giOne(c, "label", giOne(c, "key"))));
      if (!cols.length) return "";
      const types = (Array.isArray(n.types) ? n.types : []).map((t) => giText(t).toLowerCase());
      const rows = (Array.isArray(n.rows) ? n.rows : []).map((r) => (Array.isArray(r) ? r : cols.map((c) => (r || {})[c])));
      const cell = (v, i, ri) => {
        switch (types[i]) {
          case "index": return esc(String(ri + 1));
          case "num": return esc(giText(v));
          case "delta": return giDelta(v);
          case "bar": return `<span class="gui-mini-bar"><i style="width:${Math.max(0, Math.min(100, Math.round(giNum(v) ?? 0)))}%"></i></span>`;
          case "badge": return `<span class="gui-badge">${giInline(v)}</span>`;
          case "group": return `<b>${giInline(v)}</b>`;
          default: return giInline(v);
        }
      };
      const head = cols.map((c) => `<th>${giInline(c)}</th>`).join("");
      const body = rows.map((r, ri) => `<tr>${cols.map((c, i) => `<td>${cell(r[i], i, ri)}</td>`).join("")}</tr>`).join("");
      const total = Array.isArray(n.total)
        ? `<tfoot><tr>${cols.map((c, i) => `<td>${cell(n.total[i], i, rows.length)}</td>`).join("")}</tr></tfoot>` : "";
      const filter = n.filter
        ? `<div class="gui-filter"><input type="search" data-gui-filter placeholder="筛选这一张表…" aria-label="筛选表格"></div>` : "";
      const copy = n.export
        ? `<button type="button" class="gui-btn" data-gui-copy="${esc([cols.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n"))}">复制表格</button>` : "";
      return giTag("div", "gui-tablewrap", filter + copy
        + `<table class="gui-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${total}</table>`);
    },
    keyvalue: (n) => {
      const pairs = Array.isArray(n.pairs) ? n.pairs : Array.isArray(n.items) ? n.items : [];
      return giTag("dl", "gui-kv", pairs.map((p) => {
        const o = p && typeof p === "object" ? p : { key: "", value: p };
        return `<dt>${giInline(o.key ?? o.label ?? "")}</dt><dd>${giInline(o.value ?? "")}</dd>`;
      }).join(""));
    },
    steps: (n) => {
      const items = Array.isArray(n.steps) ? n.steps : Array.isArray(n.items) ? n.items : [];
      const cur = giNum(n.current);
      return giTag("ol", "gui-steps", items.map((it, i) => {
        const o = it && typeof it === "object" ? it : { title: it };
        const cls = cur != null && i === cur ? " now" : cur != null && i < cur ? " done" : "";
        return `<li class="gui-step${cls}">${giTag("b", "", giInline(o.title ?? ""))}`
          + (o.desc ? giTag("span", "", giInline(o.desc)) : "") + "</li>";
      }).join(""));
    },
    timeline: (n) => giTag("ul", "gui-tl", (Array.isArray(n.items) ? n.items : []).map((it) => {
      const o = it && typeof it === "object" ? it : { title: it };
      return giTag("li", "", (o.time ? giTag("span", "gui-tl-t", giInline(o.time)) : "")
        + giTag("b", "", giInline(o.title ?? "")) + (o.desc ? giTag("span", "gui-tl-d", giInline(o.desc)) : ""));
    }).join("")),
    breadcrumb: (n) => giTag("nav", "gui-crumb",
      (Array.isArray(n.items) ? n.items : []).map((it) => giTag("span", "", giInline(giOne(it, "text", giOne(it, "label")))))
        .join('<i aria-hidden="true">/</i>')),
    "file-tree": (n) => {
      const walk = (items) => giTag("ul", "gui-tree", (Array.isArray(items) ? items : []).map((it) => {
        const o = it && typeof it === "object" ? it : { name: it };
        const dir = giText(o.type).toLowerCase() === "dir" || Array.isArray(o.children);
        return giTag("li", dir ? "dir" : "file", giTag("b", "", giInline(o.name ?? "")) + (dir ? walk(o.children) : ""));
      }).join(""));
      return walk(n.items);
    },
    diff: (n) => giTag("div", "gui-diff", (Array.isArray(n.diffs) ? n.diffs : []).map((d) => {
      const o = d && typeof d === "object" ? d : {};
      const side = (text, cls) => giText(text).split("\n")
        .map((line) => `<span class="gui-dl ${cls}">${esc(line) || "&nbsp;"}</span>`).join("");
      return giTag("div", "gui-diff-one", (o.path ? giTag("div", "gui-diff-p", esc(o.path)) : "")
        + side(o.oldText, "old") + side(o.newText, "new"));
    }).join("")),
    json: (n) => `<pre class="gui-code" data-lang="json"><code>${esc(JSON.stringify(n.value ?? n.data ?? {}, null, 2))}</code></pre>`,
    code: (n) => giCode(n.lang || "", n.code ?? n.content ?? ""),
    chart: (n) => giChart(n),
    avatar: (n) => {
      const src = giText(n.src);
      // data-private-face（v0.212.0）：AI 卡片里的头像节点 —— 开的若是真人头像/肖像，
      // 宿主的隐私展示模式会把它模糊掉（见 le-time-management/src/privacyMask.js）。
      if (/^data:image\//.test(src)) {
        return `<span class="gui-avatar" data-private-face><img src="${esc(src)}" alt="${esc(giText(n.alt ?? n.name ?? ""))}"></span>`;
      }
      return `<span class="gui-avatar" data-private-face>${esc(giText(n.name ?? n.text ?? "").trim().slice(0, 1) || "·")}</span>`;
    },
    button: (n) => {
      const act = giText(n.action);
      return `<button type="button" class="gui-btn${giText(n.variant) === "pri" ? " pri" : ""}"`
        + (act ? ` data-gui-act="${esc(act)}"` : ' disabled title="这一版只认本地动作，需要模型参与的按钮先留空"')
        + `>${giInline(n.label ?? n.text ?? "按钮")}</button>`;
    },
    link: (n) => `<a class="gui-link" href="${esc(giText(n.href) || "#")}" target="_blank" rel="noreferrer noopener">${giInline(n.text ?? n.label ?? n.href ?? "")}</a>`,
    copy: (n) => {
      const text = giText(n.text ?? n.value ?? "");
      return `<button type="button" class="gui-btn" data-gui-copy="${esc(text)}">${giInline(n.label ?? "复制")}</button>`;
    },
    input: (n, d, s) => giField(n, s),
    textarea: (n, d, s) => giField(n, s),
    select: (n, d, s) => giField(n, s),
    checkbox: (n, d, s) => giField(n, s),
    switch: (n, d, s) => giField(n, s),
    radio: (n, d, s) => giField(n, s),
    tabs: (n, d, s) => {
      const tabs = Array.isArray(n.tabs) ? n.tabs : Array.isArray(n.items) ? n.items : [];
      if (!tabs.length) return "";
      const id = `t${s.fields.length}`;
      const bar = tabs.map((t, i) => `<button type="button" class="gui-tab${i === 0 ? " on" : ""}" role="tab"`
        + ` aria-selected="${i === 0}" data-gui-tab="${esc(id)}" data-gui-panel="${esc(`${id}-${i}`)}">`
        + `${giInline(t && typeof t === "object" ? t.label ?? t.title : t ?? "")}</button>`).join("");
      const panels = tabs.map((t, i) => {
        const o = t && typeof t === "object" ? t : { items: [t] };
        return giTag("div", `gui-panel${i === 0 ? " on" : ""}`, giKids(o, d, s),
          ` id="${esc(`${id}-${i}`)}" role="tabpanel"`);
      }).join("");
      return giTag("div", "gui-tabs", giTag("div", "gui-tabbar", bar, ' role="tablist"') + panels);
    },
    accordion: (n, d, s) => giTag("div", "gui-acc", (Array.isArray(n.items) ? n.items : []).map((it) => {
      const o = it && typeof it === "object" ? it : { title: it };
      const open = o.open === true;
      return `<div class="gui-acc-one${open ? " open" : ""}">`
        + `<button type="button" class="gui-acc-h" data-gui-acc aria-expanded="${open}">${giInline(o.title ?? "")}<i aria-hidden="true"></i></button>`
        + giTag("div", "gui-acc-b", giTag("div", "gui-acc-in", giKids(o, d, s))) + "</div>";
    }).join("")),
    quiz: (n) => {
      const qs = Array.isArray(n.questions) ? n.questions : Array.isArray(n.items) ? n.items : [];
      if (!qs.length) return "";
      const body = qs.map((q, qi) => {
        const o = q && typeof q === "object" ? q : { q };
        const key = `q${qi}`;
        const opts = (Array.isArray(o.options) ? o.options : []).map((op, oi) => `<label class="gui-radio">`
          + `<input type="radio" name="${esc(`${n.id || "quiz"}-${key}`)}" value="${oi}" data-gui-quiz="${esc(`${qi}:${oi}`)}">`
          + `<span>${giInline(op)}</span></label>`).join("");
        return giTag("div", `gui-q`, giTag("b", "", giInline(o.q ?? o.question ?? "")) + opts
          + giTag("div", "gui-q-ex", giInline(o.explanation ?? ""), ` data-gui-answer="${Math.round(giNum(o.answer) ?? 0)}" hidden`));
      }).join("");
      return giTag("div", "gui-quiz", body
        + `<button type="button" class="gui-btn pri" data-gui-grade>${giInline(n.submitLabel ?? "对答案")}</button>`);
    },
  };

  /** 一份规格 → HTML 片段。state 用来存表单值（同一气泡重建后还在）。 */
  function genuiHtml(spec, state = {}, uid = "g0") {
    const seen = { n: 0, state, fields: [], uid };
    const items = spec.items.map((it) => giRender(it, 1, seen)).filter(Boolean).join("");
    const head = spec.title
      ? `<div class="gui-bar"><span class="gui-bar-t">${giInline(spec.title)}</span><span class="gui-bar-dot">dsh-ui</span></div>`
      : "";
    return `<div class="aichat-gui" data-gui-block="${esc(uid)}" style="--gui-gap:${spec.gap}px">${head}<div class="gui-body">${items}</div></div>`;
  }

  /** 表单值挂在消息上：saveThread() 会一起落盘，重建气泡不丢。 */
  function genuiState(m) {
    if (!m.genuiState || typeof m.genuiState !== "object" || Array.isArray(m.genuiState)) m.genuiState = {};
    return m.genuiState;
  }

  /** 正文：按占位符把文本段与组件段按原顺序拼起来。 */
  function bodyHtml(m) {
    const text = giText(m.text);
    const blocks = Array.isArray(m.genui) ? m.genui : [];
    // AI 的正文走卡片装帧；用户那侧保持原样（自己写的话不需要被排版）。
    const paint = (s) => (m.role === "assistant" ? cardHtml(s) : md(s));
    if (!blocks.length) return paint(text);
    const rx = new RegExp(`${GENUI_MARK}GUI(\\d+)${GENUI_MARK}`, "g");
    let out = "";
    let last = 0;
    let hit = rx.exec(text);
    while (hit) {
      out += paint(text.slice(last, hit.index));
      const spec = blocks[Number(hit[1])];
      if (spec) out += genuiHtml(spec, genuiState(m), `g${hit[1]}`);
      last = hit.index + hit[0].length;
      hit = rx.exec(text);
    }
    return out + paint(text.slice(last));
  }

  /** 复制：沙箱里 clipboard 可能没有权限，拿不到就明说，不静默失败。 */
  function giCopy(text, btn) {
    const done = () => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = old; }, 1200);
    };
    try {
      if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, () => tide.notify("复制没成功，选中文字手动复制吧"));
        return;
      }
    } catch { /* 没有 clipboard 权限是常态，往下走提示 */ }
    tide.notify("复制没成功，选中文字手动复制吧");
  }

  /** 判卷就地做，不回头找模型。 */
  function giGrade(quiz, btn) {
    if (!quiz) return;
    let right = 0;
    let total = 0;
    let picked = false;
    quiz.querySelectorAll(".gui-q").forEach((q) => {
      total += 1;
      const ex = q.querySelector("[data-gui-answer]");
      const answer = Number(ex ? ex.dataset.guiAnswer : 0);
      const hit = q.querySelector('input[type="radio"]:checked');
      if (hit) picked = true;
      const ok = !!hit && Number(hit.value) === answer;
      if (ok) right += 1;
      q.classList.toggle("ok", ok);
      q.classList.toggle("no", !!hit && !ok);
      if (ex) ex.hidden = false;
    });
    if (!picked) { tide.notify("先选一个答案，再对答案"); return; }
    if (btn) btn.textContent = `答对 ${right} / ${total}`;
  }

  /** 组件里的交互全部本地完成：切页签 / 展开收起 / 筛选 / 填值 / 判卷 / 复制。 */
  function wireGenui(box, m) {
    const root = box.querySelector(".aichat-gui");
    if (!root) return;
    const state = genuiState(m);
    root.querySelectorAll("[data-gui-tab]").forEach((btn) => {
      btn.onclick = () => {
        const wrap = btn.closest(".gui-tabs");
        if (!wrap) return;
        wrap.querySelectorAll("[data-gui-tab]").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("on", on);
          b.setAttribute("aria-selected", String(on));
        });
        wrap.querySelectorAll(".gui-panel").forEach((p) => p.classList.toggle("on", p.id === btn.dataset.guiPanel));
      };
    });
    root.querySelectorAll("[data-gui-acc]").forEach((btn) => {
      btn.onclick = () => {
        const one = btn.closest(".gui-acc-one");
        if (!one) return;
        const open = !one.classList.contains("open");
        one.classList.toggle("open", open);
        btn.setAttribute("aria-expanded", String(open));
      };
    });
    root.querySelectorAll("[data-gui-field]").forEach((el) => {
      const key = el.dataset.guiField;
      const sync = () => {
        if (el.type === "radio") { if (el.checked) state[key] = el.value; return; }
        state[key] = el.type === "checkbox" ? String(el.checked) : el.value;
      };
      sync();                       // 首次挂上时把渲染值记下来，重渲染才接得住
      el.oninput = sync;
      el.onchange = sync;
    });
    root.querySelectorAll("[data-gui-filter]").forEach((input) => {
      const wrap = input.closest(".gui-tablewrap");
      if (!wrap) return;
      const rows = Array.from(wrap.querySelectorAll("tbody tr"));
      input.oninput = () => {
        const q = input.value.trim().toLowerCase();
        rows.forEach((tr) => { tr.hidden = !!q && !String(tr.textContent || "").toLowerCase().includes(q); });
      };
    });
    root.querySelectorAll("[data-gui-copy]").forEach((btn) => {
      btn.onclick = () => giCopy(btn.dataset.guiCopy || "", btn);
    });
    root.querySelectorAll("[data-gui-grade]").forEach((btn) => {
      btn.onclick = () => giGrade(btn.closest(".gui-quiz"), btn);
    });
    // data-gui-act 是留给「要模型参与」的按钮的位子：这一版不接活，规格里写了也还是禁用态。
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
      + "不要 Markdown 标题、表格、emoji、加粗和斜体（真要摆表格就改用下面第 ⑧ 条的围栏，别在正文里画）。",
      "⑦ 数据不够回答时**只写一句**：查不到什么、缺的是哪一项、下一步做哪一件最省事的事。"
      + "不要为此硬凑「现状 / 建议 / 操作」三块，也不要把时间块的原样格式（几点起多少分钟什么分类）抄进正文。",
      "⑧ 遇到这四种情况，除了正文，在正文**之后**、json 建议块之前另起一个 ```dsh-ui 代码块，里面只放一份 JSON 规格，"
      + "界面会把它画成真组件：①要横向对比两组以上数字（几个方案、几项指标）；②有结论或风险要单独框出来；"
      + "③清单超过 6 条；④有趋势或占比要看。规格写法：根节点 {\"title\":\"一句标题\",\"items\":[ … ]}，"
      + "item 的 type 只能取 callout（tone 取 info|success|warning|error，content 写一句话）、"
      + "table（columns + rows，数值列在 types 里标 delta 让界面按正负染色、标 bar 画进度条）、"
      + "list（items 每项 {title, desc}）、keyvalue（pairs 每项 {key, value}）、stat（label + value + delta）、"
      + "progress（label + value 取 0–100）、badge、steps、timeline、card、grid、row、col、text、code、"
      + "chart（kind 取 bars|line|donut，data 每项 {label, value}）。"
      + "最外层最多 8 个组件、整套不超过 200 个节点；字符串里不要出现半角双引号；围栏外不要再把同一批数据讲一遍。"
      + "这些都不合适时就用普通正文，不要硬凑。",
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

  /**
   * 拆回复：dsh-ui 围栏先摘走（正文留占位符），剩下最后一个能解析成建议的 json 块算建议。
   *
   * 顺序很要紧：先摘生成式界面再找建议块。否则一份以数组为根的 dsh-ui 规格会被
   * 建议解析认成「建议列表」（Array.isArray 那条分支），凭空长出一堆写不进去的条目。
   */
  function parseReply(text) {
    const { body: stripped, blocks } = splitGenui(text);
    const chunks = [...stripped.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      let parsed = null;
      try { parsed = JSON.parse(chunks[i][1]); } catch { continue; }
      const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions
        : Array.isArray(parsed) ? parsed : null;
      if (!list) continue;
      const cut = chunks[i].index;
      return {
        body: stripped.slice(0, cut).trimEnd(),
        suggestions: list.map(normalizeSuggestion).filter(Boolean),
        genui: blocks,
      };
    }
    return { body: stripped.trim(), suggestions: [], genui: blocks };
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
      // 正文里的 dsh-ui 占位符（\u0001GUI0\u0001）是给渲染器看的，不是给模型看的 ——
      // 原样发回去等于每轮多塞一串控制字符，模型还会照着抄。
      .map((m) => ({ role: m.role, content: giText(m.text).replace(/\u0001GUI\d+\u0001/g, "").trim() }));
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
      thread.push({
        role: "assistant", text: parsed.body, at: Date.now(),
        suggestions: parsed.suggestions,
        // 规格跟着消息落盘：下次打开这条记录，表格和结论卡还在。
        genui: parsed.genui && parsed.genui.length ? parsed.genui : undefined,
      });
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

  /* 快捷提问行的选中反馈 —— 铁律六要求「单选切换」用滑动选中光，Nephele 的
     SettingChipGroup 也是「一条玻璃分组 + 一块滑行的 glider + 1.1× 外发光」，所以这里
     不再用「点一下按钮底色瞬变」：
       · 光块由宿主 src/selectionGlow.js 的 attachSelectionGlow 画（tide.ui.selectionGlow），
         位移 500ms / cubic-bezier(.34,1.56,.64,1)（过冲 1.3）、尺寸 400ms，与侧栏、
         设置分类、番茄模式同一套参数，减动效时直接落到终态；
       · 行内容不变时**只切 .on**，让光块自己从旧位置滑过去；行内容变了（「带本机数据」
         开关会把整组提问换掉）才重建 —— innerHTML 一换，光块和它的观察者就成了孤儿，
         而且 500ms 的位移动画会被截断。 */
  const CHIP_ON = "button.on";

  function attachChipGlow() {
    chipGlow?.dispose();
    // 老宿主没有这一口时退回瞬变（不抛错：插件要能在旧运行时上照常长出来）。
    chipGlow = tide.ui.selectionGlow?.(ui.shortcuts, { selector: CHIP_ON }) || null;
  }

  function paintChipSelection() {
    const buttons = [...(ui?.shortcuts?.querySelectorAll("[data-chip]") || [])];
    if (!buttons.length) return;
    buttons.forEach((btn, i) => {
      const on = i === activeChip;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    chipGlow?.sync();
  }

  function paintChips() {
    if (!ui?.shortcuts) return;
    const chips = activeChips();
    const signature = chips.map((c) => c.label).join("\u0001");
    if (ui.shortcuts.dataset.chips === signature) { paintChipSelection(); return; }
    ui.shortcuts.dataset.chips = signature;
    // 换了一组提问（「带本机数据」开关会整组换掉）：同一个下标指向的已经不是同一句话了，
    // 于是连选中态一起清掉 —— 重建出来的行永远是「一个都没选」，光块由 attachChipGlow 收起。
    activeChip = -1;
    ui.shortcuts.innerHTML = chips
      .map((c, i) => `<button type="button" data-chip="${i}">${esc(c.label)}</button>`)
      .join("");
    ui.shortcuts.querySelectorAll("[data-chip]").forEach((btn) => {
      btn.onclick = () => {
        if (busy) return;
        const idx = Number(btn.dataset.chip);
        activeChip = idx;
        paintChipSelection();                 // 光块从上一个选项滑过来（宿主负责动画）
        ui.input.value = activeChips()[idx].ask;
        ui.input.oninput();
        ui.input.focus();
      };
    });
    attachChipGlow();                          // 重建后重挂：宿主自己会 rAF 落位，不播位移
  }

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
/* 思考强度下拉栏（v0.175.0 加档位，v0.204.0 改成下拉）自己的钩子。别让它复挂
   .aichat-think —— 那个类是「正在思考…」三个跳动圆点（见下方 .aichat-think i 的
   animation），复用后下拉里一旦出现 <i> 就会冒出三个点。 */
.aichat-effort{display:inline-flex;gap:6px;align-items:center}
.aichat-effort-lab{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 方向箭头：展开 / 收起是同一支箭头连续旋转，不是换字符（铁律七）。 */
.aichat-effort-arrow{flex:none;width:7px;height:7px;margin-top:-3px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg);transition:transform 240ms cubic-bezier(.22,1,.36,1)}
.aichat-effort[aria-expanded="true"] .aichat-effort-arrow{margin-top:2px;transform:rotate(-135deg)}
/* 档位栏的展开与收起（铁律七）：容器高度 0fr → 1fr 连续插值，内容始终留在 DOM 里，
   收起时才置 inert（里面的选项既点不到也 Tab 不到），不用 display:none / hidden 闪没。
   v0.205.0 起它从「输入区里 in-flow 的折叠块」改成**向上展开的浮层**：以前展开那一瞬要在
   布局里长高 139px，正好把上面的对话顶掉（用户原话：「让对话拥有更大的空间…不然看不到
   上面的对话」）。现在定位祖先是 .aichat-bar（见那条 position:relative），bottom:100%
   朝消息流方向长，展开对布局的高度占用是 0，对话区一行都不让。
   浮层不自己去碰安全区四条边：包含块是 .aichat 的 padding box（.aichat 带 transform），
   边距由宿主 .view 负责 —— 与 .aichat-id 弹窗同一口径（铁律四）。 */
.aichat-effort-menu{position:absolute;z-index:9;left:0;right:0;bottom:calc(100% + 6px);isolation:isolate;display:grid;grid-template-rows:0fr;opacity:0;pointer-events:none;transform:translateY(6px);border:1px solid #bc9acd4d;border-radius:14px;background:#30273ef2;box-shadow:0 12px 32px #1c132866;backdrop-filter:blur(14px);transition:grid-template-rows 260ms cubic-bezier(.22,1,.36,1),opacity 220ms ease,transform 260ms cubic-bezier(.22,1,.36,1)}
.aichat-effort-menu.open{grid-template-rows:1fr;opacity:1;pointer-events:auto;transform:none}
.aichat-effort-in{overflow:hidden;min-height:0;display:flex;flex-direction:column;gap:4px;padding:0 8px;transition:padding 260ms cubic-bezier(.22,1,.36,1)}
.aichat-effort-menu.open .aichat-effort-in{padding:8px}
/* 选项：一行「档位 + 它是什么意思」，选中高亮交给宿主的滑动光块（铁律六）。 */
.aichat-lv{position:relative;z-index:1;display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:calc(12px * var(--ui-text-scale,1));line-height:1.5;padding:7px 10px;cursor:pointer}
.aichat-lv small{margin-left:auto;flex:none;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-3,#A9B2BA)}
/* 光块长相与「光块在场时选中项不再画第二层底」——与 .aichat-shortcuts 同一口径。 */
.aichat-effort-menu .selection-glow{border-radius:10px;background:#c9a6d445;border:1px solid #d6b8e199;box-shadow:0 0 14px #cfaae459,0 0 3px #e6d0f22e}
.aichat-effort-menu.has-selection-glow .aichat-lv.on{background:transparent;border-color:transparent;color:#fff}
/* 老宿主没有 tide.ui.selectionGlow 时退回瞬变底色：选中项不能没有反馈。 */
.aichat-effort-menu:not(.has-selection-glow) .aichat-lv.on{background:#bf9ecd33;border-color:#c5a5d34d}
.aichat-log{flex:1;min-height:120px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:2px 2px 0}
/* 消息流那一块（可伸缩）+ 它和输入区之间的分区。类名刻意不叫 .aichat-body —— 那个名字早被
   「单条消息的气泡容器」（.aichat-row > .aichat-body）占了，同名会把 gap/column 一并套到气泡上。 */
.aichat-flow{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1}
.aichat-jump{align-self:center;flex:none;height:26px;padding:0 12px;border-radius:999px;border:1px solid var(--line,#E4DFD6);background:var(--panel,#fff);color:var(--ink-2,#7E8B94);font-family:inherit;font-size:calc(11px * var(--ui-text-scale));cursor:pointer}
.aichat-jump:hover{border-color:var(--deep,#0F4C5C);color:var(--deep,#0F4C5C)}
.aichat-feed{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);flex:1;min-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aichat-empty{border:1px solid var(--line,#E4DFD6);border-radius:14px;padding:18px;background:var(--panel,#fff)}
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
/* 输入区的长相只在下面「深色外壳」那一段定一次（那边一条规则写全）。这里不再留第二份
   .aichat-bar —— 两份同特异性的定义谁后谁赢，改一份忘了另一份就是「改了没反应」的经典坑。 */
.aichat-input{flex:1;min-width:0;resize:none;max-height:96px;min-height:34px;border:1px solid var(--line,#E4DFD6);border-radius:12px;padding:10px 12px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);font:inherit;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.5}
.aichat-input:focus{outline:none;border-color:var(--deep,#0F4C5C)}
.aichat-input:disabled{opacity:.6;cursor:default}
/* 头像与名称（v0.200.0）：这里只管长相，定位 / 开合动画写在下面「深色外壳」那一段。
   拆开是为了避免两份同特异性规则互抢 —— 跟 .aichat-bar 一样的分工。 */
.aichat-id{border:1px solid var(--line,#E4DFD6);border-radius:16px;background:var(--panel,#fff);padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.aichat-id-head{display:flex;align-items:center;gap:8px;font-size:calc(13.5px * var(--ui-text-scale))}
.aichat-id-head b{flex:1;font-weight:600}
.aichat-id-close{flex:none;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--ink-2,#7E8B94);font:inherit;font-size:calc(20px * var(--ui-text-scale));line-height:1;cursor:pointer}
.aichat-id-close:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 12%,transparent);color:var(--ink,#22303A)}
.aichat-id-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.aichat-id-name{flex:1 1 150px;min-width:0;display:flex;align-items:center;gap:8px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.aichat-id-name input{flex:1;min-width:0;height:30px;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:0 10px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);font:inherit;font-size:calc(12.5px * var(--ui-text-scale))}
.aichat-id-name input:focus{outline:none;border-color:var(--deep,#0F4C5C)}
.aichat-id-tip{margin:0;font-size:calc(11px * var(--ui-text-scale));line-height:1.7;color:var(--ink-3,#A9B2BA)}
button.aichat-avatar{padding:0;cursor:pointer}
.aichat-avatar:disabled{opacity:.5;cursor:default}
/* Nephele 参考布局；色板只作用于插件，不改变宿主主题。
   入场与发光照 NepheleDialog.qml：opacity 300ms OutCubic + scale 0.9→1 400ms OutBack +
   软阴影（它那边是 MultiEffect shadowColor rgba(0,0,0,.15) / blur .75 / offset 8）。
   底部 padding 从 58px 收到 18px —— 58px 是照「浮层底下要留出手影」抄的，但本视图不是浮层，
   快捷提问行下面那一段就白占了 82px（用户：「对话框下面太多空位了」）。 */
.aichat{--ink:#f6f0ff;--ink-2:#c7b6d9;--ink-3:#bba8cf;--panel:#2b243b;--paper:#352d46;--line:#665573;--deep:#bb91ce;--on-deep:#fff;--pad-x:clamp(10px,1.6%,24px);--side-w:260px;position:relative;isolation:isolate;box-sizing:border-box;max-width:none;min-height:0;gap:10px;padding:10px var(--pad-x) 12px;background:radial-gradient(ellipse at 12% 95%,#67516f66,transparent 62%),linear-gradient(120deg,#51435e,#48425c);border-radius:18px;overflow:hidden;font-family:"Microsoft YaHei UI","PingFang SC",sans-serif;box-shadow:0 8px 22px #00000026,0 0 34px #cfa8dd21;animation:aichat-dialog-in 400ms cubic-bezier(.34,1.4,.64,1) both,aichat-dialog-fade 300ms cubic-bezier(.16,1,.3,1) both}
/* 布局改用 grid（v0.235.0）：对话面要能容纳左侧一整列常驻侧栏（见下面 .aichat.side-docked），
   而 flex 列做不到「侧栏跨满整高、其余四段仍在右侧各自成行」。grid-area 的名字把这四段钉死，
   浮层（.aichat-backdrop / .aichat-id / .aichat-ctx）是 absolute，不参与轨道分配。 */
.aichat{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto auto;grid-template-areas:"head" "flow" "bar" "quick"}
.aichat-head{grid-area:head}.aichat-flow{grid-area:flow}.aichat-bar{grid-area:bar}.aichat-shortcuts{grid-area:quick}
@keyframes aichat-dialog-in{from{transform:translate3d(0,20px,0) scale(.9)}to{transform:none}}
@keyframes aichat-dialog-fade{from{opacity:0}to{opacity:1}}
.aichat::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:.55;background-image:radial-gradient(circle at 17% 15%,#e9c9ff 0 1px,transparent 1.5px),radial-gradient(circle at 74% 33%,#e9c9ff 0 1px,transparent 1.5px),radial-gradient(circle at 85% 56%,#e9c9ff 0 1px,transparent 1.5px),radial-gradient(circle at 32% 18%,#bb80d2 0 .7px,transparent 1.2px),radial-gradient(circle at 66% 26%,#dc9bea 0 .8px,transparent 1.3px),radial-gradient(circle at 73% 90%,#e9c9ff 0 1px,transparent 1.5px);background-size:100% 100%,100% 100%,100% 100%,193px 157px,271px 211px,100% 100%}
.aichat [hidden]{display:none!important}
.aichat-head{flex:none;gap:8px;min-height:26px}
.aichat-log{padding:6px 2px 0}
.aichat-menu{position:relative;z-index:6;width:26px;height:26px;border:0;background:transparent;color:#e0cfea;padding:0;cursor:pointer;margin-right:auto;transition:transform 500ms cubic-bezier(.22,1,.36,1)}
.aichat-menu::before{content:"";position:absolute;inset:-18px;pointer-events:none;border-radius:50%;background:radial-gradient(circle,#cfa8dd33,transparent 68%)}
.aichat-menu span{position:absolute;left:5px;top:12px;width:16px;height:2px;border-radius:2px;background:currentColor;transition:transform 500ms cubic-bezier(.22,1,.36,1),width 500ms cubic-bezier(.22,1,.36,1),left 500ms cubic-bezier(.22,1,.36,1),opacity 350ms}
.aichat-menu span:first-child{transform:translateY(-5px)}
.aichat-menu span:nth-child(2){left:3px;width:20px}
.aichat-menu span:last-child{transform:translateY(5px)}
.aichat-menu:hover,.sidebar-open .aichat-menu{color:#d9b3ea}
.sidebar-open .aichat-menu{transform:rotate(180deg)}
.sidebar-open .aichat-menu span:first-child{left:3px;width:20px;transform:rotate(45deg)}
.sidebar-open .aichat-menu span:nth-child(2){opacity:0;transform:scaleX(0)}
.sidebar-open .aichat-menu span:last-child{left:3px;width:20px;transform:rotate(-45deg)}
/* 蒙版（v0.200.0）：以前它只是个「点得到」的空层，没有任何视觉。现在它得真的暗下去 ——
   头像与名称弹窗弹出时，背后的对话界面必须被压暗，否则这块弹窗看着仍像页面里的一张卡。 */
.aichat-backdrop{position:absolute;inset:0;z-index:4;background:#1c13286b;backdrop-filter:blur(3px);opacity:0;visibility:hidden;pointer-events:none;transition:opacity 200ms ease,visibility 0s 220ms}
.sidebar-open .aichat-backdrop,.id-open .aichat-backdrop{opacity:1;visibility:visible;pointer-events:auto;transition:opacity 220ms ease,visibility 0s}
/* 弹窗（头像与名称）要盖过 z-index:6 的汉堡按钮：弹出期间背后那层不该还点得着 */
.id-open .aichat-backdrop{z-index:7}
/* box-sizing 是必须的（v0.235.0 修）：这条规则只有 width:100% / min(320px,…)，没有 border-box，
   于是那 14px padding 与 1px 边框会往外再加 30px —— 常驻态下它比给它的 260px 网格列宽 30px，
   正好压住右侧对话区左边 16px（实测：浮层右缘 368 / 对话列左缘 352，首批字符被盖）。
   抽屉态同样虚胖 30px，calc(100% - 32px) 也就不是写这句话时想的意思了。 */
.aichat-sidebar{position:absolute;box-sizing:border-box;z-index:5;left:var(--pad-x);top:52px;width:min(320px,calc(100% - 32px));max-height:min(520px,calc(100% - 74px));display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid #bc9acd4d;border-radius:16px;background:#30273eee;box-shadow:0 8px 28px #1c132866;backdrop-filter:blur(16px);transform-origin:top left;opacity:0;transform:scale(.92);visibility:hidden;pointer-events:none;transition:opacity 180ms ease-in,transform 220ms ease-in,visibility 0s 220ms}
.sidebar-open .aichat-sidebar{opacity:1;transform:scale(1);visibility:visible;pointer-events:auto;transition:opacity 220ms cubic-bezier(.22,1,.36,1),transform 320ms cubic-bezier(.34,1.4,.64,1),visibility 0s}
.aichat-sidebar-heading{display:flex;align-items:center;gap:8px;font-size:calc(16px * var(--ui-text-scale,1))}
.aichat-sidebar-heading b{flex:1}
.aichat-sidebar-close{width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:#d5c1e2;font:inherit;font-size:calc(23px * var(--ui-text-scale,1));cursor:pointer}
.aichat-sidebar-close:hover{background:#bd99d12b}
.aichat-sidebar-in{display:flex;flex-direction:column;gap:12px;min-height:0;flex:1;width:100%}
.aichat-sidebar-in>.aichat-btn{width:100%;min-height:34px}
.aichat-session-list{min-height:0;overflow-y:auto;border-top:1px solid #b69ac42b;padding-top:8px;display:flex;flex-direction:column;gap:4px;scrollbar-width:thin;scrollbar-color:#a17eb966 transparent}
.aichat-session{flex:none;text-align:left;border:1px solid transparent;border-radius:10px;padding:10px;background:transparent;color:#efe5fa;cursor:pointer;font:inherit;font-size:calc(12px * var(--ui-text-scale,1));transition:background 250ms}
.aichat-session:hover,.aichat-session.on{background:#b58fc32b;border-color:#b58fc32b}
/* 右键菜单指向的那张卡片：菜单是 absolute 浮层，不给锚点的话看不出它要对哪一条动手 */
.aichat-session.ctx-on{background:#b58fc33d;border-color:#d6b8e166;box-shadow:inset 0 0 0 1px #d6b8e133}
.aichat-session:disabled{opacity:.55;cursor:default}
.aichat-session span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aichat-session small{display:block;margin-top:5px;color:#c1afd0;font-size:calc(10.5px * var(--ui-text-scale,1))}
.aichat-history-empty{margin:22px 0;text-align:center;color:#bba8cf;font-size:calc(12px * var(--ui-text-scale,1))}
/* ─── 常驻侧栏（v0.235.0，用户原话：「添加对话侧边栏」）───
   宽度够（>720px）时侧栏不再是一块浮出来的抽屉，而是对话面左侧的一整列 —— 桌面上「点汉堡
   才看得见历史」等于每次切会话都多两次点击。窄屏仍然是抽屉（.side-docked 不加，就回到上面
   那条 absolute 规则），因为手机上一条 260px 的常驻列会把对话挤没。
   列宽用 grid-template-columns 插值收起（Chromium 107+ 支持轨道插值），同时钳掉遮罩 ——
   常驻侧栏不是浮层，不该把对话面压暗。 */
.aichat.side-docked{grid-template-columns:var(--side-w) minmax(0,1fr);grid-template-areas:"side head" "side flow" "side bar" "side quick";column-gap:14px;transition:grid-template-columns 280ms cubic-bezier(.22,1,.36,1)}
.aichat.side-docked:not(.sidebar-open){grid-template-columns:0px minmax(0,1fr)}
.aichat.side-docked .aichat-sidebar{position:relative;left:auto;top:auto;z-index:3;grid-area:side;width:100%;max-height:none;opacity:1;visibility:visible;pointer-events:auto;transform:none;overflow-x:clip;transition:opacity 200ms ease,padding 280ms cubic-bezier(.22,1,.36,1)}
.aichat.side-docked:not(.sidebar-open) .aichat-sidebar{opacity:0;visibility:hidden;pointer-events:none;padding-left:0;padding-right:0}
/* 内层跟着外层列宽走（减 24px = 网格列宽减去侧栏左右各 12px 的内边距），
   拖动改的是 --side-w，内层不必再单独测量：收起时靠外层 overflow-x:clip 裁掉，
   而不是让文字一路重排（重排会「抽动」）。 */
.aichat.side-docked .aichat-sidebar-in{width:calc(var(--side-w) - 24px);flex:none}
.aichat.side-docked .aichat-backdrop{opacity:0;visibility:hidden;pointer-events:none}
.aichat.side-docked .aichat-sidebar-close{display:none}
/* ─── 侧栏宽度拖拽条（v0.243.0，用户原话：「宽度可以自由拖动、拉长或拉大」）───
   拖的是 --side-w，跟 .aichat.side-docked 的第一列共用同一个变量：样式表只留默认 260px，
   用户拖过的值以**内联**变量写回 root（内联天然压过样式表档位）。
   absolute 让它在 grid 里不占轨道 —— .aichat 是 grid 容器，多一个流内子项会另起一行。
   只在「常驻 + 展开」时出现：窄屏抽屉态第一列是 0px，条会贴到左内边距上、拖了也没意义。
   收起 / 展开的过渡期间同样不管：那时列宽在插值，条的 left 会跟着跑一段。 */
.aichat-rail-resizer{display:none}
.aichat.side-docked.sidebar-open .aichat-rail-resizer{display:grid;place-items:center;position:absolute;z-index:6;top:8px;bottom:8px;left:calc(var(--pad-x) + var(--side-w) - 8px);width:16px;padding:0;border:0;border-radius:8px;background:transparent;cursor:col-resize;touch-action:none;transition:background 220ms ease}
.aichat-rail-resizer::before{content:"";width:2px;height:30px;border-radius:2px;background:#c9acd31f;transition:background 220ms ease,height 220ms ease}
.aichat-rail-resizer:hover,.aichat-rail-resizer:focus-visible{background:#b58fc32e;outline:none}
.aichat-rail-resizer:hover::before,.aichat-rail-resizer:focus-visible::before,.aichat.rail-dragging .aichat-rail-resizer::before{background:#e0c4ecb3;height:46px}
/* 拖动期间关掉列宽插值：280ms 的轨道过渡会让条一直追不上指针（感觉像「越拖越远」）。
   必须排在上面 .aichat.side-docked 那条之后 —— 两边特异性相同，比的是先后。 */
.aichat.rail-dragging{transition:none}
/* ─── 会话右键菜单（改名 / 归档 / 删除）───
   位置口径是 absolute（不是 fixed）：包含块是 .aichat 的 padding box，天然落在宿主 .view 的
   四条安全边内，不需要自己去读 --sat/--sab（铁律四）。坐标由 JS 按 .aichat 的矩形夹取。 */
.aichat-ctx{position:absolute;z-index:10;left:0;top:0;min-width:134px;display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid #bc9acd4d;border-radius:12px;background:#30273ef2;box-shadow:0 12px 30px #1c132866;backdrop-filter:blur(14px);transform-origin:top left;opacity:0;transform:scale(.94);visibility:hidden;pointer-events:none;transition:opacity 160ms ease-in,transform 200ms ease-in,visibility 0s 200ms}
.aichat-ctx.open{opacity:1;transform:scale(1);visibility:visible;pointer-events:auto;transition:opacity 180ms cubic-bezier(.22,1,.36,1),transform 240ms cubic-bezier(.34,1.4,.64,1),visibility 0s}
.aichat-ctx button{display:block;width:100%;text-align:left;border:0;border-radius:8px;background:transparent;color:#efe5fa;font:inherit;font-size:calc(12px * var(--ui-text-scale,1));padding:7px 10px;cursor:pointer}
.aichat-ctx button:hover,.aichat-ctx button:focus-visible{background:#b58fc33d;color:#fff}
.aichat-ctx button[data-ctx-act="remove"]{color:#f2a7a0}
.aichat-ctx button[data-ctx-act="remove"]:hover,.aichat-ctx button[data-ctx-act="remove"]:focus-visible{background:#c96b6b3d;color:#ffd9d5}
/* 删除的第一下只是上膛：底色坐实、字加粗，跟上面那条 hover 明显不同层级 ——
   用户得能一眼看出「这一下没删，还得再点一下」。 */
.aichat-ctx button[data-ctx-act="remove"].armed{background:#c96b6b52;color:#ffe3df;font-weight:700}
/* ─── 侧栏里的「已归档」分组 ───
   展开 / 收起都走 0fr ↔ 1fr 连续插值（铁律七），内容始终留在 DOM 里；箭头是同一支连续旋转。 */
.aichat-archive{margin-top:6px;border-top:1px solid #b69ac42b;padding-top:6px}
.aichat-archive-head{display:flex;align-items:center;gap:7px;width:100%;text-align:left;border:0;border-radius:8px;background:transparent;color:#bba8cf;font:inherit;font-size:calc(11px * var(--ui-text-scale,1));padding:6px 8px;cursor:pointer}
.aichat-archive-head:hover{background:#b58fc32b;color:#efe5fa}
.aichat-archive-head i{flex:none;width:7px;height:7px;margin-top:-3px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg);transition:transform 240ms cubic-bezier(.22,1,.36,1)}
.aichat-archive-head[aria-expanded="true"] i{margin-top:2px;transform:rotate(-135deg)}
.aichat-archive-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows 260ms cubic-bezier(.22,1,.36,1)}
.aichat-archive.open .aichat-archive-body{grid-template-rows:1fr}
.aichat-archive-body>div{overflow:hidden;min-height:0;display:flex;flex-direction:column;gap:4px;padding:0}
.aichat-archive.open .aichat-archive-body>div{padding-top:4px}
/* 改名用的行内输入框：与卡片同一块面。宿主 src/styles.css 有一条带 !important 的通用 input
   规则（background + border-radius，特异性 (0,3,1)），所以这里既抬特异性又加 !important ——
   只写一边的话会被它刷成宿主控件底色，在深色侧栏里就是一块刺眼的白框。 */
.aichat .aichat-session-list input.aichat-session-edit.aichat-session-edit:not([type="checkbox"]):not([type="radio"]):not([type="range"]){
  width:100%;box-sizing:border-box;height:auto;padding:9px 10px;font:inherit;font-size:calc(12px * var(--ui-text-scale,1));background:#2b243b!important;border:1px solid #d6b8e199!important;border-radius:10px!important;color:#fff!important;box-shadow:none!important;outline:none!important
}
/* ─── 回答卡片（v0.235.0，用户原话：「颜色多样化一些」）───
   六个色相，都是压在这个深紫气泡（#2b243bd9）上能读清的亮色；左竖条 + 同色晕染底 + 同色
   结论/小标题。色相由内容哈希决定（见 cardHtml），同一条回答重绘不变色。
   这里必须排在 .aichat-msg .lead / .aichat-msg .sec 之后：同特异性比的是先后。 */
.aichat-card{position:relative;margin:0 0 8px;padding:9px 12px 9px 15px;border-radius:13px;background:linear-gradient(135deg,var(--tone-bg,#c0a2ec2e),transparent 78%);border:1px solid var(--tone-line,#c0a2ec4d);box-shadow:0 2px 10px #1c132826}
.aichat-card:last-child{margin-bottom:0}
.aichat-card::before{content:"";position:absolute;left:5px;top:9px;bottom:9px;width:3px;border-radius:3px;background:var(--tone,#c0a2ec)}
.aichat-card[data-tone="0"]{--tone:#c0a2ec;--tone-bg:#c0a2ec2e;--tone-line:#c0a2ec4d}
.aichat-card[data-tone="1"]{--tone:#6fc9d8;--tone-bg:#6fc9d82b;--tone-line:#6fc9d847}
.aichat-card[data-tone="2"]{--tone:#7fd3a8;--tone-bg:#7fd3a829;--tone-line:#7fd3a845}
.aichat-card[data-tone="3"]{--tone:#e9be72;--tone-bg:#e9be722b;--tone-line:#e9be7247}
.aichat-card[data-tone="4"]{--tone:#f09c93;--tone-bg:#f09c932b;--tone-line:#f09c9347}
.aichat-card[data-tone="5"]{--tone:#9ec5ea;--tone-bg:#9ec5ea2b;--tone-line:#9ec5ea47}
/* 卡片自带左竖条，结论那条就不该再画一根 —— 两根并排会看成缩进错位。 */
.aichat-card .lead{color:var(--tone,#c0a2ec)}
.aichat-card .lead::before{display:none}
.aichat-card .sec{color:var(--tone,#c0a2ec)}
.aichat-card p:last-child,.aichat-card ul:last-child,.aichat-card ol:last-child{margin-bottom:0}
.aichat-chip{background:#ffffff0a;border-color:#c9acd329;color:#e1d2ef;padding:5px 10px}
.aichat-chip.on{background:#c9a6d438;border-color:#d6b8e16b;color:#fff}
.aichat-log{padding:8px 2px 0;min-height:0;scrollbar-width:thin;scrollbar-color:#ae8cbb66 transparent}
.aichat.is-empty .aichat-log{justify-content:safe flex-end;overflow:auto;padding-bottom:0}
/* 空态在深色外壳里也得是一块看得见的「欢迎卡」：以前这里是 border:0/padding:0/background:none，
   整块被抹平后空对话就只剩一片紫底，用户看到的正是「一个空框」。 */
.aichat-empty{flex:none;border:1px solid #b08fc045;border-radius:16px;padding:20px 22px;background:#2b243ba6;margin-bottom:0}
.aichat-empty b{font-size:calc(clamp(25px,4.7vw,38px) * var(--ui-text-scale,1));line-height:1.4;letter-spacing:.01em;margin-bottom:10px;font-weight:700;color:#fcf4ff}
.aichat-empty p{font-size:calc(16px * var(--ui-text-scale,1));line-height:1.6;margin:0;color:#c0abd0}
.aichat-empty .aichat-btn{margin-top:12px}
/* 输入区（本视图的「对话框」本体）：不再往对话框里套第二个带边框的小框 —— 外壳与输入区之间
   不留第二层圆角边界，只用一条内嵌发丝线把「说」的区域从消息流里分出来；聚焦时那条线亮起并
   按 Nephele SettingChipGroup 的 pulse（0.62↔0.38、1500ms InOutSine）呼吸。
   .aichat-bar 这个类名与 :focus-within 的写法是宿主测试（scripts/test-ai-chat.mjs）认的钩子，
   改名要同步改测试，所以长相换了、名字保留。
   v0.205.0：垂直方向的 padding 与 gap 一起收紧（16px/12px → 8px/6px），并把档位浮层的定位
   祖先交给它（position:relative）—— 省下的每一像素都还给上面的消息流。 */
/* v0.243.0：这里从「一条顶部分隔线 + 透明底」改成**圆角输入卡**（用户原话：
   「将下面的对话框设置为圆角」）。上一版为了消掉「框里再套一个小框」，把外壳与输入面
   抹成了同一块 —— 代价是整颗输入区在深色底上几乎没有边界，看不出「说」的区域到哪为止。
   现在边界回到 .aichat-bar 自己身上（1px 描边 + 18px 圆角 + 半透明底 + 一点内阴影），
   里面那颗 textarea 仍然彻底透明、圆角归零（见下一条 !important 规则），所以还是
   **一层**边界，不是又套了个小框。聚焦时的呼吸光继续用 :focus-within 那条。 */
.aichat-bar{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:6px;flex:none;padding:9px 12px;border:1px solid #c9acd33d;border-radius:18px;background:#2b243b8f;box-shadow:0 6px 18px #1c132833,inset 0 1px 0 #e6d2f20f;transition:border-color .3s,box-shadow .3s}
.aichat-bar:focus-within{border-color:#b99cc7;animation:aichat-bar-glow 3s ease-in-out infinite alternate}
@keyframes aichat-bar-glow{from{border-color:#b99cc7;box-shadow:0 0 0 1px #b99cc729,0 0 16px #cfa8dd33}to{border-color:#cdb0d8;box-shadow:0 0 0 1px #cdb0d847,0 0 28px #d9b6ea59}}
.aichat-input{width:100%;box-sizing:border-box;flex:none;border:0;border-radius:0;padding:4px 2px;min-height:34px;background:transparent;font-size:calc(15px * var(--ui-text-scale,1));color:#f5eaff;line-height:1.6}
.aichat-input::placeholder{color:#bca9cf;opacity:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 为什么这里要写一长串 :not() —— 宿主 src/styles.css 有一条全局 !important 规则
   （input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea
   {background:var(--control-bg)!important;border-radius:8px!important}，特异性 (0,3,1)），
   它把页面里每个 textarea 都刷成「实心底 + 8px 圆角」的独立控件。插件样式虽然注入在 <head>
   末尾，但**两边都带 !important 时比的是特异性、不是先后**（宿主自己在 .market-search 那条
   注释里记过这个坑，v0.176.0 真机探针实测），所以光写 background:transparent 拿不回来 ——
   结果就是对话框里那颗输入框自带一个实心小圆角框，正是用户说的「框里再套一个小框」。
   下面这条把选择器抬到 (0,6,1) 才压得住，让整个对话框本体就是输入面。
   同理 :focus-visible 的 outline 也会在输入框上再画一圈（宿主 styles.css:255），一并去掉，
   聚焦反馈交给 .aichat-bar:focus-within 的呼吸光。 */
.aichat .aichat-bar textarea.aichat-input.aichat-input:not([type="checkbox"]):not([type="radio"]):not([type="range"]){
  background:transparent !important;
  border-color:transparent !important;
  border-radius:0 !important;
  box-shadow:none !important;
  outline:none !important;
}
/* 能力开关行（v0.204.0）：以前这两颗胶囊挂在顶栏，用户的原话是「这 2 个按钮弄成到对话框
   那里去」—— 能改本轮行为的东西贴着「说」的地方，顶栏只留对话历史与只读状态。
   能力开关行与工具行并排（v0.205.0）：以前一颗胶囊在输入框上面、一颗在下面，各占一整行 ——
   输入区的一半高度花在「两行小控件」上。现在输入框在最上、这两行合成一行摆在它下面，
   窄屏放不下时 .aichat-compose-row 仍然自己换行，不顶出横向滚动。
   但 chips 必须 flex:1 1 auto、tools 必须 flex:none：不这么写的话 tools 里那颗模型按钮会把
   行宽撑爆，flex-wrap 就把两行拆开（真应用探针实测 row_children_same_line=0），白忙一场。 */
.aichat-compose-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.aichat-compose-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1 1 auto;min-width:0}
.aichat-compose-chips .aichat-chip{padding:4px 10px}
.aichat-lv{color:#e6d8f4}
.aichat-lv:hover{background:#bf9ecd33;border-color:#c5a5d34d}
.aichat-lv small{color:#bba8cf}
.aichat-lv b{font-weight:600}
.aichat-compose-tools{display:flex;align-items:center;gap:8px;flex:none;min-width:0;margin-left:auto}
.aichat-personalize{display:grid;place-items:center;flex:none;width:30px;height:30px;border:1px solid #a588b03d;border-radius:9px;color:#c8b2d8;background:transparent;cursor:pointer}
.aichat-personalize svg{width:18px;height:18px}
.aichat-model{margin-left:auto;max-width:65%;font:inherit;font-size:calc(12px * var(--ui-text-scale,1));padding:6px 16px;border:1px solid #dac0e485;color:#fff;background:linear-gradient(120deg,#b492c1aa,#856794aa);box-shadow:0 0 18px #d6b3e043;border-radius:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aichat-send{display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:50%;padding:0;background:#cfa8dd;color:#fff;flex:none;cursor:pointer}
.aichat-send svg{width:21px;height:21px}
.aichat-send:disabled{opacity:.45;cursor:default}
.aichat-send.is-blocked{background:#8d7b97}
.aichat-send.is-blocked:hover{background:#a28fae}
.aichat-shortcuts{position:relative;isolation:isolate;display:flex;flex:0 1 auto;min-width:0;gap:3px;padding:3px;background:#c1a8ca15;border:1px solid #c6acd51f;border-radius:13px;overflow-x:auto;scrollbar-width:none;box-shadow:inset 0 1px 4px #1c132833}
.aichat-shortcuts button{position:relative;z-index:1;flex:1 0 auto;font:inherit;font-size:calc(11.5px * var(--ui-text-scale,1));padding:5px 10px;color:#ddd0ef;border:1px solid transparent;border-radius:10px;background:transparent;cursor:pointer;transition:color .3s,background .25s,border-color .25s,box-shadow .25s}
.aichat-shortcuts button:hover{background:#bf9ecd4d;border-color:#c5a5d366;box-shadow:0 0 12px #cfaae42e;color:#fff}
/* 选中光块 = Nephele SettingChipGroup 的 glider：α0.35 强调色底 + 1px 描边 + 一圈外发光
   （它那边是 1.1× 的模糊矩形，CSS 里用低 α 的大模糊 box-shadow 等价）。
   位移 500ms cubic-bezier(.34,1.56,.64,1)（过冲 1.3）与尺寸 400ms 由宿主
   tide.ui.selectionGlow（src/selectionGlow.js）负责，这里只管长相。
   光块在场时被选中的按钮不能再画第二层底，否则两层叠加会糊成实心块。 */
.aichat-shortcuts .selection-glow{border-radius:10px;background:#c9a6d445;border:1px solid #d6b8e199;box-shadow:0 0 14px #cfaae459,0 0 3px #e6d0f22e}
.aichat-shortcuts.has-selection-glow button.on{background:transparent;border-color:transparent;box-shadow:none;color:#fff}
.aichat-feed{font-size:calc(10.5px * var(--ui-text-scale,1));opacity:.85;flex:1;min-width:0}
.aichat button:focus-visible{outline:2px solid #ead3f4;outline-offset:3px}
.aichat-menu:focus-visible{outline:2px solid #ead3f4;outline-offset:3px;border-radius:8px}
.aichat-msg.ai{background:#2b243bd9}
.aichat-msg.me{background:#856294;color:#fff}
/* 居中弹窗（v0.200.0，用户原话：「这个窗口弹出放在中间背后界面蒙版」）。三条口径：
   ① 用 absolute 而不是 fixed —— 包含块是 .aichat 的 padding box（.aichat 带 transform），
      天然落在宿主 .view 的安全区里；fixed 会跳出那四条边、得自己补 --sat/--sab（铁律四）。
   ② 展开与收起都要有动画（同侧栏一套时长曲线），收起时保留可见直到过渡结束，不许 hidden 闪没。
   ③ 宽度 min(520px, 100% - 44px)：窄屏只剩左右 18px 边距，不会顶到屏幕边。 */
.aichat-id{position:absolute;z-index:8;left:50%;top:50%;width:min(520px,calc(100% - 44px));max-height:min(78%,560px);overflow:auto;background:#2b243bfa;box-shadow:0 18px 48px #1c132866,0 0 0 1px #bc9acd3d,0 0 34px #cfa8dd26;transform:translate(-50%,-50%) scale(.92);opacity:0;visibility:hidden;pointer-events:none;transition:opacity 180ms ease-in,transform 220ms ease-in,visibility 0s 220ms}
.id-open .aichat-id{opacity:1;transform:translate(-50%,-50%) scale(1);visibility:visible;pointer-events:auto;transition:opacity 220ms cubic-bezier(.22,1,.36,1),transform 320ms cubic-bezier(.34,1.4,.64,1),visibility 0s}
.aichat-id:focus{outline:none}
@media (max-width:640px){.aichat-id{width:calc(100% - 36px);padding:12px 13px}}
@media (max-height:480px){.aichat-id{max-height:calc(100% - 32px);gap:8px;padding:12px 13px}}
@media (max-width:640px){.aichat-row.me{max-width:90%}.aichat{gap:8px;padding:8px 14px 10px;border-radius:14px}.aichat-empty b{font-size:calc(26px * var(--ui-text-scale,1))}.aichat-empty p{font-size:calc(13px * var(--ui-text-scale,1))}.aichat-empty{padding:16px 16px}.aichat-bar{padding:6px 0 0}.aichat-head{gap:6px}.aichat-chip{font-size:calc(10px * var(--ui-text-scale,1));padding:5px 8px}.aichat-feed{display:none}.aichat-tools{width:100%}.aichat-model{max-width:68%;padding:6px 10px}}
@media (max-height:480px){.aichat{padding-top:6px;padding-bottom:8px}.aichat-empty b{font-size:calc(23px * var(--ui-text-scale,1))}.aichat-empty p{font-size:calc(12px * var(--ui-text-scale,1))}.aichat-feed{display:none}.aichat-empty{padding:12px 14px}}
@media (max-width:640px){.aichat-sidebar{left:14px;top:44px;width:min(320px,calc(100% - 28px));max-height:calc(100% - 66px)}}
@media (max-height:480px){.aichat-sidebar{top:44px;max-height:calc(100% - 60px);gap:8px;padding:12px}}
@media (prefers-reduced-motion:reduce){.aichat-bar,.aichat-menu,.aichat-menu span,.aichat-sidebar,.aichat-id,.aichat-backdrop,.aichat-ctx,.aichat-ctx button,.aichat-archive-body,.aichat-archive-head i,.aichat-session,.aichat-effort-arrow,.aichat-effort-menu,.aichat-effort-in,.aichat-shortcuts button,.aichat-shortcuts .selection-glow{transition:none}.aichat,.aichat-menu,.aichat-bar,.aichat-think i{animation:none}}
/* 常驻侧栏的列宽插值同样归「减少动效」管：那条规则跟上面一份不是同一批选择器（它带 .side-docked），
   所以在白名单之外单独收。 */
@media (prefers-reduced-motion:reduce){.aichat.side-docked,.aichat.side-docked .aichat-sidebar{transition:none}}
/* 应用内「减少动效」开关（data-ui-motion=reduced）与系统开关同级：入场、呼吸光都要停。
   光块的位置换算本身不看动效开关 —— selectionGlow 在 reducedMotion() 下直接跳到终态。
   下拉栏也在这里瞬切：减动效时收起 / 展开不再插值，方向箭头直接到位。 */
:root[data-ui-motion="reduced"] .aichat,:root[data-ui-motion="reduced"] .aichat-menu,:root[data-ui-motion="reduced"] .aichat-bar{animation:none}
:root[data-ui-motion="reduced"] .aichat-shortcuts .selection-glow{transition:none}
:root[data-ui-motion="reduced"] .aichat-effort-arrow,:root[data-ui-motion="reduced"] .aichat-effort-menu,:root[data-ui-motion="reduced"] .aichat-effort-in{transition:none}
:root[data-ui-motion="reduced"] .aichat-ctx,:root[data-ui-motion="reduced"] .aichat-ctx button,:root[data-ui-motion="reduced"] .aichat-archive-body,:root[data-ui-motion="reduced"] .aichat-archive-head i,:root[data-ui-motion="reduced"] .aichat-sidebar,:root[data-ui-motion="reduced"] .aichat.side-docked{transition:none}
/* 窄屏：档位名与说明挤不进一行 —— 只留档位名，说明仍写在每一项的 title 上（读屏与悬停都还在）。 */
@media (max-width:640px){.aichat-compose-row{gap:6px}.aichat-compose-chips{gap:4px}.aichat-compose-tools{gap:6px}.aichat-shortcuts{mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent);-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}.aichat-lv{padding:7px 8px}.aichat-lv small{display:none}}

/* ─── 生成式界面（dsh-ui 围栏，v0.201.0）───
   参考 dsh-genui 的长相：结论卡（callout）+ 对比表（table）+ 清单（list）三段式。
   配色全走宿主主题变量，宽度跟着气泡走 —— 这里不做任何视口定位（安全区由宿主 .view 负责）。 */
/* 气泡本来就是深底（这个视图自带深色外壳，跟宿主明暗无关），所以色板与语义色一律用亮版：
   挂到 [data-theme-mode="dark"] 上，浅色宿主下就会拿到一套压在深底上读不出来的颜色。 */
.aichat-gui{display:flex;flex-direction:column;gap:var(--gui-gap,12px);margin:9px 0 2px;--gui-1:#8FD0E0;--gui-2:#7FD3A8;--gui-3:#E9BE72;--gui-4:#C4B5FD;--gui-5:#F09C93;--gui-6:#9EC5EA}
.aichat-gui:first-child{margin-top:0}
.gui-bar{display:flex;align-items:center;gap:8px;font-size:calc(10.5px * var(--ui-text-scale))}
.gui-bar-t{flex:1;min-width:0;font-weight:600;color:var(--ink-2,#7E8B94);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gui-bar-dot{flex:none;letter-spacing:.06em;border:1px solid var(--line,#E4DFD6);border-radius:999px;padding:1px 7px;color:var(--ink-3,#A9B2BA)}
.gui-body{display:flex;flex-direction:column;gap:var(--gui-gap,12px)}
.gui-text{margin:0;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.75}
.gui-text code,.gui-li code,.gui-table code{font-size:.92em;background:color-mix(in srgb,var(--deep,#0F4C5C) 11%,transparent);border-radius:5px;padding:1px 5px}
.gui-text mark,.gui-li mark{background:color-mix(in srgb,var(--deep,#0F4C5C) 24%,transparent);color:inherit;border-radius:4px;padding:0 3px}
.gui-link{color:var(--deep,#0F4C5C);text-decoration:underline;text-underline-offset:2px}
.gui-card{border:1px solid var(--line,#E4DFD6);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;background:var(--paper,#F7F6F2)}
.gui-card-t{font-size:calc(12.5px * var(--ui-text-scale));font-weight:700}
.gui-hero{display:flex;flex-direction:column;gap:6px}
.gui-hero b{font-size:calc(17px * var(--ui-text-scale))}
.gui-hero span{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-row{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch}
.gui-col{display:flex;flex-direction:column;gap:10px}
.gui-grid{display:grid;grid-template-columns:repeat(var(--gui-cols,2),minmax(0,1fr));gap:10px}
.gui-span{min-width:0}
.gui-hr{border:0;border-top:1px solid var(--line,#E4DFD6);margin:2px 0}
/* 结论卡：四种语气只改左侧色条、标题色与 7% 底色 —— 真正压住可读性的是那个色条 */
.gui-callout{border:1px solid var(--line,#E4DFD6);border-left:3px solid var(--deep,#0F4C5C);border-radius:12px;padding:11px 13px;display:flex;flex-direction:column;gap:8px;font-size:calc(12.5px * var(--ui-text-scale));line-height:1.7;background:color-mix(in srgb,var(--deep,#0F4C5C) 6%,var(--panel,#fff))}
.gui-callout>b{font-size:calc(12.5px * var(--ui-text-scale))}
.gui-callout-b{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
/* 语义色也一律亮版：深底气泡上 #C0392B 这类深色只有 3:1 上下，糊成一团 */
.gui-callout.success{border-color:#7FD3A866;border-left-color:#7FD3A8;background:color-mix(in srgb,#2E7D5B 14%,var(--panel,#fff))}
.gui-callout.success>b{color:#7FD3A8}
.gui-callout.warning{border-color:#E9BE7266;border-left-color:#E9BE72;background:color-mix(in srgb,#B8862B 15%,var(--panel,#fff))}
.gui-callout.warning>b{color:#E9BE72}
.gui-callout.error{border-color:#F09C9366;border-left-color:#F09C93;background:color-mix(in srgb,#C0392B 16%,var(--panel,#fff))}
.gui-callout.error>b{color:#F09C93}
.gui-badge{display:inline-block;border:1px solid var(--line,#E4DFD6);border-radius:999px;padding:1px 8px;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-badge.success{border-color:#7FD3A866;color:#7FD3A8}
.gui-badge.warning{border-color:#E9BE7266;color:#E9BE72}
.gui-badge.error{border-color:#F09C9366;color:#F09C93}
.gui-stat{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid var(--line,#E4DFD6);border-radius:12px;background:var(--paper,#F7F6F2)}
.gui-stat.lg .gui-stat-v{font-size:calc(24px * var(--ui-text-scale))}
.gui-stat-v{font-size:calc(17px * var(--ui-text-scale));font-weight:700;font-variant-numeric:tabular-nums}
.gui-stat-l{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-delta{font-weight:600;font-variant-numeric:tabular-nums}
.gui-delta.up{color:#7FD3A8}
.gui-delta.down{color:#F09C93}
.gui-delta.flat{color:var(--ink-2,#7E8B94)}
.gui-prog{display:flex;flex-direction:column;gap:5px}
.gui-prog-bar{height:8px;border-radius:99px;background:var(--line,#E4DFD6);overflow:hidden}
.gui-prog-bar i{display:block;height:100%;border-radius:99px;background:var(--deep,#0F4C5C)}
.gui-prog-t{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-prog.ring{flex-direction:row;align-items:center;gap:10px}
.gui-ring{width:44px;height:44px;flex:none;transform:rotate(-90deg)}
.gui-ring circle{fill:none;stroke-width:3.4}
.gui-ring .bg{stroke:var(--line,#E4DFD6)}
.gui-ring .fg{stroke:var(--deep,#0F4C5C)}
/* 清单：左侧一条竖线把条目串起来（参考长相），标题主色、说明次级 */
.gui-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.gui-list.rail{position:relative;padding-left:20px}
.gui-list.rail::before{content:"";position:absolute;left:7px;top:7px;bottom:7px;width:1px;background:var(--line,#E4DFD6)}
.gui-li{display:flex;gap:8px;align-items:flex-start;position:relative;font-size:calc(12px * var(--ui-text-scale));line-height:1.65}
.gui-list.rail>.gui-li::before{content:"";position:absolute;left:-17px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--panel,#fff);border:1px solid var(--deep,#0F4C5C)}
.gui-li-i{flex:none}
.gui-li-b{display:flex;flex-direction:column;gap:2px;min-width:0}
.gui-li-b b{font-weight:600}
.gui-li-b span{color:var(--ink-2,#7E8B94);font-size:calc(11.5px * var(--ui-text-scale))}
.gui-li.block{display:block}
/* 对比表：外层横向滚动，窄屏也不撑破气泡；数值列右对齐、等宽数字 */
.gui-tablewrap{display:flex;flex-direction:column;gap:8px;border:1px solid var(--line,#E4DFD6);border-radius:13px;padding:9px 11px;background:color-mix(in srgb,var(--deep,#0F4C5C) 4%,var(--panel,#fff));overflow-x:auto}
.gui-filter input{width:100%;box-sizing:border-box;border:1px solid var(--line,#E4DFD6);border-radius:8px;padding:5px 9px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);font:inherit;font-size:calc(11.5px * var(--ui-text-scale))}
.gui-table{width:100%;border-collapse:collapse;font-size:calc(11.5px * var(--ui-text-scale))}
.gui-table th,.gui-table td{padding:6px 8px;text-align:left;white-space:nowrap;border-bottom:1px solid color-mix(in srgb,var(--line,#E4DFD6) 55%,transparent)}
.gui-table th{color:var(--ink-3,#A9B2BA);font-weight:600;font-size:calc(11px * var(--ui-text-scale))}
.gui-table td{font-variant-numeric:tabular-nums}
.gui-table tbody tr:last-child td{border-bottom:0}
.gui-table tfoot td{border-bottom:0;border-top:1px solid var(--line,#E4DFD6);font-weight:600}
.gui-mini-bar{display:inline-block;width:56px;height:6px;border-radius:99px;background:var(--line,#E4DFD6);vertical-align:middle}
.gui-mini-bar i{display:block;height:100%;border-radius:99px;background:var(--deep,#0F4C5C)}
.gui-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;margin:0;font-size:calc(11.5px * var(--ui-text-scale))}
.gui-kv dt{color:var(--ink-2,#7E8B94)}
.gui-kv dd{margin:0;font-variant-numeric:tabular-nums}
.gui-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;counter-reset:gs}
.gui-step{display:flex;flex-direction:column;gap:2px;padding-left:26px;position:relative;font-size:calc(12px * var(--ui-text-scale))}
.gui-step::before{counter-increment:gs;content:counter(gs);position:absolute;left:0;top:1px;width:18px;height:18px;border-radius:50%;border:1px solid var(--line,#E4DFD6);display:grid;place-items:center;font-size:calc(10px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-step.now::before{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
.gui-step.done::before{background:color-mix(in srgb,#7FD3A8 22%,transparent);border-color:transparent;color:#7FD3A8}
.gui-step span{color:var(--ink-2,#7E8B94);font-size:calc(11.5px * var(--ui-text-scale))}
.gui-tl{list-style:none;margin:0;padding:0 0 0 16px;display:flex;flex-direction:column;gap:10px;position:relative}
.gui-tl::before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:1px;background:var(--line,#E4DFD6)}
.gui-tl li{position:relative;display:flex;flex-direction:column;gap:2px;font-size:calc(12px * var(--ui-text-scale))}
.gui-tl li::before{content:"";position:absolute;left:-15px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--deep,#0F4C5C)}
.gui-tl-t{color:var(--ink-3,#A9B2BA);font-size:calc(10.5px * var(--ui-text-scale))}
.gui-tl-d{color:var(--ink-2,#7E8B94);font-size:calc(11.5px * var(--ui-text-scale))}
.gui-crumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-crumb i{font-style:normal;color:var(--ink-3,#A9B2BA)}
.gui-tree{list-style:none;margin:0;padding:0 0 0 14px;display:flex;flex-direction:column;gap:4px;font-size:calc(11.5px * var(--ui-text-scale))}
.gui-tree li{position:relative}
.gui-tree li::before{content:"";position:absolute;left:-9px;top:9px;width:6px;height:1px;background:var(--line,#E4DFD6)}
.gui-tree b{font-weight:500}
.gui-tree li.dir>b{font-weight:700}
.gui-diff{display:flex;flex-direction:column;gap:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:calc(11px * var(--ui-text-scale))}
.gui-diff-one{border:1px solid var(--line,#E4DFD6);border-radius:11px;overflow:hidden}
.gui-diff-p{padding:5px 10px;background:color-mix(in srgb,var(--deep,#0F4C5C) 9%,transparent);color:var(--ink-2,#7E8B94)}
.gui-dl{display:block;padding:1px 10px;white-space:pre-wrap;word-break:break-word}
.gui-dl.old{background:color-mix(in srgb,#C0392B 22%,transparent);color:#F5B7AE}
.gui-dl.new{background:color-mix(in srgb,#2E7D5B 24%,transparent);color:#A6E3C4}
.gui-code{margin:0;border:1px solid var(--line,#E4DFD6);border-radius:11px;padding:10px 12px;background:var(--paper,#F7F6F2);overflow-x:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:calc(11px * var(--ui-text-scale));line-height:1.65;color:var(--ink,#22303A)}
.gui-code[data-lang]::before{content:attr(data-lang);display:block;margin-bottom:6px;color:var(--ink-3,#A9B2BA);font-size:calc(10px * var(--ui-text-scale));letter-spacing:.06em}
.gui-code code{white-space:pre}
.gui-chart{display:flex;flex-direction:column;gap:6px;border:1px solid var(--line,#E4DFD6);border-radius:13px;padding:10px 12px;background:var(--paper,#F7F6F2)}
.gui-chart-t{font-size:calc(11.5px * var(--ui-text-scale));font-weight:600;color:var(--ink-2,#7E8B94)}
.gui-chart-svg{width:100%;height:auto}
.gui-chart-svg rect{fill:var(--gui-1)}
.gui-chart-svg polyline{fill:none;stroke:var(--gui-1);stroke-width:2;stroke-linejoin:round}
.gui-chart-svg circle{fill:var(--gui-1)}
.gui-chart-svg text{fill:var(--ink-3,#A9B2BA);font-size:9px}
.gui-chart-x{display:flex;justify-content:space-between;gap:6px;font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA)}
.gui-donut{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.gui-donut svg{width:64px;height:64px;flex:none;transform:rotate(-90deg)}
.gui-donut circle{fill:none;stroke-width:3.4}
.gui-donut circle.bg{stroke:var(--line,#E4DFD6)}
.gui-donut .sg0{stroke:var(--gui-1)}
.gui-donut .sg1{stroke:var(--gui-2)}
.gui-donut .sg2{stroke:var(--gui-3)}
.gui-donut .sg3{stroke:var(--gui-4)}
.gui-donut .sg4{stroke:var(--gui-5)}
.gui-donut .sg5{stroke:var(--gui-6)}
.gui-legend{display:flex;flex-direction:column;gap:4px;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-legend b{font-variant-numeric:tabular-nums;color:var(--ink,#22303A)}
.gui-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.gui-legend i.sg0{background:var(--gui-1)}
.gui-legend i.sg1{background:var(--gui-2)}
.gui-legend i.sg2{background:var(--gui-3)}
.gui-legend i.sg3{background:var(--gui-4)}
.gui-legend i.sg4{background:var(--gui-5)}
.gui-legend i.sg5{background:var(--gui-6)}
.gui-tabs{display:flex;flex-direction:column;gap:9px}
.gui-tabbar{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--line,#E4DFD6)}
.gui-tab{border:1px solid transparent;border-radius:9px;padding:5px 11px;background:transparent;color:var(--ink-2,#7E8B94);font:inherit;font-size:calc(11.5px * var(--ui-text-scale));cursor:pointer;transition:background 180ms ease,color 180ms ease,border-color 180ms ease}
.gui-tab.on{background:color-mix(in srgb,var(--deep,#0F4C5C) 14%,transparent);border-color:color-mix(in srgb,var(--deep,#0F4C5C) 34%,transparent);color:var(--ink,#22303A);font-weight:600}
.gui-panel{display:none;flex-direction:column;gap:10px}
.gui-panel.on{display:flex}
/* 折叠：用 grid-template-rows 0fr→1fr 连续插值，展开与收起都是动画（铁律七） */
.gui-acc{display:flex;flex-direction:column;gap:8px}
.gui-acc-one{border:1px solid var(--line,#E4DFD6);border-radius:12px;overflow:hidden;background:var(--paper,#F7F6F2)}
.gui-acc-h{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;border:0;background:transparent;color:inherit;font:inherit;font-size:calc(12px * var(--ui-text-scale));text-align:left;cursor:pointer}
.gui-acc-h i{flex:none;margin-left:auto;width:8px;height:8px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg);transition:transform 240ms ease}
.gui-acc-one.open .gui-acc-h i{transform:rotate(-135deg)}
.gui-acc-b{display:grid;grid-template-rows:0fr;transition:grid-template-rows 260ms cubic-bezier(.22,1,.36,1)}
.gui-acc-one.open .gui-acc-b{grid-template-rows:1fr}
.gui-acc-in{overflow:hidden;min-height:0;padding:0 12px;transition:padding 260ms cubic-bezier(.22,1,.36,1)}
.gui-acc-one.open .gui-acc-in{padding-bottom:12px}
.gui-field{display:flex;flex-direction:column;gap:6px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.gui-field-l{font-weight:600;color:var(--ink,#22303A)}
.gui-input{width:100%;box-sizing:border-box;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:7px 10px;background:var(--paper,#F7F6F2);color:var(--ink,#22303A);font:inherit;font-size:calc(12px * var(--ui-text-scale))}
.gui-input:focus{outline:none;border-color:var(--deep,#0F4C5C)}
.gui-check,.gui-radio{display:flex;align-items:center;gap:7px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink,#22303A);cursor:pointer}
.gui-check input,.gui-radio input{flex:none;accent-color:var(--deep,#0F4C5C)}
.gui-btn{border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:6px 12px;background:var(--panel,#fff);color:var(--ink,#22303A);font:inherit;font-size:calc(11.5px * var(--ui-text-scale));cursor:pointer;transition:border-color 180ms ease,background 180ms ease}
.gui-btn:hover:not(:disabled){border-color:var(--deep,#0F4C5C)}
.gui-btn.pri{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff);font-weight:600}
.gui-btn:disabled{opacity:.5;cursor:default}
.gui-quiz{display:flex;flex-direction:column;gap:11px;border:1px solid var(--line,#E4DFD6);border-radius:13px;padding:11px 13px;background:var(--paper,#F7F6F2)}
.gui-q{display:flex;flex-direction:column;gap:6px;font-size:calc(12px * var(--ui-text-scale))}
.gui-q-ex{border-left:2px solid var(--line,#E4DFD6);padding-left:9px;color:var(--ink-2,#7E8B94);font-size:calc(11.5px * var(--ui-text-scale))}
.gui-q.ok .gui-q-ex{border-left-color:#7FD3A8}
.gui-q.no .gui-q-ex{border-left-color:#F09C93}
@media (max-width:640px){.gui-table th,.gui-table td{padding:5px 6px;font-size:calc(10.5px * var(--ui-text-scale))}.gui-grid{grid-template-columns:minmax(0,1fr)}.gui-callout{padding:10px 11px}}
@media (prefers-reduced-motion:reduce){.gui-acc-h i,.gui-acc-b,.gui-acc-in,.gui-tab,.gui-btn{transition:none}}
:root[data-ui-motion="reduced"] .gui-acc-h i,:root[data-ui-motion="reduced"] .gui-acc-b,:root[data-ui-motion="reduced"] .gui-acc-in,:root[data-ui-motion="reduced"] .gui-tab{transition:none}
`;
    document.head.append(st);
  }

  function renderThread() {
    if (!ui) return;
    const log = ui.log;
    ui.root.classList.toggle("is-empty", !thread.length && !busy);
    paintChips();
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
      : bodyHtml(m);
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
  }

  function wireMessage(box, m) {
    wireGenui(box, m);
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
    // 未配置时发送键**不置灰**：点得动才有回音（会弹「去配置」），置灰等于又回到「点了没反应」。
    ui.send.disabled = busy;
    ui.input.disabled = busy;
    ui.send.classList.toggle("is-blocked", !configured);
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

  /* 思考强度下拉栏（v0.204.0）：四档是「一组只能选一个」，所以选中高亮交给宿主的滑动光块
     （与快捷提问行 CHIP_ON 同一套参数，铁律六），开合两向都走连续过渡（铁律七）。
     它同时是输入区里 in-flow 的折叠容器，不是浮层 —— 不碰安全区四条边。 */
  const THINK_ON = "button.aichat-lv.on";

  /** 把当前档位画到胶囊按钮、下拉栏选项与光块上。开合状态统一由 aria-expanded 表达。 */
  function paintThink() {
    if (!ui?.think) return;
    const level = thinkLevel();
    const lab = ui.think.querySelector(".aichat-effort-lab");
    if (lab) lab.textContent = `思考强度 ${level.label}`;
    ui.think.classList.toggle("on", level.id !== "");
    ui.think.setAttribute("aria-label", `思考强度：${level.label}，展开可选档位`);
    ui.think.title = `${level.hint}。可选：${THINK_CYCLE}`;
    [...(ui.thinkMenu?.querySelectorAll("[data-think-lv]") || [])].forEach((btn) => {
      const on = btn.dataset.thinkLv === level.id;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", String(on));
    });
    thinkGlow?.sync();
  }

  /* 收起：内容留在 DOM 里直到过渡跑完（铁律七），同时立刻 inert —— 收起后里面的选项既点不到、
     也 Tab 不到，而视觉上高度还在往下收。展开时先解除 inert，再让高度插值。 */
  function setThinkMenu(open, restoreFocus = false) {
    if (!ui?.thinkMenu || open === thinkOpen) return;
    thinkOpen = open;
    ui.thinkMenu.classList.toggle("open", open);
    ui.thinkMenu.setAttribute("aria-hidden", String(!open));
    ui.think.setAttribute("aria-expanded", String(open));
    ui.thinkMenu.inert = !open;
    /* 光块落位要等布局定下来再量：展开的那一帧容器还是 0 高、内边距也还在从 0 长到 8px，
       真应用探针实测这一帧量到的 offsetTop 比终态少 8px（换档后重新展开，高亮会贴着选项上沿偏出去）。
       所以等最长的那条过渡（行高与内边距都是 260ms）走完再同步一次。
       用定时器而不是 transitionend：开了减少动效时过渡被砍掉，transitionend 根本不触发。 */
    clearTimeout(thinkGlowTimer);
    if (open) thinkGlowTimer = setTimeout(() => thinkGlow?.sync(), 300);
    if (restoreFocus) ui.think.focus();
  }

  /** 选一档：就地写入并收起，焦点回到胶囊按钮。发送路径只看 thinkEffort，下一句话就按新档发出。 */
  function pickThink(id) {
    if (!isThinkLevel(id)) return;
    thinkEffort = id;
    tide.storage.set(THINK_KEY, id);
    paintThink();
    setThinkMenu(false, true);
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
    railWidth = normalizeRailW(await tide.storage.get(RAIL_W_KEY, null));
    const saved = await tide.storage.get(SESSIONS_KEY, null);
    sessions = Array.isArray(saved?.items) ? saved.items.filter((s) => s && typeof s.id === "string" && typeof s.title === "string" && Array.isArray(s.thread)) : [];
    sessionId = typeof saved?.activeId === "string" && saved.activeId ? saved.activeId : newSessionId();
    // 旧版本只有 thread / draft，首次进入即加入历史，保留原有内容。
    saveThread();
    loaded = true;
  }

  /** 输入框的引导语要跟着「有没有模型」变：未配置时输入框本身就要说明点发送会发生什么。 */
  function paintPlaceholder() {
    if (!ui?.input) return;
    ui.input.placeholder = configured ? "帮我把这周的事理一遍" : "还没配模型 —— 先写也行，点发送会带你去配置";
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
      paintPlaceholder();
      paintBusy();
    }
  }

  async function render(el2) {
    ensureStyle();
    await loadOnce();
    // 切走再回来会整份重建：旧光块和它的 ResizeObserver 挂在旧 DOM 上，必须先撤。
    // （不能只靠 render 的返回值：这个 render 是 async，宿主拿到的 Promise 不是函数。）
    chipGlow?.dispose();
    chipGlow = null;
    el2.innerHTML = "";
    ui = null;

    const root = node(`<div class="aichat">
      <div class="aichat-head">
        <button type="button" class="aichat-menu" data-menu aria-label="展开对话历史" title="对话历史" aria-controls="aichat-history" aria-expanded="false"><span></span><span></span><span></span></button>
        <div class="aichat-feed"></div>
      </div>
      <div class="aichat-backdrop" aria-hidden="true"></div>
      <aside class="aichat-sidebar" id="aichat-history" aria-label="对话历史" aria-hidden="true" inert>
        <div class="aichat-sidebar-in">
          <div class="aichat-sidebar-heading"><b>对话历史</b><button type="button" class="aichat-sidebar-close" aria-label="收起对话历史">×</button></div>
          <button type="button" class="aichat-btn pri" data-clear>＋ 新对话</button>
          <div class="aichat-session-list"></div>
          <button type="button" class="aichat-btn" data-id aria-controls="aichat-id-panel" aria-expanded="false">头像与名称</button>
        </div>
      </aside>
      <button type="button" class="aichat-rail-resizer" role="separator" aria-orientation="vertical" aria-label="拖动调整对话历史宽度" aria-valuemin="200" aria-valuemax="480" aria-valuenow="260" title="拖动调整宽度 · 双击恢复默认 · 聚焦后 ←/→ 微调" tabindex="0"></button>
      <div class="aichat-id" id="aichat-id-panel" role="dialog" aria-modal="true" aria-label="头像与名称" aria-hidden="true" tabindex="-1" inert>
        <div class="aichat-id-head"><b>头像与名称</b><button type="button" class="aichat-id-close" data-id-close aria-label="关闭头像与名称">×</button></div>
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
      <div class="aichat-ctx" id="aichat-ctx" role="menu" aria-label="对话操作" aria-hidden="true" inert>
        <button type="button" role="menuitem" data-ctx-act="rename">重命名</button>
        <button type="button" role="menuitem" data-ctx-act="archive">归档</button>
        <button type="button" role="menuitem" data-ctx-act="remove">删除</button>
      </div>
      <div class="aichat-flow">
        <div class="aichat-log"></div>
        <button type="button" class="aichat-jump" hidden>↓ 有新回复</button>
      </div>
      <div class="aichat-bar">
        <textarea class="aichat-input" rows="1" aria-label="对话内容" placeholder="帮我把这周的事理一遍"></textarea>
        <div class="aichat-compose-row">
          <div class="aichat-compose-chips">
            <button type="button" class="aichat-chip" data-ctx aria-pressed="true">带本机数据</button>
            <button type="button" class="aichat-chip aichat-effort" data-think aria-haspopup="listbox" aria-expanded="false" aria-controls="aichat-effort-menu" title="展开可选档位：自动 → 低 → 中 → 高"><span class="aichat-effort-lab"></span><i class="aichat-effort-arrow" aria-hidden="true"></i></button>
          </div>
          <div class="aichat-compose-tools">
            <button type="button" class="aichat-personalize" data-personalize aria-label="头像与名称" title="头像与名称"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/></svg></button>
            <button type="button" class="aichat-model" title="打开模型设置"></button>
            <button type="button" class="aichat-send" data-send aria-label="发送" title="发送 · Enter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m21 3-6 18-4-8-8-4 18-6Z"/><path d="m11 13 10-10"/></svg></button>
          </div>
        </div>
        <div class="aichat-effort-menu" id="aichat-effort-menu" role="listbox" aria-label="思考强度" aria-hidden="true" inert>
          <div class="aichat-effort-in">${THINK_ITEMS}</div>
        </div>
      </div>
      <div class="aichat-shortcuts" aria-label="快捷提问"></div>
    </div>`).firstChild;
    el2.append(root);

    ui = {
      root,
      sessionList: root.querySelector(".aichat-session-list"),
      shortcuts: root.querySelector(".aichat-shortcuts"),
      body: root.querySelector(".aichat-flow"),
      log: root.querySelector(".aichat-log"),
      input: root.querySelector(".aichat-input"),
      send: root.querySelector("[data-send]"),
      model: root.querySelector(".aichat-model"),
      feed: root.querySelector(".aichat-feed"),
      ctx: root.querySelector("[data-ctx]"),
      think: root.querySelector("[data-think]"),
      thinkMenu: root.querySelector(".aichat-effort-menu"),
      clear: root.querySelector("[data-clear]"),
      jump: root.querySelector(".aichat-jump"),
      idBtn: root.querySelector("[data-id]"),
      idPanel: root.querySelector(".aichat-id"),
    };
    // 插件被停用 / 卸载时把光块的观察者一并撤掉。宿主 Set 里只留一个闭包 ——
    // 每次重绘都挂一次的话，反复切页面会把同一个收尾动作塞进一堆新闭包里。
    if (!disposeHooked) {
      disposeHooked = true;
      tide.ui.onDispose?.(() => { clearTimeout(thinkGlowTimer); chipGlow?.dispose(); chipGlow = null; thinkGlow?.dispose(); thinkGlow = null; });
    }
    ui.model.textContent = configured ? (modelLabel || "已配置模型") : "未配置模型";
    paintPlaceholder();
    ui.ctx.classList.toggle("on", withContext);
    ui.ctx.setAttribute("aria-pressed", String(withContext));
    ui.ctx.title = withContext ? "每次提问都会把本机任务、近三天时间块与插件消息一起发给模型" : "已关闭：只问通用问题，不上传本机数据";
    ui.ctx.onclick = () => setContext(!withContext);
    // 重建的 DOM 天生是收起态：把标志位拉回来，否则第一次点按钮会被当成「收起」而没反应。
    thinkOpen = false;
    // 光块每次都要重挂：root 是整棵重建的 —— 留着上一次的光块，它量的是已经不在文档里的旧选项。
    clearTimeout(thinkGlowTimer);
    thinkGlowTimer = 0;
    thinkGlow?.dispose();
    thinkGlow = tide.ui.selectionGlow?.(ui.thinkMenu, { selector: THINK_ON }) || null;
    paintThink();
    ui.think.onclick = () => setThinkMenu(!thinkOpen);
    /* 选项点击走委托：选项 HTML 是一次拼好的静态串，而「收起后不响应」要靠状态判断，
       绑在容器上比给每个选项挂监听更省，也不会在重建时漏摘。 */
    ui.thinkMenu.onclick = (event) => {
      const btn = event.target?.closest?.("[data-think-lv]");
      if (!btn || !ui.thinkMenu.contains(btn)) return;
      pickThink(btn.dataset.thinkLv);
    };
    // 下拉栏里的上下键：展开后不用鼠标也能换档（Enter / Space 选，Esc 收起）。
    ui.thinkMenu.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const opts = [...ui.thinkMenu.querySelectorAll("[data-think-lv]")];
      if (!opts.length) return;
      const at = opts.indexOf(document.activeElement);
      event.preventDefault();
      const to = event.key === "Home" ? 0
        : event.key === "End" ? opts.length - 1
          : event.key === "ArrowDown" ? (at + 1) % opts.length
            : (at <= 0 ? opts.length - 1 : at - 1);
      opts[to]?.focus();
    });
    /* 点别处（输入框、发送、模型行、页面空白）就收起：它不是浮层，没有「点外面还留着」的理由。 */
    root.addEventListener("click", (event) => {
      if (!thinkOpen) return;
      if (ui.think.contains(event.target) || ui.thinkMenu.contains(event.target)) return;
      setThinkMenu(false);
    });
    ui.model.onclick = () => window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: "ai" } }));
    const menu = root.querySelector("[data-menu]");
    const sidebar = root.querySelector(".aichat-sidebar");
    const backdrop = root.querySelector(".aichat-backdrop");
    const idPanel = ui.idPanel;
    let sidebarOpen = false;
    let idOpen = false;
    /* 弹窗（头像与名称）开着时，背后那层不接受点击与 Tab。蒙版自己不算 —— 它是「点一下关掉」
       的落点，inert 掉就没人接这一下；侧栏关着的时候本来就该是 inert，恢复时要按它自己的
       状态写回，别一把清成 false（那会让收起的侧栏重新变成 Tab 得到、却看不见的幽灵）。
       右键菜单同理：它挂在 root 上，但 inert 由 openCtx/closeCtx 自己管，这里不能插手。 */
    const setBehindInert = (on) => {
      [...root.children].forEach((child) => {
        if (child === idPanel || child === backdrop || child === ctxMenu) return;
        if (on) child.inert = true;
        else child.inert = child === sidebar ? !sidebarOpen : false;
      });
    };
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
    /* 常驻态下「切换会话后收起侧栏」是错的 —— 用户刚就是从那一列里点的，收起等于把菜单抽走。
       只有抽屉态（窄屏）才需要它自己让位。 */
    ui.closeSidebar = () => { if (!root.classList.contains("side-docked")) setSidebar(false); };
    menu.onclick = () => setSidebar(!sidebarOpen);
    root.querySelector(".aichat-sidebar-close").onclick = () => setSidebar(false, true);
    backdrop.onclick = () => { if (idOpen) setIdOpen(false); else setSidebar(false, true); };
    /* ─── 会话右键菜单（v0.235.0）────────────────────────────────────────────
       用户原话「右键对话题可改名、删除或归档」。菜单本身是一块 absolute 小浮层，
       坐标按 .aichat 的矩形夹取 —— 它是 position:relative 的包含块，可视区就是它的 border box
       （overflow:hidden），而 absolute 子元素的偏移原点是包含块的 padding box；.aichat 没有
       边框，两者同界，于是本地坐标 = clientX - rect.left。夹在 [6, 边长 - 自身尺寸 - 6] 之间
       就既不出框，也不必自己去读 --sat/--sab（铁律四只要求视口级浮层让边，这里不是）。 */
    const ctxMenu = root.querySelector(".aichat-ctx");
    let ctxFor = "";        // 菜单当前对着哪条会话
    let ctxReturnTo = null; // 关掉后焦点回哪儿
    let ctxCard = null;     // 菜单当前指着的那张卡片（加高亮 + 改名要拿它换输入框）
    let ctxAt = null;       // 打开时的指针坐标：菜单内容变宽后要按同一个锚点重新夹位置

    const placeCtx = (x, y) => {
      ctxMenu.style.left = "0px";
      ctxMenu.style.top = "0px";
      const box = root.getBoundingClientRect();
      const w = ctxMenu.offsetWidth;
      const h = ctxMenu.offsetHeight;
      ctxMenu.style.left = `${Math.max(6, Math.min(x - box.left, box.width - w - 6))}px`;
      ctxMenu.style.top = `${Math.max(6, Math.min(y - box.top, box.height - h - 6))}px`;
    };

    /* 删除不可恢复，所以走「点两次」而不是 window.confirm()：原生对话框会打断整个
       WebView 的绘制与动画，也和这个界面里所有自绘弹层（侧栏 / 头像与名称）不一致。
       第一次点只把菜单项变成确认态，第二次才真删；菜单一关就复位。 */
    let ctxArm = false;
    const armCtx = (on) => {
      ctxArm = on;
      const btn = ctxMenu.querySelector('[data-ctx-act="remove"]');
      if (!btn) return;
      btn.classList.toggle("armed", on);
      btn.textContent = on ? "确认删除" : "删除";
      // 文案变长会把菜单撑宽，重新夹一次位置，别让它戳出对话面
      if (on && ctxAt) placeCtx(ctxAt.x, ctxAt.y);
    };

    const closeCtx = (restoreFocus = false) => {
      const back = ctxReturnTo;
      if (ctxArm) armCtx(false);
      ctxFor = "";
      ctxReturnTo = null;
      ctxAt = null;
      ctxCard?.classList.remove("ctx-on");   // 卡片可能已被重画成游离节点，classList 照样安全
      ctxCard = null;
      if (!ctxMenu.classList.contains("open")) return;
      ctxMenu.classList.remove("open");
      ctxMenu.setAttribute("aria-hidden", "true");
      ctxMenu.inert = true;
      if (restoreFocus && back?.isConnected) back.focus();
    };
    ctxCloser = closeCtx;

    const openCtx = (cardEl, x, y) => {
      closeCtx();
      ctxFor = cardEl.dataset.session || "";
      ctxReturnTo = cardEl;
      ctxCard = cardEl;
      cardEl.classList.add("ctx-on");
      ctxAt = { x, y };
      ctxMenu.classList.add("open");
      ctxMenu.setAttribute("aria-hidden", "false");
      ctxMenu.inert = false;
      placeCtx(x, y);
      // 焦点进菜单：这样 Esc 与上下键落在菜单自己的处理器上（也能从键盘直接操作）
      ctxMenu.querySelector("[data-ctx-act]")?.focus?.();
    };

    /* 改名走「就地换输入框」而不是再弹一层窗：侧栏本来就窄，弹窗等于把要改的那行盖住。
       回车 / 失焦提交，Esc 放弃，空标题视为放弃 —— 一个手滑不该把会话变成无名氏。 */
    const renameCard = (cardEl) => {
      const id = cardEl.dataset.session || "";
      const title = cardEl.querySelector("span");
      const s = sessions.find((x) => x.id === id);
      if (!s || !title) return;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "aichat-session-edit";
      input.value = s.title || "";
      input.maxLength = 60;
      input.setAttribute("aria-label", "对话名称");
      let done = false;
      const settle = (save) => {
        if (done) return;
        done = true;                     // 失焦与回车常常连着来，只认第一次
        const next = input.value.trim();
        // renameSession() 只在「真的改了」时自己重画；否则这里补一次，把那行换回卡片
        if (!(save && next && renameSession(id, next))) paintSessions();
        ui.sessionList.querySelector(`[data-session="${id}"]`)?.focus?.();
      };
      input.onkeydown = (event) => {
        if (event.key === "Enter") { event.preventDefault(); settle(true); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); settle(false); }
      };
      input.onblur = () => settle(true);
      title.replaceWith(input);
      input.focus();
      input.select();
    };

    /* 事件全委托在列表容器上：卡片是 innerHTML 整批重建的，逐张挂监听每次重画都得重挂。 */
    ui.sessionList.addEventListener("click", (event) => {
      const toggle = event.target?.closest?.("[data-arch-toggle]");
      if (toggle) { archiveOpen = !archiveOpen; paintSessions(); return; }
      const cardEl = event.target?.closest?.(".aichat-session");
      if (!cardEl) return;
      closeCtx();
      if (cardEl.dataset.session === sessionId) return;
      startSession(cardEl.dataset.session);
    });
    ui.sessionList.addEventListener("contextmenu", (event) => {
      const cardEl = event.target?.closest?.(".aichat-session");
      if (!cardEl) { closeCtx(); return; }
      event.preventDefault();
      openCtx(cardEl, event.clientX, event.clientY);
    });
    ctxMenu.addEventListener("click", (event) => {
      const act = event.target?.closest?.("[data-ctx-act]")?.dataset.ctxAct;
      const id = ctxFor;
      const cardEl = ctxCard;            // closeCtx() 会清掉 ctxCard，先把改名要用的那张留下
      if (!act || !id) return;
      // 删除的第一下只是上膛：菜单留在原地、按钮变「确认删除」，第二下才真删
      if (act === "remove" && !ctxArm) { armCtx(true); return; }
      closeCtx();
      if (act === "rename") { if (cardEl?.isConnected) renameCard(cardEl); }
      else if (act === "archive") archiveSession(id);
      else if (act === "remove") deleteSession(id);
    });
    ctxMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCtx(true); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const acts = [...ctxMenu.querySelectorAll("[data-ctx-act]")];
      if (!acts.length) return;
      const at = acts.indexOf(document.activeElement);
      event.preventDefault();
      const to = event.key === "Home" ? 0
        : event.key === "End" ? acts.length - 1
          : event.key === "ArrowDown" ? (at + 1) % acts.length
            : (at <= 0 ? acts.length - 1 : at - 1);
      acts[to]?.focus();
    });
    /* 三种「自己关掉」：点别处、列表滚走（卡片位置已经变了）、窗口变尺寸（夹取用的矩形过期）。
       pointerdown 而不是 click：右键按下时就该收，不必等菜单键抬起。 */
    root.addEventListener("pointerdown", (event) => {
      if (!ctxMenu.classList.contains("open")) return;
      if (ctxMenu.contains(event.target)) return;
      closeCtx();
    });
    ui.sessionList.addEventListener("scroll", () => closeCtx());

    /* ─── 常驻侧栏 vs 抽屉（v0.235.0）─────────────────────────────────────────
       够宽的窗口里侧栏是对话面左边的一整列（列宽 260px ↔ 0px 的插值由 CSS 的
       .aichat.side-docked 决定），窄屏退回抽屉 —— 手机上一列 260px 会把对话挤没。
       这里只做「够不够宽」一个判断，样式全在 CSS。
       用 matchMedia 而不是读视口尺寸属性：它在 Android WebView 里不等于可视区（被
       test-plugin-safe-area 盯着），而这里也根本不需要具体数值。 */
    const dockQuery = window.matchMedia("(min-width:860px)");
    const applyDock = () => {
      const docked = !!dockQuery.matches;
      const was = root.classList.contains("side-docked");
      root.classList.toggle("side-docked", docked);
      // 首次进宽屏：侧栏直接摊开（用户要的是「看得到的一列」，不是又要点一次汉堡）；
      // 之后由用户自己开合，resize 不再擅自摊开。
      if (docked && !was && !sidebarOpen) setSidebar(true);
      // 回到窄屏：抽屉先收起，否则会以展开姿态压住整个对话面
      if (!docked && sidebarOpen) setSidebar(false);
    };
    applyDock();
    dockQuery.addEventListener("change", applyDock);
    const onViewportLayout = () => { applyDock(); closeCtx(); };
    window.addEventListener("resize", onViewportLayout);
    /* ─── 侧栏宽度拖拽（v0.243.0，用户原话：「宽度可以自由拖动、拉长或拉大」）────────
       出口只有一个 applyRailW()：往 root 写/删**内联** --side-w，样式表只留默认 260px
       （内联值天然压过任何档位，用户显式拖过的宽度优先，与宿主 .rail 同口径）。
       缩放口径：插件的指针坐标与 getBoundingClientRect() 都是**视觉 px**，而 offsetWidth 是
       布局 px —— UI 缩放下两者不等（宿主 uiScale 是根节点 zoom，插件读不到那条 API）。这里
       就地用「矩形宽 ÷ offsetWidth」现算比例，位移除过它才跟手。
       落盘只在抬起与键盘改动时写一次：pointermove 每帧都写会把存储刷爆。 */
    const resizer = root.querySelector(".aichat-rail-resizer");
    const railScale = () => {
      const layout = root.offsetWidth || 0;
      if (!layout) return 1;
      return (root.getBoundingClientRect().width || layout) / layout;
    };
    const railNow = () => sidebar.offsetWidth || RAIL_W_DEFAULT;
    const applyRailW = (px, persist = false) => {
      const v = clampRailW(px, root.offsetWidth);
      if (v == null) return null;
      root.style.setProperty("--side-w", `${v}px`);
      resizer.setAttribute("aria-valuenow", String(v));
      if (persist) {
        railWidth = v;
        tide.storage.set(RAIL_W_KEY, v);
      }
      return v;
    };
    const resetRailW = () => {
      root.style.removeProperty("--side-w");
      railWidth = null;
      resizer.setAttribute("aria-valuenow", String(RAIL_W_DEFAULT));
      tide.storage.set(RAIL_W_KEY, null);
    };
    // DOM 是整棵重建的：把用户上次拖的宽度立刻接回来（存储值已在 loadOnce 里过闸门）。
    if (railWidth) applyRailW(railWidth);
    let railDrag = null;
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button > 0) return;
      railDrag = { id: event.pointerId, x: event.clientX, w: railNow(), scale: railScale() || 1 };
      root.classList.add("rail-dragging");
      resizer.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    resizer.addEventListener("pointermove", (event) => {
      if (!railDrag || event.pointerId !== railDrag.id) return;
      applyRailW(railDrag.w + (event.clientX - railDrag.x) / railDrag.scale);
      event.preventDefault();
    });
    /* 抬起时按**实测列宽**落盘：拖动过程中的值可能被夹取过，与真正渲染出来的列宽差一两像素。 */
    const endRailDrag = (event) => {
      if (!railDrag) return;
      if (event?.pointerId != null && event.pointerId !== railDrag.id) return;
      railDrag = null;
      root.classList.remove("rail-dragging");
      applyRailW(railNow(), true);
    };
    resizer.addEventListener("pointerup", endRailDrag);
    resizer.addEventListener("pointercancel", endRailDrag);
    resizer.addEventListener("lostpointercapture", endRailDrag);
    resizer.addEventListener("dblclick", (event) => { event.preventDefault(); resetRailW(); });
    // 键盘微调：separator 可聚焦，←/→ ±16，Home 回默认（与宿主 .rail-resizer 的手感一致）。
    resizer.addEventListener("keydown", (event) => {
      if (event.key === "Home") { event.preventDefault(); resetRailW(); return; }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      applyRailW(railNow() + (event.key === "ArrowRight" ? RAIL_W_STEP : -RAIL_W_STEP), true);
    });
    /* 视口变窄后重放一次：480px 的列在小窗口里会占超过一半，得按新的容器宽重新夹。 */
    window.addEventListener("resize", () => { if (railWidth) applyRailW(railWidth); });
    /* 「头像与名称」= 居中弹窗 + 背后蒙版（v0.200.0）。开合两向都由 root 上的 .id-open 驱动，
       收起时内容留在 DOM 里直到过渡结束，不许 hidden 闪没（铁律七）。 */
    let idReturnTo = null;
    const setIdOpen = (open) => {
      if (open === idOpen) return;
      idOpen = open;
      if (open && sidebarOpen) setSidebar(false);   // 一次只开一个浮层：蒙版只有一块，两个一起开会打架
      if (open && thinkOpen) setThinkMenu(false);   // 弹窗一起，输入区里那份下拉先收起，不然两层焦点打架
      root.classList.toggle("id-open", open);
      idPanel.inert = !open;
      idPanel.setAttribute("aria-hidden", String(!open));
      ui.idBtn.classList.toggle("on", open);
      ui.idBtn.setAttribute("aria-expanded", String(open));
      setBehindInert(open);
      if (open) idPanel.focus();
      else if (idReturnTo?.isConnected) { idReturnTo.focus(); idReturnTo = null; }
    };
    const closeId = () => setIdOpen(false);
    ui.closeId = closeId;
    const toggleId = (from) => {
      if (idOpen) { setIdOpen(false); return; }
      // 从侧栏里点开的，侧栏会随弹窗一起收起：焦点回汉堡键，回已经藏起来的按钮等于丢失焦点
      idReturnTo = from === ui.idBtn ? menu : from;
      setIdOpen(true);
    };
    ui.idBtn.onclick = () => toggleId(ui.idBtn);
    idPanel.querySelector("[data-id-close]").onclick = closeId;
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      // 右键菜单最上（它是「对着某一条的操作」，焦点就在它里面），一次只关一层
      if (ctxMenu.classList.contains("open")) { event.preventDefault(); event.stopPropagation(); closeCtx(true); return; }
      // 下拉栏最轻、弹窗在上、侧栏在下，Esc 一次只关最上面那一层
      const top = thinkOpen ? () => setThinkMenu(false, true)
        : idOpen ? closeId : sidebarOpen ? () => setSidebar(false, true) : null;
      if (!top) return;
      event.preventDefault();
      event.stopPropagation();
      top();
    });
    const personalize = root.querySelector("[data-personalize]");
    personalize.onclick = () => toggleId(personalize);
    ui.jump.onclick = () => {
      ui.log.scrollTop = ui.log.scrollHeight;
      ui.jump.hidden = true;
    };
    ui.clear.onclick = () => {
      if (busy) return;
      startSession();
      tide.notify("已开新对话，之前的记录保留在对话历史中");
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
    // 发送永远要有回音：以前未配置模型时这里直接 return，用户看到的就是「点了没反应」。
    // 现在三条早退路径各给一句话，并且把「去配置」摆在最显眼的位置（提示条上直接给动作）。
    const openAiSettings = () => window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: "ai" } }));
    const send = () => {
      if (busy) { tide.notify("上一条还在回，等它说完再发"); return; }
      if (!configured) { tide.notify("还没配模型，AI 没法回答", { action: openAiSettings, actionLabel: "去配置", ms: 12000 }); return; }
      const q = ui.input.value.trim();
      if (!q) { tide.notify("先写点什么，再按发送"); ui.input.focus(); return; }
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
    return () => {
      // 视图被换掉时先摘干净自己挂出去的三样：窗口 resize、matchMedia、以及 paintSessions 里的收尾钩子
      window.removeEventListener("resize", onViewportLayout);
      dockQuery.removeEventListener("change", applyDock);
      closeCtx();
      ctxCloser = null;
      ui = null;
    };
  }

  tide.ui.registerView({ id: VIEW_ID, title: "AI 对话", icon: "robot", render });
})();
