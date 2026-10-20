//! Отчёты. Суммы в основной валюте по курсу на дату операции.
//! Переводы не входят в доходы и расходы; корректировки идут отдельной строкой.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{currencies, Result};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSummary {
    pub base_currency: String,
    pub income: i64,
    pub expense: i64,
    pub adjustments: i64,
    /// Валюты операций, для которых не нашёлся курс (такие операции не вошли).
    pub missing_rates: Vec<String>,
}

pub fn period_summary(conn: &Connection, from: &str, to: &str) -> Result<PeriodSummary> {
    let base = currencies::base_currency(conn)?;
    let mut out = PeriodSummary {
        base_currency: base.clone(),
        ..Default::default()
    };
    let mut stmt = conn.prepare(
        "SELECT t.type, t.date, t.amount, a.currency_code FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type IN ('income', 'expense', 'adjustment')
           AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (kind, date, amount, currency) = row?;
        let Some(v) = currencies::convert(conn, amount, &currency, &base, &date)? else {
            if !out.missing_rates.contains(&currency) {
                out.missing_rates.push(currency);
            }
            continue;
        };
        match kind.as_str() {
            "income" => out.income += v,
            "expense" => out.expense += v,
            _ => out.adjustments += v,
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};
    use crate::{categories, currencies};

    #[test]
    fn summary_in_base_currency_by_operation_date() {
        // Сценарий «Покупка в поездке»: 45 € в рублях по курсу на день покупки.
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let cat = |n: &str| -> String {
            c.query_row("SELECT id FROM categories WHERE name = ?1", [n], |r| {
                r.get(0)
            })
            .unwrap()
        };
        let rub = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let eur = accounts::create(c, &input("Евро-карта", "debit", "EUR", 50_000)).unwrap();
        let usd = accounts::create(c, &input("USD", "cash", "USD", 0)).unwrap();
        currencies::set_rate(c, "2026-10-01", "EUR", "RUB", "100").unwrap();
        currencies::set_rate(c, "2026-10-10", "EUR", "RUB", "101").unwrap();
        let t = |kind: &str, date: &str, acc: &str, amount: i64, category: &str| TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: acc.into(),
            amount,
            category_id: Some(cat(category)),
            to_account_id: None,
            to_amount: None,
            payee: None,
            note: None,
        };
        transactions::create(c, &t("expense", "2026-10-05", &eur, 4_500, "Путешествия")).unwrap();
        transactions::create(c, &t("expense", "2026-10-12", &eur, 1_000, "Путешествия")).unwrap();
        transactions::create(c, &t("income", "2026-10-05", &rub, 8_500_000, "Зарплата")).unwrap();
        transactions::create(c, &t("income", "2026-10-05", &usd, 1_000, "Подработка")).unwrap();
        accounts::adjust_balance(c, &rub, 8_400_000, "2026-10-20", None).unwrap();

        let s = period_summary(c, "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(s.expense, 450_000 + 101_000);
        assert_eq!(s.income, 8_500_000);
        assert_eq!(s.adjustments, -100_000);
        assert_eq!(s.missing_rates, ["USD"]);
    }
}
