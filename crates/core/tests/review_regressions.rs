//! Regressions from the full review. Use only disposable databases.
use budget_core::{
    currencies,
    storage::{OpenOptions, Storage, MIGRATIONS},
};

#[test]
fn restore_rejects_orphan_without_replacing_live_data() {
    let dir = tempfile::tempdir().unwrap();
    let opts = OpenOptions {
        backup_dir: dir.path().join("backups"),
        keep_backups: 3,
    };
    let path = dir.path().join("orphan.db");
    {
        let source = Storage::open(&path, &opts).unwrap();
        source.conn().execute_batch("PRAGMA foreign_keys=OFF; INSERT INTO accounts (id,name,type,currency_code,opening_date,created_at,updated_at) VALUES ('orphan','Orphan','cash','MISSING','2026-01-01','','');").unwrap();
        let integrity: String = source.conn().query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
    }
    let mut live = Storage::open_in_memory().unwrap();
    live.conn().execute("INSERT OR REPLACE INTO settings(key,value) VALUES ('review_marker','keep')", []).unwrap();
    assert!(live.restore_from(&path, &opts).is_err());
    let marker: String = live.conn().query_row("SELECT value FROM settings WHERE key='review_marker'", [], |r| r.get(0)).unwrap();
    assert_eq!(marker, "keep");
    let orphans: i64 = live.conn().query_row("SELECT count(*) FROM accounts WHERE id='orphan'", [], |r| r.get(0)).unwrap();
    assert_eq!(orphans, 0);
}

#[test]
fn currency_overflow_is_rejected_instead_of_wrapping() {
    let db = Storage::open_in_memory().unwrap();
    currencies::set_rate(db.conn(), "2026-01-01", "USD", "RUB", "100000000000").unwrap();
    assert!(currencies::convert(db.conn(), 1_000_000_000, "USD", "RUB", "2026-01-01").is_err());
}

#[test]
fn legacy_budget_merge_keeps_income_at_original_period_end() {
    let dir = tempfile::tempdir().unwrap();
    let opts = OpenOptions {
        backup_dir: dir.path().join("backups"),
        keep_backups: 3,
    };
    let path = dir.path().join("legacy.db");
    {
        let old = Storage::open_with(&path, &opts, &MIGRATIONS[..23]).unwrap();
        old.conn()
            .execute_batch(
                "INSERT OR REPLACE INTO settings(key,value) VALUES ('month_start_day','31');
                 INSERT INTO budgets(id,period_start,currency_code,created_at,updated_at)
                 VALUES ('march','2026-02-28','RUB','','');
                 INSERT INTO categories(id,name,kind,created_at,updated_at) VALUES
                 ('source','Source','expense','',''),
                 ('target','Target','expense','',''),
                 ('salary','Salary','income','','');
                 INSERT INTO accounts(id,name,type,currency_code,opening_date,created_at,updated_at)
                 VALUES ('cash','Cash','cash','RUB','2026-01-01','','');
                 INSERT INTO transactions(id,type,date,account_id,amount,category_id,created_at,updated_at)
                 VALUES ('salary-row','income','2026-03-29','cash',100000,'salary','','');
                 INSERT INTO budget_lines(id,budget_id,category_id,limit_amount,limit_kind,limit_value)
                 VALUES ('a','march','source',0,'percent',1000),
                        ('b','march','target',0,'percent',2000);
                 UPDATE settings SET value='28' WHERE key='month_start_day';",
            )
            .unwrap();
    }
    let mut upgraded = Storage::open(&path, &opts).unwrap();
    // Return to the original month before merging: March includes March 29.
    budget_core::settings::set(upgraded.conn(), "month_start_day", "31").unwrap();
    budget_core::categories::merge(upgraded.conn_mut(), "source", "target").unwrap();
    let merged: i64 = upgraded
        .conn()
        .query_row(
            "SELECT limit_amount FROM budget_lines
             WHERE budget_id='march' AND category_id='target'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // 10% + 20% of 100000, independently calculated from the original period.
    assert_eq!(merged, 30000);
}