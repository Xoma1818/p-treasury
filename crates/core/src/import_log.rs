//! История импорта и сопоставление записей (0.22).
//!
//! Каждый импорт — запись истории: когда, какой файл, сколько операций
//! добавлено, связано с ручными записями и пропущено как повтор. Импорт можно
//! отменить целиком.
//!
//! Строка выписки, похожая на уже записанную вручную операцию (тот же счёт,
//! тип и сумма, дата ±3 дня; разбитый чек — по сумме частей; перевод между
//! своими счетами — по своей стороне), связывается с ней: запись остаётся как
//! есть, а данные строки банка запоминаются в `import_links`. Сами
//! связываются только однозначные совпадения: у строки одна подходящая запись,
//! и на эту запись не претендует другая строка той же выписки. Остальные
//! строки добавляются, а возможные совпадения ждут подтверждения — как и две
//! стороны перевода, пришедшие отдельными строками выписок.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::invalid;
use crate::transactions::{self, TxnInput};
use crate::{ids, time, Error, Result};

/// На сколько дней дата в банке может отличаться от записанной вручную.
pub const SAME_DAYS: i64 = 3;
/// На сколько дней могут расходиться две стороны перевода.
pub const TRANSFER_DAYS: i64 = 2;
/// Больше вариантов к одной строке не предлагаем.
const MAX_CANDIDATES: usize = 5;

/// Откуда импорт: окно «Импорт операций» или папка автоимпорта.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Manual,
    Folder,
}

impl Origin {
    fn key(self) -> &'static str {
        match self {
            Origin::Manual => "manual",
            Origin::Folder => "folder",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub import_id: String,
    pub added: usize,
    /// Строки, сами связанные с уже записанными операциями.
    pub linked: usize,
    /// Возможные совпадения, ждущие подтверждения.
    pub suggested: usize,
}

/// Запись, с которой можно связать строку выписки: одна операция или
/// разбитый чек целиком (тогда `id` — любая его часть).
#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    id: String,
    split_id: Option<String>,
}

/// Подходящие ручные записи для строки выписки.
fn candidates(conn: &Connection, t: &TxnInput) -> Result<Vec<Candidate>> {
    let mut out = Vec::new();
    let near = "abs(julianday(t.date) - julianday(?3)) <= ?4";
    let free = "t.status = 'cleared' AND t.import_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM import_links l WHERE l.transaction_id = t.id AND l.account_id = ?1)";
    // Обычная операция того же типа.
    let mut stmt = conn.prepare(&format!(
        "SELECT t.id FROM transactions t
         WHERE t.account_id = ?1 AND t.type = ?2 AND t.amount = ?5 AND t.split_id IS NULL
           AND {near} AND {free}
         ORDER BY abs(julianday(t.date) - julianday(?3)), t.created_at"
    ))?;
    for id in stmt.query_map(
        params![t.account_id, t.kind, t.date, SAME_DAYS, t.amount],
        |r| r.get::<_, String>(0),
    )? {
        out.push(Candidate {
            id: id?,
            split_id: None,
        });
    }
    // Разбитый чек: сумма частей равна сумме строки.
    if t.kind == "expense" {
        let mut stmt = conn.prepare(&format!(
            "SELECT min(t.id), t.split_id FROM transactions t
             WHERE t.account_id = ?1 AND t.type = ?2 AND t.split_id IS NOT NULL
               AND {near} AND {free}
             GROUP BY t.split_id HAVING sum(t.amount) = ?5"
        ))?;
        for r in stmt.query_map(
            params![t.account_id, t.kind, t.date, SAME_DAYS, t.amount],
            |r| {
                Ok(Candidate {
                    id: r.get(0)?,
                    split_id: r.get(1)?,
                })
            },
        )? {
            out.push(r?);
        }
    }
    // Записанный вручную перевод между своими счетами: списание — сторона
    // «откуда», поступление — сторона «куда».
    let side = if t.kind == "expense" {
        "t.account_id = ?1 AND t.amount = ?5"
    } else {
        "t.to_account_id = ?1 AND t.to_amount = ?5"
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT t.id FROM transactions t
         WHERE t.type = 'transfer' AND {side} AND ?2 IN ('expense', 'income')
           AND {near} AND {free}"
    ))?;
    for id in stmt.query_map(
        params![t.account_id, t.kind, t.date, SAME_DAYS, t.amount],
        |r| r.get::<_, String>(0),
    )? {
        out.push(Candidate {
            id: id?,
            split_id: None,
        });
    }
    out.truncate(MAX_CANDIDATES);
    Ok(out)
}

/// Запомнить у записи `c` строку выписки `t` (у разбитого чека — у всех частей).
fn link(conn: &Connection, c: &Candidate, t: &TxnInput, import_id: &str, auto: bool) -> Result<()> {
    let ids: Vec<String> = match &c.split_id {
        Some(split) => {
            let mut stmt = conn.prepare("SELECT id FROM transactions WHERE split_id = ?1")?;
            let rows = stmt.query_map([split], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        }
        None => vec![c.id.clone()],
    };
    for id in ids {
        conn.execute(
            "INSERT OR REPLACE INTO import_links
               (transaction_id, account_id, import_id, kind, bank_date, bank_amount, bank_payee, auto)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, coalesce(?7, ''), ?8)",
            params![
                id,
                t.account_id,
                import_id,
                t.kind,
                t.date,
                t.amount,
                t.payee,
                auto
            ],
        )?;
    }
    Ok(())
}

/// Кандидаты к каждой строке и можно ли связать её саму. Ищутся до вставки:
/// строки этой же выписки ими не бывают.
fn plan(conn: &Connection, bank: bool, inputs: &[TxnInput]) -> Result<Vec<(Vec<Candidate>, bool)>> {
    if !bank {
        return Ok(vec![(Vec::new(), false); inputs.len()]);
    }
    let found: Vec<Vec<Candidate>> = inputs
        .iter()
        .map(|t| candidates(conn, t))
        .collect::<Result<_>>()?;
    let claims = |c: &Candidate| {
        found
            .iter()
            .filter(|list| list.iter().any(|x| x == c))
            .count()
    };
    let sure: Vec<bool> = found
        .iter()
        .map(|list| list.len() == 1 && claims(&list[0]) == 1)
        .collect();
    Ok(found.into_iter().zip(sure).collect())
}

