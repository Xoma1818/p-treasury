//! Импорт операций из CSV по шаблону приложения (те же столбцы, что в
//! выгрузке операций): сначала предпросмотр с ошибками по строкам, затем
//! загрузка правильных строк одной транзакцией.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
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

/// Таблица Excel (`.xlsx`, `.xls`, `.ods`): лист, где в первой строке есть
/// «Дата», «Тип», «Счёт», «Сумма» (иначе первый лист). Даты — `ДД.ММ.ГГГГ`,
/// числа — с точкой, как их понимает разбор суммы.
fn is_book(path: &Path) -> bool {
    path.extension().is_some_and(|e| {
        ["xlsx", "xls", "xlsm", "ods"]
            .iter()
            .any(|x| e.eq_ignore_ascii_case(x))
    })
}

fn book_rows(path: &Path) -> Result<Vec<Vec<String>>> {
    use calamine::{open_workbook_auto, Data, Reader};
    let mut book = open_workbook_auto(path)
        .map_err(|e| Error::Validation(format!("не удалось открыть Excel: {e}")))?;
    let cell = |d: &Data| match d {
        Data::DateTime(dt) => {
            let (y, mo, d, ..) = dt.to_ymd_hms_milli();
            format!("{d:02}.{mo:02}.{y}")
        }
        Data::DateTimeIso(s) => s.get(..10).unwrap_or(s).to_string(),
        // Сумма в ячейке — число: 1234.5, без хвостов двоичной дроби.
        Data::Float(f) => {
            let s = format!("{:.4}", f);
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        }
        Data::Int(i) => i.to_string(),
        Data::Empty => String::new(),
        other => other.to_string(),
    };
    let mut first = None;
    for name in book.sheet_names() {
        let Ok(range) = book.worksheet_range(&name) else {
            continue;
        };
        let rows: Vec<Vec<String>> = range.rows().map(|r| r.iter().map(cell).collect()).collect();
        let head = rows
            .first()
            .map(|r| {
                r.iter()
                    .map(|h| h.trim().to_lowercase())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if ["дата", "тип", "счёт", "сумма"]
            .iter()
            .all(|h| head.iter().any(|c| c == h))
        {
            return Ok(rows);
        }
        first.get_or_insert(rows);
    }
    Ok(first.unwrap_or_default())
}

/// Строки файла по шаблону операций: CSV (`;` или `,`) или Excel.
pub(crate) fn read_table(path: &Path) -> Result<Vec<Vec<String>>> {
    if is_book(path) {
        return book_rows(path);
    }
    let text = read_text(path)?;
    let first = text.lines().next().unwrap_or("");
    let delimiter = if first.matches(';').count() >= first.matches(',').count() {
        b';'
    } else {
        b','
    };
    csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .has_headers(false)
        .from_reader(text.as_bytes())
        .records()
        .map(|r| {
            r.map(|r| r.iter().map(str::to_string).collect())
                .map_err(|e| Error::Validation(format!("не удалось прочитать CSV: {e}")))
        })
        .collect()
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

pub(crate) struct Lookup {
    /// имя счёта в нижнем регистре → (id, знаки после запятой)
    accounts: HashMap<String, (String, u32)>,
    /// (вид, «родитель → подкатегория» или имя) в нижнем регистре → id; `None` — имя неоднозначно
    categories: HashMap<(String, String), Option<String>>,
    /// Все категории (вид, id, имя) — для поиска похожей.
    names: Vec<(String, String, String)>,
}

/// Новые категории: (номер строки в разборе, категория).
pub(crate) type NewCategories = Vec<(usize, NewCategory)>;

/// Возвраты покупок из файла: (номер строки в разборе, дата для бюджета).
/// Дата для бюджета — дата покупки, если возврат учтён в её месяце, иначе `None`.
/// Такие строки пишутся не как доход, а как возврат найденной покупки.
pub(crate) type Refunds = Vec<(usize, Option<String>)>;

/// Что разбор файла по шаблону добавил к строкам.
#[derive(Debug, Default)]
pub(crate) struct Extra {
    pub(crate) categories: NewCategories,
    pub(crate) refunds: Refunds,
}

/// Категория из файла, которой нет в программе: её создаст загрузка.
#[derive(Debug, Clone)]
pub(crate) struct NewCategory {
    kind: String,
    /// Родитель из «Родитель → Имя»: id готовой категории или имя новой.
    parent: Option<Parent>,
    name: String,
}

impl NewCategory {
    /// Категория верхнего уровня (из выписки банка).
    pub(crate) fn top(kind: &str, name: &str) -> Self {
        NewCategory {
            kind: kind.to_string(),
            parent: None,
            name: name.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
enum Parent {
    Existing(String),
    New(String),
}

/// Основы слов длиной от 4 букв: «Продукты питания» → «проду», «питан».
fn stems(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 4)
        .map(|w| w.chars().take(5).collect())
        .collect()
}

/// Похожая категория того же вида: больше всего общих основ слов
/// («Продукты питания» → «Питание», «Кафе и рестораны» → «Рестораны»).
pub(crate) fn similar(lk: &Lookup, kind: &str, name: &str) -> Option<(String, String)> {
    let want = stems(name);
    if want.is_empty() {
        return None;
    }
    lk.names
        .iter()
        .filter(|(k, _, _)| k == kind)
        .map(|(_, id, n)| (stems(n).iter().filter(|s| want.contains(s)).count(), id, n))
        .filter(|(score, _, _)| *score > 0)
        // При равенстве — первая по порядку категорий.
        .fold(None::<(usize, &String, &String)>, |best, cur| match best {
            Some(b) if b.0 >= cur.0 => Some(b),
            _ => Some(cur),
        })
        .map(|(_, id, n)| (id.clone(), n.clone()))
}

pub(crate) fn lookup(conn: &Connection) -> Result<Lookup> {
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
    let mut names = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.kind, c.name, p.name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
         WHERE c.archived_at IS NULL
         ORDER BY COALESCE(p.sort_order, c.sort_order), c.parent_id IS NOT NULL, c.sort_order",
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
        names.push((kind.clone(), id.clone(), name.clone()));
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
        names,
    })
}

/// Разбор CSV; строки с неизвестной категорией без похожей попадут в
/// загрузку только после `create_categories` (сразу — в `parse`).
pub(crate) fn parse(conn: &Connection, path: &Path) -> Result<(Vec<Parsed>, Refunds)> {
    let (mut parsed, extra) = parse_full(conn, path)?;
    create_categories(conn, &mut parsed, &extra.categories)?;
    Ok((parsed, extra.refunds))
}

/// Создать недостающие категории и проставить их строкам (`(номер строки в
/// `parsed`, категория)`). Одинаковые имена создаются один раз.
pub(crate) fn create_categories(
    conn: &Connection,
    parsed: &mut [Parsed],
    new: &[(usize, NewCategory)],
) -> Result<()> {
    // «Аквариум» и «аквариум» — одна категория (первое написание).
    let key = |nc: &NewCategory| {
        let parent = match &nc.parent {
            None => String::new(),
            Some(Parent::Existing(id)) => id.clone(),
            Some(Parent::New(n)) => format!("new:{}", n.to_lowercase()),
        };
        (nc.kind.clone(), parent, nc.name.to_lowercase())
    };
    let mut made: HashMap<(String, String, String), String> = HashMap::new();
    let mut parents: HashMap<(String, String), String> = HashMap::new();
    for (i, nc) in new {
        let id = match made.get(&key(nc)) {
            Some(id) => id.clone(),
            None => {
                let parent_id = match &nc.parent {
                    None => None,
                    Some(Parent::Existing(id)) => Some(id.clone()),
                    Some(Parent::New(name)) => {
                        let key = (nc.kind.clone(), name.to_lowercase());
                        Some(match parents.get(&key) {
                            Some(id) => id.clone(),
                            None => {
                                let id = crate::categories::create(
                                    conn,
                                    &crate::categories::CategoryInput {
                                        name: name.clone(),
                                        kind: nc.kind.clone(),
                                        parent_id: None,
                                    },
                                )?;
                                parents.insert(key, id.clone());
                                id
                            }
                        })
                    }
                };
                let id = crate::categories::create(
                    conn,
                    &crate::categories::CategoryInput {
                        name: nc.name.clone(),
                        kind: nc.kind.clone(),
                        parent_id,
                    },
                )?;
                made.insert(key(nc), id.clone());
                id
            }
        };
        if let Some(input) = parsed.get_mut(*i).and_then(|p| p.input.as_mut()) {
            input.category_id = Some(id);
        }
    }
    Ok(())
}

/// Разбор без записи в базу: строки и категории, которые нужно создать.
pub(crate) fn parse_full(conn: &Connection, path: &Path) -> Result<(Vec<Parsed>, Extra)> {
    let mut table = read_table(path)?.into_iter();
    let headers: Vec<String> = table
        .next()
        .unwrap_or_default()
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
    let c_budget = idx("Дата для бюджета");
    let lk = lookup(conn)?;
    let mut refunds: Refunds = Vec::new();
    // Ключ категории строки: id или «new:имя» для той, что создаст загрузка.
    let mut cat_keys: Vec<Option<String>> = Vec::new();
    let mut seen = HashMap::new();

    let mut out = Vec::new();
    let mut new_cats = Vec::new();
    for (i, rec) in table.enumerate() {
        let get = |c: Option<usize>| {
            c.and_then(|c| rec.get(c))
                .map_or("", |s| s.as_str())
                .trim()
                .to_string()
        };
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
        let mut new_cat: Option<NewCategory> = None;
        let mut shown: Option<String> = None;
        // Возврат покупки: категория — расходная, как у покупки.
        let is_refund = row.kind.to_lowercase() == "возврат";
        let mut budget_date: Option<String> = None;
        let checked = (|| -> std::result::Result<TxnInput, String> {
            let date = parse_date(&row.date)
                .ok_or_else(|| format!("дата «{}»: нужна ДД.ММ.ГГГГ", row.date))?;
            let kind = match row.kind.to_lowercase().as_str() {
                "расход" | "возврат" => "expense",
                "доход" => "income",
                "перевод" => "transfer",
                _ => {
                    return Err(format!(
                        "тип «{}»: нужен Расход, Доход, Перевод или Возврат",
                        row.kind
                    ))
                }
            };
            if is_refund {
                if row.category.is_empty() {
                    return Err("у возврата нужна категория покупки".into());
                }
                let b = get(c_budget);
                if !b.is_empty() {
                    let b = parse_date(&b)
                        .ok_or_else(|| format!("дата для бюджета «{b}»: нужна ДД.ММ.ГГГГ"))?;
                    if b > date {
                        return Err("дата для бюджета позже возврата".into());
                    }
                    budget_date = Some(b).filter(|b| *b != date);
                }
            }
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
                    // Нет такой категории: похожая, иначе новая (её создаст загрузка).
                    None => {
                        let (parent, name) = match row
                            .category
                            .split_once(" → ")
                            .or_else(|| row.category.split_once(" / "))
                        {
                            Some((p, n)) => (Some(p.trim()), n.trim()),
                            None => (None, row.category.as_str()),
                        };
                        let parent = parent.filter(|p| !p.is_empty());
                        let parent_id = parent.and_then(|p| {
                            lk.categories
                                .get(&(kind.to_string(), p.to_lowercase()))
                                .cloned()
                                .flatten()
                        });
                        if parent.is_none() {
                            if let Some((id, found)) = similar(&lk, kind, name) {
                                shown = Some(format!("{found} (в файле «{}»)", row.category));
                                input.category_id = Some(id);
                                return Ok(input);
                            }
                        }
                        new_cat = Some(NewCategory {
                            kind: kind.to_string(),
                            parent: parent.map(|p| match parent_id {
                                Some(id) => Parent::Existing(id),
                                None => Parent::New(p.to_string()),
                            }),
                            name: name.to_string(),
                        });
                        shown = Some(format!("{} (новая)", row.category));
                        None
                    }
                };
            }
            Ok(input)
        })();
        let input = match checked {
            Ok(mut i) => {
                cat_keys.push(i.category_id.clone().or_else(|| {
                    new_cat
                        .as_ref()
                        .map(|nc| format!("new:{}", nc.name.to_lowercase()))
                }));
                if let Some(nc) = new_cat {
                    new_cats.push((out.len(), nc));
                }
                if is_refund {
                    i.kind = "income".into();
                    refunds.push((out.len(), budget_date));
                }
                if let Some(s) = shown {
                    row.category = s;
                }
                Some(i)
            }
            Err(e) => {
                cat_keys.push(None);
                row.error = Some(e);
                None
            }
        };
        // Уже есть такая операция (файл загружают второй раз, например
        // выгрузку «Операций»): пропускается. Части разбитого чека — каждая сама по себе.
        let input = match input {
            Some(i) if repeat(conn, &i, &mut seen)? => {
                row.duplicate = true;
                None
            }
            other => other,
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
    // Возврат без покупки (ни в программе, ни выше в файле) не загружается:
    // иначе он стал бы обычным доходом.
    refunds.retain(|(i, budget)| {
        let Some(input) = out[*i].input.as_ref() else {
            return false;
        };
        let in_file = out[..*i].iter().zip(&cat_keys).any(|(p, key)| {
            p.input.as_ref().is_some_and(|q| {
                q.kind == "expense"
                    && key.is_some()
                    && *key == cat_keys[*i]
                    && q.payee == input.payee
                    && q.amount >= input.amount
                    && match budget {
                        Some(d) => q.date == *d,
                        None => q.date <= input.date,
                    }
            })
        });
        let found = in_file
            || input.category_id.as_deref().is_some_and(|c| {
                purchase_for(conn, c, input, budget.as_deref())
                    .ok()
                    .flatten()
                    .is_some()
            })
            // Уже загруженный возврат пропущен как повтор — покупка у него есть.
            || out[*i].row.duplicate;
        if !found {
            out[*i].row.error = Some(format!(
                "возврат: нет покупки «{}» в категории «{}» не дороже возврата — загрузите файл вместе с покупкой",
                input.payee.as_deref().unwrap_or("без получателя"),
                out[*i].row.category
            ));
            out[*i].input = None;
        }
        found
    });
    // Категории создаются только для строк, которые загрузятся.
    new_cats.retain(|(i, _)| out[*i].input.is_some());
    Ok((
        out,
        Extra {
            categories: new_cats,
            refunds,
        },
    ))
}

/// Строка — повтор уже записанной операции (дата, счёт, тип, сумма, получатель;
/// у перевода и счёт зачисления). N-я одинаковая строка файла — повтор, только
/// если таких операций уже не меньше N: две одинаковые покупки за день остаются.
fn repeat(conn: &Connection, t: &TxnInput, seen: &mut HashMap<String, usize>) -> Result<bool> {
    let key = format!(
        "{}|{}|{}|{}|{}|{}",
        t.date,
        t.account_id,
        t.kind,
        t.amount,
        t.payee.as_deref().unwrap_or(""),
        t.to_account_id.as_deref().unwrap_or("")
    );
    let nth = seen.entry(key).or_insert(0);
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM transactions WHERE date = ?1 AND account_id = ?2 AND type = ?3
           AND abs(amount) = ?4 AND coalesce(payee, '') = coalesce(?5, '')
           AND coalesce(to_account_id, '') = coalesce(?6, '')",
        params![
            t.date,
            t.account_id,
            t.kind,
            t.amount,
            t.payee,
            t.to_account_id
        ],
        |r| r.get(0),
    )?;
    let repeat = n as usize > *nth;
    *nth += 1;
    Ok(repeat)
}

/// Покупка, к которой относится возврат: обычный проведённый расход той же
/// категории и получателя, где осталось вернуть не меньше суммы возврата; в дату
/// для бюджета, если она есть, иначе последняя не позже возврата.
pub(crate) fn purchase_for(
    conn: &Connection,
    category: &str,
    t: &TxnInput,
    budget: Option<&str>,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT p.id FROM transactions p
             WHERE p.type = 'expense' AND p.refund = 0 AND p.category_id = ?1
               AND coalesce(p.payee, '') = coalesce(?2, '') AND p.status = 'cleared'
               AND p.spread_months IS NULL AND p.debt_id IS NULL
               AND (CASE WHEN ?4 IS NULL THEN p.date <= ?3 ELSE p.date = ?4 END)
               AND p.amount - coalesce((SELECT sum(r.amount) FROM transactions r
                                        WHERE r.refund_of = p.id), 0) >= ?5
             ORDER BY p.date DESC, p.created_at DESC LIMIT 1",
            params![category, t.payee, t.date, budget, t.amount],
            |r| r.get(0),
        )
        .optional()?)
}

