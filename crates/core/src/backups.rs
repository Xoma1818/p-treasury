//! Резервные копии: ручная копия в файл, проверка файла копии и напоминание,
//! если копий давно не было. Автокопии делает папка сохранности ([`crate::vault`]).
//! Восстановление — `Storage::restore_from`.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::error::invalid;
use crate::storage::{backup_to, LATEST_VERSION};
use crate::{settings, time, Error, Result};

/// Через сколько дней без копии напоминать о ней (папка сохранности выключена
/// или недоступна).
pub const REMIND_AFTER_DAYS: i64 = 30;

/// Имя файла ручной копии по умолчанию.
pub fn default_name() -> String {
    format!("p-treasury-{}.db", time::file_stamp())
}

/// Сделать копию в файл и запомнить время последней копии.
pub fn backup(conn: &Connection, dest: &Path) -> Result<()> {
    backup_to(conn, dest)?;
    settings::set(conn, "last_backup_at", &time::now_utc())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub schema_version: i64,
    pub accounts: i64,
    pub transactions: i64,
    /// Дата последней операции в копии.
    pub last_date: Option<String>,
}

/// Проверить, что файл — копия P-Treasury, которую эта версия может открыть.
pub fn inspect(path: &Path) -> Result<BackupInfo> {
    let not_ours = || Error::Validation("это не файл данных P-Treasury".into());
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| not_ours())?;
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|_| not_ours())?;
    if version == 0 {
        return Err(not_ours());
    }
    if version > LATEST_VERSION {
        return invalid(format!("копия сделана более новой версией приложения (схема {version}); сначала обновите приложение"));
    }
    let count = |sql: &str| {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0))
            .map_err(|_| not_ours())
    };
    Ok(BackupInfo {
        path: path.display().to_string(),
        schema_version: version,
        accounts: count("SELECT COUNT(*) FROM accounts WHERE type <> 'debt'")?,
        transactions: count("SELECT COUNT(*) FROM transactions")?,
        last_date: conn
            .query_row("SELECT MAX(date) FROM transactions", [], |r| r.get(0))
            .map_err(|_| not_ours())?,
    })
}

/// Пора напомнить о копии: данные есть, а копии не было `REMIND_AFTER_DAYS` дней.
/// Работающая папка сохранности обновляет копию каждый день, и напоминания нет.
pub fn reminder_due(conn: &Connection, today: &str) -> Result<bool> {
    let first: Option<String> =
        conn.query_row("SELECT MIN(date) FROM transactions", [], |r| r.get(0))?;
    let Some(first) = first else { return Ok(false) };
    let since = settings::get(conn, "last_backup_at")?
        .filter(|v| v.len() >= 10)
        .map(|v| v[..10].to_string())
        .unwrap_or(first);
    let (Ok(since), Ok(today)) = (
        chrono::NaiveDate::parse_from_str(&since, "%Y-%m-%d"),
        chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d"),
    ) else {
        return Ok(false);
    };
    Ok((today - since).num_days() >= REMIND_AFTER_DAYS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::{OpenOptions, Storage};

    fn opts(dir: &Path) -> OpenOptions {
        OpenOptions {
            backup_dir: dir.join("backups"),
            keep_backups: 10,
        }
    }

    #[test]
    fn backup_and_restore_on_a_new_computer() {
        let dir = tempfile::tempdir().unwrap();
        let old = Storage::open(
            &dir.path().join("old/budget.db"),
            &opts(&dir.path().join("old")),
        )
        .unwrap();
        accounts::create(old.conn(), &input("Карта", "debit", "RUB", 1_234_500)).unwrap();
        let flash = dir.path().join("flash/p-treasury.db");
        backup(old.conn(), &flash).unwrap();
        assert!(settings::get(old.conn(), "last_backup_at")
            .unwrap()
            .unwrap()
            .starts_with("20"));
        let info = inspect(&flash).unwrap();
        assert_eq!((info.accounts, info.schema_version), (1, LATEST_VERSION));

        // «Новый компьютер»: пустая база, восстановление из копии.
        let new_dir = dir.path().join("new");
        let mut new = Storage::open(&new_dir.join("budget.db"), &opts(&new_dir)).unwrap();
        accounts::create(new.conn(), &input("Лишний", "cash", "RUB", 0)).unwrap();
        let safety = new.restore_from(&flash, &opts(&new_dir)).unwrap();
        let names: Vec<String> = accounts::list(new.conn(), true)
            .unwrap()
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, ["Карта"]);
        // Перед восстановлением прежние данные сохранены отдельной копией.
        assert!(safety.exists());
        assert_eq!(inspect(&safety).unwrap().accounts, 1);
        // После перезапуска данные те же.
        drop(new);
        let reopened = Storage::open(&new_dir.join("budget.db"), &opts(&new_dir)).unwrap();
        assert_eq!(
            accounts::list(reopened.conn(), true).unwrap()[0].balance,
            1_234_500
        );
    }

    #[test]
    fn foreign_and_newer_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("junk.db");
        std::fs::write(&junk, b"not a database").unwrap();
        assert!(inspect(&junk).is_err());
        let empty = dir.path().join("empty.db");
        Connection::open(&empty)
            .unwrap()
            .execute_batch("CREATE TABLE x(a);")
            .unwrap();
        assert!(inspect(&empty)
            .unwrap_err()
            .to_string()
            .contains("не файл данных"));
        let newer = dir.path().join("newer.db");
        let c = Connection::open(&newer).unwrap();
        c.pragma_update(None, "user_version", LATEST_VERSION + 1)
            .unwrap();
        drop(c);
        assert!(inspect(&newer)
            .unwrap_err()
            .to_string()
            .contains("более новой версией"));
        let mut db = Storage::open_in_memory().unwrap();
        assert!(db.restore_from(&junk, &opts(dir.path())).is_err());
    }

    #[test]
    fn reminder_after_30_days_without_copies() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        assert!(
            !reminder_due(c, "2026-10-20").unwrap(),
            "без данных не напоминаем"
        );
        crate::categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let cat: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Продукты'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        crate::transactions::create(
            c,
            &crate::transactions::TxnInput {
                kind: "expense".into(),
                date: "2026-09-01".into(),
                account_id: card,
                amount: 100,
                category_id: Some(cat),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
        assert!(!reminder_due(c, "2026-09-20").unwrap());
        assert!(reminder_due(c, "2026-10-01").unwrap());
        settings::set(c, "last_backup_at", "2026-09-25T10:00:00.000Z").unwrap();
        assert!(!reminder_due(c, "2026-10-01").unwrap());
        settings::set(c, "last_backup_at", "2026-11-30T23:10:00.000Z").unwrap();
        assert!(
            !reminder_due(c, "2026-12-01").unwrap(),
            "папка сохранности обновлялась вчера"
        );
    }
}
