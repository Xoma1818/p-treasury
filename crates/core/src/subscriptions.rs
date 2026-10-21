//! Подписки и регулярные платежи: приложение само находит расходы, которые
//! повторяются у одного получателя с ровным шагом (неделя, месяц, квартал, год)
//! и почти одной суммой, и показывает, сколько они стоят в год.

use std::collections::HashMap;

use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{currencies, settings, time, Result};

/// Сколько дней истории просматривать.
const LOOKBACK_DAYS: i64 = 400;
/// Насколько сумма может отличаться от обычной (доля).
const AMOUNT_TOLERANCE: f64 = 0.15;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    /// Получатель в нижнем регистре: по нему подписку можно скрыть.
    pub key: String,
    pub payee: String,
    pub category_name: Option<String>,
    /// `week`, `month`, `quarter`, `year`.
    pub period: String,
    /// Обычная сумма платежа в валюте счёта.
    pub amount: i64,
    pub currency_symbol: String,
    pub minor_units: u32,
    /// Обычная сумма в основной валюте.
    pub base_amount: Option<i64>,
    /// Сколько выходит в год, в основной валюте.
    pub yearly: Option<i64>,
    pub count: usize,
    pub last_date: String,
    /// Когда ждать следующий платёж.
    pub next_date: String,
    /// Скрыта пользователем («это не подписка»).
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionsReport {
    pub base_currency: String,
    pub items: Vec<Subscription>,
    /// Сумма в год по видимым подпискам.
    pub yearly_total: i64,
    pub monthly_total: i64,
}

struct Period {
    name: &'static str,
    days: i64,
    min: i64,
    max: i64,
    per_year: f64,
    /// Сколько платежей нужно, чтобы поверить в регулярность.
    min_count: usize,
}

const PERIODS: [Period; 4] = [
    Period {
        name: "week",
        days: 7,
        min: 6,
        max: 8,
        per_year: 52.0,
        min_count: 4,
    },
    Period {
        name: "month",
        days: 30,
        min: 26,
        max: 35,
        per_year: 12.0,
        min_count: 3,
    },
    Period {
        name: "quarter",
        days: 91,
        min: 84,
        max: 98,
        per_year: 4.0,
        min_count: 3,
    },
    Period {
        name: "year",
        days: 365,
        min: 350,
        max: 380,
        per_year: 1.0,
        min_count: 2,
    },
];

struct Payment {
    date: NaiveDate,
    amount: i64,
    payee: String,
    category: Option<String>,
    currency: String,
    symbol: String,
    minor: u32,
}

fn median(mut v: Vec<i64>) -> i64 {
    v.sort_unstable();
    v[v.len() / 2]
}

/// Регулярные платежи на дату `today`; прекратившиеся (платёж пропущен больше
/// чем на полпериода) не показываются.
pub fn list(conn: &Connection, today: &str) -> Result<SubscriptionsReport> {
    let today_d = time::parse_date(today)?;
    let since = (today_d - Duration::days(LOOKBACK_DAYS)).to_string();
    let base = currencies::base_currency(conn)?;
    let hidden: Vec<String> = settings::get(conn, "subscriptions_hidden")?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let mut stmt = conn.prepare(
        "SELECT t.date, t.amount, trim(t.payee), c.name, a.currency_code, cur.symbol, cur.minor_units
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN currencies cur ON cur.code = a.currency_code
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'cleared' AND t.type = 'expense' AND trim(coalesce(t.payee, '')) <> ''
           AND t.date BETWEEN ?1 AND ?2
         ORDER BY t.date",
    )?;
    let rows = stmt.query_map(params![since, today], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, u32>(6)?,
        ))
    })?;
    let mut groups: HashMap<(String, String), Vec<Payment>> = HashMap::new();
    for row in rows {
        let (date, amount, payee, category, currency, symbol, minor) = row?;
        let Ok(date) = time::parse_date(&date) else {
            continue;
        };
        groups
            .entry((payee.to_lowercase(), currency.clone()))
            .or_default()
            .push(Payment {
                date,
                amount,
                payee,
                category,
                currency,
                symbol,
                minor,
            });
    }
    let mut items = Vec::new();
    for ((key, _), pays) in groups {
        if let Some(s) = detect(conn, &key, &pays, today_d, &base, &hidden)? {
            items.push(s);
        }
    }
    items.sort_by(|a, b| {
        b.yearly
            .unwrap_or(0)
            .cmp(&a.yearly.unwrap_or(0))
            .then_with(|| a.key.cmp(&b.key))
    });
    let yearly_total: i64 = items
        .iter()
        .filter(|s| !s.hidden)
        .filter_map(|s| s.yearly)
        .sum();
    Ok(SubscriptionsReport {
        base_currency: base,
        items,
        yearly_total,
        monthly_total: (yearly_total as f64 / 12.0).round() as i64,
    })
}

