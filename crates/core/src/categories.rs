//! Категории доходов и расходов: двухуровневое дерево.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::{ids, time, Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub sort_order: i64,
    pub archived: bool,
    /// Сколько операций в категории (без подкатегорий).
    pub transaction_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInput {
    pub name: String,
    pub kind: String,
    pub parent_id: Option<String>,
}

/// Набор категорий по умолчанию (architecture.md: в том числе «Кешбэк и бонусы»
/// и обе категории процентов для долгов).
const DEFAULTS: &[(&str, &str, &[&str])] = &[
    ("expense", "Продукты", &["Супермаркет", "Рынок"]),
    ("expense", "Кафе и рестораны", &["Обеды", "Доставка"]),
    (
        "expense",
        "Транспорт",
        &[
            "Общественный транспорт",
            "Такси",
            "Топливо",
            "Обслуживание авто",
        ],
    ),
    (
        "expense",
        "Жильё",
        &["Аренда", "ЖКХ", "Интернет и связь", "Ремонт"],
    ),
    ("expense", "Здоровье", &["Аптека", "Врачи"]),
    ("expense", "Одежда и обувь", &[]),
    ("expense", "Дети", &["Школа", "Кружки", "Одежда"]),
    (
        "expense",
        "Развлечения",
        &["Кино и театр", "Подписки", "Хобби"],
    ),
    ("expense", "Подарки", &[]),
    ("expense", "Путешествия", &[]),
    ("expense", "Образование", &[]),
    ("expense", "Проценты по кредитам", &[]),
    ("expense", "Прочие расходы", &[]),
    ("income", "Зарплата", &[]),
    ("income", "Подработка", &[]),
    ("income", "Кешбэк и бонусы", &[]),
    ("income", "Проценты по вкладам", &[]),
    ("income", "Проценты по займам", &[]),
    ("income", "Дивиденды и купоны", &[]),
    ("income", "Подарки", &[]),
    ("income", "Прочие доходы", &[]),
];

/// Создать набор по умолчанию, если категорий ещё нет. Возвращает, создан ли он.
pub fn seed_defaults(conn: &Connection) -> Result<bool> {
    let existing: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0))?;
    if existing > 0 {
        return Ok(false);
    }
    let now = time::now_utc();
    let mut insert = conn.prepare(
        "INSERT INTO categories (id, parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
    )?;
    for (i, (kind, name, children)) in DEFAULTS.iter().enumerate() {
        let id = ids::new_id();
        insert.execute(params![id, None::<String>, name, kind, i as i64, now])?;
        for (j, child) in children.iter().enumerate() {
            insert.execute(params![ids::new_id(), id, child, kind, j as i64, now])?;
        }
    }
    Ok(true)
}

