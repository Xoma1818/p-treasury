import { describe, expect, it } from "vitest";
import { DEFAULT_HEAD, isDefaultHead, parseHead, shownTemplates, toggleHead } from "./headBar";

describe("шапка «Операций» (Г5)", () => {
  it("по умолчанию видны выписка и выгрузка", () => {
    expect(parseHead(null)).toEqual(DEFAULT_HEAD);
    expect(parseHead("не json")).toEqual(DEFAULT_HEAD);
    expect(isDefaultHead(parseHead(undefined))).toBe(true);
  });
  it("неизвестное отбрасывается, повторы убираются", () => {
    expect(parseHead(JSON.stringify({ shown: ["export", "x", 5, "tpl:a", "export", "tpl:"] }))).toEqual({ shown: ["export", "tpl:a"] });
    expect(parseHead(JSON.stringify({ shown: [] }))).toEqual({ shown: [] });
  });
  it("галочка убирает в «⋯» и возвращает в конец", () => {
    const h = toggleHead(DEFAULT_HEAD, "import");
    expect(h.shown).toEqual(["export"]);
    expect(isDefaultHead(h)).toBe(false);
    expect(toggleHead(h, "import").shown).toEqual(["export", "import"]);
  });
  it("удалённые шаблоны не показываются", () => {
    expect(shownTemplates({ shown: ["import", "tpl:a", "tpl:b"] }, ["b", "c"])).toEqual(["b"]);
  });
});
