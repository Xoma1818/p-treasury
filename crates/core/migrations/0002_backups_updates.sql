-- Этап 6: время последней резервной копии (для напоминания о копии)
-- и автоматическая проверка обновлений при запуске.
INSERT INTO settings (key, value) VALUES
    ('last_backup_at', ''),
    ('update_check', '1');
