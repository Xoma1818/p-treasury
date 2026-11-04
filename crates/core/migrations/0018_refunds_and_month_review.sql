-- 0.29 «Возвраты и итоги месяца» (docs/product/0.29-refunds-and-month-review.md).
--
-- Возврат — приход денег на счёт (type = 'income', баланс растёт), но в
-- бюджете и отчётах это минус расход своей категории (категория расходов
-- исходной покупки). refund_of — исходный расход, count_date — дата, по
-- которой возврат попадает в бюджетный месяц: дата покупки (по умолчанию) или
-- NULL — по дате самого возврата.
ALTER TABLE transactions ADD COLUMN refund INTEGER NOT NULL DEFAULT 0 CHECK (refund IN (0, 1));
ALTER TABLE transactions ADD COLUMN refund_of TEXT REFERENCES transactions(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN count_date TEXT;
CREATE INDEX idx_transactions_refund_of ON transactions(refund_of) WHERE refund_of IS NOT NULL;

-- В txn_by_month возврат идёт расходом с минусом в своём месяце, поэтому
-- бюджет, отчёты, прогноз и «Как посчитано» вычитают его сами. Столбцы те же,
-- что в 0010 (см. предупреждение там).
DROP VIEW txn_by_month;
CREATE VIEW txn_by_month AS
SELECT t.id, CASE WHEN t.refund = 1 THEN 'expense' ELSE t.type END AS type,
       CASE WHEN t.refund = 1 THEN coalesce(t.count_date, t.date) ELSE t.date END AS date,
       t.date AS txn_date, t.account_id,
       CASE WHEN t.refund = 1 THEN -t.amount ELSE t.amount END AS amount, t.category_id,
       t.to_account_id, t.to_amount, t.payee, t.note, t.recurring_rule_id, t.debt_id, t.status,
       t.event_id, t.split_id, t.spread_months, 0 AS part
FROM transactions t
WHERE t.spread_months IS NULL
UNION ALL
SELECT g.id, g.type,
       min(date(g.pk, '+' || CAST(julianday(g.date) - julianday(g.p0) AS INTEGER) || ' days'),
           date(g.pk1, '-1 day')),
       g.date, g.account_id,
       CASE WHEN g.k = 0 THEN g.amount - (g.amount / g.spread_months) * (g.spread_months - 1)
            ELSE g.amount / g.spread_months END,
       g.category_id, g.to_account_id, g.to_amount, g.payee, g.note, g.recurring_rule_id,
       g.debt_id, g.status, g.event_id, g.split_id, g.spread_months, g.k
FROM (
    SELECT b.*,
           min(date(b.base, '+' || (b.sd - 1) || ' days'),
               date(b.base, '+1 month', '-1 day')) AS p0,
           min(date(b.base, '+' || b.k || ' months', '+' || (b.sd - 1) || ' days'),
               date(b.base, '+' || (b.k + 1) || ' months', '-1 day')) AS pk,
           min(date(b.base, '+' || (b.k + 1) || ' months', '+' || (b.sd - 1) || ' days'),
               date(b.base, '+' || (b.k + 2) || ' months', '-1 day')) AS pk1
    FROM (
        SELECT a.*,
               CASE WHEN a.date >= min(date(a.date, 'start of month', '+' || (a.sd - 1) || ' days'),
                                       date(a.date, 'start of month', '+1 month', '-1 day'))
                    THEN date(a.date, 'start of month')
                    ELSE date(a.date, 'start of month', '-1 month') END AS base
        FROM (
            SELECT t.*, s.k,
                   max(1, min(31, coalesce((SELECT CAST(value AS INTEGER) FROM settings
                                            WHERE key = 'month_start_day'), 1))) AS sd
            FROM transactions t
            JOIN spread_steps s ON s.k < t.spread_months
            WHERE t.spread_months IS NOT NULL
        ) a
    ) b
) g;

-- Итоги месяца. forecast_* — прогноз доходов и расходов месяца, запомненный
-- до его начала (или в первый день работы программы в этом месяце);
-- closed_at — когда пользователь отметил «Месяц завершён».
CREATE TABLE month_reviews (
    month            TEXT PRIMARY KEY,
    forecast_income  INTEGER,
    forecast_expense INTEGER,
    forecast_at      TEXT,
    forecast_partial INTEGER NOT NULL DEFAULT 0 CHECK (forecast_partial IN (0, 1)),
    closed_at        TEXT,
    note             TEXT
);
