//! Ядро приложения «Казна».
//!
//! UI вызывает только команды ядра и никогда не пишет SQL; модули ядра
//! обращаются к базе только через [`storage`].

pub mod accounts;
pub mod budgets;
pub mod categories;
pub mod currencies;
pub mod debts;
pub mod error;
pub mod ids;
pub mod loan_calc;
pub mod money;
pub mod onboarding;
pub mod reports;
pub mod settings;
pub mod storage;
pub mod time;
pub mod transactions;

pub use error::{Error, Result};
