// Приёмка NSIS в чистой виртуальной машине. Оболочка передаёт путь из установленной копии.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { choose, click, fill, money, onboard, openSection, save, start, stop, waitText } from "./app.mjs";

const [phase, bin, scratch, evidence] = process.argv.slice(2);
assert.ok(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" && process.env.KAZNA_INSTALLER_QA === "1",
  "Для проверки установленного приложения требуется одноразовая машина GitHub Actions");
assert.ok(["seed-old", "verify-clean", "verify-upgrade"].includes(phase), "Неизвестный этап проверки установки");
assert.ok([bin, scratch, evidence].every(path => path && isAbsolute(path)), "Нужны полные пути к программе и файлам проверки");
assert.equal(process.env.PTREASURY_DATA_DIR, undefined, "Проверяем штатную папку установленной программы");

const dbPath = join(process.env.APPDATA, "app.kazna.desktop", "budget.db");
const isOld = phase === "seed-old";
const isUpgrade = phase === "verify-upgrade";
assert.equal(existsSync(dbPath), isUpgrade, "Исходная база в профиле должна присутствовать только перед обновлением");
const accountName = "Учебная карта";
const payee = "Проверка установщика";
const monthly = "2026-01";
const global = "2026-02";
const wizard = "//h1[normalize-space()='Основная валюта']";
const home = "//main//h1[normalize-space()='Главная']";

let browser;
async function command(name, args = {}) {
  const reply = await browser.executeAsync((name, args, done) => {
    window.__TAURI_INTERNALS__.invoke(name, args).then(value => done({ value }), e => done({ error: String(e) }));
  }, name, args);
  assert.equal(reply.error, undefined, name + ": " + reply.error);
  return reply.value;
}

async function seed() {
  // Проверка выполняется в локальном бюджете; последующее сравнение охватывает и настройки.
  for (const key of ["rates_auto", "update_check", "vault_on", "weekly_summary"]) {
    await command("set_setting", { key, value: "0" });
  }
  await onboard(browser, [{ name: accountName, type: "Карта", balance: "2700" }]);
  await click(browser, "+ Расход");
  await fill(browser, "amount", "100");
  await choose(browser, "category", "Питание");
  await fill(browser, "payee", payee);
  await save(browser);
  await command("set_invest_plan", { mode: "amount", value: 120000, month: null });
  await command("set_invest_plan", { mode: "amount", value: 34567, month: monthly });
}

async function checkBudget() {
  const accounts = await command("list_accounts", { includeArchived: true });
  assert.equal(accounts.length, 1);
  const [account] = accounts;
  assert.deepEqual([account.name, account.type, account.currencyCode, account.openingBalance, account.balance],
    [accountName, "debit", "RUB", 270000, 260000]);
  await openSection(browser, "Счета");
  await waitText(browser, `//tr[@data-testid="account-row"][.//*[normalize-space()="${accountName}"]]`, money("2 600 ₽"));
  await openSection(browser, "Главная");
  const page = await command("list_transactions", { filter: { limit: 10 } });
  assert.equal(page.total, 1);
  assert.deepEqual(page.items.map(row => [row.accountId, row.payee, row.type, row.amount]),
    [[account.id, payee, "expense", 10000]]);
  for (const [month, value, onlyMonth] of [[monthly, 34567, true], [global, 120000, false]]) {
    const { plan, planned } = await command("invest_month", { month });
    assert.deepEqual([plan.mode, plan.value, plan.onlyMonth], ["amount", value, onlyMonth]);
    if (isUpgrade) {
      assert.equal(plan.currencyCode, null, "Для старого плана сначала требуется подтверждение валюты");
      assert.equal(planned, null, "В валюте основного бюджета нельзя молча интерпретировать старую сумму");
    }
  }
  return {
    accountBalanceMinor: account.balance, transactionCount: page.total, expenseMinor: page.items[0].amount,
    monthlyPlanMinor: 34567, defaultPlanMinor: 120000, planCurrencyNeedsConfirmation: isUpgrade,
  };
}

mkdirSync(scratch, { recursive: true });
try {
  ({ browser } = await start(scratch, {
    bin, args: [], homeDefaults: true,
    env: {
      WEBVIEW2_USER_DATA_FOLDER: join(scratch, "webview"), PTREASURY_VAULT_DIR: join(scratch, "vault"),
      PTREASURY_UPDATE_URL: "",
    },
  }));
  await browser.$(isUpgrade ? home : wizard).waitForDisplayed({ timeout: 30000 });
  const info = await command("app_info");
  assert.equal(info.version, isOld ? "0.42.1" : "0.42.8");
  assert.equal(info.schemaVersion, isOld ? 31 : 32);
  assert.equal(info.supportedSchemaVersion, info.schemaVersion);
  assert.equal(info.portable, false);
  assert.equal(realpathSync.native(info.dbPath).toLowerCase(), realpathSync.native(dbPath).toLowerCase());
  assert.equal(info.onboardingDone, isUpgrade);
  if (isUpgrade) {
    assert.ok(info.preMigrationBackup && existsSync(info.preMigrationBackup), "Нет копии перед обновлением");
  } else {
    assert.equal(info.preMigrationBackup, null);
  }

  let result = {};
  if (isOld) await seed();
  if (isOld || isUpgrade) {
    assert.equal((await command("app_info")).onboardingDone, true);
    result = await checkBudget();
  } else {
    const accounts = await command("list_accounts", { includeArchived: true });
    const journal = await command("list_transactions", { filter: { limit: 1 } });
    assert.equal(accounts.length, 0, "Чистая установка содержит посторонний счёт");
    assert.equal(journal.total, 0, "Чистая установка содержит постороннюю операцию");
    result = { accountCount: accounts.length, transactionCount: journal.total };
  }
  mkdirSync(dirname(evidence), { recursive: true });
  writeFileSync(evidence, JSON.stringify({
    phase, version: info.version, schemaVersion: info.schemaVersion, dbPath: resolve(info.dbPath),
    preMigrationBackup: info.preMigrationBackup, screen: isOld || isUpgrade ? "Главная" : "Основная валюта",
    ...result,
  }) + "\n", { flag: "wx" });
} finally {
  await stop(browser);
}
