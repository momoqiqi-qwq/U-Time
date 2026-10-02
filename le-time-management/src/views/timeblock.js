// 时间块视图 —— 概念稿 04「潮汐」：任务池 + 24h 时间轴 + 右侧概览
import * as S from "../store.js";
import { el, popmenu, toast, pointerDrag } from "../ui.js";
import { openTaskDrawer } from "./drawer.js";
import { previewSchedule } from "../scheduleConflict.js";
import { getTaskPreferences } from "../taskPreferences.js";
import { closeLayer, reducedMotion } from "../motion.js";
import { createTimeViewSwitcher, createTimeViewZoom, attachViewZoomGestures, renderTimeView } from "./timeViews.js";

const DAY_END = 24 * 60;     // 24:00
const HOUR_PX = 62;
const PX_PER_MIN = HOUR_PX / 60;

/* 分类色：唯一事实源是 styles.css 的 --cat-*（一种类型一种颜色），这里只做引用。
   历史坑：本文件原来自带一份 { work: var(--deep), study: var(--grape), ... }，
   而时间视图那边是另一份十六进制表，同一个「工作」在两边颜色不同。 */
const CAT_COLOR = {
  work: "var(--cat-work)", study: "var(--cat-study)", sport: "var(--cat-sport)",
  life: "var(--cat-life)", rest: "var(--cat-rest)",
};

