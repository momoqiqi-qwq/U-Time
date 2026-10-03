const { store, holidayData, examData, WEEK_CN, CAT_LABEL, pad2, dateMs, dayDiff, weekday, durationLabel } = require("./common.js");
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


module.exports = { futureExams, pastExamGroups, examFlow, EXAM_FILTERS };
