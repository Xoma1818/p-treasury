import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { choose, click, clickControl, fill, money, onboard, openSection, save, start, stop, waitText } from "./app.mjs";
import { holdCommands } from "./hold-commands.mjs";

const modal = '[role="dialog"]';
const input = (name) => modal + ' [name="' + name + '"]';
let browser, cardId, debtId, today;

async function invoke(command, args = {}) {
  const result = await browser.executeAsync((command, args, done) => {
    window.__TAURI_INTERNALS__.invoke(command, args).then(value => done({ value }), e => done({ error: String(e) }));
  }, command, args);
  assert.equal(result.error, undefined, command + ": " + result.error);
  return result.value;
}

async function push(selector) {
  const button = await browser.$(selector);
  await button.waitForExist();
  await clickControl(browser, button, selector);
}
const reveal = () => push(modal + ' [data-testid="form-amounts-toggle"]');
async function valueIs(name, expected) {
  const el = await browser.$(input(name));
  await el.waitForExist();
  await browser.waitUntil(async () => await el.getValue() === expected, { timeoutMsg: "Неверное значение " + name });
  if (expected === "•••") assert.equal(await el.getProperty("readOnly"), true);
}
async function privateMode(on) {
  const button = await browser.$('[data-testid="hide-amounts"]');
  if (await button.getAttribute("aria-checked") !== String(on)) await browser.keys(["Control", "h"]);
  await browser.waitUntil(async () => await button.getAttribute("aria-checked") === String(on));
}
async function dismiss() {
  await browser.keys("Escape");
  await browser.$(modal).waitForExist({ reverse: true });
}
// В маске сверяем фактический текст, значения полей и подписи, доступные при наведении и с клавиатуры.
async function assertMasked(scope, ...amounts) {
  const exposed = await browser.execute((selector, amounts) => {
    const root = document.querySelector(selector);
    if (!root) throw Error(selector);
    const surfaces = [root.textContent];
    for (const node of root.querySelectorAll("input,textarea,[value],[title],[placeholder],[aria-label],[aria-valuetext]")) {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) surfaces.push(node.value);
      for (const attr of ["value","title","placeholder","aria-label","aria-valuetext"]) surfaces.push(node.getAttribute(attr));
    }
    return amounts.find(amount => surfaces.some(s => s?.replace(/\s/gu, "").replaceAll(".", ",").includes(amount))) ?? null;
  }, scope, amounts);
  assert.equal(exposed, null, "В открытой поверхности появилась учебная сумма: " + exposed);
}

before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта для кофе", balance: "1000" }, { name: "Деньги для платежа", balance: "5000" }]);
  const accounts = await invoke("list_accounts", { includeArchived: false });
  cardId = accounts.find(a => a.name === "Карта для кофе").id;
  const dates = await browser.execute(() => {
    const day = offset => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
    };
    return [day(0), day(-2), day(2)];
  });
  today = dates[0];
  for (const [name, valuation] of [["Портфель А", 8345211], ["Портфель Б", 7234168]]) {
    const accountId = await invoke("create_account", { input: { name, type: "investment", currencyCode: "RUB", openingDate: today,
      openingBalance: 0, includeInTotal: true, investKind: "broker" } });
    await invoke("set_invest_value", { accountId, date: today, value: valuation });
  }
  await invoke("set_invest_plan", { mode: "amount", value: 1234567, month: null });
  debtId = await invoke("create_debt", { input: { direction: "borrowed", counterparty: "Учебный заём", currencyCode: "RUB",
    principal: 1200000, rateBp: 0, repaymentType: "annuity", termMonths: 3, issueDate: dates[1], firstPaymentDate: dates[2],
    maturityDate: null, accountId: null, note: null } });
  const expense = (await invoke("list_categories", { includeArchived: false })).find(c => c.kind === "expense" && !c.parentId);
  for (const [name, accountId] of [["Кофе", cardId], ["Выбрать счёт", null]]) {
    await invoke("create_template", { input: { name, type: "expense", amount: 25000, accountId, categoryId: expense.id, toAccountId: null, payee: "Кофейня", note: null } });
  }
  await invoke("create_template", { input: { name: "Проезд", type: "expense", amount: 17500,
    accountId: accounts.find(a => a.name === "Деньги для платежа").id, categoryId: expense.id, toAccountId: null, payee: "Транспорт", note: null } });
  await invoke("set_setting", { key: "hide_amounts", value: "1" });
  await browser.refresh();
});
afterEach(async () => {
  if (browser && await browser.$(modal).isExisting()) await dismiss();
});
after(async () => { await stop(browser); });

