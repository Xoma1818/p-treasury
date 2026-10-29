//! «Взгляд вперёд» (0.18): прогноз остатка на 12 месяцев, сценарии «что если»
//! и поток денег (docs/product/0.18-forecast.md).
//!
//! Прогноз не хранится, а считается каждый раз:
//! * старт — деньги на наличных, картах и вкладах «в общем балансе» сегодня
//!   (как у финансовой подушки);
//! * известное по датам — напоминания с суммой, платежи по графикам займов и
//!   запланированные операции;
//! * остальное — «обычные» доходы и траты: среднее по категориям за последние
//!   полные месяцы. Из среднего убраны платежи по займам, поездки и события,
//!   операции, отмеченные по напоминанию, и категории повторяющихся напоминаний —
//!   они уже посчитаны по датам, второй раз их не берём.
//!
//! Месяцы — бюджетные (настройка «первый день месяца»), как в бюджете и отчётах.

use std::collections::{HashMap, HashSet};

use chrono::NaiveTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::budgets::{self, Period};
use crate::error::invalid;
use crate::wealth::LIQUID_TYPES;
use crate::{accounts, categories, currencies, ids, reminders, reports, time, Result};

/// На сколько месяцев вперёд строится прогноз (текущий месяц входит).
pub const HORIZON: usize = 12;
/// Сколько прошлых полных месяцев берётся для обычных доходов и трат.
const HISTORY_MONTHS: i32 = 3;

