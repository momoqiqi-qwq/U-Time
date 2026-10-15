# v0.219.0 · 网页收集 / GitHub 文档 / 插件说明三张卡片改成「从底边翻起」的抽屉

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.219.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/build-exam-calendar-plugin.js --check` → ✓ exam-calendar 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `node ../tools/sync-plugins.js --check` → ✓ 插件生成物与清单同源（17 个内置插件）
> `npm test` → 138 个脚本 133 通过；未通过的 5 个（`test-cppu` / `test-chaoxing` /
> `test-plugin-permissions` / `test-plugin-safe-area` / `test-release-history`）
> 全部落在本次没碰过的文件上（未提交的 `cppu-notify` 改造、`src-tauri` 登录态注入、发布记录），
> 本次动过的 6 个文件对应的 `test-web-collector` / `test-github-readme` / `test-github-ux` /
> `test-text-scale` / `test-css-integrity` 全绿。

动的文件：

- `public/plugins/web-collector/main.js` —— 卡片拆成 `.wc-front` / `.wc-detail` 两层，
  新增 `flippedCards` 集合与翻起样式；`paint()` 的卡片模板重写
- `public/plugins/web-collector/manifest.json` —— 1.6.0 → 1.7.0；`description` 改写
- `public/plugins/github-readme/main.js` —— 卡片拆成 `.gh-front` / `.gh-detail`，
  新增 `flipped` 集合、`toggleCardFlip()` 与 `[data-gh-more]` 委托分支；`repoCard()` 重写
- `public/plugins/github-readme/manifest.json` —— 1.3.0 → 1.4.0；`description` 改写
- `public/plugins/plugin-guide/main.js` —— 卡片拆成 `.pg-front` / `.pg-detail`，
  新增 `boundRoots` / `flipped` / `toggleCard()` 与 `[data-pg-more]` 一次性委托；`render()` 的卡片构造重写
- `public/plugins/plugin-guide/manifest.json` —— 1.4.4 → 1.5.0；`description` 改写
- 生成物：`src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、三端版本号
  （`src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json`、`miniprogram/core/appMeta.js`、
  `src-tauri/gen/android/app/tauri.properties`、`app/src/main/assets/tauri.conf.json`）

**无数据迁移**。三个插件的 `storage` 键与结构都没动；翻起状态只活在内存里
（`flippedCards` / `flipped` 两个 `Set`），刷新即回到正面。

## 用户要求

> 给网页收集插件、GitHub 文档插件以及插件说明插件添加这个动画。

「这个动画」指 https://chocologism.github.io/lab-orbit/resources 的卡片动效。

## 一、那个动画到底是什么

不是「翻页」（`rotateY`），是**从卡片底边立起来的 3D 抽屉**。LabOrbit 里叫 `.book-card`：

```css
.book-card   { perspective: 1000px; transform-style: preserve-3d; overflow: hidden; }
.card__content {
  position: absolute; inset: 0;
  transform: rotateX(-90deg);
  transform-origin: bottom;          /* 合页在底边 */
  backface-visibility: hidden;
  transition: all .6s cubic-bezier(.175, .885, .32, 1.275);
}
.book-card:hover .card__content { transform: rotateX(0deg); }
```

`rotateX(-90deg)` + `origin: bottom` = 详情层先「躺平」在底边、背对用户，
展开时绕底边转 90° 立起来盖住正面。缓动 `cubic-bezier(.175,.885,.32,1.275)` 是
先快、末端过冲再回弹的一档（LabOrbit 卡片缩放、详情层翻转、封面推近三者同频）。

### 三条少一条就废

| 参数 | 写错会怎样 |
|---|---|
| `perspective` 必须写在**卡片本体** | 写到详情层上等于「自己给自己透视」，转出来是平的，没有景深 |
| `transform-origin: bottom` | 默认 `center` 会从卡片中间对折；写成 `top` 则是从顶边垂下来，方向反了 |
| `backface-visibility: hidden` | `-90°` 时背面正对用户，不隐掉就会透出反向镜像的文字 |

闭合态必须是 `-90deg`（向内折）而不是 `+90deg`（向外垂）—— 后者在收起过程中
会先「甩」到卡片下方再收回，看着像穿模。

## 二、三个插件各自怎么接

### 共同部分

- 时长 `.6s`、缓动 `cubic-bezier(.175,.885,.32,1.275)`，与 LabOrbit 一致。
- `visibility` 与 `transform` **分开延迟**：
  展开 `transition: transform .6s <curve>, visibility 0s linear 0s`（立刻可见），
  收起 `… visibility 0s linear .6s`（等转完再隐藏）。否则收起瞬间就 `hidden`，
  看不到转出去的过程。
