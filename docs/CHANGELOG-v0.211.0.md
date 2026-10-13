# v0.211.0 · 警大获奖名单多一档「人名榜」

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.211.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 132 个测试脚本全部通过

动的文件：

- `public/plugins/cppu-notify/award-list.js` —— 新增 `rankNames()` / `rankTone()`，面板加第三档「人名榜」与名次配色
- `public/plugins/cppu-notify/manifest.json` —— 插件版本 1.43.0 → 1.44.0
- `src/views/settings/cppuAward.js` —— 新增：设置页「警大获奖名单」卡片（一个人名榜开关）
- `src/views/settings.js` —— 注册该设置分区
- `scripts/test-cppu-award.mjs` —— 补人名榜与配色的断言
- 三端版本号与插件目录（`src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`）由 `sync-version.js` / `sync-plugins.js` 同步

无数据迁移，无存储键变更（新增的开关读写在插件已有的 storage 上）。

## 用户要求

> 添加1个按人名来的，可以在设置中打开默认关闭，按获奖数量排名，前10名的数字绿色，10-20名黄色，其他红色

## 这一档算的是「人」，不是「身份」

原来的两档分别按项目（奖项项目）和按主体（获奖排名：个人 / 团体）排。人名榜换了一个口径：
**把个人获奖者与团体成员一并算到人头上**，一个人既以个人身份获奖、又出现在代表队成员名单里时，
两次都记在他名下。

团体只有队名、通知没列成员时不计入任何人 —— 人名榜里因此看不到那面队旗，
这是「不猜」而不是漏算；条目展开里会写明「其中 N 次来自团体成员名单」，
能看出某人的次数里有多少是替团队拿的。指导教师、领队仍然只展示、不计入排名。

## 为什么默认关闭

它是个「换个角度看同一批数据」的视图，不是主口径：默认把三档按钮都摆出来，
会让人以为获奖名单有三个平行入口。设置里开启后才出现这一档；
关掉时如果正停在这一档，自动退回「奖项项目」——不会留在一个已经隐藏的档位上。
设置改动不需要重启：视图每次进入都重读一次开关。

## 名次配色

前 10 名绿色、11–20 名黄色、其余红色（`rankTone()`），并列同名次同色。
三色都走主题令牌 `color-mix()`（`--mint` / `--sun` / `--danger`），换主题、切深浅、
开 Nephele 都自动跟随；深色模式单独把混色比例调高，避免在深底上发闷。

## 铁律六 / 铁律七

- 新增的档位仍在同一组单选里，滑动选中光由宿主 `tide.ui.selectionGlow()` 提供，
  没有自己画静态底色（`[hidden]` 的档位不参与光块定位）。
- 人名榜的行仍是同一种下拉栏：展开与收起都走 `.aw-shell` 的
  `grid-template-rows: 0fr → 1fr` 双向动画，`aria-expanded` / `aria-hidden` 同步，
  减少动效时立即切换。

## 本版没动的一笔

「奖项项目」「获奖排名」两档的排序口径、时间正倒序、来源回跳、缓存与偏好键都没改；
人名榜只是并列多出来的一档，关掉时对原有界面零影响。

## 验证命令

```bash
cd le-time-management
node scripts/test-cppu-award.mjs        # 人名榜：团体成员计入本人 / 并列名次 / 三色分档 / 开关显隐
npm test                                # 132 个测试脚本
node ../tools/sync-version.js --check
node ../tools/gen-theme-dark.js --check
node ../tools/build-schedule-plugin.js --check
node ../tools/sync-android-native.js --check
```

**一句话**：人名榜把个人与团体成员合并到人头上排名，默认关闭、设置里开，名次数字前 10 绿、11–20 黄、其余红。
