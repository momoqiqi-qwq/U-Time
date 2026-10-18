import assert from "node:assert/strict";
import { readProductSource } from "./lib/read-product-source.mjs";

/* 待办里的「名单碎片」守卫。
   实测事故（2026-10-10，用户粘贴三次）：从聊天窗复制的名单接龙被 capture.js
   当成一件事建了三条待办 ——
     「1 刘2 梁3 冯」note "1\r\n刘2\r\n梁3\r\n冯"
     「3 冯 4 张」  note "3\r\n冯\r\n\r\n4\r\n张"
     「3 冯」       note "3\r\n冯"
   这三条出现在收件箱面板里，既看不懂也没法一眼判断该不该做。
   captureNoise.looksLikeNoise 负责在 handleText 建任务前把它们挡掉。 */

const { looksLikeNoise } = await import("../src/captureNoise.js");

/* 1. 事故原文必须判为碎片（原文三种 + 拼成标题后的形态） */
const DIRTY = [
  "1\r\n刘2\r\n梁3\r\n冯",
  "3\r\n冯\r\n\r\n4\r\n张",
  "3\r\n冯",
  "1 刘2 梁3 冯",
  "3 冯 4 张",
  "1刘2梁3冯",
];
for (const t of DIRTY) {
  assert.equal(looksLikeNoise(t), true, `名单碎片必须挡下：${JSON.stringify(t)}`);
}

/* 2. 空白 / 纯数字 / 纯符号：同样不是一件事 */
for (const t of ["", "   ", "\r\n\t", "123", "1 2 3", "——", "……"]) {
  assert.equal(looksLikeNoise(t), true, `空内容或纯数字符号必须挡下：${JSON.stringify(t)}`);
}

/* 3. 真实待办一个都不许误杀（含超短、中英混排、带链接与全角冒号） */
const OK = [
  "开会",
  "A4纸",
  "交论文",
  "作业:《C语言程序设计A》实训2",
  "作业作答.download",
  "周五 9:00 交论文",
  "关于组织开展第十届学术文化活动月的通知",
  "https://portal-jw.cppu.edu.cn/tp_up/view?m=up",
  "明早8点前把实验报告发到邮箱",
];
for (const t of OK) {
  assert.equal(looksLikeNoise(t), false, `真实待办不许误杀：${JSON.stringify(t)}`);
}

/* 4. 接线：守卫必须在 handleText 里、且在 addTask 之前 */
const capture = readProductSource(new URL("../src/capture.js", import.meta.url), "utf8");
assert.match(capture, /import \{ looksLikeNoise \} from "\.\/captureNoise\.js"/, "capture.js 要引入碎片守卫");
assert.match(capture, /function handleText\(text\) \{[\s\S]{0,400}?looksLikeNoise\(text\)/, "handleText 开头必须先过守卫");
const guardAt = capture.indexOf("looksLikeNoise(text)");
const addAt = capture.indexOf("S.addTask({", guardAt);
assert.ok(guardAt > 0, "守卫调用必须存在");
assert.ok(addAt > guardAt, "守卫必须排在 addTask 之前");
assert.match(capture, /没当成一件事/, "拦截时要给用户一句说明，不能静默丢弃");

console.log("PASS: 名单碎片守卫（6 条事故原文 + 7 条空/符号 + 9 条真实待办 + 接线）");
