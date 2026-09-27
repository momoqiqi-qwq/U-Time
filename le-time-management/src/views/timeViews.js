import * as S from "../store.js";
import { bottomInsetPx, el } from "../ui.js";

const VIEW_META = [
  ["day", "日时间轴", "当前可拖拽编辑的日程"],
  ["wakeup", "课时格", "把本周时间块按小时铺成节次网格"],
  ["milestone", "里程碑", "彩色箭头式阶段时间轴"],
  ["chronicle", "横向时间轴", "高密度事件年表"],
  ["cards", "卡片时间轴", "左右交错的叙事时间线"],
  ["gantt", "年度甘特", "按项目/任务展示跨月计划"],
  ["swimlane", "阶段甘特", "按分类分泳道查看时间占用"],
];

const CAT_NAME = { work: "工作", study: "学习", sport: "运动", life: "生活", rest: "休息" };
/* 分类色只认 styles.css 的 --cat-*（唯一事实源），这里不再写第二份十六进制表。
   历史坑：这张表曾是 #2d8ee6 那一系的自配色，与 styles.css 的 .cat-block-* 毫无关系 ——
   同一个「工作」在时间块视图是深青、在这里是蓝；而里程碑轴更彻底，它按序号取 PALETTE，
   于是同一种类型能同时出现蓝 / 绿 / 黄 / 紫四种颜色（用户截图指出）。 */
const CAT_COLOR = {
  work: "var(--cat-work)", study: "var(--cat-study)", sport: "var(--cat-sport)",
  life: "var(--cat-life)", rest: "var(--cat-rest)",
};
/* 压在分类底色上的文字色。不能一律用 --on-accent：浅色模式下它是白字，
   而黄 / 红 / 青绿三种底色都偏亮（白字只有 2.2~2.8:1，见 :root 的实测记录）。 */
const CAT_FG = {
  work: "var(--cat-work-fg)", study: "var(--cat-study-fg)", sport: "var(--cat-sport-fg)",
  life: "var(--cat-life-fg)", rest: "var(--cat-rest-fg)",
};
/* 「截止」节点的标签是「目标」，它不显示分类，所以也不该借分类的颜色 ——
   给一个独立的品牌深青，色与字才对得上。 */
const GOAL_TONE = { c: "var(--deep)", fg: "var(--on-deep)" };
function catTone(e) {
  if (e.kind === "截止") return GOAL_TONE;
  return CAT_COLOR[e.cat] ? { c: CAT_COLOR[e.cat], fg: CAT_FG[e.cat] } : GOAL_TONE;
}
/* 时间块分类缺失/未知时的兜底色，只在课时格用得上（其它视图一律走 CAT_COLOR）。 */
const PALETTE = ["#2397e5", "#62b2ea", "#7bc886", "#ffbb52", "#e86d70", "#ff3d35", "#9061bd", "#42b6a2"];

/* ═══════════════════ 视图切换栏 ═══════════════════
   7 个样式原来平铺成一行横向滚动 chips：手机上一屏只看得见 4 个半，
   「卡片时间轴 / 年度甘特 / 阶段甘特」藏在滑动条后面，用户根本不知道有几种视图。
   现在收成「当前样式名 + 展开按钮」，点开列出全部 7 项并带一句说明。
   桌面端同样收起 —— 省出的整条横向空间还给内容，且两端行为一致。 */
