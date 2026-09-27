// AI 文档 / 图片解析：把截图、通知、课表照片、文档交给视觉模型，抽成结构化事件，
// 再按事件类型路由到 任务 / 时间块 / 收件箱 / 课程表。
//
// 三条设计红线（都是想清楚才这么写的，别改）：
//
// ① **AI 只负责「读懂」，不负责「写入」。** 模型返回的每条事件都必须过
//    `normalizeIngestEvent` 白名单归一 —— 不存在的日期、越界的时长、未知的分类
//    一律兜底成安全默认值，落盘统一走 `applyIngestEvents` 里应用自己的 API。
//    模型不能指定 id、不能写 storage、不能碰任何文件路径。
//    （同一条纪律见 aiAutomation.js 的 opSystemPrompt。）
//
// ② **降级路径必须真能用。** 没配 AI 凭据时整条链路不可用，入口要退回 capture.js
//    原有的「手选时间」流程，而不是弹一个报错框把用户堵死。
//
// ③ **课程表不可用时不静默丢数据。** course 类事件降级进收件箱并注明原因 ——
//    宁可让用户多看一眼，也不能让识别结果凭空消失。
import * as S from "./store.js";
import { api } from "./api.js";
import { guessCategory, guessQuad } from "./timeParser.js";
import { extractJson } from "./aiAutomation.js";
import { emitPluginEvent } from "./pluginHost.js";

/** 单次最多接受多少条事件。模型偶尔会把一整张课表铺开成几十条，这里封顶防止刷屏。 */
export const MAX_INGEST_EVENTS = 40;

/** 事件类型白名单 —— 决定这条事件最终写到哪里。 */
export const INGEST_KINDS = ["task", "timeblock", "inbox", "course"];

/**
 * 时间块分类白名单。必须与 `store.js` 的 `CATEGORIES` 完全一致。
 *
 * ⚠️ 是 `sport` 不是 `exercise` —— aiAutomation.js 里曾把 `exercise` 写进白名单，
 * 结果 AI 生成的时间块拿到一个没有 `--cat-*` 变量的分类 id，渲染出来没有配色
 * 也不报错（本次一并修掉）。
 */
export const INGEST_CATS = ["work", "study", "sport", "life", "rest"];

/** 课程表插件 id —— 判断它是否启用、以及往谁广播。 */
export const COURSE_PLUGIN_ID = "shiguang-schedule";

/** 课程表插件接受外部导入的事件名。 */
export const INGEST_COURSES_EVENT = "ingest:courses";

const clone = (x) => structuredClone(x ?? null);

/* ── 基础清洗 ───────────────────────────────────────────── */

/**
 * 校验并归一日期。
 *
 * 除了格式，还要挡掉「格式对但日子不存在」的输入：`2026-02-31` 会被 `new Date`
 * 静默滚到 3 月 3 日，于是模型幻觉出来的日期会悄悄变成另一天的安排。
 */
export function cleanIngestDate(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return "";
  return s;
}

/** 校验并归一 24 小时制时刻，非法返回空串（不是 `"09:00"` —— 空串才代表「没识别到」）。 */
export function cleanIngestTime(v) {
  const s = String(v ?? "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : "";
}

function cleanTitle(v, fallback) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return (s || fallback).slice(0, 160);
}

function clampDuration(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.max(5, Math.min(720, n));
}

/**
 * 取一个区间内的整数，不合格就返回兜底值。
 *
 * 刻意**不做四舍五入**：模型给出 `weekday: 1.5` 或 `weeks: [2.5]` 说明它自己也没想清楚，
 * 圆成 2 会凭空造出一条「周三的课」—— 比直接拒绝危险得多。
 * （时长 `durMin` 是另一回事，连续值四舍五入到分钟是合理的，见 `clampDuration`。）
 */
