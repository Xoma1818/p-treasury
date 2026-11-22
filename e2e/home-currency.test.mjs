import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, choose, money, waitText } from "./app.mjs";

test("Главная и расшифровка баланса совпадают для основной валюты без копеек", async (t) => {
  // Настройка «Кодом» хранится также в профиле окна, отдельно от учебной базы.
  const dir = mkdtempSync(join(tmpdir(), "kazna-e2e-yen-"));
  const { browser } = await start(dir, {
    homeDefaults: true,
    env: { XDG_DATA_HOME: join(dir, "xdg-data"), WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview") },
  });
  t.after(() => stop(browser));
  await browser.$('[name="baseCurrency"]').waitForDisplayed({ timeout: 15000 });
  // Такой набор возможен после восстановления старых данных, где JPY уже использовалась.
  const error = await browser.executeAsync((done) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    invoke("app_info").then(({ today }) => invoke("finish_onboarding", { setup: {
      baseCurrency: "JPY", defaultCategories: true, accounts: [{
        name: "Счёт в иенах", type: "debit", currencyCode: "JPY", openingBalance: 12_345,
        openingDate: today, creditLimit: null, includeInTotal: true,
      }],
    } })).then(() => done(null), (err) => done(String(err)));
  });
  assert.equal(error, null);
  await browser.refresh();
  await waitText(browser, "main h1", /Главная/);
  await openSection(browser, "Настройки");
  const fine = await browser.$('[data-testid="fine-card"]');
  await fine.waitForExist({ timeout: 5000 });
  if (!(await browser.execute((card) => card.open, fine))) await fine.$("summary").click();
  await choose(browser, "fineCode", "Кодом: 1 200 RUB");
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="explain-balance"]', money("12 345 JPY"));
  await waitText(browser, '[data-testid="home-free"]', money("12 345 JPY"));
  await browser.$('[data-testid="explain-balance"]').click();
  await waitText(browser, '[data-testid="explain-row"][data-status="in"]', money("12 345 JPY"));
  await waitText(browser, '[data-testid="explain-total"]', money("12 345 JPY"));
});
