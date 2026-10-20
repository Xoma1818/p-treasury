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
