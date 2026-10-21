//! Команды, которые вызывает UI. Каждая команда — тонкая обёртка над ядром:
//! здесь нет SQL и бизнес-правил.

use std::collections::BTreeMap;

use std::path::Path;

use budget_core::accounts::{self, Account, AccountInput, Totals};
use budget_core::assets::{self, Asset, AssetInput};
use budget_core::auto_import::{self, ScanResult};
use budget_core::backups::{self, BackupInfo};
use budget_core::budgets::{self, Budget, FillMode, Period};
use budget_core::calendar::{self, Month};
use budget_core::categories::{self, Category, CategoryInput};
use budget_core::cbr;
use budget_core::csv_import::{self, Preview};
use budget_core::currencies::{self, Currency, ExchangeRate};
use budget_core::debts::{self, DebtCard, DebtDetail, DebtInput, PaymentInput};
use budget_core::demo;
use budget_core::events::{self, Event, EventInput};
use budget_core::export;
use budget_core::goals::{self, Goal, GoalInput};
use budget_core::habits::{self, WeekSummary};
use budget_core::invest::{self, MonthProgress};
use budget_core::loan_calc::{self, Comparison, LoanInput, Schedule};
use budget_core::notes::{self, Note, NoteFilter, NoteInput};
use budget_core::onboarding::{self, Setup};
use budget_core::quick::{self, Draft};
use budget_core::reminders::{self, Key, Occurrence, Overview, ReminderInput};
use budget_core::reports::{self, BalancesReport, CategoryReport, MonthsReport, PeriodSummary};
use budget_core::rules::{self, Rule, RuleInput};
use budget_core::search::{self, Hit};
use budget_core::split::{self, SplitInput, SplitResult};
use budget_core::storage::{self, Storage};
use budget_core::subscriptions::{self, SubscriptionsReport};
use budget_core::templates::{self, Template, TemplateInput};
use budget_core::transactions::{self, Defaults, Filter, Page, PayeeHint, Txn, TxnInput};
use budget_core::undo::UndoState;
use budget_core::views::{self, SavedView, ViewInput};
use budget_core::wealth::{self, Cushion, FxReport};
use budget_core::year::{self, YearReview};
use budget_core::{settings, time, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

/// Действие пользователя, которое можно отменить (Ctrl+Z): изменения записываются в журнал.
fn with_undo<T>(
    state: &State<AppState>,
    label: &str,
    f: impl FnOnce(&mut Connection) -> budget_core::Result<T>,
) -> CmdResult<T> {
    let mut guard = state
        .db
        .lock()
        .map_err(|_| "база данных недоступна".to_string())?;
    let db = guard.as_mut().map_err(|e| e.clone())?;
    let mut journal = state
        .undo
        .lock()
        .map_err(|_| "журнал отмены недоступен".to_string())?;
    journal
        .record(db.conn_mut(), label, f)
        .map_err(|e| e.to_string())
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
    /// Переносная версия: обновления ставятся вручную, данные рядом с программой.
    portable: bool,
    data_dir: String,
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
            portable: state.portable,
            data_dir: state.data_dir.display().to_string(),
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
    with_undo(&state, "Курс валюты", |c| {
        currencies::set_rate(c, &date, &from, &to, &rate)
    })
}

#[tauri::command]
pub fn delete_rate(
    state: State<AppState>,
    date: String,
    from: String,
    to: String,
) -> CmdResult<()> {
    with_undo(&state, "Удаление курса", |c| {
        currencies::delete_rate(c, &date, &from, &to)
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

/// Загрузить официальные курсы ЦБ РФ на дату и записать их к основной валюте.
/// Сеть — до блокировки базы, чтобы окно не подвисало, пока ждём ответа.
#[tauri::command]
pub async fn load_cbr_rates(
    state: State<'_, AppState>,
    date: String,
) -> CmdResult<cbr::ImportResult> {
    let daily = download_cbr(&date).await?;
    with_undo(&state, "Курсы ЦБ РФ", |c| cbr::import(c, &daily))
}

/// Курсы ЦБ раз в день сами: при запуске и пока программа открыта.
/// `None` — выключено в Настройках или сегодня уже загружено. Без отмены (Ctrl+Z):
/// это не действие пользователя.
#[tauri::command]
pub async fn auto_cbr_rates(
    state: State<'_, AppState>,
    date: String,
) -> CmdResult<Option<cbr::ImportResult>> {
    if !with_db(&state, |db| cbr::auto_due(db.conn(), &date))? {
        return Ok(None);
    }
    let daily = download_cbr(&date).await?;
    with_db(&state, |db| cbr::auto_import(db.conn(), &date, &daily)).map(Some)
}

async fn download_cbr(date: &str) -> CmdResult<cbr::Daily> {
    let base = std::env::var("PTREASURY_CBR_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| cbr::DAILY_URL.to_string());
    let url = cbr::daily_url(&base, date).map_err(|e| e.to_string())?;
    let bytes = fetch_cbr(&url).await?;
    cbr::parse_daily(&bytes).map_err(|e| e.to_string())
}

async fn fetch_cbr(url: &str) -> CmdResult<Vec<u8>> {
    let offline =
        |_| "Нет связи с сайтом ЦБ РФ. Проверьте интернет и попробуйте ещё раз.".to_string();
    // Шифрование как у модуля обновлений: ring, если поставщик ещё не выбран.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("P-Treasury/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url).send().await.map_err(offline)?;
    if !response.status().is_success() {
        return Err(format!(
            "Сайт ЦБ РФ ответил ошибкой {}. Попробуйте позже.",
            response.status().as_u16()
        ));
    }
    Ok(response.bytes().await.map_err(offline)?.to_vec())
}

// --- Первый запуск ---

#[tauri::command]
pub fn finish_onboarding(state: State<AppState>, setup: Setup) -> CmdResult<()> {
    with_db(&state, |db| onboarding::finish(db.conn_mut(), &setup))
}

/// «Посмотреть на примере»: заполнить пустую базу пробными данными.
#[tauri::command]
pub fn seed_demo(state: State<AppState>) -> CmdResult<()> {
    with_db(&state, |db| demo::seed(db.conn_mut(), &time::today_local()))
}

/// Удалить пример и вернуться к мастеру первого запуска. Отменить нельзя:
/// журнал отмены очищается, чтобы Ctrl+Z не вернул пример по частям.
#[tauri::command]
pub fn clear_demo(state: State<AppState>) -> CmdResult<()> {
    with_db(&state, |db| demo::clear(db.conn_mut()))?;
    state
        .undo
        .lock()
        .map_err(|_| "журнал отмены недоступен".to_string())?
        .clear();
    Ok(())
}

// --- Счета ---

#[tauri::command]
pub fn list_accounts(state: State<AppState>, include_archived: bool) -> CmdResult<Vec<Account>> {
    with_db(&state, |db| accounts::list(db.conn(), include_archived))
}

#[tauri::command]
pub fn create_account(state: State<AppState>, input: AccountInput) -> CmdResult<String> {
    with_undo(&state, "Новый счёт", |c| {
        accounts::create(c, &input)
    })
}

#[tauri::command]
pub fn update_account(state: State<AppState>, id: String, input: AccountInput) -> CmdResult<()> {
    with_undo(&state, "Изменение счёта", |c| {
        accounts::update(c, &id, &input)
    })
}

#[tauri::command]
pub fn archive_account(state: State<AppState>, id: String, archived: bool) -> CmdResult<()> {
    with_undo(&state, "Закрытие счёта", |c| {
        accounts::set_archived(c, &id, archived)
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
    with_undo(&state, "Сверка баланса", |c| {
        accounts::adjust_balance(c, &id, actual_balance, &date, note.as_deref())
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
    with_undo(&state, "Новая категория", |c| {
        categories::create(c, &input)
    })
}

#[tauri::command]
pub fn update_category(
    state: State<AppState>,
    id: String,
    name: String,
    parent_id: Option<String>,
) -> CmdResult<()> {
    with_undo(&state, "Изменение категории", |c| {
        categories::update(c, &id, &name, parent_id.as_deref())
    })
}

#[tauri::command]
pub fn archive_category(state: State<AppState>, id: String, archived: bool) -> CmdResult<()> {
    with_undo(&state, "Архивация категории", |c| {
        categories::set_archived(c, &id, archived)
    })
}

#[tauri::command]
pub fn delete_category(
    state: State<AppState>,
    id: String,
    move_to: Option<String>,
) -> CmdResult<()> {
    with_undo(&state, "Удаление категории", |c| {
        categories::delete(c, &id, move_to.as_deref())
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
pub fn create_transaction(
    state: State<AppState>,
    input: TxnInput,
    event_id: Option<String>,
) -> CmdResult<String> {
    with_undo(&state, "Новая операция", |c| {
        let id = transactions::create(c, &input)?;
        if let Some(e) = event_id.as_deref() {
            events::assign(c, Some(e), std::slice::from_ref(&id))?;
        }
        Ok(id)
    })
}

#[tauri::command]
pub fn move_transaction(state: State<AppState>, id: String, date: String) -> CmdResult<()> {
    with_undo(&state, "Перенос операции", |c| {
        transactions::move_to(c, &id, &date)
    })
}

#[tauri::command]
pub fn split_expense(state: State<AppState>, input: SplitInput) -> CmdResult<SplitResult> {
    with_undo(&state, "Общая трата", |c| {
        split::create(c, &input)
    })
}

#[tauri::command]
pub fn update_transaction(state: State<AppState>, id: String, input: TxnInput) -> CmdResult<()> {
    with_undo(&state, "Изменение операции", |c| {
        transactions::update(c, &id, &input)
    })
}

#[tauri::command]
pub fn delete_transaction(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление операции", |c| {
        transactions::delete(c, &id)
    })
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
    with_undo(&state, "Создание бюджета", |c| {
        budgets::create(c, &month, copy_previous)
    })
}

#[tauri::command]
pub fn set_budget_limit(
    state: State<AppState>,
    budget_id: String,
    category_id: String,
    limit: Option<i64>,
) -> CmdResult<()> {
    with_undo(&state, "Изменение лимита", |c| {
        budgets::set_limit(c, &budget_id, &category_id, limit)
    })
}

#[tauri::command]
pub fn set_budget_note(
    state: State<AppState>,
    budget_id: String,
    note: Option<String>,
) -> CmdResult<()> {
    with_undo(&state, "Заметка к бюджету", |c| {
        budgets::set_note(c, &budget_id, note.as_deref())
    })
}

/// Заполнить лимиты по истории; возвращает число заданных лимитов.
#[tauri::command]
pub fn fill_budget(
    state: State<AppState>,
    budget_id: String,
    mode: FillMode,
    category_id: Option<String>,
) -> CmdResult<usize> {
    with_undo(&state, "Бюджет по истории", |c| {
        budgets::fill(c, &budget_id, mode, category_id.as_deref())
    })
}

#[tauri::command]
pub fn delete_budget(state: State<AppState>, budget_id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление бюджета", |c| {
        budgets::delete(c, &budget_id)
    })
}

#[tauri::command]
pub fn cushion(state: State<AppState>) -> CmdResult<Cushion> {
    with_db(&state, |db| {
        wealth::cushion(db.conn(), &time::today_local())
    })
}

#[tauri::command]
pub fn report_fx(state: State<AppState>, from: String, to: String) -> CmdResult<FxReport> {
    with_db(&state, |db| wealth::fx_gain(db.conn(), &from, &to))
}

#[tauri::command]
pub fn list_views(state: State<AppState>, kind: Option<String>) -> CmdResult<Vec<SavedView>> {
    with_db(&state, |db| views::list(db.conn(), kind.as_deref()))
}

#[tauri::command]
pub fn create_view(state: State<AppState>, input: ViewInput) -> CmdResult<String> {
    with_undo(&state, "Сохранение вида", |c| {
        views::create(c, &input)
    })
}

#[tauri::command]
pub fn delete_view(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление вида", |c| {
        views::delete(c, &id)
    })
}

#[tauri::command]
pub fn quick_parse(state: State<AppState>, text: String) -> CmdResult<Draft> {
    with_db(&state, |db| {
        quick::parse(db.conn(), &text, &time::today_local())
    })
}

#[tauri::command]
pub fn remember_rule(
    state: State<AppState>,
    merchant: String,
    category_id: String,
    payee: Option<String>,
) -> CmdResult<String> {
    with_undo(&state, "Правило для категории", |c| {
        quick::remember(c, &merchant, &category_id, payee.as_deref())
    })
}

#[tauri::command]
pub fn list_rules(state: State<AppState>) -> CmdResult<Vec<Rule>> {
    with_db(&state, |db| rules::list(db.conn()))
}

#[tauri::command]
pub fn create_rule(state: State<AppState>, input: RuleInput) -> CmdResult<String> {
    with_undo(&state, "Правило для категории", |c| {
        rules::create(c, &input)
    })
}

#[tauri::command]
pub fn delete_rule(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление правила", |c| {
        rules::delete(c, &id)
    })
}

#[tauri::command]
pub fn open_quick(app: AppHandle) -> CmdResult<()> {
    crate::quick_window::open(&app).map_err(|e| e.to_string())
}

/// Операция записана в окне быстрого ввода: окно прячется, главное обновляет данные.
#[tauri::command]
pub fn hide_quick(app: AppHandle, saved: bool) {
    crate::quick_window::hide(&app);
    if saved {
        let _ = app.emit("data-changed", ());
    }
}

#[tauri::command]
pub fn set_quick_hotkey(app: AppHandle, state: State<AppState>, hotkey: String) -> CmdResult<()> {
    if !settings::QUICK_HOTKEYS.contains(&hotkey.as_str()) {
        return Err(format!("сочетание «{hotkey}» не поддерживается"));
    }
    let old = crate::quick_window::saved_hotkey(&app);
    if let Err(e) = crate::quick_window::register(&app, &hotkey) {
        // Не получилось: прежнее сочетание продолжает работать.
        let _ = crate::quick_window::register(&app, &old);
        return Err(e);
    }
    with_db(&state, |db| {
        settings::set(db.conn(), "quick_hotkey", &hotkey)
    })
}

#[tauri::command]
pub fn list_assets(state: State<AppState>) -> CmdResult<Vec<Asset>> {
    with_db(&state, |db| assets::list(db.conn()))
}

#[tauri::command]
pub fn create_asset(state: State<AppState>, input: AssetInput) -> CmdResult<String> {
    with_undo(&state, "Новое имущество", |c| {
        assets::create(c, &input)
    })
}

#[tauri::command]
pub fn update_asset(state: State<AppState>, id: String, input: AssetInput) -> CmdResult<()> {
    with_undo(&state, "Изменение имущества", |c| {
        assets::update(c, &id, &input)
    })
}

#[tauri::command]
pub fn delete_asset(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление имущества", |c| {
        assets::delete(c, &id)
    })
}

#[tauri::command]
pub fn invest_overview(state: State<AppState>) -> CmdResult<invest::Overview> {
    with_db(&state, |db| {
        invest::overview(db.conn(), &time::today_local())
    })
}

#[tauri::command]
pub fn invest_month(state: State<AppState>, month: String) -> CmdResult<MonthProgress> {
    with_db(&state, |db| invest::month_progress(db.conn(), &month))
}

#[tauri::command]
pub fn set_invest_value(
    state: State<AppState>,
    account_id: String,
    date: String,
    value: i64,
) -> CmdResult<()> {
    with_undo(&state, "Стоимость инвестиций", |c| {
        invest::set_value(c, &account_id, &date, value)
    })
}

#[tauri::command]
pub fn delete_invest_value(
    state: State<AppState>,
    account_id: String,
    date: String,
) -> CmdResult<()> {
    with_undo(&state, "Удаление оценки", |c| {
        invest::delete_value(c, &account_id, &date)
    })
}

/// План на инвестиции: общий на каждый месяц или, с `month`, только на этот месяц.
#[tauri::command]
pub fn set_invest_plan(
    state: State<AppState>,
    mode: String,
    value: i64,
    month: Option<String>,
) -> CmdResult<()> {
    with_undo(&state, "План инвестиций", |c| match &month {
        Some(m) => invest::set_month_plan(c, m, &mode, value),
        None => invest::set_plan(c, &mode, value),
    })
}

#[tauri::command]
pub fn clear_invest_month_plan(state: State<AppState>, month: String) -> CmdResult<()> {
    with_undo(&state, "План инвестиций", |c| {
        invest::clear_month_plan(c, &month)
    })
}

#[tauri::command]
pub fn list_events(state: State<AppState>) -> CmdResult<Vec<Event>> {
    with_db(&state, |db| events::list(db.conn(), &time::today_local()))
}

#[tauri::command]
pub fn create_event(state: State<AppState>, input: EventInput) -> CmdResult<String> {
    with_undo(&state, "Новое событие", |c| {
        events::create(c, &input)
    })
}

#[tauri::command]
pub fn update_event(state: State<AppState>, id: String, input: EventInput) -> CmdResult<()> {
    with_undo(&state, "Изменение события", |c| {
        events::update(c, &id, &input)
    })
}

#[tauri::command]
pub fn delete_event(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление события", |c| {
        events::delete(c, &id)
    })
}

