// Оформление 0.9: тёмная тема по умолчанию, светлая по кнопке; меню по группам.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, onboard, openSection } from "./app.mjs";

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

test("по умолчанию тёмная тема, переключатель в меню выбирает светлую и обратно", async () => {
  const { browser } = app;
  await browser.execute(() => localStorage.removeItem("p-treasury-theme"));
  await browser.refresh();
  await onboard(browser, [{ name: "Карта", balance: "1000" }]);
  assert.equal(await theme(browser), "dark");
  assert.equal(await (await browser.$('[data-testid="theme-dark"]')).getAttribute("aria-pressed"), "true");
  await (await browser.$('[data-testid="theme-light"]')).click();
  assert.equal(await theme(browser), "light");
  assert.equal(await (await browser.$('[data-testid="theme-light"]')).getAttribute("aria-pressed"), "true");
  assert.equal(await browser.execute(() => localStorage.getItem("p-treasury-theme")), "light");
  // Выбор переживает перезагрузку окна.
  await browser.refresh();
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  assert.equal(await theme(browser), "light");
  await (await browser.$('[data-testid="theme-dark"]')).click();
  assert.equal(await theme(browser), "dark");
});

test("меню разбито на группы, у пункта меню значок, у раздела подсказка", async () => {
  const { browser } = app;
  const groups = await browser.execute(() => [...document.querySelectorAll(".nav-group")].map((g) => g.textContent));
  assert.deepEqual(groups, ["Каждый день", "Планы", "Деньги", "Справочники"]);
  await openSection(browser, "Бюджет");
  const hint = await browser.$("main .screen-hint").getText();
  assert.equal(hint, "Сколько можно тратить в этом месяце");
  // 0.25 «Лаконичный»: крупный заголовок без значка, значок Lucide остаётся в меню.
  assert.ok(!(await browser.$("main .screen-title .icon-tile").isExisting()));
  assert.ok(await browser.$("nav .nav-item.active .icon-tile svg.lucide").isExisting());
  const title = await browser.$('//nav//button[normalize-space()="Бюджет"]').getAttribute("title");
  assert.equal(title, "Сколько можно тратить в этом месяце · Ctrl+4");
});
