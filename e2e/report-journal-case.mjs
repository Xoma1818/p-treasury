import assert from "node:assert/strict";

const tile = '[data-testid="report-expense"]';
const sum = '[data-testid="sel-sum"]';
const share = '[data-testid="txn-period-share"]';
const back = '[data-testid="back-to-report"]';
const count = '[data-testid="txn-count"]';
const tagName = "Для отчёта";
const localDate = date => date.split("-").reverse().join(".");

async function ledger(invoke) {
  const accounts = await invoke("list_accounts", { includeArchived: false });
  const page = await invoke("list_transactions", { filter: {} });
  return { balances: accounts.map(a => [a.id, a.balance]).sort(), ids: page.items.map(t => t.id).sort() };
}

// Начальный бюджет пуст. Три соседних периода заканчиваются текущим.
export async function openFilteredReportJournal(w) {
  const { invoke } = w;
  assert.equal((await invoke("list_transactions", { filter: {} })).total, 0);
  await invoke("set_setting", { key: "month_start_day", value: "15" });
  const { today } = await invoke("app_info");
  const third = await invoke("month_of", { date: today });
  const [y, m] = third.month.split("-").map(Number);
  const periodBefore = n => invoke("report_period", { kind: "month",
    month: new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7) });
  const first = await periodBefore(2);
  const second = await periodBefore(1);
  assert.equal(second.start.slice(-2), "15");
  assert.equal(second.end.slice(-2), "14");
  const [card] = await invoke("list_accounts", { includeArchived: false });
  const cash = await invoke("create_account", { input: { name: "Другой счёт", type: "cash",
    currencyCode: "RUB", openingBalance: 100000, openingDate: first.start, creditLimit: null, includeInTotal: true } });
  const categories = await invoke("list_categories", { includeArchived: false });
  const [category, other] = categories.filter(c => c.kind === "expense" && !c.parentId);
  const salary = categories.find(c => c.kind === "income" && !c.parentId);
  const expense = (amount, date, payee, accountId = card.id, categoryId = category.id) =>
    invoke("create_transaction", { input: { type: "expense", amount, date, payee, accountId, categoryId }, eventId: null });
  const spread = await expense(100000, first.start, "На три месяца");
  await invoke("set_transaction_spread", { id: spread, months: 3 });
  const purchase = await expense(10000, second.end, "Покупка с возвратом");
  await invoke("create_refund", { input: { of: purchase, date: third.start, amount: 4000,
    accountId: null, inPurchaseMonth: true, note: "Учесть в месяце покупки" } });
  const otherTag = await expense(5000, second.start, "С другой меткой");
  const otherAccount = await expense(2000, second.start, "С другого счёта", cash);
  const otherCategory = await expense(3000, second.start, "В другой категории", card.id, other.id);
  const income = await invoke("create_transaction", { input: { type: "income", amount: 8000, date: second.start,
    accountId: card.id, categoryId: salary.id, payee: "Доход с тегом" }, eventId: null });
  // Возврат наследует тег покупки при отборе. Собственной метки у него нет.
  // Среди двух меток проверяемая — не самая частая (по умолчанию открывается другая).
  for (const id of [spread, purchase, otherAccount, otherCategory, income, otherTag]) {
    await invoke("set_transaction_tags", { id, tags: id === otherTag ? ["Другая"] : ["Другая", tagName] });
  }
  const tag = (await invoke("list_tags")).find(t => t.name === tagName);
  const before = await ledger(invoke);
  assert.deepEqual(before.balances, [[card.id, 7894000], [cash, 98000]].sort());
  assert.equal(before.ids.length, 7);
  await w.refresh();
  await w.nav("Отчёты");
  await w.click('[aria-label="Предыдущий период"]');
  await w.contains(".month-switch", localDate(second.start));
  await w.contains(tile, "493,33");
  await w.choose('[name="reportAccount"]', card.id);
  await w.choose('[name="reportTag"]', tag.id);
  const row = `[data-testid="cat-row"][data-category="${category.name}"]`;
  await w.contains(row + " .num", "393,33");
  await w.click(row + " .cat-link");
  await w.contains("main h1", "Операции");
  await w.contains(count, "Показано 3 из 3");
  await w.contains('[data-testid="chip-account"]', card.name);
  await w.contains('[data-testid="chip-tag"]', tagName);
  await w.contains('[data-testid="txn-refund-tag"]', "возврат");
  const rows = await w.texts('[data-testid="txn-row"]');
  assert.ok(rows.some(r => r.includes("На три месяца") && r.includes(localDate(first.start)) && /1\s*000/.test(r)));
  assert.ok(rows.some(r => r.includes("возврат") && r.includes(localDate(third.start)) && /40\s*₽/.test(r)));
  assert.ok(rows.some(r => r.includes("Покупка с возвратом") && r.includes(localDate(second.end)) && /100\s*₽/.test(r)));
  return { before, first, second, row, card, tag, rows };
}

