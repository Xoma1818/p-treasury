//! «Свободно до дохода» (0.27): сколько денег можно тратить до ближайшего
//! известного прихода. Деньги сегодня на быстрых счетах прогноза минус
//! известные платежи до прихода (напоминания, займы, запланированные) и минус
//! резервы, отложенные внутри этих счетов. Делится на дни до прихода.

use serde::Serialize;

use crate::forecast::{self, Item};
use crate::{accounts, currencies, goals, time, Result};

/// Дальше этого ближайший доход не ищем: без него считаем до конца месяца.
pub const LOOK_AHEAD_DAYS: i64 = 62;

/// Резерв внутри счёта, в основной валюте.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservePart {
    pub goal_id: String,
    pub name: String,
    pub account: String,
    pub amount: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeMoney {
    pub base_currency: String,
    pub today: String,
    /// До какого дня (не включая его) считается: дата дохода или день после
    /// конца месяца.
    pub until: String,
    /// Ближайший известный доход; `None` — дохода в ближайшие два месяца нет,
    /// считается до конца месяца.
    pub income: Option<Item>,
    /// Дней до `until`, не меньше 1.
    pub days: i64,
    /// Деньги сегодня на счетах прогноза.
    pub liquid: i64,
    /// Известные платежи до дохода (суммы положительные).
    pub payments: Vec<Item>,
    pub payments_total: i64,
    /// Известные приходы до дохода, кроме него самого (возвраты долгов и т. п.).
    pub inflow_total: i64,
    pub reserves: Vec<ReservePart>,
    pub reserved_total: i64,
    /// liquid − payments_total + inflow_total − reserved_total.
    pub free: i64,
    /// В день, округлено вниз; 0, если свободных денег нет.
    pub per_day: i64,
    pub missing_rates: Vec<String>,
}

/// Первый день после конца бюджетного месяца, в котором `today`.
fn after_month(conn: &rusqlite::Connection, today: &str) -> Result<String> {
    let p = crate::budgets::month_of(conn, today)?;
    Ok((time::parse_date(&p.end)? + chrono::Duration::days(1)).to_string())
}

