// 微信小程序原生插件适配层：只放纯数据逻辑，页面负责交互。
const store = require("../store.js");
const holidayData = require("../pluginData/holiday.js");
const examData = require("../pluginData/exams.js");

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

module.exports = { store, holidayData, examData, WEEK_CN, CAT_LABEL, pad2, dateMs, dayDiff, weekday, durationLabel };
