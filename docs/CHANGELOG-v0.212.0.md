# v0.212.0 · 设置分类栏加回图标（改成线性图标）

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.212.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 133 个测试脚本全部通过

动的文件：

- `src/settingsNavIcons.js` —— 新增：15 个分类的线性图标（24×24 描边几何，零依赖）
- `src/views/settings/navigator.js` —— 两处调用点改用线性图标；删掉本地 `faIcon()` 小助手
- `src/views/settings.js` —— 「界面与交互」的图标从 `sliders` 换成 `layout-panel`（原来和「任务与排程」撞了同一个字形）
- `src/styles/nephele-settings.css` —— 不再隐藏 `.settings-nav-ico`，并按 Nephele 观感收掉底板块
- `src/styles/settings-layout.css` —— 窄屏竖排分类栏保留图标
- `src/styles.css`、`src/styles/feature-layouts.css` —— `.fa-ic` 规则换成 `.settings-nav-glyph`
- `scripts/test-settings-nav-icons.mjs` —— 新增守卫（画法 / 覆盖 / 不被样式隐藏）

无数据迁移，无存储键变更（纯界面）。

## 用户要求

> 左边添加合适的图标，可以参考一下右边的图像

## 图标本来是有的，是被样式藏起来的

分类图标在 `settingEntries` 里一直写着（`icon: "sliders"` / `"bell"` / …），
渲染链路也一直把它塞进 `.settings-nav-ico`。**问题出在 Nephele 那层样式**：
`nephele-settings.css` 有一条规则把 `.settings-nav-item-copy small`、`.settings-nav-ico`、
`.settings-nav-chevron` 一起 `display: none` —— 分类栏于是只剩光秃秃的文字
（横排 chip 和左侧竖排列表都一样），而默认皮肤正是 Nephele，也就是说**多数人看到的都是没图标的版本**。

所以这次做两件事：

1. 把 `.settings-nav-ico` 从隐藏名单里摘出来，窄屏竖排栏（≤760px 那档）同样保留；
2. 借这个机会换掉图标本身 —— 原来是 Font Awesome **solid 实体字形**，13px 下是一团实心块，
   和参考稿的细描边风格不是一路。现在改成自绘线性图标：24×24 网格、1.7px 描边、圆头圆角、
   `stroke: currentColor`，颜色完全继承文字，选中态不用再写一条 ico 规则。

## 为什么自绘而不是换一套图标字体

- 打包里已有的 regular 精灵图**根本没收这些名字**（`sliders` / `database` / `puzzle-piece` / `gear` 都在 free regular 之外），换字体这条路走不通；
- 15 个图标全是基础图元，手写反而更短：`[标签, 属性]` 一条一行，改风格只要动 `STROKE_WIDTH` 那一个常量；
- 没有网络依赖、没有新资源文件，测试能直接遍历断言。

## 守卫

`scripts/test-settings-nav-icons.mjs` 钉住四件事：图形坐标不越 24 网格；
`settingEntries` 里出现的每个 `icon` 都有画法且**互不重复**；
svg 的描边属性走 `currentColor` + `fill: none`；
**没有任何样式再把 `.settings-nav-ico` / `.settings-nav-glyph` 隐藏起来**（含 Nephele 与窄屏两处，
反向判据就是这个 bug 本身的复现条件）。
