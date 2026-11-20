import { describe, expect, it } from "vitest";
import type { ImportRow } from "./api";
import { importRowExplanation } from "./importRowExplanation";

function row(fields: Partial<ImportRow> = {}): ImportRow {
  return {
    line: 2,
    date: "2026-11-18",
    type: "Расход",
    account: "Карта",
    amount: "1000",
    category: "Продукты",
    payee: "Магазин",
    error: null,
    duplicate: false,
    linkedTo: null,
    maybe: 0,
    toTransfer: false,
    ...fields,
  };
}

describe("пояснения в предпросмотре импорта", () => {
  it("различает повтор и вторую сторону банковского перевода", () => {
    const secondSide = row({
      duplicate: true,
      type: "Перевод",
      category: "вторая сторона строки 3",
    });

    expect(importRowExplanation(secondSide, true)).toContain("из строки №3");
    expect(importRowExplanation(secondSide, true)).toContain("операцию не добавим");
    expect(importRowExplanation(secondSide, false)).toContain("Распознано как повтор");
    expect(importRowExplanation(row({ duplicate: true, type: "Возврат" }), true))
      .toContain("операцию не добавим");
  });

  it("показывает связанную запись только когда её нашло ядро", () => {
    expect(importRowExplanation(row({ linkedTo: "19.10 · Питание" }), true))
      .toContain("19.10 · Питание");
    expect(importRowExplanation(row({ maybe: 2 }), true)).toContain("Возможные совпадения: 2");
    expect(importRowExplanation(row({ type: "возврат" }), false))
      .toBe("Запишем как возврат покупки.");
  });
});
