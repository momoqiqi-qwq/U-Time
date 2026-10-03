import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 通知堆叠（图2 那种「多条横幅叠成一张，鼠标移上去背后那张向上散开」）回归测试。
 *
 * 分两层：
 *  ① JS 层（跑真代码）：`toast()` 往容器里塞卡 → 该不该折叠、`--item-h` 有没有写进去。
 *     判据只有一条：`is-stacked` 决定折叠，而 CSS 只认这个类 —— 两边对不上就是白做。
 *  ② CSS 层（读文本）：折叠公式、hover/焦点展开、触屏不折叠这三件事必须都在，
 *     而且公式里必须减掉 `--item-h`（漏减会叠成「所有卡顶对齐」，看着像只有一张）。
 *
 * 为什么值得写：这套交互的失败模式全是**静默**的 —— 公式写错、类名对不上、媒体查询
 * 漏掉触屏，页面都不会报错，只会「看着不对」，而手机上根本没法用眼睛验。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const styles = readProductSource(path.join(appRoot, "src/styles.css"), "utf8");

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
    this._vars = {};
    // 堆叠要读真实盒高；测试里由用例显式设定（浏览器里是布局引擎给的）。
    this.offsetHeight = 0;
    this.style = {
      cssText: "",
      setProperty: (name, value) => { this._vars[name] = value; },
      getPropertyValue: (name) => this._vars[name] ?? "",
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this._classes;
    return {
      contains: (c) => set.has(c),
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      toggle: (c, on) => {
        const next = on === undefined ? !set.has(c) : !!on;
        if (next) set.add(c); else set.delete(c);
        return next;
      },
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

const toastsBox = new FakeNode("div");
globalThis.document = {
  body: new FakeNode("body"),
  documentElement: { dataset: { uiMotion: "reduced" } },
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => (id === "toasts" ? toastsBox : null),
};
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const { toast } = await import("../src/ui.js");
const { refreshStack } = await import("../src/notifyStack.js");

/* ── ① JS：什么时候折叠 ── */

assert.equal(toastsBox.classList.contains("notify-stack"), false, "容器类名由 toast() 负责加，别写死在 index.html 之外");

const first = toast("第一条");
first.node.offsetHeight = 44;
refreshStack(toastsBox);
assert.equal(toastsBox.classList.contains("is-stacked"), false, "只有一条时不折叠 —— 没有可藏的背后那张");
assert.equal(first.node.style.getPropertyValue("--item-h"), "44px", "卡片高度要写进 --item-h，折叠量靠它算");

const second = toast("第二条");
second.node.offsetHeight = 60;
refreshStack(toastsBox);
assert.equal(toastsBox.classList.contains("is-stacked"), true, "两条以上才折叠");
assert.equal(second.node.style.getPropertyValue("--item-h"), "60px");

/* 常驻卡带着要用户按的按钮，被盖住等于按钮消失 —— 只要有一张在，整列摊平。 */
const pinned = toast("长鸣：要人来处理", { ms: 0 });
pinned.node.offsetHeight = 52;
refreshStack(toastsBox);
assert.ok(pinned.node.hasAttribute("data-pin"), "ms:0 的常驻横幅要自动打上 data-pin");
assert.equal(toastsBox.classList.contains("is-stacked"), false, "有常驻卡时不许折叠");

// 常驻卡撤掉后要能重新折叠，否则 data-pin 的判定只在第一次生效。
pinned.close();
refreshStack(toastsBox);
assert.equal(toastsBox.classList.contains("is-stacked"), true, "常驻卡收掉，堆叠要恢复");

/* ── ② CSS：折叠公式与生效条件 ── */

const stackBlock = styles.match(/@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.ok(stackBlock, "必须存在只认指针的堆叠媒体查询（触屏没有 hover，折叠等于藏东西）");
assert.match(stackBlock, /\.notify-stack\.is-stacked > \*:not\(:last-child\)/,
  "折叠只作用于「除最前面那张之外」的卡：最前面那张必须一动不动");
assert.match(stackBlock, /margin-bottom:\s*calc\(\(var\(--ns-peek\) - var\(--item-h, 0px\) - var\(--ns-gap\)\) \* var\(--ns-fold\)\)/,
  "🔴 折叠量必须减掉 --item-h：漏减会把所有卡顶对齐，看着像只剩一张");
assert.match(stackBlock, /:hover > \*,[\s\S]*:focus-within > \*\s*\{\s*margin-bottom:\s*0/,
  "hover 与键盘焦点都要展开（只用 :hover 的话键盘用户永远看不到被藏的那张）");
assert.match(stackBlock, /transition:\s*margin-bottom/,
  "展开必须是 margin 过渡：用 JS 改 top/transform 会和入场动画的 transform 打架");

/* 设置里的「通知叠成一张」开关：走折叠系数，而不是删规则 —— 拨完当场就变。 */
assert.match(styles, /\.notify-stack\s*\{[^}]*--ns-fold:\s*1/, "折叠系数默认必须是 1（开着）");
assert.match(styles, /:root\[data-notify-stack="off"\]\s*\.notify-stack\s*\{\s*--ns-fold:\s*0/,
  "🔴 关掉开关要把 --ns-fold 归零：整条折叠公式乘出 0，才等于回到逐条竖排");
// 归零要能真的算出 0：漏乘系数的话，开关拨到「关」卡片照旧叠着。
assert.ok(styles.includes("* var(--ns-fold))"), "折叠公式必须乘 --ns-fold");

assert.match(styles, /\.notify-stack\s*\{[^}]*--ns-peek:\s*11px/, "露出边要有默认值（11px：只露圆角边，不露正文）");
assert.match(styles, /#toasts\s*\{[^}]*gap:\s*var\(--ns-gap/, "#toasts 的间距要和 --ns-gap 同源，否则折叠公式算错");

/* ──  更新通知：容器与卡片拆分（堆叠的单元是卡，不是容器） ── */

const cardRule = styles.match(/\.update-toast-card\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(cardRule, "必须存在 .update-toast-card：折叠/hover 作用在卡上，容器只管定位");
assert.match(cardRule, /background:\s*var\(--panel\)/, "卡片外观走主题令牌，深色模式自动成立");
assert.match(styles, /\.update-toast\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/,
  "更新容器要竖排，才能和 #toasts 共用同一套堆叠公式");
assert.match(styles, /\.ns-spinner\s*\{[^}]*animation:\s*ns-spin/, "进度卡要有 spinner：数字没动时它是唯一「还在下」的凭据");
assert.match(styles, /\.update-live-meter\s*\{[^}]*font-variant-numeric:\s*tabular-nums/,
  "🔴 进度读数要等宽数字，否则每秒刷新时整行字在左右抖");
// spinner 与进度行都写了 display，会把 UA 的 `[hidden]{display:none}` 压过去 —— 项目里踩过两次。
// 取「兜底选择器组」本体而不是全文匹配：那段注释里也写着 `[hidden]{display:none}`，
// 正则从注释里起手也能配上，判据就会指向错的地方。
const hiddenBlock = styles.match(/\.update-progress\[hidden\],[\s\S]*?display:\s*none\s*!important/)?.[0] ?? "";
assert.ok(hiddenBlock, "必须存在 [hidden] 兜底选择器组");
assert.match(hiddenBlock, /\.update-live-meter\[hidden\]/, "缺 .update-live-meter[hidden] 兜底：下完之后进度行藏不掉");
assert.match(hiddenBlock, /\.ns-spinner\[hidden\]/, "缺 .ns-spinner[hidden] 兜底：非下载态 spinner 会一直挂着");

/* ── ④ 设置里的开关：界面与交互卡片，且只在桌面出现 ── */

const appearance = readProductSource(path.join(appRoot, "src/views/settings/appearance.js"), "utf8");
assert.match(appearance, /通知叠成一张（鼠标悬停展开）/, "设置 › 界面与交互必须有这个开关");
assert.match(appearance, /desktopWindow \? toggleRow\("通知叠成一张/,
  "🔴 手机端没有 hover，CSS 那套折叠压根不生效 —— 开关必须跟着桌面才摆出来，别摆个拧不动的");
assert.match(appearance, /setUiPreferences\(\{ notifyStack: value \}\)/, "开关要写进 settings.ui.notifyStack");
assert.match(readProductSource(path.join(appRoot, "src/settingsSearchIndex.js"), "utf8"),
  /通知叠成一张（鼠标悬停展开）/, "设置项要进全局搜索索引（标题必须是界面上的原文）");

console.log("PASS: 通知堆叠（折叠时机 / data-pin 摊平 / 折叠公式 / hover+焦点展开 / 触屏不折叠 / 设置开关 / 更新卡拆分与进度行样式）");
