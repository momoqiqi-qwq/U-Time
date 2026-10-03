import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 四象限卡片拖拽排序回归测试 —— v0.52.0
 *
 * 守住这几件事（静态断言守源码不变量）：
 *   ① store：moveTaskRelative 存在且只允许「同象限 + 同完成态」换位；
 *      order 懒回填（首次拖拽才写 0..n-1）；tasksOfQuad 排序 order 优先、done 仍是最外层分组键。
 *   ② quadrant：指针拖拽模块存在（桌面 ≥6px 即拖 / 触屏长按 240ms）、幽灵卡跟随、
 *      WAAPI FLIP 让位与落位接续、松手写回 store、reducedMotion 全程短路动画。
 *   ③ 手势让路：拖拽会话置 body[data-swipe-suspended]（滑动返回在 touchend 检查并让路），
 *      且清除必须延迟（pointerup 先于 touchend 发出，立即清会漏掉同一次触摸）。
 *   ④ 长按拖拽期间不弹右键菜单（dragReorder 标志守卫 contextmenu）。
 *   ⑤ 键盘可达：Alt+↑/↓ 重排、焦点回到被移动的卡片、跨完成态边界忽略。
 *   ⑥ 跨象限：指针落在哪个象限就移入哪个象限，并保持完成项沉底。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readProductSource(path.join(here, rel), "utf8");

const storeJs = read("../src/store.js");
const quadrantJs = read("../src/views/quadrant.js");
const shellJs = read("../src/shell.js");
const styles = read("../src/styles.css");

/* ── ① store：order 语义 ── */
assert.match(storeJs, /export function moveTaskRelative\(dragId, overId, before = true\)/,
  "store 必须导出 moveTaskRelative(dragId, overId, before)");
assert.match(storeJs, /over\.quad !== drag\.quad \|\| over\.done !== drag\.done/,
  "moveTaskRelative 必须拒绝跨象限 / 跨完成态换位（完成沉底语义不破坏）");
assert.match(storeJs, /seq\.forEach\(\(t, i\) => \{ t\.order = i; \}\)/,
  "moveTaskRelative 必须懒回填 order（首次拖拽才写 0..n-1，老数据无迁移）");
assert.match(storeJs, /export function moveTaskToQuad\(dragId, targetQuad, overId = null, before = true\)/,
  "store 必须导出跨象限移动入口 moveTaskToQuad");
// 排序键必须与 tasksOfQuad 完全对齐：createdAt 尾键会让「插到相邻卡前面」在
// DOM 序与 store 序里落点不同（真浏览器探针抓到：拖拽落点跳位），不许回潮
const moveBlock = storeJs.slice(storeJs.indexOf("export function moveTaskRelative"), storeJs.indexOf("/* ── 插件状态 ── */"));
assert.ok(moveBlock.length > 0, "没找到 moveTaskRelative 代码块");
const moveCode = moveBlock.replace(/\/\/[^\n]*/g, ""); // 剥行注释：函数内的解释注释含「createdAt」字样属正常文档
assert.ok(!/createdAt/.test(moveCode),
  "moveTaskRelative 的 seq 排序键不得掺 createdAt —— 必须与 tasksOfQuad（done→order→due）完全一致，回填基准才是渲染序");
assert.equal((moveBlock.match(/\.sort\(compareTasks\)/g) || []).length, 2,
  "同象限与跨象限拖拽必须复用显示列表的排序规则");
// 探针抓到的第 2 个坑：FLIP 让位动画进行中，卡片的 getBoundingClientRect 含残余 transform，
// 槽位判定会被污染到动画中间态（落点跳位）→ computeSlot 只许 offsetHeight + rowGap 几何推演
const slotBlock = quadrantJs.slice(
  quadrantJs.indexOf("const computeSlot = (st, y) => {"),
  quadrantJs.indexOf("const reorderDOM = (st, k) => {"));
assert.ok(slotBlock.length > 0, "没找到 computeSlot 代码块");
assert.match(slotBlock, /st\.h\[c\.dataset\.id\] \|\| c\.offsetHeight/,
  "computeSlot 必须用 beginDrag 缓存的高度（st.h）或 offsetHeight 推演卡片位置");
