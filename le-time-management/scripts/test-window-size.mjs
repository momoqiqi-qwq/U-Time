import { readProductSource } from "./lib/read-product-source.mjs";
// 启动窗口大小：默认中等窗口 + 可在「总设置 → 界面与交互」里选。
// 外加左下角「缩放视图」按钮（一键收成固定尺寸并居中 / 再按还原）。
//
// 这里只测纯逻辑（resolveWindowSize / focusWindowSize / 夹取 / 偏好归一），Tauri 的 setSize 调用靠
// 「非桌面环境直接返回 applied:false 且不抛异常」来守住 —— 真正的窗口行为只能在装好的桌面版里看。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WINDOW_SIZE_PRESETS,
  CUSTOM_SIZE_LIMITS,
  FOCUS_WINDOW_SIZE,
  clampWindowSize,
  resolveWindowSize,
  isDesktopRuntime,
  applyWindowSize,
  windowSizeHint,
  focusWindowSize,
  isFocusWindowActive,
  toggleFocusWindow,
} from "../src/windowSize.js";
import {
  DEFAULT_UI_PREFERENCES,
  WINDOW_SIZE_MODES,
  WINDOW_SIZE_OPTIONS,
  normalizeUiPreferences,
} from "../src/uiPreferences.js";

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");

/* ── 一、默认值：中等窗口，不要在大屏上接近满屏 ── */
assert.equal(DEFAULT_UI_PREFERENCES.startupWindowMode, "standard", "默认必须是标准窗口，避免大屏上启动窗口过大");
assert.deepEqual([DEFAULT_UI_PREFERENCES.startupWindowWidth, DEFAULT_UI_PREFERENCES.startupWindowHeight], [1360, 860]);
assert.equal(resolveWindowSize(DEFAULT_UI_PREFERENCES, null).width, 1360);
assert.equal(resolveWindowSize(DEFAULT_UI_PREFERENCES, null).height, 860);
assert.equal(resolveWindowSize({}, null).width, 1360);
assert.equal(resolveWindowSize({}, null).height, 860);

/* ── 二、模式表 / 选项表 / 预设表必须对齐（三处写 id 最容易漂） ── */
assert.deepEqual(WINDOW_SIZE_OPTIONS.map((x) => x[0]), [...WINDOW_SIZE_MODES], "设置页选项必须与模式表逐项对应");
for (const [id, label] of WINDOW_SIZE_OPTIONS) assert.ok(label && label.length > 1, `模式 ${id} 缺中文说明`);
for (const id of Object.keys(WINDOW_SIZE_PRESETS)) {
  assert.ok(WINDOW_SIZE_MODES.includes(id), `预设 ${id} 不在可选模式里，选了会静默回落`);
}
for (const id of ["auto", "full", "custom"]) {
  assert.equal(WINDOW_SIZE_PRESETS[id], undefined, `${id} 是算出来的，不该出现在预设表里`);
}
for (const preset of Object.values(WINDOW_SIZE_PRESETS)) {
  assert.ok(preset.width >= CUSTOM_SIZE_LIMITS.minWidth && preset.height >= CUSTOM_SIZE_LIMITS.minHeight);
  assert.ok(preset.width <= CUSTOM_SIZE_LIMITS.maxWidth && preset.height <= CUSTOM_SIZE_LIMITS.maxHeight);
}

/* ── 三、auto：按屏幕算，但大屏封顶到中等窗口 ── */
const auto = resolveWindowSize({ startupWindowMode: "auto" }, { width: 1920, height: 1040 });
assert.deepEqual(auto, { mode: "size", width: 1440, height: 894 });
assert.ok(auto.width <= 1440 && auto.height <= 900, `跟随屏幕在大屏上也不能过大，实际 ${auto.width}×${auto.height}`);
const autoHuge = resolveWindowSize({ startupWindowMode: "auto" }, { width: 2560, height: 1440 });
assert.deepEqual(autoHuge, { mode: "size", width: 1440, height: 900 });
const autoSmall = resolveWindowSize({ startupWindowMode: "auto" }, { width: 1366, height: 768 });
assert.ok(autoSmall.width <= 1366 - 24 && autoSmall.height <= 768 - 24, "小屏上必须缩到可用区域内");
assert.equal(autoSmall.mode, "size");

