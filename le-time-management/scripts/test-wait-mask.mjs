import assert from "node:assert/strict";
import { readProductSource } from "./lib/read-product-source.mjs";

/*
 * 刷新等待蒙版的行为守卫（v0.233.0）。
 *
 * 用户需求原文：「给其他需要刷新等待时间的界面也添加这种蒙版。」（v0.232.0 那条是启动/刷新那一次）
 *
 * 这条测试**真跑** src/waitMask.js（用最小 DOM 替身，不用 jsdom），守四类事故：
 *   ① 快操作不许闪：50ms 就结束的刷新如果也弹一下蒙版，比没有蒙版更烦 —— 必须延迟 180ms 才起；
 *   ② 起了就不许抽搐：210ms 才起的蒙版不能在 220ms 就消失 —— 一旦显示，至少停 420ms；
 *   ③ 并发不许互相踩：打开视图的渲染等待与插件自己的拉取会重叠，必须引用计数 + 取最新标签，
 *      少一次 release 蒙版撤不掉、多一次 release 蒙版提前消失，两种都是「界面永久锁死 / 内容没画完就解锁」；
 *   ④ 收尾必须真的摘节点，且不能把已经画好的界面重新盖住（CSS 侧半透明 + 不拦指针）。
 */

const source = readProductSource(new URL("../src/waitMask.js", import.meta.url), "utf8");

/* ── 最小 DOM 替身（与 test-refresh-mask.mjs 同一套，加了 dataset / textContent 语义） ── */

/* 只认单层选择器（`.class` / `[attr]` / `tag`），但支持空格分隔的后代组合
   （`.brand b`、`.wait-mask-count` 这类都要能选中）。 */
function matchSimple(node, sel) {
  if (sel.startsWith(".")) return node.classes.has(sel.slice(1));
  if (sel.startsWith("[")) return node.attrs.has(sel.slice(1, -1));
  return node.tagName === sel.toUpperCase();
}
function matchesSelector(node, sel) {
  const parts = String(sel).trim().split(/\s+/);
  if (!matchSimple(node, parts[parts.length - 1])) return false;
  let cur = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (cur) {
      if (matchSimple(cur, parts[i])) { found = true; cur = cur.parentNode; break; }
      cur = cur.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function makeElement(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    attrs: new Map(),
    classes: new Set(),
    dataset: {},
    /* 内联自定义属性（waitMask.js 的 wide 档把估宽写进 --wait-mask-em）。
       真 DOM 一定有 style，替身也得有 —— 少了它测的是替身的短板，不是产品代码。 */
    style: {
      props: new Map(),
      setProperty(n, v) { this.props.set(n, String(v)); },
      getPropertyValue(n) { return this.props.has(n) ? this.props.get(n) : ""; },
      removeProperty(n) { this.props.delete(n); },
    },
    listeners: [],
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...this.classes].join(" "); },
    get textContent() { return this.children.map((c) => c.textContent || "").join(""); },
    set textContent(v) { this.children = [{ textContent: String(v) }]; },
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
    matches(sel) { return matchesSelector(this, sel); },
  };
  Object.defineProperty(el, "isConnected", { get: () => !!el.parentNode || el.__connected === true });
  return el;
}

