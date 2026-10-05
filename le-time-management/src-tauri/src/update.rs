//! 应用内自动更新（v0.38.0）。
//!
//! ## 为什么不用 tauri-plugin-updater
//!
//! 官方插件要求更新包带**签名**（`tauri signer generate` 出的私钥 + 公钥内嵌），
//! 每次发版都要拿私钥签一遍，而且密钥丢了就没法再发更新。本项目的发布流程是
//! 「构建脚本手工归集产物 → 传到 GitHub Releases」，刻意不加这道密钥工序，
//! 所以走自建：`reqwest` 打 GitHub Releases API（`reqwest` 本来就是依赖，零新增）。
//!
//! ## 三段式，互相不耦合
//!
//! 1. [`update_check`]    —— 查 `releases/latest`，比版本号，挑出本平台该装哪个产物。
//! 2. [`update_download`] —— 流式下到应用缓存目录，边下边发 `update:progress`，下完校验大小与 SHA-256。
//! 3. [`update_install`]  —— 交给系统安装：Windows 静默重装（NSIS `/S /R`，装完自启）；
//!    Android 经 [`ApkInstallerPlugin`] 用 FileProvider 发 `content://` 给系统安装器。
//!
//! 前端把这三步串起来，并在启动时静默跑第 1 步（见 `src/updateChecker.js`）。
//!
//! ## 两条容易踩空的约束
//!
//! - **平台产物命名**：GitHub Release 里必须同时有 `UTime-<版本>-x64-setup.exe` 与
//!   `UTime-<版本>-universal.apk`（历史版本仍是 `LeTime-` 前缀，
//!   匹配逻辑只看扩展名 + 关键词 + 版本子串，不依赖品牌前缀），否则对应端会退化成「只能去仓库手动下载」。
//!   匹配规则见 [`asset_score`]，两个平台各按「精确后缀 + 关键词」打分。
//! - **Android 落盘位置**：必须用 `app_cache_dir()`（＝`Context.getCacheDir()`，内部缓存），
//!   因为 `res/xml/file_paths.xml` 只声明了 `<cache-path>`。用 `cache_dir()` 会落到
//!   `getExternalCacheDir`，FileProvider 不认 → 安装器打不开。见 `ApkInstallerPlugin.kt`。
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 发布源：公开仓库的 latest release。
const RELEASES_API: &str =
    "https://api.github.com/repos/momoqiqi-qwq/U-Time/releases/latest";

/// 下载体积上限。APK 约 21MB、安装包约 4MB，512MB 足够宽松，
/// 又能在「上游填错 asset.size / 被中间人塞了超大文件」时保住磁盘。
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

/// 版本说明最多回传这么多字符（release body 可能很长，没必要整段塞进事件总线）。
const MAX_NOTES_CHARS: usize = 2000;

/* ───────────────────────── Android 安装桥 ───────────────────────── */

/// 承载 `ApkInstallerPlugin` 的句柄。只在 Android 上存在。
#[cfg(target_os = "android")]
struct AndroidUpdater<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// 注册 Android 侧的原生安装插件（与 `native_schedule::init` 同款写法）。
///
/// 不注册的话：手机上下载完 APK 之后没有任何办法把它交给系统安装器 ——
/// `tauri-plugin-opener` 对 `file://` 既不经 FileProvider 也不授予读权限，
/// Android 7.0 起直接抛 `FileUriExposedException`。
#[cfg(target_os = "android")]
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("letime-update")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.yile.letime", "ApkInstallerPlugin")?;
            app.manage(AndroidUpdater(handle));
            Ok(())
        })
        .build()
}

/* ───────────────────────── 纯逻辑（可单测） ───────────────────────── */

/// 解析三段式版本号，容忍 `v` 前缀与 `-beta.1` / `+build` 后缀。
///
/// 只比较 `major.minor.patch`：预发布后缀不参与排序（本项目至今没发过预发布版），
/// 拿到 `v0.38.0-rc1` 时按 `0.38.0` 处理 —— 宁可提示更新，也不要把用户卡在旧版。
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let text = raw.trim().trim_start_matches(['v', 'V']);
    let core = text.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next().unwrap_or("0").trim().parse().ok()?;
    let patch = parts.next().unwrap_or("0").trim().parse().ok()?;
    Some((major, minor, patch))
}

