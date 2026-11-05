//! Ввод одной строкой: «пятёрочка 1250 карта», «+85000 зарплата», «такси 600 вчера»
//! или вставленный текст SMS/пуша банка («Покупка 1 250р PYATEROCHKA Баланс …»).
//! Разбор только предлагает черновик операции; записывает её пользователь.

use std::sync::OnceLock;

use chrono::{Datelike, Duration, NaiveDate};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::rules::{self, normalize};
use crate::{accounts, categories, currencies, money, transactions, Result};

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// `expense`, `income` или `transfer` (снятие наличных).
    #[serde(rename = "type")]
    pub kind: String,
    /// Сумма в минимальных единицах валюты счёта; `None`, если суммы в тексте нет.
    pub amount: Option<i64>,
    pub date: String,
    pub account_id: Option<String>,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub payee: Option<String>,
    /// Название магазина как в тексте банка: по нему можно запомнить правило.
    pub merchant: Option<String>,
    /// Сработавшее правило автокатегоризации.
    pub rule_id: Option<String>,
    /// `line` — строка, набранная вручную, `sms` — текст банка.
    pub source: String,
    /// Чего не хватает, чтобы записать операцию сразу: «сумма», «категория», «счёт».
    pub missing: Vec<String>,
    /// Теги из слов с «#»: «леруа 4500 #ремонт» → «ремонт».
    pub tags: Vec<String>,
}

/// Убрать из текста слова с «#» и вернуть их как теги (без повторов).
fn take_tags(text: &str) -> (String, Vec<String>) {
    let mut tags: Vec<String> = Vec::new();
    let mut rest: Vec<&str> = Vec::new();
    for word in text.split_whitespace() {
        let Some(tag) = word.strip_prefix('#') else {
            rest.push(word);
            continue;
        };
        if let Some(t) = crate::tags::clean_name(tag) {
            if !tags.iter().any(|x| x.to_lowercase() == t.to_lowercase()) {
                tags.push(t);
            }
        }
    }
    (rest.join(" "), tags)
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("регулярное выражение"))
}

/// Сумма с валютой в тексте банка: «1 250р», «1250.00 RUB», «на 1 250 ₽».
fn sms_amount() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)(\d[\d \u{a0}]*(?:[.,]\d{1,2})?)\s*(₽|р\.?|руб\.?|rub|rur|usd|eur|\$|€)(?:[^\p{L}]|$)",
    )
}

/// Последние 4 цифры карты или счёта: «*1234», «MIR-1234», «ECMC1234», «Карта*1234».
fn card_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)(?:\*|mir-?|ecmc|visa|maestro|карта\s*\*?|сч[её]т\s*\*?|счет\s*\*?)(\d{4})\b",
    )
}

fn date_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?\b")
}

fn time_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"\b\d{1,2}:\d{2}\b")
}

const SMS_WORDS: &[&str] = &[
    "покупка",
    "оплата",
    "списание",
    "зачисление",
    "пополнение",
    "поступление",
    "перевод",
    "снятие",
    "возврат",
    "баланс",
    "доступно",
    "остаток",
];
const INCOME_WORDS: &[&str] = &[
    "зачисление",
    "пополнение",
    "поступление",
    "возврат",
    "зарплата",
    "перевод от",
    "входящий перевод",
];
/// После этих слов в SMS идёт остаток, а не сумма операции.
const BALANCE_WORDS: &[&str] = &["баланс", "доступно", "остаток", "бал."];

fn is_sms(text: &str) -> bool {
    let low = text.to_lowercase();
    SMS_WORDS.iter().any(|w| low.contains(w)) && sms_amount().is_match(text)
}