/// Что будет со строкой выписки при загрузке (для предпросмотра).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Mark {
    New,
    /// Свяжется сама с этой записью: «19.10 · Продукты».
    Link(String),
    /// Добавится, а возможные совпадения (сколько) попросят подтверждения.
    Doubt(usize),
}

pub(crate) fn marks(conn: &Connection, bank: bool, inputs: &[TxnInput]) -> Result<Vec<Mark>> {
    plan(conn, bank, inputs)?
        .into_iter()
        .map(|(list, sure)| {
            Ok(match (list.first(), sure) {
                (Some(c), true) => {
                    let s = side(conn, &c.id)?;
                    let what = s.category.or(s.payee).unwrap_or_else(|| match s.parts {
                        0 => "перевод".into(),
                        n => format!("чек из {n} частей"),
                    });
                    let d = &s.date;
                    Mark::Link(format!("{}.{} · {what}", &d[8..10], &d[5..7]))
                }
                (None, _) => Mark::New,
                (Some(_), false) => Mark::Doubt(list.len()),
            })
        })
        .collect()
}

/// Сохранить операции импорта одной записью истории. `inputs` — строки, которых
/// ещё нет в базе; `skipped` — сколько строк пропущено как повтор. `bank` —
/// выписка банка: только её строки сопоставляются с ручными записями (CSV по
/// шаблону — это уже свои записи). Вызывать внутри транзакции.
pub fn save(
    conn: &Connection,
    origin: Origin,
    file_name: &str,
    bank: Option<&str>,
    inputs: &[TxnInput],
    skipped: usize,
) -> Result<Saved> {
    save_with_raw(conn, origin, file_name, bank, inputs, &[], skipped)
}

/// То же, что [`save`]; `raws[i]` — текст получателя строки `inputs[i]` в
/// выписке до правил. Он запоминается как ключ повтора (B3): новое правило или
/// правка записи не заставят ту же строку банка загрузиться второй раз.
pub fn save_with_raw(
    conn: &Connection,
    origin: Origin,
    file_name: &str,
    bank: Option<&str>,
    inputs: &[TxnInput],
    raws: &[Option<String>],
    skipped: usize,
) -> Result<Saved> {
    let import_id = ids::new_id();
    let now = time::now_utc();
    conn.execute(
        "INSERT INTO import_batches (id, created_at, origin, file_name, bank, skipped)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            import_id,
            now,
            origin.key(),
            file_name,
            bank,
            skipped as i64
        ],
    )?;
    let mut out = Saved {
        import_id: import_id.clone(),
        ..Default::default()
    };
    let found = plan(conn, bank.is_some(), inputs)?;
    let mut new_ids = Vec::new();
    for (i, (t, (list, sure))) in inputs.iter().zip(&found).enumerate() {
        let raw = raws.get(i).cloned().flatten().or_else(|| t.payee.clone());
        if *sure {
            link(conn, &list[0], t, &import_id, true)?;
            out.linked += 1;
            continue;
        }
        let id = transactions::create(conn, t)?;
        conn.execute(
            "UPDATE transactions SET import_id = ?2 WHERE id = ?1",
            params![id, import_id],
        )?;
        // Ключ строки банка: повтор узнаётся и после правки записи (B3).
        conn.execute(
            "INSERT OR REPLACE INTO import_keys
               (transaction_id, account_id, kind, bank_date, bank_amount, bank_payee)
             VALUES (?1, ?2, ?3, ?4, ?5, coalesce(?6, ''))",
            params![id, t.account_id, t.kind, t.date, t.amount, raw],
        )?;
        out.added += 1;
        for c in list {
            suggest(conn, &import_id, "same", &id, &c.id, &now)?;
            out.suggested += 1;
        }
        if list.is_empty() && bank.is_some() {
            new_ids.push((id, t));
        }
    }
    // Две стороны перевода: списание с одного своего счёта и поступление той
    // же суммы на другой в пределах двух дней. Всегда на подтверждение.
    for (id, t) in &new_ids {
        for other in transfer_candidates(conn, id, t)? {
            if suggest(conn, &import_id, "transfer", id, &other, &now)? {
                out.suggested += 1;
            }
        }
    }
    conn.execute(
        "UPDATE import_batches SET added = ?2, linked = ?3 WHERE id = ?1",
        params![import_id, out.added as i64, out.linked as i64],
    )?;
    Ok(out)
}

/// Записать возможное совпадение; пара, уже предложенная в любом порядке, не
/// повторяется. `true` — записано.
fn suggest(
    conn: &Connection,
    import_id: &str,
    kind: &str,
    new_id: &str,
    old_id: &str,
    now: &str,
) -> Result<bool> {
    let known: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM import_suggestions
          WHERE (new_id = ?1 AND old_id = ?2) OR (new_id = ?2 AND old_id = ?1))",
        params![new_id, old_id],
        |r| r.get(0),
    )?;
    if known {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO import_suggestions (id, import_id, kind, new_id, old_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![ids::new_id(), import_id, kind, new_id, old_id, now],
    )?;
    Ok(true)
}

