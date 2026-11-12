//! Р10: группы бюджета — «Обязательное», «Желаемое», «Накопления» или свои,
//! с целевой долей дохода. Готовый шаблон 50/30/20 заводит три группы.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::invalid;
use crate::{categories, ids, time, Error, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetGroup {
    pub id: String,
    pub name: String,
    /// Целевая доля дохода в сотых процента (5000 = 50 %).
    pub share_bp: Option<i64>,
    pub sort_order: i64,
    /// Категории верхнего уровня в группе.
    pub category_ids: Vec<String>,
}

/// Шаблон 50/30/20: обязательное, желаемое, накопления.
pub const TEMPLATE: &[(&str, i64)] = &[
    ("Обязательное", 5000),
    ("Желаемое", 3000),
    ("Накопления", 2000),
];

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

fn check_share(share: Option<i64>) -> Result<()> {
    if share.is_some_and(|s| !(0..=10_000).contains(&s)) {
        return invalid("доля дохода — от 0 до 100 %");
    }
    Ok(())
}

fn exists(conn: &Connection, id: &str) -> Result<()> {
    conn.query_row(
        "SELECT 1 FROM budget_groups WHERE id = ?1",
        [id],
        |_| Ok(()),
    )
    .optional()?
    .ok_or(Error::NotFound("группа бюджета"))
}

/// Категория → группа (только явно заданные).
pub fn membership(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, budget_group_id FROM categories WHERE budget_group_id IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn list(conn: &Connection) -> Result<Vec<BudgetGroup>> {
    let member = membership(conn)?;
    let mut stmt = conn.prepare_cached(
        "SELECT id, name, share_bp, sort_order FROM budget_groups ORDER BY sort_order, name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(BudgetGroup {
            id: r.get(0)?,
            name: r.get(1)?,
            share_bp: r.get(2)?,
            sort_order: r.get(3)?,
            category_ids: Vec::new(),
        })
    })?;
    let mut out: Vec<BudgetGroup> = rows.collect::<rusqlite::Result<_>>()?;
    for g in &mut out {
        g.category_ids = member
            .iter()
            .filter(|(_, gid)| **gid == g.id)
            .map(|(c, _)| c.clone())
            .collect();
        g.category_ids.sort();
    }
    Ok(out)
}

pub fn create(conn: &Connection, name: &str, share_bp: Option<i64>) -> Result<String> {
    let name = clean_name(name)?;
    check_share(share_bp)?;
    let id = ids::new_id();
    let now = time::now_utc();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(max(sort_order) + 1, 0) FROM budget_groups",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO budget_groups (id, name, share_bp, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, name, share_bp, order, now],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, name: &str, share_bp: Option<i64>) -> Result<()> {
    exists(conn, id)?;
    let name = clean_name(name)?;
    check_share(share_bp)?;
    conn.execute(
        "UPDATE budget_groups SET name = ?2, share_bp = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, share_bp, time::now_utc()],
    )?;
    Ok(())
}

