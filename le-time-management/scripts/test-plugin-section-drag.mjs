import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";

/* 侧栏颜色组**整卡**拖动（v0.215.0）
 *
 * 假 DOM 把 src/pluginSectionDrag.js 真跑起来，验的是**几何对得上真布局**：
 * 假环境自带一个「块级布局 + 相邻兄弟外边距合并」的模型，缩放按 html 上的 zoom 建模
 * （getBoundingClientRect 已乘 zoom，getComputedStyle 的外边距不乘）。
 *
 * 两条硬不变量就是「松手不跳」的全部根据，都由假布局独立算出，不抄模块自己的算术：
 *   ① 让位过的段：松手后的自然位置 == 它松手前的视觉位置；
 *   ② 原件的落位动画首帧 == 原件松手前的视觉位置 − 它松手后的自然位置。
 * 段高、段外边距刻意各不相同（80 / 90 / 120 / 70，3px 与 0 混用），
 * 所以任何「按等高递推」或「按固定 gap 递推」的写法都会在这两条上红。
 */
const src = readProductSource(new URL("../src/pluginSectionDrag.js", import.meta.url), "utf8");
const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");
const css = readProductSource(new URL("../src/styles.css", import.meta.url), "utf8");

// 侧栏真实形状：分隔线 → 置顶段 → 颜色卡片 A → 被拖的颜色卡片 B → 无色段 C → 颜色卡片 D。
// 段高与外边距刻意全不相同（等高递推的写法会在这里翻车）。
const DEFAULT_SPEC = [
  { id: "div", kind: "divider", height: 1, mT: 14, mB: 6 },
  { id: "pin", kind: "pinned", height: 100, mT: 3, mB: 6 },
  { id: "A", kind: "group", height: 80, mT: 3, mB: 3, color: "grape" },
  { id: "B", kind: "group", height: 90, mT: 3, mB: 3, color: "sky" },
  { id: "C", kind: "seg", height: 120, mT: 0, mB: 0 },
  { id: "D", kind: "group", height: 70, mT: 3, mB: 3, color: "sun" },
];

