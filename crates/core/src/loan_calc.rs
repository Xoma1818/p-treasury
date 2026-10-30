//! Расчётный движок займов: калькулятор, график займа, прогноз и выгрузка
//! считаются одной функцией [`simulate`]. Чистые функции без базы данных.
//!
//! Ставка `R` задана в сотых долях процента (`rate_bp`: 1800 = 18 %).
//! Каждая сумма округляется до минимальной единицы («половина — вверх»),
//! последняя строка забирает ошибку округления, чтобы остаток стал ровно 0.
//!
//! Проценты считаются двумя способами ([`InterestMethod`]):
//! - `monthly` — `остаток × R / 12` за период, без учёта числа дней (как в 0.15);
//! - `daily` — по фактическим дням: `остаток × R × дни / дней в году`, отрезок
//!   через 1 января делится по годам (365/366), сумма за период округляется один раз.
//!
//! Ставку можно задать за год, месяц или день ([`RatePeriod`]). Внутри движка
//! она всегда годовая (`rate_bp`): месячная × 12, дневная × 365. У дневной ставки
//! проценты по дням считаются на базе 365 дней в любом году, поэтому
//! «0,5 % в день» даёт ровно `остаток × 0,5 % × дни`.
//!
//! Аннуитетный платёж для обоих способов — по формуле с `r = R / 12`
//! ([`annuity_payment`]); при `daily` основная часть равна платежу минус
//! проценты за фактические дни, последняя строка добирает остаток.

use chrono::{Datelike, Months, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::Result;

/// Знаменатель месячной ставки: `r = rate_bp / 120 000`.
const MONTH_DEN: i128 = 120_000;
/// Общий знаменатель дневных процентов: `10 000 × 365 × 366`.
const DAY_DEN: i128 = 10_000 * 365 * 366;
/// Предел суммы (10^14 минимальных единиц), при котором расчёты в i128 не переполняются.
pub const MAX_PRINCIPAL: i64 = 100_000_000_000_000;
/// Самый длинный срок в месяцах.
pub const MAX_TERM: u32 = 600;
/// Масштаб фиксированной точки для `(1 + r)^n`.
const SCALE: i128 = 1_000_000_000_000_000_000;
/// Защита от бесконечного графика (платёж не покрывает проценты): не больше 100 лет.
const MAX_ROWS: u32 = 1200;

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

    /// Название для людей (выгрузка).
    pub fn title(self) -> &'static str {
        match self {
            Self::Annuity => "аннуитетный",
            Self::Differentiated => "дифференцированный",
            Self::Bullet => "разовый возврат",
        }
    }
}

/// Как начисляются проценты.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterestMethod {
    /// Ставка ÷ 12 за каждый период (как в 0.15 и раньше).
    #[default]
    Monthly,
    /// По фактическим дням, как в банке.
    Daily,
}

impl InterestMethod {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "monthly" => Ok(Self::Monthly),
            "daily" => Ok(Self::Daily),
            _ => invalid(format!("неизвестный способ начисления процентов: {s}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Monthly => "monthly",
            Self::Daily => "daily",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Monthly => "по месяцам (ставка ÷ 12)",
            Self::Daily => "по дням",
        }
    }
}

/// За какой период задана ставка.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RatePeriod {
    #[default]
    Year,
    Month,
    Day,
}

impl RatePeriod {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "year" => Ok(Self::Year),
            "month" => Ok(Self::Month),
            "day" => Ok(Self::Day),
            _ => invalid(format!("неизвестный период ставки: {s}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Year => "year",
            Self::Month => "month",
            Self::Day => "day",
        }
    }

    /// Сколько периодов в году: годовая ставка = ставка за период × столько.
    pub fn per_year(self) -> i64 {
        match self {
            Self::Year => 1,
            Self::Month => 12,
            Self::Day => 365,
        }
    }

    /// «годовых», «в месяц», «в день».
    pub fn suffix(self) -> &'static str {
        match self {
            Self::Year => "годовых",
            Self::Month => "в месяц",
            Self::Day => "в день",
        }
    }
}

/// Как часто платить по графику. Срок (`term_months`) у займа — число платежей:
/// для ежемесячных это месяцы.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayEvery {
    #[default]
    Month,
    Quarter,
    TwoWeeks,
}

impl PayEvery {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "month" => Ok(Self::Month),
            "quarter" => Ok(Self::Quarter),
            "two_weeks" => Ok(Self::TwoWeeks),
            _ => invalid(format!("неизвестная периодичность платежей: {s}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Month => "month",
            Self::Quarter => "quarter",
            Self::TwoWeeks => "two_weeks",
        }
    }

    /// Платежей в году: ставка за период платежа = годовая ÷ столько.
    pub fn per_year(self) -> i64 {
        match self {
            Self::Month => 12,
            Self::Quarter => 4,
            Self::TwoWeeks => 26,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Month => "каждый месяц",
            Self::Quarter => "раз в квартал",
            Self::TwoWeeks => "раз в две недели",
        }
    }

    /// Дата `k`-го платежа после `first`.
    pub fn nth(self, first: NaiveDate, k: u32) -> NaiveDate {
        match self {
            Self::Month => due_date(first, k),
            Self::Quarter => due_date(first, 3 * k),
            Self::TwoWeeks => first + chrono::Days::new(14 * k as u64),
        }
    }
}

/// Как пересчитать график после досрочного или неполного платежа.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Recalc {
    /// Срок прежний, платёж меньше.
    #[default]
    ReducePayment,
    /// Платёж прежний, строк меньше.
    ReduceTerm,
}

impl Recalc {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "reduce_payment" => Ok(Self::ReducePayment),
            "reduce_term" => Ok(Self::ReduceTerm),
            _ => invalid(format!("неизвестный способ пересчёта: {s}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReducePayment => "reduce_payment",
            Self::ReduceTerm => "reduce_term",
        }
    }
}

/// Вид кредитных каникул.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HolidayKind {
    /// В строках каникул платятся только проценты, срок удлиняется.
    InterestOnly,
    /// Платежи сдвигаются, проценты за паузу входят в первый платёж после неё.
    Shift,
}

impl HolidayKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "interest_only" => Ok(Self::InterestOnly),
            "shift" => Ok(Self::Shift),
            _ => invalid(format!("неизвестный вид каникул: {s}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::InterestOnly => "interest_only",
            Self::Shift => "shift",
        }
    }
}

/// Как часто повторяется плановая досрочка.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Frequency {
    Once,
    Monthly,
    Quarterly,
    Yearly,
}

impl Frequency {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "once" => Ok(Self::Once),
            "monthly" => Ok(Self::Monthly),
            "quarterly" => Ok(Self::Quarterly),
            "yearly" => Ok(Self::Yearly),
            _ => invalid(format!("неизвестная периодичность: {s}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Monthly => "monthly",
            Self::Quarterly => "quarterly",
            Self::Yearly => "yearly",
        }
    }

