mod native_schedule;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "windows"))]
use tauri_plugin_opener::OpenerExt as _;

mod lan;
mod notification;
mod system_bar;
mod uninstaller;
mod update;

/// 应用数据目录（Windows: %APPDATA%，Linux: ~/.local/share，Android: 应用内部存储）
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    Ok(dir)
}

fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("plugins");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建插件目录: {e}"))?;
    Ok(dir)
}

const SCHOOL_IMPORT_BOOTSTRAP: &str = r#"
(function () {
  if (window.__leSchoolImportReady) return;
  window.__leSchoolImportReady = true;
  const callbacks = new Map(); let callbackCounter = 0; let bridgeQueue = Promise.resolve();
  const encode = (text) => {
    const bytes = new TextEncoder().encode(text); let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };
  const callback = (id, ok, value) => { const item = callbacks.get(id); if (!item) return; callbacks.delete(id); ok ? item.resolve(value) : item.reject(value); };
  window._shiguangNativeCallback = callback;
  const setStatus = (text) => { const node = document.querySelector('#le-school-import-toolbar')?.shadowRoot?.querySelector('[data-status]'); if (node) node.textContent = text; };
  const bridge = async (action, payload, callbackId) => {
    try {
      if (action === 'showToast') { setStatus(payload.message || ''); return true; }
      if (action === 'showAlert') return window.confirm([payload.titleText, payload.contentText].filter(Boolean).join('\n\n'));
      if (action === 'showPrompt') return window.prompt([payload.titleText, payload.tipText].filter(Boolean).join('\n'), payload.defaultText || '');
      if (action === 'showSingleSelection') {
        const items = JSON.parse(payload.itemsJsonString || '[]'); const answer = window.prompt(payload.titleText + '\n' + items.map((x, i) => `${i + 1}. ${x}`).join('\n'), String((payload.defaultSelectedIndex || 0) + 1));
        const index = Number(answer) - 1; return Number.isInteger(index) && index >= 0 && index < items.length ? index : null;
      }
      const raw = JSON.stringify({ action, callbackId: callbackId || null, payload: JSON.stringify(payload || {}) });
      bridgeQueue = bridgeQueue.then(() => new Promise(resolve => {
        location.href = 'letime-import://bridge/' + encode(raw);
        setTimeout(resolve, 100);
      }));
      await bridgeQueue;
      return true;
    } catch (error) { throw String(error && error.message || error); }
  };
  const promises = {};
  for (const action of ['showAlert','showPrompt','showSingleSelection','saveImportedCourses','saveCourseConfig','savePresetTimeSlots']) {
    promises[action] = (...args) => new Promise((resolve, reject) => {
      const id = 'cb_' + (++callbackCounter) + '_' + Date.now(); callbacks.set(id, { resolve, reject });
      const payload = action === 'showAlert' ? {titleText:args[0]||'',contentText:args[1]||'',confirmText:args[2]||null}
        : action === 'showPrompt' ? {titleText:args[0]||'',tipText:args[1]||'',defaultText:args[2]||'',validatorJsFunction:args[3]||''}
        : action === 'showSingleSelection' ? {titleText:args[0]||'',itemsJsonString:typeof args[1]==='string'?args[1]:JSON.stringify(args[1]||[]),defaultSelectedIndex:args[2]??-1}
        : action === 'saveImportedCourses' ? {coursesJsonString:args[0]||'[]'}
        : action === 'saveCourseConfig' ? {configJsonString:args[0]||'{}'} : {timeSlotsJsonString:args[0]||'[]'};
      Promise.resolve(bridge(action, payload, id)).then(value => callback(id, true, value), error => callback(id, false, error));
    });
  }
  window.shiguangBridgePromise = window.AndroidBridgePromise = promises;
  window.shiguangBridge = window.AndroidBridge = {
    showToast: message => bridge('showToast', {message}),
    notifyTaskCompletion: () => bridge('notifyTaskCompletion', {})
  };
  const mount = () => {
    if (document.querySelector('#le-school-import-toolbar')) return;
    const host = document.createElement('div'); host.id = 'le-school-import-toolbar'; host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const shadow = host.attachShadow({mode:'open'}); shadow.innerHTML = `<style>*{box-sizing:border-box}div{font:13px system-ui;background:#162b35;color:#fff;border-radius:14px;padding:10px;box-shadow:0 8px 28px #0006;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:calc(100vw - 32px)}button{border:0;border-radius:9px;padding:9px 13px;cursor:pointer;background:#fff;color:#17333e;font-weight:650}button.primary{background:#61c1d0;color:#092830}span{max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><div><span data-status>登录后进入课表页面</span><button data-back>后退</button><button data-close>关闭</button><button class="primary" data-import>导入当前课表</button></div>`;
    // 关闭走三条重试：Android WebView 对「同一 URL 的重复导航」不再触发
    // shouldOverrideUrlLoading，只发一次可能被吞（历史教训：状态停在「正在关闭…」）。
    // 带随机 query 保证每次 URL 都不同；关成功了页面销毁，后续 setTimeout 自然不执行。
    const close = () => {
      setStatus('正在关闭…');
      let n = 0;
      const go = () => { location.href = 'letime-import://close?r=' + (++n) + '-' + Date.now(); };
      go();
      setTimeout(go, 600);
      setTimeout(go, 1600);
    };
    shadow.querySelector('[data-back]').onclick = () => { if (history.length > 1) history.back(); else close(); };
    shadow.querySelector('[data-close]').onclick = close;
    shadow.querySelector('[data-import]').onclick = () => { setStatus('正在执行学校适配脚本…'); location.href = 'letime-import://execute'; };
    document.documentElement.appendChild(host);
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mount, {once:true}) : mount();
})();
"#;

/// 关闭教务导入窗口。
///
/// **Android 上的坑（v0.37.12 修复）**：tauri 的 `window.close()` 在 Android 只是
/// 丢弃 Rust 侧引用（tao 的 Android Window 没有 Drop/finish 逻辑，runtime 也永远
/// 收不到 Destroyed 事件），承载教务页面的 Activity 会一直留在返回栈上 —— 用户点
/// 「关闭」只看到状态停在「正在关闭…」。所以 Android 必须经 wry 的 `JniHandle`
/// 对承载 Activity 直接调 `finish()`；随后的 `destroy()` 负责清掉 tauri/runtime
/// 层的引用。桌面端 `destroy()` 等价于原来的 `close()`（不等 closeRequested，更干脆）。
fn school_import_close(app: &AppHandle, label: &str) {
  if let Some(window) = app.get_webview_window(label) {
    #[cfg(target_os = "android")]
    {
      let _ = window.with_webview(|webview| {
        webview.jni_handle().exec(|env, activity, _webview| {
          let _ = env.call_method(activity, "finish", "()V", &[]);
        });
      });
    }
    let _ = window.destroy();
  }
}

fn school_import_bridge(app: &AppHandle, label: &str, encoded: &str) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| format!("教务回传解码失败: {e}"))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("教务回传数据超过 2 MB".into());
    }
    let message = String::from_utf8(bytes).map_err(|e| format!("教务回传不是 UTF-8: {e}"))?;
    let value: Value =
        serde_json::from_str(&message).map_err(|e| format!("教务回传 JSON 无效: {e}"))?;
    let allowed = [
        "saveImportedCourses",
        "saveCourseConfig",
        "savePresetTimeSlots",
        "notifyTaskCompletion",
    ];
    let action = value.get("action").and_then(Value::as_str).unwrap_or("");
    if !allowed.contains(&action) {
        return Err("教务回传操作不受支持".into());
    }
    app.emit_to("main", "school-import-message", message)
        .map_err(|e| format!("发送教务回传失败: {e}"))?;
    // 适配器的最后一步会调 notifyTaskCompletion，收到它就说明导入流程已经走完 ——
    // 主动把教务窗口关掉，用户不必自己去找关闭按钮（手机端尤其重要：
    // 没有标题栏关闭按钮，只有工具栏那一个出口）。
    if action == "notifyTaskCompletion" {
        school_import_close(app, label);
    }
    Ok(())
}

