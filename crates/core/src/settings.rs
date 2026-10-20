//! Настройки приложения: ключ-значение в таблице `settings`.
//! Набор ключей и значения по умолчанию задаются миграциями.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{Error, Result};

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

pub fn all(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Изменить существующую настройку. Неизвестный ключ — ошибка, чтобы опечатка
/// в UI не создавала мусорных записей.
pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE settings SET value = ?2 WHERE key = ?1",
        params![key, value],
    )?;
    if changed == 0 {
        return Err(Error::UnknownSetting(key.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    #[test]
    fn defaults_and_update() {
        let db = Storage::open_in_memory().unwrap();
        assert_eq!(
            get(db.conn(), "base_currency").unwrap().as_deref(),
            Some("RUB")
        );
        set(db.conn(), "hide_amounts", "1").unwrap();
        assert_eq!(all(db.conn()).unwrap()["hide_amounts"], "1");
        assert!(matches!(
            set(db.conn(), "nope", "1"),
            Err(Error::UnknownSetting(_))
        ));
    }
}
