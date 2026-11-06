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

struct Row {
    id: i64,
    at: String,
    kind: String,
    before: Map<String, Value>,
    after: Option<Map<String, Value>>,
}

fn for_ids(conn: &Connection, ids: &[String]) -> Result<Vec<Change>> {
    let mut stmt =
        conn.prepare("SELECT id, at, kind, before, after FROM txn_history WHERE txn_id = ?1")?;
    let mut rows = Vec::new();
    for id in ids {
        let found = stmt
            .query_map([id], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    kind: r.get(2)?,
                    before: parse(&r.get::<_, String>(3)?),
                    after: r.get::<_, Option<String>>(4)?.as_deref().map(parse),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.extend(found);
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.id));

    // Одна строка — одно действие: правку полей и тегов одного сохранения
    // `record_tags` сам дописывает в строку этого действия.
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if row.kind != "update" {
            out.push(Change {
                at: row.at,
                kind: row.kind,
                fields: Vec::new(),
            });
            continue;
        }
        let after = row.after.clone().unwrap_or_default();
        let fields = diff(conn, &row.before, &after)?;
        // Правка без видимой разницы не показывается.
        if !fields.is_empty() {
            out.push(Change {
                at: row.at,
                kind: row.kind,
                fields,
            });
        }
    }
    Ok(out)
}

/// Номер последней строки истории: метка начала действия для `record_tags`.
pub(crate) fn last_id(conn: &Connection) -> Result<i64> {
    Ok(
        conn.query_row("SELECT coalesce(max(id), 0) FROM txn_history", [], |r| {
            r.get(0)
        })?,
    )
}

/// Записать смену тегов существующей операции (форма, «Теги операции»,
/// массовое действие, отмена и повтор). Теги при создании операции сюда не
/// попадают. Если то же действие (строки после метки `since`) уже записало
/// правку полей этой операции, теги дописываются в ту же строку: одно
/// сохранение — одна запись.
pub(crate) fn record_tags(
    conn: &Connection,
    txn_id: &str,
    before: &[String],
    after: &[String],
    since: Option<i64>,
) -> Result<()> {
    if before == after {
        return Ok(());
    }
    let (b, a) = (
        serde_json::json!(before).to_string(),
        serde_json::json!(after).to_string(),
    );
    let same_action: Option<i64> = match since {
        Some(since) => conn
            .query_row(
                "SELECT id FROM txn_history WHERE id > ?1 AND txn_id = ?2 AND kind = 'update'
                 ORDER BY id DESC LIMIT 1",
                params![since, txn_id],
                |r| r.get(0),
            )
            .optional()?,
        None => None,
    };
    match same_action {
        Some(row) => conn.execute(
            "UPDATE txn_history SET before = json_set(before, '$.tags', json(?2)),
                                    after = json_set(after, '$.tags', json(?3))
             WHERE id = ?1",
            params![row, b, a],
        )?,
        None => conn.execute(
            "INSERT INTO txn_history (txn_id, at, kind, before, after)
             VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'update',
                     json_object('tags', json(?2)), json_object('tags', json(?3)))",
            params![txn_id, b, a],
        )?,
    };
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

/// Что было с операциями до отмены или повтора (см. `undo`): теги и чеки.
/// Правки полей при отмене пишут триггеры, а теги и состав чека — вот это.
pub(crate) struct UndoSnapshot {
    mark: i64,
    /// Операция и её теги (`None` — операции не было).
    tags: Vec<(String, Option<Vec<String>>)>,
    /// Чек: его части и снимок до отмены.
    receipts: Vec<(String, Vec<String>, Value)>,
}

