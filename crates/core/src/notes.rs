//! Заметки: текст с датой и необязательной привязкой к операции, счёту, долгу
//! или месяцу бюджета. Поиск по полнотекстовому индексу `notes_fts`.
//! При удалении того, к чему заметка привязана, она остаётся, а привязка
//! очищается (ON DELETE SET NULL).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{ids, time, Error, Result};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    pub body: String,
    pub date: Option<String>,
    pub transaction_id: Option<String>,
    pub account_id: Option<String>,
    pub debt_id: Option<String>,
    pub budget_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub body: String,
    pub date: Option<String>,
    pub transaction_id: Option<String>,
    pub account_id: Option<String>,
    pub debt_id: Option<String>,
    pub budget_id: Option<String>,
    /// К чему привязана, для списка: «Счёт: Карта», «Долг: Банк».
    pub link: Option<String>,
    /// Напоминание у заметки (0.23).
    pub reminder_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFilter {
    /// Слова для поиска; каждое ищется по началу слова («гарант» найдёт «гарантия»).
    pub query: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub transaction_id: Option<String>,
    pub account_id: Option<String>,
    pub debt_id: Option<String>,
    pub budget_id: Option<String>,
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

struct Checked {
    body: String,
    date: Option<String>,
    links: [Option<String>; 4],
}

fn validate(input: &NoteInput) -> Result<Checked> {
    let body = input.body.trim();
    if body.is_empty() {
        return invalid("заметка пустая");
    }
    let date = clean(&input.date);
    if let Some(d) = date.as_deref() {
        time::check_date(d)?;
    }
    let links = [
        clean(&input.transaction_id),
        clean(&input.account_id),
        clean(&input.debt_id),
        clean(&input.budget_id),
    ];
    if links.iter().filter(|l| l.is_some()).count() > 1 {
        return invalid("заметку можно привязать только к чему-то одному");
    }
    Ok(Checked {
        body: body.to_string(),
        date,
        links,
    })
}

pub fn create(conn: &Connection, input: &NoteInput) -> Result<String> {
    let c = validate(input)?;
    let id = ids::new_id();
    let [t, a, d, b] = c.links;
    conn.execute(
        "INSERT INTO notes (id, body, date, transaction_id, account_id, debt_id, budget_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, c.body, c.date, t, a, d, b, time::now_utc()],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, input: &NoteInput) -> Result<()> {
    let c = validate(input)?;
    let [t, a, d, b] = c.links;
    let n = conn.execute(
        "UPDATE notes SET body = ?2, date = ?3, transaction_id = ?4, account_id = ?5, debt_id = ?6, budget_id = ?7,
                updated_at = ?8
         WHERE id = ?1",
        params![id, c.body, c.date, t, a, d, b, time::now_utc()],
    )?;
    if n == 0 {
        return Err(Error::NotFound("заметка"));
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Note> {
    let sql = format!("{SELECT} WHERE n.id = ?1");
    conn.query_row(&sql, [id], row)
        .optional()?
        .ok_or(Error::NotFound("заметка"))
}

/// Запрос FTS5 из слов пользователя: каждое слово в кавычках с `*` (по началу
/// слова), слова через AND. Кавычки и служебные символы FTS5 убираются, чтобы
/// любой ввод был корректным запросом.
pub fn fts_query(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" AND "))
}

const SELECT: &str = "SELECT n.id, n.body, n.date, n.transaction_id, n.account_id, n.debt_id, n.budget_id,
        CASE
          WHEN n.transaction_id IS NOT NULL THEN 'Операция: ' || t.date || COALESCE(' ' || NULLIF(t.payee, ''), '')
          WHEN n.account_id IS NOT NULL THEN 'Счёт: ' || a.name
          WHEN n.debt_id IS NOT NULL THEN 'Долг: ' || d.counterparty
          WHEN n.budget_id IS NOT NULL THEN 'Бюджет с ' || b.period_start
        END,
        n.created_at, n.updated_at,
        (SELECT r.id FROM reminders r WHERE r.note_id = n.id ORDER BY r.created_at LIMIT 1)
     FROM notes n
     LEFT JOIN transactions t ON t.id = n.transaction_id
     LEFT JOIN accounts a ON a.id = n.account_id
     LEFT JOIN debts d ON d.id = n.debt_id
     LEFT JOIN budgets b ON b.id = n.budget_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        body: r.get(1)?,
        date: r.get(2)?,
        transaction_id: r.get(3)?,
        account_id: r.get(4)?,
        debt_id: r.get(5)?,
        budget_id: r.get(6)?,
        link: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        reminder_id: r.get(10)?,
    })
}

