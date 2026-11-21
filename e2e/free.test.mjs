// 0.27 «Свободно до дохода и резервы»: строка «Свободно до …» на плитке
// баланса и её разбор, резерв внутри счёта в целях и на экране «Счета».
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, click, fill, choose, save, waitText, waitCount, money, showAllHomeCards } from "./app.mjs";

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

let card, salary;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "80000" }]);
  card = (await invoke("list_accounts", { includeArchived: false })).find((a) => a.name === "Карта").id;
  const reminder = (title, date, amount, txnType) =>
    invoke("create_reminder", {
      input: { title, startAt: `${date}T10:00`, repeat: "once", dayOfMonth: null, endDate: null, amount, txnType, accountId: card, categoryId: null, note: null },
    });
  salary = await reminder("Заработная плата", day(10), 10_000_000, "income");
  await reminder("Аренда", day(3), 3_000_000, "expense");
});
after(async () => {
  await stop(browser);
});

test("резерв внутри счёта: отложить и увидеть на «Счетах»", async () => {
  await openSection(browser, "Главная");
  await showAllHomeCards(browser);
  await click(browser, "+ Цель");
  await fill(browser, "goalName", "Отпуск");
  await fill(browser, "goalTarget", "50000");
  await choose(browser, "goalAccount", "Карта (₽)");
  await (await browser.$('[data-testid="goal-reserve-toggle"] input')).click();
  await save(browser);
  const goal = '[data-testid="goal"][data-name="Отпуск"]';
  await waitText(browser, `${goal} [data-testid="goal-reserve"]`, /Резерв на счёте «Карта»/);
  await (await browser.$(`${goal} [data-testid="goal-deposit"]`)).click();
  await fill(browser, "amount", "20000");
  await save(browser);
  await waitText(browser, goal, /40 %[\s\S]*20 000 ₽[\s\S]*из 50 000 ₽/);

  await openSection(browser, "Счета");
  await waitText(browser, '[data-testid="account-reserved"]', money("в резервах 20 000 ₽, свободно 60 000 ₽"));
});

test("«Свободно до дохода»: деньги минус платежи и резервы, по дням", async () => {
  await openSection(browser, "Главная");
  // 80 000 − аренда 30 000 − резерв 20 000 = 30 000 на 10 дней.
  const label = await waitText(browser, '[data-testid="home-free"]', money("30 000 ₽"));
  assert.ok(label.includes(`Свободно до дохода ${day(10).split("-").reverse().join(".")}`));
  assert.doesNotMatch(label, money("3 000 ₽"));
  await (await browser.$('[data-testid="home-free"]')).click();
  await waitCount(browser, '[data-testid="explain-row"][data-kind="payment"]', 1);
  await waitText(browser, '[data-testid="explain-row"][data-kind="reserve"]', /Резерв «Отпуск»/);
  await waitText(browser, '[data-testid="explain-total"]', money("30 000 ₽"));
  await waitText(browser, '[data-testid="explain"] tfoot tr:last-child', /В среднем на день за период \(10 дн\.\)[\s\S]*3[\s\u00A0]000[\s\u00A0]₽/);
  await browser.keys(["Control", "h"]);
  await waitText(browser, '[data-testid="explain-total"]', /•••/);
  assert.doesNotMatch(await browser.$('[data-testid="explain"]').getText(), /₽/);
  await browser.keys(["Control", "h"]);
  await waitText(browser, '[data-testid="explain-total"]', money("30 000 ₽"));
  await browser.keys("Escape");
});

test("без запланированного дохода свободный остаток рассчитан по последний день бюджетного месяца", async () => {
  await invoke("delete_reminder", { id: salary });
  await invoke("set_setting", { key: "month_start_day", value: "15" });
  const period = await invoke("month_of", { date: day(0) });
  await browser.refresh();
  await openSection(browser, "Главная");
  const label = await waitText(browser, '[data-testid="home-free"]', /до конца бюджетного месяца/);
  assert.ok(label.includes(`по ${period.end.split("-").reverse().join(".")}`));
  assert.doesNotMatch(label, /до дохода/);
});
