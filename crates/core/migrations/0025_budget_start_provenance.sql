-- Preserve schema-24 values, but distinguish ambiguous backfilled history.
-- New budgets keep the known day captured by the existing insert trigger.
ALTER TABLE budgets ADD COLUMN start_day_known INTEGER NOT NULL DEFAULT 1
    CHECK (start_day_known IN (0, 1));
UPDATE budgets SET start_day_known = 0
WHERE period_start = date(period_start, 'start of month', '+1 month', '-1 day')
  AND CAST(strftime('%d', period_start) AS INTEGER) < 31;
