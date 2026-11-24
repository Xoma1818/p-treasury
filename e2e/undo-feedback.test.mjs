import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, test } from "node:test";
import { choose, click, fill, minimizeTestWindow, onboard, openSection, openSettings, resizeAppWindow, save, start, stop, waitText, WIN } from "./app.mjs";
import { holdCommands } from "./hold-commands.mjs";

const bar = '[data-testid="undo-bar"]';
const action = name => `//*[@data-testid="undo-bar"]//button[normalize-space()="${name}"]`;
let browser, dataDir;

before(async () => {
  ({ browser, dataDir } = await start());
  const { dbPath } = await invoke("app_info");
  assert.equal(relative(join(dataDir, "budget.db"), dbPath), "", "окно работает с отдельной учебной базой");
  await onboard(browser, [{ name: "Учебная карта", balance: "10000" }]);
});
after(async () => { await stop(browser); });
beforeEach(async () => {
  const close = await browser.$(bar + ' button[aria-label="Закрыть"]');
  if (await close.isDisplayed()) await close.click();
});

async function invoke(cmd, args = {}) {
  const result = await browser.executeAsync((cmd, args, done) => {
    window.__TAURI_INTERNALS__.invoke(cmd, args).then(value => done({ value }), e => done({ error: String(e) }));
  }, cmd, args);
  assert.equal(result.error, undefined, cmd + ": " + result.error);
  return result.value;
}

async function expense(rubles, payee) {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", String(rubles));
  await choose(browser, "category", "Питание");
  await fill(browser, "payee", payee);
  await save(browser);
  await browser.$(action("Отменить")).waitForDisplayed();
}

// Проверяем сохранённый журнал и остаток независимо от текста уведомления.
async function ledger() {
  const account = (await invoke("list_accounts", { includeArchived: false })).find(a => a.name === "Учебная карта");
  const ledger = await invoke("list_transactions", { filter: { limit: 100 } });
  return {
    balance: account.balance,
    count: ledger.total,
    expense: ledger.items.filter(row => row.type === "expense").reduce((sum, row) => sum + row.amount, 0),
  };
}

async function repeatKey(code) {
  await browser.execute(code => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, ctrlKey: true, repeat: true, bubbles: true, cancelable: true }));
  }, code);
}

async function clickWithShortcut(name, code) {
  const button = await browser.$(action(name));
  await browser.execute((b, code) => {
    b.focus();
    b.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { code, ctrlKey: true, bubbles: true, cancelable: true }));
  }, button, code);
}

test("два расхода: нажатие с Ctrl+Z и удержание клавиш отменяют и возвращают ровно одну запись", async () => {
  await expense(120, "Первая покупка");
  const first = await ledger();
  await expense(340, "Вторая покупка");
  const both = await ledger();
  assert.deepEqual(both, { balance: first.balance - 34000, count: first.count + 1, expense: first.expense + 34000 });
  for (const [cmd, name, code, text, before, after] of [
    ["undo", "Отменить", "KeyZ", /Отменено/, both, first],
    ["redo", "Повторить", "KeyY", /Повторено/, first, both],
  ]) {
    await holdCommands(browser, ["undo", "redo"]);
    try {
      await clickWithShortcut(name, code);
      await browser.waitUntil(async () => (await browser.execute(() => window.heldCommands.calls.length)) > 0);
      assert.deepEqual(await ledger(), before, "до ответа деньги и журнал сохраняются");
      await browser.execute(() => window.heldCommands.release());
      await waitText(browser, bar, text);
      if (cmd === "undo") {
        const redo = await browser.$(action("Повторить"));
        await browser.waitUntil(async () => await redo.getAttribute("aria-disabled") !== "true");
        const prevented = await browser.execute(b => {
          const held = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", repeat: true, bubbles: true, cancelable: true });
          b.dispatchEvent(held);
          // У синтетического keydown нет встроенной активации кнопки.
          if (!held.defaultPrevented) b.click();
          b.dispatchEvent(new MouseEvent("click", { detail: 2, bubbles: true, cancelable: true }));
          return held.defaultPrevented;
        }, redo);
        assert.equal(prevented, true, "удержание Enter не подтверждает появившийся повтор");
      }
      await repeatKey("KeyZ");
      await repeatKey("KeyY");
      assert.deepEqual(await browser.execute(() => window.heldCommands.calls), [cmd]);
      assert.deepEqual(await ledger(), after);
    } finally { await browser.execute(() => window.heldCommands.restore()); }
  }
});

