-- 0.17: займы по-банковски. Проценты по дням или по месяцам, изменения ставки,
-- кредитные каникулы, плановые досрочные погашения и снимки графика (версии).
-- Уже записанные займы остаются с методом 'monthly': их графики не меняются.
ALTER TABLE debts ADD COLUMN interest_method TEXT NOT NULL DEFAULT 'monthly'
    CHECK (interest_method IN ('monthly', 'daily'));

-- Новая ставка с даты: с первой даты платежа после неё аннуитет пересчитывается.
CREATE TABLE debt_rate_changes (
    id         TEXT PRIMARY KEY,
    debt_id    TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    from_date  TEXT NOT NULL,
    rate_bp    INTEGER NOT NULL CHECK (rate_bp >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (debt_id, from_date)
);
CREATE INDEX idx_debt_rate_changes_debt ON debt_rate_changes(debt_id);

-- Кредитные каникулы: interest_only — только проценты, срок длиннее;
-- shift — платежи сдвигаются, проценты за паузу входят в первый платёж после неё.
CREATE TABLE debt_holidays (
    id         TEXT PRIMARY KEY,
    debt_id    TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    from_seq   INTEGER NOT NULL CHECK (from_seq >= 1),
    months     INTEGER NOT NULL CHECK (months BETWEEN 1 AND 12),
    kind       TEXT NOT NULL CHECK (kind IN ('interest_only', 'shift')),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_debt_holidays_debt ON debt_holidays(debt_id);

-- Плановые досрочные погашения: только для прогноза, в debt_schedule не пишутся.
CREATE TABLE debt_planned_early (
    id         TEXT PRIMARY KEY,
    debt_id    TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    start_date TEXT NOT NULL,
    frequency  TEXT NOT NULL CHECK (frequency IN ('once', 'monthly', 'quarterly', 'yearly')),
    end_date   TEXT,
    mode       TEXT NOT NULL CHECK (mode IN ('reduce_payment', 'reduce_term')),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_debt_planned_early_debt ON debt_planned_early(debt_id);

-- Снимок графика до изменения: итоги и строки в JSON (история «было → стало»).
CREATE TABLE debt_versions (
    id             TEXT PRIMARY KEY,
    debt_id        TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    created_at     TEXT NOT NULL,
    reason         TEXT NOT NULL,
    payment        INTEGER NOT NULL,
    total_interest INTEGER NOT NULL,
    total_payment  INTEGER NOT NULL,
    maturity_date  TEXT NOT NULL,
    rows_json      TEXT NOT NULL
);
CREATE INDEX idx_debt_versions_debt ON debt_versions(debt_id);

-- ФИО займодавца для PDF графика: запоминается между выгрузками.
INSERT INTO settings (key, value) VALUES ('loan_lender_name', '');
