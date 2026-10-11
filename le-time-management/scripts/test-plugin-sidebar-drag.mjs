import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = readProductSource(path.join(here, "..", "src", "shell.js"), "utf8");
const css = readProductSource(path.join(here, "..", "src", "styles.css"), "utf8");
const block = shell.slice(shell.indexOf("function attachPluginListDrag"), shell.indexOf("// 横向工具区", shell.indexOf("function attachPluginListDrag")));

assert.ok(block.length > 1000, "侧栏插件必须有独立的指针拖拽控制器");
// v0.197.0：拖动项就是原件自己 —— 不克隆副本、不挂到 body（旧写法「原位留空槽 +
// body 上的克隆项跟手」两份配色一样，看上去就是两个一模一样的条目）。
// 模型对齐 tauri-shortcut-launcher 的子目录上下拖动：原件写 transform 跟手、
// 其余项各自让位、松手才落地 DOM。
assert.doesNotMatch(block, /cloneNode|body\.append\(|document\.body\.append/, "不许再克隆跟手副本或往 body 上挂浮层");
assert.doesNotMatch(block, /plugin-nav-ghost/, "浮起副本的类名必须整段删除");
assert.match(block, /st\.card\.style\.transform = `translate3d\(/, "跟手位移必须写在原件自己身上");
assert.match(block, /node\.style\.transform = px \? `translate3d\(0, \$\{px\}px, 0\)` : ""/, "其余插件项必须各自让出一格");
assert.match(block, /const step = st\.step \/ st\.scale;/, "让位位移必须按界面缩放换算");
assert.match(block, /requestAnimationFrame\(\(\) => frame\(st\)\)/, "拖拽落点更新必须合并至动画帧");
assert.match(block, /const mids = st\.peers\.map\(/, "每帧必须按最新指针位置计算槽位");
assert.match(block, /st\.tops\.get\(node\) \?\? list\.getBoundingClientRect\(\)\.top/, "落点判定必须用未位移的位置缓存（否则让位位移会喂回判定）");
assert.match(block, /st\.drift = \(list\.getBoundingClientRect\(\)\.top - st\.listTop\)/, "祖先滚动必须按漂移量补偿");
assert.match(block, /list\.insertBefore\(st\.card, st\.peers\[slot\] \?\? null\)/, "松手才把 DOM 顺序落地");
assert.doesNotMatch(block.slice(block.indexOf("const frame ="), block.indexOf("const finish =")), /insertBefore/, "拖动中不许重排 DOM");
assert.match(block, /if \(!reducedMotion\(\) && typeof st\.card\.animate === "function"/, "减少动效时必须跳过落位动画");
assert.match(block, /Math\.hypot\(dx, dy\) >= 4/, "鼠标移动阈值缺失");
assert.match(block, /setTimeout\(\(\) => \{ if \(pd\?\.card === card && !pd\.active\) begin\(pd\); \}, 240\)/, "触屏长按阈值缺失");
assert.match(block, /event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/, "必须支持 Alt+↑/↓ 键盘排序");
// v0.102 颜色分组：拖拽单位从整列 .plug-list 变成一段一段的 .plug-seg（每组一次），
// 段内仍然是「等高连续兄弟」，所以落点推演那套几何一行没改。
// v0.152.0：置顶段与颜色组共用同一套落点容器，只是松手后写哪张表不同
//（常规段 → pluginOrder，置顶段 → pinnedPlugins）。
assert.match(shell, /attachPluginListDrag\(seg, \(\) => \(pinned \? savePinnedOrder\(readIds\(\)\) : saveSegmentOrder\(readIds\(\)\)\)\)/,
  "拖拽必须按段挂载：一个颜色组、一段未分组插件、一段置顶插件各挂一次");
assert.match(shell, /seg\.querySelectorAll\(":scope > button\[data-plugin-id\]"\)/,
  "段容器只能把插件按钮作为直接子节点，中间不许插组头");
assert.match(shell, /settings\.pluginOrder = full\.map\(\(id\) => \(slots\.has\(id\) \? ids\[at\+\+\] : id\)\)/,
  "松手后必须按实时 DOM 顺序回填该段并持久化 pluginOrder");
assert.match(shell, /collapsed \? null : plugSegNode\(views\)/,
  "组头必须挂在拖拽容器外，收起时整段成员不渲染");
// 颜色卡片（.nav .plug-group）是 overflow: hidden，原件被拖出卡片边界会被裁掉：
// 拖动期间必须临时放开这条链上的裁切，且绝不碰 .nav 滚动容器。
assert.match(block, /unclip\(st\)/, "被拖出颜色卡片时必须临时放开裁切");
assert.match(block, /st\.unclipped\.push\(\[node, node\.style\.overflow\]\)/, "放开的裁切必须记录原值以便还原");
assert.match(block, /if \(node\.classList\?\.contains\("nav"\)\) break/, "绝不能放开 .nav 滚动容器的裁切");
assert.match(block, /reclip\(st\)/, "松手必须把裁切原样还回去");
assert.match(css, /\.nav \.plug-seg > button\.nav-dragging\s*\{[^}]*position: relative;[^}]*box-shadow: 0 10px 26px/s, "被拖项必须自己浮在列表之上");
assert.match(css, /\.plug-seg\.plugin-drag-live > button\[data-plugin-id\]\s*\{[^}]*transition: transform 140ms/s, "让位项必须有位移动画");
assert.match(css, /\.plug-seg\.plugin-drag-live > button\.nav-dragging\s*\{\s*transition: none; \}/, "被拖项必须排除在让位过渡之外，否则跟手变迟滞");
assert.match(css, /\.nav \.plug-seg > button\.nav-dragging > \.nav-actions\s*\{[^}]*opacity: 0;/s, "浮起期间必须收掉按钮内部的操作条");
assert.doesNotMatch(css, /\.plugin-nav-ghost\s*\{/, "跟手副本的样式规则必须整段删除");

console.log("PASS: 侧栏插件拖拽是原件自己浮起 / 每帧落点 / 让位一格 / 松手落地 / 键盘与 reduced-motion");
