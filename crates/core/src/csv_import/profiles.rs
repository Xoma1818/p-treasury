//! Локальные профили импорта обычных CSV. Шаблон Kazna и распознанные
//! банковские форматы по-прежнему разбираются своими обработчиками.

use super::{
    import_parsed, lookup, parse_date, preview_parsed, Extra, NewCategory, Parsed, Parsed3,
    Preview, Row,
};
use crate::{accounts, error::invalid, ids, import_log, money, rules, settings};
use crate::{transactions::TxnInput, Error, Result};
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

const SETTINGS_KEY: &str = "csv_import_profiles";
const MAX_PROFILES: usize = 32;
const MAX_COLUMNS: usize = 128;
const MAX_HEADER_CHARS: usize = 160;
const SAMPLE_ROWS: usize = 5;
pub(crate) const SOURCE_KEY_PREFIX: &str = "\u{1f}kazna:csv:v1:";
const SOURCE_SEPARATOR: char = '\u{1f}';

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvEncoding {
    Utf8,
    Windows1251,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Delimiter {
    Semicolon,
    Comma,
    Tab,
}

impl Delimiter {
    fn byte(self) -> u8 {
        match self {
            Self::Semicolon => b';',
            Self::Comma => b',',
            Self::Tab => b'\t',
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DateFormat {
    Standard,
    DayFirstSlash,
    MonthFirstSlash,
}

impl DateFormat {
    fn parse(self, value: &str) -> Option<String> {
        let format = match self {
            Self::Standard => return parse_date(value),
            Self::DayFirstSlash => "%d/%m/%Y",
            Self::MonthFirstSlash => "%m/%d/%Y",
        };
        if value.rsplit('/').next()?.len() != 4 {
            return None;
        }
        NaiveDate::parse_from_str(value, format)
            .ok()
            .map(|date| date.to_string())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AmountColumn {
    Signed { column: usize },
    DebitCredit { debit: usize, credit: usize },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMapping {
    /// Полный порядок заголовков. При изменении схемы индексам доверять нельзя.
    pub headers: Vec<String>,
    pub encoding: CsvEncoding,
    pub delimiter: Delimiter,
    pub date_format: DateFormat,
    pub date: usize,
    pub amount: AmountColumn,
    pub payee: Option<usize>,
    pub note: Option<usize>,
    pub currency: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportOptions {
    #[serde(flatten)]
    pub mapping: CsvMapping,
    /// Для каждой похожей строки: true — добавить отдельно, false — пропустить.
    #[serde(default)]
    pub decisions: BTreeMap<usize, bool>,
}

impl CsvMapping {
    fn validate(&self, headers: &[String]) -> Result<()> {
        if headers != self.headers {
            return invalid("заголовки CSV изменились. Сопоставьте столбцы заново");
        }
        let mut columns = vec![self.date];
        match self.amount {
            AmountColumn::Signed { column } => columns.push(column),
            AmountColumn::DebitCredit { debit, credit } => columns.extend([debit, credit]),
        }
        columns.extend(self.payee);
        columns.extend(self.note);
        columns.extend(self.currency);
        if columns.iter().any(|&index| index >= headers.len()) {
            return invalid("выбранного столбца нет в файле");
        }
        columns.sort_unstable();
        if columns.windows(2).any(|pair| pair[0] == pair[1]) {
            return invalid("выберите отдельный столбец для каждого поля");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvSample {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub encoding: CsvEncoding,
    pub delimiter: Delimiter,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProfile {
    pub id: String,
    pub name: String,
    pub account_id: String,
    pub mapping: CsvMapping,
}

fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("csv"))
    {
        return invalid("сопоставление столбцов доступно для файлов CSV");
    }
    Ok(fs::read(path)?)
}

fn decode(bytes: &[u8], requested: Option<CsvEncoding>) -> Result<(String, CsvEncoding)> {
    let with_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let input = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let encoding = requested.unwrap_or_else(|| {
        if with_bom || std::str::from_utf8(input).is_ok() {
            CsvEncoding::Utf8
        } else {
            CsvEncoding::Windows1251
        }
    });
    match encoding {
        CsvEncoding::Utf8 => Ok((
            std::str::from_utf8(input)
                .map_err(|_| Error::Validation("файл не в кодировке UTF-8".into()))?
                .to_string(),
            encoding,
        )),
        CsvEncoding::Windows1251 if with_bom => invalid("у файла есть метка UTF-8. Выберите UTF-8"),
        CsvEncoding::Windows1251 => {
            let (text, bad) = encoding_rs::WINDOWS_1251.decode_without_bom_handling(input);
            if bad {
                return invalid("не удалось прочитать файл в Windows-1251");
            }
            Ok((text.into_owned(), encoding))
        }
    }
}

fn reader(text: &str, delimiter: Delimiter) -> csv::Reader<&[u8]> {
    csv::ReaderBuilder::new()
        .delimiter(delimiter.byte())
        .flexible(true)
        .has_headers(false)
        .from_reader(text.as_bytes())
}

fn csv_error(error: csv::Error) -> Error {
    Error::Validation(format!("не удалось прочитать CSV: {error}"))
}

fn delimiter_guess(text: &str) -> Delimiter {
    // Считаются поля первой записи, а не запятые внутри кавычек.
    [Delimiter::Tab, Delimiter::Comma, Delimiter::Semicolon]
        .into_iter()
        .max_by_key(|&delimiter| {
            reader(text, delimiter)
                .records()
                .next()
                .and_then(std::result::Result::ok)
                .map_or(0, |row| row.len())
        })
        .unwrap_or(Delimiter::Semicolon)
}

fn read_header(rows: &mut csv::StringRecordsIter<'_, &[u8]>) -> Result<Vec<String>> {
    let Some(first) = rows.next().transpose().map_err(csv_error)? else {
        return invalid("файл CSV пуст");
    };
    if first.len() < 2 || first.len() > MAX_COLUMNS {
        return invalid("в первой строке CSV должно быть от 2 до 128 столбцов");
    }
    let headers: Vec<_> = first.iter().map(|s| s.trim().to_string()).collect();
    if headers
        .iter()
        .any(|s| s.chars().take(MAX_HEADER_CHARS + 1).count() > MAX_HEADER_CHARS)
    {
        return invalid("название столбца CSV превышает 160 символов");
    }
    Ok(headers)
}

pub fn inspect(
    path: &Path,
    delimiter: Option<Delimiter>,
    encoding: Option<CsvEncoding>,
) -> Result<CsvSample> {
    let (text, encoding) = decode(&read_bytes(path)?, encoding)?;
    let delimiter = delimiter.unwrap_or_else(|| delimiter_guess(&text));
    let mut reader = reader(&text, delimiter);
    let mut records = reader.records();
    let headers = read_header(&mut records)?;
    let mut rows = Vec::new();
    for row in records.take(SAMPLE_ROWS) {
        let row = row.map_err(csv_error)?;
        rows.push(
            (0..headers.len())
                .map(|i| row.get(i).unwrap_or("").chars().take(160).collect())
                .collect(),
        );
    }
    Ok(CsvSample {
        headers,
        rows,
        encoding,
        delimiter,
    })
}

fn import_account(conn: &Connection, id: &str) -> Result<accounts::Head> {
    let account = accounts::head(conn, id)?;
    if account.archived || account.kind == "debt" {
        return invalid("для импорта выберите открытый счёт, который не относится к займам");
    }
    Ok(account)
}

pub fn list(conn: &Connection) -> Result<Vec<CsvProfile>> {
    match settings::get(conn, SETTINGS_KEY)? {
        Some(value) => serde_json::from_str(&value)
            .map_err(|_| Error::Validation("не удалось прочитать профили CSV".into())),
        None => Ok(Vec::new()),
    }
}

fn store(conn: &Connection, profiles: &[CsvProfile]) -> Result<()> {
    let value = serde_json::to_string(profiles)
        .map_err(|_| Error::Validation("не удалось сохранить профили CSV".into()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SETTINGS_KEY, value],
    )?;
    Ok(())
}

pub fn save(
    conn: &Connection,
    path: &Path,
    id: Option<&str>,
    name: &str,
    account_id: &str,
    mapping: CsvMapping,
) -> Result<CsvProfile> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return invalid("название профиля должно содержать от 1 до 60 символов");
    }
    import_account(conn, account_id)?;
    let sample = inspect(path, Some(mapping.delimiter), Some(mapping.encoding))?;
    mapping.validate(&sample.headers)?;
    let mut profiles = list(conn)?;
    if profiles
        .iter()
        .any(|p| p.name.to_lowercase() == name.to_lowercase() && Some(p.id.as_str()) != id)
    {
        return invalid("профиль с таким названием уже есть");
    }
    let profile = CsvProfile {
        id: id.map(str::to_owned).unwrap_or_else(ids::new_id),
        name: name.into(),
        account_id: account_id.into(),
        mapping,
    };
    if let Some(id) = id {
        let previous = profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(Error::NotFound("профиль CSV"))?;
        *previous = profile.clone();
    } else {
        if profiles.len() >= MAX_PROFILES {
            return invalid("можно сохранить до 32 профилей CSV");
        }
        profiles.push(profile.clone());
    }
    store(conn, &profiles)?;
    Ok(profile)
}

pub fn remove(conn: &Connection, id: &str) -> Result<()> {
    let mut profiles = list(conn)?;
    let before = profiles.len();
    profiles.retain(|p| p.id != id);
    if profiles.len() != before {
        store(conn, &profiles)?;
    }
    Ok(())
}

fn read_amount(
    mapping: &AmountColumn,
    value: impl Fn(usize) -> String,
    minor: u32,
) -> std::result::Result<i64, String> {
    let parse = |text: String| {
        money::parse_amount(&text, minor).map_err(|_| format!("не распознана сумма «{text}»"))
    };
    let amount = match *mapping {
        AmountColumn::Signed { column } => parse(value(column))?,
        AmountColumn::DebitCredit { debit, credit } => {
            let or_zero = |text: String| if text.is_empty() { Ok(0) } else { parse(text) };
            let debit = or_zero(value(debit))?;
            let credit = or_zero(value(credit))?;
            if debit < 0 || credit < 0 || (debit > 0 && credit > 0) {
                return Err("нужна одна положительная сумма: списание или поступление".into());
            }
            credit - debit
        }
    };
    if amount == 0 {
        return Err("сумма равна нулю".into());
    }
    Ok(amount)
}

fn previous_source_rows(
    conn: &Connection,
    account_id: &str,
    prefix: &str,
) -> Result<HashSet<usize>> {
    // Ключ хранится там же, где оригинал банковской строки. Правка операции,
    // разбивка чека и ручное удаление не забывают его, а отмена импорта убирает.
    let mut statement = conn.prepare_cached(
        "SELECT bank_payee FROM import_keys
         WHERE account_id = ?1 AND substr(bank_payee, 1, length(?2)) = ?2
         UNION ALL
         SELECT bank_payee FROM import_deleted
         WHERE account_id = ?1 AND substr(bank_payee, 1, length(?2)) = ?2",
    )?;
    let keys = statement.query_map(params![account_id, prefix], |row| row.get::<_, String>(0))?;
    let mut lines = HashSet::new();
    for key in keys {
        if let Some(line) = key?
            .strip_prefix(prefix)
            .and_then(|tail| tail.split(SOURCE_SEPARATOR).next())
            .and_then(|line| line.parse().ok())
        {
            lines.insert(line);
        }
    }
    Ok(lines)
}

fn similar_transactions(conn: &Connection, input: &TxnInput) -> Result<Vec<String>> {
    let mut statement = conn.prepare_cached(
        "SELECT min(id) FROM transactions
         WHERE account_id = ?1 AND date = ?2 AND type = ?3 AND status = 'cleared'
         GROUP BY coalesce(split_id, id)
         HAVING sum(amount) = ?4
            AND (?5 IS NULL OR max(nullif(payee, '') IS NULL OR payee = ?5) = 1)
            AND (?6 IS NULL OR max(nullif(note, '') IS NULL OR note = ?6) = 1)
         ORDER BY min(id)
         LIMIT 4",
    )?;
    let ids = statement.query_map(
        params![
            input.account_id,
            input.date,
            input.kind,
            input.amount,
            input.payee,
            input.note
        ],
        |row| row.get(0),
    )?;
    Ok(ids.collect::<rusqlite::Result<_>>()?)
}

type PossibleMatches = BTreeMap<usize, Vec<String>>;

fn parse(
    conn: &Connection,
    path: &Path,
    account_id: &str,
    mapping: &CsvMapping,
) -> Result<(Parsed3, PossibleMatches)> {
    let account = import_account(conn, account_id)?;
    let bytes = read_bytes(path)?;
    // Две одинаковые покупки в одном файле различаются номером строки.
    // Даже у двух файлов с одинаковыми строками могут быть разные источники.
    let mut source = Sha256::new();
    source.update(&bytes);
    source.update([0]);
    if let Some(name) = path.file_name() {
        source.update(name.to_string_lossy().as_bytes());
    }
    let prefix = format!("{SOURCE_KEY_PREFIX}{:x}:", source.finalize());
    let known = previous_source_rows(conn, account_id, &prefix)?;
    let (text, _) = decode(&bytes, Some(mapping.encoding))?;
    let mut reader = reader(&text, mapping.delimiter);
    let mut records = reader.records();
    let headers = read_header(&mut records)?;
    mapping.validate(&headers)?;
    let lookup = lookup(conn)?;
    let mut parsed = Vec::new();
    let mut extra = Extra::default();
    let mut matches = BTreeMap::new();
    for (index, record) in records.enumerate() {
        let record = record.map_err(csv_error)?;
        if record.iter().all(|value| value.trim().is_empty()) {
            continue;
        }
        let value = |i| record.get(i).unwrap_or("").trim().to_string();
        let payee = mapping.payee.map(value).filter(|s| !s.is_empty());
        let note = mapping.note.map(value).filter(|s| !s.is_empty());
        let date = value(mapping.date);
        let mut row = Row {
            line: record
                .position()
                .and_then(|position| usize::try_from(position.line()).ok())
                .unwrap_or(index + 2),
            date: date.clone(),
            kind: String::new(),
            account: account.name.clone(),
            amount: String::new(),
            category: String::new(),
            category_source: None,
            payee: payee.clone().unwrap_or_default(),
            source_note: note.clone(),
            error: None,
            duplicate: false,
            linked_to: None,
            maybe: 0,
            to_transfer: false,
        };
        let fields = if record.len() != headers.len() {
            Err("число столбцов отличается от заголовка".into())
        } else if let Some(code) = mapping
            .currency
            .map(value)
            .filter(|code| !code.eq_ignore_ascii_case(&account.currency_code))
        {
            Err(format!(
                "валюта строки «{code}» не совпадает с валютой счёта {}",
                account.currency_code
            ))
        } else {
            read_amount(&mapping.amount, value, account.minor_units).and_then(|amount| {
                mapping
                    .date_format
                    .parse(&date)
                    .map(|date| (date, amount))
                    .ok_or_else(|| format!("дата «{date}» не соответствует формату профиля"))
            })
        };
        let input = match fields {
            Ok((date, amount)) => {
                let (kind, label, fallback) = if amount < 0 {
                    ("expense", "Расход", "Прочие расходы")
                } else {
                    ("income", "Доход", "Прочие доходы")
                };
                row.date = date.clone();
                row.kind = label.into();
                row.amount = money::format_amount(amount, account.minor_units, false);
                // Получатель остаётся в операции. Правило подсказывает категорию.
                let rule = rules::find(conn, payee.as_deref().unwrap_or(""), kind)?;
                row.category_source = Some(if rule.is_some() {
                    "По правилу"
                } else {
                    "Категория по умолчанию"
                });
                let category_id = rule.map(|r| r.category_id).or_else(|| {
                    lookup
                        .categories
                        .get(&(kind.to_string(), fallback.to_lowercase()))
                        .cloned()
                        .flatten()
                });
                let input = TxnInput {
                    kind: kind.into(),
                    date,
                    account_id: account_id.into(),
                    amount: amount.abs(),
                    category_id,
                    to_account_id: None,
                    to_amount: None,
                    payee: payee.clone(),
                    note,
                };
                if let Some(id) = &input.category_id {
                    row.category = lookup
                        .names
                        .iter()
                        .find(|(_, category_id, _)| category_id == id)
                        .map_or_else(|| fallback.into(), |(_, _, name)| name.clone());
                } else {
                    row.category = format!("{fallback} (новая)");
                }
                if known.contains(&row.line) {
                    row.duplicate = true;
                    None
                } else {
                    let possible = similar_transactions(conn, &input)?;
                    if !possible.is_empty() {
                        row.maybe = possible.len();
                        matches.insert(row.line, possible);
                    }
                    if input.category_id.is_none() {
                        extra
                            .categories
                            .push((parsed.len(), NewCategory::top(kind, fallback)));
                    }
                    Some(input)
                }
            }
            Err(error) => {
                row.error = Some(error);
                None
            }
        };
        // Сохраняем имя из исходника для повторной загрузки обычной выписки
        // того же банка. Оно не зависит от дальнейшей правки получателя.
        let source_key = format!(
            "{prefix}{}{SOURCE_SEPARATOR}{}",
            row.line,
            payee.as_deref().unwrap_or("")
        );
        parsed.push(Parsed {
            row,
            input,
            raw_payee: Some(source_key),
            convert: None,
        });
    }
    if parsed.is_empty() {
        return invalid("в файле нет строк с операциями");
    }
    Ok(((parsed, extra, None), matches))
}

pub fn preview(
    conn: &Connection,
    path: &Path,
    account_id: &str,
    mapping: &CsvMapping,
) -> Result<Preview> {
    let (parsed, matches) = parse(conn, path, account_id, mapping)?;
    let mut preview = preview_parsed(conn, parsed, None, None)?;
    preview.doubtful = matches.len();
    for (line, ids) in matches {
        let examples = ids
            .iter()
            .map(|id| import_log::side(conn, id))
            .collect::<Result<_>>()?;
        preview.matches.insert(line, examples);
    }
    preview.account_id = Some(account_id.into());
    Ok(preview)
}

pub fn import(
    conn: &mut Connection,
    path: &Path,
    skip_errors: bool,
    account_id: &str,
    options: &CsvImportOptions,
) -> Result<import_log::Saved> {
    let (mut parsed, matches) = parse(conn, path, account_id, &options.mapping)?;
    for row in &mut parsed.0 {
        if row.input.is_none() {
            continue;
        }
        match options.decisions.get(&row.row.line) {
            Some(true) => {}
            Some(false) => {
                row.input = None;
                row.row.duplicate = true;
            }
            None if matches.contains_key(&row.row.line) => {
                return invalid(format!(
                    "строка {} похожа на запись в Kazna: выберите «Добавить отдельно» или «Пропустить»",
                    row.row.line
                ));
            }
            None => {}
        }
    }
    parsed
        .1
        .categories
        .retain(|(i, _)| parsed.0[*i].input.is_some());
    import_parsed(conn, path, skip_errors, parsed, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts::tests::input, categories, storage::Storage, undo::Journal};

    fn setup() -> (Storage, String) {
        let db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let account = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        (db, account)
    }

    fn options(mapping: &CsvMapping) -> CsvImportOptions {
        CsvImportOptions {
            mapping: mapping.clone(),
            decisions: BTreeMap::new(),
        }
    }

    #[test]
    fn mapped_csv_uses_undo_and_preserves_two_equal_purchases() {
        let (mut db, account) = setup();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("operations.csv");
        fs::write(
            &path,
            "date,amount,\"merchant, label\",note,currency\n\
             05/10/2026,\"-65,00\",Метро,поездка,RUB\n\
             05/10/2026,\"-65,00\",Метро,поездка,RUB\n\
             05/10/2026,1200,Доход,перевод от клиента,RUB\n\
             05/10/2026,999,Доход,другая валюта,EUR\n",
        )
        .unwrap();
        let sample = inspect(&path, None, None).unwrap();
        assert_eq!(sample.headers[2], "merchant, label");
        assert_eq!(sample.rows.len(), 4);
        let mapping = CsvMapping {
            headers: sample.headers,
            encoding: sample.encoding,
            delimiter: sample.delimiter,
            date_format: DateFormat::DayFirstSlash,
            date: 0,
            amount: AmountColumn::Signed { column: 1 },
            payee: Some(2),
            note: Some(3),
            currency: Some(4),
        };
        let first = preview(db.conn(), &path, &account, &mapping).unwrap();
        assert_eq!((first.valid, first.errors, first.duplicates), (3, 1, 0));
        assert_eq!(first.rows[0].date, "2026-10-05");
        assert_eq!(first.rows[0].kind, "Расход");
        assert!(import(db.conn_mut(), &path, false, &account, &options(&mapping)).is_err());
        assert_eq!(accounts::balance(db.conn(), &account, None).unwrap(), 0);

        let mut journal = Journal::default();
        let saved = journal
            .record(db.conn_mut(), "Импорт", |conn| {
                import(conn, &path, true, &account, &options(&mapping))
            })
            .unwrap();
        assert_eq!(saved.added, 3);
        assert_eq!(
            accounts::balance(db.conn(), &account, None).unwrap(),
            107_000
        );
        let repeated = preview(db.conn(), &path, &account, &mapping).unwrap();
        assert_eq!(
            (repeated.valid, repeated.errors, repeated.duplicates),
            (0, 1, 3)
        );
        journal.undo(db.conn_mut()).unwrap();
        assert_eq!(accounts::balance(db.conn(), &account, None).unwrap(), 0);
    }

    #[test]
    fn saved_profile_requires_explicit_mapping_when_headers_move() {
        let (mut db, account) = setup();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("statement.csv");
        let (text, _, _) = encoding_rs::WINDOWS_1251.encode(
            "Дата;Списание;Пополнение;Получатель\n05.10.2026;10,50;;Магазин\n06.10.2026;;150;Работа\n07.10.2026;4;6;Ошибка\n",
        );
        fs::write(&path, text).unwrap();
        let sample = inspect(&path, None, None).unwrap();
        assert_eq!(sample.rows[0][3], "Магазин");
        let mapping = CsvMapping {
            headers: sample.headers,
            encoding: sample.encoding,
            delimiter: sample.delimiter,
            date_format: DateFormat::Standard,
            date: 0,
            amount: AmountColumn::DebitCredit {
                debit: 1,
                credit: 2,
            },
            payee: Some(3),
            note: None,
            currency: None,
        };
        let profile = save(db.conn(), &path, None, "Мой банк", &account, mapping).unwrap();
        let profiles = list(db.conn()).unwrap();
        assert_eq!(profiles[0].id, profile.id);
        let mapping = &profiles[0].mapping;
        let reviewed = preview(db.conn(), &path, &account, mapping).unwrap();
        assert_eq!((reviewed.valid, reviewed.errors), (2, 1));
        assert_eq!(reviewed.rows[0].kind, "Расход");
        assert_eq!(reviewed.rows[1].kind, "Доход");
        let (text, _, _) = encoding_rs::WINDOWS_1251
            .encode("Дата;Пополнение;Списание;Получатель\n05.10.2026;10,50;;Магазин\n");
        fs::write(&path, text).unwrap();
        assert!(preview(db.conn(), &path, &account, mapping).is_err());
        assert!(import(db.conn_mut(), &path, true, &account, &options(mapping)).is_err());
        assert_eq!(accounts::balance(db.conn(), &account, None).unwrap(), 0);
        remove(db.conn(), &profile.id).unwrap();
        assert!(list(db.conn()).unwrap().is_empty());
    }

    #[test]
    fn same_amount_from_another_file_needs_note_or_explicit_decision() {
        let (mut db, account) = setup();
        let temp = tempfile::tempdir().unwrap();
        let airport = temp.path().join("airport.csv");
        let home = temp.path().join("home.csv");
        let overlap = temp.path().join("overlap.csv");
        fs::write(
            &airport,
            "Дата;Сумма;Заметка\n05.10.2026;-500;Такси аэропорт\n",
        )
        .unwrap();
        fs::write(&home, "Дата;Сумма;Заметка\n05.10.2026;-500;Такси домой\n").unwrap();
        // Такое же содержимое в другом документе не доказывает, что покупка одна.
        fs::copy(&airport, &overlap).unwrap();
        let sample = inspect(&airport, None, None).unwrap();
        let mapping = CsvMapping {
            headers: sample.headers,
            encoding: sample.encoding,
            delimiter: sample.delimiter,
            date_format: DateFormat::Standard,
            date: 0,
            amount: AmountColumn::Signed { column: 1 },
            payee: None,
            note: Some(2),
            currency: None,
        };
        let mut options = options(&mapping);
        let first = import(db.conn_mut(), &airport, false, &account, &options).unwrap();
        assert_eq!(first.added, 1);
        let distinct = preview(db.conn(), &home, &account, &mapping).unwrap();
        assert_eq!(
            (distinct.valid, distinct.doubtful, distinct.duplicates),
            (1, 0, 0)
        );
        let second = import(db.conn_mut(), &home, false, &account, &options).unwrap();
        assert_eq!(second.added, 1);
        assert_eq!(
            accounts::balance(db.conn(), &account, None).unwrap(),
            -100_000
        );
        assert_eq!(
            preview(db.conn(), &home, &account, &mapping)
                .unwrap()
                .duplicates,
            1
        );

        let suspicious = preview(db.conn(), &overlap, &account, &mapping).unwrap();
        assert_eq!(
            (suspicious.valid, suspicious.doubtful, suspicious.duplicates),
            (1, 1, 0)
        );
        assert_eq!(
            suspicious.matches[&2][0].note.as_deref(),
            Some("Такси аэропорт")
        );
        assert!(import(db.conn_mut(), &overlap, false, &account, &options).is_err());
        options.decisions.insert(2, false);
        let skipped = import(db.conn_mut(), &overlap, false, &account, &options).unwrap();
        assert_eq!(skipped.added, 0);
        options.decisions.insert(2, true);
        let third = import(db.conn_mut(), &overlap, false, &account, &options).unwrap();
        assert_eq!(third.added, 1);
        assert_eq!(
            accounts::balance(db.conn(), &account, None).unwrap(),
            -150_000
        );
        assert_eq!(
            preview(db.conn(), &overlap, &account, &mapping)
                .unwrap()
                .duplicates,
            1
        );
    }
}
