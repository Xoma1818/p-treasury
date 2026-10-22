//! Долги и займы. Каждый долг — служебный счёт типа `debt`: выдача и возврат
//! основного долга — переводы, проценты — расход «Проценты по кредитам» или
//! доход «Проценты по займам». Остаток долга = сумма долга − возвращённое.
//!
//! График (`debt_schedule`) — функция условий долга и списка платежей:
//! после каждого платежа или его удаления он перестраивается заново
//! (`rebuild`), строки обновляются по номеру, поэтому их id не меняются.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::loan_calc::{
    self, Event, HolidayInput, InterestMethod, LoanInput, PlannedEarlyInput, RateChangeInput,
    Recalc, Repayment, Row, Sim, SimView, Totals,
};
use crate::money::format_amount;
use crate::{accounts, categories, currencies, ids, time, Error, Result};

const INTEREST_EXPENSE: &str = "Проценты по кредитам";
const INTEREST_INCOME: &str = "Проценты по займам";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtInput {
    /// `lent` — я дал, `borrowed` — я взял.
    pub direction: String,
    pub counterparty: String,
    pub note: Option<String>,
    pub currency_code: String,
    pub principal: i64,
    pub issue_date: String,
    pub rate_bp: i64,
    pub repayment_type: String,
    pub term_months: Option<u32>,
    pub first_payment_date: Option<String>,
    pub maturity_date: Option<String>,
    /// Счёт, с которого выданы или на который получены деньги. Пусто — долг
    /// заведён «как есть» (например, старый кредит), без операции.
    pub account_id: Option<String>,
    /// `daily` (по умолчанию, как в банке) или `monthly` (ставка ÷ 12).
    #[serde(default)]
    pub interest_method: Option<String>,
    /// Изменения ставки с дат.
    #[serde(default)]
    pub rate_changes: Vec<RateChangeInput>,
    /// Плановые досрочки (только для прогноза).
    #[serde(default)]
    pub planned_early: Vec<PlannedEarlyInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentInput {
    pub date: String,
    pub account_id: String,
    pub principal: i64,
    pub interest: i64,
    /// Строка графика, которую закрывает платёж; пусто — досрочный или внеплановый.
    pub schedule_id: Option<String>,
    /// `reduce_payment` (по умолчанию) или `reduce_term`.
    pub recalc_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRow {
    pub id: String,
    pub seq: u32,
    pub due_date: String,
    pub payment: i64,
    pub principal_part: i64,
    pub interest_part: i64,
    pub balance_after: i64,
    /// `pending`, `paid`, `partial`.
    pub status: String,
    pub overdue: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRow {
    pub id: String,
    pub date: String,
    pub principal: i64,
    pub interest: i64,
    pub schedule_seq: Option<u32>,
    pub recalc_mode: Option<String>,
    pub account_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtCard {
    pub id: String,
    pub direction: String,
    pub counterparty: String,
    pub note: Option<String>,
    pub account_id: String,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub principal: i64,
    pub issue_date: String,
    pub rate_bp: i64,
    pub repayment_type: String,
    pub term_months: Option<u32>,
    pub maturity_date: String,
    pub status: String,
    pub outstanding: i64,
    pub principal_paid: i64,
    pub interest_paid: i64,
    /// Проценты, которые ещё предстоят по графику.
    pub interest_planned: i64,
    pub next_payment: Option<ScheduleRow>,
    pub overdue_count: u32,
    pub overdue_amount: i64,
    /// Счёт для следующего платежа: счёт последней операции по долгу (выдачи или платежа).
    pub default_account_id: Option<String>,
    /// `daily` или `monthly`.
    pub interest_method: String,
    pub first_payment_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtDetail {
    pub card: DebtCard,
    pub schedule: Vec<ScheduleRow>,
    pub payments: Vec<PaymentRow>,
    pub rate_changes: Vec<RateChangeRow>,
    pub holidays: Vec<HolidayRow>,
    pub planned_early: Vec<PlannedEarlyRow>,
}

struct Terms {
    id: String,
    direction: String,
    counterparty: String,
    account_id: String,
    currency_code: String,
    principal: i64,
    issue_date: String,
    rate_bp: i64,
    repayment: Repayment,
    term_months: Option<u32>,
    first_payment_date: Option<String>,
    maturity_date: String,
    status: String,
    method: InterestMethod,
}

impl Terms {
    fn loan(&self) -> LoanInput {
        LoanInput {
            principal: self.principal,
            rate_bp: self.rate_bp,
            repayment: self.repayment,
            term_months: self.term_months,
            issue_date: self.issue_date.clone(),
            first_payment_date: self.first_payment_date.clone(),
            maturity_date: (self.repayment == Repayment::Bullet)
                .then(|| self.maturity_date.clone()),
            interest_method: self.method,
        }
    }

    fn engine(&self) -> Result<loan_calc::Terms> {
        loan_calc::Terms::from_input(&self.loan())
    }
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn terms(conn: &Connection, id: &str) -> Result<Terms> {
    conn.query_row(
        "SELECT id, direction, counterparty, account_id, currency_code, principal, issue_date, rate_bp,
                repayment_type, term_months, first_payment_date, maturity_date, status, interest_method
         FROM debts WHERE id = ?1",
        [id],
        |r| {
            Ok(Terms {
                id: r.get(0)?,
                direction: r.get(1)?,
                counterparty: r.get(2)?,
                account_id: r.get(3)?,
                currency_code: r.get(4)?,
                principal: r.get(5)?,
                issue_date: r.get(6)?,
                rate_bp: r.get(7)?,
                repayment: Repayment::parse(&r.get::<_, String>(8)?).unwrap_or(Repayment::Annuity),
                term_months: r.get(9)?,
                first_payment_date: r.get(10)?,
                maturity_date: r.get(11)?,
                status: r.get(12)?,
                method: InterestMethod::parse(&r.get::<_, String>(13)?)
                    .unwrap_or(InterestMethod::Monthly),
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("долг"))
}

/// Счёт оплаты: обычный открытый счёт в валюте долга.
fn payment_account(conn: &Connection, id: &str, currency: &str) -> Result<accounts::Head> {
    let a = accounts::head(conn, id)?;
    if a.kind == "debt" {
        return invalid("выберите обычный счёт");
    }
    if a.archived {
        return invalid(format!("счёт «{}» закрыт", a.name));
    }
    if a.currency_code != currency {
        return invalid(format!(
            "счёт «{}» в другой валюте: выберите счёт в {currency}",
            a.name
        ));
    }
    Ok(a)
}

#[allow(clippy::too_many_arguments)]
fn insert_txn(
    conn: &Connection,
    kind: &str,
    date: &str,
    account_id: &str,
    amount: i64,
    category_id: Option<&str>,
    to_account_id: Option<&str>,
    payee: &str,
    note: &str,
    debt_id: &str,
) -> Result<String> {
    let id = ids::new_id();
    conn.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, category_id, to_account_id, to_amount,
                                   payee, note, debt_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            id,
            kind,
            date,
            account_id,
            amount,
            category_id,
            to_account_id,
            to_account_id.map(|_| amount),
            payee,
            note,
            debt_id,
            time::now_utc()
        ],
    )?;
    Ok(id)
}

/// Категория процентов; если её удалили, создаётся заново.
fn interest_category(conn: &Connection, direction: &str) -> Result<String> {
    let (name, kind) = if direction == "borrowed" {
        (INTEREST_EXPENSE, "expense")
    } else {
        (INTEREST_INCOME, "income")
    };
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM categories WHERE name = ?1 AND kind = ?2 AND archived_at IS NULL ORDER BY parent_id IS NOT NULL LIMIT 1",
            params![name, kind],
            |r| r.get(0),
        )
        .optional()?;
    match found {
        Some(id) => Ok(id),
        None => categories::create(
            conn,
            &categories::CategoryInput {
                name: name.into(),
                kind: kind.into(),
                parent_id: None,
            },
        ),
    }
}

pub fn create(conn: &mut Connection, input: &DebtInput) -> Result<String> {
    let tx = conn.transaction()?;
    let id = create_in(&tx, input)?;
    tx.commit()?;
    Ok(id)
}

/// Как [`create`], но внутри уже открытой транзакции (общие траты пишут
/// расход и несколько долгов вместе).
pub fn create_in(conn: &Connection, input: &DebtInput) -> Result<String> {
    if !matches!(input.direction.as_str(), "lent" | "borrowed") {
        return invalid("направление: «я дал» или «я взял»");
    }
    let counterparty = input.counterparty.trim();
    if counterparty.is_empty() {
        return invalid("укажите, кто должен или кому");
    }
    currencies::get(conn, &input.currency_code)?;
    let repayment = Repayment::parse(&input.repayment_type)?;
    let method = match input.interest_method.as_deref() {
        None | Some("") => InterestMethod::Daily,
        Some(m) => InterestMethod::parse(m)?,
    };
    let loan = LoanInput {
        principal: input.principal,
        rate_bp: input.rate_bp,
        repayment,
        term_months: if repayment == Repayment::Bullet {
            None
        } else {
            input.term_months
        },
        issue_date: input.issue_date.clone(),
        first_payment_date: if repayment == Repayment::Bullet {
            None
        } else {
            clean(&input.first_payment_date)
        },
        maturity_date: clean(&input.maturity_date),
        interest_method: method,
    };
    let schedule = loan_calc::calculate(&loan)?;
    let engine = loan_calc::Terms::from_input(&loan)?;
    for r in &input.rate_changes {
        if r.parse()?.from < engine.issue {
            return invalid("ставка меняется раньше даты выдачи");
        }
    }
    for p in &input.planned_early {
        p.check()?;
    }
    if let Some(acc) = input.account_id.as_deref() {
        payment_account(conn, acc, &input.currency_code)?;
    }
    let first_payment = match repayment {
        Repayment::Bullet => None,
        _ => schedule.rows.first().map(|r| r.due_date.clone()),
    };

    let tx = conn;
    let now = time::now_utc();
    let account = ids::new_id();
    let sign = if input.direction == "lent" { 1 } else { -1 };
    // Без счёта оплаты долг появляется сразу: начальный остаток служебного счёта.
    let opening = if input.account_id.is_some() {
        0
    } else {
        sign * input.principal
    };
    tx.execute(
        "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, include_in_total,
                               sort_order, created_at, updated_at)
         VALUES (?1, ?2, 'debt', ?3, ?4, ?5, 0, 0, ?6, ?6)",
        params![account, counterparty, input.currency_code, opening, input.issue_date, now],
    )?;
    let id = ids::new_id();
    tx.execute(
        "INSERT INTO debts (id, direction, counterparty, note, account_id, currency_code, principal, issue_date,
                            rate_bp, repayment_type, frequency, term_months, first_payment_date, maturity_date,
                            created_at, updated_at, interest_method)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16)",
        params![
            id,
            input.direction,
            counterparty,
            clean(&input.note),
            account,
            input.currency_code,
            input.principal,
            input.issue_date,
            input.rate_bp,
            repayment.as_str(),
            if repayment == Repayment::Bullet { "once" } else { "monthly" },
            loan.term_months,
            first_payment,
            schedule.maturity_date,
            now,
            method.as_str()
        ],
    )?;
    if let Some(acc) = input.account_id.as_deref() {
        let (from, to, note) = if input.direction == "lent" {
            (acc, account.as_str(), "Выдача долга")
        } else {
            (account.as_str(), acc, "Получение долга")
        };
        insert_txn(
            tx,
            "transfer",
            &input.issue_date,
            from,
            input.principal,
            None,
            Some(to),
            counterparty,
            note,
            &id,
        )?;
    }
    for r in &input.rate_changes {
        insert_rate_change(tx, &id, r)?;
    }
    insert_planned(tx, &id, &input.planned_early)?;
    rebuild(tx, &id)?;
    snapshot(tx, &id, "Заём записан")?;
    Ok(id)
}

pub fn update_info(
    conn: &Connection,
    id: &str,
    counterparty: &str,
    note: Option<String>,
) -> Result<()> {
    let t = terms(conn, id)?;
    let name = counterparty.trim();
    if name.is_empty() {
        return invalid("укажите, кто должен или кому");
    }
    let now = time::now_utc();
    conn.execute(
        "UPDATE debts SET counterparty = ?2, note = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, clean(&note), now],
    )?;
    conn.execute(
        "UPDATE accounts SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![t.account_id, name, now],
    )?;
    Ok(())
}

/// Удалить долг вместе с его операциями и графиком.
pub fn delete(conn: &mut Connection, id: &str) -> Result<()> {
    let t = terms(conn, id)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM debt_payments WHERE debt_id = ?1", [id])?;
    tx.execute("DELETE FROM transactions WHERE debt_id = ?1", [id])?;
    tx.execute("DELETE FROM debts WHERE id = ?1", [id])?;
    tx.execute("DELETE FROM accounts WHERE id = ?1", [&t.account_id])?;
    tx.commit()?;
    Ok(())
}

fn outstanding(conn: &Connection, t: &Terms) -> Result<i64> {
    let paid: i64 = conn.query_row(
        "SELECT COALESCE(sum(principal_amount), 0) FROM debt_payments WHERE debt_id = ?1",
        [&t.id],
        |r| r.get(0),
    )?;
    Ok(t.principal - paid)
}

/// Отметить платёж: перевод на основной долг, операция на проценты, запись
/// платежа и пересчёт графика — одной транзакцией.
pub fn pay(conn: &mut Connection, debt_id: &str, input: &PaymentInput) -> Result<String> {
    let t = terms(conn, debt_id)?;
    if t.status == "closed" {
        return invalid("долг уже погашен");
    }
    time::check_date(&input.date)?;
    if input.date < t.issue_date {
        return invalid("платёж раньше даты выдачи долга");
    }
    if input.principal < 0 || input.interest < 0 || input.principal + input.interest == 0 {
        return invalid("введите сумму платежа");
    }
    let left = outstanding(conn, &t)?;
    if input.principal > left {
        return invalid(format!("основной долг больше остатка ({left})"));
    }
    let mode = match input.recalc_mode.as_deref() {
        None | Some("reduce_payment") => "reduce_payment",
        Some("reduce_term") => "reduce_term",
        Some(m) => return invalid(format!("неизвестный способ пересчёта: {m}")),
    };
    payment_account(conn, &input.account_id, &t.currency_code)?;
    if let Some(sid) = input.schedule_id.as_deref() {
        let next: Option<String> = conn
            .query_row(
                "SELECT id FROM debt_schedule WHERE debt_id = ?1 AND status = 'pending' ORDER BY seq LIMIT 1",
                [debt_id],
                |r| r.get(0),
            )
            .optional()?;
        if next.as_deref() != Some(sid) {
            return invalid("отмечать можно только ближайший неоплаченный платёж графика");
        }
    }

    let tx = conn.transaction()?;
    let reason = payment_reason(&tx, &t, input, mode)?;
    snapshot(&tx, debt_id, &reason)?;
    let acc = input.account_id.as_str();
    let principal_txn = if input.principal > 0 {
        let (from, to) = if t.direction == "lent" {
            (t.account_id.as_str(), acc)
        } else {
            (acc, t.account_id.as_str())
        };
        Some(insert_txn(
            &tx,
            "transfer",
            &input.date,
            from,
            input.principal,
            None,
            Some(to),
            &t.counterparty,
            "Возврат долга",
            debt_id,
        )?)
    } else {
        None
    };
    let interest_txn = if input.interest > 0 {
        let cat = interest_category(&tx, &t.direction)?;
        let kind = if t.direction == "borrowed" {
            "expense"
        } else {
            "income"
        };
        Some(insert_txn(
            &tx,
            kind,
            &input.date,
            acc,
            input.interest,
            Some(&cat),
            None,
            &t.counterparty,
            "Проценты по долгу",
            debt_id,
        )?)
    } else {
        None
    };
    let id = ids::new_id();
    tx.execute(
        "INSERT INTO debt_payments (id, debt_id, schedule_id, date, principal_amount, interest_amount,
                                    principal_transaction_id, interest_transaction_id, recalc_mode, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            debt_id,
            input.schedule_id,
            input.date,
            input.principal,
            input.interest,
            principal_txn,
            interest_txn,
            mode,
            time::now_utc()
        ],
    )?;
    rebuild(&tx, debt_id)?;
    tx.commit()?;
    Ok(id)
}

/// Удалить платёж: его операции удаляются, график перестраивается.
pub fn delete_payment(conn: &mut Connection, payment_id: &str) -> Result<()> {
    #[allow(clippy::type_complexity)]
    let (debt_id, p_txn, i_txn, date, total): (String, Option<String>, Option<String>, String, i64) = conn
        .query_row(
            "SELECT debt_id, principal_transaction_id, interest_transaction_id, date, principal_amount + interest_amount
             FROM debt_payments WHERE id = ?1",
            [payment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or(Error::NotFound("платёж"))?;
    let t = terms(conn, &debt_id)?;
    let tx = conn.transaction()?;
    let reason = format!(
        "Удалён платёж {} от {}",
        money(&tx, &t, total)?,
        ru_date(&date)
    );
    snapshot(&tx, &debt_id, &reason)?;
    tx.execute("DELETE FROM debt_payments WHERE id = ?1", [payment_id])?;
    for t in [p_txn, i_txn].into_iter().flatten() {
        tx.execute("DELETE FROM transactions WHERE id = ?1", [t])?;
    }
    rebuild(&tx, &debt_id)?;
    tx.commit()?;
    Ok(())
}

/// События графика долга: платежи, изменения ставки и каникулы.
fn events(conn: &Connection, debt_id: &str) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare(
        "SELECT s.seq, p.principal_amount, p.interest_amount, COALESCE(p.recalc_mode, 'reduce_payment'), p.date
         FROM debt_payments p LEFT JOIN debt_schedule s ON s.id = p.schedule_id
         WHERE p.debt_id = ?1 ORDER BY p.date, p.created_at",
    )?;
    let rows: Vec<(Option<u32>, i64, i64, String, String)> = stmt
        .query_map([debt_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut events = Vec::with_capacity(rows.len());
    for (seq, principal, interest, mode, date) in rows {
        events.push(Event::Payment(loan_calc::Payment {
            date: loan_calc::parse_date(&date)?,
            principal,
            interest,
            seq,
            mode: Recalc::parse(&mode)?,
        }));
    }
    for r in rate_changes(conn, debt_id)? {
        events.push(Event::RateChange(r.input.parse()?));
    }
    for h in holidays(conn, debt_id)? {
        events.push(Event::Holiday(h.input.parse()?));
    }
    Ok(events)
}

fn simulate_debt(conn: &Connection, t: &Terms) -> Result<Sim> {
    Ok(loan_calc::simulate(&t.engine()?, &events(conn, &t.id)?))
}

/// Перестроить график по условиям и событиям. Вызывается внутри транзакции.
fn rebuild(conn: &Connection, debt_id: &str) -> Result<()> {
    let t = terms(conn, debt_id)?;
    let sim = simulate_debt(conn, &t)?;
    let lines: Vec<(&Row, &str)> = sim
        .rows
        .iter()
        .map(|l| (&l.row, l.status.as_str()))
        .collect();
    write_schedule(conn, &t, &lines, sim.outstanding)
}

/// Записать строки графика и состояние долга.
fn write_schedule(conn: &Connection, t: &Terms, lines: &[(&Row, &str)], left: i64) -> Result<()> {
    let debt_id = t.id.as_str();
    // Запись по номеру строки: id сохраняются (на них ссылаются платежи и напоминания).
    for (r, status) in lines {
        let changed = conn.execute(
            "UPDATE debt_schedule SET due_date = ?3, payment = ?4, principal_part = ?5, interest_part = ?6,
                    balance_after = ?7, status = ?8
             WHERE debt_id = ?1 AND seq = ?2",
            params![debt_id, r.seq, r.due_date, r.payment, r.principal_part, r.interest_part, r.balance_after, status],
        )?;
        if changed == 0 {
            conn.execute(
                "INSERT INTO debt_schedule (id, debt_id, seq, due_date, payment, principal_part, interest_part,
                                            balance_after, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![ids::new_id(), debt_id, r.seq, r.due_date, r.payment, r.principal_part, r.interest_part, r.balance_after, status],
            )?;
        }
    }
    let max_seq = lines.iter().map(|l| l.0.seq).max().unwrap_or(0);
    conn.execute(
        "DELETE FROM debt_schedule WHERE debt_id = ?1 AND seq > ?2",
        params![debt_id, max_seq],
    )?;

    let maturity = lines
        .last()
        .map(|l| l.0.due_date.clone())
        .unwrap_or(t.maturity_date.clone());
    let closed_at: Option<String> = if left == 0 {
        conn.query_row(
            "SELECT date FROM debt_payments WHERE debt_id = ?1 ORDER BY date DESC, created_at DESC LIMIT 1",
            [debt_id],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    conn.execute(
        "UPDATE debts SET maturity_date = ?2, status = ?3, closed_at = ?4, updated_at = ?5 WHERE id = ?1",
        params![debt_id, maturity, if left == 0 { "closed" } else { "active" }, closed_at, time::now_utc()],
    )?;
    Ok(())
}

const ROW_SELECT: &str =
    "SELECT id, seq, due_date, payment, principal_part, interest_part, balance_after, status FROM debt_schedule";

fn schedule_rows(conn: &Connection, debt_id: &str, today: &str) -> Result<Vec<ScheduleRow>> {
    let mut stmt = conn.prepare(&format!("{ROW_SELECT} WHERE debt_id = ?1 ORDER BY seq"))?;
    let rows = stmt.query_map([debt_id], |r| {
        let due: String = r.get(2)?;
        let status: String = r.get(7)?;
        Ok(ScheduleRow {
            id: r.get(0)?,
            seq: r.get(1)?,
            overdue: status == "pending" && due.as_str() < today,
            due_date: due,
            payment: r.get(3)?,
            principal_part: r.get(4)?,
            interest_part: r.get(5)?,
            balance_after: r.get(6)?,
            status,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn card(conn: &Connection, t: &Terms, schedule: &[ScheduleRow]) -> Result<DebtCard> {
    let (note, symbol, minor): (Option<String>, String, u32) = conn.query_row(
        "SELECT d.note, c.symbol, c.minor_units FROM debts d JOIN currencies c ON c.code = d.currency_code WHERE d.id = ?1",
        [&t.id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let (principal_paid, interest_paid): (i64, i64) = conn.query_row(
        "SELECT COALESCE(sum(principal_amount), 0), COALESCE(sum(interest_amount), 0) FROM debt_payments WHERE debt_id = ?1",
        [&t.id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let pending = || schedule.iter().filter(|r| r.status == "pending");
    let default_account_id: Option<String> = conn
        .query_row(
            "SELECT CASE WHEN account_id = ?2 THEN to_account_id ELSE account_id END FROM transactions
             WHERE debt_id = ?1 ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 1",
            params![t.id, t.account_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(DebtCard {
        id: t.id.clone(),
        direction: t.direction.clone(),
        counterparty: t.counterparty.clone(),
        note,
        account_id: t.account_id.clone(),
        currency_code: t.currency_code.clone(),
        currency_symbol: symbol,
        minor_units: minor,
        principal: t.principal,
        issue_date: t.issue_date.clone(),
        rate_bp: t.rate_bp,
        repayment_type: t.repayment.as_str().into(),
        term_months: t.term_months,
        maturity_date: t.maturity_date.clone(),
        status: t.status.clone(),
        outstanding: t.principal - principal_paid,
        principal_paid,
        interest_paid,
        interest_planned: pending().map(|r| r.interest_part).sum(),
        next_payment: pending().next().cloned(),
        overdue_count: pending().filter(|r| r.overdue).count() as u32,
        overdue_amount: pending().filter(|r| r.overdue).map(|r| r.payment).sum(),
        default_account_id,
        interest_method: t.method.as_str().into(),
        first_payment_date: t.first_payment_date.clone(),
    })
}

pub fn get(conn: &Connection, id: &str, today: &str) -> Result<DebtDetail> {
    let t = terms(conn, id)?;
    let schedule = schedule_rows(conn, id, today)?;
    let mut stmt = conn.prepare(
        "SELECT p.id, p.date, p.principal_amount, p.interest_amount, s.seq, p.recalc_mode,
                COALESCE(pa.name, ia.name)
         FROM debt_payments p
         LEFT JOIN debt_schedule s ON s.id = p.schedule_id
         LEFT JOIN transactions pt ON pt.id = p.principal_transaction_id
         LEFT JOIN transactions it ON it.id = p.interest_transaction_id
         LEFT JOIN accounts pa ON pa.id = (CASE WHEN pt.account_id = ?2 THEN pt.to_account_id ELSE pt.account_id END)
         LEFT JOIN accounts ia ON ia.id = it.account_id
         WHERE p.debt_id = ?1 ORDER BY p.date DESC, p.created_at DESC, p.rowid DESC",
    )?;
    let payments = stmt
        .query_map(params![id, t.account_id], |r| {
            Ok(PaymentRow {
                id: r.get(0)?,
                date: r.get(1)?,
                principal: r.get(2)?,
                interest: r.get(3)?,
                schedule_seq: r.get(4)?,
                recalc_mode: r.get(5)?,
                account_name: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(DebtDetail {
        card: card(conn, &t, &schedule)?,
        schedule,
        payments,
        rate_changes: rate_changes(conn, id)?,
        holidays: holidays(conn, id)?,
        planned_early: planned_early(conn, id)?,
    })
}

pub fn list(conn: &Connection, today: &str) -> Result<Vec<DebtCard>> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM debts ORDER BY status = 'closed', maturity_date, counterparty")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.iter()
        .map(|id| {
            let t = terms(conn, id)?;
            let schedule = schedule_rows(conn, id, today)?;
            card(conn, &t, &schedule)
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upcoming {
    pub debt_id: String,
    pub schedule_id: String,
    pub counterparty: String,
    pub direction: String,
    pub due_date: String,
    pub payment: i64,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub overdue: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub base_currency: String,
    pub base_symbol: String,
    /// Сколько должны мне (остатки по «я дал»), в основной валюте.
    pub owed_to_me: i64,
    /// Сколько должен я.
    pub i_owe: i64,
    /// Имущество по последней оценке, в основной валюте.
    pub assets: i64,
    /// Счета («в общем балансе») + имущество + должны мне − должен я.
    pub net_worth: i64,
    pub accounts_total: i64,
    pub missing_rates: Vec<String>,
    /// Неоплаченные платежи: просроченные и ближайшие, по дате.
    pub upcoming: Vec<Upcoming>,
}

/// Сводка раздела и «Чистые активы» на сегодня.
pub fn summary(conn: &Connection, today: &str, upcoming_limit: usize) -> Result<Summary> {
    let totals = accounts::totals(conn, today)?;
    let mut missing_rates = totals.missing_rates.clone();
    let (assets, assets_missing) = crate::assets::total(conn, today)?;
    for c in assets_missing {
        if !missing_rates.contains(&c) {
            missing_rates.push(c);
        }
    }
    let (mut owed_to_me, mut i_owe) = (0, 0);
    for d in list(conn, today)?
        .into_iter()
        .filter(|d| d.status == "active")
    {
        match currencies::convert(
            conn,
            d.outstanding,
            &d.currency_code,
            &totals.base_currency,
            today,
        )? {
            Some(v) if d.direction == "lent" => owed_to_me += v,
            Some(v) => i_owe += v,
            None if !missing_rates.contains(&d.currency_code) => {
                missing_rates.push(d.currency_code)
            }
            None => {}
        }
    }
    let mut stmt = conn.prepare(
        "SELECT s.debt_id, s.id, d.counterparty, d.direction, s.due_date, s.payment, c.symbol, c.minor_units
         FROM debt_schedule s JOIN debts d ON d.id = s.debt_id JOIN currencies c ON c.code = d.currency_code
         WHERE s.status = 'pending' AND d.status = 'active'
           AND s.seq = (SELECT min(seq) FROM debt_schedule x WHERE x.debt_id = s.debt_id AND x.status = 'pending')
         ORDER BY s.due_date LIMIT ?1",
    )?;
    let upcoming = stmt
        .query_map([upcoming_limit as i64], |r| {
            let due: String = r.get(4)?;
            Ok(Upcoming {
                debt_id: r.get(0)?,
                schedule_id: r.get(1)?,
                counterparty: r.get(2)?,
                direction: r.get(3)?,
                overdue: due.as_str() < today,
                due_date: due,
                payment: r.get(5)?,
                currency_symbol: r.get(6)?,
                minor_units: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Summary {
        base_currency: totals.base_currency,
        base_symbol: totals.base_symbol,
        owed_to_me,
        i_owe,
        assets,
        net_worth: totals.total + assets + owed_to_me - i_owe,
        accounts_total: totals.total,
        missing_rates,
        upcoming,
    })
}

// --- Условия, ставка, каникулы, плановые досрочки, версии (0.17) ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateChangeRow {
    pub id: String,
    #[serde(flatten)]
    pub input: RateChangeInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayRow {
    pub id: String,
    #[serde(flatten)]
    pub input: HolidayInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedEarlyRow {
    pub id: String,
    #[serde(flatten)]
    pub input: PlannedEarlyInput,
}

fn rate_changes(conn: &Connection, debt_id: &str) -> Result<Vec<RateChangeRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_date, rate_bp FROM debt_rate_changes WHERE debt_id = ?1 ORDER BY from_date",
    )?;
    let rows = stmt.query_map([debt_id], |r| {
        Ok(RateChangeRow {
            id: r.get(0)?,
            input: RateChangeInput {
                from: r.get(1)?,
                rate_bp: r.get(2)?,
            },
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn holidays(conn: &Connection, debt_id: &str) -> Result<Vec<HolidayRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_seq, months, kind FROM debt_holidays WHERE debt_id = ?1 ORDER BY from_seq, created_at",
    )?;
    let rows = stmt.query_map([debt_id], |r| {
        Ok(HolidayRow {
            id: r.get(0)?,
            input: HolidayInput {
                from_seq: r.get(1)?,
                months: r.get(2)?,
                kind: r.get(3)?,
            },
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn planned_early(conn: &Connection, debt_id: &str) -> Result<Vec<PlannedEarlyRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, amount, start_date, frequency, end_date, mode FROM debt_planned_early
         WHERE debt_id = ?1 ORDER BY start_date, created_at, rowid",
    )?;
    let rows = stmt.query_map([debt_id], |r| {
        Ok(PlannedEarlyRow {
            id: r.get(0)?,
            input: PlannedEarlyInput {
                amount: r.get(1)?,
                start_date: r.get(2)?,
                frequency: r.get(3)?,
                end_date: r.get(4)?,
                mode: r.get(5)?,
            },
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn insert_rate_change(conn: &Connection, debt_id: &str, r: &RateChangeInput) -> Result<String> {
    let rc = r.parse()?;
    let id = ids::new_id();
    // Та же дата — ставка заменяется.
    conn.execute(
        "INSERT INTO debt_rate_changes (id, debt_id, from_date, rate_bp, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (debt_id, from_date) DO UPDATE SET rate_bp = excluded.rate_bp",
        params![id, debt_id, rc.from.to_string(), rc.rate_bp, time::now_utc()],
    )?;
    Ok(conn.query_row(
        "SELECT id FROM debt_rate_changes WHERE debt_id = ?1 AND from_date = ?2",
        params![debt_id, rc.from.to_string()],
        |r| r.get(0),
    )?)
}

fn insert_planned(conn: &Connection, debt_id: &str, list: &[PlannedEarlyInput]) -> Result<()> {
    for p in list {
        let (start, freq, end, mode) = p.check()?;
        conn.execute(
            "INSERT INTO debt_planned_early (id, debt_id, amount, start_date, frequency, end_date, mode, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                ids::new_id(),
                debt_id,
                p.amount,
                start.to_string(),
                freq.as_str(),
                end.map(|e| e.to_string()),
                mode.as_str(),
                time::now_utc()
            ],
        )?;
    }
    Ok(())
}

fn ru_date(d: &str) -> String {
    crate::loan_export::ru_date(d)
}

fn rate_text(bp: i64) -> String {
    crate::loan_export::rate_text(bp)
}

/// Сумма для людей: «50 000 ₽».
fn money(conn: &Connection, t: &Terms, v: i64) -> Result<String> {
    let c = currencies::get(conn, &t.currency_code)?;
    Ok(format!(
        "{} {}",
        format_amount(v, c.minor_units, true),
        c.symbol
    ))
}

fn payment_reason(
    conn: &Connection,
    t: &Terms,
    input: &PaymentInput,
    mode: &str,
) -> Result<String> {
    let total = money(conn, t, input.principal + input.interest)?;
    let date = ru_date(&input.date);
    Ok(if input.schedule_id.is_some() {
        format!("Платёж {total} {date} по графику")
    } else if t.repayment == Repayment::Bullet {
        format!("Возврат {total} {date}")
    } else {
        let how = if mode == "reduce_term" {
            "уменьшен срок"
        } else {
            "уменьшен платёж"
        };
        format!("Досрочно {total} {date}, {how}")
    })
}

/// Строка снимка графика.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionRow {
    #[serde(flatten)]
    pub row: Row,
    pub status: String,
}

/// Снимок графика: до изменения (из истории) или текущий.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    /// Пусто у текущего графика.
    pub id: Option<String>,
    pub created_at: String,
    pub reason: String,
    pub payment: i64,
    pub total_interest: i64,
    pub total_payment: i64,
    pub maturity_date: String,
    pub rows: Vec<VersionRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    /// Снимки от старых к новым; каждый — график до изменения из `reason`.
    pub versions: Vec<Version>,
    pub current: Version,
    /// Экономия: проценты в первом снимке − (уплачено + осталось по графику).
    pub savings: i64,
}

/// Текущий график из базы как снимок.
fn current_version(conn: &Connection, debt_id: &str) -> Result<Version> {
    let (maturity, created_at): (String, String) = conn.query_row(
        "SELECT maturity_date, updated_at FROM debts WHERE id = ?1",
        [debt_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let schedule = schedule_rows(conn, debt_id, "")?;
    let (principal_paid, interest_paid): (i64, i64) = conn.query_row(
        "SELECT COALESCE(sum(principal_amount), 0), COALESCE(sum(interest_amount), 0) FROM debt_payments WHERE debt_id = ?1",
        [debt_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let pending = || schedule.iter().filter(|r| r.status == "pending");
    let interest_left: i64 = pending().map(|r| r.interest_part).sum();
    let payments_left: i64 = pending().map(|r| r.payment).sum();
    Ok(Version {
        id: None,
        created_at,
        reason: "Сейчас".into(),
        payment: pending().next().map_or(0, |r| r.payment),
        total_interest: interest_paid + interest_left,
        total_payment: principal_paid + interest_paid + payments_left,
        maturity_date: maturity,
        rows: schedule
            .into_iter()
            .map(|r| VersionRow {
                row: Row {
                    seq: r.seq,
                    due_date: r.due_date,
                    payment: r.payment,
                    principal_part: r.principal_part,
                    interest_part: r.interest_part,
                    balance_after: r.balance_after,
                },
                status: r.status,
            })
            .collect(),
    })
}

/// Записать снимок графика (до изменения) с причиной.
fn snapshot(conn: &Connection, debt_id: &str, reason: &str) -> Result<()> {
    let v = current_version(conn, debt_id)?;
    let json = serde_json::to_string(&v.rows)
        .map_err(|e| Error::Validation(format!("снимок графика: {e}")))?;
    conn.execute(
        "INSERT INTO debt_versions (id, debt_id, created_at, reason, payment, total_interest, total_payment,
                                    maturity_date, rows_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            ids::new_id(),
            debt_id,
            time::now_utc(),
            reason,
            v.payment,
            v.total_interest,
            v.total_payment,
            v.maturity_date,
            json
        ],
    )?;
    Ok(())
}

/// История графика: снимки и текущий график для сравнения «было → стало».
pub fn versions(conn: &Connection, debt_id: &str) -> Result<Versions> {
    terms(conn, debt_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, created_at, reason, payment, total_interest, total_payment, maturity_date, rows_json
         FROM debt_versions WHERE debt_id = ?1 ORDER BY created_at, rowid",
    )?;
    let raw: Vec<(Version, String)> = stmt
        .query_map([debt_id], |r| {
            Ok((
                Version {
                    id: r.get(0)?,
                    created_at: r.get(1)?,
                    reason: r.get(2)?,
                    payment: r.get(3)?,
                    total_interest: r.get(4)?,
                    total_payment: r.get(5)?,
                    maturity_date: r.get(6)?,
                    rows: Vec::new(),
                },
                r.get(7)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let versions: Vec<Version> = raw
        .into_iter()
        .map(|(mut v, json)| {
            v.rows = serde_json::from_str(&json).unwrap_or_default();
            v
        })
        .collect();
    let current = current_version(conn, debt_id)?;
    let savings = versions
        .first()
        .map_or(0, |f| f.total_interest - current.total_interest);
    Ok(Versions {
        versions,
        current,
        savings,
    })
}

/// Новые условия займа.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermsInput {
    pub principal: i64,
    pub issue_date: String,
    pub rate_bp: i64,
    pub repayment_type: String,
    pub term_months: Option<u32>,
    pub first_payment_date: Option<String>,
    pub maturity_date: Option<String>,
    /// `daily` или `monthly`.
    pub interest_method: String,
}

/// Изменить условия займа: сумму, дату выдачи, ставку, срок, первый платёж, тип
/// и метод процентов. Операция выдачи со счёта меняется вместе с ними.
pub fn update_terms(conn: &mut Connection, debt_id: &str, input: &TermsInput) -> Result<()> {
    let t = terms(conn, debt_id)?;
    let repayment = Repayment::parse(&input.repayment_type)?;
    let method = InterestMethod::parse(&input.interest_method)?;
    let bullet = repayment == Repayment::Bullet;
    let loan = LoanInput {
        principal: input.principal,
        rate_bp: input.rate_bp,
        repayment,
        term_months: if bullet { None } else { input.term_months },
        issue_date: input.issue_date.clone(),
        first_payment_date: if bullet {
            None
        } else {
            clean(&input.first_payment_date)
        },
        maturity_date: clean(&input.maturity_date),
        interest_method: method,
    };
    let schedule = loan_calc::calculate(&loan)?;
    let (principal_paid, first_paid): (i64, Option<String>) = conn.query_row(
        "SELECT COALESCE(sum(principal_amount), 0), min(date) FROM debt_payments WHERE debt_id = ?1",
        [debt_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if input.principal < principal_paid {
        return invalid(format!(
            "сумма меньше уже возвращённого ({})",
            money(conn, &t, principal_paid)?
        ));
    }
    if first_paid
        .as_deref()
        .is_some_and(|d| d < input.issue_date.as_str())
    {
        return invalid("дата выдачи позже первого платежа");
    }
    if bullet && !holidays(conn, debt_id)?.is_empty() {
        return invalid("у разового возврата нет каникул: сначала удалите их");
    }
    let first_payment = if bullet {
        None
    } else {
        schedule.rows.first().map(|r| r.due_date.clone())
    };

    // Что изменилось — для истории.
    let mut parts = Vec::new();
    if input.principal != t.principal {
        parts.push(format!(
            "сумма {} → {}",
            money(conn, &t, t.principal)?,
            money(conn, &t, input.principal)?
        ));
    }
    if input.rate_bp != t.rate_bp {
        parts.push(format!(
            "ставка {} → {}",
            rate_text(t.rate_bp).trim_end_matches(" %"),
            rate_text(input.rate_bp)
        ));
    }
    if loan.term_months != t.term_months {
        let m = |v: Option<u32>| v.map_or("—".to_string(), |v| v.to_string());
        parts.push(format!(
            "срок {} → {} мес.",
            m(t.term_months),
            m(loan.term_months)
        ));
    }
    if input.issue_date != t.issue_date {
        parts.push(format!(
            "выдача {} → {}",
            ru_date(&t.issue_date),
            ru_date(&input.issue_date)
        ));
    }
    if first_payment != t.first_payment_date {
        let d = |v: &Option<String>| v.as_deref().map_or("—".to_string(), ru_date);
        parts.push(format!(
            "первый платёж {} → {}",
            d(&t.first_payment_date),
            d(&first_payment)
        ));
    }
    if repayment != t.repayment {
        parts.push(format!(
            "тип {} → {}",
            t.repayment.title(),
            repayment.title()
        ));
    }
    if method != t.method {
        parts.push(format!(
            "проценты {} → {}",
            t.method.title(),
            method.title()
        ));
    }
    if bullet && t.repayment == Repayment::Bullet && schedule.maturity_date != t.maturity_date {
        parts.push(format!(
            "возврат {} → {}",
            ru_date(&t.maturity_date),
            ru_date(&schedule.maturity_date)
        ));
    }
    if parts.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    snapshot(
        &tx,
        debt_id,
        &format!("Изменены условия: {}", parts.join(", ")),
    )?;
    let now = time::now_utc();
    tx.execute(
        "UPDATE debts SET principal = ?2, issue_date = ?3, rate_bp = ?4, repayment_type = ?5, frequency = ?6,
                term_months = ?7, first_payment_date = ?8, maturity_date = ?9, interest_method = ?10, updated_at = ?11
         WHERE id = ?1",
        params![
            debt_id,
            input.principal,
            input.issue_date,
            input.rate_bp,
            repayment.as_str(),
            if bullet { "once" } else { "monthly" },
            loan.term_months,
            first_payment,
            schedule.maturity_date,
            method.as_str(),
            now
        ],
    )?;
    // Выдача со счёта — перевод без платежа; без счёта — начальный остаток служебного счёта.
    let issue_txn: Option<String> = tx
        .query_row(
            "SELECT id FROM transactions
             WHERE debt_id = ?1 AND type = 'transfer'
               AND id NOT IN (SELECT principal_transaction_id FROM debt_payments
                              WHERE debt_id = ?1 AND principal_transaction_id IS NOT NULL)
             ORDER BY date, created_at, rowid LIMIT 1",
            [debt_id],
            |r| r.get(0),
        )
        .optional()?;
    match issue_txn {
        Some(txn) => {
            tx.execute(
                "UPDATE transactions SET amount = ?2, to_amount = ?2, date = ?3, updated_at = ?4 WHERE id = ?1",
                params![txn, input.principal, input.issue_date, now],
            )?;
        }
        None => {
            let sign = if t.direction == "lent" { 1 } else { -1 };
            tx.execute(
                "UPDATE accounts SET opening_balance = ?2, opening_date = ?3, updated_at = ?4 WHERE id = ?1",
                params![t.account_id, sign * input.principal, input.issue_date, now],
            )?;
        }
    }
    rebuild(&tx, debt_id)?;
    tx.commit()?;
    Ok(())
}

/// Новая ставка с даты.
pub fn add_rate_change(
    conn: &mut Connection,
    debt_id: &str,
    input: &RateChangeInput,
) -> Result<String> {
    let t = terms(conn, debt_id)?;
    let rc = input.parse()?;
    if rc.from.to_string() < t.issue_date {
        return invalid("ставка меняется раньше даты выдачи");
    }
    let tx = conn.transaction()?;
    snapshot(
        &tx,
        debt_id,
        &format!(
            "Ставка {} с {}",
            rate_text(rc.rate_bp),
            ru_date(&rc.from.to_string())
        ),
    )?;
    let id = insert_rate_change(&tx, debt_id, input)?;
    rebuild(&tx, debt_id)?;
    tx.commit()?;
    Ok(id)
}

pub fn delete_rate_change(conn: &mut Connection, rate_change_id: &str) -> Result<()> {
    let (debt_id, from): (String, String) = conn
        .query_row(
            "SELECT debt_id, from_date FROM debt_rate_changes WHERE id = ?1",
            [rate_change_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or(Error::NotFound("изменение ставки"))?;
    let tx = conn.transaction()?;
    snapshot(
        &tx,
        &debt_id,
        &format!("Отменено изменение ставки с {}", ru_date(&from)),
    )?;
    tx.execute(
        "DELETE FROM debt_rate_changes WHERE id = ?1",
        [rate_change_id],
    )?;
    rebuild(&tx, &debt_id)?;
    tx.commit()?;
    Ok(())
}

/// Кредитные каникулы с платежа `from_seq`.
pub fn add_holiday(conn: &mut Connection, debt_id: &str, input: &HolidayInput) -> Result<String> {
    let t = terms(conn, debt_id)?;
    let h = input.parse()?;
    if t.repayment == Repayment::Bullet {
        return invalid("каникулы бывают только у ежемесячных платежей");
    }
    if t.status == "closed" {
        return invalid("долг уже погашен");
    }
    let (last_paid, last_seq): (Option<u32>, Option<u32>) = conn.query_row(
        "SELECT max(CASE WHEN status <> 'pending' THEN seq END), max(seq) FROM debt_schedule WHERE debt_id = ?1",
        [debt_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if h.from_seq <= last_paid.unwrap_or(0) {
        return invalid("каникулы можно взять только на неоплаченные платежи");
    }
    if h.from_seq > last_seq.unwrap_or(0) {
        return invalid("в графике нет платежа с таким номером");
    }
    let taken: i64 = conn.query_row(
        "SELECT count(*) FROM debt_holidays WHERE debt_id = ?1 AND from_seq = ?2",
        params![debt_id, h.from_seq],
        |r| r.get(0),
    )?;
    if taken > 0 {
        return invalid("с этого платежа каникулы уже есть");
    }
    let tx = conn.transaction()?;
    let kind = match h.kind {
        loan_calc::HolidayKind::InterestOnly => "только проценты",
        loan_calc::HolidayKind::Shift => "сдвиг платежей",
    };
    snapshot(
        &tx,
        debt_id,
        &format!(
            "Каникулы {} мес. с платежа №{}, {kind}",
            h.months, h.from_seq
        ),
    )?;
    let id = ids::new_id();
    tx.execute(
        "INSERT INTO debt_holidays (id, debt_id, from_seq, months, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, debt_id, h.from_seq, h.months, h.kind.as_str(), time::now_utc()],
    )?;
    rebuild(&tx, debt_id)?;
    tx.commit()?;
    Ok(id)
}

pub fn delete_holiday(conn: &mut Connection, holiday_id: &str) -> Result<()> {
    let (debt_id, from_seq): (String, u32) = conn
        .query_row(
            "SELECT debt_id, from_seq FROM debt_holidays WHERE id = ?1",
            [holiday_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or(Error::NotFound("каникулы"))?;
    let tx = conn.transaction()?;
    snapshot(
        &tx,
        &debt_id,
        &format!("Отменены каникулы с платежа №{from_seq}"),
    )?;
    tx.execute("DELETE FROM debt_holidays WHERE id = ?1", [holiday_id])?;
    rebuild(&tx, &debt_id)?;
    tx.commit()?;
    Ok(())
}

/// Заменить список плановых досрочек (они идут только в прогноз).
pub fn set_planned_early(
    conn: &mut Connection,
    debt_id: &str,
    list: &[PlannedEarlyInput],
) -> Result<()> {
    terms(conn, debt_id)?;
    for p in list {
        p.check()?;
    }
    let tx = conn.transaction()?;
    let reason = if list.is_empty() {
        "Плановые досрочки убраны".to_string()
    } else {
        format!("Плановые досрочки: {}", list.len())
    };
    snapshot(&tx, debt_id, &reason)?;
    tx.execute(
        "DELETE FROM debt_planned_early WHERE debt_id = ?1",
        [debt_id],
    )?;
    insert_planned(&tx, debt_id, list)?;
    tx.commit()?;
    Ok(())
}

/// Расчёт платежа без записи.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInput {
    pub date: String,
    pub amount: i64,
    /// `scheduled` — в счёт ближайшего платежа, `early` — досрочно.
    pub kind: String,
    /// Для досрочки: `reduce_payment` (по умолчанию) или `reduce_term`.
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// Подсказка разбивки: проценты и основной долг.
    pub interest: i64,
    pub principal: i64,
    pub before: SimView,
    pub after: SimView,
    /// Новый ближайший платёж (0 — долг закрыт).
    pub new_payment: i64,
    /// Экономия на процентах: было − стало.
    pub savings: i64,
}

/// Разбивка платежа и графики «до» и «после» без записи.
pub fn quote_payment(conn: &Connection, debt_id: &str, input: &QuoteInput) -> Result<Quote> {
    let t = terms(conn, debt_id)?;
    if t.status == "closed" {
        return invalid("долг уже погашен");
    }
    let date = loan_calc::parse_date(&input.date)?;
    if input.date < t.issue_date {
        return invalid("платёж раньше даты выдачи долга");
    }
    if input.amount <= 0 {
        return invalid("введите сумму платежа");
    }
    let mode = Recalc::parse(input.mode.as_deref().unwrap_or("reduce_payment"))?;
    let engine = t.engine()?;
    let mut events = events(conn, debt_id)?;
    let before = loan_calc::simulate(&engine, &events);
    let left = before.outstanding;
    let (interest, principal, seq) = match input.kind.as_str() {
        "scheduled" => {
            let next = before
                .rows
                .iter()
                .find(|r| r.status == loan_calc::Status::Pending)
                .ok_or_else(|| Error::Validation("в графике нет неоплаченных платежей".into()))?;
            let interest = next.row.interest_part.min(input.amount);
            let principal = (input.amount - interest).min(left);
            (interest, principal, Some(next.row.seq))
        }
        "early" => {
            let (i, p) = loan_calc::split_early(&engine, &events, date, input.amount);
            (i, p, None)
        }
        k => return invalid(format!("неизвестный вид платежа: {k}")),
    };
    events.push(Event::Payment(loan_calc::Payment {
        date,
        principal,
        interest,
        seq,
        mode,
    }));
    let after: SimView = loan_calc::simulate(&engine, &events).into();
    let before: SimView = before.into();
    Ok(Quote {
        interest,
        principal,
        new_payment: after.totals.payment,
        savings: before.totals.total_interest - after.totals.total_interest,
        before,
        after,
    })
}

/// Прогноз: график с плановыми досрочками начиная с `max(today, дата последнего платежа)`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub from: String,
    pub rows: Vec<loan_calc::SimRow>,
    pub early: Vec<loan_calc::EarlyRow>,
    pub totals: Totals,
    /// Итоги без плановых досрочек (как в графике).
    pub base: Totals,
    /// Экономия на процентах от плановых досрочек.
    pub savings: i64,
}

fn forecast_sim(conn: &Connection, t: &Terms, today: &str) -> Result<(String, Sim, Sim)> {
    let engine = t.engine()?;
    let mut events = events(conn, &t.id)?;
    let base = loan_calc::simulate(&engine, &events);
    let last: Option<String> = conn.query_row(
        "SELECT max(date) FROM debt_payments WHERE debt_id = ?1",
        [&t.id],
        |r| r.get(0),
    )?;
    let from = last
        .filter(|l| l.as_str() > today)
        .unwrap_or_else(|| today.to_string());
    let from_date = loan_calc::parse_date(&from)?;
    let until = base
        .rows
        .last()
        .map(|r| loan_calc::parse_date(&r.row.due_date))
        .transpose()?
        .unwrap_or(from_date);
    let list: Vec<PlannedEarlyInput> = planned_early(conn, &t.id)?
        .into_iter()
        .map(|p| p.input)
        .collect();
    events.extend(loan_calc::expand_planned(&list, from_date, until)?);
    let with = loan_calc::simulate(&engine, &events);
    Ok((from, base, with))
}

pub fn forecast(conn: &Connection, debt_id: &str, today: &str) -> Result<Forecast> {
    let t = terms(conn, debt_id)?;
    let (from, base, with) = forecast_sim(conn, &t, today)?;
    let base = base.totals();
    let totals = with.totals();
    Ok(Forecast {
        from,
        savings: base.total_interest - totals.total_interest,
        rows: with.rows,
        early: with.early,
        totals,
        base,
    })
}

/// Документ графика займа для Excel и PDF; с прогнозом — с плановыми досрочками.
pub fn schedule_doc(
    conn: &Connection,
    debt_id: &str,
    today: &str,
    with_forecast: bool,
) -> Result<crate::loan_export::ScheduleDoc> {
    use crate::loan_export::{doc_rows, doc_totals, my_name, DocTerms, ScheduleDoc};
    let t = terms(conn, debt_id)?;
    let sim = if with_forecast {
        forecast_sim(conn, &t, today)?.2
    } else {
        simulate_debt(conn, &t)?
    };
    let cur = currencies::get(conn, &t.currency_code)?;
    let me = my_name(conn)?;
    let (lender_name, borrower_name) = if t.direction == "lent" {
        (me, t.counterparty.clone())
    } else {
        (t.counterparty.clone(), me)
    };
    Ok(ScheduleDoc {
        title: format!("График платежей: {}", t.counterparty),
        lender_name,
        borrower_name,
        terms: DocTerms {
            principal: t.principal,
            currency_code: cur.code,
            currency_symbol: cur.symbol,
            minor_units: cur.minor_units,
            rate_bp: t.rate_bp,
            rate_changes: rate_changes(conn, debt_id)?
                .into_iter()
                .map(|r| r.input)
                .collect(),
            holidays: holidays(conn, debt_id)?
                .into_iter()
                .map(|h| h.input)
                .collect(),
            term_months: t.term_months,
            repayment_type: t.repayment.as_str().into(),
            interest_method: t.method.as_str().into(),
            issue_date: t.issue_date.clone(),
            first_payment_date: t.first_payment_date.clone(),
        },
        rows: doc_rows(&sim),
        totals: doc_totals(&sim.totals()),
        with_signatures: true,
        created_on: today.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;
    use crate::{reports, settings, transactions};

    struct Fx {
        db: Storage,
        card: String,
    }

    impl Fx {
        fn new() -> Self {
            let db = Storage::open_in_memory().unwrap();
            categories::seed_defaults(db.conn()).unwrap();
            let mut acc = input("Карта", "debit", "RUB", 5_000_000);
            acc.opening_date = "2026-01-01".into();
            let card = accounts::create(db.conn(), &acc).unwrap();
            Fx { db, card }
        }
        fn c(&mut self) -> &mut Connection {
            self.db.conn_mut()
        }
        fn credit(&mut self) -> String {
            let card = self.card.clone();
            create(
                self.c(),
                &loan(
                    "borrowed",
                    "Банк",
                    30_000_000,
                    1800,
                    "annuity",
                    Some(24),
                    None,
                    Some(card),
                ),
            )
            .unwrap()
        }
        fn balance(&self, acc: &str) -> i64 {
            accounts::balance(self.db.conn(), acc, None).unwrap()
        }
        fn detail(&self, id: &str) -> DebtDetail {
            get(self.db.conn(), id, "2026-10-20").unwrap()
        }
        fn pay(
            &mut self,
            id: &str,
            date: &str,
            principal: i64,
            interest: i64,
            scheduled: bool,
            mode: Option<&str>,
        ) -> Result<String> {
            let schedule_id = scheduled.then(|| self.detail(id).card.next_payment.unwrap().id);
            let card = self.card.clone();
            pay(
                self.c(),
                id,
                &PaymentInput {
                    date: date.into(),
                    account_id: card,
                    principal,
                    interest,
                    schedule_id,
                    recalc_mode: mode.map(str::to_string),
                },
            )
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn loan(
        direction: &str,
        who: &str,
        principal: i64,
        rate_bp: i64,
        kind: &str,
        term: Option<u32>,
        maturity: Option<&str>,
        account: Option<String>,
    ) -> DebtInput {
        DebtInput {
            direction: direction.into(),
            counterparty: who.into(),
            note: None,
            currency_code: "RUB".into(),
            principal,
            issue_date: "2026-10-15".into(),
            rate_bp,
            repayment_type: kind.into(),
            term_months: term,
            first_payment_date: None,
            maturity_date: maturity.map(str::to_string),
            account_id: account,
            // Прежние тесты — контракт метода «по месяцам».
            interest_method: Some("monthly".into()),
            rate_changes: vec![],
            planned_early: vec![],
        }
    }

    #[test]
    fn bank_credit_monthly_payment() {
        // «Кредит в банке»: 300 000 ₽ под 18 % на 24 месяца, каждый месяц «Оплачено».
        let mut f = Fx::new();
        let id = f.credit();
        let d = f.detail(&id);
        assert_eq!(
            f.balance(&f.card),
            5_000_000 + 30_000_000,
            "кредит пришёл на карту"
        );
        assert_eq!(
            f.balance(&d.card.account_id),
            -30_000_000,
            "служебный счёт: я должен"
        );
        assert_eq!(d.schedule.len(), 24);
        let next = d.card.next_payment.clone().unwrap();
        assert_eq!(
            (next.payment, next.principal_part, next.interest_part),
            (1_497_723, 1_047_723, 450_000)
        );
        assert_eq!(
            d.card.interest_planned,
            d.schedule.iter().map(|r| r.interest_part).sum::<i64>()
        );

        f.pay(&id, "2026-11-15", 1_047_723, 450_000, true, None)
            .unwrap();
        let d = f.detail(&id);
        assert_eq!(f.balance(&f.card), 35_000_000 - 1_497_723);
        assert_eq!(d.card.outstanding, 30_000_000 - 1_047_723);
        assert_eq!(f.balance(&d.card.account_id), -d.card.outstanding);
        assert_eq!(d.schedule[0].status, "paid");
        assert_eq!(
            d.schedule[1].payment, 1_497_723,
            "остальной график не изменился"
        );
        assert_eq!(d.card.interest_paid, 450_000);
        assert_eq!(d.payments.len(), 1);
        assert_eq!(d.payments[0].account_name.as_deref(), Some("Карта"));
        assert_eq!(
            d.card.default_account_id.as_deref(),
            Some(f.card.as_str()),
            "следующий платёж с того же счёта"
        );
        // Проценты — расход, основной долг — перевод, в расходы не входит.
        let s = reports::period_summary(f.db.conn(), "2026-11-01", "2026-11-30").unwrap();
        assert_eq!(s.expense, 450_000);
        let cats =
            reports::by_category(f.db.conn(), "expense", "2026-11-01", "2026-11-30").unwrap();
        assert_eq!(cats.items[0].name, "Проценты по кредитам");
        // Операции долга нельзя править в общем списке.
        let txn =
            f.db.conn()
                .query_row(
                    "SELECT id FROM transactions WHERE debt_id = ?1 LIMIT 1",
                    [&id],
                    |r| r.get::<_, String>(0),
                )
                .unwrap();
        assert!(transactions::delete(f.db.conn(), &txn).is_err());
    }

    #[test]
    fn early_payment_reduce_payment_or_term() {
        let mut f = Fx::new();
        let a = f.credit();
        let b = f.credit();
        for id in [&a, &b] {
            f.pay(id, "2026-11-15", 1_047_723, 450_000, true, None)
                .unwrap();
        }
        let left = 30_000_000 - 1_047_723;
        // Досрочно 100 000 ₽ в основной долг.
        f.pay(
            &a,
            "2026-11-20",
            10_000_000,
            0,
            false,
            Some("reduce_payment"),
        )
        .unwrap();
        f.pay(&b, "2026-11-20", 10_000_000, 0, false, Some("reduce_term"))
            .unwrap();

        let da = f.detail(&a);
        assert_eq!(da.card.outstanding, left - 10_000_000);
        assert_eq!(da.schedule.len(), 24, "срок прежний");
        assert_eq!(da.card.maturity_date, "2028-10-15");
        let pa = da.card.next_payment.unwrap().payment;
        assert!(pa < 1_497_723, "платёж уменьшился: {pa}");
        assert_eq!(pa, loan_calc::annuity_payment(left - 10_000_000, 1800, 23));
        assert_eq!(da.schedule.last().unwrap().balance_after, 0);

        let db = f.detail(&b);
        assert_eq!(
            db.card.next_payment.unwrap().payment,
            1_497_723,
            "платёж прежний"
        );
        assert!(
            db.schedule.len() < 24,
            "срок сократился: {}",
            db.schedule.len()
        );
        assert!(db.card.maturity_date.as_str() < "2028-10-15");
        assert_eq!(
            db.schedule.iter().map(|r| r.principal_part).sum::<i64>(),
            30_000_000 - 10_000_000
        );
        assert!(
            db.card.interest_planned < da.card.interest_planned,
            "сокращение срока выгоднее"
        );
    }

    #[test]
    fn friend_partial_return_then_full() {
        // «Занял другу»: Ивану 20 000 ₽ без процентов до 1 марта, он вернул 5 000.
        let mut f = Fx::new();
        let card = f.card.clone();
        let id = create(
            f.c(),
            &loan(
                "lent",
                "Иван",
                2_000_000,
                0,
                "bullet",
                None,
                Some("2027-03-01"),
                Some(card),
            ),
        )
        .unwrap();
        assert_eq!(f.balance(&f.card), 3_000_000);
        f.pay(&id, "2026-12-01", 500_000, 0, false, None).unwrap();
        let d = f.detail(&id);
        assert_eq!(d.card.outstanding, 1_500_000);
        assert_eq!(d.schedule.len(), 1);
        assert_eq!(
            (d.schedule[0].principal_part, d.schedule[0].status.as_str()),
            (1_500_000, "pending")
        );
        assert_eq!(f.balance(&f.card), 3_500_000);
        assert_eq!(f.balance(&d.card.account_id), 1_500_000, "мне должны");

        let last = f.pay(&id, "2027-02-20", 1_500_000, 0, true, None).unwrap();
        let d = f.detail(&id);
        assert_eq!((d.card.status.as_str(), d.card.outstanding), ("closed", 0));
        assert_eq!(d.schedule[0].status, "paid");
        assert!(
            f.pay(&id, "2027-02-21", 1, 0, false, None).is_err(),
            "погашенный долг"
        );

        // Удаление последнего платежа возвращает долг.
        delete_payment(f.c(), &last).unwrap();
        let d = f.detail(&id);
        assert_eq!(
            (d.card.status.as_str(), d.card.outstanding),
            ("active", 1_500_000)
        );
        assert_eq!(f.balance(&f.card), 3_500_000);
    }

    #[test]
    fn short_scheduled_payment_moves_the_rest() {
        let mut f = Fx::new();
        let card = f.card.clone();
        let id = create(
            f.c(),
            &loan(
                "borrowed",
                "Пётр",
                3_000_000,
                0,
                "annuity",
                Some(3),
                None,
                Some(card),
            ),
        )
        .unwrap();
        f.pay(&id, "2026-11-15", 500_000, 0, true, None).unwrap();
        let d = f.detail(&id);
        assert_eq!(d.schedule[0].status, "partial");
        assert_eq!(d.schedule.len(), 3);
        assert_eq!(d.schedule[1].payment + d.schedule[2].payment, 2_500_000);
        // Последний платёж меньше графика: остаток уходит на следующий месяц.
        f.pay(&id, "2026-12-15", 1_250_000, 0, true, None).unwrap();
        f.pay(&id, "2027-01-15", 1_000_000, 0, true, None).unwrap();
        let d = f.detail(&id);
        assert_eq!(d.schedule.len(), 4);
        assert_eq!(
            (d.schedule[3].due_date.as_str(), d.schedule[3].payment),
            ("2027-02-15", 250_000)
        );
    }

    #[test]
    fn payment_validation() {
        let mut f = Fx::new();
        let id = f.credit();
        assert!(
            f.pay(&id, "2026-11-15", 30_000_001, 0, false, None)
                .is_err(),
            "больше остатка"
        );
        assert!(
            f.pay(&id, "2026-10-01", 100, 0, false, None).is_err(),
            "раньше выдачи"
        );
        assert!(
            f.pay(&id, "2026-11-15", 0, 0, false, None).is_err(),
            "пустой платёж"
        );
        assert!(f
            .pay(&id, "2026-11-15", 100, 0, false, Some("other"))
            .is_err());
        let second = f.detail(&id).schedule[1].id.clone();
        let card = f.card.clone();
        let wrong_row = PaymentInput {
            date: "2026-11-15".into(),
            account_id: card,
            principal: 100,
            interest: 0,
            schedule_id: Some(second),
            recalc_mode: None,
        };
        assert!(
            pay(f.c(), &id, &wrong_row).is_err(),
            "только ближайший платёж"
        );
        let usd = accounts::create(f.db.conn(), &input("USD", "cash", "USD", 0)).unwrap();
        let other_currency = PaymentInput {
            account_id: usd,
            schedule_id: None,
            ..wrong_row
        };
        assert!(
            pay(f.c(), &id, &other_currency).is_err(),
            "счёт в другой валюте"
        );
        assert!(create(
            f.c(),
            &loan("gift", "X", 100, 0, "annuity", Some(1), None, None)
        )
        .is_err());
        assert!(create(
            f.c(),
            &loan("lent", " ", 100, 0, "annuity", Some(1), None, None)
        )
        .is_err());
    }

    #[test]
    fn summary_and_net_worth() {
        // «Сколько мне должны»: должны мне 35 000, должен я 245 000.
        let mut f = Fx::new();
        create(
            f.c(),
            &loan(
                "lent",
                "Иван",
                2_000_000,
                0,
                "bullet",
                None,
                Some("2027-03-01"),
                None,
            ),
        )
        .unwrap();
        create(
            f.c(),
            &loan(
                "lent",
                "Оля",
                1_500_000,
                0,
                "bullet",
                None,
                Some("2026-12-01"),
                None,
            ),
        )
        .unwrap();
        let mut credit = loan(
            "borrowed",
            "Банк",
            24_500_000,
            1800,
            "annuity",
            Some(24),
            None,
            None,
        );
        credit.first_payment_date = Some("2026-11-15".into());
        create(f.c(), &credit).unwrap();
        assert_eq!(
            f.balance(&f.card),
            5_000_000,
            "долги без счёта оплаты не трогают карту"
        );

        let s = summary(f.db.conn(), "2026-10-20", 5).unwrap();
        assert_eq!((s.owed_to_me, s.i_owe), (3_500_000, 24_500_000));
        assert_eq!(s.net_worth, 5_000_000 + 3_500_000 - 24_500_000);
        assert_eq!(s.upcoming[0].due_date, "2026-11-15");
        assert_eq!(s.upcoming[0].counterparty, "Банк");
        assert_eq!(s.upcoming.len(), 3);
        // Просрочка считается при чтении.
        let late = summary(f.db.conn(), "2026-11-20", 5).unwrap();
        assert!(late.upcoming[0].overdue);
        let list = list(f.db.conn(), "2026-11-20").unwrap();
        let bank = list.iter().find(|d| d.counterparty == "Банк").unwrap();
        assert_eq!(bank.overdue_count, 1);
    }

    #[test]
    fn delete_debt_with_its_operations() {
        let mut f = Fx::new();
        let id = f.credit();
        f.pay(&id, "2026-11-15", 1_047_723, 450_000, true, None)
            .unwrap();
        let acc = f.detail(&id).card.account_id;
        delete(f.c(), &id).unwrap();
        assert_eq!(f.balance(&f.card), 5_000_000);
        let left: i64 = f
            .db
            .conn()
            .query_row("SELECT (SELECT count(*) FROM transactions) + (SELECT count(*) FROM debt_schedule) + (SELECT count(*) FROM accounts WHERE id = ?1)", [&acc], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn rename_keeps_service_account_in_sync() {
        let mut f = Fx::new();
        let id = f.credit();
        update_info(f.db.conn(), &id, "Сбербанк", Some("ипотека".into())).unwrap();
        let d = f.detail(&id);
        assert_eq!(
            (d.card.counterparty.as_str(), d.card.note.as_deref()),
            ("Сбербанк", Some("ипотека"))
        );
        assert_eq!(
            accounts::get(f.db.conn(), &d.card.account_id).unwrap().name,
            "Сбербанк"
        );
        assert!(
            accounts::list(f.db.conn(), true)
                .unwrap()
                .iter()
                .all(|a| a.kind != "debt"),
            "служебный счёт скрыт"
        );
    }

    /// Баланс служебного счёта всегда равен остатку основного долга (со знаком).
    fn assert_balance_matches(f: &Fx, id: &str) {
        let d = f.detail(id);
        let sign = if d.card.direction == "lent" { 1 } else { -1 };
        assert_eq!(
            f.balance(&d.card.account_id),
            sign * d.card.outstanding,
            "служебный счёт = остаток"
        );
        let pending: i64 = d
            .schedule
            .iter()
            .filter(|r| r.status == "pending")
            .map(|r| r.principal_part)
            .sum();
        if d.card.repayment_type != "bullet" || d.card.outstanding > 0 {
            assert_eq!(pending, d.card.outstanding, "график покрывает остаток");
        }
    }

    fn terms_of(d: &DebtDetail) -> TermsInput {
        TermsInput {
            principal: d.card.principal,
            issue_date: d.card.issue_date.clone(),
            rate_bp: d.card.rate_bp,
            repayment_type: d.card.repayment_type.clone(),
            term_months: d.card.term_months,
            first_payment_date: d.card.first_payment_date.clone(),
            maturity_date: Some(d.card.maturity_date.clone()),
            interest_method: d.card.interest_method.clone(),
        }
    }

    #[test]
    fn new_debts_count_interest_by_days() {
        let mut f = Fx::new();
        let card = f.card.clone();
        let mut input = loan(
            "borrowed",
            "Банк",
            30_000_000,
            1200,
            "annuity",
            Some(24),
            None,
            Some(card),
        );
        input.interest_method = None;
        let id = create(f.c(), &input).unwrap();
        let d = f.detail(&id);
        assert_eq!(d.card.interest_method, "daily");
        // 300 000 × 12 % × 31 / 365 = 3 057,53 ₽.
        assert_eq!(d.schedule[0].interest_part, 305_753);
        assert_eq!(d.schedule.last().unwrap().balance_after, 0);
        let v = versions(f.db.conn(), &id).unwrap();
        assert_eq!(v.versions.len(), 1);
        assert_eq!(v.versions[0].reason, "Заём записан");
        assert_eq!(v.versions[0].rows.len(), 24);
        assert_eq!(v.savings, 0);
    }

    #[test]
    fn update_terms_moves_issue_and_keeps_balance() {
        let mut f = Fx::new();
        let id = f.credit();
        f.pay(&id, "2026-11-15", 1_047_723, 450_000, true, None)
            .unwrap();
        assert_balance_matches(&f, &id);
        let before_card = f.balance(&f.card);
        let mut t = terms_of(&f.detail(&id));
        // Меньше уже возвращённого нельзя.
        t.principal = 1_000_000;
        assert!(update_terms(f.c(), &id, &t).is_err());
        // Ставка 18 → 12 %, сумма 350 000, выдача на день раньше.
        t.principal = 35_000_000;
        t.rate_bp = 1200;
        t.issue_date = "2026-10-14".into();
        let mut journal = crate::undo::Journal::default();
        journal
            .record(f.c(), "Изменение условий", |c| {
                update_terms(c, &id, &t)
            })
            .unwrap();
        let d = f.detail(&id);
        assert_eq!((d.card.principal, d.card.rate_bp), (35_000_000, 1200));
        assert_eq!(d.card.outstanding, 35_000_000 - 1_047_723);
        assert_eq!(
            f.balance(&f.card),
            before_card + 5_000_000,
            "операция выдачи изменилась"
        );
        let issue_date: String =
            f.db.conn()
                .query_row(
                    "SELECT date FROM transactions WHERE debt_id = ?1 AND note = 'Получение долга'",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(issue_date, "2026-10-14");
        // Платёж прежний, а строка по новым условиям больше: отмечена частично.
        assert_eq!(
            d.schedule[0].status, "partial",
            "оплаченная строка на месте"
        );
        assert_balance_matches(&f, &id);
        let v = versions(f.db.conn(), &id).unwrap();
        assert_eq!(v.versions.len(), 3, "создание, платёж, условия");
        let plain = |s: &str| s.replace('\u{a0}', " ");
        assert!(
            plain(&v.versions[1].reason).starts_with("Платёж 14 977,23 ₽ 15.11.2026"),
            "{}",
            v.versions[1].reason
        );
        let reason = &plain(&v.versions[2].reason);
        assert!(reason.contains("ставка 18 → 12 %"), "{reason}");
        assert!(reason.contains("сумма 300 000 ₽ → 350 000 ₽"), "{reason}");
        // Отмена возвращает условия, операцию и снимки.
        journal.undo(f.db.conn()).unwrap();
        let d = f.detail(&id);
        assert_eq!((d.card.principal, d.card.rate_bp), (30_000_000, 1800));
        assert_eq!(f.balance(&f.card), before_card);
        assert_eq!(versions(f.db.conn(), &id).unwrap().versions.len(), 2);
        assert_balance_matches(&f, &id);
    }

    #[test]
    fn balance_matches_outstanding_without_account() {
        // Долг «как есть» (без счёта): начальный остаток служебного счёта.
        for direction in ["borrowed", "lent"] {
            let mut f = Fx::new();
            let id = create(
                f.c(),
                &loan(
                    direction,
                    "Сосед",
                    12_000_000,
                    1000,
                    "differentiated",
                    Some(12),
                    None,
                    None,
                ),
            )
            .unwrap();
            assert_balance_matches(&f, &id);
            let p = f
                .pay(
                    &id,
                    "2026-12-01",
                    3_000_000,
                    50_000,
                    false,
                    Some("reduce_term"),
                )
                .unwrap();
            assert_balance_matches(&f, &id);
            let mut t = terms_of(&f.detail(&id));
            t.principal = 15_000_000;
            t.issue_date = "2026-10-01".into();
            t.term_months = Some(18);
            t.interest_method = "daily".into();
            update_terms(f.c(), &id, &t).unwrap();
            assert_balance_matches(&f, &id);
            let opening: (i64, String) =
                f.db.conn()
                    .query_row(
                        "SELECT opening_balance, opening_date FROM accounts WHERE id = ?1",
                        [&f.detail(&id).card.account_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap();
            let sign = if direction == "lent" { 1 } else { -1 };
            assert_eq!(opening, (sign * 15_000_000, "2026-10-01".to_string()));
            delete_payment(f.c(), &p).unwrap();
            assert_balance_matches(&f, &id);
            assert_eq!(f.detail(&id).card.outstanding, 15_000_000);
        }
    }

    #[test]
    fn rate_change_holidays_planned_early_and_history() {
        let mut f = Fx::new();
        let card = f.card.clone();
        let mut input = loan(
            "borrowed",
            "Банк",
            30_000_000,
            1200,
            "annuity",
            Some(24),
            None,
            Some(card),
        );
        input.interest_method = Some("daily".into());
        let id = create(f.c(), &input).unwrap();
        let ids_before: Vec<String> = f
            .detail(&id)
            .schedule
            .iter()
            .map(|r| r.id.clone())
            .collect();
        let base = f.detail(&id).card.interest_planned;

        let rc = add_rate_change(
            f.c(),
            &id,
            &RateChangeInput {
                from: "2027-03-01".into(),
                rate_bp: 1000,
            },
        )
        .unwrap();
        let d = f.detail(&id);
        assert_eq!(d.schedule.len(), 24);
        assert!(d.card.interest_planned < base);
        assert_eq!(d.rate_changes.len(), 1);
        let ids_after: Vec<String> = d.schedule.iter().map(|r| r.id.clone()).collect();
        assert_eq!(ids_before, ids_after, "id строк не меняются");
        assert!(add_rate_change(
            f.c(),
            &id,
            &RateChangeInput {
                from: "2026-01-01".into(),
                rate_bp: 1
            }
        )
        .is_err());

        let h = add_holiday(
            f.c(),
            &id,
            &HolidayInput {
                from_seq: 3,
                months: 2,
                kind: "interest_only".into(),
            },
        )
        .unwrap();
        let d = f.detail(&id);
        assert_eq!(d.schedule.len(), 26);
        assert_eq!(d.schedule[2].principal_part, 0);
        assert_balance_matches(&f, &id);
        f.pay(
            &id,
            "2026-11-15",
            d.schedule[0].principal_part,
            d.schedule[0].interest_part,
            true,
            None,
        )
        .unwrap();
        assert!(
            add_holiday(
                f.c(),
                &id,
                &HolidayInput {
                    from_seq: 1,
                    months: 1,
                    kind: "shift".into()
                }
            )
            .is_err(),
            "на оплаченные платежи каникулы не берутся"
        );
        delete_holiday(f.c(), &h).unwrap();
        assert_eq!(f.detail(&id).schedule.len(), 24);
        delete_rate_change(f.c(), &rc).unwrap();

        set_planned_early(
            f.c(),
            &id,
            &[PlannedEarlyInput {
                amount: 1_000_000,
                start_date: "2027-01-01".into(),
                frequency: "monthly".into(),
                end_date: None,
                mode: "reduce_term".into(),
            }],
        )
        .unwrap();
        let d = f.detail(&id);
        assert_eq!(d.schedule.len(), 24, "плановые досрочки не в графике");
        assert_eq!(d.planned_early.len(), 1);
        let fc = forecast(f.db.conn(), &id, "2026-12-01").unwrap();
        assert_eq!(fc.from, "2026-12-01");
        assert!(fc.rows.len() < 24);
        assert!(fc.savings > 0);
        assert!(fc
            .early
            .iter()
            .all(|e| e.planned && e.date.as_str() >= "2027-01-01"));

        // «А что если»: расчёт без записи.
        let q = quote_payment(
            f.db.conn(),
            &id,
            &QuoteInput {
                date: "2026-12-01".into(),
                amount: 5_000_000,
                kind: "early".into(),
                mode: Some("reduce_term".into()),
            },
        )
        .unwrap();
        let left = f.detail(&id).card.outstanding;
        let accrued = (left as i128 * 1200 * 16 * 2 + 10_000 * 365) / (2 * 10_000 * 365);
        assert_eq!(q.interest as i128, accrued, "проценты за 16 дней с 15.11");
        assert_eq!(q.principal, 5_000_000 - q.interest);
        assert!(q.after.totals.rows_left < q.before.totals.rows_left);
        assert!(q.savings > 0);
        assert_eq!(f.detail(&id).payments.len(), 1, "ничего не записано");
        let q = quote_payment(
            f.db.conn(),
            &id,
            &QuoteInput {
                date: "2026-12-10".into(),
                amount: 2_000_000,
                kind: "scheduled".into(),
                mode: None,
            },
        )
        .unwrap();
        assert_eq!(
            q.interest,
            f.detail(&id).card.next_payment.unwrap().interest_part
        );

        let card = f.card.clone();
        pay(
            f.c(),
            &id,
            &PaymentInput {
                date: "2026-12-01".into(),
                account_id: card,
                principal: 5_000_000 - accrued as i64,
                interest: accrued as i64,
                schedule_id: None,
                recalc_mode: Some("reduce_term".into()),
            },
        )
        .unwrap();
        assert_balance_matches(&f, &id);
        let v = versions(f.db.conn(), &id).unwrap();
        let last = &v.versions.last().unwrap().reason.replace('\u{a0}', " ");
        assert_eq!(last, "Досрочно 50 000 ₽ 01.12.2026, уменьшен срок");
        assert!(v.savings > 0, "экономия {}", v.savings);
        assert_eq!(v.current.rows.len(), f.detail(&id).schedule.len());

        // Документ для выгрузки.
        settings::set(f.db.conn(), "loan_lender_name", "Иванов Иван Иванович").unwrap();
        let doc = schedule_doc(f.db.conn(), &id, "2026-12-02", true).unwrap();
        assert_eq!(doc.lender_name, "Банк");
        assert_eq!(doc.borrower_name, "Иванов Иван Иванович");
        assert!(
            doc.rows.iter().any(|r| r.seq.is_none() && r.paid),
            "фактическая досрочка"
        );
        assert!(doc
            .rows
            .iter()
            .any(|r| r.note.as_deref() == Some("Плановая досрочка")));
        let pdf = crate::loan_export::schedule_pdf(&doc).unwrap();
        let text = pdf_extract::extract_text_from_mem(&pdf).unwrap();
        assert!(text.contains("Иванов Иван Иванович"));
    }

    type Dumped = (String, String, u32, String, i64, i64, i64, i64, String);

    /// Старая база (схема 0008) с долгами: после миграции графики те же, метод `monthly`.
    #[test]
    fn upgrade_from_schema_8_keeps_schedules() {
        use crate::loan_calc::legacy;
        use crate::storage::{migrate, MIGRATIONS};
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&mut conn, &MIGRATIONS[..8]).unwrap();
        let now = time::now_utc();
        let kinds = [
            ("annuity", Some(24), None),
            ("differentiated", Some(12), None),
            ("bullet", None, Some("2027-06-01")),
        ];
        let mut debts = Vec::new();
        for (i, (kind, term, maturity)) in kinds.into_iter().enumerate() {
            let input = LoanInput {
                principal: 30_000_000,
                rate_bp: 1800,
                repayment: Repayment::parse(kind).unwrap(),
                term_months: term,
                issue_date: "2026-10-15".into(),
                first_payment_date: None,
                maturity_date: maturity.map(str::to_string),
                interest_method: InterestMethod::Monthly,
            };
            let base = legacy::calculate(&input);
            let (account, id) = (format!("acc{i}"), format!("debt{i}"));
            conn.execute(
                "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, include_in_total,
                                       sort_order, created_at, updated_at)
                 VALUES (?1, 'Банк', 'debt', 'RUB', -30000000, '2026-10-15', 0, 0, ?2, ?2)",
                params![account, now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO debts (id, direction, counterparty, account_id, currency_code, principal, issue_date,
                                    rate_bp, repayment_type, frequency, term_months, first_payment_date, maturity_date,
                                    created_at, updated_at)
                 VALUES (?1, 'borrowed', 'Банк', ?2, 'RUB', 30000000, '2026-10-15', 1800, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    id,
                    account,
                    kind,
                    if kind == "bullet" { "once" } else { "monthly" },
                    term,
                    (kind != "bullet").then(|| base.rows[0].due_date.clone()),
                    base.maturity_date,
                    now
                ],
            )
            .unwrap();
            let t = Terms {
                id: id.clone(),
                direction: "borrowed".into(),
                counterparty: "Банк".into(),
                account_id: account,
                currency_code: "RUB".into(),
                principal: 30_000_000,
                issue_date: "2026-10-15".into(),
                rate_bp: 1800,
                repayment: input.repayment,
                term_months: term,
                first_payment_date: (kind != "bullet").then(|| base.rows[0].due_date.clone()),
                maturity_date: base.maturity_date.clone(),
                status: "active".into(),
                method: InterestMethod::Monthly,
            };
            debts.push((t, input));
        }
        // Прежний rebuild после каждого платежа.
        let write = |conn: &Connection, t: &Terms, input: &LoanInput, paid: &[legacy::Paid]| {
            let (lines, left) = legacy::rebuild(input, paid);
            let refs: Vec<(&Row, &str)> = lines.iter().map(|(r, s)| (r, *s)).collect();
            write_schedule(conn, t, &refs, left).unwrap();
        };
        for (t, input) in &debts {
            let mut paid: Vec<legacy::Paid> = Vec::new();
            write(&conn, t, input, &paid);
            let steps: [(bool, i64, &'static str); 4] = [
                (true, 100, "reduce_payment"),
                (false, 5_000_000, "reduce_term"),
                (true, 60, "reduce_payment"),
                (false, 2_000_000, "reduce_payment"),
            ];
            for (k, (scheduled, amount, mode)) in steps.into_iter().enumerate() {
                let next: Option<(String, u32, i64, i64)> = conn
                    .query_row(
                        "SELECT id, seq, principal_part, interest_part FROM debt_schedule
                         WHERE debt_id = ?1 AND status = 'pending' ORDER BY seq LIMIT 1",
                        [&t.id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )
                    .optional()
                    .unwrap();
                let Some((sid, seq, principal_part, interest_part)) = next else {
                    break;
                };
                let (sid, seq, principal, interest) =
                    if scheduled && t.repayment != Repayment::Bullet {
                        (
                            Some(sid),
                            Some(seq),
                            principal_part * amount / 100,
                            interest_part,
                        )
                    } else {
                        (None, None, amount, 0)
                    };
                conn.execute(
                    "INSERT INTO debt_payments (id, debt_id, schedule_id, date, principal_amount, interest_amount,
                                                recalc_mode, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![ids::new_id(), t.id, sid, format!("2026-11-{:02}", 15 + k), principal, interest, mode, now],
                )
                .unwrap();
                paid.push(legacy::Paid {
                    seq,
                    principal,
                    interest,
                    mode,
                });
                write(&conn, t, input, &paid);
            }
        }
        let dump = |conn: &Connection| -> Vec<Dumped> {
            conn.prepare(
                "SELECT id, debt_id, seq, due_date, payment, principal_part, interest_part, balance_after, status
                 FROM debt_schedule ORDER BY debt_id, seq",
            )
            .unwrap()
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
        };
        let before = dump(&conn);
        assert!(before.len() > 20);

        migrate(&mut conn, MIGRATIONS).unwrap();
        let methods: Vec<String> = conn
            .prepare("SELECT DISTINCT interest_method FROM debts")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(methods, ["monthly"]);
        assert_eq!(dump(&conn), before, "миграция графики не трогает");
        // Новый движок строит те же графики, id строк те же.
        for (t, _) in &debts {
            rebuild(&conn, &t.id).unwrap();
            get(&conn, &t.id, "2026-12-01").unwrap();
        }
        assert_eq!(dump(&conn), before, "новый rebuild даёт прежние строки");
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(150))]

        /// При любых платежах (по графику, меньше, больше, досрочно) график сходится
        /// с остатком: строки графика и досрочные платежи покрывают сумму долга,
        /// неоплаченные строки = остаток = баланс служебного счёта.
        #[test]
        fn schedule_always_matches_outstanding(
            principal in 100_000i64..50_000_000,
            rate_bp in 0i64..3000,
            term in 2u32..36,
            diff in proptest::bool::ANY,
            steps in proptest::collection::vec((0u8..4, 1i64..120, proptest::bool::ANY), 1..12),
        ) {
            let mut f = Fx::new();
            let card = f.card.clone();
            let kind = if diff { "differentiated" } else { "annuity" };
            let id = create(f.c(), &loan("borrowed", "Банк", principal, rate_bp, kind, Some(term), None, Some(card))).unwrap();
            for (i, (action, pct, term_mode)) in steps.into_iter().enumerate() {
                let d = f.detail(&id);
                if d.card.status == "closed" { break; }
                let next = d.card.next_payment.clone();
                let date = format!("2026-11-{:02}", 1 + i);
                let mode = Some(if term_mode { "reduce_term" } else { "reduce_payment" });
                let r = match (action, next) {
                    (0, Some(n)) => f.pay(&id, &date, n.principal_part, n.interest_part, true, mode),
                    (1, Some(n)) => f.pay(&id, &date, (n.principal_part * pct / 100).min(d.card.outstanding), n.interest_part, true, mode),
                    (2, _) => f.pay(&id, &date, (d.card.outstanding * pct / 200).max(1).min(d.card.outstanding), 0, false, mode),
                    _ => f.pay(&id, &date, d.card.outstanding, 0, false, mode),
                };
                r.unwrap();
                let d = f.detail(&id);
                proptest::prop_assert_eq!(f.balance(&d.card.account_id), -d.card.outstanding);
                // Досрочные платежи не строки графика: они в истории платежей.
                let early: i64 = d.payments.iter().filter(|p| p.schedule_seq.is_none()).map(|p| p.principal).sum();
                proptest::prop_assert_eq!(d.schedule.iter().map(|r| r.principal_part).sum::<i64>() + early, principal);
                let pending: i64 = d.schedule.iter().filter(|r| r.status == "pending").map(|r| r.principal_part).sum();
                proptest::prop_assert_eq!(pending, d.card.outstanding);
                proptest::prop_assert_eq!(d.card.status == "closed", d.card.outstanding == 0);
                for r in &d.schedule {
                    proptest::prop_assert_eq!(r.payment, r.principal_part + r.interest_part);
                }
            }
        }
    }
}
