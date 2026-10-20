import { describe, expect, it } from "vitest";
import type { CompareRow } from "./api";
import { barWidth, formatChange, isBetter, splitRows } from "./compare";

const row = (name: string, a: number, b: number): CompareRow => ({
  key: name,
  name,
  a,
  b,
  diff: b - a,
  percent: a ? Math.round(((b - a) / a) * 100) : null,
  presence: a && b ? "both" : a ? "onlyA" : "onlyB",
  children: [],
});

describe("сравнение периодов", () => {
  it("делит позиции на «больше», «меньше» и «без изменений» по силе изменения", () => {
    const s = splitRows([row("Кафе", 400, 300), row("Продукты", 1000, 1250), row("Аптека", 0, 150), row("Связь", 50, 50), row("Такси", 200, 0)]);
    expect(s.up.map((r) => r.name)).toEqual(["Продукты", "Аптека"]);
    expect(s.down.map((r) => r.name)).toEqual(["Такси", "Кафе"]);
    expect(s.same.map((r) => r.name)).toEqual(["Связь"]);
  });

  it("пишет изменение в процентах со знаком, новое — словом", () => {
    expect(formatChange(25)).toBe("+25 %");
    expect(formatChange(-25)).toBe("−25 %");
    expect(formatChange(0)).toBe("0 %");
    expect(formatChange(null)).toBe("новое");
  });

  it("для расходов хорошо, когда меньше, для доходов — когда больше", () => {
    expect(isBetter("expense", -100)).toBe(true);
    expect(isBetter("expense", 100)).toBe(false);
    expect(isBetter("income", 100)).toBe(true);
  });

  it("полоска пропорциональна изменению, малая всё равно видна", () => {
    expect(barWidth(-500, 1000)).toBe(50);
    expect(barWidth(1, 100000)).toBe(1.5);
    expect(barWidth(0, 1000)).toBe(0);
  });
});
