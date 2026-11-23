//! Папка сохранности в неудобных условиях (проверка треда 31):
//! нет доступа к папке, кончилось место, несколько бюджетов в одной папке,
//! выключенное копирование.

use std::fs;
use std::path::{Path, PathBuf};

use budget_core::storage::{backup_to, OpenOptions, Storage};
use budget_core::{accounts, backups, settings, vault, Error};

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

/// KAZNA_FULL_DIR указывает на отдельный пустой тестовый том размером 16 МиБ.
/// На Linux: после `mount -t tmpfs -o size=16m tmpfs <папка>` пометьте том
/// командой `touch <папка>/.kazna-test-volume-16mib`.
#[test]
#[ignore = "требуется отдельный том 16 МиБ в KAZNA_FULL_DIR"]
fn full_disk_keeps_last_good_copy_and_leaves_no_parts() {
    let full = PathBuf::from(
        std::env::var_os("KAZNA_FULL_DIR").expect("укажите отдельный том 16 МиБ в KAZNA_FULL_DIR"),
    );
    assert!(full.is_absolute(), "KAZNA_FULL_DIR должен быть абсолютным");
    assert!(
        full.join(".kazna-test-volume-16mib").is_file(),
        "в KAZNA_FULL_DIR нет метки подготовленного тома .kazna-test-volume-16mib"
    );
    let scratch = tempfile::tempdir_in(full).unwrap();
    let dir = scratch.path().join("Kazna");
    let tmp = tempfile::tempdir().unwrap();
    let db = demo(tmp.path(), "budget.db");
    let card: String = db
        .conn()
        .query_row(
            "SELECT id FROM accounts WHERE name='Карта Сбер'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let balance = |s: &Storage| accounts::balance(s.conn(), &card, None).unwrap();
    let original_balance = balance(&db);
    let transactions = count(&db);
    let copy = vault::sync_copy(db.conn(), &dir, vault::MAIN_NAME).unwrap();
    let original = fs::read(&copy).unwrap();
    db.conn()
        .execute(
            "UPDATE accounts SET opening_balance=opening_balance+40000 WHERE id=?1",
            [&card],
        )
        .unwrap();
    let updated_balance = original_balance + 40_000;
    assert_eq!(balance(&db), updated_balance);

    // На томе уже лежат основная и историческая копии. Оставляем примерно
    // половину размера одной копии. На большом диске тест просто не получит ENOSPC.
    const VOLUME_BYTES: usize = 16 * 1024 * 1024;
    let reserve = scratch.path().join("reserve");
    let reservation = VOLUME_BYTES
        .checked_sub(original.len() * 2 + original.len() / 2)
        .expect("тестовая база слишком велика для тома 16 МиБ");
    fs::write(&reserve, vec![0x51; reservation]).unwrap();

    // Проверяем исходную причину до того, как папка сохранности пояснит её пользователю.
    let cause = backup_to(db.conn(), &copy)
        .expect_err("копия поместилась: укажите отдельный том 16 МиБ в KAZNA_FULL_DIR");
    let disk_full = match &cause {
        Error::Db(e) => e.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull),
        Error::Io(e) => {
            e.kind() == std::io::ErrorKind::StorageFull
                || (cfg!(windows) && matches!(e.raw_os_error(), Some(39 | 112)))
        }
        _ => false,
    };
    assert!(disk_full, "ожидалась нехватка места: {cause:?}");
    let msg = vault::sync(db.conn(), &dir, vault::MAIN_NAME)
        .unwrap_err()
        .to_string();
    assert!(
        msg.contains("кончилось место") && msg.contains("прошлая копия цела"),
        "{msg}"
    );
    assert_eq!(
        settings::get(db.conn(), "vault_error").unwrap().as_deref(),
        Some(msg.as_str())
    );
    assert!(
        fs::read(&copy).unwrap() == original,
        "предыдущая копия изменилась"
    );
    assert_eq!(backups::verify(&copy).unwrap().transactions, transactions);
    assert_eq!(
        balance(&Storage::rehearse_restore(&copy).unwrap()),
        original_balance
    );
    assert_eq!((count(&db), balance(&db)), (transactions, updated_balance));
    for entry in fs::read_dir(&dir)
        .unwrap()
        .chain(fs::read_dir(dir.join(vault::HISTORY)).unwrap())
    {
        let path = entry.unwrap().path();
        assert!(
            !path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".part"),
            "{}",
            path.display()
        );
    }

    fs::remove_file(reserve).unwrap();
    let retry = vault::sync(db.conn(), &dir, vault::MAIN_NAME).unwrap();
    assert_eq!(retry.excel_error, None);
    assert_eq!(
        settings::get(db.conn(), "vault_error").unwrap().as_deref(),
        Some("")
    );
    assert_eq!(backups::verify(&copy).unwrap().transactions, transactions);
    assert_eq!(
        balance(&Storage::rehearse_restore(&copy).unwrap()),
        updated_balance
    );
}