function intIn(v, min, max, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * 归一课程字段。课程表插件（`shiguang-schedule/model.js` 的 `normalize`）对数据很挑：
 * 星期必须 1~7、周次必须落在学期周数内、节次必须存在于节次表里 —— 任何一条不满足
 * 都会 `fail()` 抛错。所以这里只做**格式与范围**的粗筛，真正的合法性由插件自己再验一遍。
 */
export function normalizeIngestCourse(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const weeks = [...new Set(
    (Array.isArray(c.weeks) ? c.weeks : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 60),
  )].sort((a, b) => a - b);
  const customStartTime = cleanIngestTime(c.customStartTime);
  const customEndTime = cleanIngestTime(c.customEndTime);
  // 「按钟点上课」只有在起止都给全、且结束晚于开始时才成立；否则退回节次模式。
  const isCustomTime = !!(customStartTime && customEndTime && S.mmOf(customEndTime) > S.mmOf(customStartTime));
  return {
    name: cleanTitle(c.name, "未命名课程"),
    teacher: String(c.teacher ?? "").slice(0, 100),
    position: String(c.position ?? "").slice(0, 150),
    weekday: intIn(c.weekday, 1, 7, 1),
    weeks,
    isCustomTime,
    startSection: intIn(c.startSection, 1, 40, 1),
    endSection: intIn(c.endSection, 1, 40, 1),
    customStartTime: isCustomTime ? customStartTime : "",
    customEndTime: isCustomTime ? customEndTime : "",
    remark: String(c.remark ?? "").slice(0, 300),
  };
}

/**
 * 把归一后的 course 字段转成**课程表插件 `model.js` 能吃的形状**。
 *
 * 唯一的字段名转换点：面向模型我们用 `weekday`（1=周一 … 7=周日，模型更容易理解），
 * 而插件 `normalize()` 读的是 `day`。漏了这一步，`int(c.day,1,7,'星期')` 会直接抛
 * 「星期」错误 —— 而且是在插件的广播回调里抛，界面上只看到「导入失败」四个字。
 * 转换只做一次，别在别处再转。
 */
export function toScheduleCourse(course, fallbackName = "未命名课程") {
  const c = course && typeof course === "object" ? course : {};
  return {
    name: c.name || fallbackName,
    teacher: c.teacher || "",
    position: c.position || "",
    day: c.weekday,
    weeks: Array.isArray(c.weeks) ? c.weeks : [],
    isCustomTime: !!c.isCustomTime,
    startSection: c.startSection,
    endSection: c.endSection,
    customStartTime: c.customStartTime || "",
    customEndTime: c.customEndTime || "",
    remark: c.remark || "",
  };
}

/**
 * 把模型返回的一条原始事件归一成可信结构。**纯函数**，是测试的主战场。
 *
 * `base` 只用于「没给日期时猜象限」，不参与日期推算 —— 相对日期（「下周三」）
 * 由模型按提示词里的当前时间自己换算成绝对日期，我们只做格式与范围校验。
 */
export function normalizeIngestEvent(raw, base = new Date()) {
  const src = raw && typeof raw === "object" ? raw : {};
  const kind = INGEST_KINDS.includes(src.kind) ? src.kind : "task";
  const title = cleanTitle(src.title, kind === "course" ? "未命名课程" : "未命名事件");
  const date = cleanIngestDate(src.date);
  const start = cleanIngestTime(src.start);
  let end = cleanIngestTime(src.end);
  // 结束不晚于开始 = 模型把时段搞反了，宁可不写结束时间，也别生成负时长的时间块。
  if (start && end && S.mmOf(end) <= S.mmOf(start)) end = "";

  const cat = INGEST_CATS.includes(src.cat) ? src.cat : guessCategory(title);
  const quad = intIn(src.quad, 1, 4, guessQuad(date || null, base));
  const confRaw = Number(src.confidence);

  return {
    kind,
    title,
    date,
    start,
    end,
    // 给了起止时间就以它为准 —— 模型算出的 durMin 经常和它自己对不上。
    durMin: start && end ? Math.max(5, S.mmOf(end) - S.mmOf(start)) : clampDuration(src.durMin),
    cat,
    quad,
    note: String(src.note ?? "").slice(0, 1000),
    confidence: Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5,
    course: kind === "course" ? normalizeIngestCourse(src.course) : null,
  };
}

/** 批量归一，顺手按上限截断。非数组输入返回空数组而不是抛错。 */
export function normalizeIngestEvents(raw, base = new Date()) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, MAX_INGEST_EVENTS).map((x) => normalizeIngestEvent(x, base));
}

/* ── AI 调用 ────────────────────────────────────────────── */

function ingestSystemPrompt() {
  const now = new Date();
  return `你是 U-Time 应用里的「内容解析器」。用户会给你一段文字、一张截图或一份文档，
你负责把里面的**时间安排**抽成结构化事件。当前本地时间：${now.toLocaleString("zh-CN")}
（星期${"日一二三四五六"[now.getDay()]}，今天日期 ${S.todayStr()}）。

只返回 JSON，不要 Markdown 代码块，不要任何解释文字。格式：
{"summary":"一句话说明你识别到了什么","events":[...]}

每个事件对象：
{"kind":"task|timeblock|inbox|course","title":"简短标题","date":"YYYY-MM-DD 或空串",
 "start":"HH:MM 或空串","end":"HH:MM 或空串","durMin":分钟数,
 "cat":"work|study|sport|life|rest","quad":1-4,"note":"补充说明","confidence":0~1,
 "course":{"name":"课程名","teacher":"教师","position":"上课地点","weekday":1-7,
           "weeks":[周次数组],"startSection":开始节次,"endSection":结束节次,
           "customStartTime":"HH:MM","customEndTime":"HH:MM"}}

判定规则：
- **course**：课表 / 上课安排（含"第X-Y节""周次""星期X"）。weekday 周一=1 … 周日=7。
  weeks 是上课周次数组，如 [1,2,3,4]。有节次就填 startSection/endSection；
  只有钟点（如 08:00-09:40）才填 customStartTime/customEndTime，两者**不要同时填**。
- **timeblock**：有明确日期**且**有开始时间的单次安排（开会、面试、体检）。
- **task**：有截止时间但没说要占哪个时段的待办（交作业、报名截止）。
- **inbox**：信息性内容，暂时不用安排，先收着（通知、公告、群消息）。
- 相对日期（"明天""下周三""本周五"）必须按上面的当前时间换算成绝对日期 YYYY-MM-DD。
- 识别不到的字段一律填空串，**不要编造**。看不清的内容不要猜。
- 最多返回 ${MAX_INGEST_EVENTS} 条事件，按重要性排序。
- 你没有任何文件、命令、网络权限，只做解析，不要输出路径、脚本或 URL 请求。`;
}

