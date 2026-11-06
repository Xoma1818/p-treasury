//! Тред 35: сверка расчётов новых функций 7б/7в (#81, #82).
//!
//! Отбор отчётов по счёту и тегу, вид «Год» против календаря, горизонты
//! прогноза, «Как быстрее расплатиться» на настоящих долгах.

use budget_core::accounts::{self, AccountInput};
use budget_core::debts::{self, DebtInput};
use budget_core::receipts::{self, PartInput, ReceiptInput};
use budget_core::refunds::{self, RefundInput};
use budget_core::reports::{self, ReportFilter};
use budget_core::storage::Storage;
use budget_core::transactions::{self, TxnInput};
use budget_core::{calendar, categories, currencies, forecast, payoff, tags};
use rusqlite::Connection;

fn acc(c: &Connection, name: &str, cur: &str) -> String {
    accounts::create(
        c,
        &AccountInput {
            name: name.into(),
            kind: "debit".into(),
            currency_code: cur.into(),
            opening_balance: 100_000_000,
            opening_date: "2026-01-01".into(),
            credit_limit: None,
            include_in_total: true,
            invest_kind: None,
        },
    )
    .unwrap()
}

fn cat(c: &Connection, name: &str) -> String {
    c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
        r.get(0)
    })
    .unwrap()
}

fn spend(c: &Connection, acc: &str, date: &str, amount: i64, cat: &str) -> String {
    transactions::create(
        c,
        &TxnInput {
            kind: "expense".into(),
            date: date.into(),
            account_id: acc.into(),
            amount,
            category_id: Some(cat.into()),
            to_account_id: None,
            to_amount: None,
            payee: None,
            note: None,
        },
    )
    .unwrap()
}

fn tag_id(c: &Connection, name: &str) -> String {
    c.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
        .unwrap()
}

fn filter(account: Option<&str>, tag: Option<&str>) -> ReportFilter {
    ReportFilter {
        account_id: account.map(Into::into),
        tag_id: tag.map(Into::into),
    }
}

/// Карта и наличные в рублях, карта в долларах; чек, трата на 3 месяца,
/// покупка с тегом и её возврат.
struct World {
    db: Storage,
    card: String,
    cash: String,
    usd: String,
    tag: String,
}

fn world() -> World {
    let mut db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    categories::seed_defaults(c).unwrap();
    currencies::set_rate(c, "2026-01-01", "USD", "RUB", "92.3456").unwrap();
    let card = acc(c, "Карта", "RUB");
    let cash = acc(c, "Наличные", "RUB");
    let usd = acc(c, "Доллары", "USD");
    let food = cat(c, "Питание");
    spend(c, &card, "2026-10-03", 150_000, &food);
    spend(c, &cash, "2026-10-04", 70_001, &food);
    spend(c, &usd, "2026-10-05", 1, &food);
    spend(c, &usd, "2026-10-05", 1, &food);
    spend(c, &usd, "2026-10-05", 1_999, &food);
    let long = spend(c, &card, "2026-10-10", 100_000, &food);
    transactions::set_spread(c, &long, Some(3)).unwrap();
    let parts = vec![
        PartInput {
            category_id: food.clone(),
            amount: 40_000,
            note: None,
        },
        PartInput {
            category_id: cat(c, "Жильё"),
            amount: 25_000,
            note: None,
        },
    ];
    receipts::create(
        db.conn_mut(),
        &ReceiptInput {
            date: "2026-10-12".into(),
            account_id: card.clone(),
            payee: Some("Ашан".into()),
            note: None,
            total: 65_000,
            parts,
            tags: vec!["дача".into()],
            event_id: None,
        },
    )
    .unwrap();
    let c = db.conn();
    let mower = spend(c, &card, "2026-10-15", 300_000, &cat(c, "Жильё"));
    tags::set_for(c, &mower, &["дача".to_string()]).unwrap();
    // Газонокосилку вернули на наличные, в месяце покупки.
    refunds::create(
        c,
        &RefundInput {
            of: mower,
            date: "2026-10-20".into(),
            account_id: Some(cash.clone()),
            amount: 300_000,
            in_purchase_month: true,
            note: None,
        },
    )
    .unwrap();
    // Перевод с карты на долларовый счёт.
    transactions::create(
        c,
        &TxnInput {
            kind: "transfer".into(),
            date: "2026-10-18".into(),
            account_id: card.clone(),
            amount: 923_456,
            category_id: None,
            to_account_id: Some(usd.clone()),
            to_amount: Some(10_000),
            payee: None,
            note: None,
        },
    )
    .unwrap();
    let tag = tag_id(c, "дача");
    World {
        db,
        card,
        cash,
        usd,
        tag,
    }
}

