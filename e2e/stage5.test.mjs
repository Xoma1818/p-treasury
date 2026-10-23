// Приёмочные тесты этапа 5 «Календарь, напоминания, заметки»: сценарии из product/mvp-features.md, раздел 10.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, chooseLike, click, save, waitText, waitContent, money, setDate, waitCount, newDebt } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const today = iso(now);
const inDays = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
// Месяц через два от текущего: целиком в будущем.
const future = new Date(now.getFullYear(), now.getMonth() + 2, 1);
const futureMonth = iso(future).slice(0, 7);

let browser, dataDir;
before(async () => {
  ({ browser, dataDir } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

const card = `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="Карта"]]`;
const occ = (list, title) => `//*[@data-testid="${list}"]//li[@data-testid="occurrence" and @data-title="${title}"]`;

async function openReminders() {
  await openSection(browser, "Календарь");
  await click(browser, "Напоминания");
  await browser.$('[data-testid="rem-all"]').waitForDisplayed({ timeout: 5000 });
}

async function newReminder({ title, date, time = "09:00", repeat, amount, category, account }) {
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", title);
  await setDate(browser, "reminderDate", date);
  await setDate(browser, "reminderTime", time);
  if (repeat) await choose(browser, "repeat", repeat);
  if (amount) await fill(browser, "reminderAmount", amount);
  if (category) await chooseLike(browser, "reminderCategory", category);
  if (account) await choose(browser, "reminderAccount", account);
  await save(browser);
}

test("коммуналка: «ЖКХ» ежемесячно, «Создать операцию» с суммой 6 230 ₽", async () => {
  await openReminders();
  await newReminder({ title: "ЖКХ", date: today, time: "00:00", repeat: "Ежемесячно", amount: "6000", category: "ЖКХ", account: "Карта (₽)" });
  await waitText(browser, '[data-testid="rem-all"]', /ЖКХ · ежемесячно, следующее/);
  // Срок наступил сегодня в 0:00 — напоминание в просроченных.
  await click(browser, "Создать операцию", occ("rem-overdue", "ЖКХ"));
  assert.equal(await (await browser.$('[role="dialog"] [name="amount"]')).getValue(), "6000");
  assert.equal(await (await browser.$('[role="dialog"] [name="payee"]')).getValue(), "ЖКХ");
  assert.match(await (await browser.$('[role="dialog"] [name="account"]')).getValue(), /.+/);
  await fill(browser, "amount", "6230");
  await save(browser);
  await waitText(browser, '[data-testid="rem-done"]', /ЖКХ/);
  await waitText(browser, '[data-testid="rem-overdue"]', /Всё сделано/);
  await openSection(browser, "Счета");
  await waitText(browser, card, money("93 770 ₽"));
});

test("платёж по кредиту: напоминание за 3 дня, «Оплачено» создаёт платёж по графику", async () => {
  await newDebt(browser, { counterparty: "Сбер", principal: "300000", rate: "18", term: "24", firstPayment: inDays(2), account: "Карта (₽)" });
  await save(browser);
  await waitText(browser, '[data-testid="debt-next"]', money("14 977,23 ₽"));

  // До платежа 2 дня, напоминание за 3 дня уже наступило.
  await openReminders();
  await waitText(browser, occ("rem-overdue", "Платёж: Сбер"), money("14 977,23 ₽"));
  await click(browser, "Оплачено", occ("rem-overdue", "Платёж: Сбер"));
  // Открылась карточка долга с отметкой платежа по графику.
  await browser.$('//main//h1[contains(., "Сбер")]').waitForDisplayed({ timeout: 5000 });
  assert.equal(await (await browser.$('[role="dialog"] [name="principal"]')).getValue(), "10477,23");
  await save(browser);
  await waitText(browser, '//tr[@data-testid="schedule-row"][1]', /оплачен/);
  await openReminders();
  assert.equal(await browser.$(occ("rem-overdue", "Платёж: Сбер")).isExisting(), false);
  // Следующий платёж — в ближайших.
  await waitText(browser, '[data-testid="rem-upcoming"]', /Платёж: Сбер/);
});

test("вид месяца: платёж по кредиту, подарок 20-го и сколько ещё заплатить", async () => {
  await openReminders();
  await newReminder({ title: "Подарок маме", date: `${futureMonth}-20`, time: "10:00", repeat: "Ежегодно", amount: "5000", category: "Подарки" });
  await click(browser, "Месяц");
  while (!(await browser.$(`[data-testid="cal-day"][data-date="${futureMonth}-20"]`).isExisting())) {
    await (await browser.$('button[aria-label="Следующий месяц"]')).click();
  }
  await waitContent(browser, `[data-testid="cal-day"][data-date="${futureMonth}-20"]`, /Подарок маме/);
  const debtDays = await browser.$$('[data-testid="cal-day"] [data-testid="cal-debt"]');
  assert.equal(debtDays.length, 1, "в месяце один платёж по кредиту");
  // Кредит 14 977,23 + ЖКХ 6 000 + подарок 5 000.
  await waitText(browser, '[data-testid="cal-planned"]', money("25 977,23 ₽"));
  await waitText(browser, '[data-testid="cal-expense"]', money("0 ₽"));
});

test("день календаря: операция на дату и заметка, неделя показывает расходы", async () => {
  await openSection(browser, "Календарь");
  await (await browser.$(`[data-testid="cal-day"][data-date="${today}"] .cal-num`)).click();
  await browser.$('[data-testid="day-panel"]').waitForDisplayed({ timeout: 5000 });
  await click(browser, "+ Операция", '//*[@data-testid="day-panel"]');
  await fill(browser, "amount", "45000");
  await fill(browser, "payee", "Холодильник");
  await choose(browser, "category", "Прочие расходы");
  await save(browser);
  await waitText(browser, '[data-testid="day-panel"]', money("−45 000 ₽"));
  await waitContent(browser, `[data-testid="cal-day"][data-date="${today}"]`, money("−55 730 ₽"));
  // За день: ЖКХ 6 230 + проценты по кредиту 4 500 + холодильник 45 000.
  // Заметка на день.
  await fill(browser, "newNote", "Позвонить в сервис");
  await click(browser, "Добавить", '//*[@data-testid="day-panel"]');
  await waitText(browser, '[data-testid="day-panel"] [data-testid="notes"]', /Позвонить в сервис/);
  await waitContent(browser, `[data-testid="cal-day"][data-date="${today}"]`, /✎ Позвонить в сервис/);

  await click(browser, "Неделя");
  await waitCount(browser, '[data-testid="week-day"]', 7);
  await waitContent(browser, '[data-testid="week"]', money("−55 730 ₽"));
});

test("заметка к покупке: «гарантия до 10.2028» находится поиском", async () => {
  await openSection(browser, "Операции");
  await (await browser.$('//tr[@data-testid="txn-row"][.//*[contains(., "Холодильник")]]/td[2]')).click();
  await browser.$('[role="dialog"] [data-testid="notes-block"]').waitForDisplayed({ timeout: 5000 });
  await fill(browser, "newNote", "Гарантия до 10.2028, чек в ящике");
  await click(browser, "Добавить", '//*[@role="dialog"]');
  await waitText(browser, '[role="dialog"] [data-testid="notes"]', /Гарантия до 10\.2028/);
  await browser.keys("Escape");

  await openSection(browser, "Заметки");
  await fill(browser, "noteSearch", "гарантия");
  await waitText(browser, '[data-testid="notes"]', /Гарантия до 10\.2028, чек в ящике/);
  await waitText(browser, '[data-testid="notes"]', /Операция: .*Холодильник/);
  // Поиск срабатывает после паузы в наборе: ждём, пока в списке останется одна заметка.
  await browser.waitUntil(async () => (await browser.$$('[data-testid="note"]')).length === 1, { timeout: 5000 });
  await fill(browser, "noteSearch", "ящик");
  await waitText(browser, '[data-testid="notes"]', /Гарантия/);
  await fill(browser, "noteSearch", "пылесос");
  await waitText(browser, "main", /Ничего не нашлось/);
});

test("заметка в карточке долга", async () => {
  await openSection(browser, "Займы и долги");
  await (await browser.$('//tr[@data-testid="debt-row" and @data-name="Сбер"]//div[@class="main"]')).click();
  await fill(browser, "newNote", "Договор № 123, телефон 900");
  await click(browser, "Добавить", '//*[@data-testid="notes-block"]');
  await waitText(browser, '[data-testid="notes-block"]', /Договор № 123/);
  await openSection(browser, "Заметки");
  await waitText(browser, '[data-testid="notes"]', /Долг: Сбер/);
});

test("Главная показывает ближайшие напоминания", async () => {
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="home-reminders"]', /Платёж: Сбер/);
});

test("окно пропущенных напоминаний при запуске", async () => {
  await openReminders();
  await newReminder({ title: "Продлить ОСАГО", date: today, time: "00:01", amount: "12000" });
  // Перезапуск с теми же данными.
  await stop(browser);
  ({ browser } = await start(dataDir));
  const dialog = '[role="dialog"][aria-label="Пропущенные напоминания"]';
  await browser.$(dialog).waitForDisplayed({ timeout: 15000 });
  await waitText(browser, dialog, /Продлить ОСАГО/);
  await waitText(browser, dialog, money("12 000 ₽"));
  // Выполненное и оплаченное в список не попали.
  const text = await browser.$(dialog).getText();
  assert.ok(!/ЖКХ|Сбер/.test(text), text);
  await click(browser, "Выполнено", `//*[@data-testid="missed"]//li[@data-title="Продлить ОСАГО"]`);
  // Последнее пропущенное выполнено — окно закрылось само.
  await browser.$(dialog).waitForExist({ timeout: 5000, reverse: true });
  await openReminders();
  await waitText(browser, '[data-testid="rem-done"]', /Продлить ОСАГО/);
});
