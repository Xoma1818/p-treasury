//! Разбивка чека по категориям (Г3): «Ашан, 3 категории». Каждая часть — обычный
//! расход со своей категорией и общим `split_id`, поэтому отчёты, бюджет и
//! «Можно тратить» считают каждую категорию без особых правил, а баланс счёта
//! уменьшается ровно на сумму чека. Изменение и удаление — всем чеком.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::transactions::{self, TxnInput};
use crate::{ids, tags, Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartInput {
    pub category_id: String,
    pub amount: i64,
    /// Комментарий части; пусто — комментарий чека.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptInput {
    pub date: String,
    pub account_id: String,
    pub payee: Option<String>,
    pub note: Option<String>,
    /// Сумма чека: сумма частей должна быть равна ей.
    pub total: i64,
    pub parts: Vec<PartInput>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Поездка или событие для всех частей; None снимает привязку.
    #[serde(default)]
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: String,
    pub category_id: String,
    pub category_name: String,
    pub amount: i64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub split_id: String,
    pub date: String,
    pub account_id: String,
    pub payee: Option<String>,
    pub total: i64,
    pub event_id: Option<String>,
    pub tags: Vec<String>,
    pub parts: Vec<Part>,
}

fn check(input: &ReceiptInput) -> Result<()> {
    if input.total <= 0 {
        return invalid("сумма чека должна быть больше нуля");
    }
    if input.parts.len() < 2 {
        return invalid("разбейте чек хотя бы на две категории");
    }
    if input.parts.iter().any(|p| p.amount <= 0) {
        return invalid("сумма каждой строки должна быть больше нуля");
    }
    let sum: i64 = input.parts.iter().map(|p| p.amount).sum();
    if sum != input.total {
        return invalid("сумма строк не равна сумме чека");
    }
    Ok(())
}

fn insert_parts(conn: &Connection, split_id: &str, input: &ReceiptInput) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for p in &input.parts {
        let note = p
            .note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| input.note.clone());
        let id = transactions::create(
            conn,
            &TxnInput {
                kind: "expense".into(),
                date: input.date.clone(),
                account_id: input.account_id.clone(),
                amount: p.amount,
                category_id: Some(p.category_id.clone()),
                to_account_id: None,
                to_amount: None,
                payee: input.payee.clone(),
                note,
            },
        )?;
        conn.execute(
            "UPDATE transactions SET split_id = ?2 WHERE id = ?1",
            params![id, split_id],
        )?;
        tags::set_for(conn, &id, &input.tags)?;
        out.push(id);
    }
    Ok(out)
}

/// Записать разбитый чек; возвращает идентификатор разбивки.
pub fn create(conn: &mut Connection, input: &ReceiptInput) -> Result<String> {
    check(input)?;
    let split_id = ids::new_id();
    let tx = conn.transaction()?;
    let ids = insert_parts(&tx, &split_id, input)?;
    crate::events::assign(&tx, input.event_id.as_deref(), &ids)?;
    tx.commit()?;
    Ok(split_id)
}

