//! История изменений операций.
//!
//! Правки видимых полей и удаление операции записывают триггеры базы (миграция
//! 0021) в `txn_history` со снимком «до» и «после». Смену тегов существующей
//! операции явно пишет `tags::edit_for` (и массовое действие), пересборку
//! разбитого чека — `receipts::update`; создание операции не пишется.
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
    /// Денежное поле: окно прячет его в режиме «Скрыть суммы».
    pub money: bool,
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
    ("parts", "Части чека"),
    ("tags", "Теги"),
];

/// Поля с деньгами.
const MONEY: &[&str] = &["amount", "to_amount", "parts"];

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

/// Когда добавлена операция и что с ней было потом. Для разбитого чека
/// (`split_id`) собирается история всего чека: пересборки и правки частей.
pub fn get(conn: &Connection, txn_id: &str, split_id: Option<&str>) -> Result<TxnHistory> {
    let mut ids = vec![txn_id.to_string()];
    if let Some(split) = split_id {
        ids = conn
            .prepare("SELECT id FROM transactions WHERE split_id = ?1")?
            .query_map([split], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        ids.push(split.to_string());
    }
    let mut created: Option<String> = None;
    let mut imported = false;
    for id in &ids {
        let row = conn
            .query_row(
                "SELECT created_at, import_id IS NOT NULL FROM transactions WHERE id = ?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)),
            )
            .optional()?;
        if let Some((at, imp)) = row {
            imported |= imp;
            if created.as_ref().is_none_or(|c| at < *c) {
                created = Some(at);
            }
        }
    }
    Ok(TxnHistory {
        created_at: created,
        imported,
        changes: for_ids(conn, &ids)?,
    })
}

/// Правки и удаления операции, новые записи сверху. Для удалённой операции тоже работает.
pub fn for_txn(conn: &Connection, txn_id: &str) -> Result<Vec<Change>> {
    for_ids(conn, &[txn_id.to_string()])
}

/// Строка с одними тегами (её пишет `record_tags`).
fn is_tag(r: &Row) -> bool {
    r.before.len() == 1 && r.before.contains_key("tags")
}

struct Row {
    id: i64,
    txn: String,
    at: String,
    kind: String,
    before: Map<String, Value>,
    after: Option<Map<String, Value>>,
}

fn for_ids(conn: &Connection, ids: &[String]) -> Result<Vec<Change>> {
    let mut stmt = conn
        .prepare("SELECT id, txn_id, at, kind, before, after FROM txn_history WHERE txn_id = ?1")?;
    let mut rows = Vec::new();
    for id in ids {
        let found = stmt
            .query_map([id], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    txn: r.get(1)?,
                    at: r.get(2)?,
                    kind: r.get(3)?,
                    before: parse(&r.get::<_, String>(4)?),
                    after: r.get::<_, Option<String>>(5)?.as_deref().map(parse),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.extend(found);
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.id));

    // Одно сохранение — одна запись: теги, снятые и поставленные в ту же
    // секунду, присоединяются к правке полей этой операции.
    let mut groups: Vec<Vec<Row>> = Vec::new();
    for row in rows {
        let same = groups.last().is_some_and(|g| {
            let last = &g[0];
            row.kind == "update"
                && last.kind == "update"
                && row.txn == last.txn
                && row.at.get(..19) == last.at.get(..19)
                // Две правки полей не склеиваются (правка и быстрая отмена).
                && (is_tag(&row) || g.iter().all(is_tag))
        });
        if same {
            groups.last_mut().expect("есть").push(row);
        } else {
            groups.push(vec![row]);
        }
    }

    let mut out = Vec::with_capacity(groups.len());
    for g in groups {
        let first = &g[0];
        let (at, kind) = (first.at.clone(), first.kind.clone());
        if kind != "update" {
            out.push(Change {
                at,
                kind,
                fields: Vec::new(),
            });
            continue;
        }
        let mut fields = Vec::new();
        // Внутри группы строки новые сверху; поля разбираем в порядке записи.
        for row in g.iter().rev() {
            let after = row.after.clone().unwrap_or_default();
            fields.extend(diff(conn, &row.before, &after)?);
        }
        // Правка без видимой разницы (например, тег снят и поставлен снова)
        // не показывается.
        if !fields.is_empty() {
            out.push(Change { at, kind, fields });
        }
    }
    Ok(out)
}

/// Записать смену тегов существующей операции (форма, «Теги операции»,
/// массовое действие). Теги при создании операции сюда не попадают.
pub(crate) fn record_tags(
    conn: &Connection,
    txn_id: &str,
    before: &[String],
    after: &[String],
) -> Result<()> {
    if before == after {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO txn_history (txn_id, at, kind, before, after)
         VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'update', ?2, ?3)",
        params![
            txn_id,
            serde_json::json!({ "tags": before }).to_string(),
            serde_json::json!({ "tags": after }).to_string()
        ],
    )?;
    Ok(())
}

