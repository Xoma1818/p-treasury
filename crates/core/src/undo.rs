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
    changes: Vec<u8>,
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
/// отметки показанных предупреждений о бюджете не отменяются вместе с расходом.
fn tracked(table: &str) -> bool {
    !(table == "settings"
        || table == "budget_alerts"
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
        let out = action(conn);
        let mut changes = Vec::new();
        session.changeset_strm(&mut changes)?;
        drop(session);
        drop(shadow);
        let out = out?;
        if !changes.is_empty() {
            self.next_id += 1;
            self.undo.push(Step {
                id: self.next_id,
                label: label.to_string(),
                changes,
            });
            if self.undo.len() > LIMIT {
                self.undo.remove(0);
            }
            self.redo.clear();
        }
        Ok(out)
    }

    /// Отменить последнее действие; `None`, если отменять нечего.
    pub fn undo(&mut self, conn: &Connection) -> Result<Option<String>> {
        let Some(step) = self.undo.pop() else {
            return Ok(None);
        };
        if let Err(e) = apply(conn, &step.changes, true) {
            return Err(blocked("отменить", &step.label, e));
        }
        let label = step.label.clone();
        self.redo.push(step);
        Ok(Some(label))
    }

    /// Повторить отменённое действие; `None`, если повторять нечего.
    pub fn redo(&mut self, conn: &Connection) -> Result<Option<String>> {
        let Some(step) = self.redo.pop() else {
            return Ok(None);
        };
        if let Err(e) = apply(conn, &step.changes, false) {
            return Err(blocked("повторить", &step.label, e));
        }
        let label = step.label.clone();
        self.undo.push(step);
        Ok(Some(label))
    }
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
        let db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 100_000)).unwrap();
        let food: String = db
            .conn()
            .query_row(
                "SELECT id FROM categories WHERE name = 'Продукты'",
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
}
