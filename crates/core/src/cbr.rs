//! Официальные курсы ЦБ РФ: разбор ежедневного XML и запись курсов в базу.
//!
//! Сам запрос к cbr.ru делает оболочка приложения; ядро получает уже скачанный
//! ответ, поэтому всё здесь проверяется тестами без сети.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::currencies::{self, base_currency};
use crate::money::Rate;
use crate::{settings, time, Error, Result};

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
        // VunitRate — уже курс за одну единицу; в старых ответах его нет, а у очень
        // дешёвых валют он записан как 4,47935E-05. Тогда считаем Value / Nominal.
        // Валюта с нечитаемым курсом пропускается, чтобы не сорвать загрузку остальных.
        let per_unit = || {
            let value = Rate::parse(tag(body, "Value")?).ok()?;
            let nominal = Rate::parse(tag(body, "Nominal").unwrap_or("1")).ok()?;
            value.divide(&nominal)
        };
        let rate = tag(body, "VunitRate")
            .and_then(|unit| Rate::parse(unit).ok())
            .or_else(per_unit);
        if let Some(rate) = rate {
            rub_per_unit.insert(code.to_uppercase(), rate);
        }
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

/// Основные валюты: их курс загружается всегда, даже без таких счетов.
pub const MAIN_CURRENCIES: &[&str] = &["CNY", "EUR", "GBP", "KZT", "RUB", "USD"];

/// Валюты пользователя, которым нужен курс: валюты счетов и долгов и те, у
/// которых уже есть хоть один курс, кроме основной.
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
    let own = wanted_currencies(conn)?;
    let mut codes: Vec<String> = MAIN_CURRENCIES
        .iter()
        .map(|c| c.to_string())
        .filter(|c| *c != base)
        .chain(own.iter().cloned())
        .collect();
    codes.sort();
    codes.dedup();
    for code in codes {
        currencies::get(conn, &code)?;
        let Some(rate) = rub(&code).and_then(|r| r.divide(&base_rub)) else {
            // Об отсутствии курса говорим только для валют пользователя.
            if own.contains(&code) {
                result.missing.push(code);
            }
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

/// Нужна ли автозагрузка курсов на дату: включена и сегодня ещё не было.
pub fn auto_due(conn: &Connection, date: &str) -> Result<bool> {
    let on = settings::get(conn, "rates_auto")?.as_deref() != Some("0");
    let last = settings::get(conn, "rates_auto_date")?.unwrap_or_default();
    Ok(on && last.as_str() < date)
}

/// Автозагрузка: записать курсы и запомнить дату, чтобы до завтра не повторять.
pub fn auto_import(conn: &Connection, date: &str, daily: &Daily) -> Result<ImportResult> {
    let result = import(conn, daily)?;
    settings::set(conn, "rates_auto_date", date)?;
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
    fn tiny_rate_in_exponent_form_does_not_break_import() {
        // Так ЦБ присылает курс иранского риала: за единицу 4,47935E-05 рубля.
        let xml = SAMPLE.replace(
            "</ValCurs>",
            "<Valute ID=\"R01300\"><CharCode>IRR</CharCode><Nominal>10000</Nominal><Value>0,4479</Value><VunitRate>4,47935E-05</VunitRate></Valute>\n\
             <Valute ID=\"R09999\"><CharCode>XXX</CharCode><Nominal>1</Nominal><Value>н/д</Value><VunitRate>н/д</VunitRate></Valute>\n</ValCurs>",
        );
        let d = parse_daily(xml.as_bytes()).unwrap();
        assert_eq!(d.rub_per_unit["USD"], r("92.15"));
        assert_eq!(d.rub_per_unit["IRR"], r("0.00004479"));
        assert!(!d.rub_per_unit.contains_key("XXX"));
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
    fn imports_main_and_user_currencies() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        add_account(c, "RUB");
        add_account(c, "USD");
        add_account(c, "GBP");
        let daily = parse_daily(SAMPLE.as_bytes()).unwrap();

        let res = import(c, &daily).unwrap();
        assert_eq!(res.date, "2026-10-18");
        // EUR — основная валюта, грузится без счёта; JPY не нужна никому.
        assert_eq!(res.updated, vec!["EUR", "USD"]);
        // GBP есть у пользователя, но её нет в ответе; про CNY не говорим.
        assert_eq!(res.missing, vec!["GBP"]);
        let rates = currencies::list_rates(c).unwrap();
        assert_eq!(rates.len(), 2);
        let usd = rates.iter().find(|r| r.from_code == "USD").unwrap();
        assert_eq!((usd.rate.as_str(), usd.source.as_str()), ("92.15", "cbr"));
        assert_eq!(
            currencies::convert(c, 100, "USD", "RUB", "2026-10-20").unwrap(),
            Some(9_215)
        );

        // Повторная загрузка заменяет курс ЦБ, а не дублирует.
        let mut next = daily.clone();
        next.rub_per_unit.insert("USD".into(), r("93"));
        import(c, &next).unwrap();
        let rates = currencies::list_rates(c).unwrap();
        assert_eq!(rates.len(), 2);
        assert_eq!(
            rates.iter().find(|r| r.from_code == "USD").unwrap().rate,
            "93"
        );
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
    fn main_currencies_without_foreign_accounts() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        add_account(c, "RUB");
        let res = import(c, &parse_daily(SAMPLE.as_bytes()).unwrap()).unwrap();
        assert_eq!(res.updated, vec!["EUR", "USD"]);
        assert!(res.missing.is_empty());
    }

    #[test]
    fn auto_import_once_a_day_and_can_be_switched_off() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let daily = parse_daily(SAMPLE.as_bytes()).unwrap();
        assert!(auto_due(c, "2026-10-20").unwrap());
        auto_import(c, "2026-10-20", &daily).unwrap();
        // Сегодня уже загружено, завтра снова.
        assert!(!auto_due(c, "2026-10-20").unwrap());
        assert!(auto_due(c, "2026-10-21").unwrap());
        crate::settings::set(c, "rates_auto", "0").unwrap();
        assert!(!auto_due(c, "2026-10-21").unwrap());
        assert!(crate::settings::set(c, "rates_auto", "maybe").is_err());
    }
}
