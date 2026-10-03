//! 主数据文件的唯一读写入口：串行提交、落盘同步，以及恢复前的原始副本。
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

static DATA_LOCK: Mutex<()> = Mutex::new(());

fn commit(dir: &Path, data: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(data).map_err(|e| format!("序列化数据失败: {e}"))?;
    let tmp = dir.join("data.json.tmp");
    let mut file = File::create(&tmp).map_err(|e| format!("创建临时文件失败: {e}"))?;
    file.write_all(&bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    file.sync_all().map_err(|e| format!("同步临时文件失败: {e}"))?;
    drop(file);
    fs::rename(&tmp, dir.join("data.json")).map_err(|e| format!("替换数据文件失败: {e}"))?;
    #[cfg(unix)]
    File::open(dir).and_then(|file| file.sync_all()).map_err(|e| format!("同步数据目录失败: {e}"))?;
    Ok(())
}

pub fn load(dir: &Path, seed: impl FnOnce() -> Value) -> Result<Value, String> {
    let _guard = DATA_LOCK.lock().map_err(|_| "数据锁不可用")?;
    let path = dir.join("data.json");
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("数据文件损坏: {e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let data = seed(); commit(dir, &data)?; Ok(data)
        }
        Err(error) => Err(format!("读取数据失败: {error}")),
    }
}

pub fn save(dir: &Path, data: &Value) -> Result<(), String> {
    let _guard = DATA_LOCK.lock().map_err(|_| "数据锁不可用")?;
    commit(dir, data)
}

pub fn recover(dir: &Path, data: &Value) -> Result<(), String> {
    if !data.get("tasks").is_some_and(Value::is_array)
        || !data.get("blocks").is_some_and(Value::is_array)
        || data.get("dataSchemaVersion").and_then(Value::as_u64).unwrap_or(0) > 1 {
        return Err("不是当前版本可恢复的有效备份".into());
    }
    let _guard = DATA_LOCK.lock().map_err(|_| "数据锁不可用")?;
    let path = dir.join("data.json");
    match File::open(&path) {
        Ok(mut original) => {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?.as_nanos();
            let backup = dir.join(format!("data.before-recovery-{stamp}.json"));
            let mut copy = OpenOptions::new().write(true).create_new(true).open(backup)
                .map_err(|e| format!("创建恢复前副本失败: {e}"))?;
            std::io::copy(&mut original, &mut copy).map_err(|e| format!("保留原始数据失败: {e}"))?;
            copy.sync_all().map_err(|e| format!("同步原始副本失败: {e}"))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取恢复前原始数据失败: {e}")),
    }
    commit(dir, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corruption_is_preserved_until_explicit_recovery() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("letime-storage-{stamp}"));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("data.json"), "broken original").unwrap();
        assert!(load(&dir, || serde_json::json!({"tasks":[],"blocks":[]})).is_err());
        assert_eq!(fs::read_to_string(dir.join("data.json")).unwrap(), "broken original");
        assert!(recover(&dir, &serde_json::json!({"tasks":"bad","blocks":[]})).is_err());
        let data = serde_json::json!({"tasks":[{"id":"restored"}],"blocks":[]});
        recover(&dir, &data).unwrap();
        assert_eq!(load(&dir, || panic!("must not seed")).unwrap(), data);
        let backup = fs::read_dir(&dir).unwrap().map(|x| x.unwrap().path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("data.before-recovery-")).unwrap();
        assert_eq!(fs::read_to_string(backup).unwrap(), "broken original");
        fs::remove_dir_all(dir).unwrap();
    }
}
