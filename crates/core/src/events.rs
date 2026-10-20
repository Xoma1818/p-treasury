//! Поездки и события: даты, бюджет и операции, отнесённые к событию.
//! Траты в дни события без отметки предлагаются к добавлению; итог считается
//! отдельно от месячного бюджета, в основной валюте по курсу на дату операции.

use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{currencies, ids, time, Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    /// Бюджет в основной валюте; пусто — без бюджета.
    pub budget: Option<i64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub budget: Option<i64>,
    pub note: Option<String>,
    /// Расходы события в основной валюте.
    pub spent: i64,
    pub count: u32,
    /// Расходы в дни события, ещё не отнесённые ни к какому событию.
    pub unassigned: u32,
    pub base_symbol: String,
    pub base_minor_units: u32,
    /// `upcoming`, `current` или `past`.
    pub state: String,
    pub missing_rates: Vec<String>,
}

fn check(input: &EventInput) -> Result<(String, Option<String>)> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("введите название, например «Отпуск в Сочи»");
    }
    time::check_date(&input.start_date)?;
    time::check_date(&input.end_date)?;
    if input.end_date < input.start_date {
        return invalid("дата окончания раньше даты начала");
    }
    if input.budget.is_some_and(|b| b <= 0) {
        return invalid("бюджет должен быть больше нуля или пустым");
    }
    let note = input
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((name.to_string(), note))
}

pub fn create(conn: &Connection, input: &EventInput) -> Result<String> {
    let (name, note) = check(input)?;
    let id = ids::new_id();
    conn.execute(
        "INSERT INTO events (id, name, start_date, end_date, budget, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            name,
            input.start_date,
            input.end_date,
            input.budget,
            note,
            time::now_utc()
        ],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, input: &EventInput) -> Result<()> {
    let (name, note) = check(input)?;
    let n = conn.execute(
        "UPDATE events SET name = ?2, start_date = ?3, end_date = ?4, budget = ?5, note = ?6 WHERE id = ?1",
        params![id, name, input.start_date, input.end_date, input.budget, note],
    )?;
    if n == 0 {
        return Err(Error::NotFound("событие"));
    }
    Ok(())
}

/// Удалить событие; операции остаются, только теряют отметку.
pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM events WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound("событие"));
    }
    Ok(())
}

/// Отнести операции к событию (`None` — снять отметку).
pub fn assign(conn: &Connection, event_id: Option<&str>, txn_ids: &[String]) -> Result<usize> {
    if let Some(e) = event_id {
        let exists: bool =
            conn.query_row("SELECT count(*) > 0 FROM events WHERE id = ?1", [e], |r| {
                r.get(0)
            })?;
        if !exists {
            return Err(Error::NotFound("событие"));
        }
    }
    let mut n = 0;
    for id in txn_ids {
        n += conn.execute(
            "UPDATE transactions SET event_id = ?2, updated_at = ?3
             WHERE id = ?1 AND type IN ('expense', 'income')",
            params![id, event_id, time::now_utc()],
        )?;
    }
    Ok(n)
}