test("инвестиционный план скрыт при открытии; раскрытие локально, отмена оставляет исходную сумму", async () => {
  await openSection(browser, "Главная");
  await push('[data-testid="invest-plan-edit"]');
  await valueIs("investPlanAmount", "•••");
  await assertMasked(modal, "12345,67");
  await reveal();
  await valueIs("investPlanAmount", "12345,67");
  await assertMasked('[data-testid="invest-month"]', "12345,67");
  await fill(browser, "investPlanAmount", "15432,18");
  await privateMode(false);
  await privateMode(true);
  await valueIs("investPlanAmount", "•••");
  await assertMasked(modal, "15432,18");
  await reveal();
  await valueIs("investPlanAmount", "15432,18");
  await dismiss();
  await push('[data-testid="invest-plan-edit"]');
  await valueIs("investPlanAmount", "•••");
  await reveal();
  await valueIs("investPlanAmount", "12345,67");
});

test("оценки двух портфелей и калькулятор получают собственное разрешение", async () => {
  await openSection(browser, "Главная");
  await push('[data-testid="invest-value-open"]');
  await choose(browser, "investAccount", "Портфель А");
  await valueIs("investValue", "•••");
  await assertMasked(modal, "83452,11", "72341,68");
  await reveal();
  await valueIs("investValue", "83452,11");
  await waitText(browser, '[data-testid="invest-history"]', money("83 452,11 ₽"));
  await choose(browser, "investAccount", "Портфель Б");
  await valueIs("investValue", "•••");
  await assertMasked(modal, "72341,68");
  await reveal();
  await valueIs("investValue", "72341,68");
  await dismiss();
  await push('[data-testid="invest-calc-open"]');
  await valueIs("calcStart", "•••");
  await valueIs("calcMonthly", "•••");
  await assertMasked(modal, "12345,67", "155793,79");
  await reveal();
  await valueIs("calcStart", "155793,79");
  await valueIs("calcMonthly", "12345,67");
  assert.equal(await browser.$(input("calcRate")).getValue(), "12");
});

test("платёж по займу скрывает тело и нулевые проценты; подтверждение меняет долг один раз", async () => {
  await openSection(browser, "Займы и долги");
  await push('[data-testid="debt-row"][data-name="Учебный заём"]');
  await click(browser, "Оплачено");
  await valueIs("principal", "•••");
  await valueIs("interest", "•••");
  await assertMasked(modal, "4000", "12000");
  await reveal();
  await valueIs("principal", "4000");
  await valueIs("interest", "0");
  await choose(browser, "payAccount", "Деньги для платежа (₽)");
  await save(browser);
  const debtor = await invoke("get_debt", { id: debtId });
  assert.equal(debtor.card.outstanding, 800000);
  assert.deepEqual(debtor.payments.map(p => [p.principal, p.interest]), [[400000, 0]]);
  const accounts = await invoke("list_accounts", { includeArchived: false });
  assert.equal(accounts.find(a => a.name === "Деньги для платежа").balance, 100000);
  assert.equal((await invoke("period_summary", { from: today, to: today })).expense, 0);
  await push('[data-testid="tab-history"]');
  const history = '[data-testid="history"]';
  await waitText(browser, history + ' [data-testid="version"] .history-head b', /Изменение графика/);
  await assertMasked(history, "4000", "8000", "12000");
  await push(history + ' [data-testid="form-amounts-toggle"]');
  await waitText(browser, history, money("Платёж 4 000 ₽"));
  await push(history + ' [data-testid="form-amounts-toggle"]');
  await click(browser, "Изменить условия");
  await valueIs("termsPrincipal", "•••");
  await reveal();
  await valueIs("termsPrincipal", "12000");
  await fill(browser, "termsPrincipal", "3000");
  await waitText(browser, modal, /меньше уже возвращённого/i);
  await reveal();
  await valueIs("termsPrincipal", "•••");
  await assertMasked(modal, "3000", "4000", "12000");
  await dismiss();
  assert.equal((await invoke("get_debt", { id: debtId })).card.principal, 1200000);
});

