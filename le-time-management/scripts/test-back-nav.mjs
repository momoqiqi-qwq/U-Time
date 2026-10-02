// 返回键历史栈的行为测试 —— 不是源码文本断言，而是把 src/backNav.js 真的跑起来。
//
// backNav.js 是纯逻辑 + 少量 DOM 查询，所以这里配一套极简的 DOM / History /
// MutationObserver 替身，逐条验证「按一下返回键，到底退到哪」。
// 替身只实现 backNav 真正用到的那点 API，不做通用 DOM。
//
// 每个场景都换一套全新的世界 + 一份全新的 backNav 模块实例（import 加 query 破缓存），
// 场景之间不共享状态，断言才好读。
//
// 覆盖的关键回归：
//   · 首页（什么都没有）按返回 = 交给系统退出应用，不留「按一下没反应」的空格子
//   · 切视图后返回 = 回上一个界面；连点同一个导航项不会多压格
//   · 浮层打开后返回 = 只关最上面那层浮层，不切视图
//   · 浮层被自己的按钮关掉后，那一格要回收，否则下次返回白按一下
//   · 命令面板 / 询问框这类非 .drawer-mask 的浮层也要能被返回键关掉

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/* ────────────────────────── 极简 DOM 替身 ────────────────────────── */

function matchesSimple(el, raw) {
  const sel = raw.trim();
  if (!sel) return false;
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  const attr = sel.match(/^\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/);
  if (attr) {
    const value = el.getAttribute(attr[1]);
    return attr[2] === undefined ? value !== null : value === attr[2];
  }
  return el.tagName === sel.toUpperCase();
}
const matchesSelector = (el, sel) => sel.split(",").some((one) => matchesSimple(el, one));

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => n && this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
}

class FakeEl {
  constructor(tag = "div", attrs = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList();
    this.children = [];
    this.parent = null;
    this.attrs = { ...attrs };
    this.textContent = text;
    this.clicks = 0;
    this._clickHandlers = [];
    if (attrs.class) this.classList.add(...String(attrs.class).split(/\s+/).filter(Boolean));
  }
  get title() { return this.attrs.title || ""; }
  get isConnected() {
    let node = this;
    while (node) {
      if (node === STATE.doc.body || node === STATE.doc.documentElement) return true;
      node = node.parent;
    }
    return false;
  }
  get nextElementSibling() {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return i < 0 ? null : this.parent.children[i + 1] || null;
  }
  append(...kids) {
    for (const kid of kids) {
      if (!kid) continue;
      kid.parent = this;
      this.children.push(kid);
      queueRecord({ addedNodes: [kid] });
    }
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
    queueRecord({ removedNodes: [this] });
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  matches(sel) { return matchesSelector(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const kid of node.children) {
        if (matchesSelector(kid, sel)) out.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return out;
  }
  addEventListener(type, handler) { if (type === "click") this._clickHandlers.push(handler); }
  click() {
    this.clicks += 1;
    for (const handler of [...this._clickHandlers]) handler({ target: this });
  }
}

/* MutationObserver：把本轮的 DOM 增删攒成一批，用微任务回调出去（与浏览器一致）。 */
let pendingRecords = [];
let flushScheduled = false;

function queueRecord(record) {
  if (!STATE.observers.length) return;
  pendingRecords.push(record);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const records = pendingRecords;
    pendingRecords = [];
    for (const observer of [...STATE.observers]) observer.callback(records);
  });
}

class FakeMutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() { STATE.observers.push(this); }
  disconnect() { STATE.observers = STATE.observers.filter((o) => o !== this); }
}

/* ────────────────────────── 极简 History 替身 ────────────────────────── */

// 与真浏览器一致：back() 只移动指针、不删条目；之后再 pushState 才会截掉前面的条目。
// 所以「栈上还剩几格能退」要看 depth（= index），不是 length。
class FakeHistory {
  constructor() { this.stack = [{ state: null }]; this.index = 0; }
  get state() { return this.stack[this.index].state; }
  get length() { return this.stack.length; }
  get depth() { return this.index; }
  get canGoBack() { return this.index > 0; }
  pushState(state) {
    this.stack.splice(this.index + 1);
    this.stack.push({ state });
    this.index = this.stack.length - 1;
  }
  replaceState(state) { this.stack[this.index] = { state }; }
  back() {
    if (this.index === 0) return;
    this.index -= 1;
    const state = this.state;
    queueMicrotask(() => { for (const fn of [...STATE.popstate]) fn({ state }); });
  }
}

