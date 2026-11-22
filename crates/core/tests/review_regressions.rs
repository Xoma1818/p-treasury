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
        let integrity: String = source
            .conn()
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }
    let mut live = Storage::open_in_memory().unwrap();
    live.conn()
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES ('review_marker','keep')",
            [],
        )
        .unwrap();
    assert!(live.restore_from(&path, &opts).is_err());
    let marker: String = live
        .conn()
        .query_row(
            "SELECT value FROM settings WHERE key='review_marker'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(marker, "keep");
    let orphans: i64 = live
        .conn()
        .query_row("SELECT count(*) FROM accounts WHERE id='orphan'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(orphans, 0);
}

#[test]
fn currency_overflow_is_rejected_instead_of_wrapping() {
    let db = Storage::open_in_memory().unwrap();
    currencies::set_rate(db.conn(), "2026-01-01", "USD", "RUB", "100000000000").unwrap();
    assert!(currencies::convert(db.conn(), 1_000_000_000, "USD", "RUB", "2026-01-01").is_err());
}

#[test]
fn counted_expenses_find_spread_parts_and_return_the_original_once() {
    use budget_core::transactions::{list, Filter};

    let db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    c.execute_batch(
        "UPDATE settings SET value='25' WHERE key='month_start_day';
         INSERT INTO accounts(id,name,type,currency_code,opening_date,created_at,updated_at)
         VALUES ('cash','Cash','cash','RUB','2026-01-01','','');
         INSERT INTO categories(id,name,kind,created_at,updated_at)
         VALUES ('expense','Expense','expense','','');
         INSERT INTO transactions(id,type,date,account_id,amount,category_id,status,spread_months,created_at,updated_at)
         VALUES ('spread','expense','2026-01-27','cash',120000,'expense','cleared',2,'',''),
                ('pending','expense','2026-01-27','cash',60000,'expense','planned',2,'',''),
                ('plain','expense','2026-02-27','cash',10000,'expense','cleared',NULL,'','');",
    )
    .unwrap();

    let mut filter = Filter {
        date_from: Some("2026-02-25".into()),
        date_to: Some("2026-03-24".into()),
        types: vec!["expense".into()],
        ..Filter::default()
    };
    let raw = list(c, &filter).unwrap();
    assert_eq!(raw.total, 1);
    assert_eq!(raw.items[0].id, "plain");

    filter.counted = true;
    let counted = list(c, &filter).unwrap();
    assert_eq!(counted.total, 2);
    assert_eq!(counted.items.len(), 2);
    let spread = &counted.items[1];
    assert_eq!(spread.id, "spread");
    assert_eq!(spread.date, "2026-01-27");
    assert_eq!(spread.amount, 120000);

    filter.date_from = Some("2026-01-25".into());
    filter.limit = Some(1);
    filter.offset = Some(1);
    let second_page = list(c, &filter).unwrap();
    assert_eq!(second_page.total, 2);
    assert_eq!(second_page.items.len(), 1);
    assert_eq!(second_page.items[0].id, "spread");

    filter.date_from = Some("2026-02-01".into());
    filter.date_to = Some("2026-02-24".into());
    filter.offset = None;
    assert_eq!(list(c, &filter).unwrap().total, 0);
}

#[test]
fn budget_fact_drilldown_matches_its_currency_and_account_scope() {
    use budget_core::{budgets, transactions};

    let db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    c.execute_batch(
        r#"INSERT OR REPLACE INTO settings(key,value) VALUES
               ('month_start_day','15'),('budget_excluded_accounts','["excluded"]');
           INSERT INTO accounts(id,name,type,currency_code,opening_date,created_at,updated_at)
               VALUES ('card','Card','debit','RUB','2026-01-01','',''),
                      ('excluded','Outside','debit','RUB','2026-01-01','','');
           INSERT INTO categories(id,name,kind,created_at,updated_at) VALUES ('goods','Goods','expense','','');
           INSERT INTO events(id,name,start_date,end_date,created_at)
               VALUES ('trip','Trip','2026-11-01','2026-12-01','');
           INSERT INTO budgets(id,period_start,currency_code,created_at,updated_at)
               VALUES ('nov','2026-10-15','USD','','');
           INSERT INTO transactions(id,type,date,account_id,amount,category_id,status,event_id,spread_months,created_at,updated_at)
               VALUES ('purchase','expense','2026-10-15','card',100000,'goods','cleared',NULL,3,'',''),
                      ('outside','expense','2026-11-14','excluded',15000,'goods','cleared',NULL,NULL,'',''),
                      ('travel','expense','2026-11-14','card',20000,'goods','cleared','trip',NULL,'',''),
                      ('next','expense','2026-11-15','card',30000,'goods','cleared',NULL,NULL,'','');"#,
    )
    .unwrap();
    currencies::set_rate(c, "2026-10-15", "USD", "RUB", "100").unwrap();
    budgets::set_limit(c, "nov", "goods", Some(10000)).unwrap();
    let budget = budgets::get(c, "2026-11", "2026-11-01").unwrap();
    let mut filter = transactions::Filter {
        category_id: Some("goods".into()),
        types: vec!["expense".into()],
        counted: true,
        budget_month: Some("2026-11".into()),
        date_from: Some(budget.period.start),
        date_to: Some(budget.period.end),
        ..Default::default()
    };
    let page = transactions::list(c, &filter).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].id, "purchase");
    assert_eq!(page.items[0].amount, 100000);
    let share = page.items[0].counted_share.as_ref().unwrap();
    assert_eq!(share.amount, 33334);
    assert_eq!(share.budget_currency, "USD");
    assert_eq!(share.budget_amount, 333);
    assert!(!share.missing_rate);
    let sum = transactions::sum_filter(c, &filter).unwrap();
    assert_eq!(sum.base_currency, "USD");
    assert_eq!(sum.expense, 333);
    assert_eq!(sum.expense, budget.actual_expense);

    currencies::delete_rate(c, "2026-10-15", "USD", "RUB").unwrap();
    let page = transactions::list(c, &filter).unwrap();
    let share = page.items[0].counted_share.as_ref().unwrap();
    assert_eq!(share.amount, 33334);
    assert_eq!(share.budget_amount, 0);
    assert!(share.missing_rate);
    let sum = transactions::sum_filter(c, &filter).unwrap();
    assert_eq!(sum.expense, 0);
    assert_eq!(sum.missing_rates, vec!["RUB"]);

    // Та же категория в отчёте охватывает все счета и события.
    filter.budget_month = None;
    assert_eq!(transactions::list(c, &filter).unwrap().total, 3);
    assert_eq!(transactions::sum_filter(c, &filter).unwrap().expense, 68334);
}

