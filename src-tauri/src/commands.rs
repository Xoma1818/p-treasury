//! Команды, которые вызывает UI. Каждая команда — тонкая обёртка над ядром:
//! здесь нет SQL и бизнес-правил.

use std::collections::BTreeMap;

use budget_core::accounts::{self, Account, AccountInput, Totals};
use budget_core::budgets::{self, Budget, Period};
use budget_core::calendar::{self, Month};
use budget_core::categories::{self, Category, CategoryInput};
use budget_core::currencies::{self, Currency, ExchangeRate};
use budget_core::debts::{self, DebtCard, DebtDetail, DebtInput, PaymentInput};
use budget_core::loan_calc::{self, Comparison, LoanInput, Schedule};
use budget_core::notes::{self, Note, NoteFilter, NoteInput};
use budget_core::onboarding::{self, Setup};
use budget_core::reminders::{self, Key, Occurrence, Overview, ReminderInput};
use budget_core::reports::{self, BalancesReport, CategoryReport, MonthsReport, PeriodSummary};
use budget_core::storage::{self, Storage};
use budget_core::transactions::{self, Defaults, Filter, Page, PayeeHint, Txn, TxnInput};
use budget_core::{settings, time};
use serde::Serialize;
use tauri::State;

use crate::AppState;

type CmdResult<T> = Result<T, String>;

fn with_db<T>(
    state: &State<AppState>,
    f: impl FnOnce(&mut Storage) -> budget_core::Result<T>,
) -> CmdResult<T> {
    let mut guard = state
        .db
        .lock()
        .map_err(|_| "база данных недоступна".to_string())?;
    let db = guard.as_mut().map_err(|e| e.clone())?;
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
    onboarding_done: bool,
    today: String,
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
            onboarding_done: onboarding::is_done(db.conn())?,
            today: time::today_local(),
        })
    })
}

// --- Настройки и валюты ---

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

#[tauri::command]
pub fn list_rates(state: State<AppState>) -> CmdResult<Vec<ExchangeRate>> {
    with_db(&state, |db| currencies::list_rates(db.conn()))
}

#[tauri::command]
pub fn set_rate(
    state: State<AppState>,
    date: String,
    from: String,
    to: String,
    rate: String,
) -> CmdResult<()> {
    with_db(&state, |db| {
        currencies::set_rate(db.conn(), &date, &from, &to, &rate)
    })
}

#[tauri::command]
pub fn delete_rate(
    state: State<AppState>,
    date: String,
    from: String,
    to: String,
) -> CmdResult<()> {
    with_db(&state, |db| {
        currencies::delete_rate(db.conn(), &date, &from, &to)
    })
}

#[tauri::command]
pub fn rate_on(
    state: State<AppState>,
    from: String,
    to: String,
    date: String,
) -> CmdResult<Option<String>> {
    with_db(&state, |db| {
        currencies::rate_on(db.conn(), &from, &to, &date)
    })
}

// --- Первый запуск ---

#[tauri::command]
pub fn finish_onboarding(state: State<AppState>, setup: Setup) -> CmdResult<()> {
    with_db(&state, |db| onboarding::finish(db.conn_mut(), &setup))
}

// --- Счета ---

#[tauri::command]
pub fn list_accounts(state: State<AppState>, include_archived: bool) -> CmdResult<Vec<Account>> {
    with_db(&state, |db| accounts::list(db.conn(), include_archived))
}

#[tauri::command]
pub fn create_account(state: State<AppState>, input: AccountInput) -> CmdResult<String> {
    with_db(&state, |db| accounts::create(db.conn(), &input))
}

#[tauri::command]
pub fn update_account(state: State<AppState>, id: String, input: AccountInput) -> CmdResult<()> {
    with_db(&state, |db| accounts::update(db.conn(), &id, &input))
}

#[tauri::command]
pub fn archive_account(state: State<AppState>, id: String, archived: bool) -> CmdResult<()> {
    with_db(&state, |db| {
        accounts::set_archived(db.conn(), &id, archived)
    })
}