/// 教务导入窗口的 label 序号。
///
/// label 必须每次递增：Android 上 runtime 收不到 Destroyed 事件，tauri manager 里的
/// 窗口/webview 注册表条目关不掉，第二次用相同 label build 会直接报
/// 「a webview with label … already exists」。递增 label 让每次导入都是全新注册。
static IMPORT_WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
async fn school_import_open(
    app: AppHandle,
    url: String,
    adapter_script: String,
    title: String,
) -> Result<(), String> {
    if adapter_script.len() > 2 * 1024 * 1024 {
        return Err("学校适配脚本超过 2 MB".into());
    }
    let parsed: Url = url.parse().map_err(|e| format!("教务网址无效: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "about") {
        return Err("教务网址仅支持 http/https".into());
    }
    let seq = IMPORT_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("school-import-{seq}");
    // 上一扇教务窗还开着就先关掉（桌面端真的关；Android 端 finish Activity + 清引用）
    if seq > 1 {
        school_import_close(&app, &format!("school-import-{}", seq - 1));
    }
    let app_for_navigation = app.clone();
    let script_for_navigation = adapter_script.clone();
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(format!(
            "时光课程表 · {}",
            title.chars().take(60).collect::<String>()
        ))
        .inner_size(1100.0, 780.0)
        .initialization_script(SCHOOL_IMPORT_BOOTSTRAP)
        .on_navigation(move |target| {
            if target.scheme() != "letime-import" {
                return true;
            }
            match target.host_str().unwrap_or("") {
                "execute" => {
                    if let Some(window) = app_for_navigation.get_webview_window(&label) {
                        let _ = window.eval(script_for_navigation.clone());
                    }
                }
                "bridge" => {
                    let encoded = target.path().trim_start_matches('/');
                    let _ = school_import_bridge(&app_for_navigation, &label, encoded);
                }
                // 关闭教务窗口。手机端没有窗口标题栏的关闭按钮，系统返回键的行为也由
                // Tauri 的 Activity 决定，所以必须给工具栏一条自己的退出通道。
                // 注意 query 带 seq：Android WebView 对相同 URL 的重复导航不再回调，
                // 工具栏的重试按钮靠它保证每次都触发 on_navigation。
                "close" => {
                    school_import_close(&app_for_navigation, &label);
                }
                _ => {}
            }
            false
        });
    // Android 上必须指定我们自己的 Activity 类：tauri 默认路径拿不到独立 Activity，
    // close 时也没有可 finish 的目标。SchoolImportActivity 在 gen/android 的
    // AndroidManifest.xml 注册（gen/ 不入 git，内容备份在 docs/CHANGELOG-v0.37.12.md，
    // scripts/test-school-import.mjs 会守）。
    // `center()` 在 tauri 里属于 `#[cfg(desktop)]` 门控的 impl 块，Android 上没有这个方法。
    // 不门控的话 Windows 能编过、Android 直接 E0599 编译失败（v0.25.0 起一直如此）。
    #[cfg(target_os = "android")]
    let builder = builder.activity_name("SchoolImportActivity");
    #[cfg(desktop)]
    let builder = builder.center();
    builder
        .build()
        .map_err(|e| format!("打开教务登录窗口失败: {e}"))?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct AiSecretConfig {
    #[serde(rename = "baseUrl")]
    base_url: String,
    api_key: String,
    model: String,
}

#[derive(serde::Serialize)]
struct AiVaultStatus {
    configured: bool,
    #[serde(rename = "baseUrl")]
    base_url: String,
    model: String,
    #[serde(rename = "keyMasked")]
    key_masked: String,
}

/// 一条对话消息。`content` 允许两种形态：
///
/// - **纯字符串** —— 纯文本消息，v0.55.0 及之前的调用方全部沿用这一形态；
/// - **OpenAI 兼容的多模态 content 数组** ——
///   `[{"type":"text","text":"..."},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}]`
///
/// 为什么用 `serde_json::Value` 而不是定义枚举：这里要**原样透传**给上游。
/// 各家「OpenAI 兼容」端点在 content parts 上的字段并不一致（有的要 `detail`、
/// 有的不认多出来的键），本地拆解再重组只会把本来能用的端点挡在门外。
/// 校验交给 `inspect_ai_content`，它只读不写，不认识的结构直接拒绝。
#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct AiMessage {
    role: String,
    content: serde_json::Value,
}

fn ai_vault_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(".ai-vault.key"))
}

fn ai_vault_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("ai-vault.bin"))
}

fn restrict_secret_file(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

fn ai_vault_key(app: &AppHandle) -> Result<Vec<u8>, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let path = ai_vault_key_path(app)?;
    if path.exists() {
        let key = fs::read(&path).map_err(|e| format!("读取 AI 加密密钥失败: {e}"))?;
        if key.len() != 32 {
            return Err("AI 加密密钥长度异常".into());
        }
        return Ok(key);
    }
    let mut key = vec![0u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "生成 AI 加密密钥失败".to_string())?;
    fs::write(&path, &key).map_err(|e| format!("写入 AI 加密密钥失败: {e}"))?;
    restrict_secret_file(&path);
    Ok(key)
}

fn ai_encrypt(app: &AppHandle, plain: &[u8]) -> Result<Vec<u8>, String> {
    aead_encrypt(&ai_vault_key(app)?, plain)
}

fn ai_decrypt(app: &AppHandle, raw: &[u8]) -> Result<Vec<u8>, String> {
    aead_decrypt(&ai_vault_key(app)?, raw)
}

/// AES-256-GCM。密文格式：版本号(1) + nonce(12) + 密文+tag。
/// AI 凭据与插件密钥库共用同一个本机密钥文件（.ai-vault.key）。
fn aead_encrypt(key: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use ring::rand::{SecureRandom, SystemRandom};
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "初始化加密器失败".to_string())?;
    let less_safe = LessSafeKey::new(unbound);
    let mut nonce_bytes = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "生成加密随机数失败".to_string())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plain.to_vec();
    less_safe
        .seal_in_place_append_tag(nonce, Aad::empty(), &mut in_out)
        .map_err(|_| "凭据加密失败".to_string())?;
    let mut out = Vec::with_capacity(1 + nonce_bytes.len() + in_out.len());
    out.push(1);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&in_out);
    Ok(out)
}

fn aead_decrypt(key: &[u8], raw: &[u8]) -> Result<Vec<u8>, String> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    if raw.len() < 1 + 12 + 16 || raw[0] != 1 {
        return Err("凭据文件格式不受支持".into());
    }
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "初始化解密器失败".to_string())?;
    let less_safe = LessSafeKey::new(unbound);
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&raw[1..13]);
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = raw[13..].to_vec();
    let plain = less_safe
        .open_in_place(nonce, Aad::empty(), &mut in_out)
        .map_err(|_| "凭据解密失败，可能已损坏或密钥已变化".to_string())?;
    Ok(plain.to_vec())
}

fn load_ai_secret(app: &AppHandle) -> Result<AiSecretConfig, String> {
    let path = ai_vault_data_path(app)?;
    if !path.exists() {
        return Err("尚未配置 AI Base URL / API Key".into());
    }
    let raw = fs::read(&path).map_err(|e| format!("读取 AI 凭据失败: {e}"))?;
    let plain = ai_decrypt(app, &raw)?;
    serde_json::from_slice(&plain).map_err(|e| format!("AI 凭据解析失败: {e}"))
}

fn mask_api_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "••••••••".into();
    }
    let head: String = chars.iter().take(3).copied().collect();
    let tail: String = chars.iter().skip(chars.len() - 4).copied().collect();
    format!("{head}••••••{tail}")
}

fn validate_ai_base_url(base_url: &str) -> Result<(), String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("Base URL 不能为空".into());
    }
    if !base.starts_with("https://") && !base.starts_with("http://") {
        return Err("Base URL 仅支持 http/https".into());
    }
    Ok(())
}

fn ai_chat_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

#[tauri::command]
fn ai_vault_save(
    app: AppHandle,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<AiVaultStatus, String> {
    validate_ai_base_url(&base_url)?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名称不能为空".into());
    }
    let existing = load_ai_secret(&app).ok();
    let key = if api_key.trim().is_empty() {
        existing
            .as_ref()
            .map(|x| x.api_key.clone())
            .ok_or("首次保存时必须填写 API Key")?
    } else {
        api_key.trim().to_string()
    };
    let secret = AiSecretConfig {
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        api_key: key,
        model,
    };
    let plain = serde_json::to_vec(&secret).map_err(|e| format!("AI 凭据序列化失败: {e}"))?;
    let encrypted = ai_encrypt(&app, &plain)?;
    let path = ai_vault_data_path(&app)?;
    let tmp = path.with_extension("bin.tmp");
    fs::write(&tmp, encrypted).map_err(|e| format!("写入 AI 凭据失败: {e}"))?;
    restrict_secret_file(&tmp);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("替换旧 AI 凭据失败: {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("保存 AI 凭据失败: {e}"))?;
    restrict_secret_file(&path);
    Ok(AiVaultStatus {
        configured: true,
        base_url: secret.base_url,
        model: secret.model,
        key_masked: mask_api_key(&secret.api_key),
    })
}

#[tauri::command]
fn ai_vault_status(app: AppHandle) -> Result<AiVaultStatus, String> {
    match load_ai_secret(&app) {
        Ok(secret) => Ok(AiVaultStatus {
            configured: true,
            base_url: secret.base_url,
            model: secret.model,
            key_masked: mask_api_key(&secret.api_key),
        }),
        Err(_) => Ok(AiVaultStatus {
            configured: false,
            base_url: String::new(),
            model: String::new(),
            key_masked: String::new(),
        }),
    }
}

#[tauri::command]
fn ai_vault_clear(app: AppHandle) -> Result<(), String> {
    let data_path = ai_vault_data_path(&app)?;
    if data_path.exists() {
        fs::remove_file(data_path).map_err(|e| format!("清除 AI 凭据失败: {e}"))?;
    }
    Ok(())
}

/* ── 插件密钥库：与 AI 凭据同机制的加密 KV，供插件保存密码、会话票据等敏感数据 ── */

type PluginVault = HashMap<String, HashMap<String, String>>;

fn plugin_vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("plugin-vault.bin"))
}

fn load_plugin_vault(app: &AppHandle) -> Result<PluginVault, String> {
    let path = plugin_vault_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = fs::read(&path).map_err(|e| format!("读取插件密钥库失败: {e}"))?;
    if raw.is_empty() {
        return Ok(HashMap::new());
    }
    let plain = ai_decrypt(app, &raw)?;
    serde_json::from_slice(&plain).map_err(|e| format!("插件密钥库解析失败: {e}"))
}

fn save_plugin_vault(app: &AppHandle, vault: &PluginVault) -> Result<(), String> {
    let plain = serde_json::to_vec(vault).map_err(|e| format!("插件密钥库序列化失败: {e}"))?;
    let encrypted = ai_encrypt(app, &plain)?;
    let path = plugin_vault_path(app)?;
    let tmp = path.with_extension("bin.tmp");
    fs::write(&tmp, encrypted).map_err(|e| format!("写入插件密钥库失败: {e}"))?;
    restrict_secret_file(&tmp);
    fs::rename(&tmp, &path).map_err(|e| format!("替换插件密钥库失败: {e}"))?;
    restrict_secret_file(&path);
    Ok(())
}