fn detect(
    conn: &Connection,
    key: &str,
    pays: &[Payment],
    today: NaiveDate,
    base: &str,
    hidden: &[String],
) -> Result<Option<Subscription>> {
    // Несколько покупок в один день у одного получателя — это не подписка.
    let mut dates: Vec<NaiveDate> = pays.iter().map(|p| p.date).collect();
    dates.dedup();
    if dates.len() != pays.len() || pays.len() < 2 {
        return Ok(None);
    }
    let gaps: Vec<i64> = dates.windows(2).map(|w| (w[1] - w[0]).num_days()).collect();
    let typical_gap = median(gaps.clone());
    let Some(period) = PERIODS
        .iter()
        .find(|p| (p.min..=p.max).contains(&typical_gap))
    else {
        return Ok(None);
    };
    if pays.len() < period.min_count {
        return Ok(None);
    }
    // Один пропуск или лишний платёж допустим, если платежей много.
    let off = gaps
        .iter()
        .filter(|g| !(period.min..=period.max).contains(*g))
        .count();
    if off > usize::from(gaps.len() >= 4) {
        return Ok(None);
    }
    let recent: Vec<i64> = pays.iter().rev().take(3).map(|p| p.amount).collect();
    let amount = median(recent.clone());
    if recent
        .iter()
        .any(|&a| ((a - amount).abs() as f64) > amount as f64 * AMOUNT_TOLERANCE)
    {
        return Ok(None);
    }
    let last = pays.last().expect("не пусто");
    if (today - last.date).num_days() > period.days + period.days / 2 {
        return Ok(None);
    }
    let mut next = last.date + Duration::days(period.days);
    if period.name == "month" {
        next = last
            .date
            .checked_add_months(chrono::Months::new(1))
            .unwrap_or(next);
    } else if period.name == "year" {
        next = last
            .date
            .checked_add_months(chrono::Months::new(12))
            .unwrap_or(next);
    }
    let base_amount =
        currencies::convert(conn, amount, &last.currency, base, &last.date.to_string())?;
    Ok(Some(Subscription {
        key: key.to_string(),
        payee: last.payee.clone(),
        category_name: last.category.clone(),
        period: period.name.to_string(),
        amount,
        currency_symbol: last.symbol.clone(),
        minor_units: last.minor,
        base_amount,
        yearly: base_amount.map(|v| (v as f64 * period.per_year).round() as i64),
        count: pays.len(),
        last_date: last.date.to_string(),
        next_date: next.to_string(),
        hidden: hidden.iter().any(|h| h == key),
    }))
}

/// Скрыть подписку («это не подписка») или вернуть её.
pub fn set_hidden(conn: &Connection, key: &str, hide: bool) -> Result<()> {
    let mut hidden: Vec<String> = settings::get(conn, "subscriptions_hidden")?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    hidden.retain(|h| h != key);
    if hide {
        hidden.push(key.to_string());
    }
    settings::set(
        conn,
        "subscriptions_hidden",
        &serde_json::to_string(&hidden).expect("json"),
    )
}

/// Регулярные платежи, которые спишутся сегодня или завтра и о которых ещё не
/// напоминали; они сразу отмечаются напомненными (по дате платежа). Выключаются
/// настройкой `subs_remind`.
pub fn due_unnotified(conn: &Connection, today: &str) -> Result<Vec<Subscription>> {
    if settings::get(conn, "subs_remind")?.as_deref() == Some("0") {
        return Ok(Vec::new());
    }
    let tomorrow = (time::parse_date(today)? + Duration::days(1)).to_string();
    let mut notified: HashMap<String, String> = settings::get(conn, "subs_notified")?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    let due: Vec<Subscription> = list(conn, today)?
        .items
        .into_iter()
        .filter(|s| {
            !s.hidden
                && (today..=tomorrow.as_str()).contains(&s.next_date.as_str())
                && notified.get(&s.key) != Some(&s.next_date)
        })
        .collect();
    if !due.is_empty() {
        // Старые отметки не копятся: остаются только у платежей из списка.
        notified.retain(|_, date| date.as_str() >= today);
        for s in &due {
            notified.insert(s.key.clone(), s.next_date.clone());
        }
        settings::set(
            conn,
            "subs_notified",
            &serde_json::to_string(&notified).expect("json"),
        )?;
    }
    Ok(due)
}

