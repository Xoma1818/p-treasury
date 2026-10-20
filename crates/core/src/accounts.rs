//! Счета: наличные, карты, кредитки, вклады. Баланс не хранится, а считается
//! из начального остатка и операций.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{currencies, ids, time, Error, Result};

/// Типы счетов, которые пользователь заводит сам (`debt` создаёт модуль долгов).
pub const USER_TYPES: &[&str] = &["cash", "debit", "credit", "savings"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub currency_code: String,
    pub currency_symbol: String,
    pub minor_units: u32,
    pub opening_balance: i64,
    pub opening_date: String,
    pub credit_limit: Option<i64>,
    pub include_in_total: bool,
    pub sort_order: i64,
    pub archived: bool,
    /// Текущий баланс в валюте счёта.
    pub balance: i64,
    /// Для кредитной карты: лимит + баланс.
    pub available: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub currency_code: String,
    pub opening_balance: i64,
    pub opening_date: String,
    pub credit_limit: Option<i64>,
    pub include_in_total: bool,
}

/// Баланс счёта на дату включительно (`None` — на все даты). Учитываются
/// только проведённые операции.
pub fn balance(conn: &Connection, account_id: &str, on: Option<&str>) -> Result<i64> {
    let on = on.unwrap_or("9999-12-31");
    conn.query_row(
        "SELECT a.opening_balance
            + COALESCE((SELECT sum(CASE t.type WHEN 'income' THEN t.amount
                                              WHEN 'adjustment' THEN t.amount
                                              ELSE -t.amount END)
                        FROM transactions t
                        WHERE t.account_id = a.id AND t.status = 'cleared' AND t.date <= ?2), 0)
            + COALESCE((SELECT sum(t.to_amount) FROM transactions t
                        WHERE t.to_account_id = a.id AND t.type = 'transfer'
                          AND t.status = 'cleared' AND t.date <= ?2), 0)
         FROM accounts a WHERE a.id = ?1",
        params![account_id, on],
        |r| r.get(0),
    )
    .optional()?
    .ok_or(Error::NotFound("счёт"))
}

const SELECT: &str =
    "SELECT a.id, a.name, a.type, a.currency_code, c.symbol, c.minor_units, a.opening_balance,
        a.opening_date, a.credit_limit, a.include_in_total, a.sort_order, a.archived_at IS NOT NULL
 FROM accounts a JOIN currencies c ON c.code = a.currency_code";

fn map(conn: &Connection, r: &rusqlite::Row) -> rusqlite::Result<Account> {
    let id: String = r.get(0)?;
    let kind: String = r.get(2)?;
    let credit_limit: Option<i64> = r.get(8)?;
    let bal = balance(conn, &id, None).map_err(|e| match e {
        Error::Db(e) => e,
        other => rusqlite::Error::ToSqlConversionFailure(Box::new(other)),
    })?;
    Ok(Account {
        available: (kind == "credit").then(|| credit_limit.unwrap_or(0) + bal),
        id,
        name: r.get(1)?,
        kind,
        currency_code: r.get(3)?,
        currency_symbol: r.get(4)?,
        minor_units: r.get(5)?,
        opening_balance: r.get(6)?,
        opening_date: r.get(7)?,
        credit_limit,
        include_in_total: r.get(9)?,
        sort_order: r.get(10)?,
        archived: r.get(11)?,
        balance: bal,
    })
}

/// Счета пользователя (без служебных счетов долгов) в порядке сортировки.
pub fn list(conn: &Connection, include_archived: bool) -> Result<Vec<Account>> {
    let sql = format!(
        "{SELECT} WHERE a.type <> 'debt' AND (?1 OR a.archived_at IS NULL)
         ORDER BY a.archived_at IS NOT NULL, a.sort_order, a.name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([include_archived], |r| map(conn, r))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get(conn: &Connection, id: &str) -> Result<Account> {
    let sql = format!("{SELECT} WHERE a.id = ?1");
    conn.query_row(&sql, [id], |r| map(conn, r))
        .optional()?
        .ok_or(Error::NotFound("счёт"))
}

fn validate(conn: &Connection, input: &AccountInput) -> Result<String> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("укажите название счёта");
    }
    if !USER_TYPES.contains(&input.kind.as_str()) {
        return invalid("тип счёта: наличные, карта, кредитная карта или вклад");
    }
    currencies::get(conn, &input.currency_code)?;
    time::check_date(&input.opening_date)?;
    match (input.kind.as_str(), input.credit_limit) {
        ("credit", Some(limit)) if limit < 0 => {
            return invalid("кредитный лимит не может быть отрицательным")
        }
        ("credit", _) => {}
        (_, Some(_)) => return invalid("кредитный лимит бывает только у кредитной карты"),
        _ => {}
    }
    if input.kind != "credit" && input.opening_balance < 0 {
        return invalid("отрицательный остаток бывает только у кредитной карты");
    }
    Ok(name.to_string())
}