- 悬停触发一律包在 `@media (hover: hover) and (pointer: fine)` 里。
  **不写这条会踩 LabOrbit 自己的坑**：它把 `:hover` 和 `.is-flipped` 写在同一条规则里、
  没有 hover 能力守卫，手机上点一下会留下粘滞的 hover 态，只能靠一个额外的
  `.mobile-flip-back-btn` 兜底。这里改成「触屏/键盘走显式按钮」，不需要兜底。
- 每个插件都带 `@media (prefers-reduced-motion: reduce) { … transition: none !important }`。

### web-collector（网页收集）

卡片原本是一层网格 + 一个 `.wc-actions` 行，「编辑 / 换图标 / 刷新 / 删除」四个按钮
挤在正面。现在：

- 正面 `.wc-front`：图标 + 标题 / 域名 / 徽标 / 备注（2 行截断）+ 「打开」+「更多」。
- 详情层 `.wc-detail`：完整标题 + 收起按钮 + 两个输入框 + 五个按钮。
- 翻开后 `.wc-front` 走 `transform: scale(.86); opacity: 0; pointer-events: none`。
  正面缩一点再淡出，视觉上是「被详情层顶下去」，比直接消失有层次。
- **正面 `pointer-events: none`、详情层 `auto`**：卡片主体本来就没有主点击动作，
  让详情层独占事件最省事。
- 卡片高度由两层里更高的一层撑住：`.wc-front` 给 `min-height: calc(182px * var(--ui-text-scale))`。
  这个数字是**量出来的**：详情层的内容预算（两行标题 + 两个 34px 输入框 + 两行动作条）需要 174px，
  `min-height` 给 178 时还差 6px 会出滚动条，给 182 才归零。
- 同时**删掉了 `.wc-card` 上的 `content-visibility: auto` / `contain-intrinsic-size`**：
  尺寸包含和 3D 翻转凑在一起时，卡片高度会被 `contain-intrinsic-size` 接管，
  正面内容反而撑不开卡片（实测卡片停在 161px，而正面内容要 173px）。收藏列表只有几十条，
  这个优化本来也省不下什么。
- **不给 `.wc-actions` 加分隔线**：详情层里也有一份 `.wc-actions`，
  一条 `.wc-card.is-flipped .wc-actions { border-top: …; padding-top: 9px }` 会连详情层那份一起命中，
  凭空多出 10px 把动作条顶出卡片。
- 详情层标题加 `-webkit-line-clamp: 2`：它和下面的编辑框、动作条共享固定高度，
  不限行的话长标题会把动作条顶出去。
- 原来的 `.wc-card.expanded` 那套「展开显隐」CSS 整段删掉，改成 `.is-flipped`。
  注意 `.wc-card > div:nth-child(2) { min-width: 0 }` 这条跟着挪到了 `.wc-front > div:nth-child(2)`
  —— 包了一层之后，原来的选择器指向的是 `.wc-front` 自己。

### github-readme（GitHub 文档）

- 正面 `.gh-front`：仓库名 + 别名 / 备注 + 最近提交标题 + 分支·作者·时间·README 体积 + 「阅读 README →」+「更多」。
- 详情层 `.gh-detail`：仓库名 + 收起 + 同样的 meta + 「阅读 README / 编辑 / 移除」。
- **和 web-collector 相反：正面翻开后刻意保留可点**（不写 `pointer-events: none`），
  反过来让 `.gh-detail` 容器 `pointer-events: none`、只让 `.gh-detail button { pointer-events: auto }` 吃事件。
  原因：这张卡整块就是一个「阅读 README」按钮，鼠标往卡片上一放就翻起，
  此时用户想点的往往还是「读 README」。若正面一并禁掉事件，点下去会落进详情层的空白区，
  「点卡片进阅读页」就变成了看运气。
- 详情层内容短，用 `overflow: hidden`（没有滚动需求；留 `auto` 会在详情层里吞掉滚轮）。
- `toggleCardFlip()` **只切 class、不整页重绘** —— `paint()` 会抹掉编辑框草稿与滚动位置。
- 委托链最前面插入 `[data-gh-more]` 分支并 `return`，避免继续往下走到 `[data-gh-open]`。
- `.gh-card` 的 `padding: 12px 13px` 挪进 `.gh-front`（`padding` 会撑破 `overflow: hidden` 的合页）。

### plugin-guide（插件使用说明）

原来是一张静态卡：图标 + 名称 + 平台徽章 + 简介 + `<ol>` 步骤全塞在正面，
长插件的步骤有七八条，卡片高度参差、页面读起来像文档墙。现在按「是什么 / 怎么做」分层：

