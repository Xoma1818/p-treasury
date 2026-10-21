// Приёмочные тесты этапа 4 «Долги и калькулятор»: сценарии из product/mvp-features.md, раздел 8.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money, setDate } from "./app.mjs";

const now = new Date();
// «До 1 марта»: ближайшее 1 марта в будущем.
const march = `${now.getMonth() >= 2 ? now.getFullYear() + 1 : now.getFullYear()}-03-01`;

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

const card = `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="Карта"]]`;
const debtRow = (name) => `//tr[@data-testid="debt-row" and @data-name="${name}"]`;

async function openDebt(name) {
  await openSection(browser, "Займы и долги");
  await (await browser.$(`${debtRow(name)}//div[@class="main"]`)).click();
  await browser.$(`//main//h1[contains(., "${name}")]`).waitForDisplayed({ timeout: 5000 });
}

test("выбор кредита: калькулятор сравнивает аннуитет и дифференцированный", async () => {
  await openSection(browser, "Займы и долги");
  await click(browser, "Калькулятор");
  await waitText(browser, '[data-testid="calc-annuity"]', money("14 977,23 ₽"));
  await waitText(browser, '[data-testid="calc-annuity"] [data-testid="overpay"]', /59 45\d,\d\d ₽/);
  await waitText(browser, '[data-testid="calc-differentiated"] [data-testid="overpay"]', money("56 250 ₽"));
  // Дифференцированный дешевле, но первый платёж выше.
  await waitText(browser, '[data-testid="calc-differentiated"]', /дешевле на/);
  await waitText(browser, '[data-testid="calc-differentiated"]', money("17 000 ₽"));
  // Срок 12 месяцев: график пересчитывается сразу.
  await fill(browser, "calcTerm", "12");
  await waitText(browser, '[data-testid="calc-annuity"]', money("27 504 ₽"));
  await fill(browser, "calcTerm", "24");
  await waitText(browser, '[data-testid="calc-annuity"]', money("14 977,23 ₽"));
});

test("кредит в банке: «Сохранить как долг», деньги пришли на карту, график на 24 месяца", async () => {
  await click(browser, "Сохранить как долг", '//*[@data-testid="calc-annuity"]');
  await fill(browser, "counterparty", "Банк");
  await choose(browser, "account", "Карта (₽)");
  await waitText(browser, '[data-testid="debt-preview"]', money("14 977,23 ₽"));
  await save(browser);
  await waitText(browser, '[data-testid="debt-next"]', money("14 977,23 ₽"));
  assert.equal((await browser.$$('[data-testid="schedule-row"]')).length, 24);
  await openSection(browser, "Счета");
  await waitText(browser, card, money("400 000 ₽"));
});

test("«Оплачено»: перевод в основной долг и расход на проценты 4 500 ₽", async () => {
  await openDebt("Банк");
  await click(browser, "Оплачено");
  assert.equal(await (await browser.$('[role="dialog"] [name="principal"]')).getValue(), "10477,23");
  assert.equal(await (await browser.$('[role="dialog"] [name="interest"]')).getValue(), "4500");
  await save(browser);
  await waitText(browser, '//tr[@data-testid="schedule-row"][1]', /оплачен/);
  await waitText(browser, '[data-testid="debt-outstanding"]', money("289 522,77 ₽"));
  await waitText(browser, '[data-testid="debt-interest"]', money("4 500 ₽"));
  await openSection(browser, "Главная");
  // В расходы попали только проценты, основной долг — перевод.
  await waitText(browser, '[data-testid="month-expense"]', money("4 500 ₽"));
  await openSection(browser, "Счета");
  await waitText(browser, card, money("385 022,77 ₽"));
});

test("досрочный платёж «уменьшить срок»: платёж прежний, платежей меньше", async () => {
  await openDebt("Банк");
  await click(browser, "Досрочный платёж");
  await fill(browser, "principal", "100000");
  await fill(browser, "interest", "0");
  await choose(browser, "recalcMode", "Уменьшить срок, платёж прежний");
  await save(browser);
  await waitText(browser, '[data-testid="debt-outstanding"]', money("189 522,77 ₽"));
  await waitText(browser, '[data-testid="debt-next"]', money("14 977,23 ₽"));
  const rows = (await browser.$$('[data-testid="schedule-row"]')).length;
  assert.ok(rows < 24, `платежей ${rows}`);
});

test("занял другу: Иван вернул 5 000 из 20 000, остаток 15 000", async () => {
  await openSection(browser, "Займы и долги");
  await click(browser, "+ Новый долг");
  await click(browser, "Я дал в долг", '//*[@role="dialog"]');
  await fill(browser, "counterparty", "Иван");
  await fill(browser, "principal", "20000");
  await choose(browser, "account", "Карта (₽)");
  await choose(browser, "repayment", "Разовый возврат в конце");
  await setDate(browser, "maturity", march);
  await waitText(browser, '[data-testid="debt-preview"]', money("К возврату 20 000 ₽"));
  await save(browser);
  await waitText(browser, '[data-testid="debt-outstanding"]', money("20 000 ₽"));

  await click(browser, "Частичный возврат");
  await fill(browser, "principal", "5000");
  await save(browser);
  await waitText(browser, '[data-testid="debt-outstanding"]', money("15 000 ₽"));
  await waitText(browser, '[data-testid="payments"]', money("5 000 ₽"));
  await waitText(browser, '[data-testid="schedule"]', new RegExp(`01\\.03\\.${march.slice(0, 4)}`));
});

test("сколько мне должны: сводка, ближайший платёж и чистые активы", async () => {
  await openSection(browser, "Займы и долги");
  await waitText(browser, '[data-testid="owed-to-me"]', money("15 000 ₽"));
  await waitText(browser, '[data-testid="i-owe"]', money("189 522,77 ₽"));
  await waitText(browser, '[data-testid="upcoming"]', /Банк/);
  // Счета: карта 385 022,77 − 100 000 − 20 000 + 5 000 = 270 022,77; чистые активы = 270 022,77 + 15 000 − 189 522,77.
  await waitText(browser, '[data-testid="net-worth"]', money("95 500 ₽"));
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="home-net-worth"]', money("95 500 ₽"));
  await waitText(browser, '[data-testid="home-upcoming"]', /Банк/);
});

test("удаление платежа возвращает остаток и деньги на карте", async () => {
  await openDebt("Иван");
  await (await browser.$('[data-testid="payments"] button[title^="Удалить платёж"]')).click();
  await waitText(browser, '[data-testid="debt-outstanding"]', money("20 000 ₽"));
  await openSection(browser, "Счета");
  await waitText(browser, card, money("265 022,77 ₽"));
});

test("удаление долга убирает его операции", async () => {
  await openDebt("Иван");
  await click(browser, "Удалить долг");
  await click(browser, "Да, удалить");
  await browser.$('//main//h1[normalize-space()="Займы и долги"]').waitForDisplayed({ timeout: 5000 });
  assert.equal(await browser.$(debtRow("Иван")).isExisting(), false);
  await waitText(browser, '[data-testid="owed-to-me"]', money("0 ₽"));
  await openSection(browser, "Счета");
  await waitText(browser, card, money("285 022,77 ₽"));
});
