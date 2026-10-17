// 警大门户通知 · 警大校历（v0.216.0 从独立插件 cppu-calendar 并入本插件）。
// 只负责校历自身的状态与渲染：学期边界、教学周、个人事项、本周课次统计。
// 学期数据仍由 main.js 的教务链路提供（cppu:term-request / cppu:term-response），
// 统一身份认证与 Cookie 不出 main.js —— 与获奖名单、一卡通同一套边界。
//
// 取数口径对齐 cppu-helper v15.0 的 XlFragment（同一个 POST /je/system/getNowXnxq 的
// data.values）：KSRQ = 学期开始日、JSRQ = 学期结束日、JXZQSRQ = 教学第 1 周起始日、
// JXZS = 教学周数。**结束日有官方值就用官方值**，只有官方没给才退回
// 「起始日 + 周数」推算并明写「推算」—— 推算出来的那天不是放假安排。

import { calIcon } from './cal-icons.js';

export function createCalendarView(tide) {
  const DAY = 86400000;
  const KEY = "calendar";
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const stamp = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); if (!m) return NaN; const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); return new Date(t).toISOString().slice(0, 10) === s ? t : NaN; };
  const dateOf = (t) => new Date(t).toISOString().slice(0, 10);
  const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const day = (v) => { const s = String(v || "").slice(0, 10); return Number.isFinite(stamp(s)) ? s : ""; };
  const initial = today();
  const state = { month: initial.slice(0, 7), selected: initial, term: null, events: [], status: "", retry: null, loading: false, root: null, requestId: "", stats: null, statsId: "", statsLoading: false };

  function cleanTerm(raw, source) {
    const start = day(raw?.jxStart);
    const weeks = Number(raw?.weeks);
    if (!Number.isFinite(stamp(start)) || !Number.isInteger(weeks) || weeks < 1 || weeks > 40) return null;
    // 官方学期起止（KSRQ / JSRQ）：拿得到就一起存下来，结束日优先用官方值。
    return { name: String(raw?.name || "当前学期").slice(0, 80), jxStart: start, weeks,
      termStart: day(raw?.termStart), termEnd: day(raw?.termEnd), source, updatedAt: new Date().toISOString() };
  }
  function weekOf(s) {
    if (!state.term) return 0;
    const n = Math.floor((stamp(s) - stamp(state.term.jxStart)) / (7 * DAY)) + 1;
    return n >= 1 && n <= state.term.weeks ? n : 0;
  }
  /** 学期结束日：官方 JSRQ 优先，缺了才按「教学第 1 周起始日 + 周数」推算。 */
  function termEndOf(term) {
    if (!term) return { value: "", official: false };
    if (term.termEnd) return { value: term.termEnd, official: true };
    return { value: dateOf(stamp(term.jxStart) + (term.weeks * 7 - 1) * DAY), official: false };
  }
  /** 合并后的「学期起止」卡片：起始日与结束日并排，日期是绿色大字（用户要求 v0.216.0）。 */
  function termCardHtml(term) {
    const end = termEndOf(term);
    const start = term ? term.termStart || term.jxStart : "";
    const note = !term ? "请先同步或设置学期"
      : end.official
        ? `官方校历学期起止日 · 教学 ${term.weeks} 周${term.termStart && term.termStart !== term.jxStart ? `（教学第 1 周起始 ${escapeHtml(term.jxStart)}）` : ""}`
        : `起始日 + ${term.weeks} 周推算，非官方放假日期（教学第 1 周起始 ${escapeHtml(term.jxStart)}）`;
    return `<div class="cc-term">${calIcon("term", 54)}<div class="cc-body"><small>当前学期 · 起止</small><strong>${escapeHtml(term?.name || "尚未设置")}</strong>`
      + `<div class="cc-dates">`
      + `<span class="cc-date"><em>起始</em><b>${term ? escapeHtml(start) : "—"}</b></span>`
      + `<span class="cc-arrow" aria-hidden="true">→</span>`
      + `<span class="cc-date"><em>结束</em><b>${term ? escapeHtml(end.value) : "—"}</b></span>`
      + `</div><small>${note}</small></div></div>`;
  }
  function monthMove(delta) {
    const [y, m] = state.month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    state.month = d.toISOString().slice(0, 7);
    paint();
  }
  function save() { return tide.storage.set(KEY, { term: state.term, events: state.events }); }
  function calendarCells() {
    const [year, month] = state.month.split("-").map(Number);
    const first = Date.UTC(year, month - 1, 1);
    const mondayOffset = (new Date(first).getUTCDay() + 6) % 7;
    const start = first - mondayOffset * DAY;
    const end = Date.UTC(year, month, 1);
    const weeks = Math.ceil((end - start) / (7 * DAY));
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const date = dateOf(start + i * DAY), n = weekOf(date), count = state.events.filter((e) => e.date === date).length;
      const cls = [date.slice(0, 7) !== state.month ? "outside" : "", date === today() ? "today" : "", date === state.selected ? "selected" : "", n && n === weekOf(today()) ? "current-week" : ""].filter(Boolean).join(" ");
      const weekStart = n && (stamp(date) - stamp(state.term.jxStart)) % (7 * DAY) === 0;
      return `<button type="button" class="cc-day ${cls}" data-date="${date}" aria-label="${date}${n ? `，教学第${n}周` : ""}${count ? `，${count}项事项` : ""}"><span>${Number(date.slice(8))}</span>${weekStart ? `<small>${n}周</small>` : ""}${count ? `<i aria-hidden="true"></i>` : ""}</button>`;
    }).join("");
  }
  function statsHtml() {
    const stats = state.stats, term = state.term;
    return `<div data-week-stats>${calIcon("course", 54)}<div class="cc-body"><small>本周课程 · ${stats?.start ? `<span class="cc-nw">${escapeHtml(stats.start)}</span> ～ <span class="cc-nw">${escapeHtml(stats.end)}</span>` : "周一至周日"}</small><strong>${state.statsLoading ? "正在读取…" : stats?.available ? `本周共 ${stats.periods} 节${stats.unknownPeriods ? "（已知）" : ""} · ${stats.occurrences} 次课` : "暂无可用课表"}</strong>${!state.statsLoading && stats?.available ? `<strong class="cc-remaining">${Number.isInteger(stats.remainingPeriods) ? `还剩 ${stats.remainingPeriods} 节${stats.remainingUnknownPeriods ? "（已知）" : ""} · ${stats.remainingOccurrences} 次课` : "剩余节数暂不可用，请更新课程表插件"}</strong><small>按每节结束时间扣除，含正在上的课${stats.remainingUnknownPeriods ? `；另有 ${stats.remainingUnknownPeriods} 次自定义时间课程未结束，节数未知` : ""}</small>` : ""}<small>${escapeHtml(stats?.error || (stats?.available ? `依据「${stats.name}」当前课表${stats.unknownPeriods ? `；另有 ${stats.unknownPeriods} 次自定义时间课程，节数未知` : ""}` : "请启用课程表插件并导入本学期课表"))}</small>${stats?.available && term && stats.semesterStart !== term.jxStart ? '<small>课表与校历起始日不同，请核对当前课表学期。</small>' : ''}<button type="button" data-action="stats" ${state.statsLoading ? "disabled" : ""}>刷新课次</button></div></div>`;
  }
  function paintStats() {
    const root = state.root; if (!root) return;
    const card = root.querySelector("[data-week-stats]");
    if (!card || typeof card.outerHTML !== "string") { paint(); return; }
    card.outerHTML = statsHtml();
    root.querySelector('[data-action="stats"]').onclick = requestStats;
  }
  function paint() {
    const root = state.root; if (!root) return;
    const term = state.term, week = weekOf(state.selected), nowWeek = weekOf(today());
    const dayEvents = state.events.filter((e) => e.date === state.selected).sort((a, b) => a.title.localeCompare(b.title));
    const future = state.events.filter((e) => e.date >= today()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
    root.innerHTML = `<div class="cc-wrap">
      <header class="cc-head"><div class="cc-head-main">${calIcon("cal", 46)}<div><div class="cc-eyebrow">CPPU · ACADEMIC CALENDAR</div><h2>警大校历</h2><p>教学周与自己的重要日期，一起看。</p></div></div><button type="button" data-action="sync" ${state.loading ? "disabled" : ""}>${state.loading ? "正在同步…" : "同步教务学期"}</button></header>
      <div class="cc-summary">${termCardHtml(term)}<div class="cc-now">${calIcon("week", 54)}<div class="cc-body"><small>当前教学周 · 按今天</small><strong>${term ? nowWeek ? `第 ${nowWeek} 周` : "当前不在教学周内" : "尚未设置学期"}</strong></div></div>${statsHtml()}</div>
      <div class="cc-layout"><section class="cc-panel"><div class="cc-toolbar"><h3>${escapeHtml(state.month.replace("-", " 年 "))} 月</h3><div><button type="button" data-action="prev" aria-label="上个月">‹</button><button type="button" data-action="today">今天</button><button type="button" data-action="next" aria-label="下个月">›</button></div></div><div class="cc-weekdays">${["一", "二", "三", "四", "五", "六", "日"].map((x) => `<span>${x}</span>`).join("")}</div><div class="cc-grid">${calendarCells()}</div><p class="cc-note">${term ? `红色标记今天所在教学周，与选中日期无关。教学周依据${term.source === "教务" ? "警大教务" : "手动设置"}的起始日和周数推算；放假、调课、考试请以学校通知为准。` : "可同步警大教务当前学期，或在右侧手动设置。"}</p></section>
      <aside class="cc-side"><section class="cc-panel"><h3>${escapeHtml(state.selected)} · ${week ? `第 ${week} 教学周` : "非教学周"}</h3><div class="cc-list">${dayEvents.length ? dayEvents.map((e) => `<div class="cc-event"><span>${escapeHtml(e.title)}</span><button type="button" data-remove="${escapeHtml(e.id)}" aria-label="删除${escapeHtml(e.title)}">删除</button></div>`).join("") : '<p class="cc-empty">这一天还没有个人事项</p>'}</div><form id="cc-add"><input name="title" maxlength="80" placeholder="添加考试、返校等事项" aria-label="事项名称" required><button type="submit">添加</button></form></section>
      <section class="cc-panel"><h3>接下来的事项</h3>${future.length ? future.map((e) => `<div class="cc-upcoming"><time>${escapeHtml(e.date.slice(5))}</time><span>${escapeHtml(e.title)}</span></div>`).join("") : '<p class="cc-empty">暂无即将到来的个人事项</p>'}</section>
      <details class="cc-panel cc-settings"><summary>手动设置学期</summary><form id="cc-term"><label>学期名称<input name="name" maxlength="80" value="${escapeHtml(term?.name || "")}" required></label><label>教学第 1 周起始日<input name="jxStart" type="date" value="${escapeHtml(term?.jxStart || "")}" required></label><label>教学周数<input name="weeks" type="number" min="1" max="40" value="${term?.weeks || 20}" required></label><button type="submit">保存学期</button></form></details></aside></div>
      ${statusHtml()}</div>`;
    root.querySelector('[data-action="prev"]').onclick = () => monthMove(-1);
    root.querySelector('[data-action="next"]').onclick = () => monthMove(1);
    root.querySelector('[data-action="today"]').onclick = () => { state.selected = today(); state.month = state.selected.slice(0, 7); paint(); requestStats(); };
    root.querySelector('[data-action="sync"]').onclick = syncTerm;
    const retryBtn = root.querySelector('[data-action="retry"]');
    if (retryBtn) retryBtn.onclick = retryFail;
    root.querySelector('[data-action="stats"]').onclick = requestStats;
    root.querySelectorAll("[data-date]").forEach((b) => { b.onclick = () => { state.selected = b.dataset.date; state.month = state.selected.slice(0, 7); paint(); }; });
    root.querySelectorAll("[data-remove]").forEach((b) => { b.onclick = async () => { state.events = state.events.filter((e) => e.id !== b.dataset.remove); await save(); paint(); }; });
    root.querySelector("#cc-add").onsubmit = async (e) => { e.preventDefault(); const title = String(new FormData(e.currentTarget).get("title") || "").trim(); if (!title) return; state.events.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, date: state.selected, title: title.slice(0, 80) }); await save(); paint(); };
    root.querySelector("#cc-term").onsubmit = async (e) => { e.preventDefault(); const data = new FormData(e.currentTarget); const term = cleanTerm({ name: data.get("name"), jxStart: data.get("jxStart"), weeks: data.get("weeks") }, "手动"); if (!term) { state.status = "请检查教学起始日和周数"; paint(); return; } state.term = term; state.status = "学期设置已保存"; state.retry = null; await save(); paint(); };
  }
  function requestStats() {
    if (!state.root) return;
    const id = `calendar-${Date.now()}-${Math.random()}`;
    state.statsId = id; state.statsLoading = true; state.stats = null; paintStats();
    tide.events.emit("schedule:week-request", { id, date: today() });
    setTimeout(() => { if (state.statsId === id && state.statsLoading) { state.statsLoading = false; state.statsId = ""; state.stats = { error: "课程表未响应，请确认插件已启用后重试" }; paintStats(); } }, 5000);
  }
  tide.events.on("schedule:week-response", message => {
    if (!message || !state.statsId || message.id !== state.statsId) return;
    state.statsId = ""; state.statsLoading = false;
    const count = n => Number.isInteger(n) && n >= 0 && n <= 40000;
    const hasRemaining = [message.remainingOccurrences, message.remainingPeriods, message.remainingUnknownPeriods].some(n => n !== undefined);
    const valid = [message.occurrences, message.periods, message.unknownPeriods].every(count) && (!hasRemaining || ([message.remainingOccurrences, message.remainingPeriods, message.remainingUnknownPeriods].every(count) && message.remainingOccurrences <= message.occurrences && message.remainingPeriods <= message.periods && message.remainingUnknownPeriods <= message.unknownPeriods));
    state.stats = message.available && !valid ? { error: "课表统计格式无效，请刷新重试" } : message; paintStats();
  });
  tide.events.on("schedule:changed", () => requestStats());
  // 刷新等待蒙版（v0.233.0）：同步教务学期要等门户往返，最长 30s，期间界面上只有一行状态字。
  // 老宿主没有 tide.ui.waitMask 时退化成空操作。
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});
  function syncTerm() {
    state.loading = true; state.status = "正在通过警大门户同步教务学期…"; state.retry = null; state.requestId = `${Date.now()}-${Math.random()}`; paint();
    const id = state.requestId;
    // 结束点有两个：收到 cppu:term-response（正常）与下面那个 30s 超时（门户不回话）。
    // 两条路都要撤，否则超时后蒙版会一直盖着 —— 用同一个 release 幂等收口。
    state.releaseTermWait = waitMask("正在同步教务学期…");
    tide.events.emit("cppu:term-request", { id });
    setTimeout(() => {
      if (state.loading && state.requestId === id) {
        state.loading = false; state.status = "同步超时；可检查警大门户登录，或手动设置学期"; state.retry = "term"; paint();
      }
      state.releaseTermWait?.(); state.releaseTermWait = null;
    }, 30000);
  }
  tide.events.on("cppu:term-response", async (message) => {
    if (!message || message.id !== state.requestId) return;
    state.releaseTermWait?.(); state.releaseTermWait = null;
    state.loading = false; state.requestId = "";
    const term = cleanTerm(message.term, "教务");
    if (term) { state.term = term; state.status = "已同步警大教务当前学期"; state.retry = null; await save(); }
    else { state.status = message.error || "教务暂未返回有效学期；可手动设置"; state.retry = "term"; }
    paint();
  });
  /* 失败状态行整条就是刷新入口（v0.190.0，用户要求「如果有登录失败 / 拉取失败横幅，也添加整条变成刷新入口」）。
     state.retry 记着「这一步失败该重跑哪一段」：load = 重新读取校历并刷新课次，term = 重新同步教务学期。
     用真 <button> 而不是 div+click：Tab 能聚焦、Enter / Space 能触发、读屏会念成按钮名。
     成功 / 进行中的提示仍是普通 <p class="cc-status">，只有失败那条才变成按钮。 */
  function statusHtml() {
    if (!state.retry) return `<p class="cc-status" role="status">${escapeHtml(state.status)}</p>`;
    return `<button type="button" class="cc-banner" data-action="retry"><span class="cc-banner-txt">${escapeHtml(state.status)}</span><span class="cc-banner-hint">点击重试</span></button>`;
  }
  function retryFail() {
    const kind = state.retry;
    state.retry = null;
    if (kind === "term") { syncTerm(); return; }
    reload();
  }
  function reload() {
    const root = state.root; if (!root) return;
    state.status = "正在读取校历…"; state.retry = null; paint();
    tide.storage.get(KEY, null).then((stored) => {
      if (state.root !== root) return;
      state.term = cleanTerm(stored?.term, stored?.term?.source === "教务" ? "教务" : "手动");
      state.events = Array.isArray(stored?.events) ? stored.events.filter((e) => Number.isFinite(stamp(e?.date)) && typeof e.title === "string" && typeof e.id === "string").slice(0, 500) : [];
      state.status = ""; paint(); requestStats();
    }).catch((error) => { state.status = `读取校历失败：${String(error?.message || error)}`; state.retry = "load"; paint(); });
  }
  function style() {
    if (document.getElementById("cppu-calendar-style")) return;
    const s = document.createElement("style"); s.id = "cppu-calendar-style";
    s.textContent = `.cc-wrap{max-width:1180px;margin:auto;color:var(--ink,#22303a);padding:16px 8px 28px}.cc-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.cc-head h2{font-size:28px;margin:3px 0}.cc-head p,.cc-note,.cc-empty,.cc-status{color:var(--muted,#687780);font-size:13px;line-height:1.6}.cc-eyebrow{color:var(--accent,#2f7c83);font-size:11px;font-weight:700;letter-spacing:.13em}.cc-wrap button{cursor:pointer;border:1px solid var(--border,#e4dfd6);background:var(--card,#fff);color:inherit;border-radius:9px;padding:8px 11px}.cc-head>button,.cc-wrap form button{background:var(--accent,#2f7c83);color:var(--on-accent,#fff);border-color:transparent}.cc-wrap button:disabled{opacity:.55;cursor:wait}.cc-summary{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,.85fr) minmax(0,1.2fr);gap:10px;margin-bottom:14px}.cc-summary>div,.cc-panel{background:var(--card,#fff);border:1px solid var(--border,#e4dfd6);border-radius:15px;padding:16px}.cc-summary small{display:block;color:var(--muted,#687780);margin-bottom:7px}.cc-summary strong{display:block;overflow-wrap:anywhere}.cc-summary .cc-remaining{color:var(--accent,#2f7c83);margin:7px 0}/* ── 学期起止（v0.216.0 把原来的「当前学期」与「学期教学结束日」两张卡并成一张）：起始日与结束日并排，日期绿色大字。绿用 light-dark() 成对给值 —— 浅色 #0f7a43 落在白卡上 5.3:1，深色 #4ade80 落在 --card 上 8.6:1，都过 AA；不引新令牌是因为 --mint 在白卡上只有 1.9:1，当文字色看不清。 */.cc-dates{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin:9px 0 8px}.cc-date{display:grid;gap:3px}.cc-date em{font-style:normal;font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--muted,#687780)}.cc-date b{font-size:24px;line-height:1.08;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:#0f7a43;color:light-dark(#0f7a43,#4ade80)}.cc-arrow{color:var(--muted,#687780);font-size:15px;padding-bottom:4px}.cc-layout{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,1fr);gap:14px}.cc-side{display:grid;gap:14px;align-content:start}.cc-panel h3{font-size:16px;margin:0 0 15px}.cc-toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px}.cc-toolbar h3{margin:0}.cc-toolbar>div{display:flex;gap:5px}.cc-weekdays,.cc-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}.cc-weekdays{margin:16px 0 8px;text-align:center;color:var(--muted,#687780);font-size:12px}.cc-day{min-height:70px!important;text-align:left!important;display:flex;flex-direction:column;gap:3px;position:relative}.cc-day.outside{opacity:.4}.cc-day.today{border-color:var(--accent,#2f7c83)}.cc-day.selected{background:var(--accent,#2f7c83);color:var(--on-accent,#fff)}.cc-summary .cc-now strong{color:#b42c3c;color:light-dark(#b42c3c,#ff8995)}.cc-day.current-week{box-shadow:inset 0 -3px #d43a4d;border-color:#d43a4d}.cc-day.current-week:not(.selected){color:#b42c3c;color:light-dark(#b42c3c,#ff8995);background:color-mix(in srgb,#d43a4d 9%,var(--card,#fff))}.cc-day.current-week.outside{opacity:1}.cc-day small{font-size:10px}.cc-day i{width:5px;height:5px;border-radius:50%;background:currentColor;position:absolute;right:8px;bottom:8px}.cc-event,.cc-upcoming{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--border,#e4dfd6);overflow-wrap:anywhere}.cc-event button{font-size:11px;padding:5px 7px}.cc-upcoming time{font-variant-numeric:tabular-nums;color:var(--accent,#2f7c83);white-space:nowrap}.cc-wrap form{display:flex;gap:7px;margin-top:12px}.cc-wrap input{min-width:0;flex:1;border:1px solid var(--border,#e4dfd6);border-radius:8px;background:var(--card,#fff);color:inherit;padding:9px}.cc-settings summary{cursor:pointer;font-weight:600}.cc-settings form{display:grid}.cc-settings label{display:grid;gap:5px;font-size:12px}.cc-note{margin:15px 0 0}.cc-status{min-height:22px}.cc-banner,.cc-banner-txt,.cc-banner-hint{box-sizing:border-box}/* ── 失败状态行整条 = 重试入口（v0.190.0）：配色由 --accent 混进视图底色 --bg 派生，换主题、切深浅、开 Nephele 都自动跟随（Nephele 下 --accent = #81559b / 深色 #d3afe9，这条就成同色系薰衣草紫）。三档底是 --accent 与 --bg 的 color-mix：静止 14% / 悬停 22% / 按下 32%；文字 --ink，右侧提示 --accent 30% + --ink 70%（34 张色板实测最低 5.03:1）。混 --bg 而不是 --card：横幅挂在视图顶部、不在卡片里，Nephele 的 --bg 恰好落在 --accent 与 --card 的 12% 处，混 --card 会让底色与背景只差 1 个通道（等于看不见）。选择器带 .cc-wrap 前缀压过上面那条通用 .cc-wrap button 的 (0,1,1)。 */.cc-wrap .cc-banner{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;text-align:left;font:inherit;font-size:13px;line-height:1.65;margin:14px 0 0;padding:10px 14px;color:var(--ink,#22303a);background:color-mix(in srgb,var(--accent,#2f7c83) 14%,var(--bg,#F2EFEA));border:1px solid color-mix(in srgb,var(--accent,#2f7c83) 38%,var(--bg,#F2EFEA));border-radius:12px;appearance:none;-webkit-appearance:none;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,border-color .18s ease}.cc-wrap .cc-banner:hover{background:color-mix(in srgb,var(--accent,#2f7c83) 22%,var(--bg,#F2EFEA));border-color:color-mix(in srgb,var(--accent,#2f7c83) 52%,var(--bg,#F2EFEA))}.cc-wrap .cc-banner:active{background:color-mix(in srgb,var(--accent,#2f7c83) 32%,var(--bg,#F2EFEA))}.cc-wrap .cc-banner:focus-visible{outline:3px solid var(--accent,#2f7c83);outline-offset:2px}.cc-banner-txt{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}.cc-banner-hint{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:color-mix(in srgb,var(--accent,#2f7c83) 30%,var(--ink,#22303a));white-space:nowrap}.cc-banner-hint::before{content:"↻";font-size:14px;line-height:1;transition:transform .18s ease}.cc-wrap .cc-banner:hover .cc-banner-hint::before{transform:rotate(-90deg)}/* ── 图标（v1.60.0）：六边形立体底板，SVG 由 cal-icons.js 生成。三张汇总卡与 header 各一枚，图标与文字用 flex 并排；.cc-body 收住 min-width:0，长日期串才会换行而不是把卡片撑破。 */.cc-head-main{display:flex;align-items:center;gap:13px;min-width:0}.cc-head-main>div{min-width:0}.cc-ico-svg{display:block;flex:none}.cc-summary>div{display:flex;align-items:flex-start;gap:14px}.cc-summary>div>.cc-ico-svg{margin-top:2px}.cc-body{min-width:0;flex:1 1 auto}.cc-nw{white-space:nowrap}.cc-summary .cc-date b{white-space:nowrap}@media(prefers-reduced-motion:reduce){.cc-banner,.cc-banner-hint::before{transition-duration:.01ms!important}}@media(max-width:700px){.cc-head{flex-direction:column;align-items:stretch;gap:11px}.cc-head>button{align-self:flex-start}.cc-head-main .cc-ico-svg,.cc-summary .cc-ico-svg{width:40px;height:40px}.cc-head h2{font-size:23px}.cc-head>button{white-space:nowrap}.cc-summary{grid-template-columns:1fr}.cc-date b{font-size:19px}.cc-arrow{display:none}.cc-dates{row-gap:6px}.cc-layout{grid-template-columns:1fr}.cc-day{min-height:53px!important;padding:5px!important}.cc-day small{font-size:9px}.cc-wrap .cc-banner{padding:9px 11px;font-size:12.5px}}`;
    document.head.append(s);
  }
  function render(root) {
    state.root = root; style();
    const statsTimer = setInterval(() => { if (state.root === root && !state.statsLoading) requestStats(); }, 60000);
    reload();
    return () => { clearInterval(statsTimer); state.releaseTermWait?.(); state.releaseTermWait = null; if (state.root === root) { state.root = null; state.requestId = ""; state.loading = false; state.statsId = ""; state.statsLoading = false; } };
  }
  return { state, cleanTerm, weekOf, termEndOf, termCardHtml, calendarCells, paint, requestStats, statusHtml, retryFail, reload, syncTerm, render };
}
