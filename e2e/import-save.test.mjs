import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { start, stop, onboard, openSection, click, choose, waitText } from "./app.mjs";
let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "100000" }]);
});
after(async () => { if (browser) await stop(browser); });

test("сохранение выписки: повторный клик и смена файла не создают второй запрос", async () => {
  const dialog = '//*[@role="dialog"]';
  await openSection(browser, "Настройки");
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
  }
});