export function createTimeViewSwitcher({ current = "day", onChange }) {
  // 同一时刻只允许存在一个菜单：视图重进会重建 switcher，旧菜单节点还挂在 body 上，
  // 不清掉就会叠出第二个（也会让「选完不关闭」看起来像没生效）。
  document.querySelectorAll(".time-viewmenu").forEach((m) => m.remove());
  const labelOf = (id) => VIEW_META.find(([key]) => key === id)?.[1] ?? "日时间轴";
  const bar = el("div", { class: "time-viewbar" });
  const menu = el("div", { class: "time-viewmenu", role: "menu" });
  menu.hidden = true;
  const buttons = new Map();

  // 菜单挂到 <body>：切换栏自己带 overflow，菜单作为子节点会被裁掉。
  const toggle = el("button", {
    class: "time-viewtoggle", type: "button",
    "aria-haspopup": "menu", "aria-expanded": "false",
    title: "切换时间视图",
  }, el("b", { class: "time-viewname" }, labelOf(current)), el("i", { class: "time-viewcaret", "aria-hidden": "true" }));

  for (const [id, label, title] of VIEW_META) {
    const b = el("button", {
      class: `time-viewitem${id === current ? " on" : ""}`,
      role: "menuitemradio", "aria-checked": id === current ? "true" : "false",
      onclick: () => { close(); onChange(id); },
    }, el("b", {}, label), el("span", {}, title));
    buttons.set(id, b); menu.append(b);
  }

  let opened = false;
  const onDocPointer = (e) => { if (!menu.contains(e.target) && !toggle.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    if (!opened) return;
    opened = false;
    // 🔴 必须写布尔值。`menu.hidden = ""` 赋的是空字符串（falsy），
    // 属性不会变成 hidden，菜单会赖在屏幕上不消失。
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function open() {
    if (opened) return;
    opened = true;
    const r = toggle.getBoundingClientRect();
    menu.hidden = false; menu.style.visibility = "hidden"; document.body.append(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    // 右对齐展开按钮，但不许越出视口（窄屏时贴左右安全边）；底部再让开三键导航栏（v0.58.2）。
    menu.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
    menu.style.top = `${Math.min(r.bottom + 6, innerHeight - mh - 8 - bottomInsetPx())}px`;
    menu.style.visibility = "";
    toggle.setAttribute("aria-expanded", "true");
    setTimeout(() => {
      if (!opened) return;   // 可能在这次 task 结束前就被关掉了
      document.addEventListener("pointerdown", onDocPointer, true);
      document.addEventListener("keydown", onKey, true);
    });
  }

  toggle.addEventListener("click", () => (opened ? close() : open()));
  bar.append(el("span", { class: "time-viewlead" }, "时间视图"), toggle);

  bar.setCurrent = (id) => {
    for (const [key, b] of buttons) {
      const on = key === id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    }
    toggle.querySelector(".time-viewname").textContent = labelOf(id);
  };
  bar._closeMenu = close;
  return bar;
}

export function renderTimeView(host, mode, anchorDate, zoom) {
  host.replaceChildren();
  host.dataset.view = mode;
  const data = collectTimelineData(anchorDate);
  const view = mode === "wakeup" ? wakeupView(data, anchorDate)
    : mode === "milestone" ? milestoneView(data)
    : mode === "chronicle" ? chronicleView(data)
      : mode === "cards" ? cardTimelineView(data)
        : mode === "gantt" ? ganttView(data)
          : swimlaneView(data, anchorDate);
  host.append(view);
  // 手势面 = 该视图自己的滚动容器（建模时打上 data-zoom-surface）。
  // 空数据时视图里没有滚动容器，退回面板根节点：捏合依然只是改那个共用系数，不会算错东西。
  if (zoom) attachViewZoomGestures(view.querySelector("[data-zoom-surface]") ?? view, zoom);
}

function parseDate(s) { const [y, m, d] = String(s || "").slice(0, 10).split("-").map(Number); return new Date(y || 1970, (m || 1) - 1, d || 1); }
function dateKey(d) { return S.fmtDate(d); }
function dayDiff(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function shortDate(s) { return String(s || "").slice(5).replace("-", "/"); }
function safeDateFromCreated(ts) { const d = new Date(Number(ts) || Date.now()); return Number.isNaN(d.getTime()) ? S.todayStr() : dateKey(d); }

function collectTimelineData(anchorDate) {
  const st = S.getState();
  const tasks = (st.tasks || []).filter(t => !t.done);
  const blocks = st.blocks || [];
  const events = [];
  for (const b of blocks) events.push({ id: b.id, date: b.date, title: b.title, subtitle: `${b.start} · ${S.durLabel(b.durMin)}`, cat: b.cat || "work", kind: "时间块" });
  for (const t of tasks) if (t.due) events.push({ id: t.id, date: t.due.slice(0, 10), title: t.title, subtitle: t.project || (t.tags || []).join(" · ") || "任务截止", cat: taskCat(t), kind: "截止" });
  events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  const projectMap = new Map();
  // 任务 → 排程日期先按 taskId 分组一遍（v0.109.0）：原来是每条任务全表 filter，
  // O(任务数 × 时间块数)；任务上百、时间块过千时每次渲染时间线都白扫几十万次。
  const blockDatesByTask = new Map();
  for (const b of blocks) {
    const list = blockDatesByTask.get(b.taskId);
    if (list) list.push(b.date); else blockDatesByTask.set(b.taskId, [b.date]);
  }
  for (const t of tasks) {
    const key = t.project || (t.tags && t.tags[0]) || "未分类任务";
    const blockDates = (blockDatesByTask.get(t.id) || []).slice().sort();
    const start = blockDates[0] || safeDateFromCreated(t.createdAt);
    const end = (t.due || blockDates.at(-1) || start).slice(0, 10);
    const row = { id: t.id, group: key, title: t.title, start: start <= end ? start : end, end: end >= start ? end : start, cat: taskCat(t) };
    if (!projectMap.has(key)) projectMap.set(key, []);
    projectMap.get(key).push(row);
  }
  return { events, projects: [...projectMap.entries()], blocks, anchorDate };
}

function taskCat(t) {
  const tag = (t.tags || [])[0] || "";
  return ({ 论文: "work", 工作: "work", 学习: "study", 读书: "study", 运动: "sport", 健身: "sport", 跑步: "sport", 生活: "life", 休息: "rest" })[tag] || "work";
}

function empty(title = "暂无可展示的数据") {
  return el("div", { class: "tv-empty" }, el("div", { class: "tv-empty-icon" }, "⌁"), el("b", {}, title), el("span", {}, "添加带日期的任务或时间块后，这里会自动生成可视化。"));
}

/* 面板标题条：只留视图名。
   原来每个视图下面还挂一句「参考箭头阶段图：…」的占位说明，不承载信息也不可交互，
   只是把内容往下推（用户截图反馈「占位置的东西删掉」）。说明参数保留但不再渲染，
   以后要恢复只需改这里一处。 */
function head(title, desc) {
  void desc;
  return el("div", { class: "tv-head" }, el("div", {}, el("h2", {}, title)));
}

/* 手机上一个视图动辄几十条事件。「全部平铺」既滚不到底，也看不清结构 ——
   统一改成 <details> 分组折叠：桌面端由 CSS 强制展开（display:contents 让内容
   直接参与父级 flex/grid 布局），窄屏才变成真正可收放的分组。
   折叠用的原生 <details> 不需要额外 JS，键盘与读屏也自带支持。 */
function collapsible(summaryText, extraClass, open) {
  const box = el("details", { class: `tv-fold${extraClass ? ` ${extraClass}` : ""}` });
  if (open) box.setAttribute("open", "");
  box.append(el("summary", { class: "tv-fold-head" }, el("span", { class: "tv-fold-title" }, summaryText), el("i", { class: "tv-fold-caret", "aria-hidden": "true" })));
  const body = el("div", { class: "tv-fold-body" });
  box.append(body);
  return { box, body };
}

function mondayOf(dateStr) {
  const d = parseDate(dateStr); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return dateKey(d);
}
function addDate(dateStr, n) { const d = parseDate(dateStr); d.setDate(d.getDate() + n); return dateKey(d); }
function minutes(hhmm) { const [h, m] = String(hhmm || "0:0").split(":").map(Number); return h * 60 + m; }

/* ═══════════════ 时间块页的统一缩放（v0.71.0）═══════════════
   七种视图共用**一个**系数：JS 把它写成 `--tv-zoom` 挂在视图根节点（`.tb-root`）上，
   各视图在 CSS / JS 里各取所需 ——
   ① 课时格：沿用原有的「尺寸 × --wk-zoom」写法，CSS 把 `--wk-zoom` 别名到 `--tv-zoom`
      （那张网格是 height:100% + 1fr 铺满容器的，换成 zoom 属性会反向，见下方长注）；
   ② 日时间轴：分钟→像素的换算本来就写在 JS 里，所以由 JS 乘系数后重算块几何；
   ③ 里程碑 / 年表 / 年度甘特 / 阶段甘特 / 卡片时间轴：画布内部全是 px 或 % 定位，
      直接吃 CSS `zoom`，一条规则整体等比放大。
   比例存 settings.timeViewZoom（沿用课时格的原字段），切视图、重启都保持。

   触控板与触控屏的捏合在 Chromium 里走两条不同的路，必须都接：
   ① 触控板捏合 = **带 ctrlKey 的 wheel**（和鼠标 Ctrl+滚轮同一条路，顺便白送键盘用户）；
   ② 触控屏捏合 = 双指 touchmove 的距离变化。
   平移不自己实现：各视图的滚动容器都是 overflow:auto，原生触摸 / 触控板滚动已经够顺，
   自己写反而丢掉惯性；`touch-action:pan-x pan-y`（见 styles.css）保证双指平移交给原生。
   这里只负责「别让浏览器把捏合拿去缩放整个页面」。
   缩放锚点取手势中心：缩放前后该点对应的内容坐标必须一致，否则捏合时内容会从手指底下
   跑掉（用起来像「越捏越偏」）。 */
const ZOOM_MIN = 0.6, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1));

/**
 * 缩放控制器：写 `--tv-zoom` + 右上角那三颗键（＋ / 当前比例 / －）。
 *
 * 中间那颗既是读数也是「默认」：点一下回 100%，与原有的双击复位同一条回头路。
 * 三键按需求给的顺序排：放大、默认、缩小。
 *
 * @param {HTMLElement} root 挂变量的节点（时间块视图的容器，七种视图都是它的后代）
 * @param {{onApply?:(z:number)=>void}} [options] onApply = CSS 变量之外的联动
 *   （日时间轴要按新系数重算块的 top/height，光靠 CSS 变不了 JS 写的内联值）
 */
export function createTimeViewZoom(root, { onApply } = {}) {
  let cur = clampZoom(S.getState().settings.timeViewZoom);
  let settle = null;
  const value = el("b", { class: "tv-zoom-value" });
  const btnIn = el("button", { class: "tv-zoom-btn", type: "button", title: "放大一档", "aria-label": "放大" }, "＋");
  const btnDefault = el("button", { class: "tv-zoom-btn tv-zoom-default", type: "button", title: "恢复默认大小（100%）" }, value);
  const btnOut = el("button", { class: "tv-zoom-btn", type: "button", title: "缩小一档", "aria-label": "缩小" }, "－");
  const bar = el("div", { class: "tv-zoombar", role: "group", "aria-label": "视图缩放" }, btnIn, btnDefault, btnOut);
  btnIn.addEventListener("click", () => set(stepBy(1)));
  btnOut.addEventListener("click", () => set(stepBy(-1)));
  btnDefault.addEventListener("click", () => set(1));

  // 按键走离散档位：0.7 − 0.1 在浮点里是 0.5999999999999999，
  // 于是「已到下限 − 键不置灰」「持久化里存进一串小数尾巴」两处一起错（实测）。
  const stepBy = (dir) => Math.round((cur + dir * ZOOM_STEP) * 100) / 100;

  function paint() {
    value.textContent = `${Math.round(cur * 100)}%`;
    btnIn.disabled = cur >= ZOOM_MAX;
    btnOut.disabled = cur <= ZOOM_MIN;
    // 非 100% 时给中间那颗上色：一眼看出「现在是缩放态，点它能回去」
    btnDefault.classList.toggle("is-active", Math.abs(cur - 1) >= 0.005);
  }

  function persist(z) {
    S.getState().settings.timeViewZoom = z;
    S.persistSoon();
  }

  function set(next) {
    const z = clampZoom(next);
    // 已到上下限时再往外捏不动：返回原值，让手势那边知道「没变」，不要白动滚动位置
    if (Math.abs(z - cur) < 0.005) return cur;
    cur = z;
    root.style.setProperty("--tv-zoom", String(z));
    paint();
    onApply?.(z);
    // 落盘延后：捏合一次能产生上百个 wheel，逐帧请求写盘没意义（停手 600ms 写一次）
    clearTimeout(settle);
    settle = setTimeout(() => { settle = null; persist(z); }, 600);
    return cur;
  }

  root.style.setProperty("--tv-zoom", String(cur));
  paint();
  return {
    get: () => cur,
    set,
    bar,
    // 离开视图时把待写的那一笔结掉，别让 600ms 定时器跨视图存活
    flush: () => { if (settle) { clearTimeout(settle); settle = null; persist(cur); } },
  };
}

/** 把「捏合 / Ctrl+滚轮 / 双击复位」接到某个滚动容器上，系数本体归控制器管。
 *  导出给日时间轴用（`.tl-scroll`），那边和这里共用同一套锚点保位逻辑。 */
export function attachViewZoomGestures(scroll, zoom, { dblToReset = true } = {}) {
  let pinch = null;
  const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  function setZoom(next, ax, ay) {
    const before = zoom.get();
    const r = scroll.getBoundingClientRect();
    const px = ax == null ? scroll.clientWidth / 2 : ax - r.left;
    const py = ay == null ? scroll.clientHeight / 2 : ay - r.top;
    // 🔴 锚点用「在滚动内容里的相对位置」，不能用绝对内容坐标：
    //    网格宽受 min-width、高受 height:100% / min-height 三重约束，缩放并不是纯等比 ——
    //    实测 zoom 1 → 1.377 时网格宽只放大 1.11 倍（1116 → 1239），
    //    按绝对坐标算会漂 60px+（内容从手指底下跑掉）。相对位置对非等比也成立。
    const relX = scroll.scrollWidth ? (scroll.scrollLeft + px) / scroll.scrollWidth : 0;
    const relY = scroll.scrollHeight ? (scroll.scrollTop + py) / scroll.scrollHeight : 0;
    if (zoom.set(next) === before) return;   // 被上下限夹住 = 没变化，那就别动滚动位置
    // 先把布局刷出来再改滚动位置：scrollLeft 的合法范围由内容尺寸决定，
    // 尺寸刚改完时范围还是旧的 ⇒ 直接赋值会被 clamp 到旧范围。
    // 读一次 scrollWidth 触发同步 layout。
    void scroll.scrollWidth;
    scroll.scrollLeft = relX * scroll.scrollWidth - px;
    scroll.scrollTop = relY * scroll.scrollHeight - py;
  }

  // ① 触控板捏合 / Ctrl+滚轮。passive:false 才允许 preventDefault ——
  //    否则 WebView2 会执行自己的页面缩放，整个界面跟着变大（而不是只缩这块画布）。
  scroll.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;              // 普通滚动放行，交给原生
    e.preventDefault();
    setZoom(zoom.get() * Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
  }, { passive: false });

  // ② 触控屏捏合
  scroll.addEventListener("touchstart", (e) => {
    pinch = e.touches.length === 2
      ? {
        d: touchDist(e.touches), z: zoom.get(),
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      }
      : null;
  }, { passive: true });
  scroll.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    setZoom(pinch.z * (touchDist(e.touches) / pinch.d), pinch.x, pinch.y);
  }, { passive: false });
  const endPinch = () => { pinch = null; };
  scroll.addEventListener("touchend", endPinch, { passive: true });
  scroll.addEventListener("touchcancel", endPinch, { passive: true });

  // 双击复位：缩到很小或放得很大之后总得有条回头路，否则只能一点点捏回来。
  // 日时间轴关掉这条（dblToReset:false）：那里双击会命中时间块并弹出块菜单，
  // 一次双击同时「改比例 + 开菜单」是最坏的巧合 —— 三键里的默认键已经够用。
  if (dblToReset) scroll.addEventListener("dblclick", (e) => {
    if (Math.abs(zoom.get() - 1) < 0.005) return;
    setZoom(1, e.clientX, e.clientY);
  });
}

