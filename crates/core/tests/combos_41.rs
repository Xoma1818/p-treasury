//! Тред 41: сочетания функций после этапа 8 (#88) и пересекающихся выписок (#91).
//!
//! - Выписка, сделавшая записанные расходы и доходы переводами, проходит через
//!   все экраны: отчёты, бюджет, счета, группы счетов, плитки «Главной», «Год».
//!   «Отменить импорт» возвращает все цифры как были, Ctrl+Z отмены — снова переводы.
//! - Отмена первой (ранней) выписки, когда поверх загружена вторая: та же
//!   выписка загружается снова целиком, с переводами.
//! - Удалённая строка не возвращается ни повтором выписки, ни после Ctrl+Z/Ctrl+Y.
//! - Бюджет, созданный при начале месяца не с 1-го: новые бюджеты получают
//!   свой день начала, лимит «в неделю» считает свой период.
//! - Настоящая база 0.25 (testdata/upgrade-0.25.db) обновляется до последней
//!   схемы без потерь, и на ней работают новые функции.

use std::path::{Path, PathBuf};

use budget_core::accounts::{self, AccountInput};
use budget_core::storage::{OpenOptions, Storage, LATEST_VERSION};
use budget_core::undo::Journal;
use budget_core::{
    account_groups, budgets, categories, csv_import, home_figures, import_log, reports, settings,
    transactions, year,
};
use rusqlite::Connection;

const TODAY: &str = "2026-11-14";

fn testdata(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(name)
}

fn account(c: &Connection, name: &str) -> String {
    accounts::create(
        c,
        &AccountInput {
            name: name.into(),
            kind: "debit".into(),
            currency_code: "RUB".into(),
            opening_balance: 0,
            opening_date: "2026-01-01".into(),
            credit_limit: None,
            include_in_total: true,
            invest_kind: None,
        },
    )
    .unwrap()
}

fn n(c: &Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// Все цифры, которые человек видит на экранах, одной строкой для сравнения.
fn figures(c: &Connection) -> String {
    let nov = reports::period_summary(c, "2026-11-01", "2026-11-30").unwrap();
    let b = budgets::get(c, "2026-11", TODAY).unwrap();
    let lines: Vec<(String, i64)> = b
        .lines
        .iter()
        .map(|l| (l.category_name.clone(), l.actual))
        .collect();
    let balances: Vec<(String, i64)> = accounts::list(c, false)
        .unwrap()
        .into_iter()
        .map(|a| (a.name.clone(), accounts::balance(c, &a.id, None).unwrap()))
        .collect();
    let groups: Vec<(String, i64)> = account_groups::list(c, TODAY)
        .unwrap()
        .into_iter()
        .map(|g| (g.name, g.total))
        .collect();
    let tiles: Vec<(String, i64)> = home_figures::values(c, TODAY, false)
        .unwrap()
        .into_iter()
        .map(|v| (v.id, v.value))
        .collect();
    let y = year::review(c, 2026, TODAY).unwrap();
    let cats = reports::by_category(c, "expense", "2026-11-01", "2026-11-30").unwrap();
    format!(
        "summary {}/{}\nbudget {}/{}/{} {lines:?}\nbalances {balances:?} total {}\ngroups {groups:?}\ntiles {tiles:?}\nyear {:?}\ncats {:?}",
        nov.income,
        nov.expense,
        b.actual_income,
        b.actual_expense,
        b.unbudgeted_expense,
        accounts::totals(c, TODAY).unwrap().total,
        (y.income, y.expense),
        cats.items
            .iter()
            .map(|i| (i.name.clone(), i.amount))
            .collect::<Vec<_>>(),
    )
}

/// Две карты в одной группе, бюджет ноября, плитки «Главной» по месяцу.
fn setup(db: &mut Storage) -> (String, String) {
    categories::seed_defaults(db.conn()).unwrap();
    let premium = account(db.conn(), "Premium");
    let savings = account(db.conn(), "Накопительный");
    let c = db.conn();
    let g = account_groups::create(c, "Т-Банк").unwrap();
    accounts::set_group(c, &premium, Some(&g)).unwrap();
    accounts::set_group(c, &savings, Some(&g)).unwrap();
    let tiles: Vec<home_figures::Figure> = serde_json::from_str(
        r#"[{"id":"e","title":"Расходы","measure":"expense","period":"month"},
            {"id":"i","title":"Доходы","measure":"income","period":"month"},
            {"id":"s","title":"Сальдо","measure":"saldo","period":"month"},
            {"id":"b","title":"Остаток","measure":"balance","period":"month"}]"#,
    )
    .unwrap();
    home_figures::save(c, &tiles).unwrap();
    budgets::create(db.conn_mut(), "2026-11", false).unwrap();
    (premium, savings)
}