/* ── 四、预设 + 屏幕夹取 ── */
const largeOnSmallScreen = resolveWindowSize({ startupWindowMode: "large" }, { width: 1366, height: 768 });
assert.deepEqual(largeOnSmallScreen, { mode: "size", width: 1342, height: 744 }, "装不下时要退到「可用区域 − 余量」");
const largeOnBigScreen = resolveWindowSize({ startupWindowMode: "large" }, { width: 2560, height: 1440 });
assert.deepEqual(largeOnBigScreen, { mode: "size", ...WINDOW_SIZE_PRESETS.large }, "装得下就用预设值，不要莫名放大");
assert.deepEqual(resolveWindowSize({ startupWindowMode: "compact" }, null), { mode: "size", ...WINDOW_SIZE_PRESETS.compact });

/* ── 五、自定义尺寸要夹在可用范围内 ── */
assert.deepEqual(clampWindowSize(200, 99999), { width: CUSTOM_SIZE_LIMITS.minWidth, height: CUSTOM_SIZE_LIMITS.maxHeight });
assert.deepEqual(clampWindowSize(99999, 100), { width: CUSTOM_SIZE_LIMITS.maxWidth, height: CUSTOM_SIZE_LIMITS.minHeight });
assert.deepEqual(clampWindowSize("1720", "1080"), { width: 1720, height: 1080 }, "表单送来的字符串数值要能用");
assert.deepEqual(resolveWindowSize({ startupWindowMode: "custom", startupWindowWidth: 1720, startupWindowHeight: 1080 }, { width: 2560, height: 1440 }),
  { mode: "size", width: 1720, height: 1080 });

/* ── 六、full / 未知模式 / 脏输入 ── */
assert.deepEqual(resolveWindowSize({ startupWindowMode: "full" }, { width: 1920, height: 1080 }), { mode: "full" });
for (const bad of [undefined, null, "", "huge", 123, {}]) {
  const out = resolveWindowSize({ startupWindowMode: bad }, { width: 1920, height: 1040 });
  assert.deepEqual(out, { mode: "size", width: 1440, height: 894 }, `模式 ${String(bad)} 必须退回「跟随屏幕」而不是开出 0 尺寸窗口`);
}
assert.ok(resolveWindowSize(null, null).width > 0, "整个偏好丢失时也要给出可用尺寸");

/* ── 七、偏好归一化：非法模式与越界尺寸都要被修正 ── */
assert.equal(normalizeUiPreferences({ startupWindowMode: "huge" }).startupWindowMode, "standard");
assert.equal(normalizeUiPreferences({ startupWindowMode: "full" }).startupWindowMode, "full");
assert.equal(normalizeUiPreferences({ startupWindowWidth: 10 }).startupWindowWidth, CUSTOM_SIZE_LIMITS.minWidth);
assert.equal(normalizeUiPreferences({ startupWindowWidth: 99999 }).startupWindowWidth, CUSTOM_SIZE_LIMITS.maxWidth);
assert.equal(normalizeUiPreferences({ startupWindowHeight: 1 }).startupWindowHeight, CUSTOM_SIZE_LIMITS.minHeight);
assert.equal(normalizeUiPreferences({ startupWindowWidth: "1600" }).startupWindowWidth, 1600);
assert.deepEqual(normalizeUiPreferences({}), DEFAULT_UI_PREFERENCES, "空偏好必须等于默认值（老用户升级后走这条）");

/* ── 八、提示文案 ── */
for (const mode of WINDOW_SIZE_MODES) {
  const hint = windowSizeHint(mode, { startupWindowWidth: 1500, startupWindowHeight: 960 });
  assert.ok(typeof hint === "string" && hint.length > 8, `模式 ${mode} 缺少说明文案`);
  if (!["auto", "full"].includes(mode)) assert.match(hint, /\d+ × \d+/, `模式 ${mode} 的说明里应给出具体尺寸`);
}
assert.match(windowSizeHint("full"), /最大化/);
assert.match(windowSizeHint("auto"), /最高 1440 × 900/);

/* ── 九、非桌面环境：不抛异常，如实返回 not-desktop ── */
assert.equal(isDesktopRuntime(), false, "Node 里没有 Tauri，不该被当成桌面端");
const notDesktop = await applyWindowSize(DEFAULT_UI_PREFERENCES);
assert.equal(notDesktop.applied, false);
assert.equal(notDesktop.reason, "not-desktop");

