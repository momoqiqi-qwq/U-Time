//! Original Compose application hosted as a native child, controlled over a private stdin pipe.
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{Manager, Runtime};

#[cfg(target_os = "android")]
struct AndroidSchedule<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("native-schedule")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.yile.letime", "NativeSchedulePlugin")?;
            app.manage(AndroidSchedule(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize, Clone)]
pub struct ScheduleBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[cfg(target_os = "windows")]
struct ScheduleProcess {
    child: std::process::Child,
    input: std::process::ChildStdin,
}
#[cfg(target_os = "windows")]
impl Drop for ScheduleProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct NativeSchedule {
    #[cfg(target_os = "windows")]
    process: Mutex<Option<ScheduleProcess>>,
}

#[cfg(target_os = "windows")]
fn executable<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("native/shiguang/ShiguangSchedule.exe");
    if packaged.is_file() {
        return Ok(packaged);
    }
    #[cfg(debug_assertions)]
    {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("native/shiguang/ShiguangSchedule.exe");
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err("安装包尚未包含原版课表运行时，请安装包含原生课表的版本".into())
}

#[tauri::command]
pub async fn native_schedule<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, NativeSchedule>,
    action: String,
    bounds: Option<ScheduleBounds>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::io::{BufRead, Write};
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        if action == "status" {
            return Ok(
                serde_json::json!({"available": executable(&app).is_ok(), "platform":"windows"}),
            );
        }
        if !["show", "hide", "close"].contains(&action.as_str()) {
            return Err("未知课表操作".into());
        }
        // 首次启动要等课表进程打印 LE_READY（最长 45s），且全程持有进程锁：
        // 放进阻塞线程池执行，避免长时间占住异步运行时的工作线程。
        let _ = state;
        let (app, window) = (app.clone(), window.clone());
        return tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let state = app.state::<NativeSchedule>();
        let mut guard = state.process.lock().map_err(|e| e.to_string())?;
        if guard
            .as_mut()
            .is_some_and(|p| p.child.try_wait().ok().flatten().is_some())
        {
            *guard = None;
        }
        if action == "close" {
            *guard = None;
            return Ok(serde_json::json!({}));
        }
        if action == "hide" && guard.is_none() {
            return Ok(serde_json::json!({}));
        }
        if guard.is_none() {
            let path = executable(&app)?;
            let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
            let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("shiguang-native.log"))
                .map_err(|e| e.to_string())?;
            let mut child = Command::new(path)
                .arg(format!("--le-parent={parent}"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::from(log))
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| format!("原版课表启动失败：{e}"))?;
            let input = child.stdin.take().ok_or("课表控制管道不可用")?;
            let output = child.stdout.take().ok_or("课表启动管道不可用")?;
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(output)
                    .lines()
                    .map_while(Result::ok)
                {
                    if line.trim() == "LE_READY" {
                        let _ = tx.send(());
                    }
                }
            });
            let process = ScheduleProcess { child, input };
            rx.recv_timeout(std::time::Duration::from_secs(45))
                .map_err(|_| "原版课表未完成启动，请检查运行时日志")?;
            *guard = Some(process);
        }
        let message = if action == "hide" {
            serde_json::json!({"visible":false})
        } else {
            let b = bounds.ok_or("缺少课表显示区域")?;
            if b.width < 1 || b.height < 1 || b.width > 16384 || b.height > 16384 {
                return Err("课表区域尺寸不合法".into());
            }
            serde_json::json!({"visible":true,"x":b.x,"y":b.y,"width":b.width,"height":b.height})
        };
        let p = guard.as_mut().ok_or("课表未启动")?;
        writeln!(p.input, "{message}")
            .and_then(|_| p.input.flush())
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({"visible":action == "show"}))
        })
        .await
        .map_err(|e| format!("课表后台任务异常终止: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        let _ = (window, state, bounds);
        if !["status", "show", "hide", "close"].contains(&action.as_str()) {
            return Err("未知课表操作".into());
        }
        return app
            .state::<AndroidSchedule<R>>()
            .0
            .run_mobile_plugin_async(&action, serde_json::json!({}))
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = (app, window, state, bounds);
        if action == "status" {
            return Ok(serde_json::json!({"available":false,"platform":std::env::consts::OS}));
        }
        Err("此平台的原版课表宿主尚未接入".into())
    }
}