/// «1 250,50» → «1250,50» для `money::parse_amount`.
fn digits(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn date_from(d: &str, m: &str, y: Option<&str>, today: NaiveDate) -> Option<NaiveDate> {
    let (d, m) = (d.parse().ok()?, m.parse().ok()?);
    let y = match y {
        Some(y) if y.len() == 2 => 2000 + y.parse::<i32>().ok()?,
        Some(y) => y.parse().ok()?,
        None => today.year(),
    };
    let date = NaiveDate::from_ymd_opt(y, m, d)?;
    // Без года дата из будущего — это прошлый год (31.12 в январе).
    Some(
        if date > today && date.year() == today.year() && y == today.year() {
            NaiveDate::from_ymd_opt(y - 1, m, d).unwrap_or(date)
        } else {
            date
        },
    )
}

/// Счёт, в названии которого есть последние 4 цифры карты.
fn account_by_card(conn: &Connection, last4: &str) -> Result<Option<String>> {
    Ok(accounts::list(conn, false)?
        .into_iter()
        .find(|a| a.name.contains(last4))
        .map(|a| a.id))
}

fn first_card(conn: &Connection) -> Result<Option<String>> {
    let list = accounts::list(conn, false)?;
    Ok(["debit", "credit"]
        .iter()
        .find_map(|k| list.iter().find(|a| a.kind == *k))
        .map(|a| a.id.clone()))
}

/// Как магазины сетей пишутся в SMS латиницей и как их назвать по-русски.
const BRANDS: &[(&str, &str)] = &[
    ("pyaterochka", "Пятёрочка"),
    ("magnit", "Магнит"),
    ("perekrestok", "Перекрёсток"),
    ("lenta", "Лента"),
    ("vkusvill", "ВкусВилл"),
    ("auchan", "Ашан"),
    ("dixy", "Дикси"),
    ("diksi", "Дикси"),
    ("okey", "О'кей"),
    ("metro", "Метро"),
    ("samokat", "Самокат"),
    ("yandexgo", "Яндекс Go"),
    ("yandextaxi", "Яндекс Go"),
    ("yandexeda", "Яндекс Еда"),
    ("yandexlavka", "Яндекс Лавка"),
    ("ozon", "Ozon"),
    ("wildberries", "Wildberries"),
    ("lukoil", "Лукойл"),
    ("rosneft", "Роснефть"),
    ("gazpromneft", "Газпромнефть"),
    ("shokoladnitsa", "Шоколадница"),
    ("vkusnoitochka", "Вкусно и точка"),
    ("burgerking", "Бургер Кинг"),
    ("rigla", "Ригла"),
    ("aptekarigla", "Аптека Ригла"),
    ("mvideo", "М.Видео"),
    ("eldorado", "Эльдорадо"),
    ("leroymerlin", "Леруа Мерлен"),
    ("fixprice", "Fix Price"),
    ("sportmaster", "Спортмастер"),
    ("detskiymir", "Детский мир"),
];

/// Русское название сети по тексту магазина из SMS: «PYATEROCHKA» → «Пятёрочка».
fn brand(merchant: &str) -> Option<&'static str> {
    let key: String = merchant
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    // Самое длинное совпадение: «APTEKA RIGLA» — «Аптека Ригла», а не «Ригла».
    BRANDS
        .iter()
        .filter(|(latin, _)| key.starts_with(latin))
        .max_by_key(|(latin, _)| latin.len())
        .map(|(_, name)| *name)
}

fn clean_merchant(s: &str) -> Option<String> {
    let s = card_re().replace_all(s, " ");
    let s = time_re().replace_all(&s, " ");
    let s = date_re().replace_all(&s, " ");
    let first = s
        .split(['.', ';', '\n'])
        .map(str::trim)
        .find(|p| p.chars().any(char::is_alphabetic))?;
    let words: Vec<&str> = first
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .collect();
    let skip = [
        "в",
        "на",
        "от",
        "для",
        "по",
        "карта",
        "карты",
        "счет",
        "счёт",
        "rub",
        "rur",
    ];
    let start = words
        .iter()
        .position(|w| !skip.contains(&w.to_lowercase().as_str()))?;
    // Номер магазина в конце («PYATEROCHKA 2312») к названию не относится.
    let mut end = words.len();
    while end > start + 1 && words[end - 1].chars().all(|c| c.is_ascii_digit()) {
        end -= 1;
    }
    let out = words[start..end].join(" ");
    let out = out.trim_matches(|c: char| !c.is_alphanumeric() && c != '"' && c != '»' && c != ')');
    (!out.is_empty()).then(|| out.to_string())
}

struct Parsed {
    kind: String,
    amount_text: Option<String>,
    date: NaiveDate,
    account_id: Option<String>,
    category_id: Option<String>,
    merchant: Option<String>,
    sms: bool,
}

