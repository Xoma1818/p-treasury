import assert from "node:assert/strict";

// Real WebDriver input with the primary button held across scrolls, including
// when a calendar row and its destination cannot both fit in the viewport.
export async function pointerDrag(browser, source, target, { allowed = true, beforeRelease } = {}) {
  const point = async (selector) => {
    await browser.$(selector).waitForExist();
    return browser.execute((selector) => {
      const element = document.querySelector(selector);
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const r = element.getBoundingClientRect();
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      const x = Math.floor(left + Math.min(32, (right - left) / 2)), y = Math.floor((top + bottom) / 2);
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error("Цель перекрыта: " + selector);
      return { x, y };
    }, selector);
  };
  const actions = (events) => browser.performActions([{ type: "pointer", id: "move-item", parameters: { pointerType: "mouse" }, actions: events }]);
  const move = (xy, duration) => ({ type: "pointerMove", origin: "viewport", duration, ...xy });
  try {
    const start = await point(source);
    await actions([move(start, 0), { type: "pointerDown", button: 0 }, move({ x: start.x + 8, y: start.y }, 80)]);
    const end = await point(target);
    await actions([move(end, 130)]);
    const marks = await browser.execute((target) => ({
      active: document.querySelectorAll("[data-drag-active]").length,
      destinations: document.querySelectorAll("[data-drag-over]").length,
      overTarget: !!document.querySelector(target).closest("[data-drag-over]"),
    }), target);
    assert.deepEqual(marks, { active: 1, destinations: Number(allowed), overTarget: allowed });
    await beforeRelease?.();
    await actions([{ type: "pointerUp", button: 0 }]);
  } finally {
    await browser.releaseActions();
  }
  assert.equal(await browser.execute(() => document.querySelectorAll("[data-drag-active], [data-drag-over]").length), 0);
}
