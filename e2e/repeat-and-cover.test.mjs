import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Key } from "webdriverio";
import { choose, click, money, openSection, setDate, start, stop, waitText } from "./app.mjs";

const dialog = '(//*[@role="dialog"])[last()]';
const byTest = name => `[data-testid="${name}"]`;

async function capture(browser, name) {
  if (process.env.KAZNA_QA_SCREENSHOTS) {
    await browser.executeAsync(done => {
      const entering = document.getAnimations().filter(animation =>
        animation.playState === "running" && animation.effect?.getComputedTiming().endTime <= 1500);
      Promise.allSettled(entering.map(animation => animation.finished))
        .then(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true))));
    });
    await browser.saveScreenshot(join(process.env.KAZNA_QA_SCREENSHOTS, name + ".png"));
  }
}

function shiftDay(date, days) {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nextMonthlyDate(due, dayOfMonth) {
  const [year, month, day] = due.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(dayOfMonth ?? day, lastDay))).toISOString().slice(0, 10);
}

async function testBudget(t, openings) {
  const dir = await mkdtemp(join(tmpdir(), "kazna-repeat-cover-"));
  const { browser } = await start(dir, { homeDefaults: true, env: {
    XDG_DATA_HOME: join(dir, "xdg-data"), WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
  } });
  t.after(() => stop(browser));
  const invoke = async (command, args = {}) => {
    const result = await browser.executeAsync((cmd, input, done) => {
      window.__TAURI_INTERNALS__.invoke(cmd, input).then(value => done({ value }), error => done({ error: String(error) }));
    }, command, args);
    assert.equal(result.error, undefined, `${command}: ${result.error}`);
    return result.value;
  };
  await browser.$('[name="baseCurrency"]').waitForDisplayed({ timeout: 15000 });
  const { today } = await invoke("app_info");
  const accounts = openings.map(([name, openingBalance]) => ({
    name, type: "debit", openingBalance, openingDate: shiftDay(today, -60),
    currencyCode: "RUB", includeInTotal: true, creditLimit: null,
  }));
  await invoke("finish_onboarding", { setup: { baseCurrency: "RUB", defaultCategories: true, accounts } });
  await invoke("set_setting", { key: "home_layout", value: JSON.stringify({ order: [], hidden: [] }) });
  const accountIds = Object.fromEntries((await invoke("list_accounts", { includeArchived: false })).map(a => [a.name, a.id]));
  const categories = await invoke("list_categories", { includeArchived: false });
  const categoryId = name => categories.find(c => c.name === name).id;
  const record = (type, account, category, amount, payee, date = today) => invoke("create_transaction", {
    eventId: null, input: { type, accountId: accountIds[account], categoryId: categoryId(category), amount, date, payee },
  });
  async function ledger() {
    const accounts = await invoke("list_accounts", { includeArchived: false });
    const page = await invoke("list_transactions", { filter: {} });
    assert.equal(page.total, page.items.length);
    return { balances: Object.fromEntries(accounts.map(a => [a.name, a.balance])), ids: page.items.map(t => t.id).sort() };
  }
  async function refresh() {
    await browser.refresh();
    await waitText(browser, "main h1", /Главная/);
  }
  return { browser, dir, invoke, today, accountIds, categoryId, record, ledger, refresh };
}

async function openSource(browser, payee) {
  await openSection(browser, "Операции");
  await click(browser, "Всё время");
  await browser.$(`//*[@data-testid="txn-row" and contains(., "${payee}")]//td[@class="date"]`).click();
  await browser.$(byTest("txn-plan-repeat")).waitForDisplayed();
  await browser.$(byTest("txn-plan-repeat")).click();
}

async function openReminders(browser) {
  await openSection(browser, "Календарь");
  await click(browser, "Напоминания");
  await browser.$(byTest("rem-all")).waitForDisplayed();
}

