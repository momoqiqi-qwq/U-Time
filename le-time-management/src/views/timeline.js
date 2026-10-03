// 时间线视图（v0.52.0 新增）—— APK 端核心视图，替代窄屏下的「时间块 / 收件箱」入口。
//
// 样式参照用户给的「America in the World」年表：一条中轴线贯穿上下，
// 年份徽章标在轴上（跨年时出现），日期徽章骑在轴上，卡片左右交错。
// 收起的卡片只露「时间点 + 标题」；点一下就地展开，显示：
//   · 具体到点的完整时间（2026年9月18日 周五 · 14:00 – 15:30 · 1 小时 30 分钟）
//   · 正文（任务 note；时间块给分类 / 时长 / 关联任务）
//
// 数据面：collectTimelineEvents() / buildTimelineModel() 是纯函数（不碰 DOM），
// scripts/test-timeline-view.mjs 直接对它们做单测；渲染层只消费模型。
import * as S from "../store.js";
import { el, newBadge, QUADS } from "../ui.js";
import { openTaskDrawer } from "./drawer.js";
import { getKeywordHighlights, highlightedText } from "../keywordHighlights.js";
import { createKeyedNodes } from "../keyedNodes.js";

/* ── 分类色（唯一事实源是 styles.css 的 --cat-*，这里只做引用）──
   不要再写死强调色令牌：那等于在 JS 里维护第二份映射，一改就漏（历史上有 4 套）。 */
const CAT_COLOR = { work: "var(--cat-work)", study: "var(--cat-study)", sport: "var(--cat-sport)", life: "var(--cat-life)", rest: "var(--cat-rest)" };
const CAT_NAME = { work: "工作", study: "学习", sport: "运动", life: "生活", rest: "休息" };
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function taskCatOf(t) {
  const tag = (t.tags || [])[0] || "";
  const map = { 论文: "work", 工作: "work", 学习: "study", 读书: "study", 运动: "sport", 健身: "sport", 跑步: "sport", 生活: "life", 休息: "rest" };
  return map[tag] || "work";
}
function quadTitle(q) { return QUADS.find((x) => x.q === q)?.title || ""; }

/**
 * 纯函数：把 state 里的时间块 + 带截止日任务摊平成时间线事件，按「日期 → 时间点」升序。
 * 无截止日的任务不上时间线（没有日期锚点）；已完成的任务保留（时间线是编年回顾）。
 */
