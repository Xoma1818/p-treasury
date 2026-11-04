// 0.29 «Возвраты и итоги месяца»: «Вернуть…» у расхода с выбором месяца,
// метка «возврат» в списке и окно «Итоги месяца» из Бюджета.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, click, fill, save, waitText, waitCount } from "./app.mjs";

let browser;
const invoke = async (command, args = {}) => {
  const result = await browser.executeAsync((cmd, input, done) => {
    window.__TAURI_INTERNALS__.invoke(cmd, input).then((value) => done({ value }), (error) => done({ error: String(error) }));
  }, command, args);
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  return result.value;
};
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let purchase;
let purchaseMonth;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "50000" }]);
  const card = (await invoke("list_accounts", { includeArchived: false })).find((a) => a.name === "Карта").id;
  const cat = (await invoke("list_categories", { includeArchived: false })).find((c) => c.kind === "expense" && !c.parentId);
  // Покупка полтора месяца назад: возврат сегодня — уже другой бюджетный месяц.
  purchase = await invoke("create_transaction", {
    input: { type: "expense", date: day(-45), accountId: card, amount: 800_000, categoryId: cat.id, toAccountId: null, toAmount: null, payee: "Куртка", note: null },
    eventId: null,
  });
  purchaseMonth = (await invoke("month_of", { date: day(-45) })).month;
});
after(async () => {
  await stop(browser);
});

test("«Вернуть…»: возврат в месяце покупки уменьшает его расходы, деньги на счёте", async () => {
  await openSection(browser, "Операции");
  await click(browser, "Куртка");
  await (await browser.$('[data-testid="txn-refund"]')).click();
  await waitText(browser, '[data-testid="refund-purchase"]', /Куртка/);
  // Месяц покупки выбран по умолчанию.
  await waitCount(browser, '[data-testid="refund-month"] input:checked', 1);
  await fill(browser, "amount", "3000");
  await save(browser);
  await waitCount(browser, '[data-testid="txn-refund-tag"]', 1);

  const review = await invoke("month_review", { month: purchaseMonth });
  assert.equal(review.expense, 500_000);
  assert.equal(review.refunds, 300_000);
  const totals = await invoke("totals", { date: day(0) });
  assert.equal(totals.total, 5_000_000 - 800_000 + 300_000);

  // Возврат открывается своим окном; больше покупки вернуть нельзя.
  await click(browser, "возврат");
  await waitText(browser, '[data-testid="refund-purchase"]', /уже вернули|Куртка/);
  await fill(browser, "amount", "9000");
  await click(browser, "Сохранить", '//*[@role="dialog"]');
  await waitText(browser, '[role="alert"]', /больше, чем стоила покупка/);
  await browser.keys("Escape");
});

test("«Итоги месяца» в Бюджете: доходы, расходы, отложено", async () => {
  await openSection(browser, "Бюджет");
  await (await browser.$('[data-testid="month-review-open"]')).click();
  await waitText(browser, '[data-testid="month-review"]', /Доходы[\s\S]*Расходы[\s\S]*Прогноз и факт/);
  // Текущий месяц ещё идёт: кнопки «Месяц завершён» нет.
  assert.equal(await (await browser.$('[data-testid="review-close"]')).isExisting(), false);
  await browser.keys("Escape");
});