test("Повтор аренды: выписка и план связываются с одним проведённым платежом", async t => {
  const w = await testBudget(t, [["Карта", 4_000_000]]);
  const { browser, invoke, today } = w;
  const title = "Аренда";
  const source = await w.record("expense", "Карта", title, 1_000_000, title, shiftDay(today, -28));
  const due = shiftDay(today, 1);
  const before = { balances: { Карта: 3_000_000 }, ids: [source] };
  assert.deepEqual(await w.ledger(), before);
  await w.refresh();
  await openSource(browser, title);
  await waitText(browser, byTest("repeat-plan-source"), money("10 000 ₽"));
  assert.equal(await browser.$('[name="reminderTitle"]').getValue(), title);
  assert.equal(await browser.$('[name="repeat"]').getValue(), "monthly");
  await setDate(browser, "reminderDate", due);
  await capture(browser, "01-plan-repeat");
  await browser.$(byTest("repeat-plan-save")).click();
  await browser.$(byTest("repeat-plan-form")).waitForExist({ reverse: true });
  assert.deepEqual(await w.ledger(), before);
  // После смены валюты отчётов исходный платёж и серия по-прежнему рублёвые.
  await invoke("set_rate", { date: shiftDay(today, -60), from: "USD", to: "RUB", rate: "90" });
  await openSection(browser, "Настройки");
  const baseCurrency = browser.$('[name="baseCurrency"]');
  await baseCurrency.waitForDisplayed();
  await baseCurrency.selectByAttribute("value", "USD");
  await browser.waitUntil(async () => (await invoke("get_settings")).base_currency === "USD");
  await w.refresh();
  await openSource(browser, title);
  await waitText(browser, dialog + "//h2", /^Напоминание$/);
  assert.equal(await browser.$('[name="reminderDate"]').getValue(), due);
  const amountInput = browser.$('[name="reminderAmount"]');
  assert.equal(Number((await amountInput.getValue()).replace(/\s/g, "").replace(",", ".")), 10_000);
  assert.match(await browser.execute(el => el.labels[0].textContent, await amountInput), /₽/);
  await click(browser, "Отмена", dialog);
  const overview = await invoke("reminders_overview");
  assert.equal(overview.reminders.length, 1);
  const [series] = overview.reminders;
  assert.equal(series.amount, 1_000_000);
  assert.equal(series.amountCurrency, "RUB");
  assert.equal(series.txnType, "expense");
  assert.equal(series.accountId, w.accountIds.Карта);
  assert.equal(series.categoryId, w.categoryId(title));
  assert.deepEqual(await w.ledger(), before);

  // Банк провёл платёж накануне срока. Путь тестового файла передаётся вместо системного выбора,
  // экран проверки, распознавание формата и сохранение используют штатный импорт Казны.
  const path = join(w.dir, "аренда.csv");
  const date = today.split("-").reverse().join(".");
  await writeFile(path, [
    '"Дата операции";"Номер карты";"Статус";"Сумма операции";"Валюта операции";"Сумма платежа";"Валюта платежа";"Категория";"Описание"',
    `"${date} 10:00:00";"*1140";"OK";"-10000,00";"RUB";"-10000,00";"RUB";"Жильё";"${title}"`, "",
  ].join("\n"));
  await openSection(browser, "Настройки");
  await click(browser, "Импорт выписки или CSV");
  await browser.execute(p => { window.__ptPick = [p]; }, path);
  await click(browser, "Выбрать файл", dialog);
  await choose(browser, "importAccount", "Карта (₽)");
  await waitText(browser, byTest("import-summary"), /строк 1, без ошибок 1/);
  await click(browser, "Загрузить 1", dialog);
  await waitText(browser, byTest("import-done"), /Загружено операций: 1/);
  const after = await w.ledger();
  assert.deepEqual(after.balances, { Карта: 2_000_000 });
  assert.equal(after.ids.length, 2);
  assert.ok(after.ids.includes(source));
  const imported = after.ids.find(id => id !== source);
  await click(browser, "Проверить снова", dialog);
  await waitText(browser, byTest("import-summary"), /уже загружено раньше 1/);
  await browser.keys("Escape");

  await openReminders(browser);
  const occurrence = `//*[@data-testid="rem-upcoming"]//*[@data-title="${title}"]`;
  await waitText(browser, occurrence, money("10 000 ₽"));
  await click(browser, "Учесть платёж", occurrence);
  await waitText(browser, byTest("occ-match-candidate"), money("10 000 ₽"));
  assert.equal((await browser.$$(byTest("occ-match-candidate"))).length, 1);
  assert.doesNotMatch(await browser.$(byTest("occ-match-candidate")).getText(), /Сумма отличается/);
  async function checkDates(container) {
    const row = browser.$(container);
    await row.waitForDisplayed();
    const dates = row.$(byTest("payment-dates"));
    assert.ok(await dates.isExisting(), "в карточке нужны подписи плановой и фактической дат");
    await dates.waitForDisplayed();
    assert.match(await dates.getText(), /По плану.+списано/is);
    const values = await dates.$$("time").map(time => time.getAttribute("datetime"));
    assert.deepEqual(values, [due, today], "срок платежа и фактическое списание показаны в одном блоке");
  }
  await checkDates(byTest("occ-match-candidate"));
  await capture(browser, "04-rent-match-dates");
  await click(browser, "Связать с платежом", dialog);
  const paidRow = `//*[@data-testid="rem-done"]//*[@data-title="${title}"]`;
  const seriesRow = `//*[@data-testid="rem-all"]//*[@data-testid="reminder-row"][.//span[@class="main" and text()="${title}"]]`;
  const nextDate = nextMonthlyDate(due, series.dayOfMonth).split("-").reverse().join(".");
  for (let visit = 0; visit < 2; visit++) {
    if (visit) {
      await w.refresh();
      await openReminders(browser);
    }
    await waitText(browser, paidRow, /связано с операцией/);
    await checkDates(paidRow);
    const next = await waitText(browser, seriesRow, /следующее/);
    if (!visit) {
      await browser.$(seriesRow).scrollIntoView({ block: "nearest", inline: "nearest" });
      await capture(browser, "03-rent-next-payment");
    }
    assert.ok(next.includes(`следующее ${nextDate}`), `Ожидался следующий платёж ${nextDate}. В списке: ${next}`);
    await browser.$(paidRow + '//*[@data-testid="occ-open-transaction"]').click();
    const linked = browser.$(byTest("linked-transaction"));
    await linked.waitForDisplayed();
    assert.equal(await linked.getAttribute("data-transaction-id"), imported);
    await waitText(browser, byTest("linked-transaction"), money("10 000 ₽"));
    await click(browser, "Закрыть", dialog);
    const { done, reminders } = await invoke("reminders_overview");
    assert.equal(reminders.length, 1);
    assert.equal(done.filter(o => o.key.refId === series.id && o.transactionId === imported && o.linkedActual).length, 1);
    assert.deepEqual(await w.ledger(), after);
  }
  await click(browser, "Месяц");
  if (due.slice(0, 7) !== today.slice(0, 7)) await browser.$('[aria-label="Следующий месяц"]').click();
  const day = browser.$(`[data-testid="cal-day"][data-date="${due}"]`);
  await day.scrollIntoView({ block: "center" });
  await day.click();
  await checkDates(`//*[@data-testid="day-panel"]//*[@data-title="${title}"]`);
  // И из уже сопоставленного платежа открывается существующая серия.
  await openSection(browser, "Операции");
  await click(browser, "Всё время");
  await browser.$(`//*[@data-testid="txn-row"]//td[@class="date" and normalize-space()="${date}"]`).click();
  await waitText(browser, byTest("txn-plan-repeat"), /Открыть запланированный повтор/);
  await browser.$(byTest("txn-plan-repeat")).click();
  await waitText(browser, dialog + "//h2", /^Напоминание$/);
  assert.equal(await browser.$('[name="reminderDate"]').getValue(), due);
  assert.equal((await invoke("reminders_overview")).reminders.length, 1);
  assert.deepEqual(await w.ledger(), after);
  t.diagnostic(`Первый платёж ${source}; импорт и ссылка ${imported}; после выбора USD (90 ₽) сумма серии 10 000 ₽, остаток 40 000 → 30 000 → 20 000 ₽. Операций 2.`);
});

