import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, moveBlock, parseLayout, placeBefore, toggleBlock } from "./homeLayout";

describe("своя Главная", () => {
  it("пустая или повреждённая настройка — порядок по умолчанию", () => {
    expect(parseLayout("")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{oops")).toEqual(DEFAULT_LAYOUT);
  });

  it("неизвестные карточки отбрасываются, новые добавляются в конец", () => {
    const l = parseLayout(JSON.stringify({ order: ["main", "gone", "main", "quick"], hidden: ["tiles", "gone"] }));
    expect(l.order.slice(0, 2)).toEqual(["main", "quick"]);
    expect(l.order).toHaveLength(DEFAULT_LAYOUT.order.length);
    expect(l.hidden).toEqual(["tiles"]);
  });

  it("стрелки, перетаскивание и скрытие", () => {
    let l = moveBlock(DEFAULT_LAYOUT, "tiles", -1);
    expect(l.order.slice(0, 2)).toEqual(["tiles", "quick"]);
    l = moveBlock(l, "tiles", -1);
    expect(l.order[0]).toBe("tiles");
    l = placeBefore(l, "reminders", "tiles");
    expect(l.order[0]).toBe("reminders");
    l = toggleBlock(toggleBlock(l, "cushion"), "spend");
    expect(l.hidden).toEqual(["cushion", "spend"]);
    expect(toggleBlock(l, "cushion").hidden).toEqual(["spend"]);
  });
});