/// Отнести операции к событию; без `event_id` — снять отметку.
#[tauri::command]
pub fn assign_event(
    state: State<AppState>,
    event_id: Option<String>,
    txn_ids: Vec<String>,
) -> CmdResult<usize> {
    with_undo(&state, "Операции события", |c| {
        events::assign(c, event_id.as_deref(), &txn_ids)
    })
}

#[tauri::command]
pub fn event_candidates(state: State<AppState>, id: String) -> CmdResult<Vec<String>> {
    with_db(&state, |db| events::candidates(db.conn(), &id))
}

#[tauri::command]
pub fn events_on(state: State<AppState>, date: String) -> CmdResult<Vec<(String, String)>> {
    with_db(&state, |db| events::on_date(db.conn(), &date))
}

#[tauri::command]
pub fn last_week(state: State<AppState>) -> CmdResult<WeekSummary> {
    with_db(&state, |db| {
        habits::last_week(db.conn(), &time::today_local())
    })
}

#[tauri::command]
pub fn no_spend_streak(state: State<AppState>) -> CmdResult<u32> {
    with_db(&state, |db| habits::streak(db.conn(), &time::today_local()))
}

// --- Файлы бюджета ---

#[tauri::command]
pub fn list_files(state: State<AppState>) -> CmdResult<Vec<crate::files::FileRow>> {
    let current = with_db(&state, |db| Ok(db.path().to_path_buf()))?;
    Ok(crate::files::list(&state.data_dir, &current))
}

