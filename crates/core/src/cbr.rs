//! Официальные курсы ЦБ РФ: разбор ежедневного XML и запись курсов в базу.
//!
//! Сам запрос к cbr.ru делает оболочка приложения; ядро получает уже скачанный
//! ответ, поэтому всё здесь проверяется тестами без сети.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::currencies::{self, base_currency};
use crate::money::Rate;
use crate::{time, Error, Result};

/// Адрес ежедневных курсов; дата добавляется параметром `date_req=ДД/ММ/ГГГГ`.
pub const DAILY_URL: &str = "https://www.cbr.ru/scripts/XML_daily.asp";

/// Адрес запроса курсов на дату `YYYY-MM-DD`.
pub fn daily_url(base: &str, date: &str) -> Result<String> {
    time::check_date(date)?;
    let (y, rest) = date.split_at(4);
    let (m, d) = (&rest[1..3], &rest[4..6]);
    Ok(format!("{base}?date_req={d}/{m}/{y}"))
}

/// Ответ ЦБ: дата, на которую установлены курсы, и рубли за одну единицу валюты.
#[derive(Debug, Clone, PartialEq)]
pub struct Daily {
    pub date: String,
    pub rub_per_unit: BTreeMap<String, Rate>,
}

fn bad(what: &str) -> Error {
    Error::Validation(format!("ЦБ РФ прислал непонятный ответ: {what}"))
}

/// Текст первого тега `<name>…</name>` внутри `xml`.
fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(xml[start..end].trim())
}

/// Разобрать ответ `XML_daily.asp`. Ответ приходит в windows-1251, но коды,
/// даты и числа в нём латинские, поэтому русские названия валют не нужны.
pub fn parse_daily(bytes: &[u8]) -> Result<Daily> {
    let xml = String::from_utf8_lossy(bytes);
    let head_start = xml
        .find("<ValCurs")
        .ok_or_else(|| bad("нет списка курсов"))?;
    let head_end = xml[head_start..]
        .find('>')
        .ok_or_else(|| bad("нет списка курсов"))?
        + head_start;
    let head = &xml[head_start..head_end];
    let raw_date = head
        .split("Date=\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .ok_or_else(|| bad("нет даты"))?;
    let date = match raw_date.split('.').collect::<Vec<_>>()[..] {
        [d, m, y] => format!("{y}-{m}-{d}"),
        _ => return Err(bad("дата")),
    };
    time::check_date(&date).map_err(|_| bad("дата"))?;

    let mut rub_per_unit = BTreeMap::new();
    for chunk in xml[head_end..].split("<Valute").skip(1) {
        let body = chunk.split("</Valute>").next().unwrap_or_default();
        let code = tag(body, "CharCode").ok_or_else(|| bad("нет кода валюты"))?;
        // VunitRate — уже курс за одну единицу; в старых ответах его нет.
        let rate = match tag(body, "VunitRate") {
            Some(unit) => Rate::parse(unit)?,
            None => {
                let value = Rate::parse(tag(body, "Value").ok_or_else(|| bad("нет курса"))?)?;
                let nominal = Rate::parse(tag(body, "Nominal").unwrap_or("1"))?;
                value.divide(&nominal).ok_or_else(|| bad("курс"))?
            }
        };
        rub_per_unit.insert(code.to_uppercase(), rate);
    }
    if rub_per_unit.is_empty() {
        return Err(bad("курсов нет"));
    }
    Ok(Daily { date, rub_per_unit })
}

/// Итог загрузки для окна настроек.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Дата, на которую ЦБ установил курсы (может быть раньше запрошенной: выходные).
    pub date: String,
    /// Валюты, для которых записан курс.
    pub updated: Vec<String>,
    /// Валюты с курсом, введённым вручную на ту же дату: его не трогаем.
    pub kept_manual: Vec<String>,
    /// Валюты, которых нет в списке ЦБ.
    pub missing: Vec<String>,
}

