//! Выгрузка в Excel (`.xlsx`) и CSV. Листы собираются в общую модель
//! (`Sheet`), а записываются двумя функциями: так сводка, отчёт и список
//! операций выглядят одинаково в обоих форматах.
//!
//! В `.xlsx` суммы пишутся числами с денежным форматом, даты — датами Excel.
//! CSV — UTF-8 с BOM и разделителем `;`, чтобы русский Excel открывал его
//! двойным щелчком; суммы с десятичной запятой, даты `ДД.ММ.ГГГГ`.

use std::fs;
use std::path::Path;

use rusqlite::Connection;
use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};

use crate::error::invalid;
use crate::transactions::{self, Filter, Txn};
use crate::{budgets, currencies, debts, reports, Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Text(String),
    /// Сумма в минимальных единицах и число знаков после запятой.
    Money(i64, u32),
    /// Целый процент; `None` — не считается (например, нет доходов).
    Percent(Option<i64>),
    /// `YYYY-MM-DD`.
    Date(String),
    Int(i64),
    Empty,
}

impl Cell {
    fn text(s: impl Into<String>) -> Self {
        Cell::Text(s.into())
    }
    fn opt(s: &Option<String>) -> Self {
        s.as_deref().map_or(Cell::Empty, Cell::text)
    }
}

