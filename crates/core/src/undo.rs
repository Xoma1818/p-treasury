//! Отмена и повтор (Ctrl+Z / Ctrl+Y).
//!
//! Каждое действие пользователя записывается сессией SQLite: она запоминает
//! «до» и «после» всех строк, которые действие изменило, в любых таблицах
//! (включая каскадные изменения). Отмена применяет обратный набор изменений,
//! повтор — прямой, оба в одной транзакции. Если строки с тех пор изменились
//! (или от удаляемой строки уже зависят новые), SQLite сообщает о конфликте,
//! и шаг не выполняется: данные остаются как были.
//!
//! Журнал живёт в памяти, до 50 шагов, и очищается при закрытии приложения.

use std::ffi::{c_int, c_void};
use std::ptr;

use rusqlite::session::Session;
use rusqlite::{ffi, Connection};
use serde::Serialize;

use crate::{Error, Result};

/// Сколько шагов помнить.
pub const LIMIT: usize = 50;

struct Step {
    id: u64,
    label: String,
    action: Action,
}

enum Action {
    Rows {
        changes: Vec<u8>,
        settings: Vec<(String, Option<String>, Option<String>)>,
    },
    InvestPlan {
        before: crate::invest::PlanValues,
        after: crate::invest::PlanValues,
    },
    InvestMonthCurrency {
        month: String,
        value: i64,
        currency: String,
    },
}

impl Action {
    fn replay(&self, conn: &Connection, invert: bool) -> Result<()> {
        match self {
            Self::InvestMonthCurrency {
                month,
                value,
                currency,
            } => {
                let code = Some(currency.as_str());
                let (from, to) = if invert { (code, None) } else { (None, code) };
                crate::invest::replace_month_currency(conn, month, *value, from, to)
            }
            Self::InvestPlan { before, after } => {
                let (from, to) = if invert {
                    (after, before)
                } else {
                    (before, after)
                };
                crate::invest::write_plan(conn, from, to)
            }
            Self::Rows { changes, settings } => {
                // Изменения строк, связанных настроек и истории составляют один шаг.
                // SAVEPOINT также поддерживает вызывающего внутри своей транзакции.
                conn.execute_batch("SAVEPOINT kazna_undo_rows")?;
                let result = (|| {
                    let snap = crate::history::before_undo(conn, &touched(changes)?)?;
                    apply(conn, changes, invert)?;
                    for (key, before, after) in settings {
                        let (from, to) = if invert {
                            (after, before)
                        } else {
                            (before, after)
                        };
                        shift_setting(conn, key, from, to)?;
                    }
                    crate::history::after_undo(conn, &snap)?;
                    conn.execute_batch("RELEASE kazna_undo_rows")?;
                    Ok(())
                })();
                if result.is_err() && !conn.is_autocommit() {
                    conn.execute_batch("ROLLBACK TO kazna_undo_rows; RELEASE kazna_undo_rows")?;
                }
                result
            }
        }
    }
}

/// Эти списки меняются одновременно с данными счетов и видимостью подписок.
/// Их прежний состав нужен для отмены действия целиком.
const UNDOABLE_SETTINGS: &[&str] = &[
    "budget_excluded_accounts",
    "forecast_excluded_accounts",
    "subscriptions_hidden",
];

fn read_settings(conn: &Connection) -> Result<Vec<Option<String>>> {
    UNDOABLE_SETTINGS
        .iter()
        .map(|k| crate::settings::get(conn, k))
        .collect()
}

fn ids_of(value: &Option<String>) -> Vec<String> {
    value
        .as_deref()
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default()
}

