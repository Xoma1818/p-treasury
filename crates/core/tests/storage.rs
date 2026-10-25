use budget_core::storage::{self, Migration, OpenOptions, Storage, LATEST_VERSION, MIGRATIONS};
use budget_core::{ids, time, Error};
use rusqlite::params;

fn opts(dir: &std::path::Path) -> OpenOptions {
    OpenOptions {
        backup_dir: dir.join("backups"),
        keep_backups: 3,
    }
}

fn backups(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    match std::fs::read_dir(dir.join("backups")) {
        Ok(rd) => rd.map(|e| e.unwrap().path()).collect(),
        Err(_) => vec![],
    }
}

#[test]
fn fresh_database_gets_latest_schema_without_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data/budget.db");
    let db = Storage::open(&path, &opts(dir.path())).unwrap();
    assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
    assert!(db.pre_migration_backup().is_none());
    assert!(backups(dir.path()).is_empty());

    let fk: i64 = db
        .conn()
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
    let mode: String = db
        .conn()
        .pragma_query_value(None, "journal_mode", |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    let rub: String = db
        .conn()
        .query_row(
            "SELECT symbol FROM currencies WHERE code = 'RUB'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rub, "₽");
}

#[test]
fn reopening_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.db");
    drop(Storage::open(&path, &opts(dir.path())).unwrap());
    let db = Storage::open(&path, &opts(dir.path())).unwrap();
    assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
    assert!(db.pre_migration_backup().is_none());
}

#[test]
fn newer_schema_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.db");
    {
        let db = Storage::open(&path, &opts(dir.path())).unwrap();
        db.conn()
            .pragma_update(None, "user_version", LATEST_VERSION + 5)
            .unwrap();
    }
    match Storage::open(&path, &opts(dir.path())) {
        Err(Error::SchemaTooNew { found, supported }) => {
            assert_eq!(found, LATEST_VERSION + 5);
            assert_eq!(supported, LATEST_VERSION);
        }
        other => panic!("ожидалась ошибка SchemaTooNew, получено {:?}", other.err()),
    }
}

const ADD_COLUMN: Migration = Migration {
    version: 2,
    name: "test_add_column",
    sql: "ALTER TABLE accounts ADD COLUMN test_flag INTEGER NOT NULL DEFAULT 0;",
};

const BROKEN: Migration = Migration {
    version: 2,
    name: "test_broken",
    sql: "CREATE TABLE half_done (x INTEGER); THIS IS NOT SQL;",
};

fn insert_account(db: &Storage) -> String {
    let id = ids::new_id();
    let now = time::now_utc();
    db.conn()
        .execute(
            "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, created_at, updated_at)
             VALUES (?1, 'Карта', 'debit', 'RUB', 1234567, '2026-10-01', ?2, ?2)",
            params![id, now],
        )
        .unwrap();
    id
}

#[test]
fn upgrade_makes_backup_and_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.db");
    let account_id = {
        let db = Storage::open_with(&path, &opts(dir.path()), &MIGRATIONS[..1]).unwrap();
        insert_account(&db)
    };

    let upgraded = [MIGRATIONS[0], ADD_COLUMN];
    let db = Storage::open_with(&path, &opts(dir.path()), &upgraded).unwrap();
    assert_eq!(db.schema_version().unwrap(), 2);

    let (balance, flag): (i64, i64) = db
        .conn()
        .query_row(
            "SELECT opening_balance, test_flag FROM accounts WHERE id = ?1",
            [&account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((balance, flag), (1_234_567, 0));

    let backup = db
        .pre_migration_backup()
        .expect("должна быть копия перед миграцией")
        .to_path_buf();
    assert!(backup
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("before-update-v1-"));
    let copy = rusqlite::Connection::open(&backup).unwrap();
    assert_eq!(storage::schema_version(&copy).unwrap(), 1);
    let n: i64 = copy
        .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn failed_migration_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.db");
    {
        let db = Storage::open_with(&path, &opts(dir.path()), &MIGRATIONS[..1]).unwrap();
        insert_account(&db);
    }

    let broken = [MIGRATIONS[0], BROKEN];
    match Storage::open_with(&path, &opts(dir.path()), &broken) {
        Err(Error::Migration {
            version, backup, ..
        }) => {
            assert_eq!(version, 2);
            assert!(backup.expect("копия должна быть указана").exists());
        }
        other => panic!("ожидалась ошибка миграции, получено {:?}", other.err()),
    }

    let db = Storage::open_with(&path, &opts(dir.path()), &MIGRATIONS[..1]).unwrap();
    assert_eq!(db.schema_version().unwrap(), 1);
    let half: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'half_done'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(half, 0, "частично применённая миграция должна откатиться");
    let n: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn prune_keeps_newest_backups() {
    let dir = tempfile::tempdir().unwrap();
    let b = dir.path().join("backups");
    std::fs::create_dir_all(&b).unwrap();
    for stamp in [
        "20260101-000000",
        "20260201-000000",
        "20260301-000000",
        "20260401-000000",
    ] {
        std::fs::write(b.join(format!("before-update-v1-{stamp}.db")), b"x").unwrap();
    }
    std::fs::write(b.join("other.db"), b"x").unwrap();
    storage::prune_backups(&b, "before-update", 2).unwrap();
    let mut left: Vec<_> = backups(dir.path())
        .into_iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            "before-update-v1-20260301-000000.db",
            "before-update-v1-20260401-000000.db",
            "other.db"
        ]
    );
}

