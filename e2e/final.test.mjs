// Большой итоговый тест, пункт 2: «месяц жизни» на чистой базе одним сценарием.
// Мастер → счета в рублях и долларах → месяц операций → бюджет → кредит с платежом →
// напоминание → заметка → отчёты → сводка в Excel → резервная копия →
// восстановление в новую папку → все цифры совпадают с исходными.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, fill, choose, chooseLike, click, save, waitText, money, setDate } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ru = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const today = iso(now);
/** День текущего месяца, не позже сегодняшнего. */
const day = (n) => new Date(now.getFullYear(), now.getMonth(), Math.min(n, now.getDate()));
const files = mkdtempSync(join(tmpdir(), "p-treasury-final-"));

/** Сумма в копейках так, как её пишет приложение: «1 248,13 ₽». */
function rub(kop) {
  const sign = kop < 0 ? "−" : "";
  const a = Math.abs(kop);
  const int = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${int}${a % 100 ? "," + pad(a % 100) : ""} ₽`;
}

// Месяц операций (в копейках). Карта и наличные; зарплата, аванс, расходы, перевод.
const rows = [
  [day(1), "Доход", "Карта", "Зарплата", "Работа", "", 9000000],
  [day(2), "Расход", "Карта", "Жильё", "Мосэнергосбыт", "", 623000],
  [day(3), "Расход", "Карта", "Продукты", "Пятёрочка", "", 234050],
  [day(4), "Расход", "Наличные", "Транспорт", "Метро", "", 50000],
  [day(5), "Перевод", "Карта", "", "", "в кошелёк", 1000000, "Наличные"],
  [day(6), "Расход", "Карта", "Кафе и рестораны", "Шоколадница", "", 189000],
  [day(8), "Расход", "Наличные", "Продукты", "Рынок", "", 120000],
  [day(10), "Расход", "Карта", "Жильё → Интернет и связь", "МТС", "", 65000],
  [day(12), "Расход", "Карта", "Здоровье", "Аптека", "", 43090],
  [day(15), "Доход", "Карта", "Зарплата", "Работа", "аванс", 4000000],
  [day(18), "Расход", "Карта", "Продукты", "Перекрёсток", "", 312045],
  [day(20), "Расход", "Наличные", "Кафе и рестораны", "Столовая", "", 45000],
];
const amountText = (k) => (k / 100).toFixed(2).replace(".", ",");
const csv =
  "﻿Дата;Тип;Счёт;Категория;Получатель;Комментарий;Сумма;Счёт зачисления\n" +
  rows.map(([d, t, a, c, p, n, k, to = ""]) => [ru(d), t, a, c, p, n, amountText(k), to].join(";")).join("\n") +
  "\n";

const sum = (pred) => rows.filter(pred).reduce((s, r) => s + r[6], 0);
const csvIncome = sum((r) => r[1] === "Доход");
const csvExpense = sum((r) => r[1] === "Расход");
// Ручные операции: чек «1890+455» по карте и шаблон «Кофе 250 ₽» с карты.
const manualExpense = 234500 + 25000;
// Кредит 100 000 ₽ под 12 % на 12 месяцев: платёж 8 884,88 ₽, проценты 1 000 ₽.
const loanInterest = 100000;
const loanPayment = 888488;
const income = csvIncome;
const expense = csvExpense + manualExpense + loanInterest;
const cardBalance =
  5000000 + sum((r) => r[2] === "Карта" && r[1] === "Доход") - sum((r) => r[2] === "Карта" && r[1] !== "Доход") - manualExpense + 10000000 - loanPayment;
const cashBalance = 500000 + 1000000 - sum((r) => r[2] === "Наличные" && r[1] === "Расход");

let browser, dataDir;
before(async () => {
  ({ browser, dataDir } = await start());
});
after(async () => {
  await stop(browser);
});

const accountRow = (name) => `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="${name}"]]`;
const pick = (...paths) => browser.execute((p) => (window.__ptPick = p), paths);

/** Снимок всех цифр, которые видит пользователь: для сравнения до копии и после восстановления. */
async function snapshot() {
  const text = async (sel) => (await (await browser.$(sel)).getText()).replace(/\s+/g, " ").trim();
  const s = {};
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="month-expense"]', /₽/);
  for (const id of ["total-balance", "month-income", "month-expense", "home-budget", "home-upcoming"]) s[id] = await text(`[data-testid="${id}"]`);
  await openSection(browser, "Счета");
  s.accounts = await browser.execute(() => [...document.querySelectorAll('[data-testid="account-row"]')].map((r) => r.textContent));
  await openSection(browser, "Операции");
  await click(browser, "Сбросить");
  await waitText(browser, '[data-testid="txn-count"]', /Показано/);
  s.txnCount = await text('[data-testid="txn-count"]');
  s.txns = await browser.execute(() => [...document.querySelectorAll('[data-testid="txn-row"]')].map((r) => r.textContent));
  await openSection(browser, "Бюджет");
  s.budget = await browser.execute(() => [...document.querySelectorAll('[data-testid="budget-line"]')].map((r) => r.textContent));
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="report-expense"]', /₽/);
  for (const id of ["report-income", "report-expense", "report-balance", "savings-rate"]) s[id] = await text(`[data-testid="${id}"]`);
  await openSection(browser, "Долги");
  s.debts = await text("main");
  await openSection(browser, "Календарь");
  s.calendar = await browser.execute(() => document.querySelector("main").textContent);
  await openSection(browser, "Заметки");
  s.notes = await text("main");
  return s;
}

let before_;

test("месяц жизни: от первого запуска до сводки в Excel", async () => {
  // 1. Мастер: рубли и доллары.
  await onboard(browser, [
    { name: "Наличные", balance: "5000" },
    { name: "Карта", balance: "50000" },
    { name: "Вклад USD", type: "Вклад / сбережения", currency: "USD", balance: "1000" },
  ]);
  await openSection(browser, "Настройки");
  await choose(browser, "rateFrom", "USD");
  await fill(browser, "rate", "90");
  await click(browser, "Добавить");
  await waitText(browser, '[data-testid="rates"]', /1 USD = 90 ₽/);

  // 2. Месяц операций: из таблицы (CSV) и вручную.
  const path = join(files, "месяц.csv");
  writeFileSync(path, csv);
  await click(browser, "Импорт из CSV");
  await pick(path);
  await click(browser, "Выбрать файл", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="import-summary"]', new RegExp(`строк ${rows.length}, без ошибок ${rows.length}$`));
  await click(browser, `Загрузить ${rows.length}`, '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="import-done"]', new RegExp(`Загружено операций: ${rows.length}`));
  await browser.keys("Escape");
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "1890+455");
  await choose(browser, "account", "Карта (₽)");
  await choose(browser, "category", "Продукты");
  await save(browser);
  await click(browser, "+ Расход");
  await fill(browser, "amount", "250");
  await choose(browser, "account", "Карта (₽)");
  await choose(browser, "category", "Кафе и рестораны");
  await click(browser, "Сохранить как шаблон", '//*[@role="dialog"]');
  await fill(browser, "templateName", "Кофе");
  await click(browser, "Сохранить шаблон", '//*[@role="dialog"]');
  await click(browser, "Отмена", '//*[@role="dialog"]');
  await (await browser.$('//*[@data-testid="template" and @data-name="Кофе"]//button')).click();
  await waitText(browser, '[data-testid="undo-bar"]', /Операция по шаблону/);

  // 3. Бюджет месяца.
  await openSection(browser, "Бюджет");
  await click(browser, "Создать пустой");
  for (const [cat, limit] of [["Продукты", "15000"], ["Кафе и рестораны", "3000"]]) {
    await choose(browser, "add-expense", cat);
    await fill(browser, "add-expense-limit", limit);
    await click(browser, "Добавить", '//*[@data-testid="budget-expense"]');
  }
  await browser.$('//tr[@data-testid="budget-line" and @data-category="Кафе и рестораны"]').waitForExist({ timeout: 5000 });

  // 4. Кредит 100 000 ₽ и первый платёж.
  await openSection(browser, "Долги");
  await click(browser, "+ Новый долг");
  await fill(browser, "counterparty", "Банк");
  await fill(browser, "principal", "100000");
  await fill(browser, "rate", "12");
  await fill(browser, "term", "12");
  await choose(browser, "account", "Карта (₽)");
  await save(browser);
  await waitText(browser, '[data-testid="debt-next"]', money("8 884,88 ₽"));
  await click(browser, "Оплачено");
  assert.equal(await (await browser.$('[role="dialog"] [name="interest"]')).getValue(), "1000");
  await save(browser);
  await waitText(browser, '[data-testid="debt-outstanding"]', money("92 115,12 ₽"));

  // 5. Напоминание и заметка.
  await openSection(browser, "Календарь");
  await click(browser, "Напоминания");
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", "ЖКХ");
  await setDate(browser, "reminderDate", iso(new Date(now.getFullYear(), now.getMonth() + 1, 2)));
  await choose(browser, "repeat", "Ежемесячно");
  await fill(browser, "reminderAmount", "6230");
  await save(browser);
  await openSection(browser, "Заметки");
  await click(browser, "+ Заметка");
  await fill(browser, "noteBody", "Холодильник: гарантия до 10.2028, чек в ящике");
  await save(browser);

  // 6. Цифры сходятся с тем, что ввели.
  await openSection(browser, "Счета");
  await waitText(browser, accountRow("Карта"), money(rub(cardBalance)));
  await waitText(browser, accountRow("Наличные"), money(rub(cashBalance)));
  await waitText(browser, accountRow("Вклад USD"), money("1 000 $"));
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="report-income"]', money(rub(income)));
  await waitText(browser, '[data-testid="report-expense"]', money(rub(expense)));
  await waitText(browser, '[data-testid="report-balance"]', money(rub(income - expense).replace("−", "")));
  await openSection(browser, "Главная");
  // Общий баланс: карта + наличные + 1 000 $ × 90.
  await waitText(browser, '[data-testid="total-balance"]', money(rub(cardBalance + cashBalance + 9000000)));

  // 7. Сводка в Excel: доходы и расходы на листе «Сводка» — числами.
  const xlsx = join(files, "сводка.xlsx");
  await openSection(browser, "Настройки");
  await click(browser, "Сводка в Excel");
  await pick(xlsx);
  await click(browser, "Скачать", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="export-done"]', /Сохранено/);
  await browser.keys("Escape");
  const sheet1 = execFileSync("unzip", ["-p", xlsx, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
  const numbers = [...sheet1.matchAll(/<v>(-?[\d.]+)<\/v>/g)].map((m) => Number(m[1]));
  assert.ok(numbers.includes(income / 100), `доходы ${income / 100} в ${numbers}`);
  assert.ok(numbers.includes(expense / 100), `расходы ${expense / 100} в ${numbers}`);

  before_ = await snapshot();
  // Снимок содержательный: есть что сравнивать после восстановления.
  assert.equal(before_.accounts.length, 3);
  assert.ok(before_.txns.length >= rows.length + 4, `операций в списке ${before_.txns.length}`);
  assert.ok(before_.budget.length >= 2);
  assert.match(before_.debts, /Банк/);
  assert.match(before_.notes, /Холодильник/);
});

test("резервная копия → восстановление в новую папку: все цифры совпадают", async () => {
  const flash = join(files, "flash.db");
  await openSection(browser, "Настройки");
  await pick(flash);
  await click(browser, "Сделать копию");
  await waitText(browser, '[data-testid="backup-msg"]', /Копия сохранена/);
  await stop(browser);

  ({ browser, dataDir } = await start());
  await onboard(browser, [{ name: "Временный", balance: "1" }]);
  await openSection(browser, "Настройки");
  await pick(flash);
  await click(browser, "Восстановить из копии");
  await waitText(browser, '[role="dialog"]', /В копии: счетов 3, операций \d+/);
  await click(browser, "Восстановить", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="backup-msg"]', /Данные восстановлены/);

  const after_ = await snapshot();
  for (const key of Object.keys(before_)) assert.deepEqual(after_[key], before_[key], `расхождение: ${key}`);
});