test("Повтор дохода берёт счёт, категорию и сумму из поступления", async t => {
  const w = await testBudget(t, [["Зарплатная", 0]]);
  const { browser, invoke } = w;
  const source = await w.record("income", "Зарплатная", "Заработная плата", 5_000_000, "Работодатель");
  const unchanged = { ids: [source], balances: { Зарплатная: 5_000_000 } };
  await w.refresh();
  await openSection(browser, "Операции");
  const rowDate = browser.$('//*[@data-testid="txn-row" and contains(., "Работодатель")]//td[@class="date"]');
  const menu = browser.$(byTest("context-menu"));
  const checkbox = browser.$(byTest("txn-row") + " " + byTest("txn-select"));
  await checkbox.click({ button: "right" });
  await menu.waitForDisplayed();
  assert.equal(await checkbox.isSelected(), false, "правый щелчок по флажку не выделяет операцию");
  await browser.keys("Escape");
  await menu.waitForExist({ reverse: true });
  await rowDate.click({ button: "right" });
  await menu.waitForDisplayed();
  assert.equal((await browser.$$('[role="dialog"]')).length, 0, "правый щелчок открывает только меню");
  await browser.keys("Escape");
  await menu.waitForExist({ reverse: true });
  await rowDate.click();
  await browser.$('[role="dialog"][aria-label="Операция"][data-side="true"]').waitForDisplayed();
  await browser.keys("Escape");
  await browser.$('[role="dialog"]').waitForExist({ reverse: true });
  await rowDate.click({ button: "right" });
  await menu.waitForDisplayed();
  await click(browser, "Запланировать повтор…", '//*[@data-testid="context-menu"]');
  await waitText(browser, byTest("repeat-plan-source"), /Доход/);
  assert.equal((await browser.$$('[role="dialog"]')).length, 1, "форму повтора не перекрывает карточка операции");
  await waitText(browser, byTest("repeat-plan-source"), money("50 000 ₽"));
  const repeat = browser.$('[data-testid="repeat-plan-form"] select[name="repeat"]');
  await repeat.scrollIntoView({ block: "center" });
  await repeat.waitForClickable();
  assert.equal(await repeat.getValue(), "monthly");
  // В закрытом списке «Еженедельно» находится перед «Ежемесячно».
  await repeat.addValue(Key.ArrowUp);
  assert.equal(await repeat.getValue(), "weekly");
  const due = shiftDay(w.today, 7);
  assert.equal(await browser.$('[name="reminderDate"]').getValue(), due);
  await browser.$(byTest("repeat-plan-save")).click();
  await browser.$(byTest("repeat-plan-form")).waitForExist({ reverse: true });
  const { reminders, upcoming } = await invoke("reminders_overview");
  assert.equal(reminders.length, 1);
  const [r] = reminders;
  assert.deepEqual([r.txnType, r.amount, r.accountId, r.categoryId, r.repeat], [
    "income", 5_000_000, w.accountIds.Зарплатная, w.categoryId("Заработная плата"), "weekly",
  ]);
  assert.ok(upcoming.some(o => o.key.refId === r.id && o.payAt.startsWith(due)));
  assert.deepEqual(await w.ledger(), unchanged);
});

