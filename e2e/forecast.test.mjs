// «Взгляд вперёд» (0.18): прогноз на 12 месяцев, сценарий «что если» и поток денег на настоящем окне.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, waitCount, money } from "./app.mjs";

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const now = new Date();
const monthName = (delta) => MONTHS[(now.getMonth() + delta) % 12];
const PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];

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

test("без истории прогноз ровный: 100 000 ₽ все 12 месяцев, денег хватает", async () => {
  await openSection(browser, "Взгляд вперёд");
  await waitText(browser, '[data-testid="fc-now"]', money("100 000 ₽"));
  await waitText(browser, '[data-testid="fc-end"]', money("100 000 ₽"));
  await waitText(browser, '[data-testid="fc-ok"]', /хватает на все 12 месяцев/);
  await waitCount(browser, '[data-testid="fc-row"]', 12);
  await waitText(browser, '[data-testid="fc-how"]', /ещё нет/);
});

test("сценарий «Ипотека» −45 000 ₽ в месяц: на четвёртом месяце денег не хватит, удаление возвращает обычный прогноз", async () => {
  await click(browser, "+ Сценарий");
  await click(browser, "Ипотека или кредит", '//*[@role="dialog"]');
  await waitCount(browser, '[data-testid="scenario-row"]', 1);
  assert.equal(await (await browser.$('[name="scenario-name"]')).getValue(), "Ипотека");
  await save(browser);
  await waitText(browser, '[data-testid="fc-short"]', new RegExp(`В ${PREP[(now.getMonth() + 3) % 12]} \\d{4} денег может не хватить`));
  // 100 000 − 3 × 45 000 = −35 000 ₽ к концу четвёртого месяца, в конце года −395 000 ₽.
  await waitText(browser, '[data-testid="fc-short"]', money("−35 000 ₽"));
  await waitText(browser, '[data-testid="fc-end"]', money("−395 000 ₽"));
  await waitText(browser, '[data-testid="fc-table"] thead', /Ипотека/);

  // «Как сейчас» — без сценария, сценарий остаётся в списке.
  await click(browser, "Как сейчас");
  await waitText(browser, '[data-testid="fc-ok"]', /хватает/);
  await click(browser, "Ипотека", '//*[@data-testid="scenario-bar"]');
  await waitText(browser, '[data-testid="fc-short"]', /не хватить/);

  await (await browser.$('button[aria-label="Изменить сценарий «Ипотека»"]')).click();
  await click(browser, "Удалить", '//*[@role="dialog"]');
  await browser.waitUntil(async () => !(await browser.$('[role="dialog"]').isExisting()), { timeout: 5000 });
  await waitText(browser, '[data-testid="fc-ok"]', /хватает на все 12 месяцев\.$/);
  await waitCount(browser, '[data-testid="scenario-chip"]', 0);
});

test("поток денег за месяц: продукты справа, недостающее — «Из накоплений» слева", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "5000");
  await choose(browser, "account", "Карта (₽)");
  await choose(browser, "category", "Продукты");
  await save(browser);
  await openSection(browser, "Взгляд вперёд");
  await waitText(browser, '[data-testid="fc-now"]', money("95 000 ₽"));
  await click(browser, "Поток денег", '//*[@role="tablist"]');
  await waitText(browser, '[data-testid="flow-title"]', new RegExp(monthName(11)));
  await waitText(browser, '[data-testid="flow-card"]', /доходов и расходов нет/);
  await (await browser.$('button[aria-label="Позже"]')).click();
  await waitText(browser, '[data-testid="flow-title"]', new RegExp(monthName(0)));
  await waitText(browser, '[data-testid="flow-chart"]', /Продукты/);
  await waitText(browser, '[data-testid="flow-chart"]', /Из накоплений/);
  await waitText(browser, '[data-testid="flow-card"]', money("Расходы 5 000 ₽"));
});
