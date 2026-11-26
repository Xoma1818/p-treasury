import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { click, fill, openSection, openSavedView, start, stop, waitText } from "./app.mjs";

const merchant = "Киноклуб";
const row = (currency) => `[data-testid="sub-row"][data-key="киноклуб"][data-currency="${currency}"]`;

async function setupSeries(invoke) {
  const { today } = await invoke("app_info");
  const ago = (n) => {
    const d = new Date(today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const accounts = ["RUB", "JPY"].map(currencyCode => ({
    name: "Счёт " + currencyCode, type: "debit", currencyCode, openingBalance: 1_000_000,
    openingDate: ago(500), creditLimit: null, includeInTotal: true,
  }));
  await invoke("finish_onboarding", { setup: { baseCurrency: "RUB", defaultCategories: true, accounts } });
  await invoke("set_setting", { key: "home_layout", value: JSON.stringify({ order: [], hidden: [] }) });
  await invoke("set_rate", { date: ago(500), from: "JPY", to: "RUB", rate: "0.60" });
  const available = await invoke("list_accounts", { includeArchived: false });
  const accountId = (code) => available.find(a => a.currencyCode === code).id;
  const category = (await invoke("list_categories", { includeArchived: false })).find(c => c.kind === "expense" && !c.parentId);
  const expense = (currency, days, amount, payee, note) => invoke("create_transaction", { input: {
    type: "expense", date: ago(days), accountId: accountId(currency), categoryId: category.id, amount, payee, note,
  }, eventId: null });
  const expected = { RUB: [], JPY: [] };
  let purchase;
  for (const [currency, days, amount] of [["RUB", [65, 35, 5], 39_900], ["JPY", [64, 34, 4], 750]]) {
    for (const day of days) {
      const id = await expense(currency, day, amount, merchant, "Абонемент " + currency);
      expected[currency].push(ago(day).split("-").reverse().join("."));
      if (currency === "RUB") purchase = id;
    }
  }
  await invoke("create_refund", { input: { of: purchase, date: ago(2), amount: 5_000, accountId: null, inPurchaseMonth: true, note: "Частичный возврат" } });
  await expense("RUB", 20, 1_900, merchant + " плюс", "Билет");
  await expense("RUB", 19, 2_500, "Кафе", "После сеанса: " + merchant);
  await expense("RUB", 425, 39_900, merchant, "Старое списание");
  // Ещё один ежемесячный платёж появляется уже после сохранения вида.
  const addEarlierRub = async () => ({
    id: await expense("RUB", 95, 39_900, merchant, "Абонемент RUB"),
    date: ago(95).split("-").reverse().join("."),
  });
  return { expected, addEarlierRub };
}

async function ledger(invoke) {
  const accounts = await invoke("list_accounts", { includeArchived: false });
  const txns = await invoke("list_transactions", { filter: {} });
  return { balances: accounts.map(a => [a.currencyCode, a.balance]).sort(), ids: txns.items.map(t => t.id).sort() };
}

test("Подписки: журнал из Отчётов и Главной показывает платежи выбранной серии, скрытие действует на одну валюту", async t => {
  const dir = mkdtempSync(join(tmpdir(), "kazna-subs-e2e-"));
  const { browser } = await start(dir, { homeDefaults: true, env: {
    XDG_DATA_HOME: join(dir, "xdg-data"), WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
  } });
  t.after(() => stop(browser));
  const invoke = async (command, args = {}) => {
    const reply = await browser.executeAsync((cmd, input, done) => {
      window.__TAURI_INTERNALS__.invoke(cmd, input).then(value => done({ value }), e => done({ error: String(e) }));
    }, command, args);
    assert.equal(reply.error, undefined, command + ": " + reply.error);
    return reply.value;
  };
  await browser.$('[name="baseCurrency"]').waitForDisplayed({ timeout: 15000 });
  const { expected, addEarlierRub } = await setupSeries(invoke);
  const initial = await ledger(invoke);
  assert.equal(initial.ids.length, 10);
  assert.deepEqual(initial.balances, [["JPY", 997_750], ["RUB", 841_000]]);
  await browser.refresh();
  await waitText(browser, "main h1", /Главная/);

  async function checkPayments(currency, dates) {
    await waitText(browser, "main h1", /Операции/);
    await waitText(browser, '[data-testid="txn-count"]', new RegExp("Показано " + dates.length + " из " + dates.length + "$"));
    await browser.$('[data-testid="chip-subscription"]').waitForDisplayed();
    const rows = await browser.execute(() => [...document.querySelectorAll('[data-testid="txn-row"]')].map(tr => ({
      date: tr.querySelector("td.date").textContent, text: tr.innerText,
    })));
    assert.deepEqual(rows.map(r => r.date).sort(), [...dates].sort());
    for (const entry of rows) {
      assert.ok(entry.text.includes(merchant) && entry.text.includes("Счёт " + currency), entry.text);
    }
  }

  async function openPayments(currency) {
    const link = browser.$(row(currency) + " button[data-report-source]");
    await link.waitForDisplayed();
    await link.click();
    await checkPayments(currency, expected[currency]);
  }

  async function backToRubSeries() {
    await browser.$('[data-testid="back-to-report"]').click();
    const selector = row("RUB") + " button[data-report-source]";
    await browser.waitUntil(() => browser.execute(s => document.activeElement === document.querySelector(s), selector),
      { timeout: 5000, timeoutMsg: "Не восстановлен фокус на рублёвой подписке" });
  }

  await openSection(browser, "Отчёты");
  await click(browser, "Подписки");
  await openPayments("RUB");
  const viewName = "Киноклуб в рублях";
  await click(browser, "Сохранить вид");
  await fill(browser, "viewName", viewName);
  await click(browser, "Сохранить");
  await waitText(browser, '[data-testid="views-transactions"]', /Киноклуб в рублях/);
  await backToRubSeries();
  const rub = browser.$(row("RUB"));
  const yen = browser.$(row("JPY"));
  await rub.waitForDisplayed();
  await rub.$('[data-testid="sub-hide"]').click();
  await rub.waitForExist({ reverse: true });
  await yen.waitForDisplayed();
  const hidden = browser.$('//label[contains(., "Показать скрытые")]/input');
  await hidden.click();
  await waitText(browser, row("RUB") + ' [data-testid="sub-hide"]', /Вернуть/);
  await waitText(browser, row("JPY") + ' [data-testid="sub-hide"]', /Не подписка/);
  await openPayments("RUB");
  await backToRubSeries();
  await waitText(browser, row("RUB") + ' [data-testid="sub-hide"]', /Вернуть/);
  assert.ok(await hidden.isSelected());
  await rub.$('[data-testid="sub-hide"]').click();
  await waitText(browser, row("RUB") + ' [data-testid="sub-hide"]', /Не подписка/);
  await openSection(browser, "Главная");
  await openPayments("JPY");
  assert.deepEqual(await ledger(invoke), initial);

  const fourth = await addEarlierRub();
  // После перезагрузки открываем сохранённый вид так же, как при следующем запуске.
  await browser.refresh();
  await openSavedView(browser, "Киноклуб в рублях");
  await checkPayments("RUB", [...expected.RUB, fourth.date]);
  assert.deepEqual(await ledger(invoke), {
    balances: [["JPY", 997_750], ["RUB", 801_100]], ids: [...initial.ids, fourth.id].sort(),
  });
});
