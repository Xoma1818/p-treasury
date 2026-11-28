// 0.21 «Понятнее и надёжнее»: короткая Главная по умолчанию, предупреждения с
// причиной и действием, «было → станет» у займов, проверка восстановления копии.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, openSettings, onboard, fill, click, clickControl, choose, save, waitText, addHomeCard, saveHomeEditor } from "./app.mjs";

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

test("единый редактор Главной: предпросмотр, отмена, сохранение и возврат к основным карточкам", async () => {
  const ids = () => browser.execute(() => [...document.querySelectorAll(".home-grid > [data-block]")].map((node) => node.dataset.block));
  await browser.$('[data-testid="total-balance"] [data-testid="month-income"]').waitForExist();
  const defaults = await ids();
  assert.deepEqual(defaults.slice(0, 3), ["tiles", "accounts", "recent"]);
  assert.ok(await browser.$('[data-testid="total-balance"] [data-testid="month-expense"]').isExisting());
  await openSettings(browser, "appearance");
  const layout = async () => (await invoke("get_settings")).home_layout;
  const original = await layout();
  await click(browser, "Настроить Главную");
  await addHomeCard(browser, "ahead");
  await browser.$('[data-testid="home-ahead"]').waitForDisplayed();
  assert.equal(await layout(), original, "предпросмотр не записывает раскладку");
  await clickControl(browser, await browser.$('[data-testid="home-cancel"]'), "Отмена");
  await browser.$('[data-testid="home-ahead"]').waitForExist({ reverse: true });
  assert.equal(await layout(), original);
  await click(browser, "Настроить Главную");
  await addHomeCard(browser, "ahead");
  await clickControl(browser, await browser.$('[data-block="recent"] [data-testid="home-half"]'), "Ширина последних операций");
  await saveHomeEditor(browser);
  await browser.$('[data-testid="home-ahead"]').waitForDisplayed({ timeout: 5000 });
  assert.deepEqual(new Set(JSON.parse(await layout()).half), new Set(["tiles", "accounts", "recent"]));
  await browser.refresh();
  await browser.$('main .home-block.half[data-block="recent"]').waitForExist();
  assert.equal(await browser.$('main .home-block[data-block="accounts"]').isExisting(), true);
  await click(browser, "Настроить Главную");
  await clickControl(browser, await browser.$('[data-testid="home-cards-default"]'), "Вернуть по умолчанию");
  await saveHomeEditor(browser);
  await browser.waitUntil(async () => !(await browser.$('[data-testid="home-ahead"]').isExisting()), { timeout: 5000, timeoutMsg: "карточка не скрылась" });
  assert.deepEqual(await ids(), defaults);
});

test("сравнение сохраняет только выбранный вариант и не меняет старую раскладку при отмене", async () => {
  const readLayout = async () => (await invoke("get_settings")).home_layout;
  const tap = async (id) => clickControl(browser, await browser.$(`[data-testid="${id}"]`), id);
  const legacy = JSON.stringify({ v: 2, order: ["main", "tiles", "quick"], half: ["main"], hidden: ["quick"] });
  await invoke("set_setting", { key: "home_layout", value: legacy });
  await browser.refresh();
  await browser.$('.home-grid > [data-block="main"].half').waitForExist();
  await tap("home-customize");
  await tap("home-preview-open");
  await tap("home-preview-overview");
  const preview = '.home-grid[data-preview="overview"]';
  await browser.$(preview + ' [data-testid="total-balance"] [data-testid="month-income"]').waitForExist();
  assert.equal(await readLayout(), legacy);
  assert.equal(await browser.execute((selector) => document.querySelector(selector).closest("[inert]") !== null, preview), true);
  await tap("home-preview-mine");
  await browser.$('.home-grid[data-preview="mine"] > [data-block="main"].half').waitForExist();
  await tap("home-cancel");
  assert.equal(await readLayout(), legacy);
  await tap("home-customize");
  await tap("home-preview-open");
  await tap("home-preview-overview");
  await saveHomeEditor(browser);
  assert.equal(JSON.parse(await readLayout()).composition, "overview");
  await browser.refresh();
  await browser.$('.home-grid > [data-block="tiles"].half [data-testid="month-expense"]').waitForDisplayed();
  assert.ok(await browser.$('.home-grid > [data-block="accounts"].half').isExisting());
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
  await waitText(browser, '[data-testid="warning-row"]', /Общепит: потрачено 95 % бюджета/);
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

test("Enter в последних операциях открывает форму один раз и возвращает фокус без записи", async (t) => {
  await openSection(browser, "Главная");
  const recent = '[data-block="recent"] [data-testid="txn-row"]';
  const editor = '[role="dialog"] form.txn-editor';
  const snapshot = () => invoke("list_transactions", { filter: { limit: 8 } });
  const account = (await invoke("list_accounts", { includeArchived: false })).find(a => a.name === "Карта");
  const category = (await invoke("list_categories", { includeArchived: false })).find(c => c.name === "Общепит");
  await invoke("create_transaction", {
    input: { type: "expense", date: today, accountId: account.id, amount: 3725, categoryId: category.id, toAccountId: null, toAmount: null, payee: "Учебная покупка", note: null },
    eventId: null,
  });
  await browser.refresh();
  await browser.$(recent).waitForDisplayed();
  const before = await snapshot();
  // WebKitGTK наводится на ячейку внутри строки; щелчок по дате всплывает в TR.
  await clickControl(browser, await browser.$(recent + " td.date"), "Дата последней операции");
  await browser.$(editor).waitForDisplayed();
  await browser.keys("Escape");
  await browser.$(editor).waitForExist({ reverse: true });

  await browser.execute(() => {
    window.__observeRowEnter = new AbortController();
    window.__rowEnterSubmits = 0;
    document.addEventListener("submit", (event) => {
      if (event.target.matches("form.txn-editor")) window.__rowEnterSubmits++;
    }, { capture: true, signal: window.__observeRowEnter.signal });
    document.querySelector('[data-testid="home-all-transactions"]').focus();
  });
  t.after(() => browser.execute(() => {
    window.__observeRowEnter.abort();
    delete window.__observeRowEnter;
    delete window.__rowEnterSubmits;
  }));
  await browser.keys("Tab");
  const rowFocused = () => browser.execute(selector => document.activeElement === document.querySelector(selector), recent);
  assert.ok(await rowFocused());
  await browser.keys("Enter");
  await browser.$(editor).waitForDisplayed();
  assert.equal(await browser.execute(() => window.__rowEnterSubmits), 0, "Enter не отправил только что открытую форму");
  await browser.keys("Escape");
  await browser.$(editor).waitForExist({ reverse: true });
  await browser.waitUntil(rowFocused, { timeout: 3000, timeoutMsg: "фокус не вернулся к открытой строке" });
  assert.deepEqual(await snapshot(), before);
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
  await openSettings(browser, "data");
  await waitText(browser, '[data-testid="backup-verified"]', /ещё не проверялась|восстановление проходит/);
  await click(browser, "Сохранить сейчас");
  await waitText(browser, '[data-testid="vault-synced"]', /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  await browser.$('[data-testid="verify-backup"]').click();
  await waitText(browser, '[data-testid="backup-verified"]', /✓[\s\S]*\d\d\.\d\d\.\d{4} \d\d:\d\d: восстановление проходит, счетов \d+, операций \d+/, 10000);
});