#[tauri::command]
pub fn adjust_balance(
    state: State<AppState>,
    id: String,
    actual_balance: i64,
    date: String,
    note: Option<String>,
) -> CmdResult<Option<String>> {
    with_db(&state, |db| {
        accounts::adjust_balance(db.conn(), &id, actual_balance, &date, note.as_deref())
    })
}

#[tauri::command]
pub fn totals(state: State<AppState>, date: String) -> CmdResult<Totals> {
    with_db(&state, |db| accounts::totals(db.conn(), &date))
}

// --- Категории ---

#[tauri::command]
pub fn list_categories(state: State<AppState>, include_archived: bool) -> CmdResult<Vec<Category>> {
    with_db(&state, |db| categories::list(db.conn(), include_archived))
}

#[tauri::command]
pub fn create_category(state: State<AppState>, input: CategoryInput) -> CmdResult<String> {
    with_db(&state, |db| categories::create(db.conn(), &input))
}

#[tauri::command]
pub fn update_category(
    state: State<AppState>,
    id: String,
    name: String,
    parent_id: Option<String>,
) -> CmdResult<()> {
    with_db(&state, |db| {
        categories::update(db.conn(), &id, &name, parent_id.as_deref())
    })
}

#[tauri::command]
pub fn archive_category(state: State<AppState>, id: String, archived: bool) -> CmdResult<()> {
    with_db(&state, |db| {
        categories::set_archived(db.conn(), &id, archived)
    })
}

#[tauri::command]
pub fn delete_category(
    state: State<AppState>,
    id: String,
    move_to: Option<String>,
) -> CmdResult<()> {
    with_db(&state, |db| {
        categories::delete(db.conn_mut(), &id, move_to.as_deref())
    })
}

// --- Операции ---

#[tauri::command]
pub fn list_transactions(state: State<AppState>, filter: Filter) -> CmdResult<Page> {
    with_db(&state, |db| transactions::list(db.conn(), &filter))
}

#[tauri::command]
pub fn get_transaction(state: State<AppState>, id: String) -> CmdResult<Txn> {
    with_db(&state, |db| transactions::get(db.conn(), &id))
}

#[tauri::command]
pub fn create_transaction(state: State<AppState>, input: TxnInput) -> CmdResult<String> {
    with_db(&state, |db| transactions::create(db.conn(), &input))
}

#[tauri::command]
pub fn update_transaction(state: State<AppState>, id: String, input: TxnInput) -> CmdResult<()> {
    with_db(&state, |db| transactions::update(db.conn(), &id, &input))
}

#[tauri::command]
pub fn delete_transaction(state: State<AppState>, id: String) -> CmdResult<()> {
    with_db(&state, |db| transactions::delete(db.conn(), &id))
}

#[tauri::command]
pub fn payee_hints(
    state: State<AppState>,
    kind: String,
    query: String,
) -> CmdResult<Vec<PayeeHint>> {
    with_db(&state, |db| {
        transactions::payee_hints(db.conn(), &kind, &query, 8)
    })
}

#[tauri::command]
pub fn transaction_defaults(state: State<AppState>, kind: String) -> CmdResult<Defaults> {
    with_db(&state, |db| transactions::defaults(db.conn(), &kind))
}

// --- Отчёты ---

#[tauri::command]
pub fn period_summary(
    state: State<AppState>,
    from: String,
    to: String,
) -> CmdResult<PeriodSummary> {
    with_db(&state, |db| reports::period_summary(db.conn(), &from, &to))
}

// --- Бюджеты ---

#[tauri::command]
pub fn get_budget(state: State<AppState>, month: String) -> CmdResult<Budget> {
    with_db(&state, |db| {
        budgets::get(db.conn(), &month, &time::today_local())
    })
}