/// 本平台该装哪类产物。用 `cfg!` 而不是 `#[cfg]` 是为了让三条分支都参与编译，
/// 改错匹配规则时编译器能立刻报出来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetKind {
    /// Windows：NSIS 安装包（能静默覆盖安装并自启）。
    SetupExe,
    /// Android：通用 APK。
    Apk,
    /// 其它平台：本项目只发 Windows 与 Android 产物。
    Unsupported,
}

fn asset_kind() -> AssetKind {
    if cfg!(target_os = "windows") {
        AssetKind::SetupExe
    } else if cfg!(target_os = "android") {
        AssetKind::Apk
    } else {
        AssetKind::Unsupported
    }
}

/// 给 release 里的某个 asset 打分，`None` ＝ 这个平台上用不了。
///
/// 打分而不是「取第一个匹配」的原因：release 里同时挂着
/// `-setup.exe` / `-portable.exe` / `-x64-zh-CN.msi` / `-universal.apk`，
/// 而 portable 与 msi 都没法做「静默原地升级」。
///
/// 分值构成：
/// - 前置条件：文件名必须带**目标版本号**，否则拒绝自动安装；
/// - 基础 +3：精确后缀 + 首选关键词（Windows `setup` / Android `universal`）；
/// - 基础 +1：仅后缀匹配（Windows 退而求其次的 msi / Android 的普通 apk）；
/// - 版本号满足前置条件后额外 +4。
///
/// 版本判断用子串匹配（`0.38.0` 出现在名字里），不限制品牌前缀或分隔符，
/// 所以 `UTime-0.38.0-...` 与 `LeTime_v0.38.0_...` 都能匹配。
fn asset_score(name: &str, kind: AssetKind, latest: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    // Release 若误挂了旧版本产物，宁可禁用自动安装，也不能让用户装完仍是旧版、
    // 每次启动继续提示同一个更新。品牌前缀和分隔符仍不限制，只要求版本号出现。
    if !latest.is_empty() && !lower.contains(&latest.to_ascii_lowercase()) {
        return None;
    }
    let base = match kind {
        AssetKind::SetupExe => {
            if lower.ends_with(".exe") && lower.contains("setup") {
                3
            } else if lower.ends_with(".msi") {
                1
            } else {
                return None;
            }
        }
        AssetKind::Apk => {
            if lower.ends_with(".apk") && lower.contains("universal") {
                3
            } else if lower.ends_with(".apk") {
                1
            } else {
                return None;
            }
        }
        AssetKind::Unsupported => return None,
    };
    Some(base + if latest.is_empty() { 0 } else { 4 })
}

/// 从 release 的 assets 里挑出唯一要用的那个：**最高分，同分取先出现的**。
///
/// 显式写循环而不是 `max_by_key`：`Iterator::max_by_key` 在并列时返回的是**最后一**个，
/// 与本函数承诺的「先出现的优先」相反。这里靠 `>`（而非 `>=`）把「取先出现」钉死，
/// 免得改天有人按注释去推理行为却被标准库的细节坑到。
fn pick_asset<'a>(
    assets: &'a [(String, String, u64)],
    kind: AssetKind,
    latest: &str,
) -> Option<&'a (String, String, u64)> {
    let mut best: Option<(u32, &'a (String, String, u64))> = None;
    for asset in assets {
        let Some(score) = asset_score(&asset.0, kind, latest) else {
            continue;
        };
        if best.is_none_or(|(current, _)| score > current) {
            best = Some((score, asset));
        }
    }
    best.map(|(_, asset)| asset)
}

/// 把远端的 asset 名规整成可以安全落盘的纯文件名。
///
/// 要求「规整结果与原名完全一致」而不是「截取最后一段」：调用方传的是
/// GitHub API 给的 asset 名，正常就是一个裸文件名。一旦出现分隔符，
/// 说明这条数据不可信（或被改了），直接拒绝比「截断后照写」安全。
fn safe_file_name(name: &str, required_ext: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 200 {
        return Err("更新包文件名长度不合法".into());
    }
    if name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("更新包文件名含路径分隔符，已拒绝".into());
    }
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("更新包文件名不合法")?;
    if base != name {
        return Err("更新包文件名不合法".into());
    }
    if !base.to_ascii_lowercase().ends_with(required_ext) {
        return Err(format!("更新包扩展名必须是 {required_ext}"));
    }
    Ok(base.to_string())
}

