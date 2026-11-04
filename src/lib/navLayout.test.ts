import { describe, expect, it } from "vitest";
import { DEFAULT_NAV, isDefaultNav, navSections, parseAddMain, parseNav } from "./navLayout";

const all = () => true;

describe("Г4: своё меню", () => {
  it("пустое или испорченное значение — меню как было", () => {
    expect(parseNav(null)).toEqual(DEFAULT_NAV);
    expect(parseNav("{не json")).toEqual(DEFAULT_NAV);
    expect(isDefaultNav(parseNav(""))).toBe(true);
  });

  it("неизвестные разделы отбрасываются, новые встают в конец, Главную и Настройки не скрыть", () => {
    const l = parseNav(JSON.stringify({ order: ["budget", "budget", "nope", "home"], hidden: ["home", "settings", "notes", "x"] }));
    expect(l.order.slice(0, 2)).toEqual(["budget", "home"]);
    expect(l.order).toHaveLength(DEFAULT_NAV.order.length);
    expect(l.order).not.toContain("settings");
    expect(l.hidden).toEqual(["notes"]);
    expect(isDefaultNav(l)).toBe(false);
  });

  it("меню: свой порядок, без скрытых и выключенных модулей, Настройки последними", () => {
    const l = parseNav(JSON.stringify({ order: ["accounts", "home"], hidden: ["calendar"] }));
    const ids = navSections(l, (id) => id !== "notes").map((s) => s.id);
    expect(ids.slice(0, 2)).toEqual(["accounts", "home"]);
    expect(ids).not.toContain("calendar");
    expect(ids).not.toContain("notes");
    expect(ids.at(-1)).toBe("settings");
    expect(navSections(DEFAULT_NAV, all).map((s) => s.id)[0]).toBe("home");
  });

  it("Г6: главная кнопка — расход, если не выбрано иное", () => {
    expect(parseAddMain(null)).toBe("expense");
    expect(parseAddMain("income")).toBe("income");
    expect(parseAddMain("bad")).toBe("expense");
  });
});