fn parse_sms(conn: &Connection, text: &str, today: NaiveDate) -> Result<Parsed> {
    let low = text.to_lowercase();
    // Всё после слов «Баланс», «Доступно» — остаток, его не трогаем.
    let cut = BALANCE_WORDS
        .iter()
        .filter_map(|w| low.find(w))
        .min()
        .unwrap_or(text.len());
    let head = &text[..cut];
    let kind = if low.contains("снятие") || low.contains("выдача наличных") {
        "transfer"
    } else if INCOME_WORDS.iter().any(|w| low.contains(w)) {
        "income"
    } else {
        "expense"
    };
    let amount = sms_amount().captures(head);
    let (amount_text, after, before) = match &amount {
        Some(c) => {
            let m = c.get(0).expect("совпадение");
            (Some(digits(&c[1])), &head[m.end()..], &head[..m.start()])
        }
        None => (None, head, ""),
    };
    let account_id = match card_re().captures(text) {
        // Номер карты не найден в названиях счетов: берём первую карту, а не наличные.
        Some(c) => match account_by_card(conn, &c[1])? {
            Some(id) => Some(id),
            None => first_card(conn)?,
        },
        None => None,
    };
    let date = date_re()
        .captures(head)
        .and_then(|c| date_from(&c[1], &c[2], c.get(3).map(|m| m.as_str()), today))
        .unwrap_or(today);
    // Магазин обычно после суммы; у переводов («Перевод от Иван И. 5000р») — до неё.
    let merchant = clean_merchant(after).or_else(|| {
        let before = SMS_WORDS
            .iter()
            .filter_map(|w| before.to_lowercase().find(w).map(|i| i + w.len()))
            .max()
            .map_or(before, |i| &before[i.min(before.len())..]);
        clean_merchant(before)
    });
    Ok(Parsed {
        kind: kind.into(),
        amount_text,
        date,
        account_id,
        category_id: None,
        merchant,
        sms: true,
    })
}

/// Сумма в строке: «1250», «1250р», «1 250» не поддерживается (это два слова), «1,5к» = 1 500.
fn line_amount(token: &str) -> Option<String> {
    let t = token
        .trim_end_matches(['₽', 'р', '.'])
        .trim_end_matches("руб");
    let (num, thousands) = match t.strip_suffix(['к', 'k', 'К', 'K']) {
        Some(n) => (n, true),
        None => (t, false),
    };
    if num.is_empty()
        || !num
            .chars()
            .all(|c| c.is_ascii_digit() || c == ',' || c == '.')
    {
        return None;
    }
    if !num.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    if thousands {
        let v: f64 = num.replace(',', ".").parse().ok()?;
        return Some(format!("{}", (v * 1000.0).round() as i64));
    }
    Some(num.to_string())
}

fn parse_line(conn: &Connection, text: &str, today: NaiveDate) -> Result<Parsed> {
    let accounts = accounts::list(conn, false)?;
    let cats = categories::list(conn, false)?;
    let mut kind = "expense".to_string();
    let mut amount_text = None;
    let mut date = today;
    let mut account_id = None;
    let mut category_id = None;
    let mut rest: Vec<&str> = Vec::new();
    for token in text.split_whitespace() {
        let low = normalize(token);
        let mut tok = token;
        if let Some(t) = token.strip_prefix('+') {
            kind = "income".into();
            tok = t;
            if tok.is_empty() {
                continue;
            }
        }
        if amount_text.is_none() {
            if let Some(a) = line_amount(tok) {
                amount_text = Some(a);
                continue;
            }
        }
        match low.as_str() {
            "доход" => {
                kind = "income".into();
                continue;
            }
            "сегодня" => continue,
            "вчера" => {
                date = today - Duration::days(1);
                continue;
            }
            "позавчера" => {
                date = today - Duration::days(2);
                continue;
            }
            _ => {}
        }
        if let Some(c) = date_re().captures(tok) {
            if c.get(0).is_some_and(|m| m.as_str() == tok) {
                if let Some(d) = date_from(&c[1], &c[2], c.get(3).map(|m| m.as_str()), today) {
                    date = d;
                    continue;
                }
            }
        }
        let word = low.trim_matches(|c: char| !c.is_alphanumeric()).to_string();
        if word.chars().count() >= 3 {
            if account_id.is_none() {
                let hit = accounts.iter().find(|a| {
                    normalize(&a.name)
                        .split(|c: char| !c.is_alphanumeric())
                        .any(|w| w.starts_with(&word))
                });
                if let Some(a) = hit {
                    account_id = Some(a.id.clone());
                    continue;
                }
            }
            if category_id.is_none() {
                // Сначала полное совпадение названия, затем начало слова.
                let exact = cats.iter().find(|c| normalize(&c.name) == word);
                let prefix = || {
                    cats.iter().find(|c| {
                        normalize(&c.name)
                            .split(' ')
                            .next()
                            .is_some_and(|w| w.starts_with(&word))
                    })
                };
                // Привычные прежние названия («продукты», «зарплата») ведут к новым (0.28).
                let legacy = || {
                    categories::RENAMES
                        .iter()
                        .find(|r| normalize(r.2) == word)
                        .and_then(|r| cats.iter().find(|c| c.kind == r.0 && c.name == r.3))
                };
                if let Some(c) = exact.or_else(prefix).or_else(legacy) {
                    category_id = Some(c.id.clone());
                    if c.kind == "income" {
                        kind = "income".into();
                    }
                    continue;
                }
            }
        }
        rest.push(token);
    }
    let merchant = (!rest.is_empty()).then(|| {
        let s = rest.join(" ");
        let mut ch = s.chars();
        match ch.next() {
            Some(f) => f.to_uppercase().collect::<String>() + ch.as_str(),
            None => s,
        }
    });
    Ok(Parsed {
        kind,
        amount_text,
        date,
        account_id,
        category_id,
        merchant,
        sms: false,
    })
}

