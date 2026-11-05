//! Теги операций (Г6): «ремонт», «отпуск-2026». Тег — метка поверх категорий:
//! одна операция может иметь несколько тегов. Имена сравниваются без учёта
//! регистра, «#» в начале отбрасывается.

use std::collections::{BTreeMap, HashMap};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::invalid;
use crate::{budgets, categories, currencies, ids, time, Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// Сколько операций с тегом.
    pub count: i64,
}

/// Имя тега из ввода: без «#», лишних пробелов; пусто — `None`.
pub fn clean_name(name: &str) -> Option<String> {
    let s = name.trim().trim_start_matches('#').trim();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    (!s.is_empty()).then_some(s)
}

/// Все теги по алфавиту с числом операций.
pub fn list(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, (SELECT count(*) FROM transaction_tags tt WHERE tt.tag_id = g.id)
         FROM tags g",
    )?;
    let mut out: Vec<Tag> = stmt
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    out.sort_by_key(|t| t.name.to_lowercase());
    Ok(out)
}

fn find(conn: &Connection, name: &str) -> Result<Option<String>> {
    let low = name.to_lowercase();
    Ok(list(conn)?
        .into_iter()
        .find(|t| t.name.to_lowercase() == low)
        .map(|t| t.id))
}

fn name_of(conn: &Connection, id: &str) -> Result<String> {
    conn.query_row("SELECT name FROM tags WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or(Error::NotFound("тег"))
}

/// Тег с таким именем: существующий (без учёта регистра) или новый.
pub fn ensure(conn: &Connection, name: &str) -> Result<String> {
    let Some(name) = clean_name(name) else {
        return invalid("введите название тега");
    };
    if let Some(id) = find(conn, &name)? {
        return Ok(id);
    }
    let id = ids::new_id();
    conn.execute(
        "INSERT INTO tags (id, name) VALUES (?1, ?2)",
        params![id, name],
    )?;
    Ok(id)
}

/// Заменить теги операции набором имён (новые теги создаются).
pub fn set_for(conn: &Connection, txn_id: &str, names: &[String]) -> Result<()> {
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM transactions WHERE id = ?1", [txn_id], |r| {
            r.get(0)
        })
        .optional()?;
    if exists.is_none() {
        return Err(Error::NotFound("операция"));
    }
    let mut wanted = Vec::new();
    for n in names {
        if clean_name(n).is_some() {
            let id = ensure(conn, n)?;
            if !wanted.contains(&id) {
                wanted.push(id);
            }
        }
    }
    let current: Vec<String> = conn
        .prepare("SELECT tag_id FROM transaction_tags WHERE transaction_id = ?1")?
        .query_map([txn_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for old in current.iter().filter(|t| !wanted.contains(t)) {
        conn.execute(
            "DELETE FROM transaction_tags WHERE transaction_id = ?1 AND tag_id = ?2",
            params![txn_id, old],
        )?;
    }
    for new in wanted.iter().filter(|t| !current.contains(t)) {
        conn.execute(
            "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?1, ?2)",
            params![txn_id, new],
        )?;
    }
    Ok(())
}

/// Добавить тег операциям; возвращает, скольким он добавлен впервые.
pub fn add_to(conn: &Connection, tag_id: &str, txn_ids: &[String]) -> Result<usize> {
    name_of(conn, tag_id)?;
    let mut n = 0;
    for t in txn_ids {
        n += conn.execute(
            "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
             SELECT id, ?2 FROM transactions WHERE id = ?1",
            params![t, tag_id],
        )?;
    }
    Ok(n)
}

/// Снять тег с операций; возвращает, со скольких снят.
pub fn remove_from(conn: &Connection, tag_id: &str, txn_ids: &[String]) -> Result<usize> {
    let mut n = 0;
    for t in txn_ids {
        n += conn.execute(
            "DELETE FROM transaction_tags WHERE transaction_id = ?1 AND tag_id = ?2",
            params![t, tag_id],
        )?;
    }
    Ok(n)
}

/// Переименовать тег. Имя другого тега занимать нельзя: для этого есть «Объединить».
pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
    name_of(conn, id)?;
    let Some(name) = clean_name(name) else {
        return invalid("введите название тега");
    };
    if find(conn, &name)?.is_some_and(|other| other != id) {
        return invalid(format!(
            "тег «{name}» уже есть: чтобы соединить теги, нажмите «Объединить»"
        ));
    }
    conn.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Объединить тег `from` с тегом `into`: операции получают `into`, `from` удаляется.
pub fn merge(conn: &mut Connection, from: &str, into: &str) -> Result<()> {
    if from == into {
        return invalid("выберите два разных тега");
    }
    name_of(conn, from)?;
    name_of(conn, into)?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
         SELECT transaction_id, ?2 FROM transaction_tags WHERE tag_id = ?1",
        params![from, into],
    )?;
    tx.execute("DELETE FROM transaction_tags WHERE tag_id = ?1", [from])?;
    tx.execute("DELETE FROM tags WHERE id = ?1", [from])?;
    tx.commit()?;
    Ok(())
}

