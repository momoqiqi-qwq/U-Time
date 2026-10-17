// 刷新等待蒙版（v0.233.0，用户需求「给其他需要刷新等待时间的界面也添加这种蒙版」）。
//
// 与启动蒙版（loadingMask.js）是**同一套外观、不同用途**：
//   · loadingMask  → 启动那一次，盖住整段首屏，铺满 `--bg`，走完就摘掉，不复用；
//   · waitMask     → 任何「要等一会儿」的操作（刷新课表 / 拉通知 / 同步账单 / 切视图），
//                    半透明、可复用、可并发，操作结束自动撤。
// 蒙版上那句字与左上角标题同源（brandWordmark.js 的 `.brand` + 哥特字标 + 装饰线），
// 默认还是 `U Time WorkSpace`；传 text 就换成那句操作的说明（如「正在刷新课表…」）。
//
// 四个设计决定（改之前先读完，都是踩过的地方）：
// ① **延迟出现（SHOW_DELAY_MS）**：操作常常 50ms 就完了。不延迟的话每次刷新都闪一下蒙版，
//    比没有蒙版更烦。超过这个阈值才起，用户看到的是「确实在等」，不是「界面在抖」。
// ② **最短停留（MIN_VISIBLE_MS）**：一旦显示了就至少停这么久。否则 210ms 才起的蒙版会在
//    220ms 消失 —— 一次 10ms 的淡入淡出，比不显示更像故障。
// ③ **引用计数 + 标签栈**：同一时刻可能有多个等待（打开视图时的渲染等待 + 插件自己的拉取）。
//    每个 show 拿一个 release；全部 release 完才撤。文字取**最后**一个还没结束的标签
//    （最新的那条最贴近用户当下在做的事），并带一个 `×N` 后缀说明「还有几件事在跑」。
// ④ **纯装饰 + 半透明**：`aria-hidden="true"`、`role="presentation"` —— 读屏不该念它；
//    下面那页已经画好了，遮死反而像卡住，所以底色是 `color-mix(--bg 86%)`。
// ⑤ **只盖右侧主区（v0.239.0）**：蒙版挂在 `.main` 里（顶栏 + 视图），不是挂在 body 上。
//    用户需求原文「蒙板仅在右界面使用，不在侧边栏使用。蒙版期间，依然可以选择侧边栏的其他项目」——
//    盖住侧栏就会连点击一起拦掉，用户被锁在当前页直到刷新结束。
//    侧栏在 `.main` 之外 ⇒ 蒙版既盖不到它、也拦不住它；窄屏底栏是 fixed 浮层，靠 body 上的
//    `wait-mask-open` 标记抬 z-index（styles.css ≤900px 块），一并保住可点。
//
// 蒙版节点**复用** index.html 里那颗 `[data-wait-mask]` 空壳（和启动蒙版一样写在 HTML 里，
// 首帧就在文档中）；被摘掉之后再 show 会重新建一颗，所以它不依赖那颗空壳还在不在。

import { brandMark } from "./brandWordmark.js";

/** 操作慢过这个时长才显示蒙版 —— 快操作不该闪。 */
export const SHOW_DELAY_MS = 180;
/** 一旦显示，至少停这么久（含淡出），避免「刚出现就消失」的抽搐。 */
export const MIN_VISIBLE_MS = 420;
/** 淡出时长，与 CSS 里 `.wait-mask` 的 `transition` 保持一致（改一处要改两处）。 */
export const FADE_MS = 200;
/** 兜底上限：任何一次等待最多挂这么久，超时自动撤。
    插件忘了 release（异常路径、视图被拆掉时 await 永远不 resolve）不该把整屏永久锁住。 */
export const MAX_HOLD_MS = 120000;
/** 标签长度阈值：超过它走 `wide` 档（字号 clamp 进视口，任意长标签都不横向溢出）。 */
const WIDE_AT = 10;

const READY_CLASS = "ready";
const LEAVING_CLASS = "leaving";
const MASK_SELECTOR = "[data-wait-mask]";
const BRAND_GRADIENT_ID = "waitMaskBrandRuleGrad";

/** 当前蒙版节点。撤下时置空，下次 show 重新建。 */
let node = null;
let nodeShownAt = 0;
/** 延迟出现的定时器与淡出定时器（同一时刻各最多一个）。 */
let showTimer = 0;
let hideTimer = 0;
/** 还在等待的标签，key 是本次 show 的序号：`Map<number, string>`。 */
const pending = new Map();
/** 每个等待的兜底定时器：`Map<number, timerId>`。单独记账是为了 reset 时能一并取消 ——
    只 `pending.clear()` 的话那些 120s 的定时器还挂在事件循环里（回调会自己早退，但白占）。 */
