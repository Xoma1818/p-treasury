//! Запас и стоимость денег: финансовая подушка и курсовая разница по счетам
//! в валюте. Всё считается из счетов и операций, ничего не хранится.

use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::money::Rate;
use crate::{accounts, budgets, currencies, reports, settings, Result};

/// Типы счетов, деньги на которых можно быстро потратить.
const LIQUID_TYPES: &[&str] = &["cash", "debit", "savings"];

/// Сколько полных месяцев брать для средних расходов.
const CUSHION_MONTHS: i32 = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cushion {
    pub base_currency: String,
    pub base_symbol: String,
    /// Наличные, карты и вклады «в общем балансе» в основной валюте.
    pub liquid: i64,
    /// Средние расходы в месяц; `None`, если прошлых месяцев с расходами нет.
    pub avg_monthly_expense: Option<i64>,
    /// На сколько месяцев хватит денег, в десятых (42 = 4,2 месяца).
    pub months_tenths: Option<i64>,
    /// Сколько прошлых месяцев вошло в среднее.
    pub months_counted: i64,
    /// Цель в месяцах из настройки `cushion_goal_months`.
    pub goal_months: i64,
    pub missing_rates: Vec<String>,
}

/// Первая дата учёта: самая ранняя операция дохода или расхода.
fn first_activity(conn: &Connection) -> Result<Option<String>> {
    Ok(conn.query_row(
        "SELECT min(date) FROM transactions WHERE type IN ('expense', 'income') AND status = 'cleared'",
        [],
        |r| r.get(0),
    )?)
}