#[tauri::command]
pub fn create_file(state: State<AppState>, name: String) -> CmdResult<String> {
    crate::files::create(&state, &name)
}

#[tauri::command]
pub fn open_file(state: State<AppState>, path: String) -> CmdResult<()> {
    crate::files::open_existing(&state, Path::new(&path))
}

#[tauri::command]
pub fn switch_file(state: State<AppState>, path: String) -> CmdResult<()> {
    if !Path::new(&path).exists() {
        return Err("файла нет на месте: проверьте флешку или папку".into());
    }
    crate::files::switch(&state, Path::new(&path))
}

#[tauri::command]
pub fn rename_file(state: State<AppState>, path: String, name: String) -> CmdResult<()> {
    crate::files::rename(&state, &path, &name)
}

#[tauri::command]
pub fn forget_file(state: State<AppState>, path: String) -> CmdResult<()> {
    crate::files::forget(&state, &path)
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

/// Два периода для сравнения: `a` — с чем сравниваем, `b` — что сравниваем.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparePeriods {
    pub a_from: String,
    pub a_to: String,
    pub b_from: String,
    pub b_to: String,
}

#[tauri::command]
pub fn compare_periods(
    state: State<AppState>,
    kind: String,
    by: String,
    periods: ComparePeriods,
) -> CmdResult<budget_core::compare::Comparison> {
    let p = periods;
    with_db(&state, |db| {
        budget_core::compare::compare(
            db.conn(),
            &kind,
            &by,
            &p.a_from,
            &p.a_to,
            &p.b_from,
            &p.b_to,
        )
    })
}

