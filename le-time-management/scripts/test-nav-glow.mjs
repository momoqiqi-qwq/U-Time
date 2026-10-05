import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 侧栏选中光块（滑动指示器）回归测试
 *
 * 背景：切换界面时，`renderNav()` 首行的 `nav.replaceChildren()` 会把整个侧栏重建，
 * 所以"选中态"过去只是一块静态底色，做不出"从旧位置滑到新位置"的位移关系。
 * v0.152.0 加了一个独立的 `.nav-glow` 元素承担位移，机制与参数照 Nephele Workshop 的
 * `sidebarActiveIndicator`（已读其随包分发的 QML 源码）。守卫下面这些**容易回退**的点：
 *
 *   ① 两层结构：条目自持一层淡底（"自持微光"）+ 光块是"更亮的焦点标记"。
 *      把按钮那层摘掉（"避免双重高亮"的直觉）就会丢掉一个语义 —— 选中项落进收起的分组、
 *      由组头替它亮着时，侧栏会整个失焦。这是本次改造最容易被"优化"掉的地方。
 *   ② 光块必须 absolute（跟着滚动容器走），且桌面 / 窄屏各有自己的底色（白色在玻璃底栏上看不见）。
 *   ③ 包含块：桌面 `.rail` 与 `.nav` 都要有 position —— 少一个光块的坐标就会漏到 #app 之外。
 *   ④ renderNav 收尾必须重新落位；替换子节点之后必须把光块挂回去（漏一次它就永久消失）。
 *   ⑤ 落位必须过 reducedMotion() 闸门，且坐标要除 getUiScaleFactor()（zoom 下不除会整体偏）。
 *   ⑥ 位移与尺寸两条通道的时长**必须不同**（5:4）—— 写成同一个就丢了"惯性拉伸"感。
 *   ⑦ 终点坐标必须**剥掉按钮自身的 transform**（layoutBoxOf）。CSS 给 button 挂了 hover 抬升
 *      与 :active 下压，都带过渡；切页那一刻正在过渡中间，裸 rect 读到的是瞬时反馈的位置
 *      （实测终点偏 1px，:active 的 scale(.98) 极端时让宽度差 2%）。这处反解最容易被"简化"回去。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readProductSource(path.join(here, rel), "utf8");
const css = read("../src/styles.css");
const shell = read("../src/shell.js");

/* 取一条规则的声明体（选择器 + 紧跟的开括号；命中第一处 = 基础规则，不是媒体块里的覆盖） */
function ruleBody(source, selector) {
  const index = source.indexOf(`${selector} {`);
  assert.ok(index >= 0, `styles.css 里找不到规则 ${selector} {`);
  const end = source.indexOf("}", index);
  assert.ok(end > index, `规则 ${selector} 没有闭合`);
  return source.slice(index, end);
}
/* 取函数的函数体（先跳过参数表 —— 解构参数里也有花括号，直接找第一个 { 会误判） */
function bodyOf(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `shell.js 里找不到 ${header}`);
  const parenOpen = source.indexOf("(", start);
  let paren = 0;
  let i = parenOpen;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") paren += 1;
    else if (source[i] === ")") {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  const open = source.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < source.length; j += 1) {
    if (source[j] === "{") depth += 1;
    else if (source[j] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, j + 1);
    }
  }
  throw new Error(`${header} 的花括号不闭合`);
}
const rgbaAlpha = (body) => {
  const match = body.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
  return match ? Number(match[1]) : null;
};

