mod background;
mod commands;
mod files;
mod quick_window;
mod vault;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use budget_core::storage::{OpenOptions, Storage};
use tauri::{Manager, WindowEvent};

/// Состояние приложения: одно подключение к базе на всё приложение.
/// Если база не открылась, UI получает текст ошибки и показывает экран с ней.
pub struct AppState {
    pub db: Mutex<Result<Storage, String>>,
    /// Папка данных: там же копии перед миграцией и восстановлением.
    pub data_dir: PathBuf,
    /// Журнал отмены и повтора (в памяти, очищается при закрытии).
    pub undo: Mutex<budget_core::undo::Journal>,
    /// Переносная версия: данные в папке `data` рядом с программой.
    pub portable: bool,
    /// Папка сохранности по умолчанию (`Документы\Kazna`).
    pub vault_default: PathBuf,
}

impl AppState {
    /// База. Если какая-то команда упала с паникой, замок не остаётся
    /// «отравленным»: незавершённая транзакция SQLite уже откатилась, и
    /// остальные команды работают дальше, а не отвечают «база недоступна».
    pub fn lock_db(&self) -> MutexGuard<'_, Result<Storage, String>> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn lock_undo(&self) -> MutexGuard<'_, budget_core::undo::Journal> {
        self.undo.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn open_options(&self) -> OpenOptions {
        OpenOptions {
            backup_dir: self.data_dir.join("backups"),
            keep_backups: 10,
        }
    }
}

/// Папка данных для сквозных тестов: аргумент `--data-dir=<путь>` или
/// переменная PTREASURY_DATA_DIR. Каждый прогон тестов идёт с чистой базой.
fn data_dir_override() -> Option<PathBuf> {
    std::env::args()
        .find_map(|a| a.strip_prefix("--data-dir=").map(PathBuf::from))
        .or_else(|| std::env::var_os("PTREASURY_DATA_DIR").map(PathBuf::from))
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Одна копия программы (должен регистрироваться первым): второй запуск
    // показывает уже открытое окно, даже если оно свёрнуто в трей.
    #[cfg(windows)]
    let builder = if data_dir_override().is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            background::show_main(app)
        }))
    } else {
        builder
    };
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(quick_window::plugin())
        .setup(|app| {
            let portable = files::portable_dir();
            let test_dir = data_dir_override().is_some();
            let data_dir = match (data_dir_override(), &portable) {
                (Some(dir), _) => dir,
                (None, Some(dir)) => dir.clone(),
                (None, None) => app.path().app_data_dir()?,
            };
            let state = AppState {
                db: Mutex::new(Err(String::new())),
                data_dir: data_dir.clone(),
                undo: Mutex::default(),
                portable: portable.is_some(),
                vault_default: vault::default_dir(
                    app.handle(),
                    &data_dir,
                    test_dir,
                    portable.is_some(),
                ),
            };
            let db = Storage::open(&files::startup_path(&data_dir), &state.open_options())
                .map_err(|e| e.to_string());
            // 0.26: программа стала Kazna — папка по умолчанию переезжает из «P-Treasury».
            if let Ok(db) = &db {
                match budget_core::vault::migrate_default(db.conn(), &state.vault_default) {
                    Ok(true) => eprintln!(
                        "папка сохранности переименована в {}",
                        state.vault_default.display()
                    ),
                    Ok(false) => {}
                    Err(e) => {
                        eprintln!("папка сохранности не переименована, остаётся прежняя: {e}")
                    }
                }
            }
            *state.lock_db() = db;
            app.manage(state);
            if let Err(e) = background::build_tray(app.handle()) {
                eprintln!("значок в трее недоступен: {e}");
            }
            background::register_actions(app.handle());
            background::start_scheduler(app.handle().clone());
            let hotkey = quick_window::saved_hotkey(app.handle());
            if let Err(e) = quick_window::register(app.handle(), &hotkey) {
                eprintln!("быстрый ввод: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let Some(w) = window.app_handle().get_webview_window(window.label()) else {
                    return;
                };
                // Окно быстрого ввода не закрывается, а прячется до следующего раза.
                if w.label() == quick_window::LABEL {
                    api.prevent_close();
                    let _ = w.hide();
                    return;
                }
                if background::hide_instead_of_close(&w) {
                    api.prevent_close();
                    let _ = w.hide();
                } else {
                    // Окно закрывается вместе с приложением: копия сейчас, пока
                    // процесс точно жив (до события выхода дело может не дойти).
                    vault::sync_on_exit(w.app_handle());
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
            commands::load_cbr_rates,
            commands::auto_cbr_rates,
            commands::finish_onboarding,
            commands::seed_demo,
            commands::clear_demo,
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
            commands::fill_budget,
            commands::cushion,
            commands::report_fx,
            commands::list_views,
            commands::create_view,
            commands::delete_view,
            commands::quick_parse,
            commands::remember_rule,
            commands::list_rules,
            commands::create_rule,
            commands::delete_rule,
            commands::move_transaction,
            commands::split_expense,
            commands::list_assets,
            commands::create_asset,
            commands::update_asset,
            commands::delete_asset,
            commands::invest_overview,
            commands::invest_month,
            commands::set_invest_value,
            commands::delete_invest_value,
            commands::set_invest_plan,
            commands::clear_invest_month_plan,
            commands::list_events,
            commands::create_event,
            commands::update_event,
            commands::delete_event,
            commands::assign_event,
            commands::event_candidates,
            commands::events_on,
            commands::last_week,
            commands::no_spend_streak,
            commands::list_files,
            commands::create_file,
            commands::open_file,
            commands::switch_file,
            commands::rename_file,
            commands::forget_file,
            commands::open_quick,
            commands::hide_quick,
            commands::set_quick_hotkey,
            commands::report_period,
            commands::report_by_category,
            commands::compare_periods,
            commands::export_comparison,
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
            commands::plan_loan,
            commands::update_debt_terms,
            commands::add_debt_rate_change,
            commands::delete_debt_rate_change,
            commands::add_debt_holiday,
            commands::delete_debt_holiday,
            commands::set_debt_row_amount,
            commands::delete_debt_row_amount,
            commands::set_debt_planned_early,
            commands::quote_debt_payment,
            commands::debt_forecast,
            commands::debt_versions,
            commands::debt_schedule_doc,
            commands::calc_schedule_doc,
            commands::export_schedule_xlsx,
            commands::export_schedule_pdf,
            commands::preview_debt_terms,
            commands::preview_debt_change,
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
            commands::get_reminder,
            commands::edit_reminder_occurrence,
            commands::split_reminder,
            commands::pay_reminder,
            commands::list_notes,
            commands::create_note,
            commands::update_note,
            commands::delete_note,
            commands::export_summary,
            commands::export_transactions,
            commands::export_report,
            commands::import_preview,
            commands::import_csv,
            commands::save_bytes,
            commands::write_import_template,
            commands::backup_status,
            commands::backup_now,
            commands::inspect_backup,
            commands::restore_backup,
            vault::vault_status,
            vault::vault_sync,
            vault::verify_backup,
            vault::vault_places,
            vault::set_vault_dir,
            vault::vault_scan,
            vault::vault_inspect,
            vault::vault_transfer,
            vault::open_folder,
            commands::check_update,
            commands::install_update,
            commands::changelog,
            commands::list_templates,
            commands::create_template,
            commands::delete_template,
            commands::apply_template,
            commands::template_used,
            commands::undo_state,
            commands::undo,
            commands::redo,
            commands::list_goals,
            commands::free_until_income,
            commands::account_reserves,
            commands::forecast,
            commands::list_scenarios,
            commands::create_scenario,
            commands::update_scenario,
            commands::delete_scenario,
            commands::money_flow,
            commands::forecast_accounts,
            commands::set_forecast_excluded,
            commands::create_goal,
            commands::update_goal,
            commands::delete_goal,
            commands::goal_deposit,
            commands::list_subscriptions,
            commands::hide_subscription,
            commands::year_review,
            commands::global_search,
            commands::auto_import_dir,
            commands::auto_import_now,
            commands::explain_balance,
            commands::explain_period,
            commands::import_history,
            commands::import_undo,
            commands::import_suggestions,
            commands::import_accept,
            commands::import_reject,
            commands::create_transaction_full,
            commands::update_transaction_full,
            commands::set_transaction_spread,
            commands::sum_selected,
            commands::sum_filtered,
            commands::bulk_set_category,
            commands::bulk_set_payee,
            commands::bulk_set_account,
            commands::bulk_tag,
            commands::bulk_delete,
            commands::create_receipt,
            commands::update_receipt,
            commands::delete_receipt,
            commands::get_receipt,
            commands::list_tags,
            commands::set_transaction_tags,
            commands::rename_tag,
            commands::merge_tags,
            commands::delete_tag,
            commands::report_by_tag,
            commands::spending_vs_usual,
            commands::list_checks,
            commands::budget_warnings,
            commands::dismiss_check,
            commands::delete_duplicate,
            commands::net_worth_history,
        ])
        .build(tauri::generate_context!())
        .expect("не удалось запустить приложение")
        .run(|app, event| {
            // Папка сохранности при закрытии приложения (из трея «Выход» или закрытием окна).
            if let tauri::RunEvent::Exit = event {
                vault::sync_on_exit(app);
            }
        });
}
