import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 保存状态浮标（右下角那块）回归测试。
 *
 * 失败模式全是**静默**的：最早它订阅时立刻收到一次 `saved` 回执就再也没收起来，
 * 于是从启动第一帧起右下角永远挂着一块「已保存」；后来改成成功后亮一会儿，
 * 仍然天天复活 —— 因为 persistSoon() 也被插件后台轮询、提醒计时、自动整理调用。
 * 浏览器不会报任何错，只能靠断言把契约钉住：
 *   saved 永不露面 / pending·saving 只在对时后露面 / error 立刻露面并常驻。
 *
 * 分两层：
 *  ① JS 层（跑真代码 + 真 store）：启动首帧不许露面；普通写入全程不露面；
 *     写入卡住到点才露面；失败立刻露面且永不退场（重试/导出按钮跟着它）。
 *  ② CSS 层（读文本）：`data-visible` 是唯一的显隐开关，且收起要等淡出走完再撤
 *     visibility（否则过渡途中还能点到按钮），展开要把延迟清零。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const css = readProductSource(path.join(appRoot, "src/styles/storage-status.css"), "utf8");
const viewSource = readProductSource(path.join(appRoot, "src/views/storageStatus.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(appRoot, "index.html"), "utf8");

/* ─────────────────────── 迷你 DOM ─────────────────────── */

class FakeText {
  constructor(text) { this.nodeType = 3; this._text = String(text); this.parentNode = null; }
  get textContent() { return this._text; }
  remove() { this.parentNode?.removeChild(this); }
}

class FakeNode {
  constructor(tag = "") {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.hidden = false;
    this._classes = new Set();
    this._listeners = new Map();
    this._data = {};
    // storageStatus.js 写的是 node.dataset.visible，映射回 data-visible 属性。
    // 用 Proxy 而不是对象字面量：键在运行时才知道。
    this.dataset = new Proxy(this._data, {
      set: (target, key, value) => { target[key] = String(value); this.attrs[`data-${String(key)}`] = String(value); return true; },
      get: (target, key) => target[key],
    });
    this.style = { cssText: "", setProperty() {}, getPropertyValue: () => "" };
  }
  get className() { return [...this._classes].join(" "); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this._classes;
    return {
      contains: (c) => set.has(c),
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      toggle: (c, on) => { const next = on === undefined ? !set.has(c) : !!on; if (next) set.add(c); else set.delete(c); return next; },
    };
  }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === "class") this.className = value; }
  getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
  hasAttribute(key) { return key in this.attrs; }
  addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); }
  removeEventListener() {}
  append(...kids) {
    for (const kid of kids) {
      const real = kid && kid.nodeType ? kid : new FakeText(kid);
      real.parentNode?.children.splice(real.parentNode.children.indexOf(real), 1);
      this.children.push(real);
      real.parentNode = this;
    }
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = null;
    }
  }
  get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); }
  // storageStatus.js 直接写 label.textContent，替身必须支持赋值（真 DOM 会清空旧子节点）。
  set textContent(value) { this.children = []; this.append(String(value)); }
  find(pred) {
    for (const child of this.children) {
      if (child.nodeType !== 1) continue;
      if (pred(child)) return child;
      const found = child.find(pred);
      if (found) return found;
    }
    return null;
  }
}

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
globalThis.document = {
  body: new FakeNode("body"),
  documentElement: { dataset: { uiMotion: "full" } },
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: () => null,
};
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  // store.js 的 emitChanged 会派发 tide:state-changed；这里只让它别炸，断言不依赖它。
  dispatchEvent: () => true,
};
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };

const S = await import("../src/store.js");
const { api } = await import("../src/api.js");
const { mountStorageStatus } = await import("../src/views/storageStatus.js");

const stuckMs = Number(viewSource.match(/const STUCK_MS = (\d+)/)?.[1] ?? 0);
assert.ok(stuckMs > 0, "必须存在 STUCK_MS：没有卡顿时长就分不出「正常写入」和「卡住了」");
/* 以前这里叫 SAVED_LINGER_MS，是成功回执的停留时长。有它就意味着「已保存」会露面 ——
   反过来把这条钉死：源码里不许再有「成功回执停留」这个概念。 */
assert.doesNotMatch(viewSource, /SAVED_LINGER_MS/, "🔴 成功回执的停留时长必须彻底消失：它一露脸就会被后台写入反复点亮");
const settle = () => new Promise((resolve) => setTimeout(resolve, stuckMs + 350));

await S.initStore({ tasks: [], blocks: [] });

const root = new FakeNode("body");
mountStorageStatus(root);
const pill = root.find((node) => node.className.split(/\s+/).includes("storage-status"));
assert.ok(pill, "storageStatus.js 必须挂一块 .storage-status");
const label = pill.children[0];
const retry = pill.find((node) => node.tagName === "BUTTON");

/* ── ① 启动首帧：不许冒出「已保存」 ── */
assert.equal(pill.dataset.visible, "false", "🔴 启动首帧收到的是 subscribe 的立刻回执，不能把它当成「刚刚保存过」而露面");
assert.equal(pill.dataset.phase, "saved");
assert.equal(label.textContent, "已保存");

/* ── ② 普通写入（pending → saving → saved）：全程不露面 ── */
let wrote = 0;
const realSave = api.saveData;
api.saveData = async () => { wrote++; };