#[tauri::command]
pub fn export_comparison(
    state: State<AppState>,
    kind: String,
    by: String,
    periods: ComparePeriods,
    path: String,
) -> CmdResult<()> {
    let p = periods;
    with_db(&state, |db| {
        let sheet = export::comparison_sheet(
            db.conn(),
            &kind,
            &by,
            &p.a_from,
            &p.a_to,
            &p.b_from,
            &p.b_to,
        )?;
        export::write_one(Path::new(&path), &sheet)
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
    with_undo(&state, "Новый долг", |c| debts::create(c, &input))
}

#[tauri::command]
pub fn update_debt_info(
    state: State<AppState>,
    id: String,
    counterparty: String,
    note: Option<String>,
) -> CmdResult<()> {
    with_undo(&state, "Изменение долга", |c| {
        debts::update_info(c, &id, &counterparty, note)
    })
}

#[tauri::command]
pub fn delete_debt(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление долга", |c| {
        debts::delete(c, &id)
    })
}

#[tauri::command]
pub fn pay_debt(state: State<AppState>, id: String, input: PaymentInput) -> CmdResult<String> {
    with_undo(&state, "Платёж по долгу", |c| {
        debts::pay(c, &id, &input)
    })
}

#[tauri::command]
pub fn delete_debt_payment(state: State<AppState>, payment_id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление платежа", |c| {
        debts::delete_payment(c, &payment_id)
    })
}

