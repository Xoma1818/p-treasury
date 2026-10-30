// Большой итоговый тест, пункт 3: данные старой версии открываются новой.
// Старая программа (PTREASURY_OLD_BIN: первый выпуск 0.11.1 со схемой 5 или 0.16.0 со схемой 9)
// заполняет данные, затем новая открывает ту же папку: копия перед обновлением сделана,
// балансы, отчёты и долги не изменились. Без PTREASURY_OLD_BIN тест пропускается.
// Старую версию собирать в отдельный --target-dir, иначе она затрёт target/debug/budget-app.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money } from "./app.mjs";

const OLD = process.env.PTREASURY_OLD_BIN;
// Последняя версия схемы данных: по числу миграций ядра.
const LATEST = readdirSync(new URL("../crates/core/migrations/", import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
const ready = OLD && existsSync(OLD);
// В CI старая сборка обязательна: пропуск не должен выглядеть как успешная проверка.
if (process.env.PTREASURY_REQUIRE_OLD === "1" && !ready) {
  throw new Error(`нет старой сборки PTREASURY_OLD_BIN: ${OLD ?? "не задана"}`);
}
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
  // Плашка «−3 %» (сравнение с прошлым месяцем) есть только в новых версиях — сравниваем суммы.
  f.total = (await (await browser.$('[data-testid="total-balance"]')).getText()).replace(/[−+]?\d+ %/, "");
  f.expense = await (await browser.$('[data-testid="month-expense"]')).getText();
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="report-expense"]', /₽/);
  f.report = await (await browser.$('[data-testid="report-balance"]')).getText();
  await openSection(browser, "Займы и долги");
  await waitText(browser, '[data-testid="debt-card"]', /Банк/).catch(() => {});
  f.debts = await (await browser.$("main")).getText();
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  f.txns = await (await browser.$('[data-testid="txn-count"]')).getText();
  return f;
}

test("данные старой версии открываются новой версией без потерь", { skip: !ready && "нет PTREASURY_OLD_BIN" }, async () => {
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
  await openSection(browser, "Займы и долги");
  if (await browser.$('//main//button[normalize-space()="Калькулятор"]').isExisting()) {
    // С 0.16 кредит записывается из калькулятора; проценты по дням от сегодняшней выдачи.
    await click(browser, "Калькулятор");
    await fill(browser, "principal", "300000");
    await fill(browser, "rate", "18");
    await choose(browser, "termUnit", "месяцев");
    await fill(browser, "term", "24");
    await click(browser, "Записать заём");
    await fill(browser, "counterparty", "Банк");
    await choose(browser, "account", "Карта (₽)");
    await save(browser);
    await waitText(browser, '[data-testid="debt-next"]', /\d[\d\s]*,\d\d\s₽/);
  } else {
    await click(browser, "+ Новый долг");
    await fill(browser, "counterparty", "Банк");
    await fill(browser, "principal", "300000");
    await fill(browser, "rate", "18");
    await fill(browser, "term", "24");
    await choose(browser, "account", "Карта (₽)");
    await save(browser);
    await waitText(browser, '[data-testid="debt-next"]', money("14 977,23 ₽"));
  }
  const old = await figures();
  await openSection(browser, "Настройки");
  const before = await waitText(browser, '//h2[normalize-space()="О программе"]/..', /(\d+) из \1/);
  const oldSchema = Number(/(\d+) из \1/.exec(before)[1]);
  assert.ok(oldSchema < LATEST, `старая схема ${oldSchema}, новая ${LATEST}`);
  await stop(browser);

  // Новая версия на той же папке данных.
  ({ browser } = await start(dataDir));
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 15000 });
  const now = await figures();
  assert.deepEqual(now, old);
  await openSection(browser, "Настройки");
  const about = '//h2[normalize-space()="О программе"]/..';
  await waitText(browser, about, new RegExp(`${LATEST} из ${LATEST}`));
  await waitText(browser, about, /Копия перед обновлением/);
  const copies = readdirSync(join(dataDir, "backups")).filter((f) => f.startsWith("before-update-"));
  assert.equal(copies.length, 1, String(copies));
});