/// Удалить группу: категории остаются, только без группы.
pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    exists(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE categories SET budget_group_id = NULL WHERE budget_group_id = ?1",
        [id],
    )?;
    tx.execute("DELETE FROM budget_groups WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

/// Категория в группу (`None` — без группы). Подкатегории идут за родителем.
pub fn set_category(conn: &Connection, category_id: &str, group_id: Option<&str>) -> Result<()> {
    categories::kind_of(conn, category_id)?;
    if let Some(g) = group_id {
        exists(conn, g)?;
    }
    conn.execute(
        "UPDATE categories SET budget_group_id = ?2 WHERE id = ?1",
        params![category_id, group_id],
    )?;
    Ok(())
}

/// Шаблон 50/30/20 — только если групп ещё нет. Возвращает id групп.
pub fn apply_template(conn: &Connection) -> Result<Vec<String>> {
    let n: i64 = conn.query_row("SELECT count(*) FROM budget_groups", [], |r| r.get(0))?;
    if n > 0 {
        return invalid("группы уже есть: шаблон заводится только с нуля");
    }
    let tx = conn.unchecked_transaction()?;
    let ids = TEMPLATE
        .iter()
        .map(|(name, share)| create(&tx, name, Some(*share)))
        .collect::<Result<Vec<_>>>()?;
    tx.commit()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::budgets;
    use crate::categories;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn cat(c: &Connection, name: &str) -> String {
        c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn txn(c: &Connection, account: &str, kind: &str, date: &str, amount: i64, category: &str) {
        transactions::create(
            c,
            &TxnInput {
                kind: kind.into(),
                date: date.into(),
                account_id: account.into(),
                amount,
                category_id: Some(cat(c, category)),
                to_account_id: None,
                to_amount: None,
                payee: None,
                note: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn template_groups_targets_and_kinds() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let budget = budgets::create(db.conn_mut(), "2026-11", false).unwrap();
        let c = db.conn();
        let ids = apply_template(c).unwrap();
        assert_eq!(ids.len(), 3);
        assert!(apply_template(c).is_err(), "второй раз не заводится");
        set_category(c, &cat(c, "Жильё"), Some(&ids[0])).unwrap();
        set_category(c, &cat(c, "Общепит"), Some(&ids[1])).unwrap();

        txn(
            c,
            &card,
            "income",
            "2026-11-02",
            10_000_000,
            "Заработная плата",
        );
        txn(c, &card, "expense", "2026-11-03", 4_000_000, "Жильё");
        txn(c, &card, "expense", "2026-11-04", 1_000_000, "Обеды"); // подкатегория «Общепита»

        // Р9: «Общепит» — 10 % дохода, «Жильё» — 10 000 в неделю (30 дней ноября).
        budgets::set_limit_kind(c, &budget, &cat(c, "Общепит"), "percent", 1000).unwrap();
        budgets::set_limit_kind(c, &budget, &cat(c, "Жильё"), "week", 1_000_000).unwrap();
        assert!(
            budgets::set_limit_kind(c, &budget, &cat(c, "Заработная плата"), "percent", 1000)
                .is_err()
        );
        let b = budgets::get(c, "2026-11", "2026-11-10").unwrap();
        let line = |n: &str| b.lines.iter().find(|l| l.category_name == n).unwrap();
        assert_eq!(b.income_basis, 10_000_000);
        assert_eq!(line("Общепит").limit, 1_000_000);
        assert_eq!(line("Жильё").limit, 1_000_000 * 30 / 7);
        assert_eq!(line("Жильё").limit_kind, "week");

        let g = |n: &str| b.groups.iter().find(|g| g.name == n).unwrap();
        assert_eq!(
            (g("Обязательное").actual, g("Обязательное").target),
            (4_000_000, Some(5_000_000))
        );
        assert_eq!(g("Желаемое").actual, 1_000_000);
        assert!(g("Накопления").savings);
        assert_eq!(g("Накопления").actual, 5_000_000, "осталось от дохода");

        delete(c, &ids[0]).unwrap();
        assert!(!membership(c).unwrap().contains_key(&cat(c, "Жильё")));
    }

    #[test]
    fn copy_forward_and_year() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 0)).unwrap();
        let src = budgets::create(db.conn_mut(), "2026-01", false).unwrap();
        let food = cat(db.conn(), "Питание");
        budgets::set_limit(db.conn(), &src, &food, Some(2_000_000)).unwrap();
        budgets::create(db.conn_mut(), "2026-03", false).unwrap();
        let r = budgets::copy_forward(db.conn_mut(), "2026-01", 3, false).unwrap();
        assert_eq!(r.created, ["2026-02", "2026-04"]);
        assert_eq!(r.skipped, ["2026-03"]);
        let r = budgets::copy_forward(db.conn_mut(), "2026-01", 3, true).unwrap();
        assert_eq!(r.replaced, ["2026-02", "2026-03", "2026-04"]);
        assert!(budgets::copy_forward(db.conn_mut(), "2025-12", 1, false).is_err());

        txn(
            db.conn(),
            &card,
            "expense",
            "2026-05-10",
            300_000,
            "Питание",
        );
        let y = budgets::year(db.conn(), 2026, "2026-06-01").unwrap();
        assert_eq!(y.months.len(), 12);
        let row = y
            .rows
            .iter()
            .find(|r| r.category_name == "Питание")
            .unwrap();
        assert_eq!(
            &row.limits[..5],
            &[
                Some(2_000_000),
                Some(2_000_000),
                Some(2_000_000),
                Some(2_000_000),
                None
            ]
        );
        assert_eq!(row.actuals[4], 300_000, "факт и без лимита");
        assert_eq!(y.has_budget[..5], [true, true, true, true, false]);
    }

    /// Ревью #88: объединение складывает лимиты по сумме на месяц и не теряет перенос;
    /// процентный остаток переносится по той же базе дохода, что и в месяце.
    #[test]
    fn merge_kinds_and_percent_carry() {
        let mut db = Storage::open_in_memory().unwrap();
        categories::seed_defaults(db.conn()).unwrap();
        let nov = budgets::create(db.conn_mut(), "2026-11", false).unwrap();
        let c = db.conn();
        budgets::set_limit(c, &nov, &cat(c, "Заработная плата"), Some(5_000_000)).unwrap();
        budgets::set_limit_kind(c, &nov, &cat(c, "Общепит"), "percent", 1000).unwrap();
        budgets::set_limit(c, &nov, &cat(c, "Подарки"), Some(200_000)).unwrap();
        budgets::set_rollover(c, &nov, &cat(c, "Подарки"), true).unwrap();
        let cafe = cat(c, "Общепит");
        let gifts = cat(c, "Подарки");
        categories::merge(db.conn_mut(), &gifts, &cafe).unwrap();
        let c = db.conn();
        let b = budgets::get(c, "2026-11", "2026-11-10").unwrap();
        let l = b.lines.iter().find(|l| l.category_id == cafe).unwrap();
        assert_eq!(
            (l.limit, l.limit_kind.as_str(), l.rollover),
            (700_000, "month", true)
        );

        // 10 % от плана 100 000 при факте 0: в месяце 10 000, и столько же переходит дальше.
        budgets::set_limit(c, &nov, &cat(c, "Заработная плата"), Some(10_000_000)).unwrap();
        budgets::set_limit_kind(c, &nov, &cafe, "percent", 1000).unwrap();
        budgets::set_rollover(c, &nov, &cafe, true).unwrap();
        assert_eq!(
            budgets::get(c, "2026-11", "2026-11-10")
                .unwrap()
                .lines
                .iter()
                .find(|l| l.category_id == cafe)
                .unwrap()
                .remaining,
            1_000_000
        );
        let mut db2 = db;
        budgets::create(db2.conn_mut(), "2026-12", true).unwrap();
        let c = db2.conn();
        let dec = budgets::get(c, "2026-12", "2026-12-10").unwrap();
        let l = dec.lines.iter().find(|l| l.category_id == cafe).unwrap();
        assert_eq!(l.carried, 1_000_000);
    }
}