test("двойное применение шаблона записывает один расход; неполный шаблон открывает приватный черновик", async () => {
  await openSection(browser, "Главная");
  const card = '[data-testid="templates-card"]';
  const template = name => card + ' [data-name="' + name + '"] .template-main';
  const balance = async () => (await invoke("list_accounts", { includeArchived: false })).find(a => a.id === cardId).balance;
  const expenses = () => invoke("list_transactions", { filter: { types: ["expense"], accountId: cardId } });
  await waitText(browser, card, /Кофе/);
  await assertMasked(card, "250");
  assert.equal(await balance(), 100000);
  assert.equal((await expenses()).total, 0);
  await holdCommands(browser, ["apply_template"]);
  try {
    await browser.execute(selector => {
      const button = document.querySelector(selector);
      button.click();
      button.click();
    }, template("Кофе"));
    await browser.waitUntil(() => browser.execute(() => window.heldCommands.calls.length > 0));
    assert.equal(await browser.$(template("Кофе")).isEnabled(), false);
    assert.equal(await balance(), 100000);
    assert.equal((await expenses()).total, 0);
    await openSection(browser, "Операции");
    await push('[data-testid="head-more"]');
    const menuCoffee = await browser.$('//*[@role="menuitem" and normalize-space()="Кофе"]');
    await menuCoffee.waitForExist();
    assert.equal(await menuCoffee.isEnabled(), false);
    assert.equal(await browser.$('//*[@role="menuitem" and normalize-space()="Выбрать счёт"]').isEnabled(), true);
    await browser.execute(() => window.heldCommands.release());
    await browser.waitUntil(async () => await menuCoffee.isEnabled());
    await browser.keys("Escape");
    assert.deepEqual(await browser.execute(() => window.heldCommands.calls), ["apply_template"]);
  } finally {
    await browser.execute(() => window.heldCommands?.restore());
  }
  const rows = await expenses();
  assert.equal(rows.total, 1);
  assert.equal(rows.items[0].amount, 25000);
  assert.equal(await balance(), 75000);
  assert.equal((await invoke("period_summary", { from: today, to: today })).expense, 25000);
  await openSection(browser, "Главная");
  await push(template("Выбрать счёт"));
  await valueIs("amount", "•••");
  await assertMasked(modal, "250");
  await reveal();
  await valueIs("amount", "250");
  await dismiss();
  assert.equal(await balance(), 75000);
  assert.equal((await expenses()).total, 1);
});