/* ── ① 两层结构 ── */
const buttonOn = ruleBody(css, ".nav button.on");
const glow = ruleBody(css, ".nav-glow");
assert.match(buttonOn, /background:\s*rgba\(/, "选中按钮必须保留自己的淡底（自持微光那一层）");
assert.doesNotMatch(buttonOn, /background:\s*none/, "选中按钮的底色被摘掉了 —— 收起的分组替它亮着时侧栏会失焦");
const buttonAlpha = rgbaAlpha(buttonOn);
const glowAlpha = rgbaAlpha(glow);
assert.ok(buttonAlpha > 0, "选中按钮的底色透明度必须是有效值");
assert.ok(glowAlpha > buttonAlpha,
  `光块要比按钮那层更亮（焦点标记）。现在是 按钮 ${buttonAlpha} / 光块 ${glowAlpha}`);

/* ── ② 光块的定位与形态 ── */
assert.match(glow, /position:\s*absolute/, ".nav-glow 必须 absolute（桌面要跟着 .nav 这个滚动容器走）");
assert.doesNotMatch(glow, /position:\s*fixed/, ".nav-glow 不许用 fixed —— 那样它不会跟着列表滚动");
assert.match(glow, /z-index:\s*0/, ".nav-glow 要 z-index: 0，与按钮的 1 配成'画在按钮底之下、内容之上'");
assert.match(glow, /pointer-events:\s*none/, "光块不该抢指针事件");
assert.match(glow, /transition:\s*opacity/, "显隐要有过渡（对应 Nephele 的 Behavior on opacity 200ms）");

/* 光块的**生效**底色必须按语境走：基础规则压根不是最终形态 —— ≤900px 与 ≥901px 两个媒体块
   都会把 .rail 换成各自的主题令牌配色（窄屏玻璃底栏 / 宽屏浅色面板），所以两处都得有自己的
   .nav-glow 覆盖。少一处就是那个语境下"光块隐身"（v0.152.0 实测：宽屏浅色叠白只差 1 个色阶）。
   ⚠️ 只能用**各自的媒体块**来取，不能再用 lastIndexOf(".nav-glow {") —— 宽屏块在文件里更靠后。 */
const glowRules = css.match(/\.nav-glow \{/g) ?? [];
assert.ok(glowRules.length >= 3,
  `基础 + 窄屏 + 宽屏三处都要有 .nav-glow 规则（现在只有 ${glowRules.length} 处）`);
const narrowBlock = bodyOf(css, "@media (max-width: 900px)");
const wideBlock = bodyOf(css, "@media (min-width: 901px)");
const narrowGlow = narrowBlock.match(/\.nav-glow \{[^}]*\}/)?.[0] ?? "";
const wideGlow = wideBlock.match(/\.nav-glow \{[^}]*\}/)?.[0] ?? "";
assert.match(narrowGlow, /color-mix\(/, "窄屏光块要用主题令牌的 color-mix 显色（白色系在玻璃底栏上看不见）");
assert.match(narrowGlow, /border-radius:\s*10px/, "窄屏光块的圆角要跟窄屏按钮的 10px 对齐");
assert.match(wideGlow, /color-mix\([^)]*var\(--deep\)/,
  "宽屏块也要给 .nav-glow 一条 --deep 色 —— 那条侧栏在这个块里换成了浅色面板，基础规则的白色会隐身");
// 与同块的 .nav button.on 同源且更亮（`--active-bg` 就是 --deep 10%）
const wideOn = wideBlock.match(/\.nav button\.on \{[^}]*\}/)?.[0] ?? "";
assert.match(wideOn, /var\(--active-bg\)/, "宽屏选中底色走 --active-bg，光块要跟它同源");
const pct = (src) => Number(src.match(/var\(--deep\)\s*(\d+(?:\.\d+)?)%/)?.[1] ?? NaN);
assert.ok(pct(wideGlow) > 10,
  `宽屏光块要比选中底色的 --deep 10% 更亮（焦点标记那一层）。现在是 ${pct(wideGlow)}%`);

/* ── ③ 包含块 ── */
assert.match(ruleBody(css, ".rail"), /position:\s*relative/,
  "桌面 .rail 必须是定位元素，否则光块的包含块会一路漏到 #app 之外，坐标全错");
assert.match(ruleBody(css, ".nav"), /position:\s*relative/,
  "桌面 .nav 必须是定位元素（滚动容器 + 光块的包含块）");
assert.match(ruleBody(css, ".nav button"), /z-index:\s*1/, "按钮要抬到光块之上，否则光块会盖住图标文字");

/* ── ④ renderNav 的收尾与重挂 ── */
const renderNav = bodyOf(shell, "function renderNav()");
const replaceAt = renderNav.indexOf("nav.replaceChildren()");
const prependAt = renderNav.indexOf("nav.prepend(navGlow)");
assert.ok(replaceAt >= 0, "renderNav 里没找到 nav.replaceChildren()");
assert.ok(prependAt > replaceAt,
  "replaceChildren 之后必须把 navGlow 挂回去 —— 漏一次光块就永久消失（第一次切换后就不见了）");
