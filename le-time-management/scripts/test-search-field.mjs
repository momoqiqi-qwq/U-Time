import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");

const fieldModule = read("../src/searchField.js");
const css = read("../src/styles.css");
const shell = read("../src/shell.js");
const palette = read("../src/commandPalette.js");
const quadrant = read("../src/views/quadrant.js");
const navigatorSrc = read("../src/views/settings/navigator.js");
const pluginsSrc = read("../src/views/settings/plugins.js");
const aiPicker = read("../src/views/settings/aiModelPicker.js");

/* ── 需求（用户）：「删除所有搜索框内的中文，仅保留搜索图标。」 ──────────────────────
   这条契约有两半，缺一半就是回归：
   ① 框里不许再写中文占位词 —— 每个搜索框的 placeholder 都清空（提示改挂 title）；
   ② 框里必须有那颗放大镜 —— 除命令面板（图标本来就在框外的 .cmd-search 行里）之外，
      其余搜索框统一走 src/searchField.js 的 withSearchGlyph()。 */

// ① 中文占位词清空（按调用点逐个查，避免「只改了一个框」也能过）。
const placeholderSites = [
  ["src/shell.js", shell, /class: "market-search"[^}]*placeholder: "([^"]*)"/, "插件中心搜索框"],
  ["src/views/quadrant.js", quadrant, /class: "task-search"[^}]*placeholder: "([^"]*)"/, "四象限任务搜索框"],
  ["src/views/settings/plugins.js", pluginsSrc, /class: "plugin-search-input"[^}]*placeholder: "([^"]*)"/, "插件管理搜索框"],
  ["src/commandPalette.js", palette, /class: "cmd-input"[^}]*placeholder: "([^"]*)"/, "命令面板搜索框"],
];
for (const [file, src, re, label] of placeholderSites) {
  const hit = src.match(re);
  assert.ok(hit, `${file}：没找到${label}的 placeholder 声明（选择器/类名变了？）`);
  assert.equal(hit[1], "", `${file}：${label}里不许再有中文占位词，提示改挂 title / aria-label`);
}
for (const [file, src, label] of [
  ["src/views/settings/navigator.js", navigatorSrc, "设置左栏搜索框"],
  ["src/views/settings/aiModelPicker.js", aiPicker, "模型列表搜索框"],
]) {
  assert.match(src, /placeholder: ""/, `${file}：${label}的 placeholder 必须清空`);
}

// 旧的中文占位串一个都不许留在产物里（改名/搬家式的「假删除」也会被这条抓住）。
const allSources = [fieldModule, shell, palette, quadrant, navigatorSrc, pluginsSrc, aiPicker].join("\n");
for (const phrase of [
  "搜索插件名称 / ID / 功能 / 作者…",
  "搜索插件名称 / ID / 描述 / 作者…",
  "搜索任务 / 备注 / 项目",
  "搜索模型名称或 ID",
]) {
  assert.ok(!allSources.includes(phrase), `旧的中文占位词必须删干净，仍残留：「${phrase}」`);
}
// 中文提示只是从「框内」挪到「悬停可见」，不是整条删掉（否则用户不知道这个框能搜什么）。
assert.ok(palette.includes('title: "搜索任务、时间块、插件、设置，或输入命令"'),
  "命令面板的长提示应当挪进 title，而不是连同占位词一起丢掉");
assert.ok(navigatorSrc.includes("title: \"搜索设置：背景、快捷键、WebDAV…也认拼音缩写（zt → 字体）\""),
  "设置左栏的搜索提示同理，挪进 title");

// ② 每个搜索框都挂上放大镜。
for (const [file, src] of [
  ["src/shell.js", shell],
  ["src/views/quadrant.js", quadrant],
  ["src/views/settings/navigator.js", navigatorSrc],
  ["src/views/settings/plugins.js", pluginsSrc],
  ["src/views/settings/aiModelPicker.js", aiPicker],
]) {
  assert.ok(src.includes("withSearchGlyph("), `${file}：搜索框必须走 withSearchGlyph()，否则框里一颗图标都没有`);
}
assert.ok(palette.includes("cmd-search-ico"), "命令面板的放大镜（.cmd-search-ico）不能被删掉");
assert.ok(shell.includes('searchGlyph("market-search-glyph")'),
  "窄屏插件中心的搜索开关也要换成同一颗放大镜（原来是「⌕」这个字符）");

