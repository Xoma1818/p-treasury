import { describe, expect, it } from "vitest";
import type { Forecast, GoalMark, MoneyFlow } from "./api";
import { aheadSummary, chartPoints, describeChange, goalText, monthLine, seasonText, flowIsEmpty, flowLayout, genitive, monthsText, prepositional, presets, ribbon } from "./forecast";
import { formatMoney } from "./money";

const flow = (over: Partial<MoneyFlow>): MoneyFlow => ({
  baseCurrency: "RUB",
  currencySymbol: "₽",
  minorUnits: 2,
  period: { month: "2026-09", start: "2026-09-01", end: "2026-09-30" },
  income: [],
  expense: [],
  totalIncome: 0,
  totalExpense: 0,
  invested: 0,
  saved: 0,
  missingRates: [],
  ...over,
});

describe("подписи изменений сценария", () => {
  it("склоняет месяцы и сроки", () => {
    expect(genitive("2027-06")).toBe("июня 2027");
    expect(prepositional("2027-05")).toBe("мае 2027");
    expect([1, 2, 5, 11, 12, 21, 22].map(monthsText)).toEqual(["1 месяц", "2 месяца", "5 месяцев", "11 месяцев", "12 месяцев", "21 месяц", "22 месяца"]);
  });

  it("описывает каждое изменение по-человечески", () => {
    const base = { title: "", amount: null, percent: null, startMonth: "2027-06", months: null };
    expect(describeChange({ ...base, kind: "once", amount: -30_000_000 })).toBe(`−${formatMoney(30_000_000, "₽")} в июне 2027`);
    expect(describeChange({ ...base, kind: "monthly", amount: -4_500_000, months: 12 })).toBe(`−${formatMoney(4_500_000, "₽")} каждый месяц с июня 2027, 12 месяцев`);
    expect(describeChange({ ...base, kind: "monthly", amount: 1_000_000 })).toBe(`+${formatMoney(1_000_000, "₽")} каждый месяц с июня 2027, до конца прогноза`);
    expect(describeChange({ ...base, kind: "income_pct", percent: -100, months: 3 })).toBe("−100 % (без дохода) к доходам с июня 2027, 3 месяца");
    expect(describeChange({ ...base, kind: "expense_pct", percent: 15 })).toBe("+15 % к обычным тратам с июня 2027, до конца прогноза");
  });

  it("заготовки начинаются от первого месяца прогноза", () => {
    const p = presets("2026-11");
    expect(p.map((x) => x.change.startMonth)).toEqual(["2026-12", "2027-02", "2026-12", "2026-12", "2026-11"]);
    expect(p.find((x) => x.label === "3 месяца без зарплаты")!.change).toMatchObject({ kind: "income_pct", percent: -100, months: 3 });
  });
});

describe("график прогноза", () => {
  it("первая точка — сегодня, дальше конец каждого месяца", () => {
    const month = (m: string, closing: number, sc: number | null) => ({
      month: m, start: `${m}-01`, end: `${m}-28`, opening: 0, regularIncome: 0, regularExpense: 0, plannedIncome: 0, plannedExpense: 0, seasonIncome: 0, seasonExpense: 0,
      closing, items: [], scenario: sc == null ? null : { delta: 0, closing: sc, items: [] },
    });
    const f = { liquid: 100, scenarioId: "s", months: [month("2026-10", 150, 120), month("2026-11", 200, 90)] } as unknown as Forecast;
    expect(chartPoints(f)).toEqual([
      { label: "Сейчас", base: 100, scenario: 100 },
      { label: "Окт", base: 150, scenario: 120 },
      { label: "Ноя", base: 200, scenario: 90 },
    ]);
    expect(chartPoints({ ...f, scenarioId: null, months: [month("2026-10", 150, null)] })[0].scenario).toBeNull();
  });
});