/// Перевести список счетов из `from` в `to`, не трогая счета, которые с тех пор
/// изменили другим путём (например, в «Взгляде вперёд»): отменяется только своё.
fn shift_setting(
    conn: &Connection,
    key: &str,
    from: &Option<String>,
    to: &Option<String>,
) -> Result<()> {
    let was_absent = to.is_none();
    let (from, to) = (ids_of(from), ids_of(to));
    let mut now = ids_of(&crate::settings::get(conn, key)?);
    now.retain(|id| to.contains(id) || !from.contains(id));
    for id in &to {
        if !from.contains(id) && !now.contains(id) {
            now.push(id.clone());
        }
    }
    if was_absent && now.is_empty() {
        conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        return Ok(());
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![
            key,
            serde_json::to_string(&now).map_err(|e| Error::Validation(e.to_string()))?
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepInfo {
    pub id: u64,
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UndoState {
    pub undo: Option<StepInfo>,
    pub redo: Option<StepInfo>,
}

#[derive(Default)]
pub struct Journal {
    undo: Vec<Step>,
    redo: Vec<Step>,
    next_id: u64,
}

/// Таблицы, изменения в которых отменяются. Настройки — не действия с данными;
/// служебные таблицы полнотекстового поиска обновляются своими триггерами;
/// отметки показанных предупреждений о бюджете не отменяются вместе с расходом;
/// история изменений операций не стирается отменой — отмена сама попадает в неё.
fn tracked(table: &str) -> bool {
    !(table == "settings"
        || table == "budget_alerts"
        || table == "txn_history"
        || table.starts_with("notes_fts")
        || table.starts_with("sqlite_"))
}

impl Journal {
    pub fn state(&self) -> UndoState {
        let info = |s: &Step| StepInfo {
            id: s.id,
            label: s.label.clone(),
        };
        UndoState {
            undo: self.undo.last().map(info),
            redo: self.redo.last().map(info),
        }
    }

    /// Сохраняем счётчик, чтобы при смене бюджета новый шаг не получил id старой кнопки.
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    /// Выполнить действие и запомнить его изменения как один шаг.
    pub fn record<T>(
        &mut self,
        conn: &mut Connection,
        label: &str,
        action: impl FnOnce(&mut Connection) -> Result<T>,
    ) -> Result<T> {
        // Сессия наблюдает за тем же соединением через второй, не владеющий
        // объект Connection: само действие получает &mut соединение.
        let shadow = unsafe { Connection::from_handle(conn.handle())? };
        let mut session = Session::new(&shadow)?;
        session.table_filter(Some(tracked));
        session.attach::<&str>(None)?;
        let before = read_settings(conn)?;
        let out = action(conn);
        let mut changes = Vec::new();
        session.changeset_strm(&mut changes)?;
        drop(session);
        drop(shadow);
        let out = out?;
        let after = read_settings(conn)?;
        let settings: Vec<_> = UNDOABLE_SETTINGS
            .iter()
            .zip(before.into_iter().zip(after))
            .filter(|(_, (b, a))| b != a)
            .map(|(k, (b, a))| (k.to_string(), b, a))
            .collect();
        if !changes.is_empty() || !settings.is_empty() {
            self.push(label, Action::Rows { changes, settings });
        }
        Ok(out)
    }

    pub fn set_invest_plan(
        &mut self,
        conn: &Connection,
        mode: &str,
        value: i64,
        currency_code: Option<&str>,
    ) -> Result<()> {
        let (before, after) = crate::invest::change_plan(conn, mode, value, currency_code)?;
        if before != after {
            self.push("План инвестиций", Action::InvestPlan { before, after });
        }
        Ok(())
    }

    pub fn confirm_invest_plan_currency(
        &mut self,
        conn: &Connection,
        month: Option<&str>,
        expected: i64,
        currency: &str,
    ) -> Result<()> {
        let action = if let Some(month) = month {
            crate::invest::replace_month_currency(conn, month, expected, None, Some(currency))?;
            Action::InvestMonthCurrency {
                month: month.to_owned(),
                value: expected,
                currency: currency.to_owned(),
            }
        } else {
            let (before, after) = crate::invest::confirm_global_currency(conn, expected, currency)?;
            Action::InvestPlan { before, after }
        };
        self.push("Валюта плана инвестиций", action);
        Ok(())
    }

    fn push(&mut self, label: &str, action: Action) {
        self.next_id += 1;
        self.undo.push(Step {
            id: self.next_id,
            label: label.to_owned(),
            action,
        });
        if self.undo.len() > LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Отменить последнее действие; `None`, если отменять нечего.
    pub fn undo(&mut self, conn: &Connection) -> Result<Option<String>> {
        self.undo_if_current(conn, None)
    }

    pub fn undo_if_current(
        &mut self,
        conn: &Connection,
        expected_id: Option<u64>,
    ) -> Result<Option<String>> {
        replay_step(conn, &mut self.undo, &mut self.redo, expected_id, true)
    }

    /// Повторить отменённое действие; `None`, если повторять нечего.
    pub fn redo(&mut self, conn: &Connection) -> Result<Option<String>> {
        self.redo_if_current(conn, None)
    }

    pub fn redo_if_current(
        &mut self,
        conn: &Connection,
        expected_id: Option<u64>,
    ) -> Result<Option<String>> {
        replay_step(conn, &mut self.redo, &mut self.undo, expected_id, false)
    }
}

fn replay_step(
    conn: &Connection,
    source: &mut Vec<Step>,
    destination: &mut Vec<Step>,
    expected_id: Option<u64>,
    invert: bool,
) -> Result<Option<String>> {
    if expected_id.is_some_and(|id| source.last().map(|step| step.id) != Some(id)) {
        return Err(Error::Validation(
            "История действий изменилась. Проверьте последнее действие.".into(),
        ));
    }
    let Some(step) = source.pop() else {
        return Ok(None);
    };
    if let Err(error) = step.action.replay(conn, invert) {
        let verb = if invert {
            "отменить"
        } else {
            "повторить"
        };
        let error = blocked(verb, &step.label, error);
        // Конфликт данных делает шаг недоступным. При отказе записи оставляем
        // его наверху: после устранения причины можно безопасно повторить.
        if !matches!(error, Error::Validation(_)) {
            source.push(step);
        }
        if let Error::Db(err) = &error {
            use rusqlite::ErrorCode::{DatabaseBusy, DatabaseLocked};
            if matches!(err.sqlite_error_code(), Some(DatabaseBusy | DatabaseLocked)) {
                return Err(Error::Validation(
                    "База сейчас занята. Попробуйте ещё раз.".into(),
                ));
            }
        }
        return Err(error);
    }
    let label = step.label.clone();
    destination.push(step);
    Ok(Some(label))
}

/// Шаг, который нельзя выполнить, из журнала убирается: данные изменились.
fn blocked(verb: &str, label: &str, e: Error) -> Error {
    match e {
        Error::Db(rusqlite::Error::SqliteFailure(f, _))
            if f.code == rusqlite::ErrorCode::OperationAborted =>
        {
            Error::Validation(format!(
                "нельзя {verb} «{label}»: эти данные изменились позже"
            ))
        }
        other => other,
    }
}

/// Операции, которых касается набор изменений: строки `transactions` и их теги.
fn touched(changes: &[u8]) -> Result<Vec<String>> {
    use rusqlite::fallible_streaming_iterator::FallibleStreamingIterator;
    use rusqlite::hooks::Action;
    let mut input: &[u8] = changes;
    let reader: &mut dyn std::io::Read = &mut input;
    let mut it = rusqlite::session::ChangesetIter::start_strm(&reader)?;
    let mut ids = Vec::new();
    while let Some(item) = it.next()? {
        let op = item.op()?;
        if !matches!(op.table_name(), "transactions" | "transaction_tags") {
            continue;
        }
        let v = match op.code() {
            Action::SQLITE_INSERT => item.new_value(0)?,
            _ => item.old_value(0)?,
        };
        if let rusqlite::types::ValueRef::Text(t) = v {
            let id = String::from_utf8_lossy(t).into_owned();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

/// Любой конфликт (строка изменилась, исчезла, от неё зависят новые) — отказ.
unsafe extern "C" fn abort_on_conflict(
    _: *mut c_void,
    _: c_int,
    _: *mut ffi::sqlite3_changeset_iter,
) -> c_int {
    ffi::SQLITE_CHANGESET_ABORT
}

/// Применить набор изменений (обратный при `invert`) одной транзакцией.
/// Каскады внешних ключей выключены: удаление строки, от которой уже зависят
/// более поздние записи, — конфликт, а не молчаливое удаление этих записей.
fn apply(conn: &Connection, changes: &[u8], invert: bool) -> Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let mut flags = ffi::SQLITE_CHANGESETAPPLY_FKNOACTION;
    if invert {
        flags |= ffi::SQLITE_CHANGESETAPPLY_INVERT;
    }
    let len = c_int::try_from(changes.len())
        .map_err(|_| Error::Validation("слишком большое действие".into()))?;
    let rc = unsafe {
        ffi::sqlite3changeset_apply_v2(
            conn.handle(),
            len,
            changes.as_ptr() as *mut c_void,
            None,
            Some(abort_on_conflict),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            flags,
        )
    };
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(Error::Db(rusqlite::Error::SqliteFailure(
            ffi::Error::new(rc),
            None,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::notes::{self, NoteFilter, NoteInput};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn setup() -> (Storage, String, String) {
        seed(Storage::open_in_memory().unwrap())
    }

    fn seed(db: Storage) -> (Storage, String, String) {
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 100_000)).unwrap();
        let food: String = db
            .conn()
            .query_row(
                "SELECT id FROM categories WHERE name = 'Питание'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (db, card, food)
    }

    fn buy(card: &str, food: &str, amount: i64) -> TxnInput {
        TxnInput {
            kind: "expense".into(),
            date: "2026-10-20".into(),
            account_id: card.into(),
            amount,
            category_id: Some(food.into()),
            to_account_id: None,
            to_amount: None,
            payee: Some("Пятёрочка".into()),
            note: None,
        }
    }

    fn balance(db: &Storage, card: &str) -> i64 {
        accounts::balance(db.conn(), card, None).unwrap()
    }

    #[test]
    fn busy_database_keeps_the_same_step_for_undo_and_redo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.db");
        let options = crate::storage::OpenOptions {
            backup_dir: dir.path().join("backups"),
            keep_backups: 0,
        };
        let (mut db, card, food) = seed(Storage::open(&path, &options).unwrap());
        db.conn().busy_timeout(std::time::Duration::ZERO).unwrap();
        let locker = Connection::open(&path).unwrap();
        let mut journal = Journal::default();
        journal
            .record(db.conn_mut(), "Покупка", |c| {
                transactions::create(c, &buy(&card, &food, 700))
            })
            .unwrap();
        let id = journal.state().undo.unwrap().id;
        locker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let error = journal.undo_if_current(db.conn(), Some(id)).unwrap_err();
        assert!(error.to_string().contains("занята"), "{error}");
        assert_eq!(balance(&db, &card), 99_300);
        assert_eq!(journal.state().undo.unwrap().id, id);
        assert!(journal.state().redo.is_none());
        locker.execute_batch("ROLLBACK").unwrap();
        journal.undo_if_current(db.conn(), Some(id)).unwrap();
        assert_eq!(balance(&db, &card), 100_000);

        locker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let error = journal.redo_if_current(db.conn(), Some(id)).unwrap_err();
        assert!(error.to_string().contains("занята"), "{error}");
        assert_eq!(balance(&db, &card), 100_000);
        assert_eq!(journal.state().redo.unwrap().id, id);
        assert!(journal.state().undo.is_none());
        locker.execute_batch("ROLLBACK").unwrap();
        journal.redo_if_current(db.conn(), Some(id)).unwrap();
        assert_eq!(balance(&db, &card), 99_300);
    }

    #[test]
    fn failed_setting_write_rolls_back_the_purchase_and_its_history() {
        const KEY: &str = "budget_excluded_accounts";
        let (mut db, card, food) = setup();
        db.conn()
            .execute("DELETE FROM settings WHERE key=?1", [KEY])
            .unwrap();
        let mut journal = Journal::default();
        let excluded = serde_json::to_string(&[&card]).unwrap();
        journal
            .record(db.conn_mut(), "Изменение", |c| {
                transactions::create(c, &buy(&card, &food, 700))?;
                c.execute(
                    "INSERT INTO settings (key,value) VALUES (?1,?2)",
                    [KEY, &excluded],
                )?;
                Ok(())
            })
            .unwrap();
        let id = journal.state().undo.unwrap().id;
        let history_len = |c: &Connection| {
            c.query_row("SELECT COUNT(*) FROM txn_history", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        let before = history_len(db.conn());
        db.conn()
            .execute_batch(
                "CREATE TEMP TRIGGER reject_setting BEFORE DELETE ON settings
             WHEN OLD.key = 'budget_excluded_accounts'
             BEGIN SELECT RAISE(ABORT, 'отказ записи'); END",
            )
            .unwrap();
        assert!(journal.undo_if_current(db.conn(), Some(id)).is_err());
        assert_eq!(journal.state().undo.unwrap().id, id);
        assert_eq!(balance(&db, &card), 99_300);
        assert_eq!(history_len(db.conn()), before);
        assert_eq!(
            crate::settings::get(db.conn(), KEY).unwrap(),
            Some(excluded)
        );
        db.conn()
            .execute_batch("DROP TRIGGER reject_setting")
            .unwrap();
        journal.undo_if_current(db.conn(), Some(id)).unwrap();
        assert_eq!(balance(&db, &card), 100_000);
        assert_eq!(crate::settings::get(db.conn(), KEY).unwrap(), None);
    }

    #[test]
    fn stale_undo_and_redo_leave_balances_and_pending_steps_untouched() {
        let (mut db, card, food) = setup();
        let mut journal = Journal::default();
        let mut purchase = |journal: &mut Journal, amount| {
            journal
                .record(db.conn_mut(), "Покупка", |c| {
                    transactions::create(c, &buy(&card, &food, amount))
                })
                .unwrap();
            journal.state().undo.unwrap().id
        };
        let first = purchase(&mut journal, 500);
        let second = purchase(&mut journal, 700);
        assert!(journal.undo_if_current(db.conn(), Some(first)).is_err());
        assert_eq!(balance(&db, &card), 98_800);
        assert_eq!(journal.state().undo.unwrap().id, second);

        journal.undo_if_current(db.conn(), Some(second)).unwrap();
        assert!(journal.undo_if_current(db.conn(), Some(second)).is_err());
        assert_eq!(balance(&db, &card), 99_500);
        journal.undo_if_current(db.conn(), Some(first)).unwrap();
        assert!(journal.redo_if_current(db.conn(), Some(second)).is_err());
        assert_eq!(balance(&db, &card), 100_000);
        assert_eq!(journal.state().redo.unwrap().id, first);
        journal.redo_if_current(db.conn(), Some(first)).unwrap();
        assert!(journal.redo_if_current(db.conn(), Some(first)).is_err());
        assert_eq!(balance(&db, &card), 99_500);
        journal.redo_if_current(db.conn(), Some(second)).unwrap();
        assert_eq!(balance(&db, &card), 98_800);
    }

    #[test]
    fn stale_step_after_switch_cannot_change_the_new_budget() {
        let (mut old, old_card, old_food) = setup();
        let (mut new, new_card, new_food) = setup();
        let mut journal = Journal::default();
        journal
            .record(old.conn_mut(), "Покупка", |c| {
                transactions::create(c, &buy(&old_card, &old_food, 700))
            })
            .unwrap();
        let old_id = journal.state().undo.unwrap().id;
        journal.clear();
        assert!(journal.undo_if_current(new.conn(), Some(old_id)).is_err());
        journal
            .record(new.conn_mut(), "Покупка", |c| {
                transactions::create(c, &buy(&new_card, &new_food, 200))
            })
            .unwrap();
        let new_id = journal.state().undo.unwrap().id;
        assert_ne!(old_id, new_id);
        assert!(journal.undo_if_current(new.conn(), Some(old_id)).is_err());
        assert_eq!(journal.state().undo.unwrap().id, new_id);
        assert_eq!(balance(&old, &old_card), 99_300);
        assert_eq!(balance(&new, &new_card), 99_800);
    }

    #[test]
    fn deleted_transaction_comes_back_and_redo_deletes_it_again() {
        let (mut db, card, food) = setup();
        let mut j = Journal::default();
        let id = j
            .record(db.conn_mut(), "Новая операция", |c| {
                transactions::create(c, &buy(&card, &food, 234_000))
            })
            .unwrap();
        j.record(db.conn_mut(), "Удаление операции", |c| {
            transactions::delete(c, &id)
        })
        .unwrap();
        assert_eq!(balance(&db, &card), 100_000);
        assert_eq!(j.state().undo.unwrap().label, "Удаление операции");

        assert_eq!(
            j.undo(db.conn()).unwrap().as_deref(),
            Some("Удаление операции")
        );
        assert_eq!(balance(&db, &card), 100_000 - 234_000);
        assert_eq!(
            transactions::get(db.conn(), &id).unwrap().payee.as_deref(),
            Some("Пятёрочка")
        );
        assert_eq!(j.state().redo.unwrap().label, "Удаление операции");

        assert_eq!(
            j.redo(db.conn()).unwrap().as_deref(),
            Some("Удаление операции")
        );
        assert_eq!(balance(&db, &card), 100_000);
        // Две отмены подряд: удаление, затем создание.
        j.undo(db.conn()).unwrap();
        j.undo(db.conn()).unwrap();
        assert_eq!(balance(&db, &card), 100_000);
        assert!(transactions::get(db.conn(), &id).is_err());
        assert_eq!(j.undo(db.conn()).unwrap(), None);
    }

    #[test]
    fn edit_is_undone_to_previous_values() {
        let (mut db, card, food) = setup();
        let mut j = Journal::default();
        let id = transactions::create(db.conn(), &buy(&card, &food, 1_000)).unwrap();
        j.record(db.conn_mut(), "Изменение операции", |c| {
            transactions::update(c, &id, &buy(&card, &food, 5_000))
        })
        .unwrap();
        assert_eq!(balance(&db, &card), 95_000);
        j.undo(db.conn()).unwrap();
        assert_eq!(balance(&db, &card), 99_000);
    }

    #[test]
    fn invest_plan_sits_above_purchase_and_failure_keeps_both_keys() {
        let (mut db, card, food) = setup();
        let mut journal = Journal::default();
        let c = db.conn_mut();
        let purchase = journal
            .record(c, "Покупка", |c| {
                transactions::create(c, &buy(&card, &food, 25_000))
            })
            .unwrap();
        c.execute_batch(
            "CREATE TEMP TRIGGER reject_amount BEFORE UPDATE OF value ON settings
             WHEN NEW.key = 'invest_plan_value' BEGIN SELECT RAISE(ABORT, 'test'); END;",
        )
        .unwrap();
        assert!(journal
            .set_invest_plan(c, "amount", 1_234_567, None)
            .is_err());
        assert_eq!(
            crate::settings::get(c, "invest_plan_mode")
                .unwrap()
                .as_deref(),
            Some("")
        );
        assert_eq!(
            crate::settings::get(c, "invest_plan_value")
                .unwrap()
                .as_deref(),
            Some("0")
        );
        assert_eq!(journal.state().undo.unwrap().label, "Покупка");
        c.execute_batch("DROP TRIGGER reject_amount").unwrap();

        journal
            .set_invest_plan(c, "amount", 1_234_567, None)
            .unwrap();
        let step = journal.state().undo.unwrap();
        journal
            .set_invest_plan(c, "amount", 1_234_567, None)
            .unwrap();
        assert_eq!(journal.state().undo, Some(step));
        assert_eq!(journal.undo(c).unwrap().as_deref(), Some("План инвестиций"));
        assert_eq!(crate::invest::plan(c).unwrap().mode, "");
        assert_eq!(transactions::get(c, &purchase).unwrap().amount, 25_000);
        assert_eq!(journal.state().undo.unwrap().label, "Покупка");
        journal.redo(c).unwrap();
        let plan = crate::invest::plan(c).unwrap();
        assert_eq!((plan.mode.as_str(), plan.value), ("amount", 1_234_567));
        journal.undo(c).unwrap();
        journal.undo(c).unwrap();
        assert!(transactions::get(c, &purchase).is_err());
    }

    #[test]
    fn independent_change_to_either_plan_field_blocks_replay() {
        let (db, _, _) = setup();
        let c = db.conn();
        crate::invest::set_plan(c, "amount", 10).unwrap();
        let mut journal = Journal::default();
        journal.set_invest_plan(c, "amount", 20, None).unwrap();
        crate::settings::set(c, "invest_plan_mode", "percent").unwrap();
        assert!(journal.undo(c).is_err());
        let plan = crate::invest::plan(c).unwrap();
        assert_eq!((plan.mode.as_str(), plan.value), ("percent", 20));

        journal.set_invest_plan(c, "amount", 20, None).unwrap();
        journal.undo(c).unwrap();
        crate::settings::set(c, "invest_plan_value", "30").unwrap();
        assert!(journal.redo(c).is_err());
        let plan = crate::invest::plan(c).unwrap();
        assert_eq!((plan.mode.as_str(), plan.value), ("percent", 30));
    }

    #[test]
    fn rows_changed_later_block_undo_and_nothing_is_touched() {
        let (mut db, card, food) = setup();
        let mut j = Journal::default();
        let id = j
            .record(db.conn_mut(), "Новая операция", |c| {
                transactions::create(c, &buy(&card, &food, 1_000))
            })
            .unwrap();
        // Операцию потом изменили мимо журнала (например, напоминание или другой экран).
        transactions::update(db.conn(), &id, &buy(&card, &food, 2_000)).unwrap();
        let err = j.undo(db.conn()).unwrap_err().to_string();
        assert!(err.contains("нельзя отменить «Новая операция»"), "{err}");
        assert_eq!(balance(&db, &card), 98_000);
        assert_eq!(j.state().undo, None, "невыполнимый шаг убран из журнала");
    }

    #[test]
    fn undo_never_cascades_into_later_records() {
        let (mut db, _, food) = setup();
        let mut j = Journal::default();
        let cash = j
            .record(db.conn_mut(), "Новый счёт", |c| {
                accounts::create(c, &input("Наличные", "cash", "RUB", 0))
            })
            .unwrap();
        // Позже на счёт записали операцию, не через журнал.
        transactions::create(db.conn(), &buy(&cash, &food, 500)).unwrap();
        assert!(j.undo(db.conn()).is_err());
        assert_eq!(balance(&db, &cash), -500, "счёт и операция на месте");
    }

    #[test]
    fn cascaded_changes_are_undone_too() {
        // Заметка к операции: при удалении операции связь обнуляется (ON DELETE SET NULL),
        // отмена возвращает и операцию, и связь заметки с ней.
        let (mut db, card, food) = setup();
        let mut j = Journal::default();
        let id = transactions::create(db.conn(), &buy(&card, &food, 700)).unwrap();
        let note = notes::create(
            db.conn(),
            &NoteInput {
                body: "чек в ящике".into(),
                transaction_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let link = |db: &Storage| notes::get(db.conn(), &note).unwrap().transaction_id;
        j.record(db.conn_mut(), "Удаление операции", |c| {
            transactions::delete(c, &id)
        })
        .unwrap();
        assert_eq!(link(&db), None);
        j.undo(db.conn()).unwrap();
        assert_eq!(link(&db).as_deref(), Some(id.as_str()));
        assert_eq!(balance(&db, &card), 99_300);
        j.redo(db.conn()).unwrap();
        assert_eq!(link(&db), None);
    }

    #[test]
    fn deleted_note_is_found_by_search_again() {
        let (mut db, _, _) = setup();
        let mut j = Journal::default();
        let id = notes::create(
            db.conn(),
            &NoteInput {
                body: "гарантия до 10.2028, чек в ящике".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let found = |db: &Storage| {
            notes::list(
                db.conn(),
                &NoteFilter {
                    query: Some("гарантия".into()),
                    ..Default::default()
                },
            )
            .unwrap()
            .len()
        };
        j.record(db.conn_mut(), "Удаление заметки", |c| {
            notes::delete(c, &id)
        })
        .unwrap();
        assert_eq!(found(&db), 0);
        j.undo(db.conn()).unwrap();
        assert_eq!(found(&db), 1);
    }

    #[test]
    fn template_usage_counter_does_not_block_undo() {
        // Ошибка, найденная сквозным тестом: счётчик использования шаблона менялся
        // позже, и отмена «Операции по шаблону» отказывала. Счётчик теперь вне шага.
        use crate::templates::{self, TemplateInput};
        let (mut db, card, food) = setup();
        let mut j = Journal::default();
        let t = templates::create(
            db.conn(),
            &TemplateInput {
                name: "Кофе".into(),
                kind: "expense".into(),
                amount: Some(25_000),
                account_id: Some(card.clone()),
                category_id: Some(food),
                ..Default::default()
            },
        )
        .unwrap();
        j.record(db.conn_mut(), "Операция по шаблону", |c| {
            templates::apply(c, &t, "2026-10-20")
        })
        .unwrap();
        templates::used(db.conn(), &t).unwrap();
        templates::used(db.conn(), &t).unwrap();
        j.undo(db.conn()).unwrap();
        assert_eq!(balance(&db, &card), 100_000);
    }

    #[test]
    fn journal_keeps_50_steps_and_new_action_clears_redo() {
        let (mut db, card, food) = setup();
        let mut j = Journal::default();
        for i in 1..=55 {
            j.record(db.conn_mut(), &format!("шаг {i}"), |c| {
                transactions::create(c, &buy(&card, &food, 100))
            })
            .unwrap();
        }
        let mut undone = 0;
        while j.undo(db.conn()).unwrap().is_some() {
            undone += 1;
        }
        assert_eq!(undone, LIMIT);
        assert_eq!(balance(&db, &card), 100_000 - 5 * 100);
        assert!(j.state().redo.is_some());
        j.record(db.conn_mut(), "новое", |c| {
            transactions::create(c, &buy(&card, &food, 1))
        })
        .unwrap();
        assert_eq!(j.state().redo, None);
        // Действие без изменений и действие с ошибкой не создают шагов.
        let top = j.state().undo.unwrap().id;
        j.record(db.conn_mut(), "пусто", |_| Ok(())).unwrap();
        assert!(j
            .record(db.conn_mut(), "ошибка", |c| transactions::create(
                c,
                &buy(&card, &food, -5)
            ))
            .is_err());
        assert_eq!(j.state().undo.unwrap().id, top);
    }

    #[test]
    fn account_includes_undo_in_one_step() {
        let (mut db, card, _) = setup();
        let mut j = Journal::default();
        j.record(db.conn_mut(), "Куда входит счёт", |c| {
            accounts::set_includes(c, &card, false, false, false)
        })
        .unwrap();
        let a = accounts::get(db.conn(), &card).unwrap();
        assert!(!a.include_in_total && !a.in_budget && !a.in_forecast);
        // Потом другой счёт выключили в «Взгляде вперёд» — отмена его не трогает.
        let key = crate::forecast::EXCLUDED_ACCOUNTS_KEY;
        let mut list: Vec<String> =
            serde_json::from_str(&crate::settings::get(db.conn(), key).unwrap().unwrap()).unwrap();
        list.push("other".into());
        crate::settings::set(db.conn(), key, &serde_json::to_string(&list).unwrap()).unwrap();
        j.undo(db.conn()).unwrap();
        assert_eq!(
            crate::settings::get(db.conn(), key).unwrap().as_deref(),
            Some(r#"["other"]"#)
        );
        let a = accounts::get(db.conn(), &card).unwrap();
        assert!(
            a.include_in_total && a.in_budget && a.in_forecast,
            "все три вернулись"
        );
        j.redo(db.conn()).unwrap();
        let a = accounts::get(db.conn(), &card).unwrap();
        assert!(!a.include_in_total && !a.in_budget && !a.in_forecast);
    }
}
