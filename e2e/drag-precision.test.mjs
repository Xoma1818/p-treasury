import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { onboard, openSection, start, stop } from "./app.mjs";
import { pointerDrag } from "./pointer-drag.mjs";

let browser;
const moveNotice = () => browser.execute(() => document.querySelector('[data-testid="move-result"]')?.textContent);
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "50000" }, { name: "Запас", balance: "37000" }]);
});

test("счёт: перенос перед счётом другой группы меняет группу и порядок, сохраняет каждый баланс и отменяется за один шаг", async () => {
  const read = async () => (await invoke("list_accounts", { includeArchived: false })).map(({ id, groupId, sortOrder, balance }) => ({ id, groupId, sortOrder, balance }));
  const accounts = await invoke("list_accounts", { includeArchived: false });
  const target = accounts[0], source = accounts[1];
  const group = await invoke("create_account_group", { name: "На месяц" });
  await invoke("set_account_group", { id: target.id, groupId: group });
  const initial = await read();
  const undo = (await invoke("undo_state")).undo.id;
  await openSection(browser, "Счета");
  const sourceRow = `[data-testid="account-row"][data-name="${source.name}"]`;
  const targetRow = `[data-testid="account-row"][data-name="${target.name}"]`;
  await browser.$(`[data-group="На месяц"] ${targetRow}`).waitForExist();
  await pointerDrag(browser, sourceRow, targetRow, { beforeRelease: () => browser.keys("Escape") });
  assert.deepEqual(await read(), initial);
  assert.equal(await moveNotice(), "");
  await pointerDrag(browser, sourceRow, targetRow);
  await browser.waitUntil(async () => (await read())[0].id === source.id);
  const moved = await read();
  assert.deepEqual(moved.map((a) => [a.id, a.groupId]), [[source.id, group], [target.id, group]]);
  assert.deepEqual(moved.map((a) => a.balance), [initial[1].balance, initial[0].balance]);
  await browser.$(`[data-group="На месяц"] ${sourceRow}`).waitForExist();
  await browser.waitUntil(async () => (await moveNotice()) === `«${source.name}» в группе «На месяц», перед счётом «${target.name}».`);
  await browser.keys(["Control", "z"]);
  await browser.waitUntil(async () => (await read())[0].id === target.id);
  assert.deepEqual(await read(), initial);
  assert.equal((await invoke("undo_state")).undo.id, undo);
});
after(async () => { await stop(browser); });

async function invoke(command, args = {}) {
  const { value, error } = await browser.executeAsync((command, args, done) => {
    window.__TAURI_INTERNALS__.invoke(command, args).then((value) => done({ value }), (e) => done({ error: String(e) }));
  }, command, args);
  assert.equal(error, undefined, command + ": " + error);
  return value;
}

test("календарь: исходная дата, Escape и потеря фокуса отменяют жест; точное отпускание перемещает запись одним шагом", async () => {
  const [card] = await invoke("list_accounts", { includeArchived: false });
  const category = (await invoke("list_categories", { includeArchived: false })).find((c) => c.kind === "expense");
  const month = (await invoke("app_info")).today.slice(0, 7);
  const from = month + "-11", to = month + "-12";
  const id = await invoke("create_transaction", {
    input: { type: "expense", date: from, amount: 100000, accountId: card.id, categoryId: category.id, payee: "Проверка переноса" },
    eventId: null,
  });
  const snapshot = async () => {
    const rows = await invoke("list_transactions", { filter: { accountId: card.id, types: ["expense"] } });
    assert.equal(rows.total, 1);
    assert.equal(rows.items[0].id, id);
    assert.equal(rows.items[0].amount, 100000);
    return { date: rows.items[0].date, undo: (await invoke("undo_state")).undo?.id,
      balance: (await invoke("list_accounts", { includeArchived: false }))[0].balance };
  };
  const original = await snapshot();
  const day = (date) => `[data-testid="cal-day"][data-date="${date}"]`;
  const row = '[data-testid="day-panel"] [data-drag-source="calendar-txn"]';
  await openSection(browser, "Календарь");
  await browser.$(day(from)).click();
  await browser.$(row).waitForExist();
  await pointerDrag(browser, row, day(from), { allowed: false });
  assert.deepEqual(await snapshot(), original);
  await pointerDrag(browser, row, day(to), { beforeRelease: () => browser.keys("Escape") });
  assert.deepEqual(await snapshot(), original);
  // Deterministic coverage of the cancellation handler. Physical Alt+Tab is a separate native-window check.
  await pointerDrag(browser, row, day(to), { beforeRelease: () => browser.execute(() => window.dispatchEvent(new Event("blur"))) });
  assert.deepEqual(await snapshot(), original);
  assert.equal(await moveNotice(), "");
  await pointerDrag(browser, row, day(to));
  await browser.waitUntil(async () => (await snapshot()).date === to);
  assert.equal((await snapshot()).balance, original.balance);
  await browser.$(row).waitForExist({ reverse: true });
  await browser.waitUntil(async () => (await moveNotice()) === "Операция перенесена на " + to.split("-").reverse().join(".") + ".");
  await browser.keys(["Control", "z"]);
  await browser.waitUntil(async () => (await snapshot()).date === from);
  assert.deepEqual(await snapshot(), original, "одна отмена восстанавливает исходную операцию и предыдущий шаг журнала");
  assert.equal(await browser.$('[role="dialog"]').isExisting(), false);
});