/// Выписка без второго счёта, затем та же выписка со вторым счётом: строки
/// «Учёт в аналитике: Нет» становятся переводами. Цифры совпадают с банком,
/// карта Premium не меняется, отмена и Ctrl+Z ходят туда и обратно без потерь.
#[test]
fn converted_statement_flows_through_screens_and_undo_round_trips() {
    let mut db = Storage::open_in_memory().unwrap();
    let (premium, savings) = setup(&mut db);
    let path = testdata("tbank-operations-analytics.csv");
    let mut journal = Journal::default();

    journal
        .record(db.conn_mut(), "Импорт операций", |c| {
            csv_import::import_with(c, &path, false, Some(&premium), Some(""))
        })
        .unwrap();
    let plain = figures(db.conn());
    let premium_before = accounts::balance(db.conn(), &premium, None).unwrap();

    let saved = journal
        .record(db.conn_mut(), "Импорт операций", |c| {
            csv_import::import_with(c, &path, false, Some(&premium), Some(&savings))
        })
        .unwrap();
    assert_eq!((saved.added, saved.converted), (0, 4));
    let c = db.conn();
    // Как в банке «без переводов»: 170 + 170 + 2 109,48 и 1 543,80 + 102 586.
    let s = reports::period_summary(c, "2026-11-01", "2026-11-30").unwrap();
    assert_eq!((s.expense, s.income), (244_948, 10_412_980));
    let b = budgets::get(c, "2026-11", TODAY).unwrap();
    assert_eq!((b.actual_expense, b.actual_income), (244_948, 10_412_980));
    // Карта та же; копилка получила переводы: +1 521 +80 000 −9 000 −20 306,91.
    assert_eq!(
        accounts::balance(c, &premium, None).unwrap(),
        premium_before
    );
    assert_eq!(accounts::balance(c, &savings, None).unwrap(), 5_221_409);
    let group = &account_groups::list(c, TODAY).unwrap()[0];
    assert_eq!(group.total, premium_before + 5_221_409);
    let tiles = home_figures::values(c, TODAY, false).unwrap();
    let tile = |id: &str| tiles.iter().find(|t| t.id == id).unwrap().value;
    assert_eq!((tile("e"), tile("i")), (244_948, 10_412_980));
    assert_eq!(tile("s"), 10_412_980 - 244_948);
    let converted = figures(c);
    assert_ne!(converted, plain);

    // «Отменить импорт» второй выписки — всё как после первой.
    journal
        .record(db.conn_mut(), "Отмена импорта", |c| {
            let tx = c.transaction()?;
            import_log::undo(&tx, &saved.import_id)?;
            tx.commit()?;
            Ok(())
        })
        .unwrap();
    assert_eq!(figures(db.conn()), plain);
    // Ctrl+Z отмены — снова переводы; Ctrl+Y — снова как после первой.
    journal.undo(db.conn_mut()).unwrap().unwrap();
    assert_eq!(figures(db.conn()), converted);
    journal.redo(db.conn_mut()).unwrap().unwrap();
    assert_eq!(figures(db.conn()), plain);
    // Повтор выписки после всего этого снова делает те же 4 перевода.
    let again =
        csv_import::import_with(db.conn_mut(), &path, false, Some(&premium), Some(&savings))
            .unwrap();
    assert_eq!((again.added, again.converted), (0, 4));
    assert_eq!(figures(db.conn()), converted);
}

/// Так у OTTO 13.11 «пропал ноябрь»: отменили первую выписку, а вторая,
/// пересекающаяся, добавила только новые строки. Повторная загрузка второй
/// выписки возвращает всё — с переводами, без дублей.
#[test]
fn undo_of_earlier_statement_then_reload_restores_everything() {
    let mut db = Storage::open_in_memory().unwrap();
    let (premium, savings) = setup(&mut db);
    let path = testdata("tbank-operations-analytics.csv");
    let first =
        csv_import::import_with(db.conn_mut(), &path, false, Some(&premium), Some("")).unwrap();
    csv_import::import_with(db.conn_mut(), &path, false, Some(&premium), Some(&savings)).unwrap();
    let converted = figures(db.conn());
    let rows = n(db.conn(), "SELECT count(*) FROM transactions");

    import_log::undo(db.conn(), &first.import_id).unwrap();
    assert_eq!(n(db.conn(), "SELECT count(*) FROM transactions"), 0);
    let p = csv_import::preview_with(db.conn(), &path, Some(&premium), Some(&savings)).unwrap();
    assert_eq!((p.valid, p.duplicates), (9, 0));
    csv_import::import_with(db.conn_mut(), &path, false, Some(&premium), Some(&savings)).unwrap();
    assert_eq!(n(db.conn(), "SELECT count(*) FROM transactions"), rows);
    assert_eq!(figures(db.conn()), converted);
    let p = csv_import::preview_with(db.conn(), &path, Some(&premium), Some(&savings)).unwrap();
    assert_eq!((p.valid, p.to_transfers), (0, 0));
}

