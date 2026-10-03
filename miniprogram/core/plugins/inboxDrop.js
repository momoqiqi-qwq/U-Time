const { store, holidayData, examData, WEEK_CN, CAT_LABEL, pad2, dateMs, dayDiff, weekday, durationLabel } = require("./common.js");
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


module.exports = { inboxDropSummary, idAddDrops, idLoadAll, idDrops, idStatsOf, idNormalizeDrop, idDetectPlatform, idDetectType, idSourceOf, idTitleOf, idMatchDate, idMatchTime, idSameMessage, idIsDuplicate, idToInboxItem, idToTaskPatch, idPlatformLabel, idTypeLabel, idKindLabel, idTypeMeta, ID_PLATFORMS, ID_TYPES, ID_KINDS, ID_KEEP, ID_TITLE_MAX, ID_RAW_MAX, ID_DUP_MS };
