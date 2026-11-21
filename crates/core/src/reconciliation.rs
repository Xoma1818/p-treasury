//! Сверка с выпиской: отметка хранит дату и состояние учёта для этой даты.
//! Сверка сама по себе не добавляет операции и не меняет их статус.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::invalid;
use crate::{accounts, time, Error, Result};

const STALE_PREVIEW: &str =
    "Данные счёта изменились после проверки. Проверьте остаток и подтвердите ещё раз.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub date: String,
    pub balance: i64,
    pub revision: String,
    pub opening_date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconciliation {
    pub account_id: String,
    pub date: String,
    pub balance: i64,
    pub stale: bool,
}

struct Opening {
    date: String,
    balance: i64,
    currency: String,
    archived: bool,
}

fn opening(conn: &Connection, id: &str) -> Result<Opening> {
    conn.query_row(
        "SELECT opening_date, opening_balance, currency_code, archived_at IS NOT NULL
         FROM accounts WHERE id = ?1",
        [id],
        |r| {
            Ok(Opening {
                date: r.get(0)?,
                balance: r.get(1)?,
                currency: r.get(2)?,
                archived: r.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("счёт"))
}

fn write_text(hash: &mut Sha256, s: &str) {
    hash.update((s.len() as u64).to_le_bytes());
    hash.update(s.as_bytes());
}

/// Не опираемся лишь на сумму: две правки с одинаковым итогом меняют сверенный
/// список. Метаданные вроде тегов и заметок не меняют остаток в банке.
fn revision(conn: &Connection, id: &str, date: &str, opening: &Opening) -> Result<String> {
    let mut hash = Sha256::new();
    for s in [
        "kazna/reconciliation/1",
        id,
        date,
        &opening.date,
        &opening.currency,
    ] {
        write_text(&mut hash, s);
    }
    hash.update(opening.balance.to_le_bytes());
    let mut stmt = conn.prepare_cached(
        "SELECT id, date, type, amount, 0 AS leg
         FROM transactions
         WHERE account_id = ?1 AND status = 'cleared' AND date <= ?2
         UNION ALL
         SELECT id, date, type, to_amount, 1 AS leg
         FROM transactions
         WHERE to_account_id = ?1 AND type = 'transfer' AND status = 'cleared' AND date <= ?2
         ORDER BY date, id, leg",
    )?;
    let mut rows = stmt.query(params![id, date])?;
    while let Some(row) = rows.next()? {
        for i in 0..3 {
            write_text(&mut hash, &row.get::<_, String>(i)?);
        }
        hash.update(row.get::<_, i64>(3)?.to_le_bytes());
        hash.update([row.get::<_, u8>(4)?]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn quote(conn: &Connection, id: &str, date: &str) -> Result<Preview> {
    time::check_date(date)?;
    let opening = opening(conn, id)?;
    if opening.archived {
        return invalid("счёт закрыт");
    }
    Ok(Preview {
        date: date.into(),
        balance: accounts::balance(conn, id, Some(date))?,
        revision: revision(conn, id, date, &opening)?,
        opening_date: opening.date,
    })
}

/// Остаток и версия предпросмотра читаются из одной версии базы.
pub fn preview(conn: &mut Connection, id: &str, date: &str) -> Result<Preview> {
    let tx = conn.transaction()?;
    let out = quote(&tx, id, date)?;
    tx.commit()?;
    Ok(out)
}

/// По каждой карте показываем отметку с самой поздней датой выписки.
pub fn list(conn: &mut Connection) -> Result<Vec<Reconciliation>> {
    let tx = conn.transaction()?;
    let checkpoints: Vec<(String, String, i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT r.account_id, r.statement_date, r.balance, r.revision
             FROM account_reconciliations r
             JOIN (
                 SELECT account_id, max(statement_date) AS statement_date
                 FROM account_reconciliations GROUP BY account_id
             ) latest USING (account_id, statement_date)
             ORDER BY r.account_id",
        )?;
        let records = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        records.collect::<rusqlite::Result<_>>()?
    };
    let mut result = Vec::with_capacity(checkpoints.len());
    for (account_id, date, balance, saved_revision) in checkpoints {
        let opening = opening(&tx, &account_id)?;
        let stale = revision(&tx, &account_id, &date, &opening)? != saved_revision;
        result.push(Reconciliation {
            account_id,
            date,
            balance,
            stale,
        });
    }
    tx.commit()?;
    Ok(result)
}

fn checked_quote(conn: &Connection, id: &str, date: &str, expected: &str) -> Result<Preview> {
    let current = quote(conn, id, date)?;
    if current.revision != expected {
        return invalid(STALE_PREVIEW);
    }
    Ok(current)
}

pub fn complete(
    conn: &mut Connection,
    id: &str,
    date: &str,
    statement_balance: i64,
    expected: &str,
) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = checked_quote(&tx, id, date, expected)?;
    if current.balance != statement_balance {
        return invalid("остатки не совпадают. Разберите разницу перед завершением сверки.");
    }
    tx.execute(
        "INSERT INTO account_reconciliations (account_id, statement_date, balance, revision)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (account_id, statement_date) DO UPDATE
         SET balance = excluded.balance, revision = excluded.revision
         WHERE revision <> excluded.revision OR balance <> excluded.balance",
        params![id, date, statement_balance, current.revision],
    )?;
    tx.commit()?;
    Ok(())
}

/// Явная коррекция подтверждается по только что показанному остатку. Даже при
/// одинаковом итоговом балансе правка прошлого отменяет прежнее подтверждение.
pub fn adjust_checked(
    conn: &mut Connection,
    id: &str,
    date: &str,
    statement_balance: i64,
    expected: &str,
) -> Result<Option<String>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = checked_quote(&tx, id, date, expected)?;
    let diff = accounts::balance_difference(statement_balance, current.balance)?;
    let id = accounts::record_adjustment(&tx, id, date, diff, None)?;
    tx.commit()?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};
    use crate::undo::Journal;

    const CUT_OFF: &str = "2026-10-20";

    #[test]
    fn preview_and_checked_adjustment_share_the_statement_date() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 1_200_000)).unwrap();
        accounts::adjust_balance(c, &card, 1_500_000, "2026-10-25", None).unwrap();
        assert_eq!(
            preview(c, &card, "2026-09-30").unwrap().balance,
            accounts::balance(c, &card, Some("2026-09-30")).unwrap()
        );
        let q = preview(c, &card, CUT_OFF).unwrap();
        assert_eq!(q.balance, 1_200_000);
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 1_500_000);
        let mut journal = Journal::default();
        let adjustment = journal
            .record(c, "Корректировка", |c| {
                adjust_checked(c, &card, CUT_OFF, 1_250_000, &q.revision)
            })
            .unwrap()
            .expect("поправка нужна");
        let amount: i64 = c
            .query_row(
                "SELECT amount FROM transactions WHERE id = ?1",
                [adjustment],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(amount, 50_000);
        let refreshed = preview(c, &card, CUT_OFF).unwrap();
        assert_eq!(
            adjust_checked(c, &card, CUT_OFF, 1_250_000, &refreshed.revision).unwrap(),
            None
        );
        assert_eq!(journal.undo(c).unwrap().as_deref(), Some("Корректировка"));
        assert_eq!(preview(c, &card, CUT_OFF).unwrap().balance, 1_200_000);
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 1_500_000);
    }

    #[test]
    fn checkpoint_tracks_the_currency_and_financial_rows_but_not_notes_or_future_operations() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        let rub = accounts::create(c, &input("Рубли", "debit", "RUB", 1_000_000)).unwrap();
        let usd = accounts::create(c, &input("Доллары", "debit", "USD", 30_000)).unwrap();
        let mut transfer = TxnInput {
            kind: "transfer".into(),
            date: "2026-10-17".into(),
            account_id: rub,
            amount: 450_000,
            to_account_id: Some(usd.clone()),
            to_amount: Some(5_000),
            category_id: None,
            payee: None,
            note: None,
        };
        let movement = transactions::create(c, &transfer).unwrap();
        let q = preview(c, &usd, CUT_OFF).unwrap();
        assert_eq!(q.balance, 35_000, "получатель видит сумму своей валюты");
        assert!(complete(c, &usd, CUT_OFF, 34_999, &q.revision).is_err());
        assert!(list(c).unwrap().is_empty());

        let mut journal = Journal::default();
        journal
            .record(c, "Сверка счёта", |c| {
                complete(c, &usd, CUT_OFF, 35_000, &q.revision)
            })
            .unwrap();
        assert!(!list(c).unwrap()[0].stale);
        assert_eq!(preview(c, &usd, CUT_OFF).unwrap().balance, q.balance);
        assert_eq!(journal.undo(c).unwrap().as_deref(), Some("Сверка счёта"));
        assert!(list(c).unwrap().is_empty());
        assert_eq!(journal.redo(c).unwrap().as_deref(), Some("Сверка счёта"));

        transfer.note = Some("Уточнена заметка".into());
        transactions::update(c, &movement, &transfer).unwrap();
        accounts::adjust_balance(c, &usd, 40_000, "2026-10-22", None).unwrap();
        assert!(!list(c).unwrap()[0].stale);
        transfer.date = "2026-10-18".into();
        transactions::update(c, &movement, &transfer).unwrap();
        assert!(
            list(c).unwrap()[0].stale,
            "та же сумма, но иная строка учёта"
        );
        assert_eq!(preview(c, &usd, CUT_OFF).unwrap().balance, 35_000);
        assert!(adjust_checked(c, &usd, CUT_OFF, 35_001, &q.revision).is_err());
        assert!(complete(c, &usd, CUT_OFF, 35_000, &q.revision).is_err());
        assert_eq!(accounts::balance(c, &usd, None).unwrap(), 40_000);

        let q = preview(c, &usd, CUT_OFF).unwrap();
        complete(c, &usd, CUT_OFF, 35_000, &q.revision).unwrap();
        assert!(!list(c).unwrap()[0].stale);
        let older = preview(c, &usd, "2026-10-16").unwrap();
        complete(c, &usd, &older.date, 30_000, &older.revision).unwrap();
        assert_eq!(list(c).unwrap()[0].date, CUT_OFF);
    }

    #[test]
    fn upgrade_from_25_preserves_ledger_and_creates_reconciliation_table() {
        use crate::storage::{OpenOptions, MIGRATIONS};

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("old.db");
        let opts = OpenOptions {
            backup_dir: root.path().join("backups"),
            keep_backups: 2,
        };
        let id = {
            let db = Storage::open_with(&path, &opts, &MIGRATIONS[..25]).unwrap();
            let c = db.conn();
            let id = accounts::create(c, &input("Карта", "debit", "RUB", 12_000)).unwrap();
            accounts::adjust_balance(c, &id, 15_000, CUT_OFF, None).unwrap();
            id
        };
        let mut db = Storage::open(&path, &opts).unwrap();
        assert!(db.pre_migration_backup().unwrap().exists());
        let c = db.conn_mut();
        assert!(list(c).unwrap().is_empty());
        let q = preview(c, &id, CUT_OFF).unwrap();
        assert_eq!(q.balance, 15_000);
        complete(c, &id, CUT_OFF, 15_000, &q.revision).unwrap();
        assert!(!list(c).unwrap()[0].stale);
    }
}
