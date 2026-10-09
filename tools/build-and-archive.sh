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
cp src-tauri/target/release/bundle/nsis/*_x64-setup.exe "$OUT/UTime-$VER-x64-setup.exe"
cp src-tauri/target/release/bundle/msi/*_x64_zh-CN.msi  "$OUT/UTime-$VER-x64-zh-CN.msi"

# ---------- 3. Android ----------
echo "==== [3/3] Android APK（两个 ABI）===="
mv dist "$ROOT/.workbuddy-ai/tmp/dist-win-v$VER-$(date +%s)" 2>/dev/null || true
bash scripts/build-android-apk.sh all
cp src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
   "$OUT/UTime-$VER-universal.apk"

# ---------- 4. 校验 + 摘要 ----------
echo "==== 校验产物版本 ===="
python -c "
import sys
ok=True
for v in ['$VER']:
    for p in ['$OUT/UTime-$VER-x64-portable.exe','$OUT/UTime-$VER-x64-setup.exe']:
        d=open(p,'rb').read()
        n=d.count(v.encode('utf-16-le'))
        print(f'  {p.split(chr(47))[-1]}: {v} u16={n}')
        if n==0: ok=False
sys.exit(0 if ok else 1)
" || { echo "✗ 产物版本不符，别发布"; exit 1; }

cd "$OUT"
sha256sum UTime-$VER-* > SHA256SUMS.txt
echo ""
echo "==== 完成 ===="
ls -la "$OUT"
echo ""
echo "下一步（各版本独立 Release，最新版带 --latest，旧版加 --latest=false）："
echo "  gh release create v$VER --repo momoqiqi-qwq/U-Time --title \"U-Time v$VER\" \\"
echo "     --notes-file .workbuddy-ai/tmp/release-notes-$VER.md $OUT/UTime-$VER-*"
