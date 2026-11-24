import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { clickControl, money, onboard, openSection, save, start, stop, waitText } from "./app.mjs";
import { holdCommands } from "./hold-commands.mjs";

const dialog = '[role="dialog"]';
const preview = dialog + ' [data-testid="invest-plan-currency-preview"]';
const confirm = dialog + ' [data-testid="invest-plan-currency-confirm"]';
const dataDir = mkdtempSync(join(tmpdir(), "kazna-legacy-invest-"));
const period = offset => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
};
const month = period(0), nextMonth = period(1);
let browser;

// Схема 0.42.6. У старых планов хранится только целое в минимальных единицах.
function seedLegacyPlans() {
  const db = new DatabaseSync(join(dataDir, "budget.db"));
  try {
    const folder = resolve(import.meta.dirname, "../crates/core/migrations");
    const files = readdirSync(folder).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 31).sort();
    assert.equal(files.length, 31);
    for (const file of files) db.exec(readFileSync(join(folder, file), "utf8"));
    db.exec("PRAGMA user_version=31");
    db.exec("UPDATE settings SET value='amount' WHERE key='invest_plan_mode'");
    db.exec("UPDATE settings SET value='1234567' WHERE key='invest_plan_value'");
    db.prepare("INSERT INTO invest_month_plans(month,mode,value) VALUES (?,'amount',?)").run(month, 34567);
  } finally {
    db.close();
  }
}

async function invoke(command, args = {}) {
  const result = await browser.executeAsync((command, args, done) => {
    window.__TAURI_INTERNALS__.invoke(command, args).then(value => done({ value }), e => done({ error: String(e) }));
  }, command, args);
  assert.equal(result.error, undefined, command + ": " + result.error);
  return result.value;
}
const progress = month => invoke("invest_month", { month });
const select = () => browser.$(dialog + ' [name="investPlanCurrency"]');
async function push(selector) {
  const el = await browser.$(selector);
  await el.waitForDisplayed();
  await clickControl(browser, el, selector);
}
async function pick(code) {
  await browser.$(dialog + ' [name="investPlanCurrency"] option[value="' + code + '"]').waitForExist();
  await (await select()).selectByAttribute("value", code);
}
const reveal = () => push(dialog + ' [data-testid="form-amounts-toggle"]');
async function checkPlan(which, raw, code, onlyMonth) {
  const m = await progress(which);
  assert.deepEqual([m.plan.mode, m.plan.value, m.plan.currencyCode, m.plan.onlyMonth], ["amount", raw, code, onlyMonth]);
  assert.equal(m.planned, code ? raw : null);
}

before(async () => {
  seedLegacyPlans();
  ({ browser } = await start(dataDir));
  const info = await invoke("app_info");
  assert.ok(info.schemaVersion >= 32);
  assert.ok(info.preMigrationBackup && existsSync(info.preMigrationBackup), "при обновлении создана копия учебной базы");
  await onboard(browser, [{ name: "Учебная карта", balance: "2700" }]);
  for (const m of [month, nextMonth]) await invoke("create_budget", { month: m, copyPrevious: false });
  await invoke("set_setting", { key: "hide_amounts", value: "1" });
  await browser.refresh();
});
after(async () => { await stop(browser); });

test("обновление схемы 31 сохраняет оба значения, выбор и отмена валюты месяца оставляют их прежними", async () => {
  await checkPlan(month, 34567, null, true);
  await checkPlan(nextMonth, 1234567, null, false);
  await openSection(browser, "Бюджет");
  await waitText(browser, '[data-testid="plan-fact-invest-edit"]', /валюту/i);
  assert.equal(await browser.$('[data-testid="plan-fact-left"]').isExisting(), false);
  await push('[data-testid="plan-fact-invest-edit"]');
  assert.equal(await (await select()).getValue(), "");
  assert.equal(await browser.$(confirm).isEnabled(), false);
  await pick("JPY");
  await waitText(browser, preview, /•••/);
  await reveal();
  await waitText(browser, preview, money("34 567 ¥"));
  await pick("RUB");
  await waitText(browser, preview, /•••/);
  await reveal();
  await waitText(browser, preview, money("345,67 ₽"));
  await browser.keys("Escape");
  await browser.$(dialog).waitForExist({ reverse: true });
  await checkPlan(month, 34567, null, true);
  await checkPlan(nextMonth, 1234567, null, false);
});

