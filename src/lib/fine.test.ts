import { describe, expect, it } from "vitest";
import { currencyLabel, DEFAULT_FINE, DEFAULT_LAYERS, parseFine, shownAmount, startSection, weekdayIndex } from "./fine";

describe("Г12: тонкие настройки", () => {
  it("разбирает сохранённое, незнакомое — по умолчанию", () => {
    expect(parseFine(null)).toEqual(DEFAULT_FINE);
    expect(parseFine("{битое")).toEqual(DEFAULT_FINE);
    expect(parseFine('{"start":"budget","week":"sun","kopecks":false,"code":true}')).toEqual({ start: "budget", week: "sun", kopecks: false, code: true, layers: DEFAULT_LAYERS });
    // Р6: слои по отдельности, незнакомое и битое — по умолчанию.
    expect(parseFine('{"layers":{"balance":true,"expense":false,"debts":"да"}}').layers).toEqual({ ...DEFAULT_LAYERS, balance: true, expense: false });
    expect(parseFine('{"start":"nowhere","week":"tue"}')).toEqual(DEFAULT_FINE);
  });
  it("без копеек округляет только для экрана, код вместо значка", () => {
    const f = { ...DEFAULT_FINE, kopecks: false, code: true };
    expect(shownAmount(123450, 2, f)).toBe(123500);
    expect(shownAmount(-123449, 2, f)).toBe(-123400);
    expect(shownAmount(1234, 0, f)).toBe(1234);
    expect(shownAmount(123450, 2, DEFAULT_FINE)).toBe(123450);
    expect(currencyLabel("₽", f)).toBe("RUB");
    expect(currencyLabel("¥", f)).toBe("CNY");
    expect(currencyLabel("₽", DEFAULT_FINE)).toBe("₽");
  });
  it("начало недели и экран при запуске", () => {
    expect(weekdayIndex(0, DEFAULT_FINE)).toBe(6); // воскресенье в конце
    expect(weekdayIndex(0, { ...DEFAULT_FINE, week: "sun" })).toBe(0);
    expect(weekdayIndex(1, DEFAULT_FINE)).toBe(0);
    expect(startSection({ ...DEFAULT_FINE, start: "calendar" })).toBe("calendar");
    expect(startSection({ ...DEFAULT_FINE, start: "last" })).toBe("home");
  });
});
