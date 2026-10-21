// Скриншоты раздела «Инвестиции» 0.11 на примере данных: node e2e/screenshots-invest.mjs <папка> (под xvfb-run).
import { start, stop, openSection, click, fill } from "./app.mjs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "screens");
mkdirSync(dir, { recursive: true });
const shot = (b, name) => b.saveScreenshot(join(dir, `${name}.png`));
const { browser } = await start();
try {
  await browser.setWindowSize(1280, 900);
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  await browser.$('[data-testid="home-invest"]').scrollIntoView();
  await browser.pause(500);
  await shot(browser, "home-invest");
  await browser.$('[data-testid="invest-value-open"]').click();
  await browser.pause(400);
  await shot(browser, "invest-value");
  await browser.keys("Escape");
  await browser.$('[data-testid="invest-calc-open"]').click();
  await browser.pause(400);
  await shot(browser, "invest-calc");
  await browser.keys("Escape");
  await openSection(browser, "Бюджет");
  await browser.$('[data-testid="plan-fact"]').scrollIntoView();
  await browser.pause(400);
  await shot(browser, "budget-plan-fact");
  await browser.$('[data-testid="plan-fact-invest-edit"]').click();
  await browser.pause(400);
  await shot(browser, "invest-plan");
  await browser.keys("Escape");
  await openSection(browser, "Счета");
  await browser.pause(400);
  await shot(browser, "accounts-invest");
} finally {
  await stop(browser);
}