function makeHarness({ reducedMotion = false, withShell = true } = {}) {
  const doc = makeElement("html");
  const body = makeElement("body");
  const shell = makeElement("div");
  if (withShell) {
    shell.setAttribute("class", "wait-mask");
    shell.setAttribute("data-wait-mask", "");
    shell.setAttribute("hidden", "");
    body.append(shell);
  }
  doc.append(body);
  doc.body = body;
  doc.querySelector = (sel) => (sel === "[data-wait-mask]" && withShell && shell.isConnected ? shell : body.querySelector(sel));
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
  /* 按到期时间升序跑一批定时器（waitMask 会同时排「延迟出现」与「兜底上限」两个，顺序有意义）。 */
  const fireTimers = (maxMs = Infinity) => {
    const due = [...timers.entries()].filter(([, t]) => t.ms <= maxMs).sort((a, b) => a[1].ms - b[1].ms);
    due.forEach(([id]) => timers.delete(id));
    due.forEach(([, t]) => t.fn());
    return due.map(([, t]) => t.ms);
  };
  const pendingTimers = () => [...timers.values()].map((t) => t.ms).sort((a, b) => a - b);
  /* 「最短停留」那条定时器的实际时长是 MIN_VISIBLE_MS 减去已经显示的毫秒数，
     所以断言不能拿它做等值比较（实测可能是 419）。这里只判「有没有那条定时器」。 */
  const hasMinVisibleTimer = () => pendingTimers().some((ms) => ms > 0 && ms <= mod.MIN_VISIBLE_MS);

  // brandWordmark 的真模块要真跑（蒙版复用的就是它），所以照旧读源码并剥掉 import。
  const wordmarkSrc = readProductSource(new URL("../src/brandWordmark.js", import.meta.url), "utf8");
  const brandMark = new Function("document", `${wordmarkSrc.replace(/^export /gm, "")}\nreturn brandMark;`)(doc);

  const mod = new Function(
    "document", "window", "brandMark", "requestAnimationFrame", "clearTimeout", "setTimeout",
    `${source.replace(/^import .*$/m, "").replace(/^export /gm, "")}
return { SHOW_DELAY_MS, MIN_VISIBLE_MS, FADE_MS, MAX_HOLD_MS, showWaitMask, withWaitMask, resetWaitMask };`,
  )(doc, win, brandMark, win.requestAnimationFrame, win.clearTimeout, win.setTimeout);

  const maskEl = () => body.children.find((c) => c.classes.has("wait-mask")) || null;
  const brandText = () => maskEl()?.querySelector(".brand b")?.textContent ?? null;
  const badgeText = () => maskEl()?.querySelector(".wait-mask-count")?.textContent ?? null;

  return { doc, body, shell, mod, flushFrames, fireTimers, pendingTimers, hasMinVisibleTimer, maskEl, brandText, badgeText };
}

/* ── 1. 延迟出现：快操作不闪 ── */
{
  const h = makeHarness();
  const release = h.mod.showWaitMask("正在刷新…");
  assert.equal(h.maskEl().hasAttribute("hidden"), true, "调用后不许立刻显示：必须等 SHOW_DELAY_MS 的延迟");
  assert.deepEqual(h.pendingTimers().includes(h.mod.SHOW_DELAY_MS), true,
    `必须排一个 ${h.mod.SHOW_DELAY_MS}ms 的延迟定时器（快操作不闪蒙版）`);
  h.fireTimers(h.mod.SHOW_DELAY_MS - 1);
  assert.equal(h.maskEl().hasAttribute("hidden"), true, "延迟没到之前不许显示");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "延迟到了必须显示");
  release();
}

/* ── 2. 延迟期内就结束：一次蒙版都不许出现 ── */
{
  const h = makeHarness();
  const release = h.mod.showWaitMask("正在刷新…");
  release();
  const fired = h.fireTimers(Infinity);
  assert.equal(h.maskEl().hasAttribute("hidden"), true,
    "180ms 内就结束的刷新绝不能闪出蒙版（延迟期内 release 必须把延迟定时器一起清掉）");
  assert.equal(fired.includes(h.mod.MIN_VISIBLE_MS), false, "从没显示过就不该走「最短停留」那条路");
}

/* ── 3. 最短停留：起了就不许抽搐 ── */
{
  const h = makeHarness();
  const release = h.mod.showWaitMask("正在刷新…");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  release();                                        // 刚显示就结束
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "刚显示就被 release 时不许立刻撤：要补足最短停留");
  assert.ok(h.hasMinVisibleTimer(),
    `必须补足 ${h.mod.MIN_VISIBLE_MS}ms 的最短停留（否则是 10ms 的淡入淡出，比不显示更像故障）`);
  h.fireTimers(h.mod.MIN_VISIBLE_MS);
  assert.ok(h.maskEl().classes.has("leaving"), "最短停留走完才起淡出（走 .leaving，不是 hidden）");
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "收尾不许退回 hidden：那会把淡出直接掐断");
  const left = h.fireTimers(Infinity);
  assert.equal(left.length, 1, "应当只排一个「过渡结束再摘节点」的定时器");
  assert.ok(left[0] > h.mod.FADE_MS, "摘节点的延时必须大于 CSS 里的过渡时长");
  assert.equal(h.maskEl(), null, "过渡结束后必须真的把蒙版从文档里摘掉");
}

