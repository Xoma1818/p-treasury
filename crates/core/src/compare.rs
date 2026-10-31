//! Сравнение двух любых периодов: что стало больше, что меньше, на сколько в деньгах и в процентах.
//! Позиции (категории, получатели или счета) сопоставляются между периодами;
//! позиция, которая встречается только в одном периоде, помечается отдельно.
//! Суммы в основной валюте по курсу на дату операции, как во всех отчётах.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::invalid;
use crate::reports::{self, PeriodSummary};
use crate::{currencies, time, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    /// id категории или счёта; для получателя — его имя.
    pub key: String,
    pub name: String,
    /// Сумма в первом периоде (с чем сравниваем).
    pub a: i64,
    /// Сумма во втором периоде.
    pub b: i64,
    /// `b - a`: больше нуля — стало больше.
    pub diff: i64,
    /// Изменение в процентах от первого периода; `None`, если в первом периоде позиции не было.
    pub percent: Option<i64>,
    /// `both`, `onlyA` (во втором периоде нет), `onlyB` (новое во втором).
    pub presence: &'static str,
    /// Подкатегории (только для сравнения по категориям).
    pub children: Vec<CompareRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub base_currency: String,
    pub kind: String,
    pub by: String,
    pub summary_a: PeriodSummary,
    pub summary_b: PeriodSummary,
    pub total_a: i64,
    pub total_b: i64,
    pub diff: i64,
    pub percent: Option<i64>,
    /// По изменению: сначала то, что выросло сильнее всего, в конце — что сильнее всего уменьшилось.
    pub rows: Vec<CompareRow>,
    pub missing_rates: Vec<String>,
}

fn row(key: String, name: String, a: i64, b: i64, children: Vec<CompareRow>) -> CompareRow {
    let diff = b - a;
    CompareRow {
        key,
        name,
        a,
        b,
        diff,
        percent: (a != 0).then(|| reports::percent(diff, a)),
        presence: match (a != 0, b != 0) {
            (true, false) => "onlyA",
            (false, true) => "onlyB",
            _ => "both",
        },
        children,
    }
}

fn sort(rows: &mut [CompareRow]) {
    rows.sort_by(|x, y| y.diff.cmp(&x.diff).then_with(|| x.name.cmp(&y.name)));
}

