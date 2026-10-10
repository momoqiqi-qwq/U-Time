import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 侧栏两条细横线的回归守卫（v0.181.0）。
 *
 * 用户需求原文：
 *   ①「请去掉图中的文字（在侧边栏那里），变成一个横线。上下两条横线对齐，并缩短一些。」
 *   ②「把 U-Time 改成 U-Time Work。」
 *
 * ① 的做法：插件列表上方那行「插 件 视 图 ／ 上下拖动排序」整行删掉，换成一条细横线
 *    （shell.js 的 .plug-list 里那个 .rail-divider）；底部操作条上方那条线（原来是
 *    .rail-bottom 的 border-top）同步改成内缩的伪元素 —— 两条线左右对齐，且都比侧栏外框短。
 * ② 的字标文案由 scripts/test-brand-wordmark.mjs 守。
 *
 * 这条测试守的是「下次谁顺手改回去」的四类事故：
 *   ① 那行标题文字 / 拖拽提示 / 两个死类名（.nav .sec、.plug-list-sec）又长回来；
 *   ② 两条线的左右内缩各写各的（今天 9px、明天 12px）—— 一旦分叉就不再对齐；
 *   ③ 底栏那条线退回 border-top（border 永远贴满整条边，做不出「缩短一些」）；
 *   ④ 窄屏忘了关掉伪元素 —— .rail-bottom 在窄屏是 display: contents，伪元素会被提到 .rail
 *      里变成一个 1px 的散件，压在手机底栏上面。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const read = (p) => readProductSource(path.join(appRoot, p), "utf8");

const shellSrc = read("src/shell.js");
const stylesCss = read("src/styles.css");

/* ── 1. DOM：那行标题文字整行没了，原位只剩一条线 ── */
const plugListBody = /el\("div",\s*\{\s*class:\s*"plug-list"\s*\},([\s\S]*?)\n\s{4}\);/.exec(shellSrc)?.[1];
assert.ok(plugListBody, "在 shell.js 里找不到 .plug-list 的创建（选择器或结构变了？）");
assert.match(plugListBody, /el\("div",\s*\{\s*class:\s*"rail-divider"[^}]*\}\)/,
  ".plug-list 的第一个孩子必须是那条细横线 .rail-divider（标题文字就删在这里）");