/* ── 课时格（内部 id 仍叫 wakeup，改 id 会让用户已保存的视图选择失效）──
   它是「用课表的样子看时间线」，数据源恒为本周时间块，不读「课程表」插件的课表
   storage —— 真实课表去插件里看，这里看自己的安排（v0.70.0 解耦）。
   桌面是一屏 7 天的网格；窄屏改成「按天分组的日程列表」：
   7 列 × 16 节 = 112 个格子在 390px 宽里最小可读宽度约 700px，
   横向滚动能滚但不实用 —— 直接换布局，一天一段更符合手机阅读。
   节次按小时切（7:00 起 16 格）：时间块只有起止时刻，没有学校作息表，
   按小时铺是不依赖任何外部数据的最近似课表形态。
   行高不写死：`--slot-count` 提到根节点上，CSS 用
   `minmax(下限, 1fr)` 按剩余空间平分，让全部节次一屏看完（见 styles.css）。 */
function wakeupView(data, anchorDate) {
  const root = el("section", { class: "tv-panel wakeup-view" });
  const anchor = anchorDate || S.todayStr(); const monday = mondayOf(anchor); const today = S.todayStr();
  const slots = Array.from({ length: 16 }, (_, i) => { const m = 7 * 60 + i * 60; return { number: i + 1, startTime: S.hhmmOf(m), endTime: S.hhmmOf(m + 50) }; });
  const mapDate = new Map(Array.from({ length: 7 }, (_, i) => [addDate(monday, i), i + 1]));
  const courses = data.blocks.filter(b => mapDate.has(b.date)).map((b, i) => { const sm = minutes(b.start), em = sm + Number(b.durMin || 30); const r1 = clamp(Math.floor((sm - 420) / 60), 0, 15), r2 = clamp(Math.floor((Math.max(sm + 1, em) - 421) / 60), r1, 15); return { name: b.title, day: mapDate.get(b.date), position: CAT_NAME[b.cat] || "时间块", start: b.start, end: S.hhmmOf(em), r1, r2, color: CAT_COLOR[b.cat] || PALETTE[i % PALETTE.length] }; });
  // `--slot-count` 挂在根节点上（而不是网格自己）：CSS 要用它算「自然高度上限」，
  // 那个 max-height 写在 .wakeup-scroll（网格的父级）上，变量只能向下继承。
  root.style.setProperty("--slot-count", String(slots.length));
  root.append(head("课时格", `${monday} ～ ${addDate(monday, 6)} · 把这一周的时间块按小时铺进网格，窄屏自动改为按天分组。`));

  // 桌面：真 7 列网格（CSS 在 ≤760px 里隐藏）
  // 缩放系数不再由这里写：`--tv-zoom` 挂在时间块视图的根容器上（createTimeViewZoom），
  // CSS 里 `.wakeup-view { --wk-zoom: var(--tv-zoom, 1) }` 接过来。消费点必须在面板类上
  // 而不是网格自己 —— 变量只向下继承，而外层 .wakeup-scroll 的 max-height 也要读它。
  const sc = el("div", { class: "wakeup-scroll", "data-zoom-surface": "" }); const grid = el("div", { class: "wakeup-grid" });
  grid.append(el("div", { class: "wk-corner" }, "时间"));
  const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  for (let i = 0; i < 7; i++) { const d = addDate(monday, i); grid.append(el("div", { class: `wk-day${d === today ? " today" : ""}`, style: `grid-column:${i + 2};grid-row:1` }, el("b", {}, dayNames[i]), el("span", {}, shortDate(d)))); }
  slots.forEach((sl, i) => grid.append(el("div", { class: "wk-slot", style: `grid-column:1;grid-row:${i + 2}` }, el("b", {}, String(sl.number)), el("span", {}, `${sl.startTime}\n${sl.endTime}`))));
  for (let r = 0; r < slots.length; r++) for (let d = 0; d < 7; d++) grid.append(el("div", { class: "wk-cell", style: `grid-column:${d + 2};grid-row:${r + 2}` }));
  courses.forEach((c, i) => {
    const col = clamp(Number(c.day) || 1, 1, 7) + 1;
    const r1 = clamp(Number(c.r1) || 0, 0, slots.length - 1) + 2;
    const r2 = clamp(Number(c.r2 ?? c.r1) || 0, 0, slots.length - 1) + 3;
    grid.append(el("article", { class: "wk-course", style: `grid-column:${col};grid-row:${r1}/${r2};--wk:${c.color || PALETTE[i % PALETTE.length]}`, title: `${c.name || c.title} ${c.start || ""}-${c.end || ""}` },
      el("b", {}, c.name || c.title), c.position ? el("span", {}, c.position) : null,
      el("small", {}, `${c.start || ""}${c.end ? `-${c.end}` : ""}`)));
  });
  sc.append(grid); root.append(sc);

  // 手机：按天分组列表（CSS 在 >760px 里隐藏）
  const mobile = el("div", { class: "wakeup-mobile" });
  for (let i = 0; i < 7; i++) {
    const d = addDate(monday, i);
    const list = courses.filter(c => Number(c.day) === i + 1);
    const fold = collapsible(`${dayNames[i]} · ${shortDate(d)}`, "", d === today || (!courses.length && i === 0));
    fold.box.classList.toggle("is-today", d === today);
    const sorted = list.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    fold.body.append(...(sorted.length
      ? sorted.map(c => el("article", { class: "wm-item", style: `--wk:${c.color}` },
        el("span", { class: "wm-time" }, `${c.start || ""}\n${c.end || ""}`),
        el("div", { class: "wm-copy" }, el("b", {}, c.name || c.title),
          c.position ? el("span", {}, c.position) : null)))
      : [el("p", { class: "wm-none" }, "这天没有时间块")]));
    mobile.append(fold.box);
  }
  root.append(mobile);
  if (!courses.length) root.append(el("div", { class: "wk-tip" }, "这一周还没有时间块：在「日时间轴」里添加，或到「课程表」插件里把课程同步到时间块。"));
  return root;
}