assert.match(slotBlock, /st\.gap/,
  "computeSlot 必须用列表 rowGap（st.gap）递推卡间距，不许逐卡量 rect");
{
  const slotCode = slotBlock.replace(/\/\/[^\n]*/g, ""); // 剥行注释：函数内解释注释含「getBoundingClientRect」字样属正常文档
  const withoutListTop = slotCode.replace(/list\.getBoundingClientRect\(\)\.top/g, "");
  assert.ok(!withoutListTop.includes("getBoundingClientRect"),
    "computeSlot 里禁止对卡片调 getBoundingClientRect —— FLIP 动画进行中 rect 含 transform 残留（列表自身 top 读取不受限）");
}
// 探针抓到的第 3 个坑：setPointerCapture 失败 / 指针在列表外松手时，事件不会冒泡回 list，
// 会话挂死（幽灵卡不消失、顺序不落库）→ 必须有 document 捕获阶段兜底，会话结束必须摘除
assert.match(quadrantJs, /document\.addEventListener\("pointerup", st\.docUp, true\)/,
  "必须有 document 捕获阶段 pointerup 兜底（capture=true），否则列表外松手会话挂死");
assert.match(quadrantJs, /document\.addEventListener\("pointercancel", st\.docCancel, true\)/,
  "必须有 document 捕获阶段 pointercancel 兜底");
assert.match(quadrantJs, /document\.removeEventListener\("pointerup", st\.docUp, true\)/,
  "会话结束必须摘除 document pointerup 兜底监听（detachDoc，防泄漏重复触发）");
assert.match(quadrantJs, /document\.removeEventListener\("pointercancel", st\.docCancel, true\)/,
  "会话结束必须摘除 document pointercancel 兜底监听");
assert.match(quadrantJs, /detachDoc\(st\)/, "endSession 必须经 detachDoc 摘除兜底监听");
assert.match(quadrantJs, /try \{ st\.card\.setPointerCapture\(st\.pointerId\); \} catch/,
  "setPointerCapture 必须包 try/catch（部分环境拿不到 capture，靠 document 兜底）");
const sortBlock = storeJs.slice(storeJs.indexOf("function compareTasks"), storeJs.indexOf("export function moveTaskRelative"));
assert.match(sortBlock, /\.sort\(compareTasks\)/, "tasksOfQuad 必须使用共享排序规则");
assert.match(sortBlock, /\(a\.order \?\? Infinity\) - \(b\.order \?\? Infinity\)/,
  "tasksOfQuad 排序必须先比显式 order（无 order 兜底 Infinity 落回 due 规则）");
assert.match(sortBlock, /Number\(a\.done\) - Number\(b\.done\)/,
  "tasksOfQuad 的 done 必须仍是最外层分组键（完成的永远沉底，order 只在组内生效）");

/* ── ② quadrant：拖拽模块 ── */
assert.match(quadrantJs, /function attachListDrag\(list\)/, "必须存在 attachListDrag 拖拽模块");
assert.match(quadrantJs, /Math\.hypot\(dx, dy\) >= 6/,
  "桌面（mouse）移动 ≥6px 即进入拖拽");
assert.match(quadrantJs, /setTimeout\(\(\) => \{ if \(pd && pd\.card === card && !pd\.active\) beginDrag\(pd, pd\.x, pd\.y\); \}, 240\)/,
  "触屏必须长按 240ms 才进入拖拽（期间移动视为滚动意图）");
assert.match(quadrantJs, /Math\.abs\(dx\) > 8 \|\| Math\.abs\(dy\) > 8/,
  "触屏长按期间移动 >8px 必须取消长按（让位给列表滚动）");
assert.match(quadrantJs, /classList\.add\("drag-ghost"\)/,
  "拖拽必须有幽灵卡（drag-ghost 克隆卡跟随指针，用户点名要拖拽动画）");
