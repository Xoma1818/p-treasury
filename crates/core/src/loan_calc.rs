//! Калькулятор кредита: графики аннуитетного, дифференцированного и разового
//! погашения. Чистые функции без базы данных: ими пользуются и экран
//! калькулятора, и модуль `debts`, поэтому графики всегда совпадают.
//!
//! Месячная ставка `r = R / 12`, где `R` задана в сотых долях процента
//! (`rate_bp`: 1800 = 18 %). Каждая сумма округляется до минимальной единицы
//! («половина — вверх»), последняя строка забирает ошибку округления, чтобы
//! остаток стал ровно 0. Проценты за месяц — `r` от остатка, без учёта числа
//! дней в месяце (упрощение MVP, см. architecture.md).

use chrono::{Datelike, Months, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::Result;

/// Знаменатель месячной ставки: `r = rate_bp / 120 000`.
const MONTH_DEN: i128 = 120_000;
/// Предел суммы (10^14 минимальных единиц), при котором расчёты в i128 не переполняются.
pub const MAX_PRINCIPAL: i64 = 100_000_000_000_000;
/// Масштаб фиксированной точки для `(1 + r)^n`.
const SCALE: i128 = 1_000_000_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repayment {
    Annuity,
    Differentiated,
    Bullet,
}

impl Repayment {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "annuity" => Ok(Self::Annuity),
            "differentiated" => Ok(Self::Differentiated),
            "bullet" => Ok(Self::Bullet),
            _ => invalid(format!("неизвестный вид погашения: {s}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Annuity => "annuity",
            Self::Differentiated => "differentiated",
            Self::Bullet => "bullet",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanInput {
    pub principal: i64,
    pub rate_bp: i64,
    pub repayment: Repayment,
    /// Срок в месяцах для ежемесячных платежей.
    pub term_months: Option<u32>,
    pub issue_date: String,
    /// Первый платёж; по умолчанию через месяц после выдачи. Дальше тот же день каждого месяца.
    pub first_payment_date: Option<String>,
    /// Дата возврата для разового погашения.
    pub maturity_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub seq: u32,
    pub due_date: String,
    pub payment: i64,
    pub principal_part: i64,
    pub interest_part: i64,
    pub balance_after: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub rows: Vec<Row>,
    pub first_payment: i64,
    pub last_payment: i64,
    pub total_payment: i64,
    /// Переплата: сумма процентов.
    pub total_interest: i64,
    pub maturity_date: String,
}

impl Schedule {
    pub fn from_rows(rows: Vec<Row>) -> Self {
        Schedule {
            first_payment: rows.first().map_or(0, |r| r.payment),
            last_payment: rows.last().map_or(0, |r| r.payment),
            total_payment: rows.iter().map(|r| r.payment).sum(),
            total_interest: rows.iter().map(|r| r.interest_part).sum(),
            maturity_date: rows.last().map(|r| r.due_date.clone()).unwrap_or_default(),
            rows,
        }
    }
}

/// `num / den`, округлённое «половина — от нуля». `den > 0`.
fn div_round(num: i128, den: i128) -> i128 {
    if num >= 0 {
        (2 * num + den) / (2 * den)
    } else {
        -((-2 * num + den) / (2 * den))
    }
}

/// Проценты за месяц на остаток.
pub fn month_interest(balance: i64, rate_bp: i64) -> i64 {
    div_round(balance as i128 * rate_bp as i128, MONTH_DEN) as i64
}

/// Аннуитетный платёж `A = P · r / (1 − (1 + r)^−n)`, округлённый до минимальной единицы.
pub fn annuity_payment(principal: i64, rate_bp: i64, n: u32) -> i64 {
    assert!(n > 0, "срок не может быть нулевым");
    if rate_bp == 0 {
        return div_round(principal as i128, n as i128) as i64;
    }
    // A = P · r / (1 − (1 + r)^−n). Считаем g = (1 + r)^−n в фиксированной точке:
    // степень меньше единицы не переполняется при любом сроке.
    let q = MONTH_DEN + rate_bp as i128;
    let mut g = SCALE;
    for _ in 0..n {
        g = div_round(g * MONTH_DEN, q);
    }
    let num = principal as i128 * rate_bp as i128 * SCALE;
    let den = MONTH_DEN * (SCALE - g);
    div_round(num, den) as i64
}

/// Дата `k`-го платежа: `first` плюс `k` месяцев, день как у первого платежа
/// (31-е в коротком месяце становится последним днём).
pub fn due_date(first: NaiveDate, k: u32) -> NaiveDate {
    first
        .checked_add_months(Months::new(k))
        .expect("дата в пределах календаря")
}

pub fn parse_date(s: &str) -> Result<NaiveDate> {
    crate::time::check_date(s)?;
    Ok(NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("проверено"))
}

/// Как строить оставшиеся строки графика.
#[derive(Debug, Clone, Copy)]
pub enum Plan {
    /// Ровно `n` платежей: аннуитет или дифференцированный.
    Count(u32),
    /// Аннуитет с прежним платежом, пока остаток не станет 0 («уменьшить срок»).
    Payment(i64),
    /// Дифференцированный с прежней частью основного долга («уменьшить срок»).
    Principal(i64),
    /// Аннуитет с заданным платежом ровно на `n` строк (последняя добирает остаток).
    Fixed(i64, u32),
}

/// Ежемесячные строки от остатка `balance`, номера с `start_seq`. `first` — дата
/// первого платежа всего графика: строка с номером `s` приходится на `first + (s − 1)` месяцев.
pub fn monthly_rows(
    balance: i64,
    rate_bp: i64,
    repayment: Repayment,
    plan: Plan,
    first: NaiveDate,
    start_seq: u32,
) -> Vec<Row> {
    let rows = rows_once(balance, rate_bp, repayment, plan, first, start_seq);
    let (Plan::Count(n), Repayment::Annuity) = (plan, repayment) else {
        return rows;
    };
    // На длинных кредитах с высокой ставкой округлённый вверх платёж с процентами
    // гасит долг раньше срока. Тогда платёж уменьшается на копейку, пока строк не станет n:
    // срок остаётся тем, что выбрал пользователь, разницу забирает последняя строка.
    let mut a = rows.first().map_or(0, |r| r.payment);
    let mut rows = rows;
    while (rows.len() as u32) < n && a > 0 {
        a -= 1;
        rows = rows_once(
            balance,
            rate_bp,
            repayment,
            Plan::Fixed(a, n),
            first,
            start_seq,
        );
    }
    rows
}

fn rows_once(
    balance: i64,
    rate_bp: i64,
    repayment: Repayment,
    plan: Plan,
    first: NaiveDate,
    start_seq: u32,
) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut left = balance;
    let annuity = match plan {
        Plan::Fixed(a, _) => Some(a),
        Plan::Count(n) if repayment == Repayment::Annuity => {
            Some(annuity_payment(balance, rate_bp, n))
        }
        Plan::Payment(a) => Some(a),
        _ => None,
    };
    let fixed_principal = match plan {
        Plan::Count(n) if repayment != Repayment::Annuity => {
            Some(div_round(balance as i128, n as i128) as i64)
        }
        Plan::Principal(p) => Some(p),
        _ => None,
    };
    let count = match plan {
        Plan::Count(n) | Plan::Fixed(_, n) => n,
        // Защита от платежа, который не покрывает проценты: не больше 100 лет.
        _ => 1200,
    };
    for k in 0..count {
        if left == 0 {
            break;
        }
        let interest = month_interest(left, rate_bp);
        let last = k + 1 == count;
        let mut principal = match (annuity, fixed_principal) {
            (Some(a), _) => a - interest,
            (_, Some(p)) => p,
            _ => unreachable!(),
        };
        if principal <= 0 && matches!(plan, Plan::Payment(_)) {
            // Платёж не покрывает проценты: срок не сократить, остаток гасится последней строкой.
            principal = left;
        }
        if last || principal >= left {
            principal = left;
        }
        let principal = principal.max(0);
        left -= principal;
        rows.push(Row {
            seq: start_seq + k,
            due_date: due_date(first, start_seq - 1 + k).to_string(),
            payment: principal + interest,
            principal_part: principal,
            interest_part: interest,
            balance_after: left,
        });
    }
    rows
}

/// Проценты разового возврата: `P · R · дни / 365`.
pub fn bullet_interest(principal: i64, rate_bp: i64, from: NaiveDate, to: NaiveDate) -> i64 {
    let days = (to - from).num_days().max(0) as i128;
    div_round(principal as i128 * rate_bp as i128 * days, 10_000 * 365) as i64
}

/// График по условиям долга.
pub fn calculate(input: &LoanInput) -> Result<Schedule> {
    if input.principal <= 0 {
        return invalid("сумма должна быть больше нуля");
    }
    if input.principal > MAX_PRINCIPAL {
        return invalid("слишком большая сумма");
    }
    if !(0..=100_000).contains(&input.rate_bp) {
        return invalid("ставка должна быть от 0 до 1000 %");
    }
    let issue = parse_date(&input.issue_date)?;
    if input.repayment == Repayment::Bullet {
        let Some(m) = input.maturity_date.as_deref() else {
            return invalid("укажите дату возврата");
        };
        let maturity = parse_date(m)?;
        if maturity < issue {
            return invalid("дата возврата раньше даты выдачи");
        }
        let interest = bullet_interest(input.principal, input.rate_bp, issue, maturity);
        return Ok(Schedule::from_rows(vec![Row {
            seq: 1,
            due_date: maturity.to_string(),
            payment: input.principal + interest,
            principal_part: input.principal,
            interest_part: interest,
            balance_after: 0,
        }]));
    }
    let n = match input.term_months {
        Some(n) if (1..=600).contains(&n) => n,
        Some(_) => return invalid("срок должен быть от 1 до 600 месяцев"),
        None => return invalid("укажите срок в месяцах"),
    };
    let first = match input.first_payment_date.as_deref() {
        Some(d) => parse_date(d)?,
        None => issue
            .checked_add_months(Months::new(1))
            .expect("дата в пределах календаря"),
    };
    if first <= issue {
        return invalid("первый платёж должен быть позже даты выдачи");
    }
    let rows = monthly_rows(
        input.principal,
        input.rate_bp,
        input.repayment,
        Plan::Count(n),
        first,
        1,
    );
    Ok(Schedule::from_rows(rows))
}

/// Аннуитет и дифференцированный на одних условиях — для сравнения в калькуляторе.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub annuity: Schedule,
    pub differentiated: Schedule,
}

pub fn compare(input: &LoanInput) -> Result<Comparison> {
    let mut a = input.clone();
    a.repayment = Repayment::Annuity;
    let mut d = input.clone();
    d.repayment = Repayment::Differentiated;
    Ok(Comparison {
        annuity: calculate(&a)?,
        differentiated: calculate(&d)?,
    })
}

/// День месяца первого платежа (для подписи «каждое 15-е число»).
pub fn payment_day(first: NaiveDate) -> u32 {
    first.day()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn input(principal: i64, rate_bp: i64, n: u32, repayment: Repayment) -> LoanInput {
        LoanInput {
            principal,
            rate_bp,
            repayment,
            term_months: Some(n),
            issue_date: "2026-10-15".into(),
            first_payment_date: None,
            maturity_date: None,
        }
    }

    #[test]
    fn control_example_from_the_plan() {
        // 300 000 ₽, 18 %, 24 месяца.
        let a = calculate(&input(30_000_000, 1800, 24, Repayment::Annuity)).unwrap();
        assert_eq!(a.first_payment, 1_497_723);
        assert_eq!(a.rows.len(), 24);
        assert_eq!(a.rows[0].interest_part, 450_000);
        assert_eq!(a.rows[0].principal_part, 1_047_723);
        assert_eq!(a.rows[0].due_date, "2026-11-15");
        assert_eq!(a.rows[23].due_date, "2028-10-15");
        assert_eq!(a.rows[23].balance_after, 0);
        // Переплата ≈ 59 453 ₽.
        assert!(
            (5_945_300..5_945_400).contains(&a.total_interest),
            "{}",
            a.total_interest
        );
        assert_eq!(a.total_payment, 30_000_000 + a.total_interest);

        let d = calculate(&input(30_000_000, 1800, 24, Repayment::Differentiated)).unwrap();
        assert_eq!(d.total_interest, 5_625_000);
        assert_eq!(d.first_payment, 1_250_000 + 450_000);
        assert_eq!(d.last_payment, 1_250_000 + 18_750);
        assert!(d.total_interest < a.total_interest && d.first_payment > a.first_payment);
    }

    #[test]
    fn zero_rate_is_the_same_for_both() {
        let a = calculate(&input(10_000_000, 0, 3, Repayment::Annuity)).unwrap();
        let d = calculate(&input(10_000_000, 0, 3, Repayment::Differentiated)).unwrap();
        let pays: Vec<_> = a.rows.iter().map(|r| r.payment).collect();
        assert_eq!(pays, [3_333_333, 3_333_333, 3_333_334]);
        assert_eq!(a.rows, d.rows);
        assert_eq!(a.total_interest, 0);
    }

    #[test]
    fn bullet_with_and_without_interest() {
        let mut i = input(2_000_000, 0, 1, Repayment::Bullet);
        i.term_months = None;
        i.maturity_date = Some("2027-03-01".into());
        let s = calculate(&i).unwrap();
        assert_eq!(s.rows.len(), 1);
        assert_eq!(
            (s.rows[0].payment, s.rows[0].due_date.as_str()),
            (2_000_000, "2027-03-01")
        );
        // 100 000 ₽ под 10 % на 365 дней = 10 000 ₽.
        let mut i = input(10_000_000, 1000, 1, Repayment::Bullet);
        i.issue_date = "2026-01-01".into();
        i.maturity_date = Some("2027-01-01".into());
        assert_eq!(calculate(&i).unwrap().total_interest, 1_000_000);
        i.maturity_date = Some("2025-01-01".into());
        assert!(calculate(&i).is_err());
    }

    #[test]
    fn end_of_month_dates() {
        let mut i = input(1_200_000, 1200, 4, Repayment::Annuity);
        i.issue_date = "2027-12-31".into();
        i.first_payment_date = Some("2028-01-31".into());
        let dates: Vec<_> = calculate(&i)
            .unwrap()
            .rows
            .into_iter()
            .map(|r| r.due_date)
            .collect();
        assert_eq!(
            dates,
            ["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]
        );
    }

    #[test]
    fn long_high_rate_loan_keeps_its_term() {
        // Найдено тестом свойств: округлённый платёж с процентами за 29 лет гасил долг на месяц раньше.
        let s = calculate(&input(4_785_987, 3445, 349, Repayment::Annuity)).unwrap();
        assert_eq!(s.rows.len(), 349);
        assert_eq!(s.rows.last().unwrap().balance_after, 0);
    }

    #[test]
    fn invalid_input() {
        assert!(calculate(&input(0, 1800, 24, Repayment::Annuity)).is_err());
        assert!(calculate(&input(MAX_PRINCIPAL + 1, 1800, 24, Repayment::Annuity)).is_err());
        assert!(calculate(&input(MAX_PRINCIPAL, 100_000, 600, Repayment::Annuity)).is_ok());
        assert!(calculate(&input(100, -1, 24, Repayment::Annuity)).is_err());
        assert!(calculate(&input(100, 1800, 0, Repayment::Annuity)).is_err());
        let mut i = input(100, 1800, 12, Repayment::Annuity);
        i.first_payment_date = Some("2026-10-01".into());
        assert!(calculate(&i).is_err(), "первый платёж раньше выдачи");
    }

    #[test]
    fn reduce_term_with_the_same_payment() {
        // После досрочного платежа остаток 100 000 при платеже 14 977,23: срок короче, последний платёж меньше.
        let first = NaiveDate::from_ymd_opt(2027, 1, 15).unwrap();
        let rows = monthly_rows(
            10_000_000,
            1800,
            Repayment::Annuity,
            Plan::Payment(1_497_723),
            first,
            5,
        );
        assert_eq!(rows[0].seq, 5);
        assert_eq!(rows.len(), 8);
        assert!(rows.iter().rev().skip(1).all(|r| r.payment == 1_497_723));
        assert!(rows.last().unwrap().payment < 1_497_723);
        assert_eq!(rows.last().unwrap().balance_after, 0);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        #[test]
        fn schedules_add_up(
            principal in 1_000i64..10_000_000_000,
            rate_bp in 0i64..5000,
            n in 1u32..360,
            diff in any::<bool>(),
        ) {
            let kind = if diff { Repayment::Differentiated } else { Repayment::Annuity };
            let s = calculate(&input(principal, rate_bp, n, kind)).unwrap();
            prop_assert_eq!(s.rows.len() as u32, n);
            prop_assert_eq!(s.rows.iter().map(|r| r.principal_part).sum::<i64>(), principal);
            prop_assert_eq!(s.total_payment, principal + s.total_interest);
            prop_assert_eq!(s.rows.last().unwrap().balance_after, 0);
            for r in &s.rows {
                prop_assert_eq!(r.payment, r.principal_part + r.interest_part);
                prop_assert!(r.principal_part >= 0 && r.interest_part >= 0);
            }
            if !diff {
                // Все платежи, кроме последнего, равны; последний отличается не больше чем на округление.
                let a = s.first_payment;
                prop_assert!(s.rows.iter().rev().skip(1).all(|r| r.payment == a));
                // Ошибка округления платежа копится с процентами: не больше n · (1 + r)^n.
                let r = rate_bp as f64 / 120_000.0;
                prop_assert!(((s.last_payment - a).abs() as f64) <= n as f64 * (1.0 + r).powi(n as i32) + 1.0);
            }
        }

        #[test]
        fn annuity_payment_matches_float_formula(principal in 100_000i64..100_000_000_000, rate_bp in 1i64..5000, n in 1u32..360) {
            let r = rate_bp as f64 / 120_000.0;
            let exact = principal as f64 * r / (1.0 - (1.0 + r).powi(-(n as i32)));
            prop_assert!((annuity_payment(principal, rate_bp, n) as f64 - exact).abs() <= 1.0);
        }
    }
}