// --- Шаблоны операций ---

#[tauri::command]
pub fn list_templates(state: State<AppState>) -> CmdResult<Vec<Template>> {
    with_db(&state, |db| templates::list(db.conn()))
}

#[tauri::command]
pub fn create_template(state: State<AppState>, input: TemplateInput) -> CmdResult<String> {
    with_undo(&state, "Новый шаблон", |c| {
        templates::create(c, &input)
    })
}

#[tauri::command]
pub fn delete_template(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление шаблона", |c| {
        templates::delete(c, &id)
    })
}

#[tauri::command]
pub fn apply_template(state: State<AppState>, id: String, date: String) -> CmdResult<String> {
    let txn = with_undo(&state, "Операция по шаблону", |c| {
        templates::apply(c, &id, &date)
    })?;
    with_db(&state, |db| templates::used(db.conn(), &id))?;
    Ok(txn)
}

#[tauri::command]
pub fn template_used(state: State<AppState>, id: String) -> CmdResult<()> {
    with_db(&state, |db| templates::used(db.conn(), &id))
}

// --- Отмена и повтор ---

#[tauri::command]
pub fn undo_state(state: State<AppState>) -> CmdResult<UndoState> {
    Ok(state
        .undo
        .lock()
        .map_err(|_| "журнал отмены недоступен".to_string())?
        .state())
}

