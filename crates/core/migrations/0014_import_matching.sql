-- 0.22 «Понятные цифры»: история импорта и сопоставление записей (Issue #44).
-- Номер миграции 0014: 0013 занята 0.21 «Понятно и надёжно».

-- Каждый импорт выписки или CSV — одна запись истории. Сколько операций
-- добавлено и связано, считается по import_id и import_links; skipped —
-- строки, которые уже были загружены раньше.
CREATE TABLE import_batches (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    origin     TEXT NOT NULL CHECK (origin IN ('manual', 'folder')),
    file_name  TEXT NOT NULL,
    -- «Сбер», «Т-Банк»; NULL — CSV по шаблону.
    bank       TEXT,
    added      INTEGER NOT NULL DEFAULT 0,
    linked     INTEGER NOT NULL DEFAULT 0,
    skipped    INTEGER NOT NULL DEFAULT 0,
    undone_at  TEXT
);

-- Операция, добавленная импортом. Ручные записи — NULL.
ALTER TABLE transactions ADD COLUMN import_id TEXT REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX idx_transactions_import ON transactions(import_id) WHERE import_id IS NOT NULL;

-- Строка выписки, узнанная как уже записанная операция: запись остаётся как
-- есть (категории, части чека, теги, заметки), а данные строки банка хранятся
-- здесь, чтобы повторная выписка не добавила покупку второй раз. У перевода
-- между своими счетами может быть по строке на каждый счёт.
CREATE TABLE import_links (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    account_id     TEXT NOT NULL,
    import_id      TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    bank_date      TEXT NOT NULL,
    bank_amount    INTEGER NOT NULL,
    bank_payee     TEXT NOT NULL DEFAULT '',
    auto           INTEGER NOT NULL CHECK (auto IN (0, 1)),
    PRIMARY KEY (transaction_id, account_id)
);
CREATE INDEX idx_import_links_bank ON import_links(account_id, bank_date, bank_amount);

-- Сомнительные совпадения ждут подтверждения: new_id — операция из выписки,
-- old_id — запись, с которой её, возможно, надо связать (same) или
-- объединить в перевод между своими счетами (transfer).
CREATE TABLE import_suggestions (
    id         TEXT PRIMARY KEY,
    import_id  TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('same', 'transfer')),
    new_id     TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    old_id     TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (new_id, old_id)
);
