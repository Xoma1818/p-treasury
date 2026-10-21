//! Цели накоплений: «Отпуск 150 000 ₽ к июлю». Прогресс берётся с привязанного
//! счёта (копилка, вклад) или из ручных пополнений; по темпу последних
//! месяцев считается, когда цель будет достигнута.

use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{accounts, currencies, ids, time, Error, Result};

/// За сколько последних дней считается темп накопления.
const PACE_DAYS: i64 = 90;
const DAYS_IN_MONTH: f64 = 30.44;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalInput {
    pub name: String,
    /// Сколько накопить, в минимальных единицах валюты.
    pub target: i64,
    pub currency_code: String,
    /// Счёт, остаток которого и есть накопленное (копилка, вклад). Без счёта —
    /// ручные пополнения.
    pub account_id: Option<String>,
    /// К какой дате, `YYYY-MM-DD`.
    pub deadline: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub name: String,
    pub target: i64,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub deadline: Option<String>,
    /// Накоплено сейчас (в валюте цели).
    pub saved: i64,
    /// 0–100.
    pub percent: u32,
    pub remaining: i64,
    /// Сколько в среднем прибавляется в месяц (за последние 3 месяца).
    pub pace_per_month: Option<i64>,
    /// Когда цель будет достигнута при нынешнем темпе.
    pub forecast_date: Option<String>,
    /// Сколько откладывать в месяц, чтобы успеть к сроку.
    pub need_per_month: Option<i64>,
    /// `reached`, `on_track` (успевает к сроку или срока нет), `behind`, `no_pace`.
    pub status: String,
    /// Нет курса валюты счёта к валюте цели: накопленное не посчитать.
    pub missing_rate: bool,
}

fn check(conn: &Connection, input: &GoalInput) -> Result<(String, Option<String>, Option<String>)> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("введите название цели, например «Отпуск»");
    }
    if input.target <= 0 {
        return invalid("сумма цели должна быть больше нуля");
    }
    currencies::get(conn, &input.currency_code)?;
    let account = input
        .account_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(a) = &account {
        accounts::head(conn, a)?;
    }
    let deadline = input
        .deadline
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(d) = &deadline {
        time::check_date(d)?;
    }
    Ok((name.to_string(), account, deadline))
}

pub fn create(conn: &Connection, input: &GoalInput) -> Result<String> {
    let (name, account, deadline) = check(conn, input)?;
    let id = ids::new_id();
    let now = time::now_utc();
    conn.execute(
        "INSERT INTO goals (id, name, target, currency_code, account_id, deadline, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, name, input.target, input.currency_code, account, deadline, now],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, input: &GoalInput) -> Result<()> {
    let (name, account, deadline) = check(conn, input)?;
    let n = conn.execute(
        "UPDATE goals SET name = ?2, target = ?3, currency_code = ?4, account_id = ?5, deadline = ?6, updated_at = ?7
         WHERE id = ?1",
        params![id, name, input.target, input.currency_code, account, deadline, time::now_utc()],
    )?;
    if n == 0 {
        return Err(Error::NotFound("цель"));
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM goals WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound("цель"));
    }
    Ok(())
}

/// Ручное пополнение цели (с минусом — взяли из накопленного).
pub fn deposit(conn: &Connection, goal_id: &str, date: &str, amount: i64) -> Result<()> {
    time::check_date(date)?;
    if amount == 0 {
        return invalid("введите сумму пополнения");
    }
    let account: Option<Option<String>> = conn
        .query_row(
            "SELECT account_id FROM goals WHERE id = ?1",
            [goal_id],
            |r| r.get(0),
        )
        .optional()?;
    match account {
        None => return Err(Error::NotFound("цель")),
        Some(Some(_)) => return invalid("цель привязана к счёту: пополняйте сам счёт переводом"),
        Some(None) => {}
    }
    conn.execute(
        "INSERT INTO goal_deposits (id, goal_id, date, amount, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ids::new_id(), goal_id, date, amount, time::now_utc()],
    )?;
    Ok(())
}

