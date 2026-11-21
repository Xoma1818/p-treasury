import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { start, stop, onboard, openSection, click, fill, choose, save, setDate, waitText, money } from "./app.mjs";

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Наличные", balance: "0" }]);
});
after(async () => { await stop(browser); });

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
}

const account = '[data-testid="account-row"][data-name="Счёт выписки"]';
const statementDate = daysAgo(7);

test("историческая сверка показывает сумму на дату и фиксирует совпадение отдельно от корректировки", async () => {
  await openSection(browser, "Счета");
  await click(browser, "+ Новый счёт");
  await fill(browser, "name", "Счёт выписки");
  await fill(browser, "openingBalance", "12000");
  await setDate(browser, "openingDate", daysAgo(14));
  await save(browser);

  await openSection(browser, "Главная");
  await click(browser, "+ Доход");
  await fill(browser, "amount", "3000");
  await choose(browser, "account", "Счёт выписки (₽)");
  await choose(browser, "category", "Заработная плата");
  await save(browser);

  await openSection(browser, "Счета");
  await waitText(browser, account, money("15 000 ₽"));
  await (await browser.$(account).$("button=Сверить")).click();
  await setDate(browser, "date", statementDate);
  await fill(browser, "actualBalance", "12500");
  await waitText(browser, '[data-testid="reconcile-book-balance"]', money("12 000 ₽"));
  await waitText(browser, '[data-testid="reconcile-difference"]', money("+500 ₽"));
  await click(browser, "Посмотреть операции", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="reconcile-operations"]', /Операций за этот период нет/);
  assert.equal(await browser.$('[name="actualBalance"]').getValue(), "12500");
  await save(browser, "Записать корректировку");
  await waitText(browser, account, money("15 500 ₽"));

  await (await browser.$(account).$("button=Сверить")).click();
  await setDate(browser, "date", statementDate);
  await fill(browser, "actualBalance", "12500");
  await waitText(browser, '[data-testid="reconcile-difference"]', /Остатки совпадают/);
  await save(browser, "Завершить сверку");
  await waitText(browser, account + " [data-testid=account-reconciled]", /Сверено на/);
  await waitText(browser, account, money("15 500 ₽"));
});
