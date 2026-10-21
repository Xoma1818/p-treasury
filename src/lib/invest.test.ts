import { describe, expect, it } from "vitest";
import { leftToSave, projectGrowth, tenthsText } from "./invest";

describe("projectGrowth", () => {
  it("без доходности стоимость равна вложенному", () => {
    const rows = projectGrowth({ start: 100_000_00, monthly: 10_000_00, ratePct: 0, years: 2, iis: false });
    expect(rows).toEqual([
      { year: 1, invested: 220_000_00, deductions: 0, value: 220_000_00 },
      { year: 2, invested: 340_000_00, deductions: 0, value: 340_000_00 },
    ]);
  });

  it("годовая доходность начисляется за год ровно один раз", () => {
    const [row] = projectGrowth({ start: 100_000_00, monthly: 0, ratePct: 12, years: 1, iis: false });
    expect(row.value).toBe(112_000_00);
  });

  it("вычет ИИС с лимитом докладывается со следующего года", () => {
    const rows = projectGrowth({ start: 0, monthly: 50_000_00, ratePct: 0, years: 2, iis: true });
    // Взносы 600 000 ₽ в год, вычет только с 400 000 ₽ — 52 000 ₽.
    expect(rows[0].deductions).toBe(0);
    expect(rows[1].deductions).toBe(52_000_00);
    expect(rows[1].value).toBe(1_200_000_00 + 52_000_00);
  });

  it("сроки ограничены разумными пределами", () => {
    expect(projectGrowth({ start: 0, monthly: 1, ratePct: 5, years: -3, iis: false })).toEqual([]);
    expect(projectGrowth({ start: 0, monthly: 1, ratePct: 5, years: 500, iis: false })).toHaveLength(50);
  });
});

describe("подписи", () => {
  it("десятые процента", () => {
    expect(tenthsText(67)).toBe("6,7");
    expect(tenthsText(67, true)).toBe("+6,7");
    expect(tenthsText(-125, true)).toBe("−12,5");
    expect(tenthsText(0, true)).toBe("0,0");
  });

  it("сколько осталось отложить", () => {
    expect(leftToSave(20_000_00, 15_000_00)).toBe(5_000_00);
    expect(leftToSave(20_000_00, 25_000_00)).toBe(0);
    expect(leftToSave(20_000_00, -1_000_00)).toBe(20_000_00);
    expect(leftToSave(null, 0)).toBe(0);
  });
});
