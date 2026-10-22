// Займы 0.16 (product/loans-0.16.md): рассчитал в форме → записал заём → досрочка через окно платежа →
// ставка изменилась → история показывает снимки → скачал Excel и PDF (файлы созданы).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, waitContent, money, setDate, waitCount } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = (n) => iso(new Date(Date.now() + n * 86_400_000));
const out = mkdtempSync(join(tmpdir(), "p-treasury-loans-"));

let browser;
before(async () => {
  ({ browser } = await start());
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
  const r = spawnSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
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

  // Обратные расчёты: срок по желаемому платежу.
  await (await browser.$('[data-testid="solve-term"]')).click();
  await fill(browser, "desiredPayment", "14122,04");
  await waitText(browser, '[data-testid="loan-term"]', /2 года/);
  await (await browser.$('[data-testid="solve-payment"]')).click();
  await waitText(browser, '[data-testid="loan-payment"]', money("14 122,04 ₽"));
});

test("из формы: «Скачать Excel» и «PDF для подписи» с ФИО", async () => {
  const xlsx = join(out, "расчёт.xlsx");
  await pick(xlsx);
  await click(browser, "Скачать Excel");
  await waitText(browser, '[data-testid="export-status"]', /Сохранено: расчёт\.xlsx/);
  assertFile(xlsx, "PK");

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
  await setDate(browser, "rateFrom", inDays(5));
  await fill(browser, "newRate", "10");
  await save(browser);
  await waitText(browser, '[data-testid="loan-changes"]', /Ставка 10 % с/);
  await browser.waitUntil(async () => (await (await browser.$('[data-testid="debt-next"]')).getText()) !== before, { timeout: 5000, timeoutMsg: "платёж не пересчитался" });

  await click(browser, "Изменить условия");
  assert.equal(await (await browser.$('[role="dialog"] [name="termsPrincipal"]')).getValue(), "300000");
  await fill(browser, "termsTerm", "36");
  await waitText(browser, '[data-testid="diff-maturity"]', /\d\d\.\d\d\.\d{4}\s*→\s*\d\d\.\d\d\.\d{4}/);
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
