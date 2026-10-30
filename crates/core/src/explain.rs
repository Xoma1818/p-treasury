//! «Как посчитано» (0.23): из чего сложились итоговые суммы Главной — общий
//! баланс по счетам и доходы/расходы месяца по категориям, и что не вошло.
//! Считается теми же правилами, что [`accounts::totals`] и
//! [`reports::period_summary`], поэтому строки в сумме дают ровно итог.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::invalid;
use crate::{accounts, currencies, Result};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPart {
    pub id: String,
    pub name: String,
    pub currency: String,
    /// В валюте счёта (у брокерского — оценка).
    pub balance: i64,
    /// В основной валюте; `None` — нет курса.
    pub converted: Option<i64>,
    /// `in` — вошёл в итог, `excluded` — «не учитывать в общем балансе»,
    /// `no_rate` — нет курса валюты на эту дату.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceExplain {
    pub base_currency: String,
    pub total: i64,
    pub accounts: Vec<AccountPart>,
}

pub fn balance(conn: &Connection, on: &str) -> Result<BalanceExplain> {
    let base = currencies::base_currency(conn)?;
    let mut out = BalanceExplain {
        base_currency: base.clone(),
        total: 0,
        accounts: Vec::new(),
    };
    for a in accounts::list(conn, false)? {
        let bal = if a.kind == "investment" {
            crate::invest::value_on(conn, &a.id, on)?.0
        } else {
            accounts::balance(conn, &a.id, Some(on))?
        };
        let converted = currencies::convert(conn, bal, &a.currency_code, &base, on)?;
        let status = match (a.include_in_total, converted) {
            (false, _) => "excluded",
            (true, None) => "no_rate",
            (true, Some(v)) => {
                out.total += v;
                "in"
            }
        };
        out.accounts.push(AccountPart {
            id: a.id,
            name: a.name,
            currency: a.currency_code,
            balance: bal,
            converted,
            status: status.into(),
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPart {
    pub category_id: String,
    /// «Родитель / Категория» у подкатегории.
    pub name: String,
    pub amount: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodExplain {
    pub base_currency: String,
    pub total: i64,
    /// По убыванию суммы.
    pub categories: Vec<CategoryPart>,
    pub count: i64,
    /// Части трат «по месяцам», пришедшиеся на этот период.
    pub spread_parts: i64,
    pub spread_amount: i64,
    /// Части разбитых чеков (каждая — в своей категории).
    pub split_parts: i64,
    /// Не вошли: валюты без курса.
    pub missing_rates: Vec<String>,
    /// Не вошли: запланированные операции этого типа.
    pub planned: i64,
    /// Не вошли: переводы между своими счетами.
    pub transfers: i64,
    /// Не вошли: корректировки баланса (сверка), со знаком.
    pub adjustments: i64,
}

/// Доходы (`income`) или расходы (`expense`) за период по категориям.
pub fn period(conn: &Connection, from: &str, to: &str, kind: &str) -> Result<PeriodExplain> {
    if kind != "income" && kind != "expense" {
        return invalid("объяснить можно доходы или расходы");
    }
    let base = currencies::base_currency(conn)?;
    let mut out = PeriodExplain {
        base_currency: base.clone(),
        ..Default::default()
    };
    let mut stmt = conn.prepare(
        "SELECT t.type, t.status, t.date, t.amount, a.currency_code, t.category_id,
                coalesce(p.name || ' / ', '') || coalesce(c.name, ''), t.spread_months IS NOT NULL,
                t.split_id IS NOT NULL
         FROM txn_by_month t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         WHERE t.date BETWEEN ?1 AND ?2",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, bool>(7)?,
            r.get::<_, bool>(8)?,
        ))
    })?;
    let mut by_cat: BTreeMap<String, CategoryPart> = BTreeMap::new();
    for row in rows {
        let (t, status, date, amount, currency, cat, name, spread, split) = row?;
        match t.as_str() {
            "transfer" => {
                if status == "cleared" {
                    out.transfers += 1;
                }
                continue;
            }
            "adjustment" => {
                if status == "cleared" {
                    if let Some(v) = currencies::convert(conn, amount, &currency, &base, &date)? {
                        out.adjustments += v;
                    }
                }
                continue;
            }
            k if k != kind => continue,
            _ => {}
        }
        if status != "cleared" {
            out.planned += 1;
            continue;
        }
        let Some(v) = currencies::convert(conn, amount, &currency, &base, &date)? else {
            if !out.missing_rates.contains(&currency) {
                out.missing_rates.push(currency);
            }
            continue;
        };
        out.total += v;
        out.count += 1;
        if spread {
            out.spread_parts += 1;
            out.spread_amount += v;
        }
        if split {
            out.split_parts += 1;
        }
        let id = cat.unwrap_or_default();
        let part = by_cat.entry(id.clone()).or_insert(CategoryPart {
            category_id: id,
            name,
            amount: 0,
            count: 0,
        });
        part.amount += v;
        part.count += 1;
    }
    out.categories = by_cat.into_values().collect();
    out.categories
        .sort_by(|a, b| b.amount.cmp(&a.amount).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{create, AccountInput};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn acc(c: &Connection, name: &str, cur: &str, total: bool) -> String {
        create(
            c,
            &AccountInput {
                name: name.into(),
                kind: "debit".into(),
                currency_code: cur.into(),
                opening_balance: 1_000_000,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: total,
                invest_kind: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn parts_add_up_to_home_totals() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = acc(c, "Карта", "RUB", true);
        let save = acc(c, "Копилка", "RUB", false);
        acc(c, "Доллары", "USD", true);
        let cat = |n: &str| -> String {
            c.query_row("SELECT id FROM categories WHERE name = ?1", [n], |r| {
                r.get(0)
            })
            .unwrap()
        };
        let t = |kind: &str, amount: i64, category: Option<String>, date: &str| {
            transactions::create(
                c,
                &TxnInput {
                    kind: kind.into(),
                    date: date.into(),
                    account_id: card.clone(),
                    amount,
                    category_id: category,
                    to_account_id: (kind == "transfer").then(|| save.clone()),
                    to_amount: (kind == "transfer").then_some(amount),
                    payee: None,
                    note: None,
                },
            )
            .unwrap()
        };
        t("expense", 30_000, Some(cat("Продукты")), "2026-10-03");
        t("expense", 20_000, Some(cat("Продукты")), "2026-10-04");
        t("expense", 10_000, Some(cat("Такси")), "2026-10-05");
        t("income", 500_000, Some(cat("Зарплата")), "2026-10-05");
        t("transfer", 100_000, None, "2026-10-06");
        let tv = t(
            "expense",
            120_000,
            Some(cat("Прочие расходы")),
            "2026-09-20",
        );
        transactions::set_spread(c, &tv, Some(3)).unwrap();

        let e = period(c, "2026-10-01", "2026-10-31", "expense").unwrap();
        let s = crate::reports::period_summary(c, "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(e.total, s.expense);
        assert_eq!(
            e.categories.iter().map(|p| p.amount).sum::<i64>(),
            s.expense
        );
        assert_eq!(e.categories[0].amount, 50_000);
        assert_eq!(e.categories[0].count, 2);
        assert_eq!((e.spread_parts, e.spread_amount), (1, 40_000));
        assert_eq!(e.transfers, 1);
        let i = period(c, "2026-10-01", "2026-10-31", "income").unwrap();
        assert_eq!(i.total, s.income);

        let b = balance(c, "2026-10-31").unwrap();
        let t = accounts::totals(c, "2026-10-31").unwrap();
        assert_eq!(b.total, t.total);
        let st: Vec<_> = b.accounts.iter().map(|a| a.status.as_str()).collect();
        assert_eq!(st, ["in", "excluded", "no_rate"]);
    }
}
