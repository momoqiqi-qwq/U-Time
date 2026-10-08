//! AI 与插件凭据的加密、验证与持久化；命令名称保持兼容。
use super::{data_dir, valid_plugin_id};
use std::{fs, path::PathBuf, collections::HashMap};
use tauri::AppHandle;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub(crate) struct AiSecretConfig {
    #[serde(rename = "baseUrl")]
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
}

#[derive(serde::Serialize)]
pub(crate) struct AiVaultStatus {
    configured: bool,
    #[serde(rename = "baseUrl")]
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(rename = "keyMasked")]
    key_masked: String,
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
pub(crate) fn aead_encrypt(key: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
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

pub(crate) fn aead_decrypt(key: &[u8], raw: &[u8]) -> Result<Vec<u8>, String> {
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

pub(crate) fn load_ai_secret(app: &AppHandle) -> Result<AiSecretConfig, String> {
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

pub(crate) fn validate_ai_base_url(base_url: &str) -> Result<(), String> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err("Base URL 不能为空".into());
    }
    if !base.starts_with("https://") && !base.starts_with("http://") {
        return Err("Base URL 仅支持 http/https".into());
    }
    Ok(())
}

pub(crate) fn ai_chat_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

#[tauri::command]
pub(crate) fn ai_vault_save(
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
    let key = crate::ai_models::resolve_key(&base_url, &api_key, existing.as_ref())?;
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
pub(crate) fn ai_vault_status(app: AppHandle) -> Result<AiVaultStatus, String> {
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
pub(crate) fn ai_vault_clear(app: AppHandle) -> Result<(), String> {
    let data_path = ai_vault_data_path(&app)?;
    if data_path.exists() {
        fs::remove_file(data_path).map_err(|e| format!("清除 AI 凭据失败: {e}"))?;
    }
    crate::ai_models::clear_cache();
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
pub(crate) fn plugin_vault_set(
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
pub(crate) fn plugin_vault_get(
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
pub(crate) fn plugin_vault_del(app: AppHandle, plugin_id: String, key: String) -> Result<(), String> {
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

