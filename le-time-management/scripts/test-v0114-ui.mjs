import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => readProductSource(new URL(rel, import.meta.url), "utf8");
const shell = read("../src/shell.js");
const pluginSettings = read("../src/views/settings/plugins.js");
const pluginHost = read("../src/pluginHost.js");
const icons = read("../src/icons.js");
const cppu = read("../public/plugins/cppu-notify/main.js");

assert.doesNotMatch(shell, /权限\s*\/\s*管理/);
assert.doesNotMatch(pluginSettings, /getPluginPermissions|setPluginPermission|plugin-perm/);
assert.doesNotMatch(pluginHost, /export function getPluginPermissions|export async function setPluginPermission/);
assert.match(shell, /market-plugin-switch/);
assert.match(pluginSettings, /plugin-enable-switch/);
// v0.42.0：主导航图标从 Icons8 iOS Filled CDN 直链改为随包 Color PNG（icons/nav/），与插件图标同一方案
assert.match(icons, /icons\/\$\{bundledDir\}\/\$\{key\}\.png/);
assert.match(icons, /bundled nav PNG \(Icons8 Color\)/);
assert.match(cppu, /pp-detail-shell/);
assert.match(cppu, /grid-template-rows:0fr/);
assert.match(cppu, /setCardExpanded\(card, false\)/);
assert.match(cppu, /prefers-reduced-motion:reduce/);

console.log("PASS: v0.11.4 plugin switch simplification, bundled nav/plugin Icons8 Color icons and smooth notice expansion");