#[tauri::command]
fn plugin_vault_set(
    app: AppHandle,
    plugin_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    if !valid_plugin_id(&plugin_id) {
        return Err(format!("插件 ID 不合法: {plugin_id}"));
    }
    if key.trim().is_empty() {
        return Err("密钥库名不能为空".into());
    }
    let mut vault = load_plugin_vault(&app)?;
    vault.entry(plugin_id).or_default().insert(key, value);
    save_plugin_vault(&app, &vault)
}

#[tauri::command]
fn plugin_vault_get(
    app: AppHandle,
    plugin_id: String,
    key: String,
) -> Result<Option<String>, String> {
    if !valid_plugin_id(&plugin_id) {
        return Err(format!("插件 ID 不合法: {plugin_id}"));
    }
    Ok(load_plugin_vault(&app)?
        .get(&plugin_id)
        .and_then(|m| m.get(&key))
        .cloned())
}

#[tauri::command]
fn plugin_vault_del(app: AppHandle, plugin_id: String, key: String) -> Result<(), String> {
    if !valid_plugin_id(&plugin_id) {
        return Err(format!("插件 ID 不合法: {plugin_id}"));
    }
    let mut vault = load_plugin_vault(&app)?;
    if let Some(entry) = vault.get_mut(&plugin_id) {
        entry.remove(&key);
        if entry.is_empty() {
            vault.remove(&plugin_id);
        }
    }
    if vault.is_empty() {
        let path = plugin_vault_path(&app)?;
        if path.exists() {
            fs::remove_file(path).map_err(|e| format!("清除插件密钥库失败: {e}"))?;
        }
        return Ok(());
    }
    save_plugin_vault(&app, &vault)
}

/// 单张图片 data URL 的字符上限。base64 约为原始字节的 4/3，2_000_000 字符 ≈ 1.5 MB
/// 二进制 —— 截图经前端压到长边 900px 后通常在 100~300 KB，这个上限留了充足余量，
/// 同时挡住「直接把 20 MB 原图拖进来」这种会白烧 token 又被端点拒收的情况。
const AI_IMAGE_DATA_URL_MAX_CHARS: usize = 2_000_000;

/// 单次请求最多几张图。视觉模型按图计费，一次课表/通知截图通常 1~2 张；
/// 给到 6 张是留给「一周 5 天通知截图」这类批量场景的上限。
const AI_IMAGE_MAX_COUNT: usize = 6;

/// 读取一条消息的内容，返回 `(文本字符数, 图片张数)`。
///
/// 只读校验，不修改 `content` —— 原样透传给上游（见 `AiMessage` 的注释）。
/// 任何不认识的 content part 类型一律拒绝：白名单比黑名单安全，
/// 也避免上游端点收到半懂不懂的结构后返回一个更难查的 400。
fn inspect_ai_content(content: &serde_json::Value) -> Result<(usize, usize), String> {
    match content {
        serde_json::Value::String(text) => Ok((text.chars().count(), 0)),
        serde_json::Value::Array(parts) => {
            let mut chars = 0usize;
            let mut images = 0usize;
            for part in parts {
                let kind = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match kind {
                    "text" => {
                        chars += part
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .chars()
                            .count();
                    }
                    "image_url" => {
                        let url = part
                            .pointer("/image_url/url")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !url.starts_with("data:image/") {
                            return Err("图片必须是 data:image/* 内联数据（不接受远程 URL）".into());
                        }
                        if url.chars().count() > AI_IMAGE_DATA_URL_MAX_CHARS {
                            return Err("单张图片过大（超过约 1.5 MB），请先压缩或裁剪后重试".into());
                        }
                        images += 1;
                    }
                    other => return Err(format!("不支持的消息内容类型: {other}")),
                }
            }
            Ok((chars, images))
        }
        _ => Err("消息 content 必须是字符串或多模态数组".into()),
    }
}

#[tauri::command]
async fn ai_chat(
    app: AppHandle,
    messages: Vec<AiMessage>,
    temperature: Option<f64>,
) -> Result<String, String> {
    let secret = load_ai_secret(&app)?;
    validate_ai_base_url(&secret.base_url)?;
    if messages.is_empty() || messages.len() > 24 {
        return Err("AI 消息数量必须在 1～24 条之间".into());
    }
    // 文本按字符数封顶；图片单独计数与限长 —— 图片字节数不进 chars 统计，
    // 否则一张 300 KB 的截图会被算成 40 万「字符」而误触发「上下文过长」。
    let mut total_chars = 0usize;
    let mut total_images = 0usize;
    for m in &messages {
        let (chars, images) = inspect_ai_content(&m.content)?;
        total_chars += chars;
        total_images += images;
    }
    if total_chars > 60_000 {
        return Err("AI 上下文过长，请减少内容后重试".into());
    }
    if total_images > AI_IMAGE_MAX_COUNT {
        return Err(format!("一次最多分析 {AI_IMAGE_MAX_COUNT} 张图片"));
    }
    if messages
        .iter()
        .any(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant"))
    {
        return Err("AI 消息角色不合法".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(55))
        .build()
        .map_err(|e| format!("AI HTTP 客户端初始化失败: {e}"))?;
    let endpoint = ai_chat_endpoint(&secret.base_url);
    let body = json!({
        "model": secret.model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.2).clamp(0.0, 2.0),
    });
    let resp = client
        .post(endpoint)
        .bearer_auth(&secret.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {}", error_chain(&e)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 AI 响应失败: {}", error_chain(&e)))?;
    if !status.is_success() {
        let brief: String = text.chars().take(900).collect();
        return Err(format!("AI 接口返回 {}：{}", status.as_u16(), brief));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("AI 响应不是有效 JSON: {e}"))?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .or_else(|| value.pointer("/output_text").and_then(|v| v.as_str()))
        .ok_or_else(|| "AI 响应缺少 choices[0].message.content".to_string())?;
    Ok(content.to_string())
}

/// 首次启动的初始数据。
///
/// v0.37.17 起**刻意保持全空** —— 首启的四象限、时间块、收件箱都应该干干净净，
/// 让空状态自己引导用户建第一条任务，而不是先塞一堆「示例任务」假装很热闹。
/// 想给用户看的样例改走「设置 → 恢复示例数据」这类显式入口，不要塞回这里。
///
/// 注意 `load_data` 的判据是「data.json 不存在」，所以改这里只影响**新装用户**；
/// 已落盘旧数据的设备要清空得删掉 `data.json` 或走设置里的清空入口。
fn seed_data() -> Value {
    let today = js_datetoday();
    json!({
        "version": 1,
        "tasks": [],
        "blocks": [],
        "settings": { "lastView": "quadrant", "lastDate": today },
        "plugins": {}
    })
}

/// 本地日期 YYYY-MM-DD（不依赖 chrono，用天总数换算）
///
/// 仅供 `seed_data()` 写默认 `settings.lastDate` 使用 —— 空 seed 之后这是唯一调用点，
/// 所以别当它是通用工具函数搬走。
fn js_datetoday() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = (secs + 8 * 3600) / 86400; // 按东八区
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<Value, String> {
    let path = data_dir(&app)?.join("data.json");
    if !path.exists() {
        let seed = seed_data();
        fs::write(&path, serde_json::to_vec_pretty(&seed).unwrap())
            .map_err(|e| format!("写入初始数据失败: {e}"))?;
        return Ok(seed);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取数据失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("数据文件损坏: {e}"))
}

#[tauri::command]
fn save_data(app: AppHandle, data: Value) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let path = dir.join("data.json");
    let tmp = dir.join("data.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&data).unwrap())
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    // 原子替换，避免写一半崩溃丢数据
    fs::rename(&tmp, &path).map_err(|e| format!("替换数据文件失败: {e}"))?;
    Ok(())
}

#[derive(serde::Serialize)]
struct PluginInfo {
    id: String,
    dir: String,
}

