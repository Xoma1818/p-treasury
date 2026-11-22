-- Явный выбор для одной валюты имеет приоритет над старым скрытием получателя.
CREATE TABLE subscription_visibility (
    payee TEXT NOT NULL,
    currency_code TEXT NOT NULL REFERENCES currencies(code),
    hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
    PRIMARY KEY (payee, currency_code)
);

-- Старые отметки напоминаний остаются действительны до даты платежа.
INSERT INTO settings (key, value) VALUES ('subs_notified_by_currency', '{}')
ON CONFLICT(key) DO NOTHING;