/* ── 4. 引用计数 + 标签栈：并发等待取最新那条，并显示 ×N ── */
{
  const h = makeHarness();
  const a = h.mod.showWaitMask("正在刷新课表…");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.brandText(), "正在刷新课表…", "蒙版上的字必须就是传进来的文案");
  assert.equal(h.maskEl().dataset.size, "compact", "10 字以内的标签走 compact 档");
  assert.equal(h.badgeText(), null, "只有一个等待时不显示 ×N");
  const b = h.mod.showWaitMask("正在同步账单…");
  assert.equal(h.brandText(), "正在同步账单…", "多个等待并存时取**最后**一个标签（最贴近用户当下在做的事）");
  assert.equal(h.badgeText(), "×2", "两个等待并存必须显示 ×2");
  b();
  assert.equal(h.brandText(), "正在刷新课表…", "后进来的那个结束之后，蒙版要退回剩下那条标签");
  assert.equal(h.badgeText(), null, "只剩一个时 ×N 必须摘掉");
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "还有等待在跑，蒙版不许撤");
  a();
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "最短停留没走完之前蒙版要留着（刚显示就撤 = 抽搐）");
  assert.ok(h.hasMinVisibleTimer(),
    "最后一个等待结束才排最短停留定时器，之后才淡出");
  h.fireTimers(h.mod.MIN_VISIBLE_MS);
  h.fireTimers(Infinity);
  assert.equal(h.maskEl(), null, "全部等待结束 + 最短停留走完 → 蒙版真的撤掉");
}

/* ── 5. release 幂等：多撤一次不许把别人的等待算掉 ── */
{
  const h = makeHarness();
  const a = h.mod.showWaitMask("A");
  const b = h.mod.showWaitMask("B");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  a(); a(); a();
  assert.equal(h.badgeText(), null, "重复 release 必须幂等：撤三次也只能减掉自己那一个（否则会提前解锁别人的等待）");
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "B 还在等，蒙版必须留着");
  b();
}

/* ── 6. 字号档位：空文案走品牌档、超长走 wide（不横向溢出） ── */
{
  const h = makeHarness();
  const r1 = h.mod.showWaitMask();
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.brandText(), "U Time WorkSpace", "不传文案时蒙版上就是左上角那句品牌字标（唯一事实源 brandWordmark.js）");
  assert.equal(h.maskEl().dataset.size, "brand", "空文案走 brand 档（与启动蒙版同字号）");
  r1();
  h.mod.resetWaitMask();

  const h2 = makeHarness();
  const long = "正在读取培养计划与课程模块进度";
  const r2 = h2.mod.showWaitMask(long);
  h2.fireTimers(h2.mod.SHOW_DELAY_MS);
  assert.equal(h2.brandText(), long);
  assert.equal(h2.maskEl().dataset.size, "wide",
    "超过 10 字的标签必须走 wide 档：CSS 那档用 clamp 把字号压进视口，任意长文案都不会横向溢出");
  // 估宽：15 个汉字 = 15em。写死除数时 34px × 15 = 510px 在 390px 视口上直接顶出屏幕。
  assert.equal(h2.maskEl().style.getPropertyValue("--wait-mask-em"), "15",
    "wide 档必须把估宽写进 --wait-mask-em（纯汉字：字数 = em 数）");
  // 混排：汉字 1em、拉丁/数字 0.55em —— 「正在读取 2025 年节假日…」= 7 汉字 + 空格 + 4 数字 + 3 汉字
  const mixed = makeHarness();
  const rm = mixed.mod.showWaitMask("正在读取 2025 年节假日…");
  mixed.fireTimers(mixed.mod.SHOW_DELAY_MS);
  const em = Number(mixed.maskEl().style.getPropertyValue("--wait-mask-em"));
  assert.ok(em > 9 && em < 13, `混排标签的估宽应落在 10em 上下，实测 ${em}`);
  rm();
  // 离开 wide 档要清掉估宽，否则短标签会借到上一个长标签的除数
  const short = makeHarness();
  const rs = short.mod.showWaitMask(long);
  short.fireTimers(short.mod.SHOW_DELAY_MS);
  const rs2 = short.mod.showWaitMask("正在刷新…");
  assert.equal(short.maskEl().style.getPropertyValue("--wait-mask-em"), "",
    "短标签走 compact 档时必须清掉 --wait-mask-em");
  rs();
  rs2();
  r2();
}