/// 本平台更新包的扩展名。
fn required_ext() -> &'static str {
    match asset_kind() {
        AssetKind::SetupExe => ".exe",
        AssetKind::Apk => ".apk",
        AssetKind::Unsupported => "",
    }
}

/// 只允许从 GitHub 下载。`browser_download_url` 是 `github.com/.../releases/download/...`，
/// 由 reqwest 自动跟随 302 落到 CDN；这里卡住**起始**地址，避免这段代码被当成通用下载器使。
fn validate_release_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or("更新包地址必须是 https")?;
    let host = rest.split(['/', '?']).next().unwrap_or("");
    let host = host.split('@').next_back().unwrap_or("");
    if host == "github.com" || host == "api.github.com" {
        Ok(())
    } else {
        Err(format!("更新包地址不是 GitHub 域名：{host}"))
    }
}

/// 接受 GitHub API 的 `sha256:<64 hex>`，也容忍调用方只传 64 位十六进制。
/// 返回统一的小写 hex；空值代表旧 API 没提供摘要，由体积校验兜底。
fn normalize_sha256_digest(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let hex = trimmed.strip_prefix("sha256:").unwrap_or(trimmed);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// 文件必须在给定目录之内（防「让宿主执行任意路径」）。
fn ensure_inside(dir: &Path, file: &Path) -> Result<(), String> {
    let root = std::fs::canonicalize(dir).map_err(|e| format!("缓存目录不可用：{e}"))?;
    let target = std::fs::canonicalize(file).map_err(|_| "更新包不存在或已被清理".to_string())?;
    if target.starts_with(&root) {
        Ok(())
    } else {
        Err("更新包不在应用缓存目录内，已拒绝执行".into())
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/* ───────────────────────── 命令 ───────────────────────── */

/// 字段名**必须**保持 snake_case 原样输出：`src/updateChecker.js` 读的就是
/// `has_update` / `asset_url` / `asset_name` / `asset_size`。加 `rename_all = "camelCase"`
/// 不会报错，只会让这四个字段全变 `undefined` —— 于是永远判「已是最新版本」，
/// 而单单词的 `current` / `latest` 照常显示，看起来一切正常（v0.38.0 起踩过，别再踩）。
#[derive(Serialize)]
pub struct UpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
    /// 本平台能否自动安装（macOS/Linux 目前只发 Windows+Android 产物）。
    supported: bool,
    /// 找不到匹配产物时给前端一句人话，避免出现「有更新但点不动」。
    message: String,
    notes: String,
    published_at: String,
    release_name: String,
    release_url: String,
    asset_name: String,
    asset_url: String,
    asset_size: u64,
    asset_digest: String,
}

/// 查最新发布并和当前版本比。
///
/// 失败一律返回 `Err`，由前端决定要不要打扰用户 —— 启动时的静默检查会吞掉错误，
/// 手动点「检查更新」时才把 `Err` 的内容显示出来。
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let response = crate::shared_http_client()?
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        // 🔴 必须带 no-cache。GitHub 的 API 响应走 Fastly CDN，`releases/latest`
        // 的响应头是 `cache-control: public, max-age=60, s-maxage=60` —— 刚发布的
        // release 会在最多一分钟内被缓存里的**上一个**版本顶住，客户端于是答
        // 「已是最新版本」。带上 no-cache 让 CDN 回源，发版后点「检查更新」必中。
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|e| format!("检查更新失败：{e}"))?;

    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        // 未鉴权的 GitHub API 每小时 60 次，共用出口 IP 时很容易撞上。
        return Err("检查更新太频繁了，请过一会儿再试".into());
    }
    if !status.is_success() {
        return Err(format!("检查更新失败：HTTP {}", status.as_u16()));
    }

    // 🔴 用 text() + serde_json::from_str，不要用 response.json()。
    // reqwest 的 `json` feature 未启用（Cargo.toml 里 default-features = false，
    // features 只有 rustls-tls / charset / gzip / cookies），Response::json() 不存在，
    // 编到这一步会 E0599 直接断构建。`.text()` 是 reqwest 的 base 能力，无需额外 feature。
    // 这也是本仓库其它地方（lib.rs 的 AI 响应、lan.rs）一致的写法。
    let body = response
        .text()
        .await
        .map_err(|e| format!("版本信息读取失败：{e}"))?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        let brief: String = body.chars().take(300).collect();
        format!("版本信息解析失败：{e}（原文：{brief}）")
    })?;

    let tag = json["tag_name"].as_str().unwrap_or("").trim().to_string();
    if tag.is_empty() {
        return Err("版本信息里没有 tag_name".into());
    }
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let latest_version =
        parse_version(&latest).ok_or_else(|| format!("无法解析远端版本号：{tag}"))?;
    let current_version = parse_version(&current);
    let has_update = current_version.is_some_and(|cur| latest_version > cur);

    let kind = asset_kind();
    let assets: Vec<(String, String, u64)> = json["assets"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|asset| {
                    let name = asset["name"].as_str()?.to_string();
                    let url = asset["browser_download_url"].as_str()?.to_string();
                    let size = asset["size"].as_u64().unwrap_or(0);
                    Some((name, url, size))
                })
                .collect()
        })
        .unwrap_or_default();

    let unsupported_message = match kind {
        AssetKind::Unsupported => "当前平台暂未提供应用内更新，请到项目仓库下载".to_string(),
        _ => format!("最新发布里没有找到本平台可用的更新包（{latest}），请到项目仓库下载"),
    };
    let picked = pick_asset(&assets, kind, &latest);
    // 有没有产物是「能不能自动装」的前提；是否真有新版由 has_update 决定。
    let supported = kind != AssetKind::Unsupported && picked.is_some();

    let (asset_name, asset_url, asset_size) = picked
        .map(|(name, url, size)| (name.clone(), url.clone(), *size))
        .unwrap_or_default();
    let asset_digest = if asset_name.is_empty() {
        String::new()
    } else {
        json["assets"]
            .as_array()
            .and_then(|list| {
                list.iter()
                    .find(|asset| asset["name"].as_str() == Some(&asset_name))
            })
            .and_then(|asset| asset["digest"].as_str())
            .and_then(normalize_sha256_digest)
            .map(|hex| format!("sha256:{hex}"))
            .unwrap_or_default()
    };

    Ok(UpdateInfo {
        current,
        latest,
        has_update,
        supported,
        message: if supported {
            String::new()
        } else {
            unsupported_message
        },
        notes: truncate_chars(json["body"].as_str().unwrap_or(""), MAX_NOTES_CHARS),
        published_at: json["published_at"].as_str().unwrap_or("").to_string(),
        release_name: json["name"].as_str().unwrap_or("").to_string(),
        release_url: json["html_url"].as_str().unwrap_or("").to_string(),
        asset_name,
        asset_url,
        asset_size,
        asset_digest,
    })
}

