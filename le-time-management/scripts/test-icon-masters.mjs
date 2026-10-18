// v0.250.0 内置图标统一为自有扁平母版：母版齐全、台账口径、生成链接线
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_PLUGINS } from "../src/pluginCatalog.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(app, "..");
const masters = path.join(repo, "tools", "icon-masters");
const gen = fs.readFileSync(path.join(repo, "tools", "gen-plugin-icons.py"), "utf8");

assert.match(gen, /MASTERS = REPO \/ "tools" \/ "icon-masters"/, "生成器必须从 tools/icon-masters 读母版");
assert.match(gen, /raw = master_bytes\(f"\{plugin_id\}\.png"\)/, "插件图标优先用母版");
assert.match(gen, /raw = master_bytes\(f"\{view_id\}\.png"\)/, "分类视图图标优先用母版");
assert.match(gen, /raw = master_bytes\(f"nav\/\{mkey\}\.png"\)/, "导航图标优先用母版");

// 每个内置插件都要有母版（否则侧栏会混进旧风格）
for (const p of BUILTIN_PLUGINS) {
  assert.ok(fs.existsSync(path.join(masters, `${p.id}.png`)), `缺少内置插件母版 tools/icon-masters/${p.id}.png`);
}
// 生成器 VIEW_ICONS 里的每个分类视图都要有母版
const viewBlock = /VIEW_ICONS = \{([\s\S]*?)\n\}/.exec(gen)?.[1] || "";
const views = [...viewBlock.matchAll(/^\s*"([\w-]+)":/gm)].map((m) => m[1]);
assert.ok(views.length >= 9, "VIEW_ICONS 解析失败");
for (const v of views) assert.ok(fs.existsSync(path.join(masters, `${v}.png`)), `缺少分类视图母版 ${v}.png`);
for (const k of ["quadrant", "timeline", "timeblock", "inbox", "market", "settings"]) {
  assert.ok(fs.existsSync(path.join(masters, "nav", `${k}.png`)), `缺少导航母版 nav/${k}.png`);
}

// 母版是 PNG，且边长 ≥ 128（生成器会缩到 58px 图形，母版太小会糊）
for (const f of fs.readdirSync(masters).filter((x) => x.endsWith(".png"))) {
  const b = fs.readFileSync(path.join(masters, f));
  assert.equal(b.subarray(1, 4).toString(), "PNG", `${f} 不是 PNG`);
  assert.ok(b.readUInt32BE(16) >= 128 && b.readUInt32BE(20) >= 128, `${f} 母版太小`);
}

// 台账：内置插件与分类视图都记为 master；导航来源指向母版
const attr = fs.readFileSync(path.join(app, "public", "icons", "plugins", "ATTRIBUTION.md"), "utf8");
for (const id of [...BUILTIN_PLUGINS.map((p) => p.id), ...views]) {
  assert.match(attr, new RegExp("\\| `" + id + "` \\| master \\|"), `ATTRIBUTION.md 里 ${id} 应来自母版`);
}
assert.match(attr, /无需第三方署名/, "台账要写明母版无需第三方署名");
const navAttr = fs.readFileSync(path.join(app, "public", "icons", "nav", "ATTRIBUTION.md"), "utf8");
for (const k of ["quadrant", "timeline", "timeblock", "inbox", "market", "settings", "capture"]) {
  assert.match(navAttr, new RegExp("\\| `" + k + "` \\| `icon-masters/nav/"), `导航 ${k} 应来自母版`);
}

// icons.js 的来源标注跟着改；CDN 回落仍是 Icons8
const icons = fs.readFileSync(path.join(app, "src", "icons.js"), "utf8");
assert.match(icons, /"bundled plugin PNG \(flat masters\)"/);
assert.match(icons, /: "Icons8 Color",/, "CDN 回落仍标 Icons8 Color");

console.log("PASS: 内置图标统一为自有扁平母版（插件 / 分类视图 / 导航母版齐全，台账与来源标注一致）");
