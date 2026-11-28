// Приёмочные тесты этапа 3 «Отчёты»: сценарии из product/mvp-features.md, раздел 6.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, money, setDate, waitCount } from "./app.mjs";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const title = (d) => `${MONTHS[d.getMonth()][0].toUpperCase()}${MONTHS[d.getMonth()].slice(1)} ${d.getFullYear()}`;
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
  for (const [type, amount, category] of [
    ["income", "20000", "Заработная плата"],
    ["expense", "2800", "Питание"],
    ["expense", "1500", "Транспорт"],
    ["expense", "5700", "Жильё"],
  ]) {
    await click(browser, type === "income" ? "+ Доход" : "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта (₽)");
    await choose(browser, "category", category);
    await save(browser);
  }
  // Перевод не должен попасть ни в расходы, ни в отчёт по категориям.
  await click(browser, "Перевод");
  await fill(browser, "amount", "3000");
  await choose(browser, "account", "Карта (₽)");
  await choose(browser, "toAccount", "Наличные (₽)");
  await save(browser);
});
after(async () => {
  await stop(browser);
});

const catRow = (name) => `//li[@data-testid="cat-row" and @data-category="${name}"]`;

test("итоги месяца: доли категорий «Жильё 57 %», «Продукты 28 %», «Транспорт 15 %»", async () => {
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="report-period"]', new RegExp(title(now)));
  await waitText(browser, '[data-testid="report-expense"]', money("10 000 ₽"));
  await waitText(browser, `${catRow("Питание")}//*[@data-testid="share"]`, /^28 %$/);
  const rows = await browser.$$('[data-testid="cat-row"]');
  const names = [];
  for (const r of rows) names.push(await r.getAttribute("data-category"));
  assert.deepEqual(names, ["Жильё", "Питание", "Транспорт"]);
  assert.equal(await browser.$(`${catRow("Транспорт")}//*[@data-testid="share"]`).getText(), "15 %");
  assert.equal(await browser.$(`${catRow("Жильё")}//*[@data-testid="share"]`).getText(), "57 %");
});

test("норма сбережений: половина дохода осталась (50 %), перевод не считается", async () => {
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="savings-rate"]', /50 %/);
  await waitText(browser, '[data-testid="report-balance"]', money("+10 000 ₽"));
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="home-savings-rate"]', /Норма сбережений 50 %/);
});

test("доходы по категориям на второй вкладке структуры", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Доходы", '//*[contains(@class,"tabs small")]');
  await waitText(browser, `${catRow("Заработная плата")}//*[@data-testid="share"]`, /^100 %$/);
});

test("разобраться в цифре: клик по «Транспорт» открывает его операции за период", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Расходы", '//*[contains(@class,"tabs small")]');
  await browser.$(catRow("Транспорт")).waitForExist({ timeout: 5000 });
  await (await browser.$(`${catRow("Транспорт")}//button[contains(@class,"cat-link")]`)).click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
});

test("динамика за год: 12 месяцев, текущий с доходом 20 000 и расходом 10 000", async () => {
  await openSection(browser, "Отчёты");
  await choose(browser, "periodKind", "Год");
  await waitText(browser, '[data-testid="report-period"]', new RegExp(`${now.getFullYear()} год`));
  await click(browser, "По месяцам");
  await browser.$('[data-testid="months"]').waitForExist({ timeout: 5000 });
  await waitCount(browser, '[data-testid="month-row"]', 12);
  const row = `//tr[@data-testid="month-row" and @data-month="${now.getFullYear()}-${pad(now.getMonth() + 1)}"]`;
  await waitText(browser, row, money("20 000 ₽"));
  await waitText(browser, row, money("10 000 ₽"));
  await waitText(browser, row, /50 %/);
  await waitText(browser, '[data-testid="months-savings-rate"]', /50 %/);
  // В графике по паре столбцов на месяц.
  await waitCount(browser, ".chart path.bar-income", 12);
});

test("остатки на дату: сегодня 110 000 ₽, вчера счетов ещё не было", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Остатки на дату");
  await waitText(browser, '[data-testid="balances-total"]', money("110 000 ₽"));
  await waitText(browser, '//tr[@data-account="Наличные"]', money("3 000 ₽"));
  await waitText(browser, '//tr[@data-account="Карта"]', money("107 000 ₽"));
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  await setDate(browser, "balancesDate", iso(yesterday));
  await waitText(browser, "main", /На эту дату счетов ещё не было/);
});

test("корректировка видна отдельной строкой и не входит в расходы", async () => {
  await openSection(browser, "Счета");
  const card = `//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="Карта"]]`;
  await (await browser.$(`${card}//button[normalize-space()="Сверить"]`)).click();
  await fill(browser, "actualBalance", "106500");
  await save(browser, "Записать корректировку");
  await openSection(browser, "Отчёты");
  await waitText(browser, '[data-testid="report-balance"]', money("Корректировки: −500 ₽"));
  await waitText(browser, '[data-testid="report-expense"]', money("10 000 ₽"));
});

