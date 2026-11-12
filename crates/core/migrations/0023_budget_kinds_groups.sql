-- Тред 27, этап 8в: виды лимита (Р9) и группы бюджета (Р10).
--
-- budget_lines.limit_kind — 'month' (сумма на месяц, как раньше), 'week'
-- (limit_value — сумма в неделю) или 'percent' (limit_value — доля дохода
-- месяца в сотых процента). limit_amount для недели хранит пересчёт на месяц.
-- budget_groups — «Обязательное», «Желаемое», «Накопления» или свои;
-- share_bp — целевая доля дохода (50/30/20), сотые процента, может не быть.
-- categories.budget_group_id — в какую группу бюджета входит категория.
ALTER TABLE budget_lines ADD COLUMN limit_kind TEXT NOT NULL DEFAULT 'month'
    CHECK (limit_kind IN ('month', 'week', 'percent'));
ALTER TABLE budget_lines ADD COLUMN limit_value INTEGER;

CREATE TABLE budget_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    share_bp   INTEGER CHECK (share_bp IS NULL OR share_bp BETWEEN 0 AND 10000),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE categories ADD COLUMN budget_group_id TEXT REFERENCES budget_groups(id) ON DELETE SET NULL;
