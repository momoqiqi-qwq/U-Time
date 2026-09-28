// 微信小程序原生插件适配层：只放纯数据逻辑，页面负责交互。
const store = require("./store.js");
const holidayData = require("./pluginData/holiday.js");
const examData = require("./pluginData/exams.js");

const WEEK_CN = "日一二三四五六";
const CAT_LABEL = { work: "工作", study: "学习", sport: "运动", life: "生活", rest: "休息" };

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function dateMs(ds) {
  const p = String(ds || "").split("-").map(Number);
  return new Date(p[0], p[1] - 1, p[2]).getTime();
}
function dayDiff(a, b) { return Math.round((dateMs(b) - dateMs(a)) / 86400000); }
function weekday(ds) {
  const p = String(ds || "").split("-").map(Number);
  return "周" + WEEK_CN[new Date(p[0], p[1] - 1, p[2]).getDay()];
}
function durationLabel(min) {
  min = Math.max(0, Number(min) || 0);
  if (min < 60) return min + "m";
  const h = Math.floor(min / 60), r = min % 60;
  return h + "h" + (r ? r + "m" : "");
}
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

const EXAM_FILTERS = [
  { id: "all", label: "全部考试" },
  { id: "cet4", label: "大学英语四级（CET4）" },
  { id: "cet6", label: "大学英语六级（CET6）" },
  { id: "ncre", label: "全国计算机等级考试（NCRE）" },
  { id: "ntce", label: "中小学教师资格考试（NTCE）" },
  { id: "putonghua", label: "普通话水平测试（PSC）" },
  { id: "kaoyan", label: "全国硕士研究生招生考试" },
  { id: "tem4", label: "英语专业四级（TEM4）" },
  { id: "tem8", label: "英语专业八级（TEM8）" },
];
// 与桌面端 public/plugins/exam-calendar/main.js 的 SIGNUP_GUIDES 保持一致
const CET_GUIDE = {
  signupUrl: "https://cet-bm.neea.edu.cn/",
  signupAction: "复制 CET 报名系统网址",
  signupNotice: "CET 报名时间可能因省份、学校或考点不同而不同。请考生按所在学校规定时间登录 CET 全国网上报名系统（cet-bm.neea.edu.cn），完成资格审核、笔试报名缴费及口试报名缴费。",
};
const SIGNUP_GUIDES = {
  cet4: CET_GUIDE,
  cet6: CET_GUIDE,
  putonghua: {
    signupUrl: "https://bm.cltt.org/",
    signupAction: "复制普通话报名系统网址",
    signupNotice: "普通话水平测试（PSC）没有全国统一考试日期，由各省（市）语委与测试站分批组织，频次从每年 1 次到每月开考不等，报名与测试时间各省不同。请登录国家普通话水平测试在线报名系统（bm.cltt.org），选择所在省份查看测试站计划并报名。",
  },
};
function examFamilyIds(id) {
  if (id === "cet4") return ["cet4", "cet-set4"];
  if (id === "cet6") return ["cet6", "cet-set6"];
  return [id];
}
function eventBelongsToExam(ev, id) {
  if (!id || id === "all") return true;
  const ids = examFamilyIds(id);
  if (ids.indexOf(ev.examId) >= 0) return true;
  const merged = Array.isArray(ev.mergedFrom) ? ev.mergedFrom : [];
  return merged.some((x) => ids.indexOf(x) >= 0);
}
/* 考试列表展示口径必须与桌面端插件（public/plugins/exam-calendar/main.js）保持一致：
 * 日期只留 月-日 + 星期（年份由分组承担），倒计时分档，进行中用 endDate 判断。 */
function examSpanDays(ev) {
  return (ev.endDate && ev.endDate !== ev.date) ? dayDiff(ev.date, ev.endDate) + 1 : 1;
}
function examDateLines(ev) {
  const md = (s) => String(s).slice(5);
  const end = (ev.endDate && ev.endDate !== ev.date) ? ev.endDate : "";
  if (!end) return { top: md(ev.date), bottom: weekday(ev.date) };
  return { top: md(ev.date) + " → " + md(end), bottom: weekday(ev.date) + " → " + weekday(end) };
}
/* 报名窗口类条目（普通话这类各省分批、无全国统一日期的考试）不编造「剩 N 天」的截止感 */
function isExamWindow(ev) {
  return ev.type === "registration" || ev.type === "pre-registration";
}
/* 进行中必须用 endDate 判断：多日考试从第 2 天起 date 已经过去，
 * 只按 date 算差值会显示成「-1 天后」（旧版就是这个 bug）。 */
function examCountdown(ev, today) {
  const start = ev.date;
  const end = ev.endDate || ev.date;
  const win = isExamWindow(ev);
  if (today >= start && today <= end) {
    if (win) return { text: "报名中 · 各省分批", tone: "live" };
    const total = dayDiff(start, end) + 1;
    return { text: total > 1 ? "进行中 · 第 " + (dayDiff(start, today) + 1) + " 天" : "今天", tone: "live" };
  }
  const d = dayDiff(today, start);
  if (d <= 0) return { text: win ? "本批已结束" : "已结束", tone: "far" };
  if (d === 1) return { text: win ? "明天开始报名" : "明天", tone: "urgent" };
  if (d <= 3) return { text: d + " 天后" + (win ? "开始报名" : ""), tone: "urgent" };
  if (d <= 14) return { text: d + " 天后" + (win ? "开始报名" : ""), tone: "soon" };
  if (d <= 60) return { text: d + " 天后" + (win ? "开始报名" : ""), tone: "near" };
  if (d <= 180) return { text: "约 " + Math.round(d / 30) + " 个月后", tone: "far" };
  return { text: start, tone: "far" };
}
function examMetaText(ev) {
  const parts = [];
  if (ev.category) parts.push(ev.category);
  const span = examSpanDays(ev);
  if (span > 1 && !isExamWindow(ev)) parts.push("连续 " + span + " 天");
  if (ev.startTime) parts.push(ev.startTime + "–" + (ev.endTime || ""));
  parts.push(ev.confirmed ? "官方已确认" : "规则推算");
  return parts.join(" · ");
}
function futureExams(today, limit, examFilter) {
  today = today || store.todayStr();
  limit = Number(limit) || 30;
  examFilter = examFilter || "all";
  return (examData.events || [])
    .filter((ev) => ev && (ev.endDate || ev.date) >= today && eventBelongsToExam(ev, examFilter))
    .slice()
    // 只按日期排序（依赖稳定排序保留同日多条的数据顺序），与桌面端 allEvents() 口径一致。
    // 分批报名窗口（普通话这类）排在同年的具体考试之后，先按年分桶保证年份连续。
    .sort((a, b) => {
      const ay = a.date.slice(0, 4), by = b.date.slice(0, 4);
      if (ay !== by) return ay < by ? -1 : 1;
      const aw = isExamWindow(a) ? 1 : 0, bw = isExamWindow(b) ? 1 : 0;
      if (aw !== bw) return aw - bw;
      return a.date.localeCompare(b.date);
    })
    .slice(0, limit)
    .map((ev) => {
      const dl = examDateLines(ev);
      const cd = examCountdown(ev, today);
      return {
        examId: ev.examId,
        name: ev.name,
        type: ev.type,
        typeName: ev.typeName || "考试",
        category: ev.category || "考试",
        date: ev.date,
        endDate: ev.endDate || ev.date,
        dateTop: dl.top,
        dateBottom: dl.bottom,
        metaText: examMetaText(ev),
        confirmed: !!ev.confirmed,
        statusText: ev.confirmed ? "官方已确认" : "规则推算",
        url: ev.url || "",
        startTime: ev.startTime || "",
        endTime: ev.endTime || "",
        countdown: cd.text,
        tone: cd.tone,
        hot: cd.tone === "urgent" || cd.tone === "live",
        linkLabel: isExamWindow(ev) ? "复制报名网址" : "复制官方链接",
        key: [ev.examId, ev.type, ev.date].join("|"),
      };
    });
}
/* 已结束的场次：小程序端默认折叠，按年倒序分组 */
function pastExamGroups(today, examFilter) {
  today = today || store.todayStr();
  examFilter = examFilter || "all";
  const list = (examData.events || [])
    .filter((ev) => ev && (ev.endDate || ev.date) < today && eventBelongsToExam(ev, examFilter))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((ev) => ({
      key: [ev.examId, ev.type, ev.date].join("|"),
      examId: ev.examId,
      name: ev.name,
      type: ev.type,
      typeName: ev.typeName || "考试",
      date: ev.date,
      year: String(ev.date).slice(0, 4),
      dateText: ev.date + ((ev.endDate && ev.endDate !== ev.date) ? " ~ " + String(ev.endDate).slice(5) : ""),
      nameText: ev.name + ((ev.type !== "written" && ev.typeName) ? " · " + ev.typeName : ""),
      url: ev.url || "",
    }));
  const groups = [];
  list.forEach((x) => {
    let g = groups[groups.length - 1];
    if (!g || g.year !== x.year) { g = { year: x.year, count: 0, items: [] }; groups.push(g); }
    g.items.push(x);
    g.count += 1;
  });
  return { total: list.length, groups };
}
function examFlow(today, examFilter) {
  today = today || store.todayStr();
  examFilter = examFilter || "all";
  const option = EXAM_FILTERS.find((x) => x.id === examFilter) || EXAM_FILTERS[0];
  if (examFilter === "all") return { id: "all", label: option.label, registrations: [], registrationText: "", signupNotice: "", signupUrl: "", signupAction: "" };
  const regs = (examData.events || [])
    .filter((ev) => ev && eventBelongsToExam(ev, examFilter) && (ev.type === "registration" || ev.type === "pre-registration") && (ev.endDate || ev.date) >= today)
    .sort((a,b) => a.date.localeCompare(b.date));
  const registrationText = regs.length
    ? "已收录报名时间：" + regs.map((r) => (r.type === "pre-registration" ? "预报名 " : "报名 ") + r.date + (r.endDate && r.endDate !== r.date ? " ～ " + r.endDate : "") + (r.confirmed ? "（官方）" : "（预计）")).join("；")
    : "报名时间：当前离线数据尚未收录可用的全国统一报名起止时间，请以考试官网及所在学校/考点通知为准。";
  const guide = SIGNUP_GUIDES[examFilter] || null;
  return {
    id: examFilter,
    label: option.label,
    registrations: regs,
    registrationText,
    signupNotice: guide ? guide.signupNotice : "",
    signupUrl: guide ? guide.signupUrl : "",
    signupAction: guide ? guide.signupAction : "",
  };
}

