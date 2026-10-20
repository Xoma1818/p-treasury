// Большой итоговый тест, пункт 3: данные старой версии открываются новой.
// Старая программа (PTREASURY_OLD_BIN, например сборка этапа 5 — версия 0.5, схема данных 1)
// заполняет данные, затем новая открывает ту же папку: копия перед обновлением сделана,
// балансы, отчёты и долги не изменились. Без PTREASURY_OLD_BIN тест пропускается.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money } from "./app.mjs";

const OLD = process.env.PTREASURY_OLD_BIN;
const ready = OLD && existsSync(OLD);
let browser, dataDir;
after(async () => {
  if (browser) await stop(browser);
});

async function figures() {
  const f = {};
  await openSection(browser, "Счета");
  f.accounts = await browser.execute(() => [...document.querySelectorAll('[data-testid="account-row"]')].map((r) => r.textContent));
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="month-expense"]', /₽/);
  f.total = await (await browser.$('[data-testid="total-balance"]')).getText();
  f.expense = await (await browser.$('[data-testid="month-expense"]')).getText();
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="report-expense"]', /₽/);
  f.report = await (await browser.$('[data-testid="report-balance"]')).getText();
  await openSection(browser, "Долги");
  await waitText(browser, '[data-testid="debt-card"]', /Банк/).catch(() => {});
  f.debts = await (await browser.$("main")).getText();
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  f.txns = await (await browser.$('[data-testid="txn-count"]')).getText();
  return f;
}

test("данные версии 0.5 открываются новой версией без потерь", { skip: !ready && "нет PTREASURY_OLD_BIN" }, async () => {
  ({ browser, dataDir } = await start(undefined, { bin: OLD }));
  await onboard(browser, [
    { name: "Наличные", balance: "3000" },
    { name: "Карта", balance: "80000" },
  ]);
  for (const [amount, category] of [["2340", "Продукты"], ["6230", "Жильё"], ["1890", "Кафе и рестораны"]]) {
    await click(browser, "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта (₽)");
    await choose(browser, "category", category);
    await save(browser);
  }
  await openSection(browser, "Долги");
  await click(browser, "+ Новый долг");
  await fill(browser, "counterparty", "Банк");
  await fill(browser, "principal", "300000");
  await fill(browser, "rate", "18");
  await fill(browser, "term", "24");
  await choose(browser, "account", "Карта (₽)");
  await save(browser);
  await waitText(browser, '[data-testid="debt-next"]', money("14 977,23 ₽"));
  const old = await figures();
  await openSection(browser, "Настройки");
  await waitText(browser, '//h2[normalize-space()="О программе"]/..', /1 из 1/);
  await stop(browser);

  // Новая версия на той же папке данных.
  ({ browser } = await start(dataDir));
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 15000 });
  const now = await figures();
  assert.deepEqual(now, old);
  await openSection(browser, "Настройки");
  const about = '//h2[normalize-space()="О программе"]/..';
  await waitText(browser, about, /2 из 2/);
  await waitText(browser, about, /Копия перед обновлением/);
  const copies = readdirSync(join(dataDir, "backups")).filter((f) => f.startsWith("before-update-"));
  assert.equal(copies.length, 1, String(copies));
});
