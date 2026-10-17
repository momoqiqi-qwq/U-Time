// 中国节假日 —— 由 cn-holiday Skill 的查询逻辑移植为U-Time内置插件。
// 数据源: NateScarlet/holiday-cn（基于国务院办公厅放假通知整理）
(function () {
  const REMOTE = "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master";
  const BUNDLED_YEARS = new Set([2024, 2025, 2026]);
  const DAY_MS = 86400000;
  const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];
  const cache = new Map();
  let root = null;
  let currentYear = Number(tide.util.today().slice(0, 4));
  let busy = false;
  // 「查某一天」自定义日历的状态：选中日期 + 日历正在展示的年月
  let checkDate = "", calYear = 0, calMonth = 0;

  const toUTC = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const fromUTC = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => fromUTC(toUTC(s) + n * DAY_MS);
  const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
  const yearOf = (s) => Number(s.slice(0, 4));
  const weekday = (s) => `周${WEEK_CN[new Date(toUTC(s)).getUTCDay()]}`;
  const isWeekend = (s) => [0, 6].includes(new Date(toUTC(s)).getUTCDay());
  const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(toUTC(s));
  const fmt = (s) => `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`;
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function validateDoc(j, year) {
    if (!j || !Array.isArray(j.days)) throw new Error("缺少 days 数组");
    if (!j.days.length) {
      const e = new Error(`${year} 年节假日安排尚未公布`);
      e.code = "UNPUBLISHED";
      throw e;
    }
    for (const d of j.days) {
      if (!validDate(d?.date) || typeof d?.isOffDay !== "boolean" || !d?.name) throw new Error(`${year} 年数据格式不正确`);
    }
    return { year, papers: j.papers || [], days: j.days };
  }

  async function loadYear(year, forceNetwork = false, allowNetwork = true) {
    if (!forceNetwork && cache.has(year)) return cache.get(year);
    if (!forceNetwork) {
      const stored = await tide.storage.get(`year:${year}`, null);
      if (stored) {
        try {
          const doc = validateDoc(stored, year);
          const out = { doc, source: "缓存" };
          cache.set(year, out);
          return out;
        } catch {}
      }
      if (BUNDLED_YEARS.has(year)) {
        try {
          const doc = validateDoc(await tide.assets.json(`data/${year}.json`), year);
          const out = { doc, source: "内置" };
          cache.set(year, out);
          return out;
        } catch (e) {
          console.warn("cn-holiday bundled data failed", year, e);
        }
      }
    }
    if (!allowNetwork) {
      const e = new Error(`${year} 年暂无本地数据`);
      e.code = "LOCAL_MISS";
      throw e;
    }
    const res = forceNetwork
      ? await tide.http.get(`${REMOTE}/${year}.json`)
      : await tide.http.getCached(`${REMOTE}/${year}.json`, 12 * 60 * 60 * 1000);
    if (res.status !== 200) throw new Error(`获取 ${year} 年数据失败（HTTP ${res.status}）`);
    const doc = validateDoc(JSON.parse(res.body), year);
    await tide.storage.set(`year:${year}`, doc);
    await tide.storage.set("updatedAt", new Date().toISOString());
    const out = { doc, source: "联网" };
    cache.set(year, out);
    return out;
  }

  function buildIndex(docs) {
    const offMap = new Map(), makeupMap = new Map(), entries = [];
    for (const doc of docs) {
      for (const d of doc.days) {
        if (d.isOffDay) { offMap.set(d.date, d.name); entries.push(d); }
        else makeupMap.set(d.date, d.name);
      }
    }
    entries.sort((a, b) => a.date.localeCompare(b.date));
    const blocks = [];
    for (const d of entries) {
      const last = blocks[blocks.length - 1];
      if (last && last.name === d.name && diffDays(last.end, d.date) === 1) {
        last.end = d.date; last.days.push(d.date);
      } else blocks.push({ name: d.name, start: d.date, end: d.date, days: [d.date] });
    }
    return { offMap, makeupMap, blocks };
  }

  function kindOf(date, idx) {
    if (idx.offMap.has(date)) return { kind: "holiday", rest: true, name: idx.offMap.get(date) };
    if (idx.makeupMap.has(date)) return { kind: "makeup", rest: false, name: idx.makeupMap.get(date) };
    if (isWeekend(date)) return { kind: "weekend", rest: true, name: null };
    return { kind: "workday", rest: false, name: null };
  }

  function nextWorkdayAfter(date, idx) {
    for (let i = 1; i <= 30; i++) {
      const d = addDays(date, i);
      if (!kindOf(d, idx).rest) return d;
    }
    return null;
  }

  function nextRest(from, idx) {
    for (let i = 0; i <= 400; i++) {
      const d = addDays(from, i), k = kindOf(d, idx);
      if (k.rest) return { date: d, offset: i, ...k };
    }
    return null;
  }

  function report(from, idx) {
    const todayStatus = kindOf(from, idx);
    const block = idx.blocks.find((b) => diffDays(from, b.end) >= 0) || null;
    if (!block) return { todayStatus, nextHoliday: null, nextRest: nextRest(from, idx) };
    const during = diffDays(block.start, from) >= 0 && diffDays(from, block.end) >= 0;
    return {
      todayStatus,
      nextRest: nextRest(from, idx),
      nextHoliday: {
        ...block,
        phase: during ? "during" : "before",
        totalDays: block.days.length,
        daysUntilStart: Math.max(0, diffDays(from, block.start)),
        daysUntilEnd: diffDays(from, block.end),
        alreadyOffDays: during ? diffDays(block.start, from) + 1 : 0,
        backToWork: nextWorkdayAfter(block.end, idx),
      },
    };
  }

  async function neighborhood(date) {
    const y = yearOf(date), years = [y - 1, y, y + 1], docs = [], errors = [];
    // 首屏只读取缓存/内置数据，避免为了“下一年尚未公布”白等一次公网请求。
    const local = await Promise.allSettled(years.map((yy) => loadYear(yy, false, false)));
    local.forEach((r, i) => {
      if (r.status === "fulfilled") docs.push(r.value.doc);
      else errors.push({ year: years[i], error: r.reason?.message || String(r.reason), unpublished: r.reason?.code === "UNPUBLISHED" });
    });
    if (!docs.some((d) => d.year === y)) {
      // 当前查询年份确实缺失时才联网，且只请求这一年。
      try { docs.push((await loadYear(y, false, true)).doc); }
      catch (e) { throw new Error(e.message || `${y} 年数据不可用`); }
    }
    return { index: buildIndex(docs), errors };
  }

  function ensureStyle() {
    if (document.getElementById("cn-holiday-style")) return;
    const st = document.createElement("style");
    st.id = "cn-holiday-style";
    st.textContent = `
      .ch-wrap{max-width:900px;margin:0 auto;padding-bottom:28px}
      .ch-hero{display:grid;grid-template-columns:1.35fr .65fr;gap:14px;margin:12px 0 14px}
      .ch-card{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:18px;padding:20px 22px}
      .ch-kicker{font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#8B979F);letter-spacing:.24em;text-transform:uppercase;margin-bottom:8px}
      .ch-name{font-size:calc(28px * var(--ui-text-scale));font-weight:800;letter-spacing:.02em;color:var(--ink,#22303A)}
      .ch-count{font-size:calc(52px * var(--ui-text-scale));line-height:1;font-weight:800;color:var(--deep,#0F4C5C);margin:10px 0 6px}
      .ch-count small{font-size:calc(13px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);font-weight:500;margin-left:5px}
      .ch-muted{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.7}
      .ch-status{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:5px 10px;background:color-mix(in srgb,var(--mint,#2ec4b6) 12%,var(--panel,#fff));color:var(--deep,#176C60);font-size:calc(11px * var(--ui-text-scale));font-weight:700}
      .ch-status.makeup{background:color-mix(in srgb,var(--sun,#e3a008) 12%,var(--panel,#fff));color:var(--ink,#9A4D16)}.ch-status.workday{background:var(--paper,#F1F3F5);color:var(--ink-2,#59656D)}.ch-status.weekend{background:color-mix(in srgb,var(--sea,#5364A5) 10%,var(--panel,#fff));color:var(--deep,#5364A5)}
      .ch-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.ch-btn{height:34px;border-radius:9px;border:1px solid var(--line,#DCD6CB);background:var(--panel,#fff);padding:0 13px;cursor:pointer;font-size:calc(12px * var(--ui-text-scale));color:var(--ink,#22303A)}.ch-btn.pri{background:#0F4C5C;border-color:var(--deep,#0F4C5C);color:#fff}.ch-btn:disabled{opacity:.5}
      .ch-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.ch-title{font-size:calc(14px * var(--ui-text-scale));font-weight:750;margin-bottom:12px}.ch-rest-big{font-size:calc(22px * var(--ui-text-scale));font-weight:750;color:var(--ink,#22303A);margin:6px 0}.ch-rest-big em{font-style:normal;color:var(--deep,#0F4C5C)}
      .ch-check{display:flex;gap:8px}.ch-in{height:36px;border:1px solid var(--line,#DDD7CD);border-radius:9px;padding:0 10px;background:#fff;color:var(--ink,#22303A)}.ch-check .ch-datebtn{flex:1;min-width:150px;height:38px;text-align:left;font-size:calc(13px * var(--ui-text-scale));cursor:pointer}
      .ch-cal{display:grid;grid-template-rows:0fr;opacity:0;transform:translateY(-6px);transition:grid-template-rows .3s cubic-bezier(.4,0,.2,1),opacity .22s ease,transform .3s cubic-bezier(.4,0,.2,1);pointer-events:none}
      .ch-cal.open{grid-template-rows:1fr;opacity:1;transform:none;pointer-events:auto}
      .ch-cal-in{min-height:0;overflow:hidden}
      .ch-cal-panel{padding:13px 14px;border:1px solid var(--line,#DDD7CD);border-radius:12px;background:var(--panel,#fff);margin-top:8px}
      .ch-cal-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}.ch-cal-head b{font-size:calc(13px * var(--ui-text-scale))}.ch-cal-nav{height:28px;padding:0 10px}
      .ch-cal-legend{margin-left:auto;font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);display:inline-flex;gap:6px;align-items:center}.lg-off{width:9px;height:9px;border-radius:3px;background:color-mix(in srgb,#D64545 18%,var(--panel,#fff));border:1px solid #D64545;display:inline-block}.lg-makeup{font-style:normal;width:14px;height:14px;border-radius:4px;background:var(--sun,#e3a008);color:#fff;font-size:calc(9px * var(--ui-text-scale));display:inline-flex;align-items:center;justify-content:center}
      .ch-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
      .ch-cal-wd{font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-3,#8B979F);text-align:center;padding:4px 0}
      .ch-cal-day{position:relative;border:0;background:transparent;border-radius:9px;min-height:37px;font-size:calc(12.5px * var(--ui-text-scale));cursor:pointer;color:var(--ink,#22303A);font-family:inherit}
      .ch-cal-day:hover{background:var(--paper,#F1F3F5)}
      .ch-cal-day.off{color:#C0392B;font-weight:700;background:color-mix(in srgb,#D64545 10%,var(--panel,#fff))}
      .ch-cal-day.makeup{color:var(--ink-2,#59656D)}
      .ch-cal-day.makeup i,.ch-cal-day.sel i{position:absolute;top:2px;right:3px;font-style:normal;font-size:calc(8.5px * var(--ui-text-scale));background:var(--sun,#e3a008);color:#fff;border-radius:4px;padding:0 3px;line-height:1.5}
      .ch-cal-day.tod{box-shadow:inset 0 0 0 1px var(--deep,#0F4C5C)}
      .ch-cal-day.sel{background:var(--deep,#0F4C5C);color:#fff}
      .ch-cal-foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px}
      .ch-result{margin-top:12px;border-radius:12px;background:var(--paper,#F8F7F3);padding:13px 14px;font-size:calc(13px * var(--ui-text-scale));line-height:1.7;color:var(--ink-2,#46545D);min-height:47px}
      .ch-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 0 8px}.ch-year-nav{display:flex;align-items:center;gap:7px}.ch-year{font-size:calc(18px * var(--ui-text-scale));font-weight:800;min-width:76px;text-align:center}
      .ch-list{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:18px;overflow:hidden}.ch-row{display:grid;grid-template-columns:92px 1fr auto;gap:12px;align-items:center;padding:13px 17px;border-bottom:1px solid var(--line-soft,#F0ECE5)}.ch-row:last-child{border-bottom:0}.ch-row b{font-size:calc(13px * var(--ui-text-scale))}.ch-range{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#687780)}.ch-days{font-size:calc(11px * var(--ui-text-scale));color:var(--deep,#0F4C5C);background:color-mix(in srgb,var(--mint,#2ec4b6) 10%,var(--panel,#fff));border-radius:999px;padding:4px 9px}
      .ch-row.past b,.ch-row.past .ch-range{color:var(--ink-3,#A9B2BA)}.ch-row.past .ch-days{background:var(--paper,#F1F3F5);color:var(--ink-3,#A9B2BA)}.ch-past-tag{font-style:normal;font-weight:500;font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#98A2AA);border:1px solid var(--line,#DCD6CB);border-radius:999px;padding:1px 7px;margin-left:7px;vertical-align:1px}
      .ch-makeup{margin-top:10px;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#8A6B52);line-height:1.8}.ch-source{font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#A1A9AF);margin-top:10px}.ch-err{color:#B34747}
      @media(max-width:720px){.ch-hero,.ch-grid{grid-template-columns:1fr}.ch-name{font-size:calc(23px * var(--ui-text-scale))}.ch-count{font-size:calc(44px * var(--ui-text-scale))}.ch-row{grid-template-columns:76px 1fr auto;padding:12px}.ch-card{padding:17px}}
    `;
    document.head.append(st);
  }

  function statusLabel(k) {
    return k.kind === "holiday" ? `法定假期 · ${k.name}` : k.kind === "makeup" ? `调休上班 · ${k.name}` : k.kind === "weekend" ? "普通周末" : "工作日";
  }

  /* ── 「查某一天」自定义日历（替代原生 date input）──
     原生弹层又小又没法定制；自绘日历更大，且能把法定假休日标红、「班」标调休。
     展开收起用 grid-template-rows 0fr→1fr + 透明度/位移过渡，动画平滑不跳变。 */
  const calLabel = (d) => (validDate(d) ? `${d.slice(0, 4)} / ${d.slice(5, 7)} / ${d.slice(8, 10)} ${weekday(d)}` : "选择日期");
  function paintDateBtn() {
    const btn = root?.querySelector("[data-datebtn]");
    if (btn) btn.textContent = calLabel(checkDate);
  }
  function toggleCal(open) {
    const cal = root?.querySelector("[data-cal]");
    if (cal) cal.classList.toggle("open", open);
  }
  // 某月的日子网格：周一起头，用 null 补齐首尾空位（周一对齐原生选择器习惯）
  function monthGrid(year, month) {
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const startOff = (new Date(toUTC(first)).getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < startOff; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    while (cells.length % 7) cells.push(null);
    return cells;
  }
  async function renderCalendar() {
    const cal = root?.querySelector("[data-cal]");
    if (!cal) return;
    const today = tide.util.today();
    const cells = monthGrid(calYear, calMonth);
    // 假日标记：本地/内置优先，缺年才联网（带 12h 缓存）；失败静默降级为无标记日历
    let idx = null;
    try { idx = buildIndex([(await loadYear(calYear, false, true)).doc]); } catch {}
    const mark = (d) => {
      if (!idx) return "";
      const k = kindOf(d, idx);
      return k.kind === "holiday" ? " off" : k.kind === "makeup" ? " makeup" : "";
    };
    cal.querySelector(".ch-cal-in").innerHTML = `
      <div class="ch-cal-panel">
        <div class="ch-cal-head">
          <button class="ch-btn ch-cal-nav" data-cal-prev type="button">‹</button>
          <b>${calYear}年${calMonth}月</b>
          <button class="ch-btn ch-cal-nav" data-cal-next type="button">›</button>
          <span class="ch-cal-legend"><i class="lg-off"></i>休 <i class="lg-makeup">班</i>班</span>
        </div>
        <div class="ch-cal-grid">
          ${["一", "二", "三", "四", "五", "六", "日"].map((w) => `<span class="ch-cal-wd">${w}</span>`).join("")}
          ${cells.map((d) => d
            ? `<button class="ch-cal-day${mark(d)}${d === checkDate ? " sel" : ""}${d === today ? " tod" : ""}" data-day="${d}" type="button">${Number(d.slice(8, 10))}${idx && kindOf(d, idx).kind === "makeup" ? "<i>班</i>" : ""}</button>`
            : "<span></span>").join("")}
        </div>
        <div class="ch-cal-foot"><button class="ch-btn" data-cal-clear type="button">清除</button>${idx ? "" : '<span class="ch-muted">该年节假日数据不可用，暂无假日标记</span>'}<button class="ch-btn" data-cal-today type="button">今天</button></div>
      </div>`;
    cal.querySelector("[data-cal-prev]").addEventListener("click", () => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } renderCalendar(); });
    cal.querySelector("[data-cal-next]").addEventListener("click", () => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } renderCalendar(); });
    cal.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => {
      checkDate = b.dataset.day;
      paintDateBtn();
      toggleCal(false);
      queryDay();
    }));
    cal.querySelector("[data-cal-clear]").addEventListener("click", () => { checkDate = ""; paintDateBtn(); });
    cal.querySelector("[data-cal-today]").addEventListener("click", () => {
      const t = tide.util.today();
      checkDate = t; calYear = yearOf(t); calMonth = Number(t.slice(5, 7));
      paintDateBtn(); renderCalendar();
    });
  }
  async function queryDay() {
    const out = root?.querySelector("[data-result]");
    if (!out) return;
    if (!validDate(checkDate)) { out.textContent = "请先选择有效日期。"; return; }
    out.textContent = "查询中…";
    try {
      const { index: idx } = await neighborhood(checkDate);
      const k = kindOf(checkDate, idx);
      const extra = k.kind === "holiday" ? `，${k.name}放假` : k.kind === "makeup" ? `，补「${k.name}」的假` : "";
      out.innerHTML = `<b>${esc(fmt(checkDate))} ${weekday(checkDate)}</b>：${esc(statusLabel(k))}${esc(extra)}`;
    } catch (e) { out.innerHTML = `<span class="ch-err">${esc(e.message || e)}</span>`; }
  }

  /* 刷新等待蒙版（v0.233.0）：节假日数据要联网取（首次 / 跨年 / 点「联网更新」），
     内存缓存命中的重绘是同步返回的，蒙版有 180ms 延迟，不会闪 —— 所以这里直接包住
     paint / paintYear 就行，不必再区分「这次会不会真发请求」。老宿主没有 tide.ui.waitMask
     时退化成空操作。 */
  const waitMask = (text) => (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});
  function paint() {
    if (!root) return Promise.resolve();
    const releaseWait = waitMask("正在读取节假日数据…");
    return paintInner().finally(releaseWait);
  }

  async function paintInner() {
    if (!root) return;
    const today = tide.util.today();
    root.innerHTML = `<div class="ch-wrap"><div class="ch-card"><div class="ch-muted">正在读取节假日数据…</div></div></div>`;
    try {
      const { index, errors } = await neighborhood(today);
      const rep = report(today, index), h = rep.nextHoliday, r = rep.nextRest;
      const unavailableNext = errors.find((e) => e.year === yearOf(today) + 1);
      let hero;
      if (h) {
        const title = h.phase === "during" ? `正在放 · ${esc(h.name)}` : `下一个假期 · ${esc(h.name)}`;
        const count = h.phase === "during" ? h.daysUntilEnd : h.daysUntilStart;
        const unit = h.phase === "during" ? "天后结束" : "天后放假";
        hero = `<div class="ch-kicker">${title}</div><div class="ch-name">${fmt(h.start)} — ${fmt(h.end)}</div><div class="ch-count">${count}<small>${unit}</small></div><div class="ch-muted">共 ${h.totalDays} 天${h.backToWork ? ` · ${fmt(h.backToWork)}（${weekday(h.backToWork)}）返岗` : ""}</div>`;
      } else {
        hero = `<div class="ch-kicker">法定节假日</div><div class="ch-name">暂无后续已公布安排</div><div class="ch-muted">${unavailableNext ? esc(unavailableNext.error) : "当前数据中没有更晚的法定假期。"}</div>`;
      }
      root.innerHTML = `<div class="ch-wrap">
        <div class="ch-hero">
          <section class="ch-card">${hero}<div class="ch-actions"><button class="ch-btn pri" data-refresh>联网更新</button><button class="ch-btn" data-jump-year>查看 ${yearOf(today)} 全年</button></div></section>
          <section class="ch-card"><div class="ch-kicker">今天 · ${esc(today)} ${weekday(today)}</div><div class="ch-status ${rep.todayStatus.kind}">${esc(statusLabel(rep.todayStatus))}</div><div class="ch-rest-big">${r?.offset === 0 ? "今天就是休息日" : `再过 <em>${r?.offset ?? "-"}</em> 天休息`}</div><div class="ch-muted">${r ? `${fmt(r.date)} ${weekday(r.date)} · ${r.kind === "holiday" ? esc(r.name) : "普通周末"}` : "未找到下个休息日"}</div></section>
        </div>
        <div class="ch-grid">
          <section class="ch-card"><div class="ch-title">查某一天</div><div class="ch-check"><button class="ch-in ch-datebtn" data-datebtn type="button">选择日期</button><button class="ch-btn pri" data-check>查询</button></div><div class="ch-cal" data-cal><div class="ch-cal-in"></div></div><div class="ch-result" data-result>点日期框展开日历：法定假休日标红、「班」为调休上班日；选中即可判断。</div></section>
          <section class="ch-card"><div class="ch-title">规则说明</div><div class="ch-muted">调休上班日会覆盖普通周末，不会误算成休息日。缺少年份时才联网读取；已获取的数据会缓存到U-Time本地数据中。</div><div class="ch-source">数据源：NateScarlet/holiday-cn · 原始依据为国务院办公厅放假通知</div></section>
        </div>
        <div class="ch-toolbar"><div><div class="ch-kicker">全年安排</div><div class="ch-year-nav"><button class="ch-btn" data-prev>‹</button><span class="ch-year" data-year>${currentYear}</span><button class="ch-btn" data-next>›</button></div></div><div class="ch-muted" data-year-source></div></div>
        <div class="ch-list" data-list><div class="ch-row"><span></span><span class="ch-muted">正在读取…</span><span></span></div></div>
        <div class="ch-makeup" data-makeup></div>
      </div>`;
      bind(index);
      await paintYear();
    } catch (e) {
      root.innerHTML = `<div class="ch-wrap"><div class="ch-card"><div class="ch-title ch-err">节假日数据读取失败</div><div class="ch-muted">${esc(e.message || e)}</div><div class="ch-actions"><button class="ch-btn pri" data-retry>重试</button></div></div></div>`;
      root.querySelector("[data-retry]")?.addEventListener("click", () => paint());
    }
  }

  function bind(index) {
    // 查某一天：初始选中今天，日历从当月起展示
    const today = tide.util.today();
    if (!validDate(checkDate)) { checkDate = today; calYear = yearOf(today); calMonth = Number(today.slice(5, 7)); }
    paintDateBtn();
    root.querySelector("[data-datebtn]")?.addEventListener("click", async () => {
      const cal = root.querySelector("[data-cal]");
      const willOpen = !cal.classList.contains("open");
      toggleCal(willOpen);
      if (willOpen) await renderCalendar();
    });
    if (!bind._docBound) {
      bind._docBound = true;
      document.addEventListener("click", (e) => { if (!e.target.closest(".ch-card")) toggleCal(false); });
    }
    root.querySelector("[data-check]")?.addEventListener("click", queryDay);
    root.querySelector("[data-refresh]")?.addEventListener("click", refreshNow);
    root.querySelector("[data-jump-year]")?.addEventListener("click", () => { currentYear = yearOf(tide.util.today()); paintYear(); root.querySelector("[data-list]")?.scrollIntoView({ behavior: "smooth", block: "start" }); });
    root.querySelector("[data-prev]")?.addEventListener("click", () => { currentYear--; paintYear(); });
    root.querySelector("[data-next]")?.addEventListener("click", () => { currentYear++; paintYear(); });
  }

  function paintYear() {
    if (!root) return Promise.resolve();
    const releaseWait = waitMask(`正在读取 ${currentYear} 年节假日…`);
    return paintYearInner().finally(releaseWait);
  }

  async function paintYearInner() {
    if (!root) return;
    const yEl = root.querySelector("[data-year]"), list = root.querySelector("[data-list]"), src = root.querySelector("[data-year-source]"), makeup = root.querySelector("[data-makeup]");
    if (!list) return;
    yEl.textContent = currentYear; list.innerHTML = `<div class="ch-row"><span></span><span class="ch-muted">正在读取 ${currentYear} 年…</span><span></span></div>`; makeup.textContent = ""; src.textContent = "";
    try {
      const r = await loadYear(currentYear), idx = buildIndex([r.doc]);
      src.textContent = `来源：${r.source}`;
      // 已经结束的假期（今天在 end 之后）整行置灰并打「已过」标签
      const today = tide.util.today();
      list.innerHTML = idx.blocks.map((b) => {
        const past = diffDays(b.end, today) > 0;
        return `<div class="ch-row${past ? " past" : ""}"><b>${esc(b.name)}${past ? '<i class="ch-past-tag">已过</i>' : ""}</b><span class="ch-range">${fmt(b.start)} ${weekday(b.start)} — ${fmt(b.end)} ${weekday(b.end)}</span><span class="ch-days">${b.days.length} 天</span></div>`;
      }).join("") || `<div class="ch-row"><span></span><span class="ch-muted">暂无放假记录</span><span></span></div>`;
      const ms = [...idx.makeupMap.entries()].sort().map(([d, n]) => ({ txt: `${fmt(d)} ${weekday(d)}（补${n}）`, past: diffDays(d, today) > 0 }));
      makeup.innerHTML = ms.length ? `调休上班：${ms.map((x) => x.past ? `<span style="color:var(--ink-3,#A9B2BA)">${esc(x.txt)}（已过）</span>` : esc(x.txt)).join(" · ")}` : "本年数据中没有调休上班日。";
    } catch (e) {
      list.innerHTML = `<div class="ch-row"><span></span><span class="ch-err">${esc(e.message || e)}</span><span></span></div>`;
      src.textContent = "可尝试联网更新";
    }
  }

  async function refreshNow() {
    if (busy) return;
    busy = true;
    const btn = root?.querySelector("[data-refresh]");
    if (btn) { btn.disabled = true; btn.textContent = "更新中…"; }
    const y = yearOf(tide.util.today()), years = [y, y + 1];
    // 这里强制走网络，是这一页唯一「一定要等」的路径。蒙版在 paint 之前就撤掉：
    // 撤完 paint 读的是刚写进内存缓存的数据，不会出现两层蒙版叠成「×2」。
    const releaseWait = waitMask("正在联网更新节假日数据…");
    try {
      const settled = await Promise.allSettled(years.map((yy) => loadYear(yy, true)));
      const result = settled.map((r, i) => r.status === "fulfilled" ? `${years[i]} 已更新` : `${years[i]}：${r.reason?.message || r.reason}`);
      tide.notify(result.join("；"));
    } finally { busy = false; releaseWait(); }
    await paint();
  }

  function render(el) {
    ensureStyle();
    root = el;
    currentYear = yearOf(tide.util.today());
    paint();
    return () => { if (root === el) root = null; };
  }

  tide.ui.registerView({ id: "cn-holiday", title: "中国节假日", icon: 'calendar-day', render });
})();
