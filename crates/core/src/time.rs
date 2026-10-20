//! Служебные метки времени (UTC, ISO 8601) и даты операций (`YYYY-MM-DD`).

use chrono::{Local, SecondsFormat, Utc};

/// Метка времени для `created_at` / `updated_at`.
pub fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Сегодняшняя дата по местному времени пользователя.
pub fn today_local() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Метка для имён файлов резервных копий: `20261020-141530`.
pub fn file_stamp() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Проверить дату операции `YYYY-MM-DD`.
pub fn check_date(date: &str) -> crate::Result<()> {
    match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        Ok(_) if date.len() == 10 => Ok(()),
        _ => crate::error::invalid(format!("некорректная дата: {date}")),
    }
}
