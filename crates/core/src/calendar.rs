//! Календарь: собственной таблицы нет, дни собираются из операций, графиков
//! долгов, срабатываний напоминаний и заметок. Суммы операций и итоги — в
//! основной валюте по курсу на дату; платежи по долгам и напоминания показываются
//! в своей валюте.

use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate, NaiveTime};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::invalid;
use crate::reminders::{self, Occurrence};
use crate::{currencies, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtDue {
    pub debt_id: String,
    pub schedule_id: String,
    pub counterparty: String,
    /// `lent` — мне вернут, `borrowed` — плачу я.
    pub direction: String,
    pub payment: i64,
    pub currency_symbol: String,
    pub minor_units: u32,
    /// `pending`, `paid`, `partial`.
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub date: String,
    pub income: i64,
    pub expense: i64,
    pub debts: Vec<DebtDue>,
    /// Свои напоминания этого дня (о долгах календарь показывает сам платёж).
    pub reminders: Vec<Occurrence>,
    pub notes: u32,
    /// Тексты дня для клетки календаря: сначала заметки на эту дату, затем
    /// комментарии к доходам и расходам (по времени создания).
    pub memos: Vec<String>,
    /// День без трат: прошёл (или сегодня), расходов нет, а учёт уже вёлся.
    pub no_spend: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Month {
    /// `YYYY-MM`.
    pub month: String,
    pub base_currency: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub days: Vec<Day>,
    pub income: i64,
    pub expense: i64,
    /// Ещё предстоит заплатить с сегодняшнего дня до конца месяца: платежи по
    /// взятым долгам и напоминания-расходы, которые не выполнены.
    pub planned_expense: i64,
    /// Ещё ожидается: возвраты по выданным долгам и напоминания-доходы.
    pub planned_income: i64,
    pub missing_rates: Vec<String>,
}

fn parse_month(month: &str) -> Result<(NaiveDate, NaiveDate)> {
    let Ok(first) = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d") else {
        return invalid(format!("некорректный месяц: {month}"));
    };
    let last = reminders::add_months(first, 1) - Duration::days(1);
    Ok((first, last))
}

/// Календарь месяца `YYYY-MM`. `today` отделяет прошлое (факт) от будущего (план).
pub fn month(conn: &Connection, month: &str, today: &str) -> Result<Month> {
    let (first, last) = parse_month(month)?;
    let r = range(conn, first, last, today)?;
    Ok(Month {
        month: month.to_string(),
        ..r
    })
}

/// Дни с `first` по `last` включительно (для месяца и недели).
pub fn range(conn: &Connection, first: NaiveDate, last: NaiveDate, today: &str) -> Result<Month> {
    if last < first || (last - first).num_days() > 62 {
        return invalid("календарь строится не больше чем на два месяца");
    }
    let base = currencies::base_currency(conn)?;
    let bc = currencies::get(conn, &base)?;
    let (from, to) = (first.to_string(), last.to_string());
    let mut days: BTreeMap<String, Day> = BTreeMap::new();
    let mut d = first;
    while d <= last {
        days.insert(
            d.to_string(),
            Day {
                date: d.to_string(),
                income: 0,
                expense: 0,
                debts: Vec::new(),
                reminders: Vec::new(),
                notes: 0,
                memos: Vec::new(),
                no_spend: false,
            },
        );
        d += Duration::days(1);
    }
    let mut missing: Vec<String> = Vec::new();
    let miss = |c: String, missing: &mut Vec<String>| {
        if !missing.contains(&c) {
            missing.push(c);
        }
    };

    // Операции: доходы и расходы (переводы и корректировки не считаются).
    let mut stmt = conn.prepare(
        "SELECT t.type, t.date, t.amount, a.currency_code FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type IN ('income', 'expense') AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows: Vec<(String, String, i64, String)> = stmt
        .query_map(params![from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (kind, date, amount, currency) in rows {
        let Some(v) = currencies::convert(conn, amount, &currency, &base, &date)? else {
            miss(currency, &mut missing);
            continue;
        };
        if let Some(day) = days.get_mut(&date) {
            if kind == "income" {
                day.income += v;
            } else {
                day.expense += v;
            }
        }
    }

    let (mut planned_expense, mut planned_income) = (0i64, 0i64);

    // Платежи по графикам долгов.
    let mut stmt = conn.prepare(
        "SELECT s.id, s.due_date, s.payment, s.status, d.id, d.counterparty, d.direction, d.currency_code,
                c.symbol, c.minor_units
         FROM debt_schedule s JOIN debts d ON d.id = s.debt_id JOIN currencies c ON c.code = d.currency_code
         WHERE s.due_date BETWEEN ?1 AND ?2
         ORDER BY s.due_date, d.counterparty",
    )?;
    type DebtRow = (
        String,
        String,
        i64,
        String,
        String,
        String,
        String,
        String,
        String,
        u32,
    );
    let rows: Vec<DebtRow> = stmt
        .query_map(params![from, to], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (sid, due, payment, status, debt_id, who, direction, currency, sym, mu) in rows {
        if status == "pending" && due.as_str() >= today {
            match currencies::convert(conn, payment, &currency, &base, today)? {
                Some(v) if direction == "borrowed" => planned_expense += v,
                Some(v) => planned_income += v,
                None => miss(currency, &mut missing),
            }
        }
        if let Some(day) = days.get_mut(&due) {
            day.debts.push(DebtDue {
                debt_id,
                schedule_id: sid,
                counterparty: who,
                direction,
                payment,
                currency_symbol: sym,
                minor_units: mu,
                status,
            });
        }
    }

    // Свои напоминания (о долгах уже показан сам платёж).
    let start = first.and_time(NaiveTime::MIN);
    let end = last.and_hms_opt(23, 59, 0).expect("время");
    for o in reminders::occurrences(conn, start, end)? {
        if o.key.source != "reminder" {
            continue;
        }
        let date = o.key.scheduled_at[..10].to_string();
        let open = matches!(o.status.as_str(), "pending" | "snoozed");
        if open && date.as_str() >= today {
            if let Some(a) = o.amount {
                if o.txn_type.as_deref() == Some("income") {
                    planned_income += a;
                } else {
                    planned_expense += a;
                }
            }
        }
        if let Some(day) = days.get_mut(&date) {
            day.reminders.push(o);
        }
    }

    // Заметки.
    let mut stmt = conn
        .prepare("SELECT date, COUNT(*) FROM notes WHERE date BETWEEN ?1 AND ?2 GROUP BY date")?;
    let rows: Vec<(String, u32)> = stmt
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (date, n) in rows {
        if let Some(day) = days.get_mut(&date) {
            day.notes = n;
        }
    }

    // Тексты для клетки: заметки дня, затем комментарии к операциям.
    let mut stmt = conn.prepare(
        "SELECT date, body FROM (
             SELECT date, body, 0 AS kind, created_at FROM notes
             WHERE date BETWEEN ?1 AND ?2 AND trim(body) <> ''
             UNION ALL
             SELECT date, note, 1, created_at FROM transactions
             WHERE date BETWEEN ?1 AND ?2 AND type IN ('expense', 'income')
               AND note IS NOT NULL AND trim(note) <> ''
         ) ORDER BY date, kind, created_at",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (date, text) in rows {
        if let Some(day) = days.get_mut(&date) {
            day.memos.push(text.trim().to_string());
        }
    }

    let started = crate::habits::first_day(conn)?;
    let mut days: Vec<Day> = days.into_values().collect();
    for d in &mut days {
        d.no_spend = d.expense == 0
            && d.date.as_str() <= today
            && started.as_deref().is_some_and(|s| d.date.as_str() >= s);
    }
    Ok(Month {
        month: format!("{:04}-{:02}", first.year(), first.month()),
        base_currency: base,
        currency_symbol: bc.symbol,
        minor_units: bc.minor_units,
        income: days.iter().map(|d| d.income).sum(),
        expense: days.iter().map(|d| d.expense).sum(),
        days,
        planned_expense,
        planned_income,
        missing_rates: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::categories;
    use crate::debts::{self, DebtInput};
    use crate::notes::{self, NoteInput};
    use crate::reminders::ReminderInput;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn reminder(title: &str, start: &str, repeat: &str, amount: Option<i64>) -> ReminderInput {
        ReminderInput {
            title: title.into(),
            start_at: start.into(),
            repeat: repeat.into(),
            amount,
            ..Default::default()
        }
    }

    /// «Вид месяца»: в ноябре 15-го платёж по кредиту, 20-го «Подарок, 5 000 ₽»,
    /// до конца месяца запланировано ещё 26 000 ₽ платежей.
    #[test]
    fn november_view_with_loan_gift_and_planned_total() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card =
            accounts::create(db.conn(), &input("Карта", "debit", "RUB", 10_000_000)).unwrap();
        let debt = debts::create(
            db.conn_mut(),
            &DebtInput {
                direction: "borrowed".into(),
                counterparty: "Кредит".into(),
                note: None,
                currency_code: "RUB".into(),
                principal: 2_100_000,
                issue_date: "2026-10-15".into(),
                rate_bp: 0,
                repayment_type: "annuity".into(),
                term_months: Some(12),
                first_payment_date: Some("2026-11-15".into()),
                maturity_date: None,
                account_id: Some(card.clone()),
                interest_method: None,
                rate_period: None,
                pay_every: None,
                rate_changes: vec![],
                planned_early: vec![],
            },
        )
        .unwrap();
        let c = db.conn();
        // Без процентов: 21 000 / 12 = 1 750 ₽ в месяц.
        reminders::create(
            c,
            &reminder("Подарок маме", "2026-11-20T10:00", "yearly", Some(500_000)),
        )
        .unwrap();
        let mut zhkh = reminder("ЖКХ", "2026-09-10T10:00", "monthly", Some(600_000));
        zhkh.day_of_month = Some(10);
        reminders::create(c, &zhkh).unwrap();
        // Разовое напоминание 25-го: ремонт 14 250 ₽.
        reminders::create(
            c,
            &reminder("Ремонт", "2026-11-25T12:00", "once", Some(1_425_000)),
        )
        .unwrap();
        notes::create(
            c,
            &NoteInput {
                body: "Подарок: шарф".into(),
                date: Some("2026-11-20".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let cat: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Продукты'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: "2026-11-03".into(),
                account_id: card.clone(),
                amount: 123_400,
                category_id: Some(cat),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: Some("К празднику".into()),
            },
        )
        .unwrap();

        let m = month(c, "2026-11", "2026-11-12").unwrap();
        assert_eq!(m.days.len(), 30);
        let day = |n: usize| &m.days[n - 1];
        assert_eq!(day(3).expense, 123_400);
        assert_eq!(day(10).reminders[0].title, "ЖКХ");
        assert_eq!(day(15).debts.len(), 1);
        assert_eq!(day(15).debts[0].counterparty, "Кредит");
        assert_eq!(day(15).debts[0].payment, 175_000);
        assert_eq!(day(20).reminders[0].title, "Подарок маме");
        assert_eq!(day(20).notes, 1);
        assert_eq!(day(20).memos, vec!["Подарок: шарф".to_string()]);
        assert_eq!(day(3).memos, vec!["К празднику".to_string()]);
        assert!(day(10).memos.is_empty());
        assert_eq!(m.expense, 123_400);
        // 12-го: ЖКХ 10-го уже прошло → не в плане; кредит 1 750 + подарок 5 000 + ремонт 14 250 = 21 000.
        assert_eq!(m.planned_expense, 175_000 + 500_000 + 1_425_000);
        // Напоминание о долге (за 3 дня) календарь не показывает отдельно.
        assert!(m
            .days
            .iter()
            .all(|d| d.reminders.iter().all(|r| r.key.source == "reminder")));

        // Платёж по кредиту отмечен → в календаре «оплачен», из плана ушёл.
        let next = debts::get(c, &debt, "2026-11-12")
            .unwrap()
            .card
            .next_payment
            .unwrap();
        debts::pay(
            db.conn_mut(),
            &debt,
            &debts::PaymentInput {
                date: "2026-11-12".into(),
                account_id: card,
                principal: next.principal_part,
                interest: next.interest_part,
                schedule_id: Some(next.id),
                recalc_mode: None,
            },
        )
        .unwrap();
        let c = db.conn();
        let m = month(c, "2026-11", "2026-11-12").unwrap();
        assert_eq!(m.days[14].debts[0].status, "paid");
        assert_eq!(m.planned_expense, 500_000 + 1_425_000);
        // Выполненное напоминание тоже уходит из плана.
        let gift = m.days[19].reminders[0].key.clone();
        reminders::complete(c, &gift, None).unwrap();
        let m = month(c, "2026-11", "2026-11-12").unwrap();
        assert_eq!(m.planned_expense, 1_425_000);
        assert_eq!(m.days[19].reminders[0].status, "done");
    }

    #[test]
    fn week_range_across_months_and_limits() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let w = range(c, d("2026-10-26"), d("2026-11-01"), "2026-10-20").unwrap();
        assert_eq!(w.days.len(), 7);
        assert_eq!(w.days[6].date, "2026-11-01");
        assert!(range(c, d("2026-11-01"), d("2026-10-01"), "2026-10-20").is_err());
        assert!(range(c, d("2026-01-01"), d("2026-12-31"), "2026-10-20").is_err());
        assert!(month(c, "2026-13", "2026-10-20").is_err());
        assert_eq!(month(c, "2028-02", "2026-10-20").unwrap().days.len(), 29);
    }
}
