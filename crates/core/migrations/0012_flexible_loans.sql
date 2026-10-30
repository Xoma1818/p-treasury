-- 0.20: гибкие займы. Ставку можно ввести за год, месяц или день: rate_bp остаётся
-- годовой (месячная × 12, дневная × 365), rate_period — как её ввели и показывают.
-- Платить можно каждый месяц, раз в квартал или раз в две недели: pay_every;
-- term_months тогда — число платежей. Уже записанные займы — годовые и ежемесячные.
ALTER TABLE debts ADD COLUMN rate_period TEXT NOT NULL DEFAULT 'year'
    CHECK (rate_period IN ('year', 'month', 'day'));
ALTER TABLE debts ADD COLUMN pay_every TEXT NOT NULL DEFAULT 'month'
    CHECK (pay_every IN ('month', 'quarter', 'two_weeks'));

-- Своя сумма строки графика: договорились заплатить больше или меньше.
-- Следующие строки пересчитываются (меньше платёж или меньше срок).
CREATE TABLE debt_row_amounts (
    id         TEXT PRIMARY KEY,
    debt_id    TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL CHECK (seq >= 1),
    amount     INTEGER NOT NULL CHECK (amount >= 0),
    mode       TEXT NOT NULL CHECK (mode IN ('reduce_payment', 'reduce_term')),
    created_at TEXT NOT NULL,
    UNIQUE (debt_id, seq)
);
CREATE INDEX idx_debt_row_amounts_debt ON debt_row_amounts(debt_id);
