#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let service = backend::Backend::new(app.handle()).map_err(std::io::Error::other)?;
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend::api_request])
        .build(tauri::generate_context!())
        .expect("No se pudo iniciar Konsora")
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
                handle.state::<backend::Backend>().stop();
            }
        });
}
