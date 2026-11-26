// Оформление 0.9: тёмная тема по умолчанию, светлая по кнопке; меню по группам.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, onboard, openSection, selectTheme } from "./app.mjs";

let app;
before(async () => {
  app = await start();
});
after(async () => {
  // Тема хранится в окне, а не в данных: возвращаем тёмную, чтобы не влиять на другие прогоны.
  await app?.browser.execute(() => localStorage.removeItem("p-treasury-theme")).catch(() => {});
  await stop(app?.browser);
});

const theme = (b) => b.execute(() => document.documentElement.dataset.theme);

function luminance(color) {
  const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("по умолчанию тёмная тема, переключатель в меню выбирает светлую и обратно", async () => {
  const { browser } = app;
  await browser.execute(() => localStorage.removeItem("p-treasury-theme"));
  await browser.refresh();
  await onboard(browser, [{ name: "Карта", balance: "1000" }]);
  assert.equal(await theme(browser), "dark");
  const trigger = await browser.$('button[data-testid="theme-switch"]');
  await trigger.click();
  assert.equal(await (await browser.$('[data-testid="theme-dark"]')).getAttribute("aria-checked"), "true");
  await browser.keys("Escape");
  await browser.waitUntil(async () => (await trigger.getAttribute("aria-expanded")) === "false" && await trigger.isFocused());
  await browser.keys("Enter");
  const light = await browser.$('[data-testid="theme-light"]');
  await light.waitForDisplayed();
  await browser.keys("Home");
  assert.equal(await light.isFocused(), true);
  await browser.keys("Enter");
  assert.equal(await theme(browser), "light");
  assert.equal(await trigger.isFocused(), true);
  assert.equal(await browser.execute(() => localStorage.getItem("p-treasury-theme")), "light");
  // Выбор переживает перезагрузку окна.
  await browser.refresh();
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  assert.equal(await theme(browser), "light");
  await selectTheme(browser, "dark");
  assert.equal(await theme(browser), "dark");
});

test("основные разделы видны в меню, Настройки закреплены рядом с быстрыми действиями", async () => {
  const { browser } = app;
  const nav = await browser.$('[data-testid="nav-list"]');
  assert.equal((await nav.$$("button[data-section]")).length, 10);
  assert.equal(await nav.$(".nav-settings").isExisting(), false);
  await browser.$(".app-nav > .nav-settings button").waitForDisplayed();
  await openSection(browser, "Бюджет");
  const hint = await browser.$("main .screen-hint").getText();
  assert.equal(hint, "Сколько можно тратить в этом месяце");
  // 0.25 «Лаконичный»: крупный заголовок без значка, значок Lucide остаётся в меню.
  assert.ok(!(await browser.$("main .screen-title .icon-tile").isExisting()));
  assert.ok(await browser.$("nav .nav-item.active .icon-tile svg.lucide").isExisting());
  const selected = await browser.$('nav button[aria-current="page"]');
  assert.equal(await selected.getAttribute("aria-label"), "Бюджет");
  await (await browser.$("main h1")).moveTo();
  await selected.moveTo();
  const tip = await browser.$('.rail-tip[role="tooltip"]');
  await tip.waitForDisplayed();
  assert.equal(await tip.getText(), "Бюджет");
});

test("текст основной кнопки читается в светлой и тёмной темах", async () => {
  const { browser } = app;
  await openSection(browser, "Счета");
  const primary = await browser.$("main .btn.primary");
  await primary.waitForDisplayed();
  for (const mode of ["light", "dark"]) {
    await selectTheme(browser, mode);
    await browser.waitUntil(() => browser.execute((mode) =>
      document.documentElement.dataset.theme === mode && !document.documentElement.classList.contains("theme-fade"), mode));
    const colors = await browser.execute((button) => {
      const style = getComputedStyle(button);
      return [style.color, style.backgroundColor];
    }, primary);
    const [lighter, darker] = colors.map(luminance).sort((a, b) => b - a);
    const contrast = (lighter + 0.05) / (darker + 0.05);
    assert.ok(contrast >= 4.5, `${mode}: контраст подписи основной кнопки ${contrast.toFixed(2)}:1`);
  }
});