/* ── 里程碑 ──
   v0.50.0：从「一条横向轨道排到底」改成蛇形折返跑道（参考「人类科技革命里程碑」那种回环图）——
   一行排满就掉头，下一行反向铺，行间用竖直段把两端接起来，每个节点带序号
   （折返之后光看左右位置已经看不出先后，序号是必需的）。
   DOM 顺序恒为时间顺序，方向只交给 CSS 的 data-dir —— 窄屏把每行拆成单列时不必重排。
   窄屏（≤760px）仍是纵向铺满，见 styles.css 里程碑段。 */
const MS_COLS = 4;
function milestoneView(data) {
  const root = el("section", { class: "tv-panel milestone-view" });
  root.append(head("里程碑时间轴", "参考箭头阶段图：按日期排序展示近期关键任务与时间块。"));
  if (!data.events.length) { root.append(empty()); return root; }
  const list = data.events.slice(0, 12);
  const track = el("div", { class: "milestone-track" });
  for (let start = 0; start < list.length; start += MS_COLS) {
    const slice = list.slice(start, start + MS_COLS);
    const rev = (start / MS_COLS) % 2 === 1;
    const row = el("div", { class: "ms-row", "data-dir": rev ? "rev" : "fwd" });
    // 一种类型一种颜色：取色只认事件的分类，不再看它排在第几位。
    // 折返跑道上同色行会让 --ms-rail 退化成一条纯色，这是正确结果 —— 不要为了「好看」再按序号上色。
    const tones = slice.map(catTone);
    const colors = tones.map((t) => t.c);
    slice.forEach((e, k) => {
      const label = e.kind === "截止" ? "目标" : CAT_NAME[e.cat] || "安排";
      row.append(el("div", { class: "ms-cell", style: `--ms:${colors[k]};--tone-fg:${tones[k].fg}` },
        el("div", { class: "ms-stage" }, label),
        el("div", { class: "ms-line" }),
        el("div", { class: "ms-arrow" }, el("b", {}, e.date.slice(0, 4)), el("span", {}, shortDate(e.date))),
        el("div", { class: "ms-pin" }, String(start + k + 1)),
        el("div", { class: "ms-copy" }, el("b", {}, e.title), el("span", {}, e.subtitle || e.kind)),
      ));
    });
    // 跑道线跟着本行节点上色。反向行的视觉从左到右是倒序，渐变要跟着倒过来铺。
    const rail = rev ? [...colors].reverse() : colors;
    row.style.setProperty("--ms-rail", `linear-gradient(90deg, ${rail.join(", ")})`);
    // 行间竖直段接在「本行时间最晚的那个节点」下方：正向行落在右端，反向行落在左端。
    row.style.setProperty("--ms-joint", colors[colors.length - 1]);
    track.append(row);
  }
  root.append(el("div", { class: "milestone-scroll", "data-zoom-surface": "" }, track));
  return root;
}

