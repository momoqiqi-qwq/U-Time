/* v0.172.0 · 设置搜索的拼音缩写 + 「点了就跳到那个控件」。
 *
 * 两条腿都要有，缺一条就不算数：
 *   ① 打分器（src/searchMatch.js）—— 按**词段**匹配拼音首字母，不再把
 *      title+keywords 拼成一整串再 includes。配了反面判据：zt 不许再命中
 *      「顶部任务统计居中」（dbrwtjjz 里恰好有 zt）、「界面缩放」（整体缩放 → ztsf）。
 *   ② 索引里的每条都要能在**它所属那个分区**里找到锚点 —— 找不到就是死条目：
 *      搜得到、点下去什么也不发生（旧索引的「手机版测试」挂在 ui 下，而它其实在
 *      「测试」分区，ui 分区里没有这几个字）。这里核结构不变量，
 *      DOM 级的逐条点击核验走 .workbuddy-ai/tmp/probe-settings-abbrev.cjs（真浏览器）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS_SEARCH_ENTRIES, SETTINGS_SECTION_LABELS } from "../src/settingsSearchIndex.js";
import { abbreviationSegments, matchesSearchEntry, scoreSearchEntry, searchSegments } from "../src/searchMatch.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const navigatorSrc = read("../src/views/settings/navigator.js");
const settingsSrc = read("../src/views/settings.js");
const paletteSrc = read("../src/commandPalette.js");
const matchSrc = read("../src/searchMatch.js");

/* ── ① 打分器 ───────────────────────────────────────────────────────────── */
const ranked = (q) => SETTINGS_SEARCH_ENTRIES
  .map((item) => ({ item, score: scoreSearchEntry(item, q) }))
  .filter((hit) => hit.score >= 0)
  .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "zh-CN"))
  .map((hit) => hit.item.title);

// 词段：括号、斜杠都要当边界，否则「通知叠成一张（鼠标悬停展开）」会粘成一串。
assert.deepEqual(abbreviationSegments("字体 字号"), ["zt", "zh"], "关键词里的每个词都要单独出一个缩写");
assert.deepEqual(abbreviationSegments("通知叠成一张（鼠标悬停展开）"), ["tzdcyz", "sbxtzk"], "括号要当词段边界");
assert.deepEqual(searchSegments("表格 / 日历交换"), ["表格", "日历交换"], "斜杠要当词段边界");
assert.deepEqual(abbreviationSegments("表格 / 日历交换"), ["bg", "rljh"], "词段各自出缩写，不跨段拼接");

// 用户举的例子：zt → 字体。
const zt = ranked("zt");
assert.ok(zt.includes("字体模式"), `「zt」必须能搜出「字体模式」，实际：${JSON.stringify(zt)}`);
assert.ok(zt.includes("文字大小"), "「zt」必须能搜出「文字大小」（关键词里写着「字体」）");
assert.ok(zt.indexOf("字体模式") <= 2, `「字体模式」要排在前三，实际第 ${zt.indexOf("字体模式") + 1} 位`);
// 反面判据：整串 includes 时代的三条假阳性，一条都不许回来。
for (const noise of ["顶部任务统计居中", "界面缩放", "界面主题"]) {
  assert.ok(!zt.includes(noise), `「zt」不许命中「${noise}」—— 那是整串 includes 的假阳性`);
}
assert.ok(zt.length <= 8, `「zt」的命中要收敛，实际 ${zt.length} 条：${JSON.stringify(zt)}`);

// 多段缩写与整串缩写都要能用。
assert.ok(ranked("ztzs").includes("字体着色"), "「ztzs」要命中「字体着色」");
assert.ok(ranked("ztms").includes("字体模式"), "「ztms」要命中「字体模式」");
assert.ok(ranked("wzdx").includes("文字大小"), "「wzdx」要命中「文字大小」");
assert.ok(ranked("ymdx").includes("页面动效"), "「ymdx」要命中「页面动效」");
assert.ok(ranked("jmyjh").includes("界面与交互"), "「jmyjh」要命中「界面与交互」");
assert.ok(ranked("bj").includes("背景标注"), "「bj」要命中「背景标注」");
assert.ok(!ranked("bj").includes("记住密码"), "「bj」不许命中「记住密码」（本机保存 → bjbcjm）");
assert.ok(!ranked("bj").includes("设备联动"), "「bj」不许命中「设备联动」");

// 标题类一律压过关键词类：界面上看得见的是标题。
assert.ok(scoreSearchEntry({ title: "字体模式" }, "zt") > scoreSearchEntry({ title: "文字大小", keywords: "字体" }, "zt"),
  "标题词段命中要高于关键词词段命中");
assert.ok(scoreSearchEntry({ title: "主题" }, "zt") > scoreSearchEntry({ title: "字体模式" }, "zt"),
  "标题全等要高于标题前缀");
assert.equal(matchesSearchEntry({ title: "主题" }, "zt"), true);
assert.equal(matchesSearchEntry({ title: "主题" }, "bgs"), false, "不沾边的缩写不能命中");
assert.equal(scoreSearchEntry({ title: "主题" }, ""), 0, "空查询给中性分，由调用方决定优先级");

/* ── ② 源码接线 ─────────────────────────────────────────────────────────── */
const has = (re, msg, src = navigatorSrc) => assert.ok(re.test(src), msg);

has(/import \{ matchesSearchEntry, scoreSearchEntry \} from "\.\.\/\.\.\/searchMatch\.js"/,
  "左栏搜索必须复用共享打分器，不许再自己写一份「整串 includes」");
