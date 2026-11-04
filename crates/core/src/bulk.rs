//! Массовые действия с выделенными операциями (Г2): категория, получатель,
//! счёт, тег, удаление. Всё действие — одна транзакция SQLite, поэтому
//! оболочка записывает его в журнал отмены одним шагом (одно Ctrl+Z).
//! Строки, к которым действие неприменимо, пропускаются и считаются.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::invalid;
use crate::{accounts, categories, tags, time, Result};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResult {
    /// Сколько операций изменено (удалено).
    pub changed: usize,
    /// Сколько пропущено: переводы и корректировки при смене категории,
    /// платежи по долгам, операции в другой валюте при смене счёта.
    pub skipped: usize,
}

struct Row {
    id: String,
    kind: String,
    account_id: String,
    to_account_id: Option<String>,
    debt_id: Option<String>,
    split_id: Option<String>,
}

fn rows(conn: &Connection, ids: &[String]) -> Result<Vec<Row>> {
    let mut out: Vec<Row> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::with_capacity(ids.len());
    let mut stmt = conn.prepare(
        "SELECT id, type, account_id, to_account_id, debt_id, split_id FROM transactions WHERE id = ?1",
    )?;
    for id in ids {
        if !seen.insert(id.as_str()) {
            continue;
        }
        let row = stmt
            .query_row([id], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    account_id: r.get(2)?,
                    to_account_id: r.get(3)?,
                    debt_id: r.get(4)?,
                    split_id: r.get(5)?,
                })
            })
            .optional()?;
        if let Some(row) = row {
            out.push(row);
        }
    }
    Ok(out)
}

/// Части разбитого чека, которых нет в выделении: счёт, получатель и
/// удаление действуют на весь чек.
fn with_whole_receipts(conn: &Connection, ids: &[String]) -> Result<Vec<String>> {
    let mut all: Vec<String> = ids.to_vec();
    let mut known: HashSet<String> = ids.iter().cloned().collect();
    let splits: HashSet<String> = rows(conn, ids)?
        .into_iter()
        .filter_map(|r| r.split_id)
        .collect();
    let mut stmt = conn.prepare("SELECT id FROM transactions WHERE split_id = ?1")?;
    for s in splits {
        for id in stmt.query_map([&s], |r| r.get::<_, String>(0))? {
            let id = id?;
            if known.insert(id.clone()) {
                all.push(id);
            }
        }
    }
    Ok(all)
}

/// Поставить категорию. Переводы, корректировки, платежи по долгам и
/// операции другого вида (доход для категории расходов) пропускаются.
pub fn set_category(
    conn: &mut Connection,
    ids: &[String],
    category_id: &str,
) -> Result<BulkResult> {
    let kind = categories::kind_of(conn, category_id)?;
    let now = time::now_utc();
    let tx = conn.transaction()?;
    let mut res = BulkResult::default();
    for r in rows(&tx, ids)? {
        if r.kind != kind || r.debt_id.is_some() {
            res.skipped += 1;
            continue;
        }
        tx.execute(
            "UPDATE transactions SET category_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![r.id, category_id, now],
        )?;
        res.changed += 1;
    }
    tx.commit()?;
    Ok(res)
}

/// Поставить получателя (пусто — убрать). Платежи по долгам пропускаются.
pub fn set_payee(conn: &mut Connection, ids: &[String], payee: Option<&str>) -> Result<BulkResult> {
    let payee = payee.map(str::trim).filter(|p| !p.is_empty());
    let now = time::now_utc();
    let tx = conn.transaction()?;
    let all = with_whole_receipts(&tx, ids)?;
    let mut res = BulkResult::default();
    for r in rows(&tx, &all)? {
        if r.debt_id.is_some() {
            res.skipped += 1;
            continue;
        }
        tx.execute(
            "UPDATE transactions SET payee = ?2, updated_at = ?3 WHERE id = ?1",
            params![r.id, payee, now],
        )?;
        res.changed += 1;
    }
    tx.commit()?;
    Ok(res)
}