const FROM: &str = "2026-10-01";
const TO: &str = "2026-10-31";

#[test]
fn filtered_reports_add_up_to_unfiltered() {
    let w = world();
    let c = w.db.conn();
    let total = |f: &ReportFilter| {
        reports::by_category_in(c, "expense", FROM, TO, f)
            .unwrap()
            .total
    };
    let all = total(&filter(None, None));
    let parts: i64 = [&w.card, &w.cash, &w.usd]
        .iter()
        .map(|a| total(&filter(Some(a), None)))
        .sum();
    assert_eq!(parts, all, "сумма по счетам = итог без отбора");
    // «Структура» и «По месяцам» с одним отбором показывают одно и то же.
    for f in [
        filter(None, None),
        filter(Some(&w.card), None),
        filter(Some(&w.cash), None),
        filter(Some(&w.usd), None),
        filter(None, Some(&w.tag)),
    ] {
        let m = reports::by_month_in(c, "2026-10", "2026-10", &f).unwrap();
        assert_eq!(m.expense, total(&f), "{f:?}");
    }
}

#[test]
fn tag_filter_counts_refund_of_tagged_purchase() {
    // Газонокосилка с тегом «дача» возвращена целиком: по тегу остаётся только чек.
    let w = world();
    let c = w.db.conn();
    let by_tag = reports::by_category_in(c, "expense", FROM, TO, &filter(None, Some(&w.tag)))
        .unwrap()
        .total;
    assert_eq!(by_tag, 65_000);
    let m = reports::by_month_in(c, "2026-10", "2026-10", &filter(None, Some(&w.tag))).unwrap();
    assert_eq!(m.expense, 65_000);
    assert_eq!(tags::report(c, &w.tag, FROM, TO).unwrap().expense, 65_000);
}

#[test]
fn year_heat_matches_calendar_days() {
    // Три траты в долларах в один день по дробному курсу: «Год» и день календаря
    // должны показать одну сумму до копейки.
    let w = world();
    let c = w.db.conn();
    let heat = calendar::year_heat(c, 2026).unwrap();
    let month = calendar::month(c, "2026-10", "2026-10-31").unwrap();
    for day in &month.days {
        let h = heat.days.iter().find(|d| d.date == day.date).unwrap();
        assert_eq!(h.expense, day.expense, "{}", day.date);
    }
}

#[test]
fn day_balances_match_account_totals() {
    let w = world();
    let c = w.db.conn();
    let first = chrono::NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
    let last = chrono::NaiveDate::from_ymd_opt(2026, 10, 31).unwrap();
    let b = calendar::balances(c, first, last, "2026-10-25").unwrap();
    assert_eq!(b[30].balance, None);
    // Каждый прошедший день — как общий баланс на Главной на эту дату.
    for day in b.iter().filter(|d| d.date.as_str() <= "2026-10-25") {
        assert_eq!(
            day.balance,
            Some(accounts::totals(c, &day.date).unwrap().total),
            "{}",
            day.date
        );
    }
    // С переходом через месяц и началом раньше первой операции.
    let first = chrono::NaiveDate::from_ymd_opt(2025, 12, 20).unwrap();
    let last = chrono::NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
    for day in calendar::balances(c, first, last, "2026-10-25").unwrap() {
        assert_eq!(
            day.balance,
            Some(accounts::totals(c, &day.date).unwrap().total)
        );
    }
}

