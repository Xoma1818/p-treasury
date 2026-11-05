-- Тред 27, этап 6д «Тонкие настройки» (Г12).
--
-- unusual_percent — с какого отклонения от обычного трата попадает в «Необычно» (5–300 %).
-- checks_days — за сколько последних дней смотрит карточка «Проверьте» (7–180).
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('unusual_percent', '25'),
    ('checks_days', '30');
