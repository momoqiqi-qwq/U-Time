import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 插件联动提醒：插件通过 tide.tasks.create 创建的任务自动记住来源插件（sourcePlugin），
   四象限任务卡与任务详情抽屉据此显示来源插件的图标（跟随用户在插件中心的自定义图标/强调色）。 */

const root = new URL("../", import.meta.url);
const read = (p) => readProductSource(new URL(p, root), "utf8");
const host = read("src/pluginHost.js");
const quad = read("src/views/quadrant.js");
const drawer = read("src/views/drawer.js");
const css = read("src/styles.css");

/* 1. 宿主注入：tasks.create 必须写入 sourcePlugin，且以宿主注入为准（插件传同名字段会被覆盖，防伪装来源） */
assert.match(host, /S\.addTask\(\{ \.\.\.patch, sourcePlugin: pid \}\)/, "tasks.create 必须注入来源插件 id（宿主注入优先）");

/* 2. 四象限任务卡：有来源插件的任务在标题行渲染插件小图标 + 悬停提示 */
assert.match(quad, /t\.sourcePlugin \? el\("span", \{ class: "src-ic"/, "四象限任务卡要为插件来源任务渲染插件图标");
assert.match(quad, /来自插件/, "任务卡来源图标要带「来自插件 ××」悬停提示");
assert.match(quad, /pluginDisplayName, pluginDisplayIcon/, "四象限要复用 pluginAppearance（用户自定义图标/强调色自动跟随）");
assert.doesNotMatch(quad, /sourcePlugin: pid/, "视图层只读 sourcePlugin，不许自己伪造来源");

/* 3. 任务详情抽屉：显示「来源插件」行（图标 + 名称），手动创建的任务没有该行 */
assert.match(drawer, /"来源插件"/, "任务详情抽屉要有「来源插件」行");
assert.match(drawer, /pluginDisplayIcon\(t\.sourcePlugin/, "抽屉来源行必须用 pluginDisplayIcon 渲染图标");

/* 4. 样式：两处来源图标都要有尺寸规则，否则 app-icon 默认 30px 会把任务卡撑爆 */
assert.match(css, /\.tkc \.tt \.tt-top \.src-ic \.app-icon \{ width: 15px/, "任务卡来源图标要有小尺寸规则");
assert.match(css, /\.kv \.src-plug \.app-icon \{ width: 18px/, "抽屉来源图标要有尺寸规则");

/* 5. 🔴 回归守卫：原生 append() 会把假值字符串化，`append(null)` 落成文本 "null"
   ── 曾经的 bug（v0.48.0 用户截图报的「抽屉里多一行 null」）：
   `body.append(..., t.sourcePlugin ? <行> : null, ...)` 用的是**原生** Element.append，
   不经过 el() 的 null 过滤；手动创建的任务（无 sourcePlugin，占绝大多数）取到 : null 分支，
   于是抽屉里渲染出一个裸 `null` 文本节点（在「任务名称」与「标签」之间）。
   修法：把这一串实参先收进数组、`filter(Boolean)` 之后再展开。
   下面两条断言分别守「确实过滤了」与「没退回成裸实参」。 */
assert.match(drawer, /\]\.filter\(Boolean\)/, "抽屉 dbody 的 append 实参必须先滤掉假值再展开");

// 取向上的实参区（body.append( 到与之配对的 ); ），确认「三元收尾的 : null」不再作为裸实参存在。
// 判据：三元结尾的 ))) : null, 之后紧邻的必须是数组元素分隔或闭括号，而**不是直接跑到 el(...)** 那一层。
// 更稳的写法：整个 body.append(<单个表达式>); 里，实参只能有 1 个（即那个被展开的数组）。
{
  const idx = drawer.indexOf("body.append(");
  assert.ok(idx > 0, "抽屉里应当有 body.append(");
  // 手工配对括号找到调用结束
  let depth = 0, end = -1, started = false;
  for (let i = idx + "body.append".length; i < drawer.length; i++) {
    const ch = drawer[i];
    if (ch === "(") { depth++; started = true; }
    else if (ch === ")") { depth--; if (started && depth === 0) { end = i; break; } }
  }
  assert.ok(end > idx, "能配对到 body.append( 的右括号");
  const argBlock = drawer.slice(idx + "body.append(".length, end).trim();
  assert.ok(
    argBlock.startsWith("...["),
    "抽屉 body.append 的唯一实参应当是 `...[…].filter(Boolean)`（先过滤再展开），实际开头是：" + argBlock.slice(0, 40),
  );
  assert.ok(
    argBlock.endsWith("filter(Boolean)") || argBlock.endsWith("filter(Boolean),"),
    "抽屉 body.append 的实参结尾应当是 .filter(Boolean)",
  );
  // 断言：整个实参区里没有「裸 xx,」形式的顶层实参（顶层只有 1 个 —— 被展开的数组）
  assert.equal(
    argBlock.includes(") : null,") && !argBlock.includes("].filter(Boolean)"),
    false,
    "三元 : null 必须在被过滤的数组里，不能作为裸实参",
  );
}

console.log("PASS: 插件联动提醒（sourcePlugin 注入 + 四象限/抽屉来源插件图标 + 原生 append 假值守卫）");