    fn step_months(self) -> Option<u32> {
        match self {
            Self::Once => None,
            Self::Monthly => Some(1),
            Self::Quarterly => Some(3),
            Self::Yearly => Some(12),
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
    /// Способ начисления процентов; по умолчанию `monthly`, как раньше.
    #[serde(default)]
    pub interest_method: InterestMethod,
    /// За какой период человек ввёл ставку; `rate_bp` всё равно годовая.
    #[serde(default)]
    pub rate_period: RatePeriod,
    /// Как часто платить; `term_months` тогда — число платежей.
    #[serde(default)]
    pub pay_every: PayEvery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    period_interest(balance, rate_bp, 12)
}

/// Проценты за один из `per_year` периодов года: `остаток × R / per_year`.
pub fn period_interest(balance: i64, rate_bp: i64, per_year: i64) -> i64 {
    div_round(
        balance as i128 * rate_bp as i128,
        MONTH_DEN / 12 * per_year as i128,
    ) as i64
}

/// Аннуитетный платёж `A = P · r / (1 − (1 + r)^−n)`, округлённый до минимальной единицы.
pub fn annuity_payment(principal: i64, rate_bp: i64, n: u32) -> i64 {
    annuity_payment_per(principal, rate_bp, n, 12)
}

/// Аннуитет при `per_year` платежах в году: `r = R / per_year`.
pub fn annuity_payment_per(principal: i64, rate_bp: i64, n: u32, per_year: i64) -> i64 {
    assert!(n > 0, "срок не может быть нулевым");
    if rate_bp == 0 {
        return div_round(principal as i128, n as i128) as i64;
    }
    // A = P · r / (1 − (1 + r)^−n). Считаем g = (1 + r)^−n в фиксированной точке:
    // степень меньше единицы не переполняется при любом сроке.
    let den_r = MONTH_DEN / 12 * per_year as i128;
    let q = den_r + rate_bp as i128;
    let mut g = SCALE;
    for _ in 0..n {
        g = div_round(g * den_r, q);
    }
    let num = principal as i128 * rate_bp as i128 * SCALE;
    let den = den_r * (SCALE - g);
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

fn days_in_year(year: i32) -> i128 {
    if NaiveDate::from_ymd_opt(year, 2, 29).is_some() {
        366
    } else {
        365
    }
}

/// Проценты разового возврата: `P · R · дни / 365`.
pub fn bullet_interest(principal: i64, rate_bp: i64, from: NaiveDate, to: NaiveDate) -> i64 {
    let days = (to - from).num_days().max(0) as i128;
    div_round(principal as i128 * rate_bp as i128 * days, 10_000 * 365) as i64
}

// --- Условия и события ---

/// Условия займа для движка.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub principal: i64,
    pub issue: NaiveDate,
    /// Дата первого платежа; у разового возврата — дата возврата.
    pub first: NaiveDate,
    /// Срок в месяцах; у разового возврата 1.
    pub n: u32,
    pub repayment: Repayment,
    pub rate_bp: i64,
    pub method: InterestMethod,
    pub rate_period: RatePeriod,
    pub every: PayEvery,
}

impl Terms {
    /// Проверить условия и привести их к виду движка.
    pub fn from_input(input: &LoanInput) -> Result<Terms> {
        if input.principal <= 0 {
            return invalid("сумма должна быть больше нуля");
        }
        if input.principal > MAX_PRINCIPAL {
            return invalid("слишком большая сумма");
        }
        check_rate(input.rate_bp)?;
        let issue = parse_date(&input.issue_date)?;
        let base = Terms {
            principal: input.principal,
            issue,
            first: issue,
            n: 1,
            repayment: input.repayment,
            rate_bp: input.rate_bp,
            method: input.interest_method,
            rate_period: input.rate_period,
            every: input.pay_every,
        };
        if input.repayment == Repayment::Bullet {
            let Some(m) = input.maturity_date.as_deref() else {
                return invalid("укажите дату возврата");
            };
            let maturity = parse_date(m)?;
            if maturity < issue {
                return invalid("дата возврата раньше даты выдачи");
            }
            return Ok(Terms {
                first: maturity,
                ..base
            });
        }
        let n = match input.term_months {
            Some(n) if (1..=MAX_TERM).contains(&n) => n,
            Some(_) if input.pay_every == PayEvery::Month => {
                return invalid("срок должен быть от 1 до 600 месяцев")
            }
            Some(_) => return invalid("платежей должно быть от 1 до 600"),
            None => return invalid("укажите срок"),
        };
        let first = match input.first_payment_date.as_deref() {
            Some(d) => parse_date(d)?,
            None => input.pay_every.nth(issue, 1),
        };
        if first <= issue {
            return invalid("первый платёж должен быть позже даты выдачи");
        }
        Ok(Terms { first, n, ..base })
    }
}

/// Наибольшая годовая ставка: 1000 %.
pub const MAX_RATE: i64 = 100_000;

pub fn check_rate(rate_bp: i64) -> Result<()> {
    if !(0..=MAX_RATE).contains(&rate_bp) {
        return invalid("ставка должна быть от 0 до 1000 %");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateChange {
    pub from: NaiveDate,
    pub rate_bp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Holiday {
    pub from_seq: u32,
    pub months: u32,
    pub kind: HolidayKind,
}

/// Фактический платёж.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payment {
    pub date: NaiveDate,
    pub principal: i64,
    pub interest: i64,
    /// Строка графика, которую закрывает платёж; `None` — досрочный.
    pub seq: Option<u32>,
    pub mode: Recalc,
}

/// Событие графика. Платежи применяются в переданном порядке (по дате);
/// ставки и каникулы действуют на весь график; плановые досрочки и свои суммы строк —
/// после всех платежей, вместе и по порядку дат.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Payment(Payment),
    RateChange(RateChange),
    Holiday(Holiday),
    PlannedEarly {
        date: NaiveDate,
        amount: i64,
        mode: Recalc,
    },
    /// Своя сумма строки графика `seq` (договорились платить больше или меньше);
    /// следующие строки пересчитываются по `mode`.
    RowAmount {
        seq: u32,
        amount: i64,
        mode: Recalc,
    },
}

/// Своя сумма платежа в строке графика.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowAmountInput {
    pub seq: u32,
    pub amount: i64,
    /// `reduce_payment` или `reduce_term`.
    pub mode: String,
}

impl RowAmountInput {
    pub fn parse(&self) -> Result<Event> {
        if self.seq < 1 {
            return invalid("номер платежа начинается с 1");
        }
        if !(0..=MAX_PRINCIPAL).contains(&self.amount) {
            return invalid("проверьте сумму платежа");
        }
        Ok(Event::RowAmount {
            seq: self.seq,
            amount: self.amount,
            mode: Recalc::parse(&self.mode)?,
        })
    }
}

/// Плановое досрочное погашение (разовое или регулярное).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedEarlyInput {
    pub amount: i64,
    pub start_date: String,
    /// `once`, `monthly`, `quarterly`, `yearly`.
    pub frequency: String,
    pub end_date: Option<String>,
    /// `reduce_payment` или `reduce_term`.
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateChangeInput {
    /// С какой даты действует ставка.
    pub from: String,
    pub rate_bp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayInput {
    pub from_seq: u32,
    pub months: u32,
    /// `interest_only` или `shift`.
    pub kind: String,
}

impl RateChangeInput {
    pub fn parse(&self) -> Result<RateChange> {
        check_rate(self.rate_bp)?;
        Ok(RateChange {
            from: parse_date(&self.from)?,
            rate_bp: self.rate_bp,
        })
    }
}

impl HolidayInput {
    pub fn parse(&self) -> Result<Holiday> {
        if self.from_seq < 1 {
            return invalid("каникулы начинаются с платежа №1 или позже");
        }
        if !(1..=12).contains(&self.months) {
            return invalid("каникулы длятся от 1 до 12 месяцев");
        }
        Ok(Holiday {
            from_seq: self.from_seq,
            months: self.months,
            kind: HolidayKind::parse(&self.kind)?,
        })
    }
}

impl PlannedEarlyInput {
    /// Проверить запись плановой досрочки.
    pub fn check(&self) -> Result<(NaiveDate, Frequency, Option<NaiveDate>, Recalc)> {
        if self.amount <= 0 {
            return invalid("сумма досрочного погашения должна быть больше нуля");
        }
        if self.amount > MAX_PRINCIPAL {
            return invalid("слишком большая сумма");
        }
        let start = parse_date(&self.start_date)?;
        let freq = Frequency::parse(&self.frequency)?;
        let end = self.end_date.as_deref().map(parse_date).transpose()?;
        if end.is_some_and(|e| e < start) {
            return invalid("дата окончания досрочек раньше даты начала");
        }
        Ok((start, freq, end, Recalc::parse(&self.mode)?))
    }
}

/// Развернуть плановые досрочки в события с датами в `[from, until]`.
pub fn expand_planned(
    list: &[PlannedEarlyInput],
    from: NaiveDate,
    until: NaiveDate,
) -> Result<Vec<Event>> {
    let mut out = Vec::new();
    for p in list {
        let (start, freq, end, mode) = p.check()?;
        let last = end.map_or(until, |e| e.min(until));
        let mut k = 0u32;
        loop {
            let date = match freq.step_months() {
                None if k > 0 => break,
                None => start,
                Some(step) => match start.checked_add_months(Months::new(step * k)) {
                    Some(d) => d,
                    None => break,
                },
            };
            if date > last || k >= MAX_ROWS {
                break;
            }
            if date >= from {
                out.push(Event::PlannedEarly {
                    date,
                    amount: p.amount,
                    mode,
                });
            }
            k += 1;
        }
    }
    out.sort_by_key(|e| match e {
        Event::PlannedEarly { date, .. } => *date,
        _ => from,
    });
    Ok(out)
}

// --- Результат расчёта ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Paid,
    Partial,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Paid => "paid",
            Self::Partial => "partial",
        }
    }
}

/// Особая строка графика.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowKind {
    Regular,
    /// Каникулы: только проценты.
    InterestOnly,
    /// Первый платёж после сдвига: в нём проценты за паузу.
    AfterShift,
}

/// Строка графика с отметкой оплаты.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimRow {
    #[serde(flatten)]
    pub row: Row,
    pub status: Status,
    pub kind: RowKind,
    /// Аннуитетный платёж, по которому построена строка (для «уменьшить срок»).
    #[serde(skip)]
    annuity: Option<i64>,
    /// Основная часть дифференцированного платежа.
    #[serde(skip)]
    principal_plan: Option<i64>,
}

/// Досрочный платёж (фактический или плановый) — не строка графика.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarlyRow {
    pub date: String,
    pub principal: i64,
    pub interest: i64,
    pub balance_after: i64,
    /// Плановая досрочка из прогноза или калькулятора.
    pub planned: bool,
}

/// Итоги графика.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Ближайший неоплаченный платёж (0 — долг закрыт).
    pub payment: i64,
    /// Все проценты: уплаченные и предстоящие.
    pub total_interest: i64,
    /// Все выплаты: основной долг и проценты.
    pub total_payment: i64,
    pub maturity_date: String,
    pub rows_left: u32,
    /// Предстоящие проценты.
    pub interest_left: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sim {
    pub rows: Vec<SimRow>,
    pub early: Vec<EarlyRow>,
    /// Остаток после фактических платежей.
    pub outstanding: i64,
    pub principal_paid: i64,
    pub interest_paid: i64,
}

impl Sim {
    pub fn totals(&self) -> Totals {
        let pending = || self.rows.iter().filter(|r| r.status == Status::Pending);
        let planned = || self.early.iter().filter(|e| e.planned);
        let interest_left = pending().map(|r| r.row.interest_part).sum::<i64>()
            + planned().map(|e| e.interest).sum::<i64>();
        let left_payments = pending().map(|r| r.row.payment).sum::<i64>()
            + planned().map(|e| e.principal + e.interest).sum::<i64>();
        Totals {
            payment: pending().next().map_or(0, |r| r.row.payment),
            total_interest: self.interest_paid + interest_left,
            total_payment: self.principal_paid + self.interest_paid + left_payments,
            maturity_date: self
                .rows
                .last()
                .map(|r| r.row.due_date.clone())
                .unwrap_or_default(),
            rows_left: pending().count() as u32,
            interest_left,
        }
    }

    /// Строки графика без отметок.
    pub fn plain_rows(&self) -> Vec<Row> {
        self.rows.iter().map(|r| r.row.clone()).collect()
    }
}

// --- Движок ---

/// Как строить оставшиеся строки графика.
#[derive(Debug, Clone, Copy)]
enum Plan {
    /// Ровно `n` платежей (без строк каникул «только проценты»).
    Count(u32),
    /// Аннуитет с прежним платежом, пока остаток не станет 0 («уменьшить срок»).
    Payment(i64),
    /// Дифференцированный с прежней частью основного долга («уменьшить срок»).
    Principal(i64),
    /// Аннуитет с заданным платежом ровно на `n` строк (последняя добирает остаток).
    Fixed(i64, u32),
}

/// Начисление внутри периода после досрочки: с какой даты считать,
/// сколько процентов уже накоплено и не уплачено, какой остаток.
#[derive(Debug, Clone, Copy)]
struct Accrual {
    index: usize,
    start: NaiveDate,
    carry: i64,
    balance: i64,
}

struct Ctx<'a> {
    t: &'a Terms,
    rates: Vec<RateChange>,
    holidays: Vec<Holiday>,
}

impl<'a> Ctx<'a> {
    fn new(t: &'a Terms, events: &[Event]) -> Self {
        let mut rates: Vec<RateChange> = events
            .iter()
            .filter_map(|e| match e {
                Event::RateChange(r) => Some(*r),
                _ => None,
            })
            .collect();
        rates.sort_by_key(|r| r.from);
        let mut holidays: Vec<Holiday> = events
            .iter()
            .filter_map(|e| match e {
                // Каникулы считаются в месяцах: только у ежемесячных платежей.
                Event::Holiday(h) if t.every == PayEvery::Month => Some(*h),
                _ => None,
            })
            .collect();
        holidays.sort_by_key(|h| h.from_seq);
        Ctx { t, rates, holidays }
    }

    fn rate_at(&self, d: NaiveDate) -> i64 {
        self.rates
            .iter()
            .rev()
            .find(|r| r.from <= d)
            .map_or(self.t.rate_bp, |r| r.rate_bp)
    }

