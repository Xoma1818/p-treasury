import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, DEFAULT_SHOWN, moveBlock, parseLayout, placeBefore, toggleBlock, toSetting } from "./homeLayout";

describe("своя Главная", () => {
  it("пустая или повреждённая настройка — порядок по умолчанию", () => {
    expect(parseLayout("")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{oops")).toEqual(DEFAULT_LAYOUT);
  });

  it("неизвестные карточки отбрасываются, новые встают за своей соседкой", () => {
    const l = parseLayout(JSON.stringify({ order: ["main", "gone", "main", "quick"], hidden: ["tiles", "gone"] }));
    expect(l.order.slice(0, 2)).toEqual(["main", "plans"]);
    expect(l.order.slice(l.order.indexOf("quick"), l.order.indexOf("quick") + 3)).toEqual(["quick", "summary", "tiles"]);
    expect(l.order).toHaveLength(DEFAULT_LAYOUT.order.length);
    expect(l.hidden).toEqual(["tiles"]);
  });

  it("сохранённый порядок без новых карточек 0.12 получает их на привычных местах", () => {
    const old = ["quick", "tiles", "cushion", "invest", "templates", "spend", "main", "plans", "reminders"];
    const l = parseLayout(JSON.stringify({ order: old, hidden: [] }));
    expect(l.order).toEqual(DEFAULT_LAYOUT.order);
  });

  it("стрелки, перетаскивание и скрытие", () => {
    const all = { order: DEFAULT_LAYOUT.order, hidden: [] };
    let l = moveBlock(all, "summary", -1);
    expect(l.order.slice(0, 2)).toEqual(["summary", "quick"]);
    l = moveBlock(l, "summary", -1);
    expect(l.order[0]).toBe("summary");
    l = placeBefore(l, "reminders", "summary");
    expect(l.order[0]).toBe("reminders");
    l = toggleBlock(toggleBlock(l, "cushion"), "spend");
    expect(l.hidden).toEqual(["cushion", "spend"]);
    expect(toggleBlock(l, "cushion").hidden).toEqual(["spend"]);
  });

  it("карточки 0.16 «Проверьте» и «Необычно» встают сразу за плитками баланса", () => {
    const old = ["quick", "summary", "tiles", "trend", "cushion", "invest", "goals", "subs", "days", "templates", "spend", "main", "plans", "reminders"];
    const l = parseLayout(JSON.stringify({ order: old, hidden: ["trend"] }));
    expect(l.order.slice(2, 5)).toEqual(["tiles", "checks", "unusual"]);
    expect(l.hidden).toEqual(["trend"]);
  });

  it("плитка 0.19 «Взгляд вперёд» встаёт сразу за подушкой", () => {
    const old = DEFAULT_LAYOUT.order.filter((b) => b !== "ahead");
    const l = parseLayout(JSON.stringify({ order: old, hidden: [] }));
    expect(l.order[l.order.indexOf("cushion") + 1]).toBe("ahead");
  });

  it("0.21: по умолчанию видны пять основных карточек, остальные скрыты", () => {
    const shown = DEFAULT_LAYOUT.order.filter((b) => !DEFAULT_LAYOUT.hidden.includes(b));
    expect(shown).toEqual(["quick", "tiles", "checks", "main", "plans"]);
    expect(DEFAULT_SHOWN).toHaveLength(5);
    expect(DEFAULT_LAYOUT.hidden).toHaveLength(DEFAULT_LAYOUT.order.length - 5);
  });

  it("0.21: уже настроенная Главная не меняется, сохранение — в новом виде", () => {
    const old = parseLayout(JSON.stringify({ order: DEFAULT_LAYOUT.order, hidden: ["trend"] }));
    expect(old.hidden).toEqual(["trend"]);
    const saved = JSON.parse(toSetting(old));
    expect(saved).toEqual({ order: DEFAULT_LAYOUT.order, hidden: ["trend"], v: 2 });
  });

  it("0.21: в новой раскладке карточки из будущих обновлений приходят скрытыми", () => {
    const order = DEFAULT_LAYOUT.order.filter((b) => b !== "ahead" && b !== "checks");
    const l = parseLayout(JSON.stringify({ order, hidden: [], v: 2 }));
    expect(l.hidden).toEqual(["ahead"]);
    expect(l.order).toContain("checks");
  });
});
