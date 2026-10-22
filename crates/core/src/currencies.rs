//! Справочник валют и курсы для пересчёта в основную валюту.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::money::Rate;
use crate::{settings, time, Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Currency {
    pub code: String,
    pub name: String,
    pub symbol: String,
    pub minor_units: u32,
}

/// Валюты, которые предлагает программа (по решению владельца, 0.15.1).
pub const OFFERED: &[&str] = &["RUB", "USD", "EUR", "CNY", "GBP", "KZT"];

/// Валюты для списков: предлагаемые и те прочие, что уже есть в счетах, долгах,
/// бюджетах, имуществе или целях (старые данные остаются видны). Рубль первым.
pub fn list(conn: &Connection) -> Result<Vec<Currency>> {
    let offered = OFFERED
        .iter()
        .map(|c| format!("'{c}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT code, name, symbol, minor_units FROM currencies
         WHERE code IN ({offered})
            OR code IN (SELECT currency_code FROM accounts
                        UNION SELECT currency_code FROM debts
                        UNION SELECT currency_code FROM budgets
                        UNION SELECT currency_code FROM assets
                        UNION SELECT currency_code FROM goals)
         ORDER BY code = 'RUB' DESC, code"
    ))?;
    let rows = stmt.query_map([], |r| {
        Ok(Currency {
            code: r.get(0)?,
            name: r.get(1)?,
            symbol: r.get(2)?,
            minor_units: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get(conn: &Connection, code: &str) -> Result<Currency> {
    conn.query_row(
        "SELECT code, name, symbol, minor_units FROM currencies WHERE code = ?1",
        [code],
        |r| {
            Ok(Currency {
                code: r.get(0)?,
                name: r.get(1)?,
                symbol: r.get(2)?,
                minor_units: r.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("валюта"))
}

pub fn minor_units(conn: &Connection, code: &str) -> Result<u32> {
    Ok(get(conn, code)?.minor_units)
}

pub fn base_currency(conn: &Connection) -> Result<String> {
    Ok(settings::get(conn, "base_currency")?.unwrap_or_else(|| "RUB".into()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRate {
    pub date: String,
    pub from_code: String,
    pub to_code: String,
    /// Десятичная строка: `92.15`.
    pub rate: String,
    pub source: String,
}

/// Записать курс `1 from = rate to` на дату (заменяет курс на ту же дату).
pub fn set_rate(conn: &Connection, date: &str, from: &str, to: &str, rate: &str) -> Result<()> {
    time::check_date(date)?;
    if from == to {
        return invalid("курс задаётся между разными валютами");
    }
    get(conn, from)?;
    get(conn, to)?;
    let rate = Rate::parse(rate)?;
    conn.execute(
        "INSERT INTO exchange_rates (date, from_code, to_code, rate, source) VALUES (?1, ?2, ?3, ?4, 'manual')
         ON CONFLICT (date, from_code, to_code) DO UPDATE SET rate = excluded.rate, source = 'manual'",
        params![date, from, to, rate.to_string()],
    )?;
    Ok(())
}

pub fn delete_rate(conn: &Connection, date: &str, from: &str, to: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM exchange_rates WHERE date = ?1 AND from_code = ?2 AND to_code = ?3",
        params![date, from, to],
    )?;
    Ok(())
}

pub fn list_rates(conn: &Connection) -> Result<Vec<ExchangeRate>> {
    let mut stmt = conn.prepare(
        "SELECT date, from_code, to_code, rate, source FROM exchange_rates ORDER BY date DESC, from_code, to_code",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ExchangeRate {
            date: r.get(0)?,
            from_code: r.get(1)?,
            to_code: r.get(2)?,
            rate: r.get(3)?,
            source: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Последний известный курс на дату (или раньше): прямой `from→to` или обратный.
fn find_rate(conn: &Connection, from: &str, to: &str, on: &str) -> Result<Option<(Rate, bool)>> {
    let row: Option<(String, bool)> = conn
        .query_row(
            "SELECT rate, from_code <> ?1 FROM exchange_rates
             WHERE ((from_code = ?1 AND to_code = ?2) OR (from_code = ?2 AND to_code = ?1)) AND date <= ?3
             ORDER BY date DESC, from_code = ?1 DESC LIMIT 1",
            params![from, to, on],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(rate, inverse)| Ok((Rate::parse(&rate)?, inverse)))
        .transpose()
}

/// Курс `1 from = ? to` на дату строкой (для подстановки в форму).
pub fn rate_on(conn: &Connection, from: &str, to: &str, on: &str) -> Result<Option<String>> {
    Ok(find_rate(conn, from, to, on)?.map(|(rate, inverse)| {
        if inverse {
            invert_string(&rate)
        } else {
            rate.to_string()
        }
    }))
}

fn invert_string(rate: &Rate) -> String {
    // 1 / rate с шестью знаками: пересчитываем 1,000000 единицу по обратному курсу.
    let micro = rate.convert_inverse(1_000_000, 0, 0);
    Rate::from_amounts(1_000_000, 0, micro.max(1), 0)
        .map(|r| r.to_string())
        .unwrap_or_default()
}

/// Пересчитать сумму между валютами по курсу на дату. `None`, если курса нет.
pub fn convert(
    conn: &Connection,
    amount: i64,
    from: &str,
    to: &str,
    on: &str,
) -> Result<Option<i64>> {
    if from == to {
        return Ok(Some(amount));
    }
    let (from_minor, to_minor) = (minor_units(conn, from)?, minor_units(conn, to)?);
    Ok(find_rate(conn, from, to, on)?.map(|(rate, inverse)| {
        if inverse {
            rate.convert_inverse(amount, from_minor, to_minor)
        } else {
            rate.convert(amount, from_minor, to_minor)
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    #[test]
    fn rub_first() {
        let db = Storage::open_in_memory().unwrap();
        let all = list(db.conn()).unwrap();
        assert_eq!(all[0].code, "RUB");
        let codes: Vec<_> = all.iter().map(|c| c.code.as_str()).collect();
        assert_eq!(codes, ["RUB", "CNY", "EUR", "GBP", "KZT", "USD"]);
    }

    #[test]
    fn used_old_currency_stays_listed() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        c.execute(
            "INSERT INTO accounts (id, name, type, currency_code, opening_date, created_at, updated_at)
             VALUES ('a', 'Лиры', 'cash', 'TRY', '2026-01-01', '', '')",
            [],
        )
        .unwrap();
        let all = list(c).unwrap();
        assert!(all.iter().any(|x| x.code == "TRY"));
        assert!(!all.iter().any(|x| x.code == "JPY"));
    }

    #[test]
    fn latest_rate_on_date_direct_and_inverse() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        assert_eq!(convert(c, 100, "USD", "RUB", "2026-10-20").unwrap(), None);
        set_rate(c, "2026-10-01", "USD", "RUB", "90").unwrap();
        set_rate(c, "2026-10-15", "USD", "RUB", "92,15").unwrap();
        assert_eq!(
            convert(c, 100_000, "USD", "RUB", "2026-10-10").unwrap(),
            Some(9_000_000)
        );
        assert_eq!(
            convert(c, 100_000, "USD", "RUB", "2026-10-20").unwrap(),
            Some(9_215_000)
        );
        assert_eq!(
            convert(c, 921_500, "RUB", "USD", "2026-10-20").unwrap(),
            Some(10_000)
        );
        assert_eq!(
            convert(c, 100_000, "USD", "RUB", "2026-09-30").unwrap(),
            None
        );
        assert_eq!(
            rate_on(c, "USD", "RUB", "2026-10-20").unwrap().as_deref(),
            Some("92.15")
        );
        assert_eq!(
            rate_on(c, "RUB", "USD", "2026-10-10").unwrap().as_deref(),
            Some("0.011111")
        );
        // Замена курса на ту же дату.
        set_rate(c, "2026-10-15", "USD", "RUB", "93").unwrap();
        assert_eq!(list_rates(c).unwrap().len(), 2);
        assert!(set_rate(c, "2026-10-15", "USD", "USD", "1").is_err());
        assert!(set_rate(c, "2026-13-15", "USD", "RUB", "1").is_err());
    }
}