/// Заметки по фильтру, новые сверху (по дате заметки, затем по времени создания).
pub fn list(conn: &Connection, f: &NoteFilter) -> Result<Vec<Note>> {
    let mut sql = format!("{SELECT} WHERE 1 = 1");
    let mut args: Vec<String> = Vec::new();
    let mut add = |cond: &str, v: Option<String>, sql: &mut String| {
        if let Some(v) = v {
            args.push(v);
            sql.push_str(&format!(" AND {cond} ?{}", args.len()));
        }
    };
    add(
        "n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH",
        f.query.as_deref().and_then(fts_query),
        &mut sql,
    );
    if f.query.as_deref().and_then(fts_query).is_some() {
        sql.push(')');
    }
    add("n.date >=", clean(&f.date_from), &mut sql);
    add("n.date <=", clean(&f.date_to), &mut sql);
    add("n.transaction_id =", clean(&f.transaction_id), &mut sql);
    add("n.account_id =", clean(&f.account_id), &mut sql);
    add("n.debt_id =", clean(&f.debt_id), &mut sql);
    add("n.budget_id =", clean(&f.budget_id), &mut sql);
    sql.push_str(
        " ORDER BY COALESCE(n.date, substr(n.created_at, 1, 10)) DESC, n.created_at DESC LIMIT 500",
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;
    use crate::transactions;

    fn note(body: &str, date: Option<&str>) -> NoteInput {
        NoteInput {
            body: body.into(),
            date: date.map(str::to_string),
            ..Default::default()
        }
    }

    fn search(conn: &Connection, q: &str) -> Vec<String> {
        list(
            conn,
            &NoteFilter {
                query: Some(q.into()),
                ..Default::default()
            },
        )
        .unwrap()
        .into_iter()
        .map(|n| n.body)
        .collect()
    }

    #[test]
    fn search_finds_fridge_warranty_by_word_start() {
        let s = Storage::open_in_memory().unwrap();
        let conn = s.conn();
        create(
            conn,
            &note("Гарантия до 10.2028, чек в ящике", Some("2026-10-05")),
        )
        .unwrap();
        create(conn, &note("Телефон банка 900", None)).unwrap();
        assert_eq!(
            search(conn, "гарантия"),
            ["Гарантия до 10.2028, чек в ящике"]
        );
        assert_eq!(search(conn, "гарант"), ["Гарантия до 10.2028, чек в ящике"]);
        assert_eq!(
            search(conn, "ЧЕК ящик"),
            ["Гарантия до 10.2028, чек в ящике"]
        );
        assert!(
            search(conn, "гарантия банка").is_empty(),
            "все слова должны найтись"
        );
        // Служебные символы FTS5 не ломают запрос.
        assert!(search(conn, "\"(* OR NEAR -").is_empty());
        assert_eq!(
            list(
                conn,
                &NoteFilter {
                    query: Some("  ".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            2
        );
    }

    #[test]
    fn edit_updates_the_index_and_delete_removes_it() {
        let s = Storage::open_in_memory().unwrap();
        let conn = s.conn();
        let id = create(conn, &note("старый текст", None)).unwrap();
        update(conn, &id, &note("новый текст", Some("2026-10-20"))).unwrap();
        assert!(search(conn, "старый").is_empty());
        assert_eq!(search(conn, "новый"), ["новый текст"]);
        delete(conn, &id).unwrap();
        assert!(search(conn, "новый").is_empty());
        assert!(matches!(
            update(conn, &id, &note("x", None)),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn links_are_shown_and_cleared_when_the_object_is_deleted() {
        let s = Storage::open_in_memory().unwrap();
        let conn = s.conn();
        crate::categories::seed_defaults(conn).unwrap();
        let card = accounts::create(conn, &input("Карта", "debit", "RUB", 0)).unwrap();
        let id = create(
            conn,
            &NoteInput {
                body: "Договор 123".into(),
                account_id: Some(card.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(get(conn, &id).unwrap().link.as_deref(), Some("Счёт: Карта"));
        let by_account = list(
            conn,
            &NoteFilter {
                account_id: Some(card.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_account.len(), 1);

        let cat: String = conn
            .query_row(
                "SELECT id FROM categories WHERE name = 'Продукты'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let txn = transactions::create(
            conn,
            &transactions::TxnInput {
                kind: "expense".into(),
                date: "2026-10-05".into(),
                account_id: card.clone(),
                amount: 4_500_000,
                category_id: Some(cat),
                to_account_id: None,
                to_amount: None,
                payee: Some("Холодильник".into()),
                note: None,
            },
        )
        .unwrap();
        let n2 = create(
            conn,
            &NoteInput {
                body: "гарантия".into(),
                transaction_id: Some(txn.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            get(conn, &n2).unwrap().link.as_deref(),
            Some("Операция: 2026-10-05 Холодильник")
        );
        transactions::delete(conn, &txn).unwrap();
        let after = get(conn, &n2).unwrap();
        assert_eq!(after.transaction_id, None);
        assert_eq!(after.link, None);
    }

    #[test]
    fn validation() {
        let s = Storage::open_in_memory().unwrap();
        let conn = s.conn();
        assert!(create(conn, &note("  ", None)).is_err());
        assert!(create(conn, &note("x", Some("2026-02-30"))).is_err());
        let two = NoteInput {
            body: "x".into(),
            account_id: Some("a".into()),
            debt_id: Some("d".into()),
            ..Default::default()
        };
        assert!(matches!(create(conn, &two), Err(Error::Validation(_))));
    }

    #[test]
    fn filter_by_dates() {
        let s = Storage::open_in_memory().unwrap();
        let conn = s.conn();
        create(conn, &note("a", Some("2026-10-01"))).unwrap();
        create(conn, &note("b", Some("2026-10-15"))).unwrap();
        create(conn, &note("c", Some("2026-11-01"))).unwrap();
        let got: Vec<_> = list(
            conn,
            &NoteFilter {
                date_from: Some("2026-10-01".into()),
                date_to: Some("2026-10-31".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .into_iter()
        .map(|n| n.body)
        .collect();
        assert_eq!(got, ["b", "a"]);
    }
}
