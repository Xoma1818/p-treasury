//! Инвестиции («инвест-копилка»): брокерские счета, ИИС и ПДС.
//!
//! Пополнение инвестиционного счёта — обычный перевод, не трата. Вложено —
//! начальный остаток плюс переводы на счёт минус переводы со счёта. Стоимость
//! пользователь вводит раз в месяц из приложения брокера; переводы после
//! последней оценки добавляются к ней. Разница стоимости и вложенного —
//! результат инвестиций, он не попадает в доходы и расходы бюджета.

use chrono::Datelike;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::assets::Valuation;
use crate::error::invalid;
use crate::{accounts, budgets, currencies, reports, settings, time, Error, Result};

/// Вид инвестиционного счёта: обычный брокерский, ИИС или ПДС.
pub const INVEST_KINDS: &[&str] = &["broker", "iis", "pds"];

/// Общий лимит взносов на ИИС-3 и ПДС для вычета, в копейках (400 000 ₽ в год).
pub const TAX_LIMIT: i64 = 40_000_000;

/// Ставка налога, с которой считается вычет, %.
const TAX_RATE: i64 = 13;

/// Последняя оценка счёта на дату включительно.
fn last_value(conn: &Connection, account_id: &str, on: &str) -> Result<Option<(String, i64)>> {
    Ok(conn
        .query_row(
            "SELECT date, value FROM account_values WHERE account_id = ?1 AND date <= ?2
             ORDER BY date DESC LIMIT 1",
            params![account_id, on],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// Стоимость счёта на дату и дата последней оценки. Без оценки стоимость
/// равна остатку по операциям.
pub fn value_on(conn: &Connection, account_id: &str, on: &str) -> Result<(i64, Option<String>)> {
    let balance = accounts::balance(conn, account_id, Some(on))?;
    Ok(match last_value(conn, account_id, on)? {
        Some((date, value)) => {
            let at_valuation = accounts::balance(conn, account_id, Some(&date))?;
            (value + balance - at_valuation, Some(date))
        }
        None => (balance, None),
    })
}

/// Сколько вложено в счёт на дату: начальный остаток и переводы (доходы и
/// расходы внутри счёта — дивиденды, комиссии — это уже результат).
pub fn invested_on(conn: &Connection, account_id: &str, on: &str) -> Result<i64> {
    conn.query_row(
        "SELECT a.opening_balance
            + COALESCE((SELECT sum(t.to_amount) FROM transactions t
                        WHERE t.to_account_id = a.id AND t.type = 'transfer'
                          AND t.status = 'cleared' AND t.date <= ?2), 0)
            - COALESCE((SELECT sum(t.amount) FROM transactions t
                        WHERE t.account_id = a.id AND t.type = 'transfer'
                          AND t.status = 'cleared' AND t.date <= ?2), 0)
         FROM accounts a WHERE a.id = ?1",
        params![account_id, on],
        |r| r.get(0),
    )
    .optional()?
    .ok_or(Error::NotFound("счёт"))
}

fn check_account(conn: &Connection, account_id: &str) -> Result<accounts::Account> {
    let account = accounts::get(conn, account_id)?;
    if account.kind != "investment" {
        return invalid("стоимость вводится только для брокерского счёта или ИИС");
    }
    Ok(account)
}

/// Записать стоимость счёта на дату; повторная оценка той же датой заменяет прежнюю.
pub fn set_value(conn: &Connection, account_id: &str, date: &str, value: i64) -> Result<()> {
    time::check_date(date)?;
    if value < 0 {
        return invalid("стоимость не может быть отрицательной");
    }
    if check_account(conn, account_id)?.archived {
        return invalid("счёт закрыт");
    }
    conn.execute(
        "INSERT INTO account_values (account_id, date, value) VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id, date) DO UPDATE SET value = excluded.value",
        params![account_id, date, value],
    )?;
    Ok(())
}

pub fn delete_value(conn: &Connection, account_id: &str, date: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM account_values WHERE account_id = ?1 AND date = ?2",
        params![account_id, date],
    )?;
    if n == 0 {
        return Err(Error::NotFound("оценка"));
    }
    Ok(())
}

fn history(conn: &Connection, account_id: &str) -> Result<Vec<Valuation>> {
    let mut stmt = conn.prepare(
        "SELECT date, value FROM account_values WHERE account_id = ?1 ORDER BY date DESC",
    )?;
    let rows = stmt.query_map([account_id], |r| {
        Ok(Valuation {
            date: r.get(0)?,
            value: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Переводы между инвестиционными и остальными счетами за период в основной
/// валюте: пополнения минус выводы. `kinds` ограничивает виды инвестиционных
/// счетов (для вычета — только ИИС и ПДС), `inflow_only` — только пополнения.
fn contributions(
    conn: &Connection,
    from: &str,
    to: &str,
    kinds: &[&str],
    inflow_only: bool,
    base: &str,
    missing: &mut Vec<String>,
) -> Result<i64> {
    let mut stmt = conn.prepare(
        "SELECT t.date, t.amount, fa.currency_code, t.to_amount, ta.currency_code,
                fa.type = 'investment', COALESCE(fa.invest_kind, ''),
                ta.type = 'investment', COALESCE(ta.invest_kind, '')
         FROM transactions t
         JOIN accounts fa ON fa.id = t.account_id
         JOIN accounts ta ON ta.id = t.to_account_id
         WHERE t.type = 'transfer' AND t.status = 'cleared' AND t.date BETWEEN ?1 AND ?2
           AND (fa.type = 'investment') <> (ta.type = 'investment')",
    )?;
    type Row = (String, i64, String, i64, String, bool, String, bool, String);
    let rows: Vec<Row> = stmt
        .query_map(params![from, to], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut sum = 0;
    for (date, amount, from_cur, to_amount, to_cur, from_inv, from_kind, _, to_kind) in rows {
        // Пополнение считается по сумме, ушедшей из бюджета; вывод — по пришедшей.
        let (sign, amount, currency, kind) = if from_inv {
            (-1, to_amount, to_cur, from_kind)
        } else {
            (1, amount, from_cur, to_kind)
        };
        if !kinds.contains(&kind.as_str()) || (inflow_only && sign < 0) {
            continue;
        }
        match currencies::convert(conn, amount, &currency, base, &date)? {
            Some(v) => sum += sign * v,
            None if !missing.contains(&currency) => missing.push(currency),
            None => {}
        }
    }
    Ok(sum)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// `""` — не задан, `amount` — сумма, `percent` — процент от доходов месяца.
    pub mode: String,
    /// Сумма в основной валюте или процент.
    pub value: i64,
    /// План задан только для этого месяца, а не общий на каждый месяц.
    pub only_month: bool,
}

/// Общий план на каждый месяц.
pub fn plan(conn: &Connection) -> Result<Plan> {
    let mode = settings::get(conn, "invest_plan_mode")?.unwrap_or_default();
    let value = settings::get(conn, "invest_plan_value")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    Ok(normalize(mode, value, false))
}

fn normalize(mode: String, value: i64, only_month: bool) -> Plan {
    match mode.as_str() {
        "amount" | "percent" if value > 0 => Plan {
            mode,
            value,
            only_month,
        },
        _ => Plan {
            mode: String::new(),
            value: 0,
            only_month,
        },
    }
}

/// План месяца: свой для месяца, если задан, иначе общий.
pub fn plan_for(conn: &Connection, month: &str) -> Result<Plan> {
    let own: Option<(String, i64)> = conn
        .query_row(
            "SELECT mode, value FROM invest_month_plans WHERE month = ?1",
            [month],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match own {
        Some((mode, value)) => Ok(normalize(mode, value, true)),
        None => plan(conn),
    }
}

fn check_plan(mode: &str, value: i64) -> Result<i64> {
    match mode {
        "" => {}
        "amount" if value > 0 => {}
        "percent" if (1..=100).contains(&value) => {}
        "amount" => return invalid("введите сумму больше нуля"),
        "percent" => return invalid("процент от доходов — от 1 до 100"),
        _ => return invalid("план: сумма или процент от доходов"),
    }
    Ok(if mode.is_empty() { 0 } else { value })
}

/// Задать общий план на каждый месяц; `mode = ""` убирает план.
pub fn set_plan(conn: &Connection, mode: &str, value: i64) -> Result<()> {
    let value = check_plan(mode, value)?;
    settings::set(conn, "invest_plan_mode", mode)?;
    settings::set(conn, "invest_plan_value", &value.to_string())
}

/// Свой план на один месяц (`2026-12`); `mode = ""` — в этом месяце не откладывать.
pub fn set_month_plan(conn: &Connection, month: &str, mode: &str, value: i64) -> Result<()> {
    budgets::period(month, 1)?;
    let value = check_plan(mode, value)?;
    conn.execute(
        "INSERT INTO invest_month_plans (month, mode, value) VALUES (?1, ?2, ?3)
         ON CONFLICT (month) DO UPDATE SET mode = excluded.mode, value = excluded.value",
        params![month, mode, value],
    )?;
    Ok(())
}

/// Вернуть месяцу общий план.
pub fn clear_month_plan(conn: &Connection, month: &str) -> Result<()> {
    conn.execute("DELETE FROM invest_month_plans WHERE month = ?1", [month])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthProgress {
    pub month: String,
    pub start: String,
    pub end: String,
    pub plan: Plan,
    /// План в основной валюте; для процента — от доходов месяца. `None` без плана.
    pub planned: Option<i64>,
    /// Доходы месяца (для плана в процентах).
    pub income: i64,
    /// Отложено за месяц: переводы на инвестиционные счета минус выводы.
    pub saved: i64,
    /// Процент выполнения плана.
    pub percent: Option<i64>,
    pub missing_rates: Vec<String>,
}

/// Сколько отложено на инвестиции за месяц бюджета (`2026-10`) и план.
pub fn month_progress(conn: &Connection, month: &str) -> Result<MonthProgress> {
    let p = budgets::period(month, budgets::start_day(conn)?)?;
    let base = currencies::base_currency(conn)?;
    let mut missing = Vec::new();
    let saved = contributions(
        conn,
        &p.start,
        &p.end,
        INVEST_KINDS,
        false,
        &base,
        &mut missing,
    )?;
    let plan = plan_for(conn, &p.month)?;
    let summary = reports::period_summary(conn, &p.start, &p.end)?;
    for c in summary.missing_rates {
        if !missing.contains(&c) {
            missing.push(c);
        }
    }
    let planned = match plan.mode.as_str() {
        "amount" => Some(plan.value),
        // Процент от доходов, округлённый до рубля.
        "percent" => {
            let unit = 10i64.pow(currencies::minor_units(conn, &base)?);
            Some((summary.income.max(0) * plan.value / 100 + unit / 2) / unit * unit)
        }
        _ => None,
    };
    let percent = planned
        .filter(|&v| v > 0)
        .map(|v| reports::percent(saved.max(0), v));
    Ok(MonthProgress {
        month: p.month,
        start: p.start,
        end: p.end,
        plan,
        planned,
        income: summary.income,
        saved,
        percent,
        missing_rates: missing,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestAccount {
    pub id: String,
    pub name: String,
    pub invest_kind: String,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub invested: i64,
    pub value: i64,
    pub result: i64,
    /// Дата последней оценки; `None` — стоимость ещё не вводили.
    pub valued_on: Option<String>,
    /// Все оценки, новые сверху.
    pub history: Vec<Valuation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaxYear {
    pub year: i32,
    /// Внесено за календарный год на ИИС и ПДС, ₽ в копейках.
    pub contributed: i64,
    pub limit: i64,
    /// Сколько ещё можно внести для полного вычета.
    pub left: i64,
    /// Вычет 13 % со взносов в пределах лимита.
    pub deduction: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub base_currency: String,
    pub base_symbol: String,
    pub accounts: Vec<InvestAccount>,
    /// Итоги по открытым счетам в основной валюте.
    pub invested: i64,
    pub value: i64,
    pub result: i64,
    /// Результат в десятых долях процента от вложенного (67 = 6,7 %).
    pub result_tenths: Option<i64>,
    pub month: MonthProgress,
    /// Есть ИИС или ПДС — лимит вычета за текущий год.
    pub tax: Option<TaxYear>,
    /// Дивиденды и купоны за текущий год (категории доходов с этими словами).
    pub passive_income: i64,
    pub missing_rates: Vec<String>,
}

/// Категории доходов от инвестиций: в названии (своём или родителя) есть
/// «дивиденд» или «купон».
fn passive_income(
    conn: &Connection,
    from: &str,
    to: &str,
    base: &str,
    missing: &mut Vec<String>,
) -> Result<i64> {
    let mut stmt = conn.prepare(
        "SELECT t.date, t.amount, a.currency_code, c.name, COALESCE(p.name, '')
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         WHERE t.type = 'income' AND t.status = 'cleared' AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows: Vec<(String, i64, String, String, String)> = stmt
        .query_map(params![from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let is_passive = |name: &str| {
        let n = name.to_lowercase();
        n.contains("дивиденд") || n.contains("купон")
    };
    let mut sum = 0;
    for (date, amount, currency, name, parent) in rows {
        if !is_passive(&name) && !is_passive(&parent) {
            continue;
        }
        match currencies::convert(conn, amount, &currency, base, &date)? {
            Some(v) => sum += v,
            None if !missing.contains(&currency) => missing.push(currency),
            None => {}
        }
    }
    Ok(sum)
}

/// Всё для раздела «Инвестиции» на дату `today`.
pub fn overview(conn: &Connection, today: &str) -> Result<Overview> {
    time::check_date(today)?;
    let base = currencies::base_currency(conn)?;
    let base_symbol = currencies::get(conn, &base)?.symbol;
    let mut missing = Vec::new();
    let (mut invested, mut value) = (0, 0);
    let mut list = Vec::new();
    let mut has_tax_account = false;
    for a in accounts::list(conn, false)?
        .into_iter()
        .filter(|a| a.kind == "investment")
    {
        let kind = a.invest_kind.clone().unwrap_or_else(|| "broker".into());
        has_tax_account |= kind != "broker";
        let inv = invested_on(conn, &a.id, today)?;
        let (val, valued_on) = value_on(conn, &a.id, today)?;
        if a.include_in_total {
            match (
                currencies::convert(conn, inv, &a.currency_code, &base, today)?,
                currencies::convert(conn, val, &a.currency_code, &base, today)?,
            ) {
                (Some(i), Some(v)) => {
                    invested += i;
                    value += v;
                }
                _ if !missing.contains(&a.currency_code) => missing.push(a.currency_code.clone()),
                _ => {}
            }
        }
        list.push(InvestAccount {
            history: history(conn, &a.id)?,
            id: a.id,
            name: a.name,
            invest_kind: kind,
            currency_code: a.currency_code,
            currency_symbol: a.currency_symbol,
            minor_units: a.minor_units,
            invested: inv,
            value: val,
            result: val - inv,
            valued_on,
        });
    }
    let month = month_progress(conn, &budgets::month_of(conn, today)?.month)?;
    let year = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .expect("проверено")
        .year();
    let (jan, dec) = (format!("{year}-01-01"), format!("{year}-12-31"));
    let tax = if has_tax_account {
        let contributed =
            contributions(conn, &jan, &dec, &["iis", "pds"], true, "RUB", &mut missing)?;
        Some(TaxYear {
            year,
            contributed,
            limit: TAX_LIMIT,
            left: (TAX_LIMIT - contributed).max(0),
            deduction: contributed.clamp(0, TAX_LIMIT) * TAX_RATE / 100,
        })
    } else {
        None
    };
    let passive_income = passive_income(conn, &jan, &dec, &base, &mut missing)?;
    for c in &month.missing_rates {
        if !missing.contains(c) {
            missing.push(c.clone());
        }
    }
    let result = value - invested;
    Ok(Overview {
        base_currency: base,
        base_symbol,
        accounts: list,
        invested,
        value,
        result,
        result_tenths: (invested > 0)
            .then(|| (result * 1000 + invested / 2 * result.signum()) / invested),
        month,
        tax,
        passive_income,
        missing_rates: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;
    use crate::storage::{migrate, MIGRATIONS};
    use crate::transactions::{self, TxnInput};

    fn txn(kind: &str, date: &str, account: &str, amount: i64) -> TxnInput {
        TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: account.into(),
            amount,
            category_id: None,
            to_account_id: None,
            to_amount: None,
            payee: None,
            note: None,
        }
    }

    fn broker(c: &Connection, name: &str, kind: &str, opening: i64) -> String {
        accounts::create(
            c,
            &accounts::AccountInput {
                invest_kind: Some(kind.into()),
                ..input(name, "investment", "RUB", opening)
            },
        )
        .unwrap()
    }

    fn transfer(c: &Connection, date: &str, from: &str, to: &str, amount: i64) {
        transactions::create(
            c,
            &TxnInput {
                to_account_id: Some(to.into()),
                to_amount: Some(amount),
                ..txn("transfer", date, from, amount)
            },
        )
        .unwrap();
    }

    #[test]
    fn invested_value_and_result() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 10_000_000)).unwrap();
        let iis = broker(c, "ИИС", "iis", 10_000_000);
        transfer(c, "2026-10-05", &card, &iis, 2_000_000);
        // Стоимость без оценки — остаток по операциям.
        assert_eq!(invested_on(c, &iis, "2026-10-20").unwrap(), 12_000_000);
        assert_eq!(value_on(c, &iis, "2026-10-20").unwrap(), (12_000_000, None));
        set_value(c, &iis, "2026-10-10", 12_500_000).unwrap();
        // Пополнение после оценки прибавляется к ней.
        transfer(c, "2026-10-15", &card, &iis, 500_000);
        assert_eq!(
            value_on(c, &iis, "2026-10-20").unwrap(),
            (13_000_000, Some("2026-10-10".into()))
        );
        // До оценки — по операциям.
        assert_eq!(value_on(c, &iis, "2026-10-09").unwrap().0, 12_000_000);
        // Общий баланс считает инвестиционный счёт по стоимости.
        let total = accounts::totals(c, "2026-10-20").unwrap().total;
        assert_eq!(total, 10_000_000 - 2_500_000 + 13_000_000);
        let o = overview(c, "2026-10-20").unwrap();
        assert_eq!(
            (o.invested, o.value, o.result),
            (12_500_000, 13_000_000, 500_000)
        );
        assert_eq!(o.result_tenths, Some(40));
        assert_eq!(o.accounts[0].history.len(), 1);
        // Повторная оценка той же датой заменяет прежнюю, удаление возвращает расчёт.
        set_value(c, &iis, "2026-10-10", 11_000_000).unwrap();
        assert_eq!(value_on(c, &iis, "2026-10-20").unwrap().0, 11_500_000);
        delete_value(c, &iis, "2026-10-10").unwrap();
        assert_eq!(value_on(c, &iis, "2026-10-20").unwrap().0, 12_500_000);
        assert!(set_value(c, &card, "2026-10-10", 1).is_err());
        assert!(set_value(c, &iis, "2026-10-10", -1).is_err());
    }

    #[test]
    fn month_plan_and_saved() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let br = broker(c, "Брокер", "broker", 0);
        let salary = crate::categories::list(c, false)
            .unwrap()
            .into_iter()
            .find(|x| x.name == "Зарплата")
            .unwrap()
            .id;
        transactions::create(
            c,
            &TxnInput {
                category_id: Some(salary),
                ..txn("income", "2026-10-01", &card, 15_000_000)
            },
        )
        .unwrap();
        transfer(c, "2026-10-02", &card, &br, 2_000_000);
        transfer(c, "2026-10-20", &br, &card, 500_000);
        transfer(c, "2026-11-02", &card, &br, 700_000);
        let m = month_progress(c, "2026-10").unwrap();
        assert_eq!((m.saved, m.planned, m.percent), (1_500_000, None, None));
        set_plan(c, "amount", 2_000_000).unwrap();
        let m = month_progress(c, "2026-10").unwrap();
        assert_eq!((m.planned, m.percent), (Some(2_000_000), Some(75)));
        set_plan(c, "percent", 10).unwrap();
        assert_eq!(
            month_progress(c, "2026-10").unwrap().planned,
            Some(1_500_000)
        );
        assert!(set_plan(c, "percent", 0).is_err());
        assert!(set_plan(c, "amount", -5).is_err());
        assert!(set_plan(c, "weekly", 5).is_err());
        // Свой план на месяц важнее общего; соседние месяцы его не видят.
        set_month_plan(c, "2026-10", "amount", 4_000_000).unwrap();
        let m = month_progress(c, "2026-10").unwrap();
        assert_eq!((m.planned, m.plan.only_month), (Some(4_000_000), true));
        assert_eq!(month_progress(c, "2026-11").unwrap().planned, Some(0));
        set_month_plan(c, "2026-10", "", 0).unwrap();
        assert_eq!(month_progress(c, "2026-10").unwrap().planned, None);
        clear_month_plan(c, "2026-10").unwrap();
        assert_eq!(
            month_progress(c, "2026-10").unwrap().planned,
            Some(1_500_000)
        );
        assert!(set_month_plan(c, "2026-13", "amount", 1).is_err());
        set_plan(c, "", 0).unwrap();
        assert_eq!(plan(c).unwrap().mode, "");
    }

    #[test]
    fn tax_limit_and_passive_income() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let br = broker(c, "Брокер", "broker", 0);
        assert!(overview(c, "2026-10-20").unwrap().tax.is_none());
        let iis = broker(c, "ИИС", "iis", 0);
        let pds = broker(c, "ПДС", "pds", 0);
        transfer(c, "2025-12-30", &card, &iis, 10_000_000);
        transfer(c, "2026-03-01", &card, &iis, 20_000_000);
        transfer(c, "2026-04-01", &card, &pds, 5_000_000);
        transfer(c, "2026-05-01", &card, &br, 30_000_000);
        let tax = overview(c, "2026-10-20").unwrap().tax.unwrap();
        assert_eq!((tax.year, tax.contributed), (2026, 25_000_000));
        assert_eq!((tax.left, tax.deduction), (15_000_000, 3_250_000));
        transfer(c, "2026-06-01", &card, &iis, 30_000_000);
        let tax = overview(c, "2026-10-20").unwrap().tax.unwrap();
        assert_eq!((tax.left, tax.deduction), (0, 5_200_000));

        let div = crate::categories::list(c, false)
            .unwrap()
            .into_iter()
            .find(|x| x.name == "Дивиденды и купоны")
            .unwrap()
            .id;
        transactions::create(
            c,
            &TxnInput {
                category_id: Some(div),
                ..txn("income", "2026-07-15", &card, 320_000)
            },
        )
        .unwrap();
        assert_eq!(overview(c, "2026-10-20").unwrap().passive_income, 320_000);
    }

    #[test]
    fn migration_adds_dividend_category_once() {
        let count = |c: &Connection| -> i64 {
            c.query_row(
                "SELECT count(*) FROM categories WHERE name = 'Дивиденды и купоны'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let add = |c: &Connection, name: &str| {
            c.execute(
                "INSERT INTO categories (id, name, kind, created_at, updated_at)
                 VALUES (?1, ?2, 'income', '', '')",
                params![crate::ids::new_id(), name],
            )
            .unwrap();
        };
        // Пустая база: категории придут с набором по умолчанию.
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, MIGRATIONS).unwrap();
        assert_eq!(count(&c), 0);
        // Набор уже был — категория добавляется.
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, &MIGRATIONS[..4]).unwrap();
        add(&c, "Зарплата");
        migrate(&mut c, MIGRATIONS).unwrap();
        assert_eq!(count(&c), 1);
        // Своя такая же категория — не дублируется.
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, &MIGRATIONS[..4]).unwrap();
        add(&c, "Дивиденды и купоны");
        migrate(&mut c, MIGRATIONS).unwrap();
        assert_eq!(count(&c), 1);
    }
}