/// Записать разобранные строки файла по шаблону или выписки банка (`bank`): операции — через историю
/// импорта, возвраты — возвратами своих покупок (они могли загрузиться этим же
/// файлом). Всё в транзакции вызывающего.
pub(crate) fn save_rows(
    conn: &Connection,
    origin: import_log::Origin,
    file_name: &str,
    bank: Option<&str>,
    parsed: Vec<Parsed>,
    refunds: &Refunds,
    skipped: usize,
) -> Result<import_log::Saved> {
    let mut plain = (Vec::new(), Vec::new());
    let mut back = Vec::new();
    for (i, p) in parsed.into_iter().enumerate() {
        let Some(input) = p.input else { continue };
        match refunds.iter().find(|(r, _)| *r == i) {
            Some((_, budget)) => back.push((p.row.line, input, budget.clone())),
            None => {
                plain.0.push(input);
                plain.1.push(p.raw_payee);
            }
        }
    }
    let mut saved =
        import_log::save_with_raw(conn, origin, file_name, bank, &plain.0, &plain.1, skipped)?;
    for (line, t, budget) in back {
        let of = t
            .category_id
            .as_deref()
            .map(|c| purchase_for(conn, c, &t, budget.as_deref()))
            .transpose()?
            .flatten()
            .ok_or_else(|| Error::Validation(format!("строка {line}: возврат без покупки")))?;
        let id = crate::refunds::create(
            conn,
            &crate::refunds::RefundInput {
                of,
                date: t.date.clone(),
                account_id: Some(t.account_id.clone()),
                amount: t.amount,
                in_purchase_month: budget.is_some(),
                note: t.note.clone(),
            },
        )
        .map_err(|e| Error::Validation(format!("строка {line}: {e}")))?;
        conn.execute(
            "UPDATE transactions SET import_id = ?2 WHERE id = ?1",
            params![id, saved.import_id],
        )?;
        saved.added += 1;
    }
    Ok(saved)
}

