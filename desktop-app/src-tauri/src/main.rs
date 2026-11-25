#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

struct NodeBrain(Arc<Mutex<Option<Child>>>);

fn resolve_node_binary(resource_dir: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    let bundled = resource_dir.join("runtime").join("node").join("node.exe");
    #[cfg(not(target_os = "windows"))]
    let bundled = resource_dir.join("runtime").join("node").join("bin").join("node");

    if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    }
}

fn spawn_threadline_backend(app: &tauri::AppHandle) -> Result<(Child, String), String> {
    let res_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| res_dir.join("_local").join("desktop"));

    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Cannot create Studio data directory: {e}"))?;
    let node_bin = resolve_node_binary(&res_dir);
    let entry = res_dir.join("scripts").join("local-demo.mjs");
    if !entry.is_file() {
        return Err("The installed package is missing scripts/local-demo.mjs".into());
    }

    let mut cmd = Command::new(node_bin);
    cmd.arg(&entry)
        .current_dir(&res_dir)
        .env("THREADLINE_DATA_DIR", &data_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Threadline Node backend: {e}"))?;

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Missing stdout from Threadline backend".into());
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut startup = Some(sender);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(raw_url) = line.strip_prefix("Threadline Studio（百搭玻璃箱工作台）：") else { continue };
            let Ok(url) = raw_url.trim().parse::<tauri::Url>() else { continue };
            if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some() {
                if let Some(sender) = startup.take() {
                    let _ = sender.send(url.to_string());
                }
            }
        }
    });
    match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(url) => Ok((child, url)),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("Threadline backend failed local startup: {error}"))
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let brain_state = Arc::new(Mutex::new(None));
            app.manage(NodeBrain(brain_state.clone()));

            // System Tray: close window hides to tray so Auto-Dream & gateway stay alive
            let show_item = MenuItem::with_id(app, "show", "打开 Threadline Studio", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "彻底退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray_handle = handle.clone();
            let tray_brain = brain_state.clone();
            let tray = TrayIconBuilder::new().menu(&menu);
            let tray = if let Some(icon) = app.default_window_icon() { tray.icon(icon.clone()) } else { tray };
            let _tray = tray
                .tooltip("Threadline Studio（后台运行中）")
                .on_menu_event(move |_app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = tray_handle.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        if let Ok(mut guard) = tray_brain.lock() {
                            if let Some(mut c) = guard.take() {
                                let _ = c.kill();
                                let _ = c.wait();
                            }
                        }
                        tray_handle.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Start local Threadline Node brain and navigate native WebView to it
            let win = app.get_webview_window("main").ok_or_else(|| std::io::Error::other("Missing Studio window"))?;
            let (mut child, url) = spawn_threadline_backend(&handle).map_err(std::io::Error::other)?;
            if let Err(error) = win.navigate(url.parse()?) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
            *brain_state.lock().expect("Studio backend state") = Some(child);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Threadline Studio");
}
