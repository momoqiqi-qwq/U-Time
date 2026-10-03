import { readProductSource } from "./lib/read-product-source.mjs";
// AI 文档 / 图片解析管线：脏数据兜底、路由分派、降级不丢数据。
//
// 为什么这个测试重点在「脏数据」：这条链路的输入是**大模型的自由文本**，
// 它随时会返回 `2026-02-31`、`end` 早于 `start`、`cat:"exercise"`（应用里没有这个分类）、
// `durMin: -30`。这些值如果不拦，会变成「用户日历里一条看不见颜色的 2 小时块」
// 或者「静默滚到 3 月 3 日的安排」—— 不报错，但数据是坏的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../src/store.js';

const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readProductSource(path.join(root, rel), 'utf8');

/**
 * 去掉块注释再断言。
 *
 * 断言要查的是**代码**里有没有旧写法，而注释里往往正引用着那个旧写法当反面教材
 * （aiAutomation.js 的 `CAT_IDS` 上方就写着「曾经抄成 exercise」）——
 * 不去注释就会把「记录教训」误判成「又犯了」。
 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ');

const A = await import('../src/aiIngest.js');

const EMPTY = () => ({ tasks: [], blocks: [], inbox: [], settings: {}, plugins: {}, automation: {} });
await S.initStore(EMPTY());

/* ── 1. 日期校验：格式对但日子不存在必须挡掉 ──────────────────────────── */
assert.equal(A.cleanIngestDate('2026-03-05'), '2026-03-05', '正常日期通过');
// 关键用例：2026-02-31 会被 new Date 静默滚到 3 月 3 日，于是幻觉日期变成另一天
assert.equal(A.cleanIngestDate('2026-02-31'), '', '不存在的日子必须被挡掉');
assert.equal(A.cleanIngestDate('2026-13-01'), '', '月份越界必须被挡掉');
assert.equal(A.cleanIngestDate('2026-3-5'), '', '非补零格式不接受');
assert.equal(A.cleanIngestDate(''), '', '空串返回空串');
assert.equal(A.cleanIngestDate(null), '', 'null 返回空串');
assert.equal(A.cleanIngestDate('2026-02-28'), '2026-02-28', '闰年 2 月 28 通过');

/* ── 2. 时刻校验 ─────────────────────────────────────────────────── */
assert.equal(A.cleanIngestTime('08:30'), '08:30');
assert.equal(A.cleanIngestTime('24:00'), '', '24:00 不是合法时刻');
assert.equal(A.cleanIngestTime('8:30'), '', '必须两位小时');
assert.equal(A.cleanIngestTime('08:60'), '', '分钟越界');
assert.equal(A.cleanIngestTime(undefined), '', 'undefined 返回空串');

/* ── 3. 分类白名单必须与 store.js 的 CATEGORIES 一致 ──────────────────
   这条是防回归：aiAutomation.js 曾经手抄白名单并写成 "exercise"，
   而应用里根本没有这个分类 —— AI 生成的时间块会拿到一个没有 --cat-* 变量的
   分类 id，渲染出来没有配色、catLabel 直接回显 id，全程不报错。 */
