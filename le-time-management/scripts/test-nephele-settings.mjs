import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSettingsNavigator } from "../src/views/settings/navigator.js";
import { normalizeUiPreferences } from "../src/uiPreferences.js";
import { usesSettingsTabs } from "../src/views/settings/layout.js";

assert.equal(normalizeUiPreferences({}).nepheleSettings, true);
assert.equal(normalizeUiPreferences({ nepheleSettings: "true" }).nepheleSettings, false);
assert.equal(normalizeUiPreferences({ nepheleSettings: true, nepheleBackground: false }).nepheleBackground, false);

class Node {
  nodeType = 1; children = []; attrs = {}; listeners = new Map(); hidden = false; value = ""; textContent = "";
  classes = new Set();
  classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)),
    toggle: (x, force) => { if (force) this.classes.add(x); else this.classes.delete(x); } };
  setAttribute(key, value) { this.attrs[key] = value; if (key === "value") this.value = value; if (key === "hidden") this.hidden = true; }
  removeAttribute(key) { delete this.attrs[key]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  closest() { return null; }
  scrollIntoView() {}
  focus() { focused = this; }
}
let focused;
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
globalThis.window = { matchMedia: () => media };
globalThis.document = { createElement: () => new Node(), createElementNS: () => new Node(),
  createTextNode: text => Object.assign(new Node(), { textContent: text }), documentElement: { dataset: { uiMotion: "reduced" } } };
globalThis.requestAnimationFrame = fn => fn();
function fixture(options = {}) {
  const state = {};
  const entries = ["ui", "theme", "data"].map(id => ({ id, label: id, node: new Node() }));
  const nav = createSettingsNavigator(entries, state, options);
  nav.apply();
  // 卡片子节点顺序（v0.170.0 起）：0 头部、1 搜索框、2 具体设置项结果、3 分类目录、4 空态。
  const search = nav.node.children[0].children[1];
  const catalog = nav.node.children[0].children[3];
  const buttons = catalog.children;
  const visible = () => nav.panels.filter(p => !p.hidden && !p.children[1].hidden);
  return { nav, state, search, catalog, buttons, visible, entries };
}
// Desktop: only active panel, retain original DOM and unfinished input while toggling.
const desktop = fixture();
desktop.entries[1].node.value = "unfinished";
desktop.nav.select("theme");
desktop.nav.setTabs(true);
assert.equal(desktop.state.active, "theme");
assert.equal(desktop.visible().length, 1);
assert.equal(desktop.entries[1].node.value, "unfinished");
desktop.buttons[1].listeners.get("keydown")({ key: "ArrowRight", preventDefault() {} });
assert.equal(desktop.state.active, "data");
assert.equal(focused, desktop.buttons[2]);
desktop.search.value = "ui"; desktop.nav.apply();
assert.equal(desktop.visible().length, 1);
assert.equal(desktop.state.active, "ui");
desktop.nav.setTabs(false);
assert.equal(desktop.search.value, "ui");
assert.equal(desktop.entries[1].node.value, "unfinished");
desktop.nav.dispose();

// 分类位置与视觉风格正交；顶部/左侧切换仍复用分类和草稿 DOM。
for (const nepheleSettings of [false, true]) {
  for (const settingsNavPosition of ["left", "top", "right"]) {
    const prefs = normalizeUiPreferences({ nepheleSettings, settingsNavPosition });
    assert.equal(usesSettingsTabs(prefs), true);
  }
}
assert.equal(usesSettingsTabs(normalizeUiPreferences({})), true);
const positionSwitch = fixture({ tabs: true });
positionSwitch.entries[1].node.value = "draft";
positionSwitch.nav.select("theme");
document.documentElement.dataset.settingsNavPosition = "left";
positionSwitch.nav.setTabs(true);
assert.equal(positionSwitch.catalog.attrs["aria-orientation"], "vertical");
positionSwitch.buttons[1].listeners.get("keydown")({ key: "ArrowDown", preventDefault() {} });
assert.equal(positionSwitch.state.active, "data");
document.documentElement.dataset.settingsNavPosition = "right";
positionSwitch.nav.setTabs(true);
assert.equal(positionSwitch.catalog.attrs["aria-orientation"], "vertical");
positionSwitch.buttons[2].listeners.get("keydown")({ key: "ArrowUp", preventDefault() {} });
assert.equal(positionSwitch.state.active, "theme");
assert.equal(positionSwitch.entries[1].node.value, "draft");
positionSwitch.search.value = "theme"; positionSwitch.nav.apply();
document.documentElement.dataset.settingsNavPosition = "top";
positionSwitch.nav.setTabs(true);
assert.equal(positionSwitch.catalog.attrs["aria-orientation"], "horizontal");
assert.equal(positionSwitch.state.active, "theme");
assert.equal(positionSwitch.search.value, "theme");
assert.equal(positionSwitch.entries[1].node.value, "draft");
assert.equal(positionSwitch.visible().length, 1);
positionSwitch.nav.dispose();
delete document.documentElement.dataset.settingsNavPosition;