/// Финансовая подушка: деньги на счетах, делённые на средние расходы за
/// последние полные месяцы (месяцы до начала учёта не считаются).
pub fn cushion(conn: &Connection, today: &str) -> Result<Cushion> {
    let base = currencies::base_currency(conn)?;
    let base_symbol = currencies::get(conn, &base)?.symbol;
    let mut liquid = 0i64;
    let mut missing_rates = Vec::new();
    for a in accounts::list(conn, false)?
        .into_iter()
        .filter(|a| a.include_in_total && LIQUID_TYPES.contains(&a.kind.as_str()))
    {
        let bal = accounts::balance(conn, &a.id, Some(today))?;
        match currencies::convert(conn, bal, &a.currency_code, &base, today)? {
            Some(v) => liquid += v,
            None if !missing_rates.contains(&a.currency_code) => {
                missing_rates.push(a.currency_code)
            }
            None => {}
        }
    }

    let current = budgets::month_of(conn, today)?.month;
    let sd = budgets::start_day(conn)?;
    let first = first_activity(conn)?;
    let (mut total, mut counted) = (0i64, 0i64);
    if let Some(first) = &first {
        for i in 1..=CUSHION_MONTHS {
            let p = budgets::period(&budgets::shift_month(&current, -i)?, sd)?;
            if p.end.as_str() < first.as_str() {
                continue;
            }
            let s = reports::period_summary(conn, &p.start, &p.end)?;
            for c in s.missing_rates {
                if !missing_rates.contains(&c) {
                    missing_rates.push(c);
                }
            }
            total += s.expense;
            counted += 1;
        }
    }
    let avg = (counted > 0 && total > 0).then(|| total / counted);
    let goal_months = settings::get(conn, "cushion_goal_months")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(6);
    Ok(Cushion {
        base_currency: base,
        base_symbol,
        months_tenths: avg.map(|a| (liquid.max(0) as i128 * 10 / a as i128) as i64),
        liquid,
        avg_monthly_expense: avg,
        months_counted: counted,
        goal_months,
        missing_rates,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxRow {
    pub account_id: String,
    pub name: String,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    /// Остаток в валюте счёта накануне начала периода и в последний день.
    pub start_balance: i64,
    pub end_balance: i64,
    /// Курс в первый и последний день периода (для подписи).
    pub start_rate: Option<String>,
    pub end_rate: Option<String>,
    /// Курсовая разница в основной валюте: изменение стоимости остатка без
    /// учёта пополнений и списаний. `None`, если нет курса на нужную дату.
    pub gain: Option<i64>,
    /// Средний курс покупки валюты переводами из основной валюты за период.
    pub avg_buy_rate: Option<String>,
    pub bought: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxReport {
    pub base_currency: String,
    pub base_symbol: String,
    pub rows: Vec<FxRow>,
    pub total_gain: i64,
    pub missing_rates: Vec<String>,
}

/// Остаток счёта на дату с поправкой на дату открытия, как в отчёте «Остатки».
fn value_at(conn: &Connection, a: &accounts::Account, date: &str) -> Result<i64> {
    let mut bal = accounts::balance(conn, &a.id, Some(date))?;
    if a.opening_date.as_str() > date {
        bal -= a.opening_balance;
    }
    Ok(bal)
}

/// Курсовая разница за период по каждому счёту в валюте, отличной от основной:
/// `остаток в конце × курс в конце − остаток в начале × курс в начале −
/// Σ движений × курс на дату движения`.
pub fn fx_gain(conn: &Connection, from: &str, to: &str) -> Result<FxReport> {
    crate::time::check_date(from)?;
    crate::time::check_date(to)?;
    let base = currencies::base_currency(conn)?;
    let base_symbol = currencies::get(conn, &base)?.symbol;
    let base_minor = currencies::minor_units(conn, &base)?;
    let before = (NaiveDate::parse_from_str(from, "%Y-%m-%d").expect("проверено")
        - Duration::days(1))
    .to_string();
    let mut rows = Vec::new();
    let mut total_gain = 0;
    let mut missing_rates = Vec::new();
    for a in accounts::list(conn, true)?
        .into_iter()
        .filter(|a| a.currency_code != base)
    {
        let start_balance = value_at(conn, &a, &before)?;
        let end_balance = value_at(conn, &a, to)?;
        // Движения периода в валюте счёта: (дата, сумма со знаком).
        let mut flows: Vec<(String, i64)> = Vec::new();
        if a.opening_date.as_str() >= from && a.opening_date.as_str() <= to {
            flows.push((a.opening_date.clone(), a.opening_balance));
        }
        let mut stmt = conn.prepare(
            "SELECT date, CASE WHEN account_id = ?1 THEN
                        CASE type WHEN 'income' THEN amount WHEN 'adjustment' THEN amount ELSE -amount END
                    ELSE to_amount END
             FROM transactions
             WHERE status = 'cleared' AND date BETWEEN ?2 AND ?3
               AND (account_id = ?1 OR (to_account_id = ?1 AND type = 'transfer'))",
        )?;
        let rows_iter = stmt.query_map(params![a.id, from, to], |r| Ok((r.get(0)?, r.get(1)?)))?;
        for f in rows_iter {
            flows.push(f?);
        }
        if start_balance == 0 && end_balance == 0 && flows.is_empty() {
            continue;
        }
        let conv = |amount: i64, date: &str| currencies::convert(conn, amount, &a.currency_code, &base, date);
        let mut gain = Some(0i64);
        for (amount, date) in [(end_balance, to), (-start_balance, before.as_str())] {
            if amount != 0 {
                gain = gain.zip(conv(amount, date)?).map(|(g, v)| g + v);
            }
        }
        for (date, amount) in &flows {
            gain = gain.zip(conv(*amount, date)?).map(|(g, v)| g - v);
        }
        match gain {
            Some(g) => total_gain += g,
            None if !missing_rates.contains(&a.currency_code) => {
                missing_rates.push(a.currency_code.clone())
            }
            None => {}
        }
        // Покупки валюты: переводы на этот счёт со счетов в основной валюте.
        let (paid, bought): (i64, i64) = conn.query_row(
            "SELECT COALESCE(sum(t.amount), 0), COALESCE(sum(t.to_amount), 0)
             FROM transactions t JOIN accounts s ON s.id = t.account_id
             WHERE t.type = 'transfer' AND t.status = 'cleared' AND t.to_account_id = ?1
               AND s.currency_code = ?2 AND t.date BETWEEN ?3 AND ?4",
            params![a.id, base, from, to],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        rows.push(FxRow {
            start_rate: currencies::rate_on(conn, &a.currency_code, &base, from)?,
            end_rate: currencies::rate_on(conn, &a.currency_code, &base, to)?,
            avg_buy_rate: Rate::from_amounts(bought, a.minor_units, paid, base_minor)
                .map(|r| r.to_string()),
            bought,
            account_id: a.id,
            name: a.name,
            currency_code: a.currency_code,
            currency_symbol: a.currency_symbol,
            minor_units: a.minor_units,
            start_balance,
            end_balance,
            gain,
        });
    }
    Ok(FxReport {
        base_currency: base,
        base_symbol,
        rows,
        total_gain,
        missing_rates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};
    use crate::{categories, currencies};

    fn txn(kind: &str, date: &str, account: &str, amount: i64) -> TxnInput {
        TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: account.into(),
            amount,
            category_id: None,
            to_account_id: None,
            to_amount: None,
            payee: None,
            note: None,
        }
    }

    fn category(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn cushion_months_from_average_expense() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let mut card = input("Карта", "debit", "RUB", 0);
        card.opening_date = "2026-01-01".into();
        let card = accounts::create(c, &card).unwrap();
        let mut credit = input("Кредитка", "credit", "RUB", -5_000_000);
        credit.opening_date = "2026-01-01".into();
        accounts::create(c, &credit).unwrap();
        let empty = cushion(c, "2026-10-20").unwrap();
        assert_eq!((empty.avg_monthly_expense, empty.months_tenths), (None, None));
        assert_eq!(empty.goal_months, 6);

        let food = category(c, "Продукты");
        let salary = category(c, "Зарплата");
        let mut income = txn("income", "2026-08-01", &card, 50_000_000);
        income.category_id = Some(salary);
        transactions::create(c, &income).unwrap();
        // Август 30 000 ₽, сентябрь 50 000 ₽, октябрь (текущий) не считается.
        for (date, amount) in [("2026-08-10", 3_000_000), ("2026-09-10", 5_000_000), ("2026-10-10", 9_000_000)] {
            let mut t = txn("expense", date, &card, amount);
            t.category_id = Some(food.clone());
            transactions::create(c, &t).unwrap();
        }
        let k = cushion(c, "2026-10-20").unwrap();
        // На карте 500 000 − 170 000 = 330 000 ₽, кредитка не входит.
        assert_eq!(k.liquid, 33_000_000);
        assert_eq!(k.months_counted, 2);
        assert_eq!(k.avg_monthly_expense, Some(4_000_000));
        assert_eq!(k.months_tenths, Some(82));
        settings::set(c, "cushion_goal_months", "3").unwrap();
        assert_eq!(cushion(c, "2026-10-20").unwrap().goal_months, 3);
    }

    #[test]
    fn fx_gain_excludes_deposits_and_finds_buy_rate() {
        // Купил 1 000 $ по 92, курс вырос до 95: курсовая разница +3 000 ₽.
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let mut rub = input("Карта", "debit", "RUB", 50_000_000);
        rub.opening_date = "2026-01-01".into();
        let rub = accounts::create(c, &rub).unwrap();
        let mut usd = input("Доллары", "savings", "USD", 50_000);
        usd.opening_date = "2026-01-01".into();
        let usd = accounts::create(c, &usd).unwrap();
        currencies::set_rate(c, "2026-09-30", "USD", "RUB", "90").unwrap();
        currencies::set_rate(c, "2026-10-05", "USD", "RUB", "92").unwrap();
        currencies::set_rate(c, "2026-10-31", "USD", "RUB", "95").unwrap();
        let mut buy = txn("transfer", "2026-10-05", &rub, 9_200_000);
        buy.to_account_id = Some(usd.clone());
        buy.to_amount = Some(100_000);
        transactions::create(c, &buy).unwrap();

        let r = fx_gain(c, "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(r.rows.len(), 1, "рублёвый счёт не показывается");
        let row = &r.rows[0];
        assert_eq!((row.start_balance, row.end_balance), (50_000, 150_000));
        // 1 500 × 95 − 500 × 90 − 1 000 × 92 = 142 500 − 45 000 − 92 000 = 5 500 ₽.
        assert_eq!(row.gain, Some(550_000));
        assert_eq!(r.total_gain, 550_000);
        assert_eq!(row.avg_buy_rate.as_deref(), Some("92"));
        assert_eq!(row.bought, 100_000);

        // Без курса на начало разница не считается.
        let none = fx_gain(c, "2026-09-01", "2026-09-29").unwrap();
        assert_eq!(none.rows[0].gain, None);
        assert_eq!(none.missing_rates, vec!["USD".to_string()]);
    }
}
