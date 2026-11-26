import { describe, expect, it } from "vitest";
import { currencyLabel, DEFAULT_FINE, DEFAULT_LAYERS, parseFine, startSection, weekdayIndex } from "./fine";

describe("Г12: тонкие настройки", () => {
  it("разбирает сохранённое, незнакомое — по умолчанию", () => {
    expect(parseFine(null)).toEqual(DEFAULT_FINE);
    expect(parseFine("{битое")).toEqual(DEFAULT_FINE);
    expect(parseFine('{"start":"budget","week":"sun","kopecks":false,"code":true}')).toEqual({ start: "budget", week: "sun", kopecks: false, code: true, layers: DEFAULT_LAYERS });
    // Р6: слои по отдельности, незнакомое и битое — по умолчанию.
    expect(parseFine('{"layers":{"balance":true,"expense":false,"debts":"да"}}').layers).toEqual({ ...DEFAULT_LAYERS, balance: true, expense: false });
    expect(parseFine('{"start":"nowhere","week":"tue"}')).toEqual(DEFAULT_FINE);
  });
  it("выбирает код валюты из каталога, в том числе для общего знака иены и юаня", () => {
    const f = { ...DEFAULT_FINE, kopecks: false, code: true };
    expect(currencyLabel("₽", 2, f)).toBe("RUB");
    expect(currencyLabel("¥", 2, f)).toBe("CNY");
    expect(currencyLabel("¥", 0, f)).toBe("JPY");
    expect(currencyLabel("Br", 2, f)).toBe("BYN");
    expect(currencyLabel("₺", 2, f)).toBe("TRY");
    expect(currencyLabel("₽", 2, DEFAULT_FINE)).toBe("₽");
  });
  it("начало недели и экран при запуске", () => {
    expect(weekdayIndex(0, DEFAULT_FINE)).toBe(6); // воскресенье в конце
    expect(weekdayIndex(0, { ...DEFAULT_FINE, week: "sun" })).toBe(0);
    expect(weekdayIndex(1, DEFAULT_FINE)).toBe(0);
    expect(startSection({ ...DEFAULT_FINE, start: "calendar" })).toBe("calendar");
    expect(startSection({ ...DEFAULT_FINE, start: "last" })).toBe("home");
  });
});
