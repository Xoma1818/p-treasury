import { describe, expect, it } from "vitest";
import type { InvestMonth } from "./api";
import { contributionPrefill, leftToSave, progressIssue, projectGrowth, rubleContribution, tenthsText } from "./invest";

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

describe("валюта инвестиционного плана", () => {
  const rub = { code: "RUB", name: "Российский рубль", symbol: "₽", minorUnits: 2 };
  const jpy = { code: "JPY", name: "Японская иена", symbol: "¥", minorUnits: 0 };
  const month: InvestMonth = {
    month: "2026-11", start: "2026-11-15", end: "2026-12-14",
    currency: rub, incomeCurrency: jpy, income: 80_000, incomeComplete: true,
    plan: { mode: "amount", value: 120_000, onlyMonth: false, currencyCode: "RUB" },
    planned: 120_000, saved: 30_000, savedComplete: true, percent: 25, missingRates: [],
  };

  it("остаток 900 ₽ и рублёвый калькулятор берут единицы исходного плана при основной валюте JPY", () => {
    expect(contributionPrefill(month)).toEqual({ amountCurrency: "RUB", amount: 90_000 });
    expect(rubleContribution(month)).toBe(120_000);
    const yen = { ...month, currency: jpy, plan: { ...month.plan, value: 1200, currencyCode: "JPY" }, planned: 1200, saved: 300 };
    expect(contributionPrefill(yen)).toEqual({ amountCurrency: "JPY", amount: 900 });
    expect(rubleContribution(yen)).toBeNull();
  });

  it("старый номинал до подтверждения не появляется в переводе или калькуляторе", () => {
    const legacy = { ...month, plan: { ...month.plan, currencyCode: null }, planned: null, percent: null };
    expect(progressIssue(legacy)).toMatch(/валюта/);
    expect(contributionPrefill(legacy).amount).toBeNull();
    expect(rubleContribution(legacy)).toBeNull();
  });

  it("предлагает восполнить снятие и выполнить весь план в его валюте", () => {
    const afterWithdrawal = { ...month, planned: 2_000_000, saved: -100_000 };
    expect(contributionPrefill(afterWithdrawal)).toEqual({ amountCurrency: "RUB", amount: 2_100_000 });
    expect(contributionPrefill({ ...afterWithdrawal, saved: 2_000_000 }).amount).toBeNull();
    expect(contributionPrefill({ ...month, planned: Number.MAX_SAFE_INTEGER, saved: -2 }).amount).toBeNull();
  });

  it("неполный факт блокирует остаток перевода, а неполный доход затрагивает только процентный план", () => {
    expect(contributionPrefill({ ...month, savedComplete: false }).amount).toBeNull();
    expect(contributionPrefill({ ...month, incomeComplete: false }).amount).toBe(90_000);
    const percentPlan = { ...month, plan: { ...month.plan, mode: "percent" as const, value: 10, currencyCode: null }, incomeComplete: false, planned: null };
    expect(progressIssue(percentPlan)).toMatch(/дохода/);
    expect(rubleContribution(percentPlan)).toBeNull();
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
    expect(leftToSave(20_000_00, -1_000_00)).toBe(21_000_00);
    expect(leftToSave(null, 0)).toBe(0);
  });
});
