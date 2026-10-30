//! Резервные копии: ручная копия в файл, проверка файла копии и напоминание,
//! если копий давно не было. Автокопии делает папка сохранности ([`crate::vault`]).
//! Восстановление — `Storage::restore_from`.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::error::invalid;
use crate::storage::{backup_to, Storage, LATEST_VERSION};
use crate::{settings, time, Error, Result};

/// Итог проверки восстановления копии.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub path: String,
    /// Когда проверили (UTC, RFC 3339).
    pub checked_at: String,
    pub schema_version: i64,
    pub accounts: i64,
    pub transactions: i64,
    pub last_date: Option<String>,
}

/// Проверить, что из копии можно восстановиться: файл открывается, проходит
/// проверку целостности SQLite, пробное восстановление в память с миграциями
/// до текущей схемы удаётся, связи между записями целы, а число счетов и
/// операций после восстановления совпадает с копией. Рабочие данные не трогает.
pub fn verify(path: &Path) -> Result<Verified> {
    let info = inspect(path)?;
    {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return invalid(format!("копия повреждена: {integrity}"));
        }
    }
    let restored = crate::storage::Storage::rehearse_restore(path)
        .map_err(|e| Error::Validation(format!("пробное восстановление не удалось: {e}")))?;
    let c = restored.conn();
    let broken: i64 = c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if broken > 0 {
        return invalid(format!("в копии нарушены связи между записями: {broken}"));
    }
    let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
    let accounts = count("SELECT COUNT(*) FROM accounts WHERE type <> 'debt'")?;
    let transactions = count("SELECT COUNT(*) FROM transactions")?;
    if (accounts, transactions) != (info.accounts, info.transactions) {
        return invalid(format!(
            "после восстановления не сходятся данные: счетов {accounts} из {}, операций {transactions} из {}",
            info.accounts, info.transactions
        ));
    }
    Ok(Verified {
        path: info.path,
        checked_at: time::now_utc(),
        schema_version: info.schema_version,
        accounts,
        transactions,
        last_date: info.last_date,
    })
}

/// Запомнить итог проверки: успешная обновляет дату последней проверенной
/// копии, неудачная — только текст ошибки (прежняя успешная дата остаётся).
pub fn record_verify(conn: &Connection, result: &Result<Verified>) -> Result<()> {
    match result {
        Ok(v) => {
            settings::set(conn, "backup_verified_at", &v.checked_at)?;
            settings::set(conn, "backup_verified_path", &v.path)?;
            settings::set(
                conn,
                "backup_verified_info",
                &serde_json::to_string(v).unwrap_or_default(),
            )?;
            settings::set(conn, "backup_verify_error", "")?;
        }
        Err(e) => settings::set(conn, "backup_verify_error", &e.to_string())?,
    }
    Ok(())
}

/// Записать итог проверки в тот бюджет, копию которого проверяли (`origin` —
/// его файл). Проверка идёт без замка на базу, и за это время могли открыть
/// другой бюджет: тогда итог не записывается (`false`), иначе другой бюджет
/// показал бы проверку, которой у него не было.
pub fn record_verify_for(db: &Storage, origin: &Path, result: &Result<Verified>) -> Result<bool> {
    if db.path() != origin {
        return Ok(false);
    }
    record_verify(db.conn(), result)?;
    Ok(true)
}

/// Последняя успешно проверенная копия и ошибка последней проверки.
pub fn last_verified(conn: &Connection) -> Result<(Option<Verified>, Option<String>)> {
    let info =
        settings::get(conn, "backup_verified_info")?.and_then(|v| serde_json::from_str(&v).ok());
    let error = settings::get(conn, "backup_verify_error")?.filter(|v| !v.is_empty());
    Ok((info, error))
}

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
    use crate::storage::OpenOptions;

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

    #[test]
    fn verify_restore_records_last_good_copy() {
        let dir = tempfile::tempdir().unwrap();
        let db = Storage::open(&dir.path().join("budget.db"), &opts(dir.path())).unwrap();
        accounts::create(db.conn(), &input("Карта", "debit", "RUB", 1_000)).unwrap();
        let copy = dir.path().join("copy.db");
        backup(db.conn(), &copy).unwrap();

        let ok = verify(&copy);
        let v = ok.as_ref().unwrap().clone();
        assert_eq!((v.accounts, v.schema_version), (1, LATEST_VERSION));
        record_verify(db.conn(), &ok).unwrap();
        assert_eq!(last_verified(db.conn()).unwrap(), (Some(v.clone()), None));

        // Испорченная копия: проверка не проходит, дата прошлой удачной остаётся.
        let mut bytes = std::fs::read(&copy).unwrap();
        let mid = bytes.len() / 2;
        for b in &mut bytes[100..mid] {
            *b = 0x5a;
        }
        let broken = dir.path().join("broken.db");
        std::fs::write(&broken, &bytes).unwrap();
        let bad = verify(&broken);
        assert!(bad.is_err());
        record_verify(db.conn(), &bad).unwrap();
        let (kept, error) = last_verified(db.conn()).unwrap();
        assert_eq!(kept, Some(v));
        assert!(error.is_some());

        // Не файл программы.
        let txt = dir.path().join("notes.txt");
        std::fs::write(&txt, "привет").unwrap();
        assert!(verify(&txt).is_err());
    }

    #[test]
    fn verify_result_stays_with_its_budget() {
        let dir = tempfile::tempdir().unwrap();
        let a_path = dir.path().join("a.db");
        let a = Storage::open(&a_path, &opts(dir.path())).unwrap();
        accounts::create(a.conn(), &input("Карта", "debit", "RUB", 1_000)).unwrap();
        let copy = dir.path().join("a-copy.db");
        backup(a.conn(), &copy).unwrap();
        let b = Storage::open(&dir.path().join("b.db"), &opts(dir.path())).unwrap();

        // Проверяли копию бюджета A, а к концу проверки открыт бюджет B.
        let ok = verify(&copy);
        assert!(ok.is_ok());
        assert!(!record_verify_for(&b, &a_path, &ok).unwrap());
        assert_eq!(last_verified(b.conn()).unwrap(), (None, None));
        let bad: Result<Verified> = Err(Error::Validation("сбой".into()));
        assert!(!record_verify_for(&b, &a_path, &bad).unwrap());
        assert_eq!(last_verified(b.conn()).unwrap(), (None, None));

        // Тот же бюджет — итог записан.
        assert!(record_verify_for(&a, &a_path, &ok).unwrap());
        assert_eq!(last_verified(a.conn()).unwrap().0, Some(ok.unwrap()));
    }

    #[test]
    fn verify_old_copy_goes_through_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.db");
        let old =
            Storage::open_with(&path, &opts(dir.path()), &crate::storage::MIGRATIONS[..9]).unwrap();
        accounts::create(old.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        drop(old);
        let v = verify(&path).unwrap();
        assert_eq!((v.schema_version, v.accounts), (9, 1));
        // Сам файл копии не изменился: схема прежняя.
        assert_eq!(inspect(&path).unwrap().schema_version, 9);
    }
}