#[test]
fn every_horizon_starts_like_the_year_forecast() {
    let mut db = Storage::open_in_memory().unwrap();
    budget_core::demo::seed(db.conn_mut(), "2026-10-20").unwrap();
    let c = db.conn();
    let year = forecast::forecast(c, "2026-10-20", None).unwrap();
    for h in forecast::HORIZONS {
        let f = forecast::forecast_for(c, "2026-10-20", None, h).unwrap();
        assert_eq!(f.months.len(), h);
        for i in 0..h.min(12) {
            assert_eq!(f.months[i].closing, year.months[i].closing, "h={h} i={i}");
        }
        for pair in f.months.windows(2) {
            assert_eq!(
                pair[1].month,
                budget_core::budgets::shift_month(&pair[0].month, 1).unwrap()
            );
        }
    }
}

fn borrow(
    db: &mut Storage,
    name: &str,
    principal: i64,
    rate: i64,
    term: u32,
    every: &str,
    kind: &str,
) -> String {
    let card: String = db
        .conn()
        .query_row(
            "SELECT id FROM accounts WHERE name = 'Карта'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    debts::create(
        db.conn_mut(),
        &DebtInput {
            direction: "borrowed".into(),
            counterparty: name.into(),
            note: None,
            currency_code: "RUB".into(),
            principal,
            issue_date: "2026-10-01".into(),
            rate_bp: rate,
            repayment_type: kind.into(),
            term_months: Some(term),
            first_payment_date: None,
            maturity_date: None,
            account_id: Some(card),
            interest_method: None,
            rate_period: None,
            pay_every: Some(every.into()),
            rate_changes: vec![],
            planned_early: vec![],
        },
    )
    .unwrap()
}

/// Обычными платежами долг закрывается по своему графику: месяц свободы
/// «без лишних денег» — месяц последнего платежа графика (±1 месяц на упрощение).
#[test]
fn payoff_base_matches_schedule_for_every_kind() {
    for (every, kind, term) in [
        ("month", "annuity", 12u32),
        ("month", "differentiated", 12),
        ("quarter", "annuity", 4),
        ("two_weeks", "annuity", 26),
    ] {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        acc(db.conn(), "Карта", "RUB");
        let id = borrow(&mut db, "Банк", 12_000_000, 1500, term, every, kind);
        let c = db.conn();
        let card = debts::list(c, "2026-10-01")
            .unwrap()
            .into_iter()
            .find(|d| d.id == id)
            .unwrap();
        let last = &card.maturity_date[..7];
        let p = payoff::for_debts(c, "2026-10-01", 0, "costly").unwrap();
        let free = p.base_free_month.clone().unwrap_or_default();
        let gap = month_gap(&free, last);
        assert!(
            gap.abs() <= 1,
            "{every}/{kind}: свобода {free}, график до {last}"
        );
    }
}

fn month_gap(a: &str, b: &str) -> i32 {
    let n = |s: &str| s[..4].parse::<i32>().unwrap() * 12 + s[5..7].parse::<i32>().unwrap();
    if a.is_empty() {
        return 999;
    }
    n(a) - n(b)
}

/// Сквозная сверка: возврат, чек, трата на 3 месяца и доллары переносятся через
/// свою выгрузку CSV/Excel в новый бюджет с теми же цифрами отчётов, а
/// загруженная обратно в тот же бюджет — ничего не добавляет.
#[test]
fn refund_receipt_spread_survive_export_roundtrip() {
    use budget_core::{csv_import, export};
    let totals = |c: &Connection| {
        let s = reports::period_summary(c, "2026-01-01", "2027-12-31").unwrap();
        let cats = reports::by_category(c, "expense", "2026-01-01", "2027-12-31").unwrap();
        let mut by_name: Vec<(String, i64)> = cats
            .items
            .iter()
            .map(|r| (r.name.clone(), r.amount))
            .collect();
        by_name.sort();
        (s.income, s.expense, by_name)
    };
    for ext in ["csv", "xlsx"] {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = world();
        let before = totals(w.db.conn());
        let sheet =
            export::transactions_sheet(w.db.conn(), &transactions::Filter::default()).unwrap();
        let file = tmp.path().join(format!("Операции.{ext}"));
        if ext == "csv" {
            export::write_one(&file, &sheet).unwrap();
        } else {
            export::write_xlsx(&file, std::slice::from_ref(&sheet)).unwrap();
        }
        // В тот же бюджет: всё узнаётся.
        let p = csv_import::preview(w.db.conn(), &file, None).unwrap();
        assert_eq!(p.duplicates, p.rows.len(), "{ext}: {:#?}", p.rows);
        csv_import::import(w.db.conn_mut(), &file, false, None).unwrap();
        assert_eq!(totals(w.db.conn()), before, "{ext}: повторная загрузка");
        // В новый бюджет с теми же счетами.
        let mut twin = Storage::open_in_memory().unwrap();
        let c = twin.conn();
        categories::seed_defaults(c).unwrap();
        currencies::set_rate(c, "2026-01-01", "USD", "RUB", "92.3456").unwrap();
        for (n, cur) in [("Карта", "RUB"), ("Наличные", "RUB"), ("Доллары", "USD")]
        {
            acc(c, n, cur);
        }
        csv_import::import(twin.conn_mut(), &file, true, None).unwrap();
        assert_eq!(totals(twin.conn()), before, "{ext}: перенос в новый бюджет");
    }
}

