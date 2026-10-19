/*
 * 侧栏按「分类」区分图标（v0.216.0）
 *
 * 过去侧栏一律拿插件图标：shell.js 的 viewDef 给 `icon = PLUGIN_ICONS[pluginId] || v.icon`，
 * navBtn 又用 `def.pluginView.pluginId` 取图，于是 cppu-notify 的七个分类在侧栏长得一模一样。
 * 现在图标来源是**视图 id**（iconKey = v.id），插件主视图的 id 就等于插件 id，仍落回插件图标。
 *
 * 守住六件事：
 *   ① 同一插件的每个分类，桌面彩色 PNG 与窄屏 FA 轮廓两套图标都两两不同，也不等于插件自己的；
 *   ② 随包 PNG 真存在且字节两两不同 —— 这才是「不重复」的硬证据，光对常量表不够；
 *   ③ FA sprite 里真有那个符号：缺符号时窄屏是一整排空白，看着还是「一样的图标」；
 *   ④ 侧栏里同时出现的插件图标也不许撞（竞赛消息 trophy ≠ 获奖名单；课程表 calendar-days ≠ 校历）；
 *   ⑤ 插件注册了几个分类就得有几个图标 —— 新增分类忘了配图标要在这里红；
 *   ⑥ 声明（registerView 的 icon）与消费口径（VIEW_FA_ICONS）不许漂移。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const sha = (rel) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");

const PLUGIN = "cppu-notify";

// icons.js 的 appIcon 要 document、store 要 localStorage —— 给最小替身，直接跑真函数而不是读源码。
const mkNode = (tag) => ({
  tag, attrs: {}, dataset: {}, children: [],
  style: { setProperty(key, value) { this[key] = value; } },
  classList: { add() {} },
  setAttribute(key, value) { this.attrs[key] = value; },
  append(...nodes) { this.children.push(...nodes); },
  addEventListener() {},
});
globalThis.document = { createElement: mkNode, createElementNS: (_ns, tag) => mkNode(tag) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { initStore } = await import("../src/store.js");
await initStore({ tasks: [], blocks: [], settings: {}, inbox: [], plugins: {}, automation: {} });
const { pluginDisplayIcon, pluginDisplayOutlineIcon } = await import("../src/pluginAppearance.js");

const iconSrc = (iconKey) => pluginDisplayIcon(PLUGIN, "", iconKey).attrs.src;
const outlineName = (iconKey) => pluginDisplayOutlineIcon(PLUGIN, "", iconKey).children[0].attrs.href.split("#")[1];

/* ── ① 从插件源码取出它注册的分类视图与各自声明的图标 ── */
const portal = read("public/plugins/cppu-notify/main.js");
const declared = new Map();
for (const m of portal.matchAll(/tide\.ui\.registerView\(\{\s*id: "([\w-]+)",\s*title: "[^"]+",\s*icon: ["']([\w-]+)["']/g)) {
  declared.set(m[1], m[2]);
}
const jwStart = portal.indexOf("const JW_VIEWS = [");
const jwBlock = portal.slice(jwStart, portal.indexOf("\n  ];", jwStart));
for (const m of jwBlock.matchAll(/^\s*id: "([\w-]+)", title: "[^"]+", icon: "([\w-]+)"/gm)) declared.set(m[1], m[2]);

assert.equal(declared.get(PLUGIN), "building-columns", "插件主视图的图标仍是插件自己的（视图 id === 插件 id）");
const views = [...declared.keys()].filter((id) => id !== PLUGIN).sort();
assert.deepEqual(views, ["cppu-award", "cppu-calendar", "cppu-card", "cppu-credit", "cppu-cx", "cppu-growth", "cppu-net", "cppu-profile", "cppu-qj", "cppu-xk"],
  "cppu-notify 现在注册 10 个分类视图；新增/删除分类要同步更新本测试与 src/icons.js 的两张表");

/* ── ② 声明与消费口径不许漂移 ── */
const icons = read("src/icons.js");
const tableOf = (name) => {
  const start = icons.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `src/icons.js 缺少 ${name}`);
  return icons.slice(start, icons.indexOf("};", start));
};
const viewFa = Object.fromEntries([...tableOf("VIEW_FA_ICONS").matchAll(/"([\w-]+)": "([\w-]+)"/g)].map((m) => [m[1], m[2]]));
const viewIcons8 = Object.fromEntries([...tableOf("VIEW_ICONS8").matchAll(/"([\w-]+)": \[([^\]]*)\]/g)]
  .map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1])]));
assert.deepEqual(Object.keys(viewFa).sort(), views, "VIEW_FA_ICONS 的键必须与分类视图一一对应（新增分类要配图标）");
assert.deepEqual(Object.keys(viewIcons8).sort(), views, "VIEW_ICONS8 的键必须与分类视图一一对应");
for (const id of views) {
  assert.equal(viewFa[id], declared.get(id), `${id}：VIEW_FA_ICONS 与 registerView 的 icon 必须一致，否则窄屏与桌面各画各的`);
}

