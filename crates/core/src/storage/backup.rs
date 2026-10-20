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
    // Остатки копии, прерванной падением или выключением компьютера.
    remove_part(tmp)?;
    {
        let mut target = Connection::open(tmp)?;
        let backup = Backup::new(conn, &mut target)?;
        backup.run_to_completion(256, Duration::from_millis(10), None)?;
        drop(backup);
        // Копия — один самостоятельный файл: без режима WAL её открытие (проверка
        // перед восстановлением) не оставит рядом файлов -wal и -shm.
        target.pragma_update_and_check(None, "journal_mode", "DELETE", |_| Ok(()))?;
    }
    fs::rename(tmp, dest)?;
    Ok(())
}

/// Удалить недописанную копию вместе со служебными файлами SQLite.
fn remove_part(tmp: &Path) -> Result<()> {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let mut name = tmp.as_os_str().to_owned();
        name.push(suffix);
        let p = Path::new(&name);
        if p.exists() {
            fs::remove_file(p)?;
        }
    }
    Ok(())
}

/// Оставить в папке `keep` самых новых копий с данным префиксом и убрать
/// недописанные (`.part`), оставшиеся после прерванного копирования.
/// Имена копий содержат метку времени, поэтому порядок по имени = по времени.
pub fn prune_backups(dir: &Path, prefix: &str, keep: usize) -> Result<()> {
    for e in fs::read_dir(dir)?.filter_map(|e| e.ok()) {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(".db.part") {
            remove_part(&e.path())?;
        }
    }
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
