-- 0.13: папка сохранности (Документы\P-Treasury или своя папка).
-- vault_dir пусто — папка по умолчанию; выбранная раньше папка автокопий
-- становится папкой сохранности. vault_synced_at и vault_error — когда папка
-- обновлялась в последний раз и что не удалось (например, Excel открыт).
INSERT INTO settings (key, value) VALUES
    ('vault_on', '1'),
    ('vault_dir', ''),
    ('vault_synced_at', ''),
    ('vault_error', '');

UPDATE settings
SET value = (SELECT value FROM settings WHERE key = 'autobackup_dir')
WHERE key = 'vault_dir';