export function collectTimelineEvents(state) {
  const events = [];
  for (const b of state?.blocks || []) {
    events.push({
      id: `blk:${b.id}`, kind: "block", date: String(b.date || "").slice(0, 10),
      time: b.start || "00:00", title: b.title || "未命名时间块",
      cat: b.cat || "work", durMin: Number(b.durMin) || 0, taskId: b.taskId || null, note: "",
      ...(b.isNew === true ? { isNew: true } : {}),
    });
  }
  for (const t of state?.tasks || []) {
    const date = String(t.due || "").slice(0, 10);
    if (!date) continue;
    events.push({
      id: `task:${t.id}`, kind: "task", date, time: t.dueTime || "23:59",
      title: t.title || "未命名任务", cat: taskCatOf(t), durMin: 0, taskId: t.id,
      note: t.note || "", done: !!t.done, quad: t.quad ?? null, project: t.project || "",
      ...(t.isNew === true ? { isNew: true } : {}),
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
  return events;
}

/**
 * 纯函数：事件按日期分组；每组带 weekday / isToday / isPast / hasOverdue，
 * 以及 year / yearChanged（首组和跨年处为 true，渲染层据此画年份徽章）。
 */
export function buildTimelineModel(state, today) {
  const events = collectTimelineEvents(state);
  const groups = [];
  let prevYear = null;
  for (const e of events) {
    let g = groups.at(-1);
    if (!g || g.date !== e.date) {
      const [y, m, d] = e.date.split("-").map(Number);
      const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()] || "";
      const year = Number.isFinite(y) ? y : "";
      g = {
        date: e.date, year, monthDay: `${m}/${d}`,
        fullLabel: `${year}年${m}月${d}日${weekday ? ` ${weekday}` : ""}`,
        weekday, items: [],
        isToday: e.date === today, isPast: e.date < today,
        yearChanged: year !== prevYear,
      };
      prevYear = year;
      groups.push(g);
    }
    g.items.push(e);
  }
  for (const g of groups) {
    g.hasOverdue = g.isPast && g.items.some((x) => x.kind === "task" && !x.done);
    g.hasDone = g.items.some((x) => x.kind === "task" && x.done);
  }
  return { today, groups };
}

/* ── 渲染 ── */

export function renderTimeline(container) {
  // 展开状态跨重渲染保持（与四象限 expandedCards 同一套思路，闭包级即可：
  // 离开视图再回来重新收起，符合「视图重进重置」的直觉）
  const expanded = new Set();
  const today = S.todayStr();
  let highlightCfg = getKeywordHighlights(S.getState().settings);

  const wrap = el("div", { class: "tlv" });
  const axis = el("div", { class: "tlv-axis", "aria-hidden": "true" });
  const lane = el("div", { class: "tlv-lane" });
  const reconcileRows = createKeyedNodes(lane);

  // 「回到今天」：sticky 小胶囊，长时间线滚远了能一键跳回
  const jump = el("button", { class: "tlv-jump", type: "button", title: "回到今天", onclick: () => scrollToToday(true) }, "◎ 今天");

  function cardBodyInner(e, g) {
    const parts = [];
    if (e.kind === "block") {
      const end = S.hhmmOf(S.mmOf(e.time) + e.durMin);
      parts.push(el("p", { class: "tlv-when" },
        highlightedText(`${g.fullLabel} · ${e.time} – ${end} · ${S.durLabel(e.durMin)}`, highlightCfg)));
      const task = e.taskId ? S.taskById(e.taskId) : null;
      parts.push(el("div", { class: "tlv-note" },
        el("b", {}, `${CAT_NAME[e.cat] || e.cat} · 时间块`),
        task ? el("span", {}, highlightedText(`来自任务「${task.title}」的排程`, highlightCfg)) : el("span", { class: "dim" }, "独立安排，没有正文备注"),
      ));
      if (task) {
        parts.push(el("button", { class: "btn ghost sm tlv-more", type: "button", onclick: (ev) => { ev.stopPropagation(); openTaskDrawer(task.id); } }, "任务详情"));
      }
    } else {
      const marks = [`${g.fullLabel} · ${e.time} 截止`];
      if (e.done) marks.push("已完成");
      else if (g.isPast) marks.push("已过期");
      if (e.quad) marks.push(quadTitle(e.quad).split(" · ")[0]);
      if (e.project) marks.push(e.project);
      parts.push(el("p", { class: "tlv-when" }, highlightedText(marks.join(" · "), highlightCfg)));
      parts.push(el("div", { class: "tlv-note" },
        el("b", {}, "正文"),
        e.note
          ? el("span", {}, highlightedText(e.note, highlightCfg))
          : el("span", { class: "dim" }, "没有写正文备注"),
      ));
      parts.push(el("button", { class: "btn ghost sm tlv-more", type: "button", onclick: (ev) => { ev.stopPropagation(); openTaskDrawer(e.taskId); } }, "任务详情"));
    }
    return parts;
  }

  function cardEl(e, g) {
    const open = expanded.has(e.id);
    const card = el("article", {
      class: `tlv-card kind-${e.kind}${e.done ? " is-done" : ""}${open ? " open" : ""}${g.isPast ? " is-past" : ""}`,
      style: `--tc:${CAT_COLOR[e.cat] || CAT_COLOR.work}`,
      "data-event": e.id,
      tabindex: "0", role: "button",
      "aria-expanded": open ? "true" : "false",
    },
      el("div", { class: "tlv-card-head" },
        el("span", { class: "tlv-time" }, highlightedText(e.kind === "block" ? e.time : `${e.time} 截止`, highlightCfg)),
        el("span", { class: "tlv-kind" }, e.kind === "block" ? (CAT_NAME[e.cat] || "安排") : "任务"),
        e.kind === "task" && e.done ? el("span", { class: "tlv-flag done" }, "✓ 完成") : null,
        e.kind === "task" && !e.done && g.isPast ? el("span", { class: "tlv-flag overdue" }, "已过期") : null,
      ),
      el("h3", { class: "tlv-title" }, el("span", {}, highlightedText(e.title, highlightCfg)), newBadge(e.isNew === true)),
      e.kind === "block" && e.durMin ? el("span", { class: "tlv-brief" }, S.durLabel(e.durMin)) : null,
      el("div", { class: "tlv-card-body" },
        el("div", { class: "tlv-card-body-inner" }, cardBodyInner(e, g))),
    );
    const toggle = () => {
      if (expanded.has(e.id)) expanded.delete(e.id);
      else expanded.add(e.id);
      const nowOpen = expanded.has(e.id);
      card.classList.toggle("open", nowOpen);
      card.setAttribute("aria-expanded", nowOpen ? "true" : "false");
      if (e.isNew) {
        if (e.kind === "task") S.markTaskSeen(e.taskId);
        else S.markBlockSeen(e.id.slice(4));
      }
    };
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
    });
    return card;
  }

  function render() {
    const scrollTop = container.scrollTop;
    const state = S.getState();
    highlightCfg = getKeywordHighlights(state.settings);
    const model = buildTimelineModel(state, today);
    const rows = [];
    const taskTitles = new Map(state.tasks.map((task) => [task.id, task.title]));
    if (!model.groups.length) {
      rows.push({ key: "empty", signature: "empty", create: () => el("div", { class: "tlv-empty" },
        el("div", { class: "tlv-empty-icon", "aria-hidden": "true" }, "⌁"),
        el("b", {}, "时间线上还没有节点"),
        el("span", {}, "创建带截止日的任务或安排时间块后，它们会按日期串在这里。")) });
    }
    // 逐行左右交错（参考图样式）：同一天的多张卡也左右都占，不整组堆一侧。
    // side 用全局行序奇偶（跨组连续），日期徽章只出现在组首行骑轴，其余行用小圆点。
    let rowIndex = 0;
    for (const g of model.groups) {
      if (g.yearChanged) {
        rows.push({ key: `year:${g.year}`, signature: String(g.year), create: () => el("div", { class: "tlv-year-row", role: "separator" },
          el("span", { class: "tlv-year", "aria-hidden": "true" }, String(g.year)),
          el("b", { class: "tlv-year-label" }, `${g.year} 年`)) });
      }
      g.items.forEach((e, i) => {
        const side = rowIndex % 2 === 0 ? "left" : "right";
        rowIndex++;
        rows.push({ key: e.id, signature: JSON.stringify([e, g.fullLabel, g.isToday, g.isPast, g.hasOverdue, i === 0, side, highlightCfg, taskTitles.get(e.taskId)]),
          create: () => el("div", { class: `tlv-row side-${side}${g.isToday ? " is-today" : ""}` },
          el("div", { class: "tlv-cards" }, cardEl(e, g)),
          i === 0
            ? el("div", { class: "tlv-badge", "aria-label": g.fullLabel },
              el("b", {}, g.monthDay),
              g.isToday ? el("i", { class: "tlv-badge-today" }, "今天") : null,
              g.hasOverdue ? el("i", { class: "tlv-badge-dot", title: "有过期未完成任务" }) : null,
            )
            : el("i", { class: "tlv-dot", "aria-hidden": "true" }),
        ) });
      });
    }
    reconcileRows(rows);
    if (!wrap.contains(lane)) wrap.replaceChildren(axis, lane);
    if (!container.contains(wrap)) container.replaceChildren(jump, wrap);
    container.scrollTop = scrollTop;
  }

  function scrollToToday(smooth) {
    const badge = container.querySelector(".tlv-row.is-today");
    if (!badge) return;
    badge.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  }

  render();
  // 首次进入把今天滚到可视区中央（只此一次，后续重渲染保持滚动位置）
  requestAnimationFrame(() => scrollToToday(false));
  const un = S.subscribe(render);
  container._unsub = () => { un(); };
}

export { CAT_NAME as TIMELINE_CAT_NAME };