has(/const scoreOption = \(item, q\) => scoreSearchEntry\(item, q\)/,
  "左栏设置项打分必须走共享打分器");
has(/function entryMatches\(entry, q\)/, "分类筛选要有独立函数（拼音缩写也要吃）");
assert.ok(!/pinyinInitialsOf\(`\$\{item\.title\} \$\{item\.keywords\}`\)/.test(navigatorSrc),
  "不许再回到「title+keywords 拼一整串再比首字母」的旧写法");
has(/empty\.hidden = visibleIds\.size > 0 \|\| hasOptions/,
  "分类没命中但有设置项命中时，不许再摆出「没有找到匹配的设置项」");
has(/paintSearchSummary\(\)/, "计数与空态要由同一个函数算，两处各写一遍迟早飘");

assert.match(paletteSrc, /scoreSearchEntry\(entry, q\)/, "命令面板要与设置页同一套打分");
assert.match(paletteSrc, /SETTINGS_SECTION_LABELS\[item\.section\]/,
  "命令面板的分区名要取共享映射表，不许再手抄一串三元表达式（漏一个分区会默认显示成「主题」）");

// force：从搜索结果里点具体设置项时，目标分区往往不在「按文字筛出来」的分类里。
has(/const select = \(id, \{ animate = true, force = false \} = \{\}\) => \{/, "select 要有 force 出口");
has(/if \(!force\) return;/, "force 之外仍要受筛选约束（普通点击不能绕过）");
assert.match(settingsSrc, /settingsNavigator\.select\(section, \{ force: true \}\)/,
  "点具体设置项必须 force 切分区，否则搜「zt」时分类 0 命中，select 直接返回 —— 表现就是「点了没反应」");

// 目标定位：通用解析，不再维护手写白名单。
assert.match(settingsSrc, /function findSettingTarget\(root, wanted\)/,
  "定位要改成通用解析（按元素自身文本找最深的一层）");
assert.match(settingsSrc, /const TARGET_ANCHORS = \[/, "要有「行级容器」白名单用于向上归位");
for (const anchor of [".about-meta", ".shortcut-grid", ".plugin-shortcut-block", ".lan-push-row"]) {
  assert.ok(settingsSrc.includes(anchor), `落点容器要覆盖 ${anchor}（实测漏过，那几条点了没反应）`);
}
assert.ok(!/"h2", "h3", "label", "button", "input", "select", "\[aria-label\]"/.test(settingsSrc),
  "旧的手写候选选择器清单要删干净");
assert.match(settingsSrc, /while \(matched && matched\.tagName === "OPTION" && matched\.parentElement\)/,
  "<option> 自己没有盒子，高亮它等于没高亮 —— 要落到它的 <select>");
assert.match(settingsSrc, /const landing = anchor\.getClientRects\?\.\(\)\.length \? anchor : \(root\.closest\?\.\("\.settings-section"\) \|\| root\)/,
  "命中的控件在当前状态下不渲染（.sync-daily 要配好网盘才展开）时要退回分区本身，否则滚动与高亮落在 0×0 的元素上");

// 打分器本身的实现守卫：锚整行，避免「注释掉实现、把文本留在注释里」骗过断言。
assert.ok(/^\s*if \(abbreviationSegments\(entry\.keywords\)\.includes\(q\)\) return SCORE\.KEYWORD_ABBR_EXACT;\s*$/m.test(matchSrc),
  "关键词只收词段全等 —— 允许前缀的话「整体缩放 → ztsf」会到处误命中");
assert.ok(/^\s*const SEGMENT_SPLIT = .*\/;?\s*$/m.test(matchSrc), "词段切分正则在，且不许被注释掉");

/* ── ③ 索引结构不变量 ───────────────────────────────────────────────────── */
const settingsIds = new Set([...settingsSrc.matchAll(/\{ id: "([a-z0-9-]+)", create:/g)].map((m) => m[1]));
assert.ok(settingsIds.size >= 14, `设置分区解析失败，只认出 ${settingsIds.size} 个`);
for (const section of new Set(SETTINGS_SEARCH_ENTRIES.map((x) => x.section))) {
  assert.ok(settingsIds.has(section), `索引里的分区 ${section} 在设置视图里不存在 —— 点下去切不到任何分区`);
}
for (const [section, label] of Object.entries(SETTINGS_SECTION_LABELS)) {
  assert.ok(settingsIds.has(section), `分区名映射表里的 ${section} 不是真实分区`);
  assert.ok(label.length > 0, `${section} 的中文名不能为空`);
}
for (const item of SETTINGS_SEARCH_ENTRIES) {
  assert.ok(item.title.trim().length > 0, `${item.section} 有一条空标题`);
  assert.ok(!/^[a-zA-Z]+$/.test(item.title) || item.title.length > 1, `标题疑似实现字段名：${item.title}`);
}
// 旧索引把「手机版测试」挂在 ui 下，而它其实在「测试」分区 —— 死条目。
assert.ok(!SETTINGS_SEARCH_ENTRIES.some((x) => x.title === "手机版测试"),
  "「手机版测试」是死条目（文案与分区都不对），不许回来");
assert.ok(SETTINGS_SEARCH_ENTRIES.some((x) => x.section === "testing" && x.title === "测试"),
  "「测试」分区要收进索引，否则手机预览那几项搜不到具体控件");

console.log(`PASS: 设置搜索按词段匹配拼音缩写（zt → 字体模式/文字大小），点击结果 force 切分区并定位到具体控件；索引 ${SETTINGS_SEARCH_ENTRIES.length} 条的分区与标题都自洽`);
