//! Сравнение с обычным (А2): траты по категориям с начала месяца против
//! среднего за тот же отрезок дней трёх прошлых месяцев. Месяцы до начала
//! учёта в среднее не входят; без истории сравнения нет. Суммы в основной
//! валюте; поездки и события вне бюджета не считаются, трата на N месяцев
//! делится по месяцам — как в Бюджете.

use std::collections::HashMap;

use chrono::Duration;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{budgets, categories, currencies, reports, time, Result};

/// Разница, начиная с которой категория «необычна»: процент и сумма в основной валюте.
pub const MIN_PERCENT: i64 = 25;
pub const MIN_DIFF_UNITS: i64 = 1_000;
/// Сколько прошлых месяцев брать.
pub const HISTORY: i32 = 3;
/// Сколько категорий показывать на Главной.
pub const HOME_LIMIT: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsualRow {
    pub category_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    /// Траты с начала месяца (для верхней категории — вместе с подкатегориями).
    pub current: i64,
    /// Обычно за тот же отрезок дней.
    pub usual: i64,
    /// current − usual.
    pub diff: i64,
    /// На сколько процентов больше (меньше) обычного; `None`, если обычно 0.
    pub percent: Option<i64>,
    /// Разница не меньше 25 % и не меньше 1 000 единиц основной валюты.
    pub notable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsualReport {
    pub month: String,
    pub base_currency: String,
    pub base_symbol: String,
    /// Отрезок текущего месяца.
    pub from: String,
    pub to: String,
    /// Сколько прошлых месяцев вошло в «обычно» (0 — истории нет).
    pub months_counted: i64,
    /// Все категории расходов с тратами сейчас или раньше, по убыванию |diff|.
    pub items: Vec<UsualRow>,
    /// Карточка Главной «Необычно в этом месяце»: до трёх верхних категорий.
    pub home: Vec<UsualRow>,
    pub missing_rates: Vec<String>,
}

fn sums(
    conn: &Connection,
    from: &str,
    to: &str,
    base: &str,
    missing: &mut Vec<String>,
) -> Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare(
        "SELECT t.category_id, t.date, t.amount, a.currency_code FROM txn_by_month t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type = 'expense' AND t.event_id IS NULL
           AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows: Vec<(String, String, i64, String)> = stmt
        .query_map(params![from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out: HashMap<String, i64> = HashMap::new();
    for (cat, date, amount, cur) in rows {
        match currencies::convert(conn, amount, &cur, base, &date)? {
            Some(v) => *out.entry(cat).or_default() += v,
            None if !missing.contains(&cur) => missing.push(cur),
            None => {}
        }
    }
    Ok(out)
}

/// Сравнить месяц `month` с обычным. Если `today` внутри месяца, сравнивается
/// отрезок с начала месяца по `today`, иначе — месяц целиком.
pub fn compare(conn: &Connection, month: &str, today: &str) -> Result<UsualReport> {
    time::check_date(today)?;
    let sd = budgets::start_day(conn)?;
    let p = budgets::period(month, sd)?;
    let base = currencies::base_currency(conn)?;
    let cur = currencies::get(conn, &base)?;
    let to = if p.start.as_str() <= today && today <= p.end.as_str() {
        today.to_string()
    } else {
        p.end.clone()
    };
    let offset = (time::parse_date(&to)? - time::parse_date(&p.start)?).num_days();
    let mut missing = Vec::new();
    let now = sums(conn, &p.start, &to, &base, &mut missing)?;

    let first: Option<String> = conn.query_row(
        "SELECT min(date) FROM transactions WHERE type IN ('expense', 'income') AND status = 'cleared'",
        [],
        |r| r.get(0),
    )?;
    let mut past: HashMap<String, i64> = HashMap::new();
    let mut counted = 0i64;
    for k in 1..=HISTORY {
        let mp = budgets::period(&budgets::shift_month(month, -k)?, sd)?;
        if first.as_deref().is_none_or(|f| mp.end.as_str() < f) {
            continue;
        }
        counted += 1;
        let end = (time::parse_date(&mp.start)? + Duration::days(offset))
            .to_string()
            .min(mp.end.clone());
        for (cat, v) in sums(conn, &mp.start, &end, &base, &mut missing)? {
            *past.entry(cat).or_default() += v;
        }
    }

    let mut items = Vec::new();
    if counted > 0 {
        let cats = categories::list(conn, true)?;
        let min_diff = MIN_DIFF_UNITS * 10i64.pow(cur.minor_units);
        let total_of = |m: &HashMap<String, i64>, id: &str| -> i64 {
            cats.iter()
                .filter(|c| c.id == id || c.parent_id.as_deref() == Some(id))
                .filter_map(|c| m.get(&c.id))
                .sum()
        };
        for c in cats.iter().filter(|c| c.kind == "expense") {
            let current = total_of(&now, &c.id);
            let usual = total_of(&past, &c.id) / counted;
            if current == 0 && usual == 0 {
                continue;
            }
            let diff = current - usual;
            let percent = (usual > 0).then(|| reports::percent(diff, usual));
            items.push(UsualRow {
                category_id: c.id.clone(),
                parent_id: c.parent_id.clone(),
                name: c.name.clone(),
                current,
                usual,
                diff,
                notable: percent.is_some_and(|p| p.abs() >= MIN_PERCENT) && diff.abs() >= min_diff,
                percent,
            });
        }
        items.sort_by(|a, b| {
            b.diff
                .abs()
                .cmp(&a.diff.abs())
                .then_with(|| a.name.cmp(&b.name))
        });
    }
    let home = items
        .iter()
        .filter(|r| r.notable && r.parent_id.is_none())
        .take(HOME_LIMIT)
        .cloned()
        .collect();
    Ok(UsualReport {
        month: month.to_string(),
        base_currency: base,
        base_symbol: cur.symbol,
        from: p.start,
        to,
        months_counted: counted,
        items,
        home,
        missing_rates: missing,
    })
}

/// Текст строки карточки: «Кафе: 8 400 ₽, на 34 % больше обычного».
pub fn text(r: &UsualRow, symbol: &str, minor_units: u32) -> String {
    let amount = crate::money::format_amount(r.current, minor_units, true);
    match r.percent {
        Some(p) if p >= 0 => format!("{}: {amount} {symbol}, на {p} % больше обычного", r.name),
        Some(p) => format!("{}: {amount} {symbol}, на {} % меньше обычного", r.name, -p),
        None => format!("{}: {amount} {symbol}", r.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 AND kind = 'expense'",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn spend(c: &Connection, card: &str, cat: &str, date: &str, amount: i64) {
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: card.into(),
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

    #[test]
    fn compares_same_days_of_three_previous_months() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let (cafe, lunch, taxi, food) = (
            cat(c, "Кафе и рестораны"),
            cat(c, "Обеды"),
            cat(c, "Такси"),
            cat(c, "Супермаркет"),
        );
        assert!(compare(c, "2026-10", "2026-10-15")
            .unwrap()
            .items
            .is_empty());

        // Июль–сентябрь: кафе по 6 000 до 15-го (и 9 000 после — не в счёт).
        for m in ["07", "08", "09"] {
            spend(c, &card, &cafe, &format!("2026-{m}-05"), 400_000);
            spend(c, &card, &lunch, &format!("2026-{m}-10"), 200_000);
            spend(c, &card, &cafe, &format!("2026-{m}-25"), 900_000);
            spend(c, &card, &taxi, &format!("2026-{m}-07"), 100_000);
            spend(c, &card, &food, &format!("2026-{m}-03"), 2_000_000);
        }
        // Октябрь до 15-го: кафе 8 400 (+40 %), такси 1 500 (+50 %, но разница 500 ₽),
        // продукты 1 200 (−40 %).
        spend(c, &card, &cafe, "2026-10-02", 840_000);
        spend(c, &card, &taxi, "2026-10-03", 150_000);
        spend(c, &card, &food, "2026-10-04", 1_200_000);

        let r = compare(c, "2026-10", "2026-10-15").unwrap();
        assert_eq!(r.months_counted, 3);
        let row = |id: &str| r.items.iter().find(|x| x.category_id == id).unwrap();
        let cafe_row = row(&cafe);
        assert_eq!((cafe_row.current, cafe_row.usual), (840_000, 600_000));
        assert_eq!(cafe_row.percent, Some(40));
        assert!(cafe_row.notable);
        assert!(!row(&taxi).notable, "разница меньше 1 000 ₽");
        let food_row = row(&food);
        assert_eq!((food_row.percent, food_row.notable), (Some(-40), true));
        let home: Vec<&str> = r.home.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(home, ["Продукты", "Кафе и рестораны"]);
        assert_eq!(
            text(cafe_row, "₽", 2),
            "Кафе и рестораны: 8\u{a0}400 ₽, на 40 % больше обычного"
        );
        assert_eq!(
            text(food_row, "₽", 2),
            "Супермаркет: 12\u{a0}000 ₽, на 40 % меньше обычного"
        );
    }

    #[test]
    fn shorter_history_uses_what_there_is() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let cafe = cat(c, "Кафе и рестораны");
        spend(c, &card, &cafe, "2026-09-03", 500_000);
        spend(c, &card, &cafe, "2026-10-03", 1_000_000);
        let r = compare(c, "2026-10", "2026-10-10").unwrap();
        assert_eq!(r.months_counted, 1, "июль и август — до начала учёта");
        assert_eq!(r.items[0].percent, Some(100));
    }
}
