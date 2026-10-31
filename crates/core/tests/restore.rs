//! Восстановление старого бюджета (проверка надёжности, тред 26).
//!
//! Копия из каждой выпущенной схемы (1…последняя) с данными примера
//! восстанавливается в текущую версию: все прежние строки на месте, связи
//! целы, итог совпадает с обычным обновлением той же базы, проверка копии
//! проходит. Плюс края: повреждённая копия, сбой миграции копии, настройки
//! этого компьютера.

use std::path::{Path, PathBuf};

use budget_core::storage::{OpenOptions, Storage, LATEST_VERSION, MIGRATIONS};
use rusqlite::Connection;

const AS_OF: &str = "2026-10-20";

fn opts(dir: &Path) -> OpenOptions {
    OpenOptions {
        backup_dir: dir.join("backups"),
        keep_backups: 3,
    }
}

fn schema_tables(c: &Connection) -> Vec<(String, Vec<String>)> {
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

fn dump(c: &Connection, table: &str, cols: &[String]) -> Vec<String> {
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

fn dump_all(c: &Connection) -> Vec<(String, Vec<String>)> {
    schema_tables(c)
        .into_iter()
        .map(|(t, cols)| {
            let rows = dump(c, &t, &cols);
            (t, rows)
        })
        .collect()
}

fn count(c: &Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// Данные примера в новой базе.
fn demo(dir: &Path) -> PathBuf {
    let src = dir.join("demo.db");
    if !src.exists() {
        let mut db = Storage::open(&src, &opts(dir)).unwrap();
        budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
    }
    src
}

/// Настоящая схема `version` (миграции 0001…version) с данными примера,
/// перенесёнными по её колонкам. Настройки: только ключи, которые эта
/// схема знает (новые версии добавляют свои ключи миграциями).
fn old_copy(dir: &Path, version: usize) -> PathBuf {
    let src = demo(dir);
    let path = dir.join(format!("copy-v{version}.db"));
    let db = Storage::open_with(&path, &opts(dir), &MIGRATIONS[..version]).unwrap();
    assert_eq!(db.schema_version().unwrap(), version as i64);
    let c = db.conn();
    let tables = schema_tables(c);
    c.execute("ATTACH DATABASE ?1 AS src", [src.to_str().unwrap()])
        .unwrap();
    c.execute_batch("PRAGMA foreign_keys = OFF; BEGIN;")
        .unwrap();
    for (t, cols) in &tables {
        let list = cols.join(", ");
        if t == "settings" {
            c.execute(
                "UPDATE main.settings SET value =
                   (SELECT s.value FROM src.settings s WHERE s.key = main.settings.key)
                 WHERE key IN (SELECT key FROM src.settings)",
                [],
            )
            .unwrap();
            continue;
        }
        c.execute(&format!("DELETE FROM main.{t}"), []).unwrap();
        c.execute(
            &format!("INSERT INTO main.{t} ({list}) SELECT {list} FROM src.{t}"),
            [],
        )
        .unwrap();
    }
    c.execute_batch("COMMIT; DETACH DATABASE src;").unwrap();
    // В старой схеме не все таблицы, на которые ссылались строки примера,
    // уже были: такие строки в старой версии появиться не могли — убираем.
    loop {
        let broken: Vec<(String, i64)> = c
            .prepare("SELECT \"table\", rowid FROM pragma_foreign_key_check")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        if broken.is_empty() {
            break;
        }
        for (t, rowid) in broken {
            c.execute(&format!("DELETE FROM {t} WHERE rowid = ?1"), [rowid])
                .unwrap();
        }
    }
    c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    drop(db);
    // Копия программы — самостоятельный файл без WAL, как делает backup_to.
    let out = dir.join(format!("backup-v{version}.db"));
    let c = Connection::open(&path).unwrap();
    budget_core::storage::backup_to(&c, &out).unwrap();
    out
}

/// Рабочая база текущей версии со своими данными (их восстановление заменит).
fn live(dir: &Path) -> Storage {
    let db = Storage::open(&dir.join("live").join("budget.db"), &opts(dir)).unwrap();
    db.conn()
        .execute(
            "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, created_at, updated_at)
             VALUES ('live-acc', 'Только в рабочей', 'cash', 'RUB', 100, '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    db
}

#[test]
fn copy_from_every_schema_restores_like_an_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    for version in 1..=MIGRATIONS.len() {
        let copy = old_copy(dir.path(), version);
        let before = {
            let c = Connection::open(&copy).unwrap();
            dump_all(&c)
        };
        let info = budget_core::backups::inspect(&copy).unwrap();
        assert_eq!(info.schema_version, version as i64);

        // Проверка копии (кнопка «Проверить копию»).
        let v = budget_core::backups::verify(&copy)
            .unwrap_or_else(|e| panic!("v{version}: проверка копии: {e}"));
        assert_eq!(v.transactions, info.transactions, "v{version}");

        // Восстановление в рабочую базу текущей версии.
        let mut db = live(dir.path());
        let safety = db.restore_from(&copy, &opts(dir.path())).unwrap();
        assert!(safety.exists(), "v{version}: страховка прежних данных");
        let c = db.conn();
        assert_eq!(db.schema_version().unwrap(), LATEST_VERSION, "v{version}");
        assert_eq!(count(c, "SELECT count(*) FROM pragma_foreign_key_check"), 0);
        let ok: String = c
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ok, "ok", "v{version}");
        assert_eq!(
            count(c, "SELECT count(*) FROM accounts WHERE id = 'live-acc'"),
            0,
            "v{version}: рабочие данные заменены копией"
        );
        // Все строки и колонки копии на месте.
        let now = schema_tables(c);
        for (t, rows) in &before {
            let cols = &now
                .iter()
                .find(|(n, _)| n == t)
                .unwrap_or_else(|| panic!("v{version}: таблица {t} пропала"))
                .1;
            let old_cols: Vec<String> = {
                let oc = Connection::open(&copy).unwrap();
                schema_tables(&oc)
                    .into_iter()
                    .find(|(n, _)| n == t)
                    .unwrap()
                    .1
            };
            assert!(old_cols.iter().all(|col| cols.contains(col)));
            let current = dump(c, t, &old_cols);
            if t == "settings" {
                assert!(
                    rows.iter().all(|r| current.contains(r)),
                    "v{version}: прежние настройки"
                );
            } else {
                assert_eq!(&current, rows, "v{version}: таблица {t}");
            }
        }

        // Тот же файл, открытый обычным обновлением, даёт ту же базу.
        let upgraded_path = dir.path().join(format!("upgraded-v{version}.db"));
        std::fs::copy(&copy, &upgraded_path).unwrap();
        let upgraded = Storage::open(&upgraded_path, &opts(dir.path())).unwrap();
        assert_eq!(
            dump_all(upgraded.conn()),
            dump_all(c),
            "v{version}: восстановление = обновление"
        );

        // Расчёты работают на восстановленных данных.
        if version >= 8 {
            budget_core::budgets::get(c, "2026-10", AS_OF).unwrap();
            budget_core::net_worth::history(c, AS_OF, Some(12)).unwrap();
            budget_core::reports::period_summary(c, "2026-01-01", "2026-10-31").unwrap();
        }
        drop(db);
        std::fs::remove_dir_all(dir.path().join("live")).unwrap();
    }
}

/// Повреждённая копия (испорчена страница данных) не должна заменить
/// рабочие данные: восстановление отказывает, рабочая база прежняя.
#[test]
fn damaged_copy_does_not_replace_data() {
    let dir = tempfile::tempdir().unwrap();
    let copy = old_copy(dir.path(), MIGRATIONS.len());
    // Портим середину файла: заголовок цел, user_version читается.
    let mut bytes = std::fs::read(&copy).unwrap();
    let page = 4096;
    let pages = bytes.len() / page;
    for p in (pages / 2)..(pages / 2 + 3).min(pages) {
        for b in &mut bytes[p * page + 8..p * page + 200] {
            *b = 0xA5;
        }
    }
    std::fs::write(&copy, &bytes).unwrap();
    let integrity = {
        let c = Connection::open(&copy).unwrap();
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap_or_else(|e| e.to_string())
    };
    assert_ne!(integrity, "ok", "копия действительно повреждена");

    let mut db = live(dir.path());
    let result = db.restore_from(&copy, &opts(dir.path()));
    let kept = count(
        db.conn(),
        "SELECT count(*) FROM accounts WHERE id = 'live-acc'",
    );
    assert!(
        result.is_err() && kept == 1,
        "повреждённая копия: восстановление {:?}, рабочий счёт {kept}, проверка копии «{integrity}»",
        result.map(|_| "прошло")
    );
}

/// Если копию не удалось обновить до текущей схемы (сбой миграции),
/// рабочие данные остаются прежними, а не полуобновлённой копией.
#[test]
fn failed_migration_of_copy_keeps_live_data() {
    let dir = tempfile::tempdir().unwrap();
    let version = MIGRATIONS.len() - 1;
    let copy = old_copy(dir.path(), version);
    // Таблица, которую создаёт последняя миграция, уже есть — миграция упадёт.
    {
        let c = Connection::open(&copy).unwrap();
        let last = MIGRATIONS.last().unwrap();
        let table = last
            .sql
            .split("CREATE TABLE ")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .expect("последняя миграция создаёт таблицу");
        c.execute_batch(&format!("CREATE TABLE {table} (x)"))
            .unwrap();
    }
    let mut db = live(dir.path());
    let result = db.restore_from(&copy, &opts(dir.path()));
    assert!(result.is_err(), "миграция копии должна упасть");
    let kept = count(
        db.conn(),
        "SELECT count(*) FROM accounts WHERE id = 'live-acc'",
    );
    let schema = db.schema_version().unwrap();
    assert!(
        kept == 1 && schema == LATEST_VERSION,
        "после сбоя: рабочий счёт {kept}, схема {schema} (ожидалось 1 и {LATEST_VERSION})"
    );
}

/// Настройки папки сохранности относятся к этому компьютеру: старая копия
/// или копия с другого компьютера не выключает копирование и не уводит его
/// в чужую папку (флешку, которой здесь нет).
#[test]
fn restore_keeps_this_computers_vault_settings() {
    let dir = tempfile::tempdir().unwrap();
    let copy = old_copy(dir.path(), MIGRATIONS.len());
    {
        let c = Connection::open(&copy).unwrap();
        budget_core::settings::set(&c, "vault_dir", r"E:\Флешка\Kazna").unwrap();
        budget_core::settings::set(&c, "vault_on", "0").unwrap();
        budget_core::settings::set(&c, "base_currency", "EUR").unwrap();
    }
    let mut db = live(dir.path());
    let here = r"C:\Users\otto\Яндекс.Диск\Kazna";
    budget_core::settings::set(db.conn(), "vault_dir", here).unwrap();
    budget_core::settings::set(db.conn(), "vault_on", "1").unwrap();
    db.restore_from(&copy, &opts(dir.path())).unwrap();
    let get = |k: &str| {
        budget_core::settings::get(db.conn(), k)
            .unwrap()
            .unwrap_or_default()
    };
    assert_eq!(get("vault_dir"), here);
    assert_eq!(get("vault_on"), "1");
    // Остальные настройки бюджета — из копии.
    assert_eq!(get("base_currency"), "EUR");
}

/// Тестовая база с данными примера на текущей схеме — для проверки
/// обновления установщиком (upgrade-check.yml, тред 9). Запуск вручную:
/// `KAZNA_FIXTURE=/путь/upgrade.db cargo test -p budget-core --test restore -- --ignored`.
#[test]
#[ignore = "создаёт тестовую базу по запросу"]
fn make_upgrade_fixture() {
    let Ok(out) = std::env::var("KAZNA_FIXTURE") else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let src = demo(dir.path());
    let c = Connection::open(&src).unwrap();
    budget_core::storage::backup_to(&c, Path::new(&out)).unwrap();
}
