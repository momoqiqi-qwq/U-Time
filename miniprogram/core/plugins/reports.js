const { store, holidayData, examData, WEEK_CN, CAT_LABEL, pad2, dateMs, dayDiff, weekday, durationLabel } = require("./common.js");
function weeklyReport(today) {
  today = today || store.todayStr();
  const days = [];
  for (let i = -6; i <= 0; i++) days.push(store.addDays(today, i));
  const perDay = days.map((date) => {
    const blocks = store.blocksOf(date);
    const minutes = blocks.reduce((sum, b) => sum + (Number(b.durMin) || 0), 0);
    return { date, weekday: weekday(date), minutes, label: durationLabel(minutes) };
  });
  const max = Math.max(60, ...perDay.map((x) => x.minutes));
  perDay.forEach((x) => { x.pct = Math.max(3, Math.round((x.minutes / max) * 100)); });
  const byCat = {};
  for (const date of days) {
    for (const b of store.blocksOf(date)) byCat[b.cat] = (byCat[b.cat] || 0) + (Number(b.durMin) || 0);
  }
  const cats = store.CATEGORIES.map((c) => ({
    id: c.id,
    label: CAT_LABEL[c.id] || c.label || c.id,
    minutes: byCat[c.id] || 0,
    value: durationLabel(byCat[c.id] || 0),
  }));
  const tasks = store.getState().tasks || [];
  const done = tasks.filter((t) => t.done).length;
  const total = perDay.reduce((sum, x) => sum + x.minutes, 0);
  return { days: perDay, cats, total, totalLabel: durationLabel(total), averageLabel: durationLabel(Math.round(total / 7)), done, taskCount: tasks.length };
}

function holidaySummary(today) {
  today = today || store.todayStr();
  const year = today.slice(0, 4);
  const doc = holidayData[year] || null;
  if (!doc) return { available: false, year, today, todayText: "当前年份没有内置节假日数据", upcoming: [] };
  const map = Object.create(null);
  for (const d of doc.days || []) map[d.date] = d;
  const special = map[today];
  const dow = new Date(dateMs(today)).getDay();
  let todayText;
  if (special) todayText = special.isOffDay ? `${special.name} · 放假` : `${special.name} · 调休上班`;
  else todayText = dow === 0 || dow === 6 ? "周末 · 休息日" : "普通工作日";

  const groups = [];
  const days = (doc.days || []).filter((d) => d.isOffDay && d.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) {
    const last = groups[groups.length - 1];
    if (last && last.name === d.name && dayDiff(last.endDate, d.date) === 1) {
      last.endDate = d.date;
      last.days += 1;
    } else {
      groups.push({ name: d.name, startDate: d.date, endDate: d.date, days: 1 });
    }
  }
  const upcoming = groups.slice(0, 8).map((g) => {
    const diff = dayDiff(today, g.startDate);
    return Object.assign({}, g, {
      countdown: diff === 0 ? "今天" : diff === 1 ? "明天" : `${diff} 天后`,
      range: g.startDate === g.endDate ? g.startDate : `${g.startDate} → ${g.endDate}`,
    });
  });
  return { available: true, year, today, todayText, upcoming, papers: doc.papers || [] };
}


module.exports = { weeklyReport, holidaySummary };
