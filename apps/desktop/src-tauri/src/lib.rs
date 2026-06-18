#[tauri::command]
fn application_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![application_version])
        .run(tauri::generate_context!())
        .expect("error while running Auto Gen Studio");
}
