-- Тред 33, ревью OTTO 184d320. История изменений: теги операции.
--
-- Добавленный или снятый тег пишется отдельной строкой kind = 'update':
-- before = {"tag_removed": имя} или after = {"tag_added": имя}; окно собирает
-- строки одной секунды в одно изменение «Теги: было → стало».
-- Теги, поставленные при создании операции (форма, импорт, чек), не пишутся:
-- строка моложе 5 секунд считается частью создания. Каскадное удаление тегов
-- вместе с операцией тоже не пишется — операции к этому моменту уже нет.
CREATE TRIGGER txn_history_tag_add AFTER INSERT ON transaction_tags
WHEN EXISTS (SELECT 1 FROM transactions t WHERE t.id = NEW.transaction_id
             AND julianday('now') - julianday(t.created_at) > 5.0 / 86400)
BEGIN
    INSERT INTO txn_history (txn_id, at, kind, before, after) VALUES (
        NEW.transaction_id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        'update',
        '{}',
        json_object('tag_added', (SELECT name FROM tags WHERE id = NEW.tag_id))
    );
END;

CREATE TRIGGER txn_history_tag_remove AFTER DELETE ON transaction_tags
WHEN EXISTS (SELECT 1 FROM transactions WHERE id = OLD.transaction_id)
 AND EXISTS (SELECT 1 FROM tags WHERE id = OLD.tag_id)
BEGIN
    INSERT INTO txn_history (txn_id, at, kind, before, after) VALUES (
        OLD.transaction_id,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        'update',
        json_object('tag_removed', (SELECT name FROM tags WHERE id = OLD.tag_id)),
        '{}'
    );
END;
