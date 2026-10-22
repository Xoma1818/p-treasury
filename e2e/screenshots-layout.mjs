// Снимки всех разделов на примере в обычном окне и на весь экран:
// node e2e/screenshots-layout.mjs <папка> (под xvfb-run с экраном 1920x1080).
import { start, stop, click } from "./app.mjs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "screens");
mkdirSync(dir, { recursive: true });
const SECTIONS = ["Главная", "Операции", "Календарь", "Бюджет", "Отчёты", "Займы и долги", "Счета", "Категории", "Заметки", "Настройки"];
const SIZES = [["1280", 1280, 800], ["1920", 1920, 1080]];
const { browser } = await start();
try {
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 15000 });
  for (const [tag, w, h] of SIZES) {
    await browser.setWindowSize(w, h);
    await browser.pause(800);
    for (const [i, title] of SECTIONS.entries()) {
      // Нажатие через страницу: при масштабе WebKitWebDriver промахивается координатами.
      await browser.execute((t) => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().startsWith(t))?.click(), title);
      await browser.pause(1500);
      await browser.saveScreenshot(join(dir, `${tag}-${String(i).padStart(2, "0")}.png`));
    }
  }
} finally {
  await stop(browser);
}