/// Удалить тег; операции остаются, с них снимается только тег.
pub fn delete(conn: &mut Connection, id: &str) -> Result<()> {
    name_of(conn, id)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM transaction_tags WHERE tag_id = ?1", [id])?;
    tx.execute("DELETE FROM tags WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCategory {
    pub category_id: String,
    pub name: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagMonth {
    pub month: String,
    pub expense: i64,
    pub income: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagReport {
    pub tag_id: String,
    pub name: String,
    pub base_currency: String,
    pub from: String,
    pub to: String,
    pub expense: i64,
    pub income: i64,
    /// Сколько операций с тегом за период.
    pub count: i64,
    /// Расходы по верхним категориям, по убыванию.
    pub by_category: Vec<TagCategory>,
    /// По бюджетным месяцам, по порядку.
    pub by_month: Vec<TagMonth>,
    pub missing_rates: Vec<String>,
}

/// Отчёт «По тегу» за период: итог, разбивка по категориям и месяцам.
/// Траты на несколько месяцев делятся по месяцам, как в других отчётах.
pub fn report(conn: &Connection, tag_id: &str, from: &str, to: &str) -> Result<TagReport> {
    time::check_date(from)?;
    time::check_date(to)?;
    if from > to {
        return invalid("начало периода позже конца");
    }
    let name = name_of(conn, tag_id)?;
    let base = currencies::base_currency(conn)?;
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM transactions t JOIN transaction_tags tt ON tt.transaction_id = t.id
         WHERE tt.tag_id = ?1 AND t.status = 'cleared' AND t.date BETWEEN ?2 AND ?3",
        params![tag_id, from, to],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT t.type, t.date, t.amount, a.currency_code, COALESCE(c.parent_id, c.id)
         FROM txn_by_month t
         JOIN transaction_tags tt ON tt.transaction_id = t.id
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE tt.tag_id = ?1 AND t.status = 'cleared' AND t.type IN ('expense', 'income')
           AND t.date BETWEEN ?2 AND ?3",
    )?;
    let rows: Vec<(String, String, i64, String, Option<String>)> = stmt
        .query_map(params![tag_id, from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let (mut expense, mut income) = (0i64, 0i64);
    let mut by_cat: HashMap<String, i64> = HashMap::new();
    let mut by_month: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut missing_rates = Vec::new();
    for (kind, date, amount, cur, top) in rows {
        let Some(v) = currencies::convert(conn, amount, &cur, &base, &date)? else {
            if !missing_rates.contains(&cur) {
                missing_rates.push(cur);
            }
            continue;
        };
        let month = budgets::month_of(conn, &date)?.month;
        let m = by_month.entry(month).or_default();
        if kind == "expense" {
            expense += v;
            m.0 += v;
            if let Some(top) = top {
                *by_cat.entry(top).or_default() += v;
            }
        } else {
            income += v;
            m.1 += v;
        }
    }
    let names: HashMap<String, String> = categories::list(conn, true)?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect();
    let mut by_category: Vec<TagCategory> = by_cat
        .into_iter()
        .map(|(id, amount)| TagCategory {
            name: names.get(&id).cloned().unwrap_or_default(),
            category_id: id,
            amount,
        })
        .collect();
    by_category.sort_by(|a, b| b.amount.cmp(&a.amount).then_with(|| a.name.cmp(&b.name)));
    Ok(TagReport {
        tag_id: tag_id.to_string(),
        name,
        base_currency: base,
        from: from.to_string(),
        to: to.to_string(),
        expense,
        income,
        count,
        by_category,
        by_month: by_month
            .into_iter()
            .map(|(month, (expense, income))| TagMonth {
                month,
                expense,
                income,
            })
            .collect(),
        missing_rates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions::{self, Filter, TxnExtra, TxnInput};

    pub(crate) fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 AND kind = 'expense'",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn spend(
        c: &mut Connection,
        card: &str,
        cat: &str,
        date: &str,
        amount: i64,
        tags: &[&str],
    ) -> String {
        transactions::create_with(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: card.into(),
                amount,
                category_id: Some(cat.into()),
                to_account_id: None,
                to_amount: None,
                payee: Some("Леруа".into()),
                note: None,
            },
            &TxnExtra {
                spread_months: None,
                tags: tags.iter().map(|t| t.to_string()).collect(),
            },
        )
        .unwrap()
    }

    #[test]
    fn tags_on_operations_filter_rename_merge_delete_and_report() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let repair = cat(db.conn(), "Ремонт");
        let food = cat(db.conn(), "Магазины");
        let c = db.conn_mut();
        let a = spend(
            c,
            &card,
            &repair,
            "2026-09-10",
            450_000,
            &["#ремонт", "Дача"],
        );
        let b = spend(c, &card, &repair, "2026-10-02", 120_000, &["РЕМОНТ"]);
        spend(c, &card, &food, "2026-10-03", 50_000, &["дача"]);
        spend(c, &card, &food, "2026-10-04", 70_000, &[]);

        let tags = list(c).unwrap();
        assert_eq!(
            tags.iter()
                .map(|t| (t.name.as_str(), t.count))
                .collect::<Vec<_>>(),
            [("Дача", 2), ("ремонт", 2)],
            "регистр и «#» не создают второй тег"
        );
        let remont = tags[1].id.clone();
        let dacha = tags[0].id.clone();
        assert_eq!(transactions::get(c, &a).unwrap().tags, ["Дача", "ремонт"]);
        let page = transactions::list(
            c,
            &Filter {
                tag_id: Some(remont.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 2);

        let r = report(c, &remont, "2026-09-01", "2026-10-31").unwrap();
        assert_eq!((r.expense, r.income, r.count), (570_000, 0, 2));
        assert_eq!(r.by_category.len(), 1);
        assert_eq!(r.by_category[0].name, "Жильё");
        assert_eq!(
            r.by_month
                .iter()
                .map(|m| (m.month.as_str(), m.expense))
                .collect::<Vec<_>>(),
            [("2026-09", 450_000), ("2026-10", 120_000)]
        );

        assert!(rename(c, &remont, "дача").is_err(), "имя занято");
        rename(c, &remont, " #Ремонт  квартиры ").unwrap();
        assert_eq!(transactions::get(c, &b).unwrap().tags, ["Ремонт квартиры"]);

        merge(c, &dacha, &remont).unwrap();
        let tags = list(c).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].count, 3, "у операции a тег не задвоился");

        let n_before: i64 = c
            .query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        delete(c, &remont).unwrap();
        assert!(list(c).unwrap().is_empty());
        let n_after: i64 = c
            .query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_before, n_after, "операции остаются");
        assert!(ensure(c, " # ").is_err());
    }

    #[test]
    fn add_and_remove_in_bulk() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let food = cat(db.conn(), "Магазины");
        let c = db.conn_mut();
        let ids: Vec<String> = (1..=3)
            .map(|d| spend(c, &card, &food, &format!("2026-10-0{d}"), 100, &[]))
            .collect();
        let tag = ensure(c, "отпуск").unwrap();
        assert_eq!(add_to(c, &tag, &ids).unwrap(), 3);
        assert_eq!(add_to(c, &tag, &ids).unwrap(), 0);
        assert_eq!(remove_from(c, &tag, &ids[..1]).unwrap(), 1);
        assert_eq!(list(c).unwrap()[0].count, 2);
    }
}
