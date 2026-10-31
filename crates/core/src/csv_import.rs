//! Импорт операций из CSV по шаблону приложения (те же столбцы, что в
//! выгрузке операций): сначала предпросмотр с ошибками по строкам, затем
//! загрузка правильных строк одной транзакцией.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::invalid;
use crate::export::{write_csv, Sheet, TXN_HEADERS};
use crate::transactions::TxnInput;
use crate::{bank_import, import_log, money, Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// Номер строки в файле (заголовок — строка 1).
    pub line: usize,
    pub date: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub account: String,
    pub amount: String,
    pub category: String,
    pub payee: String,
    /// Что не так; `None` — строка будет загружена.
    pub error: Option<String>,
    /// Такая операция уже есть (выписка банка за пересекающийся период): пропускается.
    pub duplicate: bool,
    /// Строка свяжется с записанной вручную операцией: «19.10 · Продукты».
    pub linked_to: Option<String>,
    /// Возможных совпадений, которые попросят подтверждения.
    pub maybe: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub rows: Vec<Row>,
    pub valid: usize,
    pub errors: usize,
    /// Строки, которые уже загружены раньше: пропускаются.
    pub duplicates: usize,
    /// Строки, которые сами свяжутся с ручными записями.
    pub linked: usize,
    /// Строки с возможными совпадениями на подтверждение.
    pub doubtful: usize,
    /// Выписка банка («Сбер», «Т-Банк»); `None` — CSV по шаблону.
    pub bank: Option<String>,
    /// Счёт, на который пойдёт выписка банка (выбранный или запомненный).
    pub account_id: Option<String>,
}

pub(crate) struct Parsed {
    pub(crate) row: Row,
    pub(crate) input: Option<TxnInput>,
    /// Текст получателя из выписки банка до правил (ключ повтора, B3).
    pub(crate) raw_payee: Option<String>,
}

fn read_text(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        Error::Validation("файл не в кодировке UTF-8: сохраните его как «CSV UTF-8»".into())
    })
}

/// Дата `ДД.ММ.ГГГГ` или `ГГГГ-ММ-ДД` → `ГГГГ-ММ-ДД`.
pub fn parse_date(s: &str) -> Option<String> {
    let s = s.trim();
    // Год только четырьмя цифрами: «08.10.26» иначе стало бы 26-м годом нашей эры.
    let year_ok = s.rsplit('.').next().is_some_and(|y| y.len() == 4)
        || s.split('-').next().is_some_and(|y| y.len() == 4);
    if !year_ok {
        return None;
    }
    ["%d.%m.%Y", "%Y-%m-%d"]
        .iter()
        .find_map(|f| chrono::NaiveDate::parse_from_str(s, f).ok())
        .map(|d| d.to_string())
}

struct Lookup {
    /// имя счёта в нижнем регистре → (id, знаки после запятой)
    accounts: HashMap<String, (String, u32)>,
    /// (вид, «родитель → подкатегория» или имя) в нижнем регистре → id; `None` — имя неоднозначно
    categories: HashMap<(String, String), Option<String>>,
}