/* ────────────────────────── 世界搭建 ────────────────────────── */

const STATE = { doc: null, observers: [], popstate: [] };
let worldSeq = 0;

/**
 * 换一套干净的世界。
 * `goto(id)` = 模拟用户在界面上切视图（shell.switchTo 的 commit）；
 * `applyView(id)` = 返回键触发的视图还原，单独记进 `applied`，两者不能混。
 */
async function setup({ view = "quadrant" } = {}) {
  const body = new FakeEl("body");
  const doc = {
    body,
    documentElement: new FakeEl("html"),
    querySelectorAll(sel) { return body.querySelectorAll(sel); },
  };
  const history = new FakeHistory();
  const window = {
    history,
    addEventListener: (type, fn) => { if (type === "popstate") STATE.popstate.push(fn); },
    removeEventListener: (type, fn) => {
      if (type !== "popstate") return;
      const i = STATE.popstate.indexOf(fn);
      if (i >= 0) STATE.popstate.splice(i, 1);
    },
  };
  STATE.doc = doc;
  STATE.observers = [];
  STATE.popstate = [];
  pendingRecords = [];
  flushScheduled = false;
  globalThis.document = doc;
  globalThis.window = window;
  globalThis.MutationObserver = FakeMutationObserver;

  const applied = [];
  let current = view;
  const world = {
    history,
    applied,
    body,
    get current() { return current; },
    goto(id) { current = id; },
    applyView(id) { applied.push(id); current = id; },
    /** 造一个浮层遮罩挂到 body：`onClickClose` 模拟「点遮罩即关」。 */
    openMask({ className = "drawer-mask", onClickClose = true, closers = [] } = {}) {
      const mask = new FakeEl("div", { class: className });
      const buttons = closers.map((spec) => {
        const btn = new FakeEl("button", spec.role ? { role: spec.role } : {}, spec.text || "");
        if (spec.label) btn.attrs["aria-label"] = spec.label;
        btn.addEventListener("click", () => mask.remove());
        mask.append(btn);
        return btn;
      });
      if (onClickClose) mask.addEventListener("click", () => mask.remove());
      body.append(mask);
      return { mask, buttons };
    },
  };

  worldSeq += 1;
  const mod = await import(new URL(`../src/backNav.js?world=${worldSeq}`, import.meta.url).href);
  const off = mod.initBackNav({ readView: () => world.current, applyView: (id) => world.applyView(id) });
  return { world, mod, off };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function pressBack(world) {
  world.history.back();
  await flush();
}

/* ────────────────────────── 场景 ────────────────────────── */

// 1. 首页且什么都没有：栈里只剩最初那一格 → 返回键直接交给系统退出应用。
{
  const { world, off } = await setup();
  assert.equal(world.history.depth, 0, "首屏不能多压格子");
  assert.equal(world.history.canGoBack, false,
    "首页必须不可回退：否则返回键第一下没反应、第二下才退出应用");
  off();
}

// 2. 切视图后返回 = 回上一个界面（用户原始诉求：不要直接退出软件）。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  world.goto("timeblock"); mod.noteViewChange("timeblock");
  assert.equal(world.history.depth, 2, "两次切视图压两格");

  await pressBack(world);
  assert.deepEqual(world.applied, ["inbox"], "返回键应先回到 inbox 而不是退出应用");
  assert.equal(world.current, "inbox");

  await pressBack(world);
  assert.deepEqual(world.applied, ["inbox", "quadrant"], "再退一次回到首页");
  assert.equal(world.history.canGoBack, false, "到达最初那格后才交给系统退出");
  off();
}

// 3. 连点同一个导航项：不重复压栈（否则返回键按下去看着「没反应」）。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  mod.noteViewChange("inbox");
  assert.equal(world.history.depth, 1, "同一个视图重复切换只算一格");
  await pressBack(world);
  assert.deepEqual(world.applied, ["quadrant"]);
  off();
}

// 4. 浮层打开 → 返回只关浮层，不切视图；关掉后不留空格子。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  const { mask } = world.openMask();
  await flush();
  assert.equal(world.history.depth, 1, "浮层打开要压一格浮层格，返回键才有得退");
  assert.equal(world.history.state.ltmGuard, true, "栈顶那一格要标记成浮层格");

  await pressBack(world);
  assert.equal(mask.isConnected, false, "返回键先关浮层");
  assert.deepEqual(world.applied, [], "关浮层不能顺手把视图也切了");
  assert.equal(world.history.canGoBack, false, "浮层关掉后那一格要还回去，不能留空格子");
  void mod;
  off();
}

