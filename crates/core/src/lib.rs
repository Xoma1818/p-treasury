//! Ядро приложения P-Treasury.
//!
//! UI вызывает только команды ядра и никогда не пишет SQL; модули ядра
//! обращаются к базе только через [`storage`].

pub mod accounts;
pub mod assets;
pub mod auto_import;
pub mod backups;
pub mod budgets;
pub mod calendar;
pub mod categories;
pub mod cbr;
pub mod compare;
pub mod csv_import;
pub mod currencies;
pub mod debts;
pub mod demo;
pub mod error;
pub mod events;
pub mod export;
pub mod goals;
pub mod habits;
pub mod ids;
pub mod invest;
pub mod loan_calc;
pub mod money;
pub mod notes;
pub mod onboarding;
pub mod quick;
pub mod reminders;
pub mod reports;
pub mod rules;
pub mod search;
pub mod settings;
pub mod split;
pub mod storage;
pub mod subscriptions;
pub mod templates;
pub mod time;
pub mod transactions;
pub mod undo;
pub mod views;
pub mod wealth;
pub mod year;

pub use error::{Error, Result};
/// Соединение SQLite: тип нужен оболочке приложения для журнала отмены.
pub use rusqlite::Connection;
