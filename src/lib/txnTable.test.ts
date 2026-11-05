import { describe, expect, it } from "vitest";
import type { Txn } from "./api";
import { clickSort, DEFAULT_TABLE, groupRows, isDefaultTable, moveCol, orderedRows, parseTable, sortParam, toggleCol } from "./txnTable";

const t = (id: string, p: Partial<Txn>): Txn =>
  ({ id, type: "expense", date: "2026-11-01", accountId: "a1", accountName: "Карта", currencySymbol: "₽", currencyCode: "RUB", minorUnits: 2, amount: 100, categoryId: "c1", categoryName: "Еда", ...p }) as Txn;

describe("Г8: таблица операций", () => {
  it("разбирает сохранённое и возвращает обязательные столбцы", () => {
    expect(parseTable(null)).toEqual(DEFAULT_TABLE);
    expect(parseTable("{битое")).toEqual(DEFAULT_TABLE);
    const v = parseTable(JSON.stringify({ cols: ["payee", "date", "x", "date"], group: "day", sort: { by: "amount", desc: false } }));
    expect(v.cols).toEqual(["what", "payee", "date", "amount"]);
    expect(v.group).toBe("day");
    expect(v.sort).toEqual({ by: "amount", desc: false });
    expect(parseTable({ group: "weird", sort: { by: "rowid" } })).toEqual(DEFAULT_TABLE);
  });

  it("столбцы: новый перед суммой, обязательные не прячутся, сдвиг в пределах", () => {
    const a = toggleCol(DEFAULT_TABLE, "payee");
    expect(a.cols).toEqual(["date", "what", "account", "payee", "amount"]);
    expect(toggleCol(a, "payee").cols).toEqual(DEFAULT_TABLE.cols);
    expect(toggleCol(DEFAULT_TABLE, "amount")).toBe(DEFAULT_TABLE);
    expect(moveCol(DEFAULT_TABLE, "date", 1).cols).toEqual(["what", "date", "account", "amount"]);
    expect(moveCol(DEFAULT_TABLE, "date", -1)).toBe(DEFAULT_TABLE);
    expect(isDefaultTable(DEFAULT_TABLE)).toBe(true);
    expect(isDefaultTable(a)).toBe(false);
  });

  it("сортировка по заголовку и параметр для ядра", () => {
    expect(sortParam(DEFAULT_TABLE)).toBeUndefined();
    const byDateAsc = clickSort(DEFAULT_TABLE, "date");
    expect(sortParam(byDateAsc)).toBe("date:asc");
    expect(sortParam(clickSort(DEFAULT_TABLE, "amount"))).toBe("amount:desc");
    expect(sortParam(clickSort(DEFAULT_TABLE, "payee"))).toBe("payee:asc");
  });

  it("группы по первому появлению, итог только в одной валюте, чек — одной строкой", () => {
    const items = [
      t("1", { date: "2026-11-03", amount: 100 }),
      t("2", { date: "2026-11-02", type: "income", categoryId: "c2", categoryName: "Зарплата", amount: 500 }),
      t("3", { date: "2026-11-03", accountId: "a2", accountName: "USD", currencySymbol: "$", currencyCode: "USD", amount: 7 }),
      t("4", { date: "2026-11-01", splitId: "s", amount: 30 }),
      t("5", { date: "2026-11-01", splitId: "s", categoryId: "c3", amount: 20 }),
      t("6", { date: "2026-11-01", type: "transfer", categoryId: undefined, categoryName: undefined, amount: 999 }),
    ];
    const days = groupRows(items, "day");
    expect(days.map((g) => g.rows.length)).toEqual([2, 1, 2]);
    expect(days[0].total).toBeNull();
    expect(days[2].total?.amount).toBe(-50);
    const cats = groupRows(items, "category");
    expect(cats.map((g) => g.label)).toEqual(["Еда", "Зарплата", "Чеки на несколько категорий", "Переводы"]);
    expect(cats[1].total?.amount).toBe(500);
    expect(groupRows(items, "account").map((g) => g.label)).toEqual(["Карта", "USD"]);
    expect(orderedRows(items, "category").map((r) => r.key)).toEqual(["1", "3", "2", "split:s", "6"]);
    expect(groupRows(items, "none")).toHaveLength(1);
    // Один символ «¥» у юаня и иены: итог не складывается.
    const yen = [t("y1", { currencySymbol: "¥", currencyCode: "CNY", amount: 10000 }), t("y2", { currencySymbol: "¥", currencyCode: "JPY", minorUnits: 0, amount: 100 })];
    expect(groupRows(yen, "category")[0].total).toBeNull();
  });
});
