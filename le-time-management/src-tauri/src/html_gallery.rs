//! 本地 HTML 目录预览（「HTML 目录」插件用）
//!
//! 插件要的是「挑一个文件夹 → 自动认出里面的 .html → 卡片上看到首页真实长什么样」。
//! 三件事只有原生侧做得到，所以都在这里：
//!
//! ① **目录浏览 / 扫描**：WebView 里拿不到任意本地路径（`<input webkitdirectory>` 只能
//!    一次性拿到用户手点的那个目录，重启就没了，也没法记住路径）。这里用 std::fs 只读遍历，
//!    给插件一个「磁盘式」目录选择器。
//! ② **回环静态服务**：缩略图必须是**真的渲染**，不是截屏也不是图标。iframe 要能加载页面，
//!    页面里的相对路径 css / js / 图片就得跟着能取到 —— 把 `file://` 塞进 iframe 会被
//!    WebView2 拦掉（页面来源是 `http://tauri.localhost`，跨到 file: 属于禁止的导航）。
//!    所以这里起一个只绑 `127.0.0.1` 的静态服务，把选中的目录挂上去：
//!    iframe 拿到的是普通 http 地址，相对路径、字体、图片全都按原样工作。
//! ③ **路径校验**：服务只认「挂载根」里的文件 —— 逐段拒绝 `..`、盘符与反斜杠，
//!    落盘前再 canonicalize 比一次前缀，防住 `%2e%2e%2f` 这类绕过。挂了别人的目录
//!    也读不到目录外的东西。
//!
//! 与 lan.rs 的区别：那边是给手机连的局域网服务（绑 0.0.0.0 + 配对令牌），这边只服务
//! 本机自己的 WebView，绑 127.0.0.1、不需要令牌，也不需要写任何路由。
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

/// 一次扫描最多返回多少个 html。够用（正常项目目录几十个），又不会把界面拖死。
const MAX_SCAN: usize = 600;
/// 单个文件响应上限。超过就当它不是「页面」—— 视频 / 压缩包不该走这条通道。
const MAX_BYTES: u64 = 48 * 1024 * 1024;
/// 并发服务线程数。缩略图一屏能起十几个 iframe，单线程顺序处理会让后面的卡片长时间空白。
const WORKERS: usize = 4;

/// 回环服务句柄。整个应用同时只挂一个目录：换目录时先停旧的再起新的。
#[derive(Default)]
pub struct HtmlServe {
    current: Arc<Mutex<Option<Serving>>>,
}

struct Serving {
    root: PathBuf,
    base: String,
    stop: Arc<AtomicBool>,
}

/* ── 目录：起点 / 浏览 / 扫描 ─────────────────────────────────────────────── */

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn is_html(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// 选目录时最先想到的几个地方。存在的才给，避免给一串点进去报错的入口。
fn start_roots() -> Vec<serde_json::Value> {
    let home = home_dir();
    let mut out = Vec::new();
    let mut push = |label: &str, path: PathBuf| {
        if path.is_dir() {
            out.push(serde_json::json!({ "label": label, "path": path.to_string_lossy() }));
        }
    };
    push("桌面", home.join("Desktop"));
    push("文档", home.join("Documents"));
    push("下载", home.join("Downloads"));
    push("用户目录", home.clone());
    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            if root.is_dir() {
                out.push(serde_json::json!({ "label": format!("{} 盘", letter as char), "path": root.to_string_lossy() }));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    out.push(serde_json::json!({ "label": "/", "path": "/" }));
    out
}

#[tauri::command]
pub fn html_dir_roots() -> serde_json::Value {
    serde_json::json!({ "roots": start_roots(), "home": home_dir().to_string_lossy() })
}

/// 快速数一下某个子目录里有多少个 html（只数直接子文件，最多数到 99）。
/// 目录选择器给每个子目录标上「3 个页面」这类提示，用户不用逐个点进去找。
fn count_html(dir: &Path) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut n = 0u32;
    for entry in entries.flatten() {
        if n >= 99 {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) && is_html(&name) {
            n += 1;
        }
    }
    n
}

#[tauri::command]
pub fn html_dir_list(path: String) -> Result<serde_json::Value, String> {
    let dir = PathBuf::from(path.trim());
    if !dir.is_dir() {
        return Err("这个路径不是文件夹，或者已经不存在了".into());
    }
    let mut dirs = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读不到这个文件夹：{e}"))?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏目录（.git / .vscode …）对选目录没意义，直接略过
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let child = entry.path();
        dirs.push(serde_json::json!({
            "name": name,
            "path": child.to_string_lossy(),
            "htmlCount": count_html(&child),
        }));
        if dirs.len() >= 300 {
            break;
        }
    }
    dirs.sort_by(|a, b| {
        let an = a["name"].as_str().unwrap_or("");
        let bn = b["name"].as_str().unwrap_or("");
        an.to_lowercase().cmp(&bn.to_lowercase())
    });
    let parent = dir.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    Ok(serde_json::json!({
        "path": dir.to_string_lossy(),
        "parent": parent,
        "dirs": dirs,
        "htmlCount": count_html(&dir),
    }))
}

