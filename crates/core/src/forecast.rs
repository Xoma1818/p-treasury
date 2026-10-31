//! «Взгляд вперёд» (0.18): прогноз остатка на 12 месяцев, сценарии «что если»
//! и поток денег (docs/product/0.18-forecast.md).
//!
//! Прогноз не хранится, а считается каждый раз:
//! * старт — деньги на наличных, картах и вкладах «в общем балансе» сегодня
//!   (как у финансовой подушки);
//! * известное по датам — напоминания с суммой, платежи по графикам займов и
//!   запланированные операции;
//! * остальное — «обычные» доходы и траты: среднее по категориям за последние
//!   полные месяцы. Доходы и расходы брокерских счетов не входят: их деньги не
//!   в стартовом остатке, и прогноз не должен превращать их в доступные. Из среднего убраны платежи по займам, поездки и события,
//!   операции, отмеченные по напоминанию, и категории повторяющихся напоминаний —
//!   они уже посчитаны по датам, второй раз их не берём.
//!
//! Месяцы — бюджетные (настройка «первый день месяца»), как в бюджете и отчётах.
//!
//! 0.19 «Прогноз повсюду»: сезонность (когда учёт ведётся год, месяц
//! поправляется на то, насколько тот же месяц год назад отличался от среднего
//! за год), выбор счетов для прогноза и цели со сроком на графике.

use std::collections::{HashMap, HashSet};

use chrono::NaiveTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::budgets::{self, Period};
use crate::error::invalid;
use crate::wealth::LIQUID_TYPES;
use crate::{
    accounts, categories, currencies, goals, ids, reminders, reports, settings, time, Result,
};

/// На сколько месяцев вперёд строится прогноз (текущий месяц входит).
pub const HORIZON: usize = 12;
/// Сколько прошлых полных месяцев берётся для обычных доходов и трат.
const HISTORY_MONTHS: i32 = 3;
/// Сколько прошлых полных месяцев нужно для сезонности: тот же месяц год назад.
const SEASON_MONTHS: i32 = 12;
/// Настройка: счета, которые не входят в прогноз (JSON-список id).
pub const EXCLUDED_ACCOUNTS_KEY: &str = "forecast_excluded_accounts";

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
    /// Поправка на сезонность (со знаком), уже входит в `regular_*`.
    pub season_income: i64,
    pub season_expense: i64,
    pub closing: i64,
    pub items: Vec<Item>,
    pub scenario: Option<ScenarioMonth>,
}

/// Цель со сроком внутри прогноза: хватит ли денег к сроку.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalMark {
    pub id: String,
    pub name: String,
    pub deadline: String,
    /// Месяц прогноза, в котором срок.
    pub month: String,
    /// Сколько денег цели нужно к сроку, в основной валюте: вся сумма, если
    /// копите на счёте из прогноза, иначе — сколько осталось.
    pub need: i64,
    /// Остаток прогноза на конец этого месяца.
    pub closing: i64,
    /// `closing − need`: меньше нуля — не хватит.
    pub free: i64,
}

/// Счёт, который может входить в прогноз.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastAccount {
    pub id: String,
    pub name: String,
    pub included: bool,
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
    /// Учтена сезонность: история не короче года.
    pub seasonal: bool,
    /// Счета, выключенные из прогноза.
    pub excluded_accounts: Vec<String>,
    pub goals: Vec<GoalMark>,
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
fn liquid_on(
    conn: &Connection,
    base: &str,
    on: &str,
    skip: &HashSet<String>,
    missing: &mut Vec<String>,
) -> Result<i64> {
    let mut total = 0i64;
    for a in liquid_accounts(conn)?
        .into_iter()
        .filter(|a| !skip.contains(&a.id))
    {
        let bal = accounts::balance(conn, &a.id, Some(on))?;
        match currencies::convert(conn, bal, &a.currency_code, base, on)? {
            Some(v) => total += v,
            None => add_missing(missing, a.currency_code),
        }
    }
    Ok(total)
}

/// Быстрые счета «в общем балансе»: из них складывается прогноз.
fn liquid_accounts(conn: &Connection) -> Result<Vec<accounts::Account>> {
    Ok(accounts::list(conn, false)?
        .into_iter()
        .filter(|a| a.include_in_total && LIQUID_TYPES.contains(&a.kind.as_str()))
        .collect())
}

