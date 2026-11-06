import { describe, expect, it } from "vitest";
import { DEFAULT_FINE } from "./fine";
import { heatLevel, heatWeeks } from "./heat";

describe("Р7 тепловая карта года", () => {
  it("оттенки от светлого к тёмному", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(30, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
    expect(heatLevel(5, 0)).toBe(0);
  });
  it("недели с понедельника и с воскресенья", () => {
    // 1 января 2026 — четверг.
    const days = Array.from({ length: 365 }, (_, i) => {
      const d = new Date(2026, 0, 1 + i);
      const p = (n: number) => String(n).padStart(2, "0");
      return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, expense: i === 0 ? 50 : 0 };
    });
    const mon = heatWeeks(days, 50, DEFAULT_FINE);
    expect(mon[0].slice(0, 3)).toEqual([null, null, null]);
    expect(mon[0][3]).toEqual({ date: "2026-01-01", expense: 50, level: 4 });
    expect(mon.every((w) => w.length === 7)).toBe(true);
    expect(mon.flat().filter(Boolean)).toHaveLength(365);
    const sun = heatWeeks(days, 50, { ...DEFAULT_FINE, week: "sun" });
    expect(sun[0][4]?.date).toBe("2026-01-01");
  });
});
