import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, moveBlock, parseLayout, placeBefore, toggleBlock } from "./homeLayout";

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
    let l = moveBlock(DEFAULT_LAYOUT, "summary", -1);
    expect(l.order.slice(0, 2)).toEqual(["summary", "quick"]);
    l = moveBlock(l, "summary", -1);
    expect(l.order[0]).toBe("summary");
    l = placeBefore(l, "reminders", "summary");
    expect(l.order[0]).toBe("reminders");
    l = toggleBlock(toggleBlock(l, "cushion"), "spend");
    expect(l.hidden).toEqual(["cushion", "spend"]);
    expect(toggleBlock(l, "cushion").hidden).toEqual(["spend"]);
  });
});