/* ── 7. 装饰线用自己那颗渐变 id ── */
{
  const h = makeHarness();
  const r = h.mod.showWaitMask("正在刷新…");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  const rule = h.maskEl().querySelector(".brand-rule");
  assert.ok(rule, "等待蒙版上也要有那条哥特装饰线（与左上角同一份 brandRule()）");
  const gradId = rule.children.find((c) => c.matches?.("defs"))?.children[0]?.getAttribute("id");
  assert.equal(gradId, "waitMaskBrandRuleGrad",
    "装饰线必须用自己的渐变 id：与侧栏 / 启动蒙版同 id 时先出现的定义会赢，会借错色标");
  r();
}

/* ── 8. 空壳：复用 HTML 里那颗；被摘掉后能自己重建 ── */
{
  const h = makeHarness();
  const r = h.mod.showWaitMask("正在刷新…");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.maskEl(), h.shell, "必须复用 index.html 里那颗空壳（首帧就在文档中，弱机不闪半成品）");
  r();
  h.fireTimers(h.mod.MIN_VISIBLE_MS);
  h.fireTimers(Infinity);
  assert.equal(h.maskEl(), null, "收尾后节点应当已被摘走");
  const r2 = h.mod.showWaitMask("再来一次");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.ok(h.maskEl(), "空壳被摘掉之后再 show 必须能重建一颗（不依赖空壳还在不在）");
  assert.equal(h.brandText(), "再来一次");
  r2();
  h.mod.resetWaitMask();

  // 连空壳都没有（index.html 被改坏 / 旧缓存）时也得能工作
  const h2 = makeHarness({ withShell: false });
  const r3 = h2.mod.showWaitMask("无壳也要能跑");
  h2.fireTimers(h2.mod.SHOW_DELAY_MS);
  assert.ok(h2.maskEl(), "HTML 里没有空壳时也必须自己建一颗（否则蒙版整条链路静默失效）");
  assert.equal(h2.brandText(), "无壳也要能跑");
  r3();
}

/* ── 9. 减少动效：延迟照旧（拦的是「闪」，不是动画）；出现/消失跳过过渡 ── */
{
  const h = makeHarness({ reducedMotion: true });
  const r = h.mod.showWaitMask("正在刷新…");
  assert.equal(h.maskEl().hasAttribute("hidden"), true,
    "减少动效**也要**延迟出现：这条延迟拦的是「快操作闪一下蒙版」，与位移动画无关");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.maskEl().hasAttribute("hidden"), false);
  assert.ok(h.maskEl().classes.has("ready"), "减少动效时直接落到可见态，不等 rAF");
  r();
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "最短停留照旧生效（拦的还是「闪」）");
  h.fireTimers(h.mod.MIN_VISIBLE_MS);
  assert.equal(h.maskEl(), null, "减少动效时收尾同步摘掉，不走 200ms 淡出");
  assert.equal(h.pendingTimers().length, 0, "减少动效时不该留下任何淡出定时器");
}

/* ── 10. 淡入两帧 rAF（与启动蒙版同一条路径） ── */
{
  const h = makeHarness();
  const r = h.mod.showWaitMask("正在刷新…");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.maskEl().classes.has("ready"), false, "第一帧还不该是 ready（要给淡入留起点）");
  h.flushFrames();
  assert.equal(h.maskEl().classes.has("ready"), false, "需要两帧 rAF：一帧布局、一帧才加类");
  h.flushFrames();
  assert.ok(h.maskEl().classes.has("ready"), "两帧 rAF 后必须加上 .ready（CSS 由它从 opacity:0 淡入）");
  r();
}

/* ── 11. 兜底上限：调用方漏 release 不许把整屏永久锁死 ── */
{
  const h = makeHarness();
  h.mod.showWaitMask("忘了 release 的那次");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.maskEl().hasAttribute("hidden"), false, "先显示出来");
  h.fireTimers(h.mod.MAX_HOLD_MS);
  assert.ok(h.hasMinVisibleTimer(),
    "超过 MAX_HOLD_MS 仍未 release 必须自动撤下（插件异常 / 视图被拆走时 await 永不落地），"
    + "且走的是正常收尾路径（补足最短停留再淡出），不是硬摘");
  h.fireTimers(h.mod.MIN_VISIBLE_MS);
  h.fireTimers(Infinity);
  assert.equal(h.maskEl(), null, "兜底撤下后蒙版必须真的从文档里消失");
}