pub fn until_income(conn: &rusqlite::Connection, today: &str) -> Result<FreeMoney> {
    let base = currencies::base_currency(conn)?;
    let skip = forecast::excluded_accounts(conn)?;
    let mut missing = Vec::new();
    let today_d = time::parse_date(today)?;
    let last = (today_d + chrono::Duration::days(LOOK_AHEAD_DAYS)).to_string();
    let items = forecast::known_items(conn, &base, today, &last, &skip, &mut missing)?;
    // Доход сегодня уже не ждём: его либо получили, либо он в балансе завтра.
    let income = items
        .iter()
        .find(|i| i.amount > 0 && i.date.as_str() > today && i.kind != "debt")
        .cloned();
    let until = match &income {
        Some(i) => i.date.clone(),
        None => after_month(conn, today)?,
    };
    let mut payments = Vec::new();
    let mut inflow_total = 0;
    for i in items.into_iter().filter(|i| i.date < until) {
        if i.amount < 0 {
            payments.push(Item {
                amount: -i.amount,
                ..i
            });
        } else {
            inflow_total += i.amount;
        }
    }
    let payments_total = payments.iter().map(|p| p.amount).sum();

    let mut liquid = 0;
    let mut reserves = Vec::new();
    let mut reserved_total = 0;
    let goals = goals::list(conn, today)?;
    for a in forecast::liquid_accounts(conn)?
        .into_iter()
        .filter(|a| !skip.contains(&a.id))
    {
        let conv = |v: i64| currencies::convert(conn, v, &a.currency_code, &base, today);
        let Some(bal) = conv(accounts::balance(conn, &a.id, Some(today))?)? else {
            if !missing.contains(&a.currency_code) {
                missing.push(a.currency_code.clone());
            }
            continue;
        };
        liquid += bal;
        for g in goals
            .iter()
            .filter(|g| g.reserve && g.account_id.as_deref() == Some(&a.id) && g.saved > 0)
        {
            let Some(v) = conv(g.saved)? else { continue };
            reserved_total += v;
            reserves.push(ReservePart {
                goal_id: g.id.clone(),
                name: g.name.clone(),
                account: a.name.clone(),
                amount: v,
            });
        }
    }
    let free = liquid - payments_total + inflow_total - reserved_total;
    let days = (time::parse_date(&until)? - today_d).num_days().max(1);
    Ok(FreeMoney {
        base_currency: base,
        today: today.to_string(),
        until,
        income,
        days,
        liquid,
        payments,
        payments_total,
        inflow_total,
        reserves,
        reserved_total,
        free,
        per_day: if free > 0 { free / days } else { 0 },
        missing_rates: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{create, AccountInput};
    use crate::goals::GoalInput;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn acc(c: &rusqlite::Connection, name: &str, kind: &str, balance: i64) -> String {
        create(
            c,
            &AccountInput {
                name: name.into(),
                kind: kind.into(),
                currency_code: "RUB".into(),
                opening_balance: balance,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap()
    }

    fn planned(c: &rusqlite::Connection, kind: &str, date: &str, account: &str, amount: i64) {
        let cat: String = c
            .query_row(
                "SELECT id FROM categories WHERE kind = ?1 LIMIT 1",
                [kind],
                |r| r.get(0),
            )
            .unwrap();
        let id = transactions::create(
            c,
            &TxnInput {
                kind: kind.into(),
                date: date.into(),
                account_id: account.into(),
                amount,
                category_id: Some(cat),
                to_account_id: None,
                to_amount: None,
                payee: Some(
                    if kind == "income" {
                        "Зарплата"
                    } else {
                        "Аренда"
                    }
                    .into(),
                ),
                note: None,
            },
        )
        .unwrap();
        c.execute(
            "UPDATE transactions SET status = 'planned' WHERE id = ?1",
            [id],
        )
        .unwrap();
    }

    #[test]
    fn free_until_salary_minus_payments_and_reserves() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = acc(c, "Карта", "debit", 8_000_000);
        acc(c, "Наличные", "cash", 1_000_000);
        planned(c, "expense", "2026-11-03", &card, 3_000_000);
        planned(c, "income", "2026-11-10", &card, 10_000_000);
        // После дохода — не входит.
        planned(c, "expense", "2026-11-12", &card, 500_000);

        let vacation = goals::create(
            c,
            &GoalInput {
                name: "Отпуск".into(),
                target: 5_000_000,
                currency_code: "RUB".into(),
                account_id: Some(card.clone()),
                deadline: None,
                reserve: true,
            },
        )
        .unwrap();
        goals::deposit(c, &vacation, "2026-10-31", 2_000_000).unwrap();

        let f = until_income(c, "2026-10-31").unwrap();
        assert_eq!(f.until, "2026-11-10");
        assert_eq!(f.income.as_ref().unwrap().amount, 10_000_000);
        assert_eq!(f.days, 10);
        assert_eq!(f.liquid, 9_000_000);
        assert_eq!(f.payments_total, 3_000_000);
        assert_eq!(f.reserved_total, 2_000_000);
        assert_eq!(f.free, 4_000_000);
        assert_eq!(f.per_day, 400_000);
        assert_eq!(f.reserves[0].name, "Отпуск");

        // Резерв не больше свободного на счёте и не уходит в минус.
        assert!(goals::deposit(c, &vacation, "2026-10-31", 7_000_000).is_err());
        assert!(goals::deposit(c, &vacation, "2026-10-31", -2_500_000).is_err());
        let g = goals::list(c, "2026-10-31").unwrap();
        assert_eq!((g[0].saved, g[0].percent), (2_000_000, 40));
    }

    #[test]
    fn without_income_counts_to_month_end() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        acc(c, "Карта", "debit", 1_000_000);
        let f = until_income(c, "2026-10-21").unwrap();
        assert!(f.income.is_none());
        assert_eq!(f.until, "2026-11-01");
        assert_eq!((f.days, f.free, f.per_day), (11, 1_000_000, 90_909));

        // Резерв без счёта или в чужой валюте не создаётся.
        let bad = |account: Option<String>, cur: &str| {
            goals::create(
                c,
                &GoalInput {
                    name: "Ремонт".into(),
                    target: 100,
                    currency_code: cur.into(),
                    account_id: account,
                    deadline: None,
                    reserve: true,
                },
            )
        };
        assert!(bad(None, "RUB").is_err());
        let card: String = c
            .query_row("SELECT id FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert!(bad(Some(card.clone()), "USD").is_err());
        assert!(bad(Some(card), "RUB").is_ok());
    }

    #[test]
    fn changing_a_goal_keeps_reserves_honest() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let card = acc(c, "Карта", "debit", 1_000_000);
        let small = acc(c, "Копилка", "savings", 100_000);
        let input = |account: Option<&String>, reserve: bool| GoalInput {
            name: "Ремонт".into(),
            target: 2_000_000,
            currency_code: "RUB".into(),
            account_id: account.cloned(),
            deadline: None,
            reserve,
        };
        let held = goals::create(c, &input(Some(&card), true)).unwrap();
        goals::deposit(c, &held, "2026-10-31", 500_000).unwrap();
        let manual = goals::create(c, &input(None, false)).unwrap();
        goals::deposit(c, &manual, "2026-10-31", 600_000).unwrap();

        // а) обычная цель с отметками → резерв: не больше свободного на счёте.
        assert!(goals::update(c, &manual, &input(Some(&card), true)).is_err());
        goals::deposit(c, &manual, "2026-10-31", -200_000).unwrap();
        goals::update(c, &manual, &input(Some(&card), true)).unwrap();
        // в) перенос резерва на счёт, где столько нет.
        assert!(goals::update(c, &manual, &input(Some(&small), true)).is_err());
        // б) резерв → цель со счётом: отметки не пропадают молча.
        assert!(goals::update(c, &manual, &input(Some(&card), false)).is_err());
        goals::update(c, &manual, &input(None, false)).unwrap();
        let g = goals::list(c, "2026-10-31").unwrap();
        let m = g.iter().find(|g| g.id == manual).unwrap();
        assert_eq!((m.saved, m.reserve), (400_000, false));

        // Счёт резерва удалён: цель становится обычной и редактируется.
        c.execute("UPDATE goals SET account_id = NULL WHERE id = ?1", [&held])
            .unwrap();
        let g = goals::list(c, "2026-10-31").unwrap();
        let h = g.iter().find(|g| g.id == held).unwrap();
        assert_eq!((h.saved, h.reserve), (500_000, false));
        goals::update(c, &held, &input(None, false)).unwrap();
    }
}
