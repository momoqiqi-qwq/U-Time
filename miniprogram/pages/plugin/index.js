const store = require("../../core/store.js");
const routes = require("../../core/pluginRoutes.js");
const catalog = require("../../core/pluginCatalog.js");
const runtime = require("../../core/pluginRuntime.js");
const timeParser = require("../../core/timeParser.js");
const net = require("../../core/pluginNet.js");
const cxCore = require("../../core/chaoxingCore.js");

const POMO_MODES = [
  { id: "focus", label: "专注 25", min: 25 },
  { id: "short", label: "短休 5", min: 5 },
  { id: "long", label: "长休 15", min: 15 },
];

/* 学习通分类（中文，来自 chaoxingCore.classify）→ ASCII 类名后缀。
   WXSS 的选择器标识符不允许非 ASCII：`.cat-考试` 会被编译器切碎成非法字节，
   上传时整个包被拒（`unexpected \`�\` at pos ...`，v0.40.0 实测）。
   中文继续作为文本渲染，只有 class 走这里映射。 */
const CX_CAT_CLS = { "考试": "exam", "作业": "work", "签到": "checkin", "通知": "notice" };

/* 插件使用说明：分组与使用步骤与桌面端 plugin-guide/main.js 同源 */
const GUIDE_GROUPS = [
  { name: "学习与校园", ids: ["shiguang-schedule", "school-notice", "chaoxing-notify", "cppu-notify", "exam-calendar"] },
  { name: "效率与专注", ids: ["pomodoro", "weekly-report"] },
  { name: "信息与提醒", ids: ["rss-reader", "gx-news", "cn-holiday", "wechat-push"] },
  { name: "生活与工具", ids: ["dorm-duty", "web-collector", "inbox-drop"] },
];
const GUIDE_DOCS = {
  "shiguang-schedule": ["小程序提供原生周课表、今日课程、多课表与课程编辑", "导入桌面 JSON 或教务 CSV/TSV/HTML，先解析预览再确认；Excel 请先转 CSV", "可导出 JSON/ICS 并将本周课程加入时间块；教务网页登录与 OCR 仍需桌面或 Android"],
  "school-notice": ["填写学校通知/公告网址并检测", "公开网站可直接同步；需登录时填写登录信息", "图片验证码需要本人查看后手动输入"],
  "chaoxing-notify": ["使用账号密码或 Cookie 登录学习通", "同步通知并查看完整正文", "识别到截止时间后可转为 Le 提醒"],
  "cppu-notify": ["打开插件进入智慧警大登录流程", "手动输入验证码完成 SSO 登录", "筛选通知并按需转成提醒"],
  "exam-calendar": ["选择考试类别或时间范围", "查看考试节点和来源说明", "把需要关注的日期加入计划"],
  "pomodoro": ["选择预设时间或输入自定义倒计时", "选择已有任务，或直接新建一个专注任务", "开始计时；完成后自动累计专注统计"],
  "weekly-report": ["打开后自动读取任务与时间块", "查看每天投入、分类占比和完成情况", "用周报复盘下一周安排"],
  "gx-news": ["设置竞赛关键词和筛选条件", "刷新获取竞赛通知", "重要消息可直接转成提醒", "切换竞赛源与自定义源需在桌面端使用（微信只放行了摩课云一个域名）"],
  "rss-reader": ["添加订阅并选择过滤条件，支持未读、星标与转任务", "可以导入 RSS/Atom XML 或桌面缓存，刷新需要 HTTPS 与微信合法域名配置", "联网只在主动刷新时发生；原文链接可复制到浏览器阅读"],
  "cn-holiday": ["打开即可优先读取本地节假日数据", "需要最新调整时再手动联网更新", "用于课程、计划和休息日判断"],
  "wechat-push": ["按插件页面配置 PushPlus / 推送参数", "选择需要推送的提醒", "先测试连接，再开启日常使用"],
  "web-collector": ["输入网址和名称进行收藏，可搜索、编辑备注和导入桌面收藏", "小程序复制原文链接后在浏览器打开；不自动抓取任意网站，也不保证网页内嵌"],
  "dorm-duty": ["一个插件里可放多套轮换（宿舍值日 / 公区卫生…），各有自己的成员、周期与提醒时刻，互不影响", "选中一套轮换后按顺序添加成员，第一个人先当班；设好起始日期与轮换周期（每天 / 每周 / 自定义 N 天）", "在「地点轮换」里添加地点并设置每多少天换一次；地点和成员从同一起始日分别计时，可有不同周期", "需要时给某一轮临时换人；到点会提醒当班的人和当天地点，也可一键加入今日任务", "点标签后面的「⋯」可以改名、删除，或把整套轮换连成员带规则复制一份，也能从别的轮换按名字导入成员，不用重打一遍名字"],
  "inbox-drop": ["小程序没有系统级拖放，用「粘贴消息」把聊天里的通知复制进来，或直接手输一句话", "插件会自动认出来源平台、消息类型和其中的日期时间，认错了可以改", "确认无误后收纳；需要动起来的点「建任务」，会带着象限和截止时间进任务表", "收纳记录与桌面端共用一份存储，桌面拖进来的消息在这里也能看到"],
};

/* 微信推送：时间块提前分钟选项（与桌面端 wechat-push 一致） */
const PUSH_LEADS = [3, 5, 10, 15, 30];

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function secText(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  return pad2(Math.floor(sec / 60)) + ":" + pad2(sec % 60);
}
function normalizeTime(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? pad2(+m[1]) + ":" + m[2] : "09:00";
}

/* 番茄自定义时长：以「秒」为唯一事实源（storage 键 customSec），分 / 秒两个输入框只是它的两种视图。 */
const CUSTOM_MAX_SEC = 240 * 60;
function clampCustomSec(min, sec) {
  const total = Math.round((Number(min) || 0) * 60 + (Number(sec) || 0));
  return Math.max(1, Math.min(CUSTOM_MAX_SEC, total));
}
/** 老数据只存了 customMin（分钟，可能是 1.5 这种小数），读不到 customSec 时按分钟换算。 */
function readCustomSec() {
  const savedSec = store.pluginStorageGet("pomodoro", "customSec", null);
  if (savedSec !== null && savedSec !== undefined && Number.isFinite(Number(savedSec))) {
    return Math.max(1, Math.min(CUSTOM_MAX_SEC, Math.round(Number(savedSec))));
  }
  return clampCustomSec(Number(store.pluginStorageGet("pomodoro", "customMin", 25)) || 25, 0);
}

