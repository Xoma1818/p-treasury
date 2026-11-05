//! История изменений операций.
//!
//! Записи делают триггеры базы (миграция 0021): любая правка видимых полей и
//! удаление операции добавляют строку в `txn_history` со снимком «до» и «после».
//! Здесь снимки превращаются в понятный список «что стало»: названия счетов,
//! категорий и поездок подставляются нынешние, суммы — в валюте счёта;
//! даты остаются `YYYY-MM-DD`, окно показывает их в выбранном формате.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::money::format_amount;
use crate::Result;

/// Одно поле, которое поменялось.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    /// Понятное название поля: «Сумма», «Категория»…
    pub field: String,
    pub before: String,
    pub after: String,
}

/// Одна запись истории.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Когда (UTC, ISO 8601).
    pub at: String,
    /// `update` или `delete`.
    pub kind: String,
    /// Для правки — что поменялось; для удаления пусто.
    pub fields: Vec<FieldChange>,
}

/// Поля в порядке показа и их названия.
const FIELDS: &[(&str, &str)] = &[
    ("type", "Тип"),
    ("amount", "Сумма"),
    ("to_amount", "Сумма зачисления"),
    ("date", "Дата"),
    ("account_id", "Счёт"),
    ("to_account_id", "Счёт зачисления"),
    ("category_id", "Категория"),
    ("payee", "Получатель"),
    ("note", "Комментарий"),
    ("status", "Статус"),
    ("event_id", "Поездка или событие"),
    ("spread_months", "По месяцам"),
    ("count_date", "Дата для бюджета"),
];

/// История операции целиком.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnHistory {
    /// Когда операция добавлена (UTC); `None`, если её уже нет.
    pub created_at: Option<String>,
    /// Добавлена загрузкой выписки или файла.
    pub imported: bool,
    /// Правки и удаления, новые сверху.
    pub changes: Vec<Change>,
}

const EMPTY: &str = "—";

/// Когда добавлена операция и что с ней было потом.
pub fn get(conn: &Connection, txn_id: &str) -> Result<TxnHistory> {
    let row = conn
        .query_row(
            "SELECT created_at, import_id IS NOT NULL FROM transactions WHERE id = ?1",
            [txn_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)),
        )
        .optional()?;
    Ok(TxnHistory {
        created_at: row.as_ref().map(|r| r.0.clone()),
        imported: row.is_some_and(|r| r.1),
        changes: for_txn(conn, txn_id)?,
    })
}