/// Перенести на другой счёт той же валюты. Корректировки, платежи по долгам,
/// операции в другой валюте и переводы на этот же счёт пропускаются.
pub fn set_account(conn: &mut Connection, ids: &[String], account_id: &str) -> Result<BulkResult> {
    let target = accounts::head(conn, account_id)?;
    if target.kind == "debt" {
        return invalid("операции по долгу записываются в разделе «Долги»");
    }
    if target.archived {
        return invalid(format!("счёт «{}» закрыт", target.name));
    }
    let now = time::now_utc();
    let tx = conn.transaction()?;
    let all = with_whole_receipts(&tx, ids)?;
    let mut res = BulkResult::default();
    for r in rows(&tx, &all)? {
        let from = accounts::head(&tx, &r.account_id)?;
        let skip = r.kind == "adjustment"
            || r.debt_id.is_some()
            || from.currency_code != target.currency_code
            || r.to_account_id.as_deref() == Some(account_id);
        if skip {
            res.skipped += 1;
            continue;
        }
        tx.execute(
            "UPDATE transactions SET account_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![r.id, account_id, now],
        )?;
        res.changed += 1;
    }
    tx.commit()?;
    Ok(res)
}

/// Добавить (`add`) или снять тег. Тег задаётся именем: новый создаётся.
pub fn tag(conn: &mut Connection, ids: &[String], tag_name: &str, add: bool) -> Result<BulkResult> {
    let tx = conn.transaction()?;
    let existing: Vec<String> = rows(&tx, ids)?.into_iter().map(|r| r.id).collect();
    let n = if add {
        let tag = tags::ensure(&tx, tag_name)?;
        tags::add_to(&tx, &tag, &existing)?
    } else {
        match tags::list(&tx)?.into_iter().find(|t| {
            Some(t.name.to_lowercase()) == tags::clean_name(tag_name).map(|n| n.to_lowercase())
        }) {
            Some(t) => tags::remove_from(&tx, &t.id, &existing)?,
            None => 0,
        }
    };
    tx.commit()?;
    Ok(BulkResult {
        changed: n,
        skipped: existing.len() - n,
    })
}

