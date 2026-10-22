// Снимки займов 0.17: форма расчёта с досрочками и диаграммой, карточка займа с историей,
// окно досрочки, диалог PDF и первая страница PDF (через pdftoppm), в обеих темах.
// node e2e/screenshots-loans.mjs <папка> [ширина] (под xvfb-run с экраном 1920x1080).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { start, stop, onboard, openSection, fill, choose, click, save, setDate, waitText } from "./app.mjs";

const dir = resolve(process.argv[2] ?? "screens");
const width = Number(process.argv[3] ?? 1280);
const height = width >= 1920 ? 1080 : 800;
mkdirSync(dir, { recursive: true });
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = (n) => iso(new Date(Date.now() + n * 86_400_000));

const { browser } = await start();
const shot = async (name, theme) => {
  // Плашку «Отменить» прошлого действия убираем, чтобы не закрывала форму.
  await browser.execute(() => document.querySelector('[data-testid="undo-bar"] button[aria-label="Закрыть"]')?.click());
  // На 1920 окно увеличено масштабом, и WebKitWebDriver промахивается координатами:
  // всё нажимаем на 1280, а размер меняем только на время снимка.
  if (width !== 1280) await browser.setWindowSize(width, height);
  await browser.pause(900);
  await browser.saveScreenshot(join(dir, `${name}-${theme}-${width}.png`));
  if (width !== 1280) {
    await browser.setWindowSize(1280, 800);
    await browser.pause(400);
  }
};
const setTheme = (t) => browser.execute((label) => [...document.querySelectorAll(".theme-switch button")].find((b) => b.textContent.includes(label))?.click(), t === "light" ? "Светлая" : "Тёмная");
const scrollTop = () => browser.execute(() => document.querySelector(".content")?.scrollTo(0, 0) ?? window.scrollTo(0, 0));
const pick = (path) => browser.execute((p) => (window.__ptPick = [p]), path);

try {
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "150000" },
  ]);
  await browser.setWindowSize(1280, 800);

  // Займ с историей: досрочка, смена ставки, плановые досрочки.
  await openSection(browser, "Займы и долги");
  await click(browser, "+ Новый долг");
  await fill(browser, "principal", "600000");
  await fill(browser, "rate", "14,5");
  await fill(browser, "term", "3");
  await choose(browser, "termUnit", "лет");
  await setDate(browser, "issueDate", inDays(-1));
  await browser.$('[data-testid="loan-payment"]').waitForDisplayed({ timeout: 5000 });
  await click(browser, "Записать заём");
  await fill(browser, "counterparty", "Т-Банк");
  await choose(browser, "account", "Карта (₽)");
  await save(browser);
  await browser.$('//main//h1[contains(., "Т-Банк")]').waitForDisplayed({ timeout: 5000 });
  await click(browser, "Досрочный платёж");
  await fill(browser, "earlyAmount", "80000");
  await choose(browser, "recalcMode", "Уменьшить срок, платёж прежний");
  await waitText(browser, '[data-testid="pay-quote"]', /экономия/);
  await save(browser);
  await waitText(browser, '[data-testid="payments"]', /досрочно/);
  await click(browser, "Ставка изменилась");
  await setDate(browser, "rateFrom", inDays(20));
  await fill(browser, "newRate", "12");
  await save(browser);
  await (await browser.$('[data-testid="tab-planned"]')).click();
  await click(browser, "+ Досрочное погашение");
  await fill(browser, "early-amount-0", "15000");
  await choose(browser, "early-freq-0", "раз в квартал");
  await click(browser, "Сохранить досрочки");
  await browser.$('[data-testid="forecast-savings"]').waitForDisplayed({ timeout: 5000 });

  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    // Форма расчёта с досрочками и диаграммой.
    await openSection(browser, "Займы и долги");
    await click(browser, "Калькулятор");
    await click(browser, "+ Досрочное погашение");
    await fill(browser, "early-amount-0", "100000");
    await setDate(browser, "early-date-0", inDays(180));
    await click(browser, "+ Досрочное погашение");
    await fill(browser, "early-amount-1", "5000");
    await choose(browser, "early-freq-1", "раз в месяц");
    await choose(browser, "early-mode-1", "уменьшать платёж");
    await browser.$('[data-testid="loan-savings"]').waitForDisplayed({ timeout: 5000 });
    await scrollTop();
    await shot("forma-rascheta", theme);
    // Диалог PDF.
    await click(browser, "PDF для подписи");
    await fill(browser, "lenderName", "Петров Пётр Петрович");
    await fill(browser, "borrowerName", "Сидоров Сидор Сидорович");
    await shot("dialog-pdf", theme);
    if (theme === "dark") {
      const pdf = join(dir, "grafik.pdf");
      await pick(pdf);
      await save(browser, "Сохранить файл");
      await waitText(browser, '[data-testid="export-status"]', /Сохранено/);
      spawnSync("pdftoppm", ["-png", "-r", "110", "-f", "1", "-l", "1", "-singlefile", pdf, join(dir, "pdf-stranica-1")]);
    } else {
      await browser.keys("Escape");
    }

    // Карточка займа с историей.
    await openSection(browser, "Займы и долги");
    await (await browser.$('//tr[@data-testid="debt-row" and @data-name="Т-Банк"]//div[@class="main"]')).click();
    await browser.$('//main//h1[contains(., "Т-Банк")]').waitForDisplayed({ timeout: 5000 });
    await (await browser.$('[data-testid="tab-history"]')).click();
    await browser.waitUntil(async () => (await browser.$$('[data-testid="version"]')).length >= 3, { timeout: 5000 });
    await browser.execute(() => document.querySelector(".loan-card-actions")?.closest(".card")?.scrollIntoView({ block: "start" }));
    await shot("kartochka-istoriya", theme);
    await (await browser.$('[data-testid="tab-planned"]')).click();
    await browser.$('[data-testid="forecast-savings"]').waitForDisplayed({ timeout: 5000 });
    await shot("kartochka-prognoz", theme);
    await (await browser.$('[data-testid="tab-whatif"]')).click();
    await fill(browser, "whatIfAmount", "50000");
    await browser.$('[data-testid="whatif-result"]').waitForDisplayed({ timeout: 5000 });
    await shot("kartochka-a-chto-esli", theme);

    // Окно досрочки.
    await click(browser, "Досрочный платёж");
    await setDate(browser, "payDate", inDays(10));
    await fill(browser, "earlyAmount", "50000");
    await browser.$('[data-testid="pay-quote"]').waitForDisplayed({ timeout: 5000 });
    await shot("okno-dosrochki", theme);
    await browser.keys("Escape");
    await click(browser, "Оплачено");
    await browser.$('[data-testid="pay-towards"]').waitForDisplayed({ timeout: 5000 });
    await shot("okno-platezha", theme);
    await browser.keys("Escape");
    await scrollTop();
  }
} finally {
  await stop(browser);
}
