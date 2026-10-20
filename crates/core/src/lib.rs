//! Ядро приложения P-Treasury.
//!
//! UI вызывает только команды ядра и никогда не пишет SQL; модули ядра
//! обращаются к базе только через [`storage`].

pub mod accounts;
pub mod backups;
pub mod budgets;
pub mod calendar;
pub mod categories;
pub mod cbr;
pub mod compare;
pub mod csv_import;
pub mod currencies;
pub mod debts;
pub mod error;
pub mod export;
pub mod ids;
pub mod loan_calc;
pub mod money;
pub mod notes;
pub mod onboarding;
pub mod reminders;
pub mod reports;
pub mod settings;
pub mod storage;
pub mod templates;
pub mod time;
pub mod transactions;
pub mod undo;

pub use error::{Error, Result};
/// Соединение SQLite: тип нужен оболочке приложения для журнала отмены.
pub use rusqlite::Connection;
