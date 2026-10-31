// 0.21 «Понятнее и надёжнее»: короткая Главная по умолчанию, предупреждения с
// причиной и действием, «было → станет» у займов, проверка восстановления копии.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, click, choose, save, waitText } from "./app.mjs";

let browser;
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  // Главная как после установки: без включения всех карточек.
  ({ browser } = await start(undefined, { homeDefaults: true }));
  await onboard(browser, [{ name: "Карта", balance: "100000" }]);
});
after(async () => {
  await stop(browser);
});

/** Команда ядра напрямую — только для подготовки данных. */
async function invoke(command, args = {}) {
  const result = await browser.executeAsync((cmd, input, done) => {
    window.__TAURI_INTERNALS__.invoke(cmd, input).then(
      (value) => done({ value }),
      (error) => done({ error: String(error) }),
    );
  }, command, args);
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  return result.value;
}

test("Главная по умолчанию: пять основных карточек, остальные включаются в Настройках", async () => {
  await browser.waitUntil(async () => (await browser.$$("main .home-block")).length === 5, { timeout: 5000, timeoutMsg: "не пять карточек" });
  const blocks = await browser.execute(() => [...document.querySelectorAll("main .home-block")].map((b) => b.dataset.block));
  assert.deepEqual(blocks, ["quick", "tiles", "checks", "main", "plans"]);
  await openSection(browser, "Настройки");
  await browser.$('[name="homeCard-ahead"]').click();
  await openSection(browser, "Главная");
  await browser.$('[data-testid="home-ahead"]').waitForDisplayed({ timeout: 5000 });
  await openSection(browser, "Настройки");
  await browser.$('[data-testid="home-cards-default"]').click();
  await openSection(browser, "Главная");
  await browser.waitUntil(async () => !(await browser.$('[data-testid="home-ahead"]').isExisting()), { timeout: 5000, timeoutMsg: "карточка не скрылась" });
});

test("предупреждение бюджета объясняет причину и ведёт к операциям и плану", async () => {
  const card = (await invoke("list_accounts", { includeArchived: false })).find((a) => a.name === "Карта");
  const cafe = (await invoke("list_categories", { includeArchived: false })).find((c) => c.name === "Общепит");
  const period = await invoke("month_of", { date: today });
  const budget = await invoke("create_budget", { month: period.month, copyPrevious: false });
  await invoke("set_budget_limit", { budgetId: budget, categoryId: cafe.id, limit: 1_000_000 });
  for (const amount of [500_000, 450_000]) {
    await invoke("create_transaction", {
      input: { type: "expense", date: today, accountId: card.id, amount, categoryId: cafe.id, toAccountId: null, toAmount: null, payee: "Шоколадница", note: null },
      eventId: null,
    });
  }
  await browser.refresh();
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  await waitText(browser, '[data-testid="warning-row"]', /Кафе и рестораны: потрачено 95 % бюджета/);
  await waitText(browser, '[data-testid="warning-reason"]', /Месяц прошёл на \d+ %, а лимит потрачен на 95 %[\s\S]*«Шоколадница»: 2 из 2/);
  await browser.$('[data-testid="warning-ops"]').click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, "main", /Шоколадница/);
  await openSection(browser, "Главная");
  await browser.$('[data-testid="warning-plan"]').click();
  await browser.$('//main//h1[normalize-space()="Бюджет"]').waitForDisplayed({ timeout: 5000 });
  await browser.$('tr[data-focus="true"][data-category="Общепит"]').waitForExist({ timeout: 5000 });
  const focused = await browser.execute(() => document.activeElement?.getAttribute("name"));
  assert.equal(focused, "limit", "курсор в лимите категории");
});

test("займ: «было → станет» перед сохранением новой ставки", async () => {
  await openSection(browser, "Займы и долги");
  await click(browser, "Калькулятор");
  await fill(browser, "principal", "300000");
  await fill(browser, "rate", "18");
  await choose(browser, "termUnit", "месяцев");
  await fill(browser, "term", "24");
  await click(browser, "Записать заём");
  await fill(browser, "counterparty", "Банк сравнения");
  await save(browser);
  await browser.$('//main//h1[contains(., "Банк сравнения")]').waitForDisplayed({ timeout: 5000 });
  await click(browser, "Ставка изменилась");
  await fill(browser, "newRate", "12");
  await waitText(browser, '[data-testid="cmp-rate"]', /18 % годовых[\s\S]*→[\s\S]*12 % годовых с/);
  await waitText(browser, '[data-testid="cmp-payments"]', /24[\s\S]*→[\s\S]*24/);
  await waitText(browser, '[data-testid="cmp-delta"]', /Экономия на процентах/);
  await browser.keys("Escape");
});

test("копия: «Проверить восстановление» запоминает дату проверенной копии", async () => {
  await openSection(browser, "Настройки");
  await waitText(browser, '[data-testid="backup-verified"]', /ещё не проверялась|восстановление проходит/);
  await click(browser, "Сохранить сейчас");
  await waitText(browser, '[data-testid="vault-synced"]', /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  await browser.$('[data-testid="verify-backup"]').click();
  await waitText(browser, '[data-testid="backup-verified"]', /✓[\s\S]*\d\d\.\d\d\.\d{4} \d\d:\d\d: восстановление проходит, счетов \d+, операций \d+/, 10000);
});
