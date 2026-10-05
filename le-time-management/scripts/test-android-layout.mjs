import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");
const css = read("../src/styles.css");
const shell = read("../src/shell.js");
const quadrant = read("../src/views/quadrant.js");
const appearance = read("../src/views/settings/appearance.js");

// Android 上四象限必须由内容撑高，让 .view 承担整页滚动。若继续继承桌面的
// height:100% + flex:1，四张卡会被压进一屏，卡内按钮虽在 DOM 中却被 overflow 裁掉。
// 断点保持 `px`。曾一度改成 `em`（理由是「em 媒体查询会跟着界面缩放走」），
// 实测证明该理由**不成立**：em 媒体查询按浏览器默认 16px 求值，zoom 与 html font-size
// 都改不动它（详见 styles.css 顶部那段「被实测推翻的旧结论」），已全部回退。
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.quad-wrap\s*\{[^}]*height:\s*auto[^}]*min-height:\s*100%/,
  "窄屏四象限容器必须按内容自然增高");
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.quad-grid\s*\{[^}]*flex:\s*none[^}]*grid-auto-rows:\s*max-content/,
  "窄屏象限网格不能继续参与剩余高度压缩");
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.q\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*overflow:\s*visible/,
  "窄屏象限不能裁掉任务与添加按钮");
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.q \.tks\s*\{[^}]*flex:\s*none[^}]*max-height:\s*none[^}]*overflow:\s*visible/,
  "窄屏任务列表应交给页面统一滚动");

// Android 没有桌面窗口概念，窗口按钮仍由桌面运行时门控。
// v0.81.0：顶栏改用共享指针拖拽，所有平台禁用 HTML5 draggable，避免竞争触摸点击。
assert.match(shell, /const desktopWindow = isDesktopRuntime\(\)/,
  "应用外壳必须识别桌面运行时");
