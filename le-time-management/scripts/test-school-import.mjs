import { readProductSource } from "./lib/read-product-source.mjs";
import fs from 'node:fs';
import assert from 'node:assert/strict';

/*
 * 教务导入窗口的退出通道。
 *
 * 背景（用户反馈）：手机端导入课表后无法返回，点「关闭」只显示「正在关闭…」。
 * 根因（v0.37.12 查实）：tauri 的 window.close() 在 Android 只是丢弃 Rust 侧引用
 * （tao 的 Android Window 没有 Drop/finish 逻辑，runtime 也收不到 Destroyed 事件），
 * 承载教务页面的 Activity 永远留在返回栈上。桌面端有窗口关闭按钮所以一直没暴露。
 *
 * 这里守：
 * ① 工具栏有真正的关闭通道（带随机 query 重试，防 Android「同 URL 不再回调」）；
 * ② Rust 侧 close 走「JNI finish Activity + destroy」；
 * ③ 导入完成后自动关窗（notifyTaskCompletion）；
 * ④ Android 专用 SchoolImportActivity 存在、注册、并被 school_import_open 指定；
 * ⑤ label 递增（Android manager 条目关不掉，同 label 二次 build 会报 already exists）。
 */

const read = (rel) => readProductSource(new URL(rel, import.meta.url), 'utf8');
const rust = read('../src-tauri/src/lib.rs');