/* ── 十、接线守卫：设置页与启动流程真的用上了 ── */
const mainSrc = read("../src/main.js");
assert.match(mainSrc, /applyWindowSize\(getUiPreferences\(\)\)/, "启动流程必须套用窗口大小设置");
const appearanceSrc = read("../src/views/settings/appearance.js");
for (const marker of ["startupWindowMode", "WINDOW_SIZE_OPTIONS", "立即应用", "windowSizeHint"]) {
  assert.ok(appearanceSrc.includes(marker), `设置页缺少启动窗口大小相关片段：${marker}`);
}
const windowSizeSrc = read("../src/windowSize.js");
assert.ok(!/from\s+"\.\/uiPreferences\.js"/.test(windowSizeSrc), "windowSize 不能反向依赖 uiPreferences，会形成循环导入");

/* ── 十一、窗口初值也一起收成中等尺寸 ── */
const tauri = JSON.parse(read("../src-tauri/tauri.conf.json"));
const win = tauri.app.windows[0];
assert.deepEqual([win.width, win.height], [1360, 860], `tauri.conf.json 默认窗口应为中等尺寸，实际 ${win.width}×${win.height}`);
assert.equal(win.minWidth, 400);
assert.equal(win.minHeight, 560);
assert.ok(win.center === true, "放大后必须居中，否则会溢出屏幕右下");

/* ── 十二、缩放视图（左下角那颗按钮）── */
assert.deepEqual({ ...FOCUS_WINDOW_SIZE }, { width: 1600, height: 1100 }, "目标尺寸是量着需求截图定的，改它要先确认");
assert.ok(FOCUS_WINDOW_SIZE.width >= CUSTOM_SIZE_LIMITS.minWidth && FOCUS_WINDOW_SIZE.width <= CUSTOM_SIZE_LIMITS.maxWidth);
assert.ok(FOCUS_WINDOW_SIZE.height >= CUSTOM_SIZE_LIMITS.minHeight && FOCUS_WINDOW_SIZE.height <= CUSTOM_SIZE_LIMITS.maxHeight,
  "预设尺寸越出自定义范围会被 clampWindowSize 悄悄改掉，按钮上写的数字就成了假的");

// 装得下就用请求值；拿不到显示器信息（area=null）也用请求值，不能退成 86% 的 auto 算法
assert.deepEqual(focusWindowSize(null), { width: 1600, height: 1100 });
assert.deepEqual(focusWindowSize({ width: 2560, height: 1440 }), { width: 1600, height: 1100 });
// 装不下要退到「可用区域 − 余量」，否则窗口右下一角跑到屏幕外
assert.deepEqual(focusWindowSize({ width: 1366, height: 768 }), { width: 1342, height: 744 });
// 小屏下限由 CUSTOM_SIZE_LIMITS 兜住，但绝不能超过可用区域
const tiny = focusWindowSize({ width: 1000, height: 700 });
assert.ok(tiny.width <= 1000 - 24 && tiny.height <= 700 - 24, `小屏上必须收进可用区域内，实际 ${tiny.width}×${tiny.height}`);

assert.equal(isFocusWindowActive(), false, "Node 里没有窗口，不该一上来就是缩放态");
const focusNotDesktop = await toggleFocusWindow();
assert.equal(focusNotDesktop.applied, false);
assert.equal(focusNotDesktop.reason, "not-desktop");
assert.equal(isFocusWindowActive(), false, "非桌面端调用后状态不能翻转，否则按钮会卡在激活态");

