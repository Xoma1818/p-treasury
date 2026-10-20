//! Справочник валют.

use rusqlite::Connection;
use serde::Serialize;

use crate::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Currency {
    pub code: String,
    pub name: String,
    pub symbol: String,
    pub minor_units: u32,
}

/// Все валюты; рубль первым, остальные по коду.
pub fn list(conn: &Connection) -> Result<Vec<Currency>> {
    let mut stmt = conn.prepare(
        "SELECT code, name, symbol, minor_units FROM currencies ORDER BY code = 'RUB' DESC, code",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Currency {
            code: r.get(0)?,
            name: r.get(1)?,
            symbol: r.get(2)?,
            minor_units: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use crate::storage::Storage;

    #[test]
    fn rub_first() {
        let db = Storage::open_in_memory().unwrap();
        let all = super::list(db.conn()).unwrap();
        assert_eq!(all[0].code, "RUB");
        assert!(all.iter().any(|c| c.code == "JPY" && c.minor_units == 0));
    }
}
