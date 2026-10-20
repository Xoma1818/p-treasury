import { describe, expect, it } from "vitest";
import { monthsText, monthsWord } from "../components/Cushion";

describe("финансовая подушка", () => {
  it("десятые месяца по-русски", () => {
    expect(monthsText(42)).toBe("4,2");
    expect(monthsText(5)).toBe("0,5");
    expect(monthsText(120)).toBe("12,0");
  });
  it("склонение", () => {
    expect(monthsWord(42)).toBe("месяца");
    expect(monthsWord(10)).toBe("месяц");
    expect(monthsWord(30)).toBe("месяца");
    expect(monthsWord(50)).toBe("месяцев");
    expect(monthsWord(110)).toBe("месяцев");
    expect(monthsWord(210)).toBe("месяц");
  });
});
