// Скриншоты новых функций 0.10 на примере данных: node e2e/screenshots-wave.mjs <папка> [light] (под xvfb-run).
import { start, stop, openSection, click, choose, setDate } from "./app.mjs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "screens");
const light = process.argv[3] === "light";
mkdirSync(dir, { recursive: true });
const suffix = light ? "-light" : "";
const shot = (b, name) => b.saveScreenshot(join(dir, `${name}${suffix}.png`));
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const { browser } = await start();
try {
  await browser.setWindowSize(1280, 900);
  if (light) await browser.execute(() => localStorage.setItem("p-treasury-theme", "light"));
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await shot(browser, "onboarding-demo");
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  if (light) {
    await browser.refresh();
    await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  }
  await browser.pause(600);
  await shot(browser, "home");
  // Быстрый ввод: текст SMS банка разобран в черновик.
  await browser.$('textarea[name="quickText"]').setValue("Покупка 2 340,50р Карта*1234 PYATEROCHKA 1520 Баланс: 10 000р");
  await browser.$('[data-testid="quick-draft"]').waitForDisplayed({ timeout: 5000 });
  await browser.pause(500);
  await shot(browser, "quick");
  await setDate(browser, "quickText", "");
  await openSection(browser, "Категории");
  await browser.$('[data-testid="rules"]').scrollIntoView();
  await browser.pause(300);
  await shot(browser, "rules");
  await openSection(browser, "Бюджет");
  await browser.pause(400);
  await shot(browser, "budget");
  await openSection(browser, "Отчёты");
  await click(browser, "Курсовая разница", '//*[@role="tablist"]');
  await choose(browser, "periodKind", "Произвольный");
  const d = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  await setDate(browser, "reportFrom", `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`);
  await browser.pause(500);
  await shot(browser, "fx");
  await openSection(browser, "Операции");
  await click(browser, "☆ Сохранить вид");
  await browser.pause(300);
  await shot(browser, "views");
} finally {
  await stop(browser);
}