fn lookup(conn: &Connection) -> Result<Lookup> {
    let mut accounts = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, c.minor_units FROM accounts a JOIN currencies c ON c.code = a.currency_code
         WHERE a.type <> 'debt'",
    )?;
    for r in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u32>(2)?,
        ))
    })? {
        let (id, name, mu) = r?;
        accounts.insert(name.trim().to_lowercase(), (id, mu));
    }
    let mut categories: HashMap<(String, String), Option<String>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.kind, c.name, p.name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
         WHERE c.archived_at IS NULL",
    )?;
    for r in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })? {
        let (id, kind, name, parent) = r?;
        let short = name.to_lowercase();
        if let Some(p) = &parent {
            categories.insert(
                (kind.clone(), format!("{} → {}", p.to_lowercase(), short)),
                Some(id.clone()),
            );
            categories.insert(
                (kind.clone(), format!("{} / {}", p.to_lowercase(), short)),
                Some(id.clone()),
            );
        }
        // Одно имя у нескольких категорий (например, «Одежда» в «Дети» и отдельно) — нужен путь.
        categories
            .entry((kind, short))
            .and_modify(|v| *v = None)
            .or_insert(Some(id));
    }
    // Файлы, выгруженные до 0.28, называют категории по-старому («Продукты», «Жильё → ЖКХ»):
    // прежнее имя ведёт к категории с новым, если своей категории с прежним именем нет.
    for (kind, parent, old, new) in crate::categories::RENAMES {
        let target = categories
            .get(&(kind.to_string(), new.to_lowercase()))
            .cloned();
        if let Some(Some(id)) = target {
            categories
                .entry((kind.to_string(), old.to_lowercase()))
                .or_insert(Some(id.clone()));
            if let Some(p) = parent {
                for sep in [" → ", " / "] {
                    categories
                        .entry((
                            kind.to_string(),
                            format!("{}{sep}{}", p.to_lowercase(), old.to_lowercase()),
                        ))
                        .or_insert(Some(id.clone()));
                }
            }
        }
    }
    Ok(Lookup {
        accounts,
        categories,
    })
}

pub(crate) fn parse(conn: &Connection, path: &Path) -> Result<Vec<Parsed>> {
    let text = read_text(path)?;
    let first = text.lines().next().unwrap_or("");
    let delimiter = if first.matches(';').count() >= first.matches(',').count() {
        b';'
    } else {
        b','
    };
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(text.as_bytes());
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| Error::Validation(format!("не удалось прочитать CSV: {e}")))?
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    let col = |name: &str| headers.iter().position(|h| h == &name.to_lowercase());
    let required = ["Дата", "Тип", "Счёт", "Сумма"];
    let missing: Vec<_> = required
        .iter()
        .filter(|h| col(h).is_none())
        .copied()
        .collect();
    if !missing.is_empty() {
        return invalid(format!(
            "в файле нет столбцов: {}. Возьмите шаблон: первая строка — {}",
            missing.join(", "),
            TXN_HEADERS.join(";")
        ));
    }
    let idx = |name: &str| col(name);
    let (c_date, c_type, c_acc, c_amount) = (idx("Дата"), idx("Тип"), idx("Счёт"), idx("Сумма"));
    let (c_cat, c_payee, c_note, c_to, c_to_amount) = (
        idx("Категория"),
        idx("Получатель"),
        idx("Комментарий"),
        idx("Счёт зачисления"),
        idx("Сумма зачисления"),
    );
    let lk = lookup(conn)?;

    let mut out = Vec::new();
    for (i, rec) in rdr.records().enumerate() {
        let rec = rec.map_err(|e| Error::Validation(format!("не удалось прочитать CSV: {e}")))?;
        let get = |c: Option<usize>| c.and_then(|c| rec.get(c)).unwrap_or("").trim().to_string();
        if rec.iter().all(|f| f.trim().is_empty()) {
            continue;
        }
        let mut row = Row {
            line: i + 2,
            date: get(c_date),
            kind: get(c_type),
            account: get(c_acc),
            amount: get(c_amount),
            category: get(c_cat),
            payee: get(c_payee),
            error: None,
            duplicate: false,
            linked_to: None,
            maybe: 0,
        };
        let checked = (|| -> std::result::Result<TxnInput, String> {
            let date = parse_date(&row.date)
                .ok_or_else(|| format!("дата «{}»: нужна ДД.ММ.ГГГГ", row.date))?;
            let kind = match row.kind.to_lowercase().as_str() {
                "расход" => "expense",
                "доход" => "income",
                "перевод" => "transfer",
                _ => {
                    return Err(format!(
                        "тип «{}»: нужен Расход, Доход или Перевод",
                        row.kind
                    ))
                }
            };
            let (account_id, mu) = lk
                .accounts
                .get(&row.account.to_lowercase())
                .cloned()
                .ok_or_else(|| format!("нет счёта «{}»", row.account))?;
            let amount = money::parse_amount(&row.amount, mu)
                .map_err(|_| format!("сумма «{}»", row.amount))?
                .abs();
            if amount == 0 {
                return Err("сумма равна нулю".into());
            }
            let mut input = TxnInput {
                kind: kind.into(),
                date,
                account_id,
                amount,
                category_id: None,
                to_account_id: None,
                to_amount: None,
                payee: Some(row.payee.clone()).filter(|p| !p.is_empty()),
                note: Some(get(c_note)).filter(|n| !n.is_empty()),
            };
            if kind == "transfer" {
                let to = get(c_to);
                let (to_id, to_mu) =
                    lk.accounts
                        .get(&to.to_lowercase())
                        .cloned()
                        .ok_or_else(|| {
                            if to.is_empty() {
                                "для перевода нужен «Счёт зачисления»".to_string()
                            } else {
                                format!("нет счёта зачисления «{to}»")
                            }
                        })?;
                let to_amount = get(c_to_amount);
                if !to_amount.is_empty() {
                    input.to_amount = Some(
                        money::parse_amount(&to_amount, to_mu)
                            .map_err(|_| format!("сумма зачисления «{to_amount}»"))?
                            .abs(),
                    );
                }
                input.to_account_id = Some(to_id);
            } else {
                if row.category.is_empty() {
                    // Без категории выручают правила автокатегоризации по получателю.
                    let rule = crate::rules::find(conn, &row.payee, kind)
                        .map_err(|e| e.to_string())?
                        .ok_or("не указана категория (и нет правила для получателя)")?;
                    input.category_id = Some(rule.category_id);
                    if rule.payee.is_some() {
                        input.payee = rule.payee;
                    }
                    return Ok(input);
                }
                let key = (kind.to_string(), row.category.to_lowercase());
                input.category_id = match lk.categories.get(&key) {
                    Some(Some(id)) => Some(id.clone()),
                    Some(None) => {
                        return Err(format!(
                            "категория «{}» есть в нескольких местах: укажите «Родитель → {}»",
                            row.category, row.category
                        ))
                    }
                    None => {
                        return Err(format!(
                            "нет категории «{}» для типа «{}»",
                            row.category, row.kind
                        ))
                    }
                };
            }
            Ok(input)
        })();
        let input = match checked {
            Ok(i) => Some(i),
            Err(e) => {
                row.error = Some(e);
                None
            }
        };
        out.push(Parsed {
            row,
            input,
            raw_payee: None,
        });
    }
    if out.is_empty() {
        return invalid("в файле нет строк с операциями");
    }
    Ok(out)
}

