//! Папка сохранности: одна видимая папка (по умолчанию `Документы\Kazna`),
//! которую программа сама обновляет при закрытии и раз в день.
//!
//! ```text
//! Kazna\
//!   Мой бюджет.ptreasury      полная копия базы: из неё переносят на другой ПК
//!   Копии\                    прошлые копии, хранятся последние N
//!   Excel\                    зеркало для просмотра без программы
//!     Операции.xlsx, Сводка 2026.xlsx
//!     Все данные.xlsx         все таблицы по листам: из него можно восстановить
//!   Прочти меня.txt
//! ```
//!
//! Рабочая база остаётся в папке данных приложения: в папке лежат только копии.
//! Файл `.ptreasury` — та же база SQLite, поэтому восстанавливается обычным
//! `Storage::restore_from`. «Все данные.xlsx» — запасной путь, если копии нет.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::Connection;
use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::storage::{OpenOptions, Storage, LATEST_VERSION};
use crate::{backups, export, settings, time, Error, Result};

/// Расширение копии в папке сохранности.
pub const EXT: &str = "ptreasury";
/// Имя основного файла бюджета в папке.
pub const MAIN_NAME: &str = "Мой бюджет";
/// Имя папки сохранности; выбранная пользователем папка получает её внутрь.
pub const FOLDER: &str = "Kazna";
/// Имя папки до 0.26 (программа называлась P-Treasury): её узнаём при поиске
/// данных, а папку по умолчанию переименовываем в [`FOLDER`] (см. [`migrate_default`]).
pub const LEGACY_FOLDER: &str = "P-Treasury";

fn is_vault_name(p: &Path) -> bool {
    matches!(
        p.file_name().and_then(|n| n.to_str()),
        Some(FOLDER | LEGACY_FOLDER)
    )
}

/// 0.26: «Документы\P-Treasury» → «Документы\Kazna». Только для папки по
/// умолчанию и только если новой ещё нет; выбранную пользователем папку
/// (настройка `vault_dir`) не трогаем. Возвращает `true`, если папка переименована.
pub fn migrate_default(conn: &Connection, default: &Path) -> Result<bool> {
    let chosen = settings::get(conn, "vault_dir")?.unwrap_or_default();
    if !chosen.trim().is_empty() {
        return Ok(false);
    }
    let Some(old) = default.parent().map(|p| p.join(LEGACY_FOLDER)) else {
        return Ok(false);
    };
    if default.file_name().and_then(|n| n.to_str()) != Some(FOLDER)
        || default.exists()
        || !old.is_dir()
    {
        return Ok(false);
    }
    fs::rename(&old, default)?;
    Ok(true)
}
pub const HISTORY: &str = "Копии";
pub const EXCEL: &str = "Excel";
pub const ALL_DATA: &str = "Все данные.xlsx";
pub const README: &str = "Прочти меня.txt";
/// Первый лист «Всех данных»: версия программы и схемы.
const INFO_SHEET: &str = "О файле";

/// Имя файла без символов, запрещённых в Windows.
pub fn safe_name(name: &str) -> String {
    let s: String = name
        .trim()
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let s = s.trim_matches(['.', ' ']).to_string();
    if s.is_empty() {
        MAIN_NAME.into()
    } else {
        s.chars().take(60).collect()
    }
}

/// Папка Excel-зеркала для бюджета: `Excel` для основного, `Excel (Дача)` для других.
pub fn excel_dir(dir: &Path, name: &str) -> PathBuf {
    if name == MAIN_NAME {
        dir.join(EXCEL)
    } else {
        dir.join(format!("{EXCEL} ({name})"))
    }
}

/// Папка, которую выбрал пользователь, или `default`. `None` — папка выключена.
pub fn dir(conn: &Connection, default: &Path) -> Result<Option<PathBuf>> {
    if settings::get(conn, "vault_on")?.as_deref() == Some("0") {
        return Ok(None);
    }
    let chosen = settings::get(conn, "vault_dir")?.unwrap_or_default();
    Ok(Some(if chosen.trim().is_empty() {
        default.to_path_buf()
    } else {
        PathBuf::from(chosen.trim())
    }))
}

