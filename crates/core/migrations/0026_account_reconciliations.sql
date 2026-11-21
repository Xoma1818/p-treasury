-- Отметка сверки относится к счёту и дате выписки, а не к статусу операций.
CREATE TABLE account_reconciliations (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    statement_date TEXT NOT NULL,
    balance INTEGER NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY (account_id, statement_date)
);
