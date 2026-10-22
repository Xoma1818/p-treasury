//! Чистые активы по месяцам (В3): значение на конец каждого бюджетного месяца.
//! Деньги на счетах «в общем балансе», инвестиции по последней оценке не позже
//! конца месяца, имущество по оценке на ту дату, плюс «мне должны», минус
//! «я должен». Всё в основной валюте по курсу на конец месяца.
//!
//! Остаток долга на дату читается здесь по служебному счёту долга (его баланс
//! равен остатку со знаком), модуль долгов не меняется.

use rusqlite::Connection;
use serde::Serialize;

use crate::{accounts, assets, budgets, currencies, invest, time, Result};

/// Больше стольких месяцев график не строится (20 лет).
pub const MAX_MONTHS: usize = 240;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub month: String,
    /// Дата значения: конец месяца, у текущего — сегодня.
    pub date: String,
    /// Деньги: счета «в общем балансе», кроме брокерских.
    pub cash: i64,
    /// Брокерские счета и ИИС по последней оценке.
    pub investments: i64,
    pub assets: i64,
    pub owed_to_me: i64,
    pub i_owe: i64,
    /// cash + investments + assets + owed_to_me − i_owe.
    pub net: i64,
    /// Изменение к прошлому месяцу; у первой точки `None`.
    pub change: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub base_currency: String,
    pub base_symbol: String,
    pub points: Vec<Point>,
    pub missing_rates: Vec<String>,
}

fn miss(missing: &mut Vec<String>, c: &str) {
    if !missing.iter().any(|m| m == c) {
        missing.push(c.to_string());
    }
}

/// Самая ранняя дата учёта: открытие счёта, операция, оценка имущества, долг.
fn first_date(conn: &Connection) -> Result<Option<String>> {
    Ok(conn.query_row(
        "SELECT min(d) FROM (
            SELECT min(opening_date) AS d FROM accounts
            UNION ALL SELECT min(date) FROM transactions
            UNION ALL SELECT min(date) FROM asset_values
            UNION ALL SELECT min(issue_date) FROM debts)",
        [],
        |r| r.get(0),
    )?)
}

