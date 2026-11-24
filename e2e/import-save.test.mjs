import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { start, stop, onboard, openSettings, click, choose, waitText } from "./app.mjs";
let browser, dataDir;
before(async () => {
  ({ browser, dataDir } = await start());
  await onboard(browser, [{ name: "Карта", balance: "100000" }]);
});
after(async () => { if (browser) await stop(browser); });

test("сохранение выписки: повторный клик и смена файла не создают второй запрос", async () => {
  const dialog = '//*[@role="dialog"]';
  await openSettings(browser, "data");
  await click(browser, "Импорт выписки или CSV");
  await browser.execute((path) => { window.__ptPick = [path]; }, join(import.meta.dirname, "..", "crates/core/testdata/tbank.csv"));
  await click(browser, "Выбрать файл", dialog);
  await choose(browser, "importAccount", "Карта (₽)");
  await waitText(browser, '[data-testid="import-summary"]', /строк 4, без ошибок 4$/);
  // Delay transport, not business outcome: release calls the real Rust command.
  await browser.execute(() => {
    if (!navigator.webdriver) throw new Error("Import delay requires WebDriver mode");
    window.__saveCalls = 0;
    window.__restoreImportInvoke = () => { window.__releaseImport?.(); delete window.__ptBeforeImport; delete window.__releaseImport; };
    window.__ptBeforeImport = () => {
      window.__saveCalls++;
      return new Promise(resolve => { window.__releaseImport = resolve; });
    };
    const button = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === "Загрузить 4");
    button.click(); button.click();
  });
  try {
    await browser.waitUntil(() => browser.execute(() => window.__saveCalls === 1), { timeout: 5000 });
    assert.equal(await browser.$(`${dialog}//button[normalize-space()="Выбрать файл"]`).isEnabled(), false);
    assert.equal(await browser.$(`${dialog}//button[normalize-space()="Проверить снова"]`).isEnabled(), false);
    assert.equal(await browser.$('[data-testid="open-import-history"]').isEnabled(), false);
    assert.equal(await browser.$(`${dialog}//button[@aria-label="Закрыть"]`).isEnabled(), false);
    assert.equal(await browser.$('select[name="importAccount"]').isEnabled(), false);
    assert.equal(await browser.$(`${dialog}//button[normalize-space()="Загрузить 4"]`).isEnabled(), false);
    await browser.execute(() => { window.__releaseImport(); });
    await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 4/);
    assert.equal(await browser.execute(() => window.__saveCalls), 1);
    await browser.$(`${dialog}//button[normalize-space()="Выбрать файл"]`).waitForEnabled({ timeout: 5000 });
    await click(browser, "Проверить снова", dialog);
    await waitText(browser, '[data-testid="import-summary"]', /уже загружено раньше 4/);
  } finally {
    await browser.execute(() => { window.__restoreImportInvoke(); });
    await browser.keys("Escape");
  }
});

test("выписка сохраняет только предложенную связь и узнаёт исходного получателя при повторе", async () => {
  const dialog = '//*[@role="dialog"]';
  const summary = '[data-testid="import-summary"]';
  const invoke = async (command, args = {}) => {
    const result = await browser.executeAsync((name, input, done) => {
      window.__TAURI_INTERNALS__.invoke(name, input)
        .then((value) => done({ value }), (error) => done({ error: String(error) }));
    }, command, args);
    assert.equal(result.error, undefined, `${command}: ${result.error}`);
    return result.value;
  };
  const accounts = await invoke("list_accounts", { includeArchived: false });
  const card = accounts.find((a) => a.name === "Карта").id;
  const categories = await invoke("list_categories", { includeArchived: false });
  const categoryId = categories.find((c) => c.name === "Питание").id;
  const payee = "Контрольное кафе";
  const amount = 712_507;
  const manual = await invoke("create_transaction", { eventId: null, input: {
    type: "expense", date: "2026-11-19", accountId: card, amount, categoryId,
    toAccountId: null, toAmount: null, payee, note: "Ручная запись до выписки",
  } });
  await invoke("create_rule", { input: { pattern: "qacoffee", categoryId, payee } });

  const first = join(dataDir, "первая-выписка.csv");
  const second = join(dataDir, "повтор-и-новая.csv");
  const header = '"Дата операции";"Номер карты";"Статус";"Сумма операции";"Валюта операции";"Сумма платежа";"Валюта платежа";"Категория";"Описание"';
  const row = (name) => `"20.11.2026 10:00:00";"*1140";"OK";"-7125,07";"RUB";"-7125,07";"RUB";"Супермаркеты";"QAcoffee ${name}"`;
  await writeFile(first, [header, row("A"), ""].join("\n"));
  await writeFile(second, [header, row("B"), row("A"), ""].join("\n"));
  const pick = async (path) => {
    await browser.execute((p) => { window.__ptPick = [p]; }, path);
    await click(browser, "Выбрать файл", dialog);
  };

  await openSettings(browser, "data");
  await click(browser, "Импорт выписки или CSV");
  await pick(first);
  await choose(browser, "importAccount", "Карта (₽)");
  await waitText(browser, summary, /строк 1, без ошибок 1, свяжутся с вашими записями 1/);
  await click(browser, "Связать 1", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 0, связано с вашими записями: 1/);

  await pick(second);
  await waitText(browser, summary, /строк 2, без ошибок 2, уже загружено раньше 1/);
  const duplicates = await browser.execute(() =>
    [...document.querySelectorAll('[data-testid="import-row"]')].map((row) => row.dataset.duplicate));
  assert.deepEqual(duplicates, ["0", "1"]);
  await click(browser, "Загрузить 1", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 1/);
  await pick(second);
  await waitText(browser, summary, /строк 2, без ошибок 2, уже загружено раньше 2/);

  const page = await invoke("list_transactions", { filter: { accountId: card, types: ["expense"], limit: 100 } });
  const purchases = page.items.filter((t) => t.amount === amount);
  assert.equal(purchases.length, 2);
  assert.equal(purchases.find((t) => t.id === manual).note, "Ручная запись до выписки");
});
