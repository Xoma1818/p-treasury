//! Поиск по всему (Ctrl+K): заметки, поездки и события, долги, имущество,
//! цели и теги. Счета, категории, виды и операции ищет интерфейс через свои запросы.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{transactions, Result};

const PER_KIND: usize = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// `note`, `event`, `debt`, `asset`, `goal`, `tag` (открывает операции с тегом).
    pub kind: String,
    pub id: String,
    pub title: String,
    /// Дата или пояснение под названием.
    pub detail: Option<String>,
}

/// Найти `query` (без учёта регистра, и по-русски) в названиях и текстах.
pub fn find(conn: &Connection, query: &str) -> Result<Vec<Hit>> {
    let q = query.trim().to_lowercase();
    if q.chars().count() < 2 {
        return Ok(vec![]);
    }
    transactions::register_lower(conn)?;
    let like = format!("%{q}%");
    let sources: [(&str, &str); 6] = [
        (
            "note",
            "SELECT id, body, date FROM notes WHERE kz_lower(body) LIKE ?1
             ORDER BY coalesce(date, created_at) DESC LIMIT ?2",
        ),
        (
            "event",
            "SELECT id, name, start_date || ' — ' || end_date FROM events
             WHERE kz_lower(name) LIKE ?1 OR kz_lower(coalesce(note, '')) LIKE ?1
             ORDER BY start_date DESC LIMIT ?2",
        ),
        (
            "debt",
            "SELECT id, counterparty, CASE direction WHEN 'lent' THEN 'Мне должны' ELSE 'Я должен' END
             FROM debts WHERE kz_lower(counterparty) LIKE ?1 OR kz_lower(coalesce(note, '')) LIKE ?1
             ORDER BY status, issue_date DESC LIMIT ?2",
        ),
        (
            "asset",
            "SELECT id, name, NULL FROM assets
             WHERE archived = 0 AND (kz_lower(name) LIKE ?1 OR kz_lower(coalesce(note, '')) LIKE ?1)
             ORDER BY name LIMIT ?2",
        ),
        (
            "goal",
            "SELECT id, name, deadline FROM goals WHERE archived = 0 AND kz_lower(name) LIKE ?1
             ORDER BY name LIMIT ?2",
        ),
        (
            "tag",
            "SELECT g.id, '#' || g.name,
                    'Тег · операций: ' || (SELECT count(*) FROM transaction_tags tt WHERE tt.tag_id = g.id)
             FROM tags g WHERE kz_lower(g.name) LIKE ?1 ORDER BY g.name LIMIT ?2",
        ),
    ];
    let mut out = Vec::new();
    for (kind, sql) in sources {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![like, PER_KIND as i64], |r| {
            Ok(Hit {
                kind: kind.to_string(),
                id: r.get(0)?,
                title: r.get(1)?,
                detail: r.get(2)?,
            })
        })?;
        for h in rows {
            out.push(h?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    #[test]
    fn finds_in_russian_regardless_of_case() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        c.execute_batch(
            "INSERT INTO notes (id, body, date, created_at, updated_at) VALUES ('n1', 'Отдать Пете за Билеты', '2026-10-01', '', '');
             INSERT INTO events (id, name, start_date, end_date, created_at) VALUES ('e1', 'Поездка в Питер', '2026-07-01', '2026-07-10', '');
             INSERT INTO goals (id, name, target, currency_code, created_at, updated_at) VALUES ('g1', 'Билеты в Сочи', 100, 'RUB', '', '');",
        )
        .unwrap();
        let hits = find(c, "БИЛЕТ").unwrap();
        let kinds: Vec<(&str, &str)> = hits
            .iter()
            .map(|h| (h.kind.as_str(), h.id.as_str()))
            .collect();
        assert_eq!(kinds, [("note", "n1"), ("goal", "g1")]);
        assert_eq!(
            find(c, "питер").unwrap()[0].detail.as_deref(),
            Some("2026-07-01 — 2026-07-10")
        );
        c.execute_batch("INSERT INTO tags (id, name) VALUES ('t1', 'Ремонт кухни');")
            .unwrap();
        let tag = &find(c, "РЕМОНТ").unwrap()[0];
        assert_eq!(
            (tag.kind.as_str(), tag.id.as_str(), tag.title.as_str()),
            ("tag", "t1", "#Ремонт кухни")
        );
        assert_eq!(tag.detail.as_deref(), Some("Тег · операций: 0"));
        assert!(
            find(c, "п").unwrap().is_empty(),
            "одна буква — слишком широко"
        );
    }
}
