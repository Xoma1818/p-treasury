// Дымовой тест: приложение открывается, база создаётся, меню и Настройки работают.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { start, stop, openSection } from "./app.mjs";

let app;
before(async () => {
  app = await start();
});
after(async () => {
  await stop(app?.browser);
});

test("окно открывается с названием «Казна» и Главной", async () => {
  const { browser } = app;
  assert.equal(await browser.getTitle(), "Казна");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
});

test("при первом запуске создаётся файл данных", async () => {
  assert.ok(existsSync(join(app.dataDir, "budget.db")));
});

test("все разделы меню открываются", async () => {
  for (const title of ["Операции", "Бюджет", "Отчёты", "Счета", "Категории", "Долги", "Календарь", "Заметки", "Главная"]) {
    await openSection(app.browser, title);
  }
});

test("Настройки показывают версию данных и пример суммы", async () => {
  const { browser } = app;
  await openSection(browser, "Настройки");
  const about = await browser.$('//h2[normalize-space()="О программе"]/..');
  await browser.waitUntil(async () => (await about.getText()).includes("1 из 1"), { timeout: 5000 });
  const text = await browser.$("main").getText();
  assert.match(text, /14\s977,23\s₽/);
  assert.match(text, /Российский рубль/);
});
