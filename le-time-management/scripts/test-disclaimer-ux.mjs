import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SETTINGS_SEARCH_ENTRIES } from "../src/settingsSearchIndex.js";

const read = (name) => readProductSource(new URL(name, import.meta.url), "utf8");
const code = read("../src/disclaimer.js").replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
const el = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(Boolean), nodeType: 1 });
const flatten = (node) => typeof node === "string" ? node : node.children.map(flatten).join(" ");
const walk = (node) => typeof node === "string" ? [] : [node, ...node.children.flatMap(walk)];
function fixture({ version = null, failStorage = false, native = true } = {}) {
  let answer, count = 0, writes = 0, last;
  const module = new Function("api", "appConfirm", "el", "localStorage", `${code}\nreturn {showStartupDisclaimer,createDisclaimerContent,DISCLAIMER_VERSION,DISCLAIMER_SECTIONS,DISCLAIMER_ITEMS};`)(
    { isTauri: native }, (...args) => { count++; last = args; return new Promise((resolve) => { answer = resolve; }); }, el,
    { getItem() { if (failStorage) throw Error("blocked"); return version; }, setItem(_, v) { if (failStorage) throw Error("blocked"); writes++; version = v; } });
  return { ...module, resolve: (v) => answer(v), get count() { return count; }, get writes() { return writes; }, get version() { return version; }, get last() { return last; } };
}
let f = fixture({ version: "1" });
const a = f.showStartupDisclaimer(), b = f.showStartupDisclaimer();
assert.equal(f.count, 1, "concurrent calls share one dialog");
assert.equal(f.last[2].focusMessage, true);
assert.equal(f.last[1].attrs.tabindex, "0");
f.resolve(false);
assert.deepEqual(await Promise.all([a, b]), [false, false]);
assert.equal(f.version, "1", "cancel leaves old acknowledgement unchanged");
assert.equal(f.writes, 0);
const accepted = f.showStartupDisclaimer(); f.resolve(true);
assert.equal(await accepted, true);
assert.equal(f.version, f.DISCLAIMER_VERSION);
await f.showStartupDisclaimer(); assert.equal(f.count, 2);
f = fixture({ version: "2" }); assert.equal(await f.showStartupDisclaimer(), true); assert.equal(f.count, 0);
f = fixture({ native: false }); assert.equal(await f.showStartupDisclaimer(), false); assert.equal(f.count, 0);
f = fixture({ failStorage: true });
const blocked = f.showStartupDisclaimer(); f.resolve(true); assert.equal(await blocked, true);
await f.showStartupDisclaimer(); assert.equal(f.count, 1, "storage failure does not block startup or repeat within session");
const content = f.createDisclaimerContent();
assert.equal(walk(content).filter((n) => n.tag === "section").length, 7);
assert.ok(walk(content).every((n) => !String(n.attrs.class).includes("set-hint")), "essential copy must not inherit description hiding");
assert.equal(f.DISCLAIMER_ITEMS.length, f.DISCLAIMER_SECTIONS.length);
for (const required of ["官方", "备用提醒", "AI", "备份", "自动联网", "费用", "API Key", "依法不得免除", "不代表授权所有联网功能"]) {
  assert.ok(flatten(content).includes(required), required);
}
const entry = SETTINGS_SEARCH_ENTRIES.find((x) => x.title === "使用说明与免责声明");
assert.equal(entry.section, "about");
assert.ok(entry.keywords.includes("隐私"));
assert.ok(read("../src/views/aboutCard.js").includes('sectionTitle("使用说明与免责声明"), createDisclaimerContent()'));
const css = read("../src/styles.css");
assert.match(css, /\.disclaimer-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
assert.match(css, /\.disclaimer-dialog[^}]*\.app-dialog-actions\s*\{\s*flex-shrink:\s*0/);
assert.match(css, /\.disclaimer-dialog \.app-dialog-btn\s*\{[^}]*min-height:\s*44px/);
console.log("PASS: disclaimer versioning, concurrency, cancellation, storage fallback, readable sections, search and legal boundaries");