/// Последняя операция с этим получателем (без учёта регистра): категория и счёт.
fn by_history(
    conn: &Connection,
    payee: &str,
    kind: &str,
) -> Result<Option<(String, Option<String>, String)>> {
    let p = normalize(payee);
    let mut stmt = conn.prepare(
        "SELECT payee, category_id, account_id FROM transactions
         WHERE type = ?1 AND payee IS NOT NULL ORDER BY date DESC, created_at DESC LIMIT 2000",
    )?;
    let mut rows = stmt.query([kind])?;
    while let Some(r) = rows.next()? {
        let name: String = r.get(0)?;
        if normalize(&name) == p {
            return Ok(Some((name, r.get(1)?, r.get(2)?)));
        }
    }
    Ok(None)
}

/// Разобрать текст в черновик операции.
pub fn parse(conn: &Connection, text: &str, today: &str) -> Result<Draft> {
    crate::time::check_date(today)?;
    let today_d = NaiveDate::parse_from_str(today, "%Y-%m-%d").expect("проверено");
    let (text, tags) = take_tags(text.trim());
    let text = text.as_str();
    let p = if is_sms(text) {
        parse_sms(conn, text, today_d)?
    } else {
        parse_line(conn, text, today_d)?
    };
    let mut d = Draft {
        kind: p.kind.clone(),
        date: p.date.to_string(),
        account_id: p.account_id,
        category_id: p.category_id,
        payee: p.merchant.clone(),
        merchant: p.merchant.clone(),
        source: if p.sms { "sms" } else { "line" }.into(),
        tags,
        ..Default::default()
    };
    if d.kind != "transfer" {
        // Правило по магазину, иначе по всему тексту (в SMS магазин бывает с городом).
        let rule = match &p.merchant {
            Some(m) => rules::find(conn, m, &d.kind)?,
            None => None,
        };
        let rule = match rule {
            Some(r) => Some(r),
            None if p.sms => rules::find(conn, text, &d.kind)?,
            None => None,
        };
        if let Some(name) = p.merchant.as_deref().filter(|_| p.sms).and_then(brand) {
            d.payee = Some(name.into());
        }
        if let Some(r) = rule {
            if d.category_id.is_none() {
                d.category_id = Some(r.category_id.clone());
            }
            if r.payee.is_some() {
                d.payee = r.payee.clone();
            }
            d.rule_id = Some(r.id);
        }
        if let Some(payee) = d.payee.clone() {
            if let Some((name, cat, acc)) = by_history(conn, &payee, &d.kind)? {
                d.payee = Some(name);
                if d.category_id.is_none() {
                    d.category_id = cat;
                }
                if d.account_id.is_none() {
                    d.account_id = Some(acc);
                }
            }
        }
    } else {
        d.payee = None;
        d.to_account_id = accounts::list(conn, false)?
            .into_iter()
            .find(|a| a.kind == "cash")
            .map(|a| a.id);
    }
    if d.account_id.is_none() {
        d.account_id = transactions::defaults(conn, &d.kind)?
            .account_id
            .or_else(|| {
                accounts::list(conn, false)
                    .ok()?
                    .into_iter()
                    .find(|a| a.kind != "cash" || d.kind != "transfer")
                    .map(|a| a.id)
            });
    }
    let minor = match &d.account_id {
        Some(id) => accounts::head(conn, id)?.minor_units,
        None => currencies::minor_units(conn, &currencies::base_currency(conn)?)?,
    };
    d.amount = match &p.amount_text {
        Some(t) => money::parse_amount(t, minor).ok().filter(|v| *v > 0),
        None => None,
    };
    if d.amount.is_none() {
        d.missing.push("сумма".into());
    }
    if d.account_id.is_none() {
        d.missing.push("счёт".into());
    }
    if d.kind == "transfer" && d.to_account_id.is_none() {
        d.missing.push("счёт зачисления".into());
    }
    if d.kind != "transfer" && d.category_id.is_none() {
        d.missing.push("категория".into());
    }
    Ok(d)
}

