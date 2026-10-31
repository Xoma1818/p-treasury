-- 0.28 Надёжность (docs/testing/reliability-2026.md, ошибки B3 и B4).
--
-- B4. Трата на несколько месяцев при начале месяца не с 1-го числа: части
-- раскладывались по календарным месяцам, и две части могли попасть в один
-- бюджетный месяц, а соседний оставался пустым. Теперь часть k стоит в
-- бюджетном месяце «месяц траты + k» на том же расстоянии от его начала, что и
-- трата (не дальше последнего дня этого месяца). При начале с 1-го — как раньше.
-- Столбцы те же, что в 0010 (см. предупреждение там).
DROP VIEW txn_by_month;
CREATE VIEW txn_by_month AS
SELECT t.id, t.type, t.date, t.date AS txn_date, t.account_id, t.amount, t.category_id,
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

-- B3. Повторная выписка после правки загруженной операции: повтор узнавался
-- по текущим дате, сумме и получателю, и после переименования получателя
-- (или правки суммы) та же строка банка добавлялась второй раз. Теперь у
-- каждой операции импорта хранится ключ строки, как он был при загрузке.
-- У разбитого чека ключ есть у каждой части (одна операция банка).
CREATE TABLE import_keys (
    transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    account_id     TEXT NOT NULL,
    kind           TEXT NOT NULL,
    bank_date      TEXT NOT NULL,
    bank_amount    INTEGER NOT NULL,
    bank_payee     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_import_keys_bank ON import_keys(account_id, bank_date, bank_amount);

-- Уже загруженные операции: ключ — их нынешние данные (как было бы и без
-- ключа). Неизменённые после загрузки совпадают со строкой банка точно.
-- Части чеков, разбитых до 0017, ключа не получают: их узнаёт сумма частей.
INSERT INTO import_keys (transaction_id, account_id, kind, bank_date, bank_amount, bank_payee)
SELECT id, account_id, type, date, abs(amount), coalesce(payee, '')
FROM transactions
WHERE import_id IS NOT NULL AND split_id IS NULL AND type IN ('expense', 'income');
