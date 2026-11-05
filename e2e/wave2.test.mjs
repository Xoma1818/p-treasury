// Обновление 0.10, этап 2: быстрый ввод строкой и из SMS банка, правила автокатегорий,
// отдельное окно быстрого ввода. Сценарии из docs/product/mvp-features.md («Версия 0.10»).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, fill, choose, chooseLike, click, waitText, setDate } from "./app.mjs";

let browser;
before(async () => {
  ({ browser } = await start());
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
});
after(async () => {
  await stop(browser);
});

/** Текст выбранного пункта списка. */
const picked = (name) =>
  browser.execute((n) => {
    const s = document.querySelector(`select[name="${n}"]`);
    return s ? s.options[s.selectedIndex].text.trim() : null;
  }, name);

async function type(text) {
  const el = await browser.$('textarea[name="quickText"]');
  await el.waitForDisplayed({ timeout: 5000 });
  await el.click();
  await el.setValue(text);
  await browser.$('[data-testid="quick-draft"]').waitForDisplayed({ timeout: 5000 });
  // Черновик обновляется после паузы в наборе.
  await browser.pause(400);
}

const enter = async () => {
  await browser.$('textarea[name="quickText"]').click();
  await browser.keys("Enter");
};

test("строка «пятёрочка 1250 карта»: сумма, счёт и категория по прошлым покупкам, Enter записывает", async () => {
  await type("пятёрочка 1250 карта");
  assert.equal(await browser.$('[name="quickAmount"]').getValue(), "1250");
  assert.match(await picked("quickAccount"), /^Карта Сбер/);
  assert.notEqual(await picked("quickCategory"), "Выберите категорию", "категория из истории");
  assert.equal(await browser.$('[name="quickPayee"]').getValue(), "Пятёрочка");
  await enter();
  await waitText(browser, '[data-testid="quick-saved"]', /Записано: Пятёрочка, 1250\. Ctrl\+Z отменит/);
  assert.equal(await browser.$('textarea[name="quickText"]').getValue(), "", "поле очищено для следующей");
});

test("«+5000 кешбэк вчера»: доход вчерашним днём", async () => {
  await type("+5000 кешбэк вчера");
  await waitText(browser, '[data-testid="quick-draft"]', /Доход/);
  const d = new Date(Date.now() - 86400000);
  const day = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  await waitText(browser, '[data-testid="quick-date"]', new RegExp(day.replace(/\./g, "\\.")));
  await setDate(browser, "quickText", "");
});

test("SMS банка с незнакомым магазином: выбираем категорию и запоминаем правило", async () => {
  await type("Покупка 2 340,50р Карта*1234 MAGNIT MM Баланс: 10 000р");
  await browser.$('[data-testid="quick-sms"]').waitForDisplayed({ timeout: 3000 });
  assert.equal(await browser.$('[name="quickAmount"]').getValue(), "2340,50");
  assert.equal(await picked("quickCategory"), "Выберите категорию");
  await choose(browser, "quickCategory", "Питание");
  await waitText(browser, '[data-testid="quick-draft"]', /запомнить: «MAGNIT[^»]*» → эта категория/);
  await click(browser, "Записать", '//*[@data-testid="quick-draft"]');
  await waitText(browser, '[data-testid="quick-saved"]', /Записано/);
});

test("следующее SMS из того же магазина получает категорию по правилу", async () => {
  await type("Оплата 799 RUB MAGNIT MM. Доступно 9 201 RUB");
  await waitText(browser, '[data-testid="quick-draft"]', /категория по правилу/);
  assert.equal(await picked("quickCategory"), "Питание");
  await setDate(browser, "quickText", "");
});

test("правила видны в Категориях: добавить своё и удалить", async () => {
  await openSection(browser, "Категории");
  await waitText(browser, '[data-testid="rules"]', /magnit/i);
  await fill(browser, "rulePattern", "лукойл");
  await chooseLike(browser, "ruleCategory", "Топливо");
  await fill(browser, "rulePayee", "Лукойл");
  await click(browser, "Добавить правило");
  await waitText(browser, '[data-testid="rules"]', /лукойл\s*Транспорт → Топливо\s*Лукойл/);
  await browser.$('button[aria-label="Удалить правило «лукойл»"]').click();
  await browser.waitUntil(async () => !/лукойл/.test(await browser.$('[data-testid="rules"]').getText()), { timeout: 5000 });
});

test("окно быстрого ввода: открывается поверх, запись видна в главном окне", async () => {
  const main = await browser.getWindowHandle();
  await browser.execute(() => window.__TAURI_INTERNALS__.invoke("open_quick"));
  await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, { timeout: 10000 });
  const quick = (await browser.getWindowHandles()).find((h) => h !== main);
  await browser.switchToWindow(quick);
  await browser.$("main.quick-window").waitForDisplayed({ timeout: 10000 });
  assert.doesNotMatch(await browser.$("main").getText(), /Подробнее/);
  await type("такси 640 карта");
  await enter();
  await waitText(browser, '[data-testid="quick-saved"]', /Записано: .*640\.$/);
  await browser.switchToWindow(main);
  await openSection(browser, "Операции");
  await waitText(browser, "main", /640/);
});

test("сочетание клавиш меняется в Настройках", async () => {
  await openSection(browser, "Настройки");
  await choose(browser, "quickHotkey", "Ctrl+Shift+Space");
  await browser.waitUntil(async () => (await browser.$('[name="quickHotkey"]').getValue()) === "Ctrl+Shift+Space", { timeout: 5000 });
  await choose(browser, "quickHotkey", "Выключен");
  await browser.waitUntil(async () => (await browser.$('[name="quickHotkey"]').getValue()) === "", { timeout: 5000 });
});