/// Выбранная папка: если она называется не «Kazna» (или прежняя «P-Treasury»),
/// файлы ложатся в подпапку «Kazna», чтобы не смешаться с другими файлами на диске.
pub fn normalize(chosen: &Path) -> PathBuf {
    if is_vault_name(chosen) {
        chosen.to_path_buf()
    } else {
        chosen.join(FOLDER)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub on: bool,
    /// Папка, куда идут копии сейчас.
    pub dir: String,
    pub default_dir: String,
    /// Выбрана своя папка (облако, флешка), а не папка по умолчанию.
    pub custom: bool,
    pub synced_at: Option<String>,
    /// Что не удалось при последнем обновлении.
    pub error: Option<String>,
    pub keep: String,
    /// Последняя копия, которая прошла проверку восстановления.
    pub verified: Option<backups::Verified>,
    /// Ошибка последней проверки восстановления.
    pub verify_error: Option<String>,
}

pub fn status(conn: &Connection, default: &Path) -> Result<Status> {
    let (verified, verify_error) = backups::last_verified(conn)?;
    let get = |k: &str| -> Result<String> { Ok(settings::get(conn, k)?.unwrap_or_default()) };
    let chosen = get("vault_dir")?;
    let custom = !chosen.trim().is_empty();
    Ok(Status {
        on: get("vault_on")? != "0",
        dir: if custom {
            chosen.trim().to_string()
        } else {
            default.display().to_string()
        },
        default_dir: default.display().to_string(),
        custom,
        synced_at: Some(get("vault_synced_at")?).filter(|v| !v.is_empty()),
        error: Some(get("vault_error")?).filter(|v| !v.is_empty()),
        keep: Some(get("autobackup_keep")?)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "10".into()),
        verified,
        verify_error,
    })
}

/// Пора обновить папку: сегодня по местному времени её ещё не обновляли.
pub fn due(conn: &Connection, today: &str) -> Result<bool> {
    let at = settings::get(conn, "vault_synced_at")?.unwrap_or_default();
    Ok(local_date(&at).as_deref() != Some(today))
}

fn local_date(utc: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(utc).ok().map(|t| {
        t.with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string()
    })
}

fn count(conn: &Connection, sql: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub copy: String,
    /// Excel-файлы, которые не удалось обновить (например, открыты в Excel).
    pub excel_error: Option<String>,
}

/// Обновить папку: копия базы, копия в «Копии», Excel-зеркало, «Прочти меня».
/// Копия базы важнее всего: ошибка Excel не мешает ей и записывается в статус.
pub fn sync(conn: &Connection, dir: &Path, name: &str) -> Result<SyncReport> {
    let result = sync_copy(conn, dir, name).map(|copy| SyncReport {
        excel_error: sync_excel(&copy, dir, name).err().map(|e| e.to_string()),
        copy: copy.display().to_string(),
    });
    record(conn, &result)?;
    result
}

/// Записать итог обновления в статус папки (его видно в Настройках).
pub fn record(conn: &Connection, result: &Result<SyncReport>) -> Result<()> {
    let error = match result {
        Ok(r) => r.excel_error.clone().unwrap_or_default(),
        Err(e) => e.to_string(),
    };
    settings::set(conn, "vault_error", &error)?;
    if result.is_ok() {
        settings::set(conn, "vault_synced_at", &time::now_utc())?;
    }
    Ok(())
}

/// Первая часть обновления — копия базы, прошлые копии и «Прочти меня».
/// Возвращает путь к свежей копии `.ptreasury`.
pub fn sync_copy(conn: &Connection, dir: &Path, name: &str) -> Result<PathBuf> {
    let name = safe_name(name);
    let main = dir.join(format!("{name}.{EXT}"));
    // Новый компьютер, где ещё ничего не ввели: не затираем копию с данными
    // со старого компьютера, а предлагаем её перенести.
    if main.exists() && count(conn, "SELECT COUNT(*) FROM transactions")? == 0 {
        if let Ok(info) = backups::inspect(&main) {
            if info.transactions > 0 {
                return invalid(format!(
                    "в папке сохранности лежат данные с другого компьютера ({} операций). Перенесите их: Настройки → Сохранность данных → Перенести данные",
                    info.transactions
                ));
            }
        }
    }
    fs::create_dir_all(dir).map_err(|e| {
        Error::Validation(format!(
            "папка сохранности недоступна ({}): {e}. Проверьте флешку или облачный диск",
            dir.display()
        ))
    })?;
    backups::backup(conn, &main)?;

    let history = dir.join(HISTORY);
    fs::create_dir_all(&history)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let old = history.join(format!("{name} - {stamp}.{EXT}"));
    let part = history.join(format!("{name} - {stamp}.{EXT}.part"));
    fs::copy(&main, &part)?;
    fs::rename(&part, &old)?;
    let keep: usize = settings::get(conn, "autobackup_keep")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(10)
        .max(1);
    prune_history(&history, &name, keep)?;
    fs::write(dir.join(README), readme())?;
    Ok(main)
}

