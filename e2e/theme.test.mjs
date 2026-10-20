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

test("по умолчанию тёмная тема, кнопка в меню переключает на светлую и обратно", async () => {
  const { browser } = app;
  await browser.execute(() => localStorage.removeItem("p-treasury-theme"));
  await browser.refresh();
  await onboard(browser, [{ name: "Карта", balance: "1000" }]);
  assert.equal(await theme(browser), "dark");
  const toggle = await browser.$('[data-testid="theme-toggle"]');
  assert.equal(await toggle.getText(), "Светлая тема");
  await toggle.click();
  assert.equal(await theme(browser), "light");
  assert.equal(await browser.execute(() => localStorage.getItem("p-treasury-theme")), "light");
  // Выбор переживает перезагрузку окна.
  await browser.refresh();
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  assert.equal(await theme(browser), "light");
  await (await browser.$('[data-testid="theme-toggle"]')).click();
  assert.equal(await theme(browser), "dark");
});

test("меню разбито на группы, у раздела значок и подсказка", async () => {
  const { browser } = app;
  const groups = await browser.execute(() => [...document.querySelectorAll(".nav-group")].map((g) => g.textContent));
  assert.deepEqual(groups, ["Каждый день", "Планы", "Долги и займы", "Справочники"]);
  await openSection(browser, "Бюджет");
  const hint = await browser.$("main .screen-hint").getText();
  assert.equal(hint, "Сколько можно тратить в этом месяце");
  assert.ok(await browser.$("main .screen-title .icon-tile svg").isExisting());
  const title = await browser.$('//nav//button[normalize-space()="Бюджет"]').getAttribute("title");
  assert.equal(title, "Сколько можно тратить в этом месяце · Ctrl+4");
});
