//! Команды, которые вызывает UI. Каждая команда — тонкая обёртка над ядром:
//! здесь нет SQL и бизнес-правил.

use std::collections::BTreeMap;

use budget_core::currencies::{self, Currency};
use budget_core::storage::Storage;
use budget_core::{settings, storage};
use serde::Serialize;
use tauri::State;

use crate::AppState;

type CmdResult<T> = Result<T, String>;

fn with_db<T>(
    state: &State<AppState>,
    f: impl FnOnce(&Storage) -> budget_core::Result<T>,
) -> CmdResult<T> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "база данных недоступна".to_string())?;
    let db = guard.as_ref().map_err(Clone::clone)?;
    f(db).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    schema_version: i64,
    supported_schema_version: i64,
    db_path: String,
    pre_migration_backup: Option<String>,
}

#[tauri::command]
pub fn app_info(state: State<AppState>) -> CmdResult<AppInfo> {
    with_db(&state, |db| {
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION"),
            schema_version: db.schema_version()?,
            supported_schema_version: storage::LATEST_VERSION,
            db_path: db.path().display().to_string(),
            pre_migration_backup: db.pre_migration_backup().map(|p| p.display().to_string()),
        })
    })
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> CmdResult<BTreeMap<String, String>> {
    with_db(&state, |db| settings::all(db.conn()))
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> CmdResult<()> {
    with_db(&state, |db| settings::set(db.conn(), &key, &value))
}

#[tauri::command]
pub fn list_currencies(state: State<AppState>) -> CmdResult<Vec<Currency>> {
    with_db(&state, |db| currencies::list(db.conn()))
}