function harness({ reduce = false, scale = 1, spec = DEFAULT_SPEC } = {}) {
  const frames = new Map(), timers = new Map();
  const moved = [];
  let seq = 1, commits = 0, animates = 0, lastAnim = null;
  const containerTop = 100;   // CSS px
  const listeners = () => ({
    handlers: new Map(),
    addEventListener(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); },
    removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); },
    fire(name, event = {}) { for (const fn of [...(this.handlers.get(name) || [])]) fn(event); },
  });
  const document = { ...listeners() };
  const window = { ...listeners() };
  const makeClass = (names = []) => {
    const values = new Set(names);
    return { add: (...a) => a.forEach((x) => values.add(x)), remove: (...a) => a.forEach((x) => values.delete(x)), contains: (x) => values.has(x) };
  };
  /* 假布局：块级、容器没有内边距/边框 ⇒ 首个子项的上外边距与末个子项的下外边距都塌到容器外；
     相邻兄弟取两边外边距的较大者（本项目全是正外边距）。display:none 的段不参与排版 ——
     模块正是靠这一点量「原件离场后各段落到哪」。长度都是 CSS px，rect 再乘缩放系数，
     与真浏览器里 zoom 的行为一致（计算值不乘、rect 乘）。 */
  const layout = () => {
    let y = containerTop, prevMB = 0, first = true;
    for (const node of list.children) {
      if (node.style.display === "none") continue;
      if (!first) y += Math.max(prevMB, node.marginTop);
      node._top = y;
      y += node.height;
      prevMB = node.marginBottom;
      first = false;
    }
  };
  const nodes = {};
  const scroller = { scrollTop: 0 };
  const list = {
    ...listeners(),
    children: [],
    classList: makeClass(),
    isConnected: true,
    scrollTop: 0,
    querySelectorAll: () => list.children.filter((node) => node.kind !== "divider"),
    querySelector: (sel) => (sel.includes("plug-seg-pinned")
      ? list.children.find((node) => node.classList.contains("plug-seg-pinned")) || null : null),
    contains: (node) => list.children.includes(node),
    closest: (sel) => (sel === ".nav" ? scroller : null),
    getBoundingClientRect: () => { layout(); return { top: containerTop * scale, left: 0, width: 220 * scale }; },
    insertBefore(node, ref) {
      const at = list.children.indexOf(node);
      if (at >= 0) list.children.splice(at, 1);
      list.children.splice(ref ? list.children.indexOf(ref) : list.children.length, 0, node);
    },
  };
  const makeNode = (spec) => {
    const node = {
      id: spec.id, kind: spec.kind, height: spec.height,
      marginTop: spec.mT, marginBottom: spec.mB,
      dataset: spec.color ? { color: spec.color } : {},
      style: {},
      classList: makeClass(spec.kind === "group" ? ["plug-group"]
        : spec.kind === "pinned" ? ["plug-seg", "plug-seg-pinned"] : ["plug-seg"]),
      _top: 0,
      get parentElement() { return list; },
      get previousElementSibling() {
        const at = list.children.indexOf(node);
        return at > 0 ? list.children[at - 1] : null;
      },
      getAnimations: () => [],
      setPointerCapture() {}, releasePointerCapture() {}, focus() {},
      animate(keys, opts) { animates += 1; lastAnim = { keys, opts }; return { cancel() {} }; },
      getBoundingClientRect() {
        layout();
        return { top: node._top * scale, left: 0, width: 220 * scale, height: node.height * scale };
      },
    };
    nodes[spec.id] = node;
    list.children.push(node);
  };
  spec.forEach(makeNode);
  layout();
  const code = src.slice(src.indexOf("export function attachPluginSectionDrag(")).replace(/^export /, "");
  const attach = new Function(
    "document", "window", "navigator", "getComputedStyle", "getUiScaleFactor", "reducedMotion", "slotIndexFor",
    "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
    `${code};return attachPluginSectionDrag;`,
  )(
    document, window, { vibrate() {} },
    (node) => ({ marginTop: `${node.marginTop}px`, marginBottom: `${node.marginBottom}px` }),
    () => scale,
    () => reduce,
    (mids, y) => { const at = mids.findIndex((mid) => y < mid); return at < 0 ? mids.length : at; },
    (fn) => { const id = seq++; frames.set(id, fn); return id; },
    (id) => frames.delete(id),
    (fn) => { const id = seq++; timers.set(id, fn); return id; },
    (id) => timers.delete(id),
  );
  attach(list, { onCommit: () => { commits += 1; }, onMove: (card, delta) => moved.push(`${card.id}${delta > 0 ? "+" : "-"}`) });

  const px = (css) => css * scale;   // 假 DOM 只在这一处把 CSS px 换成视口 px
  const target = (node, kind = "head") => ({
    closest: (sel) => {
      if (sel.includes("button[data-plugin-id]")) return kind === "plugin" ? { tag: "button" } : null;
      if (sel === ".plug-group[data-color]") {
        return node.classList.contains("plug-group") && node.dataset.color ? node : null;
      }
      return null;
    },
  });
  const event = (x, y, node, kind = "head", extra = {}) => ({
    target: target(node, kind), pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true,
    clientX: px(x), clientY: px(y), preventDefault() {}, stopPropagation() {}, ...extra,
  });
  const offsetY = (node) => {
    const found = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\)/.exec(node.style.transform || "");
    return found ? Number(found[2]) : 0;
  };
  return {
    list, nodes, document, window, frames, timers, moved, event, target,
    commits: () => commits, animates: () => animates, anim: () => lastAnim,
    order: () => list.children.map((node) => node.id).join(","),
    top: (node) => { layout(); return node._top; },
    y: offsetY,
    visual: (node) => { layout(); return node._top + offsetY(node); },
    // 落位动画首帧该长什么样：X 是指针自己走过的量（视口 px ÷ 缩放 = CSS px），
    // Y 是「松手前的视觉位置 − 松手后的自然位置」。整串都由假布局算，不抄模块的算术。
    land: (node, cssX, visualBefore) => {
      layout();
      return `translate3d(${cssX - 40}px, ${visualBefore - node._top}px, 0)`;
    },
    down: (node, cssY, kind = "head") => list.fire("pointerdown", event(40, cssY, node, kind)),
    move: (cssX, cssY, node, kind = "head") => {
      const fired = event(cssX, cssY, node, kind);
      document.fire("pointermove", fired);
      list.fire("pointermove", fired);
    },
    up: (cssX, cssY, node, kind = "head") => {
      const fired = event(cssX, cssY, node, kind);
      document.fire("pointerup", fired);
      list.fire("pointerup", fired);
    },
    key: (node, key, kind = "head", extra = {}) => list.fire("keydown", {
      target: target(node, kind), key, altKey: true, preventDefault() {}, ...extra,
    }),
    tick: () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn()); },
  };
}

