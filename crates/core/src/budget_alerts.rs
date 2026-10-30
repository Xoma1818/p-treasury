//! Предупреждения о лимите бюджета (А1): расход перевёл категорию через 80 %
//! или 100 % лимита месяца — одно уведомление Windows на порог, категорию и
//! месяц. Отметки хранятся в таблице `budget_alerts`, поэтому после
//! перезапуска программы порог не повторяется. Факт берётся из бюджета:
//! поездки и события вне бюджета туда не входят и порогов не вызывают.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::{budgets, currencies, money, settings, time, Result};

/// Порог «скоро лимит», в процентах.
pub const WARN_PERCENT: i64 = 80;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// Бюджетный месяц `2026-10`.
    pub month: String,
    pub category_id: String,
    pub category_name: String,
    /// 80 — потрачено 80 % и больше, 100 — потрачено 100 % и больше.
    pub level: i64,
    pub actual: i64,
    pub limit: i64,
    pub percent: i64,
    /// Текст уведомления: «Кафе: потрачено 82 % бюджета (8 200 из 10 000 ₽)».
    pub text: String,
    /// Почему предупреждаем: темп трат относительно прошедшей части месяца,
    /// сколько осталось и на сколько дней, где чаще всего тратили.
    pub reason: String,
    /// Период бюджетного месяца — для «Посмотреть операции».
    pub start: String,
    pub end: String,
    /// Ключ для «Понятно»: `budget:2026-10:<категория>:80`.
    pub key: String,
}

/// Текст уведомления Windows: что случилось, почему и что сделать.
pub fn notify_text(a: &Alert) -> String {
    format!(
        "{}\n{}\nГлавная → «Проверьте»: посмотреть операции или изменить план.",
        a.text, a.reason
    )
}

/// Предупреждения бюджета, которые сейчас в силе (для «Проверьте» на Главной):
/// категории текущего месяца, где потрачено 80 % лимита и больше. Скрытые
/// кнопкой «Понятно» не показываются, но превышение после «Понятно» на 80 %
/// приходит снова — у него свой ключ.
pub fn active(conn: &Connection, today: &str) -> Result<Vec<Alert>> {
    if !enabled(conn)? {
        return Ok(Vec::new());
    }
    let dismissed: Vec<String> = conn
        .prepare("SELECT key FROM check_dismissed WHERE key LIKE 'budget:%'")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = build(conn, today, |_, _, level| Ok(Some(level)))?;
    out.retain(|a| !dismissed.contains(&a.key));
    out.sort_by(|a, b| b.level.cmp(&a.level).then(b.percent.cmp(&a.percent)));
    Ok(out)
}

/// Включены ли предупреждения (настройка «Предупреждать о бюджете»).
pub fn enabled(conn: &Connection) -> Result<bool> {
    Ok(settings::get(conn, "budget_alerts")?.as_deref() != Some("0"))
}

fn marked(conn: &Connection, month: &str, category: &str, level: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM budget_alerts WHERE month = ?1 AND category_id = ?2 AND level = ?3",
            params![month, category, level],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn mark(conn: &Connection, month: &str, category: &str, level: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO budget_alerts (month, category_id, level, notified_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![month, category, level, time::now_utc()],
    )?;
    Ok(())
}

/// Новые пороги бюджета текущего месяца на `today`. Найденные сразу отмечаются
/// показанными: вызывающий (фоновая задача) показывает их тексты один раз.
/// Если категория сразу перешла 100 %, приходит одно сообщение о превышении.
///
/// Самый первый вызов (нет отметки `budget_alerts_seeded`, например сразу после
/// обновления базы в середине месяца) молча отмечает уже пройденные пороги
/// текущего месяца: уведомления придут только о новых.
pub fn pending(conn: &Connection, today: &str) -> Result<Vec<Alert>> {
    let seeding = settings::get(conn, SEEDED_KEY)?.is_none();
    if !seeding && !enabled(conn)? {
        return Ok(Vec::new());
    }
    let out = crossed(conn, today)?;
    if seeding {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
            [SEEDED_KEY],
        )?;
        return Ok(Vec::new());
    }
    Ok(out)
}

/// Служебная отметка: пороги, пройденные до первой проверки, уже отмечены.
pub const SEEDED_KEY: &str = "budget_alerts_seeded";

