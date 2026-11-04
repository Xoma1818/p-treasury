// Правки и удаления, которые раньше не проходил ни один сквозной тест (тред 29, 04.11.2026):
// счёт, категория, заметка, курс. Каждый тест проверяет результат на экране, а не только нажатие.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, click, save, waitText, waitContent, money, mainText, setDate, choose, newDebt } from "./app.mjs";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = iso(new Date());

let app;
let browser;
before(async () => {
  app = await start();
  browser = app.browser;
  await onboard(browser, [
    { name: "Наличные", balance: "5000" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

const accountRow = (name) => `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="${name}"]]`;
const catRow = (name) => `//*[@data-testid="categories-expense"]//li[.//span[@class="name" and normalize-space()="${name}"]]`;
async function rowButton(row, text) {
  await click(browser, text, row);
}

test("счёт: переименовать и поменять начальный остаток — баланс и название меняются", async () => {
  await openSection(browser, "Счета");
  await rowButton(accountRow("Наличные"), "Изменить");
  await fill(browser, "name", "Кошелёк");
  await fill(browser, "openingBalance", "6000");
  await save(browser);
  await waitText(browser, accountRow("Кошелёк"), money("6 000 ₽"));
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="total-balance"]', money("106 000 ₽"));
});

test("счёт: «Закрыть» убирает из списка, «Вернуть» возвращает", async () => {
  await openSection(browser, "Счета");
  await rowButton(accountRow("Кошелёк"), "Закрыть");
  await browser.waitUntil(async () => !(await browser.$(accountRow("Кошелёк")).isExisting()), { timeout: 5000, timeoutMsg: "закрытый счёт остался в списке" });
  await (await browser.$('//label[contains(., "закрытые")]//input')).click();
  await waitText(browser, accountRow("Кошелёк"), /закрыт/);
  await rowButton(accountRow("Кошелёк"), "Вернуть");
  await browser.waitUntil(async () => !/закрыт/.test(await (await browser.$(accountRow("Кошелёк"))).getText()), { timeout: 5000, timeoutMsg: "счёт не вернулся" });
  await (await browser.$('//label[contains(., "закрытые")]//input')).click();
});

test("категория: переименовать и отправить в архив", async () => {
  await openSection(browser, "Категории");
  await rowButton(catRow("Подарки"), "Изменить");
  await fill(browser, "name", "Подарки близким");
  await save(browser);
  await waitContent(browser, '[data-testid="categories-expense"]', /Подарки близким/);
  await rowButton(catRow("Подарки близким"), "В архив");
  await browser.waitUntil(async () => !(await browser.$(catRow("Подарки близким")).isExisting()), { timeout: 5000, timeoutMsg: "категория в архиве осталась в списке" });
});

test("заметка: изменить текст и удалить", async () => {
  await openSection(browser, "Заметки");
  await click(browser, "+ Заметка");
  await fill(browser, "noteBody", "гарантия на пылесос");
  await save(browser);
  await waitText(browser, '[data-testid="notes"]', /гарантия на пылесос/);
  await (await browser.$('//*[@data-testid="note"][contains(., "пылесос")]')).click();
  await fill(browser, "noteBody", "гарантия на чайник");
  await save(browser);
  await waitText(browser, '[data-testid="notes"]', /гарантия на чайник/);
  assert.doesNotMatch(await mainText(browser), /пылесос/);
  await (await browser.$('//*[@data-testid="note"][contains(., "чайник")]')).click();
  await save(browser, "Удалить");
  await browser.waitUntil(async () => !/чайник/.test(await mainText(browser)), { timeout: 5000, timeoutMsg: "заметка не удалилась" });
});

test("курс валюты: добавить и удалить", async () => {
  await openSection(browser, "Настройки");
  await fill(browser, "rate", "91,5");
  await click(browser, "Добавить", '//form[.//input[@name="rate"]]');
  await waitText(browser, '[data-testid="rates"]', /91,5/);
  await click(browser, "Удалить", '//*[@data-testid="rates"]//tr[contains(., "91,5")]');
  await browser.waitUntil(async () => !(await browser.$('//*[@data-testid="rates"]//tr[contains(., "91,5")]').isExisting()), { timeout: 5000, timeoutMsg: "курс не удалился" });
});

test("цель: изменить сумму и название, затем удалить", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Цель");
  await fill(browser, "goalName", "Велосипед");
  await fill(browser, "goalTarget", "30000");
  await save(browser);
  const goal = (name) => `[data-testid="goal"][data-name="${name}"]`;
  await waitText(browser, goal("Велосипед"), /30 000 ₽/);
  await click(browser, "Велосипед", `//*[@data-testid="goal" and @data-name="Велосипед"]`);
  await fill(browser, "goalName", "Самокат");
  await fill(browser, "goalTarget", "12000");
  await save(browser);
  await waitText(browser, goal("Самокат"), /12 000 ₽/);
  assert.equal(await browser.$(goal("Велосипед")).isExisting(), false);
  await click(browser, "Самокат", `//*[@data-testid="goal" and @data-name="Самокат"]`);
  await save(browser, "Удалить");
  await browser.waitUntil(async () => !(await browser.$(goal("Самокат")).isExisting()), { timeout: 5000, timeoutMsg: "цель не удалилась" });
});

const occ = (list, title) => `//*[@data-testid="${list}"]//li[@data-testid="occurrence" and @data-title="${title}"]`;
const remRow = (title) => `//*[@data-testid="reminder-row"][.//span[@class="main" and normalize-space()="${title}"]]`;

async function newReminder(title) {
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", title);
  await setDate(browser, "reminderDate", today);
  await setDate(browser, "reminderTime", "00:00");
  await choose(browser, "repeat", "Ежемесячно");
  await save(browser);
  await browser.$(occ("rem-overdue", title)).waitForExist({ timeout: 5000 });
}

test("напоминание: отложить до завтра, выполнить и вернуть", async () => {
  await openSection(browser, "Календарь");
  await click(browser, "Напоминания");
  await newReminder("Интернет");
  await click(browser, "Отложить", occ("rem-overdue", "Интернет"));
  await click(browser, "до завтра", occ("rem-overdue", "Интернет"));
  await waitText(browser, occ("rem-upcoming", "Интернет"), /отложено/);
  assert.equal(await browser.$(occ("rem-overdue", "Интернет")).isExisting(), false);

  await newReminder("Вода");
  await click(browser, "Выполнено", occ("rem-overdue", "Вода"));
  await waitText(browser, occ("rem-done", "Вода"), /выполнено/);
  await click(browser, "Вернуть", occ("rem-done", "Вода"));
  await browser.$(occ("rem-overdue", "Вода")).waitForExist({ timeout: 5000, timeoutMsg: "«Вернуть» не вернул напоминание в просроченные" });
});

test("напоминание: переименовать, выключить, включить и удалить", async () => {
  await openSection(browser, "Календарь");
  await click(browser, "Напоминания");
  await (await browser.$(`${remRow("Вода")}//span[@class="clickable"]`)).click();
  await fill(browser, "reminderTitle", "Вода и свет");
  await save(browser);
  await browser.$(remRow("Вода и свет")).waitForExist({ timeout: 5000, timeoutMsg: "напоминание не переименовалось" });
  await click(browser, "Выключить", remRow("Вода и свет"));
  // Раньше выключенное показывало «следующее …», как будто ещё придёт.
  await waitText(browser, remRow("Вода и свет"), /выключено/);
  assert.doesNotMatch(await (await browser.$(remRow("Вода и свет"))).getText(), /следующее/);
  assert.equal(await browser.$(occ("rem-overdue", "Вода и свет")).isExisting(), false, "выключенное не должно висеть в просроченных");
  await click(browser, "Включить", remRow("Вода и свет"));
  await waitText(browser, remRow("Вода и свет"), /следующее/);
  await (await browser.$(`${remRow("Вода и свет")}//span[@class="clickable"]`)).click();
  await save(browser, "Удалить");
  await browser.waitUntil(async () => !(await browser.$(remRow("Вода и свет")).isExisting()), { timeout: 5000, timeoutMsg: "напоминание не удалилось" });
});

test("бюджет: заметка к месяцу сохраняется, «Удалить бюджет месяца» удаляет", async () => {
  await openSection(browser, "Бюджет");
  await click(browser, "Создать пустой");
  await fill(browser, "budgetNote", "в ноябре отпуск");
  await (await browser.$('//main//h2[normalize-space()="Бюджет"]')).click(); // уход из поля сохраняет
  await browser.pause(500);
  await openSection(browser, "Главная");
  await openSection(browser, "Бюджет");
  assert.equal(await (await browser.$('[name="budgetNote"]')).getValue(), "в ноябре отпуск");
  await click(browser, "Удалить бюджет месяца");
  await click(browser, "Да, удалить бюджет");
  await browser.$('//button[normalize-space()="Создать пустой"]').waitForExist({ timeout: 5000, timeoutMsg: "бюджет не удалился" });
});

test("итоги месяца: прошлый месяц «Месяц завершён» и «Открыть снова»", async () => {
  await openSection(browser, "Бюджет");
  await (await browser.$('button[aria-label="Предыдущий месяц"]')).click();
  await click(browser, "Итоги месяца");
  await fill(browser, "reviewNote", "спокойный месяц");
  await click(browser, "Месяц завершён", '//*[@role="dialog"]');
  await waitText(browser, '[role="dialog"]', /Заметка: спокойный месяц/);
  await click(browser, "Открыть снова", '//*[@role="dialog"]');
  await browser.$('[data-testid="review-close"]').waitForExist({ timeout: 5000, timeoutMsg: "месяц не открылся снова" });
  await click(browser, "Закрыть", '//*[@role="dialog"]');
});

async function expense(amount, payee) {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", amount);
  await choose(browser, "account", "Кошелёк (₽)");
  await fill(browser, "payee", payee);
  await choose(browser, "category", "Путешествия");
  await save(browser);
}

test("пачка операций: перенести на другой счёт, поставить тег и получателя", async () => {
  await expense("300", "Ларёк");
  await expense("200", "Ларёк");
  await openSection(browser, "Операции");
  await fill(browser, "search", "Ларёк");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  const selectAll = async () => {
    // Поиск применяется с задержкой и снимает выделение: сначала дать ему примениться.
    await browser.pause(800);
    // Каждый раз ищем заново: после щелчка строка перерисовывается.
    for (let i = 0; i < 2; i++) await (await browser.$$('[data-testid="txn-select"]'))[i].click();
    await waitText(browser, '[data-testid="sel-sum"]', /Выбрано 2/);
  };
  await selectAll();
  await click(browser, "Счёт", '//*[@data-testid="sel-bar"]');
  await choose(browser, "bulkAccount", "Карта (₽)");
  await click(browser, "Перенести", '//*[@data-testid="sel-bar"]');
  await waitText(browser, '[data-testid="bulk-message"]', /2 операци/);
  await openSection(browser, "Счета");
  await waitText(browser, accountRow("Карта"), money("99 500 ₽"));

  await openSection(browser, "Операции");
  await fill(browser, "search", "Ларёк");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await selectAll();
  await click(browser, "Тег", '//*[@data-testid="sel-bar"]');
  await fill(browser, "bulkTag", "дача");
  await click(browser, "Добавить", '//*[@data-testid="sel-bar"]');
  await waitText(browser, '[data-testid="bulk-message"]', /2 операци/);
  await browser.waitUntil(async () => (await browser.$$('[data-testid="txn-tag"]')).length === 2, { timeout: 5000, timeoutMsg: "тег не появился у обеих операций" });

  await selectAll();
  await click(browser, "Получатель", '//*[@data-testid="sel-bar"]');
  await fill(browser, "bulkPayee", "Ларёк у дома");
  await click(browser, "Поставить", '//*[@data-testid="sel-bar"]');
  await waitText(browser, '[data-testid="bulk-message"]', /2 операци/);
  await fill(browser, "search", "Ларёк у дома");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
});

test("тег: переименовать и удалить — операции остаются", async () => {
  await openSection(browser, "Категории");
  const tag = (name) => `//*[@data-testid="tag-row" and @data-tag="${name}"]`;
  await click(browser, "Переименовать", tag("дача"));
  await fill(browser, "tagName", "огород");
  await click(browser, "Сохранить", tag("дача"));
  await browser.$(tag("огород")).waitForExist({ timeout: 5000, timeoutMsg: "тег не переименовался" });
  await click(browser, "Удалить", tag("огород"));
  await click(browser, "Да, удалить", tag("огород"));
  await browser.$(tag("огород")).waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "тег не удалился" });
  await openSection(browser, "Операции");
  await fill(browser, "search", "Ларёк у дома");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
});

test("шаблон: крестик удаляет его с Главной", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "250");
  await choose(browser, "category", "Путешествия");
  await click(browser, "Сохранить как шаблон", '//*[@role="dialog"]');
  await fill(browser, "templateName", "Билет");
  await click(browser, "Сохранить шаблон", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="template-saved"]', /Шаблон «Билет» сохранён/);
  await click(browser, "Отмена", '//*[@role="dialog"]');
  const tpl = '[data-testid="templates-card"] [data-testid="template"][data-name="Билет"]';
  await browser.$(tpl).waitForExist({ timeout: 5000 });
  await (await browser.$('button[aria-label="Удалить шаблон «Билет»"]')).click();
  await browser.$(tpl).waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "шаблон не удалился" });
});

