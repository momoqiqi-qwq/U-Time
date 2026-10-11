#!/usr/bin/env bash
# 一键构建并归档 U-Time 指定版本的全部产物（Windows 三件 + APK + SHA256SUMS.txt）。
#
# 用途：本机 WorkBuddy 沙箱禁止「孙进程」spawn 与写文件（见项目记忆 2026-10-09），
#       cargo 必须 spawn build-script 子进程 ⇒ 沙箱内**永远编不出来**。
#       请在**真实终端**（资源管理器里打开 Git Bash / Windows Terminal）运行本脚本。
#
# 用法：
#   bash tools/build-and-archive.sh              # 构建当前 package.json 的版本
#   bash tools/build-and-archive.sh 0.174.1      # 构建指定版本（需工作树/HEAD 已是该版本）
#
# 前置：工作树的 le-time-management/package.json 版本 == 目标版本，
#       且 git status 对本项目源码干净（避免把并行会话的半成品编进产物）。
set -euo pipefail

cd "$(dirname "$0")/.."                      # → 工作区根
ROOT="$(pwd)"
LM="$ROOT/le-time-management"
REL="$ROOT/releases"

VER="${1:-$(grep -oP '"version"\s*:\s*"\K[0-9.]+' "$LM/package.json" | head -1)}"
echo "==== 目标版本：v$VER ===="

# ---------- 0. 前置校验 ----------
cd "$LM"
node ../tools/sync-version.js --check || { echo "✗ 三端版本不一致，先修"; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no -- src public src-tauri miniprogram)" ]; then
  echo "⚠️  本项目源码有未提交改动 —— 产物会掺入半成品。确认无误再继续。"
  read -r -p "继续？(y/N) " a; [ "$a" = "y" ] || exit 1
fi

OUT="$REL/v$VER"
mkdir -p "$OUT"

# ---------- 1. 清 dist（每次都清；safe-delete 会拦 rm，用 mv）----------
if [ -d dist ]; then
  mv dist "$ROOT/.workbuddy-ai/tmp/dist-before-v$VER-$(date +%s)" 2>/dev/null \
    || mv dist "$HOME/wb-dist-backup-$(date +%s)"
fi

# ---------- 2. Windows：编译一次 + 打包 ----------
echo "==== [1/3] Windows --no-bundle（拿干净 portable）===="
bash build-windows.sh --no-bundle
cp src-tauri/target/release/letime.exe "$OUT/UTime-$VER-x64-portable.exe"
echo "  ✓ portable 已保存（在 bundling 打标记之前）"

echo "==== [2/3] Windows 安装包（nsis + msi）===="
sed 's|^npm run tauri -- build "\$@"|npm run tauri -- bundle "$@"|' build-windows.sh \
  > "$ROOT/.workbuddy-ai/tmp/bundle-windows.sh"
bash "$ROOT/.workbuddy-ai/tmp/bundle-windows.sh" --bundles nsis,msi

# nsis/ 与 msi/ 是历版共用的输出目录，堆着几十个旧版本产物：
# 直接 glob 会多匹配，cp 把目标当目录，报 "cp: target '...' is not a directory" 并中断。
# 所以按版本精确挑，且要求恰好一个匹配 —— 不匹配宁可失败，也不能错发别人的产物。
pick_one() {
  local label="$1"; shift
  local matches=() m
  for m in "$@"; do [ -f "$m" ] && matches+=("$m"); done
  if [ "${#matches[@]}" != "1" ]; then
    echo "  ✗ $label：期望恰好 1 个产物，实际 ${#matches[@]} 个（${matches[*]:-无}）" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}
NSIS_BIN="$(pick_one 'NSIS 安装包' src-tauri/target/release/bundle/nsis/*_"$VER"_x64-setup.exe)"
MSI_BIN="$(pick_one 'MSI 安装包' src-tauri/target/release/bundle/msi/*_"$VER"_x64_zh-CN.msi)"
cp "$NSIS_BIN" "$OUT/UTime-$VER-x64-setup.exe"
cp "$MSI_BIN"  "$OUT/UTime-$VER-x64-zh-CN.msi"

# ---------- 3. Android ----------
echo "==== [3/3] Android APK（两个 ABI）===="
mv dist "$ROOT/.workbuddy-ai/tmp/dist-win-v$VER-$(date +%s)" 2>/dev/null || true
bash scripts/build-android-apk.sh all
cp src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
   "$OUT/UTime-$VER-universal.apk"

# ---------- 3.5 清掉 MOTW（网络来源标记）----------
# 产物只要经过一次浏览器/网盘/GitHub 下载就会被写上 Zone.Identifier，双击时 Windows 弹
# 「打开文件 - 安全警告：无法验证发布者。你确定要运行此软件吗？」。归集后立刻清掉，
# 本机双击不再弹；只删附加数据流，文件内容与 SHA256 不变（下面 4 的摘要照旧）。
echo "==== 清除 MOTW（Zone.Identifier）===="
OUTW="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
  "Get-ChildItem -LiteralPath '$OUTW' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" \
  && echo "  ✓ MOTW 已清除（$OUTW）"
echo "  提示：全局关掉该弹窗（含浏览器/网盘下载的安装包）跑一次 tools/no-security-warning.ps1"

# ---------- 4. 校验 + 摘要 ----------
echo "==== 校验产物版本 ===="
# 用 node 而不是 python：本机只装了 `py`（`python` 不在 PATH），原写法在这里必挂。
# 两个 exe 的版本串按 UTF-16LE 存在；MSI 把版本放在 CFB 属性流里、APK 在压缩过的
# AndroidManifest 里，裸字节都数不到，所以只校验 exe 两件（与历版一致）。
node -e '
const fs = require("fs");
const [ver, ...files] = process.argv.slice(1);
const needle = Buffer.from(ver, "utf16le");
let ok = true;
for (const p of files) {
  const buf = fs.readFileSync(p);
  let n = 0, at = -1;
  while ((at = buf.indexOf(needle, at + 1)) !== -1) n++;
  console.log("  " + p.split(/[\\/]/).pop() + ": " + ver + " u16=" + n);
  if (n === 0) ok = false;
}
process.exit(ok ? 0 : 1);
' "$VER" "$OUT/UTime-$VER-x64-portable.exe" "$OUT/UTime-$VER-x64-setup.exe" \
  || { echo "✗ 产物版本不符，别发布"; exit 1; }

cd "$OUT"
sha256sum UTime-$VER-* > SHA256SUMS.txt
echo ""
echo "==== 完成 ===="
ls -la "$OUT"
echo ""
echo "下一步（各版本独立 Release，最新版带 --latest，旧版加 --latest=false）："
echo "  gh release create v$VER --repo momoqiqi-qwq/U-Time --title \"U-Time v$VER\" \\"
echo "     --notes-file .workbuddy-ai/tmp/release-notes-$VER.md --latest \\"
echo "     $OUT/UTime-$VER-* $OUT/SHA256SUMS.txt"
echo "  发布后核对（curl 走 github.com，本机没配代理时记得带上 HTTP(S)_PROXY）："
echo "  cd $LM && npm run check:update-release:full"
