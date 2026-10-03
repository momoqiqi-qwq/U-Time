import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");
const css = read("../src/styles.css");
const timeViews = read("../src/views/timeViews.js");
const timeblock = read("../src/views/timeblock.js");

/* ───────────── v0.37.20：时间块视图切换收进展开菜单 ─────────────
   原来 7 个样式平铺成一行横向滚动 chips，手机上只看得见 4 个半，
   「卡片时间轴 / 年度甘特 / 阶段甘特」永远藏在滑动条后面。
   现在收成「当前样式名 + 展开按钮」，菜单挂 body。 */
assert.match(timeViews, /export function createTimeViewSwitcher/);
assert.match(timeViews, /class: "time-viewtoggle"/, "必须有展开触发器");
assert.match(timeViews, /class: "time-viewmenu"/, "必须有菜单容器");
assert.doesNotMatch(timeViews, /class: `time-viewbtn/, "旧的平铺 chips 必须移除");
assert.doesNotMatch(css, /\.time-viewbtn/, "旧的 .time-viewbtn 样式必须移除");
// 菜单挂 body：切换栏带 overflow，作为子节点会被裁掉
assert.match(timeViews, /document\.body\.append\(menu\)/, "菜单必须挂到 body 才不会被 overflow 裁掉");

/* 🔴 回归 1：close() 必须写布尔值。
   `menu.hidden = ""` 赋的是空字符串（falsy），hidden 属性不会生效，
   菜单会赖在屏幕上 —— 实测「选完不关闭、Esc 关不掉、点外部关不掉」。 */
// 剥掉注释再判定 —— 本模块的说明性注释里就写着那个错误写法，否则会误伤自己。
const timeViewsCode = timeViews
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
assert.match(timeViewsCode, /menu\.hidden = true/, "关闭时必须赋布尔 true，不能是空字符串");
assert.match(timeViewsCode, /menu\.hidden = false/, "打开时必须赋布尔 false");
assert.doesNotMatch(timeViewsCode, /menu\.hidden = ""/, '`menu.hidden = ""` 是 falsy，属性不生效');
assert.doesNotMatch(timeViewsCode, /menu\.hidden = null/, "`menu.hidden = null` 语义混乱，应写布尔");

// Esc 与外部点击都要能关闭
assert.match(timeViewsCode, /e\.key === "Escape"/, "Esc 必须能关闭菜单");
assert.match(timeViewsCode, /onDocPointer/, "点菜单外部必须能关闭");

/* 🔴 回归 2：菜单必须在视图卸载时收走。
   菜单挂在 body 而不是视图内，视图切走时不会被一起清掉，
   反复进出会累积成一堆残留节点。 */
assert.match(timeblock, /document\.querySelectorAll\("\.time-viewmenu"\)\.forEach\(\(m\) => m\.remove\(\)\)/,
  "离开时间块视图必须清掉 body 上的菜单节点");
assert.match(timeViews, /document\.querySelectorAll\("\.time-viewmenu"\)\.forEach\(\(m\) => m\.remove\(\)\)/,
  "重建 switcher 前必须先清旧菜单，否则同一时刻存在两个");

/* ───────────── v0.37.20：7 个时间视图的窄屏真适配 ─────────────
   改造前每个视图都靠硬编码 min-width 撑开 + 外层横向滚动：
   WakeUp 900 / 年表 1500 / 年度甘特 1120 / 泳道 1250。
   横向滚动不是适配 —— 年表 1500px 画布里 150px 的卡片还在同一水平线左右交错，
   滚到哪都是叠字（用户实测截图）。现在按视图性质换布局。 */

// 1) 窄屏必须换掉横向滚动容器，而不是留着让它滚。
// 按「规则形态」定位那个 760px 块 —— 文件里有 10 个同条件的 760px 块（底栏、抽屉、设置页…），
// 直接 split 取 [1] 会落到抽屉块上。
// ⚠️ 别用裸选择器当锚点：基础态规则（媒体查询外）里也写着 `.wakeup-mobile`、`.time-viewtoggle`，
//    它们会被算进前一个块的尾巴，实测被 `.wakeup-mobile` 误导过一次。
//    用「选择器 + 花括号 + 声明」的完整规则形态才唯一。
// 断点用 px：曾一度改成 em 试图让断点跟随界面缩放，实测 em 媒体查询不认 zoom /
// html font-size（见 styles.css 顶部），已全部回退。
const narrowBlocks = css.split("@media (max-width: 760px)").slice(1);
const narrow = narrowBlocks.find((b) => b.includes(".wakeup-mobile { display:block")) ?? "";
assert.ok(narrow, "必须存在含时间视图适配的 ≤760px 媒体块");
for (const sel of [".wakeup-scroll", ".chronicle-scroll", ".gantt-scroll", ".swim-scroll"]) {
  assert.match(narrow, new RegExp(`\\${sel}\\s*\\{\\s*display:\\s*none`),
    `窄屏必须隐藏横向滚动容器 ${sel}，改为分组/纵向布局`);
}
// 2) 窄屏必须显示对应的新布局容器
// 规则里可能先写 position 等声明（`.chronicle-vertical { position:relative; display:block; ... }`），
// 所以不能要求 `{` 紧跟 `display` —— 按「选择器块内含 display:block」判定。
for (const sel of [".wakeup-mobile", ".chronicle-vertical", ".gantt-monthly", ".swim-mobile"]) {
  // 基础态隐藏（避免首帧两端布局同时出现），窄屏打开
  assert.match(css, new RegExp(`\\${sel}[^{]*\\{\\s*display:\\s*none`), `${sel} 基础态必须隐藏`);
  const ruleBody = narrow.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.ok(ruleBody, `窄屏必须有 ${sel} 规则`);
  assert.match(ruleBody, /display:\s*block/, `${sel} 窄屏必须显示`);
}
// 3) 桌面端必须保持原样：手机专用容器一律不渲染
assert.match(css, /@media \(min-width: 761px\)[\s\S]*?\.wakeup-mobile,[\s\S]*?\{[^}]*display:\s*none\s*!important/,
  "桌面端必须强制隐藏手机专用布局（含 !important，防作者样式覆盖）");

/* 🔴 回归 3：卡片时间轴窄屏横向溢出。
   .card-timeline 带 `margin:34px auto`。窄屏若只覆盖左右 margin 为 14px，
   box 会按「宽度 100% + 左右 margin」算出 100%+28px ⇒ 向右溢出 13px（实测）。
   修法：宽度交 auto + margin 归零，全部交给 padding。 */
const cardRule = narrow.match(/\.card-timeline\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(cardRule, "窄屏必须有 .card-timeline 规则");
const cardMargin = cardRule.match(/margin:\s*([^;]+);/)?.[1] ?? "";
assert.ok(cardMargin, "窄屏 .card-timeline 必须显式写 margin");
// 解析 margin 简写：1 值=四边相同，2 值=上下/左右，3 值=上/左右/下，4 值=上/右/下/左。
// 只看左右分量是否为 0 —— 别用 `1[0-9]px` 这种正则模糊匹配，
// `margin:16px 0 22px` 的光头值 16 会被误判成「左右有 10~19px」。
const mv = cardMargin.trim().split(/\s+/);
const left = mv.length === 1 ? mv[0] : mv.length === 2 ? mv[1] : mv.length === 3 ? mv[1] : mv[3];
const right = mv.length === 1 ? mv[0] : mv.length === 2 ? mv[1] : mv.length === 3 ? mv[1] : mv[1];
for (const [side, v] of [["左", left], ["右", right]]) {
  assert.equal(parseFloat(v), 0,
    `窄屏 .card-timeline ${side} margin 必须为 0（当前 ${v}）—— ` +
    `宽度 100% 加上非零水平 margin 会算成 100%+margin，向右溢出（实测 13px）`);
}

/* 🔴 回归 4：折叠分组在桌面端必须透明。
   折叠用原生 <details>。桌面端若不拆掉这层盒子，<details> 会成为 flex/grid item，
   把年月网格布局整个改掉（桌面外观必须与改造前一致）。
   display:contents 让内容直接参与父级布局。 */
assert.match(css, /\.tv-fold\s*\{\s*display:\s*contents/, "桌面端 .tv-fold 必须 display:contents");
assert.match(css, /\.tv-fold-head\s*\{\s*display:\s*none/, "桌面端分组标题必须隐藏");
assert.match(css, /\.tv-fold-body\s*\{\s*display:\s*contents/, "桌面端分组体必须 display:contents");
assert.match(narrow, /\.tv-fold\s*\{\s*display:\s*block/, "窄屏 .tv-fold 必须变成真正的折叠盒子");
assert.match(narrow, /\.tv-fold-head\s*\{[^}]*min-height:\s*48px/, "折叠标题行触控区 ≥44px");
assert.match(narrow, /\.tv-fold\[open\] \.tv-fold-caret\s*\{\s*transform:\s*rotate\(180deg\)/, "展开时箭头要掉头");

/* 🔴 回归 5：分组默认展开数要有节制。
   5 个分类全展开实测 1670px 高，一屏 844px 看不完 ⇒ 折叠失去意义。
   年表 12 个月全列出来时，8 个空月份的标题会把有内容的月份推出屏幕。 */
const swimBody = timeViews.split("function swimlaneView")[1] ?? "";
assert.match(swimBody, /opened\+\+ < 2/, "阶段甘特窄屏默认最多展开 2 个分类");
const ganttBody = timeViews.split("function ganttView")[1] ?? "";
assert.match(ganttBody, /filter\(r => r\.hit\.length \|\| r\.m === todayMonth\)/,
  "年度甘特窄屏只列出有内容的月份 + 当前月，空月份不能占屏");

/* 🔴 回归 6：课程表（wakeup）的「1–10 节一屏显示」靠三个约束成对存在，缺一即回归。
   ① 行下限 --wk-row-min 必须**同时**喂给 grid-template-rows 与 min-height。
      只改 grid-template-rows 而漏 min-height：窗口一矮，行触下限后轨道总和会超出被压扁的
      网格盒子，而 .wakeup-grid 自带 overflow:hidden（裁 18px 圆角用）⇒ 末尾几节被直接裁掉，
      且 scrollHeight 不含被裁内容所以滚不到 —— 比原来固定 72px「能滚」更糟。
      实测（1440×560）被裁掉 5 节，而「纵向溢出」量出来还是 0，只看溢出会判成通过。
   ② 帧高上限写在 .wakeup-scroll，CSS 变量只能向下继承 ⇒ --slot-count 必须挂面板根节点。
   ③ .wakeup-view 的 flex 高度链只能待在桌面媒体块：手机上面板一旦 height:100%，
      超出一屏的内容会被 .tv-panel 的 overflow:hidden 裁掉。 */
const wkGrid = css.match(/\.wakeup-grid\s*\{[^}]*\}/)?.[0] ?? "";
assert.match(wkGrid, /--wk-row-min\s*:\s*\d+px/, "课程表网格必须定义节次行下限 --wk-row-min");
// v0.43.0 起下限会乘 --wk-zoom（用户缩放），包裹形态是 minmax(calc(var(--wk-row-min) * var(--wk-zoom)),1fr)
assert.match(wkGrid, /grid-template-rows:[^;]*minmax\((?:calc\()?var\(--wk-row-min\)/,
  "grid-template-rows 的节次行下限必须引用 var(--wk-row-min)（允许 calc 包裹缩放系数）");
assert.match(wkGrid, /min-height:\s*calc\([^;]*var\(--wk-row-min\)/,
  "课程表网格必须有 min-height: calc(表头 + 节次数 × 行下限) —— 漏了它，矮窗口下末尾节次会被 " +
  "overflow:hidden 裁死且滚不到（溢出量还是 0，看不出来）");
// ⚠️ `.wakeup-scroll` 有两处（窄屏 `{display:none}` + 桌面自适应），必须取含 max-height 的那条。
const wkScroll = [...css.matchAll(/\.wakeup-scroll\s*\{[^}]*\}/g)].map((m) => m[0])
  .find((r) => r.includes("max-height")) ?? "";
assert.match(wkScroll, /flex:\s*1 1 0/, "课程表滚动容器要 flex:1 1 0 + min-height:0 才能被压到剩余空间");
assert.match(wkScroll, /max-height:\s*calc\([^;]*var\(--slot-count/,
  "帧高上限必须按 --slot-count 算（写死高度就没法随节次数自适应）");
assert.match(timeViews, /root\.style\.setProperty\("--slot-count"/,
  "--slot-count 必须挂在面板根节点：max-height 写在外层 .wakeup-scroll 上，变量只能向下继承");
const wkDesktop = css.match(/@media \(min-width: 761px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
assert.match(wkDesktop, /\.wakeup-view\s*\{[^}]*height:\s*100%/, "课程表的 flex 高度链必须写在桌面媒体块里");
assert.ok(!/^\.wakeup-view\s*\{[^}]*height:\s*100%/m.test(css),
  "基础态不能给 .wakeup-view 写 height:100% —— 手机上面板被限高后，超出一屏的内容会被 " +
  ".tv-panel 的 overflow:hidden 裁掉");

/* 🔴 回归 7：课时格的触控板 / 触控屏手势（v0.43.0，v0.71.0 起系数由全页统一供）。
   这几条都**不会**在普通单测里自然暴露（要真手势才看得见），但少一条用户就明显感到不对：
   ① `.wakeup-scroll` 必须 `touch-action:pan-x pan-y` —— 不写就回浏览器默认，
      双指在触控板上会被 WebView2 拿去做「页面缩放 / 前进后退」，课表纹丝不动。
   ② 课时格的 `--wk-zoom` 现在只是全页 `--tv-zoom` 的别名，且必须留在面板根 `.wakeup-view`
      这一层（JS 不再逐视图写系数）—— `.wakeup-scroll` 的 max-height 要读它，而 CSS 变量只向下继承。
   ③ wheel 监听必须 `{passive:false}` —— passive 下 preventDefault 是空操作，
      触控板捏合会去缩放整个 WebView（整个界面跟着变大），而不是只缩课表。
   ④ 课时格缩放**不能用 `zoom` 属性**（试过，是错的）：zoom 元素的内部可用宽高会被除以 zoom，
      而网格是 `height:100%` + `1fr` 铺满容器的 ⇒ 缩小时行高反而被拉大
      （实测 zoom=0.6 视觉行高 60.7px > zoom=1 的 58.1px，与直觉完全相反）。
      正确做法是「尺寸 × --wk-zoom」+ 子元素字号全走 em。
      （其余画布型视图相反：内部全是 px/% 定位，直接吃 CSS zoom 才对，见回归 8。）
   ⑤ 锚点必须用「滚动内容里的相对位置」，不能用绝对内容坐标 ——
      网格宽受 min-width、高受 height:100% / min-height 三重约束，缩放并非纯等比
      （实测 zoom 1 → 1.377 时网格宽只放大 1.11 倍），绝对坐标会漂 60px+。 */
assert.match(css, /\.wakeup-view\s*\{\s*--wk-zoom:\s*var\(--tv-zoom,\s*1\)\s*;?\s*\}/,
  "--wk-zoom 必须是 --tv-zoom 的别名并带 1 兜底：.wakeup-scroll 的 max-height 直接引用它，没兜底会整条失效");
assert.match(wkScroll, /touch-action:\s*pan-x pan-y/,
  "课程表滚动容器必须 touch-action:pan-x pan-y，否则双指平移会被浏览器抢去做页面缩放/前进后退");
assert.doesNotMatch(wkGrid, /(?:^|[;{\s])zoom\s*:/,
  "课程表网格不能用 zoom 属性缩放 —— zoom 会缩小内部可用宽高，与 height:100% + 1fr 冲突，" +
  "缩小时行高反而变大。要用尺寸 × var(--wk-zoom)");
assert.match(wkGrid, /font-size:\s*calc\(\s*\d+px\s*\*\s*var\(--wk-zoom\)(?:\s*\*\s*var\(--ui-text-scale\))?\s*\)/,
  "网格根字号必须走 calc(基准 px × var(--wk-zoom)[ × var(--ui-text-scale)])，子元素才能靠 em 一起缩放" +
  "（v0.55.0 起根字号还要乘 --ui-text-scale，否则「文字大小」管不到 em 子元素）");
// 子元素字号一律 em：改回 px 就会出现「格子缩了、字没缩」
for (const sel of [".wk-corner", ".wk-day", ".wk-slot b", ".wk-slot span", ".wk-course b", ".wk-course span", ".wk-course small"]) {
  const re = new RegExp(`\\${sel.replace(/ /g, "\\s+")}\\s*\\{[^}]*font-size:\\s*([^;}]+)`);
  const val = css.match(re)?.[1]?.trim();
  if (val == null) continue;
  assert.match(val, /em$/,
    `${sel} 的字号必须用 em（当前 ${val}）—— 用 px 就不会跟着 --wk-zoom 缩放`);
}
assert.match(timeViews, /root\.style\.setProperty\("--tv-zoom"/,
  "系数必须写在控制器拿到的那个 root（时间块视图容器）上：七种视图都是它的后代，" +
  "一处写七处生效");
assert.doesNotMatch(timeViewsCode, /setProperty\("--wk-zoom"/,
  "JS 不再逐视图写 --wk-zoom —— 它现在只是 CSS 里 --tv-zoom 的别名，两处写会打架");
assert.match(timeViews, /addEventListener\("wheel"[\s\S]{0,240}?\{ passive: false \}/,
  "wheel 监听必须 passive:false，否则 preventDefault 无效，触控板捏合会缩放整个 WebView");
assert.match(timeViews, /if \(!e\.ctrlKey\) return/,
  "必须只接管带 ctrlKey 的 wheel（Chromium 的触控板捏合 = ctrl+wheel），普通滚动要放行");
assert.match(timeViews, /ZOOM_MIN\s*=\s*[\d.]+,\s*ZOOM_MAX\s*=\s*[\d.]+/,
  "缩放必须有上下限常量");
assert.match(timeViews, /Math\.min\(ZOOM_MAX,\s*Math\.max\(ZOOM_MIN/,
  "缩放值必须钳制在 [ZOOM_MIN, ZOOM_MAX]，越界会让行高/字号算成 0 或巨大");
assert.match(timeViews, /\(scroll\.scrollLeft \+ px\)\s*\/\s*scroll\.scrollWidth/,
  "缩放锚点必须用「滚动内容里的相对位置」：网格宽高受 min-width / height:100% 约束，" +
  "缩放非等比，用绝对内容坐标会漂 60px+（内容从手指底下跑掉）");
assert.match(timeViews, /void scroll\.scrollWidth/,
  "改完 --wk-zoom 必须读一次 scrollWidth 强制同步布局，否则 scrollLeft 会被钳到旧范围");
{
  const setZoomBody = timeViews.match(/function setZoom\([\s\S]*?\n  \}/)?.[0] ?? "";
  const flushAt = setZoomBody.indexOf("void scroll.scrollWidth");
  const assignAt = setZoomBody.indexOf("scroll.scrollLeft =");
  assert.ok(flushAt > -1 && assignAt > -1 && flushAt < assignAt,
    "强制布局（void scroll.scrollWidth）必须排在 scrollLeft 赋值之前");
}
assert.match(timeViews, /settings\.timeViewZoom\s*=\s*z/,
  "缩放比例必须写进 settings 持久化，否则切走视图/重启就丢");
assert.match(timeViews, /clampZoom\(S\.getState\(\)\.settings\.timeViewZoom\)/,
  "恢复持久化缩放时也必须过 clampZoom：旧值或手改过的配置可能越界");

/* 🔴 回归 8：v0.71.0 七种视图共用一个缩放系数（`--tv-zoom`）+ 右上角三键。
   原来只有课时格能吃触控板捏合，另外六种视图捏上去是 WebView 自己整页放大。
   现在系数只有一处（时间块视图容器），CSS / JS 各自消费：
   ① 画布型视图（里程碑 / 年表 / 年度甘特 / 阶段甘特 / 卡片时间轴）内部全是 px 或 % 定位，
      直接吃 CSS `zoom` —— 一条规则整体等比放大，JS 一个系数都不乘。
      反过来若再乘一次就是二次放大（实测 62px 行在 1.5 倍下变 139.5px）。
   ② 日时间轴同理走 CSS zoom，但必须补 `min-width: calc(100% * var(--tv-zoom))`：
      zoom 元素的内部可用宽会被除以 zoom（实测），不补就越放大越截字。
      代价是指针落点要反过来除系数 —— timeblock.js 的 minFromY() 里那一次除法
      同时补上了「界面缩放」漏掉的那半截（root zoom 也是布局级的，rect 是物理像素）。
   ③ 卡片时间轴的轨道宽度带 94% 上限，而上限是物理不变量 ⇒ 轨道必须自己按系数线性变宽，
      外层还要有一层自己的滚动容器（.tv-panel 是 overflow:hidden，没处滚就直接裁掉右半边）。
   ④ 手势面靠 data-zoom-surface 声明：漏一个视图就是那块区域捏不动。 */
assert.equal([...timeViews.matchAll(/"data-zoom-surface":/g)].length, 6,
  "六种非日视图各要有一处手势面标记（日时间轴由 timeblock.js 直接挂 .tl-scroll）");
assert.match(timeblock, /renderTimeView\(altHost, viewMode, curDate, zoom\)/,
  "控制器必须传到 renderTimeView —— 不传就没有手势面，其余六种视图捏不动");
assert.match(timeblock, /attachViewZoomGestures\(scroll, zoom, \{ dblToReset: false \}\)/,
  "日时间轴要接手势，但双击不复位（双击会命中时间块弹菜单）");
assert.match(timeblock, /zoom\.flush\(\)/,
  "离开视图要把待落盘那一笔结掉：600ms 定时器不该跨视图存活");
for (const sel of [".tl-canvas", ".milestone-track", ".chronicle-canvas", ".gantt-grid", ".swim-grid", ".ct-zoom"]) {
  // 前面补一个反斜杠就是 `\.tl-canvas` —— 与上面 .wk-* 那段同一套写法
  const rule = css.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`))?.[0] ?? "";
  assert.match(rule, /zoom:\s*var\(--tv-zoom,\s*1\)/, `${sel} 必须吃 --tv-zoom（漏了就这一种视图捏不动）`);
}
assert.match(css, /\.tl-canvas\s*\{[^}]*min-width:\s*calc\(100%\s*\*\s*var\(--tv-zoom,\s*1\)\)/,
  ".tl-canvas 必须补 min-width: calc(100% * var(--tv-zoom)) —— zoom 元素内部可用宽被除以 zoom，" +
  "不补则越放大每行能放的字数越少（截字），放大反而看不清");
assert.doesNotMatch(timeblock, /PX_PER_MIN\s*\*\s*zoom/,
  "日时间轴的块几何不能再自己乘系数 —— CSS zoom 已经乘过一遍了（二次放大）");
assert.match(timeblock, /Math\.round\(\(\(y - rect\.top\) \/ viewScale\(\) - 10\)/,
  "指针落点必须先除以生效系数再换算分钟：rect 是物理像素，内联 top 是未缩放空间");
assert.match(timeblock, /getPropertyValue\("--ui-scale"\)/,
  "除的系数要含「界面缩放」的 root zoom，否则 150% 界面缩放下落点偏 1.5 倍");
assert.match(css, /\.card-timeline\s*\{\s*width:\s*max\(min\(840px,\s*94%\),\s*calc\((\d+)px\s*\*\s*var\(--tv-zoom,\s*1\)\)\)/,
  ".card-timeline 宽度必须 max(min(840px,94%), calc(Npx * 系数))：94% 上限不随 zoom 变长，" +
  "光靠原式两列卡片会压到中轴上");
{
  const laneMin = Number(css.match(/\.card-timeline\s*\{\s*width:\s*max\(min\(840px,\s*94%\),\s*calc\((\d+)px/)?.[1] ?? 0);
  assert.ok(laneMin >= 680,
    `轨道保底宽度要装得下两列（卡片 270 + 连线 70）×2 = 680px，当前 ${laneMin}`);
}
assert.match(timeViews, /class: "card-scroll"/, "卡片时间轴必须有横向滚动容器：放大后轨道必然宽过面板");
assert.match(css, /\.card-scroll\s*\{[^}]*overflow-x:\s*auto/, ".card-scroll 得真能横滚（.tv-panel 是 overflow:hidden）");
// 右上角三键：放大 / 默认 / 缩小，顺序即需求给的顺序
assert.match(timeViews, /class: "tv-zoombar"/, "必须有右上角缩放三键");
{
  const bar = timeViews.match(/const bar = el\("div", \{ class: "tv-zoombar"[\s\S]*?\);/)?.[0] ?? "";
  assert.match(bar, /btnIn, btnDefault, btnOut/, "三键顺序必须是「放大 / 默认 / 缩小」（需求原话的顺序）");
}
assert.match(timeViews, /btnIn\.disabled = cur >= ZOOM_MAX/, "顶到上限时 + 键要禁用：否则按下去没反应，像坏了一个键");
assert.match(timeViews, /btnOut\.disabled = cur <= ZOOM_MIN/, "顶到下限时 − 键同理");
assert.match(timeViews, /btnDefault\.addEventListener\("click", \(\) => set\(1\)\)/,
  "中间那颗就是「默认」：点一下回 100%");
const narrow8 = css.split("@media (max-width: 760px)").slice(1)
  .find((b) => b.includes(".time-viewlead { display:none")) ?? "";
assert.match(narrow8, /\.tv-zoom-btn\s*\{\s*min-width:\s*4[4-9]px;\s*height:\s*4[4-9]px/,
  "窄屏三键要长到 44px 以上（触控目标下限），与 .time-viewitem 同一档；" +
  "必须是 min-width —— 中间那颗是自适应宽度的读数，写死 width 会把「100%」裁掉");
assert.doesNotMatch(narrow8, /\.time-viewtoggle\s*\{\s*width:\s*100%/,
  "切换器不能再独占整行宽度 —— 右上角三键与它同一行，width:100% 会把三键挤出去");

/* 🔴 v0.70.0：课时格与「课程表」插件解耦。
   它只是「把时间线摆成课表样子」的一种视图样式，数据源恒为本周时间块；
   真实课表（学期/周次/节次/教师/教室）归「课程表」插件自己渲染。
   历史上这里直接读插件 storage 的 table，于是插件一改名/换 id 这个视图就空掉，
   而且用户分不清侧栏的「课程表」和这里的「课程表」是不是同一个东西。 */
assert.doesNotMatch(timeViews, /shiguang-schedule/,
  "课时格不许读「课程表」插件的课表 storage —— 数据源只能是时间块");
assert.doesNotMatch(timeViews, /storage\?*\.table/,
  "同上：课时格里不该出现课表 table 的读取路径");
assert.match(timeViews, /\["wakeup", "课时格"/,
  "视图名必须是「课时格」（内部 id 保持 wakeup，改 id 会让用户已存的视图选择失效）");
assert.match(timeViews, /const slots = Array\.from\(\{ length: 16 \}/,
  "节次行必须由时间块按小时生成（7:00 起 16 格），不能依赖外部节次表");

/* ───────────── v0.50.0：里程碑改成蛇形折返跑道 ─────────────
   原来是一条横向轨道排到底（12 个节点要滑很久），现在一行排满就掉头、
   下一行反向铺、行间用竖直段把两端接起来。
   折返之后「左右位置」不再等于时间先后 ⇒ 序号是必需品，不是装饰。
   几何判据（段中心与末节点中心对齐）由真浏览器探针兜着：
   技能 letime-settings-ui-probe 的 scripts/probe-milestone.cjs。 */
assert.match(timeViews, /const MS_COLS = 4;/,
  "一行排 4 个 —— 改这个数要同步 styles.css 的 grid-template-columns 与 min-width");
assert.match(timeViews, /const rev = \(start \/ MS_COLS\) % 2 === 1;/,
  "行方向必须逐行交替（奇数行反向），否则折返断在中间");
assert.match(timeViews, /"data-dir": rev \? "rev" : "fwd"/,
  "方向只能由 data-dir 表达：DOM 顺序恒为时间顺序，窄屏把每行拆成单列时才不必重排");
assert.match(timeViews, /class: "ms-pin" \}, String\(start \+ k \+ 1\)/,
  "节点必须带序号 —— 折返后光看左右位置已经看不出先后");
assert.match(timeViews, /const rail = rev \? \[\.\.\.colors\]\.reverse\(\) : colors;/,
  "反向行的跑道线渐变要跟着倒过来铺，否则颜色与节点对不上");

assert.match(css, /\.ms-row\[data-dir="rev"\]\s*\{\s*direction:\s*rtl;\s*\}/,
  "反向行用 direction:rtl 让 grid 自动放置从右往左（天然就是「倒序 + 靠右对齐」）");
assert.match(css, /\.ms-row\[data-dir="fwd"\]::before\s*\{\s*right:\s*calc\(12\.5% - 2px\);\s*\}/,
  "正向行的行间竖直段接在最右列中心（本行时间最晚的节点在那儿）");
assert.match(css, /\.ms-row\[data-dir="rev"\]::before\s*\{\s*left:\s*calc\(12\.5% - 2px\);\s*\}/,
  "反向行的竖直段要接在【最左】列中心：反向行的末节点在屏幕上落在最左列，写成 right 就接错端");
assert.match(css, /\.ms-row:last-child::before\s*\{\s*display:\s*none;\s*\}/,
  "最后一行不再往下接");
assert.match(css, /\.ms-row::before,\s*\.ms-row::after\s*\{\s*display:\s*none;\s*\}/,
  "窄屏把每行拆成单列，跑道线与行间竖直段必须一并收掉");
assert.match(css, /\.ms-row\[data-dir="rev"\] \.ms-arrow\s*\{\s*clip-path:\s*polygon\(100% 0,12% 0,0 50%,12% 100%,100% 100%,88% 50%\);\s*\}/,
  "反向行的箭头要指向那一行的行进方向（clip-path 左右镜像，尖与缺口对调）");
assert.match(css, /\.ms-row\[data-dir="rev"\] \.ms-arrow\s*\{\s*clip-path:\s*none;\s*\}/,
  "窄屏要显式复位箭头：桌面那条镜像规则 specificity 更高（0,3,0 > 0,1,0），"
  + "窄屏的 .ms-arrow{clip-path:none} 压不住它 —— 跨断点的覆盖只看 specificity，与书写顺序无关");

/* ───────────── v0.50.0：横向时间轴「时间堆积」修复 —— 长空档用省略号截断 ─────────────
   两个事件相隔太久（>60 天且占跨度 15%+）时，中轴不再按真实天数硬铺 ——
   长空档换成省略号芯片，省出的位置按天数比例还给密集段；
   段内再做「前推 + 后收」两遍扫描，密集事件不再叠卡。 */
assert.match(timeViews, /const gapThreshold = Math\.max\(60, Math\.round\(total \* 0\.15\)\)/,
  "「隔太久」必须同时满足绝对下限与相对占比：只看占比会把短跨度的普通间隔切碎，"
  + "只看天数在长跨度里又切不动（半年空档在十年轴上只占 5%）");
assert.match(timeViews, /if \(d > gapThreshold\) \{\s*\n\s*gaps\.push\(/,
  "必须先按长空档把事件切成密集段再分配位置 —— 直接线性映射，长空档会把密集段挤成一团");
assert.match(timeViews, /const step = Math\.min\(MIN_STEP, Math\.max\(1\.5, \(remaining - gaps\.length \* TAIL_UNIT\) \/ Math\.max\(1, events\.length - segments\.length\)\)\)/,
  "段内最小步长必须有兜底压缩：各段保底宽度放不下时压步长，而不是让卡片叠上");
assert.match(timeViews, /for \(let i = 1; i < px\.length; i\+\+\) px\[i\] = Math\.max\(px\[i\], px\[i - 1\] \+ step\);/,
  "段内落位必须「前推」：时间比例落位后，相邻间距不足 step 的事件要向右推");
assert.match(timeViews, /for \(let i = px\.length - 2; i >= 0; i--\) px\[i\] = Math\.min\(px\[i\], px\[i \+ 1\] - step\);/,
  "段内落位必须「后收」：只前推会把段尾挤出段外（比例位置贴近段尾时）；"
  + "宽度保底在手，后收不会把队首推出段外");
assert.match(timeViews, /class: "ce-gap"/, "桌面长空档必须渲染省略号芯片");
assert.match(timeViews, /title: `此处省略 \$\{g\.days\} 天（\$\{g\.from\} → \$\{g\.to\}）`/,
  "省略号芯片必须带悬浮说明：省略多少天、从哪天到哪天");
assert.match(timeViews, /gapCenters\.push\(end \+ \(GAP_UNIT - TAIL_UNIT\) \/ 2\)/,
  "芯片必须居中在「段尾尾巴 + 省略号区」的安静带里 —— 直接放在段边界上的话，"
  + "段尾事件的日期徽章（半宽约 38px）会压到芯片上");
assert.match(timeViews, /if \(d > gapThreshold\) vertical\.append\(el\("div", \{ class: "cv-gap" \}/,
  "窄屏纵向年表的长间隔也要给省略提示，两端语义一致");
assert.match(css, /\.ce-gap\s*\{[^}]*position:\s*absolute/, "桌面省略号芯片必须有定位样式");
assert.match(css, /\.ce-gap-mark\s*\{[^}]*background:\s*var\(--panel\)/,
  "芯片要垫 panel 底色盖住轴线 —— 否则渐变轴线从「⋯⋯」字缝里穿出来，不像断口");
assert.match(css, /\.cv-gap\s*\{/, "窄屏省略提示必须有样式");

/* ───────────── v0.70.0：年表画布宽度按事件数撑出来（修重叠） ─────────────
   用户截图：横向时间轴上卡片互相压住、一排日期徽章只看得见「2026-0」。
   无头实测（26 条事件）：画布写死 1500px ⇒ 一槽只有 53.4px，而卡片就要 150px，
   同侧相邻卡叠 43.2px；上下两排的日期徽章都骑在同一条轴带上、相邻只隔一槽，
   70.2px 的徽章叠 16.8px —— 被后一张盖掉后半截就剩下「2026-0」。共 49 对重叠。
   这不是某条 CSS 写错，是「画布宽度写死 + 位置按百分比算」的必然：
   百分比预算再怎么调都救不回「槽宽 < 内容宽」。所以画布宽度改成按事件数算。 */
assert.doesNotMatch(css, /\.chronicle-canvas\s*\{[^}]*min-width/,
  "画布宽度不许再写死在 CSS 里 —— 写死 1500px 时事件一多，槽宽就小于卡片宽度，卡片必然互叠");
assert.match(timeViews, /const SLOT_MIN = \(CARD_W \+ 18\) \/ 2;/,
  "一槽的下限必须由卡片宽度算出来：上下交错下同侧相邻卡隔【两】槽，"
  + "所以槽 ≥ (卡片宽 + 18) / 2。写成常量就会和卡片宽度脱节");
assert.match(timeViews, /const canvasW = Math\.max\(CANVAS_MIN, \(\(events\.length - 1\) \* SLOT_MIN/,
  "画布宽度必须随事件数增长 —— 密度交给 .chronicle-scroll 横向滚动承担，而不是让卡片互盖");
assert.match(timeViews, /class: "chronicle-canvas", style: `min-width:\$\{Math\.round\(canvasW\)\}px;--tl-card-w:\$\{CARD_W\}px`/,
  "算出来的宽度要挂到画布内联 min-width 上，并把卡片宽一起发给 CSS（--tl-card-w）—— "
  + "槽位算的就是这个宽，两边必须同源");
assert.match(css, /\.chronicle-event\s*\{[^}]*width:var\(--tl-card-w, 150px\)/,
  "卡片宽度必须吃 JS 发下来的 --tl-card-w，否则 JS 按 150px 算槽、CSS 用别的宽，又会叠");

// 日期徽章：横向宽度只由 MM/DD 五个字符决定，年份另起一行
assert.match(timeViews, /class: "ce-date" \}, shortDate\(e\.date\), showYear \? el\("i", \{ class: "ce-year" \}, year\)/,
  "徽章恒写 MM/DD、跨年时年份用 .ce-year 换行 —— 写成「2026/09/12」前缀会把徽章拉宽一倍，"
  + "而槽位是按 MM/DD 算的，轴带就又开始互盖");
assert.match(css, /\.ce-date\s*\{[^}]*white-space:nowrap/, "徽章不能换行折字");

// 卡片高度必须有上限：连线 / 圆点 / 徽章全按固定偏移排
assert.match(css, /\.ce-card b, \.ce-card span\s*\{[^}]*-webkit-line-clamp:2/,
  "标题与副文案各限两行。实测「文字大小」150% 下不封顶的卡片会长到 143.6px，"
  + "顺着把连线推进日期徽章带 —— 竖向重叠的来源");
assert.match(css, /\.ce-card b, \.ce-card span\s*\{[^}]*overflow-wrap:anywhere/,
  "卡片只有 150px，一条不沾空格的长链接能横着穿出邻卡");

// order 只在 flex 里生效：父级不开 flex，下排的连线就会掉到卡片下面、指向远离中轴的方向
assert.match(css, /\.chronicle-event\s*\{[^}]*display:flex;[^}]*flex-direction:column/,
  ".chronicle-event 必须是 flex 列 —— .down .ce-stem{order:-1} 靠它才生效，"
  + "块级布局下那条是死规则");

/* ───────────── v0.55.0：一种类型一种颜色 ─────────────
   用户截图指出：里程碑轴上同一个「工作」会变出蓝 / 绿 / 黄 / 紫四种颜色。
   根因是它按序号取 PALETTE。顺带查出全仓库有 4 套互不一致的分类映射
   （styles.css 的 .cat-block-*、timeline.js、timeblock.js、timeViews.js）——
   同一个「工作」在时间块视图是深青、在时间视图是蓝。现在只留 styles.css 的 --cat-* 一份。 */

// 1) 事实源：映射钉在 CSS，且必须是用户指定的那套（工作=黄 --sun、学习=蓝 --sea）
for (const [cat, token] of [["work", "sun"], ["study", "sea"], ["sport", "coral"], ["life", "grape"], ["rest", "mint"]]) {
  assert.match(css, new RegExp(`--cat-${cat}:\\s*var\\(--${token}\\)`),
    `分类 ${cat} 必须映射到 --${token} —— 这是「一种类型一种颜色」的唯一事实源`);
  assert.match(css, new RegExp(`--cat-${cat}-fg:`), `分类 ${cat} 必须有配套的前景色令牌`);
}

// 2) 里程碑按事件分类取色，不许再按序号
assert.match(timeViews, /const tones = slice\.map\(catTone\);/,
  "里程碑节点必须按事件的分类取色");
assert.doesNotMatch(timeViews, /PALETTE\[\(start \+ k\) % PALETTE\.length\]/,
  "按序号取彩虹色正是「同一种类型出现多种颜色」的来源（用户截图指出的就是这条）");

// 3) 其余视图里「有分类的元素」也不许按序号上色。
//    注意不能一刀切禁用 PALETTE：课时格里分类缺失的时间块要按序号兜底取色。
for (const [pattern, why] of [
  [/--ec:\$\{PALETTE\[i % PALETTE\.length\]\}/, "横向年表要按分类取色"],
  [/--ct:\$\{PALETTE\[i % PALETTE\.length\]\}/, "卡片时间轴要按分类取色"],
  [/--gm:\$\{PALETTE\[i % PALETTE\.length\]\}/, "年度甘特（窄屏按月）要按分类取色"],
  [/class: "gantt-bar"[^}]*background:\$\{PALETTE\[/, "年度甘特（桌面）要按分类取色"],
  [/PALETTE\[\(i \+ CATS\.indexOf\(cat\)\) % PALETTE\.length\]/, "泳道一行就是一个分类，条要用本行的分类色"],
]) {
  assert.doesNotMatch(timeViews, pattern, why);
}

// 3b) 🔴 只写「不许出现什么」是不够的 —— 变异实测漏过一次：
//     把泳道条改写成 PALETTE[(0 + 0) % PALETTE.length] 就不再匹配上面那条正则，断言却照样 PASS。
//     所以每条都要**正面**钉住实现表达式，且计数必须精确（多一处少一处都说明改错了地方）。
for (const [needle, count, why] of [
  ["--ms:${colors[k]};--tone-fg:${tones[k].fg}", 1, "里程碑节点"],
  ["--ec:${catTone(e).c};--tone-fg:${catTone(e).fg}", 2, "横向年表（桌面 + 窄屏各一处）"],
  ["--ct:${catTone(e).c}", 1, "卡片时间轴"],
  ["background:${catTone(r).c};--tone-fg:${catTone(r).fg}", 1, "年度甘特（桌面）"],
  ["--gm:${catTone(r).c}", 1, "年度甘特（窄屏按月）"],
  ["background:${CAT_COLOR[cat]};--tone-fg:${CAT_FG[cat]}", 2, "泳道（行标签 + 条）"],
]) {
  const got = timeViews.split(needle).length - 1;
  assert.equal(got, count, `${why} 必须用分类色（期望出现 ${count} 次，实际 ${got} 次）`);
}

// 4) 分类色只许引用令牌，不许在 JS 里再写一份十六进制表
assert.doesNotMatch(timeViews, /const CAT_COLOR = \{[^}]*#/, "timeViews 的 CAT_COLOR 不许写死十六进制");
assert.match(timeViews, /work: "var\(--cat-work\)"/, "CAT_COLOR 必须引用 --cat-* 令牌");
assert.match(read("../src/views/timeline.js"), /work: "var\(--cat-work\)"/,
  "timeline.js 的分类色必须与 timeViews 同源（历史上有 4 套，改一处漏三处）");
assert.match(read("../src/views/timeblock.js"), /work: "var\(--cat-work\)"/,
  "timeblock.js 的侧栏图例必须与 timeViews 同源");

// 5) 分类色块上的文字色：黄 / 红 / 青绿底偏亮，必须配深字（白字只有 2.2~2.8:1）
for (const sel of [".ms-arrow", ".ms-pin"]) {
  assert.match(css, new RegExp(`${sel.replace(".", "\\.")}\\s*\\{[^}]*color:\\s*var\\(--tone-fg,\\s*#fff\\)`),
    `${sel} 是「分类色块 + 文字」，文字色必须读 --tone-fg，不能写死 white`);
}
assert.match(timeViews, /--tone-fg:\$\{tones\[k\]\.fg\}/, "里程碑节点必须把前景色一起交给 CSS");
for (const sel of ["work", "sport", "rest"]) {
  assert.match(css, new RegExp(`--cat-${sel}-fg:\\s*#`),
    `${sel} 的底色偏亮，前景色必须是深色（不能沿用 --on-accent 的白）`);
}

// 6) 分类色当「文字」压在面板上时必须混向 --ink。
//    黄当背景配深字没问题，但当文字只有 2.26:1 —— 时间线视图的时间戳就是这种用法。
assert.match(css, /\.tlv-time\s*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--tc,\s*var\(--deep\)\)\s*55%,\s*var\(--ink\)\)/,
  "时间线视图的时间戳把分类色当文字用，必须混向 --ink");
assert.match(css, /\.wm-time\s*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--wk,\s*var\(--deep\)\)\s*55%,\s*var\(--ink\)\)/,
  "窄屏课表的时段文字可能吃到兜底的分类色，同样要混向 --ink");

console.log("PASS: 时间视图切换收进展开菜单（关闭语义 / 卸载清理）+ 7 个视图窄屏真适配（无横向溢出）"
  + " + 课时格手势（touch-action / 变量挂点 / passive:false / 非 zoom 缩放 / 相对锚点）"
  + " + 七视图共用 --tv-zoom 与右上角三键（CSS zoom 消费端 / 落点除系数 / 卡片轨道保底宽）"
  + " + 分类配色唯一事实源（一种类型一种颜色，按分类取色而非按序号）");
