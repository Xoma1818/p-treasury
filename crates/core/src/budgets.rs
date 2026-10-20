//! Месячные бюджеты: лимиты по категориям, план/факт/остаток.
//!
//! Период месяца считается от настройки `month_start_day`: при начале 25-го
//! «ноябрь 2026» — это 25.10.2026–24.11.2026. «Факт» не хранится, а считается
//! по операциям периода в валюте бюджета по курсу на дату операции. Переводы
//! и корректировки в факт не входят.

use std::collections::HashMap;

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::invalid;
use crate::{categories, currencies, ids, settings, time, Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    /// Месяц бюджета: `2026-11`.
    pub month: String,
    pub start: String,
    /// Последний день периода включительно.
    pub end: String,
}

fn parse_month(month: &str) -> Result<(i32, u32)> {
    let bad = || Error::Validation(format!("некорректный месяц: {month}"));
    let (y, m) = month.split_once('-').ok_or_else(bad)?;
    let (y, m): (i32, u32) = (y.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    if month.len() != 7 || !(1..=12).contains(&m) {
        return Err(bad());
    }
    Ok((y, m))
}

/// День `day` месяца, а если его нет (31-е в феврале) — последний день.
fn clamp_day(y: i32, m: u32, day: u32) -> NaiveDate {
    (1..=day)
        .rev()
        .find_map(|d| NaiveDate::from_ymd_opt(y, m, d))
        .expect("1-е число есть всегда")
}

fn prev_month(y: i32, m: u32) -> (i32, u32) {
    if m == 1 {
        (y - 1, 12)
    } else {
        (y, m - 1)
    }
}

fn next_month(y: i32, m: u32) -> (i32, u32) {
    if m == 12 {
        (y + 1, 1)
    } else {
        (y, m + 1)
    }
}

pub fn shift_month(month: &str, delta: i32) -> Result<String> {
    let (mut y, mut m) = parse_month(month)?;
    for _ in 0..delta.unsigned_abs() {
        (y, m) = if delta > 0 {
            next_month(y, m)
        } else {
            prev_month(y, m)
        };
    }
    Ok(format!("{y:04}-{m:02}"))
}

/// Период бюджетного месяца при начале месяца в день `start_day` (1–28 или до 31).
pub fn period(month: &str, start_day: u32) -> Result<Period> {
    let (y, m) = parse_month(month)?;
    let start_day = start_day.clamp(1, 31);
    let start = if start_day == 1 {
        NaiveDate::from_ymd_opt(y, m, 1).expect("валидный месяц")
    } else {
        let (py, pm) = prev_month(y, m);
        clamp_day(py, pm, start_day)
    };
    let (ny, nm) = next_month(y, m);
    let next_start = if start_day == 1 {
        NaiveDate::from_ymd_opt(ny, nm, 1).expect("валидный месяц")
    } else {
        clamp_day(y, m, start_day)
    };
    let end = next_start - Duration::days(1);
    Ok(Period {
        month: month.to_string(),
        start: start.to_string(),
        end: end.to_string(),
    })
}

pub fn start_day(conn: &Connection) -> Result<u32> {
    Ok(settings::get(conn, "month_start_day")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(1))
}

/// Бюджетный месяц, в который попадает дата.
pub fn month_of(conn: &Connection, date: &str) -> Result<Period> {
    time::check_date(date)?;
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").expect("проверено");
    let sd = start_day(conn)?;
    let candidate = format!("{:04}-{:02}", d.year(), d.month());
    // Дата либо в «своём» месяце, либо (при начале не с 1-го) уже в следующем.
    for month in [candidate.clone(), shift_month(&candidate, 1)?] {
        let p = period(&month, sd)?;
        if p.start.as_str() <= date && date <= p.end.as_str() {
            return Ok(p);
        }
    }
    unreachable!("каждая дата попадает в один из двух соседних периодов")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub category_id: String,
    pub category_name: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub limit: i64,
    /// Факт за период (для родительской категории вместе с подкатегориями).
    pub actual: i64,
    pub remaining: i64,
    /// Процент исполнения, целый (0 при нулевом лимите).
    pub percent: i64,
    pub over: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub id: Option<String>,
    pub period: Period,
    pub currency_code: String,
    pub currency_symbol: String,
    pub note: Option<String>,
    pub lines: Vec<Line>,
    pub planned_expense: i64,
    pub planned_income: i64,
    /// Все расходы периода (в том числе по категориям без лимита).
    pub actual_expense: i64,
    pub actual_income: i64,
    /// Расходы по категориям без лимита.
    pub unbudgeted_expense: i64,
    /// «Можно тратить сегодня»: остаток лимитов расходов / оставшиеся дни
    /// периода, включая `today`. `None`, если бюджета нет или период не текущий.
    pub safe_to_spend_today: Option<i64>,
    pub missing_rates: Vec<String>,
}

fn budget_row(conn: &Connection, start: &str) -> Result<Option<(String, String, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT id, currency_code, note FROM budgets WHERE period_start = ?1 AND period_type = 'month'",
            [start],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

/// Факт по категориям за период в валюте `currency`: (расходы, доходы) по id категории.
fn actuals(
    conn: &Connection,
    p: &Period,
    currency: &str,
) -> Result<(HashMap<String, i64>, Vec<String>)> {
    let mut stmt = conn.prepare(
        "SELECT t.category_id, t.date, t.amount, a.currency_code FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type IN ('expense', 'income') AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows = stmt.query_map(params![p.start, p.end], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut by_cat: HashMap<String, i64> = HashMap::new();
    let mut missing = Vec::new();
    for row in rows {
        let (cat, date, amount, cur) = row?;
        match currencies::convert(conn, amount, &cur, currency, &date)? {
            Some(v) => *by_cat.entry(cat).or_default() += v,
            None if !missing.contains(&cur) => missing.push(cur),
            None => {}
        }
    }
    Ok((by_cat, missing))
}

/// Бюджет месяца с фактом. Если бюджета нет, `id = None` и строк нет,
/// но факт за период всё равно посчитан.
pub fn get(conn: &Connection, month: &str, today: &str) -> Result<Budget> {
    let p = period(month, start_day(conn)?)?;
    let row = budget_row(conn, &p.start)?;
    let currency = match &row {
        Some((_, c, _)) => c.clone(),
        None => currencies::base_currency(conn)?,
    };
    let symbol = currencies::get(conn, &currency)?.symbol;
    let (by_cat, missing_rates) = actuals(conn, &p, &currency)?;

    let cats = categories::list(conn, true)?;
    let parent_of: HashMap<&str, Option<&str>> = cats
        .iter()
        .map(|c| (c.id.as_str(), c.parent_id.as_deref()))
        .collect();
    let kind_of: HashMap<&str, &str> = cats
        .iter()
        .map(|c| (c.id.as_str(), c.kind.as_str()))
        .collect();
    let actual_for = |cat: &str| -> i64 {
        by_cat
            .iter()
            .filter(|(id, _)| {
                id.as_str() == cat || parent_of.get(id.as_str()).copied().flatten() == Some(cat)
            })
            .map(|(_, v)| v)
            .sum()
    };

    let mut lines = Vec::new();
    if let Some((id, _, _)) = &row {
        let mut stmt = conn.prepare(
            "SELECT bl.category_id, c.name, c.parent_id, c.kind, bl.limit_amount
             FROM budget_lines bl JOIN categories c ON c.id = bl.category_id
             LEFT JOIN categories p ON p.id = c.parent_id
             WHERE bl.budget_id = ?1
             ORDER BY c.kind = 'income', COALESCE(p.sort_order, c.sort_order), COALESCE(p.name, c.name),
                      c.parent_id IS NOT NULL, c.sort_order, c.name",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (category_id, category_name, parent_id, kind, limit) = row?;
            let actual = actual_for(&category_id);
            lines.push(Line {
                remaining: limit - actual,
                percent: if limit > 0 {
                    ((actual as i128 * 100) / limit as i128) as i64
                } else {
                    0
                },
                over: kind == "expense" && actual > limit,
                category_id,
                category_name,
                parent_id,
                kind,
                limit,
                actual,
            });
        }
    }

    // Итоги: подкатегория с лимитом внутри родителя с лимитом не считается дважды.
    let budgeted: Vec<&str> = lines.iter().map(|l| l.category_id.as_str()).collect();
    let top_level = |l: &&Line| {
        l.parent_id
            .as_deref()
            .is_none_or(|p| !budgeted.contains(&p))
    };
    let planned_expense: i64 = lines
        .iter()
        .filter(|l| l.kind == "expense")
        .filter(top_level)
        .map(|l| l.limit)
        .sum();
    let planned_income: i64 = lines
        .iter()
        .filter(|l| l.kind == "income")
        .filter(top_level)
        .map(|l| l.limit)
        .sum();
    let covered = |cat: &str| {
        budgeted.contains(&cat)
            || parent_of
                .get(cat)
                .copied()
                .flatten()
                .is_some_and(|p| budgeted.contains(&p))
    };
    let (mut actual_expense, mut actual_income, mut unbudgeted_expense) = (0i64, 0i64, 0i64);
    for (cat, v) in &by_cat {
        match kind_of.get(cat.as_str()).copied() {
            Some("expense") => {
                actual_expense += v;
                if !covered(cat) {
                    unbudgeted_expense += v;
                }
            }
            Some("income") => actual_income += v,
            _ => {}
        }
    }

    let safe_to_spend_today =
        if row.is_some() && p.start.as_str() <= today && today <= p.end.as_str() {
            let budgeted_spent: i64 = lines
                .iter()
                .filter(|l| l.kind == "expense")
                .filter(top_level)
                .map(|l| l.actual)
                .sum();
            let end = NaiveDate::parse_from_str(&p.end, "%Y-%m-%d").expect("дата периода");
            let now = NaiveDate::parse_from_str(today, "%Y-%m-%d")
                .map_err(|_| Error::Validation(format!("некорректная дата: {today}")))?;
            let days_left = (end - now).num_days() + 1;
            let left = planned_expense - budgeted_spent;
            // Округление вниз до минимальной единицы, чтобы не обещать лишнего.
            Some(left.div_euclid(days_left))
        } else {
            None
        };

    Ok(Budget {
        id: row.as_ref().map(|r| r.0.clone()),
        note: row.and_then(|r| r.2),
        period: p,
        currency_code: currency,
        currency_symbol: symbol,
        lines,
        planned_expense,
        planned_income,
        actual_expense,
        actual_income,
        unbudgeted_expense,
        safe_to_spend_today,
        missing_rates,
    })
}

/// Создать бюджет месяца; с `copy_previous` — копией лимитов прошлого месяца.
pub fn create(conn: &mut Connection, month: &str, copy_previous: bool) -> Result<String> {
    let sd = start_day(conn)?;
    let p = period(month, sd)?;
    if budget_row(conn, &p.start)?.is_some() {
        return invalid("бюджет на этот месяц уже есть");
    }
    let prev = budget_row(conn, &period(&shift_month(month, -1)?, sd)?.start)?;
    if copy_previous && prev.is_none() {
        return invalid("в прошлом месяце бюджета нет: копировать нечего");
    }
    let currency = match (&prev, copy_previous) {
        (Some((_, c, _)), true) => c.clone(),
        _ => currencies::base_currency(conn)?,
    };
    let tx = conn.transaction()?;
    let id = ids::new_id();
    let now = time::now_utc();
    tx.execute(
        "INSERT INTO budgets (id, period_start, period_type, currency_code, created_at, updated_at)
         VALUES (?1, ?2, 'month', ?3, ?4, ?4)",
        params![id, p.start, currency, now],
    )?;
    if let (Some((prev_id, _, _)), true) = (&prev, copy_previous) {
        tx.execute(
            "INSERT INTO budget_lines (id, budget_id, category_id, limit_amount, rollover)
             SELECT lower(hex(randomblob(16))), ?1, bl.category_id, bl.limit_amount, bl.rollover
             FROM budget_lines bl JOIN categories c ON c.id = bl.category_id
             WHERE bl.budget_id = ?2 AND c.archived_at IS NULL",
            params![id, prev_id],
        )?;
    }
    tx.commit()?;
    Ok(id)
}

fn check_budget(conn: &Connection, budget_id: &str) -> Result<()> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM budgets WHERE id = ?1",
        [budget_id],
        |r| r.get(0),
    )?;
    if n == 0 {
        return Err(Error::NotFound("бюджет"));
    }
    Ok(())
}

/// Задать лимит категории. `None` убирает категорию из бюджета.
pub fn set_limit(
    conn: &Connection,
    budget_id: &str,
    category_id: &str,
    limit: Option<i64>,
) -> Result<()> {
    check_budget(conn, budget_id)?;
    categories::kind_of(conn, category_id)?;
    match limit {
        None => {
            conn.execute(
                "DELETE FROM budget_lines WHERE budget_id = ?1 AND category_id = ?2",
                params![budget_id, category_id],
            )?;
        }
        Some(v) if v < 0 => return invalid("лимит не может быть отрицательным"),
        Some(v) => {
            conn.execute(
                "INSERT INTO budget_lines (id, budget_id, category_id, limit_amount) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (budget_id, category_id) DO UPDATE SET limit_amount = excluded.limit_amount",
                params![ids::new_id(), budget_id, category_id, v],
            )?;
        }
    }
    conn.execute(
        "UPDATE budgets SET updated_at = ?2 WHERE id = ?1",
        params![budget_id, time::now_utc()],
    )?;
    Ok(())
}

pub fn set_note(conn: &Connection, budget_id: &str, note: Option<&str>) -> Result<()> {
    check_budget(conn, budget_id)?;
    let note = note.map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "UPDATE budgets SET note = ?2, updated_at = ?3 WHERE id = ?1",
        params![budget_id, note, time::now_utc()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, budget_id: &str) -> Result<()> {
    check_budget(conn, budget_id)?;
    conn.execute("DELETE FROM budgets WHERE id = ?1", [budget_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    #[test]
    fn periods() {
        let p = |m: &str, d: u32| {
            let p = period(m, d).unwrap();
            (p.start, p.end)
        };
        assert_eq!(p("2026-11", 1), ("2026-11-01".into(), "2026-11-30".into()));
        assert_eq!(p("2026-11", 25), ("2026-10-25".into(), "2026-11-24".into()));
        assert_eq!(p("2026-01", 10), ("2025-12-10".into(), "2026-01-09".into()));
        // 31-е: в феврале берётся последний день.
        assert_eq!(p("2026-03", 31), ("2026-02-28".into(), "2026-03-30".into()));
        assert_eq!(p("2028-03", 31), ("2028-02-29".into(), "2028-03-30".into()));
        assert_eq!(p("2026-02", 31), ("2026-01-31".into(), "2026-02-27".into()));
        assert!(period("2026-13", 1).is_err());
        assert_eq!(shift_month("2026-01", -1).unwrap(), "2025-12");
        assert_eq!(shift_month("2026-12", 1).unwrap(), "2027-01");
    }

    #[test]
    fn month_of_date_respects_start_day() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        assert_eq!(month_of(c, "2026-10-25").unwrap().month, "2026-10");
        settings::set(c, "month_start_day", "25").unwrap();
        assert_eq!(month_of(c, "2026-10-24").unwrap().month, "2026-10");
        assert_eq!(month_of(c, "2026-10-25").unwrap().month, "2026-11");
        assert_eq!(month_of(c, "2026-12-31").unwrap().month, "2027-01");
    }

    struct Fx {
        db: Storage,
        card: String,
        eur: String,
    }

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 ORDER BY kind = 'income' LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn fx() -> Fx {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        Fx {
            card: accounts::create(c, &input("Карта", "debit", "RUB", 10_000_000)).unwrap(),
            eur: accounts::create(c, &input("Евро", "debit", "EUR", 100_000)).unwrap(),
            db,
        }
    }

    fn spend(c: &Connection, account: &str, date: &str, amount: i64, category: &str) {
        let kind = categories::kind_of(c, &cat(c, category)).unwrap();
        transactions::create(
            c,
            &TxnInput {
                kind,
                date: date.into(),
                account_id: account.into(),
                amount,
                category_id: Some(cat(c, category)),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn control_during_month() {
        // Сценарий «Контроль в течение месяца»: «Кафе» 90 %, «Продукты» 55 %.
        let mut f = fx();
        let id = create(f.db.conn_mut(), "2026-10", false).unwrap();
        let c = f.db.conn();
        set_limit(c, &id, &cat(c, "Кафе и рестораны"), Some(1_000_000)).unwrap();
        set_limit(c, &id, &cat(c, "Продукты"), Some(2_000_000)).unwrap();
        set_limit(c, &id, &cat(c, "Зарплата"), Some(8_500_000)).unwrap();
        spend(c, &f.card, "2026-10-05", 600_000, "Кафе и рестораны");
        spend(c, &f.card, "2026-10-12", 300_000, "Обеды"); // подкатегория идёт в «Кафе»
        spend(c, &f.card, "2026-10-15", 1_100_000, "Супермаркет");
        spend(c, &f.card, "2026-10-16", 50_000, "Такси"); // без лимита
        spend(c, &f.card, "2026-11-01", 999_999, "Продукты"); // другой месяц
        spend(c, &f.card, "2026-10-05", 8_500_000, "Зарплата");
        accounts::adjust_balance(c, &f.card, 0, "2026-10-20", None).unwrap(); // не входит в факт

        let b = get(c, "2026-10", "2026-10-18").unwrap();
        let line = |n: &str| {
            b.lines
                .iter()
                .find(|l| l.category_name == n)
                .unwrap()
                .clone()
        };
        assert_eq!(
            (
                line("Кафе и рестораны").actual,
                line("Кафе и рестораны").percent
            ),
            (900_000, 90)
        );
        assert_eq!(
            (line("Продукты").actual, line("Продукты").percent),
            (1_100_000, 55)
        );
        assert!(!line("Кафе и рестораны").over);
        assert_eq!(b.planned_expense, 3_000_000);
        assert_eq!(b.planned_income, 8_500_000);
        assert_eq!(b.actual_expense, 2_050_000);
        assert_eq!(b.actual_income, 8_500_000);
        assert_eq!(b.unbudgeted_expense, 50_000);
        // Можно тратить: (3 000 000 − 2 000 000) / 14 дней (18–31 октября) = 71 428 коп.
        assert_eq!(b.safe_to_spend_today, Some(71_428));
        assert_eq!(
            get(c, "2026-10", "2026-11-02").unwrap().safe_to_spend_today,
            None
        );

        spend(c, &f.card, "2026-10-19", 200_000, "Кафе и рестораны");
        let b = get(c, "2026-10", "2026-10-19").unwrap();
        let cafe = b
            .lines
            .iter()
            .find(|l| l.category_name == "Кафе и рестораны")
            .unwrap();
        assert!(cafe.over, "перерасход отмечается");
        assert_eq!(cafe.remaining, -100_000);
    }

    #[test]
    fn foreign_currency_spending_in_budget_currency() {
        // Сценарий «Покупка в поездке»: 45 € в бюджете «Путешествия» в рублях по курсу дня.
        let mut f = fx();
        let id = create(f.db.conn_mut(), "2026-10", false).unwrap();
        let c = f.db.conn();
        set_limit(c, &id, &cat(c, "Путешествия"), Some(5_000_000)).unwrap();
        currencies::set_rate(c, "2026-10-01", "EUR", "RUB", "100.5").unwrap();
        spend(c, &f.eur, "2026-10-07", 4_500, "Путешествия");
        let b = get(c, "2026-10", "2026-10-20").unwrap();
        assert_eq!(b.lines[0].actual, 452_250);
    }

    #[test]
    fn copy_previous_month() {
        // Сценарий «Планирование месяца»: скопировать октябрь в ноябрь и поднять «Подарки».
        let mut f = fx();
        let oct = create(f.db.conn_mut(), "2026-10", false).unwrap();
        {
            let c = f.db.conn();
            set_limit(c, &oct, &cat(c, "Подарки"), Some(500_000)).unwrap();
            set_limit(c, &oct, &cat(c, "Продукты"), Some(2_000_000)).unwrap();
        }
        assert!(
            create(f.db.conn_mut(), "2026-10", false).is_err(),
            "второй бюджет на месяц нельзя"
        );
        assert!(
            create(f.db.conn_mut(), "2026-09", true).is_err(),
            "в августе бюджета нет"
        );
        let nov = create(f.db.conn_mut(), "2026-11", true).unwrap();
        let c = f.db.conn();
        set_limit(c, &nov, &cat(c, "Подарки"), Some(1_000_000)).unwrap();
        let b = get(c, "2026-11", "2026-11-01").unwrap();
        assert_eq!(b.lines.len(), 2);
        assert_eq!(b.planned_expense, 3_000_000);
        // Октябрь не изменился.
        assert_eq!(
            get(c, "2026-10", "2026-10-01").unwrap().planned_expense,
            2_500_000
        );

        set_limit(c, &nov, &cat(c, "Подарки"), None).unwrap();
        assert_eq!(get(c, "2026-11", "2026-11-01").unwrap().lines.len(), 1);
        set_note(c, &nov, Some("  в ноябре ремонт, кафе урезал ")).unwrap();
        assert_eq!(
            get(c, "2026-11", "2026-11-01").unwrap().note.as_deref(),
            Some("в ноябре ремонт, кафе урезал")
        );
        assert!(set_limit(c, &nov, &cat(c, "Продукты"), Some(-1)).is_err());
    }

    #[test]
    fn nested_limits_not_double_counted() {
        let mut f = fx();
        let id = create(f.db.conn_mut(), "2026-10", false).unwrap();
        let c = f.db.conn();
        set_limit(c, &id, &cat(c, "Транспорт"), Some(1_000_000)).unwrap();
        set_limit(c, &id, &cat(c, "Такси"), Some(300_000)).unwrap();
        spend(c, &f.card, "2026-10-05", 100_000, "Такси");
        let b = get(c, "2026-10", "2026-10-05").unwrap();
        assert_eq!(b.planned_expense, 1_000_000);
        assert_eq!(
            b.lines
                .iter()
                .find(|l| l.category_name == "Транспорт")
                .unwrap()
                .actual,
            100_000
        );
        assert_eq!(
            b.lines
                .iter()
                .find(|l| l.category_name == "Такси")
                .unwrap()
                .actual,
            100_000
        );
        assert_eq!(b.safe_to_spend_today, Some((1_000_000 - 100_000) / 27));
    }

    #[test]
    fn custom_month_start() {
        // При начале месяца 25-го трата 26 октября относится к ноябрю.
        let mut f = fx();
        settings::set(f.db.conn(), "month_start_day", "25").unwrap();
        let id = create(f.db.conn_mut(), "2026-11", false).unwrap();
        let c = f.db.conn();
        set_limit(c, &id, &cat(c, "Продукты"), Some(1_000_000)).unwrap();
        spend(c, &f.card, "2026-10-26", 10_000, "Продукты");
        spend(c, &f.card, "2026-10-24", 20_000, "Продукты");
        let b = get(c, "2026-11", "2026-10-26").unwrap();
        assert_eq!(b.period.start, "2026-10-25");
        assert_eq!(b.lines[0].actual, 10_000);
        let stored: String = c
            .query_row("SELECT period_start FROM budgets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, "2026-10-25");
    }
}
