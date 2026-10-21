//! Операции: доходы, расходы, переводы (в том числе между валютами).

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{accounts, categories, ids, money, time, Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnInput {
    #[serde(rename = "type")]
    pub kind: String,
    pub date: String,
    pub account_id: String,
    pub amount: i64,
    pub category_id: Option<String>,
    pub to_account_id: Option<String>,
    /// Сумма зачисления; для перевода в той же валюте можно не указывать.
    pub to_amount: Option<i64>,
    pub payee: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Txn {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub date: String,
    pub account_id: String,
    pub account_name: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub amount: i64,
    pub to_account_id: Option<String>,
    pub to_account_name: Option<String>,
    pub to_currency_symbol: Option<String>,
    pub to_minor_units: Option<u32>,
    pub to_amount: Option<i64>,
    pub category_id: Option<String>,
    /// «Транспорт → Такси» или «Продукты».
    pub category_name: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub debt_id: Option<String>,
    /// Поездка или событие, к которому отнесена операция.
    pub event_id: Option<String>,
    pub event_name: Option<String>,
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Проверенная операция, готовая к записи.
struct Checked {
    category_id: Option<String>,
    to_account_id: Option<String>,
    to_amount: Option<i64>,
    payee: Option<String>,
    note: Option<String>,
}

fn check_account(conn: &Connection, id: &str, previous: &[&str]) -> Result<accounts::Head> {
    let a = accounts::head(conn, id)?;
    if a.kind == "debt" {
        return invalid("операции по долгу записываются в разделе «Долги»");
    }
    // В закрытый счёт нельзя записать новую операцию, но старую можно поправить.
    if a.archived && !previous.contains(&id) {
        return invalid(format!("счёт «{}» закрыт", a.name));
    }
    Ok(a)
}

fn validate(conn: &Connection, input: &TxnInput, previous: &[&str]) -> Result<Checked> {
    time::check_date(&input.date)?;
    if input.amount <= 0 {
        return invalid("сумма должна быть больше нуля");
    }
    let from = check_account(conn, &input.account_id, previous)?;
    let payee = clean(&input.payee);
    let note = clean(&input.note);
    match input.kind.as_str() {
        "expense" | "income" => {
            let Some(cat) = input.category_id.as_deref() else {
                return invalid("выберите категорию");
            };
            if categories::kind_of(conn, cat)? != input.kind {
                return invalid(if input.kind == "expense" {
                    "для расхода нужна категория расходов"
                } else {
                    "для дохода нужна категория доходов"
                });
            }
            Ok(Checked {
                category_id: Some(cat.into()),
                to_account_id: None,
                to_amount: None,
                payee,
                note,
            })
        }
        "transfer" => {
            let Some(to_id) = input.to_account_id.as_deref() else {
                return invalid("выберите счёт зачисления");
            };
            if to_id == input.account_id {
                return invalid("перевод должен быть между разными счетами");
            }
            let to = check_account(conn, to_id, previous)?;
            let to_amount = match input.to_amount {
                Some(v) if v <= 0 => return invalid("сумма зачисления должна быть больше нуля"),
                Some(v) => v,
                None if from.currency_code == to.currency_code => input.amount,
                None => return invalid("счета в разных валютах: укажите сумму зачисления"),
            };
            if from.currency_code == to.currency_code && to_amount != input.amount {
                return invalid(
                    "счета в одной валюте: суммы списания и зачисления должны совпадать",
                );
            }
            Ok(Checked {
                category_id: None,
                to_account_id: Some(to_id.into()),
                to_amount: Some(to_amount),
                payee,
                note,
            })
        }
        "adjustment" => invalid("корректировка делается кнопкой «Сверить баланс» на счёте"),
        _ => invalid("тип операции: расход, доход или перевод"),
    }
}

pub fn create(conn: &Connection, input: &TxnInput) -> Result<String> {
    let c = validate(conn, input, &[])?;
    let id = ids::new_id();
    let now = time::now_utc();
    conn.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, category_id, to_account_id, to_amount,
                                   payee, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            input.kind,
            input.date,
            input.account_id,
            input.amount,
            c.category_id,
            c.to_account_id,
            c.to_amount,
            c.payee,
            c.note,
            now
        ],
    )?;
    Ok(id)
}

struct Existing {
    kind: String,
    account_id: String,
    to_account_id: Option<String>,
    debt_id: Option<String>,
}

fn existing(conn: &Connection, id: &str) -> Result<Existing> {
    conn.query_row(
        "SELECT type, account_id, to_account_id, debt_id FROM transactions WHERE id = ?1",
        [id],
        |r| {
            Ok(Existing {
                kind: r.get(0)?,
                account_id: r.get(1)?,
                to_account_id: r.get(2)?,
                debt_id: r.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("операция"))
}

pub fn update(conn: &Connection, id: &str, input: &TxnInput) -> Result<()> {
    let old = existing(conn, id)?;
    if old.debt_id.is_some() {
        return invalid("это платёж по долгу: измените его в карточке долга");
    }
    if old.kind == "adjustment" {
        return invalid("корректировку можно только удалить и сделать сверку заново");
    }
    let previous: Vec<&str> = [Some(old.account_id.as_str()), old.to_account_id.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    let c = validate(conn, input, &previous)?;
    conn.execute(
        "UPDATE transactions SET type = ?2, date = ?3, account_id = ?4, amount = ?5, category_id = ?6,
                to_account_id = ?7, to_amount = ?8, payee = ?9, note = ?10, updated_at = ?11
         WHERE id = ?1",
        params![
            id,
            input.kind,
            input.date,
            input.account_id,
            input.amount,
            c.category_id,
            c.to_account_id,
            c.to_amount,
            c.payee,
            c.note,
            time::now_utc()
        ],
    )?;
    Ok(())
}

/// Перенести операцию на другой день (перетаскиванием в календаре).
pub fn move_to(conn: &Connection, id: &str, date: &str) -> Result<()> {
    time::check_date(date)?;
    let old = existing(conn, id)?;
    if old.debt_id.is_some() {
        return invalid("это платёж по долгу: дату меняют в карточке долга");
    }
    if old.kind == "adjustment" {
        return invalid("корректировку нельзя перенести: сделайте сверку заново");
    }
    conn.execute(
        "UPDATE transactions SET date = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, date, time::now_utc()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    let old = existing(conn, id)?;
    if old.debt_id.is_some() {
        return invalid("это платёж по долгу: удалите его в карточке долга");
    }
    conn.execute("DELETE FROM transactions WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    /// Счёт списания или зачисления.
    pub account_id: Option<String>,
    /// Категория вместе с её подкатегориями.
    pub category_id: Option<String>,
    /// Типы операций; пусто — все.
    pub types: Vec<String>,
    /// Текст в получателе или комментарии, либо сумма («2340» или «2 340,50»).
    pub search: Option<String>,
    /// Операции поездки или события.
    pub event_id: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Txn>,
    pub total: i64,
}

const SELECT: &str =
    "SELECT t.id, t.type, t.date, t.account_id, a.name, ca.symbol, ca.minor_units, t.amount,
        t.to_account_id, ta.name, ct.symbol, ct.minor_units, t.to_amount, t.category_id,
        CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' → ' || c.name END,
        t.payee, t.note, t.debt_id, t.event_id, e.name
 FROM transactions t
 JOIN accounts a ON a.id = t.account_id
 JOIN currencies ca ON ca.code = a.currency_code
 LEFT JOIN accounts ta ON ta.id = t.to_account_id
 LEFT JOIN currencies ct ON ct.code = ta.currency_code
 LEFT JOIN categories c ON c.id = t.category_id
 LEFT JOIN categories p ON p.id = c.parent_id
 LEFT JOIN events e ON e.id = t.event_id";

fn map(r: &rusqlite::Row) -> rusqlite::Result<Txn> {
    Ok(Txn {
        id: r.get(0)?,
        kind: r.get(1)?,
        date: r.get(2)?,
        account_id: r.get(3)?,
        account_name: r.get(4)?,
        currency_symbol: r.get(5)?,
        minor_units: r.get(6)?,
        amount: r.get(7)?,
        to_account_id: r.get(8)?,
        to_account_name: r.get(9)?,
        to_currency_symbol: r.get(10)?,
        to_minor_units: r.get(11)?,
        to_amount: r.get(12)?,
        category_id: r.get(13)?,
        category_name: r.get(14)?,
        payee: r.get(15)?,
        note: r.get(16)?,
        debt_id: r.get(17)?,
        event_id: r.get(18)?,
        event_name: r.get(19)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> Result<Txn> {
    conn.query_row(&format!("{SELECT} WHERE t.id = ?1"), [id], map)
        .optional()?
        .ok_or(Error::NotFound("операция"))
}

/// Условие WHERE и его параметры для фильтра.
fn where_clause(conn: &Connection, f: &Filter) -> Result<(String, Vec<Value>)> {
    let mut wh = vec!["t.status = 'cleared'".to_string()];
    let mut args: Vec<Value> = Vec::new();
    let mut arg = |v: Value| {
        args.push(v);
        format!("?{}", args.len())
    };
    if let Some(d) = &f.date_from {
        wh.push(format!("t.date >= {}", arg(d.clone().into())));
    }
    if let Some(d) = &f.date_to {
        wh.push(format!("t.date <= {}", arg(d.clone().into())));
    }
    if let Some(a) = &f.account_id {
        let p = arg(a.clone().into());
        wh.push(format!("(t.account_id = {p} OR t.to_account_id = {p})"));
    }
    if let Some(c) = &f.category_id {
        let p = arg(c.clone().into());
        wh.push(format!("(t.category_id = {p} OR c.parent_id = {p})"));
    }
    if let Some(e) = &f.event_id {
        wh.push(format!("t.event_id = {}", arg(e.clone().into())));
    }
    if !f.types.is_empty() {
        let ps: Vec<String> = f.types.iter().map(|t| arg(t.clone().into())).collect();
        wh.push(format!("t.type IN ({})", ps.join(", ")));
    }
    if let Some(q) = f.search.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let like = arg(format!("%{}%", q.to_lowercase()).into());
        let mut cond = format!("(lower(t.payee) LIKE {like} OR lower(t.note) LIKE {like}");
        // SQLite lower() понимает только латиницу, поэтому кириллицу сравниваем через Rust-функцию.
        cond.push_str(&format!(
            " OR kz_lower(t.payee) LIKE {like} OR kz_lower(t.note) LIKE {like}"
        ));
        if let Ok(v) = money::parse_amount(q, 2) {
            if v > 0 {
                // Сумма ищется в минимальных единицах счёта; для валют без копеек отдельно.
                let p2 = arg(v.into());
                let p0 = arg((v / 100).into());
                cond.push_str(&format!(
                    " OR abs(t.amount) = CASE ca.minor_units WHEN 0 THEN {p0} ELSE {p2} END OR t.to_amount = {p2}"
                ));
            }
        }
        cond.push(')');
        wh.push(cond);
    }
    register_lower(conn)?;
    Ok((wh.join(" AND "), args))
}

/// Список операций по фильтру, новые сверху.
pub fn list(conn: &Connection, f: &Filter) -> Result<Page> {
    let (where_sql, args) = where_clause(conn, f)?;
    let total: i64 = conn.query_row(
        &format!(
            "SELECT count(*) FROM transactions t
             JOIN accounts a ON a.id = t.account_id JOIN currencies ca ON ca.code = a.currency_code
             LEFT JOIN categories c ON c.id = t.category_id WHERE {where_sql}"
        ),
        params_from_iter(args.iter()),
        |r| r.get(0),
    )?;
    let limit = f.limit.unwrap_or(200).clamp(1, 5000);
    let offset = f.offset.unwrap_or(0).max(0);
    let sql = format!(
        "{SELECT} WHERE {where_sql} ORDER BY t.date DESC, t.id DESC LIMIT {limit} OFFSET {offset}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(params_from_iter(args.iter()), map)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Page { items, total })
}

/// Все операции по фильтру одним запросом, новые сверху (выгрузки).
/// `limit` и `offset` фильтра не учитываются.
pub fn list_all(conn: &Connection, f: &Filter) -> Result<Vec<Txn>> {
    let (where_sql, args) = where_clause(conn, f)?;
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE {where_sql} ORDER BY t.date DESC, t.id DESC"
    ))?;
    let items = stmt
        .query_map(params_from_iter(args.iter()), map)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(items)
}

/// Функция `kz_lower` для поиска без учёта регистра по-русски.
pub(crate) fn register_lower(conn: &Connection) -> Result<()> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function(
        "kz_lower",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(ctx.get::<Option<String>>(0)?.map(|s| s.to_lowercase())),
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayeeHint {
    pub payee: String,
    pub category_id: Option<String>,
    pub account_id: String,
}

/// Подсказки получателей по началу или части имени: категория и счёт
/// берутся из последней операции с этим получателем.
pub fn payee_hints(
    conn: &Connection,
    kind: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<PayeeHint>> {
    register_lower(conn)?;
    let q = query.trim().to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT t.payee, t.category_id, t.account_id FROM transactions t
         WHERE t.payee IS NOT NULL AND t.type = ?1 AND kz_lower(t.payee) LIKE ?2
           AND t.date = (SELECT max(t2.date) FROM transactions t2 WHERE t2.payee = t.payee AND t2.type = ?1)
         GROUP BY t.payee
         ORDER BY kz_lower(t.payee) LIKE ?3 DESC,
                  (SELECT count(*) FROM transactions t3 WHERE t3.payee = t.payee) DESC, t.payee
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![kind, format!("%{q}%"), format!("{q}%"), limit as i64],
        |r| {
            Ok(PayeeHint {
                payee: r.get(0)?,
                category_id: r.get(1)?,
                account_id: r.get(2)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub to_account_id: Option<String>,
}

/// Последние использованные счёт и категория для типа операции (быстрый ввод).
pub fn defaults(conn: &Connection, kind: &str) -> Result<Defaults> {
    Ok(conn
        .query_row(
            "SELECT t.account_id, t.category_id, t.to_account_id FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             WHERE t.type = ?1 AND a.archived_at IS NULL AND a.type <> 'debt'
             ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1",
            [kind],
            |r| {
                Ok(Defaults {
                    account_id: r.get(0)?,
                    category_id: r.get(1)?,
                    to_account_id: r.get(2)?,
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input as acc;
    use crate::storage::Storage;

    struct Fx {
        db: Storage,
        card: String,
        cash: String,
        usd: String,
        food: String,
        cafe: String,
        lunch: String,
        salary: String,
    }

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn fx() -> Fx {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        Fx {
            card: accounts::create(c, &acc("Карта", "debit", "RUB", 10_000_000)).unwrap(),
            cash: accounts::create(c, &acc("Наличные", "cash", "RUB", 0)).unwrap(),
            usd: accounts::create(c, &acc("Вклад USD", "savings", "USD", 0)).unwrap(),
            food: cat(c, "Продукты"),
            cafe: cat(c, "Кафе и рестораны"),
            lunch: cat(c, "Обеды"),
            salary: cat(c, "Зарплата"),
            db,
        }
    }

    fn txn(kind: &str, date: &str, account: &str, amount: i64, category: Option<&str>) -> TxnInput {
        TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: account.into(),
            amount,
            category_id: category.map(Into::into),
            to_account_id: None,
            to_amount: None,
            payee: None,
            note: None,
        }
    }

    fn transfer(from: &str, to: &str, amount: i64, to_amount: Option<i64>) -> TxnInput {
        TxnInput {
            to_account_id: Some(to.into()),
            to_amount,
            ..txn("transfer", "2026-10-20", from, amount, None)
        }
    }

    #[test]
    fn purchase_and_salary_change_balance() {
        // Сценарии «Покупка в магазине» и «Зарплата».
        let f = fx();
        let c = f.db.conn();
        create(
            c,
            &txn("expense", "2026-10-20", &f.card, 234_000, Some(&f.food)),
        )
        .unwrap();
        create(
            c,
            &txn("income", "2026-10-20", &f.card, 8_500_000, Some(&f.salary)),
        )
        .unwrap();
        assert_eq!(
            accounts::balance(c, &f.card, None).unwrap(),
            10_000_000 - 234_000 + 8_500_000
        );
    }

    #[test]
    fn transfer_same_currency() {
        // Сценарий «Снятие наличных».
        let f = fx();
        let c = f.db.conn();
        create(c, &transfer(&f.card, &f.cash, 500_000, None)).unwrap();
        assert_eq!(accounts::balance(c, &f.card, None).unwrap(), 9_500_000);
        assert_eq!(accounts::balance(c, &f.cash, None).unwrap(), 500_000);
        assert!(create(c, &transfer(&f.card, &f.cash, 500_000, Some(400_000))).is_err());
        assert!(create(c, &transfer(&f.card, &f.card, 500_000, None)).is_err());
    }

    #[test]
    fn currency_exchange_transfer() {
        // Сценарий «Обмен валюты»: 92 000 ₽ → 1 000 $, курс 92,00.
        let f = fx();
        let c = f.db.conn();
        assert!(
            create(c, &transfer(&f.card, &f.usd, 9_200_000, None)).is_err(),
            "нужна сумма зачисления"
        );
        let id = create(c, &transfer(&f.card, &f.usd, 9_200_000, Some(100_000))).unwrap();
        assert_eq!(accounts::balance(c, &f.usd, None).unwrap(), 100_000);
        let t = get(c, &id).unwrap();
        let rate = money::Rate::from_amounts(t.to_amount.unwrap(), 2, t.amount, 2).unwrap();
        assert_eq!(rate.to_string(), "92");
    }

    #[test]
    fn category_must_match_type() {
        let f = fx();
        let c = f.db.conn();
        assert!(create(c, &txn("expense", "2026-10-20", &f.card, 100, None)).is_err());
        assert!(create(
            c,
            &txn("expense", "2026-10-20", &f.card, 100, Some(&f.salary))
        )
        .is_err());
        assert!(create(c, &txn("income", "2026-10-20", &f.card, 100, Some(&f.food))).is_err());
        assert!(create(c, &txn("expense", "2026-10-20", &f.card, 0, Some(&f.food))).is_err());
        assert!(create(
            c,
            &txn("expense", "2026-02-30", &f.card, 100, Some(&f.food))
        )
        .is_err());
        assert!(create(c, &txn("adjustment", "2026-10-20", &f.card, 100, None)).is_err());
    }

    #[test]
    fn archived_account_rejects_new_operations() {
        let f = fx();
        let c = f.db.conn();
        let id = create(
            c,
            &txn("expense", "2026-10-20", &f.cash, 100, Some(&f.food)),
        )
        .unwrap();
        accounts::set_archived(c, &f.cash, true).unwrap();
        assert!(create(
            c,
            &txn("expense", "2026-10-21", &f.cash, 100, Some(&f.food))
        )
        .is_err());
        update(
            c,
            &id,
            &txn("expense", "2026-10-20", &f.cash, 200, Some(&f.food)),
        )
        .unwrap();
    }

    #[test]
    fn filters_and_search() {
        // Сценарий «Найти трату»: кафе за сентябрь, включая подкатегории.
        let f = fx();
        let c = f.db.conn();
        let mut sep_lunch = txn("expense", "2026-09-10", &f.card, 45_000, Some(&f.lunch));
        sep_lunch.payee = Some("Столовая №1".into());
        create(c, &sep_lunch).unwrap();
        create(
            c,
            &txn("expense", "2026-09-12", &f.card, 120_000, Some(&f.cafe)),
        )
        .unwrap();
        create(
            c,
            &txn("expense", "2026-10-01", &f.card, 99_000, Some(&f.cafe)),
        )
        .unwrap();
        let mut groceries = txn("expense", "2026-09-15", &f.cash, 234_050, Some(&f.food));
        groceries.note = Some("Продукты на неделю, ПЯТЁРОЧКА".into());
        create(c, &groceries).unwrap();
        create(c, &transfer(&f.card, &f.cash, 500_000, None)).unwrap();

        let sep = |extra: Filter| Filter {
            date_from: Some("2026-09-01".into()),
            date_to: Some("2026-09-30".into()),
            ..extra
        };
        let page = list(
            c,
            &sep(Filter {
                category_id: Some(f.cafe.clone()),
                ..Default::default()
            }),
        )
        .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items.iter().map(|t| t.amount).sum::<i64>(), 165_000);
        assert_eq!(page.items[0].date, "2026-09-12", "новые сверху");
        assert!(page
            .items
            .iter()
            .any(|t| t.category_name.as_deref() == Some("Кафе и рестораны → Обеды")));

        let by_text = |q: &str| {
            list(
                c,
                &Filter {
                    search: Some(q.into()),
                    ..Default::default()
                },
            )
            .unwrap()
            .total
        };
        assert_eq!(by_text("столовая"), 1, "без учёта регистра по-русски");
        assert_eq!(by_text("пятёрочка"), 1);
        assert_eq!(by_text("2 340,50"), 1, "поиск по сумме");
        assert_eq!(by_text("450"), 1);

        let cash_ops = list(
            c,
            &Filter {
                account_id: Some(f.cash.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cash_ops.total, 2, "перевод виден и на счёте зачисления");
        let transfers = list(
            c,
            &Filter {
                types: vec!["transfer".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(transfers.total, 1);
        let paged = list(
            c,
            &Filter {
                limit: Some(2),
                offset: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((paged.items.len(), paged.total), (2, 5));
    }

    #[test]
    fn payee_hints_and_defaults() {
        // Сценарий «Знакомый магазин»: «Пят…» → «Пятёрочка», категория и счёт из последней операции.
        let f = fx();
        let c = f.db.conn();
        let mut a = txn("expense", "2026-10-01", &f.cash, 50_000, Some(&f.cafe));
        a.payee = Some("Пятёрочка".into());
        create(c, &a).unwrap();
        let mut b = txn("expense", "2026-10-15", &f.card, 70_000, Some(&f.food));
        b.payee = Some("Пятёрочка".into());
        create(c, &b).unwrap();
        let mut other = txn("expense", "2026-10-16", &f.card, 1_000, Some(&f.food));
        other.payee = Some("Магнит".into());
        create(c, &other).unwrap();

        let hints = payee_hints(c, "expense", "пят", 5).unwrap();
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].payee, "Пятёрочка");
        assert_eq!(hints[0].category_id.as_deref(), Some(f.food.as_str()));
        assert_eq!(hints[0].account_id, f.card);
        assert!(payee_hints(c, "income", "пят", 5).unwrap().is_empty());

        let d = defaults(c, "expense").unwrap();
        assert_eq!(d.account_id.as_deref(), Some(f.card.as_str()));
        assert_eq!(defaults(c, "income").unwrap().account_id, None);
    }

    #[test]
    fn defaults_take_the_last_entered_within_one_millisecond() {
        // Две операции в одну миллисекунду (платёж по долгу пишет перевод и расход сразу):
        // по умолчанию предлагается счёт последней записанной, а не случайной из двух.
        let f = fx();
        let c = f.db.conn();
        create(
            c,
            &txn("expense", "2026-10-01", &f.cash, 100, Some(&f.food)),
        )
        .unwrap();
        create(
            c,
            &txn("expense", "2026-10-01", &f.card, 100, Some(&f.food)),
        )
        .unwrap();
        c.execute(
            "UPDATE transactions SET created_at = '2026-10-01T12:00:00.000Z'",
            [],
        )
        .unwrap();
        let d = defaults(c, "expense").unwrap();
        assert_eq!(d.account_id.as_deref(), Some(f.card.as_str()));
    }

    #[test]
    fn update_and_delete() {
        let f = fx();
        let c = f.db.conn();
        let id = create(
            c,
            &txn("expense", "2026-10-20", &f.card, 100_000, Some(&f.food)),
        )
        .unwrap();
        let mut changed = transfer(&f.card, &f.cash, 100_000, None);
        changed.note = Some("  ".into());
        update(c, &id, &changed).unwrap();
        let t = get(c, &id).unwrap();
        assert_eq!(
            (t.kind.as_str(), t.category_id.as_deref(), t.note.as_deref()),
            ("transfer", None, None)
        );
        delete(c, &id).unwrap();
        assert!(matches!(get(c, &id), Err(Error::NotFound(_))));
        assert_eq!(accounts::balance(c, &f.card, None).unwrap(), 10_000_000);
    }
}
