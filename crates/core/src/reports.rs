//! Отчёты. Суммы в основной валюте по курсу на дату операции.
//! Переводы не входят в доходы и расходы; корректировки идут отдельной строкой.
//! Трата «на N месяцев» считается частями по месяцам (`txn_by_month`).

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::budgets::{self, Period};
use crate::error::invalid;
use crate::{accounts, categories, currencies, Error, Result};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSummary {
    pub base_currency: String,
    pub income: i64,
    pub expense: i64,
    pub adjustments: i64,
    /// Норма сбережений за период, %; `None` без доходов. Корректировки не учитываются.
    pub savings_rate: Option<i64>,
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
        "SELECT t.type, t.date, t.amount, a.currency_code FROM txn_by_month t
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
    out.savings_rate = savings_rate(out.income, out.expense);
    Ok(out)
}

/// Процент `part` от `whole`, округлённый до целого (половина — от нуля).
pub fn percent(part: i64, whole: i64) -> i64 {
    if whole == 0 {
        return 0;
    }
    let (p, w) = (part as i128 * 100, whole as i128);
    let q = (2 * p + p.signum() * w.abs()) / (2 * w);
    q as i64
}

/// Норма сбережений: доля дохода, которая осталась, в процентах. `None` без доходов.
pub fn savings_rate(income: i64, expense: i64) -> Option<i64> {
    (income > 0).then(|| percent(income - expense, income))
}

