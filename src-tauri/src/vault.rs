//! Папка сохранности в оболочке: где она по умолчанию, когда обновляется
//! (при закрытии и раз в день), выбор облака или флешки и перенос данных
//! с другого компьютера. Сами копии и Excel делает `budget_core::vault`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use budget_core::vault::{self, Found, Status};
use budget_core::{backups, onboarding, settings, storage::Storage, time};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::AppState;

type CmdResult<T> = Result<T, String>;

/// Папка по умолчанию: `Документы\P-Treasury`; в переносной версии — рядом с
/// программой; в тестах (своя папка данных) — внутри папки данных.
pub fn default_dir(app: &AppHandle, data_dir: &Path, test_dir: bool, portable: bool) -> PathBuf {
    if let Some(dir) = std::env::var_os("PTREASURY_VAULT_DIR") {
        return PathBuf::from(dir);
    }
    if test_dir {
        return data_dir.join(vault::FOLDER);
    }
    if portable {
        if let Some(parent) = data_dir.parent() {
            return parent.join(vault::FOLDER);
        }
    }
    app.path()
        .document_dir()
        .unwrap_or_else(|_| data_dir.to_path_buf())
        .join(vault::FOLDER)
}

/// Название бюджета для имени копии: «Мой бюджет» или имя из списка файлов.
fn budget_name(state: &AppState, db: &Storage) -> String {
    crate::files::list(&state.data_dir, db.path())
        .into_iter()
        .find(|f| f.current && !f.main)
        .map(|f| vault::safe_name(&f.name))
        .unwrap_or_else(|| vault::MAIN_NAME.into())
}

/// Обновить папку для открытого бюджета. Ничего не делает, пока не пройден
/// первый запуск (на новом компьютере сначала предлагаем перенос) и если папка
/// выключена. Ошибка записывается в статус, её видно в Настройках.
///
/// База занята только на время копии; Excel-зеркало строится по копии, пока
/// программа работает дальше. Два обновления сразу (раз в день и при
/// закрытии) не идут: второе ждёт первое.
pub fn sync(state: &AppState, only_if_due: bool) {
    static RUNNING: Mutex<()> = Mutex::new(());
    let Ok(_running) = RUNNING.lock() else { return };
    let (copy, dir, name, origin) = {
        let guard = state.lock_db();
        let Ok(db) = guard.as_ref() else { return };
        let c = db.conn();
        if !onboarding::is_done(c).unwrap_or(false) {
            return;
        }
        if only_if_due && !vault::due(c, &time::today_local()).unwrap_or(false) {
            return;
        }
        let Ok(Some(dir)) = vault::dir(c, &state.vault_default) else {
            return;
        };
        let name = budget_name(state, db);
        match vault::sync_copy(c, &dir, &name) {
            Ok(copy) => (copy, dir, name, db.path().to_path_buf()),
            Err(e) => {
                eprintln!("папка сохранности не обновлена: {e}");
                let _ = vault::record(c, &Err(e));
                return;
            }
        }
    };
    let report = Ok(vault::SyncReport {
        excel_error: vault::sync_excel(&copy, &dir, &name)
            .err()
            .map(|e| e.to_string()),
        copy: copy.display().to_string(),
    });
    // Свежую копию сразу проверяем пробным восстановлением (в памяти, без базы).
    let verified = backups::verify(&copy);
    let guard = state.lock_db();
    // Пока строился Excel и шла проверка, могли открыть другой файл бюджета:
    // его статус не трогаем (сверяем файл базы, а не имя — имена бывают одинаковые).
    if let Ok(db) = guard.as_ref() {
        if db.path() == origin {
            let _ = vault::record(db.conn(), &report);
            let _ = backups::record_verify_for(db, &origin, &verified);
        }
    }
}

/// Проверить восстановление: свежая копия в папке сохранности (`path` пусто)
/// или выбранный файл копии. Итог запоминается, его видно в Настройках.
#[tauri::command(async)]
pub fn verify_backup(state: State<AppState>, path: Option<String>) -> CmdResult<Status> {
    // Бюджет, для которого проверяем: итог запишется только в него.
    let (file, origin) = {
        let guard = state.lock_db();
        let db = guard.as_ref().map_err(|e| e.clone())?;
        let file = match path.filter(|p| !p.trim().is_empty()) {
            Some(p) => PathBuf::from(p),
            None => {
                let dir = vault::dir(db.conn(), &state.vault_default)
                    .map_err(|e| e.to_string())?
                    .ok_or("папка сохранности выключена: выберите файл копии")?;
                dir.join(format!("{}.{}", budget_name(&state, db), vault::EXT))
            }
        };
        (file, db.path().to_path_buf())
    };
    let result = if file.exists() {
        backups::verify(&file)
    } else {
        Err(budget_core::Error::Validation(format!(
            "копии ещё нет: {}. Нажмите «Сохранить сейчас»",
            file.display()
        )))
    };
    {
        let guard = state.lock_db();
        let db = guard.as_ref().map_err(|e| e.clone())?;
        if !backups::record_verify_for(db, &origin, &result).map_err(|e| e.to_string())? {
            return Err(
                "пока шла проверка, открыли другой бюджет: итог не записан, проверьте ещё раз"
                    .into(),
            );
        }
    }
    result.map_err(|e| e.to_string())?;
    status_of(&state)
}

/// При выходе из приложения — один раз (и закрытие окна, и событие выхода вызывают её).
pub fn sync_on_exit(app: &AppHandle) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    sync(&app.state::<AppState>(), false);
}