/// 页面标题：卡片上写文件名太冷，写标题才知道那是哪个页面。
/// 编码先按 UTF-8 严格解，失败再退 GB18030 —— 老项目里 GBK 页面还不少，
/// 一上来就 from_utf8_lossy 会把中文标题变成一串 �。
fn title_of(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else { return String::new() };
    let mut buf = vec![0u8; 8192];
    let Ok(n) = file.read(&mut buf) else { return String::new() };
    buf.truncate(n);
    let text = match std::str::from_utf8(&buf) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GB18030.decode(&buf);
            decoded.into_owned()
        }
    };
    let lower = text.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else { return String::new() };
    let Some(open) = lower[start..].find('>') else { return String::new() };
    let from = start + open + 1;
    let end = lower[from..].find("</title").map(|i| from + i).unwrap_or(text.len().min(from + 200));
    let raw = text.get(from..end).unwrap_or("");
    let cleaned = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned.chars().take(120).collect()
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "__pycache__" | "target" | "vendor")
}

fn walk(root: &Path, dir: &Path, depth_left: u32, out: &mut Vec<serde_json::Value>) {
    if out.len() >= MAX_SCAN {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if depth_left > 0 && !skip_dir(&name) {
                children.push((true, entry.path(), name));
            }
            continue;
        }
        if !file_type.is_file() || !is_html(&name) {
            continue;
        }
        let meta = entry.metadata().ok();
        let rel = entry
            .path()
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        out.push(serde_json::json!({
            "name": name,
            "rel": rel,
            "path": entry.path().to_string_lossy(),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "mtime": meta.as_ref().map(mtime_ms).unwrap_or(0),
            "title": title_of(&entry.path()),
        }));
        if out.len() >= MAX_SCAN {
            return;
        }
    }
    children.sort_by(|a, b| a.2.to_lowercase().cmp(&b.2.to_lowercase()));
    for (_, path, _) in children {
        if out.len() >= MAX_SCAN {
            return;
        }
        walk(root, &path, depth_left - 1, out);
    }
}

/// 扫一个目录下的 html。`depth` 是往下找几层（0 = 只看这一层）。
#[tauri::command]
pub fn html_dir_scan(path: String, depth: Option<u32>) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err("这个路径不是文件夹，或者已经不存在了".into());
    }
    let depth = depth.unwrap_or(2).min(6);
    let mut items = Vec::new();
    walk(&root, &root, depth, &mut items);
    // index.html 排最前：它通常就是这个项目的入口
    items.sort_by(|a, b| {
        let ar = a["rel"].as_str().unwrap_or("");
        let br = b["rel"].as_str().unwrap_or("");
        let ai = ar.rsplit('/').next().map(|n| n.to_ascii_lowercase().starts_with("index.")).unwrap_or(false);
        let bi = br.rsplit('/').next().map(|n| n.to_ascii_lowercase().starts_with("index.")).unwrap_or(false);
        bi.cmp(&ai).then_with(|| ar.to_lowercase().cmp(&br.to_lowercase()))
    });
    Ok(serde_json::json!({
        "root": root.to_string_lossy(),
        "depth": depth,
        "truncated": items.len() >= MAX_SCAN,
        "items": items,
    }))
}

/* ── 回环静态服务 ─────────────────────────────────────────────────────────── */

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// 请求路径 → 挂载根下的真实文件。任何一段是 `..`、带盘符或反斜杠都直接拒。
fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path)?;
    let trimmed = decoded.split(['?', '#']).next().unwrap_or("");
    let mut target = root.to_path_buf();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." || segment.contains('\\') || segment.contains(':') || segment.contains('\0') {
            return None;
        }
        target.push(segment);
    }
    if target.is_dir() {
        target.push("index.html");
    }
    let canon = target.canonicalize().ok()?;
    let root_canon = root.canonicalize().ok()?;
    if !canon.starts_with(&root_canon) || !canon.is_file() {
        return None;
    }
    Some(canon)
}

