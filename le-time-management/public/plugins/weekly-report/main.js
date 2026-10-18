// 周度报告插件 —— 演示只读使用 tasks / blocks API
// v0.2.0：每天一根按分类堆叠的柱子（悬停看明细）、与上一个 7 天的对比、带百分比的分类图例、空状态；
// 配色只用主题变量，深色模式自动跟随。原来的「周 度 报 告 · 内 置 插 件」字距小标题去掉 —— 侧栏与标题已经说明了这是哪个页面。
(function () {
  const CATS = [
    { id: "work", label: "深度工作", color: "#0F4C5C" },
    { id: "study", label: "学习", color: "#9B5DE5" },
    { id: "sport", label: "运动", color: "#FF6B6B" },
    { id: "life", label: "生活", color: "#E3A008" },
    { id: "rest", label: "休息", color: "#2EC4B6" },
  ];
  const OTHER = { id: "_other", label: "其他", color: "var(--ink-3,#A9B2BA)" };
  const KNOWN = new Set(CATS.map((c) => c.id));
  const catOf = (b) => (KNOWN.has(b.cat) ? b.cat : OTHER.id);

  function weekday(ds) {
    const [y, m, d] = ds.split("-").map(Number);
    return "日一二三四五六"[new Date(y, m - 1, d).getDay()];
  }
  function dur(m) {
    m = Math.round(m || 0);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + "m" : ""}`;
  }
  const minutes = (b) => Math.max(0, Number(b?.durMin) || 0);

  const CSS = `
.wr-root{max-width:var(--plugin-content-max,1040px);margin:0 auto;padding:14px 0 30px;color:var(--ink,#22303A)}
.wr-card{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:18px;padding:24px 28px;box-shadow:var(--shadow,0 2px 10px rgba(34,48,58,.07))}
.wr-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wr-title{font-size:calc(16px * var(--ui-text-scale));font-weight:700}
.wr-range{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.wr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0 6px}
.wr-stat{background:var(--paper,#F7F6F2);border-radius:12px;padding:10px 12px}
.wr-stat small{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.wr-stat b{display:block;font-size:calc(18px * var(--ui-text-scale));margin-top:2px;font-variant-numeric:tabular-nums}
.wr-delta{font-size:calc(11px * var(--ui-text-scale));font-weight:600;margin-left:6px}
.wr-delta.up{color:var(--mint-deep,#1F9E92)}.wr-delta.down{color:var(--danger,#B03535)}.wr-delta.flat{color:var(--ink-3,#A9B2BA)}
.wr-chart{display:flex;align-items:flex-end;gap:12px;height:168px;margin:18px 0 4px}
.wr-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end;min-width:0}
.wr-bar{width:100%;max-width:44px;border-radius:7px 7px 3px 3px;overflow:hidden;display:flex;flex-direction:column-reverse;background:var(--line-soft,#EFEAE1);min-height:3px}
.wr-bar i{display:block;flex:none}
.wr-col.today .wr-bar{outline:2px solid var(--deep,#0F4C5C);outline-offset:2px}
.wr-lab{font-size:calc(10.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);white-space:nowrap}
.wr-col.today .wr-lab{color:var(--deep,#0F4C5C);font-weight:700}
.wr-val{font-size:calc(10px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);font-variant-numeric:tabular-nums}
.wr-legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin:14px 0 4px}
.wr-legend span{font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);display:flex;align-items:center;gap:6px}
.wr-legend i{width:9px;height:9px;border-radius:3px;display:inline-block}
.wr-legend b{color:var(--ink,#22303A);font-variant-numeric:tabular-nums}
.wr-empty{text-align:center;padding:34px 10px 26px;color:var(--ink-2,#7E8B94);font-size:calc(13px * var(--ui-text-scale));line-height:1.8}
.wr-empty svg{display:block;width:min(100%,176px);height:auto;margin:0 auto 10px;color:color-mix(in srgb,var(--ink,#22303A) 34%,transparent);--ea-accent:#9B5DE5;--ea-on-accent:var(--panel,#fff)}
.wr-foot{margin-top:16px;padding-top:14px;border-top:1px dashed var(--line-soft,#EFEAE1);font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}
.wr-foot b{color:var(--ink,#22303A)}
@media (max-width:560px){.wr-card{padding:18px 16px}.wr-chart{gap:6px}.wr-val{display:none}}
`;
  function ensureStyle() {
    if (document.getElementById("wr-style")) return;
    const st = document.createElement("style");
    st.id = "wr-style";
    st.textContent = CSS;
    document.head.append(st);
  }

  function deltaHtml(now, prev) {
    if (!prev) return now ? '<span class="wr-delta flat">上周无记录</span>' : "";
    const pct = Math.round(((now - prev) / prev) * 100);
    if (!pct) return '<span class="wr-delta flat">与上周持平</span>';
    return `<span class="wr-delta ${pct > 0 ? "up" : "down"}">${pct > 0 ? "↑" : "↓"} ${Math.abs(pct)}%</span>`;
  }

  function render(el2) {
    ensureStyle();
    el2.innerHTML = "";
    const root = document.createElement("div");
    root.className = "wr-root";
    const card = document.createElement("div");
    card.className = "wr-card";
    card.innerHTML = '<div class="wr-head"><div class="wr-title">过去 7 天</div></div>';
    root.append(card);
    el2.append(root);

    const today = tide.util.today();
    const days = [];
    for (let i = -6; i <= 0; i++) days.push(tide.util.addDays(today, i));
    const prevDays = [];
    for (let i = -13; i <= -7; i++) prevDays.push(tide.util.addDays(today, i));

    Promise.all([...days, ...prevDays].map((d) => tide.blocks.list(d))).then((all) => {
      if (!root.isConnected) return;
      const weeks = all.slice(0, 7);
      const prevTotal = all.slice(7).flat().reduce((a, b) => a + minutes(b), 0);
      const perDay = weeks.map((bs) => {
        const cats = {};
        for (const b of bs) cats[catOf(b)] = (cats[catOf(b)] || 0) + minutes(b);
        return { total: bs.reduce((a, b) => a + minutes(b), 0), cats };
      });
      const total = perDay.reduce((a, d) => a + d.total, 0);
      const byCat = {};
      perDay.forEach((d) => { for (const [k, v] of Object.entries(d.cats)) byCat[k] = (byCat[k] || 0) + v; });
      const cats = [...CATS, ...(byCat[OTHER.id] ? [OTHER] : [])];
      const tasks = tide.tasks.list();
      const done = tasks.filter((t) => t.done).length;
      const activeDays = perDay.filter((d) => d.total > 0).length;

      card.querySelector(".wr-head").insertAdjacentHTML("beforeend",
        `<div class="wr-range">${days[0].slice(5)} – ${days[6].slice(5)}</div>`);

      const stats = document.createElement("div");
      stats.className = "wr-stats";
      stats.innerHTML = `<div class="wr-stat"><small>排程合计</small><b>${dur(total)}${deltaHtml(total, prevTotal)}</b></div>`
        + `<div class="wr-stat"><small>日均</small><b>${dur(total / 7)}</b></div>`
        + `<div class="wr-stat"><small>有安排的天数</small><b>${activeDays} / 7</b></div>`
        + `<div class="wr-stat"><small>任务完成</small><b>${done} / ${tasks.length}</b></div>`;
      card.append(stats);

      if (!total) {
        // 空状态线稿（v0.249.0，与宿主空状态同一画风；插件不能 import 宿主源码，所以内联一份）
        const WR_EMPTY_ART = '<svg viewBox="0 0 160 100" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M46 20.6V79.4H119"/><path d="M42.6 79.4H46"/><rect x="70.4" y="52" width="9.4" height="27.4" rx="2.4" stroke-dasharray="3 3.4"/><rect x="86" y="40" width="9.4" height="39.4" rx="2.4" stroke-dasharray="3 3.4"/><rect x="101.6" y="30.6" width="9.4" height="48.8" rx="2.4" stroke-dasharray="3 3.4"/><path d="M122 17.5Q122.81 21.19 126.5 22Q122.81 22.81 122 26.5Q121.19 22.81 117.5 22Q121.19 21.19 122 17.5Z"/><path d="M36 32.6Q36.61 35.39 39.4 36Q36.61 36.61 36 39.4Q35.39 36.61 32.6 36Q35.39 35.39 36 32.6Z"/><circle cx="128" cy="50" r="1.1" fill="currentColor" stroke="none"/><circle cx="60" cy="24" r="1.1" fill="currentColor" stroke="none"/></g><rect x="54.8" y="66.6" width="9.4" height="12.8" rx="2.4" style="fill:var(--ea-accent,#E8705F)"/><rect x="54.8" y="66.6" width="9.4" height="12.8" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const empty = document.createElement("div");
        empty.className = "wr-empty";
        empty.innerHTML = WR_EMPTY_ART + "这 7 天还没有时间块。<br>在「时间块」里排几段日程，这里就会按天、按分类汇总出来。";
        card.append(empty);
        return;
      }

      const maxDay = Math.max(60, ...perDay.map((d) => d.total));
      const chart = document.createElement("div");
      chart.className = "wr-chart";
      chart.setAttribute("role", "img");
      chart.setAttribute("aria-label", days.map((d, i) => `周${weekday(d)} ${dur(perDay[i].total)}`).join("，"));
      days.forEach((d, i) => {
        const day = perDay[i];
        const col = document.createElement("div");
        col.className = `wr-col${i === 6 ? " today" : ""}`;
        col.title = `${d}（周${weekday(d)}）共 ${dur(day.total)}`
          + cats.filter((c) => day.cats[c.id]).map((c) => `\n${c.label} ${dur(day.cats[c.id])}`).join("");
        const val = document.createElement("span");
        val.className = "wr-val";
        val.textContent = day.total ? dur(day.total) : "";
        const bar = document.createElement("div");
        bar.className = "wr-bar";
        bar.style.height = `${Math.max(2, (day.total / maxDay) * 100)}%`;
        for (const c of cats) {
          const v = day.cats[c.id];
          if (!v) continue;
          const seg = document.createElement("i");
          seg.style.cssText = `height:${(v / day.total) * 100}%;background:${c.color}`;
          bar.append(seg);
        }
        const lab = document.createElement("span");
        lab.className = "wr-lab";
        lab.textContent = i === 6 ? "今天" : `周${weekday(d)}`;
        col.append(val, bar, lab);
        chart.append(col);
      });

      const legend = document.createElement("div");
      legend.className = "wr-legend";
      cats.forEach((c) => {
        const v = byCat[c.id] || 0;
        const item = document.createElement("span");
        item.innerHTML = `<i style="background:${c.color}"></i>${c.label} <b>${dur(v)}</b> ${v ? `${Math.round((v / total) * 100)}%` : ""}`;
        legend.append(item);
      });

      const top = cats.filter((c) => c.id !== OTHER.id).sort((a, b) => (byCat[b.id] || 0) - (byCat[a.id] || 0))[0];
      const foot = document.createElement("div");
      foot.className = "wr-foot";
      foot.innerHTML = top && byCat[top.id]
        ? `投入最多的是 <b>${top.label}</b>（${dur(byCat[top.id])}），上一个 7 天合计 ${dur(prevTotal)}。`
        : `上一个 7 天合计 ${dur(prevTotal)}。`;
      card.append(chart, legend, foot);
    });
  }

  tide.ui.registerView({ id: "weekly-report", title: "周度报告", icon: 'chart-column', render });
})();
