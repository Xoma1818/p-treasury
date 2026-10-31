// Приёмочные тесты этапа 7 «Удобство»: сценарии из product/mvp-features.md (разделы 2 и 11).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money } from "./app.mjs";

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "10000" },
  ]);
});
after(async () => {
  await stop(browser);
});

const card = `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="Карта"]]`;
const keys = (...k) => browser.keys(k);
/** Убрать фокус из полей: Ctrl+Z в поле ввода — это отмена набора текста, а не действия. */
const blur = () => browser.execute(() => document.activeElement?.blur());

async function cardBalance(text) {
  await openSection(browser, "Счета");
  await waitText(browser, card, money(text));
}

test("чек из двух частей: «1890+455» даёт 2 345 ₽", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "1890+455");
  await waitText(browser, '[data-testid="amount-calc"]', money("= 2 345"));
  await choose(browser, "account", "Карта (₽)");
  await choose(browser, "category", "Питание");
  await save(browser);
  await cardBalance("7 655 ₽");
});

test("утренний кофе: шаблон «Кофе 250 ₽» записывает операцию одним нажатием, плашка позволяет отменить", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "250");
  await choose(browser, "account", "Карта (₽)");
  await choose(browser, "category", "Общепит");
  await fill(browser, "payee", "Кофейня");
  await click(browser, "Сохранить как шаблон", '//*[@role="dialog"]');
  await fill(browser, "templateName", "Кофе");
  await click(browser, "Сохранить шаблон", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="template-saved"]', /Шаблон «Кофе» сохранён/);
  await click(browser, "Отмена", '//*[@role="dialog"]');

  const coffee = '//*[@data-testid="templates-card"]//*[@data-testid="template" and @data-name="Кофе"]';
  await waitText(browser, coffee, /Кофе\s*250[\s\u00A0]₽/);
  await (await browser.$(`${coffee}//button[contains(@class, "template-main")]`)).click();
  await waitText(browser, '[data-testid="undo-bar"]', /Операция по шаблону/);
  await cardBalance("7 405 ₽");
  // Второй кофе — и сразу «Отменить» на плашке.
  await openSection(browser, "Главная");
  await (await browser.$(`${coffee}//button[contains(@class, "template-main")]`)).click();
  await waitText(browser, '[data-testid="undo-bar"]', /Операция по шаблону/);
  await click(browser, "Отменить", '//*[@data-testid="undo-bar"]');
  await waitText(browser, '[data-testid="undo-bar"]', /Отменено: Операция по шаблону/);
  await cardBalance("7 405 ₽");
});

test("шаблон в форме операции подставляет сумму, счёт, категорию и получателя", async () => {
  await openSection(browser, "Операции");
  await click(browser, "+ Операция");
  await (await browser.$('//*[@role="dialog"]//*[@data-testid="template" and @data-name="Кофе"]//button')).click();
  assert.equal(await (await browser.$('[role="dialog"] [name="amount"]')).getValue(), "250");
  assert.equal(await (await browser.$('[role="dialog"] [name="payee"]')).getValue(), "Кофейня");
  await click(browser, "Отмена", '//*[@role="dialog"]');
});

test("ошибся: удалил операцию, Ctrl+Z вернул её, Ctrl+Y удалил снова", async () => {
  await openSection(browser, "Операции");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  // Первая колонка — флажок выделения (0.16), форму открывает щелчок по дате.
  await (await browser.$('//tr[@data-testid="txn-row"][.//*[contains(., "Кофейня")]]/td[2]')).click();
  await click(browser, "Удалить", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await waitText(browser, '[data-testid="undo-bar"]', /Удаление операции/);
  await blur();
  await keys("Control", "z");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await waitText(browser, '[data-testid="undo-bar"]', /Отменено: Удаление операции/);
  await keys("Control", "y");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await keys("Control", "z");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await cardBalance("7 405 ₽");
});

test("Ctrl+Z в поле ввода отменяет набор текста, а не последнее действие", async () => {
  await openSection(browser, "Операции");
  // Плашку от прошлого теста закрываем, чтобы видеть только новое.
  if (await browser.$('[data-testid="undo-bar"]').isExisting()) await (await browser.$('[data-testid="undo-bar"] button[aria-label="Закрыть"]')).click();
  const search = await browser.$('[name="search"]');
  await search.click();
  await search.setValue("абв");
  assert.equal(await browser.execute(() => document.activeElement?.getAttribute("name")), "search");
  await keys("Control", "z");
  await browser.pause(500);
  const bar = await browser.$('[data-testid="undo-bar"]');
  assert.equal(await bar.isExisting(), false, `отмены действия не было: «${(await bar.isExisting()) ? await bar.getText() : ""}»`);
  await (await browser.$('//button[normalize-space()="Сбросить"]')).click();
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
});

test("при гостях: «Скрыть суммы» прячет все суммы, Ctrl+H возвращает", async () => {
  await openSection(browser, "Главная");
  await (await browser.$('[data-testid="hide-amounts"]')).click();
  await waitText(browser, '[data-testid="total-balance"]', /•••/);
  await openSection(browser, "Календарь");
  const text = await browser.$("main").getText();
  assert.doesNotMatch(text, /\d[\d\s ]*,?\d*[\s ]₽/, "в календаре не видно сумм");
  await openSection(browser, "Счета");
  await waitText(browser, card, /•••/);
  await blur();
  await keys("Control", "h");
  await waitText(browser, card, money("7 405 ₽"));
});

test("горячие клавиши: F1 — справка, Ctrl+F — поиск, Ctrl+N и Ctrl+Enter — операция без мыши", async () => {
  await openSection(browser, "Главная");
  await blur();
  await keys("F1");
  await waitText(browser, '[data-testid="hotkeys"]', /Ctrl\+Z\s*Отменить последнее действие/);
  await keys("Escape");
  await keys("Control", "f");
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await browser.waitUntil(() => browser.execute(() => document.activeElement?.getAttribute("name") === "search"), { timeout: 3000 });
  await blur();
  await keys("Control", "n");
  await (await browser.$('[role="dialog"] [name="amount"]')).waitForDisplayed();
  await fill(browser, "amount", "100");
  await keys("Control", "Enter");
  await browser.waitUntil(async () => !(await browser.$('[role="dialog"]').isExisting()), { timeout: 5000 });
  await waitText(browser, '[data-testid="txn-count"]', /Показано 3 из 3/);
});
