-- Подсказки для целей с ручными пополнениями. У прежних целей режим выключен.
ALTER TABLE goals ADD COLUMN funding_mode TEXT
    CHECK (funding_mode IS NULL OR (
        funding_mode IN ('monthly', 'refill') AND (account_id IS NULL OR reserve = 1)
    ));
ALTER TABLE goals ADD COLUMN monthly_amount INTEGER
    CHECK (
        (funding_mode IS 'monthly' AND typeof(monthly_amount) = 'integer' AND monthly_amount > 0)
        OR (funding_mode IS NOT 'monthly' AND monthly_amount IS NULL)
    );