assert.deepEqual(
  [...A.INGEST_CATS].sort(),
  S.CATEGORIES.map((c) => c.id).sort(),
  'INGEST_CATS 必须与 store.js 的 CATEGORIES 完全一致',
);
assert.ok(!A.INGEST_CATS.includes('exercise'), 'exercise 不是本应用的分类 id');
const aiAutomation = read('src/aiAutomation.js');
assert.doesNotMatch(codeOf(aiAutomation), /["']exercise["']/, 'aiAutomation 代码里不许再出现 exercise');
assert.match(aiAutomation, /const CAT_IDS = new Set\(S\.CATEGORIES/, 'aiAutomation 必须从 CATEGORIES 取分类，不许手抄');

/* ── 4. 单条事件归一：脏数据兜底 ────────────────────────────────────── */
const base = new Date(2026, 8, 18); // 2026-09-18 周五

const unknownKind = A.normalizeIngestEvent({ kind: 'delete_everything', title: '恶意类型' }, base);
assert.equal(unknownKind.kind, 'task', '未知 kind 落到 task，绝不能透传');

const badCat = A.normalizeIngestEvent({ kind: 'timeblock', title: '跑步五公里', cat: 'exercise' }, base);
assert.ok(A.INGEST_CATS.includes(badCat.cat), `未知分类必须兜底成合法分类，实得 ${badCat.cat}`);

const reversed = A.normalizeIngestEvent({ kind: 'timeblock', title: '面试', date: '2026-09-20', start: '15:00', end: '14:00' }, base);
assert.equal(reversed.end, '', '结束早于开始 ⇒ 清空 end，不许生成负时长');
assert.equal(reversed.durMin, 60, '清空 end 后时长回落默认 60');

const span = A.normalizeIngestEvent({ kind: 'timeblock', title: '开会', date: '2026-09-20', start: '14:00', end: '15:30' }, base);
assert.equal(span.durMin, 90, '起止都给全时以起止为准算时长');

const hugeDur = A.normalizeIngestEvent({ kind: 'task', title: '写论文', durMin: 99999 }, base);
assert.equal(hugeDur.durMin, 720, '时长上限 720 分钟');
const negDur = A.normalizeIngestEvent({ kind: 'task', title: '写论文', durMin: -30 }, base);
assert.equal(negDur.durMin, 60, '负时长回落默认值');

assert.equal(A.normalizeIngestEvent({ kind: 'task', title: '   ' }, base).title, '未命名事件', '空白标题兜底');
assert.equal(A.normalizeIngestEvent({ kind: 'task', title: 'x'.repeat(500) }, base).title.length, 160, '标题截断到 160');
assert.equal(A.normalizeIngestEvent({ kind: 'task', title: 'a', confidence: 5 }, base).confidence, 1, '置信度上限 1');
assert.equal(A.normalizeIngestEvent({ kind: 'task', title: 'a', confidence: -3 }, base).confidence, 0, '置信度下限 0');
assert.equal(A.normalizeIngestEvent({ kind: 'task', title: 'a', confidence: 'abc' }, base).confidence, 0.5, '非数值置信度回落 0.5');
assert.equal(A.normalizeIngestEvent({ kind: 'task', title: 'a', quad: 99 }, base).quad, 2, '越界象限回落推测值');

// 非对象输入不能炸
for (const bad of [null, undefined, 'str', 42, []]) {
  const ev = A.normalizeIngestEvent(bad, base);
  assert.equal(ev.kind, 'task', `非对象输入 ${JSON.stringify(bad)} 也要归一成 task`);
  assert.ok(ev.title, '非对象输入也要有标题');
}

/* ── 5. 课程字段归一 ──────────────────────────────────────────────── */
const c1 = A.normalizeIngestCourse({ name: '高等数学', weekday: 9, weeks: [3, 1, 1, 99, 0, 2.5], startSection: 1, endSection: 2 });
assert.equal(c1.weekday, 1, '星期越界回落 1');
// 2.5 被**拒绝**而不是圆成 3 —— 模型给半个周次说明它自己没想清楚，
// 圆整会凭空造出一周本来没有的课。
assert.deepEqual(c1.weeks, [1, 3], '周次去重、排序、剔除越界与非整数');
assert.equal(A.normalizeIngestCourse({ name: 'x', weekday: 1.5 }).weekday, 1, '非整数星期不四舍五入');
assert.equal(A.normalizeIngestCourse({ name: 'x', startSection: 2.5, endSection: 4 }).startSection, 1, '非整数节次不四舍五入');
assert.equal(c1.isCustomTime, false, '没给钟点 ⇒ 按节次模式');

const c2 = A.normalizeIngestCourse({ name: '英语', customStartTime: '10:00', customEndTime: '09:00' });
assert.equal(c2.isCustomTime, false, '钟点倒置 ⇒ 退回节次模式，不许生成负时长课程');

const c3 = A.normalizeIngestCourse({ name: '英语', customStartTime: '10:00', customEndTime: '11:40' });
assert.equal(c3.isCustomTime, true, '钟点齐全且正序 ⇒ 按钟点上课');
assert.equal(c3.customStartTime, '10:00');

const c4 = A.normalizeIngestCourse({});
assert.equal(c4.name, '未命名课程', '课程名兜底');
assert.equal(c4.startSection, 1, '节次越界回落 1');

/* ── 5b. 交给课程表插件的字段名转换 ────────────────────────────────────
   面向模型的 schema 用 `weekday`，而插件 model.js 的 normalize() 读的是 `day`。
   漏了这层映射，插件会在广播回调里抛「星期」错误 —— 界面上只看到「导入失败」四个字，
   排查成本很高。这是两套命名之间**唯一**的转换点。 */
const sc = A.toScheduleCourse(
  A.normalizeIngestCourse({ name: '高等数学', teacher: '张老师', position: 'A101', weekday: 3, weeks: [1, 2], startSection: 5, endSection: 6 }),
);
assert.equal(sc.day, 3, 'toScheduleCourse 必须把 weekday 映射成插件要的 day');
assert.equal(sc.weekday, undefined, '不许把 weekday 一起透传（插件不认这个字段）');
assert.equal(sc.name, '高等数学');
assert.equal(sc.position, 'A101');
assert.equal(sc.startSection, 5);
assert.equal(sc.isCustomTime, false);
assert.equal(A.toScheduleCourse(null, '兜底名').name, '兜底名', '空课程也要有名字');
assert.deepEqual(A.toScheduleCourse(null).weeks, [], '空课程周次是空数组而不是 undefined（插件要 .join）');

/* ── 6. 批量归一 ──────────────────────────────────────────────────── */
assert.deepEqual(A.normalizeIngestEvents(null, base), [], '非数组输入返回空数组');
assert.deepEqual(A.normalizeIngestEvents('nope', base), [], '字符串输入返回空数组');
const many = A.normalizeIngestEvents(Array.from({ length: 200 }, (_, i) => ({ kind: 'task', title: `t${i}` })), base);
assert.equal(many.length, A.MAX_INGEST_EVENTS, `批量上限 ${A.MAX_INGEST_EVENTS} 条`);

/* ── 7. 路由写入 ──────────────────────────────────────────────────── */
S.replaceAll(EMPTY());
const today = S.todayStr();

let res = await A.applyIngestEvents([
  { kind: 'task', title: '交作业', date: today, quad: 1, estMin: 45, cat: 'study' },
  { kind: 'inbox', title: '班群通知', date: today },
], { source: '单测' });
assert.equal(res.routed.task, 1, 'task 进任务');
assert.equal(res.routed.inbox, 1, 'inbox 进收件箱');
assert.equal(S.getState().tasks.length, 1);
assert.equal(S.getState().inbox.length, 1);
assert.equal(S.getState().inbox[0].source, '单测', '收件箱条目要带来源');
assert.equal(S.getState().tasks[0].tags.includes('AI解析'), true, 'AI 创建的任务要打标签');

// 时间块：正常落位
S.replaceAll(EMPTY());
res = await A.applyIngestEvents([
  { kind: 'timeblock', title: '体检', date: today, start: '09:00', end: '10:00', cat: 'life' },
], { source: '单测' });
assert.equal(res.routed.timeblock, 1, '时间块正常落位');
assert.equal(S.getState().blocks.length, 1);
assert.equal(S.getState().blocks[0].start, '09:00');
assert.equal(S.getState().blocks[0].cat, 'life');
// 回归钉子：传进来的是**原始**事件（没带 durMin），落库的块必须自己算出时长。
// 曾经漏了这一步 —— addBlock 的 `{...patch}` 把默认 30 覆盖成 undefined，
// 落库一个没有 durMin 的块，冲突检测（靠 b.durMin 算区间）从此静默失效。
assert.equal(S.getState().blocks[0].durMin, 60, '原始事件也要落出真实时长，不能是 undefined');

// 时间块冲突：**不许覆盖**，改投收件箱
res = await A.applyIngestEvents([
  { kind: 'timeblock', title: '冲突会议', date: today, start: '09:30', end: '10:30' },
], { source: '单测' });
assert.equal(res.routed.timeblock, 0, '冲突时不许落位');
assert.equal(S.getState().blocks.length, 1, '原有时间块必须原样保留');
assert.equal(S.getState().inbox[0].title, '排程冲突：冲突会议', '冲突转收件箱并写明原因');

// 缺日期/开始时间的 timeblock 直接跳过，不能变成「今天 09:00」这种瞎猜
S.replaceAll(EMPTY());
res = await A.applyIngestEvents([{ kind: 'timeblock', title: '没时间的安排' }], { source: '单测' });
assert.equal(res.applied, 0, '缺日期与开始时间的时间块不写入');
assert.equal(res.skipped, 1, '记一次跳过');
assert.equal(S.getState().blocks.length, 0);

/* ── 8. 课程路由：没有订阅者时必须降级进收件箱，不许静默丢 ───────────── */
S.replaceAll(EMPTY());
res = await A.applyIngestEvents([
  { kind: 'course', title: '高等数学', course: { name: '高等数学', weekday: 1, weeks: [1, 2], startSection: 1, endSection: 2 } },
], { source: '单测' });
assert.equal(res.courseDegraded, 1, '课程表不可用 ⇒ 记一次降级');
assert.equal(res.courseHandled, 0, '没有处理方就不算交接成功');
assert.equal(S.getState().inbox.length, 1, '降级的课程必须进收件箱（红线：不静默丢数据）');
assert.match(S.getState().inbox[0].title, /^课程：高等数学/, '收件箱标题要能看出是课程');

// 插件显式禁用时走的是另一条降级分支
S.replaceAll(EMPTY());
S.pluginState(A.COURSE_PLUGIN_ID).enabled = false;
res = await A.applyIngestEvents([
  { kind: 'course', title: '线性代数', course: { name: '线性代数', weekday: 2, weeks: [1] } },
], { source: '单测' });
assert.equal(res.courseDegraded, 1, '插件被禁用也要降级');
assert.match(S.getState().inbox[0].note, /课程表插件未启用/, '降级原因要写清楚');

/* ── 9. 撤销 ──────────────────────────────────────────────────────── */
S.replaceAll(EMPTY());
const snap = await A.applyIngestEvents([{ kind: 'task', title: '可撤销任务' }], { source: '单测' });
assert.equal(S.getState().tasks.length, 1);
A.revertIngest(snap.before);
assert.equal(S.getState().tasks.length, 0, '撤销要把任务还原');
A.revertIngest(null); // 空快照不能炸

/* ── 10. 静态契约：安全边界与接线 ──────────────────────────────────── */
const ingest = read('src/aiIngest.js');
assert.doesNotMatch(ingest, /readPluginFile|deletePlugin|importPluginZip|saveDownload/,
  'AI 解析管线不得触碰插件文件与下载目录');
assert.doesNotMatch(ingest, /child_process|exec\(|spawn\(/, 'AI 解析管线不得执行命令');
assert.match(ingest, /emitPluginEvent\(INGEST_COURSES_EVENT/, '课程必须走事件广播交给插件');

const host = read('src/pluginHost.js');
assert.match(host, /export async function emitPluginEvent/, '宿主必须导出 emitPluginEvent');
assert.match(host, /entry\.fn\(data\)/, 'emitPluginEvent 必须真的调用订阅者');

// Rust：多模态与图片护栏
const rust = read('src-tauri/src/lib.rs');
assert.match(rust, /content: serde_json::Value/, 'AiMessage.content 必须是 Value 才能透传多模态');
assert.match(rust, /fn inspect_ai_content/, '必须有 content 校验函数');
assert.match(rust, /AI_IMAGE_DATA_URL_MAX_CHARS/, '必须有单图体积上限');
assert.match(rust, /AI_IMAGE_MAX_COUNT/, '必须有图片张数上限');
assert.match(rust, /data:image\//, '必须只接受内联 data:image 图片（拒绝远程 URL）');
assert.match(rust, /inspect_ai_content\(&m\.content\)\?/, 'ai_chat 必须逐条走校验');

// 课程表插件：权限 + 订阅 + 落盘链路
const schedManifest = JSON.parse(read('public/plugins/shiguang-schedule/manifest.json'));
assert.ok(schedManifest.permissions.includes('events'), '课程表 manifest 必须声明 events 权限');
const schedUi = read('public/plugins/shiguang-schedule/ui.js');
assert.match(schedUi, /tide\.events\.on\('ingest:courses'/, '课程表必须订阅 ingest:courses');
assert.match(schedUi, /M\.mergeTables\(table,added\)/, '导入必须走 mergeTables，不能整体替换课表');
assert.match(schedUi, /timeSlots:table\.timeSlots/, '校验节次必须用当前课表的节次表');
const schedMain = read('public/plugins/shiguang-schedule/main.js');
assert.ok(schedMain.includes("tide.events.on('ingest:courses'"), '生成物 main.js 必须包含订阅（否则白改 ui.js）');

// 入口：降级路径必须还在
const capture = read('src/capture.js');
assert.match(capture, /isAiIngestReady/, '入口必须先探测 AI 可用性');
assert.match(capture, /openCaptureModal\(dataUrl, text\)/, 'AI 不可用时必须退回手选时间弹窗');
assert.match(capture, /parseWhen\(text\)\.date\) \{ handleText\(text\); return; \}/, '文本必须先试本地规则解析再考虑 AI');

// 确认面板：AI 结果必须先过确认再落盘
const panel = read('src/views/ingestPanel.js');
assert.match(panel, /applyIngestEvents/, '确认面板负责落盘');
assert.match(panel, /normalizeIngestEvent\(\{/, '面板里改过的值要重新过归一');

console.log('PASS: AI 文档/图片解析 —— 脏数据兜底、路由分派、课程降级不丢数据、安全边界');
