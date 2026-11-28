"""Disposable SQLite fixture and independent acceptance checks for Kazna's public updater."""
from argparse import ArgumentParser
from collections import Counter
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


def uid(n):
    return f"019a0000-0000-7000-8000-{n:012d}"


CARD, CASH, USD = map(uid, (1, 2, 3))
SALARY, GOODS = map(uid, (10, 11))
PREFS = {"p-treasury-theme": "dark", "p-treasury-scale": "110", "kazna.txnOpen": "dialog",
         "kazna.look": '{"density":"compact","accent":"mint"}'}
SETTINGS = {
    "base_currency": "RUB", "month_start_day": "10", "onboarding_done": "1",
    "rates_auto": "0", "update_check": "0", "vault_on": "0", "weekly_summary": "0",
    "close_to_tray": "0", "invest_plan_mode": "amount", "invest_plan_value": "120000",
    "unusual_percent": "45", "checks_days": "60",
    "home_layout": '{"v":3,"order":["accounts","recent","tiles","quick","summary","checks","unusual","figures","trend","cushion","ahead","invest","goals","subs","days","templates","spend","plans","reminders"],"hidden":["quick","summary","checks","unusual","figures","trend","cushion","ahead","invest","goals","subs","days","templates","spend","plans","reminders"],"half":["accounts","recent"]}',
}
INITIAL_LAYOUT = '{"v":3,"order":["accounts","recent","tiles","quick","summary","checks","unusual","figures","trend","cushion","ahead","invest","goals","subs","days","templates","spend","plans","reminders"],"hidden":["quick","summary","checks","unusual","figures","trend","cushion","ahead","invest","goals","subs","days","templates","spend","plans","reminders"],"half":["accounts"]}'
ACCOUNTS = [
    (CARD, "Учебная карта Рубин", "debit", "RUB", 2000000),
    (CASH, "Учебные наличные", "cash", "RUB", 10000),
    (USD, "Учебный доллар", "debit", "USD", 5000),
]
# Absolute amounts in each respective account's minor units.
TX_FIELDS = "id,type,date,account_id,amount,category_id,to_account_id,to_amount,payee,refund,refund_of,count_date"
TX = [
    (uid(101), "income",   "2026-11-12", CARD, 123456, SALARY, None, None, "Учебный проект", 0, None, None),
    (uid(102), "expense",  "2026-11-13", CARD, 23456, GOODS, None, None, "Учебная мастерская", 0, None, None),
    (uid(103), "income",   "2026-11-14", CARD, 3456, GOODS, None, None, "Учебная мастерская", 1, uid(102), "2026-11-13"),
    (uid(104), "transfer", "2026-11-15", CARD, 90000, None, USD, 1000, None, 0, None, None),
    (uid(105), "transfer", "2026-11-16", CARD, 40000, None, CASH, 40000, None, 0, None, None),
    (uid(106), "expense",  "2026-11-17", CASH, 6789, GOODS, None, None, "Учебный рынок", 0, None, None),
    (uid(107), "expense",  "2026-11-18", USD, 225, GOODS, None, None, "Учебный каталог", 0, None, None),
]
EXPECTED_BALANCES = {CARD: 1973456, CASH: 43211, USD: 5775}
EXPECTED_FLOWS = {("expense", "RUB"): 26789, ("expense", "USD"): 225, ("income", "RUB"): 123456}
STAMP = "2026-11-18T12:00:00Z"
RATE = ("2026-11-01", "USD", "RUB", "90", "manual")


def check(actual, expected, label):
    if actual != expected:
        raise ValueError(f"{label}: expected {expected!r}, found {actual!r}")


def read_only(path):
    return sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=ro", uri=True)


def make_new(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=False)
    return sqlite3.connect(path)


