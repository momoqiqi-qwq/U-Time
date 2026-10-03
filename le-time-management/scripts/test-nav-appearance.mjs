import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 核心导航项自定义（侧栏右键改名 / 换图标）回归测试
 *
 * 守住这几件事：
 *   ① navAppearance：只存「用户改过的字段」；空名称、非 data:image 图标一律不落库，
 *      键清空后整条删除 —— 留下 {name:""} 这种脏对象会让「恢复默认」按钮永远可点，
 *      而 navDisplayName 又会因为 trim 后为空而回落默认，两处判定自相矛盾。
 *   ② shell：默认名的事实源仍是 VIEWS 常量，viewDef 只在改过名时新建对象（不写脏常量表）；
 *      侧栏条目与顶栏标题卡读同一个 navDisplayIcon，自定义图标才不会「侧栏换了、标题没换」。
 *   ③ 菜单：核心页与插件共用一个菜单槽位（同一时刻只开一个，关闭逻辑一份）；
 *      核心页菜单只有外观三项，不许混进插件专属的快捷键 / 导入 / 删除。
 *   ④ 改名后只刷外壳，不重跑视图渲染（重渲染会丢滚动位置与未提交的输入）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initStore, getState } from "../src/store.js";
import { getNavOverride, hasNavOverride, navDisplayName, resetNavOverride, setNavOverride } from "../src/navAppearance.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readProductSource(path.join(here, rel), "utf8");
const shell = read("../src/shell.js");
const appearance = read("../src/views/settings/appearance.js");
const navModule = read("../src/navAppearance.js");

// store 的 350ms 防抖落盘会走 api.saveData → localStorage，node 里没有这个全局，
// 会在测试跑完后打一行「保存失败」污染输出。给一份内存实现，顺带验证覆盖值真能落盘。
const mem = new Map();
globalThis.localStorage = {
  getItem: (key) => (mem.has(key) ? mem.get(key) : null),
  setItem: (key, value) => mem.set(key, String(value)),
  removeItem: (key) => mem.delete(key),
};

/* ── ① 覆盖表的读写语义 ── */
await initStore({ tasks: [], blocks: [], settings: {}, inbox: [], plugins: {}, automation: {} });

assert.equal(navDisplayName("inbox", "收件箱"), "收件箱", "没有覆盖时必须回落传入的默认名");
assert.equal(hasNavOverride("inbox"), false, "初始态不该有任何覆盖记录");

setNavOverride("inbox", { name: "  收集站  " });
assert.equal(navDisplayName("inbox", "收件箱"), "收集站", "显示名在读取时 trim（表里存用户原样输入，与 pluginOverrides 同一套语义）");
setNavOverride("inbox", { name: "收集站" });
assert.deepEqual(getState().settings.navOverrides, { inbox: { name: "收集站" } }, "只存改过的字段");

// 留空 = 恢复默认：整条删掉，而不是留 {name:""}
setNavOverride("inbox", { name: "   " });
assert.equal(hasNavOverride("inbox"), false, "清空名称后必须删掉整条，否则「恢复默认」按钮判定会失真");
assert.equal(navDisplayName("inbox", "收件箱"), "收件箱");

setNavOverride("inbox", { name: "收集站", icon: "data:image/png;base64,AAAA" });
assert.deepEqual(getNavOverride("inbox"), { name: "收集站", icon: "data:image/png;base64,AAAA" });
// 只接受 data: 图片：http(s) 外链会随离线/图床失效，也会把用户访问记录泄漏出去
setNavOverride("inbox", { icon: "https://img.example.com/x.png" });
assert.deepEqual(getNavOverride("inbox"), { name: "收集站" }, "非法图标值不许进表，连带的旧值一并清掉");
assert.equal(getState().settings.navOverrides.inbox.icon, undefined);

resetNavOverride("inbox");
assert.equal(hasNavOverride("inbox"), false, "恢复默认 = 整条删除");
assert.equal(navDisplayName("inbox", "收件箱"), "收件箱");

// 覆盖表按视图 id 分键，互不影响
setNavOverride("quadrant", { name: "待办" });
assert.equal(navDisplayName("timeblock", "时间块"), "时间块", "改一个页面不许影响其它页面");
resetNavOverride("quadrant");

// 表被写坏（数组 / null）时归一化回对象，不许抛异常
getState().settings.navOverrides = [];
assert.equal(navDisplayName("market", "插件"), "插件", "navOverrides 是数组时必须回落默认值");
getState().settings.navOverrides = null;
assert.equal(navDisplayName("market", "插件"), "插件");

