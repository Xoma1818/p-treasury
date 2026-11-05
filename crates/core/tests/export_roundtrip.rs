//! Перенос через выгрузку (проверка треда 31): все операции примера данных
//! выгружены в CSV и Excel и загружены в новый бюджет с теми же счетами.
//! Доходы, расходы и расходы по категориям должны совпасть; своя выгрузка,
//! загруженная обратно, ничего не меняет (ошибка Ф10: выдача долга в файле
//! отклоняла весь файл).

use std::path::Path;

use budget_core::storage::{OpenOptions, Storage};
use budget_core::transactions::Filter;
use budget_core::{csv_import, export, reports};

const AS_OF: &str = "2026-10-20";

fn opts(dir: &Path) -> OpenOptions {
    OpenOptions {
        backup_dir: dir.join("backups"),
        keep_backups: 3,
    }
}

fn snapshot(db: &Storage) -> String {
    let c = db.conn();
    let s = reports::period_summary(c, "2000-01-01", "2100-01-01").unwrap();
    let cats = reports::by_category(c, "expense", "2000-01-01", "2100-01-01").unwrap();
    let bal = reports::balances_on(c, AS_OF).unwrap();
    format!(
        "доход {} расход {} корр {}\nкатегории {}\nостатки {}",
        s.income,
        s.expense,
        s.adjustments,
        serde_json::to_string(&cats).unwrap(),
        serde_json::to_string(&bal).unwrap()
    )
}

/// Новый бюджет: те же счета и категории, операций нет.
fn empty_twin(dir: &Path, name: &str) -> Storage {
    let mut db = Storage::open(&dir.join(name), &opts(dir)).unwrap();
    budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
    db.conn()
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             DELETE FROM transactions; DELETE FROM debt_payments;
             PRAGMA foreign_keys = ON;",
        )
        .unwrap();
    db
}

fn roundtrip(ext: &str) {
    let tmp = tempfile::tempdir().unwrap();
    let mut src = Storage::open(&tmp.path().join("src.db"), &opts(tmp.path())).unwrap();
    budget_core::demo::seed(src.conn_mut(), AS_OF).unwrap();
    let sheet = export::transactions_sheet(src.conn(), &Filter::default()).unwrap();
    let file = tmp.path().join(format!("Операции.{ext}"));
    if ext == "csv" {
        export::write_one(&file, &sheet).unwrap();
    } else {
        export::write_xlsx(&file, std::slice::from_ref(&sheet)).unwrap();
    }
    let mut dst = empty_twin(tmp.path(), "dst.db");
    let p = csv_import::preview(dst.conn(), &file, None).unwrap();
    // Выдачу и платежи по долгу файл не вносит (график долга ведётся в «Долгах»),
    // всё остальное загружается без ошибок.
    let bad: Vec<_> = p
        .rows
        .iter()
        .filter(|r| r.error.as_deref().is_some_and(|e| !e.contains("по долгу")))
        .collect();
    assert!(bad.is_empty(), "{ext}: строки с ошибками: {bad:#?}");
    csv_import::import(dst.conn_mut(), &file, true, None).unwrap();
    assert_eq!(totals(&dst), totals(&src), "{ext}: цифры после переноса");
    // Повторная загрузка той же выгрузки ничего не удваивает.
    csv_import::import(dst.conn_mut(), &file, true, None).unwrap();
    assert_eq!(
        totals(&dst),
        totals(&src),
        "{ext}: после повторной загрузки"
    );
}

/// Доходы, расходы и расходы по категориям (переводы в них не входят).
/// Идентификаторы категорий в разных бюджетах свои, сравниваются названия.
fn totals(db: &Storage) -> String {
    let head = snapshot(db).split("\nостатки").next().unwrap().to_string();
    let mut out = String::new();
    for (i, part) in head.split("\"categoryId\":\"").enumerate() {
        out.push_str(if i == 0 {
            part
        } else {
            part.split_once('"').unwrap().1
        });
    }
    out
}

