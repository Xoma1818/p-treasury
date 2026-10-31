// «Напоминания и платежи наперёд» (0.23): серия на N раз с последним платежом другой суммы,
// проверка денег на счёте, правка одного платежа, напоминание у заметки и сроки «заранее» в Настройках.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, chooseLike, click, save, waitText, money, setDate } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const inDays = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));

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

const occ = (title) => `//*[@data-testid="rem-upcoming"]//li[@data-testid="occurrence" and @data-title="${title}"]`;
const lastDialog = '(//*[@role="dialog"])[last()]';

async function openReminders() {
  await openSection(browser, "Календарь");
  await click(browser, "Напоминания");
  await browser.$('[data-testid="rem-all"]').waitForDisplayed({ timeout: 5000 });
}

test("рассрочка: 3 платежа по 5 000 ₽, последний 2 000 ₽ — конец серии считается сам", async () => {
  await openReminders();
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", "Рассрочка");
  await setDate(browser, "reminderDate", inDays(3));
  await choose(browser, "repeat", "Ежемесячно");
  await choose(browser, "reminderEndMode", "Несколько раз");
  await fill(browser, "reminderCount", "3");
  await fill(browser, "reminderAmount", "5000");
  await fill(browser, "reminderLastAmount", "2000");
  await save(browser);
  await waitText(browser, occ("Рассрочка"), money("5 000 ₽"));
  // Правка серии показывает дату конца — третий месяц.
  await (await browser.$('//*[@data-testid="rem-all"]//span[@class="main" and normalize-space()="Рассрочка"]')).click();
  await (await browser.$('[name="reminderEndMode"]')).waitForDisplayed({ timeout: 5000 });
  assert.equal(await (await browser.$('[name="reminderEndMode"]')).getValue(), "date");
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
  const last = new Date(d.getFullYear(), d.getMonth() + 2, 1);
  assert.match(await (await browser.$('[name="reminderEnd"]')).getValue(), new RegExp(`^${iso(last).slice(0, 7)}`));
  assert.equal((await (await browser.$('[name="reminderLastAmount"]')).getValue()).replace(/\s/g, ""), "2000");
  await click(browser, "Отмена", '//*[@role="dialog"]');
});

test("аренда 150 000 ₽ с карты через 2 дня: видно, что не хватит 50 000 ₽; после правки платежа — хватает", async () => {
  await openReminders();
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", "Аренда");
  await setDate(browser, "reminderDate", inDays(2));
  await choose(browser, "repeat", "Ежемесячно");
  await fill(browser, "reminderAmount", "150000");
  await choose(browser, "reminderAccount", "Карта (₽)");
  await chooseLike(browser, "reminderCategory", "ЖКХ");
  await save(browser);
  await waitText(browser, `${occ("Аренда")}//*[@data-testid="shortfall"]`, money("50 000 ₽"));

  // Только этот платёж — 80 000 ₽ и на день позже.
  await click(browser, "Изменить", occ("Аренда"));
  await fill(browser, "occAmount", "80000");
  await setDate(browser, "occDate", inDays(3));
  await save(browser);
  await waitText(browser, occ("Аренда"), /изменён/);
  await waitText(browser, occ("Аренда"), money("80 000 ₽"));
  await browser.waitUntil(async () => !(await browser.$(`${occ("Аренда")}//*[@data-testid="shortfall"]`).isExisting()), { timeout: 5000 });
});

test("заметка «Продлить страховку»: напоминание за неделю прямо из заметки", async () => {
  await openSection(browser, "Заметки");
  await click(browser, "+ Заметка");
  await fill(browser, "noteBody", "Продлить страховку");
  await setDate(browser, "noteDate", inDays(20));
  await save(browser);
  await (await browser.$('//*[@data-testid="note"][contains(., "Продлить страховку")]')).click();
  await click(browser, "Напомнить…", '//*[@role="dialog"]');
  await browser.waitUntil(async () => (await browser.$$('[role="dialog"]')).length === 2, { timeout: 5000 });
  assert.equal(await (await browser.$(`${lastDialog}//*[@name="reminderTitle"]`)).getValue(), "Продлить страховку");
  await (await browser.$(`${lastDialog}//*[@name="reminderLeadMode"]`)).selectByVisibleText("Свои сроки");
  await click(browser, "за 3 дня", lastDialog);
  await click(browser, "за день", lastDialog);
  await click(browser, "за неделю", lastDialog);
  await click(browser, "Сохранить", lastDialog);
  await browser
    .waitUntil(async () => (await browser.$$('[role="dialog"]')).length <= 1, { timeout: 5000 })
    .catch(async () => {
      const alert = await browser.$('[role="alert"]');
      throw new Error(`напоминание не сохранилось: ${(await alert.isExisting()) ? await alert.getText() : "диалогов " + (await browser.$$('[role="dialog"]')).length}`);
    });
  if ((await browser.$$('[role="dialog"]')).length) await click(browser, "Отмена", '//*[@role="dialog"]');
  await (await browser.$('[data-testid="notes"] [aria-label="Есть напоминание"]')).waitForExist({ timeout: 5000 });

  await openReminders();
  await waitText(browser, '[data-testid="rem-all"]', /Продлить страховку.*за неделю.*из заметки/s);
});

test("Настройки: сроки «заранее» по умолчанию и проверка денег", async () => {
  await openSection(browser, "Настройки");
  const picker = '//*[@data-testid="defaultLeadDays"]';
  await (await browser.$(picker)).waitForDisplayed({ timeout: 5000 });
  await click(browser, "за неделю", picker);
  await browser.waitUntil(async () => (await (await browser.$(`${picker}//button[normalize-space()="за неделю"]`)).getAttribute("aria-pressed")) === "true", { timeout: 5000 });
  await choose(browser, "fundsDays", "за 5 дней");
  await openReminders();
  await click(browser, "+ Напоминание");
  const opt = await browser.execute(() => document.querySelector('[name="reminderLeadMode"] option[value="default"]').textContent);
  assert.match(opt, /за неделю, за 3 дня, за день/);
  await click(browser, "Отмена", '//*[@role="dialog"]');
});
