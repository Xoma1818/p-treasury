import { describe, expect, it } from "vitest";
import type { BackupStatus, CurrentRate, VaultStatus } from "./api";
import { backupRow, ratesRow, uncategorizedRow, when } from "./dataStatus";

const fmt = (d: string) => d.split("-").reverse().join(".");
const TODAY = "2026-11-06";

const backup = (o: Partial<BackupStatus> = {}): BackupStatus => ({ lastBackupAt: null, autobackupDir: "", autobackupKeep: "10", reminderDue: false, defaultName: "x.db", ...o });
const vault = (o: Partial<VaultStatus> = {}): VaultStatus =>
  ({ on: true, dir: "", defaultDir: "", custom: false, syncedAt: null, error: null, keep: "10", verified: null, verifyError: null, ...o }) as VaultStatus;
const rate = (code: string, r: string | null, date: string | null): CurrentRate => ({ code, rate: r, date, source: r ? "cbr" : null });

describe("состояние данных: копия", () => {
  it("свежая проверенная копия — в порядке, время местное", () => {
    const row = backupRow(backup(), vault({ syncedAt: "2026-11-06T10:15", verified: { checkedAt: "2026-11-06T10:15" } as VaultStatus["verified"] }), TODAY, fmt)!;
    expect(row.level).toBe("ok");
    expect(row.text).toBe("Копия: сегодня в 10:15, восстановление проверено");
  });
  it("берёт самую свежую из ручной копии и папки сохранности", () => {
    const row = backupRow(backup({ lastBackupAt: "2026-11-05T09:00" }), vault({ syncedAt: "2026-11-01T09:00" }), TODAY, fmt)!;
    expect(row.text).toBe("Копия: вчера в 09:00");
  });
  it("нет копии, давняя копия и неудачная проверка — внимание", () => {
    expect(backupRow(backup(), vault(), TODAY, fmt)!.level).toBe("warn");
    expect(backupRow(backup({ lastBackupAt: "2026-09-01T09:00", reminderDue: true }), vault({ on: false }), TODAY, fmt)!.text).toBe("Копия: 01.09.2026 в 09:00, больше месяца назад");
    expect(backupRow(backup({ lastBackupAt: "2026-11-06T09:00" }), vault({ verifyError: "битый файл" }), TODAY, fmt)!.level).toBe("warn");
  });
  it("пока сведения не загрузились — строки нет", () => {
    expect(backupRow(undefined, vault(), TODAY, fmt)).toBeNull();
  });
});

describe("состояние данных: курсы", () => {
  it("без валютных счетов курсы не нужны", () => {
    expect(ratesRow([], undefined, null, true, TODAY, fmt)).toEqual({ key: "rates", level: "ok", text: "Курсы: счетов в других валютах нет" });
  });
  it("смотрит только валюты счетов", () => {
    const rates = [rate("USD", "90", "2026-11-06"), rate("CNY", null, null)];
    expect(ratesRow(["USD"], rates, "2026-11-06T09:30", true, TODAY, fmt)!.text).toBe("Курсы ЦБ: проверены сегодня в 09:30");
  });
  it("нет курса — внимание с перечнем валют", () => {
    const row = ratesRow(["USD", "KZT"], [rate("USD", "90", "2026-11-06"), rate("KZT", null, null)], null, true, TODAY, fmt)!;
    expect(row.level).toBe("warn");
    expect(row.text).toContain("Нет курса: KZT");
  });
  it("курс старше недели — давно не обновлялся", () => {
    const row = ratesRow(["USD", "EUR"], [rate("USD", "90", "2026-10-20"), rate("EUR", "100", "2026-11-05")], "2026-11-06T09:30", true, TODAY, fmt)!;
    expect(row).toEqual({ key: "rates", level: "warn", text: "Курс USD от 20.10.2026 — давно не обновлялся" });
  });
  it("выходные не делают курс давним", () => {
    expect(ratesRow(["USD"], [rate("USD", "90", "2026-11-01")], null, true, TODAY, fmt)!.level).toBe("ok");
  });
  it("ручные курсы без автозагрузки — дата последнего", () => {
    expect(ratesRow(["USD"], [rate("USD", "90", "2026-11-03")], null, false, TODAY, fmt)!.text).toBe("Курсы: вводятся вручную, последний от 03.11.2026");
  });
});

describe("состояние данных: без категории", () => {
  it("ноль — в порядке, иначе число", () => {
    expect(uncategorizedRow(0)!.level).toBe("ok");
    expect(uncategorizedRow(3)).toEqual({ key: "uncategorized", level: "warn", text: "Без категории в этом месяце: 3" });
    expect(uncategorizedRow(undefined)).toBeNull();
  });
});

describe("when", () => {
  it("сегодня, вчера и дата", () => {
    expect(when("2026-11-06T08:05", TODAY, fmt)).toBe("сегодня в 08:05");
    expect(when("2026-11-05T23:59", TODAY, fmt)).toBe("вчера в 23:59");
    expect(when("2026-10-30T12:00", TODAY, fmt)).toBe("30.10.2026 в 12:00");
  });
});