test("Р12: доли кольцом, линия по месяцам и отбор по счёту", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Структура", "//main");
  await (await browser.$('[data-testid="structure-chart-donut"]')).click();
  await waitText(browser, '[data-testid="structure-donut"]', /Жильё/);
  await browser.execute(() => document.querySelector('[data-category="Транспорт"] .cat-link').focus());
  await waitText(browser, ".donut-sub", /Транспорт/);
  await waitText(browser, ".donut-main", /15 %/);
  // Все расходы — с «Карты»: по «Наличным» расходов нет, перевод не считается.
  await choose(browser, "reportAccount", "Наличные");
  await waitText(browser, "main", /За этот период операций нет/);
  await choose(browser, "reportAccount", "Все счета");
  await waitText(browser, '[data-testid="report-expense"]', money("10 000 ₽"));
  await (await browser.$('[data-testid="structure-chart-bars"]')).click();
  await waitCount(browser, '[data-testid="structure-donut"]', 0);

  await click(browser, "По месяцам", "//main");
  await (await browser.$('[data-testid="months-chart-line"]')).click();
  await browser.$('[data-testid="months-line"]').waitForExist({ timeout: 5000 });
  await browser.execute(() => document.querySelector('.chart svg g[tabindex]').focus());
  await waitText(browser, '.chart [role="tooltip"]', /Доходы/);
  const months = await browser.$$('.monthly-chart svg g[tabindex]');
  const tip = '.monthly-chart [role="tooltip"]';
  assert.equal((await browser.$$('.monthly-chart svg g[tabindex="0"]')).length, 1);
  await browser.keys("End");
  await waitText(browser, tip, new RegExp(await months.at(-1).getAttribute("aria-label")));
  await browser.keys("ArrowLeft");
  await waitText(browser, tip, new RegExp(await months.at(-2).getAttribute("aria-label")));
  await browser.keys("Home");
  await waitText(browser, tip, new RegExp(await months[0].getAttribute("aria-label")));
  await browser.keys("Escape");
  await waitCount(browser, '.chart [role="tooltip"]', 0);
  await waitCount(browser, ".chart path.bar-income", 0);
  await (await browser.$('[data-testid="months-chart-bars"]')).click();
  await waitCount(browser, ".chart path.bar-income", 12);
  await click(browser, "Структура", "//main");
});

test("переход к прошлому периоду: там операций нет", async () => {
  await openSection(browser, "Отчёты");
  await choose(browser, "periodKind", "Месяц");
  await (await browser.$('button[aria-label="Предыдущий период"]')).click();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  await waitText(browser, '[data-testid="report-period"]', new RegExp(title(prev)));
  await waitText(browser, '[data-testid="report-expense"]', money("0 ₽"));
  await waitText(browser, "main", /За этот период операций нет/);
});

test("девятая категория доступна с клавиатуры, возврат за прошлый месяц не превращается в долю", async () => {
  // Легенда показывает первые восемь. За её пределами всё ещё доступны подсветка и переход.
  const seeded = await browser.executeAsync(async (date, previous, done) => {
    const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    try {
      const { id: accountId } = (await invoke("list_accounts", { includeArchived: false })).find(a => a.name === "Карта");
      const create = (categoryId, at, amount) => invoke("create_transaction", { input: { type: "expense", date: at, accountId, amount, categoryId,
        payee: null, note: null, toAccountId: null, toAmount: null } });
      for (let i = 1; i <= 9; i++) {
        const categoryId = await invoke("create_category", { input: { name: `Проверка ${i}`, kind: "expense", parentId: null } });
        await create(categoryId, date, 1000 + i);
      }
      const categoryId = await invoke("create_category", { input: { name: "Возврат из прошлого", kind: "expense", parentId: null } });
      done({ purchase: await create(categoryId, previous, 8000) });
    } catch (error) { done({ error: String(error) }); }
  }, iso(now), iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
  assert.equal(seeded.error, undefined);
  await browser.refresh();
  await openSection(browser, "Отчёты");
  await choose(browser, "periodKind", "Месяц");
  await click(browser, "Структура", "//main");
  await browser.$('[data-testid="structure-chart-donut"]').click();
  await waitText(browser, '[data-testid="structure-donut"]', /и ещё/);
  const ninth = await browser.execute(() => {
    const row = document.querySelectorAll('[data-testid="cat-row"]')[8];
    row.querySelector(".cat-link").focus();
    return row.dataset.category;
  });
  await waitText(browser, ".donut-sub", new RegExp(ninth));
  await browser.keys("Enter");
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed();

  const refund = await browser.executeAsync((purchase, date, done) => {
    window.__TAURI_INTERNALS__.invoke("create_refund", { input: { of: purchase, date, accountId: null, amount: 8000,
      inPurchaseMonth: false, note: null } }).then(() => done(null), error => done(String(error)));
  }, seeded.purchase, iso(now));
  assert.equal(refund, null);
  await browser.refresh();
  await openSection(browser, "Отчёты");
  await waitText(browser, "main", /отрицательные суммы/);
  await waitText(browser, catRow("Возврат из прошлого"), money("−80 ₽"));
  await waitCount(browser, '[data-testid="structure-donut"]', 0);
  await waitCount(browser, '[data-testid="share"]', 0);
});