/// Узнанная выписка банка и её операции.
type Statement = (bank_import::Bank, Vec<bank_import::Op>);

/// Выписка банка или CSV по шаблону.
fn parse_any(
    conn: &Connection,
    path: &Path,
    account_id: Option<&str>,
) -> Result<(Vec<Parsed>, Option<Statement>)> {
    if let Some((bank, ops)) = bank_import::read(path)? {
        if ops.is_empty() {
            return invalid("в выписке нет проведённых операций");
        }
        let parsed = bank_import::to_parsed(conn, bank, &ops, account_id)?;
        return Ok((parsed, Some((bank, ops))));
    }
    let is_csv = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("csv"));
    if !is_csv {
        return invalid("файл не похож на выписку Сбера (PDF) или Т-Банка (CSV, Excel)");
    }
    Ok((parse(conn, path)?, None))
}

/// Предпросмотр: каждая строка с ошибкой или без. Для выписки банка
/// `account_id` — выбранный счёт (без него — запомненный).
pub fn preview(conn: &Connection, path: &Path, account_id: Option<&str>) -> Result<Preview> {
    let (mut parsed, bank) = parse_any(conn, path, account_id)?;
    let errors = parsed.iter().filter(|p| p.row.error.is_some()).count();
    let duplicates = parsed.iter().filter(|p| p.row.duplicate).count();
    let inputs: Vec<TxnInput> = parsed.iter().filter_map(|p| p.input.clone()).collect();
    let mut marks = import_log::marks(conn, bank.is_some(), &inputs)?.into_iter();
    let (mut linked, mut doubtful) = (0, 0);
    for p in parsed.iter_mut().filter(|p| p.input.is_some()) {
        match marks.next() {
            Some(import_log::Mark::Link(what)) => {
                p.row.linked_to = Some(what);
                linked += 1;
            }
            Some(import_log::Mark::Doubt(n)) => {
                p.row.maybe = n;
                doubtful += 1;
            }
            _ => {}
        }
    }
    let account_id = match &bank {
        Some((b, _)) => account_id
            .map(str::to_string)
            .or_else(|| bank_import::remembered(conn).ok()?.get(b.key()).cloned()),
        None => None,
    };
    Ok(Preview {
        valid: parsed.iter().filter(|p| p.input.is_some()).count() - linked,
        errors,
        duplicates,
        linked,
        doubtful,
        bank: bank.map(|(b, _)| b.title().to_string()),
        account_id,
        rows: parsed.into_iter().map(|p| p.row).collect(),
    })
}

