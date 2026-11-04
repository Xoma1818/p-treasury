// Правки и удаления, которые раньше не проходил ни один сквозной тест (тред 29, 04.11.2026):
// счёт, категория, заметка, курс. Каждый тест проверяет результат на экране, а не только нажатие.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, click, save, waitText, waitContent, money, mainText, setDate, choose } from "./app.mjs";

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
