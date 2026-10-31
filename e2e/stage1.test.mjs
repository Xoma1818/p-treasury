// Приёмочные тесты этапа 1 «Учёт»: сценарии из product/mvp-features.md, разделы 1–4.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, mainText, money, field } from "./app.mjs";

let app;
let browser;
before(async () => {
  app = await start();
  browser = app.browser;
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

async function newTxn(type, { amount, account, toAccount, toAmount, category, payee }) {
  await openSection(browser, "Главная");
  await click(browser, { expense: "+ Расход", income: "+ Доход", transfer: "Перевод" }[type]);
  await fill(browser, "amount", amount);
  if (account) await choose(browser, "account", account);
  if (toAccount) await choose(browser, "toAccount", toAccount);
  if (toAmount) await fill(browser, "toAmount", toAmount);
  if (payee) await fill(browser, "payee", payee);
  if (category) await choose(browser, "category", category);
}

const accountRow = (name) => `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="${name}"]]`;

test("покупка в магазине: 2 340 ₽ на «Продукты» уменьшает баланс карты", async () => {
  await newTxn("expense", { amount: "2340", account: "Карта (₽)", category: "Питание", payee: "Пятёрочка" });
  await save(browser);
  await waitText(browser, '[data-testid="month-expense"]', money("2 340 ₽"));
  await openSection(browser, "Счета");
  await waitText(browser, accountRow("Карта"), money("97 660 ₽"));
});

test("зарплата: доход 85 000 ₽", async () => {
  await newTxn("income", { amount: "85000", account: "Карта (₽)", category: "Заработная плата" });
  await save(browser);
  await waitText(browser, '[data-testid="month-income"]', money("85 000 ₽"));
});

test("снятие наличных: перевод 5 000 ₽ не попадает в расходы", async () => {
  await newTxn("transfer", { amount: "5000", account: "Карта (₽)", toAccount: "Наличные (₽)" });
  await save(browser);
  await waitText(browser, '[data-testid="month-expense"]', money("2 340 ₽"));
  await openSection(browser, "Счета");
  await waitText(browser, accountRow("Наличные"), money("5 000 ₽"));
  await waitText(browser, accountRow("Карта"), money("177 660 ₽"));
});

test("знакомый магазин: получатель подставляет категорию из прошлой операции", async () => {
  await newTxn("expense", { amount: "500", account: "Наличные (₽)" });
  await choose(browser, "category", "Подарки");
  await fill(browser, "payee", "Пят");
  await browser.waitUntil(async () => (await browser.$$("#payee-hints option")).length > 0, {
    timeout: 5000,
    timeoutMsg: "нет подсказки «Пятёрочка»",
  });
  // Имя набрано целиком: категория подставляется, как при выборе из списка.
  await fill(browser, "payee", "Пятёрочка");
  await browser.waitUntil(
    async () => (await (await field(browser, "category")).$("option:checked").getText()).trim() === "Питание",
    { timeout: 5000, timeoutMsg: "категория «Продукты» не подставилась" },
  );
  // Счёт тоже подставился из прошлой операции («Карта»); эту покупку оплатили наличными.
  assert.equal((await (await field(browser, "account")).$("option:checked").getText()).trim(), "Карта (₽)");
  await choose(browser, "account", "Наличные (₽)");
  await browser.pause(400);
  assert.equal((await (await field(browser, "account")).$("option:checked").getText()).trim(), "Наличные (₽)");
  await save(browser);
});

test("валютный счёт и обмен: 92 000 ₽ → 1 000 $ показывает курс 92,00", async () => {
  await openSection(browser, "Счета");
  await click(browser, "+ Новый счёт");
  await fill(browser, "name", "Вклад USD");
  await choose(browser, "type", "Вклад / сбережения");
  await choose(browser, "currency", "USD · Доллар США");
  await fill(browser, "openingBalance", "1000");
  await save(browser);

  await newTxn("transfer", { amount: "92000", account: "Карта (₽)", toAccount: "Вклад USD ($)", toAmount: "1000" });
  await waitText(browser, '[data-testid="rate"]', /1 \$ = 92,00 ₽/);
  await save(browser);
  await openSection(browser, "Счета");
  await waitText(browser, accountRow("Вклад USD"), money("2 000 $"));
});

test("валютный вклад попадает в общий баланс по курсу", async () => {
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="total-balance"]', /Нет курса для USD/);
  await openSection(browser, "Настройки");
  await choose(browser, "rateFrom", "USD");
  await fill(browser, "rate", "92");
  await click(browser, "Добавить");
  await waitText(browser, '[data-testid="rates"]', /1 USD = 92 ₽/);
  await openSection(browser, "Главная");
  // Карта 85 660 + Наличные 4 500 + 2 000 $ × 92 = 274 160 ₽
  await waitText(browser, '[data-testid="total-balance"]', money("274 160 ₽"));
});

test("сверка: корректировка записывает разницу 350 ₽", async () => {
  await openSection(browser, "Счета");
  await (await browser.$(`${accountRow("Карта")}//button[normalize-space()="Сверить"]`)).click();
  await fill(browser, "actualBalance", "85310");
  await waitText(browser, '[role="dialog"]', money("−350 ₽"));
  await save(browser, "Сверить");
  await waitText(browser, accountRow("Карта"), money("85 310 ₽"));
  // Корректировка не входит в расходы месяца.
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="month-expense"]', money("2 840 ₽"));
});

