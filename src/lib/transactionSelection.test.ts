import { describe, expect, it } from "vitest";
import { loadAllTransactionIds } from "./transactionSelection";
import { selectAll } from "./selection";
import type { TxnFilter } from "./api";

describe("выделение всех найденных операций", () => {
  it("выбирает больше 5000 операций, включая чек на границе страниц, с правильной общей суммой", async () => {
    // Независимый контракт сервера: limit ограничен, offset относится к сырым операциям,
    // а одна видимая строка чека может состоять из частей на разных страницах.
    const history = Array.from({ length: 6207 }, (_, i) => ({
      id: String(i),
      amount: i + 1,
      accountId: "card",
      splitId: i >= 999 && i <= 1001 ? "receipt" : null,
    }));
    const rows = [...history, { id: "other", amount: 999_999, accountId: "other", splitId: null }];
    const loadPage = async (f: TxnFilter) => {
      const matching = rows.filter((r) => !f.accountId || r.accountId === f.accountId);
      const from = f.offset ?? 0;
      return { total: matching.length, items: matching.slice(from, from + Math.min(f.limit ?? 200, 5000)) };
    };
    const selectedIds = await loadAllTransactionIds(loadPage, { accountId: "card", limit: 7, offset: 2000 });
    const selected = selectAll(selectedIds!);
    expect(selected.ids.size).toBe(history.length);
    expect(selected.ids.size).toBeGreaterThan(5000);
    expect(history.filter((r) => selected.ids.has(r.id)).reduce((s, r) => s + r.amount, 0))
      .toBe(6207 * 6208 / 2);
    expect(history.filter((r) => r.splitId === "receipt").every((r) => selected.ids.has(r.id))).toBe(true);
    expect(selected.ids.has("other")).toBe(false);
  });

  it("не отдаёт частичный результат, если следующая страница не загрузилась", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: String(i) }));
    const loadPage = async (f: TxnFilter) => {
      if (f.offset) throw new Error("связь прервалась");
      return { total: rows.length, items: rows.slice(0, f.limit) };
    };
    await expect(loadAllTransactionIds(loadPage, {})).rejects.toThrow("связь прервалась");
  });

  it("отменённая выборка не применяет уже полученные страницы", async () => {
    const controller = new AbortController();
    const result = await loadAllTransactionIds(async () => {
      controller.abort();
      return { total: 1, items: [{ id: "old-filter" }] };
    }, {}, controller.signal);
    expect(result).toBeNull();
  });

  it("просит повторить выбор при изменении списка, вместо неполного выделения", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: String(i) }));
    await expect(loadAllTransactionIds(async (f) => ({
      total: f.offset ? rows.length - 1 : rows.length,
      items: rows.slice(f.offset, (f.offset ?? 0) + (f.limit ?? 200)),
    }), {})).rejects.toThrow("повторите Ctrl+A");
    await expect(loadAllTransactionIds(async (f) => ({
      total: rows.length,
      items: f.offset ? [] : rows.slice(0, f.limit),
    }), {})).rejects.toThrow("повторите Ctrl+A");
  });
});
