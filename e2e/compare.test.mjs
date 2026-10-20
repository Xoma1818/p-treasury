// Сравнение двух любых периодов (Отчёты → «Сравнение»): что стало больше и что меньше, в рублях и в %.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money, setDate } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const prev = (day) => iso(new Date(now.getFullYear(), now.getMonth() - 1, day));
const cur = iso(new Date(now.getFullYear(), now.getMonth(), 1));
const files = mkdtempSync(join(tmpdir(), "p-treasury-files-"));

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
  // Прошлый месяц: продукты 10 000, кафе 4 000, транспорт 2 000.
  // Этот месяц: продукты 12 500 (+25 %), кафе 3 000 (−25 %), транспорта нет, здоровье 1 500 (новое).
  for (const [date, amount, category, payee] of [
    [prev(10), "10000", "Продукты", "Пятёрочка"],
    [prev(11), "4000", "Кафе и рестораны", "Шоколадница"],
    [prev(12), "2000", "Транспорт", ""],
    [cur, "12500", "Продукты", "Пятёрочка"],
    [cur, "3000", "Кафе и рестораны", "Шоколадница"],
    [cur, "1500", "Здоровье", ""],
  ]) {
    await click(browser, "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта (₽)");
    await choose(browser, "category", category);
    if (payee) await fill(browser, "payee", payee);
    await setDate(browser, "date", date);
    await save(browser);
  }
});
after(async () => {
  await stop(browser);
});

const row = (name, section = "") => `//*[@data-testid="${section || "compare"}"]//li[@data-testid="cmp-row" and @data-name="${name}"]`;
const names = async (section) => {
  const out = [];
  for (const r of await browser.$$(`[data-testid="${section}"] [data-testid="cmp-row"]`)) out.push(await r.getAttribute("data-name"));
  return out;
};

async function openCompare() {
  await openSection(browser, "Отчёты");
  await click(browser, "Сравнение", '//*[@role="tablist"]');
  await browser.$('[data-testid="compare"]').waitForExist({ timeout: 5000 });
}

test("месяц к прошлому: продукты +2 500 ₽ (+25 %), кафе −25 %, транспорт пропал, здоровье новое", async () => {
  await openCompare();
  await waitText(browser, '[data-testid="cmp-expense"]', money("17 000 ₽"));
  await waitText(browser, '[data-testid="cmp-expense-diff"]', /\+1[\s ]000[\s ]₽ \(\+6 %\)/);
  await waitText(browser, `${row("Продукты", "cmp-up")}//*[@data-testid="cmp-diff"]`, money("+2 500 ₽"));
  assert.equal(await browser.$(`${row("Продукты")}//*[@data-testid="cmp-percent"]`).getText(), "+25 %");
  assert.match(await browser.$(`${row("Продукты")}//*[@data-testid="cmp-a"]`).getText(), money("10 000 ₽"));
  assert.match(await browser.$(`${row("Продукты")}//*[@data-testid="cmp-b"]`).getText(), money("12 500 ₽"));
  assert.equal(await browser.$(`${row("Кафе и рестораны", "cmp-down")}//*[@data-testid="cmp-percent"]`).getText(), "−25 %");
  // Порядок по силе изменения: больше — сверху самое выросшее, меньше — самое упавшее.
  assert.deepEqual(await names("cmp-up"), ["Продукты", "Здоровье"]);
  assert.deepEqual(await names("cmp-down"), ["Транспорт", "Кафе и рестораны"]);
  assert.match(await browser.$(row("Здоровье")).getText(), /новое/);
  assert.match(await browser.$(row("Транспорт")).getText(), /нет в периоде 2/);
  assert.equal(await browser.$(`${row("Транспорт")}//*[@data-testid="cmp-percent"]`).getText(), "−100 %");
  await waitText(browser, '[data-testid="cmp-presence"]', /Новых позиций: 1, пропало: 1/);
  // Полоски: рост расходов — «хуже», снижение — «лучше».
  assert.match(await browser.$(`${row("Продукты")}//*[contains(@class,"dbar")]`).getAttribute("class"), /up worse/);
  assert.match(await browser.$(`${row("Кафе и рестораны")}//*[contains(@class,"dbar")]`).getAttribute("class"), /down better/);
});

test("по получателям и по счетам", async () => {
  await openCompare();
  await click(browser, "Получатели", '//*[contains(@class,"compare-switches")]');
  await waitText(browser, `${row("Пятёрочка")}//*[@data-testid="cmp-percent"]`, /^\+25 %$/);
  await click(browser, "Счета", '//*[contains(@class,"compare-switches")]');
  await waitText(browser, `${row("Карта")}//*[@data-testid="cmp-diff"]`, money("+1 000 ₽"));
  await click(browser, "Категории", '//*[contains(@class,"compare-switches")]');
});

test("любые периоды: первая половина прошлого месяца против этого", async () => {
  await openCompare();
  await setDate(browser, "cmp1From", prev(1));
  await setDate(browser, "cmp1To", prev(10));
  // В первом периоде только продукты 10 000: кафе стало «новым».
  await waitText(browser, `${row("Кафе и рестораны")}//*[@data-testid="cmp-percent"]`, /^новое$/);
  await waitText(browser, '[data-testid="cmp-total"]', /Итого: 10[\s ]000[\s ]₽ → 17[\s ]000[\s ]₽/);
  // Готовая пара возвращает «месяц к прошлому».
  await click(browser, "Месяц к прошлому");
  await waitText(browser, `${row("Кафе и рестораны")}//*[@data-testid="cmp-percent"]`, /^−25 %$/);
});

test("клик по позиции открывает её операции за период 2", async () => {
  await openCompare();
  await browser.$(row("Продукты")).waitForExist({ timeout: 5000 });
  await (await browser.$(`${row("Продукты")}//button[contains(@class,"cat-link")]`)).click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
});

test("сравнение выгружается в Excel: лист «Сравнение расходов» с суммами числами", async () => {
  await openCompare();
  await browser.$(row("Продукты")).waitForExist({ timeout: 5000 });
  const path = join(files, "сравнение.xlsx");
  await browser.execute((p) => (window.__ptPick = p), [path]);
  await click(browser, "Выгрузить", '//*[@data-testid="compare"]');
  await waitText(browser, '[data-testid="export-done"]', /Выгружено: сравнение\.xlsx/);
  const workbook = execFileSync("unzip", ["-p", path, "xl/workbook.xml"], { encoding: "utf8" });
  assert.deepEqual([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]), ["Сравнение расходов"]);
  const sheet = execFileSync("unzip", ["-p", path, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  assert.match(sheet, /<v>2500<\/v>/, "изменение по продуктам записано числом");
  assert.match(sheet, /<v>0\.25<\/v>/, "и процент тоже");
});