/// Поездка или событие чека; ошибка, если чека нет.
fn exists(conn: &Connection, split_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT event_id FROM transactions WHERE split_id = ?1 LIMIT 1",
        [split_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()?
    .ok_or(Error::NotFound("разбитый чек"))
}

/// Заменить чек целиком. Новые части, заметки и привязка к событию меняются
/// одной транзакцией, которая целиком записывается в журнал отмены.
pub fn update(conn: &mut Connection, split_id: &str, input: &ReceiptInput) -> Result<()> {
    check(input)?;
    exists(conn, split_id)?;
    let tx = conn.transaction()?;
    let previous: Vec<String> = tx
        .prepare("SELECT id FROM transactions WHERE split_id = ?1")?
        .query_map([split_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let ids = insert_parts(&tx, split_id, input)?;
    crate::events::assign(&tx, input.event_id.as_deref(), &ids)?;
    // В списке операций части идут по date DESC, id DESC: первая представляет
    // весь чек и открывает его заметки. Переносим их до удаления старых частей,
    // иначе ON DELETE SET NULL разорвёт привязку. Число частей может измениться.
    let anchor = ids.iter().max().expect("проверено не меньше двух частей");
    for old in previous {
        tx.execute(
            "UPDATE notes SET transaction_id = ?2 WHERE transaction_id = ?1",
            params![old, anchor],
        )?;
        tx.execute("DELETE FROM transactions WHERE id = ?1", [old])?;
    }
    tx.commit()?;
    Ok(())
}

/// Удалить весь чек.
pub fn delete(conn: &Connection, split_id: &str) -> Result<()> {
    exists(conn, split_id)?;
    conn.execute("DELETE FROM transactions WHERE split_id = ?1", [split_id])?;
    Ok(())
}

/// Чек с частями (для формы «Разбить по категориям»).
pub fn get(conn: &Connection, split_id: &str) -> Result<Receipt> {
    let parts: Vec<transactions::Txn> = {
        let ids: Vec<String> = conn
            .prepare("SELECT id FROM transactions WHERE split_id = ?1 ORDER BY amount DESC, id")?
            .query_map([split_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        ids.iter()
            .map(|id| transactions::get(conn, id))
            .collect::<Result<_>>()?
    };
    let Some(first) = parts.first() else {
        return Err(Error::NotFound("разбитый чек"));
    };
    Ok(Receipt {
        split_id: split_id.to_string(),
        date: first.date.clone(),
        account_id: first.account_id.clone(),
        payee: first.payee.clone(),
        total: parts.iter().map(|p| p.amount).sum(),
        event_id: first.event_id.clone(),
        tags: first.tags.clone(),
        parts: parts
            .iter()
            .map(|p| Part {
                id: p.id.clone(),
                category_id: p.category_id.clone().unwrap_or_default(),
                category_name: p.category_name.clone().unwrap_or_default(),
                amount: p.amount,
                note: p.note.clone(),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::{budgets, categories, reports};

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 AND kind = 'expense'",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn receipt(card: &str, parts: &[(&str, i64)], total: i64) -> ReceiptInput {
        ReceiptInput {
            date: "2026-10-05".into(),
            account_id: card.into(),
            payee: Some("Ашан".into()),
            note: Some("большая закупка".into()),
            total,
            parts: parts
                .iter()
                .map(|(c, a)| PartInput {
                    category_id: c.to_string(),
                    amount: *a,
                    note: None,
                })
                .collect(),
            tags: vec!["дом".into()],
            event_id: None,
        }
    }

    fn event(c: &Connection, name: &str) -> String {
        crate::events::create(
            c,
            &crate::events::EventInput {
                name: name.into(),
                start_date: "2026-10-01".into(),
                end_date: "2026-10-31".into(),
                budget: None,
                note: None,
            },
        )
        .unwrap()
    }

    /// Карточка списка открывает первую часть в порядке списка операций.
    fn visible_part(c: &Connection, split: &str) -> String {
        transactions::list(c, &transactions::Filter::default())
            .unwrap()
            .items
            .into_iter()
            .find(|t| t.split_id.as_deref() == Some(split))
            .unwrap()
            .id
    }

    #[test]
    fn saving_unchanged_receipt_keeps_note_visible_in_its_card() {
        use crate::notes::{self, NoteFilter, NoteInput};

        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let food = cat(db.conn(), "Супермаркет");
        let drug = cat(db.conn(), "Аптека");
        let data = receipt(&card, &[(&food, 100_000), (&drug, 50_000)], 150_000);
        let split = create(db.conn_mut(), &data).unwrap();
        let old_part = visible_part(db.conn(), &split);
        notes::create(
            db.conn(),
            &NoteInput {
                body: "Сохранить гарантию".into(),
                transaction_id: Some(old_part),
                ..Default::default()
            },
        )
        .unwrap();

        update(db.conn_mut(), &split, &data).unwrap();
        let visible = notes::list(
            db.conn(),
            &NoteFilter {
                transaction_id: Some(visible_part(db.conn(), &split)),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].body, "Сохранить гарантию");
    }

    #[test]
    fn event_assignment_is_atomic_with_receipt_creation_and_undo() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let food = cat(db.conn(), "Супермаркет");
        let drug = cat(db.conn(), "Аптека");
        let trip = event(db.conn(), "Поездка");
        let mut data = receipt(&card, &[(&food, 100_000), (&drug, 50_000)], 150_000);
        data.event_id = Some("нет такого события".into());
        assert!(create(db.conn_mut(), &data).is_err());
        assert_eq!(accounts::balance(db.conn(), &card, None).unwrap(), 1_000_000);
        assert!(tags::list(db.conn()).unwrap().is_empty());
        let count: i64 = db
            .conn()
            .query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "ошибка события не оставила части чека");

        data.event_id = Some(trip.clone());
        let mut journal = crate::undo::Journal::default();
        let split = journal
            .record(db.conn_mut(), "Новый чек", |c| create(c, &data))
            .unwrap();
        let c = db.conn();
        let saved = get(c, &split).unwrap();
        assert_eq!(saved.event_id.as_deref(), Some(trip.as_str()));
        assert!(saved.parts.iter().all(|p| {
            transactions::get(c, &p.id).unwrap().event_id.as_deref() == Some(trip.as_str())
        }));
        assert_eq!(budgets::get(c, "2026-10", "2026-10-20").unwrap().actual_expense, 0);
        journal.undo(c).unwrap();
        assert!(get(c, &split).is_err());
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 1_000_000);
        journal.redo(c).unwrap();
        assert_eq!(get(c, &split).unwrap().event_id, Some(trip));
    }

    #[test]
    fn editing_receipt_keeps_notes_through_part_changes_and_one_undo() {
        use crate::notes::{self, NoteInput};

        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let food = cat(db.conn(), "Супермаркет");
        let drug = cat(db.conn(), "Аптека");
        let clothes = cat(db.conn(), "Одежда");
        let trip = event(db.conn(), "Поездка");
        let other_trip = event(db.conn(), "Другая поездка");
        let mut original = receipt(
            &card,
            &[(&food, 300_000), (&drug, 50_000), (&clothes, 150_000)],
            500_000,
        );
        original.event_id = Some(trip.clone());
        let split = create(db.conn_mut(), &original).unwrap();
        let before = get(db.conn(), &split).unwrap();
        let mut linked = Vec::new();
        for (i, part) in before.parts.iter().enumerate() {
            let id = notes::create(
                db.conn(),
                &NoteInput {
                    body: format!("Заметка {i}"),
                    transaction_id: Some(part.id.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
            linked.push((id, part.id.clone(), format!("Заметка {i}")));
        }

        // Удаляем одну категорию, меняем суммы, теги и событие. Все заметки
        // остаются у того же чека, включая заметку к удалённой части.
        let mut changed = receipt(&card, &[(&food, 200_000), (&drug, 100_000)], 300_000);
        changed.tags = vec!["покупки".into()];
        changed.event_id = Some(other_trip.clone());
        let mut journal = crate::undo::Journal::default();
        journal
            .record(db.conn_mut(), "Изменение чека", |c| update(c, &split, &changed))
            .unwrap();
        let c = db.conn();
        let saved = get(c, &split).unwrap();
        let anchor = visible_part(c, &split);
        assert_eq!(saved.total, 300_000);
        assert_eq!(saved.parts.len(), 2);
        for (id, _, body) in &linked {
            let note = notes::get(c, id).unwrap();
            assert_eq!(note.body, *body);
            assert_eq!(note.transaction_id.as_deref(), Some(anchor.as_str()));
        }
        for p in &saved.parts {
            let t = transactions::get(c, &p.id).unwrap();
            assert_eq!(t.tags, ["покупки"]);
            assert_eq!(t.event_id.as_deref(), Some(other_trip.as_str()));
        }
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 700_000);

        journal.undo(c).unwrap();
        let restored = get(c, &split).unwrap();
        assert_eq!(restored.total, before.total);
        assert_eq!(restored.parts.len(), 3);
        for (id, old_part, body) in &linked {
            let note = notes::get(c, id).unwrap();
            assert_eq!(note.body, *body);
            assert_eq!(note.transaction_id.as_deref(), Some(old_part.as_str()));
        }
        for p in &before.parts {
            let t = transactions::get(c, &p.id).unwrap();
            assert_eq!(t.tags, ["дом"]);
            assert_eq!(t.event_id.as_deref(), Some(trip.as_str()));
        }
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 500_000);
        journal.redo(c).unwrap();
        for (id, _, _) in &linked {
            assert_eq!(notes::get(c, id).unwrap().transaction_id.as_deref(), Some(anchor.as_str()));
        }

        // Добавление частей и снятие события тоже сохраняют заметки.
        let mut expanded = receipt(
            &card,
            &[
                (&food, 100_000),
                (&drug, 50_000),
                (&clothes, 50_000),
                (&food, 50_000),
            ],
            250_000,
        );
        expanded.tags = vec!["новый тег".into()];
        update(db.conn_mut(), &split, &expanded).unwrap();
        let c = db.conn();
        let expanded = get(c, &split).unwrap();
        let expanded_anchor = visible_part(c, &split);
        assert_eq!(expanded.parts.len(), 4);
        for p in &expanded.parts {
            let t = transactions::get(c, &p.id).unwrap();
            assert_eq!(t.tags, ["новый тег"]);
            assert!(t.event_id.is_none());
        }
        for (id, _, _) in &linked {
            assert_eq!(
                notes::get(c, id).unwrap().transaction_id.as_deref(),
                Some(expanded_anchor.as_str())
            );
        }
        assert_eq!(budgets::get(c, "2026-10", "2026-10-20").unwrap().actual_expense, 250_000);

        // Если выбранное событие исчезло, весь новый чек откатывается:
        // прежние части, заметки, теги и суммы остаются на месте.
        let mut invalid = receipt(&card, &[(&food, 50_000), (&drug, 50_000)], 100_000);
        invalid.event_id = Some("удалённое событие".into());
        invalid.tags = vec!["не должен сохраниться".into()];
        assert!(update(db.conn_mut(), &split, &invalid).is_err());
        let c = db.conn();
        let after_error = get(c, &split).unwrap();
        assert_eq!(after_error.total, expanded.total);
        assert_eq!(after_error.parts.len(), expanded.parts.len());
        for p in &expanded.parts {
            assert!(transactions::get(c, &p.id).is_ok());
        }
        for (id, _, _) in &linked {
            assert_eq!(
                notes::get(c, id).unwrap().transaction_id.as_deref(),
                Some(expanded_anchor.as_str())
            );
        }
        assert!(!tags::list(c).unwrap().iter().any(|t| t.name == "не должен сохраниться"));
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 750_000);
    }

    #[test]
    fn split_receipt_counts_each_category_and_balance_once() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let (food, kids, drug) = (
            cat(db.conn(), "Супермаркет"),
            cat(db.conn(), "Одежда"),
            cat(db.conn(), "Аптека"),
        );
        let c = db.conn_mut();
        assert!(create(c, &receipt(&card, &[(&food, 300_000)], 300_000)).is_err());
        assert!(
            create(
                c,
                &receipt(&card, &[(&food, 300_000), (&kids, 100_000)], 500_000)
            )
            .is_err(),
            "сумма строк не равна чеку"
        );
        let split = create(
            c,
            &receipt(
                &card,
                &[(&food, 300_000), (&kids, 150_000), (&drug, 50_000)],
                500_000,
            ),
        )
        .unwrap();
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 500_000);
        let r = get(c, &split).unwrap();
        assert_eq!((r.total, r.parts.len()), (500_000, 3));
        assert_eq!(r.tags, ["дом"]);
        let by_cat = reports::by_category(c, "expense", "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(by_cat.total, 500_000);
        assert_eq!(by_cat.items.len(), 3, "каждая категория отдельно");
        let b = budgets::get(c, "2026-10", "2026-10-20").unwrap();
        assert_eq!(b.actual_expense, 500_000);

        // Часть нельзя менять отдельно, но перенос и удаление действуют на весь чек.
        let part = r.parts[1].id.clone();
        assert!(transactions::update(
            c,
            &part,
            &TxnInput {
                kind: "expense".into(),
                date: "2026-10-05".into(),
                account_id: card.clone(),
                amount: 1,
                category_id: Some(food.clone()),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            }
        )
        .is_err());
        transactions::move_to(c, &part, "2026-10-07").unwrap();
        assert!(get(c, &split)
            .unwrap()
            .parts
            .iter()
            .all(|p| transactions::get(c, &p.id).unwrap().date == "2026-10-07"));

        update(
            c,
            &split,
            &receipt(&card, &[(&food, 200_000), (&kids, 100_000)], 300_000),
        )
        .unwrap();
        let r = get(c, &split).unwrap();
        assert_eq!(
            (r.total, r.parts.len(), r.date.as_str()),
            (300_000, 2, "2026-10-05")
        );
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 700_000);

        transactions::delete(c, &r.parts[0].id).unwrap();
        assert!(get(c, &split).is_err());
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 1_000_000);
        assert!(delete(c, &split).is_err());
    }
}