{
  // ① 往下拖两格：原件跟手、跨过的段让一截、DOM 一行不动、松手才落地 —— 两条不变量都成立。
  const h = harness();
  const card = h.nodes.B;
  h.down(card, 300);
  assert.equal(card.classList.contains("nav-dragging"), false, "按下还没动，不许起拖");
  h.move(44, 304, card);
  assert.equal(card.classList.contains("nav-dragging"), true, "鼠标移过 4px 就起拖：浮起的是整张卡片自己");
  assert.equal(h.list.classList.contains("plugin-section-drag-live"), true, "让位过渡挂在列表上");
  assert.equal(h.y(card), 4, "原件按已经发生的位移定位，不先在原位闪一帧");
  h.move(44, 500, card);
  h.tick();
  assert.equal(h.order(), "div,pin,A,B,C,D", "拖动中一行 DOM 都不许动");
  assert.equal(h.y(h.nodes.C), -93, "跨过的段让一截：原件离场后它上移 93（卡片 90 + 下外边距 3）");
  assert.equal(h.y(h.nodes.A), 0, "没跨过的段不许动");
  assert.equal(h.y(h.nodes.D), 0, "没跨过的段不许动");
  assert.equal(h.y(h.nodes.pin), 0, "置顶段永远不让位");
  assert.equal(h.animates(), 0, "拖动中不启动任何 WAAPI 动画");
  const visual = new Map([card, h.nodes.A, h.nodes.C, h.nodes.D].map((node) => [node, h.visual(node)]));
  h.up(44, 500, card);
  assert.equal(h.order(), "div,pin,A,C,B,D", "松手才把 DOM 顺序落地（插到 C 之后）");
  assert.equal(h.commits(), 1, "落地必须回填顺序");
  for (const node of [h.nodes.A, h.nodes.C, h.nodes.D]) {
    assert.equal(h.top(node), visual.get(node), `不变量①：${node.id} 松手后的自然位置 == 松手前的视觉位置（清掉位移不会跳）`);
  }
  assert.equal(h.anim().keys[0].transform, h.land(card, 44, visual.get(card)),
    "不变量②：落位动画首帧 == 原件松手前的视觉位置 − 松手后的自然位置");
  assert.equal(h.y(card), 0, "落地后原件自己的位移清零");
  assert.equal(card.classList.contains("nav-dragging"), false, "拖动类必须摘掉");
  assert.equal(h.list.classList.contains("plugin-section-drag-live"), false, "让位过渡类必须摘掉");
  assert.equal(card.dataset.motion, undefined, "拖动期间的 motion=off 必须还原");
  for (const name of ["pointermove", "pointerup", "pointercancel", "scroll"]) {
    assert.equal(h.document.handlers.get(name)?.size || 0, 0, `document 收尾 ${name}`);
  }
}

{
  // ② 往上拖：让位方向相反，落点 0 = 紧贴置顶段下方（置顶段自己不动）。
  const h = harness();
  const card = h.nodes.B;
  h.down(card, 300);
  h.move(44, 296, card);
  h.move(44, 200, card);
  h.tick();
  assert.equal(h.order(), "div,pin,A,B,C,D", "往上拖同样不重排 DOM");
  assert.equal(h.y(h.nodes.A), 93, "往上拖：被跨过的段往下让出「插入后多出来的高度」");
  assert.equal(h.y(h.nodes.C), 0, "没跨过的段不许动");
  assert.equal(h.y(h.nodes.pin), 0, "置顶段既不许拖也不让位");
  const visual = new Map([card, h.nodes.A, h.nodes.C, h.nodes.D].map((node) => [node, h.visual(node)]));
  h.up(44, 200, card);
  assert.equal(h.order(), "div,pin,B,A,C,D", "松手后卡片插到置顶段下面、A 上面");
  for (const node of [h.nodes.A, h.nodes.C, h.nodes.D]) {
    assert.equal(h.top(node), visual.get(node), `不变量①：${node.id} 不跳`);
  }
  assert.equal(h.anim().keys[0].transform, h.land(card, 44, visual.get(card)), "不变量②：落位首帧对齐");
}