/* ── 横向时间轴（年表）──
   桌面是绝对定位年表，靠上下交错区分事件；窄屏换成纵向年表（一条中轴 + 左右卡片），
   不再有横向滚动 —— 1500px 画布塞进几十条事件时，卡片只能互相盖住（用户截图证实）。
   v0.50.0：修复时间堆积 —— 两个事件相隔太久（>60 天且占跨度 15%+）时，
   中轴用「省略号」截断长空档，省出的横向位置按天数比例还给密集段；
   段内再做「前推 + 后收」两遍扫描。
   v0.70.0：画布宽度改为按事件数撑出来（见下面 SLOT_MIN 的推导），密度由横向滚动承担。
   原来宽度写死 1500px、位置按百分比算，26 条事件只剩 53px 一槽，而卡片就要 150px ——
   百分比预算再怎么调都救不回「槽宽 < 内容宽」，所以只能从画布宽度这一层解。 */
function chronicleView(data) {
  const root = el("section", { class: "tv-panel chronicle-view" });
  root.append(head("横向时间轴", "参考机器人发展史年表：适合信息密度高、事件多的长期回顾。"));
  if (!data.events.length) { root.append(empty()); return root; }
  const events = data.events.slice(0, 30);
  const total = Math.max(1, dayDiff(events[0].date, events.at(-1).date));
  // 「相隔太久」要同时满足绝对下限与相对占比：只看占比，短跨度里相邻两个月
  // 的间隔也会被切得粉碎；只看天数，十年跨度里半年的空档在轴上只占 5%，切了反而丢信息。
  const gapThreshold = Math.max(60, Math.round(total * 0.15));

  // 1) 按长空档把事件切成密集段（gaps[k] = 第 k 段之后的那个空档）
  const segments = [[]];
  const gaps = [];
  for (let i = 0; i < events.length; i++) {
    if (i > 0) {
      const d = dayDiff(events[i - 1].date, events[i].date);
      if (d > gapThreshold) {
        gaps.push({ seg: segments.length - 1, days: d, from: events[i - 1].date, to: events[i].date });
        segments.push([]);
      }
    }
    segments.at(-1).push(events[i]);
  }

  // 2) 画布宽度由事件数撑出来 —— 不再写死 1500px。
  //    写死时 26 条事件只能分到 53px 一槽，而一张卡片就要 150px：实测同侧相邻卡
  //    互相压掉 43px、日期徽章压掉 17px（用户截图里那排「2026-0」就是徽章被后一张
  //    盖掉后半截的结果）。密度交给 .chronicle-scroll 的横向滚动去承担，卡片才不必互盖。
  //    一槽要同时喂饱两样东西，取大者：
  //      · 卡片 150px —— 上下交错，同侧相邻卡隔【两】槽 ⇒ 槽 ≥ (150 + 18) / 2 = 84；
  //      · 日期徽章 —— 上下两排的徽章都骑在同一条轴带上，相邻只隔【一】槽
  //        ⇒ 槽 ≥ 徽章宽 + 12。徽章恒为 MM/DD（年份另起一行，见下面渲染），
  //          最宽实测 57px，所以这一条永远让位给卡片那条。
  //    槽宽因此是个常数，不随「文字大小」设置变 —— 这点是刻意的：改文字缩放不会
  //    重渲染本视图，任何「渲染时读一次 CSS 变量」的算法都会在改完字号后留下旧画布。
  //    轴上可用区间恒占画布 AXIS_BUDGET%（5.5%~94.5%），把「需要的像素」除以它就是画布宽；
  //    这样下面那句 step 的兜底压缩永远命中不到 MIN_STEP 以下。
  const AXIS_BUDGET = 89;
  const CANVAS_MIN = 1500;
  const CARD_W = 150;                 // 与 .chronicle-event 的 --tl-card-w 同源
  const SLOT_MIN = (CARD_W + 18) / 2;
  const GAP_MIN = 120;                // 一枚省略号芯片占的横向位置
  const TAIL_MIN = 46;                // 段尾安静带：徽章半宽 + 与芯片的间隙
  const canvasW = Math.max(CANVAS_MIN, ((events.length - 1) * SLOT_MIN + gaps.length * (GAP_MIN + TAIL_MIN)) * 100 / AXIS_BUDGET);
  const pct = (px) => px * 100 / canvasW;
  const MIN_STEP = pct(SLOT_MIN);
  const GAP_UNIT = pct(GAP_MIN);
  const TAIL_UNIT = pct(TAIL_MIN);
  const remaining = AXIS_BUDGET - gaps.length * GAP_UNIT;
  const step = Math.min(MIN_STEP, Math.max(1.5, (remaining - gaps.length * TAIL_UNIT) / Math.max(1, events.length - segments.length)));
  const mins = segments.map((s, k) => (s.length - 1) * step + (gaps[k] ? TAIL_UNIT : 0));
  const spare = Math.max(0, remaining - mins.reduce((a, b) => a + b, 0));
  const weights = segments.map((s) => Math.max(1, dayDiff(s[0].date, s.at(-1).date)));
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

  // 3) 逐段落位：先按真实时间比例，再「前推 + 后收」各扫一遍。
  //    只前推会在段尾溢出（比例位置贴近段尾时，后面的事件被推出段外）；
  //    宽度保底 (n-1)*step 在手，后收最坏也只是把整段压成等距，不会推出段外。
  const xs = [];
  const gapCenters = [];
  let cursor = 5.5;
  segments.forEach((seg, k) => {
    const start = cursor;
    const width = mins[k] + spare * weights[k] / weightSum;
    const end = start + width;
    const usable = width - (gaps[k] ? TAIL_UNIT : 0);
    const span = Math.max(1, dayDiff(seg[0].date, seg.at(-1).date));
    const px = seg.map((e) => start + (dayDiff(seg[0].date, e.date) / span) * usable);
    for (let i = 1; i < px.length; i++) px[i] = Math.max(px[i], px[i - 1] + step);
    px[px.length - 1] = Math.min(px[px.length - 1], start + usable);
    for (let i = px.length - 2; i >= 0; i--) px[i] = Math.min(px[i], px[i + 1] - step);
    xs.push(...px);
    cursor = end;
    if (gaps[k]) {
      // 芯片居中在「段尾尾巴 + 省略号区」拼成的安静带里，离两侧日期徽章各 ≥14px
      gapCenters.push(end + (GAP_UNIT - TAIL_UNIT) / 2);
      cursor += GAP_UNIT;
    }
  });

  // 桌面：横向年表。宽度按事件数撑出来（上面算的 canvasW），比容器宽就交给
  // .chronicle-scroll 横滚 —— 用 min-width 而不是 width，事件少时仍能铺满面板。
  const canvas = el("div", { class: "chronicle-canvas", style: `min-width:${Math.round(canvasW)}px;--tl-card-w:${CARD_W}px` });
  canvas.append(el("div", { class: "chronicle-axis" }));
  gaps.forEach((g, i) => {
    canvas.append(el("div", {
      class: "ce-gap", style: `left:${gapCenters[i]}%`,
      title: `此处省略 ${g.days} 天（${g.from} → ${g.to}）`,
    }, el("span", { class: "ce-gap-mark" }, "⋯⋯"), el("span", { class: "ce-gap-days" }, `省略 ${g.days} 天`)));
  });
  // 徽章恒为 MM/DD：轴带里上下两排的徽章相邻只隔【一】槽，完整日期太宽必然互盖
  // （推导见上面 SLOT_MIN）。完整日期在卡片第二行与悬浮 title 里都还在。
  // 跨年时年份另起一行塞进同一枚徽章 —— 写成「2026/09/12」会把徽章拉宽一倍，
  // 而槽位是按 MM/DD 定的；换行只让徽章长高几像素，轴带上下都有富余。
  let prevYear = null;
  events.forEach((e, i) => {
    const upper = i % 2 === 0;
    const year = String(e.date || "").slice(0, 4);
    const showYear = year !== prevYear;
    prevYear = year;
    canvas.append(el("div", {
      class: `chronicle-event ${upper ? "up" : "down"}`, style: `left:${xs[i]}%;--ec:${catTone(e).c};--tone-fg:${catTone(e).fg}`,
      title: e.date,
    },
      el("div", { class: "ce-card" }, el("b", {}, e.title), el("span", {}, `${e.date} · ${e.subtitle || e.kind}`)),
      el("div", { class: "ce-stem" }), el("div", { class: "ce-dot" }),
      el("div", { class: "ce-date" }, shortDate(e.date), showYear ? el("i", { class: "ce-year" }, year) : null),
    ));
  });
  root.append(el("div", { class: "chronicle-scroll", "data-zoom-surface": "" }, canvas));

  // 窄屏：纵向年表（长间隔同样给省略提示，两端语义一致）
  const vertical = el("div", { class: "chronicle-vertical" });
  events.forEach((e, i) => {
    if (i > 0) {
      const d = dayDiff(events[i - 1].date, e.date);
      if (d > gapThreshold) vertical.append(el("div", { class: "cv-gap" }, `⋯ 间隔 ${d} 天 ⋯`));
    }
    const side = i % 2 ? "right" : "left";
    vertical.append(el("article", { class: `cv-item ${side}`, style: `--ec:${catTone(e).c};--tone-fg:${catTone(e).fg}` },
      el("span", { class: "cv-date" }, e.date),
      el("div", { class: "cv-card" }, el("b", {}, e.title), el("span", {}, e.subtitle || e.kind)),
    ));
  });
  root.append(vertical);
  return root;
}

