//! OpenAI 兼容模型目录：凭据留在原生侧，缓存按地址和 Key 摘要隔离。
use crate::vault::{load_ai_secret, AiSecretConfig};
use ring::digest::{digest, SHA256};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

const TTL_MS: u64 = 30 * 60 * 1000;
const MAX_BODY: usize = 2 * 1024 * 1024;
type CacheKey = (String, Vec<u8>);
static CACHE: OnceLock<Mutex<HashMap<CacheKey, ModelCatalog>>> = OnceLock::new();

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct ModelInfo {
    id: String,
    name: String,
    created: Option<u64>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCatalog {
    models: Vec<ModelInfo>,
    fetched_at: u64,
    cached: bool,
    warning: Option<String>,
}

pub(crate) fn models_endpoint(base: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base.trim()).map_err(|_| "Base URL 格式不正确")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Base URL 应为不含账号、查询参数或片段的 http/https 接口地址".into());
    }
    let path = url.path().trim_end_matches('/');
    let root = path
        .strip_suffix("/chat/completions")
        .or_else(|| path.strip_suffix("/models"))
        .unwrap_or(path);
    url.set_path(&format!("{root}/models"));
    Ok(url.to_string())
}

// 留空只允许复用同一个接口的凭据；更换供应商或中转地址时必须提供新 Key。
pub(crate) fn resolve_key(
    base: &str,
    input: &str,
    saved: Option<&AiSecretConfig>,
) -> Result<String, String> {
    let endpoint = models_endpoint(base)?;
    if !input.trim().is_empty() {
        return Ok(input.trim().to_string());
    }
    match saved {
        Some(secret)
            if models_endpoint(&secret.base_url).ok().as_deref() == Some(endpoint.as_str()) =>
        {
            Ok(secret.api_key.clone())
        }
        Some(_) => Err("接口地址已更改，请填写此供应商的 API Key".into()),
        None => Err("请先填写 API Key，或加密保存 AI 配置".into()),
    }
}

fn cache_key(endpoint: &str, key: &str) -> CacheKey {
    (
        endpoint.to_string(),
        digest(&SHA256, key.as_bytes()).as_ref().to_vec(),
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_models(value: &Value) -> Result<Vec<ModelInfo>, String> {
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("模型列表响应缺少 data 数组")?;
    if rows.len() > 4000 {
        return Err("模型列表过大，请检查接口地址".into());
    }
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty()
            || id.len() > 256
            || id.chars().any(char::is_control)
            || !seen.insert(id.to_string())
        {
            continue;
        }
        models.push(ModelInfo {
            id: id.to_string(),
            name: row
                .get("name")
                .or_else(|| row.get("display_name"))
                .and_then(Value::as_str)
                .unwrap_or(id)
                .chars()
                .take(256)
                .collect(),
            created: row.get("created").and_then(Value::as_u64),
        });
    }
    if models.is_empty() {
        return Err("接口未返回可用模型，可继续手动填写模型 ID".into());
    }
    models.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
    Ok(models)
}

fn http_error(code: u16) -> String {
    match code {
        401 | 403 => format!("模型列表请求被拒绝（HTTP {code}），请检查 API Key 和访问权限"),
        404 | 405 => "该地址不支持模型列表接口，可继续手动填写模型 ID".into(),
        429 => "模型列表请求过于频繁，请稍后刷新".into(),
        _ => format!("模型列表接口返回 HTTP {code}，请稍后刷新"),
    }
}

async fn fetch_models(endpoint: &str, key: &str) -> Result<ModelCatalog, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "模型列表 HTTP 客户端初始化失败")?;
    let mut response = client
        .get(endpoint)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "无法连接模型列表接口，请检查地址和网络")?;
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err("模型列表响应过大".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取模型列表失败")? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("模型列表响应过大".into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| "模型列表响应不是有效 JSON")?;
    Ok(ModelCatalog {
        models: parse_models(&value)?,
        fetched_at: now_ms(),
        cached: false,
        warning: None,
    })
}

async fn list_models(
    endpoint: &str,
    key: &str,
    force_refresh: bool,
) -> Result<ModelCatalog, String> {
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cache_id = cache_key(endpoint, key);
    let cached = cache
        .lock()
        .map_err(|_| "模型缓存不可用")?
        .get(&cache_id)
        .cloned();
    if !force_refresh {
        if let Some(mut entry) = cached
            .clone()
            .filter(|entry| now_ms().saturating_sub(entry.fetched_at) < TTL_MS)
        {
            entry.cached = true;
            return Ok(entry);
        }
    }
    match fetch_models(endpoint, key).await {
        Ok(catalog) => {
            let mut entries = cache.lock().map_err(|_| "模型缓存不可用")?;
            if entries.len() >= 16 && !entries.contains_key(&cache_id) {
                if let Some(oldest) = entries
                    .iter()
                    .min_by_key(|(_, c)| c.fetched_at)
                    .map(|(k, _)| k.clone())
                {
                    entries.remove(&oldest);
                }
            }
            entries.insert(cache_id, catalog.clone());
            Ok(catalog)
        }
        Err(error) => match cached {
            Some(mut entry) => {
                entry.cached = true;
                entry.warning = Some(error);
                Ok(entry)
            }
            None => Err(error),
        },
    }
}

