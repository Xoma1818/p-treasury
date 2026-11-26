import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, waitText, chooseLike } from "./app.mjs";

test("быстрый ввод очищает черновик, статус и счета при смене или восстановлении бюджета", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kazna-quick-budgets-"));
  const { browser } = await start(dir, { env: {
    XDG_DATA_HOME: join(dir, "xdg-data"), WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
  } });
  t.after(() => stop(browser));
  const main = await browser.getWindowHandle();
  const invoke = async (cmd, args = {}) => {
    const result = await browser.executeAsync((command, input, done) => {
      window.__TAURI_INTERNALS__.invoke(command, input).then(value => done({ value }), e => done({ error: String(e) }));
    }, cmd, args);
    if (result.error) throw Error(result.error);
    return result.value;
  };
  const setup = name => invoke("finish_onboarding", { setup: {
    baseCurrency: "RUB", defaultCategories: true,
    accounts: [{ name, type: "debit", currencyCode: "RUB", openingBalance: 1000000,
      openingDate: "2020-01-01", creditLimit: null, includeInTotal: true }],
  } });
  const field = '[name="quickText"]';
  const quick = async () => {
    await invoke("open_quick");
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, { timeout: 15000 });
    const handle = (await browser.getWindowHandles()).find(h => h !== main);
    await browser.switchToWindow(handle);
    await browser.$(field).waitForDisplayed({ timeout: 10000 });
    return handle;
  };
  const assertCleared = async old => {
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(old), { timeout: 10000 });
    const fresh = await quick();
    assert.equal(await browser.$(field).getValue(), "");
    assert.equal(await browser.$('[data-testid="quick-draft"]').isExisting(), false);
    assert.equal(await browser.$('[data-testid="quick-saved"]').isExisting(), false);
    return fresh;
  };
  const draft = async (text, account, excluded) => {
    await browser.$(field).setValue(text);
    const choices = () => browser.execute(() =>
      [...document.querySelectorAll('[name="quickAccount"] option')].map(option => option.text).join("\n"));
    await browser.waitUntil(async () => (await choices()).includes(account), { timeout: 8000 });
    assert.doesNotMatch(await choices(), new RegExp(excluded));
  };
  await browser.$('[name="baseCurrency"]').waitForDisplayed({ timeout: 15000 });
  const a = "Карта первого бюджета", b = "Карта второго бюджета";
  const backupA = join(dir, "первый.ptreasury"), backupB = join(dir, "второй.ptreasury");
  await setup(a);
  await invoke("backup_now", { path: backupA });
  const windowA = await quick();
  await draft("покупка 640", a, b);
  await browser.switchToWindow(main);
  // Сбой восстановления и повторный вызов прежнего окна сохраняют черновик.
  await assert.rejects(invoke("restore_backup", { path: join(dir, "нет.ptreasury") }));
  assert.equal(await quick(), windowA);
  assert.equal(await browser.$(field).getValue(), "покупка 640");
  // Успешная замена при открытом черновике: новый WebView и новые счета.
  await browser.switchToWindow(main);
  await invoke("create_file", { name: "Второй бюджет" });
  await setup(b);
  await invoke("set_setting", { key: "hide_amounts", value: "1" });
  await invoke("backup_now", { path: backupB });
  const windowB = await assertCleared(windowA);
  await draft("расход 420", b, a);
  await chooseLike(browser, "quickAccount", `${b} (₽)`);
  await chooseLike(browser, "quickCategory", "Питание");
  await browser.$('[data-testid="quick-draft"] button.btn').click();
  await waitText(browser, '[data-testid="quick-saved"]', /^Операция записана\.$/);
  // Скрытое окно с сообщением об успехе: восстановление в тот же путь также меняет контекст.
  await invoke("hide_quick", { saved: false });
  await browser.switchToWindow(main);
  const pathB = (await invoke("app_info")).dbPath;
  await invoke("restore_backup", { path: backupA });
  assert.equal((await invoke("app_info")).dbPath, pathB);
  const restored = await assertCleared(windowB);
  await draft("другая покупка 300", a, b);
  // Перенос из папки сохранности заменяет содержимое того же файла.
  await browser.switchToWindow(main);
  const found = await invoke("vault_inspect", { path: backupB });
  await invoke("vault_transfer", { found });
  await assertCleared(restored);
  await draft("покупка 100", b, a);
  await browser.switchToWindow(main);
});