assert.match(quadrantJs, /moveGhost\(st, x, y\)/, "幽灵卡必须跟随指针移动");
assert.match(quadrantJs, /\.animate\(\[\{ transform: `translateY\(\$\{dy\}px\)` \}/,
  "让位必须用 WAAPI FLIP（旧位置 → 新位置平滑滑动），不能瞬移");
assert.match(quadrantJs, /newCard\.animate\(/,
  "松手后新卡必须从幽灵落点平滑接位（拖拽动画的收尾一拍）");
assert.match(quadrantJs, /S\.moveTaskRelative\(dragId, next\.dataset\.id, true\)/,
  "松手必须把顺序写回 store（moveTaskRelative），不能只改 DOM");
assert.match(quadrantJs, /document\.elementFromPoint\(x, y\)\?\.closest\?\.\("\.q\[data-quad\]"\)/,
  "拖动时必须用指针坐标识别目标象限");
assert.match(quadrantJs, /S\.moveTaskToQuad\(dragId, targetQuad, targetOverId, true\)/,
  "跨象限松手必须把象限与落点写回 store");
assert.match(quadrantJs, /import \{ reducedMotion \} from "\.\.\/motion\.js"/,
  "quadrant 必须引入 reducedMotion()");
assert.match(quadrantJs, /if \(!reducedMotion\(\)\) \{\s*\n\s*const ghost/,
  "reducedMotion 时不得创建幽灵卡（直接半透明占位）");
assert.match(quadrantJs, /if \(reducedMotion\(\)\) return;\s*\n\s*cards\.forEach/,
  "reducedMotion 时 FLIP 让位必须短路");
assert.match(quadrantJs, /navigator\.vibrate\?\.\(10\)/,
  "触屏进入拖拽要有触觉反馈（不支持的环境静默）");

/* ── ③ 手势让路：swipeSuspended ── */
assert.match(quadrantJs, /document\.body\.dataset\.swipeSuspended = "1"/,
  "拖拽会话开始必须置 body[data-swipe-suspended=1]（滑动返回让路）");
assert.match(quadrantJs, /setTimeout\(\(\) => \{ if \(!pd\?\.active && document\.body\.dataset\.cardSwipe !== "1"\) delete document\.body\.dataset\.swipeSuspended; \}, 80\)/,
  "swipeSuspended 清除必须延迟 80ms：pointerup 先于 touchend 发出，立即清会把拖拽误判成滑动返回");
const swipeAt = shellJs.indexOf("内容区左右滑动 = 返回上一页");
assert.ok(swipeAt > -1, "shell 滑动段注释锚存在");
const swipeBlock = shellJs.slice(swipeAt).match(/addEventListener\("touchend"[\s\S]*?\}, \{ passive: true \}\);/)?.[0] ?? "";
assert.ok(swipeBlock, "shell 滑动段必须有 touchend 监听");
assert.match(swipeBlock, /document\.body\.dataset\.swipeSuspended === "1"/,
  "shell touchend 必须检查 swipeSuspended：拖拽卡片的横移满足滑动阈值，不拦会误触发返回");

/* ── ④ 长按不弹菜单 ── */
assert.match(quadrantJs, /document\.body\.dataset\.dragReorder === "1" \|\| document\.body\.dataset\.cardSwipe === "1"\) return;/,
  "卡片 contextmenu 必须守卫 dragReorder：触屏长按进入拖拽时浏览器会补发 contextmenu");
assert.match(quadrantJs, /document\.body\.dataset\.dragReorder = "1"/,
  "拖拽会话开始必须置 body[data-drag-reorder=1]");

/* ── ⑤ 键盘重排 ── */
assert.match(quadrantJs, /e\.key !== "ArrowUp" && e\.key !== "ArrowDown"/,
  "必须支持 Alt+↑/↓ 键盘重排");
assert.match(quadrantJs, /S\.moveTaskRelative\(id, seq\[j\]\.id, dir < 0\)/,
  "键盘重排必须走 moveTaskRelative（与拖拽同一条 store 路径）");
assert.match(quadrantJs, /list\.querySelector\(`\.tkc\[data-id="\$\{id\}"\]`\)\?\.focus\(\)/,
  "键盘重排后焦点必须回到被移动的卡片（支持连续按键）");
assert.match(quadrantJs, /while \(j >= 0 && j < seq\.length && seq\[j\]\.done !== seq\[i\]\.done\) j \+= dir;/,
  "键盘重排必须跳过不同完成态的任务（到边界忽略），跨组会破坏沉底语义");

/* ── ⑥ CSS：状态类与动画 ── */
assert.match(styles, /\.tkc\.dragging \{ opacity: \.3/, "被拖卡必须有半透明占位样式");
assert.match(styles, /\.tkc\.drag-ghost \{ position: fixed/, "幽灵卡必须是 fixed 定位跟随指针");
assert.match(styles, /\.tks\.drag-live \{ cursor: grabbing/, "拖拽会话中列表要有 grabbing 光标");
assert.match(styles, /\.q\.quad-drop-target \{ outline:/, "跨象限落点必须有可视高亮");
assert.match(styles, /@keyframes plug-bulk-pop/, "批量勾选要有错落弹起动画");
assert.match(styles, /@keyframes plug-bulk-check/, "勾选框本身也要有弹跳动画");
assert.match(styles, /\.plug-card\.bulk-pop \{ animation: plug-bulk-pop \.42s cubic-bezier\(\.22, \.8, \.22, 1\) both; animation-delay: var\(--bi, 0ms\); \}/,
  "错落延迟必须走 --bi 变量（JS 按序写 45ms 递增）");
assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.plug-card\.bulk-pop, \.plug-card\.bulk-pop \.plugin-select input \{ animation: none; \}/,
  "CSS 端必须有 prefers-reduced-motion 兜底（JS 端 reducedMotion() 之外的第二道保险）");

console.log("PASS: 四象限拖拽排序（store order 懒回填 / 幽灵卡 + FLIP 动画 / swipe 让路 / 长按守卫 / 键盘重排 / reducedMotion）");

/* ── ⑦ 行为面：把 store 的 moveTaskRelative / tasksOfQuad 真跑起来 ──
 * 使用内存 localStorage，加载空数据时回退 seed，保存也可正常完成。 */
const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };
const S = await import("../src/store.js?behavior=1");
await S.initStore({
  tasks: [
    { id: "tA", title: "A（早截止）", quad: 1, done: false, due: "2026-01-01", createdAt: 1 },
    { id: "tB", title: "B（晚截止）", quad: 1, done: false, due: "2026-06-01", createdAt: 2 },
    { id: "tC", title: "C（无截止）", quad: 1, done: false, due: null, createdAt: 3 },
    { id: "tD", title: "D（已完成）", quad: 1, done: true, due: "2026-02-01", createdAt: 4 },
    { id: "tE", title: "E（另一象限）", quad: 2, done: false, due: null, createdAt: 5 },
  ],
});
const ids = () => S.tasksOfQuad(1).map((t) => t.id);

// 拖之前：未回填，order 缺省 → done 沉底 + due 升序（旧语义原样）
assert.deepEqual(ids(), ["tA", "tB", "tC", "tD"], "未拖拽前排序必须与旧版完全一致（due 升序 + 完成沉底）");

// 懒回填：首次拖拽把 B 移到 A 前面 → 整组 order 落满
S.moveTaskRelative("tB", "tA", true);
assert.deepEqual(ids(), ["tB", "tA", "tC", "tD"], "B 拖到 A 前面");
assert.deepEqual(S.tasksOfQuad(1).filter((t) => !t.done).map((t) => t.order), [0, 1, 2],
  "首次拖拽必须对同象限同完成态整组懒回填 order 0..n-1（其它组不受牵连）");

// 再拖：C 插到 B 后面（before=false）
S.moveTaskRelative("tC", "tB", false);
assert.deepEqual(ids(), ["tB", "tC", "tA", "tD"], "C 拖到 B 后面（before=false）");

// 跨象限 no-op
S.moveTaskRelative("tA", "tE", true);
assert.deepEqual(ids(), ["tB", "tC", "tA", "tD"], "跨象限换位必须被拒绝（tE 在 quad 2）");

// 跨完成态 no-op：完成的 D 永远沉底
S.moveTaskRelative("tA", "tD", true);
assert.deepEqual(ids(), ["tB", "tC", "tA", "tD"], "拖到已完成卡前面必须被拒绝（完成沉底语义不破坏）");

// 键盘语义同一条路：Alt+↓ = moveTaskRelative(id, next, false)
S.moveTaskRelative("tB", "tC", false);
assert.deepEqual(ids(), ["tC", "tB", "tA", "tD"], "B 下移一位（插到 C 后面）");

// 新增任务没有 order：落回组尾（order=Infinity 兜底），不挤乱用户排好的顺序
S.addTask({ id: "tF", title: "F（新加）", quad: 1, done: false, due: null });
assert.deepEqual(ids(), ["tC", "tB", "tA", "tF", "tD"], "新任务必须排到未完成组尾部，已完成组不受影响");

// 跨象限：A 落到象限 2 的 E 前，再把完成项 D 放到同象限；两组依然分开。
S.moveTaskToQuad("tA", 2, "tE", true);
assert.deepEqual(S.tasksOfQuad(2).map((t) => t.id), ["tA", "tE"], "A 应移到象限 2 并落在 E 前");
assert.equal(S.taskById("tA").quad, 2, "跨象限必须持久化 quad");
S.moveTaskToQuad("tD", 2);
assert.deepEqual(S.tasksOfQuad(2).map((t) => t.id), ["tA", "tE", "tD"], "跨象限后完成项仍沉底");
assert.deepEqual(ids(), ["tC", "tB", "tF"], "原象限不应再保留已移走的卡片");

await S.saveNow();
console.log("PASS: moveTaskRelative / tasksOfQuad 行为面真跑（懒回填 / 前后插 / 跨组拒绝 / 新任务沉底）");