// 5. 浮层被自己的按钮关掉 → 那一格要回收，下次返回才真的退得动。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  const { mask } = world.openMask();
  await flush();
  assert.equal(world.history.depth, 2, "有浮层时 = 视图格 + 浮层格");

  mask.remove();          // 等价于用户自己点了浮层里的「关闭 / ×」
  await flush();
  assert.equal(world.history.depth, 1, "浮层被按钮关掉后，浮层格必须回收");
  assert.deepEqual(world.applied, [], "回收历史格本身不是一次视图切换");

  await pressBack(world);
  assert.deepEqual(world.applied, ["quadrant"], "回收后下一次返回要真的回到上个界面，不能白按一下");
  off();
}

// 6. 两层浮层：返回键一层一层关，全程不切视图。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  const lower = world.openMask().mask;
  const upper = world.openMask().mask;
  await flush();
  assert.equal(world.history.depth, 2, "两层浮层也只占一格（栈顶那格代表最上面那层）");

  await pressBack(world);
  assert.equal(upper.isConnected, false, "第一次返回关最上面那层");
  assert.equal(lower.isConnected, true, "下面那层要留着");
  assert.equal(world.history.depth, 2, "还有浮层开着，就必须保证返回键还退得动");

  await pressBack(world);
  assert.equal(lower.isConnected, false, "第二次返回关剩下那层");
  assert.deepEqual(world.applied, [], "关浮层全程不应切视图");

  await pressBack(world);
  assert.deepEqual(world.applied, ["quadrant"], "浮层都关完后，返回才回上一个界面");
  off();
}

// 7. 遮罩不响应点击的询问框：要退到「取消」那条路，且不能误触「确定」。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  const { mask, buttons } = world.openMask({
    className: "drawer-mask app-dialog-mask",
    onClickClose: false,
    closers: [{ text: "取消" }, { text: "确定", role: "button" }],
  });
  await flush();
  await pressBack(world);
  assert.equal(mask.isConnected, false, "遮罩不响应点击时要走「取消按钮」那条兜底路径");
  assert.equal(buttons[0].clicks, 1, "应当点的是「取消」");
  assert.equal(buttons[1].clicks, 0, "绝不能误触「确定」");
  assert.deepEqual(world.applied, [], "关询问框不切视图");
  off();
}

// 8. 命令面板用的是自己的类名（.cmd-mask），也必须能被返回键关掉。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  const { mask } = world.openMask({ className: "cmd-mask" });
  await flush();
  assert.equal(world.history.depth, 1, "命令面板打开也要压浮层格");
  await pressBack(world);
  assert.equal(mask.isConnected, false, "命令面板必须能被返回键关掉（类名清单最容易漏）");
  assert.equal(world.history.canGoBack, false);
  void mod;
  off();
}

// 9. 屏幕上没有浮层时，无关的 DOM 变化不能凭空多压一格。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  const { mask } = world.openMask();
  await flush();
  const before = world.history.depth;
  world.body.append(new FakeEl("div", { class: "toast" }));
  world.body.append(new FakeEl("p"));
  await flush();
  assert.equal(world.history.depth, before, "普通 DOM 变化不该动历史栈（Observer 挂在 subtree 上，容易误判）");
  await pressBack(world);
  assert.equal(mask.isConnected, false);
  off();
}

// 10. 浮层开着时程序性切视图：改浮层格上的视图名，而不是额外压一格。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  const { mask } = world.openMask();
  await flush();
  const before = world.history.depth;

  world.goto("timeblock"); mod.noteViewChange("timeblock");   // 插件注册表变化导致的跳转
  assert.equal(world.history.depth, before, "浮层开着时切视图不该额外压格");
  assert.equal(world.history.state.ltmView, "timeblock", "浮层格要跟着改成新视图，否则以后退到它会跳回旧界面");

  await pressBack(world);
  assert.equal(mask.isConnected, false, "返回键仍然先关浮层");
  assert.equal(world.current, "timeblock", "关浮层不能把视图改回旧的");
  assert.deepEqual(world.applied, []);
  off();
  assert.deepEqual(STATE.popstate, [], "卸载后不应再留着 popstate 监听");
}