test("Перенос 400 ₽: фиксированный общий план, факты и остатки обоих счетов сохраняются", async t => {
  const w = await testBudget(t, [["Карта", 2_600_000], ["Наличные", 600_000]]);
  const { browser, invoke } = w;
  const month = (await invoke("month_of", { date: w.today })).month;
  const existing = await invoke("get_budget", { month });
  const budgetId = existing.id ?? await invoke("create_budget", { month, copyPrevious: false });
  const food = w.categoryId("Питание"), leisure = w.categoryId("Досуг");
  for (const [categoryId, limit] of [[food, 300_000], [leisure, 200_000]]) {
    await invoke("set_budget_limit", { budgetId, categoryId, limit });
  }
  const ids = [
    await w.record("expense", "Карта", "Питание", 340_000, "Продукты"),
    await w.record("expense", "Наличные", "Досуг", 100_000, "Музей"),
  ].sort();
  const unchanged = { ids, balances: { Карта: 2_260_000, Наличные: 500_000 } };
  async function check(foodLimit, leisureLimit) {
    const b = await invoke("get_budget", { month });
    assert.deepEqual([b.plannedExpense, b.actualExpense], [500_000, 440_000]);
    for (const [id, planned, actual] of [[food, foodLimit, 340_000], [leisure, leisureLimit, 100_000]]) {
      const line = b.lines.find(l => l.categoryId === id);
      assert.deepEqual([line.baseLimit, line.actual, line.remaining], [planned, actual, planned - actual]);
    }
    assert.deepEqual(await w.ledger(), unchanged);
  }
  await check(300_000, 200_000);
  await w.refresh();
  const recipient = '//*[@data-testid="budget-line" and @data-category="Питание"]';
  const homeRow = '//*[@data-testid="warning-row"][contains(., "Питание")]';
  const homeCover = browser.$(homeRow + '//*[@data-testid="warning-cover"]');
  async function preview(button) {
    await button.waitForDisplayed();
    await button.scrollIntoView({ block: "center", inline: "nearest" });
    await button.click();
    const source = browser.$(byTest("cover-source"));
    await source.waitForDisplayed();
    await browser.waitUntil(() => browser.execute(() => document.activeElement?.dataset.testid === "cover-source"),
      { timeout: 3000, timeoutMsg: "При открытии переноса фокус должен стоять на выборе источника" });
    await source.selectByAttribute("value", leisure);
    await waitText(browser, byTest("cover-confirm"), money("400 ₽"));
    const rows = await browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"] tbody tr')].map(row =>
        [...row.cells].map(cell => cell.innerText.replace(/\s+/g, " ").trim())));
    assert.deepEqual(rows, [["Досуг", "2 000 ₽", "1 600 ₽"], ["Питание", "3 000 ₽", "3 400 ₽"]]);
  }
  await waitText(browser, homeRow + '//*[@data-testid="warning-cover"]', money("Покрыть 400 ₽"));
  await browser.keys(["Control", "h"]);
  const masked = await waitText(browser, homeRow, /•••/);
  assert.doesNotMatch(masked, /3\s?[04]00|400/);
  assert.doesNotMatch(await homeCover.getComputedLabel(), /400/);
  await browser.keys(["Control", "h"]);
  await waitText(browser, homeRow + '//*[@data-testid="warning-cover"]', money("Покрыть 400 ₽"));
  await preview(homeCover);
  await waitText(browser, "main h1", /Главная/);
  await browser.keys("Escape");
  await browser.waitUntil(async () => browser.execute(el => el === document.activeElement, await homeCover));
  await check(300_000, 200_000);
  await openSection(browser, "Бюджет");
  const cover = browser.$(recipient + '//button[contains(., "Покрыть перерасход")]');
  // Обычный вход из строки бюджета тоже удерживает и возвращает фокус.
  await preview(cover);
  for (let i = 0; i < 4; i++) {
    await browser.keys("Tab");
    assert.ok(await browser.execute(() => !!document.activeElement?.closest('[role="dialog"]')), "Tab вышел из диалога");
  }
  await browser.keys("Escape");
  await browser.waitUntil(async () => browser.execute(el => el === document.activeElement, await cover),
    { timeout: 3000, timeoutMsg: "После отмены фокус должен вернуться на кнопку строки «Питание»" });
  await check(300_000, 200_000);
  await preview(cover);
  await capture(browser, "02-cover-overspend");
  await browser.$(byTest("cover-confirm")).click();
  await browser.$(byTest("cover-confirm")).waitForExist({ reverse: true });
  await cover.waitForExist({ reverse: true });
  await browser.waitUntil(() => browser.execute(() => document.activeElement?.matches('[data-testid="budget-expense"] h2')),
    { timeout: 3000, timeoutMsg: "После погашения перерасхода фокус должен перейти на заголовок расходов" });
  await check(340_000, 160_000);
  await click(browser, "Отменить", '//*[@data-testid="undo-bar"]');
  await cover.waitForDisplayed();
  await check(300_000, 200_000);
  await openSection(browser, "Главная");
  await preview(homeCover);
  await capture(browser, "05-home-cover-preview");
  await browser.$(byTest("cover-confirm")).click();
  await browser.$(byTest("cover-confirm")).waitForExist({ reverse: true });
  await homeCover.waitForExist({ reverse: true });
  await waitText(browser, homeRow, /Лимит использован/);
  assert.ok(await browser.$(homeRow).$(".qw-kind.used").isExisting());
  await browser.waitUntil(() => browser.execute(() => document.activeElement?.matches('[data-testid="home-checks"] h2')),
    { timeout: 3000, timeoutMsg: "После покрытия перерасхода фокус должен перейти на заголовок предупреждений" });
  await check(340_000, 160_000);
  await click(browser, "Отменить", '//*[@data-testid="undo-bar"]');
  await homeCover.waitForDisplayed();
  await check(300_000, 200_000);
  await click(browser, "Повторить", '//*[@data-testid="undo-bar"]');
  await homeCover.waitForExist({ reverse: true });
  await w.refresh();
  await openSection(browser, "Бюджет");
  await browser.$(recipient).waitForDisplayed();
  assert.equal(await cover.isExisting(), false);
  await waitText(browser, recipient, /Лимит использован/);
  assert.ok(await browser.$(recipient).$(".bar.used").isExisting());
  await browser.$(recipient).scrollIntoView({ block: "center", inline: "nearest" });
  await capture(browser, "06-budget-used");
  await waitText(browser, byTest("budget-planned"), money("5 000 ₽"));
  await waitText(browser, byTest("budget-spent"), money("4 400 ₽"));
  await check(340_000, 160_000);
  // Остатка досуга 100 ₽ недостаточно, чтобы покрыть 400 ₽ питания.
  await invoke("set_budget_limit", { budgetId, categoryId: food, limit: 300_000 });
  await invoke("set_budget_limit", { budgetId, categoryId: leisure, limit: 110_000 });
  await w.refresh();
  const editPlan = browser.$(homeRow + '//button[@data-testid="warning-plan" and normalize-space()="Изменить план"]');
  await editPlan.waitForExist();
  await editPlan.scrollIntoView({ block: "center", inline: "nearest" });
  await editPlan.waitForClickable();
  assert.equal(await homeCover.isExisting(), false);
  await editPlan.click();
  await waitText(browser, "main h1", /Бюджет/);
  await browser.waitUntil(() => browser.execute(() =>
    document.activeElement?.matches('tr[data-category="Питание"] input[name="limit"]')),
    { timeout: 5000, timeoutMsg: "После «Изменить план» должен быть выбран лимит питания" });
  // В предупреждении о приближении к лимиту обе суммы и пояснение также скрываются.
  await invoke("set_budget_limit", { budgetId, categoryId: food, limit: 350_000 });
  await w.refresh();
  const warning = browser.$(homeRow);
  await warning.waitForExist();
  await warning.scrollIntoView({ block: "center", inline: "nearest" });
  const amounts = /3\s?400 из 3\s?500 ₽/;
  await waitText(browser, homeRow, amounts);
  await browser.keys(["Control", "h"]);
  await waitText(browser, homeRow, /97 % лимита/);
  assert.doesNotMatch(await browser.$(homeRow).getText(), /3\s?[45]00|100\s?₽/);
  await browser.keys(["Control", "h"]);
  await waitText(browser, homeRow, amounts);
  assert.deepEqual(await w.ledger(), unchanged);
  t.diagnostic(`Лимиты 3 000/2 000 → 3 400/1 600 ₽. План 5 000, факт 4 400, счета 22 600 и 5 000 ₽. ID после отмены и повтора: ${ids.join(", ")}.`);
});