#[test]
fn demo_moves_through_csv_with_same_numbers() {
    roundtrip("csv");
}

#[test]
fn demo_moves_through_excel_with_same_numbers() {
    roundtrip("xlsx");
}

#[test]
fn own_export_loads_back_into_same_budget_without_changes() {
    for ext in ["csv", "xlsx"] {
        let tmp = tempfile::tempdir().unwrap();
        let mut db = Storage::open(&tmp.path().join("b.db"), &opts(tmp.path())).unwrap();
        budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
        let before = snapshot(&db);
        let sheet = export::transactions_sheet(db.conn(), &Filter::default()).unwrap();
        let file = tmp.path().join(format!("Операции.{ext}"));
        if ext == "csv" {
            export::write_one(&file, &sheet).unwrap();
        } else {
            export::write_xlsx(&file, std::slice::from_ref(&sheet)).unwrap();
        }
        let p = csv_import::preview(db.conn(), &file, None).unwrap();
        // Каждая строка узнаётся как уже записанная, в том числе выдача долга.
        assert_eq!(p.duplicates, p.rows.len(), "{ext}: {:#?}", p.rows);
        let saved = csv_import::import(db.conn_mut(), &file, false, None).unwrap();
        assert_eq!(saved.added, 0, "{ext}");
        assert_eq!(snapshot(&db), before, "{ext}");
    }
}

/// OFX: по каждому счёту начальный остаток + все строки выписки = остаток в выписке.
#[test]
fn ofx_lines_add_up_to_ledger_balance() {
    let tmp = tempfile::tempdir().unwrap();
    let mut db = Storage::open(&tmp.path().join("b.db"), &opts(tmp.path())).unwrap();
    budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
    let text = budget_core::ofx::transactions_ofx(db.conn(), &Filter::default(), AS_OF).unwrap();
    let num = |s: &str| -> i64 {
        let v: f64 = s.parse().unwrap();
        (v * 100.0).round() as i64
    };
    let mut checked = 0;
    for stmt in text.split("<STMTRS>").skip(1) {
        let acct = stmt
            .split("<ACCTID>")
            .nth(1)
            .unwrap()
            .split('<')
            .next()
            .unwrap();
        let sum: i64 = stmt
            .split("<TRNAMT>")
            .skip(1)
            .map(|p| num(p.split('<').next().unwrap()))
            .sum();
        let bal = num(stmt
            .split("<BALAMT>")
            .nth(1)
            .unwrap()
            .split('<')
            .next()
            .unwrap());
        let opening: i64 = db
            .conn()
            .query_row(
                "SELECT opening_balance FROM accounts WHERE upper(replace(id, '-', '')) LIKE '%' || ?1",
                [acct],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| panic!("счёт {acct}"));
        assert_eq!(
            opening + sum,
            bal,
            "счёт {acct}: начальный {opening} + строки {sum} ≠ остаток {bal}"
        );
        checked += 1;
    }
    assert!(checked > 2);
}

/// Ревью 04.11 (P1): обычный счёт называется как должник («Иван»). Своя выгрузка,
/// загруженная обратно, не должна повторить выдачу долга переводом на этот счёт.
#[test]
fn own_export_with_account_named_like_debtor_adds_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let mut db = Storage::open(&tmp.path().join("b.db"), &opts(tmp.path())).unwrap();
    budget_core::demo::seed(db.conn_mut(), AS_OF).unwrap();
    db.conn()
        .execute(
            "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, created_at, updated_at)
             VALUES ('ivan-card', 'Иван', 'cash', 'RUB', 0, '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    let before = snapshot(&db);
    let sheet = export::transactions_sheet(db.conn(), &Filter::default()).unwrap();
    let file = tmp.path().join("Операции.csv");
    export::write_one(&file, &sheet).unwrap();
    let saved = csv_import::import(db.conn_mut(), &file, false, None).unwrap();
    assert_eq!(saved.added, 0);
    assert_eq!(snapshot(&db), before);
}