pub fn create(conn: &Connection, input: &AccountInput) -> Result<String> {
    let name = validate(conn, input)?;
    let id = ids::new_id();
    let now = time::now_utc();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(max(sort_order) + 1, 0) FROM accounts",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, credit_limit,
                               include_in_total, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            name,
            input.kind,
            input.currency_code,
            input.opening_balance,
            input.opening_date,
            input.credit_limit,
            input.include_in_total,
            order,
            now
        ],
    )?;
    Ok(id)
}

/// Изменить счёт. Валюту нельзя менять, если по счёту уже есть операции:
/// суммы операций записаны в валюте счёта.
pub fn update(conn: &Connection, id: &str, input: &AccountInput) -> Result<()> {
    let name = validate(conn, input)?;
    let current = get(conn, id)?;
    if current.kind == "debt" {
        return invalid("служебный счёт долга меняется в разделе «Долги»");
    }
    if current.currency_code != input.currency_code {
        let used: i64 = conn.query_row(
            "SELECT count(*) FROM transactions WHERE account_id = ?1 OR to_account_id = ?1",
            [id],
            |r| r.get(0),
        )?;
        if used > 0 {
            return invalid("по счёту уже есть операции, поэтому валюту изменить нельзя");
        }
    }
    conn.execute(
        "UPDATE accounts SET name = ?2, type = ?3, currency_code = ?4, opening_balance = ?5, opening_date = ?6,
                credit_limit = ?7, include_in_total = ?8, updated_at = ?9
         WHERE id = ?1",
        params![
            id,
            name,
            input.kind,
            input.currency_code,
            input.opening_balance,
            input.opening_date,
            input.credit_limit,
            input.include_in_total,
            time::now_utc()
        ],
    )?;
    Ok(())
}

/// Закрыть (архивировать) или вернуть счёт. История операций остаётся.
pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> Result<()> {
    get(conn, id)?;
    conn.execute(
        "UPDATE accounts SET archived_at = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, archived.then(time::now_utc), time::now_utc()],
    )?;
    Ok(())
}