/// Вторая часть — Excel-зеркало. Строится по свежей копии, а не по рабочей
/// базе: на большой базе это секунды, и программа в это время не ждёт.
pub fn sync_excel(copy: &Path, dir: &Path, name: &str) -> Result<()> {
    let conn = Connection::open_with_flags(copy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    write_excel(&conn, &excel_dir(dir, &safe_name(name)))
}

/// Копии бюджета `name` в «Копии»: оставить `keep` самых новых.
/// Имя `<бюджет> - ГГГГ-ММ-ДД чч-мм-сс.ptreasury`, порядок по имени = по времени.
fn prune_history(history: &Path, name: &str, keep: usize) -> Result<()> {
    let prefix = format!("{name} - ");
    let mut files: Vec<PathBuf> = fs::read_dir(history)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.strip_prefix(&prefix)
                    .and_then(|rest| rest.strip_suffix(&format!(".{EXT}")))
                    .is_some_and(|stamp| {
                        chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H-%M-%S").is_ok()
                    })
            })
        })
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(keep);
    for old in &files[..excess] {
        fs::remove_file(old)?;
    }
    Ok(())
}

fn readme() -> String {
    format!(
        "Папка сохранности Kazna\r\n\
         ============================\r\n\r\n\
         Программа сама обновляет эту папку при закрытии и раз в день.\r\n\r\n\
         *.{EXT}       полная копия всех данных. Из неё переносят данные на другой компьютер.\r\n\
         {HISTORY}\\          прошлые копии (хранятся последние, сколько выбрано в Настройках).\r\n\
         {EXCEL}\\            те же данные в Excel для просмотра. «{ALL_DATA}» — запасной путь:\r\n\
         \x20                 из него программа восстановит данные, если копии нет.\r\n\r\n\
         Как перенести на другой компьютер\r\n\
         ---------------------------------\r\n\
         1. Скопируйте эту папку целиком в «Документы» нового компьютера\r\n\
         \x20  (или просто войдите в облачный диск, если папка лежит в нём).\r\n\
         2. Установите Kazna и запустите.\r\n\
         3. На первом экране нажмите «Перенести данные»: программа найдёт папку сама\r\n\
         \x20  или попросит её показать.\r\n\r\n\
         Excel-файлы можно открывать и смотреть. Правки в них программа не подхватывает:\r\n\
         при следующем обновлении папки они перезапишутся.\r\n"
    )
}

// --- Excel-зеркало ---

fn write_excel(conn: &Connection, dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    let mut failed = Vec::new();
    let mut attempt = |file: &str, r: Result<()>| {
        if r.is_err() {
            failed.push(file.to_string());
        }
    };
    attempt(
        "Операции.xlsx",
        export::transactions_sheet(conn, &Default::default())
            .and_then(|s| export::write_xlsx(&dir.join("Операции.xlsx"), &[s])),
    );
    let today = time::today_local();
    let summary = format!("Сводка {}.xlsx", &today[..4]);
    attempt(
        &summary,
        export::summary_workbook(conn, &format!("{}-01-01", &today[..4]), &today, &today)
            .and_then(|s| export::write_xlsx(&dir.join(&summary), &s)),
    );
    attempt(ALL_DATA, write_all_data(conn, &dir.join(ALL_DATA)));
    if failed.is_empty() {
        Ok(())
    } else {
        invalid(format!(
            "не обновлены файлы Excel: {} (возможно, они открыты в Excel; обновятся в следующий раз)",
            failed.join(", ")
        ))
    }
}

/// Таблицы с данными пользователя: без служебных SQLite и поискового индекса заметок.
fn data_tables(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let virtual_tables: Vec<&String> = rows
        .iter()
        .filter(|(_, sql)| {
            sql.trim_start()
                .to_uppercase()
                .starts_with("CREATE VIRTUAL")
        })
        .map(|(n, _)| n)
        .collect();
    Ok(rows
        .iter()
        .filter(|(n, _)| !virtual_tables.iter().any(|v| n.starts_with(v.as_str())))
        .map(|(n, _)| n.clone())
        .collect())
}