test("найти трату: фильтр по категории и поиск по получателю и сумме", async () => {
  await openSection(browser, "Операции");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 6 из 6/);
  await choose(browser, "filterCategory", "Питание");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await click(browser, "Сбросить");
  await fill(browser, "search", "пятёрочка");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await fill(browser, "search", "2 340");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await click(browser, "Сбросить");
});

test("правка и удаление операции меняют баланс", async () => {
  await openSection(browser, "Операции");
  await fill(browser, "search", "500");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await (await browser.$('[data-testid="txn-row"] td.date')).click();
  await fill(browser, "amount", "700");
  await save(browser);
  await openSection(browser, "Счета");
  await waitText(browser, accountRow("Наличные"), money("4 300 ₽"));
  await openSection(browser, "Операции");
  await fill(browser, "search", "700");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await (await browser.$('[data-testid="txn-row"] td.date')).click();
  await save(browser, "Удалить");
  await openSection(browser, "Счета");
  await waitText(browser, accountRow("Наличные"), money("5 000 ₽"));
});

test("настройка под семью: «Дети → Секция»", async () => {
  await openSection(browser, "Категории");
  const kids = '//*[@data-testid="categories-expense"]//li[.//span[@class="name" and normalize-space()="Дети"]]';
  await (await browser.$(kids)).moveTo();
  await (await browser.$(`${kids}//button[normalize-space()="+ подкатегория"]`)).click();
  await fill(browser, "name", "Секция");
  await save(browser);
  await waitText(browser, '[data-testid="categories-expense"]', /Секция/);
});

test("объединение: удаление категории с переносом операций", async () => {
  await openSection(browser, "Категории");
  const food = '//*[@data-testid="categories-expense"]//li[.//span[@class="name" and normalize-space()="Питание"]]';
  await (await browser.$(food)).moveTo();
  await (await browser.$(`${food}//button[normalize-space()="Удалить"]`)).click();
  await waitText(browser, '[role="dialog"]', /Перенести операции \(1\)/);
  await choose(browser, "moveTo", "Прочие расходы");
  await save(browser, "Удалить");
  const text = await mainText(browser);
  assert.ok(!/Супермаркет/.test(text), "подкатегории удалены вместе с категорией");
  await openSection(browser, "Операции");
  await choose(browser, "filterCategory", "Прочие расходы");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
});

test("ошибки показываются, а не теряются: расход без суммы", async () => {
  await newTxn("expense", { amount: "abc" });
  await click(browser, "Сохранить", '//*[@role="dialog"]');
  await waitText(browser, '[role="alert"]', /сумму больше нуля/);
  await click(browser, "Отмена", '//*[@role="dialog"]');
});
