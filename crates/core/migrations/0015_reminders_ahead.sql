-- 0.23: напоминания и платежи наперёд.
-- За сколько дней предупредить о платеже: '7,3,1' (0 — в сам день не нужен, он есть всегда).
-- NULL — как в Настройках (reminder_lead_days), '' — заранее не предупреждать.
ALTER TABLE reminders ADD COLUMN lead_days TEXT;
-- Последний платёж серии другой суммы (например, остаток рассрочки).
ALTER TABLE reminders ADD COLUMN last_amount INTEGER CHECK (last_amount IS NULL OR last_amount > 0);
-- Напоминание у заметки или у события календаря: удаляется вместе с ним.
ALTER TABLE reminders ADD COLUMN note_id TEXT REFERENCES notes(id) ON DELETE CASCADE;
ALTER TABLE reminders ADD COLUMN event_id TEXT REFERENCES events(id) ON DELETE CASCADE;

-- Правка одного платежа серии: своя сумма и перенос на другой день.
ALTER TABLE reminder_occurrences ADD COLUMN amount_override INTEGER
    CHECK (amount_override IS NULL OR amount_override > 0);
ALTER TABLE reminder_occurrences ADD COLUMN moved_to TEXT;

-- Предупреждения заранее, которые уже показаны: 'lead' — «через N дней»,
-- 'funds' — на счёте не хватает денег.
CREATE TABLE reminder_notices (
    source       TEXT NOT NULL CHECK (source IN ('reminder', 'debt')),
    ref_id       TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('lead', 'funds')),
    days         INTEGER NOT NULL,
    sent_at      TEXT NOT NULL,
    PRIMARY KEY (source, ref_id, scheduled_at, kind, days)
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('reminder_lead_days', '3,1'),
    ('reminder_funds_days', '3');