#[tauri::command]
pub fn month_of(state: State<AppState>, date: String) -> CmdResult<Period> {
    with_db(&state, |db| budgets::month_of(db.conn(), &date))
}

#[tauri::command]
pub fn create_budget(
    state: State<AppState>,
    month: String,
    copy_previous: bool,
) -> CmdResult<String> {
    with_db(&state, |db| {
        budgets::create(db.conn_mut(), &month, copy_previous)
    })
}

#[tauri::command]
pub fn set_budget_limit(
    state: State<AppState>,
    budget_id: String,
    category_id: String,
    limit: Option<i64>,
) -> CmdResult<()> {
    with_db(&state, |db| {
        budgets::set_limit(db.conn(), &budget_id, &category_id, limit)
    })
}

#[tauri::command]
pub fn set_budget_note(
    state: State<AppState>,
    budget_id: String,
    note: Option<String>,
) -> CmdResult<()> {
    with_db(&state, |db| {
        budgets::set_note(db.conn(), &budget_id, note.as_deref())
    })
}

#[tauri::command]
pub fn delete_budget(state: State<AppState>, budget_id: String) -> CmdResult<()> {
    with_db(&state, |db| budgets::delete(db.conn(), &budget_id))
}

#[tauri::command]
pub fn report_period(state: State<AppState>, kind: String, month: String) -> CmdResult<Period> {
    with_db(&state, |db| reports::period_of(db.conn(), &kind, &month))
}

#[tauri::command]
pub fn report_by_category(
    state: State<AppState>,
    kind: String,
    from: String,
    to: String,
) -> CmdResult<CategoryReport> {
    with_db(&state, |db| {
        reports::by_category(db.conn(), &kind, &from, &to)
    })
}

#[tauri::command]
pub fn report_by_month(
    state: State<AppState>,
    from_month: String,
    to_month: String,
) -> CmdResult<MonthsReport> {
    with_db(&state, |db| {
        reports::by_month(db.conn(), &from_month, &to_month)
    })
}

#[tauri::command]
pub fn report_balances(state: State<AppState>, date: String) -> CmdResult<BalancesReport> {
    with_db(&state, |db| reports::balances_on(db.conn(), &date))
}

// --- Долги и калькулятор ---

