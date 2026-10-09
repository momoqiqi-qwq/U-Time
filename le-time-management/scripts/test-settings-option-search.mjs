/* v0.170.0 · 设置页左栏搜索要能「直达具体设置项」。
 *
 * 原来左栏搜索只筛分类：输入「字」剩下 4 个分类，点进去还得自己在长分区里翻。
 * 现在同一处搜索同时列出命中的**具体设置项**，点一行就落到那个控件上。
 *
 * 两条腿都要有，缺一条就不算数：
 *   ① 假 DOM 行为 —— 结果确实渲染出来了、点下去确实带着 (分区, 选项名) 交给外壳；
 *   ② 源码守卫 —— 索引只有一个事实源、定位范围收在目标分区内、窄屏别把结果一起藏掉。
 * ② 里的每一条都配了反面判据，所以「改个类名、样式没动」这类改动会被判红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSettingsNavigator } from "../src/views/settings/navigator.js";
import { SETTINGS_SEARCH_ENTRIES } from "../src/settingsSearchIndex.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const navigatorSrc = read("../src/views/settings/navigator.js");
const settingsSrc = read("../src/views/settings.js");
const css = read("../src/styles.css");

/* ── 假 DOM ─────────────────────────────────────────────────────────────── */
class Node {
  nodeType = 1; children = []; attrs = {}; listeners = new Map(); hidden = false; value = ""; textContent = "";
  classes = new Set();
  classList = {
    add: (...xs) => xs.forEach((x) => this.classes.add(x)),
    toggle: (x, force) => { if (force) this.classes.add(x); else this.classes.delete(x); },
  };
  setAttribute(key, value) { this.attrs[key] = value; if (key === "value") this.value = value; if (key === "hidden") this.hidden = true; }
  removeAttribute(key) { delete this.attrs[key]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  closest() { return null; }
  scrollIntoView() {}
  focus() {}
}
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
globalThis.window = { matchMedia: () => media };
globalThis.document = {
  createElement: () => new Node(),
  createElementNS: () => new Node(),
  createTextNode: (text) => Object.assign(new Node(), { textContent: text }),
  documentElement: { dataset: { uiMotion: "reduced" } },
};
globalThis.requestAnimationFrame = (fn) => fn();

// 假 DOM 不会把子文本汇总到 textContent，这里自己拼（el() 把字符串子节点变成 TextNode）。
const textOf = (node) => (node.children?.length ? node.children.map(textOf).join("") : node.textContent || "");

function fixture() {
  const picked = [];
  const entries = [
    { id: "ui", label: "界面与交互", node: new Node() },
    { id: "theme", label: "主题", node: new Node() },
    { id: "cppu-login", label: "警大登录设置", node: new Node() },
  ];
  const nav = createSettingsNavigator(entries, {}, { onPickOption: (section, title) => picked.push([section, title]) });
  nav.apply();
  const card = nav.node.children[0];
  const search = card.children[1];
  const results = card.children[2];
  const catalog = card.children[3];
  const rows = () => results.children.slice(1);
  return { nav, picked, search, results, catalog, rows };
}

// 卡片子节点顺序：0 头部、1 搜索框、2 具体设置项结果、3 分类目录、4 空态。
const f = fixture();
assert.equal(f.catalog.className, "settings-catalog", "分类目录不能被顶到别的位置");
assert.equal(f.results.hidden, true, "没输入时结果区必须收起");

f.search.value = "文字大小"; f.nav.apply();
assert.equal(f.results.hidden, false, "命中设置项时结果区要展开");
assert.equal(f.rows().length, 1, "「文字大小」应恰好命中一条");
assert.equal(textOf(f.rows()[0].children[0]), "文字大小", "结果行要显示设置项名字");
assert.equal(textOf(f.rows()[0].children[1]), "界面与交互", "结果行要显示它属于哪个分区");
f.rows()[0].listeners.get("click")();
assert.deepEqual(f.picked, [["ui", "文字大小"]], "点击结果必须把「分区 + 具体选项」一起交给外壳");

// 拼音首字母与全局搜索同口径：wzdx → 文字大小。
f.search.value = "wzdx"; f.nav.apply();
assert.ok(f.rows().some((row) => textOf(row.children[0]) === "文字大小"), "拼音缩写要能命中中文设置项");

// 索引里没收的分区（警大登录设置 / 测试）用分区名兜底，否则那两个分区的设置项永远搜不到。
f.search.value = "警大"; f.nav.apply();
assert.equal(f.rows().length, 1, "未收录分区要按分区名兜底出一条");
f.rows()[0].listeners.get("click")();
assert.deepEqual(f.picked.at(-1), ["cppu-login", "警大登录设置"]);

f.search.value = "没有这个设置项"; f.nav.apply();
assert.equal(f.results.hidden, true, "零命中要收起结果区，别留一个空框");
assert.equal(f.rows().length, 0);
f.search.value = ""; f.nav.apply();
assert.equal(f.results.hidden, true, "清空搜索词后结果区必须收回去");
f.nav.dispose();

/* ── 源码守卫 ───────────────────────────────────────────────────────────── */
const has = (re, msg, src = navigatorSrc) => assert.ok(re.test(src), msg);

has(/import \{ SETTINGS_SEARCH_ENTRIES \} from "\.\.\/\.\.\/settingsSearchIndex\.js"/,
  "左栏搜索必须复用全局搜索那份索引，不许另抄一份设置项清单");
has(/class: "settings-search-results"/, "结果区要有稳定的类名，样式与测试都挂它");
has(/class: "settings-option-result"/, "结果行要有稳定的类名");
has(/onPickOption = null/, "onPickOption 要有默认值，未接外壳时不能炸");
has(/function paintOptions\(q\)/, "结果区要有独立的重画函数");
has(/results\.hidden = matches\.length === 0/, "paintOptions 要按命中数收放结果区");
has(/paintOptions\(q\)/, "搜索主流程（apply）必须真的重画结果");

assert.match(settingsSrc, /onPickOption: pickSettingOption/,
  "设置视图必须把「点到具体选项」接到 navigator 上，否则点了没反应");
assert.match(settingsSrc, /revealSettingTarget\(entry\?\.node \|\| content, target\)/,
  "定位必须收在目标分区自己的节点里 —— 用整页找会被别的分区里先出现的同文控件抢走匹配，而它是隐藏的，表现就是「点了没反应」");

has(/\.settings-search-results\s*\{[\s\S]{0,400}\}/, "结果区样式缺失", css);
has(/\.settings-search-results\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/,
  "结果区必须显式处理 [hidden] —— 作者样式 display:flex 会盖掉 UA 的 [hidden]", css);
has(/\.settings-option-result\.on/, "结果行要有键盘/鼠标高亮态", css);

// 窄屏（≤980px）分类列表被收掉走手风琴，这时结果区是搜索**唯一**的出口，不能被一起藏掉。
const mediaBlocks = (query) => {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`@media ${query}`, from);
    if (at < 0) break;
    const open = css.indexOf("{", at);
    let depth = 0, i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i + 1;
  }
  return out;
};
const narrowBlocks = mediaBlocks("(max-width: 980px)");
assert.ok(narrowBlocks.some((block) => /\.settings-catalog\s*\{\s*display:\s*none/.test(block)),
  "窄屏应该收掉分类列表（改这里说明布局假设变了，先复核本测试）");
assert.ok(!narrowBlocks.some((block) => /\.settings-search-results[^{]*\{[^}]*display:\s*none/.test(block)),
  "窄屏不许把「具体设置项」结果一起藏掉 —— 那时分类列表是隐藏的，藏了搜索就只剩计数");

assert.ok(SETTINGS_SEARCH_ENTRIES.length >= 70, "索引本身要覆盖到具体选项，不能只列十个分区");

console.log("PASS: 设置左栏搜索能列出命中的具体设置项，点击带「分区 + 选项」直达对应控件，且窄屏不会丢掉这个出口");
