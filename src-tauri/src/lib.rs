mod background;
mod commands;

use std::path::PathBuf;
use std::sync::Mutex;

use budget_core::storage::{OpenOptions, Storage};
use tauri::{Manager, WindowEvent};

/// Состояние приложения: одно подключение к базе на всё приложение.
/// Если база не открылась, UI получает текст ошибки и показывает экран с ней.
pub struct AppState {
    pub db: Mutex<Result<Storage, String>>,
    /// Папка данных: там же копии перед миграцией и восстановлением.
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn open_options(&self) -> OpenOptions {
        OpenOptions {
            backup_dir: self.data_dir.join("backups"),
            keep_backups: 10,
        }
    }
}

/// Папка данных для сквозных тестов: аргумент `--data-dir=<путь>` или
/// переменная KAZNA_DATA_DIR. Каждый прогон тестов идёт с чистой базой.
fn data_dir_override() -> Option<PathBuf> {
    std::env::args()
        .find_map(|a| a.strip_prefix("--data-dir=").map(PathBuf::from))
        .or_else(|| std::env::var_os("KAZNA_DATA_DIR").map(PathBuf::from))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = match data_dir_override() {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
            let state = AppState {
                db: Mutex::new(Err(String::new())),
                data_dir: data_dir.clone(),
            };
            let db = Storage::open(&data_dir.join("budget.db"), &state.open_options())
                .map_err(|e| e.to_string());
            *state.db.lock().expect("база ещё не используется") = db;
            app.manage(state);
            if let Err(e) = background::build_tray(app.handle()) {
                eprintln!("значок в трее недоступен: {e}");
            }
            background::start_scheduler(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let Some(w) = window.app_handle().get_webview_window(window.label()) else {
                    return;
                };
                if background::hide_instead_of_close(&w) {
                    api.prevent_close();
                    let _ = w.hide();
                } else {
                    // Окно закрывается вместе с приложением: копия сейчас, пока
                    // процесс точно жив (до события выхода дело может не дойти).
                    background::autobackup_on_exit(w.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::set_setting,
            commands::list_currencies,
            commands::list_rates,
            commands::set_rate,
            commands::delete_rate,
            commands::rate_on,
            commands::finish_onboarding,
            commands::list_accounts,
            commands::create_account,
            commands::update_account,
            commands::archive_account,
            commands::adjust_balance,
            commands::totals,
            commands::list_categories,
            commands::create_category,
            commands::update_category,
            commands::archive_category,
            commands::delete_category,
            commands::list_transactions,
            commands::get_transaction,
            commands::create_transaction,
            commands::update_transaction,
            commands::delete_transaction,
            commands::payee_hints,
            commands::transaction_defaults,
            commands::period_summary,
            commands::get_budget,
            commands::month_of,
            commands::create_budget,
            commands::set_budget_limit,
            commands::set_budget_note,
            commands::delete_budget,
            commands::report_period,
            commands::report_by_category,
            commands::report_by_month,
            commands::report_balances,
            commands::calc_loan,
            commands::compare_loans,
            commands::list_debts,
            commands::get_debt,
            commands::debt_summary,
            commands::create_debt,
            commands::update_debt_info,
            commands::delete_debt,
            commands::pay_debt,
            commands::delete_debt_payment,
            commands::calendar_month,
            commands::calendar_range,
            commands::reminders_overview,
            commands::missed_reminders,
            commands::create_reminder,
            commands::update_reminder,
            commands::set_reminder_active,
            commands::delete_reminder,
            commands::complete_reminder,
            commands::snooze_reminder,
            commands::dismiss_reminder,
            commands::reopen_reminder,
            commands::list_notes,
            commands::create_note,
            commands::update_note,
            commands::delete_note,
            commands::export_summary,
            commands::export_transactions,
            commands::export_report,
            commands::import_preview,
            commands::import_csv,
            commands::write_import_template,
            commands::backup_status,
            commands::backup_now,
            commands::inspect_backup,
            commands::restore_backup,
            commands::check_update,
            commands::install_update,
            commands::changelog,
        ])
        .build(tauri::generate_context!())
        .expect("не удалось запустить приложение")
        .run(|app, event| {
            // Автокопия при закрытии приложения (из трея «Выход» или закрытием окна).
            if let tauri::RunEvent::Exit = event {
                background::autobackup_on_exit(app);
            }
        });
}