/**
 * 检查 AI 凭据是否可用。结果**不做缓存** —— 用户在设置页保存/清除凭据后要立刻生效，
 * 缓存会让入口按钮停留在错误状态。
 */
export async function isAiIngestReady() {
  try {
    const status = await api.aiVaultStatus();
    return !!(status && status.configured);
  } catch {
    return false;
  }
}

/**
 * 分析一段文本 / 一张图片 / 一份文档，返回归一后的事件列表。
 *
 * `imageDataUrl` 是前端压好的 data URL（见 capture.js 的 `fileToDataUrl`，
 * 长边 900px、JPEG 0.82）—— 直接用原图会让 token 账单和失败率一起飙升。
 */
export async function aiAnalyzeContent({ text = "", imageDataUrl = "", fileName = "" } = {}) {
  const plain = String(text ?? "").trim().slice(0, 20000);
  const image = String(imageDataUrl ?? "").trim();
  const name = String(fileName ?? "").trim().slice(0, 120);
  if (!plain && !image) throw new Error("没有可分析的内容");

  let head = "";
  if (name) head += `来源文件：${name}\n`;
  if (plain) head += `内容：\n${plain}`;
  else head += "内容：见附图，请直接读图。";

  const content = image
    ? [
        { type: "text", text: head },
        { type: "image_url", image_url: { url: image } },
      ]
    : head;

  const reply = await api.aiChat([
    { role: "system", content: ingestSystemPrompt() },
    { role: "user", content },
  ], 0.1);

  const parsed = extractJson(reply);
  const events = normalizeIngestEvents(parsed?.events, new Date());
  return {
    summary: String(parsed?.summary ?? "").slice(0, 300) || `识别到 ${events.length} 条内容`,
    events,
  };
}

/* ── 写入路由 ───────────────────────────────────────────── */

function pushIngestInbox(source, { title, when, note }) {
  const st = S.getState();
  st.inbox ??= [];
  st.inbox.unshift({
    id: S.uid("in"),
    status: "new",
    createdAt: Date.now(),
    source,
    title: title.slice(0, 160),
    when: when || null,
    note: String(note ?? "").slice(0, 1000),
  });
  S.touch();
}

/**
 * 判断课程表插件此刻能不能接货。
 *
 * 两个条件都要满足：插件**启用**，且**真的加载成功**了（`enabled` 只代表用户开关，
 * 加载失败时 `runPlugin` 会把 error 写进 registry，此时广播出去没人接）。
 */
function coursePluginUsable() {
  try {
    return S.pluginState(COURSE_PLUGIN_ID).enabled !== false;
  } catch {
    return false;
  }
}

/**
 * 执行事件列表，把它们写进对应的落点。
 *
 * 入参可以是**原始**事件（模型刚返回的、或用户刚编辑过的）也可以是归一后的 ——
 * 函数内部会先过一遍 `normalizeIngestEvents`，见下面那行注释里的事故记录。
 *
 * 返回 `{applied, skipped, routed, courses, courseHandled, courseDegraded, before}`：
 * - `before` 是写入前的快照，供调用方做「撤销」；
 * - `courseHandled` / `courseDegraded` 必须分开报：前者是真写进课表了，
 *   后者是课程表不可用、改投收件箱 —— 混成一个数字，界面就没法如实告诉用户东西去哪了。
 *
 * 冲突处理沿用 aiAutomation 的纪律：**不覆盖已有时间块**，改投收件箱让用户自己决定。
 */
