//! Выписки российских банков как есть, без переделки в шаблон:
//! Т-Банк — CSV или Excel из личного кабинета, Сбер — PDF «Выписка по счёту»
//! из СберБанк Онлайн. Операции попадают на выбранный счёт (или на счёт, в
//! названии которого есть последние цифры карты), категория подбирается
//! правилами автокатегорий, затем по категории банка, иначе — «Прочие».

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use regex::Regex;
use rusqlite::{params, Connection};

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
    /// Имя счёта в банке («Premium»), если выписка его называет.
    pub account: Option<String>,
    /// Категорию задал сам человек в банке («Ваша категория»): она главнее
    /// догадок по получателю.
    pub own: bool,
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

/// Суммы и валюты в порядке предпочтения: сначала то, что списано со счёта.
/// Старая выписка — «Сумма платежа», новая «Operations …» — «Сумма в валюте счёта».
const TBANK_SUMS: &[(&str, &str)] = &[
    ("сумма в валюте счёта", "валюта счёта"),
    ("сумма в валюте счета", "валюта счета"),
    ("сумма платежа", "валюта платежа"),
    ("сумма операции", "валюта операции"),
];

fn tbank_header(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("дата операции")
        && l.contains("описание")
        && TBANK_SUMS.iter().any(|(sum, _)| l.contains(sum))
}

/// «OK», «Ok» и «Ок» (кириллицей, как в выгрузке «Operations …»).
fn tbank_ok(status: &str) -> bool {
    let s: String = status
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'о' => 'o',
            'к' => 'k',
            c => c,
        })
        .collect();
    s == "ok"
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
    let any = |names: &[&str]| names.iter().find_map(|n| col(n));
    let sum = TBANK_SUMS
        .iter()
        .find_map(|(sum, cur)| col(sum).map(|c| (c, col(cur))));
    let (Some(c_date), Some((c_sum, c_cur)), Some(c_desc)) =
        (col("дата операции"), sum, col("описание"))
    else {
        return Err(Error::Validation(
            "в выписке Т-Банка нет столбцов «Дата операции», «Сумма в валюте счёта» (или «Сумма платежа»), «Описание»".into(),
        ));
    };
    let (c_status, c_card) = (col("статус"), col("номер карты"));
    // Своя категория человека в банке главнее категории банка.
    let c_own = col("ваша категория");
    let c_cat = any(&[
        "категория",
        "категория по-умолчанию",
        "категория по умолчанию",
    ]);
    let c_account = any(&["имя счёта", "имя счета"]);
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
        if !status.is_empty() && !tbank_ok(&status) {
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
            own: !get(c_own).is_empty(),
            category: Some(get(c_own))
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| get(c_cat)),
            payee: get(Some(c_desc)),
            card: (digits.len() >= 4).then(|| digits[digits.len() - 4..].to_string()),
            account: Some(get(c_account)).filter(|a| !a.is_empty()),
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
                account: None,
                own: false,
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

/// Ключ запомненного второго счёта для переводов «Между своими счетами».
fn self_key(bank: Bank) -> String {
    format!("{}:self", bank.key())
}

/// Запомнить (или забыть, `None`) второй свой счёт для переводов
/// «Между своими счетами» в выписках банка.
pub(crate) fn remember_self(conn: &Connection, bank: Bank, account_id: Option<&str>) -> Result<()> {
    let mut map = remembered(conn)?;
    match account_id {
        Some(id) => map.insert(self_key(bank), id.into()),
        None => map.remove(&self_key(bank)),
    };
    settings::set(
        conn,
        "bank_accounts",
        &serde_json::to_string(&map).expect("json"),
    )
}

/// Второй свой счёт для переводов: выбранный (`Some("")` — «не знаю») или запомненный.
pub(crate) fn self_account(
    conn: &Connection,
    bank: Bank,
    chosen: Option<&str>,
) -> Result<Option<String>> {
    Ok(match chosen {
        Some("") => None,
        Some(id) => Some(id.to_string()),
        None => remembered(conn)?.get(&self_key(bank)).cloned(),
    })
}

/// Перевод между своими счетами, как его называет банк: «Между своими счетами».
pub(crate) fn own_transfer(op: &Op) -> bool {
    op.payee.to_lowercase().contains("между своими")
}