def seed(repo, path):
    migrations = sorted((repo / "crates/core/migrations").glob("*.sql"))
    check([int(f.name[:4]) for f in migrations], list(range(1, 33)), "migration sequence for 0.45.0")
    with closing(make_new(path)) as db:
        db.execute("PRAGMA foreign_keys=ON")
        for version, source in enumerate(migrations, start=1):
            db.executescript("BEGIN;\n" + source.read_text(encoding="utf-8") + f"\nPRAGMA user_version={version}; COMMIT;")
        db.execute("CREATE INDEX IF NOT EXISTS idx_transactions_date_id ON transactions(date,id)")
        with db:
            # This runtime flag normally appears after the first background scan.
            # Use the same, already-initialised preferences in both versions.
            db.execute("INSERT INTO settings(key,value) VALUES('budget_alerts_seeded','1')")
            for key, value in {**SETTINGS, "home_layout": INITIAL_LAYOUT, "ui_prefs": json.dumps(PREFS, separators=(",", ":"))}.items():
                check(db.execute("UPDATE settings SET value=? WHERE key=?", (value, key)).rowcount, 1, key)
            db.execute("INSERT INTO invest_month_plans (month,mode,value,currency_code) VALUES ('2026-11','amount',34567,'USD')")
            db.execute("INSERT INTO exchange_rates (date,from_code,to_code,rate,source) VALUES (?,?,?,?,?)", RATE)
            db.executemany("INSERT INTO categories (id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?)",
                           [(SALARY, "Учебный заработок", "income", STAMP, STAMP),
                            (GOODS, "Учебные покупки", "expense", STAMP, STAMP)])
            db.executemany("INSERT INTO accounts (id,name,type,currency_code,opening_balance,opening_date,sort_order,"
                           "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                           [(*row, "2026-11-01", i, STAMP, STAMP) for i, row in enumerate(ACCOUNTS)])
            db.executemany(f"INSERT INTO transactions ({TX_FIELDS},created_at,updated_at) "
                           "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [(*row, STAMP, STAMP) for row in TX])
    print(json.dumps(inspect(path, 32, initial=True), ensure_ascii=False, indent=2))


def snapshot(source, destination):
    with closing(read_only(source)) as src, closing(make_new(destination)) as dst:
        src.backup(dst)


def inspect(path, schema, initial=False):
    with closing(read_only(path)) as db:
        db.execute("BEGIN")
        check(db.execute("PRAGMA user_version").fetchone()[0], schema, "schema")
        check(db.execute("PRAGMA integrity_check").fetchall(), [("ok",)], "integrity")
        check(db.execute("PRAGMA foreign_key_check").fetchall(), [], "foreign keys")
        accounts = db.execute("SELECT id,name,type,currency_code,opening_balance FROM accounts ORDER BY id").fetchall()
        check(accounts, ACCOUNTS, "complete account list")
        journal = db.execute(f"SELECT {TX_FIELDS} FROM transactions ORDER BY id").fetchall()
        check(journal, TX, "complete journal")
        balances = {}
        for acc, name, _, currency, opening in accounts:
            result = db.execute("""
                SELECT ? + COALESCE(SUM(CASE
                  WHEN account_id=? THEN CASE WHEN type IN ('income','adjustment') THEN amount ELSE -amount END
                  WHEN to_account_id=? AND type='transfer' THEN to_amount ELSE 0 END),0)
                FROM transactions WHERE status='cleared'""", (opening, acc, acc)).fetchone()[0]
            check(result, EXPECTED_BALANCES[acc], "balance " + name)
            balances[name] = {"currency": currency, "openingMinor": opening, "balanceMinor": result}
        rates = db.execute("SELECT date,from_code,to_code,rate,source FROM exchange_rates ORDER BY date").fetchall()
        check(rates, [RATE], "manual rate as of the transactions")
        by_currency = {(kind, currency): amount for kind, currency, amount in db.execute("""
            SELECT t.type,a.currency_code,sum(t.amount) FROM txn_by_month t JOIN accounts a ON a.id=t.account_id
            WHERE t.status='cleared' AND t.type IN ('income','expense')
              AND date(t.date) BETWEEN '2026-11-10' AND '2026-12-09'
            GROUP BY t.type,a.currency_code""")}
        check(by_currency, EXPECTED_FLOWS, "budget period net flows by source currency")
        rate = int(rates[0][3])
        expense_rub = by_currency["expense", "RUB"] + rate * by_currency["expense", "USD"]
        check(expense_rub, 47039, "net expense in RUB")
        total = sum(v["balanceMinor"] * (rate if v["currency"] == "USD" else 1) for v in balances.values())
        check(total, 2536417, "total balance in RUB")
        settings = dict(db.execute("SELECT key,value FROM settings ORDER BY key"))
        expected_settings = {**SETTINGS, "home_layout": INITIAL_LAYOUT} if initial else SETTINGS
        check({k: settings.get(k) for k in SETTINGS}, expected_settings, "witness settings")
        prefs = json.loads(settings["ui_prefs"])
        check({k: prefs.get(k) for k in PREFS}, PREFS, "window preferences mirrored in SQLite")
        plans = db.execute("SELECT month,mode,value,currency_code FROM invest_month_plans").fetchall()
        check(plans, [("2026-11", "amount", 34567, "USD")], "monthly investment plan and its saved currency")
        tables = sorted(row[0] for row in db.execute("SELECT name FROM pragma_table_list WHERE schema='main' "
                                                     "AND type='table' AND substr(name,1,7)<>'sqlite_'"))
        return {"file": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "schema": schema, "tablesCompared": len(tables), "transactionCount": len(journal), "accounts": balances,
                "journal": [dict(zip(TX_FIELDS.split(","), row)) for row in journal],
                "totalBalanceRubMinor": total, "incomeRubMinor": by_currency["income", "RUB"], "expenseRubMinor": expense_rub,
                "allSettings": settings, "uiPrefs": prefs, "foreignRate": RATE, "monthlyInvestmentPlan": plans}


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def logical_snapshot(path):
    with closing(read_only(path)) as db:
        db.execute("BEGIN")
        tables = [name for name, in db.execute("SELECT name FROM pragma_table_list WHERE schema='main' "
                                              "AND type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name")]
        return {name: (db.execute(f"PRAGMA table_xinfo({quote(name)})").fetchall(),
                       Counter(db.execute(f"SELECT * FROM {quote(name)}"))) for name in tables}


def verify(repo, before, after, backup, evidence):
    files = {"before": before, "after": after, "backup": backup}
    check(len({f.resolve(strict=True) for f in files.values()}), 3, "distinct snapshots")
    sides = {name: inspect(path, 32) for name, path in files.items()}
    original = logical_snapshot(before)
    for label in ("after", "backup"):
        check(sides[label]["allSettings"], sides["before"]["allSettings"], "all settings in " + label)
        compared = logical_snapshot(files[label])
        check(sorted(compared), sorted(original), f"{label}: application tables")
        for name, (columns, rows) in original.items():
            check(compared[name][0], columns, f"{label}.{name}: all columns")
            check(compared[name][1], rows, f"{label}.{name}: all rows, fields and multiplicities")
    sides["allTablesMatch"] = True
    with evidence.open("x", encoding="utf-8") as out:
        json.dump(sides, out, ensure_ascii=False, indent=2)
    print(f"{len(TX)} rows, 3 account balances, 2 currencies, all {len(sides['before']['allSettings'])} settings verified.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for command, params in {"seed": ["repo", "output"], "snapshot": ["source", "output"],
                            "verify": ["repo", "before", "after", "backup", "evidence"]}.items():
        sub = commands.add_parser(command)
        for arg in params:
            sub.add_argument(arg, type=Path)
    opts = parser.parse_args()
    if opts.action == "seed":
        seed(opts.repo, opts.output)
    elif opts.action == "snapshot":
        snapshot(opts.source, opts.output)
    else:
        verify(opts.repo, opts.before, opts.after, opts.backup, opts.evidence)
