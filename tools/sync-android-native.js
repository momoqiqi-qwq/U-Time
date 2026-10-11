#!/usr/bin/env node
// 把 Android 端「原生代码」从版本化镜像同步进 Tauri 的生成目录，并补齐只能靠补丁生效的声明。
//
// ── 为什么需要这个脚本 ──
// `src-tauri/gen/android/` 是 Tauri 的生成目录（被 .gitignore 忽略），**重新执行一次
// `tauri android init` 就会把它整个重建**。可手机端真正干活的 Kotlin 只活在那里：
//   · v0.37.12 SchoolImportActivity（教务窗口 close 关不掉）
//   · BrowserActivity（普通网页的应用内 WebView 容器）
//   · v0.37.15 MainActivity 安全区注入（WebView 不实现 env(safe-area-inset-*)）
//   · v0.37.17 MainActivity 返回键 handleBackNavigation + 双指缩放
//   · v0.38.0 ApkInstallerPlugin（应用内一键升级）
//   · AppUninstallerPlugin（应用内「卸载本应用」，交系统卸载程序）
//   · v0.73.0 NotificationPlugin + ReminderHub + 三个接收器（系统通知与后台闹钟），
//     以及 MainActivity 长鸣期间不冻结 WebView 的 onPause 补丁
// 只要有人 init 一次，上面全部静默消失，而且因为目录不进 git，**回滚都没得回**。
//
// ── 事实源与目标 ──
//   事实源：le-time-management/android/gradle/      （版本化镜像，与 gen/android 路径 1:1）
//   目标：  le-time-management/src-tauri/gen/android/
//
// ── 四类处理（刻意分开，别合并成「整目录覆盖」）──
//   ① 我们拥有的文件（Kotlin 源码 + 通知小图标等资源）：整份覆盖。这部分百分之百是我们
//      写的，没有上游模板会被盖坏的问题。清单见 SOURCES 与 RESOURCES。
//   ② AndroidManifest.xml：**只加不删的补丁** —— 补 REQUEST_INSTALL_PACKAGES /
//      REQUEST_DELETE_PACKAGES 与通知/闹钟四条权限、注册 .SchoolImportActivity /
//      .BrowserActivity 与三个提醒接收器、删 MainActivity 的 label。
//      不做整份覆盖 —— 否则将来 Tauri 模板新增的 permission/provider 会被我们的旧副本吃掉。
//      FileProvider 的 provider 块是 Tauri 模板自带的，**只校验不合成**（合成容易写错一整个块）。
//   ③ res/xml/file_paths.xml：确保 `<cache-path>` 存在。Rust 侧把更新包暂存在
//      `app_cache_dir()`（＝Android 的 `getCacheDir`，内部缓存），FileProvider 靠这条声明才肯共享。
//   ④ 事实源在 src-tauri 下的自有产物：`assets/tauri.conf.json`（Android 运行时读它）与
//      启动器图标 `res/mipmap-*`。`tauri android init` 拷一次就再也不管，init 之后换品牌
//      图标 / 改窗口配置，gen 里会永远停在旧快照 —— 也就是「apk 跟不上更新」。整份覆盖。
//
// ── 用法 ──
//   node tools/sync-android-native.js            应用（同步我们拥有的文件 + 打补丁）
//   node tools/sync-android-native.js --check    只校验，不写文件
//   node tools/sync-android-native.js --capture  反向：把 gen 里的现状采纳为镜像
//                                                （只在 `tauri android init` 重建过、需要重建基线时用）
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "le-time-management");
const MIRROR = path.join(APP, "android", "gradle");
const GEN = path.join(APP, "src-tauri", "gen", "android");

