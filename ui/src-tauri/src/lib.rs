use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct SidecarState {
    engine: Mutex<Option<CommandChild>>,
    core: Mutex<Option<CommandChild>>,
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("kaveh"))
}

fn start_sidecars(app: &AppHandle) {
    let data_dir = app_data_dir(app);
    let _ = std::fs::create_dir_all(data_dir.join("config"));
    let _ = std::fs::create_dir_all(data_dir.join("logs"));

    let state = app.state::<SidecarState>();

    {
        let mut engine = state.engine.lock().unwrap();
        if engine.is_none() {
            if let Ok(cmd) = app
                .shell()
                .sidecar("kaveh-engine")
                .map(|c| c.current_dir(&data_dir).env("KAVEH_DATA_DIR", data_dir.to_string_lossy().to_string()))
            {
                if let Ok((_rx, child)) = cmd.spawn() {
                    *engine = Some(child);
                }
            }
        }
    }

    {
        let mut core = state.core.lock().unwrap();
        if core.is_none() {
            if let Ok(cmd) = app
                .shell()
                .sidecar("kaveh-core")
                .map(|c| c.current_dir(&data_dir).env("KAVEH_DATA_DIR", data_dir.to_string_lossy().to_string()))
            {
                if let Ok((_rx, child)) = cmd.spawn() {
                    *core = Some(child);
                }
            }
        }
    }
}

fn stop_sidecars(app: &AppHandle) {
    let state = app.state::<SidecarState>();

    if let Some(mut child) = state.core.lock().unwrap().take() {
        let _ = child.kill();
    }

    if let Some(mut child) = state.engine.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut app = tauri::Builder::default()
        .manage(SidecarState {
            engine: Mutex::new(None),
            core: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            start_sidecars(&app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit { .. }) {
            stop_sidecars(app_handle);
        }
    });
}
