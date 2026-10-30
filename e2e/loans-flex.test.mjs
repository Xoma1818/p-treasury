// Займы 0.20 «Гибкий ввод»: ставка за год, месяц или день, срок в днях, ставка по платежу,
// платежи раз в квартал и своя сумма строки графика.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money, setDate, waitCount } from "./app.mjs";

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "100000" }]);
  await openSection(browser, "Займы и долги");
  await click(browser, "Калькулятор");
});
after(async () => {
  await stop(browser);
});

test("ставка в день и срок в днях: проценты ровно по дням даже в високосный год", async () => {
  await fill(browser, "principal", "10000");
  await choose(browser, "repayment", "Разовый возврат в конце");
  await fill(browser, "rate", "0,5");
  await choose(browser, "ratePeriod", "% в день");
  await setDate(browser, "issueDate", "2028-01-10");
  await fill(browser, "termDays", "30");
  // 10 000 ₽ × 0,5 % × 30 дней = 1 500 ₽.
  await waitText(browser, '[data-testid="loan-payment"]', money("11 500 ₽"));
  await waitText(browser, '[data-testid="loan-form"]', /≈ 182,5 % годовых/);
  assert.equal(await (await browser.$('[name="maturity"]')).getValue(), "2028-02-09");
});

test("рассчитать ставку по платежу из договора", async () => {
  await choose(browser, "repayment", "Аннуитет (равные платежи)");
  await fill(browser, "principal", "300000");
  await choose(browser, "termUnit", "месяцев");
  await fill(browser, "term", "24");
  await (await browser.$('[data-testid="solve-rate"]')).click();
  await fill(browser, "desiredPayment", "14977,23");
  await choose(browser, "ratePeriod", "% годовых");
  await waitText(browser, '[data-testid="loan-rate"]', /18 % годовых/);
  await choose(browser, "ratePeriod", "% в месяц");
  await waitText(browser, '[data-testid="loan-rate"]', /1,5 % в месяц/);
  await (await browser.$('[data-testid="solve-payment"]')).click();
});

test("платежи раз в квартал: 24 месяца — 8 платежей", async () => {
  await fill(browser, "rate", "1,5");
  await choose(browser, "payEvery", "раз в квартал");
  await waitCount(browser, '[data-testid="plan-row"]', 8);
  await choose(browser, "payEvery", "каждый месяц");
  await waitCount(browser, '[data-testid="plan-row"]', 24);
  await waitText(browser, '[data-testid="loan-payment"]', money("14 977,23 ₽"));
});

test("своя сумма строки графика: срок короче, отметка «своя», можно вернуть", async () => {
  await click(browser, "Записать заём");
  await fill(browser, "counterparty", "Гибкий банк");
  await waitText(browser, '[data-testid="debt-preview"]', /1,5 % в месяц/);
  await save(browser);
  await browser.$('//main//h1[contains(., "Гибкий банк")]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="debt-terms"]', /1,5 % в месяц/);
  await waitCount(browser, '[data-testid="schedule-row"]', 24);
  await (await browser.$('[data-testid="row-amount"]')).click();
  await fill(browser, "rowAmount", "60000");
  await save(browser);
  await browser.waitUntil(async () => (await browser.$$('[data-testid="schedule-row"]')).length < 24, { timeout: 5000, timeoutMsg: "срок не сократился" });
  await waitText(browser, '[data-testid="schedule"]', /своя/);
  await (await browser.$('[data-testid="row-amount"]')).click();
  await click(browser, "Вернуть сумму по графику");
  await waitCount(browser, '[data-testid="schedule-row"]', 24);
});
