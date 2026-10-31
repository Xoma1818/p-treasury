// Обновление 0.10, этап 4: несколько файлов бюджета и переносная версия.
// Сценарии из docs/product/mvp-features.md («Версия 0.10»).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, fill, click, waitText, APP_BIN, APP_FILE } from "./app.mjs";

let browser;
const dataDir = mkdtempSync(join(tmpdir(), "p-treasury-e2e-"));
after(async () => {
  await stop(browser);
});

const row = (name) => `//*[@data-testid="file-row" and @data-name="${name}"]`;
const home = () => browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 15000 });

test("второй файл «Дача»: свой мастер первого запуска и свои счета", async () => {
  ({ browser } = await start(dataDir));
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await home();
  await openSection(browser, "Настройки");
  await waitText(browser, row("Основной"), /Основной\s*открыт/);
  await click(browser, "+ Новый файл");
  await fill(browser, "fileName", "Дача");
  await click(browser, "Создать и открыть");
  // Новый файл пустой: открывается мастер первого запуска.
  await onboard(browser, [{ name: "Кошелёк дачи", balance: "5000" }]);
  await waitText(browser, '[data-testid="total-balance"]', /5[\s ]000/);
  assert.equal(await browser.$('[data-testid="demo-banner"]').isExisting(), false);
});

test("переключение файлов одной кнопкой и переименование", async () => {
  await openSection(browser, "Настройки");
  await waitText(browser, row("Дача"), /открыт/);
  await browser.$(`${row("Основной")}//button[normalize-space()="Открыть"]`).click();
  await home();
  await waitText(browser, '[data-testid="demo-banner"]', /Это пример/);
  await openSection(browser, "Настройки");
  await browser.$(`${row("Дача")}//button[normalize-space()="Переименовать"]`).click();
  await fill(browser, "fileRename", "Дача 2027");
  await click(browser, "Сохранить", row("Дача"));
  await browser.$(row("Дача 2027")).waitForExist({ timeout: 5000 });
  await browser.$(`${row("Дача 2027")}//button[normalize-space()="Открыть"]`).click();
  await home();
  await waitText(browser, "main", /Кошелёк дачи/);
});

test("после перезапуска открывается последний файл; чужой файл не открывается", async () => {
  await stop(browser);
  ({ browser } = await start(dataDir));
  await home();
  await waitText(browser, "main", /Кошелёк дачи/);
  await openSection(browser, "Настройки");
  const foreign = join(dataDir, "not-ours.db");
  writeFileSync(foreign, "это не база");
  await browser.execute((p) => (window.__ptPick = [p]), foreign);
  await click(browser, "Открыть файл…");
  await waitText(browser, '[data-testid="budget-files"]', /это не файл данных Kazna/);
  // Открытый файл убрать из списка нельзя, другой — можно (сам файл остаётся).
  await browser.$(`${row("Основной")}//button[normalize-space()="Открыть"]`).click();
  await home();
  await openSection(browser, "Настройки");
  await browser.$(`${row("Дача 2027")}//button[normalize-space()="Убрать из списка"]`).click();
  await browser.$(row("Дача 2027")).waitForExist({ timeout: 5000, reverse: true });
  assert.ok(existsSync(join(dataDir, "files", "Дача.db")), "файл на диске остался");
  // И открывается снова через «Открыть файл…».
  await browser.execute((p) => (window.__ptPick = [p]), join(dataDir, "files", "Дача.db"));
  await click(browser, "Открыть файл…");
  await home();
  await waitText(browser, "main", /Кошелёк дачи/);
});

test("переносная версия: файл portable рядом с программой — данные в папке data", async () => {
  await stop(browser);
  const dir = mkdtempSync(join(tmpdir(), "p-treasury-portable-"));
  // Жёсткая ссылка: программа «лежит» в этой папке, места на диске не занимает.
  const bin = join(dir, APP_FILE);
  linkSync(APP_BIN, bin);
  writeFileSync(join(dir, "portable"), "");
  ({ browser } = await start(dir, { bin, args: [] }));
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await onboard(browser, [{ name: "Флешка", balance: "100" }]);
  await openSection(browser, "Настройки");
  await waitText(browser, '[data-testid="portable-note"]', new RegExp(`Переносная версия: все данные лежат в папке ${join(dir, "data").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(existsSync(join(dir, "data", "budget.db")));
});
