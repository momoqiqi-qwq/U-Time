import { readProductSource } from "./lib/read-product-source.mjs";
/* 手机底栏「悬空玻璃」回归守卫（v0.106.0）。
 *
 * 需求（用户原话）：「把 APK 的下栏改成悬空玻璃」。
 * 落点是 src/styles.css 里 @media (max-width: 900px) 的 .rail —— 桌面那条竖栏在
 * 窄屏被 order:2 + position:fixed 变成底部导航条（点 ⋮ 呼出，见 test-chrome-toggle.mjs）。
 * 改造前它是「贴边通宽 + 只有上边一条描边 + 阴影只往上方抛」，属于钉在屏幕底的形态。
 *
 * 这里钉住六件事，都是改的时候最容易只顾一半的地方：
 *   ① 悬空：四边离开屏幕 --nav-float（左右等值，底边还要叠安全区）；
 *   ② 玻璃：半透明表面 + backdrop-filter 磨砂，且**必须用主题 token**
 *      （浅色/深色与六套配色自动跟随，不许出现写死的 rgba 底色或 [data-theme-mode] 覆盖）；
 *   ③ 收口：整圈 1px 描边 + 四角圆角 —— 悬空之后没有「贴边」可依赖，
 *      旧的 border-top 单条必须消失；
 *   ④ 安全区只算一遍：--sab 从 padding-bottom 挪到底边的 bottom 偏移上，
 *      两处都留就是 v0.38.2「安全区被算了两遍」的同族 bug（横向 --sal/--sar 仍走 padding，
 *      因为横屏挖孔远大于 --nav-float，要靠内边距让开）；
 *   ⑤ 进出场动画跟着悬空量走：rail-dock-in/out 的位移必须算进 --nav-float，
 *      否则收起时屏幕底缘会留小半截条子；
 *   ⑥ 悬空量不许把浮层顶回屏幕外：#toasts 与 .update-toast 的底距同步抬高。
 *
 * 另有两条反面守卫：桌面竖栏（≥901px）不许跟着变玻璃（它背后没有滚动内容，
 * 磨砂只会糊），以及 translateZ(0) 那条常驻合成层不许掉 —— 它是治真机
 * 「点开插件时底栏闪一帧」的（原始注释在 styles.css 的 .rail 规则里）。
 *
 * 真实观感（呼出态/收起态、四周阴影、toast 不被压）由无头 Chrome 在 390×844
 * 逐图检过；本文件只钉源码里会静默回归的接线点，与仓库其余 CSS 守卫同一思路。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readProductSource(path.join(here, "..", rel), "utf8");

const css = read("src/styles.css");
/* 注释里全是 `.rail {` 这类字样，直接数花括号会被注释里的括号带偏 ⇒ 先剥注释再解析。 */
const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出所有匹配条件的 @media 块体（已剥注释，花括号配平可靠） */
function mediaBlocks(condRe) {
  const out = [];
  const re = /@media[^{]*\{/g;
  for (const m of plain.matchAll(re)) {
    if (!condRe.test(m[0])) continue;
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < plain.length && depth > 0) {
      if (plain[i] === "{") depth += 1;
      else if (plain[i] === "}") depth -= 1;
      i += 1;
    }
    out.push(plain.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

/** 在给定文本里找某个选择器的声明块（selector 用字面量，含 . 需转义） */
function ruleBodies(text, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[};\\s])${esc}\\s*\\{([^}]*)\\}`, "g");
  return [...text.matchAll(re)].map((m) => m[2]);
}

const mobile = mediaBlocks(/max-width:\s*900px/);
assert.ok(mobile.length >= 2, "窄屏媒体块数量与预期不符（解析是否被新写法打断？）");
const mobileText = mobile.join("\n;\n");
const railMobile = ruleBodies(mobileText, ".rail").find((b) => /position:\s*fixed/.test(b));
assert.ok(railMobile, "≤900px 里必须仍有 position:fixed 的 .rail 底栏规则");

const desktop = mediaBlocks(/min-width:\s*901px/).join("\n;\n");

/* ── ① 悬空：左右等值的 --nav-float，底边再叠真实安全区 ── */
assert.match(
  mobileText,
  /--nav-float:\s*(\d+)px/,
  "窄屏必须定义 --nav-float（底栏四周的悬空量），桌面块里没有它",
);
const floatPx = Number(/--nav-float:\s*(\d+)px/.exec(mobileText)[1]);
assert.ok(floatPx > 0 && floatPx <= 24, `--nav-float 取 ${floatPx}px，悬空量要在「看得出浮着」与「够不着边」之间`);

/** 取 .rail 块里某条属性的值（不含属性名与结尾分号） */
const decl = (prop) => {
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]*);`).exec(railMobile);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
};
for (const side of ["left", "right"]) {
  assert.match(decl(side), /var\(--nav-float/, `底栏${side === "left" ? "左" : "右"}边必须悬空（${side}: … var(--nav-float…)）`);
  assert.match(decl(side), /\/\s*var\(--ui-scale/, `${side} 的悬空量必须 ÷ --ui-scale（zoom 是布局级缩放，见 v0.105.1 结论）`);
}
const bottomDecl = decl("bottom");
assert.match(bottomDecl, /var\(--nav-float/, "底栏底边要悬空");
assert.match(bottomDecl, /var\(--sab/, "底边必须先让开原生导航栏（--sab）再悬空");
assert.match(bottomDecl, /\/\s*var\(--ui-scale/, "bottom 的让位必须 ÷ --ui-scale");
assert.doesNotMatch(railMobile, /width:\s*100%/, "已经左右定住了，width:100% 会把条子撑出屏幕外");
/* 基础 .rail 那条带着桌面宽度 width: var(--rail-w)（212px）。窄屏旧写法靠 width:100%
   盖住它；改成左右定宽后必须显式清零，否则底栏只有 212px、右边空一大截
   （探针实测过：gapRight 176）。 */
assert.match(decl("width"), /auto/, "窄屏必须把基础的 --rail-w 宽度清成 auto，否则底栏不满宽");

/* ── ② 玻璃：半透明表面 + 磨砂，且只跟主题 token ── */
assert.match(railMobile, /background:[^;]*color-mix\([^;]*transparent/, "底栏表面必须半透明（color-mix … transparent）");
assert.match(railMobile, /backdrop-filter:[^;]*blur\(calc\(24px \* var\(--nav-surface-alpha, 1\)\)\)/, "底栏磨砂必须随背景透明度变化，默认保持 24px");
assert.doesNotMatch(railMobile, /#[0-9A-Fa-f]{3,6}/, "底栏表面不许写死十六进制色 —— 必须跟主题 token 走，深色模式才自动跟随");

/* ── ③ 收口：整圈描边 + 圆角，旧的单条 border-top 必须消失 ── */
assert.match(railMobile, /border:\s*1px solid/, "悬空后必须整圈描边");
assert.match(railMobile, /border-radius:\s*\d+px/, "悬空后必须四角圆角");
assert.doesNotMatch(railMobile, /border-top:/, "不许再出现只贴上边的 border-top（通宽贴底形态的遗留）");
assert.doesNotMatch(railMobile, /box-shadow:[^;]*0\s+-\d+px/, "阴影不许再只往上方抛（那是贴底条的读法），要四周浮起");

/* ── ④ 安全区只算一遍 ── */
const paddingDecl = decl("padding");
assert.ok(paddingDecl, ".rail 的 padding 必须仍然显式声明（左右让开横屏挖孔）");
assert.doesNotMatch(paddingDecl, /--sab/, "--sab 已挪到底边的 bottom 偏移，padding 里再算一次就是双重计算");
assert.match(paddingDecl, /--sal/, "左边仍要 --sal 让开横屏挖孔");
assert.match(paddingDecl, /--sar/, "右边仍要 --sar 让开横屏挖孔");
for (const inset of ["--sal", "--sar"]) {
  assert.ok(
    new RegExp(`${inset}[^;]*?\\/\\s*var\\(--ui-scale`).test(paddingDecl),
    `padding 里的 ${inset} 必须 ÷ --ui-scale（zoom 会把让位乘掉，原生浮层却是物理恒定的）`,
  );
}

/* ── ⑤ 进出场位移算进悬空量 ── */
for (const name of ["rail-dock-in", "rail-dock-out"]) {
  const kf = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "m").exec(plain);
  assert.ok(kf, `关键帧 ${name} 必须存在`);
  assert.match(kf[1], /--nav-float/, `${name} 的位移必须算进 --nav-float，否则收起时屏幕底缘留半截条子`);
  assert.match(kf[1], /translate3d/, `${name} 必须用 translate3d（保住底栏常驻合成层）`);
}

/* ── ⑥ 浮层底距跟悬空量同步，旧的 86px 常量不许回潮 ── */
assert.doesNotMatch(plain, /86px\s*\/\s*var\(--ui-scale/, "toast 系的底距仍写着贴底时代的 86px");
const raised = [...plain.matchAll(/96px\s*\/\s*var\(--ui-scale/g)].length;
assert.equal(raised, 2, "#toasts 与 .update-toast 两处底距都要抬到悬空后的高度");

/* ── 反面守卫 ── */
assert.match(railMobile, /transform:\s*translateZ\(0\)/, "底栏的常驻合成层不能丢（真机点开插件会闪一帧）");
const railDesktop = ruleBodies(desktop, ".rail");
assert.ok(railDesktop.length, "≥901px 的桌面竖栏规则必须仍然存在");
for (const block of railDesktop) {
  assert.doesNotMatch(block, /backdrop-filter/, "桌面竖栏不许跟着变玻璃（它背后没有滚动内容）");
  assert.doesNotMatch(block, /--nav-float/, "桌面竖栏不悬空，别把 --nav-float 漏到 ≥901px");
}
assert.doesNotMatch(
  mobileText,
  /\.rail\s*\{[^}]*var\(--panel\)\s*97%/,
  "旧的不透明窄屏表面（--panel 97%）已被悬空玻璃取代，不许留在后写的主题层里盖回来",
);

console.log("PASS: 悬空玻璃底栏守卫通过");
