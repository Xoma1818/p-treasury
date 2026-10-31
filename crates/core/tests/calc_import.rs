//! Этап 2б проверки: согласованность расчётов и импорта (тред 27).
//!
//! Итоги примера сходятся во всех отчётах при разных днях начала месяца,
//! валюты считаются одинаково, импорт выписки не задваивает и честно
//! отменяется, отмена действий и займы сходятся с ожиданием.
//! Тесты с `#[ignore = "R-ошибка: …"]` воспроизводят найденные ошибки.

use budget_core::storage::Storage;
use budget_core::{budgets, currencies, explain, export, reports, settings};
use rusqlite::Connection;

const AS_OF: &str = "2026-10-20";

fn demo() -> Storage {
    let mut db = Storage::open_in_memory().unwrap();
    budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
    db
}

fn scalar_i64(c: &Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn scalar_str(c: &Connection, sql: &str) -> String {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// Месяцы бюджета от первой операции примера до месяца после `AS_OF`.
fn demo_months(c: &Connection) -> Vec<String> {
    let first = scalar_str(c, "SELECT min(date) FROM transactions");
    let mut m = budgets::month_of(c, &first).unwrap().month;
    let last = budgets::shift_month(&budgets::month_of(c, AS_OF).unwrap().month, 2).unwrap();
    let mut out = Vec::new();
    while m <= last {
        out.push(m.clone());
        m = budgets::shift_month(&m, 1).unwrap();
    }
    out
}

/// Независимый подсчёт: доходы и расходы периода прямо по `transactions`,
/// трата на N месяцев делится в Rust так же, как описано в миграции 0010.
fn oracle(c: &Connection, from: &str, to: &str) -> (i64, i64) {
    let base = currencies::base_currency(c).unwrap();
    let mut stmt = c
        .prepare(
            "SELECT t.type, t.date, t.amount, a.currency_code, t.spread_months
             FROM transactions t JOIN accounts a ON a.id = t.account_id
             WHERE t.status = 'cleared' AND t.type IN ('income', 'expense')",
        )
        .unwrap();
    let rows: Vec<(String, String, i64, String, Option<i64>)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let (mut inc, mut exp) = (0, 0);
    for (kind, date, amount, cur, spread) in rows {
        let n = spread.unwrap_or(1);
        for k in 0..n {
            let part_date = if k == 0 {
                date.clone()
            } else {
                let d = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").unwrap();
                d.checked_add_months(chrono::Months::new(k as u32))
                    .unwrap()
                    .to_string()
            };
            if part_date.as_str() < from || part_date.as_str() > to {
                continue;
            }
            let part = if k == 0 {
                amount - (amount / n) * (n - 1)
            } else {
                amount / n
            };
            let v = currencies::convert(c, part, &cur, &base, &part_date)
                .unwrap()
                .expect("в примере курсы есть");
            if kind == "income" {
                inc += v;
            } else {
                exp += v;
            }
        }
    }
    (inc, exp)
}

fn check_month_consistency(c: &Connection) {
    let months = demo_months(c);
    let by_month = reports::by_month(c, &months[0], months.last().unwrap()).unwrap();
    assert_eq!(by_month.months.len(), months.len());
    let mut sum_inc = 0;
    let mut sum_exp = 0;
    for (m, row) in months.iter().zip(&by_month.months) {
        let p = reports::period_of(c, "month", m).unwrap();
        assert_eq!(row.period, p, "{m}");
        let s = reports::period_summary(c, &p.start, &p.end).unwrap();
        assert!(s.missing_rates.is_empty(), "{m}: {:?}", s.missing_rates);
        assert_eq!((row.income, row.expense), (s.income, s.expense), "{m}");
        assert_eq!(oracle(c, &p.start, &p.end), (s.income, s.expense), "{m}");
        sum_inc += s.income;
        sum_exp += s.expense;

        for (kind, total) in [("expense", s.expense), ("income", s.income)] {
            let cat = reports::by_category(c, kind, &p.start, &p.end).unwrap();
            assert_eq!(cat.total, total, "{m} {kind}: by_category.total");
            let items: i64 = cat.items.iter().map(|i| i.amount).sum();
            assert_eq!(items, total, "{m} {kind}: сумма строк по категориям");
            for i in &cat.items {
                if !i.children.is_empty() {
                    let ch: i64 = i.children.iter().map(|x| x.amount).sum();
                    assert_eq!(ch, i.amount, "{m} {kind}: подкатегории {}", i.name);
                }
            }
            let ex = explain::period(c, &p.start, &p.end, kind).unwrap();
            assert_eq!(ex.total, total, "{m} {kind}: explain.total");
            let parts: i64 = ex.categories.iter().map(|x| x.amount).sum();
            assert_eq!(parts, total, "{m} {kind}: explain по категориям");
            assert_eq!(ex.adjustments, s.adjustments, "{m}: корректировки");
        }

        let b = budgets::get(c, m, AS_OF).unwrap();
        assert_eq!(b.period, p, "{m}: период бюджета");
        assert_eq!(b.actual_income, s.income, "{m}: доходы бюджета");
        assert_eq!(
            b.actual_expense + b.event_expense,
            s.expense,
            "{m}: расходы бюджета + события = расходы отчёта"
        );
        for l in &b.lines {
            assert_eq!(l.remaining, l.limit - l.actual);
        }

        let wb = export::summary_workbook(c, &p.start, &p.end, AS_OF).unwrap();
        let money = |label: &str| -> i64 {
            wb[0]
                .rows
                .iter()
                .find_map(|r| match (r.first(), r.get(1)) {
                    (Some(export::Cell::Text(t)), Some(export::Cell::Money(v, _)))
                        if t == label =>
                    {
                        Some(*v)
                    }
                    _ => None,
                })
                .unwrap()
        };
        assert_eq!(money("Доходы"), s.income, "{m}: выгрузка, доходы");
        assert_eq!(money("Расходы"), s.expense, "{m}: выгрузка, расходы");
        assert_eq!(money("Корректировки"), s.adjustments);
    }
    assert_eq!((by_month.income, by_month.expense), (sum_inc, sum_exp));
    // Год целиком = сумма месяцев (трата на 12 месяцев частично уходит в следующий год).
    let all = reports::period_summary(
        c,
        &reports::period_of(c, "month", &months[0]).unwrap().start,
        &reports::period_of(c, "month", months.last().unwrap())
            .unwrap()
            .end,
    )
    .unwrap();
    assert_eq!((all.income, all.expense), (sum_inc, sum_exp));
}

/// Запланированные расход и доход, корректировка и долларовая трата поверх примера.
fn add_planned_and_adjustment(c: &Connection) {
    let card = scalar_str(c, "SELECT id FROM accounts WHERE currency_code = 'RUB' AND type IN ('debit', 'credit') LIMIT 1");
    let usd = scalar_str(
        c,
        "SELECT id FROM accounts WHERE currency_code = 'USD' LIMIT 1",
    );
    let food = scalar_str(
        c,
        "SELECT id FROM categories WHERE kind = 'expense' AND parent_id IS NULL LIMIT 1",
    );
    let inc = scalar_str(
        c,
        "SELECT id FROM categories WHERE kind = 'income' AND parent_id IS NULL LIMIT 1",
    );
    for (kind, acc, cat, date) in [
        ("expense", &card, &food, "2026-10-26"),
        ("income", &card, &inc, "2026-09-26"),
    ] {
        let id = txn(c, kind, date, acc, 777_777, Some(cat));
        c.execute(
            "UPDATE transactions SET status = 'planned' WHERE id = ?1",
            [&id],
        )
        .unwrap();
    }
    let bal = budget_core::accounts::balance(c, &card, Some("2026-09-24")).unwrap();
    budget_core::accounts::adjust_balance(c, &card, bal - 12_345, "2026-09-24", None)
        .unwrap()
        .unwrap();
    txn(c, "expense", "2026-09-25", &usd, 4_321, Some(&food));
}

#[test]
fn demo_totals_agree_everywhere_start_day_1() {
    let db = demo();
    let c = db.conn();
    // В примере есть всё, что проверяется: перевод, план, разнос, чек, событие.
    assert!(
        scalar_i64(
            c,
            "SELECT count(*) FROM transactions WHERE type = 'transfer'"
        ) > 0
    );
    assert!(
        scalar_i64(
            c,
            "SELECT count(*) FROM transactions WHERE spread_months IS NOT NULL"
        ) > 0
    );
    assert!(
        scalar_i64(
            c,
            "SELECT count(*) FROM transactions WHERE split_id IS NOT NULL"
        ) > 0
    );
    assert!(
        scalar_i64(
            c,
            "SELECT count(*) FROM transactions WHERE event_id IS NOT NULL"
        ) > 0
    );
    add_planned_and_adjustment(c);
    check_month_consistency(c);
}

#[test]
fn demo_totals_agree_everywhere_start_day_25_and_31() {
    for day in ["25", "31", "15"] {
        let db = demo();
        let c = db.conn();
        settings::set(c, "month_start_day", day).unwrap();
        add_planned_and_adjustment(c);
        check_month_consistency(c);
    }
}

/// Минимальная база: категории по умолчанию, рублёвая карта и долларовый счёт.
struct Fx {
    db: Storage,
    rub: String,
    usd: String,
    food: String,
    salary: String,
}

fn account(c: &Connection, name: &str, cur: &str, opening: i64) -> String {
    budget_core::accounts::create(
        c,
        &budget_core::accounts::AccountInput {
            name: name.into(),
            kind: "debit".into(),
            currency_code: cur.into(),
            opening_balance: opening,
            opening_date: "2026-01-01".into(),
            credit_limit: None,
            include_in_total: true,
            invest_kind: None,
        },
    )
    .unwrap()
}

fn cat_id(c: &Connection, name: &str) -> String {
    c.query_row(
        "SELECT id FROM categories WHERE name = ?1 AND parent_id IS NULL",
        [name],
        |r| r.get(0),
    )
    .unwrap()
}

fn fx() -> Fx {
    let db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    budget_core::categories::seed_defaults(c).unwrap();
    let rub = account(c, "Карта", "RUB", 10_000_000);
    let usd = account(c, "Доллары", "USD", 100_000);
    let food = cat_id(c, "Продукты");
    let salary = cat_id(c, "Зарплата");
    Fx {
        db,
        rub,
        usd,
        food,
        salary,
    }
}

fn txn(
    c: &Connection,
    kind: &str,
    date: &str,
    account: &str,
    amount: i64,
    category: Option<&str>,
) -> String {
    budget_core::transactions::create(
        c,
        &budget_core::transactions::TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: account.into(),
            amount,
            category_id: category.map(Into::into),
            to_account_id: None,
            to_amount: None,
            payee: None,
            note: None,
        },
    )
    .unwrap()
}

#[test]
fn currency_rounding_same_in_all_reports() {
    let f = fx();
    let c = f.db.conn();
    // Курс с дробью: каждая операция округляется, сумма округлений не равна
    // округлению суммы. Все отчёты должны округлять одинаково — по операции.
    currencies::set_rate(c, "2026-01-01", "USD", "RUB", "92.3456").unwrap();
    currencies::set_rate(c, "2026-03-15", "RUB", "USD", "0.0107").unwrap();
    for (i, d) in ["2026-03-02", "2026-03-10", "2026-03-20", "2026-03-28"]
        .iter()
        .enumerate()
    {
        txn(c, "expense", d, &f.usd, 1 + i as i64 * 7, Some(&f.food));
        txn(c, "expense", d, &f.rub, 333, Some(&f.food));
    }
    txn(c, "income", "2026-03-05", &f.usd, 12_345, Some(&f.salary));
    let s = reports::period_summary(c, "2026-03-01", "2026-03-31").unwrap();
    let cat = reports::by_category(c, "expense", "2026-03-01", "2026-03-31").unwrap();
    let ex = explain::period(c, "2026-03-01", "2026-03-31", "expense").unwrap();
    let b = budgets::get(c, "2026-03", "2026-03-31").unwrap();
    assert_eq!(s.expense, cat.total);
    assert_eq!(s.expense, ex.total);
    assert_eq!(s.expense, b.actual_expense);
    assert_eq!(oracle(c, "2026-03-01", "2026-03-31"), (s.income, s.expense));
    // До 15-го прямой курс, после — обратный (последний по дате).
    assert_eq!(
        currencies::convert(c, 100, "USD", "RUB", "2026-03-10").unwrap(),
        Some(9235)
    );
    assert_eq!(
        currencies::convert(c, 100, "USD", "RUB", "2026-03-20").unwrap(),
        Some(9346)
    );
}

#[test]
fn missing_rate_reported_same_way_everywhere() {
    let f = fx();
    let c = f.db.conn();
    txn(c, "expense", "2026-03-02", &f.rub, 50_000, Some(&f.food));
    txn(c, "expense", "2026-03-03", &f.usd, 1_000, Some(&f.food));
    let s = reports::period_summary(c, "2026-03-01", "2026-03-31").unwrap();
    let cat = reports::by_category(c, "expense", "2026-03-01", "2026-03-31").unwrap();
    let ex = explain::period(c, "2026-03-01", "2026-03-31", "expense").unwrap();
    let b = budgets::get(c, "2026-03", "2026-03-31").unwrap();
    let m = reports::by_month(c, "2026-03", "2026-03").unwrap();
    for (name, v, miss) in [
        ("summary", s.expense, &s.missing_rates),
        ("category", cat.total, &cat.missing_rates),
        ("explain", ex.total, &ex.missing_rates),
        ("budget", b.actual_expense, &b.missing_rates),
        ("months", m.expense, &m.missing_rates),
    ] {
        assert_eq!(v, 50_000, "{name}");
        assert_eq!(miss, &vec!["USD".to_string()], "{name}");
    }
}

#[test]
/// B1 (исправлено): расходы событий без курса молча терялись, missing_rates был пуст.
fn event_expense_without_rate_is_reported() {
    let f = fx();
    let c = f.db.conn();
    let trip = budget_core::events::create(
        c,
        &budget_core::events::EventInput {
            name: "Поездка".into(),
            start_date: "2026-03-01".into(),
            end_date: "2026-03-10".into(),
            budget: None,
            note: None,
        },
    )
    .unwrap();
    let id = txn(c, "expense", "2026-03-03", &f.usd, 1_000, Some(&f.food));
    budget_core::events::assign(c, Some(&trip), &[id]).unwrap();
    let s = reports::period_summary(c, "2026-03-01", "2026-03-31").unwrap();
    assert_eq!(s.missing_rates, vec!["USD".to_string()]);
    let b = budgets::get(c, "2026-03", "2026-03-31").unwrap();
    // Отчёт честно говорит «не вошло: USD», бюджет — нет.
    assert_eq!(b.missing_rates, vec!["USD".to_string()]);
}

// ---------- Импорт выписки ----------

const TBANK_HEAD: &str = "\"Дата операции\";\"Дата платежа\";\"Номер карты\";\"Статус\";\"Сумма операции\";\"Валюта операции\";\"Сумма платежа\";\"Валюта платежа\";\"Кэшбэк\";\"Категория\";\"MCC\";\"Описание\"";

/// Строка выписки: дата `ДД.ММ.ГГГГ`, карта, сумма со знаком, категория банка, описание.
fn op(date: &str, card: &str, sum: &str, cat: &str, desc: &str) -> String {
    format!(
        "\"{date} 12:00:00\";\"{date}\";\"*{card}\";\"OK\";\"{sum}\";\"RUB\";\"{sum}\";\"RUB\";\"\";\"{cat}\";\"\";\"{desc}\""
    )
}

fn statement(dir: &std::path::Path, name: &str, rows: &[String]) -> std::path::PathBuf {
    let p = dir.join(name);
    let mut text = String::from(TBANK_HEAD);
    for r in rows {
        text.push('\n');
        text.push_str(r);
    }
    std::fs::write(&p, text).unwrap();
    p
}

struct Bank {
    db: Storage,
    dir: tempfile::TempDir,
    card: String,
    other: String,
}

fn bank() -> Bank {
    let db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    budget_core::categories::seed_defaults(c).unwrap();
    let card = account(c, "Т-Банк *1140", "RUB", 10_000_000);
    let other = account(c, "Т-Банк *8305", "RUB", 5_000_000);
    Bank {
        db,
        dir: tempfile::tempdir().unwrap(),
        card,
        other,
    }
}

fn import(b: &mut Bank, file: &std::path::Path) -> budget_core::import_log::Saved {
    budget_core::csv_import::import(b.db.conn_mut(), file, false, None).unwrap()
}

fn count(c: &Connection) -> i64 {
    scalar_i64(c, "SELECT count(*) FROM transactions")
}

/// Итоги, по которым видно, что импорт и его отмена ничего не потеряли.
fn snapshot(c: &Connection) -> (i64, i64, i64, Vec<i64>) {
    let s = reports::period_summary(c, "2026-01-01", "2026-12-31").unwrap();
    let bal = reports::balances_on(c, "2026-12-31").unwrap();
    (
        s.income,
        s.expense,
        count(c),
        bal.rows.iter().map(|r| r.balance).collect(),
    )
}

#[test]
fn reimport_same_statement_adds_nothing() {
    let mut b = bank();
    let rows = vec![
        op("01.10.2026", "1140", "-350,00", "Рестораны", "KAFE"),
        op(
            "02.10.2026",
            "1140",
            "-1053,77",
            "Супермаркеты",
            "Пятерочка",
        ),
        op("03.10.2026", "1140", "85000,00", "Зарплата", "Зарплата"),
    ];
    let f = statement(b.dir.path(), "a.csv", &rows);
    let first = import(&mut b, &f);
    assert_eq!(first.added, 3);
    let before = snapshot(b.db.conn());
    let again = import(&mut b, &f);
    assert_eq!(again.added, 0);
    assert_eq!(snapshot(b.db.conn()), before);
    let h = budget_core::import_log::history(b.db.conn(), 10).unwrap();
    assert_eq!(h[0].skipped, 3);
}

#[test]
fn two_same_purchases_in_one_file_both_saved() {
    let mut b = bank();
    let coffee = op("01.10.2026", "1140", "-350,00", "Рестораны", "KAFE");
    let f = statement(b.dir.path(), "a.csv", &[coffee.clone(), coffee.clone()]);
    assert_eq!(import(&mut b, &f).added, 2);
    let s = reports::period_summary(b.db.conn(), "2026-10-01", "2026-10-31").unwrap();
    assert_eq!(s.expense, 70_000);
    // Тот же файл ещё раз — ни одной новой.
    assert_eq!(import(&mut b, &f).added, 0);
}

#[test]
fn overlapping_statement_keeps_second_same_purchase() {
    let mut b = bank();
    let coffee = op("01.10.2026", "1140", "-350,00", "Рестораны", "KAFE");
    // Выписка, скачанная утром: одна покупка кофе. Вечером — две.
    let morning = statement(b.dir.path(), "morning.csv", std::slice::from_ref(&coffee));
    let evening = statement(b.dir.path(), "evening.csv", &[coffee.clone(), coffee]);
    assert_eq!(import(&mut b, &morning).added, 1);
    assert_eq!(
        import(&mut b, &evening).added,
        1,
        "вторая покупка должна добавиться"
    );
    let s = reports::period_summary(b.db.conn(), "2026-10-01", "2026-10-31").unwrap();
    assert_eq!(s.expense, 70_000);
}

#[test]
#[ignore = "R-ошибка B3: после правки получателя у загруженной операции повторная выписка добавляет её второй раз"]
fn reimport_after_renaming_payee_adds_nothing() {
    let mut b = bank();
    let f = statement(
        b.dir.path(),
        "a.csv",
        &[op(
            "01.10.2026",
            "1140",
            "-350,00",
            "Рестораны",
            "KAFE DEDUSHKA KHO",
        )],
    );
    assert_eq!(import(&mut b, &f).added, 1);
    let c = b.db.conn();
    let id = scalar_str(c, "SELECT id FROM transactions");
    let t = budget_core::transactions::get(c, &id).unwrap();
    budget_core::transactions::update(
        c,
        &id,
        &budget_core::transactions::TxnInput {
            kind: t.kind.clone(),
            date: t.date.clone(),
            account_id: t.account_id.clone(),
            amount: t.amount,
            category_id: t.category_id.clone(),
            to_account_id: None,
            to_amount: None,
            payee: Some("Кафе «Дедушка Хо»".into()),
            note: None,
        },
    )
    .unwrap();
    assert_eq!(import(&mut b, &f).added, 0);
    assert_eq!(count(b.db.conn()), 1);
}

#[test]
fn undo_import_returns_totals_and_keeps_manual() {
    let mut b = bank();
    let food = cat_id(b.db.conn(), "Продукты");
    // Ручная запись, которую выписка узнает и свяжет.
    let manual = txn(
        b.db.conn(),
        "expense",
        "2026-10-01",
        &b.card,
        105_377,
        Some(&food),
    );
    let before = snapshot(b.db.conn());
    let f = statement(
        b.dir.path(),
        "a.csv",
        &[
            op(
                "02.10.2026",
                "1140",
                "-1053,77",
                "Супермаркеты",
                "Пятерочка",
            ),
            op("03.10.2026", "1140", "-500,00", "Рестораны", "KAFE"),
            op("03.10.2026", "1140", "-500,00", "Рестораны", "KAFE"),
            op("04.10.2026", "8305", "20000,00", "Зарплата", "Зарплата"),
        ],
    );
    let saved = import(&mut b, &f);
    assert_eq!((saved.added, saved.linked), (3, 1));
    let s = reports::period_summary(b.db.conn(), "2026-10-01", "2026-10-31").unwrap();
    assert_eq!((s.income, s.expense), (2_000_000, 105_377 + 100_000));
    // Пользователь поправил категорию загруженной операции — это всё ещё
    // операция импорта: отмена её убирает (так задумано, 0.22).
    let n = budget_core::import_log::undo(b.db.conn(), &saved.import_id).unwrap();
    assert_eq!(n, 3);
    assert_eq!(snapshot(b.db.conn()), before);
    assert!(budget_core::transactions::get(b.db.conn(), &manual).is_ok());
    // Связь забыта: повторная загрузка снова свяжет, а не задвоит.
    let again = import(&mut b, &f);
    assert_eq!((again.added, again.linked), (3, 1));
}

#[test]
fn receipt_matched_by_statement_survives_undo() {
    let mut b = bank();
    let c = b.db.conn();
    let food = cat_id(c, "Продукты");
    let home = cat_id(c, "Подарки");
    let split = budget_core::receipts::create(
        b.db.conn_mut(),
        &budget_core::receipts::ReceiptInput {
            date: "2026-10-02".into(),
            account_id: b.card.clone(),
            payee: Some("Ашан".into()),
            note: None,
            total: 300_000,
            parts: vec![
                budget_core::receipts::PartInput {
                    category_id: food.clone(),
                    amount: 200_000,
                    note: None,
                },
                budget_core::receipts::PartInput {
                    category_id: home,
                    amount: 100_000,
                    note: None,
                },
            ],
            tags: vec![],
            event_id: None,
        },
    )
    .unwrap();
    let before = snapshot(b.db.conn());
    let f = statement(
        b.dir.path(),
        "a.csv",
        &[op(
            "02.10.2026",
            "1140",
            "-3000,00",
            "Супермаркеты",
            "AUCHAN",
        )],
    );
    let saved = import(&mut b, &f);
    assert_eq!((saved.added, saved.linked), (0, 1));
    assert_eq!(snapshot(b.db.conn()), before);
    // Чек переписан после связи — повтор выписки всё равно не задваивает.
    let r = budget_core::receipts::get(b.db.conn(), &split).unwrap();
    assert_eq!(r.parts.len(), 2);
    assert_eq!(import(&mut b, &f).added, 0);
    budget_core::import_log::undo(b.db.conn(), &saved.import_id).unwrap();
    assert_eq!(snapshot(b.db.conn()), before);
    assert_eq!(
        budget_core::receipts::get(b.db.conn(), &split)
            .unwrap()
            .total,
        300_000
    );
}

#[test]
fn own_transfer_from_two_statements_is_not_expense() {
    let mut b = bank();
    let before = snapshot(b.db.conn());
    let out = statement(
        b.dir.path(),
        "card.csv",
        &[op(
            "05.10.2026",
            "1140",
            "-5000,00",
            "Переводы",
            "Перевод между счетами",
        )],
    );
    let inc = statement(
        b.dir.path(),
        "other.csv",
        &[op(
            "06.10.2026",
            "8305",
            "5000,00",
            "Пополнения",
            "Перевод между счетами",
        )],
    );
    let a = import(&mut b, &out);
    let z = import(&mut b, &inc);
    assert_eq!((a.added, z.added), (1, 1));
    let sug = budget_core::import_log::suggestions(b.db.conn()).unwrap();
    let tr: Vec<_> = sug.iter().filter(|s| s.kind == "transfer").collect();
    assert_eq!(tr.len(), 1, "{sug:?}");
    let id = budget_core::import_log::accept(b.db.conn(), &tr[0].id).unwrap();
    let t = budget_core::transactions::get(b.db.conn(), &id).unwrap();
    assert_eq!(t.kind, "transfer");
    let s = reports::period_summary(b.db.conn(), "2026-10-01", "2026-10-31").unwrap();
    assert_eq!((s.income, s.expense), (0, 0));
    let bal = reports::balances_on(b.db.conn(), "2026-12-31").unwrap();
    let get = |id: &str| {
        bal.rows
            .iter()
            .find(|r| r.account_id == id)
            .unwrap()
            .balance
    };
    assert_eq!(get(&b.card), 10_000_000 - 500_000);
    assert_eq!(get(&b.other), 5_000_000 + 500_000);
    // Обе выписки ещё раз — ничего нового.
    assert_eq!(import(&mut b, &out).added, 0);
    assert_eq!(import(&mut b, &inc).added, 0);
    assert_eq!(count(b.db.conn()), 1);
    // Отмена одной выписки: перевод распадается, вторая сторона возвращается доходом.
    budget_core::import_log::undo(b.db.conn(), &a.import_id).unwrap();
    let s = reports::period_summary(b.db.conn(), "2026-10-01", "2026-10-31").unwrap();
    assert_eq!((s.income, s.expense), (500_000, 0));
    budget_core::import_log::undo(b.db.conn(), &z.import_id).unwrap();
    assert_eq!(snapshot(b.db.conn()), before);
}

// ---------- Отмена действий ----------

fn input(
    kind: &str,
    date: &str,
    acc: &str,
    amount: i64,
    cat: &str,
) -> budget_core::transactions::TxnInput {
    budget_core::transactions::TxnInput {
        kind: kind.into(),
        date: date.into(),
        account_id: acc.into(),
        amount,
        category_id: Some(cat.into()),
        to_account_id: None,
        to_amount: None,
        payee: Some("Ашан".into()),
        note: None,
    }
}

fn month_totals(c: &Connection, m: &str) -> (i64, i64) {
    let p = reports::period_of(c, "month", m).unwrap();
    let s = reports::period_summary(c, &p.start, &p.end).unwrap();
    (s.income, s.expense)
}

#[test]
fn undo_redo_create_edit_keeps_totals_and_balance() {
    use budget_core::transactions::{self as tx, TxnExtra};
    let mut f = fx();
    let mut j = budget_core::undo::Journal::default();
    let (rub, food) = (f.rub.clone(), f.food.clone());
    let bal = |c: &Connection| budget_core::accounts::balance(c, &rub, None).unwrap();
    let start = bal(f.db.conn());
    let id = j
        .record(f.db.conn_mut(), "Новая операция", |c| {
            tx::create_with(
                c,
                &input("expense", "2026-03-10", &rub, 120_000, &food),
                &TxnExtra::default(),
            )
        })
        .unwrap();
    // Правка: другая сумма и «на 3 месяца».
    j.record(
        f.db.conn_mut(),
        "Изменение операции",
        |c| {
            tx::update_with(
                c,
                &id,
                &input("expense", "2026-03-10", &rub, 90_001, &food),
                &TxnExtra {
                    spread_months: Some(3),
                    tags: vec![],
                },
            )
        },
    )
    .unwrap();
    let c = f.db.conn();
    assert_eq!(bal(c), start - 90_001);
    assert_eq!(month_totals(c, "2026-03"), (0, 30_001));
    assert_eq!(month_totals(c, "2026-05"), (0, 30_000));

    j.undo(c).unwrap();
    assert_eq!(bal(c), start - 120_000);
    assert_eq!(month_totals(c, "2026-03"), (0, 120_000));
    assert_eq!(month_totals(c, "2026-04"), (0, 0));
    j.undo(c).unwrap();
    assert_eq!(bal(c), start);
    assert_eq!(month_totals(c, "2026-03"), (0, 0));
    assert_eq!(count(c), 0);
    j.redo(c).unwrap();
    j.redo(c).unwrap();
    assert_eq!(bal(c), start - 90_001);
    assert_eq!(month_totals(c, "2026-04"), (0, 30_000));
    assert_eq!(oracle(c, "2026-01-01", "2026-12-31"), (0, 90_001));
}

#[test]
fn ctrl_z_brings_back_undone_import() {
    let mut b = bank();
    let mut j = budget_core::undo::Journal::default();
    let f = statement(
        b.dir.path(),
        "a.csv",
        &[
            op(
                "02.10.2026",
                "1140",
                "-1053,77",
                "Супермаркеты",
                "Пятерочка",
            ),
            op("03.10.2026", "1140", "85000,00", "Зарплата", "Зарплата"),
        ],
    );
    let before = snapshot(b.db.conn());
    let saved = j
        .record(b.db.conn_mut(), "Импорт", |c| {
            budget_core::csv_import::import(c, &f, false, None)
        })
        .unwrap();
    let imported = snapshot(b.db.conn());
    j.record(b.db.conn_mut(), "Отмена импорта", |c| {
        budget_core::import_log::undo(c, &saved.import_id)
    })
    .unwrap();
    assert_eq!(snapshot(b.db.conn()), before);
    j.undo(b.db.conn()).unwrap();
    assert_eq!(snapshot(b.db.conn()), imported);
    assert_eq!(import(&mut b, &f).added, 0);
}

// ---------- Напоминания ----------

#[test]
fn moved_and_edited_reminder_payment_counts_once() {
    use budget_core::reminders::{self, Key, Paid, ReminderInput};
    let f = fx();
    let c = f.db.conn();
    let id = reminders::create(
        c,
        &ReminderInput {
            title: "Интернет".into(),
            start_at: "2026-01-10T10:00".into(),
            repeat: "monthly".into(),
            day_of_month: Some(10),
            amount: Some(80_000),
            txn_type: Some("expense".into()),
            account_id: Some(f.rub.clone()),
            category_id: Some(f.food.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let dt = |s: &str| reminders::parse_dt(s).unwrap();
    let key = Key {
        source: "reminder".into(),
        ref_id: id.clone(),
        scheduled_at: "2026-03-10T10:00".into(),
    };
    // Мартовский платёж переносится на 2 апреля и стоит 95 000.
    reminders::edit_occurrence(c, &key, Some(95_000), Some("2026-04-02T09:00")).unwrap();
    let march = reminders::occurrences(c, dt("2026-03-01T00:00"), dt("2026-03-31T23:59")).unwrap();
    assert!(march.is_empty(), "{march:?}");
    let april = reminders::occurrences(c, dt("2026-04-01T00:00"), dt("2026-04-30T23:59")).unwrap();
    let at: Vec<(&str, Option<i64>)> = april
        .iter()
        .map(|o| (o.pay_at.as_str(), o.amount))
        .collect();
    assert_eq!(
        at,
        vec![
            ("2026-04-02T09:00", Some(95_000)),
            ("2026-04-10T10:00", Some(80_000))
        ]
    );
    // «Оплачено» — одна операция на сумму платежа, второй раз не создаётся.
    let Paid::Transaction(t) = reminders::pay(c, &key, "2026-04-02").unwrap() else {
        panic!("ожидалась операция");
    };
    assert_eq!(
        reminders::pay(c, &key, "2026-04-02").unwrap(),
        Paid::Transaction(t.clone())
    );
    assert_eq!(
        budget_core::transactions::get(c, &t).unwrap().amount,
        95_000
    );
    assert_eq!(month_totals(c, "2026-04"), (0, 95_000));
    let april = reminders::occurrences(c, dt("2026-04-01T00:00"), dt("2026-04-30T23:59")).unwrap();
    assert_eq!(april[0].status, "done");
    assert_eq!(april[1].status, "pending");
}

// ---------- Займы ----------

fn loan(f: &mut Fx, kind: &str) -> String {
    budget_core::debts::create(
        f.db.conn_mut(),
        &budget_core::debts::DebtInput {
            direction: "borrowed".into(),
            counterparty: "Банк".into(),
            note: None,
            currency_code: "RUB".into(),
            principal: 12_000_000,
            issue_date: "2026-01-15".into(),
            rate_bp: 1200,
            repayment_type: kind.into(),
            term_months: Some(12),
            first_payment_date: None,
            maturity_date: None,
            account_id: Some(f.rub.clone()),
            interest_method: None,
            rate_period: None,
            pay_every: None,
            rate_changes: vec![],
            planned_early: vec![],
        },
    )
    .unwrap()
}

/// График сходится с остатком: основной долг всех строк = сумма долга,
/// неоплаченные строки = остаток, последняя строка гасит долг до нуля.
fn check_schedule(d: &budget_core::debts::DebtDetail) {
    let paid: i64 = d.payments.iter().map(|p| p.principal).sum();
    assert_eq!(d.card.principal_paid, paid);
    assert_eq!(d.card.outstanding, d.card.principal - paid);
    let pending: i64 = d
        .schedule
        .iter()
        .filter(|r| r.status != "paid")
        .map(|r| r.principal_part)
        .sum();
    let partial_paid: i64 = d.schedule.iter().filter(|r| r.status == "partial").count() as i64;
    if partial_paid == 0 {
        assert_eq!(pending, d.card.outstanding, "неоплаченные строки = остаток");
    }
    let last = d.schedule.last().unwrap();
    assert_eq!(last.balance_after, 0, "{:?}", last);
    for r in &d.schedule {
        assert_eq!(r.payment, r.principal_part + r.interest_part, "{r:?}");
    }
}

#[test]
fn loan_payments_are_transfer_plus_interest_and_schedule_adds_up() {
    for kind in ["annuity", "differentiated"] {
        let mut f = fx();
        let start = budget_core::accounts::balance(f.db.conn(), &f.rub, None).unwrap();
        let debt = loan(&mut f, kind);
        let d = budget_core::debts::get(f.db.conn(), &debt, "2026-01-20").unwrap();
        check_schedule(&d);
        // Выдача — перевод: на карте +120 000, доходов нет.
        assert_eq!(
            budget_core::accounts::balance(f.db.conn(), &f.rub, None).unwrap(),
            start + 12_000_000
        );
        assert_eq!(month_totals(f.db.conn(), "2026-01"), (0, 0));

        // Первый платёж по графику.
        let r1 = d.schedule[0].clone();
        let pay =
            |f: &mut Fx, date: &str, p: i64, i: i64, sid: Option<String>, mode: Option<&str>| {
                budget_core::debts::pay(
                    f.db.conn_mut(),
                    &debt,
                    &budget_core::debts::PaymentInput {
                        date: date.into(),
                        account_id: f.rub.clone(),
                        principal: p,
                        interest: i,
                        schedule_id: sid,
                        recalc_mode: mode.map(Into::into),
                    },
                )
                .unwrap()
            };
        pay(
            &mut f,
            &r1.due_date,
            r1.principal_part,
            r1.interest_part,
            Some(r1.id.clone()),
            None,
        );
        let m1 = &r1.due_date[..7];
        assert_eq!(
            month_totals(f.db.conn(), m1),
            (0, r1.interest_part),
            "{kind}"
        );
        let cat = reports::by_category(f.db.conn(), "expense", "2026-01-01", "2026-12-31").unwrap();
        assert_eq!(cat.items.len(), 1);
        assert_eq!(cat.items[0].name, "Проценты по кредитам");
        let d = budget_core::debts::get(f.db.conn(), &debt, "2026-03-01").unwrap();
        assert_eq!(d.schedule[0].status, "paid", "{kind}");
        check_schedule(&d);

        // Досрочный платёж 30 000 с сокращением срока.
        pay(
            &mut f,
            "2026-03-01",
            3_000_000,
            0,
            None,
            Some("reduce_term"),
        );
        let d = budget_core::debts::get(f.db.conn(), &debt, "2026-03-02").unwrap();
        check_schedule(&d);
        assert!(d.schedule.len() < 12, "{kind}: срок сократился");
        assert_eq!(
            d.card.outstanding,
            12_000_000 - r1.principal_part - 3_000_000
        );

        // Частичный платёж по следующей строке.
        let next = d
            .schedule
            .iter()
            .find(|r| r.status == "pending")
            .unwrap()
            .clone();
        pay(
            &mut f,
            &next.due_date,
            next.principal_part / 2,
            next.interest_part,
            Some(next.id.clone()),
            None,
        );
        let d = budget_core::debts::get(f.db.conn(), &debt, &next.due_date).unwrap();
        check_schedule(&d);
        let paid_total: i64 = d.payments.iter().map(|p| p.principal + p.interest).sum();
        let interest: i64 = d.payments.iter().map(|p| p.interest).sum();
        assert_eq!(d.card.interest_paid, interest);
        assert_eq!(
            budget_core::accounts::balance(f.db.conn(), &f.rub, None).unwrap(),
            start + 12_000_000 - paid_total,
            "{kind}: карта"
        );
        let debt_acc = &d.card.account_id;
        assert_eq!(
            budget_core::accounts::balance(f.db.conn(), debt_acc, None).unwrap(),
            -d.card.outstanding,
            "{kind}: счёт долга"
        );
        let s = reports::period_summary(f.db.conn(), "2026-01-01", "2026-12-31").unwrap();
        assert_eq!((s.income, s.expense), (0, interest), "{kind}");

        // Удаление последнего платежа возвращает всё как было до него.
        let last = d.payments.iter().find(|p| p.date == next.due_date).unwrap();
        budget_core::debts::delete_payment(f.db.conn_mut(), &last.id).unwrap();
        let d2 = budget_core::debts::get(f.db.conn(), &debt, "2026-03-02").unwrap();
        check_schedule(&d2);
        assert_eq!(
            d2.card.outstanding,
            12_000_000 - r1.principal_part - 3_000_000
        );
    }
}

#[test]
#[ignore = "R-ошибка B4: при начале месяца 29–31 трата «на N месяцев» пропускает февраль и даёт две части в март"]
fn spread_gives_one_part_per_budget_month_with_late_start_day() {
    let mut f = fx();
    settings::set(f.db.conn(), "month_start_day", "30").unwrap();
    let (rub, food) = (f.rub.clone(), f.food.clone());
    // 29 января при начале месяца 30-го — последний день январского периода.
    budget_core::transactions::create_with(
        f.db.conn_mut(),
        &input("expense", "2026-01-29", &rub, 300_000, &food),
        &budget_core::transactions::TxnExtra {
            spread_months: Some(3),
            tags: vec![],
        },
    )
    .unwrap();
    let c = f.db.conn();
    let by: Vec<i64> = ["2026-01", "2026-02", "2026-03"]
        .iter()
        .map(|m| budgets::get(c, m, "2026-01-29").unwrap().actual_expense)
        .collect();
    assert_eq!(by, vec![100_000, 100_000, 100_000]);
}

/// Ручная запись связана со строкой выписки; более полная выписка с двумя
/// такими же покупками добавляет вторую, а не считает обе повтором.
#[test]
fn linked_row_counts_once_when_fuller_statement_has_two() {
    let mut b = bank();
    let food = cat_id(b.db.conn(), "Продукты");
    txn(
        b.db.conn(),
        "expense",
        "2026-10-01",
        &b.card,
        105_377,
        Some(&food),
    );
    let row = op(
        "02.10.2026",
        "1140",
        "-1053,77",
        "Супермаркеты",
        "Пятерочка",
    );
    let one = statement(b.dir.path(), "one.csv", std::slice::from_ref(&row));
    let first = import(&mut b, &one);
    assert_eq!((first.added, first.linked), (0, 1));
    let two = statement(b.dir.path(), "two.csv", &[row.clone(), row]);
    assert_eq!(import(&mut b, &two).added, 1, "вторая покупка добавилась");
    assert_eq!(import(&mut b, &two).added, 0, "повтор ничего не добавляет");
}
