// Обновление 0.11: раздел «Инвестиции» (инвест-копилка). Сценарии из docs/product/mvp-features.md («Версия 0.11»).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, fill, choose, click, save, waitText, money } from "./app.mjs";

const card = '[data-testid="home-invest"]';
let browser;
before(async () => {
  ({ browser } = await start());
  await browser.setWindowSize(1280, 1000);
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
});
after(async () => {
  await stop(browser);
});

test("Главная: план месяца, вложено и стоимость, лимит ИИС и дивиденды", async () => {
  const text = await waitText(browser, card, /Отложено[\s\S]*Вложено[\s\S]*Стоит сейчас[\s\S]*Результат/);
  assert.match(text, /10 % доходов/);
  assert.match(text, /ИИС и ПДС: внесено в \d{4} году/);
  assert.match(text, money("Дивиденды и купоны за год: 1 240 ₽"));
});

test("план суммой: «из 20 000 ₽» на Главной и в Бюджете", async () => {
  await browser.$('[data-testid="invest-plan-edit"]').click();
  await click(browser, "Сумма", '//*[@role="dialog"]');
  await fill(browser, "investPlanAmount", "20000");
  await save(browser);
  await waitText(browser, `${card} [data-testid="invest-month"]`, money("из 20 000 ₽"));
  await openSection(browser, "Бюджет");
  await waitText(browser, '[data-testid="plan-fact-invest"]', money("20 000 ₽"));
  await openSection(browser, "Главная");
});

test("Бюджет: план и факт по доходам, расходам и инвестициям, свой план на месяц", async () => {
  await openSection(browser, "Бюджет");
  const pf = '[data-testid="plan-fact"]';
  const text = await waitText(browser, pf, /Доходы[\s\S]*Расходы[\s\S]*Инвестиции[\s\S]*Остаётся/);
  assert.match(text, /Совпадение с планом \d+ %/);
  assert.match(await browser.$('[data-testid="plan-fact-verdict"]').getText(), /План (сходится|не сходится)/);
  await waitText(browser, '[data-testid="plan-fact-invest"]', money("20 000 ₽"));
  await browser.$('[data-testid="plan-fact-invest-edit"]').click();
  await click(browser, "Сумма", '//*[@role="dialog"]');
  await fill(browser, "investPlanAmount", "30000");
  await browser.$('[role="dialog"] [name="investOnlyMonth"]').click();
  await save(browser);
  await waitText(browser, '[data-testid="plan-fact-invest"]', /план этого месяца[\s\S]*30 000/);
  // Следующий месяц — по общему плану.
  await browser.$('button[aria-label="Следующий месяц"]').click();
  await waitText(browser, '[data-testid="budget-invest"], [data-testid="plan-fact-invest"]', money("20 000 ₽"));
  await browser.$('button[aria-label="Предыдущий месяц"]').click();
  await openSection(browser, "Главная");
  await waitText(browser, `${card} [data-testid="invest-month"]`, money("из 30 000 ₽"));
});

test("стоимость из приложения брокера: результат без доходов и расходов", async () => {
  const income = await browser.$('[data-testid="month-income"]').getText();
  await browser.$('[data-testid="invest-value-open"]').click();
  await fill(browser, "investValue", "250000");
  await waitText(browser, '[data-testid="invest-value-preview"]', /Результат: \+/);
  await save(browser);
  await waitText(browser, '[data-testid="invest-value"]', money("250 000 ₽"));
  await waitText(browser, '[data-testid="invest-result"]', /^\+/);
  assert.equal(await browser.$('[data-testid="month-income"]').getText(), income, "оценка не стала доходом");
  // В общем балансе брокерский счёт — по стоимости.
  await openSection(browser, "Счета");
  const row = '//*[@data-testid="account-row" and .//div[normalize-space()="ИИС"]]';
  await waitText(browser, row, money("250 000 ₽"));
  await waitText(browser, `${row}//*[@data-testid="account-invest-sub"]`, /вложено[\s\S]*оценка/);
});

test("новый брокерский счёт и перевод «Отложить»", async () => {
  await click(browser, "+ Новый счёт");
  await fill(browser, "name", "Т-Инвестиции");
  await choose(browser, "type", "Брокерский счёт / ИИС");
  await choose(browser, "investKind", "Брокерский счёт");
  await save(browser);
  await waitText(browser, "main", /Т-Инвестиции[\s\S]*Брокерский счёт · RUB/);
  await openSection(browser, "Главная");
  const before = await browser.$('[data-testid="invest-saved"]').getText();
  await browser.$('[data-testid="invest-save"]').click();
  await fill(browser, "amount", "1500");
  await save(browser);
  await browser.waitUntil(async () => (await browser.$('[data-testid="invest-saved"]').getText()) !== before, { timeout: 5000 });
});

test("калькулятор: без доходности через 2 года — сумма взносов", async () => {
  await browser.$('[data-testid="invest-calc-open"]').click();
  await fill(browser, "calcStart", "0");
  await fill(browser, "calcMonthly", "10000");
  await fill(browser, "calcRate", "0");
  await fill(browser, "calcYears", "2");
  const iis = await browser.$('[role="dialog"] [name="calcIis"]');
  if (await iis.isSelected()) await iis.click();
  await waitText(browser, '[data-testid="invest-calc-result"]', money("Через 2 года: 240 000 ₽, из них вложено 240 000 ₽"));
  await click(browser, "Закрыть", '//*[@role="dialog"]');
});
