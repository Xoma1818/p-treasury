//! Выгрузка графика займа: Excel и PDF для подписи. Источник — [`ScheduleDoc`]:
//! его собирает ядро по займу (`debts::schedule_doc`) или по расчёту
//! калькулятора без записи ([`calc_schedule_doc`]); перед выгрузкой интерфейс
//! может поправить ФИО сторон и признак «с подписями».

use std::fs;
use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::export::{self, Cell, Sheet};
use crate::loan_calc::{
    self, CalcInput, HolidayInput, RateChangeInput, RowKind, Sim, Status, Totals,
};
use crate::money::format_amount;
use crate::pdf::{Align, Pdf, A4_HEIGHT, A4_WIDTH};
use crate::{currencies, settings, Result};

/// Условия займа в документе.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTerms {
    pub principal: i64,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub rate_bp: i64,
    #[serde(default)]
    pub rate_changes: Vec<RateChangeInput>,
    #[serde(default)]
    pub holidays: Vec<HolidayInput>,
    pub term_months: Option<u32>,
    /// `annuity`, `differentiated`, `bullet`.
    pub repayment_type: String,
    /// `daily` или `monthly`.
    pub interest_method: String,
    /// `year`, `month` или `day`; пусто — годовая.
    #[serde(default)]
    pub rate_period: String,
    /// `month`, `quarter` или `two_weeks`; пусто — каждый месяц.
    #[serde(default)]
    pub pay_every: String,
    pub issue_date: String,
    pub first_payment_date: Option<String>,
}

/// Строка графика в документе. Досрочные платежи — строки без номера.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRow {
    pub seq: Option<u32>,
    pub date: String,
    pub payment: i64,
    pub interest: i64,
    pub principal: i64,
    pub balance: i64,
    pub paid: bool,
    /// «Досрочно», «Плановая досрочка», «Каникулы», «После каникул».
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTotals {
    pub total_payment: i64,
    /// Переплата: все проценты.
    pub overpayment: i64,
    pub maturity_date: String,
}

/// Документ «График платежей» для Excel и PDF.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDoc {
    pub title: String,
    /// ФИО займодавца.
    pub lender_name: String,
    /// ФИО заёмщика.
    pub borrower_name: String,
    pub terms: DocTerms,
    pub rows: Vec<DocRow>,
    pub totals: DocTotals,
    /// Строки «Займодавец ____ / ФИО /» и «Заёмщик ____ / ФИО /».
    pub with_signatures: bool,
    /// Дата составления, `YYYY-MM-DD`.
    pub created_on: String,
}

/// Строки документа из расчёта: строки графика и досрочки по дате.
pub fn doc_rows(sim: &Sim) -> Vec<DocRow> {
    let mut rows: Vec<DocRow> = sim
        .rows
        .iter()
        .map(|r| DocRow {
            seq: Some(r.row.seq),
            date: r.row.due_date.clone(),
            payment: r.row.payment,
            interest: r.row.interest_part,
            principal: r.row.principal_part,
            balance: r.row.balance_after,
            paid: r.status != Status::Pending,
            note: match (r.kind, r.status) {
                (_, Status::Partial) => Some("Оплачено частично".into()),
                (RowKind::InterestOnly, _) => Some("Каникулы".into()),
                (RowKind::AfterShift, _) => Some("После каникул".into()),
                _ => None,
            },
        })
        .collect();
    for e in &sim.early {
        let at = rows
            .iter()
            .position(|r| r.date > e.date)
            .unwrap_or(rows.len());
        rows.insert(
            at,
            DocRow {
                seq: None,
                date: e.date.clone(),
                payment: e.principal + e.interest,
                interest: e.interest,
                principal: e.principal,
                balance: e.balance_after,
                paid: !e.planned,
                note: Some(if e.planned {
                    "Плановая досрочка".into()
                } else {
                    "Досрочно".into()
                }),
            },
        );
    }
    rows
}