#[test]
fn ambiguous_legacy_budget_merge_refuses_without_changing_finances() {
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
    for day in ["28", "1", "31"] {
        budget_core::settings::set(upgraded.conn(), "month_start_day", day).unwrap();
        assert!(budget_core::categories::merge(upgraded.conn_mut(), "source", "target").is_err());
        let preserved: (i64, i64, i64, i64) = upgraded
            .conn()
            .query_row(
                "SELECT (SELECT count(*) FROM categories WHERE id IN ('source','target')),
                        (SELECT sum(limit_value) FROM budget_lines WHERE budget_id='march'),
                        (SELECT sum(amount) FROM transactions),
                        (SELECT start_day FROM budgets WHERE id='march')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(preserved, (2, 3000, 100000, 28));
    }
}

#[test]
fn legacy_budget_merge_recovers_an_unambiguous_start_from_its_date() {
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
                "UPDATE settings SET value='25' WHERE key='month_start_day';
                 INSERT INTO budgets(id,period_start,currency_code,created_at,updated_at)
                 VALUES ('march','2026-02-25','RUB','','');
                 INSERT INTO categories(id,name,kind,created_at,updated_at) VALUES
                 ('source','Source','expense','',''), ('target','Target','expense','',''),
                 ('salary','Salary','income','','');
                 INSERT INTO accounts(id,name,type,currency_code,opening_date,created_at,updated_at)
                 VALUES ('cash','Cash','cash','RUB','2026-01-01','','');
                 INSERT INTO transactions(id,type,date,account_id,amount,category_id,created_at,updated_at)
                 VALUES ('before','income','2026-02-24','cash',1000000,'salary','',''),
                        ('first','income','2026-02-25','cash',20000,'salary','',''),
                        ('last','income','2026-03-24','cash',80000,'salary','',''),
                        ('after','income','2026-03-25','cash',1000000,'salary','','');
                 INSERT INTO budget_lines(id,budget_id,category_id,limit_amount,limit_kind,limit_value)
                 VALUES ('a','march','source',0,'percent',1000),
                        ('b','march','target',0,'percent',2000);
                 UPDATE settings SET value='1' WHERE key='month_start_day';",
            )
            .unwrap();
    }
    let mut upgraded = Storage::open(&path, &opts).unwrap();
    budget_core::categories::merge(upgraded.conn_mut(), "source", "target").unwrap();
    let saved: (i64, String, i64) = upgraded
        .conn()
        .query_row(
            "SELECT b.start_day, b.period_start, l.limit_amount
             FROM budgets b JOIN budget_lines l ON l.budget_id=b.id
             WHERE b.id='march' AND l.category_id='target'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(saved, (1, String::from("2026-02-25"), 30000));
}

