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
