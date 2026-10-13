# v0.209.0 · 应用里按一下，就把眼前这一屏截成 PNG

> 本版四项生成器校验全绿：`✓ 三端版本一致：v0.209.0`、`✓ 派生调色板已同步（15 套深色变体）`、
> `✓ shiguang-schedule 生成物与源一致`、`✓ Android 原生代码与版本化镜像一致`；
> `cargo check --lib` 退出码 0（仅剩 `vault.rs:32` 那条既有的 `unused variable: path` 警告）；
> `npm test` → `PASS: 132 个测试脚本全部通过`。

## 用户要求

> 能不能生成界面图片，能不能给应用开个快捷生成界面演示图片的后门

两件事：先把图出出来，再让应用自己会出图。

## 一、先出图：警大获奖名单演示图

`docs/screenshots/` 新增 5 张（`desktop-award-items` / `-items-collapsed` / `-items-dark` /
`-rank-person` / `-rank-team`），都是「警大通知」插件上一版新增的**获奖名单**视图：
奖项项目（含展开态与深色）、获奖排名（个人榜与团体榜）。

出图链路复用了技能 `letime-plugin-ui-check` 的无头 Chrome 路线，另加两样东西：

- `tools/shots/fixtures/cppu-notify.mjs` —— 演示专用假数据（6 条通知，人名、成绩、单位、时间
  全是编的，不进产品运行时）。刻意覆盖四类真实写法：级别行 + 纯姓名名单行、级别与名单同行、
  团体带成员、指导教师行，另配两条干扰项（正文无名单 / 标题不含获奖词）。
- `tools/shots/audit.mjs` —— 用 CDP 量真几何（元素是否溢出、有没有重叠），出图前先过一遍，
  免得把「文字压在一起」的截图当成品交出去。

技能 harness 同时修掉三个「替身不真」的缺陷（都在技能目录，不进本仓库）：
`textarea.value` 没做实体解码导致插件 `cleanText()` 恒返回空串、`innerHTML` 取值优先返回原始
字符串导致动态内容被藏、渲染只等一轮 tick 导致异步填充还没落地就出图。前两个是「页面看着有壳、
其实正文全丢」的根因。

## 二、后门：三个入口，一条链路

`生成界面演示图` 现在有三个入口，全部落到 `src/uiShot.js` 的 `captureUiShot()`：

| 入口 | 位置 | 说明 |
|---|---|---|
| 命令面板 | 搜「演示图 / 截图 / 出图 / screenshot」 | 面板先关闭，留 320ms 等浮层收完，免得把自己拍进去 |
| 全局快捷键 | `CommandOrControl+Alt+S`（`tide:ui-shot`） | 键位在设置页可改；刻意避开 `Ctrl+Shift+S`——那是 WebView 的「另存为」 |
| 设置页 | 快捷键分组第三个输入框 | 旁边一句提示说明它干什么、存到哪 |

链路：`uiShot.js` → `api.captureUiShot(name)` → Rust 命令 `capture_ui_shot` →
WebView2 `ICoreWebView2::CapturePreview` → 内存流读回 PNG 字节 → `save_to_download_dir()`。
文件名 `界面演示图-<当前视图>-<YYYY-MM-DD_HHmmss>.png`，落**系统下载目录**（与「保存附件」同一
套落盘逻辑），落盘后 toast 带一个「打开文件夹」动作。

截的是渲染层自己，所以**真实数据、当前主题、滚动位置、展开状态都在**——这正是文档配图需要的，
也是「另建一个页面截图」给不了的。

## 三、为什么不用 Rust 抓窗口

抓窗口（`BitBlt` / `PrintWindow`）要先给 `windows-sys` 加 `Win32_Graphics_Gdi`，
还得处理 DPI 缩放、窗口遮挡、多显示器，且截出来的是**含窗口边框与标题栏**的位图。
而 Tauri 2 已经带着 `webview2-com 0.38.2`（`Cargo.lock` 里本来就有），
`CapturePreview` 是 WebView2 自带接口：UI 线程发起、完成回调同样由 UI 线程派发，
拿到的就是干净的页面像素。成本只是一次 `with_webview` 取 controller——仓库里
`lib.rs` 已有两处同样写法（浏览器窗口、二维码），不是新机制。

`CapturePreview` 只能在 UI 线程发起，所以整条链路是 `async` + `mpsc` 把字节交回调用方，
不让任何 COM 回调跨线程碰状态。

## 四、两处刻意的取舍

- **只在桌面端出现**。Android 的 WebView 没有对应接口，Rust 侧直接返回错误；
  入口由 `uiShotSupported()` 收起来——设置页不显示那一行、命令面板里那条命令根本不出现，
  而不是让用户点了才吃一句报错。
- **连按只截一张**。`busy` 闸门挡住重入：两帧几乎相同的图没有意义，还会并发落盘撞文件名。

## 五、动的文件

- `src-tauri/Cargo.toml`：新增直接依赖 `webview2-com 0.38`（仅 Windows）、
  `windows 0.61`（features 只要 `Graphics_Gdi` / `Graphics_Imaging` / `Foundation` /
  `Storage_Streams` / `System_Com*` / `System_Variant`）。
- `src-tauri/src/lib.rs`：`capture_ui_shot`（命令）、`shot_file_name`（文件名白名单 + 时间戳）、
  `capture_webview_png` / `start_capture_preview` / `read_stream_bytes`（Windows 实现）、
  非 Windows 的失败桩，并在 `invoke_handler` 注册。
- `src/uiShot.js`（新增）、`src/api.js`（`captureUiShot`）、`src/main.js`（`initUiShot()`）。
- `src/globalShortcuts.js`（默认键 + `tide:ui-shot` 分发）、`src/commandPalette.js`（命令）、
  `src/views/settings/shortcuts.js`（第三个输入框 + 提示，手机端整行不显示）、`src/settingsSearchIndex.js`（搜索词）。
- `scripts/test-ui-shot.mjs`（新增）：用 vm 把两个 import 换成桩后**真跑** `uiShot.js`，
  覆盖桌面/手机分支、重入闸门、文件名与时间戳、toast 的「打开文件夹」、`tide:ui-shot` 事件入口，
  再对跨文件契约（命令面板 / 快捷键键位与分发 / 设置页 / Rust 命令与 `CapturePreview`）做静态断言。
- `tools/shots/`（fixture 与几何审计，中间产物 `out/` 已进 `.gitignore`）、`docs/screenshots/` 5 张新图。

## 六、验证命令

```bash
cd le-time-management
node ../tools/sync-version.js --check        # ✓ 三端版本一致：v0.209.0
node ../tools/gen-theme-dark.js --check      # ✓ 派生调色板已同步（15 套深色变体）
node ../tools/build-schedule-plugin.js --check
node ../tools/sync-android-native.js --check # ✓ Android 原生代码与版本化镜像一致
cargo check --lib --manifest-path src-tauri/Cargo.toml
npm test                                     # PASS: 131 个测试脚本全部通过
```

**一句话**：图先用手上的工具出（可复现、可批量），再把这条链路搬进应用里一键可用的位置——
两边各管一段，谁都不将就。
