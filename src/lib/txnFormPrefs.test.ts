import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, isDefaultForm, newTxnDate, parseForm, preferredAccount } from "./txnFormPrefs";

describe("Г9: настройка формы операции", () => {
  it("испорченное значение — форма как была", () => {
    expect(parseForm(null)).toEqual(DEFAULT_FORM);
    expect(parseForm("[")).toEqual(DEFAULT_FORM);
    expect(isDefaultForm(parseForm('{"date":"x","account":""}'))).toBe(true);
  });

  it("закреплённые поля и дата «как в прошлой» читаются", () => {
    const p = parseForm(JSON.stringify({ pinNote: true, pinTags: true, account: "a1", date: "last" }));
    expect(p).toEqual({ pinNote: true, pinTags: true, account: "a1", date: "last" });
    expect(isDefaultForm(p)).toBe(false);
  });

  it("счёт по настройке, только если он открыт", () => {
    const p = parseForm(JSON.stringify({ account: "a2" }));
    expect(preferredAccount(p, [{ id: "a1" }, { id: "a2" }])).toBe("a2");
    expect(preferredAccount(p, [{ id: "a1" }])).toBeNull();
    expect(preferredAccount(DEFAULT_FORM, [{ id: "a1" }])).toBeNull();
  });

  it("дата: сегодня, если не выбрано иное или прошлой даты нет", () => {
    expect(newTxnDate(DEFAULT_FORM, "2026-11-04")).toBe("2026-11-04");
    expect(newTxnDate({ ...DEFAULT_FORM, date: "last" }, "2026-11-04")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