/* ── ③ 两套图标各自两两不同，且都不等于插件自己的 ── */
const pngs = views.map(iconSrc);
const outlines = views.map(outlineName);
assert.deepEqual(pngs, views.map((id) => `/icons/plugins/${id}.png`), "彩色图标的随包 PNG key 必须就是视图 id");
assert.equal(new Set(pngs).size, views.length, `分类的彩色图标不能重复：${pngs.join(", ")}`);
assert.equal(new Set(outlines).size, views.length, `分类的轮廓图标不能重复：${outlines.join(", ")}`);
assert.ok(!pngs.includes(iconSrc(PLUGIN)), "分类图标不许等于插件图标");
assert.ok(!outlines.includes(outlineName(PLUGIN)), "分类轮廓不许等于插件图标");

/* ── ④ 同一个侧栏里其它插件的轮廓图标也不能撞 ── */
const sidebar = new Map(); // 轮廓名 → 占用者
sidebar.set(outlineName(PLUGIN), PLUGIN);
for (const dir of fs.readdirSync(path.join(root, "public/plugins"))) {
  const rel = `public/plugins/${dir}/manifest.json`;
  if (!exists(rel)) continue;
  const manifest = JSON.parse(read(rel));
  if (manifest.id === PLUGIN || (manifest.platforms || {}).miniprogram === "unavailable") continue;
  const name = manifest.icon || manifest.faIcon || "puzzle-piece";
  assert.ok(!sidebar.has(name), `侧栏图标撞了：${dir} 与 ${sidebar.get(name)} 都是 ${name}`);
  sidebar.set(name, dir);
}
for (const id of views) {
  assert.ok(!sidebar.has(viewFa[id]), `${id} 的轮廓图标 ${viewFa[id]} 已被 ${sidebar.get(viewFa[id])} 占用，同一个侧栏里不能重复`);
  sidebar.set(viewFa[id], id);
}
// 彩色 PNG 一侧：7 个分类的首选 slug 互不相同，且整条 CDN 回落链也不跨分类重复
const firsts = views.map((id) => viewIcons8[id][0]);
assert.equal(new Set(firsts).size, firsts.length, `分类的 Icons8 首选 slug 不能重复：${firsts.join(", ")}`);
const chain = views.flatMap((id) => viewIcons8[id]);
assert.equal(new Set(chain).size, chain.length, `分类的 Icons8 回落链不能跨分类重复：${chain.join(", ")}`);

/* ── ⑤ 随包 PNG 真存在、字节两两不同、三端同源 ── */
const keys = [PLUGIN, ...views];
const digests = new Map();
for (const key of keys) {
  const rel = `public/icons/plugins/${key}.png`;
  assert.ok(exists(rel), `缺少随包图标 ${rel}`);
  assert.ok(fs.statSync(path.join(root, rel)).size > 200, `${rel} 不像真 PNG`);
  digests.set(key, sha(rel));
}
assert.equal(new Set(digests.values()).size, keys.length, "分类图标必须各是一张不同的图（有重复的 PNG 字节）");
for (const key of keys) {
  const mini = path.join(root, "..", "miniprogram", "images", "plugins", `${key}.png`);
  assert.ok(fs.existsSync(mini), `微信端缺少 miniprogram/images/plugins/${key}.png`);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(mini)).digest("hex"), digests.get(key),
    `${key} 的图标必须三端同源（微信端与桌面端同一份字节）`);
}

/* ── ⑥ FA sprite 里真有这些符号，否则窄屏是一整排空白 ── */
const sprite = read("public/icons/fontawesome/solid.svg");
for (const name of [outlineName(PLUGIN), ...outlines]) {
  assert.ok(sprite.includes(`id="${name}"`), `FA sprite 缺少 ${name}：窄屏会画成空白，看着还是「一样的图标」`);
}

/* ── ⑦ 接线：shell.js 用视图 id 取图，自定义图标仍按插件 id ── */
const shell = read("src/shell.js");
assert.match(shell, /iconKey: v\.id/, "viewDef 要把视图 id 交出去当图标来源");
assert.match(shell, /const iconKey = isPlug \? \(def\.pluginView\?\.id \|\| def\.pluginView\?\.pluginId\) : id;/,
  "取不到视图 id 时回落到插件 id，异常态不能变裂图");
assert.match(shell, /pluginDisplayIcon\(def\.pluginView\.pluginId, def\.title, iconKey\)/);
assert.match(shell, /pluginDisplayOutlineIcon\(def\.pluginView\.pluginId, def\.title, iconKey\)/);
const appearance = read("src/pluginAppearance.js");
assert.match(appearance, /export function pluginDisplayIcon\(id, title = "", iconKey = ""\) \{\n\s+const icon = appIcon\(iconKey \|\| id, title\);/,
  "pluginDisplayIcon 要按 iconKey 取底图，不传时行为不变（iconKey || id）");
assert.match(appearance, /export function pluginDisplayOutlineIcon\(id, title = "", iconKey = ""\) \{\n\s+const icon = outlineAppIcon\(iconKey \|\| id, title\);/);
assert.match(appearance, /const custom = getPluginOverride\(id\)\.icon;/,
  "用户给插件换的图标与 accent 色仍按插件 id，对它所有分类生效");

console.log(`侧栏分类图标：${views.length} 个分类，彩色 PNG 与 FA 轮廓两两不同，且不与同侧栏 ${sidebar.size} 个图标相撞`);
console.log("PASS: sidebar icons per plugin view (cppu-notify 10 categories), bundled PNG uniqueness and FA sprite coverage");