/// Поменять порядок счетов: `ids` в нужном порядке.
pub fn reorder(conn: &mut Connection, ids: &[String]) -> Result<()> {
    let tx = conn.transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE accounts SET sort_order = ?2 WHERE id = ?1",
            params![id, i as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Корректировка баланса при сверке: записывает разницу между реальным
/// остатком и учётом отдельной операцией. Возвращает id операции или `None`,
/// если расхождения нет.
pub fn adjust_balance(
    conn: &Connection,
    account_id: &str,
    actual_balance: i64,
    date: &str,
    note: Option<&str>,
) -> Result<Option<String>> {
    time::check_date(date)?;
    let account = get(conn, account_id)?;
    if account.archived {
        return invalid("счёт закрыт");
    }
    let diff = actual_balance - balance(conn, account_id, Some(date))?;
    if diff == 0 {
        return Ok(None);
    }
    let id = ids::new_id();
    let now = time::now_utc();
    conn.execute(
        "INSERT INTO transactions (id, type, date, account_id, amount, note, created_at, updated_at)
         VALUES (?1, 'adjustment', ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, date, account_id, diff, note.unwrap_or("Корректировка баланса"), now],
    )?;
    Ok(Some(id))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub base_currency: String,
    pub base_symbol: String,
    /// Сумма счетов с «учитывать в общем балансе» в основной валюте.
    pub total: i64,
    /// Валюты, для которых нет курса: такие счета в общий баланс не вошли.
    pub missing_rates: Vec<String>,
}

/// Общий баланс по всем открытым счетам в основной валюте по последнему
/// известному курсу на дату.
pub fn totals(conn: &Connection, on: &str) -> Result<Totals> {
    let base = currencies::base_currency(conn)?;
    let base_symbol = currencies::get(conn, &base)?.symbol;
    let mut total = 0i64;
    let mut missing_rates = Vec::new();
    for a in list(conn, false)?
        .into_iter()
        .filter(|a| a.include_in_total)
    {
        let bal = balance(conn, &a.id, Some(on))?;
        match currencies::convert(conn, bal, &a.currency_code, &base, on)? {
            Some(v) => total += v,
            None if !missing_rates.contains(&a.currency_code) => {
                missing_rates.push(a.currency_code)
            }
            None => {}
        }
    }
    Ok(Totals {
        base_currency: base,
        base_symbol,
        total,
        missing_rates,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::storage::Storage;

    pub fn input(name: &str, kind: &str, currency: &str, opening: i64) -> AccountInput {
        AccountInput {
            name: name.into(),
            kind: kind.into(),
            currency_code: currency.into(),
            opening_balance: opening,
            opening_date: "2026-10-01".into(),
            credit_limit: None,
            include_in_total: true,
        }
    }

    #[test]
    fn create_list_archive() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let cash = create(c, &input("Наличные", "cash", "RUB", 500_000)).unwrap();
        create(c, &input("Карта Сбер", "debit", "RUB", 4_250_000)).unwrap();
        let all = list(c, false).unwrap();
        assert_eq!(
            all.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["Наличные", "Карта Сбер"]
        );
        assert_eq!(all[0].balance, 500_000);
        set_archived(c, &cash, true).unwrap();
        assert_eq!(list(c, false).unwrap().len(), 1);
        assert!(list(c, true)
            .unwrap()
            .iter()
            .any(|a| a.id == cash && a.archived));
    }

    #[test]
    fn validation() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        assert!(create(c, &input(" ", "cash", "RUB", 0)).is_err());
        assert!(create(c, &input("X", "debt", "RUB", 0)).is_err());
        assert!(create(c, &input("X", "cash", "XXX", 0)).is_err());
        assert!(create(c, &input("X", "cash", "RUB", -1)).is_err());
        let mut card = input("Кредитка", "cash", "RUB", 0);
        card.credit_limit = Some(10_000_000);
        assert!(create(c, &card).is_err(), "лимит только у кредитки");
    }

    #[test]
    fn credit_card_available() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let mut card = input("Кредитка Т-Банк", "credit", "RUB", -1_500_000);
        card.credit_limit = Some(10_000_000);
        let id = create(c, &card).unwrap();
        let a = get(c, &id).unwrap();
        assert_eq!(a.balance, -1_500_000);
        assert_eq!(a.available, Some(8_500_000));
    }

    #[test]
    fn reconciliation_scenario() {
        // Сценарий «Сверка»: в приложении на 350 ₽ больше, чем в банке.
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let card = create(c, &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let id = adjust_balance(c, &card, 965_000, "2026-10-31", None).unwrap();
        assert!(id.is_some());
        assert_eq!(balance(c, &card, None).unwrap(), 965_000);
        let amount: i64 = c
            .query_row(
                "SELECT amount FROM transactions WHERE type = 'adjustment'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(amount, -35_000);
        assert_eq!(
            adjust_balance(c, &card, 965_000, "2026-10-31", None).unwrap(),
            None,
            "расхождения больше нет"
        );
    }

    #[test]
    fn totals_in_base_currency() {
        // Сценарий «Валютный вклад»: 2 000 $ в общем балансе по курсу.
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        create(c, &input("Карта", "debit", "RUB", 5_000_000)).unwrap();
        create(c, &input("Вклад USD", "savings", "USD", 200_000)).unwrap();
        let mut hidden = input("Копилка", "cash", "RUB", 100_000);
        hidden.include_in_total = false;
        create(c, &hidden).unwrap();

        let t = totals(c, "2026-10-20").unwrap();
        assert_eq!(t.total, 5_000_000);
        assert_eq!(t.missing_rates, ["USD"]);

        currencies::set_rate(c, "2026-10-20", "USD", "RUB", "92").unwrap();
        let t = totals(c, "2026-10-20").unwrap();
        assert_eq!(t.total, 5_000_000 + 18_400_000);
        assert!(t.missing_rates.is_empty());
        assert_eq!(t.base_symbol, "₽");
    }

    #[test]
    fn currency_locked_after_transactions() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let id = create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        update(c, &id, &input("Карта USD", "debit", "USD", 0)).unwrap();
        adjust_balance(c, &id, 100, "2026-10-20", None).unwrap();
        assert!(update(c, &id, &input("Карта", "debit", "RUB", 0)).is_err());
    }
}
