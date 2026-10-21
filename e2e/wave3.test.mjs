// Обновление 0.10, этап 3: имущество, поездки и события, общие траты, дни без трат
// и итог недели, своя Главная, перетаскивание. Сценарии из docs/product/mvp-features.md («Версия 0.10»).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, fill, choose, chooseLike, click, save, waitText, money } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = iso(new Date());

let browser;
before(async () => {
  ({ browser } = await start());
  // Форма общей траты высокая: окно побольше, чтобы кнопка «Сохранить» была видна.
  await browser.setWindowSize(1280, 1000);
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
});
after(async () => {
  await stop(browser);
});

/** Перетаскивание мышью: WebDriver не умеет HTML5 drag-and-drop, поэтому события те же, что шлёт браузер. */
async function dragTo(source, target) {
  const ok = await browser.execute(
    (s, d) => {
      const src = document.querySelector(s);
      const dst = document.querySelector(d);
      if (!src || !dst) return false;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return true;
    },
    source,
    target,
  );
  assert.ok(ok, `нет элемента для перетаскивания: ${source} → ${target}`);
}

test("имущество: оценка входит в чистые активы на Главной", async () => {
  await waitText(browser, '[data-testid="home-net-worth"]', /Чистые активы с имуществом и долгами/);
  const before = await browser.$('[data-testid="home-net-worth"]').getText();
  await openSection(browser, "Счета");
  await waitText(browser, '[data-testid="assets"]', /Квартира[\s\S]*\+3 % с[\s\S]*9 800 000 ₽/);
  await click(browser, "+ Имущество");
  await fill(browser, "assetName", "Дача");
  await fill(browser, "assetValue", "2000000");
  await save(browser);
  await waitText(browser, '[data-testid="assets"]', /Дача[\s\S]*2 000 000 ₽/);
  await openSection(browser, "Главная");
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-net-worth"]').getText()) !== before, { timeout: 5000 });
  // Пример данных строится от сегодняшнего дня, поэтому сверяем прирост, а не сумму.
  const rub = (t) => Number(t.replace(/[^\d,−-]/g, "").replace(",", ".").replace("−", "-"));
  const after = await browser.$('[data-testid="home-net-worth"]').getText();
  assert.equal(Math.round((rub(after) - rub(before)) * 100), 200000000, `${before} → ${after}`);
});

test("поездка: итог против бюджета, трата этих дней добавляется одной кнопкой", async () => {
  await openSection(browser, "Бюджет");
  const trip = '//*[@data-testid="event-row" and @data-name="Поездка в Казань"]';
  await waitText(browser, `${trip}//*[@data-testid="event-spent"]`, money("23 050 ₽ из 40 000 ₽"));
  await browser.$(`${trip}//*[@data-testid="event-add-all"]`).click();
  await browser.$(`${trip}//*[@data-testid="event-add-all"]`).waitForExist({ timeout: 5000, reverse: true });
  const spent = await waitText(browser, `${trip}//*[@data-testid="event-spent"]`, /из 40 000/);
  assert.doesNotMatch(spent, money("23 050 ₽"), "трата этих дней вошла в итог");
  const ops = await browser.$(`${trip}//button[starts-with(normalize-space(), "Операции:")]`);
  const n = Number((await ops.getText()).match(/\d+/)[0]);
  assert.ok(n > 4);
  await ops.click();
  await browser.$('//main//h1[normalize-space()="Операции"]').waitForDisplayed({ timeout: 5000 });
  await waitText(browser, '[data-testid="filter-event"]', /Поездка в Казань/);
  await waitText(browser, '[data-testid="txn-count"]', new RegExp(`Показано ${n} из ${n}`));
  await waitText(browser, "main", /Гостиница/);
});

test("событие на сегодня: расход отмечается в форме операции", async () => {
  await openSection(browser, "Бюджет");
  await click(browser, "+ Событие");
  await fill(browser, "eventName", "Ремонт кухни");
  await fill(browser, "eventBudget", "150000");
  await save(browser);
  await waitText(browser, '//*[@data-testid="event-row" and @data-name="Ремонт кухни"]', /идёт сейчас[\s\S]*0 ₽ из 150 000 ₽/);
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "12500");
  await chooseLike(browser, "category", "Ремонт");
  await choose(browser, "event", "Ремонт кухни");
  await save(browser);
  await openSection(browser, "Бюджет");
  await waitText(browser, '//*[@data-testid="event-row" and @data-name="Ремонт кухни"]//*[@data-testid="event-spent"]', money("12 500 ₽ из 150 000 ₽"));
  // Трата события не входит в факт месячного бюджета, её итог показан отдельно.
  await waitText(browser, '[data-testid="budget-events"]', money("поездки и события отдельно: 12 500 ₽"));
});