test("событие: переименовать, поменять бюджет и удалить", async () => {
  await openSection(browser, "Бюджет");
  await click(browser, "+ Событие");
  await fill(browser, "eventName", "Дача");
  await fill(browser, "eventBudget", "20000");
  await save(browser);
  const ev = (name) => `//*[@data-testid="event-row" and @data-name="${name}"]`;
  await waitText(browser, ev("Дача"), money("0 ₽ из 20 000 ₽"));
  await click(browser, "Дача", ev("Дача"));
  await fill(browser, "eventName", "Дача летом");
  await fill(browser, "eventBudget", "30000");
  await save(browser);
  await waitText(browser, ev("Дача летом"), money("0 ₽ из 30 000 ₽"));
  await click(browser, "Дача летом", ev("Дача летом"));
  await save(browser, "Удалить");
  await browser.$(ev("Дача летом")).waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "событие не удалилось" });
});

test("имущество: изменить оценку и удалить", async () => {
  await openSection(browser, "Счета");
  await click(browser, "+ Имущество");
  await fill(browser, "assetName", "Гараж");
  await fill(browser, "assetValue", "500000");
  await save(browser);
  const row = '//tr[@data-testid="asset-row"][contains(., "Гараж")]';
  await waitText(browser, row, money("500 000 ₽"));
  await (await browser.$(`${row}/td[1]`)).click();
  await fill(browser, "assetValue", "550000");
  await save(browser);
  await waitText(browser, row, money("550 000 ₽"));
  await (await browser.$(`${row}/td[1]`)).click();
  await save(browser, "Удалить");
  await browser.$(row).waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "имущество не удалилось" });
});

