# v0.232.0 · 首屏刷新蒙版；全项目补作者署名（By 梁逸乐）

> 归属说明：改动进 `le-time-management/src/`、`le-time-management/public/`、
> `le-time-management/src-tauri/`、`miniprogram/`（均属「必须升版本」的目录），
> 随 v0.231.0 之后的 v0.232.0 发布（新增界面与元数据 → minor +1）。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致 v0.232.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → 141 个测试脚本全部通过（本次新增 `test-author-attribution.mjs`，
> 另 `test-brand-wordmark.mjs` / `test-refresh-mask.mjs` 同批新增）。

## 起因

用户两条要求：

1. **刷新时加一个蒙版**，蒙版上要有文字，文字形式参考左上角的标题，刷新完成后取消蒙版。
2. **在必要的地方添加作者署名** —— By 梁逸乐。

## 改了什么

### 1. 首屏 / 刷新蒙版（`src/loadingMask.js`，新增）

盖住的是**整段首屏启动过程**：从 HTML 首帧一直到 `revealAppWindow()` 把界面交出来为止。

- 空壳 `.refresh-mask[data-refresh-mask]` **写在 `index.html` 里**，由 `main.js` 在 `boot()` 第一行
  同步挂载 —— 等模块加载完再 `createElement` 的话，弱机上会先闪一下半成品界面。
- 蒙版上那句字**就是左上角那颗字标本身**，DOM 由 `brandWordmark.js` 给、样式由 `styles.css`
  的 `.brand b` / `.brand-rule` 给，`loadingMask.js` 里**一个色值都不写死**。
- 字色是渐变裁剪（`background-clip: text`），底色统一走 `--bg`（主题自己的页面底色，与侧栏同色系），
  不会让字标糊在背景上；浅色 / 深色两套渐变靠 `data-theme-mode` 二选一。
- **收尾顺序是「先亮界面、后撤蒙版」**：`revealAppWindow()` 之后才 `finishRefreshMask()`，
  先加 `.leaving` 起淡出、等过渡结束再摘节点；减少动效时同步摘掉，不留空窗。
  `boot()` 的失败路径同样撤蒙版，否则「重新读取」按钮会被蒙版压在下面点不到。

### 2. 字标抽成唯一创建口（`src/brandWordmark.js`，新增）

`U Time WorkSpace` 字标与下方那条哥特装饰线原来只长在 `shell.js` 的侧栏里。蒙版要用同一句文案、
同一套渐变、同一条装饰线，复制一份必然走形，所以把 DOM 构造抽到这里两处共用。

- 视觉的唯一事实源仍是 `styles.css` 的 `.brand b` / `.brand-rule`。
- `scripts/test-brand-wordmark.mjs` 的静态断言现在分两处读：文案与调用看 `shell.js` 的 rail，
  装饰线形状（`viewBox` / `preserveAspectRatio` / 四档渐变）看本文件 ——
  所以 `shell.js` 里那句调用与 `brandRule()` 这个名字都不能改名。

### 3. 作者署名（By 梁逸乐）

署名统一写法 **梁逸乐（Yile Liang）**，按「产品内可见」与「打包 / 文档元数据」两条线铺开：

| 位置 | 落点 |
|---|---|
| 产品内「关于」页 | `src/aboutData.js` 新增 `AUTHOR` 常量（`name` / `latin` / `role`），`src/views/aboutCard.js` 在标题下渲染 `By 梁逸乐 Yile Liang · 设计与开发`；样式 `.about-author*` 只消费既有主题令牌，不新增色值 |
| 桌面壳 | `index.html` 加 `<meta name="author">` 与 `<meta name="description">` |
| 打包元数据 | `package.json` `author`；`src-tauri/Cargo.toml` `authors`（原为 `["yile"]`）；`src-tauri/tauri.conf.json` `bundle.publisher` / `bundle.copyright` / `bundle.homepage` |
| 小程序 | `miniprogram/core/appMeta.js` 新增 `author`；`pages/settings/index.wxml` 关于区显示 `By {{about.author}}` |
| 说明与文档 | 根 `README.md`、`le-time-management/README.md`、`miniprogram/README.md` 标题下加署名；`public/OPEN_SOURCE_NOTICES.md` 顶部加作者与版权行；`docs/` 五个 HTML（`index` / `features` / `plugins` / `tech-stack` / `upload`）页脚补署名 |

署名散在九层文件里，漏一处不会报错、只会静默少一个署名位，所以加了
`scripts/test-author-attribution.mjs`：把上面每一处都钉成静态断言（连「作者行样式不许写死色值」也断言），
改署名必须全改，否则这条测试红。

**没有改的地方**（有意为之）：`public/plugins/*/manifest.json` 的 `author` 字段是**各插件自己的来源署名**
（`U-Time内置`、`基于 XingHeYuZhuan/shiguangschedule · U-Time适配` 等），不是应用作者的落点，
保持原样；`src/shell.js` 快捷面板里原有的 `Yile Liang` 与 `YL` 头像照旧。

### 4. 版本与镜像

- `package.json` → `0.232.0`，`node ../tools/sync-version.js` 同步 Cargo.toml / Cargo.lock /
  `tauri.conf.json` / `appMeta.js` / Android `versionName+versionCode`（`versionCode = major*10000 + minor*100 + patch`，23100 → 23200）。
- `package-lock.json` 两处（`version` 与 `packages[""].version`）已是 `0.232.0`。
- `src-tauri/gen/android/app/src/main/assets/tauri.conf.json` 是 Android 运行时读的那份配置镜像，
  改 `tauri.conf.json` 后由 `node ../tools/sync-android-native.js` 同步（本次已同步并 `--check` 通过）。

## 影响面

- 桌面（Windows / Linux）与 Android：首屏多一层蒙版，启动路径与错误路径都已覆盖。
- 小程序：仅设置页「关于」多一行署名，无逻辑改动。
- 数据：无迁移，`letime-data` 结构未动。
