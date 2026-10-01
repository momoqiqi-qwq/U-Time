import assert from "node:assert/strict";
import fs from "node:fs";
const rust = fs.readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const script = rust.match(/const INTERNAL_BROWSER_BOOTSTRAP: &str = r#"([\s\S]*?)"#;/)[1];
const seed = script.slice(script.indexOf('      const key = "__utime_browser_favorites_v1";'), script.indexOf('      const favorite ='));
const data = new Map([["__utime_browser_favorites_v1", JSON.stringify([{ title: "原有收藏", url: "https://example.com/" }])]]);
const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
const initialize = new Function("localStorage", seed);
initialize(storage); initialize(storage);
let rows = JSON.parse(storage.getItem("__utime_browser_favorites_v1"));
assert.deepEqual(rows.map((row) => row.title), ["原有收藏", "选课", "我的学分"]);
assert.equal(new URL(rows[1].url).search, "");
assert.equal(new URLSearchParams(new URL(rows[1].url).hash.slice(1)).get("utime-menu"), "37mz91XBnBIljahBQSs");
storage.setItem("__utime_browser_favorites_v1", JSON.stringify(rows.filter((row) => row.title !== "选课")));
initialize(storage);
assert.equal(JSON.parse(storage.getItem("__utime_browser_favorites_v1")).length, 2, "removed defaults must not return");

const jump = script.slice(script.indexOf('  if (location.hostname === "jw.cppu.edu.cn")'), script.indexOf("  const toHttpUrl"));
const pending = new Map(), opened = [];
let callback, cleared = false;
new Function("location", "sessionStorage", "window", "setInterval", "clearInterval", jump)(
  new URL(rows[2].url), { getItem: (key) => pending.get(key), setItem: (key, value) => pending.set(key, value), removeItem: (key) => pending.delete(key) },
  { JE: { _MENUS: { target: { id: "RMX4lNNDjXaz3b2oz8B" } }, openFuncById: (id) => opened.push(id) } },
  (fn) => { callback = fn; return 1; }, () => { cleared = true; });
callback();
assert.deepEqual(opened, ["RMX4lNNDjXaz3b2oz8B"]);
assert.ok(cleared); assert.equal(pending.size, 0);
console.log("PASS: default bookmarks preserve existing entries, seed once, respect removal and open validated JE menu after login");
