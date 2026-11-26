// Дымовой тест: приложение открывается, база создаётся, мастер, меню и Настройки работают.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { start, stop, openSection, openSettings, onboard, waitText, money, click, clickControl } from "./app.mjs";

let app;
before(async () => {
  app = await start();
});
after(async () => {
  await stop(app?.browser);
});

test("окно Kazna открывается, при первом запуске создаётся файл данных", async () => {
  assert.equal(await app.browser.getTitle(), "Kazna");
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
  for (const title of ["Операции", "Бюджет", "Отчёты", "Счета", "Категории", "Займы и долги", "Календарь", "Заметки", "Главная"]) {
    await openSection(app.browser, title);
  }
});

test("Настройки показывают установленную версию, технические сведения раскрываются отдельно", async () => {
  const { browser } = app;
  await openSettings(browser, "about");
  await waitText(browser, '[data-testid="app-version"]', /^\d+\.\d+\.\d+$/);
  const details = await browser.$('[data-testid="about-details"]');
  assert.equal(await details.getProperty("open"), false);
  await clickControl(browser, await details.$("summary"), "Технические сведения");
  await waitText(browser, '[data-testid="about-details"]', /(\d+) из \1/);
});

test("Что нового открывает установленную версию и позволяет выбрать прошлый выпуск", async () => {
  const { browser } = app;
  await openSettings(browser, "about");
  const version = await waitText(browser, '[data-testid="app-version"]', /^\d+\.\d+\.\d+$/);
  await click(browser, "Что нового");
  const dialog = '[role="dialog"]';
  await waitText(browser, dialog + " h3", /Версия/);
  assert.equal(await (await browser.$(dialog + " h3")).getText(), "Версия " + version);
  assert.ok((await browser.$$(dialog + " li")).length > 0);
  assert.doesNotMatch(await (await browser.$(dialog)).getText(), /(?:^|\n)#+\s/u);
  const archive = await browser.$(dialog + " details");
  assert.equal(await archive.getProperty("open"), false);
  await clickControl(browser, await archive.$("summary"), "Предыдущие версии");
  const picker = await archive.$("select");
  await picker.waitForDisplayed();
  const before = await (await archive.$("li")).getText();
  await picker.selectByIndex(1);
  await browser.waitUntil(async () => (await (await archive.$("li")).getText()) !== before);
  await browser.keys("Escape");
  await browser.waitUntil(async () => !(await browser.$(dialog).isExisting()) &&
    await browser.execute(() => document.activeElement?.getAttribute("name") === "releaseNotes"));
});

test("После отключения сети встроенная история по-прежнему открывается", async () => {
  const { browser } = app;
  await openSettings(browser, "about");
  await browser.execute(() => window.dispatchEvent(new Event("offline")));
  try {
    await click(browser, "Что нового");
    await waitText(browser, '[role="dialog"] li', /\S/u);
    await browser.keys("Escape");
  } finally {
    await browser.execute(() => window.dispatchEvent(new Event("online")));
  }
});
