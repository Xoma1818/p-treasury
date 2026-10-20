//! Ядро приложения «Казна».
//!
//! UI вызывает только команды ядра и никогда не пишет SQL; модули ядра
//! обращаются к базе только через [`storage`].

pub mod currencies;
pub mod error;
pub mod ids;
pub mod money;
pub mod settings;
pub mod storage;
pub mod time;

pub use error::{Error, Result};
