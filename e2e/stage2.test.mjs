// Приёмочные тесты этапа 2 «Бюджеты»: сценарии из product/mvp-features.md, раздел 5.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money } from "./app.mjs";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const dmy = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const title = (d) => `${MONTHS[d.getMonth()][0].toUpperCase()}${MONTHS[d.getMonth()].slice(1)} ${d.getFullYear()}`;
const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

/** Сумма в копейках так, как её пишет приложение: «1 248,13 ₽». */
function rub(kopecks) {
  const int = Math.floor(kopecks / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const frac = kopecks % 100;
  return `${int}${frac ? "," + pad(frac) : ""} ₽`;
}

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

const line = (name) => `//tr[@data-testid="budget-line" and @data-category="${name}"]`;

async function addLimit(category, amount, kind = "expense") {
  await choose(browser, `add-${kind}`, category);
  await fill(browser, `add-${kind}-limit`, amount);
  await click(browser, "Добавить", `//*[@data-testid="budget-${kind}"]`);
  await browser.$(line(category)).waitForExist({ timeout: 5000 });
}

async function expense(amount, category, account = "Карта (₽)") {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", amount);
  await choose(browser, "account", account);
  await choose(browser, "category", category);
  await save(browser);
}

test("план месяца: пустой бюджет и лимиты по категориям", async () => {
  await openSection(browser, "Бюджет");
  await waitText(browser, '[data-testid="budget-month"]', new RegExp(title(now)));
  await waitText(browser, "main", /пока нет/);
  await click(browser, "Создать пустой");
  await addLimit("Кафе и рестораны", "10000");
  await addLimit("Продукты", "20000");
  await waitText(browser, '[data-testid="budget-planned"]', money("30 000 ₽"));
});

test("контроль: «Кафе 90 %» без отметки, перерасход отмечен оранжевым", async () => {
  await expense("9000", "Кафе и рестораны");
  await openSection(browser, "Бюджет");
  await waitText(browser, `${line("Кафе и рестораны")}//*[@data-testid="percent"]`, /^90 %$/);
  assert.doesNotMatch((await browser.$(line("Кафе и рестораны")).getAttribute("class")) ?? "", /over-row/);

  await expense("1500", "Кафе и рестораны");
  await openSection(browser, "Бюджет");
  await waitText(browser, `${line("Кафе и рестораны")}//*[@data-testid="percent"]`, /^105 %$/);
  assert.match(await browser.$(line("Кафе и рестораны")).getAttribute("class"), /over-row/);
  await waitText(browser, line("Кафе и рестораны"), money("−500 ₽"));
  const color = await browser.$(`${line("Кафе и рестораны")}/td[4]`).getCSSProperty("color");
  // Оранжевый цвета перерасхода из темы: #fb923c в тёмной, #c2410c в светлой.
  const over = await browser.execute(() => getComputedStyle(document.documentElement).getPropertyValue("--over").trim());
  assert.ok(["#fb923c", "#c2410c"].includes(over), over);
  assert.equal(color.parsed.hex, over, "остаток при перерасходе оранжевый");
});

test("расход 45 € входит в рублёвый бюджет по курсу дня", async () => {
  await openSection(browser, "Счета");
  await click(browser, "+ Новый счёт");
  await fill(browser, "name", "Карта EUR");
  await choose(browser, "currency", "EUR · Евро");
  await fill(browser, "openingBalance", "100");
  await save(browser);
  await openSection(browser, "Настройки");
  await choose(browser, "rateFrom", "EUR");
  await fill(browser, "rate", "100,5");
  await click(browser, "Добавить");
  await waitText(browser, '[data-testid="rates"]', /1 EUR = 100,5 ₽/);

  await expense("45", "Продукты", "Карта EUR (€)");
  await openSection(browser, "Бюджет");
  await waitText(browser, line("Продукты"), money("4 522,50 ₽"));
});

test("корректировка баланса не входит в факт бюджета", async () => {
  await openSection(browser, "Бюджет");
  const before = await waitText(browser, '[data-testid="budget-spent"]', money("15 022,50 ₽"));
  await openSection(browser, "Счета");
  const card = `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="Карта"]]`;
  await (await browser.$(`${card}//button[normalize-space()="Сверить"]`)).click();
  await fill(browser, "actualBalance", "89000");
  await save(browser, "Сверить");
  await waitText(browser, card, money("89 000 ₽"));
  await openSection(browser, "Бюджет");
  assert.equal(await waitText(browser, '[data-testid="budget-spent"]', money("15 022,50 ₽")), before);
});

test("«Можно тратить сегодня»: остаток лимитов на оставшиеся дни месяца", async () => {
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const days = last - now.getDate() + 1;
  const expected = rub(Math.floor((3_000_000 - 1_502_250) / days));
  await openSection(browser, "Бюджет");
  await waitText(browser, '[data-testid="safe-to-spend"]', money(expected));
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="home-safe-to-spend"]', money(expected));
  await waitText(browser, '[data-testid="home-budget"]', /Кафе и рестораны\s*105 %/);
});

test("клик по факту открывает операции категории за месяц", async () => {
  await openSection(browser, "Бюджет");
  await (await browser.$(`${line("Кафе и рестораны")}//button[contains(@class, "fact")]`)).click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
});

test("планирование: бюджет копируется в следующий месяц", async () => {
  await openSection(browser, "Бюджет");
  await (await browser.$('button[aria-label="Следующий месяц"]')).click();
  await waitText(browser, '[data-testid="budget-month"]', new RegExp(title(nextMonth)));
  // Кнопка называет месяц, из которого копируем.
  await click(browser, `Скопировать из ${MONTHS_GEN[now.getMonth()]}`);
  await waitText(browser, line("Кафе и рестораны"), money("0 ₽"));
  await waitText(browser, '[data-testid="budget-planned"]', money("30 000 ₽"));
  await waitText(browser, '[data-testid="safe-to-spend"]', /только для текущего месяца/);
  // Лимит правится на месте: 12 000 вместо 10 000.
  const input = await browser.$(`${line("Кафе и рестораны")}//input[@name="limit"]`);
  await input.clearValue();
  await input.setValue("12000");
  await browser.keys("Enter");
  await waitText(browser, '[data-testid="budget-planned"]', money("32 000 ₽"));
  await click(browser, "Текущий");
  await waitText(browser, '[data-testid="budget-planned"]', money("30 000 ₽"));
});

test("период бюджета следует настройке «первый день месяца»", async () => {
  await openSection(browser, "Настройки");
  await choose(browser, "monthStartDay", "25-го числа");
  await openSection(browser, "Бюджет");
  // С началом 25-го сегодняшний день попадает в период 25-го прошлого (или этого) месяца.
  const startsThisMonth = now.getDate() >= 25;
  const start = new Date(now.getFullYear(), now.getMonth() - (startsThisMonth ? 0 : 1), 25);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 24);
  const month = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  await waitText(browser, '[data-testid="budget-month"]', new RegExp(title(month)));
  await waitText(browser, "main", new RegExp(`${dmy(start)} – ${dmy(end)}`));
  await openSection(browser, "Настройки");
  await choose(browser, "monthStartDay", "1-го числа");
  await openSection(browser, "Бюджет");
  await waitText(browser, '[data-testid="budget-planned"]', money("30 000 ₽"));
});