pub fn doc_totals(t: &Totals) -> DocTotals {
    DocTotals {
        total_payment: t.total_payment,
        overpayment: t.total_interest,
        maturity_date: t.maturity_date.clone(),
    }
}

/// ФИО «моей» стороны из настроек (запоминается в PDF-диалоге).
pub fn my_name(conn: &Connection) -> Result<String> {
    Ok(settings::get(conn, "loan_lender_name")?.unwrap_or_default())
}

/// Документ по расчёту калькулятора без записи.
pub fn calc_schedule_doc(
    conn: &Connection,
    input: &CalcInput,
    currency_code: &str,
    today: &str,
) -> Result<ScheduleDoc> {
    let cur = currencies::get(conn, currency_code)?;
    let loan = input.solved()?;
    let t = loan_calc::Terms::from_input(&loan)?;
    let mut events = input.events(&t)?;
    let base = loan_calc::simulate(&t, &events);
    let until = loan_calc::parse_date(&base.totals().maturity_date)?;
    let planned = loan_calc::expand_planned(&input.planned_early, t.issue, until)?;
    let sim = if planned.is_empty() {
        base
    } else {
        events.extend(planned);
        loan_calc::simulate(&t, &events)
    };
    Ok(ScheduleDoc {
        title: "График платежей (расчёт)".into(),
        lender_name: my_name(conn)?,
        borrower_name: String::new(),
        terms: DocTerms {
            principal: t.principal,
            currency_code: cur.code.clone(),
            currency_symbol: cur.symbol.clone(),
            minor_units: cur.minor_units,
            rate_bp: t.rate_bp,
            rate_changes: input.rate_changes.clone(),
            holidays: input.holidays.clone(),
            term_months: (t.repayment != loan_calc::Repayment::Bullet).then_some(t.n),
            repayment_type: t.repayment.as_str().into(),
            interest_method: t.method.as_str().into(),
            rate_period: t.rate_period.as_str().into(),
            pay_every: t.every.as_str().into(),
            issue_date: t.issue.to_string(),
            first_payment_date: Some(t.first.to_string()),
        },
        rows: doc_rows(&sim),
        totals: doc_totals(&sim.totals()),
        with_signatures: true,
        created_on: today.to_string(),
    })
}

// --- Подписи и форматы ---

pub fn ru_date(d: &str) -> String {
    match (d.get(0..4), d.get(5..7), d.get(8..10)) {
        (Some(y), Some(m), Some(day)) if d.len() == 10 => format!("{day}.{m}.{y}"),
        _ => d.to_string(),
    }
}

/// Ставка в процентах: 1250 → «12,5 %».
pub fn rate_text(bp: i64) -> String {
    let int = bp / 100;
    let frac = bp % 100;
    if frac == 0 {
        format!("{int} %")
    } else if frac % 10 == 0 {
        format!("{int},{} %", frac / 10)
    } else {
        format!("{int},{frac:02} %")
    }
}

/// Ставка за свой период: «18 % годовых», «1,5 % в месяц», «0,5 % в день».
/// `bp` — годовая ставка; за период — с точностью до сотых долей процента.
pub fn rate_in(bp: i64, period: loan_calc::RatePeriod) -> String {
    let per = period.per_year();
    let v = (2 * bp + per) / (2 * per);
    format!("{} {}", rate_text(v), period.suffix())
}

fn period_of(s: &str) -> loan_calc::RatePeriod {
    loan_calc::RatePeriod::parse(s).unwrap_or_default()
}

fn method_title(m: &str) -> &'static str {
    loan_calc::InterestMethod::parse(m).map_or("", |m| m.title())
}

fn repayment_title(r: &str) -> &'static str {
    loan_calc::Repayment::parse(r).map_or("", |r| r.title())
}

fn holiday_title(h: &HolidayInput) -> String {
    let kind = if h.kind == "shift" {
        "сдвиг платежей"
    } else {
        "только проценты"
    };
    format!("{} мес. с платежа №{}, {kind}", h.months, h.from_seq)
}

