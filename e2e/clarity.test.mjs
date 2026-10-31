// 0.22 «Понятные цифры»: «Как посчитано» у плиток Главной, сопоставление строк
// выписки с записанными вручную покупками, разбор сомнительных совпадений и
// история импорта с отменой. Окно выбора файла не нажимается: путь
// подкладывается в window.__ptPick.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { start, stop, openSection, onboard, click, choose, waitText, waitCount, money } from "./app.mjs";

const fixtures = join(import.meta.dirname, "..", "crates/core/testdata");
const dialog = '//*[@role="dialog"]';

let browser;
const pick = (...paths) => browser.execute((p) => (window.__ptPick = p), paths);
const invoke = async (command, args = {}) => {
  const result = await browser.executeAsync((cmd, input, done) => {
    window.__TAURI_INTERNALS__.invoke(cmd, input).then((value) => done({ value }), (error) => done({ error: String(error) }));
  }, command, args);
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  return result.value;
};

let card;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "100000" }]);
  card = (await invoke("list_accounts", { includeArchived: false })).find((a) => a.name === "Карта").id;
  const cats = await invoke("list_categories", { includeArchived: false });
  const cat = (name) => cats.find((c) => c.name === name).id;
  const add = (date, amount, category, payee, note = null) =>
    invoke("create_transaction", {
      input: { type: "expense", date, accountId: card, amount, categoryId: cat(category), toAccountId: null, toAmount: null, payee, note },
      eventId: null,
    });
  // Выписка tbank.csv: «Пятерочка» 1 053,77 за 20.10, Steam 1 200 за 18.10.
  await add("2026-10-19", 105_377, "Питание", "Питание", "на неделю");
  // Две записи по 1 200 рядом с Steam: какая из них — неясно, спросим.
  await add("2026-10-17", 120_000, "Досуг", "Игра");
  await add("2026-10-19", 120_000, "Досуг", "Игра другу");
});
after(async () => {
  await stop(browser);
});

test("строка выписки узнаёт ручную запись, сомнительная — ждёт подтверждения", async () => {
  await openSection(browser, "Настройки");
  await click(browser, "Импорт выписки или CSV");
  await pick(join(fixtures, "tbank.csv"));
  await click(browser, "Выбрать файл", dialog);
  await choose(browser, "importAccount", "Карта (₽)");
  await waitText(browser, '[data-testid="import-summary"]', /свяжутся с вашими записями 1, спросим про совпадения 1/);
  await waitCount(browser, '[data-testid="import-row"][data-linked="1"]', 1);
  await click(browser, "Загрузить 3", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 3, связано с вашими записями: 1\. Совпадений на проверку: 2/);

  await click(browser, "Разобрать", dialog);
  await waitCount(browser, '[data-testid="match"]', 2);
  await (await browser.$('[data-testid="match-accept"]')).click();
  await waitText(browser, '[data-testid="matches-empty"]', /Всё разобрано/);
  await browser.keys("Escape");

  // Своя запись с заметкой осталась, покупка не задвоилась.
  const page = await invoke("list_transactions", { filter: { accountId: card, types: ["expense"], limit: 100 } });
  assert.equal(page.items.filter((t) => t.amount === 105_377).length, 1);
  assert.equal(page.items.find((t) => t.amount === 105_377).note, "на неделю");
  assert.equal(page.items.filter((t) => t.amount === 120_000).length, 2, "Steam связан с одной из двух записей");
});

test("история импорта: счётчики и отмена импорта целиком", async () => {
  await click(browser, "История импорта");
  await waitCount(browser, '[data-testid="history-row"]', 1);
  await waitText(browser, '[data-testid="history-row"]', /tbank\.csv\s*выписка Т-Банк\s*2\s*2\s*0\s*Операции/);
  await (await browser.$('[data-testid="history-undo"]')).click();
  await waitText(browser, '[data-testid="history-confirm"]', /Удалить операции этого импорта \(2\)/);
  await (await browser.$('[data-testid="history-undo-yes"]')).click();
  await waitText(browser, '[data-testid="history-row"]', /отменён/);
  await browser.keys("Escape");
  const page = await invoke("list_transactions", { filter: { accountId: card, limit: 100 } });
  assert.deepEqual(page.items.map((t) => t.amount).sort(), [105_377, 120_000, 120_000].sort(), "остались только ручные записи");
});

test("«Как посчитано»: расходы месяца раскладываются по категориям ровно в итог плитки", async () => {
  await invoke("create_transaction", {
    input: { type: "expense", date: new Date().toISOString().slice(0, 10), accountId: card, amount: 50_000, categoryId: (await invoke("list_categories", { includeArchived: false })).find((c) => c.name === "Питание").id, toAccountId: null, toAmount: null, payee: "Рынки", note: null },
    eventId: null,
  });
  await openSection(browser, "Главная");
  const tile = await browser.$('[data-testid="explain-expense"]');
  await waitText(browser, '[data-testid="explain-expense"]', /\d/);
  await browser.pause(1500); // сумма на плитке «набегает»
  const shown = (await tile.getText()).trim();
  await tile.click();
  // Сумма разбора совпадает с суммой на плитке.
  await waitText(browser, '[data-testid="explain-total"]', money(shown));
  await waitText(browser, '[data-testid="explain"]', /Продукты/);
  await browser.keys("Escape");

  await (await browser.$('[data-testid="explain-balance"]')).click();
  await waitText(browser, '[data-testid="explain-row"]', /Карта/);
  await browser.keys("Escape");
});
