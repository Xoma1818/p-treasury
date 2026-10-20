use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ошибка базы данных: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("ошибка файла: {0}")]
    Io(#[from] std::io::Error),

    /// Файл создан более новой версией приложения: открывать его на запись нельзя.
    #[error("файл данных создан более новой версией приложения (схема {found}, эта версия знает до {supported}); обновите приложение")]
    SchemaTooNew { found: i64, supported: i64 },

    /// Миграция не применилась; изменения откатаны, копия файла лежит в `backup`.
    #[error("не удалось обновить структуру данных до версии {version}: {source}")]
    Migration {
        version: i64,
        backup: Option<PathBuf>,
        #[source]
        source: rusqlite::Error,
    },

    #[error("некорректная сумма: {0}")]
    InvalidAmount(String),

    #[error("неизвестная настройка: {0}")]
    UnknownSetting(String),

    /// Нарушено бизнес-правило; текст показывается пользователю как есть.
    #[error("{0}")]
    Validation(String),

    #[error("{0} не найден(а)")]
    NotFound(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Короткая запись для ошибок проверки: `invalid("Сумма должна быть больше нуля")`.
pub fn invalid<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error::Validation(msg.into()))
}