assert.ok(renderNav.indexOf("syncNavGlow()") > 0, "renderNav 收尾必须落位一次（所有调用点才都被覆盖）");
assert.ok(renderNav.indexOf("if (!pluginViews.length) { syncNavGlow(); return; }") > 0,
  "没有插件视图的提前 return 分支也要落位，否则那条路径上光块会停在旧位置");

/* ── ⑤ 落位函数自身的闸门与换算 ── */
const sync = bodyOf(shell, "function syncNavGlow(");
assert.match(sync, /reducedMotion\(\)/, "减少动效时必须跳过位移/尺寸动画（只落位）");
assert.match(sync, /getUiScaleFactor\(\)/,
  "坐标必须除界面缩放系数：zoom 下 getBoundingClientRect 是视觉 px，不除会整体偏移");
assert.match(sync, /offsetParent/, "包含块要从 offsetParent 取（绝对定位元素的 offsetParent 就是它的包含块）");
assert.ok(bodyOf(shell, "function hideNavGlow()").includes('classList.remove("on")'),
  "找不到选中项时要淡出（去掉 .on），不是跳位");
assert.match(shell, /navGlowAnims\.forEach\(\(anim\) => anim\.cancel\(\)\)/,
  "重算前要取消在飞的动画，否则两条通道会互相打架");

/* ── ⑥ 两条通道的时长必须不同 ── */
const slideMs = shell.match(/NAV_GLOW_SLIDE_MS = (\d+)/);
const resizeMs = shell.match(/NAV_GLOW_RESIZE_MS = (\d+)/);
assert.ok(slideMs && resizeMs, "位移 / 尺寸两条通道的时长常量要各自声明");
assert.notEqual(slideMs[1], resizeMs[1],
  "两条通道时长相同就丢了'惯性拉伸'感 —— Nephele 是 500 位移 / 400 尺寸，比例 5:4");
assert.match(sync, /duration: NAV_GLOW_SLIDE_MS/, "位移通道要真的用上自己的时长");
assert.match(sync, /duration: NAV_GLOW_RESIZE_MS/, "尺寸通道要真的用上自己的时长");

