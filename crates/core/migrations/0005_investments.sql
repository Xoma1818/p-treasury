-- Обновление 0.11: раздел «Инвестиции» (инвест-копилка).

-- Вид инвестиционного счёта: обычный брокерский, ИИС или ПДС
-- (программа долгосрочных сбережений). У других счетов пусто.
ALTER TABLE accounts ADD COLUMN invest_kind TEXT
    CHECK (invest_kind IS NULL OR invest_kind IN ('broker', 'iis', 'pds'));

-- Сколько стоит инвестиционный счёт на дату (цифра из приложения брокера).
-- Разница со вложенным — результат инвестиций, он не попадает в доходы и расходы.
CREATE TABLE account_values (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    value      INTEGER NOT NULL CHECK (value >= 0),
    PRIMARY KEY (account_id, date)
);

-- План откладывать на инвестиции каждый месяц: '' — не задан,
-- 'amount' — сумма в основной валюте, 'percent' — процент от доходов месяца.
INSERT INTO settings (key, value) VALUES
    ('invest_plan_mode', ''),
    ('invest_plan_value', '0');

-- План на один месяц вместо общего (например, премия → отложить больше);
-- mode = '' — в этом месяце не откладывать.
CREATE TABLE invest_month_plans (
    month TEXT PRIMARY KEY,
    mode  TEXT NOT NULL CHECK (mode IN ('', 'amount', 'percent')),
    value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0)
);

-- Категория дохода «Дивиденды и купоны» для тех, у кого набор категорий уже есть
-- (новым пользователям она приходит в наборе по умолчанию).
INSERT INTO categories (id, name, kind, sort_order, created_at, updated_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-'
             || hex(randomblob(2)) || '-' || hex(randomblob(6))),
       'Дивиденды и купоны', 'income',
       (SELECT COALESCE(max(sort_order) + 1, 0) FROM categories),
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE EXISTS (SELECT 1 FROM categories)
  AND NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Дивиденды и купоны' AND kind = 'income');
