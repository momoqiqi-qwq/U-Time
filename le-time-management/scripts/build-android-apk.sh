#!/usr/bin/env bash
# U-Time Android APK 构建流水线（绕开两个 Windows 中文路径坑）：
#  1) tauri CLI 强制用 NDK 的 .cmd 链接器包装脚本，cmd.exe 有 8191 字符上限，
#     依赖一多链接命令行超长即损坏 → 直接用 clang.exe + --target 参数；
#  2) tauri CLI 会覆盖 CARGO_TARGET_*_LINKER/RUSTFLAGS 环境变量 → 不经过 tauri CLI，
#     手动 cargo 构建 .so，再让 gradle 直接打包签名（assets 已嵌入 Rust 库）。
#
# 用法: scripts/build-android-apk.sh [aarch64|x86_64|armv7|i686|all]   (默认 all=aarch64+x86_64)
set -e

TARGETS=${1:-all}
[ "$TARGETS" = "all" ] && TARGETS="aarch64 x86_64"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NDKBIN="D:/Environment/android-sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/windows-x86_64/bin"
# JDK 路径交给环境变量（各人安装位置不同，不把某台机器的用户目录写进仓库）。
export JAVA_HOME="${JAVA_HOME:-${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/Eclipse Adoptium/jdk-21.0.10.7-hotspot}"
export ANDROID_HOME="D:/Environment/android-sdk"
export NDK_HOME="D:/Environment/android-sdk/ndk/27.0.12077973"
export ANDROID_NDK_ROOT="$NDK_HOME"   # cc-rs（ring 等 C 依赖）认这个
# NDK 工具链在 Windows 上打开中文路径会编码损坏（lld 无法读取 .o/.rlib），
# 所以 cargo 的 target 目录必须放纯 ASCII 路径；首次构建会全量重编依赖
TARGET_DIR="D:/Environment/android-target"

