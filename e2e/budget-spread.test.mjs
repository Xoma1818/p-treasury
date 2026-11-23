import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, waitText, click, fill, openMore, setDate } from "./app.mjs";
import { checkBudgetSpread } from "./budget-spread-case.mjs";

test("Факт бюджета: 1 000 ₽ списаны один раз и распределены на три периода с 15-го", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kazna-budget-spread-"));
  const { browser } = await start(dir, { homeDefaults: true,
    env: { XDG_DATA_HOME: join(dir, "xdg-data"), WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview") } });
  t.after(() => stop(browser));
  const invoke = async (command, args = {}) => {
    const result = await browser.executeAsync((cmd, input, done) => {
      window.__TAURI_INTERNALS__.invoke(cmd, input).then(value => done({ value }), err => done({ error: String(err) }));
    }, command, args);
    assert.equal(result.error, undefined, command + ": " + result.error);
    return result.value;
  };
  await browser.$('[name="baseCurrency"]').waitForDisplayed({ timeout: 15000 });
  await invoke("finish_onboarding", { setup: { baseCurrency: "RUB", defaultCategories: true, accounts: [{
    name: "Карта", type: "debit", currencyCode: "RUB", openingBalance: 8000000,
    openingDate: "2020-01-01", creditLimit: null, includeInTotal: true,
  }] } });
  await checkBudgetSpread({ invoke, refresh: async () => { await browser.refresh(); await waitText(browser, "main h1", /Главная/); },
    nav: name => openSection(browser, name), click: selector => browser.$(selector).click(),
    contains: (selector, value) => browser.waitUntil(async () => (await browser.$(selector).getText()).includes(value), { timeout: 6000, timeoutMsg: selector + " · " + value }),
    text: selector => browser.$(selector).getText(), privacy: () => browser.keys(["Control", "h"]) });

  // При начале месяца 15-го бюджет называется по месяцу его окончания.
  // Даты фиксированы: этот переход через границу не зависит от даты запуска.
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "1000");
  await setDate(browser, "date", "2026-11-14");
  await openMore(browser);
  await browser.$('[role="dialog"] [name="spreadOn"]').click();
  await setDate(browser, "spreadMonths", "");
  assert.equal(await browser.$('[name="spreadOn"]').isSelected(), true);
  await click(browser, "Сохранить", '//*[@role="dialog"]');
  await waitText(browser, '[role="dialog"] [role="alert"]', /от 2 до 24/);
  await setDate(browser, "spreadMonths", "3");
  const preview = '[data-testid="spread-preview"]';
  await waitText(browser, preview, /ноябрь 2026 – январь 2027/);
  await setDate(browser, "date", "2026-11-15");
  await waitText(browser, preview, /декабрь 2026 – февраль 2027/);
  await click(browser, "Отмена", '//*[@role="dialog"]');
});