// 图标本体：内联 SVG、走 currentColor，深浅主题同一份。
assert.match(fieldModule, /stroke="currentColor"/, "放大镜必须跟随 currentColor（深色主题下才不是黑图）");
assert.match(fieldModule, /export function withSearchGlyph\(/, "searchField.js 必须导出 withSearchGlyph()");
assert.match(fieldModule, /export function searchGlyph\(/, "searchField.js 必须导出 searchGlyph()");

// ③ 样式契约：图标钉在框内左端、不吃指针事件、输入框让出内边距。
assert.match(css, /\.search-field\{[^}]*position:relative/, "图标要钉在框内，容器必须建立定位上下文");
assert.match(css, /\.search-ico\{[^}]*position:absolute[^}]*pointer-events:none/, "图标绝对定位且不许吃点击（点图标要能聚焦输入框）");
assert.match(css, /\.search-field > input\{[^}]*padding-left:38px/, "输入框要留出图标的位置（否则文字压住放大镜）");
// 四象限的 .quad-wrap 是列向 flex：容器必须 flex:none，否则 flex:1 会纵向吸走剩余高度、把象限网格压扁。
assert.match(css, /\.search-field\{[^}]*flex:0 1 auto/, "容器默认不许纵向伸展（.quad-wrap 是列向 flex）");
assert.match(css, /\.quad-wrap > \.search-field\{flex:none;margin:0 0 14px\}/, "四象限搜索框的留白挪到容器上，高度按内容走");
assert.match(css, /\.market-search-row > \.search-field, \.plugin-search-row > \.search-field\{flex:1 1 auto\}/,
  "横排搜索行里容器要吃满剩余宽度");
assert.match(css, /\.search-field > \.task-search\{margin:0;width:100%\}/, "输入框自己必须归零 margin，避免图标与框错位");

/* ④ 内置插件：同一份契约（v0.185.0 起）。
   插件是独立打包的单文件，既 import 不了 src/searchField.js、也拿不到宿主的
   .search-field 样式，所以只能按同一套做法各写一遍：容器 + 绝对定位图标 + 输入框让出左内边距。
   这里逐个查「容器 / 图标 / 让位」三件套，漏一件就是「框里没图标」或「文字压住图标」。 */
const pluginSites = [
  ["chaoxing-notify/main.js", "学习通通知（收件箱 / 课程）", "cx2-searchbox", "cx2-search-ico", "cx2-search"],
  ["cppu-notify/main.js", "警大门户通知搜索", "pp-kwbox", "pp-kw-ico", "pp-kw"],
  ["gx-news/main.js", "竞赛消息雷达搜索", "gx-kwbox", "gx-kw-ico", "gx-kw"],
  ["rss-reader/main.js", "RSS 关键词搜索", "rss-kwbox", "rss-kw-ico", "rss-input"],
  ["web-collector/main.js", "网址收藏搜索", "wc-searchbox", "wc-search-ico", "wc-input"],
  ["school-notice/main.js", "学校通知搜索", "sn-searchbox", "sn-search-ico", "sn-in"],
  ["shiguang-schedule/ui.js", "课程表学校搜索", "school-searchbox", "school-search-ico", "school-search"],
  ["exam-calendar/src/main.template.js", "考试日历搜索", "ecal-searchbox", "ecal-search-ico", "ecal-search"],
];
const pluginSources = [];
for (const [file, label, box, ico, input] of pluginSites) {
  const src = read(`../public/plugins/${file}`);
  pluginSources.push(src);
  assert.match(src, new RegExp(`\\.${box}[{,:][^}]*position:relative`), `${file}：${label}的容器必须建立定位上下文（${box}）`);
  assert.match(src, new RegExp(`\\.${ico}{[^}]*position:absolute`), `${file}：${label}的放大镜要绝对定位在框内（${ico}）`);
  assert.match(src, new RegExp(`\\.${box}>\\.${input}[^{]*{[^}]*padding-left:`), `${file}：${label}的输入框要留出图标的位置`);
  assert.ok(src.includes(`class="${ico}"`), `${file}：${label}必须真的渲染出那颗放大镜`);
}
// 一网打尽：这些搜索框的旧中文占位词不许在任何一处残留（改名 / 搬家式的假删除也会被抓住）。
const pluginAll = pluginSources.join("\n");
for (const phrase of [
  "搜索课程 / 教师 / 作业 / 考试 / 正文…",
  "搜索课程 / 教师 / 班级…",
  "关键词过滤：标题 / 发布人 / 单位 / 分类…",
  "关键词过滤：如 答辩 / 数学 / 报名 / 截止…",
  "关键词过滤：标题与摘要…",
  "搜索已收藏网站",
  "搜索通知",
  "搜索学校名称或拼音首字母",
  "搜索考试名称",
]) {
  assert.ok(!pluginAll.includes(`placeholder="${phrase}"`), `插件搜索框里不许再有中文占位词，仍残留：「${phrase}」`);
}
// 提示只是从「框内」挪到「悬停可见 + 读屏可见」，不是整条删掉。
assert.ok(pluginAll.includes('title="搜索学校名称或拼音首字母"'), "课程表的搜索提示要挪进 title");
assert.ok(pluginAll.includes('aria-label="关键词过滤：标题 / 发布人 / 单位 / 分类"'), "警大门户的搜索提示要挪进 aria-label");

/* ⑤ 小程序：同一份契约的第三个宿主。
   小程序既没有内联 SVG 的能力，也不共享桌面的 CSS，所以图标改用纯 CSS 画的
   圆环 + 斜柄（.search-ico::before / ::after），一套样式放 app.wxss，六个页面共用。 */
const miniCss = read("../../miniprogram/app.wxss");
assert.match(miniCss, /\.search-wrap\s*{[^}]*position:\s*relative/, "小程序搜索框容器要建立定位上下文");
assert.match(miniCss, /\.search-ico\s*{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/, "小程序的放大镜绝对定位且不吃点击");
assert.match(miniCss, /\.search-ico::before\s*{[^}]*border-radius:\s*50%/, "放大镜的「镜片」得是个圆");
assert.match(miniCss, /\.search-ico::after\s*{[^}]*transform:\s*rotate\(45deg\)/, "放大镜的「手柄」得是根斜杠");
assert.match(miniCss, /\.search-wrap\s*>\s*input\s*{[^}]*padding-left:\s*62rpx/, "输入框要留出图标的位置（否则文字压住放大镜）");

const miniSites = [
  ["pages/inbox/index.wxml", "收件箱"],
  ["pages/library/index.wxml", "资料库"],
  ["pages/plugins/index.wxml", "插件中心"],
  ["pages/quadrant/index.wxml", "四象限"],
  ["pages/schedule/index.wxml", "课程表"],
  ["pages/plugin/index.wxml", "插件页（考试日历 / 竞赛雷达 / 学习通）"],
];
const miniSources = miniSites.map(([file, label]) => {
  const src = read(`../../miniprogram/${file}`);
  assert.ok(src.includes('class="search-wrap'), `${file}：${label}的搜索框必须包上 .search-wrap`);
  assert.ok(src.includes('class="search-ico"'), `${file}：${label}的搜索框里必须有一颗放大镜`);
  return src;
});
const miniAll = miniSources.join("\n");
for (const phrase of [
  "搜索标题、内容或来源",
  "搜索标题、摘要或备注",
  "搜索插件名称 / ID / 功能…",
  "搜索考试名称",
  "关键词：答辩 / 数学 / 报名 / 截止…",
  "搜索标题 / 正文 / 发送者…",
  "搜索课程 / 教师 / 班级…",
  "搜索任务 / 备注 / 项目 / 标签",
  "搜索课程、教师、地点、备注",
]) {
  assert.ok(!miniAll.includes(`placeholder="${phrase}"`), `小程序搜索框里不许再有中文占位词，仍残留：「${phrase}」`);
}
assert.equal((miniSources[4].match(/search-wrap/g) || []).length >= 1, true, "课程表管理页的搜索框也要换掉");
assert.equal((miniSources[5].match(/class="search-wrap"/g) || []).length, 4, "插件页四处搜索框（考试 / 竞赛 / 学习通收件箱与课程）要共用同一个容器类");

console.log("PASS: 所有搜索框（顶栏 / 命令面板 / 插件中心 / 四象限 / 设置左栏 / 插件管理 / 模型列表 + 8 个内置插件 + 小程序 6 个页面）框内不再有中文占位词，只留一颗跟随主题的放大镜");
