import { describe, expect, it } from "vitest";
import type { Txn } from "./api";
import { barClass, barLevel, usualLabel } from "./budgetLevel";
import { axisLabel, axisPad, changePercent, netWorthScale } from "./netWorth";
import { groupReceipts, receiptProblem, receiptRemainder, receiptTitle, rowIds, spreadParts } from "./receipt";
import { clickRow, EMPTY_SEL, isRowSelected, keepExisting, selectAll, type SelRow } from "./selection";
import { addTag, cleanTag, tagSuggestions } from "./tags";

const rows: SelRow[] = [
  { key: "a", ids: ["a"] },
  { key: "b", ids: ["b"] },
  { key: "split:s", ids: ["s1", "s2", "s3"] },
  { key: "d", ids: ["d"] },
  { key: "e", ids: ["e"] },
];
const ids = (s: { ids: Set<string> }) => [...s.ids].sort();

describe("выделение операций (Г1)", () => {
  it("флажок добавляет и снимает строку", () => {
    let s = clickRow(EMPTY_SEL, rows, "b");
    expect(ids(s)).toEqual(["b"]);
    s = clickRow(s, rows, "d", { ctrl: true });
    expect(ids(s)).toEqual(["b", "d"]);
    s = clickRow(s, rows, "b", { ctrl: true });
    expect(ids(s)).toEqual(["d"]);
  });

  it("Shift выделяет диапазон от последней отмеченной строки в любую сторону", () => {
    let s = clickRow(EMPTY_SEL, rows, "b");
    s = clickRow(s, rows, "e", { shift: true });
    expect(ids(s)).toEqual(["b", "d", "e", "s1", "s2", "s3"]);
    // Второй Shift-щелчок меняет конец диапазона, а не добавляет.
    s = clickRow(s, rows, "a", { shift: true });
    expect(ids(s)).toEqual(["a", "b"]);
  });

  it("Ctrl+Shift добавляет диапазон к выделению", () => {
    let s = clickRow(EMPTY_SEL, rows, "e");
    s = clickRow(s, rows, "a", { ctrl: true });
    s = clickRow(s, rows, "b", { ctrl: true, shift: true });
    expect(ids(s)).toEqual(["a", "b", "e"]);
  });

  it("Shift без начала диапазона работает как обычный щелчок", () => {
    const s = clickRow(EMPTY_SEL, rows, "d", { shift: true });
    expect(ids(s)).toEqual(["d"]);
    expect(s.anchor).toBe("d");
  });

  it("разбитый чек выделяется целиком", () => {
    const s = clickRow(EMPTY_SEL, rows, "split:s");
    expect(isRowSelected(s, rows[2])).toBe(true);
    expect(isRowSelected(clickRow(s, rows, "split:s"), rows[2])).toBe(false);
  });

  it("Ctrl+A и чистка после изменения списка", () => {
    const s = selectAll(["a", "b", "c"]);
    expect(s.ids.size).toBe(3);
    expect(ids(keepExisting(s, new Set(["a", "c", "z"])))).toEqual(["a", "c"]);
    expect(keepExisting(s, new Set(["a", "b", "c"]))).toBe(s);
  });
});

