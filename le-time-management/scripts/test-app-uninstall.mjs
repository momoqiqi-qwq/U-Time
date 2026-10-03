import { readProductSource } from "./lib/read-product-source.mjs";
/* 应用内「卸载 U-Time」的五层接线守卫（Android）。
 *
 * 需求来源：卸载这一步原本只能在系统桌面 / 设置里做，应用内没有任何入口；
 * 而且「卸载会把本机数据一起带走」这件事没人提前说，用户是事后才知道的。
 * 做成与「软件更新」对称的一块：先给备份退路，再用应用内确认框（不用系统灰框）
 * 交代清楚会丢什么，最后才把卸载交给系统的卸载程序。
 *
 * 五层里任何一环断开，症状都不一样，但**都不报错**：
 *   ① Kotlin 漏 ACTION_DELETE → 点了没反应；
 *   ② 清单漏 REQUEST_DELETE_PACKAGES → startActivity 抛 SecurityException（系统卸载
 *      Activity 受这条权限保护），症状同样是「点了没反应」；
 *   ③ 同步工具 SOURCES 漏登记 → `tauri android init` 重建 gen/android 后整个功能静默消失；
 *   ④ Rust 漏注册插件 / 漏加进 generate_handler → 命令调不到（Android 分支还会编译断）；
 *   ⑤ 前端漏挂载 → 界面上根本没有这个按钮。
 * 所以这一份测试逐层钉死，改任何一环都会红在这里，而不是等到手机上才发现。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");

const pluginKt = read("../android/gradle/app/src/main/java/com/yile/letime/AppUninstallerPlugin.kt");
const mirrorManifest = read("../android/gradle/app/src/main/AndroidManifest.xml");
const syncTool = read("../../tools/sync-android-native.js");
const libRs = read("../src-tauri/src/lib.rs");
const rs = read("../src-tauri/src/uninstaller.rs");
const api = read("../src/api.js");
const panel = read("../src/views/settings/uninstall.js");
const aboutCard = read("../src/views/aboutCard.js");
const settings = read("../src/views/settings.js");
const notify = read("../src/androidNotify.js");

/* ① Kotlin：真的把 ACTION_DELETE + 裸包名发出去，且异常都翻成人话。 */
assert.match(pluginKt, /@TauriPlugin\s+class AppUninstallerPlugin\(private val host: Activity\) : Plugin\(host\)/,
  "必须是注册进 Tauri 的 Android 插件，构造签名与其它原生插件一致");