/// Значение на дату `on` (без поля `change`).
pub fn on_date(conn: &Connection, on: &str, missing: &mut Vec<String>) -> Result<Point> {
    let base = currencies::base_currency(conn)?;
    let mut p = Point {
        date: on.to_string(),
        ..Default::default()
    };
    for a in accounts::list(conn, true)?
        .into_iter()
        .filter(|a| a.include_in_total)
    {
        if a.opening_date.as_str() > on {
            continue;
        }
        let investment = a.kind == "investment";
        let value = if investment {
            invest::value_on(conn, &a.id, on)?.0
        } else {
            accounts::balance(conn, &a.id, Some(on))?
        };
        if value == 0 {
            continue;
        }
        match currencies::convert(conn, value, &a.currency_code, &base, on)? {
            Some(v) if investment => p.investments += v,
            Some(v) => p.cash += v,
            None => miss(missing, &a.currency_code),
        }
    }
    let (assets_value, assets_missing) = assets::total(conn, on)?;
    p.assets = assets_value;
    for c in assets_missing {
        miss(missing, &c);
    }
    let mut stmt = conn.prepare(
        "SELECT d.account_id, d.direction, d.currency_code FROM debts d WHERE d.issue_date <= ?1",
    )?;
    let debts: Vec<(String, String, String)> = stmt
        .query_map([on], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (account, direction, currency) in debts {
        // Баланс служебного счёта: «я дал» — плюс, «я взял» — минус.
        let balance = accounts::balance(conn, &account, Some(on))?;
        let left = if direction == "lent" {
            balance
        } else {
            -balance
        }
        .max(0);
        if left == 0 {
            continue;
        }
        match currencies::convert(conn, left, &currency, &base, on)? {
            Some(v) if direction == "lent" => p.owed_to_me += v,
            Some(v) => p.i_owe += v,
            None => miss(missing, &currency),
        }
    }
    p.net = p.cash + p.investments + p.assets + p.owed_to_me - p.i_owe;
    Ok(p)
}

/// Ряд за последние `months` месяцев по текущий (`None` — за всё время учёта).
pub fn history(conn: &Connection, today: &str, months: Option<u32>) -> Result<History> {
    time::check_date(today)?;
    let base = currencies::base_currency(conn)?;
    let base_symbol = currencies::get(conn, &base)?.symbol;
    let sd = budgets::start_day(conn)?;
    let current = budgets::month_of(conn, today)?.month;
    let first_month = match months {
        Some(n) => budgets::shift_month(&current, 1 - n.clamp(1, MAX_MONTHS as u32) as i32)?,
        None => match first_date(conn)? {
            Some(d) if d.as_str() < today => budgets::month_of(conn, &d)?.month,
            _ => current.clone(),
        },
    };
    let mut points: Vec<Point> = Vec::new();
    let mut missing = Vec::new();
    let mut month = first_month;
    loop {
        let p = budgets::period(&month, sd)?;
        let on = if p.end.as_str() > today {
            today.to_string()
        } else {
            p.end
        };
        let mut point = on_date(conn, &on, &mut missing)?;
        point.month = month.clone();
        point.change = points.last().map(|prev| point.net - prev.net);
        points.push(point);
        if month >= current || points.len() >= MAX_MONTHS {
            break;
        }
        month = budgets::shift_month(&month, 1)?;
    }
    Ok(History {
        base_currency: base,
        base_symbol,
        points,
        missing_rates: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::assets::AssetInput;
    use crate::debts::{self, DebtInput};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    #[test]
    fn month_end_values_with_investments_assets_and_debts() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let c = db.conn();
        let mut card_in = input("Карта", "debit", "RUB", 10_000_000);
        card_in.opening_date = "2026-07-01".into();
        let card = accounts::create(c, &card_in).unwrap();
        let mut usd_in = input("Доллары", "cash", "USD", 100_000);
        usd_in.opening_date = "2026-08-15".into();
        accounts::create(c, &usd_in).unwrap();
        currencies::set_rate(c, "2026-08-01", "USD", "RUB", "90").unwrap();
        currencies::set_rate(c, "2026-09-30", "USD", "RUB", "95").unwrap();
        let mut iis_in = input("ИИС", "investment", "RUB", 5_000_000);
        iis_in.opening_date = "2026-07-01".into();
        let iis = accounts::create(c, &iis_in).unwrap();
        invest::set_value(c, &iis, "2026-08-31", 5_500_000).unwrap();
        let food: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Супермаркет'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: "2026-08-10".into(),
                account_id: card.clone(),
                amount: 1_000_000,
                category_id: Some(food),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
        let flat = assets::create(
            c,
            &AssetInput {
                name: "Квартира".into(),
                kind: "realty".into(),
                currency_code: "RUB".into(),
                value: 900_000_000,
                date: "2026-07-01".into(),
                note: None,
            },
        )
        .unwrap();
        assets::set_value(c, &flat, "2026-09-15", 950_000_000).unwrap();
        debts::create(
            db.conn_mut(),
            &DebtInput {
                direction: "lent".into(),
                counterparty: "Иван".into(),
                note: None,
                currency_code: "RUB".into(),
                principal: 2_000_000,
                issue_date: "2026-09-05".into(),
                rate_bp: 0,
                repayment_type: "bullet".into(),
                term_months: None,
                first_payment_date: None,
                maturity_date: Some("2027-01-01".into()),
                account_id: Some(card.clone()),
            },
        )
        .unwrap();
        debts::create(
            db.conn_mut(),
            &DebtInput {
                direction: "borrowed".into(),
                counterparty: "Банк".into(),
                note: None,
                currency_code: "RUB".into(),
                principal: 30_000_000,
                issue_date: "2026-10-05".into(),
                rate_bp: 0,
                repayment_type: "bullet".into(),
                term_months: None,
                first_payment_date: None,
                maturity_date: Some("2027-10-05".into()),
                account_id: None,
            },
        )
        .unwrap();

        let h = history(db.conn(), "2026-10-20", Some(4)).unwrap();
        let months: Vec<&str> = h.points.iter().map(|p| p.month.as_str()).collect();
        assert_eq!(months, ["2026-07", "2026-08", "2026-09", "2026-10"]);
        let jul = &h.points[0];
        assert_eq!(
            (jul.cash, jul.investments, jul.assets, jul.net, jul.change),
            (10_000_000, 5_000_000, 900_000_000, 915_000_000, None),
            "доллары ещё не открыты"
        );
        let aug = &h.points[1];
        assert_eq!(aug.cash, 9_000_000 + 9_000_000);
        assert_eq!(aug.investments, 5_500_000, "по оценке на 31.08");
        assert_eq!(aug.change, Some(aug.net - jul.net));
        let sep = &h.points[2];
        assert_eq!(sep.date, "2026-09-30");
        assert_eq!(sep.cash, 7_000_000 + 9_500_000, "курс на конец месяца");
        assert_eq!(
            (sep.assets, sep.owed_to_me, sep.i_owe),
            (950_000_000, 2_000_000, 0)
        );
        let oct = &h.points[3];
        assert_eq!(oct.date, "2026-10-20", "текущий месяц — на сегодня");
        assert_eq!(oct.i_owe, 30_000_000);
        // Сегодняшняя точка совпадает со сводкой «Долгов».
        let s = debts::summary(db.conn(), "2026-10-20", 0).unwrap();
        assert_eq!(oct.net, s.net_worth);

        let all = history(db.conn(), "2026-10-20", None).unwrap();
        assert_eq!(all.points.len(), 4, "всё время — с июля");
    }
}
