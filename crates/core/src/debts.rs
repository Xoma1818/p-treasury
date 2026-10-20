//! Долги и займы. Каждый долг — служебный счёт типа `debt`: выдача и возврат
//! основного долга — переводы, проценты — расход «Проценты по кредитам» или
//! доход «Проценты по займам». Остаток долга = сумма долга − возвращённое.
//!
//! График (`debt_schedule`) — функция условий долга и списка платежей:
//! после каждого платежа или его удаления он перестраивается заново
//! (`rebuild`), строки обновляются по номеру, поэтому их id не меняются.

use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::loan_calc::{self, LoanInput, Plan, Repayment, Row};
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtDetail {
    pub card: DebtCard,
    pub schedule: Vec<ScheduleRow>,
    pub payments: Vec<PaymentRow>,
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
        }
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
                repayment_type, term_months, first_payment_date, maturity_date, status
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
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("долг"))
}

/// Счёт оплаты: обычный открытый счёт в валюте долга.
fn payment_account(conn: &Connection, id: &str, currency: &str) -> Result<accounts::Account> {
    let a = accounts::get(conn, id)?;
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
    if !matches!(input.direction.as_str(), "lent" | "borrowed") {
        return invalid("направление: «я дал» или «я взял»");
    }
    let counterparty = input.counterparty.trim();
    if counterparty.is_empty() {
        return invalid("укажите, кто должен или кому");
    }
    currencies::get(conn, &input.currency_code)?;
    let repayment = Repayment::parse(&input.repayment_type)?;
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
    };
    let schedule = loan_calc::calculate(&loan)?;
    if let Some(acc) = input.account_id.as_deref() {
        payment_account(conn, acc, &input.currency_code)?;
    }
    let first_payment = match repayment {
        Repayment::Bullet => None,
        _ => schedule.rows.first().map(|r| r.due_date.clone()),
    };

    let tx = conn.transaction()?;
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
                            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
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
            now
        ],
    )?;
    if let Some(acc) = input.account_id.as_deref() {
        let (from, to, note) = if input.direction == "lent" {
            (acc, account.as_str(), "Выдача долга")
        } else {
            (account.as_str(), acc, "Получение долга")
        };
        insert_txn(
            &tx,
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
    rebuild(&tx, &id)?;
    tx.commit()?;
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
    let (debt_id, p_txn, i_txn): (String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT debt_id, principal_transaction_id, interest_transaction_id FROM debt_payments WHERE id = ?1",
            [payment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or(Error::NotFound("платёж"))?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM debt_payments WHERE id = ?1", [payment_id])?;
    for t in [p_txn, i_txn].into_iter().flatten() {
        tx.execute("DELETE FROM transactions WHERE id = ?1", [t])?;
    }
    rebuild(&tx, &debt_id)?;
    tx.commit()?;
    Ok(())
}

struct Paid {
    seq: Option<u32>,
    principal: i64,
    interest: i64,
    mode: String,
    date: String,
}

#[derive(Clone)]
struct Line {
    row: Row,
    status: &'static str,
}

/// Перестроить график по условиям и платежам. Вызывается внутри транзакции.
fn rebuild(conn: &Connection, debt_id: &str) -> Result<()> {
    let t = terms(conn, debt_id)?;
    let base = loan_calc::calculate(&t.loan())?;
    let first = t
        .first_payment_date
        .as_deref()
        .map(loan_calc::parse_date)
        .transpose()?;
    let mut lines: Vec<Line> = base
        .rows
        .iter()
        .cloned()
        .map(|row| Line {
            row,
            status: "pending",
        })
        .collect();

    let mut stmt = conn.prepare(
        "SELECT s.seq, p.principal_amount, p.interest_amount, COALESCE(p.recalc_mode, 'reduce_payment'), p.date
         FROM debt_payments p LEFT JOIN debt_schedule s ON s.id = p.schedule_id
         WHERE p.debt_id = ?1 ORDER BY p.date, p.created_at",
    )?;
    let payments: Vec<Paid> = stmt
        .query_map([debt_id], |r| {
            Ok(Paid {
                seq: r.get(0)?,
                principal: r.get(1)?,
                interest: r.get(2)?,
                mode: r.get(3)?,
                date: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut left = t.principal;
    let mut interest_paid = 0;
    for p in &payments {
        left -= p.principal;
        interest_paid += p.interest;
        if t.repayment == Repayment::Bullet {
            continue;
        }
        let from = match p
            .seq
            .and_then(|s| lines.iter().position(|l| l.row.seq == s))
        {
            Some(i) => {
                let planned = lines[i].row.principal_part;
                lines[i] = Line {
                    row: Row {
                        payment: p.principal + p.interest,
                        principal_part: p.principal,
                        interest_part: p.interest,
                        balance_after: left,
                        ..lines[i].row.clone()
                    },
                    status: if p.principal >= planned {
                        "paid"
                    } else {
                        "partial"
                    },
                };
                if p.principal == planned {
                    continue;
                }
                i + 1
            }
            // Досрочный платёж: пересчитываются все неоплаченные строки.
            None => lines
                .iter()
                .position(|l| l.status == "pending")
                .unwrap_or(lines.len()),
        };
        let first = first.expect("у ежемесячного долга есть дата первого платежа");
        recalc(&mut lines, from, left, &t, &p.mode, first);
    }
    if t.repayment == Repayment::Bullet {
        let row = &mut lines[0];
        if left == 0 {
            row.status = "paid";
        } else {
            let interest = (base.total_interest - interest_paid).max(0);
            row.row.principal_part = left;
            row.row.interest_part = interest;
            row.row.payment = left + interest;
        }
    } else if left == 0 {
        lines.retain(|l| l.status != "pending");
    }

    // Запись по номеру строки: id сохраняются (на них ссылаются платежи и напоминания).
    for l in &lines {
        let r = &l.row;
        let changed = conn.execute(
            "UPDATE debt_schedule SET due_date = ?3, payment = ?4, principal_part = ?5, interest_part = ?6,
                    balance_after = ?7, status = ?8
             WHERE debt_id = ?1 AND seq = ?2",
            params![debt_id, r.seq, r.due_date, r.payment, r.principal_part, r.interest_part, r.balance_after, l.status],
        )?;
        if changed == 0 {
            conn.execute(
                "INSERT INTO debt_schedule (id, debt_id, seq, due_date, payment, principal_part, interest_part,
                                            balance_after, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![ids::new_id(), debt_id, r.seq, r.due_date, r.payment, r.principal_part, r.interest_part, r.balance_after, l.status],
            )?;
        }
    }
    let max_seq = lines.iter().map(|l| l.row.seq).max().unwrap_or(0);
    conn.execute(
        "DELETE FROM debt_schedule WHERE debt_id = ?1 AND seq > ?2",
        params![debt_id, max_seq],
    )?;

    let maturity = lines
        .last()
        .map(|l| l.row.due_date.clone())
        .unwrap_or(t.maturity_date.clone());
    let closed_at = (left == 0)
        .then(|| payments.last().map(|p| p.date.clone()))
        .flatten();
    conn.execute(
        "UPDATE debts SET maturity_date = ?2, status = ?3, closed_at = ?4, updated_at = ?5 WHERE id = ?1",
        params![debt_id, maturity, if left == 0 { "closed" } else { "active" }, closed_at, time::now_utc()],
    )?;
    Ok(())
}

/// Пересчитать строки начиная с `from` от остатка `left`.
fn recalc(lines: &mut Vec<Line>, from: usize, left: i64, t: &Terms, mode: &str, first: NaiveDate) {
    let tail = &lines[from.min(lines.len())..];
    let count = tail.len() as u32;
    let start_seq = lines
        .get(from)
        .map_or_else(|| lines.last().map_or(1, |l| l.row.seq + 1), |l| l.row.seq);
    let plan = match (mode, tail.first()) {
        ("reduce_term", Some(l)) if t.repayment == Repayment::Annuity => {
            Plan::Payment(l.row.payment)
        }
        ("reduce_term", Some(l)) => Plan::Principal(l.row.principal_part),
        // Платёж меньше графика на последней строке: остаток переносится на месяц позже.
        (_, _) => Plan::Count(count.max(1)),
    };
    lines.truncate(from);
    if left > 0 {
        let rows = loan_calc::monthly_rows(left, t.rate_bp, t.repayment, plan, first, start_seq);
        lines.extend(rows.into_iter().map(|row| Line {
            row,
            status: "pending",
        }));
    }
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
    /// Счета («в общем балансе») + должны мне − должен я.
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
        net_worth: totals.total + owed_to_me - i_owe,
        accounts_total: totals.total,
        missing_rates,
        upcoming,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;
    use crate::{reports, transactions};

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