/// 枚举用户插件目录：{data_dir}/plugins/<id>/manifest.json
#[tauri::command]
fn list_plugins(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
    let dir = plugins_dir(&app)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取插件目录失败: {e}"))?;
    for entry in entries.flatten() {
        let pdir = entry.path();
        if pdir.is_dir() {
            if pdir.join("manifest.json").exists() {
                if let Some(name) = pdir.file_name().and_then(|n| n.to_str()) {
                    out.push(PluginInfo {
                        id: name.to_string(),
                        dir: pdir.to_string_lossy().to_string(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// 读取插件文件内容（仅允许插件目录内的文件，防目录穿越）
#[tauri::command]
fn read_plugin_file(app: AppHandle, rel_path: String) -> Result<String, String> {
    let root = plugins_dir(&app)?;
    let target = root.join(&rel_path);
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canon_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Err(format!("插件文件不存在: {rel_path}")),
    };
    if !canon_target.starts_with(&canon_root) {
        return Err("禁止访问插件目录之外的文件".into());
    }
    fs::read_to_string(&canon_target).map_err(|e| format!("读取失败: {e}"))
}

/// 删除用户插件目录（仅允许 data_dir/plugins/<id> 一级目录，内置插件不可删除）
#[tauri::command]
fn delete_plugin(app: AppHandle, id: String) -> Result<(), String> {
    if id.contains('/') || id.contains('\\') || id == "." || id == ".." || id.trim().is_empty() {
        return Err("插件 ID 不合法".into());
    }
    let root = plugins_dir(&app)?;
    let target = root.join(&id);
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("插件目录异常: {e}"))?;
    let canon_target = target
        .canonicalize()
        .map_err(|_| format!("用户插件不存在: {id}"))?;
    if !canon_target.starts_with(&canon_root) || canon_target == canon_root {
        return Err("禁止删除插件目录之外的文件".into());
    }
    if !canon_target.is_dir() {
        return Err("目标不是插件目录".into());
    }
    if !canon_target.join("manifest.json").exists() {
        return Err("目标目录缺少 manifest.json，拒绝删除".into());
    }
    fs::remove_dir_all(&canon_target).map_err(|e| format!("删除插件失败: {e}"))
}

fn valid_plugin_id(id: &str) -> bool {
    !id.trim().is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// 从 zip 导入一个或多个用户插件。支持 `<id>/manifest.json` 和 zip 根目录直接放 manifest.json 两种格式。
#[tauri::command]
fn import_plugin_zip(app: AppHandle, bytes: Vec<u8>) -> Result<Vec<String>, String> {
    use std::io::{Cursor, Read};
    let root = plugins_dir(&app)?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("ZIP 无法打开: {e}"))?;

    // 先定位 manifest，确定 zip 中的源前缀和最终插件 id。
    let mut plugins: Vec<(String, String)> = Vec::new(); // (source prefix, plugin id)
    for i in 0..archive.len() {
        let mut f = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 失败: {e}"))?;
        let Some(path) = f.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        if path.file_name().and_then(|x| x.to_str()) != Some("manifest.json") {
            continue;
        }
        let mut raw = String::new();
        f.read_to_string(&mut raw)
            .map_err(|e| format!("读取 manifest.json 失败: {e}"))?;
        let man: Value =
            serde_json::from_str(&raw).map_err(|e| format!("manifest.json 格式错误: {e}"))?;
        let id = man
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !valid_plugin_id(&id) {
            return Err(format!("插件 ID 不合法: {id}"));
        }
        let prefix = path
            .parent()
            .map(|x| x.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        plugins.push((prefix, id));
    }
    if plugins.is_empty() {
        return Err("ZIP 中未找到 manifest.json".into());
    }
    plugins.sort();
    plugins.dedup();

    let mut imported = Vec::new();
    for (prefix, id) in &plugins {
        let dest = root.join(id);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| format!("覆盖旧插件失败: {e}"))?;
        }
        fs::create_dir_all(&dest).map_err(|e| format!("创建插件目录失败: {e}"))?;

        for i in 0..archive.len() {
            let mut f = archive
                .by_index(i)
                .map_err(|e| format!("读取 ZIP 失败: {e}"))?;
            let Some(path) = f.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            let norm = path.to_string_lossy().replace('\\', "/");
            let rel = if prefix.is_empty() {
                // 根目录插件：保留 assets/data 等子目录。
                norm.clone()
            } else {
                let pre = format!("{prefix}/");
                if !norm.starts_with(&pre) {
                    continue;
                }
                norm[pre.len()..].to_string()
            };
            if rel.is_empty() {
                continue;
            }
            let out = dest.join(&rel);
            if f.is_dir() {
                fs::create_dir_all(&out).map_err(|e| format!("创建目录失败: {e}"))?;
            } else {
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
                }
                let mut data = Vec::new();
                f.read_to_end(&mut data)
                    .map_err(|e| format!("解压插件失败: {e}"))?;
                fs::write(&out, data).map_err(|e| format!("写入插件文件失败: {e}"))?;
            }
        }
        if !dest.join("manifest.json").exists() {
            return Err(format!("插件 {id} 导入后缺少 manifest.json"));
        }
        imported.push(id.clone());
    }
    Ok(imported)
}

/// 将所选用户插件打包为 zip，返回 base64，前端负责保存下载。
#[tauri::command]
fn export_plugins_zip(app: AppHandle, ids: Vec<String>) -> Result<String, String> {
    use base64::Engine as _;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    if ids.is_empty() {
        return Err("请先选择要导出的用户插件".into());
    }
    let root = plugins_dir(&app)?;
    let mut cur = Cursor::new(Vec::<u8>::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cur);
        let opt = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for id in ids {
            if !valid_plugin_id(&id) {
                return Err(format!("插件 ID 不合法: {id}"));
            }
            let dir = root.join(&id);
            if !dir.join("manifest.json").exists() {
                return Err(format!("用户插件不存在: {id}"));
            }
            let mut stack = vec![dir.clone()];
            while let Some(path) = stack.pop() {
                for entry in fs::read_dir(&path).map_err(|e| format!("读取插件失败: {e}"))? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let p = entry.path();
                    if p.is_dir() {
                        stack.push(p);
                        continue;
                    }
                    let rel = p
                        .strip_prefix(&dir)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/");
                    writer
                        .start_file(format!("{id}/{rel}"), opt)
                        .map_err(|e| format!("创建 ZIP 失败: {e}"))?;
                    let data = fs::read(&p).map_err(|e| format!("读取插件文件失败: {e}"))?;
                    writer
                        .write_all(&data)
                        .map_err(|e| format!("写入 ZIP 失败: {e}"))?;
                }
            }
        }
        writer.finish().map_err(|e| format!("完成 ZIP 失败: {e}"))?;
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(cur.into_inner()))
}

/// 把前端给的文本保存到系统下载目录（重名自动追加 " (n)"），返回落盘的完整路径。
/// WebView 里 <a download> 对 blob: 的下载在部分平台静默失败，统一走这里真正落盘。
#[tauri::command]
fn save_download(app: AppHandle, name: String, contents: String) -> Result<String, String> {
    save_to_download_dir(&app, &name, contents.as_bytes())
}

/// 二进制版落盘：收 base64，解码后写进同一个下载目录。
/// 走 `save_download` 传附件会直接坏掉 —— 那个按 UTF-8 文本写入，docx / pdf 这类
/// 二进制根本进不来。入参格式与 `http_fetch` 的 `binary: true` 一致（STANDARD 字母表），
/// 插件抓到即可存，不用自己再转一遍。
#[tauri::command]
fn save_download_base64(app: AppHandle, name: String, base64: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim().as_bytes())
        .map_err(|e| format!("附件数据不完整（base64 解码失败）: {e}"))?;
    save_to_download_dir(&app, &name, &bytes)
}

/// 下载目录落盘的公共部分：校验文件名 → 定位目录 → 重名追加 " (n)" → 写字节。
fn save_to_download_dir(app: &AppHandle, raw_name: &str, bytes: &[u8]) -> Result<String, String> {
    let name = raw_name.trim();
    if name.is_empty() || name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Err("文件名不合法".into());
    }
    // 优先系统下载目录；平台没有（如部分 Android）则回退应用数据目录
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("无法定位下载目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建下载目录: {e}"))?;

    let target = dir.join(name);
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = target
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut final_path = target.clone();
    let mut counter = 1u32;
    while final_path.exists() {
        final_path = dir.join(if ext.is_empty() {
            format!("{stem} ({counter})")
        } else {
            format!("{stem} ({counter}).{ext}")
        });
        counter += 1;
    }
    fs::write(&final_path, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(final_path.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct AppInfo {
    version: String,
    os: String,
    arch: String,
    data_dir: String,
}

#[tauri::command]
fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: data_dir(&app)?.to_string_lossy().to_string(),
    })
}

