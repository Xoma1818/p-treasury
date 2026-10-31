// 0.12: импорт из папки, регулярные платежи, цели накоплений, итоги года, поиск Ctrl+K и значки «?».
// Системные окна выбора папки тест не нажимает: ответы подкладываются в window.__ptPick.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop, openSection, onboard, click, fill, save, waitText, waitContent, money } from "./app.mjs";
// Названия в списке поиска обрезаются многоточием, а WebKit не отдаёт такой текст через getText.
const paletteHas = (re) => waitContent(browser, '[data-testid="palette"]', re);

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const ru = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const daysAgo = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
const inbox = mkdtempSync(join(tmpdir(), "p-treasury-inbox-"));
const csv = (rows) => "﻿Дата;Тип;Счёт;Категория;Получатель;Комментарий;Сумма\n" + rows.map((r) => r.join(";")).join("\n") + "\n";

let browser;
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

test("импорт из папки: новый CSV по шаблону загружается один раз, чужие файлы не трогаются", async () => {
  await openSection(browser, "Настройки");
  await browser.execute((p) => (window.__ptPick = p), [inbox]);
  await click(browser, "Выбрать папку");
  await waitText(browser, '[data-testid="auto-import-dir"]', new RegExp(inbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  writeFileSync(
    join(inbox, "выписка.csv"),
    csv([
      [ru(daysAgo(65)), "Расход", "Карта", "Подписки", "Яндекс Плюс", "", "399"],
      [ru(daysAgo(35)), "Расход", "Карта", "Подписки", "Яндекс Плюс", "", "399"],
      [ru(daysAgo(5)), "Расход", "Карта", "Подписки", "Яндекс Плюс", "", "399"],
      [ru(daysAgo(3)), "Расход", "Карта", "Питание", "Пятёрочка", "", "1250"],
    ]),
  );
  writeFileSync(join(inbox, "прайс.csv"), "name,price\nчай,10\n");
  await click(browser, "Проверить сейчас");
  await waitText(browser, '[data-testid="auto-import-result"]', /выписка\.csv: добавлено 4, пропущено 0/);
  // Второй раз тот же файл не берётся, а повтор операций в новом файле пропускается.
  writeFileSync(join(inbox, "ещё.csv"), csv([[ru(daysAgo(3)), "Расход", "Карта", "Питание", "Пятёрочка", "", "1250"]]));
  await click(browser, "Проверить сейчас");
  await waitText(browser, '[data-testid="auto-import-result"]', /^ещё\.csv: добавлено 0, пропущено 1$/);
});

test("регулярные платежи: «Яндекс Плюс» найден, 4 788 ₽ в год; «Не подписка» скрывает", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Подписки");
  const row = '[data-testid="sub-row"][data-key="яндекс плюс"]';
  await waitText(browser, row, /Яндекс Плюс[\s\S]*399 ₽[\s\S]*в месяц/);
  await waitText(browser, '[data-testid="subs-year"]', money("4 788 ₽"));
  await (await browser.$(`${row} [data-testid="sub-hide"]`)).click();
  await waitText(browser, '[data-testid="subs-year"]', money("0 ₽"));
  await (await browser.$('//label[contains(., "Показать скрытые")]/input')).click();
  await (await browser.$(`${row} [data-testid="sub-hide"]`)).click();
  await waitText(browser, '[data-testid="subs-year"]', money("4 788 ₽"));
});

test("цель накоплений: 30 000 ₽ к сроку, пополнение 12 000 ₽ — 40 % и сколько нужно в месяц", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Цель");
  await fill(browser, "goalName", "Велосипед");
  await fill(browser, "goalTarget", "30000");
  const next = new Date(now.getFullYear() + 1, now.getMonth(), 1);
  await browser.execute(
    (v) => {
      const i = document.querySelector('[name="goalDeadline"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, v);
      i.dispatchEvent(new Event("input", { bubbles: true }));
    },
    `${next.getFullYear()}-${pad(next.getMonth() + 1)}-01`,
  );
  await save(browser);
  const goal = '[data-testid="goal"][data-name="Велосипед"]';
  await waitText(browser, goal, /0 %[\s\S]*Пока нет пополнений/);
  await (await browser.$(`${goal} [data-testid="goal-deposit"]`)).click();
  await fill(browser, "amount", "12000");
  await save(browser);
  await waitText(browser, goal, /40 %[\s\S]*12 000 ₽[\s\S]*из 30 000 ₽/);
  await waitText(browser, `${goal} [data-testid="goal-forecast"]`, /При нынешнем темпе — к /);
  await waitText(browser, `${goal} [data-testid="goal-need"]`, /нужно .* в месяц/);
});

test("итоги года: потрачено 2 447 ₽, чаще всего платили «Яндекс Плюс»", async () => {
  await openSection(browser, "Отчёты");
  await click(browser, "Итоги года");
  await waitText(browser, '[data-testid="year-title"]', new RegExp(`Итоги ${now.getFullYear()} года`));
  // Три платежа «Яндекс Плюс» могли попасть в прошлый год, если сейчас начало года.
  const yearRows = [65, 35, 5].filter((d) => daysAgo(d).getFullYear() === now.getFullYear()).length;
  await waitText(browser, '[data-testid="year-expense"]', money(`${(1250 + 399 * yearRows).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`));
  if (yearRows >= 2) await waitText(browser, '[data-testid="year-review"]', /Чаще всего платили\s*Яндекс Плюс/i);
});

test("Ctrl+K: поиск находит цель, счёт и операцию; Enter и клик открывают", async () => {
  await browser.keys(["Control", "k"]);
  await browser.$('[data-testid="palette"]').waitForDisplayed({ timeout: 3000 });
  await fill(browser, "paletteQuery", "вел");
  await paletteHas(/Цели[\s\S]*Велосипед/);
  await fill(browser, "paletteQuery", "яндекс");
  await paletteHas(/Операции[\s\S]*Яндекс Плюс/);
  await fill(browser, "paletteQuery", "карт");
  await paletteHas(/Счета[\s\S]*Карта/);
  // Первым идёт раздел «Счета» (в его описании есть «карты»): Enter открывает его.
  await browser.keys("Enter");
  await browser.$('//main//h1[normalize-space()="Счета"]').waitForDisplayed({ timeout: 5000 });
  assert.equal(await browser.$('[data-testid="palette"]').isExisting(), false);
  // Клик по счёту открывает его операции.
  await (await browser.$('[data-testid="open-palette"]')).click();
  await fill(browser, "paletteQuery", "карт");
  await paletteHas(/Счета[\s\S]*Карта/);
  await (await browser.$('//*[@data-testid="palette-item"][.//span[@class="p-title" and normalize-space()="Карта"]]')).click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
});

test("значок «?»: под мышкой подсказка, в Настройках все подсказки выключаются", async () => {
  await openSection(browser, "Главная");
  const q = await browser.$('[data-testid="total-balance"] [data-testid="hint"]');
  await q.moveTo();
  await waitText(browser, '[data-testid="hint-tip"]', /Общий баланс[\s\S]*в основной валюте/);
  // Знак «?» не попадает в текст карточки.
  assert.doesNotMatch(await browser.$('[data-testid="total-balance"] .tile-label').getText(), /\?/);
  await openSection(browser, "Настройки");
  const select = await browser.$('select[name="hints"]');
  await select.selectByVisibleText("Скрыть");
  await openSection(browser, "Главная");
  await browser.$('[data-testid="total-balance"]').waitForDisplayed();
  assert.equal(await browser.$('[data-testid="hint"]').isExisting(), false);
  await openSection(browser, "Настройки");
  await (await browser.$('select[name="hints"]')).selectByVisibleText("Показывать");
});
