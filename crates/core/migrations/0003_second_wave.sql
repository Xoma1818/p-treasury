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

-- Имущество: квартира, машина и т. п. Стоимость — оценки на даты, последняя
-- входит в чистые активы.
CREATE TABLE assets (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('realty', 'vehicle', 'other')),
    currency_code TEXT NOT NULL REFERENCES currencies(code),
    note          TEXT,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE asset_values (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    date     TEXT NOT NULL,
    value    INTEGER NOT NULL CHECK (value >= 0),
    PRIMARY KEY (asset_id, date)
);

-- Поездки и события: даты, бюджет в основной валюте и операции события.
CREATE TABLE events (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    budget     INTEGER CHECK (budget IS NULL OR budget > 0),
    note       TEXT,
    created_at TEXT NOT NULL,
    CHECK (end_date >= start_date)
);

ALTER TABLE transactions ADD COLUMN event_id TEXT REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX idx_transactions_event ON transactions(event_id);

-- Своя Главная (порядок и скрытые карточки, JSON; пусто — как по умолчанию)
-- и итог недели по понедельникам.
INSERT INTO settings (key, value) VALUES
    ('home_layout', ''),
    ('weekly_summary', '1'),
    ('weekly_summary_sent', '');