/// Все цели с прогрессом и прогнозом на `today`.
pub fn list(conn: &Connection, today: &str) -> Result<Vec<Goal>> {
    let today_d = time::parse_date(today)?;
    let since = (today_d - Duration::days(PACE_DAYS)).to_string();
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, g.target, g.currency_code, c.symbol, c.minor_units, g.account_id, a.name,
                a.currency_code, g.deadline, substr(g.created_at, 1, 10)
         FROM goals g JOIN currencies c ON c.code = g.currency_code
         LEFT JOIN accounts a ON a.id = g.account_id
         WHERE g.archived = 0 ORDER BY g.deadline IS NULL, g.deadline, g.created_at",
    )?;
    type Row = (
        String,
        String,
        i64,
        String,
        String,
        u32,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    );
    let rows: Vec<Row> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (
        id,
        name,
        target,
        currency,
        symbol,
        mu,
        account_id,
        account_name,
        account_cur,
        deadline,
        created,
    ) in rows
    {
        let mut missing_rate = false;
        let (saved, gained, window) = match (&account_id, &account_cur) {
            (Some(acc), Some(cur)) => {
                let now = accounts::balance(conn, acc, Some(today))?;
                let before = accounts::balance(conn, acc, Some(&since))?;
                let conv = |v: i64| currencies::convert(conn, v, cur, &currency, today);
                match (conv(now)?, conv(now - before)?) {
                    (Some(s), Some(g)) => (s, g, PACE_DAYS),
                    _ => {
                        missing_rate = true;
                        (0, 0, PACE_DAYS)
                    }
                }
            }
            _ => {
                let saved: i64 = conn.query_row(
                    "SELECT COALESCE(sum(amount), 0) FROM goal_deposits WHERE goal_id = ?1 AND date <= ?2",
                    params![id, today],
                    |r| r.get(0),
                )?;
                let gained: i64 = conn.query_row(
                    "SELECT COALESCE(sum(amount), 0) FROM goal_deposits WHERE goal_id = ?1 AND date > ?2 AND date <= ?3",
                    params![id, since, today],
                    |r| r.get(0),
                )?;
                // Молодая цель: темп считается с её создания, но не меньше чем за месяц.
                let age = time::parse_date(&created)
                    .map(|c| (today_d - c).num_days())
                    .unwrap_or(PACE_DAYS);
                (saved, gained, age.clamp(30, PACE_DAYS))
            }
        };
        let remaining = (target - saved).max(0);
        let percent = ((saved.max(0) as f64 / target as f64) * 100.0)
            .floor()
            .min(100.0) as u32;
        let pace =
            (gained > 0).then(|| (gained as f64 * DAYS_IN_MONTH / window as f64).round() as i64);
        let forecast = match pace {
            Some(p) if remaining > 0 && p > 0 => {
                let days = (remaining as f64 / p as f64 * DAYS_IN_MONTH).ceil() as i64;
                // При темпе в копейки дата уходит за пределы календаря: прогноза нет.
                Duration::try_days(days)
                    .and_then(|d| today_d.checked_add_signed(d))
                    .map(|d| d.to_string())
            }
            _ => None,
        };
        let need = deadline
            .as_deref()
            .and_then(|d| time::parse_date(d).ok())
            .map(|d: NaiveDate| {
                let months = ((d - today_d).num_days() as f64 / DAYS_IN_MONTH).max(1.0);
                (remaining as f64 / months).ceil() as i64
            });
        let status = if remaining == 0 {
            "reached"
        } else if pace.is_none() {
            "no_pace"
        } else if let (Some(d), Some(f)) = (&deadline, &forecast) {
            if f <= d {
                "on_track"
            } else {
                "behind"
            }
        } else {
            "on_track"
        };
        out.push(Goal {
            id,
            name,
            target,
            currency_code: currency,
            currency_symbol: symbol,
            minor_units: mu,
            account_id,
            account_name,
            deadline,
            saved,
            percent,
            remaining,
            pace_per_month: pace,
            forecast_date: forecast,
            need_per_month: need.filter(|_| remaining > 0),
            status: status.to_string(),
            missing_rate,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::AccountInput;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn goal(name: &str, target: i64, account: Option<String>, deadline: Option<&str>) -> GoalInput {
        GoalInput {
            name: name.into(),
            target,
            currency_code: "RUB".into(),
            account_id: account,
            deadline: deadline.map(str::to_string),
        }
    }

    #[test]
    fn manual_goal_progress_and_forecast() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let id = create(c, &goal("Отпуск", 15_000_000, None, Some("2027-06-30"))).unwrap();
        // Цель создана сегодня: темп считается как минимум за месяц.
        deposit(c, &id, &time::today_local(), 3_000_000).unwrap();
        let g = &list(c, &time::today_local()).unwrap()[0];
        assert_eq!(g.saved, 3_000_000);
        assert_eq!(g.percent, 20);
        assert_eq!(g.remaining, 12_000_000);
        assert!(g.pace_per_month.unwrap() > 2_900_000);
        assert!(g.forecast_date.is_some());
        assert!(g.need_per_month.is_some());
        assert!(matches!(g.status.as_str(), "on_track" | "behind"));
        assert!(deposit(c, &id, "2026-10-20", 0).is_err());
        assert!(create(c, &goal(" ", 1, None, None)).is_err());
        assert!(create(c, &goal("x", 0, None, None)).is_err());

        // Темп в копейку при цели в миллиарды: прогноз за пределами календаря не роняет программу.
        let big = create(c, &goal("Остров", i64::MAX / 2, None, None)).unwrap();
        deposit(c, &big, &time::today_local(), 1).unwrap();
        let g = list(c, &time::today_local()).unwrap();
        let g = g.iter().find(|g| g.id == big).unwrap();
        assert_eq!(
            (g.pace_per_month, g.forecast_date.as_deref()),
            (Some(1), None)
        );
    }

    #[test]
    fn account_goal_uses_balance_and_reaches() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let acc = accounts::create(
            c,
            &AccountInput {
                name: "Копилка".into(),
                kind: "savings".into(),
                currency_code: "RUB".into(),
                opening_balance: 0,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap();
        c.execute(
            "INSERT INTO categories (id, name, kind, created_at, updated_at) VALUES ('inc', 'Зарплата', 'income', '', '')",
            [],
        )
        .unwrap();
        let cat = "inc".to_string();
        for (date, amount) in [
            ("2026-08-15", 1_000_000),
            ("2026-09-15", 1_000_000),
            ("2026-10-15", 1_000_000),
        ] {
            transactions::create(
                c,
                &TxnInput {
                    kind: "income".into(),
                    date: date.into(),
                    account_id: acc.clone(),
                    amount,
                    category_id: Some(cat.clone()),
                    to_account_id: None,
                    to_amount: None,
                    payee: None,
                    note: None,
                },
            )
            .unwrap();
        }
        let id = create(
            c,
            &goal("Машина", 6_000_000, Some(acc.clone()), Some("2026-12-31")),
        )
        .unwrap();
        let g = &list(c, "2026-10-20").unwrap()[0];
        assert_eq!(g.saved, 3_000_000);
        assert_eq!(g.account_name.as_deref(), Some("Копилка"));
        // 3 пополнения по 10 000 ₽ за 90 дней ≈ 10 000 ₽ в месяц.
        assert_eq!(g.pace_per_month, Some(1_014_667));
        // Осталось 30 000 ₽ ≈ 3 месяца: к 31 декабря не успеть.
        assert_eq!(g.status, "behind");
        assert!(
            deposit(c, &id, "2026-10-20", 100).is_err(),
            "у цели со счётом пополняют счёт"
        );
        update(c, &id, &goal("Машина", 3_000_000, Some(acc), None)).unwrap();
        let g = &list(c, "2026-10-20").unwrap()[0];
        assert_eq!(
            (g.status.as_str(), g.percent, g.forecast_date.as_deref()),
            ("reached", 100, None)
        );
        delete(c, &id).unwrap();
        assert!(list(c, "2026-10-20").unwrap().is_empty());
    }
}