/// Расходы в дни события без отметки: их предлагается добавить.
pub fn candidates(conn: &Connection, event_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.id FROM transactions t JOIN events e ON e.id = ?1
         WHERE t.status = 'cleared' AND t.type = 'expense' AND t.event_id IS NULL AND t.debt_id IS NULL
           AND t.date BETWEEN e.start_date AND e.end_date
         ORDER BY t.date, t.id",
    )?;
    let rows = stmt.query_map([event_id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn list(conn: &Connection, today: &str) -> Result<Vec<Event>> {
    let base = currencies::base_currency(conn)?;
    let bc = currencies::get(conn, &base)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, start_date, end_date, budget, note FROM events
         ORDER BY start_date DESC, name",
    )?;
    let events: Vec<Event> = stmt
        .query_map([], |r| {
            Ok(Event {
                id: r.get(0)?,
                name: r.get(1)?,
                start_date: r.get(2)?,
                end_date: r.get(3)?,
                budget: r.get(4)?,
                note: r.get(5)?,
                spent: 0,
                count: 0,
                unassigned: 0,
                base_symbol: bc.symbol.clone(),
                base_minor_units: bc.minor_units,
                state: String::new(),
                missing_rates: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut spent = conn.prepare(
        "SELECT t.amount, a.currency_code, t.date FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.event_id = ?1 AND t.type = 'expense' AND t.status = 'cleared'",
    )?;
    events
        .into_iter()
        .map(|mut e| {
            let rows: Vec<(i64, String, String)> = spent
                .query_map([&e.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            e.count = rows.len() as u32;
            for (amount, currency, date) in rows {
                match currencies::convert(conn, amount, &currency, &base, &date)? {
                    Some(v) => e.spent += v,
                    None if !e.missing_rates.contains(&currency) => e.missing_rates.push(currency),
                    None => {}
                }
            }
            e.unassigned = candidates(conn, &e.id)?.len() as u32;
            e.state = if today < e.start_date.as_str() {
                "upcoming"
            } else if today > e.end_date.as_str() {
                "past"
            } else {
                "current"
            }
            .into();
            Ok(e)
        })
        .collect()
}

/// События, в дни которых попадает дата (для выбора в форме операции).
pub fn on_date(conn: &Connection, date: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, name FROM events WHERE ?1 BETWEEN start_date AND end_date ORDER BY start_date DESC",
    )?;
    let rows = stmt.query_map(params_from_iter([date]), |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::{categories, transactions};

    fn expense(c: &Connection, acc: &str, cat: &str, date: &str, amount: i64) -> String {
        transactions::create(
            c,
            &transactions::TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: acc.into(),
                amount,
                category_id: Some(cat.into()),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn trip_budget_candidates_and_assign() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let usd = accounts::create(c, &input("Доллары", "cash", "USD", 100_000)).unwrap();
        currencies::set_rate(c, "2026-07-01", "USD", "RUB", "90").unwrap();
        let cat: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Кафе и рестораны'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let before = expense(c, &card, &cat, "2026-07-09", 100_000);
        let a = expense(c, &card, &cat, "2026-07-10", 300_000);
        let b = expense(c, &usd, &cat, "2026-07-12", 5_000);
        let id = create(
            c,
            &EventInput {
                name: "Отпуск в Сочи".into(),
                start_date: "2026-07-10".into(),
                end_date: "2026-07-20".into(),
                budget: Some(5_000_000),
                note: None,
            },
        )
        .unwrap();
        assert_eq!(candidates(c, &id).unwrap(), vec![a.clone(), b.clone()]);
        assert_eq!(assign(c, Some(&id), &[a.clone(), b.clone()]).unwrap(), 2);
        let e = &list(c, "2026-07-15").unwrap()[0];
        // 3 000 ₽ + 50 $ × 90.
        assert_eq!((e.spent, e.count, e.unassigned), (300_000 + 450_000, 2, 0));
        assert_eq!(e.state, "current");
        assert_eq!(on_date(c, "2026-07-11").unwrap()[0].1, "Отпуск в Сочи");
        assert!(on_date(c, "2026-07-09").unwrap().is_empty());
        let txn = transactions::get(c, &a).unwrap();
        assert_eq!(txn.event_name.as_deref(), Some("Отпуск в Сочи"));
        assert_eq!(
            transactions::list(
                c,
                &transactions::Filter {
                    event_id: Some(id.clone()),
                    ..Default::default()
                }
            )
            .unwrap()
            .total,
            2
        );
        // Удаление события снимает отметку, операции остаются.
        delete(c, &id).unwrap();
        assert!(transactions::get(c, &a).unwrap().event_id.is_none());
        assert!(transactions::get(c, &before).is_ok());
        assert!(create(
            c,
            &EventInput {
                name: "x".into(),
                start_date: "2026-07-10".into(),
                end_date: "2026-07-01".into(),
                budget: None,
                note: None
            }
        )
        .is_err());
    }
}