fn mime_of(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "xml" => "text/xml; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
        .unwrap_or_else(|_| tiny_http::Header::from_bytes(&b"X-Empty"[..], &b"1"[..]).unwrap())
}

fn serve_one(request: tiny_http::Request, root: &Path) {
    let method = request.method().clone();
    let url = request.url().to_string();
    if !matches!(method, tiny_http::Method::Get | tiny_http::Method::Head) {
        let _ = request.respond(tiny_http::Response::empty(405));
        return;
    }
    let Some(path) = resolve(root, &url) else {
        let body = "<!doctype html><meta charset=\"utf-8\"><body style=\"font:15px/1.7 system-ui;padding:28px;color:#64748b\">这里没有页面。<br>只服务你选中的那个文件夹里的文件。</body>";
        let response = tiny_http::Response::from_string(body)
            .with_status_code(404)
            .with_header(header("Content-Type", "text/html; charset=utf-8"));
        let _ = request.respond(response);
        return;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        let _ = request.respond(tiny_http::Response::empty(404));
        return;
    };
    if meta.len() > MAX_BYTES {
        let _ = request.respond(tiny_http::Response::empty(413));
        return;
    }
    if matches!(method, tiny_http::Method::Head) {
        let response = tiny_http::Response::empty(200)
            .with_header(header("Content-Type", mime_of(&path)))
            .with_header(header("Content-Length", &meta.len().to_string()));
        let _ = request.respond(response);
        return;
    }
    let Ok(bytes) = std::fs::read(&path) else {
        let _ = request.respond(tiny_http::Response::empty(500));
        return;
    };
    // 页面里的相对资源要靠浏览器缓存才有意义，但页面本身改完要立刻看到 ——
    // 所以统一 no-cache：本地磁盘读一次是微秒级，换「改了立刻生效」值。
    let response = tiny_http::Response::from_data(bytes)
        .with_header(header("Content-Type", mime_of(&path)))
        .with_header(header("Cache-Control", "no-cache"))
        .with_header(header("Access-Control-Allow-Origin", "*"));
    let _ = request.respond(response);
}

/// 起一个只服务 `root` 的静态服务，返回 (base 地址, 停止旗标)。
/// 从命令里拆出来是为了能在单元测试里直接起一个（命令需要 tauri::State，测不了）。
fn spawn(root: &Path) -> Result<(String, Arc<AtomicBool>), String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("本地预览服务起不来：{e}"))?;
    // ListenAddr 在 Windows 上只有 IP 一种（Unix socket 变体不存在），
    // 保留兜底分支是为了 Android / 其它目标也能编译，这里显式允许 unreachable。
    #[allow(unreachable_patterns)]
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => return Err("本地预览服务没有拿到端口".into()),
    };
    let base = format!("http://127.0.0.1:{port}");
    let stop = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(server);
    for _ in 0..WORKERS {
        let server = shared.clone();
        let stop = stop.clone();
        let root = root.to_path_buf();
        std::thread::spawn(move || {
            // recv_timeout 而不是 incoming_requests：后者会一直阻塞，
            // 换目录时旧线程就永远退不出去（端口也被它占着）。
            while !stop.load(Ordering::Relaxed) {
                match server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => serve_one(request, &root),
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
        });
    }
    Ok((base, stop))
}

#[tauri::command]
pub fn html_serve_start(state: State<'_, HtmlServe>, path: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err("这个路径不是文件夹，或者已经不存在了".into());
    }
    let root = root.canonicalize().map_err(|e| format!("目录不可用：{e}"))?;
    let mut slot = state.current.lock().map_err(|_| "服务状态被占用")?;
    // 已经挂着同一个目录：直接把现有地址还回去，不要重启（重启会让已渲染的缩略图全白一次）
    if let Some(serving) = slot.as_ref() {
        if serving.root == root {
            return Ok(serde_json::json!({ "base": serving.base, "root": serving.root.to_string_lossy(), "reused": true }));
        }
    }
    if let Some(old) = slot.take() {
        old.stop.store(true, Ordering::Relaxed);
    }
    let (base, stop) = spawn(&root)?;
    *slot = Some(Serving { root: root.clone(), base: base.clone(), stop });
    Ok(serde_json::json!({ "base": base, "root": root.to_string_lossy(), "reused": false }))
}

