//! Несколько файлов бюджета («Семья», «Дача», «Бизнес мамы») и переносная версия.
//!
//! Список файлов и текущий файл хранятся в `files.json` в папке данных. Новый
//! файл создаётся в `files/` рядом с основным; любой другой файл Kazna
//! можно открыть с диска. Переключение закрывает текущую базу и открывает
//! другую, журнал отмены очищается.

use std::fs;
use std::path::{Path, PathBuf};

use budget_core::backups;
use budget_core::storage::Storage;
use serde::{Deserialize, Serialize};

use crate::AppState;

/// Основной файл данных в папке данных.
pub const MAIN: &str = "budget.db";
const LIST: &str = "files.json";
/// Файл-признак переносной версии рядом с программой.
pub const PORTABLE_MARK: &str = "portable";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetFile {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    current: Option<String>,
    files: Vec<BudgetFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub name: String,
    pub path: String,
    pub current: bool,
    /// Файла нет на месте (например, флешка не вставлена).
    pub missing: bool,
    pub main: bool,
}

/// Папка переносной версии: `data` рядом с программой, если там лежит файл `portable`.
pub fn portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    dir.join(PORTABLE_MARK).exists().then(|| dir.join("data"))
}

fn main_path(data_dir: &Path) -> PathBuf {
    data_dir.join(MAIN)
}

fn load(data_dir: &Path) -> Registry {
    fs::read_to_string(data_dir.join(LIST))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store(data_dir: &Path, r: &Registry) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(r).map_err(|e| e.to_string())?;
    fs::write(data_dir.join(LIST), text)
        .map_err(|e| format!("не удалось сохранить список файлов: {e}"))
}

/// Файл, который открыть при запуске: последний выбранный, если он на месте.
pub fn startup_path(data_dir: &Path) -> PathBuf {
    match load(data_dir).current.map(PathBuf::from) {
        Some(p) if p.exists() => p,
        _ => main_path(data_dir),
    }
}

pub fn list(data_dir: &Path, current: &Path) -> Vec<FileRow> {
    let r = load(data_dir);
    let main = main_path(data_dir);
    let mut rows = vec![FileRow {
        name: "Основной".into(),
        path: main.display().to_string(),
        current: current == main,
        missing: false,
        main: true,
    }];
    for f in r.files.iter().filter(|f| Path::new(&f.path) != main) {
        rows.push(FileRow {
            name: f.name.clone(),
            path: f.path.clone(),
            current: Path::new(&f.path) == current,
            missing: !Path::new(&f.path).exists(),
            main: false,
        });
    }
    rows
}

/// Имя файла из названия: буквы и цифры, остальное — дефис.
fn slug(name: &str) -> String {
    let s: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "budget".into()
    } else {
        s.chars().take(40).collect()
    }
}

/// Новый пустой файл в `files/`; открывается мастер первого запуска.
pub fn create(state: &AppState, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("введите название, например «Дача»".into());
    }
    let dir = state.data_dir.join("files");
    let mut path = dir.join(format!("{}.db", slug(name)));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{}-{n}.db", slug(name)));
        n += 1;
    }
    let mut r = load(&state.data_dir);
    if r.files.iter().any(|f| f.name.eq_ignore_ascii_case(name)) || name == "Основной" {
        return Err(format!("файл «{name}» уже есть в списке"));
    }
    switch(state, &path)?;
    r = load(&state.data_dir);
    r.files.push(BudgetFile {
        name: name.into(),
        path: path.display().to_string(),
    });
    store(&state.data_dir, &r)?;
    Ok(path.display().to_string())
}

/// Открыть файл Kazna с диска и добавить в список.
pub fn open_existing(state: &AppState, path: &Path) -> Result<(), String> {
    backups::inspect(path).map_err(|e| e.to_string())?;
    let main = main_path(&state.data_dir);
    switch(state, path)?;
    if path != main {
        let mut r = load(&state.data_dir);
        let p = path.display().to_string();
        if !r.files.iter().any(|f| f.path == p) {
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Файл".into());
            r.files.push(BudgetFile { name, path: p });
            store(&state.data_dir, &r)?;
        }
    }
    Ok(())
}

/// Закрыть текущую базу и открыть другую. При ошибке остаётся прежняя.
pub fn switch(state: &AppState, path: &Path) -> Result<(), String> {
    if path != main_path(&state.data_dir) && path.exists() {
        backups::inspect(path).map_err(|e| e.to_string())?;
    }
    let mut guard = state.lock_db();
    if guard.as_ref().is_ok_and(|db| db.path() == path) {
        return Ok(());
    }
    let next = Storage::open(path, &state.open_options()).map_err(|e| e.to_string())?;
    // Старое соединение закрывается здесь, когда его место занимает новое.
    *guard = Ok(next);
    drop(guard);
    *state.lock_undo() = budget_core::undo::Journal::default();
    let mut r = load(&state.data_dir);
    r.current = Some(path.display().to_string());
    store(&state.data_dir, &r)
}

pub fn rename(state: &AppState, path: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("введите название".into());
    }
    let mut r = load(&state.data_dir);
    let Some(f) = r.files.iter_mut().find(|f| f.path == path) else {
        return Err("основной файл не переименовывается".into());
    };
    f.name = name.into();
    store(&state.data_dir, &r)
}

/// Убрать из списка (сам файл остаётся на диске). Открытый файл убрать нельзя.
pub fn forget(state: &AppState, path: &str) -> Result<(), String> {
    let open = state
        .lock_db()
        .as_ref()
        .ok()
        .map(|db| db.path().display().to_string());
    if open.as_deref() == Some(path) {
        return Err("сейчас открыт этот файл: сначала откройте другой".into());
    }
    let mut r = load(&state.data_dir);
    r.files.retain(|f| f.path != path);
    store(&state.data_dir, &r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_letters() {
        assert_eq!(slug(" Дача / 2027 "), "Дача---2027");
        assert_eq!(slug("***"), "budget");
    }

    #[test]
    fn startup_falls_back_to_main_when_file_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(startup_path(dir.path()), dir.path().join(MAIN));
        let r = Registry {
            current: Some(dir.path().join("нет.db").display().to_string()),
            files: vec![],
        };
        store(dir.path(), &r).unwrap();
        assert_eq!(startup_path(dir.path()), dir.path().join(MAIN));
        let other = dir.path().join("files").join("Дача.db");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, b"").unwrap();
        store(
            dir.path(),
            &Registry {
                current: Some(other.display().to_string()),
                files: vec![],
            },
        )
        .unwrap();
        assert_eq!(startup_path(dir.path()), other);
    }
}