/// Загрузить правильные строки одной транзакцией. Без `skip_errors` файл с
/// ошибками не загружается вовсе; уже загруженные раньше строки выписки
/// пропускаются, а строки, похожие на записанные вручную, связываются с ними
/// (см. [`import_log`]). Импорт попадает в историю. Выбранный для выписки счёт
/// запоминается.
pub fn import(
    conn: &mut Connection,
    path: &Path,
    skip_errors: bool,
    account_id: Option<&str>,
) -> Result<import_log::Saved> {
    let (parsed, bank) = parse_any(conn, path, account_id)?;
    let errors = parsed.iter().filter(|p| p.row.error.is_some()).count();
    if errors > 0 && !skip_errors {
        return invalid(format!(
            "в файле строк с ошибками: {errors}; исправьте их или загрузите только правильные"
        ));
    }
    let skipped = parsed.iter().filter(|p| p.row.duplicate).count();
    let (inputs, raws): (Vec<TxnInput>, Vec<Option<String>>) = parsed
        .into_iter()
        .filter_map(|p| p.input.map(|i| (i, p.raw_payee)))
        .unzip();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tx = conn.transaction()?;
    let saved = import_log::save_with_raw(
        &tx,
        import_log::Origin::Manual,
        &name,
        bank.as_ref().map(|(b, _)| b.title()),
        &inputs,
        &raws,
        skipped,
    )?;
    if let (Some((bank, ops)), Some(id)) = (&bank, account_id) {
        bank_import::remember(&tx, *bank, ops, id)?;
    }
    tx.commit()?;
    Ok(saved)
}

