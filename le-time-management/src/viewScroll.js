// 视图滚动位置记忆（v0.274.0）
//
// 需求（用户）：「apk 滑动位置保存，不要返回就回到顶上」。
//
// 背景：`.view` 是**所有页面共用的同一个**滚动容器（插件页里再多一层 `.plugview`
// 自己滚，见 styles.css 的 `.plugview { height:100%; overflow-y:auto }`）。切视图时
// `view.replaceChildren()` 会把内容全部换掉，而 switchTo 里原先只有一句
// 「换到别的视图就把 scrollTop 归零」—— 于是「列表滚到一半 → 点进详情 / 换到别的插件
// → 按返回」必然被甩回顶部，之前滚到哪儿全丢。APK 上返回键是主要导航方式，感知特别强。
//
// 这里改成按视图 id 记账：
//   · 切走之前 `remember(id)` 把外层 `.view` 与内层 `.plugview` 的偏移各存一份；
//   · 渲染完 `restore(id)` 放回去；**没记过的视图（首次进入）显式归零**，保持旧行为，
//     不会把上一页的偏移带进新页面。
//
// 三个必须守住的细节：
//   1. styles.css 给 `.view` 定了 `scroll-behavior: smooth`，直接赋值 scrollTop 会
//      **缓慢滚**而不是瞬移（返回时能看见页面从顶部滑下来）。所以赋值期间临时把内联
//      scroll-behavior 设成 auto，写完立刻还原，绝不留在元素上。
//   2. 插件页内容是异步渲染的（先占位、后填数据），赋值那一刻 scrollHeight 可能还不够
//      高，浏览器会把偏移截断成 0。所以恢复 = 「立刻赋值 + 接下来若干次重试」，直到落位
//      或次数用完（约 2 秒）。内容姗姗来迟也能接上。
//   3. 用户在这段重试期里主动触摸 / 滚轮 / 按键 ⇒ 立刻收手，不跟人抢滚动条。
//
// 只记「本次会话」的位置：冷启动停在顶部是对的，持久化反而会把陈旧偏移套到新数据上。

/** 最多记多少个视图（核心视图 + 插件视图，够用且不会无限涨）。 */
const MAX_ENTRIES = 32;
/** 重试次数：前 ~16 次走动画帧（约 260ms），之后拖到 60ms 一次，总计约 2s。 */
const MAX_ATTEMPTS = 42;
const RAF_ATTEMPTS = 16;
/** 认定「已经落位」的容差（px）：浏览器会把偏移量化到整数。 */
const TOLERANCE = 1;
/** 用户手势：出现任意一个就不再抢滚动位置。 */
const INTENT_EVENTS = ["touchstart", "pointerdown", "wheel", "keydown"];
function defaultSchedule(fn, attempt) {
  if (attempt < RAF_ATTEMPTS && typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
  return setTimeout(fn, 60);
}

/** 把目标偏移裁到「当前内容允许」的范围内（内容还没渲染完时会被裁小，靠重试追回来）。 */
function clampOffset(root, top) {
  const height = Number(root?.scrollHeight) || 0;
  const box = Number(root?.clientHeight) || 0;
  const max = Math.max(0, height - box);
  const wanted = Number(top);
  if (!Number.isFinite(wanted) || wanted <= 0) return 0;
  return Math.min(Math.round(wanted), max);
}

function readOffset(root) {
  const value = Number(root?.scrollTop);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 同步瞬移：临时压掉 CSS 的 scroll-behavior: smooth，写完还原。 */
function applyInstant(root, top) {
  if (!root) return;
  const style = root.style;
  const previous = style ? style.scrollBehavior : undefined;
  if (style) style.scrollBehavior = "auto";
  try {
    root.scrollTop = clampOffset(root, top);
  } finally {
    if (style) {
      if (previous === undefined) delete style.scrollBehavior;
      else style.scrollBehavior = previous;
    }
  }
}

/**
 * @param {{ schedule?: (fn: () => void, attempt: number) => unknown }} [options]
 *   schedule 只在测试里注入；生产走 rAF + setTimeout。
 */
export function createViewScrollMemory(options = {}) {
  const schedule = typeof options.schedule === "function" ? options.schedule : defaultSchedule;
  const offsets = new Map();   // viewId -> { outer, inner }
  let job = null;              // 正在重试的那一次恢复

  function stopJob() {
    if (!job) return;
    const { roots, onIntent } = job;
    job = null;
    for (const root of roots) {
      if (typeof root?.removeEventListener !== "function") continue;
      for (const type of INTENT_EVENTS) {
        try { root.removeEventListener(type, onIntent); } catch { /* 取不到就当我没挂过 */ }
      }
    }
  }

  /** 记下这个视图此刻滚到哪儿了。 */
  function remember(id, roots = {}) {
    if (typeof id !== "string" || !id) return;
    const entry = { outer: readOffset(roots.outer), inner: readOffset(roots.inner) };
    offsets.delete(id);
    offsets.set(id, entry);                       // 重新插入 = 记成最近使用
    while (offsets.size > MAX_ENTRIES) offsets.delete(offsets.keys().next().value);
  }

  function step() {
    if (!job) return;                             // 已被用户手势或下一次切换取消
    const { pairs, attempt } = job;
    job.attempt = attempt + 1;
    let chasing = false;
    for (const [root, top] of pairs) {
      if (top <= 0) continue;
      if (Math.abs(readOffset(root) - clampOffset(root, top)) <= TOLERANCE) continue;
      applyInstant(root, top);
      if (Math.abs(readOffset(root) - top) > TOLERANCE) chasing = true;   // 内容还不够高，下一拍再试
    }
    if (!chasing || job.attempt >= MAX_ATTEMPTS) { stopJob(); return; }
    job.handle = schedule(step, job.attempt);
  }

  /** 把 id 这页的偏移放回去；没记过就归零（首次进入从顶部开始）。 */
  function restore(id, roots = {}) {
    stopJob();
    const saved = (typeof id === "string" && offsets.get(id)) || { outer: 0, inner: 0 };
    const pairs = [];
    if (roots.outer) pairs.push([roots.outer, saved.outer || 0]);
    if (roots.inner) pairs.push([roots.inner, saved.inner || 0]);
    if (!pairs.length) return;

    for (const [root, top] of pairs) applyInstant(root, top);
    // 首次进入（目标全 0）一次归零就够，不挂重试也不挂手势监听。
    if (pairs.every(([, top]) => top <= 0)) return;

    job = { pairs, roots: pairs.map(([root]) => root), attempt: 0, onIntent: null };
    job.onIntent = () => stopJob();
    for (const root of job.roots) {
      if (typeof root?.addEventListener !== "function") continue;
      for (const type of INTENT_EVENTS) {
        try { root.addEventListener(type, job.onIntent, { passive: true, once: true }); } catch { /* 同上 */ }
      }
    }
    job.handle = schedule(step, 0);
  }

  /** 丢掉某个视图的存档（视图被删掉、插件被卸载时用）。 */
  function forget(id) {
    offsets.delete(id);
  }

  function clear() {
    stopJob();
    offsets.clear();
  }

  return { remember, restore, forget, clear, stop: stopJob };
}
