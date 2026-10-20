// Дымовой тест: приложение открывается, база создаётся, мастер, меню и Настройки работают.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { start, stop, openSection, onboard, waitText, money } from "./app.mjs";

let app;
before(async () => {
  app = await start();
});
after(async () => {
  await stop(app?.browser);
});

test("окно P-Treasury открывается, при первом запуске создаётся файл данных", async () => {
  assert.equal(await app.browser.getTitle(), "P-Treasury");
  assert.ok(existsSync(join(app.dataDir, "budget.db")));
});

test("сценарий «Первый запуск»: счета с остатками и общий баланс", async () => {
  const { browser } = app;
  await onboard(browser, [
    { name: "Наличные", balance: "12000" },
    { name: "Карта Сбер", balance: "45 300" },
    { name: "Вклад", type: "Вклад / сбережения", balance: "300000" },
  ]);
  await waitText(browser, '[data-testid="total-balance"]', money("357 300 ₽"));
});

test("все разделы меню открываются", async () => {
  for (const title of ["Операции", "Бюджет", "Отчёты", "Счета", "Категории", "Долги", "Календарь", "Заметки", "Главная"]) {
    await openSection(app.browser, title);
  }
});

test("Настройки показывают версию данных и пример суммы", async () => {
  const { browser } = app;
  await openSection(browser, "Настройки");
  const about = '//h2[normalize-space()="О программе"]/..';
  await waitText(browser, about, /(\d+) из \1/);
  await waitText(browser, about, money("14 977,23 ₽"));
});