/// Отменить последнее действие; возвращает его название (или ничего, если отменять нечего).
#[tauri::command]
pub fn undo(state: State<AppState>) -> CmdResult<Option<String>> {
    with_db(&state, |db| {
        let mut j = state
            .undo
            .lock()
            .map_err(|_| budget_core::Error::Validation("журнал отмены недоступен".into()))?;
        j.undo(db.conn())
    })
}

#[tauri::command]
pub fn redo(state: State<AppState>) -> CmdResult<Option<String>> {
    with_db(&state, |db| {
        let mut j = state
            .undo
            .lock()
            .map_err(|_| budget_core::Error::Validation("журнал отмены недоступен".into()))?;
        j.redo(db.conn())
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
    with_undo(&state, "Новое напоминание", |c| {
        reminders::create(c, &input)
    })
}

#[tauri::command]
pub fn update_reminder(state: State<AppState>, id: String, input: ReminderInput) -> CmdResult<()> {
    with_undo(&state, "Изменение напоминания", |c| {
        reminders::update(c, &id, &input)
    })
}

#[tauri::command]
pub fn set_reminder_active(state: State<AppState>, id: String, active: bool) -> CmdResult<()> {
    with_undo(&state, "Включение напоминания", |c| {
        reminders::set_active(c, &id, active)
    })
}

#[tauri::command]
pub fn delete_reminder(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление напоминания", |c| {
        reminders::delete(c, &id)
    })
}

#[tauri::command]
pub fn complete_reminder(
    state: State<AppState>,
    key: Key,
    transaction_id: Option<String>,
) -> CmdResult<()> {
    with_undo(&state, "Напоминание выполнено", |c| {
        reminders::complete(c, &key, transaction_id.as_deref())
    })
}

#[tauri::command]
pub fn snooze_reminder(state: State<AppState>, key: Key, until: String) -> CmdResult<()> {
    with_undo(&state, "Отложенное напоминание", |c| {
        reminders::snooze(c, &key, &until)
    })
}

#[tauri::command]
pub fn dismiss_reminder(state: State<AppState>, key: Key) -> CmdResult<()> {
    with_undo(&state, "Пропуск напоминания", |c| {
        reminders::dismiss(c, &key)
    })
}

#[tauri::command]
pub fn reopen_reminder(state: State<AppState>, key: Key) -> CmdResult<()> {
    with_undo(&state, "Возврат напоминания", |c| {
        reminders::reopen(c, &key)
    })
}

#[tauri::command]
pub fn list_notes(state: State<AppState>, filter: NoteFilter) -> CmdResult<Vec<Note>> {
    with_db(&state, |db| notes::list(db.conn(), &filter))
}

#[tauri::command]
pub fn create_note(state: State<AppState>, input: NoteInput) -> CmdResult<String> {
    with_undo(&state, "Новая заметка", |c| {
        notes::create(c, &input)
    })
}

#[tauri::command]
pub fn update_note(state: State<AppState>, id: String, input: NoteInput) -> CmdResult<()> {
    with_undo(&state, "Изменение заметки", |c| {
        notes::update(c, &id, &input)
    })
}

#[tauri::command]
pub fn delete_note(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление заметки", |c| {
        notes::delete(c, &id)
    })
}

// --- Данные: выгрузка, импорт, резервные копии, обновления ---

#[tauri::command]
pub fn export_summary(
    state: State<AppState>,
    from: String,
    to: String,
    path: String,
) -> CmdResult<()> {
    with_db(&state, |db| {
        let sheets = export::summary_workbook(db.conn(), &from, &to, &time::today_local())?;
        export::write_xlsx(Path::new(&path), &sheets)
    })
}

