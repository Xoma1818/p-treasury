//! Копии файла базы через SQLite backup API.
//!
//! Копия пишется во временный файл и затем переименовывается, чтобы в
//! облачную папку (например, Яндекс.Диск) не попала недописанная копия.

use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::Connection;

use crate::Result;

pub fn backup_to(conn: &Connection, dest: &Path) -> Result<()> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp_name = dest.as_os_str().to_owned();
    tmp_name.push(".part");
    let tmp = Path::new(&tmp_name);
    {
        let mut target = Connection::open(tmp)?;
        let backup = Backup::new(conn, &mut target)?;
        backup.run_to_completion(256, Duration::from_millis(10), None)?;
    }
    fs::rename(tmp, dest)?;
    Ok(())
}

/// Оставить в папке `keep` самых новых копий с данным префиксом.
/// Имена копий содержат метку времени, поэтому порядок по имени = по времени.
pub fn prune_backups(dir: &Path, prefix: &str, keep: usize) -> Result<()> {
    let mut files: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|ext| ext == "db")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(prefix))
        })
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(keep);
    for old in &files[..excess] {
        fs::remove_file(old)?;
    }
    Ok(())
}