/// Известная по дате сумма прогноза. `amount` со знаком: + приход, − расход,
/// в основной валюте.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Дата; у изменений сценария — первый день месяца.
    pub date: String,
    pub title: String,
    /// `reminder`, `debt`, `planned` или `change` (изменение сценария).
    pub kind: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioMonth {
    /// Насколько сценарий меняет итог месяца (со знаком).
    pub delta: i64,
    pub closing: i64,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Month {
    /// Бюджетный месяц `YYYY-MM`.
    pub month: String,
    pub start: String,
    pub end: String,
    /// Деньги на начало месяца (для текущего — сегодня).
    pub opening: i64,
    /// Обычные доходы и траты (по среднему); для текущего месяца — только то,
    /// что по среднему ещё осталось после уже случившегося.
    pub regular_income: i64,
    pub regular_expense: i64,
    /// Известные по датам приходы и расходы (положительные числа).
    pub planned_income: i64,
    pub planned_expense: i64,
    pub closing: i64,
    pub items: Vec<Item>,
    pub scenario: Option<ScenarioMonth>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub base_currency: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub today: String,
    /// Деньги сегодня: наличные, карты и вклады «в общем балансе».
    pub liquid: i64,
    /// Сколько прошлых месяцев вошло в среднее (0 — истории ещё нет).
    pub history_months: i64,
    pub avg_income: i64,
    pub avg_expense: i64,
    /// Категории, которые не вошли в среднее: их считают напоминания.
    pub excluded_categories: Vec<String>,
    pub months: Vec<Month>,
    /// Самый низкий остаток на конец месяца и месяц, когда он будет.
    pub lowest_month: String,
    pub lowest_balance: i64,
    /// Первый месяц, в конце которого денег меньше нуля.
    pub short_month: Option<String>,
    /// На сколько месяцев обычных трат хватит денег сегодня, в десятых.
    pub cushion_tenths: Option<i64>,
    pub scenario_id: Option<String>,
    pub scenario_name: Option<String>,
    pub scenario_lowest_balance: Option<i64>,
    pub scenario_short_month: Option<String>,
    pub missing_rates: Vec<String>,
}

fn add_missing(missing: &mut Vec<String>, code: String) {
    if !missing.contains(&code) {
        missing.push(code);
    }
}

/// Деньги на быстрых счетах «в общем балансе» на дату, в основной валюте.
fn liquid_on(conn: &Connection, base: &str, on: &str, missing: &mut Vec<String>) -> Result<i64> {
    let mut total = 0i64;
    for a in accounts::list(conn, false)?
        .into_iter()
        .filter(|a| a.include_in_total && LIQUID_TYPES.contains(&a.kind.as_str()))
    {
        let bal = accounts::balance(conn, &a.id, Some(on))?;
        match currencies::convert(conn, bal, &a.currency_code, base, on)? {
            Some(v) => total += v,
            None => add_missing(missing, a.currency_code),
        }
    }
    Ok(total)
}

/// Категории повторяющихся напоминаний с суммой: их суммы идут по датам.
fn reminder_categories(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT category_id FROM reminders
         WHERE active = 1 AND amount IS NOT NULL AND category_id IS NOT NULL AND repeat <> 'once'",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Обычные доходы и расходы по категориям за `[from, to]`: ключ — (тип, категория).
fn regular_by_category(
    conn: &Connection,
    base: &str,
    from: &str,
    to: &str,
    excluded: &HashSet<String>,
    missing: &mut Vec<String>,
) -> Result<HashMap<(String, String), i64>> {
    let mut stmt = conn.prepare(
        "SELECT t.type, t.category_id, t.date, t.amount, a.currency_code FROM txn_by_month t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type IN ('income', 'expense')
           AND t.debt_id IS NULL AND t.event_id IS NULL
           AND t.date BETWEEN ?1 AND ?2
           AND t.id NOT IN (SELECT transaction_id FROM reminder_occurrences
                            WHERE transaction_id IS NOT NULL)",
    )?;
    let rows: Vec<(String, String, String, i64, String)> = stmt
        .query_map(params![from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out: HashMap<(String, String), i64> = HashMap::new();
    for (kind, cat, date, amount, cur) in rows {
        if excluded.contains(&cat) {
            continue;
        }
        match currencies::convert(conn, amount, &cur, base, &date)? {
            Some(v) => *out.entry((kind, cat)).or_default() += v,
            None => add_missing(missing, cur),
        }
    }
    Ok(out)
}

/// Первая дата учёта: самая ранняя операция дохода или расхода.
fn first_activity(conn: &Connection) -> Result<Option<String>> {
    Ok(conn.query_row(
        "SELECT min(date) FROM transactions WHERE type IN ('expense', 'income') AND status = 'cleared'",
        [],
        |r| r.get(0),
    )?)
}

/// Известные по датам суммы с `today` по `last` включительно.
fn known_items(
    conn: &Connection,
    base: &str,
    today: &str,
    last: &str,
    missing: &mut Vec<String>,
) -> Result<Vec<Item>> {
    let mut items = Vec::new();

    // Напоминания с суммой, ещё не выполненные (суммы в основной валюте).
    let from = time::parse_date(today)?.and_time(NaiveTime::MIN);
    let to = time::parse_date(last)?
        .and_hms_opt(23, 59, 0)
        .expect("время");
    for o in reminders::occurrences(conn, from, to)? {
        if o.key.source != "reminder" || !matches!(o.status.as_str(), "pending" | "snoozed") {
            continue;
        }
        let Some(a) = o.amount else { continue };
        let sign = if o.txn_type.as_deref() == Some("income") {
            1
        } else {
            -1
        };
        items.push(Item {
            date: o.key.scheduled_at[..10].to_string(),
            title: o.title,
            kind: "reminder".into(),
            amount: sign * a,
        });
    }

    // Платежи по графикам займов: выданные вернут мне, по взятым плачу я.
    let mut stmt = conn.prepare(
        "SELECT s.due_date, s.payment, d.direction, d.counterparty, d.currency_code
         FROM debt_schedule s JOIN debts d ON d.id = s.debt_id
         WHERE s.status = 'pending' AND s.payment > 0 AND s.due_date BETWEEN ?1 AND ?2",
    )?;
    let rows: Vec<(String, i64, String, String, String)> = stmt
        .query_map(params![today, last], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (due, payment, direction, who, cur) in rows {
        let Some(v) = currencies::convert(conn, payment, &cur, base, today)? else {
            add_missing(missing, cur);
            continue;
        };
        let (sign, title) = if direction == "borrowed" {
            (-1, format!("Платёж: {who}"))
        } else {
            (1, format!("Возврат: {who}"))
        };
        items.push(Item {
            date: due,
            title,
            kind: "debt".into(),
            amount: sign * v,
        });
    }

    // Запланированные операции (ещё не проведены, в баланс не входят).
    let mut stmt = conn.prepare(
        "SELECT t.type, t.date, t.amount, a.currency_code,
                COALESCE(NULLIF(trim(t.payee), ''), c.name, 'Запланировано')
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'planned' AND t.type IN ('income', 'expense') AND t.date BETWEEN ?1 AND ?2",
    )?;
    let rows: Vec<(String, String, i64, String, String)> = stmt
        .query_map(params![today, last], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (kind, date, amount, cur, title) in rows {
        let Some(v) = currencies::convert(conn, amount, &cur, base, today)? else {
            add_missing(missing, cur);
            continue;
        };
        items.push(Item {
            date,
            title,
            kind: "planned".into(),
            amount: if kind == "income" { v } else { -v },
        });
    }

    items.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.title.cmp(&b.title)));
    Ok(items)
}

/// Прогноз на [`HORIZON`] месяцев от `today`. С `scenario_id` поверх обычного
/// прогноза считается линия сценария.
pub fn forecast(conn: &Connection, today: &str, scenario_id: Option<&str>) -> Result<Forecast> {
    time::check_date(today)?;
    let base = currencies::base_currency(conn)?;
    let bc = currencies::get(conn, &base)?;
    let mut missing = Vec::new();
    let liquid = liquid_on(conn, &base, today, &mut missing)?;

    let current = budgets::month_of(conn, today)?;
    let sd = budgets::start_day(conn)?;
    let mut periods: Vec<Period> = vec![current.clone()];
    for i in 1..HORIZON as i32 {
        periods.push(budgets::period(
            &budgets::shift_month(&current.month, i)?,
            sd,
        )?);
    }

    // Среднее по категориям за прошлые полные месяцы (с начала учёта).
    let excluded = reminder_categories(conn)?;
    let first = first_activity(conn)?;
    let mut sums: HashMap<(String, String), i64> = HashMap::new();
    let mut counted = 0i64;
    if let Some(first) = &first {
        for i in 1..=HISTORY_MONTHS {
            let p = budgets::period(&budgets::shift_month(&current.month, -i)?, sd)?;
            if p.end.as_str() < first.as_str() {
                continue;
            }
            for (k, v) in
                regular_by_category(conn, &base, &p.start, &p.end, &excluded, &mut missing)?
            {
                *sums.entry(k).or_default() += v;
            }
            counted += 1;
        }
    }
    let avg: HashMap<(String, String), i64> = if counted > 0 {
        sums.into_iter().map(|(k, v)| (k, v / counted)).collect()
    } else {
        HashMap::new()
    };
    let avg_of = |kind: &str| -> i64 {
        avg.iter()
            .filter(|((k, _), _)| k == kind)
            .map(|(_, v)| *v)
            .sum()
    };
    let (avg_income, avg_expense) = (avg_of("income"), avg_of("expense"));

    // Текущий месяц: по каждой категории осталось «среднее минус уже случилось».
    let so_far = regular_by_category(conn, &base, &current.start, today, &excluded, &mut missing)?;
    let rest = |kind: &str| -> i64 {
        avg.iter()
            .filter(|((k, _), _)| k == kind)
            .map(|(key, v)| (v - so_far.get(key).copied().unwrap_or(0)).max(0))
            .sum()
    };
    let (rest_income, rest_expense) = (rest("income"), rest("expense"));

    let last = &periods[HORIZON - 1].end;
    let known = known_items(conn, &base, today, last, &mut missing)?;

    let mut months = Vec::with_capacity(HORIZON);
    let mut balance = liquid;
    for (i, p) in periods.iter().enumerate() {
        let items: Vec<Item> = known
            .iter()
            .filter(|it| it.date >= p.start && it.date <= p.end)
            .cloned()
            .collect();
        let planned_income: i64 = items
            .iter()
            .filter(|i| i.amount > 0)
            .map(|i| i.amount)
            .sum();
        let planned_expense: i64 = items
            .iter()
            .filter(|i| i.amount < 0)
            .map(|i| -i.amount)
            .sum();
        let (regular_income, regular_expense) = if i == 0 {
            (rest_income, rest_expense)
        } else {
            (avg_income, avg_expense)
        };
        let opening = balance;
        balance += regular_income - regular_expense + planned_income - planned_expense;
        months.push(Month {
            month: p.month.clone(),
            start: if i == 0 {
                today.to_string()
            } else {
                p.start.clone()
            },
            end: p.end.clone(),
            opening,
            regular_income,
            regular_expense,
            planned_income,
            planned_expense,
            closing: balance,
            items,
            scenario: None,
        });
    }

    let lowest = months
        .iter()
        .min_by_key(|m| m.closing)
        .expect("месяцев прогноза 12");
    let (lowest_month, lowest_balance) = (lowest.month.clone(), lowest.closing);
    let short_month = months
        .iter()
        .find(|m| m.closing < 0)
        .map(|m| m.month.clone());

    let mut out = Forecast {
        base_currency: base,
        currency_symbol: bc.symbol,
        minor_units: bc.minor_units,
        today: today.to_string(),
        liquid,
        history_months: counted,
        avg_income,
        avg_expense,
        excluded_categories: excluded_names(conn, &excluded)?,
        months,
        lowest_month,
        lowest_balance,
        short_month,
        cushion_tenths: (avg_expense > 0)
            .then(|| (liquid.max(0) as i128 * 10 / avg_expense as i128) as i64),
        scenario_id: None,
        scenario_name: None,
        scenario_lowest_balance: None,
        scenario_short_month: None,
        missing_rates: missing,
    };
    if let Some(id) = scenario_id {
        let s = get(conn, id)?;
        apply(&mut out, &s.changes);
        out.scenario_lowest_balance = out
            .months
            .iter()
            .filter_map(|m| m.scenario.as_ref().map(|s| s.closing))
            .min();
        out.scenario_short_month = out
            .months
            .iter()
            .find(|m| m.scenario.as_ref().is_some_and(|s| s.closing < 0))
            .map(|m| m.month.clone());
        out.scenario_id = Some(s.id);
        out.scenario_name = Some(s.name);
    }
    Ok(out)
}

fn excluded_names(conn: &Connection, ids: &HashSet<String>) -> Result<Vec<String>> {
    let mut names: Vec<String> = categories::list(conn, true)?
        .into_iter()
        .filter(|c| ids.contains(&c.id))
        .map(|c| c.name)
        .collect();
    names.sort();
    Ok(names)
}

/// Номер месяца прогноза, с которого действует изменение (может быть < 0 или
/// за горизонтом).
fn month_index(first: &str, month: &str) -> Option<i64> {
    let parse = |s: &str| -> Option<i64> {
        let (y, m) = s.split_once('-')?;
        Some(y.parse::<i64>().ok()? * 12 + m.parse::<i64>().ok()? - 1)
    };
    Some(parse(month)? - parse(first)?)
}

/// Изменение `percent` % от суммы `of`, с округлением до целых копеек.
fn pct(of: i64, percent: i64) -> i64 {
    (of as i128 * percent as i128 / 100) as i64
}

/// Наложить изменения сценария на готовый прогноз.
fn apply(f: &mut Forecast, changes: &[Change]) {
    let first = f.months[0].month.clone();
    let mut balance = f.liquid;
    for (i, m) in f.months.iter_mut().enumerate() {
        let i = i as i64;
        let mut items = Vec::new();
        for c in changes {
            let Some(start) = month_index(&first, &c.start_month) else {
                continue;
            };
            let active = match c.kind.as_str() {
                "once" => i == start,
                _ => i >= start && c.months.is_none_or(|n| i < start + n as i64),
            };
            if !active {
                continue;
            }
            let amount = match c.kind.as_str() {
                "once" | "monthly" => c.amount.unwrap_or(0),
                "income_pct" => pct(m.regular_income + m.planned_income, c.percent.unwrap_or(0)),
                "expense_pct" => -pct(m.regular_expense, c.percent.unwrap_or(0)),
                _ => 0,
            };
            if amount != 0 {
                items.push(Item {
                    date: if i == 0 {
                        m.start.clone()
                    } else {
                        format!("{}-01", m.month)
                    },
                    title: c.title.clone(),
                    kind: "change".into(),
                    amount,
                });
            }
        }
        let delta: i64 = items.iter().map(|it| it.amount).sum();
        balance += m.closing - m.opening + delta;
        m.scenario = Some(ScenarioMonth {
            delta,
            closing: balance,
            items,
        });
    }
}

// ---------------------------------------------------------------------------
// Сценарии «что если»

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeInput {
    /// `once`, `monthly`, `income_pct`, `expense_pct`.
    pub kind: String,
    pub title: String,
    /// Для `once` и `monthly`: сумма в основной валюте, + доход, − трата.
    pub amount: Option<i64>,
    /// Для `income_pct` и `expense_pct`: от −100 до 1000, не 0.
    pub percent: Option<i64>,
    /// Бюджетный месяц `YYYY-MM`.
    pub start_month: String,
    /// Сколько месяцев действует `monthly` и проценты; `None` — до конца прогноза.
    pub months: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioInput {
    pub name: String,
    pub changes: Vec<ChangeInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub amount: Option<i64>,
    pub percent: Option<i64>,
    pub start_month: String,
    pub months: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub id: String,
    pub name: String,
    pub changes: Vec<Change>,
}

fn check_change(c: &ChangeInput) -> Result<ChangeInput> {
    let title = c.title.trim();
    let mut out = ChangeInput {
        title: title.to_string(),
        ..c.clone()
    };
    budgets::shift_month(&c.start_month, 0)?;
    if c.months.is_some_and(|n| !(1..=120).contains(&n)) {
        return invalid("срок изменения — от 1 до 120 месяцев");
    }
    match c.kind.as_str() {
        "once" | "monthly" => {
            if c.amount.is_none_or(|a| a == 0) {
                return invalid("введите сумму изменения");
            }
            out.percent = None;
            if c.kind == "once" {
                out.months = None;
            }
        }
        "income_pct" | "expense_pct" => {
            match c.percent {
                Some(p) if p != 0 && (-100..=1000).contains(&p) => {}
                _ => return invalid("процент изменения — от −100 до 1000, не 0"),
            }
            out.amount = None;
        }
        k => return invalid(format!("неизвестное изменение: {k}")),
    }
    if title.is_empty() {
        out.title = match c.kind.as_str() {
            "once" => "Разовая сумма",
            "monthly" => "Каждый месяц",
            "income_pct" => "Доходы",
            _ => "Траты",
        }
        .to_string();
    }
    Ok(out)
}

fn write_changes(conn: &Connection, scenario_id: &str, changes: &[ChangeInput]) -> Result<()> {
    conn.execute(
        "DELETE FROM forecast_changes WHERE scenario_id = ?1",
        [scenario_id],
    )?;
    for (i, c) in changes.iter().enumerate() {
        conn.execute(
            "INSERT INTO forecast_changes (id, scenario_id, kind, title, amount, percent, start_month, months, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                ids::new_id(),
                scenario_id,
                c.kind,
                c.title,
                c.amount,
                c.percent,
                c.start_month,
                c.months,
                i as i64
            ],
        )?;
    }
    Ok(())
}

fn check(input: &ScenarioInput) -> Result<(String, Vec<ChangeInput>)> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("введите название сценария");
    }
    if input.changes.len() > 50 {
        return invalid("в сценарии не больше 50 изменений");
    }
    let changes = input
        .changes
        .iter()
        .map(check_change)
        .collect::<Result<Vec<_>>>()?;
    Ok((name.to_string(), changes))
}

pub fn create(conn: &Connection, input: &ScenarioInput) -> Result<String> {
    let (name, changes) = check(input)?;
    let id = ids::new_id();
    let now = time::now_utc();
    conn.execute(
        "INSERT INTO forecast_scenarios (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![id, name, now],
    )?;
    write_changes(conn, &id, &changes)?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, input: &ScenarioInput) -> Result<()> {
    let (name, changes) = check(input)?;
    let n = conn.execute(
        "UPDATE forecast_scenarios SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, time::now_utc()],
    )?;
    if n == 0 {
        return invalid("сценарий не найден");
    }
    write_changes(conn, id, &changes)
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM forecast_scenarios WHERE id = ?1", [id])? == 0 {
        return invalid("сценарий не найден");
    }
    Ok(())
}

fn changes_of(conn: &Connection, scenario_id: &str) -> Result<Vec<Change>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, title, amount, percent, start_month, months FROM forecast_changes
         WHERE scenario_id = ?1 ORDER BY sort_order, rowid",
    )?;
    let rows = stmt.query_map([scenario_id], |r| {
        Ok(Change {
            id: r.get(0)?,
            kind: r.get(1)?,
            title: r.get(2)?,
            amount: r.get(3)?,
            percent: r.get(4)?,
            start_month: r.get(5)?,
            months: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get(conn: &Connection, id: &str) -> Result<Scenario> {
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM forecast_scenarios WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(name) = name else {
        return invalid("сценарий не найден");
    };
    Ok(Scenario {
        id: id.to_string(),
        name,
        changes: changes_of(conn, id)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Scenario>> {
    let mut stmt =
        conn.prepare("SELECT id, name FROM forecast_scenarios ORDER BY created_at, rowid")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|(id, name)| {
            Ok(Scenario {
                changes: changes_of(conn, &id)?,
                id,
                name,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Поток денег

/// Сколько категорий показывать отдельно; остальные — одной полосой «Прочее».
const FLOW_TOP: usize = 8;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlowNode {
    /// id категории или `other` для «Прочего».
    pub id: String,
    pub name: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub base_currency: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub period: Period,
    pub income: Vec<FlowNode>,
    pub expense: Vec<FlowNode>,
    pub total_income: i64,
    pub total_expense: i64,
    /// Переведено на брокерские счета за период (минус выведенное обратно).
    pub invested: i64,
    /// Осталось: доходы − расходы − вложения; меньше нуля — потрачено из накоплений.
    pub saved: i64,
    pub missing_rates: Vec<String>,
}

fn top_nodes(items: Vec<reports::CategoryItem>) -> Vec<FlowNode> {
    let mut nodes: Vec<FlowNode> = items
        .into_iter()
        .filter(|i| i.amount > 0)
        .map(|i| FlowNode {
            id: i.category_id,
            name: i.name,
            amount: i.amount,
        })
        .collect();
    nodes.sort_by_key(|n| std::cmp::Reverse(n.amount));
    if nodes.len() > FLOW_TOP {
        let rest: i64 = nodes.drain(FLOW_TOP - 1..).map(|n| n.amount).sum();
        nodes.push(FlowNode {
            id: "other".into(),
            name: "Прочее".into(),
            amount: rest,
        });
    }
    nodes
}

/// Чистый перевод с быстрых счетов на брокерские за период.
fn invested(
    conn: &Connection,
    base: &str,
    from: &str,
    to: &str,
    missing: &mut Vec<String>,
) -> Result<i64> {
    let liquid = LIQUID_TYPES
        .iter()
        .map(|t| format!("'{t}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT t.date, t.amount, src.currency_code, t.to_amount, dst.currency_code,
                src.type = 'investment'
         FROM transactions t
         JOIN accounts src ON src.id = t.account_id
         JOIN accounts dst ON dst.id = t.to_account_id
         WHERE t.type = 'transfer' AND t.status = 'cleared' AND t.date BETWEEN ?1 AND ?2
           AND ((src.type IN ({liquid}) AND src.include_in_total = 1 AND dst.type = 'investment')
             OR (src.type = 'investment' AND dst.type IN ({liquid}) AND dst.include_in_total = 1))"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<(String, i64, String, i64, String, bool)> = stmt
        .query_map(params![from, to], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut total = 0i64;
    for (date, amount, src_cur, to_amount, dst_cur, back) in rows {
        // Сумма считается на стороне быстрого счёта.
        let (a, cur, sign) = if back {
            (to_amount, dst_cur, -1)
        } else {
            (amount, src_cur, 1)
        };
        match currencies::convert(conn, a, &cur, base, &date)? {
            Some(v) => total += sign * v,
            None => add_missing(missing, cur),
        }
    }
    Ok(total)
}

/// Поток денег за месяц или год (`kind` = `month` | `year`), в который входит `month`.
pub fn flow(conn: &Connection, kind: &str, month: &str) -> Result<Flow> {
    if !matches!(kind, "month" | "year") {
        return invalid(format!(
            "поток денег строится за месяц или год, не за {kind}"
        ));
    }
    let period = reports::period_of(conn, kind, month)?;
    let base = currencies::base_currency(conn)?;
    let bc = currencies::get(conn, &base)?;
    let inc = reports::by_category(conn, "income", &period.start, &period.end)?;
    let exp = reports::by_category(conn, "expense", &period.start, &period.end)?;
    let mut missing = Vec::new();
    for c in inc.missing_rates.into_iter().chain(exp.missing_rates) {
        add_missing(&mut missing, c);
    }
    let invested = invested(conn, &base, &period.start, &period.end, &mut missing)?;
    let (total_income, total_expense) = (inc.total, exp.total);
    Ok(Flow {
        base_currency: base,
        currency_symbol: bc.symbol,
        minor_units: bc.minor_units,
        income: top_nodes(inc.items),
        expense: top_nodes(exp.items),
        total_income,
        total_expense,
        invested,
        saved: total_income - total_expense - invested,
        period,
        missing_rates: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::debts::{self, DebtInput};
    use crate::reminders::ReminderInput;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn category(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn txn(
        c: &Connection,
        kind: &str,
        date: &str,
        account: &str,
        amount: i64,
        cat: &str,
    ) -> String {
        transactions::create(
            c,
            &TxnInput {
                kind: kind.into(),
                date: date.into(),
                account_id: account.into(),
                amount,
                category_id: Some(category(c, cat)),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap()
    }

    /// Карта с 100 000 ₽ с июля и три полных месяца: зарплата 80 000 ₽,
    /// продукты 30 000 ₽, кафе 10 000 ₽ (август — 16 000 ₽).
    fn setup() -> (Storage, String) {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let mut card = input("Карта", "debit", "RUB", 10_000_000);
        card.opening_date = "2026-07-01".into();
        let card = accounts::create(c, &card).unwrap();
        for m in ["07", "08", "09"] {
            txn(
                c,
                "income",
                &format!("2026-{m}-05"),
                &card,
                8_000_000,
                "Зарплата",
            );
            txn(
                c,
                "expense",
                &format!("2026-{m}-10"),
                &card,
                3_000_000,
                "Продукты",
            );
            let cafe = if m == "08" { 1_600_000 } else { 1_000_000 };
            txn(
                c,
                "expense",
                &format!("2026-{m}-12"),
                &card,
                cafe,
                "Кафе и рестораны",
            );
        }
        (db, card)
    }

    #[test]
    fn baseline_from_three_full_months() {
        let (db, _) = setup();
        let f = forecast(db.conn(), "2026-10-01", None).unwrap();
        // 100 000 + 3 × (80 000 − 30 000) − 36 000 кафе = 214 000 ₽.
        assert_eq!(f.liquid, 21_400_000);
        assert_eq!(f.history_months, 3);
        assert_eq!(f.avg_income, 8_000_000);
        assert_eq!(f.avg_expense, 3_000_000 + 1_200_000);
        assert_eq!(f.months.len(), HORIZON);
        assert_eq!(f.months[0].month, "2026-10");
        assert_eq!(f.months[11].month, "2027-09");
        // Каждый месяц +38 000 ₽.
        assert_eq!(f.months[0].closing, 21_400_000 + 3_800_000);
        assert_eq!(f.months[11].closing, 21_400_000 + 12 * 3_800_000);
        assert_eq!(f.short_month, None);
        assert_eq!(f.lowest_month, "2026-10");
        // 214 000 / 42 000 = 5,09 месяца.
        assert_eq!(f.cushion_tenths, Some(50));
    }

    #[test]
    fn current_month_counts_only_what_is_left_of_average() {
        let (db, card) = setup();
        let c = db.conn();
        // В октябре зарплата уже пришла, продуктов куплено на 20 000 ₽,
        // а на кафе — 15 000 ₽ (больше среднего: «ещё» по кафе 0, не минус).
        txn(c, "income", "2026-10-05", &card, 8_000_000, "Зарплата");
        txn(c, "expense", "2026-10-08", &card, 2_000_000, "Продукты");
        txn(
            c,
            "expense",
            "2026-10-09",
            &card,
            1_500_000,
            "Кафе и рестораны",
        );
        let f = forecast(c, "2026-10-15", None).unwrap();
        let m = &f.months[0];
        assert_eq!(m.start, "2026-10-15");
        assert_eq!((m.regular_income, m.regular_expense), (0, 1_000_000));
        assert_eq!(m.opening, 21_400_000 + 8_000_000 - 3_500_000);
        assert_eq!(m.closing, m.opening - 1_000_000);
        assert_eq!(f.months[1].regular_expense, 4_200_000);
    }

    #[test]
    fn reminders_debts_and_planned_are_dated_and_not_double_counted() {
        let (mut db, card) = setup();
        let c = db.conn();
        // Аренда 25 000 ₽ 1-го числа — напоминание с категорией: её прошлые
        // операции выпадают из среднего, а суммы идут по датам.
        let rent = category(c, "Жильё");
        txn(c, "expense", "2026-09-01", &card, 2_500_000, "Жильё");
        reminders::create(
            c,
            &ReminderInput {
                title: "Аренда".into(),
                start_at: "2026-09-01T10:00".into(),
                repeat: "monthly".into(),
                amount: Some(2_500_000),
                txn_type: Some("expense".into()),
                category_id: Some(rent),
                ..Default::default()
            },
        )
        .unwrap();
        // Запланированная покупка 50 000 ₽ в декабре.
        let id = txn(c, "expense", "2026-12-20", &card, 5_000_000, "Продукты");
        c.execute(
            "UPDATE transactions SET status = 'planned' WHERE id = ?1",
            [&id],
        )
        .unwrap();
        // Кредит без процентов 120 000 ₽ на 12 месяцев с ноября — 10 000 ₽ в месяц.
        debts::create(
            db.conn_mut(),
            &DebtInput {
                direction: "borrowed".into(),
                counterparty: "Банк".into(),
                note: None,
                currency_code: "RUB".into(),
                principal: 12_000_000,
                issue_date: "2026-10-01".into(),
                rate_bp: 0,
                repayment_type: "annuity".into(),
                term_months: Some(12),
                first_payment_date: Some("2026-11-15".into()),
                maturity_date: None,
                account_id: None,
                interest_method: None,
                rate_changes: vec![],
                planned_early: vec![],
            },
        )
        .unwrap();
        let c = db.conn();
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(f.excluded_categories, vec!["Жильё".to_string()]);
        assert_eq!(f.avg_expense, 4_200_000, "аренда не в среднем");
        let oct = &f.months[0];
        assert_eq!(oct.planned_expense, 2_500_000);
        assert_eq!(oct.items[0].title, "Аренда");
        assert_eq!(oct.items[0].kind, "reminder");
        let dec = &f.months[2];
        assert_eq!(dec.planned_expense, 2_500_000 + 1_000_000 + 5_000_000);
        assert!(dec
            .items
            .iter()
            .any(|i| i.kind == "debt" && i.amount == -1_000_000));
        assert!(dec
            .items
            .iter()
            .any(|i| i.kind == "planned" && i.amount == -5_000_000));
        // Баланс уменьшился на прошлую аренду; дальше −25 000 и −10 000 в месяц.
        assert_eq!(f.liquid, 21_400_000 - 2_500_000);
        let total: i64 = f
            .months
            .iter()
            .map(|m| m.regular_income - m.regular_expense + m.planned_income - m.planned_expense)
            .sum();
        assert_eq!(f.months[11].closing, f.liquid + total);
    }

    #[test]
    fn shortfall_month_is_found() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let mut card = input("Карта", "debit", "RUB", 0);
        card.opening_date = "2026-09-01".into();
        let card = accounts::create(c, &card).unwrap();
        txn(c, "income", "2026-09-01", &card, 5_000_000, "Зарплата");
        txn(c, "expense", "2026-09-02", &card, 4_000_000, "Продукты");
        // Ипотека 30 000 ₽ с ноября: −20 000 ₽ в месяц, остаток 10 000 ₽.
        reminders::create(
            c,
            &ReminderInput {
                title: "Ипотека".into(),
                start_at: "2026-11-05T09:00".into(),
                repeat: "monthly".into(),
                amount: Some(3_000_000),
                ..Default::default()
            },
        )
        .unwrap();
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(f.history_months, 1, "месяцы до начала учёта не считаются");
        assert_eq!(f.months[0].closing, 2_000_000);
        assert_eq!(f.months[1].closing, 0);
        assert_eq!(f.short_month.as_deref(), Some("2026-12"));
        assert_eq!(f.lowest_month, "2027-09");
    }

    #[test]
    fn empty_database_gives_flat_forecast() {
        let db = Storage::open_in_memory().unwrap();
        let f = forecast(db.conn(), "2026-10-20", None).unwrap();
        assert_eq!((f.liquid, f.history_months, f.avg_expense), (0, 0, 0));
        assert!(f.months.iter().all(|m| m.closing == 0));
        assert_eq!(f.cushion_tenths, None);
    }

    #[test]
    fn scenario_changes_apply_on_top() {
        let (db, _) = setup();
        let c = db.conn();
        let id = create(
            c,
            &ScenarioInput {
                name: "Машина и пауза".into(),
                changes: vec![
                    ChangeInput {
                        kind: "once".into(),
                        title: "Машина".into(),
                        amount: Some(-20_000_000),
                        start_month: "2026-12".into(),
                        ..Default::default()
                    },
                    ChangeInput {
                        kind: "income_pct".into(),
                        title: "Без зарплаты".into(),
                        percent: Some(-100),
                        start_month: "2027-01".into(),
                        months: Some(3),
                        ..Default::default()
                    },
                    ChangeInput {
                        kind: "monthly".into(),
                        title: "".into(),
                        amount: Some(-4_500_000),
                        start_month: "2027-06".into(),
                        months: None,
                        ..Default::default()
                    },
                    ChangeInput {
                        kind: "expense_pct".into(),
                        title: "Экономия".into(),
                        percent: Some(-50),
                        start_month: "2026-01".into(),
                        months: Some(10),
                        ..Default::default()
                    },
                ],
            },
        )
        .unwrap();
        let s = get(c, &id).unwrap();
        assert_eq!(s.changes[2].title, "Каждый месяц");
        let f = forecast(c, "2026-10-01", Some(&id)).unwrap();
        assert_eq!(f.scenario_name.as_deref(), Some("Машина и пауза"));
        let sc = |i: usize| f.months[i].scenario.clone().unwrap();
        // Экономия началась в прошлом и длится 10 месяцев: до 2026-10 включительно.
        assert_eq!(sc(0).delta, 2_100_000);
        assert_eq!(sc(1).delta, 0);
        assert_eq!(sc(2).delta, -20_000_000);
        assert_eq!(sc(3).delta, -8_000_000);
        assert_eq!(sc(5).delta, -8_000_000);
        assert_eq!(sc(6).delta, 0);
        assert_eq!(sc(8).delta, -4_500_000);
        assert_eq!(sc(11).delta, -4_500_000);
        let base_end = f.months[11].closing;
        assert_eq!(
            sc(11).closing,
            base_end + 2_100_000 - 20_000_000 - 24_000_000 - 4 * 4_500_000
        );
        assert_eq!(f.scenario_short_month, None);
        assert!(f.scenario_lowest_balance.unwrap() < f.lowest_balance + 1);

        // Изменение и удаление.
        update(
            c,
            &id,
            &ScenarioInput {
                name: "Только машина".into(),
                changes: vec![s.changes[0].clone()]
                    .into_iter()
                    .map(|ch| ChangeInput {
                        kind: ch.kind,
                        title: ch.title,
                        amount: Some(-300_000_000),
                        percent: None,
                        start_month: ch.start_month,
                        months: None,
                    })
                    .collect(),
            },
        )
        .unwrap();
        let f = forecast(c, "2026-10-01", Some(&id)).unwrap();
        assert_eq!(f.scenario_short_month.as_deref(), Some("2026-12"));
        assert_eq!(list(c).unwrap().len(), 1);
        delete(c, &id).unwrap();
        assert!(list(c).unwrap().is_empty());
        let n: i64 = c
            .query_row("SELECT count(*) FROM forecast_changes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "изменения удалены вместе со сценарием");
        assert!(forecast(c, "2026-10-01", Some(&id)).is_err());
    }

    #[test]
    fn scenario_validation() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let bad = |ch: ChangeInput| {
            create(
                c,
                &ScenarioInput {
                    name: "X".into(),
                    changes: vec![ch],
                },
            )
            .is_err()
        };
        assert!(create(
            c,
            &ScenarioInput {
                name: " ".into(),
                changes: vec![]
            }
        )
        .is_err());
        assert!(bad(ChangeInput {
            kind: "once".into(),
            start_month: "2026-12".into(),
            ..Default::default()
        }));
        assert!(bad(ChangeInput {
            kind: "income_pct".into(),
            percent: Some(-150),
            start_month: "2026-12".into(),
            ..Default::default()
        }));
        assert!(bad(ChangeInput {
            kind: "monthly".into(),
            amount: Some(100),
            start_month: "2026-13".into(),
            ..Default::default()
        }));
        assert!(bad(ChangeInput {
            kind: "monthly".into(),
            amount: Some(100),
            start_month: "2026-12".into(),
            months: Some(0),
            ..Default::default()
        }));
        assert!(bad(ChangeInput {
            kind: "gift".into(),
            amount: Some(100),
            start_month: "2026-12".into(),
            ..Default::default()
        }));
    }

    #[test]
    fn money_flow_for_month_and_year() {
        let (db, card) = setup();
        let c = db.conn();
        let mut broker = input("Брокер", "investment", "RUB", 0);
        broker.opening_date = "2026-07-01".into();
        let broker = accounts::create(c, &broker).unwrap();
        transactions::create(
            c,
            &TxnInput {
                kind: "transfer".into(),
                date: "2026-09-20".into(),
                account_id: card.clone(),
                amount: 2_000_000,
                category_id: None,
                to_account_id: Some(broker.clone()),
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
        transactions::create(
            c,
            &TxnInput {
                kind: "transfer".into(),
                date: "2026-09-25".into(),
                account_id: broker,
                amount: 500_000,
                category_id: None,
                to_account_id: Some(card),
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
        let f = flow(c, "month", "2026-09").unwrap();
        assert_eq!((f.total_income, f.total_expense), (8_000_000, 4_000_000));
        assert_eq!(f.invested, 1_500_000);
        assert_eq!(f.saved, 2_500_000);
        assert_eq!(f.income.len(), 1);
        assert_eq!(f.expense[0].name, "Продукты");
        let y = flow(c, "year", "2026-09").unwrap();
        assert_eq!(y.period.start, "2026-01-01");
        assert_eq!(y.total_expense, 3 * 4_000_000 + 600_000);
        assert!(flow(c, "week", "2026-09").is_err());
    }

    #[test]
    fn flow_groups_small_categories_into_other() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let names: Vec<String> = categories::list(c, false)
            .unwrap()
            .into_iter()
            .filter(|k| k.kind == "expense" && k.parent_id.is_none())
            .map(|k| k.name)
            .take(FLOW_TOP + 2)
            .collect();
        assert_eq!(names.len(), FLOW_TOP + 2, "в справочнике хватает категорий");
        for (i, n) in names.iter().enumerate() {
            txn(
                c,
                "expense",
                "2026-09-10",
                &card,
                100_000 * (i as i64 + 1),
                n,
            );
        }
        let f = flow(c, "month", "2026-09").unwrap();
        assert_eq!(f.expense.len(), FLOW_TOP);
        let other = f.expense.last().unwrap();
        assert_eq!(other.id, "other");
        // Три самые маленькие: 100 000 + 200 000 + 300 000.
        assert_eq!(other.amount, 600_000);
        assert_eq!(f.saved, -f.total_expense, "без доходов — всё из накоплений");
    }
}