# 注入 MSVC 环境，避免 Git Bash /usr/bin/link 遮蔽 MSVC link.exe
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    MSVC=$(ls -d "/c/Program Files/Microsoft Visual Studio/"*/Community/VC/Tools/MSVC/*/ 2>/dev/null | sort -V | tail -1)
    MSVC="${MSVC%/}"
    if [ -d "$MSVC/bin/Hostx64/x64" ]; then
      export PATH="$MSVC/bin/Hostx64/x64:$HOME/.cargo/bin:$JAVA_HOME/bin:$PATH"
      SDK="/c/Program Files (x86)/Windows Kits/10"
      SDK_VER=$(ls "$SDK/Include" 2>/dev/null | sort -V | tail -1)
      win() { printf '%s' "$1" | sed -e 's|^/\([a-z]\)/|\1:\\|' -e 's|/|\\|g'; }
      export INCLUDE="$(win "$MSVC")\\include;$(win "$SDK")\\Include\\$SDK_VER\\ucrt;$(win "$SDK")\\Include\\$SDK_VER\\shared;$(win "$SDK")\\Include\\$SDK_VER\\um;$(win "$SDK")\\Include\\$SDK_VER\\winrt;$(win "$SDK")\\Include\\$SDK_VER\\cppwinrt"
      export LIB="$(win "$MSVC")\\lib\\x64;$(win "$SDK")\\Lib\\$SDK_VER\\ucrt\\x64;$(win "$SDK")\\Lib\\$SDK_VER\\um\\x64"
    else
      export PATH="$HOME/.cargo/bin:$JAVA_HOME/bin:$PATH"
    fi
    ;;
  *)
    export PATH="$HOME/.cargo/bin:$JAVA_HOME/bin:$PATH"
    ;;
esac

# ⓪ 把版本化的 Android 原生代码同步进 gen/android，并补齐只能靠补丁生效的声明
#    手机端真正干活的 Kotlin（安全区注入 / 返回键 / 双指缩放 / 教务窗口 / APK 安装桥）只存在于
#    **gitignored 的 src-tauri/gen/android 里**，重新 `tauri android init` 会把它整个重建、全部丢失。
#    事实源是版本化的镜像 android/gradle/，这里构建前先同步一次（set -e：同步失败直接中止，
#    宁可不出包也不要出一个缺原生桥的包）。同一个脚本还幂等处理三件事：
#      · AndroidManifest 补 REQUEST_INSTALL_PACKAGES（应用内升级要拉起系统安装器）
#      · 去掉 MainActivity 的 label（activity 级 label 会盖掉 app_name，桌面图标名变成
#        「U-Time · 时间块与四象限」被截断；教务窗口的 label 是有意保留的，只按 android:name 精确删）
#      · res/xml/file_paths.xml 补 <cache-path>（更新包暂存在 app_cache_dir，要给 FileProvider 共享）
#    细节与坑见 tools/sync-android-native.js 顶部注释。
#    🔴 用相对路径，不要写 "$ROOT/../tools/..."：上面 `cd "$ROOT"` 之后就在仓库根，
#    而 ROOT 是 Git Bash 的 POSIX 形态（/e/E-Develop-Project/...），Node 在 Windows 上
#    解析不了它 —— 前导 `/` 被当成盘根，`/e/E-...` 会变成 `E:\e\E-...` 报 MODULE_NOT_FOUND。
node "../tools/sync-android-native.js"

# ① 前端构建（资产会被 Rust 库通过 custom-protocol 嵌入）
#
# 🔴 构建前**必须**先把 dist 移走，否则这一步会挂。
#    原注释写「vite emptyOutDir 已设为 false」是**错的**：vite.config.js 里根本没设它，
#    而 outDir 在项目根内时默认就是 true ⇒ vite 每次都先 `emptyDir(dist)`。
#    dist/plugins 有 79 个文件，超过 safe-delete 的 50 条批量删除阈值，于是：
#      [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":79,"threshold":50,...}
#    实测（2026-09-16）：`mv dist ../.workbuddy-ai/tmp/dist-old-$(date +%s)` 移走即可。
#    ⚠️ 移走前先停 dev server —— `vite dev` 持有 dist 的**目录句柄**，不停会 `Permission denied`
#    （同目录改名也失败，但普通目录改名 / dist 内部单文件改名都正常，别误判成 safe-delete 拦截）。
npx vite build

# ② 逐目标交叉编译 .so
for t in $TARGETS; do
  case $t in
    aarch64) triple=aarch64-linux-android;    api=24 ;;
    x86_64)  triple=x86_64-linux-android;     api=24 ;;
    armv7)   triple=armv7-linux-androideabi;  api=24 ;;
    i686)    triple=i686-linux-android;       api=24 ;;
    *) echo "未知目标: $t"; exit 1 ;;
  esac
  abi=$t; [ "$t" = "aarch64" ] && abi=arm64-v8a; [ "$t" = "armv7" ] && abi=armeabi-v7a
  key=$(echo "$triple" | tr 'a-z-' 'A-Z_')   # CARGO_TARGET_* 环境变量名用下划线
  echo "── cargo build $triple ──"
  (cd src-tauri && env "CARGO_TARGET_${key}_LINKER=$NDKBIN/clang.exe" \
      "CARGO_TARGET_${key}_RUSTFLAGS=-Clink-arg=--target=$triple$api -Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES" \
      "CC_$triple=$NDKBIN/clang.exe" "AR_$triple=$NDKBIN/llvm-ar.exe" \
      "CFLAGS_$triple=--target=$triple$api" \
    cargo build --lib --release --target "$triple" --features tauri/custom-protocol --target-dir "$TARGET_DIR")
  mkdir -p "src-tauri/gen/android/app/src/main/jniLibs/$abi"
  cp -f "$TARGET_DIR/$triple/release/libletime_lib.so" \
        "src-tauri/gen/android/app/src/main/jniLibs/$abi/libletime_lib.so"
  echo "── 已放入 jniLibs/$abi ──"
done

# 原版课表构建使用它的 AGP/Kotlin 工具链，同时把两套 Activity 放入同一 APK。
if [ "${TIDE_NATIVE_SCHEDULE:-0}" = "1" ]; then
  # 同样用相对路径：$ROOT 是 Git Bash 的 POSIX 形态，pwsh 也解析不了（详见上面 sync-android-native 那段）
  pwsh.exe -NoProfile -File "../tools/build-native-android.ps1" -Configuration Release
  exit $?
fi

# ③ gradle 打包 + 签名（universal 变体包含 jniLibs 里现存的全部 ABI）
#    -x 排除 rust 任务：.so 已手动放好，避免 gradle 再走一遍坏链路
cd src-tauri/gen/android
./gradlew.bat --no-daemon :app:assembleUniversalRelease \
  -x rustBuildUniversalRelease -x rustBuildArm64Release -x rustBuildX86_64Release
echo "APK: $ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