/* ── 卡片时间轴 ──
   本来就有一版窄屏改写（单列 + 中轴挪到左边），但卡片固定 270px 且不换行，
   日期是 15px 的裸文本，一屏只能看到一张半。窄屏改成更紧凑的单列卡片 +
   日期徽章，并保留中轴的视觉连接。
   v0.71.0 缩放：轨道外面必须有一层自己的滚动容器（.card-scroll）—— 轨道被 --tv-zoom
   放大后必然宽过面板，而 .tv-panel 是 overflow:hidden，没有这层就右半边直接被裁掉。 */
function cardTimelineView(data) {
  const root = el("section", { class: "tv-panel card-timeline-view" });
  root.append(head("卡片时间轴", "参考中国近代史时间轴：左右交错卡片，适合展示阶段说明和备注。"));
  if (!data.events.length) { root.append(empty()); return root; }
  const lane = el("div", { class: "card-timeline" });
  // 缩放层（v0.71.0）：zoom 只乘内容，轨道宽度另按系数算（见 styles.css .card-timeline 的推导）
  const zoomLayer = el("div", { class: "ct-zoom" });
  data.events.slice(0, 16).forEach((e, i) => {
    const side = i % 2 ? "right" : "left";
    zoomLayer.append(el("article", { class: `ct-item ${side}`, style: `--ct:${catTone(e).c}` },
      el("div", { class: "ct-card" },
        el("div", { class: "ct-date" }, e.date),
        el("h3", {}, e.title),
        el("p", {}, e.subtitle || `${e.kind} · ${CAT_NAME[e.cat] || "安排"}`),
      ),
      el("div", { class: "ct-link" }, el("i"), el("span")),
    ));
  });
  lane.append(zoomLayer);
  root.append(el("div", { class: "card-scroll", "data-zoom-surface": "" }, lane));
  return root;
}

