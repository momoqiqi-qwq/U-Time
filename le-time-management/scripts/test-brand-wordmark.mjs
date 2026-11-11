import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 左上角品牌字标回归守卫（v0.178.0，v0.183.0 扩到「字标 + 下方装饰线」，
 * v0.300.0 改为「只显示 U-Time + 一般字形、不再随包字体」）。
 *
 * 用户需求原文（v0.178.0）：「请将应用左上角的名称和图标修改为仅保留名称，名称的字体格式参照上述样式。」
 * —— 图标（`.mark` 那枚四色圆环）与重复一行的副标题 `<small>U-TIME</small>` 一起删掉，
 * 只剩一颗写着 U-Time 的 `<b>`，字体换成 Nephele Workshop 那套哥特黑体 + 粉紫→珊瑚橙横向渐变。
 *
 * v0.300.0 曾把字标整体改成「U-Time + 一般字形」并删掉随包字体；v0.301.0 按用户要求
 * 改成**两种形态并存、设置里切换**（原文：「我叫你在设置里面弄开关，不是删除」）：
 *   gothic（默认）= 哥特体 UnifrakturCook + 文案 `U Time WorkSpace` + 20px + 160px 装饰线
 *   plain         = 系统无衬线粗体 + 文案 `U-Time` + 24px + 128px 装饰线
 * 事实源：brandWordmark.js 的 BRAND_NAME_GOTHIC / BRAND_NAME_PLAIN / BRAND_STYLES，
 * 偏好字段 brandStyle（uiPreferences.js），CSS 靠 :root[data-brand-style="plain"] 分叉。
 *
 * 这条测试守的是「下次谁顺手改回去」的七类事故：
 *   ① 图标 / 副标题又长回来（DOM 与死 CSS 两头查）；
 *   ② 只剩一种形态（删字体 / 删开关 / 两态文案写在两处各说各的）；
 *   ③ 渐变字的实现被写坏 —— 少一条透明字色、改用 `text-shadow` 发光（阴影画在背景之上会把
 *      渐变整个盖住）、或某条媒体查询里又给 `.brand b` 写回 `color: var(--ink)`；
 *   ④ 浅色模式直接沿用参考图那组粉紫→珊瑚橙 —— 那组颜色压在浅色面板上只有 2.1~2.5:1，
 *      等于糊在白纸上。所以浅色必须另有一套「色相相同、压暗到 ≥4:1」的四档；
 *   ⑤ 字号被改回 28px 或又给过渡带加覆盖 —— 20px / 24px 是两态各自按文案量出来的；
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
/* v0.232.0：`brandRule()` 从 shell.js 抽到了 src/brandWordmark.js（刷新蒙版要复用同一条装饰线，
   复制一份必然走形）。装饰线的形状断言改读这个模块；shell.js 那边只查「有没有调它」。 */
const wordmarkSrc = read("src/brandWordmark.js");
const stylesCss = read("src/styles.css");

/* ── 1. DOM：品牌区只剩名称 ── */
const brandBody = /el\("div",\s*\{\s*class:\s*"brand"\s*\},([\s\S]*?)\),\s*nav,/.exec(shellSrc)?.[1];
assert.ok(brandBody, "在 shell.js 里找不到 rail 内的 .brand 品牌区（选择器或结构变了？）");
/* v0.300.0（用户需求「把红框里的 U Time WorkSpace 改成只显示 U-Time，并且是一般字形」）：
   文案改为 U-Time，唯一事实源仍是 brandWordmark.js 的 BRAND_NAME —— shell.js 只引用不写死，
   否则侧栏与刷新蒙版会各说各的。 */