/// Пороги, пройденные впервые; найденные сразу отмечаются.
fn crossed(conn: &Connection, today: &str) -> Result<Vec<Alert>> {
    build(conn, today, |month, category, level| {
        let fresh = if level == 100 {
            !marked(conn, month, category, 100)?
        } else {
            !marked(conn, month, category, WARN_PERCENT)?
        };
        if !fresh {
            return Ok(None);
        }
        // Сразу за 100 %: предупреждение о 80 % уже не нужно.
        for lv in [WARN_PERCENT, 100].into_iter().filter(|lv| *lv <= level) {
            mark(conn, month, category, lv)?;
        }
        Ok(Some(level))
    })
}

/// Предупреждения по строкам бюджета текущего месяца. `pick` получает месяц,
/// категорию и достигнутый порог (80 или 100) и решает, показывать ли его.
fn build(
    conn: &Connection,
    today: &str,
    mut pick: impl FnMut(&str, &str, i64) -> Result<Option<i64>>,
) -> Result<Vec<Alert>> {
    let period = budgets::month_of(conn, today)?;
    let month = period.month.clone();
    let budget = budgets::get(conn, &month, today)?;
    if budget.id.is_none() {
        return Ok(Vec::new());
    }
    let minor = currencies::minor_units(conn, &budget.currency_code)?;
    let fmt = |v: i64| money::format_amount(v, minor, true);
    let sym = budget.currency_symbol.as_str();
    let days = |a: &str, b: &str| -> i64 {
        match (
            chrono::NaiveDate::parse_from_str(a, "%Y-%m-%d"),
            chrono::NaiveDate::parse_from_str(b, "%Y-%m-%d"),
        ) {
            (Ok(a), Ok(b)) => (b - a).num_days() + 1,
            _ => 0,
        }
    };
    let total_days = days(&period.start, &period.end).max(1);
    let passed = days(&period.start, today).clamp(1, total_days);
    let left_days = total_days - passed;
    let mut out = Vec::new();
    for l in budget
        .lines
        .iter()
        .filter(|l| l.kind == "expense" && l.limit > 0)
    {
        // Как у полосы бюджета: 100 % и больше — красный порог.
        let reached = if l.actual >= l.limit {
            100
        } else if l.actual as i128 * 100 >= l.limit as i128 * WARN_PERCENT as i128 {
            WARN_PERCENT
        } else {
            continue;
        };
        let Some(level) = pick(&month, &l.category_id, reached)? else {
            continue;
        };
        let text = if level == 100 && l.actual == l.limit {
            format!(
                "{}: бюджет исчерпан ({} {sym})",
                l.category_name,
                fmt(l.limit)
            )
        } else if level == 100 {
            format!(
                "{}: бюджет превышен на {} {sym}",
                l.category_name,
                fmt(l.actual - l.limit)
            )
        } else {
            format!(
                "{}: потрачено {} % бюджета ({} из {} {sym})",
                l.category_name,
                l.percent,
                fmt(l.actual),
                fmt(l.limit)
            )
        };
        let month_pct = passed * 100 / total_days;
        let mut reason = if level == 100 {
            if left_days > 0 {
                format!(
                    "Лимит {} {sym} закончился за {passed} {} из {total_days}; до конца месяца ещё {left_days} {}.",
                    fmt(l.limit),
                    plural(passed, "день", "дня", "дней"),
                    plural(left_days, "день", "дня", "дней")
                )
            } else {
                format!("Лимит {} {sym} закончился к концу месяца.", fmt(l.limit))
            }
        } else {
            let left = l.limit - l.actual;
            let per_day = if left_days > 0 {
                left / left_days
            } else {
                left
            };
            format!(
                "Месяц прошёл на {month_pct} %, а лимит потрачен на {} %. Осталось {} {sym} на {} {} — около {} {sym} в день.",
                l.percent,
                fmt(left),
                left_days.max(1),
                plural(left_days.max(1), "день", "дня", "дней"),
                fmt(per_day)
            )
        };
        if let Some((payee, n, all)) = top_payee(conn, &l.category_id, &period.start, today)? {
            reason.push_str(&format!(
                " Чаще всего — «{payee}»: {n} из {all} {}.",
                plural(all, "операции", "операций", "операций")
            ));
        }
        out.push(Alert {
            key: format!("budget:{month}:{}:{level}", l.category_id),
            month: month.clone(),
            category_id: l.category_id.clone(),
            category_name: l.category_name.clone(),
            level,
            actual: l.actual,
            limit: l.limit,
            percent: l.percent,
            text,
            reason,
            start: period.start.clone(),
            end: period.end.clone(),
        });
    }
    Ok(out)
}