/// Противоположная операция той же суммы на другом своём счёте в той же валюте.
fn transfer_candidates(conn: &Connection, id: &str, t: &TxnInput) -> Result<Vec<String>> {
    let opposite = if t.kind == "expense" {
        "income"
    } else {
        "expense"
    };
    let mut stmt = conn.prepare(
        "SELECT t.id FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN accounts me ON me.id = ?1
         WHERE t.type = ?2 AND t.amount = ?3 AND t.account_id <> ?1 AND t.id <> ?4
           AND a.currency_code = me.currency_code AND a.type <> 'debt'
           AND t.status = 'cleared' AND t.split_id IS NULL AND t.debt_id IS NULL
           AND abs(julianday(t.date) - julianday(?5)) <= ?6
         ORDER BY abs(julianday(t.date) - julianday(?5)) LIMIT ?7",
    )?;
    let rows = stmt.query_map(
        params![
            t.account_id,
            opposite,
            t.amount,
            id,
            t.date,
            TRANSFER_DAYS,
            MAX_CANDIDATES as i64
        ],
        |r| r.get(0),
    )?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

// ---------- История ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub created_at: String,
    pub origin: String,
    pub file_name: String,
    pub bank: Option<String>,
    /// Сколько было при импорте.
    pub added: i64,
    pub linked: i64,
    pub skipped: i64,
    /// Сколько операций импорта сейчас в базе.
    pub present: i64,
    /// Из них изменены после импорта.
    pub edited: i64,
    /// Совпадения, ждущие подтверждения.
    pub pending: i64,
    pub undone_at: Option<String>,
}

