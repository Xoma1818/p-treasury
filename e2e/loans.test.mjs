// Займы 0.16 (product/loans-0.16.md): рассчитал в форме → записал заём → досрочка через окно платежа →
// ставка изменилась → история показывает снимки → скачал Excel и PDF (файлы созданы).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, openSettings, onboard, fill, choose, click, save, waitText, waitContent, money, setDate, waitCount } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = (n) => iso(new Date(Date.now() + n * 86_400_000));
const out = mkdtempSync(join(tmpdir(), "p-treasury-loans-"));

let browser;
before(async () => {
  ({ browser } = await start());
  // Восстановленный заём без привязки к счёту делает JPY доступной в справочнике с первого запуска.
  await browser.$('//h1[normalize-space()="Основная валюта"]').waitForDisplayed({ timeout: 15000 });
  const debt = await browser.executeAsync((issueDate, firstPaymentDate, done) => {
    window.__TAURI_INTERNALS__.invoke("create_debt", { input: {
      direction: "borrowed", counterparty: "Заём в иенах", currencyCode: "JPY", principal: 12000,
      rateBp: 0, repaymentType: "annuity", termMonths: 3, issueDate, firstPaymentDate,
      maturityDate: null, accountId: null, note: null,
    } }).then((id) => done({ id }), (error) => done({ error: String(error) }));
  }, inDays(-5), inDays(5));
  assert.ifError(debt.error);
  assert.ok(debt.id);
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

/** Подложить ответ системному окну «Сохранить как» (src/lib/files.ts). */
const pick = (path) => browser.execute((p) => (window.__ptPick = [p]), path);

/** Файл появился, не пустой и начинается с подписи формата. */
function assertFile(path, magic) {
  assert.ok(existsSync(path), `нет файла ${path}`);
  assert.ok(statSync(path).size > 1000, `файл ${path} слишком мал`);
  assert.equal(readFileSync(path).subarray(0, magic.length).toString("latin1"), magic);
}

/** Текст PDF, если в системе есть pdftotext (poppler); иначе null. */
function pdfText(path) {
  const r = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

test("форма расчёта: проценты по дням, досрочка, экономия и диаграмма", async () => {
  await openSection(browser, "Займы и долги");
  await click(browser, "Калькулятор");
  await fill(browser, "principal", "300000");
  await fill(browser, "rate", "12");
  await choose(browser, "termUnit", "месяцев");
  await fill(browser, "term", "24");
  await setDate(browser, "issueDate", "2026-10-15");
  await setDate(browser, "firstPayment", "2026-11-15");
  // Аннуитет по формуле с r = R/12, проценты первого периода за 31 день: 300 000 × 12 % × 31 / 365.
  await waitText(browser, '[data-testid="loan-payment"]', money("14 122,04 ₽"));
  await waitText(browser, '//tr[@data-testid="plan-row"][1]', money("3 057,53 ₽"));
  await waitCount(browser, '[data-testid="plan-row"]', 24);
  assert.equal(await browser.$('[data-testid="loan-savings"]').isExisting(), false);

  // Досрочка 50 000 ₽ 01.03.2027 с уменьшением срока: строк меньше, есть экономия и вторая линия.
  await click(browser, "+ Досрочное погашение");
  await fill(browser, "early-amount-0", "50000");
  await setDate(browser, "early-date-0", "2027-03-01");
  await choose(browser, "early-mode-0", "уменьшать срок");
  await waitText(browser, '[data-testid="loan-savings"]', /\d/);
  await browser.$('[data-testid="plan-early"]').waitForExist({ timeout: 5000 });
  assert.ok((await browser.$$('[data-testid="plan-row"]')).length < 24);
  assert.ok(await browser.$('[data-testid="loan-chart"] .line-base').isExisting(), "линия без досрочек");
  const date = await browser.$('[aria-label="Дата остатка долга"]');
  await browser.execute((slider) => slider.focus(), date);
  await browser.keys("Home");
  await browser.keys("ArrowRight");
  await waitText(browser, '[data-testid="loan-chart-readout"] time', /16\.10\.2026/);
  assert.match(await date.getAttribute("aria-valuetext"), money("300 000 ₽"));
  await browser.keys("End");
  assert.match(await date.getAttribute("aria-valuetext"), /Без досрочек 0\s*₽\. С досрочками 0\s*₽/);
  await (await browser.$('[data-testid="hide-amounts"]')).click();
  await waitText(browser, '[data-testid="loan-chart-readout"]', /•••/);
  assert.match(await date.getAttribute("aria-valuetext"), /Сумма скрыта/);
  assert.doesNotMatch(await date.getAttribute("aria-valuetext"), /₽/);
  assert.doesNotMatch(await browser.$('[data-testid="loan-chart"]').getText(), /₽/);
  await (await browser.$('[data-testid="hide-amounts"]')).click();
  await waitText(browser, '[data-testid="loan-chart-readout"]', /₽/);

  // Обратные расчёты: срок по желаемому платежу.
  await (await browser.$('[data-testid="solve-term"]')).click();
  await fill(browser, "desiredPayment", "14122,04");
  await waitText(browser, '[data-testid="loan-term"]', /2 года/);
  await (await browser.$('[data-testid="solve-payment"]')).click();
  await waitText(browser, '[data-testid="loan-payment"]', money("14 122,04 ₽"));
});

test("из формы: «Скачать график» в Excel и CSV и «PDF для подписи» с ФИО", async () => {
  const xlsx = join(out, "расчёт.xlsx");
  await pick(xlsx);
  await click(browser, "Скачать график");
  await click(browser, "Скачать в Excel");
  await waitText(browser, '[data-testid="export-status"]', /Сохранено: расчёт\.xlsx/);
  assertFile(xlsx, "PK");

  const csv = join(out, "расчёт.csv");
  await pick(csv);
  await click(browser, "Скачать график");
  await click(browser, "Скачать в CSV");
  await waitText(browser, '[data-testid="export-status"]', /Сохранено: расчёт\.csv/);
  const csvText = readFileSync(csv, "utf8");
  assert.ok(csvText.startsWith("\uFEFFГрафик"), "BOM и первым — лист «График»");
  assert.match(csvText, /\nУсловия\r?\n/, "и лист «Условия»");

  const pdf = join(out, "расчёт.pdf");
  await click(browser, "PDF для подписи");
  await fill(browser, "lenderName", "Петров Пётр Петрович");
  await fill(browser, "borrowerName", "Сидоров Сидор Сидорович");
  await pick(pdf);
  await save(browser, "Сохранить файл");
  await waitText(browser, '[data-testid="export-status"]', /Сохранено: расчёт\.pdf/);
  assertFile(pdf, "%PDF");
  const text = pdfText(pdf);
  if (text !== null) {
    assert.match(text, /Петров Пётр Петрович/);
    assert.match(text, /Заёмщик/);
  }
});

test("«Записать заём»: заём по дням с выдачей сегодня, деньги на карте", async () => {
  // Записываем с выдачей сегодня, без плановой досрочки из расчёта.
  await (await browser.$('button[aria-label="Убрать досрочку"]')).click();
  await setDate(browser, "issueDate", inDays(0));
  await setDate(browser, "firstPayment", "");
  await waitCount(browser, '[data-testid="plan-early"]', 0);
  await click(browser, "Записать заём");
  await fill(browser, "counterparty", "Банк");
  await choose(browser, "account", "Карта (₽)");
  await waitText(browser, '[data-testid="debt-preview"]', /по дням, как банк/);
  await save(browser);
  await browser.$('//main//h1[contains(., "Банк")]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="debt-next"]', money("14 122,04 ₽"));
  await waitCount(browser, '[data-testid="schedule-row"]', 24);
  await waitText(browser, "main", /по дням, как банк/);
});

test("окно платежа: раньше даты — «в счёт платежа от …», досрочка с разбивкой и прогнозом", async () => {
  await click(browser, "Оплачено");
  await waitText(browser, '[data-testid="pay-towards"]', /в счёт платежа от \d\d\.\d\d\.\d{4}/);
  assert.equal(await (await browser.$('[role="dialog"] [name="asEarly"]')).isSelected(), false);
  await browser.keys("Escape");

  await click(browser, "Досрочный платёж");
  assert.equal(await (await browser.$('[role="dialog"] [name="asEarly"]')).isSelected(), true);
  await fill(browser, "earlyAmount", "1000");
  const debtPart = '[role="dialog"] [name="principal"]';
  await browser.waitUntil(async () => (await browser.$(debtPart).getValue()) === "1000");
  // Отправляем форму до пересчёта. Предыдущая разбивка не должна стать платежом.
  const changeAndSubmit = (value) => browser.executeAsync((amount, done) => {
    const input = document.querySelector('[role="dialog"] [name="earlyAmount"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, amount);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(() => { input.form.requestSubmit(); done(); }, 0);
  }, value);
  await changeAndSubmit("100");
  await browser.waitUntil(async () => (await browser.$(debtPart).getValue()) === "100");
  await changeAndSubmit("");
  await browser.waitUntil(async () => (await browser.$('[name="earlyAmount"]').getValue()) === "");
  await fill(browser, "earlyAmount", "50000");
  await choose(browser, "recalcMode", "Уменьшить срок, платёж прежний");
  await waitText(browser, '[data-testid="pay-quote"]', /новый платёж .+ \/ срок до \d\d\.\d\d\.\d{4} \/ экономия/);
  // Выдача сегодня: процентов за прошедшие дни нет, вся сумма — в долг.
  await browser.waitUntil(async () => (await (await browser.$('[role="dialog"] [name="principal"]')).getValue()) === "50000", { timeout: 5000 });
  await save(browser);
  await waitText(browser, '[data-testid="debt-outstanding"]', money("250 000 ₽"));
  await waitText(browser, '[data-testid="debt-next"]', money("14 122,04 ₽"));
  await browser.waitUntil(async () => (await browser.$$('[data-testid="schedule-row"]')).length < 24, { timeout: 5000 });
});

test("«Ставка изменилась» и «Изменить условия» с предпросмотром «было → стало»", async () => {
  const before = await (await browser.$('[data-testid="debt-next"]')).getText();
  await click(browser, "Ставка изменилась");
  const from = inDays(5);
  await setDate(browser, "rateFrom", from);
  await fill(browser, "newRate", "10");
  await waitText(browser, '[data-testid="cmp-rate"] td:last-child', money(`10 % годовых с ${from.split("-").reverse().join(".")}`));
  await save(browser);
  await waitText(browser, '[data-testid="loan-changes"]', /Ставка 10 % годовых с/);
  await browser.waitUntil(async () => (await (await browser.$('[data-testid="debt-next"]')).getText()) !== before, { timeout: 5000, timeoutMsg: "платёж не пересчитался" });

  await click(browser, "Изменить условия");
  assert.equal(await (await browser.$('[role="dialog"] [name="termsPrincipal"]')).getValue(), "300000");
  await fill(browser, "termsTerm", "36");
  await waitText(browser, '[data-testid="cmp-maturity"]', /\d\d\.\d\d\.\d{4}\s*→\s*\d\d\.\d\d\.\d{4}/);
  await save(browser);
  await waitText(browser, '[data-testid="debt-terms"]', /36 мес\./);
});

test("история: снимки до каждого изменения и общая экономия", async () => {
  await (await browser.$('[data-testid="tab-history"]')).click();
  await browser.waitUntil(async () => (await browser.$$('[data-testid="version"]')).length >= 4, { timeout: 5000, timeoutMsg: "мало снимков в истории" });
  // Строки ленты проявляются плавно: текст берём через textContent, а не getText.
  for (const re of [/Заём записан/, /Досрочно/, /ставк/i, /Изменены условия/]) await waitContent(browser, '[data-testid="history"]', re);
  await waitText(browser, '[data-testid="history-savings"]', /₽/);
});

test("плановые досрочки дают прогноз, «а что если» считает без записи", async () => {
  await (await browser.$('[data-testid="tab-planned"]')).click();
  await click(browser, "+ Досрочное погашение");
  await fill(browser, "early-amount-0", "10000");
  await choose(browser, "early-freq-0", "раз в месяц");
  await click(browser, "Сохранить досрочки");
  await waitText(browser, '[data-testid="forecast-savings"]', /\d/);
  const snapshot = await browser.executeAsync((done) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    invoke("list_debts").then((debts) => {
      const { id } = debts.find((d) => d.counterparty === "Банк");
      return Promise.all([invoke("get_debt", { id }), invoke("debt_forecast", { id })]);
    }).then(([{ card }, forecast]) => done({ from: forecast.from, balance: card.outstanding, principal: card.principal }), (error) => done({ error: String(error) }));
  });
  assert.ifError(snapshot.error);
  assert.deepEqual([snapshot.principal, snapshot.balance], [30_000_000, 25_000_000]);
  const readout = '[data-testid="forecast"] [data-testid="loan-chart-readout"]';
  assert.equal(await (await browser.$(readout + " time")).getAttribute("datetime"), snapshot.from);
  for (const i of ["first-child", "last-child"]) {
    await waitText(browser, readout + " .legend > span:" + i, money("250 000 ₽"));
  }

  await (await browser.$('[data-testid="tab-whatif"]')).click();
  const outstanding = await (await browser.$('[data-testid="debt-outstanding"]')).getText();
  await fill(browser, "whatIfAmount", "20000");
  await waitText(browser, '[data-testid="whatif-result"]', /Экономия/);
  // Ничего не записано.
  assert.equal(await (await browser.$('[data-testid="debt-outstanding"]')).getText(), outstanding);
});

test("«Скачать график»: PDF с подписями и Excel по займу, ваше ФИО запомнилось", async () => {
  const pdf = join(out, "заём.pdf");
  await click(browser, "Скачать график");
  // В расчёте вы были займодавцем; в этом займе вы заёмщик — ФИО подставилось из настройки.
  assert.equal(await (await browser.$('[role="dialog"] [name="borrowerName"]')).getValue(), "Петров Пётр Петрович");
  assert.equal(await (await browser.$('[role="dialog"] [name="lenderName"]')).getValue(), "Банк");
  await (await browser.$('[role="dialog"] [name="withForecast"]')).click();
  await pick(pdf);
  await save(browser, "Сохранить файл");
  await waitText(browser, '[data-testid="export-status"]', /Сохранено: заём\.pdf/);
  assertFile(pdf, "%PDF");
  const text = pdfText(pdf);
  if (text !== null) assert.match(text, /Петров Пётр Петрович/);

  const xlsx = join(out, "заём.xlsx");
  await click(browser, "Скачать график");
  await click(browser, "Excel", '//*[@role="dialog"]');
  await pick(xlsx);
  await save(browser, "Сохранить файл");
  await waitText(browser, '[data-testid="export-status"]', /Сохранено: заём\.xlsx/);
  assertFile(xlsx, "PK");
});

test("деньги: выдача пришла на карту, досрочка ушла с неё", async () => {
  await openSection(browser, "Счета");
  await waitText(browser, '//tr[@data-testid="account-row"][.//div[@class="main" and normalize-space()="Карта"]]', money("350 000 ₽"));
});

test("остаток на день обычного и досрочного платежа учитывает обе суммы", async () => {
  await openSection(browser, "Займы и долги");
  await click(browser, "Калькулятор");
  await fill(browser, "principal", "12000");
  await fill(browser, "rate", "0");
  await choose(browser, "termUnit", "месяцев");
  await fill(browser, "term", "3");
  await setDate(browser, "issueDate", "2026-11-14");
  await setDate(browser, "firstPayment", "2026-11-15");
  await click(browser, "+ Досрочное погашение");
  await fill(browser, "early-amount-0", "1000");
  await setDate(browser, "early-date-0", "2026-11-15");
  await choose(browser, "early-mode-0", "уменьшать срок");
  await waitText(browser, '[data-testid="plan-early"]', money("1 000 ₽"));
  const slider = await browser.$('[aria-label="Дата остатка долга"]');
  await browser.execute((input) => input.focus(), slider);
  await browser.keys("Home");
  await waitText(browser, '[data-testid="loan-chart-readout"]', money("12 000 ₽"));
  for (const day of ["15.11.2026", "16.11.2026"]) {
    await browser.keys("ArrowRight");
    await browser.waitUntil(async () => (await slider.getAttribute("aria-valuetext")).startsWith(day), { timeout: 5000 });
    await waitText(browser, '[data-testid="loan-chart-readout"] .legend > span:first-child', money("8 000 ₽"));
    await waitText(browser, '[data-testid="loan-chart-readout"] .legend > span:last-child', money("7 000 ₽"));
  }
});

test("сохранённая иена верно подписана, при смене RUB на JPY калькулятор ждёт новый расчёт", async (t) => {
  await openSettings(browser, "general");
  const fineCard = await browser.$('[data-testid="fine-card"]');
  await fineCard.waitForExist({ timeout: 5000 });
  if (!(await browser.execute((card) => card.open, fineCard))) await (await fineCard.$("summary")).click();
  const previousCodeMode = await (await browser.$('[name="fineCode"]')).getValue();
  t.after(async () => {
    await openSettings(browser, "general");
    const card = await browser.$('[data-testid="fine-card"]');
    await card.waitForExist({ timeout: 5000 });
    if (!(await browser.execute((el) => el.open, card))) await (await card.$("summary")).click();
    const select = await browser.$('[name="fineCode"]');
    await select.selectByAttribute("value", previousCodeMode);
    assert.equal(await select.getValue(), previousCodeMode);
  });
  await choose(browser, "fineCode", "Кодом: 1 200 RUB");
  await openSection(browser, "Займы и долги");
  const row = '[data-testid="debt-row"][data-name="Заём в иенах"]';
  await waitText(browser, row, money("12 000 JPY"));
  await waitText(browser, '//*[@data-testid="upcoming"]//li[contains(., "Заём в иенах")]', money("4 000 JPY"));
  const debtName = await browser.$(row + " .main");
  await browser.execute((el) => el.scrollIntoView({ block: "center" }), debtName);
  await debtName.waitForClickable({ timeout: 5000 });
  await debtName.click();
  await waitText(browser, '[data-testid="debt-outstanding"]', money("12 000 JPY"));
  await waitText(browser, '[data-testid="debt-next"]', money("4 000 JPY"));
  await click(browser, "Все долги");
  await click(browser, "Калькулятор");
  await fill(browser, "principal", "12000");
  const readout = '[data-testid="loan-chart-readout"]';
  await waitText(browser, readout, money("12 000 RUB"));
  assert.ok(await browser.$('select[name="currency"] option[value="JPY"]').isExisting());
  const transition = await browser.executeAsync((done) => {
    const el = document.querySelector('select[name="currency"]');
    el.value = "JPY";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    queueMicrotask(() => {
      const buttons = [...document.querySelectorAll(".loan-actions button")].filter((b) =>
        ["Записать заём", "Скачать график", "PDF для подписи"].includes(b.textContent.trim()));
      done({ hasChart: !!document.querySelector('[data-testid="loan-chart"]'), buttons: buttons.map((b) => b.disabled) });
    });
  });
  assert.deepEqual(transition, { hasChart: false, buttons: [true, true, true] });
  await waitText(browser, readout, money("12 000 JPY"));
  const slider = await browser.$('[aria-label="Дата остатка долга"]');
  assert.match(await slider.getAttribute("aria-valuetext"), money("12 000 JPY"));
  await click(browser, "+ Досрочное погашение");
  await waitText(browser, '[data-testid="loan-totals"]', /Укажите дату и сумму/);
  assert.equal(await (await browser.$('[data-testid="loan-chart"]')).isExisting(), false);
  for (const label of ["Записать заём", "Скачать график", "PDF для подписи"]) {
    assert.equal(await (await browser.$(`//button[normalize-space()="${label}"]`)).isEnabled(), false);
  }
});