const KOTLIN_DIR = "app/src/main/java/com/yile/letime";
/** 我们完整拥有的 Kotlin 源文件（镜像 → gen 整份覆盖）。加新文件就加一条。 */
const SOURCES = [
  "MainActivity.kt",
  "SchoolImportActivity.kt",
  "BrowserActivity.kt",
  "NativeSchedulePlugin.kt",
  "ApkInstallerPlugin.kt",
  "AppUninstallerPlugin.kt",
  "SystemBarPlugin.kt",
  // v0.73.0 系统通知与闹钟：插件 + 中枢 + 三个广播接收器
  "ReminderHub.kt",
  "NotificationPlugin.kt",
  "ReminderReceivers.kt",
];
/**
 * 我们拥有的资源文件（同样是镜像 → gen 整份覆盖）。
 *
 * 通知小图标必须我们自己给：系统会把通知的 small icon **整体染成单色剪影**，
 * 只认 alpha，拿彩色实心的启动器图标去用就是一坨白块。
 */
const RESOURCES = ["app/src/main/res/drawable/ic_stat_letime.xml"];
const MANIFEST = "app/src/main/AndroidManifest.xml";
const FILE_PATHS = "app/src/main/res/xml/file_paths.xml";
/** Android 8.0 起「安装未知来源应用」是按应用授权，没有它系统安装器会被静默拦掉。 */
const INSTALL_PERMISSION = "android.permission.REQUEST_INSTALL_PACKAGES";
/**
 * 应用内「卸载本应用」（`AppUninstallerPlugin`）要的那条。
 *
 * 系统的卸载 Activity 带 `android:permission="REQUEST_DELETE_PACKAGES"` 保护：
 * 调用方没声明这条权限时，`startActivity(ACTION_DELETE)` 抛 SecurityException，
 * 症状是「点了卸载按钮没反应」—— 而这条权限装完就自动生效，不需要运行时授权，
 * 所以漏了只能靠清单，运行时探不出来。
 */
const UNINSTALL_PERMISSION = "android.permission.REQUEST_DELETE_PACKAGES";
/**
 * v0.73.0 通知与闹钟所需的权限。清单合并只认声明过的权限，缺一个就是运行期才炸：
 *   · POST_NOTIFICATIONS —— Android 13 起通知是运行时权限，没声明连弹窗都给不出来
 *   · VIBRATE —— 渠道的 enableVibration
 *   · SCHEDULE_EXACT_ALARM —— API 31 起精确闹钟变成用户可撤销授权（没批会退化成
 *     非精确排期，Doze 下最坏晚几分钟，所以设置页还要给一个引导入口）
 *   · RECEIVE_BOOT_COMPLETED —— 闹钟不跨重启，开机必须自己从持久化记录里重排
 */
const NOTIFICATION_PERMISSIONS = [
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.VIBRATE",
  "android.permission.SCHEDULE_EXACT_ALARM",
  "android.permission.RECEIVE_BOOT_COMPLETED",
];

const CHECK = process.argv.includes("--check");
const CAPTURE = process.argv.includes("--capture");
const failures = [];
const changes = [];

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const write = (file, text) => fs.writeFileSync(file, text);

/** gen/android 还不存在（全新 clone 没跑过 `tauri android init`）—— 不是错误，跳过即可。 */
if (!fs.existsSync(GEN)) {
  console.log("── gen/android 尚未生成，跳过 Android 原生同步（先跑一次 `tauri android init`）──");
  process.exit(0);
}

/* ─────────────── ① Kotlin 源码与自有资源 ─────────────── */

/** 镜像里我们完整拥有的文件（相对 gen/android 与 android/gradle 两边的路径 1:1）。 */
function ownedFiles() {
  return [...SOURCES.map((name) => `${KOTLIN_DIR}/${name}`), ...RESOURCES];
}