/// Записать пересборку разбитого чека: что было и что стало (части, дата,
/// счёт, получатель, поездка). Вызывается из `receipts::update` до удаления
/// старых частей; `new_ids` — уже вставленные новые части.
pub(crate) fn record_receipt(
    conn: &Connection,
    split_id: &str,
    old_ids: &[String],
    new_ids: &[String],
) -> Result<()> {
    let before = receipt_snapshot(conn, old_ids)?;
    let after = receipt_snapshot(conn, new_ids)?;
    if before == after {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO txn_history (txn_id, at, kind, before, after)
         VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'update', ?2, ?3)",
        params![split_id, before.to_string(), after.to_string()],
    )?;
    Ok(())
}

fn receipt_snapshot(conn: &Connection, ids: &[String]) -> Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT date, account_id, payee, event_id, category_id, amount, note
         FROM transactions WHERE id = ?1",
    )?;
    let mut head = Map::new();
    let mut parts = Vec::new();
    let mut sorted = ids.to_vec();
    sorted.sort();
    for id in &sorted {
        let row = stmt
            .query_row([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            })
            .optional()?;
        let Some((date, account, payee, event, category, amount, note)) = row else {
            continue;
        };
        head.insert("date".into(), date.into());
        head.insert("account_id".into(), account.into());
        head.insert("payee".into(), payee.map_or(Value::Null, Value::from));
        head.insert("event_id".into(), event.map_or(Value::Null, Value::from));
        // Теги у всех частей чека одни и те же.
        head.insert("tags".into(), crate::tags::names_of(conn, id)?.into());
        parts.push(serde_json::json!([category, amount, note]));
    }
    head.insert("parts".into(), Value::Array(parts));
    Ok(Value::Object(head))
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
            money: MONEY.contains(key),
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
        "parts" => parts(conn, v, row.get("account_id"))?,
        "tags" => {
            let names: Vec<&str> = v
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if names.is_empty() {
                EMPTY.to_string()
            } else {
                names.join(", ")
            }
        }
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