    fn shift_before(&self, seq: u32) -> u32 {
        self.holidays
            .iter()
            .filter(|h| h.kind == HolidayKind::Shift && h.from_seq <= seq)
            .map(|h| h.months)
            .sum()
    }

    /// Пауза перед строкой `seq` (каникулы со сдвигом, начинающиеся с неё).
    fn pause(&self, seq: u32) -> u32 {
        self.holidays
            .iter()
            .filter(|h| h.kind == HolidayKind::Shift && h.from_seq == seq)
            .map(|h| h.months)
            .sum()
    }

    fn interest_only(&self, seq: u32) -> bool {
        self.holidays.iter().any(|h| {
            h.kind == HolidayKind::InterestOnly && h.from_seq <= seq && seq < h.from_seq + h.months
        })
    }

    fn due(&self, seq: u32) -> NaiveDate {
        self.t
            .every
            .nth(self.t.first, seq - 1 + self.shift_before(seq))
    }

    fn period_start(&self, seq: u32) -> NaiveDate {
        if seq <= 1 {
            self.t.issue
        } else {
            self.due(seq - 1)
        }
    }

    /// Проценты по дням за `[from, to)`: отрезки делятся по годам и датам смены
    /// ставки, сумма округляется один раз.
    fn daily(&self, balance: i64, from: NaiveDate, to: NaiveDate) -> i64 {
        if to <= from || balance == 0 {
            return 0;
        }
        let mut num: i128 = 0;
        let mut a = from;
        while a < to {
            let new_year = NaiveDate::from_ymd_opt(a.year() + 1, 1, 1).expect("дата");
            let next_rate = self
                .rates
                .iter()
                .map(|r| r.from)
                .find(|&d| d > a)
                .unwrap_or(to);
            let b = to.min(new_year).min(next_rate);
            let days = (b - a).num_days() as i128;
            // Дневная ставка: база 365 в любом году (× 366 / (365 × 366) = 1 / 365).
            let other = if self.t.rate_period == RatePeriod::Day {
                366
            } else if days_in_year(a.year()) == 366 {
                365
            } else {
                366
            };
            num += balance as i128 * self.rate_at(a) as i128 * days * other;
            a = b;
        }
        div_round(num, DAY_DEN) as i64
    }

    /// Проценты строки `seq`: полные и «обычные» (за один период), по которым
    /// считается основная часть аннуитета.
    fn row_interest(&self, balance: i64, seq: u32, acc: Option<Accrual>) -> (i64, i64) {
        match self.t.method {
            InterestMethod::Monthly => {
                let start = self.period_start(seq);
                let per_year = self.t.every.per_year();
                let normal = period_interest(balance, self.rate_at(start), per_year);
                let mut full = normal;
                for j in 1..=self.pause(seq) {
                    let d = start.checked_add_months(Months::new(j)).unwrap_or(start);
                    full += period_interest(balance, self.rate_at(d), per_year);
                }
                (full, normal)
            }
            InterestMethod::Daily => {
                let due = self.due(seq);
                let (start, carry) =
                    acc.map_or((self.period_start(seq), 0), |a| (a.start, a.carry));
                let full = carry + self.daily(balance, start, due);
                let normal = if self.pause(seq) > 0 {
                    let month_ago = due.checked_sub_months(Months::new(1)).unwrap_or(due);
                    self.daily(balance, start.max(month_ago), due)
                } else {
                    full
                };
                (full, normal)
            }
        }
    }

    /// Есть ли смена ставки в `[due(seq − 1), due(seq))`: тогда с этой строки
    /// аннуитет пересчитывается.
    fn rate_changes_before(&self, seq: u32) -> bool {
        let (a, b) = (self.due(seq - 1), self.due(seq));
        self.rates.iter().any(|r| a <= r.from && r.from < b)
    }

    /// Строки от остатка `balance`, номера с `start_seq`.
    fn gen(&self, balance: i64, plan: Plan, start_seq: u32, acc: Option<Accrual>) -> Vec<SimRow> {
        let rows = self.rows_once(balance, plan, start_seq, acc);
        let (Plan::Count(n), Repayment::Annuity) = (plan, self.t.repayment) else {
            return rows;
        };
        if amortizing(&rows) >= n {
            return rows;
        }
        // На длинных кредитах с высокой ставкой округлённый вверх платёж с процентами
        // гасит долг раньше срока. Тогда платёж уменьшается, пока строк не станет n:
        // срок остаётся тем, что выбрал пользователь, разницу забирает последняя строка.
        // Ищется наибольший платёж меньше исходного, при котором строк ровно n.
        let a = rows.first().and_then(|r| r.annuity).unwrap_or(0);
        if a <= 0 {
            return rows;
        }
        let try_rows = |p: i64| self.rows_once(balance, Plan::Fixed(p, n), start_seq, acc);
        let (mut lo, mut hi) = (0i64, a - 1);
        let top = try_rows(hi);
        if amortizing(&top) >= n {
            return top;
        }
        // Инвариант: при lo строк хватает (или lo = 0), при hi — нет.
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if amortizing(&try_rows(mid)) >= n {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        try_rows(lo)
    }

    fn rows_once(
        &self,
        balance: i64,
        plan: Plan,
        start_seq: u32,
        acc: Option<Accrual>,
    ) -> Vec<SimRow> {
        let t = self.t;
        let is_annuity = t.repayment == Repayment::Annuity;
        let mut out = Vec::new();
        let mut left = balance;
        let annuity = match plan {
            Plan::Fixed(a, _) | Plan::Payment(a) => Some(a),
            Plan::Count(n) if is_annuity => Some(annuity_payment_per(
                balance,
                self.rate_at(self.due(start_seq)),
                n,
                t.every.per_year(),
            )),
            _ => None,
        };
        let fixed_principal = match plan {
            Plan::Count(n) if !is_annuity => Some(div_round(balance as i128, n as i128) as i64),
            Plan::Principal(p) => Some(p),
            _ => None,
        };
        let count = match plan {
            Plan::Count(n) | Plan::Fixed(_, n) => n,
            _ => MAX_ROWS,
        };
        let mut acc = acc;
        let mut seq = start_seq;
        let mut k = 0;
        while k < count {
            if left == 0 {
                break;
            }
            if is_annuity && seq > start_seq && self.rate_changes_before(seq) {
                // Новая ставка: аннуитет пересчитывается на оставшиеся строки, срок прежний.
                let remaining = match plan {
                    Plan::Payment(a) => {
                        rows_needed(left, self.rate_at(self.due(seq - 1)), a, t.every.per_year())
                            .min(MAX_ROWS - k)
                    }
                    _ => count - k,
                };
                out.extend(self.gen(left, Plan::Count(remaining.max(1)), seq, None));
                return out;
            }
            if self.interest_only(seq) {
                let (full, _) = self.row_interest(left, seq, acc.take());
                out.push(SimRow {
                    row: Row {
                        seq,
                        due_date: self.due(seq).to_string(),
                        payment: full,
                        principal_part: 0,
                        interest_part: full,
                        balance_after: left,
                    },
                    status: Status::Pending,
                    kind: RowKind::InterestOnly,
                    annuity,
                    principal_plan: fixed_principal,
                });
                seq += 1;
                continue;
            }
            let (interest, normal) = self.row_interest(left, seq, acc.take());
            let last = k + 1 == count;
            let mut principal = match (annuity, fixed_principal) {
                (Some(a), _) => a - normal,
                (_, Some(p)) => p,
                _ => unreachable!("план задаёт платёж или основную часть"),
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
            out.push(SimRow {
                row: Row {
                    seq,
                    due_date: self.due(seq).to_string(),
                    payment: principal + interest,
                    principal_part: principal,
                    interest_part: interest,
                    balance_after: left,
                },
                status: Status::Pending,
                kind: if self.pause(seq) > 0 {
                    RowKind::AfterShift
                } else {
                    RowKind::Regular
                },
                annuity,
                principal_plan: fixed_principal,
            });
            seq += 1;
            k += 1;
        }
        out
    }

    /// Пересчитать строки начиная с `from` от остатка `left`.
    fn recalc(
        &self,
        lines: &mut Vec<SimRow>,
        from: usize,
        left: i64,
        mode: Recalc,
        acc: Option<Accrual>,
    ) {
        let tail = &lines[from.min(lines.len())..];
        let count = amortizing(tail);
        let start_seq = lines
            .get(from)
            .map_or_else(|| lines.last().map_or(1, |l| l.row.seq + 1), |l| l.row.seq);
        let plain =
            |l: &SimRow| self.t.method == InterestMethod::Monthly && l.kind == RowKind::Regular;
        let plan = match (mode, tail.first()) {
            (Recalc::ReduceTerm, Some(l)) if self.t.repayment == Repayment::Annuity => {
                Plan::Payment(if plain(l) {
                    l.row.payment
                } else {
                    l.annuity.unwrap_or(l.row.payment)
                })
            }
            (Recalc::ReduceTerm, Some(l)) => Plan::Principal(if plain(l) {
                l.row.principal_part
            } else {
                l.principal_plan.unwrap_or(l.row.principal_part)
            }),
            // Платёж меньше графика на последней строке: остаток переносится на месяц позже.
            _ => Plan::Count(count.max(1)),
        };
        lines.truncate(from);
        if left > 0 {
            let acc = acc.filter(|a| a.index == from);
            lines.extend(self.gen(left, plan, start_seq, acc));
        }
    }

    /// Начало периода строки `i` с учётом досрочек внутри него.
    fn accrual_at(
        &self,
        lines: &[SimRow],
        i: usize,
        acc: Option<Accrual>,
        balance: i64,
    ) -> Accrual {
        match acc {
            Some(a) if a.index == i => a,
            _ => Accrual {
                index: i,
                start: if i == 0 {
                    self.t.issue
                } else {
                    parse_date(&lines[i - 1].row.due_date).expect("дата графика")
                },
                carry: 0,
                balance,
            },
        }
    }

    /// Проценты, накопленные к дате `date` в периоде строки `i` (только `daily`).
    fn accrued(
        &self,
        lines: &[SimRow],
        a: &Accrual,
        i: usize,
        date: NaiveDate,
    ) -> (NaiveDate, i64) {
        let due = lines
            .get(i)
            .map_or(date, |l| parse_date(&l.row.due_date).expect("дата графика"));
        let d = date.min(due).max(a.start);
        (d, a.carry + self.daily(a.balance, a.start, d))
    }
}

fn amortizing(rows: &[SimRow]) -> u32 {
    rows.iter()
        .filter(|r| r.kind != RowKind::InterestOnly)
        .count() as u32
}

/// Сколько строк нужно платежу `a`, чтобы погасить `left` при ставке `rate_bp`.
fn rows_needed(left: i64, rate_bp: i64, a: i64, per_year: i64) -> u32 {
    let mut l = left;
    let mut k = 0;
    while l > 0 && k < MAX_ROWS {
        let p = a - period_interest(l, rate_bp, per_year);
        k += 1;
        if p <= 0 {
            break;
        }
        l -= p.min(l);
    }
    k
}

/// Состояние после фактических платежей.
struct Run<'a> {
    ctx: Ctx<'a>,
    lines: Vec<SimRow>,
    early: Vec<EarlyRow>,
    left: i64,
    principal_paid: i64,
    interest_paid: i64,
    acc: Option<Accrual>,
}

fn first_pending(lines: &[SimRow]) -> usize {
    lines
        .iter()
        .position(|l| l.status == Status::Pending)
        .unwrap_or(lines.len())
}

fn run<'a>(t: &'a Terms, events: &[Event]) -> Run<'a> {
    let ctx = Ctx::new(t, events);
    let mut payments: Vec<Payment> = events
        .iter()
        .filter_map(|e| match e {
            Event::Payment(p) => Some(*p),
            _ => None,
        })
        .collect();
    payments.sort_by_key(|p| p.date);
    let mut r = Run {
        lines: Vec::new(),
        early: Vec::new(),
        left: t.principal,
        principal_paid: 0,
        interest_paid: 0,
        acc: None,
        ctx,
    };
    if t.repayment == Repayment::Bullet {
        let interest = match t.method {
            InterestMethod::Monthly => bullet_interest(t.principal, t.rate_bp, t.issue, t.first),
            InterestMethod::Daily => r.ctx.daily(t.principal, t.issue, t.first),
        };
        let mut row = SimRow {
            row: Row {
                seq: 1,
                due_date: t.first.to_string(),
                payment: t.principal + interest,
                principal_part: t.principal,
                interest_part: interest,
                balance_after: 0,
            },
            status: Status::Pending,
            kind: RowKind::Regular,
            annuity: None,
            principal_plan: None,
        };
        for p in &payments {
            r.left -= p.principal;
            r.principal_paid += p.principal;
            r.interest_paid += p.interest;
        }
        if r.left == 0 {
            row.status = Status::Paid;
        } else {
            let rest = (interest - r.interest_paid).max(0);
            row.row.principal_part = r.left;
            row.row.interest_part = rest;
            row.row.payment = r.left + rest;
        }
        r.lines.push(row);
        return r;
    }

    r.lines = r.ctx.gen(t.principal, Plan::Count(t.n), 1, None);
    for p in &payments {
        let before = r.left;
        r.left -= p.principal;
        r.principal_paid += p.principal;
        r.interest_paid += p.interest;
        let found = p
            .seq
            .and_then(|s| r.lines.iter().position(|l| l.row.seq == s));
        let (from, acc) = match found {
            Some(i) => {
                let planned = r.lines[i].row.principal_part;
                let line = &mut r.lines[i];
                line.row.payment = p.principal + p.interest;
                line.row.principal_part = p.principal;
                line.row.interest_part = p.interest;
                line.row.balance_after = r.left;
                line.status = if p.principal >= planned {
                    Status::Paid
                } else {
                    Status::Partial
                };
                r.acc = None;
                if p.principal == planned {
                    continue;
                }
                (i + 1, None)
            }
            // Досрочный платёж: пересчитываются все неоплаченные строки.
            None => {
                let i = first_pending(&r.lines);
                r.early.push(EarlyRow {
                    date: p.date.to_string(),
                    principal: p.principal,
                    interest: p.interest,
                    balance_after: r.left,
                    planned: false,
                });
                // По дням: сначала гасятся проценты, накопленные с начала периода,
                // остаток периода начисляется на новый остаток.
                let acc = (t.method == InterestMethod::Daily && i < r.lines.len()).then(|| {
                    let a = r.ctx.accrual_at(&r.lines, i, r.acc, before);
                    let (d, accrued) = r.ctx.accrued(&r.lines, &a, i, p.date);
                    Accrual {
                        index: i,
                        start: d,
                        carry: (accrued - p.interest).max(0),
                        balance: r.left,
                    }
                });
                r.acc = acc;
                (i, acc)
            }
        };
        r.ctx.recalc(&mut r.lines, from, r.left, p.mode, acc);
    }
    if r.left == 0 {
        r.lines.retain(|l| l.status != Status::Pending);
    }
    r
}

