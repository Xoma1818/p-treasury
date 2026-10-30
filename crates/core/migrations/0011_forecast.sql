-- 0.18 «Взгляд вперёд» (docs/product/0.18-forecast.md).
--
-- Сам прогноз нигде не хранится: он считается из счетов, операций, напоминаний
-- и графиков займов. Хранятся только сценарии «что если» — наборы изменений,
-- которые накладываются на обычный прогноз.

CREATE TABLE forecast_scenarios (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL CHECK (trim(name) <> ''),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- kind:
--   once        — разовая сумма в месяце start_month (amount со знаком: + доход, − трата);
--   monthly     — сумма каждый месяц с start_month на months месяцев (NULL — до конца прогноза);
--   income_pct  — доходы месяца меняются на percent % (−100 — «без дохода»);
--   expense_pct — обычные траты месяца меняются на percent %.
CREATE TABLE forecast_changes (
    id          TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES forecast_scenarios(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('once', 'monthly', 'income_pct', 'expense_pct')),
    title       TEXT NOT NULL,
    amount      INTEGER,
    percent     INTEGER,
    start_month TEXT NOT NULL,
    months      INTEGER CHECK (months IS NULL OR months BETWEEN 1 AND 120),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    CHECK (kind NOT IN ('once', 'monthly') OR (amount IS NOT NULL AND amount <> 0 AND percent IS NULL)),
    CHECK (kind NOT IN ('income_pct', 'expense_pct')
           OR (percent IS NOT NULL AND percent <> 0 AND percent >= -100 AND amount IS NULL))
);
CREATE INDEX idx_forecast_changes_scenario ON forecast_changes(scenario_id, sort_order);