type Step = dyn Fn(&mut Connection) -> budget_core::Result<()>;

/// Создание → изменение → отмена → повтор для возврата, чека и платежа по долгу:
/// балансы, отчёты, тег и «Как быстрее расплатиться» на каждом шаге как до шага.
#[test]
fn undo_redo_chain_with_refund_receipt_and_debt() {
    use budget_core::undo::Journal;
    let mut w = world();
    let mut j = Journal::default();
    let debt = borrow(&mut w.db, "Банк", 12_000_000, 1500, 12, "month", "annuity");
    let tag = w.tag.clone();
    let state = |c: &Connection| {
        let t = accounts::totals(c, "2026-12-31").unwrap().total;
        let m = reports::by_month(c, "2026-10", "2026-12").unwrap();
        let by_tag = tags::report(c, &tag, FROM, TO).unwrap().expense;
        let p = payoff::for_debts(c, "2026-10-01", 100_000, "costly").unwrap();
        format!(
            "{t} {} {} {by_tag} {:?} {}",
            m.income, m.expense, p.free_month, p.interest
        )
    };
    let refund_id: String =
        w.db.conn()
            .query_row("SELECT id FROM transactions WHERE refund = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
    let split: String =
        w.db.conn()
            .query_row(
                "SELECT split_id FROM transactions WHERE split_id IS NOT NULL LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
    let mower: String =
        w.db.conn()
            .query_row(
                "SELECT refund_of FROM transactions WHERE refund = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
    let (cash, card) = (w.cash.clone(), w.card.clone());
    let next = debts::get(w.db.conn(), &debt, "2026-10-01")
        .unwrap()
        .card
        .next_payment
        .unwrap();
    let steps: Vec<Box<Step>> = vec![
        Box::new(move |c| {
            refunds::update(
                c,
                &refund_id,
                &RefundInput {
                    of: mower.clone(),
                    date: "2026-11-02".into(),
                    account_id: Some(cash.clone()),
                    amount: 120_000,
                    in_purchase_month: false,
                    note: None,
                },
            )
        }),
        Box::new(move |c| receipts::delete(c, &split)),
        Box::new(move |c| {
            debts::pay(
                c,
                &debt,
                &debts::PaymentInput {
                    date: next.due_date.clone(),
                    account_id: card.clone(),
                    principal: next.principal_part,
                    interest: next.interest_part,
                    schedule_id: Some(next.id.clone()),
                    recalc_mode: None,
                },
            )
            .map(|_| ())
        }),
    ];
    for (i, step) in steps.iter().enumerate() {
        let before = state(w.db.conn());
        j.record(w.db.conn_mut(), "шаг", |c| step(c)).unwrap();
        let after = state(w.db.conn());
        assert_ne!(before, after, "шаг {i} ничего не изменил");
        j.undo(w.db.conn_mut()).unwrap().unwrap();
        assert_eq!(state(w.db.conn()), before, "шаг {i}: отмена");
        j.redo(w.db.conn_mut()).unwrap().unwrap();
        assert_eq!(state(w.db.conn()), after, "шаг {i}: повтор");
    }
}