// 11. v0.44.1 顶栏返回按钮的数据源：canGoBack() / goBack()。
//     这两条是「按钮该不该出现」与「点了有没有用」的唯一依据，
//     而 WebView 里拿不到历史长度，只能靠 backNav 自己记的 depth —— 记错就会
//     出现「按钮常驻但点了没反应」或「明明能退却不给按钮」。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  assert.equal(mod.canGoBack(), false, "首屏必须报「没地方可回」——否则按钮点了等于退出应用");
  assert.equal(mod.goBack(), false, "没地方可回时 goBack 应返回 false 且不动历史");

  world.goto("inbox"); mod.noteViewChange("inbox");
  assert.equal(mod.canGoBack(), true, "切过一次视图后就有地方可回，按钮该出现");

  assert.equal(mod.goBack(), true, "goBack 要真的发起回退");
  await flush();
  assert.deepEqual(world.applied, ["quadrant"], "顶栏返回按钮的行为必须与 Android 返回键完全一致");
  assert.equal(mod.canGoBack(), false, "退到最初那格后按钮要自己消失");
  off();
}

// 12. 浮层也算「有地方可回」：返回按钮要先关浮层，而不是切视图。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  const { mask } = world.openMask();
  await flush();
  assert.equal(mod.canGoBack(), true, "浮层开着也算有地方可回");

  await mod.goBack();
  await flush();
  assert.equal(mask.isConnected, false, "返回按钮先关浮层");
  assert.deepEqual(world.applied, [], "关浮层不能顺手切视图");
  assert.equal(mod.canGoBack(), false, "浮层关掉后没有多余格子");
  off();
}

// 13. depth 记账必须跟着「回收空格子」一起走 —— 否则按钮会常驻。
//     浮层被自己的关闭按钮关掉时，backNav 会 history.back() 回收那一格；
//     那次 back() 的 popstate 也会进来，若不记账就会多算一格。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  const { mask } = world.openMask();
  await flush();
  assert.equal(mod.canGoBack(), true);

  mask.remove();          // 用户自己点了浮层里的「关闭」
  await flush();
  assert.equal(mod.canGoBack(), true, "还有一格视图格可退（inbox → quadrant）");

  await mod.goBack();
  await flush();
  assert.deepEqual(world.applied, ["quadrant"], "回收浮层格后，返回应直接回上一个视图");
  assert.equal(mod.canGoBack(), false, "退到底后按钮必须消失（回收那一格没记错账）");
  off();
}

