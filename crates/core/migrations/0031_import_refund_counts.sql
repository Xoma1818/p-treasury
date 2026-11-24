-- Старый импорт записывал возвраты после сохранения счётчика партии.
-- Для уже удалённых строк не осталось надёжной связи с партией.
UPDATE import_batches
SET added = added + (
    SELECT count(*) FROM transactions t
    WHERE t.import_id = import_batches.id AND t.refund = 1
)
WHERE id IN (SELECT import_id FROM transactions WHERE refund = 1 AND import_id IS NOT NULL);
