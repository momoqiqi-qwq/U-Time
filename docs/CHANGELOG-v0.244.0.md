# v0.244.0

> 用户诉求（原话）：「在设置中添加这个赞助图，专门弄个赞助项。」
> 把一张微信 + 支付宝的商家聚合收款码做成设置里的**独立分区**，不是塞进「关于」的一行链接。

## 改了什么

### 1. 设置新增「赞助支持」分区（第 17 个分类）

桌面端 `le-time-management/src/views/settings.js` 的 `settingEntries` 在 `testing` 之后插入：

```js
{ id: "support", create: ({ render }) => createSupportCard(), label: "赞助支持",
  icon: "mug-hot", hint: "收款码 / 支持作者",
  keywords: "赞助 打赏 支持 捐赠 收款码 二维码 扫码 微信 支付宝 保存图片 请作者喝咖啡 donate sponsor" }
```

卡片本体在新增文件 `le-time-management/src/views/settings/support.js`：`h2`「赞助支持」+ `.desc`
说明 + 可点击放大的收款码 + 两个动作 + 一段可折叠的「赞助说明」。

- **点一下放大**：`.support-qr` 在 300px ↔ 420px 之间过渡，再点回去。不做全屏浮层 ——
  浮层要自己处理 Android 返回键与焦点陷阱，而这里的目标只是「大到第二台手机扫得到」。
- **保存收款码**：`fetch(SPONSOR_QR_SRC)` → `arrayBuffer` → base64 → `api.saveDownloadBase64(...)`，
  落到下载目录并返回路径；成功后「打开所在文件夹」按钮才启用（走 `api.revealSavedFile`，只认自己给过的路径）。
  非 Tauri 环境（浏览器调试）该按钮不呈现。
- **图片缺失兜底**：`img.onerror` 换成 `.support-qr-missing` 文字，不会留一个破图标。
- **赞助说明**用 `createDisclosure({ open: false })`，四段：自愿、不构成购买、不收集付款信息、反馈也算支持。
  `grid-template-rows 0fr↔1fr` 双向动画，符合铁律七。

### 2. 图标：新增 `mug-hot`

`le-time-management/src/settingsNavIcons.js` 加 `"mug-hot"` —— 咖啡杯 + 杯把 + 两缕热气 + 托碟线（5 条 path），
24×24 描边、`currentColor`。铁律：每个分类专属图标，不复用 `gear` / `heart`。

### 3. 全局搜索与命令面板接入

`le-time-management/src/settingsSearchIndex.js`：

- `GROUPS.support` 三条（「赞助支持」「保存收款码」「赞助说明」），标题都是卡内**真实可见**文案，
  点下去能落到控件上；插在 `about` 之前。
- `SETTINGS_SECTION_LABELS` 加 `support: "赞助支持"`，命令面板与左栏导航共用同一个中文名。

索引条数 119 → **122**。左栏导航由 `entries` 自动生成，无需额外接线。

### 4. 样式新分片 `src/styles/support-card.css`

`le-time-management/index.html` 在 `storage-status.css` 之后引入。全部颜色走主题令牌
（`--panel --line --ink-2 --ink-3 --shadow --shadow-lg --focus-ring`），字号乘 `--ui-text-scale`，
所以 16 套主题 × 浅深两态都跟随；二维码图本身自带白底，不随主题改。

窄屏（≤760px）二维码上限 260px，放大时占满内容宽。减少动效用 `:root[data-ui-motion="reduced"]`
与 `@media (prefers-reduced-motion: reduce)` 双路，直接切尺寸不做位移动画。

### 5. 小程序也加了，但换了一种交互

`miniprogram/pages/settings/`：在「关于 U-Time」之前插入「赞 助」card，图片放
`miniprogram/images/support/sponsor-qr.png`（33 KB，主包可接受）。

- 小程序没有「下载目录」概念，所以**不移植保存按钮**：点图片走 `wx.previewImage`（系统图片预览，
  长按可保存/转发），`<image>` 上加 `show-menu-by-longpress` 让长按菜单直接可用。
- 文案与桌面端同源口径，样式 `rpx` + 既有 `var(--line) / var(--panel)`。

## 影响哪端

| 端 | 赞助入口 | 交互差异 |
|---|---|---|
| Windows / Android | 设置 › 赞助支持（第 17 个分类，`mug-hot` 图标） | 点图放大、保存到下载目录、打开文件夹、折叠说明 |
| 微信小程序 | 设置页「赞 助」卡片 | 点图进系统预览、长按保存；无「保存到下载目录」 |
| 浏览器调试 | 同上 | 无保存按钮（`saveDownloadBase64` 仅 Tauri） |

无新增权限、无新增存储键、无新增数据字段。新增静态资源 2 份（桌面 `public/support/`、小程序 `images/support/`，
内容同一张图）。

## 数据迁移

无。

## 验证

- `node scripts/test-settings-nav-icons.mjs` ✓（断言 16 → 17 条，17 个分类图标互不共用）
- `node scripts/test-settings-global-search.mjs` ✓（分区集合加 `support`，122 条索引分区与标题自洽）
- `node scripts/test-settings-abbrev-search.mjs` ✓ / `test-settings-option-search.mjs` ✓
- `node ../tools/sync-version.js --check` ✓（v0.244.0）、`gen-theme-dark --check` ✓、
  `build-schedule-plugin --check` ✓、`build-exam-calendar-plugin --check` ✓、`sync-android-native --check` ✓
- 说明：`sync-version.js` 会改 `src-tauri/tauri.conf.json` 的 `version`，Android 侧
  `gen/android/app/src/main/assets/tauri.conf.json` 是它的镜像，必须补跑一次
  `node ../tools/sync-android-native.js`，否则 `--check` 会报 assets 不一致（本次已踩到并修复）。