{
  // ③ 置顶段与无色段都不是拖动单位：按在它们身上不许起拖（但无色段照样让位）。
  const h = harness();
  for (const node of [h.nodes.pin, h.nodes.C]) {
    h.down(node, 300);
    h.move(44, 500, node);
    assert.equal(node.classList.contains("nav-dragging"), false, `${node.id} 不是拖动单位：不许浮起`);
    assert.equal(h.commits(), 0, `${node.id} 上不许改顺序`);
    h.up(44, 500, node);
  }
}

{
  // ④ 卡片里的插件按钮归段内拖动：整卡这边不许抢；键盘 Alt+↑/↓ 也不许双触发。
  const h = harness();
  const card = h.nodes.B;
  h.down(card, 300, "plugin");
  h.move(44, 500, card, "plugin");
  assert.equal(card.classList.contains("nav-dragging"), false, "按在卡片里的插件按钮上不许起整卡拖动");
  assert.equal(h.commits(), 0);
  h.up(44, 500, card, "plugin");
  h.key(card, "ArrowDown");
  assert.deepEqual(h.moved, ["B+"], "组头上 Alt+↓ 换到下一组");
  h.key(card, "ArrowUp");
  assert.deepEqual(h.moved, ["B+", "B-"], "组头上 Alt+↑ 换到上一组");
  h.key(card, "ArrowDown", "plugin");
  assert.deepEqual(h.moved, ["B+", "B-"], "插件按钮上的 Alt+↓ 归段内拖动，整卡这边不许再动一次");
}

{
  // ⑤ 取消：Escape / 失焦 / pointercancel 都要干净收场，顺序一行不改。
  for (const how of ["escape", "blur", "cancel"]) {
    const h = harness();
    const card = h.nodes.B;
    h.down(card, 300);
    h.move(44, 296, card);
    h.move(44, 500, card);
    h.tick();
    if (how === "escape") h.key(card, "Escape", "head", { altKey: false });
    else if (how === "blur") h.window.fire("blur");
    else h.document.fire("pointercancel", h.event(44, 500, card));
    assert.equal(h.order(), "div,pin,A,B,C,D", `${how}：顺序一行没动`);
    assert.equal(h.commits(), 0, `${how}：不许提交`);
    assert.equal(card.classList.contains("nav-dragging"), false, `${how}：拖动类必须摘掉`);
    assert.equal(h.y(h.nodes.C), 0, `${how}：让位位移必须清干净`);
    assert.equal(h.frames.size, 0, `${how}：不留下待执行的帧`);
  }
}

{
  // ⑥ 点击与触屏长按：没拖就不提交；触屏滑动取消长按，长按到点才起拖。
  const h = harness();
  const card = h.nodes.B;
  h.down(card, 300);
  h.up(40, 300, card);
  assert.equal(h.commits(), 0, "普通点击不改顺序");
  assert.equal(card.classList.contains("nav-dragging"), false);

  const touch = (cssY) => h.event(40, cssY, card, "head", { pointerType: "touch" });
  h.list.fire("pointerdown", touch(300));
  h.move(60, 300, card);   // 触屏先滑动：长按取消
  assert.equal(h.timers.size, 0, "触屏滑动必须取消长按");
  h.up(60, 300, card);
  assert.equal(h.commits(), 0, "触屏滑动不改顺序");

  h.list.fire("pointerdown", touch(300));
  [...h.timers.values()][0]();   // 长按到点
  assert.equal(card.classList.contains("nav-dragging"), true, "触屏长按 240ms 后激活");
  h.move(44, 500, card);
  h.tick();
  h.up(44, 500, card);
  assert.equal(h.commits(), 1, "触屏长按拖动照样落地");
  assert.equal(h.order(), "div,pin,A,C,B,D");
}

{
  // ⑦ 减少动效：装饰性动画全跳过，拖动内容本身照旧直接跟手。
  const h = harness({ reduce: true, scale: 1.5 });
  const card = h.nodes.B;
  h.down(card, 300);
  h.move(44, 296, card);
  assert.equal(h.nodes.C.style.transition, "none", "减少动效时让位直接跳过去，不吃过渡");
  h.move(44, 500, card);
  h.tick();
  assert.equal(h.y(h.nodes.C), -93, "缩放只改视口像素：写回的位移仍按 CSS px 换算（139.5 视口px ÷ 1.5）");
  h.up(44, 500, card);
  assert.equal(h.animates(), 0, "减少动效不启动落位动画");
  assert.equal(h.commits(), 1, "减少动效照样落地");
  assert.equal(h.order(), "div,pin,A,C,B,D");
}