/* ── 年度甘特 ──
   桌面 12 个月 × 每列 ≥70px，配 220px 标签列 = 1060px 起。
   窄屏改成「按月分组」折叠：一个月一组，组内是该月有交集的条，横轴改成 1…31 天刻度。
   全年 12 组默认只展开当前月，其余收起来 —— 38 条任务也不会一次糊满屏幕。 */
function ganttView(data) {
  const root = el("section", { class: "tv-panel gantt-view" });
  root.append(head("年度甘特图", "参考年度工作规划：按任务起止日期映射到月份，窄屏按月分组折叠。"));
  const rows = data.projects.flatMap(([group, list]) => list.map(x => ({ ...x, group }))).slice(0, 18);
  if (!rows.length) { root.append(empty("暂无可生成甘特图的任务")); return root; }
  const years = rows.flatMap(r => [parseDate(r.start).getFullYear(), parseDate(r.end).getFullYear()]);
  const year = years.sort((a, b) => a - b)[Math.floor(years.length / 2)] || new Date().getFullYear();
  const start = `${year}-01-01`, end = `${year}-12-31`, total = dayDiff(start, end) + 1;

  // 桌面：整年网格
  const grid = el("div", { class: "gantt-grid" });
  const header = el("div", { class: "gantt-headrow" }, el("div", { class: "gantt-label head" }, `${year} · 项目 / 任务`));
  for (let m = 1; m <= 12; m++) header.append(el("div", { class: "gantt-month" }, `${m}月`));
  grid.append(header);
  rows.forEach((r) => {
    const rs = clamp(dayDiff(start, r.start), 0, total - 1), re = clamp(dayDiff(start, r.end), rs, total - 1);
    const left = rs / total * 100, width = Math.max(1.2, (re - rs + 1) / total * 100);
    grid.append(el("div", { class: "gantt-row" },
      el("div", { class: "gantt-label" }, el("b", {}, r.group), el("span", {}, r.title)),
      el("div", { class: "gantt-cells" },
        ...Array.from({ length: 12 }, () => el("i")),
        el("div", { class: "gantt-bar", title: `${r.start} ~ ${r.end} · ${r.title}`, style: `left:${left}%;width:${width}%;background:${catTone(r).c};--tone-fg:${catTone(r).fg}` }, r.title),
      ),
    ));
  });
  root.append(el("div", { class: "gantt-scroll", "data-zoom-surface": "" }, grid));

  // 窄屏：按月折叠
  // 只列出「有内容的月份」加上当前月：一年 12 个月若全列出来，空月份（实测 8 个）
  // 的折叠标题会把真正有内容的那一个月推到屏幕之外，等于没适配。
  const yearRows = [];
  for (let m = 1; m <= 12; m++) {
    const dim = new Date(year, m, 0).getDate();
    const first = `${year}-${String(m).padStart(2, "0")}-01`, last = `${year}-${String(m).padStart(2, "0")}-${String(dim).padStart(2, "0")}`;
    yearRows.push({ m, dim, first, last, hit: rows.filter(r => r.start <= last && r.end >= first) });
  }
  const todayMonth = parseDate(S.todayStr()).getFullYear() === year ? parseDate(S.todayStr()).getMonth() + 1 : 0;
  const shown = yearRows.filter(r => r.hit.length || r.m === todayMonth);
  const monthly = el("div", { class: "gantt-monthly" });
  if (!shown.length) monthly.append(el("p", { class: "wm-none" }, "本年还没有带日期的任务。"));
  const onlyMonth = !shown.some(r => r.hit.length);
  for (const { m, dim, first, hit } of shown) {
    const fold = collapsible(`${year}.${String(m).padStart(2, "0")} · ${hit.length} 项`, "tv-fold-month", hit.length > 0 || onlyMonth);
    if (!hit.length) { fold.body.append(el("p", { class: "wm-none" }, "本月没有安排")); }
    hit.forEach((r) => {
      const from = Math.max(1, dayDiff(first, r.start) + 1), to = Math.min(dim, dayDiff(first, r.end) + 1);
      fold.body.append(el("article", { class: "gm-item" },
        el("div", { class: "gm-copy" }, el("b", {}, r.group), el("span", {}, r.title)),
        el("div", { class: "gm-track", style: `--days:${dim};--gm-from:${from};--gm-to:${to};--gm:${catTone(r).c}` },
          el("i", { class: "gm-span" }),
          el("small", {}, `${from} → ${to} 日`)),
      ));
    });
    monthly.append(fold.box);
  }
  root.append(monthly);
  return root;
}