#[derive(serde::Serialize)]
struct HttpResp {
    status: u16,
    body: String,
    #[serde(rename = "finalUrl")]
    final_url: String,
    #[serde(rename = "contentType")]
    content_type: String,
}

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 全应用共享的 HTTP 客户端（连接池 / UA / 超时统一在这里）。
///
/// `pub(crate)`：更新检查模块（`update.rs`）要复用同一份客户端 ——
/// 它已经带了 `LeTimeManagement/<版本>` 的 UA，GitHub API 正需要这个头。
pub(crate) fn shared_http_client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = HTTP_CLIENT.get() {
        return Ok(c);
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Mozilla/5.0 LeTimeManagement/",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(std::time::Duration::from_secs(6))
        .timeout(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;
    let _ = HTTP_CLIENT.set(client);
    HTTP_CLIENT
        .get()
        .ok_or_else(|| "HTTP 客户端初始化失败".into())
}

/// 从 Content-Type 头里取 charset（`text/html; charset=gb2312` → `gb2312`）。
/// 也可直接喂一个 `<meta>` 标签字符串，规则相同。
fn charset_from_content_type(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    let idx = lower.find("charset")?;
    let rest = &content_type[idx + "charset".len()..];
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let val: String = rest
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    if val.is_empty() {
        None
    } else {
        Some(val)
    }
}

/// 从 HTML 头部（前 4KB）的 `<meta>` 里嗅探 charset。
///
/// 中文站点常见做法：响应头只给 `text/html`（**不带 charset**），编码只在
/// `<meta http-equiv=Content-Type content="text/html; charset=gb2312">`
/// 或 `<meta charset="gbk">` 里声明。reqwest 的 `text()` **不读 meta**，
/// 这种情况会按 UTF-8 解，标题就成了一串 `�`。
fn charset_from_meta(bytes: &[u8]) -> Option<String> {
    let head_len = bytes.len().min(4096);
    let head = String::from_utf8_lossy(&bytes[..head_len]);
    let lower = head.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find("<meta") {
        let start = cursor + rel;
        let end = lower[start..]
            .find('>')
            .map(|i| start + i)
            .unwrap_or(lower.len());
        if lower[start..end].contains("charset") {
            if let Some(v) = charset_from_content_type(&head[start..end]) {
                return Some(v);
            }
        }
        cursor = end.max(start + "<meta".len());
        if cursor >= lower.len() {
            break;
        }
    }
    None
}

/// 正文本身是不是一份标记文档（而不是「含有标记片段的 JSON」）。
/// 首字符必须是 `<`，且 512 字节内出现 html / doctype / head / meta / ?xml 之一。
/// 这道判别是必要的：否则 `{"html":"<meta charset=gbk>"}` 这种 JSON 会被误判成
/// 声明了 gbk，反而把本来正确的 UTF-8 中文解坏。
fn looks_like_markup(bytes: &[u8]) -> bool {
    let head_len = bytes.len().min(512);
    let head = String::from_utf8_lossy(&bytes[..head_len]);
    let head = head.trim_start_matches('\u{feff}');
    if !head.trim_start().starts_with('<') {
        return false;
    }
    let lower = head.to_ascii_lowercase();
    ["<html", "<!doctype", "<head", "<meta", "<?xml"]
        .iter()
        .any(|k| lower.contains(k))
}

/// 按声明编码解码响应体：**响应头 charset → HTML meta charset → UTF-8 兜底**。
///
/// ⚠️ 不要退回 `resp.text()` —— 它只认响应头，中文站点（老 IIS / gov / edu 站尤甚）
/// 经常只在 meta 里声明 gb2312，用它解出来就是满屏替换字符。
/// 只在 content-type 为空或 html/xml、**且正文看起来确实是标记文档**时才嗅探 meta ——
/// JSON 按规范恒 UTF-8，不该被正文里偶然出现的 `<meta charset=...>` 带偏。
fn decode_body(bytes: &[u8], content_type: &str) -> String {
    let ct = content_type.to_ascii_lowercase();
    let htmlish = ct.is_empty() || ct.contains("html") || ct.contains("xml");
    let encoding = charset_from_content_type(content_type)
        .or_else(|| {
            if htmlish && looks_like_markup(bytes) {
                charset_from_meta(bytes)
            } else {
                None
            }
        })
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim().as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

/// 把错误的 cause 链摊平成一行。
///
/// ⚠️ 打 reqwest 的错**永远不要直接 `{e}`**：0.12 的 `Display` 只有
/// `error sending request for url (…)` 这一句，真正的成因（DNS 解析失败、TCP 连不上、
/// TLS 握手断、客户端超时）全藏在 `source()` 里。吞掉 source 的后果是插件界面上
/// 只剩一句没人能看懂的英文，用户和开发者都只能猜（v0.102.0 警大学分视图就是这样）。
/// 最多摊三层，再深的是 hyper 的内部包装，只会把提示条撑爆。
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cause = e.source();
    let mut hops = 0;
    while let Some(next) = cause {
        if hops == 3 {
            out.push('…');
            break;
        }
        out.push_str(": ");
        out.push_str(&next.to_string());
        cause = next.source();
        hops += 1;
    }
    out
}

/// 插件网络桥：服务端抓取，绕开 WebView 的 CORS 限制
#[tauri::command]
async fn http_get(url: String) -> Result<HttpResp, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 地址".into());
    }
    let client = shared_http_client()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json, text/html;q=0.9, */*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", error_chain(&e)))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", error_chain(&e)))?;
    let body = decode_body(&bytes, &content_type);
    Ok(HttpResp {
        status,
        body,
        final_url,
        content_type,
    })
}

/// 图标抓取：把远程图标读成 data URL，供前端 `<img src>` 直接内联。
///
/// **为什么必须走原生侧**：Android 上 Tauri 用 `WebViewAssetLoader`（默认 scheme = https），
/// 页面来源是 `https://tauri.localhost`；WebView 自 API 21 起默认
/// `MIXED_CONTENT_NEVER_ALLOW`，release 版还叠了一道 `usesCleartextTraffic="false"`
/// ⇒ 学校网站常见的 `http://…/favicon.ico` 用 `<img src>` 直接引用会被**静默拦掉**。
/// 桌面端页面来源是 `http://tauri.localhost`（明文页面加载明文图片不算混合内容），
/// 所以同一个站点在 Windows 上图标正常、在 APK 上消失 —— 只看桌面端永远复现不了。
/// 走 reqwest 抓取完全不受 WebView 策略约束，顺带绕开防盗链，且转成 data URL 后
/// 能随插件 storage 落盘，离线也显示得出来。
///
/// **不收 SVG**：SVG 是文档不是位图，内联等于把第三方文档塞进应用；学校站点用不到，直接拒。
#[tauri::command]
async fn http_get_icon(url: String) -> Result<String, String> {
    /// 图标上限。正常 favicon 1~30 KB，给足余量但必须封顶 ——
    /// 否则一个指向大文件的 URL 能把几十 MB 灌进 data.json。
    const MAX_ICON_BYTES: usize = 256 * 1024;
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 地址".into());
    }
    let client = shared_http_client()?;
    let resp = client
        .get(&url)
        .header("Accept", "image/*,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", error_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // 有 Content-Length 就先挡一道，省得白读一遍大文件
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_ICON_BYTES {
            return Err("图标文件过大".into());
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", error_chain(&e)))?;
    if bytes.len() > MAX_ICON_BYTES {
        return Err("图标文件过大".into());
    }
    let mime =
        icon_mime(&content_type, &bytes).ok_or_else(|| "响应不是可用的图标格式".to_string())?;
    use base64::Engine as _;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// 判定图标 MIME：**魔数优先，认不出才退到响应头**。
///
/// 为什么不只信响应头：高校站点的图标大量由 IIS / 老旧 CMS 提供，
/// `Content-Type: text/plain`、`application/octet-stream` 甚至空值都常见 ——
/// 只信头会把好图标判死。反过来只信魔数又认不出 webp 这类容器，所以两者结合。
///
/// 404 页面是这里最需要挡掉的东西：站点把 `/favicon.ico` 回落到首页 HTML，
/// 魔数对不上、头又是 `text/html` ⇒ 返回 `None`，前端走首字母兜底而不是内联一段 HTML。
fn icon_mime(content_type: &str, bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png".into());
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg".into());
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif".into());
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp".into());
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp".into());
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon".into());
    }
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    // 魔数认不出时才信头，且只接受明确的位图 —— svg 是文档，一律拒。
    if ct.starts_with("image/") && !ct.contains("svg") {
        return Some(ct);
    }
    None
}

/// 用系统默认浏览器打开外部链接（插件点击消息详情用）
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 链接".into());
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return open_url_with_shell_execute(&url);
    }
    #[cfg(not(target_os = "windows"))]
    {
        return app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("打开失败: {e}"));
    }
}

#[cfg(target_os = "windows")]
fn open_url_with_shell_execute(url: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = OsStr::new(url).encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if result <= 32 {
        return Err(format!("打开失败: ShellExecuteW 返回 {result}"));
    }
    Ok(())
}

/// 在 U-Time 自己的 WebView 窗口中打开普通网页。
///
/// 窗口 label 每次递增，避免 Android runtime 已销毁的 WebView 仍残留在注册表里；
/// capability 只授权 `main`，因此远程页面拿不到任何 Tauri IPC 权限。
///
/// ⚠️ **必须是 `async`**：同步命令在主线程的 IPC 回调里执行，而 `build()` 要等
/// WebView2 控制器创建完成的回调 —— 那个回调同样只能由主线程的事件循环派发。
/// 在主线程里再入主线程就是死锁：窗口框画出来了、内容永远是白的，整个应用一起卡住。
/// 走 async 时命令在 worker 线程执行，`build()` 把创建请求代理给事件循环，主线程
/// 照常泵消息。教务导入窗口（`school_import_open`）一直是这么写的，所以没踩到。
static BROWSER_WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

const INTERNAL_BROWSER_BOOTSTRAP: &str = r#"
(function () {
  if (window.__leInternalBrowserBootstrap) return;
  window.__leInternalBrowserBootstrap = true;

  const toHttpUrl = (raw) => {
    try {
      const href = new URL(String(raw || ""), location.href).href;
      return /^https?:/i.test(href) ? href : "";
    } catch (_) {
      return "";
    }
  };
  const openHere = (raw) => {
    const href = toHttpUrl(raw);
    if (href) location.href = href;
    return window;
  };

  window.open = function (url) {
    return openHere(url);
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    const link = target && target.closest ? target.closest("a[target]") : null;
    if (!link) return;
    const frame = String(link.getAttribute("target") || "").toLowerCase();
    if (!frame || frame === "_self") return;
    const href = toHttpUrl(link.getAttribute("href") || link.href);
    if (!href) return;
    event.preventDefault();
    location.href = href;
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || !form.getAttribute) return;
    const frame = String(form.getAttribute("target") || "").toLowerCase();
    if (frame && frame !== "_self") form.removeAttribute("target");
  }, true);
})();
"#;

#[tauri::command]
async fn open_internal(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("网页地址无效: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http/https 链接".into());
    }
    let seq = BROWSER_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("browser-{seq}");
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .initialization_script_for_all_frames(INTERNAL_BROWSER_BOOTSTRAP)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .title("U-Time · 网页")
        .inner_size(1100.0, 780.0);
    #[cfg(target_os = "android")]
    let builder = builder.activity_name("BrowserActivity");
    #[cfg(desktop)]
    let builder = builder.center();
    builder
        .build()
        .map_err(|e| format!("应用内打开网页失败: {e}"))?;
    Ok(())
}

fn is_chaoxing_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ["chaoxing.com"].iter().any(|root| {
        host == *root || host.ends_with(&format!(".{root}"))
    })
}

fn cookie_domain_matches_host(domain: &str, host: &str) -> bool {
    let domain = domain.trim_start_matches('.').trim_end_matches('.').to_ascii_lowercase();
    is_chaoxing_host(&domain)
        && (host.eq_ignore_ascii_case(&domain)
            || host.to_ascii_lowercase().ends_with(&format!(".{domain}")))
}

/// 从 native reqwest Cookie Jar 取当前有效的会话，并保留响应中的安全属性。
/// scope 只覆盖学习通域名；任意外站拿不到这批凭据。
fn chaoxing_webview_cookies(
    session: &HttpSession,
    target: &Url,
) -> Result<Vec<(String, tauri::webview::Cookie<'static>)>, String> {
    use reqwest::cookie::CookieStore as _;
    let target_host = target.host_str().ok_or("链接缺少主机名")?;
    if target.scheme() != "https" || !is_chaoxing_host(target_host) {
        return Err("学习通登录态仅允许注入 HTTPS 学习通域名".into());
    }
    let mut url_strings = vec![
        "https://passport2.chaoxing.com/".to_string(),
        "https://i.chaoxing.com/".to_string(),
        "https://notice.chaoxing.com/".to_string(),
        "https://mooc2-ans.chaoxing.com/".to_string(),
        "https://mooc1.chaoxing.com/".to_string(),
        "https://study.chaoxing.com/".to_string(),
        target.as_str().to_string(),
    ];
    url_strings.sort();
    url_strings.dedup();
    let captured = session.set_cookie_headers.lock().map_err(|_| "登录 Cookie 锁占用")?.clone();
    let mut out: Vec<(String, tauri::webview::Cookie<'static>)> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for url_string in url_strings {
        let request_url: Url = url_string.parse().map_err(|e| format!("Cookie URL 无效: {e}"))?;
        let Some(host) = request_url.host_str() else { continue };
        if !is_chaoxing_host(host) { continue; }
        let Some(header) = session.jar.cookies(&request_url) else { continue };
        let Ok(header) = header.to_str() else { continue };
        for pair in header.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            let Some((name, value)) = pair.split_once('=') else { continue };
            let name = name.trim();
            let value = value.trim();
            if name.is_empty() { continue; }

            // 找当前 host/path 确实适用的最新 Set-Cookie，保留 HttpOnly/SameSite/Path。
            let mut selected: Option<String> = None;
            for record in captured.iter().rev() {
                let Ok(source_url) = record.url.parse::<Url>() else { continue };
                let Some(source_host) = source_url.host_str() else { continue };
                if !is_chaoxing_host(source_host) { continue; }
                let Ok(parsed) = tauri::webview::Cookie::parse(record.header.clone()) else { continue };
                if parsed.name() != name || parsed.value() != value { continue; }
                let domain = parsed.domain().unwrap_or(source_host);
                if !cookie_domain_matches_host(domain, host) { continue; }
                let path = parsed.path().unwrap_or("/");
                if !request_url.path().starts_with(path) { continue; }
                let mut raw = record.header.clone();
                if parsed.domain().is_none() { raw.push_str(&format!("; Domain={source_host}")); }
                if parsed.path().is_none() { raw.push_str("; Path=/"); }
                selected = Some(raw);
                break;
            }

            // 旧版/手动 Cookie 登录没有 Set-Cookie 元数据；按最窄 host-only 作用域补齐。
            let raw = selected.unwrap_or_else(|| {
                format!("{name}={value}; Domain={host}; Path=/; Secure")
            });
            let cookie = tauri::webview::Cookie::parse(raw)
                .map_err(|_| "学习通 Cookie 格式无效，未打开浏览器".to_string())?
                .into_owned();
            let domain = cookie.domain().unwrap_or(host);
            if !cookie_domain_matches_host(domain, host) { continue; }
            let key = format!("{}\u{1f}{}\u{1f}{}\u{1f}{}", cookie.name(), cookie.value(), domain, cookie.path().unwrap_or("/"));
            if seen.insert(key) { out.push((url_string.clone(), cookie)); }
        }
    }
    if out.is_empty() {
        return Err("插件会话中没有可传给浏览器的有效学习通 Cookie，请先在插件刷新登录".into());
    }
    Ok(out)
}
#[cfg(target_os = "android")]
fn set_android_webview_cookies(
    window: &tauri::WebviewWindow,
    cookies: Vec<(String, String)>,
) -> Result<(), String> {
    use jni::objects::JValue;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window.with_webview(move |webview| {
        webview.jni_handle().exec(move |env, _activity, _native_webview| {
            let result = (|| -> Result<(), String> {
                let manager = env.call_static_method(
                    "android/webkit/CookieManager", "getInstance",
                    "()Landroid/webkit/CookieManager;", &[],
                ).map_err(|e| e.to_string())?.l().map_err(|e| e.to_string())?;
                for (url, cookie) in &cookies {
                    let jurl = env.new_string(url).map_err(|e| e.to_string())?;
                    let jcookie = env.new_string(cookie).map_err(|e| e.to_string())?;
                    env.call_method(
                        &manager, "setCookie", "(Ljava/lang/String;Ljava/lang/String;)V",
                        &[JValue::Object(&jurl), JValue::Object(&jcookie)],
                    ).map_err(|e| e.to_string())?;
                }
                env.call_method(&manager, "flush", "()V", &[]).map_err(|e| e.to_string())?;
                Ok(())
            })();
            let _ = tx.send(result);
        });
    }).map_err(|e| format!("无法连接 Android WebView: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|e| format!("等待 Android CookieManager 超时: {e}"))?
}

/// 学习通插件专用：native 写入会话 Cookie 后再导航；Cookie 不经过 URL 或页面 JS。
#[tauri::command]
async fn open_internal_with_http_session(
    app: AppHandle,
    state: State<'_, HttpSessions>,
    sid: String,
    url: String,
) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("网页地址无效: {e}"))?;
    let cookies = {
        let sessions = state.0.lock().map_err(|_| "会话表被占用")?;
        let session = sessions.get(&sid).ok_or("学习通会话不存在或已过期，请刷新插件登录")?;
        chaoxing_webview_cookies(session, &parsed)?
    };
    let blank: Url = "about:blank".parse().map_err(|e| format!("空白页地址无效: {e}"))?;
    let seq = BROWSER_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("browser-{seq}");
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(blank))
        .initialization_script_for_all_frames(INTERNAL_BROWSER_BOOTSTRAP)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .title("U-Time · 网页")
        .inner_size(1100.0, 780.0);
    #[cfg(target_os = "android")]
    let builder = builder.activity_name("BrowserActivity");
    #[cfg(desktop)]
    let builder = builder.center();
    let window = builder.build().map_err(|e| format!("应用内打开网页失败: {e}"))?;

    #[cfg(target_os = "android")]
    set_android_webview_cookies(
        &window,
        cookies.into_iter().map(|(cookie_url, cookie)| (cookie_url, cookie.to_string())).collect(),
    )?;
    #[cfg(not(target_os = "android"))]
    for (_, cookie) in cookies {
        window.set_cookie(cookie).map_err(|e| format!("写入应用内网页登录态失败: {e}"))?;
    }
    window.navigate(parsed).map_err(|e| format!("带登录态导航失败: {e}"))?;
    Ok(())
}
/* ── 局域网联动：手机/小程序作为遥控端 ── */