{
  // ⑧ 界面缩放 150%：外边距（getComputedStyle，不跟 zoom 走）必须先换成视口像素再和
  // rect 混算，否则落点会歪 1.5 视口px —— 松手那一下就是一跳。两条不变量在缩放下一并验。
  const h = harness({ scale: 1.5 });
  const card = h.nodes.B;
  h.down(card, 300);
  h.move(44, 296, card);
  h.move(44, 560, card);   // 拖到最后一格：落点靠「末段底 + 空档」算，正是会被缩放歪掉的那一项
  h.tick();
  const visual = new Map([card, h.nodes.C, h.nodes.D].map((node) => [node, h.visual(node)]));
  h.up(44, 560, card);
  assert.equal(h.order(), "div,pin,A,C,D,B", "拖到最末一格");
  for (const node of [h.nodes.C, h.nodes.D]) {
    assert.equal(h.top(node), visual.get(node), `缩放 150% 下不变量①仍成立：${node.id}`);
  }
  assert.equal(h.anim().keys[0].transform, h.land(card, 44, visual.get(card)),
    "缩放 150% 下落位首帧仍对齐（外边距必须换成视口像素）");

  const up = harness({ scale: 1.5 });
  const upCard = up.nodes.B;
  up.down(upCard, 300);
  up.move(44, 296, upCard);
  up.move(44, 200, upCard);   // 往上拖：让位量是「和」，不换像素同样会歪
  up.tick();
  const upVisual = new Map([upCard, up.nodes.A].map((node) => [node, up.visual(node)]));
  up.up(44, 200, upCard);
  assert.equal(up.top(up.nodes.A), upVisual.get(up.nodes.A), "缩放 150% 下往上拖：被让位的段松手后不跳");
  assert.equal(up.anim().keys[0].transform, up.land(upCard, 44, upVisual.get(upCard)),
    "缩放 150% 下往上拖的落位首帧仍对齐");
}

{
  // ⑨ 原件左右都是无色段（外边距 0）：合并出来的空档不是「高度 + 下外边距」，
  // 而且**没被跨过**的后段也会因为合并关系变了挪几像素。按「跨过的段各让一截」递推
  // （或按固定空档递推）这两种写法都会在这里露馅 —— 松手那一下就是一跳。
  const h = harness({
    spec: [
      { id: "div", kind: "divider", height: 1, mT: 14, mB: 6 },
      { id: "pin", kind: "pinned", height: 100, mT: 3, mB: 6 },
      { id: "S1", kind: "seg", height: 60, mT: 0, mB: 0 },
      { id: "B", kind: "group", height: 90, mT: 3, mB: 3, color: "sky" },
      { id: "S2", kind: "seg", height: 50, mT: 0, mB: 0 },
      { id: "E", kind: "group", height: 40, mT: 3, mB: 3, color: "sun" },
    ],
  });
  const card = h.nodes.B;
  h.down(card, 300);
  h.move(44, 296, card);
  h.move(44, 400, card);   // 落点 = 插到 E 之前
  h.tick();
  assert.equal(h.y(h.nodes.S2), -96, "两边都是无色段：让位量是 96（90 + 3 + 3 − 0），不是 93");
  assert.equal(h.y(h.nodes.S1), 0, "原件之前、没被跨过的段不许动");
  const visual = new Map([card, h.nodes.S1, h.nodes.S2, h.nodes.E].map((node) => [node, h.visual(node)]));
  h.up(44, 400, card);
  assert.equal(h.order(), "div,pin,S1,S2,B,E", "松手后卡片插到 S2 与 E 之间");
  for (const node of [h.nodes.S1, h.nodes.S2, h.nodes.E]) {
    assert.equal(h.top(node), visual.get(node), `不变量①：${node.id} 不跳（E 没被跨过，也会因空档合并关系变了挪 3px）`);
  }
  assert.equal(h.anim().keys[0].transform, h.land(card, 44, visual.get(card)), "不变量②：落位首帧对齐");
}

