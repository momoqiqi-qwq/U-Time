import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");
const plugin = readProductSource(new URL("../public/plugins/cppu-notify/main.js", import.meta.url), "utf8");
const ids = ["cppu-credit", "cppu-cx", "cppu-qj", "cppu-notify", "cppu-xk", "cppu-card", "cppu-award"];
for (const id of ids) assert.ok(plugin.includes(`"${id}"`), `${id} must be registered`);
// v0.180.0：卡片上的「打开」按钮已删（卡片本身就是入口），切片终点从 `const open =` 换成 `const toggle =`。
// v0.214.1：视图入口不再只在 APK 露（桌面侧栏按视图成行、插件中心按插件成卡，只列首视图时
// 「绿色组 7 条」到插件中心只剩一张卡），所以这里不再注入 isAndroidRuntime。
const block = shell.slice(shell.indexOf("        const cardViews ="), shell.indexOf("        const toggle = el(\"button\", {", shell.indexOf("        const cardViews =")));
assert.ok(block, "plugin card view links are required");
assert.ok(!block.includes("isAndroidRuntime"), "🔴 视图入口不许再按平台分叉：两端的组计数与条目必须一致");
// 卡片改为读取本轮索引后，夹具也执行真实索引构建，避免凭空注入与生产口径不同的 Map。
const indexStart = shell.indexOf("    let viewsByPlugin = new Map()");
const indexEnd = shell.indexOf("    // 启停只同步现有节点", indexStart);
assert.ok(indexStart >= 0 && indexEnd > indexStart, "plugin view indexing source must be present");
const indexBlock = shell.slice(indexStart, indexEnd);
const render = new Function("pluginViews", "rec", "enabled", "el", "faIcon", "switchTo", "pluginName",
  `${indexBlock}\nconst pluginColor = () => "green";\nindexMarketViews([rec]);\n${block}\nreturn viewLinks;`);
const views = ids.map((id) => ({ id, title: id, pluginId: "cppu-notify" }));
views.push({ id: "unrelated", title: "Other", pluginId: "other" });
const el = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat() });
const routes = [];
const draw = (enabled) => render(views, { id: "cppu-notify" }, enabled, el, (icon) => icon, (id) => routes.push(id), "警大门户");
const links = draw(true);
assert.deepEqual(links.children.map((button) => button.attrs["data-plugin-view"]), ids);
for (const button of links.children) button.attrs.onclick({ stopPropagation() {} });
assert.deepEqual(routes, ids.map((id) => `plug:${id}`));
assert.ok(draw(true).children.every((button) => button.attrs.disabled !== true));
assert.ok(draw(false).children.every((button) => button.attrs.disabled === true));
assert.equal(render([], { id: "cppu-notify" }, false, el, () => "", () => {}, "警大门户"), null);
console.log("PASS: every platform exposes every registered plugin view with correct navigation and enable state");
