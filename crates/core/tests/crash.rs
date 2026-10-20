//! Надёжность данных (большой итоговый тест, пункт 5): процесс приложения
//! убивают посреди записи и посреди резервной копии. После этого база цела,
//! каждая сохранённая операция записана целиком, а недописанной копии нет.
//!
//! Тест запускает сам себя дочерним процессом (переменная PTREASURY_CRASH_CHILD)
//! и убивает его через SIGKILL — как выключение света или «снять задачу».

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use budget_core::accounts::{self, AccountInput};
use budget_core::backups;
use budget_core::storage::{backup_to, OpenOptions, Storage};
use budget_core::transactions::{self, TxnInput};
use rusqlite::{Connection, OpenFlags};

const CHILD: &str = "PTREASURY_CRASH_CHILD";
const DIR: &str = "PTREASURY_CRASH_DIR";

fn opts(dir: &Path) -> OpenOptions {
    OpenOptions {
        backup_dir: dir.join("backups"),
        keep_backups: 3,
    }
}

fn open(dir: &Path) -> Storage {
    Storage::open(&dir.join("budget.db"), &opts(dir)).unwrap()
}

fn integrity(path: &Path) -> String {
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap()
}

/// Подготовить базу: счёт и категория.
fn prepare(dir: &Path) -> (String, String) {
    let db = open(dir);
    budget_core::categories::seed_defaults(db.conn()).unwrap();
    let card = accounts::create(
        db.conn(),
        &AccountInput {
            name: "Карта".into(),
            kind: "debit".into(),
            currency_code: "RUB".into(),
            opening_balance: 1_000_000,
            opening_date: "2026-01-01".into(),
            credit_limit: None,
            include_in_total: true,
        },
    )
    .unwrap();
    let food: String = db
        .conn()
        .query_row(
            "SELECT id FROM categories WHERE name = 'Продукты'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    (card, food)
}

/// Дочерний процесс: бесконечно пишет (или копирует), пока его не убьют.
#[test]
fn crash_child() {
    let Ok(mode) = std::env::var(CHILD) else {
        return;
    };
    let dir = PathBuf::from(std::env::var(DIR).unwrap());
    let mut db = open(&dir);
    let card: String = db
        .conn()
        .query_row("SELECT id FROM accounts LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let food: String = db
        .conn()
        .query_row(
            "SELECT id FROM categories WHERE name = 'Продукты'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    match mode.as_str() {
        // Пачка из 10 операций — одна транзакция, как импорт или платёж по долгу.
        "write" => {
            let mut batch = 0u64;
            loop {
                batch += 1;
                let tx = db.conn_mut().transaction().unwrap();
                for i in 0..10 {
                    transactions::create(
                        &tx,
                        &TxnInput {
                            kind: "expense".into(),
                            date: "2026-10-20".into(),
                            account_id: card.clone(),
                            amount: 100 + i,
                            category_id: Some(food.clone()),
                            to_account_id: None,
                            to_amount: None,
                            payee: None,
                            note: Some(format!("пачка {}-{batch}", std::process::id())),
                        },
                    )
                    .unwrap();
                }
                tx.commit().unwrap();
            }
        }
        "backup" => loop {
            backup_to(db.conn(), &dir.join("flash/p-treasury.db")).unwrap();
        },
        _ => unreachable!(),
    }
}

fn spawn(dir: &Path, mode: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["crash_child", "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, mode)
        .env(DIR, dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// Дать процессу поработать и убить его без предупреждения.
fn kill_after(mut child: Child, ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn killed_during_writes_database_is_intact_and_batches_are_whole() {
    let dir = tempfile::tempdir().unwrap();
    prepare(dir.path());
    for round in 0..3 {
        kill_after(spawn(dir.path(), "write"), 600 + 150 * round);
        assert_eq!(integrity(&dir.path().join("budget.db")), "ok");
    }
    let db = open(dir.path());
    let (txns, broken): (i64, i64) = db
        .conn()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM transactions),
                    (SELECT COUNT(*) FROM (SELECT note FROM transactions GROUP BY note HAVING COUNT(*) <> 10))",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(txns > 0, "дочерний процесс успел что-то записать");
    // Каждая пачка либо записана целиком, либо её нет вовсе.
    assert_eq!(broken, 0, "неполных пачек нет (операций {txns})");
    // Баланс сходится с суммой операций.
    let card: String = db
        .conn()
        .query_row("SELECT id FROM accounts LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let spent: i64 = db
        .conn()
        .query_row("SELECT SUM(amount) FROM transactions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        accounts::balance(db.conn(), &card, None).unwrap(),
        1_000_000 - spent
    );
}

#[test]
fn killed_during_backup_leaves_no_broken_copy() {
    let dir = tempfile::tempdir().unwrap();
    prepare(dir.path());
    // Немного данных, чтобы копия занимала время.
    {
        let mut db = open(dir.path());
        let tx = db.conn_mut().transaction().unwrap();
        tx.execute_batch(
            "CREATE TABLE filler(x BLOB);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
             INSERT INTO filler SELECT randomblob(2000) FROM n;",
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let flash = dir.path().join("flash");
    for round in 0..4 {
        kill_after(spawn(dir.path(), "backup"), 300 + 70 * round);
        assert_eq!(integrity(&dir.path().join("budget.db")), "ok");
        // Под именем копии лежит только целая копия (если успела записаться).
        let copy = flash.join("p-treasury.db");
        if copy.exists() {
            assert_eq!(integrity(&copy), "ok");
            backups::inspect(&copy).unwrap();
        }
    }
    // Следующая копия убирает недописанный остаток.
    let db = open(dir.path());
    backups::backup(db.conn(), &flash.join("p-treasury.db")).unwrap();
    let names: Vec<String> = std::fs::read_dir(&flash)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["p-treasury.db"]);
}
