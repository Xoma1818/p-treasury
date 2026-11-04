import { describe, expect, it } from "vitest";
import { parseModulesOff } from "./modules";

describe("модули (Г3)", () => {
  it("читает список выключенных и отбрасывает лишнее", () => {
    expect(parseModulesOff('["debts","notes","нет такого",1]')).toEqual(["debts", "notes"]);
    expect(parseModulesOff("")).toEqual([]);
    expect(parseModulesOff("не json")).toEqual([]);
    expect(parseModulesOff(undefined)).toEqual([]);
  });
});

import { loadPrefs } from "./uiPrefs";

describe("настройки вида в базе (Г13)", () => {
  const mem = (init: Record<string, string>) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it("после восстановления берёт тему из базы, а своё окно не перетирает", () => {
    const s = mem({ "p-treasury-scale": "125" });
    const restored = loadPrefs('{"p-treasury-theme":"light","p-treasury-scale":"90"}', s);
    expect(restored).toEqual(["p-treasury-theme"]);
    expect(s.m.get("p-treasury-theme")).toBe("light");
    expect(s.m.get("p-treasury-scale")).toBe("125");
  });
  it("испорченное значение в базе не мешает", () => {
    expect(loadPrefs("не json", mem({}))).toEqual([]);
  });
});
