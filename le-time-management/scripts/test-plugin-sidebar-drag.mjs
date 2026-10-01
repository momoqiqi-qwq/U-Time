import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = fs.readFileSync(path.join(here, "..", "src", "shell.js"), "utf8");
const css = fs.readFileSync(path.join(here, "..", "src", "styles.css"), "utf8");
const block = shell.slice(shell.indexOf("function attachPluginListDrag"), shell.indexOf("// 横向工具区", shell.indexOf("function attachPluginListDrag")));

assert.ok(block.length > 1000, "侧栏插件必须有独立的指针拖拽控制器");
assert.match(block, /requestAnimationFrame\(\(\) => frame\(st\)\)/, "拖拽落点更新必须合并至动画帧");
assert.match(block, /const slot = computeSlot\(st, st\.y\)/, "每帧必须按最新指针位置计算槽位");
assert.match(block, /list\.insertBefore\(st\.card, peers\[slot\] \?\? null\)/, "拖动项必须留在普通流中形成实时空槽");
assert.match(block, /node\.animate\(\[\{ transform: `translateY\(\$\{dy\}px\)` \}/, "其余插件项必须各自用 FLIP 追赶位置");
assert.match(block, /classList\.add\("plugin-nav-ghost"\)/, "拖动项必须有脱离列表流的浮起副本");
assert.match(block, /if \(reducedMotion\(\)\) return/, "减少动效时必须跳过装饰性让位动画");
assert.match(block, /Math\.hypot\(dx, dy\) >= 4/, "鼠标移动阈值缺失");
assert.match(block, /setTimeout\(\(\) => \{ if \(pd\?\.card === card && !pd\.active\) begin\(pd\); \}, 240\)/, "触屏长按阈值缺失");
assert.match(block, /event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/, "必须支持 Alt+↑/↓ 键盘排序");
// v0.102 颜色分组：拖拽单位从整列 .plug-list 变成一段一段的 .plug-seg（每组一次），
// 段内仍然是「等高连续兄弟」，所以落点推演那套几何一行没改。
assert.match(shell, /attachPluginListDrag\(seg, \(\) => saveSegmentOrder\(/,
  "拖拽必须按段挂载：一个颜色组或一段未分组插件各挂一次");
assert.match(shell, /seg\.querySelectorAll\(":scope > button\[data-plugin-id\]"\)/,
  "段容器只能把插件按钮作为直接子节点，中间不许插组头");
assert.match(shell, /settings\.pluginOrder = full\.map\(\(id\) => \(slots\.has\(id\) \? ids\[at\+\+\] : id\)\)/,
  "松手后必须按实时 DOM 顺序回填该段并持久化 pluginOrder");
assert.match(shell, /collapsed \? null : plugSegNode\(views\)/,
  "组头必须挂在拖拽容器外，收起时整段成员不渲染");
assert.match(css, /\.nav \.plug-seg > button\.nav-dragging\s*\{[^}]*outline:/s, "原位置必须显示明确空槽");
assert.match(css, /\.plugin-nav-ghost\s*\{[^}]*position: fixed/s, "浮起插件项必须 fixed 跟随指针");

console.log("PASS: 侧栏插件拖拽具备浮起项 / 每帧落点 / 明确空槽 / 独立 FLIP 追赶 / 键盘与 reduced-motion");

