import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 任务卡曲线删除回归测试 —— v0.79.0
 *
 * 守住手势阈值、曲线退场、动画后删数据、未达阈值归位、键盘与 reduced-motion，
 * 同时确保横滑不会劫持纵向拖拽排序。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readProductSource(path.join(here, rel), "utf8");
const quadrantJs = read("../src/views/quadrant.js");
const styles = read("../src/styles.css");

assert.match(quadrantJs, /function attachCardSwipeDelete\(list, trash\)/,
  "四象限必须挂载独立的横滑删除控制器");
assert.match(quadrantJs, /Math\.max\(THRESHOLD_MIN, Math\.min\(150, st\.card\.offsetWidth \* \.38\)\)/,
  "删除阈值必须随卡片宽度计算，并设合理上下限");
assert.match(quadrantJs, /Math\.abs\(st\.dx\) <= Math\.abs\(dy\) \* 1\.15/,
  "横滑删除必须先做方向仲裁，纵向手势要让给滚动/排序");
assert.match(quadrantJs, /Math\.abs\(dx\) > Math\.abs\(dy\) \* 1\.15\) return;/,
  "桌面横向移动必须由删除控制器优先接管，不能误启动排序");

const deleteStart = quadrantJs.indexOf("const deleteAlongCurve = async (st) => {");
const deleteEnd = quadrantJs.indexOf("const finish = (st, cancelled = false) => {", deleteStart);
const deleteBlock = quadrantJs.slice(deleteStart, deleteEnd);
assert.ok(deleteStart > -1 && deleteEnd > deleteStart, "必须存在曲线退场代码块");
assert.match(deleteBlock, /const tx = to\.left \+ to\.width \/ 2 - \(from\.left \+ from\.width \/ 2 - dx\)/,
  "退场终点必须取真实删除目标中心，不能飞向固定屏幕坐标");
assert.match(deleteBlock, /ty \* \.14 - arc/,
  "曲线路径中段必须加入弧高，而非直线平移");
assert.match(deleteBlock, /rotate\(\$\{turn \* 19\}deg\) scale\(\.12\)/,
  "卡片飞出时必须旋转并缩小");
assert.match(deleteBlock, /opacity: 0/,
  "卡片飞出时必须淡出");
assert.match(deleteBlock, /if \(reducedMotion\(\)\)/,
  "必须为 reduced-motion 提供短淡出分支");
const waitAt = deleteBlock.indexOf("await animateAndWait(card");
const removeAt = deleteBlock.indexOf("S.deleteTaskUndoable(st.id)");
assert.ok(waitAt > -1 && removeAt > waitAt,
  "数据源删除必须发生在 await 退场动画之后");

assert.match(quadrantJs, /const returnHome = async \(st\) =>/,
  "未过阈值必须有独立归位动画");
assert.match(quadrantJs, /if \(cancelled \|\| !st\.armed\) returnHome\(st\)/,
  "取消或未过阈值时必须回原位");
assert.match(quadrantJs, /event\.key !== "Delete" && event\.key !== "Backspace"/,
  "键盘必须支持 Delete 与 Backspace 删除当前聚焦卡片");
assert.match(quadrantJs, /document\.addEventListener\("pointerup", st\.docUp, true\)/,
  "鼠标/触摸在卡片外松手也必须能结束会话");
assert.match(quadrantJs, /document\.body\.dataset\.swipeSuspended = "1"/,
  "横滑删除期间必须暂停页面级滑动返回");

assert.match(styles, /\.tkc \{[^}]*touch-action: pan-y;/s,
  "任务卡必须保留纵向原生滚动，并允许 JS 接管横滑");
assert.match(styles, /\.task-trash-target \{[^}]*position: absolute;/s,
  "象限内必须有明确的删除目的地");
assert.match(styles, /\.task-trash-target\.armed \{[^}]*background: var\(--danger\)/s,
  "跨过阈值后删除目的地必须切换为危险强调态");
assert.match(styles, /\.tkc\.swipe-active \{[^}]*will-change: transform, opacity;/s,
  "活动卡片必须优化 transform/opacity 曲线动画");
assert.match(styles, /\.tkc\.swipe-deleting \{ pointer-events: none; \}/,
  "退场中的卡片不能再次响应输入");

console.log("PASS: 任务卡曲线删除（阈值归位 / 曲线缩放旋转淡出 / 动画后删除 / 触摸鼠标键盘 / reduced-motion）");
