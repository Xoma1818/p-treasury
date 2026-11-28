import sqlite3, sys, uuid
from pathlib import Path
db=Path(sys.argv[1]).resolve(strict=True)
assert db.parent.name=="behaviors-budget" and db.name=="budget.db"
with sqlite3.connect(db) as con:
    con.row_factory=sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    assert con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]==7
    stamp="2026-11-17T12:00:00Z"
    for n in [102,106]:
        batch=str(uuid.uuid4())
        con.execute("INSERT INTO import_batches(id,created_at,origin,file_name,added) VALUES(?,?,'manual',?,1)",(batch,stamp,"Учебная выписка "+str(n)+".csv"))
        old=dict(con.execute("SELECT * FROM transactions WHERE id=?",("019a0000-0000-7000-8000-%012d"%n,)).fetchone())
        old_id=old["id"];old["id"]=str(uuid.uuid4());old["import_id"]=batch
        con.execute("INSERT INTO transactions("+",".join(old)+") VALUES("+",".join("?" for _ in old)+")",list(old.values()))
        con.execute("INSERT INTO import_suggestions(id,import_id,kind,new_id,old_id,created_at) VALUES(?,?,'same',?,?,?)",(str(uuid.uuid4()),batch,old["id"],old_id,stamp))
    assert con.execute("PRAGMA foreign_key_check").fetchall()==[]
