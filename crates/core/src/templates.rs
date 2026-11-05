//! Шаблоны операций: «Кофе 250 ₽» создаёт операцию одним нажатием.
//! Неполный шаблон (без суммы, без счёта) только заполняет форму операции.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::invalid;
use crate::transactions::{self, TxnInput};
use crate::{ids, time, Error, Result};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInput {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub amount: Option<i64>,
    pub account_id: Option<String>,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub amount: Option<i64>,
    pub account_id: Option<String>,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub payee: Option<String>,
    pub note: Option<String>,
    pub currency_symbol: Option<String>,
    pub minor_units: u32,
    /// Хватает данных, чтобы создать операцию сразу, без формы.
    pub complete: bool,
    pub use_count: i64,
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn create(conn: &Connection, input: &TemplateInput) -> Result<String> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("назовите шаблон, например «Кофе»");
    }
    if !matches!(input.kind.as_str(), "expense" | "income" | "transfer") {
        return invalid("шаблон бывает для расхода, дохода или перевода");
    }
    if input.amount.is_some_and(|a| a <= 0) {
        return invalid("сумма шаблона должна быть больше нуля");
    }
    let transfer = input.kind == "transfer";
    let id = ids::new_id();
    let now = time::now_utc();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM transaction_templates",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO transaction_templates (id, name, type, amount, account_id, to_account_id, category_id, payee, note,
                                            sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            name,
            input.kind,
            input.amount,
            clean(&input.account_id),
            if transfer { clean(&input.to_account_id) } else { None },
            if transfer { None } else { clean(&input.category_id) },
            clean(&input.payee),
            clean(&input.note),
            order,
            now
        ],
    )?;
    Ok(id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    if conn.execute("DELETE FROM transaction_templates WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound("шаблон"));
    }
    Ok(())
}