/// Валюты, для которых нужен курс: валюты счетов и долгов и те, у которых уже
/// есть хоть один курс, кроме основной.
pub fn wanted_currencies(conn: &Connection) -> Result<Vec<String>> {
    let base = base_currency(conn)?;
    let mut stmt = conn.prepare(
        "SELECT currency_code FROM accounts
         UNION SELECT currency_code FROM debts
         UNION SELECT from_code FROM exchange_rates
         UNION SELECT to_code FROM exchange_rates",
    )?;
    let codes = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out: Vec<String> = codes
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|c| *c != base)
        .collect();
    out.sort();
    Ok(out)
}

/// Записать курсы ЦБ к основной валюте с источником «ЦБ РФ».
/// Для основной валюты не в рублях курс считается через рубль (кросс-курс).
pub fn import(conn: &Connection, daily: &Daily) -> Result<ImportResult> {
    let base = base_currency(conn)?;
    let rub = |code: &str| -> Option<Rate> {
        if code == "RUB" {
            Rate::parse("1").ok()
        } else {
            daily.rub_per_unit.get(code).copied()
        }
    };
    let mut result = ImportResult {
        date: daily.date.clone(),
        ..Default::default()
    };
    let Some(base_rub) = rub(&base) else {
        result.missing.push(base);
        return Ok(result);
    };
    for code in wanted_currencies(conn)? {
        currencies::get(conn, &code)?;
        let Some(rate) = rub(&code).and_then(|r| r.divide(&base_rub)) else {
            result.missing.push(code);
            continue;
        };
        let existing: Option<String> = conn
            .query_row(
                "SELECT source FROM exchange_rates WHERE date = ?1 AND from_code = ?2 AND to_code = ?3",
                params![daily.date, code, base],
                |r| r.get(0),
            )
            .optional()?;
        if existing.as_deref() == Some("manual") {
            result.kept_manual.push(code);
            continue;
        }
        conn.execute(
            "INSERT INTO exchange_rates (date, from_code, to_code, rate, source) VALUES (?1, ?2, ?3, ?4, 'cbr')
             ON CONFLICT (date, from_code, to_code) DO UPDATE SET rate = excluded.rate, source = 'cbr'",
            params![daily.date, code, base, rate.to_string()],
        )?;
        result.updated.push(code);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    /// Сокращённый настоящий ответ ЦБ (в windows-1251 названия были бы кракозябрами).
    const SAMPLE: &str = r#"<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="18.10.2026" name="Foreign Currency Market">
<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>92,1500</Value><VunitRate>92,15</VunitRate></Valute>
<Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Name>Евро</Name><Value>100,5000</Value><VunitRate>100,5</VunitRate></Valute>
<Valute ID="R01820"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>Иен</Name><Value>61,2345</Value></Valute>
</ValCurs>"#;

    fn r(s: &str) -> Rate {
        Rate::parse(s).unwrap()
    }

    #[test]
    fn url_has_russian_date() {
        assert_eq!(
            daily_url(DAILY_URL, "2026-10-05").unwrap(),
            "https://www.cbr.ru/scripts/XML_daily.asp?date_req=05/10/2026"
        );
        assert!(daily_url(DAILY_URL, "05.10.2026").is_err());
    }

    #[test]
    fn parses_daily_xml() {
        let d = parse_daily(SAMPLE.as_bytes()).unwrap();
        assert_eq!(d.date, "2026-10-18");
        assert_eq!(d.rub_per_unit["USD"], r("92.15"));
        assert_eq!(d.rub_per_unit["EUR"], r("100.5"));
        // Без VunitRate: 61,2345 за 100 иен.
        assert_eq!(d.rub_per_unit["JPY"], r("0.612345"));
    }

    #[test]
    fn parses_windows_1251_bytes() {
        let mut bytes = SAMPLE.replace("Доллар США", "").into_bytes();
        bytes.extend_from_slice(&[0xC4, 0xEE, 0xEB]); // «Дол» в windows-1251 после конца.
        assert_eq!(parse_daily(&bytes).unwrap().rub_per_unit.len(), 3);
    }

    #[test]
    fn rejects_garbage() {
        for bad in [
            "",
            "<html>Сервис недоступен</html>",
            r#"<ValCurs Date="18.10.2026"></ValCurs>"#,
            r#"<ValCurs Date="2026-10-18"><Valute><CharCode>USD</CharCode><Value>1</Value></Valute></ValCurs>"#,
            r#"<ValCurs Date="18.10.2026"><Valute><CharCode>USD</CharCode><Value>abc</Value></Valute></ValCurs>"#,
        ] {
            assert!(
                parse_daily(bad.as_bytes()).is_err(),
                "должно быть ошибкой: {bad}"
            );
        }
    }

    fn add_account(c: &Connection, currency: &str) {
        c.execute(
            "INSERT INTO accounts (id, name, type, currency_code, opening_date, created_at, updated_at)
             VALUES (?1, ?1, 'cash', ?2, '2026-01-01', '', '')",
            params![format!("acc-{currency}"), currency],
        )
        .unwrap();
    }

    #[test]
    fn imports_rates_for_user_currencies_only() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        add_account(c, "RUB");
        add_account(c, "USD");
        add_account(c, "GBP");
        let daily = parse_daily(SAMPLE.as_bytes()).unwrap();

        let res = import(c, &daily).unwrap();
        assert_eq!(res.date, "2026-10-18");
        assert_eq!(res.updated, vec!["USD"]);
        assert_eq!(res.missing, vec!["GBP"]);
        let rates = currencies::list_rates(c).unwrap();
        assert_eq!(rates.len(), 1);
        assert_eq!(
            (rates[0].rate.as_str(), rates[0].source.as_str()),
            ("92.15", "cbr")
        );
        assert_eq!(
            currencies::convert(c, 100, "USD", "RUB", "2026-10-20").unwrap(),
            Some(9_215)
        );

        // Повторная загрузка заменяет курс ЦБ, а не дублирует.
        let mut next = daily.clone();
        next.rub_per_unit.insert("USD".into(), r("93"));
        import(c, &next).unwrap();
        assert_eq!(currencies::list_rates(c).unwrap()[0].rate, "93");
    }

    #[test]
    fn keeps_manual_rate_on_same_date() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        add_account(c, "USD");
        add_account(c, "EUR");
        currencies::set_rate(c, "2026-10-18", "USD", "RUB", "95").unwrap();
        let res = import(c, &parse_daily(SAMPLE.as_bytes()).unwrap()).unwrap();
        assert_eq!(res.updated, vec!["EUR"]);
        assert_eq!(res.kept_manual, vec!["USD"]);
        assert_eq!(
            currencies::rate_on(c, "USD", "RUB", "2026-10-18")
                .unwrap()
                .as_deref(),
            Some("95")
        );
    }

    #[test]
    fn cross_rates_for_non_ruble_base() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::settings::set(c, "base_currency", "USD").unwrap();
        add_account(c, "RUB");
        add_account(c, "EUR");
        add_account(c, "USD");
        let res = import(c, &parse_daily(SAMPLE.as_bytes()).unwrap()).unwrap();
        assert_eq!(res.updated, vec!["EUR", "RUB"]);
        // 100,5 / 92,15 и 1 / 92,15 с десятью знаками.
        assert_eq!(
            currencies::rate_on(c, "EUR", "USD", "2026-10-18")
                .unwrap()
                .as_deref(),
            Some("1.0906131308")
        );
        assert_eq!(
            currencies::rate_on(c, "RUB", "USD", "2026-10-18")
                .unwrap()
                .as_deref(),
            Some("0.0108518719")
        );
        assert_eq!(
            currencies::convert(c, 921_500, "RUB", "USD", "2026-10-18").unwrap(),
            Some(10_000)
        );
    }

    #[test]
    fn nothing_to_do_without_foreign_currencies() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        add_account(c, "RUB");
        let res = import(c, &parse_daily(SAMPLE.as_bytes()).unwrap()).unwrap();
        assert!(res.updated.is_empty() && res.missing.is_empty());
    }
}
