//! Миграции: нумерованные SQL-файлы, встроенные в приложение.
//!
//! Правила (architecture.md, «Безопасное обновление данных»): только вперёд,
//! только добавляющие изменения, каждая миграция в своей транзакции.
//! Версия схемы хранится в `PRAGMA user_version`.

use rusqlite::Connection;

use crate::{Error, Result};

#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        sql: include_str!("../../migrations/0001_init.sql"),
    },
    Migration {
        version: 2,
        name: "backups_updates",
        sql: include_str!("../../migrations/0002_backups_updates.sql"),
    },
    Migration {
        version: 3,
        name: "second_wave",
        sql: include_str!("../../migrations/0003_second_wave.sql"),
    },
    Migration {
        version: 4,
        name: "auto_rates",
        sql: include_str!("../../migrations/0004_auto_rates.sql"),
    },
    Migration {
        version: 5,
        name: "investments",
        sql: include_str!("../../migrations/0005_investments.sql"),
    },
    Migration {
        version: 6,
        name: "goals_subscriptions",
        sql: include_str!("../../migrations/0006_goals_subscriptions.sql"),
    },
];

pub const LATEST_VERSION: i64 = MIGRATIONS[MIGRATIONS.len() - 1].version;

/// Применить все миграции новее текущей версии схемы.
pub fn migrate(conn: &mut Connection, migrations: &[Migration]) -> Result<()> {
    debug_assert!(
        migrations
            .windows(2)
            .all(|w| w[1].version == w[0].version + 1),
        "версии миграций должны идти подряд"
    );
    let current = super::schema_version(conn)?;
    for m in migrations.iter().filter(|m| m.version > current) {
        let wrap = |source| Error::Migration {
            version: m.version,
            backup: None,
            source,
        };
        let tx = conn.transaction().map_err(wrap)?;
        tx.execute_batch(m.sql).map_err(wrap)?;
        tx.pragma_update(None, "user_version", m.version)
            .map_err(wrap)?;
        tx.commit().map_err(wrap)?;
    }
    Ok(())
}
