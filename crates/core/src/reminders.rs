//! Напоминания: свои (с повтором) и автоматические о платежах по долгам.
//!
//! Будущие повторы не хранятся: их даты вычисляет `expand`. Строка в
//! `reminder_occurrences` появляется, только когда со срабатыванием что-то
//! произошло (показано уведомление, «Выполнено», «Отложить»).
//! Напоминание о платеже по долгу срабатывает за N дней до даты платежа
//! (настройка `debt_reminder_days_before`) и исчезает, когда платёж отмечен.
//!
//! С 0.23 у своего напоминания есть сроки «предупредить заранее» (`lead_days`,
//! по умолчанию из настройки `reminder_lead_days`), последний платёж серии
//! другой суммы, правка одного платежа (сумма, перенос) и привязка к заметке
//! или событию. За `reminder_funds_days` дней до расхода с выбранного счёта
//! проверяется, хватит ли на нём денег.

use std::collections::HashMap;

use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{categories, ids, settings, time, Error, Result};

const DT: &str = "%Y-%m-%dT%H:%M";
/// Время напоминаний о платежах по долгам.
const DEBT_HOUR: &str = "09:00";
/// Насколько назад искать несработавшие напоминания (пропущенные, просроченные).
pub const LOOKBACK_DAYS: i64 = 31;

pub fn parse_dt(s: &str) -> Result<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, DT)
        .map_err(|_| Error::Validation(format!("некорректные дата и время: {s}")))
}

pub fn format_dt(d: NaiveDateTime) -> String {
    d.format(DT).to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repeat {
    Once,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Repeat {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "once" => Self::Once,
            "daily" => Self::Daily,
            "weekly" => Self::Weekly,
            "monthly" => Self::Monthly,
            "yearly" => Self::Yearly,
            _ => return invalid(format!("неизвестный повтор: {s}")),
        })
    }
}

/// Правило повтора.
#[derive(Debug, Clone)]
pub struct Rule {
    pub start: NaiveDateTime,
    pub repeat: Repeat,
    /// Для ежемесячного: число месяца (31 → последний день короткого месяца).
    pub day_of_month: Option<u32>,
    /// Последний день повторов включительно.
    pub end_date: Option<NaiveDate>,
}

/// День `day` месяца `y-m`, а если его нет — последний день месяца.
fn clamp(y: i32, m: u32, day: u32) -> NaiveDate {
    (1..=day.min(31))
        .rev()
        .find_map(|d| NaiveDate::from_ymd_opt(y, m, d))
        .expect("1-е число есть всегда")
}

