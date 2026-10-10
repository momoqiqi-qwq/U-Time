import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");
const plugin = readProductSource(new URL("../public/plugins/cppu-notify/main.js", import.meta.url), "utf8");
const ids = ["cppu-credit", "cppu-cx", "cppu-qj", "cppu-notify", "cppu-xk", "cppu-card"];
for (const id of ids) assert.ok(plugin.includes(`"${id}"`), `${id} must be registered`);
// v0.180.0：卡片上的「打开」按钮已删（卡片本身就是入口），切片终点从 `const open =` 换成 `const toggle =`。
const block = shell.slice(shell.indexOf("        const cardViews ="), shell.indexOf("        const toggle = el(\"button\", {", shell.indexOf("        const cardViews =")));
assert.ok(block, "plugin card view links are required");
const render = new Function("pluginViews", "rec", "enabled", "isAndroidRuntime", "el", "faIcon", "switchTo", "pluginName", `${block}\nreturn viewLinks;`);
const views = ids.map((id) => ({ id, title: id, pluginId: "cppu-notify" }));
views.push({ id: "unrelated", title: "Other", pluginId: "other" });
const el = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat() });
const routes = [];
const draw = (android, enabled) => render(views, { id: "cppu-notify" }, enabled, () => android, el, (icon) => icon, (id) => routes.push(id), "警大门户");
const links = draw(true, true);
assert.deepEqual(links.children.map((button) => button.attrs["data-plugin-view"]), ids);
for (const button of links.children) button.attrs.onclick({ stopPropagation() {} });
assert.deepEqual(routes, ids.map((id) => `plug:${id}`));
assert.equal(draw(false, true), null, "desktop retains existing sidebar navigation");
assert.ok(draw(true, false).children.every((button) => button.attrs.disabled === true));
assert.equal(render([], { id: "cppu-notify" }, false, () => true, el, () => "", () => {}, "警大门户"), null);
console.log("PASS: APK exposes every registered plugin view with correct navigation and enable state");
