// 界面演示图（src/uiShot.js）：把「此刻这一屏」截成 PNG 落进下载目录。
//
// 两条线都测：
//   1) 真跑一遍 uiShot.js —— 用 vm 把两个 import 换成注入桩，验桌面/手机分支、重入闸门、
//      文件名形态、toast 里的「打开文件夹」动作、快捷键事件入口；
//   2) 静态接线断言 —— 命令面板入口、全局快捷键键位与分发、设置页输入框与搜索词、
//      Rust 侧命令与 CapturePreview 是否真的接上（这些跨文件契约最容易「改一半」）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- 1. 真跑 uiShot.js ---------- */

const UI_SHOT = src("../src/uiShot.js");

// 桌面 UA / 手机 UA 两套沙箱：uiShot.js 的分支只看 api.isTauri 与 navigator.userAgent。
function makeSandbox({ ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", isTauri = true, capture } = {}) {
  const state = { captured: [], revealed: [], toasts: [], listeners: [], aborted: 0 };
  const api = {
    isTauri,
    async captureUiShot(name) {
      state.captured.push(name);
      if (capture) return capture(name, state);
      return `C:\\Users\\me\\Downloads\\${name}`;
    },
    async revealSavedFile(path) { state.revealed.push(path); },
  };
  const toast = (msg, opts) => state.toasts.push({ msg, opts });
  const sandbox = {
    api, toast, state,
    window: { addEventListener: (type, fn) => state.listeners.push({ type, fn }) },
    navigator: { userAgent: ua },
    // currentViewLabel() 只做「取当前视图名」的尽力而为，取不到就退回「界面」。
    document: { querySelector: () => null },
    console,
    setTimeout, clearTimeout,
  };
  const code = UI_SHOT
    .replace(/^import .*$/gm, "")                          // 两个 import 换成沙箱里的同名桩
    .replace(/\bexport (async function|function|const|let|var|class) /g, "$1 ") // Script 里不能出现 export
    + "\nglobalThis.__mod = { uiShotSupported, captureUiShot, initUiShot };";
  vm.runInNewContext(code, sandbox, { filename: "uiShot.js" });
  return { ...sandbox, mod: sandbox.__mod };
}

// ① 桌面端：文件名带视图名与时间戳，落盘后 toast 里能一键打开文件夹。
{
  const box = makeSandbox();
  assert.equal(box.mod.uiShotSupported(), true, "桌面 Tauri 应支持界面演示图");
  const path = await box.mod.captureUiShot({ label: "获奖名单" });
  assert.equal(box.state.captured.length, 1);
  assert.match(box.state.captured[0], /^界面演示图-获奖名单-\d{4}-\d{2}-\d{2}_\d{6}\.png$/,
    "文件名应为「界面演示图-<视图>-<本地时间戳>.png」");
  assert.equal(path, `C:\\Users\\me\\Downloads\\${box.state.captured[0]}`, "应返回落盘绝对路径");
  assert.match(box.state.toasts[0].msg, /界面演示图已保存：界面演示图-获奖名单-/);
  assert.equal(box.state.toasts[0].opts.actionLabel, "打开文件夹");
  box.state.toasts[0].opts.action();
  assert.deepEqual(box.state.revealed, [path], "toast 的「打开文件夹」应把落盘路径交给 revealSavedFile");
}

// ② 取不到视图名时退回「界面」，不出现空 label 的文件名。
{
  const box = makeSandbox();
  await box.mod.captureUiShot();
  assert.match(box.state.captured[0], /^界面演示图-界面-/, "取不到视图名时退回「界面」");
}

// ③ 手机端（Android UA）：入口应被藏起来，真调用也只给一句提示，不打到 Rust。
{
  const box = makeSandbox({ ua: "Mozilla/5.0 (Linux; Android 14; PJD110) AppleWebKit/537.36" });
  assert.equal(box.mod.uiShotSupported(), false, "Android 的 WebView 没有 CapturePreview，入口必须收起");
  assert.equal(await box.mod.captureUiShot(), null);
  assert.deepEqual(box.state.captured, [], "手机端不该调 capture_ui_shot");
  assert.match(box.state.toasts[0].msg, /只在桌面端可用/);
}

// ④ 浏览器预览（非 Tauri）：同上，入口收起。
{
  const box = makeSandbox({ isTauri: false });
  assert.equal(box.mod.uiShotSupported(), false);
  assert.equal(await box.mod.captureUiShot(), null);
  assert.deepEqual(box.state.captured, []);
}

// ⑤ 重入闸门：连按只截一张（两帧几乎相同的图没有意义，还会并发落盘撞文件名）。
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const box = makeSandbox({ capture: async (name) => { await gate; return name; } });
  const first = box.mod.captureUiShot();
  const second = await box.mod.captureUiShot(); // 第一次还挂着 → 第二次直接返回 null
  assert.equal(second, null, "重入应直接返回 null");
  assert.equal(box.state.captured.length, 1, "重入不得发起第二次截图");
  release();
  await first;
  await box.mod.captureUiShot();
  assert.equal(box.state.captured.length, 2, "上一张落盘后应恢复可用");
}

// ⑥ 失败路径：Rust 报错时给可读提示，不把异常抛给调用方。
{
  const box = makeSandbox({ capture: async () => { throw new Error("当前平台不支持界面演示图"); } });
  assert.equal(await box.mod.captureUiShot(), null);
  assert.match(box.state.toasts[0].msg, /截图失败：当前平台不支持界面演示图/);
}

