// Обновление 0.10, этап 1: пример данных, бюджет по среднему и прогноз, подушка,
// курсовая разница, сохранённые виды. Сценарии из docs/product/mvp-features.md («Версия 0.10»).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, waitText, setDate } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let browser;
before(async () => {
  ({ browser } = await start());
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
});
after(async () => {
  await stop(browser);
});

test("«Посмотреть на примере» открывает приложение с данными и плашкой примера", async () => {
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  await waitText(browser, '[data-testid="demo-banner"]', /Это пример/);
  await waitText(browser, '[data-testid="total-balance"]', /\d/);
});

test("финансовая подушка: сколько месяцев хватит денег и цель", async () => {
  const text = await waitText(browser, '[data-testid="home-cushion"]', /Денег хватит на \d+,\d/);
  assert.match(text, /в месяц \(за 3 мес\.\)/);
  await choose(browser, "cushionGoal", "12 мес.");
  await browser.waitUntil(async () => (await (await browser.$('[name="cushionGoal"]')).getValue()) === "12", { timeout: 5000 });
});

test("бюджет: прогноз на конец месяца и заполнение по среднему за 3 месяца", async () => {
  await openSection(browser, "Бюджет");
  await waitText(browser, '[data-testid="budget-forecast"]', /При таком темпе к концу месяца (останется|перерасход)/);
  await click(browser, "По среднему за 3 месяца");
  await waitText(browser, '[data-testid="budget-filled"]', /Обновлено лимитов: \d+/);
  // «Как в прошлом году»: год назад операций нет, ошибка понятная.
  await click(browser, "Как в прошлом году");
  await waitText(browser, '[data-testid="budget-expense"]', /год назад в этом месяце операций нет/);
});

test("курсовая разница: доллары куплены по 91,5, разница считается за период", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Курсовая разница", '//*[@role="tablist"]');
  await choose(browser, "periodKind", "Произвольный");
  await setDate(browser, "reportFrom", iso(new Date(now.getFullYear(), now.getMonth() - 3, 1)));
  const row = '//*[@data-testid="fx-row" and @data-account="Доллары"]';
  await waitText(browser, row, /91,5/);
  await waitText(browser, `${row}//*[@data-testid="fx-gain"]`, /\+\d/);
  await waitText(browser, '[data-testid="fx-total"]', /Итого за период: \+/);
});

test("сохранённый вид отчёта открывает ту же вкладку одним нажатием", async () => {
  await click(browser, "☆ Сохранить вид");
  await fill(browser, "viewName", "Валюта");
  await click(browser, "Сохранить");
  await click(browser, "Структура", '//*[@role="tablist"]');
  await browser.$('[data-testid="fx-report"]').waitForExist({ timeout: 5000, reverse: true });
  await click(browser, "Валюта", '//*[@data-testid="views-report"]');
  await browser.$('[data-testid="fx-report"]').waitForExist({ timeout: 5000 });
  // Тот же вид открывается из бокового меню («Мои виды») из любого раздела.
  await openSection(browser, "Главная");
  await (await browser.$('//*[@data-testid="nav-views"]//button[contains(., "Валюта")]')).click();
  await browser.$('//main//h1[normalize-space()="Отчёты"]').waitForDisplayed({ timeout: 5000 });
  await browser.$('[data-testid="fx-report"]').waitForExist({ timeout: 5000 });
});

test("сохранённый вид операций: «Кафе» возвращает фильтр после сброса", async () => {
  await openSection(browser, "Операции");
  await choose(browser, "filterCategory", "Кафе и рестораны");
  const filtered = await waitText(browser, '[data-testid="txn-count"]', /Показано \d+ из \d+/);
  await click(browser, "☆ Сохранить вид");
  await fill(browser, "viewName", "Кафе");
  await click(browser, "Сохранить");
  await click(browser, "Сбросить");
  await browser.waitUntil(async () => (await (await browser.$('[name="filterCategory"]')).getValue()) === "", { timeout: 5000 });
  await click(browser, "Кафе", '//*[@data-testid="views-transactions"]');
  await browser.waitUntil(async () => (await (await browser.$('[name="filterCategory"]')).getValue()) !== "", { timeout: 5000 });
  await waitText(browser, '[data-testid="txn-count"]', new RegExp(filtered.replace(/[()]/g, ".")));
  // Из бокового меню: с Главной сразу в операции с этим фильтром.
  await openSection(browser, "Главная");
  await (await browser.$('//*[@data-testid="nav-views"]//button[contains(., "Кафе")]')).click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="txn-count"]', new RegExp(filtered.replace(/[()]/g, ".")));
  // Удаление вида.
  await (await browser.$('button[aria-label="Удалить вид «Кафе»"]')).click();
  await browser.$('//*[@data-testid="views-transactions"]//button[normalize-space()="Кафе"]').waitForExist({ timeout: 5000, reverse: true });
});

test("«Удалить пример и начать своё» возвращает мастер первого запуска", async () => {
  await click(browser, "Удалить пример и начать своё");
  await click(browser, "Да, удалить пример");
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "1000" },
  ]);
  assert.equal(await browser.$('[data-testid="demo-banner"]').isExisting(), false);
  await openSection(browser, "Операции");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 0 из 0/);
});
