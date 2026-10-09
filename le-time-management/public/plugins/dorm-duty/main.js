// 轮换值日 —— 内置插件：把「按成员顺序轮换」的公共事务（宿舍值日 / 公区卫生 / 打水…）
// 排成多套互相独立的轮换，到点提醒当班的人。
//
// 四个建模决定（改之前先读）：
//   · **一个插件里放多套轮换**（`groups`）：每套各有成员、周期、起始日、换人记录与提醒设置。
//     互不影响 —— A 组临时换人不改 B 组排班，A 组的提醒时刻与 B 组无关。宿舍和公区就是典型的两套。
//   · 用「轮次」而不是「每天算一个人」：起始日按周期切段，一段一批人。这样「每周轮换」的整周都显示
//     同一批人，提醒也只在每段第一天触发一次 —— 否则会天天催人。
//   · **每轮可以多人一起当班**（`perRound`）：成员顺序不变，按 perRound 人在环上取滑动窗口 ——
//     [A,B,C] 每轮 2 人 → 第 1 轮 A、B；第 2 轮 C、A；第 3 轮 B、C（比硬切块更公平）。
//   · 临时换人按**轮次起始日**记 override，一次换人管一整轮（周期 = 1 时就是当天）。
//     override 的值是**双格式**：单人 = 字符串 id（历史格式，旧版本客户端仍能读）；多人 = id 数组。
//     读的时候统一过 overrideHits()，别端不用关心格式。
//   · 提醒靠自己的 setInterval（宿主没有「定时回调」API）。要扛住宿主两个行为：
//       ① 停用再启用会**重新执行整个模块**，旧实例的 interval 还活着 → 用 storage 里的「代号」
//          让旧实例发现被顶掉后自己 clearInterval 退出，否则会双份提醒；
//       ② 停用（不重启用）只摘注册、interval 仍在 → tick 里查侧栏里本插件入口还在不在，不在就自杀。
//
// 存储（`dorm-duty` 命名空间）：
//   groups   : [{ id, name, startDate, periodDays, perRound, remindEnabled, remindTime, sound,
//                 members, removed, overrides, lastNotified }]
//   activeId : 界面当前选中的那套轮换
//   gen      : 实例代号（防双份提醒）
// 旧版（单套轮换）把数据平铺在 members / config / overrides / removed / lastNotified 上，
// 这里首次加载时自动迁移成一组。**旧键留着不删**：删了就没法回退到旧版本。
// 注意旧键迁移后不会再被写入 —— 旧版本客户端读到的是迁移前的快照，请用新版本。
(function () {
  const DAY_MS = 86400000;
  const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];
  const VIEW_ID = "dorm-duty";
  const UPCOMING = 6;                 // 首页展示的后续轮次数量
  const REMOVED_KEEP = 12;            // 「已移除」可恢复名单上限
  const GROUP_MAX = 12;               // 最多几套轮换（防病态数据把界面撑爆）
  const NAME_MAX = 12;                // 轮换名（宿舍值日 / 公区卫生）
  const MEMBER_MAX = 16;              // 成员名
  const LOCATION_MAX = 12;
  const LOCATION_NAME_MAX = 24;
  const DEFAULT_GROUP_NAME = "值日";
  const PERIOD_CHIPS = [1, 3, 7, 14];
  const PERIOD_LABEL = { 1: "每天", 3: "每 3 天", 7: "每周", 14: "每两周" };
  const PERROUND_CHIPS = [1, 2, 3, 4]; // 「每轮人数」快捷档；更多用旁边的自定义输入

  const state = {
    groups: [],       // 多套轮换；顺序即界面上标签的顺序
    activeId: "",     // 当前选中的那套
    soundPresets: [], // 宿主音效目录（只取一次，供下拉用）
    timer: null,
    gen: 0,
    busy: false,
    membersOrderKey: "",
  };
  let root = null;
  let MY_GEN = 0;

  /* ── 标签右键菜单 ──
     菜单是 position:fixed 浮层，落在宿主 .view 之外，四边得自己让开 Android 的状态栏 /
     导航栏 / 横屏挖孔（铁律四：WebView 里 env() 恒为 0，只能读宿主注入的 --sat 等）。
     step 为空是一级动作表，"import" 是二级「导入成员」的选源组列表。 */
  let tabMenu = null;
  let tabMenuDismissBound = false;
  /** 长按弹过菜单后，浏览器还会补一个 click —— 不吞掉的话长按的同时顺手把组切了。 */
  let longPressed = false;
  const LONG_PRESS_MS = 550;
  const MENU_W = 200;
  const MENU_H = 320;

  /* ── 日期助手：一律用 UTC 零点算差值，避开时区与夏令时偏移（与 cn-holiday 同款） ── */
  const toUTC = (s) => { const [y, m, d] = String(s).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const fromUTC = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => fromUTC(toUTC(s) + n * DAY_MS);
  const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
  const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(toUTC(s)) && fromUTC(toUTC(s)) === s;
  const weekday = (s) => `周${WEEK_CN[new Date(toUTC(s)).getUTCDay()]}`;
  const fmt = (s) => `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`;
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const faIcon = (name) => `<svg class="dd-ico" viewBox="0 0 512 512" aria-hidden="true"><use href="/icons/fontawesome/solid.svg#${name}"></use></svg>`;
  /** 二次确认。宿主把插件代码跑在主窗口里（`new Function("tide", …)`），所以 window.confirm 可用；
      单测沙箱里没有 window，退回「允许」—— 那种环境没有用户点得到，由测试自己塞 window 桩。 */
  const confirmFn = (msg) => {
    try {
      if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(msg);
    } catch { /* 忽略：确认框本身不该把删除流程卡死 */ }
    return true;
  };
  /** 要一个名字。取消 / 拿不到弹窗一律返回 null = 「不改名」，不能把复制流程卡死。
      Android 侧 Tauri 生成的 RustWebChromeClient 实现了 onJsPrompt（弹 AlertDialog + EditText），
      所以 APK 上这个框是真能用的，不只是桌面能用。 */
  const promptFn = (msg, value) => {
    try {
      if (typeof window !== "undefined" && typeof window.prompt === "function") return window.prompt(msg, value);
    } catch { /* 退回「不改名」 */ }
    return null;
  };

  /* ── 归一化：数据损坏不能把插件变成白屏，一律退回可用默认值 ── */
  /** 合法时刻 → "HH:MM"；非法返回 null。
      只校验 /^\d{2}:\d{2}$/ 是不够的："25:99" 能过格式校验，但它换算成分钟是 1599，
      超过一天的最大值 1439 —— 于是 tick() 里「now < 到点」永远成立，提醒被**静默关掉**
      （不报错、不提示，最难查的一类失效）。时 0–23、分 0–59 必须真校验。 */
  function normalizeTime(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  /** 成员 / 已移除名单：丢掉没有 id 的脏数据（否则「移除某人」会命中 undefined）。 */
  function normalizeMembers(raw) {
    return Array.isArray(raw)
      ? raw.filter((m) => m && m.id)
        .map((m) => ({ id: String(m.id), name: String(m.name || "").slice(0, MEMBER_MAX).trim() || "未命名" }))
      : [];
  }
  function normalizeLocations(raw) {
    const names = Array.isArray(raw) ? raw.map((v) => String(v || "").trim().slice(0, LOCATION_NAME_MAX)).filter(Boolean) : [];
    return [...new Set(names)].slice(0, LOCATION_MAX);
  }

  // 暂停段包含首尾日期；合并交叠日期，避免同一天重复扣除。
  function pauseRanges(raw) {
    const ranges = (Array.isArray(raw) ? raw : []).filter(r => r && validDate(r.start) && validDate(r.end) && r.start <= r.end)
      .map(r => ({ start: r.start, end: r.end })).sort((a,b) => a.start.localeCompare(b.start));
    const out = [];
    for (const r of ranges) {
      const last = out[out.length - 1];
      if (last && diffDays(last.end, r.start) <= 1) { if (r.end > last.end) last.end = r.end; }
      else out.push(r);
    }
    return out;
  }
  function pausedAt(g, date) { return pauseRanges(g.pauseRanges).some(r => r.start <= date && date <= r.end); }
  // [起始日, date) 中真正计入轮换的天数。
  function activeDays(g, date) {
    let days = diffDays(g.startDate, date);
    for (const r of pauseRanges(g.pauseRanges)) {
      const a = r.start < g.startDate ? g.startDate : r.start;
      const b = r.end < date ? addDays(r.end, 1) : date;
      if (a < b) days -= diffDays(a, b);
    }
    return days;
  }
  // 有效日序号反解为自然日期，按日期段跳过，可处理多年假期。
  function activeDate(g, index) {
    let date = addDays(g.startDate, index);
    for (const r of pauseRanges(g.pauseRanges)) {
      if (r.end < g.startDate) continue;
      const start = r.start < g.startDate ? g.startDate : r.start;
      if (start > date) break;
      date = addDays(date, diffDays(start, r.end) + 1);
    }
    return date;
  }
  function shiftActive(g, date, days) { return activeDate(g, activeDays(g, date) + days); }
  function cycleEndOf(g, date, period) {
    return activeDate(g, (Math.floor(activeDays(g, date) / period) + 1) * period - 1);
  }

  /** 一套轮换的默认值。 */
  function defaultGroup(today, name) {
    return {
      id: uid("g"),
      name: String(name || "").trim().slice(0, NAME_MAX) || DEFAULT_GROUP_NAME,
      startDate: validDate(today) ? today : tide.util.today(),
      periodDays: 7,
      perRound: 1,
      pauseRanges: [],
      locations: [],
      locationPeriodDays: 7,
      remindEnabled: true,
      remindTime: "08:00",
      sound: "beep",
      members: [],
      removed: [],
      overrides: {},
      lastNotified: "",
    };
  }
  /** 归一化一组。未识别的键原样保留 —— 别端（小程序）不展示 sound，但也不能把它抹掉。 */
  function normalizeGroup(raw, today) {
    const base = defaultGroup(today, null);
    const g = { ...base, ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
    g.id = String(g.id || "").trim() || base.id;
    g.name = String(g.name || "").trim().slice(0, NAME_MAX) || DEFAULT_GROUP_NAME;
    if (!validDate(g.startDate)) g.startDate = base.startDate;
    g.periodDays = Math.min(365, Math.max(1, Math.round(Number(g.periodDays) || 7)));
    g.locationPeriodDays = Math.min(365, Math.max(1, Math.round(Number(g.locationPeriodDays) || 7)));
    g.locations = normalizeLocations(g.locations);
    g.pauseRanges = pauseRanges(g.pauseRanges);
    // 每轮人数：1 = 单人（历史默认）。上限对齐 MEMBER_MAX —— 成员数可能随时变，
    // 这里不能 clamp 到当前成员数（否则移除一个人会偷偷改掉排班规则），计算时用模运算兜底。
    g.perRound = Math.min(MEMBER_MAX, Math.max(1, Math.round(Number(g.perRound) || 1)));
    g.remindTime = normalizeTime(g.remindTime) || "08:00";
    g.remindEnabled = g.remindEnabled !== false;
    g.sound = String(g.sound || "beep");
    g.members = normalizeMembers(g.members);
    g.removed = normalizeMembers(g.removed).slice(0, REMOVED_KEEP);
    g.overrides = g.overrides && typeof g.overrides === "object" && !Array.isArray(g.overrides) ? { ...g.overrides } : {};
    g.lastNotified = String(g.lastNotified || "");
    return g;
  }
  /** 归一化整份组列表。重复 id 会让「切换轮换」指错对象，必须剔掉。 */
  function normalizeGroups(raw, today) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      if (out.length >= GROUP_MAX) break;
      const g = normalizeGroup(item, today);
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push(g);
    }
    return out;
  }
  /** 旧版单套轮换 → 一组。没有任何旧数据时返回空数组（由 load() 决定要不要建默认组）。 */
  function migrateLegacy(legacy, today) {
    const L = legacy && typeof legacy === "object" ? legacy : {};
    const hasAny = (Array.isArray(L.members) && L.members.length > 0)
      || !!L.config
      || !!L.lastNotified
      || (L.overrides && typeof L.overrides === "object" && Object.keys(L.overrides).length > 0);
    if (!hasAny) return [];
    const cfg = L.config && typeof L.config === "object" ? L.config : {};
    return [normalizeGroup({
      name: cfg.dutyName,
      startDate: cfg.startDate,
      periodDays: cfg.periodDays,
      remindEnabled: cfg.remindEnabled,
      remindTime: cfg.remindTime,
      sound: cfg.sound,
      members: L.members,
      removed: L.removed,
      overrides: L.overrides,
      lastNotified: L.lastNotified,
    }, today)];
  }

  /* ── 存储 ── */
  /** 宿主音效目录。真宿主的 `presets()` 是**同步**返回数组（见 src/pluginHost.js），
      这里用 Promise.resolve 兼容同步 / 异步两种实现，再滤掉形状不对的条目 ——
      目录读坏了最多是下拉少几项，不该把整页画崩（与番茄专注同一套写法）。 */
  async function loadSoundPresets() {
    try {
      const list = await Promise.resolve(tide.sound.presets());
      return (Array.isArray(list) ? list : [])
        .filter((p) => p && p.id)
        .map((p) => ({ id: String(p.id), label: String(p.label || p.id) }));
    } catch { return []; }
  }
  async function load() {
    const today = tide.util.today();
    const [groups, activeId, legacyMembers, legacyConfig, legacyOverrides, legacyRemoved, legacyLast, gen] = await Promise.all([
      tide.storage.get("groups", null),
      tide.storage.get("activeId", ""),
      tide.storage.get("members", null),
      tide.storage.get("config", null),
      tide.storage.get("overrides", null),
      tide.storage.get("removed", null),
      tide.storage.get("lastNotified", null),
      tide.storage.get("gen", 0),
    ]);
    let list = normalizeGroups(groups, today);
    let needPersist = false;
    // 只有「新版数据完全不存在」时才看旧键：groups 一旦存在就说明已经迁移过，
    // 不能再被旧快照（旧版本客户端写的）盖回去。
    if (!groups) {
      const migrated = migrateLegacy({ members: legacyMembers, config: legacyConfig, overrides: legacyOverrides, removed: legacyRemoved, lastNotified: legacyLast }, today);
      if (migrated.length) { list = migrated; needPersist = true; }
    }
    if (!list.length) { list = [defaultGroup(today, null)]; needPersist = true; }
    state.groups = list;
    state.activeId = list.some((g) => g.id === activeId) ? String(activeId) : list[0].id;
    state.gen = Number(gen) || 0;
    // 迁移 / 兜底建组要立刻落盘：不写的话「已迁移」和「未迁移」在存储上分不出来，
    // 每次 load 都会重新生成一个随机 id 的默认组，用户在那上面做的设置下一次就没了。
    if (needPersist) await save();
    // 音效目录只在首次（或上次读空）时取一次，不必每次 tick 都问宿主
    if (!state.soundPresets.length) state.soundPresets = await loadSoundPresets();
  }
  async function save() {
    await Promise.all([
      tide.storage.set("groups", state.groups),
      tide.storage.set("activeId", state.activeId),
    ]);
  }

  const activeGroup = () => state.groups.find((g) => g.id === state.activeId) || state.groups[0] || null;
  const periodOf = (g) => Math.max(1, Math.round(Number(g && g.periodDays) || 1));
  const perRoundOf = (g) => Math.max(1, Math.round(Number(g && g.perRound) || 1));

  /* ── 轮换计算（纯函数：只吃传入的那一组，可被探针在任意「今天」下复算） ── */
  /** 某天落在哪一轮：返回该轮起始日；起始日之前返回 null（轮换还没开始）。 */
  function cycleStartOf(g, date) {
    const start = g && g.startDate;
    if (!validDate(start) || !validDate(date)) return null;
    const diff = activeDays(g, date);
    if (diff < 0) return null;
    const p = periodOf(g);
    if (pausedAt(g, date)) return null;
    return activeDate(g, Math.floor(diff / p) * p);
  }
  /** 轮次序号（从 0 起）。 */
  const cycleIndexAt = (g, cycleStart) => Math.floor(activeDays(g, cycleStart) / periodOf(g));
  /** 某一轮的临时换人名单里**真的还在名单里**的人（保序、去重）。
      override 值是双格式：单人 = 字符串 id（历史格式），多人 = id 数组。
      指向已被移除的人要过滤掉 —— 全部失效时返回空数组，由调用方退回正常排班，
      否则界面会显示「已换人 · 原 X」而实际当班的就是 X。 */
  function overrideHits(g, cycleStart) {
    const v = cycleStart ? (g.overrides || {})[cycleStart] : "";
    const ids = Array.isArray(v) ? v : (v ? [v] : []);
    const seen = new Set();
    const hits = [];
    for (const id of ids) {
      const key = String(id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const m = g.members.find((x) => x.id === key);
      if (m) hits.push(m);
    }
    return hits;
  }
  /** 单人视角的换人（兼容旧调用点 / 旧测试）：多人换人时取第一个。 */
  const overrideHit = (g, cycleStart) => overrideHits(g, cycleStart)[0] || null;
  /** 某一轮「正常轮换」该当班的一批人（不看临时换人）：从轮次序号 × perRound 起，
      在成员环上取 perRound 个的滑动窗口。perRound > 成员数时同一人会出现多次，去重保序。 */
  function normalAssignees(g, cycle) {
    if (!cycle || !g.members.length) return [];
    const per = perRoundOf(g);
    const len = g.members.length;
    const idx = cycleIndexAt(g, cycle);
    const out = [];
    for (let i = 0; i < per; i++) out.push(g.members[(idx * per + i) % len]);
    return [...new Map(out.map((m) => [m.id, m])).values()];
  }
  /** 某天的当班人（可能多人）：没成员 / 没开始 → 空数组；有临时换人 → 换上的名单。 */
  function assigneesFor(g, date) {
    const cycle = cycleStartOf(g, date);
    if (!cycle || !g.members.length) return [];
    const ov = overrideHits(g, cycle);
    return ov.length ? ov : normalAssignees(g, cycle);
  }
  /** 编辑列表始终显示真实轮换顺序，拖放的目标位置才与写回位置一致。 */
  function membersInDateOrder(g, date) {
    return g.members.slice();
  }
  const membersOrderKey = (g, date) => `${g.id}:${date}:${assigneesFor(g, date).map((m) => m.id).join(",")}:${locationAt(g, date)}`;
  /** 单人视角（第一个当班人）：提醒判据、「有没有人当班」这类布尔判断用；
      展示一律用 assigneesFor() 的数组，别丢人。 */
  const assigneeFor = (g, date) => assigneesFor(g, date)[0] || null;
  const isCycleStartDay = (g, date) => cycleStartOf(g, date) === date;
  function locationCycleStartOf(g, date) {
    if (!validDate(g.startDate) || !validDate(date)) return null;
    const diff = activeDays(g, date);
    if (diff < 0) return null;
    if (pausedAt(g, date)) return null;
    return activeDate(g, Math.floor(diff / g.locationPeriodDays) * g.locationPeriodDays);
  }
  function locationAt(g, date) {
    if (!g.locations.length) return "";
    const start = locationCycleStartOf(g, date);
    return start ? g.locations[Math.floor(activeDays(g, start) / g.locationPeriodDays) % g.locations.length] : "";
  }
  /** 某组此刻是否该提醒。纯函数 —— 任意「今天 / 当前分钟」都能真跑。
      五个条件缺一不可：开着提醒 + 有成员 + 今天是本轮第一天 + 已过设定时刻 + 这一轮还没提醒过。 */
  function reminderDue(g, today, nowMinutes) {
    if (!g.remindEnabled || !g.members.length) return false;
    if (!isCycleStartDay(g, today)) return false;
    if (g.lastNotified === today) return false;
    const [h, m] = String(g.remindTime).split(":").map(Number);
    return nowMinutes >= h * 60 + m;
  }

  /* ── 定时提醒 ── */
  function stopTimer() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }
  function startTimer() {
    stopTimer();
    state.timer = setInterval(tick, 60 * 1000);
  }
  /** 宿主停用插件时只摘注册，本实例的 interval 还活着 —— 拿侧栏入口在不在当判据。
      启动早期导航还没渲染（没有 nav.nav）时不算停用，避免误自杀。 */
  function navEntryAlive() {
    try {
      const nav = document.querySelector("nav.nav");
      if (!nav) return true;
      return !!nav.querySelector(`[data-view="plug:${VIEW_ID}"]`);
    } catch { return true; }
  }
  async function tick() {
    if (state.busy) return;
    state.busy = true;
    try {
      await load();                                  // 每次全量重读：设置改动立刻生效
      if (state.gen !== MY_GEN) return stopTimer();  // 本实例被重新加载过（停用再启用）→ 退出
      if (!navEntryAlive()) return stopTimer();      // 插件已停用 → 入口消失 → 退出
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const today = tide.util.today();
      const visibleGroup = activeGroup();
      if (root && visibleGroup && state.membersOrderKey !== membersOrderKey(visibleGroup, today)) await paint();
      // 逐组判断：每套轮换有各自的周期、提醒时刻与「已提醒」记录，互不干扰。
      const due = state.groups.filter((g) => reminderDue(g, today, nowMinutes) && assigneesFor(g, today).length);
      if (!due.length) return;
      // 先落盘再提醒：万一还有旧实例同时 tick，也只有一个能抢到写入
      for (const g of due) g.lastNotified = today;
      await tide.storage.set("groups", state.groups);
      for (const g of due) {
        const names = assigneesFor(g, today).map((m) => m.name).join("、");
        const location = locationAt(g, today);
        tide.notify(`「${g.name}」今天轮到 ${names}${location ? ` · 地点：${location}` : ""}`, {
          actionLabel: "查看",
          action: () => tide.util.navigate(`plug:${VIEW_ID}`),
        });
      }
      // 同一次 tick 里多组同时到点时只响一声 —— 叠着播会糊成一片噪音
      playSound(due[0].sound);
    } catch (e) {
      console.warn("dorm-duty: 提醒检查失败", e);
    } finally {
      state.busy = false;
    }
  }
  function playSound(sound) {
    try { tide.sound.play({ sound }); } catch (e) { console.warn("dorm-duty: 提示音播放失败", e); }
  }

  /* ── 样式：配色一律走主题变量，深色模式下自动跟随 ── */
  function ensureStyle() {
    if (document.getElementById("dorm-duty-style")) return;
    const st = document.createElement("style");
    st.id = "dorm-duty-style";
    st.textContent = `
      .dd-wrap{max-width:900px;margin:0 auto;padding-bottom:28px;color:var(--ink,#22303A)}
      .dd-groups{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:12px 0 4px}
      .dd-glist{display:flex;gap:7px;flex-wrap:wrap;min-width:0}
      .dd-gchip{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;border-radius:999px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);cursor:pointer;font-family:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink-2,#59656D);max-width:100%}
      .dd-gchip:hover{border-color:color-mix(in srgb,var(--deep,#0F4C5C) 42%,var(--line,#DCD6CB))}
      .dd-gchip.on{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
      .dd-gchip .dd-gwho{font-style:normal;font-size:calc(11px * var(--ui-text-scale));opacity:.72}
      /* 右键菜单。刻意不钉 top/left/right/bottom —— 坐标由 JS 按视口算好写进 style，
         这样夹取时能把宿主注入的安全区减掉（CSS 里那条边钉死了就没法让了）。 */
      .dd-tabmenu{position:fixed;z-index:60;min-width:180px;max-width:260px;max-height:320px;overflow:auto;display:grid;gap:2px;padding:6px;background:var(--panel,#fff);border:1px solid var(--line,#DCD6CB);border-radius:12px;box-shadow:0 12px 30px rgba(20,30,36,.18)}
      .dd-tabmenu-title{font-size:calc(11.5px * var(--ui-text-scale));font-weight:750;color:var(--ink,#22303A);padding:6px 9px 7px;margin-bottom:4px;border-bottom:1px solid var(--line-soft,#F0ECE5);overflow-wrap:anywhere}
      .dd-tabmenu-hint{font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3,#A1A9AF);line-height:1.6;padding:4px 9px 6px}
      .dd-tabmenu-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:34px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--ink,#22303A);font-family:inherit;font-size:calc(12.5px * var(--ui-text-scale));text-align:left;cursor:pointer;overflow-wrap:anywhere}
      .dd-tabmenu-item:hover{background:color-mix(in srgb,var(--deep,#0F4C5C) 8%,var(--panel,#fff));color:var(--deep,#0F4C5C)}
      .dd-tabmenu-item.danger{color:var(--coral,#D64545)}
      .dd-tabmenu-item.danger:hover{background:color-mix(in srgb,var(--coral,#D64545) 10%,var(--panel,#fff));color:var(--coral,#D64545)}
      .dd-tabmenu-item:disabled{opacity:.45;cursor:not-allowed}
      .dd-tabmenu-sep{height:1px;margin:5px 4px;background:var(--line-soft,#F0ECE5)}
      .dd-tabmenu-n{font-style:normal;flex:none;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3,#A1A9AF)}
      .dd-hero{display:grid;grid-template-columns:1.35fr .65fr;gap:14px;margin:12px 0 14px}
      .dd-card{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:18px;padding:20px 22px}
      .dd-kicker{font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#8B979F);letter-spacing:.24em;text-transform:uppercase;margin-bottom:8px}
      .dd-title{display:flex;align-items:center;gap:7px;font-size:calc(14px * var(--ui-text-scale));font-weight:750;margin-bottom:12px}
      .dd-ico{width:14px;height:14px;flex:none;fill:currentColor;color:var(--deep,#0F4C5C)}
      .dd-who{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .dd-who b{font-size:calc(30px * var(--ui-text-scale));font-weight:800;letter-spacing:.01em}
      /* 多人当班时名字串很长，30px 会把卡片撑成三行 —— 略缩一号 */
      .dd-who b.dd-multi{font-size:calc(21px * var(--ui-text-scale));line-height:1.35}
      .dd-badge{font-size:calc(10.5px * var(--ui-text-scale));font-weight:700;border-radius:999px;padding:4px 9px;background:color-mix(in srgb,var(--mint,#2ec4b6) 14%,var(--panel,#fff));color:var(--deep,#176C60)}
      .dd-badge.warn{background:color-mix(in srgb,var(--sun,#e3a008) 16%,var(--panel,#fff));color:var(--ink,#8A5A10)}
      .dd-range{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.8;margin-top:8px}
      .dd-big{font-size:calc(22px * var(--ui-text-scale));font-weight:750;margin:6px 0}
      .dd-big em{font-style:normal;color:var(--deep,#0F4C5C);font-size:calc(30px * var(--ui-text-scale));margin-right:3px}
      .dd-muted{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.75}
      .dd-note{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A1A9AF);line-height:1.7;margin-top:9px}
      .dd-err{color:#B34747}
      .dd-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
      .dd-btn{height:34px;border-radius:9px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);padding:0 13px;cursor:pointer;font-size:calc(12px * var(--ui-text-scale));font-family:inherit;color:var(--ink,#22303A);display:inline-flex;align-items:center;gap:6px}
      .dd-btn.pri{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
      .dd-btn.pri .dd-ico{color:var(--on-deep,#fff)}
      .dd-btn.danger{color:var(--coral,#D64545);border-color:color-mix(in srgb,var(--coral,#D64545) 38%,var(--line,#DCD6CB))}
      .dd-btn:disabled{opacity:.45;cursor:not-allowed}
      .dd-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
      .dd-list{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:18px;overflow:hidden}
      /* 列宽：轮次名固定宽（各行才对得齐）→ 日期取内容宽 → 标签吃掉剩余空间并靠右。
         曾经写成 150px 1fr auto，日期落在 1fr 里 —— 「10月12日 — 10月18日 · 周一」
         这种最长的串会被挤成两行（实测 1280 宽下折了 2 行）。日期是固定格式的短串，
         不该折行，把弹性让给右侧的标签列。 */
      .dd-row{display:grid;grid-template-columns:96px auto 1fr;gap:12px;align-items:center;padding:13px 17px;border-bottom:1px solid var(--line-soft,#F0ECE5)}
      .dd-row:last-child{border-bottom:0}
      .dd-row b{font-size:calc(13px * var(--ui-text-scale))}
      .dd-row .dd-d{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#687780);white-space:nowrap}
      /* 多人当班时名字串可能很长，允许折行（text-align 保靠右），别把行撑破 */
      .dd-tag{font-size:calc(11px * var(--ui-text-scale));border-radius:12px;padding:4px 9px;background:color-mix(in srgb,var(--mint,#2ec4b6) 10%,var(--panel,#fff));color:var(--deep,#0F4C5C);white-space:normal;text-align:right;max-width:100%;justify-self:end}
      .dd-row.now{background:color-mix(in srgb,var(--deep,#0F4C5C) 5%,var(--panel,#fff))}
      .dd-row.past b,.dd-row.past .dd-d{color:var(--ink-3,#A9B2BA)}
      .dd-mrow{display:grid;grid-template-columns:26px 28px minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line-soft,#F0ECE5)}
      .dd-lrow{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line-soft,#F0ECE5)}
      /* 「今天当班」与「正在拖动」共用同一个绿色（--mint）—— 两者都是「这一行是当前的」。
         用 outline（不吃布局）而不是 border：.dd-mrow 是 grid，加 border 会让整行高 2px，
         拖动经过时上下几行会跟着抖一下。 */
      .dd-mrow.current{background:color-mix(in srgb,var(--mint,#2EC4B6) 12%,transparent);border-radius:10px;outline:2px solid var(--mint,#2EC4B6);outline-offset:-2px}
      .dd-mrow.current .dd-mno{color:var(--mint,#2EC4B6);font-weight:750}
      .dd-mrow.current .dd-in{border-color:var(--mint,#2EC4B6)}
      .dd-mrow:last-child{border-bottom:0}
      /* 拖动中的行：绿色描边 + 抬起来（阴影）。真实行跟着指针走（不是克隆），
         所以不能像象限卡片那样压到 .3 透明度 —— 名字要一直读得清。 */
      .dd-mrow.dragging{position:relative;z-index:5;background:var(--panel,#fff);border-radius:10px;outline:2px solid var(--mint,#2EC4B6);outline-offset:-2px;box-shadow:0 12px 26px color-mix(in srgb,var(--ink,#22303A) 24%,transparent);cursor:grabbing;will-change:transform}
      .dd-mno{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A1A9AF);text-align:center;font-variant-numeric:tabular-nums}
      .dd-drag{width:28px;height:32px;border:0;background:transparent;color:var(--ink-3,#A1A9AF);cursor:grab;font-size:calc(16px * var(--ui-text-scale));line-height:1;display:grid;place-items:center;padding:0;touch-action:none}
      .dd-drag:active{cursor:grabbing;color:var(--deep,#0F4C5C)}
      .dd-in{height:34px;border:1px solid var(--line,#DDD7CD);border-radius:9px;padding:0 10px;background:var(--panel,#fff);color:var(--ink,#22303A);font:inherit;font-size:calc(13px * var(--ui-text-scale));min-width:0;width:100%}
      .dd-in:focus{outline:2px solid color-mix(in srgb,var(--deep,#0F4C5C) 18%,transparent);border-color:var(--deep,#0F4C5C)}
      .dd-mbtns{display:flex;gap:5px;flex:none}
      .dd-mini{height:32px;min-width:32px;padding:0 9px;border-radius:8px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);cursor:pointer;font-size:calc(12px * var(--ui-text-scale));font-family:inherit;color:var(--ink-2,#59656D)}
      .dd-mini:hover{border-color:color-mix(in srgb,var(--deep,#0F4C5C) 42%,var(--line,#DCD6CB));color:var(--deep,#0F4C5C)}
      .dd-mini.danger:hover{border-color:var(--coral,#D64545);color:var(--coral,#D64545)}
      .dd-mini:disabled{opacity:.4;cursor:not-allowed}
      .dd-add{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
      .dd-add .dd-in{flex:1;min-width:140px}
      .dd-chips{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
      .dd-chip{height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);cursor:pointer;font-size:calc(12px * var(--ui-text-scale));font-family:inherit;color:var(--ink-2,#59656D)}
      .dd-chip.on{background:var(--deep,#0F4C5C);border-color:var(--deep,#0F4C5C);color:var(--on-deep,#fff)}
      .dd-field{display:grid;grid-template-columns:104px 1fr;gap:10px;align-items:center;padding:8px 0}
      .dd-field > span{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
      .dd-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .dd-num{width:76px}
      .dd-switch-row{display:flex;align-items:center;gap:10px}
      .dd-switch-row label{display:inline-flex;align-items:center;gap:8px;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink,#22303A);cursor:pointer}
      .dd-removed{margin-top:12px;border-top:1px dashed var(--line,#E4DFD6);padding-top:10px}
      .dd-removed-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
      @media(max-width:720px){
        .dd-hero,.dd-grid{grid-template-columns:1fr}
        .dd-card{padding:17px}
        .dd-who b{font-size:calc(25px * var(--ui-text-scale))}
        .dd-groups{margin-top:8px}
        /* 显式定位，别靠自动排布：DOM 顺序是 b → .dd-d → .dd-tag，
           而 .dd-d 要跨满整行，自动排布就会把 .dd-tag 挤到下一行的第 1 列，
           1fr 列让它撑成整行横幅（实测截图里「小北 · 4 天后」被拉满一整行）。 */
        .dd-row{grid-template-columns:1fr auto;gap:6px 10px;padding:12px}
        .dd-row > b{grid-column:1;grid-row:1}
        .dd-row > .dd-tag{grid-column:2;grid-row:1;justify-self:end}
        .dd-row > .dd-d{grid-column:1/-1;grid-row:2}
        .dd-mrow{grid-template-columns:22px 28px 1fr;gap:6px 8px}
        .dd-lrow{grid-template-columns:22px minmax(0,1fr);gap:6px 8px}
        .dd-lrow .dd-mbtns{grid-column:2;justify-content:flex-end}
        .dd-mbtns{grid-column:3;justify-content:flex-end}
        .dd-field{grid-template-columns:1fr;gap:6px}
      }
    `;
    document.head.append(st);
  }

  /* ── 组装页面数据 ── */
  function snapshot(g) {
    const today = tide.util.today();
    const p = periodOf(g);
    const per = perRoundOf(g);
    const cycle = cycleStartOf(g, today);
    const started = !!cycle;
    const current = assigneeFor(g, today);
    const currentAll = assigneesFor(g, today);
    const paused = today >= g.startDate && pausedAt(g, today);
    const nextStart = paused ? shiftActive(g, today, 0) : cycle ? shiftActive(g, cycle, p) : activeDate(g, 0);
    const locationCycle = locationCycleStartOf(g, today);
    const nextLocationStart = g.locations.length ? (paused ? shiftActive(g, today, 0) : locationCycle ? shiftActive(g, locationCycle, g.locationPeriodDays) : activeDate(g, 0)) : null;
    const rows = [];
    for (let i = 0; i < UPCOMING && nextStart; i++) {
      const start = i === 0 ? nextStart : shiftActive(g, cycleStartOf(g, nextStart), i * p);
      const whoAll = assigneesFor(g, start);
      rows.push({
        start,
        end: cycleEndOf(g, start, p),
        who: whoAll[0] || null,
        whoAll,
        index: cycleIndexAt(g, start) + 1,
        daysUntil: diffDays(today, start),
        swapped: overrideHits(g, start).length > 0,
      });
    }
    return {
      g, today, cycle, started, paused,
      current, currentAll, per,
      nextStart,
      currentLocation: locationAt(g, today),
      nextLocationStart,
      nextLocation: nextLocationStart ? locationAt(g, nextLocationStart) : "",
      nextWho: nextStart ? assigneeFor(g, nextStart) : null,
      nextWhoAll: nextStart ? assigneesFor(g, nextStart) : [],
      rows, period: p,
    };
  }
  const relLabel = (n) => (n === 0 ? "今天" : n === 1 ? "明天" : n > 0 ? `${n} 天后` : `${-n} 天前`);
  /** 「下次换人」大数字：没开始的阶段说的是「开始」而不是「换人」。 */
  function nextBigText(s) {
    const d = diffDays(s.today, s.nextStart);
    const verb = s.paused ? "恢复" : s.started ? "换人" : "开始";
    if (d <= 0) return `<em>今天</em>${verb}`;
    if (d === 1) return `<em>明天</em>${verb}`;
    return `<em>${d}</em>天后${verb}`;
  }

  /** 顶部轮换切换条：每套轮换一个标签，顺手带上它今天当班的人（一眼看全所有轮换）。 */
  function groupChipsHtml() {
    return state.groups.map((g) => {
      const names = assigneesFor(g, tide.util.today()).map((m) => m.name).join("、");
      const on = g.id === state.activeId;
      return `<button class="dd-gchip${on ? " on" : ""}" data-group="${esc(g.id)}" type="button" aria-pressed="${on ? "true" : "false"}" title="切到「${esc(g.name)}」（右键或长按可重命名 / 复制 / 导入成员）">
        <span>${esc(g.name)}</span><em class="dd-gwho">${esc(pausedAt(g, tide.util.today()) ? "暂停中" : names || "未排班")}</em>
      </button>`;
    }).join("");
  }

  function heroHtml(s) {
    const g = s.g;
    const kicker = `${esc(g.name)} · ${PERIOD_LABEL[s.period] || `每 ${s.period} 天`}一轮${s.per > 1 ? ` · 每轮 ${s.per} 人` : ""}`;
    if (!g.members.length) {
      return `<div class="dd-kicker">${kicker}</div>
        <div class="dd-who"><b>先添加成员</b></div>
        <div class="dd-range">在下面的「成员」里按顺序填写名字，第一个人先当班；<br>之后按你设定的周期自动轮换，到点会提醒当班的人。</div>`;
    }
    if (s.paused) return `<div class="dd-kicker">${kicker}</div><div class="dd-who"><b>假期 / 节日暂停中</b></div><div class="dd-range">暂停期间不排班、不提醒，成员和地点轮换均停止计时。<br>${fmt(s.nextStart)}恢复，继续由 ${esc(s.nextWhoAll.map(m => m.name).join("、") || "—")} 当班。</div>`;
    if (!s.started) {
      const firstNames = (s.rows[0]?.whoAll || []).map((m) => m.name).join("、");
      return `<div class="dd-kicker">${kicker}</div>
        <div class="dd-who"><b>轮换还没开始</b><span class="dd-badge warn">未开始</span></div>
        <div class="dd-range">将于 <b>${fmt(s.nextStart)}（${weekday(s.nextStart)}）</b> 开始，第一批是 <b>${esc(firstNames || "—")}</b>。<br>想从今天开始就把下面的「起始日期」改成今天。</div>`;
    }
    const onSwitch = s.cycle === s.today;
    const names = s.currentAll.map((m) => m.name).join("、");
    // 「已换人 · 原 X」里的 X 是**正常轮换本该当班的那批人**，不是换上去的 ——
    // overrideHits() 返回的是替补，别直接拿来当「原」。
    const normalNames = normalAssignees(g, s.cycle).map((m) => m.name).join("、");
    const rangeEnd = cycleEndOf(g, s.cycle, s.period);
    return `<div class="dd-kicker">${kicker}</div>
      <div class="dd-who"><b${s.currentAll.length > 1 ? ' class="dd-multi"' : ""}>${esc(names)}</b>${onSwitch ? '<span class="dd-badge">今天换人</span>' : ""}${overrideHits(g, s.cycle).length ? `<span class="dd-badge warn">已换人 · 原 ${esc(normalNames)}</span>` : ""}</div>
      <div class="dd-range">本轮 ${fmt(s.cycle)}${s.period > 1 ? ` — ${fmt(rangeEnd)}` : `（${weekday(s.cycle)}）`}${s.period > 1 ? ` · ${weekday(s.cycle)}起` : ""} · 第 ${cycleIndexAt(g, s.cycle) + 1} 轮${s.currentLocation ? `<br>今日地点：<b>${esc(s.currentLocation)}</b>` : ""}</div>`;
  }

  /** 「本轮换人」：勾选式多选。初始勾选 = 本轮**现在实际**当班的人（换过就是换上的名单），
      点成员芯片勾上 / 取消，再点「换成所选」生效。 */
  function swapHtml(s) {
    const g = s.g;
    if (!g.members.length) return "";
    const hits = s.cycle ? overrideHits(g, s.cycle) : [];
    const activeIds = new Set((hits.length ? hits : s.currentAll).map((m) => m.id));
    const options = g.members.map((m) => `<button class="dd-chip${activeIds.has(m.id) ? " on" : ""}" data-swap-pick="${esc(m.id)}" type="button" aria-pressed="${activeIds.has(m.id) ? "true" : "false"}">${esc(m.name)}</button>`).join("");
    return `<div class="dd-field"><span>本轮换人</span>
      <div class="dd-inline">
        <div class="dd-chips" data-swap-box role="group" aria-label="勾选本轮当班的人（可多选）">${options}</div>
        <button class="dd-btn" data-swap-apply type="button">换成所选</button>
        ${hits.length ? '<button class="dd-btn" data-swap-clear type="button">撤销换人</button>' : ""}
      </div>
    </div>`;
  }

  function rowsHtml(s) {
    const g = s.g;
    if (!g.members.length) return `<div class="dd-row"><span class="dd-d">还没有成员，添加后会自动排班。</span></div>`;
    if (!s.rows.length) return `<div class="dd-row"><span class="dd-d">还没有可排的轮次。</span></div>`;
    return s.rows.map((r) => {
      const names = r.whoAll.map((m) => m.name).join("、");
      return `<div class="dd-row${r.daysUntil === 0 ? " now" : ""}">
      <b>${r.daysUntil === 0 ? "本轮" : `第 ${r.index} 轮`}</b>
      <span class="dd-d">${s.period > 1 ? `${fmt(r.start)} — ${fmt(r.end)} · ${weekday(r.start)}起` : `${fmt(r.start)}（${weekday(r.start)}）`}</span>
      <span class="dd-tag">${esc(names || "—")}${r.swapped ? " · 换人" : ""} · ${relLabel(r.daysUntil)}</span>
    </div>`;
    }).join("");
  }

  function membersHtml(g, date = tide.util.today()) {
    if (!g.members.length) return `<div class="dd-muted">还没有成员。按你填写的顺序轮换，第一个人先当班。</div>`;
    const currentIds = new Set(assigneesFor(g, date).map((m) => m.id));
    return membersInDateOrder(g, date).map((m, i) => {
      const baseIndex = g.members.findIndex((item) => item.id === m.id);
      return `<div class="dd-mrow${currentIds.has(m.id) ? " current" : ""}" data-id="${esc(m.id)}">
      <span class="dd-mno">${i + 1}</span>
      <button class="dd-drag" data-drag type="button" title="拖动调整长期轮换顺序" aria-label="拖动 ${esc(m.name)} 调整顺序">⋮⋮</button>
      <input class="dd-in" data-name value="${esc(m.name)}" maxlength="${MEMBER_MAX}" aria-label="第 ${i + 1} 位成员的名字">
      <span class="dd-mbtns">
        <button class="dd-mini" data-up type="button" ${baseIndex === 0 ? "disabled" : ""} title="调整长期轮换顺序：往前排" aria-label="把 ${esc(m.name)} 在长期轮换顺序中往前排">↑</button>
        <button class="dd-mini" data-down type="button" ${baseIndex === g.members.length - 1 ? "disabled" : ""} title="调整长期轮换顺序：往后排" aria-label="把 ${esc(m.name)} 在长期轮换顺序中往后排">↓</button>
        <button class="dd-mini danger" data-del type="button" title="从轮换里移除（可在下方恢复）" aria-label="移除 ${esc(m.name)}">移除</button>
      </span>
    </div>`;
    }).join("");
  }

  function locationsHtml(s) {
    const g = s.g;
    const custom = !PERIOD_CHIPS.includes(g.locationPeriodDays);
    return `<div class="dd-field"><span>地点周期</span><div class="dd-chips">
      ${PERIOD_CHIPS.map((p) => `<button class="dd-chip${p === g.locationPeriodDays ? " on" : ""}" data-location-period="${p}" type="button">${PERIOD_LABEL[p]}</button>`).join("")}
      <input class="dd-in dd-num" data-location-period-custom type="number" min="1" max="365" value="${custom ? g.locationPeriodDays : ""}" placeholder="N" aria-label="自定义地点周期天数"><span class="dd-muted">天换地点</span>
    </div></div>
    ${g.locations.length ? g.locations.map((name, i) => `<div class="dd-lrow" data-location-index="${i}"><span class="dd-mno">${i + 1}</span><input class="dd-in" data-location-name value="${esc(name)}" maxlength="${LOCATION_NAME_MAX}" aria-label="第 ${i + 1} 个地点"><span class="dd-mbtns"><button class="dd-mini" data-location-up type="button"${i ? "" : " disabled"} title="地点前移">↑</button><button class="dd-mini" data-location-down type="button"${i < g.locations.length - 1 ? "" : " disabled"} title="地点后移">↓</button><button class="dd-mini danger" data-location-del type="button">移除</button></span></div>`).join("") : '<div class="dd-muted">添加地点后，将从起始日期按顺序轮换。</div>'}
    <div class="dd-add"><input class="dd-in" data-location-new maxlength="${LOCATION_NAME_MAX}" placeholder="输入地点，如 走廊" aria-label="新地点"><button class="dd-btn pri" data-location-add type="button"${g.locations.length >= LOCATION_MAX ? " disabled" : ""}>添加地点</button></div>
    ${s.nextLocationStart ? `<div class="dd-note">${s.started ? "下次换地点" : "地点轮换开始"}：${fmt(s.nextLocationStart)}（${weekday(s.nextLocationStart)}）→ ${esc(s.nextLocation)}。地点和成员分别计时，均从起始日期开始。</div>` : ""}`;
  }

  function moveMemberTo(g, id, toIndex) {
    const members = g.members || [];
    const from = members.findIndex((m) => m.id === id);
    const to = Math.max(0, Math.min(members.length - 1, Math.round(Number(toIndex))));
    if (from < 0 || to < 0 || from === to) return false;
    const [m] = members.splice(from, 1);
    members.splice(to, 0, m);
    return true;
  }

  /* 成员拖动排序（手感对齐 dnd-kit 的 sortable，参考 tauri-shortcut-launcher 的侧栏拖动）：
       · 按下把手后先等 4px 位移才进入拖动态 —— 只点一下不该闪出一圈绿框；
       · 被拖的行跟着指针走（transform），**不克隆幽灵卡**：行里有个 <input>，
         克隆一份会让用户以为能在副本上改名，而焦点与输入值都在原件上；
       · 其余行用 WAAPI FLIP 从旧位置滑到新位置，松手后不会再整列跳一下；
       · 序号按槽位**在拖动过程中**就重编 —— 松手前用户已经看到「我会排到第 2 位」，
         而不是松手瞬间 1..6 集体改一次。 */
  function bindMemberDrag(g, commit) {
    const list = root?.querySelector("[data-members]");
    if (!list) return;
    const ACTIVATE_PX = 4;      // 与参考实现 PointerSensor 的 activationConstraint.distance 同值
    const FLIP_MS = 180;
    let drag = null;

    const rows = () => [...list.querySelectorAll(".dd-mrow")];
    const reduceMotion = () => {
      try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch { return false; }
    };
    /** 量几何前先让在跑的让位动画落定：带残余 transform 的 rect 会把槽位判定带偏
        （象限拖拽踩过这个坑）。cancel() 只是让行直接落到它的布局位置，不会闪。 */
    const topOf = (node) => {
      node.getAnimations?.().forEach((a) => a.cancel());
      return node.getBoundingClientRect().top;
    };
    /** 序号列 = DOM 顺序，拖动中每换一次槽位就重编。 */
    function renumber() {
      rows().forEach((node, i) => {
        const no = node.querySelector(".dd-mno");
        if (no && no.textContent !== String(i + 1)) no.textContent = String(i + 1);
        node.querySelector("[data-name]")?.setAttribute("aria-label", `第 ${i + 1} 位成员的名字`);
      });
    }
    /** FLIP：先量旧位置 → 改 DOM → 让每行从旧位置滑到新位置。被拖的行由指针驱动，不参与。 */
    function flip(mutate) {
      const before = rows().map((node) => [node, topOf(node)]);
      mutate();
      if (reduceMotion()) return;
      for (const [node, top] of before) {
        if (node === drag?.row) continue;
        const dy = top - node.getBoundingClientRect().top;
        if (!dy) continue;
        node.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
          { duration: FLIP_MS, easing: "cubic-bezier(.22,.8,.22,1)" });
      }
    }
    /** 收尾：摘掉全局兜底监听 + 清掉拖动态样式（顺序是否落库由 finish 决定）。 */
    function endDrag() {
      document.removeEventListener("pointerup", docUp, true);
      document.removeEventListener("pointercancel", docCancel, true);
      const row = drag?.row;
      drag = null;
      if (!row) return;
      row.classList.remove("dragging");
      row.style.transform = "";
      row.style.willChange = "";
      renumber();
    }
    async function finish(commitIt) {
      if (!drag) return;
      const d = drag;
      const to = rows().map((node) => node.dataset.id).indexOf(d.id);
      const changed = commitIt && d.active && to >= 0 && d.startIndex >= 0 && to !== d.startIndex;
      endDrag();
      if (!changed) return;
      await commit(() => { moveMemberTo(g, d.id, to); });
    }
    // setPointerCapture 失败、或指针在行外松手时，事件不会回到把手 —— 必须走 document 兜底，
    // 否则会话挂死：行停在拖动态、顺序也不落库。capture=true 保证比行内处理器先跑（不会双提交）。
    function docUp() { finish(true); }
    function docCancel() { finish(false); }

    list.querySelectorAll("[data-drag]").forEach((handle) => {
      handle.addEventListener("pointerdown", (e) => {
        const row = e.currentTarget.closest(".dd-mrow");
        if (!row || e.button > 0) return;
        e.preventDefault();
        const startIndex = rows().map((node) => node.dataset.id).indexOf(row.dataset.id);
        // slot 用的是「去掉被拖行之后」的槽位坐标：被拖行前面有 startIndex 行，初值就是它。
        drag = { id: row.dataset.id, row, startIndex, slot: startIndex, startY: e.clientY, active: false };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* 靠 document 兜底 */ }
        document.addEventListener("pointerup", docUp, true);
        document.addEventListener("pointercancel", docCancel, true);
      });
      handle.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (!drag.active) {
          if (Math.abs(e.clientY - drag.startY) < ACTIVATE_PX) return;
          drag.active = true;
          drag.row.classList.add("dragging");
          drag.row.style.willChange = "transform";
        }
        drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`;
        const others = rows().filter((node) => node !== drag.row);
        let slot = others.length;
        for (let i = 0; i < others.length; i++) {
          if (e.clientY < topOf(others[i]) + others[i].offsetHeight / 2) { slot = i; break; }
        }
        if (slot === drag.slot) return;
        drag.slot = slot;
        flip(() => list.insertBefore(drag.row, others[slot] || null));
        renumber();
      });
      handle.addEventListener("pointerup", () => { finish(true); });
      handle.addEventListener("pointercancel", () => { finish(false); });
    });
  }

  function currentTimeString() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function removedHtml(g) {
    if (!g.removed.length) return "";
    const names = g.removed.map((m) => esc(m.name)).join("、");
    return `<div class="dd-removed"><div class="dd-removed-row">
      <span>已移除：${names}</span>
      <button class="dd-btn" data-restore type="button">恢复已移除（${g.removed.length}）</button>
    </div><div class="dd-note">恢复会加回轮换末尾，不改动已经过去的轮次。</div></div>`;
  }

  function rulesHtml(s) {
    const g = s.g;
    const custom = !PERIOD_CHIPS.includes(s.period);
    const per = s.per;
    const perCustom = !PERROUND_CHIPS.includes(per);
    const lastOne = state.groups.length <= 1;
    return `<div class="dd-field"><span>轮换名称</span>
        <input class="dd-in" data-group-name value="${esc(g.name)}" maxlength="${NAME_MAX}" placeholder="宿舍值日 / 公区卫生 / 打水">
      </div>
      <div class="dd-field"><span>起始日期</span>
        <div class="dd-inline">
          <input class="dd-in" data-start type="date" value="${esc(g.startDate)}" style="max-width:170px" aria-label="轮换起始日期">
          <button class="dd-mini" data-start-today type="button">今天</button>
        </div>
      </div>
      <div class="dd-field"><span>轮换周期</span>
        <div class="dd-chips">
          ${PERIOD_CHIPS.map((p) => `<button class="dd-chip${p === s.period ? " on" : ""}" data-period="${p}" type="button">${PERIOD_LABEL[p]}</button>`).join("")}
          <input class="dd-in dd-num" data-period-custom type="number" min="1" max="365" value="${custom ? s.period : ""}" placeholder="N" aria-label="自定义周期天数">
          <span class="dd-muted">天一轮</span>
        </div>
      </div>
      <div class="dd-field"><span>每轮人数</span>
        <div class="dd-chips">
          ${PERROUND_CHIPS.map((n) => `<button class="dd-chip${n === per ? " on" : ""}" data-perround="${n}" type="button">${n === 1 ? "单人" : `${n} 人`}</button>`).join("")}
          <input class="dd-in dd-num" data-perround-custom type="number" min="1" max="${MEMBER_MAX}" value="${perCustom ? per : ""}" placeholder="N" aria-label="自定义每轮人数">
          <span class="dd-muted">人一起当班</span>
        </div>
      </div>
      <div class="dd-note">起始日期就是「第一个人开始当班」的那天；改周期不会打乱已经排好的顺序。<br>每轮人数大于 1 时按名单顺序每轮取 N 人循环（如 3 人每轮 2 人：A、B → C、A → B、C）。<br>每套轮换各自独立 —— 这里的成员、周期、换人与提醒都只影响「${esc(g.name)}」。</div>
      <div class="dd-actions">
        <button class="dd-btn danger" data-group-del type="button"${lastOne ? " disabled" : ""} title="${lastOne ? "至少要留一套轮换" : `删除「${esc(g.name)}」`}">${faIcon("trash")}删除这个轮换</button>
      </div>`;
  }

  function pauseHtml(g) {
    return `<div class="dd-title" style="margin-top:16px">假期 / 节日暂停</div>
      <div class="dd-note">添加放假日期段（含首尾日期）；期间不值日、不提醒，也不累计成员和地点轮换天数。结束后接着原顺序继续。重叠或相邻日期会自动合并。</div>
      ${g.pauseRanges.map((r,i) => `<div class="dd-inline">${esc(r.start)} → ${esc(r.end)}<button class="dd-mini danger" data-pause-del="${i}" type="button">移除</button></div>`).join("")}
      <div class="dd-chips"><input class="dd-in" type="date" data-pause-start aria-label="暂停开始日期" style="max-width:170px"><span>至</span><input class="dd-in" type="date" data-pause-end aria-label="暂停结束日期" style="max-width:170px"><button class="dd-btn" data-pause-add type="button">添加暂停</button></div>`;
  }

  function remindHtml(s) {
    const g = s.g;
    const opts = state.soundPresets
      .map((p) => `<option value="${esc(p.id)}"${p.id === g.sound ? " selected" : ""}>${esc(p.label)}</option>`)
      .join("");
    return `<div class="dd-field"><span>提醒</span>
        <span class="dd-switch-row"><label><input class="switch" role="switch" type="checkbox" data-remind${g.remindEnabled ? " checked" : ""} aria-label="开启轮换提醒">每轮第一天提醒当班的人</label></span>
      </div>
      <div class="dd-field"><span>提醒时刻</span>
        <div class="dd-inline"><input class="dd-in" data-time type="time" value="${esc(g.remindTime)}" style="max-width:140px" aria-label="提醒时刻">
        <button class="dd-btn" data-test type="button">试一下</button></div>
      </div>
      <div class="dd-field"><span>提示音</span>
        <div class="dd-inline">
          <select class="dd-in" data-sound style="max-width:170px" aria-label="提示音">${opts || '<option value="beep">默认提示音</option>'}</select>
          <button class="dd-btn" data-sound-try type="button">试听</button>
        </div>
      </div>
      <div class="dd-note">只在每轮的第一天提醒一次（周期 = 1 就是每天），不会天天催。<br>当天没打开应用、之后才打开时会补提醒一次；提醒依赖应用在运行（与「任务提醒」同一套通道）。</div>`;
  }

  async function paint() {
    if (!root) return;
    ensureStyle();
    const g = activeGroup();
    if (!g) return;
    const s = snapshot(g);
    state.membersOrderKey = membersOrderKey(g, s.today);
    root.innerHTML = `<div class="dd-wrap">
      <div class="dd-groups">
        <div class="dd-glist" role="tablist" aria-label="轮换列表">${groupChipsHtml()}</div>
        <button class="dd-btn" data-group-new type="button">${faIcon("circle-plus")}新建轮换</button>
      </div>
      ${tabMenu ? tabMenuHtml() : ""}
      <div class="dd-hero">
        <section class="dd-card">${heroHtml(s)}
          <div class="dd-actions">
            <button class="dd-btn pri" data-task type="button"${s.current ? "" : " disabled"}>${faIcon("circle-plus")}加入今日任务</button>
            <button class="dd-btn" data-today type="button">看今天</button>
          </div>
          ${s.current ? swapHtml(s) : ""}
        </section>
        <section class="dd-card">
          <div class="dd-kicker">${s.paused ? "恢复值日" : s.started ? "下次换人" : "轮换开始"}</div>
          ${g.members.length && s.nextStart ? `<div class="dd-big">${nextBigText(s)}</div>
          <div class="dd-muted">${fmt(s.nextStart)} ${weekday(s.nextStart)} · 轮到 <b>${esc(s.nextWhoAll.map((m) => m.name).join("、") || "—")}</b></div>` : `<div class="dd-muted">${g.members.length ? "还没有可排的轮次。" : "还没有成员，无法排班。"}</div>`}
        </section>
      </div>
      <div class="dd-grid" style="margin-bottom:14px">
        <section class="dd-card" style="padding:0">
          <div class="dd-title" style="padding:17px 17px 0">${faIcon("calendar-days")}接下来的轮次</div>
          <div class="dd-list" style="border:0">${rowsHtml(s)}</div>
        </section>
        <section class="dd-card">
          <div class="dd-title">${faIcon("people-group")}成员 · 轮换顺序</div>
          <div class="dd-note">按真实轮换顺序排列；绿色描边表示今天当班（拖动时被拖的那行也是绿框）。拖动 ⋮⋮ 或点 ↑↓ 调整顺序，拖动过程中序号实时跟着变。</div>
          <div data-members>${membersHtml(g)}</div>
          <div class="dd-add">
            <input class="dd-in" data-new maxlength="${MEMBER_MAX}" placeholder="输入成员名字，回车即可添加" aria-label="新成员名字">
            <button class="dd-btn pri" data-add type="button">${faIcon("user-plus")}添加成员</button>
          </div>
          ${removedHtml(g)}
        </section>
      </div>
      <div class="dd-grid">
        <section class="dd-card">
          <div class="dd-title">${faIcon("arrows-rotate")}轮换规则</div>
          ${rulesHtml(s)}
          ${pauseHtml(g)}
        </section>
        <section class="dd-card">
          <div class="dd-title">${faIcon("bell")}提醒</div>
          ${remindHtml(s)}
        </section>
      </div>
      <section class="dd-card" style="margin-top:14px">
        <div class="dd-title">${faIcon("location-dot")}地点轮换</div>
        ${locationsHtml(s)}
      </section>
    </div>`;
    bind();
  }

  /* ── 轮换组的增删改（抽成具名函数：绑定时只负责调用，逻辑才能在 Node 里真跑） ── */
  /** 切换当前轮换。返回是否真的切了。 */
  async function setActiveGroup(id) {
    if (!id || id === state.activeId) return false;
    if (!state.groups.some((x) => x.id === id)) return false;
    state.activeId = id;
    await save();
    return true;
  }
  /** 新建一套轮换并切过去。到上限返回 null（由调用方提示）。 */
  async function addGroup() {
    if (state.groups.length >= GROUP_MAX) return null;
    const created = defaultGroup(tide.util.today(), `轮换 ${state.groups.length + 1}`);
    state.groups.push(created);
    state.activeId = created.id;
    await save();
    return created;
  }
  /** 删除一套轮换。**最后一套不许删** —— 删光界面就没有可编辑的对象了，
      用户想重来应该改名 + 清成员，而不是把自己删到没有落脚点。 */
  async function removeGroup(id) {
    if (state.groups.length <= 1) return false;
    const idx = state.groups.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    state.groups.splice(idx, 1);
    if (state.activeId === id) state.activeId = (state.groups[idx] || state.groups[idx - 1]).id;
    await save();
    return true;
  }
  /** 改名。空名退回默认名，不留空白标签。 */
  async function renameGroup(id, name) {
    const g = state.groups.find((x) => x.id === id);
    if (!g) return false;
    const next = String(name || "").trim().slice(0, NAME_MAX) || DEFAULT_GROUP_NAME;
    if (next === g.name) return false;
    g.name = next;
    await save();
    return true;
  }
  /** 副本名：把本体截短来腾出「 N」的位置。直接 `src + " 2"` 再切到 NAME_MAX，
      满长的名字会切回和源组一模一样的串 —— 用户取消改名时标签条上就是两个同名标签。 */
  function nextCopyName(srcName, groups) {
    const taken = new Set(groups.map((g) => g.name));
    for (let n = 2; n < 100; n += 1) {
      const suffix = ` ${n}`;
      const cand = (srcName.slice(0, Math.max(1, NAME_MAX - suffix.length)) + suffix).slice(0, NAME_MAX);
      if (!taken.has(cand)) return cand;
    }
    return `轮换 ${groups.length + 1}`.slice(0, NAME_MAX);
  }
  /** 复制一套轮换：规则与名单原样带走，但**组 id 和每个成员 id 全部重新生成**。
      沿用旧 id 等于两组共享同一批人 —— 副本里「本轮换人」「移除某人」会连着改掉原组的排班，
      而「每套轮换互不影响」是本插件的立身之本（见文件头第一条建模决定）。
      连带代价：overrides 记的是成员 id，端过来全是悬空引用，所以换人记录清空；
      lastNotified 也清空，否则副本当天不会再提醒当班的人。
      起始日**保留** —— 同一宿舍的两套值日才会在同一天换人。 */
  async function duplicateGroup(id) {
    if (state.groups.length >= GROUP_MAX) return null;
    const src = state.groups.find((x) => x.id === id);
    if (!src) return null;
    const reid = (list) => list.map((m) => ({ id: uid("m"), name: m.name }));
    const copy = normalizeGroup({
      ...src,
      id: uid("g"),
      name: nextCopyName(src.name, state.groups),
      members: reid(src.members),
      removed: reid(src.removed),
      overrides: {},
      lastNotified: "",
    }, tide.util.today());
    // 紧跟源组插入，而不是甩到列表末尾
    state.groups.splice(state.groups.indexOf(src) + 1, 0, copy);
    state.activeId = copy.id;
    await save();
    return copy;
  }
  /** 从另一套轮换导入成员：按**名字**去重后追加到当前名单末尾，id 一律新建。
      只能按名字对 —— 两组的成员 id 各起各的，名字才是唯一对得上的东西。
      已有的人连 id 都不动，否则换人顺序和过去的轮次会指错人。返回实际导入人数。 */
  async function importMembers(targetId, sourceId) {
    const target = state.groups.find((x) => x.id === targetId);
    const source = state.groups.find((x) => x.id === sourceId);
    if (!target || !source || target === source) return 0;
    const room = MEMBER_MAX - target.members.length;
    if (room <= 0) return 0;
    const have = new Set(target.members.map((m) => m.name));
    const added = [];
    for (const m of source.members) {
      if (added.length >= room) break;
      if (have.has(m.name)) continue;
      have.add(m.name);
      added.push({ id: uid("m"), name: m.name });
    }
    if (!added.length) return 0;
    target.members.push(...added);
    await save();
    return added.length;
  }

  /* ── 标签右键菜单 ── */
  /** 弹菜单。只定位、**不切组** —— 一级菜单里「切到这一组」才是切组动作，
      右键时偷偷切走会让用户以为菜单操作的是原来那套。 */
  function openTabMenu(id, x, y) {
    if (!state.groups.some((g) => g.id === id)) return;
    // ⚠️ 视口坐标是从屏幕角量起的，而安全区那四条边落在屏幕边上：fixed 的包含块是宿主
    // .view 的 padding box，.view 垫掉的安全区拦不住 fixed 后代 —— 夹取必须自己减掉。
    const px = (v) => {
      try { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0; } catch { return 0; }
    };
    const [sat, sab, sal, sar] = [px("--sat"), px("--sab"), px("--sal"), px("--sar")];
    tabMenu = {
      id,
      x: Math.max(8 + sal, Math.min(x, (window.innerWidth || 1024) - sar - MENU_W)),
      y: Math.max(8 + sat, Math.min(y, (window.innerHeight || 768) - sab - MENU_H)),
      step: "",
    };
    paint();
  }
  function closeTabMenu() { if (!tabMenu) return; tabMenu = null; paint(); }

  /** 菜单项统一 data-tab-act，不复用标签的 data-group、也不复用卡片的 data-group-del ——
      事件委托里那两个分支会先把点击抢走（与 school-notice 同一条规矩）。 */
  function tabMenuHtml() {
    const target = state.groups.find((g) => g.id === tabMenu.id);
    if (!target) return "";
    const item = (act, label, opts = {}) => `<button type="button" role="menuitem" class="dd-tabmenu-item${opts.danger ? " danger" : ""}" data-tab-act="${act}"${opts.disabled ? " disabled" : ""}>${esc(label)}</button>`;
    const head = `<div class="dd-tabmenu" data-tab-menu role="menu" aria-label="轮换操作" style="left:${tabMenu.x}px;top:${tabMenu.y}px">`
      + `<span class="dd-tabmenu-title">${esc(target.name)}</span>`;
    if (tabMenu.step === "import") {
      const others = state.groups.filter((g) => g.id !== target.id);
      return head
        + `<span class="dd-tabmenu-hint">把哪一套的成员并进「${esc(target.name)}」？同名的人自动跳过</span>`
        + (others.length
          ? others.map((g) => `<button type="button" role="menuitem" class="dd-tabmenu-item" data-import-from="${esc(g.id)}">${esc(g.name)}<em class="dd-tabmenu-n">${g.members.length} 人</em></button>`).join("")
          : `<span class="dd-tabmenu-hint">还没有别的轮换可以导入。</span>`)
        + `<span class="dd-tabmenu-sep"></span>`
        + item("back", "取消")
        + `</div>`;
    }
    const lastOne = state.groups.length <= 1;
    return head
      + item("switch", "切到这一组")
      + item("rename", "重命名")
      + item("duplicate", "再添加一个")
      + item("import", "导入成员")
      + `<span class="dd-tabmenu-sep"></span>`
      + item("remove", "删除这一组", { danger: true, disabled: lastOne })
      + `</div>`;
  }

  /** 执行菜单动作。target 是**被右键那套**（tabMenu.id），不是当前那套。 */
  async function runTabMenuAction(act) {
    if (!tabMenu) return;
    const id = tabMenu.id;
    if (act === "import") { tabMenu = { ...tabMenu, step: "import" }; return paint(); }
    if (act === "back") { tabMenu = { ...tabMenu, step: "" }; return paint(); }
    const target = state.groups.find((g) => g.id === id);
    tabMenu = null;
    if (!target) return paint();
    if (act === "switch") {
      await setActiveGroup(id);
      return paint();
    }
    if (act === "rename") {
      const next = promptFn(`给「${target.name}」改个名字`, target.name);
      if (next != null && next.trim()) await renameGroup(id, next);
      return paint();
    }
    if (act === "duplicate") {
      const created = await duplicateGroup(id);
      if (!created) { await paint(); tide.notify(`最多 ${GROUP_MAX} 套轮换，先删掉不用的`); return; }
      await paint();
      const next = promptFn("给复制出来的这套改个名字", created.name);
      if (next != null && next.trim()) await renameGroup(created.id, next);
      await paint();
      tide.notify(`已复制出「${(state.groups.find((g) => g.id === created.id) || created).name}」，成员和规则都带过来了`);
      return;
    }
    if (act === "remove") {
      if (state.groups.length <= 1) { await paint(); tide.notify("至少要留一套轮换"); return; }
      if (!confirmFn(`删除轮换「${target.name}」？\n\n它的成员、换人记录和提醒设置会一起删掉。`)) return paint();
      const name = target.name;
      if (await removeGroup(id)) tide.notify(`已删除轮换「${name}」`);
      return paint();
    }
    paint();
  }

  /** 二级菜单选中某个源组 → 导进被右键那套。 */
  async function importFromMenu(sourceId) {
    const targetId = tabMenu ? tabMenu.id : state.activeId;
    tabMenu = null;
    const n = await importMembers(targetId, sourceId);
    await paint();
    const target = state.groups.find((g) => g.id === targetId);
    tide.notify(n
      ? `已给「${target ? target.name : "这套轮换"}」导入 ${n} 位成员，顺序在「成员 · 轮换顺序」里调`
      : `那套轮换的人已经都在「${target ? target.name : "这套轮换"}」里了`);
  }

  /* ── 加入今日任务 ── */
  /** 把这一组本轮的人做成一条今天的任务（多人用「、」连接）。同日同名的未完成任务视为重复。 */
  async function addTodayTask(g) {
    if (!g) return null;
    const today = tide.util.today();
    const all = assigneesFor(g, today);
    if (!all.length) { tide.notify("这一组还没有当班安排"); return null; }
    const names = all.map((m) => m.name).join("、");
    const location = locationAt(g, today);
    const title = `${g.name} · ${names}${location ? ` · ${location}` : ""}`;
    const dup = (await tide.tasks.list()).find((t) => !t.done && t.due === today && t.title === title);
    if (dup) { tide.notify(`今天的「${title}」任务已经在列表里了`); return null; }
    try {
      const created = tide.tasks.create({ title, due: today, quad: 2, estMin: 15, tags: [g.name] });
      tide.notify(`已把「${title}」加进今天的任务`);
      return created;
    } catch (e) {
      tide.notify(`加入任务失败：${e.message || e}`);
      return null;
    }
  }

  /* ── 交互绑定：每次 paint() 后重绑（节点都是新的） ── */
  /** 标签右键菜单的接线。paint() 会重建节点，所以标签上的监听每次重绑、
      document 上的收起监听用 tabMenuDismissBound 闸门只绑一次。 */
  function bindTabMenu() {
    const list = root.querySelector(".dd-glist");
    // 只对标签压掉浏览器原生菜单；别处保留（右键往输入框里粘贴还用得上）。
    list?.addEventListener("contextmenu", (e) => {
      const tab = e.target?.closest?.("[data-group]");
      if (!tab) return;
      e.preventDefault();
      openTabMenu(tab.dataset.group, e.clientX, e.clientY);
    });
    // Android WebView 长按普通按钮不会触发 contextmenu，只能自己数时间。
    // 按下后挪开 10px 以上算滑动，不该弹菜单。
    let pressTimer = null;
    let pressAt = null;
    const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    list?.addEventListener("pointerdown", (e) => {
      const tab = e.target?.closest?.("[data-group]");
      clearPress();
      // 新的一次按下就是新意图：清掉上一次长按可能残留的标志，否则它会白吞掉一次正常点击
      longPressed = false;
      if (!tab || e.button === 2) return;
      pressAt = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        openTabMenu(tab.dataset.group, pressAt.x, pressAt.y);
      }, LONG_PRESS_MS);
    });
    list?.addEventListener("pointermove", (e) => {
      if (!pressTimer || !pressAt) return;
      if (Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) clearPress();
    });
    list?.addEventListener("pointerup", clearPress);
    list?.addEventListener("pointercancel", clearPress);

    root.querySelectorAll("[data-tab-act]").forEach((btn) => btn.addEventListener("click", () => {
      runTabMenuAction(btn.dataset.tabAct).catch((e) => tide.notify(`操作失败：${e.message || e}`));
    }));
    root.querySelectorAll("[data-import-from]").forEach((btn) => btn.addEventListener("click", () => {
      importFromMenu(btn.dataset.importFrom).catch((e) => tide.notify(`导入失败：${e.message || e}`));
    }));

    if (tabMenuDismissBound) return;
    tabMenuDismissBound = true;
    document.addEventListener("pointerdown", (e) => {
      const t = e.target;
      // 点菜单自身留给 click；点标签交给 contextmenu 重新定位
      if (t && typeof t.closest === "function" && (t.closest("[data-tab-menu]") || t.closest("[data-group]"))) return;
      if (e.button === 2) return;
      closeTabMenu();
    }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTabMenu(); });
    document.addEventListener("scroll", () => closeTabMenu(), true);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", () => closeTabMenu());
    }
  }

  function bind() {
    const q = (sel) => root.querySelector(sel);
    const g = activeGroup();
    if (!g) return;
    const commit = async (mutate) => { mutate(); await save(); await paint(); };

    q("[data-pause-add]")?.addEventListener("click", async () => {
      const start = q("[data-pause-start]").value, end = q("[data-pause-end]").value;
      if (!validDate(start) || !validDate(end) || start > end) { tide.notify("请选择有效的开始和结束日期，结束不能早于开始"); return; }
      await commit(() => { g.pauseRanges = pauseRanges([...g.pauseRanges, { start, end }]); });
    });
    root.querySelectorAll("[data-pause-del]").forEach(btn => btn.addEventListener("click", async () => {
      await commit(() => { g.pauseRanges.splice(Number(btn.dataset.pauseDel), 1); });
    }));
    // 切换 / 新建 / 改名 / 删除轮换
    root.querySelectorAll("[data-group]").forEach((btn) => btn.addEventListener("click", async () => {
      if (longPressed) { longPressed = false; return; }   // 长按弹过菜单，这个 click 是它的尾巴
      // 菜单开着时点标签 = 切组 + 收掉浮层。document 上的收起监听刻意放过标签点击，
      // 所以这里不收就没人收 —— 屏幕上会留下一个指着旧组的菜单。
      const closing = !!tabMenu;
      tabMenu = null;
      const switched = await setActiveGroup(btn.dataset.group);
      if (switched || closing) await paint();
    }));
    bindTabMenu();
    q("[data-group-new]")?.addEventListener("click", async () => {
      const created = await addGroup();
      if (!created) { tide.notify(`最多 ${GROUP_MAX} 套轮换，先删掉不用的`); return; }
      await paint();
      tide.notify(`已新建「${created.name}」——在「轮换规则」里改名，再加成员`);
    });
    q("[data-group-name]")?.addEventListener("change", async () => {
      const input = q("[data-group-name]");
      const next = String(input.value || "").trim().slice(0, NAME_MAX) || DEFAULT_GROUP_NAME;
      if (!await renameGroup(g.id, next)) { input.value = g.name; return; }
      await paint();
    });
    q("[data-group-del]")?.addEventListener("click", async () => {
      if (state.groups.length <= 1) { tide.notify("至少要留一套轮换"); return; }
      if (!confirmFn(`删除轮换「${g.name}」？\n\n它的成员、换人记录和提醒设置会一起删掉。`)) return;
      const name = g.name;
      if (!await removeGroup(g.id)) return;
      await paint();
      tide.notify(`已删除轮换「${name}」`);
    });

    // 成员：改名 / 排序 / 移除
    bindMemberDrag(g, commit);
    root.querySelectorAll(".dd-mrow").forEach((row) => {
      const id = row.dataset.id;
      const idx = g.members.findIndex((m) => m.id === id);
      if (idx < 0) return;
      const nameIn = row.querySelector("[data-name]");
      nameIn?.addEventListener("change", async () => {
        const next = String(nameIn.value || "").trim().slice(0, MEMBER_MAX) || g.members[idx].name;
        if (next === g.members[idx].name) { nameIn.value = next; return; }
        await commit(() => { g.members[idx].name = next; });
      });
      row.querySelector("[data-up]")?.addEventListener("click", async () => {
        if (idx <= 0) return;
        await commit(() => { const [m] = g.members.splice(idx, 1); g.members.splice(idx - 1, 0, m); });
      });
      row.querySelector("[data-down]")?.addEventListener("click", async () => {
        if (idx >= g.members.length - 1) return;
        await commit(() => { const [m] = g.members.splice(idx, 1); g.members.splice(idx + 1, 0, m); });
      });
      row.querySelector("[data-del]")?.addEventListener("click", async () => {
        const m = g.members[idx];
        if (!m) return;
        await commit(() => {
          g.members.splice(idx, 1);
          g.removed = [{ id: m.id, name: m.name }, ...g.removed.filter((x) => x.id !== m.id)].slice(0, REMOVED_KEEP);
          // 清掉指向他的换人记录，避免出现「换给一个已经不在名单里的人」。
          // override 值有双格式：单人字符串直接删；多人数组里滤掉他，滤空了整个键也删掉。
          for (const [k, v] of Object.entries(g.overrides)) {
            if (Array.isArray(v)) {
              const next = v.filter((x) => x !== m.id);
              if (next.length) g.overrides[k] = next; else delete g.overrides[k];
            } else if (v === m.id) delete g.overrides[k];
          }
        });
        tide.notify(`已把「${m.name}」移出轮换，可在「恢复已移除」里找回`);
      });
    });

    // 添加成员
    const addMember = async () => {
      const input = q("[data-new]");
      const name = String(input?.value || "").trim().slice(0, MEMBER_MAX);
      if (!name) { tide.notify("先输入名字再添加"); input?.focus(); return; }
      await commit(() => { g.members.push({ id: uid("m"), name }); });
    };
    q("[data-add]")?.addEventListener("click", addMember);
    q("[data-new]")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addMember(); } });

    // 恢复已移除
    q("[data-restore]")?.addEventListener("click", async () => {
      const back = g.removed.slice().reverse();
      await commit(() => {
        const ids = new Set(g.members.map((m) => m.id));
        for (const m of back) if (!ids.has(m.id)) g.members.push({ id: m.id, name: m.name });
        g.removed = [];
      });
      tide.notify(`已恢复 ${back.length} 位成员`);
    });

    // 规则
    q("[data-start]")?.addEventListener("change", async () => {
      const input = q("[data-start]");
      if (!validDate(input.value)) { tide.notify("起始日期无效，已保留原值"); await paint(); return; }
      await commit(() => { g.startDate = input.value; });
    });
    q("[data-start-today]")?.addEventListener("click", async () => {
      await commit(() => { g.startDate = tide.util.today(); });
    });
    root.querySelectorAll("[data-period]").forEach((btn) => btn.addEventListener("click", async () => {
      const p = Math.max(1, Math.round(Number(btn.dataset.period) || 7));
      if (p === periodOf(g)) return;
      await commit(() => { g.periodDays = p; });
    }));
    q("[data-period-custom]")?.addEventListener("change", async () => {
      const input = q("[data-period-custom]");
      const raw = Math.round(Number(input.value));
      if (!Number.isFinite(raw) || raw < 1 || raw > 365) { tide.notify("周期请填 1～365 天"); await paint(); return; }
      await commit(() => { g.periodDays = raw; });
    });

    root.querySelectorAll("[data-location-period]").forEach((btn) => btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.locationPeriod);
      if (days !== g.locationPeriodDays) await commit(() => { g.locationPeriodDays = days; });
    }));
    q("[data-location-period-custom]")?.addEventListener("change", async (e) => {
      const raw = Number(e.currentTarget.value);
      if (!Number.isInteger(raw) || raw < 1 || raw > 365) { tide.notify("地点周期请填 1～365 天"); await paint(); return; }
      await commit(() => { g.locationPeriodDays = raw; });
    });
    const addLocation = async () => {
      const input = q("[data-location-new]");
      const name = String(input?.value || "").trim().slice(0, LOCATION_NAME_MAX);
      if (!name) { tide.notify("先输入地点名称"); input?.focus(); return; }
      if (g.locations.includes(name)) { tide.notify("这个地点已经在列表中"); return; }
      if (g.locations.length >= LOCATION_MAX) { tide.notify(`最多 ${LOCATION_MAX} 个地点`); return; }
      await commit(() => { g.locations.push(name); });
    };
    q("[data-location-add]")?.addEventListener("click", addLocation);
    q("[data-location-new]")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addLocation(); } });
    root.querySelectorAll("[data-location-index]").forEach((row) => {
      const index = Number(row.dataset.locationIndex);
      row.querySelector("[data-location-name]")?.addEventListener("change", async (e) => {
        const name = String(e.currentTarget.value || "").trim().slice(0, LOCATION_NAME_MAX);
        if (!name || g.locations.some((item, i) => i !== index && item === name)) { tide.notify("地点名称不能为空或重复"); await paint(); return; }
        await commit(() => { g.locations[index] = name; });
      });
      row.querySelector("[data-location-up]")?.addEventListener("click", async () => {
        if (index > 0) await commit(() => { [g.locations[index - 1], g.locations[index]] = [g.locations[index], g.locations[index - 1]]; });
      });
      row.querySelector("[data-location-down]")?.addEventListener("click", async () => {
        if (index < g.locations.length - 1) await commit(() => { [g.locations[index + 1], g.locations[index]] = [g.locations[index], g.locations[index + 1]]; });
      });
      row.querySelector("[data-location-del]")?.addEventListener("click", async () => {
        await commit(() => { g.locations.splice(index, 1); });
      });
    });

    // 每轮人数（多人值日）
    root.querySelectorAll("[data-perround]").forEach((btn) => btn.addEventListener("click", async () => {
      const n = Math.max(1, Math.round(Number(btn.dataset.perround) || 1));
      if (n === perRoundOf(g)) return;
      await commit(() => { g.perRound = n; });
    }));
    q("[data-perround-custom]")?.addEventListener("change", async () => {
      const input = q("[data-perround-custom]");
      const raw = Math.round(Number(input.value));
      if (!Number.isFinite(raw) || raw < 1 || raw > MEMBER_MAX) { tide.notify(`每轮人数请填 1～${MEMBER_MAX}`); await paint(); return; }
      await commit(() => { g.perRound = raw; });
    });

    // 提醒
    q("[data-remind]")?.addEventListener("change", async (e) => {
      const on = !!e.currentTarget.checked;
      await commit(() => { g.remindEnabled = on; });
      tide.notify(on ? `「${g.name}」提醒已开启` : `「${g.name}」提醒已关闭`);
    });
    q("[data-time]")?.addEventListener("change", async () => {
      const input = q("[data-time]");
      const t = normalizeTime(input.value);
      if (!t) { tide.notify("提醒时刻无效（时 0–23、分 0–59），已保留原值"); await paint(); return; }
      await commit(() => { g.remindTime = t; });
    });
    q("[data-sound]")?.addEventListener("change", async () => {
      const input = q("[data-sound]");
      await commit(() => { g.sound = input.value; });
      playSound(input.value);
    });
    q("[data-sound-try]")?.addEventListener("click", () => playSound(g.sound));
    q("[data-test]")?.addEventListener("click", () => {
      const names = assigneesFor(g, tide.util.today()).map((m) => m.name).join("、");
      const location = locationAt(g, tide.util.today());
      tide.notify(names ? `提醒测试：「${g.name}」今天轮到 ${names}${location ? ` · 地点：${location}` : ""}` : `提醒测试：「${g.name}」还没有成员，正式提醒时会跳过`);
      playSound(g.sound);
    });

    // 本轮换人：勾选式多选 / 撤销
    root.querySelectorAll("[data-swap-pick]").forEach((chip) => chip.addEventListener("click", () => {
      const on = chip.classList.toggle("on");
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    }));
    q("[data-swap-apply]")?.addEventListener("click", async () => {
      const picks = [...root.querySelectorAll("[data-swap-pick].on")].map((el) => el.dataset.swapPick);
      const members = picks.map((id) => g.members.find((m) => m.id === id)).filter(Boolean);
      if (!members.length) { tide.notify("先勾选本轮当班的人（至少一位）"); return; }
      const s = snapshot(g);
      const key = s.cycle || g.startDate;
      // 与本轮现在的名单完全一致就不写 —— 避免把「正常排班」固化成 override
      const activeIds = (overrideHits(g, s.cycle).length ? overrideHits(g, s.cycle) : s.currentAll).map((m) => m.id).join(",");
      const nextIds = members.map((m) => m.id).join(",");
      if (nextIds === activeIds) { tide.notify("勾选的就是本轮当班的名单，没有变化"); return; }
      // 单人存字符串（历史格式，旧版本客户端也能读）；多人才存数组
      const value = members.length === 1 ? members[0].id : members.map((m) => m.id);
      const now = currentTimeString();
      await commit(() => { g.overrides[key] = value; g.remindTime = now; if (g.lastNotified === s.today) g.lastNotified = ""; });
      tide.notify(`「${g.name}」本轮改由 ${members.map((m) => m.name).join("、")} 当班，提醒时刻已改为 ${now}`);
    });
    q("[data-swap-clear]")?.addEventListener("click", async () => {
      const s = snapshot(g);
      const key = s.cycle || g.startDate;
      await commit(() => { delete g.overrides[key]; });
      tide.notify("已撤销本轮换人");
    });

    // 加入今日任务
    q("[data-task]")?.addEventListener("click", () => { addTodayTask(g); });

    // 看今天：滚到本轮那行
    q("[data-today]")?.addEventListener("click", () => {
      root.querySelector(".dd-row.now")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  let bootPromise = null;

  function render(el) {
    ensureStyle();
    root = el;
    // 首绘必须等 boot() 读完 storage：render() 可能早于插件初始化完成（宿主渲染视图 vs 模块启动），
    // 直接 paint() 会拿着空 members 画出「先添加成员」的空态，而且之后没人再重绘。
    el.innerHTML = `<div class="dd-wrap"><section class="dd-card"><div class="dd-muted">正在读取轮换设置…</div></section></div>`;
    boot()
      .then(() => { if (root === el) paint(); })
      .catch((e) => {
        if (root !== el) return;
        el.innerHTML = `<div class="dd-wrap"><section class="dd-card"><div class="dd-title dd-err">轮换设置读取失败</div><div class="dd-muted">${esc(e?.message || e)}</div><div class="dd-actions"><button class="dd-btn pri" data-retry type="button">重试</button></div></section></div>`;
        el.querySelector("[data-retry]")?.addEventListener("click", () => { bootPromise = null; render(el); });
      });
    return () => { if (root === el) root = null; };
  }

  tide.ui.registerView({ id: VIEW_ID, title: "轮换值日", icon: "broom", render });

  /* 启动：读配置 → 领代号（顶掉旧实例的定时器）→ 起定时器 → 立刻查一次（补当天已过点的提醒） */
  function boot() {
    if (!bootPromise) bootPromise = (async () => {
      await load();
      MY_GEN = (Number(await tide.storage.get("gen", 0)) || 0) + 1;
      await tide.storage.set("gen", MY_GEN);
      startTimer();
      await tick();
    })();
    return bootPromise;
  }
  boot().catch((e) => console.warn("dorm-duty: 初始化失败", e));
})();