assert.match(shell, /const windowControls = desktopWindow\s*\?\s*el\(/,
  "窗口控制按钮只应在桌面端创建");
assert.match(shell, /node\.draggable = false/,
  "顶栏已改用指针拖拽，Android 与桌面均不能再启动原生 HTML5 拖拽");
assert.doesNotMatch(shell, /node\.draggable\s*=\s*(true|desktopWindow)/,
  "不能重新启用与共享指针拖拽冲突的 HTML5 拖拽");
assert.match(shell, /attachToolbarDrag\(topbarActionCard/,
  "禁用原生拖拽后必须保留可用的顶栏指针拖拽入口");
assert.ok(shell.includes('desktopWindow ? (pinActionBtn = createQuickDockButton("thumbtack", "窗口置顶"'),
  "快捷入口中的窗口置顶必须由桌面运行时门控");
assert.match(appearance, /desktopWindow\s*\?\s*windowRow\s*:\s*null/,
  "Android 设置页不应显示无效的窗口大小控件");

// v0.37.13 回归：窄屏设置页横向溢出。分类导航 .settings-catalog 在 ≤980px 变横向滚动行
// （11 个 flex:0 0 200px 的导航项，min-content ≈ 2272px）。若 .settings-layout 继续写
// grid-template-columns: 1fr（自动最小 = min-content），轨道会被撑到 2272px，整页被顶出
// 屏幕右缘且 docWidth 不变（无横向滚动可救）。必须 minmax(0,1fr) + 侧栏 min-width:0，
// 让 overflow-x:auto 真正就地滚动。
const mobileSettings = css.split("@media (max-width: 980px)")[1]?.split("@media")[0] ?? "";
assert.match(mobileSettings, /\.settings-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  "窄屏设置布局必须用 minmax(0,1fr)，1fr 的自动最小值会被分类导航 min-content 撑爆");
assert.match(mobileSettings, /\.settings-sidebar\s*\{[^}]*min-width:\s*0/,
  "窄屏设置侧栏必须 min-width:0，否则横向分类行把整页顶出屏幕");

// v0.37.15 回归 1：任务卡标题必须换行让卡片随内容变高。
// 旧版写 white-space:nowrap + text-overflow:ellipsis，标题被截断、卡片高度恒定。
// 改回 nowrap 就会退化成「文字太多看不到」（用户反馈「当字太多时卡片变高」）。
const tkcRule = css.match(/\.tkc \.tt \.t\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(tkcRule, "必须存在 .tkc .tt .t 规则");
assert.match(tkcRule, /white-space:\s*normal/, "任务卡标题必须允许换行，卡片才能随文字变高");
assert.doesNotMatch(tkcRule, /text-overflow:\s*ellipsis/, "任务卡标题不能再走省略号截断");
assert.doesNotMatch(tkcRule, /white-space:\s*nowrap/, "任务卡标题不能再 nowrap");
assert.match(tkcRule, /overflow-wrap:\s*anywhere/, "超长连续字符（无空格）也要能断行，否则撑破卡片");
// 卡片纵向内边距方向必须是「首行对齐」，否则变高后复选框/徽标会跑到垂直居中
assert.match(css, /\.tkc\s*\{[^}]*align-items:\s*flex-start/, "任务卡在变高后复选框应贴首行，不能垂直居中");
assert.match(quadrant, /class: "tt-top"/, "标题与展开箭头必须包在 .tt-top 里同处一行");
assert.match(quadrant, /const expandable = hasNote;/, "标题不再截断后，展开只服务于备注，不再看标题长度");

// v0.58.0 回归：顶栏 5 键合一框（用户需求「有把这5个按钮做到1个方框里面吗」）。
// 前史：v0.37.15/v0.39.0 因「框太多」去掉外层框、闪电/搜索/窗口键各自带小框；
// v0.58.0 用户要求反转 —— 5 个键收进同一个方框。规则：外框有边框+底色，
// **内层按钮一律裸图标无边框**（嵌套框才是当年「框太多」的本意），
// hover/激活用底色表达。
// 注意：共享规则 `.topbar-title-card, .topbar-action-card { border: 1px … }` 依然存在
// （标题卡要用），方框判定必须落在靠后的那条覆盖规则上。
const actionCardRules = [...css.matchAll(/\.topbar-action-card\s*\{([^}]*)\}/g)].map((m) => m[1]);
// v0.58.0 方框覆盖规则的特征：4px 内边距 + 边框 + 渐变底色（与 2068 行的共享规则
// `.topbar-title-card, .topbar-action-card` 区分开 —— 那条是标题卡用的 8px 12px）。
const framed = actionCardRules.find((r) => /padding:\s*4px/.test(r) && /border:\s*1px/.test(r) && /background:\s*linear-gradient/.test(r)) ?? "";
assert.ok(framed, "顶栏工具必须恢复带边框+渐变底色的方框规则（5 键合一框，v0.58.0）");
// 内层三件套必须去框：嵌套框 = 当年「框太多」的回归。
// 判定「任一 .topbar-action-card .X … {…} 规则块含 border:0」——
// 同一选择器在文件里有多条（2128 附近的 margin-right 覆盖、hover 规则等），
// 只要去框那条存在即可；注意搜索/快捷入口的去框是合体选择器（逗号分隔），
// 正则要跨过 `,\n.sel {` 到达块体，用 [^{]* 而不是 \s*。
const innerBlocks = (sel) => [...css.matchAll(new RegExp(sel + "[^{]*\\{([^}]*)\\}", "g"))].map((m) => m[1]);
for (const [sel, name] of [
  ["\\.topbar-action-card \\.top-search", ".top-search（搜索）"],
  ["\\.topbar-action-card \\.top-mini-btn", ".top-mini-btn（快捷入口）"],
  ["\\.topbar-action-card \\.window-controls", ".window-controls（窗口三键组）"],
]) {
  const bodies = innerBlocks(sel);
  assert.ok(bodies.length >= 1, `内层 ${name} 必须有卡内作用域规则`);
  assert.ok(
    bodies.some((b) => /border:\s*0/.test(b)),
    `${name} 在方框内必须去边框（嵌套框 = 「框太多」回归）`,
  );
}
assert.ok(
  innerBlocks("\\.topbar-action-card \\.window-controls").some((b) => /background:\s*transparent/.test(b)),
  ".window-controls 必须显式透明底色（不再做独立胶囊）",
);

// v0.57.0 回归：顶栏工具行改「图标一行 + 统计居中」。
// ① 搜索钮必须是纯放大镜图标（用户原话「搜索/命令也弄成一个放大镜图标，不用文字」）：
//    DOM 里不许再出现文字 label 与 Ctrl K 角标 —— 结构回退（重新塞回
//    top-search-label / <kbd>）而 CSS 没跟着回退时，按钮会被 34px 瓷砖裁成残废。
assert.ok(shell.includes("faIcon(\"magnifying-glass\")"), "搜索钮必须用 Font Awesome 放大镜图标");
assert.ok(shell.includes("top-search-glyph"), "放大镜字形必须有专用容器（.top-search-glyph）");
assert.match(shell, /top-search-label/, "桌面默认布局包含搜索文字");
assert.match(css, /\.top-search-label\s*\{\s*display:\s*none/, "窄屏和原自定义布局仍使用纯图标");
assert.match(css, /@media \(min-width: 901px\)[\s\S]*\.topbar-reference \.top-search-label\s*\{\s*display:\s*inline/, "搜索文字仅在桌面新默认布局显示");
assert.doesNotMatch(shell, /class: "top-search"[\s\S]{0,200}<kbd/, "搜索钮里不许再挂 Ctrl K 角标");
// ② 瓷砖规格：34×34 方形、零内边距、居中放字形 —— 与快捷入口 / 窗口钮同高同排。
const topSearchRule = css.match(/\.top-search\{[^}]*\}/)?.[0] ?? "";
assert.match(topSearchRule, /width:\s*34px/, "搜索图标钮必须是 34px 宽的瓷砖");
assert.match(topSearchRule, /height:\s*34px/, "搜索图标钮必须是 34px 高（与快捷入口/窗口钮同排）");
assert.match(topSearchRule, /padding:\s*0/, "图标瓷砖不能保留横向内边距（旧文字态残留会撑成椭圆)");
assert.doesNotMatch(css, /\.top-search kbd/, "kbd 角标样式必须随 DOM 一并移除");
// ③ 统计默认居中：居中规则必须存在，且默认值翻转为 true（归一化断言在 test-ui-preferences.mjs）。
assert.match(css, /\[data-center-top-stats="on"\]\s+\.topbar-action-card\s*>\s*\.pill\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%/,
  "统计居中必须由 data-center-top-stats=on 驱动（绝对定位水平居中）");
// ④ 拖动排序保留：居中只是默认姿态，四个部件仍可在顶栏一行内自由换位。
assert.ok(shell.includes("TOPBAR_PARTS"), "顶栏四部件（search/quick/stats/window）清单必须保留");
assert.match(shell, /moveTopbarPart/, "拖动换位逻辑必须保留（用户：可以自由拖动切换位置）");

// ⑤ v0.58.0：顶栏加深浅色切换键 + 整框贴右（用户需求「这一套按键放在右边，并且
//    添加深色和浅色切换按钮」）。
//    部件清单：theme 必须在列，且 window 恒排最后（窗口键贴最右的 Windows 习惯）。
const topbarPartsDecl = shell.match(/const TOPBAR_PARTS = \[([^\]]*)\]/)?.[1] ?? "";
const topbarPartIds = topbarPartsDecl.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
assert.ok(topbarPartIds.includes("theme"), "TOPBAR_PARTS 必须含 theme（顶栏深浅切换键）");
assert.equal(topbarPartIds[topbarPartIds.length - 1], "window", "TOPBAR_PARTS 里 window 必须排最后");
// 老存档升级：新增部件补尾时必须插到 window 之前（否则新键排到窗口键右边）
assert.match(shell, /indexOf\("window"\)/, "topbarOrderState 必须把新增部件插到 window 之前");
// 按钮接线：切换走 setThemeMode（与侧栏/设置页同一动画路径），图标随亮暗翻转
assert.match(shell, /top-theme-toggle/, "顶栏必须有 .top-theme-toggle 按钮");
assert.match(shell, /paintTopTheme/, "顶栏主题键图标必须由 paintTopTheme 统一刷新");
assert.ok(
  (shell.match(/new MutationObserver\(paintTopTheme\)/g) || []).length === 1,
  "顶栏主题键必须用 MutationObserver 监听 data-theme-mode（跟随系统时系统亮暗翻转也要刷新）",
);
// 整框贴右：margin-left 必须 auto（12px 会让无 strip 的环境贴在标题卡后面）
const actionCardFramed = actionCardRules.find((r) => /padding:\s*4px/.test(r)) ?? "";
assert.ok(actionCardFramed, "v0.58.0 方框规则必须存在（前文断言）");
const marginAutoRule = actionCardRules.find((r) => /margin-left:\s*auto/.test(r)) ?? "";
assert.ok(marginAutoRule, ".topbar-action-card 必须 margin-left:auto 贴顶栏右侧");
// 瓷砖规格：34×34 方形、padding 归零（.top-mini-btn 的横向 padding 会把它撑成椭圆）
const themeBtnRule = css.match(/\.topbar-action-card \.top-theme-toggle\s*\{[^}]*\}/)?.[0] ?? "";
assert.match(themeBtnRule, /width:\s*34px/, "顶栏主题键必须 34px 宽（对齐搜索瓷砖）");
assert.match(themeBtnRule, /padding:\s*0/, "顶栏主题键必须归零横向 padding（top-mini-btn 残留会撑成椭圆）");

// v0.39.0 回归：顶栏标题左侧小框回归（紧凑版）。前史：v0.38.2 之前是一颗 42×42
// 死框、恒装 Le 应用图标，用户嫌噪音删掉（v0.38.2）；随后用户回头表示想要框 ——
// 但要小（不顶开顶栏两条横线），且图标必须跟随当前视图（插件页 = 插件自己的图标）。
assert.ok(shell.includes("topbar-title-mark"), "标题卡里必须有 .topbar-title-mark 小框");
assert.ok(shell.includes("renderTitleMark"), "小框图标必须随视图切换刷新（renderTitleMark）");
assert.ok(shell.includes("class: \"topbar-title-copy\""), "标题卡里必须保留 .topbar-title-copy（标题 + 副标题）");
// 紧凑尺寸：桌面 28px / 窄屏 24px。超过 30px 就会顶开标题卡、把卡推出顶栏两条横线
// （42px 死框当年就是这么压顶的），低于 20px 图标糊成一团。
const markSizeRules = [...css.matchAll(/\.topbar-title-mark\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(markSizeRules.length >= 2, "桌面与窄屏各应有一条 .topbar-title-mark 规则");
for (const rule of markSizeRules) {
  const w = Number(rule.match(/width:\s*(\d+)px/)?.[1] ?? 0);
  const h = Number(rule.match(/height:\s*(\d+)px/)?.[1] ?? 0);
  assert.ok(w >= 20 && w <= 30, `小框宽度必须是 20~30px 的紧凑规格，实际 ${w}px`);
  assert.ok(h >= 20 && h <= 30, `小框高度必须是 20~30px 的紧凑规格，实际 ${h}px`);
  assert.equal(w, h, "小框必须是正方形");
}
assert.match(css, /\.topbar-title-mark\s+\.app-icon/, "小框内部的 .app-icon 必须有尺寸规则（否则回落 30px 撑破小框）");
// 图标来源：插件页走 pluginDisplayIcon（含用户自定义图标覆盖），不许再装死的 app 图标。
assert.ok(shell.includes("pluginDisplayIcon(def.pluginView.pluginId"), "插件页小框必须装插件自己的图标");
assert.doesNotMatch(shell, /titleMark\.append\(appIcon\("quadrant"\)\)/, "小框不许恒装四象限应用图标（回到 v0.38.2 之前的老毛病）");
// 小框左侧占位后，标题卡内边距仍要左右对称，否则标题会偏左贴边。
// 注意不能只看 `padding:` 简写：`padding: 8px 12px` 配上一条 `padding-right: 16px`
// 就是不对称的，而简写本身看起来完全正常（第一版断言就是这么漏过的）。
const titleCardRules = [...css.matchAll(/\.topbar-title-card\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(titleCardRules.length >= 2, "桌面与窄屏各应有一条 .topbar-title-card 规则");
for (const rule of titleCardRules) {
  const parts = (rule.match(/(?:^|;)\s*padding:\s*([^;]+)/)?.[1] ?? "0").trim().split(/\s+/).filter(Boolean);
  const base = { top: parts[0] ?? "0", right: parts[1] ?? parts[0] ?? "0", bottom: parts[2] ?? parts[0] ?? "0", left: parts[3] ?? parts[1] ?? parts[0] ?? "0" };
  const long = (side) => rule.match(new RegExp(`(?:^|;)\\s*padding-${side}:\\s*([^;]+)`))?.[1]?.trim() ?? base[side];
  assert.equal(long("left"), long("right"), `标题卡内边距要左右对称，实际 left=${long("left")} right=${long("right")}`);
}

// v0.37.15 回归 3：APK 桌面图标名必须是「U-Time」。
// MainActivity 上的 activity 级 android:label 会覆盖 application 级 app_name，图标名变成
// 「U-Time · 时间块与四象限」，手机桌面放不下被截断。
// gen/ 是 gitignored，手改会在下次 `tauri android init` 时丢 —— 所以这条清理逻辑
// v0.38.0 起搬到了 tools/sync-android-native.js（幂等补丁），由构建脚本在打包前调用。
// 断言因此落在「工具里有这条规则」+「构建脚本确实调了它」两点上。
const androidBuild = read("../scripts/build-android-apk.sh");
const androidSync = read("../../tools/sync-android-native.js");
assert.match(androidBuild, /sync-android-native\.js/, "Android 构建脚本必须在打包前同步版本化的原生代码");
assert.match(androidSync, /android:name="\\\.MainActivity"/,
  "必须按 android:name 精确定位 MainActivity，不能误删教务窗口的 label");
assert.match(androidSync, /main_activity_title/, "必须移除 MainActivity 对 main_activity_title 的引用");
assert.match(androidSync, /REQUEST_INSTALL_PACKAGES/,
  "必须幂等补上安装未知来源应用权限，否则应用内一键升级在 Android 8+ 上会被系统静默拦掉");

// v0.37.16 回归：状态栏 / 设置页顶部重叠。
// Android WebView **不实现 env(safe-area-inset-*)**（取值恒为 0，viewport-fit=cover 也没用），
// 而 MainActivity 的 enableEdgeToEdge() 让状态栏变成透明浮层盖在网页上 ——
// 顶栏从屏幕绝对顶部开始画，标题与关闭按钮被信号/电量图标压住。
// 解法：原生侧读 WindowInsets 注入 --sat/--sab/--sal/--sar，前端走 var(..., env(...)) 双路。
// 读版本化镜像而不是 gen/android —— 后者 gitignored，全新 clone 上这个测试会直接 ENOENT。
// 镜像由 tools/sync-android-native.js 同步进 gen（--check 守两者一致）。
const mainActivity = read("../android/gradle/app/src/main/java/com/yile/letime/MainActivity.kt");
assert.match(mainActivity, /getInsets\(WindowInsetsCompat\.Type\.systemBars\(\)\)/,
  "MainActivity 必须读 systemBars 的真实 inset，否则 edge-to-edge 下顶栏必然压状态栏");
assert.match(mainActivity, /setProperty\('--sat'/,
  "必须把状态栏高度注入成 CSS 变量 --sat");
assert.match(mainActivity, /setProperty\('--sab'/,
  "必须把导航栏高度注入成 CSS 变量 --sab");
// v0.49.0 回归：键盘弹出整屏只剩背景色（轮换值日插件输成员名字必现）。
// 旧写法 `val bottom = maxOf(bars.bottom, ime.bottom)` 把 --sab 撑到键盘高（~370px），
// .view 的 padding-bottom / toast / 抽屉底栏全部暴涨 —— 页面被凭空撑长一大截，
// 聚焦输入框时 Chrome scrollIntoView 把 WebView 滚进这段空白 → 整屏只剩背景色。
// 修复：--sab 回归纯导航栏；键盘 inset 由 WebView 自己消费（bottomMargin 压缩网页视口）。
// ⚠️ 判定前剥掉 Kotlin 注释（/* */ 与 //）—— 本文件的说明性注释会引用旧写法文本，会误伤自己。
const ktNoComment = mainActivity.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
assert.doesNotMatch(ktNoComment, /maxOf\(bars\.bottom,\s*ime\.bottom\)/,
  "--sab 严禁掺 ime：键盘高度会撑爆 CSS 布局（黑屏根因），键盘避让必须走 WebView ime listener");
assert.match(mainActivity, /setOnApplyWindowInsetsListener\(webView\)/,
  "必须给 WebView 挂 ime inset listener：edge-to-edge 下 adjustResize 不生效、adjustPan 只挪窗口，" +
  "不消费 ime 的话输入框会被键盘盖住且视口不变");
assert.match(mainActivity, /bottomMargin\s*=\s*ime\.bottom/,
  "ime 避让必须用 bottomMargin 压缩 WebView 视口 —— WebView 不尊重 padding，网页会铺满 view 边界");
assert.match(mainActivity, /WindowInsetsCompat\.Builder\(insets\)/,
  "WebView 消费 ime 后必须剥掉 ime 再往下传（防子层级二次消费）");
// 四个方向都要：横屏与折叠屏展开时挖孔会跑到侧边，只补 top 不够。
for (const v of ["--sal", "--sar"]) {
  assert.ok(mainActivity.includes(`setProperty('${v}'`), `必须注入 ${v}（横屏刘海安全区）`);
}
assert.match(mainActivity, /onPageFinished/,
  "页面加载完必须补注入一次：新文档会重置 documentElement 的内联样式变量");

// CSS 侧：所有安全区取值都必须是「var(注入值, env(原生)) 」双路。
assert.doesNotMatch(css, /(?<!\))\benv\(safe-area-inset-[a-z]+,\s*0px\)(?!\))/,
  "安全区不能裸用 env()：Android WebView 里恒为 0，会被直接压到状态栏");
const satUses = [...css.matchAll(/var\(--s(?:at|ab|al|ar),\s*env\(safe-area-inset-[a-z]+,\s*0px\)\)/g)].length;
assert.ok(satUses >= 15, `安全区必须统一走 var(--s…, env(…)) 双路，当前只匹配到 ${satUses} 处`);
// 🔴 :root 里绝不能给 --sat/--sab/… 定义默认值：变量一旦有有效值，
// var() 的第二参数永不生效，iOS / 桌面的原生 env() 会被彻底废掉。
// 先剥掉注释再判定，否则本文件的说明性注释会被自己误伤。
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, "");
const rootBlock = cssNoComment.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.doesNotMatch(rootBlock, /--s(?:at|ab|al|ar)\s*:/,
  ":root 不能定义 --sat/--sab/--sal/--sar 默认值，否则 var() 的 env() 兜底永远不生效");
// 手机端顶栏必须同时吃 top 与左右：竖屏补 top，横屏挖孔在侧边。
// 注意：全文件有 8 个 max-width:760px 查询，必须按「哪一块里有 .topbar」来定位，
// 不能取第一个 —— 否则断言落在错误的块上（本回归的第一次写法就踩了这个坑）。
const topbarRule = css.match(
  /\.topbar\s*\{[^}]*?padding-left:\s*calc\([^}]*?var\(--sal[^}]*?\}/,
)?.[0] ?? "";
assert.ok(topbarRule, "窄屏顶栏必须有一条同时含 padding-left: calc(… var(--sal …)) 的规则");
assert.match(topbarRule, /padding-top:\s*var\(--sat/,
  "窄屏顶栏必须吃掉 --sat，否则标题压状态栏");
assert.match(topbarRule, /padding-right:\s*calc\([^)]*var\(--sar/,
  "窄屏顶栏必须吃掉 --sar（横屏刘海）");

/* ───────────── v0.37.17 回归 1：Android 返回键 ─────────────
   Tauri 的 TauriActivity 把 wry 的 handleBackNavigation 固定成了 false（wry 自己是 true），
   于是返回键完全不碰 WebView 历史、直接 finish 掉 Activity —— 用户看到「一按返回就退出软件」。
   必须覆盖回 true（wry 便成了「能回退就 goBack，不能才 finish」），
   再由前端 src/backNav.js 压历史：视图格 + 浮层格。 */
// 同上：读版本化镜像（gen/android 不进 git）
const mainActivityBack = read("../android/gradle/app/src/main/java/com/yile/letime/MainActivity.kt");
assert.match(mainActivityBack, /override\s+val\s+handleBackNavigation\s*:\s*Boolean\s*=\s*true/,
  "MainActivity 必须把 handleBackNavigation 覆盖回 true，否则返回键绕过 WebView 直接退出应用");

const backNav = read("../src/backNav.js");
assert.match(backNav, /export\s+function\s+initBackNav/, "必须存在返回键历史栈模块");
assert.match(backNav, /export\s+function\s+noteViewChange/, "切视图要能给历史栈压一格");
// 遮罩类名清单是这份文件唯一要跟着浮层一起维护的地方，漏一个就有浮层关不掉。
assert.match(backNav, /const OVERLAY_SELECTOR = "[^"]*\.drawer-mask[^"]*\.cmd-mask[^"]*\.cap-mask[^"]*"/,
  "浮层遮罩类名清单要齐全：命令面板 .cmd-mask、捕获浮层 .cap-mask 最容易漏");
assert.match(backNav, /ltmGuard/, "浮层格标记不能丢，否则返回键会连视图一起退掉");
assert.match(shell, /initBackNav\(\{[\s\S]{0,160}applyView/, "外壳必须在首屏视图定下来后挂上历史栈");
assert.match(shell, /if \(opts\.history !== false\) noteViewChange\(targetId\)/,
  "只有真正切视图才压历史；程序性重渲染压栈会让返回键要多按好几下");
assert.ok((shell.match(/switchTo\([^)]*\{ history: false \}/g) || []).length >= 4,
  "程序性重渲染的几处调用都要带 { history: false }（刷新视图 / 注册表回正 / 首屏）");

/* ───────────── v0.37.17 回归 2：双指缩放 ─────────────
   Android WebView 默认 builtInZoomControls = false，叠加 index.html 里 viewport 的
   user-scalable=no，双指缩放完全没反应。原生侧打开缩放机制，前端只在手持设备上
   放开 user-scalable —— 两边缺一不可，桌面必须保持原样。 */
assert.match(mainActivityBack, /setSupportZoom\(true\)/, "原生必须显式 setSupportZoom(true)");
assert.match(mainActivityBack, /builtInZoomControls\s*=\s*true/, "必须打开 WebView 的内置缩放机制");
assert.match(mainActivityBack, /displayZoomControls\s*=\s*false/,
  "内置缩放自带的 +/- 悬浮件要藏起来，否则会浮在界面上");

const mobileViewport = read("../src/mobileViewport.js");
assert.match(mobileViewport, /maximum-scale=5\.0/, "手机 viewport 要把放大上限放开");
// 剥掉注释再判定 —— 本模块的说明性注释里就写着旧的 user-scalable=no，否则会误伤自己。
const mobileViewportCode = mobileViewport
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
assert.doesNotMatch(mobileViewportCode, /user-scalable=no/, "手机上不能再写 user-scalable=no");
assert.match(mobileViewport, /Android\|iPhone\|iPad\|iPod/, "只有手持设备才放开缩放");
const mainJs = read("../src/main.js");
assert.match(mainJs, /applyTouchZoomViewport\(\);\s*\n\s*await initStore/,
  "必须在首屏渲染前改 viewport，否则第一帧仍按旧的 user-scalable=no 排版");
// 桌面 index.html 保持原样：窗口缩放交给应用自己的「启动窗口大小」设置，
// Ctrl+滚轮放大只会让用户以为界面坏了。
assert.match(read("../index.html"), /name="viewport"[^>]*user-scalable=no/,
  "桌面的 viewport 不能顺手放开，缩放只对手机生效");

/* ───────────── v0.37.17 回归 3：窄屏设置页手风琴 ─────────────
   手机上原来是「横向分类 chip 行 + 一次只显示一块内容」：11 个分类要横着滑才看得全，
   当前分类下面还有什么完全看不见。窄屏改成手风琴（标题行 + 方向箭头，可就地收放），
   桌面仍用左栏分类，标题行必须隐藏。 */
// 作者样式里 .settings-acc 有 display:block，会盖掉 UA 的 [hidden] ——
// 少了这条 !important，11 个分区会全部堆在设置页上。
assert.match(css, /\.settings-acc\[hidden\]\s*\{\s*display:\s*none\s*!important/,
  "必须显式写 .settings-acc[hidden] { display:none !important }，否则隐藏属性失效");

const narrowBlocks = css
  .split(/@media \(max-width: 980px\)/)
  .slice(1)
  .map((chunk) => chunk.split(/\n@/)[0]);
// 按「哪一块里有 .settings-acc-open」定位手风琴块 —— 基础规则（.settings-acc-head 的
// display:none）落在前一个 980px 块之后，按 .settings-acc-head 找会落在错误的块上。
const accordion = narrowBlocks.find((block) => block.includes(".settings-acc-open")) ?? "";
assert.ok(accordion, "必须存在窄屏手风琴的媒体块");
assert.match(accordion, /\.settings-acc-head\s*\{[^}]*display:\s*flex/, "窄屏要把分类标题行显示出来");
const accordionHeadHeight = Number(accordion.match(/\.settings-acc-head\s*\{[^}]*min-height:\s*(\d+)px/)?.[1] || 0);
assert.ok(accordionHeadHeight >= 44, "标题行触控区要够高（≥44px），拇指才点得住");
assert.match(accordion, /\.settings-acc-open \.settings-acc-arrow\s*\{[^}]*transform:\s*rotate\(180deg\)/,
  "展开时方向箭头要掉头，否则看不出可收放");
assert.match(accordion, /\.settings-catalog\s*\{\s*display:\s*none/,
  "窄屏要收掉横向 chip 行：分类切换已由标题行承担，两个入口重复又占首屏");

// 桌面：标题行隐藏，仍是「左侧分类 + 右侧单页」。
const accHeadBase = css.match(/\.settings-acc-head\s*\{([^}]*)\}/)?.[1] ?? "";
assert.match(accHeadBase, /display:\s*none/, "桌面必须隐藏标题行，分类切换仍交给左栏");

const navigatorSrc = read("../src/views/settings/navigator.js");
assert.match(navigatorSrc, /class:\s*"settings-acc-arrow"/, "每个分区标题行都要有方向箭头");
assert.match(navigatorSrc, /return \{ node, apply, select, panels, dispose \}/,
  "navigator 必须把 panels 暴露出去");
assert.match(read("../src/views/settings.js"), /\.\.\.settingsNavigator\.panels/,
  "设置视图要渲染 navigator 给的 panels，否则手风琴结构根本不生效");

/* ───────────── v0.49.1 回归：窄屏进设置页先给分类目录，不预展开 ─────────────
   原先窄屏一进设置页就展开当前分类（「界面与交互」），11 个分区里只看得见它，
   其余分类被挤到屏幕外。现在初始不展开任何分区，展开与否全由用户点标题行决定。 */
assert.ok(!/expanded\.add\(active\)/.test(navigatorSrc),
  "窄屏不许在初始化 / 断点变化时预展开当前分类（v0.49.1：一进来先给一张分类目录）");
assert.match(navigatorSrc, /^\s*const syncExpanded = \(\) => \{ state\.expanded = \[\.\.\.expanded\]; \};\s*$/m,
  "展开状态必须写回 state：改一项设置会整页重建，状态只存局部变量会让展开的面板当场塌掉");
assert.match(navigatorSrc, /^\s*let expanded = new Set\(Array\.isArray\(state\.expanded\) \? state\.expanded : \[\]\);\s*$/m,
  "重建时要读回 state.expanded，否则上面那句写了也白写");
assert.match(read("../src/views/settings.js"), /settingsNavState\.expanded = \[\];/,
  "每次打开设置页要清空展开集合：重新进来仍是目录态，不记住上次展开");

/* ───────────── 窄屏回归：分区末尾的「收起」按钮 ─────────────
   展开的分区（如「主题」的十几张色板卡）比一屏长得多，标题行早就滚出屏幕外，
   手机上想收起只能一路往上翻。所以每个分区内容末尾给一颗就地收起的按钮。 */
assert.match(navigatorSrc, /class:\s*"settings-acc-collapse"/,
  "每个分区都要在内容末尾挂一颗「收起」按钮，否则手机上收不起长分区");
assert.match(navigatorSrc, /class:\s*"settings-acc-body"[^)]*entry\.node,\s*collapseBtn/,
  "「收起」必须挂在 .settings-acc-body 里：分区收起时按钮要跟着内容一起消失");
assert.match(navigatorSrc, /onclick:\s*\(\)\s*=>\s*collapseSection\(entry\.id\)/,
  "按钮要点名收自己所在的分区，不能收错");
assert.match(navigatorSrc, /function collapseSection[\s\S]{0,200}scrollIntoView/,
  "收起后要把标题行滚回视口顶部，否则视线会停在别的分区中间");
assert.match(css, /\.settings-acc-collapse\s*\{\s*display:\s*none/,
  "桌面（左栏分类，无收放概念）必须隐藏这颗按钮");
assert.match(accordion, /\.settings-acc-collapse\s*\{[^}]*display:\s*flex/, "窄屏要显示分区末尾的收起按钮");
assert.match(accordion, /\.settings-acc-collapse\s*\{[^}]*min-height:\s*(4[4-9]|[5-9]\d)px/,
  "收起按钮触控区要 ≥44px，拇指才点得住");

/* ───────────── v0.51.0 回归：任务抽屉「提前预警」布局 ─────────────
   旧版把 7 个 chip + 自定义输入框 + 「添加」按钮**一起**丢进 `.reminder-picks` 的
   flex-wrap 流里，再加 `justify-content:flex-end; max-width:245px` ⇒
   实测 900/1280px 档折成 3 行、行尾对齐行首飘、右侧一半空间全空，
   第 3 行只剩「到点」孤零零一个（用户截图反馈「太乱」）。

   修法：拆成「chips 容器」+「输入行」两组，并把这一行改成竖排让 chips 拿到全宽。 */
const drawerSrc = read("../src/views/drawer.js");

// ① 输入框与「添加」必须渲染进独立的 `.reminder-custom-row`，不能留在 chips 容器里。
assert.match(drawerSrc, /const reminderCustom = el\("div", \{ class: "reminder-custom-row" \}\)/,
  "「自定义分钟 + 添加」必须有独立容器，混进 chips 的 flex-wrap 流会折出参差的行");
assert.match(drawerSrc, /reminderCustom\.replaceChildren\(customOffset/,
  "输入行要渲染到 reminderCustom，而不是 reminderBox");
assert.ok(!/reminderBox\.append\(customOffset/.test(drawerSrc),
  "🔴 不许再把输入框塞回 chips 容器（这正是旧版折行错乱的根因）");

// ② chips 行必须左对齐，且不再限宽。
//    ⚠️ 只断言「flex-start 存在」是假断言：改成 flex-end 也能骗过（变异实测漏过）。
//    必须**同时钉住反面** —— 这一行里不许出现 flex-end。
const picksBase = css.match(/^\.reminder-picks\s*\{([^}]*)\}/m)?.[1] ?? "";
assert.ok(picksBase, "必须存在 .reminder-picks 基础规则");
assert.match(picksBase, /justify-content:\s*flex-start/,
  "chips 必须左对齐：flex-end 会让行尾对齐、行首参差，视觉上「飘」");
assert.ok(!/justify-content:\s*flex-end/.test(picksBase),
  "🔴 chips 行不许用 flex-end（等价变异会漏过只查 flex-start 的断言）");
assert.ok(!/max-width:\s*245px/.test(picksBase),
  "🔴 不许恢复 max-width:245px：抽屉固定 380px 宽，再限宽必然折 3 行、右侧全空");
assert.match(css, /\.reminder-custom-row\s*\{[^}]*display:\s*flex/,
  "输入行要自己成一行（display:flex）");

// ③ 这一行改竖排后，`.reminder-kv` 必须 `flex:none` —— 与 v0.37.18 窄屏同一个根因。
//    `.drawer .dbody` 是纵向 flex 容器，`.kv` 默认 `flex:0 1 auto` 会被压回：
//    竖排后需要 128.4px，实测被压到 74px，chips 溢出 61.4px 糊到下一行「所属项目」上。
const reminderKvBase = css.match(/^\.reminder-kv\s*\{([^}]*)\}/m)?.[1] ?? "";
assert.ok(reminderKvBase, "必须存在 .reminder-kv 基础规则");
assert.match(reminderKvBase, /flex:\s*none/,
  "🔴 竖排的 .reminder-kv 必须 flex:none，否则被纵向 flex 容器压缩、chips 溢出糊到下一行");
assert.match(reminderKvBase, /flex-direction:\s*column/,
  "抽屉里这一行要竖排：横排时标签列白吃 52px，内容只剩 269px，7 个 chip 必然折 3 行");
assert.ok(!/min-height:\s*74px/.test(reminderKvBase),
  "竖排后不许再钉死 min-height:74px 的单行高度，要由内容撑开");

// ── v0.58.1：安全区补漏 ────────────────────────────────────────────────
// 前情：Android WebView 不实现 env(safe-area-inset-*)，只有 MainActivity 注入的
// --sat/--sab/--sal/--sar 是真的（铁律四）。下列四处漏了双路写法 —— 它们用的都是
// 「固定物理边距」（22px / 18px / 32px），而系统栏 inset 实测在布局坐标约 30px 上下，
// 于是被状态栏或导航栏压住。判据必须**钉住精确的 calc 结构**：
// 只查「出现了 --sab」的话，`bottom: var(--sab)` 这种把 22px 边距整个丢掉的写法也会过。

// ① 应用内更新提示条（左下角）。#toasts 早在窄屏补了 --sab，同族的这条漏了。
const updateToast = css.match(/\.update-toast\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(updateToast, "必须存在 .update-toast 规则");
assert.match(updateToast, /bottom:\s*calc\(22px \/ var\(--ui-scale, 1\) \+ var\(--sab,\s*env\(safe-area-inset-bottom/,
  "🔴 更新提示条贴底要「原物理边距 + --sab」，否则被导航栏 / 手势条压住");
assert.match(updateToast, /left:\s*calc\(22px \/ var\(--ui-scale, 1\) \+ var\(--sal,\s*env\(safe-area-inset-left/,
  "🔴 更新提示条贴左要「原物理边距 + --sal」（横屏挖孔在侧边）");
assert.ok(!/bottom:\s*env\(safe-area-inset-bottom/.test(updateToast),
  "🔴 不许裸用 env()：Android WebView 里恒为 0，等于没写");

// ② AI 规则编辑器（居中弹窗）。原写法 max-height 只减 32px ⇒ 居中后上下各剩 16px，
//    状态栏压标题、导航栏压底部按钮。扣掉两个 inset 后居中才是真的躲开。
const aiEditor = css.match(/\.ai-rule-editor\s*\{([^}]*)\}/)?.[1] ?? "";
assert.ok(aiEditor, "必须存在 .ai-rule-editor 规则");
assert.match(aiEditor, /max-height:[^;]*var\(--sat,\s*env\(safe-area-inset-top/,
  "🔴 居中弹窗的高度上限必须扣 --sat，否则标题被状态栏压住");
assert.match(aiEditor, /max-height:[^;]*var\(--sab,\s*env\(safe-area-inset-bottom/,
  "🔴 居中弹窗的高度上限必须扣 --sab，否则底部按钮被导航栏压住");
assert.ok(!/max-height:\s*min\(760px,\s*calc\(var\(--ui-vh, 100dvh\) - 32px\)\)/.test(aiEditor),
  "🔴 不许退回「只减 32px」的旧写法（手机上必然被两端系统栏压住）");

// ③ 设置弹窗在窄屏是全屏 inset:0，它不走 .view 的 --nav-pad 安全区，
//    而窄屏 .set-wrap 的 padding-bottom 只有 2px ⇒ 滚到底时最后一项被导航栏盖住。
const modalIdx = css.indexOf(".settings-modal { inset: 0");
assert.ok(modalIdx > 0, "窄屏设置弹窗必须走 inset:0 全屏（改动这里要同步改本断言）");
assert.match(css.slice(modalIdx, modalIdx + 700),
  /\.settings-modal-body\s*\{[^}]*padding-bottom:\s*var\(--sab,\s*env\(safe-area-inset-bottom/,
  "🔴 窄屏全屏设置弹窗的滚动容器必须垫 --sab，否则最后一项被导航栏压住");

// ④ 插件（web-collector）的内嵌网页面板。插件样式没有隔离，同样得吃宿主变量；
//    18px 的物理边距小于状态栏 inset，面板顶部会伸到状态栏下面。
const wcPanel = read("../public/plugins/web-collector/main.js");
assert.match(wcPanel, /\.wc-web-panel\{position:fixed;inset:calc\(18px \+ var\(--sat,/,
  "🔴 插件浮层面板顶部必须「18px + --sat」，否则压状态栏");
assert.match(wcPanel, /\.wc-web-panel\{position:fixed;inset:[^;]*var\(--sab,env\(safe-area-inset-bottom/,
  "🔴 插件浮层面板底部必须「18px + --sab」");

console.log("PASS: Android natural-height layout, tappable quadrant controls, desktop-only window actions, wrapping task cards, single-layer topbar tools, launcher label, status-bar safe-area insets, the four v0.58.1 safe-area fill-ins, back-key history stack, pinch zoom, the narrow-screen settings accordion and the task-drawer reminder layout");