/// 下载专用客户端。
///
/// **不能复用 `crate::shared_http_client()`** —— 那个客户端设了 15 秒的**整体超时**
/// （`ClientBuilder::timeout`），20MB 的 APK 在稍慢的网速下必然被掐断，用户看到的是
/// 「下载中断：operation timed out」且永远装不上。
///
/// 这里改用 `read_timeout`：不设整体超时，只要求「每 30 秒至少来一段数据」。
/// 于是「慢但一直在动」的连接不会被误杀，真断流又能及时失败。
static DOWNLOAD_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn download_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = DOWNLOAD_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Mozilla/5.0 LeTimeManagement/",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("下载客户端初始化失败：{e}"))?;
    let _ = DOWNLOAD_CLIENT.set(client);
    DOWNLOAD_CLIENT
        .get()
        .ok_or_else(|| "下载客户端初始化失败".into())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    received: u64,
    total: u64,
}

/// 流式下载更新包到应用缓存目录，返回落盘路径。
///
/// - 先写 `*.part` 再改名：中途失败 / 被取消时不会留下一个「看起来能用」的半截文件
///   被安装器捡走。
/// - `size` 与 `digest` 都来自同一次 GitHub API 响应。体积拦截断，SHA-256 拦内容损坏；
///   摘要不是独立签名，不能替代完整的发布签名体系，但至少不会执行下载途中损坏的安装包。
#[tauri::command]
pub async fn update_download<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    name: String,
    size: u64,
    digest: String,
) -> Result<String, String> {
    if asset_kind() == AssetKind::Unsupported {
        return Err("当前平台不支持应用内更新，请到项目仓库下载".into());
    }
    validate_release_url(&url)?;
    let file_name = safe_file_name(&name, required_ext())?;
    if size > MAX_UPDATE_BYTES {
        return Err("更新包体积异常，已中止下载".into());
    }
    let expected_digest = if digest.trim().is_empty() {
        None
    } else {
        Some(normalize_sha256_digest(&digest).ok_or("更新包 SHA-256 格式不合法")?)
    };

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("缓存目录不可用：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("缓存目录创建失败：{e}"))?;
    let final_path = dir.join(&file_name);
    let part_path = dir.join(format!("{file_name}.part"));

    let mut response = download_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status().as_u16()));
    }

    // content_length 可能缺失（分块传输）；此时退回 API 给的 size 当分母。
    let total = response.content_length().unwrap_or(size);
    if total > MAX_UPDATE_BYTES {
        return Err("更新包体积异常，已中止下载".into());
    }

    let mut file =
        std::fs::File::create(&part_path).map_err(|e| format!("无法写入缓存文件：{e}"))?;
    // 进度节流：按总量切成约 200 份（下限 256KB），最多发 200 次事件，别把 IPC 打满。
    let step = (total / 200).max(256 * 1024);
    let mut last_sent: u64 = 0;
    let mut digest_context = ring::digest::Context::new(&ring::digest::SHA256);

    // 收尾（校验体积 → 改名，或清理 .part）都在 await 结束、文件句柄释放之后做：
    // Windows 上句柄没关就 rename 会报占用。
    let downloaded: Result<u64, String> = async {
        let mut received: u64 = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("下载中断：{e}"))?
        {
            received += chunk.len() as u64;
            if received > MAX_UPDATE_BYTES {
                return Err("更新包体积异常，已中止下载".to_string());
            }
            file.write_all(&chunk)
                .map_err(|e| format!("写入失败：{e}"))?;
            digest_context.update(&chunk);
            if received - last_sent >= step || received == total {
                last_sent = received;
                let _ = app.emit("update:progress", UpdateProgress { received, total });
            }
        }
        Ok(received)
    }
    .await;

    drop(file);

    match downloaded {
        Ok(received) => {
            if total > 0 && received != total {
                let _ = std::fs::remove_file(&part_path);
                return Err(format!("更新包不完整（{received}/{total} 字节），请重试"));
            }
            if size > 0 && received != size {
                let _ = std::fs::remove_file(&part_path);
                return Err(format!(
                    "更新包大小与发布信息不一致（{received}/{size} 字节），请重试"
                ));
            }
            if let Some(expected) = expected_digest {
                let actual = hex::encode(digest_context.finish().as_ref());
                if actual != expected {
                    let _ = std::fs::remove_file(&part_path);
                    return Err("更新包 SHA-256 校验失败，请重新下载".into());
                }
            }
            // Windows 的 rename 不覆盖已有文件；应用重启后重试同一版本时先删旧缓存，
            // 否则下载完整却在最后一步报 AlreadyExists。
            if final_path.exists() {
                std::fs::remove_file(&final_path)
                    .map_err(|e| format!("旧更新缓存清理失败：{e}"))?;
            }
            std::fs::rename(&part_path, &final_path).map_err(|e| format!("更新包落盘失败：{e}"))?;
            Ok(final_path.to_string_lossy().into_owned())
        }
        Err(message) => {
            let _ = std::fs::remove_file(&part_path);
            Err(message)
        }
    }
}

