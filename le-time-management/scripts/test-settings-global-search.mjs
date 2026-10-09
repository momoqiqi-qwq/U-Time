import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readProductSource(path.join(here, "..", name), "utf8");
const palette = read("src/commandPalette.js");
const shell = read("src/shell.js");
const settings = read("src/views/settings.js");
const css = read("src/styles.css");
const { SETTINGS_SEARCH_ENTRIES } = await import("../src/settingsSearchIndex.js");
const { pinyinInitialsOf } = await import("../src/pinyinInitial.js");
const { scoreSearchEntry } = await import("../src/searchMatch.js");

assert.ok(SETTINGS_SEARCH_ENTRIES.length >= 70, "设置索引必须覆盖到具体选项，不能只列十个分区");
// testing（测试分区）是 v0.172.0 收进来的：旧索引把「手机版测试」错挂在 ui 下，
// 而它其实在「测试」分区 —— 那条点下去切到「界面与交互」后找不到任何控件，是死条目。
assert.deepEqual(new Set(SETTINGS_SEARCH_ENTRIES.map((x) => x.section)),
  new Set(["tasks", "ui", "theme", "highlights", "reminders", "data", "sync", "ai", "shortcuts", "lan", "plugins", "testing", "about"]),
  "每个设置分区都必须进入全局索引");
for (const required of ["界面与交互", "界面密度", "界面缩放", "关键词标注", "日期和时间自动标红", "背景标注", "API Key", "WebDAV", "系统托盘", "插件快捷键", "检查更新"]) {
  assert.ok(SETTINGS_SEARCH_ENTRIES.some((x) => `${x.title} ${x.keywords}`.includes(required)), `全局设置索引缺少：${required}`);
}
assert.match(palette, /SETTINGS_SEARCH_ENTRIES\.map/, "命令面板必须从统一设置索引生成结果");
assert.match(palette, /scoreSearchEntry\(entry, q\)/,
  "命令面板必须与设置页左栏搜索共用同一个打分器（src/searchMatch.js），否则两边口径会飘");
assert.equal(pinyinInitialsOf("界面与交互"), "jmyjh", "全局搜索缩写 jm 必须能命中「界面」类设置项");
assert.equal(pinyinInitialsOf("应用内打开网页"), "yyndkwy", "全局搜索缩写 yy / wy 必须能命中这类中文入口");
assert.ok(scoreSearchEntry({ title: "界面与交互" }, "jmyjh") > 0, "整串缩写要能命中中文标题");
assert.ok(scoreSearchEntry({ title: "字体模式" }, "zt") > 0, "词段缩写要能命中中文标题");
assert.match(palette, /kind: "设置"/, "设置结果必须有独立类型，不能伪装成普通导航");
assert.match(palette, /detail: \{ section: item\.section, target: item\.title \}/, "点击结果必须同时传分区和具体设置项");
assert.match(shell, /openSettingsModal\(e\.detail\?\.section \|\| "", e\.detail\?\.target \|\| ""\)/,
  "外壳必须把具体设置项透传进设置弹窗");
assert.match(settings, /function revealSettingTarget\(root, target\)/, "设置页必须实现具体选项定位");
assert.match(settings, /scrollIntoView\?\.\(\{ block: "center", behavior: "smooth" \}\)/, "目标选项必须滚到可见位置");
assert.match(settings, /classList\.add\("setting-search-target"\)/, "目标选项必须有短暂的落点提示");
assert.match(css, /\.setting-search-target\s*\{/, "目标提示样式缺失");

console.log(`PASS: 全局搜索覆盖 ${SETTINGS_SEARCH_ENTRIES.length} 个设置项，并可直达具体控件`);