/// График по условиям и событиям.
pub fn simulate(t: &Terms, events: &[Event]) -> Sim {
    let mut r = run(t, events);
    // Плановые досрочки и свои суммы строк применяются вместе по датам: каждое
    // изменение пересчитывает график после себя, а более ранние сохраняются.
    // Своя сумма строки идёт по дате платежа и раньше досрочки того же дня.
    enum Step {
        Row(u32),
        Early,
    }
    let mut steps: Vec<(NaiveDate, u8, Step, Recalc, i64)> = events
        .iter()
        .filter_map(|e| match e {
            Event::PlannedEarly { date, amount, mode } => {
                Some((*date, 1, Step::Early, *mode, *amount))
            }
            Event::RowAmount { seq, amount, mode } if *seq >= 1 => {
                Some((r.ctx.due(*seq), 0, Step::Row(*seq), *mode, *amount))
            }
            _ => None,
        })
        .collect();
    steps.sort_by_key(|s| (s.0, s.1));
    if t.repayment != Repayment::Bullet {
        for (date, _, step, mode, amount) in steps {
            match step {
                Step::Row(seq) => apply_row_amount(&mut r, seq, amount, mode),
                Step::Early => apply_planned_early(&mut r, t, date, amount, mode),
            }
        }
    }
    Sim {
        rows: r.lines,
        early: r.early,
        outstanding: r.left,
        principal_paid: r.principal_paid,
        interest_paid: r.interest_paid,
    }
}

/// Плановая досрочка `amount` на дату `date` с пересчётом графика после неё.
fn apply_planned_early(r: &mut Run, t: &Terms, date: NaiveDate, amount: i64, mode: Recalc) {
    // Строки с датой не позже досрочки считаются оплаченными по графику.
    let day = date.to_string();
    let start = first_pending(&r.lines);
    let Some(i) = (start..r.lines.len()).find(|&i| r.lines[i].row.due_date > day) else {
        return;
    };
    let balance = match r.acc {
        Some(a) if a.index == i => a.balance,
        _ if i == 0 => r.left,
        _ => r.lines[i - 1].row.balance_after,
    };
    if balance == 0 {
        return;
    }
    let a = r.ctx.accrual_at(&r.lines, i, r.acc, balance);
    let (d, accrued) = match t.method {
        InterestMethod::Daily => r.ctx.accrued(&r.lines, &a, i, date),
        InterestMethod::Monthly => (a.start, 0),
    };
    let interest = accrued.min(amount);
    let principal = (amount - interest).min(balance);
    let new_balance = balance - principal;
    r.early.push(EarlyRow {
        date: day,
        principal,
        interest,
        balance_after: new_balance,
        planned: true,
    });
    let acc = Accrual {
        index: i,
        start: d,
        carry: accrued - interest,
        balance: new_balance,
    };
    r.acc = Some(acc);
    r.ctx.recalc(&mut r.lines, i, new_balance, mode, Some(acc));
}

/// Своя сумма неоплаченной строки `seq`: проценты строки платятся всегда,
/// остальное идёт в долг; строки после неё пересчитываются.
fn apply_row_amount(r: &mut Run, seq: u32, amount: i64, mode: Recalc) {
    let Some(i) = r
        .lines
        .iter()
        .position(|l| l.row.seq == seq && l.status == Status::Pending)
    else {
        return;
    };
    let row = &r.lines[i].row;
    if row.payment == amount {
        return;
    }
    let balance = row.balance_after + row.principal_part;
    let interest = row.interest_part;
    let principal = (amount - interest).clamp(0, balance);
    let left = balance - principal;
    let line = &mut r.lines[i];
    line.row.payment = principal + interest;
    line.row.principal_part = principal;
    line.row.balance_after = left;
    r.ctx.recalc(&mut r.lines, i + 1, left, mode, None);
}

/// Подсказка разбивки досрочного платежа `amount` на дату `date`: сначала
/// проценты, накопленные с начала периода (только `daily`), остальное — в долг.
/// Возвращает `(проценты, основной долг)`.
pub fn split_early(t: &Terms, events: &[Event], date: NaiveDate, amount: i64) -> (i64, i64) {
    let r = run(t, events);
    let interest = if t.method == InterestMethod::Daily && t.repayment != Repayment::Bullet {
        let i = first_pending(&r.lines);
        if i < r.lines.len() {
            let a = r.ctx.accrual_at(&r.lines, i, r.acc, r.left);
            r.ctx.accrued(&r.lines, &a, i, date).1
        } else {
            0
        }
    } else {
        0
    };
    let interest = interest.min(amount).max(0);
    (interest, (amount - interest).min(r.left).max(0))
}