#[tauri::command]
pub fn export_transactions(state: State<AppState>, filter: Filter, path: String) -> CmdResult<()> {
    with_db(&state, |db| {
        let sheet = export::transactions_sheet(db.conn(), &filter)?;
        export::write_one(Path::new(&path), &sheet)
    })
}

#[tauri::command]
pub fn export_report(
    state: State<AppState>,
    report: String,
    from: String,
    to: String,
    path: String,
) -> CmdResult<()> {
    with_db(&state, |db| {
        let sheet = export::report_sheet(db.conn(), &report, &from, &to)?;
        export::write_one(Path::new(&path), &sheet)
    })
}

#[tauri::command]
pub fn import_preview(state: State<AppState>, path: String) -> CmdResult<Preview> {
    with_db(&state, |db| {
        csv_import::preview(db.conn(), Path::new(&path))
    })
}

#[tauri::command]
pub fn import_csv(state: State<AppState>, path: String, skip_errors: bool) -> CmdResult<usize> {
    with_undo(&state, "Импорт операций", |c| {
        csv_import::import(c, Path::new(&path), skip_errors)
    })
}

#[tauri::command]
pub fn write_import_template(path: String) -> CmdResult<()> {
    csv_import::write_template(Path::new(&path)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    last_backup_at: Option<String>,
    autobackup_dir: String,
    autobackup_keep: String,
    reminder_due: bool,
    default_name: String,
}

#[tauri::command]
pub fn backup_status(state: State<AppState>) -> CmdResult<BackupStatus> {
    with_db(&state, |db| {
        let c = db.conn();
        Ok(BackupStatus {
            last_backup_at: settings::get(c, "last_backup_at")?.filter(|v| !v.is_empty()),
            autobackup_dir: settings::get(c, "autobackup_dir")?.unwrap_or_default(),
            autobackup_keep: settings::get(c, "autobackup_keep")?.unwrap_or_else(|| "10".into()),
            reminder_due: backups::reminder_due(c, &time::today_local())?,
            default_name: backups::default_name(),
        })
    })
}

#[tauri::command]
pub fn backup_now(state: State<AppState>, path: String) -> CmdResult<()> {
    with_db(&state, |db| backups::backup(db.conn(), Path::new(&path)))
}

#[tauri::command]
pub fn inspect_backup(path: String) -> CmdResult<BackupInfo> {
    backups::inspect(Path::new(&path)).map_err(|e| e.to_string())
}

/// Восстановить из копии; возвращает путь к копии прежних данных.
#[tauri::command]
pub fn restore_backup(state: State<AppState>, path: String) -> CmdResult<String> {
    let opts = state.open_options();
    let safety = with_db(&state, |db| {
        Ok(db
            .restore_from(Path::new(&path), &opts)?
            .display()
            .to_string())
    })?;
    // Данные заменены целиком: прежние шаги отмены к ним не относятся.
    if let Ok(mut j) = state.undo.lock() {
        j.clear();
    }
    Ok(safety)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Адрес обновлений задан (до первой публикации его нет).
    configured: bool,
    current: String,
    /// Новая версия, если есть.
    version: Option<String>,
    notes: Option<String>,
}

/// Адрес файла с описанием последней версии: переменная окружения (для тестов)
/// или адрес, вшитый при сборке выпуска.
fn update_endpoint() -> Option<String> {
    std::env::var("PTREASURY_UPDATE_URL")
        .ok()
        .or_else(|| option_env!("PTREASURY_UPDATE_ENDPOINT").map(str::to_string))
        .filter(|u| !u.is_empty())
}

fn updater(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Updater>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let Some(url) = update_endpoint() else {
        return Ok(None);
    };
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let u = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Some(u))
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> CmdResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let Some(u) = updater(&app)? else {
        return Ok(UpdateInfo {
            configured: false,
            current,
            version: None,
            notes: None,
        });
    };
    let update = u
        .check()
        .await
        .map_err(|e| format!("не удалось проверить обновления: {e}"))?;
    Ok(UpdateInfo {
        configured: true,
        current,
        version: update.as_ref().map(|x| x.version.clone()),
        notes: update.and_then(|x| x.body),
    })
}