#[test]
fn new_budget_keeps_its_known_period_when_merging_after_setting_change() {
    let mut db = Storage::open_in_memory().unwrap();
    budget_core::settings::set(db.conn(), "month_start_day", "31").unwrap();
    let id = budget_core::budgets::create(db.conn_mut(), "2026-03", false).unwrap();
    db.conn()
        .execute_batch(
            "INSERT INTO categories(id,name,kind,created_at,updated_at) VALUES
             ('source','Source','expense','',''), ('target','Target','expense','',''),
             ('salary','Salary','income','','');
             INSERT INTO accounts(id,name,type,currency_code,opening_date,created_at,updated_at)
             VALUES ('cash','Cash','cash','RUB','2026-01-01','','');
             INSERT INTO transactions(id,type,date,account_id,amount,category_id,created_at,updated_at)
             VALUES ('salary-row','income','2026-03-29','cash',100000,'salary','','');",
        )
        .unwrap();
    budget_core::budgets::set_limit_kind(db.conn(), &id, "source", "percent", 1000).unwrap();
    budget_core::budgets::set_limit_kind(db.conn(), &id, "target", "percent", 2000).unwrap();
    budget_core::settings::set(db.conn(), "month_start_day", "28").unwrap();
    budget_core::categories::merge(db.conn_mut(), "source", "target").unwrap();
    let saved: (i64, i64, i64) = db
        .conn()
        .query_row(
            "SELECT b.start_day, b.start_day_known, l.limit_amount
             FROM budgets b JOIN budget_lines l ON l.budget_id=b.id
             WHERE b.id=?1 AND l.category_id='target'",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(saved, (31, 1, 30000));
}
#[test]
fn checked_rates_keep_rounding_and_reject_both_overflow_directions() {
    use budget_core::money::Rate;
    let half = Rate::parse("0.5").unwrap();
    assert_eq!(half.convert(1, 0, 0).unwrap(), 1);
    assert_eq!(half.convert(-1, 0, 0).unwrap(), -1);
    assert_eq!(
        Rate::parse("1").unwrap().convert(i64::MAX, 0, 0).unwrap(),
        i64::MAX
    );
    assert!(Rate::parse("2").unwrap().convert(i64::MAX, 0, 0).is_err());
    assert!(half.convert_inverse(i64::MAX, 0, 0).is_err());
    assert!(half.convert(1, 0, 100).is_err());
    let zero = Rate::from_amounts(i64::MAX, 0, 1, 0).unwrap();
    assert!(zero.convert_inverse(1, 0, 0).is_err());
}
