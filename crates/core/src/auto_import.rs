//! Импорт из папки: приложение само забирает новые CSV по шаблону операций
//! (например, из «Загрузок»). Каждый файл разбирается один раз; операции,
//! которые уже есть (та же дата, счёт, тип, сумма и получатель), пропускаются.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::{csv_import, time, transactions, Result};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub name: String,
    pub added: usize,
    pub skipped: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub files: Vec<FileResult>,
    pub added: usize,
}

/// Первая строка похожа на шаблон операций: есть «Дата», «Тип», «Счёт», «Сумма».
fn looks_like_template(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    let first = text.lines().next().unwrap_or("").to_lowercase();
    ["дата", "тип", "счёт", "сумма"]
        .iter()
        .all(|h| first.contains(h))
}

fn exists(conn: &Connection, t: &transactions::TxnInput) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM transactions WHERE date = ?1 AND account_id = ?2 AND type = ?3
               AND abs(amount) = ?4 AND coalesce(payee, '') = coalesce(?5, '') LIMIT 1",
            params![t.date, t.account_id, t.kind, t.amount, t.payee],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Разобрать новые файлы папки `dir`. Файлы не по шаблону запоминаются и
/// больше не читаются, но в итог не попадают.
pub fn scan(conn: &mut Connection, dir: &Path) -> Result<ScanResult> {
    let mut out = ScanResult::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(out);
    };
    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("csv")))
        .collect();
    files.sort();
    for path in files {
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let size = meta.len() as i64;
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();
        let key = path.to_string_lossy().to_string();
        let seen: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM import_files WHERE path = ?1 AND size = ?2 AND modified = ?3",
                params![key, size, modified],
                |r| r.get(0),
            )
            .optional()?;
        if seen.is_some() {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut res = FileResult {
            name,
            ..Default::default()
        };
        let template = looks_like_template(&path);
        if template {
            match csv_import::parse(conn, &path) {
                Ok(parsed) => {
                    let tx = conn.transaction()?;
                    for p in parsed {
                        match p.input {
                            Some(input) if !exists(&tx, &input)? => {
                                transactions::create(&tx, &input)?;
                                res.added += 1;
                            }
                            _ => res.skipped += 1,
                        }
                    }
                    tx.commit()?;
                }
                Err(e) => res.error = Some(e.to_string()),
            }
        }
        conn.execute(
            "INSERT INTO import_files (path, size, modified, imported_at, added, skipped, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                key,
                size,
                modified,
                time::now_utc(),
                res.added as i64,
                res.skipped as i64,
                if template {
                    res.error.clone()
                } else {
                    Some("не шаблон".into())
                }
            ],
        )?;
        if template {
            out.added += res.added;
            out.files.push(res);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, AccountInput};
    use crate::storage::Storage;

    #[test]
    fn imports_new_template_files_once_and_skips_duplicates() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        c.execute(
            "INSERT INTO categories (id, name, kind, created_at, updated_at) VALUES ('food', 'Продукты', 'expense', '', '')",
            [],
        )
        .unwrap();
        accounts::create(
            c,
            &AccountInput {
                name: "Карта".into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 0,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap();
        let dir = std::env::temp_dir().join(format!("pt-auto-{}", crate::ids::new_id()));
        fs::create_dir_all(&dir).unwrap();
        let head = "Дата;Тип;Счёт;Сумма;Категория;Получатель\n";
        fs::write(dir.join("a.csv"), format!("{head}01.10.2026;Расход;Карта;100;Продукты;Магнит\n02.10.2026;Расход;Карта;50;Нет такой;X\n")).unwrap();
        fs::write(dir.join("other.csv"), "name,price\nчай,10\n").unwrap();
        fs::write(dir.join("notes.txt"), head).unwrap();

        let r = scan(c, &dir).unwrap();
        assert_eq!(r.added, 1);
        assert_eq!(r.files.len(), 1, "чужой CSV не показывается");
        assert_eq!((r.files[0].added, r.files[0].skipped), (1, 1));
        assert!(
            scan(c, &dir).unwrap().files.is_empty(),
            "второй раз файл не берётся"
        );

        // Та же операция в новом файле — дубль.
        fs::write(
            dir.join("b.csv"),
            format!("{head}01.10.2026;Расход;Карта;100;Продукты;Магнит\n"),
        )
        .unwrap();
        let r = scan(c, &dir).unwrap();
        assert_eq!((r.added, r.files[0].skipped), (0, 1));
        let n: i64 = c
            .query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
