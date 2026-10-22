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
    let month = budgets::month_of(conn, today)?.month;
    let budget = budgets::get(conn, &month, today)?;
    if budget.id.is_none() {
        return Ok(Vec::new());
    }
    let minor = currencies::minor_units(conn, &budget.currency_code)?;
    let fmt = |v: i64| money::format_amount(v, minor, true);
    let mut out = Vec::new();
    for l in budget
        .lines
        .iter()
        .filter(|l| l.kind == "expense" && l.limit > 0)
    {
        // Как у полосы бюджета: 100 % и больше — красный порог.
        let over = l.actual >= l.limit;
        let warn = l.actual as i128 * 100 >= l.limit as i128 * WARN_PERCENT as i128;
        let level = if over && !marked(conn, &month, &l.category_id, 100)? {
            100
        } else if warn && !over && !marked(conn, &month, &l.category_id, WARN_PERCENT)? {
            WARN_PERCENT
        } else {
            continue;
        };
        // Сразу за 100 %: предупреждение о 80 % уже не нужно.
        for lv in [WARN_PERCENT, 100].into_iter().filter(|lv| *lv <= level) {
            mark(conn, &month, &l.category_id, lv)?;
        }
        let text = if level == 100 && l.actual == l.limit {
            format!(
                "{}: бюджет исчерпан ({} {})",
                l.category_name,
                fmt(l.limit),
                budget.currency_symbol
            )
        } else if level == 100 {
            format!(
                "{}: бюджет превышен на {} {}",
                l.category_name,
                fmt(l.actual - l.limit),
                budget.currency_symbol
            )
        } else {
            format!(
                "{}: потрачено {} % бюджета ({} из {} {})",
                l.category_name,
                l.percent,
                fmt(l.actual),
                fmt(l.limit),
                budget.currency_symbol
            )
        };
        out.push(Alert {
            month: month.clone(),
            category_id: l.category_id.clone(),
            category_name: l.category_name.clone(),
            level,
            actual: l.actual,
            limit: l.limit,
            percent: l.percent,
            text,
        });
    }
    Ok(out)
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
}
