//! Выписки российских банков как есть, без переделки в шаблон:
//! Т-Банк — CSV или Excel из личного кабинета, Сбер — PDF «Выписка по счёту»
//! из СберБанк Онлайн. Операции попадают на выбранный счёт (или на счёт, в
//! названии которого есть последние цифры карты), категория подбирается
//! правилами автокатегорий, затем по категории банка, иначе — «Прочие».

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};

use crate::csv_import::{Parsed, Row};
use crate::transactions::TxnInput;
use crate::{money, rules, settings, Error, Result};

/// Банк, чью выписку узнали по содержимому файла.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bank {
    Sber,
    Tbank,
}

impl Bank {
    pub fn key(self) -> &'static str {
        match self {
            Bank::Sber => "sber",
            Bank::Tbank => "tbank",
        }
    }
    pub fn title(self) -> &'static str {
        match self {
            Bank::Sber => "Сбер",
            Bank::Tbank => "Т-Банк",
        }
    }
}

/// Операция из выписки до привязки к счёту и категории.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Op {
    /// Номер строки (CSV) или порядковый номер операции (PDF).
    pub line: usize,
    /// `ГГГГ-ММ-ДД`.
    pub date: String,
    /// Сумма без знака, как в выписке: «1 250,00».
    pub amount: String,
    pub income: bool,
    /// Валюта суммы, если выписка её называет.
    pub currency: Option<String>,
    pub category: String,
    pub payee: String,
    /// Последние 4 цифры карты.
    pub card: Option<String>,
}

/// Крупнее не разбираем: выписка за год — десятки килобайт, а в «Загрузках»
/// бывают большие PDF, которые не выписки.
const MAX_FILE: u64 = 8 * 1024 * 1024;

fn ext(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Узнать банк и прочитать операции. `Ok(None)` — файл не похож на выписку.
pub(crate) fn read(path: &Path) -> Result<Option<(Bank, Vec<Op>)>> {
    if fs::metadata(path)?.len() > MAX_FILE {
        return Ok(None);
    }
    match ext(path).as_str() {
        "csv" => {
            let text = decode(&fs::read(path)?);
            Ok(tbank_header(text.lines().next().unwrap_or(""))
                .then(|| tbank_csv(&text))
                .transpose()?
                .map(|ops| (Bank::Tbank, ops)))
        }
        "xlsx" | "xls" => Ok(tbank_xlsx(path)?.map(|ops| (Bank::Tbank, ops))),
        "pdf" => {
            let lines = pdf_lines(&fs::read(path)?)?;
            Ok(sber_pdf(&lines).map(|ops| (Bank::Sber, ops)))
        }
        _ => Ok(None),
    }
}

/// UTF-8 (с BOM или без), иначе Windows-1251 — так отдаёт CSV Т-Банк.
fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1251.decode(bytes).0.into_owned(),
    }
}

// ---------- Т-Банк ----------

fn tbank_header(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("дата операции") && l.contains("сумма платежа") && l.contains("описание")
}

/// Строки таблицы Т-Банка (первая — заголовок) → операции.
fn tbank_rows(rows: Vec<Vec<String>>, first_line: usize) -> Result<Vec<Op>> {
    let mut rows = rows.into_iter();
    let head: Vec<String> = rows
        .next()
        .unwrap_or_default()
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    let col = |name: &str| head.iter().position(|h| h == name);
    let (Some(c_date), Some(c_sum), Some(c_desc)) =
        (col("дата операции"), col("сумма платежа"), col("описание"))
    else {
        return Err(Error::Validation(
            "в выписке Т-Банка нет столбцов «Дата операции», «Сумма платежа», «Описание»".into(),
        ));
    };
    let (c_cur, c_status, c_cat, c_card) = (
        col("валюта платежа"),
        col("статус"),
        col("категория"),
        col("номер карты"),
    );
    let mut out = Vec::new();
    for (i, r) in rows.enumerate() {
        let get = |c: Option<usize>| {
            c.and_then(|c| r.get(c))
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        };
        if r.iter().all(|f| f.trim().is_empty()) {
            continue;
        }
        // Отклонённые и ещё не проведённые операции денег не двигали.
        let status = get(c_status);
        if !status.is_empty() && !status.eq_ignore_ascii_case("ok") {
            continue;
        }
        let sum = get(Some(c_sum));
        let date = get(Some(c_date));
        let date = date.get(..10).and_then(crate::csv_import::parse_date);
        let digits: String = get(c_card).chars().filter(|c| c.is_ascii_digit()).collect();
        out.push(Op {
            line: first_line + i + 1,
            date: date.unwrap_or_default(),
            income: !sum.starts_with(['-', '−']),
            amount: sum.trim_start_matches(['-', '−', '+']).to_string(),
            currency: Some(get(c_cur)).filter(|c| !c.is_empty()),
            category: get(c_cat),
            payee: get(Some(c_desc)),
            card: (digits.len() >= 4).then(|| digits[digits.len() - 4..].to_string()),
        });
    }
    Ok(out)
}

