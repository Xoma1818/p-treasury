-- Тред 27, этап 8в–8д: виды лимита (Р9), группы бюджета (Р10), период и цифры Главной, долги, заметки, цели.
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

-- Этап 8г: период Главной (Р2) и «Своя цифра» (Р1, Р14).
INSERT OR IGNORE INTO settings (key, value) VALUES ('home_period', 'month'), ('home_figures', '[]');

-- Этап 8д. Р18: напоминание по каждому долгу — за сколько дней до платежа;
-- NULL — как в общей настройке, -1 — не напоминать.
ALTER TABLE debts ADD COLUMN remind_days INTEGER CHECK (remind_days IS NULL OR remind_days BETWEEN -1 AND 60);
-- Р25: заметку можно закрепить сверху.
ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
-- Р26: приоритет цели (1 — самая важная) и доля свободных денег для подсказки «разложить».
ALTER TABLE goals ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN share_bp INTEGER CHECK (share_bp IS NULL OR share_bp BETWEEN 0 AND 10000);