/// Перевод — повтор уже записанного: перевод той же суммы в ту же дату между
/// теми же двумя счетами (в любую сторону) или эта строка банка, записанная
/// раньше обычной операцией. N-я такая строка файла — повтор, только если
/// таких записей не меньше N.
fn transfer_repeat(
    conn: &Connection,
    t: &TxnInput,
    plain: &TxnInput,
    raw: &str,
    seen: &mut HashMap<String, usize>,
) -> Result<bool> {
    let to = t.to_account_id.as_deref().unwrap_or("");
    let (a, b) = if t.account_id.as_str() <= to {
        (t.account_id.as_str(), to)
    } else {
        (to, t.account_id.as_str())
    };
    let nth = seen
        .entry(format!("transfer|{}|{a}|{b}|{}", t.date, t.amount))
        .or_insert(0);
    let transfers: i64 = conn.query_row(
        "SELECT count(*) FROM transactions WHERE type = 'transfer' AND date = ?1 AND amount = ?4
           AND ((account_id = ?2 AND to_account_id = ?3) OR (account_id = ?3 AND to_account_id = ?2))",
        params![t.date, a, b, t.amount],
        |r| r.get(0),
    )?;
    let n = (transfers as usize).max(existing_count(conn, plain, Some(raw))?);
    let repeat = n > *nth;
    *nth += 1;
    Ok(repeat)
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

/// Куда отнести операцию выписки.
enum Cat {
    /// Готовая категория: id и получатель из правила.
    Found(String, Option<String>),
    /// Категории банка нет в программе и похожей тоже: её создаст загрузка.
    New(String),
}

/// Категории банка «ни о чём»: по ним новую категорию не заводим.
const VAGUE: &[&str] = &["другое", "остальное", "прочее", "разное", "без категории"];

fn category(
    conn: &Connection,
    cats: &HashMap<(String, String), (String, String)>,
    lk: &crate::csv_import::Lookup,
    kind: &str,
    op: &Op,
) -> Result<Option<Cat>> {
    if let Some(rule) = rules::find(conn, &op.payee, kind)? {
        return Ok(Some(Cat::Found(rule.category_id, rule.payee)));
    }
    let hay = if op.own {
        op.category.to_lowercase()
    } else {
        format!("{} {}", op.category, op.payee).to_lowercase()
    };
    // Каждое имя ищем и по-новому, и по-старому (базы до 0.28 не переименованы).
    let legacy = |n: &str| {
        crate::categories::RENAMES
            .iter()
            .find(|r| r.0 == kind && r.3 == n)
            .map(|r| r.2)
    };
    let alias = |catch_all: bool| {
        ALIASES
            .iter()
            .filter(|(k, words, _)| *k == kind && (words == &[""]) == catch_all)
            .filter(|(_, words, _)| words.iter().any(|w| hay.contains(w)))
            .find_map(|(_, _, names)| {
                names.iter().find_map(|n| {
                    cats.get(&(kind.to_string(), n.to_lowercase())).or_else(|| {
                        legacy(n).and_then(|o| cats.get(&(kind.to_string(), o.to_lowercase())))
                    })
                })
            })
            .map(|(id, _)| Cat::Found(id.clone(), None))
    };
    if let Some(found) = alias(false) {
        return Ok(Some(found));
    }
    // Незнакомая категория банка — в похожую или новую, как при загрузке по шаблону.
    let bank = op.category.trim();
    if !bank.is_empty() && !VAGUE.contains(&bank.to_lowercase().as_str()) {
        if let Some((id, _)) = crate::csv_import::similar(lk, kind, bank) {
            return Ok(Some(Cat::Found(id, None)));
        }
        if !bank.to_lowercase().starts_with("прочие") {
            return Ok(Some(Cat::New(bank.to_string())));
        }
    }
    Ok(alias(true))
}

/// Перевод между своими счетами или пополнение — не возврат покупки.
fn transfer_like(op: &Op) -> bool {
    let cat = op.category.to_lowercase();
    cat.contains("перевод")
        || cat.contains("пополн")
        || op.payee.to_lowercase().contains("между своими")
}

/// Операции выписки → строки предпросмотра, готовые операции и то, что
/// добавит загрузка: новые категории и возвраты покупок. `account_id` —
/// счёт, выбранный для этой выписки; без него — запомненный.
///
/// Возврат — поступление от того же получателя в той же категории банка,
/// что и покупка не дороже него и не позже его (в этой выписке или уже в
/// программе). Он записывается возвратом покупки, а не доходом.
pub(crate) fn to_parsed(
    conn: &Connection,
    bank: Bank,
    ops: &[Op],
    account_id: Option<&str>,
    self_id: Option<&str>,
) -> Result<(Vec<Parsed>, crate::csv_import::Extra)> {
    let accounts = accounts(conn)?;
    let saved = remembered(conn)?;
    let lk = crate::csv_import::lookup(conn)?;
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
    // Счёт операции: карта в названии счёта («Т-Банк *1140») или запомненная
    // для неё, затем счёт с тем же именем, что в банке, затем выбранный.
    let account_of = |op: &Op| {
        op.card
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
            .or_else(|| {
                op.account
                    .as_ref()
                    .map(|n| n.trim().to_lowercase())
                    .and_then(|n| accounts.iter().find(|a| a.lower == n))
            })
            .or(chosen)
    };
    let amount_of = |op: &Op, minor: u32| money::parse_amount(&op.amount, minor).map(i64::abs);
    let self_acc = self_account(conn, bank, self_id)?.and_then(|id| by_id(&id));

    // Обе стороны перевода себе в одной выписке (выгрузка со всех счетов):
    // списание с одного счёта и поступление той же суммы в тот же день на
    // другой — один перевод. `pair[i] = j`: строка `j` — его вторая сторона.
    let accs: Vec<Option<&Account>> = ops.iter().map(account_of).collect();
    let amounts: Vec<Option<i64>> = ops
        .iter()
        .zip(&accs)
        .map(|(op, a)| a.and_then(|a| amount_of(op, a.minor).ok()))
        .collect();
    let mut pair: HashMap<usize, usize> = HashMap::new();
    let mut second: HashMap<usize, usize> = HashMap::new();
    for (i, op) in ops.iter().enumerate() {
        let (Some(from), Some(amount)) = (accs[i], amounts[i]) else {
            continue;
        };
        if op.income || !own_transfer(op) || op.date.is_empty() {
            continue;
        }
        let found = ops.iter().enumerate().position(|(j, other)| {
            other.income
                && own_transfer(other)
                && !second.contains_key(&j)
                && other.date == op.date
                && amounts[j] == Some(amount)
                && accs[j].is_some_and(|to| to.id != from.id && to.currency == from.currency)
        });
        if let Some(j) = found {
            pair.insert(i, j);
            second.insert(j, i);
        }
    }

    let mut out = Vec::new();
    let mut extra = crate::csv_import::Extra::default();
    let mut seen = HashMap::new();
    for (i, op) in ops.iter().enumerate() {
        let account = accs[i];
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
        if let Some(&first) = second.get(&i) {
            row.kind = "Перевод".into();
            row.category = format!("вторая сторона строки {}", ops[first].line);
            row.duplicate = true;
            out.push(Parsed {
                row,
                input: None,
                raw_payee: Some(op.payee.clone()),
            });
            continue;
        }
        let mut new_cat: Option<String> = None;
        let mut refund = false;
        let mut transfer: Option<String> = None;
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
            let amount =
                amount_of(op, account.minor).map_err(|_| format!("сумма «{}»", op.amount))?;
            if amount == 0 {
                return Err("сумма равна нулю".into());
            }
            let input = |kind: &str, cat: &Cat| TxnInput {
                kind: kind.into(),
                date: op.date.clone(),
                account_id: account.id.clone(),
                amount,
                category_id: match cat {
                    Cat::Found(id, ..) => Some(id.clone()),
                    Cat::New(_) => None,
                },
                to_account_id: None,
                to_amount: None,
                payee: match cat {
                    Cat::Found(_, Some(p)) => Some(p.clone()),
                    _ => None,
                }
                .or_else(|| Some(op.payee.clone()).filter(|p| !p.is_empty())),
                note: None,
            };
            // Перевод себе: вторая сторона в этой же выписке или выбранный второй счёт.
            if own_transfer(op) {
                let ends = match pair.get(&i) {
                    Some(&j) => accs[j].map(|to| (account, to)),
                    None => self_acc
                        .filter(|s| s.id != account.id && s.currency == account.currency)
                        .map(|s| {
                            if op.income {
                                (s, account)
                            } else {
                                (account, s)
                            }
                        }),
                };
                if let Some((from, to)) = ends {
                    transfer = Some(if op.income {
                        format!("из «{}»", from.name)
                    } else {
                        format!("на «{}»", to.name)
                    });
                    return Ok(TxnInput {
                        kind: "transfer".into(),
                        date: op.date.clone(),
                        account_id: from.id.clone(),
                        amount,
                        category_id: None,
                        to_account_id: Some(to.id.clone()),
                        to_amount: None,
                        payee: None,
                        note: None,
                    });
                }
            }
            // Возврат покупки: та же категория банка и тот же получатель.
            if op.income && !transfer_like(op) && !op.category.trim().is_empty() {
                if let Some(cat) =
                    category(conn, &cats, &lk, "expense", op).map_err(|e| e.to_string())?
                {
                    let as_purchase = input("expense", &cat);
                    let in_file = ops.iter().any(|p| {
                        !p.income
                            && p.payee == op.payee
                            && p.category == op.category
                            && p.card == op.card
                            && p.account == op.account
                            && p.currency == op.currency
                            && !p.date.is_empty()
                            && p.date <= op.date
                            && amount_of(p, account.minor).is_ok_and(|a| a >= amount)
                    });
                    let in_db = || match &cat {
                        Cat::Found(id, ..) => {
                            crate::csv_import::purchase_for(conn, id, &as_purchase, None)
                                .map(|p| p.is_some())
                                .unwrap_or(false)
                        }
                        Cat::New(_) => false,
                    };
                    if in_file || in_db() {
                        refund = true;
                        let mut t = as_purchase;
                        // Повтор возврата ищется среди поступлений: так он записан.
                        t.kind = "income".into();
                        if let Cat::New(name) = cat {
                            new_cat = Some(name);
                        }
                        return Ok(t);
                    }
                }
            }
            let kind = if op.income { "income" } else { "expense" };
            let cat = category(conn, &cats, &lk, kind, op)
                .map_err(|e| e.to_string())?
                .ok_or("нет подходящей категории: добавьте «Прочие расходы» или правило")?;
            let t = input(kind, &cat);
            if let Cat::New(name) = cat {
                new_cat = Some(name);
            }
            Ok(t)
        })();
        let input = match checked {
            Ok(input) => {
                row.category = match &new_cat {
                    Some(name) => format!("{name} (новая)"),
                    None => cats
                        .values()
                        .find(|(id, _)| Some(id) == input.category_id.as_ref())
                        .map(|c| c.1.clone())
                        .unwrap_or_default(),
                };
                if refund {
                    row.kind = "Возврат".into();
                }
                if let Some(p) = &input.payee {
                    row.payee = p.clone();
                }
                let repeat = match &transfer {
                    Some(to) => {
                        row.kind = "Перевод".into();
                        row.category = to.clone();
                        // Та же строка банка, записанная раньше расходом или доходом.
                        let plain = TxnInput {
                            kind: if op.income { "income" } else { "expense" }.into(),
                            account_id: account.map(|a| a.id.clone()).unwrap_or_default(),
                            to_account_id: None,
                            payee: Some(op.payee.clone()),
                            ..input.clone()
                        };
                        transfer_repeat(conn, &input, &plain, &op.payee, &mut seen)?
                    }
                    None => is_repeat(conn, &input, Some(&op.payee), &mut seen)?,
                };
                if repeat {
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
        if input.is_some() {
            let kind = if op.income && !refund {
                "income"
            } else {
                "expense"
            };
            if let Some(name) = new_cat {
                extra
                    .categories
                    .push((out.len(), crate::csv_import::NewCategory::top(kind, &name)));
            }
            if refund {
                extra.refunds.push((out.len(), None));
            }
        }
        out.push(Parsed {
            row,
            input,
            raw_payee: Some(op.payee.clone()),
        });
    }
    Ok((out, extra))
}

/// Такая операция уже есть: та же дата, счёт, тип, сумма и получатель —
/// или эта строка выписки уже связана с записанной вручную операцией.
/// Разбитый чек считается одной операцией на сумму всех его частей: после
/// разбивки повторная выписка не добавит покупку второй раз.
#[cfg(test)]
pub(crate) fn exists(conn: &Connection, t: &TxnInput) -> Result<bool> {
    Ok(existing_count(conn, t, None)? > 0)
}

/// Сколько таких строк банка уже записано: связи этой строки выписки с
/// ручными записями плюс точно такие же операции, ещё не связанные с ней
/// (связанная запись не считается дважды). Разбитый чек — одна операция.
fn existing_count(conn: &Connection, t: &TxnInput, raw: Option<&str>) -> Result<usize> {
    let n: i64 = conn.query_row(
        "WITH links AS (
            SELECT transaction_id FROM import_links WHERE account_id = ?2 AND kind = ?3
              AND bank_date = ?1 AND bank_amount = ?4 AND bank_payee = coalesce(?5, '')),
         keyed AS (
            SELECT k.transaction_id, t.split_id FROM import_keys k
            JOIN transactions t ON t.id = k.transaction_id
            WHERE k.account_id = ?2 AND k.kind = ?3 AND k.bank_date = ?1
              AND k.bank_amount = ?4
              AND k.bank_payee IN (coalesce(?5, ''), coalesce(?6, ?5, '')))
         SELECT (SELECT count(*) FROM links)
              + (SELECT count(DISTINCT coalesce(split_id, transaction_id)) FROM keyed
                   WHERE transaction_id NOT IN (SELECT transaction_id FROM links))
              + (SELECT count(*) FROM transactions t WHERE date = ?1 AND account_id = ?2
                   AND type = ?3 AND abs(amount) = ?4 AND coalesce(payee, '') = coalesce(?5, '')
                   AND split_id IS NULL AND id NOT IN (SELECT transaction_id FROM links)
                   AND NOT EXISTS (SELECT 1 FROM import_keys k WHERE k.transaction_id = t.id))
              + (SELECT count(*) FROM (SELECT 1 FROM transactions t WHERE date = ?1
                   AND account_id = ?2 AND type = ?3 AND coalesce(payee, '') = coalesce(?5, '')
                   AND split_id IS NOT NULL
                 GROUP BY split_id HAVING sum(abs(amount)) = ?4
                   AND sum(id IN (SELECT transaction_id FROM links)) = 0
                   AND sum(EXISTS (SELECT 1 FROM import_keys k
                                   WHERE k.transaction_id = t.id)) = 0))",
        params![t.date, t.account_id, t.kind, t.amount, t.payee, raw],
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
    raw: Option<&str>,
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
    let repeat = existing_count(conn, t, raw)? > *nth;
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
        let parsed = to_parsed(c, bank, &ops, None, None).unwrap().0;
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

        let parsed = to_parsed(c, bank, &ops, Some(&main), None).unwrap().0;
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
        let again = to_parsed(c, bank, &ops, None, None).unwrap().0;
        assert!(again.iter().all(|p| p.row.error.is_none()));

        // Уже загруженные операции помечаются повтором.
        for p in &again {
            crate::transactions::create(c, p.input.as_ref().unwrap()).unwrap();
        }
        let third = to_parsed(c, bank, &ops, None, None).unwrap().0;
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
        let parsed = to_parsed(c, bank, &ops, Some(&acc), None).unwrap().0;
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
        let first = to_parsed(db.conn(), bank, &ops, Some(&main), None)
            .unwrap()
            .0;
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
        let again = to_parsed(db.conn(), bank, &ops, Some(&main), None)
            .unwrap()
            .0;
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
    /// Выгрузка Т-Банка «Operations …» (Excel, OTTO 04.11): столбцы «Сумма в
    /// валюте счёта» и «Категория по-умолчанию», статус «Ок» кириллицей. Данные
    /// обезличены: суммы и порядок строк как в настоящей выгрузке.
    #[test]
    fn reads_tbank_operations_xlsx() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let path = testdata("tbank-operations.xlsx");
        let (bank, ops) = read(&path).unwrap().unwrap();
        assert_eq!(bank, Bank::Tbank);
        // Строка со статусом «Отказ» денег не двигала.
        assert_eq!(ops.len(), 14);
        assert_eq!(ops[2].date, "2026-11-04");
        assert_eq!((ops[2].amount.as_str(), ops[2].income), ("4454,18", false));
        assert_eq!(ops[0].card.as_deref(), Some("2222"));
        assert_eq!(ops[0].account.as_deref(), Some("Premium"));
        // «Ваша категория» главнее категории банка.
        assert_eq!(ops[11].category, "Обеды");

        // Счёт с тем же именем, что в банке, находится сам.
        let premium = account(c, "Premium");
        let parsed = to_parsed(c, bank, &ops, None, None).unwrap().0;
        let rows: Vec<_> = parsed
            .iter()
            .map(|p| {
                (
                    p.row.kind.as_str(),
                    p.row.category.as_str(),
                    p.row.error.as_deref(),
                )
            })
            .collect();
        assert_eq!(rows[0], ("Доход", "Переводы (новая)", None));
        assert_eq!(rows[1], ("Расход", "Сервис (новая)", None));
        assert_eq!(rows[2], ("Расход", "Магазины", None));
        // Поступление от «Доставки еды» после такой же покупки — возврат.
        assert_eq!(rows[6], ("Возврат", "Общепит", None));
        assert_eq!(rows[7], ("Расход", "Общепит", None));
        // Пополнение и перевод себе — не возвраты.
        assert_eq!(rows[9], ("Доход", "Пополнения (новая)", None));
        assert_eq!(rows[11], ("Расход", "Обеды", None));
        assert!(parsed
            .iter()
            .all(|p| p.input.as_ref().is_some_and(|i| i.account_id == premium)));

        // Загрузка: возврат — возвратом покупки, новые категории созданы один раз.
        let mut db = db;
        let saved = crate::csv_import::import(db.conn_mut(), &path, false, None).unwrap();
        assert_eq!(saved.added, 14);
        let c = db.conn();
        let (refund_of, payee): (String, String) = c
            .query_row(
                "SELECT r.refund_of, p.payee FROM transactions r JOIN transactions p ON p.id = r.refund_of
                 WHERE r.refund = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(!refund_of.is_empty());
        assert_eq!(payee, "Доставка еды");
        let n = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            n("SELECT count(*) FROM categories WHERE name = 'Переводы' AND kind = 'expense'"),
            1
        );
        assert_eq!(
            n("SELECT count(*) FROM categories WHERE name = 'Сервис'"),
            1
        );
        // Баланс: сумма всех проведённых строк выписки.
        assert_eq!(
            n(&format!(
                "SELECT sum(CASE WHEN type = 'income' THEN amount ELSE -amount END)
                 FROM transactions WHERE account_id = '{premium}'"
            )),
            1_000_000 - 85_000 - 445_418 - 25_000 - 20_000 - 9_700 + 108_100 - 108_100 - 2_000_000
                + 2_030_691
                - 6_900
                - 20_000
                - 60_000
                - 4_000_000
        );

        // Повторная загрузка того же файла ничего не удваивает.
        let preview = crate::csv_import::preview(c, &path, None).unwrap();
        assert_eq!((preview.valid, preview.duplicates), (0, 14));
        let again = crate::csv_import::import(db.conn_mut(), &path, false, None).unwrap();
        assert_eq!(again.added, 0);
    }

    /// Та же выгрузка через «Импорт из папки»: читается, а повтор не удваивается.
    #[test]
    fn folder_reads_tbank_operations_xlsx() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        account(db.conn(), "Premium");
        let dir = tempfile::tempdir().unwrap();
        std::fs::copy(
            testdata("tbank-operations.xlsx"),
            dir.path()
                .join("Operations Sun Nov 01 2026-Wed Nov 04 2026.xlsx"),
        )
        .unwrap();
        let first = crate::auto_import::scan(db.conn_mut(), dir.path()).unwrap();
        assert_eq!(first.added, 14, "{first:?}");
        let c = db.conn();
        let refunds: i64 = c
            .query_row(
                "SELECT count(*) FROM transactions WHERE refund = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(refunds, 1);
    }
    /// Переводы «Между своими счетами»: с выбранным вторым счётом — переводы,
    /// а не расходы и доходы; выбор запоминается, повтор не удваивает.
    #[test]
    fn own_transfers_go_to_chosen_account() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let premium = account(db.conn(), "Premium");
        let savings = account(db.conn(), "Накопительный");
        let path = testdata("tbank-operations.xlsx");

        // Без второго счёта — как раньше: расход и доход «Переводы».
        let p = crate::csv_import::preview(db.conn(), &path, None).unwrap();
        assert_eq!((p.self_transfers, p.self_account_id.as_deref()), (3, None));
        assert_eq!(p.rows[13].kind, "Расход");

        let p = crate::csv_import::preview_with(db.conn(), &path, None, Some(&savings)).unwrap();
        let kinds: Vec<_> = [0, 8, 9, 12, 13]
            .iter()
            .map(|&i| (p.rows[i].kind.as_str(), p.rows[i].category.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("Перевод", "из «Накопительный»"),
                ("Перевод", "на «Накопительный»"),
                // Пополнение из другого банка и перевод человеку — не переводы себе.
                ("Доход", "Пополнения (новая)"),
                ("Расход", "Переводы (новая)"),
                ("Перевод", "на «Накопительный»"),
            ]
        );
        let saved =
            crate::csv_import::import_with(db.conn_mut(), &path, false, None, Some(&savings))
                .unwrap();
        assert_eq!(saved.added, 14);
        let c = db.conn();
        let n = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            n("SELECT count(*) FROM transactions WHERE type = 'transfer'"),
            3
        );
        assert_eq!(
            n(&format!(
                "SELECT coalesce(sum(CASE WHEN to_account_id = '{savings}' THEN amount ELSE -amount END), 0)
                 FROM transactions WHERE type = 'transfer'"
            )),
            4_000_000 + 2_000_000 - 1_000_000
        );
        // Переводы себе не ждут подтверждения «это перевод?».
        assert_eq!(
            n("SELECT count(*) FROM import_suggestions WHERE kind = 'transfer'"),
            0
        );
        // Запомнено: следующая выписка сразу с переводами, повтор — ничего.
        let p = crate::csv_import::preview(c, &path, None).unwrap();
        assert_eq!(p.self_account_id.as_deref(), Some(savings.as_str()));
        assert_eq!((p.valid, p.duplicates), (0, 14));
        assert_eq!(
            crate::csv_import::import(db.conn_mut(), &path, false, None)
                .unwrap()
                .added,
            0
        );
        let _ = premium;
    }

    /// Записанные раньше расходом и доходом переводы себе не удваиваются,
    /// когда второй счёт выбрали позже.
    #[test]
    fn own_transfers_chosen_later_are_not_doubled() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        account(db.conn(), "Premium");
        let savings = account(db.conn(), "Накопительный");
        let path = testdata("tbank-operations.xlsx");
        crate::csv_import::import(db.conn_mut(), &path, false, None).unwrap();
        let p = crate::csv_import::preview_with(db.conn(), &path, None, Some(&savings)).unwrap();
        assert_eq!((p.valid, p.duplicates), (0, 14));
    }

    /// Обе стороны перевода себе в одной выписке (карты на разных счетах) —
    /// один перевод, вторая строка не записывается.
    #[test]
    fn both_sides_in_one_statement_make_one_transfer() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = account(db.conn(), "Карта *1111");
        let deposit = account(db.conn(), "Вклад *2222");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("operations.csv");
        std::fs::write(
            &path,
            "\"Дата операции\";\"Номер карты\";\"Статус\";\"Сумма операции\";\"Валюта операции\";\"Сумма платежа\";\"Валюта платежа\";\"Категория\";\"Описание\"\n\
             \"03.11.2026 10:00:00\";\"*1111\";\"OK\";\"-500,00\";\"RUB\";\"-500,00\";\"RUB\";\"Переводы\";\"Между своими счетами\"\n\
             \"03.11.2026 10:00:01\";\"*2222\";\"OK\";\"500,00\";\"RUB\";\"500,00\";\"RUB\";\"Переводы\";\"Между своими счетами\"\n",
        )
        .unwrap();
        let p = crate::csv_import::preview(db.conn(), &path, None).unwrap();
        assert_eq!(p.rows[0].kind, "Перевод");
        assert_eq!(p.rows[0].category, "на «Вклад *2222»");
        assert!(p.rows[1].duplicate);
        assert_eq!(p.errors, 0);
        let saved = crate::csv_import::import(db.conn_mut(), &path, false, Some(&card)).unwrap();
        assert_eq!(saved.added, 1);
        let (from, to): (String, String) = db
            .conn()
            .query_row(
                "SELECT account_id, to_account_id FROM transactions WHERE type = 'transfer'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((from, to), (card.clone(), deposit));
        assert_eq!(
            crate::csv_import::import(db.conn_mut(), &path, false, Some(&card))
                .unwrap()
                .added,
            0
        );
    }
}
