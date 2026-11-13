//! Этап 8г треда 27: период Главной (Р2) и «Своя цифра» (Р1, Р14).
//!
//! Период — месяц (как в бюджете), неделя или «от зарплаты до зарплаты»:
//! с последнего крупного дохода до дня перед следующим известным доходом.
//! «Своя цифра» — карточка Главной с одной суммой: расходы, доходы, сальдо или
//! остаток, с отбором по категории, счёту и тегу. Список хранится в настройке
//! `home_figures` (JSON), значения считает ядро тем же расчётом, что отчёты.

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::reports::{self, ReportFilter};
use crate::{accounts, budgets, currencies, forecast, settings, time, Error, Result};

pub const FIGURES_KEY: &str = "home_figures";
pub const PERIOD_KEY: &str = "home_period";
pub const MEASURES: &[&str] = &["expense", "income", "saldo", "balance"];
pub const PERIODS: &[&str] = &[
    "month", "week", "payday", "quarter", "year", "days30", "custom",
];
/// Сколько дней назад ищем последнюю зарплату.
pub const PAYDAY_LOOK_BACK: i64 = 45;
pub const MAX_FIGURES: usize = 24;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Figure {
    pub id: String,
    pub title: String,
    pub measure: String,
    pub period: String,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub tag_id: Option<String>,
    /// Период «custom» — свои даты (например, прошлый месяц из отчёта), включительно.
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// Период и такой же отрезок перед ним (для сравнения «к тем же дням»).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub kind: String,
    pub from: String,
    /// Последний день включительно.
    pub to: String,
    pub prev_from: String,
    /// Прошлый отрезок той же длины, что прошло дней в текущем.
    pub prev_to: String,
    /// «От зарплаты»: дата дохода, с которого считается.
    /// `None` при kind = "payday" — крупного дохода за 45 дней нет, взят месяц.
    pub payday: Option<String>,
    /// «От зарплаты»: следующий известный доход (по нему конец периода).
    pub next_income: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigureValue {
    pub id: String,
    pub range: Range,
    pub value: i64,
    /// Тот же отрезок в прошлом периоде; у остатка — на тот же день прошлого периода.
    pub prev: Option<i64>,
    pub base_currency: String,
    pub missing_rates: Vec<String>,
}

fn date(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn same_days(
    prev_from: NaiveDate,
    from: NaiveDate,
    today: NaiveDate,
    prev_end: NaiveDate,
) -> NaiveDate {
    let elapsed = (today - from).num_days().max(0);
    (prev_from + Duration::days(elapsed)).min(prev_end)
}

/// Дата последнего крупного дохода не позже `on` (за 45 дней): самый большой доход
/// окна и всё, что не меньше его половины; из них — самый поздний.
pub fn last_payday(conn: &Connection, on: NaiveDate) -> Result<Option<NaiveDate>> {
    let base = currencies::base_currency(conn)?;
    let from = on - Duration::days(PAYDAY_LOOK_BACK);
    let mut stmt = conn.prepare_cached(
        "SELECT t.date, t.amount, a.currency_code FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE t.type = 'income' AND t.status = 'cleared' AND t.refund = 0
            AND t.debt_id IS NULL AND t.date >= ?1 AND t.date <= ?2",
    )?;
    let rows = stmt
        .query_map(params![date(from), date(on)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut incomes = Vec::new();
    for (d, amount, cur) in rows {
        if let Some(v) = currencies::convert(conn, amount, &cur, &base, &d)? {
            incomes.push((d, v));
        }
    }
    let Some(top) = incomes.iter().map(|(_, v)| *v).max() else {
        return Ok(None);
    };
    let last = incomes
        .iter()
        .filter(|(_, v)| *v * 2 >= top)
        .map(|(d, _)| d.as_str())
        .max()
        .map(time::parse_date)
        .transpose()?;
    Ok(last)
}

/// Ближайший известный доход после `today` (как в «Свободно до дохода»).
fn next_income(conn: &Connection, today: &str) -> Result<Option<String>> {
    let base = currencies::base_currency(conn)?;
    let skip = forecast::excluded_accounts(conn)?;
    let last =
        (time::parse_date(today)? + Duration::days(crate::free_money::LOOK_AHEAD_DAYS)).to_string();
    let mut missing = Vec::new();
    let items = forecast::known_items(conn, &base, today, &last, &skip, &mut missing)?;
    Ok(items
        .into_iter()
        .find(|i| i.amount > 0 && i.date.as_str() > today && i.kind != "debt")
        .map(|i| i.date))
}

fn month_range(conn: &Connection, kind: &str, today: NaiveDate) -> Result<Range> {
    let p = budgets::month_of(conn, &date(today))?;
    let from = time::parse_date(&p.start)?;
    let prev = budgets::month_of(conn, &date(from - Duration::days(1)))?;
    let pf = time::parse_date(&prev.start)?;
    Ok(Range {
        kind: kind.into(),
        from: p.start,
        to: p.end,
        prev_from: prev.start,
        prev_to: date(same_days(pf, from, today, time::parse_date(&prev.end)?)),
        payday: None,
        next_income: None,
    })
}

/// Границы периода `kind` на сегодня. `week_sunday` — неделя с воскресенья.
pub fn range(conn: &Connection, kind: &str, today: &str, week_sunday: bool) -> Result<Range> {
    let t = time::parse_date(today)?;
    match kind {
        "month" => month_range(conn, kind, t),
        "week" => {
            let wd = if week_sunday {
                t.weekday().num_days_from_sunday()
            } else {
                t.weekday().num_days_from_monday()
            } as i64;
            let from = t - Duration::days(wd);
            Ok(Range {
                kind: kind.into(),
                from: date(from),
                to: date(from + Duration::days(6)),
                prev_from: date(from - Duration::days(7)),
                prev_to: date(t - Duration::days(7)),
                payday: None,
                next_income: None,
            })
        }
        "days30" => Ok(Range {
            kind: kind.into(),
            from: date(t - Duration::days(29)),
            to: date(t),
            prev_from: date(t - Duration::days(59)),
            prev_to: date(t - Duration::days(30)),
            payday: None,
            next_income: None,
        }),
        "quarter" | "year" => {
            let m = budgets::month_of(conn, today)?.month;
            let p = reports::period_of(conn, kind, &m)?;
            let step = if kind == "quarter" { -3 } else { -12 };
            let prev = reports::period_of(conn, kind, &budgets::shift_month(&m, step)?)?;
            let (from, pf) = (time::parse_date(&p.start)?, time::parse_date(&prev.start)?);
            Ok(Range {
                kind: kind.into(),
                from: p.start,
                to: p.end,
                prev_from: prev.start,
                prev_to: date(same_days(pf, from, t, time::parse_date(&prev.end)?)),
                payday: None,
                next_income: None,
            })
        }
        "payday" => {
            let Some(from) = last_payday(conn, t)? else {
                return Ok(Range {
                    kind: kind.into(),
                    ..month_range(conn, kind, t)?
                });
            };
            let next = next_income(conn, today)?;
            let to = match &next {
                Some(n) => time::parse_date(n)? - Duration::days(1),
                None => {
                    let m = from
                        .checked_add_months(chrono::Months::new(1))
                        .unwrap_or(from);
                    (m - Duration::days(1)).max(t)
                }
            };
            let pf = last_payday(conn, from - Duration::days(1))?
                .unwrap_or(from - Duration::days((to - from).num_days() + 1));
            Ok(Range {
                kind: kind.into(),
                from: date(from),
                to: date(to),
                prev_from: date(pf),
                prev_to: date(same_days(pf, from, t, from - Duration::days(1))),
                payday: Some(date(from)),
                next_income: next,
            })
        }
        _ => Err(Error::Validation(format!("неизвестный период: {kind}"))),
    }
}

/// Период Главной из настройки `home_period` (по умолчанию месяц).
pub fn home_range(conn: &Connection, today: &str, week_sunday: bool) -> Result<Range> {
    let kind = settings::get(conn, PERIOD_KEY)?.unwrap_or_default();
    let kind = if matches!(kind.as_str(), "week" | "payday") {
        kind
    } else {
        "month".into()
    };
    range(conn, &kind, today, week_sunday)
}

pub fn list(conn: &Connection) -> Result<Vec<Figure>> {
    Ok(settings::get(conn, FIGURES_KEY)?
        .and_then(|v| serde_json::from_str::<Vec<Figure>>(&v).ok())
        .unwrap_or_default())
}

pub fn check(f: &Figure) -> Result<()> {
    let bad = |m: &str| Err(Error::Validation(m.into()));
    if f.id.trim().is_empty() {
        return bad("у цифры нет id");
    }
    if f.title.trim().is_empty() || f.title.chars().count() > 60 {
        return bad("название цифры — от 1 до 60 знаков");
    }
    if !MEASURES.contains(&f.measure.as_str()) {
        return bad("неизвестная величина");
    }
    if !PERIODS.contains(&f.period.as_str()) {
        return bad("неизвестный период");
    }
    if f.period == "custom" {
        let (Some(a), Some(b)) = (&f.from, &f.to) else {
            return bad("у своего периода нужны даты «с» и «по»");
        };
        if time::parse_date(a)? > time::parse_date(b)? {
            return bad("дата «с» позже даты «по»");
        }
    }
    if f.measure == "balance" && (f.category_id.is_some() || f.tag_id.is_some()) {
        return bad("остаток считается по счёту, без категории и тега");
    }
    Ok(())
}

/// Сохранить список цифр целиком (порядок — как в списке).
pub fn save(conn: &Connection, figures: &[Figure]) -> Result<()> {
    if figures.len() > MAX_FIGURES {
        return Err(Error::Validation(format!("не больше {MAX_FIGURES} цифр")));
    }
    for f in figures {
        check(f)?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES (?1, ?2)",
        params![
            FIGURES_KEY,
            serde_json::to_string(figures).expect("сериализуется")
        ],
    )?;
    Ok(())
}

/// Сумма категории: у верхней — вместе с подкатегориями, у подкатегории — своя.
fn find(items: &[reports::CategoryItem], id: &str) -> Option<i64> {
    items
        .iter()
        .find(|i| i.category_id == id)
        .map(|i| i.amount)
        .or_else(|| {
            items
                .iter()
                .flat_map(|i| &i.children)
                .find(|c| c.category_id == id)
                .map(|c| c.amount)
        })
}

fn flow(
    conn: &Connection,
    f: &Figure,
    kind: &str,
    from: &str,
    to: &str,
    missing: &mut Vec<String>,
) -> Result<i64> {
    let filter = ReportFilter {
        account_id: f.account_id.clone(),
        tag_id: f.tag_id.clone(),
    };
    let r = reports::by_category_in(conn, kind, from, to, &filter)?;
    for m in r.missing_rates {
        if !missing.contains(&m) {
            missing.push(m);
        }
    }
    Ok(match &f.category_id {
        Some(c) => find(&r.items, c).unwrap_or(0),
        None => r.total,
    })
}

fn measure(
    conn: &Connection,
    f: &Figure,
    from: &str,
    to: &str,
    missing: &mut Vec<String>,
) -> Result<i64> {
    Ok(match f.measure.as_str() {
        "expense" => flow(conn, f, "expense", from, to, missing)?,
        "income" => flow(conn, f, "income", from, to, missing)?,
        "saldo" => {
            flow(conn, f, "income", from, to, missing)?
                - flow(conn, f, "expense", from, to, missing)?
        }
        _ => balance(conn, f.account_id.as_deref(), to, missing)?,
    })
}

fn balance(
    conn: &Connection,
    account: Option<&str>,
    on: &str,
    missing: &mut Vec<String>,
) -> Result<i64> {
    let Some(id) = account else {
        let t = accounts::totals(conn, on)?;
        for m in t.missing_rates {
            if !missing.contains(&m) {
                missing.push(m);
            }
        }
        return Ok(t.total);
    };
    let base = currencies::base_currency(conn)?;
    let (cur, kind): (String, String) = conn.query_row(
        "SELECT currency_code, type FROM accounts WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // Инвестиционный счёт — по оценке, как в общем балансе.
    let bal = if kind == "investment" {
        crate::invest::value_on(conn, id, on)?.0
    } else {
        accounts::balance(conn, id, Some(on))?
    };
    Ok(match currencies::convert(conn, bal, &cur, &base, on)? {
        Some(v) => v,
        None => {
            if !missing.contains(&cur) {
                missing.push(cur);
            }
            0
        }
    })
}

/// Период цифры: свой (даты из отчёта) или относительный на сегодня.
fn figure_range(conn: &Connection, f: &Figure, today: &str, week_sunday: bool) -> Result<Range> {
    if f.period != "custom" {
        return range(conn, &f.period, today, week_sunday);
    }
    let (Some(a), Some(b)) = (&f.from, &f.to) else {
        return Err(Error::Validation("у своего периода нужны даты".into()));
    };
    let (from, to) = (time::parse_date(a)?, time::parse_date(b)?);
    let len = (to - from).num_days() + 1;
    Ok(Range {
        kind: "custom".into(),
        from: date(from),
        to: date(to),
        prev_from: date(from - Duration::days(len)),
        prev_to: date(from - Duration::days(1)),
        payday: None,
        next_income: None,
    })
}

/// Значение одной цифры на сегодня.
pub fn value(conn: &Connection, f: &Figure, today: &str, week_sunday: bool) -> Result<FigureValue> {
    let range = figure_range(conn, f, today, week_sunday)?;
    let mut missing = Vec::new();
    // Остаток — на сегодня (или на конец прошедшего периода), поток — за весь период.
    let to_now = if f.measure == "balance" {
        today.min(range.to.as_str()).to_string()
    } else {
        range.to.clone()
    };
    let value = measure(conn, f, &range.from, &to_now, &mut missing)?;
    let prev = Some(measure(
        conn,
        f,
        &range.prev_from,
        &range.prev_to,
        &mut missing,
    )?);
    Ok(FigureValue {
        id: f.id.clone(),
        range,
        value,
        prev,
        base_currency: currencies::base_currency(conn)?,
        missing_rates: missing,
    })
}

/// Значения всех цифр. Цифра, у которой пропал счёт или категория, даёт 0.
pub fn values(conn: &Connection, today: &str, week_sunday: bool) -> Result<Vec<FigureValue>> {
    list(conn)?
        .iter()
        .map(|f| match value(conn, f, today, week_sunday) {
            Err(Error::Db(rusqlite::Error::QueryReturnedNoRows)) => {
                let range = figure_range(conn, f, today, week_sunday)?;
                Ok(FigureValue {
                    id: f.id.clone(),
                    range,
                    value: 0,
                    prev: None,
                    base_currency: currencies::base_currency(conn)?,
                    missing_rates: Vec::new(),
                })
            }
            v => v,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::categories;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn txn(c: &Connection, account: &str, kind: &str, date: &str, amount: i64, category: &str) {
        transactions::create(
            c,
            &TxnInput {
                kind: kind.into(),
                date: date.into(),
                account_id: account.into(),
                amount,
                category_id: Some(cat(c, category)),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
    }

    fn fig(id: &str, measure: &str, period: &str) -> Figure {
        Figure {
            id: id.into(),
            title: id.into(),
            measure: measure.into(),
            period: period.into(),
            category_id: None,
            account_id: None,
            tag_id: None,
            from: None,
            to: None,
        }
    }

    #[test]
    fn periods_week_payday_and_month() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();

        // Чт 12.11.2026: неделя с понедельника 09.11 или с воскресенья 08.11.
        let w = range(c, "week", "2026-11-12", false).unwrap();
        assert_eq!(
            (w.from.as_str(), w.to.as_str(), w.prev_to.as_str()),
            ("2026-11-09", "2026-11-15", "2026-11-05")
        );
        assert_eq!(
            range(c, "week", "2026-11-12", true).unwrap().from,
            "2026-11-08"
        );

        let m = range(c, "month", "2026-11-12", false).unwrap();
        assert_eq!(
            (m.from.as_str(), m.to.as_str()),
            ("2026-11-01", "2026-11-30")
        );
        assert_eq!(
            (m.prev_from.as_str(), m.prev_to.as_str()),
            ("2026-10-01", "2026-10-12")
        );

        // Без доходов «от зарплаты» = месяц.
        let p = range(c, "payday", "2026-11-12", false).unwrap();
        assert_eq!((p.from.as_str(), p.payday), ("2026-11-01", None));

        // Зарплата 05.10 и 05.11, аванс 20.10 меньше половины — не считается.
        txn(
            c,
            &card,
            "income",
            "2026-10-05",
            10_000_000,
            "Заработная плата",
        );
        txn(
            c,
            &card,
            "income",
            "2026-10-20",
            3_000_000,
            "Заработная плата",
        );
        txn(
            c,
            &card,
            "income",
            "2026-11-05",
            10_000_000,
            "Заработная плата",
        );
        let p = range(c, "payday", "2026-11-12", false).unwrap();
        assert_eq!(p.payday.as_deref(), Some("2026-11-05"));
        assert_eq!(
            (p.from.as_str(), p.to.as_str()),
            ("2026-11-05", "2026-12-04")
        );
        assert_eq!(
            (p.prev_from.as_str(), p.prev_to.as_str()),
            ("2026-10-05", "2026-10-12")
        );
        assert!(range(c, "fortnight", "2026-11-12", false).is_err());
    }

    #[test]
    fn figures_sum_like_reports_and_validate() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 100_000)).unwrap();
        let cash = accounts::create(c, &input("Наличные", "cash", "RUB", 0)).unwrap();
        txn(c, &card, "expense", "2026-11-03", 300_000, "Общепит");
        txn(c, &card, "expense", "2026-11-04", 200_000, "Обеды");
        txn(c, &cash, "expense", "2026-11-04", 50_000, "Обеды");
        txn(c, &card, "expense", "2026-10-04", 70_000, "Общепит");
        txn(
            c,
            &card,
            "income",
            "2026-11-02",
            1_000_000,
            "Заработная плата",
        );

        let mut cafe = fig("cafe", "expense", "month");
        cafe.category_id = Some(cat(c, "Общепит"));
        let mut lunch_card = fig("lunch", "expense", "month");
        lunch_card.category_id = Some(cat(c, "Обеды"));
        lunch_card.account_id = Some(card.clone());
        let mut bal = fig("bal", "balance", "month");
        bal.account_id = Some(card.clone());
        save(c, &[cafe, lunch_card, fig("saldo", "saldo", "month"), bal]).unwrap();

        let v = values(c, "2026-11-12", false).unwrap();
        let by = |id: &str| v.iter().find(|x| x.id == id).unwrap();
        assert_eq!((by("cafe").value, by("cafe").prev), (550_000, Some(70_000)));
        assert_eq!(by("lunch").value, 200_000);
        assert_eq!(by("saldo").value, 1_000_000 - 550_000);
        assert_eq!(
            by("bal").value,
            100_000 - 300_000 - 200_000 - 70_000 + 1_000_000
        );

        let mut bad = fig("x", "balance", "month");
        bad.category_id = Some(cat(c, "Обеды"));
        assert!(save(c, &[bad]).is_err());
        assert!(save(c, &[fig("y", "expense", "decade")]).is_err());
        assert!(save(c, &[fig("", "expense", "month")]).is_err());
        assert_eq!(
            list(c).unwrap().len(),
            4,
            "неудачная запись не трогает список"
        );

        // Инвестиционный счёт — по оценке: внесено 100 000, стоит 140 000.
        let iis = accounts::create(c, &input("ИИС", "investment", "RUB", 10_000_000)).unwrap();
        crate::invest::set_value(c, &iis, "2026-11-01", 14_000_000).unwrap();
        let mut inv = fig("iis", "balance", "month");
        inv.account_id = Some(iis);
        assert_eq!(
            value(c, &inv, "2026-11-12", false).unwrap().value,
            14_000_000
        );

        // Свой период — октябрь из отчёта.
        let mut oct = fig("oct", "expense", "custom");
        assert!(save(c, &[oct.clone()]).is_err(), "без дат нельзя");
        (oct.from, oct.to) = (Some("2026-10-01".into()), Some("2026-10-31".into()));
        let v = value(c, &oct, "2026-11-12", false).unwrap();
        assert_eq!(
            (v.value, v.range.prev_from.as_str()),
            (70_000, "2026-08-31")
        );

        settings::set(c, PERIOD_KEY, "week").unwrap();
        assert_eq!(home_range(c, "2026-11-12", false).unwrap().kind, "week");
        assert!(settings::set(c, PERIOD_KEY, "year").is_err());
    }
}
