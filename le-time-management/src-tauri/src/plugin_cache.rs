//! 插件缓存（前端 `tide.cache`，见 src/pluginCache.js）：每个插件一个目录，每个键一个 JSON 文件，
//! 位于 `<数据目录>/plugin-cache/<插件>/<键>.json`。
//!
//! 不进 data.json：主状态每次保存都要整份序列化重写，插件抓回来的通知 / 账单 / 名单塞在里面，
//! 改一个任务标题也要搬几 MB。缓存可以重抓，所以这里不 fsync、不进备份与同步；读到坏文件当未命中。
use serde_json::Value;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::off_main;

const KEY_MAX: usize = 200;
const NAME_MAX: usize = 200;

pub(crate) fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join("plugin-cache"))
}

/// 文件名编码：只原样保留 `[a-z0-9_-]`，其余字节一律写成 `~XX`。
/// 大写字母也编码 —— Windows 文件名不分大小写，`A` 与 `a` 会撞成同一个文件；
/// `:`（school-notice 的 `notices:<站点>`）、`/`、`\`、`.` 因此都进不了路径，`..` 穿越无从谈起。
fn encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-' {
            out.push(b as char);
        } else {
            out.push_str(&format!("~{b:02X}"));
        }
    }
    out
}

fn entry_path(root: &Path, plugin_id: &str, key: &str) -> Result<PathBuf, String> {
    let dir = encode_component(plugin_id.trim());
    if dir.is_empty() || dir.len() > NAME_MAX {
        return Err("插件 ID 不合法".into());
    }
    if key.is_empty() || key.len() > KEY_MAX {
        return Err("缓存键不合法".into());
    }
    let file = encode_component(key);
    if file.len() > NAME_MAX {
        return Err("缓存键过长".into());
    }
    Ok(root.join(dir).join(format!("{file}.json")))
}

fn read_entry(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        // 半截文件 / 手工改坏：当未命中，插件会重新抓一份覆盖它。
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取插件缓存失败: {e}")),
    }
}

fn write_entry(path: &Path, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除插件缓存失败: {e}")),
        };
    }
    let dir = path.parent().ok_or("插件缓存路径异常")?;
    fs::create_dir_all(dir).map_err(|e| format!("无法创建插件缓存目录: {e}"))?;
    let bytes = serde_json::to_vec(value).map_err(|e| format!("序列化插件缓存失败: {e}"))?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // 先写临时文件再 rename：读的一方永远看到完整的旧文件或完整的新文件。
    let tmp = dir.join(format!(".{name}.{}-{nanos}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入插件缓存失败: {e}"));
    }
    Ok(())
}

/// 卸载插件时连同缓存目录一起删（见 lib.rs 的 delete_plugin_blocking）。
pub(crate) fn clear_plugin_cache(app: &AppHandle, plugin_id: &str) -> Result<(), String> {
    let dir = encode_component(plugin_id.trim());
    if dir.is_empty() {
        return Err("插件 ID 不合法".into());
    }
    match fs::remove_dir_all(cache_root(app)?.join(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清理插件缓存失败: {e}")),
    }
}

#[tauri::command]
pub async fn plugin_cache_get(app: AppHandle, plugin_id: String, key: String) -> Result<Option<Value>, String> {
    off_main(move || read_entry(&entry_path(&cache_root(&app)?, &plugin_id, &key)?)).await
}

/// `value` 为 null 时删除该键。
#[tauri::command]
pub async fn plugin_cache_set(app: AppHandle, plugin_id: String, key: String, value: Value) -> Result<(), String> {
    off_main(move || write_entry(&entry_path(&cache_root(&app)?, &plugin_id, &key)?, &value)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("letime-plugin-cache-{tag}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn names_are_encoded_into_a_single_safe_component() {
        assert_eq!(encode_component("cppu-notify"), "cppu-notify");
        assert_eq!(encode_component("notices:school-a"), "notices~3Aschool-a");
        assert_eq!(encode_component("A"), "~41");
        assert_eq!(encode_component("../x"), "~2E~2E~2Fx");
        let root = Path::new("root");
        let p = entry_path(root, "../evil", "..\\k").unwrap();
        assert_eq!(p.parent().unwrap().parent().unwrap(), root, "插件与键都只能各占一层目录");
        assert!(entry_path(root, "", "k").is_err());
        assert!(entry_path(root, "p", "").is_err());
        assert!(entry_path(root, "p", &"中".repeat(30)).is_err(), "编码后超长的键要拒绝（NTFS 单段 255 上限）");
    }

    #[test]
    fn write_read_and_delete_round_trip() {
        let root = temp_root("rt");
        let path = entry_path(&root, "chaoxing-notify", "inboxCache").unwrap();
        assert_eq!(read_entry(&path).unwrap(), None);
        write_entry(&path, &json!([{ "id": "1", "title": "通知" }])).unwrap();
        assert_eq!(read_entry(&path).unwrap(), Some(json!([{ "id": "1", "title": "通知" }])));
        write_entry(&path, &json!({ "v": 2 })).unwrap();
        assert_eq!(read_entry(&path).unwrap(), Some(json!({ "v": 2 })), "覆盖写");
        write_entry(&path, &Value::Null).unwrap();
        assert_eq!(read_entry(&path).unwrap(), None, "null 即删除");
        write_entry(&path, &Value::Null).unwrap();
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert!(leftovers.is_empty(), "不留临时文件");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_file_reads_as_miss() {
        let root = temp_root("bad");
        let path = entry_path(&root, "p", "k").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{\"half\":").unwrap();
        assert_eq!(read_entry(&path).unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }
}