/// График по условиям долга.
pub fn calculate(input: &LoanInput) -> Result<Schedule> {
    let t = Terms::from_input(input)?;
    Ok(Schedule::from_rows(simulate(&t, &[]).plain_rows()))
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

// --- Обратные расчёты ---

/// Первый (наибольший) платёж: у аннуитета — сам аннуитет.
fn first_payment(principal: i64, rate_bp: i64, n: u32, repayment: Repayment, per_year: i64) -> i64 {
    match repayment {
        Repayment::Differentiated => {
            div_round(principal as i128, n as i128) as i64
                + period_interest(principal, rate_bp, per_year)
        }
        _ => annuity_payment_per(principal, rate_bp, n, per_year),
    }
}

/// Сколько месяцев нужно, чтобы платить не больше `payment` (наименьший срок).
pub fn solve_term(principal: i64, rate_bp: i64, payment: i64) -> Result<u32> {
    solve_term_for(principal, rate_bp, payment, Repayment::Annuity, 12)
}

fn solve_term_for(
    principal: i64,
    rate_bp: i64,
    payment: i64,
    repayment: Repayment,
    per_year: i64,
) -> Result<u32> {
    if principal <= 0 || principal > MAX_PRINCIPAL {
        return invalid("сумма должна быть больше нуля");
    }
    check_rate(rate_bp)?;
    // Платёж, равный процентам первого месяца, ещё гасит долг: на долгом сроке
    // с высокой ставкой округлённый аннуитет совпадает с процентами.
    if payment < period_interest(principal, rate_bp, per_year) {
        return invalid("платёж меньше процентов: долг не уменьшится");
    }
    if first_payment(principal, rate_bp, MAX_TERM, repayment, per_year) > payment {
        return invalid("с таким платежом нужно больше 600 платежей");
    }
    // Платёж убывает с ростом срока: ищем наименьший подходящий срок.
    let (mut lo, mut hi) = (1u32, MAX_TERM);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if first_payment(principal, rate_bp, mid, repayment, per_year) <= payment {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok(lo)
}

/// Наибольшая сумма, при которой платёж не больше `payment`, округлённая вниз до рубля.
pub fn solve_principal(payment: i64, rate_bp: i64, n: u32) -> Result<i64> {
    solve_principal_for(payment, rate_bp, n, Repayment::Annuity, 12)
}

fn solve_principal_for(
    payment: i64,
    rate_bp: i64,
    n: u32,
    repayment: Repayment,
    per_year: i64,
) -> Result<i64> {
    if payment <= 0 {
        return invalid("платёж должен быть больше нуля");
    }
    check_rate(rate_bp)?;
    if !(1..=MAX_TERM).contains(&n) {
        return invalid("срок должен быть от 1 до 600 месяцев");
    }
    // Ищем в рублях (по 100 минимальных единиц): платёж растёт с суммой.
    let ok = |rub: i64| first_payment(rub * 100, rate_bp, n, repayment, per_year) <= payment;
    let (mut lo, mut hi) = (0i64, MAX_PRINCIPAL / 100);
    if ok(hi) {
        return Ok(hi * 100);
    }
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if ok(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    if lo == 0 {
        return invalid("платёж слишком мал");
    }
    Ok(lo * 100)
}

/// Ставка по известному платежу: наименьшая годовая ставка (в сотых долях
/// процента), при которой первый платёж не меньше `payment`.
pub fn solve_rate(
    principal: i64,
    payment: i64,
    n: u32,
    repayment: Repayment,
    per_year: i64,
) -> Result<i64> {
    if principal <= 0 || principal > MAX_PRINCIPAL {
        return invalid("сумма должна быть больше нуля");
    }
    if !(1..=MAX_TERM).contains(&n) {
        return invalid("укажите срок");
    }
    let pay = |r: i64| first_payment(principal, r, n, repayment, per_year);
    if payment < pay(0) {
        return invalid("платёж меньше, чем без процентов: так долг не погасить");
    }
    if payment > pay(MAX_RATE) {
        return invalid("с таким платежом ставка больше 1000 % годовых");
    }
    // Платёж растёт со ставкой: ищем наименьшую ставку с платежом не меньше заданного.
    let (mut lo, mut hi) = (0i64, MAX_RATE);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if pay(mid) >= payment {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok(lo)
}

// --- Калькулятор ---

/// Что рассчитать: платёж, срок или сумму.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Solve {
    #[default]
    Payment,
    Term,
    Principal,
    /// Ставка по известному платежу.
    Rate,
}

/// Расчёт калькулятора: условия, изменения ставки, каникулы и плановые досрочки.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcInput {
    #[serde(flatten)]
    pub loan: LoanInput,
    #[serde(default)]
    pub rate_changes: Vec<RateChangeInput>,
    #[serde(default)]
    pub holidays: Vec<HolidayInput>,
    #[serde(default)]
    pub planned_early: Vec<PlannedEarlyInput>,
    /// Свои суммы строк графика.
    #[serde(default)]
    pub row_amounts: Vec<RowAmountInput>,
    #[serde(default)]
    pub solve: Solve,
    /// Желаемый платёж — для расчёта срока или суммы.
    pub payment: Option<i64>,
}

/// График с итогами.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimView {
    pub rows: Vec<SimRow>,
    pub early: Vec<EarlyRow>,
    pub totals: Totals,
}

impl From<Sim> for SimView {
    fn from(s: Sim) -> Self {
        SimView {
            totals: s.totals(),
            rows: s.rows,
            early: s.early,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcResult {
    /// Сумма (рассчитанная, если считали сумму).
    pub principal: i64,
    /// Годовая ставка (рассчитанная, если считали ставку).
    pub rate_bp: i64,
    /// Срок (рассчитанный, если считали срок).
    pub term_months: Option<u32>,
    /// Первый платёж.
    pub payment: i64,
    /// График без плановых досрочек.
    pub base: SimView,
    /// График с плановыми досрочками; пусто, если их нет.
    pub with_early: Option<SimView>,
    /// Экономия на процентах от досрочек.
    pub savings: i64,
}

impl CalcInput {
    /// Условия после обратного расчёта (срок или сумма подставлены).
    pub fn solved(&self) -> Result<LoanInput> {
        let mut loan = self.loan.clone();
        if loan.repayment == Repayment::Bullet || self.solve == Solve::Payment {
            return Ok(loan);
        }
        let Some(payment) = self.payment else {
            return invalid("укажите желаемый платёж");
        };
        let per_year = loan.pay_every.per_year();
        match self.solve {
            Solve::Term => {
                loan.term_months = Some(solve_term_for(
                    loan.principal,
                    loan.rate_bp,
                    payment,
                    loan.repayment,
                    per_year,
                )?)
            }
            Solve::Principal => {
                let Some(n) = loan.term_months else {
                    return invalid("укажите срок");
                };
                loan.principal =
                    solve_principal_for(payment, loan.rate_bp, n, loan.repayment, per_year)?;
            }
            Solve::Rate => {
                let Some(n) = loan.term_months else {
                    return invalid("укажите срок");
                };
                loan.rate_bp = solve_rate(loan.principal, payment, n, loan.repayment, per_year)?;
            }
            Solve::Payment => {}
        }
        Ok(loan)
    }

    /// События калькулятора без плановых досрочек.
    pub fn events(&self, t: &Terms) -> Result<Vec<Event>> {
        let mut events = Vec::new();
        for r in &self.rate_changes {
            let r = r.parse()?;
            if r.from < t.issue {
                return invalid("ставка меняется раньше даты выдачи");
            }
            events.push(Event::RateChange(r));
        }
        for h in &self.holidays {
            if t.repayment == Repayment::Bullet || t.every != PayEvery::Month {
                return invalid("каникулы бывают только у ежемесячных платежей");
            }
            events.push(Event::Holiday(h.parse()?));
        }
        for a in &self.row_amounts {
            events.push(a.parse()?);
        }
        Ok(events)
    }
}

/// Калькулятор: график, итоги и экономия от плановых досрочек.
pub fn plan(input: &CalcInput) -> Result<CalcResult> {
    let loan = input.solved()?;
    let t = Terms::from_input(&loan)?;
    let mut events = input.events(&t)?;
    let base = simulate(&t, &events);
    let payment = base.rows.first().map_or(0, |r| r.row.payment);
    let base: SimView = base.into();
    let until = parse_date(&base.totals.maturity_date)?;
    let planned = expand_planned(&input.planned_early, t.issue, until)?;
    let with_early: Option<SimView> = if planned.is_empty() {
        None
    } else {
        events.extend(planned);
        Some(simulate(&t, &events).into())
    };
    let savings = with_early
        .as_ref()
        .map_or(0, |w| base.totals.total_interest - w.totals.total_interest);
    Ok(CalcResult {
        principal: t.principal,
        rate_bp: t.rate_bp,
        term_months: (t.repayment != Repayment::Bullet).then_some(t.n),
        payment,
        base,
        with_early,
        savings,
    })
}

/// Прежняя реализация графика (до 0.16): эталон для проверки, что метод
/// `monthly` нового движка даёт те же строки.
#[cfg(test)]
pub(crate) mod legacy {
    use super::*;

    #[derive(Debug, Clone, Copy)]
    pub enum Plan {
        Count(u32),
        Payment(i64),
        Principal(i64),
        Fixed(i64, u32),
    }

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

    /// Прежний `calculate`.
    pub fn calculate(input: &LoanInput) -> Schedule {
        let t = Terms::from_input(input).unwrap();
        if t.repayment == Repayment::Bullet {
            let interest = bullet_interest(t.principal, t.rate_bp, t.issue, t.first);
            return Schedule::from_rows(vec![Row {
                seq: 1,
                due_date: t.first.to_string(),
                payment: t.principal + interest,
                principal_part: t.principal,
                interest_part: interest,
                balance_after: 0,
            }]);
        }
        Schedule::from_rows(monthly_rows(
            t.principal,
            t.rate_bp,
            t.repayment,
            Plan::Count(t.n),
            t.first,
            1,
        ))
    }

    /// Платёж для прежнего `rebuild`: номер строки, основной долг, проценты, способ.
    #[derive(Debug, Clone)]
    pub struct Paid {
        pub seq: Option<u32>,
        pub principal: i64,
        pub interest: i64,
        pub mode: &'static str,
    }

    /// Прежний `debts::rebuild` без записи в базу: строки, их статусы и остаток.
    pub fn rebuild(input: &LoanInput, payments: &[Paid]) -> (Vec<(Row, &'static str)>, i64) {
        let t = Terms::from_input(input).unwrap();
        let base = calculate(input);
        let mut lines: Vec<(Row, &'static str)> =
            base.rows.iter().cloned().map(|r| (r, "pending")).collect();
        let mut left = t.principal;
        let mut interest_paid = 0;
        for p in payments {
            left -= p.principal;
            interest_paid += p.interest;
            if t.repayment == Repayment::Bullet {
                continue;
            }
            let from = match p.seq.and_then(|s| lines.iter().position(|l| l.0.seq == s)) {
                Some(i) => {
                    let planned = lines[i].0.principal_part;
                    lines[i] = (
                        Row {
                            payment: p.principal + p.interest,
                            principal_part: p.principal,
                            interest_part: p.interest,
                            balance_after: left,
                            ..lines[i].0.clone()
                        },
                        if p.principal >= planned {
                            "paid"
                        } else {
                            "partial"
                        },
                    );
                    if p.principal == planned {
                        continue;
                    }
                    i + 1
                }
                None => lines
                    .iter()
                    .position(|l| l.1 == "pending")
                    .unwrap_or(lines.len()),
            };
            // recalc
            let tail = &lines[from.min(lines.len())..];
            let count = tail.len() as u32;
            let start_seq = lines
                .get(from)
                .map_or_else(|| lines.last().map_or(1, |l| l.0.seq + 1), |l| l.0.seq);
            let plan = match (p.mode, tail.first()) {
                ("reduce_term", Some(l)) if t.repayment == Repayment::Annuity => {
                    Plan::Payment(l.0.payment)
                }
                ("reduce_term", Some(l)) => Plan::Principal(l.0.principal_part),
                (_, _) => Plan::Count(count.max(1)),
            };
            lines.truncate(from);
            if left > 0 {
                let rows = monthly_rows(left, t.rate_bp, t.repayment, plan, t.first, start_seq);
                lines.extend(rows.into_iter().map(|r| (r, "pending")));
            }
        }
        if t.repayment == Repayment::Bullet {
            let row = &mut lines[0];
            if left == 0 {
                row.1 = "paid";
            } else {
                let interest = (base.total_interest - interest_paid).max(0);
                row.0.principal_part = left;
                row.0.interest_part = interest;
                row.0.payment = left + interest;
            }
        } else if left == 0 {
            lines.retain(|l| l.1 != "pending");
        }
        (lines, left)
    }
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
            interest_method: InterestMethod::Monthly,
            rate_period: RatePeriod::Year,
            pay_every: PayEvery::Month,
        }
    }

    fn daily(principal: i64, rate_bp: i64, n: u32, repayment: Repayment) -> Terms {
        let mut i = input(principal, rate_bp, n, repayment);
        i.interest_method = InterestMethod::Daily;
        i.first_payment_date = Some("2026-11-15".into());
        Terms::from_input(&i).unwrap()
    }

    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    // --- 0.20: ставка за период, частота платежей, ставка по платежу, своя сумма строки ---

    #[test]
    fn day_rate_counts_exactly_per_day_even_in_leap_year() {
        // 100 000 ₽ под 0,5 % в день на 30 дней, 2028 — високосный.
        let mut i = input(10_000_000, 50 * 365, 1, Repayment::Bullet);
        i.issue_date = "2028-01-10".into();
        i.maturity_date = Some("2028-02-09".into());
        i.interest_method = InterestMethod::Daily;
        i.rate_period = RatePeriod::Day;
        let s = simulate(&Terms::from_input(&i).unwrap(), &[]);
        assert_eq!(s.rows[0].row.interest_part, 1_500_000);
        // Та же годовая ставка, введённая как годовая, в високосном году даёт меньше.
        i.rate_period = RatePeriod::Year;
        let y = simulate(&Terms::from_input(&i).unwrap(), &[]);
        assert!(y.rows[0].row.interest_part < 1_500_000);
    }

    #[test]
    fn month_rate_is_annual_divided_by_twelve() {
        // 1,5 % в месяц = 18 % годовых: проценты первой строки — 1,5 % остатка.
        let mut i = input(30_000_000, 150 * 12, 24, Repayment::Annuity);
        i.rate_period = RatePeriod::Month;
        let s = simulate(&Terms::from_input(&i).unwrap(), &[]);
        assert_eq!(s.rows[0].row.interest_part, 450_000);
        assert_eq!(s.rows[0].row.payment, annuity_payment(30_000_000, 1800, 24));
    }

    #[test]
    fn quarterly_payments_every_three_months() {
        let mut i = input(12_000_000, 1200, 8, Repayment::Annuity);
        i.pay_every = PayEvery::Quarter;
        let s = simulate(&Terms::from_input(&i).unwrap(), &[]);
        assert_eq!(s.rows.len(), 8);
        let dates: Vec<&str> = s
            .rows
            .iter()
            .take(3)
            .map(|r| r.row.due_date.as_str())
            .collect();
        assert_eq!(dates, ["2027-01-15", "2027-04-15", "2027-07-15"]);
        // Проценты за квартал: 12 % ÷ 4 = 3 %.
        assert_eq!(s.rows[0].row.interest_part, 360_000);
        assert_eq!(
            s.rows[0].row.payment,
            annuity_payment_per(12_000_000, 1200, 8, 4)
        );
        assert_eq!(
            s.rows.iter().map(|r| r.row.principal_part).sum::<i64>(),
            12_000_000
        );
        assert_eq!(s.rows.last().unwrap().row.balance_after, 0);
    }

    #[test]
    fn two_week_payments_every_fourteen_days() {
        let mut i = input(2_600_000, 2600, 26, Repayment::Differentiated);
        i.pay_every = PayEvery::TwoWeeks;
        i.interest_method = InterestMethod::Daily;
        let s = simulate(&Terms::from_input(&i).unwrap(), &[]);
        assert_eq!(s.rows.len(), 26);
        assert_eq!(s.rows[0].row.due_date, "2026-10-29");
        assert_eq!(s.rows[1].row.due_date, "2026-11-12");
        assert_eq!(s.rows[0].row.principal_part, 100_000);
        // 26 % годовых за 14 дней невисокосного года.
        assert_eq!(
            s.rows[0].row.interest_part,
            (2_600_000i64 * 2600 * 14 + 10_000 * 365 / 2) / (10_000 * 365)
        );
        assert_eq!(s.rows.last().unwrap().row.balance_after, 0);
    }

    #[test]
    fn holidays_need_monthly_payments() {
        let mut i = input(12_000_000, 1200, 8, Repayment::Annuity);
        i.pay_every = PayEvery::Quarter;
        let c = CalcInput {
            loan: i,
            rate_changes: vec![],
            holidays: vec![HolidayInput {
                from_seq: 2,
                months: 2,
                kind: "shift".into(),
            }],
            planned_early: vec![],
            row_amounts: vec![],
            solve: Solve::Payment,
            payment: None,
        };
        assert!(plan(&c).is_err());
    }

    #[test]
    fn solve_rate_finds_rate_from_payment() {
        for (rate, n, every, kind) in [
            (1800, 24, PayEvery::Month, Repayment::Annuity),
            (2390, 60, PayEvery::Month, Repayment::Differentiated),
            (900, 12, PayEvery::Quarter, Repayment::Annuity),
        ] {
            let pay = first_payment(30_000_000, rate, n, kind, every.per_year());
            let got = solve_rate(30_000_000, pay, n, kind, every.per_year()).unwrap();
            assert!(got <= rate);
            assert_eq!(
                first_payment(30_000_000, got, n, kind, every.per_year()),
                pay
            );
        }
        assert_eq!(
            solve_rate(1_200_000, 100_000, 12, Repayment::Annuity, 12).unwrap(),
            0
        );
        assert!(solve_rate(1_200_000, 99_999, 12, Repayment::Annuity, 12).is_err());
        assert!(solve_rate(1_200_000, 1_200_000, 12, Repayment::Annuity, 12).is_err());
    }

    #[test]
    fn calculator_solves_rate() {
        let a = annuity_payment(30_000_000, 1800, 24);
        let c = CalcInput {
            loan: input(30_000_000, 0, 24, Repayment::Annuity),
            rate_changes: vec![],
            holidays: vec![],
            planned_early: vec![],
            row_amounts: vec![],
            solve: Solve::Rate,
            payment: Some(a),
        };
        let r = plan(&c).unwrap();
        assert_eq!(r.payment, a);
        assert!((1790..=1800).contains(&r.rate_bp));
    }

    #[test]
    fn row_amount_recalculates_the_rest() {
        let t = Terms::from_input(&input(30_000_000, 1200, 24, Repayment::Annuity)).unwrap();
        let base = simulate(&t, &[]);
        let row3 = base.rows[2].row.clone();
        // Платёж №3 больше на 50 000 ₽, срок короче.
        let more = Event::RowAmount {
            seq: 3,
            amount: row3.payment + 5_000_000,
            mode: Recalc::ReduceTerm,
        };
        let s = simulate(&t, &[more]);
        assert_eq!(s.rows[2].row.payment, row3.payment + 5_000_000);
        assert_eq!(s.rows[2].row.interest_part, row3.interest_part);
        assert_eq!(s.rows[3].row.payment, base.rows[3].row.payment);
        assert!(s.rows.len() < 24);
        assert_eq!(s.rows.last().unwrap().row.balance_after, 0);
        assert_eq!(
            s.rows.iter().map(|r| r.row.principal_part).sum::<i64>(),
            30_000_000
        );
        // Тот же платёж, но срок прежний: платежи после него меньше.
        let pay = Event::RowAmount {
            seq: 3,
            amount: row3.payment + 5_000_000,
            mode: Recalc::ReducePayment,
        };
        let s = simulate(&t, &[pay]);
        assert_eq!(s.rows.len(), 24);
        assert!(s.rows[3].row.payment < base.rows[3].row.payment);
        // Только проценты: долг не уменьшается, остальные платежи больше.
        let less = Event::RowAmount {
            seq: 3,
            amount: 0,
            mode: Recalc::ReducePayment,
        };
        let s = simulate(&t, &[less]);
        assert_eq!(s.rows[2].row.payment, row3.interest_part);
        assert_eq!(s.rows[2].row.principal_part, 0);
        assert!(s.rows[3].row.payment > base.rows[3].row.payment);
        assert_eq!(s.rows.last().unwrap().row.balance_after, 0);
        // Меньше на последней строке: остаток переносится на строку позже.
        let last = base.rows[23].row.clone();
        let tail = Event::RowAmount {
            seq: 24,
            amount: last.payment - 100_000,
            mode: Recalc::ReducePayment,
        };
        let s = simulate(&t, &[tail]);
        assert_eq!(s.rows.len(), 25);
        assert_eq!(s.rows.last().unwrap().row.balance_after, 0);
    }

    #[test]
    fn row_amount_keeps_later_planned_early() {
        // Своя сумма ранней строки не стирает досрочку, запланированную позже.
        let t = Terms::from_input(&input(30_000_000, 1200, 24, Repayment::Annuity)).unwrap();
        let row3 = simulate(&t, &[]).rows[2].row.clone();
        let row = Event::RowAmount {
            seq: 3,
            amount: row3.payment + 1_000_000,
            mode: Recalc::ReducePayment,
        };
        let plan = Event::PlannedEarly {
            date: d("2027-06-01"),
            amount: 5_000_000,
            mode: Recalc::ReduceTerm,
        };
        let only_row = simulate(&t, &[row]);
        for events in [[row, plan], [plan, row]] {
            let s = simulate(&t, &events);
            assert_eq!(s.early.len(), 1);
            assert!(s.rows.len() < only_row.rows.len());
            assert_eq!(s.rows[2].row.payment, row3.payment + 1_000_000);
            let paid: i64 = s.rows.iter().map(|r| r.row.principal_part).sum::<i64>()
                + s.early.iter().map(|e| e.principal).sum::<i64>();
            assert_eq!(paid, 30_000_000);
        }
    }

    fn early(date: &str, principal: i64, interest: i64, mode: Recalc) -> Event {
        Event::Payment(Payment {
            date: d(date),
            principal,
            interest,
            seq: None,
            mode,
        })
    }

    fn scheduled(r: &Row, date: &str) -> Event {
        Event::Payment(Payment {
            date: d(date),
            principal: r.principal_part,
            interest: r.interest_part,
            seq: Some(r.seq),
            mode: Recalc::ReducePayment,
        })
    }

    fn closes(s: &Sim) {
        let pending: i64 = s
            .rows
            .iter()
            .filter(|r| r.status == Status::Pending)
            .map(|r| r.row.principal_part)
            .sum();
        let planned: i64 = s
            .early
            .iter()
            .filter(|e| e.planned)
            .map(|e| e.principal)
            .sum();
        assert_eq!(pending + planned, s.outstanding, "график покрывает остаток");
        // Закрывает последняя строка или досрочка, погасившая остаток.
        let closed_early = s.early.last().is_some_and(|e| e.balance_after == 0);
        assert!(closed_early || s.rows.last().unwrap().row.balance_after == 0);
        for r in &s.rows {
            assert_eq!(r.row.payment, r.row.principal_part + r.row.interest_part);
            assert!(r.row.principal_part >= 0 && r.row.interest_part >= 0);
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
        // По дням високосный 2028 год делится на 366.
        i.interest_method = InterestMethod::Daily;
        i.issue_date = "2028-01-01".into();
        i.maturity_date = Some("2029-01-01".into());
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
        let old = legacy::calculate(&input(4_785_987, 3445, 349, Repayment::Annuity));
        assert_eq!(s.rows, old.rows);
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
        let mut i = input(30_000_000, 1800, 24, Repayment::Annuity);
        i.first_payment_date = Some("2026-09-15".into());
        i.issue_date = "2026-08-15".into();
        let t = Terms::from_input(&i).unwrap();
        let ctx = Ctx::new(&t, &[]);
        let rows = ctx.gen(10_000_000, Plan::Payment(1_497_723), 5, None);
        assert_eq!(rows[0].row.seq, 5);
        assert_eq!(rows[0].row.due_date, "2027-01-15");
        assert_eq!(rows.len(), 8);
        assert!(rows
            .iter()
            .rev()
            .skip(1)
            .all(|r| r.row.payment == 1_497_723));
        assert!(rows.last().unwrap().row.payment < 1_497_723);
        assert_eq!(rows.last().unwrap().row.balance_after, 0);
    }

    #[test]
    fn daily_interest_like_a_bank() {
        // 300 000 ₽, 12 %, 24 мес., выдача 15.10.2026, первый платёж 15.11.2026.
        let t = daily(30_000_000, 1200, 24, Repayment::Annuity);
        let s = simulate(&t, &[]);
        let rows = s.plain_rows();
        assert_eq!(rows.len(), 24);
        // 300 000 × 12 % × 31 / 365 = 3 057,53 ₽.
        assert_eq!(rows[0].interest_part, 305_753);
        let a = annuity_payment(30_000_000, 1200, 24);
        assert_eq!(rows[0].payment, a);
        assert_eq!(rows[0].principal_part, a - 305_753);
        assert!(rows.iter().rev().skip(1).all(|r| r.payment == a));
        assert_eq!(rows[23].balance_after, 0);
        assert_eq!(rows[23].due_date, "2028-10-15");
        // Период 15.12.2026–15.01.2027: 31 день, все в годах по 365.
        let r = &rows[2];
        assert_eq!(r.due_date, "2027-01-15");
        let num = rows[1].balance_after as i128 * 1200 * 31;
        assert_eq!(r.interest_part as i128, div_round(num, 10_000 * 365));
        // Период 15.12.2027–15.01.2028: 17 дней по 365 и 14 дней по 366.
        let r = &rows[14];
        assert_eq!(r.due_date, "2028-01-15");
        let b = rows[13].balance_after as i128;
        let exact = div_round(b * 1200 * (17 * 366 + 14 * 365), DAY_DEN);
        assert_eq!(r.interest_part as i128, exact);
        // Февраль 2028 (29 дней) дешевле января.
        assert!(rows[15].interest_part < rows[14].interest_part);
    }

    #[test]
    fn daily_early_payment_inside_a_period() {
        let t = daily(30_000_000, 1200, 24, Repayment::Annuity);
        let base = simulate(&t, &[]).plain_rows();
        let mut events: Vec<Event> = Vec::new();
        for (r, date) in
            base.iter()
                .take(4)
                .zip(["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"])
        {
            events.push(scheduled(r, date));
        }
        let left = base[3].balance_after;
        // Проценты за 14 дней с 15.02 по 01.03.
        let accrued = div_round(left as i128 * 1200 * 14, 10_000 * 365) as i64;
        assert_eq!(
            split_early(&t, &events, d("2027-03-01"), 5_000_000),
            (accrued, 5_000_000 - accrued)
        );

        let pay = |mode| {
            let mut e = events.clone();
            e.push(early("2027-03-01", 5_000_000 - accrued, accrued, mode));
            simulate(&t, &e)
        };
        let term = pay(Recalc::ReduceTerm);
        let payment = pay(Recalc::ReducePayment);
        closes(&term);
        closes(&payment);
        let a = annuity_payment(30_000_000, 1200, 24);
        // Остаток периода начисляется на новый остаток.
        let new_left = left - (5_000_000 - accrued);
        let next = &term.rows[4].row;
        assert_eq!(next.due_date, "2027-03-15");
        assert_eq!(
            next.interest_part,
            div_round(new_left as i128 * 1200 * 14, 10_000 * 365) as i64
        );
        assert_eq!(next.payment, a, "платёж прежний");
        assert!(term.rows.len() < 24, "строк меньше: {}", term.rows.len());
        assert_eq!(payment.rows.len(), 24, "срок прежний");
        assert!(payment.rows[4].row.payment < a, "платёж меньше");
        assert!(term.totals().total_interest < payment.totals().total_interest);
        assert_eq!(term.early.len(), 1);
    }

    #[test]
    fn rate_change_from_a_date() {
        let t = daily(30_000_000, 1200, 24, Repayment::Annuity);
        let base = simulate(&t, &[]).plain_rows();
        let change = Event::RateChange(RateChange {
            from: d("2027-03-01"),
            rate_bp: 1000,
        });
        let s = simulate(&t, &[change]);
        closes(&s);
        let rows = s.plain_rows();
        assert_eq!(rows.len(), 24, "срок прежний");
        assert_eq!(rows[..3], base[..3], "до смены ставки всё как было");
        // Строка 15.03.2027: 14 дней по 12 % и 14 дней по 10 %.
        let b = rows[3].balance_after as i128;
        let num = b * (1200 * 14 + 1000 * 14) * 366;
        assert_eq!(rows[4].interest_part as i128, div_round(num, DAY_DEN));
        // С этой строки аннуитет пересчитан по новой ставке на 20 строк.
        let a = annuity_payment(rows[3].balance_after, 1000, 20);
        assert_eq!(rows[4].payment, a);
        assert!(rows[5..23].iter().all(|r| r.payment == a));
        assert!(a < base[4].payment);

        // По месяцам: проценты по новой ставке со следующего периода.
        let mut m = t.clone();
        m.method = InterestMethod::Monthly;
        let s = simulate(&m, &[change]);
        closes(&s);
        let rows = s.plain_rows();
        assert_eq!(rows.len(), 24);
        assert_eq!(
            rows[4].interest_part,
            month_interest(rows[3].balance_after, 1200)
        );
        assert_eq!(
            rows[5].interest_part,
            month_interest(rows[4].balance_after, 1000)
        );
    }

    #[test]
    fn holidays_interest_only_and_shift() {
        for method in [InterestMethod::Monthly, InterestMethod::Daily] {
            for repayment in [Repayment::Annuity, Repayment::Differentiated] {
                let mut t = daily(30_000_000, 1200, 24, repayment);
                t.method = method;
                let base = simulate(&t, &[]).plain_rows();
                let io = simulate(
                    &t,
                    &[Event::Holiday(Holiday {
                        from_seq: 5,
                        months: 3,
                        kind: HolidayKind::InterestOnly,
                    })],
                );
                closes(&io);
                assert_eq!(io.rows.len(), 27, "срок длиннее на 3 месяца");
                assert_eq!(io.rows[..4], simulate(&t, &[]).rows[..4]);
                for r in &io.rows[4..7] {
                    assert_eq!(r.kind, RowKind::InterestOnly);
                    assert_eq!(
                        (r.row.principal_part, r.row.payment),
                        (0, r.row.interest_part)
                    );
                    assert_eq!(r.row.balance_after, base[3].balance_after);
                }
                assert_eq!(io.rows[4].row.due_date, "2027-03-15");
                assert_eq!(io.rows[26].row.due_date, "2029-01-15");

                let shift = simulate(
                    &t,
                    &[Event::Holiday(Holiday {
                        from_seq: 5,
                        months: 2,
                        kind: HolidayKind::Shift,
                    })],
                );
                closes(&shift);
                let rows = shift.plain_rows();
                assert_eq!(rows.len(), 24);
                assert_eq!(rows[3].due_date, "2027-02-15");
                assert_eq!(rows[4].due_date, "2027-05-15", "платёж сдвинут на 2 месяца");
                assert_eq!(rows[23].due_date, "2028-12-15");
                assert_eq!(shift.rows[4].kind, RowKind::AfterShift);
                // Проценты за паузу вошли в первый платёж после неё: примерно три месяца.
                let one = base[4].interest_part;
                assert!(
                    rows[4].interest_part > 2 * one,
                    "{} vs {one}",
                    rows[4].interest_part
                );
                if method == InterestMethod::Monthly || repayment == Repayment::Differentiated {
                    // Основная часть как у обычного платежа: остаток тот же.
                    assert_eq!(rows[4].principal_part, base[4].principal_part);
                }
                assert!(rows[4].principal_part > 0);
                assert!(rows[4].payment > base[4].payment);
            }
        }
    }

    #[test]
    fn short_rate_or_long_pause_pays_only_interest() {
        // Проценты больше платежа: основная часть 0, платёж равен процентам.
        let mut t = daily(30_000_000, 1200, 24, Repayment::Annuity);
        t.first = d("2027-04-15");
        let s = simulate(&t, &[]);
        closes(&s);
        assert!(s.rows[0].row.interest_part > annuity_payment(30_000_000, 1200, 24));
        assert_eq!(s.rows[0].row.principal_part, 0);
        assert_eq!(s.rows[0].row.payment, s.rows[0].row.interest_part);
    }

    #[test]
    fn planned_early_only_in_forecast() {
        let t = daily(30_000_000, 1200, 24, Repayment::Annuity);
        let base = simulate(&t, &[]);
        let list = vec![PlannedEarlyInput {
            amount: 1_000_000,
            start_date: "2027-01-01".into(),
            frequency: "monthly".into(),
            end_date: None,
            mode: "reduce_term".into(),
        }];
        let events = expand_planned(&list, t.issue, d("2028-10-15")).unwrap();
        assert_eq!(events.len(), 22);
        let s = simulate(&t, &events);
        closes(&s);
        assert!(s.rows.len() < 24);
        assert!(s.early.iter().all(|e| e.planned));
        assert!(s.totals().total_interest < base.totals().total_interest);
        assert_eq!(s.outstanding, 30_000_000, "фактически ничего не уплачено");
        // Разовая досрочка в дату платежа идёт в следующий период без процентов.
        let once = vec![PlannedEarlyInput {
            amount: 1_000_000,
            start_date: "2026-12-15".into(),
            frequency: "once".into(),
            end_date: None,
            mode: "reduce_payment".into(),
        }];
        let s = simulate(
            &t,
            &expand_planned(&once, t.issue, d("2028-10-15")).unwrap(),
        );
        closes(&s);
        assert_eq!(s.early[0].interest, 0);
        assert_eq!(s.rows.len(), 24);
        assert_eq!(
            s.early[0].balance_after,
            base.rows[1].row.balance_after - 1_000_000
        );
    }

    #[test]
    fn solve_term_when_payment_equals_first_interest() {
        // Найдено тестом свойств: аннуитет на 307 мес. под 31,17 % округлён до процентов первого месяца.
        let a = annuity_payment(100_000, 3117, 307);
        assert_eq!(a, month_interest(100_000, 3117));
        let m = solve_term(100_000, 3117, a).unwrap();
        assert!(m <= 307);
        assert_eq!(annuity_payment(100_000, 3117, m), a);
        assert!(solve_term(100_000, 3117, a - 1).is_err());
    }

    #[test]
    fn calculator_solves_term_and_principal() {
        assert!(
            solve_term(30_000_000, 1200, 300_000).is_err(),
            "платёж меньше процентов"
        );
        let a = annuity_payment(30_000_000, 1200, 24);
        assert_eq!(solve_term(30_000_000, 1200, a).unwrap(), 24);
        assert_eq!(solve_term(30_000_000, 1200, a + 1).unwrap(), 24);
        let p = solve_principal(a, 1200, 24).unwrap();
        assert_eq!(p % 100, 0);
        assert!((29_999_900..=30_000_000).contains(&p));

        let mut c = CalcInput {
            loan: input(0, 1200, 24, Repayment::Annuity),
            rate_changes: vec![],
            holidays: vec![],
            planned_early: vec![],
            row_amounts: vec![],
            solve: Solve::Principal,
            payment: Some(a),
        };
        let r = plan(&c).unwrap();
        assert_eq!(r.principal, p);
        assert!(r.with_early.is_none());
        c.solve = Solve::Term;
        c.loan.principal = 30_000_000;
        c.planned_early.push(PlannedEarlyInput {
            amount: 5_000_000,
            start_date: "2027-06-01".into(),
            frequency: "once".into(),
            end_date: None,
            mode: "reduce_term".into(),
        });
        let r = plan(&c).unwrap();
        assert_eq!(r.term_months, Some(24));
        assert_eq!(r.payment, a);
        let w = r.with_early.unwrap();
        assert!(w.rows.len() < 24);
        assert!(r.savings > 0);
        assert_eq!(
            r.savings,
            r.base.totals.total_interest - w.totals.total_interest
        );
    }

    /// Случайный набор платежей для сравнения со старым `rebuild`.
    fn random_payments(
        loan: &LoanInput,
        steps: &[(u8, i64, bool)],
    ) -> (Vec<legacy::Paid>, Vec<Event>) {
        let mut paid = Vec::new();
        let mut events = Vec::new();
        for (i, &(action, pct, term_mode)) in steps.iter().enumerate() {
            let (lines, left) = legacy::rebuild(loan, &paid);
            if left == 0 {
                break;
            }
            let next = lines.iter().find(|l| l.1 == "pending").map(|l| l.0.clone());
            let mode = if term_mode {
                "reduce_term"
            } else {
                "reduce_payment"
            };
            let (seq, principal, interest) = match (action, next) {
                (0, Some(n)) => (Some(n.seq), n.principal_part, n.interest_part),
                (1, Some(n)) => (
                    Some(n.seq),
                    (n.principal_part * pct / 100).min(left),
                    n.interest_part,
                ),
                (2, _) => (None, (left * pct / 200).clamp(1, left), 0),
                (3, Some(n)) => (
                    Some(n.seq),
                    (n.principal_part + left * pct / 400).min(left),
                    n.interest_part,
                ),
                _ => (None, left, 0),
            };
            if principal + interest == 0 {
                continue;
            }
            paid.push(legacy::Paid {
                seq,
                principal,
                interest,
                mode,
            });
            events.push(Event::Payment(Payment {
                date: d("2026-11-01") + chrono::Days::new(i as u64),
                principal,
                interest,
                seq,
                mode: Recalc::parse(mode).unwrap(),
            }));
        }
        (paid, events)
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

        /// Метод `monthly` нового движка совпадает со старым графиком строка в строку.
        #[test]
        fn monthly_calculate_matches_legacy(
            principal in 1_000i64..10_000_000_000,
            rate_bp in 0i64..6000,
            n in 1u32..400,
            kind in 0u8..3,
        ) {
            let repayment = [Repayment::Annuity, Repayment::Differentiated, Repayment::Bullet][kind as usize];
            let mut i = input(principal, rate_bp, n, repayment);
            if repayment == Repayment::Bullet {
                i.term_months = None;
                i.maturity_date = Some(due_date(d("2026-10-15"), n).to_string());
            }
            prop_assert_eq!(calculate(&i).unwrap().rows, legacy::calculate(&i).rows);
        }

        /// После любых платежей (по графику, частичных, больше графика, досрочных
        /// с обоими способами пересчёта) строки и отметки как у прежнего `rebuild`.
        #[test]
        fn monthly_rebuild_matches_legacy(
            principal in 100_000i64..5_000_000_000,
            rate_bp in 0i64..4000,
            term in 1u32..60,
            kind in 0u8..3,
            steps in proptest::collection::vec((0u8..5, 1i64..140, any::<bool>()), 1..20),
        ) {
            let repayment = [Repayment::Annuity, Repayment::Differentiated, Repayment::Bullet][kind as usize];
            let mut loan = input(principal, rate_bp, term, repayment);
            if repayment == Repayment::Bullet {
                loan.term_months = None;
                loan.maturity_date = Some("2027-10-15".into());
            }
            let (paid, events) = random_payments(&loan, &steps);
            let (old, old_left) = legacy::rebuild(&loan, &paid);
            let t = Terms::from_input(&loan).unwrap();
            let s = simulate(&t, &events);
            prop_assert_eq!(s.outstanding, old_left);
            let new: Vec<(Row, &str)> = s.rows.iter().map(|r| (r.row.clone(), r.status.as_str())).collect();
            prop_assert_eq!(new, old);
        }

        /// Ежедневные проценты: график всегда закрывается в 0 и покрывает остаток.
        #[test]
        fn daily_schedules_close(
            principal in 100_000i64..5_000_000_000,
            rate_bp in 0i64..4000,
            term in 1u32..120,
            diff in any::<bool>(),
            first_day in 1u32..60,
            steps in proptest::collection::vec((0u8..5, 1i64..140, any::<bool>()), 0..10),
            rate_change in proptest::option::of((1u32..100, 0i64..4000)),
            holiday in proptest::option::of((1u32..10, 1u32..6, any::<bool>())),
        ) {
            let repayment = if diff { Repayment::Differentiated } else { Repayment::Annuity };
            let mut t = daily(principal, rate_bp, term, repayment);
            t.first = t.issue + chrono::Days::new(first_day as u64);
            let mut events = Vec::new();
            if let Some((days, rate)) = rate_change {
                events.push(Event::RateChange(RateChange { from: t.issue + chrono::Days::new(days as u64 * 7), rate_bp: rate }));
            }
            if let Some((from_seq, months, io)) = holiday {
                let kind = if io { HolidayKind::InterestOnly } else { HolidayKind::Shift };
                events.push(Event::Holiday(Holiday { from_seq, months, kind }));
            }
            let s = simulate(&t, &events);
            prop_assert_eq!(s.rows.iter().map(|r| r.row.principal_part).sum::<i64>(), principal);
            let mut date = t.issue;
            for (i, &(action, pct, term_mode)) in steps.iter().enumerate() {
                let s = simulate(&t, &events);
                if s.outstanding == 0 { break; }
                let next = s.rows.iter().find(|r| r.status == Status::Pending).map(|r| r.row.clone());
                let mode = if term_mode { Recalc::ReduceTerm } else { Recalc::ReducePayment };
                date = date + chrono::Days::new(5 + i as u64);
                let left = s.outstanding;
                let p = match (action, next) {
                    (0, Some(n)) => Payment { date, principal: n.principal_part, interest: n.interest_part, seq: Some(n.seq), mode },
                    (1, Some(n)) => Payment { date, principal: (n.principal_part * pct / 100).min(left), interest: n.interest_part, seq: Some(n.seq), mode },
                    (2, _) => {
                        let (interest, principal) = split_early(&t, &events, date, (left * pct / 200).max(1));
                        Payment { date, principal, interest, seq: None, mode }
                    }
                    _ => Payment { date, principal: left, interest: 0, seq: None, mode },
                };
                if p.principal + p.interest == 0 { continue; }
                events.push(Event::Payment(p));
            }
            let s = simulate(&t, &events);
            let pending: i64 = s.rows.iter().filter(|r| r.status == Status::Pending).map(|r| r.row.principal_part).sum();
            prop_assert_eq!(pending, s.outstanding);
            if s.outstanding > 0 {
                prop_assert_eq!(s.rows.last().unwrap().row.balance_after, 0);
            }
            for r in &s.rows {
                prop_assert_eq!(r.row.payment, r.row.principal_part + r.row.interest_part);
                prop_assert!(r.row.principal_part >= 0 && r.row.interest_part >= 0);
            }
        }

        /// Срок и сумма обратны расчёту платежа.
        #[test]
        fn solve_is_inverse_of_calculate(
            principal in 100_000i64..10_000_000_000,
            rate_bp in 1i64..5000,
            n in 1u32..360,
        ) {
            let a = annuity_payment(principal, rate_bp, n);
            let m = solve_term(principal, rate_bp, a).unwrap();
            prop_assert!(m <= n);
            prop_assert_eq!(annuity_payment(principal, rate_bp, m), a);
            prop_assert!(m == 1 || annuity_payment(principal, rate_bp, m - 1) > a);
            let s = calculate(&input(principal, rate_bp, m, Repayment::Annuity)).unwrap();
            prop_assert_eq!(s.first_payment, a);

            let p = solve_principal(a, rate_bp, n).unwrap();
            prop_assert_eq!(p % 100, 0);
            prop_assert!(p >= principal / 100 * 100);
            prop_assert!(annuity_payment(p, rate_bp, n) <= a);
            prop_assert!(annuity_payment(p + 100, rate_bp, n) > a);
        }
    }
}