// 改完必须落盘（persistSoon 防抖 350ms）：外观要跟着同步快照与备份走，
// 换设备 / 导入备份后不该退回默认名称。
setNavOverride("inbox", { name: "收集站" });
await new Promise((resolve) => setTimeout(resolve, 400));
const saved = JSON.parse(mem.get([...mem.keys()][0]) ?? "{}");
assert.equal(saved?.settings?.navOverrides?.inbox?.name, "收集站", "navOverrides 必须写进持久化数据");

/* ── ② 模块自身的边界 ── */
const navCode = navModule.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""); // 剥注释：头部说明会提到 pluginOverrides 只是对照
assert.match(navCode, /settings\.navOverrides/, "自定义值必须落在 settings.navOverrides（随快照同步、无需数据迁移）");
assert.doesNotMatch(navCode, /pluginOverrides/, "核心页与插件的覆盖表必须分开，两张表不许互相污染");

/* ── ③ shell 接线 ── */
assert.match(shell, /const title = navDisplayName\(def\.id, def\.title\);/, "viewDef 必须按视图 id 取显示名");
assert.match(shell, /return title === def\.title \? def : \{ \.\.\.def, title \};/,
  "未改名要返回 VIEWS 原对象、改过名返回副本 —— 直接改 VIEWS 会把默认值事实源写脏");
assert.match(shell, /navDisplayIcon\(id, def\.title\)/, "侧栏条目图标必须走 navDisplayIcon（自定义图标才生效）");
assert.match(shell, /titleMark\.append\(navDisplayIcon\(def\.id, def\.title\)\)/,
  "顶栏标题卡与侧栏读同一个图标来源，否则改了图标只有一处生效");
assert.match(shell, /if \(desktopWindow && !isPlug\) \{[\s\S]{0,160}openNavContextMenu\(event, id\)\);/,
  "核心页右键菜单只在桌面窗口挂上（窄屏是底栏，没有右键语义）");
assert.match(shell, /let contextMenu = null;/, "核心页与插件菜单共用一个槽位");
assert.doesNotMatch(shell, /pluginContextMenu|closePluginContextMenu/,
  "菜单槽位与关闭逻辑只留一份通用实现，别再长出第二套");
assert.doesNotMatch(shell, /pendingPluginIconId/, "挑图 input 的目标改用 pendingIconTarget 统一表达");
assert.match(shell, /pendingIconTarget = \{ kind: "nav", id: viewId \};/, "核心页挑图要标记 kind=nav");
assert.match(shell, /if \(target\.kind === "nav"\) \{[\s\S]{0,160}setNavOverride\(target\.id, \{ icon \}\)/,
  "图标落库必须按 kind 分流：核心页写 navOverrides，插件写 pluginOverrides");

/* ── ④ 核心页菜单内容 ── */
const navMenuStart = shell.indexOf("function openNavContextMenu");
const navMenu = shell.slice(navMenuStart, shell.indexOf('document.addEventListener("pointerdown"', navMenuStart));
assert.ok(navMenuStart > 0 && navMenu.length > 0, "没找到 openNavContextMenu 代码块");
for (const label of ["重命名", "修改图标…", "恢复默认名称与图标"]) {
  assert.ok(navMenu.includes(label), `核心页菜单缺少「${label}」`);
}
assert.doesNotMatch(navMenu, /导入插件|删除插件|快捷键 ·/, "插件专属操作不许出现在核心页菜单里");
assert.match(navMenu, /disabled: !hasNavOverride\(viewId\)/, "没有覆盖项时「恢复默认」必须置灰");

/* ── ⑤ 改名后只刷外壳 ── */
const refresh = shell.slice(shell.indexOf("function refreshCorePresentation()"), shell.indexOf("pluginZipInput.addEventListener"));
assert.ok(refresh.length > 0, "没找到 refreshCorePresentation 代码块");
assert.match(refresh, /renderNav\(\)/, "改名后侧栏必须重绘");
assert.match(refresh, /renderTitleMark\(def\)/, "改名后顶栏标题卡图标必须跟着换");
assert.doesNotMatch(refresh, /switchTo\(/, "改名不许走 switchTo —— 那会重渲染整个视图，丢掉滚动位置");

/* ── ⑥ 设置页启动项跟随改名 ── */
assert.match(appearance, /id === "last" \? label : navDisplayName\(id, label\)/,
  "启动页下拉要显示改名后的页面名，「继续上次页面」不参与");

console.log("PASS: 核心导航项改名 / 换图标的覆盖表语义、菜单接线与刷新范围");
