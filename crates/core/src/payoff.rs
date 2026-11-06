//! Р17: стратегия досрочного погашения нескольких долгов. Каждый месяц по всем
//! взятым долгам вносится обычный платёж, а сверху — одна и та же «лишняя» сумма.
//! Она идёт в один долг: «сначала дорогие» (с самой высокой ставкой) или
//! «сначала маленькие» (с самым маленьким остатком). Закрытый долг отдаёт свой
//! платёж следующему. Сравнение — с погашением только обычными платежами.
//! Модель упрощённая: ежемесячные проценты на остаток, платёж — как ближайший по графику.

use rusqlite::Connection;
use serde::Serialize;

use crate::loan_calc::month_interest;
use crate::{budgets, currencies, debts, Result};

/// Дальше этого срока считаем, что долг обычными платежами не закрывается.
const MAX_MONTHS: u32 = 600;

#[derive(Debug, Clone)]
pub struct PayoffDebt {
    pub id: String,
    pub name: String,
    /// Остаток долга в основной валюте.
    pub balance: i64,
    pub rate_bp: i64,
    /// Обычный ежемесячный платёж в основной валюте.
    pub payment: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoffClose {
    pub id: String,
    pub name: String,
    /// Месяц `YYYY-MM`, в котором долг закрыт по плану.
    pub month: String,
    /// А обычными платежами — когда (None — не закрывается за 50 лет).
    pub base_month: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payoff {
    pub strategy: String,
    pub extra: i64,
    pub currency_symbol: String,
    pub minor_units: u32,
    /// Долги в порядке закрытия по плану.
    pub order: Vec<PayoffClose>,
    /// «Дата свободы»: последний месяц выплат по плану и обычными платежами.
    pub free_month: Option<String>,
    pub base_free_month: Option<String>,
    pub interest: i64,
    pub base_interest: i64,
    /// Сколько процентов не придётся платить.
    pub saved: i64,
    /// Валюты долгов без курса: такие долги не вошли.
    pub missing_rates: Vec<String>,
}

struct Run {
    /// Номер месяца закрытия по каждому долгу (с 1).
    closed: Vec<Option<u32>>,
    interest: i64,
    last: Option<u32>,
}

/// Помесячный расчёт. `extra = None` — только обычные платежи, без перекладывания.
fn simulate(list: &[PayoffDebt], extra: Option<i64>, strategy: &str) -> Run {
    let mut bal: Vec<i64> = list.iter().map(|d| d.balance.max(0)).collect();
    let mut closed: Vec<Option<u32>> = bal.iter().map(|b| (*b == 0).then_some(0)).collect();
    let mut interest = 0i64;
    for m in 1..=MAX_MONTHS {
        if closed.iter().all(Option::is_some) {
            break;
        }
        let mut pool = extra.unwrap_or(0);
        for (i, d) in list.iter().enumerate() {
            if closed[i].is_some() {
                // Закрытый долг отдаёт свой платёж остальным (только в плане).
                if extra.is_some() {
                    pool += d.payment;
                }
                continue;
            }
            let pct = month_interest(bal[i], d.rate_bp);
            interest += pct;
            bal[i] += pct;
            let p = d.payment.min(bal[i]);
            bal[i] -= p;
            if extra.is_some() {
                pool += d.payment - p;
            }
        }
        // Лишнее — в долги по очереди стратегии.
        while pool > 0 {
            let open = (0..list.len()).filter(|i| bal[*i] > 0);
            let target = if strategy == "small" {
                open.min_by_key(|i| (bal[*i], -list[*i].rate_bp))
            } else {
                open.max_by_key(|i| (list[*i].rate_bp, -bal[*i]))
            };
            let Some(t) = target else { break };
            let p = pool.min(bal[t]);
            bal[t] -= p;
            pool -= p;
        }
        for i in 0..list.len() {
            if closed[i].is_none() && bal[i] == 0 {
                closed[i] = Some(m);
            }
        }
    }
    let last = if closed.iter().all(Option::is_some) {
        closed.iter().flatten().max().copied()
    } else {
        None
    };
    Run {
        closed,
        interest,
        last,
    }
}

/// План для готового списка (считается в ядре и проверяется тестами).
pub fn plan(list: &[PayoffDebt], extra: i64, strategy: &str, first_month: &str) -> Result<Payoff> {
    let strategy = if strategy == "small" {
        "small"
    } else {
        "costly"
    };
    let base = simulate(list, None, strategy);
    let run = simulate(list, Some(extra.max(0)), strategy);
    // Месяц `m` (с 1) — это `first_month + m − 1`; закрытый с самого начала — в нём же.
    let month = |m: u32| budgets::shift_month(first_month, m.max(1) as i32 - 1);
    let mut order = Vec::new();
    let mut idx: Vec<usize> = (0..list.len()).collect();
    idx.sort_by_key(|i| (run.closed[*i].unwrap_or(u32::MAX), list[*i].name.clone()));
    for i in idx {
        let Some(m) = run.closed[i] else { continue };
        order.push(PayoffClose {
            id: list[i].id.clone(),
            name: list[i].name.clone(),
            month: month(m)?,
            base_month: base.closed[i].map(month).transpose()?,
        });
    }
    Ok(Payoff {
        strategy: strategy.into(),
        extra: extra.max(0),
        currency_symbol: String::new(),
        minor_units: 2,
        order,
        free_month: run.last.map(month).transpose()?,
        base_free_month: base.last.map(month).transpose()?,
        interest: run.interest,
        base_interest: base.interest,
        saved: if base.last.is_some() {
            base.interest - run.interest
        } else {
            0
        },
        missing_rates: Vec::new(),
    })
}

/// Р17 по своим долгам: взятые и не закрытые, суммы в основной валюте.
pub fn for_debts(conn: &Connection, today: &str, extra: i64, strategy: &str) -> Result<Payoff> {
    let base = currencies::base_currency(conn)?;
    let bc = currencies::get(conn, &base)?;
    let mut missing = Vec::new();
    let mut list = Vec::new();
    for d in debts::list(conn, today)? {
        if d.direction != "borrowed" || d.status == "closed" || d.outstanding <= 0 {
            continue;
        }
        // Обычный платёж — ближайший по графику; без графика — только проценты.
        let payment = d
            .next_payment
            .as_ref()
            .map(|p| p.payment)
            .unwrap_or_else(|| month_interest(d.outstanding, d.rate_bp));
        let conv = |v: i64| currencies::convert(conn, v, &d.currency_code, &base, today);
        let (Some(balance), Some(payment)) = (conv(d.outstanding)?, conv(payment)?) else {
            if !missing.contains(&d.currency_code) {
                missing.push(d.currency_code.clone());
            }
            continue;
        };
        list.push(PayoffDebt {
            id: d.id,
            name: d.counterparty,
            balance,
            rate_bp: d.rate_bp,
            payment,
        });
    }
    let first = budgets::month_of(conn, today)?.month;
    let mut out = plan(&list, extra, strategy, &first)?;
    out.currency_symbol = bc.symbol;
    out.minor_units = bc.minor_units;
    out.missing_rates = missing;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn debt(id: &str, balance: i64, rate_pct: i64, payment: i64) -> PayoffDebt {
        PayoffDebt {
            id: id.into(),
            name: id.into(),
            balance,
            rate_bp: rate_pct * 100,
            payment,
        }
    }

    #[test]
    fn extra_money_saves_interest_and_brings_freedom_closer() {
        // Кредитка 30 000 под 30 %, потребкредит 200 000 под 15 %, займ у друга 10 000 без процентов.
        let list = [
            debt("Кредитка", 3_000_000, 30, 300_000),
            debt("Потребкредит", 20_000_000, 15, 700_000),
            debt("Друг", 1_000_000, 0, 100_000),
        ];
        let base = plan(&list, 0, "costly", "2026-11").unwrap();
        let costly = plan(&list, 500_000, "costly", "2026-11").unwrap();
        let small = plan(&list, 500_000, "small", "2026-11").unwrap();
        // Без лишних денег план и обычные платежи совпадают, кроме перекладывания платежей.
        assert!(base.saved >= 0);
        for p in [&costly, &small] {
            assert!(p.saved > 0, "{p:?}");
            assert!(p.free_month < p.base_free_month);
            assert_eq!(p.order.len(), 3);
        }
        // «Сначала дорогие» экономит не меньше, «сначала маленькие» первым закрывает друга.
        assert!(costly.saved >= small.saved);
        assert_eq!(costly.order[0].name, "Кредитка");
        assert_eq!(small.order[0].name, "Друг");
        assert_eq!(costly.interest + costly.saved, costly.base_interest);
    }

    #[test]
    fn payment_below_interest_never_closes_without_extra() {
        let list = [debt("Долг", 10_000_000, 24, 100_000)];
        let p = plan(&list, 0, "costly", "2026-11").unwrap();
        assert_eq!(p.base_free_month, None);
        assert_eq!(p.saved, 0);
        let p = plan(&list, 1_000_000, "costly", "2026-11").unwrap();
        assert!(p.free_month.is_some());
        assert_eq!(p.order[0].base_month, None);
    }

    #[test]
    fn empty_list_is_free_now() {
        let p = plan(&[], 100_000, "small", "2026-11").unwrap();
        assert!(p.order.is_empty());
        assert_eq!(p.interest, 0);
    }
}
