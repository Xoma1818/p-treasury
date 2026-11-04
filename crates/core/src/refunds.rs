//! Возвраты (0.29): деньги за покупку вернулись на счёт.
//!
//! Возврат — приход на счёт (`type = 'income'`, баланс растёт), но в бюджете,
//! отчётах и прогнозе это минус расход категории покупки (представление
//! `txn_by_month`, миграция 0018). Пользователь выбирает месяц: месяц покупки
//! (по умолчанию: лимит «Одежды» в октябре снова свободен, если вернули
//! октябрьскую куртку) или месяц самого возврата.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::transactions::{self, Txn};
use crate::{accounts, budgets, ids, time, Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundInput {
    /// Исходный расход.
    pub of: String,
    pub date: String,
    /// Счёт, на который вернулись деньги; по умолчанию — счёт покупки.
    pub account_id: Option<String>,
    pub amount: i64,
    /// `true` — учесть в месяце покупки, `false` — в месяце возврата.
    pub in_purchase_month: bool,
    pub note: Option<String>,
}

/// Что нужно окну возврата.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundInfo {
    pub purchase: Txn,
    /// Бюджетный месяц покупки `YYYY-MM`.
    pub purchase_month: String,
    /// Уже возвращено другими возвратами (без того, что правится).
    pub refunded: i64,
    /// Сколько ещё можно вернуть.
    pub left: i64,
}

struct Purchase {
    kind: String,
    date: String,
    account_id: String,
    amount: i64,
    category_id: Option<String>,
    payee: Option<String>,
    status: String,
    debt_id: Option<String>,
    refund: bool,
    spread_months: Option<i64>,
}

fn purchase(conn: &Connection, id: &str) -> Result<Purchase> {
    conn.query_row(
        "SELECT type, date, account_id, amount, category_id, payee, status, debt_id, refund, spread_months
         FROM transactions WHERE id = ?1",
        [id],
        |r| {
            Ok(Purchase {
                kind: r.get(0)?,
                date: r.get(1)?,
                account_id: r.get(2)?,
                amount: r.get(3)?,
                category_id: r.get(4)?,
                payee: r.get(5)?,
                status: r.get(6)?,
                debt_id: r.get(7)?,
                refund: r.get(8)?,
                spread_months: r.get(9)?,
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("покупка"))
}

fn refunded(conn: &Connection, of: &str, except: Option<&str>) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(sum(amount), 0) FROM transactions
         WHERE refund = 1 AND refund_of = ?1 AND id IS NOT ?2",
        params![of, except],
        |r| r.get(0),
    )?)
}

pub fn info(conn: &Connection, of: &str, except: Option<&str>) -> Result<RefundInfo> {
    let p = purchase(conn, of)?;
    let done = refunded(conn, of, except)?;
    Ok(RefundInfo {
        purchase: transactions::get(conn, of)?,
        purchase_month: budgets::month_of(conn, &p.date)?.month,
        refunded: done,
        left: (p.amount - done).max(0),
    })
}

/// Проверенный возврат.
struct Checked {
    account: String,
    category: Option<String>,
    payee: Option<String>,
    /// Дата, по которой возврат попадает в месяц (`None` — своя дата).
    count_date: Option<String>,
}

fn check(conn: &Connection, input: &RefundInput, except: Option<&str>) -> Result<Checked> {
    time::check_date(&input.date)?;
    let p = purchase(conn, &input.of)?;
    if p.kind != "expense" || p.refund || p.debt_id.is_some() {
        return invalid("вернуть можно только обычную покупку");
    }
    if p.spread_months.is_some() {
        return invalid(
            "покупка учитывается по месяцам: сначала уберите это, потом оформляйте возврат",
        );
    }
    if p.status != "cleared" {
        return invalid("покупка ещё запланирована: возврат — после неё");
    }
    if input.date < p.date {
        return invalid("возврат не может быть раньше покупки");
    }
    if input.amount <= 0 {
        return invalid("сумма возврата должна быть больше нуля");
    }
    let left = p.amount - refunded(conn, &input.of, except)?;
    if input.amount > left {
        return invalid("вернули больше, чем стоила покупка");
    }
    let account = input
        .account_id
        .clone()
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| p.account_id.clone());
    let to = accounts::head(conn, &account)?;
    if to.kind == "debt" {
        return invalid("выберите счёт, на который вернулись деньги");
    }
    if to.currency_code != accounts::head(conn, &p.account_id)?.currency_code {
        return invalid("возврат — в валюте покупки");
    }
    let count_date = input.in_purchase_month.then(|| p.date.clone());
    Ok(Checked {
        account,
        category: p.category_id,
        payee: p.payee,
        count_date,
    })
}

