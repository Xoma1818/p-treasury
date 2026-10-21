//! «Итоги года»: главное о годе в нескольких цифрах — сколько заработано и
//! потрачено, лучший и самый дорогой месяц, куда ушло больше всего, самая
//! крупная покупка, любимый магазин и дни без трат.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::invalid;
use crate::reports::{self, CategoryItem, MonthRow};
use crate::{currencies, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub date: String,
    pub amount: i64,
    pub payee: Option<String>,
    pub category_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopPayee {
    pub name: String,
    pub count: i64,
    pub amount: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearReview {
    pub year: i32,
    pub base_currency: String,
    pub income: i64,
    pub expense: i64,
    pub savings_rate: Option<i64>,
    /// Тот же отрезок прошлого года (для сравнения).
    pub prev_income: i64,
    pub prev_expense: i64,
    pub months: Vec<MonthRow>,
    /// Месяц, когда больше всего осталось (доходы − расходы).
    pub best_month: Option<String>,
    /// Месяц с самыми большими расходами.
    pub costliest_month: Option<String>,
    pub top_categories: Vec<CategoryItem>,
    pub biggest_purchase: Option<Purchase>,
    pub top_payee: Option<TopPayee>,
    /// Сколько дней года (с первой записи и по сегодня) прошло без расходов.
    pub no_spend_days: i64,
    pub days: i64,
    pub transaction_count: i64,
    pub missing_rates: Vec<String>,
}

/// Итоги года `year` на дату `today`: текущий год считается по сегодня.
pub fn review(conn: &Connection, year: i32, today: &str) -> Result<YearReview> {
    if !(1900..=2200).contains(&year) {
        return invalid(format!("некорректный год: {year}"));
    }
    let from = format!("{year}-01-01");
    let year_end = format!("{year}-12-31");
    let to = if today < year_end.as_str() {
        today.to_string()
    } else {
        year_end
    };
    if to < from {
        return invalid(format!("{year} год ещё не начался"));
    }
    let base = currencies::base_currency(conn)?;
    let sum = reports::period_summary(conn, &from, &to)?;
    let prev = reports::period_summary(
        conn,
        &format!("{}-01-01", year - 1),
        &format!("{}{}", year - 1, &to[4..]),
    )?;
    let last_month = &to[..7];
    let months = reports::by_month(conn, &format!("{year}-01"), last_month)?.months;
    let with_data = months.iter().filter(|m| m.income != 0 || m.expense != 0);
    let best_month = with_data
        .clone()
        .max_by_key(|m| m.balance)
        .map(|m| m.period.month.clone());
    let costliest_month = with_data
        .max_by_key(|m| m.expense)
        .filter(|m| m.expense > 0)
        .map(|m| m.period.month.clone());
    let mut top_categories = reports::by_category(conn, "expense", &from, &to)?.items;
    top_categories.truncate(5);

    let mut stmt = conn.prepare(
        "SELECT t.date, t.amount, a.currency_code, trim(coalesce(t.payee, '')), c.name
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'cleared' AND t.type = 'expense' AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut biggest: Option<Purchase> = None;
    let mut payees: HashMap<String, TopPayee> = HashMap::new();
    let mut spend_days: HashSet<String> = HashSet::new();
    for row in rows {
        let (date, amount, cur, payee, category) = row?;
        spend_days.insert(date.clone());
        let Some(v) = currencies::convert(conn, amount, &cur, &base, &date)? else {
            continue;
        };
        if !payee.is_empty() {
            let p = payees
                .entry(payee.to_lowercase())
                .or_insert_with(|| TopPayee {
                    name: payee.clone(),
                    count: 0,
                    amount: 0,
                });
            p.count += 1;
            p.amount += v;
        }
        if biggest.as_ref().is_none_or(|b| v > b.amount) {
            biggest = Some(Purchase {
                date,
                amount: v,
                payee: (!payee.is_empty()).then_some(payee),
                category_name: category,
            });
        }
    }
    let top_payee = payees
        .into_values()
        .max_by(|a, b| a.count.cmp(&b.count).then(a.amount.cmp(&b.amount)));
    // Дни считаются с первой записи: до неё приложением ещё не пользовались.
    let first: Option<String> =
        conn.query_row("SELECT min(date) FROM transactions", [], |r| r.get(0))?;
    let start = first
        .filter(|f| f.as_str() > from.as_str())
        .unwrap_or(from.clone());
    let days =
        ((crate::time::parse_date(&to)? - crate::time::parse_date(&start)?).num_days() + 1).max(0);
    let transaction_count: i64 = conn.query_row(
        "SELECT count(*) FROM transactions WHERE status = 'cleared'
           AND type IN ('income', 'expense', 'transfer') AND date BETWEEN ?1 AND ?2",
        params![from, to],
        |r| r.get(0),
    )?;
    Ok(YearReview {
        year,
        base_currency: base,
        income: sum.income,
        expense: sum.expense,
        savings_rate: sum.savings_rate,
        prev_income: prev.income,
        prev_expense: prev.expense,
        months,
        best_month,
        costliest_month,
        top_categories,
        biggest_purchase: biggest,
        top_payee,
        no_spend_days: days - spend_days.len() as i64,
        days,
        transaction_count,
        missing_rates: sum.missing_rates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, AccountInput};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn add(c: &Connection, acc: &str, kind: &str, cat: &str, date: &str, amount: i64, payee: &str) {
        transactions::create(
            c,
            &TxnInput {
                kind: kind.into(),
                date: date.into(),
                account_id: acc.into(),
                amount,
                category_id: Some(cat.into()),
                to_account_id: None,
                to_amount: None,
                payee: (!payee.is_empty()).then(|| payee.into()),
                note: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn year_in_numbers() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        for (id, name, kind) in [
            ("food", "Продукты", "expense"),
            ("tech", "Техника", "expense"),
            ("pay", "Зарплата", "income"),
        ] {
            c.execute(
                "INSERT INTO categories (id, name, kind, created_at, updated_at) VALUES (?1, ?2, ?3, '', '')",
                params![id, name, kind],
            )
            .unwrap();
        }
        let acc = accounts::create(
            c,
            &AccountInput {
                name: "Карта".into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 0,
                opening_date: "2025-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap();
        add(c, &acc, "income", "pay", "2025-03-01", 5_000_000, "");
        add(c, &acc, "income", "pay", "2026-01-10", 10_000_000, "");
        add(c, &acc, "income", "pay", "2026-02-10", 10_000_000, "");
        add(
            c,
            &acc,
            "expense",
            "food",
            "2026-01-11",
            300_000,
            "Пятёрочка",
        );
        add(
            c,
            &acc,
            "expense",
            "food",
            "2026-01-12",
            200_000,
            "пятёрочка",
        );
        add(
            c,
            &acc,
            "expense",
            "tech",
            "2026-02-15",
            4_500_000,
            "М.Видео",
        );

        let r = review(c, 2026, "2026-02-28").unwrap();
        assert_eq!(
            (r.income, r.expense, r.savings_rate),
            (20_000_000, 5_000_000, Some(75))
        );
        assert_eq!(
            (r.prev_income, r.prev_expense),
            (0, 0),
            "март прошлого года не входит"
        );
        assert_eq!(r.months.len(), 2);
        assert_eq!(r.best_month.as_deref(), Some("2026-01"));
        assert_eq!(r.costliest_month.as_deref(), Some("2026-02"));
        assert_eq!(r.top_categories[0].name, "Техника");
        let big = r.biggest_purchase.unwrap();
        assert_eq!(
            (big.date.as_str(), big.amount, big.payee.as_deref()),
            ("2026-02-15", 4_500_000, Some("М.Видео"))
        );
        let top = r.top_payee.unwrap();
        assert_eq!((top.count, top.amount), (2, 500_000));
        assert_eq!((r.days, r.no_spend_days, r.transaction_count), (59, 56, 5));

        assert!(review(c, 2027, "2026-02-28").is_err());
        let full = review(c, 2025, "2026-02-28").unwrap();
        // Первая запись 1 марта: дни года считаются с неё.
        assert_eq!((full.days, full.income), (306, 5_000_000));
    }
}
