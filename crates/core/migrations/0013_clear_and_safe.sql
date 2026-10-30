-- 0.21: проверка восстановления копий. Дата последней копии, которая прошла
-- пробное восстановление (UTC, RFC 3339), её файл и итог (JSON), и ошибка
-- последней неудачной проверки.
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('backup_verified_at', ''),
    ('backup_verified_path', ''),
    ('backup_verified_info', ''),
    ('backup_verify_error', '');
