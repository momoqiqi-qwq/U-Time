import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/* 版本号一致性。
   tools/sync-version.js 管三端，但**它不管 package-lock.json** —— 仓库根 AGENTS.md 里
   专门写了这条：实测这份文件曾长期停在 0.11.2 而 package.json 已经到 0.11.6。
   这轮又踩了一次同族的坑：改 0.172.1 → 0.173.1 时用字符串替换（只命中第一处），
   package-lock 的 `packages[""].version` 被落在 0.172.1，而顶层 version 已经是新的 ——
   两份字段各说各话，npm ci 与「看起来的版本」会不一致。
   所以这里把它钉死：**四处 lock 字段 + 三端产物**任何一个掉队就报红。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json"));
const lock = JSON.parse(read("../package-lock.json"));

assert.match(pkg.version, /^\d+\.\d+\.\d+$/,
  "版本号必须是严格三段式 X.Y.Z —— 两段式（0.12）会让 sync-version.js 的正则失配");
assert.ok(lock.packages && lock.packages[""], 'package-lock.json 必须有 packages[""] 段');
assert.equal(lock.version, pkg.version, "package-lock.json 顶层 version 必须与 package.json 一致");
assert.equal(lock.packages[""].version, pkg.version,
  'package-lock.json 的 packages[""].version 必须与 package.json 一致 —— 脚本不管这处，最容易漏');
assert.equal(lock.packages[""].name, pkg.name, "lock 里的包名也要对得上");

// 三端产物：sync-version.js 会写，但测试要能独立发现「脚本根本没跑」
const cargo = read("../src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m);
assert.equal(cargo && cargo[1], pkg.version, "src-tauri/Cargo.toml 的 version 要跟上");
assert.equal(JSON.parse(read("../src-tauri/tauri.conf.json")).version, pkg.version,
  "tauri.conf.json 的 version 要跟上（Tauri 2 运行时以 Cargo.toml 为准，但这个字段确实存在且会被脚本改写）");
const appMeta = read("../../miniprogram/core/appMeta.js").match(/version:\s*"([^"]+)"/);
assert.equal(appMeta && appMeta[1], pkg.version, "小程序 core/appMeta.js 的 version 要跟上");

// Android 的 versionCode 由版本号算出，不许手改：major*10000 + minor*100 + patch
const [maj, min, pat] = pkg.version.split(".").map(Number);
const propsPath = new URL("../src-tauri/gen/android/app/tauri.properties", import.meta.url);
if (existsSync(propsPath)) {
  const props = readFileSync(propsPath, "utf8");
  assert.equal((props.match(/versionName=([^\r\n]+)/) || [])[1]?.trim(), pkg.version,
    "Android versionName 要跟上");
  assert.equal((props.match(/versionCode=(\d+)/) || [])[1], String(maj * 10000 + min * 100 + pat),
    "Android versionCode 必须由版本号算出（手改会和 versionName 对不上，装到手机上会被系统拒升级）");
} else {
  // gen/ 是 gitignored，新克隆的树上不存在 —— 缺了不算错，但不能假装验过
  console.log("（src-tauri/gen/android 不存在，跳过 versionName / versionCode 校验）");
}

console.log("PASS: 版本号一致性（package.json / package-lock 两处 / Cargo.toml / tauri.conf.json / appMeta / Android versionName+versionCode）");
