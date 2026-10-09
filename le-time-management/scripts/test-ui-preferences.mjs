import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_UI_PREFERENCES, TEXT_SCALE_LIMITS, normalizeUiPreferences } from "../src/uiPreferences.js";

assert.deepEqual(normalizeUiPreferences({}), DEFAULT_UI_PREFERENCES);
assert.equal(normalizeUiPreferences({}).fontMode, "nephele");
assert.equal(normalizeUiPreferences({ fontMode: "system", nepheleSettings: true }).fontMode, "system");
assert.equal(normalizeUiPreferences({ fontMode: "nephele", nepheleSettings: false }).fontMode, "nephele");
for (const fontMode of [null, "unknown", true]) {
  assert.equal(normalizeUiPreferences({ fontMode }).fontMode, "nephele");
}
assert.equal(normalizeUiPreferences({}).settingsNavPosition, "auto");
for (const position of ["top", "left", "right"]) {
  assert.equal(normalizeUiPreferences({ settingsNavPosition: position }).settingsNavPosition, position);
}
for (const position of [null, "bottom", true]) {
  assert.equal(normalizeUiPreferences({ settingsNavPosition: position }).settingsNavPosition, "auto");
}
for (const [raw, width, transparency] of [
  [{ navWidth: 20, navTransparency: -1 }, 60, 0],
  [{ navWidth: 180, navTransparency: 200 }, 100, 100],
  [{ navWidth: "83", navTransparency: "42" }, 83, 42],
  [{ navWidth: null, navTransparency: "bad" }, 100, 0],
]) {
  const prefs = normalizeUiPreferences(raw);
  assert.equal(prefs.navWidth, width);
  assert.equal(prefs.navTransparency, transparency);
}
assert.equal(normalizeUiPreferences({ density: "weird" }).density, "compact");
assert.equal(normalizeUiPreferences({ motion: "none" }).motion, "system");
assert.equal(normalizeUiPreferences({ startupView: "settings" }).startupView, "last");
// v0.55.0 起区间 80~150（TEXT_SCALE_LIMITS 单一事实源），步进仍 5
assert.equal(normalizeUiPreferences({ textScale: 117 }).textScale, 115);
assert.equal(normalizeUiPreferences({ textScale: 999 }).textScale, TEXT_SCALE_LIMITS.max);
assert.equal(normalizeUiPreferences({ textScale: 1 }).textScale, TEXT_SCALE_LIMITS.min);
assert.equal(normalizeUiPreferences({ textScale: 80 }).textScale, 80);
assert.equal(normalizeUiPreferences({ textScale: 150 }).textScale, 150);
assert.equal(normalizeUiPreferences({ textScale: 78 }).textScale, 80);   // 下边界外夹回
assert.equal(normalizeUiPreferences({ textScale: 152 }).textScale, 150); // 上边界外夹回
assert.equal(normalizeUiPreferences({ textScale: 84 }).textScale, 85);   // 步进对齐
assert.equal(normalizeUiPreferences({ textScale: "110" }).textScale, 110);
assert.equal(normalizeUiPreferences({ swipeNavigation: false }).swipeNavigation, false);
assert.equal(normalizeUiPreferences({ showTopStats: false }).showTopStats, false);
// v0.57.0：centerTopStats 默认翻转为 true，归一化改「!==false」（只有显式 false 才算关）
assert.equal(normalizeUiPreferences({}).centerTopStats, true);                          // 缺省 = 居中（新默认）
assert.equal(normalizeUiPreferences({ centerTopStats: true }).centerTopStats, true);
assert.equal(normalizeUiPreferences({ centerTopStats: false }).centerTopStats, false);  // 显式关过的用户保持关闭
assert.equal(normalizeUiPreferences({ centerTopStats: "true" }).centerTopStats, true);
assert.equal(normalizeUiPreferences({ showViewSubtitle: false }).showViewSubtitle, false);
assert.equal(normalizeUiPreferences({}).showSettingsDescriptions, true);
assert.equal(normalizeUiPreferences({ showSettingsDescriptions: false }).showSettingsDescriptions, false);
assert.equal(normalizeUiPreferences({}).showPluginDescriptions, false);
assert.equal(normalizeUiPreferences({ showPluginDescriptions: true }).showPluginDescriptions, true);
assert.equal(normalizeUiPreferences({ showPluginDescriptions: "true" }).showPluginDescriptions, false);
// 「显示介绍」只吃设置页那份列表会漏掉插件中心：两处描述必须共用同一条 off 规则。
// 插件中心在 .view 里、不在 .settings-section 下，所以它的选择器不能带那层前缀。
const pluginDescRule = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
  .match(/:root\[data-plugin-descriptions="off"\][^{]*\{[^}]*\}/)?.[0] || "";
for (const selector of [".settings-section .plug-card .pd", ".market-card-desc"]) {
  assert.ok(pluginDescRule.includes(selector), `插件介绍 off 规则缺少 ${selector}`);
}
assert.match(pluginDescRule, /display:\s*none\s*!important/);
// 通知堆叠：默认开，只有显式 false 才回到逐条竖排（与 centerTopStats 同一套 !==false 约定，
// 老存档里没有这个键 ⇒ 落到新默认，不会被误判成「用户关过」）
assert.equal(normalizeUiPreferences({}).notifyStack, true);
assert.equal(normalizeUiPreferences({ notifyStack: false }).notifyStack, false);
assert.equal(normalizeUiPreferences({ notifyStack: "off" }).notifyStack, true);
// 底栏高度档位：非法值回标准档，三档合法值原样保留（CSS 变量消费，见 styles.css :root[data-navbar]）
assert.equal(normalizeUiPreferences({ navBarSize: "weird" }).navBarSize, "standard");
for (const id of ["compact", "standard", "relaxed"]) {
  assert.equal(normalizeUiPreferences({ navBarSize: id }).navBarSize, id);
}

console.log("PASS: UI preference normalization and compatibility defaults");
