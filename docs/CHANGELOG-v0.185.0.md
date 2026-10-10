# v0.185.0 · 警大插件下载附件后，点一下那条通知就跳到附件所在的下载目录

> 版本号说明：同一工作区里几条改动并行，`0.182.0`（Nephele 主区底色）、`0.183.0`（品牌字标与装饰线）、
> `0.184.0`（搜索框只留放大镜）各被别的改动占用；本次改动落地时三端是 `0.184.0`，
> 随后 `package.json` 被抬到 `0.185.0`（`node ../tools/sync-version.js --check` 现在输出
> `✓ 三端版本一致：v0.185.0`），所以这一格记本次改动。

## 用户要求原文

> 「警大插件，下载附件后会弹出通知，点击该通知卡片即可跳转至附件所在的下载目录。」

改前的形态：横幅只有一行字「已保存到下载目录：C:\Users\…\Downloads\xxx.docx」，看完只能自己去文件管理器里翻。
本次要做的就是**把这条横幅本身变成入口** —— 点它，文件管理器打开到那个目录并把文件选中。

## 一、宿主：`toast()` 支持整卡可点

`src/ui.js` 的 `toast(msg, opts)` 新增两个选项：

| 选项 | 含义 |
|---|---|
| `onClick` | 有它整卡才可点；点一下（或键盘 Enter / Space）就跑回调并收卡 |
| `onClickHint` | 卡尾那句提示文案（默认「点击查看」），如「点击定位文件」 |

四条写死的规矩，都由新测试 + 变异测试守着：

1. **不加按钮。** 这种横幅只有一个去处，多一颗按钮会把一条长路径的正文挤窄 —— 所以可点的是卡本身
   （`.toast-clickable`：`cursor: pointer` + hover 底色 + `:focus-visible` 外框）。
2. **键盘可达。** 有 `onClick` 时卡上挂 `role="button"` 与 `tabindex="0"`，复用既有的
   `isSelfActivationKey()`（只认 Enter / Space，且必须是卡自身被激活 —— 卡里输入框的按键不算）。
3. **不与 `action` 按钮打架。** 卡里另有一颗真按钮（如「撤销」）时：**不**把整卡标成按钮
   （嵌套交互元素会让读屏器念两次、键盘多一站），点按钮走按钮自己的动作，只有点卡身才跑 `onClick`。
4. **回调抛错也要收卡。** `try/finally` 收卡 —— 卡留在那儿，用户会以为没点上然后一直点。

老调用方零影响：没传 `onClick` 的横幅不多类名、不多 `role`、不多提示 span。

## 二、四层接线：插件 → 宿主 → 桥 → Rust

| 层 | 新增 | 说明 |
|---|---|---|
| Rust | `reveal_saved_file`（`src-tauri/src/lib.rs`） | 定位并选中文件；Windows 走 `SHOpenFolderAndSelectItems` |
| 桥 | `api.revealSavedFile(path)`（`src/api.js`） | `invoke("reveal_saved_file", { path })` |
| 宿主 | `tide.assets.revealSaved(path)`（`src/pluginHost.js`） | 过 `ui` 权限闸门（与 `saveText` / `saveBase64` 同一道） |
| 插件 | `notifySaved(msg, path)`（`public/plugins/cppu-notify/main.js`） | 落盘横幅统一从它发 |

四层的名字是**逐层对得上**的（`revealSaved` ↔ `revealSavedFile` ↔ `reveal_saved_file` ↔
`generate_handler` 注册）。Tauri 只做 camelCase / snake_case 透传，名字写错不会报错，只会
静默变成缺参 —— 所以这四个名字被逐一钉在测试里。

## 三、Rust 侧的安全边界（这块是重点）

调这个命令的是**插件**，它拿到的就是 `save_download*` 刚返回的那个字符串，没有理由去翻系统里的任意位置。
所以 `reveal_saved_file` 立了三条：

1. **必须真实存在**（`fs::canonicalize` 失败即报「文件不存在或已被移动」）——
   定位一个已被删掉 / 移走的路径，只会让文件管理器自己弹一个「找不到」。
2. **必须在应用下载目录 / 应用数据目录之内**，否则报「只能定位应用下载目录里的文件」。
3. **路径归属判定单独拆成 `path_within()`**：Windows 上盘符与目录名不区分大小写，而
   `Path::starts_with` 逐段严格比 —— 照抄会把 `E:\Downloads` 与 `E:\downloads` 判成两处，
   于是「刚存下的文件」反而定位不了。实现是统一分隔符、统一小写后按「目录前缀 + 分隔符」比，
   免得前缀撞名（`Download` 与 `Downloads`）误放行。

Android / iOS 没有「在文件夹里选中某个文件」这回事（`tauri_plugin_opener` 在那里直接返回
`UnsupportedPlatform`），所以那一侧返回**明确的不支持**而不是静默成功；插件捕获后把路径再摊开一次
（「请手动到下载目录查看：…」）—— 横幅上本来就写着完整路径，用户照样能自己找过去。

## 四、顺手统一的三处落盘横幅

同一个动作不该有两种反应，凡是「已保存到下载目录」的横幅现在都能点：

