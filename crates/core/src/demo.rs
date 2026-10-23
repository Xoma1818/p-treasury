//! Пробные данные: «Посмотреть на примере» в мастере первого запуска.
//! Пример — это обычные данные с отметкой `demo_data = 1`; удаляются одной
//! кнопкой, после чего приложение снова открывает мастер первого запуска.

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::Connection;

use crate::accounts::{self, AccountInput};
use crate::assets::{self, AssetInput};
use crate::budgets::{self, FillMode};
use crate::debts::{self, DebtInput};
use crate::error::invalid;
use crate::events::{self, EventInput};
use crate::notes::{self, NoteInput};
use crate::reminders::{self, ReminderInput};
use crate::templates::{self, TemplateInput};
use crate::transactions::{self, TxnInput};
use crate::{categories, currencies, onboarding, settings, Result};

/// Сколько прошлых месяцев истории в примере (плюс текущий до сегодня).
const HISTORY_MONTHS: u32 = 3;

pub fn is_demo(conn: &Connection) -> Result<bool> {
    Ok(settings::get(conn, "demo_data")?.as_deref() == Some("1"))
}

fn month_start(d: NaiveDate, back: u32) -> NaiveDate {
    let total = d.year() * 12 + d.month0() as i32 - back as i32;
    NaiveDate::from_ymd_opt(total.div_euclid(12), total.rem_euclid(12) as u32 + 1, 1)
        .expect("1-е число есть всегда")
}

fn day(m: NaiveDate, d: u32) -> NaiveDate {
    (1..=d)
        .rev()
        .find_map(|d| m.with_day(d))
        .expect("1-е число есть всегда")
}

fn cat(conn: &Connection, name: &str, kind: &str) -> Result<String> {
    Ok(conn.query_row(
        "SELECT id FROM categories WHERE name = ?1 AND kind = ?2 ORDER BY parent_id IS NULL LIMIT 1",
        [name, kind],
        |r| r.get(0),
    )?)
}

fn account(name: &str, kind: &str, currency: &str, opening: i64, date: &str) -> AccountInput {
    AccountInput {
        name: name.into(),
        kind: kind.into(),
        currency_code: currency.into(),
        opening_balance: opening,
        opening_date: date.into(),
        credit_limit: (kind == "credit").then_some(10_000_000),
        include_in_total: true,
        invest_kind: None,
    }
}

