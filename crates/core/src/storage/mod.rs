//! Хранение: подключение к SQLite, миграции, резервные копии.
//!
//! Это единственное место, которое открывает базу. Остальные модули ядра
//! получают `&Connection` или `&Transaction` отсюда.

mod backup;
mod migrations;

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

pub use backup::{backup_to, prune_backups};
pub use migrations::{migrate, Migration, LATEST_VERSION, MIGRATIONS};

use crate::{time, Error, Result};

/// Префикс имени копии, которая делается перед миграцией.
pub const PRE_MIGRATION_PREFIX: &str = "before-update";

pub struct OpenOptions {
    /// Куда класть копию перед миграцией (папка данных приложения).
    pub backup_dir: PathBuf,
    /// Сколько копий перед миграцией хранить.
    pub keep_backups: usize,
}

pub struct Storage {
    conn: Connection,
    path: PathBuf,
    /// Копия, сделанная перед миграцией при этом открытии (если была).
    pre_migration_backup: Option<PathBuf>,
}

impl Storage {
    /// Открыть файл данных: настроить SQLite, проверить версию схемы,
    /// при необходимости сделать копию и применить миграции.
    pub fn open(path: &Path, opts: &OpenOptions) -> Result<Self> {
        Self::open_with(path, opts, MIGRATIONS)
    }

    pub fn open_with(path: &Path, opts: &OpenOptions, migrations: &[Migration]) -> Result<Self> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let existed = fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false);
        let mut conn = Connection::open(path)?;
        configure(&conn)?;

        let supported = migrations.last().map_or(0, |m| m.version);
        let current = schema_version(&conn)?;
        if current > supported {
            return Err(Error::SchemaTooNew {
                found: current,
                supported,
            });
        }

        let mut pre_migration_backup = None;
        if current < supported && existed && current > 0 {
            fs::create_dir_all(&opts.backup_dir)?;
            let name = format!(
                "{PRE_MIGRATION_PREFIX}-v{current}-{}.db",
                time::file_stamp()
            );
            let dest = opts.backup_dir.join(name);
            backup_to(&conn, &dest)?;
            prune_backups(&opts.backup_dir, PRE_MIGRATION_PREFIX, opts.keep_backups)?;
            pre_migration_backup = Some(dest);
        }

        migrate(&mut conn, migrations).map_err(|e| match e {
            Error::Migration {
                version, source, ..
            } => Error::Migration {
                version,
                backup: pre_migration_backup.clone(),
                source,
            },
            other => other,
        })?;

        Ok(Self {
            conn,
            path: path.to_path_buf(),
            pre_migration_backup,
        })
    }

    /// База в памяти для тестов.
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        configure(&conn)?;
        migrate(&mut conn, MIGRATIONS)?;
        Ok(Self {
            conn,
            path: PathBuf::from(":memory:"),
            pre_migration_backup: None,
        })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> Result<i64> {
        schema_version(&self.conn)
    }

    pub fn pre_migration_backup(&self) -> Option<&Path> {
        self.pre_migration_backup.as_deref()
    }
}

fn configure(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Для базы в памяти SQLite оставит режим 'memory', это нормально.
    let _mode: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
}