export async function checkReportJournal(w) {
  const { before, first, second, row, card, tag } = await openFilteredReportJournal(w);
  await w.contains(sum, "393,33");
  await w.contains(share, "333,33");
  if (w.shot) await w.shot("category");
  await w.privacy();
  await w.contains(share, "•••");
  await w.contains(sum, "•••");
  assert.doesNotMatch((await w.texts('[data-testid="txn-row"]')).join("\n"), /333,33|1\s*000|₽/);
  await w.privacy();
  await w.contains(share, "333,33");
  await w.click(back);
  await w.contains(".month-switch", localDate(second.start));
  await w.contains(row + " .num", "393,33");
  assert.equal(await w.value('[name="reportAccount"]'), card.id);
  assert.equal(await w.value('[name="reportTag"]'), tag.id);
  await w.click(tile + " button");
  await w.contains(count, "Показано 6 из 6");
  await w.contains(sum, "493,33");
  assert.equal((await w.texts('[data-testid="chip-account"], [data-testid="chip-tag"]')).length, 0);
  await w.click(back);
  await w.contains(row + " .num", "393,33");
  await w.choose('[name="periodKind"]', "custom");
  await w.setDate("reportFrom", first.start);
  await w.contains(tile, "826,67");
  await w.click(tile + " button");
  await w.contains(count, "Показано 6 из 6");
  await w.contains(sum, "826,67");
  await w.contains(share, "666,67");
  if (w.shot) await w.shot("custom");
  await w.click(back);
  await w.contains(tile, "826,67");
  assert.equal(await w.value('[name="reportFrom"]'), first.start);
  assert.equal(await w.value('[name="reportTo"]'), second.end);
  assert.equal(await w.value('[name="reportAccount"]'), card.id);
  assert.equal(await w.value('[name="reportTag"]'), tag.id);
  await w.press("По месяцам", ".report-tabs");
  await w.choose('[name="reportAccount"]', card.id);
  await w.choose('[name="reportTag"]', tag.id);
  const monthExpense = `[data-testid="month-row"][data-month="${second.month}"] td:nth-child(3) button`;
  await w.contains(monthExpense, "423,33");
  await w.click(monthExpense);
  await w.contains(count, "Показано 4 из 4");
  await w.contains(sum, "423,33");
  await w.contains(share, "333,33");
  await w.click(back);
  await w.contains(monthExpense, "423,33");
  assert.equal(await w.value('[name="reportFrom"]'), first.start);
  assert.equal(await w.value('[name="reportTo"]'), second.end);
  await w.click('[data-testid="more-tabs-toggle"]');
  await w.press("По тегу", ".report-tabs");
  await w.choose('[name="reportTag"]', tag.id);
  const tagExpense = '[data-testid="tag-expense"] button';
  await w.contains(tagExpense, "776,67");
  await w.click(tagExpense);
  await w.contains(count, "Показано 5 из 5");
  await w.contains(sum, "776,67");
  await w.contains(share, "666,67");
  await w.click(back);
  await w.contains(tagExpense, "776,67");
  assert.equal(await w.value('[name="reportTag"]'), tag.id);
  assert.deepEqual(await ledger(w.invoke), before);
  return { first, second, balances: before.balances, transactionIds: before.ids, categoryExpense: 39333,
    periodExpense: 49333, customExpense: 82667, customShare: 66667 };
}
