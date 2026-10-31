//! Объём (большой итоговый тест, пункт 4): 10 лет учёта, около 100 000 операций.
//! Тест отдельный и долгий, запускается вручную:
//!   cargo test --release -p budget-core --test volume -- --ignored --nocapture
//! С переменной PTREASURY_VOLUME_DIR база остаётся в этой папке (для сквозного
//! теста окна приложения на большой базе).

use std::path::Path;
use std::time::{Duration, Instant};

use budget_core::accounts::{self, AccountInput};
use budget_core::storage::{OpenOptions, Storage};
use budget_core::transactions::{self, Filter};
use budget_core::{budgets, calendar, export, ids, reports, settings};
use rusqlite::params;

const YEARS: i32 = 10;

/// Учёт идёт 10 лет и заканчивается сегодня: текущий месяц на экранах полон данных.
fn end() -> chrono::NaiveDate {
    chrono::Local::now().date_naive().succ_opt().unwrap()
}

fn begin() -> chrono::NaiveDate {
    end()
        .checked_sub_months(chrono::Months::new(12 * YEARS as u32))
        .unwrap()
}
const PER_DAY: usize = 27; // ≈ 98 600 операций за 10 лет

fn account(name: &str, kind: &str, currency: &str, opening: i64) -> AccountInput {
    AccountInput {
        name: name.into(),
        kind: kind.into(),
        currency_code: currency.into(),
        opening_balance: opening,
        opening_date: begin().format("%Y-%m-%d").to_string(),
        credit_limit: None,
        include_in_total: true,
        invest_kind: None,
    }
}

/// Заполнить базу: 3 счёта, набор категорий, 10 лет операций, бюджеты и курсы.
fn fill(db: &mut Storage) -> usize {
    let c = db.conn();
    budget_core::categories::seed_defaults(c).unwrap();
    settings::set(c, "onboarding_done", "1").unwrap();
    let card = accounts::create(c, &account("Карта", "debit", "RUB", 5_000_000)).unwrap();
    let cash = accounts::create(c, &account("Наличные", "cash", "RUB", 1_000_000)).unwrap();
    let usd = accounts::create(c, &account("Вклад USD", "savings", "USD", 100_000)).unwrap();
    let cats = |kind: &str| -> Vec<String> {
        let mut st = c
            .prepare("SELECT id FROM categories WHERE kind = ?1 AND parent_id IS NULL")
            .unwrap();
        st.query_map([kind], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let expense = cats("expense");
    let income = cats("income");
    let payees = [
        "Пятёрочка",
        "Перекрёсток",
        "Яндекс Go",
        "Шоколадница",
        "Мосэнергосбыт",
        "Аптека",
        "Озон",
        "ВкусВилл",
    ];

    let tx = db.conn_mut().transaction().unwrap();
    let mut n = 0;
    {
        let mut ins = tx
            .prepare(
                "INSERT INTO transactions (id, type, date, account_id, amount, category_id, to_account_id, to_amount,
                                           payee, note, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            )
            .unwrap();
        let mut day = begin();
        let end = end();
        let mut seed: u64 = 42;
        let mut rnd = |m: u64| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) % m
        };
        while day < end {
            let date = day.format("%Y-%m-%d").to_string();
            let now = format!("{date}T12:00:00.000Z");
            for i in 0..PER_DAY {
                let id = ids::new_id();
                if i == 0 && day.format("%d").to_string() == "05" {
                    // Зарплата раз в месяц.
                    ins.execute(params![
                        id,
                        "income",
                        date,
                        card,
                        12_000_000,
                        income[0],
                        None::<String>,
                        None::<i64>,
                        "Работа",
                        None::<String>,
                        now
                    ])
                    .unwrap();
                } else if i == 1 && rnd(10) == 0 {
                    ins.execute(params![
                        id,
                        "transfer",
                        date,
                        card,
                        500_000,
                        None::<String>,
                        cash,
                        500_000,
                        None::<String>,
                        None::<String>,
                        now
                    ])
                    .unwrap();
                } else {
                    let acc = if rnd(4) == 0 { &cash } else { &card };
                    let cat = &expense[rnd(expense.len() as u64) as usize];
                    let payee = payees[rnd(payees.len() as u64) as usize];
                    ins.execute(params![
                        id,
                        "expense",
                        date,
                        acc,
                        5_000 + rnd(300_000) as i64,
                        cat,
                        None::<String>,
                        None::<i64>,
                        payee,
                        None::<String>,
                        now
                    ])
                    .unwrap();
                }
                n += 1;
            }
            day = day.succ_opt().unwrap();
        }
        // Курс доллара раз в месяц.
        let mut m = begin();
        while m < end {
            tx.execute(
                "INSERT INTO exchange_rates (date, from_code, to_code, rate) VALUES (?1, 'USD', 'RUB', ?2)",
                params![m.format("%Y-%m-%d").to_string(), format!("{}.50", 60 + rnd(40))],
            )
            .unwrap();
            m = m.checked_add_months(chrono::Months::new(1)).unwrap();
        }
    }
    tx.commit().unwrap();
    let _ = usd;
    // Бюджет на последний месяц с лимитами.
    let month = chrono::Local::now().format("%Y-%m").to_string();
    let budget = budgets::create(db.conn_mut(), &month, false).unwrap();
    for cat in expense.iter().take(8) {
        budgets::set_limit(db.conn(), &budget, cat, Some(3_000_000)).unwrap();
    }
    n
}

