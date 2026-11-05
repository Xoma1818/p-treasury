// Большой итоговый тест, пункт 4: окно приложения на базе за 10 лет (около 100 000 операций).
// Базу готовит тест ядра: PTREASURY_VOLUME_DIR=<папка> cargo test --release -p budget-core --test volume -- --ignored
// затем: PTREASURY_VOLUME_DIR=<папка> node --test e2e/volume.test.mjs. Без папки тест пропускается.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { start, stop, appPid } from "./app.mjs";

/** Память процесса программы (RSS), МБ; в Windows — рабочий набор. */
function rssMb() {
  const pid = appPid();
  if (!pid) return null;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`]).toString();
      return Math.round(Number(out.trim()) / 1048576);
    }
    const kb = execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString();
    return Math.round(Number(kb.trim()) / 1024);
  } catch {
    return null;
  }
}

const source = process.env.PTREASURY_VOLUME_DIR;
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

test("10 лет учёта: каждый экран открывается быстрее секунды", { skip: !ready && "нет базы PTREASURY_VOLUME_DIR" }, async () => {
  // Работаем с копией, чтобы не менять подготовленную базу.
  const dir = mkdtempSync(join(tmpdir(), "p-treasury-volume-"));
  cpSync(source, dir, { recursive: true });
  const t0 = Date.now();
  ({ browser } = await start(dir));
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 20000 });
  await browser.waitUntil(() => browser.execute(() => /₽/.test(document.querySelector('[data-testid="total-balance"]')?.textContent ?? "")), { timeout: 10000 });
  const results = { "Запуск до Главной с балансом (вместе с запуском WebDriver)": Date.now() - t0 };
  // Главная догружает остальные карточки; разделы меряем после этого (первое открытие
  // сразу после запуска ждёт очередь запросов Главной — см. reliability-2026.md).
  await browser.pause(3000);
  const memory = { "Память после Главной": rssMb() };
  const checks = [
    ["Операции", () => /Показано \d+ из \d+/.test(document.querySelector('[data-testid="txn-count"]')?.textContent ?? "")],
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
  const count = () => browser.execute(() => document.querySelector('[data-testid="txn-count"]')?.textContent ?? "");
  /** Дождаться, пока счётчик строк изменится (ответ ядра пришёл и отрисован). */
  const changed = async (before) => browser.waitUntil(async () => (await count()) !== before, { timeout: 10000, interval: 20 });
  let before = await count();
  let t = Date.now();
  await (await browser.$('//button[normalize-space()="Сбросить"]')).click();
  await changed(before);
  results["Операции: все 10 лет"] = Date.now() - t;
  before = await count();
  t = Date.now();
  await (await browser.$('[name="search"]')).setValue("Пятёрочка");
  await changed(before);
  // Сюда входит задержка набора (250 мс).
  results["Операции: поиск «Пятёрочка» за 10 лет (с набором текста)"] = Date.now() - t;
  memory["Память после всех разделов и поиска"] = rssMb();
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(60)} ${String(v).padStart(6)} мс`);
  for (const [k, v] of Object.entries(memory)) console.log(`${k.padEnd(60)} ${String(v).padStart(6)} МБ`);
  for (const [title] of checks) assert.ok(results[title] < 1000, `${title}: ${results[title]} мс`);
  assert.ok(results["Операции: все 10 лет"] < 1000);
});
