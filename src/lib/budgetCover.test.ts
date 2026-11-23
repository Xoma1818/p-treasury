import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WarningRow } from "../components/QuickWins";
import type { BudgetLine, BudgetWarning } from "./api";
import { coverSources, warningCoverTarget } from "./budgetCover";

const period = { month: "2026-11", start: "2026-11-15", end: "2026-12-14" };
const target: BudgetLine = {
  categoryId: "food", categoryName: "Питание", kind: "expense", parentId: null, groupId: null,
  baseLimit: 100000, limit: 100000, actual: 140000, remaining: -40000, over: true, percent: 140,
  canRebalance: true, limitKind: "month", limitValue: null, rollover: false, carried: 0,
};
const source: BudgetLine = {
  ...target, categoryId: "leisure", categoryName: "Досуг", actual: 60000, remaining: 40000, over: false, percent: 60,
};
const budget = { id: "nov", period, lines: [target, source] };
const warning: BudgetWarning = {
  ...period, key: "food-100", categoryId: "food", categoryName: "Питание", level: 100,
  actual: target.actual, limit: target.limit, percent: target.percent, text: "", reason: "",
};

describe("покрытие перерасхода из предупреждения Главной", () => {
  it("в скрытом режиме строит предупреждение без денежных текстов ядра для любой валюты", () => {
    const w = { ...warning, text: "Потрачено 19 000 kr из 20 000 kr", reason: "Осталось 1 000 CHF на 2 дня, 500 ₩ в день." };
    const render = (hidden: boolean) => renderToStaticMarkup(createElement(WarningRow, {
      w, hidden, onOps: () => {}, planAction: null, onOk: () => {}, busy: false,
    }));
    const privateRow = render(true);
    expect(privateRow).toContain("Питание · 140 % лимита");
    expect(privateRow).toContain("Лимит превышен");
    expect(privateRow).not.toMatch(/19 000|20 000|1 000|500|CHF|kr|₩/);
    const openRow = render(false);
    expect(openRow).toContain(w.text);
    expect(openRow).toContain(w.reason);
  });

  it("открывает категорию своего бюджетного месяца и допускает точное покрытие", () => {
    expect(warningCoverTarget(budget, warning)).toBe(target);
    expect(coverSources(budget, target)).toEqual([source]);
    expect(warningCoverTarget(undefined, warning)).toBeUndefined();
    expect(warningCoverTarget({ ...budget, id: null }, warning)).toBeUndefined();
    expect(warningCoverTarget(budget, { ...warning, month: "2026-12" })).toBeUndefined();
    expect(warningCoverTarget(budget, { ...warning, start: "2026-11-01" })).toBeUndefined();
    expect(warningCoverTarget(budget, { ...warning, end: "2026-11-30" })).toBeUndefined();
  });

  it("учитывает свежие лимиты, свободный остаток и разрешение ядра для обеих категорий", () => {
    for (const unavailable of [
      { ...source, remaining: 39999 },
      { ...source, baseLimit: 39999, carried: 60001 },
      { ...source, canRebalance: false },
    ]) {
      expect(warningCoverTarget({ ...budget, lines: [target, unavailable] }, warning)).toBeUndefined();
    }
    expect(warningCoverTarget({ ...budget, lines: [{ ...target, canRebalance: false }, source] }, warning)).toBeUndefined();
    expect(warningCoverTarget({ ...budget, lines: [{ ...target, remaining: 0 }, source] }, warning)).toBeUndefined();
    expect(warningCoverTarget(budget, { ...warning, actual: warning.limit })).toBeUndefined();
  });
});