/// Удалённая строка не возвращается повтором выписки; Ctrl+Z удаления
/// возвращает и строку, и право загрузить её снова (повтор — дубль).
#[test]
fn deleted_row_stays_deleted_across_reload_and_undo() {
    let mut db = Storage::open_in_memory().unwrap();
    let (premium, savings) = setup(&mut db);
    let path = testdata("tbank-operations-analytics.csv");
    csv_import::import_with(db.conn_mut(), &path, false, Some(&premium), Some(&savings)).unwrap();
    let full = figures(db.conn());
    let fuel: String = db
        .conn()
        .query_row(
            "SELECT id FROM transactions WHERE amount = 210948",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut journal = Journal::default();
    journal
        .record(db.conn_mut(), "Удаление", |c| {
            transactions::delete(c, &fuel)
        })
        .unwrap();
    let p = csv_import::preview_with(db.conn(), &path, Some(&premium), Some(&savings)).unwrap();
    assert_eq!(p.valid, 0, "удалённая АЗС не предлагается снова");
    csv_import::import_with(db.conn_mut(), &path, false, Some(&premium), Some(&savings)).unwrap();
    assert_eq!(
        n(
            db.conn(),
            "SELECT count(*) FROM transactions WHERE amount = 210948"
        ),
        0
    );
    let s = reports::period_summary(db.conn(), "2026-11-01", "2026-11-30").unwrap();
    assert_eq!(s.expense, 244_948 - 210_948);

    journal.undo(db.conn_mut()).unwrap().unwrap();
    assert_eq!(figures(db.conn()), full);
    assert_eq!(n(db.conn(), "SELECT count(*) FROM import_deleted"), 0);
    let p = csv_import::preview_with(db.conn(), &path, Some(&premium), Some(&savings)).unwrap();
    assert_eq!((p.valid, p.to_transfers), (0, 0));
}

/// Бюджеты при начале месяца с 10-го: день начала записан в бюджет (и в
/// скопированный «как в прошлом месяце»), факт считается по своему периоду,
/// а лимит «в неделю» — по его длине.
#[test]
fn budgets_with_start_day_get_their_own_period() {
    let mut db = Storage::open_in_memory().unwrap();
    categories::seed_defaults(db.conn()).unwrap();
    let card = account(db.conn(), "Карта");
    settings::set(db.conn(), "month_start_day", "10").unwrap();
    let oct = budgets::create(db.conn_mut(), "2026-11", false).unwrap();
    let nov = budgets::create(db.conn_mut(), "2026-12", true).unwrap();
    let c = db.conn();
    let start_days: Vec<i64> = [&oct, &nov]
        .iter()
        .map(|id| {
            c.query_row("SELECT start_day FROM budgets WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
        })
        .collect();
    assert_eq!(start_days, [10, 10]);
    let food: String = c
        .query_row(
            "SELECT id FROM categories WHERE name = 'Общепит'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    for (date, amount) in [
        ("2026-10-09", 1_000),
        ("2026-10-10", 2_000),
        ("2026-11-09", 4_000),
        ("2026-11-10", 8_000),
    ] {
        transactions::create(
            c,
            &transactions::TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: card.clone(),
                amount,
                category_id: Some(food.clone()),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
    }
    budgets::set_limit_kind(c, &oct, &food, "week", 7_000).unwrap();
    let b = budgets::get(c, "2026-11", TODAY).unwrap();
    assert_eq!(
        (b.period.start.as_str(), b.period.end.as_str()),
        ("2026-10-10", "2026-11-09")
    );
    assert_eq!(b.actual_expense, 6_000);
    let line = b.lines.iter().find(|l| l.category_id == food).unwrap();
    // 10.10–09.11 — 31 день: 7 000 × 31 / 7.
    assert_eq!(line.limit, 31_000);
}

/// Настоящая база 0.25 обновляется до последней схемы: копия перед
/// обновлением, все строки на месте, новым бюджетам — день начала, а выписка
/// с переводами, группы счетов и плитки работают на старых данных.
#[test]
fn real_0_25_database_upgrades_and_new_features_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.db");
    std::fs::copy(testdata("upgrade-0.25.db"), &path).unwrap();
    let (old_version, counts): (i64, Vec<(String, i64)>) = {
        let c = Connection::open(&path).unwrap();
        let v = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let tables: Vec<String> = c
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let counts = tables
            .into_iter()
            .map(|t| {
                let k = n(&c, &format!("SELECT count(*) FROM \"{t}\""));
                (t, k)
            })
            .collect();
        (v, counts)
    };
    assert!(old_version < LATEST_VERSION, "база старая: {old_version}");

    let mut db = Storage::open(
        &path,
        &OpenOptions {
            backup_dir: dir.path().join("backups"),
            keep_backups: 3,
        },
    )
    .unwrap();
    assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
    assert!(db.pre_migration_backup().is_some());
    let c = db.conn();
    for (t, k) in &counts {
        if t == "settings" {
            assert!(n(c, "SELECT count(*) FROM settings") >= *k);
            continue;
        }
        assert_eq!(
            n(c, &format!("SELECT count(*) FROM \"{t}\"")),
            *k,
            "таблица {t}"
        );
    }
    assert_eq!(
        n(c, "SELECT count(*) FROM pragma_foreign_key_check"),
        0,
        "связи целы"
    );
    assert_eq!(
        n(c, "SELECT count(*) FROM budgets WHERE start_day IS NULL"),
        0
    );

    // Новые функции на старых данных.
    let before = figures(c);
    assert!(!before.is_empty());
    let premium = account(c, "Premium");
    let savings = account(c, "Накопительный");
    let g = account_groups::create(c, "Т-Банк").unwrap();
    accounts::set_group(c, &premium, Some(&g)).unwrap();
    let path_csv = testdata("tbank-operations-analytics.csv");
    csv_import::import_with(db.conn_mut(), &path_csv, false, Some(&premium), Some("")).unwrap();
    let saved = csv_import::import_with(
        db.conn_mut(),
        &path_csv,
        false,
        Some(&premium),
        Some(&savings),
    )
    .unwrap();
    assert_eq!(saved.converted, 4);
    let month = budgets::shift_month("2026-11", 1).unwrap();
    let id = budgets::create(db.conn_mut(), &month, false).unwrap();
    let sd: i64 = db
        .conn()
        .query_row("SELECT start_day FROM budgets WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(sd as u32, budgets::start_day(db.conn()).unwrap());
    let c = db.conn();
    import_log::undo(c, &saved.import_id).unwrap();
    figures(c);
}

/// Начало месяца сменили (с 1-го на 10-е): бюджеты, созданные раньше, не
/// пропадают — ноябрь по-прежнему показывает свои лимиты, «как в прошлом
/// месяце» и «Скопировать вперёд» их видят, второй бюджет на тот же месяц не создаётся.
#[test]
fn budgets_survive_month_start_change() {
    let mut db = Storage::open_in_memory().unwrap();
    categories::seed_defaults(db.conn()).unwrap();
    let oct = budgets::create(db.conn_mut(), "2026-10", false).unwrap();
    let nov = budgets::create(db.conn_mut(), "2026-11", true).unwrap();
    let c = db.conn();
    let food: String = c
        .query_row(
            "SELECT id FROM categories WHERE name = 'Общепит'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    budgets::set_limit(c, &nov, &food, Some(500_000)).unwrap();
    let _ = oct;
    for sd in ["10", "25", "1"] {
        settings::set(db.conn(), "month_start_day", sd).unwrap();
        let b = budgets::get(db.conn(), "2026-11", TODAY).unwrap();
        assert_eq!(b.id.as_deref(), Some(nov.as_str()), "начало {sd}");
        assert_eq!(b.planned_expense, 500_000, "начало {sd}");
        assert!(
            budgets::create(db.conn_mut(), "2026-11", false).is_err(),
            "начало {sd}"
        );
        let y = budgets::year(db.conn(), 2026, TODAY).unwrap();
        assert_eq!(y.has_budget[9..11], [true, true], "начало {sd}");
    }
    settings::set(db.conn(), "month_start_day", "10").unwrap();
    let dec = budgets::create(db.conn_mut(), "2026-12", true).unwrap();
    let b = budgets::get(db.conn(), "2026-12", TODAY).unwrap();
    assert_eq!(b.id.as_deref(), Some(dec.as_str()));
    assert_eq!(b.planned_expense, 500_000, "скопирован ноябрь");
}