/// Все категории: сначала верхний уровень по порядку, подкатегории сразу за родителем.
pub fn list(conn: &Connection, include_archived: bool) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.parent_id, c.name, c.kind, c.sort_order, c.archived_at IS NOT NULL,
                (SELECT count(*) FROM transactions t WHERE t.category_id = c.id)
         FROM categories c
         LEFT JOIN categories p ON p.id = c.parent_id
         WHERE ?1 OR (c.archived_at IS NULL AND (p.id IS NULL OR p.archived_at IS NULL))
         ORDER BY c.kind = 'income', COALESCE(p.sort_order, c.sort_order), COALESCE(p.name, c.name),
                  c.parent_id IS NOT NULL, c.sort_order, c.name",
    )?;
    let rows = stmt.query_map([include_archived], |r| {
        Ok(Category {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            name: r.get(2)?,
            kind: r.get(3)?,
            sort_order: r.get(4)?,
            archived: r.get(5)?,
            transaction_count: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

struct Row {
    parent_id: Option<String>,
    kind: String,
}

fn row(conn: &Connection, id: &str) -> Result<Row> {
    conn.query_row(
        "SELECT parent_id, kind FROM categories WHERE id = ?1",
        [id],
        |r| {
            Ok(Row {
                parent_id: r.get(0)?,
                kind: r.get(1)?,
            })
        },
    )
    .optional()?
    .ok_or(Error::NotFound("категория"))
}

/// Категория операции должна существовать и подходить по типу.
pub fn kind_of(conn: &Connection, id: &str) -> Result<String> {
    Ok(row(conn, id)?.kind)
}

fn check_parent(
    conn: &Connection,
    id: Option<&str>,
    parent_id: Option<&str>,
    kind: &str,
) -> Result<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if Some(parent_id) == id {
        return invalid("категория не может быть подкатегорией самой себя");
    }
    let parent = row(conn, parent_id)?;
    if parent.parent_id.is_some() {
        return invalid("категорий только два уровня: подкатегорию нельзя вложить в подкатегорию");
    }
    if parent.kind != kind {
        return invalid("родительская категория должна быть того же типа (доход или расход)");
    }
    if let Some(id) = id {
        let children: i64 = conn.query_row(
            "SELECT count(*) FROM categories WHERE parent_id = ?1",
            [id],
            |r| r.get(0),
        )?;
        if children > 0 {
            return invalid(
                "у категории есть подкатегории, поэтому её нельзя сделать подкатегорией",
            );
        }
    }
    Ok(())
}

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return invalid("укажите название категории");
    }
    Ok(name.to_string())
}

pub fn create(conn: &Connection, input: &CategoryInput) -> Result<String> {
    let name = clean_name(&input.name)?;
    if !matches!(input.kind.as_str(), "expense" | "income") {
        return invalid("тип категории: расход или доход");
    }
    check_parent(conn, None, input.parent_id.as_deref(), &input.kind)?;
    let id = ids::new_id();
    let now = time::now_utc();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(max(sort_order) + 1, 0) FROM categories WHERE kind = ?1 AND parent_id IS ?2",
        params![input.kind, input.parent_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO categories (id, parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, input.parent_id, name, input.kind, order, now],
    )?;
    Ok(id)
}

/// Переименовать и/или переместить (сменить родителя). Тип не меняется.
pub fn update(conn: &Connection, id: &str, name: &str, parent_id: Option<&str>) -> Result<()> {
    let name = clean_name(name)?;
    let current = row(conn, id)?;
    check_parent(conn, Some(id), parent_id, &current.kind)?;
    conn.execute(
        "UPDATE categories SET name = ?2, parent_id = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, parent_id, time::now_utc()],
    )?;
    Ok(())
}

pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> Result<()> {
    row(conn, id)?;
    let at = archived.then(time::now_utc);
    conn.execute(
        "UPDATE categories SET archived_at = ?2, updated_at = ?3 WHERE id = ?1 OR parent_id = ?1",
        params![id, at, time::now_utc()],
    )?;
    Ok(())
}

/// Удалить категорию вместе с подкатегориями. Если у них есть операции,
/// шаблоны, напоминания или строки бюджета, нужно указать `move_to`: всё
/// это переносится туда (так «Рестораны» объединяются с «Кафе»).
pub fn delete(conn: &mut Connection, id: &str, move_to: Option<&str>) -> Result<()> {
    let current = row(conn, id)?;
    let tx = conn.transaction()?;
    let doomed: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM categories WHERE id = ?1 OR parent_id = ?1")?;
        let rows = stmt.query_map([id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let used: i64 = doomed.iter().try_fold(0i64, |acc, cid| {
        tx.query_row(
            "SELECT (SELECT count(*) FROM transactions WHERE category_id = ?1)
                  + (SELECT count(*) FROM budget_lines WHERE category_id = ?1)
                  + (SELECT count(*) FROM recurring_rules WHERE category_id = ?1)",
            [cid],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| acc + n)
    })?;

    if let Some(target) = move_to {
        if doomed.iter().any(|d| d == target) {
            return invalid("нельзя перенести операции в удаляемую категорию");
        }
        if row(&tx, target)?.kind != current.kind {
            return invalid("операции можно перенести только в категорию того же типа");
        }
        for cid in &doomed {
            tx.execute(
                "UPDATE transactions SET category_id = ?2 WHERE category_id = ?1",
                params![cid, target],
            )?;
            tx.execute(
                "UPDATE recurring_rules SET category_id = ?2 WHERE category_id = ?1",
                params![cid, target],
            )?;
            // Лимит переносится, если у цели его в этом бюджете ещё нет; иначе суммируется.
            tx.execute(
                "UPDATE budget_lines SET limit_amount = limit_amount +
                     (SELECT b.limit_amount FROM budget_lines b WHERE b.budget_id = budget_lines.budget_id AND b.category_id = ?1)
                 WHERE category_id = ?2 AND budget_id IN (SELECT budget_id FROM budget_lines WHERE category_id = ?1)",
                params![cid, target],
            )?;
            tx.execute(
                "DELETE FROM budget_lines WHERE category_id = ?1
                   AND budget_id IN (SELECT budget_id FROM budget_lines WHERE category_id = ?2)",
                params![cid, target],
            )?;
            tx.execute(
                "UPDATE budget_lines SET category_id = ?2 WHERE category_id = ?1",
                params![cid, target],
            )?;
        }
    } else if used > 0 {
        return invalid("в категории есть операции: выберите, куда их перенести");
    }

    // Подкатегории первыми из-за внешнего ключа parent_id.
    tx.execute("DELETE FROM categories WHERE parent_id = ?1", [id])?;
    tx.execute("DELETE FROM categories WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn by_name(conn: &Connection, name: &str, kind: &str) -> String {
        conn.query_row(
            "SELECT id FROM categories WHERE name = ?1 AND kind = ?2",
            [name, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn defaults_seeded_once() {
        let db = Storage::open_in_memory().unwrap();
        assert!(seed_defaults(db.conn()).unwrap());
        assert!(!seed_defaults(db.conn()).unwrap());
        let all = list(db.conn(), false).unwrap();
        for name in ["Кешбэк и бонусы", "Проценты по займам"] {
            assert!(
                all.iter().any(|c| c.name == name && c.kind == "income"),
                "{name}"
            );
        }
        assert!(all
            .iter()
            .any(|c| c.name == "Проценты по кредитам" && c.kind == "expense"));
        // Подкатегория идёт сразу за родителем.
        let i = all.iter().position(|c| c.name == "Продукты").unwrap();
        assert_eq!(all[i + 1].name, "Супермаркет");
        assert_eq!(all[i + 1].parent_id.as_deref(), Some(all[i].id.as_str()));
    }

    #[test]
    fn two_levels_only_and_same_kind() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let kids = create(
            c,
            &CategoryInput {
                name: "Дети".into(),
                kind: "expense".into(),
                parent_id: None,
            },
        )
        .unwrap();
        let school = create(
            c,
            &CategoryInput {
                name: "Школа".into(),
                kind: "expense".into(),
                parent_id: Some(kids.clone()),
            },
        )
        .unwrap();
        assert!(create(
            c,
            &CategoryInput {
                name: "Учебники".into(),
                kind: "expense".into(),
                parent_id: Some(school)
            }
        )
        .is_err());
        assert!(create(
            c,
            &CategoryInput {
                name: "Бонус".into(),
                kind: "income".into(),
                parent_id: Some(kids.clone())
            }
        )
        .is_err());
        assert!(create(
            c,
            &CategoryInput {
                name: "  ".into(),
                kind: "expense".into(),
                parent_id: None
            }
        )
        .is_err());
        let other = create(
            c,
            &CategoryInput {
                name: "Семья".into(),
                kind: "expense".into(),
                parent_id: None,
            },
        )
        .unwrap();
        assert!(
            update(c, &kids, "Дети", Some(&other)).is_err(),
            "у «Дети» есть подкатегории"
        );
    }

    #[test]
    fn delete_with_transactions_requires_target() {
        let mut db = Storage::open_in_memory().unwrap();
        seed_defaults(db.conn()).unwrap();
        let c = db.conn();
        let cafe = by_name(c, "Кафе и рестораны", "expense");
        let lunch = by_name(c, "Обеды", "expense");
        let food = by_name(c, "Продукты", "expense");
        let salary = by_name(c, "Зарплата", "income");
        let now = time::now_utc();
        c.execute(
            "INSERT INTO accounts (id, name, type, currency_code, opening_date, created_at, updated_at)
             VALUES ('a', 'Карта', 'debit', 'RUB', '2026-10-01', ?1, ?1)",
            [&now],
        )
        .unwrap();
        c.execute(
            "INSERT INTO transactions (id, type, date, account_id, amount, category_id, created_at, updated_at)
             VALUES ('t1', 'expense', '2026-10-20', 'a', 50000, ?1, ?2, ?2)",
            params![lunch, now],
        )
        .unwrap();

        assert!(delete(db.conn_mut(), &cafe, None).is_err());
        assert!(
            delete(db.conn_mut(), &cafe, Some(&salary)).is_err(),
            "другой тип"
        );
        assert!(
            delete(db.conn_mut(), &cafe, Some(&lunch)).is_err(),
            "цель удаляется"
        );
        delete(db.conn_mut(), &cafe, Some(&food)).unwrap();

        let c = db.conn();
        let moved: String = c
            .query_row(
                "SELECT category_id FROM transactions WHERE id = 't1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(moved, food);
        let left: i64 = c
            .query_row(
                "SELECT count(*) FROM categories WHERE id IN (?1, ?2)",
                [&cafe, &lunch],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);

        // Пустую категорию можно удалить без переноса.
        let gifts = by_name(c, "Подарки", "expense");
        delete(db.conn_mut(), &gifts, None).unwrap();
    }

    #[test]
    fn archive_hides_with_children() {
        let db = Storage::open_in_memory().unwrap();
        seed_defaults(db.conn()).unwrap();
        let c = db.conn();
        let food = by_name(c, "Продукты", "expense");
        set_archived(c, &food, true).unwrap();
        let visible = list(c, false).unwrap();
        assert!(!visible
            .iter()
            .any(|x| x.name == "Продукты" || x.name == "Супермаркет"));
        assert!(list(c, true)
            .unwrap()
            .iter()
            .any(|x| x.name == "Супермаркет" && x.archived));
    }
}
