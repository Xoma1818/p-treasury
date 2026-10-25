-- 0.16 «Быстрые победы» (docs/product/0.16-quick-wins.md).
--
-- ВНИМАНИЕ: представление txn_by_month ниже перечисляет столбцы transactions
-- явно. Миграция, которая удаляет или переименовывает столбец transactions,
-- должна пересоздать и это представление, иначе база не откроется.

-- Г3. Разбивка чека: части — обычные расходы с общим идентификатором разбивки.
ALTER TABLE transactions ADD COLUMN split_id TEXT;
CREATE INDEX idx_transactions_split ON transactions(split_id) WHERE split_id IS NOT NULL;

-- Г3. Трата на несколько месяцев: баланс счёта меняется в день траты, а в
-- месячных расчётах расходов трата делится на N частей (только расходы).
ALTER TABLE transactions ADD COLUMN spread_months INTEGER
    CHECK (spread_months IS NULL OR spread_months BETWEEN 2 AND 24);
CREATE INDEX idx_transactions_spread ON transactions(spread_months) WHERE spread_months IS NOT NULL;

-- Номера частей 0..23 для представления ниже.
CREATE TABLE spread_steps (k INTEGER PRIMARY KEY);
WITH RECURSIVE s(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM s WHERE k < 23)
INSERT INTO spread_steps (k) SELECT k FROM s;

-- Операции «по месяцам учёта»: обычная операция — одной строкой как есть,
-- трата на N месяцев — N строками. Дата части k — та же дата через k месяцев
-- (31-е в коротком месяце — последний день), сумма — amount / N, копейки от
-- деления уходят в первую часть. Колонки совпадают с transactions, поэтому
-- запросы месячных сумм читают отсюда вместо transactions без других правок.
-- txn_date — настоящая дата операции, part — номер части.
CREATE VIEW txn_by_month AS
SELECT t.id, t.type, t.date, t.date AS txn_date, t.account_id, t.amount, t.category_id,
       t.to_account_id, t.to_amount, t.payee, t.note, t.recurring_rule_id, t.debt_id, t.status,
       t.event_id, t.split_id, t.spread_months, 0 AS part
FROM transactions t
WHERE t.spread_months IS NULL
UNION ALL
SELECT t.id, t.type,
       min(date(t.date, 'start of month', '+' || s.k || ' months',
                '+' || (CAST(strftime('%d', t.date) AS INTEGER) - 1) || ' days'),
           date(t.date, 'start of month', '+' || (s.k + 1) || ' months', '-1 day')),
       t.date, t.account_id,
       CASE WHEN s.k = 0 THEN t.amount - (t.amount / t.spread_months) * (t.spread_months - 1)
            ELSE t.amount / t.spread_months END,
       t.category_id, t.to_account_id, t.to_amount, t.payee, t.note, t.recurring_rule_id,
       t.debt_id, t.status, t.event_id, t.split_id, t.spread_months, s.k
FROM transactions t
JOIN spread_steps s ON s.k < t.spread_months
WHERE t.spread_months IS NOT NULL;

-- Г6. Теги: таблицы tags и transaction_tags есть с 0001; поиск операций по тегу.
CREATE INDEX idx_transaction_tags_tag ON transaction_tags(tag_id);

-- А1. Предупреждения о бюджете: какой порог (80 или 100 %) по какой категории
-- в каком бюджетном месяце уже показан. Не повторяется после перезапуска.
CREATE TABLE budget_alerts (
    month       TEXT NOT NULL,
    category_id TEXT NOT NULL,
    level       INTEGER NOT NULL CHECK (level IN (80, 100)),
    notified_at TEXT NOT NULL,
    PRIMARY KEY (month, category_id, level)
);

-- А3. «Всё в порядке» у странного списания: стабильный ключ строки «Проверьте».
CREATE TABLE check_dismissed (
    key        TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('budget_alerts', '1');