fn tbank_csv(text: &str) -> Result<Vec<Op>> {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(b';')
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let rows = rdr
        .records()
        .map(|r| r.map(|r| r.iter().map(str::to_string).collect()))
        .collect::<std::result::Result<Vec<Vec<String>>, _>>()
        .map_err(|e| Error::Validation(format!("не удалось прочитать выписку: {e}")))?;
    tbank_rows(rows, 1)
}

fn tbank_xlsx(path: &Path) -> Result<Option<Vec<Op>>> {
    use calamine::{open_workbook_auto, Data, Reader};
    let Ok(mut book) = open_workbook_auto(path) else {
        return Ok(None);
    };
    let Some(Ok(range)) = book.worksheet_range_at(0) else {
        return Ok(None);
    };
    let cell = |d: &Data| match d {
        Data::DateTime(dt) => {
            let (y, mo, d, h, mi, s, _) = dt.to_ymd_hms_milli();
            format!("{d:02}.{mo:02}.{y} {h:02}:{mi:02}:{s:02}")
        }
        Data::Float(f) => format!("{f:.2}").replace('.', ","),
        Data::Int(i) => i.to_string(),
        Data::Empty => String::new(),
        other => other.to_string(),
    };
    let rows: Vec<Vec<String>> = range.rows().map(|r| r.iter().map(cell).collect()).collect();
    let Some(start) = rows.iter().position(|r| tbank_header(&r.join(";"))) else {
        return Ok(None);
    };
    tbank_rows(rows[start..].to_vec(), start + 1).map(Some)
}

// ---------- Сбер ----------

/// Строки текста PDF: буквы собираются по высоте в строки и сортируются слева
/// направо; большой промежуток между буквами — разрыв колонки (`\t`).
#[derive(Default)]
struct Lines {
    page: u32,
    flip: f64,
    glyphs: Vec<(u32, f64, f64, f64, f64, String)>,
}

impl pdf_extract::OutputDev for Lines {
    fn begin_page(
        &mut self,
        page_num: u32,
        media_box: &pdf_extract::MediaBox,
        _: Option<(f64, f64, f64, f64)>,
    ) -> std::result::Result<(), pdf_extract::OutputError> {
        self.page = page_num;
        self.flip = media_box.ury - media_box.lly;
        Ok(())
    }
    fn end_page(&mut self) -> std::result::Result<(), pdf_extract::OutputError> {
        Ok(())
    }
    fn output_character(
        &mut self,
        trm: &pdf_extract::Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        ch: &str,
    ) -> std::result::Result<(), pdf_extract::OutputError> {
        let size = ((font_size * trm.m11).abs() * (font_size * trm.m22).abs()).sqrt();
        let (x, y) = (trm.m31, self.flip - trm.m32);
        self.glyphs
            .push((self.page, y, x, x + width * size, size, ch.to_string()));
        Ok(())
    }
    fn begin_word(&mut self) -> std::result::Result<(), pdf_extract::OutputError> {
        Ok(())
    }
    fn end_word(&mut self) -> std::result::Result<(), pdf_extract::OutputError> {
        Ok(())
    }
    fn end_line(&mut self) -> std::result::Result<(), pdf_extract::OutputError> {
        Ok(())
    }
}

/// Строка PDF: x начала и куски текста между большими промежутками.
#[derive(Debug, Clone)]
pub(crate) struct Line {
    pub x: f64,
    pub parts: Vec<(f64, String)>,
}