/// Период отчёта: месяц, квартал или год, в который входит месяц `month`.
/// Месяцы считаются от настройки «первый день месяца», как в бюджете.
pub fn period_of(conn: &Connection, kind: &str, month: &str) -> Result<Period> {
    let day = budgets::start_day(conn)?;
    let (y, m) = month
        .split_once('-')
        .and_then(|(y, m)| Some((y.parse::<i32>().ok()?, m.parse::<u32>().ok()?)))
        .ok_or_else(|| Error::Validation(format!("некорректный месяц: {month}")))?;
    let (first, last) = match kind {
        "month" => (m, m),
        "quarter" => {
            let q = (m.max(1) - 1) / 3;
            (q * 3 + 1, q * 3 + 3)
        }
        "year" => (1, 12),
        _ => return invalid(format!("неизвестный период: {kind}")),
    };
    let start = budgets::period(&format!("{y}-{first:02}"), day)?.start;
    let end = budgets::period(&format!("{y}-{last:02}"), day)?.end;
    Ok(Period {
        month: month.to_string(),
        start,
        end,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryItem {
    pub category_id: String,
    pub name: String,
    pub amount: i64,
    /// Доля от итога периода, целый процент.
    pub percent: i64,
    /// Подкатегории с операциями; «сама категория» — строкой с её же id.
    pub children: Vec<CategoryItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryReport {
    pub base_currency: String,
    pub total: i64,
    /// По убыванию суммы.
    pub items: Vec<CategoryItem>,
    pub missing_rates: Vec<String>,
}

/// Расходы или доходы по категориям за период, подкатегории внутри родителя.
pub fn by_category(conn: &Connection, kind: &str, from: &str, to: &str) -> Result<CategoryReport> {
    if !matches!(kind, "expense" | "income") {
        return invalid(format!(
            "отчёт по категориям строится для расходов или доходов, не для {kind}"
        ));
    }
    let base = currencies::base_currency(conn)?;
    let mut stmt = conn.prepare(
        "SELECT t.category_id, t.date, t.amount, a.currency_code FROM txn_by_month t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type = ?1 AND t.date BETWEEN ?2 AND ?3",
    )?;
    let rows = stmt.query_map(params![kind, from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut by_cat: HashMap<String, i64> = HashMap::new();
    let mut missing_rates = Vec::new();
    for row in rows {
        let (cat, date, amount, cur) = row?;
        match currencies::convert(conn, amount, &cur, &base, &date)? {
            Some(v) => *by_cat.entry(cat).or_default() += v,
            None if !missing_rates.contains(&cur) => missing_rates.push(cur),
            None => {}
        }
    }
    let cats = categories::list(conn, true)?;
    let total: i64 = by_cat.values().sum();
    let mut items: Vec<CategoryItem> = Vec::new();
    for parent in cats
        .iter()
        .filter(|c| c.parent_id.is_none() && c.kind == kind)
    {
        let mut children: Vec<CategoryItem> = cats
            .iter()
            .filter(|c| c.parent_id.as_deref() == Some(&parent.id))
            .filter_map(|c| by_cat.get(&c.id).map(|&v| (c, v)))
            .map(|(c, v)| CategoryItem {
                category_id: c.id.clone(),
                name: c.name.clone(),
                amount: v,
                percent: percent(v, total),
                children: vec![],
            })
            .collect();
        let own = by_cat.get(&parent.id).copied().unwrap_or(0);
        let amount = own + children.iter().map(|c| c.amount).sum::<i64>();
        if amount == 0 && !by_cat.contains_key(&parent.id) && children.is_empty() {
            continue;
        }
        if !children.is_empty() && own != 0 {
            children.push(CategoryItem {
                category_id: parent.id.clone(),
                name: format!("{} (без подкатегории)", parent.name),
                amount: own,
                percent: percent(own, total),
                children: vec![],
            });
        }
        children.sort_by_key(|c| std::cmp::Reverse(c.amount));
        items.push(CategoryItem {
            category_id: parent.id.clone(),
            name: parent.name.clone(),
            amount,
            percent: percent(amount, total),
            children,
        });
    }
    items.sort_by(|a, b| b.amount.cmp(&a.amount).then_with(|| a.name.cmp(&b.name)));
    Ok(CategoryReport {
        base_currency: base,
        total,
        items,
        missing_rates,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthRow {
    pub period: Period,
    pub income: i64,
    pub expense: i64,
    /// Доходы − расходы.
    pub balance: i64,
    pub savings_rate: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthsReport {
    pub base_currency: String,
    pub months: Vec<MonthRow>,
    pub income: i64,
    pub expense: i64,
    pub balance: i64,
    pub savings_rate: Option<i64>,
    pub missing_rates: Vec<String>,
}

/// Доходы, расходы и сальдо по месяцам от `from_month` до `to_month` включительно.
pub fn by_month(conn: &Connection, from_month: &str, to_month: &str) -> Result<MonthsReport> {
    let day = budgets::start_day(conn)?;
    let mut periods = Vec::new();
    let mut month = from_month.to_string();
    budgets::period(to_month, day)?;
    while month.as_str() <= to_month {
        if periods.len() >= 120 {
            return invalid("отчёт по месяцам строится не больше чем за 10 лет");
        }
        periods.push(budgets::period(&month, day)?);
        month = budgets::shift_month(&month, 1)?;
    }
    // Один проход по операциям всего диапазона вместо запроса на каждый месяц
    // (на 50 000 операций — в разы быстрее); суммы те же, что у period_summary.
    let mut sums = vec![PeriodSummary::default(); periods.len()];
    if let (Some(first), Some(last)) = (periods.first(), periods.last()) {
        let base = currencies::base_currency(conn)?;
        let mut stmt = conn.prepare(
            "SELECT t.type, t.date, t.amount, a.currency_code FROM txn_by_month t
             JOIN accounts a ON a.id = t.account_id
             WHERE t.status = 'cleared' AND t.type IN ('income', 'expense', 'adjustment')
               AND t.date BETWEEN ?1 AND ?2",
        )?;
        let rows = stmt.query_map(params![first.start, last.end], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (kind, date, amount, currency) = row?;
            // Периоды идут подряд: последний, начавшийся не позже даты.
            let i = periods.partition_point(|p| p.start.as_str() <= date.as_str());
            let Some(i) = i.checked_sub(1).filter(|&i| date <= periods[i].end) else {
                continue;
            };
            let out = &mut sums[i];
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
    }
    let mut months = Vec::new();
    let mut missing_rates: Vec<String> = Vec::new();
    for (p, s) in periods.into_iter().zip(sums) {
        for c in s.missing_rates {
            if !missing_rates.contains(&c) {
                missing_rates.push(c);
            }
        }
        months.push(MonthRow {
            period: p,
            income: s.income,
            expense: s.expense,
            balance: s.income - s.expense,
            savings_rate: savings_rate(s.income, s.expense),
        });
    }
    let income = months.iter().map(|m| m.income).sum();
    let expense = months.iter().map(|m| m.expense).sum();
    Ok(MonthsReport {
        base_currency: currencies::base_currency(conn)?,
        months,
        income,
        expense,
        balance: income - expense,
        savings_rate: savings_rate(income, expense),
        missing_rates,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceRow {
    pub account_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub balance: i64,
    /// В основной валюте по курсу на дату; `None`, если курса нет.
    pub base_value: Option<i64>,
    pub include_in_total: bool,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancesReport {
    pub date: String,
    pub base_currency: String,
    pub rows: Vec<BalanceRow>,
    /// Сумма счетов «в общем балансе» в основной валюте.
    pub total: i64,
    pub missing_rates: Vec<String>,
}

/// Остатки счетов на дату. Начальный остаток считается с даты открытия счёта.
/// Счёт, открытый позже даты, и закрытый счёт показываются, только если на дату
/// на них были деньги.
pub fn balances_on(conn: &Connection, date: &str) -> Result<BalancesReport> {
    crate::time::check_date(date)?;
    let base = currencies::base_currency(conn)?;
    let mut rows = Vec::new();
    let mut total = 0;
    let mut missing_rates = Vec::new();
    for a in accounts::list(conn, true)? {
        let not_yet_open = a.opening_date.as_str() > date;
        let mut balance = accounts::balance(conn, &a.id, Some(date))?;
        if not_yet_open {
            balance -= a.opening_balance;
        }
        if (a.archived || not_yet_open) && balance == 0 {
            continue;
        }
        let base_value = currencies::convert(conn, balance, &a.currency_code, &base, date)?;
        match base_value {
            Some(v) if a.include_in_total => total += v,
            None if !missing_rates.contains(&a.currency_code) => {
                missing_rates.push(a.currency_code.clone())
            }
            _ => {}
        }
        rows.push(BalanceRow {
            account_id: a.id,
            name: a.name,
            kind: a.kind,
            currency_code: a.currency_code,
            currency_symbol: a.currency_symbol,
            minor_units: a.minor_units,
            balance,
            base_value,
            include_in_total: a.include_in_total,
            archived: a.archived,
        });
    }
    Ok(BalancesReport {
        date: date.to_string(),
        base_currency: base,
        rows,
        total,
        missing_rates,
    })
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
        transactions::create(
            c,
            &t("income", "2026-10-05", &rub, 8_500_000, "Заработная плата"),
        )
        .unwrap();
        transactions::create(
            c,
            &t("income", "2026-10-05", &usd, 1_000, "Дополнительный доход"),
        )
        .unwrap();
        accounts::adjust_balance(c, &rub, 8_400_000, "2026-10-20", None).unwrap();

        let s = period_summary(c, "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(s.expense, 450_000 + 101_000);
        assert_eq!(s.income, 8_500_000);
        assert_eq!(s.adjustments, -100_000);
        assert_eq!(s.missing_rates, ["USD"]);
        assert_eq!(s.savings_rate, Some(94)); // (85 000 − 5 510) / 85 000
    }

    struct Fx {
        db: Storage,
        card: String,
    }

    impl Fx {
        fn new() -> Self {
            let db = Storage::open_in_memory().unwrap();
            categories::seed_defaults(db.conn()).unwrap();
            let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
            Fx { db, card }
        }
        fn cat(&self, n: &str) -> String {
            self.db
                .conn()
                .query_row("SELECT id FROM categories WHERE name = ?1", [n], |r| {
                    r.get(0)
                })
                .unwrap()
        }
        fn op(&self, kind: &str, date: &str, amount: i64, category: &str) {
            transactions::create(
                self.db.conn(),
                &TxnInput {
                    kind: kind.into(),
                    date: date.into(),
                    account_id: self.card.clone(),
                    amount,
                    category_id: Some(self.cat(category)),
                    to_account_id: None,
                    to_amount: None,
                    payee: None,
                    note: None,
                },
            )
            .unwrap();
        }
    }

    #[test]
    fn percent_rounding() {
        assert_eq!(percent(28, 100), 28);
        assert_eq!(percent(1, 3), 33);
        assert_eq!(percent(2, 3), 67);
        assert_eq!(percent(1, 8), 13); // 12,5 → 13
        assert_eq!(percent(-1, 8), -13);
        assert_eq!(percent(5, 0), 0);
        assert_eq!(savings_rate(100_000, 75_000), Some(25));
        assert_eq!(savings_rate(100_000, 130_000), Some(-30));
        assert_eq!(savings_rate(0, 5_000), None);
    }

    #[test]
    fn month_totals_by_category() {
        // Сценарий «Итоги месяца»: «Продукты» 28 %, «Транспорт» 15 %.
        let f = Fx::new();
        f.op("expense", "2026-10-03", 1_800_000, "Магазины");
        f.op("expense", "2026-10-04", 1_000_000, "Питание");
        f.op("expense", "2026-10-05", 1_500_000, "Такси");
        f.op("expense", "2026-10-06", 5_700_000, "Аренда");
        f.op("expense", "2026-09-30", 999_900, "Такси"); // другой месяц
        f.op("income", "2026-10-05", 15_000_000, "Заработная плата");
        accounts::adjust_balance(f.db.conn(), &f.card, 0, "2026-10-20", None).unwrap();

        let r = by_category(f.db.conn(), "expense", "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(r.total, 10_000_000);
        let names: Vec<_> = r
            .items
            .iter()
            .map(|i| (i.name.as_str(), i.percent))
            .collect();
        assert_eq!(names, [("Жильё", 57), ("Питание", 28), ("Транспорт", 15)]);
        let food = &r.items[1];
        assert_eq!(food.amount, 2_800_000);
        let kids: Vec<_> = food
            .children
            .iter()
            .map(|c| (c.name.as_str(), c.amount))
            .collect();
        assert_eq!(
            kids,
            [
                ("Магазины", 1_800_000),
                ("Питание (без подкатегории)", 1_000_000)
            ]
        );
        assert_eq!(food.children[1].category_id, f.cat("Питание"));

        let inc = by_category(f.db.conn(), "income", "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(inc.total, 15_000_000);
        assert_eq!(inc.items[0].percent, 100);
        assert!(by_category(f.db.conn(), "transfer", "2026-10-01", "2026-10-31").is_err());
    }

    #[test]
    fn year_by_months_with_savings_rate() {
        // Сценарий «Динамика за год»: в каком месяце тратил больше, чем зарабатывал.
        let f = Fx::new();
        f.op("income", "2026-01-10", 10_000_000, "Заработная плата");
        f.op("expense", "2026-01-15", 7_500_000, "Питание");
        f.op("income", "2026-02-10", 10_000_000, "Заработная плата");
        f.op("expense", "2026-02-20", 12_000_000, "Путешествия");
        f.op("expense", "2026-03-01", 100_000, "Питание");
        let r = by_month(f.db.conn(), "2026-01", "2026-12").unwrap();
        assert_eq!(r.months.len(), 12);
        assert_eq!(r.months[0].balance, 2_500_000);
        assert_eq!(r.months[0].savings_rate, Some(25));
        assert_eq!(r.months[1].balance, -2_000_000);
        assert_eq!(r.months[1].savings_rate, Some(-20));
        assert_eq!(r.months[2].savings_rate, None);
        assert_eq!(r.months[11].period.end, "2026-12-31");
        assert_eq!(
            (r.income, r.expense, r.balance),
            (20_000_000, 19_600_000, 400_000)
        );
        assert_eq!(r.savings_rate, Some(2));
        assert!(by_month(f.db.conn(), "2000-01", "2026-12").is_err());
    }

    #[test]
    fn months_follow_month_start_day() {
        let f = Fx::new();
        crate::settings::set(f.db.conn(), "month_start_day", "25").unwrap();
        f.op("income", "2026-10-25", 10_000_000, "Заработная плата"); // уже «ноябрь»
        let r = by_month(f.db.conn(), "2026-10", "2026-11").unwrap();
        assert_eq!(r.months[0].period.start, "2026-09-25");
        assert_eq!(r.months[0].income, 0);
        assert_eq!(r.months[1].income, 10_000_000);

        let q = period_of(f.db.conn(), "quarter", "2026-11").unwrap();
        assert_eq!(
            (q.start.as_str(), q.end.as_str()),
            ("2026-09-25", "2026-12-24")
        );
        let y = period_of(f.db.conn(), "year", "2026-03").unwrap();
        assert_eq!(
            (y.start.as_str(), y.end.as_str()),
            ("2025-12-25", "2026-12-24")
        );
        crate::settings::set(f.db.conn(), "month_start_day", "1").unwrap();
        let m = period_of(f.db.conn(), "month", "2028-02").unwrap();
        assert_eq!(
            (m.start.as_str(), m.end.as_str()),
            ("2028-02-01", "2028-02-29")
        );
        assert!(period_of(f.db.conn(), "week", "2026-02").is_err());
    }

    #[test]
    fn balances_on_a_date() {
        let f = Fx::new();
        let c = f.db.conn();
        let mut usd = input("Доллары", "cash", "USD", 100_000);
        usd.opening_date = "2026-06-01".into();
        let usd = accounts::create(c, &usd).unwrap();
        f.op("income", "2026-05-10", 5_000_000, "Заработная плата");
        f.op("expense", "2026-07-10", 1_000_000, "Питание");
        currencies::set_rate(c, "2026-06-01", "USD", "RUB", "90").unwrap();

        let may = balances_on(c, "2026-05-31").unwrap();
        assert_eq!(may.rows.len(), 1, "долларового счёта ещё не было");
        assert_eq!(may.total, 5_000_000);

        let july = balances_on(c, "2026-07-31").unwrap();
        let row = july.rows.iter().find(|r| r.account_id == usd).unwrap();
        assert_eq!((row.balance, row.base_value), (100_000, Some(9_000_000)));
        assert_eq!(july.total, 4_000_000 + 9_000_000);
        assert!(balances_on(c, "31.07.2026").is_err());
    }
}
