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
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__saveCalls = 0;
    window.__restoreImportInvoke = () => { window.__TAURI_INTERNALS__.invoke = original; };
    window.__TAURI_INTERNALS__.invoke = function(command, args, ...rest) {
      if (command !== "import_csv") return original.call(this, command, args, ...rest);
      window.__saveCalls++;
      return new Promise((resolve, reject) => {
        window.__releaseImport = () => original.call(this, command, args, ...rest).then(resolve, reject);
      });
    };
    const button = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === "Загрузить 4");
    button.click(); button.click();
  });
  try {
    await browser.waitUntil(() => browser.execute(() => window.__saveCalls === 1), { timeout: 5000 });
    assert.equal(await browser.$(`${dialog}//button[normalize-space()="Выбрать файл"]`).isEnabled(), false);
    assert.equal(await browser.$(`${dialog}//button[normalize-space()="Проверить снова"]`).isEnabled(), false);
    assert.equal(await browser.$('select[name="importAccount"]').isEnabled(), false);
    assert.equal(await browser.$(`${dialog}//button[normalize-space()="Загрузить 4"]`).isEnabled(), false);
    await browser.execute(() => { window.__releaseImport(); });
    await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 4/);
    assert.equal(await browser.execute(() => window.__saveCalls), 1);
    assert.equal(await browser.$(`${dialog}//button[normalize-space()="Выбрать файл"]`).isEnabled(), true);
    await click(browser, "Проверить снова", dialog);
    await waitText(browser, '[data-testid="import-summary"]', /уже загружено раньше 4/);
  } finally {
    await browser.execute(() => { window.__restoreImportInvoke(); });
  }
});
