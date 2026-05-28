use std::path::PathBuf;
use std::sync::Mutex;
use std::{fs::OpenOptions, io::Write};

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

fn log_sidecar_event(app: &AppHandle, message: &str) {
    let data_dir = app_data_dir(app);
    let logs_dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&logs_dir);
    let path = logs_dir.join("kaveh_tauri_sidecars.log");

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{ts} {message}\n");

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

fn start_sidecars(app: &AppHandle) {
    let data_dir = app_data_dir(app);
    let _ = std::fs::create_dir_all(data_dir.join("config"));
    let _ = std::fs::create_dir_all(data_dir.join("logs"));

    let state = app.state::<SidecarState>();

    {
        let mut engine = state.engine.lock().unwrap();
        if engine.is_none() {
            match app
                .shell()
                .sidecar("kaveh-engine")
                .map(|c| c.current_dir(&data_dir).env("KAVEH_DATA_DIR", data_dir.to_string_lossy().to_string()))
            {
                Ok(cmd) => match cmd.spawn() {
                    Ok((_rx, child)) => {
                        *engine = Some(child);
                        log_sidecar_event(app, "started kaveh-engine");
                    }
                    Err(e) => {
                        log_sidecar_event(app, &format!("failed to spawn kaveh-engine: {e:?}"));
                    }
                },
                Err(e) => {
                    log_sidecar_event(app, &format!("failed to prepare kaveh-engine sidecar: {e:?}"));
                }
            }
        } else {
            log_sidecar_event(app, "kaveh-engine already running");
        }
    }

    {
        let mut core = state.core.lock().unwrap();
        if core.is_none() {
            match app
                .shell()
                .sidecar("kaveh-core")
                .map(|c| c.current_dir(&data_dir).env("KAVEH_DATA_DIR", data_dir.to_string_lossy().to_string()))
            {
                Ok(cmd) => match cmd.spawn() {
                    Ok((_rx, child)) => {
                        *core = Some(child);
                        log_sidecar_event(app, "started kaveh-core");
                    }
                    Err(e) => {
                        log_sidecar_event(app, &format!("failed to spawn kaveh-core: {e:?}"));
                    }
                },
                Err(e) => {
                    log_sidecar_event(app, &format!("failed to prepare kaveh-core sidecar: {e:?}"));
                }
            }
        } else {
            log_sidecar_event(app, "kaveh-core already running");
        }
    }
}

fn stop_sidecars(app: &AppHandle) {
    let state = app.state::<SidecarState>();

    if let Some(mut child) = state.core.lock().unwrap().take() {
        if let Err(e) = child.kill() {
            log_sidecar_event(app, &format!("failed to kill kaveh-core: {e:?}"));
        } else {
            log_sidecar_event(app, "stopped kaveh-core");
        }
    }

    if let Some(mut child) = state.engine.lock().unwrap().take() {
        if let Err(e) = child.kill() {
            log_sidecar_event(app, &format!("failed to kill kaveh-engine: {e:?}"));
        } else {
            log_sidecar_event(app, "stopped kaveh-engine");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut updater_builder = tauri_plugin_updater::Builder::new();
    if let Ok(pubkey) = std::env::var("KAVEH_UPDATER_PUBLIC_KEY") {
        let trimmed = pubkey.trim();
        if !trimmed.is_empty() {
            updater_builder = updater_builder.pubkey(trimmed);
        }
    }

    let mut app = tauri::Builder::default()
        .manage(SidecarState {
            engine: Mutex::new(None),
            core: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(updater_builder.build())
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