/* ════ 轮换值日（dorm-duty）════
   与桌面端 public/plugins/dorm-duty/main.js **同源的轮换数学**：用「起始日 + 周期」切段，一段一人。
   为什么不是「每天算一个人」：每周轮换时整周都该是同一个人，否则会天天催人。

   一个插件里可以放**多套轮换**（宿舍值日 / 公区卫生…），每套各有成员、周期、起始日、换人记录
   与提醒设置，互不影响。存储结构（与桌面端逐字一致，备份可跨端恢复）：
     groups   : [{ id, name, startDate, periodDays, remindEnabled, remindTime, sound,
                   members, removed, overrides, lastNotified }]
     activeId : 界面当前选中的那一套
   旧版（单套轮换）把数据平铺在 members / config / overrides / removed / lastNotified 上，
   `ddMigrateLegacy()` 会把它迁成一组。**旧键留着不删**：删了就没法回退到旧版本。

   这里只放纯函数，**一律接收显式数据**（不在函数内部读 store），这样 Node 下能直接真跑边界；
   `dormDutySummary()` 是唯一读 store 的入口，页面用它取视图模型。 */
const DD_NAME_DEFAULT = "值日";
const DD_GROUP_MAX = 12;    // 最多几套轮换（防病态数据把界面撑爆）
const DD_PERIODS = [
  { days: 1, label: "每天" },
  { days: 3, label: "每 3 天" },
  { days: 7, label: "每周" },
  { days: 14, label: "每两周" },
];
const DD_UPCOMING = 6;      // 后续轮次展示条数
const DD_REMOVED_KEEP = 12; // 「已移除」最多保留几个
const DD_NAME_MAX = 12;     // 轮换名（如「宿舍值日」/「公区卫生」）
const DD_MEMBER_MAX = 16;   // 成员名
const DD_LOCATION_MAX = 12;
const DD_LOCATION_NAME_MAX = 24;

function ddValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }
/** 合法时刻 → "HH:MM"；非法返回 null。
    只校验 /^\d{2}:\d{2}$/ 是不够的："25:99" 能过格式校验，换算成分钟是 1599，
    超过一天的最大值 1439 —— 于是「还没到点」永远成立，提醒被**静默关掉**（不报错不提示）。
    时 0–23、分 0–59 必须真校验。桌面端踩过这个坑，这里同一套规则。 */
function ddNormalizeTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
  return pad2(h) + ":" + pad2(mi);
}
function ddPeriodLabel(days) {
  const hit = DD_PERIODS.filter((p) => p.days === days)[0];
  return hit ? hit.label : "每 " + days + " 天";
}
function ddDefaultConfig(today) {
  return { dutyName: DD_NAME_DEFAULT, startDate: today, periodDays: 7, remindEnabled: true, remindTime: "08:00", sound: "beep" };
}
/** 旧版「配置」的归一化。现在只在**迁移**时用到（新结构把字段平铺在组上）。
    配置损坏不能把插件变成白屏，一律退回可用默认值；未识别的键（如桌面端的 sound）原样保留。
    只接受**普通对象**：字符串 / 数组也能被 Object.assign 展开成 {"0":…,"1":…} 这种垃圾键，
    会被原样写回 storage 跟着备份走。 */
