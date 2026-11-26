-- У старого плана неизвестна валюта на момент ввода. До подтверждения
-- исходное целое остаётся без валюты. Общий план хранит свой код в settings.
ALTER TABLE invest_month_plans ADD COLUMN currency_code TEXT REFERENCES currencies(code)
    CHECK (currency_code IS NULL OR mode = 'amount');

-- Найти прямую или обратную котировку пары среди многолетней истории.
CREATE INDEX idx_exchange_rates_pair_date ON exchange_rates(from_code, to_code, date);
