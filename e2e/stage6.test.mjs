// Приёмочные тесты этапа 6 «Данные и настройки»: сценарии из product/mvp-features.md, разделы 11–12.
// Системные окна выбора файла тест не нажимает: ответы подкладываются в window.__ptPick.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, choose, click, waitText, money, appPid, closeLikeUser } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const ru = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const daysAgo = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
const files = mkdtempSync(join(tmpdir(), "p-treasury-files-"));

let browser, dataDir;
before(async () => {
  ({ browser, dataDir } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "5000" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

/** Подложить ответы для следующих окон выбора файла. */
const pick = (...paths) => browser.execute((p) => (window.__ptPick = p), paths);
const card = (name) => `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="${name}"]]`;

const csv = (rows) => "\uFEFFДата;Тип;Счёт;Категория;Получатель;Комментарий;Сумма;Счёт зачисления\n" + rows.map((r) => r.join(";")).join("\n") + "\n";
const good = [
  [ru(daysAgo(40)), "Доход", "Карта", "Заработная плата", "", "", "85 000", ""],
  [ru(daysAgo(39)), "Расход", "Карта", "Питание", "Пятёрочка", "", "2340,50", ""],
  [ru(daysAgo(38)), "Перевод", "Карта", "", "", "в кошелёк", "1000", "Наличные"],
  [ru(daysAgo(2)), "Расход", "Наличные", "Общепит", "", "", "450", ""],
];

test("импорт CSV: три строки с ошибкой в дате видны до загрузки, после исправления всё загружается", async () => {
  const path = join(files, "выписка.csv");
  const broken = [...good, ["31.09.2026", "Расход", "Карта", "Коммунальные платежи", "", "", "6230", ""], ["2026/10/07", "Расход", "Карта", "Такси", "", "", "350", ""], ["08.10.26", "Расход", "Карта", "Такси", "", "", "350", ""]];
  writeFileSync(path, csv(broken));
  await openSection(browser, "Настройки");
  await click(browser, "Импорт выписки или CSV");
  await pick(path);
  await click(browser, "Выбрать файл", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="import-summary"]', /строк 7, без ошибок 4, с ошибками 3/);
  const bad = await browser.$$('[data-testid="import-row"][data-error="1"]');
  assert.equal(bad.length, 3);
  assert.equal(await (await browser.$('//*[@role="dialog"]//button[normalize-space()="Загрузить 4"]')).isEnabled(), false, "с ошибками целиком не грузим");

  // Исправили даты в файле и проверили снова.
  const fixed = [...good, [ru(daysAgo(30)), "Расход", "Карта", "Коммунальные платежи", "", "", "6230", ""], [ru(daysAgo(29)), "Расход", "Карта", "Такси", "", "", "350", ""], [ru(daysAgo(28)), "Расход", "Карта", "Такси", "", "", "350", ""]];
  writeFileSync(path, csv(fixed));
  await click(browser, "Проверить снова", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="import-summary"]', /строк 7, без ошибок 7$/);
  await click(browser, "Загрузить 7", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 7/);
  await browser.keys("Escape");

  // Карта: 100 000 + 85 000 − 2 340,50 − 1 000 − 6 230 − 350 − 350 = 174 729,50.
  await openSection(browser, "Счета");
  await waitText(browser, card("Карта"), money("174 729,50 ₽"));
  await waitText(browser, card("Наличные"), money("5 550 ₽"));
});

test("напоминание о копии: операции старше месяца, а копий не было", async () => {
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="backup-reminder"]', /Резервной копии не было больше месяца/);
});

test("ручная копия на «флешку», после неё напоминание пропадает", async () => {
  const flash = join(files, "flash.db");
  await openSection(browser, "Настройки");
  await pick(flash);
  await click(browser, "Сделать копию");
  await waitText(browser, '[data-testid="backup-msg"]', /Копия сохранена и проверена: flash\.db/);
  assert.ok(existsSync(flash));
  await waitText(browser, '[data-testid="last-backup"]', /\d\d\.\d\d\.\d{4} \d\d:\d\d/);
  await openSection(browser, "Главная");
  await browser.$('[data-testid="total-balance"]').waitForDisplayed();
  assert.equal(await browser.$('[data-testid="backup-reminder"]').isExisting(), false);
});

test("сводка в Excel: файл .xlsx с шестью листами", async () => {
  const path = join(files, "сводка.xlsx");
  await openSection(browser, "Настройки");
  await click(browser, "Сводка в Excel");
  await click(browser, "Год", '//*[@role="dialog"]');
  await pick(path);
  await click(browser, "Скачать", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="export-done"]', /Сохранено: сводка\.xlsx/);
  await browser.keys("Escape");
  const workbook = execFileSync("unzip", ["-p", path, "xl/workbook.xml"], { encoding: "utf8" });
  const sheets = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheets, ["Сводка", "По категориям", "Бюджет", "По месяцам", "Долги", "Операции"]);
});

test("выгрузка операций по фильтру в CSV: русский Excel открывает без «кракозябр»", async () => {
  const path = join(files, "операции.csv");
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await choose(browser, "filterAccount", "Наличные (₽)");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
  await pick(path);
  await click(browser, "Выгрузить");
  await waitText(browser, '[data-testid="export-done"]', /Выгружено: операции\.csv/);
  const text = readFileSync(path, "utf8");
  assert.ok(text.startsWith("\uFEFFДата;Тип;Счёт"), "BOM и разделитель «;»");
  const lines = text.trim().split(/\r?\n/);
  assert.equal(lines.length, 3, text);
  assert.match(text, /Кафе и рестораны/);
  assert.match(text, /-450,00|-450/);
});

test("выгрузка отчёта «По месяцам» в Excel", async () => {
  const path = join(files, "по месяцам.xlsx");
  await openSection(browser, "Отчёты");
  await click(browser, "По месяцам");
  await pick(path);
  await click(browser, "Выгрузить");
  await waitText(browser, '[data-testid="export-done"]', /Выгружено: по месяцам\.xlsx/);
  const workbook = execFileSync("unzip", ["-p", path, "xl/workbook.xml"], { encoding: "utf8" });
  assert.match(workbook, /<sheet name="По месяцам"/);
});

test("формат даты ГГГГ-ММ-ДД меняет даты на экранах", async () => {
  await openSection(browser, "Настройки");
  await choose(browser, "dateFormat", "ГГГГ-ММ-ДД");
  await waitText(browser, '[data-testid="last-backup"]', /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  await choose(browser, "dateFormat", "ДД.ММ.ГГГГ");
  await waitText(browser, '[data-testid="last-backup"]', /^\d\d\.\d\d\.\d{4} \d\d:\d\d$/);
});

test("новый компьютер: восстановление из копии возвращает все счета и операции", async () => {
  const flash = join(files, "flash.db");
  await stop(browser);
  ({ browser, dataDir } = await start());
  await onboard(browser, [{ name: "Временный", balance: "1" }]);
  await openSection(browser, "Настройки");
  await pick(flash);
  await click(browser, "Восстановить из копии");
  await waitText(browser, '[role="dialog"]', /В копии: счетов 2, операций 7/);
  await click(browser, "Восстановить", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="backup-msg"]', /Данные восстановлены из копии/);
  await openSection(browser, "Счета");
  await waitText(browser, card("Карта"), money("174 729,50 ₽"));
  const names = await browser.execute(() => [...document.querySelectorAll('[data-testid="account-row"] .main')].map((e) => e.textContent));
  assert.deepEqual(names.sort(), ["Карта", "Наличные"]);
  // Прежние данные этого компьютера не потеряны: лежат отдельной копией.
  assert.ok(readdirSync(join(dataDir, "backups")).some((f) => f.startsWith("before-restore-")));
});

test("закрытие окна: по умолчанию в трей, с настройкой — выход с обновлением папки сохранности в облаке", async () => {
  const cloud = mkdtempSync(join(tmpdir(), "p-treasury-cloud-"));
  const vault = join(cloud, "Kazna");
  await openSection(browser, "Настройки");
  await click(browser, "Сменить папку");
  await pick(cloud);
  await click(browser, "Другая папка или флешка…", '//*[@role="dialog"]');
  // Выбрана папка облака: файлы ложатся в её подпапку Kazna, папка сразу обновляется.
  await waitText(browser, '[data-testid="vault-dir"]', new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await browser.waitUntil(async () => !(await (await browser.$('[role="dialog"]')).isExisting()), { timeout: 5000 });
  await choose(browser, "autobackupKeep", "3");
  assert.ok(existsSync(join(vault, "Мой бюджет.ptreasury")));
  assert.equal(readdirSync(join(vault, "Копии")).length, 1);

  // «Сворачивать в трей»: окно закрыли, приложение работает и шлёт напоминания.
  closeLikeUser();
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(appPid(), "приложение осталось в трее");
  assert.equal(readdirSync(join(vault, "Копии")).length, 1, "в трее папку не трогаем");
  await stop(browser);

  // «Закрывать приложение»: выход и обновление папки.
  ({ browser } = await start(dataDir));
  await openSection(browser, "Настройки");
  await choose(browser, "closeToTray", "Закрывать приложение");
  await new Promise((r) => setTimeout(r, 1100));
  closeLikeUser();
  await browser.waitUntil(async () => !appPid(), { timeout: 15000 });
  const copies = readdirSync(join(vault, "Копии"));
  assert.equal(copies.length, 2, String(copies));
  assert.ok(copies.every((f) => /^Мой бюджет - \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.ptreasury$/.test(f)), String(copies));
  assert.ok(existsSync(join(vault, "Excel", "Все данные.xlsx")));
  await stop(browser).catch(() => {});
  browser = null;
});

test("обновление: при запуске приложение сообщает о новой версии, «Позже» закрывает окно", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        version: "9.9.9",
        notes: "Новые отчёты",
        pub_date: new Date().toISOString(),
        platforms: { "linux-x86_64": { signature: "test", url: "http://127.0.0.1/p-treasury.AppImage.tar.gz" } },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    ({ browser, dataDir } = await start(undefined, { env: { PTREASURY_UPDATE_URL: `http://127.0.0.1:${server.address().port}/latest.json` } }));
    await onboard(browser, [{ name: "Карта", balance: "0" }]);
    await waitText(browser, '[data-testid="update-version"]', /Доступна версия 9\.9\.9 \(у вас \d+\.\d+\.\d+\)/, 15000);
    await waitText(browser, '[role="dialog"]', /Новые отчёты/);
    await click(browser, "Позже", '//*[@role="dialog"]');
    await openSection(browser, "Настройки");
    await choose(browser, "updateCheck", "Только по кнопке");
    await click(browser, "Проверить обновления");
    await waitText(browser, '[data-testid="update-version"]', /9\.9\.9/);
    await click(browser, "Позже", '//*[@role="dialog"]');
  } finally {
    server.close();
  }
});

test("без адреса обновлений кнопка честно говорит, что проверять пока негде", async () => {
  await stop(browser);
  ({ browser, dataDir } = await start());
  await onboard(browser, [{ name: "Карта", balance: "0" }]);
  await openSection(browser, "Настройки");
  await click(browser, "Проверить обновления");
  await waitText(browser, '[data-testid="update-result"]', /Адрес обновлений появится/);
});