/* v0.301.0：两种形态并存 —— 两套文案都在 brandWordmark.js 里，DOM 只调 brandName()，不许写死。 */
const nameGothic = /export const BRAND_NAME_GOTHIC = "([^"]+)";/.exec(wordmarkSrc)?.[1];
const namePlain = /export const BRAND_NAME_PLAIN = "([^"]+)";/.exec(wordmarkSrc)?.[1];
assert.equal(nameGothic, "U Time WorkSpace", "哥特形态的文案必须是 U Time WorkSpace（原样）");
assert.equal(namePlain, "U-Time", "一般字形态的文案必须是 U-Time");
assert.match(wordmarkSrc, /export function brandName\(/, "brandWordmark.js 必须提供 brandName(style) 统一取文案");
assert.match(wordmarkSrc, /export function syncBrandName\(/, "brandWordmark.js 必须提供 syncBrandName() 给切换开关用");
/* 只改带 .brand-name 的那颗：等待蒙版会把自定义文案（「正在刷新课表…」）塞进同一个 .brand b。 */
assert.match(wordmarkSrc, /querySelectorAll\("\.brand b\.brand-name"\)/,
  "syncBrandName 只能改 .brand b.brand-name —— 无差别改写会把蒙版的自定义文案冲掉");
assert.match(brandBody, /el\("b",\s*\{\s*class:\s*"brand-name"\s*\}\s*,\s*brandName\(\)\)/,
  "品牌区的 <b> 必须带 .brand-name 并调用 brandName()，不许写死文案");
assert.doesNotMatch(brandBody, /"U Time WorkSpace"|"U-Time"/, "品牌区不许再手写文案（两套都在 brandWordmark.js）");
assert.match(brandBody, /\bbrandRule\(\)/, "字标下方必须有那条哥特装饰线（shell.js 的 brandRule()）");
assert.doesNotMatch(brandBody, /class:\s*"mark"/, "品牌区的图标 .mark 已按需求删除，不许再长回来");
assert.doesNotMatch(brandBody, /el\("small"/, "品牌区的副标题 <small>U-TIME</small> 已删除（名称已经写在字标里）");

/* ── 2. 样式表里不留死代码 ── */
assert.doesNotMatch(stylesCss, /\.brand\s+\.mark/, "styles.css 还留着 .brand .mark 规则（图标已删，这是死代码）");
assert.doesNotMatch(stylesCss, /\.brand\s+small/, "styles.css 还留着 .brand small 规则（副标题已删，这是死代码）");

/* ── 3. 字体：哥特态要真的带字体（v0.301.0 恢复）── */
assert.match(stylesCss, /@font-face\s*\{/, "styles.css 必须有 @font-face：哥特形态靠随包的 UnifrakturCook");
assert.match(stylesCss, /url\("\/fonts\/UnifrakturCook-Bold\.woff2"\)\s*format\("woff2"\)/,
  "@font-face 必须指向 /fonts/UnifrakturCook-Bold.woff2（public/fonts 随包）");
assert.match(stylesCss, /font-family:[^;]*UnifrakturCook/, "哥特形态的字标规则要点名 UnifrakturCook");
const fontDir = path.join(appRoot, "public", "fonts");
assert.equal(fs.existsSync(fontDir), true, "public/fonts 必须存在：哥特形态（默认）依赖随包字体");
for (const f of ["UnifrakturCook-Bold.woff2", "OFL.txt"]) {
  assert.ok(fs.existsSync(path.join(fontDir, f)), `public/fonts/${f} 缺失（字体或 SIL OFL 许可文本）`);
}
const notices = read("public/OPEN_SOURCE_NOTICES.md");
assert.match(notices, /fonts\/UnifrakturCook-Bold\.woff2/, "OPEN_SOURCE_NOTICES 要列出随包的哥特体 woff2（OFL 要求署名）");
assert.doesNotMatch(notices, /不再包含该字体的任何副本/, "字体仍在随包分发，NOTICES 不许再写「已移除」");

/* ── 4. 渐变字的写法 ── */
const rules = [...stylesCss.matchAll(/\.brand b\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(rules.length >= 2, "应至少有两处 .brand b 规则（浅色基础 + 深色覆盖）");
const lightRule = rules[0];
/* v0.301.0：基础规则 = 哥特形态（默认）。一般字形是它后面那条
   `:root[data-brand-style="plain"] .brand b` 覆盖，两套都得在。 */
assert.match(lightRule, /font-family:[^;]*"UnifrakturCook"[^;]*serif/, "基础（哥特）形态必须首选 UnifrakturCook，并以 serif 收尾做降级");
assert.match(lightRule, /font-weight:\s*700/, "字标保持 700");
const plainRule = /:root\[data-brand-style="plain"\]\s*\.brand b\s*\{([^}]*)\}/.exec(stylesCss)?.[1];
assert.ok(plainRule, '缺少 :root[data-brand-style="plain"] .brand b 覆盖（一般字形那条）');
assert.match(plainRule, /font-family:[^;]*"Segoe UI"[^;]*sans-serif/, "一般字形必须走系统无衬线栈");
assert.doesNotMatch(plainRule, /UnifrakturCook|Georgia|Times/, "一般字形不许再回哥特 / 衬线");
assert.match(plainRule, /sans-serif\s*;/, "无衬线栈必须以 sans-serif 收尾（否则某些平台会落到衬线默认字体）");
/* 渐变「绘制区止于盒子」的写法只写一次，gen 通用性由基础规则承担；覆盖里不再重复。 */
assert.doesNotMatch(plainRule, /background-image:/, "四档渐变只写在基础规则里（两态同色），覆盖层不要重复一遍");
assert.match(lightRule, /-webkit-background-clip:\s*text/, "渐变字要 -webkit-background-clip: text");
assert.match(lightRule, /(?:^|;|\s)background-clip:\s*text/, "渐变字要 background-clip: text（标准属性）");
assert.match(lightRule, /-webkit-text-fill-color:\s*transparent/, "少这条时字会被填成实心色，渐变只剩描边");
assert.match(lightRule, /(?:^|;)\s*color:\s*transparent/, "`color` 也要透明（只写 -webkit-text-fill-color 的路径会漏）");
assert.match(lightRule, /white-space:\s*nowrap/, "字标是字标，不许折行");
assert.match(lightRule, /display:\s*inline-block/, "字标要 inline-block：盒子按字标自己算，背景才裁得住字形");
/* 字号是量出来的（见文件头）：`U-Time` 在 24px 粗体下实测 93.4px（Segoe UI Bold），
   默认 compact 侧栏（--rail-w: 204px）里 .brand 可用宽度 166px，余量充足。
   v0.300.0 起过渡带不再单独降字号 —— 名字只有 5 个字符，146px 里放 93px 绰绰有余。 */
assert.match(
  lightRule,
  /font-size:\s*calc\(20px \* var\(--ui-text-scale\)\)/,
  "哥特形态字号必须是 calc(20px * var(--ui-text-scale))（16 字符文案在 166px 侧栏里的实测值）",
);
assert.match(
  plainRule,
  /font-size:\s*calc\(24px \* var\(--ui-text-scale\)\)/,
  "一般字形字号必须是 calc(24px * var(--ui-text-scale))（U-Time 93.4px 的实测值）",
);
const narrowRules = rules.filter((body) => /font-size:\s*calc\(18px \* var\(--ui-text-scale\)\)/.test(body));
assert.equal(narrowRules.length, 0, "过渡带不许再给字标单独降字号（18px 是 15 字符旧名字时代的补丁）");
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
/* v0.183.0 的实现把这段 SVG 直接写成 shell.js 里的模板字面量；v0.232.0 搬进 brandWordmark.js 后
   外面包了一层 `svg.innerHTML = \`…\`;`，所以结尾的匹配从「反引号紧接 }」放宽到「反引号 + 可选分号」。 */
const ruleFn = /function brandRule\([^)]*\)\s*\{[\s\S]*?<g class="br-glow">[\s\S]*?`\s*;?/.exec(wordmarkSrc)?.[0];
assert.ok(ruleFn, "src/brandWordmark.js 里找不到 brandRule() 的 SVG 主体（装饰线的唯一创建口）");
/* 唯一创建口不许被复制出第二份：复制一份到刷新蒙版里，改一处必漏一处。 */
assert.equal(
  [...shellSrc.matchAll(/function brandRule\(/g)].length, 0,
  "shell.js 里不该再有自己的 brandRule() 定义 —— 装饰线的唯一创建口是 src/brandWordmark.js",
);
assert.match(shellSrc, /import\s*\{[^}]*\bbrandRule\b[^}]*\}\s*from\s*"\.\/brandWordmark\.js"/,
  "shell.js 必须从 ./brandWordmark.js 引入 brandRule（内联复制会与蒙版那份走形）");
assert.match(ruleFn, /createElementNS\(NS, "svg"\)/, "装饰线必须是内联 SVG（纯 CSS 画不出中间的哥特花纹）");
assert.match(ruleFn, /setAttribute\("viewBox", "0 0 160 14"\)/,
  "viewBox 必须是 0 0 160 14 —— 线宽按 0.8 缩到 128px 显示（v0.300.0 字标变窄后同比例收），改比例才会走形");
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
/* v0.187.0：字标左右居中（用户「弄居中」）。改前 flex-start 在桌面 224px 侧栏里是
   左空 19px / 右空 46px —— 顶在最左边、右边空一大片。居中的实现就是这一条
   `align-items: center`，别退回 flex-start，也别把 .brand 改成固定宽度。 */
assert.match(brandBase, /align-items:\s*center/,
  "字标要相对侧栏左右居中：.brand 必须 align-items: center（各媒体查询只改 padding，左右恒等）");
assert.doesNotMatch(brandBase, /align-items:\s*flex-start/, "别退回 flex-start（右侧会空 46px）");

const ruleCss = /^\.brand-rule\s*\{([^}]*)\}/m.exec(stylesCss)?.[1];
assert.ok(ruleCss, "styles.css 缺少 .brand-rule 的基础规则");
/* v0.301.0：线宽随形态走 —— 哥特态 min(100%, 160px) 与 viewBox 等宽（缩放比恒为 1）；
   一般字形收到 min(100%, 128px)（160 × 0.8，meet 等比缩）；100% 兜住窄侧栏，线先缩、不溢出。 */
assert.match(ruleCss, /width:\s*min\(100%,\s*160px\)/,
  "哥特态的线宽必须是 min(100%, 160px)（与 viewBox 等宽，不做横向拉伸）");
const plainRuleCss = /:root\[data-brand-style="plain"\]\s*\.brand-rule\s*\{([^}]*)\}/.exec(stylesCss)?.[1];
assert.ok(plainRuleCss, "缺少 :root[data-brand-style=\"plain\"] .brand-rule 覆盖（一般字形收窄那条）");
assert.match(plainRuleCss, /width:\s*min\(100%,\s*128px\)/,
  "一般字形的线宽必须是 min(100%, 128px)（160 × 0.8 等比缩到 5 字符的宽度）");
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

/* ── 7. 设置开关（v0.301.0）：两种形态必须能在 设置 → 界面 里切 ── */
const prefsSrc = read("src/uiPreferences.js");
assert.match(prefsSrc, /brandStyle:\s*DEFAULT_BRAND_STYLE/, "uiPreferences 默认值要带 brandStyle（默认哥特态）");
assert.match(prefsSrc, /BRAND_STYLES\.includes\(next\.brandStyle\)/, "归一化必须校验 brandStyle（脏值落回默认）");
assert.match(prefsSrc, /root\.dataset\.brandStyle = cfg\.brandStyle/, "apply 必须写 data-brand-style（CSS 的分叉开关）");
assert.match(prefsSrc, /syncBrandName\(cfg\.brandStyle\)/, "apply 必须同步字标文案（否则切完只换字体不换字）");
const appearanceSrc = read("src/views/settings/appearance.js");
assert.match(appearanceSrc, /"aria-label":\s*"品牌字标"/, "设置页缺少「品牌字标」这组选项");
assert.match(appearanceSrc, /\[\["gothic",\s*"哥特体"\],\s*\["plain",\s*"一般字形"\]\]/,
  "选项必须正好是 哥特体 / 一般字形 两档");
assert.match(appearanceSrc, /setUiPreferences\(\{ brandStyle: id \}\)/, "选项点击必须写 brandStyle 偏好");
assert.match(appearanceSrc, /attachSelectionGlow/,
  "新增的单选组要走滑动选中光（AGENTS.md 铁律六）");
assert.match(appearanceSrc, /brandStyleBox/, "选项组要进 attachSelectionGlow 的循环（brandStyleBox）");

console.log(
  `PASS: 品牌字标两态（哥特体 U Time WorkSpace / 一般字形 U-Time，设置里切换）+ 渐变 + 装饰线 160×14 / 128×14；` +
  `浅色 ${lightChecked} 套 / 深色 ${darkChecked} 套主题，` +
  `白面板 ≥${LIGHT_MIN_PANEL}:1、Nephele 毛玻璃 ≥${LIGHT_MIN_GLASS}:1、深色 ≥${DARK_MIN}:1）`,
);