#[tauri::command]
pub fn calc_loan(input: LoanInput) -> CmdResult<Schedule> {
    loan_calc::calculate(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn compare_loans(input: LoanInput) -> CmdResult<Comparison> {
    loan_calc::compare(&input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_debts(state: State<AppState>) -> CmdResult<Vec<DebtCard>> {
    with_db(&state, |db| debts::list(db.conn(), &time::today_local()))
}

#[tauri::command]
pub fn get_debt(state: State<AppState>, id: String) -> CmdResult<DebtDetail> {
    with_db(&state, |db| {
        debts::get(db.conn(), &id, &time::today_local())
    })
}

#[tauri::command]
pub fn debt_summary(state: State<AppState>) -> CmdResult<debts::Summary> {
    with_db(&state, |db| {
        debts::summary(db.conn(), &time::today_local(), 5)
    })
}

#[tauri::command]
pub fn create_debt(state: State<AppState>, input: DebtInput) -> CmdResult<String> {
    with_db(&state, |db| debts::create(db.conn_mut(), &input))
}

#[tauri::command]
pub fn update_debt_info(
    state: State<AppState>,
    id: String,
    counterparty: String,
    note: Option<String>,
) -> CmdResult<()> {
    with_db(&state, |db| {
        debts::update_info(db.conn(), &id, &counterparty, note)
    })
}

#[tauri::command]
pub fn delete_debt(state: State<AppState>, id: String) -> CmdResult<()> {
    with_db(&state, |db| debts::delete(db.conn_mut(), &id))
}

#[tauri::command]
pub fn pay_debt(state: State<AppState>, id: String, input: PaymentInput) -> CmdResult<String> {
    with_db(&state, |db| debts::pay(db.conn_mut(), &id, &input))
}

#[tauri::command]
pub fn delete_debt_payment(state: State<AppState>, payment_id: String) -> CmdResult<()> {
    with_db(&state, |db| {
        debts::delete_payment(db.conn_mut(), &payment_id)
    })
}

// --- Календарь, напоминания, заметки ---

#[tauri::command]
pub fn calendar_month(state: State<AppState>, month: String) -> CmdResult<Month> {
    with_db(&state, |db| {
        calendar::month(db.conn(), &month, &time::today_local())
    })
}

#[tauri::command]
pub fn calendar_range(state: State<AppState>, from: String, to: String) -> CmdResult<Month> {
    let parse = |s: &str| {
        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|_| format!("некорректная дата: {s}"))
    };
    let (from, to) = (parse(&from)?, parse(&to)?);
    with_db(&state, |db| {
        calendar::range(db.conn(), from, to, &time::today_local())
    })
}

#[tauri::command]
pub fn reminders_overview(state: State<AppState>) -> CmdResult<Overview> {
    with_db(&state, |db| {
        reminders::overview(db.conn(), time::now_local())
    })
}

/// Наступившие и не выполненные: окно «Пропущенные напоминания» при запуске.
#[tauri::command]
pub fn missed_reminders(state: State<AppState>) -> CmdResult<Vec<Occurrence>> {
    with_db(&state, |db| {
        Ok(reminders::overview(db.conn(), time::now_local())?.overdue)
    })
}

#[tauri::command]
pub fn create_reminder(state: State<AppState>, input: ReminderInput) -> CmdResult<String> {
    with_db(&state, |db| reminders::create(db.conn(), &input))
}

#[tauri::command]
pub fn update_reminder(state: State<AppState>, id: String, input: ReminderInput) -> CmdResult<()> {
    with_db(&state, |db| reminders::update(db.conn(), &id, &input))
}

#[tauri::command]
pub fn set_reminder_active(state: State<AppState>, id: String, active: bool) -> CmdResult<()> {
    with_db(&state, |db| reminders::set_active(db.conn(), &id, active))
}

#[tauri::command]
pub fn delete_reminder(state: State<AppState>, id: String) -> CmdResult<()> {
    with_db(&state, |db| reminders::delete(db.conn(), &id))
}

#[tauri::command]
pub fn complete_reminder(
    state: State<AppState>,
    key: Key,
    transaction_id: Option<String>,
) -> CmdResult<()> {
    with_db(&state, |db| {
        reminders::complete(db.conn(), &key, transaction_id.as_deref())
    })
}

#[tauri::command]
pub fn snooze_reminder(state: State<AppState>, key: Key, until: String) -> CmdResult<()> {
    with_db(&state, |db| reminders::snooze(db.conn(), &key, &until))
}

#[tauri::command]
pub fn dismiss_reminder(state: State<AppState>, key: Key) -> CmdResult<()> {
    with_db(&state, |db| reminders::dismiss(db.conn(), &key))
}

#[tauri::command]
pub fn reopen_reminder(state: State<AppState>, key: Key) -> CmdResult<()> {
    with_db(&state, |db| reminders::reopen(db.conn(), &key))
}

#[tauri::command]
pub fn list_notes(state: State<AppState>, filter: NoteFilter) -> CmdResult<Vec<Note>> {
    with_db(&state, |db| notes::list(db.conn(), &filter))
}

#[tauri::command]
pub fn create_note(state: State<AppState>, input: NoteInput) -> CmdResult<String> {
    with_db(&state, |db| notes::create(db.conn(), &input))
}

#[tauri::command]
pub fn update_note(state: State<AppState>, id: String, input: NoteInput) -> CmdResult<()> {
    with_db(&state, |db| notes::update(db.conn(), &id, &input))
}

#[tauri::command]
pub fn delete_note(state: State<AppState>, id: String) -> CmdResult<()> {
    with_db(&state, |db| notes::delete(db.conn(), &id))
}