const easeSlide = shell.match(/NAV_GLOW_EASE_SLIDE = "([^"]+)"/);
const easeResize = shell.match(/NAV_GLOW_EASE_RESIZE = "([^"]+)"/);
assert.ok(easeSlide && easeResize, "两条缓动曲线要各自声明");
assert.notEqual(easeSlide[1], easeResize[1], "位移用 OutBack、尺寸用 OutCubic，不能共用一条");
const overshoot = Number(easeSlide[1].match(/cubic-bezier\([\d.]+, ([\d.]+)/)?.[1]);
assert.ok(overshoot > 1, `位移曲线的第二个控制点要 > 1（OutBack 的过冲，这就是'惯性'）。现在是 ${overshoot}`);

/* ── ⑦ 跟随重算的接线 ── */
assert.match(shell, /new ResizeObserver\(\(\) => syncNavGlow\(\{ animate: false \}\)\)/,
  "容器 / 按钮尺寸变化要走瞬时对齐");
assert.match(shell, /navGlowResizeObs\.observe\(nav\)/, "要盯着 nav 的尺寸变化");
const fold = bodyOf(shell, "function foldNavGroup(");
assert.ok(fold.includes("syncNavGlow()"),
  "分组折叠必须显式挂钩：nav 的高度由 flex:1 定，折叠不改变它，ResizeObserver 盯不到这条路径");

/* ── ⑧ 终点坐标必须剥掉按钮自身的 transform ──
   真机实测结论（output/nav-glow-drift.mjs）：点击后按钮的 offsetTop 恒定不变，
   但 rect.top 在 ~160ms 内从 159 平滑缓到 158 —— 是按钮自身的 transform 在动，
   而光块在点击那一刻（transform 还停在起点）就锁定了位置，于是永久偏 1px。
   判据取"sync 区间内不许出现裸 rect"，比断言"写了 layoutBoxOf"更抗绕过。 */
assert.doesNotMatch(sync, /btn\s*\.\s*getBoundingClientRect\(\)/,
  "syncNavGlow 不能拿裸 rect 当终点 —— 按钮自身的 hover / :active transform 会让光块偏 1px 且随鼠标抖动");
assert.match(sync, /layoutBoxOf\(btn\)/, "终点坐标要过 layoutBoxOf（剥掉按钮自身的 transform）");
const boxOf = bodyOf(shell, "function layoutBoxOf(");
assert.match(boxOf, /getComputedStyle\(node\)\.transform/, "layoutBoxOf 要读元素自身的 transform");
// 前提要写在**函数上方的注释**里（bodyOf 只取函数体，不含注释）——
// 前提没了就该重新评估这处反解，别让它变成读不懂来源的无主代码。
const boxComment = shell.slice(Math.max(0, shell.indexOf("function layoutBoxOf(") - 900), shell.indexOf("function layoutBoxOf("));
assert.match(boxComment, /translateY\(-1px\)/, "layoutBoxOf 的注释要写清前提（CSS 的 hover 抬升）");
assert.match(boxOf, /Math\.abs\(b\)\s*>\s*1e-4/, "有旋转/斜切时要放弃反解（退回裸 rect 好过算错）");
assert.match(boxOf, /rect\.width\s*\/\s*\(a\s*\|\|\s*1\)/, "缩放要反解回布局宽（transform-origin 是 center）");
assert.match(boxOf, /-\s*tx/, "位移分量 tx/ty 要减掉");

/* ── ⑨ 底栏呼出 / 收起后必须显式落位 ──
   真机实测（output/nav-glow-motion.mjs 的 RoLog）：窄屏下 .nav 是 display: contents、
   不生成盒子，ResizeObserver 对它**恒报 0×0** ⇒ 「包含块从无到有」这件事 RO 完全看不见。
   所以必须自己挂钩，否则底栏会先滑出来、选中光块要等下一次 renderNav 才淡入（看着像没高亮）。 */
const chromeShown = bodyOf(shell, "function setChromeShown(");
assert.match(chromeShown, /syncNavGlow\(\{ animate: false \}\)/,
  "呼出/收起底栏后要显式落位 —— .nav 是 display:contents，ResizeObserver 盯不到包含块从无到有");

/* ── ⑩ 多颗 .on 同时存在时，必须以 activeView 为准 ──
   真机实测（output/nav-glow-plug-probe.mjs）：进入插件视图时 `market` **也**带 .on ——
   navBtn 里 `id === "market" && activeView.startsWith("plug:")`，这是**刻意**的（插件从市场进去，
   两个都该亮）。但 market 在 railCoreViewIds() 里、文档序排在插件段**之前** ⇒
   `querySelector('button[data-view].on')` 永远抓到 market，光块就停在「插件市场」上不跟过去。
   实测差 78px（近两行）。这处最容易被"简化"回裸 querySelector —— 因为单 .on 时它恰好是对的。 */
assert.doesNotMatch(sync, /querySelector\(\s*['"]button\[data-view\]\.on['"]\s*\)/,
  "syncNavGlow 不能直接 querySelector 第一个 .on —— 进插件视图时 market 也带 .on 且文档序在前，光块会停在「插件市场」");
assert.match(sync, /activeNavBtn\(\)/, "「该亮哪颗」要过 activeNavBtn()，不能就地取第一颗");
const picker = bodyOf(shell, "function activeNavBtn(");
assert.match(picker, /querySelectorAll\(\s*['"]button\[data-view\]\.on['"]\s*\)/,
  "activeNavBtn 要取出全部 .on 再挑，而不是取第一颗");
assert.match(picker, /\.dataset\.view === activeView/,
  "activeNavBtn 要以 activeView 自身那一项为准（market 与插件项会同时亮）");
assert.match(picker, /ons\[0\]/,
  "activeView 那一项不在 DOM 里时（插件项被折叠的分组藏起来）要回退到文档序第一个，不能返回 null");
const pickComment = shell.slice(Math.max(0, shell.indexOf("function activeNavBtn(") - 1200), shell.indexOf("function activeNavBtn("));
assert.match(pickComment, /market/, "activeNavBtn 的注释要写清前提（market 为什么也带 .on）");

console.log("PASS: 侧栏光块的两层结构、absolute 包含块、重挂与落位、reducedMotion/缩放换算、双通道时长、终点剥 transform、底栏呼出落位、多 .on 时以 activeView 为准");
