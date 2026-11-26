import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TrendCard } from "./Dashboard";
import { homeShares, shareUnavailable } from "../lib/categoryShares";
import type { CategoryItem, CategoryReport } from "../lib/api";

const period = { month: "2026-05", start: "2026-04-15", end: "2026-05-14" };
const queryKey = ["byCategory", "expense", period.start, period.end];
const item = (id: string, amount: number, children: CategoryItem[] = []): CategoryItem => ({
  categoryId: id, name: "Остальное", amount, percent: 0, children,
});
const report = (items: CategoryItem[], missingRates: string[] = []): CategoryReport => ({
  items, missingRates, baseCurrency: "RUB", total: items.reduce((s, c) => s + c.amount, 0),
});
function render(client: QueryClient) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TrendCard, { period })));
}

it("различает загрузку, ошибку, отсутствие операций, неизвестный курс и нулевой итог", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  expect(render(client)).toContain("Загружаем расходы по категориям");
  expect(render(client)).not.toContain("расходов пока нет");
  const fail = () => client.fetchQuery({ queryKey, queryFn: async () => { throw Error("SQLite занят"); } });
  await expect(fail()).rejects.toThrow("SQLite занят");
  expect(render(client)).toContain("SQLite занят");
  expect(render(client)).not.toContain("расходов пока нет");
  client.setQueryData(queryKey, report([]));
  expect(render(client)).toContain("расходов пока нет");
  client.setQueryData(queryKey, report([], ["USD"]));
  expect(render(client)).toContain("Нет расходов с известным курсом");
  expect(render(client)).not.toContain("расходов пока нет");
  client.setQueryData(queryKey, report([item("a", 0)]));
  expect(render(client)).toContain("Итог равен нулю");
  expect(render(client)).not.toContain("donut-seg");
  await expect(fail()).rejects.toThrow("SQLite занят");
  expect(render(client)).toContain("Показан предыдущий результат");
  expect(render(client)).toContain("Итог равен нулю");
});

it("показывает суммы с учётом возврата без фиктивной доли, в том числе при отрицательной подкатегории", () => {
  const client = new QueryClient();
  client.setQueryData(["currencies"], [{ code: "RUB", symbol: "₽", minorUnits: 2 }]);
  const signed = report([item("p", 12_000), item("q", -2_000)]);
  client.setQueryData(queryKey, signed);
  expect(render(client)).toContain("•••"); // Настройки ещё не получены.
  client.setQueryData(["settings"], { settings: { hide_amounts: "0" }, prefsRevision: 1 });
  const html = render(client);
  expect(html).toContain("отрицательные суммы");
  expect(html).toMatch(/120\s*₽/);
  expect(html).toMatch(/−20\s*₽/);
  expect(html).toMatch(/100\s*₽/);
  expect(html).not.toContain("donut-seg");
  expect(shareUnavailable(report([item("p", 100, [item("q", -30), item("r", 130)])]))).toContain("отрицательные суммы");
});

it("сохраняет разные ID при совпадении имён и собирает остаток без потери целых единиц", () => {
  const r = report([item("1", 100), item("2", 80), item("3", 60), item("4", 40), item("5", 19), item("rest", 1)]);
  expect(shareUnavailable(r)).toBeNull();
  const parts = homeShares(r);
  expect(new Set(parts.map(p => p.id)).size).toEqual(parts.length);
  expect(parts.at(-1)).toEqual({ id: "rest", name: "Остальное", amount: 20 });
  expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(r.total);
});