/// Удалить операции (разбитый чек — целиком). Платежи по долгам пропускаются:
/// их удаляют в карточке долга.
pub fn delete(conn: &mut Connection, ids: &[String]) -> Result<BulkResult> {
    let tx = conn.transaction()?;
    let all = with_whole_receipts(&tx, ids)?;
    let mut res = BulkResult::default();
    for r in rows(&tx, &all)? {
        if r.debt_id.is_some() {
            res.skipped += 1;
            continue;
        }
        tx.execute("DELETE FROM transactions WHERE id = ?1", [&r.id])?;
        res.changed += 1;
    }
    tx.commit()?;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::receipts::{self, PartInput, ReceiptInput};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};
    use crate::undo::Journal;

    fn cat(c: &Connection, name: &str, kind: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 AND kind = ?2",
            [name, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    struct Fx {
        db: Storage,
        card: String,
        cash: String,
        usd: String,
        ids: Vec<String>,
    }

    fn fx() -> Fx {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let cash = accounts::create(c, &input("Наличные", "cash", "RUB", 0)).unwrap();
        let usd = accounts::create(c, &input("Доллары", "cash", "USD", 0)).unwrap();
        let t = |kind: &str, cat_id: Option<String>, to: Option<&str>| TxnInput {
            kind: kind.into(),
            date: "2026-10-05".into(),
            account_id: card.clone(),
            amount: 10_000,
            category_id: cat_id,
            to_account_id: to.map(Into::into),
            to_amount: None,
            payee: Some("Кто-то".into()),
            note: None,
        };
        let ids = vec![
            transactions::create(c, &t("expense", Some(cat(c, "Магазины", "expense")), None))
                .unwrap(),
            transactions::create(c, &t("expense", Some(cat(c, "Такси", "expense")), None)).unwrap(),
            transactions::create(
                c,
                &t("income", Some(cat(c, "Заработная плата", "income")), None),
            )
            .unwrap(),
            transactions::create(c, &t("transfer", None, Some(&cash))).unwrap(),
        ];
        Fx {
            db,
            card,
            cash,
            usd,
            ids,
        }
    }

    #[test]
    fn category_skips_transfers_and_other_kind_and_undoes_in_one_step() {
        let mut f = fx();
        let gifts = cat(f.db.conn(), "Подарки", "expense");
        let mut journal = Journal::default();
        let res = journal
            .record(f.db.conn_mut(), "Категория", |c| {
                set_category(c, &f.ids, &gifts)
            })
            .unwrap();
        assert_eq!(
            res,
            BulkResult {
                changed: 2,
                skipped: 2
            }
        );
        let c = f.db.conn();
        assert_eq!(
            transactions::get(c, &f.ids[1])
                .unwrap()
                .category_id
                .as_deref(),
            Some(gifts.as_str())
        );
        journal.undo(c).unwrap();
        assert_ne!(
            transactions::get(c, &f.ids[0])
                .unwrap()
                .category_id
                .as_deref(),
            Some(gifts.as_str())
        );
        assert_ne!(
            transactions::get(c, &f.ids[1])
                .unwrap()
                .category_id
                .as_deref(),
            Some(gifts.as_str()),
            "одно Ctrl+Z отменяет всю пачку"
        );
    }

    #[test]
    fn payee_account_tag_and_delete() {
        let mut f = fx();
        let c = f.db.conn_mut();
        let res = set_payee(c, &f.ids[..2], Some("  Пятёрочка ")).unwrap();
        assert_eq!(res.changed, 2);
        assert_eq!(
            transactions::get(c, &f.ids[0]).unwrap().payee.as_deref(),
            Some("Пятёрочка")
        );

        // Перевод на наличные не может стать переводом «наличные → наличные».
        let res = set_account(c, &f.ids, &f.cash).unwrap();
        assert_eq!(
            res,
            BulkResult {
                changed: 3,
                skipped: 1
            }
        );
        let res = set_account(c, &f.ids, &f.usd).unwrap();
        assert_eq!(res.changed, 0, "другая валюта — пропуск");
        assert_eq!(accounts::balance(c, &f.card, None).unwrap(), -10_000);

        let res = tag(c, &f.ids, "#ремонт", true).unwrap();
        assert_eq!(res.changed, 4);
        let res = tag(c, &f.ids[..1], "РЕМОНТ", false).unwrap();
        assert_eq!(res.changed, 1);
        assert_eq!(tags::list(c).unwrap()[0].count, 3);

        let res = delete(c, &f.ids[..3]).unwrap();
        assert_eq!(res.changed, 3);
        let left: i64 = c
            .query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);
        let _ = &f.card;
    }

    #[test]
    fn receipt_parts_move_and_delete_together() {
        let mut f = fx();
        let food = cat(f.db.conn(), "Магазины", "expense");
        let drug = cat(f.db.conn(), "Лекарства", "expense");
        let c = f.db.conn_mut();
        let split = receipts::create(
            c,
            &ReceiptInput {
                date: "2026-10-06".into(),
                account_id: f.card.clone(),
                payee: Some("Ашан".into()),
                note: None,
                total: 3_000,
                parts: vec![
                    PartInput {
                        category_id: food,
                        amount: 2_000,
                        note: None,
                    },
                    PartInput {
                        category_id: drug,
                        amount: 1_000,
                        note: None,
                    },
                ],
                tags: vec![],
                event_id: None,
            },
        )
        .unwrap();
        let part = receipts::get(c, &split).unwrap().parts[0].id.clone();
        let res = set_account(c, std::slice::from_ref(&part), &f.cash).unwrap();
        assert_eq!(res.changed, 2, "счёт меняется у всего чека");
        let res = delete(c, &[part]).unwrap();
        assert_eq!(res.changed, 2);
        assert!(receipts::get(c, &split).is_err());
    }
}