test("подтверждение только месяца обратимо и сохраняет отдельную валюту бюджета", async () => {
  await openSection(browser, "Главная");
  await push('[data-testid="invest-plan-edit"]');
  await waitText(browser, dialog + " .muted", /План на /);
  await pick("JPY");
  await reveal();
  await waitText(browser, preview, money("34 567 ¥"));
  await holdCommands(browser, ["confirm_invest_plan_currency"]);
  try {
    await browser.execute(selector => {
      const button = document.querySelector(selector);
      button.click();
      button.click();
    }, confirm);
    await browser.waitUntil(() => browser.execute(() => window.heldCommands.calls.length > 0));
    assert.equal(await browser.$(confirm).isEnabled(), false);
    await browser.keys("Escape");
    assert.equal(await browser.$(dialog).isDisplayed(), true);
    await checkPlan(month, 34567, null, true);
    await browser.execute(() => window.heldCommands.release());
    await browser.$(dialog).waitForExist({ reverse: true });
    assert.deepEqual(await browser.execute(() => window.heldCommands.calls), ["confirm_invest_plan_currency"]);
  } finally {
    await browser.execute(() => window.heldCommands?.restore());
  }
  await checkPlan(month, 34567, "JPY", true);
  await checkPlan(nextMonth, 1234567, null, false);
  await browser.keys(["Control", "z"]);
  await browser.waitUntil(async () => (await progress(month)).plan.currencyCode === null);
  await checkPlan(month, 34567, null, true);
  await browser.keys(["Control", "y"]);
  await browser.waitUntil(async () => (await progress(month)).plan.currencyCode === "JPY");
  await browser.refresh();
  await checkPlan(month, 34567, "JPY", true);
  await checkPlan(nextMonth, 1234567, null, false);
  await openSection(browser, "Бюджет");
  await waitText(browser, '[data-testid="plan-fact-verdict"]', /RUB.*JPY/);
  assert.equal(await browser.$('[data-testid="plan-fact-left"]').isExisting(), false);
});

test("подтверждение общего плана из следующего месяца сохраняет исключение и остаток счёта после перезапуска", async () => {
  await openSection(browser, "Бюджет");
  await push('button[aria-label="Следующий месяц"]');
  await waitText(browser, '[data-testid="plan-fact-invest-edit"]', /валюту/i);
  await push('[data-testid="plan-fact-invest-edit"]');
  await waitText(browser, dialog + " .muted", /Общий план/);
  await pick("RUB");
  await reveal();
  await waitText(browser, preview, money("12 345,67 ₽"));
  await save(browser, "Подтвердить валюту");
  await checkPlan(nextMonth, 1234567, "RUB", false);
  await checkPlan(month, 34567, "JPY", true);
  await browser.keys(["Control", "z"]);
  await browser.waitUntil(async () => (await progress(nextMonth)).plan.currencyCode === null);
  await checkPlan(month, 34567, "JPY", true);
  await browser.keys(["Control", "y"]);
  await browser.waitUntil(async () => (await progress(nextMonth)).plan.currencyCode === "RUB");
  await stop(browser);
  browser = undefined;
  ({ browser } = await start(dataDir));
  await checkPlan(nextMonth, 1234567, "RUB", false);
  await checkPlan(month, 34567, "JPY", true);
  assert.equal((await invoke("list_accounts", { includeArchived: false })).find(a => a.name === "Учебная карта").balance, 270000);
  assert.equal((await invoke("list_transactions", { filter: {} })).total, 0);
});
