import assert from "node:assert/strict";
import { readProductSource } from "./lib/read-product-source.mjs";

/*
 * 启动 / 刷新蒙版的行为守卫（v0.232.0）。
 *
 * 用户需求原文：「在刷新时，添加一个蒙版。蒙板上面有文字，文字形式，参考左上角的标题，
 * 当刷新完成时，取消模板。」
 *
 * 这条测试**真跑** src/loadingMask.js（用最小 DOM 替身，不用 jsdom），守四类事故：
 *   ① 蒙版必须在 boot() 第一行就挂上、且是 HTML 里的空壳（等模块加载完再 createElement
 *      会先闪一下半成品界面）——「挂载不动 DOM 之外的东西、重复调用无副作用」；
 *   ② 字标必须**先等主题**再放：字标是渐变裁剪文字，浅色/深色两套渐变靠 data-theme-mode
 *      二选一，而那个属性要等 initTheme() 才写。所以 mount 时不许有 .brand，
 *      reveal 之后才许有 —— 否则深色用户会看到「先亮色字标、再跳成深色」；
 *   ③ 淡出必须是 `hidden` 之外的路径：`[hidden]` 是 display:none，会把淡出直接掐断，
 *      所以收尾只能靠 `.leaving` + 过渡结束摘节点；减少动效时同步摘掉；
 *   ④ 「取消蒙版」要幂等，且不能把已经亮起来的界面重新盖住（CSS 侧 pointer-events: none）。
 */

const source = readProductSource(new URL("../src/loadingMask.js", import.meta.url), "utf8");

/* ── 最小 DOM 替身 ── */
function makeElement(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    attrs: new Map(),
    classes: new Set(),
    listeners: [],
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...this.classes].join(" "); },
    get textContent() { return this.children.map((c) => c.textContent || "").join(""); },
    set textContent(v) { this.children = [{ textContent: String(v) }]; },
    /* 装饰线是 `svg.innerHTML = \`…\`` 塞进去的。真解析没必要 —— 本测试只关心
       「蒙版那条线的渐变 id 是不是自己那个」，所以把每对标签压成一个节点，
       记下 tag / class / 其余属性，够断言用。 */
    set innerHTML(markup) {
      const parse = (frag) => {
        const out = [];
        const re = /<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g;
        const stack = [{ children: out }];
        let m;
        while ((m = re.exec(frag))) {
          const [, close, tag, attrs, selfClose] = m;
          if (close) { if (stack.length > 1) stack.pop(); continue; }
          const node = makeElement(tag);
          for (const [, name, value] of attrs.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) node.setAttribute(name, value);
          stack[stack.length - 1].children.push(node);
          if (!selfClose) stack.push(node);
        }
        return out;
      };
      this.children = parse(String(markup));
    },
    get innerHTML() { return ""; },
    classList: {
      add: (...n) => n.forEach((x) => el.classes.add(x)),
      remove: (...n) => n.forEach((x) => el.classes.delete(x)),
      contains: (n) => el.classes.has(n),
    },
    setAttribute(n, v) { this.attrs.set(n, String(v)); if (n === "class") this.className = v; },
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; },
    removeAttribute(n) { this.attrs.delete(n); },
    hasAttribute(n) { return this.attrs.has(n); },
    append(...nodes) {
      for (const n of nodes) { n.parentNode = this; this.children.push(n); }
      return this;
    },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; },
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
    querySelector(sel) {
      for (const child of this.children) {
        if (child.matches?.(sel)) return child;
        const deep = child.querySelector?.(sel);
        if (deep) return deep;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      for (const child of this.children) {
        if (child.matches?.(sel)) out.push(child);
        out.push(...(child.querySelectorAll?.(sel) || []));
      }
      return out;
    },
    matches(sel) {
      if (sel.startsWith(".")) return this.classes.has(sel.slice(1));
      if (sel.startsWith("[")) return this.attrs.has(sel.slice(1, -1));
      return this.tagName === sel.toUpperCase();
    },
  };
  Object.defineProperty(el, "isConnected", { get: () => !!el.parentNode || el.__connected === true });
  return el;
}

