# v0.272.5 · 底部导航栏底色改由网页主题决定 + 警大考试/学分页手机窄屏重排

本版两件事：① APK 底部导航栏的 scrim（`isNavigationBarContrastEnforced`）没被管住，
深色模式下压出一条白带；② 刚上线两天的「我的考试 / 我的学分」两个视图在手机窄屏上
纵向太松，一屏只看得到一两场考试。

---

## 第一部分 · 底部导航栏的底色跟着系统走了，不跟网页主题

## 现象

APK 在**深色模式**下，底部（导航栏那一条）是**白色**；在**浅色模式**下，底部是**深色**。
图标与那条色带同相融成一片，看不清。

## 根因

v0.51.0 修「状态栏图标看不见」时只接管了**图标明暗**（`isAppearanceLightStatusBars` /
`isAppearanceLightNavigationBars`），**底色没管**。

`enableEdgeToEdge()` 让导航栏变成透明浮层，理论上露出的就是网页 `body` 的 `--bg`，
会跟着主题走。但 `Window.isNavigationBarContrastEnforced`（API 29+，**默认 true**）
会在透明导航栏下面再垫一层 **按系统深浅取的 scrim** —— 于是网页底色被盖成系统主题色：

| 系统 | 网页 | 用户看到的底部 | 我们设的图标 | 结果 |
|---|---|---|---|---|
| 浅色 | 深色 | 浅色带（scrim 白） | 白 | 白图标压白带 ⇒ 看不见 |
| 深色 | 浅色 | 深色带（scrim 深） | 近黑 | 近黑图标压深带 ⇒ 看不见 |
| 浅色 | 浅色 | 浅 | 近黑 | ✓ |
| 深色 | 深色 | 深 | 白 | ✓ |

`enableEdgeToEdge()` 一开始确实关了它，但只要之后有任何一处重设窗口属性
（`onResume`、系统深浅切换、部分 ROM 的窗口重建）就会回到默认 `true`，
所以症状表现为「切后台回来又变白」。

## 改了什么

| 文件 | 改动 |
|---|---|
| `le-time-management/android/gradle/.../SystemBars.kt` | **新增**。底色 + 图标的唯一控制点：锁 edge-to-edge 契约 → 关掉两处对比度强制 → 底色钉成 `TRANSPARENT` → 图标反相。整段在主线程、`try/catch` 吞异常、幂等 |
| `le-time-management/android/gradle/.../SystemBarPlugin.kt` | `applyDarkIcons` 整段迁出，`setDarkIcons` 委托给 `SystemBars.setDarkIcons` |
| `le-time-management/android/gradle/.../MainActivity.kt` | 新增 `onResume` / `onConfigurationChanged`，各调一次 `SystemBars.reapply(this)` —— 系统正是在这两处把窗口属性重算回去 |
| `tools/sync-android-native.js` | `SystemBars.kt` 进 `SOURCES`（`gen/android` 是 gitignored 生成目录，不收录会在下次 `tauri android init` 后静默消失） |

修完的效果：导航栏永远是**透明**的，露出的就是网页自己的 `--bg`；
图标明暗与它反相 —— 四种「系统 × 网页」组合全部可读，且不再依赖 ROM 是否尊重
`enableEdgeToEdge()`。

## 回归断言

`scripts/test-android-system-bar.mjs` 从 19 条扩到 26 条，新增钉住：

- `SystemBars` 里 `isNavigationBarContrastEnforced = false` 与 `isStatusBarContrastEnforced = false`
  两处都关（少一处，顶部或底部必有一边回到系统主题色）；
- `window.navigationBarColor = Color.TRANSPARENT` 与 `window.statusBarColor = Color.TRANSPARENT`
  （只关 scrim 不改底色，仍可能是主题色）；
- `VERSION_CODES.Q` 版本门控（对比度强制是 API 29+ 属性，裸写低版本直接崩）；
- `MainActivity` 的 `onResume` / `onConfigurationChanged` 必须各调一次 `SystemBars.reapply(this)`
  —— 这是「切后台回来又变白」的复发闸；
- `sync-android-native.js` 的 `SOURCES` 收录 `SystemBars.kt`。

## 未做

没有把导航栏改成不透明纯色兜底 —— 那会在底部压出一条与网页背景图不连续的实色带。
透明 + 关 scrim 已经覆盖所有已知 ROM；若仍有残留在某些定制 ROM 上，再考虑让前端把
`--bg` 的实际颜色传下来。

---

## 第二部分 · 警大考试 / 学分页手机窄屏重排

只动 `le-time-management/public/plugins/cppu-notify/main.js` 的窄屏样式与考试卡的 HTML 结构，桌面布局不受影响（改动全在 `@media(max-width:600px)` 与新增的 `.jw-exam-line` 容器内）。

| 位置 | 之前 | 现在 |
|---|---|---|
| 考试页统计卡 | 两列 grid + 首格 `grid-column:1/-1`（三格约 147px 高） | 三列并排、`gap:6px`、`padding:8px 9px`（390px 下每格 117px） |
| 考试卡 | 时段 / 考场 / 状态标签各占一行，卡高 140px | 三者在同一 `.jw-exam-line` 里 flex 换行，卡高 92px；日期块 46px、内外边距收紧 |
| 学分页三格 | ≤600px 被写成 `grid-template-columns:1fr`（竖排 ≈270px） | 三列并排 + 进度条，单格 117×97；`em`（「按模块看 N 门」）窄屏隐藏 |
| 回退学期提示 | 一句话占三行 | 文案缩短 + `-webkit-line-clamp:2` |

390×844 实测：首张考试卡起点 448px → **352px**，一屏完整可见 **4 张**（原来 1~2 张）。

### 为什么学分页的 `em` 直接隐藏

「按模块看 N 门」在 117px 宽的格子里挤成两行，而点开分类卡后每组标题本来就写着「N 门」，信息不丢。桌面宽度照常显示。

### 回归断言

- `scripts/test-cppu-exam.mjs` 继续 PASS（回退学期提示的两个锚词 `还有 N 场没考` / `已经考完了` 未动，`notice` 文案改动已同步）。
- 新增探针 `le-time-management/dev/probe-cppu-mobile.mjs`（不进测试套件，但可复用）：真 CSS 真渲染，`PROBE_W` 控制 320 / 360 / 390，量 `scrollWidth-clientWidth`、逐元素右边界越界、卡片与统计格 rect、`.jw-exam-wi` 是否折行，并在 `--ui-text-scale:1.15` 下再量一遍。三档宽度 × 两档字号：横向溢出 **0**、越界元素 **0**。
- 附带修掉两个预览脚本的硬编码：`dev/shot-cppu-exam.mjs` / `dev/shot-cppu-credit.mjs` 的预览页 `body` 原来写死 `width:390px`，在 360 / 320 的 iframe 里量出来是假溢出（错报 30 / 70px），改成 `width:100%;max-width:390px`。

### 未做

- 安全区不归插件管：`.view` 负责上下左右四边，插件不自垫（铁律），本轮没有新增 `position:fixed` 浮层。
- 桌面（≥601px）与平板宽度未改；宿主侧栏、底部导航与页面滚动的挤压关系未动。