test("общая трата за троих: своя доля — расход, доли друзей — долги «мне должны»", async () => {
  await openSection(browser, "Главная");
  const expense = await browser.$('[data-testid="month-expense"]').getText();
  await click(browser, "+ Расход");
  await fill(browser, "amount", "3000");
  await chooseLike(browser, "category", "Кафе и рестораны");
  await fill(browser, "payee", "Пиццерия");
  await click(browser, "Разделить с друзьями");
  await fill(browser, "friend0", "Аня");
  await click(browser, "+ ещё человек");
  await fill(browser, "friend1", "Петя");
  await click(browser, "Поровну");
  await waitText(browser, '[data-testid="split-mine"]', money("Моя доля: 1 000 ₽"));
  await save(browser);
  await browser.waitUntil(async () => (await browser.$('[data-testid="month-expense"]').getText()) !== expense, { timeout: 5000 });
  await openSection(browser, "Займы и долги");
  await waitText(browser, "main", /Аня[\s\S]*1 000 ₽/);
  await waitText(browser, "main", /Петя[\s\S]*1 000 ₽/);
});

test("календарь: дни без трат отмечены, итог недели, операция перетаскивается на другой день", async () => {
  await openSection(browser, "Календарь");
  await browser.$('[data-testid="no-spend"]').waitForExist({ timeout: 5000 });
  await waitText(browser, '[data-testid="no-spend-card"]', /\d+ (день|дня|дней) в этом месяце/);
  await waitText(browser, '[data-testid="week-summary"]', /Итог прошлой недели[\s\S]*Расходы/);
  // Сегодняшнюю операцию переносим на вчера (если сегодня 1-е, вчера в другом месяце — пропускаем).
  const target = today.endsWith("-01") ? today : iso(new Date(Date.now() - 86400000));
  await browser.$(`[data-testid="cal-day"][data-date="${today}"]`).click();
  await browser.$('[data-testid="day-panel"] [data-testid="txn-row"]').waitForExist({ timeout: 5000 });
  const rows = async () => (await browser.$$('[data-testid="day-panel"] [data-testid="txn-row"]')).length;
  const n = await rows();
  if (target !== today) {
    await dragTo('[data-testid="day-panel"] tr.draggable', `[data-testid="cal-day"][data-date="${target}"]`);
    await browser.waitUntil(async () => (await rows()) === n - 1, { timeout: 5000, timeoutMsg: "операция не ушла с этого дня" });
    await browser.$(`[data-testid="cal-day"][data-date="${target}"]`).click();
    await waitText(browser, '[data-testid="day-panel"]', /Пиццерия|Ремонт|Кафе/);
  }
  await browser.$('[name="weeklySummary"]').click();
  await browser.waitUntil(async () => !(await browser.$('[name="weeklySummary"]').isSelected()), { timeout: 5000 });
});

test("своя Главная: скрыть карточку, переставить, вернуть как было", async () => {
  await openSection(browser, "Главная");
  await browser.$('[data-testid="home-spend"]').waitForDisplayed({ timeout: 5000 });
  await click(browser, "Настроить");
  await browser.$('//*[@data-block="templates"]//button[normalize-space()="Скрыть"]').click();
  await browser.$('button[aria-label="Ниже: Быстрый ввод"]').click();
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-block"]').getAttribute("data-block")) === "tiles", { timeout: 5000 });
  // Перетаскивание карточки: «Напоминания» — в самый верх.
  await dragTo('[data-testid="home-block"][data-block="reminders"]', '[data-testid="home-block"][data-block="tiles"]');
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-block"]').getAttribute("data-block")) === "reminders", { timeout: 5000 });
  await click(browser, "Готово");
  assert.equal(await browser.$('//main//h2[normalize-space()="Шаблоны"]').isExisting(), false, "шаблоны скрыты");
  // Настройка сохраняется: после перезагрузки порядок тот же.
  await browser.refresh();
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  assert.equal(await browser.$("main .home-block").getAttribute("data-block"), "reminders");
  await click(browser, "Настроить");
  await click(browser, "Вернуть как было");
  await browser.waitUntil(async () => (await browser.$('[data-testid="home-block"]').getAttribute("data-block")) === "quick", { timeout: 5000 });
  await click(browser, "Готово");
  await browser.$('//main//h2[normalize-space()="Шаблоны"]').waitForDisplayed({ timeout: 5000 });
});

test("счёт, перетащенный на категорию «Куда тратите», открывает расход с этим счётом", async () => {
  await browser.$('//*[@data-testid="spend-chip" and @data-category="Такси"]').click();
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  const picked = (n) =>
    browser.execute((name) => {
      const s = document.querySelector(`[role="dialog"] select[name="${name}"]`);
      return s.options[s.selectedIndex].text.trim();
    }, n);
  assert.equal(await picked("category"), "Такси");
  await browser.keys("Escape");
  await browser.$('[role="dialog"]').waitForExist({ timeout: 5000, reverse: true });
  await dragTo('[data-testid="home-account"]:first-child', '[data-testid="spend-chip"][data-category="Кафе и рестораны"]');
  await browser.$('[role="dialog"]').waitForDisplayed({ timeout: 5000 });
  assert.equal(await picked("category"), "Кафе и рестораны");
  assert.match(await picked("account"), /^Наличные/);
  await browser.keys("Escape");
});
