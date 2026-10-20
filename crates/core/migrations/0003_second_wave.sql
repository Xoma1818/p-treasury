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
