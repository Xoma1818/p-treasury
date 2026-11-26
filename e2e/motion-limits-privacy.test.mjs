import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { click, clickControl, fill, onboard, openSection, start, stop, waitText } from "./app.mjs";

let browser;
const dialog = '[role="dialog"]';
const budget = '[data-testid="budget-expense"]';
const line = budget + ' [data-category="Проверка лимита"]';
const field = (name) => dialog + ` input[name="${name}"]`;
const toggle = '[data-testid="form-amounts-toggle"]';
const waitValue = (selector, value) => browser.waitUntil(async () =>
  (await browser.$(selector).isExisting()) && (await browser.$(selector).getValue()) === value);
const reveal = async (selector) => clickControl(browser, await browser.$(selector), "Локальное раскрытие сумм");

before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Учебная карта", balance: "100000" }]);
  const error = await browser.executeAsync(async done => {
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    try {
      const now = new Date();
      const monthAt = offset => {
        const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      };
      const month = monthAt(0);
      const { id: accountId } = (await invoke("list_accounts", { includeArchived: false })).find(a => a.name === "Учебная карта");
      await invoke("create_account", { input: { name: "Учебная кредитка", type: "credit", currencyCode: "RUB", openingDate: month + "-01",
        openingBalance: -1327100, creditLimit: 9613700, includeInTotal: true } });
      const category = name => invoke("create_category", { input: { name, kind: "expense", parentId: null } });
      const target = await category("Проверка лимита");
      const source = await category("Источник лимита");
      const budgetId = (await invoke("get_budget", { month })).id ?? await invoke("create_budget", { month, copyPrevious: false });
      await invoke("set_budget_limit", { budgetId, categoryId: target, limit: 2175300 });
      await invoke("set_budget_limit", { budgetId, categoryId: source, limit: 3594700 });
      for (const offset of [-3, -2, -1, 0]) {
        await invoke("create_transaction", { input: { type: "expense", date: monthAt(offset) + "-01", accountId, categoryId: target,
          amount: offset === 0 ? 2607000 : 674900, toAccountId: null, toAmount: null, payee: null, note: null } });
      }
      await invoke("set_setting", { key: "hide_amounts", value: "1" });
      done(null);
    } catch (err) { done(String(err)); }
  });
  assert.equal(error, null);
  await browser.refresh();
});
after(async () => { await stop(browser); });

async function assertPrivate(scope, numbers) {
  const leaked = await browser.execute((selector, secrets) => {
    const root = document.querySelector(selector);
    if (!root) return "Нет проверяемой формы";
    const values = [root.textContent];
    for (const e of root.querySelectorAll("input, [title], [aria-label], [aria-valuetext]")) {
      if (e instanceof HTMLInputElement) values.push(e.value, e.getAttribute("value"));
      values.push(e.title, e.getAttribute("aria-label"), e.getAttribute("aria-valuetext"));
    }
    return secrets.find(n => values.some(v => v && v.replace(/\s/gu, "").includes(n))) ?? null;
  }, scope, numbers);
  assert.equal(leaked, null);
}

test("остаток и кредитный лимит закрыты при открытии и после Ctrl+H, введённый черновик доступен при повторном раскрытии", async () => {
  await openSection(browser, "Счета");
  await clickControl(browser, await browser.$('button[aria-label="Ещё: Учебная кредитка"]'), "Действия с кредитным счётом");
  await click(browser, "Изменить", '//*[@role="menu"]');
  await waitValue(field("openingBalance"), "•••");
  await waitValue(field("creditLimit"), "•••");
  await assertPrivate(dialog, ["13271", "96137"]);
  await reveal(dialog + " " + toggle);
  await waitValue(field("creditLimit"), "96137");
  await fill(browser, "creditLimit", "92531");
  const privacy = browser.$('[data-testid="hide-amounts"]');
  await browser.keys(["Control", "h"]);
  await browser.waitUntil(async () => await privacy.getAttribute("aria-checked") === "false");
  await browser.keys(["Control", "h"]);
  await waitValue(field("creditLimit"), "•••");
  await assertPrivate(dialog, ["13271", "96137", "92531"]);
  await reveal(dialog + " " + toggle);
  await waitValue(field("creditLimit"), "92531");
  await click(browser, "Отмена", '//*[@role="dialog"]');
});

test("один переключатель строк, подсказка с обычной тратой, граница раскрытия при открытии покрытия", async () => {
  await openSection(browser, "Бюджет");
  await waitValue(line + ' input[name="limit"]', "•••");
  await browser.$(line + ' [data-testid="usual-pill"]').waitForExist();
  assert.equal((await browser.$$(toggle)).length, 1);
  const privateValues = ["21753", "35947", "26070", "6749", "4317"];
  await assertPrivate(budget, privateValues);
  await reveal(toggle);
  await waitValue(line + ' input[name="limit"]', "21753");
  const usualTitle = await browser.$(line + ' [data-testid="usual-pill"]').getAttribute("title");
  assert.match(usualTitle.replace(/\s/gu, ""), /6749/);
  await click(browser, "Покрыть перерасход…", '//tr[@data-category="Проверка лимита"]');
  await waitValue(line + ' input[name="limit"]', "•••");
  await waitText(browser, dialog + ' [data-testid="cover-confirm"]', /•••/);
  await assertPrivate(dialog, privateValues);
  await reveal(dialog + " " + toggle);
  await waitText(browser, dialog + ' [data-testid="cover-confirm"]', /4\s?317/);
  await assertPrivate(line, privateValues);
  await click(browser, "Отмена", '//*[@role="dialog"]');
  await waitValue(line + ' input[name="limit"]', "•••");
  await assertPrivate(budget, privateValues);
});