impl Line {
    fn text(&self) -> String {
        self.parts
            .iter()
            .map(|p| p.1.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub(crate) fn pdf_lines(bytes: &[u8]) -> Result<Vec<Line>> {
    let bad = || Error::Validation("не удалось прочитать PDF".into());
    // Разбор чужих PDF может упасть на редком шрифте — это не повод ронять приложение.
    let glyphs = std::panic::catch_unwind(|| {
        let doc = pdf_extract::Document::load_mem(bytes).ok()?;
        let mut out = Lines::default();
        pdf_extract::output_doc(&doc, &mut out).ok()?;
        Some(out.glyphs)
    })
    .map_err(|_| bad())?
    .ok_or_else(bad)?;
    let mut glyphs = glyphs;
    glyphs.sort_by(|a, b| {
        (a.0, a.1)
            .partial_cmp(&(b.0, b.1))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut lines = Vec::new();
    let mut i = 0;
    while i < glyphs.len() {
        let (page, y, ..) = glyphs[i];
        let tol = glyphs[i].4.max(4.0) * 0.4;
        let mut j = i;
        while j < glyphs.len() && glyphs[j].0 == page && (glyphs[j].1 - y).abs() <= tol {
            j += 1;
        }
        let mut row: Vec<_> = glyphs[i..j].to_vec();
        row.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
        let mut parts: Vec<(f64, String)> = Vec::new();
        let mut end = f64::MIN;
        for (_, _, x, x_end, size, ch) in row {
            let gap = x - end;
            match parts.last_mut() {
                Some(last) if gap < size * 1.2 => {
                    if gap > size * 0.15 && !last.1.ends_with(' ') && ch != " " {
                        last.1.push(' ');
                    }
                    last.1.push_str(&ch);
                }
                _ if ch.trim().is_empty() => continue,
                _ => parts.push((x, ch)),
            }
            end = x_end;
        }
        for p in &mut parts {
            p.1 = p.1.split_whitespace().collect::<Vec<_>>().join(" ");
        }
        parts.retain(|p| !p.1.is_empty());
        if let Some(first) = parts.first() {
            lines.push(Line { x: first.0, parts });
        }
        i = j;
    }
    Ok(lines)
}

const AMOUNT: &str = r"[+\-−]?\d{1,3}(?:[ \u{a0}]\d{3})*,\d{2}";

/// Выписка СберБанк Онлайн по карте или счёту. Операция — две строки:
/// «дата время | категория | сумма | остаток» и «дата обработки код | описание»;
/// длинное описание продолжается следующими строками в той же колонке.
pub(crate) fn sber_pdf(lines: &[Line]) -> Option<Vec<Op>> {
    let all: String = lines.iter().map(|l| l.text() + "\n").collect();
    let lower = all.to_lowercase();
    if !(lower.contains("сбер") || lower.contains("дата операции (мск)"))
        || !lower.contains("выписка")
    {
        return None;
    }
    // По карте доход идёт с «+», расход без знака; по платёжному счёту
    // наоборот: расход с «−», доход без знака, а описание и категория
    // меняются местами.
    let account_mode = lower.contains("платёжному счёту") || lower.contains("платежному счету");
    let card = Regex::new(r"(?:••|\*{2,4}|•{2,4})\s?(\d{4})")
        .expect("regex")
        .captures(&all)
        .map(|c| c[1].to_string());
    let first = Regex::new(&format!(
        r"^(\d{{2}}\.\d{{2}}\.\d{{4}}) (\d{{2}}:\d{{2}}) (.+?) ({AMOUNT}) ({AMOUNT})$"
    ))
    .expect("regex");
    let second = Regex::new(r"^(\d{2}\.\d{2}\.\d{4})(?: (\d{4,8}))?(?: (.*))?$").expect("regex");
    let noise = |t: &str| {
        let l = t.to_lowercase();
        [
            "дата операции",
            "дата обработки",
            "продолжение",
            "страница",
            "¹",
            "описание операции",
        ]
        .iter()
        .any(|n| l.starts_with(n))
            || l.contains("в валюте счёта")
    };

    let mut ops: Vec<Op> = Vec::new();
    // Колонка описания у текущей операции: продолжения строк ищем только в ней.
    let mut desc_x: Option<f64> = None;
    for line in lines {
        let text = line.text();
        if let Some(c) = first.captures(&text) {
            let sum = c[4].to_string();
            let signed = sum.starts_with(['+', '-', '−']);
            let income = if account_mode {
                !sum.starts_with(['-', '−'])
            } else {
                sum.starts_with('+')
            };
            ops.push(Op {
                line: ops.len() + 1,
                date: crate::csv_import::parse_date(&c[1]).unwrap_or_default(),
                amount: if signed { sum[1..].to_string() } else { sum },
                income,
                currency: None,
                category: c[3].to_string(),
                payee: String::new(),
                card: card.clone(),
            });
            desc_x = None;
            continue;
        }
        let Some(op) = ops.last_mut() else { continue };
        if desc_x.is_none() && op.payee.is_empty() {
            if let Some(c) = second.captures(&text) {
                let rest = c.get(3).map(|m| m.as_str().to_string()).unwrap_or_default();
                op.payee = rest;
                desc_x = line.parts.get(1).map(|p| p.0).or(Some(line.x));
                continue;
            }
        }
        match desc_x {
            Some(x) if (line.x - x).abs() < 3.0 && !noise(&text) && !op.payee.is_empty() => {
                op.payee.push(' ');
                op.payee.push_str(&text);
            }
            _ => desc_x = None,
        }
    }
    for op in &mut ops {
        if account_mode {
            std::mem::swap(&mut op.payee, &mut op.category);
        }
        if op.payee.is_empty() {
            op.payee = op.category.clone();
        }
    }
    (!ops.is_empty()).then_some(ops)
}

// ---------- Привязка к счетам и категориям ----------

/// Слова в категории или описании банка → категории приложения (по порядку).
const ALIASES: &[(&str, &[&str], &[&str])] = &[
    (
        "expense",
        &["супермаркет", "продукт"],
        &["Магазины", "Питание"],
    ),
    (
        "expense",
        &["ресторан", "кафе", "фастфуд", "фаст-фуд", "кофейн"],
        &["Общепит"],
    ),
    ("expense", &["такси"], &["Такси", "Транспорт"]),
    (
        "expense",
        &["азс", "топливо", "бензин"],
        &["Топливо", "Транспорт"],
    ),
    (
        "expense",
        &["транспорт", "метро", "ж/д", "автобус"],
        &["Общественный", "Транспорт"],
    ),
    ("expense", &["аптек"], &["Лекарства", "Медицина"]),
    (
        "expense",
        &["медицин", "здоров", "клиник"],
        &["Медуслуги", "Медицина"],
    ),
    ("expense", &["одежд", "обув"], &["Одежда и обувь"]),
    (
        "expense",
        &["связь", "мобильн", "интернет", "телеком"],
        &["Связь", "Жильё"],
    ),
    (
        "expense",
        &["жкх", "коммунал"],
        &["Коммунальные платежи", "Жильё"],
    ),
    (
        "expense",
        &["цифров", "подписк", "музык"],
        &["Подписки", "Досуг"],
    ),
    (
        "expense",
        &["кино", "театр", "развлеч"],
        &["Культура", "Досуг"],
    ),
    (
        "expense",
        &["путешеств", "авиа", "отел", "турагент"],
        &["Путешествия"],
    ),
    ("expense", &["образован", "книг"], &["Образование"]),
    ("expense", &["цвет", "подар"], &["Подарки"]),
    ("expense", &[""], &["Прочие расходы"]),
    ("income", &["зарплат"], &["Заработная плата"]),
    (
        "income",
        &["кэшбэк", "кешбэк", "бонус"],
        &["Кешбэк и бонусы"],
    ),
    ("income", &["процент"], &["Проценты по вкладам"]),
    ("income", &[""], &["Прочие доходы"]),
];

struct Account {
    id: String,
    name: String,
    lower: String,
    currency: String,
    minor: u32,
}

fn accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, a.currency_code, c.minor_units FROM accounts a
         JOIN currencies c ON c.code = a.currency_code
         WHERE a.type <> 'debt' AND a.archived_at IS NULL ORDER BY a.sort_order, a.name",
    )?;
    let rows = stmt.query_map([], |r| {
        let name: String = r.get(1)?;
        Ok(Account {
            id: r.get(0)?,
            lower: name.to_lowercase(),
            name,
            currency: r.get(2)?,
            minor: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Запомненные счета для выписок: `"sber"`, `"tbank"`, `"tbank:1140"` → id счёта.
pub fn remembered(conn: &Connection) -> Result<BTreeMap<String, String>> {
    Ok(settings::get(conn, "bank_accounts")?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

/// Запомнить счёт для выписок банка (и для каждой карты из этой выписки).
pub(crate) fn remember(conn: &Connection, bank: Bank, ops: &[Op], account_id: &str) -> Result<()> {
    let mut map = remembered(conn)?;
    map.insert(bank.key().into(), account_id.into());
    for card in ops.iter().filter_map(|o| o.card.as_ref()) {
        map.insert(format!("{}:{card}", bank.key()), account_id.into());
    }
    settings::set(
        conn,
        "bank_accounts",
        &serde_json::to_string(&map).expect("json"),
    )
}

fn category(
    conn: &Connection,
    cats: &HashMap<(String, String), (String, String)>,
    kind: &str,
    op: &Op,
) -> Result<Option<(String, String, Option<String>)>> {
    if let Some(rule) = rules::find(conn, &op.payee, kind)? {
        let name: Option<String> = conn
            .query_row(
                "SELECT name FROM categories WHERE id = ?1",
                [&rule.category_id],
                |r| r.get(0),
            )
            .optional()?;
        return Ok(Some((
            rule.category_id,
            name.unwrap_or_default(),
            rule.payee,
        )));
    }
    let hay = format!("{} {}", op.category, op.payee).to_lowercase();
    for (k, words, names) in ALIASES {
        if *k != kind || !words.iter().any(|w| hay.contains(w)) {
            continue;
        }
        // Каждое имя ищем и по-новому, и по-старому (базы до 0.28 не переименованы).
        let legacy = |n: &str| {
            crate::categories::RENAMES
                .iter()
                .find(|r| r.0 == kind && r.3 == n)
                .map(|r| r.2)
        };
        if let Some((id, name)) = names.iter().find_map(|n| {
            cats.get(&(kind.to_string(), n.to_lowercase()))
                .or_else(|| legacy(n).and_then(|o| cats.get(&(kind.to_string(), o.to_lowercase()))))
        }) {
            return Ok(Some((id.clone(), name.clone(), None)));
        }
    }
    Ok(None)
}

/// Операции выписки → строки предпросмотра и готовые операции. `account_id` —
/// счёт, выбранный для этой выписки; без него — запомненный.
pub(crate) fn to_parsed(
    conn: &Connection,
    bank: Bank,
    ops: &[Op],
    account_id: Option<&str>,
) -> Result<Vec<Parsed>> {
    let accounts = accounts(conn)?;
    let saved = remembered(conn)?;
    let mut cats: HashMap<(String, String), (String, String)> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT id, kind, name FROM categories WHERE archived_at IS NULL ORDER BY parent_id IS NOT NULL, sort_order",
    )?;
    for r in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (id, kind, name) = r?;
        cats.entry((kind, name.to_lowercase()))
            .or_insert((id, name));
    }
    let by_id = |id: &str| accounts.iter().find(|a| a.id == id);
    let chosen = account_id
        .and_then(by_id)
        .or_else(|| saved.get(bank.key()).and_then(|id| by_id(id)));

    let mut out = Vec::new();
    let mut seen = HashMap::new();
    for op in ops {
        let kind = if op.income { "income" } else { "expense" };
        // Карта в названии счёта («Т-Банк *1140») или запомненная для неё.
        let account = op
            .card
            .as_ref()
            .and_then(|card| {
                accounts
                    .iter()
                    .find(|a| a.lower.contains(card.as_str()))
                    .or_else(|| {
                        saved
                            .get(&format!("{}:{card}", bank.key()))
                            .and_then(|id| by_id(id))
                    })
            })
            .or(chosen);
        let mut row = Row {
            line: op.line,
            date: op.date.clone(),
            kind: if op.income {
                "Доход"
            } else {
                "Расход"
            }
            .into(),
            account: account.map(|a| a.name.clone()).unwrap_or_default(),
            amount: op.amount.clone(),
            category: String::new(),
            payee: op.payee.clone(),
            error: None,
            duplicate: false,
            linked_to: None,
            maybe: 0,
        };
        let checked = (|| -> std::result::Result<TxnInput, String> {
            if op.date.is_empty() {
                return Err("не удалось прочитать дату".into());
            }
            let account = account.ok_or("выберите счёт для этой выписки")?;
            if let Some(cur) = op.currency.as_deref().filter(|c| *c != account.currency) {
                return Err(format!(
                    "сумма в {cur}, а счёт «{}» в {}",
                    account.name, account.currency
                ));
            }
            let amount = money::parse_amount(&op.amount, account.minor)
                .map_err(|_| format!("сумма «{}»", op.amount))?
                .abs();
            if amount == 0 {
                return Err("сумма равна нулю".into());
            }
            let (category_id, _, payee) = category(conn, &cats, kind, op)
                .map_err(|e| e.to_string())?
                .ok_or("нет подходящей категории: добавьте «Прочие расходы» или правило")?;
            Ok(TxnInput {
                kind: kind.into(),
                date: op.date.clone(),
                account_id: account.id.clone(),
                amount,
                category_id: Some(category_id),
                to_account_id: None,
                to_amount: None,
                payee: payee.or_else(|| Some(op.payee.clone()).filter(|p| !p.is_empty())),
                note: None,
            })
        })();
        let input = match checked {
            Ok(input) => {
                row.category = cats
                    .values()
                    .find(|(id, _)| Some(id) == input.category_id.as_ref())
                    .map(|c| c.1.clone())
                    .unwrap_or_default();
                if let Some(p) = &input.payee {
                    row.payee = p.clone();
                }
                if is_repeat(conn, &input, &mut seen)? {
                    row.duplicate = true;
                    None
                } else {
                    Some(input)
                }
            }
            Err(e) => {
                row.error = Some(e);
                None
            }
        };
        out.push(Parsed { row, input });
    }
    Ok(out)
}

/// Такая операция уже есть: та же дата, счёт, тип, сумма и получатель —
/// или эта строка выписки уже связана с записанной вручную операцией.
/// Разбитый чек считается одной операцией на сумму всех его частей: после
/// разбивки повторная выписка не добавит покупку второй раз.
#[cfg(test)]
pub(crate) fn exists(conn: &Connection, t: &TxnInput) -> Result<bool> {
    Ok(existing_count(conn, t)? > 0)
}

/// Сколько таких строк банка уже записано: связи этой строки выписки с
/// ручными записями плюс точно такие же операции, ещё не связанные с ней
/// (связанная запись не считается дважды). Разбитый чек — одна операция.
fn existing_count(conn: &Connection, t: &TxnInput) -> Result<usize> {
    let n: i64 = conn.query_row(
        "WITH links AS (
            SELECT transaction_id FROM import_links WHERE account_id = ?2 AND kind = ?3
              AND bank_date = ?1 AND bank_amount = ?4 AND bank_payee = coalesce(?5, ''))
         SELECT (SELECT count(*) FROM links)
              + (SELECT count(*) FROM transactions WHERE date = ?1 AND account_id = ?2
                   AND type = ?3 AND abs(amount) = ?4 AND coalesce(payee, '') = coalesce(?5, '')
                   AND split_id IS NULL AND id NOT IN (SELECT transaction_id FROM links))
              + (SELECT count(*) FROM (SELECT 1 FROM transactions WHERE date = ?1
                   AND account_id = ?2 AND type = ?3 AND coalesce(payee, '') = coalesce(?5, '')
                   AND split_id IS NOT NULL
                 GROUP BY split_id HAVING sum(abs(amount)) = ?4
                   AND sum(id IN (SELECT transaction_id FROM links)) = 0))",
        params![t.date, t.account_id, t.kind, t.amount, t.payee],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// Строка выписки — повтор уже записанного. Одинаковые строки одного файла
/// (две одинаковые покупки за день) считаются по порядку: N-я такая строка —
/// повтор, только если таких операций уже записано не меньше N. Так более
/// полная выписка добавит недостающую вторую покупку, а повтор файла — ничего.
/// `seen` — сколько таких строк уже встретилось в этом файле.
pub(crate) fn is_repeat(
    conn: &Connection,
    t: &TxnInput,
    seen: &mut HashMap<String, usize>,
) -> Result<bool> {
    let key = format!(
        "{}|{}|{}|{}|{}",
        t.date,
        t.account_id,
        t.kind,
        t.amount,
        t.payee.as_deref().unwrap_or("")
    );
    let nth = seen.entry(key).or_insert(0);
    let repeat = existing_count(conn, t)? > *nth;
    *nth += 1;
    Ok(repeat)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, AccountInput};
    use crate::storage::Storage;

    fn testdata(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join(name)
    }

    #[test]
    fn reads_sber_card_pdf() {
        let (bank, ops) = read(&testdata("sber-card.pdf")).unwrap().unwrap();
        assert_eq!(bank, Bank::Sber);
        let short: Vec<_> = ops
            .iter()
            .map(|o| {
                (
                    o.date.as_str(),
                    o.amount.as_str(),
                    o.income,
                    o.payee.as_str(),
                )
            })
            .collect();
        assert_eq!(
            short,
            [
                (
                    "2026-10-20",
                    "1 250,00",
                    false,
                    "PYATEROCHKA 1234 Moscow RUS"
                ),
                ("2026-10-18", "50 000,00", true, "Зарплата ООО Ромашка"),
                (
                    "2026-10-15",
                    "650,00",
                    false,
                    "МТС мобильная связь, оплата по номеру +7 916 ***-**-12"
                ),
                ("2026-10-05", "399,00", false, "YANDEX*PLUS Moscow RUS"),
                ("2026-10-03", "1 840,50", false, "KOFEMANIYA Moscow RUS"),
            ]
        );
        assert_eq!(ops[0].category, "Супермаркеты");
        assert_eq!(ops[0].card.as_deref(), Some("4321"));
    }

    #[test]
    fn reads_tbank_csv_in_cp1251_and_skips_failed() {
        let (bank, ops) = read(&testdata("tbank.csv")).unwrap().unwrap();
        assert_eq!(bank, Bank::Tbank);
        let short: Vec<_> = ops
            .iter()
            .map(|o| {
                (
                    o.date.as_str(),
                    o.amount.as_str(),
                    o.income,
                    o.payee.as_str(),
                    o.card.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            short,
            [
                ("2026-10-20", "1053,77", false, "Пятерочка", Some("1140")),
                ("2026-10-18", "1200,00", false, "Steam", Some("1140")),
                ("2026-10-15", "85000,00", true, "Зарплата", None),
                ("2026-10-10", "2500,00", false, "Яндекс Go", Some("8305")),
            ]
        );
    }

    #[test]
    fn foreign_files_are_not_statements() {
        let dir = tempfile::tempdir().unwrap();
        let csv = dir.path().join("price.csv");
        fs::write(&csv, "name;price\nчай;10\n").unwrap();
        assert!(read(&csv).unwrap().is_none());
        let pdf = dir.path().join("book.pdf");
        fs::write(&pdf, b"%PDF-1.4 broken").unwrap();
        assert!(read(&pdf).is_err() || read(&pdf).unwrap().is_none());
    }

    fn account(c: &Connection, name: &str) -> String {
        accounts::create(
            c,
            &AccountInput {
                name: name.into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 0,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn maps_cards_categories_and_duplicates() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let main = account(c, "Т-Банк");
        let taxi_card = account(c, "Кредитка *8305");
        let (bank, ops) = read(&testdata("tbank.csv")).unwrap().unwrap();

        // Без выбранного счёта загрузится только операция по карте из названия счёта.
        let parsed = to_parsed(c, bank, &ops, None).unwrap();
        let errors: Vec<_> = parsed.iter().map(|p| p.row.error.as_deref()).collect();
        assert_eq!(
            errors,
            [
                Some("выберите счёт для этой выписки"),
                Some("выберите счёт для этой выписки"),
                Some("выберите счёт для этой выписки"),
                None
            ]
        );
        assert_eq!(parsed[3].input.as_ref().unwrap().account_id, taxi_card);

        let parsed = to_parsed(c, bank, &ops, Some(&main)).unwrap();
        let rows: Vec<_> = parsed
            .iter()
            .map(|p| {
                (
                    p.row.kind.as_str(),
                    p.row.category.as_str(),
                    p.row.account.as_str(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("Расход", "Магазины", "Т-Банк"),
                ("Расход", "Подписки", "Т-Банк"),
                ("Доход", "Заработная плата", "Т-Банк"),
                ("Расход", "Такси", "Кредитка *8305"),
            ]
        );
        assert_eq!(parsed[0].input.as_ref().unwrap().amount, 105_377);

        // Выбор запоминается: в следующий раз счёт подставится сам.
        remember(c, bank, &ops, &main).unwrap();
        let again = to_parsed(c, bank, &ops, None).unwrap();
        assert!(again.iter().all(|p| p.row.error.is_none()));

        // Уже загруженные операции помечаются повтором.
        for p in &again {
            crate::transactions::create(c, p.input.as_ref().unwrap()).unwrap();
        }
        let third = to_parsed(c, bank, &ops, None).unwrap();
        assert!(third.iter().all(|p| p.row.duplicate && p.input.is_none()));
    }

    #[test]
    fn rules_win_over_bank_category() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let acc = account(c, "Карта Сбер");
        let cafe: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Обеды'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        rules::create(
            c,
            &rules::RuleInput {
                pattern: "pyaterochka".into(),
                category_id: cafe,
                payee: Some("Пятёрочка у работы".into()),
            },
        )
        .unwrap();
        let (bank, ops) = read(&testdata("sber-card.pdf")).unwrap().unwrap();
        let parsed = to_parsed(c, bank, &ops, Some(&acc)).unwrap();
        let rows: Vec<_> = parsed
            .iter()
            .map(|p| (p.row.category.as_str(), p.row.payee.as_str()))
            .collect();
        assert_eq!(rows[0], ("Обеды", "Пятёрочка у работы"));
        assert_eq!(
            rows[1].0, "Заработная плата",
            "по описанию «Зарплата ООО Ромашка»"
        );
        assert_eq!(rows[2].0, "Связь");
        assert_eq!(rows[4].0, "Общепит");
    }

    /// Сочетание: выписка загружена, покупку разбили по категориям, ту же
    /// выписку загружают снова — разбитый чек узнаётся, второй раз не добавляется.
    #[test]
    fn reimport_after_split_receipt_is_a_duplicate() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let main = account(db.conn(), "Т-Банк");
        let (bank, ops) = read(&testdata("tbank.csv")).unwrap().unwrap();
        let first = to_parsed(db.conn(), bank, &ops, Some(&main)).unwrap();
        let mut ids = Vec::new();
        for p in &first {
            if let Some(i) = &p.input {
                ids.push((
                    crate::transactions::create(db.conn(), i).unwrap(),
                    i.clone(),
                ));
            }
        }
        // Покупку в супермаркете (1 053,77) разбиваем на две категории.
        let (id, shop) = ids
            .iter()
            .find(|(_, i)| i.amount == 105_377)
            .unwrap()
            .clone();
        let cat = |name: &str| -> String {
            db.conn()
                .query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
                    r.get(0)
                })
                .unwrap()
        };
        let (food, home) = (cat("Магазины"), cat("Прочие расходы"));
        db.conn()
            .execute("DELETE FROM transactions WHERE id = ?1", [&id])
            .unwrap();
        crate::receipts::create(
            db.conn_mut(),
            &crate::receipts::ReceiptInput {
                date: shop.date.clone(),
                account_id: shop.account_id.clone(),
                payee: shop.payee.clone(),
                note: None,
                total: 105_377,
                parts: vec![
                    crate::receipts::PartInput {
                        category_id: food,
                        amount: 80_000,
                        note: None,
                    },
                    crate::receipts::PartInput {
                        category_id: home,
                        amount: 25_377,
                        note: None,
                    },
                ],
                tags: Vec::new(),
                event_id: None,
            },
        )
        .unwrap();
        let again = to_parsed(db.conn(), bank, &ops, Some(&main)).unwrap();
        let fresh: Vec<_> = again
            .iter()
            .filter(|p| p.input.is_some())
            .map(|p| p.row.line)
            .collect();
        assert!(fresh.is_empty(), "повторно загрузились бы строки {fresh:?}");
        assert!(again
            .iter()
            .filter(|p| p.row.error.is_none())
            .all(|p| p.row.duplicate));
        // Часть чека на ту же сумму, что другая покупка, сама по себе не «повтор».
        let mut other = shop.clone();
        other.amount = 80_000;
        assert!(!exists(db.conn(), &other).unwrap());
    }
}
