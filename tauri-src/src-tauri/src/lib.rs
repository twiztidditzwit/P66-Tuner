// Minimal Tauri v2 shell for the static P66 Log Analyzer.
// The frontend is served straight from the repo root (index.html).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