/// Заполнить пустую базу примером: счета, три месяца операций, бюджет,
/// кредит, долг, напоминание, заметка и шаблон.
pub fn seed(conn: &mut Connection, today: &str) -> Result<()> {
    if onboarding::is_done(conn)? {
        return invalid("пример можно открыть только при первом запуске");
    }
    crate::time::check_date(today)?;
    let now = NaiveDate::parse_from_str(today, "%Y-%m-%d").expect("проверено");
    let first = month_start(now, HISTORY_MONTHS);
    let opened = first.to_string();
    let tx = conn.transaction()?;
    settings::set(&tx, "base_currency", "RUB")?;
    settings::set(&tx, "month_start_day", "1")?;
    categories::seed_defaults(&tx)?;
    let cash = accounts::create(&tx, &account("Наличные", "cash", "RUB", 800_000, &opened))?;
    let card = accounts::create(
        &tx,
        &account("Карта Сбер", "debit", "RUB", 1_500_000, &opened),
    )?;
    accounts::create(
        &tx,
        &account("Вклад", "savings", "RUB", 15_000_000, &opened),
    )?;
    let usd = accounts::create(&tx, &account("Доллары", "savings", "USD", 150_000, &opened))?;
    accounts::create(&tx, &account("Кредитка", "credit", "RUB", 0, &opened))?;
    currencies::set_rate(&tx, &opened, "USD", "RUB", "90")?;
    currencies::set_rate(
        &tx,
        &(now - Duration::days(30)).to_string(),
        "USD",
        "RUB",
        "91.5",
    )?;
    currencies::set_rate(&tx, today, "USD", "RUB", "92.4")?;

    // Траты месяца: (день, сумма в копейках, категория, получатель, счёт).
    let plan: &[(u32, i64, &str, &str, bool)] = &[
        (2, 720_000, "Супермаркет", "Пятёрочка", true),
        (4, 600_000, "Кружки", "Школа плавания", true),
        (3, 35_000, "Кафе и рестораны", "Кофейня", false),
        (6, 61_000, "Такси", "Яндекс Go", true),
        (8, 912_000, "Супермаркет", "Перекрёсток", true),
        (10, 650_000, "ЖКХ", "Управляющая компания", true),
        (12, 70_000, "Интернет и связь", "Ростелеком", true),
        (14, 180_000, "Кафе и рестораны", "Шоколадница", true),
        (15, 39_900, "Подписки", "Кинопоиск", true),
        (16, 450_000, "Одежда и обувь", "Lamoda", true),
        (17, 655_000, "Супермаркет", "Лента", true),
        (19, 120_000, "Аптека", "Аптека Ригла", false),
        (21, 250_000, "Топливо", "Лукойл", true),
        (24, 810_000, "Супермаркет", "Пятёрочка", true),
        (26, 290_000, "Кино и театр", "Кинотеатр", true),
        (28, 95_000, "Кафе и рестораны", "Обеды", true),
    ];
    let mk = |kind: &str,
              date: NaiveDate,
              account: &str,
              amount: i64,
              category: &str,
              payee: &str| TxnInput {
        kind: kind.into(),
        date: date.to_string(),
        account_id: account.into(),
        amount,
        category_id: Some(cat(&tx, category, kind).expect("категория из набора по умолчанию")),
        to_account_id: None,
        to_amount: None,
        payee: Some(payee.into()),
        note: None,
    };
    for back in (0..=HISTORY_MONTHS).rev() {
        let m = month_start(now, back);
        // Лёгкий разброс сумм от месяца к месяцу, чтобы отчёты не были плоскими.
        let k = [100, 92, 108, 97][back as usize % 4];
        let salary = day(m, 5);
        if salary <= now {
            transactions::create(
                &tx,
                &mk(
                    "income",
                    salary,
                    &card,
                    8_500_000,
                    "Зарплата",
                    "ООО «Ромашка»",
                ),
            )?;
        }
        let cashback = day(m, 25);
        if cashback <= now {
            transactions::create(
                &tx,
                &mk("income", cashback, &card, 84_000, "Кешбэк и бонусы", "Сбер"),
            )?;
        }
        for &(d, amount, category, payee, on_card) in plan {
            let date = day(m, d);
            if date > now {
                continue;
            }
            let acc = if on_card { &card } else { &cash };
            let amount =
                if category == "ЖКХ" || category == "Подписки" || category == "Интернет и связь"
                {
                    amount
                } else {
                    amount * k / 100
                };
            transactions::create(&tx, &mk("expense", date, acc, amount, category, payee))?;
        }
    }
    // Покупка долларов и снятие наличных.
    let buy = day(month_start(now, 2), 7);
    transactions::create(
        &tx,
        &TxnInput {
            kind: "transfer".into(),
            date: buy.to_string(),
            account_id: card.clone(),
            amount: 2_745_000,
            category_id: None,
            to_account_id: Some(usd),
            to_amount: Some(30_000),
            payee: None,
            note: Some("Покупка валюты".into()),
        },
    )?;
    transactions::create(
        &tx,
        &TxnInput {
            kind: "transfer".into(),
            date: day(month_start(now, 1), 3).to_string(),
            account_id: card.clone(),
            amount: 500_000,
            category_id: None,
            to_account_id: Some(cash),
            to_amount: None,
            payee: None,
            note: Some("Снятие наличных".into()),
        },
    )?;

    templates::create(
        &tx,
        &TemplateInput {
            name: "Кофе".into(),
            kind: "expense".into(),
            amount: Some(25_000),
            account_id: Some(card.clone()),
            to_account_id: None,
            category_id: Some(cat(&tx, "Кафе и рестораны", "expense")?),
            payee: Some("Кофейня".into()),
            note: None,
        },
    )?;
    reminders::create(
        &tx,
        &ReminderInput {
            title: "Оплатить ЖКХ".into(),
            // Ближайшее 10-е число, чтобы пример не начинался с пропущенного напоминания.
            start_at: format!("{}T10:00", {
                let this = day(month_start(now, 0), 10);
                if this >= now {
                    this
                } else {
                    day(
                        month_start(day(month_start(now, 0), 28) + Duration::days(7), 0),
                        10,
                    )
                }
            }),
            repeat: "monthly".into(),
            day_of_month: Some(10),
            amount: Some(650_000),
            txn_type: Some("expense".into()),
            account_id: Some(card.clone()),
            category_id: Some(cat(&tx, "ЖКХ", "expense")?),
            ..Default::default()
        },
    )?;
    // Инвестиции: ИИС, 10 % зарплаты каждый месяц, оценка и дивиденды.
    let iis = accounts::create(
        &tx,
        &AccountInput {
            invest_kind: Some("iis".into()),
            ..account("ИИС", "investment", "RUB", 15_000_000, &opened)
        },
    )?;
    for back in (0..=HISTORY_MONTHS).rev() {
        let date = day(month_start(now, back), 6);
        if date > now {
            continue;
        }
        transactions::create(
            &tx,
            &TxnInput {
                kind: "transfer".into(),
                date: date.to_string(),
                account_id: card.clone(),
                amount: 850_000,
                category_id: None,
                to_account_id: Some(iis.clone()),
                to_amount: None,
                payee: None,
                note: Some("На инвестиции".into()),
            },
        )?;
    }
    crate::invest::set_value(&tx, &iis, &month_start(now, 1).to_string(), 17_420_000)?;
    crate::invest::set_plan(&tx, "percent", 10)?;
    let div = day(month_start(now, 1), 18);
    transactions::create(
        &tx,
        &mk(
            "income",
            div,
            &card,
            124_000,
            "Дивиденды и купоны",
            "Сбер (дивиденды)",
        ),
    )?;
    settings::set(&tx, "onboarding_done", "1")?;
    settings::set(&tx, "demo_data", "1")?;
    // В примере не напоминаем о резервной копии: беречь пока нечего.
    tx.execute(
        "UPDATE settings SET value = ?1 WHERE key = 'last_backup_at'",
        [crate::time::now_utc()],
    )?;
    tx.commit()?;

    // Долги и бюджет создают свои транзакции сами.
    debts::create(
        conn,
        &DebtInput {
            direction: "borrowed".into(),
            counterparty: "Сбербанк (кредит)".into(),
            note: Some("Пример: кредит на машину".into()),
            currency_code: "RUB".into(),
            principal: 30_000_000,
            issue_date: (now - Duration::days(10)).to_string(),
            rate_bp: 1800,
            repayment_type: "annuity".into(),
            term_months: Some(24),
            first_payment_date: None,
            maturity_date: None,
            account_id: None,
            interest_method: None,
            rate_changes: vec![],
            planned_early: vec![],
        },
    )?;
    debts::create(
        conn,
        &DebtInput {
            direction: "lent".into(),
            counterparty: "Иван".into(),
            note: Some("Вернёт до весны".into()),
            currency_code: "RUB".into(),
            principal: 2_000_000,
            issue_date: day(month_start(now, 1), 12).to_string(),
            rate_bp: 0,
            repayment_type: "bullet".into(),
            term_months: None,
            first_payment_date: None,
            maturity_date: Some((now + Duration::days(120)).to_string()),
            account_id: Some(card.clone()),
            interest_method: None,
            rate_changes: vec![],
            planned_early: vec![],
        },
    )?;
    let month = budgets::month_of(conn, today)?.month;
    let budget = budgets::create(conn, &month, false)?;
    budgets::fill(conn, &budget, FillMode::Average3, None)?;
    notes::create(
        conn,
        &NoteInput {
            body: "Это пример. В этом месяце хочу меньше тратить на кафе.".into(),
            budget_id: Some(budget),
            ..Default::default()
        },
    )?;

    // Имущество (с переоценкой) и прошлая поездка со своим бюджетом.
    let asset = |name: &str, kind: &str, value: i64, date: NaiveDate| AssetInput {
        name: name.into(),
        kind: kind.into(),
        currency_code: "RUB".into(),
        value,
        date: date.to_string(),
        note: None,
    };
    let flat = assets::create(conn, &asset("Квартира", "realty", 950_000_000, first))?;
    assets::set_value(conn, &flat, today, 980_000_000)?;
    assets::create(conn, &asset("Машина", "vehicle", 120_000_000, now))?;
    let start = day(month_start(now, 2), 20);
    let trip = events::create(
        conn,
        &EventInput {
            name: "Поездка в Казань".into(),
            start_date: start.to_string(),
            end_date: (start + Duration::days(3)).to_string(),
            budget: Some(4_000_000),
            note: None,
        },
    )?;
    let mut spent = Vec::new();
    for (offset, amount, category, payee) in [
        (0, 1_240_000, "Путешествия", "РЖД"),
        (1, 380_000, "Кафе и рестораны", "Чак-чак"),
        (2, 165_000, "Такси", "Яндекс Go"),
        (3, 520_000, "Путешествия", "Гостиница"),
    ] {
        spent.push(transactions::create(
            conn,
            &mk_expense(
                conn,
                start + Duration::days(offset),
                &card,
                amount,
                category,
                payee,
            )?,
        )?);
    }
    events::assign(conn, Some(&trip), &spent)?;
    Ok(())
}

