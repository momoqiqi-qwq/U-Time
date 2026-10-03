import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");
const cssRaw = read("../src/styles.css");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

const EDGE_VAR = { top: "--sat", right: "--sar", bottom: "--sab", left: "--sal" };
const VAR_EDGE = { "--sat": "top", "--sar": "right", "--sab": "bottom", "--sal": "left" };

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out.sort();
}

const appRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginFiles = jsFiles(path.join(appRoot, "public", "plugins"));
assert.ok(pluginFiles.length >= 15, `必须扫到全部插件 JS，当前只有 ${pluginFiles.length} 个`);

const rel = (file) => path.relative(appRoot, file).replace(/\\/g, "/");

/** 单趟栈式解析：返回文件里每一个 `{ …}` 块（含 JS 代码块，不区分）。
 *  CSS 就嵌在 JS 的模板串里，花括号成对，所以这一份解析两种语言都够用。 */
function parseBlocks(text) {
  const stack = [];
  const blocks = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}" && stack.length) {
      const open = stack.pop();
      const head = text.slice(Math.max(text.lastIndexOf("}", open - 1), text.lastIndexOf("{", open - 1)) + 1, open);
      blocks.push({ open, close: i, selector: (head.split("\n").pop() || "").trim(), body: text.slice(open + 1, i) });
    }
  }
  return blocks;
}

/** index 所处的那个块（跨度最小者 = 最内层）。 */
function ruleAt(blocks, index) {
  let best = null;
  for (const b of blocks) {
    if (b.open > index || b.close < index) continue;
    if (!best || b.close - b.open < best.close - best.open) best = b;
  }
  return best;
}

// ── A. 裸 env() 禁令：铁律四的插件版 ─────────────────────────────────────────
// Android WebView 里 env(safe-area-inset-*) 恒为 0，插件与宿主同理。宿主用
// var(--sat, env(…)) 双路（原生注入 + 桌面/iOS 兜底），插件没有别的取值通道，
// 所以「只写 env()」= 在 APK 上等于没写。
const bareEnv = [];
for (const file of pluginFiles) {
  const text = readProductSource(file, "utf8");
  for (const m of text.matchAll(/env\(safe-area-inset-(top|right|bottom|left)/g)) {
    const before = text.slice(Math.max(0, m.index - 28), m.index);
    if (!new RegExp(`var\\(${EDGE_VAR[m[1]]},\\s*$`).test(before)) bareEnv.push(`${rel(file)} → ${m[0]}`);
  }
}
assert.deepEqual(bareEnv, [], `插件 CSS 里出现了裸 env(safe-area-inset-*)，必须写成 var(--sat/--sab/--sal/--sar, env(…)) 双路：\n${bareEnv.join("\n")}`);

// ── B. 单一负责人：非浮层规则不许再垫一遍 ───────────────────────────────────
// 宿主已经把四条边垫在 .view 上，插件再对自己的页面包一层 = v0.38.2「安全区被
// 算了两次」的同族 bug（桌面端插件页底部曾因此凭空多出 86px 纯空白）。
// 例外只有 position:fixed：它的包含块是 .view 的 padding box，宿主 padding 拦不住它。
// 「是不是浮层」按选择器认：媒体查询里的覆盖规则只重写部分属性、不重复 position:fixed。
const doublePadded = [];
for (const file of pluginFiles) {
  const text = readProductSource(file, "utf8");
  const blocks = parseBlocks(text);
  const fixed = new Set(blocks.filter((b) => b.body.includes("position:fixed") && b.selector).map((b) => b.selector));
  for (const m of text.matchAll(/var\((--s(?:at|ab|al|ar))\s*,/g)) {
    const rule = ruleAt(blocks, m.index);
    if (rule && fixed.has(rule.selector)) continue;
    doublePadded.push(`${rel(file)} → ${m[1]} 所在选择器「${rule ? rule.selector : "?"}」不是 fixed 浮层：\n    ${rule ? rule.body.trim().slice(0, 90) : ""}`);
  }
}
assert.deepEqual(doublePadded, [], "插件页内容的安全区已由宿主 .view 负责，插件不得再垫第二遍：\n" + doublePadded.join("\n"));

/** 下面四条扫描都是纯函数（输入一份插件 JS 文本 → 违规清单），
 *  既好复用它处的循环，也方便用一段故意写错的样本来自检「规则还咬得动人」。 */

// ① 有 fixed 浮层却一次都没提宿主变量（连"知道有安全区"都算不上）
function scanIgnorantOverlay(text) {
  if (!text.includes("position:fixed")) return [];
  const aware = /var\(--s(?:at|ab|al|ar)\s*[,)]/.test(text) || /["'`]--s(?:at|ab|al|ar)["'`]/.test(text);
  return aware ? [] : ["有 position:fixed 浮层，却完全没提宿主安全区变量"];
}

// ② 逐条边把关：fixed 面板钉了哪条边，就得让开哪条边
// 覆盖 ①拦不住的情况：文件里确实提过宿主变量，但某一条边漏了 —— 实测课表个性化抽屉
// 就是只让了底、没让左右，横屏挖孔压在滑杆上。
// 按选择器把同一浮层的所有规则并起来看（媒体查询只重写部分属性，不重复 position:fixed）。
// 整屏背板豁免：只有 inset:0、不单独钉边、也不靠内边距挤内容 —— 盖住安全区是对的。
function scanFixedEdges(text) {
  if (!text.includes("position:fixed")) return [];
  const union = new Map();
  for (const b of parseBlocks(text)) {
    if (!b.selector || b.selector.length > 70 || /function|=>|[=;]/.test(b.selector)) continue;
    union.set(b.selector, `${union.get(b.selector) || ""}${b.body}`);
  }
  const out = [];
  for (const [sel, body] of union) {
    if (!body.includes("position:fixed")) continue;
    const edges = Object.keys(EDGE_VAR).filter((e) => new RegExp(`(?:^|[;{\\s])${e}\\s*:`).test(body));
    const fullInset = /inset:\s*(?!0[\s;}])[^;}]+/.test(body);
    if (!edges.length && !fullInset) continue;
    if (!edges.length && /inset:0/.test(body) && !/padding[^;}]*[1-9vcalc]/.test(body)) continue;
    const need = fullInset ? Object.keys(EDGE_VAR) : edges;
    for (const e of need) if (!body.includes(EDGE_VAR[e])) out.push(`${sel} 钉了${e}边却没让开 ${EDGE_VAR[e]}`);
  }
  return out;
}