struct Column {
    name: String,
    integer: bool,
    not_null: bool,
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<Column>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let cols = stmt
        .query_map([], |r| {
            Ok(Column {
                name: r.get(1)?,
                integer: r.get::<_, String>(2)?.to_uppercase().contains("INT"),
                not_null: r.get::<_, i64>(3)? != 0,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(cols)
}

fn xlsx_err(e: rust_xlsxwriter::XlsxError) -> Error {
    Error::Validation(format!("не удалось записать файл Excel: {e}"))
}

/// «Все данные.xlsx»: лист «О файле» и по листу на таблицу, в первой строке
/// имена столбцов. Текст пишется текстом, числа числами, пустое — пустой ячейкой.
pub fn write_all_data(conn: &Connection, path: &Path) -> Result<()> {
    let mut wb = Workbook::new();
    let bold = Format::new().set_bold();
    let info = wb.add_worksheet();
    info.set_name(INFO_SHEET).map_err(xlsx_err)?;
    let about = [
        ("Программа", format!("Kazna {}", env!("CARGO_PKG_VERSION"))),
        ("Версия данных", crate::storage::schema_version(conn)?.to_string()),
        ("Сохранено", time::now_utc()),
        (
            "Как пользоваться",
            "Все данные по листам, для просмотра. Из этого файла Kazna восстанавливает данные, если копии .ptreasury нет. Не меняйте названия листов и первую строку.".into(),
        ),
    ];
    for (r, (k, v)) in about.iter().enumerate() {
        info.write_string_with_format(r as u32, 0, *k, &bold)
            .map_err(xlsx_err)?;
        info.write_string(r as u32, 1, v).map_err(xlsx_err)?;
    }
    info.set_column_width(0, 20).map_err(xlsx_err)?;
    info.set_column_width(1, 90).map_err(xlsx_err)?;

    for table in data_tables(conn)? {
        let cols = columns(conn, &table)?;
        let ws = wb.add_worksheet();
        ws.set_name(&table).map_err(xlsx_err)?;
        for (c, col) in cols.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, &col.name, &bold)
                .map_err(xlsx_err)?;
        }
        ws.set_freeze_panes(1, 0).map_err(xlsx_err)?;
        let list = cols
            .iter()
            .map(|c| format!("\"{}\"", c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn.prepare(&format!("SELECT {list} FROM \"{table}\" ORDER BY rowid"))?;
        let mut rows = stmt.query([])?;
        let mut r = 1u32;
        while let Some(row) = rows.next()? {
            for c in 0..cols.len() {
                let col = c as u16;
                match row.get::<_, Value>(c)? {
                    Value::Null => {}
                    Value::Integer(n) => {
                        ws.write_number(r, col, n as f64).map_err(xlsx_err)?;
                    }
                    Value::Real(f) => {
                        ws.write_number(r, col, f).map_err(xlsx_err)?;
                    }
                    Value::Text(s) => {
                        ws.write_string(r, col, &s).map_err(xlsx_err)?;
                    }
                    Value::Blob(_) => {}
                }
            }
            r += 1;
        }
        ws.autofit();
    }
    let tmp = path.with_extension("xlsx.part");
    wb.save(&tmp).map_err(xlsx_err)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

type Rows = Vec<Vec<calamine::Data>>;

fn read_book(path: &Path) -> Result<BTreeMap<String, Rows>> {
    use calamine::{open_workbook_auto, Reader};
    let not_ours = || Error::Validation("это не файл «Все данные» Kazna".into());
    let mut book = open_workbook_auto(path).map_err(|_| not_ours())?;
    let mut sheets = BTreeMap::new();
    for name in book.sheet_names() {
        let range = book.worksheet_range(&name).map_err(|_| not_ours())?;
        sheets.insert(name, range.rows().map(|r| r.to_vec()).collect());
    }
    if !sheets.contains_key(INFO_SHEET) || !sheets.contains_key("transactions") {
        return Err(not_ours());
    }
    Ok(sheets)
}

fn cell_text(d: &calamine::Data) -> Option<String> {
    use calamine::Data;
    match d {
        Data::Empty | Data::Error(_) => None,
        Data::String(s) => Some(s.clone()),
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 9e15 => Some(format!("{}", *f as i64)),
        Data::Float(f) => Some(f.to_string()),
        Data::Int(i) => Some(i.to_string()),
        Data::Bool(b) => Some(if *b { "1" } else { "0" }.into()),
        // Дату, которую Excel сам превратил в дату при правке, возвращаем строкой ГГГГ-ММ-ДД.
        Data::DateTime(dt) => {
            let (y, m, d, ..) = dt.to_ymd_hms_milli();
            Some(format!("{y:04}-{m:02}-{d:02}"))
        }
        Data::DateTimeIso(s) | Data::DurationIso(s) => Some(s.clone()),
    }
}

fn header(rows: &Rows) -> Vec<String> {
    rows.first()
        .map(|r| r.iter().map(|c| cell_text(c).unwrap_or_default()).collect())
        .unwrap_or_default()
}

/// Что лежит в «Всех данных»: как у копии, чтобы показать перед переносом.
pub fn inspect_excel(path: &Path) -> Result<backups::BackupInfo> {
    let book = read_book(path)?;
    let version = book[INFO_SHEET]
        .iter()
        .find(|r| r.first().and_then(cell_text).as_deref() == Some("Версия данных"))
        .and_then(|r| r.get(1).and_then(cell_text))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if version > LATEST_VERSION {
        return invalid(format!("файл сделан более новой версией приложения (схема {version}); сначала обновите приложение"));
    }
    let column = |sheet: &str, name: &str| -> Vec<String> {
        let Some(rows) = book.get(sheet) else {
            return Vec::new();
        };
        let Some(i) = header(rows).iter().position(|h| h == name) else {
            return Vec::new();
        };
        rows.iter()
            .skip(1)
            .map(|r| r.get(i).and_then(cell_text).unwrap_or_default())
            .collect()
    };
    Ok(backups::BackupInfo {
        path: path.display().to_string(),
        schema_version: version,
        accounts: column("accounts", "type")
            .iter()
            .filter(|t| *t != "debt")
            .count() as i64,
        transactions: book["transactions"].len().saturating_sub(1) as i64,
        last_date: column("transactions", "date")
            .into_iter()
            .filter(|d| !d.is_empty())
            .max(),
    })
}

/// Загрузить «Все данные» в чистую базу: таблицы из файла заменяют
/// одноимённые; настройки и валюты дополняются (в новой версии могли
/// появиться новые настройки). Столбцы сопоставляются по имени.
pub fn import_all_data(conn: &mut Connection, path: &Path) -> Result<usize> {
    let book = read_book(path)?;
    let tables = data_tables(conn)?;
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let result = (|| -> Result<usize> {
        let tx = conn.transaction()?;
        let mut total = 0;
        for table in &tables {
            let Some(rows) = book.get(table) else {
                continue;
            };
            let cols = columns(&tx, table)?;
            let head = header(rows);
            let map: Vec<(usize, &Column)> = head
                .iter()
                .enumerate()
                .filter_map(|(i, h)| cols.iter().find(|c| &c.name == h).map(|c| (i, c)))
                .collect();
            if map.is_empty() {
                continue;
            }
            let merge = matches!(table.as_str(), "settings" | "currencies");
            if !merge {
                tx.execute(&format!("DELETE FROM \"{table}\""), [])?;
            }
            let sql = format!(
                "INSERT OR REPLACE INTO \"{table}\" ({}) VALUES ({})",
                map.iter()
                    .map(|(_, c)| format!("\"{}\"", c.name))
                    .collect::<Vec<_>>()
                    .join(", "),
                vec!["?"; map.len()].join(", ")
            );
            let mut stmt = tx.prepare(&sql)?;
            for (n, row) in rows.iter().enumerate().skip(1) {
                if row.iter().all(|c| cell_text(c).is_none()) {
                    continue;
                }
                let values: Vec<Value> = map
                    .iter()
                    .map(|(i, col)| match row.get(*i).and_then(cell_text) {
                        None if col.not_null && !col.integer => Value::Text(String::new()),
                        None => Value::Null,
                        Some(s) if col.integer => s
                            .trim()
                            .parse::<i64>()
                            .map(Value::Integer)
                            .unwrap_or(Value::Text(s)),
                        Some(s) => Value::Text(s),
                    })
                    .collect();
                stmt.execute(rusqlite::params_from_iter(values))
                    .map_err(|e| {
                        Error::Validation(format!("лист «{table}», строка {}: {e}", n + 1))
                    })?;
                total += 1;
            }
        }
        let broken: Option<String> = tx
            .query_row(
                "SELECT \"table\" FROM pragma_foreign_key_check LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok();
        if let Some(t) = broken {
            return invalid(format!(
                "в листе «{t}» есть ссылки на строки, которых нет в файле; восстановите из копии .{EXT} или исправьте файл"
            ));
        }
        tx.commit()?;
        Ok(total)
    })();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    result
}

/// Восстановить открытую базу из «Всех данных»: файл собирается во временную
/// базу, а та заменяет текущие данные как обычная копия (со страховкой).
pub fn restore_excel(db: &mut Storage, path: &Path, opts: &OpenOptions) -> Result<PathBuf> {
    fs::create_dir_all(&opts.backup_dir)?;
    let tmp = opts
        .backup_dir
        .join(format!("from-excel-{}.db", time::file_stamp()));
    let cleanup = |p: &Path| {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut n = p.as_os_str().to_owned();
            n.push(suffix);
            let _ = fs::remove_file(PathBuf::from(n));
        }
    };
    cleanup(&tmp);
    let result = (|| {
        {
            let mut t = Storage::open(&tmp, opts)?;
            import_all_data(t.conn_mut(), path)?;
        }
        db.restore_from(&tmp, opts)
    })();
    cleanup(&tmp);
    result
}

// --- Поиск данных для переноса ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub path: String,
    pub name: String,
    /// `copy` — файл `.ptreasury` или `.db`; `excel` — «Все данные.xlsx».
    pub kind: String,
    pub accounts: i64,
    pub transactions: i64,
    pub last_date: Option<String>,
    /// Когда файл сохранён (местное время, `ГГГГ-ММ-ДД чч:мм`).
    pub saved_at: Option<String>,
    /// Папка сохранности, в которой лежит файл: после переноса копии пойдут туда же.
    pub folder: Option<String>,
}

fn saved_at(path: &Path) -> Option<String> {
    let t = fs::metadata(path).ok()?.modified().ok()?;
    Some(
        chrono::DateTime::<chrono::Local>::from(t)
            .format("%Y-%m-%d %H:%M")
            .to_string(),
    )
}

/// Описать файл, который показал пользователь: копию или «Все данные».
pub fn inspect_file(path: &Path) -> Result<Found> {
    let is_xlsx = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("xlsx"));
    let info = if is_xlsx {
        inspect_excel(path)?
    } else {
        backups::inspect(path)?
    };
    let parent = path.parent();
    let (name, folder) = if is_xlsx {
        let excel = parent
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let name = excel
            .strip_prefix(&format!("{EXCEL} ("))
            .and_then(|r| r.strip_suffix(')'))
            .unwrap_or(MAIN_NAME)
            .to_string();
        (name, parent.and_then(Path::parent))
    } else {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(MAIN_NAME);
        (stem.to_string(), parent)
    };
    let in_vault = |f: &Path| f.join(README).exists() || is_vault_name(f);
    Ok(Found {
        path: path.display().to_string(),
        name,
        kind: if is_xlsx { "excel" } else { "copy" }.into(),
        accounts: info.accounts,
        transactions: info.transactions,
        last_date: info.last_date,
        saved_at: saved_at(path),
        folder: folder
            .filter(|f| in_vault(f))
            .map(|f| f.display().to_string()),
    })
}

/// Найти данные в папках: копии `.ptreasury`, а если копии бюджета нет —
/// «Все данные.xlsx» из его Excel-папки. Папка может быть самой папкой
/// сохранности, её Excel-папкой или папкой, внутри которой лежит «Kazna»
/// (или «P-Treasury» с компьютера, где стоит версия до 0.26).
pub fn scan(dirs: &[PathBuf]) -> Vec<Found> {
    let mut found: Vec<Found> = Vec::new();
    let mut seen = Vec::new();
    for d in dirs {
        let candidates = [d.clone(), d.join(FOLDER), d.join(LEGACY_FOLDER)];
        for dir in candidates {
            let Ok(canon) = fs::canonicalize(&dir) else {
                continue;
            };
            if seen.contains(&canon) || !canon.is_dir() {
                continue;
            }
            seen.push(canon);
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            let mut entries: Vec<PathBuf> =
                entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            entries.sort();
            for p in entries
                .iter()
                .filter(|p| p.extension().is_some_and(|e| e == EXT))
            {
                if let Ok(f) = inspect_file(p) {
                    found.push(f);
                }
            }
            let mut excel: Vec<PathBuf> = entries
                .iter()
                .filter(|p| {
                    p.is_dir()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with(EXCEL))
                })
                .map(|p| p.join(ALL_DATA))
                .collect();
            excel.push(dir.join(ALL_DATA));
            for x in excel.iter().filter(|x| x.exists()) {
                if let Ok(f) = inspect_file(x) {
                    if !found
                        .iter()
                        .any(|c| c.kind == "copy" && c.name == f.name && c.folder == f.folder)
                    {
                        found.push(f);
                    }
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, AccountInput};
    use crate::transactions::{self, TxnInput};

    fn opts(dir: &Path) -> OpenOptions {
        OpenOptions {
            backup_dir: dir.join("backups"),
            keep_backups: 10,
        }
    }

    fn sample(c: &Connection) {
        crate::categories::seed_defaults(c).unwrap();
        settings::set(c, "onboarding_done", "1").unwrap();
        let card = accounts::create(
            c,
            &AccountInput {
                name: "Карта".into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 1_000_000,
                opening_date: "2026-10-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap();
        let cat: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Продукты'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for (date, amount, payee) in [
            ("2026-10-02", 234_050, "Пятёрочка"),
            ("2026-10-05", 1_10, "1.10"),
            ("2026-10-07", 99_999, "=СУММ(A1)"),
        ] {
            transactions::create(
                c,
                &TxnInput {
                    kind: "expense".into(),
                    date: date.into(),
                    account_id: card.clone(),
                    amount,
                    category_id: Some(cat.clone()),
                    to_account_id: None,
                    to_amount: None,
                    payee: Some(payee.into()),
                    note: None,
                },
            )
            .unwrap();
        }
        crate::notes::create(
            c,
            &crate::notes::NoteInput {
                body: "Купить подарок маме".into(),
                date: Some("2026-10-05".into()),
                transaction_id: None,
                account_id: None,
                debt_id: None,
                budget_id: None,
            },
        )
        .unwrap();
    }

    fn dump(c: &Connection) -> Vec<String> {
        let mut out = Vec::new();
        for t in data_tables(c).unwrap() {
            if t == "settings" {
                continue;
            }
            let mut stmt = c
                .prepare(&format!("SELECT * FROM \"{t}\" ORDER BY 1"))
                .unwrap();
            let n = stmt.column_count();
            let rows = stmt
                .query_map([], |r| {
                    (0..n)
                        .map(|i| r.get::<_, Value>(i).map(|v| format!("{v:?}")))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap();
            for r in rows {
                out.push(format!("{t}: {}", r.unwrap().join(" | ")));
            }
        }
        out
    }

    #[test]
    fn sync_writes_copy_history_excel_and_readme() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("Документы/Kazna");
        let db = Storage::open_in_memory().unwrap();
        sample(db.conn());
        settings::set(db.conn(), "autobackup_keep", "2").unwrap();
        let r = sync(db.conn(), &vault, MAIN_NAME).unwrap();
        assert_eq!(r.excel_error, None);
        let main = vault.join("Мой бюджет.ptreasury");
        assert_eq!(backups::inspect(&main).unwrap().transactions, 3);
        for f in ["Операции.xlsx", ALL_DATA] {
            assert!(vault.join(EXCEL).join(f).exists(), "{f}");
        }
        assert!(vault.join(README).exists());
        let st = status(db.conn(), &vault).unwrap();
        assert!(st.on && !st.custom && st.synced_at.is_some() && st.error.is_none());
        assert!(!due(db.conn(), &time::today_local()).unwrap());

        // В «Копиях» хранится не больше выбранного числа.
        let history = vault.join(HISTORY);
        for i in 1..=3 {
            fs::write(
                history.join(format!("Мой бюджет - 2026-01-0{i} 10-00-00.ptreasury")),
                b"",
            )
            .unwrap();
        }
        fs::write(history.join("Дача - 2026-01-01 10-00-00.ptreasury"), b"").unwrap();
        sync(db.conn(), &vault, MAIN_NAME).unwrap();
        let mut names: Vec<String> = fs::read_dir(&history)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names.len(), 3, "{names:?}");
        assert_eq!(
            names[0], "Дача - 2026-01-01 10-00-00.ptreasury",
            "чужие копии не трогаем"
        );
        assert!(names[1..].iter().all(|n| n.starts_with("Мой бюджет - ")));
        assert!(
            !names
                .iter()
                .any(|n| n.contains("2026-01-01 10") && n.starts_with("Мой")),
            "старые копии удалены: {names:?}"
        );
        assert!(
            names.iter().any(|n| !n.contains("2026-01-0")),
            "свежая копия на месте"
        );
    }

    #[test]
    fn excel_restores_everything_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let db = Storage::open_in_memory().unwrap();
        sample(db.conn());
        let xlsx = dir.path().join(ALL_DATA);
        write_all_data(db.conn(), &xlsx).unwrap();
        let info = inspect_excel(&xlsx).unwrap();
        assert_eq!((info.accounts, info.transactions), (1, 3));
        assert_eq!(info.last_date.as_deref(), Some("2026-10-07"));

        let new_dir = dir.path().join("new");
        let mut new = Storage::open(&new_dir.join("budget.db"), &opts(&new_dir)).unwrap();
        let safety = restore_excel(&mut new, &xlsx, &opts(&new_dir)).unwrap();
        assert!(safety.exists());
        assert_eq!(dump(new.conn()), dump(db.conn()));
        assert_eq!(
            settings::get(new.conn(), "onboarding_done")
                .unwrap()
                .as_deref(),
            Some("1")
        );
        // Поиск по заметкам работает: индекс заполнен заново.
        let n: i64 = new
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'подарок'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let had: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, had);
        // Временная база убрана.
        assert!(!fs::read_dir(new_dir.join("backups")).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("from-excel")));
    }

    #[test]
    fn broken_excel_is_rejected_and_data_stays() {
        let dir = tempfile::tempdir().unwrap();
        let src = Storage::open_in_memory().unwrap();
        sample(src.conn());
        // Счёт удалили из файла руками: операции ссылаются в никуда.
        src.conn()
            .execute_batch("PRAGMA foreign_keys = OFF; DELETE FROM accounts;")
            .unwrap();
        let xlsx = dir.path().join(ALL_DATA);
        write_all_data(src.conn(), &xlsx).unwrap();
        let mut db = Storage::open(&dir.path().join("budget.db"), &opts(dir.path())).unwrap();
        sample(db.conn());
        let err = restore_excel(&mut db, &xlsx, &opts(dir.path())).unwrap_err();
        assert!(err.to_string().contains("ссылки"), "{err}");
        assert_eq!(
            dump(db.conn())
                .iter()
                .filter(|r| r.starts_with("transactions:"))
                .count(),
            3
        );
        let junk = dir.path().join("junk.xlsx");
        export::write_xlsx(&junk, &[]).ok();
        fs::write(&junk, b"not excel").unwrap();
        assert!(inspect_excel(&junk).is_err());
    }

    #[test]
    fn new_computer_does_not_overwrite_data_from_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join(FOLDER);
        let old = Storage::open_in_memory().unwrap();
        sample(old.conn());
        sync(old.conn(), &vault, MAIN_NAME).unwrap();
        let fresh = Storage::open_in_memory().unwrap();
        let err = sync(fresh.conn(), &vault, MAIN_NAME).unwrap_err();
        assert!(err.to_string().contains("другого компьютера"), "{err}");
        assert!(status(fresh.conn(), &vault).unwrap().error.is_some());
        assert_eq!(
            backups::inspect(&vault.join("Мой бюджет.ptreasury"))
                .unwrap()
                .transactions,
            3
        );
    }

    #[test]
    fn scan_finds_copies_and_excel_only_budgets() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = dir.path().join("YandexDisk");
        let vault = cloud.join(FOLDER);
        let db = Storage::open_in_memory().unwrap();
        sample(db.conn());
        sync(db.conn(), &vault, MAIN_NAME).unwrap();
        sync(db.conn(), &vault, "Дача").unwrap();
        // У «Дачи» осталось только Excel-зеркало.
        fs::remove_file(vault.join("Дача.ptreasury")).unwrap();
        // Ищем по папке облака: «Kazna» внутри находится сама.
        let found = scan(&[cloud.clone(), vault.clone()]);
        let kinds: Vec<(String, String)> = found
            .iter()
            .map(|f| (f.name.clone(), f.kind.clone()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("Мой бюджет".to_string(), "copy".to_string()),
                ("Дача".to_string(), "excel".to_string())
            ]
        );
        assert!(found
            .iter()
            .all(|f| f.folder.as_deref() == Some(vault.to_str().unwrap())));
        assert_eq!(found[0].transactions, 3);
        assert!(scan(&[dir.path().join("нет такой")]).is_empty());
    }

    #[test]
    fn names_and_folders() {
        assert_eq!(safe_name(" Дача: 2026/27 "), "Дача- 2026-27");
        assert_eq!(safe_name(" .. "), MAIN_NAME);
        assert_eq!(
            normalize(Path::new("/m/YandexDisk")),
            Path::new("/m/YandexDisk/Kazna")
        );
        assert_eq!(normalize(Path::new("/m/Kazna")), Path::new("/m/Kazna"));
        assert_eq!(
            excel_dir(Path::new("/v"), "Дача"),
            Path::new("/v/Excel (Дача)")
        );
        let db = Storage::open_in_memory().unwrap();
        let def = Path::new("/home/Документы/Kazna");
        assert_eq!(dir(db.conn(), def).unwrap().as_deref(), Some(def));
        settings::set(db.conn(), "vault_dir", "/flash/Kazna").unwrap();
        assert_eq!(
            dir(db.conn(), def).unwrap().unwrap(),
            Path::new("/flash/Kazna")
        );
        settings::set(db.conn(), "vault_on", "0").unwrap();
        assert_eq!(dir(db.conn(), def).unwrap(), None);
    }

    #[test]
    fn old_autobackup_folder_becomes_vault_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.db");
        let six = &crate::storage::MIGRATIONS[..7];
        {
            let db = Storage::open_with(&path, &opts(dir.path()), six).unwrap();
            settings::set(db.conn(), "autobackup_dir", "D:/Яндекс.Диск/Копии").unwrap();
        }
        let db = Storage::open(&path, &opts(dir.path())).unwrap();
        let st = status(db.conn(), Path::new("/default")).unwrap();
        assert_eq!(
            (st.dir.as_str(), st.custom, st.on),
            ("D:/Яндекс.Диск/Копии", true, true)
        );
    }

