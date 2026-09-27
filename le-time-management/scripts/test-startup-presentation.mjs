import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const main = read("src/main.js");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
const interactions = read("src/styles/interactions.css");

assert.equal(config.app.windows[0].visible, false, "Tauri window should stay hidden until startup setup completes");
assert.ok(main.indexOf('dataset.appStarting = "true"') < main.indexOf("await applyWindowSize("), "startup gate must be active before window sizing");
assert.ok(main.indexOf("await applyWindowSize(") < main.indexOf("renderShell("), "saved window size must be applied before the first render");
assert.ok(main.indexOf("renderShell(") < main.indexOf("await revealAppWindow()"), "window must only be revealed after the shell exists");
assert.ok(capability.permissions.includes("core:window:allow-show"), "Tauri capability must allow revealing the startup window");
assert.match(interactions, /motion-app-start-enter/);
assert.match(interactions, /input\[type="range"\]:active::-(?:webkit-slider-thumb|moz-range-thumb)/);

console.log("PASS: startup is sized before reveal; shell and range motion hooks are present");