pub fn history(conn: &Connection, limit: i64) -> Result<Vec<Batch>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.created_at, b.origin, b.file_name, b.bank, b.added, b.linked, b.skipped,
                (SELECT count(*) FROM transactions t WHERE t.import_id = b.id),
                (SELECT count(*) FROM transactions t WHERE t.import_id = b.id AND t.updated_at <> t.created_at),
                (SELECT count(*) FROM import_suggestions s WHERE s.import_id = b.id),
                b.undone_at
         FROM import_batches b ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(Batch {
            id: r.get(0)?,
            created_at: r.get(1)?,
            origin: r.get(2)?,
            file_name: r.get(3)?,
            bank: r.get(4)?,
            added: r.get(5)?,
            linked: r.get(6)?,
            skipped: r.get(7)?,
            present: r.get(8)?,
            edited: r.get(9)?,
            pending: r.get(10)?,
            undone_at: r.get(11)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Отменить импорт: удалить добавленные им операции и забыть связи и
/// совпадения. Ручные записи, с которыми связались строки, остаются как есть.
/// Возвращает число удалённых операций.
pub fn undo(conn: &Connection, import_id: &str) -> Result<usize> {
    let undone: Option<Option<String>> = conn
        .query_row(
            "SELECT undone_at FROM import_batches WHERE id = ?1",
            [import_id],
            |r| r.get(0),
        )
        .optional()?;
    match undone {
        None => return Err(Error::NotFound("импорт")),
        Some(Some(_)) => return invalid("этот импорт уже отменён"),
        Some(None) => {}
    }
    unmerge(conn, import_id)?;
    conn.execute(
        "DELETE FROM import_suggestions WHERE import_id = ?1",
        [import_id],
    )?;
    conn.execute("DELETE FROM import_links WHERE import_id = ?1", [import_id])?;
    let n = conn.execute("DELETE FROM transactions WHERE import_id = ?1", [import_id])?;
    conn.execute(
        "UPDATE import_batches SET undone_at = ?2 WHERE id = ?1",
        params![import_id, time::now_utc()],
    )?;
    Ok(n)
}

// ---------- Совпадения на подтверждение ----------

/// Одна сторона совпадения, как её видно в списке.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub date: String,
    pub amount: i64,
    pub account_id: String,
    pub account: String,
    pub to_account: Option<String>,
    pub currency: String,
    pub category: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    /// Частей разбитого чека (0 — обычная операция).
    pub parts: i64,
    pub tags: i64,
    /// Добавлена импортом (а не записана вручную).
    pub imported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub import_id: String,
    /// `same` — одна и та же операция, `transfer` — две стороны перевода.
    pub kind: String,
    /// Строка выписки.
    pub new: Side,
    /// Запись, с которой её предлагается связать.
    pub old: Side,
}

fn side(conn: &Connection, id: &str) -> Result<Side> {
    conn.query_row(
        "SELECT t.id, t.type, t.date,
                CASE WHEN t.split_id IS NULL THEN t.amount
                     ELSE (SELECT sum(p.amount) FROM transactions p WHERE p.split_id = t.split_id) END,
                t.account_id, a.name, ta.name, a.currency_code,
                CASE WHEN t.split_id IS NULL THEN c.name END, t.payee, t.note,
                CASE WHEN t.split_id IS NULL THEN 0
                     ELSE (SELECT count(*) FROM transactions p WHERE p.split_id = t.split_id) END,
                (SELECT count(*) FROM transaction_tags g WHERE g.transaction_id = t.id),
                t.import_id IS NOT NULL
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN accounts ta ON ta.id = t.to_account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.id = ?1",
        [id],
        |r| {
            Ok(Side {
                id: r.get(0)?,
                kind: r.get(1)?,
                date: r.get(2)?,
                amount: r.get(3)?,
                account_id: r.get(4)?,
                account: r.get(5)?,
                to_account: r.get(6)?,
                currency: r.get(7)?,
                category: r.get(8)?,
                payee: r.get(9)?,
                note: r.get(10)?,
                parts: r.get(11)?,
                tags: r.get(12)?,
                imported: r.get(13)?,
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("операция"))
}

/// Совпадения, ждущие подтверждения, новые сверху.
pub fn suggestions(conn: &Connection) -> Result<Vec<Suggestion>> {
    let mut stmt = conn.prepare(
        "SELECT id, import_id, kind, new_id, old_id FROM import_suggestions
         ORDER BY created_at DESC, rowid",
    )?;
    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    rows.into_iter()
        .map(|(id, import_id, kind, n, o)| {
            Ok(Suggestion {
                id,
                import_id,
                kind,
                new: side(conn, &n)?,
                old: side(conn, &o)?,
            })
        })
        .collect()
}

struct Row {
    import_id: String,
    kind: String,
    new_id: String,
    old_id: String,
}

fn suggestion(conn: &Connection, id: &str) -> Result<Row> {
    conn.query_row(
        "SELECT import_id, kind, new_id, old_id FROM import_suggestions WHERE id = ?1",
        [id],
        |r| {
            Ok(Row {
                import_id: r.get(0)?,
                kind: r.get(1)?,
                new_id: r.get(2)?,
                old_id: r.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("совпадение"))
}

/// Данные строки банка у операции, добавленной импортом.
fn as_input(conn: &Connection, id: &str) -> Result<TxnInput> {
    Ok(conn.query_row(
        "SELECT type, date, account_id, amount, payee FROM transactions WHERE id = ?1",
        [id],
        |r| {
            Ok(TxnInput {
                kind: r.get(0)?,
                date: r.get(1)?,
                account_id: r.get(2)?,
                amount: r.get(3)?,
                category_id: None,
                to_account_id: None,
                to_amount: None,
                payee: r.get(4)?,
                note: None,
            })
        },
    )?)
}

/// Подтвердить совпадение. `same`: операция из выписки удаляется, её строка
/// банка запоминается у ручной записи (категории, части чека, теги и заметки
/// не меняются). `transfer`: две операции становятся одним переводом между
/// своими счетами. Возвращает id оставшейся операции.
pub fn accept(conn: &Connection, id: &str) -> Result<String> {
    let s = suggestion(conn, id)?;
    let bank = as_input(conn, &s.new_id)?;
    if s.kind == "same" {
        let split_id: Option<String> = conn.query_row(
            "SELECT split_id FROM transactions WHERE id = ?1",
            [&s.old_id],
            |r| r.get(0),
        )?;
        let old = Candidate {
            id: s.old_id.clone(),
            split_id: split_id.clone(),
        };
        link(conn, &old, &bank, &s.import_id, false)?;
        // Другие предложения к этой же ручной записи больше не нужны.
        conn.execute(
            "DELETE FROM import_suggestions WHERE kind = 'same' AND (old_id = ?1
               OR old_id IN (SELECT id FROM transactions WHERE ?2 IS NOT NULL AND split_id = ?2))",
            params![s.old_id, split_id],
        )?;
        // Что успели прикрепить к строке выписки, переходит к ручной записи.
        carry_attached(conn, &s.new_id, &s.old_id)?;
        conn.execute(
            "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
             SELECT ?2, tag_id FROM transaction_tags WHERE transaction_id = ?1",
            params![s.new_id, s.old_id],
        )?;
        conn.execute("DELETE FROM transactions WHERE id = ?1", [&s.new_id])?;
        conn.execute(
            "UPDATE import_batches SET added = added - 1, linked = linked + 1 WHERE id = ?1",
            [&s.import_id],
        )?;
        return Ok(s.old_id);
    }
    let other = as_input(conn, &s.old_id)?;
    let (out, into, out_id, into_id) = if bank.kind == "expense" {
        (&bank, &other, &s.new_id, &s.old_id)
    } else {
        (&other, &bank, &s.old_id, &s.new_id)
    };
    let notes: Vec<String> = conn
        .prepare("SELECT note FROM transactions WHERE id IN (?1, ?2) AND coalesce(note, '') <> ''")?
        .query_map(params![out_id, into_id], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let transfer = transactions::create(
        conn,
        &TxnInput {
            kind: "transfer".into(),
            date: out.date.clone(),
            account_id: out.account_id.clone(),
            amount: out.amount,
            category_id: None,
            to_account_id: Some(into.account_id.clone()),
            to_amount: Some(into.amount),
            payee: None,
            note: (!notes.is_empty()).then(|| notes.join("; ")),
        },
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
         SELECT ?1, tag_id FROM transaction_tags WHERE transaction_id IN (?2, ?3)",
        params![transfer, out_id, into_id],
    )?;
    // Стороны, пришедшие из выписок, запоминаются у перевода: повторная выписка
    // их не добавит.
    for (side_id, input) in [(out_id, out), (into_id, into)] {
        let from: Option<String> = conn.query_row(
            "SELECT import_id FROM transactions WHERE id = ?1",
            [side_id],
            |r| r.get(0),
        )?;
        if let Some(import_id) = from {
            let c = Candidate {
                id: transfer.clone(),
                split_id: None,
            };
            link(conn, &c, input, &import_id, false)?;
            conn.execute(
                "UPDATE import_batches SET added = added - 1, linked = linked + 1 WHERE id = ?1",
                [&import_id],
            )?;
        }
    }
    for side_id in [out_id, into_id] {
        remember_side(conn, &transfer, side_id)?;
        carry_attached(conn, side_id, &transfer)?;
    }
    conn.execute(
        "DELETE FROM transactions WHERE id IN (?1, ?2)",
        params![out_id, into_id],
    )?;
    Ok(transfer)
}

/// Колонки `transactions`, как они есть в этой версии базы.
fn txn_columns(conn: &Connection) -> Result<Vec<String>> {
    Ok(conn
        .prepare("SELECT name FROM pragma_table_info('transactions')")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?)
}

/// Запомнить сторону перевода целиком (все колонки и теги) перед удалением.
fn remember_side(conn: &Connection, transfer: &str, side_id: &str) -> Result<()> {
    let fields = txn_columns(conn)?
        .iter()
        .map(|c| format!("'{c}', \"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "INSERT INTO import_merges (transfer_id, side_id, import_id, row_json, tags_json,
                                        attached_json)
             SELECT ?1, id, import_id, json_object({fields}),
                    (SELECT json_group_array(tag_id) FROM transaction_tags
                     WHERE transaction_id = t.id),
                    json_object(
                      'notes', (SELECT json_group_array(id) FROM notes
                                WHERE transaction_id = t.id),
                      'occurrences', (SELECT json_group_array(id) FROM reminder_occurrences
                                      WHERE transaction_id = t.id))
             FROM transactions t WHERE id = ?2"
        ),
        params![transfer, side_id],
    )?;
    Ok(())
}

/// Заметки и отметки «оплачено» у напоминаний переходят к другой операции:
/// при удалении `from` связь иначе обнулится (ON DELETE SET NULL).
pub(crate) fn carry_attached(conn: &Connection, from: &str, to: &str) -> Result<()> {
    for table in ["notes", "reminder_occurrences"] {
        conn.execute(
            &format!("UPDATE {table} SET transaction_id = ?2 WHERE transaction_id = ?1"),
            params![from, to],
        )?;
    }
    Ok(())
}

/// Связи строк банка и предложения сопоставления у частей чека, который
/// записывается заново (`receipts::update`), переходят к новым частям.
pub(crate) fn carry_matches(conn: &Connection, old: &[String], new: &[String]) -> Result<()> {
    for o in old {
        for n in new {
            conn.execute(
                "INSERT OR IGNORE INTO import_links
                   (transaction_id, account_id, import_id, kind, bank_date, bank_amount,
                    bank_payee, auto)
                 SELECT ?2, account_id, import_id, kind, bank_date, bank_amount, bank_payee, auto
                 FROM import_links WHERE transaction_id = ?1",
                params![o, n],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO import_keys
                   (transaction_id, account_id, kind, bank_date, bank_amount, bank_payee)
                 SELECT ?2, account_id, kind, bank_date, bank_amount, bank_payee
                 FROM import_keys WHERE transaction_id = ?1",
                params![o, n],
            )?;
        }
        if let Some(anchor) = new.iter().max() {
            conn.execute(
                "UPDATE OR IGNORE import_suggestions SET old_id = ?2 WHERE old_id = ?1",
                params![o, anchor],
            )?;
        }
    }
    Ok(())
}

/// Отмена импорта, одна сторона которого вошла в объединённый перевод:
/// перевод удаляется, а сторона другой выписки (если её импорт не отменён) или
/// ручная запись возвращается как была.
fn unmerge(conn: &Connection, import_id: &str) -> Result<()> {
    let transfers: Vec<String> = conn
        .prepare("SELECT DISTINCT transfer_id FROM import_merges WHERE import_id = ?1")?
        .query_map([import_id], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let cols = txn_columns(conn)?;
    let names = cols
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    // Необязательная ссылка на то, что успели удалить (событие, правило
    // повтора, категорию), возвращается пустой, а не ломает отмену.
    let fks: Vec<(String, String, String)> = conn
        .prepare("SELECT \"from\", \"table\", \"to\" FROM pragma_foreign_key_list('transactions')")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let values = cols
        .iter()
        .map(|c| {
            let v = format!("json_extract(row_json, '$.\"{c}\"')");
            match fks.iter().find(|(from, _, _)| from == c) {
                Some((_, table, to)) if c != "account_id" => format!(
                    "CASE WHEN EXISTS (SELECT 1 FROM \"{table}\" WHERE \"{to}\" = {v}) THEN {v} END"
                ),
                _ => v,
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    for transfer in transfers {
        let back: Vec<(String, Option<String>, String, String)> = conn
            .prepare(
                "SELECT m.side_id, m.import_id, m.tags_json, m.attached_json FROM import_merges m
                 LEFT JOIN import_batches b ON b.id = m.import_id
                 WHERE m.transfer_id = ?1
                   AND (m.import_id IS NULL OR (m.import_id <> ?2 AND b.undone_at IS NULL))",
            )?
            .query_map(params![transfer, import_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<std::result::Result<_, _>>()?;
        for (side, from, tags, attached) in &back {
            conn.execute(
                &format!(
                    "INSERT INTO transactions ({names})
                     SELECT {values} FROM import_merges WHERE transfer_id = ?1 AND side_id = ?2"
                ),
                params![transfer, side],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
                 SELECT ?1, value FROM json_each(?2) WHERE value IN (SELECT id FROM tags)",
                params![side, tags],
            )?;
            // Заметки и отметки «оплачено», если их не перевесили на другое.
            for (table, key) in [("notes", "notes"), ("reminder_occurrences", "occurrences")] {
                conn.execute(
                    &format!(
                        "UPDATE {table} SET transaction_id = ?1
                         WHERE transaction_id = ?2
                           AND id IN (SELECT value FROM json_each(?3, '$.{key}'))"
                    ),
                    params![side, transfer, attached],
                )?;
            }
            if let Some(from) = from {
                conn.execute(
                    "UPDATE import_batches SET added = added + 1, linked = linked - 1 WHERE id = ?1",
                    [from],
                )?;
            }
        }
        // Связи строк банка и сохранённые стороны уходят вместе с переводом.
        conn.execute("DELETE FROM transactions WHERE id = ?1", [&transfer])?;
    }
    Ok(())
}

/// Это разные операции: предложение больше не показывается.
pub fn reject(conn: &Connection, id: &str) -> Result<()> {
    suggestion(conn, id)?;
    conn.execute("DELETE FROM import_suggestions WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, AccountInput};
    use crate::storage::Storage;

    fn account(c: &Connection, name: &str) -> String {
        accounts::create(
            c,
            &AccountInput {
                name: name.into(),
                kind: "debit".into(),
                currency_code: "RUB".into(),
                opening_balance: 0,
                opening_date: "2026-01-01".into(),
                credit_limit: None,
                include_in_total: true,
                invest_kind: None,
            },
        )
        .unwrap()
    }

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn op(kind: &str, date: &str, acc: &str, amount: i64, cat: &str, payee: &str) -> TxnInput {
        TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: acc.into(),
            amount,
            category_id: Some(cat.into()),
            to_account_id: None,
            to_amount: None,
            payee: Some(payee.into()),
            note: None,
        }
    }

    fn count(c: &Connection) -> i64 {
        c.query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn manual_entry_is_linked_and_kept() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = account(c, "Карта");
        let food = cat(c, "Продукты");
        let other = cat(c, "Прочие расходы");
        let mut manual = op("expense", "2026-10-19", &card, 125_000, &food, "Продукты");
        manual.note = Some("на неделю".into());
        let mine = transactions::create(c, &manual).unwrap();

        let bank = op(
            "expense",
            "2026-10-20",
            &card,
            125_000,
            &other,
            "PYATEROCHKA 1250",
        );
        assert_eq!(
            marks(c, true, std::slice::from_ref(&bank)).unwrap(),
            [Mark::Link("19.10 · Продукты".into())]
        );
        let r = save(
            c,
            Origin::Manual,
            "выписка.pdf",
            Some("Сбер"),
            std::slice::from_ref(&bank),
            0,
        )
        .unwrap();
        assert_eq!((r.added, r.linked, r.suggested), (0, 1, 0));
        assert_eq!(count(c), 1, "покупка одна");
        let (cat_id, note): (String, String) = c
            .query_row(
                "SELECT category_id, note FROM transactions WHERE id = ?1",
                [&mine],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((cat_id, note.as_str()), (food, "на неделю"));
        // Повторная выписка узнаёт строку по связи.
        assert!(crate::bank_import::exists(c, &bank).unwrap());
        let h = history(c, 10).unwrap();
        assert_eq!((h[0].added, h[0].linked, h[0].present), (0, 1, 0));
    }

    #[test]
    fn split_receipt_and_manual_transfer_are_matched() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = account(db.conn(), "Карта");
        let save_acc = account(db.conn(), "Накопительный");
        let food = cat(db.conn(), "Продукты");
        let other = cat(db.conn(), "Прочие расходы");
        crate::receipts::create(
            db.conn_mut(),
            &crate::receipts::ReceiptInput {
                date: "2026-10-05".into(),
                account_id: card.clone(),
                payee: Some("Ашан".into()),
                note: None,
                total: 300_000,
                parts: vec![
                    crate::receipts::PartInput {
                        category_id: food.clone(),
                        amount: 200_000,
                        note: None,
                    },
                    crate::receipts::PartInput {
                        category_id: other.clone(),
                        amount: 100_000,
                        note: None,
                    },
                ],
                tags: Vec::new(),
                event_id: None,
            },
        )
        .unwrap();
        let c = db.conn();
        transactions::create(
            c,
            &TxnInput {
                kind: "transfer".into(),
                date: "2026-10-10".into(),
                account_id: card.clone(),
                amount: 1_000_000,
                category_id: None,
                to_account_id: Some(save_acc.clone()),
                to_amount: Some(1_000_000),
                payee: None,
                note: None,
            },
        )
        .unwrap();
        let before = count(c);
        let rows = [
            op("expense", "2026-10-06", &card, 300_000, &other, "AUCHAN"),
            op(
                "expense",
                "2026-10-10",
                &card,
                1_000_000,
                &other,
                "Перевод между счетами",
            ),
        ];
        let r = save(c, Origin::Manual, "t.csv", Some("Т-Банк"), &rows, 0).unwrap();
        assert_eq!((r.added, r.linked), (0, 2));
        assert_eq!(count(c), before);
        let links: i64 = c
            .query_row("SELECT count(*) FROM import_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(links, 3, "обе части чека и перевод");
    }

    #[test]
    fn doubtful_matches_wait_and_can_be_accepted() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = account(c, "Карта");
        let cafe = cat(c, "Кафе и рестораны");
        let other = cat(c, "Прочие расходы");
        let coffee = op("expense", "2026-10-02", &card, 25_000, &cafe, "Кофе");
        let mine = transactions::create(c, &coffee).unwrap();
        crate::tags::set_for(c, &mine, &["работа".to_string()]).unwrap();
        // Два одинаковых кофе в выписке, а записан один: какой из них — неясно.
        let a = op("expense", "2026-10-02", &card, 25_000, &other, "KOFEMANIYA");
        let b = op("expense", "2026-10-03", &card, 25_000, &other, "KOFEMANIYA");
        let r = save(c, Origin::Folder, "a.csv", Some("Т-Банк"), &[a, b], 0).unwrap();
        assert_eq!((r.added, r.linked, r.suggested), (2, 0, 2));
        let list = suggestions(c).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].old.tags, 1);
        let kept = accept(c, &list[0].id).unwrap();
        assert_eq!(kept, mine);
        assert!(
            suggestions(c).unwrap().is_empty(),
            "второе предложение к той же записи убрано"
        );
        assert_eq!(count(c), 2, "своя запись с тегом + второй кофе");
        let h = history(c, 1).unwrap();
        assert_eq!((h[0].added, h[0].linked), (1, 1));
    }

    #[test]
    fn two_imported_sides_become_a_transfer() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let sber = account(c, "Сбер");
        let tbank = account(c, "Т-Банк");
        let other = cat(c, "Прочие расходы");
        let inc = cat(c, "Прочие доходы");
        save(
            c,
            Origin::Manual,
            "sber.pdf",
            Some("Сбер"),
            &[op(
                "expense",
                "2026-10-10",
                &sber,
                500_000,
                &other,
                "Перевод на Т-Банк",
            )],
            0,
        )
        .unwrap();
        let r = save(
            c,
            Origin::Manual,
            "tbank.csv",
            Some("Т-Банк"),
            &[op(
                "income",
                "2026-10-11",
                &tbank,
                500_000,
                &inc,
                "Пополнение",
            )],
            0,
        )
        .unwrap();
        assert_eq!(r.suggested, 1);
        let s = suggestions(c).unwrap();
        assert_eq!(s[0].kind, "transfer");
        let id = accept(c, &s[0].id).unwrap();
        let (kind, from, to): (String, String, String) = c
            .query_row(
                "SELECT type, account_id, to_account_id FROM transactions WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (kind.as_str(), from, to),
            ("transfer", sber.clone(), tbank.clone())
        );
        assert_eq!(count(c), 1);
        // Обе выписки снова — ничего не добавится.
        assert!(crate::bank_import::exists(
            c,
            &op(
                "expense",
                "2026-10-10",
                &sber,
                500_000,
                &other,
                "Перевод на Т-Банк"
            )
        )
        .unwrap());
        assert!(crate::bank_import::exists(
            c,
            &op("income", "2026-10-11", &tbank, 500_000, &inc, "Пополнение")
        )
        .unwrap());
    }

    /// Две стороны перевода: Сбер (выписка или ручная запись) и Т-Банк
    /// (выписка), объединены в перевод. Возвращает (сбер, т-банк, импорт Сбера
    /// или None, импорт Т-Банка, перевод).
    fn merged(
        c: &Connection,
        sber_manual: bool,
    ) -> (String, String, Option<String>, String, String) {
        crate::categories::seed_defaults(c).unwrap();
        let sber = account(c, "Сбер");
        let tbank = account(c, "Т-Банк");
        let other = cat(c, "Прочие расходы");
        let inc = cat(c, "Прочие доходы");
        let out = op(
            "expense",
            "2026-10-10",
            &sber,
            500_000,
            &other,
            "Перевод на Т-Банк",
        );
        let first = if sber_manual {
            let id = transactions::create(
                c,
                &TxnInput {
                    note: Some("маме".into()),
                    ..out
                },
            )
            .unwrap();
            c.execute("INSERT INTO tags (id, name) VALUES ('t1', 'семья')", [])
                .unwrap();
            c.execute("INSERT INTO transaction_tags VALUES (?1, 't1')", [&id])
                .unwrap();
            // Своя категория и прикреплённая заметка.
            let gifts = crate::categories::create(
                c,
                &crate::categories::CategoryInput {
                    name: "Маме".into(),
                    kind: "expense".into(),
                    parent_id: None,
                },
            )
            .unwrap();
            c.execute(
                "UPDATE transactions SET category_id = ?2 WHERE id = ?1",
                params![id, gifts],
            )
            .unwrap();
            crate::notes::create(
                c,
                &crate::notes::NoteInput {
                    body: "на день рождения".into(),
                    date: None,
                    transaction_id: Some(id),
                    account_id: None,
                    debt_id: None,
                    budget_id: None,
                },
            )
            .unwrap();
            None
        } else {
            Some(
                save(c, Origin::Manual, "sber.pdf", Some("Сбер"), &[out], 0)
                    .unwrap()
                    .import_id,
            )
        };
        let r = save(
            c,
            Origin::Manual,
            "tbank.csv",
            Some("Т-Банк"),
            &[op(
                "income",
                "2026-10-11",
                &tbank,
                500_000,
                &inc,
                "Пополнение",
            )],
            0,
        )
        .unwrap();
        let s = suggestions(c).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].kind, "transfer");
        let transfer = accept(c, &s[0].id).unwrap();
        (sber, tbank, first, r.import_id, transfer)
    }

    fn bal(c: &Connection, acc: &str) -> i64 {
        accounts::balance(c, acc, None).unwrap()
    }

    fn counters(c: &Connection, id: &str) -> (i64, i64) {
        c.query_row(
            "SELECT added, linked FROM import_batches WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn undoing_both_imports_removes_merged_transfer() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let (sber, tbank, first, second, _) = merged(c, false);
        let before = (bal(c, &sber), bal(c, &tbank));
        undo(c, &first.unwrap()).unwrap();
        undo(c, &second).unwrap();
        assert_eq!(count(c), 0, "перевода не осталось");
        assert_eq!(
            (bal(c, &sber), bal(c, &tbank)),
            (0, 0),
            "балансы как до выписок"
        );
        assert_eq!(before, (-500_000, 500_000));
        let left: i64 = c
            .query_row("SELECT count(*) FROM import_merges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn undoing_one_import_brings_back_the_other_side() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let (sber, tbank, first, second, _) = merged(c, false);
        let first = first.unwrap();
        undo(c, &second).unwrap();
        // Осталась строка выписки Сбера, как до объединения.
        let (kind, amount, payee, from): (String, i64, String, String) = c
            .query_row(
                "SELECT type, amount, payee, import_id FROM transactions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (kind.as_str(), amount, payee.as_str()),
            ("expense", 500_000, "Перевод на Т-Банк")
        );
        assert_eq!(from, first);
        assert_eq!(counters(c, &first), (1, 0));
        assert_eq!((bal(c, &sber), bal(c, &tbank)), (-500_000, 0));
        // Повторная выписка Т-Банка снова предложит перевод, отмена Сбера — уберёт всё.
        assert!(!crate::bank_import::exists(
            c,
            &op(
                "income",
                "2026-10-11",
                &tbank,
                500_000,
                &cat(c, "Прочие доходы"),
                "Пополнение"
            )
        )
        .unwrap());
        assert_eq!(undo(c, &first).unwrap(), 1);
        assert_eq!(count(c), 0);
    }

    #[test]
    fn undoing_import_restores_manual_side_with_tags() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let (sber, tbank, _, second, transfer) = merged(c, true);
        let old: String = c
            .query_row(
                "SELECT side_id FROM import_merges WHERE import_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(old, transfer);
        undo(c, &second).unwrap();
        let (id, note, category): (String, String, Option<String>) = c
            .query_row("SELECT id, note, category_id FROM transactions", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((id.as_str(), note.as_str()), (old.as_str(), "маме"));
        assert_eq!(category, Some(cat(c, "Маме")));
        assert_eq!(note_of(c), Some(id.clone()), "заметка вернулась к записи");
        let tag: String = c
            .query_row(
                "SELECT tag_id FROM transaction_tags WHERE transaction_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tag, "t1");
        assert_eq!((bal(c, &sber), bal(c, &tbank)), (-500_000, 0));
    }

    fn note_of(c: &Connection) -> Option<String> {
        c.query_row("SELECT transaction_id FROM notes", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn merge_keeps_note_and_undo_survives_deleted_tag_and_category() {
        let mut db = Storage::open_in_memory().unwrap();
        let (_, _, _, second, transfer) = merged(db.conn(), true);
        let c = db.conn();
        assert_eq!(note_of(c), Some(transfer), "заметка перешла к переводу");
        // После объединения удалили тег и категорию: без переноса нельзя —
        // в ней сторона перевода.
        c.execute("DELETE FROM tags WHERE id = 't1'", []).unwrap();
        let (gifts, other) = (cat(c, "Маме"), cat(c, "Прочие расходы"));
        assert!(crate::categories::delete(db.conn_mut(), &gifts, None).is_err());
        crate::categories::delete(db.conn_mut(), &gifts, Some(&other)).unwrap();
        let c = db.conn();
        undo(c, &second).unwrap();
        let (id, category): (String, Option<String>) = c
            .query_row("SELECT id, category_id FROM transactions", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(category, Some(other));
        assert_eq!(note_of(c), Some(id));
        let tags: i64 = c
            .query_row("SELECT count(*) FROM transaction_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tags, 0);
    }

    #[test]
    fn confirmed_same_match_keeps_what_was_attached_to_bank_row() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = account(c, "Карта");
        let fun = cat(c, "Развлечения");
        let mine = |d: &str| {
            transactions::create(c, &op("expense", d, &card, 120_000, &fun, "Игра")).unwrap()
        };
        let (a, b) = (mine("2026-10-17"), mine("2026-10-19"));
        let row = op("expense", "2026-10-18", &card, 120_000, &fun, "STEAM");
        let r = save(c, Origin::Manual, "t.csv", Some("Т-Банк"), &[row], 0).unwrap();
        assert_eq!(r.suggested, 2);
        let new_id: String = c
            .query_row(
                "SELECT id FROM transactions WHERE import_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        crate::notes::create(
            c,
            &crate::notes::NoteInput {
                body: "чек в почте".into(),
                date: None,
                transaction_id: Some(new_id.clone()),
                account_id: None,
                debt_id: None,
                budget_id: None,
            },
        )
        .unwrap();
        c.execute("INSERT INTO tags (id, name) VALUES ('g', 'игры')", [])
            .unwrap();
        c.execute("INSERT INTO transaction_tags VALUES (?1, 'g')", [&new_id])
            .unwrap();
        let s = suggestions(c).unwrap();
        let kept = accept(c, &s[0].id).unwrap();
        assert!(kept == a || kept == b);
        assert_eq!(note_of(c), Some(kept.clone()));
        let tag: String = c
            .query_row("SELECT transaction_id FROM transaction_tags", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(tag, kept);
    }

    #[test]
    fn edited_receipt_stays_linked_to_bank_row() {
        let mut db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = account(db.conn(), "Карта");
        let food = cat(db.conn(), "Продукты");
        let other = cat(db.conn(), "Прочие расходы");
        let receipt = |a: i64, b: i64| crate::receipts::ReceiptInput {
            date: "2026-10-05".into(),
            account_id: card.clone(),
            payee: Some("Ашан".into()),
            note: None,
            total: a + b,
            parts: [(&food, a), (&other, b)]
                .into_iter()
                .map(|(c, amount)| crate::receipts::PartInput {
                    category_id: c.clone(),
                    amount,
                    note: None,
                })
                .collect(),
            tags: Vec::new(),
            event_id: None,
        };
        let split = crate::receipts::create(db.conn_mut(), &receipt(200_000, 100_000)).unwrap();
        let row = op("expense", "2026-10-06", &card, 300_000, &food, "AUCHAN");
        let r = save(
            db.conn(),
            Origin::Manual,
            "s.pdf",
            Some("Сбер"),
            std::slice::from_ref(&row),
            0,
        )
        .unwrap();
        assert_eq!(r.linked, 1);
        // Перераспределили сумму между частями и добавили третью.
        let mut edited = receipt(150_000, 100_000);
        edited.total = 300_000;
        edited.parts.push(crate::receipts::PartInput {
            category_id: food.clone(),
            amount: 50_000,
            note: None,
        });
        crate::receipts::update(db.conn_mut(), &split, &edited).unwrap();
        let c = db.conn();
        assert!(
            crate::bank_import::exists(c, &row).unwrap(),
            "повтор выписки узнаётся"
        );
        let again = save(c, Origin::Manual, "s.pdf", Some("Сбер"), &[], 1).unwrap();
        assert_eq!(again.added, 0);
        assert_eq!(count(c), 3);
        // Отмена импорта снимает связи и с новых частей.
        undo(c, &r.import_id).unwrap();
        assert!(!crate::bank_import::exists(c, &row).unwrap());
        assert_eq!(count(c), 3);
    }

    #[test]
    fn undo_removes_only_imported_operations() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = account(c, "Карта");
        let food = cat(c, "Продукты");
        let mine = transactions::create(
            c,
            &op("expense", "2026-10-01", &card, 10_000, &food, "Хлеб"),
        )
        .unwrap();
        let rows = [
            op("expense", "2026-10-01", &card, 10_000, &food, "MAGNIT"),
            op("expense", "2026-10-04", &card, 77_700, &food, "VKUSVILL"),
        ];
        let r = save(c, Origin::Manual, "x.pdf", Some("Сбер"), &rows, 3).unwrap();
        assert_eq!((r.added, r.linked), (1, 1));
        assert_eq!(undo(c, &r.import_id).unwrap(), 1);
        assert_eq!(count(c), 1);
        let left: String = c
            .query_row("SELECT id FROM transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, mine);
        assert!(
            !crate::bank_import::exists(c, &rows[0]).unwrap(),
            "связь забыта"
        );
        let h = history(c, 1).unwrap();
        assert!(h[0].undone_at.is_some());
        assert_eq!(h[0].skipped, 3);
        assert!(undo(c, &r.import_id).is_err());
    }

    #[test]
    fn template_csv_is_not_matched() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        crate::categories::seed_defaults(c).unwrap();
        let card = account(c, "Карта");
        let food = cat(c, "Продукты");
        transactions::create(
            c,
            &op("expense", "2026-10-01", &card, 10_000, &food, "Хлеб"),
        )
        .unwrap();
        let r = save(
            c,
            Origin::Manual,
            "шаблон.csv",
            None,
            &[op("expense", "2026-10-01", &card, 10_000, &food, "Молоко")],
            0,
        )
        .unwrap();
        assert_eq!((r.added, r.linked, r.suggested), (1, 0, 0));
    }
}
