//! Р19: свои группы счетов («Семья», «Отложено», «Наличные») с итогом по группе.
//! У счёта не больше одной группы; без группы счёт показывается отдельно.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::invalid;
use crate::{accounts, currencies, ids, time, Error, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountGroup {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    /// Открытых счетов в группе.
    pub count: usize,
    /// Итог по открытым счетам группы в основной валюте (брокерские — по стоимости).
    pub total: i64,
    /// Валюты счетов группы без курса: такие счета в итог не вошли.
    pub missing_rates: Vec<String>,
}

fn clean_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        return invalid("введите название группы");
    }
    if name.chars().count() > 40 {
        return invalid("название группы — не длиннее 40 знаков");
    }
    Ok(name)
}

pub fn get(conn: &Connection, id: &str) -> Result<(String, String)> {
    conn.query_row(
        "SELECT id, name FROM account_groups WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or(Error::NotFound("группа счетов"))
}

fn taken(conn: &Connection, name: &str, except: Option<&str>) -> Result<bool> {
    let want = name.to_lowercase();
    let mut stmt = conn.prepare("SELECT id, name FROM account_groups")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, n) = row?;
        if Some(id.as_str()) != except && n.to_lowercase() == want {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Группы по порядку с итогами на дату `today`.
pub fn list(conn: &Connection, today: &str) -> Result<Vec<AccountGroup>> {
    let base = currencies::base_currency(conn)?;
    let accounts = accounts::list(conn, false)?;
    let mut stmt =
        conn.prepare("SELECT id, name, sort_order FROM account_groups ORDER BY sort_order, name")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, sort_order) = row?;
        let mut total = 0;
        let mut count = 0;
        let mut missing_rates = Vec::new();
        for a in accounts
            .iter()
            .filter(|a| a.group_id.as_deref() == Some(&id))
        {
            count += 1;
            let amount = a.value.unwrap_or(a.balance);
            match currencies::convert(conn, amount, &a.currency_code, &base, today)? {
                Some(v) => total += v,
                None if !missing_rates.contains(&a.currency_code) => {
                    missing_rates.push(a.currency_code.clone())
                }
                None => {}
            }
        }
        out.push(AccountGroup {
            id,
            name,
            sort_order,
            count,
            total,
            missing_rates,
        });
    }
    Ok(out)
}

pub fn create(conn: &Connection, name: &str) -> Result<String> {
    let name = clean_name(name)?;
    if taken(conn, name, None)? {
        return invalid("такая группа уже есть");
    }
    let id = ids::new_id();
    let now = time::now_utc();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(max(sort_order) + 1, 0) FROM account_groups",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO account_groups (id, name, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, name, order, now],
    )?;
    Ok(id)
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
    get(conn, id)?;
    let name = clean_name(name)?;
    if taken(conn, name, Some(id))? {
        return invalid("такая группа уже есть");
    }
    conn.execute(
        "UPDATE account_groups SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, time::now_utc()],
    )?;
    Ok(())
}

/// Удалить группу. Счета остаются, только без группы.
pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    get(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE accounts SET group_id = NULL, updated_at = ?2 WHERE group_id = ?1",
        params![id, time::now_utc()],
    )?;
    tx.execute("DELETE FROM account_groups WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

/// Новый порядок групп.
pub fn reorder(conn: &Connection, ids: &[String]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        get(&tx, id)?;
        tx.execute(
            "UPDATE account_groups SET sort_order = ?2 WHERE id = ?1",
            params![id, i as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;

    #[test]
    fn groups_total_order_and_delete() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 1_000_000)).unwrap();
        let cash = accounts::create(c, &input("Наличные", "cash", "RUB", 50_000)).unwrap();
        let other = accounts::create(c, &input("Вклад", "savings", "RUB", 7_000_000)).unwrap();
        let family = create(c, "Семья").unwrap();
        let saved = create(c, "Отложено").unwrap();
        assert!(create(c, " семья ").is_err(), "имя без учёта регистра");
        assert!(create(c, "  ").is_err());
        accounts::set_group(c, &card, Some(&family)).unwrap();
        accounts::set_group(c, &cash, Some(&family)).unwrap();
        accounts::set_group(c, &other, Some(&saved)).unwrap();
        let g = list(c, "2026-11-13").unwrap();
        assert_eq!(
            g.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            ["Семья", "Отложено"]
        );
        assert_eq!((g[0].count, g[0].total), (2, 1_050_000));
        assert_eq!(g[1].total, 7_000_000);

        reorder(c, &[saved.clone(), family.clone()]).unwrap();
        assert_eq!(list(c, "2026-11-13").unwrap()[0].name, "Отложено");
        rename(c, &saved, "Подушка").unwrap();
        assert!(rename(c, &saved, "Семья").is_err());

        delete(c, &family).unwrap();
        assert_eq!(accounts::get(c, &card).unwrap().group_id, None);
        assert_eq!(list(c, "2026-11-13").unwrap().len(), 1);
        assert!(accounts::set_group(c, &card, Some("нет такой")).is_err());
    }

    #[test]
    fn look_includes_and_order() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let a = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let b = accounts::create(c, &input("Наличные", "cash", "RUB", 0)).unwrap();
        accounts::set_look(c, &a, Some("wallet"), Some("mint")).unwrap();
        let got = accounts::get(c, &a).unwrap();
        assert_eq!(
            (got.icon.as_deref(), got.color.as_deref()),
            (Some("wallet"), Some("mint"))
        );
        assert!(accounts::set_look(c, &a, None, Some("золотой")).is_err());
        assert!(accounts::set_look(c, &a, Some("<script>"), None).is_err());

        accounts::set_includes(c, &a, false, false, false).unwrap();
        let got = accounts::get(c, &a).unwrap();
        assert!(!got.include_in_total && !got.in_budget);
        assert!(crate::forecast::excluded_accounts(c).unwrap().contains(&a));
        accounts::set_includes(c, &a, true, true, true).unwrap();
        assert!(!crate::forecast::excluded_accounts(c).unwrap().contains(&a));

        accounts::reorder(c, &[b.clone(), a.clone()]).unwrap();
        let names: Vec<_> = accounts::list(c, false)
            .unwrap()
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert_eq!(names, ["Наличные", "Карта"]);
    }
}