/// 把下载好的更新包交给系统安装。
///
/// - **Windows**：`installer.exe /S /R`。NSIS 脚本在静默模式下会先结束正在运行的实例
///   （`CheckIfAppIsRunning`），装完按 `/R` 自动重启；所以这里启动安装器之后必须立刻退出，
///   否则旧进程会一直占着 `U-Time.exe`。
/// - **Android**：经原生插件用 `content://` + 读权限交给系统安装器。返回成功只代表
///   「安装界面已拉起」，用户在系统界面点取消我们也收不到信号 —— 文案要说「已交给系统安装」。
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("缓存目录不可用：{e}"))?;
        ensure_inside(&dir, Path::new(&path))?;
        let handle = app
            .try_state::<AndroidUpdater<R>>()
            .ok_or("更新安装桥未初始化，请重启应用后再试")?;
        return handle
            .0
            .run_mobile_plugin_async("install", serde_json::json!({ "path": path }))
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("缓存目录不可用：{e}"))?;
        ensure_inside(&dir, Path::new(&path))?;
        let file = std::path::PathBuf::from(&path);
        if file
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref()
            != Some("exe")
        {
            return Err("Windows 上只能执行 .exe 安装包".into());
        }
        std::process::Command::new(&file)
            .args(["/S", "/R"])
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("无法启动安装程序：{e}"))?;
        // 安装器需要独占替换正在运行的 exe —— 立刻退出，别让用户看到「装了半天没反应」。
        app.exit(0);
        return Ok(serde_json::json!({ "launched": true, "exiting": true }));
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = (app, path);
        Err("当前平台不支持应用内更新，请到项目仓库下载".into())
    }
}

