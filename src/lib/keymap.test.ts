import { describe, expect, it } from "vitest";
import { actionFor, assign, comboFor, comboOf, parseKeys, takenBy, usable } from "./keymap";

const ev = (code: string, key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({ code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe("свои горячие клавиши (Г10)", () => {
  it("сочетание из нажатия не зависит от раскладки", () => {
    expect(comboOf(ev("KeyN", "т", { ctrlKey: true }))).toBe("Ctrl+N");
    expect(comboOf(ev("KeyE", "E", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+E");
    expect(comboOf(ev("F2", "F2"))).toBe("F2");
    expect(comboOf(ev("ControlLeft", "Control", { ctrlKey: true }))).toBeNull();
  });
  it("годятся F-клавиши и сочетания с Ctrl или Alt", () => {
    expect(usable("F5")).toBe(true);
    expect(usable("Alt+I")).toBe(true);
    expect(usable("N")).toBe(false);
    expect(usable("Shift+N")).toBe(false);
  });
  it("по умолчанию как раньше, своё назначение главнее", () => {
    expect(actionFor({}, "Ctrl+N")).toBe("newExpense");
    const m = assign({}, "newIncome", "Ctrl+I");
    expect(actionFor(m, "Ctrl+I")).toBe("newIncome");
    expect(assign(m, "newIncome", "")).toEqual({});
    expect(assign({}, "search", "")).toEqual({ search: "" });
    expect(assign({ newExpense: "Ctrl+E" }, "newExpense", "Ctrl+N")).toEqual({});
  });
  it("занятое сочетание называет, чем занято", () => {
    expect(takenBy({}, "newIncome", "Ctrl+T")).toBe("Новый перевод");
    expect(takenBy({}, "newIncome", "Ctrl+Z")).toBe("Отменить последнее действие");
    expect(takenBy({}, "newExpense", "Ctrl+N")).toBeNull();
  });
  it("из хранилища берутся только известные действия и годные сочетания", () => {
    expect(parseKeys(JSON.stringify({ newIncome: "Ctrl+I", foo: "Ctrl+Q", help: "Q", search: "" }))).toEqual({ newIncome: "Ctrl+I", search: "" });
    expect(comboFor(parseKeys("bad"), "help")).toBe("F1");
  });
});
