import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rust = fs.readFileSync(path.join(here, "../src-tauri/src/lib.rs"), "utf8");
const source = rust.match(/const INTERNAL_BROWSER_BOOTSTRAP: &str = r#"([\s\S]*?)"#;/)?.[1];
const bootstrap = source || "";

assert.ok(source, "the isolated browser bootstrap must exist");
assert.doesNotThrow(() => new Function(bootstrap), "injected browser code must remain valid JavaScript");
assert.match(bootstrap, /if \(window\.top === window\)/, "visible toolbox must only mount in the top-level page");
assert.match(bootstrap, /attachShadow\(\{ mode: "open" \}\)/, "toolbox UI should be isolated from third-party website styles");
assert.match(bootstrap, /role="toolbar" aria-label="网页工具箱"/, "sidebar should be discoverable as an accessible toolbar");
assert.match(bootstrap, /addButton\("refresh", "刷新网页"[\s\S]*?location\.reload\(\)/, "refresh must be present and reload the current webview");
assert.ok(bootstrap.indexOf('addButton("refresh"') < bootstrap.indexOf('addButton("back"'), "refresh should be the first and always-visible action");
assert.match(bootstrap, /history\.back\(\)/);
assert.match(bootstrap, /history\.forward\(\)/);
assert.match(bootstrap, /__utime_browser_favorites_v1[\s\S]*查看收藏/, "favorites should be savable and reopenable");
assert.match(bootstrap, /navigator\.clipboard\.writeText\(location\.href\)/, "copy-address tool should be wired");
assert.match(bootstrap, /缩小网页[\s\S]*Math\.max\(\.75[\s\S]*放大网页[\s\S]*Math\.min\(1\.5/, "page zoom controls should stay within safe bounds");
assert.match(bootstrap, /prefers-reduced-motion: reduce/, "toolbox feedback should honor reduced motion");
assert.match(rust, /\.initialization_script_for_all_frames\(INTERNAL_BROWSER_BOOTSTRAP\)/, "the toolbox must be installed in regular and session-cookie browser windows");

console.log("PASS: internal browser toolbox (refresh / back-forward / favorites / copy URL / zoom / top-frame isolation)");
