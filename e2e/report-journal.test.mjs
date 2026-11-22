import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSection, setDate, start, stop, waitText } from "./app.mjs";
import { checkReportJournal } from "./report-journal-case.mjs";

test("Из отчёта в операции и обратно: части расхода, возврат, счёт, тег и свои даты", async t => {
  const dir = mkdtempSync(join(tmpdir(), "kazna-report-journal-"));
  const { browser } = await start(dir, { homeDefaults: true,
    env: { XDG_DATA_HOME: join(dir, "xdg-data"), WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview") } });
  t.after(() => stop(browser));
  const invoke = async (cmd, args = {}) => {
    const result = await browser.executeAsync((name, input, done) => {
      window.__TAURI_INTERNALS__.invoke(name, input).then(value => done({ value }), e => done({ error: String(e) }));
    }, cmd, args);
    assert.equal(result.error, undefined, cmd + ": " + result.error);
    return result.value;
  };
  await browser.$('[name="baseCurrency"]').waitForDisplayed({ timeout: 15000 });
  await invoke("finish_onboarding", { setup: { baseCurrency: "RUB", defaultCategories: true, accounts: [{
    name: "Карта", type: "debit", currencyCode: "RUB", openingBalance: 8000000, openingDate: "2020-01-01",
    creditLimit: null, includeInTotal: true,
  }] } });
  await checkReportJournal({
    invoke, refresh: async () => { await browser.refresh(); await waitText(browser, "main h1", /Главная/); },
    nav: name => openSection(browser, name), click: selector => browser.$(selector).click(),
    press: (label, scope) => browser.$(scope).$('button=' + label).click(),
    choose: (selector, value) => browser.$(selector).selectByAttribute("value", value),
    value: selector => browser.$(selector).getValue(), setDate: (name, value) => setDate(browser, name, value),
    contains: (selector, value) => browser.waitUntil(async () => (await browser.$(selector).getText()).includes(value),
      { timeout: 7000, timeoutMsg: selector + " · " + value }),
    texts: selector => browser.execute(s => [...document.querySelectorAll(s)].map(el => el.innerText), selector),
    privacy: () => browser.keys(["Control", "h"]),
  });
});