/* ── 12. withWaitMask：resolve 撤、reject 也撤 ── */
{
  const h = makeHarness();
  let done = 0;
  const p = h.mod.withWaitMask("正在刷新…", async () => { await Promise.resolve(); done++; return 42; });
  assert.equal(done, 0, "任务应当被真正 await（不是同步跑完）");
  const value = await p;
  assert.equal(value, 42, "withWaitMask 必须把 task 的结果原样透传");
  assert.equal(done, 1);
  h.fireTimers(Infinity);
  assert.equal(h.maskEl().hasAttribute("hidden"), true,
    "任务在延迟期内就结束了 → 蒙版一次都不该出现，且延迟定时器必须被清掉（不许事后再弹出来）");

  const h2 = makeHarness();
  await assert.rejects(
    () => h2.mod.withWaitMask("正在刷新…", async () => { throw new Error("boom"); }),
    /boom/,
    "task 抛错必须原样冒泡",
  );
  h2.fireTimers(Infinity);
  assert.equal(h2.maskEl().hasAttribute("hidden"), true,
    "task 抛错也必须撤蒙版（走 finally，不能把蒙版留在屏上）");
}

/* ── 13. resetWaitMask：清干净，下一次 show 读到的是新标签 ── */
{
  const h = makeHarness();
  h.mod.showWaitMask("A");
  h.mod.showWaitMask("B");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.badgeText(), "×2", "先确认两个等待都真挂上了");
  h.mod.resetWaitMask();
  assert.equal(h.maskEl(), null, "reset 必须把节点摘掉");
  assert.deepEqual(h.pendingTimers(), [], "reset 必须把延迟/淡出定时器一起清掉");
  const r = h.mod.showWaitMask("C");
  h.fireTimers(h.mod.SHOW_DELAY_MS);
  assert.equal(h.brandText(), "C", "reset 之后不许再读到脏标签");
  assert.equal(h.badgeText(), null, "reset 之后计数必须归零");
  r();

  // 延迟期内 reset（还没显示过）也必须把延迟定时器清掉，否则事后会冒出一颗孤儿蒙版
  const h2 = makeHarness();
  h2.mod.showWaitMask("D");
  h2.mod.resetWaitMask();
  assert.deepEqual(h2.pendingTimers(), [], "延迟期内的 reset 也要清掉定时器");
  h2.fireTimers(Infinity);
  assert.equal(h2.maskEl().hasAttribute("hidden"), true, "reset 之后不许再冒出一颗孤儿蒙版");
}

