import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { holdCommands } from "./hold-commands.mjs";
import { click, fill, onboard, openSection, start, stop, waitText } from "./app.mjs";

let browser;
const dialog = '//*[@role="dialog"]';
const amountField = name => browser.$(`[role="dialog"] input[name="${name}"]`);
const reveal = () => browser.$('[role="dialog"] [data-testid="form-amounts-toggle"]').click();
const close = () => click(browser, "Отмена", dialog);

async function invoke(command, args) {
  const result = await browser.executeAsync((cmd, input, done) => {
    window.__TAURI_INTERNALS__.invoke(cmd, input).then(value => done({ value }), error => done({ error: String(error) }));
  }, command, args);
  assert.equal(result.error, undefined, command);
  return result.value;
}

before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "100000" }]);
  const { id: accountId } = (await invoke("list_accounts", { includeArchived: false })).find(a => a.name === "Карта");
  const categories = (await invoke("list_categories", { includeArchived: false })).filter(c => c.kind === "expense" && !c.parentId);
  const date = await browser.execute(() => {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  });
  await invoke("create_receipt", { input: { date, accountId, payee: "Учебный чек", note: null, total: 8789400,
    parts: [{ categoryId: categories[0].id, amount: 2317300 }, { categoryId: categories[1].id, amount: 6472100 }] } });
  await invoke("create_template", { input: { name: "Учебный шаблон", type: "expense", accountId, amount: 5731900,
    categoryId: categories[0].id, toAccountId: null, payee: "Учебный магазин", note: null } });
  await browser.refresh();
  await openSection(browser, "Операции");
});

after(async () => { await stop(browser); });

async function waitAmount(name, value) {
  const field = await amountField(name);
  await field.waitForExist();
  await browser.waitUntil(async () => await field.getValue() === value, { timeoutMsg: `Значение ${name} не обновилось` });
}

async function setPrivate(hidden) {
  const toggle = await browser.$('[data-testid="hide-amounts"]');
  if (await toggle.getAttribute("aria-checked") !== String(hidden)) await browser.keys(["Control", "h"]);
  await browser.waitUntil(async () => await toggle.getAttribute("aria-checked") === String(hidden));
}

// Проверяем каждую доставленную DOM-мутацию после открытия, включая приход строк чека.
// Все сравниваемые числа относятся только к этому учебному бюджету.
async function watchPrivateForm() {
  await browser.execute(() => {
    const amounts = ["87894", "23173", "64721", "57319"];
    window.privacyFormLeak = false;
    window.privacyFormWatch = new MutationObserver(() => {
      for (const box of document.querySelectorAll('[role="dialog"]')) {
        const content = [box.textContent];
        for (const e of box.querySelectorAll("input, textarea, [title], [aria-label], [aria-valuetext], [value]")) {
          content.push(e.value ?? "", e.getAttribute("title") ?? "", e.getAttribute("aria-label") ?? "",
            e.getAttribute("aria-valuetext") ?? "", e.getAttribute("value") ?? "");
        }
        window.privacyFormLeak ||= content.some(s => amounts.some(n => s.replace(/[\s\u00a0\u202f]/gu, "").includes(n)));
      }
    });
    window.privacyFormWatch.observe(document.body, { subtree: true, attributes: true, characterData: true, childList: true });
  });
}

async function assertNoLeak() {
  const seen = await browser.execute(() => {
    window.privacyFormWatch.disconnect();
    return window.privacyFormLeak;
  });
  assert.equal(seen, false, "В защищённом редакторе обнаружена сумма учебного бюджета");
}

test("скрытый чек открывается с масками, раскрытие и повторное скрытие сохраняют черновик", async () => {
  await setPrivate(true);
  await watchPrivateForm();
  await browser.$('//tr[@data-testid="txn-row" and contains(., "Учебный чек")]/td[contains(@class,"date")]').click();
  for (const field of ["amount", "partAmount0", "partAmount1"]) {
    await waitAmount(field, "•••");
    assert.equal(await (await amountField(field)).getProperty("readOnly"), true);
  }
  await assertNoLeak();
  await reveal();
  await waitAmount("amount", "87894");
  await fill(browser, "amount", "87895");
  await reveal();
  await waitAmount("amount", "•••");
  assert.doesNotMatch(await browser.$('[data-testid="receipt-left"]').getText(), /\d/);
  await reveal();
  await waitAmount("amount", "87895");
  // Оба события доставлены до ответа SQLite. Последняя команда снова скрывает
  // суммы, в том числе ранее раскрытый локально несохранённый черновик.
  await browser.execute(() => {
    for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "h", code: "KeyH", ctrlKey: true, bubbles: true, cancelable: true,
    }));
  });
  await waitAmount("amount", "•••");
  await browser.waitUntil(() => browser.execute(() => !localStorage.getItem("kazna-amounts-pending")));
  await waitAmount("amount", "•••");
  await reveal();
  await waitAmount("amount", "87895");
  await close();
});