fn note(input: &RefundInput) -> Option<String> {
    input
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn create(conn: &Connection, input: &RefundInput) -> Result<String> {
    let Checked {
        account,
        category,
        payee,
        count_date,
    } = check(conn, input, None)?;
    let id = ids::new_id();
    conn.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, category_id, payee, note,
                                   refund, refund_of, count_date, created_at, updated_at)
         VALUES (?1, 'income', ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?10)",
        params![
            id,
            input.date,
            account,
            input.amount,
            category,
            payee,
            note(input),
            input.of,
            count_date,
            time::now_utc()
        ],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, input: &RefundInput) -> Result<()> {
    let of: Option<String> = conn
        .query_row(
            "SELECT refund_of FROM transactions WHERE id = ?1 AND refund = 1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound("возврат"))?;
    if of.as_deref() != Some(input.of.as_str()) {
        return invalid("покупку у возврата сменить нельзя: удалите его и сделайте новый");
    }
    let Checked {
        account,
        count_date,
        ..
    } = check(conn, input, Some(id))?;
    conn.execute(
        "UPDATE transactions SET date = ?2, account_id = ?3, amount = ?4, note = ?5,
                count_date = ?6, updated_at = ?7
         WHERE id = ?1",
        params![
            id,
            input.date,
            account,
            input.amount,
            note(input),
            count_date,
            time::now_utc()
        ],
    )?;
    Ok(())
}

/// Возвраты покупки `id`: сумма и самая ранняя дата.
fn refunds_of(conn: &Connection, id: &str) -> Result<(i64, Option<String>)> {
    // Пример данных в тесте обновления заполняет схему до 0018: там возвратов нет.
    let has_column: bool = conn.query_row(
        "SELECT count(*) > 0 FROM pragma_table_info('transactions') WHERE name = 'refund'",
        [],
        |r| r.get(0),
    )?;
    if !has_column {
        return Ok((0, None));
    }
    Ok(conn.query_row(
        "SELECT COALESCE(sum(amount), 0), min(date) FROM transactions
         WHERE refund = 1 AND refund_of = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

/// Есть ли у покупки возвраты.
pub fn has_refunds(conn: &Connection, id: &str) -> Result<bool> {
    Ok(refunds_of(conn, id)?.1.is_some())
}

/// Новая дата покупки: не позже её возвратов; возвраты, учтённые в месяце
/// покупки, переезжают вместе с ней.
pub fn purchase_moved(conn: &Connection, id: &str, date: &str) -> Result<()> {
    let (_, first) = refunds_of(conn, id)?;
    let Some(first) = first else { return Ok(()) };
    if date > first.as_str() {
        return invalid("по этой покупке есть возврат: покупка не может быть позже него");
    }
    conn.execute(
        "UPDATE transactions SET count_date = ?2
         WHERE refund = 1 AND refund_of = ?1 AND count_date IS NOT NULL",
        params![id, date],
    )?;
    Ok(())
}

/// Правка покупки с возвратами: она остаётся расходом не меньше возвращённого,
/// а категория и месяц возвратов следуют за ней.
pub fn purchase_edited(
    conn: &Connection,
    id: &str,
    kind: &str,
    amount: i64,
    date: &str,
    category_id: Option<&str>,
) -> Result<()> {
    let (done, first) = refunds_of(conn, id)?;
    if first.is_none() {
        return Ok(());
    }
    if kind != "expense" {
        return invalid("по этой покупке есть возврат: она остаётся расходом");
    }
    if amount < done {
        return invalid("по этой покупке уже вернули больше: сначала поправьте возврат");
    }
    purchase_moved(conn, id, date)?;
    conn.execute(
        "UPDATE transactions SET category_id = ?2 WHERE refund = 1 AND refund_of = ?1",
        params![id, category_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{create as acc, AccountInput};
    use crate::storage::Storage;
    use crate::transactions::TxnInput;

    fn card(c: &Connection) -> String {
        acc(
            c,
            &AccountInput {
                name: "Карта".into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 10_000_000,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap()
    }

    fn category(c: &Connection) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE kind = 'expense' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn spent(c: &Connection, month: &str, cat: &str) -> i64 {
        let p = budgets::period(month, budgets::start_day(c).unwrap()).unwrap();
        c.query_row(
            "SELECT COALESCE(sum(amount), 0) FROM txn_by_month
             WHERE type = 'expense' AND category_id = ?1 AND date BETWEEN ?2 AND ?3",
            params![cat, p.start, p.end],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn refund_counts_in_chosen_month_and_adds_to_balance() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = card(c);
        let cat = category(c);
        let jacket = transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: "2026-10-20".into(),
                account_id: card.clone(),
                amount: 800_000,
                category_id: Some(cat.clone()),
                to_account_id: None,
                to_amount: None,
                payee: Some("Магазин".into()),
                note: None,
            },
        )
        .unwrap();
        let input = |amount, in_purchase_month| RefundInput {
            of: jacket.clone(),
            date: "2026-11-03".into(),
            account_id: None,
            amount,
            in_purchase_month,
            note: None,
        };
        // По умолчанию — в месяце покупки.
        let r = create(c, &input(300_000, true)).unwrap();
        assert_eq!(spent(c, "2026-10", &cat), 500_000);
        assert_eq!(spent(c, "2026-11", &cat), 0);
        assert_eq!(
            accounts::balance(c, &card, Some("2026-11-03")).unwrap(),
            10_000_000 - 800_000 + 300_000
        );
        let t = transactions::get(c, &r).unwrap();
        assert!(t.refund && t.refund_of.as_deref() == Some(jacket.as_str()));
        assert_eq!(t.payee.as_deref(), Some("Магазин"));

        // В месяце возврата.
        update(c, &r, &input(300_000, false)).unwrap();
        assert_eq!(spent(c, "2026-10", &cat), 800_000);
        assert_eq!(spent(c, "2026-11", &cat), -300_000);

        // Больше покупки не вернуть, в сумме тоже.
        assert!(create(c, &input(600_000, true)).is_err());
        create(c, &input(500_000, true)).unwrap();
        let i = info(c, &jacket, None).unwrap();
        assert_eq!(
            (i.refunded, i.left, i.purchase_month.as_str()),
            (800_000, 0, "2026-10")
        );
        // Возврат не правится обычной формой и не возвращается сам.
        assert!(transactions::update(
            c,
            &r,
            &TxnInput {
                kind: "income".into(),
                date: "2026-11-03".into(),
                account_id: card.clone(),
                amount: 1,
                category_id: None,
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            }
        )
        .is_err());
        assert!(create(
            c,
            &RefundInput {
                of: r.clone(),
                ..input(1, true)
            }
        )
        .is_err());
        // Раньше покупки — нельзя.
        assert!(create(
            c,
            &RefundInput {
                date: "2026-10-01".into(),
                ..input(1, true)
            }
        )
        .is_err());
        // Правка покупки: не меньше возвращённого, остаётся расходом, категория следует.
        let edit = |kind: &str, amount, date: &str, cat: &str| TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: card.clone(),
            amount,
            category_id: Some(cat.into()),
            to_account_id: None,
            to_amount: None,
            payee: Some("Магазин".into()),
            note: None,
        };
        assert!(
            transactions::update(c, &jacket, &edit("expense", 700_000, "2026-10-20", &cat))
                .is_err()
        );
        assert!(
            transactions::update(c, &jacket, &edit("income", 800_000, "2026-10-20", &cat)).is_err()
        );
        assert!(
            transactions::update(c, &jacket, &edit("expense", 800_000, "2026-11-10", &cat))
                .is_err()
        );
        assert!(transactions::set_spread(c, &jacket, Some(3)).is_err());
        let other: String = c
            .query_row(
                "SELECT id FROM categories WHERE kind = 'expense' AND id <> ?1 LIMIT 1",
                [&cat],
                |r| r.get(0),
            )
            .unwrap();
        transactions::update(c, &jacket, &edit("expense", 800_000, "2026-10-18", &other)).unwrap();
        let moved = transactions::get(c, &r).unwrap();
        assert_eq!(moved.category_id.as_deref(), Some(other.as_str()));
        assert_eq!(moved.count_date, None);
        assert_eq!(spent(c, "2026-10", &other), 300_000);
        transactions::update(c, &jacket, &edit("expense", 800_000, "2026-10-20", &cat)).unwrap();

        // Отчёт по месяцам и выбранные операции видят возврат как минус расход.
        let sums = transactions::sum_ids(c, &[jacket.clone(), r.clone()]).unwrap();
        assert_eq!((sums.expense, sums.income), (500_000, 0));
    }
}
