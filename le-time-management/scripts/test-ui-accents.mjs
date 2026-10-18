// v0.249.0 界面点缀：空状态线稿 / 来源图标 / 规则开关 / 节奏标签 / 字标重画 —— 静态断言
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

/* 1. 线稿模块：五种画面齐全，线条只认 currentColor，强调色只走变量（hex 只允许出现在 var() 兜底里） */
const art = read("src/emptyArt.js");
for (const k of ["q1", "q2", "q3", "q4", "inbox"]) assert.match(art, new RegExp(`\\n  ${k}: \``), `emptyArt.js 缺少「${k}」画面`);
assert.match(art, /stroke="currentColor"/, "线稿线条必须走 currentColor（跟随主题）");
assert.match(art, /style="fill:var\(--ea-accent,/, "强调色必须写在 style 里走 --ea-accent（展示属性不认 CSS 变量）");
const hexes = art.replace(/var\(--[\w-]+,#[0-9A-Fa-f]{3,8}\)/g, "").match(/#[0-9A-Fa-f]{6}\b/g) || [];
assert.deepEqual(hexes, [], "emptyArt.js 里不该写死颜色（只允许 var() 兜底）");

/* 2. 接入点 */
const quad = read("src/views/quadrant.js");
assert.match(quad, /import \{ emptyArt \} from "\.\.\/emptyArt\.js"/, "四象限必须用 emptyArt");
assert.match(quad, /classList\.toggle\("is-empty", S\.tasksOfQuad\(def\.q\)\.length === 0\)/,
  "空象限判定必须看象限真实任务数（搜索 / 筛选筛空不算空）");
for (const n of [1, 2, 3, 4]) assert.match(quad, new RegExp(`\\n  ${n}: "`), `象限 ${n} 缺少空状态文案`);
const inbox = read("src/views/inbox.js");
assert.match(inbox, /emptyArt\('inbox'/, "收件箱清空要用线稿");
assert.match(inbox, /pluginIdBySource\(item\.source\)/, "旧条目要按 source 文案反查插件图标");
assert.match(inbox, /'data-action':r\.action/, "规则行要带 data-action（图标与配色按它取）");
assert.match(inbox, /toggleSwitch\(/, "规则启停仍是滑块开关");
assert.match(read("src/pluginHost.js"), /pushInbox\(\{ source: man\.name \|\| pid, sourcePlugin: pid, \.\.\.item \}\)/,
  "插件推进收件箱的条目必须记下 sourcePlugin");

/* 3. 样式 */
const css = read("src/styles/ui-accents.css");
assert.match(read("index.html"), /href="\/src\/styles\/ui-accents\.css"/, "index.html 必须引入 ui-accents.css");
assert.match(css, /\.automation-rule input\.switch \{ width: var\(--switch-w\); height: var\(--switch-h\);/,
  "规则开关必须按 .switch 尺寸还原（否则被旧的 18×18 压成圆点）");
assert.match(css, /\.rhythm \.r \{ overflow: visible;/, "节奏柱必须放开 overflow，否则星期标签被裁掉");
const tb = read("src/views/timeblock.js");
assert.doesNotMatch(tb, /background:#DCEAEF/, "节奏柱当天高亮不能再写死浅色");
assert.match(tb, /" cur"/, "节奏柱要标出正在查看的那天");
assert.match(tb, /S\.todayStr\(\) \? " today"/, "节奏柱要标出今天");

/* 4. 三个插件各自内联线稿（不能依赖宿主模块） */
for (const [pid, name] of [["weekly-report", "WR_EMPTY_ART"], ["rss-reader", "NO_FEED_ART"], ["school-notice", "SN_NO_SITE_ART"]]) {
  const src = read(`public/plugins/${pid}/main.js`);
  assert.match(src, new RegExp(`const ${name} = '<svg viewBox="0 0 160 100"`), `${pid} 必须内联自己的空状态 SVG`);
  assert.match(src, /--ea-accent:#[0-9A-F]{6}/, `${pid} 要给线稿设强调色`);
  assert.doesNotMatch(src, /emptyArt\.js/, `${pid} 不能 import 宿主的 emptyArt.js`);
}

/* 5. 字标重画：零依赖、尊重减少动态 */
const bw = read("src/brandWordmark.js");
assert.match(bw, /export function replayBrandRule\(svg, reduced = false\) \{\n  if \(!svg \|\| reduced\) return;/, "replayBrandRule 必须在减少动态时直接返回");
assert.equal((bw.match(/class="br-line" data-side="[lr]" pathLength="1"/g) || []).length, 2, "两条主线都要 pathLength=1");
assert.doesNotMatch(bw, /^import /m, "brandWordmark.js 保持零依赖（刷新蒙版首屏前就要用）");
assert.match(read("src/shell.js"), /replayBrandRule\(document\.querySelector\("\.rail \.brand > \.brand-rule"\), reducedMotion\(\)\)/,
  "切换视图时重画字标线，并把 reducedMotion() 传进去");
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.brand-rule\.br-draw \* \{ animation: none !important;/, "CSS 也要兜底减少动态");

console.log("ui-accents: OK");
