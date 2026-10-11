# v0.196.0 · APK 跟上更新：内嵌配置与启动器图标不再停在 `tauri android init` 那一刻

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.196.0`；
> `node tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致（Kotlin 与自有资源 / 清单权限与教务窗口与提醒接收器 / FileProvider 路径 / assets 配置与启动器图标）`。
> 动的文件：`tools/sync-android-native.js`（454 → 约 540 行，新增第 ④ 类「事实源在 `src-tauri` 下的自有产物」）、
> `le-time-management/package.json` / `package-lock.json`（0.195.0 → **0.196.0**）、根 `docs/CHANGELOG-v0.196.0.md`。
> **产品代码一行没动**，改的是构建链路 —— 但升了版本号，因为产物内容变了（配置与图标都进了 APK）。

## 用户要求原文

> 「让apk跟上更新」

## 一、问题形态：APK 里装着一份 v0.11.2 的配置和品牌改名前的图标

拿 v0.195.0 的发布包 `releases/v0.195.0/UTime-0.195.0-universal.apk` 直接拆开看（zip 解析读 `assets/`），
里面的 `assets/tauri.conf.json` 是**旧的**：

| 字段 | APK 里（旧） | 仓库事实源（当时） |
|---|---|---|
| `productName` | `Le时间管理` | `U-Time` |
| `version` | `0.11.2` | `0.195.0` |
| `app.windows[0]` | `1280x820`，**没有** `visible:false` / `decorations:false` | `1360x860`，两者都有 |
| `bundle.windows` | **整段不存在**（NSIS 语言、安装钩子、WiX 语言全缺） | 齐全 |

落后 180 多个版本，品牌名还是改名前的。启动器图标同样旧：把 `src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png`
和 `gen/android/.../mipmap-xxxhdpi/ic_launcher.png` 做像素比对，**192×192 里 52.75% 的像素不同** —— 那是品牌改名前的图。
`mipmap-anydpi-v26/`（Android 8+ 的 adaptive icon）在 `gen` 里**根本不存在**，`values/ic_launcher_background.xml` 也缺。

同一份 APK 里其它东西都是新的（`strings.xml` 的 `app_name` = `U-Time`、`main_activity_title` = `U-Time · 时间块与四象限`、
`ApkInstallerPlugin` / `NotificationPlugin` / `SystemBarPlugin` / `NativeSchedulePlugin` / `MainActivity` 全在、
`lib/arm64-v8a/libletime_lib.so` 里 `mojinghub` 与 `0.195.0` 都在、没有 `0.11.2` 也没有 `Le时间管理`）
—— 所以问题不是「APK 没重新构建」，而是**有两样东西从来没进过同步链路**。

## 二、根因：`tauri android init` 只写一次，之后 CLI 再也不刷新

`src-tauri/gen/` 是 gitignored 的生成目录，里面的东西分三种来路：

| 来路 | 例子 | 谁维护 |
|---|---|---|
| 我们写、`sync-android-native.js` 灌进去 | `com/yile/letime/*.kt`、`AndroidManifest.xml` 的权限补丁、`file_paths.xml` | ✅ 已有同步器 |
| Tauri 模板 / 构建生成 | `generated/*.kt`、`proguard-wry.pro`、`tauri.properties`、`gradlew` | 框架自己 |
| **`init` 那一刻从 `src-tauri` 拷一次，之后没人管** | **`assets/tauri.conf.json`、`res/mipmap-*` 图标** | ❌ **谁都不管 —— 本次修的** |

第三类是本次的主角。证据链：

- `@tauri-apps/cli` 的二进制里能搜到 `app/.gitignore` 模板内容，其中一行就是 `/src/main/assets/tauri.conf.json`
  （和 `/src/main/**/generated`、`/src/main/jniLibs/**/*.so` 并列）→ Tauri 把这份配置当**生成物**，只在 init 时落一次。
- `gen/android/app/src/main/assets/tauri.conf.json` 的 mtime 是 **2026-09-12 15:43**，与同批 `generated/*.kt` 一致 —— 正是最后一次 `init` 的时刻。
- 启动器图标的事实源 `src-tauri/icons/android/`（17 个文件）mtime **2026-09-12 13:02**，随品牌改名提交 `469d034`
  「chore: 品牌改名 潮衡/TideBalance → Le时间管理」一起进来；而 `gen` 里那批 PNG 的 mtime 是 **2026-09-06 22:06**（更早的 init）。
  **改名后没人重跑 init，于是 APK 一直用着改名前的图标。**

### 这份 `assets/tauri.conf.json` 到底谁在读

Android 侧读它的官方入口是 `app.tauri.plugin.PluginManager.loadConfig()`（`tauri-2.11.5/mobile/android/.../PluginManager.kt:209`）：

```kotlin
val tauriConfigJson = FsUtils.readAsset(context.assets, "tauri.conf.json")
val mapper = ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
val config = mapper.readValue(tauriConfigJson, Config::class.java)   // Config { plugins: Map<String, JsonNode> }
return mapper.readValue(config.plugins[plugin].toString(), cls)
```

即：**官方插件的 Kotlin 端靠它取自己在 `plugins.<id>` 下的配置**。本项目当前的依赖集里
（`tauri-android` + `tauri-plugin-opener`）还没有调用者，所以现在没爆出可见故障 ——
但它是一颗定时炸弹：哪天接一个需要 Kotlin 侧读配置的官方插件（通知、深链、barcode…），
读到的就是这份 v0.11.2 的陈旧 JSON，而且 `plugins` 段缺失会让 `config.plugins[plugin]` 直接抛 `lateinit` 未初始化。

**顺带排除一个误判**：端上「关于」显示的版本号不受这个文件影响。
`tauri-codegen-2.7.2/src/context.rs:257` 里 `package_version` 是**编译期**从 `src-tauri/tauri.conf.json` 取的
（`config.version` 优先，否则 `CARGO_PKG_VERSION`），所以 `app.package_info().version` 一直是 `0.195.0`，
更新检查的版本比较没问题。

## 三、修法：给同步器加第 ④ 类，把这两样也按「我们拥有的文件」整份覆盖

`tools/sync-android-native.js` 原本管三类（自有 Kotlin 资源 / 清单补丁 / `file_paths.xml`），现在加第四类：

```js
const CONF_SOURCE = path.join(APP, "src-tauri", "tauri.conf.json");
const CONF_TARGET = path.join(GEN, "app/src/main/assets/tauri.conf.json");
const ICON_SOURCE = path.join(APP, "src-tauri", "icons", "android");
const ICON_TARGET_REL = "app/src/main/res";
```

- `syncFile(fromAbs, toAbs, label, why)` —— **用 `Buffer.equals` 比对，二进制安全**（图标是 PNG，不能按 utf8 读）；
  返回 `"same"` / `"synced"` / `false` 三态，`--check` 时不一致记 `failures` 并打 `[不一致]`，否则写盘并记 `changes`。
- `listFiles(dir, base)` —— 递归列出事实源目录，映射到 `app/src/main/res/<相对路径>`，
  所以 `mipmap-anydpi-v26/ic_launcher.xml`、`values/ic_launcher_background.xml` 这些**原来 gen 里没有的**也会被建出来。
- `syncTauriOwned()` —— 先同步 `assets/tauri.conf.json`，再遍历 17 个图标文件；全一致时只打一行汇总，不刷屏。

主流程从 `syncOwned() → patchManifest() → patchFilePaths()` 变成四段串行，最后一段就是它。
`--capture`（从 gen 采纳回版本化镜像）**不包含**这两样，因为它们的事实源本来就在 `src-tauri` 下，
不该往 `le-time-management/android/gradle/` 里倒灌 —— 脚本里加了一行提示说明这点。

## 四、跑一遍的结果

```
  [已同步] app/src/main/assets/tauri.conf.json
  [已同步] app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
  [已同步] app/src/main/res/mipmap-hdpi/ic_launcher.png        （× 5 个密度 × 3 张 = 15 张 PNG）
  [已同步] app/src/main/res/values/ic_launcher_background.xml
✓ 已同步 Android 原生代码：app/src/main/assets/tauri.conf.json、…（共 18 项）
```

再跑 `--check`：18 项全部 `[已一致]`，`✓ Android 原生代码与版本化镜像一致`。

刷新后 `gen/android/app/src/main/assets/tauri.conf.json` 已是 `"productName": "U-Time"` / `"version": "0.196.0"`，
与 `src-tauri/tauri.conf.json` 逐字节相同；adaptive icon 定义 `mipmap-anydpi-v26/ic_launcher.xml` 也已就位
（前景 `@mipmap/ic_launcher_foreground` + 背景 `@color/ic_launcher_background`，与 `tauri icon` 生成的官方结构一致）。

> 注：`gen` 里模板自带的 `drawable/ic_launcher_background.xml`（矢量）与新增的 `values/ic_launcher_background.xml`（颜色）
> 同名但**资源类型不同**（`@drawable/…` vs `@color/…`），AAPT2 允许并存，不会冲突。

## 五、影响面

- **Android**：下次构建出的 APK 里，`assets/tauri.conf.json` 与启动器图标都跟上仓库；
  Android 8+ 会走 adaptive icon（此前因为没有 `mipmap-anydpi-v26` 而一直退回用 PNG）。
- **Windows / Linux**：无变化（这两样只进 Android 包）。
- **数据**：无迁移，无接口变更。
- **构建链路**：以后改 `src-tauri/tauri.conf.json` 的窗口/打包配置、或重跑 `tauri icon` 换图标，
  跑一次 `node tools/sync-android-native.js` 就能把 gen 刷新；`--check` 会拦住「改了事实源忘了同步」。
