-- 0.12: цели накоплений, подписки, импорт выписок из папки, подсказки.

-- Цель: накопить сумму к дате (или без даты). Прогресс берётся с привязанного
-- счёта (копилка, вклад) или из ручных пополнений цели.
CREATE TABLE goals (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    target        INTEGER NOT NULL CHECK (target > 0),
    currency_code TEXT NOT NULL REFERENCES currencies(code),
    account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    deadline      TEXT,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- Ручные пополнения цели (и изъятия — с минусом), когда счёт не привязан.
CREATE TABLE goal_deposits (
    id         TEXT PRIMARY KEY,
    goal_id    TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount <> 0),
    created_at TEXT NOT NULL
);
CREATE INDEX goal_deposits_goal ON goal_deposits(goal_id, date);

-- Файлы выписок, уже разобранные автоимпортом из папки: второй раз не берутся.
CREATE TABLE import_files (
    path        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    modified    TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    added       INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    PRIMARY KEY (path, size, modified)
);

INSERT INTO settings (key, value) VALUES
    ('auto_import', '0'),
    ('auto_import_dir', ''),
    ('subscriptions_hidden', '[]'),
    ('hints', '1');
