//! Сохранённые виды: фильтр операций или настройки отчёта под именем.
//! Параметры хранятся как JSON-строка, которую понимает только интерфейс.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{ids, time, Error, Result};

const KINDS: &[&str] = &["transactions", "report"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewInput {
    pub name: String,
    pub kind: String,
    pub params: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub params: String,
}

pub fn create(conn: &Connection, input: &ViewInput) -> Result<String> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("введите название вида");
    }
    if !KINDS.contains(&input.kind.as_str()) {
        return invalid(format!("неизвестный вид: {}", input.kind));
    }
    if serde_json::from_str::<serde_json::Value>(&input.params).is_err() {
        return invalid("параметры вида повреждены");
    }
    let id = ids::new_id();
    conn.execute(
        "INSERT INTO saved_views (id, name, kind, params, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(max(sort_order), 0) + 1 FROM saved_views), ?5)",
        params![id, name, input.kind, input.params, time::now_utc()],
    )?;
    Ok(id)
}

pub fn list(conn: &Connection, kind: Option<&str>) -> Result<Vec<SavedView>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, kind, params FROM saved_views
         WHERE ?1 IS NULL OR kind = ?1 ORDER BY sort_order, name",
    )?;
    let rows = stmt.query_map([kind], |r| {
        Ok(SavedView {
            id: r.get(0)?,
            name: r.get(1)?,
            kind: r.get(2)?,
            params: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM saved_views WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound("сохранённый вид"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    #[test]
    fn create_list_delete() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let input = |name: &str, kind: &str, params: &str| ViewInput {
            name: name.into(),
            kind: kind.into(),
            params: params.into(),
        };
        let cafe = create(
            c,
            &input(" Кафе за год ", "transactions", r#"{"categoryId":"x"}"#),
        )
        .unwrap();
        create(
            c,
            &input("Структура расходов", "report", r#"{"tab":"categories"}"#),
        )
        .unwrap();
        assert!(create(c, &input("", "report", "{}")).is_err());
        assert!(create(c, &input("Х", "nope", "{}")).is_err());
        assert!(create(c, &input("Х", "report", "{не json")).is_err());
        let all = list(c, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "Кафе за год");
        assert_eq!(list(c, Some("report")).unwrap().len(), 1);
        delete(c, &cafe).unwrap();
        assert!(delete(c, &cafe).is_err());
        assert_eq!(list(c, Some("transactions")).unwrap().len(), 0);
    }
}
