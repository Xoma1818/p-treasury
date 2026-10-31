// Скриншоты для сравнения «до/после» оформления: node e2e/screenshots-ui.mjs <папка> (под xvfb-run).
import { start, stop, onboard, openSection, fill, choose, click, save } from "./app.mjs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "screens");
mkdirSync(dir, { recursive: true });
const shot = (b, name) => b.saveScreenshot(join(dir, `${name}.png`));
const { browser } = await start();
try {
  await browser.setWindowSize(1280, 800);
  await onboard(browser, [
    { name: "Наличные", balance: "8500" },
    { name: "Карта Сбер", balance: "64200" },
    { name: "Вклад USD", type: "Вклад / сбережения", currency: "USD", balance: "2000" },
  ]);
  await openSection(browser, "Главная");
  await click(browser, "+ Доход");
  await fill(browser, "amount", "85000");
  await choose(browser, "account", "Карта Сбер (₽)");
  await choose(browser, "category", "Заработная плата");
  await save(browser);
  for (const [amount, category, payee] of [["2340", "Питание", "Пятёрочка"], ["1890", "Общепит", "Шоколадница"], ["850", "Транспорт", "Яндекс Go"]]) {
    await click(browser, "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта Сбер (₽)");
    await fill(browser, "payee", payee);
    await choose(browser, "category", category);
    await save(browser);
  }
  await browser.pause(400);
  // Наведение на главную кнопку: видно состояние hover.
  await (await browser.$('//main//button[normalize-space()="+ Расход"]')).moveTo();
  await browser.pause(300);
  await shot(browser, "home");
  await click(browser, "+ Расход");
  await browser.pause(400);
  await shot(browser, "dialog");
  await browser.keys("Escape");
  await openSection(browser, "Операции");
  await browser.pause(400);
  await shot(browser, "transactions");
  await openSection(browser, "Настройки");
  await fill(browser, "rate", "92,15");
  await click(browser, "Добавить");
  await browser.pause(300);
  await browser.execute(() => document.querySelector('[data-testid="rates-card"], [data-testid="rates"]')?.closest(".card")?.scrollIntoView());
  await browser.pause(300);
  await shot(browser, "settings-rates");
  // Фокус с клавиатуры: Tab по боковому меню.
  await browser.execute(() => document.querySelector("nav button")?.focus());
  await browser.keys(["Tab", "Tab"]);
  await browser.pause(300);
  await openSection(browser, "Бюджет");
  await browser.pause(300);
  await shot(browser, "budget");
} finally {
  await stop(browser);
}