/// Текст уведомления: «Завтра спишется: Яндекс Плюс — 399 ₽».
pub fn reminder_text(due: &[Subscription], today: &str) -> String {
    let when = |s: &Subscription| {
        if s.next_date == today {
            "Сегодня"
        } else {
            "Завтра"
        }
    };
    let item = |s: &Subscription| {
        format!(
            "{} — {} {}",
            s.payee,
            crate::money::format_amount(s.amount, s.minor_units, true),
            s.currency_symbol
        )
    };
    match due {
        [one] => format!("{} спишется: {}", when(one), item(one)),
        _ => {
            let today_n = due.iter().filter(|s| s.next_date == today).count();
            let when = match today_n {
                0 => "Завтра",
                n if n == due.len() => "Сегодня",
                _ => "Сегодня и завтра",
            };
            format!(
                "{when} спишутся: {}",
                due.iter().map(item).collect::<Vec<_>>().join(", ")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, AccountInput};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn spend(c: &Connection, acc: &str, date: &str, amount: i64, payee: &str) {
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: acc.into(),
                amount,
                category_id: Some("cat".into()),
                to_account_id: None,
                to_amount: None,
                payee: Some(payee.into()),
                note: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn finds_monthly_and_yearly_and_skips_noise() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        c.execute(
            "INSERT INTO categories (id, name, kind, created_at, updated_at) VALUES ('cat', 'Связь', 'expense', '', '')",
            [],
        )
        .unwrap();
        let acc = accounts::create(
            c,
            &AccountInput {
                name: "Карта".into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 10_000_000,
                opening_date: "2025-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap();
        for d in [
            "2026-06-05",
            "2026-07-05",
            "2026-08-04",
            "2026-09-05",
            "2026-10-05",
        ] {
            spend(c, &acc, d, 29_900, "Яндекс Плюс");
        }
        for d in ["2025-10-02", "2026-10-01"] {
            spend(c, &acc, d, 199_000, "Касперский");
        }
        // Продукты: часто, но неровно и разными суммами.
        for (d, a) in [
            ("2026-09-01", 120_000),
            ("2026-09-03", 450_000),
            ("2026-09-20", 80_000),
            ("2026-10-02", 230_000),
        ] {
            spend(c, &acc, d, a, "Пятёрочка");
        }
        // Старая подписка, которую отменили весной.
        for d in ["2026-01-10", "2026-02-10", "2026-03-10"] {
            spend(c, &acc, d, 50_000, "Кинопоиск");
        }
        let r = list(c, "2026-10-21").unwrap();
        let keys: Vec<&str> = r.items.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(keys, ["яндекс плюс", "касперский"], "дороже в год — выше");
        let plus = &r.items[0];
        assert_eq!(
            (plus.period.as_str(), plus.amount, plus.yearly),
            ("month", 29_900, Some(358_800))
        );
        assert_eq!(plus.next_date, "2026-11-05");
        assert_eq!(r.items[1].period, "year");
        assert_eq!(r.yearly_total, 199_000 + 358_800);

        set_hidden(c, "касперский", true).unwrap();
        let r = list(c, "2026-10-21").unwrap();
        assert!(r.items[1].hidden);
        assert_eq!(r.yearly_total, 358_800);
        set_hidden(c, "касперский", false).unwrap();
        assert!(!list(c, "2026-10-21").unwrap().items[1].hidden);

        // Напоминание накануне платежа 05.11 приходит один раз.
        assert!(due_unnotified(c, "2026-11-02").unwrap().is_empty());
        let due = due_unnotified(c, "2026-11-04").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(
            reminder_text(&due, "2026-11-04"),
            "Завтра спишется: Яндекс Плюс — 299 ₽"
        );
        assert!(due_unnotified(c, "2026-11-04").unwrap().is_empty());
        assert!(
            due_unnotified(c, "2026-11-05").unwrap().is_empty(),
            "в день платежа о нём уже не напоминаем"
        );
        // Выключатель в Настройках.
        settings::set(c, "subs_notified", "{}").unwrap();
        settings::set(c, "subs_remind", "0").unwrap();
        assert!(due_unnotified(c, "2026-11-04").unwrap().is_empty());
    }
}
