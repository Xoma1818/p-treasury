-- Сумма и дата подтверждённой операции отличают явную связь от старого «Выполнено».
ALTER TABLE reminder_occurrences ADD COLUMN linked_actual_amount INTEGER
    CHECK (linked_actual_amount IS NULL OR linked_actual_amount > 0);
ALTER TABLE reminder_occurrences ADD COLUMN linked_actual_date TEXT;
CREATE INDEX idx_occurrences_transaction ON reminder_occurrences(transaction_id)
    WHERE transaction_id IS NOT NULL;

-- Потерявшая силу связь не закрывает напоминание и не исключает реальную
-- операцию из истории прогноза. После отмены правки связь снова действительна.
CREATE VIEW valid_reminder_actual_links AS
SELECT o.id AS occurrence_id, o.transaction_id
FROM reminder_occurrences o
JOIN reminders r ON r.id = o.reminder_id
JOIN transactions t ON t.id = o.transaction_id
WHERE o.source = 'reminder' AND o.status = 'done' AND o.linked_actual_amount IS NOT NULL
  AND t.status = 'cleared' AND t.account_id = r.account_id
  AND t.type = COALESCE(r.txn_type, 'expense') AND t.debt_id IS NULL AND t.refund = 0
  AND t.split_id IS NULL AND t.amount = o.linked_actual_amount AND t.date = o.linked_actual_date
  AND t.date BETWEEN date(COALESCE(o.moved_to, o.scheduled_at), '-3 days')
                 AND date(COALESCE(o.moved_to, o.scheduled_at), '+3 days');
