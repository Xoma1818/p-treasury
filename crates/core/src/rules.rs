//! Правила автокатегоризации: «если в получателе или тексте банка есть
//! „PYATEROCHKA“, то категория „Продукты“ и получатель „Пятёрочка“».
//! Применяются при вводе одной строкой, вставке SMS банка и импорте CSV.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::invalid;
use crate::{categories, ids, time, Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInput {
    /// Что искать в тексте (без учёта регистра и «ё»).
    pub pattern: String,
    pub category_id: String,
    /// Как назвать получателя; пусто — оставить как в тексте.
    pub payee: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub pattern: String,
    pub category_id: String,
    pub category_name: String,
    /// Вид категории: правило подходит только операциям этого вида.
    pub kind: String,
    pub payee: Option<String>,
}

/// Текст для сравнения: нижний регистр, «ё» как «е», пробелы схлопнуты.
pub fn normalize(s: &str) -> String {
    s.to_lowercase()
        .replace('ё', "е")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn create(conn: &Connection, input: &RuleInput) -> Result<String> {
    let pattern = input.pattern.trim();
    if normalize(pattern).chars().count() < 2 {
        return invalid("напишите, что искать: хотя бы две буквы, например «пятёрочка»");
    }
    categories::kind_of(conn, &input.category_id)?;
    let payee = input
        .payee
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // Одно правило на текст: новое заменяет старое.
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM payee_rules WHERE pattern_norm = ?1",
            [normalize(pattern)],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE payee_rules SET pattern = ?2, category_id = ?3, payee = ?4 WHERE id = ?1",
            params![id, pattern, input.category_id, payee],
        )?;
        return Ok(id);
    }
    let id = ids::new_id();
    conn.execute(
        "INSERT INTO payee_rules (id, pattern, pattern_norm, category_id, payee, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            pattern,
            normalize(pattern),
            input.category_id,
            payee,
            time::now_utc()
        ],
    )?;
    Ok(id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM payee_rules WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound("правило"));
    }
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<Rule>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.pattern, r.category_id,
                CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' → ' || c.name END,
                c.kind, r.payee
         FROM payee_rules r JOIN categories c ON c.id = r.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         ORDER BY r.pattern_norm",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Rule {
            id: r.get(0)?,
            pattern: r.get(1)?,
            category_id: r.get(2)?,
            category_name: r.get(3)?,
            kind: r.get(4)?,
            payee: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Первое подходящее правило для текста и вида операции. Если подходят
/// несколько, побеждает самое длинное (самое точное) совпадение.
pub fn find(conn: &Connection, text: &str, kind: &str) -> Result<Option<Rule>> {
    let hay = normalize(text);
    if hay.is_empty() {
        return Ok(None);
    }
    Ok(winning_rule(&list(conn)?, &hay, kind).cloned())
}

fn winning_rule<'a>(rules: &'a [Rule], hay: &str, kind: &str) -> Option<&'a Rule> {
    let mut best: Option<&Rule> = None;
    for r in rules.iter().filter(|r| r.kind == kind) {
        let needle = normalize(&r.pattern);
        if hay.contains(&needle)
            && best
                .as_ref()
                .is_none_or(|b| normalize(&b.pattern).len() < needle.len())
        {
            best = Some(r);
        }
    }
    best
}

const HISTORY_LIMIT: usize = 100;
const HISTORY_SQL: &str =
    "SELECT t.id, t.date, t.account_id, a.name, t.amount, a.currency_code, c.symbol, c.minor_units,
            t.category_id, CASE WHEN pc.name IS NULL THEN ct.name ELSE pc.name || ' → ' || ct.name END,
            t.payee
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     JOIN currencies c ON c.code = a.currency_code
     JOIN categories ct ON ct.id = t.category_id
     LEFT JOIN categories pc ON pc.id = ct.parent_id
     WHERE t.type = ?1 AND t.status = 'cleared' AND t.payee IS NOT NULL
       AND t.refund = 0 AND t.refund_of IS NULL AND t.debt_id IS NULL AND t.split_id IS NULL
       AND t.spread_months IS NULL AND t.event_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM transactions child WHERE child.refund_of = t.id)";