/// Даты срабатываний правила в промежутке `[from, to]` (обе границы включительно).
pub fn expand(rule: &Rule, from: NaiveDateTime, to: NaiveDateTime) -> Vec<NaiveDateTime> {
    let mut out = Vec::new();
    let t = rule.start.time();
    let end = rule
        .end_date
        .map(|d| d.and_time(t).max(rule.start))
        .unwrap_or(NaiveDateTime::MAX);
    let to = to.min(end);
    if to < rule.start || to < from {
        return out;
    }
    let mut push = |d: NaiveDateTime| {
        if d >= from && d <= to && d >= rule.start {
            out.push(d);
        }
    };
    match rule.repeat {
        Repeat::Once => push(rule.start),
        Repeat::Daily | Repeat::Weekly => {
            let step = if rule.repeat == Repeat::Daily { 1 } else { 7 };
            // Первый номер повтора, который не раньше `from`.
            let skip = ((from - rule.start).num_days().max(0) / step).max(0);
            let mut d = rule.start + Duration::days(skip * step);
            while d <= to {
                push(d);
                d += Duration::days(step);
            }
        }
        Repeat::Monthly => {
            let day = rule.day_of_month.unwrap_or(rule.start.day());
            let begin = from.max(rule.start).date();
            let (mut y, mut m) = (begin.year(), begin.month());
            // Месяц до начала: срабатывание прошлого месяца могло прийтись на `from` (сдвиг 31-го).
            if m == 1 {
                (y, m) = (y - 1, 12);
            } else {
                m -= 1;
            }
            loop {
                let d = clamp(y, m, day).and_time(t);
                if d > to {
                    break;
                }
                push(d);
                (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            }
        }
        Repeat::Yearly => {
            let (sm, sd) = (rule.start.month(), rule.start.day());
            let mut y = from.max(rule.start).year() - 1;
            loop {
                // 29 февраля в невисокосный год — 28 февраля.
                let d = clamp(y, sm, sd).and_time(t);
                if d > to {
                    break;
                }
                push(d);
                y += 1;
            }
        }
    }
    out
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub title: String,
    /// `YYYY-MM-DDTHH:MM`, местное время.
    pub start_at: String,
    pub repeat: String,
    pub day_of_month: Option<u32>,
    pub end_date: Option<String>,
    pub amount: Option<i64>,
    pub txn_type: Option<String>,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub note: Option<String>,
    /// Сроки «предупредить заранее» в днях через запятую: `None` — как в
    /// Настройках, `""` — не предупреждать.
    #[serde(default)]
    pub lead_days: Option<String>,
    /// Сколько раз повторить (вместо «до даты»): последний день считается сам.
    #[serde(default)]
    pub count: Option<u32>,
    /// Последний платёж серии другой суммы.
    #[serde(default)]
    pub last_amount: Option<i64>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub repeat: String,
    pub day_of_month: Option<u32>,
    pub end_date: Option<String>,
    pub amount: Option<i64>,
    pub txn_type: Option<String>,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub note: Option<String>,
    pub active: bool,
    /// Ближайшее будущее срабатывание.
    pub next_at: Option<String>,
    /// Свои сроки «заранее» (`None` — как в Настройках).
    pub lead_days: Option<String>,
    pub last_amount: Option<i64>,
    pub note_id: Option<String>,
    pub event_id: Option<String>,
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

struct Checked {
    title: String,
    day_of_month: Option<u32>,
    end_date: Option<String>,
    txn_type: Option<String>,
    lead_days: Option<String>,
    last_amount: Option<i64>,
}

/// Наибольший срок «заранее», дней.
pub const MAX_LEAD_DAYS: i64 = 60;

/// Сроки «заранее» из строки `'7,3,1'`: по убыванию, без повторов.
pub fn parse_lead_days(s: &str) -> Result<Vec<i64>> {
    let mut out = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let Ok(d) = part.parse::<i64>() else {
            return invalid(format!("срок «заранее» — число дней, не {part}"));
        };
        if !(1..=MAX_LEAD_DAYS).contains(&d) {
            return invalid(format!("предупредить можно за 1–{MAX_LEAD_DAYS} дней"));
        }
        if !out.contains(&d) {
            out.push(d);
        }
    }
    out.sort_unstable_by(|a, b| b.cmp(a));
    Ok(out)
}

fn join_days(days: &[i64]) -> String {
    days.iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// Сроки «заранее» по умолчанию (Настройки).
pub fn default_lead_days(conn: &Connection) -> Result<Vec<i64>> {
    let v = settings::get(conn, "reminder_lead_days")?.unwrap_or_default();
    Ok(parse_lead_days(&v).unwrap_or_default())
}

/// За сколько дней до расхода проверять деньги на счёте (0 — не проверять).
pub fn funds_days(conn: &Connection) -> Result<i64> {
    Ok(settings::get(conn, "reminder_funds_days")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(3)
        .clamp(0, MAX_LEAD_DAYS))
}

fn validate(conn: &Connection, input: &ReminderInput) -> Result<Checked> {
    let title = input.title.trim();
    if title.is_empty() {
        return invalid("введите название напоминания");
    }
    let start = parse_dt(&input.start_at)?;
    let repeat = Repeat::parse(&input.repeat)?;
    if input.count == Some(0) {
        return invalid("повторить можно от одного раза");
    }
    let end_date = match (input.count, repeat) {
        // «N раз»: последний день — дата N-го срабатывания.
        (Some(n), r) if r != Repeat::Once => {
            let rule = Rule {
                start,
                repeat,
                day_of_month: match repeat {
                    Repeat::Monthly => Some(input.day_of_month.unwrap_or(start.day())),
                    _ => None,
                },
                end_date: None,
            };
            nth(&rule, n).map(|d| d.date().to_string())
        }
        _ => clean(&input.end_date),
    };
    if let Some(e) = end_date.as_deref() {
        time::check_date(e)?;
        if e < &input.start_at[..10] {
            return invalid("повторы заканчиваются раньше первой даты");
        }
    }
    let day_of_month = match repeat {
        Repeat::Monthly => Some(input.day_of_month.unwrap_or(start.day())),
        _ => None,
    };
    if day_of_month.is_some_and(|d| !(1..=31).contains(&d)) {
        return invalid("число месяца от 1 до 31");
    }
    if input.amount.is_some_and(|a| a <= 0) || input.last_amount.is_some_and(|a| a <= 0) {
        return invalid("сумма должна быть больше нуля");
    }
    // Последний платёж другой суммы — только у серии с концом и суммой.
    let last_amount = match (input.last_amount, &end_date, input.amount) {
        (Some(_), _, _) if repeat == Repeat::Once => None,
        (Some(_), None, _) => return invalid("у серии без конца нет последнего платежа"),
        (Some(_), _, None) => return invalid("сначала укажите сумму платежа"),
        (l, _, _) => l,
    };
    let lead_days = match input.lead_days.as_deref() {
        None => None,
        Some(s) => Some(join_days(&parse_lead_days(s)?)),
    };
    let txn_type = match input.txn_type.as_deref() {
        None | Some("") => input.amount.map(|_| "expense".to_string()),
        Some(t @ ("expense" | "income")) => Some(t.to_string()),
        Some(t) => return invalid(format!("тип операции: расход или доход, не {t}")),
    };
    if let (Some(cat), Some(kind)) = (input.category_id.as_deref(), txn_type.as_deref()) {
        if categories::kind_of(conn, cat)? != kind {
            return invalid("категория не подходит к типу операции");
        }
    }
    Ok(Checked {
        title: title.to_string(),
        day_of_month,
        end_date,
        txn_type,
        lead_days,
        last_amount,
    })
}

/// Дата `n`-го срабатывания правила (с 1).
fn nth(rule: &Rule, n: u32) -> Option<NaiveDateTime> {
    // Ежедневно и еженедельно — точный шаг, остальное — с запасом по месяцам.
    let span = match rule.repeat {
        Repeat::Once => 0,
        Repeat::Daily => i64::from(n),
        Repeat::Weekly => 7 * i64::from(n),
        Repeat::Monthly => 32 * i64::from(n),
        Repeat::Yearly => 367 * i64::from(n),
    };
    expand(rule, rule.start, rule.start + Duration::days(span))
        .into_iter()
        .nth(n as usize - 1)
}

pub fn create(conn: &Connection, input: &ReminderInput) -> Result<String> {
    let c = validate(conn, input)?;
    let id = ids::new_id();
    conn.execute(
        "INSERT INTO reminders (id, title, start_at, repeat, day_of_month, end_date, amount, txn_type, account_id,
                                category_id, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            id,
            c.title,
            input.start_at,
            input.repeat,
            c.day_of_month,
            c.end_date,
            input.amount,
            c.txn_type,
            clean(&input.account_id),
            clean(&input.category_id),
            clean(&input.note),
            time::now_utc()
        ],
    )?;
    // Поля 0.23 — отдельно и только заданные: пример данных (demo) создаёт
    // напоминания и на старой схеме в тестах обновления.
    let (note_id, event_id) = (clean(&input.note_id), clean(&input.event_id));
    if c.lead_days.is_some() || c.last_amount.is_some() || note_id.is_some() || event_id.is_some() {
        conn.execute(
            "UPDATE reminders SET lead_days = ?2, last_amount = ?3, note_id = ?4, event_id = ?5 WHERE id = ?1",
            params![id, c.lead_days, c.last_amount, note_id, event_id],
        )?;
    }
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, input: &ReminderInput) -> Result<()> {
    let c = validate(conn, input)?;
    let n = conn.execute(
        "UPDATE reminders SET title = ?2, start_at = ?3, repeat = ?4, day_of_month = ?5, end_date = ?6, amount = ?7,
                txn_type = ?8, account_id = ?9, category_id = ?10, note = ?11, updated_at = ?12,
                lead_days = ?13, last_amount = ?14
         WHERE id = ?1",
        params![
            id,
            c.title,
            input.start_at,
            input.repeat,
            c.day_of_month,
            c.end_date,
            input.amount,
            c.txn_type,
            clean(&input.account_id),
            clean(&input.category_id),
            clean(&input.note),
            time::now_utc(),
            c.lead_days,
            c.last_amount
        ],
    )?;
    if n == 0 {
        return Err(Error::NotFound("напоминание"));
    }
    Ok(())
}

pub fn set_active(conn: &Connection, id: &str, active: bool) -> Result<()> {
    conn.execute(
        "UPDATE reminders SET active = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, active, time::now_utc()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM reminders WHERE id = ?1", [id])?;
    Ok(())
}

fn rule_of(r: &Reminder) -> Result<Rule> {
    Ok(Rule {
        start: parse_dt(&r.start_at)?,
        repeat: Repeat::parse(&r.repeat)?,
        day_of_month: r.day_of_month,
        end_date: r
            .end_date
            .as_deref()
            .map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d"))
            .transpose()
            .ok()
            .flatten(),
    })
}

pub fn list(conn: &Connection, now: NaiveDateTime) -> Result<Vec<Reminder>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, start_at, repeat, day_of_month, end_date, amount, txn_type, account_id, category_id, note, active,
                lead_days, last_amount, note_id, event_id
         FROM reminders ORDER BY active DESC, title",
    )?;
    let mut out: Vec<Reminder> = stmt
        .query_map([], |r| {
            Ok(Reminder {
                id: r.get(0)?,
                title: r.get(1)?,
                start_at: r.get(2)?,
                repeat: r.get(3)?,
                day_of_month: r.get(4)?,
                end_date: r.get(5)?,
                amount: r.get(6)?,
                txn_type: r.get(7)?,
                account_id: r.get(8)?,
                category_id: r.get(9)?,
                note: r.get(10)?,
                active: r.get(11)?,
                next_at: None,
                lead_days: r.get(12)?,
                last_amount: r.get(13)?,
                note_id: r.get(14)?,
                event_id: r.get(15)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    for r in &mut out {
        let rule = rule_of(r)?;
        r.next_at = expand(&rule, now, now + Duration::days(800))
            .first()
            .map(|d| format_dt(*d));
    }
    Ok(out)
}

/// Срабатывание: своё напоминание или платёж по долгу.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    /// `reminder` или `debt`.
    pub source: String,
    /// id напоминания или строки графика долга.
    pub ref_id: String,
    pub scheduled_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub key: Key,
    pub title: String,
    pub amount: Option<i64>,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub txn_type: Option<String>,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub note: Option<String>,
    /// Для платежа по долгу: долг и дата платежа.
    pub debt_id: Option<String>,
    pub due_date: Option<String>,
    /// `pending`, `done`, `snoozed`, `dismissed`.
    pub status: String,
    /// Когда показать: дата срабатывания или «отложено до».
    pub due_at: String,
    pub notified_at: Option<String>,
    pub completed_at: Option<String>,
    pub transaction_id: Option<String>,
    /// День и время самого платежа: по расписанию или куда его перенесли.
    pub pay_at: String,
    /// Сумма или дата этого платежа изменены отдельно от серии.
    pub edited: bool,
    /// Последний платёж серии с концом.
    pub last: bool,
    /// Сроки «заранее», дней (по убыванию).
    pub lead_days: Vec<i64>,
    /// Сколько не хватит на счёте к платежу (для ближайших расходов).
    pub shortfall: Option<i64>,
}

impl Occurrence {
    /// Ждёт действия пользователя на момент `now`.
    pub fn is_due(&self, now: &str) -> bool {
        matches!(self.status.as_str(), "pending" | "snoozed") && self.due_at.as_str() <= now
    }
}

struct State {
    status: String,
    snoozed_until: Option<String>,
    notified_at: Option<String>,
    completed_at: Option<String>,
    transaction_id: Option<String>,
    amount_override: Option<i64>,
    moved_to: Option<String>,
}

fn states(conn: &Connection) -> Result<HashMap<Key, State>> {
    let mut stmt = conn.prepare(
        "SELECT source, COALESCE(reminder_id, debt_schedule_id), scheduled_at, status, snoozed_until, notified_at,
                completed_at, transaction_id, amount_override, moved_to
         FROM reminder_occurrences",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            Key {
                source: r.get(0)?,
                ref_id: r.get(1)?,
                scheduled_at: r.get(2)?,
            },
            State {
                status: r.get(3)?,
                snoozed_until: r.get(4)?,
                notified_at: r.get(5)?,
                completed_at: r.get(6)?,
                transaction_id: r.get(7)?,
                amount_override: r.get(8)?,
                moved_to: r.get(9)?,
            },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn base_currency(conn: &Connection) -> Result<(String, u32)> {
    let base = crate::currencies::base_currency(conn)?;
    let c = crate::currencies::get(conn, &base)?;
    Ok((c.symbol, c.minor_units))
}

/// Все срабатывания в промежутке `[from, to]`, со своим состоянием, по времени.
pub fn occurrences(
    conn: &Connection,
    from: NaiveDateTime,
    to: NaiveDateTime,
) -> Result<Vec<Occurrence>> {
    let states = states(conn)?;
    let (symbol, minor) = base_currency(conn)?;
    let mut out = Vec::new();
    let mut add = |key: Key, mut o: Occurrence| {
        if let Some(s) = states.get(&key) {
            if let Some(a) = s.amount_override {
                o.amount = Some(a);
                o.edited = true;
            }
            if let Some(m) = &s.moved_to {
                o.pay_at = m.clone();
                o.due_at = m.clone();
                o.edited = true;
            }
            o.status = s.status.clone();
            if s.status == "snoozed" {
                if let Some(u) = &s.snoozed_until {
                    o.due_at = u.clone();
                }
            }
            o.notified_at = s.notified_at.clone();
            o.completed_at = s.completed_at.clone();
            o.transaction_id = s.transaction_id.clone();
        }
        o.key = key;
        out.push(o);
    };

    let now = from; // только для `list`, `next_at` здесь не нужен
    let default_leads = default_lead_days(conn)?;
    for r in list(conn, now)?.into_iter().filter(|r| r.active) {
        let rule = rule_of(&r)?;
        // Последний платёж серии с концом (у него может быть своя сумма).
        let last_at = match rule.end_date {
            Some(end) if rule.repeat != Repeat::Once => expand(
                &rule,
                rule.start,
                end.and_hms_opt(23, 59, 59).expect("время"),
            )
            .last()
            .copied(),
            _ => None,
        };
        let leads = match r.lead_days.as_deref() {
            None => default_leads.clone(),
            Some(s) => parse_lead_days(s).unwrap_or_default(),
        };
        for at in expand(&rule, from, to) {
            let last = last_at == Some(at);
            let key = Key {
                source: "reminder".into(),
                ref_id: r.id.clone(),
                scheduled_at: format_dt(at),
            };
            add(
                key.clone(),
                Occurrence {
                    key,
                    title: r.title.clone(),
                    amount: if last {
                        r.last_amount.or(r.amount)
                    } else {
                        r.amount
                    },
                    currency_symbol: symbol.clone(),
                    minor_units: minor,
                    txn_type: r.txn_type.clone(),
                    account_id: r.account_id.clone(),
                    category_id: r.category_id.clone(),
                    note: r.note.clone(),
                    debt_id: None,
                    due_date: None,
                    status: "pending".into(),
                    due_at: format_dt(at),
                    notified_at: None,
                    completed_at: None,
                    transaction_id: None,
                    pay_at: format_dt(at),
                    edited: false,
                    last,
                    lead_days: leads.clone(),
                    shortfall: None,
                },
            );
        }
    }

    let days: i64 = settings::get(conn, "debt_reminder_days_before")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let mut stmt = conn.prepare(
        "SELECT s.id, s.due_date, s.payment, d.id, d.counterparty, d.direction, c.symbol, c.minor_units
         FROM debt_schedule s JOIN debts d ON d.id = s.debt_id JOIN currencies c ON c.code = d.currency_code
         WHERE s.status = 'pending' AND d.status = 'active'",
    )?;
    type DebtRow = (String, String, i64, String, String, String, String, u32);
    let rows: Vec<DebtRow> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (sid, due, payment, debt_id, who, direction, sym, mu) in rows {
        let Ok(due_d) = NaiveDate::parse_from_str(&due, "%Y-%m-%d") else {
            continue;
        };
        let at = parse_dt(&format!("{}T{DEBT_HOUR}", due_d - Duration::days(days)))?;
        if at < from || at > to {
            continue;
        }
        let key = Key {
            source: "debt".into(),
            ref_id: sid,
            scheduled_at: format_dt(at),
        };
        let title = if direction == "lent" {
            format!("{who} должен вернуть")
        } else {
            format!("Платёж: {who}")
        };
        add(
            key.clone(),
            Occurrence {
                key,
                title,
                amount: Some(payment),
                currency_symbol: sym,
                minor_units: mu,
                txn_type: None,
                account_id: None,
                category_id: None,
                note: None,
                debt_id: Some(debt_id),
                due_date: Some(due.clone()),
                status: "pending".into(),
                due_at: format_dt(at),
                notified_at: None,
                completed_at: None,
                transaction_id: None,
                pay_at: format!("{due}T{DEBT_HOUR}"),
                edited: false,
                last: false,
                lead_days: Vec::new(),
                shortfall: None,
            },
        );
    }
    out.sort_by(|a, b| a.due_at.cmp(&b.due_at).then_with(|| a.title.cmp(&b.title)));
    Ok(out)
}

/// Записать состояние срабатывания (строка создаётся при первом действии).
fn upsert(conn: &Connection, key: &Key, set: &str, values: &[&dyn rusqlite::ToSql]) -> Result<()> {
    if !matches!(key.source.as_str(), "reminder" | "debt") {
        return invalid("неизвестное срабатывание");
    }
    parse_dt(&key.scheduled_at)?;
    let col = if key.source == "reminder" {
        "reminder_id"
    } else {
        "debt_schedule_id"
    };
    let existing: Option<String> = conn
        .query_row(
            &format!("SELECT id FROM reminder_occurrences WHERE source = ?1 AND {col} = ?2 AND scheduled_at = ?3"),
            params![key.source, key.ref_id, key.scheduled_at],
            |r| r.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => id,
        None => {
            let id = ids::new_id();
            conn.execute(
                &format!("INSERT INTO reminder_occurrences (id, source, {col}, scheduled_at) VALUES (?1, ?2, ?3, ?4)"),
                params![id, key.source, key.ref_id, key.scheduled_at],
            )?;
            id
        }
    };
    let mut p: Vec<&dyn rusqlite::ToSql> = vec![&id];
    p.extend_from_slice(values);
    conn.execute(
        &format!("UPDATE reminder_occurrences SET {set} WHERE id = ?1"),
        p.as_slice(),
    )?;
    Ok(())
}

/// «Выполнено» (с операцией, если её создали из напоминания).
pub fn complete(conn: &Connection, key: &Key, transaction_id: Option<&str>) -> Result<()> {
    upsert(
        conn,
        key,
        "status = 'done', completed_at = ?2, transaction_id = ?3, snoozed_until = NULL",
        &[&time::now_utc(), &transaction_id],
    )
}

/// «Отложить» до `until` (`YYYY-MM-DDTHH:MM`).
pub fn snooze(conn: &Connection, key: &Key, until: &str) -> Result<()> {
    parse_dt(until)?;
    // Отложенное покажется снова, поэтому отметку об уведомлении сбрасываем.
    upsert(
        conn,
        key,
        "status = 'snoozed', snoozed_until = ?2, notified_at = NULL",
        &[&until],
    )
}

pub fn dismiss(conn: &Connection, key: &Key) -> Result<()> {
    upsert(
        conn,
        key,
        "status = 'dismissed', completed_at = ?2",
        &[&time::now_utc()],
    )
}

/// Вернуть срабатывание в ожидание (отмена «Выполнено»).
pub fn reopen(conn: &Connection, key: &Key) -> Result<()> {
    upsert(
        conn,
        key,
        "status = 'pending', completed_at = NULL, snoozed_until = NULL, transaction_id = NULL",
        &[],
    )
}

pub fn mark_notified(conn: &Connection, keys: &[Key], at: &str) -> Result<()> {
    for k in keys {
        upsert(conn, k, "notified_at = ?2", &[&at])?;
    }
    Ok(())
}

/// Наступившие срабатывания без уведомления (за последние `LOOKBACK_DAYS` дней).
pub fn due_unnotified(conn: &Connection, now: NaiveDateTime) -> Result<Vec<Occurrence>> {
    let n = format_dt(now);
    Ok(occurrences(
        conn,
        now - Duration::days(LOOKBACK_DAYS),
        now + Duration::days(LOOKBACK_DAYS),
    )?
    .into_iter()
    .filter(|o| o.is_due(&n) && o.notified_at.is_none())
    .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// Наступили и ждут действия.
    pub overdue: Vec<Occurrence>,
    /// Ещё не наступили (ближайшие 30 дней, до конца 30-го дня).
    pub upcoming: Vec<Occurrence>,
    /// Выполненные за последний месяц.
    pub done: Vec<Occurrence>,
    pub reminders: Vec<Reminder>,
}

pub fn overview(conn: &Connection, now: NaiveDateTime) -> Result<Overview> {
    let n = format_dt(now);
    let all = occurrences(conn, now - Duration::days(LOOKBACK_DAYS), upcoming_end(now))?;
    let (mut overdue, mut upcoming, mut done) = (Vec::new(), Vec::new(), Vec::new());
    for o in all {
        if o.is_due(&n) {
            overdue.push(o);
        } else if matches!(o.status.as_str(), "pending" | "snoozed") {
            upcoming.push(o);
        } else if o.status == "done" {
            done.push(o);
        }
    }
    done.reverse();
    let short = shortfalls(conn, now, funds_days(conn)?)?;
    for o in overdue.iter_mut().chain(upcoming.iter_mut()) {
        o.shortfall = short.get(&o.key).copied();
    }
    Ok(Overview {
        overdue,
        upcoming,
        done,
        reminders: list(conn, now)?,
    })
}

/// Одно напоминание (для формы правки из заметки или события).
pub fn get(conn: &Connection, id: &str, now: NaiveDateTime) -> Result<Reminder> {
    list(conn, now)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or(Error::NotFound("напоминание"))
}

/// Правка одного платежа серии: своя сумма и (или) перенос на другой день и
/// время. `None` возвращает значение серии.
pub fn edit_occurrence(
    conn: &Connection,
    key: &Key,
    amount: Option<i64>,
    moved_to: Option<&str>,
) -> Result<()> {
    if key.source != "reminder" {
        return invalid("платёж по займу меняется в карточке займа");
    }
    if amount.is_some_and(|a| a <= 0) {
        return invalid("сумма должна быть больше нуля");
    }
    let moved_to = moved_to.filter(|m| *m != key.scheduled_at);
    if let Some(m) = moved_to {
        parse_dt(m)?;
    }
    // Перенесённый платёж напоминает заново.
    upsert(
        conn,
        key,
        "amount_override = ?2, moved_to = ?3, notified_at = CASE WHEN moved_to IS ?3 THEN notified_at END",
        &[&amount, &moved_to],
    )?;
    conn.execute(
        "DELETE FROM reminder_notices WHERE source = ?1 AND ref_id = ?2 AND scheduled_at = ?3",
        params![key.source, key.ref_id, key.scheduled_at],
    )?;
    Ok(())
}

/// «Изменить этот и все следующие»: серия до платежа `key` остаётся как была,
/// с него начинается новая с `input`. Возвращает id той, что действует дальше.
pub fn split_from(conn: &Connection, key: &Key, input: &ReminderInput) -> Result<String> {
    if key.source != "reminder" {
        return invalid("платёж по займу меняется в карточке займа");
    }
    let at = parse_dt(&key.scheduled_at)?;
    let old: (String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT start_at, note_id, event_id FROM reminders WHERE id = ?1",
            [&key.ref_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or(Error::NotFound("напоминание"))?;
    if parse_dt(&old.0)?.date() >= at.date() {
        update(conn, &key.ref_id, input)?;
        return Ok(key.ref_id.clone());
    }
    let mut next = input.clone();
    next.note_id = next.note_id.or(old.1);
    next.event_id = next.event_id.or(old.2);
    let id = create(conn, &next)?;
    // Старая серия заканчивается накануне; её последний платёж — обычной суммы.
    conn.execute(
        "UPDATE reminders SET end_date = ?2, last_amount = NULL, updated_at = ?3 WHERE id = ?1",
        params![
            key.ref_id,
            (at.date() - Duration::days(1)).to_string(),
            time::now_utc()
        ],
    )?;
    Ok(id)
}

/// Предупреждение до платежа: «через N дней» или «не хватит денег».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub occurrence: Occurrence,
    /// `lead` или `funds`.
    pub kind: String,
    /// За сколько дней до платежа (для `funds` — 0).
    pub days: i64,
    pub text: String,
}

fn days_word(n: i64) -> &'static str {
    match (n % 10, n % 100) {
        (1, x) if x != 11 => "день",
        (2..=4, x) if !(12..=14).contains(&x) => "дня",
        _ => "дней",
    }
}

fn amount_text(a: i64, minor: u32, symbol: &str) -> String {
    format!("{} {symbol}", crate::money::format_amount(a, minor, true))
}

fn pay_day(o: &Occurrence) -> String {
    let d = &o.pay_at[..10];
    format!("{}.{}", &d[8..10], &d[5..7])
}

/// Сколько не хватит на счетах к ближайшим расходам: идём по открытым платежам
/// с выбранным счётом от `now` до `now + days` и вычитаем их из остатка.
/// Счета не в основной валюте пропускаем: суммы напоминаний — в основной.
pub fn shortfalls(conn: &Connection, now: NaiveDateTime, days: i64) -> Result<HashMap<Key, i64>> {
    let mut out = HashMap::new();
    if days <= 0 {
        return Ok(out);
    }
    let horizon = (now.date() + Duration::days(days))
        .and_hms_opt(23, 59, 59)
        .expect("время");
    let n = format_dt(now);
    let base = crate::currencies::base_currency(conn)?;
    let mut occ: Vec<Occurrence> = occurrences(conn, now - Duration::days(LOOKBACK_DAYS), horizon)?
        .into_iter()
        .filter(|o| {
            o.key.source == "reminder"
                && matches!(o.status.as_str(), "pending" | "snoozed")
                && o.amount.is_some()
                && o.account_id.is_some()
                && o.pay_at >= n
                && o.pay_at <= format_dt(horizon)
        })
        .collect();
    occ.sort_by(|a, b| a.pay_at.cmp(&b.pay_at));
    let mut left: HashMap<String, Option<i64>> = HashMap::new();
    for o in occ {
        let acc = o.account_id.clone().expect("отобрано выше");
        let balance = match left.get(&acc) {
            Some(b) => *b,
            None => {
                let b = match crate::accounts::get(conn, &acc) {
                    Ok(a) if a.currency_code == base => {
                        Some(crate::accounts::balance(conn, &acc, None)?)
                    }
                    _ => None,
                };
                left.insert(acc.clone(), b);
                b
            }
        };
        let Some(mut b) = balance else { continue };
        let a = o.amount.expect("отобрано выше");
        if o.txn_type.as_deref() == Some("income") {
            b += a;
        } else {
            b -= a;
            if b < 0 {
                out.insert(o.key.clone(), (-b).min(a));
            }
        }
        left.insert(acc, Some(b));
    }
    Ok(out)
}

fn sent_notices(conn: &Connection) -> Result<std::collections::HashSet<(Key, String, i64)>> {
    let mut stmt =
        conn.prepare("SELECT source, ref_id, scheduled_at, kind, days FROM reminder_notices")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            Key {
                source: r.get(0)?,
                ref_id: r.get(1)?,
                scheduled_at: r.get(2)?,
            },
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Предупреждения, которые пора показать. Если программа была закрыта и
/// наступило сразу несколько сроков одного платежа, показываем один — ближний.
pub fn due_notices(conn: &Connection, now: NaiveDateTime) -> Result<Vec<Notice>> {
    let n = format_dt(now);
    let sent = sent_notices(conn)?;
    let funds = funds_days(conn)?;
    let short = shortfalls(conn, now, funds)?;
    let mut out = Vec::new();
    let horizon = now + Duration::days(MAX_LEAD_DAYS + 1);
    for o in occurrences(conn, now - Duration::days(LOOKBACK_DAYS), horizon)? {
        if o.key.source != "reminder"
            || !matches!(o.status.as_str(), "pending" | "snoozed")
            || o.pay_at <= n
        {
            continue;
        }
        let pay = parse_dt(&o.pay_at)?;
        // Ближний наступивший срок, о котором ещё не предупреждали.
        let lead = o
            .lead_days
            .iter()
            .copied()
            .filter(|d| pay - Duration::days(*d) <= now)
            .min();
        if let Some(d) = lead {
            if !sent.contains(&(o.key.clone(), "lead".into(), d)) {
                let when = if d == 1 {
                    "Завтра".to_string()
                } else {
                    format!("Через {d} {}", days_word(d))
                };
                let sum = o
                    .amount
                    .map(|a| format!(" — {}", amount_text(a, o.minor_units, &o.currency_symbol)))
                    .unwrap_or_default();
                out.push(Notice {
                    text: format!("{when} ({}): {}{sum}", pay_day(&o), o.title),
                    occurrence: o.clone(),
                    kind: "lead".into(),
                    days: d,
                });
            }
        }
        if let Some(gap) = short.get(&o.key) {
            if !sent.contains(&(o.key.clone(), "funds".into(), 0)) {
                let account = o
                    .account_id
                    .as_deref()
                    .and_then(|a| crate::accounts::get(conn, a).ok())
                    .map(|a| a.name)
                    .unwrap_or_default();
                out.push(Notice {
                    text: format!(
                        "Не хватает {} на «{account}» для «{}» {}",
                        amount_text(*gap, o.minor_units, &o.currency_symbol),
                        o.title,
                        pay_day(&o)
                    ),
                    occurrence: o.clone(),
                    kind: "funds".into(),
                    days: 0,
                });
            }
        }
    }
    Ok(out)
}

/// Отметить предупреждения показанными. Вместе со сроком отмечаются и все
/// более дальние сроки того же платежа: их время уже прошло.
pub fn mark_notices(conn: &Connection, notices: &[Notice], at: &str) -> Result<()> {
    for x in notices {
        let k = &x.occurrence.key;
        let days: Vec<i64> = if x.kind == "lead" {
            x.occurrence
                .lead_days
                .iter()
                .copied()
                .filter(|d| *d >= x.days)
                .collect()
        } else {
            vec![0]
        };
        for d in days {
            conn.execute(
                "INSERT OR IGNORE INTO reminder_notices (source, ref_id, scheduled_at, kind, days, sent_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![k.source, k.ref_id, k.scheduled_at, x.kind, d, at],
            )?;
        }
    }
    Ok(())
}

/// Чем кончилось «Оплачено» из уведомления.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "id")]
pub enum Paid {
    /// Создана операция, напоминание выполнено.
    Transaction(String),
    /// Суммы нет — просто «выполнено».
    Marked,
    /// Не хватает счёта или категории (или это займ): открыть форму.
    NeedsForm,
}

/// «Оплачено» из уведомления: операция сегодняшним днём по напоминанию с
/// суммой, счётом и категорией и отметка «выполнено».
pub fn pay(conn: &Connection, key: &Key, today: &str) -> Result<Paid> {
    if key.source != "reminder" {
        return Ok(Paid::NeedsForm);
    }
    let at = parse_dt(&key.scheduled_at)?;
    let o = occurrences(conn, at, at)?
        .into_iter()
        .find(|o| &o.key == key)
        .ok_or(Error::NotFound("напоминание"))?;
    if o.status == "done" {
        return Ok(o.transaction_id.map_or(Paid::Marked, Paid::Transaction));
    }
    let Some(amount) = o.amount else {
        complete(conn, key, None)?;
        return Ok(Paid::Marked);
    };
    let (Some(account), Some(category)) = (o.account_id.clone(), o.category_id.clone()) else {
        return Ok(Paid::NeedsForm);
    };
    let id = crate::transactions::create(
        conn,
        &crate::transactions::TxnInput {
            kind: o.txn_type.clone().unwrap_or_else(|| "expense".into()),
            date: today.to_string(),
            account_id: account,
            amount,
            category_id: Some(category),
            to_account_id: None,
            to_amount: None,
            payee: Some(o.title.clone()),
            note: o.note.clone(),
        },
    )?;
    complete(conn, key, Some(&id))?;
    Ok(Paid::Transaction(id))
}

/// «Ближайшие 30 дней» — целыми днями: утром и вечером список один и тот же.
fn upcoming_end(now: NaiveDateTime) -> NaiveDateTime {
    (now.date() + Duration::days(30))
        .and_hms_opt(23, 59, 59)
        .expect("конец дня")
}

/// Конец промежутка через `months` месяцев (для календаря и списков).
pub fn add_months(d: NaiveDate, months: u32) -> NaiveDate {
    d.checked_add_months(Months::new(months))
        .expect("дата в пределах календаря")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::debts::{self, DebtInput};
    use crate::storage::Storage;

    fn dt(s: &str) -> NaiveDateTime {
        parse_dt(s).unwrap()
    }

    #[test]
    fn upcoming_covers_whole_thirtieth_day() {
        // Срабатывание 20.11 в 09:00 видно и утром 21.10 до 09:00, и вечером.
        let end = NaiveDate::from_ymd_opt(2026, 11, 20)
            .unwrap()
            .and_hms_opt(23, 59, 59)
            .unwrap();
        assert_eq!(upcoming_end(dt("2026-10-21T06:40")), end);
        assert_eq!(upcoming_end(dt("2026-10-21T23:59")), end);
    }
    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn days(v: Vec<NaiveDateTime>) -> Vec<String> {
        v.into_iter()
            .map(|x| x.format("%Y-%m-%d").to_string())
            .collect()
    }
    fn rule(start: &str, repeat: Repeat) -> Rule {
        Rule {
            start: dt(start),
            repeat,
            day_of_month: None,
            end_date: None,
        }
    }

    #[test]
    fn monthly_on_the_31st_and_february() {
        let mut r = rule("2026-01-31T09:00", Repeat::Monthly);
        r.day_of_month = Some(31);
        let got = days(expand(&r, dt("2026-01-01T00:00"), dt("2026-05-31T23:59")));
        assert_eq!(
            got,
            [
                "2026-01-31",
                "2026-02-28",
                "2026-03-31",
                "2026-04-30",
                "2026-05-31"
            ]
        );
        // Високосный год.
        let got = days(expand(&r, dt("2028-02-01T00:00"), dt("2028-02-29T23:59")));
        assert_eq!(got, ["2028-02-29"]);
    }

    #[test]
    fn monthly_utilities_on_the_10th() {
        // «Коммуналка»: ежемесячно 10-го.
        let mut r = rule("2026-09-10T10:00", Repeat::Monthly);
        r.day_of_month = Some(10);
        let got = expand(&r, dt("2026-10-01T00:00"), dt("2026-12-31T00:00"));
        assert_eq!(
            got.iter().map(|x| format_dt(*x)).collect::<Vec<_>>(),
            ["2026-10-10T10:00", "2026-11-10T10:00", "2026-12-10T10:00"]
        );
        // Граница включительно, до старта ничего нет.
        assert_eq!(
            expand(&r, dt("2026-10-10T10:00"), dt("2026-10-10T10:00")).len(),
            1
        );
        assert!(expand(&r, dt("2026-01-01T00:00"), dt("2026-09-09T00:00")).is_empty());
    }

    #[test]
    fn yearly_on_feb_29_and_osago() {
        let r = rule("2028-02-29T09:00", Repeat::Yearly);
        let got = days(expand(&r, dt("2028-01-01T00:00"), dt("2032-12-31T00:00")));
        assert_eq!(
            got,
            [
                "2028-02-29",
                "2029-02-28",
                "2030-02-28",
                "2031-02-28",
                "2032-02-29"
            ]
        );
        // «ОСАГО»: ежегодно 1 марта.
        let r = rule("2027-03-01T09:00", Repeat::Yearly);
        assert_eq!(
            days(expand(&r, dt("2026-10-20T00:00"), dt("2029-03-01T09:00"))),
            ["2027-03-01", "2028-03-01", "2029-03-01"]
        );
    }

    #[test]
    fn daily_weekly_once_and_end_date() {
        let mut r = rule("2026-10-01T08:30", Repeat::Weekly);
        r.end_date = Some(d("2026-10-22"));
        assert_eq!(
            days(expand(&r, dt("2026-10-05T00:00"), dt("2026-12-31T00:00"))),
            ["2026-10-08", "2026-10-15", "2026-10-22"]
        );
        let r = rule("2026-10-01T08:30", Repeat::Daily);
        let got = expand(&r, dt("2027-10-01T08:30"), dt("2027-10-03T08:00"));
        assert_eq!(
            days(got),
            ["2027-10-01", "2027-10-02"],
            "далёкий промежуток считается без перебора с начала"
        );
        let r = rule("2026-10-01T08:30", Repeat::Once);
        assert_eq!(
            expand(&r, dt("2026-10-01T00:00"), dt("2026-10-02T00:00")).len(),
            1
        );
        assert!(expand(&r, dt("2026-10-02T00:00"), dt("2026-10-03T00:00")).is_empty());
    }

    fn reminder(title: &str, start: &str, repeat: &str, amount: Option<i64>) -> ReminderInput {
        ReminderInput {
            title: title.into(),
            start_at: start.into(),
            repeat: repeat.into(),
            day_of_month: None,
            end_date: None,
            amount,
            txn_type: None,
            account_id: None,
            category_id: None,
            note: None,
            ..Default::default()
        }
    }

    #[test]
    fn actions_done_snooze_and_notifications() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let id = create(
            c,
            &reminder("ЖКХ", "2026-10-10T10:00", "monthly", Some(600_000)),
        )
        .unwrap();
        let now = dt("2026-10-11T12:00");
        let due = due_unnotified(c, now).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(
            (
                due[0].title.as_str(),
                due[0].amount,
                due[0].txn_type.as_deref()
            ),
            ("ЖКХ", Some(600_000), Some("expense"))
        );
        mark_notified(c, &[due[0].key.clone()], "2026-10-11T12:00").unwrap();
        assert!(
            due_unnotified(c, now).unwrap().is_empty(),
            "уведомление показывается один раз"
        );
        let o = overview(c, now).unwrap();
        assert_eq!(
            (o.overdue.len(), o.upcoming.len()),
            (1, 1),
            "октябрь ждёт, ноябрь впереди"
        );

        // «Отложить» до вечера: снова не наступило, потом наступает и уведомляет ещё раз.
        snooze(c, &due[0].key, "2026-10-11T18:00").unwrap();
        assert!(overview(c, now).unwrap().overdue.is_empty());
        let later = due_unnotified(c, dt("2026-10-11T18:00")).unwrap();
        assert_eq!(later.len(), 1);

        complete(c, &due[0].key, None).unwrap();
        let o = overview(c, dt("2026-10-11T19:00")).unwrap();
        assert!(o.overdue.is_empty());
        assert_eq!(o.done.len(), 1);
        reopen(c, &due[0].key).unwrap();
        assert_eq!(
            overview(c, dt("2026-10-11T19:00")).unwrap().overdue.len(),
            1
        );

        // Выключенное не срабатывает; удалённое уносит состояние.
        set_active(c, &id, false).unwrap();
        assert!(due_unnotified(c, dt("2026-11-11T12:00"))
            .unwrap()
            .is_empty());
        delete(c, &id).unwrap();
        let left: i64 = c
            .query_row("SELECT count(*) FROM reminder_occurrences", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn debt_payment_reminder_three_days_before() {
        // «Платёж по кредиту»: за 3 дня до 15-го приходит «Платёж: Сбер, 14 977,23 ₽».
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let debt = debts::create(
            db.conn_mut(),
            &DebtInput {
                direction: "borrowed".into(),
                counterparty: "Сбер".into(),
                note: None,
                currency_code: "RUB".into(),
                principal: 30_000_000,
                issue_date: "2026-10-15".into(),
                rate_bp: 1800,
                repayment_type: "annuity".into(),
                term_months: Some(24),
                first_payment_date: None,
                maturity_date: None,
                account_id: Some(card.clone()),
                interest_method: None,
                rate_period: None,
                pay_every: None,
                rate_changes: vec![],
                planned_early: vec![],
            },
        )
        .unwrap();
        let c = db.conn();
        assert!(due_unnotified(c, dt("2026-11-11T12:00"))
            .unwrap()
            .is_empty());
        let due = due_unnotified(c, dt("2026-11-12T09:00")).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(
            (due[0].title.as_str(), due[0].amount),
            ("Платёж: Сбер", Some(1_497_723))
        );
        assert_eq!(due[0].due_date.as_deref(), Some("2026-11-15"));
        assert_eq!(due[0].debt_id.as_deref(), Some(debt.as_str()));
        // Настройка «за сколько дней».
        settings::set(c, "debt_reminder_days_before", "5").unwrap();
        assert_eq!(due_unnotified(c, dt("2026-11-10T09:00")).unwrap().len(), 1);
        // Платёж отмечен — напоминание исчезает.
        let next = debts::get(c, &debt, "2026-11-12")
            .unwrap()
            .card
            .next_payment
            .unwrap();
        debts::pay(
            db.conn_mut(),
            &debt,
            &debts::PaymentInput {
                date: "2026-11-15".into(),
                account_id: card,
                principal: next.principal_part,
                interest: next.interest_part,
                schedule_id: Some(next.id),
                recalc_mode: None,
            },
        )
        .unwrap();
        let o = overview(db.conn(), dt("2026-11-16T09:00")).unwrap();
        assert!(o.overdue.is_empty());
        assert_eq!(o.upcoming[0].due_date.as_deref(), Some("2026-12-15"));
    }

    #[test]
    fn local_time_survives_clock_change() {
        // Время хранится без пояса: «в 9:00» остаётся 9:00 и после перевода часов.
        let r = rule("2026-03-27T09:00", Repeat::Daily);
        let got = expand(&r, dt("2026-03-27T00:00"), dt("2026-03-31T23:59"));
        assert!(got.iter().all(|x| x.format("%H:%M").to_string() == "09:00"));
        assert_eq!(got.len(), 5);
    }

    #[test]
    fn validation() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        assert!(create(c, &reminder(" ", "2026-10-10T10:00", "once", None)).is_err());
        assert!(create(c, &reminder("X", "2026-10-10", "once", None)).is_err());
        assert!(create(c, &reminder("X", "2026-10-10T10:00", "hourly", None)).is_err());
        assert!(create(c, &reminder("X", "2026-10-10T10:00", "once", Some(0))).is_err());
        let mut r = reminder("X", "2026-10-10T10:00", "daily", None);
        r.end_date = Some("2026-10-01".into());
        assert!(create(c, &r).is_err());
        let bad = Key {
            source: "other".into(),
            ref_id: "x".into(),
            scheduled_at: "2026-10-10T10:00".into(),
        };
        assert!(complete(c, &bad, None).is_err());
    }

    /// Рассрочка: 4 платежа по 5 000 ₽ 15-го, последний — 2 000 ₽.
    #[test]
    fn series_by_count_with_different_last_payment() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let id = create(
            c,
            &ReminderInput {
                count: Some(4),
                last_amount: Some(200_000),
                ..reminder("Рассрочка", "2026-11-15T09:00", "monthly", Some(500_000))
            },
        )
        .unwrap();
        let r = get(c, &id, dt("2026-11-01T00:00")).unwrap();
        assert_eq!(r.end_date.as_deref(), Some("2027-02-15"));
        let all = occurrences(c, dt("2026-11-01T00:00"), dt("2027-12-31T00:00")).unwrap();
        let sums: Vec<_> = all
            .iter()
            .map(|o| (o.pay_at.as_str(), o.amount, o.last))
            .collect();
        assert_eq!(
            sums,
            vec![
                ("2026-11-15T09:00", Some(500_000), false),
                ("2026-12-15T09:00", Some(500_000), false),
                ("2027-01-15T09:00", Some(500_000), false),
                ("2027-02-15T09:00", Some(200_000), true),
            ]
        );
        // Последняя сумма без конца серии не имеет смысла.
        let bad = ReminderInput {
            last_amount: Some(1),
            ..reminder("Х", "2026-11-15T09:00", "monthly", Some(5))
        };
        assert!(create(c, &bad).is_err());
        assert!(create(
            c,
            &ReminderInput {
                count: Some(0),
                ..reminder("Х", "2026-11-15T09:00", "monthly", None)
            }
        )
        .is_err());
    }

    /// По умолчанию «за 3 дня и за день»; если программа была закрыта,
    /// приходит одно, ближнее предупреждение, и дальние больше не всплывают.
    #[test]
    fn lead_notices_default_custom_and_missed() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        create(
            c,
            &reminder("Интернет", "2026-11-10T10:00", "once", Some(70_000)),
        )
        .unwrap();
        create(
            c,
            &ReminderInput {
                lead_days: Some("7, 7,2".into()),
                ..reminder("Страховка", "2026-11-10T12:00", "once", None)
            },
        )
        .unwrap();
        create(
            c,
            &ReminderInput {
                lead_days: Some(String::new()),
                ..reminder("Без заранее", "2026-11-10T12:00", "once", None)
            },
        )
        .unwrap();
        assert!(due_notices(c, dt("2026-11-02T09:00")).unwrap().is_empty());
        let n = due_notices(c, dt("2026-11-03T12:00")).unwrap();
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].text, "Через 7 дней (10.11): Страховка");
        mark_notices(c, &n, "2026-11-03T12:00").unwrap();
        assert!(due_notices(c, dt("2026-11-03T12:01")).unwrap().is_empty());

        // Программа не работала с 3-го по 9-е: за «Интернет» одно — «завтра».
        let n = due_notices(c, dt("2026-11-09T11:00")).unwrap();
        let texts: Vec<_> = n.iter().map(|x| x.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "Завтра (10.11): Интернет — 700 ₽",
                "Через 2 дня (10.11): Страховка"
            ]
        );
        mark_notices(c, &n, "2026-11-09T11:00").unwrap();
        assert!(due_notices(c, dt("2026-11-09T23:00")).unwrap().is_empty());
        // Срок прошёл — дальше обычное напоминание в сам день.
        assert!(due_notices(c, dt("2026-11-10T13:00")).unwrap().is_empty());
        assert!(settings::set(c, "reminder_lead_days", "0").is_err());
        settings::set(c, "reminder_lead_days", "14,1").unwrap();
    }

    /// Один платёж серии: другая сумма и перенос; «этот и следующие» — новая серия.
    #[test]
    fn edit_one_payment_or_all_following() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let id = create(
            c,
            &reminder("Аренда", "2026-11-05T09:00", "monthly", Some(3_000_000)),
        )
        .unwrap();
        let dec = Key {
            source: "reminder".into(),
            ref_id: id.clone(),
            scheduled_at: "2026-12-05T09:00".into(),
        };
        edit_occurrence(c, &dec, Some(3_500_000), Some("2026-12-07T09:00")).unwrap();
        let all = occurrences(c, dt("2026-11-01T00:00"), dt("2027-01-31T00:00")).unwrap();
        let dec_o = all.iter().find(|o| o.key == dec).unwrap();
        assert_eq!(
            (dec_o.amount, dec_o.pay_at.as_str(), dec_o.edited),
            (Some(3_500_000), "2026-12-07T09:00", true)
        );
        assert_eq!(all[2].amount, Some(3_000_000), "январь как в серии");
        // В Календаре платёж — в новый день.
        let m = crate::calendar::month(c, "2026-12", "2026-11-01").unwrap();
        let has = |d: &str| {
            m.days
                .iter()
                .any(|x| x.date == d && !x.reminders.is_empty())
        };
        assert!(has("2026-12-07") && !has("2026-12-05"));
        assert!(edit_occurrence(
            c,
            &Key {
                source: "debt".into(),
                ..dec.clone()
            },
            None,
            None
        )
        .is_err());

        // С февраля аренда 32 000 ₽.
        let feb = Key {
            scheduled_at: "2027-02-05T09:00".into(),
            ..dec.clone()
        };
        let new_id = split_from(
            c,
            &feb,
            &reminder("Аренда", "2027-02-05T09:00", "monthly", Some(3_200_000)),
        )
        .unwrap();
        assert_ne!(new_id, id);
        let all = occurrences(c, dt("2027-01-01T00:00"), dt("2027-03-31T00:00")).unwrap();
        let sums: Vec<_> = all.iter().map(|o| o.amount).collect();
        assert_eq!(
            sums,
            vec![Some(3_000_000), Some(3_200_000), Some(3_200_000)]
        );
        // С первого платежа — просто правка той же серии.
        let first = Key {
            scheduled_at: "2027-02-05T09:00".into(),
            ref_id: new_id.clone(),
            ..dec
        };
        let same = split_from(
            c,
            &first,
            &reminder("Аренда", "2027-02-05T09:00", "monthly", Some(3_300_000)),
        )
        .unwrap();
        assert_eq!(same, new_id);
    }

    /// За 3 дня до расхода со счёта проверяем, хватит ли денег с учётом
    /// предыдущих платежей с него; «Оплачено» создаёт операцию.
    #[test]
    fn funds_check_and_pay_from_notification() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let usd = accounts::create(c, &input("Доллары", "cash", "USD", 0)).unwrap();
        let with = |title: &str, at: &str, amount: i64, acc: &str| ReminderInput {
            account_id: Some(acc.into()),
            lead_days: Some(String::new()),
            ..reminder(title, at, "once", Some(amount))
        };
        create(c, &with("Связь", "2026-11-10T09:00", 600_000, &card)).unwrap();
        let rent = create(c, &with("Аренда", "2026-11-11T09:00", 700_000, &card)).unwrap();
        create(c, &with("Далеко", "2026-11-20T09:00", 900_000, &card)).unwrap();
        create(c, &with("Валюта", "2026-11-10T09:00", 900_000, &usd)).unwrap();
        let now = dt("2026-11-08T10:00");
        let short = shortfalls(c, now, 3).unwrap();
        assert_eq!(
            short.len(),
            1,
            "только «Аренда»: «Далеко» позже, валютный счёт не проверяем"
        );
        let rent_key = Key {
            source: "reminder".into(),
            ref_id: rent.clone(),
            scheduled_at: "2026-11-11T09:00".into(),
        };
        assert_eq!(short.get(&rent_key), Some(&300_000));
        let n = due_notices(c, now).unwrap();
        assert_eq!(n.len(), 1);
        assert_eq!(
            n[0].text,
            "Не хватает 3\u{a0}000 ₽ на «Карта» для «Аренда» 11.11"
        );
        mark_notices(c, &n, "2026-11-08T10:00").unwrap();
        assert!(due_notices(c, now).unwrap().is_empty());
        assert_eq!(
            overview(c, now)
                .unwrap()
                .upcoming
                .iter()
                .filter(|o| o.shortfall.is_some())
                .count(),
            1
        );
        settings::set(c, "reminder_funds_days", "0").unwrap();
        assert!(shortfalls(c, now, funds_days(c).unwrap())
            .unwrap()
            .is_empty());

        // «Оплачено»: расход по карте сегодняшним днём, напоминание выполнено.
        assert_eq!(
            pay(c, &rent_key, "2026-11-08").unwrap(),
            Paid::NeedsForm,
            "без категории — форма"
        );
        let food: String = c
            .query_row(
                "SELECT id FROM categories WHERE kind = 'expense' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        c.execute(
            "UPDATE reminders SET category_id = ?1 WHERE id = ?2",
            params![food, rent],
        )
        .unwrap();
        let txn = pay(c, &rent_key, "2026-11-08").unwrap();
        assert!(matches!(txn, Paid::Transaction(_)));
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 300_000);
        assert_eq!(
            pay(c, &rent_key, "2026-11-08").unwrap(),
            txn,
            "повтор ничего не создаёт"
        );
        let o = overview(c, now).unwrap();
        assert!(o.upcoming.iter().all(|x| x.key != rent_key));
        // Без счёта — только отметка.
        let plain = create(
            c,
            &reminder("Без счёта", "2026-11-09T09:00", "once", Some(1)),
        )
        .unwrap();
        let k = Key {
            source: "reminder".into(),
            ref_id: plain,
            scheduled_at: "2026-11-09T09:00".into(),
        };
        assert_eq!(pay(c, &k, "2026-11-09").unwrap(), Paid::NeedsForm);
        let none = create(c, &reminder("Позвонить", "2026-11-09T09:00", "once", None)).unwrap();
        let k = Key { ref_id: none, ..k };
        assert_eq!(pay(c, &k, "2026-11-09").unwrap(), Paid::Marked);
    }

    /// Напоминание у заметки и у события: видно в них и удаляется вместе с ними.
    #[test]
    fn reminder_on_note_and_event() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let note = crate::notes::create(
            c,
            &crate::notes::NoteInput {
                body: "Продлить страховку".into(),
                date: Some("2026-12-01".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let id = create(
            c,
            &ReminderInput {
                note_id: Some(note.clone()),
                lead_days: Some("7".into()),
                ..reminder("Продлить страховку", "2026-12-01T09:00", "once", None)
            },
        )
        .unwrap();
        assert_eq!(
            crate::notes::get(c, &note).unwrap().reminder_id,
            Some(id.clone())
        );
        let event = crate::events::create(
            c,
            &crate::events::EventInput {
                name: "Отпуск".into(),
                start_date: "2027-01-10".into(),
                end_date: "2027-01-20".into(),
                budget: None,
                note: None,
            },
        )
        .unwrap();
        let ev_rem = create(
            c,
            &ReminderInput {
                event_id: Some(event.clone()),
                ..reminder("Отпуск", "2027-01-10T09:00", "once", None)
            },
        )
        .unwrap();
        let events = crate::events::list(c, "2026-11-01").unwrap();
        assert_eq!(events[0].reminder_id, Some(ev_rem));
        crate::notes::delete(c, &note).unwrap();
        crate::events::delete(c, &event).unwrap();
        assert!(list(c, dt("2026-11-01T00:00")).unwrap().is_empty());
        assert!(get(c, &id, dt("2026-11-01T00:00")).is_err());
    }
}