fn status_of(state: &State<AppState>) -> CmdResult<Status> {
    let guard = state.lock_db();
    let db = guard.as_ref().map_err(|e| e.clone())?;
    vault::status(db.conn(), &state.vault_default).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn vault_status(state: State<AppState>) -> CmdResult<Status> {
    status_of(&state)
}

/// Обновить папку сейчас (кнопка «Сохранить сейчас»).
#[tauri::command(async)]
pub fn vault_sync(state: State<AppState>) -> CmdResult<Status> {
    sync(&state, false);
    status_of(&state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub label: String,
    pub path: String,
}

/// Куда можно положить папку: по умолчанию и облачные диски, которые есть на компьютере.
fn places(app: &AppHandle, state: &AppState) -> Vec<Place> {
    let mut out = vec![Place {
        label: if state.portable {
            "Рядом с программой"
        } else {
            "Документы"
        }
        .into(),
        path: state.vault_default.display().to_string(),
    }];
    let home = app.path().home_dir().ok();
    let mut cloud = |label: &str, base: Option<PathBuf>| {
        if let Some(b) = base.filter(|b| b.is_dir()) {
            let path = b.join(vault::FOLDER).display().to_string();
            if !out.iter().any(|p| p.path == path) {
                out.push(Place {
                    label: label.into(),
                    path,
                });
            }
        }
    };
    for name in ["YandexDisk", "Yandex.Disk", "Яндекс Диск"] {
        cloud("Яндекс Диск", home.as_ref().map(|h| h.join(name)));
    }
    cloud("OneDrive", std::env::var_os("OneDrive").map(PathBuf::from));
    cloud("OneDrive", home.as_ref().map(|h| h.join("OneDrive")));
    cloud("Google Диск", home.as_ref().map(|h| h.join("Google Drive")));
    out
}

#[tauri::command(async)]
pub fn vault_places(app: AppHandle, state: State<AppState>) -> Vec<Place> {
    places(&app, &state)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// Сменить папку: `None` — вернуть папку по умолчанию. Папка сразу обновляется.
#[tauri::command(async)]
pub fn set_vault_dir(state: State<AppState>, path: Option<String>) -> CmdResult<Status> {
    let chosen = path
        .filter(|p| !p.trim().is_empty())
        .map(|p| vault::normalize(Path::new(p.trim())));
    if let Some(dir) = &chosen {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("в эту папку нельзя записать ({e}); выберите другую"))?;
    }
    let value = chosen
        .filter(|d| !same_dir(d, &state.vault_default))
        .map(|d| d.display().to_string())
        .unwrap_or_default();
    {
        let guard = state.lock_db();
        let db = guard.as_ref().map_err(|e| e.clone())?;
        settings::set(db.conn(), "vault_dir", &value).map_err(|e| e.to_string())?;
        settings::set(db.conn(), "vault_on", "1").map_err(|e| e.to_string())?;
    }
    sync(&state, false);
    status_of(&state)
}

/// Где искать данные с другого компьютера: показанные папки или все известные места.
#[tauri::command(async)]
pub fn vault_scan(app: AppHandle, state: State<AppState>, dirs: Option<Vec<String>>) -> Vec<Found> {
    let dirs: Vec<PathBuf> = match dirs {
        Some(d) => d.into_iter().map(PathBuf::from).collect(),
        None => {
            let mut d: Vec<PathBuf> = status_of(&state)
                .map(|s| vec![PathBuf::from(s.dir)])
                .unwrap_or_default();
            d.extend(
                places(&app, &state)
                    .into_iter()
                    .map(|p| PathBuf::from(p.path)),
            );
            d
        }
    };
    vault::scan(&dirs)
}

#[tauri::command(async)]
pub fn vault_inspect(path: String) -> CmdResult<Found> {
    vault::inspect_file(Path::new(&path)).map_err(|e| e.to_string())
}

/// Перенести данные из найденной копии или «Всех данных». Текущие данные
/// сохраняются страховочной копией; дальше папка сохранности — та, откуда
/// перенесли (облако остаётся облаком). Возвращает путь к страховке.
#[tauri::command(async)]
pub fn vault_transfer(state: State<AppState>, found: Found) -> CmdResult<String> {
    let opts = state.open_options();
    let safety = {
        let mut guard = state.lock_db();
        let db = guard.as_mut().map_err(|e| e.clone())?;
        let path = Path::new(&found.path);
        let safety = if found.kind == "excel" {
            vault::restore_excel(db, path, &opts)
        } else {
            db.restore_from(path, &opts)
        }
        .map_err(|e| e.to_string())?;
        let c = db.conn();
        // Папка со старого компьютера могла остаться в настройках копии.
        let restored = settings::get(c, "vault_dir")
            .ok()
            .flatten()
            .unwrap_or_default();
        let folder = found.folder.map(PathBuf::from).or_else(|| {
            Some(PathBuf::from(&restored)).filter(|p| !restored.is_empty() && p.is_dir())
        });
        let value = folder
            .filter(|f| !same_dir(f, &state.vault_default))
            .map(|f| f.display().to_string())
            .unwrap_or_default();
        let set = |k: &str, v: &str| settings::set(c, k, v).map_err(|e| e.to_string());
        set("vault_dir", &value)?;
        set("vault_error", "")?;
        set("onboarding_done", "1")?;
        safety.display().to_string()
    };
    // Данные заменены целиком: прежние шаги отмены к ним не относятся.
    state.lock_undo().clear();
    sync(&state, false);
    Ok(safety)
}

/// Открыть папку в Проводнике.
#[tauri::command(async)]
pub fn open_folder(path: String) -> CmdResult<()> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("папки пока нет: она появится после первого сохранения".into());
    }
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(p)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("не удалось открыть папку: {e}"))
}
