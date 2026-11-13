-- 0.35 Пересекающиеся выписки (тред 39).
--
-- Строка банка, чью операцию человек удалил сам. Без этой памяти следующая
-- выписка за тот же период загрузила бы удалённое снова: ключ строки
-- (import_keys, import_links) удаляется вместе с операцией. Отмена загрузки
-- сюда не пишет: после неё та же выписка загрузится заново целиком.
-- Ctrl+Z удаления убирает и запись отсюда (таблица отслеживается отменой).
CREATE TABLE import_deleted (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    bank_date   TEXT NOT NULL,
    bank_amount INTEGER NOT NULL,
    bank_payee  TEXT NOT NULL DEFAULT '',
    deleted_at  TEXT NOT NULL
);
CREATE INDEX idx_import_deleted_bank ON import_deleted(account_id, bank_date, bank_amount);