function ddNormalizeConfig(raw, today) {
  const base = ddDefaultConfig(today);
  const usable = raw && typeof raw === "object" && !Array.isArray(raw);
  const c = Object.assign({}, base, usable ? raw : {});
  c.dutyName = String(c.dutyName || "").trim().slice(0, DD_NAME_MAX) || DD_NAME_DEFAULT;
  if (!ddValidDate(c.startDate)) c.startDate = base.startDate;
  c.periodDays = Math.min(365, Math.max(1, Math.round(Number(c.periodDays) || 7)));
  c.remindTime = ddNormalizeTime(c.remindTime) || "08:00";
  c.remindEnabled = c.remindEnabled !== false;
  c.sound = String(c.sound || "beep");
  return c;
}
function ddMembers(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((m) => m && m.id)
    .map((m) => ({ id: String(m.id), name: String(m.name || "").slice(0, DD_MEMBER_MAX).trim() || "未命名" }));
}
function ddLocations(raw) {
  const names = (Array.isArray(raw) ? raw : []).map((v) => String(v || "").trim().slice(0, DD_LOCATION_NAME_MAX)).filter(Boolean);
  return names.filter((v, i) => names.indexOf(v) === i).slice(0, DD_LOCATION_MAX);
}
function ddUid(prefix) { return (prefix || "m") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* ── 轮换组的归一化 / 迁移 ── */
/** 一套轮换的默认值。 */
function ddDefaultGroup(today, name) {
  return {
    id: ddUid("g"),
    name: String(name || "").trim().slice(0, DD_NAME_MAX) || DD_NAME_DEFAULT,
    startDate: ddValidDate(today) ? today : store.todayStr(),
    periodDays: 7,
    perRound: 1,
    locations: [],
    locationPeriodDays: 7,
    remindEnabled: true,
    remindTime: "08:00",
    sound: "beep",
    members: [], removed: [], overrides: {}, lastNotified: "",
  };
}
/** 归一化一组。未识别的键原样保留 —— 别端（桌面）字段不能被抹掉。 */
function ddNormalizeGroup(raw, today) {
  const base = ddDefaultGroup(today, null);
  const usable = raw && typeof raw === "object" && !Array.isArray(raw);
  const g = Object.assign({}, base, usable ? raw : {});
  g.id = String(g.id || "").trim() || base.id;
  g.name = String(g.name || "").trim().slice(0, DD_NAME_MAX) || DD_NAME_DEFAULT;
  if (!ddValidDate(g.startDate)) g.startDate = base.startDate;
  g.periodDays = Math.min(365, Math.max(1, Math.round(Number(g.periodDays) || 7)));
  g.locationPeriodDays = Math.min(365, Math.max(1, Math.round(Number(g.locationPeriodDays) || 7)));
  g.locations = ddLocations(g.locations);
  // 每轮人数：1 = 单人（历史默认）。不 clamp 到当前成员数（成员会变），计算时用模运算兜底。
  g.perRound = Math.min(DD_MEMBER_MAX, Math.max(1, Math.round(Number(g.perRound) || 1)));
  g.remindTime = ddNormalizeTime(g.remindTime) || "08:00";
  g.remindEnabled = g.remindEnabled !== false;
  g.sound = String(g.sound || "beep");
  g.members = ddMembers(g.members);
  g.removed = ddMembers(g.removed).slice(0, DD_REMOVED_KEEP);
  g.overrides = g.overrides && typeof g.overrides === "object" && !Array.isArray(g.overrides)
    ? Object.assign({}, g.overrides) : {};
  g.lastNotified = String(g.lastNotified || "");
  return g;
}
/** 归一化整份组列表。重复 id 会让「切换轮换」指错对象，必须剔掉。 */
function ddGroups(raw, today) {
  const out = [];
  const seen = {};
  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length && out.length < DD_GROUP_MAX; i++) {
    const g = ddNormalizeGroup(list[i], today);
    if (seen[g.id]) continue;
    seen[g.id] = 1;
    out.push(g);
  }
  return out;
}
/** 旧版单套轮换 → 一组。没有任何旧数据时返回空数组（由调用方决定要不要建默认组）。 */
function ddMigrateLegacy(legacy, today) {
  const L = legacy && typeof legacy === "object" ? legacy : {};
  const hasAny = (Array.isArray(L.members) && L.members.length > 0)
    || !!L.config
    || !!L.lastNotified
    || (L.overrides && typeof L.overrides === "object" && Object.keys(L.overrides).length > 0);
  if (!hasAny) return [];
  const cfg = ddNormalizeConfig(L.config, today);
  return [ddNormalizeGroup({
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
/** 当前该显示哪一组：存的 activeId 有效就用它，否则退回第一组；没有组时返回 ""。 */
function ddActiveId(groups, activeId) {
  const list = groups || [];
  if (!list.length) return "";
  return list.some((g) => g.id === activeId) ? String(activeId) : list[0].id;
}

/* ── 轮换数学（纯函数，只吃传入的那一组） ── */
const ddPeriod = (g) => Math.max(1, Math.round(Number(g && g.periodDays) || 1));
/** 每轮当班人数（多人值日）：1 = 单人。 */
const ddPerRound = (g) => Math.max(1, Math.round(Number(g && g.perRound) || 1));
/** 某天落在哪一轮：返回该轮起始日；起始日之前返回 null（轮换还没开始）。 */
function ddCycleStartOf(g, date) {
  const start = g && g.startDate;
  if (!ddValidDate(start) || !ddValidDate(date)) return null;
  const diff = dayDiff(start, date);
  if (diff < 0) return null;
  return store.addDays(start, Math.floor(diff / ddPeriod(g)) * ddPeriod(g));
}
const ddCycleIndexAt = (g, cycleStart) => Math.round(dayDiff(g.startDate, cycleStart) / ddPeriod(g));
function ddLocationCycleStartOf(g, date) {
  if (!ddValidDate(g.startDate) || !ddValidDate(date)) return null;
  const diff = dayDiff(g.startDate, date);
  if (diff < 0) return null;
  return store.addDays(g.startDate, Math.floor(diff / g.locationPeriodDays) * g.locationPeriodDays);
}
function ddLocationAt(g, date) {
  if (!g.locations.length) return "";
  const start = ddLocationCycleStartOf(g, date);
  return start ? g.locations[Math.round(dayDiff(g.startDate, start) / g.locationPeriodDays) % g.locations.length] : "";
}
const ddIsCycleStartDay = (g, date) => ddCycleStartOf(g, date) === date;
/** 某一轮「正常轮换」该当班的一批人（不看临时换人）：成员环上取 perRound 人的滑动窗口。 */
function ddNormalAssignees(g, cycleStart) {
  if (!cycleStart || !g.members.length) return [];
  const per = ddPerRound(g);
  const len = g.members.length;
  const idx = ddCycleIndexAt(g, cycleStart);
  const out = [];
  for (let i = 0; i < per; i++) out.push(g.members[(idx * per + i) % len]);
  const seen = {};
  const uniq = [];
  out.forEach((m) => { if (!seen[m.id]) { seen[m.id] = 1; uniq.push(m); } });
  return uniq;
}
/** 某一轮「正常轮换」该谁（单人行，兼容旧调用）：多人时取第一个。 */
function ddNormalFor(g, cycleStart) {
  return ddNormalAssignees(g, cycleStart)[0] || null;
}
/** 某一轮的临时换人名单里**真的还在名单里**的人（保序、去重）。
    override 值是双格式：单人 = 字符串 id（历史格式，桌面端写入），多人 = id 数组。
    指向已被移除的人要过滤掉 —— 全部失效时返回空数组，由调用方退回正常排班。 */
function ddOverrideHits(g, cycleStart) {
  const v = cycleStart ? (g.overrides || {})[cycleStart] : "";
  const ids = Array.isArray(v) ? v : (v ? [v] : []);
  const seen = {};
  const hits = [];
  ids.forEach((raw) => {
    const id = String(raw || "");
    if (!id || seen[id]) return;
    seen[id] = 1;
    const m = g.members.filter((x) => x.id === id)[0];
    if (m) hits.push(m);
  });
  return hits;
}
/** 某一轮的换人是否**真的生效**（单人行，兼容旧调用）：多人换人时取第一个。
    指向已被移除的人时不算换人 —— 否则界面会显示「已换人 · 原 X」而实际当班的就是 X。 */
function ddOverrideHit(g, cycleStart) {
  return ddOverrideHits(g, cycleStart)[0] || null;
}
/** 某天的当班人（可能多人）：没成员 / 没开始 → 空数组；有临时换人 → 换上的名单。 */
function ddAssigneesFor(g, date) {
  const cycle = ddCycleStartOf(g, date);
  if (!cycle || !g.members.length) return [];
  const hits = ddOverrideHits(g, cycle);
  return hits.length ? hits : ddNormalAssignees(g, cycle);
}
/** 编辑列表按真实轮换顺序排列，拖动索引与保存位置一致。 */
function ddMembersInDateOrder(g, date) {
  return g.members.slice();
}
/** 某天的当班人（单人行，兼容旧调用）：多人时取第一个。 */
function ddAssigneeFor(g, date) {
  return ddAssigneesFor(g, date)[0] || null;
}

/* ── 组的增删改（不可变：一组进、一组出；页面只负责把结果写回 storage） ── */
/** 把某一组替换成 fn 处理后的新组。 */
function ddWithGroup(groups, id, fn) {
  return (groups || []).map((g) => (g.id === id ? fn(g) : g));
}
function ddGroupPatch(g, patch) {
  return Object.assign({}, g, patch || {});
}
function ddGroupAddLocation(g, name) {
  const n = String(name || "").trim().slice(0, DD_LOCATION_NAME_MAX);
  if (!n || (g.locations || []).indexOf(n) >= 0 || (g.locations || []).length >= DD_LOCATION_MAX) return g;
  return ddGroupPatch(g, { locations: (g.locations || []).concat(n) });
}
function ddGroupMoveLocation(g, index, delta) {
  const list = (g.locations || []).slice();
  const to = index + delta;
  if (index < 0 || to < 0 || to >= list.length) return g;
  const hold = list[index]; list[index] = list[to]; list[to] = hold;
  return ddGroupPatch(g, { locations: list });
}
function ddGroupRemoveLocation(g, index) {
  const list = (g.locations || []).slice();
  if (index < 0 || index >= list.length) return g;
  list.splice(index, 1);
  return ddGroupPatch(g, { locations: list });
}
function ddGroupAddMember(g, name) {
  const n = String(name || "").trim().slice(0, DD_MEMBER_MAX);
  if (!n) return g;
  return Object.assign({}, g, { members: (g.members || []).concat([{ id: ddUid("m"), name: n }]) });
}
function ddGroupRenameMember(g, id, name) {
  const n = String(name || "").trim().slice(0, DD_MEMBER_MAX);
  if (!n) return g;
  return Object.assign({}, g, { members: (g.members || []).map((m) => (m.id === id ? { id: m.id, name: n } : m)) });
}
function ddGroupMoveMember(g, id, delta) {
  const members = g.members || [];
  const i = members.map((m) => m.id).indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= members.length) return g;
  const next = members.slice();
  const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
  return Object.assign({}, g, { members: next });
}
function ddGroupMoveMemberTo(g, id, toIndex) {
  const members = g.members || [];
  const from = members.map((m) => m.id).indexOf(id);
  const to = Math.max(0, Math.min(members.length - 1, Math.round(Number(toIndex))));
  if (from < 0 || to < 0 || from === to) return g;
  const next = members.slice();
  const hit = next.splice(from, 1)[0];
  next.splice(to, 0, hit);
  return Object.assign({}, g, { members: next });
}
/** 移除成员：进「已移除」可恢复，并把指向他的临时换人一并清掉（否则会留一条永远命中不了的 override）。
    override 值有双格式：单人字符串直接删；多人数组里滤掉他，滤空了整个键也删掉。 */
function ddGroupRemoveMember(g, id) {
  const hit = (g.members || []).filter((m) => m.id === id)[0];
  if (!hit) return g;
  const ov = {};
  Object.keys(g.overrides || {}).forEach((k) => {
    const v = g.overrides[k];
    if (Array.isArray(v)) {
      const next = v.filter((x) => x !== id);
      if (next.length) ov[k] = next;
    } else if (v !== id) {
      ov[k] = v;
    }
  });
  return Object.assign({}, g, {
    members: g.members.filter((m) => m.id !== id),
    removed: [{ id: hit.id, name: hit.name }].concat(g.removed || []).slice(0, DD_REMOVED_KEEP),
    overrides: ov,
  });
}
function ddGroupRestoreMember(g, id) {
  const hit = (g.removed || []).filter((m) => m.id === id)[0];
  if (!hit) return g;
  return Object.assign({}, g, {
    members: (g.members || []).concat([{ id: hit.id, name: hit.name }]),
    removed: (g.removed || []).filter((m) => m.id !== id),
  });
}
/** 记 / 撤临时换人。memberId 传空 = 撤销这一轮的换人。
    小程序端的换人面板是单选（ActionSheet），所以这里写**字符串**（历史格式，
    桌面端 / 旧版本客户端都能读）；桌面端的多选换人写数组，本端读取时用 ddOverrideHits 兼容。 */
function ddGroupSetOverride(g, cycle, memberId, remindTime, today) {
  const next = Object.assign({}, g.overrides || {});
  if (memberId) next[cycle] = memberId; else delete next[cycle];
  const patch = { overrides: next };
  const t = memberId ? ddNormalizeTime(remindTime) : "";
  if (t) patch.remindTime = t;
  if (memberId && today && g.lastNotified === today) patch.lastNotified = "";
  return Object.assign({}, g, patch);
}
/** 新建一套轮换（返回新组，由调用方 concat 进列表并切过去）。到上限返回 null。 */
function ddAddGroup(groups, today, name) {
  if ((groups || []).length >= DD_GROUP_MAX) return null;
  return ddDefaultGroup(today, name);
}
/** 删除一套轮换。**最后一套不许删** —— 删光界面就没有可编辑的对象了。
    返回 { ok, groups, activeId }：删掉的正是当前组时，activeId 落到邻居。 */
function ddRemoveGroup(groups, id, activeId) {
  const list = groups || [];
  if (list.length <= 1) return { ok: false, groups: list, activeId: activeId };
  const idx = list.map((g) => g.id).indexOf(id);
  if (idx < 0) return { ok: false, groups: list, activeId: activeId };
  const next = list.slice(0, idx).concat(list.slice(idx + 1));
  const nextActive = activeId === id ? next[Math.min(idx, next.length - 1)].id : activeId;
  return { ok: true, groups: next, activeId: nextActive };
}
/** 副本名：把本体截短来腾出「 N」的位置。直接 src + " 2" 再切到 DD_NAME_MAX，
    满长的名字会切回和源组一模一样的串。与桌面端 nextCopyName 同语义。 */
function ddCopyName(srcName, groups) {
  const taken = {};
  (groups || []).forEach((g) => { taken[g.name] = 1; });
  for (let n = 2; n < 100; n++) {
    const suffix = " " + n;
    const keep = Math.max(1, DD_NAME_MAX - suffix.length);
    const cand = (String(srcName || "").slice(0, keep) + suffix).slice(0, DD_NAME_MAX);
    if (!taken[cand]) return cand;
  }
  return ("轮换 " + ((groups || []).length + 1)).slice(0, DD_NAME_MAX);
}
/** 复制一套轮换：规则与名单原样带走，但组 id 和每个成员 id 全部重新生成。
    沿用旧 id 等于两组共享同一批人，副本里换人 / 移除会连着改掉原组的排班。
    连带代价：overrides 记的是成员 id，端过来全是悬空引用，所以清空；lastNotified 也清空。
    起始日保留 —— 同一宿舍的两套值日才会在同一天换人。
    返回 { groups, activeId, created }；到上限或找不到那组时返回 null。 */
function ddDuplicateGroup(groups, id, today) {
  const list = groups || [];
  if (list.length >= DD_GROUP_MAX) return null;
  const idx = list.map((g) => g.id).indexOf(id);
  if (idx < 0) return null;
  const src = list[idx];
  const reid = (arr) => (arr || []).map((m) => ({ id: ddUid("m"), name: m.name }));
  const created = ddNormalizeGroup({
    id: ddUid("g"),
    name: ddCopyName(src.name, list),
    startDate: src.startDate,
    periodDays: src.periodDays,
    perRound: src.perRound,
    remindEnabled: src.remindEnabled,
    remindTime: src.remindTime,
    sound: src.sound,
    members: reid(src.members),
    removed: reid(src.removed),
    overrides: {},
    lastNotified: "",
  }, today);
  // 紧跟源组插入，而不是甩到列表末尾
  return {
    groups: list.slice(0, idx + 1).concat([created], list.slice(idx + 1)),
    activeId: created.id,
    created: created,
  };
}
/** 从另一套轮换导入成员：按**名字**去重后追加到目标末尾，id 一律新建。
    只能按名字对 —— 两组的成员 id 各起各的。已有的人连 id 都不动。
    返回 { groups, added }；找不到组 / 自己导给自己 / 没有新人可加时 added = 0。 */
function ddImportMembers(groups, targetId, sourceId) {
  const list = groups || [];
  const ti = list.map((g) => g.id).indexOf(targetId);
  const si = list.map((g) => g.id).indexOf(sourceId);
  if (ti < 0 || si < 0 || ti === si) return { groups: list, added: 0 };
  const target = list[ti];
  const source = list[si];
  const mine = (target.members || []).slice();
  const room = DD_MEMBER_MAX - mine.length;
  if (room <= 0) return { groups: list, added: 0 };
  const have = {};
  mine.forEach((m) => { have[m.name] = 1; });
  const added = [];
  for (let i = 0; i < (source.members || []).length && added.length < room; i++) {
    const m = source.members[i];
    if (have[m.name]) continue;
    have[m.name] = 1;
    added.push({ id: ddUid("m"), name: m.name });
  }
  if (!added.length) return { groups: list, added: 0 };
  const next = list.slice();
  next[ti] = ddGroupPatch(target, { members: mine.concat(added) });
  return { groups: next, added: added.length };
}

/* ── 视图模型（纯函数，页面与测试共用） ── */
const ddRelLabel = (n) => (n === 0 ? "今天" : n === 1 ? "明天" : n > 0 ? n + " 天后" : -n + " 天前");
const ddRangeText = (start, end) => (start === end ? start : start + " → " + end);
const ddMonthDay = (s) => Number(s.slice(5, 7)) + "月" + Number(s.slice(8, 10)) + "日";

function ddSnapshot(today, group) {
  today = today || store.todayStr();
  const g = ddNormalizeGroup(group, today);
  const period = ddPeriod(g);
  const per = ddPerRound(g);
  const cycle = ddCycleStartOf(g, today);
  const started = !!cycle;
  const current = ddAssigneeFor(g, today);
  const currentAll = ddAssigneesFor(g, today);
  const nextStart = cycle ? store.addDays(cycle, period) : (ddValidDate(g.startDate) ? g.startDate : null);
  const locationCycle = ddLocationCycleStartOf(g, today);
  const nextLocationStart = g.locations.length ? (locationCycle ? store.addDays(locationCycle, g.locationPeriodDays) : g.startDate) : null;

  const rows = [];
  for (let i = 0; i < DD_UPCOMING && nextStart; i++) {
    const start = store.addDays(nextStart, i * period);
    const whoAll = ddAssigneesFor(g, start);
    const names = whoAll.map((m) => m.name).join("、");
    rows.push({
      start,
      end: store.addDays(start, period - 1),
      // 周几要标出来，但别重复：单日轮次写成「9月18日（周五）」，
      // 多日轮次写成「9月14日 → 9月20日 · 周五起」。与桌面端文案一致。
      range: period > 1
        ? ddRangeText(ddMonthDay(start), ddMonthDay(store.addDays(start, period - 1))) + " · " + weekday(start) + "起"
        : ddMonthDay(start) + "（" + weekday(start) + "）",
      whoId: whoAll.length ? whoAll[0].id : "",
      whoName: names || "—",
      index: ddCycleIndexAt(g, start) + 1,
      daysUntil: dayDiff(today, start),
      daysText: ddRelLabel(dayDiff(today, start)),
      swapped: ddOverrideHits(g, start).length > 0,
    });
  }
  const nextAll = nextStart ? ddAssigneesFor(g, nextStart) : [];
  const nextDiff = nextStart ? dayDiff(today, nextStart) : 0;
  // 本轮换人是否真的生效（override 指向的人还在名单里才算）
  const swapHits = cycle ? ddOverrideHits(g, cycle) : [];
  const normalAll = cycle ? ddNormalAssignees(g, cycle) : [];

  return {
    today,
    todayText: weekday(today),
    groupId: g.id,
    groupName: g.name,
    cfg: {
      name: g.name, startDate: g.startDate, periodDays: g.periodDays,
      locationPeriodDays: g.locationPeriodDays,
      remindTime: g.remindTime, remindEnabled: g.remindEnabled, sound: g.sound,
    },
    periodLabel: ddPeriodLabel(period),
    periods: DD_PERIODS.map((p) => ({ days: p.days, label: p.label, on: p.days === period })),
    perRound: per,
    perRounds: [1, 2, 3, 4].map((n) => ({ n, label: n === 1 ? "单人" : n + " 人", on: n === per })),
    hasMembers: g.members.length > 0,
    empty: g.members.length === 0,
    started,
    cycle: cycle || "",
    cycleIndex: cycle ? ddCycleIndexAt(g, cycle) + 1 : 0,
    cycleText: cycle
      ? (period > 1
        ? ddMonthDay(cycle) + " — " + ddMonthDay(store.addDays(cycle, period - 1)) + " · " + weekday(cycle) + " 起"
        : ddMonthDay(cycle) + "（" + weekday(cycle) + "）")
      : "还没开始",
    current: current ? { id: current.id, name: current.name } : null,
    /** 多人当班时的名字串（「、」连接）；单人时与 current.name 一致。 */
    currentNames: currentAll.map((m) => m.name).join("、"),
    currentLocation: ddLocationAt(g, today),
    nextLocationStart: nextLocationStart || "",
    nextLocationText: nextLocationStart ? ddMonthDay(nextLocationStart) + " " + weekday(nextLocationStart) : "",
    nextLocationName: nextLocationStart ? ddLocationAt(g, nextLocationStart) : "",
    locations: g.locations.map((name, i) => ({ name, index: i, no: i + 1, canUp: i > 0, canDown: i < g.locations.length - 1 })),
    canAddLocation: g.locations.length < DD_LOCATION_MAX,
    locationPeriods: DD_PERIODS.map((p) => ({ days: p.days, label: p.label, on: p.days === g.locationPeriodDays })),
    locationPeriodCustom: !DD_PERIODS.some((p) => p.days === g.locationPeriodDays),
    /** 本轮实际当班的 id 集合（换过 = 换上的名单），供「当班」标记与换人面板用。 */
    currentIds: currentAll.map((m) => m.id),
    currentIsMulti: currentAll.length > 1,
    swapped: swapHits.length > 0,
    /** 被换掉的那批人（正常轮换本该当班的），用来在界面上说明「原本是谁」。 */
    swapName: swapHits.length && normalAll.length ? normalAll.map((m) => m.name).join("、") : "",
    nextStart: nextStart || "",
    nextStartText: nextStart ? ddMonthDay(nextStart) + " " + weekday(nextStart) : "",
    nextWhoName: nextAll.map((m) => m.name).join("、") || "—",
    nextBigEm: nextDiff <= 0 ? "今天" : nextDiff === 1 ? "明天" : String(nextDiff),
    nextBigUnit: nextDiff <= 0 ? "" : nextDiff === 1 ? "" : " 天后",
    nextVerb: started ? "换人" : "开始",
    rows,
    members: ddMembersInDateOrder(g, today).map((m, i) => {
      const baseIndex = g.members.findIndex((item) => item.id === m.id);
      return {
        id: m.id, name: m.name, no: i + 1,
        isCurrent: currentIdsOf(currentAll, m.id),
        canUp: baseIndex > 0, canDown: baseIndex < g.members.length - 1,
      };
    }),
    removed: g.removed,
    lastNotified: g.lastNotified,
  };
}
const currentIdsOf = (list, id) => list.some((m) => m.id === id);

/** 整份视图模型：当前组的完整快照（字段与旧版一致，页面直接 dd.xxx 用）+ 顶部的轮换标签条。 */
function ddSummaryFrom(groups, activeId, today) {
  const list = groups || [];
  const active = list.filter((g) => g.id === activeId)[0] || list[0] || null;
  const snap = ddSnapshot(today, active);
  snap.groups = list.map((g) => {
    const who = ddAssigneesFor(g, today).map((m) => m.name).join("、");
    return { id: g.id, name: g.name, who: who, on: !!active && g.id === active.id };
  });
  snap.activeId = active ? active.id : "";
  snap.groupCount = list.length;
  snap.canAddGroup = list.length < DD_GROUP_MAX;
  snap.canDelGroup = list.length > 1;
  return snap;
}

/** 页面入口：读 store → 视图模型。
    ⚠️ 它有**写**副作用：旧数据迁移、以及「一组都没有」的兜底建组都要立刻落盘 ——
    不写的话「已迁移」和「未迁移」在存储上分不出来，每次进页面都会重新生成一个随机 id 的
    默认组，用户刚做的设置下一次就没了。 */
function dormDutySummary(today) {
  today = today || store.todayStr();
  const raw = store.pluginStorageGet("dorm-duty", "groups", null);
  let groups = ddGroups(raw, today);
  let needPersist = false;
  // 只有「新版数据完全不存在」时才看旧键：groups 一旦存在就说明已经迁移过，
  // 不能再被旧快照（旧版本客户端写的）盖回去。
  if (!raw) {
    const migrated = ddMigrateLegacy({
      members: store.pluginStorageGet("dorm-duty", "members", []),
      config: store.pluginStorageGet("dorm-duty", "config", null),
      overrides: store.pluginStorageGet("dorm-duty", "overrides", {}),
      removed: store.pluginStorageGet("dorm-duty", "removed", []),
      lastNotified: store.pluginStorageGet("dorm-duty", "lastNotified", ""),
    }, today);
    if (migrated.length) { groups = migrated; needPersist = true; }
  }
  if (!groups.length) { groups = [ddDefaultGroup(today, null)]; needPersist = true; }
  const storedActive = store.pluginStorageGet("dorm-duty", "activeId", "");
  const activeId = ddActiveId(groups, storedActive);
  // activeId 变了（首次落盘 / 存的指针失效）也要写回 —— 让存储里的指针**始终有效**，
  // 而不是每次进页面都靠兜底。落盘的 groups 与 activeId 必须是一对，否则指针会指空。
  if (needPersist || activeId !== storedActive) {
    store.pluginStorageSet("dorm-duty", "groups", groups);
    store.pluginStorageSet("dorm-duty", "activeId", activeId);
  }
  return ddSummaryFrom(groups, activeId, today);
}

/** 某一组到点提醒的判据（纯函数）。
    小程序**没有后台常驻**，宿主也不给定时回调 —— 这里只能做「打开页面时补提醒」：
    在每轮第一天、且已过设定时刻、且当天没提醒过 → 值得弹一次。 */
function ddReminderDue(group, today, nowMinutes) {
  const g = ddNormalizeGroup(group, today);
  if (!g.remindEnabled || !g.members.length) return null;
  if (!ddIsCycleStartDay(g, today)) return null;          // 只在每轮第一天提醒，否则天天催
  if (g.lastNotified === today) return null;              // 这一轮已经提醒过
  const parts = String(g.remindTime).split(":").map(Number);
  const now = Number.isFinite(nowMinutes) ? nowMinutes : (function () {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  })();
  if (now < parts[0] * 60 + parts[1]) return null;        // 还没到点
  const all = ddAssigneesFor(g, today);
  if (!all.length) return null;
  return { groupId: g.id, groupName: g.name, whoName: all.map((m) => m.name).join("、"), location: ddLocationAt(g, today), time: g.remindTime };
}
/** 所有到点的组（多套轮换各有各的时刻与去重，互不影响）。 */
function ddDueReminders(groups, today, nowMinutes) {
  return (groups || []).map((g) => ddReminderDue(g, today, nowMinutes)).filter(Boolean);
}
/** 把这几组标成「今天已提醒」。返回新的 groups（页面写回 storage）。 */
function ddMarkNotified(groups, ids, today) {
  const set = {};
  (ids || []).forEach((id) => { set[id] = 1; });
  return (groups || []).map((g) => (set[g.id] ? Object.assign({}, g, { lastNotified: today }) : g));
}

/* ════ 拖入消息收纳（inbox-drop）════
   桌面 / Android 端的玩法是「把消息拖进面板」；小程序**没有系统级拖放**，也没有剪贴板读图，
   所以这里做的是同一件事的另一种入口：**粘贴 / 手输消息文本 → 识别 → 收纳 / 转任务**。

   存储键与桌面端逐字一致（drops / seq），所以跨端备份恢复后，桌面拖进来的记录在小程序里
   照样看得到、也能继续处理 —— 这正是「同源」的意义。
     drops : [{ id, seq, at, kind, title, raw, platform, msgType, date, time, source,
                fileSize, bin, done, pinned }]
   识别逻辑与桌面端 main.js 的同名表**必须保持一致**（平台 / 类型关键词、quad 映射）：
   两端各写一份是有意的 —— 小程序包不能 require 桌面端的 main.js（那是 DOM 插件），
   但表内容要能对得上，否则同一条消息在两端会被归进不同的类型。 */

/** 平台表。顺序即优先级：先命中先用（「学习通 考试通知」要先认平台再认类型）。 */
const ID_PLATFORMS = [
  { id: "wechat",    label: "微信",     re: /微信|WeChat|群聊|公众号|聊天记录|订阅号/i },
  { id: "qq",        label: "QQ",       re: /\bQQ\b|腾讯QQ|群消息/i },
  { id: "chaoxing",  label: "学习通",   re: /学习通|超星|智慧树|尔雅/i },
  { id: "dingtalk",  label: "钉钉",     re: /钉钉|DingTalk/i },
  { id: "wecom",     label: "企业微信", re: /企业微信|WeCom/i },
  { id: "feishu",    label: "飞书",     re: /飞书|Lark/i },
  { id: "mail",      label: "邮件",     re: /@(?:qq|163|126|outlook|gmail|foxmail)\.com|发件人|收件人|主题[:：]/i },
  { id: "school",    label: "学校门户", re: /教务处|教务系统|学工|一网通办|研究生院|学院通知/i },
  { id: "portal",    label: "校内门户", re: /门户|通知公告|信息公开/i },
  { id: "sms",       label: "短信",     re: /【.{2,12}】|短信|验证码\d|退订回复/i },
];
/** 消息类型表。quad 与 cat 决定转成任务时落到哪个象限 / 日程分类。 */
const ID_TYPES = [
  { id: "exam",     label: "考试", quad: 1, cat: "study", re: /考试|考场|补考|缓考|准考证|考级|机考|笔试/i },
  { id: "hw",       label: "作业", quad: 1, cat: "study", re: /作业|习题|实验报告|论文|提交|上传附件|小测|随堂/i },
  { id: "signin",   label: "签到", quad: 2, cat: "study", re: /签到|打卡|上课码|手势签到|位置签到/i },
  { id: "meeting",  label: "会议", quad: 2, cat: "work",  re: /会议|例会|组会|答辩|研讨会|腾讯会议|钉钉会议/i },
  { id: "activity", label: "活动", quad: 3, cat: "life",  re: /活动|讲座|报名|招募|社团|志愿者|比赛|竞赛/i },
  { id: "fee",      label: "缴费", quad: 2, cat: "life",  re: /缴费|充值|账单|水电|宿费|报名费|付款/i },
  { id: "notify",   label: "通知", quad: 3, cat: "work",  re: /通知|公告|提醒|须知|安排|公示/i },
  { id: "deadline", label: "截止", quad: 1, cat: "work",  re: /截止|最终期限|务必于|过期不候|最后期限/i },
  { id: "chat",     label: "闲聊", quad: 4, cat: "life",  re: /哈哈|在吗|收到|好的|晚安|谢谢|表情/i },
];
const ID_KINDS = [
  { id: "text",  label: "文字",   icon: "font" },
  { id: "image", label: "截图",   icon: "image" },
  { id: "file",  label: "文本文件", icon: "file-lines" },
  { id: "other", label: "文件",   icon: "paperclip" },
];
/** 收纳台账上限。超了从**最旧的、已处理**的开始丢，置顶的和没处理的一律保住。 */
const ID_KEEP = 300;
const ID_TITLE_MAX = 80;
const ID_RAW_MAX = 2000;
/** 去重窗口：标题相同且时间差在一天内算同一条（跨天重复的通知不算）。 */
const ID_DUP_MS = 86400000;

const idPlatformLabel = (id) => {
  const p = ID_PLATFORMS.find((x) => x.id === id);
  return p ? p.label : "";
};
const idTypeLabel = (id) => {
  const t = ID_TYPES.find((x) => x.id === id);
  return t ? t.label : "";
};
const idKindLabel = (id) => {
  const k = ID_KINDS.find((x) => x.id === id);
  return k ? k.label : "";
};
const idTypeMeta = (id) => ID_TYPES.find((x) => x.id === id) || null;

/** 认平台。认不出返回空串 —— 空串表示「不知道」，不是「其它」。 */
function idDetectPlatform(text) {
  const s = String(text || "");
  for (const p of ID_PLATFORMS) if (p.re.test(s)) return p.id;
  return "";
}
/** 认消息类型。命中不到就算 `notify`（一条不认识的消息默认是通知，比默认「闲聊」更接近事实）。 */
function idDetectType(text) {
  const s = String(text || "");
  for (const t of ID_TYPES) if (t.re.test(s)) return t.id;
  return s.trim() ? "notify" : "";
}
/** 从 `【学习通】` 这类方括号里抠来源名。抠不到就用平台标签，再没有就空着。 */
function idSourceOf(text, platform) {
  const m = String(text || "").match(/【([^】]{2,16})】/);
  if (m) return m[1];
  return idPlatformLabel(platform);
}
const idTidy = (s) => String(s == null ? "" : s)
  .replace(/\r\n?/g, "\n").replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** 把一坨消息文本裁成一条能当标题用的短句。
    优先取第一行有信息量的（跳过「某某：」这种发言人前缀与纯时间行），
    再把日期时间段落剪掉 —— 它们已经单独进 date / time 字段了，留在标题里只会重复。 */
function idTitleOf(text) {
  const lines = idTidy(text).split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const body = line.replace(/^[^：:]{1,12}[：:]\s*/, "");   // 去掉「张三：」
    if (body.length < 2) continue;
    if (/^\d{1,4}[-/年月日]\d{1,2}[-/月日]?\d{0,2}\s*\d{0,2}:?\d{0,2}$/.test(body)) continue; // 纯时间行
    return body.slice(0, ID_TITLE_MAX);
  }
  return idTidy(text).slice(0, ID_TITLE_MAX) || "（无标题）";
}

/** 从文本里认日期。**只认确定的说法**：今天/明天/后天/大后天、`YYYY-MM-DD`、`M月D日`、`M/D`。
    没有年份时按「就近的未来」算：已经过去超过 183 天的往后推一年 ——
    这样 12 月看到「1月5日」会算成明年 1 月，而不是今年那个已经过去的 1 月。
    认不出返回空串（不猜），界面上留空让人补。 */
function idMatchDate(text, today) {
  const s = String(text || "");
  const base = today || store.todayStr();
  const rel = s.match(/今天|明天|后天|大后天/);
  if (rel) {
    const add = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }[rel[0]];
    return store.addDays(base, add);
  }
  // ⚠️ 正则里捕获到的月/日**可能已经带前导零**（`2026-01-12` 的 `01`）。
  // `pad2` 是数值版（`n < 10`），把字符串 "01" 传进去会被隐式转成 1 → 补成 "001"，
  // 于是 `2026-001-12` 这种坏日期就进了 due 字段。这里一律先 `Number()` 再 pad。
  let m = s.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return m[1] + "-" + pad2(Number(m[2])) + "-" + pad2(Number(m[3]));
  m = s.match(/(\d{1,2})[-/月](\d{1,2})日?/);
  if (m) {
    const mm = Number(m[1]), dd = Number(m[2]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const y = Number(base.slice(0, 4));
      let cand = y + "-" + pad2(mm) + "-" + pad2(dd);
      // 过去的太远 → 当明年
      if (dayDiff(base, cand) < -183) cand = (y + 1) + "-" + pad2(mm) + "-" + pad2(dd);
      return cand;
    }
  }
  return "";
}

/** 从文本里认时刻。数字与中文数字都认（「23:59」「下午3点」「下午三点」「晚上十点半」）。
    **必须校验范围**（时 0-23、分 0-59）——
    `25:99` 这种错值一旦写进 dueTime，宿主的提醒会静默失效，比不填更糟。
    上下午标记只取紧挨着的那一个：不扫全句，否则「上午发的文件，下午3点交」会按上午算。
    ⚠️ 与桌面端 public/plugins/inbox-drop/main.js 的 matchTime 保持同一规则。 */
function idMatchTime(text) {
  const s = String(text || "");
  const norm = (h, mi, mark) => {
    let hh = h;
    const pm = /下午|晚上|傍晚|中午/.test(mark || "");
    const am = /上午|早上|凌晨/.test(mark || "");
    if (pm && hh < 12) hh += 12;
    if (am && hh === 12) hh = 0;
    if (!(hh >= 0 && hh <= 23) || !(mi >= 0 && mi <= 59)) return "";
    return pad2(hh) + ":" + pad2(mi);
  };
  let m = s.match(/(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:[ap]\.?m\.?)?/i);
  if (m) return norm(Number(m[2]), Number(m[3]), m[1]);
  // 「X点」与「X时」同权（「下午3时30分」是正式通知的常见写法），与中文数字分支的 [点时] 对齐
  m = s.match(/(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*[点时]\s*(半|(\d{1,2})\s*分?)?/);
  if (m) return norm(Number(m[2]), m[3] === "半" ? 30 : Number(m[4] || 0), m[1]);
  // 中文数字：「下午三点」「晚上十点半」「中午十二点」
  const CN = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  m = s.match(/(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*(零|一|两|二|三|四|五|六|七|八|九|十[一二]?)\s*[点时]\s*(半|(\d{1,2})\s*分?)?/);
  if (m && CN[m[2]] !== undefined) return norm(CN[m[2]], m[3] === "半" ? 30 : Number(m[4] || 0), m[1]);
  return "";
}

/** 同一条消息的判据：标题一样，且时间差在 24 小时内。
    只比标题会比掉「同样的『考试通知』不同场次」；只比原文又容易被多一个空格的同一个文件骗过。 */
function idSameMessage(a, b) {
  if (!a || !b) return false;
  const ta = idTidy(a.title), tb = idTidy(b.title);
  if (!ta || ta !== tb) return false;
  const da = a.date || "", db = b.date || "";
  if (da !== db) return false;                    // 日期都认出来了就直接比日期
  const aa = Number(a.at) || 0, ab = Number(b.at) || 0;
  if (aa && ab && Math.abs(aa - ab) > ID_DUP_MS) return false;
  const ra = idTidy(a.raw).slice(0, 60), rb = idTidy(b.raw).slice(0, 60);
  return ra === rb || !ra || !rb;
}
function idIsDuplicate(list, msg) {
  return (Array.isArray(list) ? list : []).some((x) => idSameMessage(x, msg));
}

/** 把用户粘贴 / 手输的东西变成一条标准台账记录。
    ⚠️ 全部字段都补齐（哪怕空串），下游（视图、转任务）就不用到处判 undefined。 */
function idNormalizeDrop(raw, today) {
  const r = raw && typeof raw === "object" ? raw : {};
  const title = idTidy(r.title).slice(0, ID_TITLE_MAX) || idTitleOf(r.raw || "");
  const rawText = idTidy(r.raw).slice(0, ID_RAW_MAX) || title;
  const platform = r.platform != null ? String(r.platform) : idDetectPlatform(rawText + " " + title);
  const msgType = r.msgType != null ? String(r.msgType) : idDetectType(rawText + " " + title);
  const kind = ID_KINDS.some((k) => k.id === r.kind) ? r.kind : "text";
  return {
    id: r.id ? String(r.id) : ddUid("d"),
    seq: Number(r.seq) || 0,
    at: Number(r.at) || Date.now(),
    kind,
    title,
    raw: rawText,
    platform,
    msgType,
    // 用户显式给了空串（表示「我确认没有」）就尊重它，只有 undefined 才去猜
    date: r.date != null ? String(r.date) : idMatchDate(rawText + " " + title, today),
    time: r.time != null ? String(r.time) : idMatchTime(rawText + " " + title),
    source: r.source != null ? String(r.source) : idSourceOf(rawText, platform),
    fileSize: Number(r.fileSize) || 0,
    bin: typeof r.bin === "string" ? r.bin : "",
    done: r.done === "task" || r.done === "block" ? r.done : "",
    pinned: !!r.pinned,
  };
}
/** 读 storage 用：容错 + 排序（新在前、置顶更前）+ 上限裁剪。 */
function idDrops(raw, today) {
  let list = (Array.isArray(raw) ? raw : []).filter((x) => x && typeof x === "object").map((x) => idNormalizeDrop(x, today));
  // 置顶优先，其次按时间倒序；同一时刻用 seq 兜底，保证顺序稳定（不然每次进页面都跳）
  list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.at - a.at) || (b.seq - a.seq));
  if (list.length > ID_KEEP) {
    const keep = list.filter((x) => x.pinned || !x.done);
    const rest = list.filter((x) => !x.pinned && x.done).slice(0, Math.max(0, ID_KEEP - keep.length));
    const set = {};
    keep.concat(rest).forEach((x) => { set[x.id] = 1; });
    list = list.filter((x) => set[x.id]);
  }
  return list;
}
/** 统计。**每次从列表整个重算**，不做增量 —— 删条目 / 清空 / 改类型之后增量计数会飘。 */
function idStatsOf(list) {
  const s = { total: 0, open: 0, done: 0, pinned: 0, byKind: {}, byType: {}, byPlatform: {}, lastAt: 0 };
  (Array.isArray(list) ? list : []).forEach((d) => {
    s.total += 1;
    if (d.done) s.done += 1; else s.open += 1;
    if (d.pinned) s.pinned += 1;
    s.byKind[d.kind] = (s.byKind[d.kind] || 0) + 1;
    if (d.msgType) s.byType[d.msgType] = (s.byType[d.msgType] || 0) + 1;
    if (d.platform) s.byPlatform[d.platform] = (s.byPlatform[d.platform] || 0) + 1;
    if (d.at > s.lastAt) s.lastAt = d.at;
  });
  return s;
}
/** 台账里一条 → 收件箱条目的形状（与桌面端 toInboxItem 对齐）。 */
function idToInboxItem(d) {
  return {
    id: d.id,
    title: d.title,
    source: d.source || idPlatformLabel(d.platform) || "拖入消息收纳",
    when: [d.date, d.time].filter(Boolean).join(" "),
    note: d.raw && d.raw !== d.title ? d.raw.slice(0, 160) : "",
    date: d.date || null,
    time: d.time || null,
    msgType: d.msgType || null,
    platform: d.platform || null,
    sourcePlugin: "inbox-drop",
    suggestion: d.msgType === "chat" ? "none" : "create-task",
    kind: d.kind,
    dupKey: "inbox-drop:" + d.id,
  };
}
/** 台账里一条 → store.addTask 的 patch（与桌面端 toTaskPatch 对齐）。
    象限与分类来自类型表；日期认出来了才有 due，不然留空由用户自己定。 */
function idToTaskPatch(d) {
  const meta = idTypeMeta(d.msgType);
  return {
    title: d.title.slice(0, 60) || "新任务",
    note: d.raw && d.raw !== d.title ? d.raw.slice(0, 500) : "",
    quad: meta ? meta.quad : 1,
    estMin: 30,
    tags: ["收纳", idTypeLabel(d.msgType) || idKindLabel(d.kind) || "文字"].filter(Boolean),
    project: "拖入消息收纳",
    due: d.date || null,
    dueTime: d.time || "23:59",
  };
}

/** 页面入口：读 store → 视图模型。
    纯读，不写 —— 小程序端没有「确认条」那一步，收纳是用户按按钮触发的，
    所以这里不存在桌面端那种「迁移后必须立刻落盘」的需求。 */
function inboxDropSummary(today) {
  today = today || store.todayStr();
  const drops = idDrops(store.pluginStorageGet("inbox-drop", "drops", null), today);
  const stats = idStatsOf(drops);
  const kindCounts = ID_KINDS.map((k) => ({ id: k.id, label: k.label, n: stats.byKind[k.id] || 0 }));
  return {
    drops: drops.map((d) => ({
      id: d.id,
      seq: d.seq,
      seqLabel: d.seq ? "#" + d.seq : "",
      kind: d.kind,
      kindLabel: idKindLabel(d.kind),
      title: d.title,
      raw: d.raw,
      when: [d.date, d.time].filter(Boolean).join(" "),
      date: d.date,
      time: d.time,
      platform: d.platform,
      platformLabel: idPlatformLabel(d.platform),
      typeLabel: idTypeLabel(d.msgType),
      source: d.source,
      sizeLabel: d.fileSize ? durationSize(d.fileSize) : "",
      done: d.done,
      doneLabel: d.done === "task" ? "已成任务" : (d.done === "block" ? "已排日程" : ""),
      pinned: d.pinned,
      hasThumb: !!d.bin,
      atText: idRelTime(d.at, Date.now()),
    })),
    stats: { total: stats.total, open: stats.open, done: stats.done, pinned: stats.pinned },
    kindCounts,
    empty: !drops.length,
    canClearDone: stats.done > 0,
  };
}

/** 收纳一条（手输 / 粘贴的文本）。返回新的 drops 数组，页面写回 storage。
    `storedSeq` 是存储里的 seq 键（桌面端同款）：台账被上限裁剪过后，台账内的最大 seq
    会比存储里的 seq 小，只用台账算就会重号 —— 所以取两者较大值再 +1。
    与桌面端一致：认不出任何时间信息也**照样收**，只是不自动递进收件箱。 */
function idAddDrops(list, input, today, storedSeq) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const msg = idNormalizeDrop(input, today);
  if (!msg.title || msg.title === "（无标题）") return { list: arr, added: false, duplicated: false };
  if (idIsDuplicate(arr, msg)) return { list: arr, added: false, duplicated: true };
  // seq 是给人看的序号（#1、#2…），不复用 0；存储里的 seq 与台账最大值取较大者
  const maxSeq = arr.reduce((m, x) => Math.max(m, Number(x.seq) || 0), Number(storedSeq) || 0);
  msg.seq = maxSeq + 1;
  msg.at = Date.now();
  return { list: idDrops([msg].concat(arr), today), added: true, duplicated: false, row: msg };
}