test("отказ во время смены экрана остаётся виден, после исправления тот же шаблон можно применить", async () => {
  await openSection(browser, "Главная");
  const total = async () => (await invoke("list_transactions", { filter: { types: ["expense"], accountId: cardId } })).total;
  const balance = async () => (await invoke("list_accounts", { includeArchived: true })).find(a => a.id === cardId).balance;
  const count = await total();
  const before = await balance();
  await holdCommands(browser, ["apply_template"]);
  try {
    await push('[data-testid="templates-card"] [data-name="Кофе"] .template-main');
    await browser.waitUntil(() => browser.execute(() => window.heldCommands.calls.length === 1));
    await openSection(browser, "Операции");
    await invoke("archive_account", { id: cardId, archived: true });
    await browser.execute(() => window.heldCommands.release());
    await waitText(browser, "main", /в шаблоне не хватает/i);
    assert.equal(await total(), count);
    assert.equal(await balance(), before);
  } finally {
    await browser.execute(() => window.heldCommands?.restore());
    await invoke("archive_account", { id: cardId, archived: false });
  }
  const otherAccount = (await invoke("list_accounts", { includeArchived: false })).find(a => a.name === "Деньги для платежа");
  await push('[data-testid="head-more"]');
  await click(browser, "Проезд", '//*[@role="menu"]');
  await browser.waitUntil(async () => (await invoke("list_accounts", { includeArchived: false }))
    .find(a => a.id === otherAccount.id).balance === otherAccount.balance - 17500);
  await waitText(browser, "main", /в шаблоне не хватает/i);
  await push('[data-testid="head-more"]');
  await click(browser, "Кофе", '//*[@role="menu"]');
  await browser.waitUntil(async () => await total() === count + 1);
  assert.equal(await balance(), before - 25000);
  await browser.waitUntil(async () => !/в шаблоне не хватает/i.test(await browser.$("main").getText()));
});

test("инвестиционный план 1 200 ¥ хранится в целых иенах и не подставляется в рублёвый калькулятор", async () => {
  const month = today.slice(0, 7);
  if (!(await invoke("get_budget", { month })).id) await invoke("create_budget", { month, copyPrevious: false });
  assert.equal((await invoke("get_budget", { month })).currencyCode, "RUB");
  const yen = await invoke("create_account", { input: { name: "Портфель в иенах", type: "investment", currencyCode: "JPY",
    openingDate: today, openingBalance: 0, includeInTotal: true, investKind: "broker" } });
  try {
    await invoke("set_invest_value", { accountId: yen, date: today, value: 61234 });
    await invoke("set_setting", { key: "base_currency", value: "JPY" });
    await browser.refresh();
    await openSection(browser, "Бюджет");
    await waitText(browser, '[data-testid="plan-fact-verdict"]', /RUB.*JPY/);
    assert.equal(await browser.$('[data-testid="plan-fact-left"]').isExisting(), false);
    const previousPlan = (await invoke("invest_overview")).month.plan;
    await push('[data-testid="plan-fact-invest-edit"]');
    await valueIs("investPlanAmount", "•••");
    await reveal();
    await fill(browser, "investPlanAmount", "1200");
    await save(browser);
    const overview = await invoke("invest_overview");
    assert.equal(overview.baseCurrency, "JPY");
    assert.equal(overview.month.plan.value, 1200);
    assert.equal(overview.month.planned, 1200);
    assert.ok(overview.value >= 61234, "в исходных данных есть реальная оценка в иенах");
    await browser.keys(["Control", "z"]);
    await browser.waitUntil(async () => {
      const plan = (await invoke("invest_overview")).month.plan;
      return plan.mode === previousPlan.mode && plan.value === previousPlan.value;
    }, { timeoutMsg: "Ctrl+Z не вернул исходный инвестиционный план" });
    await browser.keys(["Control", "y"]);
    await browser.waitUntil(async () => (await invoke("invest_overview")).month.planned === 1200);
    await privateMode(false);
    await waitText(browser, '[data-testid="plan-fact-invest"]', money("1 200 ¥"));
    await privateMode(true);
    await openSection(browser, "Главная");
    await push('[data-testid="invest-plan-edit"]');
    await valueIs("investPlanAmount", "•••");
    await reveal();
    await valueIs("investPlanAmount", "1200");
    await dismiss();
    await push('[data-testid="invest-calc-open"]');
    await valueIs("calcMonthly", "•••");
    await reveal();
    await valueIs("calcStart", "");
    await valueIs("calcMonthly", "");
  } finally {
    if (await browser.$(modal).isExisting()) await dismiss();
    await invoke("set_setting", { key: "base_currency", value: "RUB" });
    await invoke("set_invest_plan", { mode: "amount", value: 1234567, month: null });
    await invoke("archive_account", { id: yen, archived: true });
    await browser.refresh();
  }
});
