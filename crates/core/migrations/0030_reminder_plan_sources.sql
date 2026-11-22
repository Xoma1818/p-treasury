-- Валюта сумм, в том числе правок отдельного платежа, сохраняется вместе
-- с серией. У прежних напоминаний остаётся их исходное поведение.
ALTER TABLE reminders ADD COLUMN amount_currency TEXT REFERENCES currencies(code);

-- Платёж, по которому создана серия, уже учтён на счёте. Это источник
-- расписания, а не оплата его первого будущего срабатывания.
CREATE TABLE reminder_plan_sources (
    reminder_id TEXT PRIMARY KEY NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    series_id TEXT NOT NULL,
    is_current INTEGER NOT NULL CHECK (is_current IN (0, 1))
);
CREATE INDEX idx_repeat_source ON reminder_plan_sources(transaction_id, reminder_id);
CREATE INDEX idx_repeat_series ON reminder_plan_sources(series_id);
CREATE UNIQUE INDEX uq_repeat_current_source ON reminder_plan_sources(transaction_id) WHERE is_current = 1;
CREATE UNIQUE INDEX uq_repeat_current_series ON reminder_plan_sources(series_id) WHERE is_current = 1;