/* ① 注入脚本：能提取 + 语法有效 */
const bootstrap = (rust.match(/const SCHOOL_IMPORT_BOOTSTRAP: &str = r#"\n([\s\S]*?)\n"#;/) || [])[1];
assert.ok(bootstrap, 'SCHOOL_IMPORT_BOOTSTRAP 原始字符串必须能被提取');
// 注入脚本写在 Rust 原始字符串里，语法错了编译器不会报错，只会在手机上静默失效 —— 必须自检。
assert.doesNotThrow(() => new Function(bootstrap), '教务窗口的注入脚本必须语法有效');

/* ② 工具栏必须有真正的关闭通道，且「后退」不能是死按钮 */
assert.ok(bootstrap.includes('data-close'), '教务窗口工具栏必须有「关闭」按钮');
assert.ok(bootstrap.includes('letime-import://close'), '「关闭」按钮必须走 letime-import://close');
assert.match(
  bootstrap,
  /\[data-back\]'\)\.onclick[\s\S]{0,160}?close\(\)/,
  '「后退」在教务站首屏（无站内历史）时必须回退到关闭，否则又是个点不动的死按钮',
);
// Android WebView 对「同一 URL 的重复导航」不再触发 shouldOverrideUrlLoading ——
// 关闭必须带随机 query 并重试，否则状态停在「正在关闭…」。
assert.match(
  bootstrap,
  /letime-import:\/\/close\?r=' \+ \(\+\+\w+\) \+ '-' \+ Date\.now\(\)/,
  'close 导航必须带随机 query（同 URL 重试在 Android 上不会触发 on_navigation）',
);
assert.match(
  bootstrap,
  /setTimeout\(go, \d+\)[\s\S]{0,40}?setTimeout\(go, \d+\)/,
  'close 必须定时重试至少两次，防单次导航被吞',
);

/* ③ Rust 侧：close 分支必须走统一的关闭函数 */
assert.match(rust, /"close"\s*=>/, 'on_navigation 必须处理 letime-import://close');
assert.match(
  rust,
  /"close"\s*=>[\s\S]{0,200}?school_import_close\(&app_for_navigation, &label\)/,
  'letime-import://close 必须调 school_import_close 真正关闭窗口',
);

/* ④ 关闭实现：Android 上必须 JNI finish Activity + destroy，不能只 window.close() */
const closeFn = (rust.match(/fn school_import_close\([\s\S]*?\n\}/) || [])[0];
assert.ok(closeFn, '必须有 school_import_close 函数');
assert.match(closeFn, /with_webview/, 'Android 关窗必须经 with_webview 拿平台句柄');
assert.match(closeFn, /jni_handle\(\)\.exec/, 'Android 关窗必须用 JniHandle::exec');
assert.match(closeFn, /"finish", "\(\)V"/, '必须在承载 Activity 上调 finish()');
assert.match(closeFn, /window\.destroy\(\)/, '关闭时必须 destroy() 清 tauri/runtime 引用');
assert.doesNotMatch(closeFn, /window\.close\(\)/, 'close() 在 Android 是空操作，禁止出现');

/* ⑤ 导入流程走完要自动关窗，用户不必自己找按钮 */
assert.match(
  rust,
  /action == "notifyTaskCompletion"[\s\S]{0,120}?school_import_close\(app, label\)/,
  '导入完成（notifyTaskCompletion）后必须自动关闭教务窗口',
);

/* ⑥ 自动关窗依赖适配器发完成信号 —— 没发就永远不会触发 */
const adapter = read('../public/plugins/shiguang-schedule/adapters/cppu.js');
assert.match(adapter, /notifyTaskCompletion/, '适配器必须在导入结束时发 notifyTaskCompletion，否则自动关窗不会触发');

/* ⑦ Android 专用 Activity：存在、注册、并被 open 指定。
   注意读**版本化镜像**（android/gradle/）而不是 src-tauri/gen/android ——
   后者被 .gitignore 忽略，全新 clone 上这里会直接 ENOENT 让整个测试挂掉。
   镜像由 tools/sync-android-native.js 同步进 gen，构建脚本每次打包前都会跑一次。 */
const activityKt = read('../android/gradle/app/src/main/java/com/yile/letime/SchoolImportActivity.kt');
assert.match(activityKt, /class SchoolImportActivity : TauriActivity\(\)/, 'SchoolImportActivity 必须是 TauriActivity 的具体子类（abstract 不能 startActivity）');
const manifest = read('../android/gradle/app/src/main/AndroidManifest.xml');
assert.match(manifest, /android:name="\.SchoolImportActivity"/, 'AndroidManifest 必须注册 SchoolImportActivity，否则 startActivity 直接崩');
assert.doesNotMatch(manifest, /android:name="\.SchoolImportActivity"[^>]*android:exported="true"/, 'SchoolImportActivity 仅应用内启动，不能 exported');
// 注册本身必须由 tools/sync-android-native.js 幂等补回 —— gen/ 是 gitignored，
// `tauri android init` 会连这条注册一起抹掉（本仓库实测：镜像清单里就漏过它），
// 而崩点是「点导入才崩」，没人会在 init 之后主动去比对。
const androidSyncTool = read('../../tools/sync-android-native.js');
assert.match(androidSyncTool, /ensureSchoolImportActivity/,
  'Android 同步工具必须能补回教务窗口注册，否则 tauri android init 之后教务导入直接崩');
assert.match(androidSyncTool, /android:name="\.SchoolImportActivity"/,
  '同步工具补的活动名必须是 .SchoolImportActivity');
assert.match(
  rust,
  /#\[cfg\(target_os = "android"\)\]\s*\n\s*let builder = builder\.activity_name\("SchoolImportActivity"\);/,
  'school_import_open 必须在 Android 上指定 SchoolImportActivity',
);

/* ⑧ label 必须递增：Android manager 条目关不掉，同 label 二次 build 会报 already exists */
assert.match(rust, /IMPORT_WINDOW_SEQ: AtomicU64/, '必须有递增的窗口序号');
assert.match(rust, /let label = format!\("school-import-\{seq\}"\)/, '教务窗口 label 必须带序号');
assert.doesNotMatch(rust, /WebviewWindowBuilder::new\(&app, "school-import"/, '禁止回到固定 label（二次打不开）');

/* ⑨ 别退回「只有 history.back()」的老写法 */
assert.doesNotMatch(
  bootstrap,
  /\[data-back\]'\)\.onclick\s*=\s*\(\)\s*=>\s*history\.back\(\);/,
  '工具栏不能只剩 history.back()：手机端停在首屏时用户会被卡住',
);

console.log('PASS: school import window has a working exit path (toolbar close / back fallback / auto-close on completion)');
