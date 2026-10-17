/**
 * 设置分类图标：线性图标集 + 「图标到底会不会被样式藏起来」的守卫。
 *
 * 这组断言存在的理由：图标曾经**在代码里是对的、在界面上却没有** ——
 * nephel-settings.css 把 .settings-nav-ico 跟小字/箭头一起 display:none 了，
 * 于是默认皮肤（Nephele）下分类栏只剩文字，读代码完全看不出来。
 * 所以下面除了画法本身，还钉住「没有任何样式再把分类图标藏起来」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SETTINGS_NAV_ICONS, createSettingsNavIcon, hasSettingsNavIcon, settingsNavIconNames,
} from "../src/settingsNavIcons.js";

/* ── 1. 画法：每个图标都得是能画出来的基础图元 ───────────────────────── */
const SHAPE_ATTRS = { path: ["d"], circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"], rect: ["x", "y", "width", "height"] };
assert.ok(settingsNavIconNames().length >= 15, `图标集至少覆盖 15 个分类，现在只有 ${settingsNavIconNames().length} 个`);
for (const name of settingsNavIconNames()) {
  const shapes = SETTINGS_NAV_ICONS[name];
  assert.ok(Array.isArray(shapes) && shapes.length > 0, `${name} 至少要有 1 个形状`);
  for (const [tag, attrs] of shapes) {
    assert.ok(SHAPE_ATTRS[tag], `${name} 用了不支持的图元 ${tag}（只允许 ${Object.keys(SHAPE_ATTRS).join(" / ")}）`);
    for (const key of SHAPE_ATTRS[tag]) {
      assert.ok(attrs[key] !== undefined, `${name} 的 <${tag}> 缺属性 ${key}`);
    }
    // 坐标一律按 24 网格写；超出会被 viewBox 裁掉，界面上表现为「图标缺一角」。
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "d") continue;
      const n = Number(value);
      assert.ok(Number.isFinite(n) && n >= 0 && n <= 24, `${name} 的 <${tag}> 属性 ${key}=${value} 落在 24×24 网格外`);
    }
  }
}

/* ── 2. 覆盖：settingEntries 里出现的每个 icon 都要有对应画法 ──────────── */
const settingsSrc = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
const block = settingsSrc.slice(settingsSrc.indexOf("const settingEntries = ["), settingsSrc.indexOf("entries = settingEntries"));
assert.ok(block.length > 500, "没能从 src/views/settings.js 里切出 settingEntries 块（结构变了要同步这个测试）");
const usedIcons = [...block.matchAll(/icon:\s*"([^"]+)"/g)].map(m => m[1]);
assert.equal(usedIcons.length, 16, `settingEntries 应该是 16 条，抓到 ${usedIcons.length} 条`);
for (const icon of usedIcons) {
  assert.ok(hasSettingsNavIcon(icon), `分类用到的图标 "${icon}" 不在 settingsNavIcons.js 里，界面会落到 gear 兜底`);
}
// 每个分类一个专属图标：两个分类共用同一个字形时，分类栏就分不出谁是谁。
const dupes = usedIcons.filter((icon, i) => usedIcons.indexOf(icon) !== i);
assert.deepEqual(dupes, [], `分类之间不许共用图标，重复的有：${dupes.join(" / ")}`);