describe("разбивка чека и траты по месяцам (Г3)", () => {
  it("остаток и условия сохранения", () => {
    const parts = [
      { categoryId: "food", amount: 300000 },
      { categoryId: "home", amount: 120000 },
    ];
    expect(receiptRemainder(500000, parts)).toBe(80000);
    expect(receiptProblem(500000, parts)).toBe("Распределите остаток по строкам");
    expect(receiptProblem(400000, parts)).toBe("Строки больше суммы чека");
    expect(receiptProblem(420000, parts)).toBeNull();
    expect(receiptProblem(420000, [parts[0]])).toMatch(/две категории/);
    expect(receiptProblem(420000, [parts[0], { categoryId: "", amount: 120000 }])).toMatch(/категорию/);
    expect(receiptProblem(420000, [parts[0], { categoryId: "x", amount: null }])).toMatch(/больше нуля/);
    expect(receiptRemainder(null, parts)).toBe(-420000);
  });

  it("копейки от деления уходят в первую часть", () => {
    expect(spreadParts(1200000, 12)).toEqual(Array(12).fill(100000));
    const p = spreadParts(1000, 3);
    expect(p).toEqual([334, 333, 333]);
    expect(p.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(spreadParts(500, 1)).toEqual([500]);
  });

  it("части чека собираются в одну строку на месте первой", () => {
    const t = (id: string, splitId: string | null, amount: number, payee = "Ашан") => ({ id, splitId, amount, payee }) as Txn;
    const list = groupReceipts([t("1", null, 100), t("2", "s", 300), t("3", null, 50), t("4", "s", 200), t("5", "s", 100)]);
    expect(list.map((r) => r.key)).toEqual(["1", "split:s", "3"]);
    const r = list[1];
    expect(r.kind === "receipt" && r.total).toBe(600);
    expect(rowIds(r)).toEqual(["2", "4", "5"]);
    expect(r.kind === "receipt" && receiptTitle(r.parts)).toBe("Ашан, 3 категории");
    expect(receiptTitle([t("x", "s", 1, ""), t("y", "s", 1), t("z", "s", 1), t("w", "s", 1), t("v", "s", 1)])).toBe("Чек, 5 категорий");
  });
});

describe("теги (Г6)", () => {
  it("ввод с решёткой, пробелами и без повторов", () => {
    expect(cleanTag("  #ремонт  кухни ")).toBe("ремонт кухни");
    expect(cleanTag("#")).toBeNull();
    expect(addTag(["Ремонт"], "#ремонт")).toEqual(["Ремонт"]);
    expect(addTag(["Ремонт"], "дача")).toEqual(["Ремонт", "дача"]);
  });

  it("подсказки: сначала начинающиеся с набранного, без выбранных", () => {
    const all = ["дача", "отпуск", "ремонт", "подарки дачникам"];
    expect(tagSuggestions(all, "да", [])).toEqual(["дача", "подарки дачникам"]);
    expect(tagSuggestions(all, "", ["дача"])).toEqual(["отпуск", "ремонт", "подарки дачникам"]);
  });
});

describe("бюджет: цвет полосы и сравнение с обычным (А1, А2)", () => {
  it("жёлтая от 80 %, красная от 100 %", () => {
    expect(barLevel(79)).toBe("ok");
    expect(barLevel(80)).toBe("warn");
    expect(barLevel(99)).toBe("warn");
    expect(barLevel(100)).toBe("over");
    expect(barClass(150)).toBe("bar over");
    expect(barClass(10)).toBe("bar");
  });

  it("пометка к обычному", () => {
    expect(usualLabel(34)).toBe("+34 % к обычному");
    expect(usualLabel(-40)).toBe("−40 % к обычному");
    expect(usualLabel(null)).toBeNull();
  });
});

describe("чистые активы (В3)", () => {
  it("шкала включает ноль и минус", () => {
    const s = netWorthScale([-120000, 380000]);
    expect(s.min).toBeLessThanOrEqual(-120000);
    expect(s.max).toBeGreaterThanOrEqual(380000);
    expect(Number.isInteger(s.min / s.step)).toBe(true);
    const p = netWorthScale([500, 900]);
    expect(p.min).toBe(0);
  });

  it("короткие подписи оси и отступ под самую длинную", () => {
    expect(axisLabel(1_500_000_000)).toBe("15 млн");
    expect(axisLabel(85_000_000)).toBe("850 тыс.");
    expect(axisLabel(250_000)).toBe("2,5 тыс.");
    expect(axisLabel(-250_000_000)).toBe("−2,5 млн");
    expect(axisLabel(0)).toBe("0");
    expect(axisPad(["15 млн", "−2,5 млн"])).toBeGreaterThan(axisPad(["0"]));
  });

  it("изменение к прошлому месяцу", () => {
    expect(changePercent(110, 10)).toBe(10);
    expect(changePercent(-50, -100)).toBe(-200);
    expect(changePercent(100, null)).toBeNull();
    expect(changePercent(100, 100)).toBeNull();
  });
});

import { maskAmounts } from "../components/QuickWins";
describe("maskAmounts", () => {
  it("прячет суммы, оставляя проценты и текст", () => {
    expect(maskAmounts("Яндекс Плюс: было 399 ₽, стало 449 ₽ (+50 ₽ в месяц, +600 ₽ в год)")).toBe(
      "Яндекс Плюс: было •••, стало ••• (••• в месяц, ••• в год)",
    );
    expect(maskAmounts("Кафе: 8 400 ₽, на 34 % больше")).toBe("Кафе: •••, на 34 % больше");
  });
});
