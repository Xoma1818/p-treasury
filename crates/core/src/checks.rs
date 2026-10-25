//! Странные списания (А3) — карточка Главной «Проверьте» за последние 30 дней:
//! похоже на дубль, крупнее обычного, подорожал регулярный платёж.
//! «Всё в порядке» запоминается в `check_dismissed` по стабильному ключу
//! строки, и строка больше не появляется.

use std::collections::HashMap;

use chrono::Duration;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{currencies, money, subscriptions, time, transactions, Result};

/// За сколько дней показывать.
pub const WINDOW_DAYS: i64 = 30;
/// «Крупнее обычного»: больше стольких медиан категории…
pub const LARGE_MEDIANS: i64 = 3;
/// …и больше стольких единиц основной валюты.
pub const LARGE_MIN_UNITS: i64 = 3_000;
/// За сколько дней до траты брать медиану категории (≈ 6 месяцев).
pub const LARGE_HISTORY_DAYS: i64 = 183;
/// Сколько трат категории нужно для медианы.
pub const LARGE_MIN_SAMPLES: usize = 3;
/// «Подорожало»: дороже прошлого больше чем на столько процентов.
pub const PRICE_MIN_PERCENT: i64 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Стабильный ключ строки: по нему «Всё в порядке».
    pub key: String,
    /// `duplicate`, `large` или `price`.
    pub kind: String,
    /// «Похоже на дубль: Пятёрочка».
    pub title: String,
    /// «2 раза по 1 250 ₽: 05.10 и 06.10».
    pub detail: String,
    pub date: String,
    /// Операция, которую открывает «Открыть».
    pub transaction_id: String,
    /// У дубля — вторая (более поздняя) операция для «Удалить второй».
    pub second_id: Option<String>,
}

fn dd_mm(date: &str) -> String {
    format!("{}.{}", &date[8..10], &date[5..7])
}

fn fmt(amount: i64, minor: u32, symbol: &str) -> String {
    format!("{} {symbol}", money::format_amount(amount, minor, true))
}

