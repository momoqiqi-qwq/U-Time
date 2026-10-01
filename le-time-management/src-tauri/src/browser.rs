use tauri::{AppHandle, Webview};
use serde_json::{json, Value};
#[cfg(desktop)]
use tauri::{Manager, LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};

#[cfg(desktop)]
fn layout(window: &tauri::Window, width: f64) -> tauri::Result<()> {
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    let rail = width.min((size.width - 100.0).max(48.0));
    for view in window.webviews() {
        let tools = view.label().starts_with("browser-tools-");
        view.set_bounds(tauri::Rect {
            position: LogicalPosition::new(if tools { size.width - rail } else { 0.0 }, 0.0).into(),
            size: LogicalSize::new(if tools { rail } else { (size.width - rail).max(1.0) }, size.height).into(),
        })?;
    }
    Ok(())
}

#[cfg(desktop)]
pub fn open(app: &AppHandle, label: &str, url: tauri::Url, cookies: Vec<(String, tauri::webview::Cookie<'static>)>) -> Result<(), String> {
    let window = WindowBuilder::new(app, label).title("U-Time · 网页").inner_size(1100.0, 780.0).min_inner_size(420.0, 360.0).center().build().map_err(|e| e.to_string())?;
    let result = (|| -> tauri::Result<()> {
        let content = window.add_child(WebviewBuilder::new(format!("{label}-content"), WebviewUrl::External("about:blank".parse().unwrap()))
            .initialization_script_for_all_frames(format!("window.__leBrowserContent=true;{}", crate::INTERNAL_BROWSER_BOOTSTRAP))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny), LogicalPosition::new(0.0, 0.0), LogicalSize::new(1052.0, 780.0))?;
        for (_, cookie) in cookies { content.set_cookie(cookie)?; }
        content.navigate(url.clone())?;
        let tools_label = label.replacen("browser-", "browser-tools-", 1);
        window.add_child(WebviewBuilder::new(tools_label, WebviewUrl::App("browser-toolbox.html".into()))
            .initialization_script(format!("window.__leBrowserToolbar={{url:{}}};{}", serde_json::to_string(url.as_str()).unwrap(), crate::INTERNAL_BROWSER_BOOTSTRAP)),
            LogicalPosition::new(1052.0, 0.0), LogicalSize::new(48.0, 780.0))?;
        layout(&window, 48.0)?;
        let resized = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
                let width = resized.webviews().into_iter().find(|v| v.label().starts_with("browser-tools-"))
                    .and_then(|v| v.size().ok()).map(|s| s.to_logical::<f64>(resized.scale_factor().unwrap_or(1.0)).width).unwrap_or(48.0);
                let _ = layout(&resized, if width > 100.0 { 340.0 } else { 48.0 });
            }
        });
        Ok(())
    })();
    if let Err(error) = result { let _ = window.close(); return Err(error.to_string()); }
    Ok(())
}

#[tauri::command]
pub async fn browser_tool_action(app: AppHandle, webview: Webview, action: String, url: Option<String>, zoom: Option<f64>, expanded: Option<bool>) -> Result<Value, String> {
    #[cfg(desktop)]
    {
        let origin = webview.url().map_err(|e| e.to_string())?;
        if !webview.label().starts_with("browser-tools-") || origin.path() != "/browser-toolbox.html" ||
            !matches!(origin.host_str(), Some("tauri.localhost" | "localhost")) {
            return Err("网页内容无权调用工具栏命令".into());
        }
        let label = webview.label().replacen("browser-tools-", "browser-", 1);
        let content = app.get_webview(&format!("{label}-content")).ok_or("网页已关闭")?;
        match action.as_str() {
            "status" => return Ok(json!({ "url": content.url().map_err(|e| e.to_string())?.as_str() })),
            "legacyFavorites" => {
                let (tx, rx) = std::sync::mpsc::channel();
                content.eval_with_callback("(() => {try {return {origin:location.origin,items:JSON.parse(localStorage.getItem('__utime_browser_favorites_v1') || '[]')}} catch (_) {return {origin:location.origin,items:[]}}})()", move |value| { let _ = tx.send(value); }).map_err(|e| e.to_string())?;
                let raw = rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "读取旧收藏超时")?;
                return serde_json::from_str(&raw).map_err(|_| "旧收藏格式无效".into());
            },
            "refresh" => content.reload(),
            "back" => content.eval("history.back()"),
            "forward" => content.eval("history.forward()"),
            "zoom" => content.set_zoom(zoom.unwrap_or(1.0).clamp(0.75, 1.5)),
            "panel" => layout(&webview.window(), if expanded.unwrap_or(false) { 340.0 } else { 48.0 }),
            "navigate" => {
                let target: tauri::Url = url.ok_or("缺少网址")?.parse().map_err(|_| "网址无效")?;
                if !matches!(target.scheme(), "http" | "https") { return Err("仅支持 HTTP/HTTPS 网页".into()); }
                content.navigate(target)
            },
            _ => return Err("未知网页工具栏操作".into()),
        }.map_err(|e| e.to_string())?;
        Ok(json!({ "applied": true }))
    }
    #[cfg(not(desktop))]
    { let _ = (app, webview, action, url, zoom, expanded); Err("本平台使用原生网页工具栏".into()) }
}