/// Лист: заголовок (может быть пустым) и строки.
#[derive(Debug, Clone)]
pub struct Sheet {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

impl Sheet {
    fn new(name: &str, headers: &[&str]) -> Self {
        Sheet {
            name: name.to_string(),
            headers: headers.iter().map(|h| h.to_string()).collect(),
            rows: Vec::new(),
        }
    }
}

fn xlsx_err(e: rust_xlsxwriter::XlsxError) -> Error {
    Error::Validation(format!("не удалось записать файл Excel: {e}"))
}

/// Записать книгу `.xlsx`. Пишется во временный файл и переименовывается.
pub fn write_xlsx(path: &Path, sheets: &[Sheet]) -> Result<()> {
    let mut wb = Workbook::new();
    let bold = Format::new().set_bold();
    let date = Format::new().set_num_format("dd.mm.yyyy");
    let percent = Format::new().set_num_format("0%");
    let money: Vec<Format> = (0..=4)
        .map(|mu| {
            let frac = if mu == 0 {
                String::new()
            } else {
                format!(".{}", "0".repeat(mu))
            };
            Format::new().set_num_format(format!("#,##0{frac}"))
        })
        .collect();
    for sheet in sheets {
        let ws = wb.add_worksheet();
        ws.set_name(&sheet.name).map_err(xlsx_err)?;
        let mut r = 0u32;
        if !sheet.headers.is_empty() {
            for (c, h) in sheet.headers.iter().enumerate() {
                ws.write_string_with_format(0, c as u16, h, &bold)
                    .map_err(xlsx_err)?;
            }
            ws.set_freeze_panes(1, 0).map_err(xlsx_err)?;
            r = 1;
        }
        for row in &sheet.rows {
            for (c, cell) in row.iter().enumerate() {
                let c = c as u16;
                match cell {
                    Cell::Text(s) => {
                        ws.write_string(r, c, s).map_err(xlsx_err)?;
                    }
                    Cell::Money(v, mu) => {
                        let mu = (*mu).min(4);
                        let n = *v as f64 / 10f64.powi(mu as i32);
                        ws.write_number_with_format(r, c, n, &money[mu as usize])
                            .map_err(xlsx_err)?;
                    }
                    Cell::Percent(Some(p)) => {
                        ws.write_number_with_format(r, c, *p as f64 / 100.0, &percent)
                            .map_err(xlsx_err)?;
                    }
                    Cell::Date(d) => {
                        let dt = ExcelDateTime::parse_from_str(d).map_err(xlsx_err)?;
                        ws.write_datetime_with_format(r, c, &dt, &date)
                            .map_err(xlsx_err)?;
                    }
                    Cell::Int(n) => {
                        ws.write_number(r, c, *n as f64).map_err(xlsx_err)?;
                    }
                    Cell::Percent(None) | Cell::Empty => {}
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

/// Значение ячейки для CSV: суммы с запятой без разделителей разрядов.
pub fn csv_value(cell: &Cell) -> String {
    match cell {
        Cell::Text(s) => s.clone(),
        Cell::Money(v, mu) => {
            let neg = *v < 0;
            let abs = v.unsigned_abs();
            let scale = 10u64.pow(*mu);
            let mut s = (abs / scale).to_string();
            if *mu > 0 {
                s.push_str(&format!(",{:0width$}", abs % scale, width = *mu as usize));
            }
            if neg {
                format!("-{s}")
            } else {
                s
            }
        }
        Cell::Percent(Some(p)) => p.to_string(),
        Cell::Date(d) if d.len() == 10 => format!("{}.{}.{}", &d[8..10], &d[5..7], &d[0..4]),
        Cell::Date(d) => d.clone(),
        Cell::Int(n) => n.to_string(),
        Cell::Percent(None) | Cell::Empty => String::new(),
    }
}

/// Записать лист в CSV (UTF-8 с BOM, разделитель `;`).
pub fn write_csv(path: &Path, sheet: &Sheet) -> Result<()> {
    let mut w = csv::WriterBuilder::new()
        .delimiter(b';')
        .from_writer(vec![0xEF, 0xBB, 0xBF]);
    let csv_err = |e: csv::Error| Error::Validation(format!("не удалось записать CSV: {e}"));
    if !sheet.headers.is_empty() {
        w.write_record(&sheet.headers).map_err(csv_err)?;
    }
    for row in &sheet.rows {
        w.write_record(row.iter().map(csv_value)).map_err(csv_err)?;
    }
    let bytes = w
        .into_inner()
        .map_err(|e| Error::Validation(format!("не удалось записать CSV: {e}")))?;
    let tmp = path.with_extension("csv.part");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Записать один лист в формате по расширению файла (`.xlsx` или `.csv`).
pub fn write_one(path: &Path, sheet: &Sheet) -> Result<()> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("xlsx") => write_xlsx(path, std::slice::from_ref(sheet)),
        Some("csv") => write_csv(path, sheet),
        _ => invalid("файл должен быть .xlsx или .csv"),
    }
}

// --- Листы ---

pub const TXN_HEADERS: [&str; 11] = [
    "Дата",
    "Тип",
    "Счёт",
    "Категория",
    "Получатель",
    "Комментарий",
    "Сумма",
    "Валюта",
    "Сумма в основной валюте",
    "Счёт зачисления",
    "Сумма зачисления",
];

pub fn txn_type_name(kind: &str) -> &'static str {
    match kind {
        "expense" => "Расход",
        "income" => "Доход",
        "transfer" => "Перевод",
        _ => "Корректировка",
    }
}

fn account_currency(conn: &Connection, account_id: &str) -> Result<String> {
    Ok(conn.query_row(
        "SELECT currency_code FROM accounts WHERE id = ?1",
        [account_id],
        |r| r.get(0),
    )?)
}

fn txn_row(conn: &Connection, t: &Txn, base: &str, base_mu: u32) -> Result<Vec<Cell>> {
    let currency = account_currency(conn, &t.account_id)?;
    // Расход со знаком минус: сумма по столбцу сразу даёт сальдо.
    let signed = if t.kind == "expense" {
        -t.amount
    } else {
        t.amount
    };
    let in_base = if t.kind == "transfer" {
        Cell::Empty
    } else {
        currencies::convert(conn, signed, &currency, base, &t.date)?
            .map_or(Cell::Empty, |v| Cell::Money(v, base_mu))
    };
    Ok(vec![
        Cell::Date(t.date.clone()),
        Cell::text(txn_type_name(&t.kind)),
        Cell::text(&t.account_name),
        Cell::opt(&t.category_name),
        Cell::opt(&t.payee),
        Cell::opt(&t.note),
        Cell::Money(signed, t.minor_units),
        Cell::text(currency),
        in_base,
        Cell::opt(&t.to_account_name),
        match (t.to_amount, t.to_minor_units) {
            (Some(a), Some(mu)) => Cell::Money(a, mu),
            _ => Cell::Empty,
        },
    ])
}

/// Все операции по фильтру (без ограничения в 5 000 строк), старые сверху.
pub fn all_transactions(conn: &Connection, filter: &Filter) -> Result<Vec<Txn>> {
    let mut out = Vec::new();
    let mut f = filter.clone();
    f.limit = Some(5000);
    f.offset = Some(0);
    loop {
        let page = transactions::list(conn, &f)?;
        let n = page.items.len() as i64;
        out.extend(page.items);
        if n < 5000 {
            break;
        }
        f.offset = Some(f.offset.unwrap_or(0) + n);
    }
    out.reverse();
    Ok(out)
}

pub fn transactions_sheet(conn: &Connection, filter: &Filter) -> Result<Sheet> {
    let base = currencies::base_currency(conn)?;
    let base_mu = currencies::minor_units(conn, &base)?;
    let mut s = Sheet::new("Операции", &TXN_HEADERS);
    for t in all_transactions(conn, filter)? {
        s.rows.push(txn_row(conn, &t, &base, base_mu)?);
    }
    Ok(s)
}

fn day_before(date: &str) -> Result<String> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| Error::Validation(format!("некорректная дата: {date}")))?;
    Ok((d - chrono::Duration::days(1)).to_string())
}

fn summary_sheet(conn: &Connection, from: &str, to: &str, today: &str) -> Result<Sheet> {
    let base = currencies::base_currency(conn)?;
    let mu = currencies::minor_units(conn, &base)?;
    let s = reports::period_summary(conn, from, to)?;
    let m = |v: i64| Cell::Money(v, mu);
    let mut sh = Sheet::new("Сводка", &[]);
    let row = |label: &str, value: Cell| vec![Cell::text(label), value];
    sh.rows.push(vec![
        Cell::text("Сводка P-Treasury"),
        Cell::Date(from.into()),
        Cell::Date(to.into()),
    ]);
    sh.rows.push(row("Основная валюта", Cell::text(&base)));
    sh.rows.push(vec![]);
    sh.rows.push(row("Доходы", m(s.income)));
    sh.rows.push(row("Расходы", m(s.expense)));
    sh.rows.push(row("Сальдо", m(s.income - s.expense)));
    sh.rows
        .push(row("Норма сбережений", Cell::Percent(s.savings_rate)));
    sh.rows.push(row("Корректировки", m(s.adjustments)));
    if !s.missing_rates.is_empty() {
        sh.rows.push(row(
            "Нет курса (не вошли)",
            Cell::text(s.missing_rates.join(", ")),
        ));
    }
    sh.rows.push(vec![]);
    sh.rows.push(
        ["Счёт", "Валюта", "На начало", "На конец"]
            .map(Cell::text)
            .to_vec(),
    );
    let start = reports::balances_on(conn, &day_before(from)?)?;
    let end_date = if to < today { to } else { today };
    let end = reports::balances_on(conn, end_date)?;
    for r in end.rows.iter().filter(|r| r.kind != "debt" && !r.archived) {
        let before = start
            .rows
            .iter()
            .find(|b| b.account_id == r.account_id)
            .map_or(0, |b| b.balance);
        sh.rows.push(vec![
            Cell::text(&r.name),
            Cell::text(&r.currency_code),
            Cell::Money(before, r.minor_units),
            Cell::Money(r.balance, r.minor_units),
        ]);
    }
    sh.rows.push(vec![
        Cell::text("Итого в основной валюте"),
        Cell::text(&base),
        m(start.total),
        m(end.total),
    ]);
    let d = debts::summary(conn, end_date, 0)?;
    sh.rows.push(vec![]);
    sh.rows.push(row("Должны мне", m(d.owed_to_me)));
    sh.rows.push(row("Должен я", m(d.i_owe)));
    sh.rows.push(row("Чистые активы", m(d.net_worth)));
    Ok(sh)
}

fn categories_sheet(conn: &Connection, from: &str, to: &str) -> Result<Sheet> {
    let mu = currencies::minor_units(conn, &currencies::base_currency(conn)?)?;
    let mut sh = Sheet::new(
        "По категориям",
        &["Тип", "Категория", "Подкатегория", "Сумма", "Доля"],
    );
    for (kind, name) in [("expense", "Расход"), ("income", "Доход")] {
        let rep = reports::by_category(conn, kind, from, to)?;
        for item in &rep.items {
            sh.rows.push(vec![
                Cell::text(name),
                Cell::text(&item.name),
                Cell::Empty,
                Cell::Money(item.amount, mu),
                Cell::Percent(Some(item.percent)),
            ]);
            for ch in &item.children {
                sh.rows.push(vec![
                    Cell::text(name),
                    Cell::text(&item.name),
                    Cell::text(&ch.name),
                    Cell::Money(ch.amount, mu),
                    Cell::Percent(Some(ch.percent)),
                ]);
            }
        }
        sh.rows.push(vec![
            Cell::text(name),
            Cell::text("Итого"),
            Cell::Empty,
            Cell::Money(rep.total, mu),
            Cell::Percent(Some(100)),
        ]);
    }
    Ok(sh)
}

/// Бюджетные месяцы, которые пересекаются с периодом.
fn months_of(conn: &Connection, from: &str, to: &str) -> Result<Vec<String>> {
    let first = budgets::month_of(conn, from)?.month;
    let last = budgets::month_of(conn, to)?.month;
    let mut out = vec![first.clone()];
    let mut m = first;
    while m < last {
        if out.len() > 120 {
            return invalid("период больше 10 лет");
        }
        m = budgets::shift_month(&m, 1)?;
        out.push(m.clone());
    }
    Ok(out)
}

fn budget_sheet(conn: &Connection, from: &str, to: &str, today: &str) -> Result<Sheet> {
    let mut sh = Sheet::new(
        "Бюджет",
        &[
            "Месяц",
            "Тип",
            "Категория",
            "План",
            "Факт",
            "Отклонение",
            "Выполнение",
        ],
    );
    for month in months_of(conn, from, to)? {
        let b = budgets::get(conn, &month, today)?;
        if b.id.is_none() {
            continue;
        }
        let mu = currencies::minor_units(conn, &b.currency_code)?;
        for l in &b.lines {
            sh.rows.push(vec![
                Cell::text(&month),
                Cell::text(if l.kind == "income" {
                    "Доход"
                } else {
                    "Расход"
                }),
                Cell::text(&l.category_name),
                Cell::Money(l.limit, mu),
                Cell::Money(l.actual, mu),
                Cell::Money(l.limit - l.actual, mu),
                Cell::Percent(Some(l.percent)),
            ]);
        }
    }
    Ok(sh)
}

fn months_sheet(conn: &Connection, from: &str, to: &str) -> Result<Sheet> {
    let mu = currencies::minor_units(conn, &currencies::base_currency(conn)?)?;
    let months = months_of(conn, from, to)?;
    let rep = reports::by_month(conn, &months[0], months.last().expect("месяц есть"))?;
    let mut sh = Sheet::new(
        "По месяцам",
        &[
            "Месяц",
            "С",
            "По",
            "Доходы",
            "Расходы",
            "Сальдо",
            "Норма сбережений",
        ],
    );
    for r in &rep.months {
        sh.rows.push(vec![
            Cell::text(&r.period.month),
            Cell::Date(r.period.start.clone()),
            Cell::Date(r.period.end.clone()),
            Cell::Money(r.income, mu),
            Cell::Money(r.expense, mu),
            Cell::Money(r.balance, mu),
            Cell::Percent(r.savings_rate),
        ]);
    }
    sh.rows.push(vec![
        Cell::text("Итого"),
        Cell::Empty,
        Cell::Empty,
        Cell::Money(rep.income, mu),
        Cell::Money(rep.expense, mu),
        Cell::Money(rep.balance, mu),
        Cell::Percent(rep.savings_rate),
    ]);
    Ok(sh)
}

fn debts_sheet(conn: &Connection, today: &str) -> Result<Sheet> {
    let mut sh = Sheet::new(
        "Долги",
        &[
            "Кто",
            "Направление",
            "Валюта",
            "Сумма долга",
            "Остаток",
            "Ставка",
            "Ближайший платёж",
            "Сумма платежа",
            "Статус",
        ],
    );
    for d in debts::list(conn, today)? {
        let mu = d.minor_units;
        sh.rows.push(vec![
            Cell::text(&d.counterparty),
            Cell::text(if d.direction == "lent" {
                "Мне должны"
            } else {
                "Я должен"
            }),
            Cell::text(&d.currency_code),
            Cell::Money(d.principal, mu),
            Cell::Money(d.outstanding, mu),
            Cell::text(format!(
                "{} %",
                crate::money::format_amount(d.rate_bp, 2, true)
            )),
            d.next_payment
                .as_ref()
                .map_or(Cell::Empty, |n| Cell::Date(n.due_date.clone())),
            d.next_payment
                .as_ref()
                .map_or(Cell::Empty, |n| Cell::Money(n.payment, mu)),
            Cell::text(match (d.status.as_str(), d.overdue_count) {
                ("closed", _) => "погашен".to_string(),
                (_, 0) => "активен".to_string(),
                (_, n) => format!("просрочено платежей: {n}"),
            }),
        ]);
    }
    Ok(sh)
}

/// Сводка за период: 6 листов, как в плане функций и диалоге выгрузки.
pub fn summary_workbook(
    conn: &Connection,
    from: &str,
    to: &str,
    today: &str,
) -> Result<Vec<Sheet>> {
    crate::time::check_date(from)?;
    crate::time::check_date(to)?;
    if to < from {
        return invalid("конец периода раньше начала");
    }
    Ok(vec![
        summary_sheet(conn, from, to, today)?,
        categories_sheet(conn, from, to)?,
        budget_sheet(conn, from, to, today)?,
        months_sheet(conn, from, to)?,
        debts_sheet(conn, today)?,
        transactions_sheet(
            conn,
            &Filter {
                date_from: Some(from.into()),
                date_to: Some(to.into()),
                ..Default::default()
            },
        )?,
    ])
}

/// Открытый отчёт одним листом: `categories` (расходы и доходы) или `months`.
pub fn report_sheet(conn: &Connection, report: &str, from: &str, to: &str) -> Result<Sheet> {
    match report {
        "categories" => categories_sheet(conn, from, to),
        "months" => months_sheet(conn, from, to),
        _ => invalid(format!("неизвестный отчёт: {report}")),
    }
}

fn ru_date(d: &str) -> String {
    match (d.get(0..4), d.get(5..7), d.get(8..10)) {
        (Some(y), Some(m), Some(day)) => format!("{day}.{m}.{y}"),
        _ => d.to_string(),
    }
}

/// Сравнение двух периодов одним листом: позиции, суммы в обоих периодах, изменение в деньгах и в %.
#[allow(clippy::too_many_arguments)]
pub fn comparison_sheet(
    conn: &Connection,
    kind: &str,
    by: &str,
    a_from: &str,
    a_to: &str,
    b_from: &str,
    b_to: &str,
) -> Result<Sheet> {
    let c = crate::compare::compare(conn, kind, by, a_from, a_to, b_from, b_to)?;
    let mu = currencies::minor_units(conn, &c.base_currency)?;
    let first = match by {
        "payee" => "Получатель",
        "account" => "Счёт",
        _ => "Категория",
    };
    let a = format!("Период 1: {} – {}", ru_date(a_from), ru_date(a_to));
    let b = format!("Период 2: {} – {}", ru_date(b_from), ru_date(b_to));
    let mut sh = Sheet::new(
        if kind == "income" {
            "Сравнение доходов"
        } else {
            "Сравнение расходов"
        },
        &[
            first,
            "Подкатегория",
            &a,
            &b,
            "Изменение",
            "Изменение, %",
            "Где есть",
        ],
    );
    let presence = |p: &str| match p {
        "onlyA" => "только в периоде 1",
        "onlyB" => "только в периоде 2",
        _ => "в обоих",
    };
    let line = |name: &str, sub: Cell, r: &crate::compare::CompareRow| {
        vec![
            Cell::text(name),
            sub,
            Cell::Money(r.a, mu),
            Cell::Money(r.b, mu),
            Cell::Money(r.diff, mu),
            Cell::Percent(r.percent),
            Cell::text(presence(r.presence)),
        ]
    };
    for r in &c.rows {
        sh.rows.push(line(&r.name, Cell::Empty, r));
        for ch in &r.children {
            sh.rows.push(line(&r.name, Cell::text(&ch.name), ch));
        }
    }
    sh.rows.push(vec![
        Cell::text("Итого"),
        Cell::Empty,
        Cell::Money(c.total_a, mu),
        Cell::Money(c.total_b, mu),
        Cell::Money(c.diff, mu),
        Cell::Percent(c.percent),
        Cell::Empty,
    ]);
    Ok(sh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::categories;
    use crate::storage::Storage;
    use crate::transactions::TxnInput;
    use calamine::{open_workbook, Data, Reader, Xlsx};

    fn setup() -> Storage {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 10_000_000)).unwrap();
        let cat = |n: &str| -> String {
            c.query_row(
                "SELECT id FROM categories WHERE name = ?1 AND kind = 'expense'",
                [n],
                |r| r.get(0),
            )
            .unwrap()
        };
        let salary: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Зарплата'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let t =
            |kind: &str, date: &str, amount: i64, category: String, payee: Option<&str>| TxnInput {
                kind: kind.into(),
                date: date.into(),
                account_id: card.clone(),
                amount,
                category_id: Some(category),
                to_account_id: None,
                to_amount: None,
                payee: payee.map(str::to_string),
                note: None,
            };
        transactions::create(
            c,
            &t("income", "2026-10-01", 8_500_000, salary, Some("Работа")),
        )
        .unwrap();
        transactions::create(
            c,
            &t(
                "expense",
                "2026-10-05",
                234_050,
                cat("Продукты"),
                Some("Пятёрочка; у дома"),
            ),
        )
        .unwrap();
        transactions::create(c, &t("expense", "2026-10-07", 623_000, cat("ЖКХ"), None)).unwrap();
        transactions::create(
            c,
            &t("expense", "2026-11-02", 100_000, cat("Продукты"), None),
        )
        .unwrap();
        db
    }

    #[test]
    fn summary_has_six_sheets_with_numbers_that_read_back() {
        let db = setup();
        let c = db.conn();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Сводка.xlsx");
        write_xlsx(
            &path,
            &summary_workbook(c, "2026-10-01", "2026-10-31", "2026-11-05").unwrap(),
        )
        .unwrap();
        assert!(!dir.path().join("Сводка.xlsx.part").exists());

        let mut wb: Xlsx<_> = open_workbook(&path).unwrap();
        assert_eq!(
            wb.sheet_names(),
            [
                "Сводка",
                "По категориям",
                "Бюджет",
                "По месяцам",
                "Долги",
                "Операции"
            ]
        );
        let summary = wb.worksheet_range("Сводка").unwrap();
        let find = |label: &str| {
            summary
                .rows()
                .find(|r| r.first().is_some_and(|c| *c == label))
                .map(|r| r[1].clone())
                .unwrap()
        };
        // Суммы — числа, а не текст.
        assert_eq!(find("Доходы"), Data::Float(85_000.0));
        assert_eq!(find("Расходы"), Data::Float(8_570.5));
        assert_eq!(find("Сальдо"), Data::Float(76_429.5));
        assert_eq!(find("Норма сбережений"), Data::Float(0.9));

        let ops = wb.worksheet_range("Операции").unwrap();
        let rows: Vec<_> = ops.rows().collect();
        assert_eq!(rows.len(), 4, "заголовок и 3 операции октября");
        assert_eq!(rows[0][0].to_string(), "Дата");
        // Дата — настоящая дата Excel, расход со знаком минус.
        assert!(matches!(rows[2][0], Data::DateTime(_)), "{:?}", rows[2][0]);
        assert_eq!(rows[2][6], Data::Float(-2340.5));
        assert_eq!(rows[2][4].to_string(), "Пятёрочка; у дома");

        let cats = wb.worksheet_range("По категориям").unwrap();
        let housing: Vec<_> = cats.rows().filter(|r| r[1] == "Жильё").collect();
        assert_eq!(housing[0][3], Data::Float(6230.0));
        assert_eq!(housing[1][2].to_string(), "ЖКХ");
        let months = wb.worksheet_range("По месяцам").unwrap();
        assert_eq!(months.rows().nth(1).unwrap()[0].to_string(), "2026-10");
    }

    #[test]
    fn csv_is_utf8_with_bom_semicolons_and_decimal_comma() {
        let db = setup();
        let c = db.conn();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ops.csv");
        let sheet = transactions_sheet(
            c,
            &Filter {
                date_from: Some("2026-10-01".into()),
                date_to: Some("2026-10-31".into()),
                ..Default::default()
            },
        )
        .unwrap();
        write_one(&path, &sheet).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert!(lines[0].starts_with("Дата;Тип;Счёт;Категория"));
        assert!(
            lines.contains(
                &"05.10.2026;Расход;Карта;Продукты;\"Пятёрочка; у дома\";;-2340,50;RUB;-2340,50;;"
            ),
            "{text}"
        );
        assert!(write_one(&dir.path().join("x.txt"), &sheet).is_err());
    }

    #[test]
    fn report_and_filtered_list_export() {
        let db = setup();
        let c = db.conn();
        let s = report_sheet(c, "months", "2026-10-01", "2026-11-30").unwrap();
        assert_eq!(s.rows.len(), 3);
        assert_eq!(s.rows[2][4], Cell::Money(957_050, 2));
        let only_food = transactions_sheet(
            c,
            &Filter {
                search: Some("Пятёрочка".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_food.rows.len(), 1);
        assert!(report_sheet(c, "nope", "2026-10-01", "2026-10-31").is_err());
        assert!(summary_workbook(c, "2026-10-31", "2026-10-01", "2026-11-01").is_err());
    }

    #[test]
    fn comparison_sheet_reads_back_as_numbers() {
        let db = setup();
        let c = db.conn();
        let sh = comparison_sheet(
            c,
            "expense",
            "category",
            "2026-10-01",
            "2026-10-31",
            "2026-11-01",
            "2026-11-30",
        )
        .unwrap();
        assert_eq!(sh.name, "Сравнение расходов");
        assert_eq!(sh.headers[2], "Период 1: 01.10.2026 – 31.10.2026");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Сравнение.xlsx");
        write_one(&path, &sh).unwrap();
        let mut wb: Xlsx<_> = open_workbook(&path).unwrap();
        let range = wb.worksheet_range("Сравнение расходов").unwrap();
        let row = |name: &str| {
            range
                .rows()
                .find(|r| r[0] == Data::String(name.into()) && r[1] == Data::Empty)
                .unwrap()
                .to_vec()
        };
        let food = row("Продукты");
        assert_eq!(
            &food[2..6],
            [
                Data::Float(2340.5),
                Data::Float(1000.0),
                Data::Float(-1340.5),
                Data::Float(-0.57)
            ]
        );
        assert_eq!(food[6], Data::String("в обоих".into()));
        let home = row("Жильё");
        assert_eq!(home[6], Data::String("только в периоде 1".into()));
        let total = row("Итого");
        assert_eq!(
            &total[2..5],
            [
                Data::Float(8570.5),
                Data::Float(1000.0),
                Data::Float(-7570.5)
            ]
        );
    }

    #[test]
    fn csv_values() {
        assert_eq!(csv_value(&Cell::Money(-5, 2)), "-0,05");
        assert_eq!(csv_value(&Cell::Money(100_000, 0)), "100000");
        assert_eq!(csv_value(&Cell::Date("2026-03-01".into())), "01.03.2026");
        assert_eq!(csv_value(&Cell::Percent(None)), "");
    }
}