/// Сумма за период по ключу: `payee` или `account`.
fn sums(
    conn: &Connection,
    kind: &str,
    by: &str,
    from: &str,
    to: &str,
    missing: &mut Vec<String>,
) -> Result<HashMap<String, (String, i64)>> {
    let key = match by {
        "payee" => "COALESCE(NULLIF(TRIM(t.payee), ''), ''), COALESCE(NULLIF(TRIM(t.payee), ''), 'Без получателя')",
        _ => "a.id, a.name",
    };
    let base = currencies::base_currency(conn)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {key}, t.date, t.amount, a.currency_code FROM txn_by_month t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.status = 'cleared' AND t.type = ?1 AND t.date BETWEEN ?2 AND ?3"
    ))?;
    let rows = stmt.query_map(params![kind, from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut out: HashMap<String, (String, i64)> = HashMap::new();
    for r in rows {
        let (k, name, date, amount, cur) = r?;
        match currencies::convert(conn, amount, &cur, &base, &date)? {
            Some(v) => out.entry(k).or_insert((name, 0)).1 += v,
            None if !missing.contains(&cur) => missing.push(cur),
            None => {}
        }
    }
    Ok(out)
}

fn merge(
    a: HashMap<String, (String, i64)>,
    mut b: HashMap<String, (String, i64)>,
) -> Vec<CompareRow> {
    let mut rows: Vec<CompareRow> = a
        .into_iter()
        .map(|(k, (name, va))| {
            let vb = b.remove(&k).map_or(0, |(_, v)| v);
            row(k, name, va, vb, vec![])
        })
        .collect();
    rows.extend(
        b.into_iter()
            .map(|(k, (name, vb))| row(k, name, 0, vb, vec![])),
    );
    rows
}

/// Сравнить расходы или доходы (`kind`) за два периода по категориям, получателям или счетам (`by`).
#[allow(clippy::too_many_arguments)]
pub fn compare(
    conn: &Connection,
    kind: &str,
    by: &str,
    a_from: &str,
    a_to: &str,
    b_from: &str,
    b_to: &str,
) -> Result<Comparison> {
    if !matches!(kind, "expense" | "income") {
        return invalid("сравниваются расходы или доходы");
    }
    if !matches!(by, "category" | "payee" | "account") {
        return invalid("сравнивать можно по категориям, получателям или счетам");
    }
    for (from, to) in [(a_from, a_to), (b_from, b_to)] {
        time::check_date(from)?;
        time::check_date(to)?;
        if to < from {
            return invalid("конец периода раньше начала");
        }
    }
    let mut missing = Vec::new();
    let mut rows = if by == "category" {
        let ra = reports::by_category(conn, kind, a_from, a_to)?;
        let rb = reports::by_category(conn, kind, b_from, b_to)?;
        for cur in ra.missing_rates.into_iter().chain(rb.missing_rates) {
            if !missing.contains(&cur) {
                missing.push(cur);
            }
        }
        let flat = |items: &[reports::CategoryItem]| -> HashMap<String, (String, i64)> {
            items
                .iter()
                .map(|i| (i.category_id.clone(), (i.name.clone(), i.amount)))
                .collect()
        };
        let children_a: HashMap<String, HashMap<String, (String, i64)>> = ra
            .items
            .iter()
            .map(|i| (i.category_id.clone(), flat(&i.children)))
            .collect();
        let mut children_b: HashMap<String, HashMap<String, (String, i64)>> = rb
            .items
            .iter()
            .map(|i| (i.category_id.clone(), flat(&i.children)))
            .collect();
        let mut rows = merge(flat(&ra.items), flat(&rb.items));
        for r in &mut rows {
            let ca = children_a.get(&r.key).cloned().unwrap_or_default();
            let cb = children_b.remove(&r.key).unwrap_or_default();
            let mut ch = merge(ca, cb);
            sort(&mut ch);
            r.children = ch;
        }
        rows
    } else {
        let a = sums(conn, kind, by, a_from, a_to, &mut missing)?;
        let b = sums(conn, kind, by, b_from, b_to, &mut missing)?;
        merge(a, b)
    };
    sort(&mut rows);
    let total_a: i64 = rows.iter().map(|r| r.a).sum();
    let total_b: i64 = rows.iter().map(|r| r.b).sum();
    Ok(Comparison {
        base_currency: currencies::base_currency(conn)?,
        kind: kind.into(),
        by: by.into(),
        summary_a: reports::period_summary(conn, a_from, a_to)?,
        summary_b: reports::period_summary(conn, b_from, b_to)?,
        total_a,
        total_b,
        diff: total_b - total_a,
        percent: (total_a != 0).then(|| reports::percent(total_b - total_a, total_a)),
        rows,
        missing_rates: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    struct Fx {
        db: Storage,
        card: String,
        cash: String,
    }

    impl Fx {
        fn new() -> Self {
            let db = Storage::open_in_memory().unwrap();
            crate::categories::seed_defaults(db.conn()).unwrap();
            let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
            let cash = accounts::create(db.conn(), &input("Наличные", "cash", "RUB", 0)).unwrap();
            Fx { db, card, cash }
        }
        fn cat(&self, n: &str) -> String {
            self.db
                .conn()
                .query_row("SELECT id FROM categories WHERE name = ?1", [n], |r| {
                    r.get(0)
                })
                .unwrap()
        }
        fn op(&self, date: &str, amount: i64, cat: &str, payee: &str, account: &str) {
            transactions::create(
                self.db.conn(),
                &TxnInput {
                    kind: "expense".into(),
                    date: date.into(),
                    account_id: account.into(),
                    amount,
                    category_id: Some(self.cat(cat)),
                    to_account_id: None,
                    to_amount: None,
                    payee: (!payee.is_empty()).then(|| payee.into()),
                    note: None,
                },
            )
            .unwrap();
        }
        fn september_and_october(&self) {
            // Сентябрь: продукты 10 000, кафе 4 000, такси 2 000.
            self.op("2026-09-05", 1_000_000, "Питание", "Пятёрочка", &self.card);
            self.op("2026-09-10", 400_000, "Общепит", "Шоколадница", &self.card);
            self.op("2026-09-12", 200_000, "Такси", "Яндекс Go", &self.cash);
            // Октябрь: продукты 12 500 (+25 %), кафе 3 000 (−25 %), такси нет, аптека новая 1 500.
            self.op("2026-10-05", 1_250_000, "Питание", "Пятёрочка", &self.card);
            self.op("2026-10-10", 300_000, "Общепит", "Шоколадница", &self.cash);
            self.op("2026-10-15", 150_000, "Лекарства", "", &self.card);
        }
    }

    fn find<'a>(rows: &'a [CompareRow], name: &str) -> &'a CompareRow {
        rows.iter()
            .find(|r| r.name == name)
            .unwrap_or_else(|| panic!("нет строки {name}"))
    }

    #[test]
    fn september_against_october_by_category() {
        let f = Fx::new();
        f.september_and_october();
        let c = compare(
            f.db.conn(),
            "expense",
            "category",
            "2026-09-01",
            "2026-09-30",
            "2026-10-01",
            "2026-10-31",
        )
        .unwrap();
        assert_eq!(
            (c.total_a, c.total_b, c.diff),
            (1_600_000, 1_700_000, 100_000)
        );
        assert_eq!(c.percent, Some(6)); // 100 / 1 600 = 6,25 %
        let food = find(&c.rows, "Питание");
        assert_eq!(
            (food.a, food.b, food.diff, food.percent, food.presence),
            (1_000_000, 1_250_000, 250_000, Some(25), "both")
        );
        let cafe = find(&c.rows, "Общепит");
        assert_eq!((cafe.diff, cafe.percent), (-100_000, Some(-25)));
        // Такси — подкатегория «Транспорта»: в октябре её нет.
        let transport = find(&c.rows, "Транспорт");
        assert_eq!(
            (transport.b, transport.percent, transport.presence),
            (0, Some(-100), "onlyA")
        );
        assert_eq!(find(&transport.children, "Такси").presence, "onlyA");
        // Аптека появилась только в октябре: процента нет.
        let health = c.rows.iter().find(|r| r.presence == "onlyB").unwrap();
        assert_eq!((health.a, health.b, health.percent), (0, 150_000, None));
        // Порядок: сначала то, что выросло сильнее, в конце — что сильнее уменьшилось.
        let diffs: Vec<i64> = c.rows.iter().map(|r| r.diff).collect();
        assert!(diffs.windows(2).all(|w| w[0] >= w[1]), "{diffs:?}");
        assert_eq!(c.rows[0].name, "Питание");
        assert_eq!(c.rows.last().unwrap().name, "Транспорт");
        assert_eq!(
            (c.summary_a.expense, c.summary_b.expense),
            (1_600_000, 1_700_000)
        );
    }

    #[test]
    fn by_payee_and_by_account() {
        let f = Fx::new();
        f.september_and_october();
        let conn = f.db.conn();
        let p = compare(
            conn,
            "expense",
            "payee",
            "2026-09-01",
            "2026-09-30",
            "2026-10-01",
            "2026-10-31",
        )
        .unwrap();
        assert_eq!(find(&p.rows, "Пятёрочка").percent, Some(25));
        assert_eq!(find(&p.rows, "Яндекс Go").presence, "onlyA");
        assert_eq!(find(&p.rows, "Без получателя").presence, "onlyB");
        let a = compare(
            conn,
            "expense",
            "account",
            "2026-09-01",
            "2026-09-30",
            "2026-10-01",
            "2026-10-31",
        )
        .unwrap();
        let card = a.rows.iter().find(|r| r.key == f.card).unwrap();
        assert_eq!((card.a, card.b), (1_400_000, 1_400_000));
        assert_eq!((card.diff, card.percent), (0, Some(0)));
        let cash = a.rows.iter().find(|r| r.key == f.cash).unwrap();
        assert_eq!((cash.a, cash.b, cash.percent), (200_000, 300_000, Some(50)));
    }

    #[test]
    fn any_periods_even_of_different_length_and_validation() {
        let f = Fx::new();
        f.september_and_october();
        let conn = f.db.conn();
        // Половина сентября против всего октября и тот же период сам с собой.
        let c = compare(
            conn,
            "expense",
            "category",
            "2026-09-01",
            "2026-09-10",
            "2026-10-01",
            "2026-10-31",
        )
        .unwrap();
        assert_eq!(c.total_a, 1_400_000);
        let same = compare(
            conn,
            "expense",
            "category",
            "2026-10-01",
            "2026-10-31",
            "2026-10-01",
            "2026-10-31",
        )
        .unwrap();
        assert!(same
            .rows
            .iter()
            .all(|r| r.diff == 0 && r.presence == "both"));
        // Пустой первый период: всё новое, процентов нет.
        let empty = compare(
            conn,
            "expense",
            "category",
            "2025-01-01",
            "2025-01-31",
            "2026-10-01",
            "2026-10-31",
        )
        .unwrap();
        assert!(empty
            .rows
            .iter()
            .all(|r| r.presence == "onlyB" && r.percent.is_none()));
        assert_eq!(empty.percent, None);
        assert!(compare(
            conn,
            "transfer",
            "category",
            "2026-09-01",
            "2026-09-30",
            "2026-10-01",
            "2026-10-31"
        )
        .is_err());
        assert!(compare(
            conn,
            "expense",
            "tag",
            "2026-09-01",
            "2026-09-30",
            "2026-10-01",
            "2026-10-31"
        )
        .is_err());
        assert!(compare(
            conn,
            "expense",
            "category",
            "2026-09-30",
            "2026-09-01",
            "2026-10-01",
            "2026-10-31"
        )
        .is_err());
    }
}