    #[test]
    fn default_folder_moves_from_old_name_once() {
        let db = Storage::open_in_memory().unwrap();
        let docs = tempfile::tempdir().unwrap();
        let old = docs.path().join(LEGACY_FOLDER);
        fs::create_dir_all(old.join(HISTORY)).unwrap();
        fs::write(old.join("Мой бюджет.ptreasury"), b"x").unwrap();
        let new = docs.path().join(FOLDER);
        assert!(migrate_default(db.conn(), &new).unwrap());
        assert!(
            new.join("Мой бюджет.ptreasury").exists()
                && new.join(HISTORY).is_dir()
                && !old.exists()
        );
        // Второй раз и при уже существующей новой папке ничего не делаем.
        fs::create_dir_all(&old).unwrap();
        assert!(!migrate_default(db.conn(), &new).unwrap());
        assert!(old.exists());
    }

    #[test]
    fn chosen_folder_is_not_moved() {
        let db = Storage::open_in_memory().unwrap();
        let docs = tempfile::tempdir().unwrap();
        let old = docs.path().join(LEGACY_FOLDER);
        fs::create_dir_all(&old).unwrap();
        settings::set(db.conn(), "vault_dir", old.to_str().unwrap()).unwrap();
        assert!(!migrate_default(db.conn(), &docs.path().join(FOLDER)).unwrap());
        assert!(old.exists());
        // Старое имя узнаётся как папка сохранности: подпапка не добавляется.
        assert_eq!(normalize(&old), old);
    }
}