/// Шаблон CSV: заголовок и две строки-примера.
pub fn write_template(path: &Path) -> Result<()> {
    use crate::export::Cell::{Date, Empty, Money, Text};
    let mut sheet = Sheet {
        name: "Шаблон".into(),
        headers: TXN_HEADERS.iter().map(|h| h.to_string()).collect(),
        rows: Vec::new(),
    };
    let t = |s: &str| Text(s.into());
    sheet.rows.push(vec![
        Date("2026-10-05".into()),
        t("Расход"),
        t("Карта"),
        t("Питание"),
        t("Пятёрочка"),
        Empty,
        Money(-234_050, 2),
        t("RUB"),
        Empty,
        Empty,
        Empty,
    ]);
    sheet.rows.push(vec![
        Date("2026-10-10".into()),
        t("Доход"),
        t("Карта"),
        t("Заработная плата"),
        Empty,
        Empty,
        Money(8_500_000, 2),
        t("RUB"),
        Empty,
        Empty,
        Empty,
    ]);
    sheet.rows.push(vec![
        Date("2026-10-11".into()),
        t("Перевод"),
        t("Карта"),
        Empty,
        Empty,
        t("в копилку"),
        Money(1_000_000, 2),
        t("RUB"),
        Empty,
        t("Наличные"),
        Empty,
    ]);
    write_csv(path, &sheet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::categories;
    use crate::export::{transactions_sheet, write_one};
    use crate::storage::Storage;
    use crate::transactions::Filter;

    fn setup() -> Storage {
        let db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        accounts::create(db.conn(), &input("Наличные", "cash", "RUB", 0)).unwrap();
        db
    }

    fn file(dir: &tempfile::TempDir, name: &str, text: &str) -> std::path::PathBuf {
        let p = dir.path().join(name);
        fs::write(&p, text).unwrap();
        p
    }

    /// «Переезд из таблицы»: 3 строки с ошибками в дате видны в предпросмотре;
    /// после исправления файл загружается.
    #[test]
    fn moving_from_a_spreadsheet_with_three_bad_dates() {
        let mut db = setup();
        let dir = tempfile::tempdir().unwrap();
        let text = "\u{feff}Дата;Тип;Счёт;Категория;Получатель;Комментарий;Сумма;Счёт зачисления\n\
            05.10.2026;Расход;Карта;Продукты;Пятёрочка;;-2340,50\n\
            31.09.2026;Расход;Карта;ЖКХ;;;6230\n\
            06.10.2026;Доход;карта;Зарплата;;;85 000\n\
            2026/10/07;Расход;Наличные;Кафе и рестораны;;;450\n\
            08.10.26;Расход;Карта;Такси;;;350\n\
            09.10.2026;Перевод;Карта;;;в копилку;1000;Наличные\n";
        let bad = file(&dir, "bad.csv", text);
        let p = preview(db.conn(), &bad, None).unwrap();
        assert_eq!((p.valid, p.errors), (3, 3));
        let lines: Vec<_> = p
            .rows
            .iter()
            .filter(|r| r.error.is_some())
            .map(|r| r.line)
            .collect();
        assert_eq!(lines, [3, 5, 6]);
        assert!(p.rows[1]
            .error
            .as_deref()
            .unwrap()
            .contains("дата «31.09.2026»"));
        assert!(
            import(db.conn_mut(), &bad, false, None).is_err(),
            "с ошибками без согласия не грузим"
        );

        let fixed = file(
            &dir,
            "fixed.csv",
            &text
                .replace("31.09.2026", "30.09.2026")
                .replace("2026/10/07", "07.10.2026")
                .replace("08.10.26", "08.10.2026"),
        );
        let p = preview(db.conn(), &fixed, None).unwrap();
        assert_eq!(p.errors, 0, "{:?}", p.rows);
        assert_eq!(import(db.conn_mut(), &fixed, false, None).unwrap().added, 6);
        let card: String = db
            .conn()
            .query_row(
                "SELECT id FROM accounts WHERE name = 'Карта'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // 85 000 − 2 340,50 − 6 230 − 350 − 1 000
        assert_eq!(
            accounts::balance(db.conn(), &card, None).unwrap(),
            7_507_950
        );
    }

    /// Пустая категория берётся из правила по получателю.
    #[test]
    fn empty_category_comes_from_rule() {
        let mut db = setup();
        let food: String = db
            .conn()
            .query_row(
                "SELECT id FROM categories WHERE name = 'Питание'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        crate::rules::create(
            db.conn(),
            &crate::rules::RuleInput {
                pattern: "пятерочка".into(),
                category_id: food,
                payee: Some("Пятёрочка".into()),
            },
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let f = file(
            &dir,
            "r.csv",
            "Дата;Тип;Счёт;Категория;Получатель;Сумма\n\
             05.10.2026;Расход;Карта;;PYATEROCHKA / ПЯТЁРОЧКА 1234;500\n\
             05.10.2026;Расход;Карта;;Неизвестно;100\n",
        );
        let p = preview(db.conn(), &f, None).unwrap();
        assert_eq!((p.valid, p.errors), (1, 1));
        assert!(p.rows[1].error.as_deref().unwrap().contains("нет правила"));
        assert_eq!(import(db.conn_mut(), &f, true, None).unwrap().added, 1);
        let (cat, payee): (String, String) = db
            .conn()
            .query_row(
                "SELECT c.name, t.payee FROM transactions t JOIN categories c ON c.id = t.category_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((cat.as_str(), payee.as_str()), ("Питание", "Пятёрочка"));
    }

    #[test]
    fn dates_need_four_digit_year() {
        assert_eq!(parse_date("08.10.2026").as_deref(), Some("2026-10-08"));
        assert_eq!(parse_date(" 2026-10-08 ").as_deref(), Some("2026-10-08"));
        assert_eq!(parse_date("08.10.26"), None);
        assert_eq!(parse_date("8.1.2026").as_deref(), Some("2026-01-08"));
        assert_eq!(parse_date("29.02.2027"), None);
    }

    #[test]
    fn skip_errors_loads_only_good_rows_in_one_transaction() {
        let mut db = setup();
        let dir = tempfile::tempdir().unwrap();
        let f = file(&dir, "a.csv", "Дата,Тип,Счёт,Категория,Сумма\n05.10.2026,Расход,Карта,Продукты,100\n05.10.2026,Расход,Сейф,Продукты,100\n");
        assert_eq!(import(db.conn_mut(), &f, true, None).unwrap().added, 1);
        let p = preview(db.conn(), &f, None).unwrap();
        assert_eq!(p.rows[1].error.as_deref(), Some("нет счёта «Сейф»"));
    }

    #[test]
    fn exported_operations_import_back_unchanged() {
        let mut db = setup();
        let dir = tempfile::tempdir().unwrap();
        let tpl = dir.path().join("template.csv");
        write_template(&tpl).unwrap();
        assert_eq!(import(db.conn_mut(), &tpl, false, None).unwrap().added, 3);
        let out = dir.path().join("export.csv");
        let sheet = transactions_sheet(db.conn(), &Filter::default()).unwrap();
        write_one(&out, &sheet).unwrap();
        // Новая база, загружаем выгрузку: операции те же.
        let mut db2 = setup();
        assert_eq!(import(db2.conn_mut(), &out, false, None).unwrap().added, 3);
        let again = transactions_sheet(db2.conn(), &Filter::default()).unwrap();
        assert_eq!(again.rows, sheet.rows);
    }

    #[test]
    fn header_problems_and_ambiguous_categories() {
        let db = setup();
        let dir = tempfile::tempdir().unwrap();
        let f = file(&dir, "h.csv", "Date;Type;Sum\n01.01.2026;x;1\n");
        let e = preview(db.conn(), &f, None).unwrap_err().to_string();
        assert!(e.contains("Дата, Тип, Счёт, Сумма"), "{e}");
        // «Одежда» есть и в «Дети», и отдельной категорией «Одежда и обувь» — имя «Одежда» однозначно только в «Дети».
        let f = file(&dir, "c.csv", "Дата;Тип;Счёт;Категория;Сумма\n01.10.2026;Расход;Карта;Дети → Одежда;1\n01.10.2026;Расход;Карта;Нет такой;1\n");
        let p = preview(db.conn(), &f, None).unwrap();
        assert_eq!(p.rows[0].error, None);
        assert!(p.rows[1]
            .error
            .as_deref()
            .unwrap()
            .starts_with("нет категории"));
        let f = file(&dir, "e.csv", "Дата;Тип;Счёт;Сумма\n");
        assert!(preview(db.conn(), &f, None).is_err());
        fs::write(dir.path().join("w.csv"), [0xC4u8, 0xE0, 0xF2, 0xE0]).unwrap();
        assert!(preview(db.conn(), &dir.path().join("w.csv"), None)
            .unwrap_err()
            .to_string()
            .contains("UTF-8"));
    }
}
