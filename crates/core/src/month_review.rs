//! Итоги месяца (0.29): что получилось за бюджетный месяц, прогноз против
//! факта и отметка «Месяц завершён».
//!
//! Прогноз месяца запоминается заранее (`remember_forecast`): для следующего
//! месяца — каждый раз, пока он не начался, для текущего — один раз, если
//! раньше не запомнили (тогда он «частичный»: часть месяца уже прошла).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::invalid;
use crate::{budgets, forecast, reports, time, Result};

/// Сколько дней после конца месяца Главная предлагает подвести итоги.
pub const SUGGEST_DAYS: i64 = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastCheck {
    pub income: i64,
    pub expense: i64,
    /// Когда запомнен (UTC).
    pub made_at: String,
    /// Запомнен, когда месяц уже шёл: часть суммы — уже случившееся.
    pub partial: bool,
    /// Факт − прогноз.
    pub income_diff: i64,
    pub expense_diff: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverLine {
    pub category_id: String,
    pub category_name: String,
    pub limit: i64,
    pub actual: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthReview {
    pub month: String,
    pub start: String,
    pub end: String,
    pub base_currency: String,
    /// Месяц закончился (сегодня позже его последнего дня).
    pub ended: bool,
    pub closed_at: Option<String>,
    pub note: Option<String>,
    pub income: i64,
    pub expense: i64,
    /// Доходы − расходы.
    pub saved: i64,
    pub savings_rate: Option<i64>,
    /// Возвраты, учтённые в этом месяце (уже вычтены из расходов).
    pub refunds: i64,
    pub forecast: Option<ForecastCheck>,
    /// Категории, где факт больше лимита, по убыванию перерасхода.
    pub over: Vec<OverLine>,
    /// Есть бюджет на этот месяц.
    pub has_budget: bool,
    /// Совпадения выписки, которые ещё ждут ответа.
    pub open_matches: i64,
    /// Запланированные операции месяца, которые так и не случились.
    pub planned_left: i64,
    pub missing_rates: Vec<String>,
}

/// Сохранённая строка: прогноз (доход, расход, когда, частичный), когда
/// завершён, заметка.
type Row = (
    Option<i64>,
    Option<i64>,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
);

fn row(conn: &Connection, month: &str) -> Result<Option<Row>> {
    Ok(conn
        .query_row(
            "SELECT forecast_income, forecast_expense, forecast_at, forecast_partial, closed_at, note
             FROM month_reviews WHERE month = ?1",
            [month],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?)
}

fn save_forecast(
    conn: &Connection,
    month: &str,
    income: i64,
    expense: i64,
    partial: bool,
    only_if_missing: bool,
) -> Result<()> {
    let sql = if only_if_missing {
        "INSERT INTO month_reviews (month, forecast_income, forecast_expense, forecast_at, forecast_partial)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(month) DO UPDATE SET forecast_income = excluded.forecast_income,
             forecast_expense = excluded.forecast_expense, forecast_at = excluded.forecast_at,
             forecast_partial = excluded.forecast_partial
         WHERE month_reviews.forecast_at IS NULL"
    } else {
        "INSERT INTO month_reviews (month, forecast_income, forecast_expense, forecast_at, forecast_partial)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(month) DO UPDATE SET forecast_income = excluded.forecast_income,
             forecast_expense = excluded.forecast_expense, forecast_at = excluded.forecast_at,
             forecast_partial = excluded.forecast_partial"
    };
    conn.execute(
        sql,
        params![month, income, expense, time::now_utc(), partial],
    )?;
    Ok(())
}

/// Запомнить прогноз: следующего месяца (пока он не начался — последний) и
/// текущего (если ещё не запомнен).
pub fn remember_forecast(conn: &Connection, today: &str) -> Result<()> {
    let f = forecast::forecast(conn, today, None)?;
    let Some(current) = f.months.first() else {
        return Ok(());
    };
    if let Some(next) = f.months.get(1) {
        save_forecast(
            conn,
            &next.month,
            next.regular_income + next.planned_income,
            next.regular_expense + next.planned_expense,
            false,
            false,
        )?;
    }
    // В текущем месяце прогноз — только остаток: добавляем уже случившееся.
    // У текущего месяца прогноза start может быть сегодняшним днём.
    let start = budgets::month_of(conn, today)?.start;
    let so_far = reports::period_summary(conn, &start, today)?;
    save_forecast(
        conn,
        &current.month,
        so_far.income + current.regular_income + current.planned_income,
        so_far.expense + current.regular_expense + current.planned_expense,
        today > start.as_str(),
        true,
    )
}

pub fn get(conn: &Connection, month: &str, today: &str) -> Result<MonthReview> {
    let b = budgets::get(conn, month, today)?;
    let p = &b.period;
    let s = reports::period_summary(conn, &p.start, &p.end)?;
    let saved = row(conn, month)?;
    let forecast = saved.as_ref().and_then(|(i, e, at, partial, _, _)| {
        Some(ForecastCheck {
            income: (*i)?,
            expense: (*e)?,
            made_at: at.clone()?,
            partial: *partial,
            income_diff: s.income - (*i)?,
            expense_diff: s.expense - (*e)?,
        })
    });
    let mut over: Vec<OverLine> = b
        .lines
        .iter()
        .filter(|l| {
            l.kind == "expense" && l.parent_id.is_none() && l.limit > 0 && l.actual > l.limit
        })
        .map(|l| OverLine {
            category_id: l.category_id.clone(),
            category_name: l.category_name.clone(),
            limit: l.limit,
            actual: l.actual,
        })
        .collect();
    over.sort_by_key(|l| std::cmp::Reverse(l.actual - l.limit));
    let refunds: i64 = conn.query_row(
        "SELECT COALESCE(-sum(t.amount), 0) FROM txn_by_month t
         JOIN transactions o ON o.id = t.id
         WHERE o.refund = 1 AND t.status = 'cleared' AND t.date BETWEEN ?1 AND ?2
           AND (SELECT currency_code FROM accounts WHERE id = t.account_id) = ?3",
        params![p.start, p.end, s.base_currency],
        |r| r.get(0),
    )?;
    let open_matches: i64 =
        conn.query_row("SELECT count(*) FROM import_suggestions", [], |r| r.get(0))?;
    let planned_left: i64 = conn.query_row(
        "SELECT count(*) FROM transactions WHERE status = 'planned' AND date BETWEEN ?1 AND ?2",
        params![p.start, p.end],
        |r| r.get(0),
    )?;
    let (closed_at, note) = saved.map(|(_, _, _, _, c, n)| (c, n)).unwrap_or_default();
    Ok(MonthReview {
        month: month.to_string(),
        start: p.start.clone(),
        end: p.end.clone(),
        base_currency: s.base_currency.clone(),
        ended: today > p.end.as_str(),
        closed_at,
        note,
        income: s.income,
        expense: s.expense,
        saved: s.income - s.expense,
        savings_rate: s.savings_rate,
        refunds,
        forecast,
        over,
        has_budget: b.id.is_some(),
        open_matches,
        planned_left,
        missing_rates: s.missing_rates,
    })
}

/// «Месяц завершён»: только после его конца.
pub fn close(conn: &Connection, month: &str, today: &str, note: Option<&str>) -> Result<()> {
    let p = budgets::period(month, budgets::start_day(conn)?)?;
    if today <= p.end.as_str() {
        return invalid("месяц ещё идёт: завершить его можно после последнего дня");
    }
    let note = note.map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "INSERT INTO month_reviews (month, closed_at, note) VALUES (?1, ?2, ?3)
         ON CONFLICT(month) DO UPDATE SET closed_at = excluded.closed_at, note = excluded.note",
        params![month, time::now_utc(), note],
    )?;
    Ok(())
}

pub fn reopen(conn: &Connection, month: &str) -> Result<()> {
    conn.execute(
        "UPDATE month_reviews SET closed_at = NULL WHERE month = ?1",
        [month],
    )?;
    Ok(())
}

/// Месяц, итоги которого стоит подвести: прошлый, закончился не больше
/// `SUGGEST_DAYS` дней назад, не завершён и в нём были операции.
pub fn suggested(conn: &Connection, today: &str) -> Result<Option<String>> {
    let current = budgets::month_of(conn, today)?;
    let prev = budgets::period(
        &budgets::shift_month(&current.month, -1)?,
        budgets::start_day(conn)?,
    )?;
    let days = (time::parse_date(today)? - time::parse_date(&prev.end)?).num_days();
    if days > SUGGEST_DAYS {
        return Ok(None);
    }
    if row(conn, &prev.month)?.is_some_and(|r| r.4.is_some()) {
        return Ok(None);
    }
    let any: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM transactions WHERE status = 'cleared'
                        AND type IN ('expense', 'income') AND date BETWEEN ?1 AND ?2)",
        params![prev.start, prev.end],
        |r| r.get(0),
    )?;
    Ok(any.then_some(prev.month))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{create as acc, AccountInput};
    use crate::refunds::{self, RefundInput};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn txn(c: &Connection, kind: &str, date: &str, account: &str, amount: i64) -> String {
        let cat: String = c
            .query_row(
                "SELECT id FROM categories WHERE kind = ?1 LIMIT 1",
                [kind],
                |r| r.get(0),
            )
            .unwrap();
        transactions::create(
            c,
            &TxnInput {
                kind: kind.into(),
                date: date.into(),
                account_id: account.into(),
                amount,
                category_id: Some(cat),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn review_forecast_vs_fact_and_closing() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = acc(
            c,
            &AccountInput {
                name: "Карта".into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 0,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap();
        // Сентябрь — история для прогноза.
        txn(c, "income", "2026-09-05", &card, 10_000_000);
        txn(c, "expense", "2026-09-10", &card, 6_000_000);
        // 20 сентября запоминаем прогноз октября (полный) и сентября (частичный).
        remember_forecast(c, "2026-09-20").unwrap();
        let (i, e, _, partial, _, _) = row(c, "2026-10").unwrap().unwrap();
        assert!(i.is_some() && e.is_some() && !partial);
        assert!(row(c, "2026-09").unwrap().unwrap().3);
        // Частичный прогноз текущего месяца не перезаписывается.
        let before = row(c, "2026-09").unwrap().unwrap().2;
        remember_forecast(c, "2026-09-25").unwrap();
        assert_eq!(row(c, "2026-09").unwrap().unwrap().2, before);

        // Октябрь: доход 10 000, покупка 7 000, возврат 1 000 в месяце покупки.
        txn(c, "income", "2026-10-05", &card, 10_000_000);
        let buy = txn(c, "expense", "2026-10-12", &card, 7_000_000);
        refunds::create(
            c,
            &RefundInput {
                of: buy,
                date: "2026-11-02".into(),
                account_id: None,
                amount: 1_000_000,
                in_purchase_month: true,
                note: None,
            },
        )
        .unwrap();

        let r = get(c, "2026-10", "2026-11-03").unwrap();
        assert!(r.ended && r.closed_at.is_none());
        assert_eq!(
            (r.income, r.expense, r.saved),
            (10_000_000, 6_000_000, 4_000_000)
        );
        assert_eq!(r.refunds, 1_000_000);
        let fc = r.forecast.unwrap();
        assert_eq!(fc.expense_diff, 6_000_000 - fc.expense);
        assert_eq!(fc.income_diff, 10_000_000 - fc.income);

        assert_eq!(
            suggested(c, "2026-11-03").unwrap().as_deref(),
            Some("2026-10")
        );
        assert_eq!(suggested(c, "2026-11-20").unwrap(), None);
        // Идущий месяц не завершить; прошлый — можно и вернуть обратно.
        assert!(close(c, "2026-11", "2026-11-03", None).is_err());
        close(c, "2026-10", "2026-11-03", Some(" Отпуск дорогой ")).unwrap();
        let r = get(c, "2026-10", "2026-11-03").unwrap();
        assert!(r.closed_at.is_some());
        assert_eq!(r.note.as_deref(), Some("Отпуск дорогой"));
        assert!(r.forecast.is_some(), "завершение не стирает прогноз");
        assert_eq!(suggested(c, "2026-11-03").unwrap(), None);
        reopen(c, "2026-10").unwrap();
        assert_eq!(
            suggested(c, "2026-11-03").unwrap().as_deref(),
            Some("2026-10")
        );
    }
}