/// Шаблоны: сначала самые используемые.
pub fn list(conn: &Connection) -> Result<Vec<Template>> {
    let mut st = conn.prepare(
        "SELECT t.id, t.name, t.type, t.amount, t.account_id, t.to_account_id, t.category_id, t.payee, t.note,
                cur.symbol, COALESCE(cur.minor_units, 2), t.use_count,
                a.currency_code IS NOT NULL AND a.archived_at IS NULL,
                ta.currency_code, a.currency_code, ta.archived_at IS NULL
         FROM transaction_templates t
         LEFT JOIN accounts a ON a.id = t.account_id
         LEFT JOIN accounts ta ON ta.id = t.to_account_id
         LEFT JOIN currencies cur ON cur.code = a.currency_code
         ORDER BY t.use_count DESC, t.sort_order, t.name",
    )?;
    let rows = st.query_map([], |r| {
        let kind: String = r.get(2)?;
        let amount: Option<i64> = r.get(3)?;
        let account_ok: bool = r.get(12)?;
        let to_currency: Option<String> = r.get(13)?;
        let currency: Option<String> = r.get(14)?;
        let to_open: bool = r.get(15)?;
        let category: Option<String> = r.get(6)?;
        let complete = amount.is_some()
            && account_ok
            && match kind.as_str() {
                // Перевод между валютами требует суммы зачисления — только через форму.
                "transfer" => to_currency.is_some() && to_open && to_currency == currency,
                _ => category.is_some(),
            };
        Ok(Template {
            id: r.get(0)?,
            name: r.get(1)?,
            kind,
            amount,
            account_id: r.get(4)?,
            to_account_id: r.get(5)?,
            category_id: category,
            payee: r.get(7)?,
            note: r.get(8)?,
            currency_symbol: r.get(9)?,
            minor_units: r.get(10)?,
            complete,
            use_count: r.get(11)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Создать операцию по шаблону на дату `date`; возвращает id операции.
/// Счётчик использования отмечается отдельно (`used`): он не часть операции,
/// и его изменение не должно мешать отменить операцию.
pub fn apply(conn: &Connection, id: &str, date: &str) -> Result<String> {
    let t = list(conn)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or(Error::NotFound("шаблон"))?;
    if !t.complete {
        return invalid(
            "в шаблоне не хватает суммы, счёта или категории — откройте его в форме операции",
        );
    }
    let txn = transactions::create(
        conn,
        &TxnInput {
            kind: t.kind,
            date: date.to_string(),
            account_id: t.account_id.expect("полный шаблон"),
            amount: t.amount.expect("полный шаблон"),
            category_id: t.category_id,
            to_account_id: t.to_account_id,
            to_amount: None,
            payee: t.payee,
            note: t.note,
        },
    )?;
    Ok(txn)
}

/// Отметить использование (шаблон поднимается выше в списке).
pub fn used(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE transaction_templates SET use_count = use_count + 1 WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{self, tests::input};
    use crate::storage::Storage;

    fn setup() -> (Storage, String, String) {
        let db = Storage::open_in_memory().unwrap();
        crate::categories::seed_defaults(db.conn()).unwrap();
        let card = accounts::create(db.conn(), &input("Карта", "debit", "RUB", 100_000)).unwrap();
        let cafe: String = db
            .conn()
            .query_row(
                "SELECT id FROM categories WHERE name = 'Общепит'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (db, card, cafe)
    }

    fn coffee(card: &str, cafe: &str) -> TemplateInput {
        TemplateInput {
            name: "Кофе".into(),
            kind: "expense".into(),
            amount: Some(25_000),
            account_id: Some(card.into()),
            category_id: Some(cafe.into()),
            payee: Some("Кофейня".into()),
            ..Default::default()
        }
    }

    #[test]
    fn morning_coffee_in_one_click() {
        let (db, card, cafe) = setup();
        let c = db.conn();
        let id = create(c, &coffee(&card, &cafe)).unwrap();
        let t = &list(c).unwrap()[0];
        assert!(t.complete);
        assert_eq!(
            (t.amount, t.currency_symbol.as_deref()),
            (Some(25_000), Some("₽"))
        );
        let txn = apply(c, &id, "2026-10-20").unwrap();
        used(c, &id).unwrap();
        let got = transactions::get(c, &txn).unwrap();
        assert_eq!(
            (got.amount, got.payee.as_deref(), got.date.as_str()),
            (25_000, Some("Кофейня"), "2026-10-20")
        );
        assert_eq!(got.category_id.as_deref(), Some(cafe.as_str()));
        assert_eq!(accounts::balance(c, &card, None).unwrap(), 75_000);
        assert_eq!(list(c).unwrap()[0].use_count, 1);
    }

    #[test]
    fn incomplete_template_only_fills_the_form() {
        let (db, card, _) = setup();
        let c = db.conn();
        let id = create(
            c,
            &TemplateInput {
                name: "Такси".into(),
                kind: "expense".into(),
                account_id: Some(card),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!list(c).unwrap()[0].complete);
        assert!(apply(c, &id, "2026-10-20").is_err());
    }

    #[test]
    fn most_used_first_and_validation() {
        let (db, card, cafe) = setup();
        let c = db.conn();
        let a = create(c, &coffee(&card, &cafe)).unwrap();
        let b = create(
            c,
            &TemplateInput {
                name: "Обед".into(),
                ..coffee(&card, &cafe)
            },
        )
        .unwrap();
        assert_eq!(list(c).unwrap()[0].id, a);
        used(c, &b).unwrap();
        assert_eq!(list(c).unwrap()[0].id, b);
        assert!(create(
            c,
            &TemplateInput {
                name: " ".into(),
                ..coffee(&card, &cafe)
            }
        )
        .is_err());
        assert!(create(
            c,
            &TemplateInput {
                amount: Some(0),
                ..coffee(&card, &cafe)
            }
        )
        .is_err());
        delete(c, &a).unwrap();
        assert_eq!(list(c).unwrap().len(), 1);
        assert!(delete(c, &a).is_err());
    }

    #[test]
    fn transfer_between_currencies_needs_the_form() {
        let (db, card, _) = setup();
        let c = db.conn();
        let usd = accounts::create(c, &input("Вклад USD", "savings", "USD", 0)).unwrap();
        let cash = accounts::create(c, &input("Наличные", "cash", "RUB", 0)).unwrap();
        let t = |to: &str| TemplateInput {
            name: "Перевод".into(),
            kind: "transfer".into(),
            amount: Some(500_000),
            account_id: Some(card.clone()),
            to_account_id: Some(to.into()),
            ..Default::default()
        };
        let same = create(c, &t(&cash)).unwrap();
        create(c, &t(&usd)).unwrap();
        let all = list(c).unwrap();
        assert_eq!(all.iter().filter(|x| x.complete).count(), 1);
        apply(c, &same, "2026-10-20").unwrap();
        assert_eq!(accounts::balance(c, &cash, None).unwrap(), 500_000);
    }
}