const holdTimers = new Map();
let seq = 0;

function prefersReduced() {
  try {
    if (document.documentElement.dataset.uiMotion === "reduced") return true;
    if (document.documentElement.dataset.uiMotion === "full") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** 现在该显示哪句字：最后进来的那条标签。空串表示「等待蒙版但没指定文案」。 */
function currentLabel() {
  let last = "";
  for (const label of pending.values()) last = label;
  return last;
}

function currentSize(label) {
  if (!label) return "brand";
  return label.length > WIDE_AT ? "wide" : "compact";
}

/** 汉字/全角字符占 1em，其余（拉丁、数字、空格）约 0.55em。
    宽档靠这个估宽把字号压进视口 —— 只按字数除会在「正在读取 2025 年节假日…」
    这类混排标签上偏小、在纯汉字上偏大。 */
const FULLWIDTH = /[\u1100-\u115F\u2E80-\u303F\u3040-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function estimateEm(label) {
  let em = 0;
  for (const ch of String(label || "")) em += FULLWIDTH.test(ch) ? 1 : 0.55;
  return Math.max(em, 1);
}

/* v0.239.0：蒙版只盖右侧主区（.main = 顶栏 + 视图），侧边栏不在它的盒里 ——
   用户要求「蒙板仅在右界面使用…蒙版期间依然可以选择侧边栏的其他项目」。
   包含块由 styles.css 的 `.main { position: relative }` 提供，蒙版自己是 absolute/inset:0。
   index.html 那颗空壳仍写在 body（首帧就在，弱机不闪半成品），首次 show 时搬进 .main。
   ⚠️ 不要再改回 document.body：那样就只能 position:fixed 铺满整窗，侧栏又被一起蒙住。 */
const MASK_HOST_SELECTOR = ".main";
/** 蒙版在场标记：窄屏底栏靠它把 z-index 抬到蒙版之上（styles.css ≤900px 块），
    否则手机上蒙版期间点不动底栏，「依然可以选择其他项目」就落不了地。 */
const BODY_FLAG = "wait-mask-open";

/** 蒙版该挂在谁身上。拿不到 .main（index 被改坏 / 单测无壳）时退回 body，蒙版宁可铺满也不能不显示。 */
function maskHost() {
  try {
    return document.querySelector(MASK_HOST_SELECTOR) || document.body;
  } catch {
    return document.body;
  }
}

function clearBodyFlag() {
  try { document.body?.classList?.remove?.(BODY_FLAG); } catch { /* 无 body 的极端环境：忽略 */ }
}

/** 建/取蒙版节点。优先复用 HTML 里的空壳（首帧就在，不必等 JS 建）。 */
function ensureNode() {
  const target = maskHost();
  if (node && node.isConnected) {
    // 视图切换只重画 .view，.main 不重建；这里仍是兜底 —— 节点被别处摘走就拉回来。
    if (node.parentNode !== target) target.append(node);
    return node;
  }
  let host = null;
  try { host = document.querySelector(MASK_SELECTOR); } catch { host = null; }
  if (!host) {
    host = document.createElement("div");
    host.className = "wait-mask";
    host.dataset.waitMask = "";
  }
  if (host.parentNode !== target) target.append(host);
  host.setAttribute("hidden", "");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("role", "presentation");
  node = host;
  return host;
}

/** 把当前标签写进蒙版（文案变了就重建字标；没变只改计数）。 */
function paint(host, label, count) {
  const size = currentSize(label);
  if (host.dataset.size !== size) host.dataset.size = size;
  // 宽档把估宽交给 CSS 当除数（styles.css 的 wide 档用 var(--wait-mask-em)），
  // 其余两档字号是定值，清掉免得残留在节点上误导后来的人。
  if (size === "wide") host.style.setProperty("--wait-mask-em", String(estimateEm(label)));
  else host.style.removeProperty("--wait-mask-em");
  const existing = host.querySelector(".brand b");
  if (!existing || existing.textContent !== (label || "")) {
    const brand = document.createElement("div");
    brand.className = "brand";
    brand.append(...brandMark(BRAND_GRADIENT_ID, label));
    host.replaceChildren(brand);
  }
  // `×N` 只是给用户的补充信息，不进字标本体（字标必须保持是那套渐变裁剪的字）。
  const badge = host.querySelector(".wait-mask-count");
  if (count > 1) {
    if (badge) badge.textContent = `×${count}`;
    else host.append(Object.assign(document.createElement("span"), { className: "wait-mask-count", textContent: `×${count}` }));
  } else if (badge) badge.remove();
}

function showNow() {
  showTimer = 0;
  const label = currentLabel();
  const host = ensureNode();
  paint(host, label, pending.size);
  host.removeAttribute("hidden");
  // 只有窄屏那条 `.rail` 抬升读它（桌面侧栏根本不在蒙版范围内，类挂上也无副作用）。
  try { document.body?.classList?.add?.(BODY_FLAG); } catch { /* 忽略 */ }
  nodeShownAt = Date.now();
  window.clearTimeout(hideTimer);
  hideTimer = 0;
  host.classList.remove(LEAVING_CLASS);
  // 首帧透明 → 下一帧淡入（与启动蒙版同一条路径：填 DOM → 摘 hidden → 淡入）。
  if (prefersReduced()) host.classList.add(READY_CLASS);
  else requestAnimationFrame(() => requestAnimationFrame(() => host.classList.add(READY_CLASS)));
}

function hideNow() {
  const host = node;
  node = null;
  if (!host || !host.isConnected) { clearBodyFlag(); return; }
  host.setAttribute("aria-hidden", "true");
  if (prefersReduced()) { host.remove(); clearBodyFlag(); return; }
  host.classList.add(LEAVING_CLASS);
  // 底栏的抬升跟着节点一起撤：淡出那 200ms 里还留着标记会让底栏「悬」在渐隐的蒙版上。
  hideTimer = window.setTimeout(() => { host.remove(); clearBodyFlag(); }, FADE_MS + 60);
}

/**
 * 撤下最后一个等待：先把已显示的蒙版按「最短停留」补足时间，再走淡出。
 * 延迟期内的（还没显示）直接取消，不会有任何动画。
 */
function releaseAll() {
  window.clearTimeout(showTimer);
  showTimer = 0;
  if (!node) return;                                  // 还没显示：什么都不用撤
  const elapsed = Date.now() - nodeShownAt;
  const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
  window.clearTimeout(hideTimer);
  if (wait === 0) { hideNow(); return; }
  hideTimer = window.setTimeout(hideNow, wait);
}

/**
 * 显示刷新等待蒙版，返回一个「结束本次等待」的函数（幂等，重复调用无副作用）。
 *
 * 用法（推荐 `await`，让延迟/最短停留都生效；不等也不会卡住调用方）：
 * ```js
 * const release = tide.ui.waitMask("正在刷新课表…");
 * try { await loadSomething(); } finally { release(); }
 * ```
 *
 * @param {string} [text] 蒙版上的文案；不传就是品牌字标那句（`U Time WorkSpace`）。
 * @returns {() => void} 结束函数。
 */
export function showWaitMask(text) {
  const label = String(text ?? "").trim();
  const id = ++seq;
  pending.set(id, label);
  if (!node && !showTimer) {
    // **延迟与「减少动效」无关**：这条延迟拦的是「快操作闪一下蒙版」，不是位移动画。
    // 减少动效的用户同样不想在 50ms 的刷新里看到蒙版一闪 —— 所以这里一律走延迟，
    // 只在「出现 / 消失」那两个瞬间跳过过渡（见 showNow / hideNow）。
    showTimer = window.setTimeout(showNow, SHOW_DELAY_MS);
  } else if (node) {
    paint(node, label, pending.size);                 // 已经显示着：更新文案与计数
  }
  // 兜底：挂了太久一定是调用方漏了 release（插件异常 / 视图被拆走时 await 永不落地）。
  holdTimers.set(id, window.setTimeout(() => {
    if (!pending.has(id)) return;
    console.warn("[waitMask] 等待超过上限仍未结束，已自动撤下蒙版：", label || "(品牌文案)");
    release();
  }, MAX_HOLD_MS));
  let released = false;
  function release() {
    if (released) return;
    released = true;
    const hold = holdTimers.get(id);
    if (hold !== undefined) { window.clearTimeout(hold); holdTimers.delete(id); }
    pending.delete(id);
    if (pending.size === 0) releaseAll();
    else if (node) paint(node, currentLabel(), pending.size);
  }
  return release;
}

/**
 * 把一次异步操作整个包进等待蒙版：操作还没完就一直盖着，抛错也一定撤。
 * @param {string} text 蒙版文案。
 * @param {() => Promise<any>|any} task 要执行的操作。
 * @returns {Promise<any>} task 的结果。
 */
export async function withWaitMask(text, task) {
  const release = showWaitMask(text);
  try {
    return await task();
  } finally {
    release();
  }
}

/** 仅供测试与收尾用：立刻撤掉蒙版并清空所有等待（不动 pending 会让下一次 show 读到脏标签）。 */
export function resetWaitMask() {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  showTimer = 0;
  hideTimer = 0;
  for (const id of holdTimers.values()) window.clearTimeout(id);
  holdTimers.clear();
  pending.clear();
  const host = node;
  node = null;
  if (host) host.remove();
  clearBodyFlag();
}