test("кредит: каникулы и смена ставки записываются и удаляются, название меняется", async () => {
  await newDebt(browser, { counterparty: "Сбер", principal: "120000", rate: "12", term: "12", account: "Карта (₽)" });
  await save(browser);
  await browser.$('//main//h1[contains(., "Сбер")]').waitForDisplayed({ timeout: 5000 });
  const next = async () => (await browser.$('[data-testid="debt-next"]')).getText();
  const before = await next();

  await click(browser, "Каникулы");
  await save(browser);
  await waitText(browser, '[data-testid="loan-changes"]', /Каникулы:/);
  await browser.waitUntil(async () => (await next()) !== before, { timeout: 5000, timeoutMsg: "каникулы не сдвинули ближайший платёж" });
  await (await browser.$('button[aria-label="Удалить каникулы"]')).click();
  await browser.waitUntil(async () => (await next()) === before, { timeout: 5000, timeoutMsg: "после удаления каникул платёж не вернулся" });

  await click(browser, "Ставка изменилась");
  await fill(browser, "newRate", "8");
  await save(browser);
  await waitText(browser, '[data-testid="loan-changes"]', /Ставка 8 % годовых/);
  await (await browser.$('button[aria-label="Удалить изменение ставки"]')).click();
  await browser.$('[data-testid="loan-changes"]').waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "изменение ставки не удалилось" });
  await browser.waitUntil(async () => (await next()) === before, { timeout: 5000, timeoutMsg: "после удаления ставки платёж не вернулся" });

  await click(browser, "Изменить название и комментарий");
  await fill(browser, "counterparty", "Сбер ипотека");
  await save(browser);
  await browser.$('//main//h1[contains(., "Сбер ипотека")]').waitForDisplayed({ timeout: 5000, timeoutMsg: "название долга не поменялось" });
});