#[test]
fn schema_rules_hold() {
    let db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    let acc = insert_account(&db);
    let now = time::now_utc();

    // Расход без категории запрещён.
    let err = c.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, created_at, updated_at)
         VALUES (?1, 'expense', '2026-10-20', ?2, 100, ?3, ?3)",
        params![ids::new_id(), acc, now],
    );
    assert!(err.is_err());

    // Перевод на тот же счёт запрещён.
    let err = c.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, to_account_id, to_amount, created_at, updated_at)
         VALUES (?1, 'transfer', '2026-10-20', ?2, 100, ?2, 100, ?3, ?3)",
        params![ids::new_id(), acc, now],
    );
    assert!(err.is_err());

    // Корректировка может быть отрицательной.
    c.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, created_at, updated_at)
         VALUES (?1, 'adjustment', '2026-10-20', ?2, -35000, ?3, ?3)",
        params![ids::new_id(), acc, now],
    )
    .unwrap();

    // Внешний ключ на несуществующий счёт запрещён.
    let err = c.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, created_at, updated_at)
         VALUES (?1, 'adjustment', '2026-10-20', 'missing', 5, ?2, ?2)",
        params![ids::new_id(), now],
    );
    assert!(err.is_err());
}

#[test]
fn notes_full_text_search_in_russian() {
    let db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    let now = time::now_utc();
    let id = ids::new_id();
    c.execute(
        "INSERT INTO notes (id, body, date, created_at, updated_at) VALUES (?1, ?2, '2026-10-20', ?3, ?3)",
        params![id, "Холодильник: гарантия до 10.2028, чек в ящике", now],
    )
    .unwrap();
    let find = |q: &str| -> i64 {
        c.query_row(
            "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH ?1",
            [q],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(find("гарантия"), 1);
    assert_eq!(find("ГАРАНТИЯ"), 1);
    assert_eq!(find("холод*"), 1);

    c.execute(
        "UPDATE notes SET body = 'Телефон банка 900' WHERE id = ?1",
        [&id],
    )
    .unwrap();
    assert_eq!(find("гарантия"), 0);
    assert_eq!(find("банка"), 1);

    c.execute("DELETE FROM notes WHERE id = ?1", [&id]).unwrap();
    assert_eq!(find("банка"), 0);
}

/// Настоящее обновление 1 → 2 (этап 6): данные на месте, копия сделана,
/// новые настройки появились; копия из версии 1 восстанавливается в версии 2.
#[test]
fn real_upgrade_from_first_version_and_old_backup_restores() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.db");
    let account_id = {
        let db = Storage::open_with(&path, &opts(dir.path()), &MIGRATIONS[..1]).unwrap();
        insert_account(&db)
    };
    let old_copy = dir.path().join("old-copy.db");
    std::fs::copy(&path, &old_copy).unwrap();

    let mut db = Storage::open(&path, &opts(dir.path())).unwrap();
    assert_eq!(db.schema_version().unwrap(), storage::LATEST_VERSION);
    assert!(db.pre_migration_backup().is_some());
    let settings = budget_core::settings::all(db.conn()).unwrap();
    assert_eq!(settings["update_check"], "1");
    assert_eq!(settings["last_backup_at"], "");
    let n: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM accounts WHERE id = ?1",
            [&account_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);

    db.conn().execute("DELETE FROM accounts", []).unwrap();
    db.restore_from(&old_copy, &opts(dir.path())).unwrap();
    assert_eq!(db.schema_version().unwrap(), storage::LATEST_VERSION);
    let n: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(
        budget_core::settings::get(db.conn(), "update_check")
            .unwrap()
            .as_deref(),
        Some("1")
    );
}

/// Таблицы открытой схемы и их колонки (в порядке схемы), кроме служебных.
fn schema_tables(c: &rusqlite::Connection) -> Vec<(String, Vec<String>)> {
    let names: Vec<String> = c
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts%' ORDER BY name",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    names
        .into_iter()
        .map(|t| {
            let cols: Vec<String> = c
                .prepare(&format!("PRAGMA table_info({t})"))
                .unwrap()
                .query_map([], |r| r.get(1))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            (t, cols)
        })
        .collect()
}

/// Все строки таблицы по заданным колонкам, отсортированные, текстом.
fn dump(c: &rusqlite::Connection, table: &str, cols: &[String]) -> Vec<String> {
    let list = cols.join(", ");
    let mut rows: Vec<String> = c
        .prepare(&format!("SELECT {list} FROM {table}"))
        .unwrap()
        .query_map([], |r| {
            let mut s = String::new();
            for i in 0..cols.len() {
                let v: rusqlite::types::Value = r.get(i)?;
                s.push_str(&format!("{v:?}|"));
            }
            Ok(s)
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    rows.sort();
    rows
}

/// База 0.15.2 (миграции 0001–0008) с данными примера обновляется до 0010
/// (через займы 0009)
/// без потерь: все прежние строки и колонки на месте, копия сделана,
/// новые расчёты работают на старых данных.
#[test]
fn upgrade_from_0_15_2_with_demo_data_keeps_everything() {
    let dir = tempfile::tempdir().unwrap();
    // Данные примера (включая дубль, теги и т. п.) — во временной новой базе.
    let src = dir.path().join("demo.db");
    {
        let mut db = Storage::open(&src, &opts(dir.path())).unwrap();
        budget_core::demo::seed(db.conn_mut(), "2026-10-20").unwrap();
    }
    // Настоящая схема 0.15.2 и перенос в неё всех строк по её колонкам.
    let path = dir.path().join("budget.db");
    let tables = {
        let db = Storage::open_with(&path, &opts(dir.path()), &MIGRATIONS[..8]).unwrap();
        assert_eq!(db.schema_version().unwrap(), 8);
        let c = db.conn();
        let tables = schema_tables(c);
        c.execute("ATTACH DATABASE ?1 AS src", [src.to_str().unwrap()])
            .unwrap();
        c.execute_batch("PRAGMA foreign_keys = OFF; BEGIN;")
            .unwrap();
        for (t, cols) in &tables {
            let list = cols.join(", ");
            c.execute(&format!("DELETE FROM main.{t}"), []).unwrap();
            c.execute(
                &format!("INSERT INTO main.{t} ({list}) SELECT {list} FROM src.{t}"),
                [],
            )
            .unwrap();
        }
        // Настроек 0.16 и 0.17 из новой базы в 0.15.2 не бывает.
        c.execute(
            "DELETE FROM settings WHERE key IN ('budget_alerts', 'budget_alerts_seeded', 'loan_lender_name')",
            [],
        )
            .unwrap();
        c.execute_batch("COMMIT; PRAGMA foreign_keys = ON; DETACH DATABASE src;")
            .unwrap();
        let fk: i64 = c
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(fk, 0, "данные 0.15.2 согласованы");
        tables
    };
    let before: Vec<Vec<String>> = {
        let c = rusqlite::Connection::open(&path).unwrap();
        tables.iter().map(|(t, cols)| dump(&c, t, cols)).collect()
    };
    let txns = before[tables
        .iter()
        .position(|(t, _)| t == "transactions")
        .unwrap()]
    .len();
    assert!(txns > 50, "в примере много операций: {txns}");

    let db = Storage::open(&path, &opts(dir.path())).unwrap();
    assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
    assert!(
        db.pre_migration_backup().is_some(),
        "копия перед обновлением"
    );
    let c = db.conn();
    for ((t, cols), old) in tables.iter().zip(&before) {
        if t == "settings" {
            continue;
        }
        assert_eq!(&dump(c, t, cols), old, "таблица {t} не изменилась");
    }
    let settings = budget_core::settings::all(c).unwrap();
    assert_eq!(settings["budget_alerts"], "1");
    let old_settings = &before[tables.iter().position(|(t, _)| t == "settings").unwrap()];
    for row in old_settings {
        assert!(
            dump(c, "settings", &["key".into(), "value".into()]).contains(row),
            "настройка {row}"
        );
    }
    // Новые колонки пусты, представление совпадает с операциями.
    let (split, spread): (i64, i64) = c
        .query_row(
            "SELECT count(split_id), count(spread_months) FROM transactions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((split, spread), (0, 0));
    let view: i64 = c
        .query_row("SELECT count(*) FROM txn_by_month", [], |r| r.get(0))
        .unwrap();
    assert_eq!(view as usize, txns);
    // Расчёты 0.16 работают на старых данных.
    budget_core::budgets::get(c, "2026-10", "2026-10-20").unwrap();
    budget_core::usual::compare(c, "2026-10", "2026-10-20").unwrap();
    budget_core::checks::list(c, "2026-10-20").unwrap();
    let h = budget_core::net_worth::history(c, "2026-10-20", Some(12)).unwrap();
    assert_eq!(h.points.len(), 12);
}

/// Настоящая схема 0.16 (0001–0009), а не новая база с подменённым user_version:
/// заём по дням и платёж с заметками переживают обновление и восстановление.
#[test]
fn upgrade_from_0_16_keeps_daily_loan_payments_notes_and_restores_old_backup() {
    use budget_core::accounts::{self, AccountInput};
    use budget_core::debts::{self, DebtInput, PaymentInput};
    use budget_core::notes::{self, NoteInput};

    const AS_OF: &str = "2026-10-20";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.db");
    let options = opts(dir.path());
    let (card, debt, tables, before, balance, detail, interest) = {
        let mut db = Storage::open_with(&path, &options, &MIGRATIONS[..9]).unwrap();
        assert_eq!(db.schema_version().unwrap(), 9);
        let has_monthly_view: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'txn_by_month'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_monthly_view, 0);
        budget_core::categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(
            db.conn(),
            &AccountInput {
                name: "Карта из 0.16".into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 1_000_000,
                opening_date: "2026-08-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap();
        let debt = debts::create(
            db.conn_mut(),
            &DebtInput {
                direction: "borrowed".into(),
                counterparty: "Банк 0.16".into(),
                note: Some("Исходные условия займа".into()),
                currency_code: "RUB".into(),
                principal: 30_000_000,
                issue_date: "2026-08-15".into(),
                rate_bp: 1_200,
                repayment_type: "annuity".into(),
                term_months: Some(24),
                first_payment_date: Some("2026-09-15".into()),
                maturity_date: None,
                account_id: Some(card.clone()),
                interest_method: Some("daily".into()),
                rate_changes: vec![],
                planned_early: vec![],
            },
        )
        .unwrap();
        let first = debts::get(db.conn(), &debt, AS_OF)
            .unwrap()
            .schedule
            .into_iter()
            .next()
            .unwrap();
        assert!(first.interest_part > 0);
        let payment = debts::pay(
            db.conn_mut(),
            &debt,
            &PaymentInput {
                date: first.due_date,
                account_id: card.clone(),
                principal: first.principal_part,
                interest: first.interest_part,
                schedule_id: Some(first.id),
                recalc_mode: None,
            },
        )
        .unwrap();
        let (principal_txn, interest_txn): (String, String) = db
            .conn()
            .query_row(
                "SELECT principal_transaction_id, interest_transaction_id
                 FROM debt_payments WHERE id = ?1",
                [&payment],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        for (body, transaction_id, debt_id) in [
            ("Подтверждение возврата долга", Some(principal_txn), None),
            ("Квитанция процентов", Some(interest_txn), None),
            ("Документы по займу", None, Some(debt.clone())),
        ] {
            notes::create(
                db.conn(),
                &NoteInput {
                    body: body.into(),
                    transaction_id,
                    debt_id,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let c = db.conn();
        let tables = schema_tables(c);
        let before: Vec<Vec<String>> = tables.iter().map(|(t, cols)| dump(c, t, cols)).collect();
        let balance = accounts::balance(c, &card, None).unwrap();
        let detail = serde_json::to_value(debts::get(c, &debt, AS_OF).unwrap()).unwrap();
        assert_eq!(detail["card"]["interestMethod"], "daily");
        (
            card,
            debt,
            tables,
            before,
            balance,
            detail,
            first.interest_part,
        )
    };

    let mut db = Storage::open(&path, &options).unwrap();
    assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
    let old_backup = db
        .pre_migration_backup()
        .expect("перед переходом со схемы 9 нужна копия")
        .to_path_buf();
    {
        let copy = rusqlite::Connection::open_with_flags(
            &old_backup,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(storage::schema_version(&copy).unwrap(), 9);
        for ((table, cols), old) in tables.iter().zip(&before) {
            assert_eq!(&dump(&copy, table, cols), old, "копия: {table}");
        }
    }

    let assert_migrated_data = |c: &rusqlite::Connection| {
        for ((table, cols), old) in tables.iter().zip(&before) {
            let current = dump(c, table, cols);
            if table == "settings" {
                for row in old {
                    assert!(current.contains(row), "прежняя настройка {row}");
                }
            } else {
                assert_eq!(&current, old, "данные 0.16: {table}");
            }
        }
        assert_eq!(accounts::balance(c, &card, None).unwrap(), balance);
        assert_eq!(
            serde_json::to_value(debts::get(c, &debt, AS_OF).unwrap()).unwrap(),
            detail,
            "условия, график и платёж по займу не пересчитаны миграцией"
        );
        let violations: i64 = c
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
        let extras: i64 = c
            .query_row(
                "SELECT count(*) FROM transactions
                 WHERE split_id IS NOT NULL OR spread_months IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(extras, 0, "старые платежи не стали чеками или рассрочками");
        let (actual, monthly): (i64, i64) = c
            .query_row(
                "SELECT (SELECT count(*) FROM transactions),
                        (SELECT count(*) FROM txn_by_month)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(monthly, actual);
        let summary = budget_core::reports::period_summary(c, "2026-08-01", "2026-09-30").unwrap();
        assert_eq!(summary.income, 0, "выдача займа осталась переводом");
        assert_eq!(summary.expense, interest, "основной долг не стал расходом");
    };
    assert_migrated_data(db.conn());

    // Вносим второй платёж уже в 0.17, чтобы восстановление действительно
    // заменяло изменённые финансовые данные, а не повторно открывало их.
    let next = debts::get(db.conn(), &debt, AS_OF)
        .unwrap()
        .schedule
        .into_iter()
        .find(|row| row.status == "pending")
        .unwrap();
    let later_payment = debts::pay(
        db.conn_mut(),
        &debt,
        &PaymentInput {
            date: next.due_date,
            account_id: card.clone(),
            principal: next.principal_part,
            interest: next.interest_part,
            schedule_id: Some(next.id),
            recalc_mode: None,
        },
    )
    .unwrap();
    assert_ne!(accounts::balance(db.conn(), &card, None).unwrap(), balance);
    let safety = db.restore_from(&old_backup, &options).unwrap();
    assert_eq!(db.schema_version().unwrap(), LATEST_VERSION);
    assert_migrated_data(db.conn());

    // Страховка сохраняет состояние 0.17 до восстановления: второй платёж
    // есть там, но отсутствует в восстановленной и обновлённой базе 0.16.
    let safety =
        rusqlite::Connection::open_with_flags(safety, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    assert_eq!(storage::schema_version(&safety).unwrap(), LATEST_VERSION);
    let payments_in_safety: i64 = safety
        .query_row(
            "SELECT count(*) FROM debt_payments WHERE id = ?1",
            [&later_payment],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(payments_in_safety, 1);
    let restored_payment: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM debt_payments WHERE id = ?1",
            [&later_payment],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(restored_payment, 0);
}