Page({
  data: {
    id: "",
    plugin: null,
    pomodoro: null,
    weekly: null,
    holiday: null,
    dd: null,
    exams: [],
    examFilters: runtime.EXAM_FILTERS || [],
    examFilterIndex: 0,
    examFlow: null,
    examTotal: 0,
    examVisible: 0,
    examQuery: "",
    examConfirmedOnly: false,
    examPast: [],
    examPastTotal: 0,
    examPastOpen: false,
    guide: null,
    push: null,
    gx: null,
    cx: null,
  },

  onLoad(options) {
    const id = decodeURIComponent((options && options.id) || "");
    const plugin = catalog.byId[id];
    if (Object.prototype.hasOwnProperty.call(routes.SPECIAL,id) && plugin && plugin.platforms && plugin.platforms.miniprogram === "native") {
      if (routes.enabled(id)) wx.redirectTo({ url: routes.route(id) });
      return;
    }
    if (!plugin || !plugin.platforms || plugin.platforms.miniprogram !== "native") {
      wx.showToast({ title: "这个插件没有小程序适配", icon: "none" });
      setTimeout(() => wx.navigateBack(), 300);
      return;
    }
    if (!store.isPluginEnabled(id)) {
      wx.showToast({ title: "插件已停用", icon: "none" });
      setTimeout(() => wx.navigateBack(), 300);
      return;
    }
    this.setData({ id, plugin: { ...plugin, iconPath: `/images/plugins/${plugin.id}.png` } });
    wx.setNavigationBarTitle({ title: plugin.name });
    this.initPlugin(id);
  },

  onShow() {
    if (this.data.id === "weekly-report") this.loadWeekly();
    // 轮换值日：跨天 / 到点后回到本页都要重算（提醒判据也在这里，见 loadDormDuty）
    if (this.data.id === "dorm-duty" && this.data.dd) this.loadDormDuty();
    if (this.data.id === "pomodoro" && this._pomoReady) this.restorePomodoro();
    if (this.data.id === "wechat-push" && this._push) { this.pushTick(); this.startPushTimer(); }
    // 收纳区可能被桌面端改了（共用一份存储），回到本页重读一次
    if (this.data.id === "inbox-drop" && this.data.dropsWrap) this.loadInboxDrop();
  },

  onHide() { this.stopTickOnly(); this.stopPushTimer(); },
  onUnload() { this.stopTickOnly(); this.stopPushTimer(); },

  initPlugin(id) {
    if (id === "pomodoro") this.loadPomodoro();
    else if (id === "weekly-report") this.loadWeekly();
    else if (id === "cn-holiday") this.loadHoliday();
    else if (id === "dorm-duty") this.loadDormDuty();
    else if (id === "exam-calendar") this.loadExams();
    else if (id === "plugin-guide") this.loadGuide();
    else if (id === "wechat-push") this.loadPush();
    else if (id === "gx-news") this.loadGx();
    else if (id === "chaoxing-notify") this.loadCx();
    else if (id === "inbox-drop") this.loadInboxDrop();
  },

  /* ── 番茄专注 ── */
  loadPomodoro() {
    const tasks = [{ id: "", title: "（不关联任务）" }].concat(
      (store.getState().tasks || []).filter((t) => !t.done).map((t) => ({ id: t.id, title: t.title }))
    );
    const rt = store.pluginStorageGet("pomodoro", "timerRuntimeMini", null) || {};
    const customSec = readCustomSec();
    this._customSec = customSec;
    const modes = POMO_MODES.concat([{ id: "custom", label: "自定义", min: customSec / 60 }]);
    const mode = modes.find((m) => m.id === rt.modeId) || POMO_MODES[0];
    const taskIndex = Math.max(0, tasks.findIndex((t) => t.id === (rt.taskId || "")));
    const left = Number.isFinite(Number(rt.left)) ? Number(rt.left) : mode.min * 60;
    this._pomo = { mode, left, running: !!rt.running, endAt: Number(rt.endAt) || 0, taskId: tasks[taskIndex].id };
    this._pomoReady = true;
    this.setData({
      pomodoro: {
        modes: modes.map((m) => ({ id: m.id, label: m.label, active: m.id === mode.id })),
        customMinPart: Math.floor(customSec / 60), customSecPart: customSec % 60,
        newTaskTitle: "",
        timeText: secText(left),
        running: !!rt.running,
        tasks,
        taskIndex,
        doneCount: Number(store.pluginStorageGet("pomodoro", "doneCount", 0)) || 0,
        focusMin: Number(store.pluginStorageGet("pomodoro", "focusMin", 0)) || 0,
      },
    });
    this.restorePomodoro();
  },

  restorePomodoro() {
    if (!this._pomo) return;
    const rt = store.pluginStorageGet("pomodoro", "timerRuntimeMini", null) || {};
    if (rt.modeId) {
      const customSec = readCustomSec();
      this._customSec = customSec;
      const mode = POMO_MODES.concat([{ id: "custom", label: "自定义", min: customSec / 60 }]).find((m) => m.id === rt.modeId) || this._pomo.mode;
      this._pomo.mode = mode;
      this._pomo.taskId = rt.taskId || "";
      this._pomo.running = !!rt.running;
      this._pomo.endAt = Number(rt.endAt) || 0;
      this._pomo.left = Number(rt.left) || mode.min * 60;
    }
    if (this._pomo.running) {
      this._pomo.left = Math.max(0, Math.ceil((this._pomo.endAt - Date.now()) / 1000));
      if (this._pomo.left <= 0) {
        this.finishPomodoro();
        return;
      }
      this.startTickOnly();
    }
    this.paintPomodoro();
  },

  persistPomodoro() {
    if (!this._pomo) return;
    store.pluginStorageSet("pomodoro", "timerRuntimeMini", {
      modeId: this._pomo.mode.id,
      left: this._pomo.left,
      running: this._pomo.running,
      endAt: this._pomo.endAt,
      taskId: this._pomo.taskId || "",
    });
  },

  paintPomodoro() {
    if (!this._pomo || !this.data.pomodoro) return;
    this.setData({
      "pomodoro.timeText": secText(this._pomo.left),
      "pomodoro.running": this._pomo.running,
      "pomodoro.modes": POMO_MODES.concat([{ id: "custom", label: "自定义", min: (this._customSec || 1500) / 60 }]).map((m) => ({ id: m.id, label: m.label, active: m.id === this._pomo.mode.id })),
    });
  },

  startTickOnly() {
    this.stopTickOnly();
    if (!this._pomo || !this._pomo.running) return;
    this._tickTimer = setInterval(() => {
      if (!this._pomo || !this._pomo.running) return;
      this._pomo.left = Math.max(0, Math.ceil((this._pomo.endAt - Date.now()) / 1000));
      this.paintPomodoro();
      if (this._pomo.left <= 0) this.finishPomodoro();
    }, 1000);
  },

  stopTickOnly() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = null;
  },

  onPomoMode(e) {
    const id = e.currentTarget.dataset.id;
    const mode = POMO_MODES.concat([{ id: "custom", label: "自定义", min: (this._customSec || 1500) / 60 }]).find((m) => m.id === id);
    if (!mode || !this._pomo) return;
    this.stopTickOnly();
    this._pomo.mode = mode;
    this._pomo.left = mode.min * 60;
    this._pomo.running = false;
    this._pomo.endAt = 0;
    this.persistPomodoro();
    this.paintPomodoro();
  },

  onPomoCustomMinInput(e) { this.setData({ "pomodoro.customMinPart": e.detail.value }); },
  onPomoCustomSecInput(e) { this.setData({ "pomodoro.customSecPart": e.detail.value }); },
  onPomoSetCustom() {
    if (!this._pomo) return;
    const sec = clampCustomSec(this.data.pomodoro.customMinPart, this.data.pomodoro.customSecPart);
    this._customSec = sec;
    store.pluginStorageSet("pomodoro", "customSec", sec);
    // 两个输入框回填归一化后的值：填 90 秒会被进位成 1 分 30 秒。
    this.setData({ "pomodoro.customMinPart": Math.floor(sec / 60), "pomodoro.customSecPart": sec % 60 });
    this.stopTickOnly(); this._pomo.mode = { id: "custom", label: "自定义", min: sec / 60 }; this._pomo.left = sec; this._pomo.running = false; this._pomo.endAt = 0;
    this.persistPomodoro(); this.paintPomodoro();
  },
  onPomoNewTaskInput(e) { this.setData({ "pomodoro.newTaskTitle": e.detail.value }); },
  onPomoAddTask() {
    const title = String(this.data.pomodoro.newTaskTitle || "").trim();
    if (!title) return wx.showToast({ title: "请先输入任务名称", icon: "none" });
    const task = store.addTask({ title, quad: 2, estMin: this._pomo.mode.min, tags: ["番茄专注"] });
    const tasks = [{ id: "", title: "（不关联任务）" }].concat((store.getState().tasks || []).filter(t => !t.done).map(t => ({ id:t.id, title:t.title })));
    const taskIndex = Math.max(0, tasks.findIndex(t => t.id === task.id)); this._pomo.taskId = task.id;
    this.setData({ "pomodoro.tasks": tasks, "pomodoro.taskIndex": taskIndex, "pomodoro.newTaskTitle": "" }); this.persistPomodoro();
    wx.showToast({ title: "任务已创建", icon: "success" });
  },

  onPomoTask(e) {
    if (!this._pomo || !this.data.pomodoro) return;
    const index = Number(e.detail.value) || 0;
    const task = this.data.pomodoro.tasks[index] || this.data.pomodoro.tasks[0];
    this._pomo.taskId = task.id;
    this.setData({ "pomodoro.taskIndex": index });
    this.persistPomodoro();
  },

  onPomoToggle() {
    if (!this._pomo) return;
    if (this._pomo.running) {
      this._pomo.left = Math.max(0, Math.ceil((this._pomo.endAt - Date.now()) / 1000));
      this._pomo.running = false;
      this._pomo.endAt = 0;
      this.stopTickOnly();
    } else {
      if (this._pomo.left <= 0) this._pomo.left = this._pomo.mode.min * 60;
      this._pomo.running = true;
      this._pomo.endAt = Date.now() + this._pomo.left * 1000;
      this.startTickOnly();
    }
    this.persistPomodoro();
    this.paintPomodoro();
  },

  onPomoReset() {
    if (!this._pomo) return;
    this.stopTickOnly();
    this._pomo.running = false;
    this._pomo.endAt = 0;
    this._pomo.left = this._pomo.mode.min * 60;
    this.persistPomodoro();
    this.paintPomodoro();
  },

  finishPomodoro() {
    if (!this._pomo) return;
    const focus = this._pomo.mode.id === "focus" || this._pomo.mode.id === "custom";
    this.stopTickOnly();
    this._pomo.left = 0;
    this._pomo.running = false;
    this._pomo.endAt = 0;
    this.persistPomodoro();
    if (focus) {
      const done = (Number(store.pluginStorageGet("pomodoro", "doneCount", 0)) || 0) + 1;
      // 自定义时长可能是 30 秒这种，累加会产生 0.30000000000000004，收敛到 1 位小数。
      const mins = Math.round(((Number(store.pluginStorageGet("pomodoro", "focusMin", 0)) || 0) + this._pomo.mode.min) * 10) / 10;
      store.pluginStorageSet("pomodoro", "doneCount", done);
      store.pluginStorageSet("pomodoro", "focusMin", mins);
      this.setData({ "pomodoro.doneCount": done, "pomodoro.focusMin": mins });
    }
    this.paintPomodoro();
    try { wx.vibrateShort({ type: "medium" }); } catch (e) { /* ignore */ }
    wx.showModal({ title: focus ? "完成 1 个番茄" : "休息结束", content: focus ? "专注记录已写入插件统计。" : "可以开始下一轮专注了。", showCancel: false });
  },

  /* ── 周度报告 ── */
  loadWeekly() { this.setData({ weekly: runtime.weeklyReport() }); },

  /* ── 中国节假日 ── */
  loadHoliday() { this.setData({ holiday: runtime.holidaySummary() }); },

  ...require("./dormDuty.js"),

  /* ── 考试日历 ── */
  loadExams() {
    const filters = runtime.EXAM_FILTERS || [];
    let filterIndex = Number(store.pluginStorageGet("exam-calendar", "filterIndex", 0)) || 0;
    if (filterIndex < 0 || filterIndex >= filters.length) filterIndex = 0;
    const filterId = filters[filterIndex] ? filters[filterIndex].id : "all";
    const today = store.todayStr();

    const all = runtime.futureExams(today, 60, filterId).map((x) =>
      Object.assign({}, x, { scheduled: this.isExamScheduled(x) })
    );
    this._examAll = all;
    this._examMap = {};
    all.forEach((x) => { this._examMap[x.key] = x; });

    const past = runtime.pastExamGroups(today, filterId);
    this.setData({
      examFilters: filters,
      examFilterIndex: filterIndex,
      examFlow: runtime.examFlow(today, filterId),
      examTotal: all.length,
      examPast: past.groups,
      examPastTotal: past.total,
      examConfirmedOnly: !!this._examConfirmedOnly,
      examPastOpen: !!this._examPastOpen,
    }, () => this.applyExamFilter());
  },

  isExamScheduled(ev) {
    const title = ev.name + "（" + ev.typeName + "）";
    return store.blocksOf(ev.date).some((b) => b.title === title);
  },

  /* 搜索与「只看官方」只切显隐、不重新拉数据，避免输入框失焦 */
  applyExamFilter() {
    const q = String(this._examQuery || "").trim().toLowerCase();
    const only = !!this._examConfirmedOnly;
    const all = this._examAll || [];
    const shown = all.filter((x) => {
      if (only && !x.confirmed) return false;
      if (q && (x.name + " " + x.category + " " + x.typeName).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    this.setData({ exams: shown, examVisible: shown.length, examQuery: this._examQuery || "" });
  },

  onExamSearch(e) {
    this._examQuery = (e.detail && e.detail.value) || "";
    this.applyExamFilter();
  },

  onToggleExamConfirmed() {
    this._examConfirmedOnly = !this._examConfirmedOnly;
    this.setData({ examConfirmedOnly: this._examConfirmedOnly }, () => this.applyExamFilter());
  },

  onToggleExamHistory() {
    this._examPastOpen = !this._examPastOpen;
    this.setData({ examPastOpen: this._examPastOpen });
  },

  onExamFilter(e) {
    const index = Number(e.detail.value) || 0;
    store.pluginStorageSet("exam-calendar", "filterIndex", index);
    this.loadExams();
  },

  onExamFullFlow(e) {
    const ev = this._examMap && this._examMap[e.currentTarget.dataset.key];
    if (!ev) return;
    let target = ev.examId;
    if (target === "cet-set4") target = "cet4";
    if (target === "cet-set6") target = "cet6";
    const filters = runtime.EXAM_FILTERS || [];
    const index = filters.findIndex((x) => x.id === target);
    if (index < 0) {
      wx.showToast({ title: "该项目暂不支持独立全流程筛选", icon: "none" });
      return;
    }
    // 再点一次同一个项目 → 回到全部考试
    const next = this.data.examFilterIndex === index ? 0 : index;
    store.pluginStorageSet("exam-calendar", "filterIndex", next);
    this.loadExams();
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  onOpenExamSignup() {
    const flow = this.data.examFlow;
    if (!flow || !flow.signupUrl) return;
    wx.setClipboardData({ data: flow.signupUrl, success: () => wx.showToast({ title: "报名网址已复制", icon: "none" }) });
  },

  examDays(ev) {
    const out = [];
    const n = runtime.dayDiff(ev.date, ev.endDate || ev.date);
    for (let i = 0; i <= n; i++) out.push(store.addDays(ev.date, i));
    return out;
  },

  /* 时长口径与桌面端一致：有起止时间就用实际时长，否则按类型给默认值 */
  examDuration(ev) {
    if (ev.startTime && ev.endTime) {
      const d = store.mmOf(normalizeTime(ev.endTime)) - store.mmOf(normalizeTime(ev.startTime));
      if (d > 0) return d;
    }
    return ev.type === "written" ? 150 : 60;
  },

  onAddExam(e) {
    const ev = this._examMap && this._examMap[e.currentTarget.dataset.key];
    if (!ev) return;
    const title = ev.name + "（" + ev.typeName + "）";
    // 跨日考试（NCRE 连考 3 天、教资 2 天）整个区间都要排上，只排第一天会让后续几天凭空消失
    const days = this.examDays(ev);
    if (days.some((d) => store.blocksOf(d).some((b) => b.title === title))) {
      wx.showToast({ title: "这场考试已经排进日程", icon: "none" });
      return;
    }
    const dur = this.examDuration(ev);
    const task = store.addTask({
      title,
      note: (ev.confirmed ? "官方公告已确认" : "规则推算，待官方公告确认") + (ev.url ? "\n" + ev.url : ""),
      quad: timeParser.guessQuad(ev.date),
      estMin: dur,
      tags: ["考试"],
      project: "考试日历",
      due: ev.endDate || ev.date,
    });
    const start = normalizeTime(ev.startTime || "09:00");
    days.forEach((d) => {
      store.addBlock({ date: d, start, durMin: dur, title, taskId: task.id, cat: "study" });
    });
    wx.showToast({ title: days.length > 1 ? "已排进连续 " + days.length + " 天" : "已排进日程", icon: "success" });
    this._examAll = (this._examAll || []).map((x) => (x.key === ev.key ? Object.assign({}, x, { scheduled: true }) : x));
    this._examMap[ev.key] = Object.assign({}, ev, { scheduled: true });
    this.applyExamFilter();
  },

  onCopyExamLink(e) {
    const ev = this._examMap && this._examMap[e.currentTarget.dataset.key];
    if (!ev || !ev.url) return;
    wx.setClipboardData({ data: ev.url });
  },

  /* ════ 拖入消息收纳（inbox-drop）════
     小程序没有系统级拖放 / 剪贴板读图，这里的入口是「粘贴或手输一段消息文本」。
     纯识别逻辑全在 runtime 里（与桌面端同名表），页面只负责「读 storage → 算 → 写回 → 渲染」。 */

  loadInboxDrop() {
    const sum = runtime.inboxDropSummary(store.todayStr());
    this._idDrops = sum.drops;
    this.setData({
      dropsWrap: sum,
      idInput: this.data.idInput || "",
      idEdit: this._idEdit || null,
    });
  },

  onIdInput(e) { this.setData({ idInput: e.detail.value }); },

  /** 粘贴按钮：不能直接读剪贴板文本（wx.getClipboardData 会弹系统提示，体验割裂），
      所以用 textarea 承接 —— 用户长按粘贴，这里只负责把已粘贴的内容收下来。
      真正「一键粘」走 wx.getClipboardData，失败（用户拒绝授权）就提示去 textarea 手动粘。 */
  onIdPaste() {
    wx.getClipboardData({
      success: (res) => {
        const t = String(res.data || "").trim();
        if (!t) { wx.showToast({ title: "剪贴板是空的", icon: "none" }); return; }
        this.setData({ idInput: t });
        wx.showToast({ title: "已读入剪贴板内容", icon: "none" });
      },
      fail: () => wx.showToast({ title: "读不到剪贴板，请手动粘贴到输入框", icon: "none" }),
    });
  },

  /** 收纳：跑纯逻辑 → 落盘 → 重读渲染。识别错的字段用户可以在下面改。 */
  onIdAdd() {
    const text = String(this.data.idInput || "").trim();
    if (!text) { wx.showToast({ title: "先粘贴或输入一条消息", icon: "none" }); return; }
    // drops + seq 一起读（idLoadAll）：台账被上限裁剪后，只看台账最大 seq 会重号
    const { list: cur, seq } = runtime.idLoadAll();
    const out = runtime.idAddDrops(cur, { raw: text }, store.todayStr(), seq);
    if (out.duplicated) { wx.showToast({ title: "这条已经收过了", icon: "none" }); return; }
    if (!out.added) { wx.showToast({ title: "没读到可收纳的内容", icon: "none" }); return; }
    store.pluginStorageSet("inbox-drop", "drops", out.list);
    store.pluginStorageSet("inbox-drop", "seq", Math.max(seq, out.row.seq));
    this.setData({ idInput: "" });
    this.loadInboxDrop();
    const r = out.row;
    const bits = [runtime.idPlatformLabel(r.platform), runtime.idTypeLabel(r.msgType)].filter(Boolean).join(" · ");
    wx.showToast({ title: bits ? "已收纳 · " + bits : "已收纳", icon: "none" });
  },

  /** 抽屉里改某一条（标题 / 日期 / 时间 / 平台 / 类型）。改完重新算一遍去重键 —— 
      runtime 里没有「编辑」函数，因为编辑只是 patch + 重新规范化，放页面里更直接。 */
  onIdEdit(e) { this._idEdit = e.currentTarget.dataset.id; this.setData({ idEdit: this._idEdit }); },
  onIdEditCancel() { this._idEdit = null; this.setData({ idEdit: null }); },
  onIdEditInput(e) {
    const f = e.currentTarget.dataset.f;
    const patch = {}; patch[f] = e.detail.value;
    this._idPatch = Object.assign(this._idPatch || {}, patch);
  },
  onIdEditSave() {
    const id = this._idEdit;
    if (!id) return;
    const cur = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
    const list = cur.map((d) => (d.id === id ? runtime.idNormalizeDrop(Object.assign({}, d, this._idPatch || {}), store.todayStr()) : d));
    store.pluginStorageSet("inbox-drop", "drops", list);
    this._idEdit = null; this._idPatch = null;
    this.setData({ idEdit: null });
    this.loadInboxDrop();
    wx.showToast({ title: "已修改", icon: "success" });
  },

  /** 建任务：象限与分类来自类型表，due 来自识别到的日期。 */
  onIdTask(e) {
    const id = e.currentTarget.dataset.id;
    const d = (this._idDrops || []).find((x) => x.id === id);
    if (!d) return;
    // 已经在台账里标过 done 的不重复建 —— 这个标记就是为跨端去重留的
    if (d.done === "task") { wx.showToast({ title: "这条已经建过任务了", icon: "none" }); return; }
    const src = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr()).find((x) => x.id === id);
    if (!src) return;
    store.addTask(runtime.idToTaskPatch(src));
    this._idMarkDone(id, "task");
    wx.showToast({ title: "已加入任务表", icon: "success" });
  },

  /** 排日程：认得出时刻的排到那个点，认不出的排当天 09:00 一小时。 */
  onIdBlock(e) {
    const id = e.currentTarget.dataset.id;
    const all = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
    const d = all.find((x) => x.id === id);
    if (!d) return;
    if (!d.date) { wx.showToast({ title: "这条没识别到日期，先改一下再排", icon: "none" }); return; }
    if (d.done === "block") { wx.showToast({ title: "这条已经排过了", icon: "none" }); return; }
    const meta = runtime.idTypeMeta(d.msgType);
    store.addBlock({
      date: d.date,
      start: d.time || "09:00",
      durMin: 60,
      title: d.title.slice(0, 40),
      cat: meta ? meta.cat : "life",
    });
    this._idMarkDone(id, "block");
    wx.showToast({ title: "已排进时间块", icon: "success" });
  },

  _idMarkDone(id, kind) {
    const all = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
    store.pluginStorageSet("inbox-drop", "drops", all.map((d) => (d.id === id ? Object.assign({}, d, { done: kind }) : d)));
    this.loadInboxDrop();
  },

  onIdReopen(e) {
    const id = e.currentTarget.dataset.id;
    const all = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
    store.pluginStorageSet("inbox-drop", "drops", all.map((d) => (d.id === id ? Object.assign({}, d, { done: "" }) : d)));
    this.loadInboxDrop();
  },

  onIdPin(e) {
    const id = e.currentTarget.dataset.id;
    const all = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
    store.pluginStorageSet("inbox-drop", "drops", all.map((d) => (d.id === id ? Object.assign({}, d, { pinned: !d.pinned }) : d)));
    this.loadInboxDrop();
  },

  onIdDel(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除这条收纳记录？",
      content: "只是从收纳区里去掉，已经建出来的任务或时间块不受影响。",
      success: (res) => {
        if (!res.confirm) return;
        const all = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
        store.pluginStorageSet("inbox-drop", "drops", all.filter((d) => d.id !== id));
        this.loadInboxDrop();
      },
    });
  },

  onIdClearDone() {
    const all = runtime.idDrops(store.pluginStorageGet("inbox-drop", "drops", null), store.todayStr());
    const n = all.filter((d) => d.done).length;
    if (!n) { wx.showToast({ title: "没有已处理的记录", icon: "none" }); return; }
    wx.showModal({
      title: "清除已处理的 " + n + " 条？",
      content: "置顶的和还没处理的一律保留。",
      success: (res) => {
        if (!res.confirm) return;
        store.pluginStorageSet("inbox-drop", "drops", all.filter((d) => !d.done || d.pinned));
        this.loadInboxDrop();
        wx.showToast({ title: "已清除 " + n + " 条", icon: "success" });
      },
    });
  },

  /* ════ 插件使用说明（静态文档，清单数据与桌面端说明同源） ════ */
  loadGuide() {
    const platformText = (p) => {
      const out = [];
      if (p.windows !== "unavailable") out.push("Windows");
      if (p.android !== "unavailable") out.push("Android");
      if (p.miniprogram && p.miniprogram !== "unavailable") out.push("小程序");
      return out.join(" · ") || "暂不可用";
    };
    const groups = GUIDE_GROUPS.map((g) => ({
      name: g.name,
      items: g.ids.map((id) => {
        const p = catalog.byId[id] || { id, name: id, description: "插件清单中暂未找到此项。", version: "", platforms: {} };
        return {
          id,
          name: p.name,
          desc: p.description,
          iconPath: "/images/plugins/" + id + ".png",
          version: p.version || "",
          platformText: platformText(p.platforms || {}),
          native: !!(p.platforms && p.platforms.miniprogram === "native"),
          steps: GUIDE_DOCS[id] || ["打开插件", "按页面提示完成配置", "保存后即可使用"],
        };
      }),
    }));
    this.setData({ guide: { groups, repoUrl: "https://github.com/momoqiqi-qwq/U-Time" } });
  },

  onGuideCopyRepo() {
    wx.setClipboardData({ data: this.data.guide.repoUrl, success: () => wx.showToast({ title: "仓库地址已复制", icon: "none" }) });
  },

  /* ════ 微信提醒推送（PushPlus 主通道，兼容 Server酱） ════ */
  loadPush() {
    const lead = Math.max(1, Number(store.pluginStorageGet("wechat-push", "lead", 5)) || 5);
    this._push = {
      enabled: !!store.pluginStorageGet("wechat-push", "enabled", false),
      provider: store.pluginStorageGet("wechat-push", "provider", "") || (store.pluginStorageGet("wechat-push", "key", "") && !store.pluginStorageGet("wechat-push", "pushplusToken", "") ? "serverchan" : "pushplus"),
      token: store.pluginStorageGet("wechat-push", "pushplusToken", "") || "",
      topic: store.pluginStorageGet("wechat-push", "pushplusTopic", "") || "",
      oldKey: store.pluginStorageGet("wechat-push", "key", "") || "",
      blockEnabled: store.pluginStorageGet("wechat-push", "blockEnabled", true) !== false,
      taskEnabled: store.pluginStorageGet("wechat-push", "taskEnabled", true) !== false,
      lead,
      pushed: store.pluginStorageGet("wechat-push", "pushed", []) || [],
      log: store.pluginStorageGet("wechat-push", "log", []) || [],
    };
    this.paintPush();
    this.pushTick();
    this.startPushTimer();
  },

  savePush() {
    const p = this._push;
    store.pluginStorageSet("wechat-push", "enabled", p.enabled);
    store.pluginStorageSet("wechat-push", "provider", p.provider);
    store.pluginStorageSet("wechat-push", "pushplusToken", p.token);
    store.pluginStorageSet("wechat-push", "pushplusTopic", p.topic);
    store.pluginStorageSet("wechat-push", "key", p.oldKey);
    store.pluginStorageSet("wechat-push", "blockEnabled", p.blockEnabled);
    store.pluginStorageSet("wechat-push", "taskEnabled", p.taskEnabled);
    store.pluginStorageSet("wechat-push", "lead", p.lead);
    store.pluginStorageSet("wechat-push", "pushed", p.pushed.slice(-300));
    store.pluginStorageSet("wechat-push", "log", p.log.slice(0, 12));
  },

  pushConfigured() { return this._push.provider === "pushplus" ? !!this._push.token : !!this._push.oldKey; },

  paintPush() {
    const p = this._push;
    this.setData({
      push: {
        provider: p.provider, token: p.token, topic: p.topic, oldKey: p.oldKey,
        enabled: p.enabled, blockEnabled: p.blockEnabled, taskEnabled: p.taskEnabled,
        lead: p.lead, leadOptions: PUSH_LEADS.map(String),
        leadIndex: Math.max(0, PUSH_LEADS.indexOf(p.lead)),
        showKey: !!this._pushShowKey,
        log: p.log.slice(),
        configured: this.pushConfigured(),
      },
    });
  },

  startPushTimer() {
    this.stopPushTimer();
    this._pushTimer = setInterval(() => this.pushTick(), 60 * 1000);
  },
  stopPushTimer() {
    if (this._pushTimer) clearInterval(this._pushTimer);
    this._pushTimer = null;
  },

  async pushSend(title, content) {
    const p = this._push;
    let okFlag = false, errMsg = "";
    try {
      if (p.provider === "pushplus") {
        if (!p.token) throw new Error("请先填写 PushPlus Token");
        const payload = { token: p.token, title, content, template: "txt", channel: "wechat" };
        if (p.topic) payload.topic = p.topic;
        const res = await net.request({
          url: "https://www.pushplus.plus/send", method: "POST",
          header: { "Content-Type": "application/json" }, data: payload,
        });
        const data = res.data && typeof res.data === "object" ? res.data : null;
        if (res.statusCode < 200 || res.statusCode >= 300 || !data || Number(data.code) !== 200) {
          throw new Error((data && data.msg) || "HTTP " + res.statusCode);
        }
      } else {
        if (!p.oldKey) throw new Error("请先填写 Server酱 SendKey");
        const url = "https://sctapi.ftqq.com/" + encodeURIComponent(p.oldKey) + ".send?title=" +
          encodeURIComponent(title) + "&desp=" + encodeURIComponent(content);
        const res = await net.request({ url });
        const data = res.data && typeof res.data === "object" ? res.data : null;
        if (res.statusCode < 200 || res.statusCode >= 300 || !data || Number(data.code) !== 0) {
          throw new Error((data && (data.message || data.msg)) || "HTTP " + res.statusCode);
        }
      }
      okFlag = true;
    } catch (e) {
      errMsg = String((e && e.message) || e);
    }
    const tag = okFlag ? "✓" : "✗";
    const name = p.provider === "pushplus" ? "PushPlus" : "Server酱";
    p.log.unshift(this._hhmm() + " " + tag + " " + (okFlag ? name + "已提交：" + title.slice(0, 26) : errMsg));
    p.log = p.log.slice(0, 12);
    this.savePush(); this.paintPush();
    if (!okFlag) wx.showToast({ title: "推送失败：" + errMsg, icon: "none" });
    return okFlag;
  },

  _hhmm() {
    const d = new Date();
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  },

  pushDueAt(task) {
    if (!task || !task.due) return null;
    const time = /^\d{2}:\d{2}$/.test(task.dueTime || "") ? task.dueTime : "23:59";
    const d = new Date(task.due + "T" + time + ":00");
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  },

  async pushTick() {
    const p = this._push;
    if (!p || !p.enabled || !this.pushConfigured()) return;
    const now = new Date();
    const today = store.todayStr();
    const nowMs = now.getTime();
    const keepAfter = nowMs - 7 * 86400000;
    const kept = p.pushed.filter((k) => {
      const ts = Number(String(k).split("|").pop());
      return !Number.isFinite(ts) || ts >= keepAfter;
    });
    p.pushed = kept;
    if (p.blockEnabled) {
      const nowMin = now.getHours() * 60 + now.getMinutes();
      for (const b of store.blocksOf(today)) {
        const parts = String(b.start || "00:00").split(":");
        const delta = (+parts[0]) * 60 + (+parts[1]) - nowMin;
        const eventAt = new Date(b.date + "T" + b.start + ":00").getTime();
        const key = "block|" + b.id + "|" + eventAt;
        if (delta >= 0 && delta <= p.lead && p.pushed.indexOf(key) < 0) {
          p.pushed.push(key);
          const endMin = store.mmOf(b.start) + (Number(b.durMin) || 0);
          await this.pushSend("⏰ " + b.start + " " + b.title, b.start + " – " + store.hhmmOf(endMin) + " · " + b.durMin + " 分钟\n\n来自 U-Time · 时间块提醒");
        }
      }
    }
    if (p.taskEnabled) {
      for (const task of store.getState().tasks || []) {
        if (!task || task.done || task.reminderEnabled === false) continue;
        const due = this.pushDueAt(task); if (!due) continue;
        const offsets = Array.isArray(task.reminderOffsets) && task.reminderOffsets.length ? task.reminderOffsets : [60, 10, 0];
        for (const raw of offsets) {
          const offset = Math.max(0, Math.round(Number(raw) || 0));
          const at = due - offset * 60000;
          const key = "task|" + task.id + "|" + offset + "|" + at;
          if (nowMs >= at && nowMs - at <= 90000 && p.pushed.indexOf(key) < 0) {
            p.pushed.push(key);
            await this.pushSend("📌 " + task.title, this.pushOffsetLabel(offset) + "\n截止：" + task.due + " " + (task.dueTime || "23:59") + "\n\n来自 U-Time · 任务提醒");
          }
        }
      }
    }
    this.savePush();
  },

  pushOffsetLabel(min) {
    if (min === 0) return "已到截止时间";
    if (min < 60) return "还有 " + min + " 分钟截止";
    if (min % 1440 === 0) return "还有 " + min / 1440 + " 天截止";
    if (min % 60 === 0) return "还有 " + min / 60 + " 小时截止";
    return "还有 " + Math.floor(min / 60) + " 小时 " + min % 60 + " 分钟截止";
  },

  onPushField(e) {
    const k = e.currentTarget.dataset.k;
    if (!this._push || !(k in this._push)) return;
    this._push[k] = e.detail.value;
    this.savePush(); this.paintPush();
  },
  onPushProvider(e) {
    this._push.provider = e.currentTarget.dataset.p;
    this.savePush(); this.paintPush();
  },
  onPushSwitch(e) {
    const k = e.currentTarget.dataset.k;
    const on = !!e.detail.value;
    if (k === "enabled" && on && !this.pushConfigured()) {
      wx.showToast({ title: this._push.provider === "pushplus" ? "请先填写 PushPlus Token" : "请先填写 Server酱 SendKey", icon: "none" });
      this._push.enabled = false;
    } else {
      this._push[k] = on;
      if (k === "enabled") wx.showToast({ title: on ? "微信推送已开启（插件页打开期间每分钟检查）" : "微信推送已关闭", icon: "none" });
    }
    this.savePush(); this.paintPush();
  },
  onPushLead(e) {
    this._push.lead = PUSH_LEADS[Number(e.detail.value) || 0];
    this.savePush(); this.paintPush();
  },
  onPushToggleShow() {
    this._pushShowKey = !this._pushShowKey;
    this.paintPush();
  },
  onPushCopy(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: "链接已复制，去浏览器打开", icon: "none" }) });
  },
  onPushTest() {
    if (!this.pushConfigured()) { wx.showToast({ title: "请先填写 Token", icon: "none" }); return; }
    this.pushSend("U-Time测试推送", "如果你在微信里看到这条消息，说明推送通道正常 ✓");
  },

  /* ════ 竞赛消息雷达（gxxsjs.com 摩课云公告） ════ */
  loadGx() {
    const f = store.pluginStorageGet("gx-news", "filter", null) || {};
    this._gx = {
      filter: {
        kw: f.kw || "", type: ["all", "n202", "n203", "other"].indexOf(f.type) >= 0 ? f.type : "all",
        month: f.month || "all", hideSeen: !!f.hideSeen,
      },
      /* 桌面端 v0.66.0 起条目 id 带源前缀（`mokeroad:123`），因为多源之后三家的 id 都是自增数字、必然撞号。
         data.json 是两端共用的，这里要把前缀摘掉再比，否则手机端的已读记录全不命中、消息整列表复活成 NEW。
         写回时仍写裸 id —— 桌面端读回来会自己补回前缀。 */
      seen: new Set((store.pluginStorageGet("gx-news", "seen", []) || [])
        .map((x) => String(x).replace(/^mokeroad:/, ""))),
      list: [], page: 1, hasMore: true, fetching: false, fetchedAt: 0, error: "",
      rendered: 14,
    };
    this.gxPaint(true);
    if (!this._gx.list.length) this.gxFetch(1);
  },

  async gxFetch(page) {
    const gx = this._gx;
    if (!gx || gx.fetching) return;
    gx.fetching = true;
    this.gxPaint();
    try {
      const res = await net.request({ url: "https://www.gxxsjs.com/prod-api/home/competition/news/page?pageNum=" + page + "&pageSize=40" });
      const d = res.data && typeof res.data === "object" ? res.data : null;
      if (res.statusCode !== 200 || !d || d.code !== 0 || !d.data) throw new Error((d && d.msg) || "HTTP " + res.statusCode);
      const fresh = (d.data.records || []).map((r) => ({
        id: r.newsId,
        title: String(r.newsTitle || "(无标题)"),
        type: String(r.newsType || ""),
        time: String(r.publishTime || "").slice(0, 16),
        snippet: String(r.newsInfo || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120),
      }));
      if (page === 1) gx.list = fresh;
      else {
        const ids = new Set(gx.list.map((m) => m.id));
        gx.list = gx.list.concat(fresh.filter((m) => !ids.has(m.id)));
      }
      gx.page = page;
      gx.hasMore = fresh.length >= 40 && page < 6;
      gx.fetchedAt = Date.now();
      gx.error = "";
    } catch (e) {
      gx.error = String((e && e.message) || e);
    }
    gx.fetching = false;
    this.gxPaint(!!(page === 1));
  },

  gxMonths() {
    const set = new Set();
    for (const m of this._gx.list) set.add((m.time || "").slice(0, 7) || "unknown");
    return Array.from(set).filter((mo) => mo !== "unknown").sort().reverse()
      .concat(Array.from(set).indexOf("unknown") >= 0 ? ["unknown"] : []);
  },

  gxMonthLabel(mo) {
    if (mo === "unknown") return "时间未知";
    const parts = mo.split("-");
    return parts[0] + "年" + Number(parts[1]) + "月";
  },

  gxPaint(reset) {
    const gx = this._gx;
    if (!gx) return;
    if (reset) gx.rendered = 14;
    const kw = gx.filter.kw.trim().toLowerCase();
    const hasType = (t, code) => String(t || "").split(".").indexOf(code) >= 0;
    const rows = gx.list.filter((m) => {
      if (gx.filter.type === "n202" && !hasType(m.type, "202")) return false;
      if (gx.filter.type === "n203" && !hasType(m.type, "203")) return false;
      if (gx.filter.type === "other" && (hasType(m.type, "202") || hasType(m.type, "203"))) return false;
      if (gx.filter.month !== "all" && ((m.time || "").slice(0, 7) || "unknown") !== gx.filter.month) return false;
      if (gx.filter.hideSeen && gx.seen.has(m.id)) return false;
      if (kw && !(m.title.toLowerCase().includes(kw) || m.snippet.toLowerCase().includes(kw))) return false;
      return true;
    }).sort((a, b) => (b.time || "").localeCompare(a.time || ""));
    const vms = [];
    const counts = {};
    for (const m of rows) {
      const mo = (m.time || "").slice(0, 7) || "unknown";
      counts[mo] = (counts[mo] || 0) + 1;
    }
    let lastMonth = "";
    for (const m of rows.slice(0, gx.rendered)) {
      const mo = (m.time || "").slice(0, 7) || "unknown";
      if (mo !== lastMonth) {
        vms.push({ kind: "month", key: "m_" + mo, label: this.gxMonthLabel(mo) + " · " + counts[mo] + " 条" });
        lastMonth = mo;
      }
      const tn = hasType(m.type, "203") ? "赛事动态" : hasType(m.type, "202") ? "平台通知" : "其他";
      vms.push({
        kind: "item", key: String(m.id), id: String(m.id), title: m.title, tagName: tn,
        tagHot: tn === "赛事动态", time: m.time, snippet: m.snippet,
        isNew: !gx.seen.has(m.id), seen: gx.seen.has(m.id),
      });
    }
    const months = this.gxMonths();
    this.setData({
      gx: {
        status: gx.fetching && !gx.list.length ? "正在抓取消息…" :
          gx.error ? "" : "已更新 " + (gx.fetchedAt ? this._hhmm() : "—") + " · 拉取 " + gx.list.length + " 条 · 显示 " + rows.length + " 条",
        error: gx.error,
        fetching: gx.fetching,
        rows: vms,
        count: rows.length,
        kw: gx.filter.kw,
        hideSeen: gx.filter.hideSeen,
        typeChips: [{ id: "all", label: "全部" }, { id: "n202", label: "平台通知" }, { id: "n203", label: "赛事动态" }, { id: "other", label: "其他" }]
          .map((c) => ({ id: c.id, label: c.label, on: gx.filter.type === c.id })),
        monthChips: [{ id: "all", label: "全部" }].concat(months.map((mo) => ({ id: mo, label: this.gxMonthLabel(mo) })))
          .map((c) => ({ id: c.id, label: c.label, on: gx.filter.month === c.id })),
        more: gx.rendered < rows.length ? "page" : gx.hasMore ? "next" : "end",
        moreText: gx.rendered < rows.length ? "显示更多（本页还有 " + (rows.length - gx.rendered) + " 条）" :
          gx.hasMore ? (gx.fetching ? "正在加载更早的消息…" : "加载更早的消息（第 " + (gx.page + 1) + " 页）") : "近期消息已全部展示",
      },
    });
  },

  onGxKw(e) {
    if (!this._gx) return;
    this._gx.filter.kw = e.detail.value;
    store.pluginStorageSet("gx-news", "filter", this._gx.filter);
    clearTimeout(this._gxKwTimer);
    this._gxKwTimer = setTimeout(() => this.gxPaint(true), 250);
  },
  onGxType(e) {
    this._gx.filter.type = e.currentTarget.dataset.id;
    store.pluginStorageSet("gx-news", "filter", this._gx.filter);
    this.gxPaint(true);
  },
  onGxMonth(e) {
    this._gx.filter.month = e.currentTarget.dataset.id;
    store.pluginStorageSet("gx-news", "filter", this._gx.filter);
    this.gxPaint(true);
  },
  onGxToggleSeen() {
    this._gx.filter.hideSeen = !this._gx.filter.hideSeen;
    store.pluginStorageSet("gx-news", "filter", this._gx.filter);
    this.gxPaint(true);
  },
  onGxRefresh() { this.gxFetch(1); },
  onGxMore() {
    const gx = this._gx;
    if (!gx) return;
    if (gx.rendered < (this.data.gx ? this.data.gx.count : 0)) { gx.rendered += 14; this.gxPaint(); }
    else if (gx.hasMore) this.gxFetch(gx.page + 1);
  },
  onGxTap(e) {
    const id = e.currentTarget.dataset.id;
    const act = e.currentTarget.dataset.act;
    const m = this._gx && this._gx.list.find((x) => String(x.id) === String(id));
    if (!m) return;
    if (act === "remind") { this.gxRemind(m); return; }
    if (!this._gx.seen.has(m.id)) {
      this._gx.seen.add(m.id);
      store.pluginStorageSet("gx-news", "seen", Array.from(this._gx.seen).slice(-600));
    }
    const url = "https://www.gxxsjs.com/home/newsDetails?newsId=" + m.id;
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: "详情链接已复制（小程序不能直接打开外站）", icon: "none" }) });
    this.gxPaint();
  },
  gxRemind(m) {
    const text = m.title + " " + m.snippet;
    const p = timeParser.parseWhen(text);
    const task = store.addTask({
      title: m.title,
      quad: timeParser.guessQuad(p.date),
      estMin: p.endMin ? p.endMin - p.startMin : 60,
      due: p.date || null,
      tags: ["竞赛消息"],
      note: "https://www.gxxsjs.com/home/newsDetails?newsId=" + m.id,
    });
    if (p.date && p.startMin !== null && p.startMin !== undefined) {
      const dur = p.endMin ? p.endMin - p.startMin : 60;
      store.addBlock({ date: p.date, start: store.hhmmOf(p.startMin), durMin: dur, title: m.title, taskId: task.id, cat: timeParser.guessCategory(text) || "study" });
      wx.showToast({ title: "已创建提醒：" + p.date.slice(5) + " " + store.hhmmOf(p.startMin), icon: "none" });
    } else if (p.date) {
      store.addBlock({ date: p.date, start: "09:00", durMin: 60, title: m.title, taskId: task.id, cat: timeParser.guessCategory(text) || "study" });
      wx.showToast({ title: "识别到日期 " + p.date.slice(5) + "，提醒先放在 09:00", icon: "none" });
    } else {
      wx.showToast({ title: "没识别到日期，任务已存入象限池", icon: "none" });
    }
    if (!this._gx.seen.has(m.id)) {
      this._gx.seen.add(m.id);
      store.pluginStorageSet("gx-news", "seen", Array.from(this._gx.seen).slice(-600));
    }
    this.gxPaint();
  },

  /* ════ 学习通（notice.chaoxing.com 收件箱主路径） ════ */
  loadCx() {
    this._cx = {
      cookie: store.pluginStorageGet("chaoxing-notify", "sessionCookie", "") || "",
      creds: store.pluginStorageGet("chaoxing-notify", "creds", null),
      inbox: store.pluginStorageGet("chaoxing-notify", "inboxCache", []) || [],
      knownIds: new Set(store.pluginStorageGet("chaoxing-notify", "knownIds", []) || []),
      ignoredIds: new Set(store.pluginStorageGet("chaoxing-notify", "ignoredIds", []) || []),
      readOverrides: new Map(store.pluginStorageGet("chaoxing-notify", "readOverrides", []) || []),
      filter: Object.assign({ kw: "", category: "全部", onlyUnread: false }, store.pluginStorageGet("chaoxing-notify", "filter", null) || {}),
      workStatus: store.pluginStorageGet("chaoxing-notify", "workStatus", null) || {},
      newIds: new Set(),
      courses: [],
      loading: false,
      lastSync: "",
      year: null,
      lookupResult: null,
      remember: true,
    };
    this.cxPaint();
    if (this._cx.cookie && !this._cx.inbox.length) this.cxRefresh(true);
  },

  cxSaveAuth() {
    const cx = this._cx;
    store.pluginStorageSet("chaoxing-notify", "sessionCookie", cx.remember ? cx.cookie : "");
    store.pluginStorageSet("chaoxing-notify", "creds", cx.remember ? cx.creds : null);
  },
  cxSaveKnown() { store.pluginStorageSet("chaoxing-notify", "knownIds", Array.from(this._cx.knownIds).slice(-1000)); },
  cxSaveIgnored() { store.pluginStorageSet("chaoxing-notify", "ignoredIds", Array.from(this._cx.ignoredIds).slice(-1000)); },
  cxSaveOverrides() { store.pluginStorageSet("chaoxing-notify", "readOverrides", Array.from(this._cx.readOverrides.entries()).slice(-1000)); },
  cxSaveFilter() { store.pluginStorageSet("chaoxing-notify", "filter", this._cx.filter); },

  async cxApi(opt) {
    const { res, fresh } = await net.fetchWithCookie(this._cx.cookie, opt);
    if (fresh.length) this._cx.cookie = cxCore.mergeCookies(this._cx.cookie, fresh);
    return res;
  },

  async cxLogin() {
    const cx = this._cx;
    const uname = String(this.data.cx ? this.data.cx.uname || "" : "").trim();
    const pwd = String(this.data.cx ? this.data.cx.pwd || "" : "");
    if (!uname || !pwd) { wx.showToast({ title: "请填写账号和密码", icon: "none" }); return; }
    cx.loading = true; this.cxPaint();
    try {
      const page = await this.cxApi({ url: "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com", dataType: "text" });
      cxCore.assertJsonResponse({ body: page.data, data: page.data }, "登录页");
      const pwdHex = cxCore.desEncryptHex(pwd, "u2oh6Vu^");
      const res = await this.cxApi({
        url: "https://passport2.chaoxing.com/fanyalogin", method: "POST",
        header: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Origin": "https://passport2.chaoxing.com",
          "Referer": "https://passport2.chaoxing.com/login?fid=&newversion=true",
        },
        data: cxCore.LOGIN_BODY(uname, pwdHex),
      });
      const j = res.data && typeof res.data === "object" ? res.data : JSON.parse(String(res.data || "{}"));
      if (!j.status) throw new Error(j.msg2 || j.msg || "登录失败，请检查账号密码；频繁登录触发风控时改用 Cookie 登录");
      cx.loggedInHint = true;
      cx.creds = { uname };
      this.cxSaveAuth();
      wx.showToast({ title: "登录成功", icon: "success" });
      await this.cxRefresh(true);
    } catch (e) {
      cx.error = String((e && e.message) || e);
      this.cxPaint();
    }
    cx.loading = false;
    this.cxPaint();
  },

  async cxLoginCookie() {
    const cx = this._cx;
    const cookie = String(this.data.cx ? this.data.cx.cookieInput || "" : "").trim();
    if (!cookie) { wx.showToast({ title: "Cookie 不能为空", icon: "none" }); return; }
    cx.cookie = cookie;
    cx.loading = true; this.cxPaint();
    try {
      await this.cxFetchInbox(1, false);
      cx.loggedInHint = true;
      this.cxSaveAuth();
      wx.showToast({ title: "会话有效", icon: "success" });
      cx.error = "";
    } catch (e) {
      cx.error = String((e && e.message) || e);
    }
    cx.loading = false;
    this.cxPaint();
  },

  cxLogout() {
    this._cx.cookie = "";
    this._cx.creds = null;
    this.cxSaveAuth();
    this.cxPaint();
  },

  async cxFetchInbox(limit, incremental) {
    const cx = this._cx;
    const items = []; let last = ""; let pages = 0;
    while (pages < 50) {
      const res = await this.cxApi({
        url: "https://notice.chaoxing.com/pc/notice/getNoticeList", method: "POST",
        header: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Origin": "https://notice.chaoxing.com",
          "Referer": "https://notice.chaoxing.com/pc/notice/index",
          "X-Requested-With": "XMLHttpRequest",
        },
        data: "type=2&year=" + new Date().getFullYear() + "&lastValue=" + encodeURIComponent(last),
      });
      const root = cxCore.assertJsonResponse({ body: "", data: res.data }, "收件箱加载");
      const notices = root.notices || {};
      const list = Array.isArray(notices.list) ? notices.list : [];
      items.push.apply(items, list); pages += 1;
      const pageIds = list.map((x) => String(x.idCode || x.id || (x.insertTime || "") + "-" + (x.title || "")));
      const overlapped = incremental && pageIds.some((id) => cx.knownIds.has(id));
      if ((limit && items.length >= limit) || notices.lastPage || !list.length || overlapped) break;
      last = String(notices.lastGetId || ""); if (!last) break;
    }
    const fresh = items.slice(0, limit || items.length).map(cxCore.normalizeNotice);
    const merged = incremental ? fresh.concat(cx.inbox) : fresh;
    const dedup = new Map();
    for (const x of merged) if (x.id && !dedup.has(x.id)) dedup.set(x.id, x);
    const normalized = Array.from(dedup.values()).sort((a, b) => (b.insertTime || 0) - (a.insertTime || 0));
    const ids = fresh.map((x) => x.id).filter(Boolean);
    if (!cx.knownIds.size) cx.newIds = new Set();
    else cx.newIds = new Set(ids.filter((id) => !cx.knownIds.has(id)));
    ids.forEach((id) => cx.knownIds.add(id));
    cx.inbox = normalized;
    // wx 单 key 存储上限 1MB：缓存只留最近 300 条，raw 只留正文相关两个字段
    const cache = normalized.slice(0, 300).map((n) => Object.assign({}, n, { raw: { rtf_content: n.raw.rtf_content, content: n.raw.content } }));
    store.pluginStorageSet("chaoxing-notify", "inboxCache", cache);
    this.cxSaveKnown(); this.cxSaveAuth();
    return normalized;
  },

  async cxLoadCourses() {
    const cx = this._cx;
    const res = await this.cxApi({
      url: "https://mooc2-ans.chaoxing.com/visit/courses/list?v=" + Date.now(), dataType: "text",
      header: { "Accept": "text/html, */*; q=0.01", "Referer": "https://mooc2-ans.chaoxing.com/visit/interaction" },
    });
    if (res.statusCode !== 200 || /passport2\.chaoxing\.com/.test(String(res.data || ""))) {
      throw new Error("课程列表加载失败：登录态可能失效");
    }
    cx.courses = cxCore.parseCoursesHtml(res.data);
  },

  async cxProbeWorks() {
    const cx = this._cx;
    if (!cx.cookie || this._cxProbing) return;
    const targets = cxCore.todos(cx.inbox, { ignoredIds: cx.ignoredIds, readOverrides: cx.readOverrides, filter: cx.filter })
      .filter((n) => { const r = cxCore.parseWorkRef(n); return r && !cx.workStatus[r.id]; })
      .slice(0, 6);
    if (!targets.length) return;
    this._cxProbing = true;
    try {
      for (const n of targets) {
        const ref = cxCore.parseWorkRef(n);
        if (!ref || cx.workStatus[ref.id]) continue;
        try {
          const res = await this.cxApi({ url: ref.url, dataType: "text", header: { "Accept": "text/html,*/*; q=0.9", "Referer": "https://i.chaoxing.com/" } });
          const title = (String(res.data || "").match(/<title>([^<]*)<\/title>/) || [])[1] || "";
          cx.workStatus[ref.id] = /作业作答/.test(title) ? "unsent" : /详情/.test(title) ? "grading" : "";
        } catch (e) { /* 探测失败不留记录，下次刷新再试 */ }
        store.pluginStorageSet("chaoxing-notify", "workStatus", cx.workStatus);
        this.cxPaint();
      }
    } finally { this._cxProbing = false; this.cxPaint(); }
  },

  async cxRefresh(full) {
    const cx = this._cx;
    if (!cx.cookie || cx.loading) return;
    cx.loading = true; cx.error = ""; this.cxPaint();
    try {
      await this.cxFetchInbox(0, !full && cx.inbox.length > 0);
      try { await this.cxLoadCourses(); } catch (e) { cx.error = String((e && e.message) || e); }
      cx.lastSync = this._hhmm();
      this.cxPaint();
      this.cxProbeWorks(); // 后台串行探测作业提交状态
    } catch (e) {
      cx.error = String((e && e.message) || e);
      if (/登录|会话/.test(cx.error)) { cx.cookie = ""; this.cxSaveAuth(); }
    }
    cx.loading = false;
    this.cxPaint();
  },

  cxRowVm(n, kind) {
    const cx = this._cx;
    const cat = cxCore.classify(n);
    const grading = cxCore.parseWorkRef(n) ? cx.workStatus[cat === "作业" ? cxCore.parseWorkRef(n).id : ""] === "grading" : false;
    const target = cxCore.pickTargetLink(n);
    const real = !!target && !cxCore.isAnonymousUrl(target);
    return {
      key: n.id,
      title: n.title,
      cat,
      // WXSS 选择器不支持非 ASCII 标识符：`.cat-考试` 会让编译器把多字节字符切碎，
      // 上传报 `unexpected \`�\`` 拒绝整包（v0.40.0 实测）。
      // 所以另给一个纯 ASCII 的类名后缀，中文仍只作为文本显示。
      catCls: CX_CAT_CLS[cat] || "notice",
      sender: n.sender,
      time: n.time || "未知时间",
      unread: cxCore.effUnread(n, cx.readOverrides),
      isNew: cx.newIds.has(n.id),
      grading,
      body: n.body || "（无正文）",
      dueText: kind === "todo" ? cxCore.deadline(n.body) : "",
      hasLink: !!n.idCode || !!target,
      linkHint: real ? (cxCore.linkScore(target) >= 100 ? "已识别作业页" : cxCore.linkScore(target) >= 90 ? "已识别考试页" : "已识别页面") : "",
      kind,
    };
  },

  cxPaint() {
    const cx = this._cx;
    if (!cx) return;
    const opts = { ignoredIds: cx.ignoredIds, readOverrides: cx.readOverrides, filter: cx.filter };
    const visible = cxCore.filteredInbox(cx.inbox, opts);
    const todoRows = cxCore.todos(cx.inbox, opts).map((n) => this.cxRowVm(n, "todo"));
    const course = this.data.cx && this.data.cx.courseYearIndex !== undefined ? this.data.cx.courseYearIndex : 0;
    const cg = cxCore.courseGroups(cx.courses, new Date(), cx.filter.kw);
    const years = cg.years.map((y) => ({ year: y, label: cg.yearLabel(y), count: (cg.yearMap.get(y) || []).length }));
    let yearIndex = years.findIndex((y) => y.year === cx.year);
    if (yearIndex < 0) { yearIndex = 0; cx.year = years.length ? years[0].year : null; }
    const groupsVm = [];
    if (years.length) {
      const groups = cg.groupsOf(years[yearIndex].year);
      for (const k of ["red", "blue", "green", "gray"]) {
        if (!groups[k].length) continue;
        groupsVm.push({
          key: k, label: cxCore.STATUS_META[k].label, count: groups[k].length,
          items: groups[k].map((c) => {
            const t = cxCore.termOf(c.start);
            const g = t ? cxCore.gradeOf(t.year, cg.enrollYear) : "";
            return {
              key: c.courseid + "_" + c.clazzid,
              name: c.name,
              sub: [c.teacher, c.clazz].filter(Boolean).join(" · ") || "—",
              termLine: t ? (g ? g + t.half : "学年 " + t.year + t.half) + " · 开课 " + c.start : "无开课时间",
              status: cxCore.courseStatus(c, new Date()),
            };
          }),
        });
      }
    }
    const rowVms = visible.map((n) => this.cxRowVm(n, "inbox"));
    const unread = cx.inbox.filter((x) => !cx.ignoredIds.has(x.id) && cxCore.effUnread(x, cx.readOverrides)).length;
    this.setData({
      cx: {
        mode: cx.cookie ? "main" : "login",
        loginTab: this.data.cx && this.data.cx.loginTab === "cookie" ? "cookie" : "pwd",
        uname: cx.creds ? cx.creds.uname || "" : "",
        remember: cx.remember,
        loggedIn: !!cx.cookie,
        tab: this.data.cx && this.data.cx.tab ? this.data.cx.tab : "inbox",
        loading: cx.loading,
        error: cx.error || "",
        lastSync: cx.lastSync,
        statusText: (cx.lastSync ? "上次刷新 " + cx.lastSync + " · " : "") + "收件箱走 notice.chaoxing.com 主路径（无 IP 白名单）",
        ignoredCount: cx.ignoredIds.size,
        newCount: cx.newIds.size,
        unreadCount: unread,
        visibleCount: cx.inbox.filter((x) => !cx.ignoredIds.has(x.id)).length,
        totalCount: cx.inbox.length,
        catOptions: ["全部", "通知", "作业", "考试", "签到"],
        filterCatIndex: Math.max(0, ["全部", "通知", "作业", "考试", "签到"].indexOf(cx.filter.category)),
        filterKw: cx.filter.kw,
        onlyUnread: !!cx.filter.onlyUnread,
        inboxRows: rowVms,
        todoCount: todoRows.length,
        todoRows,
        courseYears: years,
        courseYearIndex: yearIndex,
        courseGroups: groupsVm,
        courseCount: cx.courses.length,
        courseSearchOpen: !!(cx.filter.kw && this.data.cx && this.data.cx.courseSearchOpen) || !!(cx.filter.kw && !this.data.cx),
        lookupResult: cx.lookupResult,
      },
    });
  },

  onCxField(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ["cx." + k]: e.detail.value });
  },
  onCxRemember(e) { this._cx.remember = !!e.detail.value; },
  onCxLoginTab(e) {
    this.setData({ "cx.loginTab": e.currentTarget.dataset.t });
  },
  onCxLogin() { this.cxLogin(); },
  onCxLoginCookie() { this.cxLoginCookie(); },
  onCxLogout() { this.cxLogout(); },
  onCxTab(e) {
    this.setData({ "cx.tab": e.currentTarget.dataset.t }, () => this.cxPaint());
  },
  onCxSearch(e) {
    this._cx.filter.kw = e.detail.value;
    clearTimeout(this._cxKwTimer2);
    this._cxKwTimer2 = setTimeout(() => { this.cxSaveFilter(); this.cxPaint(); }, 250);
  },
  onCxCat(e) {
    this._cx.filter.category = this.data.cx.catOptions[Number(e.detail.value) || 0];
    this.cxSaveFilter(); this.cxPaint();
  },
  onCxUnread(e) {
    this._cx.filter.onlyUnread = !!e.detail.value;
    this.cxSaveFilter(); this.cxPaint();
  },
  onCxYear(e) {
    const idx = Number(e.detail.value) || 0;
    const years = (this.data.cx && this.data.cx.courseYears) || [];
    if (years[idx]) this._cx.year = years[idx].year;
    this.setData({ "cx.courseYearIndex": idx }, () => this.cxPaint());
  },
  onCxRefresh() { this.cxRefresh(true); },
  onCxRestore() {
    const n = this._cx.ignoredIds.size;
    this._cx.ignoredIds.clear();
    this.cxSaveIgnored(); this.cxPaint();
    wx.showToast({ title: n ? "已恢复 " + n + " 条通知" : "当前没有被忽略的通知", icon: "none" });
  },
  onCxRowToggle(e) {
    const id = e.currentTarget.dataset.id;
    const open = this._cxOpen || (this._cxOpen = new Set());
    if (open.has(id)) open.delete(id); else open.add(id);
    this.setData({ ["cx.inboxRows"]: this.data.cx.inboxRows.map((r) => Object.assign({}, r, { expanded: open.has(r.key) })) });
  },
  async onCxMark(e) {
    const n = this._cx.inbox.find((x) => x.id === e.currentTarget.dataset.id);
    if (!n) return;
    const next = !cxCore.effUnread(n, this._cx.readOverrides);
    this._cx.readOverrides.set(n.id, next);
    if (this._cx.readOverrides.size > 1000) {
      for (const k of Array.from(this._cx.readOverrides.keys()).slice(0, this._cx.readOverrides.size - 1000)) this._cx.readOverrides.delete(k);
    }
    this.cxSaveOverrides(); this.cxPaint();
    wx.showToast({ title: next ? "已在本机标记为未读" : "已在本机标记为已读", icon: "none" });
  },
  onCxIgnore(e) {
    const id = e.currentTarget.dataset.id;
    this._cx.ignoredIds.add(id);
    this._cx.newIds.delete(id);
    this.cxSaveIgnored(); this.cxPaint();
    wx.showToast({ title: "已从本机列表移除，不影响学习通", icon: "none" });
  },
  onCxCopyLink(e) {
    const n = this._cx.inbox.find((x) => x.id === e.currentTarget.dataset.id);
    if (!n) return;
    const target = cxCore.pickTargetLink(n);
    const url = target || (n.idCode ? cxCore.SHARE_PAGE(n.idCode) : "");
    if (!url) { wx.showToast({ title: "这条通知里没有可打开的链接", icon: "none" }); return; }
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: target && !cxCore.isAnonymousUrl(target) ? "链接已复制（浏览器打开时需自行带登录态）" : "分享页链接已复制，无需登录即可看正文", icon: "none" }),
    });
  },
  onCxRemind(e) {
    const n = this._cx.inbox.find((x) => x.id === e.currentTarget.dataset.id);
    if (n) this.cxToReminder(n);
  },
  onCxLookupRemind() {
    const n = this._cx.lookupResult;
    if (n) this.cxToReminder(n);
  },
  cxToReminder(n) {
    const text = (n.title || "") + " " + (n.body || "");
    const due = cxCore.deadline(n.body);
    let date = "", startMin = null;
    if (due) {
      date = due.slice(0, 10);
      const parts = due.slice(11).split(":");
      startMin = (+parts[0]) * 60 + (+parts[1]);
    } else {
      const p = timeParser.parseWhen(text.slice(0, 700));
      date = p.date; startMin = p.startMin;
    }
    const link = n.idCode ? cxCore.SHARE_PAGE(n.idCode) : "";
    const task = store.addTask({
      title: n.title || "学习通提醒",
      quad: timeParser.guessQuad(date),
      estMin: 60,
      due: date || null,
      tags: ["学习通", cxCore.classify(n)],
      note: [n.sender, link, (n.body || "").slice(0, 500)].filter(Boolean).join("\n"),
    });
    if (date) {
      const start = store.hhmmOf(startMin == null ? 9 * 60 : startMin);
      store.addBlock({ date, start, durMin: 60, title: n.title || "学习通提醒", taskId: task.id, cat: timeParser.guessCategory(text) || "study" });
      wx.showToast({ title: "已创建提醒：" + date.slice(5) + " " + start, icon: "none" });
    } else {
      wx.showToast({ title: "没有识别到明确日期，已保存到任务池", icon: "none" });
    }
  },
  async onCxLookup() {
    const code = String(this.data.cx.lookupCode || "").trim();
    const clean = (String(code).match(/[0-9a-fA-F]{32}/) || [])[0] || code;
    if (!/^[0-9a-fA-F]{32}$/.test(clean)) { wx.showToast({ title: "应为 32 位 idCode 或含 idCode 的分享链接", icon: "none" }); return; }
    this._cx.loading = true; this.cxPaint();
    try {
      const res = await this.cxApi({
        url: "https://sharewh3.xuexi365.com/share/notice/" + encodeURIComponent(clean) + "/notice_data?pt=&wxsn=",
        header: { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
      });
      const j = cxCore.assertJsonResponse({ body: "", data: res.data }, "通知详情查询");
      if (String(j.result) !== "1") throw new Error(j.msg || "通知详情查询失败");
      const d = j.data || {};
      this._cx.lookupResult = {
        id: clean,
        idCode: clean,
        title: cxCore.stripHtml(d.title || "(无标题)"),
        body: cxCore.stripHtml(d.rtf_content) || cxCore.stripHtml(d.content),
        sender: cxCore.stripHtml(d.createrName || ""),
        time: cxCore.timeText(d.insertTime),
        toNames: cxCore.stripHtml(d.toNames || ""),
      };
      this._cx.error = "";
    } catch (e) {
      this._cx.error = String((e && e.message) || e);
    }
    this._cx.loading = false;
    this.cxPaint();
  },
});