function makeHarness({ reducedMotion = false } = {}) {
  const doc = makeElement("html");
  const body = makeElement("body");
  const shell = makeElement("div");
  shell.setAttribute("data-refresh-mask", "");
  shell.setAttribute("hidden", "");
  body.append(shell);
  doc.append(body);
  doc.querySelector = (sel) => (sel === "[data-refresh-mask]" ? shell : body.querySelector(sel));
  doc.createElement = (tag) => makeElement(tag);
  doc.createElementNS = (_ns, tag) => makeElement(tag);
  doc.documentElement = doc;

  const frames = new Map();
  const timers = new Map();
  let seq = 0;
  const win = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame: (fn) => { const id = ++seq; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const flushFrames = () => { const all = [...frames.values()]; frames.clear(); all.forEach((fn) => fn()); };
  const fireTimers = () => {
    const all = [...timers.values()];
    timers.clear();
    all.forEach((t) => t.fn());
    return all;
  };

  // brandWordmark 的真模块要真跑（蒙版复用的就是它），所以照旧读源码并剥掉 import。
  const wordmarkSrc = readProductSource(new URL("../src/brandWordmark.js", import.meta.url), "utf8");
  const brandMark = new Function("document", `${wordmarkSrc.replace(/^export /gm, "")}\nreturn brandMark;`)(doc);

  const mod = new Function(
    "document", "window", "brandMark", "requestAnimationFrame", "clearTimeout", "setTimeout",
    `${source.replace(/^import .*$/m, "").replace(/^export /gm, "")}\nreturn { mountRefreshMask, revealRefreshMask, finishRefreshMask };`,
  )(doc, win, brandMark, win.requestAnimationFrame, win.clearTimeout, win.setTimeout);

  return { doc, shell, mod, flushFrames, fireTimers, win };
}

/* ── 1. 挂载：只铺壳、不放字，幂等 ── */
{
  const h = makeHarness();
  const host = h.mod.mountRefreshMask();
  assert.equal(host, h.shell, "mountRefreshMask() 必须返回 HTML 里那颗空壳本身（不是新建一个）");
  assert.equal(h.shell.hasAttribute("hidden"), false, "挂载时要摘掉 hidden，否则蒙版一直 display:none");
  assert.equal(h.shell.getAttribute("aria-hidden"), "true", "蒙版是纯装饰，必须 aria-hidden（读屏不该念它）");
  assert.equal(h.shell.querySelector(".brand"), null,
    "mountRefreshMask() 阶段不许放字标：data-theme-mode 还没写，深色用户会看到色标跳一下");
  assert.equal(h.shell.querySelector(".ready"), null, "挂载阶段不许直接落到可见态（应两帧 rAF 后再加）");
  assert.equal(h.mod.mountRefreshMask(), h.shell, "重复挂载必须幂等");
  assert.equal(h.shell.children.length, 0, "重复挂载不许往壳里塞第二份内容");
}

/* ── 2. 揭示：真放字标 + 真起淡入 ── */
{
  const h = makeHarness();
  h.mod.mountRefreshMask();
  const host = h.mod.revealRefreshMask();
  assert.equal(host, h.shell);
  const brand = h.shell.querySelector(".brand");
  assert.ok(brand, "revealRefreshMask() 必须把 .brand 放进蒙版");
  assert.equal(brand.children[0].textContent, "U Time WorkSpace",
    "蒙版上的字必须就是左上角那句品牌文案（唯一事实源是 brandWordmark.js 的 BRAND_NAME）");
  assert.ok(brand.children[1] && brand.children[1].classes.has("brand-rule"),
    "蒙版上也要有那条哥特装饰线（与左上角同一份 brandRule()）");
  const gradId = brand.children[1].children.find((c) => c.matches?.("defs"))?.children[0]?.getAttribute("id");
  assert.equal(gradId, "refreshMaskBrandRuleGrad",
    "蒙版那条装饰线必须用自己的渐变 id：与侧栏同 id 时先出现的定义会赢，蒙版会借错色标");
  assert.equal(h.shell.querySelector(".ready"), null, "第一帧还不该是 ready（要给淡入留起点）");
  h.flushFrames();
  assert.equal(h.shell.querySelector(".ready"), null, "需要两帧 rAF：一帧布局、一帧才加类");
  h.flushFrames();
  assert.ok(h.shell.classes.has("ready"), "两帧 rAF 后必须加上 .ready（CSS 由它从 opacity:0 淡入）");
  const before = h.shell.children.length;
  h.mod.revealRefreshMask();
  assert.equal(h.shell.children.length, before, "重复 reveal 不许塞第二份字标");
}

/* ── 3. 减少动效：直接落到可见态，不排 rAF ── */
{
  const h = makeHarness({ reducedMotion: true });
  h.mod.mountRefreshMask();
  h.mod.revealRefreshMask();
  assert.ok(h.shell.classes.has("ready"), "减少动效时应当直接可见，不等 rAF");
  assert.equal(h.fireTimers().length, 0, "减少动效时不该排任何定时器");
}

/* ── 4. 收尾：`hidden` 之外的路径 + 幂等 ── */
{
  const h = makeHarness();
  h.mod.mountRefreshMask();
  h.mod.revealRefreshMask();
  h.flushFrames();
  h.mod.finishRefreshMask();
  assert.ok(h.shell.classes.has("leaving"), "收尾必须靠 .leaving 起淡出（[hidden] 是 display:none，会掐断过渡）");
  assert.equal(h.shell.hasAttribute("hidden"), false, "收尾不许退回 hidden：那会把 220ms 淡出直接掐断");
  assert.equal(h.shell.isConnected, true, "过渡还没跑完，节点必须留着（否则没有淡出可看）");
  const timers = h.fireTimers();
  assert.equal(timers.length, 1, "应当只排一个「过渡结束再摘节点」的定时器");
  assert.ok(timers[0].ms > 220, "摘节点的延时必须大于 CSS 里的过渡时长 220ms");
  assert.equal(h.shell.isConnected, false, "过渡结束后必须真的把蒙版从文档里摘掉（这就是「取消蒙版」）");
  assert.doesNotThrow(() => h.mod.finishRefreshMask(), "重复取消必须幂等（节点已摘走）");
}

/* ── 5. 收尾与「减少动效」设置联动（应用内设置优先于系统偏好） ── */
{
  const h = makeHarness();
  h.mod.mountRefreshMask();
  h.mod.revealRefreshMask();
  h.flushFrames();
  h.doc.dataset = { uiMotion: "reduced" };
  h.mod.finishRefreshMask();
  assert.equal(h.shell.classes.has("leaving"), false,
    "应用内「减少动效」开着时不该再起位移动画：应同步摘掉");
  assert.equal(h.shell.isConnected, false, "减少动效时要立刻取消蒙版，不留空窗");
  assert.equal(h.fireTimers().length, 0, "减少动效时不该排延时定时器");
}

/* ── 6. 接线：boot() 里的三步顺序 ── */
{
  const mainSrc = readProductSource(new URL("../src/main.js", import.meta.url), "utf8");
  const boot = /async function boot\(\)\s*\{([\s\S]*?)\n\}/.exec(mainSrc)?.[1];
  assert.ok(boot, "找不到 main.js 的 boot()");
  const at = (needle) => boot.indexOf(needle);
  assert.ok(at("mountRefreshMask()") > -1, "boot() 必须挂启动蒙版");
  assert.ok(at("mountRefreshMask()") < at("await initStore("),
    "mountRefreshMask() 必须在 await initStore() **之前**同步挂上（否则会先闪一下半成品界面）");
  assert.ok(at("initTheme()") < at("revealRefreshMask()"),
    "revealRefreshMask() 必须在 initTheme() 之后：字标渐变要靠 data-theme-mode 二选一");
  assert.ok(at("await revealAppWindow()") < at("finishRefreshMask()"),
    "finishRefreshMask() 必须在 revealAppWindow() 之后：先亮界面、再让蒙版淡出，两段动画交叠才是交接");
  assert.ok(at("revealRefreshMask()") < at("finishRefreshMask()"), "揭示在取消之前");
  const html = readProductSource(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-refresh-mask/, "index.html 必须有那颗空壳（首帧就在文档里，弱机不闪半成品）");
  assert.match(html, /data-refresh-mask[^>]*hidden/, "空壳必须带 hidden：JS 没跑到时至少不占位");
}

/* ── 7. CSS 契约：类名 / 过渡时长 / 不拦指针 ── */
{
  const css = readProductSource(new URL("../src/styles.css", import.meta.url), "utf8");
  const block = /\.refresh-mask\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(block, "styles.css 缺少 .refresh-mask 基础规则");
  assert.match(block, /position:\s*fixed/, "蒙版要固定铺满");
  assert.match(block, /inset:\s*0/, "蒙版要铺满整屏");
  assert.match(block, /background:\s*var\(--bg\)/,
    "底色要用主题自己的 --bg：字标渐变是按侧栏底色实算对比度的，与侧栏同色系才不糊");
  assert.match(block, /pointer-events:\s*none/,
    "蒙版不许拦指针：淡出那 220ms 里界面已经亮起来，要能点");
  assert.match(block, /transition:\s*opacity\s+220ms/, "淡出过渡 220ms（loadingMask.js 的 FADE_MS 要对上）");
  const fade = /const FADE_MS = (\d+)/.exec(source)?.[1];
  assert.equal(Number(fade), 220, "loadingMask.js 的 FADE_MS 必须与 CSS 的 220ms 一致");
  assert.match(css, /\.refresh-mask:not\(\.ready\)\s*\{\s*opacity:\s*0/, "未 ready 时必须是 opacity:0（淡入起点）");
  assert.match(css, /\.refresh-mask\.leaving\s*\{\s*opacity:\s*0/, "leaving 时必须是 opacity:0（淡出终点）");
  assert.match(css, /\.refresh-mask\[hidden\]\s*\{\s*display:\s*none/, "hidden 只作兜底：JS 没跑到时不占位");
  assert.match(css, /\.refresh-mask\s+\.brand\s+b\s*\{[^}]*font-size:\s*calc\(34px \* var\(--ui-text-scale\)\)/,
    "蒙版字标要单独一档字号（34px），且选择器必须多一层 —— 否则会把 test-brand-wordmark 的规则计数读歪");
  // 侧栏那条量出来的定值不许被顺手改成变量（test-brand-wordmark 直接比对它）
  assert.match(css, /font-size:\s*calc\(20px \* var\(--ui-text-scale\)\)/,
    "侧栏 .brand b 的字号仍是量出来的定值，别改成变量");
}

console.log("PASS: 启动/刷新蒙版（空壳首帧挂载 · 主题就位后才放同源字标 · 两帧 rAF 淡入 · .leaving 淡出后摘节点 · 减少动效同步摘 · boot 三步顺序 · CSS 契约）");