fn split_of(conn: &Connection, id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT split_id FROM transactions WHERE id = ?1",
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn parts_of(conn: &Connection, split: &str) -> Result<Vec<String>> {
    let mut ids: Vec<String> = conn
        .prepare("SELECT id FROM transactions WHERE split_id = ?1")?
        .query_map([split], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.sort();
    Ok(ids)
}

fn exists(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM transactions WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

pub(crate) fn before_undo(conn: &Connection, ids: &[String]) -> Result<UndoSnapshot> {
    let mut snap = UndoSnapshot {
        mark: last_id(conn)?,
        tags: Vec::new(),
        receipts: Vec::new(),
    };
    for id in ids {
        let tags = if exists(conn, id)? {
            Some(crate::tags::names_of(conn, id)?)
        } else {
            None
        };
        snap.tags.push((id.clone(), tags));
        if let Some(split) = split_of(conn, id)? {
            if !snap.receipts.iter().any(|r| r.0 == split) {
                let parts = parts_of(conn, &split)?;
                let value = receipt_snapshot(conn, &parts)?;
                snap.receipts.push((split, parts, value));
            }
        }
    }
    Ok(snap)
}

/// Записать в историю то, что отмена или повтор изменили помимо полей.
pub(crate) fn after_undo(conn: &Connection, snap: &UndoSnapshot) -> Result<()> {
    let mut rebuilt = Vec::new();
    for (split, parts, before) in &snap.receipts {
        let now = parts_of(conn, split)?;
        // Состав частей сменился — это отмена или повтор пересборки чека.
        if now.is_empty() || parts.is_empty() || now == *parts {
            continue;
        }
        let after = receipt_snapshot(conn, &now)?;
        if after != *before {
            conn.execute(
                "INSERT INTO txn_history (txn_id, at, kind, before, after)
                 VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'update', ?2, ?3)",
                params![split, before.to_string(), after.to_string()],
            )?;
        }
        rebuilt.push(split.clone());
    }
    for (id, before) in &snap.tags {
        let Some(before) = before else { continue };
        if !exists(conn, id)? {
            continue;
        }
        if split_of(conn, id)?.is_some_and(|s| rebuilt.contains(&s)) {
            continue;
        }
        let after = crate::tags::names_of(conn, id)?;
        record_tags(conn, id, before, &after, Some(snap.mark))?;
    }
    Ok(())
}

fn receipt_snapshot(conn: &Connection, ids: &[String]) -> Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT date, account_id, payee, event_id, category_id, amount, note
         FROM transactions WHERE id = ?1",
    )?;
    let mut head = Map::new();
    let mut parts = Vec::new();
    for id in ids {
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
    // Порядок частей — по содержимому, а не по идентификаторам: форма может
    // вернуть те же части в другом порядке, это не изменение.
    parts.sort_by_key(|p| p.to_string());
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
        tags::edit_for(db.conn(), &id, &["отпуск".into(), "работа".into()], None).unwrap();
        let rows: i64 = db
            .conn()
            .query_row(
                "SELECT count(*) FROM txn_history WHERE txn_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            rows, 2,
            "правка формы — одна строка, массовое действие — вторая"
        );

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

    #[test]
    fn undo_order_and_separate_actions() {
        use crate::receipts::{self, PartInput, ReceiptInput};
        use crate::transactions::TxnExtra;
        use crate::{bulk, undo};
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
        let id =
            transactions::create_with(db.conn_mut(), &input(&card, 50_000, &food), &extra("А"))
                .unwrap();

        // Две отдельные правки тегов в одну секунду — две записи.
        bulk::tag(db.conn_mut(), std::slice::from_ref(&id), "Б", true).unwrap();
        bulk::tag(db.conn_mut(), std::slice::from_ref(&id), "В", true).unwrap();
        assert_eq!(for_txn(db.conn(), &id).unwrap().len(), 2);

        // Ctrl+Z правки тегов и суммы: история показывает возврат.
        let mut j = undo::Journal::default();
        j.record(db.conn_mut(), "Правка", |c| {
            transactions::update_with(c, &id, &input(&card, 40_000, &food), &extra("Г"))
        })
        .unwrap();
        j.undo(db.conn()).unwrap();
        let h = for_txn(db.conn(), &id).unwrap();
        assert_eq!(h.len(), 4, "{h:?}");
        let tags = h[0].fields.iter().find(|f| f.field == "Теги").unwrap();
        assert_eq!(
            (tags.before.as_str(), tags.after.as_str()),
            ("Г", "А, Б, В")
        );
        assert!(h[0]
            .fields
            .iter()
            .any(|f| f.field == "Сумма" && f.after == "500 ₽"));
        j.redo(db.conn()).unwrap();
        let h = for_txn(db.conn(), &id).unwrap();
        assert_eq!(
            h[0].fields
                .iter()
                .find(|f| f.field == "Теги")
                .unwrap()
                .after,
            "Г"
        );

        // Чек: тот же состав в другом порядке — не изменение; отмена пересборки видна.
        let receipt = |parts: &[(&str, i64)]| ReceiptInput {
            date: "2026-11-05".into(),
            account_id: card.clone(),
            payee: None,
            note: None,
            total: parts.iter().map(|p| p.1).sum(),
            parts: parts
                .iter()
                .map(|(cat, a)| PartInput {
                    category_id: (*cat).into(),
                    amount: *a,
                    note: None,
                })
                .collect(),
            tags: vec![],
            event_id: None,
        };
        let split =
            receipts::create(db.conn_mut(), &receipt(&[(&food, 10_000), (&cafe, 30_000)])).unwrap();
        receipts::update(
            db.conn_mut(),
            &split,
            &receipt(&[(&cafe, 30_000), (&food, 10_000)]),
        )
        .unwrap();
        let first = |c: &Connection| {
            c.query_row(
                "SELECT id FROM transactions WHERE split_id = ?1 LIMIT 1",
                [&split],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
        };
        assert!(get(db.conn(), &first(db.conn()), Some(&split))
            .unwrap()
            .changes
            .is_empty());
        let mut j = undo::Journal::default();
        j.record(db.conn_mut(), "Чек", |c| {
            receipts::update(c, &split, &receipt(&[(&food, 10_000), (&cafe, 40_000)]))
        })
        .unwrap();
        j.undo(db.conn()).unwrap();
        let h = get(db.conn(), &first(db.conn()), Some(&split))
            .unwrap()
            .changes;
        assert_eq!(h.len(), 2, "{h:?}");
        assert!(
            h[0].fields[0].after.contains("300 ₽") && h[0].fields[0].before.contains("400 ₽"),
            "{h:?}"
        );
    }
}
