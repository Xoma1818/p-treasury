-- Обновление 0.10 («вторая волна» идей из похожих приложений).

-- Цель финансовой подушки в месяцах и признак пробных данных.
INSERT INTO settings (key, value) VALUES
    ('cushion_goal_months', '6'),
    ('demo_data', '0');

-- Сохранённые виды: фильтр операций или настройки отчёта под именем.
CREATE TABLE saved_views (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('transactions', 'report')),
    -- Параметры вида в JSON: их понимает только интерфейс.
    params     TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

-- Правила автокатегоризации: текст в получателе или SMS банка → категория.
CREATE TABLE payee_rules (
    id           TEXT PRIMARY KEY,
    pattern      TEXT NOT NULL,
    -- Текст для поиска: нижний регистр, «ё» как «е».
    pattern_norm TEXT NOT NULL UNIQUE,
    category_id  TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    payee        TEXT,
    created_at   TEXT NOT NULL
);

-- Быстрый ввод из любого места: горячая клавиша ('' — выключено).
INSERT INTO settings (key, value) VALUES ('quick_hotkey', 'Ctrl+Alt+P');