/// Строки «условия» документа: подпись и значение.
fn terms_lines(doc: &ScheduleDoc, symbol: &str) -> Vec<(String, String)> {
    let t = &doc.terms;
    let m = |v: i64| format!("{} {symbol}", format_amount(v, t.minor_units, false));
    let mut out = vec![
        ("Сумма займа".into(), m(t.principal)),
        (
            "Ставка".into(),
            rate_in(t.rate_bp, period_of(&t.rate_period)),
        ),
    ];
    for r in &t.rate_changes {
        out.push((
            String::new(),
            format!(
                "с {} — {}",
                ru_date(&r.from),
                rate_in(r.rate_bp, period_of(&t.rate_period))
            ),
        ));
    }
    let every = loan_calc::PayEvery::parse(&t.pay_every).unwrap_or_default();
    if let Some(n) = t.term_months {
        if every == loan_calc::PayEvery::Month {
            out.push(("Срок".into(), format!("{n} мес.")));
        } else {
            out.push(("Срок".into(), format!("{n} платежей, {}", every.title())));
        }
    }
    out.push((
        "Тип платежей".into(),
        repayment_title(&t.repayment_type).into(),
    ));
    out.push(("Проценты".into(), method_title(&t.interest_method).into()));
    out.push(("Дата выдачи".into(), ru_date(&t.issue_date)));
    if t.repayment_type != "bullet" {
        if let Some(f) = &t.first_payment_date {
            out.push(("Первый платёж".into(), ru_date(f)));
        }
    }
    for h in &t.holidays {
        out.push(("Каникулы".into(), holiday_title(h)));
    }
    out
}

// --- Excel ---

