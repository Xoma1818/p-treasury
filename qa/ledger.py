"""Build or verify a disposable stress ledger. The opening seven rows come from the pinned updater fixture."""
import datetime as dt
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(sys.argv[2]).resolve(strict=True)
DB = ROOT / "budget.db"
EVIDENCE = Path(sys.argv[3]).resolve(strict=True)
CARD, CASH, USD, SALARY, GOODS = (
    f"019a0000-0000-7000-8000-{n:012d}" for n in (1, 2, 3, 10, 11)
)
EXPECTED_FILE = EVIDENCE / "expected.json"


def journal_digest(db):
    h = hashlib.sha256()
    for row in db.execute("SELECT * FROM transactions ORDER BY id"):
        h.update(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def independent_balances(db):
    balances = dict(db.execute("SELECT id,opening_balance FROM accounts"))
    for kind, source, debit, dest, credit in db.execute(
        "SELECT type,account_id,amount,to_account_id,to_amount FROM transactions WHERE status='cleared'"
    ):
        balances[source] += debit if kind in ("income", "adjustment") else -debit
        if kind == "transfer":
            balances[dest] += credit
    return balances


def verify(db, expected):
    assert db.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
    assert db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == expected["count"]
    assert independent_balances(db) == expected["balances"]
    assert journal_digest(db) == expected["digest"]


if sys.argv[1] == "seed":
    with sqlite3.connect(DB.resolve(strict=True).as_uri() + "?mode=rw", uri=True) as db:
        assert db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 7
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("UPDATE accounts SET opening_date='2014-12-31'")
        balances = {CARD: 1973456, CASH: 43211, USD: 5775}
        db.execute("INSERT INTO exchange_rates(date,from_code,to_code,rate,source) VALUES ('2014-12-31','USD','RUB','90','manual')")
        n = 0
        for day in range(4000):
            date = (dt.date(2015, 1, 1) + dt.timedelta(days=day)).isoformat()
            rows = []
            for slot in range(40):
                n += 1
                residue = slot % 10
                amount = 150_000 + n % 27_017 if residue == 0 else 75 + n % 1237
                source = CARD if residue in (0, 1, 4, 5, 6) else USD if residue in (2, 3) else CASH
                kind = "transfer" if residue == 1 else "income" if residue in (0, 3) else "expense"
                dest, credit = (CASH, amount) if kind == "transfer" else (None, None)
                category = None if dest else SALARY if kind == "income" else GOODS
                balances[source] += amount if kind == "income" else -amount
                if dest:
                    balances[dest] += credit
                rows.append((f"01880000-0000-7000-8000-{n:012d}",kind,date,source,amount,category,dest,credit,"Учебная нагрузка",date+"T12:00:00Z",date+"T12:00:00Z"))
            db.executemany("INSERT INTO transactions(id,type,date,account_id,amount,category_id,to_account_id,to_amount,payee,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
        expected = {"count": 7+n, "balances": balances, "digest": journal_digest(db),
                    "totalRubMinor": balances[CARD] + balances[CASH] + 90*balances[USD],
                    "card": CARD, "category": GOODS}
        verify(db, expected)
        EXPECTED_FILE.write_text(json.dumps(expected, indent=2), encoding="utf-8")
        print("Independent baseline", expected)
elif sys.argv[1] == "verify":
    expected = json.loads(EXPECTED_FILE.read_text(encoding="utf-8"))
    with sqlite3.connect(DB.resolve(strict=True).as_uri() + "?mode=ro", uri=True) as db:
        verify(db, expected)
        evidence = {"finalTransactions":expected["count"], "balances":independent_balances(db),
                    "orderedTransactionHash":journal_digest(db), "integrity":"ok", "foreignKeyViolations":0}
        (EVIDENCE / "sqlite-after.json").write_text(json.dumps(evidence,indent=2), encoding="utf-8")
        print("Independent final ledger", evidence)
else:
    raise ValueError("Expected seed or verify")