/// Счета, выключенные из прогноза (настройка [`EXCLUDED_ACCOUNTS_KEY`]).
fn excluded_accounts(conn: &Connection) -> Result<HashSet<String>> {
    Ok(settings::get(conn, EXCLUDED_ACCOUNTS_KEY)?
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_default()
        .into_iter()
        .collect())
}

/// Счета для выбора «что входит в прогноз».
pub fn accounts(conn: &Connection) -> Result<Vec<ForecastAccount>> {
    let skip = excluded_accounts(conn)?;
    Ok(liquid_accounts(conn)?
        .into_iter()
        .map(|a| ForecastAccount {
            included: !skip.contains(&a.id),
            id: a.id,
            name: a.name,
        })
        .collect())
}

/// Выключить счета из прогноза (пустой список — все быстрые счета, как в 0.18).
pub fn set_excluded_accounts(conn: &Connection, ids: &[String]) -> Result<()> {
    let mut list: Vec<String> = Vec::new();
    for id in ids {
        accounts::head(conn, id)?;
        if !list.contains(id) {
            list.push(id.clone());
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![
            EXCLUDED_ACCOUNTS_KEY,
            serde_json::to_string(&list).expect("список строк")
        ],
    )?;
    Ok(())
}

/// Категории повторяющихся напоминаний с суммой: их суммы идут по датам.
/// Напоминания по счетам, выключенным из прогноза, не в счёт.
fn reminder_categories(conn: &Connection, skip: &HashSet<String>) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT category_id, account_id FROM reminders
         WHERE active = 1 AND amount IS NOT NULL AND category_id IS NOT NULL AND repeat <> 'once'",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    let mut out = HashSet::new();
    for row in rows {
        let (category, account) = row?;
        if !account.is_some_and(|a| skip.contains(&a)) {
            out.insert(category);
        }
    }
    Ok(out)
}

