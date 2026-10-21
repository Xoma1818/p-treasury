// 0.12: выписки Сбера и Т-Банка, напоминание накануне регулярного платежа и картинка «Итоги года».
// Системные окна выбора файла тест не нажимает: ответы подкладываются в window.__ptPick.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, click, choose, waitText, waitContent } from "./app.mjs";
// Получатель в таблице обрезается многоточием, а WebKit не отдаёт такой текст через getText.
const previewHas = (re) => waitContent(browser, '[data-testid="import-preview"]', re);

const fixtures = join(import.meta.dirname, "..", "crates/core/testdata");
const out = mkdtempSync(join(tmpdir(), "p-treasury-wave6-"));
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const ru = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const daysAgo = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
const dialog = '//*[@role="dialog"]';

let browser;
const pick = (...paths) => browser.execute((p) => (window.__ptPick = p), paths);
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "5000" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

test("выписка Т-Банка: счёт выбирается и запоминается, повторная загрузка ничего не дублирует", async () => {
  await openSection(browser, "Настройки");
  await click(browser, "Импорт выписки или CSV");
  await pick(join(fixtures, "tbank.csv"));
  await click(browser, "Выбрать файл", dialog);
  await waitText(browser, '[data-testid="import-bank"]', /Выписка Т-Банк/);
  // Отклонённая операция (FAILED) в список не попала; без счёта грузить нельзя.
  await waitText(browser, '[data-testid="import-summary"]', /строк 4, без ошибок 0, с ошибками 4/);
  await choose(browser, "importAccount", "Карта (₽)");
  await waitText(browser, '[data-testid="import-summary"]', /строк 4, без ошибок 4$/);
  await previewHas(/Супермаркет[\s\S]*Пятерочка[\s\S]*Зарплата/);
  await click(browser, "Загрузить 4", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 4/);

  // Тот же файл ещё раз: счёт подставился сам, все строки — повторы.
  await pick(join(fixtures, "tbank.csv"));
  await click(browser, "Выбрать файл", dialog);
  await waitText(browser, '[data-testid="import-summary"]', /строк 4, без ошибок 0, уже загружено раньше 4$/);
  assert.equal(await (await browser.$('select[name="importAccount"]')).getValue() !== "", true);
  assert.equal(await (await browser.$(`${dialog}//button[normalize-space()="Загрузить 0"]`)).isEnabled(), false);
  await browser.keys("Escape");
});

test("выписка Сбера (PDF): пять операций с переносом описания на счёт «Наличные»", async () => {
  await click(browser, "Импорт выписки или CSV");
  await pick(join(fixtures, "sber-card.pdf"));
  await click(browser, "Выбрать файл", dialog);
  await waitText(browser, '[data-testid="import-bank"]', /Выписка Сбер/);
  await choose(browser, "importAccount", "Наличные (₽)");
  await waitText(browser, '[data-testid="import-summary"]', /строк 5, без ошибок 5$/);
  await previewHas(/МТС мобильная связь, оплата по номеру \+7 916/);
  await click(browser, "Загрузить 5", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 5/);
  await browser.keys("Escape");
});

test("регулярный платёж: накануне списания — плашка «спишется завтра», напоминание можно выключить", async () => {
  // Каждую неделю «Литрес» по 399 ₽: последний платёж 6 дней назад, следующий — завтра.
  const path = join(out, "литрес.csv");
  const rows = [27, 20, 13, 6].map((d) => `${ru(daysAgo(d))};Расход;Карта;Образование;Литрес;;399`);
  writeFileSync(path, "﻿Дата;Тип;Счёт;Категория;Получатель;Комментарий;Сумма\n" + rows.join("\n") + "\n");
  await click(browser, "Импорт выписки или CSV");
  await pick(path);
  await click(browser, "Выбрать файл", dialog);
  await click(browser, "Загрузить 4", dialog);
  await waitText(browser, '[data-testid="import-done"]', /Загружено операций: 4/);
  await browser.keys("Escape");

  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="home-subs"] [data-key="литрес"] [data-testid="sub-soon"]', /спишется завтра/);

  await openSection(browser, "Настройки");
  assert.equal(await (await browser.$('select[name="subsRemind"]')).getValue(), "1");
  await choose(browser, "subsRemind", "не напоминать");
  await openSection(browser, "Главная");
  await openSection(browser, "Настройки");
  assert.equal(await (await browser.$('select[name="subsRemind"]')).getValue(), "0");
  await choose(browser, "subsRemind", "за день");
});

test("итоги года: картинка 1080×1350, «Без сумм» и сохранение в PNG", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Итоги года");
  await click(browser, "Картинка для друзей");
  const canvas = await browser.$('[data-testid="year-card"]');
  await canvas.waitForDisplayed({ timeout: 5000 });
  const size = await browser.execute(() => {
    const c = document.querySelector('[data-testid="year-card"]');
    return [c.width, c.height];
  });
  assert.deepEqual(size, [1080, 1350]);
  await (await browser.$('input[name="shareHide"]')).click();
  const file = join(out, "итоги.png");
  await pick(file);
  await click(browser, "Сохранить PNG", dialog);
  await waitText(browser, '[data-testid="share-status"]', /Сохранено: итоги\.png/);
  const png = readFileSync(file);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], "это PNG");
  assert.ok(statSync(file).size > 20_000, "картинка не пустая");
  await browser.keys("Escape");
});