fn mk_expense(
    conn: &Connection,
    date: NaiveDate,
    account: &str,
    amount: i64,
    category: &str,
    payee: &str,
) -> Result<TxnInput> {
    Ok(TxnInput {
        kind: "expense".into(),
        date: date.to_string(),
        account_id: account.into(),
        amount,
        category_id: Some(cat(conn, category, "expense")?),
        to_account_id: None,
        to_amount: None,
        payee: Some(payee.into()),
        note: None,
    })
}

/// Удалить все данные примера и вернуться к мастеру первого запуска.
pub fn clear(conn: &mut Connection) -> Result<()> {
    if !is_demo(conn)? {
        return invalid("сейчас открыты ваши данные, а не пример");
    }
    let tx = conn.transaction()?;
    // Порядок важен: сначала то, что ссылается на остальное.
    for table in [
        "reminder_occurrences",
        "reminders",
        "notes",
        "debt_payments",
        "debt_schedule",
        "transaction_tags",
        "tags",
        "budget_lines",
        "budgets",
        "transaction_templates",
        "saved_views",
        "payee_rules",
        "asset_values",
        "assets",
        "account_values",
        "invest_month_plans",
        "events",
        "transactions",
        "debts",
        "recurring_rules",
        "categories",
        "accounts",
        "exchange_rates",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    settings::set(&tx, "base_currency", "RUB")?;
    settings::set(&tx, "onboarding_done", "0")?;
    settings::set(&tx, "demo_data", "0")?;
    crate::invest::set_plan(&tx, "", 0)?;
    tx.execute(
        "UPDATE settings SET value = '' WHERE key = 'last_backup_at'",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    #[test]
    fn seed_shows_three_months_and_clear_starts_over() {
        let mut db = Storage::open_in_memory().unwrap();
        seed(db.conn_mut(), "2026-10-20").unwrap();
        let c = db.conn();
        assert!(onboarding::is_done(c).unwrap() && is_demo(c).unwrap());
        assert_eq!(accounts::list(c, false).unwrap().len(), 6);
        let invest = crate::invest::overview(c, "2026-10-20").unwrap();
        // 150 000 ₽ начального остатка и 4 взноса по 8 500 ₽.
        assert_eq!(invest.invested, 18_400_000);
        assert_eq!(invest.month.planned, Some(850_000));
        assert_eq!(invest.month.percent, Some(100));
        assert!(invest.tax.is_some() && invest.passive_income == 124_000);
        assert_eq!(
            crate::assets::total(c, "2026-10-20").unwrap().0,
            1_100_000_000
        );
        let trip = &crate::events::list(c, "2026-10-20").unwrap()[0];
        assert_eq!(
            (trip.count, trip.spent, trip.state.as_str()),
            (4, 2_305_000, "past")
        );
        let b = budgets::get(c, "2026-10", "2026-10-20").unwrap();
        assert!(
            b.id.is_some() && b.planned_expense > 0,
            "бюджет заполнен по среднему"
        );
        let july = crate::reports::period_summary(c, "2026-07-01", "2026-07-31").unwrap();
        assert!(july.expense > 0 && july.income == 8_584_000);
        let future: i64 = c
            .query_row(
                "SELECT count(*) FROM transactions WHERE date > '2026-10-20'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(future, 0, "операций в будущем нет");
        assert!(
            seed(db.conn_mut(), "2026-10-20").is_err(),
            "второй раз нельзя"
        );

        clear(db.conn_mut()).unwrap();
        let c = db.conn();
        assert!(!onboarding::is_done(c).unwrap() && !is_demo(c).unwrap());
        assert!(accounts::list(c, true).unwrap().is_empty());
        let left: i64 = c
            .query_row(
                "SELECT (SELECT count(*) FROM transactions) + (SELECT count(*) FROM debts)
                      + (SELECT count(*) FROM notes) + (SELECT count(*) FROM categories)
                      + (SELECT count(*) FROM assets) + (SELECT count(*) FROM events)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
        assert!(
            clear(db.conn_mut()).is_err(),
            "свои данные так не удаляются"
        );
        // После очистки мастер первого запуска проходит как обычно.
        seed(db.conn_mut(), "2027-01-15").unwrap();
    }

    #[test]
    fn month_arithmetic() {
        let d = NaiveDate::from_ymd_opt(2026, 2, 14).unwrap();
        assert_eq!(month_start(d, 3).to_string(), "2025-11-01");
        assert_eq!(day(month_start(d, 0), 31).to_string(), "2026-02-28");
    }
}