pub(crate) fn clear_cache() {
    if let Some(cache) = CACHE.get() {
        if let Ok(mut entries) = cache.lock() {
            entries.clear();
        }
    }
}

#[tauri::command]
pub(crate) async fn ai_list_models(
    app: AppHandle,
    base_url: String,
    api_key: String,
    force_refresh: bool,
) -> Result<ModelCatalog, String> {
    let endpoint = models_endpoint(&base_url)?;
    let saved = if api_key.trim().is_empty() {
        load_ai_secret(&app).ok()
    } else {
        None
    };
    let key = resolve_key(&base_url, &api_key, saved.as_ref())?;
    list_models(&endpoint, &key, force_refresh).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn endpoints_and_key_boundaries() {
        for base in [
            "https://example.com/v1",
            "https://example.com/v1/",
            "https://example.com/v1/chat/completions",
            "https://example.com/v1/models",
        ] {
            assert_eq!(
                models_endpoint(base).unwrap(),
                "https://example.com/v1/models"
            );
        }
        assert_eq!(
            models_endpoint("https://api.deepseek.com").unwrap(),
            "https://api.deepseek.com/models"
        );
        for bad in [
            "file:///x",
            "https://user:pass@example.com",
            "https://example.com?key=x",
            "https://example.com/#x",
            "bad",
        ] {
            assert!(models_endpoint(bad).is_err());
        }
        let saved = AiSecretConfig {
            base_url: "https://example.com/v1".into(),
            api_key: "secret".into(),
            model: "old".into(),
        };
        assert_eq!(
            resolve_key("https://example.com/v1/", "", Some(&saved)).unwrap(),
            "secret"
        );
        assert!(resolve_key("https://other.com/v1", "", Some(&saved)).is_err());
        assert!(resolve_key("https://example.com/v2", "", Some(&saved)).is_err());
        assert_eq!(
            resolve_key("https://other.com/v1", " new-key ", Some(&saved)).unwrap(),
            "new-key"
        );
        assert!(resolve_key("https://example.com", "", None).is_err());
        assert_ne!(cache_key("a", "key1"), cache_key("a", "key2"));
        assert_ne!(cache_key("a", "key1"), cache_key("b", "key1"));
    }

    #[test]
    fn catalog_validation_and_order() {
        let models = parse_models(&json!({"data":[{"id":"old","created":1},{"id":"new","created":3,"name":"新模型"},{"id":"old"},{"id":""},{"id":3},{"id":"manual"}]})).unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["new", "old", "manual"]
        );
        assert_eq!(models[0].name, "新模型");
        for invalid in [json!({}), json!({"data":[]}), json!({"data":[{"id":"\n"}]})] {
            assert!(parse_models(&invalid).is_err());
        }
    }

    #[test]
    fn authenticated_http_cache_and_stale_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1/models", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for (index, status) in [200, 503, 401, 200].into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buf[..n]);
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.starts_with("get /v1/models "));
                let expected_key = if index == 2 { "other-key" } else { "test-key" };
                assert!(request.contains(&format!("authorization: bearer {expected_key}\r\n")));
                let body = if index == 3 {
                    r#"{"data":[{"id":"newer-model","created":200}]}"#
                } else {
                    r#"{"data":[{"id":"fresh-model","created":100}]}"#
                };
                write!(
                    stream,
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        tauri::async_runtime::block_on(async {
            let first = list_models(&endpoint, "test-key", false).await.unwrap();
            assert!(!first.cached);
            assert_eq!(first.models[0].id, "fresh-model");
            let cached = list_models(&endpoint, "test-key", false).await.unwrap();
            assert!(cached.cached);
            assert_eq!(cached.fetched_at, first.fetched_at);
            let stale = list_models(&endpoint, "test-key", true).await.unwrap();
            assert!(stale.warning.unwrap().contains("503"));
            assert_eq!(stale.models[0].id, "fresh-model");
            // 更换 Key 不得读到上一 Key 的目录，错误结果也不能覆盖已有缓存。
            assert!(list_models(&endpoint, "other-key", false)
                .await
                .unwrap_err()
                .contains("401"));
            {
                let mut cache = CACHE.get().unwrap().lock().unwrap();
                cache
                    .get_mut(&cache_key(&endpoint, "test-key"))
                    .unwrap()
                    .fetched_at = now_ms() - TTL_MS - 1;
            }
            let refreshed = list_models(&endpoint, "test-key", false).await.unwrap();
            assert!(!refreshed.cached);
            assert_eq!(refreshed.models[0].id, "newer-model");
        });
        server.join().unwrap();
    }
}