- `public/plugins/cppu-notify/main.js`：附件下载（本次需求）、成绩单图片导出
- `public/plugins/plugin-guide/main.js`：导出《U-Time 插件开发文档》

文档也补了：`public/plugins/plugin-guide/plugin-development.md` 的「插件资源」与「通知与事件」
两节写清 `tide.assets.revealSaved` 与整卡可点横幅的写法（含 Android 要兜底的原因）。

## 五、验证

**行为测试** `scripts/test-reveal-saved-file.mjs`（新）：迷你 DOM 真跑 `src/ui.js` 的 `toast()`
（含事件冒泡与 `closest`），断言整卡可点 / 提示文案 / `role` + `tabindex` / Enter 与 Space 生效而
普通字符键不生效 / Space 要 `preventDefault` / 与 `action` 解耦 / 回调抛错仍收卡 / 没传 `onClick`
的老调用方不被改相；再钉四层接线的名字与 Rust 的三条边界；最后用 `rustc` **单跑** `path_within`
（含 `Downloads` vs `Downloads-old` 前缀撞名、大小写、正反斜杠）。

**插件端** `scripts/test-cppu.mjs`（扩）：真跑警大插件，点下附件下载后取出那条横幅的 `onClick`
并调用，断言它定位的就是刚落盘那条路径；再把宿主改成「定位失败」，断言会退回把路径摊开给用户。

**变异测试 20/20 全部被拦下**：去掉 `.toast-clickable` / 去掉 `role`+`tabindex` / 点按钮时顺带触发
`onClick` / 点完不收卡 / 任意键都算激活 / 去掉点击提示 / 去掉 pointer 光标 / `api.js` 命令名写错 /
`pluginHost` 方法改名 / 不校验 `ui` 权限 / Rust 未注册命令 / 不校验路径范围 / 不要求文件存在 /
`path_within` 退回 `Path::starts_with` / 改走 `open_path` 而非 `reveal_item_in_dir` /
Android 静默成功 / 插件横幅退回纯文字 / 去掉定位失败兜底 / 提示文案改名 / 成绩单横幅不再可点。

**真 CSS 几何探针**（无头 Chrome，真 `src/styles.css`，1280×300，`.toast` 的 `max-width: 380px` 生效档）：

| 版本 | 正文 span 宽度 | 画到卡片外 |
|---|---|---|
| 去掉 `overflow-wrap: anywhere` | 504.28px | **溢出 142.28px** |
| 本次（有这条规则） | 255px（换行收进卡内） | 0 |

原因是下载回来的文件名一旦没有可断行处（纯 ASCII 长名，`\` 与 `-` 都不是断点），
380px 的卡根本收不住。对照图与截图：`le-time-management/output/preview/toast-clickable-1280-before.png`
/ `toast-clickable-1280-after.png`（像素差分 4.19%，差异全部落在右下角横幅区域）。

**Rust** `cargo check` 通过（仅剩 `vault.rs` 一条既有的 unused variable 告警）；`cargo test --lib`
19/19 通过（含新增的 `path_within_covers_case_and_prefix_lookalikes`）。

**全量** `node scripts/run-tests.mjs`：本次改动涉及的 13 个测试脚本逐个复跑全绿
（`test-reveal-saved-file` / `test-cppu` / `test-notify-stack` / `test-css-integrity` /
`test-version-consistency` / `test-plugin-permissions` / `test-cppu-campus` /
`test-cppu-cache` / `test-cppu-card-buttons` / `test-cppu-card-averages` /
`test-cppu-login-settings` / `test-android-layout` / `test-ui-scale`）。
`sync-version --check` / `gen-theme-dark --check` / `build-schedule-plugin --check` /
`sync-android-native --check` / `sync-plugins --check` 全部通过。

> 全量套件里当时还红着 3 个**与本次改动无关**的脚本，都是同一工作区里其它改动「改了插件行为但没跟上
> 它们钉死的版本号」：`test-rss-reader`（manifest 已 1.7.0，脚本钉 1.6.1）、
> `test-web-collector`（1.6.0 / 1.5.0）、`test-chaoxing`（2.18.0 / 2.17.0）。

## 六、影响范围

- 宿主：`src/ui.js`（toast 选项）、`src/styles.css`（4 条 `.toast-*` 规则）、
  `src/api.js`、`src/pluginHost.js`、`src-tauri/src/lib.rs`（新命令 + `path_within`）。
- 插件：`cppu-notify` 1.35.1 → **1.36.0**，`plugin-guide` 1.4.2 → **1.4.3**
  （清单是事实源，改完跑了 `node tools/sync-plugins.js`，桌面与小程序插件目录已同源）。
- 没有数据迁移，没有接口破坏性变更，没有新增生成物。
- Android 上横幅同样可点，但**没有**「在文件夹里选中文件」这个能力 —— 点下去会在应用内提示路径。

## 升版本

`package.json` 0.183.0 → 0.184.0（本次改动落地时的下一步），`node ../tools/sync-version.js`
同步三端；随后同工作区另一条改动把三端一起抬到 **0.185.0**，`--check` 通过。
`package.json` / `package-lock.json`（两处）/ `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` /
`miniprogram/core/appMeta.js` 的版本号现均为 0.185.0。