fn dismissed(conn: &Connection) -> Result<Vec<String>> {
    Ok(conn
        .prepare("SELECT key FROM check_dismissed")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// «Всё в порядке»: строка с этим ключом больше не показывается.
pub fn dismiss(conn: &Connection, key: &str) -> Result<()> {
    if key.trim().is_empty() {
        return crate::error::invalid("пустой ключ проверки");
    }
    conn.execute(
        "INSERT OR IGNORE INTO check_dismissed (key, created_at) VALUES (?1, ?2)",
        params![key, time::now_utc()],
    )?;
    Ok(())
}

struct Spend {
    id: String,
    date: String,
    created_at: String,
    amount: i64,
    account_id: String,
    payee: String,
    note: String,
    category_id: String,
    category_name: String,
    currency: String,
    symbol: String,
    minor: u32,
    split_id: Option<String>,
}

fn spends(conn: &Connection, from: &str, to: &str) -> Result<Vec<Spend>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.date, t.created_at, t.amount, t.account_id, trim(coalesce(t.payee, '')),
                trim(coalesce(t.note, '')), t.category_id, c.name, a.currency_code, cur.symbol,
                cur.minor_units, t.split_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN currencies cur ON cur.code = a.currency_code
         JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'cleared' AND t.type = 'expense' AND t.debt_id IS NULL
           AND t.date BETWEEN ?1 AND ?2
         ORDER BY t.date, t.created_at, t.id",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok(Spend {
            id: r.get(0)?,
            date: r.get(1)?,
            created_at: r.get(2)?,
            amount: r.get(3)?,
            account_id: r.get(4)?,
            payee: r.get(5)?,
            note: r.get(6)?,
            category_id: r.get(7)?,
            category_name: r.get(8)?,
            currency: r.get(9)?,
            symbol: r.get(10)?,
            minor: r.get(11)?,
            split_id: r.get(12)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn days_apart(a: &str, b: &str) -> Result<i64> {
    Ok((time::parse_date(a)? - time::parse_date(b)?)
        .num_days()
        .abs())
}

/// Похоже на дубль: один счёт, одна сумма, тот же получатель (или то же
/// описание), тот же или соседний день. Части разбитых чеков не сравниваются:
/// удаление части действует на весь чек и не соответствует сумме предупреждения.
fn duplicates(list: &[Spend], since: &str) -> Result<Vec<Check>> {
    let mut out = Vec::new();
    for (i, a) in list.iter().enumerate() {
        for b in &list[i + 1..] {
            if b.date.as_str() < since || a.account_id != b.account_id || a.amount != b.amount {
                continue;
            }
            if a.split_id.is_some() || b.split_id.is_some() {
                continue;
            }
            let same_payee =
                !a.payee.is_empty() && a.payee.to_lowercase() == b.payee.to_lowercase();
            let same_note = !a.note.is_empty() && a.note.to_lowercase() == b.note.to_lowercase();
            if !(same_payee || same_note) || days_apart(&a.date, &b.date)? > 1 {
                continue;
            }
            // Список упорядочен по дате и времени записи: b — второй.
            let (lo, hi) = if a.id < b.id {
                (&a.id, &b.id)
            } else {
                (&b.id, &a.id)
            };
            let who = if same_payee { &a.payee } else { &a.note };
            let when = if a.date == b.date {
                dd_mm(&a.date)
            } else {
                format!("{} и {}", dd_mm(&a.date), dd_mm(&b.date))
            };
            out.push(Check {
                key: format!("dup:{lo}:{hi}"),
                kind: "duplicate".into(),
                title: format!("Похоже на дубль: {who}"),
                detail: format!("2 раза по {}: {when}", fmt(a.amount, a.minor, &a.symbol)),
                // Дата — та же операция, что открывает «Открыть».
                date: a.date.clone(),
                transaction_id: a.id.clone(),
                second_id: Some(b.id.clone()),
            });
        }
    }
    Ok(out)
}

fn median(mut v: Vec<i64>) -> i64 {
    v.sort_unstable();
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2
    }
}

/// Крупнее обычного: больше трёх медиан трат категории за полгода до траты
/// и больше 3 000 единиц основной валюты.
fn large(conn: &Connection, list: &[Spend], since: &str) -> Result<Vec<Check>> {
    let base = currencies::base_currency(conn)?;
    let base_cur = currencies::get(conn, &base)?;
    let min = LARGE_MIN_UNITS * 10i64.pow(base_cur.minor_units);
    let mut values: HashMap<&str, Option<i64>> = HashMap::new();
    for s in list {
        let v = currencies::convert(conn, s.amount, &s.currency, &base, &s.date)?;
        values.insert(s.id.as_str(), v);
    }
    let mut out = Vec::new();
    for s in list.iter().filter(|s| s.date.as_str() >= since) {
        let Some(v) = values[s.id.as_str()] else {
            continue;
        };
        if v <= min {
            continue;
        }
        let from = (time::parse_date(&s.date)? - Duration::days(LARGE_HISTORY_DAYS)).to_string();
        let history: Vec<i64> = list
            .iter()
            .filter(|h| {
                h.category_id == s.category_id
                    && h.id != s.id
                    && h.date.as_str() >= from.as_str()
                    && (h.date.as_str(), h.created_at.as_str())
                        < (s.date.as_str(), s.created_at.as_str())
            })
            .filter_map(|h| values[h.id.as_str()])
            .collect();
        if history.len() < LARGE_MIN_SAMPLES {
            continue;
        }
        let m = median(history);
        if m <= 0 || v <= LARGE_MEDIANS * m {
            continue;
        }
        let what = if s.payee.is_empty() {
            s.category_name.clone()
        } else {
            format!("{} ({})", s.payee, s.category_name)
        };
        out.push(Check {
            key: format!("big:{}", s.id),
            kind: "large".into(),
            title: format!("Крупнее обычного: {what}"),
            detail: format!(
                "{} {}, обычно около {}",
                dd_mm(&s.date),
                fmt(v, base_cur.minor_units, &base_cur.symbol),
                fmt(m, base_cur.minor_units, &base_cur.symbol)
            ),
            date: s.date.clone(),
            transaction_id: s.id.clone(),
            second_id: None,
        });
    }
    Ok(out)
}

/// Строки карточки «Проверьте» на `today`, новые сверху, без отмеченных
/// «Всё в порядке». Пусто — карточка показывает «Всё спокойно».
pub fn list(conn: &Connection, today: &str) -> Result<Vec<Check>> {
    let today_d = time::parse_date(today)?;
    let since = (today_d - Duration::days(WINDOW_DAYS - 1)).to_string();
    let history_from = (today_d - Duration::days(WINDOW_DAYS + LARGE_HISTORY_DAYS)).to_string();
    let all = spends(conn, &history_from, today)?;
    let mut out = duplicates(&all, &since)?;
    out.extend(large(conn, &all, &since)?);
    for p in subscriptions::price_rises(conn, today, &since, PRICE_MIN_PERCENT)? {
        let money = |v: i64| fmt(v, p.minor_units, &p.currency_symbol);
        let per = if p.period == "month" {
            format!(
                "+{} в месяц, +{} в год",
                money(p.monthly_diff),
                money(p.yearly_diff)
            )
        } else {
            format!("+{} в год", money(p.yearly_diff))
        };
        out.push(Check {
            key: format!("price:{}:{}", p.key, p.transaction_id),
            kind: "price".into(),
            title: format!("Подорожало: {}", p.payee),
            detail: format!(
                "{}: было {}, стало {} ({per})",
                p.payee,
                money(p.old_amount),
                money(p.new_amount)
            ),
            date: p.date,
            transaction_id: p.transaction_id,
            second_id: None,
        });
    }
    let hidden = dismissed(conn)?;
    out.retain(|c| !hidden.contains(&c.key));
    out.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.key.cmp(&b.key)));
    Ok(out)
}

