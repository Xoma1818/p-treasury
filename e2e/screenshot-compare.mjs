// Скриншот вкладки «Сравнение»: node e2e/screenshot-compare.mjs (под xvfb-run на Linux).
import { start, stop, onboard, fill, choose, click, save, setDate, openSection } from "./app.mjs";

const out = (name) => new URL(`../docs/${name}.png`, import.meta.url).pathname;
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const day = (back, d) => {
  const x = new Date(now.getFullYear(), now.getMonth() - back, d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};
const { browser } = await start();
try {
  await browser.setWindowSize(1280, 900);
  await onboard(browser, [
    { name: "Наличные", balance: "8500" },
    { name: "Карта Сбер", balance: "164200" },
  ]);
  const ops = [
    [1, "18400", "Продукты", "Пятёрочка"],
    [1, "6200", "Кафе и рестораны", "Шоколадница"],
    [1, "3100", "Транспорт", "Яндекс Go"],
    [1, "6230", "Жильё", "Мосэнергосбыт"],
    [1, "4500", "Одежда и обувь", "Lamoda"],
    [1, "1200", "Развлечения", "Кинопоиск"],
    [0, "21900", "Продукты", "Пятёрочка"],
    [0, "3900", "Кафе и рестораны", "Шоколадница"],
    [0, "3400", "Транспорт", "Яндекс Go"],
    [0, "6230", "Жильё", "Мосэнергосбыт"],
    [0, "2800", "Здоровье", "Аптека"],
    [0, "1200", "Развлечения", "Кинопоиск"],
  ];
  for (const [back, amount, category, payee] of ops) {
    await click(browser, "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта Сбер (₽)");
    await choose(browser, "category", category);
    await fill(browser, "payee", payee);
    await setDate(browser, "date", day(back, back ? 12 : 1));
    await save(browser);
  }
  const close = await browser.$('[data-testid="undo-bar"] .icon-btn');
  if (await close.isExisting()) await close.click();
  await openSection(browser, "Отчёты");
  await click(browser, "Сравнение", '//*[@role="tablist"]');
  await browser.$('[data-testid="cmp-row"]').waitForExist({ timeout: 5000 });
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-compare"));
} finally {
  await stop(browser);
}