export function renderTimeblock(container) {
  let DAY_START = 7 * 60;
  let curDate = S.getState().settings.lastDate || S.todayStr();
  container.classList.add("tb-root");
  let viewMode = S.getState().settings.timeViewMode || "day";
  const shell = el("div", { class: "tb-shell" });
  const wrap = el("div", { class: "tb-wrap" });
  const altHost = el("div", { class: "time-alt-host", style: "display:none" });
  const switcher = createTimeViewSwitcher({ current: viewMode, onChange: (mode) => {
    viewMode = mode;
    S.getState().settings.timeViewMode = mode;
    S.saveNow();
    switcher.setCurrent(mode);
    syncView();
  } });
  /* 缩放控制器（v0.71.0）：系数写在视图根容器上 —— 日时间轴与其余六种视图都是它的后代，
     七种视图共用同一个比例，也共用右上角那三颗键。挂在容器而不是 documentElement 上：
     离开视图时节点一起消失，不会污染别的页面（CSS 侧一律写 var(--tv-zoom, 1) 兜底）。 */
  const zoom = createTimeViewZoom(container);
  switcher.append(zoom.bar);
  shell.append(switcher, wrap, altHost);
  container.append(shell);

  const persistDate = () => { S.getState().settings.lastDate = curDate; S.persistSoon(); };

  /* ── 左：任务池 ── */
  const poolList = el("div", { class: "plist" });
  const poolTitle = el("div", { class: "pt" });
  const poolReturnTarget = el("div", { class: "pool-return-target", "aria-hidden": "true" },
    el("span", { class: "pool-return-icon" }, "↩"),
    el("b", {}, "松开移回任务池"),
    el("small", {}, "保留任务，只取消当天排程"),
  );
  const pool = el("div", { class: "pool", role: "region", "aria-label": "任务池，可接收已排任务" }, poolTitle, poolList, poolReturnTarget);

  const pointInPool = (x, y) => {
    const rect = pool.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };
  function paintPoolReturn(active = false, ready = false) {
    pool.classList.toggle("block-return-active", active);
    pool.classList.toggle("block-return-ready", active && ready);
  }
  function animateReturnedTask(taskId, fromRect) {
    if (reducedMotion()) return;
    requestAnimationFrame(() => {
      const card = [...poolList.querySelectorAll(".ptask")].find((item) => item.dataset.task === taskId);
      if (!card?.animate) return;
      const landed = card.getBoundingClientRect();
      const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
      card.animate([
        { opacity: .35, transform: `translate(${(fromRect.left - landed.left) / scale}px, ${(fromRect.top - landed.top) / scale}px) scale(.9) rotate(1deg)` },
        { opacity: 1, transform: "none" },
      ], { duration: 260, easing: "cubic-bezier(.22,.8,.22,1)" });
    });
  }

  function poolCard(t) {
    const card = el("div", { class: "ptask", "data-task": t.id, title: "拖入右侧时间轴，或点击自动安排" },
      el("div", { class: "n" }, t.title),
      el("div", { class: "m" },
        el("span", { class: `cat-pill cat-${catOf(t)}` }, catLabelOf(t)),
        el("span", {}, S.durLabel(t.estMin)),
        t.due ? el("span", {}, `截止 ${t.due.slice(5)}`) : null,
      ),
    );
    card.addEventListener("pointerdown", (e) => {
      pointerDrag(e, { type: "task", task: t }, {
        ghostHTML: (() => { const g = el("div", { class: `block cat-block-${catOf(t)}`, style: "width:190px;padding:9px 13px" }, el("div", { class: "bn" }, t.title)); return g; })(),
        onMove: (ev) => showHint(ev, t.estMin),
        onDrop: (d) => { hideHint(); dropTask(d, t); },
        onClick: () => { hideHint(); autoPlace(t); },
      });
    });
    return card;
  }

  function renderPool() {
    const items = S.poolOf(curDate);
    poolTitle.textContent = `待安排 · ${items.length} 件`;
    poolList.replaceChildren(
      ...(items.length ? items.map(poolCard) : [el("div", { class: "empty" }, "全部安排完了", el("br"), "也可以在下方添加空白时间块")]),
    );
  }

  /* ── 中：时间轴 ── */
  const canvas = el("div", { class: "tl-canvas" });
  const scroll = el("div", { class: "tl-scroll" }, canvas);
  const dateLabel = el("b", {});
  const sumLabel = el("span", { class: "sum" });
  const tlHead = el("div", { class: "tl-head" },
    dateLabel,
    el("div", { class: "dnav" },
      el("button", { title: "前一天", onclick: () => { curDate = S.addDays(curDate, -1); persistDate(); renderAll(); } }, "‹"),
      el("button", { title: "回到今天", onclick: () => { curDate = S.todayStr(); persistDate(); renderAll(); } }, "◎"),
      el("button", { title: "后一天", onclick: () => { curDate = S.addDays(curDate, 1); persistDate(); renderAll(); } }, "›"),
    ),
    sumLabel,
  );
  const timeline = el("div", { class: "timeline" }, tlHead, scroll);

  const quickInput = el("input", { placeholder: "加一段空白时间，如「午休」；回车放到第一个空闲位" });
  const addBlankBlock = (title) => {
    const cfg = getTaskPreferences(S.getState().settings);
    return autoPlace({ title, estMin: cfg.blankBlockMin, id: null, __cat: cfg.blankBlockCategory });
  };
  quickInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const v = quickInput.value.trim();
    if (!v) return;
    if (addBlankBlock(v)) quickInput.value = "";
  });
  const addbar = el("div", { class: "tl-addbar" }, quickInput, el("button", { class: "btn pri sm", onclick: () => { const title = quickInput.value.trim(); if (!title) { quickInput.focus(); toast("先写时间块名称"); return; } if (addBlankBlock(title)) quickInput.value = ""; } }, "添加"));
  timeline.append(addbar);

  const hint = el("div", { class: "drop-hint", style: "display:none" });
  let hintTimer = null;

  /* 指针坐标 → 画布内的分钟数。🔴 必须先除以生效缩放系数再换算。
     CSS `zoom` 是布局级的：clientY 与 getBoundingClientRect 给的都是物理像素，
     而块的内联 top/height 写在未缩放的空间里（zoom 由 CSS 统一乘）。不除的话
     150% 下会把 1 分钟当成 1.5 分钟 —— 落点偏一半，实测（探针量过 rect 随 zoom 放大）。
     两个系数都要算进来：本视图的 --tv-zoom（捏合 / 三键）与「界面缩放」的 root zoom，
     后者是这次顺手补上的同一类漏算。 */
  const viewScale = () => zoom.get() * (Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1);
  const minFromY = (y, rect) => Math.round(((y - rect.top) / viewScale() - 10) / PX_PER_MIN / 15) * 15 + DAY_START;

  function showHint(ev, durMin) {
    const rect = canvas.getBoundingClientRect();
    if (ev.clientY < rect.top - 30 || ev.clientY > rect.bottom + 30) { hint.style.display = "none"; return; }
    const min = minFromY(ev.clientY, rect);
    hint.style.display = "";
    hint.style.top = `${(min - DAY_START) * PX_PER_MIN + 10}px`;
    hint.dataset.label = `${S.hhmmOf(min)} – ${S.hhmmOf(min + durMin)}`;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 2500);
  }
  function hideHint() { hint.style.display = "none"; }

  function dropTask({ x, y }, t) {
    const rect = canvas.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const min = Math.max(DAY_START, minFromY(y, rect));
    try { S.placeTask(t, curDate, min, t.__cat || catOf(t)); }
    catch (e) {
      const preview = previewSchedule(S.blocksOf(curDate), { startMin: min, durMin: Math.max(15, Number(t.estMin) || 30) }, { dayStart: DAY_START, dayEnd: DAY_END });
      const alt = preview.alternatives[0];
      toast(alt ? `${e.message}；可改到 ${alt.start}` : e.message, alt ? { actionLabel: `排到 ${alt.start}`, ms: 6500, action: () => { try { S.placeTask(t, curDate, alt.startMin, t.__cat || catOf(t)); } catch (err) { toast(err.message); } } } : {});
    }
  }

  function autoPlace(t) {
    try {
      const b = S.placeTask(t, curDate, null, t.__cat || catOf(t));
      toast(`已安排 ${b.start} · ${b.title}`);
      return true;
    } catch (e) { toast(e.message); return false; }
  }

  function editBlock(b) {
    document.querySelector(".drawer")?._close?.();
    const mask = el("div", { class: "drawer-mask", onclick: close });
    const title = el("input", { value: b.title, required: "", "aria-label": "时间块名称" });
    const date = el("input", { type: "date", value: b.date, required: "" });
    const start = el("input", { type: "time", value: b.start, required: "" });
    const duration = el("input", { type: "number", min: 1, max: 1440, value: b.durMin, required: "" });
    const category = el("select", {});
    S.CATEGORIES.forEach(c => category.append(el("option", { value: c.id }, c.label)));
    category.value = b.cat;
    const conflictBox = el("div", { class: "conflict-preview ok" });
    const getPreview = () => {
      const min = S.mmOf(start.value || "00:00"), dur = Number(duration.value);
      if (!date.value || !Number.isFinite(dur) || dur <= 0 || min + dur > 1440) return null;
      return previewSchedule(S.blocksOf(date.value), { startMin: min, durMin: dur }, { ignoreId: b.id, dayStart: DAY_START, dayEnd: DAY_END });
    };
    const paintConflict = () => {
      const p = getPreview();
      conflictBox.replaceChildren();
      if (!p) { conflictBox.className = "conflict-preview"; conflictBox.append("请先填写有效日期、开始时间和时长"); return; }
      if (p.ok) { conflictBox.className = "conflict-preview ok"; conflictBox.append("✓ 当前时段没有冲突"); return; }
      conflictBox.className = "conflict-preview";
      const names = p.conflicts.slice(0, 3).map((x) => `${x.start} ${x.title}`).join("、");
      conflictBox.append(el("div", {}, `⚠ 与 ${names || `${p.conflicts.length} 个时间块`} 冲突`));
      if (p.alternatives.length) {
        const alts = el("div", { class: "conflict-alts" });
        for (const alt of p.alternatives.slice(0, 3)) alts.append(el("button", { type: "button", class: "btn ghost sm", onclick: () => { start.value = alt.start; paintConflict(); } }, `改到 ${alt.start}`));
        conflictBox.append(alts);
      } else conflictBox.append(el("div", {}, "当天没有找到足够的连续空闲时间"));
    };
    const form = el("form", { class: "dbody", onsubmit: (e) => {
      e.preventDefault();
      const name = title.value.trim(), min = S.mmOf(start.value), dur = Number(duration.value);
      if (!name) { toast("时间块名称不能为空"); return; }
      if (min + dur > 1440) { toast("时间块不能跨越当天午夜"); return; }
      const preview = getPreview();
      if (!preview?.ok) { paintConflict(); toast("当前时段有冲突，可直接选择下方候选时间"); return; }
      S.updateBlock(b.id, { title: name, date: date.value, start: start.value, durMin: dur, cat: category.value });
      close(); toast("时间块已保存");
    } });
    for (const [label, input] of [["名称", title], ["日期", date], ["开始时间", start], ["时长（分钟）", duration], ["分类", category]]) form.append(el("label", { class: "kv" }, el("span", {}, label), input));
    for (const input of [date, start, duration]) input.addEventListener("input", paintConflict);
    form.append(conflictBox, el("button", { class: "btn pri", type: "submit" }, "保存时间块"));
    paintConflict();
    const drawer = el("div", { class: "drawer", role: "dialog", "aria-label": "编辑时间块" }, el("div", { class: "dh" }, el("h3", {}, "编辑时间块"), el("button", { class: "btn ghost sm", onclick: close }, "关闭")), form);
    const onKey = e => { if (e.key === "Escape") close(); };
    function close() { closeLayer(drawer, mask, () => document.removeEventListener("keydown", onKey)); }
    drawer._close = close;
    document.addEventListener("keydown", onKey);
    document.body.append(mask, drawer);
    title.focus();
  }

  function blockEl(b) {
    const top = (S.mmOf(b.start) - DAY_START) * PX_PER_MIN;
    const h = Math.max(22, b.durMin * PX_PER_MIN - 3);
    const node = el("div", {
      class: `block cat-block-${b.cat}${b.durMin <= 25 ? " tiny" : ""}`,
      style: `top:${top}px;height:${h}px`,
      "data-block": b.id,
    },
      el("div", { class: "bn" }, b.title),
      h > 40 ? el("div", { class: "bm" }, `${b.start} – ${S.hhmmOf(S.mmOf(b.start) + b.durMin)} · ${catLabelOf(b)}`) : null,
    );
    node.addEventListener("pointerdown", (e) => {
      const canReturnToPool = Boolean(b.taskId && S.taskById(b.taskId));
      pointerDrag(e, { type: "block", block: b }, {
        ghostHTML: (() => { const g = el("div", { class: `block cat-block-${b.cat}`, style: `width:${node.offsetWidth}px;height:${Math.min(h, 44)}px;padding:9px 13px` }, el("div", { class: "bn" }, b.title)); return g; })(),
        onMove: (ev) => {
          const overPool = canReturnToPool && pointInPool(ev.clientX, ev.clientY);
          paintPoolReturn(canReturnToPool, overPool);
          if (overPool) hideHint(); else showHint(ev, b.durMin);
        },
        onDrop: (d) => {
          hideHint();
          const returnToPool = canReturnToPool && pointInPool(d.x, d.y);
          paintPoolReturn();
          if (returnToPool) {
            const fromRect = node.getBoundingClientRect();
            const removed = S.removeBlock(b.id);
            if (!removed) return;
            animateReturnedTask(b.taskId, fromRect);
            toast("已移回任务池", { actionLabel: "撤销", action: () => S.addBlock(removed) });
            return;
          }
          const rect = canvas.getBoundingClientRect();
          if (d.x < rect.left || d.x > rect.right || d.y < rect.top || d.y > rect.bottom) return;
          const min = Math.min(DAY_END - b.durMin, Math.max(DAY_START, minFromY(d.y, rect)));
          const preview = previewSchedule(S.blocksOf(curDate), { startMin: min, durMin: b.durMin }, { ignoreId: b.id, dayStart: DAY_START, dayEnd: DAY_END });
          if (!preview.ok) {
            const alt = preview.alternatives[0];
            toast(alt ? `这个时段已有安排，可改到 ${alt.start}` : "这个时段已有安排，且当天没有合适空档", alt ? { actionLabel: `改到 ${alt.start}`, ms: 6500, action: () => S.updateBlock(b.id, { date: curDate, start: alt.start }) } : {});
            return;
          }
          S.updateBlock(b.id, { date: curDate, start: S.hhmmOf(min) });
        },
        onClick: (ev) => { hideHint(); paintPoolReturn(); blockMenu(ev, b); },
        onCancel: () => { hideHint(); paintPoolReturn(); },
      });
    });
    node.addEventListener("contextmenu", (e) => { e.preventDefault(); blockMenu(e, b); });
    return node;
  }

  function blockMenu(ev, b) {
    popmenu(ev.clientX, ev.clientY, [
      { label: "编辑时间块", run: () => editBlock(b) },
      ...(b.taskId ? [{ label: "打开任务详情", run: () => openTaskDrawer(b.taskId) }, { label: S.taskById(b.taskId)?.done ? "标记未完成" : "标记任务完成", run: () => S.toggleTask(b.taskId) }] : []),
      { label: "时长 +15 分钟", run: () => { const end = S.mmOf(b.start) + b.durMin + 15; if (end > DAY_END || S.blocksOf(b.date).some(x => x.id !== b.id && S.mmOf(b.start) < S.mmOf(x.start) + x.durMin && end > S.mmOf(x.start))) { toast("延长后会与已有安排冲突或超出当天"); return; } S.updateBlock(b.id, { durMin: b.durMin + 15 }); } },
      { label: "时长 −15 分钟", icon: "－", run: () => S.updateBlock(b.id, { durMin: Math.max(15, b.durMin - 15) }) },
      { label: "换分类", run: () => {
        const cats = ["work", "study", "sport", "life", "rest"];
        S.updateBlock(b.id, { cat: cats[(cats.indexOf(b.cat) + 1) % cats.length] });
      } },
      "-",
      ...(b.taskId ? [{ label: "移回任务池", icon: "↩", run: () => { const removed = S.removeBlock(b.id); toast("已移回任务池", { action: () => S.addBlock(removed) }); } }] : []),
      { label: "删除时间块", icon: "✕", warn: true, run: () => {
        const b2 = S.removeBlock(b.id);
        toast("已删除时间块", { actionLabel: "撤销", action: () => S.addBlock(b2) });
      } },
    ]);
  }

  function renderCanvas() {
    // 自动排程和已有凌晨安排都必须落在可见范围，按整点扩展时间轴。
    let earliest = Math.min(420, S.mmOf(getTaskPreferences(S.getState().settings).autoScheduleStart));
    for (const block of S.blocksOf(curDate)) {
      const start = S.mmOf(block.start);
      if (Number.isFinite(start) && start >= 0) earliest = Math.min(earliest, start);
    }
    DAY_START = Math.floor(earliest / 60) * 60;
    hideHint();
    canvas.replaceChildren(hint);
    for (let m = DAY_START; m <= DAY_END; m += 60) {
      const row = el("div", { class: "hour-row" }, el("span", { class: "h" }, m === 1440 ? "24:00" : S.hhmmOf(m)));
      canvas.append(row);
    }
    for (const b of S.blocksOf(curDate)) canvas.append(blockEl(b));
    // 现在指示线
    if (curDate === S.todayStr()) {
      const now = new Date();
      const min = now.getHours() * 60 + now.getMinutes();
      if (min >= DAY_START && min <= DAY_END) {
        canvas.append(el("div", { class: "now-line", style: `top:${(min - DAY_START) * PX_PER_MIN + 10}px` },
          el("span", { class: "t" }, `现在 ${S.hhmmOf(min)}`)));
      }
    }
    const [y, m, d] = curDate.split("-").map(Number);
    dateLabel.textContent = `${m}月${d}日 · 周${S.weekdayCN(curDate)}${curDate === S.todayStr() ? " · 今天" : ""}`;
    const total = S.blocksOf(curDate).reduce((a, b) => a + b.durMin, 0);
    sumLabel.innerHTML = `已排 <b>${S.durLabel(total)}</b> · ${S.blocksOf(curDate).length} 个时间块`;
  }

  /* ── 右：概览 ── */
  const aside = el("div", { class: "tb-aside" });
  function renderAside() {
    const blocks = S.blocksOf(curDate);
    const total = blocks.reduce((a, b) => a + b.durMin, 0);
    const awake = DAY_END - DAY_START;
    const byCat = {};
    for (const b of blocks) byCat[b.cat] = (byCat[b.cat] || 0) + b.durMin;
    const meter = el("div", { class: "meter" });
    const legend = el("div", { class: "legend" });
    const colors = CAT_COLOR;
    const names = { work: "深度工作", study: "学习", sport: "运动", life: "生活", rest: "休息" };
    for (const [cat, min] of Object.entries(byCat)) {
      meter.append(el("i", { style: `width:${(min / Math.max(total, 1)) * 100}%;background:${colors[cat]}` }));
      legend.append(el("span", {}, el("i", { style: `background:${colors[cat]}` }), `${names[cat]} ${S.durLabel(min)}`));
    }

    // 本周节奏（当日往前 6 天的排程量）
    const rh = el("div", { class: "rhythm" });
    for (let i = -6; i <= 0; i++) {
      const d = S.addDays(curDate, i);
      const v = S.blocksOf(d).reduce((a, b) => a + b.durMin, 0);
      rh.append(el("div", { class: "r", style: i === 0 ? "background:#DCEAEF" : "" },
        el("i", { style: `height:${Math.min(100, (v / 480) * 100)}%` }),
        el("em", {}, S.weekdayCN(d))));
    }

    // 明日预告
    const nextDate = S.addDays(curDate, 1);
    const tom = S.blocksOf(nextDate).slice(0, 4);

    aside.replaceChildren(
      el("div", { class: "acard" },
        el("div", { class: "at" }, "这 天 已 排"),
        el("div", { class: "big" }, S.durLabel(total), el("small", {}, `/ ${S.durLabel(awake)} 清醒时间`)),
        meter, legend,
      ),
      el("div", { class: "acard rh-wrap" },
        el("div", { class: "at" }, "近 7 天节奏"),
        rh,
      ),
      el("div", { class: "acard tomorrow" },
        el("div", { class: "at" }, "明 天 预 告"),
        ...(tom.length ? tom.map((b) => el("div", { class: "trow" },
          el("span", { class: "td", style: `background:${CAT_COLOR[b.cat] || CAT_COLOR.work}` }),
          el("span", { class: "tt" }, `${b.start} ${b.title}`),
          el("span", { class: "du" }, S.durLabel(b.durMin)),
        )) : [el("div", { class: "trow" }, el("span", { class: "tt", style: "color:var(--ink-3)" }, "明天还是空的，去前面安排一下吧"))]),
      ),
    );
  }

  /* ── 拼装 ── */
  function syncView() {
    const day = viewMode === "day";
    wrap.style.display = day ? "flex" : "none";
    altHost.style.display = day ? "none" : "block";
    if (day) { renderPool(); renderCanvas(); renderAside(); }
    else renderTimeView(altHost, viewMode, curDate, zoom);
  }
  function renderAll() { syncView(); }
  wrap.append(pool, timeline, aside);
  // 日时间轴的手势面 = 它自己的滚动容器。双击不复位：这里双击会命中时间块弹出块菜单，
  // 一次双击同时「改比例 + 开菜单」是最坏的巧合，回头路交给右上角那颗默认键。
  attachViewZoomGestures(scroll, zoom, { dblToReset: false });
  renderAll();
  const un = S.subscribe(renderAll);
  container._unsub = () => {
    un(); clearTimeout(hintTimer); container.classList.remove("tb-root");
    // 缩放系数挂在 container 上，节点一起消失就干净了；但待落盘的那一笔要结掉，
    // 否则 600ms 定时器跨视图存活、写盘的时机跟着漂。
    zoom.flush();
    // 视图菜单挂在 body 上，离开视图必须收走，否则会残留在其他页面上（实测）。
    switcher._closeMenu?.();
    document.querySelectorAll(".time-viewmenu").forEach((m) => m.remove());
  };
}

function catOf(t) {
  if (t.__cat) return t.__cat;
  const tag = (t.tags || [])[0] || "";
  const map = { 论文: "work", 工作: "work", 学习: "study", 读书: "study", 运动: "sport", 健身: "sport", 跑步: "sport", 生活: "life", 休息: "rest" };
  return map[tag] || "work";
}
function catLabelOf(x) {
  const c = x.cat || (x.__cat ?? catOf(x));
  return { work: "工作", study: "学习", sport: "运动", life: "生活", rest: "休息" }[c] || c;
}
