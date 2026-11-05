//! Папка сохранности в неудобных условиях (проверка треда 31):
//! нет доступа к папке, кончилось место, несколько бюджетов в одной папке,
//! выключенное копирование.

use std::fs;
use std::path::{Path, PathBuf};

use budget_core::storage::{OpenOptions, Storage};
use budget_core::{backups, settings, vault};

const AS_OF: &str = "2026-10-20";

fn opts(dir: &Path) -> OpenOptions {
    OpenOptions {
        backup_dir: dir.join("backups"),
        keep_backups: 3,
    }
}

fn demo(dir: &Path, file: &str) -> Storage {
    let mut db = Storage::open(&dir.join(file), &opts(dir)).unwrap();
    budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
    db
}

fn count(db: &Storage) -> i64 {
    db.conn()
        .query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0))
        .unwrap()
}

fn history(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir.join(vault::HISTORY))
        .map(|r| {
            r.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[test]
fn unreachable_folder_gives_clear_error_and_keeps_data() {
    let tmp = tempfile::tempdir().unwrap();
    let db = demo(tmp.path(), "budget.db");
    let before = count(&db);
    // Флешку вынули, а на её букве теперь файл: создать папку нельзя.
    let blocker = tmp.path().join("E");
    fs::write(&blocker, b"").unwrap();
    let dir = blocker.join("Kazna");
    let err = vault::sync(db.conn(), &dir, vault::MAIN_NAME)
        .unwrap_err()
        .to_string();
    assert!(err.contains("папка сохранности недоступна"), "{err}");
    let saved = settings::get(db.conn(), "vault_error")
        .unwrap()
        .unwrap_or_default();
    assert!(
        saved.contains("недоступна"),
        "ошибку видно в Настройках: {saved}"
    );
    assert_eq!(count(&db), before, "рабочая база не тронута");
}

#[test]
fn two_budgets_share_the_folder_without_overwriting() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("Kazna");
    let main = demo(tmp.path(), "budget.db");
    let dacha = Storage::open(&tmp.path().join("dacha.db"), &opts(tmp.path())).unwrap();
    for _ in 0..12 {
        vault::sync(main.conn(), &dir, vault::MAIN_NAME).unwrap();
        vault::sync(dacha.conn(), &dir, "Дача").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1010));
    }
    let a = backups::inspect(&dir.join("Мой бюджет.ptreasury")).unwrap();
    let b = backups::inspect(&dir.join("Дача.ptreasury")).unwrap();
    assert_eq!((a.transactions, b.transactions), (count(&main), 0));
    let h = history(&dir);
    let n = |p: &str| h.iter().filter(|f| f.starts_with(p)).count();
    // По 10 прошлых копий у каждого: чистка одного бюджета не трогает другой.
    assert_eq!((n("Мой бюджет - "), n("Дача - ")), (10, 10), "{h:?}");
    assert!(dir.join("Excel").is_dir() && dir.join("Excel (Дача)").is_dir());
}

#[test]
fn off_switch_means_no_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let db = demo(tmp.path(), "budget.db");
    settings::set(db.conn(), "vault_on", "0").unwrap();
    assert!(vault::dir(db.conn(), &tmp.path().join("Kazna"))
        .unwrap()
        .is_none());
}

/// Кончилось место на диске с папкой сохранности. Нужна маленькая файловая
/// система: `mount -t tmpfs -o size=1500k tmpfs <папка>` и
/// `KAZNA_FULL_DIR=<папка> cargo test -p budget-core --test vault_edges -- --ignored`.
#[test]
#[ignore]
fn full_disk_keeps_last_good_copy_and_leaves_no_parts() {
    let Some(full) = std::env::var_os("KAZNA_FULL_DIR").map(PathBuf::from) else {
        return;
    };
    let dir = full.join("Kazna");
    let _ = fs::remove_dir_all(&dir);
    let tmp = tempfile::tempdir().unwrap();
    // Маленький бюджет помещается.
    let mut db = Storage::open(&tmp.path().join("budget.db"), &opts(tmp.path())).unwrap();
    db.conn()
        .execute(
            "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, created_at, updated_at)
             VALUES ('a', 'Наличные', 'cash', 'RUB', 100, '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    vault::sync_copy(db.conn(), &dir, vault::MAIN_NAME).unwrap();
    let good = backups::inspect(&dir.join("Мой бюджет.ptreasury")).unwrap();
    // Пример заметно больше места на диске.
    budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
    for _ in 0..3 {
        let err = vault::sync(db.conn(), &dir, vault::MAIN_NAME)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("кончилось место") && err.contains("прошлая копия цела"),
            "{err}"
        );
    }
    let still = backups::inspect(&dir.join("Мой бюджет.ptreasury")).unwrap();
    assert_eq!(still.accounts, good.accounts, "прошлая копия цела");
    let leftovers: Vec<String> = history(&dir)
        .into_iter()
        .chain(
            fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned()),
        )
        .filter(|n| n.ends_with(".part"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "недописанные файлы занимают место: {leftovers:?}"
    );
}
