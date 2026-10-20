// Скриншоты экранов для отчёта: node e2e/screenshots.mjs (под xvfb-run на Linux).
import { start, stop, onboard, openSection, fill, choose, click, save } from "./app.mjs";

const out = (name) => new URL(`../docs/${name}.png`, import.meta.url).pathname;
const { browser } = await start();
try {
  await browser.setWindowSize(1280, 800);
  await onboard(browser, [
    { name: "Наличные", balance: "8500" },
    { name: "Карта Сбер", balance: "64200" },
    { name: "Вклад USD", type: "Вклад / сбережения", currency: "USD", balance: "2000" },
  ]);
  const expense = async (amount, category, payee) => {
    await click(browser, "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта Сбер (₽)");
    if (payee) await fill(browser, "payee", payee);
    await choose(browser, "category", category);
    await save(browser);
  };
  await openSection(browser, "Главная");
  await click(browser, "+ Доход");
  await fill(browser, "amount", "85000");
  await choose(browser, "account", "Карта Сбер (₽)");
  await choose(browser, "category", "Зарплата");
  await save(browser);
  await expense("2340", "Продукты", "Пятёрочка");
  await expense("1890", "Кафе и рестораны", "Шоколадница");
  await expense("6230", "Жильё", "Мосэнергосбыт");
  await expense("850", "Транспорт", "Яндекс Go");
  await openSection(browser, "Настройки");
  await fill(browser, "rate", "92,15");
  await click(browser, "Добавить");
  await openSection(browser, "Главная");
  await browser.pause(500);
  await browser.saveScreenshot(out("screen-home"));
  await openSection(browser, "Операции");
  await browser.pause(500);
  await browser.saveScreenshot(out("screen-transactions"));
  await click(browser, "+ Операция");
  await click(browser, "Перевод");
  await fill(browser, "amount", "92150");
  await choose(browser, "toAccount", "Вклад USD ($)");
  await fill(browser, "toAmount", "1000");
  await browser.pause(300);
  await browser.saveScreenshot(out("screen-transfer"));
  await browser.keys("Escape");
  await openSection(browser, "Счета");
  await browser.saveScreenshot(out("screen-accounts"));
  await openSection(browser, "Категории");
  await browser.saveScreenshot(out("screen-categories"));
} finally {
  await stop(browser);
}