/// «Питание 300 ₽, Хозтовары 200 ₽».
fn parts(conn: &Connection, v: &Value, account: Option<&Value>) -> Result<String> {
    let mut out = Vec::new();
    for p in v.as_array().into_iter().flatten() {
        let category = match p.get(0).and_then(Value::as_str) {
            Some(id) => name(conn, "SELECT name FROM categories WHERE id = ?1", id)?,
            None => EMPTY.to_string(),
        };
        let amount = money(conn, p.get(1).unwrap_or(&Value::Null), account)?;
        match p.get(2).and_then(Value::as_str).filter(|n| !n.is_empty()) {
            Some(note) => out.push(format!("{category} {amount} ({note})")),
            None => out.push(format!("{category} {amount}")),
        }
    }
    Ok(if out.is_empty() {
        EMPTY.to_string()
    } else {
        out.join(", ")
    })
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
                    after: "450 ₽".into(),
                    money: true
                },
                FieldChange {
                    field: "Категория".into(),
                    before: "Питание".into(),
                    after: "Общепит".into(),
                    money: false
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
        let full = get(c, &id, None).unwrap();
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

    #[test]
    fn tags_and_receipts_are_recorded() {
        use crate::receipts::{self, PartInput, ReceiptInput};
        use crate::transactions::TxnExtra;
        use crate::{bulk, tags};
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &acc("Карта", "debit", "RUB", 0)).unwrap();
        let food = cat(c, "Питание");
        let cafe = cat(c, "Общепит");
        let extra = |t: &str| TxnExtra {
            spread_months: None,
            tags: vec![t.into()],
        };
        // Теги при создании не пишутся.
        let id =
            transactions::create_with(db.conn_mut(), &input(&card, 50_000, &food), &extra("дача"))
                .unwrap();
        assert!(for_txn(db.conn(), &id).unwrap().is_empty());
        // Правка сразу после создания: сумма и тег — одна запись, без порога времени.
        transactions::update_with(
            db.conn_mut(),
            &id,
            &input(&card, 40_000, &food),
            &extra("отпуск"),
        )
        .unwrap();
        let h = for_txn(db.conn(), &id).unwrap();
        assert_eq!(h.len(), 1);
        let tag = h[0].fields.iter().find(|f| f.field == "Теги").unwrap();
        assert_eq!(
            (tag.before.as_str(), tag.after.as_str()),
            ("дача", "отпуск")
        );
        assert!(h[0].fields.iter().any(|f| f.field == "Сумма" && f.money));
        // Массовое действие с тегом.
        bulk::tag(db.conn_mut(), std::slice::from_ref(&id), "работа", true).unwrap();
        let h = for_txn(db.conn(), &id).unwrap();
        assert!(h[0]
            .fields
            .iter()
            .any(|f| f.field == "Теги" && f.after == "отпуск, работа"));
        // Сохранение тех же тегов ничего не пишет.
        tags::edit_for(db.conn(), &id, &["отпуск".into(), "работа".into()]).unwrap();
        let rows: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM txn_history WHERE txn_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 3);

        // Разбитый чек.
        let receipt = |a: i64, b: i64, tag: &str, note: Option<&str>| ReceiptInput {
            date: "2026-11-05".into(),
            account_id: card.clone(),
            payee: None,
            note: note.map(Into::into),
            total: a + b,
            parts: vec![
                PartInput {
                    category_id: food.clone(),
                    amount: a,
                    note: None,
                },
                PartInput {
                    category_id: cafe.clone(),
                    amount: b,
                    note: None,
                },
            ],
            tags: vec![tag.into()],
            event_id: None,
        };
        let split =
            receipts::create(db.conn_mut(), &receipt(30_000, 20_000, "дача", None)).unwrap();
        db.conn()
            .execute("UPDATE transactions SET created_at = '2026-01-01T00:00:00.000Z' WHERE split_id = ?1", [&split])
            .unwrap();
        let part = |c: &Connection| {
            c.query_row(
                "SELECT id FROM transactions WHERE split_id = ?1 AND category_id = ?2",
                [&split, &food],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
        };
        // Правка части (как массовым действием) не теряется после пересборки чека.
        db.conn()
            .execute(
                "UPDATE transactions SET payee = 'Лента' WHERE split_id = ?1 AND category_id = ?2",
                [&split, &food],
            )
            .unwrap();
        receipts::update(
            db.conn_mut(),
            &split,
            &receipt(25_000, 25_000, "дача", None),
        )
        .unwrap();
        // Только теги и комментарий — тоже видимая запись.
        receipts::update(
            db.conn_mut(),
            &split,
            &receipt(25_000, 25_000, "отпуск", Some("к празднику")),
        )
        .unwrap();
        let full = get(db.conn(), &part(db.conn()), Some(&split)).unwrap();
        assert_eq!(full.created_at.as_deref(), Some("2026-01-01T00:00:00.000Z"));
        let fields: Vec<&str> = full
            .changes
            .iter()
            .flat_map(|c| c.fields.iter().map(|f| f.field.as_str()))
            .collect();
        assert!(
            fields.contains(&"Теги") && fields.contains(&"Части чека"),
            "{fields:?}"
        );
        assert!(
            fields.contains(&"Получатель"),
            "правка части пропала: {fields:?}"
        );
        assert!(
            full.changes.iter().all(|c| c.kind == "update"),
            "{:?}",
            full.changes
        );
        let last = &full.changes[0];
        let parts = last
            .fields
            .iter()
            .find(|f| f.field == "Части чека")
            .unwrap();
        assert!(
            parts.after.contains("к празднику") && parts.money,
            "{parts:?}"
        );
    }
}
