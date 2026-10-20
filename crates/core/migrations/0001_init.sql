-- Первая схема базы (architecture.md, раздел 4).
-- Деньги: INTEGER в минимальных единицах валюты. Даты: TEXT 'YYYY-MM-DD'.
-- Служебные метки времени: UTC ISO 8601. Идентификаторы: UUID v7 в TEXT.
-- Таблицы версии 2 (recurring_rules, tags) заложены сразу, чтобы ссылки на них
-- были в схеме с первой миграции.

CREATE TABLE currencies (
    code        TEXT PRIMARY KEY CHECK (length(code) = 3),
    name        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    minor_units INTEGER NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 4)
);

INSERT INTO currencies (code, name, symbol, minor_units) VALUES
    ('RUB', 'Российский рубль', '₽', 2),
    ('USD', 'Доллар США', '$', 2),
    ('EUR', 'Евро', '€', 2),
    ('CNY', 'Китайский юань', '¥', 2),
    ('KZT', 'Казахстанский тенге', '₸', 2),
    ('BYN', 'Белорусский рубль', 'Br', 2),
    ('TRY', 'Турецкая лира', '₺', 2),
    ('AED', 'Дирхам ОАЭ', 'AED', 2),
    ('GBP', 'Фунт стерлингов', '£', 2),
    ('JPY', 'Японская иена', '¥', 0);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
    ('base_currency', 'RUB'),
    ('month_start_day', '1'),
    ('date_format', 'DD.MM.YYYY'),
    ('debt_reminder_days_before', '3'),
    ('close_to_tray', '1'),
    ('autobackup_dir', ''),
    ('autobackup_keep', '10'),
    ('hide_amounts', '0'),
    ('onboarding_done', '0');

CREATE TABLE exchange_rates (
    date      TEXT NOT NULL,
    from_code TEXT NOT NULL REFERENCES currencies(code),
    to_code   TEXT NOT NULL REFERENCES currencies(code),
    -- Курс хранится десятичной строкой ('92.1234'), чтобы не терять точность.
    rate      TEXT NOT NULL,
    source    TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'cbr')),
    PRIMARY KEY (date, from_code, to_code)
);

