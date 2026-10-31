"""Снимок данных для проверки обновления: база budget.db и папка сохранности.

snap.py seed <db>                    — добавить в старую базу счёт-метку
snap.py take <db> <vault> <out.json> — записать снимок
snap.py compare <before> <after>     — сравнить, выход 1 при потере данных
"""
import hashlib, json, os, sqlite3, sys
from datetime import datetime, timezone

MARK = ("upgrade-check", "Проверка обновления", 1234567)


def seed(db):
    con = sqlite3.connect(db)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    con.execute(
        "INSERT INTO accounts (id, name, type, currency_code, opening_balance, opening_date, created_at, updated_at)"
        " VALUES (?, ?, 'cash', 'RUB', ?, ?, ?, ?)",
        (MARK[0], MARK[1], MARK[2], now[:10], now, now),
    )
    con.commit()
    con.close()


def take(db, vault, out):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    snap = {
        "integrity": con.execute("PRAGMA integrity_check").fetchone()[0],
        "user_version": con.execute("PRAGMA user_version").fetchone()[0],
        "mark": con.execute("SELECT id, name, opening_balance FROM accounts WHERE id = ?", (MARK[0],)).fetchone(),
        "tables": {},
        "vault": {},
    }
    for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        rows = sorted(repr(r) for r in con.execute(f'SELECT * FROM "{t}"'))
        snap["tables"][t] = [len(rows), hashlib.sha256("\n".join(rows).encode()).hexdigest()[:16]]
    con.close()
    if os.path.isdir(vault):
        for root, _, files in os.walk(vault):
            for f in files:
                p = os.path.join(root, f)
                snap["vault"][os.path.relpath(p, vault)] = hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    json.dump(snap, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in snap.items() if k != "tables"}, ensure_ascii=False))
    print("таблиц:", len(snap["tables"]), "строк:", sum(v[0] for v in snap["tables"].values()))


def compare(a, b):
    a = json.load(open(a, encoding="utf-8")); b = json.load(open(b, encoding="utf-8"))
    fail = []
    if b["integrity"] != "ok": fail.append(f"integrity_check: {b['integrity']}")
    if b["mark"] != a["mark"] or a["mark"] is None: fail.append(f"счёт-метка: было {a['mark']}, стало {b['mark']}")
    if b["user_version"] < a["user_version"]: fail.append("версия схемы уменьшилась")
    for t, (n, h) in a["tables"].items():
        nb, hb = b["tables"].get(t, [None, None])
        if nb is None: fail.append(f"пропала таблица {t}")
        elif nb < n: fail.append(f"{t}: строк было {n}, стало {nb}")
        elif hb != h: print(f"  изменилась таблица {t}: {n} → {nb} строк (запуск программы может её обновлять)")
    # Копии неизменны всегда. Текущий файл и Excel программа перезаписывает при выходе
    # (тогда же появляется новая копия), поэтому для них проверяется только наличие.
    for f, h in a["vault"].items():
        hb = b["vault"].get(f)
        if hb is None: fail.append(f"папка сохранности: пропал {f}")
        elif hb != h:
            if f.startswith(("Копии", "Копии\\", "Копии/")): fail.append(f"папка сохранности: изменена копия {f}")
            else: print(f"  обновлён при выходе программы: {f}")
    for f in b["vault"].keys() - a["vault"].keys(): print(f"  новый файл: {f}")
    print("в папке сохранности было файлов:", len(a["vault"]), "стало:", len(b["vault"]))
    for x in fail: print(f"::error::{x}")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    {"seed": seed, "take": take, "compare": compare}[sys.argv[1]](*sys.argv[2:])