// Android: opt-in replaces directory with tabs; turning it off restores detail/back flow.
media.matches = true;
const mobile = fixture({ pages: true, tabs: true });
assert.equal(mobile.visible().length, 1);
mobile.nav.select("theme");
assert.equal(mobile.nav.node.hidden, false);
assert.equal(mobile.nav.node._back(), false);
mobile.nav.setTabs(false);
assert.equal(mobile.nav.node.hidden, true);
assert.equal(mobile.visible().length, 1);
assert.equal(mobile.nav.node._back(), true);
assert.equal(mobile.visible().length, 0);
mobile.nav.dispose();
const filteredMobile = fixture({ pages: true, tabs: true });
filteredMobile.nav.select("theme");
filteredMobile.search.value = "data"; filteredMobile.nav.apply();
filteredMobile.nav.setTabs(false);
assert.equal(filteredMobile.state.page, "data", "退出标签布局时，保留搜索后的当前分类");
assert.equal(filteredMobile.visible().length, 1);
filteredMobile.nav.dispose();
// Browser narrow accordion remains available with switch off.
const narrow = fixture();
assert.equal(narrow.visible().length, 0);
narrow.nav.setTabs(true);
assert.equal(narrow.visible().length, 1);
narrow.nav.setTabs(false);
assert.equal(narrow.visible().length, 0);
narrow.nav.dispose();

/* ── 源码守卫：Nephele 风格必须是**应用级**的（v0.160.0 扩面）──────────────
 *
 * 这一段钉的是「开关从设置弹窗扩到全应用」这件事本身。只用行为测试测不出来 ——
 * 样式表读的是 CSS 源码，DOM 假对象里没有样式引擎。三条判据：
 *   ① 令牌挂在 :root 上（全应用继承），而不是 .settings-modal / .set-wrap 作用域内；
 *   ② 外壳（.rail / .main / .topbar）与各视图的表面（卡片 / 列表 / 浮层）真的被覆盖到；
 *   ③ 保留两条既有约定 —— 设置页的紫色短下划线、以及 solid 材质下关掉实时模糊的逃生口。
 * 每条都配了反向判据（见下），所以「换个标签、样式没动」这种改动会被判红。
 */
const cssRaw = readFileSync(new URL("../src/styles/nephele-settings.css", import.meta.url), "utf8");
// 先剥注释：注释里正举着「v0.158.0 的旧选择器」当反例，不剥会命中自己。
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const has = (re, msg) => assert.ok(re.test(css), msg);