test("кнопка отмены доступна через десять секунд фокуса, закрытие возвращает фокус к источнику", async () => {
  await expense(33, "Проверка времени");
  const before = await ledger();
  const undo = await browser.$(action("Отменить"));
  const source = await browser.$('button[data-section="accounts"]');
  await source.waitForExist();
  await browser.execute((opener, button) => { opener.focus(); button.focus(); }, source, undo);
  assert.ok(await undo.isFocused());
  await browser.pause(10050);
  assert.ok(await undo.isFocused());
  const close = await browser.$(bar + ' button[aria-label="Закрыть"]');
  await browser.execute(b => b.focus(), close);
  await browser.keys("Enter");
  await browser.$(bar).waitForExist({ reverse: true });
  assert.ok(await source.isFocused());
  assert.deepEqual(await ledger(), before);
});

test("наведение останавливает таймер, после ухода обычная плашка исчезает и Ctrl+Z сохраняет смысл", async () => {
  const before = await ledger();
  await expense(36, "Время наведённой плашки");
  const undo = await browser.$(action("Отменить"));
  await undo.moveTo();
  await browser.waitUntil(() => browser.execute(() => document.hasFocus() && !document.hidden));
  await browser.pause(8200);
  assert.ok(await undo.isDisplayed());
  await browser.$("main h1").moveTo();
  await browser.$(bar).waitForExist({ reverse: true, timeout: 11000 });
  await browser.keys(["Control", "z"]);
  await waitText(browser, bar, /Отменено/);
  assert.deepEqual(await ledger(), before);
});

