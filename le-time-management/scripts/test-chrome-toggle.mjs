import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");
const css = read("../src/styles.css");
const shell = read("../src/shell.js");

/* ───────────── v0.52.0 回归：APK 沉浸式外壳（v0.59.0 修订）─────────────
   需求（用户原话）：
   ① 「apk 默认上下栏都隐藏起来，只有点 3 个点图标的菜单键才会显示出来」
   ② 「距离手机状态栏合适的距离」
   ③ 「apk 每一页都添加返回按钮，在适合的位置，要小」
   ④ v0.59.0：「把apk上面那栏删除」—— 顶栏整条移除，⋮ 只呼出底栏。
   ⑤ v0.59.0：「点击显示菜单按钮后除非打开设置否则不[收起]菜单」—— 底栏呼出后常驻，
      切视图不再自动收回，只有打开设置才收起。

   实现：.app 挂 .chrome-shown ⇔ 底栏显示；默认不挂 ⇒ 底栏 display:none。
   ≤900px 里 .topbar 无条件 display:none（顶栏在手机端不存在）。
   右上角 .chrome-toggle（⋮/✕）呼出与收回；左上角 .mobile-back 独自承担返回
   （顶栏返回键随顶栏消失，悬浮键不再有呼出态让位）。.view 两种状态都自己补
   --sat 顶部安全距离（顶栏不再占位）。 */

// ── ① ≤900px 顶栏整条移除 + 收起态藏底栏 ──
assert.match(css, /\.app\s+\.topbar\s*\{[^}]*display:\s*none/,
  "≤900px 顶栏必须无条件隐藏（.app .topbar → display:none，v0.59.0 起手机端没有顶栏）");