/// Обычные доходы и расходы по категориям за каждый из периодов (`None` —
/// пропустить): ключ — (тип, категория). Один запрос на весь диапазон вместо
/// запроса на месяц; строки раскладываются по периодам, суммы те же.
fn regular_by_periods(
    conn: &Connection,
    base: &str,
    periods: &[Option<Period>],
    excluded: &HashSet<String>,
    skip: &HashSet<String>,
    missing: &mut Vec<String>,
) -> Result<Vec<HashMap<(String, String), i64>>> {
    let list: Vec<&Period> = periods.iter().flatten().collect();
    let (Some(from), Some(to)) = (
        list.iter().map(|p| p.start.as_str()).min(),
        list.iter().map(|p| p.end.as_str()).max(),
    ) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT t.type, t.category_id, t.date, t.amount, a.currency_code, t.account_id FROM txn_by_month t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type IN ('income', 'expense')
           AND a.type NOT IN ('investment', 'debt') AND a.include_in_total = 1
           AND t.debt_id IS NULL AND t.event_id IS NULL
           AND t.date BETWEEN ?1 AND ?2
           AND t.id NOT IN (SELECT transaction_id FROM reminder_occurrences
                            WHERE transaction_id IS NOT NULL)",
    )?;
    type Row = (String, String, String, i64, String, String);
    let rows: Vec<Row> = stmt
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
    let mut buckets: Vec<Vec<Row>> = vec![Vec::new(); list.len()];
    for row in rows {
        if let Some(i) = list
            .iter()
            .position(|p| p.start.as_str() <= row.2.as_str() && row.2.as_str() <= p.end.as_str())
        {
            buckets[i].push(row);
        }
    }
    let mut result = Vec::with_capacity(list.len());
    for rows in buckets {
        let mut out: HashMap<(String, String), i64> = HashMap::new();
        for (kind, cat, date, amount, cur, account) in rows {
            if excluded.contains(&cat) || skip.contains(&account) {
                continue;
            }
            match currencies::convert(conn, amount, &cur, base, &date)? {
                Some(v) => *out.entry((kind, cat)).or_default() += v,
                None => add_missing(missing, cur),
            }
        }
        result.push(out);
    }
    Ok(result)
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
    skip: &HashSet<String>,
    missing: &mut Vec<String>,
) -> Result<Vec<Item>> {
    let mut items = Vec::new();

    // Напоминания с суммой, ещё не выполненные (суммы в основной валюте).
    // Отложенное считается в день, до которого отложено: поэтому начинаем с
    // самого раннего срабатывания, отложенного на сегодня и позже, — перенос
    // может быть сколь угодно долгим.
    let earliest: Option<String> = conn.query_row(
        "SELECT min(scheduled_at) FROM reminder_occurrences
         WHERE source = 'reminder' AND status = 'snoozed' AND snoozed_until >= ?1",
        [today],
        |r| r.get(0),
    )?;
    let from_day = earliest
        .map(|e| e[..10].to_string())
        .filter(|e| e.as_str() < today)
        .unwrap_or_else(|| today.to_string());
    let from = time::parse_date(&from_day)?.and_time(NaiveTime::MIN);
    let to = time::parse_date(last)?
        .and_hms_opt(23, 59, 0)
        .expect("время");
    for o in reminders::occurrences(conn, from, to)? {
        if o.key.source != "reminder" {
            continue;
        }
        // Напоминание по счёту, выключенному из прогноза, — не наши деньги.
        if o.account_id.as_ref().is_some_and(|a| skip.contains(a)) {
            continue;
        }
        let date = match o.status.as_str() {
            "pending" => o.pay_at[..10].to_string(),
            "snoozed" => o.due_at[..10].to_string(),
            _ => continue,
        };
        // Просроченные и не отложенные в прогноз не идут (как в Календаре).
        if date.as_str() < today {
            continue;
        }
        let Some(a) = o.amount else { continue };
        let sign = if o.txn_type.as_deref() == Some("income") {
            1
        } else {
            -1
        };
        items.push(Item {
            date,
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
                COALESCE(NULLIF(trim(t.payee), ''), c.name, 'Запланировано'), t.account_id
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'planned' AND t.type IN ('income', 'expense') AND t.date BETWEEN ?1 AND ?2
           AND a.type NOT IN ('investment', 'debt') AND a.include_in_total = 1",
    )?;
    type Row = (String, String, i64, String, String, String);
    let rows: Vec<Row> = stmt
        .query_map(params![today, last], |r| {
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
    for (kind, date, amount, cur, title, account) in rows {
        if skip.contains(&account) {
            continue;
        }
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

/// Во сколько раз месяц может быть больше обычного: единичная крупная трата
/// год назад не раздувает прогноз.
const SEASON_CAP: f64 = 2.0;
/// Сколько месяцев из 12 категория должна встречаться, чтобы учитывать её
/// сезонность (иначе — новая или редкая категория, ровно по среднему).
const SEASON_ACTIVE: usize = 6;

/// Разложить обычный уровень `level` на 12 месяцев прогноза по долям прошлого
/// года (`year[i]` — тот же месяц год назад). Доля месяца не больше
/// [`SEASON_CAP`] средней, лишнее делится между остальными месяцами; сумма за
/// год ровно `12 × level`, ни один месяц не меньше нуля.
fn season_split(level: i64, year: &[i64; HORIZON]) -> [i64; HORIZON] {
    let n = HORIZON as f64;
    let total: i64 = year.iter().map(|v| (*v).max(0)).sum();
    let active = year.iter().filter(|v| **v > 0).count();
    if level <= 0 || total <= 0 || active < SEASON_ACTIVE {
        return [level.max(0); HORIZON];
    }
    // Доли месяцев (в сумме 12), крупные срезаются до потолка, остальные
    // растягиваются, пока ни одна не выше потолка.
    let mut idx = year.map(|v| v.max(0) as f64 * n / total as f64);
    let mut capped = [false; HORIZON];
    loop {
        let free: f64 = (0..HORIZON).filter(|i| !capped[*i]).map(|i| idx[i]).sum();
        let left = n - capped.iter().filter(|c| **c).count() as f64 * SEASON_CAP;
        if free > 0.0 {
            for i in (0..HORIZON).filter(|i| !capped[*i]) {
                idx[i] *= left / free;
            }
        }
        let mut changed = false;
        for i in 0..HORIZON {
            if !capped[i] && idx[i] > SEASON_CAP {
                idx[i] = SEASON_CAP;
                capped[i] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    // Целые копейки: остаток от округления вниз — месяцам с большей дробью.
    let target = level as i128 * HORIZON as i128;
    let exact: Vec<f64> = idx.iter().map(|x| level as f64 * x).collect();
    let mut out = [0i64; HORIZON];
    for i in 0..HORIZON {
        out[i] = exact[i].floor() as i64;
    }
    let mut rest = target - out.iter().map(|v| *v as i128).sum::<i128>();
    let mut order: Vec<usize> = (0..HORIZON).collect();
    order.sort_by(|a, b| {
        (exact[*b] - exact[*b].floor()).total_cmp(&(exact[*a] - exact[*a].floor()))
    });
    for i in order.into_iter().cycle() {
        if rest == 0 {
            break;
        }
        let step = rest.signum();
        out[i] += step as i64;
        rest -= step;
    }
    out
}

/// Прогноз на [`HORIZON`] месяцев от `today`. С `scenario_id` поверх обычного
/// прогноза считается линия сценария.
pub fn forecast(conn: &Connection, today: &str, scenario_id: Option<&str>) -> Result<Forecast> {
    time::check_date(today)?;
    let base = currencies::base_currency(conn)?;
    let bc = currencies::get(conn, &base)?;
    let mut missing = Vec::new();
    let skip = excluded_accounts(conn)?;
    let liquid = liquid_on(conn, &base, today, &skip, &mut missing)?;

    let current = budgets::month_of(conn, today)?;
    let sd = budgets::start_day(conn)?;
    let mut periods: Vec<Period> = vec![current.clone()];
    for i in 1..HORIZON as i32 {
        periods.push(budgets::period(
            &budgets::shift_month(&current.month, i)?,
            sd,
        )?);
    }

    // Прошлые полные месяцы по категориям: `past[i - 1]` — месяц `current − i`
    // (None — учёта тогда ещё не было). Для сезонности нужен целый год.
    let excluded = reminder_categories(conn, &skip)?;
    let first = first_activity(conn)?;
    let year_ago = budgets::period(&budgets::shift_month(&current.month, -SEASON_MONTHS)?, sd)?;
    let seasonal = first.as_deref().is_some_and(|f| f <= year_ago.end.as_str());
    let depth = if seasonal {
        SEASON_MONTHS
    } else {
        HISTORY_MONTHS
    };
    let mut covered_periods = Vec::new();
    for i in 1..=depth {
        let p = budgets::period(&budgets::shift_month(&current.month, -i)?, sd)?;
        let covered = first.as_deref().is_some_and(|f| p.end.as_str() >= f);
        covered_periods.push(covered.then_some(p));
    }
    let mut by_period = regular_by_periods(
        conn,
        &base,
        &covered_periods,
        &excluded,
        &skip,
        &mut missing,
    )?
    .into_iter();
    let past: Vec<Option<HashMap<(String, String), i64>>> = covered_periods
        .iter()
        .map(|p| p.as_ref().and_then(|_| by_period.next()))
        .collect();
    let average = |maps: &[Option<HashMap<(String, String), i64>>]| {
        let counted = maps.iter().flatten().count() as i64;
        let mut sums: HashMap<(String, String), i64> = HashMap::new();
        for m in maps.iter().flatten() {
            for (k, v) in m {
                *sums.entry(k.clone()).or_default() += v;
            }
        }
        if counted > 0 {
            sums.values_mut().for_each(|v| *v /= counted);
        }
        (sums, counted)
    };
    // Обычный уровень — среднее за последние полные месяцы (с начала учёта).
    let (avg, counted) = average(&past[..HISTORY_MONTHS as usize]);
    // Сезонность: обычный уровень за год раскладывается по месяцам так же,
    // как год назад (см. [`season_split`]).
    let seasonal_split: HashMap<(String, String), [i64; HORIZON]> = if seasonal {
        avg.iter()
            .map(|(key, level)| {
                let mut year = [0i64; HORIZON];
                for (i, y) in year.iter_mut().enumerate() {
                    *y = past[SEASON_MONTHS as usize - 1 - i]
                        .as_ref()
                        .and_then(|m| m.get(key).copied())
                        .unwrap_or(0);
                }
                (key.clone(), season_split(*level, &year))
            })
            .collect()
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

    // Текущий месяц: по каждой категории осталось «ожидаемое минус уже случилось».
    let so_far = regular_by_periods(
        conn,
        &base,
        &[Some(Period {
            month: current.month.clone(),
            start: current.start.clone(),
            end: today.to_string(),
        })],
        &excluded,
        &skip,
        &mut missing,
    )?
    .pop()
    .unwrap_or_default();
    // Обычные доходы или траты `kind` в месяце прогноза `i`.
    let regular = |i: usize, kind: &str, with_season: bool| -> i64 {
        avg.iter()
            .filter(|((k, _), _)| k == kind)
            .map(|(key, level)| {
                let mut v = match seasonal_split.get(key) {
                    Some(split) if with_season => split[i],
                    _ => *level,
                };
                if i == 0 {
                    v = (v - so_far.get(key).copied().unwrap_or(0)).max(0);
                }
                v
            })
            .sum()
    };

    let last = &periods[HORIZON - 1].end;
    let known = known_items(conn, &base, today, last, &skip, &mut missing)?;

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
        let regular_income = regular(i, "income", seasonal);
        let regular_expense = regular(i, "expense", seasonal);
        let (season_income, season_expense) = if seasonal {
            (
                regular_income - regular(i, "income", false),
                regular_expense - regular(i, "expense", false),
            )
        } else {
            (0, 0)
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
            season_income,
            season_expense,
            closing: balance,
            items,
            scenario: None,
        });
    }
    let goals = goal_marks(conn, &base, today, &months, &skip, &mut missing)?;

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
        seasonal,
        excluded_accounts: liquid_accounts(conn)?
            .into_iter()
            .filter(|a| skip.contains(&a.id))
            .map(|a| a.name)
            .collect(),
        goals,
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

/// Цели со сроком внутри прогноза (ещё не достигнутые).
fn goal_marks(
    conn: &Connection,
    base: &str,
    today: &str,
    months: &[Month],
    skip: &HashSet<String>,
    missing: &mut Vec<String>,
) -> Result<Vec<GoalMark>> {
    let in_forecast: HashSet<String> = liquid_accounts(conn)?
        .into_iter()
        .filter(|a| !skip.contains(&a.id))
        .map(|a| a.id)
        .collect();
    let mut out = Vec::new();
    for g in goals::list(conn, today)? {
        let Some(deadline) = g.deadline.clone() else {
            continue;
        };
        if g.status == "reached" {
            continue;
        }
        let Some(m) = months
            .iter()
            .find(|m| deadline >= m.start && deadline <= m.end)
        else {
            continue;
        };
        // Копите на счёте из прогноза (или без счёта) — к сроку нужна вся сумма,
        // иначе накопленное лежит вне прогноза и нужен только остаток.
        let whole = g
            .account_id
            .as_ref()
            .is_none_or(|a| in_forecast.contains(a));
        let need = if whole { g.target } else { g.remaining };
        let Some(need) = currencies::convert(conn, need, &g.currency_code, base, today)? else {
            add_missing(missing, g.currency_code);
            continue;
        };
        out.push(GoalMark {
            id: g.id,
            name: g.name,
            deadline,
            month: m.month.clone(),
            need,
            closing: m.closing,
            free: m.closing - need,
        });
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
                rate_period: None,
                pay_every: None,
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

    /// Напоминание 31 октября отложили на 5 ноября: платёж в ноябре, а не в
    /// октябре, и не теряется, когда 31 октября уже прошло.
    #[test]
    fn snoozed_reminder_counts_on_new_date() {
        let (db, _) = setup();
        let c = db.conn();
        let id = reminders::create(
            c,
            &ReminderInput {
                title: "Аренда".into(),
                start_at: "2026-08-31T10:00".into(),
                repeat: "monthly".into(),
                amount: Some(2_500_000),
                ..Default::default()
            },
        )
        .unwrap();
        reminders::snooze(
            c,
            &reminders::Key {
                source: "reminder".into(),
                ref_id: id,
                scheduled_at: "2026-10-31T10:00".into(),
            },
            "2026-11-05T10:00",
        )
        .unwrap();
        let rent = |m: &Month| -> Vec<String> {
            m.items
                .iter()
                .filter(|i| i.title == "Аренда")
                .map(|i| i.date.clone())
                .collect()
        };
        let f = forecast(c, "2026-10-31", None).unwrap();
        assert!(rent(&f.months[0]).is_empty(), "в октябре платежа уже нет");
        assert_eq!(rent(&f.months[1]), vec!["2026-11-05", "2026-11-30"]);
        // 31 октября прошло — отложенный платёж всё равно на месте.
        let f = forecast(c, "2026-11-02", None).unwrap();
        assert_eq!(rent(&f.months[0]), vec!["2026-11-05", "2026-11-30"]);
        assert_eq!(f.months[0].planned_expense, 2 * 2_500_000);
    }

    /// Платёж, отложенный больше чем на год, тоже остаётся в прогнозе.
    #[test]
    fn long_snoozed_reminder_is_not_lost() {
        let (db, _) = setup();
        let c = db.conn();
        let id = reminders::create(
            c,
            &ReminderInput {
                title: "Налог".into(),
                start_at: "2025-10-01T10:00".into(),
                repeat: "once".into(),
                amount: Some(1_500_000),
                ..Default::default()
            },
        )
        .unwrap();
        reminders::snooze(
            c,
            &reminders::Key {
                source: "reminder".into(),
                ref_id: id,
                scheduled_at: "2025-10-01T10:00".into(),
            },
            "2026-11-05T10:00",
        )
        .unwrap();
        let f = forecast(c, "2026-10-31", None).unwrap();
        let tax: Vec<_> = f.months[1]
            .items
            .iter()
            .filter(|i| i.title == "Налог")
            .map(|i| (i.date.as_str(), i.amount))
            .collect();
        assert_eq!(tax, vec![("2026-11-05", -1_500_000)]);
    }

    /// Счёт, выключенный из общего баланса, не в старте — и его доходы и
    /// траты не идут ни в среднее, ни в запланированное.
    #[test]
    fn excluded_account_is_not_forecast() {
        let (db, _) = setup();
        let c = db.conn();
        let mut side = input("Карта мамы", "debit", "RUB", 10_000_000);
        side.opening_date = "2026-07-01".into();
        side.include_in_total = false;
        let side = accounts::create(c, &side).unwrap();
        for m in ["07", "08", "09"] {
            txn(
                c,
                "income",
                &format!("2026-{m}-20"),
                &side,
                2_000_000,
                "Зарплата",
            );
            txn(
                c,
                "expense",
                &format!("2026-{m}-21"),
                &side,
                500_000,
                "Продукты",
            );
        }
        let id = txn(c, "income", "2026-11-20", &side, 1_000_000, "Зарплата");
        c.execute(
            "UPDATE transactions SET status = 'planned' WHERE id = ?1",
            [&id],
        )
        .unwrap();
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(f.liquid, 21_400_000, "выключенный счёт не в старте");
        assert_eq!(f.avg_income, 8_000_000, "его доходы не в среднем");
        assert_eq!(f.months[1].planned_income, 0, "и не в запланированном");
        assert_eq!(f.months[11].closing, 21_400_000 + 12 * 3_800_000);
    }

    #[test]
    fn chosen_accounts_only() {
        let (db, card) = setup();
        let c = db.conn();
        let mut deposit = input("Вклад", "savings", "RUB", 50_000_000);
        deposit.opening_date = "2026-07-01".into();
        let deposit = accounts::create(c, &deposit).unwrap();
        for m in ["07", "08", "09"] {
            txn(
                c,
                "income",
                &format!("2026-{m}-28"),
                &deposit,
                300_000,
                "Зарплата",
            );
        }
        let id = txn(c, "expense", "2026-11-20", &deposit, 1_000_000, "Продукты");
        c.execute(
            "UPDATE transactions SET status = 'planned' WHERE id = ?1",
            [&id],
        )
        .unwrap();
        let all = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(all.liquid, 21_400_000 + 50_900_000);
        assert_eq!(all.months[1].planned_expense, 1_000_000);

        set_excluded_accounts(c, &[deposit.clone(), deposit.clone()]).unwrap();
        let list = accounts(c).unwrap();
        assert!(list.iter().any(|a| a.id == card && a.included));
        assert!(list.iter().any(|a| a.id == deposit && !a.included));
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(f.liquid, 21_400_000, "вклад не в старте");
        assert_eq!(f.avg_income, 8_000_000, "его проценты не в среднем");
        assert_eq!(f.months[1].planned_expense, 0, "и не в запланированном");
        assert_eq!(f.excluded_accounts, vec!["Вклад".to_string()]);

        set_excluded_accounts(c, &[]).unwrap();
        assert_eq!(forecast(c, "2026-10-01", None).unwrap().liquid, all.liquid);
        assert!(set_excluded_accounts(c, &["нет-такого".into()]).is_err());
    }

    /// Учёт ведётся год: декабрь прошлого года стоил вдвое больше, и декабрь в
    /// прогнозе дороже, а остальные месяцы чуть дешевле — за год сумма та же.
    #[test]
    fn season_from_the_same_month_last_year() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let mut card = input("Карта", "debit", "RUB", 0);
        card.opening_date = "2025-10-01".into();
        let card = accounts::create(c, &card).unwrap();
        for i in 0..12 {
            let month = budgets::shift_month("2025-10", i).unwrap();
            txn(
                c,
                "income",
                &format!("{month}-05"),
                &card,
                8_000_000,
                "Зарплата",
            );
            let food = if month == "2025-12" {
                6_000_000
            } else {
                3_000_000
            };
            txn(
                c,
                "expense",
                &format!("{month}-10"),
                &card,
                food,
                "Продукты",
            );
        }
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert!(f.seasonal);
        assert_eq!(f.avg_expense, 3_000_000, "обычный уровень — 3 месяца");
        // Год назад 390 000 ₽, декабрь — 60 000 ₽: его доля 60/390 от годовых
        // 360 000 ₽ = 55 384,62 ₽, остальные по 27 692,31 ₽.
        assert_eq!(f.months[2].month, "2026-12");
        assert!((5_538_461..=5_538_462).contains(&f.months[2].regular_expense));
        assert_eq!(
            f.months[2].season_expense,
            f.months[2].regular_expense - 3_000_000
        );
        assert!((2_769_230..=2_769_231).contains(&f.months[1].regular_expense));
        assert_eq!(f.months[0].season_income, 0);
        let year: i64 = f.months.iter().map(|m| m.regular_expense).sum();
        assert_eq!(year, 12 * 3_000_000, "за год сумма та же");

        // Меньше года учёта — сезонности нет, как в 0.18.
        let short = forecast(c, "2026-09-15", None).unwrap();
        assert!(!short.seasonal);
        assert!(short.months.iter().all(|m| m.season_expense == 0));
    }

    /// Единичная крупная трата год назад: декабрь не больше двух обычных
    /// месяцев, годовая сумма не меняется; редкая категория — ровно по среднему.
    #[test]
    fn season_split_keeps_year_and_caps_outliers() {
        let mut year = [1_000_000i64; HORIZON];
        year[2] = 13_000_000; // 10 000 ₽ в месяц, в декабре ещё 120 000 ₽
        let split = season_split(1_000_000, &year);
        assert_eq!(split.iter().sum::<i64>(), 12 * 1_000_000);
        assert_eq!(split[2], 2_000_000, "не больше двух обычных месяцев");
        assert!(split
            .iter()
            .enumerate()
            .all(|(i, v)| i == 2 || (909_090..=909_091).contains(v)));

        let mut rare = [0i64; HORIZON];
        rare[11] = 5_000_000;
        rare[10] = 5_000_000;
        assert_eq!(season_split(700_000, &rare), [700_000; HORIZON]);
        assert_eq!(season_split(0, &year), [0; HORIZON]);
        assert!(season_split(1, &year).iter().all(|v| *v >= 0));
        assert_eq!(season_split(1, &year).iter().sum::<i64>(), 12);
    }

    #[test]
    fn goal_deadline_inside_forecast() {
        let (db, card) = setup();
        let c = db.conn();
        let goal = |name: &str, target: i64, deadline: Option<&str>, account: Option<String>| {
            goals::create(
                c,
                &goals::GoalInput {
                    name: name.into(),
                    target,
                    currency_code: "RUB".into(),
                    account_id: account,
                    deadline: deadline.map(Into::into),
                },
            )
            .unwrap()
        };
        goal("Отпуск", 30_000_000, Some("2027-01-15"), None);
        goal("Машина", 90_000_000, Some("2027-03-01"), Some(card));
        goal("Без срока", 10_000_000, None, None);
        goal("Потом", 10_000_000, Some("2028-01-01"), None);
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(f.goals.len(), 2, "только со сроком внутри 12 месяцев");
        let trip = &f.goals[0];
        assert_eq!(
            (trip.name.as_str(), trip.month.as_str()),
            ("Отпуск", "2027-01")
        );
        // 214 000 + 4 × 38 000 = 366 000 ₽ к концу января.
        assert_eq!(trip.closing, 21_400_000 + 4 * 3_800_000);
        assert_eq!(trip.need, 30_000_000);
        assert_eq!(trip.free, 6_600_000);
        let car = &f.goals[1];
        assert_eq!(car.month, "2027-03");
        assert!(car.free < 0, "на машину к марту не хватит");
    }

    /// Доходы брокерского счёта (дивиденды) не входят в среднее: денег этого
    /// счёта нет в стартовом остатке, и прогноз не делает их доступными.
    #[test]
    fn investment_account_income_is_not_forecast() {
        let (db, _) = setup();
        let c = db.conn();
        let mut broker = input("Брокер", "investment", "RUB", 50_000_000);
        broker.opening_date = "2026-07-01".into();
        let broker = accounts::create(c, &broker).unwrap();
        for m in ["07", "08", "09"] {
            txn(
                c,
                "income",
                &format!("2026-{m}-20"),
                &broker,
                1_000_000,
                "Зарплата",
            );
        }
        let id = txn(c, "income", "2026-11-20", &broker, 1_000_000, "Зарплата");
        c.execute(
            "UPDATE transactions SET status = 'planned' WHERE id = ?1",
            [&id],
        )
        .unwrap();
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(f.liquid, 21_400_000, "брокерский счёт не в старте");
        assert_eq!(f.avg_income, 8_000_000, "дивиденды не в среднем");
        assert_eq!(f.months[1].planned_income, 0, "и не в запланированном");
        assert_eq!(f.months[11].closing, 21_400_000 + 12 * 3_800_000);
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

    /// Сочетание: прогноз и выключенный счёт. Напоминание о платеже с этого
    /// счёта не уменьшает прогноз, а его категория остаётся в среднем по
    /// включённым счетам; напоминание по включённому счёту идёт как раньше.
    #[test]
    fn excluded_account_reminders_stay_out_of_forecast() {
        let (db, _) = setup();
        let c = db.conn();
        let base = forecast(c, "2026-10-01", None).unwrap();
        let mut side = input("Карта мамы", "debit", "RUB", 5_000_000);
        side.opening_date = "2026-07-01".into();
        let side = accounts::create(c, &side).unwrap();
        let cafe = category(c, "Кафе и рестораны");
        // С карты мамы каждое 3-е число — кафе на 7 000 ₽ (напоминание с суммой).
        reminders::create(
            c,
            &ReminderInput {
                title: "Обеды мамы".into(),
                start_at: "2026-10-03T10:00".into(),
                repeat: "monthly".into(),
                amount: Some(700_000),
                txn_type: Some("expense".into()),
                category_id: Some(cafe.clone()),
                account_id: Some(side.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        set_excluded_accounts(c, std::slice::from_ref(&side)).unwrap();
        let f = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(f.liquid, base.liquid, "карта мамы не в старте");
        assert!(
            f.excluded_categories.is_empty(),
            "кафе по своей карте осталось в среднем"
        );
        assert_eq!(f.avg_expense, base.avg_expense);
        assert!(f
            .months
            .iter()
            .all(|m| m.items.iter().all(|i| i.title != "Обеды мамы")));
        assert_eq!(f.months[11].closing, base.months[11].closing);

        // Включили счёт обратно: напоминание идёт по датам, кафе — из среднего.
        set_excluded_accounts(c, &[]).unwrap();
        let back = forecast(c, "2026-10-01", None).unwrap();
        assert_eq!(back.liquid, base.liquid + 5_000_000);
        assert!(back.months[0].items.iter().any(|i| i.title == "Обеды мамы"));
        assert_eq!(
            back.excluded_categories,
            vec!["Кафе и рестораны".to_string()]
        );
    }
}