struct LanHandle(Mutex<Option<lan::LanInstance>>);

#[tauri::command]
fn lan_start(
    app: AppHandle,
    handle: State<LanHandle>,
    port: u16,
    token: String,
    allow_push: bool,
) -> Result<String, String> {
    let quit = Arc::new(AtomicBool::new(false));
    let data_path = data_dir(&app)?.join("data.json");
    let (url, push) = lan::spawn_server(app, port, token.clone(), data_path, quit.clone(), allow_push)?;
    *handle.0.lock().map_err(|_| "锁占用")? = Some(lan::LanInstance {
        quit,
        url: url.clone(),
        port,
        token,
        push,
    });
    Ok(url)
}

/// 手机推过来的快照：桌面端确认之后取原文。
/// 只认当前那条 pending，取不到就是「已经不作数了」—— 前端此时不该再覆盖本机。
#[tauri::command]
fn lan_push_take(handle: State<LanHandle>, id: String) -> Result<String, String> {
    let guard = handle.0.lock().map_err(|_| "锁占用")?;
    let inst = guard.as_ref().ok_or("联动服务没在运行")?;
    inst.push.take(&id).ok_or_else(|| "这次推送已经过期或被更新的推送顶掉".to_string())
}

/// 把桌面端的决定回给手机（接收 / 拒绝），note 是给对方看的原因。
/// 返回 false 同样是「这次不作数了」。
#[tauri::command]
fn lan_push_resolve(handle: State<LanHandle>, id: String, approve: bool, note: String) -> Result<bool, String> {
    let guard = handle.0.lock().map_err(|_| "锁占用")?;
    let inst = guard.as_ref().ok_or("联动服务没在运行")?;
    Ok(inst.push.resolve(&id, approve, &note))
}

#[tauri::command]
fn lan_stop(handle: State<LanHandle>) -> Result<(), String> {
    if let Some(inst) = handle.0.lock().map_err(|_| "锁占用")?.take() {
        inst.quit.store(true, std::sync::atomic::Ordering::Relaxed);
        // 发一个哑请求解除 recv 阻塞，让服务线程退出
        if let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", inst.port)) {
            use std::io::Write as _;
            let _ = s.write_all(
                format!(
                    "GET /quit?token={} HTTP/1.1\r\nHost: localhost\r\n\r\n",
                    inst.token
                )
                .as_bytes(),
            );
        }
        // 等监听端口真正释放再返回（最多 ~1.5s），
        // 否则「停止 → 立刻启动」会撞上端口占用报「端口启动失败」。
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        while std::time::Instant::now() < deadline {
            // connect 成功 = 端口仍被旧服务占着；connect 失败 = 已释放
            if std::net::TcpStream::connect(("127.0.0.1", inst.port)).is_err() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    }
    Ok(())
}