test("операция долга: вместо молчащего «Удалить» — пояснение и «Открыть долг»", async () => {
  await openSection(browser, "Операции");
  await fill(browser, "search", "Сбер");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
  await (await browser.$('[data-testid="txn-row"] td.date')).click();
  await waitText(browser, '[data-testid="txn-debt-hint"]', /удалить или изменить его можно в карточке долга/);
  assert.equal(await browser.$('//*[@role="dialog" or contains(@class,"panel")]//button[normalize-space()="Удалить"]').isExisting(), false);
  await (await browser.$('[data-testid="txn-open-debt"]')).click();
  await browser.$('//main//h1[contains(., "Сбер ипотека")]').waitForDisplayed({ timeout: 5000, timeoutMsg: "«Открыть долг» не открыл карточку" });
});

test("тема хранится в базе: после восстановления копии берётся тема из неё", async () => {
  const theme = () => browser.execute(() => document.documentElement.dataset.theme);
  await (await browser.$('[data-testid="theme-light"]')).click();
  assert.equal(await theme(), "light");
  const prefs = () => browser.executeAsync((done) => window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => done(JSON.parse(s.ui_prefs || "{}"))));
  await browser.waitUntil(async () => (await prefs())["p-treasury-theme"] === "light", { timeout: 5000, timeoutMsg: "выбор темы не записан в базу" });
  // Как после восстановления копии с тёмной темой: в базе «dark», в окне — «light».
  const dark = JSON.stringify({ ...(await prefs()), "p-treasury-theme": "dark" });
  await browser.executeAsync((v, done) => window.__TAURI_INTERNALS__.invoke("set_setting", { key: "ui_prefs", value: v }).then(done), dark);
  await browser.refresh();
  await browser.waitUntil(async () => (await theme()) === "dark", { timeout: 10000, timeoutMsg: "тема из базы не применилась" });
  assert.equal(await (await browser.$('[data-testid="theme-dark"]')).getAttribute("aria-pressed"), "true");
});

test("сценарий «что если»: правка сохраняется", async () => {
  await openSection(browser, "Взгляд вперёд");
  await click(browser, "+ Сценарий");
  await click(browser, "Ипотека или кредит", '//*[@role="dialog"]');
  await save(browser);
  await (await browser.$('button[aria-label="Изменить сценарий «Ипотека»"]')).click();
  await fill(browser, "scenario-name", "Ипотека на 20 лет");
  await save(browser);
  await waitText(browser, '[data-testid="scenario-bar"]', /Ипотека на 20 лет/);
  await waitText(browser, '[data-testid="fc-table"] thead', /Ипотека на 20 лет/);
});