describe("поток денег", () => {
  it("остаток уходит вправо, обе стороны равны и средняя колонка без зазоров", () => {
    const f = flow({
      income: [{ id: "a", name: "Зарплата", amount: 800 }, { id: "b", name: "Подработка", amount: 200 }],
      expense: [{ id: "c", name: "Продукты", amount: 500 }, { id: "d", name: "Кафе", amount: 200 }],
      totalIncome: 1000, totalExpense: 700, invested: 100, saved: 200,
    });
    const l = flowLayout(f, 100, 10);
    expect(l.total).toBe(1000);
    expect(l.right.map((b) => b.kind)).toEqual(["expense", "expense", "invest", "saved"]);
    expect(l.left[0]).toMatchObject({ y0: 0, m0: 0, m1: 80 });
    // Слева 2 полосы: 100 − 10 на зазор = 90 на 1000 ₽.
    expect(l.left[1].y0).toBeCloseTo(72 + 10);
    expect(l.left[1].y1).toBeCloseTo(100);
    expect(l.right[3].m1).toBeCloseTo(100);
    expect(l.right[3].y1).toBeCloseTo(100);
  });

  it("если тратили больше дохода — слева «Из накоплений», с инвестиций — «С инвестиций»", () => {
    const f = flow({
      income: [{ id: "a", name: "Зарплата", amount: 500 }],
      expense: [{ id: "c", name: "Ремонт", amount: 900 }],
      totalIncome: 500, totalExpense: 900, invested: -100, saved: -300,
    });
    const l = flowLayout(f, 90, 0);
    expect(l.left.map((b) => b.name)).toEqual(["Зарплата", "С инвестиций", "Из накоплений"]);
    expect(l.right.map((b) => b.name)).toEqual(["Ремонт"]);
    expect(l.total).toBe(900);
    expect(l.left[2].y1).toBeCloseTo(90);
  });

  it("пустой период ничего не рисует", () => {
    expect(flowIsEmpty(flow({}))).toBe(true);
    expect(flowLayout(flow({}), 100)).toEqual({ left: [], right: [], total: 0 });
  });

  it("месяц только с переводом в инвестиции не пустой: «Из накоплений» → «Инвестиции»", () => {
    const f = flow({ invested: 5000, saved: -5000 });
    expect(flowIsEmpty(f)).toBe(false);
    const l = flowLayout(f, 100, 0);
    expect(l.left.map((b) => b.name)).toEqual(["Из накоплений"]);
    expect(l.right.map((b) => b.name)).toEqual(["Инвестиции"]);
    expect(flowIsEmpty(flow({ invested: -3000, saved: 3000 }))).toBe(false);
  });

  it("лента — замкнутая кривая между двумя отрезками", () => {
    expect(ribbon(0, 0, 10, 100, 20, 30)).toBe("M0.0 0.0 C50.0 0.0 50.0 20.0 100.0 20.0 L100.0 30.0 C50.0 30.0 50.0 10.0 0.0 10.0 Z");
  });
});

describe("прогноз повсюду (0.19)", () => {
  const month = (m: string, opening: number, closing: number) => ({
    month: m, start: `${m}-01`, end: `${m}-28`, opening, regularIncome: 0, regularExpense: 0, plannedIncome: 0, plannedExpense: 0,
    seasonIncome: 0, seasonExpense: 0, closing, items: [], scenario: null,
  });
  const goal: GoalMark = { id: "g", name: "Отпуск", deadline: "2027-01-15", month: "2027-01", need: 30_000_000, closing: 36_600_000, free: 6_600_000 };
  const f = {
    liquid: 10_000_000,
    shortMonth: "2027-02",
    goals: [goal],
    months: [month("2026-10", 10_000_000, 12_000_000), month("2026-11", 12_000_000, 9_000_000), month("2026-12", 9_000_000, 11_000_000), month("2027-01", 11_000_000, 14_000_000)],
  } as unknown as Forecast;

  it("плитка Главной берёт конец месяца через три", () => {
    expect(aheadSummary(f)).toEqual({ month: "2027-01", closing: 14_000_000, change: 4_000_000, short: "2027-02" });
    expect(aheadSummary(f, 99).month).toBe("2027-01");
  });

  it("строка Календаря только для месяцев прогноза", () => {
    expect(monthLine(f, "2026-11")).toEqual({ end: "2026-11-28", closing: 9_000_000, change: -3_000_000, goals: [] });
    expect(monthLine(f, "2027-01")?.goals).toEqual([goal]);
    expect(monthLine(f, "2026-09")).toBeNull();
  });

  it("цель и сезонность по-человечески", () => {
    expect(goalText(goal)).toBe(`Отпуск к 15.01.2027: хватит, останется ${formatMoney(6_600_000, "₽")}`);
    expect(goalText({ ...goal, free: -1_800_000 })).toBe(`Отпуск к 15.01.2027: не хватит ${formatMoney(1_800_000, "₽")}`);
    expect(seasonText(0, 0)).toBeNull();
    expect(seasonText(0, 2_750_000)).toBe(`как год назад: траты +${formatMoney(2_750_000, "₽")}`);
  });
});