/* ────────────────────────── 静态接线断言（v0.44.1） ──────────────────────────
   上面测的是 backNav 的行为；这一段测「按钮有没有正确接到它上面」。
   这几条都不会在行为测试里自然暴露（要真跑 shell + 真 DOM 才看得见），但少一条用户就明显感到不对：
   ① 按钮必须走 backNav 的 goBack()，不能自己写 history.back() 或自己维护一份「上一个视图」——
      浮层优先级、程序性重渲染不压栈这些规则都在 onPopState 里，两条路迟早不一致。
   ② 顶栏只该挂一次 syncBackButton，且必须排在 noteViewChange **之后**：
      commit 早于 noteViewChange 跑，而压栈发生在 noteViewChange 里 ⇒ 放前面会慢一拍
      （表现：刚进插件时按钮不出现，要再切一次才冒出来）。
   ③ `.topbar-back` 默认必须 display:none，只在 ≤900px 的媒体块里才允许显示。
      桌面端有侧栏直达全部视图，顶栏不该多出东西 —— 这个媒体块断点必须与
      `.plug-list{display:none}` 一致：正是它把插件直达入口收走，按钮才有存在意义。 */
{
  const fs = await import("node:fs");
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  const shell = read("../src/shell.js");
  const css = read("../src/styles.css");

  assert.match(shell, /import \{[^}]*\bcanGoBack\b[^}]*\bgoBack\b[^}]*\} from "\.\/backNav\.js"/,
    "shell 必须从 backNav 引入 canGoBack / goBack，别自己造一套回退");
  assert.match(shell, /class: "topbar-back"/, "顶栏必须有 .topbar-back 按钮");
  assert.match(shell, /"aria-label": "返回"/, "返回按钮要有 aria-label（图标是纯符号，读屏得靠它）");
  assert.match(shell, /onclick: \(\) => goBack\(\)/,
    "返回按钮必须直接调 backNav 的 goBack()，保证与 Android 返回键同一条路");
  assert.doesNotMatch(shell, /class: "topbar-back"[\s\S]{0,200}?history\.back\(\)/,
    "返回按钮不能自己写 history.back() —— 那样会绕过浮层优先的规则");
  // v0.52.0：syncBackButton 抽出了 show 变量（悬浮键 .mobile-back 与顶栏键共用），
  // 断言跟着改成「同一份 canGoBack() 结果喂给两颗按钮」——不变量本身没变：
  // 没地方可回时不显示，否则点了等于退出应用。
  assert.match(shell, /const show = canGoBack\(\);/,
    "按钮显隐必须由 canGoBack() 决定：没地方可回时不显示，否则点了等于退出应用");
  assert.match(shell, /backBtn\.classList\.toggle\("show", show\);/,
    "顶栏返回键的显隐跟随 canGoBack() 的结果");
  assert.match(shell, /mobileBack\.classList\.toggle\("show", show\);/,
    "悬浮返回键与顶栏返回键共用同一份 canGoBack() 状态，不能各算各的");
  // 挂点：必须在标题卡内、且排在小框前面（`[‹][图标] 标题`）
  assert.match(shell, /class: "topbar-title-card"[\s\S]{0,400}?\bbackBtn,\s*\n\s*titleMark,/,
    "backBtn 必须在标题卡里、排在 titleMark 之前");
  // 调用顺序：syncBackButton 必须在 noteViewChange 之后
  assert.match(shell, /if \(opts\.history !== false\) noteViewChange\(targetId\);[\s\S]{0,200}?syncBackButton\(\);/,
    "syncBackButton 必须排在 noteViewChange 之后 —— 压栈在 noteViewChange 里，放前面按钮会慢一拍");
  assert.match(shell, /window\.addEventListener\("popstate", syncBackButton\)/,
    "关浮层这类回退不走 commit，要单独补一个 popstate 监听刷新按钮");
  // 用「下标先后」判断，不用「字符距离窗口」——
  // 后者被无关新增代码撑破过一次（2026-09-17：插件快捷键的 attachPluginShortcutKeys
  // 插在两者中间，语义完全没变，断言却红了）。
  {
    const initAt = shell.indexOf("initBackNav({");
    const popAt = shell.indexOf('window.addEventListener("popstate", syncBackButton)');
    assert.ok(initAt > -1 && popAt > -1, "shell.js 必须同时有 initBackNav 调用与 popstate 监听");
    assert.ok(initAt < popAt,
      "popstate 监听必须注册在 initBackNav 之后：backNav 的 onPopState 先跑完，depth 才是新值");
  }

  // CSS：默认不显示 + 只在 ≤900px 显示 + 触控区 ≥40px
  // （断点用 px：曾改成 em 试图跟随界面缩放，实测 em 媒体查询不认 zoom，已回退）
  assert.match(css, /\.topbar-back\s*\{\s*display:\s*none/, "基础态必须 display:none（桌面端不显示）");
  const mobile900 = css.match(/@media \(max-width: 900px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(mobile900, "必须存在 ≤900px 媒体块");
  assert.match(mobile900, /\.plug-list\s*\{\s*display:\s*none/,
    "插件直达入口必须收在 ≤900px 里 —— 正是它被收走，返回按钮才有存在意义（两者要同进退）");
  assert.match(mobile900, /\.topbar-back\.show\s*\{[^}]*display:\s*inline-flex/,
    "返回按钮只允许在 ≤900px 媒体块里显示");
  assert.match(mobile900, /\.topbar-back\.show\s*\{[^}]*width:\s*(\d+)px[^}]*height:\s*(\d+)px/,
    "返回按钮要有明确的触控区尺寸");
  {
    const size = mobile900.match(/\.topbar-back\.show\s*\{[^}]*width:\s*(\d+)px[^}]*height:\s*(\d+)px/);
    const w = Number(size?.[1]), h = Number(size?.[2]);
    assert.ok(w >= 40 && h >= 40,
      `返回按钮触控区必须 ≥40×40px（实测 ${w}×${h}）—— 手机上小于这个尺寸点不准`);
  }
  assert.ok(!/^\.topbar-back\.show\s*\{/m.test(css),
    ".topbar-back.show 的显示规则不能写在基础态：桌面端顶栏不该多出按钮");

  // v0.52.0：内容区左右滑动 = 返回上一页（用户要求删掉「滑动翻页切界面」）。
  // 手势段必须走 backNav 的 goBack()（与返回键同一条路），不得再按 allViewIds 顺序翻页。
  {
    const swipeAt = shell.indexOf("内容区左右滑动 = 返回上一页");
    assert.ok(swipeAt > -1, "滑动段注释锚存在（v0.52.0 改语义后的标记）");
    const swipeBlock = shell.slice(swipeAt).match(/addEventListener\("touchend"[\s\S]*?\}, \{ passive: true \}\);/)?.[0] ?? "";
    assert.ok(swipeBlock, "滑动段必须有 touchend 监听");
    assert.match(swipeBlock, /\bgoBack\(\)/,
      "左右滑动必须调 backNav 的 goBack()：先关浮层再回上一视图，与返回键同一条路");
    assert.doesNotMatch(swipeBlock, /allViewIds|switchTo\(/,
      "滑动不得再翻页切视图 —— 用户明确要求删除「滑动切换应用界面」");
    assert.match(swipeBlock, /getUiPreferences\(\)\.swipeNavigation/,
      "滑动返回要受设置里既有的滑动开关控制（键名不回退，语义改为返回）");
    assert.match(swipeBlock, /Math\.abs\(dx\) < 56/,
      "横滑阈值守卫保留：足够长且横向主导才触发，别误伤纵向滚动");
    assert.match(swipeBlock, /document\.body\.dataset\.swipeSuspended === "1"/,
      "touchend 必须检查 swipeSuspended：拖拽排序等手势会话期间滑动返回让路（v0.52.0 配套）");
  }

  // v0.110.0：边缘起滑新增手势，锁住「左缘 28px 起滑 + 右拉才回」与中部兼容。
  {
    const edgeAt = shell.indexOf("const EDGE_SWIPE_PX = 28;");
    assert.ok(edgeAt > -1, "边缘返回热区必须固定为视觉像素 28px");
    const edgeBlock = shell.slice(shell.lastIndexOf("// v0.110.0：左缘返回带", edgeAt), shell.indexOf("mountQuickDock();", edgeAt));
    assert.match(edgeBlock, /swEdge = e\.touches\[0\]\.clientX <= EDGE_SWIPE_PX/,
      "边缘带必须由 touchstart 的屏幕 clientX 判定");
    assert.match(edgeBlock, /if \(!swEdge && e\.target\.closest\?\.\(SWIPE_SKIP\)\) return/,
      "边缘起滑必须优先于 SWIPE_SKIP，让插件页/输入区仍可边缘返回");
    assert.match(edgeBlock, /if \(swEdge\) \{ if \(dx > 0\) goBack\(\); return; \}/,
      "边缘带只认左向右拉；左向右不反、也不落入中部双向返回");
    assert.ok(edgeBlock.indexOf("Math.abs(dx) < 56") < edgeBlock.indexOf("if (swEdge)"),
      "边缘分支必须仍受 56px 长度与横纵比例门槛保护");
  }
}

// 14. 同一个模块实例重新挂载（热重载 / 宿主重建）：depth 必须归零。
//     否则上一轮的记账会留下来，按钮常驻但点了没反应（历史栈其实已经空了）。
{
  const { world, mod, off } = await setup({ view: "quadrant" });
  world.goto("inbox"); mod.noteViewChange("inbox");
  assert.equal(mod.canGoBack(), true, "前置：先攒出一格");
  off();

  const off2 = mod.initBackNav({ readView: () => world.current, applyView: (id) => world.applyView(id) });
  assert.equal(mod.canGoBack(), false,
    "重新挂载后 depth 必须归零 —— 留着上一轮的记账会让返回按钮常驻却点了没反应");
  off2();
}

console.log("PASS: 返回键历史栈（视图回退 / 浮层优先 / 空格子回收 / 各类遮罩类名）"
  + " + 顶栏返回按钮的数据源与接线（canGoBack / goBack / 断点 / 调用顺序）"
  + " + 内容区左右滑动 = 返回上一页（v0.52.0，翻页手势已删）");

// APK 子页面：上层弹窗先关闭，然后回目录，最后关闭设置；不残留历史格。
{
  const { world, off } = await setup();
  const { mask } = world.openMask();
  const panel = new FakeEl("section");
  let page = "data";
  panel._back = () => { if (!page) return false; page = ""; return true; };
  world.body.append(panel);
  const upper = world.openMask().mask;
  await flush();
  await pressBack(world);
  assert.equal(upper.isConnected, false);
  assert.equal(page, "data", "确认框应优先于设置子页面关闭");
  await pressBack(world);
  assert.equal(page, "", "Android 返回应先回设置目录");
  assert.equal(mask.isConnected, true);
  assert.equal(world.history.depth, 1, "目录仍可返回关闭设置");
  await pressBack(world);
  assert.equal(mask.isConnected, false);
  assert.equal(world.history.canGoBack, false);
  off();
}