// ⑦ 快捷键入口：initUiShot 监听 tide:ui-shot，收到事件就走截图（与 globalShortcuts 的 dispatch 对齐）。
{
  const box = makeSandbox();
  box.mod.initUiShot();
  const hit = box.state.listeners.filter((l) => l.type === "tide:ui-shot");
  assert.equal(hit.length, 1, "应注册一个 tide:ui-shot 监听");
  hit[0].fn();
  await new Promise((r) => setTimeout(r, 200)); // 事件里留了 120ms 等输入法候选/下拉收完
  assert.equal(box.state.captured.length, 1, "tide:ui-shot 应触发一次截图");
}

/* ---------- 2. 跨文件接线 ---------- */

const api = src("../src/api.js");
assert.match(api, /async captureUiShot\(name\)[\s\S]{0,200}invoke\("capture_ui_shot", \{ name: String\(name \|\| ""\) \}\)/,
  "api.js 应把 captureUiShot 转成 capture_ui_shot 命令");
assert.match(api, /界面演示图仅在桌面端可用/, "非 Tauri 环境应给出明确拒绝原因");

const shortcuts = src("../src/globalShortcuts.js");
assert.match(shortcuts, /uiShot: "CommandOrControl\+Alt\+S"/, "默认键位应为 CommandOrControl+Alt+S");
assert.match(shortcuts, /\{ key: "界面演示图", shortcut: String\(cfg\.uiShot \|\| ""\)\.trim\(\), event: "tide:ui-shot" \}/,
  "快捷键分发应把界面演示图指向 tide:ui-shot");
assert.match(shortcuts, /window\.dispatchEvent\(new CustomEvent\(name\)\)/, "分发事件名必须与 uiShot.js 监听的一致");
// 刻意避开 Ctrl+Shift+S（WebView 的「另存为」）：默认值里不许出现 Shift+S。
assert.doesNotMatch(shortcuts, /uiShot: "[^"]*Shift\+S"/, "不要占用 Ctrl+Shift+S");

const palette = src("../src/commandPalette.js");
assert.match(palette, /import \{ captureUiShot, uiShotSupported \} from "\.\/uiShot\.js";/, "命令面板应引 uiShot 的入口");
assert.match(palette, /uiShotSupported\(\) \? \[\{[\s\S]{0,260}run: \(\) => captureUiShot\(\{ delay: 320 \}\)/,
  "桌面端才出现「生成界面演示图」，并留延时等面板关闭");
assert.match(palette, /keywords: "screenshot shot 截图 界面图片 演示图 配图 出图 capture"/, "命令要能被「截图 / 出图 / screenshot」搜到");

const settings = src("../src/views/settings/shortcuts.js");
assert.match(settings, /const shotShortcut = el\("input", \{[^}]*value: shortcutCfg\.uiShot \|\| DEFAULT_GLOBAL_SHORTCUTS\.uiShot/,
  "设置页应给界面演示图一个可编辑键位输入框");
assert.match(settings, /\.\.\.\(shotSupported \? \[el\("span", \{\}, "界面演示图"\), shotShortcut\] : \[\]\)/,
  "输入框要进快捷键网格，且只在桌面端显示（手机端整行不出现）");
assert.match(settings, /const shotSupported = uiShotSupported\(\);/, "是否显示这一行按 uiShotSupported() 判定");
assert.match(settings, /if \(shotSupported\) shortcutCfg\.uiShot = shotShortcut\.value\.trim\(\) \|\| DEFAULT_GLOBAL_SHORTCUTS\.uiShot;/,
  "应用按钮要保存新键位（隐藏时不覆盖已存值）");
assert.match(settings, /shotShortcut\.value = DEFAULT_GLOBAL_SHORTCUTS\.uiShot;/, "恢复默认要一起还原");
assert.match(settings, /\.\.\.\(shotSupported \? \[el\("p", \{ class: "shortcut-hint" \}, "「界面演示图」/, "设置页要说明它干什么、存到哪（手机端不显示）");

const searchIndex = src("../src/settingsSearchIndex.js");
assert.match(searchIndex, /\["界面演示图", "截图 演示图 出图 配图 screenshot 下载目录"\]/, "设置搜索应能搜到它");

const main = src("../src/main.js");
assert.match(main, /import \{ initUiShot \} from "\.\/uiShot\.js";/, "main.js 应引入 initUiShot");
assert.match(main, /^\s*initUiShot\(\);$/m, "启动流程应注册快捷键事件监听");

const lib = src("../src-tauri/src/lib.rs");
assert.match(lib, /async fn capture_ui_shot\(app: AppHandle, name: Option<String>\) -> Result<String, String> \{/,
  "Rust 侧应有 capture_ui_shot 命令");
assert.match(lib, /fn shot_file_name\(raw: Option<&str>\) -> String \{/, "文件名要过一层白名单清洗");
assert.match(lib, /core\.CapturePreview\(/, "桌面实现应走 WebView2 的 CapturePreview");
assert.match(lib, /fn capture_webview_png\(_app: &AppHandle\) -> Result<Vec<u8>, String> \{/,
  "非 Windows 应有失败桩，避免命令只在桌面存在");
assert.match(lib, /save_to_download_dir\(&app, &shot_file_name\(name\.as_deref\(\)\), &bytes\)/,
  "截图应落进系统下载目录（与附件同一套落盘逻辑）");
assert.match(lib, /\r?\n\s*capture_ui_shot,\r?\n/, "命令要注册进 invoke_handler");

console.log("PASS: 界面演示图（桌面/手机分支 · 重入闸门 · 文件名与时间戳 · toast 打开文件夹 · tide:ui-shot 事件 · 命令面板与设置页与 Rust 命令接线）");
