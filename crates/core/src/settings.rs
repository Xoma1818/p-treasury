//! Настройки приложения: ключ-значение в таблице `settings`.
//! Набор ключей и значения по умолчанию задаются миграциями.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{Error, Result};

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

pub fn all(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Изменить существующую настройку. Неизвестный ключ — ошибка, чтобы опечатка
/// в UI не создавала мусорных записей.
pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    validate(key, value)?;
    let changed = conn.execute(
        "UPDATE settings SET value = ?2 WHERE key = ?1",
        params![key, value],
    )?;
    if changed == 0 {
        return Err(Error::UnknownSetting(key.to_string()));
    }
    Ok(())
}

/// Сочетания для быстрого ввода из любого места; пустая строка — выключено.
pub const QUICK_HOTKEYS: &[&str] = &["Ctrl+Alt+P", "Ctrl+Shift+Space", "Ctrl+Alt+N", ""];

/// Значения, от которых зависят расчёты, проверяются здесь, а не только в UI.
fn validate(key: &str, value: &str) -> Result<()> {
    let ok = match key {
        "month_start_day" => value.parse::<u32>().is_ok_and(|d| (1..=31).contains(&d)),
        "hide_amounts" | "close_to_tray" | "onboarding_done" | "update_check" | "demo_data"
        | "weekly_summary" | "rates_auto" | "auto_import" | "hints" | "subs_remind"
        | "vault_on" | "budget_alerts" => {
            matches!(value, "0" | "1")
        }
        "debt_reminder_days_before" | "autobackup_keep" => value.parse::<u32>().is_ok(),
        "reminder_lead_days" => crate::reminders::parse_lead_days(value).is_ok(),
        "reminder_funds_days" => value
            .parse::<i64>()
            .is_ok_and(|d| (0..=crate::reminders::MAX_LEAD_DAYS).contains(&d)),
        "cushion_goal_months" => value.parse::<u32>().is_ok_and(|m| (1..=60).contains(&m)),
        "quick_hotkey" => QUICK_HOTKEYS.contains(&value),
        "date_format" => matches!(value, "DD.MM.YYYY" | "YYYY-MM-DD"),
        "subscriptions_hidden" | "forecast_excluded_accounts" => {
            serde_json::from_str::<Vec<String>>(value).is_ok()
        }
        "subs_notified" => serde_json::from_str::<BTreeMap<String, String>>(value).is_ok(),
        "bank_accounts" => serde_json::from_str::<BTreeMap<String, String>>(value).is_ok(),
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err(Error::Validation(format!(
            "недопустимое значение настройки {key}: {value}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    #[test]
    fn defaults_and_update() {
        let db = Storage::open_in_memory().unwrap();
        assert_eq!(
            get(db.conn(), "base_currency").unwrap().as_deref(),
            Some("RUB")
        );
        set(db.conn(), "hide_amounts", "1").unwrap();
        assert_eq!(all(db.conn()).unwrap()["hide_amounts"], "1");
        assert!(matches!(
            set(db.conn(), "nope", "1"),
            Err(Error::UnknownSetting(_))
        ));
    }

    #[test]
    fn month_start_day_is_validated() {
        let db = Storage::open_in_memory().unwrap();
        set(db.conn(), "month_start_day", "25").unwrap();
        for bad in ["0", "32", "abc", ""] {
            assert!(
                matches!(
                    set(db.conn(), "month_start_day", bad),
                    Err(Error::Validation(_))
                ),
                "{bad}"
            );
        }
        assert!(set(db.conn(), "hide_amounts", "yes").is_err());
        assert_eq!(
            get(db.conn(), "month_start_day").unwrap().as_deref(),
            Some("25")
        );
    }
}