/// Правки и удаления операции, новые записи сверху. Для удалённой операции тоже работает.
pub fn for_txn(conn: &Connection, txn_id: &str) -> Result<Vec<Change>> {
    let mut stmt = conn.prepare(
        "SELECT at, kind, before, after FROM txn_history WHERE txn_id = ?1 ORDER BY id DESC",
    )?;
    let rows = stmt
        .query_map([txn_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (at, kind, before, after) in rows {
        let before = parse(&before);
        let fields = match after.as_deref() {
            Some(after) => diff(conn, &before, &parse(after))?,
            None => Vec::new(),
        };
        // Правка без видимой разницы (например, сумма 100 → 100 после
        // пересчёта) не показывается.
        if kind == "update" && fields.is_empty() {
            continue;
        }
        out.push(Change { at, kind, fields });
    }
    Ok(out)
}

fn parse(json: &str) -> Map<String, Value> {
    match serde_json::from_str(json) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn diff(
    conn: &Connection,
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Result<Vec<FieldChange>> {
    let mut out = Vec::new();
    for (key, label) in FIELDS {
        let b = before.get(*key).unwrap_or(&Value::Null);
        let a = after.get(*key).unwrap_or(&Value::Null);
        if b == a {
            continue;
        }
        out.push(FieldChange {
            field: (*label).to_string(),
            before: show(conn, key, b, before)?,
            after: show(conn, key, a, after)?,
        });
    }
    Ok(out)
}

/// Значение поля так, как его видит пользователь.
fn show(conn: &Connection, key: &str, v: &Value, row: &Map<String, Value>) -> Result<String> {
    if v.is_null() {
        return Ok(EMPTY.to_string());
    }
    let s = v.as_str().unwrap_or_default();
    Ok(match key {
        "type" => match s {
            "expense" => "Расход",
            "income" => "Доход",
            "transfer" => "Перевод",
            "adjustment" => "Корректировка",
            other => other,
        }
        .to_string(),
        "status" => match s {
            "planned" => "Запланирована",
            _ => "Проведена",
        }
        .to_string(),
        "amount" => money(conn, v, row.get("account_id"))?,
        "to_amount" => money(conn, v, row.get("to_account_id"))?,
        "account_id" | "to_account_id" => name(conn, "SELECT name FROM accounts WHERE id = ?1", s)?,
        "category_id" => name(conn, "SELECT name FROM categories WHERE id = ?1", s)?,
        "event_id" => name(conn, "SELECT name FROM events WHERE id = ?1", s)?,
        "spread_months" => match v.as_i64() {
            Some(n) if n > 1 => format!("на {n} мес."),
            _ => "нет".to_string(),
        },
        _ if s.is_empty() => EMPTY.to_string(),
        _ => s.to_string(),
    })
}

fn name(conn: &Connection, sql: &str, id: &str) -> Result<String> {
    Ok(conn
        .query_row(sql, [id], |r| r.get::<_, String>(0))
        .optional()?
        .unwrap_or_else(|| "(удалено)".to_string()))
}

fn money(conn: &Connection, v: &Value, account: Option<&Value>) -> Result<String> {
    let Some(amount) = v.as_i64() else {
        return Ok(EMPTY.to_string());
    };
    let cur = match account.and_then(Value::as_str) {
        Some(id) => conn
            .query_row(
                "SELECT c.minor_units, c.symbol FROM accounts a
                 JOIN currencies c ON c.code = a.currency_code WHERE a.id = ?1",
                params![id],
                |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?,
        None => None,
    };
    let (minor, symbol) = cur.unwrap_or((2, String::new()));
    let text = format_amount(amount, minor, true);
    Ok(if symbol.is_empty() {
        text
    } else {
        format!("{text} {symbol}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input as acc;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};
    use crate::{accounts, categories, undo};

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn input(account: &str, amount: i64, category: &str) -> TxnInput {
        TxnInput {
            kind: "expense".into(),
            date: "2026-11-05".into(),
            account_id: account.into(),
            amount,
            category_id: Some(category.into()),
            to_account_id: None,
            to_amount: None,
            payee: Some("Пятёрочка".into()),
            note: None,
        }
    }

    #[test]
    fn edits_and_delete_are_recorded() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &acc("Карта", "debit", "RUB", 0)).unwrap();
        let food = cat(c, "Питание");
        let cafe = cat(c, "Общепит");
        let id = transactions::create(c, &input(&card, 50_000, &food)).unwrap();
        // Создание не пишется.
        assert!(for_txn(c, &id).unwrap().is_empty());

        transactions::update(c, &id, &input(&card, 45_000, &cafe)).unwrap();
        // Сохранение без изменений не добавляет запись.
        transactions::update(c, &id, &input(&card, 45_000, &cafe)).unwrap();
        let h = for_txn(c, &id).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kind, "update");
        assert_eq!(
            h[0].fields,
            vec![
                FieldChange {
                    field: "Сумма".into(),
                    before: "500 ₽".into(),
                    after: "450 ₽".into()
                },
                FieldChange {
                    field: "Категория".into(),
                    before: "Питание".into(),
                    after: "Общепит".into()
                },
            ]
        );

        // Удаление записывается, а отмена удаления не стирает историю.
        let mut journal = undo::Journal::default();
        journal
            .record(db.conn_mut(), "Удаление", |c| {
                transactions::delete(c, &id)
            })
            .unwrap();
        journal.undo(db.conn()).unwrap();
        let c = db.conn();
        assert!(transactions::get(c, &id).is_ok());
        let full = get(c, &id).unwrap();
        assert!(full.created_at.is_some() && !full.imported);
        let h = for_txn(c, &id).unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].kind, "delete");
        // Отменённую правку тоже видно: сумма вернулась.
        let mut journal = undo::Journal::default();
        journal
            .record(db.conn_mut(), "Правка", |c| {
                transactions::update(c, &id, &input(&card, 30_000, &cafe))
            })
            .unwrap();
        journal.undo(db.conn()).unwrap();
        let h = for_txn(db.conn(), &id).unwrap();
        assert_eq!(h.len(), 4);
        assert_eq!(h[0].fields[0].before, "300 ₽");
        assert_eq!(h[0].fields[0].after, "450 ₽");
    }
}
