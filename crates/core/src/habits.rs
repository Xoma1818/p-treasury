//! Дни без трат, серия таких дней и итог прошлой недели (уведомление по понедельникам).

use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{calendar, currencies, settings, Result};

/// Дата первой операции: дни до начала учёта не считаются днями без трат.
pub fn first_day(conn: &Connection) -> Result<Option<String>> {
    Ok(conn.query_row(
        "SELECT min(date) FROM transactions WHERE status = 'cleared'",
        [],
        |r| r.get(0),
    )?)
}

fn date(s: &str) -> Result<NaiveDate> {
    crate::loan_calc::parse_date(s)
}

/// Сколько дней подряд, считая сегодня, не было расходов.
pub fn streak(conn: &Connection, today: &str) -> Result<u32> {
    let Some(start) = first_day(conn)? else {
        return Ok(0);
    };
    let mut stmt = conn.prepare(
        "SELECT max(date) FROM transactions
         WHERE status = 'cleared' AND type = 'expense' AND date <= ?1",
    )?;
    let last: Option<String> = stmt.query_row([today], |r| r.get(0))?;
    let today_d = date(today)?;
    // Серия идёт от дня после последней траты (или от начала учёта).
    let from = match last {
        Some(l) => date(&l)? + Duration::days(1),
        None => date(&start)?,
    };
    Ok(if from > today_d {
        0
    } else {
        ((today_d - from).num_days() + 1) as u32
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeekSummary {
    /// Понедельник и воскресенье прошлой недели.
    pub from: String,
    pub to: String,
    pub expense: i64,
    pub income: i64,
    /// Расходы позапрошлой недели, для сравнения.
    pub prev_expense: i64,
    pub no_spend_days: u32,
    /// Больше всего ушло на эту категорию (верхнего уровня).
    pub top_category: Option<String>,
    pub top_amount: i64,
    pub streak: u32,
    pub currency_symbol: String,
    pub minor_units: u32,
}

fn monday(d: NaiveDate) -> NaiveDate {
    d - Duration::days(d.weekday().num_days_from_monday() as i64)
}

/// Итог прошлой полной недели (понедельник — воскресенье) относительно `today`.
pub fn last_week(conn: &Connection, today: &str) -> Result<WeekSummary> {
    let this_monday = monday(date(today)?);
    let (from, to) = (
        this_monday - Duration::days(7),
        this_monday - Duration::days(1),
    );
    let week = calendar::range(conn, from, to, today)?;
    let prev = calendar::range(
        conn,
        from - Duration::days(7),
        from - Duration::days(1),
        today,
    )?;
    let base = currencies::base_currency(conn)?;
    let mut stmt = conn.prepare(
        "SELECT COALESCE(p.name, c.name), t.amount, a.currency_code, t.date
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         WHERE t.status = 'cleared' AND t.type = 'expense' AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows: Vec<(String, i64, String, String)> = stmt
        .query_map(params![from.to_string(), to.to_string()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut by_cat: BTreeMap<String, i64> = BTreeMap::new();
    for (cat, amount, currency, d) in rows {
        if let Some(v) = currencies::convert(conn, amount, &currency, &base, &d)? {
            *by_cat.entry(cat).or_default() += v;
        }
    }
    let top = by_cat
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)));
    Ok(WeekSummary {
        from: from.to_string(),
        to: to.to_string(),
        expense: week.expense,
        income: week.income,
        prev_expense: prev.expense,
        no_spend_days: week.days.iter().filter(|d| d.no_spend).count() as u32,
        top_amount: top.as_ref().map_or(0, |t| t.1),
        top_category: top.map(|t| t.0),
        streak: streak(conn, today)?,
        currency_symbol: week.currency_symbol,
        minor_units: week.minor_units,
    })
}

/// Пора ли прислать итог недели: понедельник или позже, с 9:00, включено,
/// за эту неделю ещё не присылали и неделя не пустая. Отмечает отправку.
pub fn weekly_due(conn: &Connection, now: NaiveDateTime) -> Result<Option<WeekSummary>> {
    if settings::get(conn, "weekly_summary")?.as_deref() == Some("0") {
        return Ok(None);
    }
    let today = now.date();
    if today == monday(today) && now.time() < chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap() {
        return Ok(None);
    }
    let week = monday(today).to_string();
    if settings::get(conn, "weekly_summary_sent")?.as_deref() == Some(week.as_str()) {
        return Ok(None);
    }
    let s = last_week(conn, &today.to_string())?;
    settings::set(conn, "weekly_summary_sent", &week)?;
    Ok((s.expense > 0 || s.income > 0).then_some(s))
}

/// Текст уведомления: «Итог недели: расходы 12 400 ₽ (на 8 % меньше), 2 дня без трат».
pub fn weekly_text(s: &WeekSummary) -> String {
    let money = |v: i64| {
        format!(
            "{} {}",
            crate::money::format_amount(v, s.minor_units, true),
            s.currency_symbol
        )
    };
    let mut text = format!("Итог недели: расходы {}", money(s.expense));
    if s.prev_expense > 0 {
        let pct =
            ((s.expense - s.prev_expense) as f64 / s.prev_expense as f64 * 100.0).round() as i64;
        text.push_str(&match pct {
            0 => " (как неделей раньше)".to_string(),
            p if p < 0 => format!(" (на {} % меньше)", -p),
            p => format!(" (на {p} % больше)"),
        });
    }
    if let Some(c) = &s.top_category {
        text.push_str(&format!(", больше всего — {c}"));
    }
    if s.no_spend_days > 0 {
        text.push_str(&format!(", дней без трат: {}", s.no_spend_days));
    }
    text.push('.');
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::categories;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn spend(c: &Connection, acc: &str, cat: &str, date: &str, amount: i64) {
        transactions::create(
            c,
            &TxnInput {
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
        .unwrap();
    }

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn no_spend_days_streak_and_weekly_summary() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        assert_eq!(streak(c, "2026-10-20").unwrap(), 0, "учёта ещё нет");
        // Позапрошлая неделя (5–11 октября): 10 000 ₽.
        spend(c, &card, &cat(c, "Супермаркет"), "2026-10-06", 1_000_000);
        // Прошлая неделя (12–18 октября): 6 000 ₽ в два дня.
        spend(c, &card, &cat(c, "Супермаркет"), "2026-10-13", 200_000);
        spend(c, &card, &cat(c, "Такси"), "2026-10-15", 400_000);
        // 20 октября — вторник; последняя трата 15-го: серия 16–20, пять дней.
        assert_eq!(streak(c, "2026-10-20").unwrap(), 5);

        let m = calendar::month(c, "2026-10", "2026-10-20").unwrap();
        let day = |d: &str| m.days.iter().find(|x| x.date == d).unwrap().no_spend;
        assert!(!day("2026-10-05"), "до первой операции не считается");
        assert!(day("2026-10-07"));
        assert!(!day("2026-10-13"));
        assert!(!day("2026-10-21"), "будущее не считается");

        let w = last_week(c, "2026-10-20").unwrap();
        assert_eq!(
            (w.from.as_str(), w.to.as_str()),
            ("2026-10-12", "2026-10-18")
        );
        assert_eq!(
            (w.expense, w.prev_expense, w.no_spend_days),
            (600_000, 1_000_000, 5)
        );
        assert_eq!(w.top_category.as_deref(), Some("Транспорт"));
        assert_eq!(
            weekly_text(&w),
            "Итог недели: расходы 6\u{a0}000 ₽ (на 40 % меньше), больше всего — Транспорт, дней без трат: 5."
        );

        // Понедельник 19-го до 9:00 — рано; после — один раз за неделю.
        let at = |s: &str| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap();
        assert!(weekly_due(c, at("2026-10-19 08:30")).unwrap().is_none());
        assert!(weekly_due(c, at("2026-10-19 09:05")).unwrap().is_some());
        assert!(weekly_due(c, at("2026-10-20 12:00")).unwrap().is_none());
        settings::set(c, "weekly_summary", "0").unwrap();
        assert!(weekly_due(c, at("2026-10-26 10:00")).unwrap().is_none());
    }
}
