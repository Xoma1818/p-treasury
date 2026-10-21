//! Правила автокатегоризации: «если в получателе или тексте банка есть
//! „PYATEROCHKA“, то категория „Продукты“ и получатель „Пятёрочка“».
//! Применяются при вводе одной строкой, вставке SMS банка и импорте CSV.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

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
    let mut best: Option<Rule> = None;
    for r in list(conn)?.into_iter().filter(|r| r.kind == kind) {
        let needle = normalize(&r.pattern);
        if hay.contains(&needle)
            && best
                .as_ref()
                .is_none_or(|b| normalize(&b.pattern).len() < needle.len())
        {
            best = Some(r);
        }
    }
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = ?1 ORDER BY kind = 'income' LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .unwrap()
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
        create(c, &rule("PYATEROCHKA", "Продукты", Some("Пятёрочка"))).unwrap();
        create(c, &rule("yandex", "Такси", None)).unwrap();
        create(
            c,
            &rule("yandex eda", "Кафе и рестораны", Some("Яндекс Еда")),
        )
        .unwrap();
        assert!(create(c, &rule(" a ", "Такси", None)).is_err());

        let m = find(c, "Покупка 1250р Pyaterochka 1234", "expense")
            .unwrap()
            .unwrap();
        assert_eq!(m.payee.as_deref(), Some("Пятёрочка"));
        assert_eq!(m.category_name, "Продукты");
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
        create(c, &rule("pyaterochka", "Супермаркет", None)).unwrap();
        assert_eq!(list(c).unwrap().len(), 3);
        let id = find(c, "PYATEROCHKA", "expense").unwrap().unwrap().id;
        delete(c, &id).unwrap();
        assert!(delete(c, &id).is_err());
        assert_eq!(normalize("  Ёлка   ПАЛКА "), "елка палка");
    }
}