assert.match(pluginKt, /@Command\s+fun uninstall\(/, "必须暴露 uninstall 命令给 Rust 侧调用");
assert.match(pluginKt, /Intent\.ACTION_DELETE/, "卸载只能走 ACTION_DELETE 交系统卸载程序（deletePackage 在 Android 12+ 对普通应用不可靠）");
assert.match(pluginKt, /Uri\.parse\("package:\$\{host\.packageName\}"\)/,
  "data 必须是 package: + 裸包名，带别的段系统不认");
assert.match(pluginKt, /FLAG_ACTIVITY_NEW_TASK/, "从非 UI 上下文起 Activity 必须带 NEW_TASK");
assert.match(pluginKt, /runOnUiThread/, "startActivity 必须在主线程");
assert.match(pluginKt, /catch \(error: ActivityNotFoundException\)/,
  "极简 ROM 没有卸载组件时要给出手动卸载的指引，而不是抛出去");
assert.match(pluginKt, /put\("launched", true\)/, "返回 launched，前端据此决定文案是「已交给系统」而不是「已卸载」");

/* ②③ 清单与同步工具：权限必须既在参考副本里、也在补丁里。
      补丁才是真正生效的那份（gen/android 的清单是 init 生成的），
      只改参考副本等于下次 init 就丢。 */
assert.match(mirrorManifest, /android\.permission\.REQUEST_DELETE_PACKAGES/,
  "参考副本必须声明卸载权限（init 之后人工比对的基准）");
assert.match(syncTool, /"AppUninstallerPlugin\.kt",/,
  "sync-android-native.js 的 SOURCES 必须收录 AppUninstallerPlugin.kt，否则重新 init 后静默丢失");
assert.match(syncTool, /const UNINSTALL_PERMISSION = "android\.permission\.REQUEST_DELETE_PACKAGES"/,
  "补丁脚本里必须有卸载权限常量");
assert.match(syncTool, /ensurePermission\(xml, UNINSTALL_PERMISSION\)/,
  "patchManifest 必须真的把卸载权限补进 gen 的清单（只加不删）");

/* ④ Rust：插件注册 + 命令全平台存在（generate_handler 没有平台门控）。 */
assert.match(rs, /register_android_plugin\("com\.yile\.letime", "AppUninstallerPlugin"\)/,
  "必须绑定到刚写的 Kotlin 插件类名");
assert.match(rs, /run_mobile_plugin_async\("uninstall"/, "命令名要与 Kotlin 的 @Command 同名");
assert.match(rs, /pub async fn app_uninstall<R: Runtime>/, "Tauri 命令必须存在");
assert.match(rs, /"launched": false/, "非 Android 分支返回 launched:false，而不是报错（前端可无脑调用）");
assert.match(libRs, /^mod uninstaller;$/m, "lib.rs 必须声明模块");
assert.match(libRs, /builder = builder\.plugin\(uninstaller::init\(\)\)/,
  "Android 分支必须注册插件，否则 try_state 拿不到句柄，命令只会报「卸载桥未初始化」");
assert.match(libRs, /uninstaller::app_uninstall/, "必须挂进 generate_handler");

/* ⑤ 前端：命令包装 + 挂载 + 只用应用内确认框。 */
assert.match(api, /invoke\("app_uninstall"\)/, "api.js 必须有 appUninstall 包装");
assert.match(panel, /import \{ el, toast, appConfirm \} from "\.\.\/\.\.\/ui\.js"/,
  "确认必须走应用内 appConfirm：window.confirm 在 Android WebView 里是系统灰框，与全应用样式不一致");
assert.doesNotMatch(panel, /window\.confirm|[^.]\bconfirm\(/, "卸载这种破坏性操作不许用原生 confirm");
assert.match(panel, /isAndroidRuntime/, "平台门禁：只有 Android 有这个能力");
assert.match(panel, /timeoutMs: \d+/, "确认框必须超时自动取消：没人点头就等于没人点头");
assert.match(panel, /danger: true/, "确认按钮必须是危险色");
assert.match(panel, /api\.saveDownload/, "备份必须走 save_download：blob 下载在 WebView 里不可靠");
assert.match(panel, /exportBtn/, "必须给「先导出完整备份」的退路，不能只给一个自毁按钮");
assert.match(aboutCard, /createUninstallPanel\(\{ version: currentVersion \}\)/, "关于卡片必须挂载卸载面板");
assert.match(aboutCard, /if \(uninstallPanel\) card\.append\(sectionTitle\("卸载应用"\)/,
  "桌面端返回 null 时连分区标题一起跳过，不能留一个空标题");
assert.match(settings, /卸载 卸载应用/, "全局搜索要能搜到「卸载」，否则用户找不到这个入口");
assert.match(notify, /export function isAndroidRuntime/, "平台判断仍复用同一处（卸载面板 import 它）");

/* ───────── 行为断言：桌面真的不出现、浏览器调试真的出现 ───────── */

globalThis.window = {};
globalThis.document = {
  createElement: () => {
    const node = {
      nodeType: 1, children: [], style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, addEventListener() {}, querySelector: () => null,
      append: (...c) => node.children.push(...c),
    };
    return node;
  },
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const S = await import("../src/store.js");
await S.initStore({
  tasks: [{ id: "t_1", title: "交报告" }, { id: "t_2", title: "取快递" }],
  blocks: [],
  settings: {},
  plugins: {},
});
const U = await import("../src/views/settings/uninstall.js");
const apiMod = await import("../src/api.js");

const walk = (node, out = []) => {
  for (const c of node.children || []) {
    if (c.className) out.push(c);
    walk(c, out);
  }
  return out;
};

// 桌面（Tauri 且非 Android）：整块不出现
apiMod.api.isTauri = true;
assert.equal(U.createUninstallPanel({ version: "0.1.0" }), null,
  "桌面端不能出现卸载入口（Windows 走系统「应用与功能」）");

// 浏览器调试模式：必须照画，否则手机端这块界面永远没法预览 / 截图
apiMod.api.isTauri = false;
const rendered = U.createUninstallPanel({ version: "0.1.0" });
assert.ok(rendered, "浏览器调试模式必须渲染面板");
const buttons = walk(rendered).filter((n) => /\bbtn\b/.test(n.className));
assert.deepEqual(buttons.map((b) => b.className).sort(), ["btn danger", "btn ghost sm"],
  "必须正好是「导出完整备份」+ 危险色的「卸载 U-Time」两个按钮");

// 确认文案必须把「本机数据条数」说出来 —— 这是用户按下按钮前唯一能看到的代价
apiMod.api.isTauri = true;
const msg = U.uninstallConfirmMessage("0.1.0");
assert.match(msg, /2 个任务、0 个时间块/, "确认文案要报出当前任务与时间块条数");
assert.match(msg, /无法找回/, "必须明说数据不可恢复");
assert.match(msg, /系统的卸载程序/, "必须交代最终确认在系统界面，不是点一下就没了");

console.log("PASS: 应用内卸载（Kotlin / 清单补丁 / 同步工具 / Rust / api / 关于卡片 / 平台门禁）五层接线完整");
