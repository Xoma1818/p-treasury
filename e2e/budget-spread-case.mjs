import assert from "node:assert/strict";

// Вызов только после обучения в новом временном бюджете с одним счётом на 80 000 ₽.
export async function checkBudgetSpread(w) {
  const { invoke } = w;
  await invoke("set_setting", { key: "month_start_day", value: "15" });
  const { today } = await invoke("app_info");
  const period = await invoke("month_of", { date: today });
  const [card] = await invoke("list_accounts", { includeArchived: false });
  const category = (await invoke("list_categories", { includeArchived: false })).find((c) => c.kind === "expense" && !c.parentId);
  assert.ok(category);
  const id = await invoke("create_transaction", { input: { type: "expense", date: period.start, accountId: card.id,
    amount: 100000, categoryId: category.id, payee: "Покупка на три месяца" }, eventId: null });
  await invoke("set_transaction_spread", { id, months: 3 });
  const share = '[data-testid="txn-budget-share"]';
  const snapshots = [];
  const [year, month] = period.month.split("-").map(Number);
  for (const [index, part] of [33334, 33333, 33333].entries()) {
    const m = new Date(Date.UTC(year, month - 1 + index, 1)).toISOString().slice(0, 7);
    const existing = await invoke("get_budget", { month: m });
    const budgetId = existing.id ?? await invoke("create_budget", { month: m, copyPrevious: false });
    await invoke("set_budget_limit", { budgetId, categoryId: category.id, limit: 200000 });
    // Открываем Бюджет заново, чтобы кнопка переключения начинала с текущего месяца.
    await w.refresh();
    await w.nav("Бюджет");
    for (let n = 0; n < index; n++) await w.click('button[aria-label="Следующий месяц"]');
    await w.contains(".month-switch", existing.period.end.split("-").reverse().join("."));
    const row = `[data-testid="budget-line"][data-category="${category.name}"] .fact`;
    const expected = index === 0 ? "333,34" : "333,33";
    await w.contains(row, expected);
    await w.click(row);
    await w.contains(share, expected);
    const current = await invoke("get_budget", { month: m });
    assert.equal(current.actualExpense, part);
    const filter = { counted: true, budgetMonth: m, categoryId: category.id, types: ["expense"],
      dateFrom: current.period.start, dateTo: current.period.end };
    const page = await invoke("list_transactions", { filter });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, id);
    assert.equal(page.items[0].amount, 100000);
    assert.equal(page.items[0].countedShare.budgetAmount, part);
    if (index === 0) {
      await w.privacy();
      await w.contains(share, "•••");
      assert.doesNotMatch(await w.text('[data-testid="txn-row"]'), /333,34|1\s*000/);
      await w.privacy();
      await w.contains(share, expected);
      if (w.capture) await w.capture();
    }
    snapshots.push({ period: current.period, part });
  }
  assert.equal((await invoke("list_accounts", { includeArchived: false })).find((a) => a.id === card.id).balance, 7900000);
  assert.equal((await invoke("list_transactions", { filter: { accountId: card.id } })).total, 1);
  assert.equal(snapshots.reduce((sum, s) => sum + s.part, 0), 100000);
  return { id, snapshots, balance: 7900000 };
}
