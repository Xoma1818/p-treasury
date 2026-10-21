//! Имущество: квартира, машина и другое ценное. Стоимость задаётся оценками
//! на даты; последняя оценка на дату входит в чистые активы.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{currencies, ids, time, Error, Result};

const KINDS: &[&str] = &["realty", "vehicle", "other"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInput {
    pub name: String,
    /// `realty` — недвижимость, `vehicle` — транспорт, `other` — другое.
    pub kind: String,
    pub currency_code: String,
    /// Оценка в минимальных единицах валюты на дату `date`.
    pub value: i64,
    pub date: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Valuation {
    pub date: String,
    pub value: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub note: Option<String>,
    /// Последняя оценка.
    pub value: i64,
    pub valued_on: String,
    /// Все оценки, новые сверху.
    pub history: Vec<Valuation>,
}

fn check(conn: &Connection, input: &AssetInput) -> Result<(String, Option<String>)> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("введите название, например «Квартира»");
    }
    if !KINDS.contains(&input.kind.as_str()) {
        return invalid("вид имущества: недвижимость, транспорт или другое");
    }
    if input.value < 0 {
        return invalid("стоимость не может быть отрицательной");
    }
    time::check_date(&input.date)?;
    currencies::get(conn, &input.currency_code)?;
    let note = input
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((name.to_string(), note))
}

pub fn create(conn: &Connection, input: &AssetInput) -> Result<String> {
    let (name, note) = check(conn, input)?;
    let id = ids::new_id();
    let now = time::now_utc();
    conn.execute(
        "INSERT INTO assets (id, name, kind, currency_code, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, name, input.kind, input.currency_code, note, now],
    )?;
    set_value(conn, &id, &input.date, input.value)?;
    Ok(id)
}

/// Изменить название и описание; новая сумма на дату записывается как оценка.
pub fn update(conn: &Connection, id: &str, input: &AssetInput) -> Result<()> {
    let (name, note) = check(conn, input)?;
    let n = conn.execute(
        "UPDATE assets SET name = ?2, kind = ?3, currency_code = ?4, note = ?5, updated_at = ?6 WHERE id = ?1",
        params![id, name, input.kind, input.currency_code, note, time::now_utc()],
    )?;
    if n == 0 {
        return Err(Error::NotFound("имущество"));
    }
    set_value(conn, id, &input.date, input.value)
}

/// Оценка на дату; повторная оценка на ту же дату заменяет прежнюю.
pub fn set_value(conn: &Connection, id: &str, date: &str, value: i64) -> Result<()> {
    time::check_date(date)?;
    if value < 0 {
        return invalid("стоимость не может быть отрицательной");
    }
    conn.execute(
        "INSERT INTO asset_values (asset_id, date, value) VALUES (?1, ?2, ?3)
         ON CONFLICT (asset_id, date) DO UPDATE SET value = excluded.value",
        params![id, date, value],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM assets WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound("имущество"));
    }
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<Asset>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, a.kind, a.currency_code, c.symbol, c.minor_units, a.note
         FROM assets a JOIN currencies c ON c.code = a.currency_code
         WHERE a.archived = 0 ORDER BY a.created_at, a.name",
    )?;
    let rows: Vec<_> = stmt
        .query_map([], |r| {
            Ok(Asset {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                currency_code: r.get(3)?,
                currency_symbol: r.get(4)?,
                minor_units: r.get(5)?,
                note: r.get(6)?,
                value: 0,
                valued_on: String::new(),
                history: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut hist = conn
        .prepare("SELECT date, value FROM asset_values WHERE asset_id = ?1 ORDER BY date DESC")?;
    rows.into_iter()
        .map(|mut a| {
            a.history = hist
                .query_map([&a.id], |r| {
                    Ok(Valuation {
                        date: r.get(0)?,
                        value: r.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            if let Some(v) = a.history.first() {
                a.value = v.value;
                a.valued_on = v.date.clone();
            }
            Ok(a)
        })
        .collect()
}

/// Стоимость имущества на дату в основной валюте и валюты без курса.
pub fn total(conn: &Connection, on: &str) -> Result<(i64, Vec<String>)> {
    let base = currencies::base_currency(conn)?;
    let mut stmt = conn.prepare(
        "SELECT a.currency_code,
                (SELECT v.value FROM asset_values v WHERE v.asset_id = a.id AND v.date <= ?1
                 ORDER BY v.date DESC LIMIT 1)
         FROM assets a WHERE a.archived = 0",
    )?;
    let rows: Vec<(String, Option<i64>)> = stmt
        .query_map([on], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let (mut sum, mut missing) = (0, Vec::new());
    for (currency, value) in rows {
        let Some(value) = value else { continue };
        match currencies::convert(conn, value, &currency, &base, on)? {
            Some(v) => sum += v,
            None if !missing.contains(&currency) => missing.push(currency),
            None => {}
        }
    }
    Ok((sum, missing))
}

/// Есть ли хоть одно имущество (чтобы не показывать пустую строку в сводке).
pub fn any(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM assets WHERE archived = 0 LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn input(name: &str, value: i64, date: &str) -> AssetInput {
        AssetInput {
            name: name.into(),
            kind: "realty".into(),
            currency_code: "RUB".into(),
            value,
            date: date.into(),
            note: None,
        }
    }

    #[test]
    fn valuations_and_total_on_date() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let flat = create(c, &input("Квартира", 1_200_000_000, "2026-01-10")).unwrap();
        set_value(c, &flat, "2026-09-01", 1_350_000_000).unwrap();
        let car = create(
            c,
            &AssetInput {
                kind: "vehicle".into(),
                ..input("Машина", 150_000_000, "2026-05-01")
            },
        )
        .unwrap();
        assert_eq!(total(c, "2026-02-01").unwrap(), (1_200_000_000, vec![]));
        assert_eq!(
            total(c, "2026-10-20").unwrap().0,
            1_350_000_000 + 150_000_000
        );
        let list = list(c).unwrap();
        assert_eq!(list[0].value, 1_350_000_000);
        assert_eq!(list[0].valued_on, "2026-09-01");
        assert_eq!(list[0].history.len(), 2);
        // Новая оценка той же датой заменяет прежнюю.
        update(c, &car, &input("Машина", 140_000_000, "2026-05-01")).unwrap();
        assert_eq!(
            total(c, "2026-10-20").unwrap().0,
            1_350_000_000 + 140_000_000
        );
        assert!(create(c, &input(" ", 1, "2026-01-01")).is_err());
        assert!(create(c, &input("Дача", -1, "2026-01-01")).is_err());
        delete(c, &flat).unwrap();
        assert_eq!(total(c, "2026-10-20").unwrap().0, 140_000_000);
    }

    #[test]
    fn foreign_currency_needs_rate() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        create(
            c,
            &AssetInput {
                currency_code: "USD".into(),
                ..input("Машина", 2_000_000, "2026-10-01")
            },
        )
        .unwrap();
        assert_eq!(total(c, "2026-10-20").unwrap(), (0, vec!["USD".into()]));
        currencies::set_rate(c, "2026-10-01", "USD", "RUB", "90").unwrap();
        assert_eq!(total(c, "2026-10-20").unwrap(), (180_000_000, vec![]));
    }
}