#[tauri::command]
fn lan_status(handle: State<LanHandle>) -> Result<Value, String> {
    Ok(match handle.0.lock().map_err(|_| "锁占用")?.as_ref() {
        Some(inst) => json!({ "running": true, "url": inst.url }),
        None => json!({ "running": false }),
    })
}

/// DES-ECB(PKCS5) 加密并输出 hex —— 超星登录等场景用（RustCrypto 实现，保证正确性）
#[tauri::command]
fn des_ecb_encrypt_hex(plain: String, key: String) -> Result<String, String> {
    use des::Des;
    use ecb::cipher::{BlockEncryptMut, KeyInit};
    use ecb::Encryptor;
    if key.as_bytes().len() != 8 {
        return Err("DES 密钥必须为 8 字节".into());
    }
    type DesEcb = Encryptor<Des>;
    let mut cipher =
        DesEcb::new_from_slice(key.as_bytes()).map_err(|e| format!("密钥初始化失败: {e}"))?;
    let mut buf = plain.as_bytes().to_vec();
    let pad = 8 - (buf.len() % 8);
    buf.extend(std::iter::repeat(pad as u8).take(pad));
    for chunk in buf.chunks_mut(8) {
        cipher.encrypt_block_mut(chunk.into());
    }
    Ok(hex::encode(buf))
}

/* ── 会话化 HTTP：带 Cookie Jar，供需要登录态的插件（如学习通）使用 ── */

/// 一个会话 = reqwest Client + 它的 Cookie Jar 句柄。
/// 留着 jar 引用是为了整体导出/恢复 Cookie（应用重启后恢复登录态，免验证码）。
pub struct HttpSession {
    client: reqwest::Client,
    no_redirect_client: reqwest::Client,
    jar: Arc<reqwest::cookie::Jar>,
    // 保留服务端原始 Set-Cookie 属性（HttpOnly/SameSite/Path 等），供应用内 WebView
    // 建立同一登录态。仅留最近 512 条；不写入日志/URL，也不回传给插件 JS。
    set_cookie_headers: Arc<Mutex<Vec<CapturedSetCookie>>>,
}

#[derive(Clone)]
struct CapturedSetCookie {
    url: String,
    header: String,
}

impl Clone for HttpSession {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            no_redirect_client: self.no_redirect_client.clone(),
            jar: self.jar.clone(),
            set_cookie_headers: self.set_cookie_headers.clone(),
        }
    }
}

pub struct HttpSessions(pub Mutex<HashMap<String, HttpSession>>);

fn new_http_session() -> Result<HttpSession, String> {
    let jar = Arc::new(reqwest::cookie::Jar::default());
    let make_client = |follow_redirects: bool| {
        let mut builder = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .user_agent(concat!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 LeTimeManagement/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(6))
            .timeout(std::time::Duration::from_secs(18))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .pool_max_idle_per_host(8);
        if !follow_redirects {
            builder = builder.redirect(reqwest::redirect::Policy::none());
        }
        builder
            .build()
            .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
    };
    let client = make_client(true)?;
    let no_redirect_client = make_client(false)?;
    Ok(HttpSession {
        client,
        no_redirect_client,
        jar,
        set_cookie_headers: Arc::new(Mutex::new(Vec::new())),
    })
}

