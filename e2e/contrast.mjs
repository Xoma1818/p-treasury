import assert from "node:assert/strict";
import { selectTheme } from "./app.mjs";

function luminance(color) {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  assert.ok(rgb, `Ожидался непрозрачный цвет sRGB, получен ${color}`);
  const [r, g, b] = rgb.slice(1).map((channel) => {
    const s = Number(channel) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Проверяет текст на его подложке после завершения переключения темы. */
export async function assertReadableInThemes(browser, label, textSelector, surfaceSelector = textSelector) {
  for (const mode of ["light", "dark"]) {
    await selectTheme(browser, mode);
    await browser.waitUntil(() => browser.execute((mode) => document.documentElement.dataset.theme === mode, mode));
    const text = await browser.$(textSelector);
    await text.waitForDisplayed();
    const colors = await browser.executeAsync((text, surface, done) => {
      const read = () => [getComputedStyle(text).color, getComputedStyle(surface).backgroundColor];
      const initial = read();
      const transitions = document.getAnimations().filter((animation) =>
        (animation.transitionProperty === "color" && animation.effect?.target?.contains?.(text)) ||
        (animation.transitionProperty === "background-color" && animation.effect?.target === surface));
      if (!transitions.length) return done(initial);
      Promise.allSettled(transitions.map((animation) => animation.finished)).then(() => done(read()));
    }, text, await browser.$(surfaceSelector));
    const [lighter, darker] = colors.map(luminance).sort((a, b) => b - a);
    const contrast = (lighter + 0.05) / (darker + 0.05);
    assert.ok(contrast >= 4.5, `${mode}, ${label}: контраст ${contrast.toFixed(2)}:1 (${colors.join(" / ")})`);
  }
}
