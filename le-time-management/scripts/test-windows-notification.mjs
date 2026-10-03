import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");
const cargo = read("../src-tauri/Cargo.toml");
const lib = read("../src-tauri/src/lib.rs");
const rust = read("../src-tauri/src/notification.rs");
const bridge = read("../src/androidNotify.js");
const reminder = read("../src/taskReminder.js");
const settings = read("../src/views/settings.js");

assert.match(cargo, /tauri-plugin-notification\s*=\s*"2"/, "桌面端必须引入 Tauri 系统通知插件");
assert.match(lib, /builder\s*=\s*builder\.plugin\(tauri_plugin_notification::init\(\)\)/,
  "桌面构建必须初始化系统通知插件");
assert.match(rust, /if action == "post"[\s\S]*app\.notification\(\)[\s\S]*\.show\(\)/,
  "notification(post) 必须真正调用桌面系统通知 show()，不能只返回成功");
assert.match(rust, /U-Time ·/, "Windows 通知标题必须带应用名，通知中心里才能辨认来源");
assert.match(bridge, /export async function postDesktopReminder/,
  "前端必须有桌面通知桥，不能再依赖 WebView2 不支持的 Notification API");
assert.match(reminder, /else if \(isDesktopRuntime\(\)\) postDesktopReminder\(reminderRecord\(ev\)\)/,
  "普通任务预警必须进入 Windows 系统通知");
assert.match(reminder, /function startRing[\s\S]*isDesktopRuntime\(\)[\s\S]*postDesktopReminder/,
  "到点长鸣也必须进入 Windows 系统通知");
assert.match(settings, /"测试提醒"/, "任务提醒设置中必须保留真实系统弹窗测试入口");

console.log("PASS: Windows 任务提醒已接入 Tauri 系统通知，普通预警/到点长鸣/手动测试三条路径均已接线");