/* ── 3. 造节点：描边属性统一注入，未知名字落 gear ──────────────────────── */
class El {
  children = []; tag = ""; attrs = {};
  constructor(tag) { this.tag = tag; }
  setAttribute(key, value) { this.attrs[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
}
const fakeDoc = { createElementNS: (_ns, tag) => new El(tag) };
const svg = createSettingsNavIcon("bell", fakeDoc);
assert.equal(svg.tag, "svg");
assert.equal(svg.attrs.viewBox, "0 0 24 24");
assert.equal(svg.attrs.stroke, "currentColor", "描边色必须走 currentColor，否则选中态不会跟着文字色变");
assert.equal(svg.attrs.fill, "none", "线性图标要 fill:none，否则形状会被实心填满");
assert.ok(Number(svg.attrs["stroke-width"]) > 0 && Number(svg.attrs["stroke-width"]) <= 2, "描边粗细要在细线区间（<=2）");
assert.ok(svg.children.length > 0, "svg 里要真的有形状");
assert.equal(createSettingsNavIcon("no-such-icon", fakeDoc).children.length, SETTINGS_NAV_ICONS.gear.length, "未知名字要落 gear 兜底");
// svg 类名与 CSS 挂钩；改了这里要同步 styles.css 的 .settings-nav-glyph 规则。
assert.equal(svg.attrs.class, "settings-nav-glyph");
for (const css of ["../src/styles.css", "../src/styles/feature-layouts.css"]) {
  const raw = readFileSync(new URL(css, import.meta.url), "utf8");
  assert.match(raw, /\.settings-nav-glyph\s*\{[^}]*width/, `${css} 要给 .settings-nav-glyph 定尺寸`);
}

/* ── 4. 回归守卫：不许再有任何样式把分类图标藏起来 ─────────────────────── */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const nephel = stripComments(readFileSync(new URL("../src/styles/nephele-settings.css", import.meta.url), "utf8"));
for (const rule of nephel.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const [, selector, body] = rule;
  const hides = /display:\s*none/.test(body);
  if (hides && selector.includes(".settings-nav-ico")) {
    assert.fail(`Nephele 又出现隐藏分类图标的规则：${selector.trim()} —— 这正是 v0.193.0 修掉的「分类栏只剩文字」`);
  }
}
// Nephele 下不能沿用默认皮肤的 30px 实心底板块（它是给 13px 实体字形配的）。
assert.match(
  nephel,
  /:root\[data-nephele-settings="on"\]\s*\.settings-nav-ico\s*\{[^}]*background:\s*none/,
  "Nephele 下分类图标要收掉底板块（background: none），否则细描边图标会缩在一个色块里",
);

// 窄屏左右侧栏：小字 / 结果数 / 箭头确实放不下，但图标必须留。
const layout = stripComments(readFileSync(new URL("../src/styles/settings-layout.css", import.meta.url), "utf8"));
const narrowBlock = layout.slice(layout.indexOf("@media (max-width: 760px)"));
const hideRule = narrowBlock.match(/[^{}]*\{[^}]*display:\s*none[^}]*\}/);
assert.ok(hideRule, "窄屏 760px 断点里应仍有「放不下就隐藏」的规则");
assert.ok(!hideRule[0].includes(".settings-nav-ico"), "窄屏竖排分类栏要保留图标（图标 + 换行文字才分得清分类）");
assert.ok(hideRule[0].includes(".settings-result"), "窄屏仍要隐藏「显示 N / N」结果数");

// navigator.js 必须真的在用线性图标集，而不是退回 FA 精灵图。
const navSrc = readFileSync(new URL("../src/views/settings/navigator.js", import.meta.url), "utf8");
assert.match(navSrc, /import \{ createSettingsNavIcon \} from "\.\.\/\.\.\/settingsNavIcons\.js"/, "导航栏要从 settingsNavIcons.js 取图标");
assert.ok(!/fontawesome\/solid\.svg/.test(navSrc), "导航栏不该再引用 FA solid 精灵图（实体字形与线性图标混用会一格一个样）");
assert.equal(
  [...navSrc.matchAll(/createSettingsNavIcon\(/g)].length, 2,
  "分类图标有两处消费点：分类按钮 .settings-nav-ico 与窄屏手风琴头 .settings-acc-ico",
);

console.log("PASS: 设置分类图标为自绘线性图标（16 个分类各一，未知名字落 gear 兜底），且 Nephele / 窄屏竖排下都不再被样式隐藏");
