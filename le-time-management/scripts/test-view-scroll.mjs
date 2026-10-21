// v0.274.0：视图滚动位置记忆的行为与接线断言。
// 需求（用户）：「apk 滑动位置保存，不要返回就回到顶上」。
import assert from "node:assert/strict";
import { readProductSource } from "./lib/read-product-source.mjs";
import { createViewScrollMemory } from "../src/viewScroll.js";

const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");

// ── 接线：切走前 remember、渲染完 restore，且不再有「换页硬归零」 ──
assert.ok(shell.includes('import { createViewScrollMemory } from "./viewScroll.js"'), "shell 必须导入滚动记忆");
assert.ok(shell.includes("const viewScroll = createViewScrollMemory()"), "shell 必须持有滚动记忆实例");
assert.ok(shell.includes('inner: view.querySelector(".plugview")'), "插件页内层 .plugview 也要记");
const switchAt = shell.indexOf("function switchTo(");
assert.ok(switchAt > 0, "必须找到 switchTo");
const rememberAt = shell.indexOf("viewScroll.remember(prevId, scrollRoots())", switchAt);
const wipeAt = shell.indexOf("\n      view.replaceChildren();", switchAt);
const restoreAt = shell.indexOf("viewScroll.restore(targetId, scrollRoots())", switchAt);
assert.ok(rememberAt > switchAt, "切换前必须 remember");
assert.ok(wipeAt > 0 && rememberAt < wipeAt, "remember 必须在 replaceChildren 之前（换掉内容就取不到旧偏移了）");
assert.ok(restoreAt > wipeAt, "restore 必须在内容渲染之后");
assert.ok(!/if \(prevId !== targetId\) view\.scrollTop = 0;/.test(shell), "旧的「换页就归零」必须撤掉");

// ── 行为：用假滚动容器 + 手动调度器把重试逻辑真跑起来 ──
function fakeRoot({ height = 0, box = 0, top = 0 } = {}) {
  const listeners = new Map();
  const root = {
    scrollHeight: height,
    clientHeight: box,
    style: {},
    behaviorWhenSet: [],
    listeners,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    fire(type) { listeners.get(type)?.(); },
  };
  let value = top;
  Object.defineProperty(root, "scrollTop", {
    get: () => value,
    set: (next) => {
      root.behaviorWhenSet.push(root.style.scrollBehavior);
      value = Math.max(0, Math.min(next, Math.max(0, root.scrollHeight - root.clientHeight)));
    },
  });
  return root;
}

function makeRig() {
  const queue = [];
  const memory = createViewScrollMemory({ schedule: (fn) => { queue.push(fn); return queue.length; } });
  return {
    memory,
    queue,
    frame() { const fn = queue.shift(); if (fn) fn(); },
    drain(limit = 200) { let n = 0; while (queue.length && n++ < limit) queue.shift()(); },
  };
}

// ① 首次进入：没有存档 ⇒ 归零，且不挂任何重试 / 手势监听。
{
  const { memory, queue } = makeRig();
  const outer = fakeRoot({ height: 2000, box: 600, top: 640 });
  memory.restore("timeline", { outer });
  assert.equal(outer.scrollTop, 0, "没记过的视图必须从顶部开始");
  assert.equal(queue.length, 0, "目标为 0 时不该排重试");
  assert.equal(outer.listeners.size, 0, "目标为 0 时不该挂手势监听");
}

// ② 滚到 800 → 切到别的页 → 返回，位置必须回来；中间那页仍从顶部开始。
{
  const { memory } = makeRig();
  const outer = fakeRoot({ height: 2000, box: 600, top: 800 });
  memory.remember("timeline", { outer });
  memory.restore("quadrant", { outer });
  assert.equal(outer.scrollTop, 0, "切到新页要从顶部开始");
  memory.restore("timeline", { outer });
  assert.equal(outer.scrollTop, 800, "返回原页必须回到原位");
}

