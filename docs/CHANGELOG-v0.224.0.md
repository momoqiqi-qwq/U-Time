# v0.224.0 · 「学生成长」视图（pdata）实测修复轮：明细弹层的 Escape 关不掉、迟到 rAF 把弹层又点亮

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.224.0
> `node ../tools/sync-plugins.js --check` → ✓ 17 个内置插件三端同源
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 138 个测试脚本全部通过

功能本体在 **v0.220.0**（`docs/CHANGELOG-v0.220.0.md`）。本档只记那一版之后**实测出来的修复**，
以及为什么版本号从 0.223.0 走到 0.224.0（改动进了 `public/plugins/`，按铁律一必须升）。

## 一、改了什么

| # | 问题 | 改法 |
|---|---|---|
| 1 | 指标卡明细弹层的 **Escape 关不掉** | `keydown` 原本只绑在 `modalEl` 自己身上，焦点一旦用 Tab 走到弹层外面的卡片按钮上就再也收不到键。改成打开时挂 `document` **捕获阶段**监听，`closeModal()` 与视图 teardown 里立刻 `removeEventListener`，不留常驻监听 |
| 2 | 迟到的 rAF 会把 `.on` 加回**正在删除**的节点 | `showModal` 里 `raf(() => modalEl.classList.add("on"))` 补一句 `&& state.detail`。同一帧内就被关掉（Escape / 点背板）时，回调不再让弹层闪一下 |
| 3 | 插件版本号 | `cppu-notify` 1.55.0 → **1.55.1**（`public/` 改动必须升，见 AGENTS.md 铁律一） |

改的文件：`le-time-management/public/plugins/cppu-notify/growth.js`（两处）、
`.../cppu-notify/manifest.json`（版本 + author 里 1.55.1 段）、
`le-time-management/package.json` + `package-lock.json`（两处 version）、
以及 `sync-version.js` / `sync-plugins.js` / `sync-android-native.js` 写出的生成物。

## 二、修复的实测证据

用假 `tide` / `bridge` 驱动**真 `growth.js`**，脚本点真按钮，每步回报 DOM 状态：

- Escape 之前：`modalClassAfterEsc = "pg-modal on"`，420ms 后节点**仍在**。
- Escape 之后：`modalClassAfterEsc = "pg-modal"`（`.on` 已摘），`modalRemovedAfterEsc = true`。

## 三、同一轮顺带实测的两条铁律

- **铁律七（下拉栏双向动画）**：展开后 `.pg-shell` 计算值 `grid-template-rows: 31px` /
  `opacity: 1`（内容高 23px + 8px 上边距），再点一次回到 `0px`；展开瞬间
  `document.getAnimations()` 返回 `transform@running`、`grid-template-rows@running`、
  `opacity@running` —— 三条过渡都真的被创建，`0fr ↔ 1fr` 可连续插值，中间帧存在。
- **铁律六（选中光）**：`我的消费 / 我的上网` 切换后 `.pg-tabs` 里始终只有 1 个 `.selection-glow`，
  类名带 `on`、尺寸跟着新按钮走（78×36 → 79×36），容器上 `_disposeSelectionGlow` 存在；
  切换只改 `aria-pressed`，不重建 `.pg-tabs` 本身。

## 四、界面几何与对比度（390px 手机视口）

- `vw === scrollW === 390`、`spillCount: 0` —— 无横向溢出；七个区块高 166 / 228 / 302 / 340 / 143 / 143 / 372。
- 主内容对比度全部 ≥ 4.5：身份卡姓名与标签 5.44（浅）/ 6.17（深）、指标卡名与数字
  4.71 / 7.47 / 5.02 / 6.03、区块标题与列表正文 13.53 / 11.08、数据中心入口 12.67 / 10.5、
  学业概览 12.46 / 10.35。次级小字（11–11.5px）3.49（浅）/ 4.27（深）—— 那是宿主主题
  `--ink-2` / `--ink-3` 两档令牌本身的水平，跟随主题是刻意选择。
- 截图：`le-time-management/output/preview/growth-m390-light.png` / `-dark.png`
  （`output/` 已在 `.gitignore` 里）。

## 五、工具侧踩坑（不是代码问题，记下来免得重踩）

1. 无头 Chrome 的 `--virtual-time-budget` **不推进 CSS 过渡**，直接量展开态 / 选中光会读到
   过渡起点（`0px` / `opacity: 0`）—— 量终态前必须先注入 `transition: none !important`；
   中间帧则用 `document.getAnimations()` 证明过渡对象存在。
2. `--screenshot` 给**中文绝对路径**（本仓库路径里有「时间管理软件」）会**静默不写文件**，
   先写到 `$env:TEMP` 再拷回来。
3. `--dump-dom` 在本机完全无输出；取测量结果只能走本地 HTTP 服务 + `<img>` 信标
   （`fetch` 在 `--screenshot` 收尾前会被掐掉）。
4. `--window-size=390` 时布局视口被钳在 500px，量手机布局要用外层页 + 固定尺寸 `<iframe>`。

## 六、版本归属

v0.216.0 警大校历并入 + 分类图标各用各的、v0.219.0 网页收集 / GitHub 文档 / 插件说明三张卡片改抽屉、
**v0.220.0 学生个人成长中心**、v0.220.1 / v0.221.0 / v0.222.0 / v0.223.0 都是别的会话的功能，
本次 v0.224.0 是 v0.220.0 那块功能的实测修复轮。`package.json` 从 0.223.0 到 0.224.0。

> ⚠️ 本轮与另外两个会话在**同一个工作树**上并行（它们此刻还在改 `src/theme.js`）。
> 版本号取「下一个空闲号」；如果 `package.json` 又被别人抬走，本档的编号与它一起改，别只改一边。
> 弹层那两处修复本身在 1.51.0 之后就已经在树里，因此 1.52.0–1.55.0 那几个版本也带着它们。