#[tauri::command]
pub fn html_serve_stop(state: State<'_, HtmlServe>) -> Result<serde_json::Value, String> {
    let mut slot = state.current.lock().map_err(|_| "服务状态被占用")?;
    if let Some(serving) = slot.take() {
        serving.stop.store(true, Ordering::Relaxed);
        return Ok(serde_json::json!({ "stopped": true, "root": serving.root.to_string_lossy() }));
    }
    Ok(serde_json::json!({ "stopped": false }))
}

#[tauri::command]
pub fn html_serve_status(state: State<'_, HtmlServe>) -> Result<serde_json::Value, String> {
    let slot = state.current.lock().map_err(|_| "服务状态被占用")?;
    Ok(match slot.as_ref() {
        Some(serving) => serde_json::json!({ "running": true, "base": serving.base, "root": serving.root.to_string_lossy() }),
        None => serde_json::json!({ "running": false }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_utf8_and_rejects_broken() {
        assert_eq!(percent_decode("/a%20b/%E4%B8%AD.html").as_deref(), Some("/a b/中.html"));
        assert_eq!(percent_decode("/%2e%2e/secret").as_deref(), Some("/../secret"));
        assert!(percent_decode("/bad%2").is_none());
        assert!(percent_decode("/bad%zz").is_none());
    }

    #[test]
    fn is_html_matches_case_insensitively() {
        assert!(is_html("index.html"));
        assert!(is_html("ABOUT.HTM"));
        assert!(!is_html("index.html.bak"));
        assert!(!is_html("style.css"));
    }

    #[test]
    fn mime_covers_what_pages_ask_for() {
        assert_eq!(mime_of(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_of(Path::new("a.WOFF2")), "font/woff2");
        assert_eq!(mime_of(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn skip_dir_ignores_build_noise() {
        assert!(skip_dir(".git"));
        assert!(skip_dir("node_modules"));
        assert!(!skip_dir("src"));
    }

    /// 真起一个服务、真发 HTTP 请求 —— 这是整个插件的命门：
    /// 能取到页面、能取到相对资源、**取不到挂载根外面**的东西。
    #[test]
    fn serves_pages_and_refuses_traversal() {
        use std::io::{Read, Write};

        let base_dir = std::env::temp_dir().join(format!("hg-test-{}", std::process::id()));
        let root = base_dir.join("site");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("index.html"), "<title>首页标题</title><h1>hi</h1>").unwrap();
        std::fs::write(sub.join("p.html"), "<title>子页</title>").unwrap();
        std::fs::write(sub.join("a.css"), "body{color:red}").unwrap();
        // 挂载根外面放一份"不该被看到"的文件
        let secret = base_dir.join("secret.txt");
        std::fs::write(&secret, "TOP SECRET").unwrap();

        let canon = root.canonicalize().unwrap();
        let (base, stop) = spawn(&canon).unwrap();
        let port = base.rsplit(':').next().unwrap().parse::<u16>().unwrap();

        let get = |path: &str| -> (u16, String) {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream
                .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes())
                .unwrap();
            let mut text = String::new();
            stream.read_to_string(&mut text).unwrap();
            let status = text
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);
            (status, text)
        };

        let (status, body) = get("/");
        assert_eq!(status, 200, "根路径应当落到 index.html");
        assert!(body.contains("首页标题"), "根路径没返回 index.html 的内容");
        assert!(body.to_lowercase().contains("text/html"));

        let (status, body) = get("/sub/p.html");
        assert_eq!(status, 200);
        assert!(body.contains("子页"));

        let (status, _) = get("/sub/a.css");
        assert_eq!(status, 200, "相对路径的样式表必须取得到，否则缩略图是裸文字");

        assert_eq!(get("/nope.html").0, 404, "不存在的文件应当 404");
        assert_eq!(get("/%2e%2e/secret.txt").0, 404, "编码过的 .. 必须被拦");
        assert_eq!(get("/sub/../../secret.txt").0, 404, "明文 .. 必须被拦");
        let (status, body) = get("/../secret.txt");
        assert_eq!(status, 404);
        assert!(!body.contains("TOP SECRET"), "挂载根外的文件被读出来了");

        stop.store(true, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(300));
        let _ = std::fs::remove_dir_all(&base_dir);
    }
}
