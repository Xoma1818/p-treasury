import { describe, expect, it } from "vitest";
import { formatAmount, formatMoney } from "./money";

const nb = " ";

describe("formatAmount", () => {
  it("совпадает с форматом ядра", () => {
    expect(formatAmount(123_456, 2, false)).toBe(`1${nb}234,56`);
    expect(formatAmount(1_497_700)).toBe(`14${nb}977`);
    expect(formatAmount(1_497_723)).toBe(`14${nb}977,23`);
    expect(formatAmount(-35_000)).toBe("−350");
    expect(formatAmount(5, 2, false)).toBe("0,05");
    expect(formatAmount(30_000_000, 0)).toBe(`30${nb}000${nb}000`);
    expect(formatAmount(0)).toBe("0");
  });

  it("не принимает дробные числа", () => {
    expect(() => formatAmount(10.5)).toThrow();
  });
});

describe("formatMoney", () => {
  it("добавляет символ валюты", () => {
    expect(formatMoney(1_497_723, "₽")).toBe(`14${nb}977,23${nb}₽`);
  });
});

import { parseAmount, amountToInput } from "./money";

describe("parseAmount", () => {
  it("совпадает с разбором в ядре", () => {
    expect(parseAmount("1234")).toBe(123_400);
    expect(parseAmount("1 234,56")).toBe(123_456);
    expect(parseAmount("1 234.5")).toBe(123_450);
    expect(parseAmount(",5")).toBe(50);
    expect(parseAmount("-50")).toBe(-5_000);
    expect(parseAmount("1500", 0)).toBe(1_500);
  });

  it("ошибки ввода", () => {
    for (const bad of ["", " ", "-", "abc", "12,345", "1,2,3", "1e5", ","]) {
      expect(parseAmount(bad), bad).toBeNull();
    }
    expect(parseAmount("10,5", 0)).toBeNull();
    expect(parseAmount("99999999999999999999")).toBeNull();
  });

  it("обратимо с amountToInput", () => {
    for (const v of [0, 5, 123_456, -987_650]) {
      expect(parseAmount(amountToInput(v))).toBe(v);
    }
  });
});