// 反向守卫：不许再出现「呼出态把顶栏显示/改样式」的规则 —— 顶栏在手机端不存在
assert.ok(!/\.app\.chrome-shown\s+\.topbar\s*\{/.test(css),
  "不允许出现 .app.chrome-shown .topbar 规则（顶栏已整条移除，别让它回潮）");
assert.match(css, /\.app:not\(\.chrome-shown\)\s+\.rail\s*\{[^}]*display:\s*none/,
  "收起态必须藏底栏（.app:not(.chrome-shown) .rail → display:none）");

// ⋮ 呼出：必须存在「.chrome-shown 显示底栏」的规则，且写在 .rail-hidden 之后 ——
// 两者同为 (0,2,1) 特异性靠后者胜；顺序反了沉浸式插件页（课程表）里 ⋮ 就呼不出底栏。
assert.match(css, /\.app\.chrome-shown\s+\.rail\s*\{[^}]*display:\s*flex/,
  "呼出态必须把底栏重新显示出来（.app.chrome-shown .rail → display:flex）");
const railHiddenIdx = css.indexOf(".app.rail-hidden .rail");
const chromeRailIdx = css.indexOf(".app.chrome-shown .rail");
assert.ok(railHiddenIdx >= 0 && chromeRailIdx > railHiddenIdx,
  ".app.chrome-shown .rail 必须出现在 .app.rail-hidden .rail 之后（同特异性靠后者胜）");

// :not(…) 带类名参与特异性。v0.59.0 起这组规则再排除 .rail-hidden：沉浸式插件视图
// （课程表）自己带顶栏，46px 让位要收掉，由 `.app.rail-hidden .view` 单独给「只剩安全区」
// 的取值 —— 若这里漏了 :not(.rail-hidden)，靠后书写会把沉浸态的 padding-top 盖回 46px。
// 正则里的 (?:…)? 兼容两种写法；「必须带 :not(.rail-hidden)」由
// scripts/test-immersive-view.mjs 的 ⑤ 单独钉住。
assert.match(css, /\.app:not\(\.chrome-shown\)(?::not\(\.rail-hidden\))?\s+\.view[^{]*\{[^}]*padding-bottom:\s*calc\(4px\s*\+\s*var\(--sab/,
  ".view 要收回为底栏预留的 padding-bottom（否则底部留一条空白）");

// ── ② 状态栏距离：内容从 --sat 下起步（顶栏移除后两种状态都需要），悬浮键本体也吃安全区 ──
assert.match(css, /\.app:not\(\.chrome-shown\)(?::not\(\.rail-hidden\))?\s+\.view[^{]*\{[^}]*padding-top:\s*calc\(\d+px\s*\+\s*var\(--sat,\s*env\(safe-area-inset-top,\s*0px\)\)/,
  ".view 必须补 padding-top = Npx + var(--sat, env(…))：内容不能压进透明状态栏");
assert.match(css, /\.app\.chrome-shown(?::not\(\.rail-hidden\))?\s+\.view[^{]*\{[^}]*padding-top:\s*calc\(\d+px\s*\+\s*var\(--sat,/,
  "呼出态 .view 也要补 --sat 顶部安全距离（顶栏移除后它不再替内容占位）");
const toggleRule = css.match(/\.chrome-toggle\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(toggleRule, "必须存在 .chrome-toggle 规则");
// v0.52.1：⋮ 从「贴顶」挪到右侧 45% 高度 —— 贴顶时它压在顶栏里，窄屏（288 CSS px 档）
// 会盖住顶栏右侧的「快捷入口 / 搜索」。纵向不再贴边 ⇒ 与 --sat 无关，不必吃安全区；
// 但**任何**位置都不许裸用 env()（铁律四），由文件末尾的全文件守卫统一把守。
// v0.110.0：垂直锚点参数化为 --fab-v（默认 45%，设置里可切 35%/55%），断言锚定默认值。
assert.match(toggleRule, /top:\s*calc\(\s*var\(--fab-v,\s*45%\)\s*-\s*18px\)/,
  "⋮ 菜单键垂直锚点必须走 var(--fab-v, 45%)（v0.52.1 起不贴顶；v0.110.0 起档位可调）");
assert.match(toggleRule, /right:\s*calc\(\d+px\s*\+\s*var\(--sar,\s*env\(safe-area-inset-right,\s*0px\)\)/,
  "⋮ 菜单键的 right 必须吃 var(--sar, env(…))（横屏挖孔在侧边）");
assert.match(toggleRule, /position:\s*fixed/, "⋮ 菜单键必须悬浮（fixed）");
// ⚠️ .mobile-back 会先命中媒体块外的兜底规则「.chrome-toggle, .mobile-back { display:none }」
// （选择器列表里也含这个类名）—— 必须取媒体块内那条含 position:fixed 的完整规则。
const mobileBackRule = [...css.matchAll(/\.mobile-back\s*\{([^}]*)\}/g)]
  .map((m) => m[1])
  .find((body) => /position:\s*fixed/.test(body)) ?? "";
assert.ok(mobileBackRule, "必须存在 .mobile-back 的窄屏定位规则（position:fixed）");
assert.match(mobileBackRule, /top:\s*calc\(\s*var\(--fab-v,\s*45%\)\s*-\s*18px\)/,
  "悬浮返回键与 ⋮ 对称，垂直锚点同样走 var(--fab-v, 45%)（v0.110.0 起档位可调）");
assert.match(mobileBackRule, /left:\s*calc\(\d+px\s*\+\s*var\(--sal,\s*env\(safe-area-inset-left,\s*0px\)\)/,
  "悬浮返回键的 left 必须吃 var(--sal, env(…))（横屏挖孔在侧边）");
// 悬浮键要压在底栏(z-55)之上：两栏呼出时 ⋮ 必须保持可点
const toggleZ = Number(toggleRule.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
assert.ok(toggleZ > 55, `⋮ 菜单键 z-index 必须 > 55（底栏层级），实际 ${toggleZ}`);

// ── ③ 桌面 / 宽屏恒隐藏两颗悬浮键（元素在 shell.js 里无条件挂进 DOM）──
assert.match(css, /\.chrome-toggle,\s*\.mobile-back\s*\{\s*display:\s*none/,
  "媒体块外必须有 .chrome-toggle, .mobile-back { display:none } 兜底，宽屏不许露出");

// 呼出态：顶栏已移除 ⇒ 悬浮返回键不再让位（它是手机端唯一返回入口，呼出底栏时也可见）
assert.ok(!/\.app\.chrome-shown\s+\.mobile-back\s*\{[^}]*display:\s*none/.test(css),
  "呼出态不许再藏悬浮返回键（v0.59.0 起顶栏返回键已随顶栏消失，没有让位对象）");

// ⋮ ↔ ✕ 图标随态切换：默认只显 ⋮，呼出后只显 ✕
assert.match(css, /\.chrome-toggle\s+\.ct-close\s*\{\s*display:\s*none/,
  "默认态 ⋮ 菜单键不该显示 ✕");
assert.match(css, /\.app\.chrome-shown\s+\.chrome-toggle\s+\.ct-open\s*\{\s*display:\s*none/,
  "呼出态要藏起 ⋮");
assert.match(css, /\.app\.chrome-shown\s+\.chrome-toggle\s+\.ct-close\s*\{\s*display:\s*block/,
  "呼出态要显示 ✕（可点它收回）");

// ── ④ shell.js 侧：状态、开关、收回入口、返回键同步 ──
assert.match(shell, /let chromeShown = false;/,
  "沉浸式外壳必须默认收起（每次启动都从收起态开始，需求原文「默认上下栏都隐藏」）");
assert.match(shell, /class: "chrome-toggle"/, "必须创建 ⋮ 菜单键按钮");
assert.match(shell, /class: "mobile-back"/, "必须创建悬浮返回键按钮");
assert.match(shell, /"aria-expanded"/, "⋮ 菜单键要把呼出态暴露给无障碍树");
assert.match(shell, /onclick: \(\) => setChromeShown\(!chromeShown\)/,
  "⋮ 菜单键的点击行为必须是切换 .chrome-shown");
assert.match(shell, /appFrame\.classList\.toggle\("chrome-shown", show\)/,
  "setChromeShown 必须把状态写到 .app 的类上（CSS 只认这个类）");
// 收回入口：v0.59.0 起底栏呼出后常驻。需求（用户原话）「点击显示菜单按钮后，除非打开
// 设置否则不[收起]菜单」⇒ 切视图不再自动收回（换页要连着点，不该每次重新呼 ⋮），
// 只有 openSettingsModal 会收掉它。反向守卫：自动收回定时器一旦回潮，这里就会失配。
assert.ok(!/chromeHide/.test(shell),
  "不允许出现「切视图自动收回底栏」的定时器（v0.59.0 起呼出态常驻，只有打开设置才收起）");
assert.match(shell,
  /function openSettingsModal\(section = ""\) \{[\s\S]{0,600}setChromeShown\(false\)/,
  "打开设置必须收回呼出的底栏（窄屏门槛照旧，桌面 .chrome-shown 无视觉效果）");
// 悬浮返回键与顶栏返回键同一份状态
assert.match(shell,
  /syncBackButton[\s\S]{0,220}backBtn\.classList\.toggle\("show", show\);[\s\S]{0,120}mobileBack\.classList\.toggle\("show", show\)/,
  "syncBackButton 必须同时驱动顶栏返回键与悬浮返回键（同一份 canGoBack()）");
assert.match(shell, /const mobileBack = el\("button", \{[\s\S]{0,200}onclick: \(\) => goBack\(\)/,
  "悬浮返回键必须复用 goBack()（先关浮层再回视图，与 Android 返回键一致）");
// 两颗键都要真的挂进 .app（appFrame）——呼出态字形切换与返回键让位全靠
// `.app.chrome-shown .chrome-toggle …` 后代选择器，挂 root 上（.app 的兄弟）永不命中
assert.match(shell, /appFrame\.append\(chromeToggle, mobileBack\)/,
  "两颗悬浮键必须挂在 .app（appFrame）里，不能挂 root（否则 .app.chrome-shown … 选择器失效）");
// 两颗键都要 data-motion="off"：interactions.css 的
// `button.motion-ripple-host:not([data-motion="off"]) { position: relative }`（0,2,1）
// 会压掉 .chrome-toggle 的 position:fixed（0,1,0），按钮掉回文档流末尾（实测 y=850 出屏）。
// 带上该属性后 :not() 不命中，fixed 保留（motion.js 同样尊重这个退出属性，波纹一并免掉）。
assert.match(shell, /class: "mobile-back",[\s\S]{0,200}?"data-motion": "off"/,
  "悬浮返回键必须带 data-motion=\"off\"，否则 interactions.css 会把 fixed 压成 relative");
assert.match(shell, /class: "chrome-toggle",[\s\S]{0,260}?"data-motion": "off"/,
  "⋮ 菜单键必须带 data-motion=\"off\"，否则 interactions.css 会把 fixed 压成 relative");
// setChromeShown 开头的定时器清理（收起动画超时兜底）由下方 ⑥ 钉住。

// ── ⑤ 新增规则不许裸用 env()（铁律四；全文件守卫在 test-android-layout.mjs，
//      这里专钉本功能的四条悬浮键 / 收起态规则）──
const chromeCssChunk = css.slice(css.indexOf(".chrome-toggle, .mobile-back"));
for (const m of chromeCssChunk.matchAll(/var\(--s(?:at|ab|al|ar),\s*env\(safe-area-inset-[a-z]+,\s*0px\)\)/g)) {
  // 命中的每处都必须在 var() 里 —— 变异守卫：谁把某一处改回裸 env 就会少一处命中
}
const chromeSatUses = (chromeCssChunk.match(/var\(--s(?:at|ab|al|ar),\s*env\(safe-area-inset-[a-z]+,\s*0px\)\)/g) || []).length;
assert.ok(chromeSatUses >= 8,
  `沉浸式外壳相关规则必须至少有 8 处 var(--s…, env(…)) 双路取值，实际 ${chromeSatUses} 处 —— 少了就是有人改回裸 env()`);

// ── ⑥ v0.58.2 追加：底栏呼出/收起动画 ──
// 呼出：chrome-shown 规则必须带 rail-dock-in 动画（display:none→flex 时 keyframes 会重放）
const chromeRailBody = css.match(/\.app\.chrome-shown\s+\.rail\s*\{([^}]*)\}/)?.[1] ?? "";
assert.match(chromeRailBody, /animation:\s*rail-dock-in/,
  "呼出态底栏必须播 rail-dock-in 弹入动画");
// 收起：rail-hiding 顶住显示 + rail-dock-out forwards 停在屏下；挂在 chrome-shown 规则之前
const railHidingIdx2 = css.indexOf(".app.rail-hiding .rail");
const chromeRailIdx2 = css.indexOf(".app.chrome-shown .rail");
assert.ok(railHidingIdx2 >= 0 && chromeRailIdx2 > railHidingIdx2,
  ".app.rail-hiding .rail 必须写在 .app.chrome-shown .rail 之前（同特异性，连点 ⋮ 时呼出态胜）");
const railHidingBody = css.match(/\.app\.rail-hiding\s+\.rail\s*\{([^}]*)\}/)?.[1] ?? "";
assert.match(railHidingBody, /display:\s*flex/, "收起动画期间必须顶住 display:flex");
assert.match(railHidingBody, /animation:\s*rail-dock-out[^;]*forwards/,
  "收起动画必须 forwards 停在滑出终态（摘类前不许弹回）");
// 关键帧存在，且 transform 走 translate3d（保住底栏 translateZ(0) 合成层提升，真机防闪帧）
assert.ok(/@keyframes rail-dock-in\s*\{/.test(css) && /@keyframes rail-dock-out\s*\{/.test(css),
  "必须存在 rail-dock-in / rail-dock-out 关键帧");
for (const kf of ["rail-dock-in", "rail-dock-out"]) {
  const body = css.match(new RegExp(`@keyframes ${kf}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
  // v0.106.0：底栏改悬空玻璃后，位移不再是「自己高度 ×105%」—— 必须算进四周的
  // --nav-float 与阴影余量，否则收起动画停在屏下时屏幕底缘会留一条边光。
  // 悬空量本身是否进了 left/right/bottom 由 scripts/test-floating-navbar.mjs 钉。
  assert.match(body, /translate3d\(0,\s*calc\(100%\s*\+\s*var\(--nav-float/,
    `${kf} 关键帧必须是 translate3d(0, calc(100% + var(--nav-float) + 阴影余量), 0)（滑到屏下且保留 z=0 合成层）`);
}
// JS 侧：收起编排 —— 摘 chrome-shown 前挂 rail-hiding、超时兜底摘类、呼出先摘 rail-hiding
assert.match(shell,
  /if \(!show && wasShown && mobileQuery\.matches && !reducedMotion\(\)\)[\s\S]{0,160}classList\.add\("rail-hiding"\)/,
  "收起动画必须四重门槛：真收起 + 之前在呼出 + 窄屏 + 非减少动效");
assert.match(shell,
  /railHideTimer = setTimeout\(\(\) => \{[\s\S]{0,120}classList\.remove\("rail-hiding"\)/,
  "rail-hiding 必须由超时兜底摘类（animationend 在无头/挂起环境不可靠）");
assert.match(shell,
  /if \(railHideTimer\) \{ clearTimeout\(railHideTimer\); railHideTimer = 0; \}[\s\S]{0,80}classList\.remove\("rail-hiding"\)/,
  "setChromeShown 开头必须清收起定时器并摘 rail-hiding（呼出/快速连点不许残留收起态）");
assert.match(shell, /const RAIL_HIDE_ANIM_MS = \d+;/, "收起动画超时兜底时长必须显式声明");

// ── ⑦ 关掉设置要按「进入设置前」的样子把底栏恢复回去 ──
// 需求（用户原话）：「点击设置前已点击三个点展开下栏，点击设置界面后隐藏下栏，出来时再
// 恢复下栏」。v0.59.0 那次收起是单程的 —— 退出设置后底栏必定不显示，还得再点一次 ⋮。
// 层数计数器不是多余的：设置页里能再开一次设置页（views/settings/sync.js 派发
// tide:open-settings），只有最外层记录快照、只有最后一层关闭才恢复。
assert.match(shell, /if \(settingsLayers === 0\) railShownBeforeSettings = chromeShown;/,
  "只有最外层打开设置才记录进入前的呼出态");
assert.match(shell, /settingsLayers = Math\.max\(0, settingsLayers - 1\);/,
  "设置弹窗关闭要把层数减回去（被新弹窗顶掉的那一层不许恢复底栏）");
assert.match(shell,
  /if \(settingsLayers === 0 && railShownBeforeSettings[\s\S]{0,140}setChromeShown\(true\)/,
  "最后一层设置弹窗关掉时，进入前是呼出态就恢复呼出");
// 同一个面板可能被关两次（点遮罩后再被 _close 调一次），减回去两次会把记账打乱。
assert.match(shell, /let dismissed = false;[\s\S]{0,120}if \(dismissed\) return;[\s\S]{0,80}dismissed = true;/,
  "close() 必须幂等（同一层只记一次账）");

// v0.120.0：底栏由上滑呼出，设置页内悬浮控件完全隐藏。
assert.match(css, /\.app\.android-runtime\s+\.chrome-toggle\s*\{\s*display:\s*none/,
  "Android 菜单悬浮键不应常驻遮挡内容");
assert.match(shell, /class: isAndroidRuntime\(\) \? "app android-runtime" : "app"/,
  "只在 Android 隐藏悬浮菜单键，窄屏浏览器仍可用鼠标打开底栏");
assert.match(css, /\.app\.settings-open\s+\.mobile-back\s*\{\s*display:\s*none/,
  "设置页必须隐藏返回悬浮键");
assert.match(css, /\.app\.settings-open:not\(\.android-runtime\)\s+\.rail\s*\{\s*display:\s*none/,
  "只有非 Android 设置页隐藏底栏");
assert.match(shell, /appFrame\.classList\.add\("settings-open"\)/,
  "打开设置要挂 settings-open 标记");
assert.match(shell, /if \(settingsLayers === 0\) appFrame\.classList\.remove\("settings-open"\)/,
  "最后一层设置关闭后要清 settings-open 标记");
assert.match(shell, /view\.addEventListener\("touchend"[\s\S]{0,750}dy <= -72[\s\S]{0,100}setChromeShown\(true\)/,
  "手机端单指向上滑动足够距离后应显示底栏");

console.log("PASS: immersive chrome shell (default-hidden bars, ⋮ toggle with ✕ swap, persistent bottom dock after navigation that only collapses when settings open and comes back with the same expansion state after closing them, floating back button synced with canGoBack, status-bar safe distances on collapsed state, desktop always hides the floating keys, dock slide in/out animation with rail-hiding orchestration)");
