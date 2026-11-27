import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, DEFAULT_SHOWN, moveBlock, parseLayout, placeBefore, resetLayout, toggleBlock, toggleHalf, toSetting, withOverspendSlot } from "./homeLayout";

describe("своя Главная", () => {
  it("ставит активный перерасход сразу за сводкой или перед плитками, когда сводка скрыта", () => {
    expect(withOverspendSlot(["quick", "summary", "tiles", "checks"])).toEqual(["quick", "summary", "overspend", "tiles", "checks"]);
    expect(withOverspendSlot(["quick", "tiles", "checks"])).toEqual(["quick", "overspend", "tiles", "checks"]);
    expect(withOverspendSlot(["accounts", "recent", "checks"])).toEqual(["overspend", "accounts", "recent", "checks"]);
  });

  it("учитывает пользовательский порядок и скрытие карточки «Проверьте»", () => {
    expect(withOverspendSlot(["checks", "quick", "summary", "tiles"])).toEqual(["overspend", "checks", "quick", "summary", "tiles"]);
    expect(withOverspendSlot(["summary", "tiles", "quick"])).toEqual(["summary", "tiles", "quick"]);
  });

  it("пустая или повреждённая настройка — порядок по умолчанию", () => {
    expect(parseLayout("")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{oops")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("null")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{"v":3,"order":false}')).toEqual(DEFAULT_LAYOUT);
  });

  it("неизвестные карточки отбрасываются, новые встают за своей соседкой", () => {
    const l = parseLayout(JSON.stringify({ order: ["main", "gone", "main", "quick"], hidden: ["tiles", "gone"] }));
    expect(l.order.slice(0, 3)).toEqual(["accounts", "recent", "plans"]);
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

  it("стрелки и перенос считают видимые позиции и сохраняют слот отключённого модуля", () => {
    const layout = { ...DEFAULT_LAYOUT, order: ["quick", "invest", "recent", "spend"] as typeof DEFAULT_LAYOUT.order };
    const visible = layout.order.filter((b) => b !== "invest");
    expect(placeBefore(layout, "quick", "recent", visible)).toBe(layout);
    expect(moveBlock(layout, "recent", -1, visible).order).toEqual(["recent", "invest", "quick", "spend"]);
    expect(moveBlock(layout, "quick", 1, visible).order).toEqual(["recent", "invest", "quick", "spend"]);
    expect(placeBefore(layout, "spend", "quick", visible).order).toEqual(["spend", "invest", "quick", "recent"]);
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

  it("по умолчанию видны пять основных блоков с общей строкой счетов и операций", () => {
    const shown = DEFAULT_LAYOUT.order.filter((b) => !DEFAULT_LAYOUT.hidden.includes(b));
    expect(shown).toEqual(["quick", "tiles", "checks", "accounts", "recent", "plans"]);
    expect(DEFAULT_LAYOUT.groupedMain).toBe(true);
    expect(DEFAULT_LAYOUT.hidden).toHaveLength(DEFAULT_LAYOUT.order.length - DEFAULT_SHOWN.length);
  });

  it("0.21: уже настроенная Главная не меняется, сохранение — в новом виде", () => {
    const old = parseLayout(JSON.stringify({ order: DEFAULT_LAYOUT.order, hidden: ["trend"] }));
    expect(old.hidden).toEqual(["trend"]);
    const saved = JSON.parse(toSetting(old));
    expect(saved).toEqual({ order: DEFAULT_LAYOUT.order, hidden: ["trend"], v: 3, groupedMain: true });
  });

  it("0.21: в новой раскладке карточки из будущих обновлений приходят скрытыми", () => {
    const order = DEFAULT_LAYOUT.order.filter((b) => b !== "ahead" && b !== "checks");
    const l = parseLayout(JSON.stringify({ order, hidden: [], v: 2 }));
    expect(l.hidden).toEqual(["ahead"]);
    expect(l.order).toContain("checks");
  });
});

describe("карточки в половину ширины (Г7)", () => {
  it("переключаются и сохраняются, неизвестные отбрасываются", async () => {
    const { toggleHalf } = await import("./homeLayout");
    const l = toggleHalf(DEFAULT_LAYOUT, "tiles");
    expect(l.half).toEqual(["tiles"]);
    expect(parseLayout(toSetting(l)).half).toEqual(["tiles"]);
    expect(toggleHalf(l, "tiles").half).toBeUndefined();
    expect(parseLayout(JSON.stringify({ ...JSON.parse(toSetting(l)), half: ["tiles", "nope"] })).half).toEqual(["tiles"]);
    expect(parseLayout(toSetting(DEFAULT_LAYOUT)).half).toBeUndefined();
  });
});

describe("совместимость объединённой строки и раздельных карточек", () => {
  it.each([undefined, 2])("раскрывает старый main на прежнем месте с его видимостью и шириной, v=%s", (v) => {
    const order = DEFAULT_LAYOUT.order.filter((b) => b !== "accounts" && b !== "recent");
    const layout = parseLayout(JSON.stringify({ v, order: ["main", ...order], hidden: ["main", "trend"], half: ["main", "quick"] }));
    expect(layout.order).toEqual(["accounts", "recent", ...order]);
    expect(layout.hidden).toEqual(["accounts", "recent", "trend"]);
    expect(layout.half).toEqual(["accounts", "recent", "quick"]);
    expect(layout.groupedMain).toBe(true);
    expect(parseLayout(toSetting(layout))).toEqual(layout);
  });

  it("скрытие одного элемента пары и изменения остальных карточек сохраняют общую строку", () => {
    const hidden = toggleBlock(DEFAULT_LAYOUT, "recent");
    const moved = moveBlock(hidden, "summary", -1);
    const resized = toggleHalf(moved, "tiles");
    expect(resized.groupedMain).toBe(true);
    expect(resized.hidden).toContain("recent");
    expect(resized.hidden).not.toContain("accounts");
    expect(parseLayout(toSetting(resized))).toEqual(resized);
    expect(placeBefore(resized, "accounts", "recent")).toBe(resized);
  });

  it("перемещение или смена ширины дочерней карточки разделяет пару вплоть до сброса", () => {
    const moved = placeBefore(DEFAULT_LAYOUT, "recent", "quick");
    expect(moved.order[0]).toBe("recent");
    expect(moved.groupedMain).toBeFalsy();
    expect(placeBefore(moved, "recent", "plans").groupedMain).toBeFalsy();
    const resized = toggleHalf(DEFAULT_LAYOUT, "recent");
    expect(resized.half).toEqual(["recent"]);
    expect(resized.groupedMain).toBeFalsy();
    expect(resetLayout(resized)).toEqual(DEFAULT_LAYOUT);
  });

  it("вставка третьей карточки в общую строку сохраняет выбранное место", () => {
    const layout = placeBefore(DEFAULT_LAYOUT, "quick", "recent");
    expect(layout.order.slice(layout.order.indexOf("accounts"), layout.order.indexOf("recent") + 1)).toEqual(["accounts", "quick", "recent"]);
    expect(layout.groupedMain).toBeFalsy();
    expect(parseLayout(toSetting(layout))).toEqual(layout);
  });

  it("перенос мимо пары сохраняет её общей и оставляет слот выключенного модуля", () => {
    const layout = parseLayout(JSON.stringify({ v: 2, order: ["quick", "invest", "main", ...DEFAULT_LAYOUT.order.filter((b) => !["quick", "invest", "accounts", "recent"].includes(b))] }));
    const visible = layout.order.filter((b) => b !== "invest");
    const moved = placeBefore(layout, "quick", "summary", visible);
    expect(moved.order.slice(0, 5)).toEqual(["accounts", "recent", "invest", "quick", "summary"]);
    expect(moved.groupedMain).toBe(true);
  });

  it("при раскрытии «Своих цифр» из v3 сохраняет позиции, ширину и разделение карточек", () => {
    const moved = placeBefore(DEFAULT_LAYOUT, "accounts", "quick");
    const resized = toggleHalf(moved, "accounts");
    const saved = parseLayout(toSetting(resized));
    const revealed = parseLayout(toSetting(toggleBlock(saved, "figures")));
    expect(revealed).toEqual({ ...resized, hidden: resized.hidden.filter((b) => b !== "figures") });
  });

  it("сброс меняет только доступные модули", () => {
    const invest = placeBefore(DEFAULT_LAYOUT, "invest", "summary");
    const recent = placeBefore(invest, "recent", "quick");
    const chosen = toggleHalf(toggleBlock(toggleHalf(recent, "recent"), "invest"), "invest");
    const slot = chosen.order.indexOf("invest");
    const active = chosen.order.filter((b) => b !== "invest");
    const cleared = resetLayout(chosen, active);
    expect(cleared.order.indexOf("invest")).toBe(slot);
    expect(cleared.half).toEqual(["invest"]);
    expect(cleared.hidden).not.toContain("invest");
    expect(cleared.order.filter((b) => b !== "invest")).toEqual(DEFAULT_LAYOUT.order.filter((b) => b !== "invest"));
    expect(cleared.groupedMain).toBe(true);
    expect(parseLayout(toSetting(cleared))).toEqual(cleared);
  });
});
