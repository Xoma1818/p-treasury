mod commands;

use std::sync::Mutex;

use budget_core::storage::{OpenOptions, Storage};
use tauri::Manager;

/// Состояние приложения: одно подключение к базе на всё приложение.
/// Если база не открылась, UI получает текст ошибки и показывает экран с ней.
pub struct AppState {
    pub db: Mutex<Result<Storage, String>>,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let opts = OpenOptions {
                backup_dir: data_dir.join("backups"),
                keep_backups: 10,
            };
            let db = Storage::open(&data_dir.join("budget.db"), &opts).map_err(|e| e.to_string());
            app.manage(AppState { db: Mutex::new(db) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::set_setting,
            commands::list_currencies,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
