-- Тред 27, этап 8а: свои группы счетов (Р19), цвет и значок счёта (Р21).
-- «Входит в бюджет» (Р20) — настройка budget_excluded_accounts, как у прогноза.
--
-- account_groups — группы вроде «Семья», «Отложено»; у счёта не больше одной.
-- accounts.group_id — группа счёта (NULL — без группы).
-- accounts.color, accounts.icon — те же имена, что у категорий.
CREATE TABLE account_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN group_id TEXT REFERENCES account_groups(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN color TEXT;
ALTER TABLE accounts ADD COLUMN icon TEXT;