/** 页面用的整包读取：drops + seq 一起读。seq 的语义见 idAddDrops。 */
function idLoadAll() {
  const list = idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
  const storedSeq = Number(store.pluginStorageGet("inbox-drop", "seq", 0)) || 0;
  return { list, seq: Math.max(storedSeq, list.reduce((m, d) => Math.max(m, Number(d.seq) || 0), 0)) };
}

/** 字节数 → 人看的短标签。`Math.round` 到一位小数就够，别显示 `184320.0 B`。 */
function durationSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}
/** 相对时间。刚收的显示「刚刚」，比绝对时间戳好读。 */
function idRelTime(at, now) {
  const diff = Math.max(0, (Number(now) || Date.now()) - (Number(at) || 0));
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " 小时前";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " 天前";
  return new Date(Number(at)).toLocaleDateString ? fmtDay(Number(at)) : "";
}
function fmtDay(ms) {
  const d = new Date(ms);
  return d.getMonth() + 1 + "月" + d.getDate() + "日";
}

module.exports = {
  weeklyReport, holidaySummary, futureExams, pastExamGroups, examFlow, EXAM_FILTERS, durationLabel, dayDiff,
  dormDutySummary, ddSummaryFrom, ddSnapshot, ddReminderDue, ddDueReminders, ddMarkNotified, ddPeriodLabel,
  ddDefaultConfig, ddNormalizeConfig, ddNormalizeTime, ddMembers, ddPeriod,
  ddDefaultGroup, ddNormalizeGroup, ddGroups, ddMigrateLegacy, ddActiveId,
  ddLocationAt, ddGroupAddLocation, ddGroupMoveLocation, ddGroupRemoveLocation,
  ddCycleStartOf, ddCycleIndexAt, ddIsCycleStartDay, ddAssigneeFor, ddNormalFor, ddOverrideHit, ddMembersInDateOrder,
  ddWithGroup, ddGroupPatch, ddGroupAddMember, ddGroupRenameMember, ddGroupMoveMember, ddGroupMoveMemberTo,
  ddGroupRemoveMember, ddGroupRestoreMember, ddGroupSetOverride, ddAddGroup, ddRemoveGroup,
  ddDuplicateGroup, ddImportMembers, ddCopyName,
  DD_PERIODS, DD_UPCOMING, DD_REMOVED_KEEP, DD_GROUP_MAX, DD_NAME_MAX,

  // 拖入消息收纳（inbox-drop）
  inboxDropSummary, idAddDrops, idLoadAll, idDrops, idStatsOf, idNormalizeDrop,
  idDetectPlatform, idDetectType, idSourceOf, idTitleOf, idMatchDate, idMatchTime,
  idSameMessage, idIsDuplicate, idToInboxItem, idToTaskPatch,
  idPlatformLabel, idTypeLabel, idKindLabel, idTypeMeta,
  ID_PLATFORMS, ID_TYPES, ID_KINDS, ID_KEEP, ID_TITLE_MAX, ID_RAW_MAX, ID_DUP_MS,
};
