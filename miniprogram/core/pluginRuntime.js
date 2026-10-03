// 小程序插件业务入口：按插件拆分，保留原有公开函数与备份契约。
module.exports = {
  ...require("./plugins/reports.js"),
  ...require("./plugins/exams.js"),
  ...require("./plugins/dormDuty.js"),
  ...require("./plugins/inboxDrop.js"),
  dayDiff: require("./plugins/common.js").dayDiff,
  durationLabel: require("./plugins/common.js").durationLabel,
};