/// Запомнить правило по черновику: магазин из текста → выбранная категория.
pub fn remember(
    conn: &Connection,
    merchant: &str,
    category_id: &str,
    payee: Option<&str>,
) -> Result<String> {
    let payee = payee.filter(|p| normalize(p) != normalize(merchant));
    rules::create(
        conn,
        &rules::RuleInput {
            pattern: merchant.into(),
            category_id: category_id.into(),
            payee: payee.map(Into::into),
        },
    )
}

/// Есть ли уже правило для этого магазина (чтобы не предлагать запомнить ещё раз).
pub fn has_rule(conn: &Connection, merchant: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM payee_rules WHERE pattern_norm = ?1",
            [normalize(merchant)],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;
    use crate::transactions::TxnInput;

    struct Fx {
        db: Storage,
        card: String,
        cash: String,
    }

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 ORDER BY kind = 'income' LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn fx() -> Fx {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        Fx {
            cash: accounts::create(c, &input("Наличные", "cash", "RUB", 0)).unwrap(),
            card: accounts::create(c, &input("Карта Сбер *4321", "debit", "RUB", 0)).unwrap(),
            db,
        }
    }

    const TODAY: &str = "2026-10-20";

    #[test]
    fn line_with_amount_account_category_and_date() {
        let f = fx();
        let c = f.db.conn();
        let d = parse(c, "пятёрочка 1250 карта продукты", TODAY).unwrap();
        assert_eq!(d.kind, "expense");
        assert_eq!(d.amount, Some(125_000));
        assert_eq!(d.account_id.as_deref(), Some(f.card.as_str()));
        assert_eq!(d.category_id, Some(cat(c, "Питание")));
        assert_eq!(d.payee.as_deref(), Some("Пятёрочка"));
        assert_eq!(d.date, TODAY);
        assert!(d.missing.is_empty(), "{:?}", d.missing);
        assert_eq!(d.source, "line");

        let d = parse(c, "такси 600,50 вчера налич", TODAY).unwrap();
        assert_eq!(d.amount, Some(60_050));
        assert_eq!(d.date, "2026-10-19");
        assert_eq!(d.account_id.as_deref(), Some(f.cash.as_str()));
        assert_eq!(d.category_id, Some(cat(c, "Такси")));
        assert_eq!(d.payee, None);

        let d = parse(c, "+85к зарплата 05.10", TODAY).unwrap();
        assert_eq!((d.kind.as_str(), d.amount), ("income", Some(8_500_000)));
        assert_eq!(d.date, "2026-10-05");
        assert_eq!(d.category_id, Some(cat(c, "Заработная плата")));

        let d = parse(c, "подарок маме", TODAY).unwrap();
        assert_eq!(
            d.missing,
            vec!["сумма".to_string(), "категория".to_string()]
        );
        // Теги через «#» не мешают разбору остального.
        let d = parse(c, "леруа 4500 #ремонт карта #Дача #РЕМОНТ", TODAY).unwrap();
        assert_eq!(d.amount, Some(450_000));
        assert_eq!(d.payee.as_deref(), Some("Леруа"));
        assert_eq!(d.account_id.as_deref(), Some(f.card.as_str()));
        assert_eq!(d.tags, ["ремонт", "Дача"]);
        // 31.12 в октябре — это прошлый декабрь.
        assert_eq!(
            parse(c, "кофе 250 31.12", TODAY).unwrap().date,
            "2025-12-31"
        );
    }

    #[test]
    fn history_fills_category_and_account() {
        let f = fx();
        let c = f.db.conn();
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: "2026-10-01".into(),
                account_id: f.cash.clone(),
                amount: 30_000,
                category_id: Some(cat(c, "Общепит")),
                to_account_id: None,
                to_amount: None,
                payee: Some("Шоколадница".into()),
                note: None,
            },
        )
        .unwrap();
        let d = parse(c, "шоколадница 450", TODAY).unwrap();
        assert_eq!(d.payee.as_deref(), Some("Шоколадница"));
        assert_eq!(d.category_id, Some(cat(c, "Общепит")));
        assert_eq!(d.account_id.as_deref(), Some(f.cash.as_str()));
    }

    #[test]
    fn bank_messages() {
        let f = fx();
        let c = f.db.conn();
        remember(c, "PYATEROCHKA", &cat(c, "Магазины"), Some("Пятёрочка")).unwrap();
        assert!(has_rule(c, "pyaterochka").unwrap());
        let cases = [
            // Сбер
            "MIR-4321 14:22 Покупка 1 250р PYATEROCHKA Баланс: 35 000.50р",
            // Т-Банк
            "Покупка, карта *4321. 1250 RUB. PYATEROCHKA. Доступно 35000 RUB",
            // ВТБ
            "Оплата 1250.00р Карта*4321 PYATEROCHKA Баланс 35000.00р 14:22",
            // Альфа-Банк
            "Карта *4321. Покупка на 1 250 ₽, PYATEROCHKA 2312. Баланс 35 000 ₽",
        ];
        for text in cases {
            let d = parse(c, text, TODAY).unwrap();
            assert_eq!(d.source, "sms", "{text}");
            assert_eq!(d.kind, "expense", "{text}");
            assert_eq!(d.amount, Some(125_000), "{text}");
            assert_eq!(d.account_id.as_deref(), Some(f.card.as_str()), "{text}");
            assert_eq!(d.payee.as_deref(), Some("Пятёрочка"), "{text}");
            assert_eq!(d.category_id, Some(cat(c, "Магазины")), "{text}");
            assert!(d.rule_id.is_some(), "{text}");
            assert!(
                d.merchant.as_deref().unwrap().starts_with("PYATEROCHKA"),
                "{text}: {:?}",
                d.merchant
            );
        }

        let d = parse(
            c,
            "СЧЁТ4321 05.10.26 Зачисление зарплаты 85 000р Баланс: 120 000р",
            TODAY,
        )
        .unwrap();
        assert_eq!((d.kind.as_str(), d.amount), ("income", Some(8_500_000)));
        assert_eq!(d.date, "2026-10-05");

        let d = parse(c, "Перевод от Иван И. 5000р Баланс 40 000р", TODAY).unwrap();
        assert_eq!((d.kind.as_str(), d.amount), ("income", Some(500_000)));
        assert_eq!(d.merchant.as_deref(), Some("Иван И"));

        let d = parse(c, "MIR-4321 Снятие 3000р ATM 123 Баланс 1000р", TODAY).unwrap();
        assert_eq!(d.kind, "transfer");
        assert_eq!(d.to_account_id.as_deref(), Some(f.cash.as_str()));
        assert!(d.missing.is_empty(), "{:?}", d.missing);

        // Правила нет, но сеть известна: получатель по-русски, категория по прошлым покупкам.
        let d = parse(
            c,
            "Покупка 760р Карта*9999 MAGNIT MM 0412 Баланс 100р",
            TODAY,
        )
        .unwrap();
        assert_eq!(d.merchant.as_deref(), Some("MAGNIT MM"));
        assert_eq!(d.payee.as_deref(), Some("Магнит"));
        assert_eq!(
            d.account_id.as_deref(),
            Some(f.card.as_str()),
            "карта не найдена по номеру — первая карта, не наличные"
        );
        assert_eq!(brand("APTEKA RIGLA 12"), Some("Аптека Ригла"));
        assert_eq!(brand("YANDEX.GO"), Some("Яндекс Go"));

        // Незнакомый магазин: категории нет, правило можно запомнить.
        let d = parse(c, "Покупка 990р OZON.RU Баланс 100р", TODAY).unwrap();
        assert_eq!(d.missing, vec!["категория".to_string()]);
        assert_eq!(d.merchant.as_deref(), Some("OZON"));
    }
}