CREATE TABLE accounts (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    type             TEXT NOT NULL CHECK (type IN ('cash', 'debit', 'credit', 'savings', 'investment', 'debt')),
    currency_code    TEXT NOT NULL REFERENCES currencies(code),
    opening_balance  INTEGER NOT NULL DEFAULT 0,
    opening_date     TEXT NOT NULL,
    credit_limit     INTEGER CHECK (credit_limit IS NULL OR credit_limit >= 0),
    include_in_total INTEGER NOT NULL DEFAULT 1 CHECK (include_in_total IN (0, 1)),
    sort_order       INTEGER NOT NULL DEFAULT 0,
    archived_at      TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE categories (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT REFERENCES categories(id),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    icon        TEXT,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_categories_parent ON categories(parent_id);

-- Версия 2: повторяющиеся операции.
CREATE TABLE recurring_rules (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    amount        INTEGER NOT NULL CHECK (amount > 0),
    category_id   TEXT REFERENCES categories(id),
    to_account_id TEXT REFERENCES accounts(id),
    to_amount     INTEGER,
    payee         TEXT,
    note          TEXT,
    frequency     TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
    interval      INTEGER NOT NULL DEFAULT 1 CHECK (interval >= 1),
    day_of_month  INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    weekday       INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
    start_date    TEXT NOT NULL,
    end_date      TEXT,
    next_due_date TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'remind' CHECK (mode IN ('auto', 'remind')),
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE debts (
    id                 TEXT PRIMARY KEY,
    direction          TEXT NOT NULL CHECK (direction IN ('lent', 'borrowed')),
    counterparty       TEXT NOT NULL,
    note               TEXT,
    account_id         TEXT NOT NULL UNIQUE REFERENCES accounts(id),
    currency_code      TEXT NOT NULL REFERENCES currencies(code),
    principal          INTEGER NOT NULL CHECK (principal > 0),
    issue_date         TEXT NOT NULL,
    rate_bp            INTEGER NOT NULL DEFAULT 0 CHECK (rate_bp >= 0),
    repayment_type     TEXT NOT NULL CHECK (repayment_type IN ('annuity', 'differentiated', 'bullet')),
    frequency          TEXT NOT NULL CHECK (frequency IN ('monthly', 'once')),
    term_months        INTEGER CHECK (term_months IS NULL OR term_months >= 1),
    first_payment_date TEXT,
    maturity_date      TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    closed_at          TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    CHECK (repayment_type <> 'bullet' OR frequency = 'once')
);

CREATE TABLE transactions (
    id                TEXT PRIMARY KEY,
    type              TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer', 'adjustment')),
    date              TEXT NOT NULL,
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    -- Для adjustment сумма со знаком (разница с реальным остатком), для остальных > 0.
    amount            INTEGER NOT NULL,
    category_id       TEXT REFERENCES categories(id),
    to_account_id     TEXT REFERENCES accounts(id),
    to_amount         INTEGER,
    payee             TEXT,
    note              TEXT,
    recurring_rule_id TEXT REFERENCES recurring_rules(id) ON DELETE SET NULL,
    debt_id           TEXT REFERENCES debts(id),
    status            TEXT NOT NULL DEFAULT 'cleared' CHECK (status IN ('cleared', 'planned')),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    CHECK (amount <> 0),
    CHECK (type = 'adjustment' OR amount > 0),
    CHECK (type NOT IN ('expense', 'income') OR category_id IS NOT NULL),
    CHECK (type <> 'transfer' OR (to_account_id IS NOT NULL AND to_amount IS NOT NULL AND to_amount > 0
                                  AND to_account_id <> account_id)),
    CHECK (type = 'transfer' OR (to_account_id IS NULL AND to_amount IS NULL))
);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_account_date ON transactions(account_id, date);
CREATE INDEX idx_transactions_to_account_date ON transactions(to_account_id, date);
CREATE INDEX idx_transactions_category_date ON transactions(category_id, date);
CREATE INDEX idx_transactions_debt ON transactions(debt_id);
CREATE INDEX idx_transactions_payee_date ON transactions(payee, date);

CREATE TABLE transaction_templates (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer')),
    amount        INTEGER CHECK (amount IS NULL OR amount > 0),
    account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    to_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
    payee         TEXT,
    note          TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    use_count     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- Версия 2: теги.
CREATE TABLE tags (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE transaction_tags (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id         TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE budgets (
    id            TEXT PRIMARY KEY,
    -- Настоящая дата начала периода по настройке month_start_day
    -- (например, 2026-10-25 для «ноября» при начале месяца 25-го).
    period_start  TEXT NOT NULL,
    period_type   TEXT NOT NULL DEFAULT 'month' CHECK (period_type IN ('month')),
    currency_code TEXT NOT NULL REFERENCES currencies(code),
    note          TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (period_start, period_type)
);

CREATE TABLE budget_lines (
    id           TEXT PRIMARY KEY,
    budget_id    TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    category_id  TEXT NOT NULL REFERENCES categories(id),
    limit_amount INTEGER NOT NULL CHECK (limit_amount >= 0),
    rollover     INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0, 1)),
    UNIQUE (budget_id, category_id)
);

CREATE TABLE debt_schedule (
    id             TEXT PRIMARY KEY,
    debt_id        TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL CHECK (seq >= 1),
    due_date       TEXT NOT NULL,
    payment        INTEGER NOT NULL CHECK (payment >= 0),
    principal_part INTEGER NOT NULL CHECK (principal_part >= 0),
    interest_part  INTEGER NOT NULL CHECK (interest_part >= 0),
    balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'partial')),
    UNIQUE (debt_id, seq)
);
CREATE INDEX idx_debt_schedule_due ON debt_schedule(due_date);

CREATE TABLE debt_payments (
    id                       TEXT PRIMARY KEY,
    debt_id                  TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    schedule_id              TEXT REFERENCES debt_schedule(id) ON DELETE SET NULL,
    date                     TEXT NOT NULL,
    principal_amount         INTEGER NOT NULL CHECK (principal_amount >= 0),
    interest_amount          INTEGER NOT NULL DEFAULT 0 CHECK (interest_amount >= 0),
    principal_transaction_id TEXT REFERENCES transactions(id),
    interest_transaction_id  TEXT REFERENCES transactions(id),
    -- Как пересчитан график после частичного или досрочного платежа.
    recalc_mode              TEXT CHECK (recalc_mode IS NULL OR recalc_mode IN ('reduce_payment', 'reduce_term')),
    created_at               TEXT NOT NULL
);
CREATE INDEX idx_debt_payments_debt ON debt_payments(debt_id);

CREATE TABLE reminders (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    -- Местное время без часового пояса: 'YYYY-MM-DDTHH:MM'.
    start_at     TEXT NOT NULL,
    repeat       TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'daily', 'weekly', 'monthly', 'yearly')),
    day_of_month INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    end_date     TEXT,
    amount       INTEGER CHECK (amount IS NULL OR amount > 0),
    txn_type     TEXT CHECK (txn_type IS NULL OR txn_type IN ('expense', 'income')),
    account_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
    note         TEXT,
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE reminder_occurrences (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL CHECK (source IN ('reminder', 'debt')),
    reminder_id      TEXT REFERENCES reminders(id) ON DELETE CASCADE,
    debt_schedule_id TEXT REFERENCES debt_schedule(id) ON DELETE CASCADE,
    scheduled_at     TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'snoozed', 'dismissed')),
    snoozed_until    TEXT,
    notified_at      TEXT,
    completed_at     TEXT,
    transaction_id   TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    CHECK ((source = 'reminder' AND reminder_id IS NOT NULL AND debt_schedule_id IS NULL)
        OR (source = 'debt' AND debt_schedule_id IS NOT NULL AND reminder_id IS NULL))
);
-- NULL в UNIQUE не сравнивается, поэтому ключ разбит на два частичных индекса.
CREATE UNIQUE INDEX uq_occ_reminder ON reminder_occurrences(reminder_id, scheduled_at) WHERE source = 'reminder';
CREATE UNIQUE INDEX uq_occ_debt ON reminder_occurrences(debt_schedule_id, scheduled_at) WHERE source = 'debt';

CREATE TABLE notes (
    id             TEXT PRIMARY KEY,
    body           TEXT NOT NULL,
    date           TEXT,
    transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    debt_id        TEXT REFERENCES debts(id) ON DELETE SET NULL,
    budget_id      TEXT REFERENCES budgets(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    CHECK ((transaction_id IS NOT NULL) + (account_id IS NOT NULL)
         + (debt_id IS NOT NULL) + (budget_id IS NOT NULL) <= 1)
);
CREATE INDEX idx_notes_date ON notes(date);

CREATE VIRTUAL TABLE notes_fts USING fts5(
    body,
    content = 'notes',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF body ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;
