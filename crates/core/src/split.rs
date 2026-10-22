//! Общие траты: «заплатил за троих». Своя доля — обычный расход, доли друзей —
//! долги «мне должны» (выданы с того же счёта), их возврат отмечается в «Долгах».

use chrono::Months;
use serde::Deserialize;

use crate::debts::{self, DebtInput};
use crate::error::invalid;
use crate::loan_calc::parse_date;
use crate::transactions::{self, TxnInput};
use crate::{accounts, categories, Connection, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub name: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitInput {
    pub date: String,
    pub account_id: String,
    pub category_id: String,
    pub payee: Option<String>,
    pub note: Option<String>,
    /// Сколько заплачено всего.
    pub total: i64,
    /// Своя доля; 0 — заплатил целиком за других.
    pub my_share: i64,
    pub friends: Vec<Share>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitResult {
    pub expense_id: Option<String>,
    pub debt_ids: Vec<String>,
}

/// Поровну: остаток от деления (копейки) достаётся своей доле.
pub fn even(total: i64, people: usize) -> (i64, i64) {
    let n = people.max(1) as i64;
    let each = total / n;
    (total - each * (n - 1), each)
}

pub fn create(conn: &mut Connection, input: &SplitInput) -> Result<SplitResult> {
    if input.total <= 0 {
        return invalid("сумма должна быть больше нуля");
    }
    if input.friends.is_empty() {
        return invalid("добавьте хотя бы одного, с кем делите трату");
    }
    if input.my_share < 0 || input.friends.iter().any(|f| f.amount <= 0) {
        return invalid("доли должны быть больше нуля");
    }
    if input.friends.iter().any(|f| f.name.trim().is_empty()) {
        return invalid("укажите имя у каждой доли");
    }
    let sum: i64 = input.my_share + input.friends.iter().map(|f| f.amount).sum::<i64>();
    if sum != input.total {
        return invalid("доли в сумме не равны общей сумме");
    }
    let account = accounts::head(conn, &input.account_id)?;
    let issue = parse_date(&input.date)?;
    let maturity = issue
        .checked_add_months(Months::new(1))
        .unwrap_or(issue)
        .to_string();
    let what = input
        .payee
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or("общая трата".to_string(), |p| {
            format!("общая трата: {p}")
        });
    // Всё в одной транзакции: при любой ошибке не записано ничего.
    let tx = conn.transaction()?;
    let expense_id = if input.my_share > 0 {
        Some(transactions::create(
            &tx,
            &TxnInput {
                kind: "expense".into(),
                date: input.date.clone(),
                account_id: input.account_id.clone(),
                amount: input.my_share,
                category_id: Some(input.category_id.clone()),
                to_account_id: None,
                to_amount: None,
                payee: input.payee.clone(),
                note: input.note.clone(),
            },
        )?)
    } else {
        if categories::kind_of(&tx, &input.category_id)? != "expense" {
            return invalid("для расхода нужна категория расходов");
        }
        None
    };
    let mut debt_ids = Vec::new();
    for f in &input.friends {
        debt_ids.push(debts::create_in(
            &tx,
            &DebtInput {
                direction: "lent".into(),
                counterparty: f.name.trim().into(),
                note: Some(capitalize(&what)),
                currency_code: account.currency_code.clone(),
                principal: f.amount,
                issue_date: input.date.clone(),
                rate_bp: 0,
                repayment_type: "bullet".into(),
                term_months: None,
                first_payment_date: None,
                maturity_date: Some(maturity.clone()),
                account_id: Some(input.account_id.clone()),
            },
        )?);
    }
    tx.commit()?;
    Ok(SplitResult {
        expense_id,
        debt_ids,
    })
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::categories;
    use crate::storage::Storage;

    fn setup() -> (Storage, String, String) {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let cat: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Кафе и рестораны'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (db, card, cat)
    }

    fn split(card: &str, cat: &str, total: i64, mine: i64, friends: &[(&str, i64)]) -> SplitInput {
        SplitInput {
            date: "2026-10-18".into(),
            account_id: card.into(),
            category_id: cat.into(),
            payee: Some("Шоколадница".into()),
            note: None,
            total,
            my_share: mine,
            friends: friends
                .iter()
                .map(|(n, a)| Share {
                    name: (*n).into(),
                    amount: *a,
                })
                .collect(),
        }
    }

    #[test]
    fn paid_for_three() {
        let (mut db, card, cat) = setup();
        let (mine, each) = even(300_001, 3);
        assert_eq!((mine, each), (100_001, 100_000));
        let r = create(
            db.conn_mut(),
            &split(&card, &cat, 300_001, mine, &[("Аня", each), ("Петя", each)]),
        )
        .unwrap();
        assert!(r.expense_id.is_some());
        assert_eq!(r.debt_ids.len(), 2);
        let c = db.conn();
        // Со счёта ушло всё: своя доля расходом, доли друзей — выданными долгами.
        assert_eq!(
            accounts::balance(c, &card, None).unwrap(),
            1_000_000 - 300_001
        );
        let s = debts::summary(c, "2026-10-20", 5).unwrap();
        assert_eq!(s.owed_to_me, 200_000);
        let d = debts::list(c, "2026-10-20").unwrap();
        assert!(d
            .iter()
            .all(|d| d.note.as_deref() == Some("Общая трата: Шоколадница")));
        let expense: i64 = c
            .query_row(
                "SELECT sum(amount) FROM transactions WHERE type = 'expense'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(expense, 100_001);
    }

    #[test]
    fn paid_fully_for_friend_and_errors() {
        let (mut db, card, cat) = setup();
        let r = create(
            db.conn_mut(),
            &split(&card, &cat, 50_000, 0, &[("Аня", 50_000)]),
        )
        .unwrap();
        assert_eq!(r.expense_id, None);
        assert_eq!(r.debt_ids.len(), 1);
        let c = db.conn_mut();
        assert!(create(c, &split(&card, &cat, 50_000, 10_000, &[("Аня", 30_000)])).is_err());
        assert!(create(c, &split(&card, &cat, 50_000, 50_000, &[])).is_err());
        assert!(create(c, &split(&card, &cat, 50_000, 0, &[(" ", 50_000)])).is_err());
        // Ошибка в своей доле (категория доходов) — долги тоже не записаны.
        let salary: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Зарплата'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(create(c, &split(&card, &salary, 50_000, 0, &[("Петя", 50_000)])).is_err());
        assert_eq!(debts::list(c, "2026-10-20").unwrap().len(), 1);
    }
}