/// Самый частый получатель в категории (с подкатегориями) за период: имя,
/// сколько у него операций и сколько операций всего. Нет получателей — `None`.
fn top_payee(
    conn: &Connection,
    category: &str,
    from: &str,
    to: &str,
) -> Result<Option<(String, i64, i64)>> {
    const IN_CATEGORY: &str = "t.type = 'expense' AND t.date BETWEEN ?2 AND ?3
        AND (t.category_id = ?1 OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?1))";
    let all: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM transactions t WHERE {IN_CATEGORY}"),
        params![category, from, to],
        |r| r.get(0),
    )?;
    let top: Option<(String, i64)> = conn
        .query_row(
            &format!(
                "SELECT trim(t.payee), COUNT(*) AS n FROM transactions t
                 WHERE {IN_CATEGORY} AND trim(COALESCE(t.payee, '')) <> ''
                 GROUP BY lower(trim(t.payee)) ORDER BY n DESC, max(t.date) DESC LIMIT 1"
            ),
            params![category, from, to],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    // Один получатель из одной операции — не закономерность.
    Ok(top.filter(|(_, n)| *n >= 2).map(|(p, n)| (p, n, all)))
}

fn plural<'a>(n: i64, one: &'a str, few: &'a str, many: &'a str) -> &'a str {
    let (n10, n100) = (n % 10, n % 100);
    if n10 == 1 && n100 != 11 {
        one
    } else if (2..=4).contains(&n10) && !(12..=14).contains(&n100) {
        few
    } else {
        many
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};
    use crate::{categories, events};

    fn spend(c: &Connection, card: &str, cat: &str, date: &str, amount: i64) -> String {
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: card.into(),
                amount,
                category_id: Some(cat.into()),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn thresholds_fire_once_per_category_and_month() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let cafe: String = db
            .conn()
            .query_row(
                "SELECT id FROM categories WHERE name = 'Кафе и рестораны'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let budget = budgets::create(db.conn_mut(), "2026-10", false).unwrap();
        let c = db.conn();
        budgets::set_limit(c, &budget, &cafe, Some(1_000_000)).unwrap();
        let today = "2026-10-20";

        // Первая проверка уже была (отметка есть): пороги приходят как обычно.
        assert!(pending(c, today).unwrap().is_empty());
        spend(c, &card, &cafe, "2026-10-03", 700_000);
        assert!(pending(c, today).unwrap().is_empty(), "70 % — рано");

        // Поездка вне бюджета порог не вызывает.
        let trip = events::create(
            c,
            &events::EventInput {
                name: "Казань".into(),
                start_date: "2026-10-10".into(),
                end_date: "2026-10-12".into(),
                budget: None,
                note: None,
            },
        )
        .unwrap();
        let t = spend(c, &card, &cafe, "2026-10-10", 500_000);
        events::assign(c, Some(&trip), &[t]).unwrap();
        assert!(pending(c, today).unwrap().is_empty());

        spend(c, &card, &cafe, "2026-10-15", 120_000);
        let a = pending(c, today).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].level, 80);
        assert_eq!(
            a[0].text,
            "Кафе и рестораны: потрачено 82 % бюджета (8\u{a0}200 из 10\u{a0}000 ₽)"
        );
        assert!(
            pending(c, today).unwrap().is_empty(),
            "второй раз не приходит"
        );

        spend(c, &card, &cafe, "2026-10-18", 300_000);
        let a = pending(c, today).unwrap();
        assert_eq!(a[0].level, 100);
        assert_eq!(
            a[0].text,
            "Кафе и рестораны: бюджет превышен на 1\u{a0}200 ₽"
        );
        assert!(pending(c, today).unwrap().is_empty());

        // Отметки в базе: после «перезапуска» (новый вызов) порог не повторяется,
        // а выключатель глушит предупреждения.
        let marks: i64 = c
            .query_row("SELECT count(*) FROM budget_alerts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(marks, 2);
        settings::set(c, "budget_alerts", "0").unwrap();
        c.execute("DELETE FROM budget_alerts", []).unwrap();
        assert!(pending(c, today).unwrap().is_empty());
        settings::set(c, "budget_alerts", "1").unwrap();
        let a = pending(c, today).unwrap();
        assert_eq!(
            a.iter().map(|x| x.level).collect::<Vec<_>>(),
            [100],
            "сразу за 100 % — одно сообщение"
        );
        assert!(pending(c, today).unwrap().is_empty());
    }

    #[test]
    fn first_check_after_upgrade_marks_crossed_thresholds_silently() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let id = |c: &Connection, name: &str| -> String {
            c.query_row(
                "SELECT id FROM categories WHERE name = ?1 AND kind = 'expense'",
                [name],
                |r| r.get(0),
            )
            .unwrap()
        };
        let (cafe, food) = (
            id(db.conn(), "Кафе и рестораны"),
            id(db.conn(), "Супермаркет"),
        );
        let budget = budgets::create(db.conn_mut(), "2026-10", false).unwrap();
        let c = db.conn();
        budgets::set_limit(c, &budget, &cafe, Some(1_000_000)).unwrap();
        budgets::set_limit(c, &budget, &food, Some(1_000_000)).unwrap();
        let today = "2026-10-20";
        // До обновления месяц уже идёт: кафе превышено, супермаркет на 85 %.
        spend(c, &card, &cafe, "2026-10-05", 1_200_000);
        spend(c, &card, &food, "2026-10-06", 850_000);
        assert_eq!(settings::get(c, SEEDED_KEY).unwrap(), None);

        assert!(
            pending(c, today).unwrap().is_empty(),
            "первый тик не засыпает уведомлениями"
        );
        assert_eq!(settings::get(c, SEEDED_KEY).unwrap().as_deref(), Some("1"));
        assert!(pending(c, today).unwrap().is_empty());

        // Новый порог после первой проверки приходит.
        spend(c, &card, &food, "2026-10-19", 200_000);
        let a = pending(c, today).unwrap();
        assert_eq!(
            a.iter()
                .map(|x| (x.category_name.as_str(), x.level))
                .collect::<Vec<_>>(),
            [("Супермаркет", 100)]
        );
    }

    #[test]
    fn active_warnings_explain_and_can_be_dismissed() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let cafe: String = db
            .conn()
            .query_row(
                "SELECT id FROM categories WHERE name = 'Кафе и рестораны'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let budget = budgets::create(db.conn_mut(), "2026-10", false).unwrap();
        let c = db.conn();
        budgets::set_limit(c, &budget, &cafe, Some(1_000_000)).unwrap();
        let today = "2026-10-11";
        assert!(pending(c, today).unwrap().is_empty(), "первая проверка");
        for (d, a) in [
            ("2026-10-02", 300_000),
            ("2026-10-05", 300_000),
            ("2026-10-09", 250_000),
        ] {
            let id = spend(c, &card, &cafe, d, a);
            c.execute(
                "UPDATE transactions SET payee = 'Шоколадница' WHERE id = ?1",
                [&id],
            )
            .unwrap();
        }
        let a = active(c, today).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].level, a[0].percent), (80, 85));
        assert_eq!(
            a[0].reason,
            "Месяц прошёл на 35 %, а лимит потрачен на 85 %. Осталось 1\u{a0}500 ₽ на 20 дней — около 75 ₽ в день. Чаще всего — «Шоколадница»: 3 из 3 операций."
        );
        assert_eq!(
            (a[0].start.as_str(), a[0].end.as_str()),
            ("2026-10-01", "2026-10-31")
        );
        assert!(notify_text(&a[0]).contains("посмотреть операции или изменить план"));
        // Список «в силе» ничего не отмечает: уведомление всё равно придёт.
        assert_eq!(pending(c, today).unwrap().len(), 1);

        crate::checks::dismiss(c, &a[0].key).unwrap();
        assert!(active(c, today).unwrap().is_empty(), "«Понятно» скрывает");
        spend(c, &card, &cafe, "2026-10-11", 200_000);
        let a = active(c, today).unwrap();
        assert_eq!(
            a[0].level, 100,
            "превышение после «Понятно» показывается снова"
        );
        assert!(a[0].reason.starts_with(
            "Лимит 10\u{a0}000 ₽ закончился за 11 дней из 31; до конца месяца ещё 20 дней."
        ));
        settings::set(c, "budget_alerts", "0").unwrap();
        assert!(active(c, today).unwrap().is_empty());
    }
}