S.addTask({ title: "保存状态 fixture" });
assert.equal(pill.dataset.phase, "pending");
assert.equal(label.textContent, "有更改待保存");
assert.equal(pill.dataset.visible, "false", "🔴 有改动待保存不许露面：插件后台轮询也会走到这里，露面就是每秒闪一次");

await S.saveNow();
assert.equal(wrote > 0, true, "测试前提：saveData 被调用了");
assert.equal(pill.dataset.phase, "saved");
assert.equal(pill.dataset.visible, "false", "🔴 保存成功不许回执 —— 「老是显示已保存」就是这条没守住");
await settle();
assert.equal(pill.dataset.visible, "false", "保存成功后也不许延迟冒出来：卡顿计时必须在 saved 时被取消");

/* ── ③ 写入卡住：到点才露面，写完后自己退场 ── */
let releaseSave;
api.saveData = () => new Promise((resolve) => { releaseSave = resolve; });
S.addTask({ title: "卡住 fixture" });
const stuckRun = S.saveNow();
await new Promise((resolve) => setTimeout(resolve, stuckMs / 3));
assert.equal(pill.dataset.visible, "false", "写入还在半路时不许抢先露面");
await new Promise((resolve) => setTimeout(resolve, stuckMs));
assert.equal(pill.dataset.phase, "saving");
assert.equal(pill.dataset.visible, "true", "写入超过 STUCK_MS 还没落盘才算「卡住了」，这时必须让用户看到");
assert.equal(label.textContent, "正在保存…");
releaseSave();
await stuckRun;
assert.equal(pill.dataset.phase, "saved");
assert.equal(pill.dataset.visible, "false", "卡住之后落盘成功，浮标要退场");

/* ── ④ 保存失败：立刻露面、不自动退场，重试/导出按钮跟着出现 ── */
api.saveData = async () => { throw new Error("simulated disk full"); };
S.addTask({ title: "失败 fixture" });
await S.saveNow().catch(() => {});
assert.equal(pill.dataset.phase, "error");
assert.match(label.textContent, /保存失败：simulated disk full/);
assert.equal(pill.dataset.visible, "true");
assert.equal(retry.hidden, false, "失败态必须露出「重试保存」");
await settle();
assert.equal(pill.dataset.visible, "true", "🔴 失败态绝不能自己退场：退场等于把重试按钮也带走");

/* ── ⑤ 重试成功 → 退场（这条路径最容易漏） ── */
api.saveData = realSave;
await S.saveNow();
assert.equal(pill.dataset.phase, "saved");
assert.equal(retry.hidden, true, "回到已保存要把「重试保存」收起来");
assert.equal(pill.dataset.visible, "false", "重试成功后同样不许留回执");
await settle();
assert.equal(pill.dataset.visible, "false");

/* ─────────────────────── CSS 层 ─────────────────────── */

assert.match(indexHtml, /styles\/storage-status\.css/, "这块样式由 index.html 直接 link，删了标签就整套失效");

const hiddenRule = css.match(/\.storage-status\[data-visible="false"\]\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(hiddenRule, "必须有 [data-visible=false] 规则：它是唯一的显隐开关");
assert.match(hiddenRule, /visibility:\s*hidden/, "收起要撤 visibility，否则透明块仍在焦点链和点击链里");
assert.match(hiddenRule, /pointer-events:\s*none/);
assert.match(hiddenRule, /opacity:\s*0/);

const shownRule = css.match(/\.storage-status\[data-visible="true"\]\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(shownRule, "必须有 [data-visible=true] 规则");
assert.match(shownRule, /visibility:\s*visible/);
assert.match(shownRule, /transition-delay:\s*0s,\s*0s,\s*0s/,
  "🔴 展开要把 transition-delay 清零：只靠基类那条 .18s 延迟，收起再展开会出现「先隐身再淡入」");

const baseRule = css.match(/\.storage-status\s*\{([^}]*)\}/)?.[1] ?? "";
assert.match(baseRule, /transition:[^;]*visibility 0s linear \.18s/,
  "🔴 收起路径必须把 visibility 推迟到淡出结束，否则中途还能点到按钮");
assert.doesNotMatch(baseRule, /transform:\s*translateY\(6px\)/);

// 老写法是「已保存时只把不透明度压到 .7」，也就是永久留在屏幕上 —— 这条必须彻底消失，
// 否则 data-visible 开关会被它绕过去（哪怕只剩 .7 的不透明度，字还是看得见）。
const savedRule = css.match(/\.storage-status\[data-phase="saved"\]\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(savedRule, "saved 态仍要有规则（负责 pointer-events）");
assert.doesNotMatch(savedRule, /opacity/, "🔴 saved 态不许再单独写 opacity：显隐只归 data-visible 管");

assert.match(css, /:root\[data-ui-motion="reduced"\]\s*\.storage-status\s*\{\s*transition:\s*none/,
  "应用内「减少动效」要掐掉位移与淡出");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.storage-status\s*\{\s*transition:\s*none/,
  "系统级减少动效同样要掐掉");

console.log("PASS: 保存状态浮标（启动首帧不露面 / 普通写入全程不露面 / 卡住才露面 / 失败常驻 + 重试 / 重试成功退场 / CSS 显隐与延迟契约）");