// ③ 视口尺寸不等于可视区：innerWidth/innerHeight 从屏幕角量，夹取必须减掉安全区
function scanViewportMath(text) {
  if (!/inner(?:Width|Height)/.test(text)) return [];
  const aware = /["'`]--s(?:at|ab|al|ar)["'`]|var\(--s(?:at|ab|al|ar)/.test(text);
  return aware ? [] : ["用 innerWidth/innerHeight 定位或夹取，却没读安全区变量"];
}

// ④ 挂进 document.body 的浮层完全逃出宿主 .view，四边都得自己让
function scanBodyMounted(text) {
  if (!/document\.body\.(?:append|prepend|appendChild|insertAdjacent)/.test(text)) return [];
  const miss = Object.values(EDGE_VAR).filter((v) => !text.includes(v));
  return miss.length ? [`挂进 document.body 却缺 ${miss.join(" / ")}`] : [];
}

const scans = [["没提宿主变量的浮层", scanIgnorantOverlay], ["钉边未让开", scanFixedEdges],
  ["视口尺寸当可视区", scanViewportMath], ["body 挂载缺边", scanBodyMounted]];
const flagged = [];
for (const file of pluginFiles) {
  const text = readProductSource(file, "utf8");
  for (const [name, scan] of scans) for (const hit of scan(text)) flagged.push(`${name}：${rel(file)} → ${hit}`);
}
// ── C. ① 号规则的现网结果 ────────────────────────────────────────────────────
assert.deepEqual(flagged.filter((s) => s.startsWith("没提宿主变量")), [],
  "有 position:fixed 浮层却完全没提宿主安全区变量：\n" + flagged.join("\n"));

// ── D. 已修好的浮层逐条钉住（照 test-android-layout 对 .wc-web-panel 的做法）──
// 断言前先把那一条规则摘出来：整份文件当 actual 打印会把测试输出淹掉。
const ruleLine = (text, sel) => {
  const m = text.match(new RegExp(`\\${sel}\\{[^}]*\\}`));
  assert.ok(m, `插件 CSS 里找不到规则 ${sel}{…}`);
  return m[0];
};

const gxMask = ruleLine(read("../public/plugins/gx-news/main.js"), ".gx-mask");
for (const v of ["--sat", "--sar", "--sab", "--sal"]) {
  assert.ok(new RegExp(`padding:[^;]*calc\\(16px \\+ var\\(${v}`).test(gxMask),
    `🔴 gx-news 遮罩的四边内边距必须是「16px + ${v}」，缺了它就压到${v === "--sat" ? "状态栏" : v === "--sab" ? "导航栏" : "横屏挖孔"}上`);
}

const sn = read("../public/plugins/school-notice/main.js");
assert.match(sn, /getComputedStyle\(document\.documentElement\)\.getPropertyValue/,
  "🔴 school-notice 右键菜单按视口坐标定位，只能从宿主注入的变量读回安全区");
assert.match(sn, /x: Math\.max\(8 \+ sal,[\s\S]{0,80}- sar - W/, "🔴 菜单 x 夹取必须让开左右安全区（横屏挖孔）");
assert.match(sn, /y: Math\.max\(8 \+ sat,[\s\S]{0,80}- sab - H/, "🔴 菜单 y 夹取必须让开状态栏与导航栏");

// ── E. 宿主侧的四条边必须齐全，且 .plugview 不参与 ──────────────────────────
// 🔴 四条边全部要 ÷ --ui-scale（v0.105.1）：界面缩放是 documentElement 上的 CSS zoom，
// 布局长度会被乘掉，而状态栏 / 导航栏 / 挖孔是原生浮层、物理尺寸恒定。左右这一条
// 一点大让位都没有，不除就是「横屏挖孔只让开 0.8×」。
const viewLeftRight = css.match(/\.view\s*\{[^}]*padding-left:\s*calc\(\s*var\(--sal,[^}]*padding-right:\s*calc\(\s*var\(--sar[^}]*\}/);
assert.ok(viewLeftRight, "🔴 宿主必须给 .view 垫左右安全区（--sal/--sar），这是插件页唯一的横向负责人");
assert.match(viewLeftRight[0], /padding-left:\s*calc\(\s*var\(--sal,[^)]*\)\)\s*\/\s*var\(--ui-scale,\s*1\)/,
  "🔴 .view 的 --sal 必须 ÷ --ui-scale（zoom 会把安全区一起缩掉）");
assert.match(viewLeftRight[0], /padding-right:\s*calc\(\s*var\(--sar,[^)]*\)\)\s*\/\s*var\(--ui-scale,\s*1\)/,
  "🔴 .view 的 --sar 必须 ÷ --ui-scale");
assert.ok(cssRaw.indexOf("@media") > cssRaw.indexOf("padding-left: calc(var(--sal"),
  "左右安全区必须写在任何媒体块之外：横屏挖孔与侧边导航栏在宽屏上也会出现");
assert.ok(!/\.plugview\s*\{[^}]*--s(?:at|ab|al|ar)/.test(css),
  ".plugview 不能再引用安全区变量，会和 .view 上的那份叠加成双重计算");
assert.match(css, /\.app\.rail-hidden \.view\s*\{[^}]*padding-top:\s*calc\(\(2px \+ var\(--sat[^}]*\)\s*\/\s*var\(--ui-scale,\s*1\)/,
  "沉浸式插件页的上下安全区由 .view 负责，不能因为收掉留白一起被删、也不许漏掉 ÷ --ui-scale");

// ── F. ②③④ 号规则在现网上的结果 ─────────────────────────────────────────────
const rest = flagged.filter((s) => !s.startsWith("没提宿主变量"));
assert.deepEqual(rest, [], "插件浮层没有让开它钉住的安全区：\n" + rest.join("\n"));

// ── G. 规则自检：故意写错的样本必须红、合规写法必须绿 ────────────────────────
// 四条扫描都是纯字符串判定，很容易被后来的重构改成"永远绿"。这两段样本是给
// 规则本身上的锁 —— 规则失效时这里先红，而不是等下一个插件踩上去。
const badSample = `.a{position:fixed;inset:0;z-index:5}
.b{position:fixed;left:0;right:0;top:0;bottom:0;padding:12px}
document.body.append(node);
const w = innerWidth - 12;`;
const goodSample = `.c{position:fixed;inset:0;padding:calc(16px + var(--sat,env(safe-area-inset-top,0px))) calc(16px + var(--sar,env(safe-area-inset-right,0px))) calc(16px + var(--sab,env(safe-area-inset-bottom,0px))) calc(16px + var(--sal,env(safe-area-inset-left,0px)))}
.d{position:fixed;left:0;right:0;bottom:0;padding-bottom:var(--sab,env(safe-area-inset-bottom,0px));padding-inline:var(--sal,env(safe-area-inset-left,0px)) var(--sar,env(safe-area-inset-right,0px))}
document.body.append(node);
const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
const lim = innerWidth - px("--sar");`;
for (const [name, scan] of scans) {
  assert.ok(scan(badSample).length, `自检失败：「${name}」对故意写错的样本都不红了 —— 这条规则已经失效`);
  assert.deepEqual(scan(goodSample), [], `自检失败：「${name}」把合规写法也判成红：\n${scan(goodSample).join("\n")}`);
}

console.log(`PASS: 插件安全区 —— ${pluginFiles.length} 个插件 JS 无裸 env()、无重复垫、fixed 浮层四边让开、宿主 .view 四条边齐备（四条规则自检通过）`);
