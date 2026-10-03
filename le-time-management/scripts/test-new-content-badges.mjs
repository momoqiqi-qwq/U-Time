import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");
const store = read("../src/store.js");
const ui = read("../src/ui.js");
const quadrant = read("../src/views/quadrant.js");
const inbox = read("../src/views/inbox.js");
const timeline = read("../src/views/timeline.js");
const drawer = read("../src/views/drawer.js");
const settings = read("../src/views/settings.js");
const css = read("../src/styles.css");

assert.match(ui, /export function newBadge\(visible = true\)/, "NEW 标签由统一组件生成");
assert.match(ui, /class: "new-badge"[\s\S]{0,100}"NEW"/, "统一组件输出 NEW 文案与类名");

assert.match(store, /createdAt: Date\.now\(\), isNew: true, \.\.\.patch/, "新任务默认带新内容标记");
assert.match(store, /cat: "work", createdAt: Date\.now\(\), isNew: true, \.\.\.patch/, "新时间块默认带新内容标记");
assert.match(store, /export function markTaskSeen\(id\)/, "任务可在查看后清除标记");
assert.match(store, /export function markBlockSeen\(id\)/, "时间块可在查看后清除标记");

assert.match(quadrant, /newBadge\(t\.isNew === true\)/, "任务表标题末尾显示 NEW");
assert.match(inbox, /newBadge\(item\.status==='new'\)/, "收件箱新消息标题末尾显示 NEW");
assert.match(timeline, /newBadge\(e\.isNew === true\)/, "时间线新节点标题末尾显示 NEW");
assert.match(drawer, /S\.markTaskSeen\(taskId\)/, "打开任务详情后清除 NEW");
assert.match(timeline, /S\.markTaskSeen\(e\.taskId\)/, "展开时间线任务后清除 NEW");
assert.match(timeline, /S\.markBlockSeen\(e\.id\.slice\(4\)\)/, "展开时间线时间块后清除 NEW");

assert.match(settings, /createdAt: x\.createdAt \|\| now, isNew: true/, "合并导入的任务与时间块也标成新内容");
assert.match(css, /\.new-badge\s*\{[\s\S]*background: #ff5d6c; color: #fff;/, "标签使用截图对应的红底白字胶囊样式");
assert.match(css, /border-radius: 999px/, "标签保持完整胶囊圆角");

console.log("PASS: 任务表 / 收件箱 / 时间线统一 NEW 标签（新增写入 / 三处渲染 / 查看即清除 / 导入覆盖）");
