"""Read-only acceptance check for the installed Kazna 0.42.1 → 0.42.8 upgrade."""

import argparse
from contextlib import closing
from pathlib import Path
import sqlite3


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def verify(db):
    for schema, version in (("original", 31), ("saved", 31), ("candidate", 32)):
        if db.execute(f"PRAGMA {schema}.user_version").fetchone() != (version,):
            raise ValueError(f"{schema}: ожидалась версия схемы {version}")
        if db.execute(f"PRAGMA {schema}.integrity_check").fetchall() != [("ok",)]:
            raise ValueError(f"{schema}: нарушена целостность SQLite")
        if db.execute(f"PRAGMA {schema}.foreign_key_check").fetchone() is not None:
            raise ValueError(f"{schema}: нарушены внешние ключи")

    def tables(schema):
        return {name for name, in db.execute(
            "SELECT name FROM pragma_table_list WHERE schema=? AND type='table' "
            "AND substr(name,1,7) <> 'sqlite_'", (schema,)
        )}

    def columns(schema, table):
        return [row[1] for row in db.execute(f"PRAGMA {schema}.table_info({quoted(table)})")]

    names = tables("original")
    if not {"accounts", "settings", "transactions", "invest_month_plans"} <= names:
        raise ValueError("Отсутствуют таблицы учебного бюджета")
    if not db.execute("SELECT 1 FROM original.transactions LIMIT 1").fetchone():
        raise ValueError("В исходной базе нет учебной операции")
    if db.execute("SELECT value FROM original.settings WHERE key='invest_plan_mode'").fetchone() != ("amount",):
        raise ValueError("В исходной базе нужен общий инвестплан фиксированной суммой")
    if not db.execute("SELECT 1 FROM original.invest_month_plans WHERE mode='amount' LIMIT 1").fetchone():
        raise ValueError("В исходной базе нужен отдельный фиксированный план месяца")

    for schema in ("saved", "candidate"):
        if tables(schema) != names:
            raise ValueError(f"{schema}: изменился состав таблиц с данными")
        for table in sorted(names):
            old_columns = columns("original", table)
            expected = old_columns + (["currency_code"] if (schema, table) == ("candidate", "invest_month_plans") else [])
            if columns(schema, table) != expected:
                raise ValueError(f"{schema}.{table}: неожиданный состав полей")
            # GROUP BY со счётчиком обнаруживает и потерю дублирующейся строки.
            fields = ", ".join(f"{quoted(c)} COLLATE BINARY" for c in old_columns)
            def grouped(side):
                return f"SELECT {fields}, count(*) FROM {side}.{quoted(table)} GROUP BY {fields}"
            for left, right in (("original", schema), (schema, "original")):
                if db.execute(f"{grouped(left)} EXCEPT {grouped(right)} LIMIT 1").fetchone():
                    raise ValueError(f"{schema}.{table}: различаются исходные строки")
    if db.execute("SELECT 1 FROM candidate.invest_month_plans WHERE currency_code IS NOT NULL LIMIT 1").fetchone():
        raise ValueError("Миграция назначила валюту месячному плану до подтверждения")
    print(f"Совпали данные {len(names)} таблиц в предмиграционной копии и рабочей базе. Схема 31 → 32.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("before", "after", "backup"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    files = [path.resolve(strict=True) for path in (args.before, args.after, args.backup)]
    if any(file.samefile(previous) for i, file in enumerate(files) for previous in files[:i]):
        raise ValueError("Укажите три разных файла")
    with closing(sqlite3.connect("file::memory:?mode=memory", uri=True)) as db:
        for name, path in zip(("original", "candidate", "saved"), files):
            db.execute(f"ATTACH DATABASE ? AS {name}", (path.as_uri() + "?mode=ro",))
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        verify(db)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, sqlite3.Error) as error:
        raise SystemExit(str(error))
