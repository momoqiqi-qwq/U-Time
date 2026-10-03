// 把小程序独立检查接入常规 npm test，避免长期游离于桌面回归之外。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
for (const script of [
  "tools/sync-miniprogram-models.js",
  "tools/test-miniprogram-core.js",
  "miniprogram/tools/test-miniprogram-core.js",
  "miniprogram/tools/test-parity.js",
  "miniprogram/tools/check-miniprogram.js",
]) {
  const args = [script, ...(script.includes("sync-miniprogram-models") ? ["--check"] : [])];
  const result = spawnSync(process.execPath, args, { cwd:root, encoding:"utf8", timeout:60000 });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("PASS: miniprogram shared models, core data, native adapters, page controllers and static integration");
