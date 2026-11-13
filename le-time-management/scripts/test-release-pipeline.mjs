import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const root = mkdtempSync(join(tmpdir(), "utime-release-test-"));
const put = (name, text) => {
  const path = join(root, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode: 0o755 });
};
const run = (version = "0.302.0") => spawnSync(bash, ["-c",
  `export PATH="$(pwd)/mock-bin:$PATH"; bash tools/build-and-archive.sh ${version}`,
], { cwd: root, encoding: "utf8", timeout: 30000 });
try {
  put("tools/build-and-archive.sh", readFileSync(new URL("../../tools/build-and-archive.sh", import.meta.url), "utf8"));
  put("le-time-management/package.json", '{"version":"0.302.0"}');
  put("tools/sync-version.js", 'console.log("version check");');
  put("tools/sync-android-native.js", 'console.log("native check");');
  put("mock-bin/git", "#!/usr/bin/env bash\nexit 0\n");
  put("mock-bin/powershell.exe", '#!/usr/bin/env bash\nprintf "powershell %s\\n" "$*" >> "$PIPELINE_LOG"\n');
  put("mock-bin/npm", `#!/usr/bin/env bash
set -eu
echo "npm $*" >> "$PIPELINE_LOG"
case "$*" in
  'run tauri -- build --no-bundle')
    mkdir -p src-tauri/target/release dist
    node -e 'require("fs").writeFileSync("src-tauri/target/release/letime.exe", Buffer.from("0.302.0", "utf16le"))' ;;
  'run tauri -- bundle --bundles nsis')
    mkdir -p src-tauri/target/release/bundle/nsis
    cp src-tauri/target/release/letime.exe src-tauri/target/release/bundle/nsis/U-Time_0.302.0_x64-setup.exe ;;
  *) echo "unexpected build: $*" >&2; exit 2 ;;
esac
`);
  put("le-time-management/build-windows.sh", '#!/usr/bin/env bash\nset -e\nnpm run tauri -- build "$@"\n');
  put("le-time-management/scripts/build-android-apk.sh", `#!/usr/bin/env bash
set -eu
[ "$1" = all ]
[ ! -d dist ]
echo android >> "$PIPELINE_LOG"
mkdir -p src-tauri/gen/android/app/build/outputs/apk/universal/release
printf apk > src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
`);
  const logPath = join(root, "pipeline.log");
  const oldLog = process.env.PIPELINE_LOG;
  process.env.PIPELINE_LOG = logPath;
  let result;
  try { result = run(); }
  finally { if (oldLog === undefined) delete process.env.PIPELINE_LOG; else process.env.PIPELINE_LOG = oldLog; }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  assert.match(log[0], /build --no-bundle$/);
  assert.match(log[1], /update-local-app\.ps1.*-Version 0\.302\.0 -Restart$/,
    "便携版生成后必须立即更新并重启本机运行版");
  assert.match(log[2], /bundle --bundles nsis$/, "不应请求超过 WiX 版本上限的 MSI");
  assert.equal(log[3], "android", "Windows 完成后串行构建 Android");
  const stage = join(root, ".workbuddy-ai/tmp/release-v0.302.0");
  const sums = readFileSync(join(stage, "SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/);
  assert.equal(sums.length, 3);
  for (const suffix of ["0.302.0-x64-portable.exe", "0.302.0-x64-setup.exe", "v0.302.0-universal.apk"]) {
    assert.ok(existsSync(join(stage, `UTime-${suffix}`)));
    assert.ok(sums.some((line) => line.endsWith(`UTime-${suffix}`)));
  }
  const mismatch = run("0.301.1");
  assert.notEqual(mismatch.status, 0, "指定版本与源码不一致必须拒绝构建");
  assert.match(mismatch.stderr, /不一致/);
  console.log("PASS: 发布流水线串行产出三件同版资产、立即更新运行版、完整 SHA256 和版本不符拦截");
} finally {
  assert.ok(root.startsWith(join(tmpdir(), "utime-release-test-")));
  rmSync(root, { recursive: true, force: true });
}