test("занятая учебная база: ошибка остаётся, после снятия блокировки можно повторить ту же отмену", async () => {
  const before = await ledger();
  await expense(47, "Проверка отказа");
  const afterPurchase = await ledger();
  const lock = new DatabaseSync(join(dataDir, "budget.db"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    await browser.$(action("Отменить")).click();
    await browser.$(action("Попробовать снова")).waitForDisplayed({ timeout: 15000 });
  } finally { lock.close(); }
  await browser.execute(() => {
    document.activeElement?.blur();
    document.querySelector("h1")?.scrollIntoView({ block: "nearest" });
  });
  await browser.$("h1").moveTo();
  await browser.pause(8200);
  const retry = await browser.$(action("Попробовать снова"));
  assert.ok(await retry.isDisplayed());
  assert.deepEqual(await ledger(), afterPurchase);
  await retry.click();
  await waitText(browser, bar, /Отменено/);
  assert.deepEqual(await ledger(), before);
});

test("свёрнутое окно Windows сохраняет действие до возврата", { skip: !WIN }, async () => {
  const before = await ledger();
  await expense(52, "Покупка перед сворачиванием");
  await browser.$("main h1").moveTo();
  minimizeTestWindow(browser, true);
  try {
    // Отсчитывается вне WebView2: в свёрнутом окне JS-таймеры могут быть замедлены.
    await new Promise(resolve => setTimeout(resolve, 10050));
  } finally { minimizeTestWindow(browser, false); }
  await browser.$(action("Отменить")).click();
  await waitText(browser, bar, /Отменено/);
  assert.deepEqual(await ledger(), before);
});

test("другая покупка появилась во время отмены: ядро оставляет обе записи и предлагает сверить историю", async () => {
  await expense(58, "Покупка перед отменой");
  const before = await ledger();
  const { items: [row] } = await invoke("list_transactions", { filter: { search: "Покупка перед отменой" } });
  await holdCommands(browser, ["undo"]);
  try {
    await browser.$(action("Отменить")).click();
    await browser.waitUntil(async () => (await browser.execute(() => window.heldCommands.calls.length)) === 1);
    await invoke("create_transaction", { eventId: null, input: {
      type: "expense", date: row.date, accountId: row.accountId, categoryId: row.categoryId,
      amount: 6100, payee: "Встречная покупка", note: null,
    } });
    await browser.execute(() => window.heldCommands.release());
    await waitText(browser, bar, /История действий изменилась/);
    assert.deepEqual(await ledger(), { balance: before.balance - 6100, count: before.count + 1, expense: before.expense + 6100 });
    assert.equal(await browser.$(action("Попробовать снова")).isExisting(), false);
  } finally { await browser.execute(() => window.heldCommands.restore()); }
});

test("восстановление копии в тот же файл обрывает старую отмену и сохраняет новые покупки", async () => {
  const before = await ledger();
  const backup = join(dataDir, "undo-before-restore.db");
  await invoke("backup_now", { path: backup });
  await expense(73, "Покупка перед восстановлением");
  await holdCommands(browser, ["undo"]);
  try {
    await browser.$(action("Отменить")).click();
    await browser.waitUntil(async () => (await browser.execute(() => window.heldCommands.calls.length)) === 1);
    await openSettings(browser, "data");
    // В системном выборе подставляется только путь к нашей учебной копии.
    await browser.execute(path => { window.__ptPick = [path]; }, backup);
    await click(browser, "Восстановить из копии");
    await waitText(browser, '[role="dialog"]', /В копии: счетов/);
    await click(browser, "Восстановить", '//*[@role="dialog"]');
    await waitText(browser, '[data-testid="backup-msg"]', /Данные восстановлены из копии/);
    assert.equal(await browser.$(bar).isExisting(), false);
    assert.deepEqual(await ledger(), before);
    await expense(89, "Покупка после восстановления");
    await browser.execute(() => window.heldCommands.release());
    assert.deepEqual(await ledger(), { balance: before.balance - 8900, count: before.count + 1, expense: before.expense + 8900 });
    await browser.$(action("Отменить")).click();
    await waitText(browser, bar, /Отменено/);
    assert.deepEqual(await ledger(), before);
  } finally { await browser.execute(() => window.heldCommands.restore()); }
});

test("отмена и массовые действия журнала доступны одновременно при обычном и двойном масштабе", async t => {
  const { today } = await invoke("app_info");
  const [account] = await invoke("list_accounts", { includeArchived: false });
  const category = (await invoke("list_categories", { includeArchived: false })).find(c => c.kind === "expense" && !c.parentId);
  for (let i = 0; i < 105; i++) {
    await invoke("create_transaction", { eventId: null, input: {
      type: "expense", date: today, accountId: account.id, categoryId: category.id,
      amount: 100 + i, payee: "Для выделения " + i, note: null,
    } });
  }
  await browser.refresh();
  await openSection(browser, "Операции");
  const toolbar = '[data-testid="sel-bar"]';
  const expected = await ledger();
  const setZoom = value => invoke("plugin:webview|set_webview_zoom", { label: "main", value });
  for (const [width, height] of [[1280, 800], [1024, 640]]) {
    await setZoom(1);
    await resizeAppWindow(browser, width, height);
    const normalWidth = await browser.execute(() => innerWidth);
    for (const scale of [1, 2]) {
      await setZoom(scale);
      await browser.waitUntil(() => browser.execute(w => Math.abs(innerWidth - w) < 8, normalWidth / scale));
      await browser.execute(() => document.querySelector("nav button").focus({ preventScroll: true }));
      await browser.keys(["Control", "z"]);
      await waitText(browser, bar, /Отменено/);
      await browser.keys(["Control", "y"]);
      await waitText(browser, bar, /Повторено/);
      // Пользователь выделяет первую строку длинного журнала. Теперь прокрутка к
      // самому уведомлению скрыла бы дефект — оно должно быть доступно отсюда.
      const first = await browser.$('[data-testid="txn-select"]');
      await browser.execute(el => { el.scrollIntoView({ block: "center" }); el.focus({ preventScroll: true }); }, first);
      await browser.keys(" ");
      await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="sel-sum"]')?.textContent.includes("Выбрано 1")));
      assert.ok(await first.isFocused(), "появление нижней панели оставляет фокус в выбранной строке");
      const measure = () => browser.execute(() => {
        const group = document.querySelector('[data-testid="sel-bar"]');
        const notice = document.querySelector('[data-testid="undo-bar"]');
        const a = group.getBoundingClientRect(), b = notice.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const blocked = el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        };
        const visibleActions = [...group.querySelectorAll("button")].filter(el => {
          const r = el.getBoundingClientRect(), y = r.y + r.height / 2;
          return y >= a.top && y <= a.bottom;
        });
        const covered = [...visibleActions, ...notice.querySelectorAll("button")].filter(blocked)
          .map(el => el.textContent.trim() || el.getAttribute("aria-label"));
        const readable = [...document.querySelectorAll('[data-testid="txn-row"]')].some(el => {
          const r = el.getBoundingClientRect(), y = r.y + r.height / 2;
          return y >= 0 && y < a.top && el.contains(document.elementFromPoint(Math.max(1, r.x + 8), y));
        });
        const rect = r => [r.x, r.y, r.width, r.height].map(Math.round);
        return { overlap, covered, readable, panel: rect(a), notice: rect(b), viewport: [innerWidth, innerHeight] };
      });
      let actual;
      await browser.waitUntil(async () => {
        actual = await measure();
        return actual.overlap < 1 && actual.covered.length === 0 && actual.readable;
      }, { timeout: 3000 }).catch(error => {
        throw new Error(`${width}×${height}, ${scale * 100}%: ${JSON.stringify(actual)}`, { cause: error });
      });
      t.diagnostic(`${width}×${height}, ${scale * 100}%: ${JSON.stringify(actual)}`);
      // Обычные клики WebDriver. Общий помощник умеет закрывать мешающую плашку.
      const clickAction = async name => {
        const el = await browser.$(toolbar).$(`button=${name}`);
        await browser.execute(button => button.scrollIntoView({ block: "nearest", inline: "nearest" }), el);
        await el.click();
      };
      await clickAction("Категория");
      await browser.$(`${toolbar} [name="bulkCategory"]`).waitForDisplayed();
      await clickAction("Отмена");
      await clickAction("Удалить");
      await browser.$('[data-testid="bulk-delete-confirm"]').waitForDisplayed();
      await clickAction("Отмена");
      assert.ok(await browser.$(bar).isExisting());
      await clickAction("Снять выделение");
      assert.deepEqual(await ledger(), expected);
    }
  }
  // Пользователь уже перешёл к поиску, когда пришёл ответ предыдущей отмены.
  await holdCommands(browser, ["undo"]);
  try {
    await browser.execute(() => document.querySelector("nav button").focus({ preventScroll: true }));
    await browser.keys(["Control", "z"]);
    await browser.waitUntil(async () => (await browser.execute(() => window.heldCommands.calls.length)) === 1);
    const search = await browser.$('input[name="search"]');
    await browser.execute(el => el.focus({ preventScroll: true }), search);
    await browser.execute(() => window.heldCommands.release());
    await waitText(browser, bar, /Отменено/);
    assert.ok(await search.isFocused(), "новый статус не забирает фокус из поиска");
    await browser.execute(el => el.blur(), search);
    await browser.keys(["Control", "y"]);
    await waitText(browser, bar, /Повторено/);
    assert.deepEqual(await ledger(), expected);
  } finally { await browser.execute(() => window.heldCommands.restore()); }
});