/// Записать график в `.xlsx`: лист «График» и лист «Условия».
pub fn export_schedule_xlsx(path: &Path, doc: &ScheduleDoc) -> Result<()> {
    let mu = doc.terms.minor_units;
    let mut graph = Sheet {
        name: "График".into(),
        headers: [
            "№",
            "Дата",
            "Платёж",
            "Проценты",
            "Основной долг",
            "Остаток",
            "Оплачено",
            "Примечание",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        rows: Vec::with_capacity(doc.rows.len() + 4),
    };
    for r in &doc.rows {
        graph.rows.push(vec![
            r.seq.map_or(Cell::Empty, |s| Cell::Int(s as i64)),
            Cell::Date(r.date.clone()),
            Cell::Money(r.payment, mu),
            Cell::Money(r.interest, mu),
            Cell::Money(r.principal, mu),
            Cell::Money(r.balance, mu),
            Cell::Text(if r.paid { "да".into() } else { String::new() }),
            r.note.clone().map_or(Cell::Empty, Cell::Text),
        ]);
    }
    graph.rows.push(vec![]);
    graph.rows.push(vec![
        Cell::Empty,
        Cell::Text("Всего выплат".into()),
        Cell::Money(doc.totals.total_payment, mu),
    ]);
    graph.rows.push(vec![
        Cell::Empty,
        Cell::Text("Переплата".into()),
        Cell::Money(doc.totals.overpayment, mu),
    ]);
    graph.rows.push(vec![
        Cell::Empty,
        Cell::Text("Дата закрытия".into()),
        if doc.totals.maturity_date.is_empty() {
            Cell::Empty
        } else {
            Cell::Date(doc.totals.maturity_date.clone())
        },
    ]);

    let mut terms = Sheet {
        name: "Условия".into(),
        headers: vec![],
        rows: vec![vec![Cell::Text(doc.title.clone())], vec![]],
    };
    terms.rows.push(vec![
        Cell::Text("Займодавец".into()),
        Cell::Text(doc.lender_name.clone()),
    ]);
    terms.rows.push(vec![
        Cell::Text("Заёмщик".into()),
        Cell::Text(doc.borrower_name.clone()),
    ]);
    for (k, v) in terms_lines(doc, &doc.terms.currency_code) {
        terms.rows.push(vec![Cell::Text(k), Cell::Text(v)]);
    }
    terms.rows.push(vec![
        Cell::Text("Дата составления".into()),
        Cell::Date(doc.created_on.clone()),
    ]);
    export::write_xlsx(path, &[graph, terms])
}

// --- PDF ---

const MARGIN: f32 = 42.0;
const ROW_H: f32 = 13.0;
const TABLE_SIZE: f32 = 8.5;
/// Колонки таблицы: подпись и ширина в пунктах (вместе 511).
const COLUMNS: [(&str, f32); 7] = [
    ("№", 28.0),
    ("Дата", 60.0),
    ("Платёж", 82.0),
    ("Проценты", 78.0),
    ("Основной долг", 84.0),
    ("Остаток", 92.0),
    ("Отметка", 87.0),
];

struct Layout {
    pdf: Pdf,
    y: f32,
    symbol: String,
}

impl Layout {
    fn bottom(&self) -> f32 {
        A4_HEIGHT - MARGIN - 18.0
    }

    fn table_header(&mut self) {
        let x0 = MARGIN;
        let width: f32 = COLUMNS.iter().map(|c| c.1).sum();
        self.pdf.fill(x0, self.y, width, ROW_H + 4.0, 0.9);
        let mut x = x0;
        for (title, w) in COLUMNS {
            self.pdf.text(
                x + w / 2.0,
                self.y + ROW_H - 1.0,
                TABLE_SIZE,
                Align::Center,
                title,
            );
            x += w;
        }
        self.y += ROW_H + 4.0;
        self.pdf.line(x0, self.y, x0 + width, self.y, 0.6);
    }

    fn new_page(&mut self, with_header: bool) {
        self.pdf.add_page();
        self.y = MARGIN;
        if with_header {
            self.table_header();
        }
    }

    fn row(&mut self, cells: [String; 7]) {
        if self.y + ROW_H > self.bottom() {
            self.new_page(true);
        }
        let mut x = MARGIN;
        let base = self.y + ROW_H - 3.5;
        for (i, (text, (_, w))) in cells.iter().zip(COLUMNS).enumerate() {
            match i {
                0 | 1 | 6 => self
                    .pdf
                    .text(x + w / 2.0, base, TABLE_SIZE, Align::Center, text),
                _ => self
                    .pdf
                    .text(x + w - 4.0, base, TABLE_SIZE, Align::Right, text),
            }
            x += w;
        }
        self.y += ROW_H;
        let width: f32 = COLUMNS.iter().map(|c| c.1).sum();
        self.pdf.line(MARGIN, self.y, MARGIN + width, self.y, 0.2);
    }

    /// Строка вне таблицы; переносится на новую страницу, если не помещается.
    fn line(&mut self, size: f32, text: &str) {
        if self.y + size * 1.6 > self.bottom() {
            self.new_page(false);
        }
        self.y += size * 1.6;
        self.pdf.text(MARGIN, self.y, size, Align::Left, text);
    }
}

/// Создать PDF графика (A4, шапка таблицы на каждой странице, подписи внизу).
pub fn schedule_pdf(doc: &ScheduleDoc) -> Result<Vec<u8>> {
    let mut l = Layout {
        pdf: Pdf::new(&doc.title),
        y: MARGIN,
        symbol: String::new(),
    };
    // Знак валюты, если его нет в шрифте, заменяется кодом валюты.
    l.symbol = if doc.terms.currency_symbol.chars().all(|c| l.pdf.has_char(c)) {
        doc.terms.currency_symbol.clone()
    } else {
        doc.terms.currency_code.clone()
    };
    let mu = doc.terms.minor_units;
    let money = |v: i64| format_amount(v, mu, false);
    l.pdf.add_page();
    l.pdf
        .text(A4_WIDTH / 2.0, l.y + 14.0, 14.0, Align::Center, &doc.title);
    l.y += 22.0;
    let side = |name: &str| {
        if name.trim().is_empty() {
            "________________________".to_string()
        } else {
            name.trim().to_string()
        }
    };
    l.line(10.0, &format!("Займодавец: {}", side(&doc.lender_name)));
    l.line(10.0, &format!("Заёмщик: {}", side(&doc.borrower_name)));
    l.y += 4.0;
    let symbol = l.symbol.clone();
    for (k, v) in terms_lines(doc, &symbol) {
        let text = if k.is_empty() {
            format!("    {v}")
        } else {
            format!("{k}: {v}")
        };
        l.line(9.0, &text);
    }
    l.y += 10.0;
    l.table_header();
    for r in &doc.rows {
        let mark = match (r.paid, r.note.as_deref()) {
            (true, Some(n)) => format!("оплачено, {}", n.to_lowercase()),
            (true, None) => "оплачено".into(),
            (false, Some(n)) => n.to_string(),
            (false, None) => String::new(),
        };
        l.row([
            r.seq.map_or("—".into(), |s| s.to_string()),
            ru_date(&r.date),
            money(r.payment),
            money(r.interest),
            money(r.principal),
            money(r.balance),
            mark,
        ]);
    }
    l.y += 6.0;
    l.line(
        9.5,
        &format!("Всего выплат: {} {symbol}", money(doc.totals.total_payment)),
    );
    l.line(
        9.5,
        &format!(
            "Переплата (проценты): {} {symbol}",
            money(doc.totals.overpayment)
        ),
    );
    if !doc.totals.maturity_date.is_empty() {
        l.line(
            9.5,
            &format!("Дата закрытия: {}", ru_date(&doc.totals.maturity_date)),
        );
    }
    l.y += 8.0;
    l.line(
        9.5,
        &format!("Дата составления: {}", ru_date(&doc.created_on)),
    );
    if doc.with_signatures {
        // Обе подписи на одной странице.
        if l.y + 70.0 > l.bottom() {
            l.new_page(false);
        }
        l.y += 20.0;
        l.line(
            10.0,
            &format!(
                "Займодавец ____________________ / {} /",
                side(&doc.lender_name)
            ),
        );
        l.y += 14.0;
        l.line(
            10.0,
            &format!(
                "Заёмщик ____________________ / {} /",
                side(&doc.borrower_name)
            ),
        );
    }
    let pages = l.pdf.page_count();
    for p in 0..pages {
        l.pdf.text_on(
            p,
            A4_WIDTH / 2.0,
            A4_HEIGHT - MARGIN + 10.0,
            8.0,
            Align::Center,
            &format!("Стр. {} из {pages}", p + 1),
        );
    }
    l.pdf.to_bytes()
}

/// Записать PDF графика. Пишется во временный файл и переименовывается.
pub fn export_schedule_pdf(path: &Path, doc: &ScheduleDoc) -> Result<()> {
    let bytes = schedule_pdf(doc)?;
    let tmp = path.with_extension("pdf.part");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_doc(rows: u32) -> ScheduleDoc {
        let input = loan_calc::LoanInput {
            principal: 1_200_000_000,
            rate_bp: 1050,
            repayment: loan_calc::Repayment::Annuity,
            term_months: Some(rows),
            issue_date: "2026-10-15".into(),
            first_payment_date: Some("2026-11-15".into()),
            maturity_date: None,
            interest_method: loan_calc::InterestMethod::Daily,
            rate_period: loan_calc::RatePeriod::Year,
            pay_every: loan_calc::PayEvery::Month,
        };
        let t = loan_calc::Terms::from_input(&input).unwrap();
        let sim = loan_calc::simulate(&t, &[]);
        ScheduleDoc {
            title: "График платежей: ипотека".into(),
            lender_name: "Петров Пётр Петрович".into(),
            borrower_name: "Иванова Анна Сергеевна".into(),
            terms: DocTerms {
                principal: t.principal,
                currency_code: "RUB".into(),
                currency_symbol: "₽".into(),
                minor_units: 2,
                rate_bp: 1050,
                rate_changes: vec![RateChangeInput {
                    from: "2030-01-01".into(),
                    rate_bp: 900,
                }],
                holidays: vec![],
                term_months: Some(rows),
                repayment_type: "annuity".into(),
                interest_method: "daily".into(),
                rate_period: String::new(),
                pay_every: String::new(),
                issue_date: "2026-10-15".into(),
                first_payment_date: Some("2026-11-15".into()),
            },
            rows: doc_rows(&sim),
            totals: doc_totals(&sim.totals()),
            with_signatures: true,
            created_on: "2026-10-22".into(),
        }
    }

    #[test]
    fn long_schedule_pdf_has_cyrillic_header_on_every_page_and_signatures() {
        let doc = long_doc(360);
        let bytes = schedule_pdf(&doc).unwrap();
        assert!(bytes.starts_with(b"%PDF-1.7"));
        // Подмножество шрифта: файл намного меньше самого шрифта (680 КБ).
        assert!(bytes.len() < 200_000, "размер PDF {}", bytes.len());
        let pdf = lopdf::Document::load_mem(&bytes).unwrap();
        let pages = pdf.get_pages();
        assert!(pages.len() >= 7, "страниц {}", pages.len());
        for id in pages.values() {
            let page = pdf.get_dictionary(*id).unwrap();
            let mb = page.get(b"MediaBox").unwrap().as_array().unwrap();
            let h = mb[3].as_float().unwrap();
            assert!((h - 841.89).abs() < 0.1, "A4");
        }
        let text = pdf_extract::extract_text_from_mem(&bytes).unwrap();
        let squash = |s: &str| s.split_whitespace().collect::<String>();
        let flat = squash(&text);
        for needle in [
            "Графикплатежей",
            "Займодавец",
            "Заёмщик",
            "ПетровПётрПетрович",
            "ИвановаАннаСергеевна",
            "Основнойдолг",
            "Датасоставления:22.10.2026",
            "Стр.1из",
            "с01.01.2030—9%",
        ] {
            assert!(flat.contains(needle), "нет «{needle}» в тексте PDF");
        }
        // Шапка таблицы повторяется на каждой странице.
        let headers = flat.matches("Основнойдолг").count();
        assert_eq!(headers, pages.len(), "шапка на каждой странице");
        // Последняя строка графика и подписи.
        assert!(flat.contains("360"));
        assert!(flat.contains(&squash(&format!(
            "Займодавец ____________________ / {} /",
            doc.lender_name
        ))));
        assert!(flat.contains(&squash(&format!(
            "Заёмщик ____________________ / {} /",
            doc.borrower_name
        ))));
    }

    #[test]
    fn excel_schedule_opens() {
        use calamine::{open_workbook, Reader, Xlsx};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("график.xlsx");
        let doc = long_doc(24);
        export_schedule_xlsx(&path, &doc).unwrap();
        let mut wb: Xlsx<_> = open_workbook(&path).unwrap();
        assert_eq!(wb.sheet_names(), ["График", "Условия"]);
        let graph = wb.worksheet_range("График").unwrap();
        assert_eq!(graph.height(), 1 + 24 + 4);
        let terms = wb.worksheet_range("Условия").unwrap();
        let all: Vec<String> = terms.rows().flatten().map(|c| c.to_string()).collect();
        assert!(all.iter().any(|c| c == "Петров Пётр Петрович"));
        assert!(all.iter().any(|c| c == "по дням"));

        let pdf = dir.path().join("график.pdf");
        export_schedule_pdf(&pdf, &doc).unwrap();
        assert!(fs::read(&pdf).unwrap().starts_with(b"%PDF"));
    }

    #[test]
    fn rates_and_dates_for_people() {
        assert_eq!(rate_text(1200), "12 %");
        assert_eq!(rate_text(1250), "12,5 %");
        assert_eq!(rate_text(1255), "12,55 %");
        assert_eq!(ru_date("2027-03-01"), "01.03.2027");
    }
}