// 接线：按钮走注册表、只在桌面端注册、点击真的调 toggleFocusWindow
const shellSrc = read("../src/shell.js");
assert.match(shellSrc, /registerRailAction\(\{\s*\n\s*id: "window-focus"/, "缩放视图必须走 rail 注册表");
assert.match(shellSrc, /if \(desktopWindow\) \{[\s\S]{0,900}id: "window-focus"/, "缩放视图按钮必须只在桌面端注册");
assert.match(shellSrc, /await toggleFocusWindow\(\)/, "按钮点击必须调 toggleFocusWindow，尺寸逻辑只留一处实现");
// 图标名必须在打包内的 sprite 里，否则按钮会渲染成空白
const sprite = read("../public/icons/fontawesome/solid.svg");
for (const name of ["compress", "expand"]) {
  assert.ok(sprite.includes(`id="${name}"`), `solid.svg 缺少图标 ${name}，缩放视图按钮会是空白`);
}
// 激活态样式要压过老 rails 的 `.rail-bottom > button.on .ic`（3 类 1 元素），靠的是带上按钮自己的类
const stylesCss = read("../src/styles.css");
assert.match(stylesCss, /\.rail-dock > \.rail-dock-btn\.window-focus-btn\.on \.ic/, "缩放视图激活态选择器缺了 .window-focus-btn，会被老的太阳黄盖掉");

/* ── Tauri ACL：每个窗口写操作都必须显式授权 ─────────────────────────────────
   v0.74.1 修的 bug：capabilities/default.json 只给了 toggle-maximize，而这里用的是
   maximize / unmaximize / setSize / center / setPosition（toggle 不等于它们），
   运行时就是「Command plugin:window|set_size not allowed by ACL」—— 左下角「缩放视图」
   按下去没反应、设置页「立即应用」报失败、快捷坞「窗口置顶」也一起失效。
   这类缺失编译期不报错，浏览器里更测不出来（非桌面端第一行就 applied:false 早退了），
   所以把「代码里用到的」和「清单里给的」逐条对上，缺哪条就红在哪条。 */
const capDefault = JSON.parse(read("../src-tauri/capabilities/default.json"));
const granted = new Set(capDefault.permissions);
// 会改窗口状态或位置的 API → 需要的 core:window:allow-*
const WRITE_API = {
  setSize: "set-size", setPosition: "set-position", setResizable: "set-resizable",
  setMinSize: "set-min-size", setMaxSize: "set-max-size", setFullscreen: "set-fullscreen",
  setDecorations: "set-decorations", setAlwaysOnTop: "set-always-on-top", setClosable: "set-closable",
  maximize: "maximize", unmaximize: "unmaximize", minimize: "minimize", unminimize: "unminimize",
  center: "center", show: "show", hide: "hide", close: "close", setFocus: "set-focus",
  startDragging: "start-dragging", toggleMaximize: "toggle-maximize",
};
// 只读的由 core:default 带出的 core:window:default 覆盖；列出来是为了抓住「未登记的新调用」
const READ_API = new Set(["innerSize", "outerSize", "innerPosition", "outerPosition", "isMaximized",
  "isFullscreen", "isFocused", "isMinimized", "isDecorated", "isResizable", "isClosable", "isAlwaysOnTop",
  "isMaximizable", "isMinimizable", "scaleFactor", "currentMonitor", "primaryMonitor", "availableMonitors",
  "theme", "title", "label"]);

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkJs(path.join(dir, e.name)) : (e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
const usedApis = new Map();
for (const file of walkJs(srcDir)) {
  for (const m of readProductSource(file, "utf8").matchAll(/\bwin\.([A-Za-z]+)\(/g)) {
    if (!usedApis.has(m[1])) usedApis.set(m[1], path.relative(srcDir, file).replace(/\\/g, "/"));
  }
}
assert.ok(usedApis.size >= 10, `必须扫到窗口 API 调用，当前只找到 ${usedApis.size} 个（正则失效了？）`);
for (const [api, where] of usedApis) {
  if (WRITE_API[api]) {
    assert.ok(granted.has(`core:window:allow-${WRITE_API[api]}`),
      `🔴 ${where} 调用 win.${api}()，但 capabilities/default.json 缺 core:window:allow-${WRITE_API[api]} → 运行时报 not allowed by ACL`);
  } else {
    assert.ok(READ_API.has(api),
      `未登记的窗口 API win.${api}()（${where}）：只读的加进 READ_API，会改状态的必须同时登记 WRITE_API 并补进 capabilities`);
  }
}
// 本 bug 涉及的那几条单独钉死：清单里被删时给出指名道姓的原因
for (const p of ["set-size", "set-position", "center", "maximize", "unmaximize", "set-always-on-top"]) {
  assert.ok(granted.has(`core:window:allow-${p}`),
    `🔴 缺 core:window:allow-${p}：缩放视图 / 启动窗口大小 / 窗口置顶会静默失败（v0.74.1 的回归）`);
}

console.log("PASS: startup window size presets, screen fitting, preference normalization, focus-window toggle, boot wiring and the Tauri window ACL grant list");