test("смена шаблона закрывает локальное раскрытие, Ctrl+H при вводе защищает и сохраняет выражение", async () => {
  await setPrivate(true);
  await click(browser, "+ Операция");
  await waitAmount("amount", "•••");
  await reveal();
  await watchPrivateForm();
  await browser.$('[role="dialog"] [data-name="Учебный шаблон"] button').click();
  await waitAmount("amount", "•••");
  await assertNoLeak();
  await reveal();
  await waitAmount("amount", "57319");
  await setPrivate(false);
  await fill(browser, "amount", "31001+208");
  await browser.$('[data-testid="amount-calc"]').waitForDisplayed();
  await setPrivate(true);
  await waitAmount("amount", "•••");
  assert.equal(await browser.$('[data-testid="amount-calc"]').isExisting(), false);
  await reveal();
  await waitAmount("amount", "31001+208");
  await close();
});

test("у возврата остаток скрыт и выбор другой части чека снимает локальное раскрытие", async () => {
  await setPrivate(true);
  await watchPrivateForm();
  await browser.$('//tr[@data-testid="txn-row" and contains(., "Учебный чек")]/td[contains(@class,"date")]').click();
  await browser.$('[data-testid="txn-refund"]').click();
  const parts = await browser.$('select[name="refundPart"]');
  await browser.waitUntil(async () => (await parts.$$("option")).length === 3);
  await parts.selectByIndex(1);
  await waitAmount("amount", "•••");
  await assertNoLeak();
  await reveal();
  assert.ok(["23173", "64721"].includes(await (await amountField("amount")).getValue()));
  await parts.selectByIndex(2);
  await waitAmount("amount", "•••");
  await close();
});

test("возврат ждёт ответа в своей форме: Ctrl+N и удаление не прерывают запись", async () => {
  await setPrivate(false);
  const seed = (await invoke("list_transactions", { filter: { search: "Учебный чек", limit: 1 } })).items[0];
  const { date, accountId, categoryId } = seed;
  const payee = "Контроль возврата в одном окне";
  const balance = async () => (await invoke("totals", { date })).total;
  const initial = await balance();
  const purchase = await invoke("create_transaction", { eventId: null, input: {
    type: "expense", date, accountId, categoryId, amount: 100000, payee, note: null,
  } });
  const refund = await invoke("create_refund", { input: {
    of: purchase, date, accountId, amount: 20000, inPurchaseMonth: true, note: null,
  } });
  assert.equal(await balance(), initial - 80000);
  await openSection(browser, "Операции");
  await click(browser, "Показать все операции");
  await fill(browser, "search", payee);
  const tag = await browser.$('[data-testid="txn-refund-tag"]');
  await tag.waitForDisplayed();
  await tag.click();
  await waitText(browser, '[data-testid="refund-purchase"]', /Контроль возврата в одном окне/);
  await fill(browser, "amount", "350");

  try {
    await holdCommands(browser, ["update_refund", "delete_transaction", "create_refund"]);
    await browser.execute(() => {
      const form = document.querySelector('[data-testid="refund-form"]');
      form.querySelector('[type="submit"]').click();
      form.querySelector("button.danger").click();
      form.requestSubmit();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await waitText(browser, '[data-testid="refund-form"] [role="status"]', /Сохраняем возврат/);
    const context = await browser.execute(() => {
      const form = document.querySelector('[data-testid="refund-form"]');
      return { dialogs: document.querySelectorAll('[role="dialog"]').length, ownsFocus: form.closest('[role="dialog"]').contains(document.activeElement),
        attempted: window.heldCommands.calls, inputLocked: form.querySelector('[name="amount"]').matches(":disabled"),
        deletionLocked: form.querySelector("button.danger").matches(":disabled") };
    });
    assert.deepEqual(context, { dialogs: 1, ownsFocus: true, attempted: ["update_refund"], inputLocked: true, deletionLocked: true });
    assert.equal((await invoke("get_transaction", { id: refund })).amount, 20000);
    assert.equal(await balance(), initial - 80000);
    await browser.execute(() => window.heldCommands.release());
    await browser.$('[role="dialog"]').waitForExist({ reverse: true, timeout: 5000 });
    const rows = await invoke("list_transactions", { filter: { payee, limit: 10 } });
    assert.equal(rows.total, 2);
    assert.deepEqual(rows.items.filter(r => r.refund).map(r => [r.id, r.refundOf, r.amount]), [[refund, purchase, 35000]]);
    const info = await invoke("refund_info", { of: purchase, except: null });
    assert.equal(info.left, 65000);
    assert.equal(await balance(), initial - 65000);
    assert.deepEqual(await browser.execute(() => window.heldCommands.calls), ["update_refund"]);
  } finally {
    await browser.execute(() => { window.heldCommands?.restore(); });
  }
});
