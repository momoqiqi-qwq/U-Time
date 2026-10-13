import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KEYWORD_HIGHLIGHTS, highlightSegments, normalizeKeywordHighlights } from "../src/keywordHighlights.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readProductSource(path.join(here, "..", name), "utf8");

const defaults = highlightSegments("今天 09:30，截止 2026-09-21 18:00", DEFAULT_KEYWORD_HIGHLIGHTS);
assert.deepEqual(defaults.filter((part) => part.kind === "time").map((part) => part.text),
  ["今天", "09:30", "2026-09-21", "18:00"], "默认规则应识别日期和时刻");
assert.ok(defaults.filter((part) => part.kind === "time").every((part) => part.color === "#e5484d"),
  "日期和时间默认使用红色字体");

const moreTimes = highlightSegments("明天上午8：25交，2026年9月22日 09:50 截止；9.28 22时30分复查，下周三下午3点半到5点。", DEFAULT_KEYWORD_HIGHLIGHTS)
  .filter((part) => part.kind === "time").map((part) => part.text);
assert.deepEqual(moreTimes,
  ["明天", "上午8：25", "2026年9月22日", "09:50", "9.28", "22时30分", "下周三", "下午3点半到5点"],
  "应覆盖中文日期、点号月日、全角冒号、中文时分、周几和时间段");

assert.deepEqual(highlightSegments("插件版本 v2.12.1 不应整段标红", DEFAULT_KEYWORD_HIGHLIGHTS)
  .filter((part) => part.kind === "time").map((part) => part.text), [],
  "版本号里的点号不应被误识别为日期");

const custom = highlightSegments("重点任务，今天 09:30 完成", {
  rules: [
    { id: "a", keyword: "重点", color: "#f59e0b", mode: "background" },
    { id: "b", keyword: "任务", color: "#2563eb", mode: "text" },
  ],
});
assert.deepEqual(custom.filter((part) => part.kind === "keyword").map(({ text, mode, color }) => ({ text, mode, color })), [
  { text: "重点", mode: "background", color: "#f59e0b" },
  { text: "任务", mode: "text", color: "#2563eb" },
], "自定义关键词应分别支持背景与字体着色");

const overlap = highlightSegments("09:30", {
  timeColor: "#e5484d",
  rules: [{ keyword: "09:30", color: "#16a34a", mode: "background" }],
});
assert.equal(overlap.length, 1, "同一段文字不应重复嵌套标注");
assert.equal(overlap[0].kind, "keyword", "自定义关键词应优先于时间规则");
assert.deepEqual(highlightSegments("重点 09:30", { enabled: false }), [{ text: "重点 09:30" }],
  "关闭总开关后应返回普通文本");

const normalized = normalizeKeywordHighlights({
  timeColor: "red",
  rules: [{ keyword: "  重点  ", color: "bad", mode: "unknown" }, { keyword: "" }],
});
assert.equal(normalized.timeColor, "#e5484d", "非法时间颜色应回退默认红色");
assert.deepEqual(normalized.rules, [{ id: "mark-1", keyword: "重点", color: "#f59e0b", mode: "text", enabled: true }],
  "关键词配置应裁剪文字并归一化颜色和模式");

const helper = read("src/keywordHighlights.js");
const settings = read("src/views/settings/highlights.js");
const quadrant = read("src/views/quadrant.js");
const inbox = read("src/views/inbox.js");
const timeline = read("src/views/timeline.js");
const css = read("src/styles.css");
assert.doesNotMatch(helper, /innerHTML\s*=/, "关键词必须按文本节点渲染，禁止 innerHTML 注入");
assert.match(settings, /日期和时间自动标红/, "设置页必须提供默认时间标红开关");
assert.match(settings, /字体着色/);
assert.match(settings, /背景标注/);
for (const [name, source] of [["任务栏", quadrant], ["收件箱", inbox], ["时间线", timeline]]) {
  assert.match(source, /highlightedText\(/, `${name}必须渲染关键词标注`);
}
assert.match(css, /\.keyword-mark\.text\s*\{/);
assert.match(css, /\.keyword-mark\.background\s*\{/);

/* 正则缓存（v0.206.0）：四象限每张卡都要跑一遍 highlightSegments，同一批关键词
   不许每帧重新编译。A/B 实测（同函数只换取正则那一行，10 规则 × 3000 轮）：
   每次编译 15.78µs/次 → 缓存 10.86µs/次。 */
assert.match(helper, /const KEYWORD_RE_CACHE = new Map\(\)/, "关键词正则要有模块级缓存");
assert.match(helper, /KEYWORD_RE_CACHE\.get\(key\)/, "取正则要先查缓存");
assert.match(helper, /KEYWORD_RE_CACHE\.size >= KEYWORD_RE_CACHE_MAX\) KEYWORD_RE_CACHE\.clear\(\)/,
  "缓存满了要整体清空（键很有限，不为此再写一层 LRU）");
assert.match(helper, /re\.lastIndex = 0;/, "复用带 g 的实例前要把 lastIndex 归零");
assert.ok(!/new RegExp\(escapeRegExp\(rule\.keyword\)/.test(helper),
  "highlightSegments 不许再对每条规则就地 new RegExp —— 那就是缓存被绕过了");
assert.equal((helper.match(/new RegExp\(escapeRegExp\(/g) || []).length, 1,
  "new RegExp(escapeRegExp(...)) 只应出现在 keywordRegExp 里");

console.log("PASS: 关键词可按字体或背景标注，日期时间默认红色且安全渲染，正则按关键词缓存复用");
