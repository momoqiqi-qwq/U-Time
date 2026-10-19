// 内置图标来源口径：插件与插件内视图 = Icons8 Color 随包 PNG；主导航 = 自有扁平母版。
// v0.250.0 曾把插件图标也统一成扁平母版，侧栏观感退回上一版后只保留主导航那套母版 ——
// 这里反向守住「插件不要再长出母版」：只要 tools/icon-masters/<插件id>.png 存在，
// gen-plugin-icons.py 就会优先用它，下次生成会把侧栏图标静默覆盖回扁平风格。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_PLUGINS } from "../src/pluginCatalog.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(app, "..");
const masters = path.join(repo, "tools", "icon-masters");
const gen = fs.readFileSync(path.join(repo, "tools", "gen-plugin-icons.py"), "utf8");

// 生成器能力（保留）：三处都是「母版优先，缺失回落 Icons8 CDN + 本地缓存」
assert.match(gen, /MASTERS = REPO \/ "tools" \/ "icon-masters"/, "生成器必须从 tools/icon-masters 读母版");
assert.match(gen, /raw = master_bytes\(f"\{plugin_id\}\.png"\)/, "插件图标应支持母版优先");
assert.match(gen, /raw = master_bytes\(f"\{view_id\}\.png"\)/, "分类视图图标应支持母版优先");
assert.match(gen, /raw = master_bytes\(f"nav\/\{mkey\}\.png"\)/, "导航图标应支持母版优先");

// 主导航：母版必须齐全，且边长 ≥ 128（生成器会缩到 58px 图形，母版太小会糊）
const NAV_KEYS = ["quadrant", "timeline", "timeblock", "inbox", "market", "settings"];
for (const k of NAV_KEYS) {
  assert.ok(fs.existsSync(path.join(masters, "nav", `${k}.png`)), `缺少导航母版 tools/icon-masters/nav/${k}.png`);
}
for (const f of fs.readdirSync(path.join(masters, "nav")).filter((x) => x.endsWith(".png"))) {
  const b = fs.readFileSync(path.join(masters, "nav", f));
  assert.equal(b.subarray(1, 4).toString(), "PNG", `nav/${f} 不是 PNG`);
  assert.ok(b.readUInt32BE(16) >= 128 && b.readUInt32BE(20) >= 128, `nav/${f} 母版太小`);
}

// 插件内视图 id（与生成器 VIEW_ICONS 对齐）
const viewBlock = /VIEW_ICONS = \{([\s\S]*?)\n\}/.exec(gen)?.[1] || "";
const views = [...viewBlock.matchAll(/^\s*"([\w-]+)":/gm)].map((m) => m[1]);
assert.ok(views.length >= 9, "VIEW_ICONS 解析失败");
const pluginIds = [...BUILTIN_PLUGINS.map((p) => p.id), ...views];

// 插件 / 视图：不许有母版（有母版就会被优先读取，侧栏图标等于被判回扁平风格）
for (const id of pluginIds) {
  assert.ok(
    !fs.existsSync(path.join(masters, `${id}.png`)),
    `插件图标应来自 Icons8 随包 PNG，不应存在母版 tools/icon-masters/${id}.png`,
  );
}

// 随包 PNG 存在、是 81×81 的生成物，且与台账里的 sha256 前 16 位一致（防手改）
const attr = fs.readFileSync(path.join(app, "public", "icons", "plugins", "ATTRIBUTION.md"), "utf8");
const rowDigests = new Map(
  [...attr.matchAll(/^\| `([\w-]+)` \| [\w-]+ \| [^|]+ \|[^|]*\| `([0-9a-f]{16})…` \|$/gm)].map((m) => [m[1], m[2]]),
);
for (const id of pluginIds) {
  const file = path.join(app, "public", "icons", "plugins", `${id}.png`);
  assert.ok(fs.existsSync(file), `缺少随包图标 public/icons/plugins/${id}.png`);
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString(), "PNG", `${id}.png 不是 PNG`);
  assert.equal(b.readUInt32BE(16), 81, `${id}.png 宽度应为 81`);
  assert.equal(b.readUInt32BE(20), 81, `${id}.png 高度应为 81`);
  const digest = createHash("sha256").update(b).digest("hex");
  const ledger = rowDigests.get(id);
  assert.ok(ledger, `ATTRIBUTION.md 缺少 ${id} 的素材行`);
  assert.equal(digest.slice(0, 16), ledger, `${id}.png 与台账 sha256 不一致（图标被手工替换？）`);
}

// 台账口径：插件行标 Icons8 风格，且没有任何 master 行
for (const id of pluginIds) {
  assert.match(attr, new RegExp("\\| `" + id + "` \\| (?:color|3d-fluency) \\|"), `台账里 ${id} 应标 Icons8 风格`);
}
assert.match(attr, /Icons8/, "插件台账要写明 Icons8 来源");
assert.doesNotMatch(attr, /\| `[\w-]+` \| master \|/, "插件台账不应有 master 行（插件图标来自 Icons8）");
const navAttr = fs.readFileSync(path.join(app, "public", "icons", "nav", "ATTRIBUTION.md"), "utf8");
for (const k of [...NAV_KEYS, "capture"]) {
  assert.match(navAttr, new RegExp("\\| `" + k + "` \\| `icon-masters/nav/"), `导航 ${k} 应来自母版`);
}

// icons.js 的来源标注跟着分家：插件标 Icons8，导航标扁平母版；CDN 回落仍是 Icons8
const icons = fs.readFileSync(path.join(app, "src", "icons.js"), "utf8");
assert.match(icons, /"bundled plugin PNG \(Icons8 Color\)"/);
assert.match(icons, /"bundled nav PNG \(flat masters\)"/);
assert.match(icons, /: "Icons8 Color",/, "CDN 回落仍标 Icons8 Color");

console.log("PASS: 侧栏插件图标来自 Icons8 随包 PNG（无母版），主导航仍为自有扁平母版，台账与来源标注一致");
