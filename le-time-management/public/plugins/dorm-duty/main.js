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

  /* ── 3D 宿舍床位星图（4 / 6 / 8 人间）──
     世界坐标是「米、右手系、y 向上」，房间占 x∈[0,w] y∈[0,H] z∈[0,d]。一台球形轨道的
     透视相机把星点投影成 SVG/DOM 坐标：星星是绝对定位的 DOM（CSS 3D 的透视会把星星上的
     名字和数字一起压扁发虚），铺板与立柱是 SVG 多边形/线段，用 vector-effect:non-scaling-stroke
     保证线宽不随容器缩放糊掉。**刻意不引 three.js** —— 场景就是十几颗星加几十条线，
     自己投影还能让文字保持清晰、体积极小。
     **不画地板与墙**：按整间房取景会把一半画面让给地板和空气，星图缩成中间一小团
     （实测星距从 57px 掉到 21px）。取景只认「真正画出来的东西」，见 roomBounds()。

     摆法照用户原型稿：上下铺贴着左右两面墙面对面摆，每面墙最多两张，铺间留缝，
     中间是过道（不是沿后墙一字排开）。相机可绕房间转：立体 / 俯视 / 正视三个档位，
     也能直接拖动，滚轮缩放。工具栏还有「自动旋转」与「显示床铺」两个开关 ——
     后者关掉就只剩星星与连线（原型稿 3D 版就是这个观感）。

     同一张铺的上下两颗星**沿铺宽略微错开**（±ROOM_BUNK_SPLIT），并且上铺实心星、
     下铺空心星：俯视时两颗星只靠高度差会完全重合，错开之后任何视角都分得开。
     这是「示意错开」，不是真实床位坐标 —— 图注里写明了。

     序号 = 成员在名单里的位次（与「成员 · 轮换顺序」里的数字同源）：每张铺先下铺后上铺，
     铺位按「绕房间一圈」排序（左墙由前往后、右墙由后往前），连线才是一条像值日路线的环。

     ⚠️ 改 ROOM_* 常量后必须重跑 scripts/test-dorm-duty.mjs 的星图用例 —— 它钉住了
     「星点不出 NaN」「同铺上下能分开」「不同铺不重叠」「连线点数 = 宿舍人数」。
     ⚠️ 容器比例由 roomBox() 一份事实源决定（宽屏 140×105 / 手机 105×140），
     SVG 的 viewBox 与星星的百分比都从它算 —— 两处各写一份就会错位。 */
  const ROOM_SIZES = [0, 4, 6, 8];   // 0 = 关掉这张图
  const ROOM_DEFAULT = 4;            // 新组的默认值
  const ROOM_BED_L = 2.0;            // 铺长（沿墙，z）
  const ROOM_BED_W = 1.0;            // 铺宽（进深，x）
  const ROOM_GAP = 0.35;             // 铺与铺之间 / 铺与墙之间的缝
  const ROOM_AISLE = 1.30;           // 中间过道净宽
  const ROOM_SLAB_LOW = 0.55;        // 下铺床面高（常见实测：床板 0.32 + 床垫）
  const ROOM_SLAB_UP = 1.98;         // 上铺床面高（常见实测：床板 1.75 + 床垫）
  const ROOM_STAR_LIFT = 0.10;       // 星星比床面再高一点，别压在铺板线上
  const ROOM_BUNK_SPLIT = 0.34;      // 上下铺两颗星沿铺宽错开多少（俯视时靠它分开）
  const ROOM_FOV = 0.785;            // 透视竖视角（45°）
  // 相机距离 = 包围球半径 × 这个数。**别往下调**：调小画面大一点，但相机会更贴，
  // 透视畸变随之变大 —— 畸变会把「上下铺错开」那点位移在屏幕中心附近抵消掉
  // （屏幕位移 ≈ (屏幕坐标−中心)·Δ/zc + F·错开/zc，第一项与焦距无关、只由 zc 决定）。
  const ROOM_FIT = 2.65;
  /* 取景框（横竖「一个单位」等长，比例才不会随容器变形）。
     宽屏用横版 4:3；手机用**竖版** —— 房间本身「窄而长」，塞进 322×242 的横版卡片里星图
     只占中间一小块，相邻两颗星只剩 21px、名字必然互压（实测 360px 宽、6/8 人间必现）。
     换竖版后同一批星能占到 1.8 倍的长度，实测星距 21px → 38px。
     容器 aspect-ratio 由 roomHtml() 用同一个 box 内联写死；CSS 里那份只是无 JS 时的兜底。 */
  const ROOM_BOX_WIDE = { w: 140, h: 105 };
  const ROOM_BOX_NARROW = { w: 105, h: 140 };
  const ROOM_SPIN_STEP = 0.0032;     // 自动旋转每帧转多少弧度（≈65 秒一圈）
  /* 三个机位。角度是拿 .tmp 探针扫过 th×ph 网格挑的：
     · 方位角刻意避开「正对房间对角线」—— 那个角度上「前左低铺」与「后右高铺」
       会在屏幕上叠成一个点（实测只剩 10px）；
     · 俯视不贴到 ph=0：会撞上万向节死锁，相机 up 向量算不出来，而且上下铺完全重合。 */
  const ROOM_VIEWS = [
    { id: "solid", label: "立体", th: 0.42, ph: 0.80 },
    { id: "top", label: "俯视", th: 0.10, ph: 0.24 },
    { id: "side", label: "正视", th: 0.42, ph: 1.22 },
  ];
  const ROOM_VIEW_DEFAULT = "solid";
  /* 五角星路径（viewBox -50 -50 100 100，外径 50 / 内径 21）。
     用内联 SVG 而不是 CSS clip-path，是为了用同一份路径画出「上铺实心 / 下铺空心」两态 ——
     clip-path 只能填充，画不出描边。 */
  const ROOM_STAR_PTS = "0,-50 12.34,-16.99 47.55,-15.45 19.97,6.49 29.39,40.45 0,21 -29.39,40.45 -19.97,6.49 -47.55,-15.45 -12.34,-16.99";

  const state = {
    groups: [],       // 多套轮换；顺序即界面上标签的顺序
    activeId: "",     // 当前选中的那套
    soundPresets: [], // 宿主音效目录（只取一次，供下拉用）
    timer: null,
    gen: 0,
    busy: false,
    membersOrderKey: "",
    // 星图的观察位（跨轮换共用一套）：档位 / 自动旋转 / 拖出来的角度 / 缩放 / 要不要画铺位线框。
    // 卫生起见存成对象而不是散在 state 上 —— roomView() 会逐字段挡脏值。
    roomView: { view: ROOM_VIEW_DEFAULT, spin: true, th: NaN, ph: NaN, dist: 1, beds: true },
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
      roomSize: ROOM_DEFAULT,
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
    // 宿舍床位数：只认 0（关闭）/ 4 / 6 / 8。认了别的数会让星图画不出铺位。
    g.roomSize = normalizeRoomSize(g.roomSize);
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
    const [groups, activeId, legacyMembers, legacyConfig, legacyOverrides, legacyRemoved, legacyLast, gen, roomView] = await Promise.all([
      tide.storage.get("groups", null),
      tide.storage.get("activeId", ""),
      tide.storage.get("members", null),
      tide.storage.get("config", null),
      tide.storage.get("overrides", null),
      tide.storage.get("removed", null),
      tide.storage.get("lastNotified", null),
      tide.storage.get("gen", 0),
      tide.storage.get("roomView", null),
    ]);
    // 星图视角是「看的人的习惯」，不是某一套轮换的属性 —— 共用一份，缺字段由 roomView() 兜。
    state.roomView = roomView && typeof roomView === "object" && !Array.isArray(roomView)
      ? { ...state.roomView, ...roomView } : state.roomView;
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
      tide.storage.set("roomView", state.roomView),
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
      /* ── 3D 宿舍床位星图 ──
         SVG 与星星共用同一套取景框坐标：SVG 的 viewBox 是 0 0 140 105，容器 aspect-ratio
         也是 4:3 ⇒ 横竖「一个单位」等长，星星按百分比定位与线端严格重合。
         比例由 roomHtml() 内联写死（同一份 roomBox()），这里的 4/3 只是无 JS 时的兜底。
         touch-action:pan-y 是刻意选的：手机上左右拖转视角、上下拖还能滚页面 ——
         把整张卡片变成「滚不动的黑洞」在这么长的设置页里很难受。 */
      .dd-room-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:calc(14px * var(--ui-text-scale));font-weight:750;margin-bottom:10px}
      .dd-room-sizes{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
      .dd-room-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
      .dd-room-views{display:flex;gap:6px}
      .dd-chip-sm{height:28px;padding:0 11px;font-size:calc(11.5px * var(--ui-text-scale))}
      .dd-room-spin{display:inline-flex;align-items:center;gap:6px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);cursor:pointer;user-select:none}
      .dd-room-spin input{accent-color:var(--deep,#0F4C5C);width:14px;height:14px;margin:0}
      .dd-room-hint{margin-left:auto;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A1A9AF)}
      .dd-room{position:relative;aspect-ratio:4/3;min-height:240px;border-radius:16px;overflow:hidden;
        touch-action:pan-y;cursor:grab;
        border:1px solid color-mix(in srgb,var(--line,#E4DFD6) 78%,transparent);
        background:
          radial-gradient(130% 82% at 50% 2%,color-mix(in srgb,var(--deep,#0F4C5C) 15%,transparent),transparent 66%),
          linear-gradient(180deg,color-mix(in srgb,var(--ink,#22303A) 7%,transparent),transparent 74%);
        --dd-bed:30px;--dd-star:#8f63b8}
      .dd-room.dragging{cursor:grabbing}
      :root[data-theme-mode="dark"] .dd-room{--dd-star:#e8d5ff}
      .dd-room-svg{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
      .dd-room-svg *{vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
      .dd-room-slab{fill:color-mix(in srgb,var(--dd-star) 14%,transparent);stroke:color-mix(in srgb,var(--dd-star) 38%,transparent);stroke-width:1}
      .dd-room-post{fill:none;stroke:color-mix(in srgb,var(--dd-star) 26%,transparent);stroke-width:1;stroke-dasharray:2 3}
      /* 「显示床铺」关掉时只留星星与连线（原型稿 3D 版就是这个观感）。
         用 display:none 而不是不生成元素 —— roomDraw() 原地重画的那条路就不用分叉，
         而且取景范围仍然按「含铺位」算（见 roomBounds），开关不会让星星跳位置。 */
      .dd-room[data-room-beds="off"] :is(.dd-room-slab,.dd-room-post){display:none}
      .dd-room-flow{fill:none;stroke:color-mix(in srgb,var(--dd-star) 92%,transparent);stroke-width:1.6;stroke-dasharray:5 7;animation:dd-flow 1.05s linear infinite}
      .dd-room-loop{fill:none;stroke:color-mix(in srgb,var(--dd-star) 42%,transparent);stroke-width:1.2;stroke-dasharray:2 6}
      @keyframes dd-flow{to{stroke-dashoffset:-12}}
      /* 按钮的盒子必须**正好等于星星**：名字是绝对定位的（脱流），否则按钮会被名字撑宽撑高，
         translate(-50%,-50%) 的落点就从星星中心偏到「星星 + 名字」这个整体的中心，
         连线端点会与星星差出半个名字的高度（实测 9px）。 */
      .dd-bed{position:absolute;z-index:2;display:block;padding:0;border:0;background:none;font:inherit;color:inherit;
        cursor:pointer;transform:translate(-50%,-50%);transition:transform .15s ease;
        width:calc(var(--dd-bed) * var(--k,1));height:calc(var(--dd-bed) * var(--k,1))}
      .dd-bed:hover:not(.empty),.dd-bed:focus-visible{transform:translate(-50%,-50%) scale(1.09)}
      .dd-bed:focus-visible{outline:2px solid var(--deep,#0F4C5C);outline-offset:4px;border-radius:12px}
      .dd-bed-star{position:relative;display:block;width:100%;height:100%}
      /* 星星是内联 SVG 而不是 CSS clip-path：只有 SVG 才能用同一份路径画出「实心 / 空心」两态
         （上铺实心、下铺空心，颜色统一），clip-path 做不到描边。 */
      .dd-bed-glyph{display:block;width:100%;height:100%;overflow:visible;
        filter:drop-shadow(0 0 6px color-mix(in srgb,var(--dd-star) 85%,transparent));
        animation:dd-twinkle 4.2s ease-in-out var(--phase,0s) infinite alternate}
      .dd-bed-glyph polygon{fill:var(--dd-star);stroke:var(--dd-star);stroke-width:10}
      .dd-bed.down .dd-bed-glyph polygon{fill:none;stroke-width:9}
      @keyframes dd-twinkle{from{opacity:.72}to{opacity:1}}
      .dd-bed-no{position:absolute;top:0;right:0;transform:translate(34%,-46%);min-width:17px;height:17px;padding:0 4px;
        border-radius:999px;background:var(--deep,#0F4C5C);color:var(--on-deep,#fff);text-align:center;line-height:17px;
        font-size:calc(10.5px * var(--ui-text-scale));font-weight:800;font-variant-numeric:tabular-nums;
        box-shadow:0 0 0 2px color-mix(in srgb,var(--panel,#fff) 72%,transparent)}
      /* 名字脱流挂在星星外侧：上铺挂上方、下铺挂下方（.dd-bed.up 那一支）。
         不只是好看 —— 侧视下同一张铺的两颗星几乎竖直相叠，两颗名字都挂下方会互相压住
         （实测 ≤380px 宽必现）。分开挂之后互不遮挡，顺带把「哪颗是上铺」也画清楚了。 */
      .dd-bed-name{position:absolute;left:50%;top:calc(100% + 2px);transform:translateX(-50%);
        max-width:4.8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 5px;border-radius:6px;
        font-size:calc(11px * var(--ui-text-scale));font-weight:650;line-height:1.5;
        background:color-mix(in srgb,var(--panel,#fff) 66%,transparent);color:var(--ink,#22303A)}
      .dd-bed.up .dd-bed-name{top:auto;bottom:calc(100% + 2px)}
      /* 今天当班的星星：绿色 + 一圈虚线轨道。跟成员列表里的绿色描边同源（--mint）。 */
      .dd-bed.now{z-index:3}
      .dd-bed.now .dd-bed-glyph polygon{fill:var(--mint,#2EC4B6);stroke:var(--mint,#2EC4B6)}
      .dd-bed.now.down .dd-bed-glyph polygon{fill:none}
      .dd-bed.now .dd-bed-glyph{filter:drop-shadow(0 0 10px color-mix(in srgb,var(--mint,#2EC4B6) 90%,transparent))}
      .dd-bed.now .dd-bed-star::after{content:"";position:absolute;inset:-7px;border-radius:50%;
        border:1.5px dashed color-mix(in srgb,var(--mint,#2EC4B6) 80%,transparent);animation:dd-orbit 16s linear infinite}
      @keyframes dd-orbit{to{transform:rotate(360deg)}}
      .dd-bed.now .dd-bed-no{background:var(--mint,#2EC4B6);color:var(--deep,#0F4C5C)}
      .dd-bed.now .dd-bed-name{background:color-mix(in srgb,var(--mint,#2EC4B6) 26%,var(--panel,#fff));color:var(--deep,#0F4C5C);font-weight:750}
      .dd-bed.empty{cursor:default}
      .dd-bed.empty .dd-bed-glyph{opacity:.3;filter:none;animation:none}
      .dd-bed.empty .dd-bed-no{background:color-mix(in srgb,var(--deep,#0F4C5C) 32%,transparent);box-shadow:none}
      .dd-bed.empty .dd-bed-name{background:transparent;color:var(--ink-3,#A1A9AF);font-weight:600}
      /* 点星星 → 成员列表里对应那行闪一下，用来回答「3 号是谁」。 */
      .dd-mrow.dd-flash{background:color-mix(in srgb,var(--mint,#2EC4B6) 18%,transparent);border-radius:10px;transition:background .25s ease}
      /* nephele 星空背景开着时把卡片让成透光薄层，把整幅星图交还给背景；关掉则退回普通卡片。 */
      :root[data-nephele-background="on"] .dd-room-card{background:color-mix(in srgb,var(--panel,#fff) 30%,transparent);
        border-color:color-mix(in srgb,var(--line,#E4DFD6) 58%,transparent);backdrop-filter:blur(3px) saturate(1.08)}
      :root[data-nephele-background="on"] .dd-room{background:radial-gradient(130% 82% at 50% 2%,color-mix(in srgb,var(--deep,#0F4C5C) 11%,transparent),transparent 66%)}
      :root[data-nephele-background="on"] .dd-bed-name{background:color-mix(in srgb,var(--panel,#fff) 44%,transparent)}
      /* 减少动效：连线的流动、星星闪烁与轨道一律停；尊重应用设置与系统偏好两条路。
         （自动旋转另有 roomReduceMotion() 在 JS 侧拦一道，两条路都拦才拦得住。） */
      :root[data-ui-motion="reduced"] .dd-room-flow,
      :root[data-ui-motion="reduced"] .dd-bed-glyph,
      :root[data-ui-motion="reduced"] .dd-bed.now .dd-bed-star::after{animation:none}
      :root:not([data-ui-motion="full"]) .dd-room-flow,
      :root:not([data-ui-motion="full"]) .dd-bed-glyph,
      :root:not([data-ui-motion="full"]) .dd-bed.now .dd-bed-star::after{animation-play-state:paused}
      @media (prefers-reduced-motion: reduce){
        :root:not([data-ui-motion="full"]) .dd-room *{animation-play-state:paused}
      }
      @media(max-width:720px){
        .dd-room{--dd-bed:26px}
        .dd-room-sizes{margin-left:0}
        .dd-room-hint{display:none}
        /* 窄屏上星星只有 22px 左右，名字必须跟着收 —— 不收的话相邻两颗星的名字会互相压
           （实测 360px 宽、8 人间时必现）。数字一直挂在星上，认人靠数字也认得出来。 */
        .dd-bed-name{font-size:calc(10px * var(--ui-text-scale));max-width:3.2em;padding:0 4px}
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

  /* ── 3D 宿舍床位星图 ── */
  /** 宿舍人数归一化：没设过（老数据 / null / 空串）或认不出的值一律退回默认档；
      0 是「明确关掉」，与「没设过」区分开。 */
  function normalizeRoomSize(v) {
    const s = v == null ? "" : String(v).trim();
    if (!s) return ROOM_DEFAULT;
    const n = Math.round(Number(s));
    return ROOM_SIZES.includes(n) ? n : ROOM_DEFAULT;
  }
  /** 这套轮换的宿舍人数。 */
  const roomSizeOf = (g) => normalizeRoomSize(g && g.roomSize);
  /** 几张上下铺：4/6/8 人 → 2/3/4 张。 */
  const roomBunkCount = (size) => Math.max(1, Math.round(size / 2));
  /** 房间尺寸与左右两面墙各放几张铺。 */
  function roomDims(size) {
    const n = roomBunkCount(size);
    const left = Math.ceil(n / 2), right = n - left;
    const perWall = Math.max(left, right);
    return {
      w: ROOM_BED_W * 2 + ROOM_AISLE,
      d: perWall * ROOM_BED_L + (perWall + 1) * ROOM_GAP,
      left, right,
    };
  }
  /** 每张上下铺落在哪：贴左/右墙、沿墙等距。顺序刻意是「绕房间一圈」
      （左墙由前往后、右墙由后往前）—— 连线才像一条值日路线，而不是来回横穿房间。 */
  function roomBunks(size) {
    const dim = roomDims(size);
    // 某面墙放 n 张铺时**在房间进深里居中**（只有一张的右墙才不会贴到门口那一头，
    // 也不会和另一面墙的某张铺撞在同一个进深上）
    const at = (n, i) => (dim.d - (n - 1) * (ROOM_BED_L + ROOM_GAP)) / 2 + i * (ROOM_BED_L + ROOM_GAP);
    const xLeft = ROOM_GAP + ROOM_BED_W / 2;
    const xRight = dim.w - xLeft;
    const left = Array.from({ length: dim.left }, (_, i) => ({ x: xLeft, z: at(dim.left, i), side: "left" }));
    const right = Array.from({ length: dim.right }, (_, i) => ({ x: xRight, z: at(dim.right, i), side: "right" }));
    return left.concat(right.reverse());
  }
  /** 星点：每张铺先下铺后上铺（序号与成员名单位次一一对应）。
      同一张铺的两颗星沿铺宽**朝房间中间**错开一点：俯视时只靠高度差两颗星会完全重合。 */
  function roomBeds(size) {
    const w = roomDims(size).w;
    const out = [];
    for (const b of roomBunks(size)) {
      const dir = b.x < w / 2 ? 1 : -1;
      out.push({ x: b.x - dir * ROOM_BUNK_SPLIT, y: ROOM_SLAB_LOW + ROOM_STAR_LIFT, z: b.z, level: "lower" });
      out.push({ x: b.x + dir * ROOM_BUNK_SPLIT, y: ROOM_SLAB_UP + ROOM_STAR_LIFT, z: b.z, level: "upper" });
    }
    return out.slice(0, Math.max(0, Math.round(size)));
  }
  /** 相机无关的整间房几何：铺板、立柱、地面、星点。 */
  function roomScene(size) {
    const dim = roomDims(size);
    const bunks = roomBunks(size);
    const hl = ROOM_BED_L / 2, hw = ROOM_BED_W / 2;
    const slab = (b, y) => [
      { x: b.x - hw, y, z: b.z - hl }, { x: b.x + hw, y, z: b.z - hl },
      { x: b.x + hw, y, z: b.z + hl }, { x: b.x - hw, y, z: b.z + hl },
    ];
    const posts = (b) => {
      const out = [];
      for (const sx of [b.x - hw, b.x + hw]) for (const sz of [b.z - hl, b.z + hl]) {
        out.push([{ x: sx, y: ROOM_SLAB_LOW, z: sz }, { x: sx, y: ROOM_SLAB_UP, z: sz }]);
      }
      return out;
    };
    return {
      size, dim, bunks, beds: roomBeds(size),
      slabs: bunks.map((b) => [slab(b, ROOM_SLAB_LOW), slab(b, ROOM_SLAB_UP)]),
      posts: bunks.map(posts),
    };
  }
  /** 取景只认**真正画出来的东西**（星星 + 铺板 + 立柱），不认整间房。
      按房间对角线取景会把一半画面让给地板和空气 —— 星图缩成小小一团；
      不画地板之后相机可以贴得很近，星星之间的间距几乎翻倍。
      ⚠️ 这里**永远把铺板与立柱算进去**，哪怕「显示床铺」已经关掉：不然开关一拨
      取景范围就变，星星会当场跳一下位置。观感开关不该动几何。 */
  function roomBounds(scene) {
    const pts = scene.beds.concat(scene.slabs.flat(2), scene.posts.flat(2));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return {
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
      radius: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
    };
  }

  /* ── 相机：球形轨道 + 透视 ── */
  const clampPh = (ph) => Math.max(0.14, Math.min(Math.PI - 0.14, ph));
  /** 当前视角（档位 + 用户拖出来的角度 + 缩放）。脏值一律退回该档位的默认机位。 */
  /** 当前该用哪个取景框。窗口宽度取不到（Node 单测 / SSR）时按宽版算，逐位可复现。 */
  function roomBox() {
    try {
      const w = Number(window?.innerWidth);
      if (Number.isFinite(w) && w > 0 && w <= 720) return ROOM_BOX_NARROW;
    } catch { /* 没有 window 就用宽版 */ }
    return ROOM_BOX_WIDE;
  }
  function roomView() {
    const raw = state.roomView && typeof state.roomView === "object" ? state.roomView : {};
    const id = ROOM_VIEWS.some((x) => x.id === raw.view) ? raw.view : ROOM_VIEW_DEFAULT;
    const base = ROOM_VIEWS.find((x) => x.id === id);
    const th = Number(raw.th), ph = Number(raw.ph), dist = Number(raw.dist);
    return {
      view: id,
      spin: raw.spin === true,
      // 只有显式关掉才不画铺位（缺席 = 老数据 = 画，跟以前的观感一致）
      beds: raw.beds !== false,
      th: Number.isFinite(th) ? th : base.th,
      ph: Number.isFinite(ph) ? clampPh(ph) : base.ph,
      dist: Number.isFinite(dist) ? Math.max(0.55, Math.min(1.9, dist)) : 1,
    };
  }
  /** 相机三轴（右 / 上 / 前）与镜头到目标的距离。目标点取房间中心偏上一点。 */
  function roomCamera(scene, v, box) {
    const bb = box || roomBox();
    const b = roomBounds(scene);
    const target = b.center;
    const r = b.radius * ROOM_FIT * v.dist;
    const ph = clampPh(v.ph);
    const dir = { x: Math.sin(ph) * Math.sin(v.th), y: Math.cos(ph), z: Math.sin(ph) * Math.cos(v.th) };
    const eye = { x: target.x + dir.x * r, y: target.y + dir.y * r, z: target.z + dir.z * r };
    const fwd = { x: -dir.x, y: -dir.y, z: -dir.z };
    const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const norm = (a) => { const n = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / n, y: a.y / n, z: a.z / n }; };
    const right = norm(cross(fwd, { x: 0, y: 1, z: 0 }));
    const up = cross(right, fwd);
    // 焦距（取景框单位）：竖视角 45° ⇒ 半高 50 单位 ÷ tan(22.5°)
    const focal = (bb.h / 2) / Math.tan(ROOM_FOV / 2);
    return { eye, fwd, right, up, focal, dist: r, cx: bb.w / 2, cy: bb.h / 2, box: bb };
  }
  /** 世界点 → 取景框坐标。k 是近大远小系数（越小越远）。 */
  function roomProjectPoint(p, cam) {
    const v = { x: p.x - cam.eye.x, y: p.y - cam.eye.y, z: p.z - cam.eye.z };
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const zc = Math.max(0.05, dot(v, cam.fwd));
    const k = cam.focal / zc;
    return { x: cam.cx + dot(v, cam.right) * k, y: cam.cy - dot(v, cam.up) * k, k };
  }
  /** 整场投影一次：星点、地面、铺板、立柱，外加画家具用的远近排序。
      **刻意不做 fit-to-bbox** —— 每帧重新贴合会让旋转时画面自己缩放（抖得厉害）；
      相机距离由包围球定死，转起来才有真实的近大远小。 */
  function roomProjectAll(scene, v, box) {
    const cam = roomCamera(scene, v, box);
    const P = (p) => roomProjectPoint(p, cam);
    const bunks = scene.bunks;
    const centerK = bunks.map((b) => P({ x: b.x, y: (ROOM_SLAB_LOW + ROOM_SLAB_UP) / 2, z: b.z }).k);
    const stars = scene.beds.map(P);
    const ks = stars.map((p) => p.k);
    const kMin = Math.min(...ks), kMax = Math.max(...ks);
    return {
      cam, stars,
      slabs: scene.slabs.map((list, i) => ({ near: centerK[i], quads: list.map((q) => q.map(P)) })),
      posts: scene.posts.map((list, i) => ({ near: centerK[i], segs: list.map((s) => s.map(P)) })),
      order: bunks.map((_, i) => i).sort((a, b) => centerK[a] - centerK[b]),
      // 近大远小压到 0.86~1：透视比值有 2 倍以上，直接当字号用会前排巨大、后排看不清
      kAt: (p) => 0.86 + 0.14 * (kMax === kMin ? 1 : (p.k - kMin) / (kMax - kMin)),
    };
  }

  /* ── 渲染 ── */
  const roomFmt = (n) => String(Math.round(n * 100) / 100);
  const roomPts = (list) => list.map((p) => `${roomFmt(p.x)},${roomFmt(p.y)}`).join(" ");
  /** 星星的无障碍名字，也是「点这颗星代表谁」的唯一说明。 */
  const roomBedLabel = (i, m, now) => (m
    ? `第 ${i + 1} 位 · ${m.name} · ${i % 2 ? "上铺" : "下铺"}${now ? " · 今天值日" : ""}`
    : `第 ${i + 1} 位 · 空床`);

  /** 首帧的整段 SVG。拖动时不会走这里 —— 那条路是 roomDraw() 原地改属性。 */
  function roomSceneSvg(L) {
    const poly = (pts, cls) => `<polygon class="${cls}" points="${roomPts(pts)}"/>`;
    const seg = (a, b, cls) => `<line class="${cls}" x1="${roomFmt(a.x)}" y1="${roomFmt(a.y)}" x2="${roomFmt(b.x)}" y2="${roomFmt(b.y)}"/>`;
    // 画家算法：远的先画。铺板是半透明的，画反了后排会盖在前排上。
    const furniture = L.order.map((i) => L.slabs[i].quads.map((q) => poly(q, "dd-room-slab")).join("")
      + L.posts[i].segs.map(([a, b]) => seg(a, b, "dd-room-post")).join("")).join("");
    const flow = L.stars.length > 1
      ? `<polyline class="dd-room-flow" points="${roomPts(L.stars)}"/>`
        + seg(L.stars[L.stars.length - 1], L.stars[0], "dd-room-loop")
      : "";
    return furniture + flow;
  }

  /** 宿舍床位星图。人数为 0（关闭）时只画一行说明。 */
  function roomHtml(g, s) {
    const size = roomSizeOf(g);
    const v = roomView();
    const nowIds = new Set(assigneesFor(g, s.today).map((m) => m.id));
    const chips = ROOM_SIZES.map((n) => `<button class="dd-chip${n === size ? " on" : ""}" data-room-size="${n}" type="button" aria-pressed="${n === size ? "true" : "false"}">${n ? `${n} 人间` : "关闭"}</button>`).join("");
    const head = `<div class="dd-room-title">${faIcon("star")}宿舍床位 · 值日星图<span class="dd-room-sizes" role="group" aria-label="宿舍人数">${chips}</span></div>`;
    if (!size) {
      return `${head}<div class="dd-muted">选一个 4 / 6 / 8 人间：床位会画成一片星图，星星上写成员名字，星上的数字是他在轮换里的位次，连线就是从第 1 位到第 x 位的值日顺序。</div>`;
    }

    const scene = roomScene(size);
    const box = roomBox();
    const L = roomProjectAll(scene, v, box);
    const starsHtml = scene.beds.map((_, i) => {
      const m = g.members[i] || null;
      const now = !!m && nowIds.has(m.id);
      const p = L.stars[i];
      // up / down 决定名字挂星星上方还是下方：侧视下同一张铺的两颗星几乎竖直相叠，
      // 名字都挂下方会互相压住。
      const cls = ["dd-bed", i % 2 ? "up" : "down", now ? "now" : "", m ? "" : "empty"].filter(Boolean).join(" ");
      return `<button class="${cls}" type="button" data-room-bed="${i}"${m ? ` data-room-id="${esc(m.id)}"` : " disabled"}`
        + ` style="left:${(p.x / box.w * 100).toFixed(3)}%;top:${(p.y / box.h * 100).toFixed(3)}%;--k:${L.kAt(p).toFixed(3)};--phase:${(-(i * 0.6) % 4).toFixed(2)}s"`
        + ` aria-label="${esc(roomBedLabel(i, m, now))}"${now ? ' aria-current="true"' : ""}>`
        + `<span class="dd-bed-star" aria-hidden="true"><svg class="dd-bed-glyph" viewBox="-50 -50 100 100"><polygon points="${ROOM_STAR_PTS}"/></svg><b class="dd-bed-no">${i + 1}</b></span>`
        + `<span class="dd-bed-name">${m ? esc(m.name) : "空床"}</span></button>`;
    }).join("");

    const views = ROOM_VIEWS.map((x) => `<button class="dd-chip dd-chip-sm${x.id === v.view ? " on" : ""}" data-room-view="${x.id}" type="button" aria-pressed="${x.id === v.view ? "true" : "false"}">${x.label}</button>`).join("");
    const bar = `<div class="dd-room-bar">
      <span class="dd-room-views" role="group" aria-label="视角">${views}</span>
      <label class="dd-room-spin"><input type="checkbox" data-room-spin${v.spin ? " checked" : ""}>自动旋转</label>
      <label class="dd-room-spin"><input type="checkbox" data-room-beds${v.beds ? " checked" : ""}>显示床铺</label>
      <span class="dd-room-hint">左右拖动转视角 · 滚轮缩放</span>
    </div>`;

    const extra = g.members.length > size
      ? `<div class="dd-note">名单里还有 ${g.members.length - size} 位成员没排进这间宿舍 —— 调大宿舍人数，或把多余的成员移到别的轮换里。</div>` : "";
    const empty = g.members.length ? "" : `<div class="dd-note">还没有成员。先在上一张卡里添加：第 1 个人住 1 号床（下铺）。</div>`;
    const legend = `<div class="dd-note">实心星是上铺、空心星是下铺（同一张铺的两颗星沿铺宽略微错开，只为俯视时也分得开 —— 是示意，不是真实床位坐标）；星上的数字是他在名单里的位次，实线按 1→${size} 走、流动方向就是值日顺序，尾端虚线绕回第 1 位；今天当班的星亮成绿色。床架觉得碍事可以把上面的「显示床铺」关掉，只剩星星与连线。点一颗星可以跳到它在成员列表里的那一行。</div>`;

    return `${head}${bar}
      <div class="dd-room" data-room data-room-beds="${v.beds ? "on" : "off"}" style="aspect-ratio:${box.w}/${box.h}">
        <svg class="dd-room-svg" viewBox="0 0 ${box.w} ${box.h}" preserveAspectRatio="none" aria-hidden="true">${roomSceneSvg(L)}</svg>
        ${starsHtml}
      </div>${extra}${empty}${legend}`;
  }

  /* 已经挂到 DOM 上的那幅星图。拖动 / 自动旋转 / 换视角时按它原地重画。 */
  let roomLive = null;
  let roomRaf = 0;
  let roomResize = null;   // 窗口跨过断点要重画：取景框换了，旧的那份百分比就对不上了
  let roomHover = false;   // 鼠标压在星图上 → 暂停自动旋转（不然星星一直在动，点不准也看不清）
  let roomDragMoved = 0;   // 刚结束的那次拖动挪了多少像素：>4 就不当成「点击星星」

  const roomRafLater = (fn) => {
    try { return typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : 0; } catch { return 0; }
  };
  function roomStopSpin() {
    if (!roomRaf) return;
    try { cancelAnimationFrame(roomRaf); } catch { /* 没有 rAF 就算了 */ }
    roomRaf = 0;
  }
  /** 按当前相机原地重画星图：只改属性，不重建 DOM（重建会让名字闪、还会丢焦点）。 */
  function roomDraw() {
    if (!roomLive) return;
    const { host, scene, g, s } = roomLive;
    const L = roomProjectAll(scene, roomView(), roomLive.box);
    const svg = host.querySelector("svg");
    if (!svg) return;
    const setPts = (el, list) => { if (el) el.setAttribute("points", roomPts(list)); };
    const quads = svg.querySelectorAll(".dd-room-slab");
    const posts = svg.querySelectorAll(".dd-room-post");
    let qi = 0, pi = 0;
    for (const i of L.order) {
      for (const q of L.slabs[i].quads) setPts(quads[qi++], q);
      for (const [a, b] of L.posts[i].segs) {
        const el = posts[pi++];
        if (!el) continue;
        el.setAttribute("x1", roomFmt(a.x)); el.setAttribute("y1", roomFmt(a.y));
        el.setAttribute("x2", roomFmt(b.x)); el.setAttribute("y2", roomFmt(b.y));
      }
    }
    setPts(svg.querySelector(".dd-room-flow"), L.stars);
    const loop = svg.querySelector(".dd-room-loop");
    if (loop && L.stars.length > 1) {
      const a = L.stars[L.stars.length - 1], b = L.stars[0];
      loop.setAttribute("x1", roomFmt(a.x)); loop.setAttribute("y1", roomFmt(a.y));
      loop.setAttribute("x2", roomFmt(b.x)); loop.setAttribute("y2", roomFmt(b.y));
    }
    // 星星也顺手对齐一次：换过人数档之后成员可能变，类名与可点性要跟着走
    const nowIds = new Set(assigneesFor(g, s.today).map((m) => m.id));
    host.querySelectorAll("[data-room-bed]").forEach((el) => {
      const i = Number(el.dataset.roomBed);
      const p = L.stars[i];
      if (!p) return;
      el.style.left = `${(p.x / roomLive.box.w * 100).toFixed(3)}%`;
      el.style.top = `${(p.y / roomLive.box.h * 100).toFixed(3)}%`;
      el.style.setProperty("--k", L.kAt(p).toFixed(3));
      const m = g.members[i] || null;
      const now = !!m && nowIds.has(m.id);
      el.classList.toggle("now", now);
      el.classList.toggle("empty", !m);
      el.disabled = !m;
      if (m) el.dataset.roomId = m.id; else delete el.dataset.roomId;
      el.setAttribute("aria-label", roomBedLabel(i, m, now));
      if (now) el.setAttribute("aria-current", "true"); else el.removeAttribute("aria-current");
    });
  }
  function roomReduceMotion() {
    try { return !!window?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch { return false; }
  }
  /** 自动旋转：只在星图还挂在页面上、且没被减少动效压掉时跑。
      页签切到后台就只保留 rAF 空转（浏览器本来就会把 rAF 降频到 1Hz 以下）。 */
  function roomSpin() {
    roomRaf = 0;
    if (!roomLive || !roomLive.host.isConnected || !roomView().spin) return;
    // 停在星图上就把旋转停下来：默认开着自动旋转是为了好看，但边转边点星星会点空。
    // 只认鼠标 / 触控笔 —— 触摸设备的 :hover 会粘住，手指一碰就再也不转了。
    if (!roomReduceMotion() && !document.hidden && !roomHover) {
      state.roomView.th = (roomView().th + ROOM_SPIN_STEP) % (Math.PI * 2);
      roomDraw();
    }
    roomRaf = roomRafLater(roomSpin);
  }
  function roomSpinSync() {
    roomStopSpin();
    if (roomLive && roomView().spin) roomRaf = roomRafLater(roomSpin);
  }

  /** 绑定星图：拖动转视角、滚轮缩放、自动旋转、换视角、点星定位。
      人数档的绑定在 bind() 里（它要 await 落盘）。 */
  function bindRoom(g, s) {
    const host = root?.querySelector?.("[data-room]") || null;
    roomStopSpin();
    roomLive = null;
    const size = roomSizeOf(g);
    if (!host || !size) return;
    // 取景框钉在「这一次渲染用的那一个」上：窗口跨过断点后不能只重算一半，
    // 否则 SVG 的 viewBox 与星星的百分比会各说各话，线就从星上滑开了。
    roomLive = { host, scene: roomScene(size), g, s, box: roomBox() };
    roomSpinSync();
    // 手机横竖屏切换会跨过断点。这里只在「取景框真的换了」时才整页重画 ——
    // 光是窗口变宽变窄不需要动，CSS 会自己把卡片缩放好。
    try {
      if (roomResize) window.removeEventListener("resize", roomResize);
    } catch { /* 没有 window 就算了 */ }
    roomResize = null;
    try {
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        roomResize = () => { if (roomLive && roomBox() !== roomLive.box) paint(); };
        window.addEventListener("resize", roomResize);
      }
    } catch { /* 没有 window 就算了 */ }

    // 拖动转视角。CSS 里给的是 touch-action:pan-y —— 手机上左右拖转视角、上下拖滚动页面，
    // 不把整张卡片变成「滚不动的黑洞」。
    let drag = null;
    host.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      roomDragMoved = 0;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, th: roomView().th, ph: roomView().ph, active: false };
      roomStopSpin();
    });
    host.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      roomDragMoved = Math.max(roomDragMoved, Math.abs(dx) + Math.abs(dy));
      if (!drag.active) {
        // 挪过 4px 才算「转视角」。**指针捕获必须等到这一刻**：setPointerCapture 会把后续的
        // click 重定向到捕获元素上，在 pointerdown 就捕获 = 把所有星星的点击全吃掉
        //（表现是「点星星跳到成员列表」完全没反应）。顺带也让「只点一下」不会把画面蹭偏。
        if (roomDragMoved <= 4) return;
        drag.active = true;
        host.classList.add("dragging");
        try { host.setPointerCapture(e.pointerId); } catch { /* 不支持就算了，事件还会冒到 host */ }
      }
      state.roomView.th = drag.th - dx * 0.007;
      state.roomView.ph = clampPh(drag.ph + dy * 0.007);
      roomDraw();
    });
    const endDrag = () => {
      if (!drag) return;
      const moved = drag.active;
      drag = null;
      host.classList.remove("dragging");
      roomSpinSync();
      if (moved) save();   // 只点一下不写盘
    };
    host.addEventListener("pointerup", endDrag);
    host.addEventListener("pointercancel", endDrag);
    host.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch") return;
      roomHover = true;
    });
    host.addEventListener("pointerleave", () => {
      if (!roomHover) return;
      roomHover = false;
      roomSpinSync();   // 之前可能是「因为悬停而空转」，离开后重新起一轮
    });
    host.addEventListener("wheel", (e) => {
      e.preventDefault();
      const v = roomView();
      state.roomView.dist = Math.max(0.55, Math.min(1.9, v.dist * (1 + Math.sign(e.deltaY) * 0.09)));
      roomDraw();
      save();
    }, { passive: false });
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
      <section class="dd-card dd-room-card" style="margin-top:14px">${roomHtml(g, s)}</section>
      <div class="dd-grid" style="margin-top:14px">
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

    // 宿舍星图：人数档（要落盘，走 commit）+ 视角档 / 自动旋转 + 「点星星找人对上号」
    root.querySelectorAll("[data-room-size]").forEach((btn) => btn.addEventListener("click", async () => {
      const n = Number(btn.dataset.roomSize) || 0;
      if (n !== roomSizeOf(g)) await commit(() => { g.roomSize = n; });
    }));
    root.querySelectorAll("[data-room-view]").forEach((btn) => btn.addEventListener("click", async () => {
      const id = btn.dataset.roomView;
      const base = ROOM_VIEWS.find((x) => x.id === id);
      if (!base) return;
      // 切档位时把角度重置回该机位：用户拖歪了之后点「立体」的预期是回到标准机位
      state.roomView.view = id;
      state.roomView.th = base.th;
      state.roomView.ph = base.ph;
      await save();
      await paint();
    }));
    q("[data-room-spin]")?.addEventListener("change", async (e) => {
      state.roomView.spin = !!e.currentTarget.checked;
      await save();
      roomSpinSync();
    });
    // 「显示床铺」只是显隐，不必整页重画（重画会把名字闪一下、也会丢焦点）：
    // 直接改容器属性 + 落盘，样式那条规则自己会生效。
    q("[data-room-beds]")?.addEventListener("change", async (e) => {
      state.roomView.beds = !!e.currentTarget.checked;
      const host = root.querySelector("[data-room]");
      if (host) host.dataset.roomBeds = state.roomView.beds ? "on" : "off";
      await save();
    });
    // 拖动过之后再抬手会补一个 click，那种不该被当成「点星星找人对号」
    root.querySelectorAll("[data-room-bed][data-room-id]").forEach((el) => el.addEventListener("click", () => {
      if (roomDragMoved > 4) return;
      const row = root.querySelector(`[data-members] .dd-mrow[data-id="${el.dataset.roomId}"]`);
      if (!row || !row.classList) return;
      row.scrollIntoView({ block: "center" });
      row.classList.add("dd-flash");
      setTimeout(() => row.classList.remove("dd-flash"), 1600);
    }));
    bindRoom(g, snapshot(g));

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
    return () => {
      if (root !== el) return;
      // 视图被换掉时把星图的自动旋转一起停掉 —— 不然 rAF 会一直对着一个已摘掉的节点跑
      roomStopSpin();
      try { if (roomResize) window.removeEventListener("resize", roomResize); } catch { /* 忽略 */ }
      roomResize = null;
      roomLive = null;
      root = null;
    };
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