#[derive(Serialize)]
struct Before {
    id: String,
    date: String,
    account_id: String,
    account_name: String,
    amount: i64,
    currency_code: String,
    currency_symbol: String,
    minor_units: u32,
    category_id: String,
    category: String,
    payee: String,
}

fn before(row: &Row<'_>) -> rusqlite::Result<Before> {
    Ok(Before {
        id: row.get(0)?,
        date: row.get(1)?,
        account_id: row.get(2)?,
        account_name: row.get(3)?,
        amount: row.get(4)?,
        currency_code: row.get(5)?,
        currency_symbol: row.get(6)?,
        minor_units: row.get(7)?,
        category_id: row.get(8)?,
        category: row.get(9)?,
        payee: row.get(10)?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: String,
    pub date: String,
    pub account_name: String,
    pub amount: i64,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub old_category: String,
    pub new_category: String,
    pub old_payee: String,
    pub new_payee: String,
    pub revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPreview {
    pub rows: Vec<HistoryRow>,
    pub has_more: bool,
}

#[derive(Deserialize)]
pub struct HistorySelection {
    pub id: String,
    pub revision: String,
}

fn selected_rule<'a>(rules: &'a [Rule], id: &str) -> Result<&'a Rule> {
    rules
        .iter()
        .find(|r| r.id == id)
        .ok_or(Error::NotFound("правило"))
}

fn proposed_row(
    old: Before,
    rules: &[Rule],
    target: &Rule,
    needle: &str,
) -> Result<Option<HistoryRow>> {
    let new_payee = target.payee.as_deref().unwrap_or(&old.payee);
    if old.category_id == target.category_id && old.payee == new_payee {
        return Ok(None);
    }
    let hay = normalize(&old.payee);
    if !hay.contains(needle)
        || winning_rule(rules, &hay, &target.kind).is_none_or(|r| r.id != target.id)
    {
        return Ok(None);
    }
    let snapshot =
        serde_json::to_vec(&(&old, target)).map_err(|e| Error::Validation(e.to_string()))?;
    let new_payee = new_payee.to_string();
    Ok(Some(HistoryRow {
        id: old.id,
        date: old.date,
        account_name: old.account_name,
        amount: old.amount,
        currency_symbol: old.currency_symbol,
        minor_units: old.minor_units,
        old_category: old.category,
        new_category: target.category_name.clone(),
        old_payee: old.payee,
        new_payee,
        revision: format!("{:x}", Sha256::digest(snapshot)),
    }))
}

fn history(conn: &Connection, id: &str) -> Result<HistoryPreview> {
    let rules = list(conn)?;
    let target = selected_rule(&rules, id)?;
    let needle = normalize(&target.pattern);
    let mut stmt = conn.prepare(&format!("{HISTORY_SQL} ORDER BY t.date DESC, t.id DESC"))?;
    let mut source = stmt.query([&target.kind])?;
    let mut rows = Vec::new();
    while let Some(row) = source.next()? {
        if let Some(change) = proposed_row(before(row)?, &rules, target, &needle)? {
            if rows.len() == HISTORY_LIMIT {
                return Ok(HistoryPreview {
                    rows,
                    has_more: true,
                });
            }
            rows.push(change);
        }
    }
    Ok(HistoryPreview {
        rows,
        has_more: false,
    })
}

pub fn history_preview(conn: &mut Connection, id: &str) -> Result<HistoryPreview> {
    let tx = conn.transaction()?;
    let result = history(&tx, id)?;
    tx.commit()?;
    Ok(result)
}

pub fn apply_history(
    conn: &mut Connection,
    id: &str,
    selections: &[HistorySelection],
) -> Result<usize> {
    if selections.is_empty() || selections.len() > HISTORY_LIMIT {
        return invalid("выберите от 1 до 100 операций из предпросмотра");
    }
    let ids: HashSet<&str> = selections.iter().map(|s| s.id.as_str()).collect();
    if ids.len() != selections.len() {
        return invalid("одна операция выбрана несколько раз. Обновите предпросмотр.");
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let rules = list(&tx)?;
    let target = selected_rule(&rules, id)?;
    let needle = normalize(&target.pattern);
    {
        let mut stmt = tx.prepare(&format!("{HISTORY_SQL} AND t.id = ?2"))?;
        let mut write = tx.prepare(
            "UPDATE transactions SET category_id = ?2, payee = ?3, updated_at = ?4 WHERE id = ?1",
        )?;
        let now = time::now_utc();
        for selection in selections {
            let old = stmt
                .query_row(params![target.kind, selection.id], before)
                .optional()?;
            let current = match old {
                Some(old) => proposed_row(old, &rules, target, &needle)?,
                None => None,
            }
            .filter(|current| current.revision == selection.revision)
            .ok_or_else(|| {
                Error::Validation("правило или операции изменились. Обновите предпросмотр.".into())
            })?;
            write.execute(params![
                current.id,
                target.category_id,
                current.new_payee,
                now
            ])?;
        }
    }
    tx.commit()?;
    Ok(selections.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input as account_input};
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};
    use crate::undo::Journal;

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 ORDER BY kind = 'income' LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn historical_expense(c: &Connection, card: &str, date: &str, payee: &str) -> String {
        transactions::create(
            c,
            &TxnInput {
                kind: "expense".into(),
                date: date.into(),
                account_id: card.into(),
                amount: 700,
                category_id: Some(cat(c, "Магазины")),
                to_account_id: None,
                to_amount: None,
                payee: Some(payee.into()),
                note: Some("сохранить примечание".into()),
            },
        )
        .unwrap()
    }

    fn history_rule(c: &Connection, pattern: &str, category: &str, payee: &str) -> String {
        create(
            c,
            &RuleInput {
                pattern: pattern.into(),
                category_id: cat(c, category),
                payee: Some(payee.into()),
            },
        )
        .unwrap()
    }

    fn selections(view: &HistoryPreview) -> Vec<HistorySelection> {
        view.rows
            .iter()
            .map(|r| HistorySelection {
                id: r.id.clone(),
                revision: r.revision.clone(),
            })
            .collect()
    }

    fn current(c: &Connection, id: &str) -> (String, String) {
        c.query_row(
            "SELECT category_id, payee FROM transactions WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn preview_uses_winning_rule_and_applies_only_chosen_rows_with_one_undo() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &account_input("Карта", "debit", "RUB", 10_000)).unwrap();
        let apply = historical_expense(c, &card, "2026-10-02", "ЯНДЕКС такси");
        let untouched = historical_expense(c, &card, "2026-10-03", "яндекс плюс");
        let other_winner = historical_expense(c, &card, "2026-10-04", "яндекс  еда");
        let excluded = historical_expense(c, &card, "2026-10-05", "яндекс такси");
        c.execute(
            "UPDATE transactions SET status = 'planned' WHERE id = ?1",
            [&excluded],
        )
        .unwrap();
        let split = historical_expense(c, &card, "2026-10-06", "яндекс такси");
        c.execute(
            "UPDATE transactions SET split_id = 'группа' WHERE id = ?1",
            [&split],
        )
        .unwrap();
        let rule = history_rule(c, "яндекс", "Такси", "Яндекс");
        history_rule(c, "яндекс еда", "Общепит", "Яндекс Еда");
        let view = history_preview(c, &rule).unwrap();
        let old_category = cat(c, "Магазины");
        assert_eq!(
            view.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            [untouched.as_str(), apply.as_str()]
        );
        assert_eq!(
            current(c, &apply),
            (old_category.clone(), "ЯНДЕКС такси".into())
        );
        assert_eq!(view.rows[1].new_category, "Транспорт → Такси");
        let choose = selections(&view).pop().unwrap();
        let mut journal = Journal::default();
        let count = journal
            .record(c, "Правило", |c| apply_history(c, &rule, &[choose]))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(current(c, &apply), (cat(c, "Такси"), "Яндекс".into()));
        assert_eq!(current(c, &other_winner).0, old_category);
        assert_eq!(current(c, &untouched).0, old_category);
        let fields: (i64, String, String, String) = c
            .query_row(
                "SELECT amount, date, account_id, note FROM transactions WHERE id = ?1",
                [&apply],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            fields,
            (
                700,
                "2026-10-02".into(),
                card,
                "сохранить примечание".into()
            )
        );
        assert_eq!(journal.undo(c).unwrap().as_deref(), Some("Правило"));
        assert_eq!(current(c, &apply), (old_category, "ЯНДЕКС такси".into()));
    }

    #[test]
    fn stale_operation_or_rule_rolls_back_the_whole_selection() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &account_input("Карта", "debit", "RUB", 10_000)).unwrap();
        let changed = historical_expense(c, &card, "2026-10-02", "яндекс такси");
        let first = historical_expense(c, &card, "2026-10-03", "яндекс такси");
        let rule = history_rule(c, "яндекс", "Такси", "Яндекс");
        let view = history_preview(c, &rule).unwrap();
        let start = current(c, &first);
        c.execute(
            "UPDATE transactions SET amount = 701 WHERE id = ?1",
            [&changed],
        )
        .unwrap();
        assert!(apply_history(c, &rule, &selections(&view)).is_err());
        assert_eq!(current(c, &first), start, "первый UPDATE тоже откатился");
        let view = history_preview(c, &rule).unwrap();
        assert_eq!(history_rule(c, "яндекс", "Такси", "Яндекс Go"), rule);
        assert!(apply_history(c, &rule, &selections(&view)).is_err());
        assert_eq!(current(c, &first), start);
    }

    #[test]
    fn history_preview_is_bounded_and_skips_purchases_with_returns() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &account_input("Карта", "debit", "RUB", 10_000)).unwrap();
        for _ in 0..=HISTORY_LIMIT {
            historical_expense(c, &card, "2026-10-02", "яндекс такси");
        }
        let refunded = historical_expense(c, &card, "2026-10-04", "яндекс такси");
        let returned = historical_expense(c, &card, "2026-10-05", "яндекс возврат");
        c.execute(
            "UPDATE transactions SET refund = 1, refund_of = ?2 WHERE id = ?1",
            [&returned, &refunded],
        )
        .unwrap();
        let rule = history_rule(c, "яндекс", "Такси", "Яндекс");
        let view = history_preview(c, &rule).unwrap();
        assert!(view.has_more);
        assert_eq!(view.rows.len(), HISTORY_LIMIT);
        assert!(view.rows.iter().all(|r| r.date == "2026-10-02"));
    }

    #[test]
    fn rules_match_longest_and_kind() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let rule = |pattern: &str, category: &str, payee: Option<&str>| RuleInput {
            pattern: pattern.into(),
            category_id: cat(c, category),
            payee: payee.map(Into::into),
        };
        create(c, &rule("PYATEROCHKA", "Питание", Some("Пятёрочка"))).unwrap();
        create(c, &rule("yandex", "Такси", None)).unwrap();
        create(c, &rule("yandex eda", "Общепит", Some("Яндекс Еда"))).unwrap();
        assert!(create(c, &rule(" a ", "Такси", None)).is_err());

        let m = find(c, "Покупка 1250р Pyaterochka 1234", "expense")
            .unwrap()
            .unwrap();
        assert_eq!(m.payee.as_deref(), Some("Пятёрочка"));
        assert_eq!(m.category_name, "Питание");
        assert_eq!(
            find(c, "YANDEX  EDA MOSCOW", "expense")
                .unwrap()
                .unwrap()
                .payee
                .as_deref(),
            Some("Яндекс Еда"),
            "длинное совпадение точнее"
        );
        assert_eq!(
            find(c, "yandex go", "expense")
                .unwrap()
                .unwrap()
                .category_name,
            "Транспорт → Такси"
        );
        assert!(
            find(c, "pyaterochka", "income").unwrap().is_none(),
            "вид не тот"
        );
        assert!(find(c, "ozon", "expense").unwrap().is_none());

        // Тот же текст заменяет правило, а не дублирует его.
        create(c, &rule("pyaterochka", "Магазины", None)).unwrap();
        assert_eq!(list(c).unwrap().len(), 3);
        let id = find(c, "PYATEROCHKA", "expense").unwrap().unwrap().id;
        delete(c, &id).unwrap();
        assert!(delete(c, &id).is_err());
        assert_eq!(normalize("  Ёлка   ПАЛКА "), "елка палка");
    }
}
