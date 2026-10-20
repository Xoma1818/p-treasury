//! Мастер первого запуска: основная валюта, счета с остатками, категории.

use serde::Deserialize;

use crate::accounts::{self, AccountInput};
use crate::error::invalid;
use crate::{categories, currencies, settings, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub base_currency: String,
    pub accounts: Vec<AccountInput>,
    pub default_categories: bool,
}

pub fn is_done(conn: &rusqlite::Connection) -> Result<bool> {
    Ok(settings::get(conn, "onboarding_done")?.as_deref() == Some("1"))
}

/// Применить мастер целиком в одной транзакции: если хоть один счёт
/// не прошёл проверку, ничего не записывается.
pub fn finish(conn: &mut rusqlite::Connection, setup: &Setup) -> Result<()> {
    if is_done(conn)? {
        return invalid("первый запуск уже выполнен");
    }
    currencies::get(conn, &setup.base_currency)?;
    let tx = conn.transaction()?;
    settings::set(&tx, "base_currency", &setup.base_currency)?;
    for a in &setup.accounts {
        accounts::create(&tx, a)?;
    }
    if setup.default_categories {
        categories::seed_defaults(&tx)?;
    }
    settings::set(&tx, "onboarding_done", "1")?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::storage::Storage;

    #[test]
    fn first_run_scenario() {
        // Сценарий «Первый запуск»: Наличные, Карта Сбер, Вклад; общий баланс на главном экране.
        let mut db = Storage::open_in_memory().unwrap();
        assert!(!is_done(db.conn()).unwrap());
        let setup = Setup {
            base_currency: "RUB".into(),
            accounts: vec![
                input("Наличные", "cash", "RUB", 1_200_000),
                input("Карта Сбер", "debit", "RUB", 4_530_000),
                input("Вклад", "savings", "RUB", 30_000_000),
            ],
            default_categories: true,
        };
        finish(db.conn_mut(), &setup).unwrap();
        let c = db.conn();
        assert!(is_done(c).unwrap());
        assert_eq!(accounts::totals(c, "2026-10-20").unwrap().total, 35_730_000);
        assert!(!categories::list(c, false).unwrap().is_empty());
        assert!(finish(db.conn_mut(), &setup).is_err(), "второй раз нельзя");
    }

    #[test]
    fn invalid_account_writes_nothing() {
        let mut db = Storage::open_in_memory().unwrap();
        let setup = Setup {
            base_currency: "RUB".into(),
            accounts: vec![
                input("Наличные", "cash", "RUB", 100),
                input("", "cash", "RUB", 0),
            ],
            default_categories: true,
        };
        assert!(finish(db.conn_mut(), &setup).is_err());
        let c = db.conn();
        assert!(!is_done(c).unwrap());
        assert!(accounts::list(c, true).unwrap().is_empty());
        assert!(categories::list(c, true).unwrap().is_empty());
    }
}