/// «Удалить второй» у дубля: обычное удаление операции (в оболочке — шагом
/// журнала отмены, Ctrl+Z возвращает её).
pub fn delete_second(conn: &Connection, second_id: &str) -> Result<()> {
    // Защита и от устаревшей карточки: «Удалить второй» не может удалить чек
    // целиком, показывая пользователю только сумму одной его части.
    if transactions::get(conn, second_id)?.split_id.is_some() {
        return crate::error::invalid(
            "это часть разбитого чека: удалите чек целиком в «Операциях»",
        );
    }
    transactions::delete(conn, second_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions::TxnInput;
    use crate::undo::Journal;

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 AND kind = 'expense'",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn spend(c: &Connection, acc: &str, cat: &str, date: &str, amount: i64, payee: &str) -> String {
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: acc.into(),
                amount,
                category_id: Some(cat.into()),
                to_account_id: None,
                to_amount: None,
                payee: Some(payee.into()).filter(|p: &String| !p.is_empty()),
                note: None,
            },
        )
        .unwrap()
    }

    const TODAY: &str = "2026-10-20";

    #[test]
    fn receipt_parts_are_not_deletable_duplicate_candidates() {
        use crate::receipts::{self, PartInput, ReceiptInput};

        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let food = cat(db.conn(), "Супермаркет");
        let drug = cat(db.conn(), "Аптека");
        let c = db.conn_mut();
        let first = spend(c, &card, &food, "2026-10-19", 100_000, "Ашан");
        let receipt = || ReceiptInput {
            date: TODAY.into(),
            account_id: card.clone(),
            payee: Some("Ашан".into()),
            note: None,
            total: 150_000,
            parts: vec![
                PartInput {
                    category_id: food.clone(),
                    amount: 100_000,
                    note: None,
                },
                PartInput {
                    category_id: drug.clone(),
                    amount: 50_000,
                    note: None,
                },
            ],
            tags: vec![],
            event_id: None,
        };
        let split = receipts::create(c, &receipt()).unwrap();
        let other_split = receipts::create(c, &receipt()).unwrap();
        assert!(list(c, TODAY).unwrap().is_empty());

        // Даже прямой вызов из устаревшей карточки не удаляет весь чек за
        // 1 500 ₽ под видом одного дубля на 1 000 ₽.
        let part = receipts::get(c, &split).unwrap().parts[0].id.clone();
        let balance = accounts::balance(c, &card, None).unwrap();
        assert!(delete_second(c, &part).is_err());
        assert_eq!(receipts::get(c, &split).unwrap().total, 150_000);
        assert_eq!(receipts::get(c, &other_split).unwrap().total, 150_000);
        assert_eq!(accounts::balance(c, &card, None).unwrap(), balance);

        // Настоящие дубли одиночных операций по-прежнему обнаруживаются.
        let second = spend(c, &card, &food, TODAY, 100_000, "Ашан");
        let checks = list(c, TODAY).unwrap();
        assert_eq!(checks.len(), 1, "{checks:?}");
        assert_eq!(checks[0].kind, "duplicate");
        assert_eq!(checks[0].transaction_id, first);
        assert_eq!(checks[0].second_id.as_deref(), Some(second.as_str()));
    }

    #[test]
    fn duplicate_found_dismissed_and_second_deleted_with_undo() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let c = db.conn();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let cash = accounts::create(c, &input("Наличные", "cash", "RUB", 0)).unwrap();
        let food = cat(c, "Супермаркет");
        assert!(list(c, TODAY).unwrap().is_empty(), "Всё спокойно");
        let first = spend(c, &card, &food, "2026-10-14", 125_000, "Пятёрочка");
        let second = spend(c, &card, &food, "2026-10-15", 125_000, "ПЯТЁРОЧКА");
        // Не дубли: другой счёт, другой день через один, другая сумма, давно.
        spend(c, &cash, &food, "2026-10-15", 125_000, "Пятёрочка");
        spend(c, &card, &food, "2026-10-17", 125_000, "Пятёрочка");
        spend(c, &card, &food, "2026-10-14", 125_001, "Пятёрочка");
        spend(c, &card, &food, "2026-08-01", 50_000, "Магнит");
        spend(c, &card, &food, "2026-08-02", 50_000, "Магнит");

        let checks = list(c, TODAY).unwrap();
        assert_eq!(checks.len(), 1, "{checks:?}");
        let d = &checks[0];
        assert_eq!(d.kind, "duplicate");
        assert_eq!(d.title, "Похоже на дубль: Пятёрочка");
        assert_eq!(d.detail, "2 раза по 1\u{a0}250 ₽: 14.10 и 15.10");
        assert_eq!(
            (d.transaction_id.as_str(), d.second_id.as_deref()),
            (first.as_str(), Some(second.as_str()))
        );
        // «Открыть» ищет операцию за дату строки: дата — у той же операции.
        assert_eq!(d.date, "2026-10-14");
        let opened: String = c
            .query_row(
                "SELECT date FROM transactions WHERE id = ?1",
                [&d.transaction_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(opened, d.date);

        // «Удалить второй» отменяется одним Ctrl+Z.
        let mut journal = Journal::default();
        journal
            .record(db.conn_mut(), "Удалить второй", |c| {
                delete_second(c, &second)
            })
            .unwrap();
        assert!(list(db.conn(), TODAY).unwrap().is_empty());
        journal.undo(db.conn()).unwrap();
        let checks = list(db.conn(), TODAY).unwrap();
        assert_eq!(checks.len(), 1);

        dismiss(db.conn(), &checks[0].key).unwrap();
        assert!(
            list(db.conn(), TODAY).unwrap().is_empty(),
            "больше не появляется"
        );
    }

    #[test]
    fn larger_than_usual_needs_three_medians_and_3000() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let tech = cat(c, "Прочие расходы");
        let cafe = cat(c, "Кафе и рестораны");
        for (d, a) in [
            ("2026-06-10", 150_000),
            ("2026-07-10", 200_000),
            ("2026-08-10", 250_000),
        ] {
            spend(c, &card, &tech, d, a, "");
            spend(c, &card, &cafe, d, 50_000, "");
        }
        let big = spend(c, &card, &tech, "2026-10-12", 900_000, "DNS");
        spend(c, &card, &tech, "2026-10-13", 500_000, "Ozon");
        // Кафе: 2 000 ₽ — в 4 раза больше обычного, но меньше 3 000 ₽.
        spend(c, &card, &cafe, "2026-10-14", 200_000, "");
        let checks = list(c, TODAY).unwrap();
        assert_eq!(checks.len(), 1, "{checks:?}");
        assert_eq!(checks[0].key, format!("big:{big}"));
        assert_eq!(checks[0].title, "Крупнее обычного: DNS (Прочие расходы)");
        assert_eq!(
            checks[0].detail,
            "12.10 9\u{a0}000 ₽, обычно около 2\u{a0}000 ₽"
        );
    }

    #[test]
    fn subscription_price_rise() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let subs = cat(c, "Подписки");
        for d in ["2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"] {
            spend(c, &card, &subs, d, 39_900, "Яндекс Плюс");
        }
        let new = spend(c, &card, &subs, "2026-10-05", 44_900, "Яндекс Плюс");
        // Мелкое изменение (+2 %) — не подорожание.
        for d in ["2026-06-07", "2026-07-07", "2026-08-07", "2026-09-07"] {
            spend(c, &card, &subs, d, 100_000, "Связь");
        }
        spend(c, &card, &subs, "2026-10-07", 102_000, "Связь");
        let checks = list(c, TODAY).unwrap();
        assert_eq!(checks.len(), 1, "{checks:?}");
        let p = &checks[0];
        assert_eq!(
            (p.kind.as_str(), p.transaction_id.as_str()),
            ("price", new.as_str())
        );
        assert_eq!(
            p.detail,
            "Яндекс Плюс: было 399 ₽, стало 449 ₽ (+50 ₽ в месяц, +600 ₽ в год)"
        );
        // Магазин с плавающими суммами — не подписка с подорожанием.
        for (d, a) in [
            ("2026-06-09", 200_000),
            ("2026-07-09", 220_000),
            ("2026-08-09", 190_000),
            ("2026-09-09", 210_000),
        ] {
            spend(c, &card, &subs, d, a, "Лента");
        }
        spend(c, &card, &subs, "2026-10-09", 250_000, "Лента");
        let checks = list(c, TODAY).unwrap();
        assert_eq!(
            checks
                .iter()
                .filter(|x| x.kind == "price")
                .map(|x| x.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Подорожало: Яндекс Плюс"],
            "{checks:?}"
        );
        // Через 30 дней строка уходит сама.
        assert!(list(c, "2026-11-10")
            .unwrap()
            .iter()
            .all(|x| x.kind != "price"));
    }
}