/* ── 阶段甘特（泳道）──
   桌面 31 列 × ≥34px + 160px 标签 = 1214px 起，手机上横向滚到手酸。
   窄屏改成「按分类分组的进度条」：一行一个分类，条宽按该分类在本月的占比，
   下面列出该分类的时间块。分类数量固定 5 个，天然适合纵向排列。 */
function swimlaneView(data, anchorDate) {
  const root = el("section", { class: "tv-panel swimlane-view" });
  const anchor = parseDate(anchorDate || S.todayStr());
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const startDate = dateKey(new Date(y, m, 1)), endDate = dateKey(new Date(y, m + 1, 0));
  root.append(head("阶段甘特图", `${y}年${m + 1}月 · 参考阶段泳道图：按工作/学习/运动/生活/休息分组。`));
  const monthBlocks = data.blocks.filter(b => b.date >= startDate && b.date <= endDate);
  if (!monthBlocks.length) { root.append(empty("本月暂无时间块")); return root; }
  const days = parseDate(endDate).getDate();
  const CATS = ["work", "study", "sport", "life", "rest"];

  // 桌面：真泳道网格
  const lane = el("div", { class: "swim-grid" });
  const hdr = el("div", { class: "swim-head", style: `--days:${days}` }, el("div", { class: "swim-label swim-year" }, `${y}.${String(m + 1).padStart(2, "0")}`));
  for (let d = 1; d <= days; d++) hdr.append(el("div", { class: "swim-day" }, d));
  lane.append(hdr);
  for (const cat of CATS) {
    // 泳道一行就是一个分类，条当然也用这一行的分类色 —— 原来按 (行号 + 序号) 取彩虹色，
    // 同一行里每根条颜色都不一样，等于把「分类」这层信息又抹掉了。
    const row = el("div", { class: "swim-row" }, el("div", { class: "swim-label", style: `background:${CAT_COLOR[cat]};--tone-fg:${CAT_FG[cat]}` }, CAT_NAME[cat]));
    const cells = el("div", { class: "swim-cells", style: `--days:${days}` }, ...Array.from({ length: days }, () => el("i")));
    const list = monthBlocks.filter(b => (b.cat || "work") === cat);
    list.forEach((b) => {
      const d = parseDate(b.date).getDate();
      const width = Math.min(6, Math.max(1.3, b.durMin / 120));
      cells.append(el("div", { class: "swim-bar", title: `${b.date} ${b.start} · ${b.title}`, style: `left:${(d - 1) / days * 100}%;width:${width}%;background:${CAT_COLOR[cat]};--tone-fg:${CAT_FG[cat]}` }, b.title));
    });
    row.append(cells); lane.append(row);
  }
  root.append(el("div", { class: "swim-scroll", "data-zoom-surface": "" }, lane));

  // 窄屏：分类折叠 + 占比条
  // 默认只展开前两个有内容的分类：5 个分类全展开实测 1670px 高，一屏（844px）看不完，
  // 也就失去了「折叠」的意义。占比条在折叠态就能看出结构。
  const totalMin = monthBlocks.reduce((a, b) => a + Number(b.durMin || 0), 0);
  const mobile = el("div", { class: "swim-mobile" });
  let opened = 0;
  for (const cat of CATS) {
    const list = monthBlocks.filter(b => (b.cat || "work") === cat).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    const sum = list.reduce((a, b) => a + Number(b.durMin || 0), 0);
    const pct = totalMin ? Math.round(sum / totalMin * 100) : 0;
    const open = list.length > 0 && opened++ < 2;
    const fold = collapsible(`${CAT_NAME[cat]} · ${list.length} 块 · ${S.durLabel(sum)}`, "tv-fold-cat", open);
    fold.box.style.setProperty("--cat", CAT_COLOR[cat]);
    fold.body.append(el("div", { class: "sm-meter" }, el("i", { style: `width:${pct}%;background:${CAT_COLOR[cat]}` }), el("span", {}, `${pct}%`)));
    fold.body.append(...(list.length
      ? list.map(b => el("article", { class: "sm-item" },
        el("span", { class: "sm-date" }, shortDate(b.date)),
        el("div", { class: "sm-copy" }, el("b", {}, b.title),
          el("span", {}, [b.start, S.durLabel(b.durMin)].filter(Boolean).join(" · "))),
      ))
      : [el("p", { class: "wm-none" }, "本月没有这类安排")]));
    mobile.append(fold.box);
  }
  root.append(mobile);
  return root;
}