/// Android 专有：现在能不能真的装（未知来源授权 + 系统里有安装器）。
///
/// 前端在下载完成后、点「立即安装」之前问一次：没授权就先把按钮换成
/// 「去开启安装权限」，否则用户点下去只会看到安装界面一闪而过。
#[tauri::command]
pub async fn update_ready<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<AndroidUpdater<R>>()
            .ok_or("更新安装桥未初始化，请重启应用后再试")?;
        return handle
            .0
            .run_mobile_plugin_async("installReady", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "ready": true, "platform": std::env::consts::OS, "reason": "" }))
    }
}

/// Android 专有：跳到本应用的「安装未知来源应用」授权页。
///
/// 与 [`update_ready`] 配套：探测到没授权时，前端把按钮换成「去开启安装权限」，
/// 点它就到这里。用户在系统设置里开完开关回到应用，再点「立即安装」即可。
#[tauri::command]
pub async fn update_open_install_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<AndroidUpdater<R>>()
            .ok_or("更新安装桥未初始化，请重启应用后再试")?;
        return handle
            .0
            .run_mobile_plugin_async("openInstallPermissionSettings", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "opened": false }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_tolerates_prefix_and_suffix() {
        assert_eq!(parse_version("0.38.0"), Some((0, 38, 0)));
        assert_eq!(parse_version("v0.38.1"), Some((0, 38, 1)));
        assert_eq!(parse_version(" v1.2.3 "), Some((1, 2, 3)));
        // 预发布 / 构建后缀不参与排序
        assert_eq!(parse_version("0.38.0-rc.1"), Some((0, 38, 0)));
        assert_eq!(parse_version("0.38.0+build.7"), Some((0, 38, 0)));
        // 两段式 / 垃圾输入按「缺位补 0」或直接判失败
        assert_eq!(parse_version("0.38"), Some((0, 38, 0)));
        assert_eq!(parse_version("dev"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn version_ordering_is_numeric_not_lexicographic() {
        // 字符串比较会把 0.9.0 > 0.10.0 判成真 —— 这是最经典的自动更新 bug。
        assert!(parse_version("0.10.0").unwrap() > parse_version("0.9.0").unwrap());
        assert!(parse_version("0.38.0").unwrap() > parse_version("0.37.19").unwrap());
        assert!(parse_version("1.0.0").unwrap() > parse_version("0.99.99").unwrap());
    }

    #[test]
    fn windows_prefers_setup_exe_over_portable_and_msi() {
        let assets = vec![
            ("LeTime-0.38.0-x64-portable.exe".to_string(), "u".into(), 1),
            ("LeTime-0.38.0-x64-zh-CN.msi".to_string(), "u".into(), 1),
            ("LeTime-0.38.0-x64-setup.exe".to_string(), "u".into(), 1),
        ];
        let picked = pick_asset(&assets, AssetKind::SetupExe, "0.38.0").unwrap();
        assert_eq!(picked.0, "LeTime-0.38.0-x64-setup.exe");
        // portable 不是「.exe 且含 setup」，压根不该被选中
        assert_eq!(
            asset_score(
                "LeTime-0.38.0-x64-portable.exe",
                AssetKind::SetupExe,
                "0.38.0"
            ),
            None
        );
    }

    #[test]
    fn android_prefers_universal_apk() {
        let assets = vec![
            ("LeTime-0.38.0-arm64.apk".to_string(), "u".into(), 1),
            ("LeTime-0.38.0-universal.apk".to_string(), "u".into(), 1),
        ];
        let picked = pick_asset(&assets, AssetKind::Apk, "0.38.0").unwrap();
        assert_eq!(picked.0, "LeTime-0.38.0-universal.apk");
    }

    #[test]
    fn stale_asset_from_older_version_loses_to_matching_one() {
        // 某个 release 误挂了旧版本产物时，版本号命中的那个必须胜出 ——
        // 否则装完还是旧版，每次启动都提示更新，变成死循环。
        let assets = vec![
            ("LeTime-0.37.18-x64-setup.exe".to_string(), "u".into(), 1),
            ("LeTime-0.38.0-x64-setup.exe".to_string(), "u".into(), 1),
        ];
        let picked = pick_asset(&assets, AssetKind::SetupExe, "0.38.0").unwrap();
        assert_eq!(picked.0, "LeTime-0.38.0-x64-setup.exe");

        // 只有旧版本产物时必须拒绝自动安装，否则装完仍是旧版，启动后会无限提示更新。
        let older = asset_score(
            "LeTime-0.37.18-x64-setup.exe",
            AssetKind::SetupExe,
            "0.38.0",
        );
        let exact = asset_score("LeTime-0.38.0-x64-setup.exe", AssetKind::SetupExe, "0.38.0");
        assert_eq!(older, None);
        assert!(exact.is_some());
    }

    #[test]
    fn unsupported_platform_gets_nothing() {
        let assets = vec![("LeTime-0.38.0-universal.apk".to_string(), "u".into(), 1)];
        assert!(pick_asset(&assets, AssetKind::Unsupported, "0.38.0").is_none());
    }

    #[test]
    fn asset_name_is_sanitised_against_path_traversal() {
        assert_eq!(
            safe_file_name("LeTime-0.38.0-x64-setup.exe", ".exe").unwrap(),
            "LeTime-0.38.0-x64-setup.exe"
        );
        // 目录穿越 / 路径分隔符 / 隐藏文件一律拒绝
        assert!(safe_file_name("../../evil.exe", ".exe").is_err());
        assert!(safe_file_name("sub/dir/evil.exe", ".exe").is_err());
        assert!(safe_file_name("sub\\dir\\evil.exe", ".exe").is_err());
        assert!(safe_file_name(".bashrc", ".exe").is_err());
        // 扩展名必须对得上本平台
        assert!(safe_file_name("LeTime-0.38.0-universal.apk", ".exe").is_err());
        assert!(safe_file_name("", ".exe").is_err());
    }

    #[test]
    fn download_url_must_be_github_https() {
        assert!(validate_release_url("https://github.com/a/b/releases/download/v1/x.exe").is_ok());
        assert!(validate_release_url("https://api.github.com/repos/a/b").is_ok());
        // http（可被中间人替换）、别的域名、以及「域名里含 github.com」的仿冒都要挡住
        assert!(validate_release_url("http://github.com/a/x.exe").is_err());
        assert!(validate_release_url("https://evil.com/github.com/x.exe").is_err());
        assert!(validate_release_url("https://github.com.evil.com/x.exe").is_err());
        assert!(validate_release_url("file:///C:/x.exe").is_err());
    }

    #[test]
    fn github_sha256_digest_is_validated() {
        let hex = "ab".repeat(32);
        assert_eq!(normalize_sha256_digest(&format!("sha256:{hex}")), Some(hex));
        assert_eq!(
            normalize_sha256_digest(&"AB".repeat(32)),
            Some("ab".repeat(32))
        );
        assert_eq!(normalize_sha256_digest("sha256:1234"), None);
        assert_eq!(
            normalize_sha256_digest(&format!("sha1:{}", "ab".repeat(32))),
            None
        );
        assert_eq!(normalize_sha256_digest(&"zz".repeat(32)), None);
    }

    #[test]
    fn notes_truncation_counts_chars_not_bytes() {
        // 按字节截断会把中文切成半个字符 —— 必须按字符数截。
        let text = "中文说明".repeat(10);
        let cut = truncate_chars(&text, 5);
        assert_eq!(cut.chars().count(), 6); // 5 个字符 + 省略号
        assert!(cut.ends_with('…'));
        assert_eq!(truncate_chars("短", 5), "短");
    }
}
