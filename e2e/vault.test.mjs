// Папка сохранности (0.13): программа сама ведёт папку с копией и Excel,
// а на новом компьютере первый экран предлагает перенести данные из неё.
// В тестах папка по умолчанию лежит внутри папки данных: <data>/P-Treasury.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, click, waitText, money } from "./app.mjs";

let browser, dataDir, vault;
after(async () => {
  await stop(browser);
});

const card = (name) => `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="${name}"]]`;

test("старый компьютер: «Сохранить сейчас» кладёт в папку копию, прошлую копию, Excel и инструкцию", async () => {
  ({ browser, dataDir } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "5000" },
    { name: "Карта", balance: "123456,78" },
  ]);
  await openSection(browser, "Настройки");
  vault = join(dataDir, "P-Treasury");
  await waitText(browser, '[data-testid="vault-dir"]', new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await click(browser, "Сохранить сейчас");
  await waitText(browser, '[data-testid="vault-synced"]', /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  await waitText(browser, '[data-testid="last-backup"]', /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  assert.ok(existsSync(join(vault, "Мой бюджет.ptreasury")));
  assert.ok(existsSync(join(vault, "Прочти меня.txt")));
  assert.equal(readdirSync(join(vault, "Копии")).length, 1);
  const excel = readdirSync(join(vault, "Excel")).sort();
  assert.ok(excel.includes("Все данные.xlsx") && excel.includes("Операции.xlsx"), String(excel));
  assert.ok(excel.some((f) => /^Сводка \d{4}\.xlsx$/.test(f)), String(excel));
  await stop(browser);
  browser = null;
});

test("новый компьютер: папку скопировали в Документы, первый экран находит её и переносит всё", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "p-treasury-newpc-"));
  cpSync(vault, join(fresh, "P-Treasury"), { recursive: true });
  ({ browser } = await start(fresh));
  await waitText(browser, '[data-testid="transfer-offer"]', /Нашлась папка сохранности: Мой бюджет/, 15000);
  await click(browser, "Перенести данные");
  await waitText(browser, '[data-testid="found-list"]', /Мой бюджет[\s\S]*счетов 2, операций 0/);
  await click(browser, "Перенести", '//*[@data-testid="found-row"]');
  await waitText(browser, '[data-testid="transfer-summary"]', /Мой бюджет: счетов 2/);
  await click(browser, "Перенести", '//*[@role="dialog"]');
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  await openSection(browser, "Счета");
  await waitText(browser, card("Карта"), money("123 456,78 ₽"));
  await openSection(browser, "Настройки");
  await waitText(browser, '[data-testid="vault-synced"]', /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  await stop(browser);
  browser = null;
});

test("копии нет, остался только Excel: данные восстанавливаются из «Все данные.xlsx»", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "p-treasury-excel-"));
  cpSync(vault, join(fresh, "P-Treasury"), { recursive: true });
  rmSync(join(fresh, "P-Treasury", "Мой бюджет.ptreasury"));
  rmSync(join(fresh, "P-Treasury", "Копии"), { recursive: true });
  ({ browser } = await start(fresh));
  await waitText(browser, '[data-testid="transfer-offer"]', /Нашлась папка сохранности/, 15000);
  await click(browser, "Перенести данные");
  await waitText(browser, '[data-testid="found-list"]', /из Excel/);
  await click(browser, "Перенести", '//*[@data-testid="found-row"]');
  await waitText(browser, '[role="dialog"]', /загрузятся из Excel-файла/);
  await click(browser, "Перенести", '//*[@role="dialog"]');
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  await openSection(browser, "Счета");
  await waitText(browser, card("Наличные"), money("5 000 ₽"));
  await waitText(browser, card("Карта"), money("123 456,78 ₽"));
  // После переноса в папке снова есть полная копия.
  await openSection(browser, "Настройки");
  await waitText(browser, '[data-testid="vault-synced"]', /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  assert.ok(existsSync(join(fresh, "P-Treasury", "Мой бюджет.ptreasury")));
});