- 正面：图标 + 名称 + 平台徽章 + 简介（3 行截断）+「查看 N 步操作 ▾」。
- 详情层：同样的头部 + 完整 `<ol>` 步骤 + 「收起 ▴」。
- **两层头部完全相同**，翻过去不觉得换了一张卡，只是下面的内容换了。
- 详情层里 `.pg-steps` 是滚动容器（`flex: 1 1 auto; min-height: 0; overflow: auto`），
  `.pg-detail` 自己 `overflow: hidden` —— 这样「收起」按钮永远在视口内，
  不用滚到步骤末尾才能关。
- 这个插件原本**一个点击事件都没有**。新增 `boundRoots`（`WeakSet`）保证
  `render()` 被重入时只挂一次委托，否则多次 `render` 会叠加处理器、
  一次点击切两次 `Set` 等于没翻。

## 三、为什么不用现成的下拉/折叠动画

铁律七要求下拉栏有双向展开收起动画，但这里刻意不走 `<details>` / `max-height` 那套：

- `max-height` 过渡**会**触发重排，一屏十几张卡同时过渡会掉帧；
  `transform` 走合成层，只重绘不重排。
- 翻起要的是「同一块地方换一面」，`max-height` 只能做「往下长」，
  在网格里会把下面整行推下去、破坏 `auto-fill` 的排布。
- 高度由两层里更高的一层撑住（所以给了 `min-height`），翻起时卡片外框不动，
  只有内部两面互换 —— 这正是 LabOrbit 观感的关键。

## 四、边界

- **小程序端不变**。`web-collector` / `plugin-guide` 的 `platforms.miniprogram` 仍是 `native`
  指的是「清单里声明可用」，小程序端没有这三个插件的卡片 UI 实现，本次只改桌面端。
- **Android 安全区**：三处新增样式全是 `position: absolute`，没有新增 `position: fixed`，
  `scripts/test-plugin-safe-area.mjs` 通过。
- **字号**：三份新增 CSS 的每条 `font-size: Npx` 都写成 `calc(Npx * var(--ui-text-scale))`，
  `scripts/test-text-scale.mjs` 通过。
- **没有做「点卡片外部收起」**：三张卡都不占满视口，加全局点击监听会和卡片自己的
  点击动作打架（github-readme 的卡片主体本身就是按钮）。收起统一走每张卡自带的收起按钮。
- **一次只翻一张**是每个插件各自的行为：`flipped` 集合允许多张同时翻开
  （用户可以对比两张卡的详情），没有做互斥。

## 五、真浏览器量过的几何

静态断言测不出「翻起来盖没盖住」。用无头 Chrome 起真 CSS（宿主 `styles.css` + 插件自身样式）、
只 stub `tide`，跑 1180×900 视口，明暗两套主题 × 收起/翻开两态各量一遍
（探针脚本放在 gitignored 的 `.workbuddy/ui-check/`，`serve.mjs` 起服务 + `drive.mjs` 驱动，不入库）：

| 插件 | 卡数 | 卡片尺寸 | 翻开后详情层盖满 | 正面 `scale` | `elementFromPoint` 命中（收起 → 翻开） |
|---|---|---|---|---|---|
| web-collector | 2 | 274×184 | ✓ 272×182 | 0.860 | `FFFFFFFFF` → `DDDDDDDDD` |
| github-readme | 3 | 960×207 | ✓ 958×205 | 0.860 | `FFFFFFFFF` → `FFFFFFFFF`（刻意） |
| plugin-guide | 13 | 343×160 | ✓ 341×158 | 0.860 | `FFFFFFFFF` → `DDDDDDDDD` |

其余同时成立：翻起前后卡片高度差 `0`（无布局跳动）、横向溢出 `0`、
收起态详情层 `visibility: hidden` + `pointer-events: none` 且 `transform` 是
`matrix3d(…, -1, …)`（真的是 `rotateX(-90deg)`，不是没生效）、翻开态是 `matrix(1, 0, 0, 1, 0, 0)`、
`perspective` 读回 `1000px`（在卡片本体上）。

> 量的时候要先把过渡关掉：无头 Chrome 的 `--virtual-time-budget` **不推进 CSS 过渡时钟**，
> 否则读到的永远是 `t = 0` 的那一帧（详情层高度会是 19px 而不是 182px）。

## 版本归属

v0.217.0 是「学生个人成长中心」，本次（v0.219.0）是「三张卡片改成翻起式抽屉」，
`package.json` 从 0.217.0 到 0.219.0；
三个插件的 manifest 各自 minor +1（`1.6.0 → 1.7.0`、`1.3.0 → 1.4.0`、`1.4.4 → 1.5.0`），
`1.4.4 → 1.5.0` 是因为 plugin-guide 的 patch 位已经在 v0.215.0 系列用掉了。