// ── 静态接线：模块、shell 与 CSS 三处必须对得上 ──────────────────────────────
assert.doesNotMatch(src, /cloneNode|document\.body|\.append\(/, "不许克隆跟手副本或往 body 上挂浮层（与段内拖动同一模型）");
const frameBody = src.slice(src.indexOf("const frame = (st)"), src.indexOf("const finish = (st)"));
assert.doesNotMatch(frameBody, /insertBefore/, "拖动中不许重排 DOM");
assert.match(src, /list\.insertBefore\(st\.card, st\.peers\[slot\] \?\? null\)/, "松手才把 DOM 顺序落地");
assert.match(src, /const shiftOf = \(st, slot, index\) => st\.gone\.get\(st\.peers\[index\]\)/,
  "让位量必须按「落位后的自然位置 − 此刻的自然位置」逐段算，不能只让被跨过的那几段让位");
assert.match(src, /const px = shiftOf\(st, slot, i\);/, "applyShift 必须逐段取真实位移");
assert.match(src, /card\.style\.display = "none";/, "「原件离场后各段落到哪」必须实测，不许按等高递推");
assert.match(src, /if \(scroller && scroller\.scrollTop !== scrollBefore\) scroller\.scrollTop = scrollBefore;/,
  "摘出原件会让滚动容器变矮，量完必须把 scrollTop 还回去");
assert.match(src, /gapBetween\(st, prev, st\.card\) - gapBetween\(st, prev, next\)/, "落点必须按「插入前后空档之差」算");
assert.match(src, /return rec\[side\] \* st\.scale;/, "外边距必须换算成视口像素，才能与 getBoundingClientRect 混算");
assert.match(src, /const peers = all\.filter\(\(node\) => node !== card && node !== pinnedSeg\)/, "置顶段不参与让位");
assert.match(src, /if \(!peers\.length\) \{ st\.dead = true; return; \}/, "只有一张卡片时没有可换的位置，直接放弃");
assert.match(src, /if \(event\.target\.closest\?\.\("button\[data-plugin-id\], \.plug-group-move"\)\) return;/,
  "卡片里的插件按钮与 ↑/↓ 操作钮上不许起整卡拖动");
assert.match(src, /setTimeout\(\(\) => \{ if \(pd\?\.card === card && !pd\.active\) begin\(pd\); \}, 240\)/, "触屏长按阈值缺失");
assert.match(src, /if \(!reducedMotion\(\) && typeof st\.card\.animate === "function"/, "减少动效时必须跳过落位动画");

assert.match(shell, /attachPluginSectionDrag\(box, \{/, "侧栏必须挂上整卡拖动控制器");
assert.match(shell, /onCommit: \(\) => saveSectionOrder\(/, "松手必须把段顺序写回 pluginOrder");
assert.match(shell, /onMove: \(card, delta\) => moveNavGroup\(card\.dataset\.color, delta\)/,
  "Alt+↑/↓ 必须复用整组 ↑/↓ 那条路（换位后整段重绘，焦点也由它还回去）");
assert.match(shell, /const sectionPluginIds = \(node\) => \(node\._views/,
  "收起的分组卡片里没有成员按钮，只能从 _views 取插件");
assert.match(shell, /settings\.pluginOrder = next;/, "整组换位必须持久化 pluginOrder");
assert.match(shell, /if \(next\.join\(" "\) === full\.join\(" "\)\) return;/, "拖回原位不许写库、不许弹提示");

assert.match(css, /\.plug-list\.plug-section-drag-live > \.plug-group,[\s\S]{0,120}transition: transform 140ms/,
  "让位的段必须有位移动画");
assert.match(css, /\.plug-list\.plug-section-drag-live > \.plug-group\.nav-dragging \{ transition: none; \}/,
  "被拖的卡片必须排除在让位过渡之外，否则跟手变迟滞");
assert.match(css, /\.nav \.plug-group\.nav-dragging \{[\s\S]{0,200}color-mix\(in srgb, var\(--gc, var\(--grape\)\) 16%, var\(--panel\)\)/,
  "浮起的卡片必须不透明，否则会透出下面正在让位的卡片");
assert.match(css, /\.nav \.plug-group-head,[\s\S]{0,80}cursor: grab/, "组头必须给出可抓的指针");

console.log("PASS: 颜色组整卡拖动 —— 跟手 / 让位 / 松手落地 / 外边距合并与缩放几何 / 置顶段与插件按钮不抢 / 取消与触屏 / reduced-motion");