/// Узнанная выписка банка и её операции.
type Statement = (bank_import::Bank, Vec<bank_import::Op>);

/// Строки, их новые категории (только CSV по шаблону) и выписка банка.
type Parsed3 = (Vec<Parsed>, Extra, Option<Statement>);

/// Выписка банка или CSV по шаблону. В базу ничего не пишет.
fn parse_any(conn: &Connection, path: &Path, account_id: Option<&str>) -> Result<Parsed3> {
    if let Some((bank, ops)) = bank_import::read(path)? {
        if ops.is_empty() {
            return invalid("в выписке нет проведённых операций");
        }
        let (parsed, extra) = bank_import::to_parsed(conn, bank, &ops, account_id)?;
        return Ok((parsed, extra, Some((bank, ops))));
    }
    let is_csv = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("csv"));
    if !is_csv && !is_book(path) {
        return invalid("файл не похож на выписку Сбера (PDF) или Т-Банка (CSV, Excel)");
    }
    let (parsed, extra) = parse_full(conn, path)?;
    Ok((parsed, extra, None))
}

/// Предпросмотр: каждая строка с ошибкой или без. Для выписки банка
/// `account_id` — выбранный счёт (без него — запомненный).
pub fn preview(conn: &Connection, path: &Path, account_id: Option<&str>) -> Result<Preview> {
    let (mut parsed, _, bank) = parse_any(conn, path, account_id)?;
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
    let (mut parsed, extra, bank) = parse_any(conn, path, account_id)?;
    let errors = parsed.iter().filter(|p| p.row.error.is_some()).count();
    if errors > 0 && !skip_errors {
        return invalid(format!(
            "в файле строк с ошибками: {errors}; исправьте их или загрузите только правильные"
        ));
    }
    let tx = conn.transaction()?;
    // Недостающие категории — в той же транзакции, что и операции.
    create_categories(&tx, &mut parsed, &extra.categories)?;
    let skipped = parsed.iter().filter(|p| p.row.duplicate).count();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let saved = save_rows(
        &tx,
        import_log::Origin::Manual,
        &name,
        bank.as_ref().map(|(b, _)| b.title()),
        parsed,
        &extra.refunds,
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
        // То же из Excel: даты и суммы в ячейках — числа, а не текст.
        let book = dir.path().join("export.xlsx");
        crate::export::write_xlsx(&book, std::slice::from_ref(&sheet)).unwrap();
        let mut db3 = setup();
        let p = preview(db3.conn(), &book, None).unwrap();
        assert_eq!(p.errors, 0, "{:?}", p.rows);
        assert_eq!(import(db3.conn_mut(), &book, false, None).unwrap().added, 3);
        let again = transactions_sheet(db3.conn(), &Filter::default()).unwrap();
        assert_eq!(again.rows, sheet.rows);
    }

    /// Категории, которых нет в программе: похожая берётся сама, иначе
    /// загрузка создаёт новую (предпросмотр ничего не создаёт).
    /// Ревью OTTO 04.11: выгрузка с разбитым чеком и возвратами, загруженная
    /// повторно, ничего не удваивает, а в новую базу переносит возвраты возвратами.
    #[test]
    fn receipt_parts_and_refunds_survive_export_and_reimport() {
        let mut db = setup();
        let cat = |c: &Connection, name: &str| -> String {
            c.query_row(
                "SELECT id FROM categories WHERE kind = 'expense' AND name = ?1",
                [name],
                |r| r.get(0),
            )
            .unwrap()
        };
        let card: String = db
            .conn()
            .query_row(
                "SELECT id FROM accounts WHERE name = 'Карта'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let (food, home) = (cat(db.conn(), "Питание"), cat(db.conn(), "Одежда и обувь"));
        crate::receipts::create(
            db.conn_mut(),
            &crate::receipts::ReceiptInput {
                date: "2026-10-05".into(),
                account_id: card.clone(),
                payee: Some("Ашан".into()),
                note: None,
                total: 300_000,
                parts: vec![
                    crate::receipts::PartInput {
                        category_id: food.clone(),
                        amount: 200_000,
                        note: None,
                    },
                    crate::receipts::PartInput {
                        category_id: home.clone(),
                        amount: 100_000,
                        note: None,
                    },
                ],
                tags: vec![],
                event_id: None,
            },
        )
        .unwrap();
        let shoes = crate::transactions::create(
            db.conn(),
            &TxnInput {
                kind: "expense".into(),
                date: "2026-09-28".into(),
                account_id: card.clone(),
                amount: 500_000,
                category_id: Some(home.clone()),
                to_account_id: None,
                to_amount: None,
                payee: Some("Леруа".into()),
                note: None,
            },
        )
        .unwrap();
        let part: String = db
            .conn()
            .query_row(
                "SELECT id FROM transactions WHERE split_id IS NOT NULL AND category_id = ?1",
                [&food],
                |r| r.get(0),
            )
            .unwrap();
        let refund =
            |of: &str, date: &str, amount: i64, in_month: bool| crate::refunds::RefundInput {
                of: of.into(),
                date: date.into(),
                account_id: None,
                amount,
                in_purchase_month: in_month,
                note: None,
            };
        // Возврат части чека — в месяце возврата, возврат покупки — в месяце покупки.
        crate::refunds::create(db.conn(), &refund(&part, "2026-10-07", 50_000, false)).unwrap();
        crate::refunds::create(db.conn(), &refund(&shoes, "2026-10-02", 120_000, true)).unwrap();
        let state = |c: &Connection| -> (i64, Vec<(String, String, i64)>) {
            let balance: i64 = c
                .query_row(
                    "SELECT sum(CASE WHEN type = 'expense' THEN -amount ELSE amount END) FROM transactions",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let mut st = c
                .prepare("SELECT type, substr(date, 1, 7), sum(amount) FROM txn_by_month GROUP BY 1, 2 ORDER BY 1, 2")
                .unwrap();
            let months = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            (balance, months)
        };
        let before = state(db.conn());
        let sheet = transactions_sheet(db.conn(), &Filter::default()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("Операции.xlsx");
        crate::export::write_xlsx(&book, std::slice::from_ref(&sheet)).unwrap();

        // Тот же файл в ту же базу: всё — повторы, ничего не добавлено.
        let p = preview(db.conn(), &book, None).unwrap();
        assert_eq!((p.errors, p.duplicates), (0, 5), "{:?}", p.rows);
        assert_eq!(import(db.conn_mut(), &book, false, None).unwrap().added, 0);
        assert_eq!(state(db.conn()), before);

        // В новую базу: возвраты остаются возвратами своих покупок и своих месяцев.
        let mut db2 = setup();
        let p = preview(db2.conn(), &book, None).unwrap();
        assert_eq!(p.errors, 0, "{:?}", p.rows);
        assert_eq!(import(db2.conn_mut(), &book, false, None).unwrap().added, 5);
        assert_eq!(state(db2.conn()), before);
        let linked: i64 = db2
            .conn()
            .query_row(
                "SELECT count(*) FROM transactions WHERE refund = 1 AND refund_of IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, 2);
        let again = transactions_sheet(db2.conn(), &Filter::default()).unwrap();
        assert_eq!(again.rows, sheet.rows);

        // Возврат без покупки не превращается в доход: строка с ошибкой.
        let alone = dir.path().join("возврат.csv");
        std::fs::write(
            &alone,
            "Дата;Тип;Счёт;Категория;Получатель;Сумма\n07.10.2026;Возврат;Карта;Питание;Пятёрочка;500\n",
        )
        .unwrap();
        let p = preview(db2.conn(), &alone, None).unwrap();
        assert!(
            p.rows[0].error.as_deref().unwrap().contains("нет покупки"),
            "{:?}",
            p.rows
        );
    }

    #[test]
    fn missing_categories_go_to_similar_or_are_created() {
        let mut db = setup();
        let dir = tempfile::tempdir().unwrap();
        let count = |db: &Storage| -> i64 {
            db.conn()
                .query_row("SELECT count(*) FROM categories", [], |r| r.get(0))
                .unwrap()
        };
        let before = count(&db);
        let f = file(
            &dir,
            "new.csv",
            "Дата;Тип;Счёт;Категория;Сумма
             01.10.2026;Расход;Карта;Продукты питания;100
             02.10.2026;Расход;Карта;Аквариум;200
             03.10.2026;Расход;Карта;аквариум;300
             04.10.2026;Расход;Карта;Дети → Шахматы;400
             05.10.2026;Расход;Карта;Рыбалка → Снасти;500
             06.10.2026;Доход;Карта;Фриланс;600
",
        );
        let p = preview(db.conn(), &f, None).unwrap();
        assert_eq!((p.valid, p.errors), (6, 0));
        let shown: Vec<_> = p.rows.iter().map(|r| r.category.as_str()).collect();
        assert_eq!(
            shown,
            [
                "Питание (в файле «Продукты питания»)",
                "Аквариум (новая)",
                "аквариум (новая)",
                "Дети → Шахматы (новая)",
                "Рыбалка → Снасти (новая)",
                "Фриланс (новая)",
            ]
        );
        assert_eq!(count(&db), before, "предпросмотр ничего не создаёт");

        assert_eq!(import(db.conn_mut(), &f, false, None).unwrap().added, 6);
        // Аквариум (один раз на два написания), Шахматы, Рыбалка и Снасти, Фриланс.
        assert_eq!(count(&db), before + 5);
        let c = db.conn();
        let cat_of = |amount: i64| -> (String, Option<String>, String) {
            c.query_row(
                "SELECT c.name, p.name, c.kind FROM transactions t JOIN categories c ON c.id = t.category_id
                 LEFT JOIN categories p ON p.id = c.parent_id WHERE t.amount = ?1",
                [amount],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };
        assert_eq!(cat_of(10_000).0, "Питание");
        assert_eq!(cat_of(20_000), cat_of(30_000));
        assert_eq!(
            cat_of(40_000),
            ("Шахматы".into(), Some("Дети".into()), "expense".into())
        );
        assert_eq!(
            cat_of(50_000),
            ("Снасти".into(), Some("Рыбалка".into()), "expense".into())
        );
        assert_eq!(cat_of(60_000), ("Фриланс".into(), None, "income".into()));
        // Второй раз категории уже есть: ничего нового.
        let again = file(
            &dir,
            "again.csv",
            "Дата;Тип;Счёт;Категория;Сумма
07.10.2026;Расход;Карта;Аквариум;700
",
        );
        import(db.conn_mut(), &again, false, None).unwrap();
        assert_eq!(count(&db), before + 5);
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
        assert_eq!(p.rows[1].error, None);
        assert_eq!(p.rows[1].category, "Нет такой (новая)");
        let f = file(&dir, "e.csv", "Дата;Тип;Счёт;Сумма\n");
        assert!(preview(db.conn(), &f, None).is_err());
        fs::write(dir.path().join("w.csv"), [0xC4u8, 0xE0, 0xF2, 0xE0]).unwrap();
        assert!(preview(db.conn(), &dir.path().join("w.csv"), None)
            .unwrap_err()
            .to_string()
            .contains("UTF-8"));
    }
}
