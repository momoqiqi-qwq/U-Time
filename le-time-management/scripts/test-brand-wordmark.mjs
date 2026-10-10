import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 左上角品牌字标回归守卫（v0.178.0，v0.183.0 扩到「字标 + 下方装饰线」）。
 *
 * 用户需求原文（v0.178.0）：「请将应用左上角的名称和图标修改为仅保留名称，名称的字体格式参照上述样式。」
 * —— 图标（`.mark` 那枚四色圆环）与重复一行的副标题 `<small>U-TIME</small>` 一起删掉，
 * 只剩一颗写着 U-Time 的 `<b>`，字体换成 Nephele Workshop 那套哥特黑体 + 粉紫→珊瑚橙横向渐变。
 *
 * 用户需求原文（v0.183.0）：「U-Time Work 改成 U Time WorkSpace，然后在下面添加一根像上面代码
 * 那样画出来的线。」—— 字标改名 + 名称**下方**补一条哥特装饰线（`.brand-rule`，DOM 由 shell.js
 * 的 brandRule() 建）。名字长了 42%，所以基础字号从 28px 降到 20px、过渡带降到 18px ——
 * 这是拿无头 Chrome 在真应用里量出来的（1280 视口：字标 159.03px / 可用 166px；
 * 1050 视口：143.13px / 可用 146px），不是估的。
 *
 * 这条测试守的是「下次谁顺手改回去」的六类事故：
 *   ① 图标 / 副标题又长回来（DOM 与死 CSS 两头查）；
 *   ② 随包字体丢了、或 @font-face 指向了不存在的文件（字标静默退化成 Georgia 衬线）；
 *   ③ 渐变字的实现被写坏 —— 少一条透明字色、改用 `text-shadow` 发光（阴影画在背景之上会把
 *      渐变整个盖住）、或某条媒体查询里又给 `.brand b` 写回 `color: var(--ink)`；
 *   ④ 浅色模式直接沿用参考图那组粉紫→珊瑚橙 —— 那组颜色压在浅色面板上只有 2.1~2.5:1，
 *      等于糊在白纸上。所以浅色必须另有一套「色相相同、压暗到 ≥4:1」的四档；
 *   ⑤ 字号被改回 28px —— 那是 `U-Time Work` 时代的尺寸，新名字会顶出侧栏；
 *   ⑥ 装饰线：四档渐变跟字标脱钩、`gradientUnits` 退回 objectBoundingBox（左右两条主线各拿
 *      一份完整渐变，画面从中间断开）、柔光在浅色下也开着（浅底上只会发灰）、
 *      或者宽度写法让 160 宽的 viewBox 被横拉变形。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { THEMES } from "../src/themeProfiles.js";

