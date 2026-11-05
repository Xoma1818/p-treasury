// Полная цепочка для операции (план OTTO 04.11): создать → итог → изменить → связанные
// экраны → отменить → удалить → перезапустить → сохранённое состояние.
import { test, after, before } from "node:test";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money } from "./app.mjs";

let app;
let browser;
let dataDir;
before(async () => {
  app = await start();
  browser = app.browser;
  dataDir = app.dataDir;
  await onboard(browser, [{ name: "Карта", balance: "10000" }]);
});
after(async () => {
  await stop(browser);
});

const card = `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="Карта"]]`;
const keys = (...k) => browser.keys(k);
const blur = () => browser.execute(() => document.activeElement?.blur());

/** Баланс карты, расход месяца на Главной и расход в отчёте за месяц. */
async function expect(balance, expense) {
  await openSection(browser, "Счета");
  await waitText(browser, card, money(balance));
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="month-expense"]', money(expense));
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="report-expense"]', money(expense));
}

async function openRow() {
  await openSection(browser, "Операции");
  await (await browser.$('//tr[@data-testid="txn-row"][.//*[contains(., "Пятёрочка")]]/td[2]')).click();
}

test("операция: создать → изменить → отменить → удалить → вернуть → перезапустить", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "1500");
  await fill(browser, "payee", "Пятёрочка");
  await choose(browser, "category", "Питание");
  await save(browser);
  await expect("8 500 ₽", "1 500 ₽");

  await openRow();
  await fill(browser, "amount", "2000");
  await save(browser);
  await expect("8 000 ₽", "2 000 ₽");

  // Отменить правку: снова 1 500.
  await openSection(browser, "Операции");
  await blur();
  await keys("Control", "z");
  await waitText(browser, '[data-testid="undo-bar"]', /Отменено/);
  await expect("8 500 ₽", "1 500 ₽");

  // Удалить и вернуть.
  await openRow();
  await click(browser, "Удалить", '//*[@role="dialog" or contains(@class,"panel")]');
  await expect("10 000 ₽", "0 ₽");
  await openSection(browser, "Операции");
  await blur();
  await keys("Control", "z");
  await waitText(browser, '[data-testid="undo-bar"]', /Отменено/);
  await expect("8 500 ₽", "1 500 ₽");

  // Перезапуск: всё на месте.
  await stop(browser);
  ({ browser } = await start(dataDir));
  await expect("8 500 ₽", "1 500 ₽");
  await openSection(browser, "Операции");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
});
