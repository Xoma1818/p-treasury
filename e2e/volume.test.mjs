// Большой итоговый тест, пункт 4: окно приложения на базе за 10 лет (около 100 000 операций).
// Базу готовит тест ядра: KAZNA_VOLUME_DIR=<папка> cargo test --release -p budget-core --test volume -- --ignored
// затем: KAZNA_VOLUME_DIR=<папка> node --test e2e/volume.test.mjs. Без папки тест пропускается.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop } from "./app.mjs";

const source = process.env.KAZNA_VOLUME_DIR;
const ready = source && existsSync(join(source, "budget.db"));
let browser;
after(async () => {
  if (browser) await stop(browser);
});

/** Открыть раздел и дождаться его данных; вернуть время в мс. */
async function timeSection(title, ready) {
  const t = Date.now();
  await (await browser.$(`//nav//button[normalize-space()="${title}"]`)).click();
  await browser.waitUntil(() => browser.execute(ready), { timeout: 10000, interval: 20 });
  return Date.now() - t;
}

test("10 лет учёта: каждый экран открывается быстрее секунды", { skip: !ready && "нет базы KAZNA_VOLUME_DIR" }, async () => {
  // Работаем с копией, чтобы не менять подготовленную базу.
  const dir = mkdtempSync(join(tmpdir(), "kazna-volume-"));
  cpSync(source, dir, { recursive: true });
  const t0 = Date.now();
  ({ browser } = await start(dir));
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 20000 });
  await browser.waitUntil(() => browser.execute(() => /₽/.test(document.querySelector('[data-testid="total-balance"]')?.textContent ?? "")), { timeout: 10000 });
  const results = { "Запуск до Главной с балансом (вместе с запуском WebDriver)": Date.now() - t0 };
  const checks = [
    ["Операции", () => /Показано 100 из \d{3}/.test(document.querySelector('[data-testid="txn-count"]')?.textContent ?? "")],
    ["Отчёты", () => /₽/.test(document.querySelector('[data-testid="report-expense"]')?.textContent ?? "")],
    ["Бюджет", () => document.querySelectorAll('[data-testid="budget-line"]').length > 0 || /нет/.test(document.querySelector("main")?.textContent ?? "")],
    ["Счета", () => document.querySelectorAll('[data-testid="account-row"]').length === 3],
    ["Календарь", () => document.querySelectorAll('[data-testid="cal-day"]').length >= 28],
    ["Главная", () => /₽/.test(document.querySelector('[data-testid="total-balance"]')?.textContent ?? "")],
  ];
  for (const [title, ok] of checks) results[title] = await timeSection(title, ok);
  // Все операции за 10 лет: «Сбросить» фильтр месяца.
  await (await browser.$('//nav//button[normalize-space()="Операции"]')).click();
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="txn-count"]')), { timeout: 10000 });
  let t = Date.now();
  await (await browser.$('//button[normalize-space()="Сбросить"]')).click();
  await browser.waitUntil(() => browser.execute(() => /Показано 100 из 9\d{4}/.test(document.querySelector('[data-testid="txn-count"]')?.textContent ?? "")), { timeout: 10000, interval: 20 });
  results["Операции: все 10 лет"] = Date.now() - t;
  t = Date.now();
  await (await browser.$('[name="search"]')).setValue("Пятёрочка");
  await browser.waitUntil(() => browser.execute(() => /Показано 100 из [1-9]\d{3,}/.test(document.querySelector('[data-testid="txn-count"]')?.textContent ?? "")), { timeout: 10000, interval: 20 });
  // Из времени поиска вычитаем задержку набора (250 мс).
  results["Операции: поиск «Пятёрочка» за 10 лет (с набором текста)"] = Date.now() - t;
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(60)} ${String(v).padStart(6)} мс`);
  for (const [title] of checks) assert.ok(results[title] < 1000, `${title}: ${results[title]} мс`);
  assert.ok(results["Операции: все 10 лет"] < 1000);
});