// ③ 内容一时变短（骨架屏 / 空列表）⇒ 先按内容裁小，等长回来再追到原偏移。
{
  const { memory, drain } = makeRig();
  const outer = fakeRoot({ height: 4000, box: 600, top: 1320 });
  memory.remember("a", { outer });
  outer.scrollHeight = 600;             // 内容被换掉后不再可滚
  outer.scrollTop = 0;
  memory.restore("a", { outer });
  assert.equal(outer.scrollTop, 0, "第一次落位受当前内容限制（clamp）");
  outer.scrollHeight = 4000;            // 内容回来
  drain();
  assert.equal(outer.scrollTop, 1320, "内容长回来后必须追到原偏移");
}

// ④ 内容异步长高：重试期间一路追到目标；落位后不再排队。
{
  const { memory, frame, queue } = makeRig();
  const outer = fakeRoot({ height: 600, box: 600, top: 0 });
  memory.remember("plug:cppu-notify", { outer: fakeRoot({}), inner: fakeRoot({ height: 5000, box: 800, top: 2400 }) });
  const inner = fakeRoot({ height: 800, box: 800, top: 0 });
  memory.restore("plug:cppu-notify", { outer, inner });
  assert.equal(inner.scrollTop, 0, "内容还没渲染出来时无从落位");
  inner.scrollHeight = 2000;            // 数据到了，开始能滚
  frame();
  assert.ok(inner.scrollTop > 0, "重试必须把位置顶回来");
  inner.scrollHeight = 5000;            // 再长高，才能到 2400
  while (queue.length && inner.scrollTop !== 2400) frame();
  assert.equal(inner.scrollTop, 2400, "内容长高后必须一路追到原偏移");
  assert.equal(queue.length, 0, "落位后不该继续排帧");
  assert.equal(inner.listeners.size, 0, "收工后必须摘掉手势监听");
}

// ⑤ 用户一动手就收手，不跟人抢滚动条。
{
  const { memory, queue, drain } = makeRig();
  const outer = fakeRoot({ height: 600, box: 600, top: 0 });
  memory.remember("long", { outer: fakeRoot({ height: 4000, box: 600, top: 2600 }) });
  memory.restore("long", { outer });
  assert.ok(queue.length > 0, "内容不够高时应当排重试");
  outer.fire("touchstart");
  assert.equal(outer.listeners.size, 0, "停手后立刻摘掉监听");
  outer.scrollHeight = 4000;            // 数据到了
  drain();                              // 已排队的那一拍照跑，但必须什么都不做
  assert.equal(outer.scrollTop, 0, "停手就停在用户滚动的地方，不再抢位置");
}

// ⑥ styles.css 的 .view 是 smooth 滚动 ⇒ 赋值期间必须临时压成 auto，且写完不留内联样式。
{
  const { memory } = makeRig();
  const outer = fakeRoot({ height: 2000, box: 600, top: 900 });
  memory.remember("smooth", { outer });
  memory.restore("other", { outer });
  outer.behaviorWhenSet.length = 0;
  memory.restore("smooth", { outer });
  assert.deepEqual(outer.behaviorWhenSet, ["auto"], "恢复必须是瞬移，不能从顶部滑下来");
  assert.ok(!("scrollBehavior" in outer.style), "写完必须把内联 scroll-behavior 删掉");
}

// ⑦ 存档有上限，不会跟着插件数量无限涨；forget / clear 正常工作。
{
  const { memory } = makeRig();
  for (let i = 0; i < 40; i++) memory.remember(`v${i}`, { outer: fakeRoot({ height: 4000, box: 600, top: 100 + i }) });
  const outer = fakeRoot({ height: 4000, box: 600, top: 0 });
  memory.restore("v39", { outer });
  assert.equal(outer.scrollTop, 139, "最近的存档必须还在");
  memory.restore("v0", { outer });
  assert.equal(outer.scrollTop, 0, "最老的存档已被挤出");
  memory.remember("keep", { outer: fakeRoot({ height: 4000, box: 600, top: 512 }) });
  memory.restore("keep", { outer });
  assert.equal(outer.scrollTop, 512);
  memory.forget("keep");
  memory.restore("keep", { outer });
  assert.equal(outer.scrollTop, 0, "forget 之后回到顶部");
  memory.remember("keep", { outer });
  memory.clear();
  memory.restore("keep", { outer });
  assert.equal(outer.scrollTop, 0, "clear 之后回到顶部");
}

console.log("PASS: 视图滚动位置按 id 记忆、异步内容重试追位、用户手势即停手、恢复为瞬移");
