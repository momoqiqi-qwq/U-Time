import assert from "node:assert/strict";
import * as S from "../src/store.js";
import { renderTimeline } from "../src/views/timeline.js";

// 仅实现时间线渲染与 keyedNodes 使用的 DOM；片段插入和节点移动遵循真实 DOM 语义。
class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
}
class Element {
  constructor(tag = "div", nodeType = 1) {
    this.nodeType = nodeType; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attrs = {}; this.className = ""; this.style = {}; this.listeners = new Map(); this.scrollTop = 0;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const on = force ?? !classes.has(name);
        if (on) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(" "); return on;
      },
    };
  }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(new TextNode(value)); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node.nodeType === 11) { this.append(...node.children.slice()); return; }
    node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0, "插入目标必须属于当前父节点");
    this.children.splice(index, 0, node); node.parentNode = this;
  }
  replaceChildren(...nodes) { for (const child of this.children.slice()) child.remove(); this.append(...nodes); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  contains(node) { for (let cur = node; cur; cur = cur.parentNode) if (cur === this) return true; return false; }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.find?.(predicate);
      if (found) return found;
    }
    return null;
  }
}
const memory = new Map();
globalThis.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new TextNode(text),
  createDocumentFragment: () => new Element("fragment", 11),
};
// 首次滚动不影响数据/节点断言，避免把布局模拟混进此性能回归。
globalThis.requestAnimationFrame = () => 1;

const day = "2026-10-01";
await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {} });

// 用 ID 访问次数检查复杂度，避免机器负载影响计时结果。
const count = 1200;
const largeState = S.getState();
largeState.tasks = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, title: `任务 ${i}` }));
largeState.blocks = largeState.tasks.map((task, i) => ({ id: `b${i}`, taskId: task.id, title: `安排 ${i}`, date: day, start: "09:00", durMin: 30 }));
let idReads = 0;
for (const task of largeState.tasks) {
  const id = task.id;
  Object.defineProperty(task, "id", { enumerable: true, get() { idReads++; return id; } });
}
const largeContainer = new Element();
renderTimeline(largeContainer);
assert.ok(idReads <= count * 2, `关联查询应线性读取任务 ID，实际 ${idReads} 次 / ${count} 项`);
assert.match(largeContainer.textContent, /来自任务「任务 1199」的排程/, "索引覆盖末尾任务");
largeContainer._unsub();

const block = { id: "linked", taskId: "duplicate", title: "固定安排", date: day, start: "09:00", durMin: 30 };
S.replaceAll({ tasks: [{ id: "duplicate", title: "首项" }, { id: "duplicate", title: "后项" }], blocks: [block], settings: {}, plugins: {} });
const container = new Element();
renderTimeline(container);
const card = () => container.find((node) => node.attrs?.["data-event"] === "blk:linked");
const note = () => card().find((node) => node.classList?.contains("tlv-note")).textContent;
const details = () => card().find((node) => node.classList?.contains("tlv-more"));
assert.match(note(), /来自任务「首项」的排程/, "重复 ID 与 taskById 一样取首项");
assert.ok(!note().includes("后项"));

let previous = card();
previous.listeners.get("click")();
S.getState().settings.unrelated = true;
S.touch();
assert.equal(card(), previous, "无关设置更新复用卡片节点");
assert.equal(card().attrs["aria-expanded"], "true", "复用卡片保留展开态");
S.getState().tasks[1].title = "后项改名";
S.touch();
assert.equal(card(), previous, "被遮蔽的重复 ID 更新不重建首项关联卡片");

S.getState().tasks[0].title = "首项改名";
S.touch();
assert.notEqual(card(), previous, "关联任务改名必须刷新详情");
assert.match(note(), /来自任务「首项改名」的排程/);
assert.equal(card().attrs["aria-expanded"], "true", "详情刷新仍保持展开态");

// 导入/替换可保留孤立排程；任务缺失与有任务但标题为空/缺字段必须生成不同的签名。
for (const title of ["", undefined]) {
  S.replaceAll({ tasks: [], blocks: [block], settings: {}, plugins: {} });
  assert.match(note(), /独立安排，没有正文备注/);
  assert.equal(details(), null, "孤立时间块没有任务详情入口");
  previous = card();
  S.addTask({ id: "duplicate", title });
  assert.notEqual(card(), previous, "添加空/缺标题任务也必须刷新关联正文");
  assert.match(note(), title === "" ? /来自任务「」的排程/ : /来自任务「undefined」的排程/);
  assert.ok(details(), "存在的任务必须有任务详情入口");
  previous = card();
  S.replaceAll({ tasks: [], blocks: [block], settings: {}, plugins: {} });
  assert.notEqual(card(), previous, "移除空/缺标题任务必须刷新关联正文");
  assert.match(note(), /独立安排，没有正文备注/);
  assert.equal(details(), null);
}
container._unsub();
await S.saveNow();
console.log("PASS: 时间线关联查询线性、重复 ID 首项一致、任务改名/添加/移除刷新详情、无关更新复用节点与展开态");