/// Скачать и поставить обновление. Перед этим — копия данных; после — перезапуск.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    {
        let opts = state.open_options();
        let guard = state
            .db
            .lock()
            .map_err(|_| "база данных недоступна".to_string())?;
        let db = guard.as_ref().map_err(|e| e.clone())?;
        let dest = opts
            .backup_dir
            .join(format!("before-app-update-{}.db", time::file_stamp()));
        storage::backup_to(db.conn(), &dest).map_err(|e| e.to_string())?;
    }
    let Some(u) = updater(&app)? else {
        return Err("адрес обновлений не задан".into());
    };
    let Some(update) = u.check().await.map_err(|e| e.to_string())? else {
        return Err("новой версии нет".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("не удалось установить обновление: {e}"))?;
    app.restart();
}

#[tauri::command]
pub fn changelog() -> &'static str {
    include_str!("../../CHANGELOG.md")
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Сервер на один ответ вместо cbr.ru (из тестовой среды сайт ЦБ недоступен).
    fn serve_once(status: &str, body: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf);
            s.write_all(head.as_bytes()).unwrap();
            s.write_all(body).unwrap();
        });
        format!("http://{addr}/scripts/XML_daily.asp")
    }

    #[test]
    fn fetch_returns_body_and_explains_errors() {
        let block_on = tauri::async_runtime::block_on;
        let url = serve_once("200 OK", b"<ValCurs/>");
        assert_eq!(block_on(super::fetch_cbr(&url)).unwrap(), b"<ValCurs/>");

        let url = serve_once("503 Service Unavailable", b"");
        let err = block_on(super::fetch_cbr(&url)).unwrap_err();
        assert!(err.contains("ошибкой 503"), "{err}");

        // Порт, который никто не слушает: как будто нет интернета.
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let err = block_on(super::fetch_cbr(&format!("http://{free}/"))).unwrap_err();
        assert!(err.starts_with("Нет связи с сайтом ЦБ РФ"), "{err}");
    }
}

#[tauri::command]
pub fn list_goals(state: State<AppState>) -> CmdResult<Vec<Goal>> {
    with_db(&state, |db| goals::list(db.conn(), &time::today_local()))
}

#[tauri::command]
pub fn create_goal(state: State<AppState>, input: GoalInput) -> CmdResult<String> {
    with_undo(&state, "Новая цель", |c| goals::create(c, &input))
}

#[tauri::command]
pub fn update_goal(state: State<AppState>, id: String, input: GoalInput) -> CmdResult<()> {
    with_undo(&state, "Изменение цели", |c| {
        goals::update(c, &id, &input)
    })
}

#[tauri::command]
pub fn delete_goal(state: State<AppState>, id: String) -> CmdResult<()> {
    with_undo(&state, "Удаление цели", |c| {
        goals::delete(c, &id)
    })
}

#[tauri::command]
pub fn goal_deposit(
    state: State<AppState>,
    id: String,
    date: String,
    amount: i64,
) -> CmdResult<()> {
    with_undo(&state, "Пополнение цели", |c| {
        goals::deposit(c, &id, &date, amount)
    })
}

#[tauri::command]
pub fn list_subscriptions(state: State<AppState>) -> CmdResult<SubscriptionsReport> {
    with_db(&state, |db| {
        subscriptions::list(db.conn(), &time::today_local())
    })
}

#[tauri::command]
pub fn hide_subscription(state: State<AppState>, key: String, hide: bool) -> CmdResult<()> {
    with_undo(
        &state,
        if hide {
            "Скрыть подписку"
        } else {
            "Вернуть подписку"
        },
        |c| subscriptions::set_hidden(c, &key, hide),
    )
}

#[tauri::command]
pub fn year_review(state: State<AppState>, year: i32) -> CmdResult<YearReview> {
    with_db(&state, |db| {
        year::review(db.conn(), year, &time::today_local())
    })
}

#[tauri::command]
pub fn global_search(state: State<AppState>, query: String) -> CmdResult<Vec<Hit>> {
    with_db(&state, |db| search::find(db.conn(), &query))
}

/// Папка автоимпорта: выбранная в Настройках или «Загрузки».
#[tauri::command]
pub fn auto_import_dir(app: AppHandle) -> CmdResult<String> {
    crate::background::import_dir(&app)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "не найдена папка «Загрузки»: выберите папку в Настройках".to_string())
}

/// Проверить папку сейчас (кнопка в Настройках).
#[tauri::command]
pub fn auto_import_now(app: AppHandle, state: State<AppState>) -> CmdResult<ScanResult> {
    let dir = auto_import_dir(app)?;
    with_db(&state, |db| {
        auto_import::scan(db.conn_mut(), Path::new(&dir))
    })
}