fn new_session_id() -> String {
    format!(
        "s{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

#[derive(serde::Serialize)]
struct HttpFetchResp {
    status: u16,
    body: String,
    #[serde(rename = "finalUrl")]
    final_url: String,
    #[serde(rename = "contentType")]
    content_type: String,
    location: String,
    cookies: Vec<String>,
}

#[tauri::command]
fn http_session_new(state: State<HttpSessions>) -> Result<String, String> {
    let id = new_session_id();
    state
        .0
        .lock()
        .map_err(|_| "会话表被占用")?
        .insert(id.clone(), new_http_session()?);
    Ok(id)
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct CookieDump {
    url: String,
    /// 该 URL 下当前生效的全部 Cookie，形如 "k1=v1; k2=v2"
    cookie: String,
}

/// 导出会话在给定 URL 下的全部 Cookie（登录成功后由插件保存，重启后恢复免验证码）
#[tauri::command]
fn http_session_export(
    state: State<HttpSessions>,
    sid: String,
    urls: Vec<String>,
) -> Result<Vec<CookieDump>, String> {
    use reqwest::cookie::CookieStore as _;
    let session = state
        .0
        .lock()
        .map_err(|_| "会话表被占用")?
        .get(&sid)
        .ok_or("会话不存在或已过期")?
        .clone();
    let mut out = Vec::new();
    for url in urls {
        let parsed = reqwest::Url::parse(&url).map_err(|e| format!("URL 无法解析: {e}"))?;
        if let Some(value) = session.jar.cookies(&parsed) {
            let cookie = value.to_str().unwrap_or("").to_string();
            if !cookie.is_empty() {
                out.push(CookieDump { url, cookie });
            }
        }
    }
    Ok(out)
}

/// 用导出的 Cookie 重建一个会话（host-only 属性与导出时一致，可直接续期）
#[tauri::command]
fn http_session_restore(
    state: State<HttpSessions>,
    cookies: Vec<CookieDump>,
) -> Result<String, String> {
    let session = new_http_session()?;
    for dump in &cookies {
        let url = reqwest::Url::parse(&dump.url).map_err(|e| format!("URL 无法解析: {e}"))?;
        for part in dump.cookie.split(';') {
            let part = part.trim();
            if part.contains('=') {
                session.jar.add_cookie_str(part, &url);
            }
        }
    }
    let id = new_session_id();
    state
        .0
        .lock()
        .map_err(|_| "会话表被占用")?
        .insert(id.clone(), session);
    Ok(id)
}

/// WebDAV 的方法名不在 `http::Method` 的常量里（它只到 PATCH），只能从字节现造。
/// 字节集是固定的内部字面量，不走用户输入，所以这里不存在被注入任意方法的可能。
fn dav_method(raw: &[u8]) -> Result<reqwest::Method, String> {
    reqwest::Method::from_bytes(raw).map_err(|e| format!("HTTP 方法不合法: {e}"))
}

#[tauri::command]
async fn http_fetch(
    state: State<'_, HttpSessions>,
    sid: String,
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    binary: Option<bool>,
    follow_redirects: Option<bool>,
) -> Result<HttpFetchResp, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 地址".into());
    }
    let session = state
        .0
        .lock()
        .map_err(|_| "会话表被占用")?
        .get(&sid)
        .cloned()
        .ok_or("会话不存在或已过期，请重新创建")?;
    let client = if follow_redirects == Some(false) {
        session.no_redirect_client
    } else {
        session.client
    };

    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        // WebDAV 的两个方法。reqwest 没有对应常量（它只到 PATCH），只能现造。
        // 少了它们，同步引导就必须让用户先自己去网盘网页版建好文件夹 ——
        // 向不存在的目录 PUT 会拿 409，对小白来说是一条看不出原因的失败。
        "MKCOL" => client.request(dav_method(b"MKCOL")?, &url),
        "PROPFIND" => client.request(dav_method(b"PROPFIND")?, &url),
        _ => client.get(&url),
    };
    if let Some(hs) = &headers {
        for (k, v) in hs {
            req = req.header(k, v);
        }
    }
    if let Some(b) = &body {
        req = req.body(b.clone());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", error_chain(&e)))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .collect();
    if !cookies.is_empty() {
        if let Ok(mut captured) = session.set_cookie_headers.lock() {
            for header in &cookies {
                captured.push(CapturedSetCookie { url: final_url.clone(), header: header.clone() });
            }
            if captured.len() > 512 {
                let excess = captured.len() - 512;
                captured.drain(..excess);
            }
        }
    }
    // binary=true 时返回 base64（验证码等图片场景）
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", error_chain(&e)))?;
    let resp_body = if binary.unwrap_or(false) {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    } else {
        decode_body(&bytes, &content_type)
    };
    Ok(HttpFetchResp {
        status,
        body: resp_body,
        final_url,
        content_type,
        location,
        cookies,
    })
}

/* ── 系统托盘与关闭行为（仅桌面端）── */

/// 主窗口的「关闭」是不是应该隐藏到托盘。
///
/// 行为设置存放在前端 data.json 的 `settings.closeToTray`（默认 true = 隐藏到托盘）。
/// 刻意**每次关闭时现读文件**而不是启动时缓存：设置改完立即生效，不需要重启应用。
/// data.json 很小，同步读一次的代价可以忽略（CloseRequested 只在用户点关闭时触发）。
#[cfg(desktop)]
fn close_to_tray(app: &tauri::AppHandle) -> bool {
    read_desktop_setting(app, "/settings/closeToTray", true)
}

/// 「是否创建系统托盘图标」。默认 true —— 与引入该开关之前的行为保持一致。
#[cfg(desktop)]
fn tray_enabled(app: &tauri::AppHandle) -> bool {
    read_desktop_setting(app, "/settings/trayEnabled", true)
}

/// 从 data.json 里现读一个布尔设置，缺失 / 解析失败 / 类型不符一律返回 `default`。
#[cfg(desktop)]
fn read_desktop_setting(app: &tauri::AppHandle, pointer: &str, default: bool) -> bool {
    let Ok(dir) = app.path().app_data_dir() else {
        return default;
    };
    let Ok(raw) = fs::read_to_string(dir.join("data.json")) else {
        return default;
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v.pointer(pointer).and_then(Value::as_bool))
        .unwrap_or(default)
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 退出前的存盘握手：前端把防抖中未落盘的改动写完后来敲一下。
///
/// 只用于托盘菜单的「退出」——窗口关闭按钮走的是隐藏到托盘那条路，不涉及退出。
/// 之所以要握手而不是固定 sleep：`app.exit(0)` 会直接掐掉进程，
/// 前端 `saveNow()` 的 IPC 一旦没跑完，用户最后的改动就静默丢了。
// ⚠️ 退出握手这一组（QuitGate / QUIT_GATE / quit_gate / quit_ack）**不能**加 `#[cfg(desktop)]`：
// `invoke_handler` 的命令列表没有平台门控，一旦 `quit_ack` 只在桌面存在，
// Android 编译会断在 `cannot find macro __cmd__quit_ack`（v0.52.0 实测）。
// 移动端无人调用它，零成本。
struct QuitGate {
    acked: Mutex<bool>,
    cv: Condvar,
}

static QUIT_GATE: OnceLock<Arc<QuitGate>> = OnceLock::new();

fn quit_gate() -> &'static Arc<QuitGate> {
    QUIT_GATE.get_or_init(|| {
        Arc::new(QuitGate {
            acked: Mutex::new(false),
            cv: Condvar::new(),
        })
    })
}

/// 前端存盘完成后调用，放行正在等待的退出线程。
#[tauri::command]
fn quit_ack(gate: State<'_, Arc<QuitGate>>) {
    if let Ok(mut acked) = gate.acked.lock() {
        *acked = true;
        gate.cv.notify_all();
    }
}

/// 等前端回执，最长等 `timeout_ms`。
///
/// 超时也照常退出 —— 宁可丢一次写盘，也不能让用户点了「退出」却退不掉。
/// 返回 `true` 表示拿到了回执（正常路径），`false` 表示超时兜底。
#[cfg(desktop)]
fn wait_quit_ack(gate: &Arc<QuitGate>, timeout_ms: u64) -> bool {
    let Ok(acked) = gate.acked.lock() else {
        return false;
    };
    // 已回执就不用等了（比如前端快得在 spurious wakeup 之外先敲了门）
    if *acked {
        return true;
    }
    match gate
        .cv
        .wait_timeout_while(acked, std::time::Duration::from_millis(timeout_ms), |a| !*a)
    {
        Ok((guard, _)) => *guard,
        Err(_) => false,
    }
}

/// 构建系统托盘。
///
/// 只有 `settings.trayEnabled` 为真时才创建图标（设置页「系统托盘」开关）。
/// 左键点按 = 切换主窗口显示/隐藏；右键 = 弹菜单（显示主窗口 / 退出）。
/// 退出前先广播 `app-quit` 事件，前端收到后把 350ms 防抖里还没落盘的改动写盘
/// （见 src/store.js persistSoon），这里延迟 800ms 再真正退出。
#[cfg(desktop)]
fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    // 托盘图标开关是**启动时**生效项：图标一旦建立，运行期增删容易留下残留。
    // 这里只读一次；用户在设置里改完会看到「重启后生效」的提示。
    if !tray_enabled(app.handle()) {
        return Ok(());
    }

    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 U-Time", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("letime-tray")
        .tooltip("U-Time")
        .menu(&menu)
        // 左键留给「显示/隐藏窗口」，右键才弹菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                let _ = app.emit("app-quit", ());
                let gate = quit_gate().clone();
                let app = app.clone();
                std::thread::spawn(move || {
                    // 等前端存盘回执，最多 2s；超时（或前端根本没起来）也照常退出。
                    wait_quit_ack(&gate, 2000);
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        show_main_window(app);
                    }
                }
            }
        });
    // 用打包时内嵌的应用图标（tauri.conf.json bundle.icon），失败就退化为系统默认图
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // 桌面端单实例：二次启动时聚焦已有窗口，避免多实例互相覆盖 data.json
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
        // 「点关闭按钮隐藏到托盘」：只拦主窗口，教务导入窗等子窗口照常直接关。
        // 行为设置存前端 data.json 的 settings.closeToTray（默认 true），关闭时现读，改完立即生效。
        // ⚠️ 托盘图标本身被关掉（settings.trayEnabled=false）时必须直接退出，
        // 否则窗口一隐藏就再也点不出来 —— 那等于把应用藏没了。
        builder = builder.on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && tray_enabled(window.app_handle())
                    && close_to_tray(window.app_handle())
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
        // 系统托盘：左键显示/隐藏主窗口，右键弹菜单（显示主窗口 / 退出）
        // 是否创建由设置页的 settings.trayEnabled 决定，见 setup_tray 注释。
        builder = builder.setup(setup_tray);
    }
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(native_schedule::init());
        // 应用内一键升级：Android 侧需要原生插件把 content:// 交给系统安装器
        builder = builder.plugin(update::init());
        // 应用内「卸载本应用」：把 ACTION_DELETE + package: 交给系统卸载程序（见 uninstaller.rs）
        builder = builder.plugin(uninstaller::init());
        // 状态栏 / 导航栏图标明暗：edge-to-edge 下系统栏图标压在网页上，
        // 必须由网页把真实亮度同步过来（否则「系统深色 + 网页浅色」时图标看不见）
        builder = builder.plugin(system_bar::init());
        // 系统通知与后台闹钟：WebView 没有 Notification API，且网页定时器不跨进程存活，
        // 提醒要能进下拉栏、应用被杀也要到点响，只能交给原生（见 src/notification.rs）
        builder = builder.plugin(notification::init());
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .manage(HttpSessions(Mutex::new(HashMap::new())))
        .manage(LanHandle(Mutex::new(None)))
        .manage(native_schedule::NativeSchedule::default())
        // 退出握手的状态必须注册，否则 `State<'_, Arc<QuitGate>>` 注入失败，
        // quit_ack 永远敲不响 → 每次退出都要空等满 2 秒超时才走。
        .manage(quit_gate().clone())
        .invoke_handler(tauri::generate_handler![
            native_schedule::native_schedule,
            system_bar::system_bar,
            notification::notification,
            load_data,
            save_data,
            quit_ack,
            list_plugins,
            read_plugin_file,
            delete_plugin,
            import_plugin_zip,
            export_plugins_zip,
            save_download,
            save_download_base64,
            app_info,
            http_get,
            http_get_icon,
            open_external,
            open_internal,
            open_internal_with_http_session,
            des_ecb_encrypt_hex,
            http_session_new,
            http_fetch,
            http_session_export,
            http_session_restore,
            school_import_open,
            plugin_vault_set,
            plugin_vault_get,
            plugin_vault_del,
            ai_vault_save,
            ai_vault_status,
            ai_vault_clear,
            ai_chat,
            lan_start,
            lan_stop,
            lan_status,
            lan_push_take,
            lan_push_resolve,
            update::update_check,
            update::update_download,
            update::update_install,
            update::update_ready,
            update::update_open_install_settings,
            uninstaller::app_uninstall
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn des_matches_pydes_vectors() {
        // 向量由 python pyDes（超星登录同款 DES-ECB/PKCS5）计算
        assert_eq!(
            des_ecb_encrypt_hex("123456".into(), "u2oh6Vu^".into()).unwrap(),
            "218b246a6f42ee81"
        );
        assert_eq!(
            des_ecb_encrypt_hex("abc".into(), "u2oh6Vu^".into()).unwrap(),
            "4cfc33620fedd8d7"
        );
    }

    #[test]
    fn aead_round_trip_and_tamper_detection() {
        // 插件密钥库同款加解密：随机密钥 round-trip + 篡改必须失败
        let key: Vec<u8> = (0..32u8).collect();
        let plain = b"password123&cookies-json";
        let sealed = aead_encrypt(&key, plain).unwrap();
        assert_ne!(sealed, plain.to_vec());
        assert_eq!(aead_decrypt(&key, &sealed).unwrap(), plain.to_vec());
        // 换密钥解不开
        let wrong: Vec<u8> = (32..64u8).collect();
        assert!(aead_decrypt(&wrong, &sealed).is_err());
        // 篡改一个字节必须失败
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(aead_decrypt(&key, &tampered).is_err());
    }

    /// 造一条带 cause 链的假错误，形状对齐 reqwest 的
    /// 「error sending request → client error (Connect) → dns error → 真因」。
    #[derive(Debug)]
    struct Chain(&'static str, Option<Box<Chain>>);

    impl std::fmt::Display for Chain {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Chain {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_ref().map(|b| &**b as &(dyn std::error::Error + 'static))
        }
    }

    const CAUSES: [&str; 5] = [
        "client error (Connect)",
        "dns error",
        "failed to lookup address information",
        "第四层包装",
        "第五层包装",
    ];

    /// 顶层恒是 reqwest 那句，`causes` 控制往下挂几层
    fn chain(causes: usize) -> Chain {
        let head = CAUSES[..causes]
            .iter()
            .rev()
            .fold(None, |acc, m| Some(Box::new(Chain(m, acc))));
        Chain("error sending request for url (https://jw.cppu.edu.cn/je/load)", head)
    }

    #[test]
    fn error_chain_surfaces_the_root_cause_and_caps_depth() {
        // 只有顶层一句 = 线索全丢，这正是 v0.102.0 警大学分那张截图的形态
        assert_eq!(error_chain(&chain(0)), chain(0).to_string());
        assert_eq!(
            error_chain(&chain(3)),
            "error sending request for url (https://jw.cppu.edu.cn/je/load): client error (Connect): dns error: failed to lookup address information"
        );
        // 再深的 hyper 包装不进提示条
        let deep = error_chain(&chain(5));
        assert!(!deep.contains("第四层包装"), "{deep}");
        assert!(deep.ends_with("information…"), "{deep}");
    }
}