// ① 令牌在 :root 上 —— 这是「全应用生效」的**唯一**机制（所有 var() 消费方靠继承拿到）。
has(/:root\[data-nephele-settings="on"\]\s*\{/, "浅色令牌要挂在 :root 上（只挂 .settings-modal 就等于只改设置页）");
has(/:root\[data-theme-mode="dark"\]\[data-nephele-settings="on"\]\s*\{/, "深色令牌同样要挂在 :root 上");
has(/\-\-panel\s*:/, "令牌块里要真的定义 --panel（表面色的单一来源）");
has(/\-\-deep\s*:/, "令牌块里要真的定义 --deep（强调色的单一来源）");
assert.ok(
  !/:root\[data-nephele-settings="on"\]\s*:is\(\s*\.settings-modal\s*,\s*\.set-wrap\s*\)/.test(css),
  "不许把令牌作用域收回 .settings-modal / .set-wrap —— 那是 v0.158.0 的写法，扩面后必须删掉",
);

// ①+ 侧栏自己的底色（v0.175.0）：侧栏此前和内容区共用同一族「面板色」，
//     两块板并排分不出谁是谁，所以另起一个更饱和的薰衣草紫。
has(/--nephele-rail:\s*#e4d7f4/, "浅色侧栏要有自己的底色令牌 --nephele-rail");
has(
  /:root\[data-theme-mode="dark"\]\[data-nephele-settings="on"\][\s\S]*?--nephele-rail:\s*#342350/,
  "深色侧栏同样要定义 --nephele-rail（漏了深色下会继承浅色那个 #e4d7f4）",
);
has(
  /background:\s*color-mix\(in srgb, var\(--nephele-rail\)\s*90%,\s*transparent\)/,
  "侧栏要真的消费 --nephele-rail —— 只在令牌块里挂个定义等于没改",
);
has(
  /background:\s*color-mix\(in srgb, var\(--nephele-rail\)\s*96%,\s*var\(--paper\)\)/,
  "solid 材质下侧栏要有自己的等价写法，别退回通用玻璃底",
);
// 反向判据：被 --nephele-rail 取代的那个通用玻璃底令牌已无消费方，
// 留着会被后来人当成活的去改它（它只挂定义、无人 var() 引用）。
assert.ok(
  !/--nephele-glass/.test(css),
  "已无消费方的 --nephele-glass 必须删干净（挂着一份死令牌比没有更容易误导）",
);

// ② 外壳与表面
for (const sel of [".rail", ".main", ".topbar"]) {
  assert.ok(
    new RegExp(`:root\\[data-nephele-settings="on"\\][^{}]*\\${sel}\\b`).test(css),
    `外壳 ${sel} 要有 Nephele 覆盖规则（否则换的只是标签）`,
  );
}
has(/backdrop-filter:\s*blur\(/, "外壳要给毛玻璃（backdrop-filter: blur）—— Nephele 的签名观感");
has(/\.topbar\s*\{[^}]*background:\s*color-mix\([^}]*transparent\)/, "顶栏要换成半透明底");
// ⚠️ 抓的是**整条规则**（选择器 + 声明块）而不是只抓声明块 —— 表面清单写在 :is(…) 的
//    选择器里，只抓 {} 之间那段会一个都不命中（第一次就写错在这，记一笔）。
const surfaceMatch = css.match(/:root\[data-nephele-settings="on"\]\s*:is\([\s\S]*?\)\s*\{[^}]*\}/);
const surface = surfaceMatch ? surfaceMatch[0] : "";
assert.ok(surface.length > 0, "要有一条覆盖全应用表面的规则（卡片 / 列表 / 浮层一起）");
for (const sel of [".card", ".tkc", ".ptask", ".mcard", ".drawer", ".cmd-palette", ".timeline"]) {
  assert.ok(surface.includes(sel), `表面清单要覆盖 ${sel}`);
}
assert.ok(
  !/backdrop-filter/.test(surface),
  "列表卡片不许各带一层 backdrop-filter：云雾是常驻动画，几十个 .tkc 逐项模糊是掉帧配方（外壳模糊一层就够）",
);

// ②+ 插件中心「去容器框」（v0.175.0）：.market 自带一圈卡片边框，嵌进 .main > .view 后
//     就成了「框套框」；Nephele 的插件页是排版直接落在窗口上的。
has(
  /:root\[data-nephele-settings="on"\]\s*\.main:has\(>\s*\.view\s*>\s*\.market\)\s*\{/,
  "插件中心去框必须用 .main:has(> .view > .market) —— 只认「当前视图正是插件中心」，别扩大到所有视图",
);
has(
  /\.main:has\(>\s*\.view\s*>\s*\.market\)\s+\.topbar\s*\{/,
  "插件页顶上那条 topbar 的板同样要撤，只撤主区会留一条框边",
);
// ⚠️ 上面两条 :has() 靠的是「.market 正好是 .view 的直接子节点」这一层结构，样式表自身
//    保证不了它，所以连 shell.js 的挂载方式一起钉住：改成 append、或中间多包一层 wrapper，
//    规则会**静默失效**（选择器不报错，只是不再命中），界面看起来就退回框套框。
const shellSrc = readFileSync(new URL("../src/shell.js", import.meta.url), "utf8");
assert.match(shellSrc, /renderMarket\(view\)/, "插件中心必须挂在 .view 上：:has(> .view > .market) 依赖这层父子关系");
assert.match(shellSrc, /container\.replaceChildren\(wrap\)/, "插件中心要保持独占 .view（replaceChildren），多包一层会让 :has() 静默失效");

// ③ 既有约定不许在扩面时被顺手改掉
has(/\.settings-nav-item\.on::after/, "设置页的紫色短下划线要保留");
has(/\[data-nav-glass="solid"\]/, "要保留 solid 材质下「关掉实时模糊」的逃生口（低端 WebView 省电）");

console.log("PASS: Nephele 设置独立开关、保留分类与草稿、搜索、键盘切换、Android 返回、窄屏目录恢复，且风格已覆盖全应用（:root 令牌 + 外壳毛玻璃 + 表面清单 + 侧栏自有底色 + 插件中心去框 + 保留逃生口）");