const require = createRequire(import.meta.url);
const { parsePalettes, deriveDark, contrastRatio, hexToRgb } = require("../../tools/lib/theme-tokens.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const read = (p) => readProductSource(path.join(appRoot, p), "utf8");

const shellSrc = read("src/shell.js");
const stylesCss = read("src/styles.css");

/* ── 1. DOM：品牌区只剩名称 ── */
const brandBody = /el\("div",\s*\{\s*class:\s*"brand"\s*\},([\s\S]*?)\),\s*nav,/.exec(shellSrc)?.[1];
assert.ok(brandBody, "在 shell.js 里找不到 rail 内的 .brand 品牌区（选择器或结构变了？）");
assert.match(brandBody, /el\("b",\s*\{\s*\}\s*,\s*"U Time WorkSpace"\)/, "品牌区必须有一颗写着 U Time WorkSpace 的 <b>（v0.183.0 改的名）");
assert.doesNotMatch(brandBody, /el\("b",\s*\{\s*\}\s*,\s*"U-Time Work"\)/, "旧文案 U-Time Work 不许留在品牌区（改名是 v0.183.0 的用户需求）");
assert.doesNotMatch(brandBody, /el\("b",\s*\{\s*\}\s*,\s*"U-Time"\)/, "旧文案 U-Time 不许留在品牌区（v0.181.0 的历史值）");
assert.match(brandBody, /\bbrandRule\(\)/, "字标下方必须有那条哥特装饰线（shell.js 的 brandRule()）");
assert.doesNotMatch(brandBody, /class:\s*"mark"/, "品牌区的图标 .mark 已按需求删除，不许再长回来");
assert.doesNotMatch(brandBody, /el\("small"/, "品牌区的副标题 <small>U-TIME</small> 已删除（名称已经写在字标里）");

/* ── 2. 样式表里不留死代码 ── */
assert.doesNotMatch(stylesCss, /\.brand\s+\.mark/, "styles.css 还留着 .brand .mark 规则（图标已删，这是死代码）");
assert.doesNotMatch(stylesCss, /\.brand\s+small/, "styles.css 还留着 .brand small 规则（副标题已删，这是死代码）");

/* ── 3. 字体：随包 woff2 真的在，@font-face 指向它 ── */
const face = /@font-face\s*\{[^}]*font-family:\s*"UnifrakturCook"[^}]*\}/.exec(stylesCss)?.[0];
assert.ok(face, "styles.css 缺少 UnifrakturCook 的 @font-face 声明");
const fontUrl = (/url\(([^)]+)\)/.exec(face)?.[1] || "").replace(/["']/g, "").trim();
assert.equal(fontUrl, "/fonts/UnifrakturCook-Bold.woff2", "@font-face 必须指向随包的 /fonts/UnifrakturCook-Bold.woff2");
assert.match(face, /font-display:\s*swap/, "@font-face 要给 font-display（否则首帧字标可能整块缺席）");

const fontFile = path.join(appRoot, "public", "fonts", "UnifrakturCook-Bold.woff2");
assert.ok(fs.existsSync(fontFile), `随包字体文件不存在：${path.relative(appRoot, fontFile)}`);
assert.equal(fs.readFileSync(fontFile).subarray(0, 4).toString("latin1"), "wOF2", "字体文件不是真的 woff2（魔数不是 wOF2）");
const ofl = path.join(appRoot, "public", "fonts", "OFL.txt");
assert.ok(fs.existsSync(ofl), "随包字体必须带 OFL 许可文本 public/fonts/OFL.txt");
assert.match(fs.readFileSync(ofl, "utf8"), /SIL OPEN FONT LICENSE/, "OFL.txt 内容不是 SIL 开源字体许可");
const notices = read("public/OPEN_SOURCE_NOTICES.md");
assert.match(notices, /UnifrakturCook/, "第三方来源说明里必须补上这套字体的署名与许可");

/* ── 4. 渐变字的写法 ── */
const rules = [...stylesCss.matchAll(/\.brand b\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(rules.length >= 2, "应至少有两处 .brand b 规则（浅色基础 + 深色覆盖）");
const lightRule = rules[0];
assert.match(lightRule, /font-family:[^;]*"UnifrakturCook"/, "字标必须优先用随包的 UnifrakturCook");
assert.match(lightRule, /-webkit-background-clip:\s*text/, "渐变字要 -webkit-background-clip: text");
assert.match(lightRule, /(?:^|;|\s)background-clip:\s*text/, "渐变字要 background-clip: text（标准属性）");
assert.match(lightRule, /-webkit-text-fill-color:\s*transparent/, "少这条时字会被填成实心色，渐变只剩描边");
assert.match(lightRule, /(?:^|;)\s*color:\s*transparent/, "`color` 也要透明（只写 -webkit-text-fill-color 的路径会漏）");
assert.match(lightRule, /white-space:\s*nowrap/, "字标是字标，不许折行");
assert.match(lightRule, /display:\s*inline-block/, "字标要 inline-block：盒子按字标自己算，背景才裁得住字形");
/* 字号是拿真应用量出来的（见文件头）：U Time WorkSpace 在 28px 下宽 222.64px，
   默认 compact 侧栏（--rail-w: 204px）里 .brand 可用宽度只有 166px。20px → 159.03px。 */
assert.match(
  lightRule,
  /font-size:\s*calc\(20px \* var\(--ui-text-scale\)\)/,
  "桌面字号必须是 calc(20px * var(--ui-text-scale))（v0.183.0 由 28px 降下来），跟界面文字缩放走",
);
// 过渡带（901~1100px，侧栏被压到 176px）另有一档字号：18px 实测 143.13px ≤ 可用 146px
const narrowRules = rules.filter((body) => /font-size:\s*calc\(18px \* var\(--ui-text-scale\)\)/.test(body));
assert.equal(narrowRules.length, 1, "过渡带必须有一条 calc(18px * var(--ui-text-scale)) 的字号覆盖（19px 会溢出 5.06px）");
// 字形冒头那截没有背景可裁（background-clip: text 的绘制区止于盒子），行高与内边距是必需余量
assert.match(lightRule, /line-height:\s*1\.3[0-9]/, "行高要留余量，黑体上下冒头的字形才不会被裁掉");
assert.match(lightRule, /padding:\s*0\s+\.1em/, "左右内边距要留余量，字形冒头那截同样会被裁");

// 发光只能用 filter: drop-shadow —— text-shadow 画在元素背景之上，会把渐变整个盖住
for (const body of rules) {
  assert.doesNotMatch(body, /text-shadow/, "字标不许用 text-shadow（会盖住渐变），发光请用 filter: drop-shadow()");
}
// 任何一条 .brand b 规则里都不许把字色写回实心（旧实现是 color: var(--ink)）
for (const body of rules) {
  const declared = [...body.matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)].map((m) => m[1].trim());
  for (const value of declared) {
    assert.equal(value, "transparent", `.brand b 的字色只能是 transparent，实际是 ${value}（渐变会被盖掉）`);
  }
}

/* ── 5. 四档渐变色 + 逐主题实算对比度 ── */
const stopsOf = (rule) => [...rule.matchAll(/(#[0-9A-Fa-f]{6})\s+[\d.]+%/g)].map((m) => m[1].toUpperCase());
const lightStops = stopsOf(lightRule);
assert.equal(lightStops.length, 4, `浅色渐变要四档颜色，实际 ${lightStops.length} 档：${lightStops.join(" ")}`);
assert.deepEqual(
  lightStops,
  ["#B62394", "#C61557", "#C32A10", "#9C5211"],
  "浅色四档是「保持参考图色相与饱和度、压暗到最不利的浅色侧栏底也够用」实算出来的，改色请重算对比度",
);

const darkRule = /^:root\[data-theme-mode="dark"\]\s*\.brand b\s*\{([^}]*)\}/m.exec(stylesCss)?.[1];
assert.ok(darkRule, "缺少深色覆盖 :root[data-theme-mode=\"dark\"] .brand b（写 [data-theme=\"night\"] 会漏掉跟随系统变深）");
const darkStops = stopsOf(darkRule);
assert.deepEqual(
  darkStops,
  ["#E781CF", "#F17EA9", "#F48A78", "#EDA15E"],
  "深色四档就是参考图原色（粉紫→珊瑚橙），这是用户指定的样式",
);
assert.match(darkRule, /filter:\s*drop-shadow\(/, "深色下要有同色系柔光（filter: drop-shadow，不是 text-shadow）");

/* ── 6. 字标下方那条哥特装饰线（v0.183.0） ── */
const ruleFn = /function brandRule\(\)\s*\{[\s\S]*?<g class="br-glow">[\s\S]*?\}`/.exec(shellSrc)?.[0];
assert.ok(ruleFn, "shell.js 里找不到 brandRule() 的 SVG 主体（装饰线的唯一创建口）");
assert.match(ruleFn, /createElementNS\(NS, "svg"\)/, "装饰线必须是内联 SVG（纯 CSS 画不出中间的哥特花纹）");
assert.match(ruleFn, /setAttribute\("viewBox", "0 0 160 14"\)/,
  "viewBox 必须是 0 0 160 14 —— 与桌面侧栏里字标的实际宽度（159.03px）几乎 1:1，横拉才会走形");
assert.match(ruleFn, /setAttribute\("preserveAspectRatio", "xMidYMid meet"\)/, "要显式写 meet：写 none 会把线连同尖头与卷草一起横拉");
assert.match(ruleFn, /gradientUnits="userSpaceOnUse"/,
  "渐变必须是 userSpaceOnUse：默认的 objectBoundingBox 会让左右两条主线**各拿一份完整渐变**，画面从中间断开");
for (const cls of ["br-line", "br-tip", "br-scroll", "br-glow"]) {
  assert.match(ruleFn, new RegExp(`class="${cls}"`), `SVG 里缺少 .${cls} 那一组（形状被删了？）`);
}
for (const i of [1, 2, 3, 4]) {
  assert.match(ruleFn, new RegExp(`class="bg-${i}"`), `渐变少了第 ${i} 档 stop（class="bg-${i}"）`);
}

const brandBase = /^\.brand\s*\{([^}]*)\}/m.exec(stylesCss)?.[1];
assert.ok(brandBase, "找不到 .brand 的基础规则");
assert.match(brandBase, /flex-direction:\s*column/, "品牌区必须改成竖排：装饰线要落在字标**下方**");

const ruleCss = /^\.brand-rule\s*\{([^}]*)\}/m.exec(stylesCss)?.[1];
assert.ok(ruleCss, "styles.css 缺少 .brand-rule 的基础规则");
assert.match(ruleCss, /width:\s*min\(100%,\s*160px\)/,
  "线宽必须是 min(100%, 160px)：与 viewBox 等宽 ⇒ meet 的缩放比恒为 1，也不会被横向拉伸");
assert.match(ruleCss, /height:\s*14px/, "线高必须是 14px（viewBox 的高度）");
assert.match(ruleCss, /--brand-rule-glow-opacity:\s*0/, "浅色下柔光必须关掉（浅底上叠同色光只会发灰）");

const ruleDark = /:root\[data-theme-mode="dark"\]\s*\.brand-rule\s*\{([^}]*)\}/.exec(stylesCss)?.[1];
assert.ok(ruleDark, '缺少深色的 .brand-rule 覆盖（写 [data-theme="night"] 会漏掉「跟随系统变深」）');
const glowValue = Number(/--brand-rule-glow-opacity:\s*([\d.]+)/.exec(ruleDark)?.[1] || "0");
assert.ok(glowValue > 0, "深色下柔光要真的开着（--brand-rule-glow-opacity > 0）");

const varsOf = (body) => [1, 2, 3, 4].map((i) =>
  (new RegExp(`--brand-rule-${i}:\\s*(#[0-9A-Fa-f]{6})`).exec(body)?.[1] || "").toUpperCase());
assert.deepEqual(varsOf(ruleCss), lightStops,
  "装饰线的浅色四档必须与字标同一套（同一份对比度预算；改一处就要两处一起重算）");
assert.deepEqual(varsOf(ruleDark), darkStops,
  "装饰线的深色四档必须与字标同一套（参考图原色）");

/** 与 CSS 的 color-mix(in srgb, A p%, B) 同算法：sRGB 通道线性插值。 */
const blend = (top, bottom, p) => {
  const A = hexToRgb(top), B = hexToRgb(bottom);
  if (!A || !B) return null;
  const c = (k) => Math.round(A[k] * p + B[k] * (1 - p));
  return `#${["r", "g", "b"].map((k) => c(k).toString(16).padStart(2, "0")).join("")}`;
};

/* 桌面侧栏「白面板」形态的底色 = color-mix(in srgb, var(--panel) 95%, var(--paper))
   （styles.css 的 ≥901px 那条 .rail）。字标就压在这上面，所以拿它算，而不是拿 --bg。 */
const railBackground = (tokens) => blend(tokens["--panel"], tokens["--paper"] || tokens["--panel"], 0.95) || tokens["--panel"];

/* 浅色侧栏其实有**两种**底色，字标两种都会压上去：
   ① Nephele 风格界面关掉时 = color-mix(in srgb, var(--panel) 95%, var(--paper))，接近纯白；
   ② 默认开着时 = `--nephele-rail`（styles/nephele-settings.css，浅色 #e4d7f4 / 深色 #342350）
      那层 0.9 透明度的淡紫毛玻璃，压在 nephele-background.css 的云层之上 ——
      实测合成色 #E0D0F0 上下。**它比纯白暗**，对深色字更不利，所以它才是浅色档真正的约束；
      云层是若干径向渐变叠出来的，这里取比实测再暗一档的理论上界当保险。
   深色那边同理，实测合成色 #362651（毛玻璃本身 90% 不透明，所以主题只影响 10%）。 */
const NEPHELE_GLASS_LIGHT = "#DCC6E4";
const NEPHELE_GLASS_DARK = "#362651";
const LIGHT_MIN_PANEL = 4.0;
const LIGHT_MIN_GLASS = 3.5;
const DARK_MIN = 4.0;

const light = parsePalettes(stylesCss);
const failures = [];
const record = (where, fg, bg, need) => {
  const got = contrastRatio(fg, bg);
  if (got + 0.01 < need) failures.push(`${where} 对比度 ${got.toFixed(2)} < ${need}（${fg} on ${bg}）`);
};

let lightChecked = 0, darkChecked = 0;
for (const theme of THEMES) {
  const tokens = light[theme.id];
  assert.ok(tokens, `styles.css 里找不到主题 ${theme.id} 的色板`);
  // night 是原生深色主题（theme.js 的 resolveTheme 强制 mode:"dark"），永远走深色那组
  if (theme.id !== "night") {
    const plain = railBackground(tokens);
    for (const c of lightStops) record(`${theme.id}(浅色/白面板)`, c, plain, LIGHT_MIN_PANEL);
    for (const c of lightStops) record(`${theme.id}(浅色/毛玻璃)`, c, NEPHELE_GLASS_LIGHT, LIGHT_MIN_GLASS);
    lightChecked++;
  }
  const darkTokens = theme.id === "night" ? tokens : deriveDark(tokens);
  for (const c of darkStops) record(`${theme.id}(深色/面板)`, c, railBackground(darkTokens), DARK_MIN);
  for (const c of darkStops) record(`${theme.id}(深色/毛玻璃)`, c, NEPHELE_GLASS_DARK, DARK_MIN);
  darkChecked++;
}
assert.deepEqual(failures, [], `品牌字标渐变对比度不达标（字与背景不能像）：\n  ${failures.join("\n  ")}`);

console.log(
  `PASS: 品牌字标（U Time WorkSpace + 哥特字 + 渐变 + 下方 160×14 哥特装饰线；` +
  `浅色 ${lightChecked} 套 / 深色 ${darkChecked} 套主题，` +
  `白面板 ≥${LIGHT_MIN_PANEL}:1、Nephele 毛玻璃 ≥${LIGHT_MIN_GLASS}:1、深色 ≥${DARK_MIN}:1）`,
);