/// Время выполнения с выводом в отчёт.
fn timed<T>(what: &str, limit: Duration, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let out = f();
    let took = t.elapsed();
    println!(
        "{what:<45} {:>7.0} мс (цель до {} мс)",
        took.as_secs_f64() * 1000.0,
        limit.as_millis()
    );
    assert!(took <= limit, "{what}: {took:?} дольше {limit:?}");
    out
}

#[test]
#[ignore = "долгий тест объёма; запускается вручную в release"]
fn ten_years_of_records_stay_fast() {
    let keep = std::env::var("PTREASURY_VOLUME_DIR").ok();
    let tmp = tempfile::tempdir().unwrap();
    let dir = keep.as_deref().map(Path::new).unwrap_or(tmp.path());
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join("budget.db");
    let _ = std::fs::remove_file(&path);
    let opts = OpenOptions {
        backup_dir: dir.join("backups"),
        keep_backups: 3,
    };
    let mut db = Storage::open(&path, &opts).unwrap();
    let t = Instant::now();
    let n = fill(&mut db);
    println!(
        "создано операций: {n} за {:.1} с",
        t.elapsed().as_secs_f64()
    );
    assert!(n >= 95_000);
    drop(db);

    let sec = Duration::from_secs(1);
    let db = timed(
        "запуск: открыть базу и проверить схему",
        sec,
        || Storage::open(&path, &opts).unwrap(),
    );
    let c = db.conn();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let month = today[..7].to_string();
    let year_ago = (end() - chrono::Days::new(365))
        .format("%Y-%m-%d")
        .to_string();
    // Отчёт по месяцам ограничен 10 годами (120 месяцев), включая текущий.
    let first_month = (begin() + chrono::Months::new(1))
        .format("%Y-%m")
        .to_string();
    timed("Главная: общий баланс", sec, || {
        accounts::totals(c, &today).unwrap()
    });
    timed(
        "Счета: список с балансами",
        sec,
        || accounts::list(c, true).unwrap(),
    );
    let page = timed(
        "Операции: первые 100 за всё время",
        sec,
        || {
            transactions::list(
                c,
                &Filter {
                    limit: Some(100),
                    ..Default::default()
                },
            )
            .unwrap()
        },
    );
    assert_eq!(page.items.len(), 100);
    assert!(page.total as usize >= n);
    timed(
        "Операции: поиск «Пятёрочка» за всё время",
        sec,
        || {
            transactions::list(
                c,
                &Filter {
                    search: Some("Пятёрочка".into()),
                    limit: Some(100),
                    ..Default::default()
                },
            )
            .unwrap()
        },
    );
    timed(
        "Отчёт: структура расходов за год",
        sec,
        || reports::by_category(c, "expense", &year_ago, &today).unwrap(),
    );
    timed(
        "Отчёт: по месяцам за 10 лет",
        sec,
        || reports::by_month(c, &first_month, &month).unwrap(),
    );
    timed("Отчёт: итоги года", sec, || {
        reports::period_summary(c, &year_ago, &today).unwrap()
    });
    timed("Бюджет месяца", sec, || {
        budgets::get(c, &month, &today).unwrap()
    });
    timed("Календарь месяца", sec, || {
        calendar::month(c, &month, &today).unwrap()
    });
    // Экраны 0.10–0.13: дашборд, подписки, поиск Ctrl+K, итоги года, подсказки.
    timed(
        "Итоги года (экран и картинка)",
        sec,
        || budget_core::year::review(c, today[..4].parse().unwrap(), &today).unwrap(),
    );
    timed(
        "Регулярные платежи (автопоиск)",
        sec,
        || budget_core::subscriptions::list(c, &today).unwrap(),
    );
    timed("Поиск Ctrl+K «пят»", sec, || {
        budget_core::search::find(c, "пят").unwrap()
    });
    timed(
        "Подсказка получателя «пят»",
        sec,
        || transactions::payee_hints(c, "expense", "пят", 8).unwrap(),
    );
    timed("Подушка безопасности", sec, || {
        budget_core::wealth::cushion(c, &today).unwrap()
    });
    timed("Инвестиции: обзор", sec, || {
        budget_core::invest::overview(c, &today).unwrap()
    });
    timed("Цели", sec, || {
        budget_core::goals::list(c, &today).unwrap()
    });
    timed(
        "Сравнение двух лет по категориям",
        sec,
        || {
            let prev = (end() - chrono::Days::new(730))
                .format("%Y-%m-%d")
                .to_string();
            budget_core::compare::compare(
                c, "expense", "category", &prev, &year_ago, &year_ago, &today,
            )
            .unwrap()
        },
    );
    let xlsx = dir.join("сводка за год.xlsx");
    timed(
        "Сводка в Excel за год (6 листов)",
        Duration::from_secs(5),
        || {
            let sheets = export::summary_workbook(c, &year_ago, &today, &today).unwrap();
            export::write_xlsx(&xlsx, &sheets).unwrap();
        },
    );
    timed(
        "Выгрузка всех операций за 10 лет в CSV",
        Duration::from_secs(10),
        || {
            let sheet = export::transactions_sheet(c, &Filter::default()).unwrap();
            export::write_one(&dir.join("все операции.csv"), &sheet).unwrap();
        },
    );
    timed(
        "Резервная копия базы",
        Duration::from_secs(5),
        || budget_core::backups::backup(c, &dir.join("копия.db")).unwrap(),
    );
    let vault = dir.join("Kazna");
    let copy = timed(
        "Папка сохранности: копия (база занята)",
        Duration::from_secs(5),
        || budget_core::vault::sync_copy(c, &vault, "Мой бюджет").unwrap(),
    );
    timed(
        "Папка сохранности: Excel по копии (база свободна)",
        Duration::from_secs(30),
        || budget_core::vault::sync_excel(&copy, &vault, "Мой бюджет").unwrap(),
    );
    let card: String = c
        .query_row(
            "SELECT id FROM accounts WHERE name = 'Карта'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let food: String = c
        .query_row(
            "SELECT id FROM categories WHERE kind = 'expense' AND parent_id IS NULL LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    timed(
        "Импорт 1 000 операций (выписка)",
        Duration::from_secs(5),
        || {
            let tx = c.unchecked_transaction().unwrap();
            for i in 0..1000 {
                transactions::create(
                    &tx,
                    &transactions::TxnInput {
                        kind: "expense".into(),
                        date: today.clone(),
                        account_id: card.clone(),
                        amount: 10_000 + i,
                        category_id: Some(food.clone()),
                        to_account_id: None,
                        to_amount: None,
                        payee: Some("Импорт".into()),
                        note: None,
                    },
                )
                .unwrap();
            }
            tx.commit().unwrap();
        },
    );
    // Файл импорта: операции последних 5 недель (≈ 1 000 строк), выгруженные в CSV.
    let csv = dir.join("импорт.csv");
    let weeks_ago = (end() - chrono::Days::new(36))
        .format("%Y-%m-%d")
        .to_string();
    let sheet = export::transactions_sheet(
        c,
        &Filter {
            date_from: Some(weeks_ago),
            ..Default::default()
        },
    )
    .unwrap();
    export::write_one(&csv, &sheet).unwrap();
    let preview = timed(
        "Импорт CSV: предпросмотр ≈ 1 000 строк",
        sec,
        || budget_core::csv_import::preview(c, &csv, None).unwrap(),
    );
    assert!(preview.rows.len() >= 900, "{}", preview.rows.len());
    drop(db);
    let mut db = Storage::open(&path, &opts).unwrap();
    timed(
        "Импорт CSV: загрузка ≈ 1 000 строк",
        Duration::from_secs(5),
        || budget_core::csv_import::import(db.conn_mut(), &csv, true, None).unwrap(),
    );
    let size = std::fs::metadata(&path).unwrap().len()
        + std::fs::metadata(dir.join("budget.db-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
    println!("размер базы: {:.1} МБ", size as f64 / 1_048_576.0);
}