assert.doesNotMatch(plugListBody, /插 件 视 图/, "「插 件 视 图」这行标题已按需求删除，不许再长回来");
assert.doesNotMatch(plugListBody, /上下拖动排序/, "「上下拖动排序」这条提示已随标题行一起删除");
assert.doesNotMatch(plugListBody, /el\("span"/, "那条线上不该再挂任何文字节点");
// 全文件层面：两个死类名与那两个 el() 调用都不许复活（注释里提到旧文案是允许的，所以查调用形式）
assert.doesNotMatch(shellSrc, /plug-list-sec/, "死类名 .plug-list-sec 不许再出现（样式表里那两条也一并删了）");
assert.doesNotMatch(shellSrc, /el\(\s*"span"\s*,\s*\{\s*\}\s*,\s*"插 件 视 图"/, "标题 span 不许复活");
assert.doesNotMatch(shellSrc, /el\(\s*"small"\s*,\s*\{\s*\}\s*,\s*"上下拖动排序"/, "拖拽提示 small 不许复活");

/* ── 2. 两条线共用同一份左右内缩 ── */
const insetDecl = /:root\s*\{\s*--rail-line-inset:\s*(\d+)px;?\s*\}/.exec(stylesCss);
assert.ok(insetDecl, "styles.css 里必须有 --rail-line-inset（两条线唯一的内缩事实源）");
const inset = Number(insetDecl[1]);
assert.ok(inset > 0, `--rail-line-inset 必须是正数（= 比侧栏外框短一截），实际 ${inset}`);

const sharedRule = /\.rail-divider,\s*\.rail-bottom::before\s*\{([^}]*)\}/.exec(stylesCss)?.[1];
assert.ok(sharedRule, "两条线必须共用一条声明块：`.rail-divider, .rail-bottom::before { … }`");
assert.match(sharedRule, /height:\s*1px/, "线高必须是 1px");
assert.match(sharedRule, /background:\s*var\(--line\)/,
  "线的颜色要走主题令牌 --line（硬编码的 rgba(255,255,255,.08) 在浅色侧栏上等于看不见）");

const dividerRules = [...stylesCss.matchAll(/\.plug-list\s*>\s*\.rail-divider\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(dividerRules.length, "缺少 `.plug-list > .rail-divider` 那条（插件列表上方的线）");
assert.ok(dividerRules.some((body) => /margin:\s*[^;]*var\(--rail-line-inset\)[^;]*;/.test(body)),
  "插件列表那条线必须用 --rail-line-inset 做左右内缩（写死数字就会和另一条分叉）");
// 媒体查询里允许只调纵向留白，但一律不许自己写横向内缩（左/右/margin-left/right）
for (const body of dividerRules) {
  assert.doesNotMatch(body, /(?:^|;)\s*(?:margin-left|margin-right|left|right)\s*:/,
    `那条线不许单独写横向内缩，否则两条线不再对齐：${body.trim()}`);
  for (const m of body.matchAll(/margin:\s*([^;]+);/g)) {
    const parts = m[1].trim().split(/\s+/);
    if (parts.length === 4) {
      assert.equal(parts[1], "var(--rail-line-inset)", "margin 简写的左右两项都要走 --rail-line-inset");
      assert.equal(parts[3], "var(--rail-line-inset)", "margin 简写的左右两项都要走 --rail-line-inset");
    }
  }
}

const dockRules = [...stylesCss.matchAll(/\.rail-bottom::before\s*\{([^}]*)\}/g)].map((m) => m[1]);
const dockRule = dockRules.find((body) => /position:\s*absolute/.test(body));
assert.ok(dockRule, "缺少 `.rail-bottom::before` 的定位规则（底栏上方的线）");
assert.match(dockRule, /position:\s*absolute/, "底栏那条线必须绝对定位（.rail-bottom 同时是 .rail-dock，flex 行容器）");
assert.match(dockRule, /left:\s*var\(--rail-line-inset\)/, "底栏那条线的左内缩也要走 --rail-line-inset");
assert.match(dockRule, /right:\s*var\(--rail-line-inset\)/, "底栏那条线的右内缩也要走 --rail-line-inset");

/* ── 3. 底栏的线不再是 border-top，几何仍是「线上方 1px + 下方 7px」 ── */
const dockBase = /^\.rail-bottom\s*\{([^}]*)\}/m.exec(stylesCss)?.[1];
assert.ok(dockBase, "找不到 .rail-bottom 的基础规则");
assert.doesNotMatch(dockBase, /border-top/, ".rail-bottom 不许再用 border-top 画分隔线（贴满整条边、做不出内缩）");
assert.match(dockBase, /position:\s*relative/, ".rail-bottom 要给绝对定位的伪元素当包含块");
assert.match(dockBase, /padding-top:\s*7px/, "底栏线到按钮的 7px 由 padding-top 给（与旧 border-top + padding-top 同几何）");

/* ── 4. 窄屏必须关掉伪元素（.rail-bottom 在那里是 display: contents） ── */
const narrowBlock = stylesCss.slice(stylesCss.indexOf("@media (max-width: 900px)"),
  stylesCss.indexOf("@media (max-width: 520px)"));
assert.ok(narrowBlock.includes(".rail-bottom::before"), "窄屏块里找不到 .rail-bottom::before 的收尾规则");
assert.match(narrowBlock, /\.rail-bottom::before\s*\{\s*display:\s*none;?\s*\}/,
  "窄屏必须 display: none 关掉这条线：.rail-bottom 在那里是 display: contents，伪元素会被提到 .rail 里");

/* ── 5. 死样式不许留（只认真正的规则，注释里提到旧类名是允许的） ── */
assert.doesNotMatch(stylesCss, /\.nav\s+\.sec\s*[,{]/, "styles.css 还留着 .nav .sec 规则（那行标题已删，这是死代码）");
assert.doesNotMatch(stylesCss, /\.plug-list-sec\s*[,{]/, "styles.css 还留着 .plug-list-sec 规则（同上）");

console.log(
  `PASS: 侧栏两条细横线（标题行已换成线 + 两条线共用 --rail-line-inset: ${inset}px 左右对齐 + 窄屏关掉 + 无死样式）`,
);
