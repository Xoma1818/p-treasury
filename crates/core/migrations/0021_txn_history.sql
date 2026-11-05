-- Тред 33. История изменений операций.
--
-- Каждая правка и удаление операции записываются триггерами, поэтому в историю
-- попадает любой путь: форма, массовые действия, правила, импорт, отмена Ctrl+Z.
-- Создание не пишется: дата создания уже есть в самой операции, а импорт
-- больших выписок не должен удваивать записи.
-- before/after — JSON только с видимыми пользователю полями; служебные
-- (updated_at, import_id, split_id и т. п.) правкой не считаются.
CREATE TABLE txn_history (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id  TEXT NOT NULL,
    at      TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('update', 'delete')),
    before  TEXT NOT NULL,
    after   TEXT
);
CREATE INDEX txn_history_txn ON txn_history (txn_id, id);

CREATE TRIGGER txn_history_update AFTER UPDATE ON transactions
WHEN OLD.type IS NOT NEW.type
  OR OLD.date IS NOT NEW.date
  OR OLD.account_id IS NOT NEW.account_id
  OR OLD.amount IS NOT NEW.amount
  OR OLD.category_id IS NOT NEW.category_id
  OR OLD.to_account_id IS NOT NEW.to_account_id
  OR OLD.to_amount IS NOT NEW.to_amount
  OR OLD.payee IS NOT NEW.payee
  OR OLD.note IS NOT NEW.note
  OR OLD.status IS NOT NEW.status
  OR OLD.event_id IS NOT NEW.event_id
  OR OLD.spread_months IS NOT NEW.spread_months
  OR OLD.count_date IS NOT NEW.count_date
BEGIN
    INSERT INTO txn_history (txn_id, at, kind, before, after) VALUES (
        NEW.id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        'update',
        json_object('type', OLD.type, 'date', OLD.date, 'account_id', OLD.account_id,
                    'amount', OLD.amount, 'category_id', OLD.category_id,
                    'to_account_id', OLD.to_account_id, 'to_amount', OLD.to_amount,
                    'payee', OLD.payee, 'note', OLD.note, 'status', OLD.status,
                    'event_id', OLD.event_id, 'spread_months', OLD.spread_months,
                    'count_date', OLD.count_date),
        json_object('type', NEW.type, 'date', NEW.date, 'account_id', NEW.account_id,
                    'amount', NEW.amount, 'category_id', NEW.category_id,
                    'to_account_id', NEW.to_account_id, 'to_amount', NEW.to_amount,
                    'payee', NEW.payee, 'note', NEW.note, 'status', NEW.status,
                    'event_id', NEW.event_id, 'spread_months', NEW.spread_months,
                    'count_date', NEW.count_date)
    );
END;

CREATE TRIGGER txn_history_delete AFTER DELETE ON transactions
BEGIN
    INSERT INTO txn_history (txn_id, at, kind, before, after) VALUES (
        OLD.id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        'delete',
        json_object('type', OLD.type, 'date', OLD.date, 'account_id', OLD.account_id,
                    'amount', OLD.amount, 'category_id', OLD.category_id,
                    'to_account_id', OLD.to_account_id, 'to_amount', OLD.to_amount,
                    'payee', OLD.payee, 'note', OLD.note, 'status', OLD.status,
                    'event_id', OLD.event_id, 'spread_months', OLD.spread_months,
                    'count_date', OLD.count_date),
        NULL
    );
END;