function captureKotlin() {
  let captured = 0;
  const owned = new Set(ownedFiles());
  for (const rel of ownedFiles()) {
    const from = path.join(GEN, rel);
    const to = path.join(MIRROR, rel);
    const text = read(from);
    if (text === null) {
      console.log(`  [gen 缺] ${rel}`);
      continue;
    }
    if (read(to) === text) {
      console.log(`  [已一致] ${rel}`);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    write(to, text);
    console.log(`  [已采纳] ${rel} → android/gradle/${rel}`);
    captured++;
  }
  // gen 里多出、又没进清单的 .kt：多半是刚写还没登记，提醒一句而不是静默丢。
  const genDir = path.join(GEN, KOTLIN_DIR);
  for (const name of fs.existsSync(genDir) ? fs.readdirSync(genDir).filter((f) => f.endsWith(".kt")) : []) {
    if (!owned.has(`${KOTLIN_DIR}/${name}`)) console.log(`  ⚠ gen 里还有未纳入镜像的 Kotlin：${name}（加进 SOURCES 后重跑 --capture）`);
  }
  console.log(`✓ 已从 gen 采纳 ${captured} 个文件到版本化镜像`);
  console.log("  （assets/tauri.conf.json 与启动器图标的事实源在 src-tauri 下，不参与 --capture）");
}

function syncOwned() {
  for (const rel of ownedFiles()) {
    const from = path.join(MIRROR, rel);
    const to = path.join(GEN, rel);
    const text = read(from);
    if (text === null) {
      failures.push(`镜像缺源文件：android/gradle/${rel}`);
      continue;
    }
    if (read(to) === text) {
      console.log(`  [已一致] ${rel}`);
      continue;
    }
    if (CHECK) {
      failures.push(`${rel}：gen/android 里的副本与版本化镜像不一致`);
      console.log(`  [不一致] ${rel}`);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      write(to, text);
      changes.push(rel);
      console.log(`  [已同步] ${rel}`);
    }
  }
}

/* ─────────────── ② AndroidManifest.xml 补丁 ─────────────── */

/** 幂等：已存在就原样返回，不重复插入。 */
function ensurePermission(xml, permission) {
  if (xml.includes(permission)) return { xml, changed: false };
  const line = `    <uses-permission android:name="${permission}" />`;
  const usesPermission = /^[ \t]*<uses-permission\b[^>]*\/>/m;
  if (usesPermission.test(xml)) {
    return { xml: xml.replace(usesPermission, (m) => `${m}\n${line}`), changed: true };
  }
  const manifestTag = /<manifest\b[^>]*>/;
  if (manifestTag.test(xml)) {
    return { xml: xml.replace(manifestTag, (m) => `${m}\n${line}`), changed: true };
  }
  return { xml, changed: false, anchorMissing: true };
}

/**
 * 删掉 MainActivity 的 `android:label`。launcher 图标显示的是 activity 级 label，
 * 留着会变成「U-Time · 时间块与四象限」，手机桌面放不下被截断。
 * 教务窗口（SchoolImportActivity）的 label 是**有意保留**的应用内标题，只按 android:name 精确删。
 */
function stripMainActivityLabel(xml) {
  const pat = /(<activity\b(?:(?!>).)*?android:name="\.MainActivity")((?:(?!>).)*?>)/s;
  if (!pat.test(xml)) return { xml, changed: false };
  const out = xml.replace(pat, (_m, head, tail) => {
    const strip = (s) => s.replace(/\n[ \t]*android:label="@string\/main_activity_title"/, "");
    return strip(head) + strip(tail);
  });
  return { xml: out, changed: out !== xml };
}

/** 教务导入窗口专用 Activity 的声明块（v0.37.12 手加，不是 Tauri 模板内容）。 */
const SCHOOL_IMPORT_ACTIVITY_BLOCK = `
        <!-- 教务导入窗口（school_import_open 在 Android 上指定 activity_name）：
             仅应用内启动，不 exported；singleTop 避免重复实例堆栈 -->
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:label="@string/main_activity_title"
            android:launchMode="singleTop"
            android:name=".SchoolImportActivity"
            android:exported="false" />`;

/** 普通网页的应用内 WebView Activity；与教务专用窗口分开，避免桥接逻辑互相污染。 */
const BROWSER_ACTIVITY_BLOCK = `
        <!-- 普通网页应用内打开窗口：无导出、无深链，仅由 Rust open_internal 启动。 -->
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:label="@string/app_name"
            android:launchMode="singleTop"
            android:name=".BrowserActivity"
            android:exported="false" />`;

/**
 * 教务导入窗口必须在清单里注册，否则 `startActivity` 直接崩（它是 abstract 的
 * TauriActivity 之外唯一能承载教务页的具体 Activity）。
 *
 * 插入位置优先选 `<provider` **之前**，让两个 activity 挨在一起 —— `<application>` 子元素
 * 顺序在 Android 里不影响行为，但这里的定位原则是「生成结果要能跟 android/gradle 下的
 * 参考副本逐行对上」：`tauri android init` 之后人工比对是唯一的恢复手段，
 * 输出顺序随机的话那次比对就没法做了。
 */
function ensureSchoolImportActivity(xml) {
  if (xml.includes('android:name=".SchoolImportActivity"')) return { xml, changed: false };
  const provider = /^[ \t]*<provider\b/m;
  if (provider.test(xml)) {
    return { xml: xml.replace(provider, (m) => `${SCHOOL_IMPORT_ACTIVITY_BLOCK}\n\n${m}`), changed: true };
  }
  const anchor = "</application>";
  if (xml.includes(anchor)) {
    return { xml: xml.replace(anchor, `${SCHOOL_IMPORT_ACTIVITY_BLOCK}\n    ${anchor}`), changed: true };
  }
  return { xml, changed: false, anchorMissing: true };
}

function ensureBrowserActivity(xml) {
  if (xml.includes('android:name=".BrowserActivity"')) return { xml, changed: false };
  const school = /(<activity\b(?:(?!>).)*?android:name="\.SchoolImportActivity"(?:(?!>).)*?\/>)/s;
  if (school.test(xml)) {
    return { xml: xml.replace(school, (m) => `${m}\n${BROWSER_ACTIVITY_BLOCK}`), changed: true };
  }
  const provider = /^[ \t]*<provider\b/m;
  if (provider.test(xml)) {
    return { xml: xml.replace(provider, (m) => `${BROWSER_ACTIVITY_BLOCK}\n\n${m}`), changed: true };
  }
  return { xml, changed: false, anchorMissing: true };
}

/**
 * 任务提醒的三个广播接收器（v0.73.0）。
 *
 * 闹钟到点、通知按钮、开机重排都靠它们，而它们**必须在清单里注册**：
 * 没注册的话 `PendingIntent.getBroadcast` 照样能构造成功，直到闹钟真的响起来
 * 才由系统投递失败 —— 也就是「应用内提醒正常、被杀之后一条都不弹」，
 * 是最难查的那种坏法。
 *
 * 前两个只被我们自己的 PendingIntent 显式点名 ⇒ exported=false；
 * 开机广播由系统投递，API 31 起必须显式 exported="true" 才收得到。
 */
const REMINDER_RECEIVERS_BLOCK = `
        <!-- 任务提醒（v0.73.0）：闹钟到点 / 通知按钮 / 开机重排三个接收器 -->
        <receiver
            android:name=".ReminderAlarmReceiver"
            android:exported="false" />
        <receiver
            android:name=".ReminderActionReceiver"
            android:exported="false" />
        <receiver
            android:name=".ReminderBootReceiver"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
            </intent-filter>
        </receiver>`;

function ensureReminderReceivers(xml) {
  if (xml.includes('android:name=".ReminderAlarmReceiver"')) return { xml, changed: false };
  const provider = /^[ \t]*<provider\b/m;
  if (provider.test(xml)) {
    return { xml: xml.replace(provider, (m) => `${REMINDER_RECEIVERS_BLOCK}\n\n${m}`), changed: true };
  }
  const anchor = "</application>";
  if (xml.includes(anchor)) {
    return { xml: xml.replace(anchor, `${REMINDER_RECEIVERS_BLOCK}\n    ${anchor}`), changed: true };
  }
  return { xml, changed: false, anchorMissing: true };
}

/**
 * 端内扫一扫（src/qrScan.js）要的两条相机声明，缺一不可：
 *   · uses-permission CAMERA —— WebView 报 VIDEO_CAPTURE 时，wry 的 RustWebChromeClient
 *     拿这条去问系统授权。清单里没声明的话 ActivityResult 会被系统直接判拒，
 *     **连授权弹窗都不会出现**，用户侧只看到「点了扫码没反应」。
 *   · uses-feature camera required=false —— 只声明权限的话，商店会把「带相机」当成安装门槛，
 *     没相机的设备搜不到也装不上本程序。扫码只是可选入口，必须显式写成非必需。
 */
const CAMERA_PERMISSION = "android.permission.CAMERA";
const CAMERA_FEATURE = "android.hardware.camera";

function ensureCameraDeclarations(xml) {
  let out = xml;
  const insertAtTopLevel = (line) => {
    const firstPerm = /^[ \t]*<uses-permission\b[^>]*\/>/m;
    if (firstPerm.test(out)) out = out.replace(firstPerm, (m) => `${m}\n${line}`);
    else out = out.replace(/<manifest\b[^>]*>/, (m) => `${m}\n${line}`);
  };
  if (!out.includes(CAMERA_PERMISSION)) insertAtTopLevel(`    <uses-permission android:name="${CAMERA_PERMISSION}" />`);
  if (!new RegExp(`android:name="${CAMERA_FEATURE}"`).test(out)) {
    insertAtTopLevel(`    <uses-feature android:name="${CAMERA_FEATURE}" android:required="false" />`);
  }
  return { xml: out, changed: out !== xml };
}

/**
 * FileProvider 的 provider 块由 Tauri 模板自带，**这里只校验不合成** ——
 * 合成整个 provider 块要把 authority / meta-data 写全，写错一个字母就是运行期才炸的
 * "Failed to find configured root"，不值得。丢了说明模板变了，该由人来看。
 * 它是 APK 一键升级的必要条件：`content://` URI 就是它签发的。
 */
function checkFileProvider(xml) {
  const ok = /android:name="androidx\.core\.content\.FileProvider"/.test(xml);
  if (!ok) {
    failures.push(
      "AndroidManifest.xml：缺 FileProvider（androidx.core.content.FileProvider）声明，" +
        "APK 无法以 content:// 交给系统安装器（Tauri 模板应自带，检查是否被 init 覆盖）",
    );
  }
  return ok;
}

function patchManifest() {
  const file = path.join(GEN, MANIFEST);
  const src = read(file);
  if (src === null) {
    failures.push(`缺少 ${MANIFEST}（gen 未初始化？）`);
    return;
  }
  let xml = src;
  const perm = ensurePermission(xml, INSTALL_PERMISSION);
  xml = perm.xml;
  const uninstallPerm = ensurePermission(xml, UNINSTALL_PERMISSION);
  xml = uninstallPerm.xml;
  // 通知与闹钟的四条权限逐条幂等补齐（ensurePermission 已存在就原样返回）。
  const extraPerms = [];
  for (const permission of NOTIFICATION_PERMISSIONS) {
    const r = ensurePermission(xml, permission);
    xml = r.xml;
    if (r.changed) extraPerms.push(permission.split(".").pop().toLowerCase().replace(/_/g, "-"));
  }
  const camera = ensureCameraDeclarations(xml);
  xml = camera.xml;
  const activity = ensureSchoolImportActivity(xml);
  xml = activity.xml;
  const browserActivity = ensureBrowserActivity(xml);
  xml = browserActivity.xml;
  const receivers = ensureReminderReceivers(xml);
  xml = receivers.xml;
  const label = stripMainActivityLabel(xml);
  xml = label.xml;

  if (!checkFileProvider(xml)) console.log("  [缺失] AndroidManifest.xml 的 FileProvider 声明");

  if (xml === src) {
    console.log(`  [已一致] AndroidManifest.xml（权限 / 相机 / 教务与网页窗口 / 提醒接收器 / label 都已就位）`);
    return;
  }
  const detail = [
    perm.changed && "补安装权限",
    uninstallPerm.changed && "补卸载权限",
    extraPerms.length && `补通知权限（${extraPerms.join("、")}）`,
    camera.changed && "补相机声明（权限 + 非必需 feature）",
    activity.changed && "注册 SchoolImportActivity",
    browserActivity.changed && "注册 BrowserActivity",
    receivers.changed && "注册提醒接收器",
    label.changed && "去 MainActivity label",
  ]
    .filter(Boolean)
    .join(" + ");
  if (CHECK) {
    failures.push(`AndroidManifest.xml：需要${detail}`);
    console.log(`  [待补] AndroidManifest.xml（${detail}）`);
    return;
  }
  write(file, xml);
  changes.push("AndroidManifest.xml");
  console.log(`  [已补] AndroidManifest.xml（${detail}）`);
}

/* ─────────────── ③ file_paths.xml ─────────────── */

function patchFilePaths() {
  const file = path.join(GEN, FILE_PATHS);
  const src = read(file);
  if (src === null) {
    failures.push(`缺少 ${FILE_PATHS}（更新包暂存目录将无法被 FileProvider 共享）`);
    return;
  }
  // 只要求「有任意一条 cache-path 根」，path 值不锁死 —— 上游换了名字也不算错。
  if (/<cache-path\b[^>]*\/>/.test(src)) {
    console.log("  [已一致] file_paths.xml（cache-path 已声明）");
    return;
  }
  if (CHECK) {
    failures.push("file_paths.xml：缺 <cache-path />，更新包无法通过 FileProvider 交给安装器");
    console.log("  [待补] file_paths.xml（缺 cache-path）");
    return;
  }
  const out = src.replace(/(<paths\b[^>]*>)/, `$1\n  <cache-path name="my_cache_images" path="." />`);
  if (out === src) {
    failures.push("file_paths.xml：找不到 <paths> 根标签，无法补 cache-path");
    return;
  }
  write(file, out);
  changes.push("file_paths.xml");
  console.log("  [已补] file_paths.xml（cache-path）");
}

/* ─────────────── ④ 事实源在 src-tauri 下的自有产物（assets 配置 + 启动器图标） ─────────────── */

/**
 * 这两样由 `tauri android init` 从 src-tauri 拷进 gen/android，**之后 CLI 再也不刷新**：
 *
 *   ① `tauri.conf.json` → `app/src/main/assets/tauri.conf.json`
 *      Android 侧是真读它的：`app.tauri.plugin.PluginManager.loadConfig()` 的实现就是
 *      `FsUtils.readAsset(context.assets, "tauri.conf.json")`，官方插件的 Kotlin 端靠它取
 *      自己在 `plugins.<id>` 下的配置。init 时的快照落后，端上取到的就是旧配置。
 *   ② `icons/android/` → `app/src/main/res/mipmap-*`（含 `mipmap-anydpi-v26/ic_launcher.xml`
 *      与 `values/ic_launcher_background.xml`）
 *      启动器图标，由 `tauri icon` 生成到 src-tauri/icons/android/。
 *
 * 实测踩坑：品牌从「潮衡 / TideBalance」改名时重新生成了 `icons/android/`，但没人重跑 init，
 * 于是 APK 里一直装着改名前的旧图标（像素比对差异 52%），`assets/tauri.conf.json` 更是停在
 * v0.11.2 —— 这就是「apk 跟不上更新」的形态。按「我们拥有的文件」处理：事实源整份覆盖，
 * 二进制用 Buffer 比对（图标是 PNG，不能用 utf8 读）。
 */
const CONF_SOURCE = path.join(APP, "src-tauri", "tauri.conf.json");
const CONF_TARGET = path.join(GEN, "app/src/main/assets/tauri.conf.json");
const CONF_TARGET_REL = "app/src/main/assets/tauri.conf.json";
const ICON_SOURCE = path.join(APP, "src-tauri", "icons", "android");
const ICON_TARGET_REL = "app/src/main/res";

/** 递归列出目录下所有文件，返回相对给定根的 posix 风格路径。 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/**
 * 单文件整份同步（二进制安全）。
 * 返回 "same"（已一致）/ "synced"（本次已写入）/ false（失败）。
 */
function syncFile(fromAbs, toAbs, label, why) {
  if (!fs.existsSync(fromAbs)) {
    failures.push(`事实源缺失：${label}（${why}）`);
    return false;
  }
  const from = fs.readFileSync(fromAbs);
  const to = fs.existsSync(toAbs) ? fs.readFileSync(toAbs) : null;
  if (to !== null && to.equals(from)) return "same";
  if (CHECK) {
    failures.push(`${label}：与事实源不一致（${why}）`);
    console.log(`  [不一致] ${label}`);
    return false;
  }
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.writeFileSync(toAbs, from);
  changes.push(label);
  console.log(`  [已同步] ${label}`);
  return "synced";
}

function syncTauriOwned() {
  // ① assets/tauri.conf.json —— 必须与 src-tauri 下的唯一事实源逐字节一致
  const conf = syncFile(
    CONF_SOURCE,
    CONF_TARGET,
    CONF_TARGET_REL,
    "Android 运行时读它取窗口与 plugins 配置",
  );
  if (conf === "same") console.log(`  [已一致] ${CONF_TARGET_REL}`);

  // ② 启动器图标 —— 5 个密度 × 3 张 PNG + adaptive icon 定义 + 背景色，共 17 个文件
  if (!fs.existsSync(ICON_SOURCE)) {
    failures.push("事实源缺失：src-tauri/icons/android/（跑 `npx tauri icon <源图>` 生成）");
    return;
  }
  const icons = listFiles(ICON_SOURCE);
  let same = 0;
  for (const rel of icons) {
    const result = syncFile(
      path.join(ICON_SOURCE, rel),
      path.join(GEN, ICON_TARGET_REL, rel),
      `${ICON_TARGET_REL}/${rel}`,
      "启动器图标落后于 src-tauri/icons/android",
    );
    if (result === "same") same++;
  }
  if (same === icons.length) {
    console.log(`  [已一致] 启动器图标（${icons.length} 个文件：5 个密度 + adaptive icon + 背景色）`);
  }
}

/* ─────────────── 主流程 ─────────────── */

console.log(`── Android 原生代码${CAPTURE ? "采纳" : CHECK ? "校验" : "同步"}（gen/android）──`);
if (CAPTURE) {
  captureKotlin();
  process.exit(0);
}

syncOwned();
patchManifest();
patchFilePaths();
syncTauriOwned();

if (failures.length) {
  console.error(CHECK ? "\nAndroid 原生一致性检查失败：" : "\nAndroid 原生同步出现问题：");
  failures.forEach((x) => console.error("- " + x));
  if (CHECK) {
    console.error("（Kotlin 差异用 `node tools/sync-android-native.js` 同步；补丁类差异运行同一命令即可）");
  }
  process.exit(1);
}
console.log(
  CHECK
    ? "✓ Android 原生代码与版本化镜像一致（Kotlin 与自有资源 / 清单权限与教务窗口与提醒接收器 / FileProvider 路径 / assets 配置与启动器图标）"
    : changes.length
      ? `✓ 已同步 Android 原生代码：${changes.join("、")}`
      : "✓ Android 原生代码已是最新，无需改动",
);