/* ── 14. 宿主接线：插件 API + 视图切走兜底 + index.html 空壳 ── */
{
  const host = readProductSource(new URL("../src/pluginHost.js", import.meta.url), "utf8");
  assert.match(host, /import \{ showWaitMask \} from "\.\/waitMask\.js"/, "pluginHost 必须直接用宿主那颗蒙版");
  assert.match(host, /waitMask\(text\)\s*\{[\s\S]{0,200}?showWaitMask\(text\)/,
    "ui.waitMask(text) 必须真的调 showWaitMask");
  assert.match(host, /waitMaskRun\(text, task\)\s*\{[\s\S]{0,400}?\.finally\(release\)/,
    "ui.waitMaskRun 必须在 finally 里 release（插件忘了 try/finally 也不会锁住整屏）");
  assert.match(host, /requirePermission\(man, pid, "ui"\)/, "新增的 ui.* 能力必须照旧过权限门");
  assert.match(host, /function trackPluginWait\(pid, release\)[\s\S]{0,300}?pluginWaits\.get\(pid\)\.set|pluginWaits\.has\(pid\)/,
    "每个插件的等待必须单独记账（逐次注册 disposer 会让 pluginDisposers 无限变长）");
  assert.match(host, /export function releasePluginWaits\(pid\)/, "必须有「撤掉某插件全部等待」的兜底出口");
  const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");
  assert.match(shell, /releasePluginWaits\(prevDef\.pluginView\.pluginId\)/,
    "切走插件视图时必须撤掉它挂着的等待：否则蒙版会留在屏幕上锁住新页面");
  assert.match(shell, /withWaitMask\("正在导入插件…"/, "宿主自己的重活（导入插件包）也要走这套蒙版");
  const html = readProductSource(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-wait-mask/, "index.html 必须有那颗空壳（首帧就在文档里）");
  assert.match(html, /data-wait-mask[^>]*hidden/, "空壳必须带 hidden：JS 没跑到时至少不占位");
}

/* ── 15. CSS 契约：半透明 / 不拦指针 / 层级 / 字号档 / 减少动效 ── */
{
  const css = readProductSource(new URL("../src/styles.css", import.meta.url), "utf8");
  const block = /\.wait-mask\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(block, "styles.css 缺少 .wait-mask 基础规则");
  assert.match(block, /position:\s*fixed/, "等待蒙版要固定铺满");
  assert.match(block, /inset:\s*0/, "等待蒙版要铺满整屏");
  assert.match(block, /color-mix\(in srgb,\s*var\(--bg\)\s*86%,\s*transparent\)/,
    "底色必须是半透明的 --bg：下面那页已经画好了，遮死反而像卡住（启动蒙版才是实心）");
  assert.match(block, /pointer-events:\s*auto/,
    "等待蒙版要拦指针：它盖的是「还没画好的内容」，让用户点到半成品更容易出事");
  assert.match(block, /transition:\s*opacity\s+200ms/, "淡出过渡 200ms（waitMask.js 的 FADE_MS 要对上）");
  const fade = /const FADE_MS = (\d+)/.exec(source)?.[1];
  assert.equal(Number(fade), 200, "waitMask.js 的 FADE_MS 必须与 CSS 的 200ms 一致");
  assert.match(css, /\.wait-mask:not\(\.ready\)\s*\{\s*opacity:\s*0/, "未 ready 时必须是 opacity:0（淡入起点）");
  assert.match(css, /\.wait-mask\.leaving\s*\{\s*opacity:\s*0/, "leaving 时必须是 opacity:0（淡出终点）");
  assert.match(css, /\.wait-mask\[hidden\]\s*\{\s*display:\s*none/, "hidden 只作兜底：JS 没跑到时不占位");
  assert.match(css, /\.wait-mask\[data-size="compact"\]\s+\.brand\s+b\s*\{[^}]*calc\(20px \* var\(--ui-text-scale\)\)/,
    "compact 档要压到侧栏那一档字号（短文案不撑满整屏）");
  assert.match(css, /\.wait-mask\[data-size="wide"\]\s+\.brand\s+b\s*\{[^}]*clamp\(|\.wait-mask\[data-size="wide"\]\s+\.brand\s+b\s*\{[^}]*min\(/,
    "wide 档必须用 clamp/min 把字号压进视口，任意长标签都不横向溢出");
  // 宽档的除数必须是「按标签估宽算出来的」，不能写死：写死 9.6 时 12 个汉字
  // （如「正在读取学生成长数据…」）在 390px 视口下要 34px × 12 = 408px，直接顶出屏幕。
  assert.match(css, /\.wait-mask\[data-size="wide"\]\s+\.brand\s+b\s*\{[^}]*var\(--wait-mask-em/,
    "wide 档字号必须除以 --wait-mask-em（估宽），写死除数会在长中文标签上横向溢出");
  assert.match(source, /host\.style\.setProperty\("--wait-mask-em", String\(estimateEm\(label\)\)\)/,
    "waitMask.js 必须在 wide 档把估宽写进 --wait-mask-em");
  assert.match(source, /host\.style\.removeProperty\("--wait-mask-em"\)/,
    "离开 wide 档要清掉 --wait-mask-em，别把旧除数留在节点上");
  // 估宽本身：汉字 1em、拉丁 .55em —— 纯汉字标签与混排标签都不能被低估
  assert.match(source, /FULLWIDTH\.test\(ch\) \? 1 : 0\.55/, "估宽规则：汉字 1em、其余 0.55em");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?\.wait-mask\s*\{\s*transition:\s*none/,
    "系统「减少动效」下必须去掉过渡");
  assert.match(css, /:root\[data-ui-motion="reduced"\]\s+\.wait-mask\s*\{\s*transition:\s*none/,
    "应用内「减少动效」设置也必须去掉过渡（铁律：应用内设置优先于系统偏好）");
  // 层级：等待蒙版要压住对话框（2400）与命令面板（1900），但让启动蒙版（2600）压住它
  const waitZ = Number(/\.wait-mask\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
  const refreshZ = Number(/\.refresh-mask\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
  assert.ok(waitZ > 2400, `等待蒙版要盖住对话框与更新历史（z-index 2400），实测 ${waitZ}`);
  assert.ok(waitZ < refreshZ, `启动蒙版必须压住等待蒙版（${refreshZ} > ${waitZ}）：启动那一次优先级最高`);
  // 侧栏那条量出来的定值不许被顺手改成变量（test-brand-wordmark 直接比对它）
  assert.match(css, /font-size:\s*calc\(20px \* var\(--ui-text-scale\)\)/,
    "侧栏 .brand b 的字号仍是量出来的定值，别改成变量");
  // 窄屏（≤900px 底栏模式）里有一条 `.brand { display: none }`，会把蒙版字标一起藏掉 ——
  // 手机上的表现是「蒙版只有一块纯色，一个字都没有」。两颗蒙版都必须自己把 display 还原回来。
  // 前提变了（那条隐藏规则没了）下面两条兜底断言可以跟着删。
  assert.match(css, /\.brand\s*\{\s*display:\s*none/,
    "前提变了：窄屏那条 `.brand { display: none }` 不见了，下面两条兜底断言可以跟着删");
  for (const sel of ["refresh-mask", "wait-mask"]) {
    const rule = new RegExp(`\\.${sel} \\.brand\\s*\\{([^}]*)\\}`).exec(css)?.[1];
    assert.ok(rule, `styles.css 缺少 .${sel} .brand 规则`);
    assert.match(rule, /display:\s*flex/,
      `.${sel} .brand 必须显式 display: flex —— 窄屏的 .brand{display:none} 会把蒙版字标一起藏掉`);
    assert.match(rule, /padding:\s*0/, `.${sel} .brand 要去掉侧栏那条 padding`);
  }
}

/* ── 16. 插件接线：重活处必须真的挂了蒙版，且插件不许自己造一套 ── */
{
  const plugins = [
    ["cppu-notify", /waitMask\(/, ["calendar.js", "growth.js", "profile.js"]],
    ["chaoxing-notify", /waitMask\(/],
    ["school-notice", /waitMask\(/],
    ["rss-reader", /waitMask\(/],
    ["gx-news", /waitMask\(/],
    ["cn-holiday", /waitMask\(/],
    ["shiguang-schedule", /waitMask\(/],
  ];
  for (const [id, needle, subs = []] of plugins) {
    const files = ["main.js", ...subs];
    const hits = files.filter((f) => {
      try { return needle.test(readProductSource(new URL(`../public/plugins/${id}/${f}`, import.meta.url), "utf8")); }
      catch { return false; }
    });
    assert.ok(hits.length > 0,
      `${id} 的刷新等待必须走宿主蒙版（找不到 tide.ui.waitMask 调用点）—— 这条守卫的作用是：`
      + `以后往这些插件里加新的网络等待时，别只画个自己的 spinner`);
  }
  // 插件不许自带一份蒙版外观：外观只有 src/styles.css 一套
  const ownCss = readProductSource(new URL("../public/plugins/cppu-notify/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(ownCss, /\.wait-mask\s*\{/, "插件不许自带 .wait-mask 样式（外观唯一事实源在 src/styles.css）");
  // 课程表插件只认 main.js，改 ui.js 之后必须重跑生成器 —— 这条守卫让「改了 ui.js 忘了生成」当场红
  const ui = readProductSource(new URL("../public/plugins/shiguang-schedule/ui.js", import.meta.url), "utf8");
  const main = readProductSource(new URL("../public/plugins/shiguang-schedule/main.js", import.meta.url), "utf8");
  assert.match(ui, /waitMask\(/, "课程表插件的蒙版调用写在事实源 ui.js 里");
  assert.match(main, /waitMask\(/, "生成物 main.js 里也必须带上：改完 ui.js 要跑 node tools/build-schedule-plugin.js");
}

console.log("PASS: 刷新等待蒙版（延迟 180ms 才起 · 最短停留 420ms · 引用计数 + 最新标签 + ×N · 幂等 release · 空壳复用/自建 · 减少动效同步摘 · withWaitMask 抛错也撤 · 兜底上限 · 插件接线 + CSS 契约）");