export async function applyIngestEvents(rawEvents, { source = "AI 解析", attachments = [] } = {}) {
  // 进来先归一 —— **不能**假设调用方已经归一过了。
  // 少了这一步，一条没带 durMin 的原始事件会以 `durMin: undefined` 落进 store：
  // `addBlock` 的 `{ ...patch }` 把默认的 30 分钟覆盖成 undefined，最终得到一个
  // 没有时长的时间块，而冲突检测靠 `b.durMin` 算区间 ⇒ 之后所有排程检查全部失效。
  // 归一本身是幂等的，所以确认面板提前归一过也没关系。
  const list = normalizeIngestEvents(rawEvents, new Date());
  // 附件只收内联图片 data URL：时间块没有附件字段，所以只挂到任务上 ——
  // 让截图跟任务一起留着，事后能回头核对 AI 读得对不对。
  const files = (Array.isArray(attachments) ? attachments : [])
    .filter((x) => typeof x === "string" && /^data:image\//i.test(x))
    .slice(0, 3);
  const st = S.getState();
  const before = { tasks: clone(st.tasks), blocks: clone(st.blocks), inbox: clone(st.inbox) };
  const routed = { task: 0, timeblock: 0, inbox: 0, course: 0 };
  let applied = 0;
  let skipped = 0;
  const courses = [];
  let courseDegraded = 0;

  const canCourse = coursePluginUsable();

  for (const ev of list) {
    if (!ev || !ev.title) { skipped++; continue; }
    try {
      if (ev.kind === "course") {
        if (!canCourse) {
          // 红线③：不静默丢数据 —— 降级进收件箱并写明原因。
          pushIngestInbox(source, {
            title: `课程：${ev.title}`,
            when: ev.date,
            note: `课程表插件未启用，未能写入课表。识别到的课程信息：${JSON.stringify(ev.course)}`,
          });
          courseDegraded++;
          skipped++;
          continue;
        }
        courses.push(toScheduleCourse(ev.course, ev.title));
        applied++;
        continue;
      }

      if (ev.kind === "inbox") {
        pushIngestInbox(source, { title: ev.title, when: ev.date, note: ev.note });
        routed.inbox++;
        applied++;
        continue;
      }

      if (ev.kind === "timeblock") {
        if (!ev.date || !ev.start) { skipped++; continue; }
        const startMin = S.mmOf(ev.start);
        const conflict = S.blocksOf(ev.date).some(
          (b) => startMin < S.mmOf(b.start) + Number(b.durMin || 0) && startMin + ev.durMin > S.mmOf(b.start),
        );
        if (conflict) {
          pushIngestInbox(source, {
            title: `排程冲突：${ev.title}`,
            when: ev.date,
            note: `${ev.start} · ${ev.durMin} 分钟，未自动覆盖已有时间块。`,
          });
          skipped++;
          continue;
        }
        S.addBlock({
          date: ev.date,
          start: ev.start,
          durMin: ev.durMin,
          title: ev.title,
          cat: ev.cat,
          note: ev.note,
        });
        routed.timeblock++;
        applied++;
        continue;
      }

      // 兜底：task（也是未知 kind 的归一结果）
      S.addTask({
        title: ev.title,
        due: ev.date || null,
        dueTime: ev.start || "23:59",
        quad: ev.quad,
        estMin: ev.durMin,
        tags: ["AI解析"],
        note: ev.note,
        ...(files.length ? { attachments: [...files] } : {}),
      });
      routed.task++;
      applied++;
    } catch {
      skipped++;
    }
  }

  // 课程统一广播一次：插件侧做 normalize + merge + persist，避免核心直接写
  // 插件 storage 造成「插件内存副本把新数据覆盖回去」（见课程表 ui.js 的 loadAll 缓存）。
  let courseHandled = 0;
  if (courses.length) {
    const results = await emitPluginEvent(INGEST_COURSES_EVENT, { courses, source });
    const ok = results.find((r) => r.ok);
    if (ok) {
      courseHandled = courses.length;
      routed.course = courses.length;
    } else {
      // 广播出去没人接（插件加载失败 / 被禁用）⇒ 同样降级进收件箱，不丢。
      for (const c of courses) {
        pushIngestInbox(source, {
          title: `课程：${c.name}`,
          when: null,
          note: `课程表插件未能接收（${results[0]?.error || "没有可用的处理方"}），识别结果：${JSON.stringify(c)}`,
        });
      }
      courseDegraded += courses.length;
      applied -= courses.length;
      skipped += courses.length;
    }
  }

  return {
    applied,
    skipped,
    routed,
    courses: courses.length,
    courseHandled,
    courseDegraded,
    before,
  };
}

/** 撤销一次 `applyIngestEvents`：把快照写回去。课程表侧由插件自己提供撤销入口。 */
export function revertIngest(before) {
  if (!before) return;
  const st = S.getState();
  if (Array.isArray(before.tasks)) st.tasks = clone(before.tasks);
  if (Array.isArray(before.blocks)) st.blocks = clone(before.blocks);
  if (Array.isArray(before.inbox)) st.inbox = clone(before.inbox);
  S.touch();
}
